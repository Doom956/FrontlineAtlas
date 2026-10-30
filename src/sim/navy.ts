// Warships, part two (units.ts keeps movement, patrols and gunnery):
// - ordering a warship on a clicked water tile near an own port (Action buildWarship with `tile`), built over
//   WARSHIP_BUILD_SECONDS in state.unitQueue;
// - auto-intercept: a patrolling warship that sees an enemy ship within WARSHIP_DETECT_RANGE leaves its post
//   (Unit.cargo, its patrol centre) to chase it (transports first, then warships, then trade ships of nations at war)
//   and sails back when the target is gone, out of sight for WARSHIP_CHASE_GIVE_UP seconds, or beyond WARSHIP_LEASH
//   from the post. Warship states: 0 patrolling, 1 sailing to an ordered tile, 2 chasing Unit.chase;
// - group orders (Action moveWarships) in a loose formation;
// - formationTiles, shared with tank divisions (tanks.ts).
// Everything is deterministic (no RNG here; scans are staggered by unit id).
import { buildingAt, buildingsOf } from './buildings';
import {
  MAX_GROUP_UNITS,
  TICKS_PER_SECOND,
  WARSHIP_BUILD_SECONDS,
  WARSHIP_CHASE_GIVE_UP,
  WARSHIP_DETECT_RANGE,
  WARSHIP_LEASH,
  WARSHIP_SCAN_TICKS,
  WARSHIP_SPAWN_RANGE,
} from './config';
import { areAllied } from './diplomacy';
import { neighbors4, sameWater, waterPath } from './grid';
import { atPeace, buildSeconds, unitRule } from './rules';
import { addEvent, newId } from './state';
import { hasTech } from './tech';
import { moveWarship, spawnWarshipAt, unitCost } from './units';
import { isWater } from './types';
import type { ActionResult, Building, GameState, QueuedUnit, Unit } from './types';

const FAIL = (reason: string): ActionResult => ({ ok: false, reason });

function isTileIn(state: GameState, t: unknown): t is number {
  return typeof t === 'number' && Number.isInteger(t) && t >= 0 && t < state.map.width * state.map.height;
}
function tileDist2(w: number, a: number, b: number): number {
  const dx = (a % w) - (b % w);
  const dy = ((a / w) | 0) - ((b / w) | 0);
  return dx * dx + dy * dy;
}

// ---------------------------------------------------------------------------------------------------------------
// Ordering a warship where you click
// ---------------------------------------------------------------------------------------------------------------

/** The queue of units under construction (created on first use). */
export function unitQueue(state: GameState): QueuedUnit[] {
  if (!state.unitQueue) state.unitQueue = [];
  return state.unitQueue;
}

/**
 * Port that can build a warship on water tile `tile` for playerId: `port` itself when given (>= 0), else the nearest
 * own finished port within WARSHIP_SPAWN_RANGE whose sea reaches the tile. Returns the port or a reason.
 */
export function warshipSpawnPort(state: GameState, playerId: number, port: number, tile: number): Building | string {
  const map = state.map;
  if (!isTileIn(state, tile)) return 'Invalid tile';
  if (!isWater(map.terrain[tile])) return 'Click a water tile: warships are placed at sea';
  const w = map.width;
  const r2 = WARSHIP_SPAWN_RANGE * WARSHIP_SPAWN_RANGE;
  const ok = (b: Building): string | null => {
    if (tileDist2(w, b.tile, tile) > r2) return `Too far from your port: at most ${WARSHIP_SPAWN_RANGE} tiles`;
    if (!sameWater(map, b.tile, tile)) return "That water can't be reached by sea from your port";
    return null;
  };
  if (port >= 0) {
    const b = isTileIn(state, port) ? buildingAt(state, port) : undefined;
    if (!b || b.type !== 'port' || b.owner !== playerId || b.buildLeft > 0) return 'Warships are built at a finished Port of yours';
    return ok(b) ?? b;
  }
  let best: Building | null = null;
  let bestD = Infinity;
  let why = 'You need a finished Port first';
  for (const b of buildingsOf(state, playerId, 'port')) {
    if (b.owner !== playerId || b.buildLeft > 0) continue;
    const bad = ok(b);
    if (bad) {
      why = bad;
      continue;
    }
    const d = tileDist2(w, b.tile, tile);
    if (d < bestD || (d === bestD && best && b.id < best.id)) {
      bestD = d;
      best = b;
    }
  }
  return best ?? why;
}

