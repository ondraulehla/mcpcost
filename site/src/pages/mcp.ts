import type { APIRoute } from 'astro';
import { fromSnapshot } from '../lib/mcp-snapshot';
import { countUse } from '../lib/mcp-use';

/**
 * mcpcost as an MCP server, five tools over the same data as the board (src/lib/mcp-server.ts).
 * initialize, tools/list, ping and the notifications come from a snapshot of the SDK's answers;
 * every other request goes to the SDK, which this route loads only for them. Each request adds one to a daily
 * count by client and method (src/lib/mcp-use.ts), written after the answer.
 */
async function handle(request: Request): Promise<Response> {
  let message: unknown;
  const quick = await fromSnapshot(request, (m) => {
    message = m;
  });
  countUse(request, message);
  const res = quick instanceof Response ? quick : await (await import('../lib/mcp-server')).answer(quick);
  const h = new Headers(res.headers);
  h.set('access-control-allow-origin', '*');
  h.set('access-control-allow-headers', 'content-type, mcp-protocol-version, mcp-session-id, accept');
  h.set('cache-control', 'no-store');
  return new Response(res.body, { status: res.status, headers: h });
}

export const POST: APIRoute = ({ request }) => handle(request);
export const GET: APIRoute = ({ request }) => handle(request);
export const DELETE: APIRoute = ({ request }) => handle(request);
export const OPTIONS: APIRoute = () =>
  new Response(null, { status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS', 'access-control-allow-headers': 'content-type, mcp-protocol-version, mcp-session-id, accept' } });
