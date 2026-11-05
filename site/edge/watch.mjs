/**
 * Who reads the board and what it costs: the Worker's requests, the database rows they read, and the
 * networks and agents behind them, for one window of time (the last hour by default). The workflow
 * watch.yml runs this every hour and opens or updates a GitHub issue when a threshold is crossed, so a
 * scraper that gets past the edge rules is noticed the hour it starts, not the morning after the limit.
 *
 *   CLOUDFLARE_API_TOKEN=… CLOUDFLARE_ACCOUNT_ID=… node site/edge/watch.mjs [from] [to]
 *
 * from and to are ISO 8601 times (UTC); without them, the hour that ended two minutes ago (the logs
 * arrive with a short delay). The workflow hands a scheduled run the time of the previous scheduled run as
 * from, since GitHub runs a schedule late and skips hours at times; the thresholds apply to the worst hour
 * of the window, so a long window reports the same as the hourly ones it stands in for. CLOUDFLARE_ZONE_TOKEN, when set and allowed Zone: Analytics: Read, adds
 * what the zone stopped before the Worker. Exit status 1 when a threshold is crossed, 2 when Cloudflare
 * could not be asked. The thresholds are the WATCH_* variables, per hour of the window.
 */
import { appendFileSync, writeFileSync } from 'node:fs';

const token = process.env.CLOUDFLARE_API_TOKEN;
const acct = process.env.CLOUDFLARE_ACCOUNT_ID;
const zoneToken = process.env.CLOUDFLARE_ZONE_TOKEN;
const API = 'https://api.cloudflare.com/client/v4';
const HOST = 'mcpcost.ulehla.dev';
const SCRIPT = 'mcpcost';
const DB_ID = 'f1984775-849a-4277-805e-537ea5ad7611';

/**
 * The thresholds, per hour. The scrapers of October 2026 made 4 000 requests an hour from one network, readers
 * make a few hundred a day. Since the server pages link to each other (2026-11-04) the named crawlers (Google,
 * Perplexity) walk the board at about 10 000 requests an hour together, which the Workers Paid plan covers,
 * so the threshold for everyone sits above them; the per-network thresholds below still catch a scraper.
 */
const LIMITS = {
  requests: Number(process.env.WATCH_REQUESTS_PER_HOUR ?? 25_000), // Worker requests from everyone
  network: Number(process.env.WATCH_NETWORK_REQUESTS_PER_HOUR ?? 800), // requests from one network that does not name itself a crawler
  lists: Number(process.env.WATCH_LIST_REQUESTS_PER_HOUR ?? 300), // list variants from one network, whatever it calls itself: robots.txt disallows them for everyone
  rowsRead: Number(process.env.WATCH_ROWS_READ_PER_HOUR ?? 1_000_000) // D1 rows read
};

const args = process.argv.slice(2).filter((a) => a && !a.startsWith('--'));
const to = args[1] ? new Date(args[1]) : new Date(Date.now() - 2 * 60_000);
const from = args[0] ? new Date(args[0]) : new Date(to.getTime() - 60 * 60_000);
if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from >= to) {
  console.error('Usage: node site/edge/watch.mjs [from] [to], ISO 8601 times with from before to.');
  process.exit(2);
}
if (!token || !acct) {
  console.error('CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID are not set.');
  process.exit(2);
}
const hours = (to.getTime() - from.getTime()) / 3_600_000;
const iso = (d) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');
const perHour = (n) => Math.round(n / hours);
const fmt = (n) => Math.round(n).toLocaleString('en-US');

