import { env, waitUntil } from 'cloudflare:workers';
import snapshot from './mcp-snapshot.json';

/**
 * Who uses the MCP server, as counts for each day (table mcp_use in schema.sql). The request log of the host does
 * not hold the JSON-RPC method, so it cannot tell a tool call from the initialize of a directory's probe, and it
 * goes away after seven days. One request adds one to the count of its day, agent, client name, method and tool.
 * No address, no argument, no answer and no time of day is kept. The weekly report (edge/reach.mjs) reads the table.
 */
export interface McpUse {
  /** The UTC date of the request. */
  day: string;
  /** The User-Agent header as a label, see agentLabel. */
  agent: string;
  /** clientInfo.name of an initialize request; empty for every other message. */
  client: string;
  /** A JSON-RPC method the server knows, or GET, DELETE, batch, unread or other. */
  method: string;
  /** The tool of a tools/call when it is one of the server's own, unknown for any other name, else empty. */
  tool: string;
}

/** The methods that get a count under their own name. Any other method is "other", so the values stay a short list. */
const METHODS = new Set(['initialize', 'ping', 'tools/list', 'tools/call', 'resources/list', 'resources/templates/list', 'resources/read', 'prompts/list', 'prompts/get']);
const TOOLS = new Set(snapshot.toolsList.tools.map((t) => t.name));
const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;

/** A name a client gives: one line, no e-mail address, a length limit. */
function label(text: string, max: number): string {
  return text.replace(EMAIL, '[email]').replace(/\s+/g, ' ').trim().slice(0, max);
}

/**
 * The User-Agent header as a label. A browser's string is long and differs from person to person, so every
 * browser is "browser"; a crawler that puts "compatible" or its kind in a Mozilla string keeps its own text.
 */
export function agentLabel(agent: string | null): string {
  if (!agent) return '';
  if (/^Mozilla\//.test(agent) && !/compatible;|bot|crawl|spider|probe|scan|check|monitor/i.test(agent)) return 'browser';
  return label(agent, 120);
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * What one request to /mcp counts as, or null when it gets no count. message is the parsed body when the route
 * read it. A notification gets no count: each client sends one after initialize, and it says nothing more.
 */
export function describeUse(request: Request, message: unknown, now: Date = new Date()): McpUse | null {
  const use: McpUse = { day: now.toISOString().slice(0, 10), agent: agentLabel(request.headers.get('user-agent')), client: '', method: 'other', tool: '' };
  if (request.method !== 'POST') return { ...use, method: request.method === 'GET' || request.method === 'DELETE' ? request.method : 'other' };
  if (message === undefined) return { ...use, method: 'unread' };
  if (Array.isArray(message)) return { ...use, method: 'batch' };
  if (!isObj(message) || typeof message.method !== 'string') return use;
  if (message.method.startsWith('notifications/')) return null;
  if (!METHODS.has(message.method)) return use;
  use.method = message.method;
  const params = isObj(message.params) ? message.params : {};
  if (use.method === 'initialize' && isObj(params.clientInfo) && typeof params.clientInfo.name === 'string') use.client = label(params.clientInfo.name, 80);
  if (use.method === 'tools/call') use.tool = typeof params.name === 'string' && TOOLS.has(params.name) ? params.name : 'unknown';
  return use;
}

/** Adds one to the count of this day, agent, client, method and tool. */
export async function recordUse(use: McpUse, db: D1Database = (env as unknown as { DB: D1Database }).DB): Promise<void> {
  await db
    .prepare('INSERT INTO mcp_use (day, agent, client, method, tool, count) VALUES (?, ?, ?, ?, ?, 1) ON CONFLICT (day, agent, client, method, tool) DO UPDATE SET count = count + 1')
    .bind(use.day, use.agent, use.client, use.method, use.tool)
    .run();
}

/** Counts a request after the answer has gone out. A count that fails must never stop or slow an answer. */
export function countUse(request: Request, message: unknown): void {
  try {
    const use = describeUse(request, message);
    if (use) waitUntil(recordUse(use).catch((e) => console.warn(`mcp_use: ${e instanceof Error ? e.message : String(e)}`)));
  } catch (e) {
    console.warn(`mcp_use: ${e instanceof Error ? e.message : String(e)}`);
  }
}
