// Population, gold, iron, oil, science, upkeep, army ratio, army mix conversion.
import { cityLevels, countBuildings, buildingsOf } from './buildings';
import {
  AI_HARD_INCOME_BONUS,
  AIRCRAFT_OIL_UPKEEP,
  ARMOR_OIL_UPKEEP,
  BARRACKS_GROWTH_BONUS,
  BARRACKS_MAX,
  BASE_SCIENCE,
  CAPITAL_POP,
  CITY_GOLD,
  CITY_POP,
  CONVERT_COST,
  CONVERT_RATE,
  DEMOBILISE_RATE,
  FARM_GROWTH,
  GOLD_PER_WORKER,
  IRON_PER_MINE,
  MARKET_GOLD_BONUS,
  MARKET_MAX_BONUS,
  MIN_GROWTH,
  OIL_PER_WELL,
  POP_GROWTH,
  SCIENCE_PER_LAB,
  TERRAIN,
  TICK_SECONDS,
} from './config';
import { hasTech } from './tech';
import { isWater, Resource } from './types';
import type { GameState, Player, Troops } from './types';

// Tech multipliers (DESIGN 6 / TECHS descriptions).
const AGRICULTURE_FARM_MULT = 1.5;
const FERTILE_FARM_MULT = 2;
const MEDICINE_GROWTH_MULT = 1.2;
const BANKING_GOLD_MULT = 1.3;
const BANKING_MARKET_MULT = 1.5;
const METALLURGY_IRON_MULT = 1.5;
const METALLURGY_CONVERT_IRON = 0.75;
const INDUSTRIAL_RESOURCE_MULT = 1.25;
const INDUSTRIAL_CONVERT_MULT = 2;
/** Population above max decays toward it: this share of the excess per second, taken from workers. */
const OVERPOP_DECAY = POP_GROWTH;

export function armyTotal(t: Troops): number {
  return t.infantry + t.armor + t.artillery;
}
export function population(p: Player): number {
  return p.workers + armyTotal(p.troops);
}

// ---------------------------------------------------------------------------------------------------------------
// Territory scan: one pass over the whole map for all players, refreshed every SCAN_INTERVAL_TICKS.
// Gives each player's land population capacity (pop/tile, fallout excluded), the tile count at scan time
// and a coarse map of which TERRITORY_BLOCK x TERRITORY_BLOCK blocks they own tiles in (used for intel).
// ---------------------------------------------------------------------------------------------------------------

export const TERRITORY_BLOCK = 8;
const SCAN_INTERVAL_TICKS = 10;

export interface TerritoryScan {
  tick: number;
  /** land pop capacity per player id at scan time */
  landPop: Float64Array;
  /** owned tiles per player id at scan time */
  tiles: Int32Array;
  /** true if `playerId` owned a tile in some block whose nearest point is within r of `tile` */
  ownsBlockInRange(playerId: number, tile: number, r: number): boolean;
}
interface ScanData extends TerritoryScan {
  width: number;
  height: number;
  playerCount: number;
}
const scans = new WeakMap<GameState, ScanData>();

