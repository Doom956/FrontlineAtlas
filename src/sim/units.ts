// Mobile units: transports, warships, trade ships, bombers, fighters, rockets, atom bombs (DESIGN section 7).
//
// Positions are float tile coordinates (x, y of the tile; the renderer adds 0.5 for the tile centre). Effects use
// tile-centre coordinates (+0.5). Ships follow `path` (water tiles); aircraft and missiles fly straight.
//
// How each unit type uses the generic Unit fields:
//   transport  home = launch tile, target = landing tile, troops = cargo, cargo = speed (tiles/s),
//              targetOwner = owner of the landing tile at launch
//   warship    home = its port, target = current destination, cargo = patrol centre tile,
//              state 0 = patrolling around the centre, 1 = sailing to a commanded tile (becomes the new centre)
//   tradeShip  home = origin port tile, target = destination port tile, targetOwner = its owner,
//              cargo = gold paid to each owner on arrival
//   bomber     home = airfield tile, target = where it is flying now, state 0 = outbound, 1 = returning
//   rocket / atomBomb  home = silo tile, target = impact tile, targetOwner = owner of that tile at launch
// Fighters are never units: they stay stored on their airfield (Building.fighters) and intercept from there.
import { buildingAt, buildingsOf, countBuildings, destroyBuilding, watchtowerRadius } from './buildings';
import { launchAttack } from './combat';
import {
  AIRCRAFT_MAX_PER_AIRFIELD,
  ATOM_CORE_RADIUS,
  ATOM_KILL_SHARE,
  ATOM_RADIUS,
  BOMBER_BUILDING_HIT,
  BOMBER_MIN_KILL,
  BOMBER_RADIUS,
  BOMBER_TROOP_KILL,
  BUILDINGS,
  FALLOUT_SECONDS,
  FIGHTER_INTERCEPT,
  MIN_ATTACK_TROOPS,
  NAVIGATION_TRANSPORT_SPEED,
  NUKE_OPINION_PENALTY,
  PORT_TRANSPORT_SPEED,
  ROCKET_KILL_MIN,
  ROCKET_RADIUS,
  SAM_COOLDOWN,
  SAM_HIT,
  SILO_COOLDOWN,
  TICK_SECONDS,
  TICKS_PER_SECOND,
  TRADE_GOLD_PER_TILE,
  TRADE_INTERVAL,
  TRANSPORT_MAX_AT_SEA,
  TRANSPORT_PER_PORT,
  UNITS,
  WARSHIP_BOMBARD_KILL,
  WARSHIP_DAMAGE_PER_S,
  WARSHIP_RANGE,
} from './config';
import { areAllied, canTrade, changeOpinion } from './diplomacy';
import { distanceField, forEachInRadius, neighbors4, waterPath } from './grid';
import { addEvent, newId, setOwner } from './state';
import { hasTech } from './tech';
import { TROOP_TYPES, isWater } from './types';
import type { ActionResult, Building, BuildingType, GameState, Troops, Unit, UnitType } from './types';

const FAIL = (reason: string): ActionResult => ({ ok: false, reason });

// ---------- tuning that config.ts leaves to this module ----------
/** Warships on patrol wander to water tiles within this many tiles of their patrol centre. */
export const WARSHIP_PATROL_RADIUS = 15;
/** Chance per tick that an idle patrolling warship picks a new wander point (about 1 s pause on average). */
const WARSHIP_WANDER_CHANCE = 0.1;
/** Rocket troop kill: this share of the army living in the blast area (at least ROCKET_KILL_MIN, at most the army). */
export const ROCKET_TROOP_KILL = 0.25;
/** At most one 'tradeDelivered' event per human player per this many seconds. */
const TRADE_EVENT_SECONDS = 60;
/** Cached water paths between ports (terrain never changes); the cache is cleared when it grows past this. */
const PATH_CACHE_MAX = 4096;
/** New (uncached) trade route searches per tick; ports over the budget retry next tick (spreads BFS cost). */
const TRADE_SEARCHES_PER_TICK = 1;

// ---------- per-unit bookkeeping that does not need to live in GameState ----------
interface UnitMemo {
  /** building ids (SAMs, airfields) that already rolled an intercept against this unit on its current pass */
  rolled: Set<number>;
  /** human player ids already warned about this unit by a watchtower */
  warned: Set<number>;
}
const memos = new WeakMap<Unit, UnitMemo>();
function memo(u: Unit): UnitMemo {
  let m = memos.get(u);
  if (!m) {
    m = { rolled: new Set(), warned: new Set() };
    memos.set(u, m);
  }
  return m;
}

