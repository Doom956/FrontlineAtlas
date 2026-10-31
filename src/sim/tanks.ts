// Tank divisions: a commandable land unit (the land counterpart of warships).
//
// - Action buildTankDivision {tile}: at an own finished Factory; costs UNITS.tankDivision (gold, iron, oil) plus
//   TANK_DIVISION_TROOPS taken from the pool (armor first, with an infantry and artillery escort); built over
//   TANK_BUILD_SECONDS in state.unitQueue; at most TANK_PER_FACTORY_LEVEL per Factory level (alive + being built).
// - Action moveTankDivision {unitIds, tile}: own land = drive there over own land (a land path, loose formation);
//   enemy or neutral land within TANK_LAUNCH_REACH of own land = drive to the nearest own tile, then launch a
//   SPEARHEAD: the head runs along the line from that tile through the clicked tile, taking a band
//   TANK_SPEARHEAD_WIDTH wide, fast on plains and desert, slow in forests and hills, stopped by mountains and forts
//   unless the division brings artillery (TANK_ARTILLERY_SUPPORT). Every tile costs troops (a normal attack's losses
//   x TANK_SPEARHEAD_LOSS x terrain, more against an armor-heavy defence); the spearhead ends when the division is
//   spent (TANK_SPEARHEAD_MIN_SHARE), blocked, or at TANK_SPEARHEAD_MAX_DEPTH. A spent division disbands and its
//   leftovers go home; a strong one holds where it stopped.
// - A holding division defends the own land around it (combat.tileCost asks tankDefenseAt).
// - Bombers hurt divisions they hit (units.dropBombs calls bombDivisions).
//
// How a tank division uses the generic Unit fields:
//   home = the factory tile it was built at; troops = its strength; hp = 1 while it exists
//   state 0 = holding, 1 = driving to `target` over own land, 2 = driving to the launch tile (path end) to spearhead
//         toward `target`, 3 = spearhead running from `launch` toward `target`
//   path / pathPos = own-land route (states 1, 2); target = destination (1) or the far aim point of the line (2, 3)
//   targetOwner = owner of the clicked tile at the order; launch = spearhead start tile; strength0 = troops at start
//   cargo = tiles taken by the current spearhead
// Deterministic: no RNG; searches have fixed tie-breaks.
import { buildingAt, buildingsOf, fortMultiplierAt } from './buildings';
import { frontTiles, tileFightCost } from './combat';
import {
  BOMBER_RADIUS,
  TANK_ARMOR_DEFENSE,
  TANK_ARTILLERY_SUPPORT,
  TANK_BOMBER_KILL,
  TANK_BUILD_SECONDS,
  TANK_DEFENSE_BONUS,
  TANK_DEFENSE_RADIUS,
  TANK_DISBAND_SHARE,
  TANK_DIVISION_TROOPS,
  TANK_LAUNCH_REACH,
  TANK_MIN_ARMOR,
  TANK_PATH_BUDGET,
  TANK_PER_FACTORY_LEVEL,
  TANK_SPEARHEAD_LOSS,
  TANK_SPEARHEAD_MAX_DEPTH,
  TANK_SPEARHEAD_MIN_SHARE,
  TANK_SPEARHEAD_SPEED,
  TANK_SPEARHEAD_WIDTH,
  TANK_TERRAIN_LOSS,
  TANK_TERRAIN_SPEED,
  TICK_SECONDS,
  TICKS_PER_SECOND,
  UNITS,
} from './config';
import { areAllied, changeOpinion, onAttackStarted } from './diplomacy';
import { doctrineMore } from './doctrines';
import { forEachInRadius } from './grid';
import { formationTiles, ownGroup, unitQueue } from './navy';
import { atPeace, buildSeconds, frontRate, peaceReason, sameTeam } from './rules';
import { addEvent, newId, setOwner } from './state';
import { hasTech } from './tech';
import { isProtected } from './admin';
import { tankDivisionMods } from './techtree';
import { aiDivisionModes, collapsePockets, divisionLimitFor, divisionStep, onSpearheadEnded, vetLossMul, vetSpeedMul } from './armor2';
import { ARMOR_POCKET_EVERY, ARMOR_SUPPORT_READY } from './config';
import { Terrain, TROOP_TYPES, isTribe, isWater } from './types';
import type { Action, ActionResult, GameState, Player, Troops, Unit } from './types';

const FAIL = (reason: string): ActionResult => ({ ok: false, reason });
const zero = (): Troops => ({ infantry: 0, armor: 0, artillery: 0 });
const total = (t: Troops): number => t.infantry + t.armor + t.artillery;
const FULL_DIVISION = TANK_DIVISION_TROOPS.armor + TANK_DIVISION_TROOPS.infantry + TANK_DIVISION_TROOPS.artillery;

function isTileIn(state: GameState, t: unknown): t is number {
  return typeof t === 'number' && Number.isInteger(t) && t >= 0 && t < state.map.width * state.map.height;
}
function unitTileOf(state: GameState, u: Unit): number {
  return Math.round(u.y) * state.map.width + Math.round(u.x);
}
function isLand(state: GameState, t: number): boolean {
  return !isWater(state.map.terrain[t]);
}
function fmt(n: number): string {
  return n >= 10000 ? `${Math.round(n / 1000)}k` : `${Math.round(n)}`;
}
/** Railways (techtree, if present): cheaper divisions and faster driving on own land. */
function hasRailways(p: Player): boolean {
  return hasTech(p, 'railways');
}

// ---------------------------------------------------------------------------------------------------------------
// Cost, limits, building
// ---------------------------------------------------------------------------------------------------------------

export interface TankDivisionCost {
  gold: number;
  iron: number;
  oil: number;
  /** troops taken from the pool (armor first; the escort may be smaller when the pool lacks it) */
  armor: number;
  infantry: number;
  artillery: number;
}

