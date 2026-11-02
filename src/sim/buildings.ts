// Building rules and lookups (DESIGN section 5).
//
// Buildings are few and levelled. A build order at tile T (resolveBuildTarget, the single source of truth that the
// client previews with):
//   1. an own building of the same type within BUILDING_UPGRADE_RADIUS of T is upgraded (level + 1, the nearest one;
//      busy or top-level ones are reported, a top-level one lets a new building go elsewhere),
//   2. otherwise the order snaps to the nearest valid own tile within BUILDING_SNAP_RADIUS of T (T itself first, then
//      by distance, then row, then column), at least the map size's spacing (buildingSpacing) from every building.
// Every effect scales with the level: countBuildings returns the SUM OF LEVELS, so "+12% gold per market" means per
// market level; forts, SAMs, watchtowers, airfields and depots also reach further per level (helpers below).
import {
  AIRCRAFT_MAX_PER_AIRFIELD,
  AIRFIELD_LEVEL_RADIUS,
  BUILDING_DEMOLISH_REFUND,
  BUILDING_MIN_SPACING,
  BUILDING_MIN_SPACING_BY_SIZE,
  BUILDING_ORDER,
  BUILDING_REPAIR_PER_S,
  DOCTRINE_PERKS,
  BUILDING_SNAP_RADIUS,
  BUILDING_UPGRADE_RADIUS,
  BUILDINGS,
  DEPOT_LEVEL_RADIUS,
  DEPOT_RADIUS,
  FORT_DEFENSE,
  FORT_DEFENSE_TECH,
  FORT_LEVEL_DEFENSE,
  FORT_LEVEL_RADIUS,
  FORT_RADIUS_TECH,
  SAM_COOLDOWN,
  SAM_LEVEL_RADIUS,
  SILO_COOLDOWN,
  TECHS,
  TERRAIN,
  TICK_SECONDS,
  TRADE_INTERVAL,
  WATCHTOWER_DEF,
  WATCHTOWER_DEF_RADIUS,
  WATCHTOWER_LEVEL_RADIUS,
} from './config';
import { areAllied } from './diplomacy';
import { buildingRule, buildSeconds } from './rules';
import { addEvent, newId } from './state';
import { doctrineLess, doctrineMore, doctrinePerk } from './doctrines';
import { ownsNear } from './territory';
import { hasTech } from './tech';
import { revealIntel } from './variants';
import { techBuildingCostMul, techBuildTimeMul } from './techtree';
import { isWater, Resource } from './types';
import type { ActionResult, Building, BuildingType, GameState, MapSize, TerrainId, Troops } from './types';

const FAIL = (reason: string): ActionResult => ({ ok: false, reason });

// ---------------------------------------------------------------------------------------------------------------
// Per-player building index.
//
// state.buildings is a flat Map; most lookups want "buildings of player P of type T". The index groups them and is
// kept up to date incrementally: build / destroyBuilding / captures (setOwner -> onBuildingCaptured) / finishing and
// upgrades move or touch single entries; per-player counts (Summary) are recomputed on first use after a change for
// that player. Anything else that changes state.buildings (elimination, tests) changes the Map's size or calls
// markBuildingsChanged, which rebuilds the index (O(#buildings)). state.buildingsVersion is bumped on every change.
// ---------------------------------------------------------------------------------------------------------------

type TypeLists = Record<BuildingType, Building[]>;
/** Per-player counts (computed on first use after a change for that player). */
interface Summary {
  /** sum of the working levels of finished buildings */
  finished: Record<BuildingType, number>;
  /** sum of levels incl. unfinished buildings (level 1) and running upgrades (+1): the cost basis */
  all: Record<BuildingType, number>;
  /** number of separate buildings (finished / incl. unfinished) */
  sitesFinished: Record<BuildingType, number>;
  sitesAll: Record<BuildingType, number>;
  /** finished farm levels, a farm on Fertile land counting twice */
  farmUnits: number;
}
interface BuildingIndex {
  size: number;
  byPlayer: Map<number, TypeLists>;
  summaries: Map<number, Summary>;
  /** per-player change stamps (cache keys for derived data such as supply sources) */
  stamps: Map<number, number>;
  baseStamp: number;
}
const indexes = new WeakMap<GameState, BuildingIndex>();
const stampSeqs = new WeakMap<GameState, { n: number }>();
function nextStamp(state: GameState): number {
  let s = stampSeqs.get(state);
  if (!s) stampSeqs.set(state, (s = { n: 0 }));
  return ++s.n;
}

function emptyLists(): TypeLists {
  const r = {} as TypeLists;
  for (const t of BUILDING_ORDER) r[t] = [];
  return r;
}
const EMPTY_LISTS: TypeLists = emptyLists();

