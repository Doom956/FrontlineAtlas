// Economy, buildings and research tests (work package B).
import { describe, expect, it } from 'vitest';
import {
  buildCostAt,
  buildingCost,
  buildingVersion,
  build,
  buildingAt,
  buildingsOf,
  buildingSpacing,
  canBuild,
  countBuildings,
  countSites,
  demolish,
  destroyBuilding,
  fortMultiplierAt,
  hasIntel,
  resolveBuildTarget,
  supplySources,
  updateBuildings,
} from '../src/sim/buildings';
import type { BuildPlan } from '../src/sim/buildings';
import {
  AI_HARD_INCOME_BONUS,
  ARMOR_OIL_UPKEEP,
  BARRACKS_GROWTH_BONUS,
  BASE_SCIENCE,
  BUILDING_MIN_SPACING_BY_SIZE,
  BUILDINGS,
  CAPITAL_TROOP_CAP,
  CITY_GOLD,
  CITY_TROOP_CAP,
  CONVERT_COST,
  CONVERT_RATE,
  FARM_GROWTH_BONUS,
  FARM_TROOP_CAP,
  FORT_DEFENSE,
  FORT_DEFENSE_TECH,
  GOLD_BASE,
  GOLD_LAND,
  IRON_PER_MINE,
  MARKET_GOLD_BONUS,
  MARKET_MAX_BONUS,
  OIL_PER_WELL,
  SCIENCE_PER_LAB,
  TECHS,
  TICK_SECONDS,
  TICKS_PER_SECOND,
  TRIBE_CAP_FACTOR,
  TROOP_CAP_BASE,
  TROOP_CAP_LAND,
  TROOP_CAP_LAND_EXP,
  TROOP_GROWTH_BASE,
  TROOP_GROWTH_EXP,
  TROOP_GROWTH_K,
  WATCHTOWER_DEF,
} from '../src/sim/config';
import { formAlliance } from '../src/sim/diplomacy';
import { armyTotal, baseGrowth, computeMaxPop, goldIncome, growthPeak, hasOilShortage, landPopValue, landValue, population, troopCap, updateEconomy } from '../src/sim/economy';
import { onFalloutChange } from '../src/sim/territory';
import { computeCoastAndLand } from '../src/sim/mapgen';
import { tick } from '../src/sim/sim';
import { setOwner } from '../src/sim/state';
import { canResearch, startResearch, updateResearch } from '../src/sim/tech';
import { Resource, Terrain } from '../src/sim/types';
import type { Building, BuildingType, GameState } from '../src/sim/types';
import { claimRect, makeFlatGame, makeTestGame } from './helpers';

const W = 60;
const H = 40;
const idx = (x: number, y: number): number => y * W + x;

/** Places a finished building directly (no cost, no validation). */
function addBuilding(state: GameState, owner: number, tile: number, type: BuildingType, level = 1): Building {
  const id = state.nextId++;
  const b: Building = { id, type, owner, tile, level, buildLeft: 0, upgradeLeft: 0, fighters: 0, bombers: 0, cooldown: 0, dropCooldown: 0, disabledUntil: 0, hp: 1, queuedLevels: 0 };
  state.buildings.set(id, b);
  state.map.building[tile] = id + 1;
  return b;
}
/** Player 1 owns x 0..19, player 2 owns x 40..59 (all plains). */
function twoPlayers(): GameState {
  const s = makeFlatGame(W, H, 2, { human: true });
  claimRect(s, 1, 0, 0, 19, H - 1);
  claimRect(s, 2, 40, 0, W - 1, H - 1);
  return s;
}
/** Player 1's gold income per second (economy.goldIncome). */
function updateEconomyGold(state: GameState): number {
  return goldIncome(state, state.players[1]);
}
function runTicks(state: GameState, n: number, fn: (s: GameState) => void = updateEconomy): void {
  for (let i = 0; i < n; i++) {
    fn(state);
    state.tick++;
  }
}