async function cf(path, body, bearer = token) {
  const r = await fetch(API + path, {
    method: body ? 'POST' : 'GET',
    headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.success === false || j.errors?.length) throw new Error(`${path}: HTTP ${r.status} ${JSON.stringify(j.errors ?? j).slice(0, 300)}`);
  return j;
}
const gql = (query, variables, bearer) => cf('/graphql', { query, variables }, bearer).then((j) => j.data);

/** Worker requests per hour, from the account's analytics: every request the Worker answered, a 403 as much as a page. */
async function workerHours(since, until) {
  const d = await gql(
    `query($acct: string!, $from: Time!, $to: Time!) { viewer { accounts(filter: {accountTag: $acct}) {
      workersInvocationsAdaptive(limit: 500, filter: {datetime_geq: $from, datetime_leq: $to, scriptName: "${SCRIPT}"}, orderBy: [datetimeHour_ASC]) {
        sum { requests errors } dimensions { datetimeHour } } } } }`,
    { acct, from: iso(since), to: iso(until) }
  );
  const byHour = new Map();
  for (const r of d.viewer.accounts[0]?.workersInvocationsAdaptive ?? []) {
    const h = byHour.get(r.dimensions.datetimeHour) ?? { requests: 0, errors: 0 };
    h.requests += r.sum.requests;
    h.errors += r.sum.errors;
    byHour.set(r.dimensions.datetimeHour, h);
  }
  return byHour;
}

/** D1 rows read and written per hour of a day. */
async function d1Hours(day) {
  const d = await gql(
    `query($acct: string!, $db: string!, $since: Date!) { viewer { accounts(filter: {accountTag: $acct}) {
      d1AnalyticsAdaptiveGroups(limit: 200, filter: {date_geq: $since, databaseId: $db}, orderBy: [datetimeHour_ASC]) {
        sum { readQueries rowsRead rowsWritten } dimensions { datetimeHour } } } } }`,
    { acct, db: DB_ID, since: day }
  );
  const byHour = new Map();
  for (const r of d.viewer.accounts[0]?.d1AnalyticsAdaptiveGroups ?? []) {
    const h = byHour.get(r.dimensions.datetimeHour) ?? { rowsRead: 0, rowsWritten: 0, queries: 0 };
    h.rowsRead += r.sum.rowsRead;
    h.rowsWritten += r.sum.rowsWritten;
    h.queries += r.sum.readQueries;
    byHour.set(r.dimensions.datetimeHour, h);
  }
  return byHour;
}

/** The Worker's log events in the window, in ten-minute slices so one query's limit does not cut an hour short. */
async function events(since, until) {
  const out = [];
  let truncated = false;
  const step = 10 * 60_000;
  const limit = 2000;
  for (let t = since.getTime(); t < until.getTime(); t += step) {
    const j = await cf(`/accounts/${acct}/workers/observability/telemetry/query`, {
      queryId: `watch-${t}`,
      timeframe: { from: t, to: Math.min(t + step, until.getTime()) },
      view: 'events',
      limit,
      parameters: { datasets: ['cloudflare-workers'], filters: [{ key: '$workers.scriptName', operation: 'eq', type: 'string', value: SCRIPT }] }
    });
    const ev = j.result?.events?.events ?? j.result?.events ?? [];
    if (!Array.isArray(ev)) continue;
    if (ev.length >= limit) truncated = true;
    out.push(...ev);
  }
  return { events: out, truncated };
}

/** The queries that read the most rows in the window, so a spike has a name. */
async function d1TopQueries(since, until) {
  const hour = new Date(Math.floor(since.getTime() / 3_600_000) * 3_600_000);
  const d = await gql(
    `query($acct: string!) { viewer { accounts(filter: {accountTag: $acct}) {
      d1QueriesAdaptiveGroups(limit: 8, filter: {datetimeHour_geq: "${iso(hour)}", datetimeHour_leq: "${iso(until)}", databaseId: "${DB_ID}"}, orderBy: [sum_rowsRead_DESC]) {
        sum { rowsRead } count avg { rowsRead } dimensions { query } } } } }`,
    { acct }
  );
  return d.viewer.accounts[0]?.d1QueriesAdaptiveGroups ?? [];
}

/** The first object under this key, wherever the log puts it. */
function under(obj, key) {
  if (!obj || typeof obj !== 'object') return undefined;
  if (obj[key] !== undefined) return obj[key];
  for (const v of Object.values(obj)) {
    if (v && typeof v === 'object') {
      const hit = under(v, key);
      if (hit !== undefined) return hit;
    }
  }
  return undefined;
}

/** A URL as a class: server pages folded into one, list variants told apart by their parameters. */
function shape(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    return String(raw).slice(0, 60);
  }
  let p = u.pathname;
  if (p.startsWith('/s/')) p = p.endsWith('.xml') ? '/s/*.xml' : '/s/*';
  else if (p.startsWith('/api/s/')) p = '/api/s/*';
  else if (p.startsWith('/badge/')) p = '/badge/*';
  else if (/^\/sitemap-\d+\.xml$/.test(p)) p = '/sitemap-N.xml';
  const keys = [...u.searchParams.keys()].sort();
  return `${p}${keys.length ? '?' + keys.join('&') : ''}`;
}