/** What a division costs playerId now (gold, iron, oil; the troops it takes from the pool). */
export function tankDivisionCost(state: GameState, playerId: number): TankDivisionCost {
  const c = UNITS.tankDivision;
  const p = state.players[playerId];
  const k = p ? tankDivisionMods(state, playerId).costMul : 1; // Railways (techtree.ts)
  const pool = p ? p.troops : zero();
  return {
    gold: Math.round(c.gold * k),
    iron: Math.round(c.iron * k),
    oil: Math.round(c.oil * k),
    armor: Math.floor(Math.min(TANK_DIVISION_TROOPS.armor, pool.armor)),
    infantry: Math.floor(Math.min(TANK_DIVISION_TROOPS.infantry, pool.infantry)),
    artillery: Math.floor(Math.min(TANK_DIVISION_TROOPS.artillery, pool.artillery)),
  };
}

/** Divisions playerId may have (alive + being built): TANK_PER_FACTORY_LEVEL per finished Factory level. */
export function tankDivisionLimit(state: GameState, playerId: number): number {
  let levels = 0;
  for (const b of buildingsOf(state, playerId, 'factory')) if (b.owner === playerId && b.buildLeft <= 0) levels += b.level;
  // + Railways (armor2.ts)
  return divisionLimitFor(state, playerId, levels);
}
/** Divisions playerId has (alive + being built). */
export function tankDivisionCount(state: GameState, playerId: number): number {
  let n = 0;
  for (const u of state.units) if (u.type === 'tankDivision' && u.owner === playerId && u.hp > 0) n++;
  for (const q of state.unitQueue ?? []) if (q.type === 'tankDivision' && q.owner === playerId) n++;
  return n;
}
/** The own finished Factory to build at when none is picked: highest level, then lowest id; -1 = none. */
export function bestFactory(state: GameState, playerId: number): number {
  let best = -1;
  let bestLevel = 0;
  let bestId = Infinity;
  for (const b of buildingsOf(state, playerId, 'factory')) {
    if (b.owner !== playerId || b.buildLeft > 0) continue;
    if (b.level > bestLevel || (b.level === bestLevel && b.id < bestId)) {
      best = b.tile;
      bestLevel = b.level;
      bestId = b.id;
    }
  }
  return best;
}

/** Whether playerId can build a division at `tile` (an own finished Factory) now: ok or the reason. */
export function canBuildTankDivision(state: GameState, playerId: number, tile: number): ActionResult {
  const p = state.players[playerId];
  if (!p || playerId === 0 || !p.alive) return FAIL('No such player');
  if (!hasTech(p, 'mechanization')) return FAIL('Needs research: Mechanization');
  if (!isTileIn(state, tile)) return FAIL('Invalid tile');
  const b = buildingAt(state, tile);
  if (!b || b.type !== 'factory' || b.owner !== playerId) return FAIL('Tank divisions are built at a Factory of yours');
  if (b.buildLeft > 0) return FAIL('This Factory is still under construction');
  const limit = tankDivisionLimit(state, playerId);
  if (tankDivisionCount(state, playerId) >= limit) return FAIL(`At most ${limit} division${limit === 1 ? '' : 's'}: one per Factory level`);
  const c = tankDivisionCost(state, playerId);
  if (p.gold < c.gold) return FAIL(`Not enough gold (${c.gold})`);
  if (p.iron < c.iron) return FAIL(`Not enough iron (${c.iron})`);
  if (p.oil < c.oil) return FAIL(`Not enough oil (${c.oil})`);
  if (p.troops.armor < TANK_MIN_ARMOR) return FAIL(`Needs ${fmt(TANK_MIN_ARMOR)} armor at home (raise the armor share)`);
  return { ok: true };
}

/** Action buildTankDivision: pays, takes the troops, and queues the division at the factory. */
export function buildTankDivision(state: GameState, playerId: number, tile: number): ActionResult {
  const r = canBuildTankDivision(state, playerId, tile);
  if (!r.ok) return r;
  const p = state.players[playerId];
  const c = tankDivisionCost(state, playerId);
  p.gold -= c.gold;
  p.iron -= c.iron;
  p.oil -= c.oil;
  const troops: Troops = { infantry: c.infantry, armor: c.armor, artillery: c.artillery };
  for (const k of TROOP_TYPES) p.troops[k] = Math.max(0, p.troops[k] - troops[k]);
  const ticks = Math.max(1, Math.round(buildSeconds(state, TANK_BUILD_SECONDS) * TICKS_PER_SECOND));
  unitQueue(state).push({ id: newId(state), type: 'tankDivision', owner: playerId, site: tile, tile, readyTick: state.tick + ticks, troops });
  return { ok: true };
}

/** Seconds a division takes to build (build speed modifiers apply). */
export function tankBuildSeconds(state: GameState): number {
  return buildSeconds(state, TANK_BUILD_SECONDS);
}

function makeDivision(state: GameState, owner: number, factory: number, troops: Troops): Unit {
  const w = state.map.width;
  const u: Unit = {
    id: newId(state),
    type: 'tankDivision',
    owner,
    x: factory % w,
    y: (factory / w) | 0,
    target: factory,
    home: factory,
    path: [],
    pathPos: 0,
    troops: { ...troops },
    hp: 1,
    cargo: 0,
    state: 0,
    targetOwner: 0,
  };
  state.units.push(u);
  return u;
}

/** Owner console: a full division appears at once on an own land tile (no cost). */
export function spawnTankDivision(state: GameState, owner: number, tile: number): Unit {
  return makeDivision(state, owner, tile, { ...TANK_DIVISION_TROOPS });
}

// ---------------------------------------------------------------------------------------------------------------
// Land routes over own territory
// ---------------------------------------------------------------------------------------------------------------

/** 16 unit directions (cos, sin of k x 22.5 degrees), written out: the sim uses no trigonometry. */
const DIR16: readonly [number, number][] = [
  [1, 0], [0.9238795325112867, 0.3826834323650898], [0.7071067811865476, 0.7071067811865476], [0.3826834323650898, 0.9238795325112867],
  [0, 1], [-0.3826834323650898, 0.9238795325112867], [-0.7071067811865476, 0.7071067811865476], [-0.9238795325112867, 0.3826834323650898],
  [-1, 0], [-0.9238795325112867, -0.3826834323650898], [-0.7071067811865476, -0.7071067811865476], [-0.3826834323650898, -0.9238795325112867],
  [0, -1], [0.3826834323650898, -0.9238795325112867], [0.7071067811865476, -0.7071067811865476], [0.9238795325112867, -0.3826834323650898],
];
const DX8 = [1, -1, 0, 0, 1, 1, -1, -1];
const DY8 = [0, 0, 1, -1, 1, -1, 1, -1];
const SQRT2 = 1.4142135623730951;

