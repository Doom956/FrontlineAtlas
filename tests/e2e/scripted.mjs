// The scripted players of the multiplayer e2e checks (mp-pillars, mp-arsenal): where to start and how to get iron,
// oil and room for a Port, an Airfield and a Factory, decided from the game state instead of luck.
// Every function here runs INSIDE the page (page.evaluate(fn, arg)): it may only use its argument and
// window.__borderfall (read the state; it never changes it), and returns plain data. The test dispatches the actions
// it returns as ordinary intents, like a player clicking.

/**
 * Start tiles on one half of the map, best first. A start claims the free land within the map's start radius (a
 * flood fill, like the sim), so the oil (and if possible the iron) a scripted player needs is inside its first
 * territory: a well (and a mine) can be built at once, without attacking anyone for them.
 * Tiers: 0 = oil, iron (well and mine sites far enough apart for the spacing rule) and coast inside the start;
 * 1 = oil and coast inside, iron near; 2 = oil and coast inside; 3 = oil near (taken by expanding), iron and coast
 * near; 4 = coast only.
 */
export function spawnCandidates({ side, count }) {
  const s = window.__borderfall.getState();
  const { width: w, height: h } = s.map;
  const T = s.map.terrain, RES = s.map.resource, OWN = s.map.owner, COAST = s.map.coastal, FALL = s.map.fallout;
  const R = { small: 5, medium: 6, large: 7, huge: 8 }[s.mapClass] ?? 6;
  const GAP = { small: 10, medium: 12, large: 14, huge: 15 }[s.mapClass] ?? 12;
  const minCap = R * 3 + 2 + 8;
  const land = (i) => T[i] > 1;
  const caps = s.players.filter((p) => p.id && p.id !== s.humanId && p.capital >= 0).map((p) => [p.capital % w, Math.floor(p.capital / w)]);
  // oil deposits on (or next to) our half
  const oilT = [];
  for (let i = 0; i < RES.length; i++) {
    if (RES[i] !== 2 || !land(i)) continue;
    const x = i % w;
    if (side === 'left' ? x < w / 2 + R : x >= w / 2 - R) oilT.push(i);
  }
  // distance to the nearest deposit of `res` within 16 tiles (99 if none): a scan of the square around the tile
  const nearest = (res, x, y) => {
    let d = 99;
    for (let dy = -16; dy <= 16; dy++) {
      const yy = y + dy;
      if (yy < 0 || yy >= h) continue;
      for (let dx = -16; dx <= 16; dx++) {
        const xx = x + dx;
        if (xx < 0 || xx >= w) continue;
        const j = yy * w + xx;
        if (RES[j] === res && land(j)) d = Math.min(d, Math.hypot(dx, dy));
      }
    }
    return d;
  };
  const disk = (c) => {
    const cx = c % w, cy = Math.floor(c / w);
    const seen = new Set([c]);
    const out = [];
    const stack = [c];
    while (stack.length) {
      const i = stack.pop();
      out.push(i);
      const x = i % w, y = Math.floor(i / w);
      for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1]) {
        if (j < 0 || seen.has(j)) continue;
        seen.add(j);
        const dx = (j % w) - cx, dy = Math.floor(j / w) - cy;
        if (dx * dx + dy * dy > R * R) continue;
        if (!land(j) || OWN[j] !== 0 || FALL[j] > 0) continue;
        stack.push(j);
      }
    }
    return out;
  };
  const cheb2 = (a, b) => Math.max(Math.abs((a % w) - (b % w)), Math.abs(Math.floor(a / w) - Math.floor(b / w))) <= 2;
  const dist = (a, b) => Math.hypot((a % w) - (b % w), Math.floor(a / w) - Math.floor(b / w));
  const okTile = (i) => {
    const x = i % w, y = Math.floor(i / w);
    if (x < 8 || y < 8 || x >= w - 8 || y >= h - 8) return false;
    if ((side === 'left') !== (x < w / 2)) return false;
    if (!land(i) || OWN[i] !== 0 || FALL[i] > 0) return false;
    for (const [px, py] of caps) if (Math.hypot(px - x, py - y) < minCap) return false;
    return true;
  };
  // candidate centres: free land within R + 1 of an oil deposit on our half (tiers 0-2), plus a coarse grid (3-4)
  const cand = new Set();
  for (const o of oilT) {
    const ox = o % w, oy = Math.floor(o / w);
    for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
      if (dx * dx + dy * dy > R * R) continue;
      const x = ox + dx, y = oy + dy;
      if (x < 0 || y < 0 || x >= w || y >= h) continue;
      if (okTile(y * w + x)) cand.add(y * w + x);
    }
  }
  // land connected to a tile, counted up to `cap` (a small island leaves no room to grow: the scripted players do
  // not sail)
  const comp = new Int32Array(T.length).fill(-1);
  const compSize = [];
  const landmass = (c, cap) => {
    if (comp[c] >= 0) return compSize[comp[c]];
    const id = compSize.length;
    let n = 0;
    const stack = [c];
    comp[c] = id;
    while (stack.length && n < cap) {
      const i = stack.pop();
      n++;
      const x = i % w;
      for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, i - w, i + w]) {
        if (j < 0 || j >= T.length || !land(j)) continue;
        if (comp[j] >= 0) {
          if (comp[j] !== id && compSize[comp[j]] >= cap) n = cap; // part of a mass already known to be big
          continue;
        }
        comp[j] = id;
        stack.push(j);
      }
    }
    // a capped count leaves part of the mass unlabelled: a later count that reaches it is big too (above)
    compSize.push(Math.min(n, cap));
    return n;
  };
  const BIG = 3000;
  const scored = [];
  const score = (c) => {
    const cx = c % w, cy = Math.floor(c / w);
    const D = disk(c);
    if (D.length < R * R * 2) return; // a sliver of land (most of the disk is water or taken)
    const mass = landmass(c, BIG);
    const coast = D.some((i) => COAST[i]);
    const oilIn = D.filter((i) => RES[i] === 2);
    const ironIn = D.filter((i) => RES[i] === 1);
    const wellSites = oilIn.length ? D.filter((i) => oilIn.some((o) => cheb2(i, o))) : [];
    const mineSites = ironIn.length ? D.filter((i) => ironIn.some((o) => cheb2(i, o))) : [];
    let pair = false;
    for (const a of wellSites) {
      for (const b of mineSites) if (dist(a, b) >= GAP) { pair = true; break; }
      if (pair) break;
    }
    const ironNear = ironIn.length ? 0 : nearest(1, cx, cy);
    const oilNear = oilIn.length ? 0 : nearest(2, cx, cy);
    const coastNear = coast;
    let tier;
    if (oilIn.length && coast && pair) tier = 0;
    else if (oilIn.length && coast && ironNear <= 16) tier = 1;
    else if (oilIn.length && coast) tier = 2;
    else if (coastNear && oilNear <= 16 && ironNear <= 16) tier = 3;
    else if (coastNear) tier = 4;
    else return;
    if (mass < BIG) tier += 10; // only if nothing else is left
    // within a tier: more land at the start, deposits closer
    scored.push([tier, -D.length + ironNear * 2 + oilNear * 2, c]);
  };
  for (const c of cand) score(c);
  // no oil start on a big landmass: a coarse grid over our half (oil and iron near, or at least a coast)
  if (!scored.some((e) => e[0] <= 2)) for (let y = 8; y < h - 8; y += 4) for (let x = 8; x < w - 8; x += 4) if (okTile(y * w + x)) score(y * w + x);
  scored.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
  return scored.slice(0, count ?? 12).map((e) => ({ tile: e[2], tier: e[0] }));
}