describe('troop cap and growth (one pool)', () => {
  it('cap = base + land (sublinear) + capital + city levels + farms; mountains and fallout count less', () => {
    const s = twoPlayers();
    const land = 20 * H; // plains: weight 1 per tile
    const base = TROOP_CAP_BASE + landPopValue(land) + CAPITAL_TROOP_CAP;
    expect(troopCap(s, 1)).toBeCloseTo(base, 6);
    expect(computeMaxPop(s, 1)).toBe(troopCap(s, 1));
    addBuilding(s, 1, idx(3, 3), 'city', 3);
    expect(troopCap(s, 1)).toBeCloseTo(base + 3 * CITY_TROOP_CAP, 6);
    addBuilding(s, 1, idx(9, 3), 'farm');
    expect(troopCap(s, 1)).toBeCloseTo(base + 3 * CITY_TROOP_CAP + FARM_TROOP_CAP, 6);
    // Fallout on an owned tile: it stops counting.
    s.map.fallout[idx(5, 5)] = 60;
    onFalloutChange(s, idx(5, 5), true);
    expect(troopCap(s, 1)).toBeCloseTo(base - landPopValue(land) + landPopValue(land - 1) + 3 * CITY_TROOP_CAP + FARM_TROOP_CAP, 6);
    // A mountain tile is worth 5/30 of a plains tile.
    const m = makeFlatGame(W, H, 1);
    m.map.terrain[idx(6, 6)] = Terrain.Mountains;
    claimRect(m, 1, 0, 0, 19, H - 1);
    expect(troopCap(m, 1)).toBeCloseTo(TROOP_CAP_BASE + landPopValue(land - 1 + 5 / 30) + CAPITAL_TROOP_CAP, 6);
  });

  it('land value: TROOP_CAP_LAND x weight^TROOP_CAP_LAND_EXP, diminishing returns', () => {
    expect(landPopValue(0)).toBe(0);
    for (const v of [1, 50, 1000, 30000, 720000]) {
      expect(landPopValue(v) / (TROOP_CAP_LAND * Math.pow(v, TROOP_CAP_LAND_EXP))).toBeCloseTo(1, 9);
      expect(landValue(v)).toBeCloseTo(Math.pow(v, TROOP_CAP_LAND_EXP), 6);
    }
    // Each extra tile adds less: early land is worth a lot, a huge empire's last tiles little.
    expect(landPopValue(2000) - landPopValue(1000)).toBeGreaterThan(landPopValue(101000) - landPopValue(100000));
    // Grand-scale numbers: hundreds of thousands to millions.
    expect(TROOP_CAP_BASE + landPopValue(20000)).toBeGreaterThan(500000);
  });

  it('growth = (base + K x troops^0.73) x (1 - troops / cap), peaking near 42% of the cap', () => {
    const cap = 1e6;
    expect(baseGrowth(0, cap)).toBeCloseTo(TROOP_GROWTH_BASE, 9);
    expect(baseGrowth(200000, cap)).toBeCloseTo((TROOP_GROWTH_BASE + TROOP_GROWTH_K * Math.pow(200000, TROOP_GROWTH_EXP)) * 0.8, 3);
    expect(baseGrowth(cap, cap)).toBe(0);
    expect(baseGrowth(cap * 1.2, cap)).toBeLessThan(0);
    // The peak: holding a full bar wastes growth.
    const peak = growthPeak(cap);
    expect(peak / cap).toBeGreaterThan(0.4);
    expect(peak / cap).toBeLessThan(0.45);
    expect(baseGrowth(peak, cap)).toBeGreaterThan(baseGrowth(peak * 0.8, cap));
    expect(baseGrowth(peak, cap)).toBeGreaterThan(baseGrowth(peak * 1.2, cap));
    expect(baseGrowth(cap * 0.95, cap)).toBeLessThan(baseGrowth(peak, cap) * 0.25);
  });

  it('one tick of growth adds infantry by the formula, toward the cap and never past it', () => {
    const s = twoPlayers();
    const p = s.players[1];
    p.troops = { infantry: 30000, armor: 0, artillery: 0 };
    updateEconomy(s);
    const cap = p.maxPop;
    expect(cap).toBeCloseTo(troopCap(s, 1), 6);
    expect(p.troops.infantry - 30000).toBeCloseTo(baseGrowth(30000, cap) * TICK_SECONDS, 6);
    expect(p.income.pop).toBeCloseTo(baseGrowth(30000, cap), 6);
    let last = population(p);
    for (let i = 0; i < 3000; i++) {
      updateEconomy(s);
      s.tick++;
      expect(population(p)).toBeGreaterThanOrEqual(last - 1e-6);
      expect(population(p)).toBeLessThanOrEqual(p.maxPop + 1e-6);
      last = population(p);
    }
    expect(population(p)).toBeGreaterThan(p.maxPop * 0.9);
  });

  it('troops above the cap (land lost) shrink back to it, every type alike', () => {
    const s = twoPlayers();
    const p = s.players[1];
    const cap = troopCap(s, 1);
    p.troops = { infantry: cap, armor: cap * 0.5, artillery: 0 };
    updateEconomy(s);
    expect(armyTotal(p.troops)).toBeLessThan(cap * 1.5);
    expect(armyTotal(p.troops)).toBeGreaterThanOrEqual(cap - 1e-6);
    expect(p.troops.armor / p.troops.infantry).toBeCloseTo(0.5, 9);
    expect(p.income.pop).toBeLessThan(0);
  });

  it('tribes have a third of the cap and grow at half speed', () => {
    const s = twoPlayers();
    const full = troopCap(s, 1);
    s.players[1].personality = 'tribe';
    expect(troopCap(s, 1)).toBeCloseTo(full * TRIBE_CAP_FACTOR, 6);
    const t = twoPlayers();
    const a = t.players[1];
    const b = t.players[2];
    b.personality = 'tribe';
    a.troops = { infantry: 10000, armor: 0, artillery: 0 };
    b.troops = { infantry: 10000, armor: 0, artillery: 0 };
    updateEconomy(t);
    expect(b.income.pop).toBeLessThan(a.income.pop * 0.6);
  });

  it('farms (+4%, x2 on Fertile, Agriculture x1.5), barracks (+10%, up to 3) and Medicine speed growth', () => {
    const rate = (setup: (s: GameState) => void): number => {
      const s = twoPlayers();
      setup(s);
      const p = s.players[1];
      p.troops = { infantry: 20000, armor: 0, artillery: 0 };
      updateEconomy(s);
      return p.income.pop;
    };
    const base = rate(() => {});
    expect(rate((s) => addBuilding(s, 1, idx(5, 5), 'farm'))).toBeGreaterThan(base * (1 + FARM_GROWTH_BONUS) * 0.999);
    // A farm also raises the cap, which raises growth a little more: compare growth multipliers on the same cap.
    const withCap = (setup: (s: GameState) => void): number => {
      const s = twoPlayers();
      setup(s);
      const p = s.players[1];
      p.troops = { infantry: 20000, armor: 0, artillery: 0 };
      updateEconomy(s);
      return p.income.pop / baseGrowth(20000, p.maxPop);
    };
    expect(withCap((s) => addBuilding(s, 1, idx(5, 5), 'farm'))).toBeCloseTo(1 + FARM_GROWTH_BONUS, 9);
    expect(withCap((s) => { s.map.resource[idx(5, 5)] = Resource.Fertile; addBuilding(s, 1, idx(5, 5), 'farm'); })).toBeCloseTo(1 + 2 * FARM_GROWTH_BONUS, 9);
    expect(withCap((s) => { s.players[1].techs.push('agriculture'); addBuilding(s, 1, idx(5, 5), 'farm'); })).toBeCloseTo(1 + 1.5 * FARM_GROWTH_BONUS, 9);
    expect(withCap((s) => s.players[1].techs.push('medicine'))).toBeCloseTo(1.2, 9);
    expect(withCap((s) => { addBuilding(s, 1, idx(5, 5), 'farm').buildLeft = 2; })).toBeCloseTo(1, 9); // unfinished
    expect(withCap((s) => addBuilding(s, 1, idx(3, 3), 'barracks'))).toBeCloseTo(1 + BARRACKS_GROWTH_BONUS, 9);
    expect(withCap((s) => { for (let k = 0; k < 4; k++) addBuilding(s, 1, idx(3 + 6 * k, 3), 'barracks'); })).toBeCloseTo(1 + 3 * BARRACKS_GROWTH_BONUS, 9);
  });

  it('there are no workers and no army ratio: the whole pool is the army', () => {
    const s = twoPlayers();
    const p = s.players[1] as unknown as Record<string, unknown>;
    expect('workers' in p).toBe(false);
    expect('armyRatio' in p).toBe(false);
    expect(population(s.players[1])).toBe(armyTotal(s.players[1].troops));
  });
});

