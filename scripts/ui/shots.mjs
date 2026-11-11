// Shared screenshot pass for the UI redesign: the same screens, state and map for every design direction.
//
//   node shots.mjs <path to dist/index.html> <output dir> [--only 05,06] [--timing]
//
// Drives the real single-file build through window.__borderfall and real clicks. Selects by data-test, aria-label
// and role only (never by colour, class or layout), so a restyle does not break it. Where a screen needs state
// (gold, techs, buildings, units, an alert) it writes to the page's game state: this tool only, never the game.
//
// Repeatable: a fixed game seed, a seeded Math.random (the menu's background map, the setup screen's seed) and a
// controlled page clock. The page's time stands still except when this script steps it, so the sim runs the same
// number of ticks before every picture on any machine, and toasts do not expire while a slow frame is drawn.
//
// Prints each file as written. Exit code 1 if a required screen failed (the message names the selector), 0 else.
// Optional screens that fail are listed and skipped. A full pass takes about 100 s (software WebGL).
//
// --only 13,21 writes just those pictures (quick checks while restyling). A partial pass plays a few ticks fewer
// than a full one, so compare designs on full passes only. --timing prints the seconds each picture took.
// One pass at a time on a shared machine: it runs one headless Chromium and closes it at the end.
import { createRequire } from 'node:module';
import { mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
let pw;
try {
  pw = require('playwright');
} catch {
  pw = createRequire('/opt/node-tools/node_modules/x.js')('playwright');
}

const argv = process.argv.slice(2);
const flags = argv.filter((a) => a.startsWith('--'));
const onlyAt = argv.indexOf('--only');
const onlyArg = onlyAt >= 0 ? argv[onlyAt + 1] ?? '' : '';
const [distArg, outArg] = argv.filter((a, k) => !a.startsWith('--') && !(onlyAt >= 0 && k === onlyAt + 1));
if (!distArg || !outArg) {
  console.error('usage: node shots.mjs <path to dist/index.html> <output dir> [--only 05,06] [--timing]');
  process.exit(2);
}
const DIST = resolve(distArg);
const OUT = resolve(outArg);
if (!existsSync(DIST)) {
  console.error(`not found: ${DIST}`);
  process.exit(2);
}
mkdirSync(OUT, { recursive: true });
const ONLY = onlyArg ? onlyArg.split(',').map((s) => s.trim()) : null;
const TIMING = flags.includes('--timing');
const want = (id) => !ONLY || ONLY.includes(id);
const wantFrom = (id) => !ONLY || ONLY.some((x) => x >= id);

const SEED = 4242;
const GAME = { seed: SEED, map: { kind: 'generated', type: 'continents', size: 'small' }, aiCount: 7, difficulty: 'easy', playerName: 'Atlas', playerColor: [64, 160, 255] };
const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };
const T0 = Date.UTC(2026, 2, 1, 12, 0, 0);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const failures = [];
const skipped = [];
const pageErrors = [];
let lastMark = Date.now();

// ------------------------------------------------------------------------------------------------ page helpers

/** A seeded Math.random (mulberry32) before any page script: the menu's background map and seeds repeat. */
const SEEDED_RANDOM = `(() => { let a = 0x9e3779b9; Math.random = () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; })();`;

async function openPage(browser, viewport, phone = false) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: phone ? 2 : 1, isMobile: phone, hasTouch: phone, reducedMotion: 'no-preference' });
  await ctx.addInitScript(SEEDED_RANDOM);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => pageErrors.push(String(e)));
  // the page's clock (timers, animation frames, performance.now, Date) stands still unless frames() steps it
  await page.clock.install({ time: T0 });
  await page.clock.pauseAt(T0 + 1000);
  await page.goto(pathToFileURL(DIST).href);
  await page.waitForFunction(() => !!window.__borderfall, null, { timeout: 30000 });
  return { ctx, page };
}

/** Steps the page clock: n animation frames, `ms` apart (100 ms = one sim tick at speed x1). */
async function frames(page, n = 1, ms = 250) {
  for (let k = 0; k < n; k++) await page.clock.fastForward(ms);
}

/** Fonts loaded, a few frames drawn, then a short real rest for CSS transitions. */
async function settle(page, { n = 3, ms = 250, rest = 350 } = {}) {
  await page.evaluate(() => document.fonts.ready.then(() => true, () => true));
  await frames(page, n, ms);
  await sleep(rest);
}

const isVisible = (page, selector) =>
  page
    .evaluate((sel) => {
      for (const n of document.querySelectorAll(sel)) {
        if (!n.getClientRects().length) continue;
        const cs = getComputedStyle(n);
        if (cs.visibility !== 'hidden' && cs.display !== 'none') return true;
      }
      return false;
    }, selector)
    .catch(() => false);

