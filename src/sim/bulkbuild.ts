// Bulk build and upgrade (owner request): one order queues several levels, which are still built one after another,
// each with its normal upgrade time.
//
// - Action buildMany { building, tile, count 1..BULK_MAX_COUNT }: on a new spot it places the building (the normal
//   build rule: buildings.resolveBuildTarget) and queues up to count - 1 more levels on it; on (or next to) an own
//   building of that type it queues up to `count` more levels (also while it is still being built or upgraded).
// - Action upgradeArea { tile, radius, building?, levels 1..BULK_MAX_COUNT }: queues up to `levels` more levels on
//   every own building (of one type) within radius, cheapest level first, as far as the money goes.
// - Action cancelQueuedLevels { tile }: drops the levels that have not started and refunds what they cost.
//
// Payment: every queued level is paid up front at the price it has in the order (buildings.buildingCostAfter: each
// level makes the next of that type dearer, as single orders would). When the gold or iron runs out the order
// queues only what can be paid now and says so ("upgrades what it can"). Building.queuedLevels / queuedPaid are sim
// state (hash.ts); updateBuildQueues starts the next queued level when a building is idle.
import { BUILDING_UPGRADE_RADIUS, BUILDINGS, BULK_MAX_COUNT, UPGRADE_AREA_MAX_BUILDINGS, UPGRADE_AREA_MAX_RADIUS } from './config';
import {
  build,
  buildingAt,
  buildingCostAfter,
  buildingMaxLevel,
  buildingsOf,
  buildTimeFor,
  noteBuildingChanged,
  resolveBuildTarget,
} from './buildings';
import { addEvent } from './state';
import type { ActionResult, Building, BuildingType, GameState } from './types';

const FAIL = (reason: string): ActionResult => ({ ok: false, reason });

export interface BulkCost {
  gold: number;
  iron: number;
}
export interface BuildManyPreview {
  /** null = the order is possible (maybe only in part: levelsQueued < requested) */
  error: string | null;
  /** the new site, or the tile of the building that gets the levels */
  tile: number;
  /** true when an existing building gets the levels (false = a new building) */
  upgrade: boolean;
  /** id of the existing building, -1 for a new one */
  buildingId: number;
  /** level the building has / will have from orders already running (0 for a new one) */
  fromLevel: number;
  /** level once everything queued now is built */
  toLevel: number;
  /** levels asked for, capped by the top level */
  requested: number;
  /** levels ordered now (for a new building: the placement counts as one) */
  levelsQueued: number;
  /** price of the levels ordered now */
  cost: BulkCost;
  /** gold and iron missing to order every requested level (0 = all affordable) */
  shortBy: BulkCost;
}
export interface UpgradeAreaPreview {
  error: string | null;
  /** buildings that get at least one level */
  buildings: number;
  /** buildings in the area that could take a level at all */
  candidates: number;
  levelsQueued: number;
  /** levels asked for over all candidates */
  requested: number;
  cost: BulkCost;
  shortBy: BulkCost;
  /** per building: id, tile and levels queued (only those that get some) */
  plan: { id: number; tile: number; type: BuildingType; levels: number }[];
}

function isCount(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= BULK_MAX_COUNT;
}
/** Level a building will reach from what is already ordered (construction, running upgrade, queue). */
export function effectiveLevel(b: Building): number {
  return b.level + (b.upgradeLeft > 0 ? 1 : 0) + (b.queuedLevels || 0);
}
function dist2(w: number, a: number, b: number): number {
  const dx = (a % w) - (b % w);
  const dy = ((a / w) | 0) - ((b / w) | 0);
  return dx * dx + dy * dy;
}
/** Nearest own building of `type` within BUILDING_UPGRADE_RADIUS of tile (lowest id on ties), or null. */
function nearestOwn(state: GameState, pid: number, type: BuildingType, tile: number): Building | null {
  const w = state.map.width;
  let best: Building | null = null;
  let bestD = BUILDING_UPGRADE_RADIUS * BUILDING_UPGRADE_RADIUS + 1;
  for (const b of buildingsOf(state, pid, type)) {
    const d = dist2(w, b.tile, tile);
    if (d < bestD || (d === bestD && best && b.id < best.id)) {
      bestD = d;
      best = b;
    }
  }
  return best;
}

