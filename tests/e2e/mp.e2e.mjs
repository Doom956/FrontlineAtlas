// End-to-end multiplayer test in real browsers (Playwright, not part of `npm test`).
//
//   npm run build && node tests/e2e/mp.e2e.mjs
//
// Starts the production server twice (PORT 8091 for a private game, 8092 with a 4 s public countdown), then:
// A creates a private lobby (a small map, Teams), B joins by code, both pick a team, A starts; both spawn by clicking the map and play
// for about a minute (attacks by clicking, builds through the HUD dispatch = intents); C joins as a spectator after
// the start. A, B and C must report identical hashState for the same turns, with no console errors. B then drops
// (page closed) and comes back (the page reload resumes the game: catchUp replay) and A loses its socket for a
// moment: hashes must match again. C's state is then broken on purpose: the server reports the desync, C shows
// the banner and its Reload replays the game until the hashes match again. Finally a public FFA lobby starts by itself after its countdown.
// Screenshots: /tmp/borderfall-shots/mp-*.png. Needs Playwright (global install is fine) and a built project.
import { spawn, execSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
let pw;
try {
  pw = require('playwright');
} catch {
  pw = createRequire(join(execSync('npm root -g').toString().trim(), 'x.js'))('playwright');
}

const OUT = '/tmp/borderfall-shots';
mkdirSync(OUT, { recursive: true });
const PLAY_SECONDS = Number(process.env.PLAY_SECONDS ?? 60);
const W = 1280;
const H = 800;
const errors = [];
const servers = [];
/** every page opened, for the failure report */
const allPages = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);

function fail(msg) {
  throw new Error(msg);
}