function runScan(state: GameState): ScanData {
  const map = state.map;
  const w = map.width;
  const h = map.height;
  const n = w * h;
  const pc = state.players.length;
  const bw = Math.ceil(w / TERRITORY_BLOCK);
  const bh = Math.ceil(h / TERRITORY_BLOCK);
  const nb = bw * bh;
  const landPop = new Float64Array(pc);
  const tiles = new Int32Array(pc);
  const blocks = new Uint8Array(pc * nb);
  const popOf = new Float64Array(9);
  for (let t = 0; t < 9; t++) popOf[t] = TERRAIN[t as keyof typeof TERRAIN].popPerTile;
  const { owner, terrain, fallout } = map;
  for (let i = 0; i < n; i++) {
    const o = owner[i];
    if (o === 0 || o >= pc) continue;
    tiles[o]++;
    const t = terrain[i];
    if (!isWater(t) && fallout[i] <= 0) landPop[o] += popOf[t];
    const x = i % w;
    const y = (i - x) / w;
    blocks[o * nb + ((y / TERRITORY_BLOCK) | 0) * bw + ((x / TERRITORY_BLOCK) | 0)] = 1;
  }
  const ownsBlockInRange = (playerId: number, tile: number, r: number): boolean => {
    if (playerId <= 0 || playerId >= pc || tiles[playerId] === 0) return false;
    const cx = tile % w;
    const cy = (tile / w) | 0;
    const r2 = r * r;
    const bx0 = Math.max(0, Math.floor((cx - r) / TERRITORY_BLOCK));
    const bx1 = Math.min(bw - 1, Math.floor((cx + r) / TERRITORY_BLOCK));
    const by0 = Math.max(0, Math.floor((cy - r) / TERRITORY_BLOCK));
    const by1 = Math.min(bh - 1, Math.floor((cy + r) / TERRITORY_BLOCK));
    const base = playerId * nb;
    for (let by = by0; by <= by1; by++) {
      // Nearest point of the block row to the centre.
      const y0 = by * TERRITORY_BLOCK;
      const dy = cy < y0 ? y0 - cy : cy > y0 + TERRITORY_BLOCK - 1 ? cy - (y0 + TERRITORY_BLOCK - 1) : 0;
      for (let bx = bx0; bx <= bx1; bx++) {
        if (!blocks[base + by * bw + bx]) continue;
        const x0 = bx * TERRITORY_BLOCK;
        const dx = cx < x0 ? x0 - cx : cx > x0 + TERRITORY_BLOCK - 1 ? cx - (x0 + TERRITORY_BLOCK - 1) : 0;
        if (dx * dx + dy * dy <= r2) return true;
      }
    }
    return false;
  };
  const data: ScanData = { tick: state.tick, landPop, tiles, ownsBlockInRange, width: w, height: h, playerCount: pc };
  scans.set(state, data);
  return data;
}

/** The latest territory scan, rescanned when older than SCAN_INTERVAL_TICKS (or `force` and not from this tick). */
export function getTerritoryScan(state: GameState, force = false): TerritoryScan {
  const s = scans.get(state);
  const fresh =
    s &&
    s.width === state.map.width &&
    s.height === state.map.height &&
    s.playerCount === state.players.length &&
    state.tick >= s.tick &&
    state.tick - s.tick < SCAN_INTERVAL_TICKS &&
    !(force && s.tick !== state.tick);
  return fresh ? s : runScan(state);
}
/** Drops the territory scan so the next lookup rescans (e.g. after a big scripted map change). */
export function invalidateTerritoryScan(state: GameState): void {
  scans.delete(state);
}

/** Land pop capacity: the last scan, scaled by how the tile count changed since (exact right after a scan). */
function landPopOf(state: GameState, p: Player): number {
  let scan = getTerritoryScan(state);
  if (scan.tiles[p.id] === 0 && p.tiles > 0) scan = getTerritoryScan(state, true); // gained first land since the scan
  const t = scan.tiles[p.id];
  return t > 0 ? (scan.landPop[p.id] * p.tiles) / t : 0;
}

/** Max population from land (minus fallout tiles), city levels, capital. */
export function computeMaxPop(state: GameState, playerId: number): number {
  const p = state.players[playerId];
  if (!p || playerId === 0 || p.tiles <= 0) return 0;
  return landPopOf(state, p) + CITY_POP * cityLevels(state, playerId) + (p.capital >= 0 ? CAPITAL_POP : 0);
}

// ---------------------------------------------------------------------------------------------------------------
// Oil shortage flags (read by combat: armor fights at NO_OIL_ARMOR_FACTOR)
// ---------------------------------------------------------------------------------------------------------------

const oilShort = new WeakMap<GameState, Uint8Array>();

/** True when the player's oil ran out this tick and upkeep exceeds production. */
export function hasOilShortage(state: GameState, playerId: number): boolean {
  const f = oilShort.get(state);
  return !!f && f[playerId] === 1;
}

