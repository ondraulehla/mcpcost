import { describe, expect, it } from 'vitest';
import { memoryD1 } from './d1';
import { fromSnapshot } from '../src/lib/mcp-snapshot';
import { agentLabel, describeUse, recordUse } from '../src/lib/mcp-use';

/**
 * The daily counts of the MCP server's use (src/lib/mcp-use.ts). The table must hold a short list of methods and
 * tools whatever a client sends, no e-mail address, and no browser string; and one request must add exactly one.
 */
const ENDPOINT = 'https://mcpcost.ulehla.dev/mcp';
const NOW = new Date('2026-11-22T23:59:59.000Z');
const post = (body: unknown, agent: string | null = 'mcpbeat/0.1 (+https://mcpbeat.com/bot/; liveness check)') => {
  const text = JSON.stringify(body);
  return new Request(ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'content-length': String(text.length), accept: 'application/json, text/event-stream', ...(agent ? { 'user-agent': agent } : {}) },
    body: text
  });
};
const rpc = (method: string, params?: object) => ({ jsonrpc: '2.0', id: 1, method, ...(params ? { params } : {}) });

describe('agentLabel', () => {
  it('keeps the name a probe gives', () => {
    expect(agentLabel('mcpbeat/0.1 (+https://mcpbeat.com/bot/; liveness check)')).toBe('mcpbeat/0.1 (+https://mcpbeat.com/bot/; liveness check)');
    expect(agentLabel('python-httpx/0.28.1')).toBe('python-httpx/0.28.1');
  });
  it('takes an e-mail address out', () => {
    expect(agentLabel('MCPWatch/0.1.0 (contact: someone@example.com) research')).toBe('MCPWatch/0.1.0 (contact: [email]) research');
    // A plus sign is a legal part of an address, so the one in front of it goes too.
    expect(agentLabel('Probe/1 (+first.last+tag@mail.example.org)')).toBe('Probe/1 ([email])');
  });
  it('folds every browser into one label, and keeps a crawler that names itself in a Mozilla string', () => {
    expect(agentLabel('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36')).toBe('browser');
    expect(agentLabel('Mozilla/5.0 (compatible; ExampleBot/1.0; +https://example.com/bot)')).toBe('Mozilla/5.0 (compatible; ExampleBot/1.0; +https://example.com/bot)');
  });
  it('gives an empty label for no header, and cuts a long one', () => {
    expect(agentLabel(null)).toBe('');
    expect(agentLabel('x'.repeat(500))).toHaveLength(120);
  });
});

describe('describeUse', () => {
  it('takes the day from the clock in UTC', () => {
    expect(describeUse(post(rpc('ping')), rpc('ping'), NOW)?.day).toBe('2026-11-22');
  });
  it('names the client of an initialize', () => {
    const m = rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude-ai', version: '0.1.0' } });
    expect(describeUse(post(m), m, NOW)).toEqual({ day: '2026-11-22', agent: 'mcpbeat/0.1 (+https://mcpbeat.com/bot/; liveness check)', client: 'claude-ai', method: 'initialize', tool: '' });
  });
  it('names the tool of a call when the server has it, and no other text', () => {
    const own = rpc('tools/call', { name: 'lookup_server', arguments: { name: 'io.github.one/alpha' } });
    expect(describeUse(post(own), own, NOW)).toMatchObject({ method: 'tools/call', tool: 'lookup_server', client: '' });
    const other = rpc('tools/call', { name: 'a name that a client made up', arguments: {} });
    expect(describeUse(post(other), other, NOW)).toMatchObject({ method: 'tools/call', tool: 'unknown' });
  });
  it('keeps no argument of a call', () => {
    const m = rpc('tools/call', { name: 'check_server', arguments: { url: 'https://secret.example/mcp' } });
    expect(JSON.stringify(describeUse(post(m), m, NOW))).not.toContain('secret.example');
  });
  it('gives a notification no count', () => {
    const m = { jsonrpc: '2.0', method: 'notifications/initialized' };
    expect(describeUse(post(m), m, NOW)).toBeNull();
  });
  it('puts a method it does not know, a batch, an unread body and other HTTP methods in fixed classes', () => {
    expect(describeUse(post(rpc('made/up')), rpc('made/up'), NOW)?.method).toBe('other');
    expect(describeUse(post([rpc('ping')]), [rpc('ping')], NOW)?.method).toBe('batch');
    expect(describeUse(post(rpc('ping')), undefined, NOW)?.method).toBe('unread');
    expect(describeUse(new Request(ENDPOINT, { method: 'GET' }), undefined, NOW)).toMatchObject({ method: 'GET', agent: '' });
    expect(describeUse(new Request(ENDPOINT, { method: 'DELETE' }), undefined, NOW)?.method).toBe('DELETE');
  });
});

describe('fromSnapshot', () => {
  it('hands the parsed body to the route for the answers from the snapshot and for the ones the SDK gives', async () => {
    for (const m of [rpc('tools/list'), rpc('tools/call', { name: 'registry_summary', arguments: {} })]) {
      let seen: unknown;
      await fromSnapshot(post(m), (message) => {
        seen = message;
      });
      expect(seen).toEqual(m);
    }
  });
});

describe('recordUse', () => {
  it('adds one to the count of the same day, agent, client, method and tool, and starts a row for a new one', async () => {
    const db = memoryD1();
    const list = describeUse(post(rpc('tools/list')), rpc('tools/list'), NOW)!;
    const call = describeUse(post(rpc('tools/call', { name: 'search_servers' })), rpc('tools/call', { name: 'search_servers' }), NOW)!;
    await recordUse(list, db.d1);
    await recordUse(list, db.d1);
    await recordUse(call, db.d1);
    await recordUse({ ...list, day: '2026-11-23' }, db.d1);
    const rows = db.sql.prepare('SELECT day, method, tool, count FROM mcp_use ORDER BY day, method').all();
    expect(rows.map((r) => ({ ...r }))).toEqual([
      { day: '2026-11-22', method: 'tools/call', tool: 'search_servers', count: 1 },
      { day: '2026-11-22', method: 'tools/list', tool: '', count: 2 },
      { day: '2026-11-23', method: 'tools/list', tool: '', count: 1 }
    ]);
  });
});
