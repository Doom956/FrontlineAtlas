// End-to-end test of watch-on-demand and the jumpscare (Playwright, not part of `npm test`).
//
//   npm run build && node tests/e2e/spectate.e2e.mjs
//
// One production server (ADMIN_CODE = a made-up code, PUBLIC_LOBBIES off). Then:
//  - page P plays a single-player game and makes a few moves (it links to the server on its own, spLink).
//  - page O (the owner) connects, unlocks the console with the made-up code, opens Games, and clicks Watch on P's
//    single-player card. O's screen rebuilds P's game from its streamed log and follows it live (the map advances).
//  - O sends a jumpscare and an announcement to that single-player game. P shows both; P never shows anything about
//    being watched; and P's game state (hashState) is unchanged by the owner's actions.
// Screenshots: /tmp/borderfall-shots/spectate-*.png and /tmp/borderfall-shots/jumpscare-*.png.
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
const CODE = 'made-up-spectate-code';
const PORT = Number(process.env.PORT ?? 8094);
const URL = `http://127.0.0.1:${PORT}/`;
const W = 1280;
const H = 800;
const errors = [];
const servers = [];
const allPages = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);
function fail(msg) {
  throw new Error(msg);
}

async function startServer(port) {
  const proc = spawn('node', ['server-dist/index.js'], {
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', ADMIN_CODE: CODE, PUBLIC_LOBBIES: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout.on('data', (d) => process.env.VERBOSE && process.stdout.write(`[srv] ${d}`));
  proc.stderr.on('data', (d) => process.stderr.write(`[srv err] ${d}`));
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

async function openPage(ctx, label) {
  const page = await ctx.newPage();
  allPages.push({ label, page });
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`[${label}] ${m.text()}`);
  });
  page.on('pageerror', (e) => errors.push(`[${label}] pageerror: ${e.message}`));
  await page.goto(URL);
  await page.waitForFunction(() => !!window.__borderfall);
  return page;
}
const shot = async (page, name) => {
  await page.screenshot({ path: `${OUT}/${name}.png` });
  log('shot', name);
};

/** The owner page: set a name on the multiplayer screen (connects the socket), then unlock the console. */
async function unlockConsole(page) {
  await page.click('[data-test=menu-mp]');
  const input = page.locator('[data-test=mp-name]');
  await input.fill('Boss');
  await input.dispatchEvent('change');
  await page.waitForFunction(() => /online/i.test(document.querySelector('[data-test=net-status]')?.textContent ?? ''), null, { timeout: 15000 });
  // leave the name field so the hotkey is not swallowed as typing, then open the hidden terminal line
  await page.evaluate(() => document.activeElement && document.activeElement.blur && document.activeElement.blur());
  await page.mouse.move(W / 2, H / 2);
  await sleep(200);
  // "|" = Shift+Backslash, type the made-up code, Enter
  await page.keyboard.down('Shift');
  await page.keyboard.press('Backslash');
  await page.keyboard.up('Shift');
  await page.waitForSelector('[data-test=terminal-line]:not(.hidden)');
  await page.fill('[data-test=terminal-line] input', CODE);
  await page.keyboard.press('Enter');
  await page.waitForSelector('[data-test=admin-console]:not(.hidden)', { timeout: 15000 });
}

/** Spawns the single-player nation by dispatching a spawn on open neutral land. */
async function spawnSP(page) {
  const ok = await page.evaluate(() => {
    const b = window.__borderfall;
    const s = b.getState();
    const w = s.map.width;
    const near = (i) => s.players.some((p) => p && p.id && p.capital >= 0 && Math.hypot((p.capital % w) - (i % w), Math.floor(p.capital / w) - Math.floor(i / w)) < 14);
    for (let i = 0; i < s.map.terrain.length; i++) {
      if (s.map.terrain[i] > 1 && s.map.owner[i] === 0 && !near(i)) {
        if (b.dispatch({ type: 'spawn', tile: i }).ok) return true;
      }
    }
    return false;
  });
  return ok;
}