/** state.buildingsVersion: changes whenever a building is added, removed, finished, upgraded or captured. */
export function buildingVersion(state: GameState): number {
  return state.buildingsVersion;
}
/** Call after changing state.buildings or a building's fields by hand (tests, scripts): rebuilds the index. */
export function markBuildingsChanged(state: GameState): void {
  state.buildingsVersion++;
  indexes.delete(state);
}
/** A number that changes whenever a building of playerId is added, removed, finished, upgraded or captured. */
export function buildingStamp(state: GameState, playerId: number): number {
  const idx = getIndex(state);
  return idx.stamps.get(playerId) ?? idx.baseStamp;
}

function getIndex(state: GameState): BuildingIndex {
  let idx = indexes.get(state);
  if (idx && idx.size === state.buildings.size) return idx;
  const byPlayer = new Map<number, TypeLists>();
  for (const b of state.buildings.values()) {
    let lists = byPlayer.get(b.owner);
    if (!lists) {
      lists = emptyLists();
      byPlayer.set(b.owner, lists);
    }
    lists[b.type].push(b);
  }
  idx = { size: state.buildings.size, byPlayer, summaries: new Map(), stamps: new Map(), baseStamp: nextStamp(state) };
  indexes.set(state, idx);
  return idx;
}
function listsOf(state: GameState, playerId: number): TypeLists {
  return getIndex(state).byPlayer.get(playerId) ?? EMPTY_LISTS;
}
/** A building's level, queue or timers were changed outside this file (bulkbuild.ts): refresh its owner's counts. */
export function noteBuildingChanged(state: GameState, b: Building): void {
  touch(state, indexes.get(state), b.owner);
}
/** A player's buildings changed (counts, levels, finished): drop its cached counts. */
function touch(state: GameState, idx: BuildingIndex | undefined, playerId: number): void {
  state.buildingsVersion++;
  if (!idx) return;
  idx.summaries.delete(playerId);
  idx.stamps.set(playerId, nextStamp(state));
}
/** Adds a building that was just put into state.buildings to the index. */
function indexAdd(state: GameState, b: Building): void {
  const idx = indexes.get(state);
  if (idx && idx.size === state.buildings.size - 1) {
    let lists = idx.byPlayer.get(b.owner);
    if (!lists) idx.byPlayer.set(b.owner, (lists = emptyLists()));
    lists[b.type].push(b);
    idx.size = state.buildings.size;
  } else indexes.delete(state);
  touch(state, indexes.get(state), b.owner);
}
/** Removes a building that was just deleted from state.buildings from the index. */
function indexRemove(state: GameState, b: Building): void {
  const idx = indexes.get(state);
  if (idx && idx.size === state.buildings.size + 1) {
    const list = idx.byPlayer.get(b.owner)?.[b.type];
    const k = list ? list.indexOf(b) : -1;
    if (k >= 0) {
      list!.splice(k, 1);
      idx.size = state.buildings.size;
    } else indexes.delete(state);
  } else indexes.delete(state);
  touch(state, indexes.get(state), b.owner);
}
/** setOwner hook: building b changed owner from prevOwner to b.owner (a capture). */
export function onBuildingCaptured(state: GameState, b: Building, prevOwner: number): void {
  // Queued levels (bulkbuild.ts) were the old owner's order: they are lost with the building.
  b.queuedLevels = 0;
  delete b.queuedPaid;
  const idx = indexes.get(state);
  if (idx && idx.size === state.buildings.size) {
    const list = idx.byPlayer.get(prevOwner)?.[b.type];
    const k = list ? list.indexOf(b) : -1;
    if (k >= 0) {
      list!.splice(k, 1);
      let lists = idx.byPlayer.get(b.owner);
      if (!lists) idx.byPlayer.set(b.owner, (lists = emptyLists()));
      // In id order, like a rebuilt index (state.buildings holds them in id order): the lists must not depend on
      // whether the index was rebuilt in between, which a client read between ticks can do (lockstep).
      const to = lists[b.type];
      let at = to.length;
      while (at > 0 && to[at - 1].id > b.id) at--;
      to.splice(at, 0, b);
    } else indexes.delete(state);
  }
  const now = indexes.get(state);
  touch(state, now, prevOwner);
  touch(state, now, b.owner);
}
function zeroCounts(): Record<BuildingType, number> {
  const r = {} as Record<BuildingType, number>;
  for (const t of BUILDING_ORDER) r[t] = 0;
  return r;
}
/** Building counts of a player for the current index (cached until the buildings change). */
function summaryOf(state: GameState, playerId: number): Summary {
  const idx = getIndex(state);
  let s = idx.summaries.get(playerId);
  if (s) return s;
  s = { finished: zeroCounts(), all: zeroCounts(), sitesFinished: zeroCounts(), sitesAll: zeroCounts(), farmUnits: 0 };
  const lists = idx.byPlayer.get(playerId) ?? EMPTY_LISTS;
  for (const t of BUILDING_ORDER) {
    for (const b of lists[t]) {
      if (!isLive(state, b, playerId, true)) continue;
      s.sitesAll[t]++;
      s.all[t] += b.level + (b.upgradeLeft > 0 ? 1 : 0) + (b.queuedLevels || 0);
      if (b.buildLeft > 0) continue;
      s.sitesFinished[t]++;
      s.finished[t] += b.level;
      if (t === 'farm') s.farmUnits += b.level * (state.map.resource[b.tile] === Resource.Fertile ? 2 : 1);
    }
  }
  idx.summaries.set(playerId, s);
  return s;
}
function isLive(state: GameState, b: Building, playerId: number, includeUnfinished: boolean): boolean {
  return b.owner === playerId && (includeUnfinished || b.buildLeft <= 0) && state.buildings.get(b.id) === b;
}

