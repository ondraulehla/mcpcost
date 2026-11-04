import { env } from 'cloudflare:workers';
import { GATED_STATUSES } from '../../../packages/mcpcost/src/types.ts';
import { STATUS_LABEL } from './format';

export interface ServerRecord {
  name: string;
  title: string | null;
  description: string | null;
  url: string;
  host: string;
  transport: string;
  repo: string | null;
  website: string | null;
  registry_status: string | null;
  registry_updated_at: string | null;
  /** For a server outside the registry that a catalog lists (registry_status "listed"): JSON [{name, url}]. See listingsOf. */
  listed_in?: string | null;
  /** A registry entry that lists several servers, or one of them (registry_status "bundled"): JSON. See bundleOf. */
  bundle?: string | null;
  /** The version of the registry entry that was probed. Null before migration 011 ran a probe. */
  version: string | null;
  probed_at: string;
  status: string;
  /** The first probe of the current run of failed probes; null while the server answers or is gated. See isConfirmedDown. */
  failing_since: string | null;
  /** failing_since once the server is down (two days of failed probes, from the real probe times); else null. */
  down_since: string | null;
  http_status: number | null;
  auth_scheme: string | null;
  /** The publisher's guide to getting access, from the OAuth protected-resource metadata. */
  auth_documentation: string | null;
  /** How a client gets in: oauth-dcr, oauth, token or unknown. Null before migration 010 ran a probe. */
  auth_kind: string | null;
  /** The OAuth metadata behind it, as JSON: authorizationServers, scopesSupported, dynamicRegistration, pkce, grantTypes. */
  auth_metadata: string | null;
  protocol_version: string | null;
  server_name: string | null;
  server_version: string | null;
  capabilities: string | null;
  init_ms: number | null;
  tools_ms: number | null;
  tool_count: number | null;
  tools_tokens: number | null;
  instructions_chars: number | null;
  toolset_hash: string | null;
  toolset_siblings: number | null;
  top_tools: string | null;
  error: string | null;
  /** Exact count from the Anthropic count_tokens endpoint, names as published. */
  claude_tokens: number | null;
  /** The same with Claude Code's mcp__<server>__ prefix. */
  claude_tokens_cc: number | null;
  claude_model: string | null;
  claude_measured_at: string | null;
  claude_error: string | null;
  /** Exact count from the Gemini countTokens endpoint. */
  gemini_tokens: number | null;
  gemini_model: string | null;
  gemini_measured_at: string | null;
  gemini_error: string | null;
  /** 1 when the daily probe used stored credentials for this server. */
  measured_with_credentials: number | null;
  /** For a server that needs auth: the publisher's open-source package and its tool set, measured in a container. */
  derived_package: string | null;
  derived_registry: string | null;
  derived_status: string | null;
  derived_probed_at: string | null;
  derived_tool_count: number | null;
  derived_tools_tokens: number | null;
  derived_claude_tokens: number | null;
  derived_error: string | null;
}

export interface HostRecord {
  host: string;
  servers: number;
  ok: number;
  auth: number;
  dead: number;
  unique_toolsets: number;
  median_tokens: number | null;
  probed_at: string;
}

export interface ProbeRecord {
  probed_at: string;
  status: string;
  init_ms: number | null;
  tool_count: number | null;
  tools_tokens: number | null;
  claude_tokens: number | null;
}

export interface TokenStats {
  median: number;
  p90: number;
  p99: number;
  max: number;
  total: number;
}

