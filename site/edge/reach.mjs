/**
 * Who comes to the board, week by week: visits from Cloudflare Web Analytics (its beacon runs only in real browsers,
 * so crawlers do not count), where they came from (search engines, AI answers, links), what the package and the
 * repository get, how many people use the board's own features (alerts, servers tracked from /check), and who calls
 * the board's MCP server (the daily counts of site/src/lib/mcp-use.ts). The owner
 * keeps the paid Workers plan while the board is successful; this is the page that says whether it is.
 *
 *   CLOUDFLARE_API_TOKEN=… CLOUDFLARE_ACCOUNT_ID=… GH_TOKEN=… node site/edge/reach.mjs [end]
 *
 * end is an ISO 8601 time (UTC), now by default. The report compares the seven days before it with the seven days
 * before those. The workflow reach.yml runs it every Monday; the report is its step summary.
 */
import { writeFileSync, appendFileSync } from 'node:fs';

const token = process.env.CLOUDFLARE_API_TOKEN;
const acct = process.env.CLOUDFLARE_ACCOUNT_ID;
const ghToken = process.env.GH_TOKEN;
const API = 'https://api.cloudflare.com/client/v4';
const HOST = 'mcpcost.ulehla.dev';
const SCRIPT = 'mcpcost';
const DB_ID = 'f1984775-849a-4277-805e-537ea5ad7611';
const REPO = 'ondraulehla/mcpcost';
const PACKAGE = 'mcpcost';
/** Pull requests that would list the board somewhere; merged is a listing. */
const LISTINGS = [
  ['punkpeye/awesome-remote-mcp-servers', 2823],
  ['punkpeye/awesome-mcp-devtools', 393]
];

const end = process.argv[2] ? new Date(process.argv[2]) : new Date();
if (Number.isNaN(end.getTime())) {
  console.error('Usage: node site/edge/reach.mjs [end], an ISO 8601 time.');
  process.exit(2);
}
if (!token || !acct) {
  console.error('CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID are not set.');
  process.exit(2);
}
const DAY = 86_400_000;
const week = { from: new Date(end.getTime() - 7 * DAY), to: end };
const before = { from: new Date(end.getTime() - 14 * DAY), to: week.from };
const iso = (d) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');
const fmt = (n) => (n === undefined || n === null ? 'n/a' : Math.round(n).toLocaleString('en-US'));
const change = (now, then) => (!then ? (now ? 'new' : '-') : `${now >= then ? '+' : ''}${Math.round(((now - then) / then) * 100)} %`);

