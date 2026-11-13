import { beforeEach, describe, expect, it } from 'vitest';
import Ajv from 'ajv';
import { env } from 'cloudflare:workers';
import { memoryD1, type MemoryD1 } from './d1';
import { answer } from '../src/lib/mcp-server';

/**
 * Every tool has an output schema, and a client may check an answer against it: MCP Inspector does, with a JSON
 * Schema validator, and it refused registry_summary (keys the schema did not name) and check_server for a URL the
 * board knows (no structured content). Each tool is called here over the board's schema in memory, and its
 * structured content must pass the schema that tools/list gives, checked the way a client checks it.
 */
const ENDPOINT = 'https://mcpcost.ulehla.dev/mcp';
let db: MemoryD1;
beforeEach(() => {
  db = memoryD1();
  (env as unknown as { DB: D1Database }).DB = db.d1;
  const server = db.sql.prepare(
    "INSERT INTO servers (name, title, description, url, host, transport, probed_at, status, tool_count, tools_tokens, claude_tokens, claude_model, init_ms, protocol_version, top_tools) VALUES (?, ?, ?, ?, ?, 'streamable-http', '2026-11-13T08:30:00.000Z', ?, ?, ?, ?, ?, ?, ?, ?)"
  );
  server.run('io.github.one/alpha', 'Alpha', 'A Postgres server', 'https://alpha.example/mcp', 'alpha.example', 'ok', 4, 900, 1700, 'claude-opus-5-5', 120, '2025-06-18', JSON.stringify([{ name: 'query', tokens: 400 }]));
  // A server with no counts, title or protocol: every optional field of an answer is absent or null.
  server.run('io.github.two/beta', null, null, 'https://beta.example/mcp', 'beta.example', 'auth', null, null, null, null, null, null, null);
  // A run summary with more keys than registry_summary's schema names, as the probe writes it.
  const run = {
    probedAt: '2026-11-13T08:30:00.000Z', probed: 2, ok: 1, registryEntries: 2, registryWithRemote: 2, fastmcpMoved: 787, tracked: 6,
    byStatus: { ok: 1, auth: 1 }, toolsTokens: { median: 900, p90: 900, p99: 900, max: 900, total: 900 },
    claudeTokens: { model: 'claude-opus-5-5', counted: 1, refused: 0, median: 1700, p90: 1700, p99: 1700, max: 1700, total: 1700 },
    topHosts: [{ host: 'alpha.example', servers: 1 }], heaviest: [{ name: 'io.github.one/alpha', claudeTokens: 1700, toolsTokens: 900 }], source: 'registry', license: 'CC BY 4.0'
  };
  db.sql.prepare('INSERT INTO runs (probed_at, summary) VALUES (?, ?)').run(run.probedAt, JSON.stringify(run));
});

async function rpc(method: string, params?: object): Promise<{ result?: Record<string, unknown>; error?: unknown }> {
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, ...(params ? { params } : {}) });
  const res = await answer(new Request(ENDPOINT, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18' }, body }));
  return (await res.json()) as { result?: Record<string, unknown>; error?: unknown };
}

type Tool = { name: string; title?: string; annotations?: Record<string, unknown>; outputSchema: Record<string, unknown> };

const CALLS: Array<[string, object]> = [
  ['lookup_server', { nameOrUrl: 'io.github.one/alpha' }],
  ['lookup_server', { nameOrUrl: 'io.github.two/beta' }],
  ['search_servers', {}],
  ['search_servers', { query: 'postgres', status: 'ok', sort: 'claude-asc' }],
  ['compare_servers', { servers: ['io.github.one/alpha', 'io.github.two/beta', 'io.github.no/such'] }],
  ['compare_servers', { servers: ['io.github.one/alpha', 'io.github.two/beta'], format: 'markdown' }],
  ['registry_summary', {}],
  // A URL the board knows: the stored record, no connection.
  ['check_server', { url: 'https://alpha.example/mcp' }],
  ['check_server', { url: 'https://beta.example/mcp' }]
];

describe('the tools of the MCP server', () => {
  it('give structured content that passes their own output schema, as a client checks it', async () => {
    const tools = (await rpc('tools/list')).result?.tools as Tool[];
    const ajv = new Ajv({ strict: false, allErrors: true });
    for (const [name, args] of CALLS) {
      const tool = tools.find((t) => t.name === name);
      expect(tool, name).toBeDefined();
      const { result, error } = await rpc('tools/call', { name, arguments: args });
      const what = `${name} ${JSON.stringify(args)}`;
      expect(error, what).toBeUndefined();
      expect(result?.isError, `${what}: ${JSON.stringify(result?.content)}`).toBeFalsy();
      expect(result?.structuredContent, what).toBeDefined();
      const validate = ajv.compile(tool!.outputSchema);
      expect(validate(result?.structuredContent), `${what}: ${ajv.errorsText(validate.errors)}`).toBe(true);
    }
  });

  it('answer check_server for a URL the board knows from the stored record', async () => {
    const { result } = await rpc('tools/call', { name: 'check_server', arguments: { url: 'https://alpha.example/mcp' } });
    expect(result?.structuredContent).toEqual({
      url: 'https://alpha.example/mcp', status: 'ok', statusLabel: 'alive', inRegistry: true, name: 'io.github.one/alpha',
      toolCount: 4, claudeTokens: 1700, toolsTokens: 900, probedAt: '2026-11-13T08:30:00.000Z', page: 'https://mcpcost.ulehla.dev/s/io.github.one/alpha'
    });
  });

  it('keep the whole run summary in registry_summary, with the keys its schema does not name', async () => {
    const { result } = await rpc('tools/call', { name: 'registry_summary', arguments: {} });
    expect(result?.structuredContent).toMatchObject({ probed: 2, fastmcpMoved: 787, license: 'CC BY 4.0' });
  });

  it('name each tool for people in title and in annotations.title, and mark it read-only', async () => {
    const tools = (await rpc('tools/list')).result?.tools as Tool[];
    expect(tools.map((t) => t.name).sort()).toEqual(['check_server', 'compare_servers', 'lookup_server', 'registry_summary', 'search_servers']);
    for (const t of tools) {
      expect(t.title, t.name).toBeTruthy();
      expect(t.annotations, t.name).toMatchObject({ title: t.title, readOnlyHint: true, destructiveHint: false, openWorldHint: true });
    }
  });
});