// ---------------------------------------------------------------------------------------------------------------
// Levels and level-scaled effects
// ---------------------------------------------------------------------------------------------------------------

/** Highest level of a building type (config BUILDINGS[type].maxLevel). */
export function buildingMaxLevel(type: BuildingType): number {
  return BUILDINGS[type]?.maxLevel ?? 1;
}
/** Minimum distance (tiles, straight line) between any two buildings on this game's map size. */
export function buildingSpacing(state: GameState): number {
  return BUILDING_MIN_SPACING_BY_SIZE[state.mapClass as MapSize] ?? BUILDING_MIN_SPACING;
}
/** True while a barrage keeps the building out of action (forts give no bonus, SAMs can't fire). */
export function isDisabled(state: GameState, b: Building): boolean {
  return b.disabledUntil > state.tick;
}
/** Cover radius of a fort (Fortification: FORT_RADIUS_TECH) + FORT_LEVEL_RADIUS per level above 1. */
export function fortRadius(state: GameState, b: Building): number {
  const p = state.players[b.owner];
  const base = p && hasTech(p, 'fortification') ? FORT_RADIUS_TECH : BUILDINGS.fort.radius;
  return base + FORT_LEVEL_RADIUS * (b.level - 1);
}
/** Defence multiplier of a fort (Fortification: FORT_DEFENSE_TECH) + FORT_LEVEL_DEFENSE per level above 1. */
export function fortDefense(state: GameState, b: Building): number {
  const p = state.players[b.owner];
  const base = p && hasTech(p, 'fortification') ? FORT_DEFENSE_TECH : FORT_DEFENSE;
  // The Fortress doctrine strengthens what the fort adds (its multiplier above 1).
  return 1 + (base + FORT_LEVEL_DEFENSE * (b.level - 1) - 1) * doctrineMore(state, b.owner, 'fortDefense');
}
/** Interception radius of a SAM site. */
export function samRadius(b: Building): number {
  return BUILDINGS.sam.radius + SAM_LEVEL_RADIUS * (b.level - 1);
}
/** Fighter cover radius of an airfield. */
export function airfieldRadius(b: Building): number {
  return BUILDINGS.airfield.radius + AIRFIELD_LEVEL_RADIUS * (b.level - 1);
}
/** Aircraft an airfield can hold (bombers + fighters, incl. bombers out flying). */
export function aircraftCap(b: Building): number {
  return AIRCRAFT_MAX_PER_AIRFIELD * Math.max(1, b.level);
}
/** Attack-bonus radius of a supply depot. */
export function depotRadius(b: Building): number {
  return DEPOT_RADIUS + DEPOT_LEVEL_RADIUS * (b.level - 1);
}
/** Intel radius of one watchtower: base + WATCHTOWER_LEVEL_RADIUS per level above 1, Radar doubles it. */
export function watchtowerRadiusOf(state: GameState, b: Building): number {
  const p = state.players[b.owner];
  return (BUILDINGS.watchtower.radius + WATCHTOWER_LEVEL_RADIUS * (b.level - 1)) * (p && hasTech(p, 'radar') ? 2 : 1);
}

