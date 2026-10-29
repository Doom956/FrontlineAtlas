// Land attacks, fronts, supply, losses (DESIGN section 4).
//
// An Attack is a force pushing into one target (a player, or 0 = neutral land). Each attack keeps a private
// frontier: a min-heap of candidate tiles (target tiles 4-adjacent to the attacker) ordered by distance to the
// focus tile plus a little random jitter, so the front grows around the clicked point but stays ragged and wide.
// The heap is built once at launch (scan of a box around the focus, whole map only if that finds nothing) and
// then updated incrementally on every capture; entries that went stale (owner changed by another attack, or the
// attacker lost the tile next to it) are skipped lazily when they reach the top.
import { countBuildings, fortMultiplierAt, supplySources } from './buildings';
import {
  ARMOR_SPEED_BONUS,
  ARTILLERY_FORT_BONUS,
  ARTILLERY_SLOW,
  ARTILLERY_UNESCORTED_SHARE,
  ARTILLERY_UNESCORTED_VULN,
  ATTACK_SPEED_DEFENDER_FACTOR,
  BARRACKS_LOSS_REDUCTION,
  BARRACKS_MAX,
  BASE_ATTACK_SPEED,
  COMBINED_ARMS_BONUS,
  COMBINED_ARMS_MIN_SHARE,
  DEFENDER_LOSS_PER_TILE,
  DEFENDER_NO_SUPPLY,
  DEPOT_ATTACK_BONUS,
  DEPOT_RADIUS,
  FORCE_SPEED_SCALE,
  FORT_DEFENSE,
  HOSPITAL_MAX,
  HOSPITAL_RECOVERY,
  MATCHUP,
  MAX_ATTACKS_PER_PLAYER,
  MIN_ATTACK_TROOPS,
  MIN_SUPPLY_EFF,
  NEUTRAL_TILE_DEF,
  NO_OIL_ARMOR_FACTOR,
  RETREAT_LOSS,
  SUPPLY_RANGE,
  SUPPLY_RECALC_TICKS,
  TERRAIN,
  TICK_SECONDS,
  TRAITOR_DEFENSE,
  TROOP_ATTACK,
  TROOP_DEFENSE,
  VULNERABILITY,
} from './config';
import { areAllied, isTraitor } from './diplomacy';
import { hasOilShortage } from './economy';
import { distanceField } from './grid';
import { addEvent, newId, setOwner } from './state';
import { hasTech } from './tech';
import { TROOP_TYPES, isWater } from './types';
import type { ActionResult, Attack, GameState, Player, TerrainId, TroopType, Troops } from './types';

// ---------- tuning that config.ts leaves to this module ----------
/** Half-size of the box scanned around the focus when a front is built. */
export const FRONT_SCAN_RADIUS = 40;
/** Random tiles of jitter added to a frontier tile's distance to the focus (keeps the front wide and ragged). */
export const FRONT_JITTER = 3;
/**
 * Dense defenders slow fronts (ATTACK_SPEED_DEFENDER_FACTOR): speed x clamp(ratio / SPEED_FULL_RATIO,
 * SPEED_MIN_FACTOR, 1), where ratio = attacking force power / defender's whole army defence at the next tile
 * (= defence per tile x defender tiles). A force 4x the defender's army runs at full speed, an even fight at 1/4.
 */
export const SPEED_FULL_RATIO = 4;
export const SPEED_MIN_FACTOR = 0.1;
/** A 'capture' effect every this many tiles per attack (and on every tile with a building). */
const CAPTURE_EFFECT_EVERY = 20;
// Tech effects (described in config TECHS).
const LOGISTICS_SPEED = 1.15;
const LOGISTICS_RANGE = 1.5;
const MECHANIZATION_ARMOR = 1.25;
const BALLISTICS_ARTILLERY = 1.3;
const BALLISTICS_UNESCORTED_SHARE = 0.55;
const UNREACHABLE = 65535;

// ---------- small troop helpers ----------
function total(t: Troops): number {
  return t.infantry + t.armor + t.artillery;
}
function zero(): Troops {
  return { infantry: 0, armor: 0, artillery: 0 };
}
function addTroops(to: Troops, t: Troops, f = 1): void {
  to.infantry += t.infantry * f;
  to.armor += t.armor * f;
  to.artillery += t.artillery * f;
}
function clearTroops(t: Troops): void {
  t.infantry = t.armor = t.artillery = 0;
}
const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

