import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import { findByUrl, getServer, latestRun, listServers, SORTS, MAX_NUMBERED_PAGE, decodeCursor, encodeCursor, type SortKey } from './db';
import { label } from './format';
import { probeRemoteRaw } from '../../../packages/mcpcost/src/core.ts';
import { payloadBytes, BYTES_PER_TOKEN } from '../../../packages/mcpcost/src/payload.ts';
import { liveClaudeCount } from './claude';
import { formatComparison } from '../../../packages/mcpcost/src/compare.ts';
import { compareOnBoard } from './compare';
import pkg from '../../../packages/mcpcost/package.json';

const SITE = 'https://mcpcost.ulehla.dev';

/** Every tool reads and reports; none changes a server or the board. check_server reaches the network. */
const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;
const STATUS = z.string().describe('ok (answered initialize and tools/list), auth (needs credentials), payment (402), needs_url (every URL in the registry has a placeholder each user fills in; not called), unprobed (an entry the probe does not run yet: an MCPB bundle, an OCI image, a NuGet or Cargo package, or nothing to connect to), not_found, protocol_error (not MCP), timeout, dns, tls, refused, server_error, rate_limited, newer_protocol, unsupported_version (rejects the protocol version the client asks for); package servers also install_failed, no_bin, needs_env, needs_args, needs_network, needs_old_sdk (starts and lists its tools only with mcp<2), crashed. A failure counts as down only after two days of failed probes (see failingSince)');
const nullableInt = (what: string) => z.number().int().nullable().optional().describe(what);
const nullableStr = (what: string) => z.string().nullable().optional().describe(what);
const SERVER_ROW = {
  name: z.string().describe('The registry name, io.github.owner/name'),
  title: nullableStr('The title the registry gives'),
  host: z.string().describe('The endpoint host'),
  status: STATUS,
  toolCount: nullableInt('How many tools tools/list returned'),
  claudeTokens: nullableInt('Exact count from the Anthropic count_tokens endpoint, names as published'),
  toolsTokens: nullableInt('o200k_base estimate over the compact JSON of the tool definitions; the exact count is about 1.9 times this at the median'),
  protocolVersion: nullableStr('The MCP protocol version the server negotiated'),
  page: z.string().describe("The server's page on the board")
};

/**
 * registerTool with the tool's argument type named by the caller. The SDK's types read zod from its own copy of the
 * package (zod 4 with v3 inside), the site's schemas come from another copy (zod 3), and inferring the arguments across
 * the two made the type check run out of memory. The SDK still checks the arguments against the schema at run time.
 */
type RegisterTool = <Args>(
  name: string,
  config: { title: string; description: string; annotations: ToolAnnotations; inputSchema: Record<string, unknown>; outputSchema: Record<string, unknown> },
  cb: (args: Args) => Promise<CallToolResult>
) => void;

/**
 * mcpcost as an MCP server: five tools over the same data as the board.
 * Stateless, one server instance per request, JSON responses.
 */