describe('income', () => {
  it('gold: base + land + cities, x markets (capped), Banking', () => {
    const s = twoPlayers();
    const p = s.players[1];
    const land = landValue(20 * H);
    const gold0 = p.gold;
    updateEconomy(s);
    expect(p.income.gold).toBeCloseTo(GOLD_BASE + GOLD_LAND * land, 6);
    expect(p.gold - gold0).toBeCloseTo(p.income.gold * TICK_SECONDS, 6);
    expect(p.stats.goldEarned).toBeCloseTo(p.income.gold * TICK_SECONDS, 6);

    addBuilding(s, 1, idx(2, 2), 'market');
    addBuilding(s, 1, idx(8, 2), 'market');
    addBuilding(s, 1, idx(14, 2), 'city', 2);
    updateEconomy(s);
    const raw = GOLD_BASE + GOLD_LAND * land + 2 * CITY_GOLD;
    expect(p.income.gold).toBeCloseTo(raw * (1 + 2 * MARKET_GOLD_BONUS), 6);

    for (let k = 0; k < 12; k++) addBuilding(s, 1, idx(2 + 6 * (k % 3), 10 + 6 * Math.floor(k / 3)), 'market');
    updateEconomy(s);
    expect(p.income.gold).toBeCloseTo(raw * (1 + MARKET_MAX_BONUS), 6);

    p.techs.push('banking');
    updateEconomy(s);
    expect(p.income.gold).toBeCloseTo(raw * (1 + MARKET_MAX_BONUS * 1.25) * 1.3, 6);
  });

  it('iron, oil, science; Metallurgy and Industrialization', () => {
    const s = twoPlayers();
    const p = s.players[1];
    addBuilding(s, 1, idx(2, 2), 'mine');
    addBuilding(s, 1, idx(6, 2), 'mine');
    addBuilding(s, 1, idx(10, 2), 'oilWell');
    addBuilding(s, 1, idx(14, 2), 'lab');
    updateEconomy(s);
    expect(p.income.iron).toBeCloseTo(2 * IRON_PER_MINE);
    expect(p.income.oil).toBeCloseTo(OIL_PER_WELL);
    expect(p.income.science).toBeCloseTo(BASE_SCIENCE + SCIENCE_PER_LAB);
    p.techs.push('metallurgy', 'industrialization');
    updateEconomy(s);
    expect(p.income.iron).toBeCloseTo(2 * IRON_PER_MINE * 1.5 * 1.25);
    expect(p.income.oil).toBeCloseTo(OIL_PER_WELL * 1.25);
  });

  it('hard AIs get an income bonus, humans do not', () => {
    const s = twoPlayers();
    s.settings.difficulty = 'hard';
    updateEconomy(s);
    expect(s.players[2].income.gold / s.players[1].income.gold).toBeCloseTo(1 + AI_HARD_INCOME_BONUS, 4);
  });

  it('armor and stored aircraft burn oil; running out sets the shortage flag', () => {
    const s = twoPlayers();
    const p = s.players[1];
    p.troops.armor = 1000;
    p.oil = 10;
    const af = addBuilding(s, 1, idx(5, 5), 'airfield');
    af.fighters = 2;
    updateEconomy(s);
    const upkeep = 1000 * ARMOR_OIL_UPKEEP + 2 * 0.02;
    expect(p.income.oil).toBeCloseTo(-upkeep);
    expect(p.oil).toBeCloseTo(10 - upkeep * TICK_SECONDS);
    expect(hasOilShortage(s, 1)).toBe(false);
    p.oil = 0.001;
    updateEconomy(s);
    expect(p.oil).toBe(0);
    expect(hasOilShortage(s, 1)).toBe(true);
    // Enough wells: no shortage even with an empty stock.
    addBuilding(s, 1, idx(10, 10), 'oilWell');
    updateEconomy(s);
    expect(hasOilShortage(s, 1)).toBe(false);
  });
});

