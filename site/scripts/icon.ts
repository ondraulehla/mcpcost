/**
 * Draws the icon of the MCP server and of the directory listings from public/favicon.svg, as square PNGs:
 *
 *   node --import tsx scripts/icon.ts
 *
 * resvg runs as WebAssembly, so every machine makes the same bytes. The files are committed (public/icon-512.png,
 * public/icon-192.png); run this again only when the favicon changes.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { initWasm, Resvg } from '@resvg/resvg-wasm';

const require = createRequire(import.meta.url);
await initWasm(readFileSync(require.resolve('@resvg/resvg-wasm/index_bg.wasm')));
const svg = readFileSync(fileURLToPath(new URL('../public/favicon.svg', import.meta.url)), 'utf8');
for (const size of [512, 192]) {
  const png = new Resvg(svg, { fitTo: { mode: 'width', value: size } }).render().asPng();
  writeFileSync(fileURLToPath(new URL(`../public/icon-${size}.png`, import.meta.url)), png);
  console.log(`icon-${size}.png ${png.length} bytes`);
}
