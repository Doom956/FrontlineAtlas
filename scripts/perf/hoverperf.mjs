// Frame times while the mouse sweeps over HUD buttons vs resting, on the real GPU.
//   node hoverperf.mjs <dist/index.html> <variant: base|noblur|nohover> [map=europe]
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
const { chromium } = createRequire(import.meta.url)('playwright');
const [dist, variant = 'base', map = 'europe'] = process.argv.slice(2);
const browser = await chromium.launch({ args: ['--ignore-gpu-blocklist', '--enable-gpu', '--use-angle=d3d11', ...(process.env.VSYNC ? [] : ['--disable-gpu-vsync', '--disable-frame-rate-limit'])] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
await page.goto(pathToFileURL(resolve(dist)).href);
await page.waitForFunction(() => !!window.__borderfall, null, { timeout: 30000 });
await page.evaluate((map) => window.__borderfall.startGame({ seed: 7, map: { kind: 'world', id: map } }), map);
await page.waitForFunction(() => window.__borderfall.getState()?.phase === 'spawn', null, { timeout: 60000 });
await page.evaluate(() => {
  const bf = window.__borderfall, s = bf.getState(), w = s.map.width;
  for (let t = (s.map.height >> 1) * w + (w >> 1); t < s.map.terrain.length; t += 37) if (s.map.terrain[t] > 1 && bf.dispatch({ type: 'spawn', tile: t })?.ok) break;
  bf.dispatch({ type: 'startNow' });
  bf.advance(600);
});
if (variant === 'noblur') await page.addStyleTag({ content: '*{backdrop-filter:none!important;-webkit-backdrop-filter:none!important}' });
if (variant === 'nohover') await page.addStyleTag({ content: '*{transition:none!important}' });
await page.waitForTimeout(1500);
const targets = await page.evaluate(() => [...document.querySelectorAll('button')].map((b) => b.getBoundingClientRect()).filter((r) => r.width > 10 && r.height > 10 && r.top >= 0 && r.bottom <= innerHeight && r.width < 200).map((r) => [r.left + r.width / 2, r.top + r.height / 2]).slice(0, 40));
await page.evaluate(() => { window.__ev = []; new PerformanceObserver((l) => window.__ev.push(...l.getEntries().map((e) => ({ n: e.name, d: e.duration, p: e.processingEnd - e.processingStart, i: e.processingStart - e.startTime, pr: e.startTime + e.duration - e.processingEnd })))).observe({ type: 'event', durationThreshold: 16, buffered: false }); });
const sample = (ms) => page.evaluate((ms) => new Promise((res) => { const d = []; let last = performance.now(); const end = last + ms; const f = (t) => { d.push(t - last); last = t; if (t < end) requestAnimationFrame(f); else res(d); }; requestAnimationFrame(f); }), ms);
const stats = (d) => { d.sort((a, b) => a - b); const q = (k) => +d[Math.min(d.length - 1, Math.floor(d.length * k))].toFixed(1); const m = d.reduce((a, b) => a + b, 0) / d.length; return { fps: +(1000 / m).toFixed(0), p50: q(0.5), p95: q(0.95), max: q(1) }; };
await page.mouse.move(720, 450);
const rest = stats(await sample(4000));
let stop = false;
const sweep = (async () => { let k = 0; while (!stop) { const [x, y] = targets[k++ % targets.length]; await page.mouse.move(x, y, { steps: 4 }); await page.waitForTimeout(40); } })();
const hover = stats(await sample(4000));
stop = true; await sweep;
const ev = await page.evaluate(() => window.__ev);
const med = (a) => { a.sort((x, y) => x - y); return +a[a.length >> 1].toFixed(1); }; const slowEv = ev.length ? { inputDelayMed: med(ev.map((e) => e.i)), inputDelayMax: +Math.max(...ev.map((e) => e.i)).toFixed(0), presentMed: med(ev.map((e) => e.pr)), presentMax: +Math.max(...ev.map((e) => e.pr)).toFixed(0), count: ev.length, worst: +Math.max(...ev.map((e) => e.d)).toFixed(0), worstJs: +Math.max(...ev.map((e) => e.p)).toFixed(1), kinds: [...new Set(ev.map((e) => e.n))].join(',') } : 'none';
console.log(JSON.stringify({ variant, map, buttons: targets.length, rest, hover, slowEvents: slowEv }));
await browser.close();
