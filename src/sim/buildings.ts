// Building rules and lookups.
import {
  BUILDING_DEMOLISH_REFUND,
  BUILDING_MIN_SPACING,
  BUILDINGS,
  BUILDING_ORDER,
  CITY_MAX_LEVEL,
  FORT_DEFENSE,
  FORT_DEFENSE_TECH,
  FORT_RADIUS_TECH,
  TERRAIN,
  TICK_SECONDS,
  TRADE_INTERVAL,
  WATCHTOWER_DEF,
  WATCHTOWER_DEF_RADIUS,
} from './config';
import { areAllied } from './diplomacy';
import { getTerritoryScan } from './economy';
import { addEvent, newId } from './state';
import { hasTech } from './tech';
import { isWater, Resource } from './types';
import type { ActionResult, Building, BuildingType, GameState, TerrainId } from './types';

const FAIL = (reason: string): ActionResult => ({ ok: false, reason });

// ---------------------------------------------------------------------------------------------------------------
// Per-player building index.
//
// state.buildings is a flat Map; most lookups want "buildings of player P of type T". The index groups them and is
// rebuilt lazily (O(#buildings)) when its key changes: the tick, the Map size, state.nextId (new ids) or our own
// version counter (bumped by every change made in this file). Changes made elsewhere in the same tick that keep the
// size and nextId (a capture flips b.owner) are caught on use: every lookup re-checks b.owner and b.buildLeft, so a
// captured building stops counting for the loser at once and counts for the taker from the next tick.
// ---------------------------------------------------------------------------------------------------------------

type TypeLists = Record<BuildingType, Building[]>;
interface BuildingIndex {
  tick: number;
  size: number;
  nextId: number;
  version: number;
  byPlayer: Map<number, TypeLists>;
}
const indexes = new WeakMap<GameState, BuildingIndex>();
const versions = new WeakMap<GameState, number>();

function emptyLists(): TypeLists {
  const r = {} as TypeLists;
  for (const t of BUILDING_ORDER) r[t] = [];
  return r;
}
const EMPTY_LISTS: TypeLists = emptyLists();

/** Changes whenever this module adds, removes, finishes or upgrades a building. Use it to key caches. */
export function buildingVersion(state: GameState): number {
  return versions.get(state) ?? 0;
}
/** Call after changing state.buildings outside this module (other than through setOwner) to drop cached lookups. */
export function markBuildingsChanged(state: GameState): void {
  versions.set(state, buildingVersion(state) + 1);
}

function getIndex(state: GameState): BuildingIndex {
  const version = buildingVersion(state);
  let idx = indexes.get(state);
  if (idx && idx.tick === state.tick && idx.size === state.buildings.size && idx.nextId === state.nextId && idx.version === version) {
    return idx;
  }
  const byPlayer = new Map<number, TypeLists>();
  for (const b of state.buildings.values()) {
    let lists = byPlayer.get(b.owner);
    if (!lists) {
      lists = emptyLists();
      byPlayer.set(b.owner, lists);
    }
    lists[b.type].push(b);
  }
  idx = { tick: state.tick, size: state.buildings.size, nextId: state.nextId, version, byPlayer };
  indexes.set(state, idx);
  return idx;
}
function listsOf(state: GameState, playerId: number): TypeLists {
  return getIndex(state).byPlayer.get(playerId) ?? EMPTY_LISTS;
}
function isLive(state: GameState, b: Building, playerId: number, includeUnfinished: boolean): boolean {
  return b.owner === playerId && (includeUnfinished || b.buildLeft <= 0) && state.buildings.get(b.id) === b;
}

// ---------------------------------------------------------------------------------------------------------------
// Costs and validation
// ---------------------------------------------------------------------------------------------------------------

/** Cost of a new copy: base x (1 + costGrowth x owned copies incl. unfinished). Iron grows the same way. */
export function buildingCost(state: GameState, playerId: number, type: BuildingType): { gold: number; iron: number } {
  const info = BUILDINGS[type];
  // Every city level counts as a copy, so upgrades and new cities get dearer together (keeps the economy in check).
  const owned = type === 'city' ? allCityLevels(state, playerId) : countBuildings(state, playerId, type, true);
  const k = 1 + info.costGrowth * owned;
  return { gold: Math.round(info.cost * k), iron: Math.round(info.iron * k) };
}