/** What kind of client an agent string names. The scrapers of October 2026 sent Chrome's. */
function kind(agent) {
  if (!agent) return 'no agent';
  if (/bot|crawl|spider|slurp|externalhit|externalagent|preview|validator|monitor|feedfetcher|archive/i.test(agent)) return 'named crawler';
  // Google's crawlers and fetchers whose names do not say bot. GoogleOther sent 4,484 requests in a night of October 2026.
  if (/GoogleOther|GoogleProducer|Google-(?:InspectionTool|Read-Aloud|Site-Verification|Safety|NotebookLM)|Mediapartners-Google|APIs-Google/.test(agent)) return 'named crawler';
  if (/Mozilla\/5\.0/.test(agent) && /Chrome|Safari|Firefox|Edg/.test(agent)) return 'browser';
  return 'tool';
}
const bump = (m, k, by = 1) => m.set(k, (m.get(k) ?? 0) + by);
/** The hourly bucket with the most of a field: GitHub runs the schedule late and skips hours at times, so a window may span many. */
function worstHour(byHour, field) {
  let best = { hour: '', value: 0 };
  for (const [hour, h] of byHour) if (h[field] > best.value) best = { hour, value: h[field] };
  return best;
}
/** The most in any 60 minutes of a window, from ten-minute buckets keyed by ISO minute; a window under an hour is scaled up to one. */
function worstSixty(byTen) {
  if (hours < 1) {
    const total = [...byTen.values()].reduce((a, b) => a + b, 0);
    return { value: Math.round(total / hours), at: iso(to) };
  }
  const keys = [...byTen.keys()].sort();
  let best = { value: 0, at: '' };
  for (let i = 0; i < keys.length; i++) {
    const start = Date.parse(keys[i]);
    let sum = 0;
    for (let j = i; j < keys.length && Date.parse(keys[j]) < start + 3_600_000; j++) sum += byTen.get(keys[j]);
    if (sum > best.value) best = { value: sum, at: new Date(start + 3_600_000).toISOString().slice(11, 16) };
  }
  return best;
}
const tenMinutes = (e) => {
  const ts = under(e, 'timestamp') ?? under(e, 'eventTimestamp');
  const d = new Date(typeof ts === 'number' ? ts : Number(ts) || ts);
  return Number.isNaN(d.getTime()) ? iso(from) : d.toISOString().slice(0, 15) + '0:00Z';
};
const sorted = (m) => [...m.entries()].sort((a, b) => b[1] - a[1]);

/**
 * What the zone stopped before the Worker, when the zone token may read analytics. The two datasets are asked
 * apart: a dataset the zone's plan does not hold answers "does not have access to the path", a token without
 * Zone: Analytics: Read answers "does not have permission", and the one that answers is still shown.
 */
