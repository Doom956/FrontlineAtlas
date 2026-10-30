// Land attacks, fronts, supply, losses (DESIGN section 4).
//
// A click picks the TARGET OWNER (a nation, a tribe, or 0 = wilderness), not a point: an Attack pushes along the
// WHOLE shared border with that owner. Each attack keeps a private frontier: a flat binary min-heap of candidate
// tiles (target tiles 4-adjacent to the attacker). Every tick the attack gets a budget of
//   (front tiles) x (rate per front tile) x 0.1 s
// tiles, so long borders move in proportion to their length, and takes the tiles with the lowest priority:
//   priority = tick queued + jitter(8..18) x (1 - 0.25 x attacker 4-neighbours + 0.5 x (1 / terrain speed - 1))
// so tiles it already half surrounds go first (smooth, blobby fronts), easy ground goes first, and the rest is
// roughly first in, first out (the front grows in rings).
//
// Rates (config): wilderness NEUTRAL_FRONT_RATE / clamp(NEUTRAL_SPEED_TROOPS / troops, 5, 100) per front tile (a
// flood fill once a few thousand troops are sent); nations NATION_FRONT_RATE / clamp(1 / odds, 0.82, 7.5) (an even
// fight takes about half the front per tick). Troop mix, Logistics, terrain, forts and supply only change the speed.
//
// Losses: wilderness NEUTRAL_LOSS_PER_TILE x terrain defence per tile; a nation's tile costs ATTACK_LOSS_BASE x
// terrain defence x forts x clamp(1 / odds, 0.6, 2) x (LOSS_FLAT + LOSS_DENSITY x defender density), divided by the
// attack power per unit (troop types, terrain attack, matchups, supply, depots, techs); the defender loses its density
// per tile. Tribes as targets cost x0.7.
//
// The heap is built at launch from the attacker's border set (territory.ts) and then updated on every capture:
// neighbours of a captured tile are queued (duplicates allowed). Stale entries are dropped lazily when they reach the
// top; a purge every few ticks keeps the front length (distinct queued tiles) honest.
import { buildingStamp, buildingsOf, countBuildings, depotRadius, fortMultiplierAt, supplySources } from './buildings';
import {
  ARMOR_SPEED_BONUS,
  ARTILLERY_FORT_BONUS,
  ARTILLERY_SLOW,
  ARTILLERY_UNESCORTED_SHARE,
  ARTILLERY_UNESCORTED_VULN,
  ATTACK_LOSS_BASE,
  BARRACKS_LOSS_REDUCTION,
  BARRACKS_MAX,
  BEACHHEAD_SUPPLY_SECONDS,
  BOAT_LANDING_RADIUS,
  COMBINED_ARMS_BONUS,
  COMBINED_ARMS_MIN_SHARE,
  DEFENDER_LOSS_PER_TILE,
  DEFENDER_NO_SUPPLY,
  DEPOT_ATTACK_BONUS,
  ENDGAME_SMALL_TILES,
  HUMAN_GRACE_SECONDS,
  FORT_DEFENSE,
  FORT_SLOW,
  FRONT_JITTER_MIN,
  FRONT_JITTER_SPAN,
  FRONT_MIN_TILES,
  FRONT_NEIGHBOUR_WEIGHT,
  FRONT_TERRAIN_WEIGHT,
  HOSPITAL_MAX,
  HOSPITAL_RECOVERY,
  LOSS_DENSITY,
  LOSS_FLAT,
  MATCHUP,
  MAX_ATTACKS_PER_PLAYER,
  MAX_TILES_PER_TICK,
  MIN_ATTACK_TROOPS,
  MIN_SUPPLY_EFF,
  NATION_FRONT_RATE,
  NEUTRAL_FRONT_RATE,
  NEUTRAL_LOSS_PER_TILE,
  NEUTRAL_SPEED_CLAMP,
  NEUTRAL_SPEED_TROOPS,
  NO_OIL_ARMOR_FACTOR,
  ODDS_SPEED,
  OUTNUMBER_LOSS,
  RETREAT_LOSS,
  SUPPLY_RANGE,
  TERRAIN,
  TICK_SECONDS,
  TICKS_PER_SECOND,
  TRAITOR_DEFENSE,
  TRIBE_ANNEX_TILES,
  TRIBE_NEUTRAL_LOSS,
  TRIBE_TARGET_LOSS,
  TROOP_ATTACK,
  TROOP_DEFENSE,
  VULNERABILITY,
} from './config';
import { areAllied, isTraitor, onAttackStarted } from './diplomacy';
import { atPeace, frontRate as frontRateMul, peaceReason, sameTeam } from './rules';
import { hasOilShortage } from './economy';
import { nearestTile } from './grid';
import { addEvent, gameSeconds, newId, setOwner } from './state';
import { hasTech } from './tech';
import { borderTiles, landComponents } from './territory';
import { TROOP_TYPES, isTribe, isWater } from './types';
import type { ActionResult, Attack, GameState, Player, TerrainId, TroopType, Troops } from './types';

// ---------- tuning that config.ts leaves to this module ----------
/** Every this many ticks an attack drops stale tiles from its front (keeps the front length honest). */
const FRONT_PURGE_TICKS = 10;
/** A 'capture' effect every this many tiles per attack (and on every tile with a building). */
const CAPTURE_EFFECT_EVERY = 40;
// Tech effects (described in config TECHS).
const LOGISTICS_SPEED = 1.15;
const LOGISTICS_RANGE = 1.5;
const MECHANIZATION_ARMOR = 1.25;
const BALLISTICS_ARTILLERY = 1.3;
const BALLISTICS_UNESCORTED_SHARE = 0.55;
/** Traitors defend badly: attackers lose x TRAITOR_DEFENSE and move this much faster. */
const TRAITOR_SPEED = 1.25;

// Per-tile terrain tables (constant, built once from config).
const TER_SPEED_COST = new Float64Array(9);
const TER_PRIO = new Float64Array(9);
for (let t = 2; t < 9; t++) {
  const sp = Math.max(0.05, TERRAIN[t as TerrainId].speed);
  TER_SPEED_COST[t] = 1 / sp;
  TER_PRIO[t] = FRONT_TERRAIN_WEIGHT * (1 / sp - 1);
}

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
// Cheap model: the supply distance of a tile is the straight-line distance to the nearest own supply source
// (capital, finished cities and depots, live beachheads). No path search; sources are cached per player and
// rebuilt when the buildings, the capital or the beachheads change.
function supplyRange(p: Player): number {
  return SUPPLY_RANGE * (hasTech(p, 'logistics') ? LOGISTICS_RANGE : 1);
}