/** The catalogs that list a server from outside the registry, from listed_in; empty for a registry entry. */
export function listingsOf(server: Pick<ServerRecord, 'listed_in'>): Array<{ name: string; url: string }> {
  try {
    const v = server.listed_in ? JSON.parse(server.listed_in) : [];
    return Array.isArray(v) ? v.filter((x) => typeof x?.name === 'string' && typeof x?.url === 'string' && /^https:\/\//.test(x.url)) : [];
  } catch {
    return [];
  }
}

/**
 * A registry entry whose remotes are several servers (com.cloudflare.mcp/mcp lists 15): on the entry, its other servers;
 * on one of those (registry_status "bundled"), its entry. Null for every other row. See probe/bundles.ts.
 */
export type BundleInfo = { members: Array<{ name: string; host: string }>; servers: number } | { entry: string; servers: number };

export function bundleOf(server: Pick<ServerRecord, 'bundle'>): BundleInfo | null {
  try {
    const v = server.bundle ? JSON.parse(server.bundle) : null;
    if (v && typeof v.servers === 'number' && (Array.isArray(v.members) || typeof v.entry === 'string')) return v as BundleInfo;
  } catch {
    // A row from before migration 014, or not JSON: no bundle.
  }
  return null;
}

export interface RunSummary {
  probedAt: string;
  /** The protocol version the probe asks for in initialize; runs since 2026-10-28. */
  requestedProtocolVersion?: string;
  registryEntries: number;
  /** Servers outside the registry from public catalogs; runs since 2026-10-27. */
  listed?: number;
  /** Servers outside the registry tracked from /check. */
  tracked?: number;
  registryWithRemote: number;
  probed: number;
  byStatus: Record<string, number>;
  /** The failing servers that are not down yet (fewer than DOWN_AFTER_DAYS days of failed probes), by status; runs since 2026-10-26. */
  noAnswer?: Record<string, number>;
  /** Registry entries the probe does not run yet, by kind (oci, mcpb, nuget, cargo, npm, pypi, remote, none); runs since 2026-10-26. */
  unprobed?: Record<string, number>;
  reachable: number;
  ok: number;
  uniqueToolsets: number;
  duplicateServers: number;
  protocols: Record<string, number>;
  authSchemes: Record<string, number>;
  /** Servers that need auth by how a client gets in; present once a run had the metadata reader. */
  authKinds?: Record<string, number>;
  transports: Record<string, number>;
  /** o200k_base estimate. */
  toolsTokens: TokenStats;
  /** Exact counts, present once a run had an API key. */
  claudeTokens?: TokenStats & {
    model?: string;
    counted: number;
    refused: number;
    claudeCode: TokenStats;
    ratioToEstimate: { median: number; p10: number; p90: number };
    /** Alive servers per cost band: bins[i] holds counts below edges[i]; the last bin is the rest. */
    histogram?: { edges: number[]; bins: number[] };
  };
  /** Exact Gemini counts, present once a run had a Gemini key. */
  geminiTokens?: TokenStats & { model?: string; counted: number; refused: number };
  toolCount: { median: number; p90: number; max: number };
  initMs: { median: number; p90: number };
  hosts: number;
  /** The 500 biggest hosts, from the run that wrote them (runs since 2026-10-21); older runs have the hosts table. */
  topHosts?: Array<{ host: string; servers: number; ok: number; gated: number; dead: number; noAnswer?: number; uniqueToolsets: number; medianTokens: number }>;
  /** The smallest and the largest number the board shows for an alive server (exact count, else estimate); runs since 2026-10-21. */
  shownTokens?: { min: number; max: number };
  heaviest: Array<{ name: string; toolCount: number; toolsTokens: number; claudeTokens?: number; claudeTokensCc?: number; host: string }>;
  /** Package (stdio) servers on the board, and how many of them this run probed. */
  stdioProbed?: number;
  stdioToday?: number;
  /** PyPI servers that stop at the import of FastMCP from mcp 2.x (crashed), or start only with mcp<2 (needs_old_sdk); runs since 2026-10-30. */
  fastmcpMoved?: number;
  registryWithPackage?: number;
  /** What changed since the previous run; absent on the first run. */
  changes?: {
    since: string;
    added: Array<{ name: string; status: string; tokens?: number }>;
    removed: string[];
    wentDown: Array<{ name: string; from: string; to: string }>;
    cameBack: Array<{ name: string; from: string; to: string }>;
    /** Packages that failed to start again at their weekly check; runs since 2026-10-27. Before that they were in wentDown. */
    packagesDown?: Array<{ name: string; from: string; to: string }>;
    /** Packages that start again at their weekly check; runs since 2026-10-27. Before that they were in cameBack. */
    packagesBack?: Array<{ name: string; from: string; to: string }>;
    tokenChanges: Array<{ name: string; before: number; after: number; exact: boolean }>;
    counts: { added: number; removed: number; wentDown: number; cameBack: number; packagesDown?: number; packagesBack?: number; tokenChanges: number };
  };
}

/**
 * The long lists of a run: since 2026-10-21 topHosts and changes are 72 kB of a 77 kB summary. A page that does
 * not show a list leaves it out, and D1 removes it before the row leaves the database: the Worker gets and parses
 * a summary of 2 kB, where parsing every list took a good part of a page's CPU time.
 */
export type RunList = 'topHosts' | 'changes' | 'heaviest';

/** What changed in the last runs, newest first, for the changes page and its feed: the changes of each run and nothing else. */
export async function recentChanges(limit = 14): Promise<Array<Pick<RunSummary, 'probedAt' | 'changes'>>> {
  const { results } = await db()
    .prepare("SELECT json_extract(summary, '$.probedAt') AS probedAt, json_extract(summary, '$.changes') AS changes FROM runs ORDER BY probed_at DESC LIMIT ?")
    .bind(limit)
    .all<{ probedAt: string; changes: string | null }>();
  return results.map((r) => ({ probedAt: r.probedAt, changes: r.changes ? (JSON.parse(r.changes) as RunSummary['changes']) : undefined }));
}

/** One run as a point of the run-by-run charts. */
export type TrendPoint = Pick<RunSummary, 'probedAt' | 'ok' | 'probed'> & { claudeTokens?: { median: number }; toolsTokens: { median: number } };

/** The summary column without the lists named, and the values the SQL binds for them. */
function summaryWithout(without: RunList[]): { sql: string; binds: string[] } {
  return without.length ? { sql: `json_remove(summary${', ?'.repeat(without.length)})`, binds: without.map((k) => `$.${k}`) } : { sql: 'summary', binds: [] };
}

/**
 * The latest run without the lists named, and the runs before it, newest first, as points of the run-by-run
 * charts. One round trip: D1 runs a batch as one transaction, so both answers come from the same table.
 */
export async function latestRunWithTrend<K extends RunList = never>(without: K[], limit: number): Promise<{ run: Omit<RunSummary, K> | null; earlier: TrendPoint[] }> {
  const summary = summaryWithout(without);
  const d = db();
  const [latest, trend] = await d.batch([
    d.prepare(`SELECT ${summary.sql} AS summary FROM runs ORDER BY probed_at DESC LIMIT 1`).bind(...summary.binds),
    d
      .prepare(
        `SELECT json_extract(summary, '$.probedAt') AS probedAt, json_extract(summary, '$.ok') AS ok, json_extract(summary, '$.probed') AS probed,
           json_extract(summary, '$.claudeTokens.median') AS claudeMedian, json_extract(summary, '$.toolsTokens.median') AS toolsMedian
         FROM runs WHERE probed_at < (SELECT max(probed_at) FROM runs) ORDER BY probed_at DESC LIMIT ?`
      )
      .bind(limit)
  ]);
  const row = (latest.results as Array<{ summary: string }>)[0];
  const points = trend.results as Array<{ probedAt: string; ok: number; probed: number; claudeMedian: number | null; toolsMedian: number }>;
  return {
    run: row ? (JSON.parse(row.summary) as Omit<RunSummary, K>) : null,
    earlier: points.map((r) => ({ probedAt: r.probedAt, ok: r.ok, probed: r.probed, claudeTokens: r.claudeMedian == null ? undefined : { median: r.claudeMedian }, toolsTokens: { median: r.toolsMedian } }))
  };
}

/** The runs from one date to another (ISO prefixes, the end excluded), oldest first, without the lists named. The monthly report reads one month this way. */
export async function runsBetween<K extends RunList = never>(from: string, to: string, without: K[] = []): Promise<Array<Omit<RunSummary, K>>> {
  const summary = summaryWithout(without);
  const { results } = await db()
    .prepare(`SELECT ${summary.sql} AS summary FROM runs WHERE probed_at >= ? AND probed_at < ? ORDER BY probed_at`)
    .bind(...summary.binds, from, to)
    .all<{ summary: string }>();
  return results.map((r) => JSON.parse(r.summary) as Omit<RunSummary, K>);
}

/** The headline numbers: exact Claude counts when the run has them, else the estimate. */
export function headline(run: Pick<RunSummary, 'claudeTokens' | 'toolsTokens'>): { stats: TokenStats; exact: boolean; model?: string } {
  return run.claudeTokens ? { stats: run.claudeTokens, exact: true, model: run.claudeTokens.model } : { stats: run.toolsTokens, exact: false };
}

function db(): D1Database {
  return (env as unknown as { DB: D1Database }).DB;
}

/** The latest run, without the lists named in `without` (see RunList). */
export async function latestRun<K extends RunList = never>(without: K[] = []): Promise<Omit<RunSummary, K> | null> {
  const summary = summaryWithout(without);
  const row = await db().prepare(`SELECT ${summary.sql} AS summary FROM runs ORDER BY probed_at DESC LIMIT 1`).bind(...summary.binds).first<{ summary: string }>();
  return row ? (JSON.parse(row.summary) as Omit<RunSummary, K>) : null;
}

/** Well-known servers for the front page, by their registry names. Order is the display order. */
export const NOTABLE: Array<{ name: string; label: string }> = [
  { name: 'io.github.github/github-mcp-server', label: 'GitHub' },
  { name: 'app.linear/linear', label: 'Linear' },
  { name: 'com.notion/mcp', label: 'Notion' },
  { name: 'com.stripe/mcp', label: 'Stripe' },
  { name: 'com.atlassian/atlassian-mcp-server', label: 'Atlassian' },
  { name: 'com.figma.mcp/mcp', label: 'Figma' },
  { name: 'io.github.getsentry/sentry-mcp', label: 'Sentry' },
  { name: 'com.supabase/mcp', label: 'Supabase' },
  { name: 'com.vercel/vercel-mcp', label: 'Vercel' },
  { name: 'com.cloudflare.mcp/mcp', label: 'Cloudflare docs' },
  { name: 'io.github.microsoft/playwright-mcp', label: 'Playwright' },
  { name: 'io.github.upstash/context7', label: 'Context7' },
  { name: 'co.huggingface/hf-mcp-server', label: 'Hugging Face' },
  { name: 'ai.exa/exa', label: 'Exa' },
  { name: 'io.github.firecrawl/firecrawl-mcp-server', label: 'Firecrawl' }
];

/** The rows for a list of names, in no particular order. One query, one row read per name. */
export async function serversByNames(names: string[]): Promise<Array<Pick<ServerRecord, 'name' | 'title' | 'status' | 'tool_count' | 'claude_tokens' | 'tools_tokens' | 'host'>>> {
  if (!names.length) return [];
  const { results } = await db()
    .prepare(`SELECT name, title, status, tool_count, claude_tokens, tools_tokens, host FROM servers WHERE name IN (${names.map(() => '?').join(',')})`)
    .bind(...names)
    .all<Pick<ServerRecord, 'name' | 'title' | 'status' | 'tool_count' | 'claude_tokens' | 'tools_tokens' | 'host'>>();
  return results;
}

export async function getServer(name: string): Promise<ServerRecord | null> {
  return db().prepare('SELECT * FROM servers WHERE name = ?').bind(name).first<ServerRecord>();
}

/** The registry name of the server at this URL, if any. */
export async function findByUrl(url: string): Promise<string | null> {
  const bare = url.replace(/\/$/, '');
  const row = await db()
    .prepare('SELECT name FROM servers WHERE url IN (?, ?, ?, ?) LIMIT 1')
    .bind(url, bare, bare + '/', bare.replace(/^http:/, 'https:'))
    .first<{ name: string }>();
  return row?.name ?? null;
}

/** Registry servers on the same host, for a URL that is not registered as is. */
export async function serversOnHost(host: string, limit = 8): Promise<Array<Pick<ServerRecord, 'name' | 'url' | 'status'>>> {
  const { results } = await db()
    .prepare('SELECT name, url, status FROM servers WHERE host = ? ORDER BY name LIMIT ?')
    .bind(host, limit)
    .all<Pick<ServerRecord, 'name' | 'url' | 'status'>>();
  return results;
}

export async function getHistory(name: string, limit = 60): Promise<ProbeRecord[]> {
  const { results } = await db()
    .prepare('SELECT probed_at, status, init_ms, tool_count, tools_tokens, claude_tokens FROM probes WHERE name = ? ORDER BY probed_at DESC LIMIT ?')
    .bind(name, limit)
    .all<ProbeRecord>();
  return results;
}

/** SQL list of the statuses in which the server answered: alive, or alive behind auth, payment or a missing input. */
const ANSWERED_STATUSES_SQL = `('ok', ${[...GATED_STATUSES].map((s) => `'${s}'`).join(', ')})`;

/** Whether any probe of the server ever got an answer. One index row for a server that did; a server page is noindex until then. */
export async function serverEverAnswered(name: string): Promise<boolean> {
  const row = await db()
    .prepare(`SELECT 1 AS answered FROM probes WHERE name = ? AND status IN ${ANSWERED_STATUSES_SQL} LIMIT 1`)
    .bind(name)
    .first<{ answered: number }>();
  return row !== null;
}

export async function getSiblings(hash: string, except: string, limit = 12): Promise<Array<Pick<ServerRecord, 'name' | 'host' | 'status'>>> {
  const { results } = await db()
    .prepare('SELECT name, host, status FROM servers WHERE toolset_hash = ? AND name <> ? ORDER BY name LIMIT ?')
    .bind(hash, except, limit)
    .all<Pick<ServerRecord, 'name' | 'host' | 'status'>>();
  return results;
}

/**
 * Everything the server page reads, in one round trip: the row, its history, the servers with the same tool set,
 * whether it ever answered, and the latest run without its long lists. The page made them in two awaits and a third
 * one for a server that never answered; each await costs CPU in the D1 client.
 */
export type RelatedServer = Pick<ServerRecord, 'name' | 'title' | 'host' | 'status'>;

/** Words that say nothing about what a server does, so no related-servers search runs on them. */
const EMPTY_WORDS = new Set([
  'mcp', 'server', 'servers', 'github', 'com', 'org', 'net', 'app', 'dev', 'api', 'tool', 'tools', 'the', 'and', 'for', 'with', 'from', 'your', 'this', 'that',
  'agent', 'agents', 'cloud', 'web', 'data', 'service', 'services', 'plugin', 'official', 'remote', 'http', 'https', 'www', 'npm', 'pypi', 'python', 'node',
  'main', 'test', 'demo', 'example', 'client', 'protocol', 'context', 'model', 'integration', 'assistant', 'platform', 'local', 'free', 'open', 'source', 'based', 'powered'
]);

/** The words of a text that a related-servers search can use: four letters or more, none of the empty ones, longest first. */
export function searchWords(text: string | null | undefined): string[] {
  if (!text) return [];
  const words = [...new Set(text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => [...w].length >= 4 && !EMPTY_WORDS.has(w)))];
  return words.sort((a, b) => b.length - a.length || a.localeCompare(b));
}