async function cf(path, body) {
  const r = await fetch(API + path, {
    method: body ? 'POST' : 'GET',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.success === false || j.errors?.length) throw new Error(`${path}: HTTP ${r.status} ${JSON.stringify(j.errors ?? j).slice(0, 300)}`);
  return j;
}
const gql = (query, variables) => cf('/graphql', { query, variables }).then((j) => j.data.viewer.accounts[0] ?? {});

/** Page views and visits from the beacon, in one window: the totals, and by day, referrer, page and country. */
async function rum({ from, to }) {
  const f = `{datetime_geq: $from, datetime_lt: $to, requestHost: "${HOST}"}`;
  return gql(
    `query($acct: string!, $from: Time!, $to: Time!) { viewer { accounts(filter: {accountTag: $acct}) {
      total: rumPageloadEventsAdaptiveGroups(limit: 1, filter: ${f}) { count sum { visits } }
      days: rumPageloadEventsAdaptiveGroups(limit: 20, filter: ${f}, orderBy: [date_ASC]) { count sum { visits } dimensions { date } }
      referers: rumPageloadEventsAdaptiveGroups(limit: 60, filter: ${f}, orderBy: [sum_visits_DESC]) { count sum { visits } dimensions { refererHost } }
      paths: rumPageloadEventsAdaptiveGroups(limit: 15, filter: ${f}, orderBy: [count_DESC]) { count sum { visits } dimensions { requestPath } }
      countries: rumPageloadEventsAdaptiveGroups(limit: 10, filter: ${f}, orderBy: [sum_visits_DESC]) { count sum { visits } dimensions { countryName } }
    } } }`,
    { acct, from: iso(from), to: iso(to) }
  );
}

/** Every request the Worker answered in a window, people and crawlers alike. */
async function workerRequests({ from, to }) {
  const a = await gql(
    `query($acct: string!, $from: Time!, $to: Time!) { viewer { accounts(filter: {accountTag: $acct}) {
      workersInvocationsAdaptive(limit: 100, filter: {datetime_geq: $from, datetime_lt: $to, scriptName: "${SCRIPT}"}) { sum { requests } dimensions { date } }
    } } }`,
    { acct, from: iso(from), to: iso(to) }
  );
  return (a.workersInvocationsAdaptive ?? []).reduce((n, r) => n + r.sum.requests, 0);
}

/** The board's own features: alert subscriptions and servers tracked from /check. */
async function features() {
  const j = await cf(`/accounts/${acct}/d1/database/${DB_ID}/query`, {
    sql: `SELECT
      (SELECT count(*) FROM watches WHERE confirmed_at IS NOT NULL AND stopped_at IS NULL) AS alerts,
      (SELECT count(DISTINCT server) FROM watches WHERE confirmed_at IS NOT NULL AND stopped_at IS NULL) AS alertServers,
      (SELECT count(*) FROM watches WHERE confirmed_at >= ?1) AS alertsNew,
      (SELECT count(*) FROM tracked) AS tracked,
      (SELECT count(*) FROM tracked WHERE submitted_at >= ?1) AS trackedNew`,
    params: [week.from.toISOString()]
  });
  return j.result?.[0]?.results?.[0] ?? {};
}

/** One D1 query with parameters, as rows. */
async function d1(sql, params = []) {
  const j = await cf(`/accounts/${acct}/d1/database/${DB_ID}/query`, { sql, params });
  return j.result?.[0]?.results ?? [];
}

/**
 * Use of the board's own MCP server, from the table mcp_use: one count for each UTC day, agent, client name, method
 * and tool. The windows are whole UTC days, the seven before the day of the report and the seven before those.
 * A directory's probe sends initialize and tools/list; a tools/call is use.
 */
async function mcpUse() {
  const day = (d) => d.toISOString().slice(0, 10);
  const [a, b, c] = [day(before.from), day(week.from), day(week.to)];
  const calls = "sum(CASE WHEN method = 'tools/call' THEN count ELSE 0 END)";
  const totals = `SELECT coalesce(sum(count), 0) AS requests, coalesce(${calls}, 0) AS calls, count(DISTINCT agent) AS agents,
    count(DISTINCT CASE WHEN method = 'tools/call' THEN agent END) AS callers, count(DISTINCT day) AS days
    FROM mcp_use WHERE day >= ?1 AND day < ?2`;
  const [now, then, agents, tools, clients] = await Promise.all([
    d1(totals, [b, c]),
    d1(totals, [a, b]),
    d1(
      `SELECT agent, sum(CASE WHEN method = 'initialize' THEN count ELSE 0 END) AS initialize,
        sum(CASE WHEN method = 'tools/list' THEN count ELSE 0 END) AS lists, ${calls} AS calls, sum(count) AS requests
        FROM mcp_use WHERE day >= ?1 AND day < ?2 GROUP BY agent ORDER BY calls DESC, requests DESC LIMIT 25`,
      [b, c]
    ),
    d1(`SELECT tool, sum(count) AS calls, count(DISTINCT agent) AS agents FROM mcp_use WHERE method = 'tools/call' AND day >= ?1 AND day < ?2 GROUP BY tool ORDER BY calls DESC`, [b, c]),
    d1(`SELECT client, sum(count) AS sessions, count(DISTINCT agent) AS agents FROM mcp_use WHERE method = 'initialize' AND day >= ?1 AND day < ?2 GROUP BY client ORDER BY sessions DESC LIMIT 20`, [b, c])
  ]);
  return { now: now[0] ?? {}, then: then[0] ?? {}, agents, tools, clients, from: b, to: c };
}

async function github(path) {
  const r = await fetch(`https://api.github.com${path}`, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'mcpcost-reach', ...(ghToken ? { authorization: `Bearer ${ghToken}` } : {}) } });
  if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
  return r.json();
}

/** Downloads of every version in the last seven days. npm's per-day API stopped in July 2026; this one is current. */
async function npmWeek() {
  const r = await fetch(`https://api.npmjs.org/versions/${PACKAGE}/last-week`);
  if (!r.ok) throw new Error(`npm: HTTP ${r.status}`);
  const j = await r.json();
  return Object.values(j.downloads ?? {}).reduce((a, b) => a + b, 0);
}