// ---------- SAM shots and silo launch slots ----------
// A level-L SAM site holds L shots, a level-L silo L launch slots. Building.cooldown is the reload debt in seconds:
// each shot / launch adds one reload time (SAM_COOLDOWN / SILO_COOLDOWN), the debt drains L seconds per second, and
// a shot is possible while the debt is at most (L - 1) reload times. So a salvo of L, then one more every reload / L
// seconds; level 1 behaves like a plain cooldown.
function reloadSeconds(b: Building): number {
  return b.type === 'silo' ? SILO_COOLDOWN : SAM_COOLDOWN;
}
/** Shots (SAM) or launches (silo) available right now, 0 .. level. */
export function chargesReady(b: Building): number {
  const t = reloadSeconds(b);
  const l = Math.max(1, b.level);
  return Math.max(0, Math.min(l, Math.floor((l * t - b.cooldown) / t + 1e-9)));
}
/** Seconds until the next shot / launch is available (0 if one is ready). */
export function nextChargeIn(b: Building): number {
  const t = reloadSeconds(b);
  const l = Math.max(1, b.level);
  const excess = b.cooldown - (l - 1) * t;
  return excess > 1e-9 ? excess / l : 0;
}
/** Spends one shot / launch (call only when chargesReady(b) > 0). */
export function useCharge(b: Building): void {
  b.cooldown += reloadSeconds(b);
}
/** One tick of reloading (units.ts). */
export function reloadTick(b: Building): void {
  if (b.cooldown > 0) b.cooldown = Math.max(0, b.cooldown - TICK_SECONDS * Math.max(1, b.level));
}

// ---------------------------------------------------------------------------------------------------------------
// Costs, placement and the build order
// ---------------------------------------------------------------------------------------------------------------

/**
 * Price of the next level of a type, new building or upgrade alike: base x (1 + costGrowth x levels of that type
 * owned, incl. unfinished buildings and running upgrades). Iron grows the same way.
 */
export function buildingCost(state: GameState, playerId: number, type: BuildingType): { gold: number; iron: number } {
  return buildingCostAfter(state, playerId, type, 0);
}
/** Price of the level after `extra` more levels of the type are ordered (bulk orders: bulkbuild.ts). */
export function buildingCostAfter(state: GameState, playerId: number, type: BuildingType, extra: number): { gold: number; iron: number } {
  const info = BUILDINGS[type];
  const owned = summaryOf(state, playerId).all[type] + extra;
  const k = (1 + info.costGrowth * owned) * (type === 'fort' ? doctrineLess(state, playerId, 'fortCost') : 1) * techBuildingCostMul(state, playerId, type);
  return { gold: Math.round(info.cost * k), iron: Math.round(info.iron * k) };
}
/** Seconds a construction or upgrade of `type` takes for playerId (Fortress level 3: forts much faster; Automation). */
export function buildTimeFor(state: GameState, playerId: number, type: BuildingType): number {
  const base = BUILDINGS[type].buildTime * (type === 'fort' && doctrinePerk(state, playerId, 'fortress') ? DOCTRINE_PERKS.fortress.fortBuildTime : 1) * techBuildTimeMul(state, playerId);
  return buildSeconds(state, base);
}

/** Cost of a build order of `type` at `tile` (upgrade or new: the same price, see buildingCost). */
export function buildCostAt(state: GameState, playerId: number, type: BuildingType, tile: number): { gold: number; iron: number } {
  void tile;
  return buildingCost(state, playerId, type);
}

/** True if there is a tile of resource `res` owned by playerId within `r` (Chebyshev) of tile. */
function depositNear(state: GameState, playerId: number, tile: number, res: number, r: number): boolean {
  const map = state.map;
  const w = map.width;
  const cx = tile % w;
  const cy = (tile / w) | 0;
  for (let y = Math.max(0, cy - r); y <= Math.min(map.height - 1, cy + r); y++) {
    for (let x = Math.max(0, cx - r); x <= Math.min(w - 1, cx + r); x++) {
      const i = y * w + x;
      if (map.resource[i] === res && map.owner[i] === playerId) return true;
    }
  }
  return false;
}

function dist2(w: number, a: number, b: number): number {
  const dx = (a % w) - (b % w);
  const dy = ((a / w) | 0) - ((b / w) | 0);
  return dx * dx + dy * dy;
}

/** Every building within r tiles (straight line) of tile, from the map's building layer (no index needed). */
function buildingsNear(state: GameState, tile: number, r: number): Building[] {
  const map = state.map;
  const w = map.width;
  const cx = tile % w;
  const cy = (tile / w) | 0;
  const out: Building[] = [];
  const r2 = r * r;
  for (let y = Math.max(0, cy - r); y <= Math.min(map.height - 1, cy + r); y++) {
    const dy = y - cy;
    for (let x = Math.max(0, cx - r); x <= Math.min(w - 1, cx + r); x++) {
      const i = y * w + x;
      if (map.building[i] === 0) continue;
      const dx = x - cx;
      if (dx * dx + dy * dy > r2) continue;
      const b = state.buildings.get(map.building[i] - 1);
      if (b) out.push(b);
    }
  }
  return out;
}

/** Snap search order: offsets within BUILDING_SNAP_RADIUS by distance, then row, then column (an immutable table). */
const SNAP_OFFSETS: readonly (readonly [number, number])[] = (() => {
  const r = BUILDING_SNAP_RADIUS;
  const out: [number, number, number][] = [];
  for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) if (dx * dx + dy * dy <= r * r) out.push([dx, dy, dx * dx + dy * dy]);
  out.sort((a, b) => a[2] - b[2] || a[1] - b[1] || a[0] - b[0]);
  return out.map(([dx, dy]) => [dx, dy] as const);
})();