function typeAttack(state: GameState, p: Player, k: TroopType): number {
  let v = TROOP_ATTACK[k];
  if (k === 'armor') {
    if (hasTech(p, 'mechanization')) v *= MECHANIZATION_ARMOR;
    if (hasOilShortage(state, p.id)) v *= NO_OIL_ARMOR_FACTOR;
  } else if (k === 'artillery' && hasTech(p, 'ballistics')) {
    v *= BALLISTICS_ARTILLERY;
  }
  return v;
}
function typeDefense(state: GameState, p: Player, k: TroopType): number {
  let v = TROOP_DEFENSE[k];
  if (k === 'armor') {
    if (hasTech(p, 'mechanization')) v *= MECHANIZATION_ARMOR;
    if (hasOilShortage(state, p.id)) v *= NO_OIL_ARMOR_FACTOR;
  }
  return v;
}
/** MATCHUP of type k against a force, weighted by that force's composition (infantry if it has none). */
function matchupVs(k: TroopType, against: Troops | null): number {
  if (!against) return 1; // neutral land: nobody to counter
  const tot = total(against);
  if (tot <= 0) return MATCHUP[k].infantry;
  const m = MATCHUP[k];
  return (against.infantry * m.infantry + against.armor * m.armor + against.artillery * m.artillery) / tot;
}
function combinedArms(p: Player, t: Troops, tot: number): number {
  if (tot <= 0 || !hasTech(p, 'combinedArms')) return 1;
  const min = COMBINED_ARMS_MIN_SHARE * tot;
  return t.infantry >= min && t.armor >= min && t.artillery >= min ? 1 + COMBINED_ARMS_BONUS : 1;
}

// ---------- supply ----------
function supplyRange(p: Player): number {
  return SUPPLY_RANGE * (hasTech(p, 'logistics') ? LOGISTICS_RANGE : 1);
}

function computeSupply(state: GameState, playerId: number): void {
  const p = state.players[playerId];
  const map = state.map;
  const owner = map.owner;
  let sources = supplySources(state, playerId).filter((t) => owner[t] === playerId);
  if (sources.length === 0 && p.capital >= 0 && owner[p.capital] === playerId) sources = [p.capital];
  const range = supplyRange(p);
  state.supplyDist.set(playerId, distanceField(map, sources, (i) => owner[i] === playerId, Math.ceil(3 * range)));
}

/**
 * Recomputes state.supplyDist every SUPPLY_RECALC_TICKS (all players): per alive player a distance field over
 * their own tiles from their supply sources, up to 3x supply range. Players without a field yet get one at once.
 * Between recalcs captureTile() extends the field to newly taken tiles.
 */
export function updateSupply(state: GameState): void {
  for (const p of state.players) {
    if (p.id === 0) continue;
    if (!p.alive || !p.spawned) {
      state.supplyDist.delete(p.id);
      continue;
    }
    // Each player every SUPPLY_RECALC_TICKS, staggered by id so the distance fields don't all land on one tick.
    const recalc = (state.tick + p.id) % SUPPLY_RECALC_TICKS === 0;
    if (recalc || !state.supplyDist.has(p.id)) computeSupply(state, p.id);
  }
}

/** Supply distance of playerId at tile: own tile -> its field value; else min over own 4-neighbours + 1. */
function supplyDistAt(state: GameState, playerId: number, tile: number): number {
  const field = state.supplyDist.get(playerId);
  if (!field) return -1;
  const map = state.map;
  const owner = map.owner;
  if (owner[tile] === playerId) return field[tile];
  const w = map.width;
  const x = tile % w;
  let d = UNREACHABLE;
  const consider = (j: number): void => {
    if (owner[j] === playerId && field[j] < UNREACHABLE && field[j] + 1 < d) d = field[j] + 1;
  };
  if (x > 0) consider(tile - 1);
  if (x < w - 1) consider(tile + 1);
  if (tile >= w) consider(tile - w);
  if (tile < owner.length - w) consider(tile + w);
  return d;
}

/**
 * 0..1 supply efficiency of playerId at tile: 1 within supply range of a source, falling linearly to
 * MIN_SUPPLY_EFF at 3x range (and beyond / unreachable). For a tile the player doesn't own, the distance is
 * taken through its own 4-neighbours (+1). 1 before the first supply computation.
 */
export function supplyEfficiency(state: GameState, playerId: number, tile: number): number {
  if (playerId <= 0) return 1;
  const d = supplyDistAt(state, playerId, tile);
  if (d < 0) return 1;
  if (d >= UNREACHABLE) return MIN_SUPPLY_EFF;
  const range = supplyRange(state.players[playerId]);
  if (d <= range) return 1;
  return Math.max(MIN_SUPPLY_EFF, 1 - ((1 - MIN_SUPPLY_EFF) * (d - range)) / (2 * range));
}

