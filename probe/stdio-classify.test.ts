import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classify, optionalEnvNames, placeholderEnv, sdkPin, withoutNames } from './stdio-classify.js';
import { stderrSummary } from '../packages/mcpcost/src/stdio.js';

const closed = 'MCP error -32000: Connection closed';
const failed = (stderr: string) => classify({ status: 'error', error: `${closed}\n${stderrSummary(stderr)}` }).status;

test('a Python traceback that ends in a missing variable wants setup, not a fix', () => {
  const trace = ['Traceback (most recent call last):', '  File "/work/bin/server", line 8, in <module>', '    sys.exit(main())', '  File "/work/uv/server/lib/python3.12/site-packages/server/main.py", line 12, in main', "    key = os.environ['OPENAI_API_KEY']", "KeyError: 'OPENAI_API_KEY'"].join('\n');
  assert.equal(failed(trace), 'needs_env');
  assert.equal(failed('Traceback (most recent call last):\n  File "x.py", line 3\nValueError: Please set GITHUB_TOKEN before you start the server'), 'needs_env');
  assert.equal(failed('Error: Missing required environment variable: NOTION_TOKEN\n    at file:///work/node_modules/x/index.js:4:9'), 'needs_env');
  assert.equal(failed('Traceback (most recent call last):\n  File "x"\nRuntimeError: npc_verify API package not found. Set NPC_VERIFY_API_PATH to the directory'), 'needs_env');
});

test('a module that is not there or a syntax error is a broken package', () => {
  assert.equal(failed("Traceback (most recent call last):\n  File \"x\", line 4\nModuleNotFoundError: No module named 'mcp.server.fastmcp'"), 'crashed');
  assert.equal(failed("node:internal/modules/cjs/loader:1228\n  throw err;\n  ^\n\nError: Cannot find module 'zod'\nRequire stack:\n- /work/node_modules/x/index.js"), 'crashed');
  assert.equal(failed("file:///work/node_modules/x/index.js:3\nSyntaxError: Unexpected token '?'"), 'crashed');
  assert.equal(classify({ status: 'error', error: closed }).status, 'crashed');
});

test('a PyPI package that stops at the import of FastMCP from mcp 2.x is installed once more with mcp<2', () => {
  // The message of mcp 2.x, src/mcp/server/fastmcp.py in modelcontextprotocol/python-sdk.
  const moved = "Traceback (most recent call last):\n  File \"/work/bin/server\", line 4\nModuleNotFoundError: No module named 'mcp.server.fastmcp'. This is mcp 2.x, where FastMCP was renamed to MCPServer (from mcp.server.mcpserver import MCPServer) and other APIs changed; see the migration guide at https://py.sdk.modelcontextprotocol.io/v2/migration/#fastmcp-renamed-to-mcpserver or pin 'mcp<2' to keep running v1 code.";
  const { status, text } = classify({ status: 'error', error: `${closed}\n${stderrSummary(moved)}` });
  assert.equal(status, 'crashed');
  assert.equal(sdkPin('pypi', status, text), 'mcp<2');
  // Only that import, only PyPI, and only a crash: another missing module is the package's own defect.
  assert.equal(sdkPin('pypi', 'crashed', "ModuleNotFoundError: No module named 'httpx'"), undefined);
  assert.equal(sdkPin('npm', 'crashed', text), undefined);
  assert.equal(sdkPin('pypi', 'needs_env', text), undefined);
});

test('the network on start, a usage text and a foreign binary each have their own status', () => {
  assert.equal(failed('Error: getaddrinfo ENOTFOUND api.example.com\n    at GetAddrInfoReqWrap.onlookup'), 'needs_network');
  assert.equal(failed('usage: server [-h] --db PATH\nserver: error: the following arguments are required: --db'), 'needs_args');
  assert.equal(classify({ status: 'error', error: 'spawn ENOEXEC' }).status, 'no_bin');
  assert.equal(classify({ status: 'error', error: `${closed}\ndocker: Error response from daemon: exec: "serve": executable file not found in $PATH` }).status, 'no_bin');
});

test('the summary keeps the exception line and the first error of Node, not the middle of a trace', () => {
  const frames = Array.from({ length: 200 }, (_, i) => `    at frame${i} (node:internal/modules/esm/loader:${i})`).join('\n');
  const summary = stderrSummary(`Error: OPENAI_API_KEY is not set\n${frames}`);
  assert.match(summary.split('\n')[0], /^Error: OPENAI_API_KEY is not set/);
  assert.ok(summary.length <= 600);
});

test('every listed variable gets a value: its default, else a placeholder', () => {
  const pkg = { environmentVariables: [{ name: 'API_KEY', isRequired: true, isSecret: true }, { name: 'REGION', default: 'eu' }, { name: 'REMOTE' }] };
  assert.deepEqual(placeholderEnv(pkg), { API_KEY: 'mcpcost-placeholder-secret', REGION: 'eu', REMOTE: 'mcpcost-placeholder' });
  assert.deepEqual(placeholderEnv({}), {});
});

test('a variable that is not required and has no default is one a client leaves unset', () => {
  // The entry of io.github.alexar76/histor 0.10.0: one variable, no isRequired, no default. Its launcher wants a URL in it.
  assert.deepEqual(optionalEnvNames({ environmentVariables: [{ name: 'HISTOR_MCP_REMOTE', description: 'Public HISTOR instance to query' }] }), ['HISTOR_MCP_REMOTE']);
  // 0.11.0 gives a default, so the variable keeps that value in both starts.
  assert.deepEqual(optionalEnvNames({ environmentVariables: [{ name: 'HISTOR_MCP_REMOTE', default: 'https://histor.modelmarket.dev' }] }), []);
  assert.deepEqual(optionalEnvNames({ environmentVariables: [{ name: 'API_KEY', isRequired: true }, { name: 'DEBUG', isRequired: false }] }), ['DEBUG']);
  assert.deepEqual(optionalEnvNames({}), []);
});

test('the second start keeps the required variables, the defaults and what the server asked for', () => {
  const pkg = { environmentVariables: [{ name: 'API_KEY', isRequired: true }, { name: 'REGION', default: 'eu' }, { name: 'REMOTE' }] };
  const env = { ...placeholderEnv(pkg), ASKED_FOR: 'mcpcost-placeholder' };
  assert.deepEqual(withoutNames(env, optionalEnvNames(pkg)), { API_KEY: 'mcpcost-placeholder', REGION: 'eu', ASKED_FOR: 'mcpcost-placeholder' });
});