async function edge(since, until) {
  if (!zoneToken) return { note: 'CLOUDFLARE_ZONE_TOKEN is not set, so what the zone stopped before the Worker is not shown.' };
  let zone;
  try {
    const z = await cf('/zones?name=ulehla.dev', undefined, zoneToken);
    zone = z.result?.[0]?.id;
    if (!zone) return { note: 'The zone token does not see ulehla.dev.' };
  } catch (e) {
    return { note: `The zone token cannot list the zones (${String(e.message).slice(0, 160)}).` };
  }
  const vars = { zone, from: iso(since), to: iso(until) };
  const ask = (field) => gql(`query($zone: string!, $from: Time!, $to: Time!) { viewer { zones(filter: {zoneTag: $zone}) { ${field} } } }`, vars, zoneToken).then((d) => d.viewer.zones[0] ?? {});
  const filter = `filter: {datetime_geq: $from, datetime_lt: $to, clientRequestHTTPHost: "${HOST}"}`;
  // The Free zone plan holds the grouped request counts and the single firewall events, not the grouped firewall
  // events (2026-11-05), so the events are grouped here when the grouped dataset answers "does not have access".
  const grouped = (events) => {
    const by = new Map();
    for (const e of events) {
      const key = [e.action, e.clientASNDescription, e.clientRequestPath, e.userAgent].join('\u0000');
      const g = by.get(key) ?? by.set(key, { count: 0, dimensions: { action: e.action, clientASNDescription: e.clientASNDescription, clientRequestPath: e.clientRequestPath, userAgent: e.userAgent } }).get(key);
      g.count += 1;
    }
    return { stopped: [...by.values()].sort((a, b) => b.count - a.count).slice(0, 40) };
  };
  const [all, stopped] = await Promise.allSettled([
    ask(`all: httpRequestsAdaptiveGroups(limit: 1, ${filter}) { count }`),
    ask(`stopped: firewallEventsAdaptiveGroups(limit: 40, ${filter}, orderBy: [count_DESC]) { count dimensions { action clientASNDescription clientRequestPath userAgent } }`).catch((e) =>
      /does not have access/.test(e.message)
        ? ask(`stopped: firewallEventsAdaptive(limit: 5000, ${filter}) { action clientASNDescription clientRequestPath userAgent }`).then((v) => grouped(v.stopped ?? []))
        : Promise.reject(e)
    )
  ]);
  const why = (r) => String(r.reason?.message ?? r.reason).slice(0, 200);
  const notes = [];
  if (all.status === 'rejected') notes.push(`The zone's request count is not readable with the zone token (httpRequestsAdaptiveGroups: ${why(all)}).`);
  if (stopped.status === 'rejected') notes.push(`What the zone stopped is not readable with the zone token (firewallEventsAdaptiveGroups: ${why(stopped)}).`);
  return {
    total: all.status === 'fulfilled' ? (all.value.all?.[0]?.count ?? 0) : undefined,
    stopped: stopped.status === 'fulfilled' ? (stopped.value.stopped ?? []) : undefined,
    note: notes.length ? notes.join(' ') : undefined
  };
}

const lines = [];
const say = (s = '') => {
  lines.push(s);
  console.log(s);
};

const midnight = new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate()));
// The analytics group by the hour and keep only the requests inside the window, so an hour the window starts in
// would come back as a part. The worst-hour search starts at the whole hour, so the hour the window starts in is
// judged whole; the window's own totals keep the exact window.
const wholeHour = new Date(Math.floor(from.getTime() / 3_600_000) * 3_600_000);
const [windowHours, peakHours, dayHours, d1, logs, zone, queries] = await Promise.all([
  workerHours(from, to),
  workerHours(wholeHour, to),
  workerHours(midnight, to),
  d1Hours(midnight.toISOString().slice(0, 10)),
  events(from, to).catch((e) => ({ events: [], truncated: false, error: e.message })),
  edge(from, to),
  d1TopQueries(from, to).catch((e) => ({ error: e.message }))
]);

const sum = (map, key) => [...map.values()].reduce((a, h) => a + h[key], 0);
// D1's analytics come by the hour: the window takes every hour it touches, whole, and its rate is per hour touched.
const inWindow = (hour) => Date.parse(hour) >= from.getTime() - (from.getTime() % 3_600_000) && Date.parse(hour) < to.getTime();
const d1Window = new Map([...d1].filter(([h]) => inWindow(h)));
const d1PerHour = (n) => Math.round(n / Math.max(hours, d1Window.size, 1));
const requests = sum(windowHours, 'requests');
const rowsRead = sum(d1Window, 'rowsRead');

