import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { memoryD1, type MemoryD1 } from './d1';
import { countServersWithErrors, serversWithError } from '../src/lib/db';
import { gate } from '../src/lib/edge-cache';
import { FIXES, fixFor, pypiPackage } from '../src/lib/fixes';

/**
 * The pages under /errors: an error text of the probe (cut to 160 characters, as servers.error holds it) must find
 * its fix by the regular expression (the server page) and by the LIKE patterns (the list), and the two must agree.
 */
let db: MemoryD1;
beforeEach(() => {
  db = memoryD1();
  (env as unknown as { DB: D1Database }).DB = db.d1;
});

/** Error texts as the run of 2026-11-13 has them, with the slug of their page, or null for a text that has none. */
const TEXTS: Array<[string, string | null]> = [
  ["MCP error -32000: Connection closed\nModuleNotFoundError: No module named 'mcp.server.fastmcp'. This is mcp 2.x, where FastMCP was renamed to MCPServer (from mcp", 'no-module-named-mcp-server-fastmcp'],
  ["ModuleNotFoundError: No module named 'mcp.server.fastmcp", 'no-module-named-mcp-server-fastmcp'],
  ["AttributeError: 'Server' object has no attribute 'list_tools'", 'server-object-has-no-attribute-list-tools'],
  ["AttributeError: 'Server' object has no attribute 'list_prompts'", 'server-object-has-no-attribute-list-tools'],
  ["AttributeError: 'Server' object has no attribute 'call_tool'", 'server-object-has-no-attribute-list-tools'],
  ["ImportError: cannot import name 'FastMCP' from 'mcp.server' (/work/lib/python3.12/site-packages/mcp/server/__init__.py)", 'cannot-import-name-fastmcp-from-mcp-server'],
  ["ImportError: cannot import name 'streamablehttp_client' from 'mcp.client.streamable_http' (/work/lib/python3.12/site-packages/mcp/client/streamable_http.py)", 'cannot-import-name-streamablehttp-client'],
  ["ImportError: cannot import name 'McpError' from 'mcp.shared.exceptions' (/work/lib/x.py)", 'cannot-import-name-mcperror'],
  ["ImportError: cannot import name 'McpError' from 'mcp' (/work/lib/x.py)", 'cannot-import-name-mcperror'],
  // Not an error of mcp 2.x: the lowlevel Server never had a tool decorator, and these modules are not the SDK's.
  ["AttributeError: 'Server' object has no attribute 'tool'", null],
  ["ModuleNotFoundError: No module named 'fastmcp'", null],
  ["ModuleNotFoundError: No module named 'mcp'", null],
  ["ImportError: cannot import name 'MCPServer' from 'mcp.server' (/work/x.py)", null],
  ['MCP error -32000: Connection closed', null]
];

describe('the fixes of the mcp 2.x errors', () => {
  it('finds the page of an error text, and none for a text of another cause', () => {
    for (const [text, slug] of TEXTS) expect(fixFor(text)?.slug ?? null, text).toBe(slug);
    expect(fixFor(null)).toBeUndefined();
  });

  it('has a unique slug per page, made of the characters of a path', () => {
    expect(new Set(FIXES.map((f) => f.slug)).size).toBe(FIXES.length);
    for (const f of FIXES) expect(f.slug).toMatch(/^[a-z0-9-]+$/);
  });

  it('lists by LIKE the same servers that the regular expression finds, PyPI packages only, crashed or pinned', async () => {
    const insert = db.sql.prepare("INSERT INTO servers (name, title, url, host, transport, probed_at, status, error) VALUES (?, ?, ?, 'pypi.org', 'stdio', '2026-11-13T08:30:00.000Z', ?, ?)");
    TEXTS.forEach(([text], i) => insert.run(`io.github.t/s${String(i).padStart(2, '0')}`, null, `pypi:pkg-${i}==1.0.${i}`, i === 0 ? 'needs_old_sdk' : 'crashed', text));
    // The same texts where they do not count: an npm package, and a server that answers again.
    insert.run('io.github.t/npm', null, 'npm:pkg@1.0.0', 'crashed', TEXTS[0][0]);
    insert.run('io.github.t/ok', null, 'pypi:fine==1.0.0', 'ok', TEXTS[0][0]);
    const counts = await countServersWithErrors(Object.fromEntries(FIXES.map((f) => [f.slug, f.like])));
    for (const f of FIXES) {
      const want = TEXTS.map(([, slug], i) => (slug === f.slug ? `io.github.t/s${String(i).padStart(2, '0')}` : null)).filter(Boolean);
      const got = await serversWithError(f.like);
      expect(got.map((s) => s.name), f.slug).toEqual(want);
      expect(counts[f.slug], f.slug).toBe(want.length);
    }
    const [pinned] = await serversWithError(FIXES[0].like);
    expect(pinned).toEqual({ name: 'io.github.t/s00', title: null, url: 'pypi:pkg-0==1.0.0', status: 'needs_old_sdk', tool_count: null });
    expect(await serversWithError([])).toEqual([]);
    expect(await countServersWithErrors({})).toEqual({});
  });

  it('reads the package name out of a PyPI server URL', () => {
    expect(pypiPackage('pypi:mcp-server-demo==1.2.3')).toBe('mcp-server-demo');
    expect(pypiPackage('pypi:mcp-server-demo@1.2.3')).toBe('mcp-server-demo');
    expect(pypiPackage('pypi:mcp-server-demo')).toBe('mcp-server-demo');
    expect(pypiPackage('npm:@scope/pkg@1.0.0')).toBeNull();
  });
});

describe('moved paths', () => {
  const get = (path: string) => gate(new Request(`https://mcpcost.ulehla.dev${path}`));
  it('sends /pricing to /tokens and keeps the query', () => {
    const res = get('/pricing?x=1');
    expect(res?.status).toBe(301);
    expect(res?.headers.get('location')).toBe('https://mcpcost.ulehla.dev/tokens?x=1');
  });
  it('lets the pages of the board through', () => {
    for (const path of ['/', '/tokens', '/privacy', '/connect', '/errors', '/pricing/more']) expect(get(path), path).toBeNull();
  });
});