// Finished supply depots per player, rebuilt at most once per tick (depot attack bonus).
let depotCache: { state: GameState | null; tick: number; byPlayer: Map<number, number[]> } = { state: null, tick: -1, byPlayer: new Map() };
function depotBonus(state: GameState, playerId: number, tile: number): number {
  if (depotCache.state !== state || depotCache.tick !== state.tick) {
    const byPlayer = new Map<number, number[]>();
    for (const b of state.buildings.values()) {
      if (b.type !== 'supplyDepot' || b.buildLeft > 0 || b.owner <= 0) continue;
      let list = byPlayer.get(b.owner);
      if (!list) byPlayer.set(b.owner, (list = []));
      list.push(b.tile);
    }
    depotCache = { state, tick: state.tick, byPlayer };
  }
  const list = depotCache.byPlayer.get(playerId);
  if (!list) return 0;
  const w = state.map.width;
  const x = tile % w;
  const y = (tile / w) | 0;
  for (const d of list) {
    const dx = (d % w) - x;
    const dy = ((d / w) | 0) - y;
    if (dx * dx + dy * dy <= DEPOT_RADIUS * DEPOT_RADIUS) return DEPOT_ATTACK_BONUS;
  }
  return 0;
}

// ---------- combat formulas ----------
/** Defence power of a player's whole army (count x TROOP_DEFENSE x tech / no-oil), used for density. */
export function defensePower(state: GameState, playerId: number): number {
  const p = state.players[playerId];
  if (!p || playerId === 0) return 0;
  const t = p.troops;
  return t.infantry * typeDefense(state, p, 'infantry') + t.armor * typeDefense(state, p, 'armor') + t.artillery * typeDefense(state, p, 'artillery');
}

/**
 * Defence of one tile: neutral NEUTRAL_TILE_DEF x terrain; enemy density (defensePower / tiles, never below
 * NEUTRAL_TILE_DEF) x terrain x forts/watchtowers x traitor x no-supply. Also returns the fort multiplier.
 */
function tileDefense(state: GameState, tile: number, defender: number): { value: number; fort: number } {
  const ter = TERRAIN[state.map.terrain[tile] as TerrainId];
  if (defender === 0) return { value: NEUTRAL_TILE_DEF * ter.defense, fort: 1 };
  const dp = state.players[defender];
  const density = Math.max(NEUTRAL_TILE_DEF, defensePower(state, defender) / Math.max(1, dp.tiles));
  const fort = fortMultiplierAt(state, tile, defender);
  let v = density * ter.defense * fort;
  if (isTraitor(state, defender)) v *= TRAITOR_DEFENSE;
  if (supplyEfficiency(state, defender, tile) < 1) v *= DEFENDER_NO_SUPPLY;
  return { value: v, fort };
}

/**
 * Attack power per unit of `troops` (owned by attackerId) against `tile` of `defender`: composition-weighted
 * (type attack x terrain x matchup vs the defender's mix x artillery fort bonus) x supply x depot x combined arms.
 * The artillery bonus applies when a fort covers the tile (multiplier >= FORT_DEFENSE; a watchtower alone is not
 * a fort).
 */
function powerPerUnit(state: GameState, attackerId: number, troops: Troops, tile: number, defender: number, fort: number): number {
  const tot = total(troops);
  if (tot <= 0) return 0;
  const p = state.players[attackerId];
  const ter = TERRAIN[state.map.terrain[tile] as TerrainId];
  const against = defender === 0 ? null : state.players[defender].troops;
  let sum = 0;
  for (const k of TROOP_TYPES) {
    if (troops[k] <= 0) continue;
    let m = typeAttack(state, p, k) * ter.attack[k] * matchupVs(k, against);
    if (k === 'artillery' && fort >= FORT_DEFENSE) m *= ARTILLERY_FORT_BONUS;
    sum += (troops[k] / tot) * m;
  }
  sum *= supplyEfficiency(state, attackerId, tile);
  sum *= 1 + depotBonus(state, attackerId, tile);
  sum *= combinedArms(p, troops, tot);
  return sum;
}

interface TileCost {
  /** attacker units lost to take the tile */
  loss: number;
  /** tile defence (units of attack power) */
  defense: number;
  /** attack power per attacking unit here */
  power: number;
  /** defender units killed when the tile falls */
  defenderLoss: number;
}
function tileCost(state: GameState, attackerId: number, troops: Troops, tile: number, defender: number): TileCost {
  const def = tileDefense(state, tile, defender);
  const power = powerPerUnit(state, attackerId, troops, tile, defender, def.fort);
  const loss = power > 0 ? def.value / power : Infinity;
  let defenderLoss = 0;
  if (defender !== 0) {
    const dp = state.players[defender];
    // DEFENDER_LOSS_PER_TILE x density in units (army count / tiles).
    defenderLoss = (DEFENDER_LOSS_PER_TILE * total(dp.troops)) / Math.max(1, dp.tiles);
  }
  return { loss, defense: def.value, power, defenderLoss };
}

