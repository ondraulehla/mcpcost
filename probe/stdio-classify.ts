/**
 * What a failed start of a package server means, from the error text of the stdio client (the transport's message,
 * then stderrSummary: the exception line, the first error of Node, the last lines). The exception line decides: a
 * module that is not there or a syntax error is a broken package (crashed); a key, a token or a variable that is not
 * set is a package that wants setup (needs_env), even when Python prints it as a traceback. No side effects, so the
 * tests can import it; probe/stdio-run.ts uses it for npm, PyPI, OCI and MCPB alike.
 */
import type { ProbeResult, RegistryPackage } from '../packages/mcpcost/src/index.js';

/** A variable of a registry entry, with the keys of the registry's schema that the package's own type leaves out. */
type EnvVar = NonNullable<RegistryPackage['environmentVariables']>[number] & { value?: string; choices?: string[]; format?: string; placeholder?: string };
type Listed = { environmentVariables?: EnvVar[] };

const PLAIN = 'mcpcost-placeholder';
/** A value the entry fixes for every user, such as TRANSPORT=stdio. One with a {variable} in it is not a value yet. */
const fixedValue = (v: EnvVar): string | undefined => (v.value != null && !String(v.value).includes('{') ? String(v.value) : undefined);

/**
 * The environment of the first start: the value the entry fixes, else its default, else a placeholder, for every
 * variable the entry lists. Most servers read a variable only when a tool runs, so they start and list their tools.
 */
export function placeholderEnv(pkg: Listed): Record<string, string> {
  const env: Record<string, string> = {};
  for (const v of pkg.environmentVariables ?? []) env[v.name] = fixedValue(v) ?? v.default ?? (v.isSecret ? `${PLAIN}-secret` : PLAIN);
  return env;
}

/**
 * The listed variables that the entry does not require and gives no value or default for. A client leaves them
 * unset. A placeholder in one of them can stop a server that checks the value at start: a URL, a number, a JSON text
 * or one of a set of names. The maintainer of io.github.alexar76/histor reported it on 2026-11-26: with
 * HISTOR_MCP_REMOTE set to the placeholder the launcher printed its usage and the board said "needs args".
 */
export function optionalEnvNames(pkg: Listed): string[] {
  return (pkg.environmentVariables ?? []).filter((v) => !v.isRequired && v.default == null && fixedValue(v) == null).map((v) => v.name);
}

/** An environment without the named variables. */
export function withoutNames(env: Record<string, string>, names: string[]): Record<string, string> {
  return Object.fromEntries(Object.entries(env).filter(([name]) => !names.includes(name)));
}

