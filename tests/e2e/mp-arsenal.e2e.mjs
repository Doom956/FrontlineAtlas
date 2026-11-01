// Multiplayer check of the Arsenal (round 2): production server on port 8099, two players + a spectator, two games.
//   Game 1 (normal research, fast game, very high gold, instant building): labs, a Shift+drag box upgrade x3 through the
//     building selection bar, then a Port, a mine and an oil well each (Arsenal items are bought with gold + iron / oil
//     and navy items need a Port), both buy Navigation, A buys a navy fork from the Arsenal card (T, Arsenal tab,
//     Destroyers), the other branch and a mastery without its prerequisite are refused, B researches Fortification
//     (Research tab, science) and buys a special (Naval Mines); both orders are delivered after their timers.
//   Game 2 (every tech unlocked): variant warships (carrier, submarine, destroyer, battleship), a tank division, recon
//     flights, a strategic mission with a carrier at sea, minefields around ports.
// Hashes must match on all three clients in both games, and no console errors.
//   npm run build && node tests/e2e/mp-arsenal.e2e.mjs      Screenshots: /tmp/borderfall-shots/arsenal-mp-*.png
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
const W = 1280;
const H = 800;
const PORT = 8099;
const URL = `http://127.0.0.1:${PORT}/`;
const errors = [];
const servers = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);
const fail = (m) => {
  throw new Error(m);
};