/** Armor in each player's attacks and transports (burns oil like armor at home). */
function deployedArmor(state: GameState): Float64Array {
  const out = new Float64Array(state.players.length);
  for (const a of state.attacks) if (a.attacker < out.length) out[a.attacker] += a.troops.armor;
  for (const u of state.units) if (u.owner < out.length && u.troops) out[u.owner] += u.troops.armor;
  return out;
}

function isHardAI(state: GameState, p: Player): boolean {
  return !p.isHuman && state.settings.difficulty === 'hard';
}

/** Iron cost per converted unit (Metallurgy -25%). */
export function convertCost(p: Player, kind: 'armor' | 'artillery'): { gold: number; iron: number } {
  const c = CONVERT_COST[kind];
  return { gold: c.gold, iron: c.iron * (hasTech(p, 'metallurgy') ? METALLURGY_CONVERT_IRON : 1) };
}

/** Population growth: logistic + farms, Medicine; split between infantry (barracks bonus) and workers. */
function growPopulation(state: GameState, p: Player, maxPop: number, dt: number): number {
  const pop = population(p);
  const before = pop;
  if (maxPop > 0 && pop < maxPop) {
    let farms = 0;
    for (const b of buildingsOf(state, p.id, 'farm')) {
      if (b.buildLeft > 0) continue;
      farms += state.map.resource[b.tile] === Resource.Fertile ? FERTILE_FARM_MULT : 1;
    }
    let g = POP_GROWTH * pop * (1 - pop / maxPop) + farms * FARM_GROWTH * (hasTech(p, 'agriculture') ? AGRICULTURE_FARM_MULT : 1);
    if (hasTech(p, 'medicine')) g *= MEDICINE_GROWTH_MULT;
    const room = maxPop - pop;
    const add = Math.min(Math.max(g, MIN_GROWTH) * dt, room);
    // New people become infantry until the army reaches its target share, the rest become workers.
    const army = armyTotal(p.troops);
    let inf = Math.min(add, Math.max(0, p.armyRatio * (pop + add) - army));
    let wrk = add - inf;
    inf *= 1 + BARRACKS_GROWTH_BONUS * Math.min(BARRACKS_MAX, countBuildings(state, p.id, 'barracks'));
    // The barracks bonus can't push past max pop: trim workers first, then infantry.
    const over = inf + wrk - room;
    if (over > 0) {
      const cut = Math.min(wrk, over);
      wrk -= cut;
      inf -= over - cut;
    }
    p.troops.infantry += inf;
    p.workers += wrk;
  } else if (pop > maxPop) {
    // Lost land: excess workers drift away.
    p.workers = Math.max(0, p.workers - Math.min(p.workers, (pop - maxPop) * OVERPOP_DECAY * dt));
  }
  // Army above the target share slowly demobilises (infantry only).
  const popNow = population(p);
  const excess = armyTotal(p.troops) - p.armyRatio * popNow;
  if (excess > 0 && p.troops.infantry > 0) {
    const d = Math.min(p.troops.infantry, excess * DEMOBILISE_RATE * dt);
    p.troops.infantry -= d;
    p.workers += d;
  }
  return (population(p) - before) / dt;
}

