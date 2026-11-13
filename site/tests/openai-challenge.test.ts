import { afterEach, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import type { APIContext } from 'astro';
import { GET } from '../src/pages/.well-known/openai-apps-challenge';

const secrets = env as unknown as { OPENAI_APPS_CHALLENGE?: string };
afterEach(() => {
  delete secrets.OPENAI_APPS_CHALLENGE;
});

it('answers the domain verification of the OpenAI directory with the exact token as plain text, and 404 without one', async () => {
  const none = await GET({} as APIContext);
  expect(none.status).toBe(404);
  secrets.OPENAI_APPS_CHALLENGE = ' token-123\n';
  const res = await GET({} as APIContext);
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toBe('text/plain; charset=utf-8');
  expect(await res.text()).toBe('token-123');
});
