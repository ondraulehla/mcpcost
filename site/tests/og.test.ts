import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { draw } from '../scripts/og';
import { CARDS, CARD_HEIGHT, CARD_WIDTH, DEFAULT_CARD, cardFor } from '../src/lib/og';

/**
 * public/og/: the social preview cards of src/lib/og.ts. scripts/og.ts draws them (npm run og -w site); here each
 * committed PNG must be what the script draws now, byte for byte. A change to a card, a font or a colour token
 * fails until the PNGs are drawn again and committed with the change.
 */
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

describe('the committed cards', () => {
  it.each(CARDS.map((c) => [c.src, c] as const))('%s is what scripts/og.ts draws now', async (src, card) => {
    const committed = readFileSync(new URL(`../public${src}`, import.meta.url));
    // The PNG header (IHDR) holds the size that og:image:width and og:image:height give.
    expect([committed.readUInt32BE(16), committed.readUInt32BE(20)]).toEqual([CARD_WIDTH, CARD_HEIGHT]);
    expect(sha(await draw(card)), `public${src} is out of date: run npm run og -w site and commit the PNGs`).toBe(sha(committed));
  });
});

describe('cardFor', () => {
  it('gives a page its own card', () => {
    expect(cardFor('/report/2026-10').src).toBe('/og/report-2026-10.png');
    expect(cardFor('/compare').src).toBe('/og/compare.png');
    expect(cardFor('/statistics').src).toBe('/og/statistics.png');
  });

  it('gives every other page the default card', () => {
    for (const path of ['/', '/servers', '/s/io.github.example/server', '/report', '/report/2026-11']) expect(cardFor(path)).toBe(DEFAULT_CARD);
  });

  it('has one card for each path and one file for each card', () => {
    expect(new Set(CARDS.map((c) => c.path)).size).toBe(CARDS.length);
    expect(new Set(CARDS.map((c) => c.src)).size).toBe(CARDS.length);
  });
});