/** Tiles per second of a force against the next tile (see SPEED_FULL_RATIO for the defender factor). */
function attackSpeed(state: GameState, attackerId: number, troops: Troops, tile: number, defender: number, cost: TileCost): number {
  const tot = total(troops);
  if (tot <= 0) return 0;
  const p = state.players[attackerId];
  const ter = TERRAIN[state.map.terrain[tile] as TerrainId];
  let s = BASE_ATTACK_SPEED * ter.speed;
  s *= 1 + (troops.armor / tot) * ARMOR_SPEED_BONUS;
  s *= 1 - (troops.artillery / tot) * ARTILLERY_SLOW;
  s *= 1 + Math.log10(1 + tot / 1000) * FORCE_SPEED_SCALE;
  if (hasTech(p, 'logistics')) s *= LOGISTICS_SPEED;
  if (ATTACK_SPEED_DEFENDER_FACTOR && defender !== 0) {
    const defenderStrength = cost.defense * Math.max(1, state.players[defender].tiles);
    const ratio = (tot * cost.power) / defenderStrength;
    s *= clamp(ratio / SPEED_FULL_RATIO, SPEED_MIN_FACTOR, 1);
  }
  return s;
}

/**
 * Splits `amount` losses over troop types by weight (count x vulnerability); a type that runs out passes its
 * excess on to the others.
 */
function splitLosses(troops: Troops, amount: number, weight: Record<TroopType, number>): Troops {
  const out = zero();
  let remaining = amount;
  for (let pass = 0; pass < 3 && remaining > 1e-9; pass++) {
    let wsum = 0;
    for (const k of TROOP_TYPES) if (troops[k] - out[k] > 1e-9) wsum += weight[k];
    if (wsum <= 0) break;
    let excess = 0;
    for (const k of TROOP_TYPES) {
      const cap = troops[k] - out[k];
      if (cap <= 1e-9) continue;
      const share = (remaining * weight[k]) / wsum;
      const take = Math.min(share, cap);
      out[k] += take;
      excess += share - take;
    }
    remaining = excess;
  }
  return out;
}

/**
 * Removes `amount` units of losses from an attack: split by vulnerability (artillery is fragile when it is more
 * than ARTILLERY_UNESCORTED_SHARE of the force, 0.55 with Ballistics), infantry losses reduced by barracks.
 * Hospitals return part of the losses as workers. Returns the units actually lost.
 */
function applyAttackerLosses(state: GameState, a: Attack, amount: number, enemy: number, useBarracks = true): number {
  const t = a.troops;
  const tot = total(t);
  if (tot <= 0 || amount <= 0) return 0;
  const p = state.players[a.attacker];
  const threshold = hasTech(p, 'ballistics') ? BALLISTICS_UNESCORTED_SHARE : ARTILLERY_UNESCORTED_SHARE;
  const weight: Record<TroopType, number> = {
    infantry: t.infantry * VULNERABILITY.infantry,
    armor: t.armor * VULNERABILITY.armor,
    artillery: t.artillery * (t.artillery / tot > threshold ? ARTILLERY_UNESCORTED_VULN : VULNERABILITY.artillery),
  };
  const loss = splitLosses(t, Math.min(amount, tot), weight);
  if (useBarracks) {
    const barracks = Math.min(BARRACKS_MAX, countBuildings(state, a.attacker, 'barracks'));
    loss.infantry *= 1 - barracks * BARRACKS_LOSS_REDUCTION;
  }
  let lost = 0;
  for (const k of TROOP_TYPES) {
    t[k] = Math.max(0, t[k] - loss[k]);
    lost += loss[k];
  }
  if (total(t) < 1e-6) clearTroops(t);
  a.losses += lost;
  p.stats.troopsLost += lost;
  if (enemy > 0) state.players[enemy].stats.troopsKilled += lost;
  const hospitals = Math.min(HOSPITAL_MAX, countBuildings(state, a.attacker, 'hospital'));
  if (hospitals > 0) p.workers += lost * hospitals * HOSPITAL_RECOVERY;
  return lost;
}

/** Kills defender units (from their home pool, split by composition). */
function applyDefenderLosses(state: GameState, defender: number, amount: number, killer: number): void {
  if (defender <= 0 || amount <= 0) return;
  const dp = state.players[defender];
  const tot = total(dp.troops);
  if (tot <= 0) return;
  const u = Math.min(amount, tot);
  for (const k of TROOP_TYPES) dp.troops[k] = Math.max(0, dp.troops[k] - (u * dp.troops[k]) / tot);
  dp.stats.troopsLost += u;
  state.players[killer].stats.troopsKilled += u;
}

// ---------- frontier ----------
interface Front {
  tiles: number[];
  prio: number[];
  /** tiles currently in the heap (no duplicates) */
  queued: Set<number>;
}
// Per-attack frontier, keyed by the Attack object. Not part of GameState: a front missing after a state copy is
// rebuilt from the map on demand.
const fronts = new WeakMap<Attack, Front>();

