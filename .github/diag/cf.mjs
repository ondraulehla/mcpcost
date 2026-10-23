// Temporary diagnostics: where the D1 read budget went. Prints aggregates only (no IPs, no query values).
// node cf.mjs <d1-hourly|d1-queries|logs|zone|tail> [from] [to] [file]
import { readFileSync } from 'node:fs';

const token = process.env.CLOUDFLARE_API_TOKEN;
const acct = process.env.CLOUDFLARE_ACCOUNT_ID;
const db = process.env.DB_ID;
const API = 'https://api.cloudflare.com/client/v4';
const [mode, from, to, file] = process.argv.slice(2);

async function cf(path, body, method = body ? 'POST' : 'GET') {
  const r = await fetch(API + path, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.success === false || j.errors?.length) console.log(`HTTP ${r.status} ${path}: ${JSON.stringify(j.errors ?? j).slice(0, 600)}`);
  return j;
}
const gql = (query, variables) => cf('/graphql', { query, variables });

/** A URL as a class: the path with ids folded, the parameter names, and the values that tell list variants apart. */
function shape(raw) {
  let u;
  try { u = new URL(raw); } catch { return String(raw).slice(0, 60); }
  let p = u.pathname;
  if (p.startsWith('/s/')) p = p.endsWith('.xml') ? '/s/*.xml' : '/s/*';
  else if (p.startsWith('/api/s/')) p = '/api/s/*';
  else if (p.startsWith('/badge/')) p = '/badge/*';
  else if (/^\/sitemap-\d+\.xml$/.test(p)) p = '/sitemap-N.xml';
  const keep = new Set(['status', 'sort', 'transport', 'protocol', 'd']);
  const parts = [...u.searchParams.entries()].map(([k, v]) => {
    if (keep.has(k)) return `${k}=${v.slice(0, 20)}`;
    if (k === 'page' || k === 'p') { const n = Number(v); return `${k}=${!n ? '?' : n <= 20 ? '1-20' : n <= 100 ? '21-100' : n <= 500 ? '101-500' : '>500'}`; }
    return `${k}=…`;
  }).sort();
  return `${u.hostname === 'mcpcost.ulehla.dev' ? '' : u.hostname} ${p}${parts.length ? '?' + parts.join('&') : ''}`.trim();
}
function top(map, n = 25, title = '') {
  const rows = [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
  console.log(`\n== ${title} (${[...map.values()].reduce((a, b) => a + b, 0)} total, ${map.size} distinct)`);
  for (const [k, v] of rows) console.log(`${String(v).padStart(7)}  ${k}`);
}
const bump = (m, k, by = 1) => m.set(k, (m.get(k) ?? 0) + by);
const ua = (s) => (s ?? '-').replace(/\s+/g, ' ').slice(0, 110);

if (mode === 'd1-hourly') {
  const j = await gql(`query($acct: string!, $db: string!, $since: Date!) { viewer { accounts(filter: {accountTag: $acct}) {
    d1AnalyticsAdaptiveGroups(limit: 200, filter: {date_geq: $since, databaseId: $db}, orderBy: [datetimeHour_ASC]) {
      sum { readQueries writeQueries rowsRead rowsWritten } dimensions { datetimeHour } } } } }`, { acct, db, since: from });
  const g = j.data?.viewer?.accounts?.[0]?.d1AnalyticsAdaptiveGroups ?? [];
  console.log('hour (UTC)            rows read   read queries   rows/query   rows written');
  for (const r of g) console.log(`${r.dimensions.datetimeHour}  ${String(r.sum.rowsRead).padStart(10)}  ${String(r.sum.readQueries).padStart(12)}  ${String(Math.round(r.sum.rowsRead / Math.max(1, r.sum.readQueries))).padStart(10)}  ${String(r.sum.rowsWritten).padStart(12)}`);
}

if (mode === 'd1-queries') {
  const j = await gql(`query($acct: string!, $filter: ZoneWorkersRequestsFilter_InputObject) { viewer { accounts(filter: {accountTag: $acct}) {
    d1QueriesAdaptiveGroups(limit: 25, filter: $filter, orderBy: [sum_rowsRead_DESC]) {
      sum { rowsRead rowsWritten queryDurationMs } avg { rowsRead } count dimensions { query } } } } }`,
    { acct, filter: { AND: [{ datetimeHour_geq: from, datetimeHour_leq: to, databaseId: db }] } });
  const g = j.data?.viewer?.accounts?.[0]?.d1QueriesAdaptiveGroups ?? [];
  console.log(`top queries by rows read, ${from} .. ${to}`);
  for (const r of g) console.log(`${String(r.sum.rowsRead).padStart(10)} rows  ${String(r.count).padStart(6)}x  avg ${String(Math.round(r.avg.rowsRead)).padStart(7)}  ${r.dimensions.query.replace(/\s+/g, ' ').slice(0, 260)}`);
}

/** Every string under a key in an event, found wherever the logs put it. */
function find(obj, keyTest, out = []) {
  if (!obj || typeof obj !== 'object') return out;
  for (const [k, v] of Object.entries(obj)) {
    if (keyTest(k) && (typeof v === 'string' || typeof v === 'number')) out.push(String(v));
    else if (v && typeof v === 'object') find(v, keyTest, out);
  }
  return out;
}
function aggregate(events, label) {
  const byShape = new Map(), byUa = new Map(), byUaShape = new Map(), byAsn = new Map(), byStatus = new Map(), byMinute = new Map();
  for (const e of events) {
    const url = find(e, (k) => k === 'url')[0];
    if (!url) continue;
    const agent = find(e, (k) => k.toLowerCase() === 'user-agent' || k === 'userAgent')[0];
    const asn = find(e, (k) => k === 'asOrganization')[0];
    const status = find(e, (k) => k === 'status')[0];
    const ts = find(e, (k) => k === 'timestamp' || k === 'eventTimestamp')[0];
    const s = shape(url);
    const cls = s.replace(/\?.*$/, '?…');
    bump(byShape, s); bump(byUa, ua(agent)); bump(byUaShape, `${ua(agent).slice(0, 60)}  →  ${cls}`); bump(byAsn, asn ?? '-'); bump(byStatus, status ?? '-');
    if (ts) { const d = new Date(Number(ts) || ts); if (!isNaN(d)) bump(byMinute, d.toISOString().slice(0, 15) + '0'); }
  }
  console.log(`\n######## ${label}: ${events.length} events`);
  top(byShape, 40, 'requests by URL shape');
  top(byUa, 25, 'by user agent');
  top(byUaShape, 30, 'user agent → path');
  top(byAsn, 15, 'by network (AS organisation)');
  top(byStatus, 10, 'by response status');
  const byNetCls = new Map();
  const byHour = new Map();
  for (const e of events) {
    const url = find(e, (k) => k === 'url')[0]; if (!url) continue;
    const asn = find(e, (k) => k === 'asOrganization')[0] ?? '-';
    const status = find(e, (k) => k === 'status')[0] ?? '-';
    const agent = ua(find(e, (k) => k.toLowerCase() === 'user-agent' || k === 'userAgent')[0]).slice(0, 40);
    bump(byNetCls, `${asn.slice(0, 28).padEnd(28)} ${String(status).padEnd(4)} ${shape(url).replace(/\?.*$/, '?…').padEnd(30)} ${agent}`);
    const ts = find(e, (k) => k === 'timestamp' || k === 'eventTimestamp')[0];
    if (ts) { const d = new Date(Number(ts) || ts); if (!isNaN(d)) bump(byHour, d.toISOString().slice(0, 13)); }
  }
  top(byNetCls, 40, 'network × status × path × agent');
  console.log('\n== per hour'); for (const [k, v] of [...byHour.entries()].sort()) console.log(`${k}  ${v}`);
  if (byMinute.size) { console.log('\n== per 10 minutes'); for (const [k, v] of [...byMinute.entries()].sort()) console.log(`${k}  ${v}`); }
}

if (mode === 'logs') {
  const keys = await cf(`/accounts/${acct}/workers/observability/telemetry/keys`, { timeframe: { from: Date.parse(from), to: Date.parse(to) }, datasets: ['cloudflare-workers'], limit: 200 });
  const names = (keys.result ?? []).map((k) => k.key ?? k).filter((k) => /url|agent|path|status|asOrg|method/i.test(String(k)));
  console.log('log keys:', names.slice(0, 40).join(', '));
  const events = [];
  // Ten-minute slices, so the event limit of one query does not cut the window short.
  const step = Number(process.env.STEP_MIN ?? 10) * 60_000;
  for (let t = Date.parse(from); t < Date.parse(to); t += step) {
    const j = await cf(`/accounts/${acct}/workers/observability/telemetry/query`, {
      queryId: `d1-diag-${t}`, timeframe: { from: t, to: Math.min(t + step, Date.parse(to)) }, view: 'events', limit: 2000,
      parameters: { datasets: ['cloudflare-workers'], filters: [{ key: '$workers.scriptName', operation: 'eq', type: 'string', value: 'mcpcost' }] }
    });
    const ev = j.result?.events?.events ?? j.result?.events ?? [];
    events.push(...(Array.isArray(ev) ? ev : []));
    process.stdout.write(`${new Date(t).toISOString().slice(11, 16)}:${Array.isArray(ev) ? ev.length : JSON.stringify(j.result ?? {}).slice(0, 200)} `);
  }
  aggregate(events, `Workers Logs ${from} .. ${to}`);
}

if (mode === 'zone') {
  const z = await cf('/zones?name=ulehla.dev');
  const zone = z.result?.[0]?.id;
  if (!zone) { console.log('no zone access'); process.exit(0); }
  const j = await gql(`query($zone: string!, $from: Time!, $to: Time!) { viewer { zones(filter: {zoneTag: $zone}) {
    httpRequestsAdaptiveGroups(limit: 60, filter: {datetime_geq: $from, datetime_lt: $to, clientRequestHTTPHost: "mcpcost.ulehla.dev"}, orderBy: [count_DESC]) {
      count dimensions { clientRequestPath userAgent clientASNDescription edgeResponseStatus } } } } }`, { zone, from, to });
  const g = j.data?.viewer?.zones?.[0]?.httpRequestsAdaptiveGroups ?? [];
  console.log(`zone requests ${from} .. ${to}, top path × agent × network`);
  for (const r of g) console.log(`${String(r.count).padStart(7)}  ${r.dimensions.edgeResponseStatus}  ${r.dimensions.clientRequestPath.replace(/^\/s\/.*/, '/s/*').slice(0, 50).padEnd(50)}  ${ua(r.dimensions.userAgent).slice(0, 70).padEnd(70)}  ${r.dimensions.clientASNDescription}`);
}

if (mode === 'tail') {
  // wrangler tail --format json prints one JSON object per event, pretty-printed: split on top-level braces.
  const text = readFileSync(from, 'utf8');
  const events = [];
  let depth = 0, start = -1, inStr = false, esc = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === '{') { if (depth++ === 0) start = i; }
    else if (c === '}') { if (--depth === 0 && start >= 0) { try { events.push(JSON.parse(text.slice(start, i + 1))); } catch {} start = -1; } }
  }
  aggregate(events, 'live tail');
}