/** Waits (stepping frames) until a match of the selector is visible; the error names the selector. */
async function need(page, selector, what, tries = 10) {
  for (let k = 0; k < tries; k++) {
    if (await isVisible(page, selector)) return page.locator(`${selector} >> visible=true`).first();
    await frames(page, 1, 250);
    await sleep(60);
  }
  throw new Error(`${what}: selector not found or not visible: ${selector}`);
}
async function click(page, selector, what) {
  const loc = await need(page, selector, what);
  try {
    await loc.click({ timeout: 4000 });
  } catch {
    // something small overlaps it (a hint card, a toast): the click still belongs to this control
    await loc.evaluate((n) => n.click());
  }
  await frames(page, 1, 250);
}

/**
 * One screenshot: `prep` sets the screen up, then a few frames and the picture. Time only moves inside frames() and
 * advance(), so nothing drifts between runs.
 */
async function shot(page, name, prep, { optional = false, n = 3, ms = 250, rest = 350, alsoFor = [] } = {}) {
  const wanted = want(name.slice(0, 2));
  if (!wanted && !alsoFor.some(want)) return; // alsoFor: a later picture that needs this one's screen
  const file = join(OUT, `${name}.png`);
  try {
    if (prep) await prep();
    await settle(page, { n, ms, rest });
    if (!wanted) return;
    await page.screenshot({ path: file });
    console.log(TIMING ? `${file}  (+${((Date.now() - lastMark) / 1000).toFixed(1)} s)` : file);
  } catch (err) {
    const msg = `${name}: ${err && err.message ? err.message.split('\n')[0] : err}`;
    (optional ? skipped : failures).push(msg);
    console.log(`${optional ? 'SKIPPED (optional)' : 'FAILED'} ${msg}`);
  }
  lastMark = Date.now();
}

// ------------------------------------------------------------------------------------------------ game helpers
// The functions passed to page.evaluate run inside the page: plain reads of the state, or writes for this tool only.

const adv = (page, n) => page.evaluate((n) => window.__borderfall.advance(n), n);
const dispatch = (page, a) => page.evaluate((a) => window.__borderfall.dispatch(a), a);
const isNation = `(q) => q.id && q.alive && q.personality !== null && !String(q.name).startsWith('Tribe')`;

/** Start tile: free land with coast near and room around it, away from the other capitals. */
function pickSpawn() {
  const s = window.__borderfall.getState();
  const { width: w, height: h } = s.map;
  const T = s.map.terrain, OWN = s.map.owner, COAST = s.map.coastal;
  const caps = s.players.filter((p) => p.id && p.capital >= 0).map((p) => [p.capital % w, Math.floor(p.capital / w)]);
  let best = -1, bs = -1;
  // away from the map's edge, so the first pictures are all map
  for (let y = 100; y < h - 100; y += 4) for (let x = 130; x < w - 130; x += 4) {
    const i = y * w + x;
    if (T[i] <= 1 || OWN[i] !== 0) continue;
    if (caps.some(([cx, cy]) => Math.hypot(cx - x, cy - y) < 40)) continue;
    let land = 0, coast = 0, water = 0;
    for (let dy = -24; dy <= 24; dy += 3) for (let dx = -24; dx <= 24; dx += 3) {
      const j = (y + dy) * w + (x + dx);
      if (T[j] > 1) { land++; if (COAST[j]) coast++; } else water++;
    }
    if (!coast || water < 30) continue;
    const score = land - Math.abs(water - 80) * 0.5;
    if (score > bs) { bs = score; best = i; }
  }
  return best;
}

/** Grows the player's land: a big army and an attack on each neighbour that is free land or a tribe. */
function growStep(troops) {
  const b = window.__borderfall;
  const s = b.getState();
  const me = s.humanId;
  const p = s.players[me];
  p.troops.infantry = Math.max(p.troops.infantry, troops);
  const w = s.map.width;
  const seen = new Set();
  for (let i = 0; i < s.map.owner.length; i += 3) {
    if (s.map.owner[i] !== me) continue;
    for (const d of [1, -1, w, -w]) {
      const j = i + d;
      if (j < 0 || j >= s.map.owner.length) continue;
      const o = s.map.owner[j];
      if (o === me || s.map.terrain[j] <= 1 || seen.has(o)) continue;
      if (o !== 0 && !String(s.players[o].name).startsWith('Tribe')) continue; // leave the nations alone
      seen.add(o);
      b.dispatch({ type: 'attack', tile: j, troops: { infantry: troops / 12, armor: 0, artillery: 0 } });
      if (seen.size >= 10) return seen.size;
    }
  }
  return seen.size;
}