async function startServer(port, env = {}) {
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
async function newClient(label) {
  const ctx = await browser.newContext({ viewport: { width: W, height: H } });
  const page = await ctx.newPage();
  page.on('console', (m) => m.type() === 'error' && errors.push(`[${label}] ${m.text()}`));
  page.on('pageerror', (e) => errors.push(`[${label}] pageerror: ${e.message}`));
  await page.goto(URL);
  await page.waitForFunction(() => !!window.__borderfall);
  return { label, ctx, page };
}
const shot = async (page, name) => page.screenshot({ path: `${OUT}/arsenal-mp-${name}.png` });
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
  // a land tile with iron, oil and a coast nearby, far from every other start
  for (let attempt = 0; attempt < 12; attempt++) {
    const tile = await page.evaluate(({ side, attempt }) => {
      const s = window.__borderfall.getState();
      const { width: w, height: h } = s.map;
      const out = [], loose = [], coastOnly = [];
      for (let y = 8; y < h - 8; y += 1) {
        for (let x = 8; x < w - 8; x += 1) {
          if ((side === 'left') !== (x < w / 2)) continue;
          const i = y * w + x;
          if (s.map.terrain[i] <= 1 || s.map.owner[i] !== 0) continue;
          let coast = false, iron = 0, oil = 0;
          for (let dy = -22; dy <= 22; dy++) for (let dx = -22; dx <= 22; dx++) {
            const j = (y + dy) * w + x + dx;
            if (j < 0 || j >= s.map.terrain.length) continue;
            const d2 = dx * dx + dy * dy;
            if (d2 <= 25 && s.map.coastal[j] && s.map.terrain[j] > 1) coast = true;
            if (d2 <= 16 && s.map.resource[j] === 1 && s.map.terrain[j] > 1) iron++;
            if (d2 >= 256 && d2 <= 400 && s.map.resource[j] === 2 && s.map.terrain[j] > 1) oil++;
          }
          let near = false;
          for (const p of s.players) if (p.id && p.capital >= 0 && Math.hypot((p.capital % w) - x, Math.floor(p.capital / w) - y) < 26) near = true;
          if (!coast || near) continue;
          if (iron && oil) out.push(i);
          else if (iron || oil) loose.push(i);
          else coastOnly.push(i);
        }
      }
      // iron and oil near a coast if the map has it, else what comes closest (oil is then taken by attacking)
      const pick = out.length ? out : loose.length ? loose : coastOnly;
      return pick.length ? pick[(attempt * 13) % pick.length] : -1;
    }, { side, attempt });
    if (tile < 0) fail('no coastal land to spawn on');
    await page.evaluate((t) => window.__borderfall.dispatch({ type: 'spawn', tile: t }), tile);
    await sleep(1200);
    if (await page.evaluate(() => { const s = window.__borderfall.getState(); return s.players[s.humanId].spawned; })) return;
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
const dispatch = (page, action) => page.evaluate((a) => window.__borderfall.dispatch(a), action);
/** A tile of ours 12+ tiles from every building of ours (the rule is 10), nearest the capital; coastal ones for ports. */
const site = (page, coastal, minGap = 12) =>
  page.evaluate(({ coastal, minGap }) => {
    const s = window.__borderfall.getState();
    const me = s.humanId;
    const w = s.map.width;
    const cap = s.players[me].capital;
    const bs = [...s.buildings.values()].filter((b) => b.owner === me).map((b) => [b.tile % w, Math.floor(b.tile / w)]);
    let best = -1, bd = 1e9;
    for (let i = 0; i < s.map.owner.length; i++) {
      if (s.map.owner[i] !== me || s.map.terrain[i] <= 1 || s.map.building[i] !== 0 || s.map.fallout[i] > 0) continue;
      if (coastal && !s.map.coastal[i]) continue;
      const x = i % w, y = Math.floor(i / w);
      if (bs.some(([bx, by]) => Math.hypot(bx - x, by - y) < minGap)) continue;
      const d = Math.hypot(x - (cap % w), y - Math.floor(cap / w));
      if (d < bd) { bd = d; best = i; }
    }
    return best;
  }, { coastal, minGap });
const ownBuildings = (page) =>
  page.evaluate(() => {
    const s = window.__borderfall.getState();
    return [...s.buildings.values()].filter((b) => b.owner === s.humanId).map((b) => ({ tile: b.tile, type: b.type, level: b.level, left: b.buildLeft }));
  });
const me = (page) =>
  page.evaluate(() => {
    const s = window.__borderfall.getState();
    const p = s.players[s.humanId];
    return { id: p.id, gold: Math.round(p.gold), iron: Math.round(p.iron), oil: Math.round(p.oil), techs: [...p.techs], researching: p.researching, procuring: (p.procuring ?? []).map((o) => o.tech), science: Math.round(p.science) };
  });
/** Every client's view of player `id`'s research (spectator included). */
const researchOf = (page, id) => page.evaluate((id) => { const p = window.__borderfall.getState().players[id]; return `${p.researching}|${(p.procuring ?? []).map((o) => `${o.tech}@${o.readyTick}`).join(',')}|${[...p.techs].sort().join(',')}`; }, id);

async function lobby(rules, toggles) {
  const A = await newClient('A');
  const B = await newClient('B');
  await setName(A.page, 'Alice');
  await A.page.click('[data-test=mp-create]');
  await A.page.waitForSelector('[data-test=lobby-code]');
  const code = (await A.page.textContent('[data-test=lobby-code]')).trim();
  await A.page.locator('.setup-field:has(.form-label:text-is("Size")) .btn', { hasText: 'Small' }).click();
  for (const label of rules) {
    const b = A.page.locator('.rules-col .btn', { hasText: new RegExp(`^${label.replace(/[×]/g, '\\$&')}$`) }).first();
    if (!(await b.count())) fail(`modifier button ${label} not found`);
    await b.click();
  }
  for (const name of toggles) {
    const t = A.page.locator(`.rules-col [role=switch][aria-label="${name}"]`).first();
    if (!(await t.count())) fail(`switch ${name} not found`);
    if ((await t.getAttribute('aria-checked')) !== 'true') await t.click();
  }
  await setName(B.page, 'Bob');
  await B.page.fill('[data-test=mp-code]', code.toLowerCase());
  await B.page.click('[data-test=mp-join]');
  await B.page.waitForSelector('[data-test=lobby-players] li:nth-child(2)');
  await A.page.click('[data-test=mp-start]');
  await Promise.all([waitGame(A.page), waitGame(B.page)]);
  await Promise.all([spawnByClick(A.page, 'left'), spawnByClick(B.page, 'right')]);
  const C = await newClient('C');
  await setName(C.page, 'Cy');
  await C.page.fill('[data-test=mp-code]', code);
  await C.page.click('[data-test=mp-watch]');
  await waitGame(C.page);
  await A.page.waitForFunction(() => window.__borderfall.getState().phase === 'playing', null, { timeout: 30000 });
  return { A, B, C, code };
}
async function closeAll(cs) {
  for (const c of cs) await c.ctx.close();
}

async function waitFor(fn, ms, what) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await fn()) return;
    await sleep(1000);
  }
  fail(`timed out: ${what}`);
}