function heapPush(f: Front, tile: number, prio: number): void {
  const tiles = f.tiles;
  const pr = f.prio;
  let i = tiles.length;
  tiles.push(tile);
  pr.push(prio);
  while (i > 0) {
    const parent = (i - 1) >> 1;
    if (pr[parent] <= prio) break;
    tiles[i] = tiles[parent];
    pr[i] = pr[parent];
    i = parent;
  }
  tiles[i] = tile;
  pr[i] = prio;
}
function heapPop(f: Front): void {
  const tiles = f.tiles;
  const pr = f.prio;
  f.queued.delete(tiles[0]);
  const lastT = tiles.pop()!;
  const lastP = pr.pop()!;
  const n = tiles.length;
  if (n === 0) return;
  let i = 0;
  for (;;) {
    let c = 2 * i + 1;
    if (c >= n) break;
    if (c + 1 < n && pr[c + 1] < pr[c]) c++;
    if (pr[c] >= lastP) break;
    tiles[i] = tiles[c];
    pr[i] = pr[c];
    i = c;
  }
  tiles[i] = lastT;
  pr[i] = lastP;
}

function frontPriority(state: GameState, focus: number, tile: number): number {
  const w = state.map.width;
  const dx = (tile % w) - (focus % w);
  const dy = ((tile / w) | 0) - ((focus / w) | 0);
  return Math.sqrt(dx * dx + dy * dy) + state.rng() * FRONT_JITTER;
}
function queueTile(state: GameState, a: Attack, f: Front, tile: number): void {
  if (f.queued.has(tile)) return;
  f.queued.add(tile);
  heapPush(f, tile, frontPriority(state, a.focusTile, tile));
}

/** True if tile has a 4-neighbour owned by playerId. */
function touches(state: GameState, tile: number, playerId: number): boolean {
  const map = state.map;
  const owner = map.owner;
  const w = map.width;
  const x = tile % w;
  return (
    (x > 0 && owner[tile - 1] === playerId) ||
    (x < w - 1 && owner[tile + 1] === playerId) ||
    (tile >= w && owner[tile - w] === playerId) ||
    (tile < owner.length - w && owner[tile + w] === playerId)
  );
}
/** A tile the attack can take next: owned by the target (land, if neutral) and touching the attacker. */
function isFrontTile(state: GameState, attacker: number, target: number, tile: number): boolean {
  const map = state.map;
  if (map.owner[tile] !== target) return false;
  if (target === 0 && isWater(map.terrain[tile])) return false;
  return touches(state, tile, attacker);
}

/** Frontier tiles in a box of half-size `radius` around focus (Infinity = whole map). */
function scanFront(state: GameState, attacker: number, target: number, focus: number, radius: number): number[] {
  const map = state.map;
  const w = map.width;
  const h = map.height;
  const fx = focus % w;
  const fy = (focus / w) | 0;
  const r = Math.min(radius, Math.max(w, h));
  const x0 = Math.max(0, fx - r);
  const x1 = Math.min(w - 1, fx + r);
  const y0 = Math.max(0, fy - r);
  const y1 = Math.min(h - 1, fy + r);
  const owner = map.owner;
  const out: number[] = [];
  for (let y = y0; y <= y1; y++) {
    const row = y * w;
    for (let x = x0; x <= x1; x++) {
      const i = row + x;
      if (owner[i] === target && isFrontTile(state, attacker, target, i)) out.push(i);
    }
  }
  return out;
}
/** Box around the focus first, whole map only if the box has no frontier. */
function findFront(state: GameState, attacker: number, target: number, focus: number): number[] {
  const near = scanFront(state, attacker, target, focus, FRONT_SCAN_RADIUS);
  return near.length ? near : scanFront(state, attacker, target, focus, Infinity);
}

/** (Re)builds an attack's heap from `tiles` plus whatever it already held, prioritised for the current focus. */
function rebuildFront(state: GameState, a: Attack, tiles: number[]): Front {
  const old = fronts.get(a);
  const f: Front = { tiles: [], prio: [], queued: new Set() };
  if (old) for (const t of old.tiles) queueTile(state, a, f, t);
  for (const t of tiles) queueTile(state, a, f, t);
  fronts.set(a, f);
  return f;
}
function getFront(state: GameState, a: Attack): Front {
  return fronts.get(a) ?? rebuildFront(state, a, findFront(state, a.attacker, a.target, a.focusTile));
}
/** Next valid frontier tile (stale entries are dropped), or -1. */
function peekFront(state: GameState, a: Attack, f: Front): number {
  while (f.tiles.length) {
    const t = f.tiles[0];
    if (isFrontTile(state, a.attacker, a.target, t)) return t;
    heapPop(f);
  }
  return -1;
}
/** Like peekFront, but rescans the map once if the heap ran dry (tiles may have become adjacent elsewhere). */
function nextFrontTile(state: GameState, a: Attack, f: Front): number {
  const t = peekFront(state, a, f);
  if (t >= 0) return t;
  for (const s of findFront(state, a.attacker, a.target, a.focusTile)) queueTile(state, a, f, s);
  return peekFront(state, a, f);
}

const nb4: number[] = [0, 0, 0, 0];
/**
 * Captures a tile for a.attacker and keeps every affected front up to date: target neighbours of the tile join
 * the attacker's fronts against their owners, and the tile itself joins fronts of attacks aimed at the attacker
 * whose attacker touches it. Also extends the attacker's supply field to the tile.
 */