/**
 * Shortest route over own land (8-neighbour, no corner cutting between two foreign / water tiles) from `from` to
 * `to`, both own land. Returns the tiles after `from` up to `to` ([] when from === to), or null when unreachable
 * within the search budget.
 */
export function ownLandPath(state: GameState, owner: number, from: number, to: number, budget = TANK_PATH_BUDGET): number[] | null {
  const map = state.map;
  const w = map.width;
  const h = map.height;
  const own = (t: number): boolean => map.owner[t] === owner && !isWater(map.terrain[t]);
  if (!own(from) || !own(to)) return null;
  if (from === to) return [];
  const tx = to % w;
  const ty = (to / w) | 0;
  const heur = (t: number): number => {
    const dx = Math.abs((t % w) - tx);
    const dy = Math.abs(((t / w) | 0) - ty);
    return Math.max(dx, dy) + (SQRT2 - 1) * Math.min(dx, dy);
  };
  const g = new Map<number, number>();
  const came = new Map<number, number>();
  // Binary heap of [f, tile] (ties: lower tile first).
  const hf: number[] = [];
  const ht: number[] = [];
  const less = (i: number, j: number): boolean => hf[i] < hf[j] || (hf[i] === hf[j] && ht[i] < ht[j]);
  const swap = (i: number, j: number): void => {
    const f = hf[i];
    hf[i] = hf[j];
    hf[j] = f;
    const t = ht[i];
    ht[i] = ht[j];
    ht[j] = t;
  };
  const push = (f: number, t: number): void => {
    hf.push(f);
    ht.push(t);
    let i = hf.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!less(i, p)) break;
      swap(i, p);
      i = p;
    }
  };
  const pop = (): number => {
    const top = ht[0];
    const lf = hf.pop()!;
    const lt = ht.pop()!;
    if (hf.length) {
      hf[0] = lf;
      ht[0] = lt;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < hf.length && less(l, m)) m = l;
        if (r < hf.length && less(r, m)) m = r;
        if (m === i) break;
        swap(i, m);
        i = m;
      }
    }
    return top;
  };
  g.set(from, 0);
  push(heur(from), from);
  let spent = 0;
  while (hf.length) {
    const cur = pop();
    if (cur === to) break;
    if (++spent > budget) return null;
    const gc = g.get(cur)!;
    const cx = cur % w;
    const cy = (cur / w) | 0;
    for (let k = 0; k < 8; k++) {
      const x = cx + DX8[k];
      const y = cy + DY8[k];
      if (x < 0 || y < 0 || x >= w || y >= h) continue;
      const t = y * w + x;
      if (!own(t)) continue;
      if (k >= 4 && !own(cy * w + x) && !own(y * w + cx)) continue;
      const ng = gc + (k >= 4 ? SQRT2 : 1);
      const old = g.get(t);
      if (old !== undefined && old <= ng) continue;
      g.set(t, ng);
      came.set(t, cur);
      push(ng + heur(t), t);
    }
  }
  if (!came.has(to)) return null;
  const out: number[] = [];
  for (let t = to; t !== from; t = came.get(t)!) out.push(t);
  out.reverse();
  return out;
}