say(`# The edge, ${iso(from)} to ${iso(to)} (${hours % 1 ? hours.toFixed(1) : hours} h)`);
say();
say('| | in the window | per hour | since 00:00 UTC |');
say('|---|---:|---:|---:|');
say(`| Worker requests | ${fmt(requests)} | ${fmt(perHour(requests))} | ${fmt(sum(dayHours, 'requests'))} |`);
say(`| Worker errors | ${fmt(sum(windowHours, 'errors'))} | ${fmt(perHour(sum(windowHours, 'errors')))} | ${fmt(sum(dayHours, 'errors'))} |`);
say(`| D1 rows read | ${fmt(rowsRead)} | ${fmt(d1PerHour(rowsRead))} | ${fmt(sum(d1, 'rowsRead'))} |`);
say(`| D1 rows written | ${fmt(sum(d1Window, 'rowsWritten'))} | ${fmt(d1PerHour(sum(d1Window, 'rowsWritten')))} | ${fmt(sum(d1, 'rowsWritten'))} |`);
if (zone.total !== undefined) {
  say(`| Requests at the edge | ${fmt(zone.total)} | ${fmt(perHour(zone.total))} | |`);
}
if (zone.stopped !== undefined) {
  const stopped = zone.stopped.reduce((a, r) => a + r.count, 0);
  say(`| Stopped by the zone's rules | ${fmt(stopped)} | ${fmt(perHour(stopped))} | |`);
}
say();

const byNetwork = new Map();
const byNetworkUnnamed = new Map();
const byNetworkLists = new Map();
const tenByNetwork = new Map(); // network -> ten-minute bucket -> count
const tenByNetworkUnnamed = new Map();
const tenByNetworkLists = new Map();
const tenOf = (m, k) => m.get(k) ?? m.set(k, new Map()).get(k);
const byAgent = new Map();
const byShape = new Map();
const byStatus = new Map();
const byNetShape = new Map();
/** CPU milliseconds per URL shape: the Workers Free plan stops a Worker that keeps going over 10 ms a request (error 1102). */
const FREE_CPU_MS = 10;
const cpuByShape = new Map();
const cpuAll = [];
/** One line per request for a closer look at the CPU (WATCH_EVENTS_FILE): shape, status and times, no address, agent string or query value. */
const compact = [];
const serverPath = (url) => {
  try {
    const p = new URL(url).pathname;
    return /^\/(s|badge)\//.test(p) ? p : undefined;
  } catch {
    return undefined;
  }
};
for (const e of logs.events) {
  const request = under(e, 'request') ?? {};
  const url = typeof request.url === 'string' ? request.url : under(e, 'url');
  if (typeof url !== 'string') continue;
  const agent = (under(request, 'user-agent') ?? under(e, 'user-agent') ?? '').toString().replace(/\s+/g, ' ');
  const asn = under(request, 'asn') ?? under(e, 'asn');
  // The organisation and the number: the number is what a rule in rules.mjs takes.
  const network = `${(under(request, 'asOrganization') ?? under(e, 'asOrganization') ?? '-').toString()}${asn ? ` (AS${asn})` : ''}`;
  const response = under(e, 'response');
  const status = response && typeof response === 'object' ? (response.status ?? '-') : '-';
  const s = shape(url);
  const k = kind(agent);
  const ten = tenMinutes(e);
  bump(byNetwork, network);
  bump(tenOf(tenByNetwork, network), ten);
  if (k !== 'named crawler') {
    bump(byNetworkUnnamed, network);
    bump(tenOf(tenByNetworkUnnamed, network), ten);
  }
  if (/^\/servers\?|^\/api\/servers/.test(s)) {
    bump(byNetworkLists, network);
    bump(tenOf(tenByNetworkLists, network), ten);
  }
  // A crawler behind a browser's agent string names itself at the end; show both ends.
  bump(byAgent, `${k}: ${agent.length > 100 ? `${agent.slice(0, 48)} … ${agent.slice(-48)}` : agent || '-'}`);
  bump(byShape, s);
  const cpu = Number(under(e, 'cpuTimeMs'));
  if (Number.isFinite(cpu)) {
    cpuAll.push(cpu);
    (cpuByShape.get(s) ?? cpuByShape.set(s, []).get(s)).push(cpu);
  }
  if (process.env.WATCH_EVENTS_FILE) {
    const wall = Number(under(e, 'wallTimeMs'));
    compact.push({ t: under(e, 'timestamp') ?? null, shape: s, path: serverPath(url), status, cpu: Number.isFinite(cpu) ? cpu : null, wall: Number.isFinite(wall) ? wall : null, colo: under(e, 'colo') ?? null, kind: k, outcome: under(e, 'outcome') ?? null });
  }
  bump(byStatus, String(status));
  bump(byNetShape, `${network.slice(0, 30)} · ${k} · ${s.replace(/\?.*$/, '?…')} · ${status}`);
}