/** Sum of city levels including unfinished cities (cost basis for cities). */
function allCityLevels(state: GameState, playerId: number): number {
  let n = 0;
  for (const b of listsOf(state, playerId).city) if (isLive(state, b, playerId, true)) n += b.level;
  return n;
}

/**
 * Cost of building `type` on `tile`. A city on an own city is an upgrade; it costs the same as a new city
 * (both grow with the total number of city levels owned). Use this for UI tooltips on a specific tile.
 */
export function buildCostAt(state: GameState, playerId: number, type: BuildingType, tile: number): { gold: number; iron: number } {
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

/**
 * Another building (anyone's) closer than BUILDING_MIN_SPACING tiles (Chebyshev) to `tile`.
 * Cities may cluster (DESIGN 5): a new city ignores other cities but keeps its distance from other buildings.
 */
function spacingConflict(state: GameState, tile: number, type: BuildingType): Building | undefined {
  const map = state.map;
  const w = map.width;
  const cx = tile % w;
  const cy = (tile / w) | 0;
  const r = BUILDING_MIN_SPACING - 1;
  for (let y = Math.max(0, cy - r); y <= Math.min(map.height - 1, cy + r); y++) {
    for (let x = Math.max(0, cx - r); x <= Math.min(w - 1, cx + r); x++) {
      const i = y * w + x;
      if (i === tile || map.building[i] === 0) continue;
      const other = buildingAt(state, i);
      if (!other) continue;
      if (type === 'city' && other.type === 'city') continue;
      return other;
    }
  }
  return undefined;
}

/** Full validation (owner, land, terrain noBuild, fallout, tech, coastal, deposits, spacing, money, city upgrade). */
export function canBuild(state: GameState, playerId: number, type: BuildingType, tile: number): ActionResult {
  const p = state.players[playerId];
  const info = BUILDINGS[type];
  if (!p || playerId === 0 || !p.alive) return FAIL('No such player');
  if (!info) return FAIL('Unknown building');
  const map = state.map;
  if (!Number.isInteger(tile) || tile < 0 || tile >= map.width * map.height) return FAIL('Invalid tile');
  if (map.owner[tile] !== playerId) return FAIL('You must build on your own territory');
  const terrain = map.terrain[tile] as TerrainId;
  if (isWater(terrain)) return FAIL('Cannot build on water');
  if (map.fallout[tile] > 0) return FAIL('This land is irradiated');
  if (TERRAIN[terrain].noBuild.includes(type)) return FAIL(`Cannot build a ${info.name} on ${TERRAIN[terrain].name}`);
  if (info.tech && !hasTech(p, info.tech)) return FAIL(`Needs research: ${info.tech}`);
  if (info.coastal && !map.coastal[tile]) return FAIL(`A ${info.name} must be on the coast`);

  const existing = buildingAt(state, tile);
  if (existing) {
    if (type !== 'city' || existing.type !== 'city' || existing.owner !== playerId) return FAIL('This tile already has a building');
    // City upgrade.
    if (existing.buildLeft > 0 || existing.cooldown > 0) return FAIL('This city is still under construction');
    if (existing.level >= CITY_MAX_LEVEL) return FAIL('This city is at its highest level');
  } else {
    if (type === 'mine' && !depositNear(state, playerId, tile, Resource.Iron, info.radius)) {
      return FAIL(`A Mine must be within ${info.radius} tiles of an Iron deposit you own`);
    }
    if (type === 'oilWell' && !depositNear(state, playerId, tile, Resource.Oil, info.radius)) {
      return FAIL(`An Oil Well must be within ${info.radius} tiles of an Oil deposit you own`);
    }
    if (spacingConflict(state, tile, type)) return FAIL(`Too close to another building (min ${BUILDING_MIN_SPACING} tiles apart)`);
  }

  const cost = buildCostAt(state, playerId, type, tile);
  if (p.gold < cost.gold) return FAIL(`Not enough gold (${cost.gold})`);
  if (p.iron < cost.iron) return FAIL(`Not enough iron (${cost.iron})`);
  return { ok: true };
}

/**
 * Validates, pays, places (or upgrades a city). A city upgrade keeps the city working at its old level while
 * the upgrade runs: for cities `cooldown` holds the upgrade seconds left (the field is otherwise unused by cities).
 */
export function build(state: GameState, playerId: number, type: BuildingType, tile: number): ActionResult {
  const ok = canBuild(state, playerId, type, tile);
  if (!ok.ok) return ok;
  const p = state.players[playerId];
  const cost = buildCostAt(state, playerId, type, tile);
  p.gold -= cost.gold;
  p.iron -= cost.iron;
  const info = BUILDINGS[type];
  const existing = buildingAt(state, tile);
  if (existing) {
    existing.cooldown = info.buildTime;
  } else {
    const id = newId(state);
    const b: Building = {
      id,
      type,
      owner: playerId,
      tile,
      level: 1,
      buildLeft: info.buildTime,
      fighters: 0,
      bombers: 0,
      cooldown: type === 'port' ? TRADE_INTERVAL : 0,
      hp: 1,
    };
    state.buildings.set(id, b);
    state.map.building[tile] = id + 1;
  }
  markBuildingsChanged(state);
  return { ok: true };
}

/** Removes an own building and refunds BUILDING_DEMOLISH_REFUND of what its latest copy (x city level) cost. */
export function demolish(state: GameState, playerId: number, tile: number): ActionResult {
  const b = buildingAt(state, tile);
  if (!b || b.owner !== playerId) return FAIL('No building of yours here');
  const p = state.players[playerId];
  const info = BUILDINGS[b.type];
  const owned = Math.max(0, countBuildings(state, playerId, b.type, true) - 1);
  const k = (1 + info.costGrowth * owned) * (b.type === 'city' ? b.level : 1);
  p.gold += info.cost * k * BUILDING_DEMOLISH_REFUND;
  p.iron += info.iron * k * BUILDING_DEMOLISH_REFUND;
  destroyBuilding(state, b);
  return { ok: true };
}

/** Removes a building (map.building cleared, state.buildings entry deleted). */
export function destroyBuilding(state: GameState, b: Building): void {
  state.buildings.delete(b.id);
  if (state.map.building[b.tile] === b.id + 1) state.map.building[b.tile] = 0;
  markBuildingsChanged(state);
}

export function buildingAt(state: GameState, tile: number): Building | undefined {
  const id = state.map.building[tile] - 1;
  return id >= 0 ? state.buildings.get(id) : undefined;
}

/** Finished buildings of a type owned by playerId (cities count once regardless of level). */
export function countBuildings(state: GameState, playerId: number, type: BuildingType, includeUnfinished = false): number {
  let n = 0;
  for (const b of listsOf(state, playerId)[type]) if (isLive(state, b, playerId, includeUnfinished)) n++;
  return n;
}

/** Sum of the levels of a player's finished cities. */
export function cityLevels(state: GameState, playerId: number): number {
  let n = 0;
  for (const b of listsOf(state, playerId).city) if (isLive(state, b, playerId, false)) n += b.level;
  return n;
}

/** Buildings of playerId (finished or not), optionally of one type. Returns a new array. */
export function buildingsOf(state: GameState, playerId: number, type?: BuildingType): Building[] {
  const lists = listsOf(state, playerId);
  const out: Building[] = [];
  const types = type ? [type] : BUILDING_ORDER;
  for (const t of types) for (const b of lists[t]) if (isLive(state, b, playerId, true)) out.push(b);
  return out;
}

/** Building construction countdown, city upgrades, 'buildingDone' events. */
export function updateBuildings(state: GameState): void {
  let changed = false;
  for (const b of state.buildings.values()) {
    if (b.buildLeft > 0) {
      b.buildLeft -= TICK_SECONDS;
      if (b.buildLeft <= 1e-9) {
        b.buildLeft = 0;
        changed = true;
        const p = state.players[b.owner];
        if (p) {
          p.stats.buildingsBuilt++;
          addEvent(state, 'buildingDone', `${BUILDINGS[b.type].name} finished`, [b.owner], b.tile);
        }
      }
    } else if (b.type === 'city' && b.cooldown > 0) {
      b.cooldown -= TICK_SECONDS;
      if (b.cooldown <= 1e-9) {
        b.cooldown = 0;
        b.level = Math.min(CITY_MAX_LEVEL, b.level + 1);
        changed = true;
        if (state.players[b.owner]) addEvent(state, 'buildingDone', `City upgraded to level ${b.level}`, [b.owner], b.tile);
      }
    }
  }
  if (changed) markBuildingsChanged(state);
}

function dist2(w: number, a: number, b: number): number {
  const dx = (a % w) - (b % w);
  const dy = ((a / w) | 0) - ((b / w) | 0);
  return dx * dx + dy * dy;
}

/**
 * Defence multiplier from forts (and watchtowers) of `owner` covering `tile`. 1 if none.
 * Any finished fort within radius (euclidean) gives FORT_DEFENSE (Fortification: FORT_DEFENSE_TECH, radius
 * FORT_RADIUS_TECH); a finished watchtower within WATCHTOWER_DEF_RADIUS multiplies by WATCHTOWER_DEF.
 * O(#forts + #watchtowers of owner).
 */
export function fortMultiplierAt(state: GameState, tile: number, owner: number): number {
  if (owner <= 0) return 1;
  const p = state.players[owner];
  if (!p) return 1;
  const lists = listsOf(state, owner);
  const w = state.map.width;
  let mult = 1;
  if (lists.fort.length) {
    const tech = hasTech(p, 'fortification');
    const r = tech ? FORT_RADIUS_TECH : BUILDINGS.fort.radius;
    for (const b of lists.fort) {
      if (isLive(state, b, owner, false) && dist2(w, b.tile, tile) <= r * r) {
        mult = tech ? FORT_DEFENSE_TECH : FORT_DEFENSE;
        break;
      }
    }
  }
  for (const b of lists.watchtower) {
    if (isLive(state, b, owner, false) && dist2(w, b.tile, tile) <= WATCHTOWER_DEF_RADIUS * WATCHTOWER_DEF_RADIUS) {
      mult *= WATCHTOWER_DEF;
      break;
    }
  }
  return mult;
}

/** True if a finished fort of `owner` covers `tile` (for artillery's fort bonus). */
export function isFortified(state: GameState, tile: number, owner: number): boolean {
  if (owner <= 0) return false;
  const p = state.players[owner];
  if (!p) return false;
  const r = hasTech(p, 'fortification') ? FORT_RADIUS_TECH : BUILDINGS.fort.radius;
  const w = state.map.width;
  for (const b of listsOf(state, owner).fort) if (isLive(state, b, owner, false) && dist2(w, b.tile, tile) <= r * r) return true;
  return false;
}

/** Intel radius of a player's watchtowers (Radar doubles it). */
export function watchtowerRadius(state: GameState, playerId: number): number {
  const p = state.players[playerId];
  return BUILDINGS.watchtower.radius * (p && hasTech(p, 'radar') ? 2 : 1);
}

/**
 * True if `viewer` can see `target`'s army numbers: same player, neutral target, allied, or one of the viewer's
 * finished watchtowers is within its radius of the target's capital, of one of the target's buildings, or of
 * the target's territory. Territory comes from the economy's periodic map scan (about once a second) at
 * TERRITORY_BLOCK x TERRITORY_BLOCK tile resolution: a block counts when its nearest point is in range, so a
 * tower can see up to one block further than its radius.
 */
export function hasIntel(state: GameState, viewer: number, target: number): boolean {
  if (viewer === target || target <= 0) return true;
  if (viewer <= 0) return false;
  if (areAllied(state, viewer, target)) return true;
  const towers = listsOf(state, viewer).watchtower;
  if (towers.length === 0) return false;
  const w = state.map.width;
  const r = watchtowerRadius(state, viewer);
  const r2 = r * r;
  const tp = state.players[target];
  const targetBuildings = listsOf(state, target);
  let scan: ReturnType<typeof getTerritoryScan> | null = null;
  for (const t of towers) {
    if (!isLive(state, t, viewer, false)) continue;
    if (tp && tp.capital >= 0 && dist2(w, t.tile, tp.capital) <= r2) return true;
    for (const type of BUILDING_ORDER) {
      for (const b of targetBuildings[type]) if (b.owner === target && dist2(w, t.tile, b.tile) <= r2) return true;
    }
    scan ??= getTerritoryScan(state);
    if (scan.ownsBlockInRange(target, t.tile, r)) return true;
  }
  return false;
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