/** Exactly what Action buildMany would do now (pure; the client's ghost preview reads it). */
export function buildManyPreview(state: GameState, pid: number, building: BuildingType, tile: number, count: number): BuildManyPreview {
  const out: BuildManyPreview = {
    error: null, tile, upgrade: false, buildingId: -1, fromLevel: 0, toLevel: 0, requested: 0, levelsQueued: 0,
    cost: { gold: 0, iron: 0 }, shortBy: { gold: 0, iron: 0 },
  };
  const p = state.players[pid];
  if (!p || pid <= 0 || !p.alive) return { ...out, error: 'No such player' };
  if (!BUILDINGS[building]) return { ...out, error: 'Unknown building' };
  if (!isCount(count)) return { ...out, error: `Count must be 1 to ${BULK_MAX_COUNT}` };
  // Where it goes: the normal build rule; a busy building of the type nearby still takes queued levels.
  let existing: Building | null = null;
  const r = resolveBuildTarget(state, pid, building, tile);
  if ('error' in r) {
    if (!/under construction|being upgraded/.test(r.error)) return { ...out, error: r.error };
    existing = nearestOwn(state, pid, building, tile);
    if (!existing) return { ...out, error: r.error };
  } else if (r.upgrade) existing = state.buildings.get(r.buildingId) ?? null;
  else out.tile = r.tile;
  const max = buildingMaxLevel(building);
  if (existing) {
    out.upgrade = true;
    out.tile = existing.tile;
    out.buildingId = existing.id;
    out.fromLevel = effectiveLevel(existing);
  }
  out.requested = Math.max(0, Math.min(count, max - out.fromLevel));
  if (out.requested <= 0) return { ...out, toLevel: out.fromLevel, error: `This ${BUILDINGS[building].name} is at its highest level (${max})` };
  let gold = p.gold;
  let iron = p.iron;
  let allGold = 0;
  let allIron = 0;
  for (let k = 0; k < out.requested; k++) {
    const c = buildingCostAfter(state, pid, building, k);
    allGold += c.gold;
    allIron += c.iron;
    if (out.levelsQueued === k && c.gold <= gold + 1e-9 && c.iron <= iron + 1e-9) {
      gold -= c.gold;
      iron -= c.iron;
      out.cost.gold += c.gold;
      out.cost.iron += c.iron;
      out.levelsQueued++;
    }
  }
  out.shortBy = { gold: Math.max(0, allGold - p.gold), iron: Math.max(0, allIron - p.iron) };
  out.toLevel = out.fromLevel + out.levelsQueued;
  if (out.levelsQueued === 0) {
    const c = buildingCostAfter(state, pid, building, 0);
    out.error = p.gold < c.gold ? `Not enough gold (${c.gold})` : `Not enough iron (${c.iron})`;
  }
  return out;
}

/** Adds n paid levels to a building's queue and starts the first one at once when it is idle. */
function enqueue(state: GameState, b: Building, n: number, paid: BulkCost): void {
  if (n <= 0) return;
  b.queuedLevels = (b.queuedLevels || 0) + n;
  const q = b.queuedPaid ?? { gold: 0, iron: 0 };
  b.queuedPaid = { gold: q.gold + paid.gold, iron: q.iron + paid.iron };
  noteBuildingChanged(state, b);
  startNextLevel(state, b);
}
/** Starts the next queued level of an idle building (refunds the queue if it is at the top level already). */
function startNextLevel(state: GameState, b: Building): void {
  if (!(b.queuedLevels > 0) || b.buildLeft > 0 || b.upgradeLeft > 0) return;
  const paid = b.queuedPaid ?? { gold: 0, iron: 0 };
  if (b.level >= buildingMaxLevel(b.type)) {
    refund(state, b);
    return;
  }
  const share = 1 / b.queuedLevels;
  b.queuedLevels--;
  if (b.queuedLevels > 0) b.queuedPaid = { gold: paid.gold * (1 - share), iron: paid.iron * (1 - share) };
  else delete b.queuedPaid;
  b.upgradeLeft = buildTimeFor(state, b.owner, b.type);
  noteBuildingChanged(state, b);
}
/** Gives back what the queued levels cost and clears the queue. */
function refund(state: GameState, b: Building): BulkCost {
  const paid = b.queuedPaid ?? { gold: 0, iron: 0 };
  const p = state.players[b.owner];
  if (p && b.owner > 0) {
    p.gold += paid.gold;
    p.iron += paid.iron;
  }
  b.queuedLevels = 0;
  delete b.queuedPaid;
  noteBuildingChanged(state, b);
  return paid;
}