const table = (title, map, head, n = 12) => {
  const rows = sorted(map).slice(0, n);
  if (!rows.length) return;
  say(`## ${title}`);
  say();
  say(`| ${head} | requests | per hour |`);
  say('|---|---:|---:|');
  for (const [k, v] of rows) say(`| ${k.replace(/\|/g, '\\|')} | ${fmt(v)} | ${fmt(perHour(v))} |`);
  say();
};
if (logs.error) say(`The Worker's logs could not be read: ${logs.error}`);
else {
  say(`## What the Worker's logs say (${fmt(logs.events.length)} events${logs.truncated ? ', a busy ten minutes was cut at 2 000, so the counts below are low' : ''})`);
  say();
  table('By network', byNetwork, 'network (AS organisation, number)');
  table('By agent', byAgent, 'kind: agent');
  table('By URL shape', byShape, 'shape', 15);
  table('By response status', byStatus, 'status', 8);
  table('Network × agent kind × shape × status', byNetShape, 'who, what, how', 20);
}
const quantile = (xs, q) => {
  if (!xs.length) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
};
if (cpuAll.length) {
  const over = cpuAll.filter((c) => c > FREE_CPU_MS).length;
  say(`## CPU time per request`);
  say();
  say(`${fmt(over)} of ${fmt(cpuAll.length)} requests (${Math.round((over / cpuAll.length) * 100)} %) took more than ${FREE_CPU_MS} ms of CPU, the Workers Free plan's limit. Median ${quantile(cpuAll, 0.5)} ms, 90th percentile ${quantile(cpuAll, 0.9)} ms. The shapes that cost the most CPU in all:`);
  say();
  say(`| shape | requests | median ms | p90 ms | max ms | over ${FREE_CPU_MS} ms |`);
  say('|---|---:|---:|---:|---:|---:|');
  const rowsCpu = [...cpuByShape.entries()].map(([shape, xs]) => ({ shape, xs, total: xs.reduce((a, b) => a + b, 0) })).sort((a, b) => b.total - a.total).slice(0, 12);
  for (const r of rowsCpu) {
    const o = r.xs.filter((c) => c > FREE_CPU_MS).length;
    say(`| ${r.shape.replace(/\|/g, '\\|')} | ${fmt(r.xs.length)} | ${quantile(r.xs, 0.5)} | ${quantile(r.xs, 0.9)} | ${Math.max(...r.xs)} | ${Math.round((o / r.xs.length) * 100)} % |`);
  }
  say();
}
if (queries.error) say(`The D1 query analytics could not be read: ${queries.error}`);
else if (queries.length) {
  say('## D1 queries by rows read, the hours of the window');
  say();
  say('| rows read | times | rows each | query |');
  say('|---:|---:|---:|---|');
  for (const q of queries) say(`| ${fmt(q.sum.rowsRead)} | ${fmt(q.count)} | ${fmt(q.avg.rowsRead)} | ${q.dimensions.query.replace(/\s+/g, ' ').replace(/\|/g, '\\|').slice(0, 150)} |`);
  say();
}
if (zone.note) say(zone.note);
if (zone.stopped?.length) {
  say('## Stopped before the Worker');
  say();
  say('| action | network | path | agent | requests |');
  say('|---|---|---|---|---:|');
  for (const r of zone.stopped.slice(0, 20)) {
    const d = r.dimensions;
    say(`| ${d.action} | ${d.clientASNDescription} | ${d.clientRequestPath.replace(/^\/s\/.+/, '/s/*').slice(0, 40)} | ${d.userAgent.replace(/\|/g, ' ').slice(0, 60)} | ${fmt(r.count)} |`);
  }
  say();
}