describe('army mix conversion', () => {
  function withFactory(): GameState {
    const s = twoPlayers();
    const p = s.players[1];
    addBuilding(s, 1, idx(5, 5), 'factory');
    p.troops = { infantry: 10000, armor: 0, artillery: 0 };
    p.gold = 1e6;
    p.iron = 1e6;
    p.oil = 1e6;
    p.armyMix = { armor: 0.5, artillery: 0 };
    return s;
  }

  it('converts at CONVERT_RATE per factory, paying gold and iron', () => {
    const s = withFactory();
    const p = s.players[1];
    const gold = p.gold;
    const iron = p.iron;
    updateEconomy(s);
    const n = CONVERT_RATE.armor * TICK_SECONDS;
    expect(p.troops.armor).toBeCloseTo(n);
    expect(p.troops.infantry).toBeCloseTo(10000 + p.income.pop * TICK_SECONDS - n); // growth joins as infantry
    expect(p.iron).toBeCloseTo(iron - n * CONVERT_COST.armor.iron);
    // gold: paid per unit, earned income
    expect(gold + p.income.gold * TICK_SECONDS - p.gold).toBeCloseTo(n * CONVERT_COST.armor.gold);
  });

  it('Industrialization doubles the rate, Metallurgy cuts iron by 25%', () => {
    const s = withFactory();
    const p = s.players[1];
    p.techs.push('metallurgy', 'industrialization');
    const iron = p.iron;
    updateEconomy(s);
    const n = CONVERT_RATE.armor * 2 * TICK_SECONDS;
    expect(p.troops.armor).toBeCloseTo(n);
    expect(iron + p.income.iron * TICK_SECONDS - p.iron).toBeCloseTo(n * CONVERT_COST.armor.iron * 0.75);
  });

  it('stops at the target share and is limited by resources', () => {
    const s = withFactory();
    const p = s.players[1];
    runTicks(s, 3000);
    expect(p.troops.armor / armyTotal(p.troops)).toBeCloseTo(0.5, 3);
    expect(p.troops.infantry).toBeGreaterThan(0);

    const t = withFactory();
    const q = t.players[1];
    q.iron = CONVERT_COST.armor.iron * 2; // 2 armor worth of iron, no mines
    runTicks(t, 50);
    expect(q.troops.armor).toBeCloseTo(2, 5);
    expect(q.iron).toBeCloseTo(0, 6);
    expect(q.troops.infantry + q.troops.armor).toBeGreaterThan(10000);
  });

  it('never converts below 0 infantry; unfinished factories and arsenals do nothing', () => {
    const s = withFactory();
    const p = s.players[1];
    p.troops = { infantry: 1, armor: 10, artillery: 0 };
    p.armyMix = { armor: 0.9, artillery: 0 };
    updateEconomy(s);
    expect(p.troops.infantry).toBeGreaterThanOrEqual(0);
    const t = withFactory();
    t.players[1].armyMix = { armor: 0, artillery: 0.5 };
    addBuilding(t, 1, idx(10, 10), 'arsenal').buildLeft = 5;
    updateEconomy(t);
    expect(t.players[1].troops.artillery).toBe(0);
  });
});