/** Can playerId order a warship at port / water tile right now? (ok, or the reason; nothing changes) */
export function canOrderWarship(state: GameState, playerId: number, port: number, tile?: number): ActionResult & { port?: number; water?: number } {
  const p = state.players[playerId];
  if (!p || playerId === 0 || !p.alive) return FAIL('No such player');
  const ruled = unitRule(state, 'warship');
  if (ruled) return FAIL(ruled);
  if (!hasTech(p, 'navigation')) return FAIL('Needs research: Navigation');
  let site: Building;
  let water = -1;
  if (tile === undefined) {
    const b = isTileIn(state, port) ? buildingAt(state, port) : undefined;
    if (!b || b.type !== 'port' || b.owner !== playerId || b.buildLeft > 0) return FAIL('Warships are built at a finished Port of yours');
    site = b;
    const nb: number[] = [];
    const k = neighbors4(state.map, b.tile, nb);
    for (let q = 0; q < k && water < 0; q++) if (isWater(state.map.terrain[nb[q]])) water = nb[q];
    if (water < 0) return FAIL('This port has no open water');
  } else {
    const r = warshipSpawnPort(state, playerId, port, tile);
    if (typeof r === 'string') return FAIL(r);
    site = r;
    water = tile;
  }
  const c = unitCost(state, playerId, 'warship');
  if (p.gold < c.gold) return FAIL(`Not enough gold (${c.gold})`);
  if (p.iron < c.iron) return FAIL(`Not enough iron (${c.iron})`);
  if (p.oil < c.oil) return FAIL(`Not enough oil (${c.oil})`);
  return { ok: true, port: site.tile, water };
}

/** Seconds a warship order takes (build speed modifiers apply; 'instant' = at once). */
export function warshipBuildSeconds(state: GameState): number {
  return buildSeconds(state, WARSHIP_BUILD_SECONDS);
}

/**
 * Action buildWarship: pays now; the ship appears on the water tile after warshipBuildSeconds (at once with instant
 * construction). Without `tile` it appears next to the port.
 */
export function orderWarship(state: GameState, playerId: number, port: number, tile?: number): ActionResult {
  const r = canOrderWarship(state, playerId, port, tile);
  if (!r.ok) return r;
  const p = state.players[playerId];
  const c = unitCost(state, playerId, 'warship');
  p.gold -= c.gold;
  p.iron -= c.iron;
  p.oil -= c.oil;
  const ticks = Math.round(warshipBuildSeconds(state) * TICKS_PER_SECOND);
  if (ticks <= 1) {
    spawnWarshipAt(state, playerId, r.port!, r.water!);
    return { ok: true };
  }
  unitQueue(state).push({
    id: newId(state),
    type: 'warship',
    owner: playerId,
    site: r.port!,
    tile: r.water!,
    readyTick: state.tick + ticks,
    troops: { infantry: 0, armor: 0, artillery: 0 },
  });
  return { ok: true };
}

/** Warships whose time is up appear (if their port is still ours); others wait. Called every tick. */
export function updateNavyQueue(state: GameState): void {
  const q = state.unitQueue;
  if (!q || !q.some((u) => u.type === 'warship')) return;
  let changed = false;
  for (const item of q) {
    if (item.type !== 'warship' || item.readyTick > state.tick) continue;
    changed = true;
    item.readyTick = -1;
    const p = state.players[item.owner];
    if (!p || !p.alive) continue;
    const port = buildingAt(state, item.site);
    if (!port || port.type !== 'port' || port.owner !== item.owner) {
      addEvent(state, 'unitLost', `${p.name} lost a warship being built: its port is gone`, [item.owner], item.site);
      continue;
    }
    spawnWarshipAt(state, item.owner, item.site, item.tile);
    addEvent(state, 'warshipReady', 'Warship ready', [item.owner], item.tile);
  }
  if (changed) state.unitQueue = q.filter((u) => u.readyTick >= 0);
}

// ---------------------------------------------------------------------------------------------------------------
// Formations and group orders
// ---------------------------------------------------------------------------------------------------------------