interface Beachhead {
  player: number;
  tile: number;
  untilTick: number;
}
interface SupplyCache {
  version: number;
  capital: number;
  heads: number;
  /** tick until which the cached beachhead list is valid (first expiry) */
  validUntil: number;
  xs: Int32Array;
  ys: Int32Array;
}
interface SupplyData {
  beachheads: Beachhead[];
  /** bumped whenever a beachhead is added */
  headVersion: number;
  byPlayer: Map<number, SupplyCache>;
}
const supplyData = new WeakMap<GameState, SupplyData>();
function supplyOf(state: GameState): SupplyData {
  let d = supplyData.get(state);
  if (!d) supplyData.set(state, (d = { beachheads: [], headVersion: 0, byPlayer: new Map() }));
  return d;
}

/** Supply source tiles of a player (capital, finished cities and depots it owns, live beachheads). */
export function supplySourceTiles(state: GameState, playerId: number): number[] {
  const owner = state.map.owner;
  const out = supplySources(state, playerId).filter((t) => owner[t] === playerId);
  for (const b of supplyOf(state).beachheads) {
    if (b.player === playerId && b.untilTick > state.tick && owner[b.tile] === playerId) out.push(b.tile);
  }
  return out;
}

function supplyCache(state: GameState, playerId: number): SupplyCache {
  const d = supplyOf(state);
  const p = state.players[playerId];
  let c = d.byPlayer.get(playerId);
  const stamp = buildingStamp(state, playerId);
  if (c && c.version === stamp && c.capital === p.capital && c.heads === d.headVersion && state.tick < c.validUntil) return c;
  const tiles = supplySourceTiles(state, playerId);
  const w = state.map.width;
  let validUntil = Infinity;
  for (const b of d.beachheads) if (b.player === playerId && b.untilTick > state.tick) validUntil = Math.min(validUntil, b.untilTick);
  c = {
    version: stamp,
    capital: p.capital,
    heads: d.headVersion,
    validUntil,
    xs: new Int32Array(tiles.map((t) => t % w)),
    ys: new Int32Array(tiles.map((t) => (t / w) | 0)),
  };
  d.byPlayer.set(playerId, c);
  return c;
}

/** Straight-line distance (tiles) from tile to playerId's nearest supply source; Infinity without sources. */
export function supplyDistance(state: GameState, playerId: number, tile: number): number {
  if (playerId <= 0 || !state.players[playerId]) return Infinity;
  const c = supplyCache(state, playerId);
  const w = state.map.width;
  const x = tile % w;
  const y = (tile / w) | 0;
  let best = Infinity;
  const xs = c.xs;
  const ys = c.ys;
  for (let k = 0; k < xs.length; k++) {
    const dx = xs[k] - x;
    const dy = ys[k] - y;
    const d2 = dx * dx + dy * dy;
    if (d2 < best) best = d2;
  }
  return Math.sqrt(best);
}

/**
 * 0..1 supply efficiency of playerId at tile: 1 within supply range of a source (straight line), falling linearly to
 * MIN_SUPPLY_EFF at 3x range and beyond. Players without any source fight at MIN_SUPPLY_EFF.
 */
export function supplyEfficiency(state: GameState, playerId: number, tile: number): number {
  if (playerId <= 0) return 1;
  const d = supplyDistance(state, playerId, tile);
  const range = supplyRange(state.players[playerId]);
  if (d <= range) return 1;
  if (!(d < 3 * range)) return MIN_SUPPLY_EFF;
  return Math.max(MIN_SUPPLY_EFF, 1 - ((1 - MIN_SUPPLY_EFF) * (d - range)) / (2 * range));
}

/** Supply is computed on demand now (kept for callers of the old periodic update): drops expired beachheads. */
export function updateSupply(state: GameState): void {
  const d = supplyData.get(state);
  if (!d || !d.beachheads.length) return;
  if (state.tick % TICKS_PER_SECOND !== 0) return;
  const owner = state.map.owner;
  d.beachheads = d.beachheads.filter((b) => b.untilTick > state.tick && owner[b.tile] === b.player);
}

/** Depot attack bonus: DEPOT_ATTACK_BONUS when a finished supply depot of playerId covers the tile (depotRadius). */
function depotBonus(state: GameState, playerId: number, tile: number): number {
  if (countBuildings(state, playerId, 'supplyDepot') === 0) return 0;
  const w = state.map.width;
  const x = tile % w;
  const y = (tile / w) | 0;
  for (const b of buildingsOf(state, playerId, 'supplyDepot')) {
    if (b.buildLeft > 0) continue;
    const dx = (b.tile % w) - x;
    const dy = ((b.tile / w) | 0) - y;
    const r = depotRadius(b);
    if (dx * dx + dy * dy <= r * r) return DEPOT_ATTACK_BONUS;
  }
  return 0;
}

// ---------- combat formulas ----------
/** Defence power of a player's home army (count x TROOP_DEFENSE x tech / no-oil). */
export function defensePower(state: GameState, playerId: number): number {
  const p = state.players[playerId];
  if (!p || playerId === 0) return 0;
  const t = p.troops;
  return t.infantry * typeDefense(state, p, 'infantry') + t.armor * typeDefense(state, p, 'armor') + t.artillery * typeDefense(state, p, 'artillery');
}

/**
 * Odds of a force against a nation: its strength (count x type attack x matchup against the defender's mix, no
 * terrain) over the defender's home army defence power. 1 = even; 0 against neutral land.
 */
