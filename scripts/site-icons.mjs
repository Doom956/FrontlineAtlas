// Dev only: makes the browser-tab / home-screen icons in public/ from the master public/favicon.svg, using Playwright.
//   node scripts/site-icons.mjs [shotsDir]        (default /tmp/borderfall-shots)
// Writes public/favicon.ico (16, 32, 48), favicon-32.png, apple-touch-icon.png (180, square, no transparency),
// icon-192.png, icon-512.png and icon-512-maskable.png (design shrunk into the 80% safe circle), then a preview
// shotsDir/icon-sizes.png (16/32/64 px on light and dark, true pixels) and icon-sizes-x3.png (3x, pixelated).
import { execSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pub = join(root, 'public');
const shots = process.argv[2] ?? '/tmp/borderfall-shots';
mkdirSync(shots, { recursive: true });

const require = createRequire(import.meta.url);
let pw;
try {
  pw = require('playwright');
} catch {
  pw = createRequire(join(execSync('npm root -g').toString().trim(), 'x.js'))('playwright');
}

const NAVY = '#0a111c';
const master = readFileSync(join(pub, 'favicon.svg'), 'utf8');
const inner = master.replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '');
// Square, opaque: iOS and launchers round the corners themselves.
const square = master.replace('rx="14"', 'rx="0"');
// Maskable: navy to the edges, the icon at 62% so the whole tile stays inside the 80% safe circle.
const maskable = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="${NAVY}"/><svg x="12.16" y="12.16" width="39.68" height="39.68" viewBox="0 0 64 64">${inner}</svg></svg>`;

const browser = await pw.chromium.launch();
const page = await browser.newPage({ deviceScaleFactor: 1 });

async function png(svg, size) {
  const src = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
  await page.setViewportSize({ width: Math.max(size, 64), height: Math.max(size, 64) });
  await page.setContent(`<body style="margin:0;background:transparent"><img id="i" src="${src}" width="${size}" height="${size}" style="display:block"></body>`);
  await page.locator('#i').evaluate((img) => img.decode());
  return page.locator('#i').screenshot({ omitBackground: true });
}

/** ICO with PNG payloads (read by every current browser). */
function ico(pngs) {
  const head = Buffer.alloc(6 + 16 * pngs.length);
  head.writeUInt16LE(0, 0);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(pngs.length, 4);
  let offset = head.length;
  pngs.forEach(([size, data], i) => {
    const e = 6 + 16 * i;
    head.writeUInt8(size >= 256 ? 0 : size, e);
    head.writeUInt8(size >= 256 ? 0 : size, e + 1);
    head.writeUInt16LE(1, e + 4);
    head.writeUInt16LE(32, e + 6);
    head.writeUInt32LE(data.length, e + 8);
    head.writeUInt32LE(offset, e + 12);
    offset += data.length;
  });
  return Buffer.concat([head, ...pngs.map(([, d]) => d)]);
}

const sizes = [16, 32, 48];
const small = [];
for (const s of sizes) small.push([s, await png(master, s)]);
writeFileSync(join(pub, 'favicon.ico'), ico(small));
writeFileSync(join(pub, 'favicon-32.png'), small[1][1]);
writeFileSync(join(pub, 'apple-touch-icon.png'), await png(square, 180));
writeFileSync(join(pub, 'icon-192.png'), await png(master, 192));
writeFileSync(join(pub, 'icon-512.png'), await png(master, 512));
writeFileSync(join(pub, 'icon-512-maskable.png'), await png(maskable, 512));

// Preview: 16/32/64 on a light and a dark tab strip, true pixels, then 3x pixelated.
const b64 = (svg) => `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
const row = (bg) =>
  `<div style="background:${bg};padding:12px;display:flex;gap:16px;align-items:center">${[16, 32, 64]
    .map((s) => `<img src="${b64(master)}" width="${s}" height="${s}">`)
    .join('')}</div>`;
await page.setViewportSize({ width: 420, height: 120 });
await page.setContent(`<body style="margin:0;background:#888;display:flex;gap:24px;padding:16px;align-items:center">${row('#fff')}${row('#202124')}</body>`);
const sheet = await page.screenshot();
writeFileSync(join(shots, 'icon-sizes.png'), sheet);
await page.setViewportSize({ width: 1260, height: 360 });
await page.setContent(`<body style="margin:0"><img src="data:image/png;base64,${sheet.toString('base64')}" style="width:1260px;image-rendering:pixelated"></body>`);
await page.screenshot({ path: join(shots, 'icon-sizes-x3.png') });
await browser.close();
console.log(`icons written to ${pub}; preview ${join(shots, 'icon-sizes.png')}`);