/** Where a visit came from, by the referrer's host. */
function source(host) {
  if (!host) return 'direct or hidden';
  const h = host.toLowerCase().replace(/^www\./, '');
  if (h === HOST) return 'the board itself';
  // AI first: gemini.google.com is not a search engine visit.
  if (/chatgpt\.com|openai\.com|perplexity\.ai|claude\.ai|gemini\.google|copilot\.microsoft|you\.com|phind\.com|kagi\.com|mistral\.ai|deepseek/.test(h)) return 'AI answers';
  if (/(^|\.)(google|bing|duckduckgo|yandex|baidu|ecosia|qwant|startpage|yahoo|naver|seznam)\.|search\.brave\.com/.test(h)) return 'search engines';
  if (/github\.com|gitlab\.com|npmjs\.com|pypi\.org|glama\.ai|smithery\.ai|pulsemcp\.com|mcp\.so|lobehub\.com|modelcontextprotocol\.io/.test(h)) return 'code and MCP directories';
  if (/news\.ycombinator\.com|reddit\.com|x\.com|^t\.co$|twitter\.com|linkedin\.com|lnkd\.in|facebook\.com|bsky\.app|mastodon|discord|slack|dev\.to|medium\.com|substack/.test(h)) return 'social and news';
  return 'other sites';
}

const settle = (p) => p.then((value) => ({ value }), (e) => ({ error: e.message }));
const [now, then, reqNow, reqThen, feat, mcp, repo, npm, ...lists] = await Promise.all([
  settle(rum(week)),
  settle(rum(before)),
  settle(workerRequests(week)),
  settle(workerRequests(before)),
  settle(features()),
  settle(mcpUse()),
  settle(github(`/repos/${REPO}`)),
  settle(npmWeek()),
  ...LISTINGS.map(([r, n]) => settle(github(`/repos/${r}/pulls/${n}`)))
]);

const lines = [];
const say = (s = '') => {
  lines.push(s);
  console.log(s);
};
const total = (r) => r.value?.total?.[0];
const bySource = (r) => {
  const m = new Map();
  for (const x of r.value?.referers ?? []) {
    const s = source(x.dimensions.refererHost);
    if (s === 'the board itself') continue;
    m.set(s, (m.get(s) ?? 0) + x.sum.visits);
  }
  return m;
};

say(`# Reach, ${iso(week.from).slice(0, 10)} to ${iso(week.to).slice(0, 10)}`);
say();
say('Visits are sessions that start on the board, from the Web Analytics beacon: it runs in real browsers only, so crawlers are not in them. Cloudflare samples the beacon, so small numbers move by a few.');
say();
if (now.error || then.error) say(`Web Analytics could not be read: ${now.error ?? then.error}`);
const srcNow = bySource(now);
const srcThen = bySource(then);
say('| | last 7 days | the 7 days before | change |');
say('|---|---:|---:|---:|');
if (!now.error) {
  say(`| Visits | ${fmt(total(now)?.sum.visits ?? 0)} | ${fmt(total(then)?.sum.visits ?? 0)} | ${change(total(now)?.sum.visits ?? 0, total(then)?.sum.visits ?? 0)} |`);
  say(`| Page views | ${fmt(total(now)?.count ?? 0)} | ${fmt(total(then)?.count ?? 0)} | ${change(total(now)?.count ?? 0, total(then)?.count ?? 0)} |`);
  for (const s of ['search engines', 'AI answers', 'code and MCP directories', 'social and news', 'other sites', 'direct or hidden']) {
    say(`| Visits from ${s} | ${fmt(srcNow.get(s) ?? 0)} | ${fmt(srcThen.get(s) ?? 0)} | ${change(srcNow.get(s) ?? 0, srcThen.get(s) ?? 0)} |`);
  }
}
say(`| Worker requests, crawlers included | ${fmt(reqNow.value)} | ${fmt(reqThen.value)} | ${reqNow.value !== undefined && reqThen.value !== undefined ? change(reqNow.value, reqThen.value) : '-'} |`);
say(`| npm downloads, all versions | ${fmt(npm.value)} | | |`);
say(`| GitHub stars | ${fmt(repo.value?.stargazers_count)} | | |`);
say(`| Alert subscriptions, active | ${fmt(feat.value?.alerts)} (${fmt(feat.value?.alertServers)} servers) | | ${fmt(feat.value?.alertsNew)} new |`);
say(`| Servers tracked from /check | ${fmt(feat.value?.tracked)} | | ${fmt(feat.value?.trackedNew)} new |`);
say();
for (const [label, r] of [['npm', npm], ['GitHub', repo], ['D1', feat], ['Worker analytics', reqNow]]) if (r.error) say(`${label} could not be read: ${r.error}`);