/** Riches, armor for tank divisions and every tech the screens need (tool only). */
function enrich() {
  const s = window.__borderfall.getState();
  const p = s.players[s.humanId];
  p.gold = 64000;
  p.iron = 5200;
  p.oil = 4100;
  p.science = 900;
  p.troops.armor = Math.max(p.troops.armor, 60000);
  p.troops.artillery = Math.max(p.troops.artillery, 20000);
  for (const t of ['agriculture', 'medicine', 'metallurgy', 'logistics', 'fortification', 'navigation', 'banking', 'mechanization', 'ballistics', 'flight', 'radar', 'rocketry', 'destroyers', 'battleships', 'reconPlanes'])
    if (!p.techs.includes(t)) p.techs.push(t);
  // the top-right clock counts real play time: here the game's own time, so it reads like a game this far in
  window.__borderfall.ui().playRealMs = ((s.tick - s.playStartTick) / 10) * 1000;
  return p.techs.length;
}

/** A free own tile at least `gap` tiles from every building, nearest to (x, y); coastal ones for ports. */
function siteNear({ x, y, coastal, gap }) {
  const s = window.__borderfall.getState();
  const me = s.humanId;
  const w = s.map.width;
  const bs = [...s.buildings.values()].map((b) => [b.tile % w, Math.floor(b.tile / w)]);
  let best = -1, bd = 1e9;
  for (let i = 0; i < s.map.owner.length; i++) {
    if (s.map.owner[i] !== me || s.map.terrain[i] <= 1 || s.map.building[i] !== 0 || s.map.fallout[i] > 0) continue;
    if (coastal && !s.map.coastal[i]) continue;
    const tx = i % w, ty = Math.floor(i / w);
    const d = Math.hypot(tx - x, ty - y);
    if (d >= bd) continue;
    if (bs.some(([bx, by]) => Math.hypot(bx - tx, by - ty) < gap)) continue;
    bd = d;
    best = i;
  }
  return best;
}

const facts = (page) =>
  page.evaluate(() => {
    const s = window.__borderfall.getState();
    const me = s.humanId;
    const p = s.players[me];
    const w = s.map.width;
    const xy = (t) => ({ x: t % w, y: Math.floor(t / w) });
    return {
      me,
      tiles: p.tiles,
      cap: xy(p.capital),
      w,
      h: s.map.height,
      tick: s.tick,
      phase: s.phase,
      buildings: [...s.buildings.values()].filter((b) => b.owner === me).map((b) => ({ type: b.type, tile: b.tile, ...xy(b.tile) })),
      units: s.units.filter((u) => u.owner === me).map((u) => ({ id: u.id, type: u.type, x: u.x, y: u.y, variant: u.variant ?? null })),
    };
  });

/**
 * An enemy or tribe land tile to fly at (tool only): the one whose distance from (x, y) is nearest to `want` tiles,
 * or with `toward` the one at least `want` tiles away whose direction is nearest to the direction of that point.
 */
function tileAtDistance({ x, y, want, nationsOnly, toward }) {
  const s = window.__borderfall.getState();
  const me = s.humanId;
  const w = s.map.width;
  const aim = toward ? Math.atan2(toward.y - y, toward.x - x) : 0;
  let best = -1, bd = 1e9;
  for (let i = 0; i < s.map.owner.length; i += 5) {
    const o = s.map.owner[i];
    if (o === 0 || o === me || s.map.terrain[i] <= 1) continue;
    if (nationsOnly && String(s.players[o].name).startsWith('Tribe')) continue;
    const dx = (i % w) - x, dy = Math.floor(i / w) - y;
    const dist = Math.hypot(dx, dy);
    let d;
    if (toward) {
      if (dist < want) continue;
      d = Math.abs(Math.atan2(Math.sin(Math.atan2(dy, dx) - aim), Math.cos(Math.atan2(dy, dx) - aim)));
    } else d = Math.abs(dist - want);
    if (d < bd) { bd = d; best = i; }
  }
  return best;
}

const setCamera = (page, x, y, zoom) =>
  page.evaluate(({ x, y, zoom }) => {
    const c = window.__borderfall.camera();
    c.zoom = zoom;
    c.x = x;
    c.y = y;
  }, { x, y, zoom });

/** Screen position (page px) of a tile's centre. */
const tilePos = (page, tile) =>
  page.evaluate((t) => {
    const c = window.__borderfall.camera();
    const s = window.__borderfall.getState();
    const p = c.tileToScreen((t % s.map.width) + 0.5, Math.floor(t / s.map.width) + 0.5);
    return { x: Math.round(p.x), y: Math.round(p.y) };
  }, tile);