// ---------- small helpers ----------
const zeroTroops = (): Troops => ({ infantry: 0, armor: 0, artillery: 0 });
function troopTotal(t: Troops): number {
  return t.infantry + t.armor + t.artillery;
}
function isTile(state: GameState, t: number): boolean {
  return Number.isInteger(t) && t >= 0 && t < state.map.width * state.map.height;
}
function isFinished(b: Building | undefined, owner: number, type: BuildingType): b is Building {
  return !!b && b.owner === owner && b.type === type && b.buildLeft <= 0;
}
function canPay(state: GameState, playerId: number, type: UnitType): string | null {
  const p = state.players[playerId];
  const c = UNITS[type];
  if (p.gold < c.gold) return `Not enough gold (${c.gold})`;
  if (p.iron < c.iron) return `Not enough iron (${c.iron})`;
  if (p.oil < c.oil) return `Not enough oil (${c.oil})`;
  return null;
}
function pay(state: GameState, playerId: number, type: UnitType): void {
  const p = state.players[playerId];
  const c = UNITS[type];
  p.gold -= c.gold;
  p.iron -= c.iron;
  p.oil -= c.oil;
}
function makeUnit(state: GameState, type: UnitType, owner: number, home: number, target: number): Unit {
  const w = state.map.width;
  return {
    id: newId(state),
    type,
    owner,
    x: home % w,
    y: (home / w) | 0,
    target,
    home,
    path: [],
    pathPos: 0,
    troops: zeroTroops(),
    hp: UNITS[type].hp,
    cargo: 0,
    state: 0,
    targetOwner: 0,
  };
}
/** Squared distance from a unit to a tile. */
function d2To(state: GameState, u: Unit, tile: number): number {
  const w = state.map.width;
  const dx = (tile % w) - u.x;
  const dy = ((tile / w) | 0) - u.y;
  return dx * dx + dy * dy;
}
function unitTile(state: GameState, u: Unit): number {
  return Math.round(u.y) * state.map.width + Math.round(u.x);
}
/** Water tile a ship is on (or heading to). */
function shipTile(state: GameState, u: Unit): number {
  if (u.path.length) return u.path[Math.min(u.pathPos, u.path.length - 1)];
  return unitTile(state, u);
}
/** Hostile = two different real players that are not allied. */
function hostile(state: GameState, a: number, b: number): boolean {
  return a !== b && a > 0 && b > 0 && !areAllied(state, a, b);
}

/** Straight-line move toward a tile; returns true on arrival. */
function moveStraight(state: GameState, u: Unit, tile: number, speed: number): boolean {
  const w = state.map.width;
  const tx = tile % w;
  const ty = (tile / w) | 0;
  const dx = tx - u.x;
  const dy = ty - u.y;
  const d = Math.sqrt(dx * dx + dy * dy);
  const step = speed * TICK_SECONDS;
  if (d <= step) {
    u.x = tx;
    u.y = ty;
    return true;
  }
  u.x += (dx / d) * step;
  u.y += (dy / d) * step;
  return false;
}
/** Moves along u.path; returns true when the end of the path is reached. */
function followPath(state: GameState, u: Unit, speed: number): boolean {
  const w = state.map.width;
  let step = speed * TICK_SECONDS;
  while (step > 0 && u.pathPos < u.path.length) {
    const t = u.path[u.pathPos];
    const dx = (t % w) - u.x;
    const dy = ((t / w) | 0) - u.y;
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d <= step) {
      u.x = t % w;
      u.y = (t / w) | 0;
      u.pathPos++;
      step -= d;
    } else {
      u.x += (dx / d) * step;
      u.y += (dy / d) * step;
      step = 0;
    }
  }
  return u.pathPos >= u.path.length;
}

/**
 * Kills up to `amount` units of a player's home army. infantryFirst: infantry, then artillery, then armor
 * (warship shelling hits the coast garrison); otherwise split by composition. Updates stats; returns units killed.
 */
function killTroops(state: GameState, victim: number, amount: number, killer: number, infantryFirst: boolean): number {
  if (victim <= 0 || amount <= 0) return 0;
  const p = state.players[victim];
  if (!p || !p.alive) return 0;
  const t = p.troops;
  const tot = troopTotal(t);
  const u = Math.min(amount, tot);
  if (u <= 0) return 0;
  if (infantryFirst) {
    let left = u;
    for (const k of ['infantry', 'artillery', 'armor'] as const) {
      const take = Math.min(left, t[k]);
      t[k] -= take;
      left -= take;
    }
  } else {
    for (const k of TROOP_TYPES) t[k] = Math.max(0, t[k] - (u * t[k]) / tot);
  }
  p.stats.troopsLost += u;
  if (killer > 0 && killer !== victim) state.players[killer].stats.troopsKilled += u;
  return u;
}

// ---------- water path cache (trade routes repeat) ----------
const pathCaches = new WeakMap<GameState, Map<number, number[] | null>>();
/**
 * Water path from the cache, else searched if budget.searches allows (and cached).
 * Returns undefined when the path is not cached and the budget is spent.
 */
function cachedWaterPath(state: GameState, from: number, to: number, budget: { searches: number }): number[] | null | undefined {
  let cache = pathCaches.get(state);
  if (!cache) {
    cache = new Map();
    pathCaches.set(state, cache);
  }
  const key = from * state.map.width * state.map.height + to;
  let p = cache.get(key);
  if (p === undefined) {
    if (budget.searches <= 0) return undefined;
    budget.searches--;
    if (cache.size >= PATH_CACHE_MAX) cache.clear();
    p = waterPath(state.map, from, to);
    cache.set(key, p);
  }
  return p ? p.slice() : null;
}

// ---------------------------------------------------------------------------------------------------------------
// Transports
// ---------------------------------------------------------------------------------------------------------------

/** Max transports a player may have at sea: base + per finished Port (+1 with Navigation). */
export function transportLimit(state: GameState, playerId: number): number {
  const p = state.players[playerId];
  if (!p) return 0;
  return TRANSPORT_MAX_AT_SEA + TRANSPORT_PER_PORT * countBuildings(state, playerId, 'port') + (hasTech(p, 'navigation') ? 1 : 0);
}
/** Transports of playerId currently at sea. */
export function transportsAtSea(state: GameState, playerId: number): number {
  let n = 0;
  for (const u of state.units) if (u.type === 'transport' && u.owner === playerId && u.hp > 0) n++;
  return n;
}
function isOwnPort(state: GameState, playerId: number, tile: number): boolean {
  return isFinished(buildingAt(state, tile), playerId, 'port');
}

/**
 * Own coastal tile with the fastest water route to `to` (water distance, divided by the port speed bonus for
 * finished own ports), with its path. One water BFS from the landing site plus one pass over the map.
 */