if (!now.error) {
  const table = (title, rows, head, key) => {
    if (!rows?.length) return;
    say(`## ${title}`);
    say();
    say(`| ${head} | visits | page views |`);
    say('|---|---:|---:|');
    for (const x of rows) say(`| ${key(x).replace(/\|/g, '\\|')} | ${fmt(x.sum.visits)} | ${fmt(x.count)} |`);
    say();
  };
  table('Referrers', (now.value.referers ?? []).filter((x) => source(x.dimensions.refererHost) !== 'the board itself').slice(0, 15), 'referrer', (x) => `${x.dimensions.refererHost || '(none)'} · ${source(x.dimensions.refererHost)}`);
  table('Pages', now.value.paths, 'page', (x) => x.dimensions.requestPath);
  table('Countries', now.value.countries, 'country', (x) => x.dimensions.countryName || '-');
  table('Days', now.value.days, 'day', (x) => x.dimensions.date);
}

say('## MCP server');
say();
if (mcp.error) say(`The counts of the MCP server could not be read: ${mcp.error}`);
else {
  const m = mcp.value;
  const cell = (text) => String(text || '(none)').replace(/\|/g, '\\|');
  say(`Requests to /mcp in whole UTC days, ${m.from} up to and not including ${m.to}, by what the request asked for. A directory's probe sends initialize and tools/list. A tool call is use. The counts hold no address and no argument.${m.now.days < 7 ? ` Counts exist for ${fmt(m.now.days)} of the 7 days.` : ''}`);
  say();
  say('| | last 7 days | the 7 days before | change |');
  say('|---|---:|---:|---:|');
  say(`| Tool calls | ${fmt(m.now.calls)} | ${fmt(m.then.calls)} | ${change(m.now.calls, m.then.calls)} |`);
  say(`| Agents that called a tool | ${fmt(m.now.callers)} | ${fmt(m.then.callers)} | ${change(m.now.callers, m.then.callers)} |`);
  say(`| Requests, all methods | ${fmt(m.now.requests)} | ${fmt(m.then.requests)} | ${change(m.now.requests, m.then.requests)} |`);
  say(`| Agents, all | ${fmt(m.now.agents)} | ${fmt(m.then.agents)} | ${change(m.now.agents, m.then.agents)} |`);
  say();
  if (m.tools.length) {
    say('| tool | calls | agents |');
    say('|---|---:|---:|');
    for (const t of m.tools) say(`| ${cell(t.tool)} | ${fmt(t.calls)} | ${fmt(t.agents)} |`);
    say();
  }
  if (m.agents.length) {
    say('| agent (User-Agent), most tool calls first | initialize | tools/list | tools/call | all requests |');
    say('|---|---:|---:|---:|---:|');
    for (const x of m.agents) say(`| ${cell(x.agent)} | ${fmt(x.initialize)} | ${fmt(x.lists)} | ${fmt(x.calls)} | ${fmt(x.requests)} |`);
    say();
  }
  if (m.clients.length) {
    say('| client name in initialize | sessions | agents |');
    say('|---|---:|---:|');
    for (const x of m.clients) say(`| ${cell(x.client)} | ${fmt(x.sessions)} | ${fmt(x.agents)} |`);
    say();
  }
}

say('## Listings');
say();
LISTINGS.forEach(([r, n], i) => {
  const p = lists[i];
  say(`- ${r}#${n}: ${p.error ? `could not be read (${p.error})` : p.value.merged_at ? `merged ${p.value.merged_at.slice(0, 10)}` : p.value.state === 'closed' ? 'closed without a merge' : `open since ${p.value.created_at.slice(0, 10)}`}`);
});

if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join('\n') + '\n');
if (process.env.REACH_REPORT_FILE) writeFileSync(process.env.REACH_REPORT_FILE, lines.join('\n') + '\n');
// Cloudflare is the source that matters; without it the run fails, so a broken token is noticed.
process.exit(now.error ? 1 : 0);