const deposit = (pg, kind) =>
  pg.evaluate((kind) => {
    const s = window.__borderfall.getState();
    const out = [];
    for (let i = 0; i < s.map.owner.length; i++) if (s.map.owner[i] === s.humanId && s.map.resource[i] === kind && s.map.building[i] === 0) out.push(i);
    return out;
  }, kind);
// iron: a mine on the deposit; oil: attack toward the nearest deposit, then a well on it (one step per call)
const economy = async (pg) => {
  for (const t of (await deposit(pg, 1)).slice(0, 1)) await dispatch(pg, { type: 'build', building: 'mine', tile: t });
  const step = await pg.evaluate(() => {
    const s = window.__borderfall.getState();
    const me = s.humanId;
    const w = s.map.width;
    const cap = s.players[me].capital;
    const cx = cap % w, cy = Math.floor(cap / w);
    if ([...s.buildings.values()].some((x) => x.owner === me && x.type === 'oilWell')) return { done: true };
    let best = -1, bd = 1e9;
    for (let i = 0; i < s.map.resource.length; i++) {
      if (s.map.resource[i] !== 2 || s.map.terrain[i] <= 1) continue;
      const d = Math.hypot((i % w) - cx, Math.floor(i / w) - cy);
      if (d < bd && d < 26) { bd = d; best = i; }
    }
    if (best < 0) return { none: true };
    if (s.map.owner[best] === me) return { well: best };
    const bx = best % w, by = Math.floor(best / w);
    let pick = -1, pd = 1e9;
    for (let i = 0; i < s.map.owner.length; i++) {
      if (s.map.owner[i] !== me) continue;
      const x = i % w, y = Math.floor(i / w);
      if (Math.hypot(x - bx, y - by) > bd + 4) continue;
      for (const j of [i + 1, i - 1, i + w, i - w]) {
        if (s.map.owner[j] === me || s.map.terrain[j] <= 1) continue;
        const d = Math.hypot((j % w) - bx, Math.floor(j / w) - by);
        if (d < pd) { pd = d; pick = j; }
      }
    }
    return { attack: pick };
  });
  if (step.well !== undefined) await dispatch(pg, { type: 'build', building: 'oilWell', tile: step.well });
  else if (step.attack !== undefined && step.attack >= 0) {
    const troops = await pg.evaluate(() => { const s = window.__borderfall.getState(); const t = s.players[s.humanId].troops; return { infantry: Math.floor(t.infantry * 0.8), armor: 0, artillery: 0 }; });
    await dispatch(pg, { type: 'attack', tile: step.attack, troops });
  }
  return step;
};

