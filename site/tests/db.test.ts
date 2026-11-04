import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { memoryD1, type MemoryD1 } from './d1';
import { countByStatus, latestRun, latestRunWithTrend, listServers, recentChanges, relatedWord, runsBetween, searchWords, serverPage, similarByTitle, sitemapChunkLines } from '../src/lib/db';
import { GATED_STATUSES } from '../../packages/mcpcost/src/types';

/**
 * The queries that moved work from the Worker into D1 (json_remove, json_extract, group_concat): their answers
 * must be what the Worker made before from the whole rows. The database is the site's schema in memory.
 */
let db: MemoryD1;
beforeEach(() => {
  db = memoryD1();
  (env as unknown as { DB: D1Database }).DB = db.d1;
});

/** A run summary with the three long lists, a float and the largest safe integer, as the probe writes them. */
function summary(day: string, ok: number, exact: boolean, withChanges = true) {
  return {
    probedAt: `${day}T08:48:42.716Z`,
    probed: 46_137,
    ok,
    byStatus: { ok, auth: 9_041, dns: 842 },
    toolsTokens: { median: 1_211, p90: 6_904.5, p99: 20_000, max: 431_925, total: 9_007_199_254_740_991 },
    ...(exact ? { claudeTokens: { model: 'claude-opus-5-5', counted: 15_455, refused: 3, median: 2_286, p90: 13_046, p99: 34_083, max: 529_755, total: 1, ratioToEstimate: { median: 1.8571428571428572, p10: 1.2, p90: 2.5 } } } : {}),
    topHosts: [{ host: 'a.example', servers: 3, ok: 2, gated: 1, dead: 0, uniqueToolsets: 2, medianTokens: 1500 }],
    heaviest: [{ name: 'io.github.heavy/one', claudeTokens: 431_925, toolsTokens: 200_000 }],
    ...(withChanges ? { changes: { since: '2026-10-20', added: ['io.github.new/one'], removed: [], wentDown: [], cameBack: [], tokenChanges: [{ name: 'x', before: 1, after: 2, exact: true }], counts: { added: 1, removed: 0, wentDown: 0, cameBack: 0, tokenChanges: 1 } } } : {})
  };
}

function insertRuns(...runs: Array<ReturnType<typeof summary>>) {
  const insert = db.sql.prepare('INSERT INTO runs (probed_at, summary) VALUES (?, ?)');
  for (const r of runs) insert.run(r.probedAt, JSON.stringify(r));
}

/** A run without some of its keys, as the page used to get it after JSON.parse of the whole summary. */
function without<T extends object>(run: T, ...keys: string[]): Partial<T> {
  return Object.fromEntries(Object.entries(run).filter(([k]) => !keys.includes(k))) as Partial<T>;
}

describe('run summaries read with lists left in D1', () => {
  const runs = [summary('2026-10-22', 25_000, false, false), summary('2026-10-23', 25_400, true), summary('2026-10-24', 25_509, true)];
  beforeEach(() => insertRuns(...runs));

  it('latestRun leaves out the lists named and keeps every other value exactly', async () => {
    expect(await latestRun(['topHosts', 'changes', 'heaviest'])).toEqual(without(runs[2], 'topHosts', 'changes', 'heaviest'));
    expect(await latestRun()).toEqual(runs[2]);
  });

  it('runsBetween reads a half-open range, oldest first, without the lists named', async () => {
    expect(await runsBetween('2026-10', '2026-10-24', ['changes'])).toEqual([without(runs[0], 'changes'), without(runs[1], 'changes')]);
    expect(await runsBetween('2026-11', '2026-12')).toEqual([]);
  });

  it('recentChanges gives each run its changes and nothing else, newest first', async () => {
    expect(await recentChanges(3)).toEqual([
      { probedAt: runs[2].probedAt, changes: runs[2].changes },
      { probedAt: runs[1].probedAt, changes: runs[1].changes },
      { probedAt: runs[0].probedAt, changes: undefined }
    ]);
  });

  it('latestRunWithTrend gives the latest run and the earlier runs as chart points, in one batch', async () => {
    const { run, earlier } = await latestRunWithTrend(['changes'], 29);
    expect(run).toEqual(without(runs[2], 'changes'));
    expect(earlier).toEqual([
      { probedAt: runs[1].probedAt, ok: runs[1].ok, probed: runs[1].probed, claudeTokens: { median: 2_286 }, toolsTokens: { median: 1_211 } },
      { probedAt: runs[0].probedAt, ok: runs[0].ok, probed: runs[0].probed, claudeTokens: undefined, toolsTokens: { median: 1_211 } }
    ]);
    expect((await latestRunWithTrend(['changes'], 1)).earlier).toHaveLength(1);
  });
});