/**
 * One step of a scripted player's economy: the actions to send now (the caller dispatches them in order) and what
 * it is doing. Order: an oil well on own oil, a mine on own iron, mines and wells up to `level`, then Port, Airfield
 * and Factory sites (`want`) once the land has room for them, and growth: an attack on wilderness or a tribe (never
 * another nation) toward oil, then iron, then any free land, until `land` tiles. `avoid` lists target tiles that
 * made no progress (the caller tracks them), `gap` the spacing kept from own buildings for new big buildings.
 */
export function economyStep({ want, level, land, avoid, gap, mineCount, attackShare, skip }) {
  const s = window.__borderfall.getState();
  const me = s.humanId;
  const p = s.players[me];
  const w = s.map.width;
  const T = s.map.terrain, RES = s.map.resource, OWN = s.map.owner, B = s.map.building, COAST = s.map.coastal, FALL = s.map.fallout;
  const SP = { small: 10, medium: 12, large: 14, huge: 15 }[s.mapClass] ?? 12;
  const cap = p.capital;
  const cx = cap % w, cy = Math.floor(cap / w);
  const actions = [];
  const notes = {};
  if (!p.alive) return { actions, notes: { dead: true } };
  const all = [...s.buildings.values()];
  const mine = all.filter((b) => b.owner === me);
  const has = (type) => mine.filter((b) => b.type === type);
  // types ordered a moment ago: the order may not have landed yet (online it runs on the next turn), and a second
  // order of the same type would upgrade the first building instead
  const busy = new Set(skip ?? []);
  const tooClose = (i, g) => all.some((b) => Math.hypot((b.tile % w) - (i % w), Math.floor(b.tile / w) - Math.floor(i / w)) < g);
  // own tiles that can take a new building next to an own deposit of `res`, nearest the capital first
  const depositSites = (res) => {
    const out = [];
    const seen = new Set();
    for (let i = 0; i < OWN.length; i++) {
      if (OWN[i] !== me || RES[i] !== res) continue;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
        const j = i + dy * w + dx;
        if (j < 0 || j >= OWN.length || seen.has(j) || OWN[j] !== me || T[j] <= 1 || B[j] !== 0 || FALL[j] > 0) continue;
        seen.add(j);
        if (tooClose(j, SP)) continue;
        out.push([Math.hypot((j % w) - cx, Math.floor(j / w) - cy), j]);
      }
    }
    return out.sort((a, b) => a[0] - b[0] || a[1] - b[1]).map((e) => e[1]);
  };
  const apart = (a, b) => Math.hypot((a % w) - (b % w), Math.floor(a / w) - Math.floor(b / w)) >= SP;
  const wells = has('oilWell'), mines = has('mine');
  const needWell = !wells.length, needMine = mines.length < (mineCount ?? 1);
  // a mine first (a well costs iron, and nobody starts with any), on a site that leaves room for a well when both are
  // missing (buildings keep SP tiles apart, and a start is not much wider than that)
  const ws = needWell ? depositSites(2) : [];
  const ms = needMine ? depositSites(1) : [];
  let mt = ms.length ? ms[0] : -1, wt = ws.length ? ws[0] : -1;
  if (mt >= 0 && wt >= 0 && !apart(mt, wt)) {
    let pair = null;
    for (const a of ms) {
      const b = ws.find((x) => apart(a, x));
      if (b !== undefined) { pair = [a, b]; break; }
    }
    if (pair) [mt, wt] = pair;
    else if (mines.length) mt = -1; // one mine is enough: keep the oil site free
    else wt = -1; // no room for both yet: the mine now, the well once the land has grown
  }
  if (mt >= 0 && !busy.has('mine')) actions.push({ type: 'build', building: 'mine', tile: mt });
  if (wt >= 0 && !busy.has('oilWell')) actions.push({ type: 'build', building: 'oilWell', tile: wt });
  notes.well = needWell ? (ws.length ? wt : -1) : -3;
  notes.mine = needMine ? (ms.length ? mt : -1) : -3;
  // upgrades (a build order on an own building of the same type raises it a level)
  for (const b of [...wells, ...mines]) if (b.level < (level ?? 1) && b.buildLeft <= 0 && b.upgradeLeft <= 0 && !busy.has(b.type)) actions.push({ type: 'build', building: b.type, tile: b.tile });
  // the big buildings, each on a free own tile `gap` from every building (coastal for the Port), nearest the capital
  const placed = {};
  // not before the well and the mine (unless the land has no site for them yet): a big building near the capital
  // could take the room they need
  const bigOk = (!needWell || ws.length === 0) && (!needMine || ms.length === 0);
  for (const type of bigOk ? want ?? [] : []) {
    const done = has(type);
    if (done.length) { placed[type] = done[0].buildLeft <= 0 ? done[0].tile : -2; continue; }
    if (busy.has(type)) { placed[type] = -2; continue; }
    // a margin over the spacing rule first, then the rule itself (a small land may only fit them that way)
    let best = -1;
    for (const g of [gap ?? SP + 2, SP]) {
      let bd = 1e9;
      for (let i = 0; i < OWN.length; i++) {
        if (OWN[i] !== me || T[i] <= 1 || B[i] !== 0 || FALL[i] > 0) continue;
        if (type === 'port' && !COAST[i]) continue;
        if (type === 'airfield' && (T[i] === 5 || T[i] === 7)) continue;
        const d = Math.hypot((i % w) - cx, Math.floor(i / w) - cy);
        if (d >= bd) continue;
        if (tooClose(i, g)) continue;
        if (actions.some((a) => a.tile !== undefined && Math.hypot((a.tile % w) - (i % w), Math.floor(a.tile / w) - Math.floor(i / w)) < g)) continue;
        bd = d; best = i;
      }
      if (best >= 0) break;
    }
    // -1: no room yet; -2: ordered now (finished buildings are listed by tile above)
    placed[type] = best >= 0 ? -2 : -1;
    if (best >= 0) actions.push({ type: 'build', building: type, tile: best });
  }
  notes.placed = placed;
  // growth: what to head for
  let goal = -1, goalKind = 'land';
  const free = (i) => OWN[i] === 0 || s.players[OWN[i]]?.personality === 'tribe';
  const avoidSet = new Set(avoid ?? []);
  const nearestFree = (res) => {
    let best = -1, bd = 1e9;
    for (let i = 0; i < RES.length; i++) {
      if (RES[i] !== res || T[i] <= 1 || OWN[i] === me || !free(i) || avoidSet.has(i)) continue;
      const d = Math.hypot((i % w) - cx, Math.floor(i / w) - cy);
      if (d < bd) { bd = d; best = i; }
    }
    return best;
  };
  const needRoom = Object.values(placed).some((t) => t === -1);
  if (needWell && wt < 0) {
    goalKind = 'oil';
    if (ws.length === 0) goal = nearestFree(2);
  } else if (needMine && mt < 0) {
    goalKind = 'iron';
    if (ms.length === 0) goal = nearestFree(1);
  } else if (p.tiles < (land ?? 0) || needRoom) goalKind = 'land';
  else goalKind = 'none';
  // the attack tile: a free (wilderness or tribe) land tile next to our border, nearest the goal (or the capital)
  let pick = -1, pd = 1e9;
  if (goalKind !== 'none') {
    const gx = goal >= 0 ? goal % w : cx, gy = goal >= 0 ? Math.floor(goal / w) : cy;
    for (let i = 0; i < OWN.length; i++) {
      if (OWN[i] !== me) continue;
      const x = i % w;
      for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, i + w, i - w]) {
        if (j < 0 || j >= OWN.length || OWN[j] === me || T[j] <= 1 || !free(j)) continue;
        const d = Math.hypot((j % w) - gx, Math.floor(j / w) - gy);
        if (d < pd) { pd = d; pick = j; }
      }
    }
  }
  // nothing free next to us (nations and water all round): a free coast across the water (the attack order sends a
  // transport from our nearest coast)
  if (goalKind !== 'none' && pick < 0) {
    const gx = goal >= 0 ? goal % w : cx, gy = goal >= 0 ? Math.floor(goal / w) : cy;
    for (let i = 0; i < OWN.length; i++) {
      if (!COAST[i] || T[i] <= 1 || OWN[i] === me || !free(i) || avoidSet.has(i)) continue;
      const d = Math.hypot((i % w) - gx, Math.floor(i / w) - gy);
      if (d < pd && Math.hypot((i % w) - cx, Math.floor(i / w) - cy) < 80) { pd = d; pick = i; }
    }
    notes.boat = pick;
  }
  const infantry = p.troops.infantry;
  const mineAtt = s.attacks.filter((a) => a.attacker === me);
  if (pick >= 0 && infantry > 400 && mineAtt.length < 6) {
    actions.push({ type: 'attack', tile: pick, troops: { infantry: Math.floor(infantry * (attackShare ?? 0.5)), armor: 0, artillery: 0 } });
  }
  // what the border touches (wilderness, tribes, nations, water) and the running attacks: for the log
  const border = { w: 0, t: 0, n: 0, s: 0 };
  for (let i = 0; i < OWN.length; i++) {
    if (OWN[i] !== me) continue;
    const x = i % w;
    for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, i + w, i - w]) {
      if (j < 0 || j >= OWN.length || OWN[j] === me) continue;
      if (T[j] <= 1) border.s++;
      else if (OWN[j] === 0) border.w++;
      else if (s.players[OWN[j]]?.personality === 'tribe') border.t++;
      else border.n++;
    }
  }
  notes.border = border;
  notes.inf = Math.round(infantry);
  notes.att = mineAtt.map((a) => `${a.target}:${Math.round(a.troops.infantry)}`).join(' ');
  notes.pick = pick;
  notes.goal = goal;
  notes.goalKind = goalKind;
  notes.dist = goal >= 0 ? Math.round(pd * 10) / 10 : null;
  notes.tiles = p.tiles;
  notes.iron = Math.round(p.iron);
  notes.oil = Math.round(p.oil);
  notes.gold = Math.round(p.gold);
  notes.wells = wells.map((b) => b.level);
  notes.mines = mines.map((b) => b.level);
  return { actions, notes };
}

