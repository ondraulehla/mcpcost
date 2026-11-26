/**
 * Prototype: probes npm-packaged (stdio) servers from the registry, each in its
 * own container. Install with the network on, run with it off. Usage:
 *   node --import tsx probe/stdio-run.ts --sample 200 --concurrency 4 --out data/raw/stdio-run.json
 * Needs the image: docker build -t mcpcost-stdio probe/stdio
 */
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { promisify } from 'node:util';
import type { RegistryEntry, RegistryPackage, ProbeResult } from '../packages/mcpcost/src/index.js';
import { priceTools } from '../packages/mcpcost/src/probe.js';
import { probeStdioRaw } from '../packages/mcpcost/src/stdio.js';
import type { RawTool } from '../packages/mcpcost/src/core.js';
import { envNamesFromError } from '../packages/mcpcost/src/env-hints.js';
import { classify, fallbackEnvs, placeholderEnv, sdkPin, type StdioStatus } from './stdio-classify.js';
import { shardOf } from './shard.js';

const run = promisify(execFile);
const { values: args } = parseArgs({
  options: {
    /** Probe only this many of the selected targets; empty means all. */
    sample: { type: 'string', default: '' },
    /** The package kinds to probe: npm, pypi, oci, mcpb, comma-separated. */
    kind: { type: 'string', default: 'npm,pypi' },
    /** Only the shard of names whose hash falls on this day of a 7-day cycle (0-6); empty means all. */
    shard: { type: 'string', default: '' },
    /** Split the (sharded) list into this many parts and take one: "3/20". */
    part: { type: 'string', default: '' },
    /** A file with one registry name per line; overrides sample. */
    names: { type: 'string', default: '' },
    /** The cache of probe/derive-packages.ts: packages of remote servers that need auth. Probed every run, split by --part. */
    derived: { type: 'string', default: '' },
    concurrency: { type: 'string', default: '4' },
    seed: { type: 'string', default: '7' },
    image: { type: 'string', default: 'mcpcost-stdio' },
    registry: { type: 'string', default: 'data/raw/registry-latest.json' },
    out: { type: 'string', default: 'data/raw/stdio-run.json' },
    'install-timeout': { type: 'string', default: '180000' },
    'probe-timeout': { type: 'string', default: '45000' }
  }
});

interface Target { name: string; pkg: RegistryPackage; updatedAt: string; derivedFor?: string }
type Kind = 'npm' | 'pypi' | 'oci' | 'mcpb';
/** The package an entry is probed by when it lists several kinds: npm and PyPI first, then an MCPB bundle, then an OCI image. */
const KIND_ORDER: Kind[] = ['npm', 'pypi', 'mcpb', 'oci'];
interface Row {
  name: string;
  /** The remote server this package stands in for: the row is its tool set, not a server of its own. */
  derivedFor?: string;
  kind: Kind;
  identifier: string;
  version?: string;
  command?: string[];
  env?: string[];
  status: StdioStatus;
  installMs?: number;
  result?: ProbeResult;
  tools?: RawTool[];
  error?: string;
}

