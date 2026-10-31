// Troops (one pool), gold, iron, oil, science, upkeep, army mix conversion (DESIGN section 3).
//
// One troop pool per player (Player.troops at home: infantry, armor, artillery). It has a sublinear cap from land
// plus flat adds from cities, the capital and farms, and regrows toward the cap with
//   growth/s = (TROOP_GROWTH_BASE + TROOP_GROWTH_K x troops^0.73) x (1 - troops / cap)
// which peaks at about 42% of the cap: a full bar barely grows, so troops are meant to be spent. Factories and
// arsenals convert part of the pool into armor and artillery. Land weights come from territory.ts (kept up to date
// by setOwner), so nothing here scans the map.
import { goldRate, growthRate, resourceRate } from './rules';
import { airRaidIncomeMul } from './airwings';
import { cityLevels, countBuildings, buildingsOf, farmUnitsOf } from './buildings';
import { stockInterest, techCapMul, techGrowthMul, techIncomeMul } from './techtree';
import {
  AI_ECONOMY,
  AIRCRAFT_OIL_UPKEEP,
  ARMOR_OIL_UPKEEP,
  BARRACKS_GROWTH_BONUS,
  BARRACKS_MAX,
  BASE_SCIENCE,
  CAPITAL_TROOP_CAP,
  CITY_GOLD,
  CITY_TROOP_CAP,
  CONVERT_ARMY_SHARE,
  CONVERT_COST,
  CONVERT_RATE,
  DOCTRINE_PERKS,
  FARM_GROWTH_BONUS,
  FARM_MAX,
  FARM_TROOP_CAP,
  GOLD_BASE,
  GOLD_LAND,
  IRON_PER_MINE,
  MARKET_GOLD_BONUS,
  MARKET_MAX_BONUS,
  OIL_PER_WELL,
  SCIENCE_PER_LAB,
  TICK_SECONDS,
  TRIBE_CAP_FACTOR,
  TRIBE_GOLD_FACTOR,
  TRIBE_GROWTH_FACTOR,
  TROOP_CAP_BASE,
  TROOP_CAP_LAND,
  TROOP_CAP_LAND_EXP,
  TROOP_GROWTH_BASE,
  TROOP_GROWTH_EXP,
  TROOP_GROWTH_K,
} from './config';
import { doctrineLess, doctrineLever, doctrineMore, doctrinePerk, smallNationFactor } from './doctrines';
import { powDet } from './fmath';
import { hasTech } from './tech';
import { landWeight } from './territory';
import { isTribe } from './types';
import type { GameState, Player, Troops } from './types';

// Tech multipliers (DESIGN 6 / TECHS descriptions).
const AGRICULTURE_FARM_MULT = 1.5;
const MEDICINE_GROWTH_MULT = 1.2;
const BANKING_GOLD_MULT = 1.3;
const BANKING_MARKET_MULT = 1.25;
const METALLURGY_IRON_MULT = 1.5;
const METALLURGY_CONVERT_IRON = 0.75;
const INDUSTRIAL_RESOURCE_MULT = 1.25;
const INDUSTRIAL_CONVERT_MULT = 2;

export function armyTotal(t: Troops): number {
  return t.infantry + t.armor + t.artillery;
}
/** The troop pool at home (one pool: there are no workers). Kept under this name for the UI. */
export function population(p: Player): number {
  return armyTotal(p.troops);
}

/**
 * Land part of the cap and of gold: (land weight)^TROOP_CAP_LAND_EXP, deterministic pow. Land weight = sum over
 * owned land of pop/tile / 30 (territory.landWeight).
 */
export function landValue(weight: number): number {
  if (!(weight > 0)) return 0;
  return powDet(weight, TROOP_CAP_LAND_EXP);
}
/** Cap from land for a land weight: TROOP_CAP_LAND x landValue(weight). */
export function landPopValue(weight: number): number {
  return TROOP_CAP_LAND * landValue(weight);
}