function captureTile(state: GameState, a: Attack, tile: number): void {
  const map = state.map;
  const owner = map.owner;
  const attacker = a.attacker;
  const hadBuilding = map.building[tile] !== 0;
  setOwner(state, tile, attacker);
  a.tilesTaken++;

  const w = map.width;
  const x = tile % w;
  let n = 0;
  if (x > 0) nb4[n++] = tile - 1;
  if (x < w - 1) nb4[n++] = tile + 1;
  if (tile >= w) nb4[n++] = tile - w;
  if (tile < owner.length - w) nb4[n++] = tile + w;

  // Supply distance for the new tile from its own neighbours (until the next full recalc).
  const field = state.supplyDist.get(attacker);
  if (field) {
    let d = UNREACHABLE;
    for (let q = 0; q < n; q++) {
      const j = nb4[q];
      if (owner[j] === attacker && field[j] < UNREACHABLE && field[j] + 1 < d) d = field[j] + 1;
    }
    field[tile] = Math.min(d, UNREACHABLE);
  }

  for (const other of state.attacks) {
    if (total(other.troops) <= 0) continue;
    const f = fronts.get(other);
    if (!f) continue;
    if (other.attacker === attacker) {
      for (let q = 0; q < n; q++) {
        const j = nb4[q];
        if (owner[j] === other.target && (other.target !== 0 || !isWater(map.terrain[j]))) queueTile(state, other, f, j);
      }
    } else if (other.target === attacker && touches(state, tile, other.attacker)) {
      queueTile(state, other, f, tile);
    }
  }

  if (hadBuilding || a.tilesTaken % CAPTURE_EFFECT_EVERY === 0) {
    state.effects.push({ kind: 'capture', x: x + 0.5, y: ((tile / w) | 0) + 0.5, radius: hadBuilding ? 3 : 1.5, tick: state.tick });
  }
}

// ---------- attacks ----------
function returnTroops(state: GameState, a: Attack): void {
  const p = state.players[a.attacker];
  if (p.alive) addTroops(p.troops, a.troops);
  clearTroops(a.troops);
}

/**
 * Starts an attack from playerId toward the owner of `tile` (0 = neutral land) with these troops, which are
 * removed from the player's pool. Validates: tile is land, not own, not allied, target borders the attacker
 * (or amphibious), troops >= MIN_ATTACK_TROOPS and available, attack count limit. If an attack on the same
 * target already exists, troops are merged into it and the focus moves.
 *
 * Amphibious (units.ts, on a transport landing): `troops` come from the transport and are NOT taken from the
 * pool; no minimum, bordering or attack-count check. The landing tile is captured first, paid like any other tile
 * by the landed troops (if they can't pay, they are lost and the result is not ok); the front then grows from that
 * beachhead. A landing on a tile the attacker already owns just puts the troops back in the pool (ok). On any
 * other failure (water, ally, dead target) the troops are untouched and the caller decides what to do with them.
 */