/** Moves along u.path at `speed` tiles/s; stops (holding) where the route leaves own land. True on arrival. */
function drive(state: GameState, u: Unit, speed: number): boolean {
  const w = state.map.width;
  const owner = state.map.owner;
  let step = speed * TICK_SECONDS;
  while (step > 0 && u.pathPos < u.path.length) {
    const t = u.path[u.pathPos];
    if (owner[t] !== u.owner) {
      // The route was cut (land lost): hold where we are.
      u.path = [];
      u.pathPos = 0;
      u.state = 0;
      return false;
    }
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

// ---------------------------------------------------------------------------------------------------------------
// Orders
// ---------------------------------------------------------------------------------------------------------------

/** Nearest own land tile to `tile` within TANK_LAUNCH_REACH (ties: lower index), or -1. */
function launchTileFor(state: GameState, owner: number, tile: number): number {
  const map = state.map;
  let best = -1;
  let bestD = Infinity;
  forEachInRadius(map, tile, TANK_LAUNCH_REACH, (i, d) => {
    if (map.owner[i] !== owner || isWater(map.terrain[i])) return;
    if (d < bestD || (d === bestD && i < best)) {
      bestD = d;
      best = i;
    }
  });
  return best;
}

/**
 * Far aim point of a spearhead from `launch` through `tile`: TANK_SPEARHEAD_MAX_DEPTH tiles along that line
 * (clamped to the map). When the clicked tile is right at the border the line points away from own land around it.
 */
function aimPoint(state: GameState, owner: number, launch: number, tile: number): number {
  const map = state.map;
  const w = map.width;
  let dx = (tile % w) - (launch % w);
  let dy = ((tile / w) | 0) - ((launch / w) | 0);
  if (dx * dx + dy * dy < 4) {
    // Clicked right at the border: of 16 directions, the one that runs furthest (up to 10 tiles) through the clicked
    // owner's land before water or another nation, passes the clicked tile, and points most like the click.
    const who = map.owner[tile];
    const lx = launch % w;
    const ly = (launch / w) | 0;
    const cl = Math.sqrt(dx * dx + dy * dy) || 1;
    const clx = dx / cl;
    const cly = dy / cl;
    let bestScore = -1;
    for (let k = 0; k < 16; k++) {
      const cx = DIR16[k][0];
      const cy = DIR16[k][1];
      let score = 0;
      let passes = false;
      let started = false;
      for (let d = 1; d <= 13 && score < 10; d++) {
        const x = Math.round(lx + cx * d);
        const y = Math.round(ly + cy * d);
        if (x < 0 || y < 0 || x >= w || y >= map.height) break;
        const t = y * w + x;
        if (d <= 3 && Math.abs(x - (tile % w)) <= 1 && Math.abs(y - ((tile / w) | 0)) <= 1) passes = true;
        const o = map.owner[t];
        if (!started && o === owner && !isWater(map.terrain[t]) && d <= 3) continue;
        started = true;
        if (o !== who || isWater(map.terrain[t])) break;
        score++;
      }
      if (passes) score += 4;
      score += 3 * (cx * clx + cy * cly);
      if (score > bestScore) {
        bestScore = score;
        dx = cx;
        dy = cy;
      }
    }
  }
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len < 1e-9) return tile;
  const depth = TANK_SPEARHEAD_MAX_DEPTH + 2;
  const x = Math.max(0, Math.min(w - 1, Math.round((launch % w) + (dx / len) * depth)));
  const y = Math.max(0, Math.min(map.height - 1, Math.round(((launch / w) | 0) + (dy / len) * depth)));
  return y * w + x;
}

/** Why playerId may not spearhead into land of `target` (0 = neutral), or null. */
function spearheadBlock(state: GameState, playerId: number, target: number): string | null {
  if (target === playerId) return null;
  if (target === 0) return null;
  const tp = state.players[target];
  if (!tp || !tp.alive) return 'That nation is gone';
  if (areAllied(state, playerId, target)) return sameTeam(state, playerId, target) ? 'You cannot attack a teammate' : 'You cannot attack an ally';
  const peace = peaceReason(state, playerId, target);
  if (peace) return peace;
  if (isProtected(state, target)) return 'The line there cannot be broken';
  return null;
}

/**
 * Action moveTankDivision. Own land: the divisions drive there (formation around the tile). Enemy / neutral land
 * within TANK_LAUNCH_REACH of own land: each drives to its launch tile, then spearheads (one line per division,
 * side by side). Divisions already in a spearhead keep going.
 */
export function moveTankDivisions(state: GameState, playerId: number, unitIds: unknown, tile: number): ActionResult {
  const group = ownGroup(state, playerId, unitIds, 'tankDivision', 'tank divisions');
  if (typeof group === 'string') return FAIL(group);
  if (!isTileIn(state, tile)) return FAIL('Invalid tile');
  const map = state.map;
  if (!isLand(state, tile)) return FAIL('Tank divisions move on land');
  const free = group.filter((u) => u.state !== 3).sort((a, b) => a.id - b.id);
  if (!free.length) return FAIL('Divisions in a spearhead cannot take new orders');
  const owner = map.owner[tile];
  let moved = 0;
  let reason = 'Your divisions cannot reach there over your own land';
  if (owner === playerId) {
    const slots = formationTiles(state, tile, free.length, (t) => map.owner[t] === playerId && isLand(state, t));
    for (let k = 0; k < free.length; k++) {
      const u = free[k];
      const dest = slots.length ? slots[k % slots.length] : tile;
      const path = ownLandPath(state, playerId, unitTileOf(state, u), dest);
      if (!path) continue;
      u.path = path;
      u.pathPos = 0;
      u.target = dest;
      u.state = path.length ? 1 : 0;
      moved++;
    }
    return moved ? { ok: true } : FAIL(reason);
  }
  const block = spearheadBlock(state, playerId, owner);
  if (block) return FAIL(block);
  const launch0 = launchTileFor(state, playerId, tile);
  if (launch0 < 0) return FAIL('Pick enemy or neutral land next to your border');
  const aim0 = aimPoint(state, playerId, launch0, tile);
  // Divisions side by side: aim lines shifted across the direction by the spearhead width.
  const w = map.width;
  const dx = (aim0 % w) - (launch0 % w);
  const dy = ((aim0 / w) | 0) - ((launch0 / w) | 0);
  const len = Math.max(1e-9, Math.sqrt(dx * dx + dy * dy));
  const px = -dy / len;
  const py = dx / len;
  for (let k = 0; k < free.length; k++) {
    const u = free[k];
    const off = (k - (free.length - 1) / 2) * TANK_SPEARHEAD_WIDTH;
    let launch = launch0;
    let aim = aim0;
    if (off !== 0) {
      const sx = Math.round((tile % w) + px * off);
      const sy = Math.round(((tile / w) | 0) + py * off);
      const t2 = sx >= 0 && sy >= 0 && sx < w && sy < map.height ? sy * w + sx : -1;
      if (t2 >= 0 && isLand(state, t2) && map.owner[t2] !== playerId) {
        const l2 = launchTileFor(state, playerId, t2);
        if (l2 >= 0) {
          launch = l2;
          aim = Math.max(0, Math.min(map.height - 1, Math.round(((aim0 / w) | 0) + py * off))) * w + Math.max(0, Math.min(w - 1, Math.round((aim0 % w) + px * off)));
        }
      }
    }
    const path = ownLandPath(state, playerId, unitTileOf(state, u), launch);
    if (!path) continue;
    u.path = path;
    u.pathPos = 0;
    u.target = aim;
    u.targetOwner = owner;
    u.state = 2;
    moved++;
  }
  return moved ? { ok: true } : FAIL(reason);
}

// ---------------------------------------------------------------------------------------------------------------
// Spearheads
// ---------------------------------------------------------------------------------------------------------------

function artillerySupport(u: Unit): boolean {
  const t = total(u.troops);
  return t > 0 && u.troops.artillery / t >= TANK_ARTILLERY_SUPPORT;
}
function armorShare(p: Player | undefined): number {
  if (!p) return 0;
  const t = total(p.troops);
  return t > 0 ? p.troops.armor / t : 0;
}
/** Head speed (tiles/s) entering a tile of terrain `ter` (0 = can't). */
function headSpeed(state: GameState, u: Unit, ter: number, defender: number): number {
  let s = TANK_SPEARHEAD_SPEED * (TANK_TERRAIN_SPEED[ter] ?? 0.5);
  if (ter === Terrain.Mountains && !artillerySupport(u)) return 0;
  const p = state.players[u.owner];
  s *= tankDivisionMods(state, u.owner).speedMul * vetSpeedMul(u); // Blitz Tactics (techtree.ts), veterancy (armor2.ts)
  if (ter === Terrain.Plains || ter === Terrain.Desert) s *= doctrineMore(state, u.owner, 'openGroundSpeed');
  if (defender > 0 && hasTech(state.players[defender], 'trenchWarfare')) s *= 0.7;
  return s * frontRate(state);
}
function maxDepth(state: GameState, u: Unit): number {
  return TANK_SPEARHEAD_MAX_DEPTH * tankDivisionMods(state, u.owner).depthMul * vetSpeedMul(u); // Blitz Tactics, veterancy
}

/** Loss for taking tile t (owner o) with the division, or a reason it can't be taken. */
function bandCost(state: GameState, u: Unit, t: number, o: number): { loss: number; killed: number } | string {
  const map = state.map;
  const ter = map.terrain[t];
  if (isWater(ter)) return 'reached the coast';
  if (o !== 0 && o !== u.targetOwner) return 'ran into another nation';
  if (o !== 0) {
    const why = spearheadBlock(state, u.owner, o);
    if (why) return 'the way is barred';
  }
  const arty = artillerySupport(u);
  if (ter === Terrain.Mountains && !arty) return 'stalled in the mountains';
  if (o > 0 && fortMultiplierAt(state, t, o) > 1.01 && !arty) return 'stopped by a fort';
  const c = tileFightCost(state, u.owner, u.troops, o, t);
  if (!Number.isFinite(c.loss)) return 'cannot fight there';
  let loss = c.loss * TANK_SPEARHEAD_LOSS * (TANK_TERRAIN_LOSS[ter] ?? 1) * vetLossMul(u); // veterancy (armor2.ts)
  if (o > 0) {
    // the defender's Trench Warfare already raises c.loss (tileFightCost -> techLossMul): not counted twice
    loss *= 1 + TANK_ARMOR_DEFENSE * armorShare(state.players[o]);
  }
  return { loss, killed: c.defenderLoss };
}

function loseTroops(state: GameState, u: Unit, amount: number, killer: number): void {
  const tot = total(u.troops);
  if (tot <= 0 || amount <= 0) return;
  const take = Math.min(tot, amount);
  for (const k of TROOP_TYPES) u.troops[k] = Math.max(0, u.troops[k] - (take * u.troops[k]) / tot);
  state.players[u.owner].stats.troopsLost += take;
  if (killer > 0 && killer !== u.owner && state.players[killer]) state.players[killer].stats.troopsKilled += take;
}
function killDefenders(state: GameState, victim: number, amount: number, killer: number): void {
  if (victim <= 0 || amount <= 0) return;
  const p = state.players[victim];
  if (!p || !p.alive) return;
  const tot = total(p.troops);
  const take = Math.min(tot, amount);
  if (take <= 0) return;
  for (const k of TROOP_TYPES) p.troops[k] = Math.max(0, p.troops[k] - (take * p.troops[k]) / tot);
  p.stats.troopsLost += take;
  state.players[killer].stats.troopsKilled += take;
}

/** Band tiles across the line at `center` (the centre first), TANK_SPEARHEAD_WIDTH wide. */
function band(state: GameState, center: number, ux: number, uy: number, out: number[]): number {
  const w = state.map.width;
  const h = state.map.height;
  const cx = center % w;
  const cy = (center / w) | 0;
  out[0] = center;
  let n = 1;
  const half = (TANK_SPEARHEAD_WIDTH - 1) >> 1;
  for (let k = 1; k <= half; k++) {
    for (const s of [1, -1]) {
      const x = cx + Math.round(-uy * k * s);
      const y = cy + Math.round(ux * k * s);
      if (x < 0 || y < 0 || x >= w || y >= h) continue;
      const t = y * w + x;
      if (t !== center) out[n++] = t;
    }
  }
  return n;
}
const bandScratch: number[] = [];

function lineOf(state: GameState, u: Unit): { lx: number; ly: number; ux: number; uy: number } {
  const w = state.map.width;
  const L = u.launch ?? unitTileOf(state, u);
  const lx = L % w;
  const ly = (L / w) | 0;
  const dx = (u.target % w) - lx;
  const dy = ((u.target / w) | 0) - ly;
  const len = Math.sqrt(dx * dx + dy * dy);
  return len < 1e-9 ? { lx, ly, ux: 1, uy: 0 } : { lx, ly, ux: dx / len, uy: dy / len };
}

/**
 * Moves a spearhead's start forward along its line over own land (the front may have moved while the division drove
 * up), and re-aims the far point from there. Returns [launch, target].
 */
function frontOfLine(state: GameState, owner: number, launch: number, target: number): [number, number] {
  const map = state.map;
  const w = map.width;
  const lx = launch % w;
  const ly = (launch / w) | 0;
  const dx = (target % w) - lx;
  const dy = ((target / w) | 0) - ly;
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len < 1e-9) return [launch, target];
  const ux = dx / len;
  const uy = dy / len;
  let best = launch;
  for (let d = 1; d <= TANK_SPEARHEAD_MAX_DEPTH * 2; d++) {
    const x = Math.round(lx + ux * d);
    const y = Math.round(ly + uy * d);
    if (x < 0 || y < 0 || x >= w || y >= map.height) break;
    const t = y * w + x;
    if (t === best) continue;
    if (map.owner[t] !== owner || isWater(map.terrain[t])) break;
    best = t;
  }
  if (best === launch) return [launch, target];
  const depth = TANK_SPEARHEAD_MAX_DEPTH + 2;
  const bx = best % w;
  const by = (best / w) | 0;
  const tx = Math.max(0, Math.min(w - 1, Math.round(bx + ux * depth)));
  const ty = Math.max(0, Math.min(map.height - 1, Math.round(by + uy * depth)));
  return [best, ty * w + tx];
}