/** Farms counted for the cap and growth (finished; a Fertile farm counts twice), at most FARM_MAX. */
function farmUnits(state: GameState, playerId: number): number {
  return Math.min(farmUnitsOf(state, playerId), FARM_MAX);
}

/**
 * Troop cap: TROOP_CAP_BASE + TROOP_CAP_LAND x landValue + city levels + capital + farms; tribes x TRIBE_CAP_FACTOR.
 * 0 for players without land.
 */
export function troopCap(state: GameState, playerId: number): number {
  const p = state.players[playerId];
  if (!p || playerId === 0 || p.tiles <= 0) return 0;
  const v =
    TROOP_CAP_BASE +
    landPopValue(landWeight(state, playerId)) +
    CITY_TROOP_CAP * cityLevels(state, playerId) +
    (p.capital >= 0 ? CAPITAL_TROOP_CAP : 0) +
    FARM_TROOP_CAP * farmUnits(state, playerId);
  return isTribe(p) ? v * TRIBE_CAP_FACTOR : v * aiEconomy(state, p).cap * techCapMul(p);
}
/** Old name of troopCap (Player.maxPop holds the cap). */
export function computeMaxPop(state: GameState, playerId: number): number {
  return troopCap(state, playerId);
}

/** Troop growth per second at `troops` home troops under `cap`, before bonuses (negative above the cap). */
export function baseGrowth(troops: number, cap: number): number {
  if (!(cap > 0)) return 0;
  const t = Math.max(0, troops);
  return (TROOP_GROWTH_BASE + TROOP_GROWTH_K * (t > 0 ? powDet(t, TROOP_GROWTH_EXP) : 0)) * (1 - t / cap);
}
/** Home troops at which growth peaks (about 42% of the cap). */
export function growthPeak(cap: number): number {
  return cap * (TROOP_GROWTH_EXP / (1 + TROOP_GROWTH_EXP));
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

/**
 * Difficulty multipliers of an AI player's economy (config AI_ECONOMY): 1 for humans; Easy / Normal slow only the AI
 * nations (tribes stay food), Hard's bonus goes to every AI player.
 */
export function aiEconomy(state: GameState, p: Player): { growth: number; income: number; cap: number } {
  if (p.isHuman) return NO_SCALE;
  const e = AI_ECONOMY[state.settings.difficulty] ?? NO_SCALE;
  if (isTribe(p) && (e.growth < 1 || e.income < 1)) return NO_SCALE;
  return e;
}
const NO_SCALE = { growth: 1, income: 1, cap: 1 } as const;

/**
 * Cost per converted unit (Metallurgy: -25% iron). With the game state, the Blitz doctrine makes armor cheaper
 * (without it, e.g. an old caller, the base price).
 */
export function convertCost(p: Player, kind: 'armor' | 'artillery', state?: GameState): { gold: number; iron: number } {
  const c = CONVERT_COST[kind];
  const doctrine = state && kind === 'armor' ? doctrineLess(state, p.id, 'armorConvertCost') : 1;
  return { gold: c.gold * doctrine, iron: c.iron * (hasTech(p, 'metallurgy') ? METALLURGY_CONVERT_IRON : 1) * doctrine };
}

/** Growth multiplier from farms, barracks, Medicine, tribes, the AI difficulty and the game's modifiers (positive growth only). */
export function growthBonus(state: GameState, p: Player): number {
  const farms = farmUnits(state, p.id) * (hasTech(p, 'agriculture') ? AGRICULTURE_FARM_MULT : 1);
  const barracks = Math.min(BARRACKS_MAX, countBuildings(state, p.id, 'barracks'));
  let m = 1 + farms * FARM_GROWTH_BONUS + barracks * BARRACKS_GROWTH_BONUS;
  if (hasTech(p, 'medicine')) m *= MEDICINE_GROWTH_MULT;
  m *= techGrowthMul(p);
  const small = doctrineLever(state, p.id, 'smallGrowth');
  if (small > 0) m *= 1 + small * smallNationFactor(state, p.id);
  if (isTribe(p)) m *= TRIBE_GROWTH_FACTOR;
  m *= aiEconomy(state, p).growth;
  return m * growthRate(state);
}

/**
 * Troop growth for one tick: new troops join as infantry; above the cap (land lost) the pool shrinks back to it,
 * every type in proportion. Returns the growth per second.
 */
function growTroops(state: GameState, p: Player, cap: number, dt: number): number {
  const t = p.troops;
  const home = armyTotal(t);
  const g = baseGrowth(home, cap);
  if (g > 0) {
    const add = Math.min(g * growthBonus(state, p) * dt, Math.max(0, cap - home));
    t.infantry += add;
    return add / dt;
  }
  if (g < 0 && home > cap) {
    const cut = Math.min(-g * dt, home - cap);
    const f = 1 - cut / home;
    t.infantry *= f;
    t.armor *= f;
    t.artillery *= f;
    return -cut / dt;
  }
  return 0;
}

/** Factories turn infantry into armor, arsenals into artillery, until the target mix is reached. */
function convertArmy(state: GameState, p: Player, dt: number): void {
  const army = armyTotal(p.troops);
  if (army <= 0) return;
  const factories = countBuildings(state, p.id, 'factory');
  const arsenals = countBuildings(state, p.id, 'arsenal');
  if (factories === 0 && arsenals === 0) return;
  const speed = hasTech(p, 'industrialization') ? INDUSTRIAL_CONVERT_MULT : 1;
  const costA = convertCost(p, 'armor', state);
  const costR = convertCost(p, 'artillery', state);
  // Wanted conversions this tick per kind, before resource limits.
  let infantryLeft = p.troops.infantry;
  let wantA = 0;
  let wantR = 0;
  if (factories > 0) {
    const need = p.armyMix.armor * army - p.troops.armor;
    if (need > 0) {
      const perBuilding = Math.max(CONVERT_RATE.armor, army * CONVERT_ARMY_SHARE);
      wantA = Math.max(0, Math.min(perBuilding * factories * speed * dt, need, infantryLeft));
      infantryLeft -= wantA;
    }
  }
  if (arsenals > 0) {
    const need = p.armyMix.artillery * army - p.troops.artillery;
    if (need > 0) {
      const perBuilding = Math.max(CONVERT_RATE.artillery, army * CONVERT_ARMY_SHARE);
      wantR = Math.max(0, Math.min(perBuilding * arsenals * speed * dt, need, infantryLeft));
    }
  }
  if (wantA <= 0 && wantR <= 0) return;
  // Factories and arsenals share gold and iron in proportion to what they want, so armor can't starve artillery.
  const goldNeed = wantA * costA.gold + wantR * costR.gold;
  const ironNeed = wantA * costA.iron + wantR * costR.iron;
  let scale = 1;
  if (goldNeed > p.gold) scale = Math.min(scale, p.gold / goldNeed);
  if (ironNeed > p.iron) scale = Math.min(scale, p.iron / ironNeed);
  const a = wantA * scale;
  const r = wantR * scale;
  if (a <= 0 && r <= 0) return;
  p.gold = Math.max(0, p.gold - a * costA.gold - r * costR.gold);
  p.iron = Math.max(0, p.iron - a * costA.iron - r * costR.iron);
  p.troops.infantry = Math.max(0, p.troops.infantry - a - r);
  p.troops.armor += a;
  p.troops.artillery += r;
}

/**
 * Gold per second: base + land + cities, x markets, Banking, the Merchant doctrine (gold, markets, level 3: more per
 * trade ship at sea); tribes x0.5; AI nations x the difficulty's income.
 */
export function goldIncome(state: GameState, p: Player): number {
  const banking = hasTech(p, 'banking');
  const marketScale = (banking ? BANKING_MARKET_MULT : 1) * doctrineMore(state, p.id, 'marketBonus');
  const marketBonus = Math.min(countBuildings(state, p.id, 'market') * MARKET_GOLD_BONUS, MARKET_MAX_BONUS) * marketScale;
  let gold = (GOLD_BASE + GOLD_LAND * landValue(landWeight(state, p.id)) + CITY_GOLD * cityLevels(state, p.id)) * (1 + marketBonus);
  if (banking) gold *= BANKING_GOLD_MULT;
  gold *= doctrineMore(state, p.id, 'gold');
  if (doctrinePerk(state, p.id, 'merchant')) gold *= 1 + DOCTRINE_PERKS.merchant.routeBonus * tradeRoutes(state, p.id);
  if (isTribe(p)) gold *= TRIBE_GOLD_FACTOR;
  gold *= aiEconomy(state, p).income * techIncomeMul(p);
  gold *= airRaidIncomeMul(state, p.id); // strategic bombing (airwings.ts)
  return gold * goldRate(state);
}
/** Own trade ships at sea (Merchant level 3: a bonus per route), at most DOCTRINE_PERKS.merchant.maxRoutes. */
function tradeRoutes(state: GameState, playerId: number): number {
  let n = 0;
  for (const u of state.units) if (u.type === 'tradeShip' && u.owner === playerId && u.hp > 0) n++;
  return Math.min(n, DOCTRINE_PERKS.merchant.maxRoutes);
}

/** Runs one tick of economy for every alive, spawned player; fills Player.maxPop (the troop cap) and Player.income. */
export function updateEconomy(state: GameState): void {
  const dt = TICK_SECONDS;
  const players = state.players;
  let flags = oilShort.get(state);
  if (!flags || flags.length !== players.length) {
    flags = new Uint8Array(players.length);
    oilShort.set(state, flags);
  }
  flags.fill(0);
  const deployed = state.attacks.length || state.units.length ? deployedArmor(state) : null;

  for (const p of players) {
    if (p.id === 0 || !p.alive || !p.spawned) continue;
    const cap = troopCap(state, p.id);
    p.maxPop = cap;
    const growth = growTroops(state, p, cap, dt);

    const aiIncome = aiEconomy(state, p).income;
    const industrial = hasTech(p, 'industrialization');
    // Stock Exchange: interest on the gold reserve (techtree.ts), part of the gold income.
    const baseGold = goldIncome(state, p);
    const gold = baseGold + stockInterest(p, baseGold);

    let iron = countBuildings(state, p.id, 'mine') * IRON_PER_MINE;
    if (hasTech(p, 'metallurgy')) iron *= METALLURGY_IRON_MULT;
    if (industrial) iron *= INDUSTRIAL_RESOURCE_MULT;
    iron *= aiIncome * resourceRate(state) * techIncomeMul(p);
    iron *= airRaidIncomeMul(state, p.id); // strategic bombing (airwings.ts)

    let oil = countBuildings(state, p.id, 'oilWell') * OIL_PER_WELL;
    if (industrial) oil *= INDUSTRIAL_RESOURCE_MULT;
    oil *= aiIncome * resourceRate(state) * techIncomeMul(p);

    const science = (BASE_SCIENCE + countBuildings(state, p.id, 'lab') * SCIENCE_PER_LAB) * resourceRate(state);

    // Oil upkeep: armor (home + deployed) and aircraft stored at own airfields.
    let aircraft = 0;
    if (countBuildings(state, p.id, 'airfield', true) > 0) for (const b of buildingsOf(state, p.id, 'airfield')) aircraft += b.fighters + b.bombers;
    const armor = p.troops.armor + (deployed ? deployed[p.id] : 0);
    const upkeep = armor * ARMOR_OIL_UPKEEP + aircraft * AIRCRAFT_OIL_UPKEEP;

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
    p.income.pop = growth;
  }
}
