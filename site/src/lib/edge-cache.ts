/**
 * The edge of the site: the checks that come before any work, and the cache of rendered GET responses. The Worker
 * entry (src/worker.ts) runs gate() and cached() before Astro, so a blocked bot, a redirect and a cache hit cost no
 * routing, no middleware and no render: on 2026-10-26 a hit still cost 5 ms of CPU inside Astro, half the free
 * plan's limit. The Astro middleware renders a miss and stores it with store().
 */
/**
 * Caches rendered GET responses inside the isolate. The data changes once a day,
 * and a front-page spike hits a handful of URLs, so this keeps D1 reads flat.
 * The Cache API is tried as well; it helps on a custom domain and is harmless on workers.dev.
 */
export const memory = new Map<string, { expires: number; status: number; headers: [string, string][]; body: ArrayBuffer }>();
const MAX_ENTRIES = 400;

function withCharset(type: string | null): string {
  const t = type ?? 'text/html';
  return /charset=/i.test(t) || !/^(text\/|image\/svg)/.test(t) ? t : `${t}; charset=utf-8`;
}

/** What the browser may keep: a minute for pages, an hour for badges and sitemaps. The zone's own TTL must not leak through. */
export function browserCacheControl(contentType: string | null): string {
  return /svg|xml/i.test(contentType ?? '') ? 'public, max-age=3600, must-revalidate' : 'public, max-age=60, must-revalidate';
}

export function ttlOf(response: Response): number {
  const cc = response.headers.get('cache-control') ?? '';
  const m = /s-maxage=(\d+)/.exec(cc) ?? /max-age=(\d+)/.exec(cc);
  return m ? Number(m[1]) : 0;
}

const CANONICAL_HOST = 'mcpcost.ulehla.dev';

/** Seconds until the next midnight UTC, when the D1 free tier counters reset. */
function secondsToMidnightUtc(): number {
  const now = new Date();
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  return Math.max(60, Math.ceil((next - now.getTime()) / 1000));
}

export function limitResponse(url: URL, message: string): Response {
  const retry = secondsToMidnightUtc();
  const headers = { 'cache-control': 'no-store', 'retry-after': String(retry) };
  if (url.pathname.startsWith('/api/') || url.pathname === '/mcp') {
    return Response.json({ error: 'The database read budget for today is spent. The board is back at 00:00 UTC.', retryAfterSeconds: retry, detail: message.slice(0, 160) }, { status: 503, headers });
  }
  const minutes = Math.round(retry / 60);
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta name="robots" content="noindex"><title>Back at 00:00 UTC · mcpcost</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#120f0c;color:#eee7d8;font:16px/1.5 system-ui,sans-serif}main{max-width:36rem;padding:32px}h1{font-size:1.4rem;margin:0 0 12px}p{margin:8px 0;color:#b8ae9c}a{color:#e8571f}code{color:#eee7d8}</style></head>
<body><main><h1>The board is resting until 00:00 UTC</h1><p>The free database tier allows a fixed number of row reads a day, and today's budget is spent. Pages are back in about ${minutes} minutes.</p><p>Until then: <a href="https://www.npmjs.com/package/mcpcost">npx mcpcost</a> measures the servers in your own config, and the <a href="https://github.com/ondraulehla/mcpcost">repository</a> has the method and the data.</p></main></body></html>`;
  return new Response(html, { status: 503, headers: { ...headers, 'content-type': 'text/html; charset=utf-8' } });
}

/**
 * Crawlers that fetch every page and every list variant, ignore robots.txt and bring nothing:
 * SEO scrapers and the like. They get a 403 before any database read. On 2026-10-18 one of
 * them (ShapBot, from Google Cloud addresses) made 85 000 requests in a day and spent the
 * Worker's free-plan request limit; a WAF rule on the zone stops them before the Worker.
 */
const BLOCKED_AGENTS = /ShapBot|SemrushBot|DataForSeoBot|AhrefsBot|MJ12bot|DotBot|PetalBot|Bytespider|BLEXBot|serpstatbot|ZoominfoBot|Barkrowler|ImagesiftBot|meta-externalagent/i;

/**
 * Networks that scraped the list on the nights of 2026-10-22 and 23: Chrome user agents from hosting addresses that
 * ignore robots.txt and nofollow and follow the host link of every server page through every status, sort and page
 * of /servers, 3 000 list variants in 90 minutes the first night, 8 000 the second. The one from Meta's cloud turned
 * out to be Meta's own crawler, meta-externalagent, named at the end of a Chrome or Firefox agent string; Cloudflare
 * counts it as a verified bot. A list variant from these networks gets a 403 before any database read; the server
 * pages stay open. The zone's rules (site/edge/rules.mjs) stop the same requests before the Worker now; this is the
 * second layer, for the workers.dev host the zone does not see.
 */
const LIST_SCRAPER_NETWORKS = /RapidSeedbox|Alibaba|Meta Platforms/i;