let exitCode = 0;
try {
  await startServer(PORT, { PUBLIC_START_SECONDS: '60' });

  // ================================================================ game 1: research, Shift-select upgrade
  {
    const { A, B, C } = await lobby(['Very high', 'Instant', '×3'], ['Fast game']);
    log('game 1 playing', JSON.stringify(await me(A.page)));
    // a lab each, next to the capital city
    for (const pg of [A.page, B.page]) {
      const t = await site(pg, false);
      const r = await dispatch(pg, { type: 'build', building: 'lab', tile: t });
      if (!r.ok) fail(`lab: ${r.reason}`);
    }
    await sleep(2500);
    // ---- A: Shift+drag a box over its lab and capital city, then Upgrade x3 on the selection bar
    const before = await ownBuildings(A.page);
    const lab = before.find((b) => b.type === 'lab');
    if (!lab) fail('A has no lab');
    const box = await A.page.evaluate((labTile) => {
      const b = window.__borderfall;
      const s = b.getState();
      const w = s.map.width;
      const cap = s.players[s.humanId].capital;
      const pts = [labTile, cap].map((t) => ({ x: t % w, y: Math.floor(t / w) }));
      const cam = b.camera();
      cam.centerOn((pts[0].x + pts[1].x) / 2, (pts[0].y + pts[1].y) / 2);
      const sc = pts.map((p) => cam.tileToScreen(p.x + 0.5, p.y + 0.5));
      const pad = 30;
      return { x0: Math.min(sc[0].x, sc[1].x) - pad, y0: Math.min(sc[0].y, sc[1].y) - pad, x1: Math.max(sc[0].x, sc[1].x) + pad, y1: Math.max(sc[0].y, sc[1].y) + pad };
    }, lab.tile);
    await sleep(400);
    const inside = (x, y) => x >= 4 && y >= 60 && x <= W - 4 && y <= H - 120;
    if (!inside(box.x0, box.y0) || !inside(box.x1, box.y1)) log('note: box partly off the map area', JSON.stringify(box));
    await A.page.keyboard.down('Shift');
    await A.page.mouse.move(box.x0, box.y0);
    await A.page.mouse.down();
    await A.page.mouse.move((box.x0 + box.x1) / 2, (box.y0 + box.y1) / 2, { steps: 5 });
    await A.page.mouse.move(box.x1, box.y1, { steps: 5 });
    await A.page.mouse.up();
    await A.page.keyboard.up('Shift');
    const bar = A.page.locator('[data-test=building-selection]');
    await bar.waitFor({ state: 'visible', timeout: 5000 });
    const barText = (await bar.innerText()).replace(/\s+/g, ' ');
    log('selection bar:', barText);
    await shot(A.page, 'g1-selection');
    await A.page.click('[data-test=upgrade-x3]');
    await sleep(3000);
    const after = await ownBuildings(A.page);
    const labAfter = after.find((b) => b.tile === lab.tile);
    log('A lab level', lab.level, '->', labAfter.level, JSON.stringify(after.map((b) => `${b.type}:${b.level}`)));
    if (labAfter.level < lab.level + 3) fail(`Shift-select upgrade x3 did not raise the lab 3 levels (${lab.level} -> ${labAfter.level})`);
    // B orders the same action raw (its lab x3)
    const bLab = (await ownBuildings(B.page)).find((b) => b.type === 'lab');
    const rb = await dispatch(B.page, { type: 'upgradeBuildings', tiles: [bLab.tile], levels: 3 });
    if (!rb.ok) fail(`B upgradeBuildings: ${rb.reason}`);
    await Promise.all([A.page.keyboard.press('Escape')]);

    // ---- Arsenal items are bought with gold + iron / oil (navy items need a Port): a Port, a mine and an oil well each
    for (const pg of [A.page, B.page]) {
      const t = await site(pg, true);
      if (t < 0) fail('no coastal site for a Port');
      const r = await dispatch(pg, { type: 'build', building: 'port', tile: t });
      if (!r.ok) fail(`port: ${r.reason}`);
    }
    // B researches Fortification meanwhile (Research tab: science, one at a time)
    let r = await dispatch(B.page, { type: 'research', tech: 'fortification' });
    if (!r.ok) fail(`B fortification: ${r.reason}`);
    // Naval Mines costs B 600 iron + 1400 oil, Navigation 300 iron each, Destroyers A 300 iron + 700 oil
    const want = { A: { iron: 700, oil: 800 }, B: { iron: 1000, oil: 1500 } };
    const raised = new Set();
    const t0 = Date.now();
    while (Date.now() - t0 < 360000) {
      await Promise.all([economy(A.page), economy(B.page)]);
      // mines and wells to level 5 (instant building)
      for (const pg of [A.page, B.page]) {
        const ex = (await ownBuildings(pg)).filter((x) => (x.type === 'mine' || x.type === 'oilWell') && x.level < 5 && !raised.has(`${x.tile}`));
        for (const x of ex) {
          raised.add(`${x.tile}`);
          await dispatch(pg, { type: 'upgradeBuildings', tiles: [x.tile], levels: 5 - x.level });
        }
      }
      const [ma, mb] = [await me(A.page), await me(B.page)];
      if (ma.iron >= want.A.iron && ma.oil >= want.A.oil && mb.iron >= want.B.iron && mb.oil >= want.B.oil) break;
      await sleep(3000);
    }
    log('A', JSON.stringify(await me(A.page)), 'B', JSON.stringify(await me(B.page)));
    if (!(await ownBuildings(A.page)).some((x) => x.type === 'port' && x.left <= 0)) fail('A has no finished Port');
    await waitFor(async () => (await me(B.page)).techs.includes('fortification'), 90000, 'B fortification');
    // the old research action on an Arsenal item is refused (bought instead): nothing changes
    await dispatch(A.page, { type: 'research', tech: 'navigation' });
    await sleep(1500);
    if ((await me(A.page)).researching === 'navigation') fail('research on an Arsenal item (Navigation) was accepted');
    // both buy Navigation (iron only), delivered after its timer
    for (const pg of [A.page, B.page]) {
      r = await dispatch(pg, { type: 'procure', tech: 'navigation' });
      if (!r.ok) fail(`procure navigation: ${r.reason}`);
    }
    await sleep(1500);
    log('orders A / B', JSON.stringify((await me(A.page)).procuring), JSON.stringify((await me(B.page)).procuring));
    await waitFor(async () => (await me(A.page)).techs.includes('navigation') && (await me(B.page)).techs.includes('navigation'), 90000, 'navigation delivered');
    log('A', JSON.stringify(await me(A.page)));
    // A buys Destroyers from its Arsenal card: T opens the panel, the Arsenal tab, click the card
    await A.page.mouse.move(W / 2, H / 2);
    await A.page.keyboard.press('KeyT');
    await A.page.click('[data-test=tab-arsenal]');
    await A.page.waitForSelector('[data-test=tech-destroyers]', { state: 'visible' });
    await shot(A.page, 'g1-arsenal-before');
    const goldBefore = (await me(A.page)).gold;
    await A.page.click('[data-test=tech-destroyers]');
    await waitFor(async () => (await me(A.page)).procuring.includes('destroyers'), 8000, 'Destroyers on order after the card click');
    await A.page.waitForSelector('[data-test=order-destroyers]', { state: 'visible', timeout: 5000 });
    log(`A paid ${goldBefore - (await me(A.page)).gold} gold (with income) for Destroyers`);
    await sleep(600);
    await shot(A.page, 'g1-arsenal-ordered');
    const subCard = await A.page.locator('[data-test=tech-submarines]').getAttribute('class');
    log('A submarines card after the order:', subCard);
    // the other branch and a mastery without its prerequisite are refused
    // (online, dispatch only queues the order: the sim refuses it when the turn runs, so check the state after)
    for (const tech of ['submarines', 'navalMastery', 'carriers']) {
      await dispatch(A.page, { type: 'procure', tech });
      await sleep(1500);
      const m = await me(A.page);
      log(`A orders ${tech}: on order ${m.procuring.join(',')}`);
      if (m.procuring.includes(tech) || m.techs.includes(tech)) fail(`${tech} was accepted (the fork / mastery lock did not hold)`);
    }
    // B buys a special: Naval Mines (needs Navigation + Fortification)
    r = await dispatch(B.page, { type: 'procure', tech: 'navalMines' });
    if (!r.ok) fail(`B navalMines: ${r.reason}`);
    await waitFor(async () => (await me(B.page)).procuring.includes('navalMines'), 8000, 'Naval Mines on order');
    // let the clients settle on the same turn, then compare what each sees
    await sleep(3000);
    {
      const ids0 = { a: (await me(A.page)).id, b: (await me(B.page)).id };
      const views = await Promise.all([A.page, B.page, C.page].map(async (pg) => `${await researchOf(pg, ids0.a)} / ${await researchOf(pg, ids0.b)}`));
      log('orders seen by A, B, C:', views[0]);
      if (new Set(views).size !== 1) fail(`clients disagree on orders:\n${views.join('\n')}`);
    }
    // delivery: Destroyers 25 s, Naval Mines 35 s
    await waitFor(async () => (await me(A.page)).techs.includes('destroyers') && (await me(B.page)).techs.includes('navalMines'), 90000, 'orders delivered');
    await sleep(800);
    await shot(A.page, 'g1-arsenal-delivered');
    await A.page.keyboard.press('Escape');
    await sleep(3000);
    const ids = { a: (await me(A.page)).id, b: (await me(B.page)).id };
    const views = await Promise.all([A.page, B.page, C.page].map(async (pg) => `${await researchOf(pg, ids.a)} / ${await researchOf(pg, ids.b)}`));
    log('research and orders seen by A, B, C:', views[0]);
    if (new Set(views).size !== 1) fail(`clients disagree on research:\n${views.join('\n')}`);
    const [va, vb] = views[0].split(' / ');
    if (!va.split('|')[2].split(',').includes('destroyers') || !vb.split('|')[2].split(',').includes('navalMines')) fail('the orders did not land');
    const common = await compareHashes([A.page, B.page, C.page], 10);
    log(`game 1: hashes agree on ${common.length} turns (${common[0]}..${common[common.length - 1]})`);
    const desync = await Promise.all([A.page, B.page, C.page].map((p) => p.evaluate(() => window.__borderfall.mp().desync)));
    if (desync.some(Boolean)) fail('game 1: a client was told it desynced');
    await shot(C.page, 'g1-spectator');
    await closeAll([A, B, C]);
  }

  // ================================================================ game 2: every tech, variant units in use
  {
    const { A, B, C } = await lobby(['Very high', 'Instant', 'All unlocked'], []);
    log('game 2 playing');
    const t0 = Date.now();
    while (Date.now() - t0 < 300000) {
      await Promise.all([economy(A.page), economy(B.page)]);
      const m = await me(A.page);
      if (m.iron > 900 && m.oil > 400) break;
      await sleep(3000);
    }
    log('economy A', JSON.stringify(await me(A.page)).slice(0, 120));
    const sites = {};
    for (const [label, pg] of [['A', A.page], ['B', B.page]]) {
      const r = {};
      for (const [key, coastal] of [['port', true], ['airfield', false], ['factory', false]]) {
        const t = await site(pg, coastal);
        if (t >= 0) await dispatch(pg, { type: 'build', building: key, tile: t });
        await sleep(1500);
      }
      await sleep(1500);
      for (const k of ['port', 'airfield', 'factory']) r[k] = (await ownBuildings(pg)).find((b) => b.type === k && b.left <= 0)?.tile ?? -1;
      sites[label] = r;
    }
    log('built', JSON.stringify(sites));
    if (sites.A.port < 0 || sites.A.airfield < 0 || sites.A.factory < 0) fail('A could not place port/airfield/factory');
    const orders = { A: ['carrier', 'submarine'], B: ['destroyer', 'battleship'] };
    log('resources before the ship orders', JSON.stringify(await Promise.all([A.page, B.page].map((pg) => pg.evaluate(() => { const s = window.__borderfall.getState(); const p = s.players[s.humanId]; return [Math.round(p.gold), Math.round(p.iron), Math.round(p.oil)]; })))));
    for (const [label, pg] of [['A', A.page], ['B', B.page]]) {
      const r = sites[label];
      if (r.port >= 0) for (const v of orders[label]) log(label, 'buildWarship', v, JSON.stringify(await dispatch(pg, { type: 'buildWarship', port: r.port, variant: v })));
      if (r.airfield >= 0) {
        await dispatch(pg, { type: 'buildAircraft', airfield: r.airfield, kind: 'bomber' });
        await dispatch(pg, { type: 'buildAircraft', airfield: r.airfield, kind: 'fighter' });
      }
      await dispatch(pg, { type: 'setArmyMix', armor: 0.5, artillery: 0.1 });
    }
    // A's ordered ships, seen at least once (a lone new submarine can be sunk by AI destroyers before the check below)
    const seenA = new Set();
    for (let k = 0; k < 40 && seenA.size < 2; k++) {
      for (const v of await A.page.evaluate(() => { const s = window.__borderfall.getState(); return s.units.filter((u) => u.owner === s.humanId && u.type === 'warship').map((u) => u.variant); })) seenA.add(v);
      await sleep(1000);
    }
    log('A ships seen', [...seenA].join(','));
    for (const [label, pg] of [['A', A.page], ['B', B.page]]) {
      if (sites[label].factory >= 0) log(label, 'tank', JSON.stringify(await dispatch(pg, { type: 'buildTankDivision', tile: sites[label].factory })));
    }
    // recon over the other capital, from each airfield
    // the nearest land of another nation (a capital if one is near) within recon reach (90 tiles) of the airfield
    const capOf = (pg, airfield) =>
      pg.evaluate((af) => {
        const s = window.__borderfall.getState();
        const w = s.map.width;
        const ax = af % w, ay = Math.floor(af / w);
        let best = -1, bd = 85;
        for (const p of s.players) if (p.id && p.id !== s.humanId && p.alive && p.capital >= 0) {
          const d = Math.hypot((p.capital % w) - ax, Math.floor(p.capital / w) - ay);
          if (d < bd) { bd = d; best = p.capital; }
        }
        if (best >= 0) return best;
        for (let i = 0; i < s.map.owner.length; i++) {
          const o = s.map.owner[i];
          if (o <= 0 || o === s.humanId) continue;
          const d = Math.hypot((i % w) - ax, Math.floor(i / w) - ay);
          if (d < bd) { bd = d; best = i; }
        }
        return best;
      }, airfield);
    const foeA = await capOf(A.page, sites.A.airfield);
    const foeB = await capOf(B.page, sites.B.airfield);
    log('recon targets', foeA, foeB);
    if (foeA < 0) fail('no foreign land within recon reach of A');
    const reconA = await dispatch(A.page, { type: 'reconFlight', airfield: sites.A.airfield, tile: foeA });
    const reconB = sites.B.airfield >= 0 ? await dispatch(B.page, { type: 'reconFlight', airfield: sites.B.airfield, tile: foeB }) : { ok: false, reason: 'no airfield' };
    log('recon A', JSON.stringify(reconA), 'B', JSON.stringify(reconB));
    if (!reconA.ok) fail(`A recon: ${reconA.reason}`);
    await sleep(8000);
    // A sends its wing on a strategic mission (bombers may fly from the carrier when it is closer)
    const mis = await dispatch(A.page, { type: 'setAirMission', airfield: sites.A.airfield, mission: 'strategic', target: foeA, refill: true });
    log('A strategic mission', JSON.stringify(mis));
    if (!mis.ok) fail(`A strategic mission: ${mis.reason}`);
    await sleep(10000);
    const units = await A.page.evaluate(() => {
      const s = window.__borderfall.getState();
      const by = {};
      for (const u of s.units) {
        const k = `${u.owner}:${u.type}${u.variant ? `/${u.variant}` : ''}`;
        by[k] = (by[k] ?? 0) + 1;
      }
      // still being built at a port / factory counts too (ships queue one after another)
      for (const q of s.unitQueue ?? []) {
        const k = `${q.owner}:${q.type}${q.variant ? `/${q.variant}` : ''}:queued`;
        by[k] = (by[k] ?? 0) + 1;
      }
      const sunk = (s.events ?? []).filter((e) => e.kind === 'unitLost' && e.players.includes(s.humanId)).map((e) => e.message).slice(-5);
      const mines = s.players.filter((p) => p.id && p.alive && p.techs.includes('navalMines')).reduce((n, p) => n + [...s.buildings.values()].filter((b) => b.owner === p.id && b.type === 'port' && b.buildLeft <= 0).length, 0);
      return { by, sunk, reveals: s.arsenal?.reveals?.length ?? 0, revealOwners: (s.arsenal?.reveals ?? []).map((r) => r.owner ?? r.viewer), recon: s.arsenal?.reconReady?.length ?? 0, mines };
    });
    log('game 2 units', JSON.stringify(units));
    const aId = (await me(A.page)).id;
    const has = (k) => Object.keys(units.by).some((x) => x.startsWith(`${aId}:`) && x.includes(k));
    if (!has('/carrier') && !seenA.has('carrier')) fail('A never had a carrier');
    if (!has('/submarine') && !seenA.has('submarine')) fail('A never had a submarine');
    if (!has('/submarine')) log('A submarine lost after it was built', JSON.stringify(units.sunk));
    if (!has('tankDivision')) fail('A has no tank division');
    if (!units.revealOwners.includes(aId) && !has('reconPlane')) fail('A recon plane neither flying nor revealing');
    if (units.mines < 1) fail('no minefield (port of a Naval Mines holder)');
    await shot(A.page, 'g2-a');
    await shot(B.page, 'g2-b');
    await shot(C.page, 'g2-spectator');
    const common = await compareHashes([A.page, B.page, C.page], 10);
    log(`game 2: hashes agree on ${common.length} turns (${common[0]}..${common[common.length - 1]})`);
    await sleep(15000);
    const common2 = await compareHashes([A.page, B.page, C.page], 10);
    if (common2[common2.length - 1] <= common[common.length - 1]) fail('no new common hashes');
    const desync = await Promise.all([A.page, B.page, C.page].map((p) => p.evaluate(() => window.__borderfall.mp().desync)));
    if (desync.some(Boolean)) fail('game 2: a client was told it desynced');
    await closeAll([A, B, C]);
  }
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