export function attackOdds(state: GameState, attackerId: number, troops: Troops, defender: number): number {
  if (defender <= 0) return 0;
  const p = state.players[attackerId];
  const dp = state.players[defender];
  if (!p || !dp) return 0;
  let strength = 0;
  for (const k of TROOP_TYPES) if (troops[k] > 0) strength += troops[k] * typeAttack(state, p, k) * matchupVs(k, dp.troops);
  return strength / Math.max(1, defensePower(state, defender));
}
/** "Send more, lose less": attacker loss multiplier clamp(1 / odds, OUTNUMBER_LOSS); 1 against neutral land. */
function lossFactorFor(defender: number, odds: number): number {
  if (defender <= 0) return 1;
  return clamp(1 / Math.max(1e-6, odds), OUTNUMBER_LOSS[0], OUTNUMBER_LOSS[1]);
}

/**
 * Attack power per unit of `troops` (owned by attackerId) against `tile`, fighting a force of composition `against`
 * (null = neutral land): composition-weighted (type attack x terrain attack x matchup x artillery fort bonus)
 * x supply x depot x combined arms. Plain infantry on supplied plains = 1.
 */
function powerPerUnit(state: GameState, attackerId: number, troops: Troops, tile: number, against: Troops | null, fort: number): number {
  const tot = total(troops);
  if (tot <= 0) return 0;
  const p = state.players[attackerId];
  const ter = TERRAIN[state.map.terrain[tile] as TerrainId];
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

/** Per-tick context of one attack (odds, loss factor, density, per-type attack), so tile costs are cheap. */
interface FightCtx {
  attacker: number;
  defender: number;
  troops: Troops;
  odds: number;
  lossFactor: number;
  /** defender home troops per tile */
  density: number;
  traitor: boolean;
  tribeTarget: boolean;
  tribeAttacker: boolean;
  /** share x type attack x matchup against the defender, per type (infantry, armor, artillery) */
  w0: number;
  w1: number;
  w2: number;
  /** combined arms factor */
  combined: number;
}
function fightCtx(state: GameState, attackerId: number, troops: Troops, defender: number): FightCtx {
  const odds = attackOdds(state, attackerId, troops, defender);
  const dp = defender > 0 ? state.players[defender] : null;
  const p = state.players[attackerId];
  const tot = total(troops);
  const against = dp ? dp.troops : null;
  const inv = tot > 0 ? 1 / tot : 0;
  return {
    attacker: attackerId,
    defender,
    troops,
    odds,
    lossFactor: lossFactorFor(defender, odds),
    density: dp ? total(dp.troops) / Math.max(1, dp.tiles) : 0,
    traitor: dp ? isTraitor(state, defender) : false,
    tribeTarget: !!dp && isTribe(dp),
    tribeAttacker: isTribe(p),
    w0: troops.infantry > 0 ? troops.infantry * inv * typeAttack(state, p, 'infantry') * matchupVs('infantry', against) : 0,
    w1: troops.armor > 0 ? troops.armor * inv * typeAttack(state, p, 'armor') * matchupVs('armor', against) : 0,
    w2: troops.artillery > 0 ? troops.artillery * inv * typeAttack(state, p, 'artillery') * matchupVs('artillery', against) : 0,
    combined: combinedArms(p, troops, tot),
  };
}

interface TileCost {
  /** attacker units lost to take the tile */
  loss: number;
  /** tile defence: the loss before dividing by the attack power per unit */
  defense: number;
  /** attack power per attacking unit here */
  power: number;
  /** defender units killed when the tile falls */
  defenderLoss: number;
  /** fort multiplier covering the tile (1 = none) */
  fort: number;
  /** budget units the tile uses (tileBudgetCost) */
  budget: number;
}
// Scratch result of tileCost (filled by every call; read it before the next one).
const scratchCost: TileCost = { loss: 0, defense: 0, power: 0, defenderLoss: 0, fort: 1, budget: 1 };

/** Cost of taking `tile` in the fight `c` (fills and returns a shared scratch object). */
function tileCost(state: GameState, c: FightCtx, tile: number): TileCost {
  const tid = state.map.terrain[tile];
  const ter = TERRAIN[tid as TerrainId];
  const out = scratchCost;
  const sup = supplyEfficiency(state, c.attacker, tile);
  const fort = c.defender === 0 ? 1 : fortMultiplierAt(state, tile, c.defender);
  const att = ter.attack;
  let power = c.w0 * att.infantry + c.w1 * att.armor + c.w2 * att.artillery * (fort >= FORT_DEFENSE ? ARTILLERY_FORT_BONUS : 1);
  power *= sup * c.combined;
  const depot = depotBonus(state, c.attacker, tile);
  if (depot > 0) power *= 1 + depot;
  let defense: number;
  if (c.defender === 0) {
    defense = NEUTRAL_LOSS_PER_TILE * ter.defense * (c.tribeAttacker ? TRIBE_NEUTRAL_LOSS : 1);
    out.defenderLoss = 0;
  } else {
    defense = ATTACK_LOSS_BASE * ter.defense * fort * c.lossFactor * (LOSS_FLAT + LOSS_DENSITY * c.density);
    if (c.traitor) defense *= TRAITOR_DEFENSE;
    if (c.tribeTarget) defense *= TRIBE_TARGET_LOSS;
    if (supplyEfficiency(state, c.defender, tile) < 1) defense *= DEFENDER_NO_SUPPLY;
    out.defenderLoss = DEFENDER_LOSS_PER_TILE * c.density;
  }
  out.loss = power > 0 ? defense / power : Infinity;
  out.defense = defense;
  out.power = power;
  out.fort = fort;
  const fortSlow = fort > 1.01 ? Math.max(1, FORT_SLOW * (fort / FORT_DEFENSE)) : 1;
  out.budget = (TER_SPEED_COST[tid] * fortSlow) / (0.5 + 0.5 * sup);
  return out;
}

/**
 * Front advance rate in tiles per second per front tile, before terrain, forts and supply (those make single tiles
 * cost more of the budget, see tileBudgetCost): wilderness by troops sent, nations by odds; x armor speed,
 * x artillery drag, x Logistics, traitors faster.
 */
function frontRate(state: GameState, c: FightCtx): number {
  const t = c.troops;
  const tot = total(t);
  if (tot <= 0) return 0;
  let r: number;
  if (c.defender === 0) r = NEUTRAL_FRONT_RATE / clamp(NEUTRAL_SPEED_TROOPS / tot, NEUTRAL_SPEED_CLAMP[0], NEUTRAL_SPEED_CLAMP[1]);
  else {
    r = NATION_FRONT_RATE / clamp(1 / Math.max(1e-6, c.odds), ODDS_SPEED[0], ODDS_SPEED[1]);
    if (c.traitor) r *= TRAITOR_SPEED;
  }
  r *= 1 + (t.armor / tot) * ARMOR_SPEED_BONUS;
  r *= 1 - (t.artillery / tot) * ARTILLERY_SLOW;
  if (hasTech(state.players[c.attacker], 'logistics')) r *= LOGISTICS_SPEED;
  return r * frontRateMul(state);
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
 * Hospitals return part of the losses to the troop pool at home. Returns the units actually lost.
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
    if (barracks > 0) loss.infantry *= 1 - barracks * BARRACKS_LOSS_REDUCTION;
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
  if (hospitals > 0 && p.alive) p.troops.infantry += lost * hospitals * HOSPITAL_RECOVERY;
  return lost;
}

/** Kills defender units (from their home pool, split by composition). */
function applyDefenderLosses(state: GameState, defender: number, amount: number, killer: number): void {
  if (defender <= 0 || amount <= 0) return;
  const dp = state.players[defender];
  const tot = total(dp.troops);
  if (tot <= 0) return;
  const u = Math.min(amount, tot);
  const f = 1 - u / tot;
  dp.troops.infantry *= f;
  dp.troops.armor *= f;
  dp.troops.artillery *= f;
  dp.stats.troopsLost += u;
  state.players[killer].stats.troopsKilled += u;
}

// ---------- frontier ----------
interface Front {
  /** flat binary min-heap of (tile, priority); a tile may appear more than once (the best entry wins) */
  tiles: Int32Array;
  prio: Float64Array;
  size: number;
  /** distinct tiles believed to be on the front (its length) */
  queued: Set<number>;
  /** tick of the last stale-entry purge */
  purgeTick: number;
}
// Per-attack frontier, keyed by the Attack object (so two games never share one). Not part of GameState: a front
// missing after a state copy is rebuilt from the map on demand.
const fronts = new WeakMap<Attack, Front>();

function heapPush(f: Front, tile: number, prio: number): void {
  if (f.size >= f.tiles.length) {
    const cap = Math.max(64, f.tiles.length * 2);
    const t2 = new Int32Array(cap);
    t2.set(f.tiles.subarray(0, f.size));
    const p2 = new Float64Array(cap);
    p2.set(f.prio.subarray(0, f.size));
    f.tiles = t2;
    f.prio = p2;
  }
  const tiles = f.tiles;
  const pr = f.prio;
  let i = f.size++;
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
/** Removes the heap top (does not touch `queued`). */
function heapPop(f: Front): void {
  const n = --f.size;
  if (n <= 0) {
    f.size = 0;
    return;
  }
  const tiles = f.tiles;
  const pr = f.prio;
  const lastT = tiles[n];
  const lastP = pr[n];
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

/** Number of 4-neighbours of tile owned by playerId. */
function ownedNeighbours(state: GameState, tile: number, playerId: number): number {
  const owner = state.map.owner;
  const w = state.map.width;
  const x = tile % w;
  let n = 0;
  if (x > 0 && owner[tile - 1] === playerId) n++;
  if (x < w - 1 && owner[tile + 1] === playerId) n++;
  if (tile >= w && owner[tile - w] === playerId) n++;
  if (tile < owner.length - w && owner[tile + w] === playerId) n++;
  return n;
}

/** Front priority (lower = taken first), in ticks. */
function frontPriority(state: GameState, a: Attack, tile: number): number {
  const nb = ownedNeighbours(state, tile, a.attacker);
  const jitter = FRONT_JITTER_MIN + state.rng() * FRONT_JITTER_SPAN;
  return state.tick + jitter * (1 - FRONT_NEIGHBOUR_WEIGHT * nb + TER_PRIO[state.map.terrain[tile]]);
}
function queueTile(state: GameState, a: Attack, f: Front, tile: number): void {
  f.queued.add(tile);
  heapPush(f, tile, frontPriority(state, a, tile));
}

/** A tile the attack can take next: owned by the target (land, if neutral) and touching the attacker. */
function isFrontTile(state: GameState, attacker: number, target: number, tile: number): boolean {
  const map = state.map;
  if (map.owner[tile] !== target) return false;
  if (target === 0 && isWater(map.terrain[tile])) return false;
  return ownedNeighbours(state, tile, attacker) > 0;
}

// Visited marks for front searches and floods, per game: a generation counter, so they never need clearing.
interface Marks {
  gen: number;
  arr: Uint32Array;
}
const markSets = new WeakMap<GameState, Marks>();
function nextMark(state: GameState): Marks {
  const n = state.map.owner.length;
  let m = markSets.get(state);
  if (!m || m.arr.length !== n) markSets.set(state, (m = { gen: 0, arr: new Uint32Array(n) }));
  if (++m.gen >= 0xffffffff) {
    m.arr.fill(0);
    m.gen = 1;
  }
  return m;
}

/**
 * Frontier tiles of attacker vs target (target land 4-adjacent to the attacker), from the attacker's border set.
 * `comp` > 0 limits it to that landmass. `limit` stops early (counting only).
 */
function findFront(state: GameState, attacker: number, target: number, comp = 0, limit = Infinity): number[] {
  const out: number[] = [];
  const { list, len } = borderTiles(state, attacker);
  if (len === 0) return out;
  const map = state.map;
  const { owner, terrain } = map;
  const w = map.width;
  const n = owner.length;
  const comps = comp > 0 ? landComponents(map) : null;
  const mk = nextMark(state);
  const gen = mk.gen;
  const m = mk.arr;
  const consider = (j: number): void => {
    if (owner[j] !== target || terrain[j] <= 1 || m[j] === gen) return;
    m[j] = gen;
    out.push(j);
  };
  for (let k = 0; k < len && out.length < limit; k++) {
    const i = list[k];
    if (comps && comps[i] !== comp) continue;
    const x = i % w;
    if (x > 0) consider(i - 1);
    if (x < w - 1) consider(i + 1);
    if (i >= w) consider(i - w);
    if (i < n - w) consider(i + w);
  }
  return out;
}

function newFront(): Front {
  return { tiles: new Int32Array(64), prio: new Float64Array(64), size: 0, queued: new Set(), purgeTick: 0 };
}
/** (Re)builds an attack's heap from `tiles` plus whatever it already held. */
function rebuildFront(state: GameState, a: Attack, tiles: number[]): Front {
  const old = fronts.get(a);
  const f = newFront();
  f.purgeTick = state.tick;
  if (old) for (const t of old.queued) if (isFrontTile(state, a.attacker, a.target, t)) queueTile(state, a, f, t);
  for (const t of tiles) if (!f.queued.has(t)) queueTile(state, a, f, t);
  fronts.set(a, f);
  return f;
}
function getFront(state: GameState, a: Attack): Front {
  return fronts.get(a) ?? rebuildFront(state, a, findFront(state, a.attacker, a.target));
}
/** Drops tiles that left the front from `queued`; rebuilds the heap when duplicates piled up. */
function purgeFront(state: GameState, a: Attack, f: Front): void {
  f.purgeTick = state.tick;
  for (const t of f.queued) if (!isFrontTile(state, a.attacker, a.target, t)) f.queued.delete(t);
  if (f.size > 3 * f.queued.size + 64) {
    // Keep each tile's best entry.
    const best = new Map<number, number>();
    for (let k = 0; k < f.size; k++) {
      const t = f.tiles[k];
      if (!f.queued.has(t)) continue;
      const p = f.prio[k];
      const b = best.get(t);
      if (b === undefined || p < b) best.set(t, p);
    }
    f.size = 0;
    for (const [t, p] of best) heapPush(f, t, p);
  }
}
/** Next valid frontier tile (stale entries are dropped), or -1. */
function peekFront(state: GameState, a: Attack, f: Front): number {
  while (f.size > 0) {
    const t = f.tiles[0];
    if (isFrontTile(state, a.attacker, a.target, t)) return t;
    heapPop(f);
    f.queued.delete(t);
  }
  return -1;
}
/** Like peekFront, but rescans once if the heap ran dry (tiles may have become adjacent elsewhere). */
function nextFrontTile(state: GameState, a: Attack, f: Front): number {
  const t = peekFront(state, a, f);
  if (t >= 0) return t;
  for (const s of findFront(state, a.attacker, a.target)) queueTile(state, a, f, s);
  return peekFront(state, a, f);
}

/** Current front length (distinct frontier tiles) of an attack, for the UI and the AI. */
export function frontLength(state: GameState, a: Attack): number {
  const f = fronts.get(a);
  return f ? f.queued.size : 0;
}

/** Attacks indexed by attacker and by target (rebuilt per updateAttacks; captures look up affected fronts). */
interface AttackIndex {
  byAttacker: Map<number, Attack[]>;
  byTarget: Map<number, Attack[]>;
}
function indexAttacks(attacks: Attack[]): AttackIndex {
  const byAttacker = new Map<number, Attack[]>();
  const byTarget = new Map<number, Attack[]>();
  for (const a of attacks) {
    let l = byAttacker.get(a.attacker);
    if (!l) byAttacker.set(a.attacker, (l = []));
    l.push(a);
    if (a.target > 0) {
      let t = byTarget.get(a.target);
      if (!t) byTarget.set(a.target, (t = []));
      t.push(a);
    }
  }
  return { byAttacker, byTarget };
}

const nb4: number[] = [0, 0, 0, 0];
/**
 * Captures a tile for a.attacker and keeps every affected front up to date: target neighbours of the tile join
 * the attacker's fronts against their owners, and the tile itself joins fronts of attacks aimed at the attacker
 * whose attacker touches it.
 */
function captureTile(state: GameState, a: Attack, tile: number, idx: AttackIndex): void {
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

  const mine = idx.byAttacker.get(attacker);
  if (mine) {
    for (const other of mine) {
      if (total(other.troops) <= 0) continue;
      const f = fronts.get(other);
      if (!f) continue;
      if (other === a) f.queued.delete(tile);
      const tgt = other.target;
      for (let q = 0; q < n; q++) {
        const j = nb4[q];
        if (owner[j] === tgt && map.terrain[j] > 1) queueTile(state, other, f, j);
      }
    }
  }
  const against = idx.byTarget.get(attacker);
  if (against) {
    for (const other of against) {
      if (total(other.troops) <= 0) continue;
      const f = fronts.get(other);
      if (!f) continue;
      if (ownedNeighbours(state, tile, other.attacker) > 0) queueTile(state, other, f, tile);
    }
  }

  if (hadBuilding || a.tilesTaken % CAPTURE_EFFECT_EVERY === 0) {
    state.effects.push({ kind: 'capture', x: x + 0.5, y: ((tile / w) | 0) + 0.5, radius: hadBuilding ? 3 : 1.5, tick: state.tick });
  }
}

// ---------- endgame: fast cleanup ----------
/**
 * Tiles under which a nation (or tribe) collapses when it is hit (and is absorbed whole when surrounded). 0 for a
 * human in its first HUMAN_GRACE_SECONDS of game time: it only loses the tiles that are taken.
 */
export function collapseThreshold(state: GameState, p: Player): number {
  if (isTribe(p)) return TRIBE_ANNEX_TILES;
  if (p.isHuman && gameSeconds(state) < HUMAN_GRACE_SECONDS) return 0;
  return ENDGAME_SMALL_TILES;
}
/**
 * Gives every tile of `victim` to `taker` (fast cleanup of a dying nation / an annexed pocket); `tiles` limits it
 * to those tiles. The victim is eliminated if nothing is left. Returns the tiles moved.
 */
export function annexTiles(state: GameState, victim: number, taker: number, tiles?: number[]): number {
  const owner = state.map.owner;
  let list = tiles;
  if (!list) list = ownedTilesFlood(state, victim);
  let moved = 0;
  for (const t of list) {
    if (owner[t] !== victim) continue;
    setOwner(state, t, taker);
    moved++;
  }
  return moved;
}
/**
 * Every tile of a player: a flood fill from its border set and capital (each 4-connected piece of land has a border
 * tile or is an island; islands are found from the capital or by a scan of the bounding area as a last resort).
 */
function ownedTilesFlood(state: GameState, playerId: number): number[] {
  const p = state.players[playerId];
  const out: number[] = [];
  if (!p || p.tiles <= 0) return out;
  const map = state.map;
  const { owner } = map;
  const w = map.width;
  const n = owner.length;
  const mk = nextMark(state);
  const gen = mk.gen;
  const m = mk.arr;
  const seed = (i: number): void => {
    if (i < 0 || owner[i] !== playerId || m[i] === gen) return;
    m[i] = gen;
    out.push(i);
  };
  const { list, len } = borderTiles(state, playerId);
  for (let k = 0; k < len; k++) seed(list[k]);
  if (p.capital >= 0) seed(p.capital);
  for (let h = 0; h < out.length; h++) {
    const i = out[h];
    const x = i % w;
    if (x > 0) seed(i - 1);
    if (x < w - 1) seed(i + 1);
    if (i >= w) seed(i - w);
    if (i < n - w) seed(i + w);
  }
  if (out.length < p.tiles) {
    // Islands without a land border away from the capital: full scan (rare: only tiny coastal specks).
    for (let i = 0; i < n && out.length < p.tiles; i++) seed(i);
  }
  return out;
}
/** After a capture from `victim`: a nation (tribe) below its collapse threshold falls to the attacker at once. */
function maybeCollapse(state: GameState, victim: number, taker: number): void {
  const vp = state.players[victim];
  if (!vp || !vp.alive || vp.tiles <= 0 || vp.tiles >= collapseThreshold(state, vp)) return;
  const name = vp.name;
  if (annexTiles(state, victim, taker) > 0) {
    addEvent(state, 'info', `${name} collapsed: ${state.players[taker].name} takes the rest of its land`, [victim, taker], state.players[taker].capital);
  }
}

// ---------- attacks ----------
function returnTroops(state: GameState, a: Attack): void {
  const p = state.players[a.attacker];
  if (p.alive) addTroops(p.troops, a.troops);
  clearTroops(a.troops);
}

/**
 * True if playerId can't reach the owner of `tile` by land on the tile's landmass: no tile of that owner on that
 * landmass touches playerId's land. Then a click there means a transport (applyAction 'attack' sends one).
 */
export function needsBoat(state: GameState, playerId: number, tile: number): boolean {
  const map = state.map;
  if (tile < 0 || tile >= map.owner.length || isWater(map.terrain[tile])) return false;
  const target = map.owner[tile];
  if (target === playerId) return false;
  const comp = landComponents(map)[tile];
  return findFront(state, playerId, target, comp, 1).length === 0;
}

/** A coastal tile of the clicked tile's owner on the same landmass, nearest to it (the transport's landing), or -1. */
export function boatLandingTile(state: GameState, tile: number): number {
  const map = state.map;
  if (tile < 0 || tile >= map.owner.length || isWater(map.terrain[tile])) return -1;
  if (map.coastal[tile]) return tile;
  const owner = map.owner[tile];
  const comps = landComponents(map);
  const comp = comps[tile];
  return nearestTile(map, tile, BOAT_LANDING_RADIUS, (i) => map.coastal[i] === 1 && map.owner[i] === owner && comps[i] === comp);
}

/**
 * Counter-attack: troops sent against a nation that is attacking us first cancel its attack, troop for troop by
 * power, fought where the fronts meet (each side's terrain, forts, matchups, supply). `sent` is reduced.
 */
function cancelCounter(state: GameState, playerId: number, target: number, sent: Troops): void {
  if (target <= 0) return;
  for (const c of state.attacks) {
    if (c.attacker !== target || c.target !== playerId || total(c.troops) <= 0) continue;
    const ta = total(sent);
    if (ta <= 0) return;
    const mine = findFront(state, playerId, target, 0, 1);
    const tileA = mine.length ? mine[0] : -1; // their land we push into
    const tileB = peekFront(state, c, getFront(state, c)); // our land they push into
    const pa = clashPowerPerUnit(state, playerId, sent, c.troops, tileA, target);
    const pb = clashPowerPerUnit(state, target, c.troops, sent, tileB, playerId);
    const powA = ta * pa;
    const powB = total(c.troops) * pb;
    const force: Attack = { id: -1, attacker: playerId, target, troops: sent, focusTile: -1, progress: 0, startTick: state.tick, amphibious: false, losses: 0, tilesTaken: 0 };
    if (powA >= powB) {
      applyAttackerLosses(state, force, pa > 0 ? powB / pa : ta, target, false);
      applyAttackerLosses(state, c, total(c.troops), playerId, false);
    } else {
      applyAttackerLosses(state, c, pb > 0 ? powA / pb : total(c.troops), playerId, false);
      applyAttackerLosses(state, force, ta, target, false);
    }
  }
}

/**
 * Starts an attack from playerId on the OWNER of `tile` (0 = wilderness) with these troops, which are removed
 * from the player's pool. The clicked tile only picks the target and is kept as a UI anchor (focusTile): the whole
 * shared border advances. Validates: land, not own, not allied, target borders the attacker (or amphibious),
 * troops >= MIN_ATTACK_TROOPS and available, attack count limit. If an attack on the same target is running, the
 * troops are merged into it. Troops sent against a nation that is attacking us first cancel its attack (counter-
 * attack). Attacking a nation cancels pending alliance requests between the two and stops their trade for a while.
 * Land across water: see needsBoat / applyAction (a click there sends a transport instead).
 *
 * Amphibious (units.ts, on a transport landing): `troops` come from the transport and are NOT taken from the
 * pool; no minimum, bordering or attack-count check. The landing tile is captured first, paid like any other tile
 * by the landed troops (if they can't pay, they are lost and the result is not ok); the front then grows from that
 * beachhead, which is a supply source for BEACHHEAD_SUPPLY_SECONDS. A landing on a tile the attacker already owns
 * just puts the troops back in the pool (ok). On any other failure (water, ally, dead target) the troops are
 * untouched and the caller decides what to do with them.
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
    if (areAllied(state, playerId, target)) return { ok: false, reason: sameTeam(state, playerId, target) ? 'You cannot attack a teammate' : 'You cannot attack an ally' };
    const peace = peaceReason(state, playerId, target);
    if (peace) return { ok: false, reason: peace };
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
    const c = fightCtx(state, playerId, sent, target);
    const cost = tileCost(state, c, tile);
    if (tot < cost.loss) {
      applyDefenderLosses(state, target, (cost.defenderLoss * tot) / cost.loss, playerId);
      applyAttackerLosses(state, force, tot, target, false);
      return { ok: false, reason: 'The landing was repelled' };
    }
    applyAttackerLosses(state, force, cost.loss, target);
    applyDefenderLosses(state, target, cost.defenderLoss, playerId);
    captureTile(state, force, tile, indexAttacks(state.attacks));
    if (target !== 0 && !tp.alive) {
      // The beachhead was their last tile.
      addTroops(p.troops, force.troops);
      return { ok: true };
    }
    // The beachhead supplies the invasion until a city or depot can take over.
    const sd = supplyOf(state);
    sd.beachheads.push({ player: playerId, tile, untilTick: state.tick + BEACHHEAD_SUPPLY_SECONDS * TICKS_PER_SECOND });
    sd.headVersion++;
    if (target !== 0) maybeCollapse(state, target, playerId);
    if (target !== 0 && !tp.alive) {
      addTroops(p.troops, force.troops);
      return { ok: true };
    }
  }

  let near: number[] = [];
  const known = existing ? fronts.get(existing) : undefined;
  if (amphibious) {
    // Only the beachhead's neighbours: the landing doesn't join a far-away land front at once.
    const w = map.width;
    const x = tile % w;
    for (const j of [x > 0 ? tile - 1 : -1, x < w - 1 ? tile + 1 : -1, tile - w, tile + w]) {
      if (j >= 0 && j < map.owner.length && isFrontTile(state, playerId, target, j)) near.push(j);
    }
  } else if (!known || known.queued.size === 0) {
    // A new attack (or a merge into one whose front is unknown): the whole shared border.
    near = findFront(state, playerId, target);
    if (near.length === 0 && !(known && known.size)) {
      return { ok: false, reason: target === 0 ? 'That land does not border yours' : `You do not border ${tp.name}` };
    }
  }
  // else: a merge into a running attack keeps its front.
  if (!amphibious) for (const k of TROOP_TYPES) p.troops[k] = Math.max(0, p.troops[k] - sent[k]);
  if (target !== 0) {
    onAttackStarted(state, playerId, target);
    // Hitting back at a nation that attacks us: its attack is cancelled troop for troop first.
    cancelCounter(state, playerId, target, force.troops);
    if (total(force.troops) < 1) {
      if (!existing) addEvent(state, 'info', `${p.name} stopped the attack of ${tp.name}`, [playerId, target], tile);
      return { ok: true };
    }
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
/** Calls the attack off early: troops go home minus RETREAT_LOSS (nothing lost in the wilderness). */
export function retreat(state: GameState, playerId: number, attackId: number): ActionResult {
  const idx = state.attacks.findIndex((a) => a.id === attackId && a.attacker === playerId);
  if (idx < 0) return { ok: false, reason: 'No such attack' };
  const a = state.attacks[idx];
  const p = state.players[playerId];
  const share = a.target === 0 ? 0 : RETREAT_LOSS;
  const lost = total(a.troops) * share;
  addTroops(p.troops, a.troops, 1 - share);
  p.stats.troopsLost += lost;
  a.losses += lost;
  clearTroops(a.troops);
  state.attacks.splice(idx, 1);
  fronts.delete(a);
  return { ok: true };
}

/**
 * Clash power per unit of force `t` (of attacker) pushing into `tile` against force `against`: like a tile
 * capture (terrain attack, matchup, artillery vs forts, supply, depots, combined arms) divided by the terrain
 * defence and fort multiplier the other side holds there. tile < 0 (no front): no terrain, no forts.
 */
function clashPowerPerUnit(state: GameState, attacker: number, t: Troops, against: Troops, tile: number, holder: number): number {
  const tot = total(t);
  if (tot <= 0) return 0;
  const p = state.players[attacker];
  if (tile < 0) {
    let sum = 0;
    for (const k of TROOP_TYPES) if (t[k] > 0) sum += (t[k] / tot) * typeAttack(state, p, k) * matchupVs(k, against);
    return sum * combinedArms(p, t, tot);
  }
  const fort = fortMultiplierAt(state, tile, holder);
  const ter = TERRAIN[state.map.terrain[tile] as TerrainId];
  return powerPerUnit(state, attacker, t, tile, against, fort) / (ter.defense * fort);
}

/**
 * A->B and B->A attacks still running at the same time (e.g. after a landing) cancel by power, fought where the
 * fronts meet: the weaker force is destroyed, the stronger loses the same power.
 */
function resolveCounterAttacks(state: GameState, idx: AttackIndex): void {
  for (const a of state.attacks) {
    if (a.target === 0 || total(a.troops) <= 0) continue;
    const back = idx.byTarget.get(a.attacker);
    if (!back) continue;
    for (const b of back) {
      if (b.attacker !== a.target || b.id <= a.id) continue;
      const ta = total(a.troops);
      const tb = total(b.troops);
      if (ta <= 0 || tb <= 0) continue;
      const tileA = peekFront(state, a, getFront(state, a)); // B's land A pushes into
      const tileB = peekFront(state, b, getFront(state, b)); // A's land B pushes into
      const pa = clashPowerPerUnit(state, a.attacker, a.troops, b.troops, tileA, b.attacker);
      const pb = clashPowerPerUnit(state, b.attacker, b.troops, a.troops, tileB, a.attacker);
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
function stepAttack(state: GameState, a: Attack, idx: AttackIndex): boolean {
  const players = state.players;
  if (!players[a.attacker].alive) return true;
  if (a.target !== 0 && (!players[a.target].alive || areAllied(state, a.attacker, a.target))) {
    returnTroops(state, a);
    return true;
  }
  if (total(a.troops) < 1) {
    returnTroops(state, a);
    return true;
  }
  const f = getFront(state, a);
  if (state.tick - f.purgeTick >= FRONT_PURGE_TICKS) purgeFront(state, a, f);
  let next = nextFrontTile(state, a, f);
  if (next < 0) {
    returnTroops(state, a); // nothing left to take
    return true;
  }
  // Odds and pace are judged once per tick for the whole front.
  let c = fightCtx(state, a.attacker, a.troops, a.target);
  const rate = frontRate(state, c);
  const len = Math.max(f.queued.size, FRONT_MIN_TILES);
  const budget = len * rate * TICK_SECONDS;
  a.progress = Math.min(a.progress + budget, budget * 2 + 5);
  // Losses are added up and applied in batches (every 32 tiles, before anything that could end the target, and at
  // the end of the tick): the same totals for a fraction of the work.
  let pool = total(a.troops);
  let spent = 0;
  let killed = 0;
  const target = a.target;
  const flush = (): void => {
    if (spent > 0) applyAttackerLosses(state, a, spent, target);
    if (killed > 0) applyDefenderLosses(state, target, killed, a.attacker);
    spent = 0;
    killed = 0;
    pool = total(a.troops);
  };
  let taken = 0;
  for (;;) {
    if (taken > 0) {
      next = nextFrontTile(state, a, f);
      if (next < 0) {
        flush();
        returnTroops(state, a);
        return true;
      }
    }
    if (taken >= MAX_TILES_PER_TICK) break;
    const cost = tileCost(state, c, next);
    if (a.progress < cost.budget) break;
    if (pool - spent < cost.loss) {
      // Can't pay for the next tile: the force is spent, taking a proportional share of defenders with it.
      killed += (cost.defenderLoss * (pool - spent)) / cost.loss;
      flush();
      applyAttackerLosses(state, a, total(a.troops), target, false);
      return true;
    }
    spent += cost.loss;
    killed += cost.defenderLoss;
    // Taking the target's last tiles can eliminate it (its troops go home with ours): settle the losses first.
    if (target !== 0 && players[target].tiles <= collapseThreshold(state, players[target]) + 1) flush();
    heapPop(f);
    captureTile(state, a, next, idx);
    a.progress -= cost.budget;
    taken++;
    if (target !== 0) {
      maybeCollapse(state, target, a.attacker);
      // Taking their last tile eliminates the target; eliminatePlayer already sent our troops home.
      if (!players[target].alive) return true;
      // Their home army and density shrink as we go: settle and refresh the odds every 32 tiles.
      if ((taken & 31) === 0) {
        flush();
        c = fightCtx(state, a.attacker, a.troops, target);
      }
    } else if ((taken & 63) === 0) flush();
    if (pool - spent < 1) {
      flush();
      returnTroops(state, a);
      return true;
    }
  }
  flush();
  return false;
}

/** One tick of every attack (capture tiles, losses, counter-attacks, end/return troops). */
export function updateAttacks(state: GameState): void {
  if (state.attacks.length === 0) return;
  const idx = indexAttacks(state.attacks);
  resolveCounterAttacks(state, idx);
  let done: Set<Attack> | null = null;
  // setOwner/elimination only zero troops while we iterate; the array itself is not replaced.
  for (const a of state.attacks) {
    if (stepAttack(state, a, idx)) (done ??= new Set()).add(a);
  }
  if (done) {
    for (const a of done) fronts.delete(a);
    state.attacks = state.attacks.filter((a) => !done!.has(a));
  }
}

export interface AttackEstimate {
  /** attacker units lost per tile taken (outnumbering already applied) */
  lossPerTile: number;
  /** tiles per second the whole front would take (front length x rate per front tile, this tile's terrain) */
  tilesPerSecond: number;
  /** tile defence: loss per tile before dividing by the attack power per unit */
  defensePerTile: number;
  /** attack strength / the defender's home army strength (> 1 = you outnumber them); 0 against neutral land */
  odds: number;
  /** "send more, lose less" multiplier on losses (OUTNUMBER_LOSS range; 1 against neutral land) */
  lossFactor: number;
  /** front length used for tilesPerSecond */
  frontTiles: number;
}

/**
 * For UI/AI: estimated troops lost per tile, tiles/s and odds if `troops` attacked the owner of `tile` now.
 * Returns null if the tile can't be attacked (water, own, allied or dead owner). Does not check bordering;
 * supply is judged at `tile`. The front length is `frontTiles` if given, else the running attack's front, else
 * the whole current shared border with that owner.
 */
export function estimateAttack(state: GameState, playerId: number, tile: number, troops: Troops, frontTiles?: number): AttackEstimate | null {
  const map = state.map;
  const p = state.players[playerId];
  if (!p || playerId === 0 || !p.alive) return null;
  if (!Number.isInteger(tile) || tile < 0 || tile >= map.owner.length || isWater(map.terrain[tile])) return null;
  const target = map.owner[tile];
  if (target === playerId) return null;
  if (target !== 0 && (!state.players[target].alive || areAllied(state, playerId, target) || atPeace(state, playerId, target))) return null;
  // With no troops given, judge a plain infantry force.
  const t = total(troops) > 0 ? troops : { infantry: 1, armor: 0, artillery: 0 };
  const c = fightCtx(state, playerId, t, target);
  const cost = tileCost(state, c, tile);
  let len = frontTiles;
  if (len === undefined || !(len >= 0)) {
    const running = state.attacks.find((a) => a.attacker === playerId && a.target === target && total(a.troops) > 0);
    len = running && fronts.has(running) ? frontLength(state, running) : findFront(state, playerId, target).length;
  }
  const lossPerTile = cost.loss;
  const defensePerTile = cost.defense;
  const budget = cost.budget;
  const rate = frontRate(state, c);
  const perSecond = (Math.max(len, FRONT_MIN_TILES) * rate) / budget;
  return { lossPerTile, tilesPerSecond: perSecond, defensePerTile, odds: c.odds, lossFactor: c.lossFactor, frontTiles: len };
}

/** True if any tile of `owner` (0 = neutral land) is 4-adjacent to a tile of playerId (from the border set). */
export function borders(state: GameState, playerId: number, owner: number): boolean {
  if (playerId === owner) return false;
  return findFront(state, playerId, owner, 0, 1).length > 0;
}
/** Tiles of `owner` (0 = neutral land) touching playerId: the whole shared border (from the border set). */
export function frontTiles(state: GameState, playerId: number, owner: number, limit = Infinity): number[] {
  if (playerId === owner) return [];
  return findFront(state, playerId, owner, 0, limit);
}
export function attacksOf(state: GameState, playerId: number): Attack[] {
  return state.attacks.filter((a) => a.attacker === playerId);
}