/** Factories turn infantry into armor, arsenals into artillery, until the target mix is reached. */
function convertArmy(state: GameState, p: Player, dt: number): void {
  const speed = hasTech(p, 'industrialization') ? INDUSTRIAL_CONVERT_MULT : 1;
  const army = armyTotal(p.troops);
  if (army <= 0) return;
  // Wanted conversions this tick per kind, before resource limits.
  const kinds = ['armor', 'artillery'] as const;
  const want = [0, 0];
  const costs = kinds.map((k) => convertCost(p, k));
  let infantryLeft = p.troops.infantry;
  kinds.forEach((kind, k) => {
    const count = countBuildings(state, p.id, kind === 'armor' ? 'factory' : 'arsenal');
    if (count === 0) return;
    const need = p.armyMix[kind] * army - p.troops[kind];
    if (need <= 0) return;
    want[k] = Math.max(0, Math.min(CONVERT_RATE[kind] * count * speed * dt, need, infantryLeft));
    infantryLeft -= want[k];
  });
  // Factories and arsenals share gold and iron in proportion to what they want, so armor can't starve artillery.
  const goldNeed = want[0] * costs[0].gold + want[1] * costs[1].gold;
  const ironNeed = want[0] * costs[0].iron + want[1] * costs[1].iron;
  let scale = 1;
  if (goldNeed > p.gold) scale = Math.min(scale, p.gold / goldNeed);
  if (ironNeed > p.iron) scale = Math.min(scale, p.iron / ironNeed);
  kinds.forEach((kind, k) => {
    const n = want[k] * scale;
    if (n <= 0) return;
    p.gold = Math.max(0, p.gold - n * costs[k].gold);
    p.iron = Math.max(0, p.iron - n * costs[k].iron);
    p.troops.infantry = Math.max(0, p.troops.infantry - n);
    p.troops[kind] += n;
  });
}

/** Runs one tick of economy for every alive, spawned player; fills Player.maxPop and Player.income. */
export function updateEconomy(state: GameState): void {
  const dt = TICK_SECONDS;
  const players = state.players;
  let flags = oilShort.get(state);
  if (!flags || flags.length !== players.length) {
    flags = new Uint8Array(players.length);
    oilShort.set(state, flags);
  }
  flags.fill(0);
  const deployed = deployedArmor(state);

  for (const p of players) {
    if (p.id === 0 || !p.alive || !p.spawned) continue;
    const maxPop = computeMaxPop(state, p.id);
    p.maxPop = maxPop;
    const popRate = growPopulation(state, p, maxPop, dt);

    const hard = isHardAI(state, p) ? 1 + AI_HARD_INCOME_BONUS : 1;
    const banking = hasTech(p, 'banking');
    const industrial = hasTech(p, 'industrialization');

    // Gold: workers x (1 + market bonus) + city levels; Banking on the total.
    const marketScale = banking ? BANKING_MARKET_MULT : 1;
    const marketBonus = Math.min(countBuildings(state, p.id, 'market') * MARKET_GOLD_BONUS, MARKET_MAX_BONUS) * marketScale;
    let gold = p.workers * GOLD_PER_WORKER * (1 + marketBonus) + CITY_GOLD * cityLevels(state, p.id);
    if (banking) gold *= BANKING_GOLD_MULT;
    gold *= hard;

    let iron = countBuildings(state, p.id, 'mine') * IRON_PER_MINE;
    if (hasTech(p, 'metallurgy')) iron *= METALLURGY_IRON_MULT;
    if (industrial) iron *= INDUSTRIAL_RESOURCE_MULT;
    iron *= hard;

    let oil = countBuildings(state, p.id, 'oilWell') * OIL_PER_WELL;
    if (industrial) oil *= INDUSTRIAL_RESOURCE_MULT;
    oil *= hard;

    const science = BASE_SCIENCE + countBuildings(state, p.id, 'lab') * SCIENCE_PER_LAB;

    // Oil upkeep: armor (home + deployed) and aircraft stored at own airfields.
    let aircraft = 0;
    for (const b of buildingsOf(state, p.id, 'airfield')) aircraft += b.fighters + b.bombers;
    const upkeep = (p.troops.armor + deployed[p.id]) * ARMOR_OIL_UPKEEP + aircraft * AIRCRAFT_OIL_UPKEEP;

    p.gold += gold * dt;
    p.iron += iron * dt;
    p.oil += (oil - upkeep) * dt;
    if (p.oil <= 0) {
      p.oil = 0;
      if (upkeep > oil) flags[p.id] = 1;
    }
    p.stats.goldEarned += gold * dt;

    convertArmy(state, p, dt);

    p.income.gold = gold;
    p.income.iron = iron;
    p.income.oil = oil - upkeep;
    p.income.science = science;
    p.income.pop = popRate;
  }
}
