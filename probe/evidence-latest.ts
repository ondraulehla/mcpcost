/**
 * Puts the re-check evidence of the newest run at one stable path of the site, with a small index next to it. Usage:
 *   node --import tsx probe/evidence-latest.ts --in evidence.json.gz --out site/public/data [--run <GitHub run id>]
 * Writes:
 *   <out>/mcpcost-evidence-latest.json.gz     the file as probe/dataset.ts wrote it
 *   <out>/mcpcost-evidence-latest.index.json  the run date, the entries per state and per check, the size, the SHA-256, the shape
 * deploy.yml runs it before each build, so every version of the site has both files and git has neither.
 * A file that is not whole (gzip, JSON, the dataset name, the shape of modelcontextprotocol/registry#1715, one valid
 * row per entry, at least --min-entries rows) is refused with exit code 1 before anything is written.
 */
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { gunzipSync } from 'node:zlib';

/** The name of both files under /data. */
export const LATEST = 'mcpcost-evidence-latest';
const SITE = 'https://mcpcost.ulehla.dev';
const REPOSITORY = 'https://github.com/ondraulehla/mcpcost';
const STATES = ['alive', 'auth', 'transient', 'dead', 'unknown'];
const CHECKS = ['endpoint', 'package'];

export interface EvidenceIndex {
  dataset: 'mcpcost-evidence';
  shape: string;
  url: string;
  /** The day of the run (ISO date). */
  run: string;
  probed_at: string;
  entries: number;
  states: Record<string, number>;
  checks: Record<string, number>;
  /** The size of the gzip file. */
  bytes: number;
  sha256: string;
  license: string;
  updates: string;
  /** The GitHub Actions run of the probe that wrote the file, when it is known. */
  run_id?: number;
  run_url?: string;
}

interface Doc {
  dataset?: unknown;
  shape?: unknown;
  probed_at?: unknown;
  entries?: unknown;
  license?: unknown;
  rows?: unknown;
}

interface Row {
  entry?: unknown;
  checked_at?: unknown;
  check?: unknown;
  state?: unknown;
  evidence?: { status?: unknown } | null;
}

const isTime = (v: unknown): v is string => typeof v === 'string' && !Number.isNaN(Date.parse(v));

/** Checks one evidence file and gives its index. Throws when the file is not whole. */
export function indexOf(gz: Buffer, opts: { minEntries?: number; maxBytes?: number; runId?: number } = {}): EvidenceIndex {
  const { minEntries = 1000, maxBytes = 10e6, runId } = opts;
  if (gz.length > maxBytes) throw new Error(`the file is ${(gz.length / 1e6).toFixed(1)} MB, over the ${maxBytes / 1e6} MB limit for a static file`);
  let doc: Doc;
  try {
    doc = JSON.parse(gunzipSync(gz).toString('utf8')) as Doc;
  } catch (e) {
    throw new Error(`not a gzip of a JSON document: ${(e as Error).message}`);
  }
  if (doc?.dataset !== 'mcpcost-evidence') throw new Error(`the dataset is ${JSON.stringify(doc?.dataset)}, not "mcpcost-evidence"`);
  if (typeof doc.shape !== 'string' || !doc.shape.startsWith('modelcontextprotocol/registry#1715')) throw new Error('the shape is not the one of modelcontextprotocol/registry#1715');
  if (!isTime(doc.probed_at)) throw new Error(`probed_at ${JSON.stringify(doc.probed_at)} is not a time`);
  if (!Array.isArray(doc.rows) || doc.rows.length !== doc.entries) throw new Error(`the document says ${JSON.stringify(doc.entries)} entries and has ${Array.isArray(doc.rows) ? doc.rows.length : 'no'} rows`);
  if (doc.rows.length < minEntries) throw new Error(`${doc.rows.length} entries, fewer than ${minEntries}: not a whole run`);
  const states: Record<string, number> = Object.fromEntries(STATES.map((s) => [s, 0]));
  const checks: Record<string, number> = Object.fromEntries(CHECKS.map((c) => [c, 0]));
  const seen = new Set<string>();
  for (const r of doc.rows as Row[]) {
    const whole = typeof r?.entry === 'string' && r.entry !== '' && isTime(r.checked_at) && typeof r.check === 'string' && CHECKS.includes(r.check) && typeof r.state === 'string' && STATES.includes(r.state) && typeof r.evidence?.status === 'string';
    if (!whole) throw new Error(`a row is not in the shape: ${JSON.stringify(r).slice(0, 200)}`);
    if (seen.has(r.entry as string)) throw new Error(`the entry ${r.entry as string} has two rows`);
    seen.add(r.entry as string);
    states[r.state as string]++;
    checks[r.check as string]++;
  }
  return {
    dataset: 'mcpcost-evidence',
    shape: doc.shape,
    url: `${SITE}/data/${LATEST}.json.gz`,
    run: doc.probed_at.slice(0, 10),
    probed_at: doc.probed_at,
    entries: doc.rows.length,
    states,
    checks,
    bytes: gz.length,
    sha256: createHash('sha256').update(gz).digest('hex'),
    license: typeof doc.license === 'string' ? doc.license : 'CC BY 4.0',
    updates: 'after each successful daily probe run; the monthly copies stay at /data/mcpcost-evidence-YYYY-MM.json.gz',
    ...(runId ? { run_id: runId, run_url: `${REPOSITORY}/actions/runs/${runId}` } : {})
  };
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const { values: args } = parseArgs({
    options: {
      in: { type: 'string' },
      out: { type: 'string', default: 'site/public/data' },
      run: { type: 'string' },
      'min-entries': { type: 'string', default: '1000' },
      /** The largest gzip, in MB, that goes out as a static file of the site, as in probe/dataset.ts. */
      'max-mb': { type: 'string', default: '10' }
    }
  });
  if (!args.in) {
    console.error('usage: node --import tsx probe/evidence-latest.ts --in evidence.json.gz [--out site/public/data] [--run <GitHub run id>]');
    process.exit(2);
  }
  const gz = await readFile(args.in);
  let index: EvidenceIndex;
  try {
    index = indexOf(gz, { minEntries: Number(args['min-entries']), maxBytes: Number(args['max-mb']) * 1e6, runId: args.run ? Number(args.run) : undefined });
  } catch (e) {
    console.error(`::warning::${args.in} is not published: ${(e as Error).message}`);
    process.exit(1);
  }
  await mkdir(args.out, { recursive: true });
  await writeFile(`${args.out}/${LATEST}.json.gz`, gz);
  await writeFile(`${args.out}/${LATEST}.index.json`, `${JSON.stringify(index, null, 2)}\n`);
  const states = Object.entries(index.states).map(([k, v]) => `${k} ${v}`).join(', ');
  console.error(`published the run of ${index.run} (${index.entries} entries: ${states}), ${(index.bytes / 1e6).toFixed(2)} MB, as ${args.out}/${LATEST}.json.gz`);
}
