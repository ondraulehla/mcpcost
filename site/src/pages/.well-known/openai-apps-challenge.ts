import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';

/**
 * The domain verification of the OpenAI plugin directory: the portal shows a token when the MCP server is connected
 * and reads it here, as plain text and nothing else. The token is the Worker secret OPENAI_APPS_CHALLENGE, so a new
 * one needs no deploy (npx wrangler secret put OPENAI_APPS_CHALLENGE). Without the secret there is no such page.
 */
export const GET: APIRoute = () => {
  const token = ((env as unknown as { OPENAI_APPS_CHALLENGE?: string }).OPENAI_APPS_CHALLENGE ?? '').trim();
  if (!token) return new Response('Not found', { status: 404 });
  // No cache-control: the middleware gives a response that has one a browser lifetime of a minute.
  return new Response(token, { headers: { 'content-type': 'text/plain; charset=utf-8' } });
};