function levelWord(n: number): string {
  return `${n} level${n === 1 ? '' : 's'}`;
}

/** Action buildMany. */
export function buildMany(state: GameState, pid: number, building: BuildingType, tile: number, count: number): ActionResult {
  const pv = buildManyPreview(state, pid, building, tile, count);
  if (pv.error) return FAIL(pv.error);
  const p = state.players[pid];
  const name = BUILDINGS[building].name;
  let target: Building | undefined;
  let rest = pv.levelsQueued;
  if (!pv.upgrade) {
    const r = build(state, pid, building, pv.tile);
    if (!r.ok) return r;
    target = buildingAt(state, pv.tile);
    rest--;
  } else target = state.buildings.get(pv.buildingId);
  if (!target) return FAIL('Building not found');
  // The rest is paid now at the prices of the preview (the placement above already raised them by one level).
  let gold = 0;
  let iron = 0;
  for (let k = 0; k < rest; k++) {
    const c = buildingCostAfter(state, pid, building, k);
    gold += c.gold;
    iron += c.iron;
  }
  p.gold -= gold;
  p.iron -= iron;
  enqueue(state, target, rest, { gold, iron });
  if (p.isHuman && count > 1) {
    const short = pv.levelsQueued < pv.requested ? ` (could afford ${pv.levelsQueued} of ${pv.requested})` : '';
    addEvent(state, 'info', `${name} -> level ${pv.toLevel}: ${levelWord(pv.levelsQueued)} ordered${short}`, [pid], target.tile);
  }
  return { ok: true };
}

/** Plans an upgradeArea order: cheapest next level first (money limited when `limit`), at most `levels` per building. */
function planArea(
  state: GameState,
  pid: number,
  tile: number,
  radius: number,
  building: BuildingType | undefined,
  levels: number,
  limit: boolean,
): { cands: Building[]; take: Map<number, number>; cost: BulkCost; requested: number } {
  const p = state.players[pid];
  const w = state.map.width;
  const r = Math.min(UPGRADE_AREA_MAX_RADIUS, radius);
  const r2 = r * r;
  const cands = buildingsOf(state, pid, building)
    .filter((b) => dist2(w, b.tile, tile) <= r2 && effectiveLevel(b) < buildingMaxLevel(b.type))
    .sort((a, b) => dist2(w, a.tile, tile) - dist2(w, b.tile, tile) || a.id - b.id)
    .slice(0, UPGRADE_AREA_MAX_BUILDINGS);
  const want = new Map<number, number>();
  let requested = 0;
  for (const b of cands) {
    const n = Math.min(levels, buildingMaxLevel(b.type) - effectiveLevel(b));
    want.set(b.id, n);
    requested += n;
  }
  const extra = new Map<BuildingType, number>();
  const take = new Map<number, number>();
  const cost: BulkCost = { gold: 0, iron: 0 };
  let gold = p.gold;
  let iron = p.iron;
  for (;;) {
    // Next level of each type's price (all buildings of a type share it): cheapest first, fewest taken on ties.
    let best: Building | null = null;
    let bestCost: BulkCost | null = null;
    for (const b of cands) {
      const got = take.get(b.id) ?? 0;
      if (got >= (want.get(b.id) ?? 0)) continue;
      const c = buildingCostAfter(state, pid, b.type, extra.get(b.type) ?? 0);
      if (limit && (c.gold > gold + 1e-9 || c.iron > iron + 1e-9)) continue;
      if (!best || !bestCost || c.gold < bestCost.gold || (c.gold === bestCost.gold && got < (take.get(best.id) ?? 0))) {
        best = b;
        bestCost = c;
      }
    }
    if (!best || !bestCost) break;
    take.set(best.id, (take.get(best.id) ?? 0) + 1);
    extra.set(best.type, (extra.get(best.type) ?? 0) + 1);
    gold -= bestCost.gold;
    iron -= bestCost.iron;
    cost.gold += bestCost.gold;
    cost.iron += bestCost.iron;
  }
  return { cands, take, cost, requested };
}