function mulberry32(seed: number) {
  return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

async function loadTargets(): Promise<Target[]> {
  const raw = JSON.parse(await readFile(args.registry, 'utf8')) as Array<{ server: RegistryEntry['server']; _meta: Record<string, RegistryEntry['meta']> }>;
  const kinds = new Set(args.kind.split(','));
  let all: Target[] = [];
  for (const r of raw) {
    if (r.server.remotes?.length) continue;
    const pkg = (r.server.packages ?? [])
      .filter((p) => kinds.has(p.registryType) && (p.transport?.type ?? 'stdio') === 'stdio')
      .sort((a, b) => KIND_ORDER.indexOf(a.registryType as Kind) - KIND_ORDER.indexOf(b.registryType as Kind))[0];
    if (!pkg) continue;
    all.push({ name: r.server.name, pkg, updatedAt: r._meta['io.modelcontextprotocol.registry/official']?.updatedAt ?? '' });
  }
  if (args.names) {
    const want = new Set((await readFile(args.names, 'utf8')).split('\n').map((l) => l.trim()).filter(Boolean));
    return all.filter((t) => want.has(t.name));
  }
  if (args.shard !== '') {
    // A package published or updated in the last 36 hours is probed today, whatever its day of the cycle: a new server
    // is on the board the day after it appears, not up to a week later, and a new version is checked at once.
    const day = Number(args.shard);
    const since = Date.now() - FRESH_HOURS * 3_600_000;
    const fresh = all.filter((t) => shardOf(t.name) !== day && t.updatedAt && Date.parse(t.updatedAt) >= since).slice(0, FRESH_MAX);
    all = [...all.filter((t) => shardOf(t.name) === day), ...fresh];
    if (fresh.length) console.error(`${fresh.length} packages published or updated in the last ${FRESH_HOURS} hours are added to today's shard`);
  }
  all.sort((a, b) => a.name.localeCompare(b.name));
  // Packages derived for gated remote servers: a few hundred, probed every run, so no shard.
  let derived: Target[] = [];
  if (args.derived && existsSync(args.derived)) {
    const cache = JSON.parse(await readFile(args.derived, 'utf8')) as { derived?: Record<string, { registry: Kind; name: string }> };
    derived = Object.entries(cache.derived ?? {})
      .filter(([, d]) => kinds.has(d.registry))
      .map(([forName, d]) => ({ name: forName, derivedFor: forName, pkg: { registryType: d.registry, identifier: d.name }, updatedAt: '' }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }
  if (args.part) {
    const [k, n] = args.part.split('/').map(Number);
    all = all.filter((_, i) => i % n === k);
    derived = derived.filter((_, i) => i % n === k);
    const list = [...all, ...derived];
    return args.sample ? list.slice(0, Number(args.sample)) : list;
  }
  const rand = mulberry32(Number(args.seed));
  for (let i = all.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [all[i], all[j]] = [all[j], all[i]]; }
  const list = args.sample ? all.slice(0, Number(args.sample)) : all;
  return [...list, ...derived];
}

/** Packages published or updated within this many hours join today's shard; at most FRESH_MAX of them a day. */
const FRESH_HOURS = 36;
const FRESH_MAX = 1500;

export { shardOf } from './shard.js';

/** Command-line arguments from the registry entry: fixed values and defaults; a required one without a value stops the probe. */
function buildArgs(pkg: RegistryPackage): { args: string[]; missing: string[] } {
  const out: string[] = [];
  const missing: string[] = [];
  for (const a of [...(pkg.runtimeArguments ?? []), ...(pkg.packageArguments ?? [])]) {
    const value = a.value ?? a.default;
    if (a.type === 'flag') { if (a.name) out.push(a.name); continue; }
    if (a.type === 'named') {
      if (value != null && a.name) out.push(a.name, value);
      else if (a.isRequired) missing.push(a.name ?? '?');
      continue;
    }
    if (value != null) out.push(value);
    else if (a.isRequired) missing.push(a.valueHint ?? a.name ?? 'positional');
  }
  return { args: out, missing };
}

function dockerArgs(extra: string[]): string[] {
  return ['run', '--rm', '--memory', '512m', '--cpus', '1', '--pids-limit', '256', '--security-opt', 'no-new-privileges', ...extra];
}

async function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let t: NodeJS.Timeout;
  return Promise.race([p, new Promise<T>((_, rej) => { t = setTimeout(() => rej(new Error(`${what} timed out after ${ms} ms`)), ms); })]).finally(() => clearTimeout(t));
}

/**
 * Runs a command and kills it when it takes longer than ms. A promise that loses a race does not stop its process, and
 * a process left behind keeps this script alive: on 2026-10-28 five parts of the run waited five hours, after their last
 * package, on an unzip and on docker clients whose time was up.
 */
async function runFor(cmd: string, argv: string[], ms: number, what: string, opts: { maxBuffer?: number } = {}) {
  try {
    return await run(cmd, argv, { ...opts, timeout: ms, killSignal: 'SIGKILL' });
  } catch (e) {
    if ((e as { killed?: boolean }).killed) throw Object.assign(new Error(`${what} timed out after ${ms} ms`), { stderr: (e as { stderr?: string }).stderr });
    throw e;
  }
}

/** A container with the limits of every probe container, killed when it takes longer than ms, and removed then too. */
async function dockerRun(extra: string[], ms: number, what: string, opts: { maxBuffer?: number } = {}) {
  const name = `mcpcost-${randomUUID().slice(0, 8)}`;
  try {
    return await runFor('docker', dockerArgs(['--name', name, ...extra]), ms, what, opts);
  } catch (e) {
    // A killed client leaves its container running: remove it, so it holds no memory for the rest of the run.
    await runFor('docker', ['rm', '-f', name], 30_000, 'docker rm').catch(() => undefined);
    throw e;
  }
}

/**
 * Installs the package into the work directory with the network on. Returns the command that starts it. A pin such as
 * mcp<2 goes into the PyPI install as --with, the same as uvx --with 'mcp<2' for a user.
 */
async function install(t: Target, dir: string, pins: string[] = []): Promise<{ command: string[] } | { status: StdioStatus; error: string }> {
  const kind = t.pkg.registryType as Kind;
  const id = t.pkg.identifier;
  if (kind === 'npm') {
    const spec = t.pkg.version ? `${id}@${t.pkg.version}` : id;
    try {
      await dockerRun(['-v', `${dir}:/work`, '-w', '/work', args.image, 'npm', 'install', '--ignore-scripts', '--no-audit', '--no-fund', '--prefix', '/work', '--loglevel', 'error', spec], Number(args['install-timeout']), 'install', { maxBuffer: 4e6 });
    } catch (e) {
      const msg = String((e as { stderr?: string }).stderr ?? e);
      return { status: /E404|404 Not Found|ETARGET|No matching version|notarget/.test(msg) ? 'not_found' : 'install_failed', error: msg.trim().split('\n').slice(-3).join(' ').slice(0, 300) };
    }
    let pkgJson: { bin?: string | Record<string, string> };
    try { pkgJson = JSON.parse(await readFile(join(dir, 'node_modules', id, 'package.json'), 'utf8')); } catch { return { status: 'install_failed', error: 'package.json missing after install' }; }
    const bins = typeof pkgJson.bin === 'string' ? { [id.split('/').pop()!]: pkgJson.bin } : (pkgJson.bin ?? {});
    const binName = Object.keys(bins).find((b) => b === id.split('/').pop()) ?? Object.keys(bins)[0];
    if (!binName) return { status: 'no_bin', error: 'package declares no bin' };
    return { command: ['node', `/work/node_modules/${id}/${bins[binName]}`] };
  }
  // PyPI: a uv tool install into the work directory; the console script is the command. Python 3.12 first, 3.13 when the package asks for it.
  const spec = t.pkg.version ? `${id}==${t.pkg.version}` : id;
  const uvCache = join(tmpdir(), 'mcpcost-uv-cache');
  let lastError = '';
  for (const py of ['3.12', '3.13']) {
    try {
      await dockerRun(['-v', `${dir}:/work`, '-v', `${uvCache}:/root/.cache/uv`, '-w', '/work', args.image, 'uv', 'tool', 'install', '--quiet', '--python', py, ...pins.flatMap((p) => ['--with', p]), spec], Number(args['install-timeout']), 'install', { maxBuffer: 4e6 });
      lastError = '';
      break;
    } catch (e) {
      lastError = String((e as { stderr?: string }).stderr ?? e);
      if (!/does not satisfy Python|requires-python|Python>=3\.13/i.test(lastError)) break;
    }
  }
  if (lastError) {
    const notFound = /there is no version of|not found in the package registry|was not found in|No matching distribution|Package `[^`]+` was not found/i.test(lastError) && !/does not satisfy Python/i.test(lastError);
    return { status: notFound ? 'not_found' : 'install_failed', error: lastError.trim().split('\n').slice(-3).join(' ').slice(0, 300) };
  }
  const { readdir } = await import('node:fs/promises');
  const bins = (await readdir(join(dir, 'bin')).catch(() => [] as string[])).filter((b) => !b.startsWith('.'));
  const want = id.toLowerCase().replace(/_/g, '-');
  const binName = bins.find((b) => b.toLowerCase().replace(/_/g, '-') === want) ?? bins.find((b) => want.includes(b.toLowerCase().replace(/_/g, '-'))) ?? bins[0];
  if (!binName) return { status: 'no_bin', error: 'package installs no console script' };
  return { command: [`/work/bin/${binName}`] };
}

/**
 * An OCI image: pulled with the network on, then started as `docker run -i` with the network off, no capabilities
 * and the same limits as a package. The probe client runs on this machine and talks to the container over stdin and
 * stdout. Only the package arguments of the entry are passed: its runtime arguments are docker options (mounts, a
 * network, privileges) that the probe does not give a stranger's image.
 */
async function probeOci(t: Target, row: Row): Promise<Row> {
  const image = t.pkg.identifier;
  const { args: cliArgs, missing } = buildArgs({ ...t.pkg, runtimeArguments: [] });
  if (missing.length) { row.status = 'needs_args'; row.error = `requires ${missing.join(', ')}`; return row; }
  const t0 = Date.now();
  try {
    await runFor('docker', ['pull', '--quiet', image], Number(args['install-timeout']), 'pull', { maxBuffer: 4e6 });
  } catch (e) {
    const msg = String((e as { stderr?: string }).stderr ?? e);
    row.status = /not found|manifest unknown|does not exist|repository .* not found|pull access denied|denied|unauthorized/i.test(msg) ? 'not_found' : 'install_failed';
    row.error = msg.trim().split('\n').slice(-2).join(' ').slice(0, 300);
    return row;
  }
  row.installMs = Date.now() - t0;
  const env = placeholderEnv(t.pkg);
  const name = `mcpcost-${randomUUID().slice(0, 8)}`;
  try {
    const probeWith = async (vars: Record<string, string>) => {
      const envArgs = Object.entries(vars).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
      const runArgs = dockerArgs(['-i', '--name', name, '--pull', 'never', '--network', 'none', '--cap-drop', 'ALL', '--tmpfs', '/tmp', ...envArgs, image, ...cliArgs]);
      row.command = ['docker', ...runArgs];
      const { result, tools } = await withTimeout(probeStdioRaw({ command: 'docker', args: runArgs }, { timeoutMs: Number(args['probe-timeout']) }), Number(args['probe-timeout']) + 20_000, 'probe');
      priceTools(result, tools);
      await runFor('docker', ['rm', '-f', name], 30_000, 'docker rm').catch(() => undefined);
      return { parsed: { result, tools }, ...classify(result) };
    };
    let attempt = await probeWith(env);
    if (attempt.status === 'needs_env' || attempt.status === 'crashed') {
      const wanted = envNamesFromError(attempt.text).filter((n) => !(n in env));
      if (wanted.length) {
        for (const n of wanted) env[n] = 'mcpcost-placeholder';
        const again = await probeWith(env);
        if (again.status === 'ok' || again.status !== attempt.status) attempt = again;
      }
    }
    // A placeholder can stop a server that checks its variables at start: once more without the optional ones, then
    // with typed values (fallbackEnvs).
    let used = env;
    if (attempt.status !== 'ok') {
      for (const other of fallbackEnvs(t.pkg, env)) {
        const again = await probeWith(other).catch(() => undefined);
        if (again?.status === 'ok') { attempt = again; used = other; break; }
      }
    }
    row.env = Object.keys(used);
    row.result = attempt.parsed.result;
    row.tools = attempt.parsed.tools;
    row.status = attempt.status;
    if (row.status !== 'ok') row.error = attempt.text.slice(0, 300);
    return row;
  } finally {
    await runFor('docker', ['rm', '-f', name], 30_000, 'docker rm').catch(() => undefined);
    await runFor('docker', ['rmi', '-f', image], 60_000, 'docker rmi').catch(() => undefined);
  }
}

/** The largest MCPB bundle the probe downloads. */
const MCPB_MAX_BYTES = 200_000_000;

/**
 * An MCPB bundle: downloaded with the network on, checked against the SHA-256 that the registry lists, and unpacked
 * into the work directory as bundle/. Its manifest says how to start it (server.mcp_config, with the Linux override);
 * ${__dirname} is the bundle, ${user_config.*} a placeholder or the default, and the rest of the ${...} variables empty.
 */
async function installMcpb(t: Target, dir: string): Promise<{ command: string[]; env: Record<string, string> } | { status: StdioStatus; error: string }> {
  let res: Response;
  try {
    res = await fetch(t.pkg.identifier, { redirect: 'follow', signal: AbortSignal.timeout(Number(args['install-timeout'])) });
  } catch (e) {
    return { status: 'install_failed', error: `download failed: ${String(e).slice(0, 200)}` };
  }
  if (!res.ok) return { status: res.status === 404 || res.status === 410 ? 'not_found' : 'install_failed', error: `download answered HTTP ${res.status}` };
  if (Number(res.headers.get('content-length') ?? 0) > MCPB_MAX_BYTES) return { status: 'install_failed', error: `the bundle is over ${MCPB_MAX_BYTES / 1e6} MB` };
  const file = Buffer.from(await res.arrayBuffer());
  if (file.length > MCPB_MAX_BYTES) return { status: 'install_failed', error: `the bundle is over ${MCPB_MAX_BYTES / 1e6} MB` };
  if (t.pkg.fileSha256 && createHash('sha256').update(file).digest('hex') !== t.pkg.fileSha256.toLowerCase()) return { status: 'install_failed', error: 'the bundle does not match the SHA-256 in the registry entry' };
  await writeFile(join(dir, 'bundle.mcpb'), file);
  try {
    // unzip keeps every path inside bundle/: it drops a leading / and refuses ../ parts. -o and an empty -P keep it from
    // asking (about a file it would replace, or for the password of an encrypted bundle), since nobody would answer.
    await runFor('unzip', ['-q', '-o', '-P', '', join(dir, 'bundle.mcpb'), '-d', join(dir, 'bundle')], 120_000, 'unzip', { maxBuffer: 4e6 });
  } catch (e) {
    return { status: 'install_failed', error: `not a zip file: ${String((e as { stderr?: string }).stderr ?? e).trim().slice(0, 200)}` };
  }
  type Config = { command?: string; args?: string[]; env?: Record<string, string> };
  let manifest: { server?: { type?: string; entry_point?: string; mcp_config?: Config & { platform_overrides?: Record<string, Config> } }; user_config?: Record<string, { default?: unknown }> };
  try { manifest = JSON.parse(await readFile(join(dir, 'bundle', 'manifest.json'), 'utf8')); } catch { return { status: 'install_failed', error: 'the bundle has no manifest.json' }; }
  const base = manifest.server?.mcp_config;
  const config: Config = { ...base, ...(base?.platform_overrides?.linux ?? {}) };
  const fill = (v: string) =>
    v.replace(/\$\{([^}]+)\}/g, (_, key: string) => {
      if (key === '__dirname') return '/work/bundle';
      if (key.startsWith('user_config.')) {
        const d = manifest.user_config?.[key.slice('user_config.'.length)]?.default;
        return d == null ? 'mcpcost-placeholder' : Array.isArray(d) ? d.join(',') : String(d);
      }
      if (key === 'HOME' || key === 'TMPDIR' || key === 'DOCUMENTS' || key === 'DESKTOP' || key === 'DOWNLOADS') return '/tmp';
      return '';
    });
  let command = config.command ? fill(config.command) : '';
  if (!command && manifest.server?.entry_point) command = manifest.server.type === 'python' ? 'python3' : manifest.server.type === 'node' ? 'node' : `/work/bundle/${manifest.server.entry_point}`;
  if (!command) return { status: 'no_bin', error: 'the manifest says no command and no entry point' };
  if (command === 'python') command = 'python3';
  const cmdArgs = (config.args ?? (config.command ? [] : manifest.server?.entry_point && (manifest.server.type === 'python' || manifest.server.type === 'node') ? [`/work/bundle/${manifest.server.entry_point}`] : [])).map(fill);
  const env = Object.fromEntries(Object.entries(config.env ?? {}).map(([k, v]) => [k, fill(String(v))]));
  return { command: [command, ...cmdArgs], env };
}

async function probeOne(t: Target): Promise<Row> {
  const row: Row = { name: t.name, derivedFor: t.derivedFor, kind: t.pkg.registryType as Kind, identifier: t.pkg.identifier, version: t.pkg.version, status: 'error' };
  if (row.kind === 'oci') {
    try {
      return await probeOci(t, row);
    } catch (e) {
      row.status = /timed out/.test(String(e)) ? 'timeout' : 'error';
      row.error = String((e as { stderr?: string }).stderr ?? e).slice(-300);
      return row;
    }
  }
  const dir = await mkdtemp(join(tmpdir(), 'mcpcost-stdio-'));
  let pinnedDir: string | undefined;
  try {
    const { args: cliArgs, missing } = row.kind === 'mcpb' ? { args: [] as string[], missing: [] as string[] } : buildArgs(t.pkg);
    if (missing.length) { row.status = 'needs_args'; row.error = `requires ${missing.join(', ')}`; return row; }
    const t0 = Date.now();
    const installed = row.kind === 'mcpb' ? await installMcpb(t, dir) : await install(t, dir);
    if ('status' in installed) { row.status = installed.status; row.error = installed.error; return row; }
    row.installMs = Date.now() - t0;
    const command = [...installed.command, ...cliArgs];
    row.command = command;
    const bundleEnv: Record<string, string> = 'env' in installed ? (installed as { env: Record<string, string> }).env : {};
    const env = { ...placeholderEnv(t.pkg), ...bundleEnv };
    // 3. run with the network off, read-only install, then list the tools
    const probeWith = async (vars: Record<string, string>, workDir = dir, cmd = command) => {
      const envArgs = Object.entries(vars).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
      const { stdout } = await dockerRun(
        ['--network', 'none', '-v', `${workDir}:/work:ro`, '--tmpfs', '/tmp', '-e', `PROBE_TIMEOUT_MS=${args['probe-timeout']}`, ...envArgs, args.image, 'node', '/app/probe.mjs', ...cmd],
        Number(args['probe-timeout']) + 20_000, 'probe', { maxBuffer: 64e6 }
      );
      const parsed = JSON.parse(stdout.slice(stdout.indexOf('{'))) as { result: ProbeResult; tools: RawTool[] };
      priceTools(parsed.result, parsed.tools);
      return { parsed, ...classify(parsed.result) };
    };
    let attempt = await probeWith(env);
    // The server said which variables it wants (a derived package has no registry entry to list them): once more with those set.
    if (attempt.status === 'needs_env' || attempt.status === 'crashed') {
      const wanted = envNamesFromError(attempt.text).filter((n) => !(n in env));
      if (wanted.length) {
        for (const n of wanted) env[n] = 'mcpcost-placeholder';
        const again = await probeWith(env);
        if (again.status === 'ok' || again.status !== attempt.status) attempt = again;
      }
    }
    // A placeholder can stop a server that checks its variables at start (a URL, a number, a JSON text): once more
    // without the variables that the entry does not require, then with typed values in the ones that stay. A value
    // from the bundle's own manifest stays as it is.
    let used = env;
    const others = fallbackEnvs(t.pkg, env, bundleEnv);
    /** The first of the other environments with which the server lists its tools. */
    const firstOk = async (workDir?: string, cmd?: string[]) => {
      for (const other of others) {
        const again = await probeWith(other, workDir, cmd).catch(() => undefined);
        if (again?.status === 'ok') return { again, other };
      }
      return undefined;
    };
    if (attempt.status !== 'ok') {
      const hit = await firstOk();
      if (hit) { attempt = hit.again; used = hit.other; }
    }
    // It stopped at the import of FastMCP from mcp 2.x: once more with mcp<2, in a fresh directory. When it lists its tools
    // then, the row says so (needs_old_sdk) with those tools and the error of the plain install. Anything else, and the
    // plain install's crash stands.
    const pin = sdkPin(row.kind, attempt.status, attempt.text);
    if (pin) {
      try {
        pinnedDir = await mkdtemp(join(tmpdir(), 'mcpcost-stdio-'));
        const pinned = await install(t, pinnedDir, [pin]);
        if (!('status' in pinned)) {
          const pinnedCommand = [...pinned.command, ...cliArgs];
          let again = await probeWith(env, pinnedDir, pinnedCommand);
          if (again.status !== 'ok') {
            const hit = await firstOk(pinnedDir, pinnedCommand);
            if (hit) { again = hit.again; used = hit.other; }
          }
          if (again.status === 'ok') attempt = { ...again, status: 'needs_old_sdk', text: attempt.text };
        }
      } catch {
        // The second run timed out or gave no answer: the crash of the plain install stands.
      }
    }
    row.env = Object.keys(used);
    row.result = attempt.parsed.result;
    row.tools = attempt.parsed.tools;
    row.status = attempt.status;
    if (row.status !== 'ok') row.error = attempt.text.slice(0, 300);
    return row;
  } catch (e) {
    row.status = /timed out/.test(String(e)) ? 'timeout' : 'error';
    row.error = String((e as { stderr?: string }).stderr ?? e).slice(-300);
    return row;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    if (pinnedDir) await rm(pinnedDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

const targets = await loadTargets();
console.error(`${targets.length} package targets (${args.kind}), concurrency ${args.concurrency}`);
const rows: Row[] = [];
let i = 0;
const started = Date.now();
await Promise.all(Array.from({ length: Number(args.concurrency) }, async () => {
  while (i < targets.length) {
    const t = targets[i++];
    const r = await probeOne(t);
    rows.push(r);
    console.error(`  ${rows.length}/${targets.length} ${r.status.padEnd(14)} ${r.kind}:${t.pkg.identifier} ${r.result?.toolCount != null ? `${r.result.toolCount} tools ${r.result.toolsTokens} tok` : ''} ${r.installMs ? `(install ${Math.round(r.installMs / 1000)}s)` : ''}`);
  }
}));
const byStatus: Record<string, number> = {};
for (const r of rows) byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
const ok = rows.filter((r) => r.status === 'ok');
const tok = ok.map((r) => r.result!.toolsTokens ?? 0).sort((a, b) => a - b);
const summary = { probed: rows.length, byStatus, ok: ok.length, medianTokens: tok[Math.floor(tok.length / 2)] ?? 0, maxTokens: tok.at(-1) ?? 0, seconds: Math.round((Date.now() - started) / 1000), secondsPerPackage: Math.round((Date.now() - started) / 1000 / Math.max(1, rows.length) * Number(args.concurrency) * 10) / 10 };
await mkdir(args.out.slice(0, args.out.lastIndexOf('/')), { recursive: true });
await writeFile(args.out, JSON.stringify({ probedAt: new Date().toISOString(), summary, rows }, null, 1));
console.log(JSON.stringify(summary, null, 2));
// The results are written. A process that a package left behind must not hold the job until its time limit.
process.exit(0);