/**
 * Why a NEW building of `type` can't stand exactly on `tile` (null = it can): ownership, water, fallout, terrain,
 * coast, deposits, an occupied tile, spacing to the given nearby buildings. Tech and money are checked elsewhere.
 */
function siteProblem(state: GameState, playerId: number, type: BuildingType, tile: number, crowded: boolean, spacing: number): string | null {
  const map = state.map;
  const info = BUILDINGS[type];
  if (map.owner[tile] !== playerId) return 'You must build on your own territory';
  const terrain = map.terrain[tile] as TerrainId;
  if (isWater(terrain)) return 'Cannot build on water';
  if (map.fallout[tile] > 0) return 'This land is irradiated';
  if (TERRAIN[terrain].noBuild.includes(type)) return `Cannot build ${/^[AEIOU]/.test(info.name) ? 'an' : 'a'} ${info.name} on ${TERRAIN[terrain].name}`;
  if (info.coastal && !map.coastal[tile]) return `A ${info.name} must be on the coast`;
  if (map.building[tile] !== 0) return 'This tile already has a building';
  if (type === 'mine' && !depositNear(state, playerId, tile, Resource.Iron, info.radius)) {
    return `A Mine must be within ${info.radius} tiles of an Iron deposit you own`;
  }
  if (type === 'oilWell' && !depositNear(state, playerId, tile, Resource.Oil, info.radius)) {
    return `An Oil Well must be within ${info.radius} tiles of an Oil deposit you own`;
  }
  if (crowded) return `Too close to another building (keep ${spacing} tiles apart)`;
  return null;
}

/** Scratch mask over the snap window (no state carried between calls). */
const SNAP_SIZE = 2 * BUILDING_SNAP_RADIUS + 1;
const crowdMask = new Uint8Array(SNAP_SIZE * SNAP_SIZE);
/**
 * Marks the snap-window cells around (cx, cy) closer than `spacing` (straight line) to any of the buildings:
 * crowdMask[(dy + R) * SNAP_SIZE + dx + R] = 1. One pass per building over the rows it reaches.
 */
function markCrowded(w: number, cx: number, cy: number, near: readonly Building[], spacing: number): void {
  crowdMask.fill(0);
  const R = BUILDING_SNAP_RADIUS;
  const s2 = spacing * spacing;
  for (const b of near) {
    const bx = (b.tile % w) - cx;
    const by = ((b.tile / w) | 0) - cy;
    for (let dy = Math.max(-R, by - spacing + 1); dy <= Math.min(R, by + spacing - 1); dy++) {
      const ry = dy - by;
      const left = s2 - ry * ry; // cells with rx^2 < left are too close
      if (left <= 0) continue;
      let half = Math.floor(Math.sqrt(left));
      if (half * half >= left) half--;
      const x0 = Math.max(-R, bx - half);
      const x1 = Math.min(R, bx + half);
      const row = (dy + R) * SNAP_SIZE + R;
      for (let dx = x0; dx <= x1; dx++) crowdMask[row + dx] = 1;
    }
  }
}

/** What a build order will do (resolveBuildTarget). */
export interface BuildPlan {
  /** where the new building goes, or the tile of the building that will be upgraded */
  tile: number;
  upgrade: boolean;
  cost: { gold: number; iron: number };
  /** the building's level once this order is done (1 for a new building) */
  level: number;
  /** id of the building that will be upgraded, -1 for a new one */
  buildingId: number;
  /** false when gold or iron is short (then `reason` says which); the order itself is possible */
  affordable: boolean;
  reason?: string;
}
export type BuildTarget = BuildPlan | { error: string };

/**
 * Exactly what a build order of `type` at `tile` by playerId will do (the client previews with this; build() and
 * canBuild() use it). Upgrade if an own building of the same type is within BUILDING_UPGRADE_RADIUS (the nearest; a
 * busy one is an error, a top-level one lets a new building go elsewhere), else snap to the nearest valid own tile
 * within BUILDING_SNAP_RADIUS. Pure: never changes the state. Cost: about 2 600 map reads plus 317 tile checks.
 */