function startSpearhead(state: GameState, u: Unit): void {
  const [here, aim] = frontOfLine(state, u.owner, unitTileOf(state, u), u.target);
  u.target = aim;
  u.state = 3;
  u.launch = here;
  u.x = here % state.map.width;
  u.y = (here / state.map.width) | 0;
  u.strength0 = total(u.troops);
  u.cargo = 0;
  u.path = [];
  u.pathPos = 0;
  const p = state.players[u.owner];
  const o = u.targetOwner;
  const block = spearheadBlock(state, u.owner, o);
  if (block) {
    endSpearhead(state, u, block.toLowerCase());
    return;
  }
  if (o > 0) {
    onAttackStarted(state, u.owner, o);
    changeOpinion(state, o, u.owner, -10);
  }
  const vs = o > 0 ? ` against ${state.players[o].name}` : '';
  addEvent(state, 'spearheadStarted', `${p.name}'s tank division broke out${vs}`, o > 0 && !isTribe(state.players[o]) ? [u.owner, o] : [u.owner], here);
}

function endSpearhead(state: GameState, u: Unit, why: string): void {
  // Pockets the line cut off collapse (armor2.ts).
  if (u.launch !== undefined && u.cargo > 0) collapsePockets(state, u, u.launch, u.x, u.y);
  const p = state.players[u.owner];
  const lost = Math.max(0, (u.strength0 ?? total(u.troops)) - total(u.troops));
  const o = u.targetOwner;
  // Back onto own land: the head tile, else step back along the line.
  const w = state.map.width;
  let here = unitTileOf(state, u);
  if (state.map.owner[here] !== u.owner && u.launch !== undefined) {
    const { lx, ly, ux, uy } = lineOf(state, u);
    const depth = Math.sqrt((u.x - lx) * (u.x - lx) + (u.y - ly) * (u.y - ly));
    for (let d = Math.floor(depth); d >= 0; d--) {
      const t = Math.round(ly + uy * d) * w + Math.round(lx + ux * d);
      if (state.map.owner[t] === u.owner) {
        here = t;
        break;
      }
    }
  }
  u.x = here % w;
  u.y = (here / w) | 0;
  u.state = 0;
  u.target = here;
  u.launch = undefined;
  u.strength0 = undefined;
  const taken = u.cargo;
  u.cargo = 0;
  onSpearheadEnded(state, u, taken); // veterancy (armor2.ts)
  const left = total(u.troops);
  const disband = left < FULL_DIVISION * TANK_DISBAND_SHARE || state.map.owner[here] !== u.owner;
  const tail = disband ? `; the division is spent, ${fmt(left)} troops return home` : '';
  const who = o > 0 && !isTribe(state.players[o]) ? [u.owner, o] : [u.owner];
  addEvent(state, 'spearheadEnded', `${p.name}'s spearhead ${why}: ${taken} tiles taken, ${fmt(lost)} troops lost${tail}`, who, here);
  if (disband) disbandDivision(state, u);
}