async function startServer(port, env = {}) {
  const proc = spawn('node', ['server-dist/index.js'], { env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  proc.stdout.on('data', (d) => process.env.VERBOSE && process.stdout.write(`[srv ${port}] ${d}`));
  proc.stderr.on('data', (d) => process.stderr.write(`[srv ${port} err] ${d}`));
  servers.push(proc);
  for (let k = 0; k < 100; k++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/health`);
      if (r.ok) return proc;
    } catch {
      /* not yet */
    }
    await sleep(100);
  }
  fail(`server on ${port} did not start`);
}

const browser = await pw.chromium.launch({ args: ['--use-gl=angle', '--enable-unsafe-swiftshader'] });

async function newClient(label, url) {
  const ctx = await browser.newContext({ viewport: { width: W, height: H } });
  const page = await openPage(ctx, label, url);
  return { label, ctx, page };
}
async function openPage(ctx, label, url) {
  const page = await ctx.newPage();
  allPages.push({ label, page });
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`[${label}] ${m.text()}`);
  });
  page.on('pageerror', (e) => errors.push(`[${label}] pageerror: ${e.message}`));
  await page.goto(url);
  await page.waitForFunction(() => !!window.__borderfall);
  return page;
}
const shot = async (page, name) => {
  await page.screenshot({ path: `${OUT}/mp-${name}.png` });
  log('shot', name);
};
const mpInfo = (page) => page.evaluate(() => window.__borderfall.mp());

async function setName(page, name) {
  await page.click('[data-test=menu-mp]');
  const input = page.locator('[data-test=mp-name]');
  await input.fill(name);
  await input.dispatchEvent('change');
  await page.waitForFunction(() => /online/i.test(document.querySelector('[data-test=net-status]')?.textContent ?? ''), null, { timeout: 10000 });
}

/** Waits until the page runs an online game whose state is built. */
async function waitGame(page, timeout = 30000) {
  await page.waitForFunction(() => {
    const m = window.__borderfall.mp();
    return !!m && window.__borderfall.turn() >= 0 && !document.querySelector('.menu:not(.hidden)');
  }, null, { timeout });
}

/** Clicks the map until our nation has a start (online: the spawn intent comes back in a turn). */
async function spawnByClick(page, side) {
  for (let attempt = 0; attempt < 12; attempt++) {
    const pt = await page.evaluate(
      ({ side, attempt, W, H }) => {
        const b = window.__borderfall;
        const s = b.getState();
        const cam = b.camera();
        const { width: w, height: h } = s.map;
        // candidate tiles on a grid in the open middle of the screen, our side first
        const out = [];
        for (let gy = 0.3; gy <= 0.7; gy += 0.05) {
          for (let gx = 0.25; gx <= 0.75; gx += 0.025) {
            const sx = side === 'left' ? W * gx * 0.9 + W * 0.05 : W * (1 - gx) * 0.9 + W * 0.05;
            const t = cam.screenToTile(sx, H * gy);
            const x = Math.floor(t.x);
            const y = Math.floor(t.y);
            if (x < 0 || y < 0 || x >= w || y >= h) continue;
            const i = y * w + x;
            if (s.map.terrain[i] <= 1 || s.map.owner[i] !== 0) continue;
            let near = false;
            for (const p of s.players) if (p.id && p.capital >= 0 && Math.hypot((p.capital % w) - x, Math.floor(p.capital / w) - y) < 26) near = true;
            if (!near) out.push({ x: sx, y: H * gy });
          }
        }
        return out[(attempt * 7) % Math.max(1, out.length)] ?? null;
      },
      { side, attempt, W, H },
    );
    if (!pt) fail('no land to spawn on');
    await page.mouse.click(pt.x, pt.y);
    await sleep(900);
    const ok = await page.evaluate(() => {
      const s = window.__borderfall.getState();
      return s.players[s.humanId].spawned;
    });
    if (ok) return pt;
  }
  fail('could not spawn');
}

/** One attack by clicking land next to our border (neutral land, a tribe or a nation). */
async function attackByClick(page) {
  const pt = await page.evaluate(({ W, H }) => {
    const b = window.__borderfall;
    const s = b.getState();
    const cam = b.camera();
    const me = s.humanId;
    const w = s.map.width;
    const cand = [];
    for (let i = 0; i < s.map.owner.length; i += 1) {
      if (s.map.owner[i] !== me) continue;
      for (const j of [i + 1, i - 1, i + w, i - w]) {
        if (j < 0 || j >= s.map.owner.length || s.map.owner[j] === me || s.map.terrain[j] <= 1) continue;
        const p = cam.tileToScreen((j % w) + 0.5, Math.floor(j / w) + 0.5);
        if (p.x > 280 && p.x < W - 280 && p.y > 140 && p.y < H - 190) cand.push(p);
      }
      if (cand.length > 400) break;
    }
    return cand.length ? cand[Math.floor(cand.length / 2)] : null;
  }, { W, H });
  if (pt) await page.mouse.click(pt.x, pt.y);
  return !!pt;
}

async function buildSomething(page) {
  return page.evaluate(() => {
    const b = window.__borderfall;
    const s = b.getState();
    const me = s.players[s.humanId];
    if (!me || me.capital < 0) return false;
    const kinds = ['city', 'farm', 'market'];
    const r = b.dispatch({ type: 'build', building: kinds[s.tick % 3], tile: me.capital + 3 });
    return r.ok;
  });
}

/** Turn -> hash maps of several pages; checks every common turn and returns how many there were. */
async function compareHashes(pages, minCommon = 3) {
  const maps = await Promise.all(pages.map((p) => p.evaluate(() => window.__borderfall.hashes())));
  const common = Object.keys(maps[0]).filter((t) => maps.every((m) => t in m));
  for (const t of common) {
    const vals = maps.map((m) => m[t]);
    if (new Set(vals).size !== 1) fail(`hash mismatch at turn ${t}: ${vals.join(' ')}`);
  }
  if (common.length < minCommon) fail(`only ${common.length} common hash turns (${maps.map((m) => Object.keys(m).length).join('/')})`);
  return common.map(Number).sort((a, b) => a - b);
}

let exitCode = 0;
try {
  // ------------------------------------------------------------------------------------------- private game
  await startServer(8091, { PUBLIC_START_SECONDS: '60' });
  const URL = 'http://127.0.0.1:8091/';
  const A = await newClient('A', URL);
  const B = await newClient('B', URL);
  await setName(A.page, 'Alice');
  await shot(A.page, 'list');
  await A.page.click('[data-test=mp-create]');
  await A.page.waitForSelector('[data-test=lobby-code]');
  const code = (await A.page.textContent('[data-test=lobby-code]')).trim();
  log('lobby', code);
  // the host changes a setting like in single player: a small map, 4 AI nations
  await A.page.locator('.setup-field:has(.form-label:text-is("Size")) .btn', { hasText: 'Small' }).click();
  await A.page.waitForFunction(() => /small/i.test(document.querySelector('.sum-main')?.textContent ?? ''));

  await setName(B.page, 'Bob');
  await B.page.fill('[data-test=mp-code]', code.toLowerCase());
  await B.page.click('[data-test=mp-join]');
  await B.page.waitForSelector('[data-test=lobby-players] li:nth-child(2)');
  await A.page.waitForSelector('[data-test=lobby-players] li:nth-child(2)');
  // B sees the host's settings, read-only
  await B.page.waitForFunction(() => /small/i.test(document.querySelector('.sum-main')?.textContent ?? ''));
  if (!(await B.page.locator('.menu-card.setup.readonly').count())) fail('guest settings are not read-only');
  await shot(B.page, 'lobby-guest');
  // a teams game: the host switches the mode, each player picks a team
  await A.page.locator('.mode-row .btn', { hasText: 'Teams' }).click();
  await B.page.waitForSelector('.team-seg [data-team="2"]');
  await A.page.click('.team-seg [data-team="1"]');
  await B.page.click('.team-seg [data-team="2"]');
  await A.page.waitForFunction(() => [...document.querySelectorAll('[data-test=lobby-players] .lp-team')].map((e) => e.textContent).join() === 'Blue,Red');
  await shot(A.page, 'lobby-host');

  await A.page.click('[data-test=mp-start]');
  await Promise.all([waitGame(A.page), waitGame(B.page)]);
  log('game started', await mpInfo(A.page), await mpInfo(B.page));
  const teams = await A.page.evaluate(() => window.__borderfall.getState().teams.slice(0, 3));
  if (teams.join() !== '0,1,2') fail(`teams not applied: ${teams}`);
  await shot(A.page, 'a-spawn');

  await Promise.all([spawnByClick(A.page, 'left'), spawnByClick(B.page, 'right')]);
  log('both spawned');

  // C watches (joins after the start)
  const C = await newClient('C', URL);
  await setName(C.page, 'Cy');
  await C.page.fill('[data-test=mp-code]', code);
  await C.page.click('[data-test=mp-watch]');
  await waitGame(C.page);
  const ci = await mpInfo(C.page);
  if (!ci.spectator) fail('C is not a spectator');
  log('C watching', ci);

  // play at server pace
  await A.page.waitForFunction(() => window.__borderfall.getState().phase === 'playing', null, { timeout: 30000 });
  const t0 = Date.now();
  let attacks = 0;
  let builds = 0;
  while (Date.now() - t0 < PLAY_SECONDS * 1000) {
    for (const p of [A.page, B.page]) {
      if (await attackByClick(p)) attacks++;
    }
    if ((Date.now() - t0) % 15000 < 4000) for (const p of [A.page, B.page]) if (await buildSomething(p)) builds++;
    await sleep(3500);
  }
  log(`played ${PLAY_SECONDS} s: ${attacks} attack clicks, ${builds} builds sent`);
  const st = await A.page.evaluate(() => {
    const s = window.__borderfall.getState();
    return { tick: s.tick, a: s.players[1].tiles, b: s.players[2].tiles, attacks: s.attacks.length, buildings: s.buildings.size };
  });
  log('state', st);
  if (st.a < 50 || st.b < 50) fail('players did not grow');
  const common1 = await compareHashes([A.page, B.page, C.page], 20);
  log(`A, B, C agree on ${common1.length} hash turns (${common1[0]}..${common1[common1.length - 1]})`);
  await shot(A.page, 'a-game');
  await shot(B.page, 'b-game');
  await shot(C.page, 'c-spectator');

  // B drops (page closed) and comes back: the reload resumes the game and replays it from the catchUp
  await B.page.close();
  await sleep(4000);
  B.page = await openPage(B.ctx, 'B2', URL);
  await waitGame(B.page);
  await B.page.waitForFunction(() => {
    const m = window.__borderfall.mp();
    return m && m.behind === 0 && m.nextTurn > 0;
  }, null, { timeout: 60000 });
  log('B back', await mpInfo(B.page));
  // A's socket drops like a network failure: it reconnects by itself and fills the gap
  await A.page.evaluate(() => window.__borderfall.dropConnection());
  await sleep(6000);
  for (const p of [A.page, B.page]) await attackByClick(p);
  await sleep(6000);
  const aInfo = await mpInfo(A.page);
  if (aInfo.status !== 'online') fail(`A did not reconnect: ${aInfo.status}`);
  const common2 = await compareHashes([A.page, B.page, C.page], 5);
  if (common2[common2.length - 1] <= common1[common1.length - 1]) fail('no new common hashes after the reconnect');
  log(`after reconnects: agree on ${common2.length} turns up to ${common2[common2.length - 1]}`);
  const desync = await Promise.all([A.page, B.page, C.page].map((p) => p.evaluate(() => window.__borderfall.mp().desync)));
  if (desync.some(Boolean)) fail('a client was told it desynced');
  await shot(B.page, 'b-rejoined');

  // a forced desync on C: the server's vote tells C, C shows the banner, Reload rebuilds the game from the turns
  await C.page.evaluate(() => {
    window.__borderfall.getState().players[1].gold += 12345;
  });
  await C.page.waitForSelector('[data-test=mp-banner]:not(.hidden) [data-test=mp-reload]:not(.hidden)', { timeout: 30000 });
  await shot(C.page, 'c-desync');
  await C.page.click('[data-test=mp-reload]');
  await C.page.waitForFunction(() => {
    const m = window.__borderfall.mp();
    return m && !m.desync && m.behind === 0 && m.nextTurn > 100;
  }, null, { timeout: 90000 });
  await sleep(4000);
  const before = common2[common2.length - 1];
  const common3 = await compareHashes([A.page, B.page, C.page], 2);
  if (common3[common3.length - 1] <= before) fail('no common hashes after the desync reload');
  log(`desync reload: C agrees again up to turn ${common3[common3.length - 1]}`);
  for (const c of [A, B, C]) await c.ctx.close();

  // ------------------------------------------------------------------------------------------- public FFA
  await startServer(8092, { PUBLIC_START_SECONDS: '4' });
  const D = await newClient('D', 'http://127.0.0.1:8092/');
  await setName(D.page, 'Dee');
  await D.page.waitForSelector('[data-test=join-ffa]');
  await D.page.waitForSelector('.lob-row.kind-special .mod-chip');
  await shot(D.page, 'public-list');
  await D.page.click('[data-test=join-ffa]');
  await D.page.waitForSelector('.lobby-when');
  await shot(D.page, 'public-lobby');
  await waitGame(D.page, 40000);
  await D.page.waitForFunction(() => window.__borderfall.turn() > 20, null, { timeout: 30000 });
  log('public FFA started by itself', await mpInfo(D.page));
  await shot(D.page, 'public-game');
  await D.ctx.close();

  if (errors.length) fail(`console errors:\n${errors.join('\n')}`);
  log('PASS');
} catch (err) {
  console.error('FAIL:', err.message);
  for (const { label, page } of allPages) {
    if (page.isClosed()) continue;
    try {
      await page.screenshot({ path: `${OUT}/mp-fail-${label}.png` });
      console.error(label, JSON.stringify(await page.evaluate(() => window.__borderfall?.mp?.() ?? null)), await page.evaluate(() => window.__borderfall?.turn?.()));
    } catch (e) {
      console.error(label, 'no report:', e.message);
    }
  }
  if (errors.length) console.error(errors.join('\n'));
  exitCode = 1;
} finally {
  await browser.close();
  for (const s of servers) s.kill();
}
process.exit(exitCode);