/** Takes the pointer off the map (no hover card on the next picture). */
async function parkMouse(page) {
  await page.mouse.move(2, 2).catch(() => {});
  await page.evaluate(() => {
    for (const c of document.querySelectorAll('canvas')) c.dispatchEvent(new PointerEvent('pointerleave', { bubbles: false }));
    const u = window.__borderfall.ui?.();
    if (u) {
      u.hoverTile = -1;
      u.hoverPx = null;
    }
  });
}

/** Dismisses the toasts on screen through their own buttons (old news would cover the next picture). */
async function dismissToasts(page) {
  await frames(page, 1, 250); // a refused order shows its toast on the next frame
  await page.evaluate(() => {
    for (const b of document.querySelectorAll('[data-test=toast] button[aria-label="Dismiss"]')) b.click();
  });
  await frames(page, 2, 250);
}

/** Closes every open panel through its own close control and clears selections. */
async function closePanels(page) {
  await page.evaluate(() => {
    const u = window.__borderfall.ui();
    if (!u) return;
    u.mode = { kind: 'none' };
    u.selection = [];
    u.selectedTile = -1;
    u.contextMenu = null;
  });
  for (let k = 0; k < 4; k++) {
    const open = await page.evaluate(() => {
      const vis = (n) => !!n && n.getClientRects().length > 0;
      for (const sel of ['[data-test=build-menu]', '[data-test=spend-panel]', '[data-test=nation-card]', '[data-test=drawer]']) {
        const n = document.querySelector(sel);
        if (!vis(n)) continue;
        const x = n.querySelector('button[aria-label^="Close"]');
        if (x) {
          x.click();
          return sel;
        }
      }
      return '';
    });
    if (!open) break;
    await frames(page, 1, 250);
  }
  await dismissToasts(page);
  await parkMouse(page);
  await frames(page, 1, 250);
}

/** Writes a part of the page magnified `scale` times with hard pixels (unit art is only 8 to 10 px on screen). */
async function magnified(page, browser, clip, scale, file) {
  const buf = await page.screenshot({ clip });
  const ctx = await browser.newContext({ viewport: { width: 200, height: 200 } });
  const p = await ctx.newPage();
  const url = await p.evaluate(async ({ b64, w, h }) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const g = c.getContext('2d');
    g.imageSmoothingEnabled = false;
    g.drawImage(img, 0, 0, w, h);
    return c.toDataURL('image/png');
  }, { b64: buf.toString('base64'), w: Math.round(clip.width * scale), h: Math.round(clip.height * scale) });
  await ctx.close();
  writeFileSync(file, Buffer.from(url.split(',')[1], 'base64'));
}

async function startGame(page) {
  // not awaited inside the page: the start waits on timers, which only run when frames() steps the clock
  await page.evaluate((g) => void window.__borderfall.startGame(g), GAME);
  for (let k = 0; k < 150; k++) {
    await frames(page, 1, 100);
    if (await page.evaluate(() => !!window.__borderfall.getState())) break;
    await sleep(80);
  }
  await need(page, '[data-test=command-bar]', 'bottom command bar (the game did not start)', 20);
}

/** Spawn, then a few seconds of play. */
async function spawnAndOpen(page) {
  const tile = await page.evaluate(pickSpawn);
  if (tile < 0) throw new Error('no start tile found on this seed');
  const r = await dispatch(page, { type: 'spawn', tile });
  if (!r.ok) throw new Error(`spawn refused: ${r.reason}`);
  await dispatch(page, { type: 'startNow' });
  await adv(page, 40);
  // the top-right clock counts real play time: here the game's own time
  await page.evaluate(() => { const s = window.__borderfall.getState(); window.__borderfall.ui().playRealMs = (s.tick - s.playStartTick) * 100; });
  return tile;
}

