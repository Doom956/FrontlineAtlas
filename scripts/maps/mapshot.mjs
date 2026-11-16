// In-game screenshot of a world map at deviceScaleFactor 2, the whole map in view after a few minutes of play.
//   NODE_PATH=D:/FrontlineAtlas-docs/node_modules node mapshot.mjs <dist/index.html> <map id> <out.png> [ticks=1800]
// The human spawns at the map's first listed spawn (or the nearest free land), all other nations are AI. Exit 1 on error.
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
const { chromium } = createRequire(import.meta.url)('playwright');

const [dist, id, out, ticksArg] = process.argv.slice(2);
if (!dist || !id || !out) {
  console.error('usage: node mapshot.mjs <dist/index.html> <map id> <out.png> [ticks]');
  process.exit(2);
}
const ticks = Number(ticksArg ?? 1800) || 1800;
const browser = await chromium.launch({ args: ['--ignore-gpu-blocklist', '--enable-gpu', '--use-angle=d3d11'] });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e)));
  await page.goto(pathToFileURL(resolve(dist)).href);
  await page.waitForFunction(() => !!window.__borderfall, null, { timeout: 30000 });
  await page.evaluate((id) => window.__borderfall.startGame({ seed: 7, map: { kind: 'world', id } }), id);
  await page.waitForFunction(() => window.__borderfall.getState()?.phase === 'spawn', null, { timeout: 60000 });
  const sp = await page.evaluate(() => {
    const bf = window.__borderfall;
    const s = bf.getState();
    const w = s.map.width;
    const taken = new Set(s.players.filter((p) => p && p.spawned).map((p) => p.capital));
    // try free land in growing rings around the map centre of mass of land
    let cx = 0, cy = 0, n = 0;
    for (let t = 0; t < s.map.terrain.length; t += 97) if (s.map.terrain[t] > 1) { cx += t % w; cy += (t / w) | 0; n++; }
    cx /= n; cy /= n;
    for (let r = 0; r < Math.max(w, s.map.height); r += 3) {
      for (let a = 0; a < 36; a++) {
        const x = Math.round(cx + Math.cos(a / 36 * Math.PI * 2) * r), y = Math.round(cy + Math.sin(a / 36 * Math.PI * 2) * r);
        if (x < 1 || y < 1 || x >= w - 1 || y >= s.map.height - 1) continue;
        const t = y * w + x;
        if (s.map.terrain[t] <= 1 || s.map.owner[t] !== 0 || taken.has(t)) continue;
        const res = bf.dispatch({ type: 'spawn', tile: t });
        if (res && res.ok) return t;
      }
    }
    return -1;
  });
  if (sp < 0) throw new Error('could not spawn the human');
  await page.evaluate(() => window.__borderfall.dispatch({ type: 'startNow' }));
  await page.evaluate((n) => { for (let k = 0; k < n; k += 100) window.__borderfall.advance(Math.min(100, n - k)); }, ticks);
  // the whole map in view: wait for the start's camera flight to end, then fit (repeated a few frames)
  await page.waitForTimeout(1200);
  for (let k = 0; k < 10; k++) {
    await page.evaluate(() => { const c = window.__borderfall.camera(); c.anim = null; c.fit(); });
    await page.waitForTimeout(60);
  }
  await page.waitForTimeout(300);
  await page.screenshot({ path: out });
  const info = await page.evaluate(() => { const s = window.__borderfall.getState(); return { w: s.map.width, h: s.map.height, tick: s.tick, nations: s.players.filter((p) => p && p.id > 0 && p.personality !== 'tribe' && p.alive).length }; });
  console.log(`SHOT ${id} ${out} ${JSON.stringify(info)}${errs.length ? ' ERRORS ' + errs.slice(0, 3).join(' | ') : ''}`);
} finally {
  await browser.close();
}