const URL_IN_TEXT = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'`)>,\]]+/i;
/** "default https://api.example.com", "Defaults to 993", "Default: true". */
const NAMED_DEFAULT = /\bdefaults?(?:\s+(?:is|to|value(?:\s+is)?))?\s*[:=]?\s*["'`]?([^\s"'`),;]+)/i;
const URL_NAME = /(URL|URI|ENDPOINT|API_BASE|ORIGIN)$/i;
const PATH_NAME = /_(PATH|DIR|FILE|ROOT|HOME|FOLDER|DIRECTORY)$/i;
const NUMBER = /^-?\d+(\.\d+)?$/;
const BOOLEAN = /^(true|false)$/i;
const trimmed = (text: string) => text.replace(/[.,;:]+$/, '');
/** A URL that a parser takes, with no <host> or {tenant} left in it. */
const usableUrl = (text: string | undefined): string | undefined => (text && !/[<>{}]/.test(text) && URL.canParse(text) ? text : undefined);

/**
 * A value of the kind a variable expects, for a server that checks its variables at start and stops on plain text.
 * In order: the value the entry fixes, its default, its first choice, the publisher's own example (the registry's
 * "placeholder" key), then what the format, the description and the name say: a number, true or false, a default
 * that the description names, a URL, a path. The last resort is the plain placeholder. The container has no network
 * at start, so a URL here is never called.
 */
export function typedValue(v: EnvVar): string {
  const fixed = fixedValue(v) ?? v.default ?? v.choices?.[0];
  if (fixed != null) return String(fixed);
  if (v.placeholder && !/\s/.test(v.placeholder)) return v.placeholder;
  const text = v.description ?? '';
  const named = trimmed(NAMED_DEFAULT.exec(text)?.[1] ?? '');
  if (v.format === 'number') return NUMBER.test(named) ? named : '1';
  if (v.format === 'boolean') return BOOLEAN.test(named) ? named.toLowerCase() : 'false';
  if (NUMBER.test(named) || BOOLEAN.test(named)) return named;
  const namedUrl = usableUrl(named);
  if (namedUrl) return namedUrl;
  if (URL_NAME.test(v.name)) return usableUrl(trimmed(URL_IN_TEXT.exec(text)?.[0] ?? '')) ?? `https://${PLAIN}.invalid`;
  if (v.format === 'filepath' || PATH_NAME.test(v.name)) return `/tmp/${PLAIN}`;
  return v.isSecret ? `${PLAIN}-secret` : PLAIN;
}

/**
 * The environments for the starts after a failed first one, in order, each tried until one lists the tools:
 * 1. without the optional variables, as a client that sets only what the entry requires,
 * 2. the same, with a typed value in each variable that stays (typedValue).
 * env is the environment of the first start with what the server asked for by name; keep holds values that no start
 * changes (the manifest of an MCPB bundle). An environment that was tried already is left out.
 */
export function fallbackEnvs(pkg: Listed, env: Record<string, string>, keep: Record<string, string> = {}): Array<Record<string, string>> {
  const optional = optionalEnvNames(pkg).filter((n) => !(n in keep));
  const lean = withoutNames(env, optional);
  const typed = { ...lean };
  for (const v of pkg.environmentVariables ?? []) if (v.name in lean && !(v.name in keep)) typed[v.name] = typedValue(v);
  const key = (e: Record<string, string>) => JSON.stringify(Object.entries(e).sort(([a], [b]) => a.localeCompare(b)));
  const seen = new Set([key(env)]);
  return [lean, typed].filter((e) => !seen.has(key(e)) && seen.add(key(e)));
}

export type StdioStatus = ProbeResult['status'] | 'install_failed' | 'no_bin' | 'needs_env' | 'needs_args' | 'needs_network' | 'needs_old_sdk' | 'crashed';

/**
 * mcp 2.0 (PyPI, 2026-07-28) renamed FastMCP to MCPServer: an import of mcp.server.fastmcp fails with a message that
 * says to move to MCPServer or to pin mcp<2. A package that asks for mcp with no upper bound gets 2.x from a plain
 * install, the same as anyone who runs it with uvx.
 */
export const FASTMCP_MOVED = /No module named '?mcp\.server\.fastmcp'?/;

/** The pin to install a crashed package with once more: mcp<2 for a PyPI package that stopped at the import of FastMCP. */
export function sdkPin(kind: string, status: StdioStatus, text: string): string | undefined {
  return kind === 'pypi' && status === 'crashed' && FASTMCP_MOVED.test(text) ? 'mcp<2' : undefined;
}

/** The line that names the exception: Python's last traceback line, or Node's first error line. */
const KEY_LINE = /^(?:Uncaught )?(?:[A-Za-z_][\w.]*(?:Error|Exception|Exit)\b|(?:[A-Z]\w*)?Error(?: \[[A-Z0-9_]+\])?:)/;
/** The server reached for the network on start. With the network off that is not a defect; a bridge to a remote server is one. */
const NETWORK = /mcp-remote|ENOTFOUND|EAI_AGAIN|getaddrinfo|ECONNREFUSED|fetch failed|ConnectError|ConnectionError|ConnectTimeout|Name or service not known|Temporary failure in name resolution|Network is unreachable|StreamableHTTPClientTransport|SSEClientTransport|urlopen error/i;
/** The package itself is broken: a module, a file of its own or a name that is not there, or a syntax error. */
const BROKEN = /ModuleNotFoundError|ImportError|No module named|Cannot find module|ERR_MODULE_NOT_FOUND|ERR_PACKAGE_PATH_NOT_EXPORTED|ERR_REQUIRE_ESM|SyntaxError|is not a function|is not defined|is not a constructor/;
/** The server wants a value from the user: a key, a token, a variable, a config file. */
const SETUP = /api[_ -]?key|\btokens?\b|credential|\bsecrets?\b|password|unauthori[sz]ed|environment variable|env var|must be set|must be provided|\bnot set\b|is required|are required|missing required|not configured|please set|placeholder|invalid (?:url|key|token)|\.env\b/i;
/** A name such as OPENAI_API_KEY in a KeyError or a message, or "set X_Y" for any variable name. */
const SETUP_NAME = /KeyError: ['"]?[A-Z][A-Z0-9_]{2,}['"]?|\b[A-Z][A-Z0-9]*_(?:KEY|TOKEN|SECRET|URL|URI|HOST|ID|PASSWORD|USER|ENDPOINT|DSN|PATH|DIR)\b|\b[Ss]et (?:the )?[A-Z][A-Z0-9]*_[A-Z0-9_]+\b/;
/** The server printed its usage: it wants arguments the entry does not list. */
const USAGE = /^usage:|\busage:|unknown command|missing argument|expected a command|too few arguments|unrecognized arguments/im;
/** A binary for another system, or a command that is not in the image. */
const FOREIGN = /ENOEXEC|exec format error|cannot execute binary file|executable file not found in \$PATH/i;

export function classify(result: Pick<ProbeResult, 'status' | 'error'>): { status: StdioStatus; text: string } {
  const text = `${result.error ?? ''}`;
  if (result.status === 'ok') return { status: 'ok', text };
  // The server answered initialize, with a protocol version this client does not take or a refusal of the one it asked for.
  if (result.status === 'newer_protocol' || result.status === 'unsupported_version') return { status: result.status, text };
  const key = text.split('\n').map((l) => l.trim()).find((l) => KEY_LINE.test(l)) ?? '';
  let status: StdioStatus = result.status;
  if (FOREIGN.test(text)) status = 'no_bin';
  else if (NETWORK.test(text) && !BROKEN.test(key)) status = 'needs_network';
  else if (USAGE.test(text)) status = 'needs_args';
  else if (key && BROKEN.test(key)) status = 'crashed';
  else if (SETUP.test(key) || SETUP_NAME.test(key) || SETUP.test(text)) status = 'needs_env';
  else if (BROKEN.test(text) || /Traceback|Connection closed/.test(text)) status = 'crashed';
  return { status, text };
}