describe('build rules', () => {
  /** resolveBuildTarget that must succeed. */
  const plan = (s: GameState, type: BuildingType, tile: number): BuildPlan => {
    const r = resolveBuildTarget(s, 1, type, tile);
    if ('error' in r) throw new Error(r.error);
    return r;
  };
  const d2 = (a: number, b: number): number => ((a % W) - (b % W)) ** 2 + (Math.floor(a / W) - Math.floor(b / W)) ** 2;

  it('validates owner, water, terrain, fallout, tech and money (snapping to the nearest valid own tile)', () => {
    const s = twoPlayers();
    const p = s.players[1];
    p.gold = 1e6;
    p.iron = 1e6;
    expect(canBuild(s, 1, 'market', idx(5, 5)).ok).toBe(true);
    expect(plan(s, 'market', idx(5, 5))).toMatchObject({ tile: idx(5, 5), upgrade: false, level: 1, buildingId: -1, affordable: true });
    expect(canBuild(s, 1, 'market', idx(45, 5)).reason).toMatch(/own territory/); // enemy land, no own land near
    expect(canBuild(s, 1, 'market', idx(30, 5)).ok).toBe(false); // neutral, 11 tiles from our land (snap radius 10)
    expect(plan(s, 'market', idx(28, 5)).tile).toBe(idx(19, 5)); // 9 tiles out: snaps onto our border
    s.map.terrain[idx(6, 6)] = Terrain.Mountains;
    const farm = plan(s, 'farm', idx(6, 6)); // no farms on mountains: the next tile
    expect(farm.tile).not.toBe(idx(6, 6));
    expect(d2(farm.tile, idx(6, 6))).toBe(1);
    expect(plan(s, 'market', idx(6, 6)).tile).toBe(idx(6, 6));
    for (let y = 0; y < H; y++) for (let x = 0; x < 20; x++) if (d2(idx(x, y), idx(10, 20)) <= 100) s.map.fallout[idx(x, y)] = 30;
    expect(canBuild(s, 1, 'market', idx(10, 20)).reason).toMatch(/irradiated/);
    expect(canBuild(s, 1, 'hospital', idx(15, 15)).reason).toMatch(/research: Medicine/);
    p.techs.push('medicine');
    expect(canBuild(s, 1, 'hospital', idx(15, 5)).ok).toBe(true);
    p.gold = 10;
    expect(canBuild(s, 1, 'market', idx(5, 5)).reason).toMatch(/gold/);
    const poor = plan(s, 'market', idx(5, 5));
    expect(poor.affordable).toBe(false);
    expect(poor.tile).toBe(idx(5, 5)); // the preview still shows where it would go
    p.gold = 1e6;
    p.iron = 0;
    expect(canBuild(s, 1, 'factory', idx(5, 5)).reason).toMatch(/iron/);
  });

  it('keeps buildings the map size spacing apart (small map: 10), cities too', () => {
    const s = twoPlayers();
    s.players[1].gold = 1e6;
    s.players[1].iron = 1e6;
    expect(buildingSpacing(s)).toBe(BUILDING_MIN_SPACING_BY_SIZE.small);
    addBuilding(s, 1, idx(10, 10), 'market');
    // Occupied / too close: the farm goes to the nearest tile 10 away (straight line; first by distance, then row).
    expect(plan(s, 'farm', idx(10, 10)).tile).toBe(idx(10, 0));
    expect(plan(s, 'farm', idx(13, 13)).tile).toBe(idx(18, 16)); // nearest tile >= 10 from the market (8, 6 away)
    expect(plan(s, 'farm', idx(10, 25)).tile).toBe(idx(10, 25)); // 15 away: fine
    addBuilding(s, 1, idx(5, 30), 'city');
    // A market can't squeeze next to the city either.
    expect(d2(plan(s, 'market', idx(6, 31)).tile, idx(5, 30))).toBeGreaterThanOrEqual(100);
    // No room at all within reach.
    const c = makeFlatGame(20, 20, 1, { human: true });
    claimRect(c, 1, 0, 0, 8, 8);
    c.players[1].gold = 1e6;
    addBuilding(c, 1, 4 * 20 + 4, 'market');
    const r = resolveBuildTarget(c, 1, 'farm', 2 * 20 + 2);
    expect('error' in r && r.error).toMatch(/No room here: buildings keep \d+ tiles apart/);
  });

  it('a build order near an own building of the same type upgrades it', () => {
    const s = twoPlayers();
    s.players[1].gold = 1e6;
    const city = addBuilding(s, 1, idx(5, 30), 'city');
    const up = plan(s, 'city', idx(6, 31));
    expect(up).toMatchObject({ tile: city.tile, upgrade: true, level: 2, buildingId: city.id });
    expect(plan(s, 'city', idx(5, 19)).upgrade).toBe(true); // 11 away: still within the upgrade radius (12)
    expect(plan(s, 'city', idx(5, 17))).toMatchObject({ tile: idx(5, 17), upgrade: false }); // 13 away: a new city
    const farm = addBuilding(s, 1, idx(10, 5), 'farm');
    farm.buildLeft = 2;
    expect(canBuild(s, 1, 'farm', idx(12, 6)).reason).toMatch(/under construction/);
    farm.buildLeft = 0;
    expect(plan(s, 'farm', idx(12, 6))).toMatchObject({ tile: farm.tile, upgrade: true });
    // Another type next to it is not an upgrade: it keeps its distance.
    expect(d2(plan(s, 'market', idx(12, 6)).tile, farm.tile)).toBeGreaterThanOrEqual(100);
  });

  it('mines and oil wells need an owned deposit within 2 tiles (the order snaps next to it)', () => {
    const s = twoPlayers();
    s.players[1].gold = 1e6;
    s.players[1].iron = 1e6;
    expect(canBuild(s, 1, 'mine', idx(5, 5)).reason).toMatch(/Iron deposit/);
    s.map.resource[idx(7, 7)] = Resource.Iron;
    expect(plan(s, 'mine', idx(5, 5)).tile).toBe(idx(5, 5));
    const m = plan(s, 'mine', idx(2, 5)); // 5 away: snaps to the nearest tile within 2 of the deposit
    expect(Math.max(Math.abs((m.tile % W) - 7), Math.abs(Math.floor(m.tile / W) - 7))).toBeLessThanOrEqual(2);
    expect(canBuild(s, 1, 'oilWell', idx(5, 5)).ok).toBe(false); // iron is not oil
    s.map.resource[idx(21, 5)] = Resource.Oil; // neutral deposit
    expect(canBuild(s, 1, 'oilWell', idx(19, 5)).ok).toBe(false);
    setOwner(s, idx(21, 5), 1);
    expect(canBuild(s, 1, 'oilWell', idx(19, 5)).ok).toBe(true);
  });

  it('ports need the coast', () => {
    const s = twoPlayers();
    s.players[1].gold = 1e6;
    for (let y = 0; y < H; y++) s.map.terrain[idx(0, y)] = Terrain.ShallowWater;
    computeCoastAndLand(s.map);
    expect(plan(s, 'port', idx(1, 5)).tile).toBe(idx(1, 5));
    expect(plan(s, 'port', idx(5, 5)).tile).toBe(idx(1, 5)); // snaps to the shore
    expect(plan(s, 'port', idx(0, 5)).tile).toBe(idx(1, 5)); // water: the nearest coastal tile
    expect(canBuild(s, 1, 'port', idx(15, 5)).reason).toMatch(/coast/); // 14 from the shore
  });

  it('build pays, costs grow per copy, finishes after buildTime with an event', () => {
    const s = twoPlayers();
    const p = s.players[1];
    p.gold = 10000;
    expect(buildingCost(s, 1, 'market').gold).toBe(500);
    expect(build(s, 1, 'market', idx(5, 5)).ok).toBe(true);
    expect(p.gold).toBe(9500);
    expect(buildingCost(s, 1, 'market').gold).toBe(Math.round(500 * 1.4)); // unfinished copy counts
    expect(countBuildings(s, 1, 'market')).toBe(0);
    expect(countBuildings(s, 1, 'market', true)).toBe(1);
    const ticks = Math.round(BUILDINGS.market.buildTime * TICKS_PER_SECOND);
    runTicks(s, ticks - 1, updateBuildings);
    expect(countBuildings(s, 1, 'market')).toBe(0);
    runTicks(s, 1, updateBuildings);
    expect(countBuildings(s, 1, 'market')).toBe(1);
    expect(s.events.some((e) => e.kind === 'buildingDone' && e.players.includes(1))).toBe(true);
    expect(p.stats.buildingsBuilt).toBe(1);
    expect(build(s, 1, 'port', idx(10, 10)).ok).toBe(false);
  });

  it('ports start with the trade timer', () => {
    const s = twoPlayers();
    s.players[1].gold = 1e4;
    for (let y = 0; y < H; y++) s.map.terrain[idx(0, y)] = Terrain.ShallowWater;
    computeCoastAndLand(s.map);
    expect(build(s, 1, 'port', idx(1, 5)).ok).toBe(true);
    expect(buildingAt(s, idx(1, 5))!.cooldown).toBeGreaterThan(0);
  });

  it('upgrades are priced like a new level, keep working, count as levels, and stop at the top level', () => {
    const s = twoPlayers();
    const p = s.players[1];
    p.gold = 1e6;
    const city = addBuilding(s, 1, idx(10, 10), 'city');
    // One level owned: base x (1 + costGrowth x 1), same as founding a second city.
    const upCost = Math.round(BUILDINGS.city.cost * (1 + BUILDINGS.city.costGrowth));
    expect(buildCostAt(s, 1, 'city', city.tile).gold).toBe(upCost);
    expect(buildingCost(s, 1, 'city').gold).toBe(upCost);
    const gold = p.gold;
    expect(build(s, 1, 'city', city.tile).ok).toBe(true);
    expect(p.gold).toBe(gold - upCost);
    expect(city.upgradeLeft).toBe(BUILDINGS.city.buildTime);
    expect(countBuildings(s, 1, 'city')).toBe(1);
    expect(countBuildings(s, 1, 'city', true)).toBe(2); // the running upgrade counts for the price
    expect(buildingCost(s, 1, 'city').gold).toBe(Math.round(BUILDINGS.city.cost * (1 + 2 * BUILDINGS.city.costGrowth)));
    expect(city.level).toBe(1);
    expect(computeMaxPop(s, 1)).toBeCloseTo(TROOP_CAP_BASE + landPopValue(20 * H) + CAPITAL_TROOP_CAP + CITY_TROOP_CAP, 6); // still working
    expect(canBuild(s, 1, 'city', city.tile).reason).toMatch(/being upgraded/);
    runTicks(s, BUILDINGS.city.buildTime * TICKS_PER_SECOND, updateBuildings);
    expect(city.level).toBe(2);
    expect(countBuildings(s, 1, 'city')).toBe(2);
    expect(countSites(s, 1, 'city', true)).toBe(1);
    expect(computeMaxPop(s, 1)).toBeCloseTo(TROOP_CAP_BASE + landPopValue(20 * H) + CAPITAL_TROOP_CAP + 2 * CITY_TROOP_CAP, 6);
    expect(s.events.some((e) => e.kind === 'buildingDone' && /level 2/.test(e.message))).toBe(true);
    // At the top level a new city goes elsewhere (spacing away), or nowhere when there is no room.
    city.level = BUILDINGS.city.maxLevel;
    const next = resolveBuildTarget(s, 1, 'city', city.tile) as BuildPlan;
    expect(next.upgrade).toBe(false);
    expect(d2(next.tile, city.tile)).toBeGreaterThanOrEqual(100);
    const c = makeFlatGame(20, 20, 1, { human: true });
    claimRect(c, 1, 0, 0, 8, 8);
    c.players[1].gold = 1e6;
    addBuilding(c, 1, 4 * 20 + 4, 'city', BUILDINGS.city.maxLevel);
    expect(canBuild(c, 1, 'city', 4 * 20 + 4).reason).toMatch(/highest level/);
    // Not on an enemy city
    const enemy = addBuilding(s, 2, idx(45, 10), 'city');
    expect(canBuild(s, 1, 'city', enemy.tile).ok).toBe(false);
  });

  it('every building type upgrades up to its own max level; effects scale with levels', () => {
    const s = twoPlayers();
    const p = s.players[1];
    p.gold = 1e9;
    p.iron = 1e9;
    const market = addBuilding(s, 1, idx(10, 10), 'market');
    const before = updateEconomyGold(s);
    for (let l = 2; l <= BUILDINGS.market.maxLevel; l++) {
      expect(build(s, 1, 'market', idx(11, 11)).ok).toBe(true);
      runTicks(s, BUILDINGS.market.buildTime * TICKS_PER_SECOND, updateBuildings);
      expect(market.level).toBe(l);
    }
    expect(countBuildings(s, 1, 'market')).toBe(BUILDINGS.market.maxLevel);
    expect(updateEconomyGold(s)).toBeCloseTo(before * (1 + MARKET_GOLD_BONUS * BUILDINGS.market.maxLevel) / (1 + MARKET_GOLD_BONUS), 6);
    // At the top: the next market goes to a new spot.
    expect(plan(s, 'market', idx(11, 11)).upgrade).toBe(false);
    expect(BUILDINGS.sam.maxLevel).toBe(3);
    expect(BUILDINGS.silo.maxLevel).toBe(3);
    expect(BUILDINGS.city.maxLevel).toBe(6);
  });

  it('demolish refunds part of the cost', () => {
    const s = twoPlayers();
    const p = s.players[1];
    addBuilding(s, 1, idx(5, 5), 'factory');
    const gold = p.gold;
    const iron = p.iron;
    expect(demolish(s, 1, idx(45, 5)).ok).toBe(false);
    expect(demolish(s, 1, idx(5, 5)).ok).toBe(true);
    expect(p.gold - gold).toBeCloseTo(900 * 0.25);
    expect(p.iron - iron).toBeCloseTo(60 * 0.25);
    expect(buildingAt(s, idx(5, 5))).toBeUndefined();
    expect(countBuildings(s, 1, 'factory', true)).toBe(0);
  });
});