/** Offsets (dx, dy) of formation slots, 2 tiles apart, nearest first (fixed order: distance, then y, then x). */
const SLOTS: [number, number][] = (() => {
  const out: [number, number][] = [];
  for (let dy = -16; dy <= 16; dy += 2) for (let dx = -16; dx <= 16; dx += 2) out.push([dx, dy]);
  out.sort((a, b) => a[0] * a[0] + a[1] * a[1] - (b[0] * b[0] + b[1] * b[1]) || a[1] - b[1] || a[0] - b[0]);
  return out;
})();

/**
 * Up to n distinct tiles around `center` for a group (the centre first, then rings 2 tiles apart) that pass
 * `accept`. Fewer when not enough tiles qualify.
 */
export function formationTiles(state: GameState, center: number, n: number, accept: (t: number) => boolean): number[] {
  const w = state.map.width;
  const h = state.map.height;
  const cx = center % w;
  const cy = (center / w) | 0;
  const out: number[] = [];
  for (const [dx, dy] of SLOTS) {
    if (out.length >= n) break;
    const x = cx + dx;
    const y = cy + dy;
    if (x < 0 || y < 0 || x >= w || y >= h) continue;
    const t = y * w + x;
    if (accept(t)) out.push(t);
  }
  return out;
}

/**
 * Checks a unit id list: 1..MAX_GROUP_UNITS distinct integers naming alive units of `type` owned by playerId.
 * Returns the units (in the given order) or a reason.
 */
export function ownGroup(state: GameState, playerId: number, ids: unknown, type: Unit['type'], what: string): Unit[] | string {
  if (!Array.isArray(ids) || ids.length === 0) return `Select ${what} first`;
  if (ids.length > MAX_GROUP_UNITS) return `At most ${MAX_GROUP_UNITS} ${what} per order`;
  const seen = new Set<number>();
  const out: Unit[] = [];
  for (const id of ids) {
    if (typeof id !== 'number' || !Number.isInteger(id) || seen.has(id)) return 'Invalid unit list';
    seen.add(id);
    const u = state.units.find((q) => q.id === id);
    if (!u || u.type !== type || u.owner !== playerId || u.hp <= 0) return `Only your own ${what} can be given orders`;
    out.push(u);
  }
  return out;
}

/** Action moveWarships: every listed own warship sails to its own slot of a formation around the water tile. */
export function moveWarships(state: GameState, playerId: number, unitIds: unknown, tile: number): ActionResult {
  const group = ownGroup(state, playerId, unitIds, 'warship', 'warships');
  if (typeof group === 'string') return FAIL(group);
  if (!isTileIn(state, tile)) return FAIL('Invalid tile');
  const map = state.map;
  if (!isWater(map.terrain[tile]) && !map.coastal[tile]) return FAIL('Warships sail on water');
  if (group.length === 1) return moveWarship(state, playerId, group[0].id, tile);
  // Slots on water of the same sea as the clicked tile; ships take them in id order.
  const slots = formationTiles(state, tile, group.length, (t) => isWater(map.terrain[t]) && sameWater(map, t, tile));
  const ships = group.slice().sort((a, b) => a.id - b.id);
  let moved = 0;
  let reason = 'Your warships cannot reach there';
  for (let k = 0; k < ships.length; k++) {
    const r = moveWarship(state, playerId, ships[k].id, slots.length ? slots[k % slots.length] : tile);
    if (r.ok) moved++;
    else if (r.reason) reason = r.reason;
  }
  return moved > 0 ? { ok: true } : FAIL(reason);
}

// ---------------------------------------------------------------------------------------------------------------
// Auto-intercept
// ---------------------------------------------------------------------------------------------------------------

function hostileTo(state: GameState, a: number, b: number): boolean {
  return a !== b && a > 0 && b > 0 && !areAllied(state, a, b) && !atPeace(state, a, b);
}

/** Interception rank of ship s for warship owner `me` (lower first), or -1 when it is not a target. */
function interceptRank(state: GameState, me: number, s: Unit, wars: Set<number>): number {
  if (s.hp <= 0 || !hostileTo(state, me, s.owner)) return -1;
  if (s.type === 'transport') return 0;
  if (s.type === 'warship') return 1;
  if (s.type === 'tradeShip') {
    if (!wars.has(me * 1024 + s.owner)) return -1;
    if (s.targetOwner === me || areAllied(state, s.targetOwner, me)) return -1;
    return 2;
  }
  return -1;
}

function d2(ax: number, ay: number, bx: number, by: number): number {
  const dx = ax - bx;
  const dy = ay - by;
  return dx * dx + dy * dy;
}