/** A division leaves the map: its troops go back to the pool. */
function disbandDivision(state: GameState, u: Unit): void {
  const p = state.players[u.owner];
  if (p && p.alive) for (const k of TROOP_TYPES) p.troops[k] += u.troops[k];
  u.troops = zero();
  u.hp = 0;
}

/** One tick of a running spearhead. */
function stepSpearhead(state: GameState, u: Unit): void {
  const map = state.map;
  const w = map.width;
  const { lx, ly, ux, uy } = lineOf(state, u);
  const depth = Math.sqrt((u.x - lx) * (u.x - lx) + (u.y - ly) * (u.y - ly));
  const limit = maxDepth(state, u);
  if (depth >= limit) {
    endSpearhead(state, u, 'reached its full depth');
    return;
  }
  // The tile one step ahead decides the pace.
  const ax = Math.round(lx + ux * (depth + 1));
  const ay = Math.round(ly + uy * (depth + 1));
  if (ax < 0 || ay < 0 || ax >= w || ay >= map.height) {
    endSpearhead(state, u, 'reached the edge of the map');
    return;
  }
  const ahead = ay * w + ax;
  const speed = headSpeed(state, u, map.terrain[ahead], map.owner[ahead]);
  const step = Math.min(0.9, Math.max(speed, 0.05) * TICK_SECONDS);
  const nd = Math.min(limit, depth + step);
  const nx = lx + ux * nd;
  const ny = ly + uy * nd;
  const cur = Math.round(u.y) * w + Math.round(u.x);
  const next = Math.round(ny) * w + Math.round(nx);
  if (next !== cur) {
    // Entering a new tile: take the band across the line (the centre must fall, the sides if affordable).
    const n = band(state, next, ux, uy, bandScratch);
    const floor = (u.strength0 ?? total(u.troops)) * TANK_SPEARHEAD_MIN_SHARE;
    const takenBefore = u.cargo;
    for (let k = 0; k < n; k++) {
      const t = bandScratch[k];
      const o = map.owner[t];
      if (o === u.owner && !isWater(map.terrain[t])) continue;
      const c = bandCost(state, u, t, o);
      if (typeof c === 'string') {
        if (k === 0) {
          endSpearhead(state, u, c);
          return;
        }
        continue;
      }
      if (total(u.troops) - c.loss < floor) {
        if (k === 0) {
          endSpearhead(state, u, 'ran out of strength');
          return;
        }
        continue;
      }
      loseTroops(state, u, c.loss, o);
      killDefenders(state, o, c.killed, u.owner);
      setOwner(state, t, u.owner);
      u.cargo++;
      if (!u.hp) return;
    }
    // Every ARMOR_POCKET_EVERY tiles: pockets the line has cut off collapse (armor2.ts).
    if (Math.floor(u.cargo / ARMOR_POCKET_EVERY) > Math.floor(takenBefore / ARMOR_POCKET_EVERY) && u.launch !== undefined) {
      collapsePockets(state, u, u.launch, nx, ny);
    }
  }
  u.x = nx;
  u.y = ny;
}

// ---------------------------------------------------------------------------------------------------------------
// Tick
// ---------------------------------------------------------------------------------------------------------------