function areaError(state: GameState, pid: number, tile: number, radius: number, building: BuildingType | undefined, levels: number): string | null {
  const p = state.players[pid];
  if (!p || pid <= 0 || !p.alive) return 'No such player';
  if (!Number.isInteger(tile) || tile < 0 || tile >= state.map.width * state.map.height) return 'Invalid tile';
  if (typeof radius !== 'number' || !Number.isFinite(radius) || radius < 1) return 'Invalid radius';
  if (building !== undefined && !BUILDINGS[building]) return 'Unknown building';
  if (!isCount(levels)) return `Levels must be 1 to ${BULK_MAX_COUNT}`;
  return null;
}

/** What Action upgradeArea would queue now (pure; the client's live preview reads it). */
export function upgradeAreaPreview(
  state: GameState,
  pid: number,
  tile: number,
  radius: number,
  building: BuildingType | undefined,
  levels: number,
): UpgradeAreaPreview {
  const out: UpgradeAreaPreview = {
    error: null, buildings: 0, candidates: 0, levelsQueued: 0, requested: 0, cost: { gold: 0, iron: 0 }, shortBy: { gold: 0, iron: 0 }, plan: [],
  };
  const bad = areaError(state, pid, tile, radius, building, levels);
  if (bad) return { ...out, error: bad };
  const p = state.players[pid];
  const got = planArea(state, pid, tile, radius, building, levels, true);
  const all = planArea(state, pid, tile, radius, building, levels, false);
  out.candidates = got.cands.length;
  out.requested = got.requested;
  out.cost = got.cost;
  out.shortBy = { gold: Math.max(0, all.cost.gold - p.gold), iron: Math.max(0, all.cost.iron - p.iron) };
  for (const b of got.cands) {
    const n = got.take.get(b.id) ?? 0;
    if (n <= 0) continue;
    out.plan.push({ id: b.id, tile: b.tile, type: b.type, levels: n });
    out.levelsQueued += n;
  }
  out.buildings = out.plan.length;
  if (!out.candidates) out.error = building ? `No ${BUILDINGS[building].name} of yours here that can be upgraded` : 'No building of yours here that can be upgraded';
  else if (!out.levelsQueued) out.error = 'Not enough gold or iron for any upgrade here';
  return out;
}

/** Action upgradeArea. */
export function upgradeArea(state: GameState, pid: number, tile: number, radius: number, building: BuildingType | undefined, levels: number): ActionResult {
  const pv = upgradeAreaPreview(state, pid, tile, radius, building, levels);
  if (pv.error) return FAIL(pv.error);
  const p = state.players[pid];
  // Pay level by level in the planned order of types (prices as planned: each level raises its type's next price).
  const byType = new Map<BuildingType, number>();
  for (const e of pv.plan) byType.set(e.type, (byType.get(e.type) ?? 0) + e.levels);
  const typePaid = new Map<BuildingType, BulkCost>();
  for (const [type, n] of byType) {
    const c: BulkCost = { gold: 0, iron: 0 };
    for (let k = 0; k < n; k++) {
      const one = buildingCostAfter(state, pid, type, k);
      c.gold += one.gold;
      c.iron += one.iron;
    }
    typePaid.set(type, c);
  }
  for (const e of pv.plan) {
    const b = state.buildings.get(e.id);
    const all = typePaid.get(e.type)!;
    const share = e.levels / byType.get(e.type)!;
    const paid = { gold: all.gold * share, iron: all.iron * share };
    p.gold -= paid.gold;
    p.iron -= paid.iron;
    if (b) enqueue(state, b, e.levels, paid);
  }
  if (p.isHuman) {
    const short = pv.levelsQueued < pv.requested ? ` (could afford ${pv.levelsQueued} of ${pv.requested})` : '';
    addEvent(state, 'info', `Upgrades ordered: ${levelWord(pv.levelsQueued)} on ${pv.buildings} building${pv.buildings === 1 ? '' : 's'}${short}`, [pid], tile);
  }
  return { ok: true };
}

/** Action cancelQueuedLevels: refund the queued levels of the own building on tile. */
export function cancelQueuedLevels(state: GameState, pid: number, tile: number): ActionResult {
  const b = buildingAt(state, tile);
  if (!b || b.owner !== pid) return FAIL('No building of yours here');
  if (!(b.queuedLevels > 0)) return FAIL('No levels are queued here');
  refund(state, b);
  return { ok: true };
}

/** Each tick: idle buildings with queued levels start the next one. */
export function updateBuildQueues(state: GameState): void {
  for (const b of state.buildings.values()) {
    if (b.queuedLevels > 0 && b.buildLeft <= 0 && b.upgradeLeft <= 0) startNextLevel(state, b);
  }
}