export function launchAttack(state: GameState, playerId: number, tile: number, troops: Troops, amphibious = false): ActionResult {
  const map = state.map;
  const p = state.players[playerId];
  if (!p || playerId === 0 || !p.alive) return { ok: false, reason: 'No such player' };
  if (!Number.isInteger(tile) || tile < 0 || tile >= map.owner.length) return { ok: false, reason: 'Invalid tile' };
  if (isWater(map.terrain[tile])) return { ok: false, reason: 'Land troops cannot attack water' };
  const target = map.owner[tile];
  const sent = zero();
  for (const k of TROOP_TYPES) {
    const v = troops?.[k];
    sent[k] = typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0;
  }
  if (target === playerId) {
    if (!amphibious) return { ok: false, reason: 'That is your own land' };
    addTroops(p.troops, sent);
    return { ok: true };
  }
  const tp = state.players[target];
  if (target !== 0) {
    if (!tp.alive) return { ok: false, reason: 'That nation is gone' };
    if (areAllied(state, playerId, target)) return { ok: false, reason: 'You cannot attack an ally' };
  }
  const tot = total(sent);
  if (!amphibious) {
    if (tot < MIN_ATTACK_TROOPS) return { ok: false, reason: `Send at least ${MIN_ATTACK_TROOPS} troops` };
    for (const k of TROOP_TYPES) {
      if (sent[k] > p.troops[k] + 1e-6) return { ok: false, reason: `Not enough ${k}` };
      sent[k] = Math.min(sent[k], p.troops[k]);
    }
  } else if (tot <= 0) {
    return { ok: false, reason: 'No troops landed' };
  }

  const existing = state.attacks.find((a) => a.attacker === playerId && a.target === target && total(a.troops) > 0);
  if (!existing && !amphibious && state.attacks.filter((a) => a.attacker === playerId).length >= MAX_ATTACKS_PER_PLAYER) {
    return { ok: false, reason: `At most ${MAX_ATTACKS_PER_PLAYER} attacks at once` };
  }

  // Force for this launch; amphibious troops first take the beachhead.
  const force: Attack = {
    id: existing ? existing.id : newId(state),
    attacker: playerId,
    target,
    troops: sent,
    focusTile: tile,
    progress: 0,
    startTick: state.tick,
    amphibious,
    losses: 0,
    tilesTaken: 0,
  };
  if (amphibious) {
    const cost = tileCost(state, playerId, sent, tile, target);
    if (tot < cost.loss) {
      applyDefenderLosses(state, target, (cost.defenderLoss * tot) / cost.loss, playerId);
      applyAttackerLosses(state, force, tot, target, false);
      return { ok: false, reason: 'The landing was repelled' };
    }
    applyAttackerLosses(state, force, cost.loss, target);
    applyDefenderLosses(state, target, cost.defenderLoss, playerId);
    captureTile(state, force, tile);
    if (target !== 0 && !tp.alive) {
      // The beachhead was their last tile.
      addTroops(p.troops, force.troops);
      return { ok: true };
    }
  }

  const near = findFront(state, playerId, target, tile);
  if (!amphibious) {
    const known = existing ? fronts.get(existing) : undefined;
    if (near.length === 0 && !(known && known.tiles.length)) {
      return { ok: false, reason: target === 0 ? 'That land does not border yours' : `You do not border ${tp.name}` };
    }
    for (const k of TROOP_TYPES) p.troops[k] = Math.max(0, p.troops[k] - sent[k]);
  }
  if (target !== 0) {
    state.allianceRequests = state.allianceRequests.filter((r) => !((r.from === playerId && r.to === target) || (r.from === target && r.to === playerId)));
  }

  if (existing) {
    addTroops(existing.troops, force.troops);
    existing.losses += force.losses;
    existing.tilesTaken += force.tilesTaken;
    existing.focusTile = tile;
    if (amphibious) existing.amphibious = true;
    rebuildFront(state, existing, near);
    return { ok: true };
  }
  state.attacks.push(force);
  rebuildFront(state, force, near);
  if (target === 0) {
    addEvent(state, 'attackStarted', `${p.name} expands into neutral land`, [playerId], tile);
  } else {
    addEvent(state, 'attackStarted', `${p.name} attacks ${tp.name}`, [playerId], tile);
    addEvent(state, 'underAttack', `${tp.name} is under attack by ${p.name}`, [target], tile);
  }
  return { ok: true };
}

/** Calls the attack off early: troops go home minus RETREAT_LOSS. */
export function retreat(state: GameState, playerId: number, attackId: number): ActionResult {
  const idx = state.attacks.findIndex((a) => a.id === attackId && a.attacker === playerId);
  if (idx < 0) return { ok: false, reason: 'No such attack' };
  const a = state.attacks[idx];
  const p = state.players[playerId];
  const lost = total(a.troops) * RETREAT_LOSS;
  addTroops(p.troops, a.troops, 1 - RETREAT_LOSS);
  p.stats.troopsLost += lost;
  a.losses += lost;
  clearTroops(a.troops);
  state.attacks.splice(idx, 1);
  fronts.delete(a);
  return { ok: true };
}

/** Attack power of a whole force against another force's composition (counter-attack clash: no terrain/supply). */
function clashPowerPerUnit(state: GameState, attacker: number, t: Troops, against: Troops): number {
  const tot = total(t);
  if (tot <= 0) return 0;
  const p = state.players[attacker];
  let sum = 0;
  for (const k of TROOP_TYPES) if (t[k] > 0) sum += (t[k] / tot) * typeAttack(state, p, k) * matchupVs(k, against);
  return sum * combinedArms(p, t, tot);
}

/** A->B and B->A attacks cancel by power: the weaker force is destroyed, the stronger loses the same power. */
function resolveCounterAttacks(state: GameState): void {
  const attacks = state.attacks;
  for (let i = 0; i < attacks.length; i++) {
    const a = attacks[i];
    if (a.target === 0) continue;
    for (let j = i + 1; j < attacks.length; j++) {
      const b = attacks[j];
      if (b.attacker !== a.target || b.target !== a.attacker) continue;
      const ta = total(a.troops);
      const tb = total(b.troops);
      if (ta <= 0 || tb <= 0) continue;
      const pa = clashPowerPerUnit(state, a.attacker, a.troops, b.troops);
      const pb = clashPowerPerUnit(state, b.attacker, b.troops, a.troops);
      const powA = ta * pa;
      const powB = tb * pb;
      if (powA >= powB) {
        applyAttackerLosses(state, a, pa > 0 ? powB / pa : ta, b.attacker, false);
        applyAttackerLosses(state, b, tb, a.attacker, false);
      } else {
        applyAttackerLosses(state, b, pb > 0 ? powA / pb : tb, a.attacker, false);
        applyAttackerLosses(state, a, ta, b.attacker, false);
      }
    }
  }
}