export function resolveBuildTarget(state: GameState, playerId: number, type: BuildingType, tile: number): BuildTarget {
  const p = state.players[playerId];
  const info = BUILDINGS[type];
  if (!p || playerId === 0 || !p.alive) return { error: 'No such player' };
  if (!info) return { error: 'Unknown building' };
  const map = state.map;
  if (!Number.isInteger(tile) || tile < 0 || tile >= map.width * map.height) return { error: 'Invalid tile' };
  const ruled = buildingRule(state, type);
  if (ruled) return { error: ruled };
  if (info.tech && !hasTech(p, info.tech)) return { error: `Needs research: ${TECHS[info.tech].name}` };

  const spacing = buildingSpacing(state);
  const near = buildingsNear(state, tile, Math.max(BUILDING_UPGRADE_RADIUS, BUILDING_SNAP_RADIUS + spacing));
  const w = map.width;
  const cost = buildingCost(state, playerId, type);
  const plan = (t: number, upgrade: boolean, level: number, buildingId: number): BuildPlan => {
    const r: BuildPlan = { tile: t, upgrade, cost, level, buildingId, affordable: true };
    if (p.gold < cost.gold) r.reason = `Not enough gold (${cost.gold})`;
    else if (p.iron < cost.iron) r.reason = `Not enough iron (${cost.iron})`;
    r.affordable = !r.reason;
    return r;
  };

  // 1. Upgrade the nearest own building of this type.
  let same: Building | null = null;
  let sameD = BUILDING_UPGRADE_RADIUS * BUILDING_UPGRADE_RADIUS + 1;
  for (const b of near) {
    if (b.owner !== playerId || b.type !== type) continue;
    const d = dist2(w, b.tile, tile);
    if (d < sameD || (d === sameD && same && b.id < same.id)) {
      sameD = d;
      same = b;
    }
  }
  let maxed: Building | null = null;
  if (same) {
    if (same.buildLeft > 0) return { error: `This ${info.name} is still under construction` };
    if (same.upgradeLeft > 0) return { error: `This ${info.name} is already being upgraded` };
    if (same.level < info.maxLevel) return plan(same.tile, true, same.level + 1, same.id);
    maxed = same;
  }

  // 2. A new building on the nearest valid own tile.
  const cx = tile % w;
  const cy = (tile / w) | 0;
  markCrowded(w, cx, cy, near, spacing);
  let first: string | null = null;
  for (const [dx, dy] of SNAP_OFFSETS) {
    const x = cx + dx;
    const y = cy + dy;
    if (x < 0 || y < 0 || x >= w || y >= map.height) continue;
    const t = y * w + x;
    const crowded = crowdMask[(dy + BUILDING_SNAP_RADIUS) * SNAP_SIZE + dx + BUILDING_SNAP_RADIUS] === 1;
    const why = siteProblem(state, playerId, type, t, crowded, spacing);
    if (why === null) return plan(t, false, 1, -1);
    if (first === null) first = why;
  }
  if (maxed) return { error: `This ${info.name} is at its highest level (${info.maxLevel})` };
  // the clicked tile's own problem is misleading when only other buildings were in the way: say what to do
  if (first === null || first === 'This tile already has a building' || first.startsWith('Too close')) {
    return { error: `No room here: buildings keep ${spacing} tiles apart, try further from your others` };
  }
  return { error: first };
}

/** Full validation of a build order (see resolveBuildTarget), money included. */
export function canBuild(state: GameState, playerId: number, type: BuildingType, tile: number): ActionResult {
  const r = resolveBuildTarget(state, playerId, type, tile);
  if ('error' in r) return FAIL(r.error);
  if (!r.affordable) return FAIL(r.reason ?? 'Not enough money');
  return { ok: true };
}

/**
 * Validates, pays, and places a new building or starts an upgrade (resolveBuildTarget decides which and where).
 * An upgrade keeps the building working at its old level while Building.upgradeLeft runs down.
 */
export function build(state: GameState, playerId: number, type: BuildingType, tile: number): ActionResult {
  const r = resolveBuildTarget(state, playerId, type, tile);
  if ('error' in r) return FAIL(r.error);
  if (!r.affordable) return FAIL(r.reason ?? 'Not enough money');
  const p = state.players[playerId];
  p.gold -= r.cost.gold;
  p.iron -= r.cost.iron;
  const info = BUILDINGS[type];
  if (r.upgrade) {
    const existing = state.buildings.get(r.buildingId)!;
    existing.upgradeLeft = buildTimeFor(state, playerId, type);
    touch(state, indexes.get(state), playerId);
  } else {
    const id = newId(state);
    const b: Building = {
      id,
      type,
      owner: playerId,
      tile: r.tile,
      level: 1,
      buildLeft: buildTimeFor(state, playerId, type),
      upgradeLeft: 0,
      fighters: 0,
      bombers: 0,
      cooldown: type === 'port' ? TRADE_INTERVAL : 0,
      dropCooldown: 0,
      disabledUntil: 0,
      hp: 1,
      queuedLevels: 0,
    };
    state.buildings.set(id, b);
    state.map.building[r.tile] = id + 1;
    indexAdd(state, b);
  }
  return { ok: true };
}

