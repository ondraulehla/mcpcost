/**
 * What a failed start of a package server means, from the error text of the stdio client (the transport's message,
 * then stderrSummary: the exception line, the first error of Node, the last lines). The exception line decides: a
 * module that is not there or a syntax error is a broken package (crashed); a key, a token or a variable that is not
 * set is a package that wants setup (needs_env), even when Python prints it as a traceback. No side effects, so the
 * tests can import it; probe/stdio-run.ts uses it for npm, PyPI, OCI and MCPB alike.
 */
import type { ProbeResult, RegistryPackage } from '../packages/mcpcost/src/index.js';

type Listed = Pick<RegistryPackage, 'environmentVariables'>;

/** Placeholder values for the environment the registry entry lists, so the server starts and lists its tools. */
export function placeholderEnv(pkg: Listed): Record<string, string> {
  const env: Record<string, string> = {};
  for (const v of pkg.environmentVariables ?? []) env[v.name] = v.default ?? (v.isSecret ? 'mcpcost-placeholder-secret' : 'mcpcost-placeholder');
  return env;
}

/**
 * The listed variables that the entry does not require and gives no default for. A client leaves them unset. A
 * placeholder in one of them can stop a server that checks the value at start: a URL, a number, a JSON text or one
 * of a set of names. The maintainer of io.github.alexar76/histor reported it on 2026-11-26: with HISTOR_MCP_REMOTE
 * set to the placeholder the launcher printed its usage and the board said "needs args". The probe starts such a
 * server once more without these variables when the start with placeholders fails.
 */
export function optionalEnvNames(pkg: Listed): string[] {
  return (pkg.environmentVariables ?? []).filter((v) => !v.isRequired && v.default == null).map((v) => v.name);
}

/** An environment without the named variables. */
export function withoutNames(env: Record<string, string>, names: string[]): Record<string, string> {
  return Object.fromEntries(Object.entries(env).filter(([name]) => !names.includes(name)));
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
