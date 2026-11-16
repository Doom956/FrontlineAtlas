// CPU used by Chromium's main (browser) process vs its children while a page runs.
//   node browsercpu.mjs <dist/index.html> <blank|game> [seconds=70] [map=europe]
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { execSync } from 'node:child_process';
const { chromium } = createRequire(import.meta.url)('playwright');
const [dist, mode = 'game', secArg, map = 'europe'] = process.argv.slice(2);
const secs = Number(secArg ?? 70) || 70;
const browser = await chromium.launch({ args: ['--ignore-gpu-blocklist', '--enable-gpu', '--use-angle=d3d11'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
if (mode === 'game') {
  await page.goto(pathToFileURL(resolve(dist)).href);
  await page.waitForFunction(() => !!window.__borderfall, null, { timeout: 30000 });
  await page.evaluate((map) => window.__borderfall.startGame({ seed: 7, map: { kind: 'world', id: map } }), map);
  await page.waitForFunction(() => window.__borderfall.getState()?.phase === 'spawn', null, { timeout: 60000 });
  await page.evaluate(() => {
    const bf = window.__borderfall, s = bf.getState(), w = s.map.width;
    for (let t = (s.map.height >> 1) * w + (w >> 1); t < s.map.terrain.length; t += 37) if (s.map.terrain[t] > 1 && bf.dispatch({ type: 'spawn', tile: t })?.ok) break;
    bf.dispatch({ type: 'startNow' });
  });
} else await page.goto('about:blank');
// the browser process: the chrome process whose parent is this node process
const ps = (q) => execSync(`powershell -NoProfile -Command "${q}"`, { encoding: 'utf8' }).trim();
const root = ps(`(Get-CimInstance Win32_Process -Filter 'ParentProcessId=${process.pid}' | Where-Object Name -like '*chrom*' | Select-Object -First 1).ProcessId`);
const cpu = () => JSON.parse(ps(`$k = Get-CimInstance Win32_Process -Filter 'ParentProcessId=${root}'; $r = Get-Process -Id ${root}; $c = @{}; foreach ($p in $k) { $t = if ($p.CommandLine -match '--type=([\w-]+)') { $Matches[1] } else { 'other' }; $g = Get-Process -Id $p.ProcessId -ErrorAction SilentlyContinue; if ($g) { $c[$t] = [double]($c[$t]) + $g.CPU } }; $c['browser'] = $r.CPU; $c | ConvertTo-Json -Compress`));
const save = mode === 'game' ? await page.evaluate(() => Object.keys(localStorage).map((k) => [k, localStorage.getItem(k).length])) : [];
const a = cpu();
await page.waitForTimeout(secs * 1000);
const b = cpu();
const pct = {};
for (const k of Object.keys(b)) pct[k] = +(((b[k] - (a[k] ?? 0)) / secs) * 100).toFixed(1);
const saveAfter = mode === 'game' ? await page.evaluate(() => Object.keys(localStorage).map((k) => [k, localStorage.getItem(k).length])) : [];
console.log(JSON.stringify({ mode, map, secs, cpuPercentOfOneCore: pct, storageBefore: save, storageAfter: saveAfter }));
await browser.close();