describe('an empty runs table', () => {
  it('gives no run and no trend', async () => {
    expect(await latestRun()).toBeNull();
    expect(await latestRunWithTrend(['changes'], 29)).toEqual({ run: null, earlier: [] });
  });
});

describe('sitemap lines made by D1', () => {
  const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const base = 'https://mcpcost.ulehla.dev';
  // rowid = position + 1. The servers that never got an answer stay out; one that is down now but answered once stays in.
  const servers = [
    { name: 'io.github.a/one', status: 'ok', probed_at: '2026-10-24T08:01:00.000Z', answeredOnce: false },
    { name: 'com.x/a&b<c>"d"', status: 'auth', probed_at: '2026-10-23T08:02:00.000Z', answeredOnce: false },
    { name: 'io.github.down/never', status: 'timeout', probed_at: '2026-10-24T08:03:00.000Z', answeredOnce: false },
    { name: 'io.github.down/once', status: 'dns', probed_at: '2026-10-22T08:04:00.000Z', answeredOnce: true },
    { name: 'npm:pkg-needs-env', status: 'needs_env', probed_at: '2026-10-21T08:05:00.000Z', answeredOnce: false }
  ];
  const answered = (s: (typeof servers)[number]) => s.status === 'ok' || GATED_STATUSES.has(s.status) || s.answeredOnce;
  /** The lines as the route built them in the Worker before: one per server row, the whole URL escaped. */
  const before = (from: number, to: number) =>
    servers
      .map((s, i) => ({ ...s, rowid: i + 1 }))
      .filter((s) => s.rowid >= from && s.rowid < to && answered(s))
      .map((s) => `  <url><loc>${escape(`${base}/s/${s.name}`)}</loc><lastmod>${s.probed_at.slice(0, 10)}</lastmod></url>`)
      .join('\n');

  beforeEach(() => {
    const server = db.sql.prepare("INSERT INTO servers (name, url, host, transport, probed_at, status) VALUES (?, 'https://x.example/mcp', 'x.example', 'streamable-http', ?, ?)");
    const probe = db.sql.prepare('INSERT INTO probes (name, probed_at, status) VALUES (?, ?, ?)');
    for (const s of servers) {
      server.run(s.name, s.probed_at, s.status);
      probe.run(s.name, '2026-10-03T00:00:00.000Z', s.answeredOnce ? 'ok' : s.status);
    }
  });

  it('are the lines the Worker made, byte for byte, escaped and in rowid order', async () => {
    const lines = await sitemapChunkLines(0, 5_000, escape(`${base}/s/`));
    expect(lines).toBe(before(0, 5_000));
    expect(lines.split('\n')).toHaveLength(4);
    expect(lines).toContain('com.x/a&amp;b&lt;c&gt;&quot;d&quot;');
  });

  it('keep to their rowid range, and an empty chunk is an empty string', async () => {
    expect(await sitemapChunkLines(0, 2, escape(`${base}/s/`))).toBe(before(0, 2));
    expect(await sitemapChunkLines(1, 2, escape(`${base}/s/`))).toBe(before(2, 4));
    expect(await sitemapChunkLines(9, 2, escape(`${base}/s/`))).toBe('');
  });
});

