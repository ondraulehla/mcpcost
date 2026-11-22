import snapshot from './mcp-snapshot.json';

/**
 * The MCP answers that need no server: initialize, tools/list, ping and the notifications. Directories and
 * monitors send little else, and for them the SDK cost the most CPU of any route: the first request in an
 * isolate loaded the SDK, zod and ajv, and every request built the server and turned five zod schemas into
 * JSON Schema. These answers come from mcp-snapshot.json instead, which the build writes from the SDK's own
 * answers (npm run mcp:snapshot). A request this code is not sure of goes to the SDK in mcp-server.ts, so every
 * answer stays the SDK's, byte for byte; tests/mcp.test.ts puts the two side by side.
 */

/** The tools/list result as JSON, made once per isolate. */
let toolsJson: string | undefined;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === 'string';
const isBool = (v: unknown): v is boolean => typeof v === 'boolean';
/** The key is absent, or its value passes the test. */
const opt = (o: Obj, key: string, test: (v: unknown) => boolean) => !Object.hasOwn(o, key) || test(o[key]);
const onlyKeys = (o: Obj, keys: string[]) => Object.keys(o).every((k) => keys.includes(k));
const objectOfObjects = (v: unknown) => isObj(v) && Object.values(v).every(isObj);
/** Params without _meta: the SDK checks _meta against a schema of its own, so a message with one goes there. */
const params = (v: unknown) => isObj(v) && !Object.hasOwn(v, '_meta');

/**
 * The checks of the SDK's message schemas (types.js), or stricter: what passes here passes there. Unknown keys
 * are allowed where the SDK drops them and refused where it refuses them (a JSON-RPC message itself is strict).
 */
const isRequest = (m: Obj) => onlyKeys(m, ['jsonrpc', 'id', 'method', 'params']) && m.jsonrpc === '2.0' && (isStr(m.id) || Number.isSafeInteger(m.id)) && opt(m, 'params', params);
const isNotification = (m: Obj) => onlyKeys(m, ['jsonrpc', 'method', 'params']) && m.jsonrpc === '2.0' && isStr(m.method) && m.method.startsWith('notifications/') && opt(m, 'params', params);
const icon = (v: unknown) =>
  isObj(v) && isStr(v.src) && opt(v, 'mimeType', isStr) && opt(v, 'sizes', (s) => Array.isArray(s) && s.every(isStr)) && opt(v, 'theme', (t) => t === 'light' || t === 'dark');
const clientInfo = (v: unknown) =>
  isObj(v) && isStr(v.name) && isStr(v.version) && opt(v, 'title', isStr) && opt(v, 'websiteUrl', isStr) && opt(v, 'description', isStr) && opt(v, 'icons', (i) => Array.isArray(i) && i.every(icon));
// The tasks capability is rare and its schema deep; a client that sends it gets the SDK.
const capabilities = (v: unknown) =>
  isObj(v) &&
  !Object.hasOwn(v, 'tasks') &&
  opt(v, 'experimental', objectOfObjects) &&
  opt(v, 'extensions', objectOfObjects) &&
  opt(v, 'sampling', (s) => isObj(s) && opt(s, 'context', isObj) && opt(s, 'tools', isObj)) &&
  opt(v, 'roots', (r) => isObj(r) && opt(r, 'listChanged', isBool)) &&
  opt(v, 'elicitation', (e) => isObj(e) && opt(e, 'form', (f) => isObj(f) && opt(f, 'applyDefaults', isBool)) && opt(e, 'url', isObj));
const initializeParams = (p: unknown) => params(p) && isStr((p as Obj).protocolVersion) && capabilities((p as Obj).capabilities) && clientInfo((p as Obj).clientInfo);

/** The SDK's answer to one request: a JSON-RPC result with status 200. */
const result = (json: string) => new Response(json, { status: 200, headers: { 'Content-Type': 'application/json' } });

/**
 * The answer from the snapshot, or the request to hand to the SDK: the same request, or a copy with
 * the same body when the body was read here. The checks before the body are the SDK's own, in its order.
 * seen gets the parsed body when this code read one, so the route can count the request (mcp-use.ts).
 */
export async function fromSnapshot(request: Request, seen?: (message: unknown) => void): Promise<Response | Request> {
  const accept = request.headers.get('accept');
  const type = request.headers.get('content-type');
  const length = request.headers.get('content-length');
  // The SDK streams a body and stops at its limit; a body without a length, or a long one, is the SDK's to read.
  if (request.method !== 'POST' || !accept?.includes('application/json') || !accept.includes('text/event-stream')) return request;
  if (type !== 'application/json' && !/^application\/json; ?charset=utf-8$/i.test(type ?? '')) return request;
  if (length === null || !(Number(length) <= 65_536)) return request;
  const text = await request.text();
  const copy = () => new Request(request.url, { method: 'POST', headers: request.headers, body: text });
  let m: unknown;
  try {
    m = JSON.parse(text);
  } catch {
    return copy();
  }
  seen?.(m);
  if (!isObj(m)) return copy();
  if (isRequest(m) && m.method === 'initialize') {
    if (!initializeParams(m.params)) return copy();
    const asked = (m.params as Obj).protocolVersion as string;
    const protocolVersion = snapshot.supportedProtocolVersions.includes(asked) ? asked : snapshot.initialize.protocolVersion;
    return result(JSON.stringify({ result: { ...snapshot.initialize, protocolVersion }, jsonrpc: '2.0', id: m.id }));
  }
  // Every message after initialize: a protocol version header the SDK does not know is a 400 from the SDK.
  const version = request.headers.get('mcp-protocol-version');
  if (version !== null && !snapshot.supportedProtocolVersions.includes(version)) return copy();
  if (isNotification(m)) return new Response(null, { status: 202 });
  if (!isRequest(m)) return copy();
  if (m.method === 'tools/list' && opt(m, 'params', (p) => opt(p as Obj, 'cursor', isStr))) {
    toolsJson ??= JSON.stringify(snapshot.toolsList);
    return result(`{"result":${toolsJson},"jsonrpc":"2.0","id":${JSON.stringify(m.id)}}`);
  }
  if (m.method === 'ping') return result(JSON.stringify({ result: {}, jsonrpc: '2.0', id: m.id }));
  return copy();
}