describe('building lookups', () => {
  it('fort multiplier: radius, unfinished, Fortification, watchtower', () => {
    const s = twoPlayers();
    const fort = addBuilding(s, 1, idx(2, 5), 'fort');
    expect(fortMultiplierAt(s, idx(2, 25), 1)).toBe(FORT_DEFENSE); // 20 away
    expect(fortMultiplierAt(s, idx(2, 26), 1)).toBe(1);
    expect(fortMultiplierAt(s, idx(2, 25), 2)).toBe(1); // not theirs
    s.players[1].techs.push('fortification');
    expect(fortMultiplierAt(s, idx(2, 33), 1)).toBe(FORT_DEFENSE_TECH); // radius 28
    fort.buildLeft = 1;
    expect(fortMultiplierAt(s, idx(2, 5), 1)).toBe(1);
    fort.buildLeft = 0;
    addBuilding(s, 1, idx(2, 20), 'watchtower');
    expect(fortMultiplierAt(s, idx(2, 30), 1)).toBeCloseTo(FORT_DEFENSE_TECH * WATCHTOWER_DEF); // 10 from the tower
    expect(fortMultiplierAt(s, idx(17, 39), 1)).toBe(1);
  });

  it('counts follow captures (next tick) and destruction (at once)', () => {
    const s = twoPlayers();
    const m = addBuilding(s, 1, idx(19, 5), 'market');
    expect(countBuildings(s, 1, 'market')).toBe(1);
    setOwner(s, idx(19, 5), 2); // captured
    expect(countBuildings(s, 1, 'market')).toBe(0);
    s.tick++;
    expect(countBuildings(s, 2, 'market')).toBe(1);
    expect(buildingsOf(s, 2).map((b) => b.id)).toEqual([m.id]);
    const v = buildingVersion(s);
    destroyBuilding(s, m);
    expect(buildingVersion(s)).not.toBe(v);
    expect(countBuildings(s, 2, 'market')).toBe(0);
  });

  it('intel: self, allies, watchtower range over territory', () => {
    const s = twoPlayers();
    expect(hasIntel(s, 1, 1)).toBe(true);
    expect(hasIntel(s, 1, 2)).toBe(false);
    const tower = addBuilding(s, 1, idx(0, 0), 'watchtower');
    // Player 2's land starts 40 tiles right of the tower.
    expect(hasIntel(s, 1, 2)).toBe(true);
    s.map.building[tower.tile] = 0;
    s.buildings.delete(tower.id);
    s.tick++;
    expect(hasIntel(s, 1, 2)).toBe(false);
    const far = makeFlatGame(300, 40, 2);
    claimRect(far, 1, 0, 0, 9, 39);
    claimRect(far, 2, 250, 0, 299, 39);
    addBuilding(far, 1, 5 + 20 * 300, 'watchtower');
    expect(hasIntel(far, 1, 2)).toBe(false); // 245 away, radius 80
    far.players[1].techs.push('radar'); // radius 160
    expect(hasIntel(far, 1, 2)).toBe(false);
    for (let x = 160; x < 250; x++) setOwner(far, 20 * 300 + x, 2); // player 2 reaches out to 155 away
    expect(hasIntel(far, 1, 2)).toBe(true);
    for (let x = 160; x < 250; x++) setOwner(far, 20 * 300 + x, 0);
    formAlliance(far, 1, 2);
    expect(hasIntel(far, 1, 2)).toBe(true);
  });

  it('supply sources: capital, finished cities and depots', () => {
    const s = twoPlayers();
    const c = addBuilding(s, 1, idx(3, 3), 'city');
    addBuilding(s, 1, idx(10, 3), 'supplyDepot');
    addBuilding(s, 1, idx(15, 3), 'supplyDepot').buildLeft = 2;
    addBuilding(s, 1, idx(3, 10), 'market');
    expect(supplySources(s, 1).sort((a, b) => a - b)).toEqual([c.tile, idx(10, 3), s.players[1].capital].sort((a, b) => a - b));
  });
});