/** Removes an own building and refunds BUILDING_DEMOLISH_REFUND of what its levels cost. */
export function demolish(state: GameState, playerId: number, tile: number): ActionResult {
  const b = buildingAt(state, tile);
  if (!b || b.owner !== playerId) return FAIL('No building of yours here');
  const p = state.players[playerId];
  const info = BUILDINGS[b.type];
  const others = Math.max(0, summaryOf(state, playerId).all[b.type] - b.level - (b.queuedLevels || 0));
  const k = (1 + info.costGrowth * others) * b.level;
  p.gold += info.cost * k * BUILDING_DEMOLISH_REFUND;
  p.iron += info.iron * k * BUILDING_DEMOLISH_REFUND;
  // Queued levels never started: paid back in full (bulkbuild.ts).
  if (b.queuedPaid) {
    p.gold += b.queuedPaid.gold;
    p.iron += b.queuedPaid.iron;
  }
  destroyBuilding(state, b);
  return { ok: true };
}

/** Removes a building (map.building cleared, state.buildings entry deleted). */
export function destroyBuilding(state: GameState, b: Building): void {
  if (!state.buildings.delete(b.id)) return;
  if (state.map.building[b.tile] === b.id + 1) state.map.building[b.tile] = 0;
  indexRemove(state, b);
}

export function buildingAt(state: GameState, tile: number): Building | undefined {
  const id = state.map.building[tile] - 1;
  return id >= 0 ? state.buildings.get(id) : undefined;
}

/**
 * Sum of the LEVELS of a player's buildings of a type: finished ones at their working level; with
 * includeUnfinished also unfinished buildings (level 1) and running upgrades (+1 each), the cost basis.
 */
export function countBuildings(state: GameState, playerId: number, type: BuildingType, includeUnfinished = false): number {
  const s = summaryOf(state, playerId);
  return includeUnfinished ? s.all[type] : s.finished[type];
}

/** Number of separate buildings of a type (not levels), finished only or incl. unfinished. */
export function countSites(state: GameState, playerId: number, type: BuildingType, includeUnfinished = false): number {
  const s = summaryOf(state, playerId);
  return includeUnfinished ? s.sitesAll[type] : s.sitesFinished[type];
}

/** Sum of the levels of a player's finished cities. */
export function cityLevels(state: GameState, playerId: number): number {
  return summaryOf(state, playerId).finished.city;
}

/** A player's finished farm levels, a farm on Fertile land counting twice. */
export function farmUnitsOf(state: GameState, playerId: number): number {
  return summaryOf(state, playerId).farmUnits;
}

/** Buildings of playerId (finished or not), optionally of one type. Returns a new array. */
export function buildingsOf(state: GameState, playerId: number, type?: BuildingType): Building[] {
  const lists = listsOf(state, playerId);
  const out: Building[] = [];
  const types = type ? [type] : BUILDING_ORDER;
  for (const t of types) for (const b of lists[t]) if (isLive(state, b, playerId, true)) out.push(b);
  return out;
}

/** Construction and upgrade countdowns ('buildingDone' events), slow repair of damaged buildings. */
export function updateBuildings(state: GameState): void {
  for (const b of state.buildings.values()) {
    if (b.buildLeft > 0) {
      b.buildLeft -= TICK_SECONDS;
      if (b.buildLeft <= 1e-9) {
        b.buildLeft = 0;
        touch(state, indexes.get(state), b.owner);
        const p = state.players[b.owner];
        if (p) {
          p.stats.buildingsBuilt++;
          addEvent(state, 'buildingDone', `${BUILDINGS[b.type].name} finished`, [b.owner], b.tile);
        }
      }
    } else if (b.upgradeLeft > 0) {
      b.upgradeLeft -= TICK_SECONDS;
      if (b.upgradeLeft <= 1e-9) {
        b.upgradeLeft = 0;
        b.level = Math.min(buildingMaxLevel(b.type), b.level + 1);
        touch(state, indexes.get(state), b.owner);
        if (state.players[b.owner]) addEvent(state, 'buildingDone', `${BUILDINGS[b.type].name} upgraded to level ${b.level}`, [b.owner], b.tile);
      }
    }
    if (b.hp < 1) {
      const fast = b.type === 'fort' && doctrinePerk(state, b.owner, 'fortress') ? DOCTRINE_PERKS.fortress.fortRepair : 1;
      b.hp = Math.min(1, b.hp + BUILDING_REPAIR_PER_S * fast * TICK_SECONDS);
    }
  }
}

/**
 * Defence multiplier from forts (and watchtowers) of `owner` covering `tile`. 1 if none.
 * The strongest working fort (finished, not knocked out by a barrage) whose fortRadius covers the tile gives its
 * fortDefense; a finished watchtower within WATCHTOWER_DEF_RADIUS multiplies by WATCHTOWER_DEF.
 * O(#forts + #watchtowers of owner).
 */
