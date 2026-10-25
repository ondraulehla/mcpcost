/**
 * The version of mcpcost is in five places: the package, VERSION in the CLI, the example output in the
 * package README, the registry entry site/server.json and the lock file. This script sets it in all five,
 * or checks that they agree. The release workflow (.github/workflows/release.yml) runs the check.
 *
 *   node scripts/version.mjs 0.3.5            set 0.3.5 in all five places
 *   node scripts/version.mjs patch            the next patch version (minor: the next minor version)
 *   node scripts/version.mjs --check          exit 1 when the places differ, else print the version
 *   node scripts/version.mjs --check 0.3.5    exit 1 when a place does not hold 0.3.5
 *
 * The package stays below 1.0.0: the tags v1.x.y and v1 belong to the GitHub Action (action.yml).
 */
import { readFileSync, writeFileSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

/** A JSON file: the version at a path of keys. Each of these files is JSON.stringify(data, null, 2) plus a newline. */
const json = (file, keys) => ({
  file,
  get: (text) => keys.reduce((o, k) => o?.[k], JSON.parse(text)),
  set: (text, version) => {
    const data = JSON.parse(text);
    keys.slice(0, -1).reduce((o, k) => o[k], data)[keys.at(-1)] = version;
    return JSON.stringify(data, null, 2) + '\n';
  }
});
/** A line of text: the second group of the pattern is the version. */
const line = (file, re) => ({
  file,
  get: (text) => text.match(re)?.[2],
  set: (text, version) => text.replace(re, `$1${version}$3`)
});

const PLACES = [
  json('packages/mcpcost/package.json', ['version']),
  line('packages/mcpcost/src/core.ts', /^(export const VERSION = ')([^']*)(';)$/m),
  line('packages/mcpcost/README.md', /^(mcpcost )(\S+)( · )/m),
  json('site/server.json', ['version']),
  json('package-lock.json', ['packages', 'packages/mcpcost', 'version'])
];

const fail = (message) => {
  console.error(message);
  process.exit(1);
};
const list = (places) => places.map((p) => `  ${(p.version ?? 'not found').padEnd(10)} ${p.file}`).join('\n');
const parts = (v) => v?.match(SEMVER)?.slice(1).map(Number);

const places = PLACES.map((p) => {
  const text = readFileSync(new URL(p.file, root), 'utf8');
  return { ...p, text, version: p.get(text) };
});
const current = places[0].version;
const agree = places.every((p) => p.version === current);
const [arg, want] = process.argv.slice(2);

if (!arg || arg === '--help' || arg === '-h') {
  console.log('Usage: node scripts/version.mjs <x.y.z | patch | minor>\n       node scripts/version.mjs --check [x.y.z]');
} else if (arg === '--check') {
  const expected = want?.replace(/^v/, '') ?? current;
  if (!places.every((p) => p.version === expected)) fail(`${want ? `Every place must hold ${expected}.` : 'The places do not agree on the version.'}\n${list(places)}`);
  if (!parts(expected)) fail(`${expected} is not a release version x.y.z.`);
  console.log(expected);
} else {
  const now = agree ? parts(current) : undefined;
  if ((arg === 'patch' || arg === 'minor') && !now) fail(`${arg} needs one version x.y.z in all places. Give the version instead.\n${list(places)}`);
  const next = arg === 'patch' ? `${now[0]}.${now[1]}.${now[2] + 1}` : arg === 'minor' ? `${now[0]}.${now[1] + 1}.0` : arg.replace(/^v/, '');
  const to = parts(next);
  if (!to) fail(`${arg} is not a version x.y.z, patch or minor.`);
  if (to[0] !== 0) fail(`${next}: the tags v1.x.y belong to the GitHub Action, so a package version from 1.0.0 needs a tag scheme of its own first.`);
  if (now && (to[0] - now[0] || to[1] - now[1] || to[2] - now[2]) <= 0) fail(`${next} is not above the current version ${current}.`);
  const missing = places.filter((p) => p.version === undefined);
  if (missing.length) fail(`No version found in:\n${list(missing)}`);
  // All five new texts first, so a place that does not take the version leaves every file as it was.
  const written = places.map((p) => ({ ...p, text: p.set(p.text, next) }));
  const wrong = written.filter((p) => p.get(p.text) !== next).map((p) => ({ ...p, version: p.get(p.text) }));
  if (wrong.length) fail(`The version could not be set in:\n${list(wrong)}`);
  for (const p of written) writeFileSync(new URL(p.file, root), p.text);
  console.log(`${agree ? current : 'mixed versions'} -> ${next}\n${list(written.map((p) => ({ ...p, version: next })))}`);
  console.log(`\nNext: commit and push main, then git tag v${next} && git push origin v${next}`);
}