function build(): McpServer {
  const server = new McpServer(
    {
      name: 'mcpcost',
      title: 'mcpcost',
      // The version of the package, which has the same board tools (packages/mcpcost/src/mcp.ts).
      version: pkg.version,
      websiteUrl: `${SITE}/connect`,
      icons: [
        { src: `${SITE}/icon-512.png`, mimeType: 'image/png', sizes: ['512x512'] },
        { src: `${SITE}/favicon.svg`, mimeType: 'image/svg+xml', sizes: ['any'] }
      ]
    },
    {
      instructions:
        'Health and token cost of every remote server in the official MCP registry, and of its npm and PyPI package servers, probed daily. Use lookup_server for a registry name or URL, search_servers to find servers, compare_servers to put two to five next to each other, check_server to probe a URL that is not in the registry. claudeTokens is the exact count from the Anthropic count_tokens endpoint (claudeTokensClaudeCode with the mcp__<server>__ prefix); toolsTokens is an o200k_base estimate over each tool definition.'
    }
  );
  const register = server.registerTool.bind(server) as unknown as RegisterTool;
  // The name of a tool for people: the directory of Claude reads it from annotations.title, other clients from title.
  const tool: RegisterTool = (name, config, cb) => register(name, { ...config, annotations: { ...config.annotations, title: config.title } }, cb);

  tool<{ nameOrUrl: string }>(
    'lookup_server',
    {
      title: 'Look up a registry server',
      description:
        "Reads the board's latest daily probe of one server in the official MCP registry: status, how a client gets access, the exact Claude token cost of its tool definitions, tool count, latency and the most expensive tools. Instant, no connection to the server. Use it when the server is in the registry; use search_servers when you do not know its name, and check_server to probe a URL that is not in the registry. A name or URL that is not on the board returns isError with a short message.",
      annotations: READ_ONLY,
      inputSchema: { nameOrUrl: z.string().describe("The registry name, for example io.github.owner/name, or the server's https URL as the registry lists it. The name is exact; the URL must match the registry entry.") },
      outputSchema: {
        ...SERVER_ROW,
        url: z.string().describe('The endpoint the board probes'),
        statusLabel: z.string().describe('The status in words, as the board shows it'),
        httpStatus: nullableInt('The HTTP status of the first response'),
        authScheme: nullableStr('The WWW-Authenticate scheme of a server that needs auth'),
        authKind: nullableStr('How a client gets in: oauth-dcr (clients register themselves), oauth (client id from the publisher), token (a key in the Authorization header), unknown'),
        authDocumentation: nullableStr("The publisher's guide to getting access"),
        authMetadata: z.record(z.string(), z.unknown()).nullable().optional().describe('authorizationServers, scopesSupported, dynamicRegistration, pkce, grantTypes, from the OAuth metadata'),
        claudeTokensClaudeCode: nullableInt('The exact count with the Claude Code prefix mcp__<server>__ on each tool name'),
        claudeModel: nullableStr('The model the exact count is for'),
        claudeError: nullableStr('Why the Anthropic endpoint refused to count'),
        failingSince: nullableStr('For a server with no valid answer: the first probe of its current run of failed probes, ISO 8601'),
        down: z.boolean().optional().describe('True when the server has failed for two days or more; a more recent failure is "no answer", not down'),
        toolsTokensNote: z.string().optional(),
        shareOf200k: z.number().nullable().optional().describe('Percent of a 200k window, exact when claudeTokens is present'),
        latencyMs: z.object({ initialize: nullableInt('milliseconds'), toolsList: nullableInt('milliseconds') }).optional(),
        topTools: z.array(z.object({ name: z.string(), tokens: z.number() })).nullable().optional().describe('The five most expensive tools: name and o200k_base tokens'),
        probedAt: z.string().describe('ISO 8601 time of the probe')
      }
    },
    async ({ nameOrUrl }) => {
      const name = /^https?:\/\//.test(nameOrUrl) ? await findByUrl(nameOrUrl) : nameOrUrl;
      const s = name ? await getServer(name) : null;
      if (!s) return { content: [{ type: 'text', text: `No registry server matches ${nameOrUrl}. Use check_server to probe a URL live.` }], isError: true };
      const out = {
        name: s.name, title: s.title, url: s.url, host: s.host, status: s.status, statusLabel: label(s.status), httpStatus: s.http_status, authScheme: s.auth_scheme,
        authKind: s.auth_kind, authDocumentation: s.auth_documentation, authMetadata: s.auth_metadata ? JSON.parse(s.auth_metadata) : null,
        protocolVersion: s.protocol_version, toolCount: s.tool_count,
        claudeTokens: s.claude_tokens, claudeTokensClaudeCode: s.claude_tokens_cc, claudeModel: s.claude_model, claudeError: s.claude_error,
        failingSince: s.failing_since, down: s.down_since != null,
        toolsTokens: s.tools_tokens, toolsTokensNote: 'o200k_base estimate; claudeTokens is exact',
        shareOf200k: (s.claude_tokens ?? s.tools_tokens) != null ? Number((((s.claude_tokens ?? s.tools_tokens)! / 200_000) * 100).toFixed(2)) : null,
        latencyMs: { initialize: s.init_ms, toolsList: s.tools_ms }, topTools: s.top_tools ? JSON.parse(s.top_tools) : null,
        probedAt: s.probed_at, page: `${SITE}/s/${s.name}`
      };
      return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }], structuredContent: out };
    }
  );

  tool<{ query?: string; status?: 'ok' | 'auth' | 'payment' | 'newer_protocol' | 'down' | 'noanswer'; sort?: SortKey; page?: number; cursor?: string }>(
    'search_servers',
    {
      title: 'Search the registry board',
      description:
        'Finds servers on the board by words in their name, title, description or host, with optional filters, sorted by exact Claude token cost (highest first) by default. With no query and no filter it ranks the whole board, so page 1 is the most expensive servers in the registry and sort=claude-asc the cheapest. Use it to discover servers or to rank them by cost; use lookup_server once you have a name, compare_servers for a few side by side, registry_summary for the totals. Returns up to 20 servers per page with name, host, status, tool count and tokens. Page numbers go to 20; after that pass the `next` value of the previous answer as `cursor`. Sorting by the estimate, latency, protocol or registry date needs a query or a small status; on a bigger list the answer keeps the token order and says so in `sort`.',
      annotations: READ_ONLY,
      inputSchema: {
        query: z.string().optional().describe('Words to match, three or more characters each, as prefixes: "git copilot" finds the GitHub Copilot servers. Omit for the whole list.'),
        status: z.enum(['ok', 'auth', 'payment', 'newer_protocol', 'down', 'noanswer']).optional().describe('ok = answers and lists tools; auth = needs credentials; payment = 402; newer_protocol = a protocol newer than the SDK; down = no valid answer for two days or more; noanswer = no valid answer for less than two days. Omit for all.'),
        sort: z.enum(Object.keys(SORTS) as [SortKey, ...SortKey[]]).optional().describe('claude = exact Claude tokens, highest first (default); claude-asc = lowest first; tokens = the o200k_base estimate; tools = tool count; latency = initialize time; name; updated = registry date'),
        page: z.number().int().min(1).max(MAX_NUMBERED_PAGE).optional().describe(`Page number, 1 to ${MAX_NUMBERED_PAGE}, twenty servers each; default 1. Not with cursor.`),
        cursor: z.string().optional().describe('The `next` value of a previous answer, to continue from there; replaces page')
      },
      outputSchema: {
        page: z.number().int().optional().describe('The page number, absent when a cursor was used'),
        sort: z.string().describe('The sort that was applied'),
        hasNext: z.boolean(),
        next: z.string().nullable().optional().describe('The cursor for the next page, when hasNext'),
        servers: z.array(z.object(SERVER_ROW))
      }
    },
    async ({ query, status, sort, page, cursor }) => {
      const { rows, sort: used, hasNext, nextCursor } = await listServers({ q: query, status, sort: sort ?? 'claude', page: page ?? 1, perPage: 20, cursor: decodeCursor(cursor) });
      const out = { page: cursor ? undefined : (page ?? 1), sort: used, hasNext, next: hasNext && nextCursor ? encodeCursor(nextCursor) : null, servers: rows.map((r) => ({ name: r.name, title: r.title, host: r.host, status: r.status, toolCount: r.tool_count, claudeTokens: r.claude_tokens, toolsTokens: r.tools_tokens, protocolVersion: r.protocol_version, page: `${SITE}/s/${r.name}` })) };
      return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }], structuredContent: out };
    }
  );

  tool<{ url: string }>(
    'check_server',
    {
      title: 'Probe a server live',
      description:
        'Connects to an MCP server URL now (initialize and tools/list, 10 s timeout) and reports status, protocol, how a client gets access, tool names and the token cost of the tool definitions: exact in Claude when the counter is available, else an estimate from the schema size. Use it for a URL that is not in the official registry, or to see the state this minute; for a registry server prefer lookup_server, which is instant. Sends no credentials: a server that needs them comes back with status "auth", not an error. A URL that is not https, or a server that does not answer, returns its failure as status and error. The requests are the ones the MCP specification defines for a client (https://modelcontextprotocol.io/specification): the initialize handshake and tools/list over Streamable HTTP or SSE; the tool calls no tool of the server.',
      annotations: READ_ONLY,
      inputSchema: { url: z.string().url().describe('The https URL of the MCP endpoint, Streamable HTTP (…/mcp) or SSE (…/sse)') },
      outputSchema: {
        url: z.string(),
        status: STATUS,
        statusLabel: z.string().describe('The status in words'),
        httpStatus: z.number().int().optional().describe('The HTTP status of the first response'),
        authScheme: z.string().optional().describe('The WWW-Authenticate scheme of a server that needs auth'),
        authKind: z.string().optional().describe('How a client gets in: oauth-dcr, oauth, token or unknown'),
        authDocumentation: z.string().optional().describe("The publisher's guide to getting access"),
        authMetadata: z.record(z.string(), z.unknown()).optional().describe('authorizationServers, scopesSupported, dynamicRegistration, pkce, grantTypes'),
        protocolVersion: z.string().optional(),
        serverInfo: z.record(z.string(), z.unknown()).optional().describe('name, version and title from initialize'),
        toolCount: z.number().int().optional(),
        toolsBytes: z.number().int().describe('Bytes of the compact JSON of every tool definition'),
        claudeTokens: z.number().int().optional().describe('Exact count from the Anthropic count_tokens endpoint'),
        claudeTokensClaudeCode: z.number().int().optional().describe('The exact count with the Claude Code prefix on each tool name'),
        claudeModel: z.string().optional(),
        claudeError: z.string().optional(),
        toolsTokensEstimate: z.number().int().describe('Tokens estimated from the schema size at the registry median of 4.42 bytes per token'),
        estimateNote: z.string(),
        tools: z.array(z.string()).describe('The tool names, in the order the server lists them'),
        latencyMs: z.object({ initialize: z.number().optional(), toolsList: z.number().optional() }),
        error: z.string().optional().describe('The first line of the failure, when status is not ok')
      }
    },
    async ({ url }) => {
      const u = new URL(url);
      if (u.protocol !== 'https:' || !u.hostname.includes('.')) return { content: [{ type: 'text', text: 'Only public https URLs can be probed.' }], isError: true };
      const known = await findByUrl(u.toString());
      if (known) {
        const s = await getServer(known);
        if (s) return { content: [{ type: 'text', text: JSON.stringify({ inRegistry: true, name: s.name, status: s.status, toolCount: s.tool_count, claudeTokens: s.claude_tokens, toolsTokens: s.tools_tokens, page: `${SITE}/s/${s.name}` }, null, 2) }] };
      }
      const { result, tools } = await probeRemoteRaw({ url: u.toString(), type: /\/sse\/?$/.test(u.pathname) ? 'sse' : 'streamable-http' }, { timeoutMs: 10_000 });
      const bytes = tools.reduce((a, t) => a + payloadBytes(t), 0);
      const claude = result.status === 'ok' ? await liveClaudeCount(tools, u.hostname) : null;
      const out = {
        url: result.url, status: result.status, statusLabel: label(result.status), httpStatus: result.httpStatus, authScheme: result.authScheme,
        authKind: result.authKind, authDocumentation: result.authDocumentation, authMetadata: result.authMetadata,
        protocolVersion: result.protocolVersion, serverInfo: result.serverInfo, toolCount: result.toolCount, toolsBytes: bytes,
        claudeTokens: claude?.tokens, claudeTokensClaudeCode: claude?.tokensClaudeCode, claudeModel: claude?.model, claudeError: claude?.error,
        toolsTokensEstimate: Math.round(bytes / BYTES_PER_TOKEN), estimateNote: 'estimated from schema size at the registry median of 4.42 bytes per token; exact o200k: npx mcpcost --url <url>',
        tools: tools.map((t) => t.name), latencyMs: result.latencyMs, error: result.error
      };
      return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }], structuredContent: out };
    }
  );

  tool<{ servers: string[]; format?: 'json' | 'markdown' | 'csv' }>(
    'compare_servers',
    {
      title: 'Compare servers side by side',
      description:
        "Puts two to five registry servers next to each other from the board's latest daily probe: status, how a client gets in, tool count, token cost (exact in Claude when counted, else the estimate), share of a 200k window and initialize latency, with the cheapest, the most expensive and the spread. Use it to choose between servers that do the same job; use lookup_server for the full record of one server, search_servers to find candidates, and check_server for a URL that is not in the registry. Instant, no connection to the servers. A name the board does not know gets a row with status \"unknown\" and the comparison goes on. format picks the text layout (JSON, a Markdown table, or CSV to paste into a spreadsheet); the structured content is always JSON.",
      annotations: READ_ONLY,
      inputSchema: {
        servers: z.array(z.string()).min(2).max(5).describe("Two to five registry names (io.github.owner/name) or the servers' https URLs as the registry lists them"),
        format: z.enum(['json', 'markdown', 'csv']).optional().describe('The layout of the text content: json (default), markdown (a table with a summary line), or csv (a header row, then one row per server)')
      },
      outputSchema: {
        servers: z.array(z.object({
          name: z.string().describe('The registry name, or what was given when the board does not know it'),
          host: nullableStr('The endpoint host'),
          status: z.string().describe('The probe status, or "unknown" when the board has no such server'),
          statusLabel: nullableStr('The status in words'),
          authKind: nullableStr('oauth-dcr, oauth, token or unknown, for a server that needs auth'),
          toolCount: nullableInt('How many tools'),
          claudeTokens: nullableInt('Exact Claude count'),
          toolsTokens: nullableInt('o200k_base estimate'),
          tokens: nullableInt('The number compared: the exact count when it exists, else the estimate'),
          exact: z.boolean().describe('Whether tokens is the exact count'),
          shareOf200k: z.number().nullable().optional().describe('Percent of a 200k window'),
          initMs: nullableInt('initialize latency, milliseconds'),
          protocolVersion: nullableStr('The negotiated protocol version'),
          probedAt: nullableStr('ISO 8601 time of the probe'),
          page: nullableStr("The server's page on the board"),
          error: nullableStr('Why there is no data, for example "not on the board"')
        })).describe('One row per requested server, in the order given'),
        measured: z.number().int().describe('How many rows have a token number'),
        cheapest: z.string().nullable().describe('The server with the fewest tokens, when two or more rows are measured'),
        mostExpensive: z.string().nullable(),
        tokenSpread: z.number().int().nullable().describe('Tokens between the most expensive and the cheapest'),
        format: z.enum(['json', 'markdown', 'csv'])
      }
    },
    async ({ servers, format }) => {
      const out = await compareOnBoard(servers, format ?? 'json');
      return { content: [{ type: 'text', text: formatComparison(out) }], structuredContent: out as unknown as Record<string, unknown> };
    }
  );

  tool<Record<string, never>>(
    'registry_summary',
    {
      title: 'Registry summary',
      description:
        'Aggregates of the latest daily run over the whole official MCP registry: how many servers answer and why the rest do not, token cost percentiles and the exact-to-estimate ratio, how servers authenticate, protocol versions, transports, the heaviest servers and the biggest publishers. Use it for the state of the registry as a whole; use lookup_server or search_servers for one server. No input; the answer is a few kilobytes of JSON.',
      annotations: READ_ONLY,
      inputSchema: {},
      outputSchema: {
        probedAt: z.string().describe('ISO 8601 time of the run'),
        registryEntries: z.number().int().optional().describe('Entries in the registry'),
        registryWithRemote: z.number().int().optional().describe('Entries with a remote endpoint'),
        probed: z.number().int().optional().describe('Servers probed in this run'),
        ok: z.number().int().optional().describe('Servers that answered initialize and tools/list'),
        byStatus: z.record(z.string(), z.number()).optional().describe('Servers per status'),
        noAnswer: z.record(z.string(), z.number()).optional().describe('Of the failing servers, the ones that are not down yet: no valid answer for less than two days, per status'),
        authSchemes: z.record(z.string(), z.number()).optional().describe('Servers that need auth, per WWW-Authenticate scheme'),
        authKinds: z.record(z.string(), z.number()).optional().describe('Servers that need auth, per kind of access: oauth-dcr, oauth, token, unknown'),
        protocols: z.record(z.string(), z.number()).optional().describe('Alive servers per negotiated protocol version'),
        transports: z.record(z.string(), z.number()).optional(),
        toolsTokens: z.record(z.string(), z.unknown()).optional().describe('o200k_base estimate: median, p90, p99, max, total'),
        claudeTokens: z.record(z.string(), z.unknown()).optional().describe('Exact Claude counts: model, counted, refused, median, p90, p99, max, histogram, ratioToEstimate'),
        toolCount: z.record(z.string(), z.unknown()).optional().describe('median, p90, max')
      }
    },
    async () => {
      const run = await latestRun();
      if (!run) return { content: [{ type: 'text', text: 'The board has no run yet.' }], isError: true };
      return { content: [{ type: 'text', text: JSON.stringify(run, null, 2) }], structuredContent: run as unknown as Record<string, unknown> };
    }
  );
  return server;
}

/**
 * One request through the SDK, as the stateless mode wants it: a new server and a new transport.
 * The answer is the SDK's own; the endpoint adds its headers (src/pages/mcp.ts).
 */
export async function answer(request: Request): Promise<Response> {
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  const server = build();
  await server.connect(transport);
  try {
    return await transport.handleRequest(request);
  } finally {
    await server.close().catch(() => undefined);
  }
}