/** Divisions under construction appear; divisions drive, launch and run spearheads. Called every tick. */
export function updateTanks(state: GameState): void {
  const q = state.unitQueue;
  if (q && q.some((x) => x.type === 'tankDivision' && x.readyTick <= state.tick)) {
    for (const item of q) {
      if (item.type !== 'tankDivision' || item.readyTick > state.tick) continue;
      item.readyTick = -1;
      const p = state.players[item.owner];
      if (!p || !p.alive) continue;
      const f = buildingAt(state, item.site);
      if (!f || f.type !== 'factory' || f.owner !== item.owner) {
        for (const k of TROOP_TYPES) p.troops[k] += item.troops[k];
        addEvent(state, 'unitLost', `${p.name} lost a tank division being built: its factory is gone (the troops went home)`, [item.owner], item.site);
        continue;
      }
      makeDivision(state, item.owner, item.site, item.troops);
      addEvent(state, 'tankDivisionReady', `Tank division ready (${fmt(total(item.troops))} troops)`, [item.owner], item.site);
    }
    state.unitQueue = q.filter((x) => x.readyTick >= 0);
  }
  let any = false;
  for (const u of state.units) {
    if (u.type !== 'tankDivision' || u.hp <= 0) continue;
    const p = state.players[u.owner];
    if (!p || !p.alive) continue;
    any = true;
    if (u.state === 3) {
      stepSpearhead(state, u);
      continue;
    }
    const here = unitTileOf(state, u);
    if (state.map.owner[here] !== u.owner) {
      // The ground under a division that isn't attacking was taken: it falls back home, beaten.
      loseTroops(state, u, total(u.troops) * 0.25, state.map.owner[here]);
      addEvent(state, 'unitLost', `${p.name}'s tank division was overrun and fell back`, [u.owner], here);
      disbandDivision(state, u);
      continue;
    }
    if (u.state === 1 || u.state === 2) {
      const speed = UNITS.tankDivision.speed * (hasRailways(p) ? 1.5 : 1) * frontRate(state);
      if (drive(state, u, speed)) {
        if (u.state === 2) startSpearhead(state, u);
        else u.state = 0;
      }
    }
    // Refit, support / refit modes (armor2.ts).
    if (u.state === 0 || u.state === 1) divisionStep(state, u);
  }
  if (!any) return;
  // Divisions moved, started or ended: the defence lookup is rebuilt from the new positions on its next use.
  defenseCache.delete(state);
  if (state.units.some((u) => u.hp <= 0)) state.units = state.units.filter((u) => u.hp > 0);
}

// ---------------------------------------------------------------------------------------------------------------
// Defence, bombers, previews
// ---------------------------------------------------------------------------------------------------------------

const defenseCache = new WeakMap<GameState, { tick: number; n: number; by: Map<number, number[]> }>();

/** Defence multiplier on attacks against `defender` at `tile` from its holding divisions nearby (1 = none). */
export function tankDefenseAt(state: GameState, defender: number, tile: number): number {
  if (defender <= 0) return 1;
  let c = defenseCache.get(state);
  if (!c || c.tick !== state.tick || c.n !== state.units.length) {
    const by = new Map<number, number[]>();
    for (const u of state.units) {
      if (u.type !== 'tankDivision' || u.hp <= 0 || u.state === 3) continue;
      let l = by.get(u.owner);
      if (!l) by.set(u.owner, (l = []));
      l.push(u.x, u.y);
    }
    c = { tick: state.tick, n: state.units.length, by };
    defenseCache.set(state, c);
  }
  const l = c.by.get(defender);
  if (!l) return 1;
  const w = state.map.width;
  const x = tile % w;
  const y = (tile / w) | 0;
  const r2 = TANK_DEFENSE_RADIUS * TANK_DEFENSE_RADIUS;
  for (let k = 0; k < l.length; k += 2) {
    const dx = l[k] - x;
    const dy = l[k + 1] - y;
    if (dx * dx + dy * dy <= r2) return (1 + TANK_DEFENSE_BONUS) * tankDivisionMods(state, defender).defenseMul; // Trench Warfare
  }
  return 1;
}

/** A bomber of `bomber` hit `tile`: hostile divisions on the move within BOMBER_RADIUS lose TANK_BOMBER_KILL. */
export function bombDivisions(state: GameState, bomber: number, tile: number): void {
  const w = state.map.width;
  const x = tile % w;
  const y = (tile / w) | 0;
  const r2 = BOMBER_RADIUS * BOMBER_RADIUS;
  for (const u of state.units) {
    if (u.type !== 'tankDivision' || u.hp <= 0 || u.state === 0 || u.owner === bomber) continue;
    if (areAllied(state, u.owner, bomber) || atPeace(state, u.owner, bomber)) continue;
    const dx = u.x - x;
    const dy = u.y - y;
    if (dx * dx + dy * dy > r2) continue;
    loseTroops(state, u, total(u.troops) * TANK_BOMBER_KILL, bomber);
    if (total(u.troops) < FULL_DIVISION * 0.05) {
      u.hp = 0;
      defenseCache.delete(state);
    }
  }
}

export interface SpearheadPreview {
  /** tiles along the line the head would cross (approximate, in order), from the launch tile */
  path: number[];
  /** tiles deep the spearhead is expected to get (centre line) */
  expectedDepth: number;
  /** plain warnings, e.g. "Mountains ahead: spearhead will stall" */
  warnings: string[];
  /** the launch tile (own land), or -1 when the order would be refused */
  launch: number;
  /** why the order would be refused (empty when it would go) */
  reason: string;
}

/**
 * What a spearhead of division unitId toward `tile` would do (no state change): the line, the expected depth from
 * its current strength, and warnings. For the client's arrow before confirming.
 */