/** Mid game: land, riches, one of each building near the capital, ships, tanks and aircraft. */
async function buildUp(page, { grow = 14, untilTick = 3200 } = {}) {
  for (let k = 0; k < grow; k++) {
    await page.evaluate(growStep, 600000);
    await adv(page, 120);
  }
  await page.evaluate(enrich);
  const f = await facts(page);
  const order = ['port', 'factory', 'airfield', 'silo', 'city', 'lab', 'market', 'farm', 'barracks', 'fort', 'sam', 'arsenal', 'watchtower', 'hospital', 'port'];
  const built = {};
  for (const type of order) {
    const tile = await page.evaluate(siteNear, { x: f.cap.x, y: f.cap.y, coastal: type === 'port', gap: 11 });
    if (tile < 0) continue;
    const r = await dispatch(page, { type: 'build', building: type, tile });
    if (r.ok && built[type] === undefined) built[type] = tile;
  }
  await adv(page, 200);
  await page.evaluate(enrich);
  const orders = [];
  if (built.port !== undefined) for (const variant of [undefined, 'battleship', undefined]) orders.push({ type: 'buildWarship', port: built.port, ...(variant ? { variant } : {}) });
  if (built.factory !== undefined) orders.push({ type: 'buildTankDivision', tile: built.factory });
  if (built.airfield !== undefined) for (const kind of ['bomber', 'bomber', 'bomber', 'bomber', 'fighter', 'fighter']) orders.push({ type: 'buildAircraft', airfield: built.airfield, kind });
  const refused = [];
  for (const o of orders) {
    const r = await dispatch(page, o);
    if (!r.ok) refused.push(`${o.type}: ${r.reason}`);
    await page.evaluate(enrich);
  }
  if (refused.length) console.log(`note: orders refused: ${[...new Set(refused)].join('; ')}`);
  // play on to a fixed tick (doctrines unlock five minutes in); the ships and the tank division are told to hold as
  // soon as they appear, so they are still by the port and the factory for the pictures
  for (;;) {
    const tick = await page.evaluate(() => {
      const s = window.__borderfall.getState();
      const ids = s.units.filter((u) => u.owner === s.humanId && u.type === 'warship' && u.stance !== 'hold').map((u) => u.id);
      if (ids.length) window.__borderfall.dispatch({ type: 'setUnitStance', unitIds: ids, stance: 'hold' });
      const tanks = s.units.filter((u) => u.owner === s.humanId && u.type === 'tankDivision' && u.mode !== 'hold').map((u) => u.id);
      if (tanks.length) window.__borderfall.dispatch({ type: 'setDivisionMode', unitIds: tanks, mode: 'hold' });
      return s.tick;
    });
    if (tick >= untilTick) break;
    await adv(page, Math.min(50, untilTick - tick));
  }
  await page.evaluate(enrich);
  return built;
}