let exitCode = 0;
try {
  await startServer(PORT);
  const ctxP = await browser.newContext({ viewport: { width: W, height: H } });
  const ctxO = await browser.newContext({ viewport: { width: W, height: H } });
  const P = await openPage(ctxP, 'P');
  const O = await openPage(ctxO, 'O');

  // ---- P plays a single player game and makes a few moves
  await P.evaluate(() => window.__borderfall.startGame({ seed: 7, difficulty: 'easy' }));
  await P.waitForFunction(() => window.__borderfall.turn() >= 0 && !!window.__borderfall.getState() && !document.querySelector('.menu:not(.hidden)'), null, { timeout: 30000 });
  if (!(await spawnSP(P))) fail('P could not spawn');
  await P.evaluate(() => window.__borderfall.advance(60));
  await P.evaluate(() => {
    const b = window.__borderfall;
    const s = b.getState();
    const me = s.players[s.humanId];
    if (me && me.capital >= 0) for (const k of ['city', 'farm']) b.dispatch({ type: 'build', building: k, tile: me.capital + 3 });
  });
  await P.evaluate(() => window.__borderfall.advance(40));
  const pTick = await P.evaluate(() => window.__borderfall.turn());
  log('P single-player game at tick', pTick);
  await shot(P, 'spectate-player');

  // ---- O unlocks the console and watches P's single-player game
  await unlockConsole(O);
  log('owner console unlocked');
  // the Games tab opens by default online; wait for P's single-player card
  await O.waitForSelector('[data-test^=adm-sp-watch-]', { timeout: 20000 });
  await shot(O, 'spectate-console');
  await O.click('[data-test^=adm-sp-watch-]');
  // O's screen rebuilds the game and advances
  await O.waitForFunction(() => window.__borderfall.turn() > 0 && !!window.__borderfall.getState() && !document.querySelector('.menu:not(.hidden)'), null, { timeout: 40000 });
  const oTick1 = await O.evaluate(() => window.__borderfall.turn());
  await sleep(2500);
  const oTick2 = await O.evaluate(() => window.__borderfall.turn());
  if (!(oTick2 > oTick1)) fail(`owner watch is not advancing (${oTick1} -> ${oTick2})`);
  log('owner watching, tick', oTick1, '->', oTick2);
  await shot(O, 'spectate-watch');

  // ---- P is paused so its state can be compared across the owner's actions
  await P.evaluate(() => {
    const ui = window.__borderfall.ui();
    if (ui) ui.paused = true;
  });
  await sleep(300);
  const hashBefore = await P.evaluate(() => window.__borderfall.hash());

  // ---- O sends a jumpscare and an announcement to that single-player game (all single-player games)
  await O.keyboard.down('Shift');
  await O.keyboard.press('Backslash');
  await O.keyboard.up('Shift');
  await O.waitForSelector('[data-test=admin-console]:not(.hidden)');
  // Effects tab -> target all single-player games -> a long-ish jumpscare so it is clearly captured
  await O.click('.adm-tab:text-is("Effects")');
  await O.selectOption('[data-test=adm-where]', 'spAll');
  await O.selectOption('[aria-label="Prank length"]', '8').catch(() => {});
  await O.click('[data-test=adm-prank-jumpscare]');
  log('owner sent a jumpscare');
  // the watched page shows the jumpscare (and it is the harsh variant: full-screen flash)
  await P.waitForSelector('[data-test=bc-jump].on', { timeout: 8000 });
  await sleep(500);
  await shot(P, 'jumpscare-player');
  // Announce tab -> target all single-player games -> send
  await O.click('.adm-tab:text-is("Announce")');
  await O.selectOption('[data-test=adm-where]', 'spAll');
  await O.fill('[data-test=adm-ann-text]', 'A message from the server');
  await O.click('.adm-btn.go.wide:has-text("Send announcement")');
  await P.waitForSelector('[data-test=bc-announcement]', { timeout: 8000 });
  await shot(P, 'jumpscare-announce');

  // ---- the watched game is unchanged, and nothing on P says it is watched
  await sleep(500);
  const hashAfter = await P.evaluate(() => window.__borderfall.hash());
  if (hashAfter !== hashBefore) fail(`watched game changed under an owner action: ${hashBefore} -> ${hashAfter}`);
  log('watched game hash unchanged by owner actions:', hashAfter);
  const leak = await P.evaluate(() => {
    const t = document.body.innerText || '';
    const m = t.match(/being watched|someone is watching|you are watched|spectated by|owner console|admin console/i);
    return m ? m[0] : null;
  });
  if (leak) fail(`P shows that it is watched: "${leak}"`);
  // the jumpscare clears itself within a couple of seconds
  await P.waitForFunction(() => document.querySelector('[data-test=bc-jump]')?.classList.contains('hidden'), null, { timeout: 8000 });
  log('jumpscare cleared itself');
  await shot(O, 'spectate-live');

  if (errors.length) fail(`console errors:\n${errors.join('\n')}`);
  log('PASS');
} catch (err) {
  console.error('FAIL:', err.message);
  for (const { label, page } of allPages) {
    if (page.isClosed()) continue;
    try {
      await page.screenshot({ path: `${OUT}/spectate-fail-${label}.png` });
      console.error(label, JSON.stringify(await page.evaluate(() => ({ turn: window.__borderfall?.turn?.(), hasState: !!window.__borderfall?.getState?.() }))));
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