describe('down and no answer in the list', () => {
  // Down: down_since is set (the probe sets it after two days of failed probes). No answer: failing, down_since null.
  const servers = [
    { name: 'a/alive', status: 'ok', failing_since: null, down_since: null },
    { name: 'b/down', status: 'timeout', failing_since: '2026-10-23T09:00:00.000Z', down_since: '2026-10-23T09:00:00.000Z' },
    { name: 'c/first-failure', status: 'timeout', failing_since: '2026-10-25T08:10:00.000Z', down_since: null },
    { name: 'd/no-date', status: 'dns', failing_since: null, down_since: null },
    { name: 'e/template', status: 'needs_url', failing_since: null, down_since: null }
  ];
  beforeEach(() => {
    // probed_at is the time of the last change in D1, as for b/down here: the list must not read it as the probe time.
    const insert = db.sql.prepare("INSERT INTO servers (name, url, host, transport, probed_at, status, failing_since, down_since) VALUES (?, 'https://x.example/mcp', 'x.example', 'streamable-http', ?, ?, ?, ?)");
    for (const s of servers) insert.run(s.name, s.failing_since ?? '2026-10-25T08:30:00.000Z', s.status, s.failing_since, s.down_since);
  });
  const names = async (status: string) => (await listServers({ status, run: null, sort: 'name' })).rows.map((r) => r.name).sort();

  it('lists the confirmed down servers under down, and the others that fail under noanswer', async () => {
    expect(await names('down')).toEqual(['b/down']);
    expect(await names('noanswer')).toEqual(['c/first-failure', 'd/no-date']);
  });

  it('takes a group and a cause', async () => {
    expect(await names('down:timeout')).toEqual(['b/down']);
    expect(await names('noanswer:timeout')).toEqual(['c/first-failure']);
    expect(await names('noanswer:dns')).toEqual(['d/no-date']);
    // A bare cause, as older links have it, lists both.
    expect(await names('timeout')).toEqual(['b/down', 'c/first-failure']);
  });

  it('counts the no-answer rows of each failing status, and none of a status that answers or is gated', async () => {
    const { counts } = await countByStatus({ sort: 'name' });
    expect(counts.timeout).toMatchObject({ n: 2, na: 1 });
    expect(counts.dns).toMatchObject({ n: 1, na: 1 });
    expect(counts.ok).toMatchObject({ n: 1, na: 0 });
    expect(counts.needs_url).toMatchObject({ n: 1, na: 0 });
  });
});