/** Advances one attack by a tick. Returns true when it is over (troops already returned or lost). */
function stepAttack(state: GameState, a: Attack): boolean {
  const players = state.players;
  if (!players[a.attacker].alive) return true;
  if (a.target !== 0 && (!players[a.target].alive || areAllied(state, a.attacker, a.target))) {
    returnTroops(state, a);
    return true;
  }
  if (total(a.troops) < 1e-6) return true;
  const f = getFront(state, a);
  let next = nextFrontTile(state, a, f);
  if (next < 0) {
    returnTroops(state, a); // nothing left to take
    return true;
  }
  const first = tileCost(state, a.attacker, a.troops, next, a.target);
  a.progress += attackSpeed(state, a.attacker, a.troops, next, a.target, first) * TICK_SECONDS;
  let cost: TileCost | null = first;
  while (a.progress >= 1) {
    if (!cost) {
      next = nextFrontTile(state, a, f);
      if (next < 0) {
        returnTroops(state, a);
        return true;
      }
      cost = tileCost(state, a.attacker, a.troops, next, a.target);
    }
    const tot = total(a.troops);
    if (tot < cost.loss) {
      // Can't pay for the next tile: the force is spent, taking a proportional share of defenders with it.
      applyDefenderLosses(state, a.target, (cost.defenderLoss * tot) / cost.loss, a.attacker);
      applyAttackerLosses(state, a, tot, a.target, false);
      return true;
    }
    applyAttackerLosses(state, a, cost.loss, a.target);
    applyDefenderLosses(state, a.target, cost.defenderLoss, a.attacker);
    heapPop(f);
    captureTile(state, a, next);
    a.progress -= 1;
    cost = null;
    // Taking their last tile eliminates the target; eliminatePlayer already sent our troops home.
    if (a.target !== 0 && !players[a.target].alive) return true;
    if (total(a.troops) < 1e-6) return true;
  }
  return false;
}

/** One tick of every attack (capture tiles, losses, counter-attacks, end/return troops). */
export function updateAttacks(state: GameState): void {
  if (state.attacks.length === 0) return;
  resolveCounterAttacks(state);
  const done = new Set<Attack>();
  // setOwner/elimination only zero troops while we iterate; the array itself is not replaced.
  for (const a of state.attacks) if (stepAttack(state, a)) done.add(a);
  if (done.size) {
    for (const a of done) fronts.delete(a);
    state.attacks = state.attacks.filter((a) => !done.has(a));
  }
}

/**
 * For UI/AI: estimated troops lost per tile and tiles/s if `troops` attacked `tile` now.
 * Returns null if the tile can't be attacked (water, own, allied or dead owner). Does not check bordering;
 * supply is judged through the player's tiles next to `tile` (a tile deep inside enemy land shows minimum supply).
 */
export function estimateAttack(state: GameState, playerId: number, tile: number, troops: Troops): { lossPerTile: number; tilesPerSecond: number; defensePerTile: number } | null {
  const map = state.map;
  const p = state.players[playerId];
  if (!p || playerId === 0 || !p.alive) return null;
  if (!Number.isInteger(tile) || tile < 0 || tile >= map.owner.length || isWater(map.terrain[tile])) return null;
  const target = map.owner[tile];
  if (target === playerId) return null;
  if (target !== 0 && (!state.players[target].alive || areAllied(state, playerId, target))) return null;
  // With no troops given, judge a plain infantry force.
  const t = total(troops) > 0 ? troops : { infantry: 1, armor: 0, artillery: 0 };
  const cost = tileCost(state, playerId, t, tile, target);
  return {
    lossPerTile: cost.loss,
    tilesPerSecond: attackSpeed(state, playerId, t, tile, target, cost),
    defensePerTile: cost.defense,
  };
}

/** True if any tile of `owner` (0 = neutral land) is 4-adjacent to a tile of playerId. Full scan, early exit. */
export function borders(state: GameState, playerId: number, owner: number): boolean {
  if (playerId === owner) return false;
  const map = state.map;
  const { width: w, height: h } = map;
  const own = map.owner;
  const terrain = map.terrain;
  const isTarget = (j: number): boolean => own[j] === owner && (owner !== 0 || !isWater(terrain[j]));
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const i = row + x;
      // Each horizontal/vertical pair once (right and down neighbours), in both directions.
      if (x < w - 1) {
        const j = i + 1;
        if ((own[i] === playerId && isTarget(j)) || (own[j] === playerId && isTarget(i))) return true;
      }
      if (y < h - 1) {
        const j = i + w;
        if ((own[i] === playerId && isTarget(j)) || (own[j] === playerId && isTarget(i))) return true;
      }
    }
  }
  return false;
}
export function attacksOf(state: GameState, playerId: number): Attack[] {
  return state.attacks.filter((a) => a.attacker === playerId);
}