/** Paths with no page of their own, and the page that answers what their visitors ask. */
const MOVED: Record<string, string> = { '/pricing': '/tokens', '/privacy-policy': '/privacy', '/docs': '/connect' };

/** A 403 for a blocked crawler or a list scraper, a 301 for an old host or a moved path, or null to go on. Cheap: no database. */
export function gate(request: Request): Response | null {
  const url = new URL(request.url);
  if (BLOCKED_AGENTS.test(request.headers.get('user-agent') ?? '')) {
    return new Response('This crawler is not welcome here. See /robots.txt.', { status: 403, headers: { 'cache-control': 'no-store' } });
  }
  // The list API is not here: a script on one of these clouds is a reader, and the zone's rate limit holds it to a pace.
  // request.cf is read only for a list variant: building it costs more than the rest of this function.
  if (url.pathname === '/servers' && url.search && LIST_SCRAPER_NETWORKS.test((request as unknown as { cf?: { asOrganization?: string } }).cf?.asOrganization ?? '')) {
    return new Response('Scraping the list variants is not welcome here. See /robots.txt; the data is in the repository.', { status: 403, headers: { 'cache-control': 'no-store' } });
  }
  // The workers.dev address and the old mcp-pulse.ulehla.dev name stay as aliases and send everyone to the real one.
  if (url.hostname.endsWith('.workers.dev') || (url.hostname.endsWith('.ulehla.dev') && url.hostname !== CANONICAL_HOST)) {
    url.hostname = CANONICAL_HOST;
    url.protocol = 'https:';
    url.port = '';
    return Response.redirect(url.toString(), 301);
  }
  // Addresses that people type or follow and the board never had. /pricing: searches for "mcp server pricing" end here.
  const moved = MOVED[url.pathname];
  if (moved) {
    url.pathname = moved;
    return Response.redirect(url.toString(), 301);
  }
  return null;
}

/** The cache key: the URL and the deployed version, so a deploy never serves stale pages. */
export function cacheKey(request: Request, version: string | undefined): string {
  const url = new URL(request.url);
  return `${request.url}${url.search ? '&' : '?'}__v=${version ?? 'dev'}`;
}

/** A cached response for the key, from the isolate's memory or the edge cache, or null. */
export async function cached(key: string): Promise<Response | null> {
  const hit = memory.get(key);
  if (hit && hit.expires > Date.now()) {
    const h = new Headers(hit.headers);
    h.set('cache-control', browserCacheControl(h.get('content-type')));
    h.set('x-cache', 'memory');
    return new Response(hit.body.slice(0), { status: hit.status, headers: h });
  }
  try {
    const edge = (caches as unknown as { default?: Cache }).default;
    const found = edge ? await edge.match(new Request(key, { method: 'GET' })) : undefined;
    if (found) {
      const h = new Headers(found.headers);
      h.set('cache-control', browserCacheControl(h.get('content-type')));
      h.set('x-cache', 'edge');
      return new Response(found.body, { status: found.status, headers: h });
    }
  } catch {
    // No Cache API here (workers.dev in some setups): the render goes on.
  }
  return null;
}

/** Keeps a rendered 200 with a TTL in memory and at the edge, and gives the response for the browser. */
export async function store(key: string, response: Response): Promise<Response> {
  const ttl = ttlOf(response);
  if (response.status !== 200 || ttl <= 0) {
    if (response.headers.has('cache-control') && response.status === 200) {
      const h = new Headers(response.headers);
      h.set('cache-control', browserCacheControl(h.get('content-type')));
      return new Response(response.body, { status: response.status, headers: h });
    }
    return response;
  }
  const body = await response.arrayBuffer();
  const headers: [string, string][] = [...response.headers.entries()];
  if (memory.size >= MAX_ENTRIES) {
    const oldest = memory.keys().next().value;
    if (oldest) memory.delete(oldest);
  }
  memory.set(key, { expires: Date.now() + ttl * 1000, status: response.status, headers, body });
  let edgeNote = 'none';
  const edge = (caches as unknown as { default?: Cache }).default;
  if (edge) {
    // Store a copy with only the headers the cache needs, keyed by the bare URL.
    const copy = new Response(body.slice(0), {
      status: response.status,
      headers: { 'content-type': withCharset(response.headers.get('content-type')), 'cache-control': `public, max-age=${ttl}` }
    });
    try {
      await edge.put(new Request(key, { method: 'GET' }), copy);
      edgeNote = 'stored';
    } catch (err) {
      edgeNote = `put-failed: ${(err as Error).message}`.slice(0, 80);
    }
  }
  const out = new Headers(headers);
  out.set('cache-control', browserCacheControl(out.get('content-type')));
  out.set('x-cache', 'miss');
  out.set('x-edge', edgeNote);
  return new Response(body, { status: response.status, headers: out });
}
