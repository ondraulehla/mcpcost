-- mcpcost D1 schema. Apply with:
--   npx wrangler d1 execute mcp-pulse --local --file=schema.sql
--   npx wrangler d1 execute mcp-pulse --remote --file=schema.sql

CREATE TABLE IF NOT EXISTS runs (
  probed_at TEXT PRIMARY KEY,
  summary TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS servers (
  name TEXT PRIMARY KEY,
  title TEXT,
  description TEXT,
  url TEXT NOT NULL,
  host TEXT NOT NULL,
  transport TEXT NOT NULL,
  repo TEXT,
  website TEXT,
  registry_status TEXT,
  registry_updated_at TEXT,
  -- For a server outside the registry (registry_status "listed"): the catalogs that list it, JSON [{"name","url"}]. See migrations/013-listed-in.sql.
  listed_in TEXT,
  -- A registry entry that lists several servers: JSON {"members":[{"name","host"}],"servers"}; one of those servers
  -- (registry_status "bundled"): {"entry","servers","listedIn"?}. See probe/bundles.ts and migrations/014-bundle.sql.
  bundle TEXT,
  -- The version of the registry entry that was probed. See migrations/011-failing-since-version.sql.
  version TEXT,
  probed_at TEXT NOT NULL,
  status TEXT NOT NULL,
  -- The first probe of the current run of failed probes. A server is down after two days of them, see isConfirmedDown.
  failing_since TEXT,
  -- failing_since once the server is down (isConfirmedDown at the real probe time), else null. See migrations/012-down-since.sql.
  down_since TEXT,
  http_status INTEGER,
  auth_scheme TEXT,
  -- The publisher's guide to getting access: resource_documentation of the OAuth protected-resource metadata (migration 009).
  auth_documentation TEXT,
  -- How a client gets in (oauth-dcr, oauth, token, unknown) and the OAuth metadata behind it, as JSON (migration 010).
  auth_kind TEXT,
  auth_metadata TEXT,
  protocol_version TEXT,
  server_name TEXT,
  server_version TEXT,
  capabilities TEXT,
  init_ms INTEGER,
  tools_ms INTEGER,
  tool_count INTEGER,
  tools_tokens INTEGER,
  instructions_chars INTEGER,
  toolset_hash TEXT,
  toolset_siblings INTEGER,
  top_tools TEXT,
  error TEXT,
  -- Exact counts from the Anthropic count_tokens endpoint. See migrations/002-claude.sql for an existing database.
  claude_model TEXT,
  claude_tokens INTEGER,
  claude_tokens_cc INTEGER,
  claude_measured_at TEXT,
  claude_error TEXT,
  -- Exact counts from the Gemini countTokens endpoint. See migrations/003-gemini.sql for an existing database.
  gemini_model TEXT,
  gemini_tokens INTEGER,
  gemini_measured_at TEXT,
  gemini_error TEXT,
  -- 1 when the probe used stored credentials (a header or an OAuth token). See migrations/004-credentials.sql.
  measured_with_credentials INTEGER,
  -- For a server that needs auth: the tool set of the publisher's open-source package, measured in a container. See migrations/005-derived.sql.
  derived_package TEXT,
  derived_registry TEXT,
  derived_status TEXT,
  derived_probed_at TEXT,
  derived_tool_count INTEGER,
  derived_tools_tokens INTEGER,
  derived_claude_tokens INTEGER,
  derived_error TEXT
);

-- The credentials file of the daily probe, one JSON document. Written by probe/credentials-sync.ts, never read by the site.
CREATE TABLE IF NOT EXISTS credentials (
  key TEXT PRIMARY KEY,
  json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS servers_toolset ON servers (toolset_hash);

CREATE TABLE IF NOT EXISTS probes (
  name TEXT NOT NULL,
  probed_at TEXT NOT NULL,
  status TEXT NOT NULL,
  init_ms INTEGER,
  tool_count INTEGER,
  tools_tokens INTEGER,
  claude_tokens INTEGER,
  PRIMARY KEY (name, probed_at)
);

-- Alerts: a mail when a watched server changes. Confirmed by a link, stopped by another.
CREATE TABLE IF NOT EXISTS watches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL,
  server TEXT NOT NULL,
  token TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  confirmed_at TEXT,
  stopped_at TEXT,
  notified_at TEXT,
  ip_hash TEXT
);
CREATE INDEX IF NOT EXISTS watches_server ON watches (server);

-- Servers outside the official registry, tracked on request from /check. The daily probe reads /api/tracked.json.
CREATE TABLE IF NOT EXISTS tracked (
  name TEXT PRIMARY KEY,
  url TEXT NOT NULL UNIQUE,
  transport TEXT NOT NULL,
  submitted_at TEXT NOT NULL,
  ip_hash TEXT
);

-- Use of the board's own MCP server (/mcp), as counts for each UTC day: src/lib/mcp-use.ts adds one for each request.
-- agent is the User-Agent header as a label, client the clientInfo.name of an initialize, tool the tool of a tools/call.
-- No address, argument or time of day. The weekly report (edge/reach.mjs) reads it.
CREATE TABLE IF NOT EXISTS mcp_use (
  day TEXT NOT NULL,
  agent TEXT NOT NULL,
  client TEXT NOT NULL,
  method TEXT NOT NULL,
  tool TEXT NOT NULL,
  count INTEGER NOT NULL,
  PRIMARY KEY (day, agent, client, method, tool)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS hosts (
  host TEXT PRIMARY KEY,
  servers INTEGER NOT NULL,
  ok INTEGER NOT NULL,
  auth INTEGER NOT NULL,
  dead INTEGER NOT NULL,
  unique_toolsets INTEGER NOT NULL,
  median_tokens INTEGER,
  probed_at TEXT NOT NULL
);

-- Indexes that let the list page read only the rows it shows. Directions match
-- the ORDER BY clauses in src/lib/db.ts. The opposite direction reads the same
-- index backwards, with the name tie-break reversed, so each sort has one index.
-- Every index entry is a row written on each update of its columns, so there
-- are as few as the page needs.
-- A status change rewrites every index that starts with status, so only the default sort has one.
-- Sorts by the estimate, by latency, by the registry date and by protocol scan the table instead of an index:
-- a page of them reads 40 000 rows once in three hours, while an index would cost a write on every row change.
-- See migrations/006-fewer-indexes.sql.
CREATE INDEX IF NOT EXISTS servers_tools_name ON servers (tool_count DESC, name);
-- The Tokens column sorts and filters by the number the board shows: the exact count, else the estimate.
-- Two indexes hold that expression, servers_status_shown (status, coalesce(claude_tokens, tools_tokens) DESC, name)
-- and servers_shown (coalesce(claude_tokens, tools_tokens) DESC, name). Building one costs a write per row, about
-- 42 000, so they are not here: migrations 007 and 008 create them, and the probe workflow applies one a day inside
-- its write budget. A new database needs both applied by hand. The expression must read exactly like SHOWN_TOKENS
-- in site/src/lib/db.ts for SQLite to use the index.

-- Full-text search over the columns people search by. The trigram tokenizer
-- matches inside words, so "wiki" finds DeepWiki and "copilot" finds
-- api.githubcopilot.com. The content table is servers, so the index stores only tokens. Triggers keep it in step; the
-- importer uses INSERT ... ON CONFLICT DO UPDATE, because REPLACE would not fire
-- the delete trigger. After creating it on a database that already has rows, run
-- once: INSERT INTO servers_fts(servers_fts) VALUES ('rebuild');
CREATE VIRTUAL TABLE IF NOT EXISTS servers_fts USING fts5(
  name, title, description, host, server_name,
  content='servers', content_rowid='rowid', tokenize='trigram'
);
CREATE TRIGGER IF NOT EXISTS servers_ai AFTER INSERT ON servers BEGIN
  INSERT INTO servers_fts(rowid, name, title, description, host, server_name)
  VALUES (new.rowid, new.name, new.title, new.description, new.host, new.server_name);
END;
CREATE TRIGGER IF NOT EXISTS servers_ad AFTER DELETE ON servers BEGIN
  INSERT INTO servers_fts(servers_fts, rowid, name, title, description, host, server_name)
  VALUES ('delete', old.rowid, old.name, old.title, old.description, old.host, old.server_name);
END;
-- The WHEN clause skips the two FTS writes when none of the indexed columns
-- changed. Most daily updates touch only numbers.
CREATE TRIGGER IF NOT EXISTS servers_au AFTER UPDATE ON servers
WHEN old.name IS NOT new.name OR old.title IS NOT new.title OR old.description IS NOT new.description OR old.host IS NOT new.host OR old.server_name IS NOT new.server_name
BEGIN
  INSERT INTO servers_fts(servers_fts, rowid, name, title, description, host, server_name)
  VALUES ('delete', old.rowid, old.name, old.title, old.description, old.host, old.server_name);
  INSERT INTO servers_fts(rowid, name, title, description, host, server_name)
  VALUES (new.rowid, new.name, new.title, new.description, new.host, new.server_name);
END;

-- The check page looks a URL up before it probes it live.
CREATE INDEX IF NOT EXISTS servers_url ON servers (url);

-- Column sorts and filters on the list page.
CREATE INDEX IF NOT EXISTS servers_status_name ON servers (status, name);
CREATE INDEX IF NOT EXISTS servers_host_name ON servers (host, name);

-- The statistics page lists the biggest hosts; without this the query read the whole table.
CREATE INDEX IF NOT EXISTS hosts_servers ON hosts (servers DESC);

-- Indexes from earlier versions that a reverse scan or a prefix now covers.
DROP INDEX IF EXISTS servers_tokens;
DROP INDEX IF EXISTS servers_status;
DROP INDEX IF EXISTS servers_host;
DROP INDEX IF EXISTS servers_host_tokens;
DROP INDEX IF EXISTS servers_protocol_tokens;
DROP INDEX IF EXISTS servers_tokens_asc;
DROP INDEX IF EXISTS servers_tools_asc;
DROP INDEX IF EXISTS servers_init_desc;
DROP INDEX IF EXISTS servers_status_desc;
DROP INDEX IF EXISTS servers_protocol_desc;
DROP INDEX IF EXISTS servers_host_desc;
DROP INDEX IF EXISTS servers_status_tokens;
DROP INDEX IF EXISTS servers_status_tools;
DROP INDEX IF EXISTS servers_status_init;
DROP INDEX IF EXISTS servers_status_updated;
