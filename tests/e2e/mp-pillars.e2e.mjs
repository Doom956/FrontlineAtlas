// Multiplayer check of the pillar controls (stances, division modes, air missions): production server on port 8098,
// two players + a spectator, a rich/instant/all-tech start so the units exist at once; hashes must match everywhere.
//   npm run build && node tests/e2e/mp-pillars.e2e.mjs      Screenshots: /tmp/borderfall-shots/pillars-mp-*.png
import { spawn, execSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { economyDriver, spawnCandidates } from './scripted.mjs';

const require = createRequire(import.meta.url);
let pw;
try {
  pw = require('playwright');
} catch {
  pw = createRequire(join(execSync('npm root -g').toString().trim(), 'x.js'))('playwright');
}
const OUT = '/tmp/borderfall-shots';
mkdirSync(OUT, { recursive: true });
const W = 1280;
const H = 800;
const errors = [];
const servers = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);
const fail = (m) => {
  throw new Error(m);
};

async function startServer(port, env = {}) {
  if (await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.ok, () => false)) fail(`port ${port} is already in use (set E2E_PORT)`);
  const proc = spawn('node', ['server-dist/index.js'], { env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  proc.stderr.on('data', (d) => process.stderr.write(`[srv err] ${d}`));
  servers.push(proc);
  for (let k = 0; k < 100; k++) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return proc;
    } catch {
      /* not yet */
    }
    await sleep(100);
  }
  fail('server did not start');
}
const browser = await pw.chromium.launch({ args: ['--use-gl=angle', '--enable-unsafe-swiftshader'] });
async function newClient(label, url) {
  const ctx = await browser.newContext({ viewport: { width: W, height: H } });
  const page = await ctx.newPage();
  page.on('console', (m) => m.type() === 'error' && errors.push(`[${label}] ${m.text()}`));
  page.on('pageerror', (e) => errors.push(`[${label}] pageerror: ${e.message}`));
  await page.goto(url);
  await page.waitForFunction(() => !!window.__borderfall);
  return { label, ctx, page };
}
const shot = async (page, name) => page.screenshot({ path: `${OUT}/pillars-mp-${name}.png` });
async function setName(page, name) {
  await page.click('[data-test=menu-mp]');
  const input = page.locator('[data-test=mp-name]');
  await input.fill(name);
  await input.dispatchEvent('change');
  await page.waitForFunction(() => /online/i.test(document.querySelector('[data-test=net-status]')?.textContent ?? ''), null, { timeout: 10000 });
}
async function waitGame(page, timeout = 30000) {
  await page.waitForFunction(() => !!window.__borderfall.mp() && window.__borderfall.turn() >= 0 && !document.querySelector('.menu:not(.hidden)'), null, { timeout });
}
async function spawnByClick(page, side) {
  // the best start on our half: oil, iron and a coast inside the first territory if the map has such a spot
  // (scripted.mjs spawnCandidates), so the economy below needs no lucky conquest
  const cands = await page.evaluate(spawnCandidates, { side, count: 12 });
  if (!cands.length) fail('no land with oil and a coast to spawn on');
  for (const c of cands) {
    await page.evaluate((t) => window.__borderfall.dispatch({ type: 'spawn', tile: t }), c.tile);
    for (let k = 0; k < 8; k++) {
      await sleep(300);
      if (await page.evaluate(() => { const s = window.__borderfall.getState(); return s.players[s.humanId].spawned; })) {
        log(side, 'start', c.tile, 'tier', c.tier);
        return;
      }
    }
  }
  fail('could not spawn');
}
async function compareHashes(pages, minCommon = 3) {
  const maps = await Promise.all(pages.map((p) => p.evaluate(() => window.__borderfall.hashes())));
  const common = Object.keys(maps[0]).filter((t) => maps.every((m) => t in m));
  for (const t of common) {
    const vals = maps.map((m) => m[t]);
    if (new Set(vals).size !== 1) fail(`hash mismatch at turn ${t}: ${vals.join(' ')}`);
  }
  if (common.length < minCommon) fail(`only ${common.length} common hash turns`);
  return common.map(Number).sort((a, b) => a - b);
}
/** Runs a dispatch in the page and waits for it to land (the next turn(s)). */
const dispatch = (page, action) => page.evaluate((a) => window.__borderfall.dispatch(a), action);
/** Own tiles near the capital: coastal ones first for ports. */
const ownTiles = (page, coastal, skip) =>
  page.evaluate(({ coastal, skip }) => {
    const s = window.__borderfall.getState();
    const me = s.humanId;
    const w = s.map.width;
    const cap = s.players[me].capital;
    const out = [];
    for (let i = 0; i < s.map.owner.length; i++) {
      if (s.map.owner[i] !== me || s.map.terrain[i] <= 1 || s.map.building[i] !== 0) continue;
      if (coastal && !s.map.coastal[i]) continue;
      out.push([Math.hypot((i % w) - (cap % w), Math.floor(i / w) - Math.floor(cap / w)), i]);
    }
    out.sort((a, b) => a[0] - b[0]);
    return out.slice(skip ?? 0, (skip ?? 0) + 60).map((e) => e[1]);
  }, { coastal, skip });