/**
 * Node side: a scripted player's economy loop state. `evaluate(fn, arg)` runs a function above in the player's page,
 * `dispatch(action)` sends an intent. A growth goal whose distance has not shrunk for `patience` steps (a defended
 * tribe, land behind water) is given up and the next one is tried.
 */
export function economyDriver(label, evaluate, dispatch, log = () => {}, patience = 10) {
  const avoid = [];
  const sent = new Map();
  let step = 0;
  let goal = -1, best = 1e9, stale = 0, lastTiles = 0, flat = 0;
  return async (opts = {}) => {
    step++;
    const skip = [...sent].filter(([, k]) => step - k <= 1).map(([t]) => t);
    const r = await evaluate(economyStep, { ...opts, avoid, skip });
    for (const a of r.actions) {
      await dispatch(a);
      if (a.type === 'build') sent.set(a.building, step);
    }
    const n = r.notes;
    // growth that stalls is logged with what the border touches (for the next person reading a failed run)
    if (n.goalKind !== 'none' && n.tiles <= lastTiles) {
      if (++flat % 5 === 0) log(label, 'land not growing', JSON.stringify(n));
    } else flat = 0;
    lastTiles = n.tiles;
    if (n.goal >= 0 && n.dist !== null) {
      if (n.goal !== goal) {
        goal = n.goal;
        best = n.dist;
        stale = 0;
      } else if (n.dist < best - 0.5) {
        best = n.dist;
        stale = 0;
      } else if (++stale >= patience) {
        avoid.push(goal);
        log(label, `no progress toward ${n.goalKind} at ${goal} (distance ${n.dist}): trying another`);
        goal = -1;
      }
    }
    return n;
  };
}
