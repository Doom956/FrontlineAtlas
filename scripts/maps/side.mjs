// node side.mjs <out.png> <height> <img1> <img2> [img3...]: the images side by side at the same height
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
const { chromium } = createRequire(import.meta.url)('playwright');
const [out, h, ...imgs] = process.argv.slice(2);
const html = `<html><body style="margin:0;background:#222;display:flex;gap:8px">${imgs.map((i) => `<img src="${pathToFileURL(i).href}" style="height:${h}px">`).join('')}</body></html>`;
const tmp = join(dirname(out), '_side.html');
writeFileSync(tmp, html);
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 400, height: Number(h) } });
await p.goto(pathToFileURL(tmp).href);
await p.waitForLoadState('load');
const w = await p.evaluate(() => document.body.scrollWidth);
await p.setViewportSize({ width: w, height: Number(h) });
await p.screenshot({ path: out });
await b.close();