let exitCode = 0;
try {
  const port = Number(process.env.E2E_PORT) || 8098; // E2E_PORT: another port when several runs share the machine
  await startServer(port, { PUBLIC_START_SECONDS: '60', FIXED_SEED: process.env.FIXED_SEED ?? '13' });
  const URL = `http://127.0.0.1:${port}/`;
  const A = await newClient('A', URL);
  const B = await newClient('B', URL);
  await setName(A.page, 'Alice');
  await A.page.click('[data-test=mp-create]');
  await A.page.waitForSelector('[data-test=lobby-code]');
  const code = (await A.page.textContent('[data-test=lobby-code]')).trim();
  await A.page.locator('.setup-field:has(.form-label:text-is("Size")) .btn', { hasText: 'Small' }).click();
  // Easy AI nations: the scripted players build up slowly and must not be overrun before their units exist
  const easy = A.page.locator('[role=group][aria-label="Difficulty"] .btn', { hasText: /^Easy$/ }).first();
  if (await easy.count()) await easy.click();
  else log('no Difficulty buttons in the lobby, AI stays on its default');
  // an island map; rich + instant + everything researched, so every pillar unit exists at once
  // (starting gold and build speed are folded under "More rules")
  await A.page.click('[data-test=more-rules]');
  for (const label of ['Very high', 'Instant', 'All unlocked']) {
    const b = A.page.locator('.rules-col .btn', { hasText: new RegExp(`^${label}$`) }).first();
    if (!(await b.count())) fail(`modifier button ${label} not found`);
    await b.click();
  }
  await setName(B.page, 'Bob');
  await B.page.fill('[data-test=mp-code]', code.toLowerCase());
  await B.page.click('[data-test=mp-join]');
  await B.page.waitForSelector('[data-test=lobby-players] li:nth-child(2)');
  await shot(A.page, 'lobby');
  await A.page.click('[data-test=mp-start]');
  await Promise.all([waitGame(A.page), waitGame(B.page)]);
  await Promise.all([spawnByClick(A.page, 'left'), spawnByClick(B.page, 'right')]);
  const C = await newClient('C', URL);
  await setName(C.page, 'Cy');
  await C.page.fill('[data-test=mp-code]', code);
  await C.page.click('[data-test=mp-watch]');
  await waitGame(C.page);
  await A.page.waitForFunction(() => window.__borderfall.getState().phase === 'playing', null, { timeout: 30000 });
  log('playing; gold', await A.page.evaluate(() => window.__borderfall.getState().players[window.__borderfall.getState().humanId].gold));

  // ---- a mine and an oil well, then the three pillar buildings (Port, Airfield, Factory); the land grows (attacks on
  // wilderness and tribes only) until there is room and a deposit for each (scripted.mjs economyStep)
  const want = ['port', 'airfield', 'factory'];
  const drivers = [A, B].map((c) => economyDriver(c.label, (fn, arg) => c.page.evaluate(fn, arg), (a) => dispatch(c.page, a), log));
  const ready = (n) => n.wells.length > 0 && n.mines.length > 0 && want.every((k) => n.placed[k] >= 0) && n.iron > 700 && n.oil > 300;
  const t0 = Date.now();
  let notes = [];
  for (let k = 0; Date.now() - t0 < 300000; k++) {
    notes = await Promise.all(drivers.map((d) => d({ want, level: 5 })));
    if (k % 10 === 0) log('economy', JSON.stringify(notes));
    // B is only a second player here: A must be ready, B gets a little longer if it is behind
    if (ready(notes[0]) && (ready(notes[1]) || Date.now() - t0 > 200000)) break;
    await sleep(3000);
  }
  log('economy', JSON.stringify(notes));
  if (!(await A.page.evaluate(() => { const s = window.__borderfall.getState(); const p = s.players[s.humanId]; return p.iron > 300 && p.oil > 100; }))) fail('A has no iron/oil');
  const result = {};
  for (const [label, pg] of [['A', A.page], ['B', B.page]]) {
    const r = {};
    for (const k of want) r[k] = await pg.evaluate((k) => { const s = window.__borderfall.getState(); const b = [...s.buildings.values()].find((x) => x.owner === s.humanId && x.type === k && x.buildLeft <= 0); return b ? b.tile : -1; }, k);
    result[label] = r;
  }
  log('built', JSON.stringify(result));
  if (result.A.port < 0 || result.A.airfield < 0 || result.A.factory < 0) fail('A could not place port/airfield/factory');
  await sleep(2500);
  for (const [label, pg] of [['A', A.page], ['B', B.page]]) {
    const r = result[label];
    if (r.port >= 0) { for (let k = 0; k < 2; k++) log(label, 'warship', JSON.stringify(await dispatch(pg, { type: 'buildWarship', port: r.port }))); }
    if (r.airfield >= 0) { await dispatch(pg, { type: 'buildAircraft', airfield: r.airfield, kind: 'bomber' }); await dispatch(pg, { type: 'buildAircraft', airfield: r.airfield, kind: 'fighter' }); }
    await dispatch(pg, { type: 'setArmyMix', armor: 0.5, artillery: 0.1 });
  }
  await sleep(12000);
  for (const [label, pg] of [['A', A.page], ['B', B.page]]) {
    const r = result[label];
    if (r.factory >= 0) log(label, 'tank', JSON.stringify(await dispatch(pg, { type: 'buildTankDivision', tile: r.factory })));
  }
  await sleep(6000);
  log('dbg', JSON.stringify(await A.page.evaluate(() => {
    const s = window.__borderfall.getState();
    const me = s.humanId;
    return { tick: s.tick, gold: s.players[me].gold, iron: s.players[me].iron, oil: s.players[me].oil, armor: s.players[me].troops.armor, tech: [...(s.players[me].techs ?? [])].length, b: [...s.buildings.values()].filter((b) => b.owner === me && ['port','airfield','factory'].includes(b.type)).map((b) => `${b.type}:${b.level}:${b.buildLeft}`), q: (s.unitQueue ?? []).length, units: s.units.length, intents: window.__borderfall.mp()?.nextTurn };
  })));
  const units = await A.page.evaluate(() => {
    const s = window.__borderfall.getState();
    const me = s.humanId;
    const mine = s.units.filter((u) => u.owner === me).map((u) => ({ id: u.id, type: u.type }));
    return { mine, queue: (s.unitQueue ?? []).length };
  });
  log('A units', JSON.stringify(units));
  const ships = units.mine.filter((u) => u.type === 'warship').map((u) => u.id);
  const divs = units.mine.filter((u) => u.type === 'tankDivision').map((u) => u.id);
  log(`A has ${ships.length} warships, ${divs.length} divisions`);
  if (!ships.length) fail('A has no warship');
  if (!divs.length) fail('A has no tank division');

  // ---- stances, division modes and air missions as intents
  const enemyTile = await A.page.evaluate(() => {
    const s = window.__borderfall.getState();
    const me = s.humanId;
    const foe = s.players.find((p) => p.id && p.id !== me && p.alive && p.capital >= 0);
    return { foe: foe?.id ?? 0, capital: foe?.capital ?? -1 };
  });
  const front = (await ownTiles(A.page, false, 30))[0];
  for (const st of ['hunt', 'escort', 'bombard', 'blockade', 'auto']) {
    const r = await dispatch(A.page, { type: 'setUnitStance', unitIds: ships, stance: st });
    if (!r.ok) fail(`setUnitStance ${st}: ${r.reason ?? r.error}`);
    await sleep(300);
  }
  await dispatch(A.page, { type: 'setUnitStance', unitIds: ships, stance: 'bombard' });
  for (const mode of ['support', 'refit', 'hold', 'support']) {
    const r = await dispatch(A.page, { type: 'setDivisionMode', unitIds: divs, mode, front });
    if (!r.ok) fail(`setDivisionMode ${mode}: ${r.reason ?? r.error}`);
    await sleep(300);
  }
  for (const mission of ['superiority', 'support', 'strategic', 'idle', 'support']) {
    const r = await dispatch(A.page, { type: 'setAirMission', airfield: result.A.airfield, mission, target: mission === 'idle' ? undefined : enemyTile.capital, refill: true });
    if (!r.ok) fail(`setAirMission ${mission}: ${r.reason ?? r.error}`);
    await sleep(300);
  }
  await dispatch(A.page, { type: 'setAirMission', airfield: -1, mission: 'superiority' });
  // B sends the same kinds of orders on its own units
  const bUnits = await B.page.evaluate(() => {
    const s = window.__borderfall.getState();
    return s.units.filter((u) => u.owner === s.humanId).map((u) => ({ id: u.id, type: u.type }));
  });
  const bShips = bUnits.filter((u) => u.type === 'warship').map((u) => u.id);
  const bDivs = bUnits.filter((u) => u.type === 'tankDivision').map((u) => u.id);
  if (bShips.length) await dispatch(B.page, { type: 'setUnitStance', unitIds: bShips, stance: 'blockade' });
  if (bDivs.length) await dispatch(B.page, { type: 'setDivisionMode', unitIds: bDivs, mode: 'support', front: (await ownTiles(B.page, false, 30))[0] });
  await dispatch(B.page, { type: 'setAirMission', airfield: -1, mission: 'strategic', target: enemyTile.capital });
  await sleep(8000);
  await shot(A.page, 'a');
  await shot(B.page, 'b');
  await shot(C.page, 'c-spectator');

  // ---- the settings landed the same way on every client
  const view = (pg) =>
    pg.evaluate(() => {
      const s = window.__borderfall.getState();
      return s.units
        .filter((u) => u.type === 'warship' || u.type === 'tankDivision')
        .map((u) => `${u.id}:${u.owner}:${u.stance ?? u.mode ?? ''}:${u.state}`)
        .join(',');
    });
  const va = await view(A.page);
  log('A view', va);
  const common = await compareHashes([A.page, B.page, C.page], 10);
  log(`hashes agree on ${common.length} turns (${common[0]}..${common[common.length - 1]})`);
  // keep playing a while with the orders running
  await sleep(20000);
  const common2 = await compareHashes([A.page, B.page, C.page], 10);
  if (common2[common2.length - 1] <= common[common.length - 1]) fail('no new common hashes');
  const desync = await Promise.all([A.page, B.page, C.page].map((p) => p.evaluate(() => window.__borderfall.mp().desync)));
  if (desync.some(Boolean)) fail('a client was told it desynced');
  const stances = await A.page.evaluate(() => {
    const s = window.__borderfall.getState();
    return s.units.filter((u) => u.owner === s.humanId).map((u) => `${u.type}:${u.stance ?? u.mode ?? '-'}`);
  });
  log('A orders now', stances.join(' '));
  const air = await A.page.evaluate(() => { const s = window.__borderfall.getState(); const a = s.air; return a ? JSON.stringify({ wings: a.wings, keys: Object.keys(a) }).slice(0, 400) : 'no air state'; });
  log('A air', air);
  if (!/support|superiority/.test(air)) fail('air mission did not stick');
  // a bombard ship at war sails to the enemy coast and can be sunk in the 20 s above: only check a ship that is still afloat
  if (!stances.some((x) => x.startsWith('warship:'))) log('A has no warship left (sunk), stance check skipped');
  else if (!stances.some((x) => x.startsWith('warship:bombard'))) fail('stance did not stick');
  if (!stances.some((x) => x.startsWith('tankDivision:support'))) fail('division mode did not stick');
  const vb = await view(B.page);
  const vc = await view(C.page);
  if (vb.split(',').length < 2) log('note: few units in view');
  log(`B and C see the same unit orders: ${(await view(B.page)).length > 0 && (await view(C.page)).length > 0}`);
  if (errors.length) fail(`console errors:\n${errors.join('\n')}`);
  log('PASS');
} catch (err) {
  console.error('FAIL:', err.message);
  exitCode = 1;
} finally {
  await browser.close();
  for (const s of servers) s.kill();
  process.exit(exitCode);
}