export function fortMultiplierAt(state: GameState, tile: number, owner: number): number {
  if (owner <= 0) return 1;
  const p = state.players[owner];
  if (!p) return 1;
  const lists = listsOf(state, owner);
  const w = state.map.width;
  let mult = 1;
  for (const b of lists.fort) {
    if (!isLive(state, b, owner, false) || b.disabledUntil > state.tick) continue;
    const r = fortRadius(state, b);
    if (dist2(w, b.tile, tile) <= r * r) mult = Math.max(mult, fortDefense(state, b));
  }
  for (const b of lists.watchtower) {
    if (isLive(state, b, owner, false) && dist2(w, b.tile, tile) <= WATCHTOWER_DEF_RADIUS * WATCHTOWER_DEF_RADIUS) {
      mult *= WATCHTOWER_DEF;
      break;
    }
  }
  return mult;
}

/** True if a working fort of `owner` covers `tile` (for artillery's fort bonus). */
export function isFortified(state: GameState, tile: number, owner: number): boolean {
  if (owner <= 0) return false;
  const p = state.players[owner];
  if (!p) return false;
  const w = state.map.width;
  for (const b of listsOf(state, owner).fort) {
    if (!isLive(state, b, owner, false) || b.disabledUntil > state.tick) continue;
    const r = fortRadius(state, b);
    if (dist2(w, b.tile, tile) <= r * r) return true;
  }
  return false;
}

/** Intel radius of a player's level-1 watchtowers (Radar doubles it); see watchtowerRadiusOf for one tower. */
export function watchtowerRadius(state: GameState, playerId: number): number {
  const p = state.players[playerId];
  return BUILDINGS.watchtower.radius * (p && hasTech(p, 'radar') ? 2 : 1);
}

/**
 * Army SIZES are public (armyTotalOf); this only says whether `viewer` may see `target`'s troop COMPOSITION
 * (infantry / armor / artillery split): same player, neutral target, allied, or one of the viewer's finished
 * watchtowers is within its radius (watchtowerRadiusOf) of the target's capital, of one of the target's buildings,
 * or of the target's territory. Territory is judged at territory.BLOCK x BLOCK tile resolution (kept up to date by
 * setOwner): a block counts when its nearest point is in range, so a tower can see up to one block further.
 */
export function hasIntel(state: GameState, viewer: number, target: number): boolean {
  if (viewer === target || target <= 0) return true;
  // Owner console 'revealIntel' (admin.ts).
  if (viewer > 0 && state.admin?.revealIntel.includes(viewer)) return true;
  if (viewer <= 0) return false;
  if (areAllied(state, viewer, target)) return true;
  if (revealIntel(state, viewer, target)) return true; // recon flights, light-tank screens (variants.ts)
  const towers = listsOf(state, viewer).watchtower;
  if (towers.length === 0) return false;
  const w = state.map.width;
  const tp = state.players[target];
  const targetBuildings = listsOf(state, target);
  for (const t of towers) {
    if (!isLive(state, t, viewer, false)) continue;
    const r = watchtowerRadiusOf(state, t);
    const r2 = r * r;
    if (tp && tp.capital >= 0 && dist2(w, t.tile, tp.capital) <= r2) return true;
    for (const type of BUILDING_ORDER) {
      for (const b of targetBuildings[type]) if (b.owner === target && dist2(w, t.tile, b.tile) <= r2) return true;
    }
    if (ownsNear(state, target, t.tile, r)) return true;
  }
  return false;
}

/**
 * A player's whole army (public, like the name labels show it): troops at home, in attacks, aboard transports and
 * cargo planes.
 */
export function armyTotalOf(state: GameState, playerId: number): number {
  const p = state.players[playerId];
  if (!p || playerId <= 0) return 0;
  const sum = (t: Troops): number => t.infantry + t.armor + t.artillery;
  let n = sum(p.troops);
  for (const a of state.attacks) if (a.attacker === playerId) n += sum(a.troops);
  for (const u of state.units) {
    if (u.owner === playerId && (u.type === 'transport' || u.type === 'transportPlane' || u.type === 'tankDivision') && u.hp > 0) n += sum(u.troops);
  }
  return n;
}

/** Supply source tiles of a player: capital, finished cities, finished supply depots. */
export function supplySources(state: GameState, playerId: number): number[] {
  const p = state.players[playerId];
  const out: number[] = [];
  if (p && p.capital >= 0) out.push(p.capital);
  const lists = listsOf(state, playerId);
  for (const b of lists.city) if (isLive(state, b, playerId, false) && b.tile !== p?.capital) out.push(b.tile);
  for (const b of lists.supplyDepot) if (isLive(state, b, playerId, false)) out.push(b.tile);
  return out;
}