describe('the server page in one round trip', () => {
  beforeEach(() => {
    insertRuns(summary('2026-10-24', 25_509, true));
    const server = db.sql.prepare("INSERT INTO servers (name, url, host, transport, probed_at, status, toolset_hash) VALUES (?, 'https://x.example/mcp', 'x.example', 'streamable-http', '2026-10-25T08:30:00.000Z', ?, ?)");
    server.run('a/one', 'ok', 'h1');
    server.run('b/twin', 'ok', 'h1');
    server.run('c/alone', 'timeout', null);
    const probe = db.sql.prepare('INSERT INTO probes (name, probed_at, status) VALUES (?, ?, ?)');
    probe.run('a/one', '2026-10-24T08:00:00.000Z', 'ok');
    probe.run('a/one', '2026-10-25T08:00:00.000Z', 'ok');
    probe.run('c/alone', '2026-10-25T08:00:00.000Z', 'timeout');
  });

  it('gives the row, the history newest first, the siblings by tool set and the run without its lists', async () => {
    const page = await serverPage('a/one');
    expect(page.server?.name).toBe('a/one');
    expect(page.history.map((h) => h.probed_at)).toEqual(['2026-10-25T08:00:00.000Z', '2026-10-24T08:00:00.000Z']);
    expect(page.siblings.map((s) => s.name)).toEqual(['b/twin']);
    expect(page.everAnswered).toBe(true);
    expect(page.run && 'topHosts' in page.run).toBe(false);
  });

  it('has no siblings without a tool set, knows a server that never answered, and gives null for an unknown name', async () => {
    const page = await serverPage('c/alone');
    expect(page.siblings).toEqual([]);
    expect(page.everAnswered).toBe(false);
    expect((await serverPage('nobody/here')).server).toBeNull();
  });

  it('links the neighbours on the same host, in name order, from both sides of the name', async () => {
    const page = await serverPage('b/twin');
    expect(page.onHost.map((s) => s.name)).toEqual(['a/one', 'c/alone']);
    expect(page.onHost[0]).toEqual({ name: 'a/one', title: null, host: 'x.example', status: 'ok' });
    expect((await serverPage('c/alone')).onHost.map((s) => s.name)).toEqual(['a/one', 'b/twin']);
  });

  it('links the servers that mention a word of the name, itself and the host neighbours left out', async () => {
    const server = db.sql.prepare("INSERT INTO servers (name, title, description, url, host, transport, probed_at, status) VALUES (?, ?, ?, 'https://y.example/mcp', ?, 'streamable-http', '2026-10-25T08:30:00.000Z', 'ok')");
    server.run('d/transcript-tools', null, null, 'd.example');
    server.run('e/notes', 'Transcripts for meetings', null, 'e.example');
    server.run('f/other', 'Other', 'Reads a transcript of a call', 'd.example');
    server.run('g/mcp', 'Nothing here', null, 'g.example');
    const page = await serverPage('d/transcript-tools');
    expect(page.word).toBe('transcript');
    expect(page.onHost.map((s) => s.name)).toEqual(['f/other']);
    expect(page.similar.map((s) => s.name)).toEqual(['e/notes']);
    // A name with no telling word searches nothing.
    expect((await serverPage('g/mcp')).word).toBe(null);
    expect((await serverPage('g/mcp')).similar).toEqual([]);
  });

  it('looks again by the words of the title, up to two, and leaves out the servers already linked', async () => {
    const server = db.sql.prepare("INSERT INTO servers (name, title, url, host, transport, probed_at, status) VALUES (?, ?, 'https://y.example/mcp', ?, 'streamable-http', '2026-10-25T08:30:00.000Z', 'ok')");
    server.run('e/notes', 'Transcripts for meetings', 'e.example');
    server.run('h/calendar', 'Meetings and calendars', 'h.example');
    const { similar, words } = await similarByTitle('Transcripts of meetings', null, 'e/notes', new Set(['h/calendar']));
    expect(words).toEqual(['transcripts', 'meetings']);
    expect(similar).toEqual([]);
    expect((await similarByTitle('Transcripts of meetings', null, 'x/none', new Set())).similar.map((s) => s.name).sort()).toEqual(['e/notes', 'h/calendar']);
    // A word tried before is skipped; a title without words gives way to the description.
    expect((await similarByTitle('Transcripts of meetings', null, 'x/none', new Set(), ['transcripts'])).words).toEqual(['meetings']);
    expect((await similarByTitle('SAP', 'Meetings and calendars for SAP', 'x/none', new Set())).words).toEqual(['calendars', 'meetings']);
    expect(await similarByTitle(null, null, 'x/none', new Set())).toEqual({ similar: [], words: [] });
  });
});

describe('the word a related-servers search runs on', () => {
  it('is the longest telling word of the last name segment, else of the publisher', () => {
    expect(relatedWord('io.github.zachshallbetter/adobe-mcp-illustrator')).toBe('illustrator');
    expect(relatedWord('io.github.arcmira/arcmira')).toBe('arcmira');
    expect(relatedWord('com.replynodes/mcp')).toBe('replynodes');
    expect(relatedWord('io.github.theluckystrike/timer-tracking')).toBe('tracking');
    expect(relatedWord('url/https://x.y/mcp')).toBe(null);
    expect(relatedWord('io.github.foo/mcp-server')).toBe(null);
  });

  it('keeps the words of four letters or more that are not empty, longest first', () => {
    expect(searchWords('The GitHub MCP server for your repos')).toEqual(['repos']);
    expect(searchWords('Transcripts: YouTube & meetings')).toEqual(['transcripts', 'meetings', 'youtube']);
    expect(searchWords(null)).toEqual([]);
  });
});