/**
 * The word of a registry name that a related-servers search runs on, before the row is read: the longest telling word
 * of the last segment ("adobe-mcp-illustrator": illustrator), else of the publisher segment without its reverse-domain
 * prefix ("io.github.zachshallbetter": zachshallbetter). Null when the name has no such word.
 */
export function relatedWord(name: string): string | null {
  const segments = name.replace(/^url\//, '').split('/');
  const last = segments[segments.length - 1] ?? '';
  const publisher = segments.slice(0, -1).join('/').replace(/^(?:[a-z]{2,4}\.)+(?=[^.]+$)/, '');
  return searchWords(last)[0] ?? searchWords(publisher)[0] ?? null;
}

/** An FTS5 query that finds the rows where any of the words occurs, inside words too (trigram tokenizer). */
function anyWord(words: string[]): string {
  return words.map((w) => `"${w.replace(/"/g, '')}"`).join(' OR ');
}

/** The statement that lists up to `limit` servers whose text mentions one of the words, except one server. Follows the list's FTS pattern: the match is capped first, then joined. */
function relatedStatement(d: D1Database, words: string[], except: string, limit: number): D1PreparedStatement {
  return d
    .prepare(`SELECT servers.name, servers.title, servers.host, servers.status FROM (SELECT rowid AS match_rowid FROM servers_fts WHERE servers_fts MATCH ? LIMIT ?) AS m CROSS JOIN servers ON servers.rowid = m.match_rowid WHERE servers.name <> ? LIMIT ?`)
    .bind(anyWord(words), limit + 1, except, limit);
}

/** How many related servers a page links to, in each of its two lists. */
export const RELATED_LIMIT = 8;

/**
 * Everything the server page reads, in one round trip: the row, its history, the servers with the same tool set,
 * whether it ever answered, the latest run without its long lists, and the links to other servers: the neighbours
 * on the same host, and the servers whose text mentions a word of the name. The page made them in two awaits and
 * a third one for a server that never answered; each await costs CPU in the D1 client.
 *
 * The links are the crawl path between server pages: the lists (/servers?...) are closed to crawlers, so without
 * them a server page is reached from the sitemap only, and Google indexes few pages that no page links to.
 */
export async function serverPage(name: string): Promise<{
  server: ServerRecord | null;
  history: ProbeRecord[];
  siblings: Array<Pick<ServerRecord, 'name' | 'host' | 'status'>>;
  everAnswered: boolean;
  run: Omit<RunSummary, 'topHosts' | 'changes' | 'heaviest'> | null;
  /** Other servers on the same host: the ones just after this name and just before it, so every page on a host links to different ones and the chain covers the host. */
  onHost: RelatedServer[];
  /** Servers whose name, title, description or host mentions `word`; empty when the name has no telling word or nothing else mentions it. */
  similar: RelatedServer[];
  word: string | null;
}> {
  const d = db();
  const summary = summaryWithout(['topHosts', 'changes', 'heaviest']);
  const word = relatedWord(name);
  const half = RELATED_LIMIT / 2;
  const [server, history, siblings, answered, run, after, before, similar] = await d.batch([
    d.prepare('SELECT * FROM servers WHERE name = ?').bind(name),
    d.prepare('SELECT probed_at, status, init_ms, tool_count, tools_tokens, claude_tokens FROM probes WHERE name = ? ORDER BY probed_at DESC LIMIT ?').bind(name, 60),
    // A server with no tool set hash has no siblings: = NULL matches nothing.
    d.prepare('SELECT name, host, status FROM servers WHERE toolset_hash = (SELECT toolset_hash FROM servers WHERE name = ?) AND name <> ? ORDER BY name LIMIT ?').bind(name, name, 12),
    d.prepare(`SELECT 1 AS answered FROM probes WHERE name = ? AND status IN ${ANSWERED_STATUSES_SQL} LIMIT 1`).bind(name),
    d.prepare(`SELECT ${summary.sql} AS summary FROM runs ORDER BY probed_at DESC LIMIT 1`).bind(...summary.binds),
    // Both walk the (host, name) index from this name outwards: half rows each, nothing else read.
    d.prepare('SELECT name, title, host, status FROM servers WHERE host = (SELECT host FROM servers WHERE name = ?) AND name > ? ORDER BY name LIMIT ?').bind(name, name, half),
    d.prepare('SELECT name, title, host, status FROM servers WHERE host = (SELECT host FROM servers WHERE name = ?) AND name < ? ORDER BY name DESC LIMIT ?').bind(name, name, half),
    word ? relatedStatement(d, [word], name, RELATED_LIMIT) : d.prepare('SELECT name, title, host, status FROM servers WHERE 0')
  ]);
  const row = (server.results as ServerRecord[])[0] ?? null;
  const latest = (run.results as Array<{ summary: string }>)[0];
  const onHost = [...(after.results as RelatedServer[]), ...(before.results as RelatedServer[])].sort((a, b) => a.name.localeCompare(b.name));
  const seen = new Set(onHost.map((s) => s.name));
  return {
    server: row,
    history: history.results as ProbeRecord[],
    siblings: siblings.results as Array<Pick<ServerRecord, 'name' | 'host' | 'status'>>,
    everAnswered: (answered.results as unknown[]).length > 0,
    run: latest ? (JSON.parse(latest.summary) as Omit<RunSummary, 'topHosts' | 'changes' | 'heaviest'>) : null,
    onHost,
    similar: (similar.results as RelatedServer[]).filter((s) => !seen.has(s.name)),
    word
  };
}

/**
 * A second look for a page whose name gave few related servers: the telling words of the title, up to two, or of the
 * description when the title has none. A word already tried is not tried again. One more round trip, for the pages
 * that need it only.
 */
export async function similarByTitle(title: string | null | undefined, description: string | null | undefined, except: string, exclude: Set<string>, tried: string[] = []): Promise<{ similar: RelatedServer[]; words: string[] }> {
  const fresh = (text: string | null | undefined) => searchWords(text).filter((w) => !tried.includes(w)).slice(0, 2);
  const words = fresh(title).length ? fresh(title) : fresh(description);
  if (!words.length) return { similar: [], words };
  const { results } = await relatedStatement(db(), words, except, RELATED_LIMIT + exclude.size).all<RelatedServer>();
  return { similar: results.filter((s) => !exclude.has(s.name)).slice(0, RELATED_LIMIT), words };
}

/** The number the board shows: the exact count when there is one, else the estimate. Two indexes in schema.sql hold this expression. */
export const SHOWN_TOKENS = 'coalesce(claude_tokens, tools_tokens)';

/**
 * "Not NULL" as a condition the sort's index can seek to. On a column SQLite seeks past the NULL entries;
 * on the indexed expression it does not and reads every NULL row first, about 20 000 in the All list.
 * A token count is never negative, so ">= 0" says the same and seeks.
 */
function notNull(col: string): string {
  return col === SHOWN_TOKENS ? `${col} >= 0` : `${col} IS NOT NULL`;
}

type Dir = 'ASC' | 'DESC';
interface SortSpec {
  /** The sort column or expression, or null when the sort is by name alone. */
  col: string | null;
  /** The row field that holds the sort value for the cursor, when it is not the column itself. */
  key?: string;
  dir: Dir;
  /** Direction of the name tie-break; the reverse of a sort reads its index backwards, so the name flips too. */
  nameDir: Dir;
  where: string;
  label: string;
}
const sortSpec = (col: string | null, dir: Dir, nameDir: Dir, where: string, label: string, key?: string): SortSpec => ({ col, dir, nameDir, where, label, key });

/**
 * Sort keys. Each matches an index in schema.sql. The opposite direction reads
 * the same index backwards, so its name tie-break is reversed too.
 */
export const SORTS = {
  // The Tokens column: the number the board shows, so a server with an estimate only ranks by that estimate.
  claude: sortSpec(SHOWN_TOKENS, 'DESC', 'ASC', '', 'tokens: most', 'shown_tokens'),
  'claude-asc': sortSpec(SHOWN_TOKENS, 'ASC', 'DESC', notNull(SHOWN_TOKENS), 'tokens: fewest', 'shown_tokens'),
  tokens: sortSpec('tools_tokens', 'DESC', 'ASC', '', 'estimate: largest'),
  'tokens-asc': sortSpec('tools_tokens', 'ASC', 'DESC', 'tools_tokens IS NOT NULL', 'estimate: smallest'),
  tools: sortSpec('tool_count', 'DESC', 'ASC', '', 'tools: most'),
  'tools-asc': sortSpec('tool_count', 'ASC', 'DESC', 'tool_count IS NOT NULL', 'tools: fewest'),
  latency: sortSpec('init_ms', 'ASC', 'ASC', 'init_ms IS NOT NULL', 'init: fastest'),
  'latency-desc': sortSpec('init_ms', 'DESC', 'DESC', 'init_ms IS NOT NULL', 'init: slowest'),
  name: sortSpec(null, 'ASC', 'ASC', '', 'name A to Z'),
  'name-desc': sortSpec(null, 'DESC', 'DESC', '', 'name Z to A'),
  status: sortSpec('status', 'ASC', 'ASC', '', 'result A to Z'),
  'status-desc': sortSpec('status', 'DESC', 'DESC', '', 'result Z to A'),
  protocol: sortSpec('protocol_version', 'ASC', 'ASC', 'protocol_version IS NOT NULL', 'protocol: oldest'),
  'protocol-desc': sortSpec('protocol_version', 'DESC', 'DESC', 'protocol_version IS NOT NULL', 'protocol: newest'),
  host: sortSpec('host', 'ASC', 'ASC', '', 'host A to Z'),
  'host-desc': sortSpec('host', 'DESC', 'DESC', '', 'host Z to A'),
  updated: sortSpec('registry_updated_at', 'DESC', 'ASC', '', 'updated: newest first')
} as const satisfies Record<string, SortSpec>;
export type SortKey = keyof typeof SORTS;
export const DEFAULT_SORT: SortKey = 'claude';

/** ORDER BY for a sort, forwards or (for a page before the cursor) backwards. */
function orderBy(sort: SortSpec, reverse = false): string {
  const flip = (d: Dir): Dir => (reverse ? (d === 'ASC' ? 'DESC' : 'ASC') : d);
  return sort.col ? `${sort.col} ${flip(sort.dir)}, name ${flip(sort.nameDir)}` : `name ${flip(sort.dir)}`;
}

/** A position in a sorted list: the sort value and the name of the row on the edge. */
export interface Cursor {
  value: string | number | null;
  name: string;
}

export function encodeCursor(c: Cursor): string {
  return btoa(unescape(encodeURIComponent(JSON.stringify([c.value, c.name])))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function decodeCursor(text: string | null | undefined): Cursor | null {
  if (!text) return null;
  try {
    const padded = text.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice(0, (4 - (text.length % 4)) % 4);
    const parsed = JSON.parse(decodeURIComponent(escape(atob(padded)))) as unknown;
    if (!Array.isArray(parsed) || parsed.length !== 2 || typeof parsed[1] !== 'string') return null;
    const value = parsed[0];
    if (value !== null && typeof value !== 'string' && typeof value !== 'number') return null;
    return { value, name: parsed[1] };
  } catch {
    return null;
  }
}

/** A condition of a cursor: its order when it is not the sort's, whether it bounds the sort value, which then is not NULL, and whether it reads the NULL tail. */
interface CursorCondition {
  sql: string;
  binds: unknown[];
  order?: string;
  bounded?: boolean;
  nullTail?: boolean;
}

/**
 * The rows after (or, going back, before) a cursor in this sort, as conditions the
 * sort's index can seek to, read one after the other until the page is full. One OR
 * across the value and the name tie-break cannot seek: the read started at the top of
 * the list, and following the next links to the end of the alive list read 2.8 million
 * rows. So the rest of the cursor's own value comes first, by name, then the values
 * beyond it; a value can hold thousands of rows (one host, one status, one tool count).
 * SQLite puts NULL first in ASC and last in DESC; the ascending sorts exclude NULL
 * through their `where`, and the NULL tail of a descending one comes last. A run of one
 * value is ordered by name alone: on the indexed expression SQLite does not see that the
 * value is the same throughout and sorted the whole run for every page.
 */
function cursorConditions(sort: SortSpec, cursor: Cursor, back: boolean): CursorCondition[] {
  const after = (d: Dir) => (back ? d === 'ASC' : d === 'DESC') ? '<' : '>';
  const nameOp = after(sort.nameDir);
  if (!sort.col) return [{ sql: `name ${after(sort.dir)} ?`, binds: [cursor.name] }];
  const byName = `name ${back === (sort.nameDir === 'ASC') ? 'DESC' : 'ASC'}`;
  if (cursor.value === null) {
    // Inside the NULL tail of a descending sort: by name within it; going back, the non-null rows come next.
    const tail = { sql: `${sort.col} IS NULL AND name ${nameOp} ?`, binds: [cursor.name], order: byName };
    return back ? [tail, { sql: notNull(sort.col), binds: [] }] : [tail];
  }
  const conditions: CursorCondition[] = [
    { sql: `${sort.col} = ? AND name ${nameOp} ?`, binds: [cursor.value, cursor.name], order: byName, bounded: true },
    { sql: `${sort.col} ${after(sort.dir)} ?`, binds: [cursor.value], bounded: true }
  ];
  if (sort.dir === 'DESC' && !back) conditions.push({ sql: `${sort.col} IS NULL`, binds: [], order: byName, nullTail: true });
  return conditions;
}

/** The gated statuses split in two: the server wants a key or a payment, or it wants setup (env, args, network, a newer protocol). */
export const ACCESS_STATUSES: ReadonlySet<string> = new Set(['auth', 'payment']);
export const SETUP_STATUSES: ReadonlySet<string> = new Set([...GATED_STATUSES].filter((s) => !ACCESS_STATUSES.has(s)));

/**
 * Page numbers go this far by OFFSET, which reads every row it skips: page n reads
 * about 50 n rows. With a number for every page, one client that walked the alive
 * list page by page read 6.2 million rows, more than the free tier's five million a
 * day, and the pager linked the last pages from the first. rel=nofollow and robots.txt
 * bind only the crawlers that honour them. Beyond this page the list moves by cursor,
 * 51 rows a page.
 */
export const MAX_NUMBERED_PAGE = 20;

export interface ListQuery {
  q?: string;
  status?: string;
  /** Part of a host name, matched anywhere in it. */
  host?: string;
  protocol?: string;
  transport?: string;
  /** A band of the shown token count, `lo-hi` with either end empty: `-1000`, `1000-5000`, `20000-`. */
  tokens?: string;
  sort?: SortKey;
  /** Page number, honoured up to MAX_NUMBERED_PAGE when there is no cursor. */
  page?: number;
  perPage?: number;
  /** Continue from this position instead of counting pages. */
  cursor?: Cursor | null;
  /** With a cursor: the page before it instead of the page after it. */
  back?: boolean;
  /** The latest run summary, when the caller has it; the list reads it otherwise. */
  run?: Pick<RunSummary, 'byStatus' | 'probed'> | null;
}

export const LIST_COLUMNS =
  `name, title, host, transport, status, failing_since, down_since, probed_at, http_status, auth_scheme, protocol_version, init_ms, tool_count, tools_tokens, claude_tokens, claude_tokens_cc, toolset_siblings, registry_updated_at, derived_package, derived_status, derived_tools_tokens, derived_claude_tokens, ${SHOWN_TOKENS} AS shown_tokens`;
export type ListRow = Pick<
  ServerRecord,
  | 'name' | 'title' | 'host' | 'transport' | 'status' | 'failing_since' | 'down_since' | 'probed_at' | 'http_status' | 'auth_scheme' | 'protocol_version'
  | 'init_ms' | 'tool_count' | 'tools_tokens' | 'claude_tokens' | 'claude_tokens_cc' | 'toolset_siblings' | 'registry_updated_at' | 'derived_package' | 'derived_status' | 'derived_tools_tokens' | 'derived_claude_tokens'
> & { shown_tokens: number | null };

export interface ListResult {
  rows: ListRow[];
  /** The sort the list used: the one asked for, or the default on a big list the asked one would scan. */
  sort: SortKey;
  hasNext: boolean;
  hasPrev: boolean;
  page: number;
  perPage: number;
  /** Position after the last row, for the next page. */
  nextCursor: Cursor | null;
  /** Position before the first row, for the previous page. */
  prevCursor: Cursor | null;
}

/**
 * Turns free text into an FTS5 query for the trigram tokenizer: every word of
 * three or more characters must occur somewhere, inside words too, so "deep wiki"
 * finds DeepWiki and "git copilot" finds api.githubcopilot.com. Shorter words
 * cannot be matched by trigrams and are dropped. Returns null when nothing is left.
 */
export function ftsQuery(q: string): string | null {
  const tokens = q
    .toLowerCase()
    .split(/[^\p{L}\p{N}_.\-]+/u)
    .map((t) => t.replace(/"/g, ''))
    .filter((t) => [...t].length >= 3)
    .slice(0, 6);
  if (!tokens.length) return null;
  return tokens.map((t) => `"${t}"`).join(' AND ');
}

/**
 * Lists one page of servers. There is no COUNT(*): on the free tier every row a
 * query scans counts against the daily budget, so the page asks for one row more
 * than it shows to know whether a next page exists. Text search goes through the
 * FTS5 table, so it reads only the matching rows. Page numbers use OFFSET, which
 * reads every row it skips, so they stop at MAX_NUMBERED_PAGE; from there the
 * list continues by cursor and a page costs its own rows only.
 */
/** A token band `lo-hi` (either end may be empty) as numbers, or null when the text is not one. */
export function tokenBand(text: string | undefined | null): { lo: number; hi: number | null } | null {
  const m = text?.match(/^(\d{0,7})-(\d{0,7})$/);
  if (!m || (!m[1] && !m[2])) return null;
  return { lo: Number(m[1] || 0), hi: m[2] ? Number(m[2]) : null };
}

/** The SQL of a token range: lower end in, upper end out. */
function tokenCondition(text: string | undefined): { sql: string; binds: number[] } | null {
  const band = tokenBand(text);
  if (!band) return null;
  return band.hi === null ? { sql: `${SHOWN_TOKENS} >= ?`, binds: [band.lo] } : { sql: `${SHOWN_TOKENS} >= ? AND ${SHOWN_TOKENS} < ?`, binds: [band.lo, band.hi] };
}

/**
 * At most this many full-text matches make a list or a count. A search or a host reads its matches and
 * sorts them, about three rows read per match; with more matches than this it ranks the first ones, and
 * the page says so. Six hosts have more servers than this, npmjs.com the most with 9 500.
 */
export const MATCH_CAP = 500;

/** The statuses that are not an answer: every status the board knows or the run counted, minus alive and gated. */
function downStatuses(run: Pick<RunSummary, 'byStatus'> | null): string[] {
  return [...new Set([...Object.keys(STATUS_LABEL), ...Object.keys(run?.byStatus ?? {})])].filter((s) => s !== 'ok' && s !== 'unprobed' && !GATED_STATUSES.has(s)).sort();
}

/**
 * A failing row that is down: two days of failed probes. The probe sets down_since from the real probe times
 * (isConfirmedDown); probed_at here is the time of the last change, so the board cannot compute it.
 */
const CONFIRMED_DOWN_SQL = '(down_since IS NOT NULL)';

/**
 * The failing statuses split in two: "down" is down for DOWN_AFTER_DAYS days or more, "noanswer" failed more
 * recently. A status parameter names a group (down, noanswer) or a group and a cause (down:timeout).
 */
function downCondition(status: string | undefined): string | null {
  const group = status?.split(':')[0];
  return group === 'down' ? CONFIRMED_DOWN_SQL : group === 'noanswer' ? `NOT ${CONFIRMED_DOWN_SQL}` : null;
}

/** The statuses of a status parameter, or null for every status. */
function statusesOf(status: string | undefined, run: Pick<RunSummary, 'byStatus'> | null): string[] | null {
  if (!status) return null;
  if (status === 'down' || status === 'noanswer') return downStatuses(run);
  if (/^(down|noanswer):/.test(status)) return [status.slice(status.indexOf(':') + 1)];
  if (status === 'gated') return [...GATED_STATUSES];
  if (status === 'access') return [...ACCESS_STATUSES];
  if (status === 'setup') return [...SETUP_STATUSES];
  return [status];
}

interface ListFilter {
  /** The full-text condition of the search and the host together, or null. */
  fts: string | null;
  /** The statuses the list holds, or null for every status. */
  statuses: string[] | null;
  /** The other conditions, with their values. */
  where: string[];
  binds: unknown[];
  /** The sort's own condition, "its value is not NULL", which a cursor bound on the value makes redundant. */
  sortWhere: string | null;
}

/** The filter of a list query, shared by the page and its count. */
function listFilter(query: ListQuery, run: Pick<RunSummary, 'byStatus'> | null, sort: SortSpec = SORTS[query.sort ?? DEFAULT_SORT] ?? SORTS[DEFAULT_SORT]): ListFilter {
  const where: string[] = [];
  const binds: unknown[] = [];
  const fts: string[] = [];
  const match = query.q ? ftsQuery(query.q) : null;
  if (match) fts.push(match);
  if (query.host) {
    // Part of a host name is enough: "foura" finds mcp.foura.ai. Three characters or more go through the
    // trigram index of the host column; a shorter text scans, which is rare.
    const h = query.host.trim().toLowerCase().replace(/"/g, '');
    if ([...h].length >= 3) fts.push(`host:"${h}"`);
    else {
      where.push('instr(lower(host), ?) > 0');
      binds.push(h);
    }
  }
  if (query.protocol) {
    where.push('protocol_version = ?');
    binds.push(query.protocol);
  }
  if (query.transport === 'sse' || query.transport === 'streamable-http' || query.transport === 'stdio') {
    where.push('transport = ?');
    binds.push(query.transport);
  }
  const band = tokenCondition(query.tokens);
  if (band) {
    where.push(band.sql);
    binds.push(...band.binds);
  }
  const down = downCondition(query.status);
  if (down) where.push(down);
  return { fts: fts.length ? fts.join(' AND ') : null, statuses: statusesOf(query.status, run), where, binds, sortWhere: sort.where || null };
}

/**
 * The table a list reads. With a full-text condition the matches come first: CROSS JOIN keeps them the
 * outer loop, so SQLite reads the matching rows by rowid and sorts them. As an IN condition it walked the
 * sort index of the whole status and tested every row: a host filter read 18 000 rows a page, and on the
 * night of 2026-10-22 scrapers that followed the host links of the server pages through every status,
 * sort and page spent the day's five million reads in an hour.
 */
function listFrom(fts: string | null): { sql: string; binds: unknown[] } {
  return fts
    ? { sql: `(SELECT rowid AS match_rowid FROM servers_fts WHERE servers_fts MATCH ? LIMIT ${MATCH_CAP + 1}) AS m CROSS JOIN servers ON servers.rowid = m.match_rowid`, binds: [fts] }
    : { sql: 'servers', binds: [] };
}

/** The status condition. A leading + keeps SQLite off the status indexes, so it walks the sort's own index. */
function statusCondition(statuses: string[] | null, walk: boolean): { sql: string | null; binds: unknown[] } {
  if (!statuses) return { sql: null, binds: [] };
  const col = walk ? '+status' : 'status';
  return statuses.length === 1 ? { sql: `${col} = ?`, binds: statuses } : { sql: `${col} IN (${statuses.map(() => '?').join(', ')})`, binds: statuses };
}

/**
 * How many servers of each status the other filters of a query leave: the counts on the
 * result segments and the cause chips, and the total of the list, all from one query. A
 * search or a host counts its matches, at most MATCH_CAP of them, and says when it stopped
 * there; the other filters read the whole table, so the page asks only when the run summary
 * cannot answer, and the edge keeps the page for hours.
 */
export interface StatusCount {
  /** Rows of this status under every other filter, the token range included. */
  n: number;
  /** Of those, the rows that failed for less than DOWN_AFTER_DAYS days: "no answer", not down. */
  na: number;
  /** The smallest and the largest shown token count of this status under the other filters, the token range left out. */
  lo: number | null;
  hi: number | null;
}
export async function countByStatus(query: Omit<ListQuery, 'status'>): Promise<{ counts: Record<string, StatusCount>; capped: boolean }> {
  const { fts, where: filters, binds, sortWhere } = listFilter({ ...query, status: '', tokens: undefined }, null);
  const from = listFrom(fts);
  const where = sortWhere ? [...filters, sortWhere] : filters;
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const band = tokenCondition(query.tokens);
  const count = band ? `count(*) FILTER (WHERE ${band.sql})` : 'count(*)';
  const notDown = band ? `count(*) FILTER (WHERE ${band.sql} AND NOT ${CONFIRMED_DOWN_SQL})` : `count(*) FILTER (WHERE NOT ${CONFIRMED_DOWN_SQL})`;
  const { results } = await db()
    .prepare(`SELECT status, ${count} AS n, ${notDown} AS na, count(*) AS rows_seen, min(${SHOWN_TOKENS}) AS lo, max(${SHOWN_TOKENS}) AS hi FROM ${from.sql} ${whereSql} GROUP BY status`)
    // The FILTER clauses stand before the FROM, and the FROM before the WHERE, so their values bind in that order.
    .bind(...(band?.binds ?? []), ...(band?.binds ?? []), ...from.binds, ...binds)
    .all<{ status: string; n: number; na: number; rows_seen: number; lo: number | null; hi: number | null }>();
  const seen = results.reduce((a, r) => a + r.rows_seen, 0);
  // na counts only for a failing status: an alive or gated row has no failing_since, and is never "no answer".
  const failing = (status: string) => status !== 'ok' && status !== 'unprobed' && !GATED_STATUSES.has(status);
  return { counts: Object.fromEntries(results.map((r) => [r.status, { n: r.n, na: failing(r.status) ? r.na : 0, lo: r.lo, hi: r.hi }])), capped: fts !== null && seen > MATCH_CAP };
}

/** Which indexes on the shown number exist: migration 007 builds the one with the status, 008 the one without. Asked once in ten minutes per isolate. */
let shownIndexed: { status: boolean; all: boolean; expires: number } | null = null;
async function shownIndexes(): Promise<{ status: boolean; all: boolean }> {
  const now = Date.now();
  if (shownIndexed && shownIndexed.expires > now) return shownIndexed;
  const { results } = await db().prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name IN ('servers_status_shown', 'servers_shown')").all<{ name: string }>();
  const names = new Set(results.map((r) => r.name));
  shownIndexed = { status: names.has('servers_status_shown'), all: names.has('servers_shown'), expires: now + 600_000 };
  return shownIndexed;
}

/**
 * The Tokens sort reads the index on the shown number that serves the list: a list by status reads
 * servers_status_shown (migration 007), a list over every status servers_shown (008). Until that index
 * exists the sort reads claude_tokens, whose index each migration drops only with its replacement:
 * sorting by an expression without its index reads the whole table, about 89 000 rows a page, and some
 * sixty such pages spend the free tier's five million reads.
 */
async function effectiveSort(spec: SortSpec, byStatus: boolean): Promise<SortSpec> {
  if (spec.col !== SHOWN_TOKENS) return spec;
  const indexed = await shownIndexes();
  if (byStatus ? indexed.status : indexed.all) return spec;
  return { ...spec, col: 'claude_tokens', key: 'claude_tokens', where: spec.where.replace(SHOWN_TOKENS, 'claude_tokens') };
}

/** A list this small, by the run summary, may sort by anything: SQLite reads its rows by status and sorts them. */
export const SMALL_LIST = MATCH_CAP;

export interface SortPlan {
  /** The sort the list uses: the one asked for, or the default when that one would read the whole table. */
  key: SortKey;
  /** Walk the sort's own index and test the status, instead of reading the status and sorting it. */
  walk: boolean;
  /** Read each status of the list on its own index and merge them. */
  merge: boolean;
}

/**
 * How a list sorts without reading the whole table. A search or a host sorts its matches, and a small
 * list its rows. A big list sorts by an index: the Tokens column, the name and the result have indexes
 * that start with the status, so a list of several statuses reads a page from each and merges them; the
 * host index holds every row, so a list of a tenth of the servers or more walks it and tests the status; the tool count is empty for every
 * server that did not answer, so its index serves only the alive list and the list of every server. The
 * other sorts (the estimate, the init time, the protocol, the registry date) have no index: on a big list
 * the list keeps the Tokens order and the page says why.
 */
export function sortPlan(query: Pick<ListQuery, 'q' | 'host' | 'status' | 'sort'>, run: Pick<RunSummary, 'byStatus' | 'probed'> | null): SortPlan {
  const key: SortKey = query.sort && SORTS[query.sort] ? query.sort : DEFAULT_SORT;
  const statuses = statusesOf(query.status, run);
  const searched = Boolean((query.q && ftsQuery(query.q)) || (query.host && [...query.host.trim()].length >= 3));
  const size = statuses ? (run ? statuses.reduce((a, s) => a + (run.byStatus[s] ?? 0), 0) : null) : (run?.probed ?? null);
  if (searched || (size !== null && size <= SMALL_LIST)) return { key, walk: false, merge: false };
  const several = (statuses?.length ?? 0) > 1;
  if (['claude', 'claude-asc', 'name', 'name-desc', 'status', 'status-desc'].includes(key)) return { key, walk: false, merge: several };
  // Walking the host index finds a page of a status in about 50 / share rows: fine for a tenth of the servers or more.
  if ((key === 'host' || key === 'host-desc') && (!statuses || (size !== null && run !== null && size * 10 >= run.probed))) return { key, walk: statuses !== null, merge: false };
  if ((key === 'tools' || key === 'tools-asc') && (!statuses || (statuses.length === 1 && statuses[0] === 'ok'))) return { key, walk: statuses !== null, merge: false };
  return { key: DEFAULT_SORT, walk: false, merge: several };
}

/** ORDER BY over the result columns of a merged list: the sort's column by its name in the row. */
function mergedOrderBy(sort: SortSpec, reverse: boolean, order?: string): string {
  if (order) return order;
  const flip = (d: Dir): Dir => (reverse ? (d === 'ASC' ? 'DESC' : 'ASC') : d);
  return sort.col ? `${sort.key ?? sort.col} ${flip(sort.dir)}, name ${flip(sort.nameDir)}` : `name ${flip(sort.dir)}`;
}

export async function listServers(query: ListQuery): Promise<ListResult> {
  const run = query.run === undefined ? await latestRun(['topHosts', 'changes', 'heaviest']) : query.run;
  const plan = sortPlan(query, run);
  const statuses = statusesOf(query.status, run);
  const sort = await effectiveSort(SORTS[plan.key], statuses !== null);
  const filter = listFilter(query, run, sort);
  const perPage = Math.min(200, Math.max(10, query.perPage ?? 50));
  const cursor = query.cursor ?? null;
  const back = Boolean(cursor && query.back);
  const page = cursor ? Math.max(1, query.page ?? 1) : Math.min(MAX_NUMBERED_PAGE, Math.max(1, query.page ?? 1));
  const offset = cursor ? 0 : (page - 1) * perPage;
  const results: ListRow[] = [];
  const conditions: CursorCondition[] = cursor ? cursorConditions(sort, cursor, back) : [{ sql: '', binds: [] }];
  for (const c of conditions) {
    // A walk tests the status on every row it reads, and its sorts have no NULL in the statuses it walks (a host is never
    // empty, an alive server has a tool count): the tail would read the NULL rows of every other status to find none.
    if (c.nullTail && plan.walk) continue;
    const want = perPage + 1 - results.length;
    const order = c.order ?? orderBy(sort, back);
    // A cursor bound on the sort value implies the sort's "not NULL"; with both, SQLite seeks by the one that reads from the start.
    const rest = [...filter.where, ...(filter.sortWhere && !c.bounded ? [filter.sortWhere] : []), ...(c.sql ? [c.sql] : [])];
    const restBinds = [...filter.binds, ...c.binds];
    let sql: string;
    let binds: unknown[];
    // D1 takes at most 100 values a query; a merge of many statuses with many filters reads by IN instead.
    if (plan.merge && statuses && !filter.fts && statuses.length * (restBinds.length + 2) + 2 <= 100) {
      const part = `SELECT * FROM (SELECT ${LIST_COLUMNS} FROM servers WHERE ${['status = ?', ...rest].join(' AND ')} ORDER BY ${order} LIMIT ?)`;
      // D1 allows five SELECTs in one UNION, so the statuses go in groups of five, and the groups in a UNION of their own.
      const groups: string[] = [];
      for (let i = 0; i < statuses.length; i += 5) groups.push(statuses.slice(i, i + 5).map(() => part).join(' UNION ALL '));
      // Each status reads up to the page's end, since any one of them could hold the whole page: a numbered page
      // deep in a list of thirteen statuses reads thirteen times its offset. The numbers stop at MAX_NUMBERED_PAGE
      // and the cursor beyond them has no offset, so this is at most 13 × 1 000 rows, once per list and page.
      sql = `${groups.length === 1 ? groups[0] : groups.map((g) => `SELECT * FROM (${g})`).join(' UNION ALL ')} ORDER BY ${mergedOrderBy(sort, back, c.order)} LIMIT ? OFFSET ?`;
      binds = [...statuses.flatMap((s) => [s, ...restBinds, offset + want]), want, offset];
    } else {
      const from = listFrom(filter.fts);
      const status = statusCondition(statuses, plan.walk);
      const all = status.sql ? [status.sql, ...rest] : rest;
      sql = `SELECT ${LIST_COLUMNS} FROM ${from.sql} ${all.length ? `WHERE ${all.join(' AND ')}` : ''} ORDER BY ${order} LIMIT ? OFFSET ?`;
      binds = [...from.binds, ...status.binds, ...restBinds, want, offset];
    }
    const { results: part } = await db().prepare(sql).bind(...binds).all<ListRow>();
    results.push(...part);
    if (results.length > perPage) break;
  }
  const more = results.length > perPage;
  const rows = results.slice(0, perPage);
  if (back) rows.reverse();
  const edge = (row: ListRow): Cursor => ({ value: sort.col ? ((row as unknown as Record<string, string | number | null>)[sort.key ?? sort.col] ?? null) : null, name: row.name });
  const first = rows[0];
  const last = rows[rows.length - 1];
  return {
    rows,
    sort: plan.key,
    hasNext: back ? true : more,
    hasPrev: back ? more : page > 1 || cursor !== null,
    page,
    perPage,
    nextCursor: last ? edge(last) : null,
    prevCursor: first ? edge(first) : null
  };
}

/**
 * The sitemap chunks that have servers in them. Chunk n holds the rowids in [n * size, (n + 1) * size).
 * The import writes with INSERT OR REPLACE, so a changed server gets a new rowid and old chunks empty out
 * over time; the index lists only the chunks that still have rows. One scan of the table, cached for a day.
 * D1 binds a JS number as a float, so the division is cast back to an integer.
 */
export async function serverSitemapChunks(size: number, lastmod: string): Promise<Array<{ chunk: number; lastmod: string }>> {
  // The largest rowid alone: one read, where a GROUP BY over the rowids read the whole table on every
  // crawler's visit from every edge. A chunk of removed rows only comes out empty, which a crawler takes in stride.
  const row = await db().prepare('SELECT max(rowid) AS top FROM servers').first<{ top: number | null }>();
  const top = row?.top ?? 0;
  return Array.from({ length: Math.floor(top / size) + 1 }, (_, chunk) => ({ chunk, lastmod }));
}

/**
 * The <url> lines of one sitemap chunk, made by D1: a rowid range, so the read touches only its own rows.
 * A server that never answered a probe stays out: its page says only "timeout" or "error", and
 * Google reads such a page as a soft 404. The EXISTS runs for the servers that are down now only.
 * D1 writes the lines, so the Worker parses one string, not 5 000 rows, and builds no line itself; building
 * them was most of a chunk's 15 ms of CPU at the median. `prefix` is the escaped URL before the name.
 */
export async function sitemapChunkLines(chunk: number, size: number, prefix: string): Promise<string> {
  const row = await db()
    .prepare(
      `SELECT group_concat('  <url><loc>' || ? || replace(replace(replace(replace(name, '&', '&amp;'), '<', '&lt;'), '>', '&gt;'), '"', '&quot;')
           || '</loc><lastmod>' || substr(probed_at, 1, 10) || '</lastmod></url>', char(10) ORDER BY rowid) AS lines
         FROM servers WHERE rowid >= ? AND rowid < ?
         AND (status IN ${ANSWERED_STATUSES_SQL}
           OR EXISTS (SELECT 1 FROM probes WHERE probes.name = servers.name AND probes.status IN ${ANSWERED_STATUSES_SQL}))`
    )
    .bind(prefix, chunk * size, (chunk + 1) * size)
    .first<{ lines: string | null }>();
  return row?.lines ?? '';
}

/** The biggest hosts: from the run summary when the run carries them, else from the hosts table of older runs. */
export async function listHosts(limit = 300, run?: Pick<RunSummary, 'topHosts' | 'probedAt'> | null): Promise<HostRecord[]> {
  const r = run === undefined ? await latestRun(['changes', 'heaviest']) : run;
  if (r?.topHosts) {
    return r.topHosts.slice(0, limit).map((h) => ({ host: h.host, servers: h.servers, ok: h.ok, auth: h.gated, dead: h.dead, unique_toolsets: h.uniqueToolsets, median_tokens: h.medianTokens, probed_at: r.probedAt }));
  }
  const { results } = await db().prepare('SELECT * FROM hosts ORDER BY servers DESC LIMIT ?').bind(limit).all<HostRecord>();
  return results;
}
