// Dev only: renders a contact sheet of every icon (16/24/32/48 px on dark, light and green backgrounds, plus
// tinted units with halo) and screenshots it with Playwright.
//   node scripts/icon-sheet.mjs [outDir]        (default /tmp/borderfall-shots)
//   node scripts/icon-sheet.mjs [outDir] --only artillery,sam
//       only writes icons-focus.png: the listed icons at 16-128 px on dark and light (for iterating on a few icons)
// Writes icons-sheet.png (true pixels), icons-sheet-zoom.png (2x, pixelated, for close inspection) and
// icons-large.png (every icon at 96 px, for judging the drawing itself).
import { build } from 'esbuild';
import { execSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const onlyAt = args.indexOf('--only');
const only = onlyAt >= 0 ? (args[onlyAt + 1] ?? '').split(',').filter(Boolean) : null;
if (onlyAt >= 0) args.splice(onlyAt, 2);
const outDir = args[0] ?? '/tmp/borderfall-shots';
mkdirSync(outDir, { recursive: true });

async function loadPlaywright() {
  try {
    return await import('playwright');
  } catch {
    const globalRoot = execSync('npm root -g').toString().trim();
    return createRequire(join(globalRoot, 'noop.js'))('playwright');
  }
}

const bundle = await build({
  entryPoints: [join(root, 'src/client/icons.ts')],
  bundle: true,
  write: false,
  format: 'iife',
  globalName: 'Icons',
  target: 'es2020',
});
const js = bundle.outputFiles[0].text;

const page = `<!doctype html><meta charset="utf-8"><style>
body{margin:0;background:#888;font:11px sans-serif}
canvas{display:block}
</style><body><canvas id="c"></canvas><script>${js}</script><script>
const { ICON_IDS, ICON_INFO, drawIcon, CATEGORY_COLORS } = Icons;
const zoom = Number(new URLSearchParams(location.hash.slice(1)).get('zoom') || 1);
const SIZES = [16, 24, 32, 48];
const BGS = [['dark', '#1f2430', '#ddd'], ['light', '#eef0ec', '#333'], ['green', '#5b8f3e', '#fff']];
const COLS = 8, CW = 152, CH = 72, HEAD = 22;
const rows = Math.ceil(ICON_IDS.length / COLS);
const units = ICON_IDS.filter((id) => ICON_INFO[id].group === 'unit');
const TINTS = ['#d23c3c', '#2f6fd6', '#2fae4f', '#e0b020', '#9b4fd0', '#ffffff', '#222222'];
const W = COLS * CW;
const secH = HEAD + rows * CH;
const extraH = HEAD + TINTS.length * 44 + 10;
const H = BGS.length * secH + extraH;
const c = document.getElementById('c');
c.width = W * zoom; c.height = H * zoom;
c.style.width = W * zoom + 'px'; c.style.imageRendering = 'pixelated';
const ctx = c.getContext('2d');
ctx.imageSmoothingEnabled = false;
// draw at 1x into an offscreen canvas, then scale up pixelated
const off = document.createElement('canvas'); off.width = W; off.height = H;
const o = off.getContext('2d');
let y0 = 0;
for (const [name, bg, fg] of BGS) {
  o.fillStyle = bg; o.fillRect(0, y0, W, secH);
  o.fillStyle = fg; o.font = 'bold 13px sans-serif'; o.fillText(name + ' background', 6, y0 + 15);
  ICON_IDS.forEach((id, i) => {
    const cx = (i % COLS) * CW, cy = y0 + HEAD + Math.floor(i / COLS) * CH;
    let x = cx + 4;
    for (const s of SIZES) { drawIcon(o, id, x, cy + 52 - s, s, { dpr: 1 }); x += s + 4; }
    o.fillStyle = fg; o.font = '11px sans-serif';
    const cat = ICON_INFO[id].category;
    o.fillText(id + (cat ? ' (' + cat + ')' : ''), cx + 4, cy + 66);
    if (cat) { o.fillStyle = CATEGORY_COLORS[cat]; o.fillRect(cx + 4, cy + 56, 6, 3); }
  });
  y0 += secH;
}
o.fillStyle = '#3d6f9e'; o.fillRect(0, y0, W, extraH);
o.fillStyle = '#fff'; o.font = 'bold 13px sans-serif'; o.fillText('units: owner tint + halo, rotated, on water (32 px) / 20 px', 6, y0 + 15);
TINTS.forEach((t, r) => {
  const yy = y0 + HEAD + r * 44;
  units.forEach((id, i) => {
    drawIcon(o, id, 6 + i * 120, yy, 32, { dpr: 1, tint: t, outline: true });
    drawIcon(o, id, 46 + i * 120 + 16, yy + 16, 32, { dpr: 1, tint: t, outline: true, anchor: 'center', rotation: -0.6 });
    drawIcon(o, id, 86 + i * 120, yy + 6, 20, { dpr: 1, tint: t, outline: true });
  });
});
ctx.drawImage(off, 0, 0, W * zoom, H * zoom);
window.__done = true;
</script>`;

const largePage = `<!doctype html><meta charset="utf-8"><style>
body{margin:0;background:#888;font:12px sans-serif}
canvas{display:block}
</style><body><canvas id="c"></canvas><script>${js}</script><script>
const { ICON_IDS, drawIcon } = Icons;
const COLS = 9, CW = 132, CH = 128, S = 96;
const rows = Math.ceil(ICON_IDS.length / COLS);
const c = document.getElementById('c');
c.width = COLS * CW; c.height = rows * CH;
const o = c.getContext('2d');
ICON_IDS.forEach((id, i) => {
  const x = (i % COLS) * CW, y = Math.floor(i / COLS) * CH;
  o.fillStyle = (Math.floor(i / COLS) + (i % COLS)) % 2 ? '#2a2f3a' : '#e9ebe6';
  o.fillRect(x, y, CW, CH);
  drawIcon(o, id, x + (CW - S) / 2, y + 6, S, { dpr: 1 });
  o.fillStyle = (Math.floor(i / COLS) + (i % COLS)) % 2 ? '#ddd' : '#333';
  o.fillText(id, x + 6, y + CH - 8);
});
window.__done = true;
</script>`;

const focusPage = `<!doctype html><meta charset="utf-8"><style>
body{margin:0;background:#888;font:12px sans-serif}
canvas{display:block}
</style><body><canvas id="c"></canvas><script>${js}</script><script>
const { drawIcon } = Icons;
const ids = ${JSON.stringify(only ?? [])};
const SIZES = [16, 20, 24, 32, 48, 128];
const BGS = [['#1f2430', '#ddd'], ['#eef0ec', '#333'], ['#5b8f3e', '#fff']];
const RH = 140, W = SIZES.reduce((a, s) => a + s + 12, 0) + 96;
const c = document.getElementById('c');
c.width = W * BGS.length; c.height = ids.length * RH;
const o = c.getContext('2d');
BGS.forEach(([bg, fg], b) => {
  o.fillStyle = bg; o.fillRect(b * W, 0, W, c.height);
  ids.forEach((id, r) => {
    let x = b * W + 90;
    o.fillStyle = fg; o.fillText(id, b * W + 6, r * RH + 70);
    for (const s of SIZES) { drawIcon(o, id, x, r * RH + 134 - s, s, { dpr: 1 }); x += s + 12; }
  });
});
window.__done = true;
</script>`;

const { chromium } = await loadPlaywright();
const browser = await chromium.launch();
try {
  const jobs = only ? [[-1, 'icons-focus.png']] : [[1, 'icons-sheet.png'], [2, 'icons-sheet-zoom.png'], [0, 'icons-large.png']];
  for (const [zoom, file] of jobs) {
    const p = await browser.newPage({ viewport: { width: 1300, height: 900 } });
    const errors = [];
    p.on('pageerror', (e) => errors.push(String(e)));
    p.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    await p.setContent(zoom === -1 ? focusPage : zoom === 0 ? largePage : page.replace("location.hash.slice(1)", `'zoom=${zoom}'`));
    await p.waitForFunction(() => window.__done === true, null, { timeout: 10000 }).catch(() => {});
    if (errors.length) console.error(errors.join('\n'));
    await p.locator('#c').screenshot({ path: join(outDir, file) });
    console.log('wrote', join(outDir, file));
    await p.close();
  }
} finally {
  await browser.close();
}
