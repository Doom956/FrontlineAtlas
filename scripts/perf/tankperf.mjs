// Frame time in a big tank fight at close zoom, on the real GPU.
//   node tankperf.mjs <dist/index.html> <label> [--headed]
// Same seed and setup every run: the human spawns next to an AI, play runs until the two touch, then 30 tank
// divisions per side are put on the border (holding), the two are set at war (warMemory) and the camera sits on the
// border at zoom 12. 10 s warm-up, then 20 s measured: rAF frame intervals (vsync and frame cap off) and the game's own
// per-frame sim / render / hud ms (window.__borderfall.perf).
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const [dist, label] = process.argv.slice(2);
const headed = process.argv.includes('--headed');
const PER_SIDE = 30;
const browser = await chromium.launch({
  headless: !headed,
  args: ['--ignore-gpu-blocklist', '--enable-gpu', '--use-angle=d3d11', '--disable-gpu-vsync', '--disable-frame-rate-limit', '--disable-renderer-backgrounding', '--disable-background-timer-throttling'],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errs = [];
page.on('pageerror', (e) => errs.push(String(e)));
await page.goto(pathToFileURL(resolve(dist)).href);
await page.waitForFunction(() => !!window.__borderfall, null, { timeout: 30000 });
const gpu = await page.evaluate(() => {
  const gl = document.createElement('canvas').getContext('webgl2') || document.createElement('canvas').getContext('webgl');
  const ext = gl && gl.getExtension('WEBGL_debug_renderer_info');
  return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : 'unknown';
});
await page.evaluate(() => window.__borderfall.startGame({ seed: 4242, map: { kind: 'generated', type: 'continents', size: 'small' }, aiCount: 7, difficulty: 'easy' }));
await page.waitForFunction(() => window.__borderfall.getState()?.phase === 'spawn', null, { timeout: 30000 });

// the human takes the first free land tile from the map centre, then play runs 600 ticks so nations meet
const spawned = await page.evaluate(() => {
  const bf = window.__borderfall;
  const s = bf.getState();
  const w = s.map.width, h = s.map.height;
  for (let r = 0; r < Math.max(w, h) / 2; r += 2) {
    for (let a = 0; a < 24; a++) {
      const x = Math.round(w / 2 + Math.cos((a / 24) * Math.PI * 2) * r), y = Math.round(h / 2 + Math.sin((a / 24) * Math.PI * 2) * r);
      if (x < 2 || y < 2 || x >= w - 2 || y >= h - 2) continue;
      const t = y * w + x;
      if (s.map.terrain[t] <= 1 || s.map.owner[t] !== 0) continue;
      const res = bf.dispatch({ type: 'spawn', tile: t });
      if (res && res.ok) return { tile: t };
    }
  }
  return null;
});
if (!spawned) throw new Error('could not spawn');
await page.evaluate(() => window.__borderfall.dispatch({ type: 'startNow' }));
await page.evaluate(() => window.__borderfall.advance(600));

// the longest land border between two nations (one of them the human when fog of war is on)
const border = await page.evaluate(() => {
  const s = window.__borderfall.getState();
  const w = s.map.width, h = s.map.height, me = s.humanId, own = s.map.owner, ter = s.map.terrain;
  const fog = !!s.fog;
  const count = new Map();
  for (let t = 0; t < own.length; t++) {
    const a = own[t];
    if (a <= 0 || ter[t] <= 1) continue;
    const x = t % w;
    for (const n of [x + 1 < w ? t + 1 : -1, t + w < own.length ? t + w : -1]) {
      if (n < 0) continue;
      const b = own[n];
      if (b <= 0 || b === a || ter[n] <= 1) continue;
      if (fog && a !== me && b !== me) continue;
      if (!s.players[a]?.alive || !s.players[b]?.alive) continue;
      const k = Math.min(a, b) * 4096 + Math.max(a, b);
      count.set(k, (count.get(k) || 0) + 1);
    }
  }
  let bk = -1, bn = 0;
  for (const [k, n] of count) if (n > bn) { bn = n; bk = k; }
  if (bk < 0) return null;
  return { a: Math.floor(bk / 4096), b: bk % 4096, tiles: bn, tick: s.tick, fog };
});
if (!border) throw new Error('no two nations share a border');

// 30 tank divisions per side on its own land within 3 tiles of the border, holding; the two at war
const setup = await page.evaluate(({ A, B, PER_SIDE }) => {
  const bf = window.__borderfall;
  const s = bf.getState();
  const w = s.map.width, h = s.map.height, me = s.humanId, own = s.map.owner, ter = s.map.terrain;
  const near = (t, other) => {
    const x = t % w, y = (t / w) | 0;
    for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      if (own[ny * w + nx] === other) return true;
    }
    return false;
  };
  const sides = [[A, B], [B, A]];
  let sx = 0, sy = 0, n = 0;
  const placed = {};
  for (const [a, b] of sides) {
    const cand = [];
    for (let t = 0; t < own.length; t++) if (own[t] === a && ter[t] > 1 && near(t, b)) cand.push(t);
    // keep the fight in one place: the candidates closest to the first one's centre
    const cx = cand.reduce((q, t) => q + (t % w), 0) / Math.max(1, cand.length);
    const cy = cand.reduce((q, t) => q + ((t / w) | 0), 0) / Math.max(1, cand.length);
    cand.sort((p, q) => Math.hypot((p % w) - cx, ((p / w) | 0) - cy) - Math.hypot((q % w) - cx, ((q / w) | 0) - cy));
    const pick = cand.slice(0, PER_SIDE);
    for (const t of pick) {
      s.units.push({ id: s.nextId++, type: 'tankDivision', owner: a, x: t % w, y: (t / w) | 0, hp: 1, state: 0, target: t, targetOwner: 0, troops: { infantry: 100, armor: 400, artillery: 50 }, path: [], pathPos: 0, cargo: 0, home: t, mode: 'hold' });
      sx += t % w; sy += (t / w) | 0; n++;
    }
    placed[a] = pick.length;
  }
  s.warMemory = s.warMemory || [];
  s.warMemory.push(A, B, 1e9);
  const c = bf.camera();
  c.zoom = 12;
  c.x = sx / n;
  c.y = sy / n;
  return { placed, cam: { x: c.x, y: c.y, zoom: c.zoom } };
}, { A: border.a, B: border.b, PER_SIDE });

const sampleFrames = (ms) => page.evaluate((ms) => new Promise((res) => {
  const d = [];
  let last = performance.now();
  const end = last + ms;
  const f = (t) => { d.push(t - last); last = t; if (t < end) requestAnimationFrame(f); else res(d); };
  requestAnimationFrame(f);
}), ms);
const keepCam = (cam) => page.evaluate((cam) => { const c = window.__borderfall.camera(); c.x = cam.x; c.y = cam.y; c.zoom = cam.zoom; }, cam);

await keepCam(setup.cam);
await sampleFrames(10000); // warm-up
await page.evaluate(() => window.__borderfall.perf()); // reset the counters
const rsSamples = [];
const camTimer = setInterval(() => { keepCam(setup.cam).catch(() => {}); page.evaluate(() => { const r = window.__borderfall.renderStats(); return { shots: r.tankShots, fx: r.msFx, units: r.units }; }).then((r) => rsSamples.push(r), () => {}); }, 1000);
const d = await sampleFrames(20000);
clearInterval(camTimer);
const p = await page.evaluate(() => window.__borderfall.perf());
const live = await page.evaluate(() => { const s = window.__borderfall.getState(); return { tanks: s.units.filter((u) => u.type === 'tankDivision' && u.hp > 0).length, tick: s.tick, phase: s.phase }; });
const rs = await page.evaluate(() => window.__borderfall.renderStats());
if (process.argv.includes('--shot')) await page.screenshot({ path: label + '.png' });
const avg = (k) => +(rsSamples.reduce((a, r) => a + (r[k] ?? 0), 0) / Math.max(1, rsSamples.length)).toFixed(3);
const rsum = { samples: rsSamples.length, tankShotsAvg: avg('shots'), tankShotsMax: Math.max(0, ...rsSamples.map((r) => r.shots ?? 0)), msFxAvg: avg('fx'), units: rsSamples.at(-1)?.units };
d.sort((a, b) => a - b);
const q = (k) => d[Math.min(d.length - 1, Math.floor(d.length * k))];
const mean = d.reduce((a, b) => a + b, 0) / d.length;
console.log(JSON.stringify({
  label, gpu, frames: d.length, fps: +(1000 / mean).toFixed(1), frameMs: { mean: +mean.toFixed(2), p50: +q(0.5).toFixed(2), p95: +q(0.95).toFixed(2), p99: +q(0.99).toFixed(2) },
  perf: { sim: +p.sim.toFixed(3), render: +p.render.toFixed(3), hud: +p.hud.toFixed(3), frames: p.frames },
  setup: { border, placed: setup.placed, cam: setup.cam }, live,
  rsum, errors: errs.slice(0, 5),
}));
await browser.close();