function findLaunchTile(state: GameState, playerId: number, to: number): { from: number; path: number[] } | null {
  const map = state.map;
  const { terrain, owner, coastal } = map;
  const nb: number[] = [];
  const goals: number[] = [];
  const k = neighbors4(map, to, nb);
  for (let q = 0; q < k; q++) if (isWater(terrain[nb[q]])) goals.push(nb[q]);
  if (!goals.length) return null;
  // 4-neighbour water BFS. waterPath forbids diagonal corner-cutting, so both see the same connectivity.
  const dist = distanceField(map, goals, (j) => isWater(terrain[j]), 2 * (map.width + map.height));
  const n = map.width * map.height;
  let best = -1;
  let bestCost = Infinity;
  for (let i = 0; i < n; i++) {
    if (owner[i] !== playerId || !coastal[i]) continue;
    const m = neighbors4(map, i, nb);
    let d = 65535;
    for (let q = 0; q < m; q++) if (isWater(terrain[nb[q]]) && dist[nb[q]] < d) d = dist[nb[q]];
    if (d === 65535) continue;
    const cost = isOwnPort(state, playerId, i) ? d / PORT_TRANSPORT_SPEED : d;
    if (cost < bestCost) {
      bestCost = cost;
      best = i;
    }
  }
  if (best < 0) return null;
  const path = waterPath(map, best, to);
  return path ? { from: best, path } : null;
}

/** from: an own coastal tile (a Port tile gives the port bonus), to: a coastal land tile of anyone but you/allies (or neutral). */
export function launchTransport(state: GameState, playerId: number, from: number, to: number, troops: Troops): ActionResult {
  const p = state.players[playerId];
  if (!p || playerId === 0 || !p.alive) return FAIL('No such player');
  const map = state.map;
  if (!isTile(state, to)) return FAIL('Invalid tile');
  if (isWater(map.terrain[to]) || !map.coastal[to]) return FAIL('Transports must land on a coastal land tile');
  const target = map.owner[to];
  if (target === playerId) return FAIL('That is your own land');
  if (target !== 0 && areAllied(state, playerId, target)) return FAIL('You cannot invade an ally');

  const sent = zeroTroops();
  for (const k of TROOP_TYPES) {
    const v = troops?.[k];
    sent[k] = typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0;
    if (sent[k] > p.troops[k] + 1e-6) return FAIL(`Not enough ${k}`);
    sent[k] = Math.min(sent[k], p.troops[k]);
  }
  if (troopTotal(sent) < MIN_ATTACK_TROOPS) return FAIL(`Send at least ${MIN_ATTACK_TROOPS} troops`);
  const limit = transportLimit(state, playerId);
  if (transportsAtSea(state, playerId) >= limit) return FAIL(`At most ${limit} transports at sea (Ports raise the limit)`);

  // Launch site: the given own coastal tile if it reaches the target, else the best own coastal tile.
  let route: { from: number; path: number[] } | null = null;
  if (isTile(state, from) && map.owner[from] === playerId && map.coastal[from]) {
    const path = waterPath(map, from, to);
    if (path) route = { from, path };
  }
  route ??= findLaunchTile(state, playerId, to);
  if (!route) return FAIL('No sea route from your coast to there');

  const fromPort = isOwnPort(state, playerId, route.from);
  if (!fromPort) {
    if (p.gold < UNITS.transport.gold) return FAIL(`Not enough gold (${UNITS.transport.gold})`);
    p.gold -= UNITS.transport.gold;
  }
  for (const k of TROOP_TYPES) p.troops[k] = Math.max(0, p.troops[k] - sent[k]);

  const u = makeUnit(state, 'transport', playerId, route.from, to);
  u.path = route.path;
  u.troops = sent;
  u.cargo = UNITS.transport.speed * (fromPort ? PORT_TRANSPORT_SPEED : 1) * (hasTech(p, 'navigation') ? NAVIGATION_TRANSPORT_SPEED : 1);
  u.targetOwner = target;
  state.units.push(u);
  return { ok: true };
}