/** A bomber raid, a recon flight, paratroopers and a rocket, all just off the ground for the picture. */
async function launchStrikes(page, built) {
  const out = {};
  const g = await facts(page);
  const xy = (t) => ({ x: t % g.w, y: Math.floor(t / g.w) });
  if (built.airfield !== undefined) {
    for (const wantDist of [70, 50, 35]) {
      const tile = await page.evaluate(tileAtDistance, { ...xy(built.airfield), want: wantDist, nationsOnly: false });
      if (tile < 0) continue;
      const r = await dispatch(page, { type: 'bomb', airfield: built.airfield, tile, count: 2 });
      out.bomb = r.ok ? `ok at ${wantDist}` : r.reason;
      if (r.ok) break;
    }
    const near = await page.evaluate(tileAtDistance, { ...xy(built.airfield), want: 45, nationsOnly: false });
    if (near >= 0) {
      const r = await dispatch(page, { type: 'reconFlight', airfield: built.airfield, tile: near });
      out.recon = r.ok ? 'ok' : r.reason;
    }
    const far = await page.evaluate(tileAtDistance, { ...xy(built.airfield), want: 90, nationsOnly: false });
    if (far >= 0) {
      const d = await dispatch(page, { type: 'paradrop', airfield: built.airfield, tile: far, troops: 4000 });
      out.paradrop = d.ok ? 'ok' : d.reason;
    }
  }
  if (built.silo !== undefined) {
    // a far target on the line over the port, so the rocket crosses the ships on its way out
    const toward = built.port !== undefined ? xy(built.port) : undefined;
    const tile = await page.evaluate(tileAtDistance, { ...xy(built.silo), want: 120, nationsOnly: true, toward });
    if (tile >= 0) {
      const r = await dispatch(page, { type: 'launchMissile', silo: built.silo, kind: 'rocket', tile, count: 1 });
      out.rocket = r.ok ? 'ok' : r.reason;
    }
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ the pass

const browser = await pw.chromium.launch({ args: ['--use-gl=angle', '--enable-unsafe-swiftshader'] });
const started = Date.now();

// ---------------------------------------------------------------------------------------------- desktop
if (!ONLY || ONLY.some((x) => x <= '18')) {
  const { ctx, page } = await openPage(browser, DESKTOP);

  await shot(page, '01-main-menu', async () => {
    await frames(page, 10, 250); // the background map draws; the map previews start
    await need(page, '[data-test=menu-play]', 'main menu Play button');
  });

  await shot(page, '02-setup', async () => {
    await click(page, '[data-test=menu-play]', 'main menu Play button');
    await need(page, '[data-test=menu-start]', 'setup screen Start button');
    for (let k = 0; k < 30; k++) {
      await frames(page, 1, 60); // the map previews are made one per timer
      await sleep(40);
    }
  });

  await shot(page, '03-setup-rules', async () => {
    await need(page, '[data-test=menu-start]', 'setup screen Start button');
    await click(page, '[data-test=more-rules]', 'setup screen "More rules" fold');
    await page.locator('[data-test=more-rules]').first().evaluate((n) => n.scrollIntoView({ block: 'start' }));
  });

  let built = {};
  let f = null;
  let gameOk = false;
  if (wantFrom('04')) {
    try {
      await startGame(page);
      gameOk = true;
    } catch (err) {
      failures.push(`start game: ${err.message.split('\n')[0]}`);
      console.log(`FAILED start game: ${err.message}`);
    }
  }

  if (gameOk) {
    await shot(page, '04-hud-spawn', async () => {
      await need(page, '[data-test=spawnbar]', 'spawn bar (pick a start)');
      await need(page, '[data-test=command-bar]', 'bottom command bar');
      await parkMouse(page);
    }, { optional: true });

    try {
      await spawnAndOpen(page);
    } catch (err) {
      failures.push(`spawn: ${err.message.split('\n')[0]}`);
      console.log(`FAILED spawn: ${err.message}`);
      gameOk = false;
    }
  }

  if (gameOk) {
    await shot(page, '05-hud-early', async () => {
      await need(page, '[data-test=command-bar]', 'bottom command bar');
      await need(page, '[data-test=cluster]', 'top cluster');
      await need(page, '[data-test=leaderboard]', 'standings');
      const g = await facts(page);
      await setCamera(page, g.cap.x, g.cap.y, 7);
      await parkMouse(page);
    });

    // a new player's guide is in the two pictures above; for the rest it is switched off through its own setting
    if (wantFrom('06')) {
      try {
        await click(page, '[data-test=menu]', 'cluster Menu button');
        await need(page, '[data-test=guide-toggle]', 'guide setting in the menu drawer');
        const off = page.locator('[data-test=guide-toggle]').getByRole('button', { name: /off/i }).first();
        if (await off.count()) await off.evaluate((n) => n.click());
        else await page.locator('[data-test=guide-toggle] button').last().evaluate((n) => n.click());
        await frames(page, 1, 250);
      } catch (err) {
        console.log(`note: guide not switched off (${err.message.split('\n')[0]})`);
      }
      await closePanels(page);

      try {
        built = await buildUp(page);
        f = await facts(page);
        console.log(`state: tick ${f.tick}, ${f.tiles} tiles, buildings: ${f.buildings.map((b) => b.type).join(' ')}; units: ${f.units.map((u) => u.variant ?? u.type).join(' ')}`);
      } catch (err) {
        failures.push(`mid-game setup: ${err.message.split('\n')[0]}`);
        console.log(`FAILED mid-game setup: ${err.message}`);
      }
    }
  }

  if (gameOk && f) {
    await shot(page, '06-hud-midgame', async () => {
      await frames(page, 2, 250);
      await dismissToasts(page);
      // two nations attack us: the alert card under the standings and the bell count; the pointer rests on a
      // neighbour's land for the map's hover card
      const foeTile = await page.evaluate((isNationSrc) => {
        const isNation = eval(isNationSrc);
        const s = window.__borderfall.getState();
        const me = s.players[s.humanId];
        const foes = s.players.filter((q) => isNation(q) && q.id !== me.id);
        for (const foe of foes.slice(0, 2)) s.events.push({ tick: s.tick, kind: 'underAttack', message: `${me.name} is under attack by ${foe.name}`, players: [me.id, foe.id], tile: me.capital });
        return foes.length ? foes[0].capital : -1;
      }, isNation);
      await setCamera(page, f.w / 2, f.h / 2, 1.5);
      await need(page, '[data-test=leaderboard]', 'standings');
      await frames(page, 2, 250);
      await need(page, '[data-test=alert]', 'an alert card');
      if (foeTile >= 0) {
        const p = await tilePos(page, foeTile);
        await page.mouse.move(p.x + 14, p.y + 10);
        await frames(page, 2, 250);
      }
    });

    await closePanels(page);
    let unitClip = null;
    await shot(page, '07-map-units', async () => {
      // ships holding off the port, the tank division at the factory, aircraft and a rocket just launched
      const g = await facts(page);
      const anchor = ['airfield', 'factory', 'port', 'silo'].filter((k) => built[k] !== undefined).map((k) => [built[k] % g.w, Math.floor(built[k] / g.w)]);
      if (!anchor.length) anchor.push([g.cap.x, g.cap.y]);
      const cx = anchor.reduce((a, p) => a + p[0], 0) / anchor.length;
      const cy = anchor.reduce((a, p) => a + p[1], 0) / anchor.length;
      const zoom = 9;
      await setCamera(page, cx, cy - 8, zoom); // the action sits below the toasts
      await frames(page, 2, 100);
      const r = await launchStrikes(page, built);
      await adv(page, 2);
      const mine = (await facts(page)).units;
      const air = mine.filter((u) => !['warship', 'tankDivision', 'tradeShip', 'transport'].includes(u.type));
      console.log(`units picture: strikes ${JSON.stringify(r)}; in the air: ${air.map((u) => u.type).join(' ') || 'nothing'}`);
      // where the close-up looks: the middle of the own units on screen (ships, tanks and what just took off)
      const near = mine.filter((u) => u.type !== 'tradeShip' && Math.abs(u.x - cx) < 40 && Math.abs(u.y - (cy - 8)) < 26);
      if (near.length) {
        const ux = near.reduce((a, u) => a + u.x, 0) / near.length;
        const uy = near.reduce((a, u) => a + u.y, 0) / near.length;
        const sx = DESKTOP.width / 2 + (ux - cx) * zoom;
        const sy = DESKTOP.height / 2 + (uy - (cy - 8)) * zoom;
        const w = 480, h = 300;
        unitClip = { x: Math.round(Math.max(0, Math.min(DESKTOP.width - w, sx - w / 2))), y: Math.round(Math.max(0, Math.min(DESKTOP.height - h, sy - h / 2))), width: w, height: h };
      }
    }, { n: 3, ms: 100, rest: 250, alsoFor: ['08'] });

    // the same moment three times as large (hard pixels): the unit art is only 8 to 10 px on screen
    if (want('08')) {
      const file = join(OUT, '08-map-units-closeup.png');
      try {
        if (!unitClip) throw new Error('no own units on screen to look at');
        await magnified(page, browser, unitClip, 3, file);
        console.log(file);
      } catch (err) {
        skipped.push(`08-map-units-closeup: ${err.message.split('\n')[0]}`);
        console.log(`SKIPPED (optional) 08-map-units-closeup: ${err.message.split('\n')[0]}`);
      }
      lastMark = Date.now();
    }

    await shot(page, '09-map-buildings', async () => {
      await adv(page, 150); // the strikes land
      await frames(page, 2, 250);
      await dismissToasts(page);
      const g = await facts(page);
      const bs = g.buildings;
      const cx = bs.reduce((a, b) => a + b.x, 0) / Math.max(1, bs.length);
      const cy = bs.reduce((a, b) => a + b.y, 0) / Math.max(1, bs.length);
      await setCamera(page, cx, cy, 15);
      await parkMouse(page);
    });

    await shot(page, '10-build-menu', async () => {
      await setCamera(page, f.cap.x, f.cap.y, 7);
      await click(page, '[data-test=build-menu-btn]', 'command bar Build button');
      await need(page, '[data-test=build-menu]', 'build menu');
      await parkMouse(page);
    });

    await closePanels(page);
    await shot(page, '11-building-drawer', async () => {
      const tile = built.factory ?? built.airfield;
      if (tile === undefined) throw new Error('no Factory or Airfield was built');
      const g = await facts(page);
      await setCamera(page, (tile % g.w) + 14, Math.floor(tile / g.w), 9);
      await frames(page, 2, 250);
      // a real click on the building; the state write is the fallback if the click picked something else
      const pos = await tilePos(page, tile);
      await page.mouse.click(pos.x, pos.y);
      await frames(page, 2, 250);
      if (!(await isVisible(page, '[data-test=drawer]'))) {
        console.log('note: the click did not open the building drawer, selecting the tile directly');
        await page.evaluate((t) => (window.__borderfall.ui().selectedTile = t), tile);
      }
      await need(page, '[data-test=drawer]', 'building drawer');
      await parkMouse(page);
    });

    await closePanels(page);
    await shot(page, '12-forces-unit-card', async () => {
      const g = await facts(page);
      const u = g.units.find((q) => q.type === 'warship') ?? g.units.find((q) => q.type === 'tankDivision');
      if (!u) throw new Error('no warship or tank division to select');
      await setCamera(page, u.x + 8, u.y, 10);
      await click(page, '[data-test=open-forces]', 'cluster Forces button');
      await need(page, '[data-test=drawer]', 'Forces drawer');
      await page.evaluate((id) => (window.__borderfall.ui().selection = [id]), u.id);
      await need(page, '[data-test=unit-card]', 'unit card');
      await need(page, '[data-test=orders-bar]', 'orders bar for the selected unit');
      await parkMouse(page);
    });

    await closePanels(page);
    await shot(page, '13-research-tree', async () => {
      await setCamera(page, f.cap.x, f.cap.y, 7);
      await click(page, '[data-test=open-research]', 'cluster Research button');
      await click(page, '[data-test=tab-research]', 'Research tab');
      await need(page, '[role=group][aria-label="Research techs"] [data-test^="tech-"]', 'a tech card in the research tree');
      await parkMouse(page);
    });

    await shot(page, '14-arsenal', async () => {
      if (!(await isVisible(page, '[data-test=tab-arsenal]'))) await click(page, '[data-test=open-research]', 'cluster Research button');
      await click(page, '[data-test=tab-arsenal]', 'Arsenal tab');
      await need(page, '[role=group][aria-label="Arsenal"] [data-test^="row-"]', 'an arsenal row');
      await parkMouse(page);
    });

    await closePanels(page);
    await shot(page, '15-doctrine', async () => {
      await click(page, '[data-test=open-doctrine]', 'cluster Doctrine button');
      await need(page, '[role=radiogroup][aria-label="Doctrines"] [role=radio]', 'a doctrine card');
      await parkMouse(page);
    }, { optional: true });

    await closePanels(page);
    await shot(page, '16-diplomacy-nation-card', async () => {
      await click(page, '[data-test=open-diplomacy]', 'cluster Diplomacy button');
      await need(page, '[data-test=drawer]', 'Diplomacy drawer');
      const ids = await page.evaluate(() => [...document.querySelectorAll('[data-test^="lb-row-"]')].filter((n) => n.getClientRects().length).map((n) => n.getAttribute('data-test')));
      const other = ids.find((id) => id !== `lb-row-${f.me}`);
      if (!other) throw new Error('standings rows: selector not found or not visible: [data-test^="lb-row-"]');
      await click(page, `[data-test="${other}"]`, 'a standings row');
      await need(page, '[data-test=nation-card]', 'nation card');
      await frames(page, 6, 250); // the camera flies to that nation
      await parkMouse(page);
    });

    await shot(page, '17-toast-tooltip', async () => {
      // toasts: an alliance request sent from the nation card and a finished research; a tooltip on a cluster button
      if (await isVisible(page, '[data-test=nc-ally]')) await page.locator('[data-test=nc-ally] >> visible=true').first().evaluate((n) => n.click());
      await closePanels(page);
      await page.evaluate(() => {
        const s = window.__borderfall.getState();
        const me = s.players[s.humanId];
        s.events.push({ tick: s.tick, kind: 'researchDone', message: 'Research complete: Flight', players: [me.id], tile: -1 });
      });
      await frames(page, 2, 250);
      await need(page, '[data-test=toast]', 'a toast');
      const b = await need(page, '[data-test=open-research]', 'cluster Research button');
      await b.hover({ force: true });
      await frames(page, 2, 250);
    }, { n: 1, rest: 400 });

    await closePanels(page);
    await shot(page, '18-game-over', async () => {
      // the sim ends the game by itself once the land needed to win is below what the leader holds
      await page.evaluate(() => (window.__borderfall.getState().settings.victoryLandShare = 0.02));
      for (let k = 0; k < 10; k++) {
        await adv(page, 20);
        if ((await page.evaluate(() => window.__borderfall.getState().phase)) === 'over') break;
      }
      await frames(page, 3, 250);
      await need(page, '[data-test=play-again]', 'game over card (Play again)', 20);
      await parkMouse(page);
    }, { optional: true, rest: 900 });
  }
  await ctx.close();
}

// ------------------------------------------------------------------------------------------------ phone
if (wantFrom('19')) {
  const { ctx, page } = await openPage(browser, PHONE, true);

  await shot(page, '19-phone-main-menu', async () => {
    await frames(page, 10, 250);
    await need(page, '[data-test=menu-play]', 'main menu Play button');
  });

  let ok = false;
  if (wantFrom('20')) {
    try {
      await startGame(page);
      await spawnAndOpen(page);
      for (let k = 0; k < 6; k++) {
        await page.evaluate(growStep, 300000);
        await adv(page, 100);
      }
      await page.evaluate(enrich);
      ok = true;
    } catch (err) {
      failures.push(`phone game: ${err.message.split('\n')[0]}`);
      console.log(`FAILED phone game: ${err.message}`);
    }
  }
  if (ok) {
    await shot(page, '20-phone-hud', async () => {
      await need(page, '[data-test=command-bar]', 'bottom command bar');
      await need(page, '[data-test=cluster]', 'top cluster');
      const g = await facts(page);
      await setCamera(page, g.cap.x, g.cap.y + 10, 5);
    });
    await shot(page, '21-phone-drawer', async () => {
      await click(page, '[data-test=open-research]', 'cluster Research button');
      await need(page, '[data-test=drawer]', 'Research drawer');
    });
  }
  await ctx.close();
}

await browser.close();
console.log(`done in ${((Date.now() - started) / 1000).toFixed(1)} s`);
if (pageErrors.length) console.log(`page errors (${pageErrors.length}): ${[...new Set(pageErrors)].slice(0, 5).join(' | ')}`);
if (skipped.length) console.log(`optional screens skipped:\n  ${skipped.join('\n  ')}`);
if (failures.length) {
  console.error(`FAILED screens:\n  ${failures.join('\n  ')}`);
  process.exit(1);
}
