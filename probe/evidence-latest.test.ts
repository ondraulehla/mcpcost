import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { gzipSync } from 'node:zlib';
import { indexOf } from './evidence-latest.js';

const SHAPE = 'modelcontextprotocol/registry#1715: entry, checked_at, check (endpoint | package), state (alive | auth | transient | dead | unknown), evidence';

function row(i: number, state = 'alive', check = 'endpoint') {
  return { entry: `io.example/server-${i}`, checked_at: '2026-10-25T08:31:02.000Z', check, state, evidence: { status: state === 'alive' ? 'ok' : 'timeout', target: `https://example.io/${i}/mcp` } };
}

function file(rows: unknown[], over: Record<string, unknown> = {}): Buffer {
  return gzipSync(Buffer.from(JSON.stringify({ dataset: 'mcpcost-evidence', shape: SHAPE, probed_at: '2026-10-25T08:30:00.000Z', entries: rows.length, license: 'CC BY 4.0', rows, ...over })));
}

const rows = [row(0), row(1, 'auth'), row(2, 'transient'), row(3, 'dead', 'package'), row(4, 'unknown', 'package')];

test('a whole file gives its index', () => {
  const gz = file(rows);
  const index = indexOf(gz, { minEntries: 5, runId: 40176662650 });
  assert.equal(index.run, '2026-10-25');
  assert.equal(index.entries, 5);
  assert.deepEqual(index.states, { alive: 1, auth: 1, transient: 1, dead: 1, unknown: 1 });
  assert.deepEqual(index.checks, { endpoint: 3, package: 2 });
  assert.equal(index.bytes, gz.length);
  assert.equal(index.sha256, createHash('sha256').update(gz).digest('hex'));
  assert.equal(index.shape, SHAPE);
  assert.equal(index.url, 'https://mcpcost.ulehla.dev/data/mcpcost-evidence-latest.json.gz');
  assert.equal(index.run_url, 'https://github.com/ondraulehla/mcpcost/actions/runs/40176662650');
});

test('without a run id the index has no run link', () => {
  const index = indexOf(file(rows), { minEntries: 5 });
  assert.equal(index.run_id, undefined);
  assert.equal(index.run_url, undefined);
});

test('a file that is not whole is refused', () => {
  const refused: Array<[string, Buffer, RegExp]> = [
    ['not gzip', Buffer.from('{"dataset":"mcpcost-evidence"}'), /not a gzip/],
    ['an HTML page', gzipSync(Buffer.from('<!doctype html><title>404</title>')), /not a gzip of a JSON/],
    ['half a file', file(rows).subarray(0, 60), /not a gzip/],
    ['another dataset', file(rows, { dataset: 'mcpcost' }), /dataset/],
    ['another shape', file(rows, { shape: 'entry, state' }), /shape/],
    ['no time', file(rows, { probed_at: 'yesterday' }), /probed_at/],
    ['fewer rows than entries', file(rows, { entries: 6 }), /6 entries and has 5 rows/],
    ['no rows', file(rows, { rows: undefined }), /no rows/],
    ['a state outside the five', file([...rows.slice(1), row(0, 'down')]), /not in the shape/],
    ['a check outside the two', file([...rows.slice(1), row(0, 'alive', 'repository')]), /not in the shape/],
    ['a row without evidence', file([...rows.slice(1), { ...row(0), evidence: null }]), /not in the shape/],
    ['a row without a check time', file([...rows.slice(1), { ...row(0), checked_at: '' }]), /not in the shape/],
    ['an entry twice', file([...rows, row(0)]), /two rows/]
  ];
  for (const [what, gz, message] of refused) assert.throws(() => indexOf(gz, { minEntries: 5 }), message, what);
});

test('a run with too few entries is refused', () => {
  assert.throws(() => indexOf(file(rows)), /5 entries, fewer than 1000/);
});

test('a file over the size limit is refused', () => {
  assert.throws(() => indexOf(file(rows), { minEntries: 5, maxBytes: 100 }), /over the/);
});

const monthly = new URL('../site/public/data/mcpcost-evidence-2026-10.json.gz', import.meta.url);
test('the published October file passes', { skip: !existsSync(monthly) }, () => {
  const index = indexOf(readFileSync(monthly));
  assert.equal(index.run, '2026-10-24');
  assert.equal(index.entries, 46137);
  assert.equal(Object.values(index.states).reduce((a, b) => a + b, 0), index.entries);
});