/** Water tile a ship is on (or heading to). */
function shipTileOf(state: GameState, u: Unit): number {
  if (u.path.length) return u.path[Math.min(u.pathPos, u.path.length - 1)];
  return Math.round(u.y) * state.map.width + Math.round(u.x);
}

/** Sends a chasing warship back to its post (state 1: on arrival it patrols there again). */
function returnToPost(state: GameState, u: Unit): void {
  u.chase = 0;
  u.chaseLost = 0;
  const from = shipTileOf(state, u);
  const path = waterPath(state.map, from, u.cargo, 4 * WARSHIP_LEASH, 6000);
  if (path && path.length) {
    u.path = path;
    u.pathPos = 0;
    u.target = path[path.length - 1];
    u.state = 1;
  } else {
    u.path = [];
    u.pathPos = 0;
    u.state = 0;
    u.cargo = from;
  }
}

function chaseTo(state: GameState, u: Unit, t: Unit): boolean {
  const to = shipTileOf(state, t);
  const path = waterPath(state.map, shipTileOf(state, u), to, 4 * WARSHIP_DETECT_RANGE, 4000);
  if (!path) return false;
  u.path = path;
  u.pathPos = 0;
  u.target = to;
  return true;
}

/**
 * Auto-intercept for one warship (called by units.updateWarship before it moves). Patrolling ships scan every
 * WARSHIP_SCAN_TICKS ticks (staggered by id); chasing ships re-aim at the same pace.
 */
export function interceptStep(state: GameState, u: Unit, ships: readonly Unit[], wars: Set<number>): void {
  if (u.state === 1) return; // under orders: sails on (it still fights whatever comes in range)
  if ((state.tick + u.id) % WARSHIP_SCAN_TICKS !== 0) return;
  const w = state.map.width;
  const postX = u.cargo % w;
  const postY = (u.cargo / w) | 0;
  const leash2 = WARSHIP_LEASH * WARSHIP_LEASH;
  const detect2 = WARSHIP_DETECT_RANGE * WARSHIP_DETECT_RANGE;
  if (u.state === 2) {
    const t = u.chase ? ships.find((s) => s.id === u.chase) : undefined;
    if (!t || interceptRank(state, u.owner, t, wars) < 0 || d2(t.x, t.y, postX, postY) > leash2) {
      returnToPost(state, u);
      return;
    }
    if (d2(t.x, t.y, u.x, u.y) > detect2) {
      u.chaseLost = (u.chaseLost ?? 0) + WARSHIP_SCAN_TICKS;
      if (u.chaseLost >= WARSHIP_CHASE_GIVE_UP * TICKS_PER_SECOND) {
        returnToPost(state, u);
        return;
      }
    } else u.chaseLost = 0;
    // Re-aim when the target moved away from where we are heading.
    const end = u.path.length ? u.path[u.path.length - 1] : -1;
    if (end < 0 || u.pathPos >= u.path.length || d2(end % w, (end / w) | 0, t.x, t.y) > 9) {
      if (!chaseTo(state, u, t)) returnToPost(state, u);
    }
    return;
  }
  // Patrolling: the best target in sight (rank, then distance, then id) within the leash of our post.
  let best: Unit | null = null;
  let bestRank = 99;
  let bestD = Infinity;
  for (const s of ships) {
    if (s === u || s.owner === u.owner) continue;
    const d = d2(s.x, s.y, u.x, u.y);
    if (d > detect2) continue;
    const rank = interceptRank(state, u.owner, s, wars);
    if (rank < 0 || d2(s.x, s.y, postX, postY) > leash2) continue;
    if (rank < bestRank || (rank === bestRank && (d < bestD || (d === bestD && best !== null && s.id < best.id)))) {
      best = s;
      bestRank = rank;
      bestD = d;
    }
  }
  if (!best) return;
  if (!chaseTo(state, u, best)) return;
  u.state = 2;
  u.chase = best.id;
  u.chaseLost = 0;
}

/** The ship a chasing warship should shoot when it is within `range` (its chase target), else null. */
export function chaseTargetInRange(u: Unit, ships: readonly Unit[], range: number): Unit | null {
  if (u.state !== 2 || !u.chase) return null;
  const t = ships.find((s) => s.id === u.chase);
  if (!t || t.hp <= 0) return null;
  return d2(t.x, t.y, u.x, u.y) <= range * range ? t : null;
}
