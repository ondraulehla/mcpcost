/**
 * Draws the social preview cards of src/lib/og.ts as 1200x630 PNGs into public/og/:
 *
 *   npm run og -w site
 *
 * satori lays out a card and turns its text into paths, and resvg paints the PNG. resvg runs as WebAssembly,
 * so every machine makes the same bytes, and tests/og.test.ts can hold the committed PNGs to what this script
 * draws now. It runs offline: the fonts are the faces of the site from @fontsource in node_modules (static
 * weights, because satori draws a variable font at its default weight only), and the colours are the light
 * tokens of src/layouts/Layout.astro.
 */
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { initWasm, Resvg } from '@resvg/resvg-wasm';
import satori, { type Font } from 'satori';
import type { CSSProperties, JSXNode } from 'satori/jsx';
import { jsx } from 'satori/jsx/jsx-runtime';
import { CARDS, CARD_HEIGHT, CARD_WIDTH, type Card } from '../src/lib/og';

const require = createRequire(import.meta.url);
const HOST = 'mcpcost.ulehla.dev';

const font = (file: string) => readFileSync(require.resolve(`@fontsource/${file}`));
const FONTS: Font[] = [
  { name: 'Anton', weight: 400, data: font('anton/files/anton-latin-400-normal.woff') },
  { name: 'Space Grotesk', weight: 500, data: font('space-grotesk/files/space-grotesk-latin-500-normal.woff') },
  { name: 'Space Grotesk', weight: 600, data: font('space-grotesk/files/space-grotesk-latin-600-normal.woff') },
  { name: 'Inter', weight: 400, data: font('inter/files/inter-latin-400-normal.woff') }
];

/** OKLCH to sRGB hex. A colour outside sRGB (the light accent is a little outside) is clipped per channel. */
function hex(l: number, c: number, hue: number): string {
  const a = c * Math.cos((hue * Math.PI) / 180);
  const b = c * Math.sin((hue * Math.PI) / 180);
  const lms = [l + 0.3963377774 * a + 0.2158037573 * b, l - 0.1055613458 * a - 0.0638541728 * b, l - 0.0894841775 * a - 1.291485548 * b].map((v) => v ** 3);
  const linear = [
    4.0767416621 * lms[0] - 3.3077115913 * lms[1] + 0.2309699292 * lms[2],
    -1.2684380046 * lms[0] + 2.6097574011 * lms[1] - 0.3413193965 * lms[2],
    -0.0041960863 * lms[0] - 0.7034186147 * lms[1] + 1.707614701 * lms[2]
  ];
  const srgb = linear.map((v) => Math.min(1, Math.max(0, v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055)));
  return '#' + srgb.map((v) => Math.round(v * 255).toString(16).padStart(2, '0')).join('');
}

/** The light tokens of the site: the first :root block of Layout.astro. */
function tokens(): Record<'surface' | 'ink' | 'ink-muted' | 'line' | 'accent', string> {
  const css = readFileSync(new URL('../src/layouts/Layout.astro', import.meta.url), 'utf8');
  const root = /:root \{([^}]*)\}/.exec(css)?.[1] ?? '';
  const out: Record<string, string> = {};
  for (const [, name, l, c, hue] of root.matchAll(/--([\w-]+):\s*oklch\(([\d.]+)%\s+([\d.]+)\s+([\d.]+)\)/g)) out[name] = hex(Number(l) / 100, Number(c), Number(hue));
  for (const name of ['surface', 'ink', 'ink-muted', 'line', 'accent']) if (!out[name]) throw new Error(`Layout.astro: no OKLCH token --${name} in the first :root block`);
  return out as ReturnType<typeof tokens>;
}
const C = tokens();

/** An element for satori: a tag, its style and its children. */
const h = (type: string, style: CSSProperties, ...children: JSXNode[]): JSXNode => jsx(type, children.length ? { style, children } : { style });

/** The mark of the site (CostMark.astro, the favicon): three bars on a grid of 32 units. */
function mark(size: number): JSXNode {
  const u = size / 32;
  return h(
    'div',
    { display: 'flex', alignItems: 'flex-end', gap: 2 * u, width: size, height: size, padding: `0 ${5 * u}px ${5 * u}px` },
    ...[9, 15, 22].map((n) => h('div', { width: 6 * u, height: n * u, background: C.accent }))
  );
}

/** Small capitals with wide tracking: the word mark, the kicker and the cells of the site. */
const caps = (size: number, weight: number): CSSProperties => ({ fontFamily: 'Space Grotesk', fontWeight: weight, fontSize: size, letterSpacing: 0.2 * size, textTransform: 'uppercase' });

function card(c: Card): JSXNode {
  // A title of three lines is smaller, so that the lede fits under it.
  const titleSize = c.hero ? 96 : c.title.length > 2 ? 88 : 112;
  return h(
    'div',
    { display: 'flex', flexDirection: 'column', width: '100%', height: '100%', background: C.surface, color: C.ink },
    // The head of the site: the mark and the word mark over a line.
    h('div', { display: 'flex', alignItems: 'center', gap: 20, height: 104, padding: '0 72px', borderBottom: `2px solid ${C.line}` }, mark(56), h('div', caps(30, 600), 'mcpcost')),
    // The kicker, the poster title and the lede.
    h(
      'div',
      { display: 'flex', flexDirection: 'column', justifyContent: 'center', flexGrow: 1, padding: '0 72px' },
      h('div', { ...caps(22, 600), color: C.accent }, c.kicker),
      h(
        'div',
        { display: 'flex', flexDirection: 'column', marginTop: 18, fontFamily: 'Anton', fontSize: titleSize, lineHeight: 0.95, textTransform: 'uppercase', color: c.hero ? C.ink : C.accent },
        ...c.title.map((line, i) => h('div', c.hero && i === c.title.length - 1 ? { color: C.accent } : {}, line))
      ),
      ...(c.lede ? [h('div', { marginTop: 24, fontFamily: 'Inter', fontSize: 28, lineHeight: 1.45, color: C['ink-muted'] }, c.lede)] : [])
    ),
    // The foot: the address of the page.
    h('div', { display: 'flex', alignItems: 'center', height: 84, padding: '0 72px', borderTop: `2px solid ${C.line}`, fontFamily: 'Space Grotesk', fontWeight: 500, fontSize: 26 }, HOST + (c.path === '/' ? '' : c.path))
  );
}

let wasm: Promise<void> | undefined;

/** The PNG of one card. */
export async function draw(c: Card): Promise<Uint8Array> {
  const svg = await satori(card(c), { width: CARD_WIDTH, height: CARD_HEIGHT, fonts: FONTS });
  wasm ??= initWasm(readFileSync(require.resolve('@resvg/resvg-wasm/index_bg.wasm')));
  await wasm;
  const resvg = new Resvg(svg);
  const image = resvg.render();
  const png = image.asPng();
  image.free();
  resvg.free();
  return png;
}

/** True when node runs this file, false when a test imports it. */
function invokedDirectly(): boolean {
  try {
    return realpathSync(process.argv[1] ?? '') === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  for (const c of CARDS) {
    const file = new URL(`../public${c.src}`, import.meta.url);
    mkdirSync(new URL('.', file), { recursive: true });
    const png = await draw(c);
    writeFileSync(file, png);
    console.log(`${c.src}  ${(png.length / 1024).toFixed(0)} kB  ${c.path}`);
  }
}