describe('research', () => {
  it('checks prerequisites, gold, duplicates', () => {
    const s = twoPlayers();
    const p = s.players[1];
    p.gold = 10000;
    expect(canResearch(s, 1, 'banking').ok).toBe(false);
    expect(canResearch(s, 1, 'agriculture').ok).toBe(true);
    p.techs.push('agriculture');
    expect(canResearch(s, 1, 'agriculture').ok).toBe(false);
    expect(canResearch(s, 1, 'banking').ok).toBe(true);
    expect(canResearch(s, 1, 'combinedArms').reason).toMatch(/Mechanization and Ballistics/);
    p.gold = 10;
    expect(canResearch(s, 1, 'banking').reason).toMatch(/gold/);
  });

  it('runs from science income to completion with an event; switching discards progress', () => {
    const s = twoPlayers();
    const p = s.players[1];
    p.gold = 10000;
    expect(startResearch(s, 1, 'logistics').ok).toBe(true);
    expect(p.gold).toBe(10000 - TECHS.logistics.gold);
    expect(startResearch(s, 1, 'logistics').ok).toBe(false);
    p.income.science = 10;
    runTicks(s, 30, updateResearch);
    expect(p.researchProgress).toBeCloseTo(30);
    expect(startResearch(s, 1, 'metallurgy').ok).toBe(true);
    expect(p.researchProgress).toBe(0);
    const ticksNeeded = TECHS.metallurgy.science; // 10 science/s = 1 per tick
    runTicks(s, ticksNeeded - 1, updateResearch);
    expect(p.techs).not.toContain('metallurgy');
    runTicks(s, 1, updateResearch);
    expect(p.techs).toContain('metallurgy');
    expect(p.researching).toBeNull();
    expect(s.events.some((e) => e.kind === 'researchDone' && e.players.includes(1))).toBe(true);
  });

  it('banks science while idle and spends it first', () => {
    const s = twoPlayers();
    const p = s.players[1];
    p.gold = 10000;
    p.income.science = 10;
    const need = TECHS.fortification.science;
    runTicks(s, need + 40, updateResearch); // need + 40 science banked
    expect(p.science).toBeCloseTo(need + 40);
    startResearch(s, 1, 'fortification');
    expect(p.researchProgress).toBeCloseTo(need);
    expect(p.science).toBeCloseTo(40);
    runTicks(s, 1, updateResearch);
    expect(p.techs).toContain('fortification');
    expect(p.science).toBeCloseTo(41);
  });

  it('works through applyAction-driven ticks on a generated map', () => {
    const s = makeTestGame();
    const p = s.players[1];
    p.gold = 5000;
    // Bank most of the science so the run stays short (the AIs would otherwise have minutes to overrun player 1).
    p.science = TECHS.agriculture.science - 10 * BASE_SCIENCE;
    expect(startResearch(s, 1, 'agriculture').ok).toBe(true);
    for (let i = 0; i < 11 * TICKS_PER_SECOND; i++) tick(s);
    expect(p.alive).toBe(true);
    expect(p.techs).toContain('agriculture');
    for (const q of s.players) {
      if (q.id === 0 || !q.alive) continue;
      expect(q.maxPop).toBeGreaterThan(0);
      expect(population(q)).toBeLessThanOrEqual(q.maxPop + 1);
      expect(q.gold).toBeGreaterThan(0);
    }
  });
});