/** Transport reached the water next to its landing tile. */
function landTransport(state: GameState, u: Unit): void {
  const map = state.map;
  const p = state.players[u.owner];
  const tile = u.target;
  const owner = map.owner[tile];
  const troops = u.troops;
  u.troops = zeroTroops();
  u.hp = 0;
  if (owner === u.owner || (owner !== 0 && areAllied(state, u.owner, owner))) {
    // Became own or allied land on the way: the troops just come home.
    for (const k of TROOP_TYPES) p.troops[k] += troops[k];
    return;
  }
  const res = launchAttack(state, u.owner, tile, troops, true);
  if (!res.ok) {
    // Own/allied land was handled above, so a failure means the landing was repelled (combat counted the losses).
    addEvent(state, 'unitLost', `${p.name}'s landing was repelled`, owner ? [u.owner, owner] : [u.owner], tile);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Warships
// ---------------------------------------------------------------------------------------------------------------

export function buildWarship(state: GameState, playerId: number, portTile: number): ActionResult {
  const p = state.players[playerId];
  if (!p || playerId === 0 || !p.alive) return FAIL('No such player');
  if (!isTile(state, portTile)) return FAIL('Invalid tile');
  const port = buildingAt(state, portTile);
  if (!isFinished(port, playerId, 'port')) return FAIL('Warships are built at a finished Port of yours');
  if (!hasTech(p, 'navigation')) return FAIL('Needs research: Navigation');
  const bad = canPay(state, playerId, 'warship');
  if (bad) return FAIL(bad);
  const nb: number[] = [];
  const k = neighbors4(state.map, portTile, nb);
  let water = -1;
  for (let q = 0; q < k && water < 0; q++) if (isWater(state.map.terrain[nb[q]])) water = nb[q];
  if (water < 0) return FAIL('This port has no open water');
  pay(state, playerId, 'warship');
  const u = makeUnit(state, 'warship', playerId, portTile, water);
  const w = state.map.width;
  u.x = water % w;
  u.y = (water / w) | 0;
  u.path = [water];
  u.pathPos = 1;
  u.cargo = water;
  state.units.push(u);
  return { ok: true };
}

export function moveWarship(state: GameState, playerId: number, unitId: number, tile: number): ActionResult {
  const u = state.units.find((q) => q.id === unitId);
  if (!u || u.type !== 'warship' || u.owner !== playerId || u.hp <= 0) return FAIL('No such warship');
  if (!isTile(state, tile)) return FAIL('Invalid tile');
  const map = state.map;
  if (!isWater(map.terrain[tile]) && !map.coastal[tile]) return FAIL('Warships sail on water');
  const path = waterPath(map, shipTile(state, u), tile);
  if (!path) return FAIL('Your warship cannot reach there');
  u.path = path;
  u.pathPos = 0;
  u.target = path[path.length - 1];
  u.state = 1;
  return { ok: true };
}

/** Picks a random reachable water tile near the patrol centre. */
function wander(state: GameState, u: Unit): void {
  const map = state.map;
  const w = map.width;
  const cx = u.cargo % w;
  const cy = (u.cargo / w) | 0;
  const r = WARSHIP_PATROL_RADIUS;
  for (let tries = 0; tries < 6; tries++) {
    const x = cx + Math.round((state.rng() * 2 - 1) * r);
    const y = cy + Math.round((state.rng() * 2 - 1) * r);
    if (x < 0 || y < 0 || x >= w || y >= map.height) continue;
    const t = y * w + x;
    if (!isWater(map.terrain[t]) || (x - cx) * (x - cx) + (y - cy) * (y - cy) > r * r) continue;
    const path = waterPath(map, shipTile(state, u), t, 3 * r);
    if (!path) continue;
    u.path = path;
    u.pathPos = 0;
    u.target = t;
    return;
  }
}

function isShip(u: Unit): boolean {
  return u.type === 'transport' || u.type === 'warship' || u.type === 'tradeShip';
}

/** Ship lost to a warship: troops aboard die, event. */
function sinkUnit(state: GameState, u: Unit, killer: number): void {
  u.hp = 0;
  const p = state.players[u.owner];
  const aboard = troopTotal(u.troops);
  if (aboard > 0) {
    p.stats.troopsLost += aboard;
    state.players[killer].stats.troopsKilled += aboard;
    u.troops = zeroTroops();
  }
  state.effects.push({ kind: 'explosion', x: u.x + 0.5, y: u.y + 0.5, radius: 1.5, tick: state.tick });
  const kp = state.players[killer];
  // Trade ships sink often; only tell humans about theirs (the event log is shared and capped).
  if (u.type === 'tradeShip' && !p.isHuman && !kp.isHuman) return;
  const what = u.type === 'transport' ? `transport with ${Math.round(aboard)} troops` : UNITS[u.type].name.toLowerCase();
  addEvent(state, 'unitLost', `${p.name} lost a ${what} to ${kp.name}'s warship`, [u.owner, killer], unitTile(state, u));
}

/** Players with an attack running against each other, as a*1024+b in both orders. */
function warPairs(state: GameState): Set<number> {
  const s = new Set<number>();
  for (const a of state.attacks) {
    if (a.target <= 0 || troopTotal(a.troops) <= 0) continue;
    s.add(a.attacker * 1024 + a.target);
    s.add(a.target * 1024 + a.attacker);
  }
  return s;
}

function updateWarship(state: GameState, u: Unit, ships: Unit[], wars: Set<number>): void {
  // Movement: sail to the commanded point, then patrol around it.
  if (followPath(state, u, UNITS.warship.speed)) {
    if (u.state === 1) {
      u.state = 0;
      u.cargo = shipTile(state, u);
    } else if (state.rng() < WARSHIP_WANDER_CHANCE) {
      wander(state, u);
    }
  }

  // Shoot the nearest hostile ship in range. Trade ships bound for us or an ally are left alone.
  let target: Unit | null = null;
  let bestD = WARSHIP_RANGE * WARSHIP_RANGE;
  for (const s of ships) {
    if (s === u || s.hp <= 0 || !hostile(state, u.owner, s.owner)) continue;
    if (s.type === 'tradeShip' && (s.targetOwner === u.owner || areAllied(state, s.targetOwner, u.owner))) continue;
    const dx = s.x - u.x;
    const dy = s.y - u.y;
    const d = dx * dx + dy * dy;
    if (d <= bestD) {
      bestD = d;
      target = s;
    }
  }
  const showShot = (state.tick + u.id) % TICKS_PER_SECOND === 0;
  if (target) {
    target.hp -= WARSHIP_DAMAGE_PER_S * TICK_SECONDS;
    if (showShot) state.effects.push({ kind: 'shot', x: u.x + 0.5, y: u.y + 0.5, x2: target.x + 0.5, y2: target.y + 0.5, radius: 0.5, tick: state.tick });
    if (target.hp <= 1e-9) sinkUnit(state, target, u.owner);
    return;
  }

  // No ship to fight: shell the nearest coast within half range of a player we are at war with.
  if (!wars.size) return;
  const map = state.map;
  const w = map.width;
  let bestTile = -1;
  let bestDist = Infinity;
  forEachInRadius(map, unitTile(state, u), WARSHIP_RANGE / 2, (i, d) => {
    if (d >= bestDist || !map.coastal[i]) return;
    const o = map.owner[i];
    if (o === 0 || o === u.owner || !wars.has(u.owner * 1024 + o) || areAllied(state, u.owner, o)) return;
    bestDist = d;
    bestTile = i;
  });
  if (bestTile < 0) return;
  killTroops(state, map.owner[bestTile], WARSHIP_BOMBARD_KILL * TICK_SECONDS, u.owner, true);
  if (showShot) {
    state.effects.push({ kind: 'shot', x: u.x + 0.5, y: u.y + 0.5, x2: (bestTile % w) + 0.5, y2: ((bestTile / w) | 0) + 0.5, radius: 0.5, tick: state.tick });
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Trade ships
// ---------------------------------------------------------------------------------------------------------------

const tradeEventTick = new WeakMap<GameState, Map<number, number>>();

/**
 * Port timer ran out: send a trade ship to a random reachable foreign port (allies weighted x2).
 * Returns false when the route search budget for this tick is spent (the caller retries next tick).
 */
function sendTradeShip(state: GameState, port: Building, ports: Building[], busy: Set<number>, budget: { searches: number }): boolean {
  if (busy.has(port.id)) return true; // one trade ship at sea per port
  const cands: Building[] = [];
  const weights: number[] = [];
  let sum = 0;
  for (const other of ports) {
    if (other.owner === port.owner || !canTrade(state, port.owner, other.owner)) continue;
    const wgt = areAllied(state, port.owner, other.owner) ? 2 : 1;
    cands.push(other);
    weights.push(wgt);
    sum += wgt;
  }
  // A few weighted draws; unreachable ports (other oceans) are dropped from the draw.
  for (let tries = 0; tries < 4 && cands.length; tries++) {
    let r = state.rng() * sum;
    let k = 0;
    while (k < cands.length - 1 && r >= weights[k]) r -= weights[k++];
    const dest = cands[k];
    const path = cachedWaterPath(state, port.tile, dest.tile, budget);
    if (path === undefined) return false;
    if (!path) {
      sum -= weights[k];
      cands.splice(k, 1);
      weights.splice(k, 1);
      continue;
    }
    const u = makeUnit(state, 'tradeShip', port.owner, port.tile, dest.tile);
    u.path = path;
    u.targetOwner = dest.owner;
    u.cargo = path.length * TRADE_GOLD_PER_TILE;
    state.units.push(u);
    busy.add(port.id);
    return true;
  }
  return true;
}

/** Gold to both owners (stats.goldEarned); a 'tradeDelivered' event for humans at most once a minute. */
function deliverTrade(state: GameState, u: Unit): void {
  u.hp = 0;
  const gold = u.cargo;
  let last = tradeEventTick.get(state);
  if (!last) {
    last = new Map();
    tradeEventTick.set(state, last);
  }
  for (const id of u.targetOwner === u.owner ? [u.owner] : [u.owner, u.targetOwner]) {
    const p = state.players[id];
    if (!p || id === 0 || !p.alive) continue;
    p.gold += gold;
    p.stats.goldEarned += gold;
    if (!p.isHuman) continue;
    const prev = last.get(id);
    if (prev !== undefined && state.tick - prev < TRADE_EVENT_SECONDS * TICKS_PER_SECOND) continue;
    last.set(id, state.tick);
    const partner = state.players[id === u.owner ? u.targetOwner : u.owner];
    addEvent(state, 'tradeDelivered', `Trade with ${partner?.name ?? 'a partner'} earned ${Math.round(gold)} gold`, [id], u.target);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Aircraft
// ---------------------------------------------------------------------------------------------------------------

/** Aircraft stored at an airfield plus its bombers out flying. */
function aircraftAt(state: GameState, b: Building): number {
  let n = b.bombers + b.fighters;
  for (const u of state.units) if (u.type === 'bomber' && u.home === b.tile && u.owner === b.owner && u.hp > 0) n++;
  return n;
}

/** Adds a stored bomber/fighter to an airfield (pay gold/iron/oil, max AIRCRAFT_MAX_PER_AIRFIELD). */
export function buildAircraft(state: GameState, playerId: number, airfieldTile: number, kind: 'bomber' | 'fighter'): ActionResult {
  const p = state.players[playerId];
  if (!p || playerId === 0 || !p.alive) return FAIL('No such player');
  if (kind !== 'bomber' && kind !== 'fighter') return FAIL('Invalid aircraft');
  if (!isTile(state, airfieldTile)) return FAIL('Invalid tile');
  const b = buildingAt(state, airfieldTile);
  if (!isFinished(b, playerId, 'airfield')) return FAIL('Aircraft are built at a finished Airfield of yours');
  const tech = UNITS[kind].tech;
  if (tech && !hasTech(p, tech)) return FAIL(`Needs research: ${tech}`);
  if (aircraftAt(state, b) >= AIRCRAFT_MAX_PER_AIRFIELD) return FAIL(`An airfield holds at most ${AIRCRAFT_MAX_PER_AIRFIELD} aircraft`);
  const bad = canPay(state, playerId, kind);
  if (bad) return FAIL(bad);
  pay(state, playerId, kind);
  if (kind === 'bomber') b.bombers++;
  else b.fighters++;
  return { ok: true };
}

/** Sends one stored bomber from the airfield to tile (enemy, not allied). */
export function launchBomber(state: GameState, playerId: number, airfieldTile: number, tile: number): ActionResult {
  const p = state.players[playerId];
  if (!p || playerId === 0 || !p.alive) return FAIL('No such player');
  if (!isTile(state, airfieldTile) || !isTile(state, tile)) return FAIL('Invalid tile');
  const b = buildingAt(state, airfieldTile);
  if (!isFinished(b, playerId, 'airfield')) return FAIL('Bombers fly from a finished Airfield of yours');
  if (b.bombers < 1) return FAIL('No bombers at this airfield');
  const target = state.map.owner[tile];
  if (target === 0) return FAIL('Nobody to bomb there');
  if (target === playerId) return FAIL('That is your own land');
  if (!state.players[target]?.alive) return FAIL('That nation is gone');
  if (areAllied(state, playerId, target)) return FAIL('You cannot bomb an ally');
  b.bombers--;
  const u = makeUnit(state, 'bomber', playerId, airfieldTile, tile);
  u.targetOwner = target;
  state.units.push(u);
  return { ok: true };
}

/**
 * Bombs fall: each hostile building in BOMBER_RADIUS is destroyed with BOMBER_BUILDING_HIT chance; each hostile
 * player with land there loses max(BOMBER_MIN_KILL x their share of the hit land, BOMBER_TROOP_KILL x army x
 * tiles hit / their tiles) troops, capped at their army.
 */
function dropBombs(state: GameState, u: Unit): void {
  const map = state.map;
  const tile = u.target;
  const owner = map.owner[tile];
  const w = map.width;
  state.effects.push({ kind: 'explosion', x: (tile % w) + 0.5, y: ((tile / w) | 0) + 0.5, radius: BOMBER_RADIUS, tick: state.tick });
  if (!hostile(state, u.owner, owner) || !state.players[owner].alive) return;
  let destroyed = 0;
  const hit = new Map<number, number>(); // hostile owner -> tiles in radius
  let hitTiles = 0;
  forEachInRadius(map, tile, BOMBER_RADIUS, (i) => {
    const o = map.owner[i];
    if (!hostile(state, u.owner, o)) return;
    hit.set(o, (hit.get(o) ?? 0) + 1);
    hitTiles++;
    const b = buildingAt(state, i);
    if (b && hostile(state, u.owner, b.owner) && state.rng() < BOMBER_BUILDING_HIT) {
      destroyBuilding(state, b);
      destroyed++;
    }
  });
  let killed = 0;
  for (const [o, n] of hit) {
    const p = state.players[o];
    const share = n / Math.max(1, p.tiles);
    const kill = Math.max((BOMBER_MIN_KILL * n) / hitTiles, BOMBER_TROOP_KILL * troopTotal(p.troops) * share);
    killed += killTroops(state, o, kill, u.owner, false);
  }
  const me = state.players[u.owner];
  const msg = `${me.name} bombed ${state.players[owner].name}: ${destroyed} building${destroyed === 1 ? '' : 's'} destroyed, ${Math.round(killed)} troops killed`;
  addEvent(state, 'bombing', msg, [u.owner, ...hit.keys()], tile);
}

/** Bomber back over its airfield: stored again, or lost if the airfield is gone or taken. */
function bomberHome(state: GameState, u: Unit): void {
  u.hp = 0;
  const b = buildingAt(state, u.home);
  if (b && b.type === 'airfield' && b.owner === u.owner) b.bombers++;
  else addEvent(state, 'unitLost', `${state.players[u.owner].name} lost a bomber: its airfield is gone`, [u.owner], u.home);
}

// ---------------------------------------------------------------------------------------------------------------
// Missiles
// ---------------------------------------------------------------------------------------------------------------

export function launchMissile(state: GameState, playerId: number, siloTile: number, kind: 'rocket' | 'atomBomb', tile: number): ActionResult {
  const p = state.players[playerId];
  if (!p || playerId === 0 || !p.alive) return FAIL('No such player');
  if (kind !== 'rocket' && kind !== 'atomBomb') return FAIL('Invalid missile');
  if (!isTile(state, siloTile) || !isTile(state, tile)) return FAIL('Invalid tile');
  const silo = buildingAt(state, siloTile);
  if (!isFinished(silo, playerId, 'silo')) return FAIL('Missiles fly from a finished Missile Silo of yours');
  const tech = UNITS[kind].tech;
  if (tech && !hasTech(p, tech)) return FAIL(`Needs research: ${tech}`);
  if (silo.cooldown > 0) return FAIL(`The silo is reloading (${Math.ceil(silo.cooldown)} s)`);
  const target = state.map.owner[tile];
  if (target === playerId) return FAIL('That is your own land');
  if (target !== 0 && areAllied(state, playerId, target)) return FAIL('You cannot fire at an ally');
  const bad = canPay(state, playerId, kind);
  if (bad) return FAIL(bad);
  pay(state, playerId, kind);
  silo.cooldown = SILO_COOLDOWN;
  const u = makeUnit(state, kind, playerId, siloTile, tile);
  u.targetOwner = target;
  state.units.push(u);
  if (target !== 0) {
    const what = kind === 'atomBomb' ? 'an atom bomb' : 'a rocket';
    addEvent(state, 'missile', `${p.name} launched ${what} at ${state.players[target].name}`, [playerId, target], tile);
  }
  return { ok: true };
}

/** Owned tiles per player inside the radius. */
function tilesInRadius(state: GameState, tile: number, r: number): Map<number, number> {
  const owner = state.map.owner;
  const out = new Map<number, number>();
  forEachInRadius(state.map, tile, r, (i) => {
    const o = owner[i];
    if (o !== 0) out.set(o, (out.get(o) ?? 0) + 1);
  });
  return out;
}

/** Rocket: hostile buildings in ROCKET_RADIUS destroyed; each hostile player with land there loses troops. */
function rocketImpact(state: GameState, u: Unit): void {
  const map = state.map;
  const tile = u.target;
  const w = map.width;
  state.effects.push({ kind: 'explosion', x: (tile % w) + 0.5, y: ((tile / w) | 0) + 0.5, radius: ROCKET_RADIUS, tick: state.tick });
  let destroyed = 0;
  forEachInRadius(map, tile, ROCKET_RADIUS, (i) => {
    const b = buildingAt(state, i);
    if (b && hostile(state, u.owner, b.owner)) {
      destroyBuilding(state, b);
      destroyed++;
    }
  });
  let killed = 0;
  const hitPlayers: number[] = [];
  for (const [o, n] of tilesInRadius(state, tile, ROCKET_RADIUS)) {
    const p = state.players[o];
    if (!hostile(state, u.owner, o) || !p.alive) continue;
    const kill = Math.max(ROCKET_KILL_MIN, ROCKET_TROOP_KILL * troopTotal(p.troops) * (n / Math.max(1, p.tiles)));
    killed += killTroops(state, o, kill, u.owner, false);
    hitPlayers.push(o);
  }
  const msg = `Rocket strike by ${state.players[u.owner].name}: ${destroyed} building${destroyed === 1 ? '' : 's'} destroyed, ${Math.round(killed)} troops killed`;
  addEvent(state, 'missile', msg, [u.owner, ...hitPlayers], tile);
}

// ---------- fallout ----------
// Tiles with fallout are kept in a list so the countdown never scans the map.
const falloutLists = new WeakMap<GameState, number[]>();
function falloutList(state: GameState): number[] {
  let list = falloutLists.get(state);
  if (!list) {
    // First use on this state: pick up any existing fallout with one scan.
    list = [];
    const f = state.map.fallout;
    for (let i = 0; i < f.length; i++) if (f[i] > 0) list.push(i);
    falloutLists.set(state, list);
  }
  return list;
}
function updateFallout(state: GameState): void {
  const list = falloutList(state);
  if (!list.length) return;
  const f = state.map.fallout;
  let k = 0;
  for (const i of list) {
    f[i] = Math.max(0, f[i] - TICK_SECONDS);
    if (f[i] > 1e-6) list[k++] = i;
    else f[i] = 0;
  }
  list.length = k;
}

/**
 * Atom bomb: every building in ATOM_RADIUS is destroyed (anyone's, the launcher's too), every player with land
 * there loses ATOM_KILL_SHARE (random in range) of the army share living there, land within ATOM_CORE_RADIUS turns
 * neutral with FALLOUT_SECONDS of fallout, and every other player's opinion of the launcher drops.
 */
function atomImpact(state: GameState, u: Unit): void {
  const map = state.map;
  const tile = u.target;
  const w = map.width;
  const launcher = state.players[u.owner];
  state.effects.push({ kind: 'nuke', x: (tile % w) + 0.5, y: ((tile / w) | 0) + 0.5, radius: ATOM_RADIUS, tick: state.tick });

  // Troops first, from tile counts before the core turns neutral.
  let killed = 0;
  for (const [o, n] of tilesInRadius(state, tile, ATOM_RADIUS)) {
    const p = state.players[o];
    if (!p.alive) continue;
    const share = ATOM_KILL_SHARE[0] + state.rng() * (ATOM_KILL_SHARE[1] - ATOM_KILL_SHARE[0]);
    killed += killTroops(state, o, share * troopTotal(p.troops) * Math.min(1, n / Math.max(1, p.tiles)), u.owner, false);
  }
  let destroyed = 0;
  forEachInRadius(map, tile, ATOM_RADIUS, (i) => {
    const b = buildingAt(state, i);
    if (b) {
      destroyBuilding(state, b);
      destroyed++;
    }
  });
  const list = falloutList(state);
  forEachInRadius(map, tile, ATOM_CORE_RADIUS, (i) => {
    if (isWater(map.terrain[i])) return;
    if (map.fallout[i] <= 0) list.push(i);
    map.fallout[i] = FALLOUT_SECONDS;
    if (map.owner[i] !== 0) setOwner(state, i, 0);
  });
  for (const q of state.players) {
    if (q.id !== 0 && q.id !== u.owner && q.alive) changeOpinion(state, q.id, u.owner, -NUKE_OPINION_PENALTY);
  }
  const victim = u.targetOwner > 0 ? ` on ${state.players[u.targetOwner].name}` : '';
  addEvent(state, 'nuke', `${launcher.name} dropped an atom bomb${victim}: ${destroyed} buildings destroyed, ${Math.round(killed)} troops killed`, [], tile);
}

// ---------------------------------------------------------------------------------------------------------------
// Interception and early warning
// ---------------------------------------------------------------------------------------------------------------

/**
 * SAMs (and, against bombers, airfields with fighters) of players hostile to the unit's owner get one roll per
 * unit per pass while it is in range. A SAM that fires reloads for SAM_COOLDOWN; one that is reloading may still
 * fire later in the pass. Fighters roll 1 - (1 - FIGHTER_INTERCEPT)^fighters and are not used up.
 * Returns true if the unit was shot down.
 */
function intercept(state: GameState, u: Unit, sams: Building[], airfields: Building[]): boolean {
  const m = memo(u);
  const kind = u.type as 'rocket' | 'atomBomb' | 'bomber';
  const w = state.map.width;
  const samR2 = BUILDINGS.sam.radius * BUILDINGS.sam.radius;
  for (const s of sams) {
    if (s.cooldown > 0 || m.rolled.has(s.id) || !hostile(state, u.owner, s.owner)) continue;
    if (d2To(state, u, s.tile) > samR2) continue;
    m.rolled.add(s.id);
    s.cooldown = SAM_COOLDOWN;
    state.effects.push({ kind: 'shot', x: (s.tile % w) + 0.5, y: ((s.tile / w) | 0) + 0.5, x2: u.x + 0.5, y2: u.y + 0.5, radius: 0.5, tick: state.tick });
    if (state.rng() < SAM_HIT[kind]) {
      shotDown(state, u, s.owner, 'SAM site');
      return true;
    }
  }
  if (u.type !== 'bomber') return false;
  const afR2 = BUILDINGS.airfield.radius * BUILDINGS.airfield.radius;
  for (const a of airfields) {
    if (a.fighters <= 0 || m.rolled.has(a.id) || !hostile(state, u.owner, a.owner)) continue;
    if (d2To(state, u, a.tile) > afR2) continue;
    m.rolled.add(a.id);
    if (state.rng() < 1 - Math.pow(1 - FIGHTER_INTERCEPT, a.fighters)) {
      shotDown(state, u, a.owner, 'fighters');
      return true;
    }
  }
  return false;
}

function shotDown(state: GameState, u: Unit, by: number, what: string): void {
  u.hp = 0;
  state.effects.push({ kind: 'explosion', x: u.x + 0.5, y: u.y + 0.5, radius: 1.5, tick: state.tick });
  const msg = `${state.players[by].name}'s ${what} shot down a ${UNITS[u.type].name.toLowerCase()} of ${state.players[u.owner].name}`;
  addEvent(state, 'unitLost', msg, [u.owner, by], unitTile(state, u));
}

/** One warning per unit and human player when a hostile bomber or transport enters one of their watchtowers' radius. */
function watchtowerWarnings(state: GameState, units: Unit[]): void {
  for (const h of state.players) {
    if (!h.isHuman || !h.alive || h.id === 0) continue;
    let towers: Building[] | null = null;
    for (const u of units) {
      if ((u.type !== 'bomber' && u.type !== 'transport') || u.hp <= 0 || !hostile(state, h.id, u.owner)) continue;
      const m = memo(u);
      if (m.warned.has(h.id)) continue;
      towers ??= buildingsOf(state, h.id, 'watchtower').filter((b) => b.buildLeft <= 0);
      if (!towers.length) break;
      const r = watchtowerRadius(state, h.id);
      if (!towers.some((t) => d2To(state, u, t.tile) <= r * r)) continue;
      m.warned.add(h.id);
      const toUs = state.map.owner[u.target] === h.id;
      const what = u.type === 'bomber' ? 'bomber' : `transport (${Math.round(troopTotal(u.troops))} troops)`;
      const msg = `Watchtower: an enemy ${what} of ${state.players[u.owner].name} is approaching${toUs ? ' your land' : ''}`;
      addEvent(state, toUs ? 'underAttack' : 'info', msg, [h.id], u.target);
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Tick
// ---------------------------------------------------------------------------------------------------------------

/** Moves every unit, resolves arrivals, interceptions, warship fights, trade ship spawning and delivery. */
export function updateUnits(state: GameState): void {
  const players = state.players;
  updateFallout(state);

  // One pass over buildings: SAM / silo reload timers and the defender and port lists.
  const sams: Building[] = [];
  const airfields: Building[] = [];
  const ports: Building[] = [];
  for (const b of state.buildings.values()) {
    if (b.buildLeft > 0) continue;
    if (b.type === 'sam') {
      if (b.cooldown > 0) b.cooldown = Math.max(0, b.cooldown - TICK_SECONDS);
      sams.push(b);
    } else if (b.type === 'silo') {
      if (b.cooldown > 0) b.cooldown = Math.max(0, b.cooldown - TICK_SECONDS);
    } else if (b.type === 'airfield') {
      if (b.fighters > 0) airfields.push(b);
    } else if (b.type === 'port') {
      ports.push(b);
    }
  }

  // Trade ships leave ports whose timer ran out (Building.cooldown is the port's trade timer).
  if (ports.length) {
    const busy = new Set<number>();
    for (const u of state.units) {
      if (u.type !== 'tradeShip' || u.hp <= 0) continue;
      const b = buildingAt(state, u.home);
      if (b) busy.add(b.id);
    }
    const budget = { searches: TRADE_SEARCHES_PER_TICK };
    for (const port of ports) {
      port.cooldown -= TICK_SECONDS;
      if (port.cooldown > 1e-9) continue;
      // Out of route searches this tick: stay at 0 and try again next tick.
      port.cooldown = sendTradeShip(state, port, ports, busy, budget) ? TRADE_INTERVAL : 0;
    }
  }

  const units = state.units;
  const ships = units.filter(isShip);
  const wars = units.some((u) => u.type === 'warship') ? warPairs(state) : new Set<number>();
  for (const u of units) {
    if (u.hp <= 0 || !players[u.owner]?.alive) continue;
    switch (u.type) {
      case 'transport':
        if (followPath(state, u, u.cargo > 0 ? u.cargo : UNITS.transport.speed)) landTransport(state, u);
        break;
      case 'tradeShip':
        if (followPath(state, u, UNITS.tradeShip.speed)) deliverTrade(state, u);
        break;
      case 'warship':
        updateWarship(state, u, ships, wars);
        break;
      case 'bomber': {
        const arrived = moveStraight(state, u, u.state === 0 ? u.target : u.home, UNITS.bomber.speed);
        if (intercept(state, u, sams, airfields) || !arrived) break;
        if (u.state === 0) {
          dropBombs(state, u);
          u.state = 1;
          u.target = u.home;
          memo(u).rolled.clear(); // the way home is a new pass
        } else {
          bomberHome(state, u);
        }
        break;
      }
      case 'rocket':
      case 'atomBomb': {
        const arrived = moveStraight(state, u, u.target, UNITS[u.type].speed);
        if (intercept(state, u, sams, airfields) || !arrived) break;
        u.hp = 0;
        if (u.type === 'rocket') rocketImpact(state, u);
        else atomImpact(state, u);
        break;
      }
      case 'fighter':
        // Fighters stay stored on airfields; a fighter unit should never exist.
        u.hp = 0;
        break;
    }
  }

  watchtowerWarnings(state, units);

  // Drop delivered, sunk, shot-down and orphaned units.
  if (state.units.some((u) => u.hp <= 0 || !players[u.owner]?.alive)) {
    state.units = state.units.filter((u) => u.hp > 0 && players[u.owner]?.alive);
  }
}