export function spearheadPreview(state: GameState, playerId: number, unitId: number, tile: number): SpearheadPreview {
  const out: SpearheadPreview = { path: [], expectedDepth: 0, warnings: [], launch: -1, reason: '' };
  const u = state.units.find((q) => q.id === unitId);
  if (!u || u.type !== 'tankDivision' || u.owner !== playerId || u.hp <= 0) return { ...out, reason: 'No such division' };
  if (!isTileIn(state, tile) || !isLand(state, tile)) return { ...out, reason: 'Tank divisions move on land' };
  const map = state.map;
  const target = map.owner[tile];
  if (target === playerId) return { ...out, reason: 'That is your own land: the division drives there' };
  const block = spearheadBlock(state, playerId, target);
  if (block) return { ...out, reason: block };
  const launch = launchTileFor(state, playerId, tile);
  if (launch < 0) return { ...out, reason: 'Pick enemy or neutral land next to your border' };
  out.launch = launch;
  // Simulate on a copy of the division (no state change).
  const [from, aim] = frontOfLine(state, playerId, launch, aimPoint(state, playerId, launch, tile));
  const sim: Unit = { ...u, troops: { ...u.troops }, path: [], launch: from, target: aim, targetOwner: target };
  const w = map.width;
  const { lx, ly, ux, uy } = lineOf(state, sim);
  const start = total(sim.troops);
  const floor = start * TANK_SPEARHEAD_MIN_SHARE;
  const limit = maxDepth(state, sim);
  const seen = new Set<string>();
  const warn = (s: string): void => {
    if (!seen.has(s)) {
      seen.add(s);
      out.warnings.push(s);
    }
  };
  let prev = from;
  let stopped = false;
  for (let d = 1; d <= limit; d++) {
    const x = Math.round(lx + ux * d);
    const y = Math.round(ly + uy * d);
    if (x < 0 || y < 0 || x >= w || y >= map.height) break;
    const t = y * w + x;
    if (t === prev) continue;
    prev = t;
    out.path.push(t);
    if (stopped) continue;
    const o = map.owner[t];
    if (o === playerId && !isWater(map.terrain[t])) continue; // own pockets cost nothing
    const ter = map.terrain[t];
    if (ter === Terrain.Mountains) warn(artillerySupport(sim) ? 'Mountains ahead: slow and costly even with artillery' : 'Mountains ahead: spearhead will stall');
    if (ter === Terrain.Forest || ter === Terrain.Hills) warn('Forests or hills ahead: the spearhead slows down');
    if (ter === Terrain.Swamp) warn('Swamp ahead: the spearhead bogs down');
    if (o > 0 && fortMultiplierAt(state, t, o) > 1.01) warn(artillerySupport(sim) ? 'Fort ahead: artillery will breach it at a high cost' : 'Fort ahead: spearhead will stop (bring artillery)');
    const c = bandCost(state, sim, t, o);
    if (typeof c === 'string') {
      if (c === 'reached the coast') warn('Water ahead: the spearhead ends at the coast');
      else if (c === 'ran into another nation') warn('Another nation ahead: the spearhead stops at its border');
      stopped = true;
      continue;
    }
    if (total(sim.troops) - c.loss < floor) {
      stopped = true;
      continue;
    }
    for (const k of TROOP_TYPES) sim.troops[k] = Math.max(0, sim.troops[k] - (c.loss * sim.troops[k]) / Math.max(1e-9, total(sim.troops)));
    out.expectedDepth++;
  }
  if (target > 0 && armorShare(state.players[target]) > 0.3) warn('Armor-heavy defence: expect heavy losses');
  if (out.expectedDepth < 3) warn('Too weak to get far here');
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// AI
// ---------------------------------------------------------------------------------------------------------------

/**
 * AI nations (called from ai.ts on their decision ticks, through applyAction like any player): build a division
 * when rich in armor and a Factory allows it; send idle divisions to spearhead into the nation they are fighting.
 */
export function aiTankDivisions(state: GameState, id: number, act: (a: Action) => ActionResult): void {
  const p = state.players[id];
  if (!p || !p.alive || isTribe(p) || p.isHuman || !hasTech(p, 'mechanization')) return;
  const personality = p.personality ?? 'balanced';
  // Warlords commit to armor: as many divisions as their factories allow (up to 6).
  const wantMax = personality === 'warlord' ? Math.max(3, Math.min(6, tankDivisionLimit(state, id))) : personality === 'turtle' || personality === 'merchant' ? 1 : 2;
  const mine = state.units.filter((u) => u.type === 'tankDivision' && u.owner === id && u.hp > 0);
  const c = tankDivisionCost(state, id);
  if (
    tankDivisionCount(state, id) < Math.min(wantMax, tankDivisionLimit(state, id)) &&
    p.gold > c.gold * 2.5 &&
    p.iron >= c.iron * 1.5 &&
    p.oil >= c.oil * 1.5 &&
    p.troops.armor >= TANK_DIVISION_TROOPS.armor * 1.5
  ) {
    const f = bestFactory(state, id);
    if (f >= 0) act({ type: 'buildTankDivision', tile: f });
  }
  // 'Support front' mode on the main war's front: they strike weak spots, cut pockets and refit by themselves (armor2.ts).
  aiDivisionModes(state, id, act);
  const idle = mine.filter((u) => u.state === 0 && total(u.troops) >= FULL_DIVISION * ARMOR_SUPPORT_READY);
  if (!idle.length || personality === 'turtle') return;
  // The war we fight with the most troops (nations before tribes), or else the nation attacking us hardest: an idle
  // division strikes back rather than wait to be overrun.
  let best: { target: number; troops: number } | null = null;
  for (const a of state.attacks) {
    let foe: number;
    let weight: number;
    if (a.attacker === id && a.target !== 0) {
      foe = a.target;
      weight = isTribe(state.players[a.target]) ? 0.3 : 1;
    } else if (a.target === id && a.attacker !== 0 && !isTribe(state.players[a.attacker])) {
      foe = a.attacker;
      weight = 0.8;
    } else continue;
    const score = total(a.troops) * weight;
    if (!best || score > best.troops) best = { target: foe, troops: score };
  }
  if (!best) return;
  // Their border tile nearest to our first idle division, if the line from there looks worth it.
  const lead = idle[0];
  const w = state.map.width;
  let tile = -1;
  let bestD = Infinity;
  for (const t of frontTiles(state, id, best.target, 64)) {
    const dx = (t % w) - lead.x;
    const dy = ((t / w) | 0) - lead.y;
    const d = dx * dx + dy * dy;
    if (d < bestD || (d === bestD && t < tile)) {
      bestD = d;
      tile = t;
    }
  }
  if (tile < 0) return;
  const ids = idle.slice(0, 2).map((u) => u.id);
  // Far from that front: drive up first (the front moves while they drive); spearhead on a later decision.
  if (bestD > 30 * 30) {
    const near = launchTileFor(state, id, tile);
    if (near >= 0) act({ type: 'moveTankDivision', unitIds: ids, tile: near });
    return;
  }
  // Launch once the line looks worth it (the preview's 'Too weak to get far' bar): waiting longer at the front mostly
  // ends with the division overrun where it stands.
  if (spearheadPreview(state, id, lead.id, tile).expectedDepth < 3) return;
  act({ type: 'moveTankDivision', unitIds: ids, tile });
}