// The thresholds are per hour, and a window can be many hours: what counts is the worst hour in it, not the average.
const alarms = [];
const peakRequests = worstHour(peakHours, 'requests');
const peakRows = worstHour(d1Window, 'rowsRead');
say('## The worst hour');
say();
say('| | most in an hour | when (UTC) |');
say('|---|---:|---|');
say(`| Worker requests | ${fmt(peakRequests.value)} | ${peakRequests.hour.slice(11, 16) || '-'} |`);
say(`| D1 rows read | ${fmt(peakRows.value)} | ${peakRows.hour.slice(11, 16) || '-'} |`);
for (const [network] of sorted(byNetwork).slice(0, 3)) {
  const w = worstSixty(tenByNetwork.get(network));
  say(`| ${network}, everything | ${fmt(w.value)} | to ${w.at} |`);
}
for (const [network] of sorted(byNetworkUnnamed).slice(0, 3)) {
  const w = worstSixty(tenByNetworkUnnamed.get(network));
  say(`| ${network}, agents that do not name a crawler | ${fmt(w.value)} | to ${w.at} |`);
}
for (const [network] of sorted(byNetworkLists).slice(0, 3)) {
  const w = worstSixty(tenByNetworkLists.get(network));
  say(`| ${network}, list variants | ${fmt(w.value)} | to ${w.at} |`);
}
say();
if (peakRequests.value > LIMITS.requests) alarms.push(`${fmt(peakRequests.value)} Worker requests in the hour from ${peakRequests.hour.slice(11, 16)} UTC, the threshold is ${fmt(LIMITS.requests)}`);
for (const [network] of sorted(byNetworkUnnamed)) {
  const w = worstSixty(tenByNetworkUnnamed.get(network));
  if (w.value > LIMITS.network) alarms.push(`${fmt(w.value)} requests in the hour to ${w.at} UTC from ${network} with agents that do not name a crawler, the threshold is ${fmt(LIMITS.network)}`);
}
for (const [network] of sorted(byNetworkLists)) {
  const w = worstSixty(tenByNetworkLists.get(network));
  if (w.value > LIMITS.lists) alarms.push(`${fmt(w.value)} list variants in the hour to ${w.at} UTC from ${network}; robots.txt disallows them for everyone, the threshold is ${fmt(LIMITS.lists)}`);
}
if (peakRows.value > LIMITS.rowsRead) alarms.push(`${fmt(peakRows.value)} D1 rows read in the hour from ${peakRows.hour.slice(11, 16)} UTC, the threshold is ${fmt(LIMITS.rowsRead)}`);

if (alarms.length) {
  say('## Over the threshold');
  say();
  for (const a of alarms) say(`- ${a}`);
  say();
  say('Which networks and agents: the tables above. A hosting network with browser agents walking the list variants is a scraper; add its ASN to SCRAPER_ASNS in site/edge/rules.mjs and the Edge rules workflow blocks it before the Worker. A verified crawler on the list variants is blocked by the zone already; one that still shows here got through, so check the rules.');
  for (const a of alarms) console.log(`::error::${a}`);
} else say('Nothing over the thresholds.');

if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join('\n') + '\n');
if (process.env.WATCH_REPORT_FILE) writeFileSync(process.env.WATCH_REPORT_FILE, lines.join('\n') + '\n');
if (process.env.WATCH_EVENTS_FILE) {
  // The key paths of one event, without values: what else a closer look could ask the logs for.
  const keyPaths = (o, prefix = '') => (o && typeof o === 'object' ? Object.entries(o).flatMap(([k, v]) => (v && typeof v === 'object' && !Array.isArray(v) ? keyPaths(v, `${prefix}${k}.`) : [`${prefix}${k}`])) : []);
  writeFileSync(process.env.WATCH_EVENTS_FILE, JSON.stringify({ from: iso(from), to: iso(to), truncated: logs.truncated, keys: keyPaths(logs.events[0]), events: compact }));
}
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `alarm=${alarms.join('; ').replace(/[\r\n]+/g, ' ')}\n`);
process.exit(alarms.length ? 1 : 0);
