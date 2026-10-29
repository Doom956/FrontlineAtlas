// Economy, buildings and research tests (work package B).
import { describe, expect, it } from 'vitest';
import {
  buildCostAt,
  buildingCost,
  buildingVersion,
  build,
  buildingAt,
  buildingsOf,
  canBuild,
  countBuildings,
  demolish,
  destroyBuilding,
  fortMultiplierAt,
  hasIntel,
  supplySources,
  updateBuildings,
} from '../src/sim/buildings';
import {
  AI_HARD_INCOME_BONUS,
  ARMOR_OIL_UPKEEP,
  BASE_SCIENCE,
  BUILDINGS,
  CAPITAL_POP,
  CITY_GOLD,
  CITY_POP,
  CONVERT_RATE,
  FORT_DEFENSE,
  FORT_DEFENSE_TECH,
  GOLD_PER_WORKER,
  IRON_PER_MINE,
  MARKET_GOLD_BONUS,
  MARKET_MAX_BONUS,
  MIN_GROWTH,
  OIL_PER_WELL,
  SCIENCE_PER_LAB,
  TECHS,
  TICK_SECONDS,
  TICKS_PER_SECOND,
  WATCHTOWER_DEF,
} from '../src/sim/config';
import { formAlliance } from '../src/sim/diplomacy';
import { armyTotal, computeMaxPop, getTerritoryScan, hasOilShortage, population, updateEconomy } from '../src/sim/economy';
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
  const b: Building = { id, type, owner, tile, level, buildLeft: 0, fighters: 0, bombers: 0, cooldown: 0, hp: 1 };
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
function runTicks(state: GameState, n: number, fn: (s: GameState) => void = updateEconomy): void {
  for (let i = 0; i < n; i++) {
    fn(state);
    state.tick++;
  }
}

describe('population', () => {
  it('max pop = land pop + capital + city levels, fallout excluded', () => {
    const s = twoPlayers();
    const land = 20 * H * 30;
    expect(computeMaxPop(s, 1)).toBeCloseTo(land + CAPITAL_POP);
    addBuilding(s, 1, idx(3, 3), 'city', 3);
    expect(computeMaxPop(s, 1)).toBeCloseTo(land + CAPITAL_POP + 3 * CITY_POP);
    s.map.fallout[idx(5, 5)] = 60;
    s.map.terrain[idx(6, 6)] = Terrain.Mountains;
    s.tick += 10; // next scan
    expect(computeMaxPop(s, 1)).toBeCloseTo(land - 30 - 25 + CAPITAL_POP + 3 * CITY_POP);
  });

  it('grows toward max pop and never past it', () => {
    const s = twoPlayers();
    const p = s.players[1];
    let last = population(p);
    for (let i = 0; i < 4000; i++) {
      updateEconomy(s);
      s.tick++;
      const pop = population(p);
      expect(pop).toBeGreaterThanOrEqual(last - 1e-6);
      expect(pop).toBeLessThanOrEqual(p.maxPop + 1e-6);
      last = pop;
    }
    expect(population(p)).toBeGreaterThan(p.maxPop * 0.99);
    // At max: no more growth.
    updateEconomy(s);
    expect(population(p)).toBeCloseTo(last, 3);
  });

  it('grows at least MIN_GROWTH while below max, logistic otherwise', () => {
    const s = twoPlayers();
    const p = s.players[1];
    p.workers = 0;
    p.troops.infantry = 0;
    updateEconomy(s); // pop 0: logistic is 0, min growth applies
    expect(population(p)).toBeCloseTo(MIN_GROWTH * TICK_SECONDS, 6);
    p.workers = 9000;
    p.troops.infantry = 1000;
    const before = population(p);
    updateEconomy(s);
    const expected = 0.05 * before * (1 - before / p.maxPop) * TICK_SECONDS;
    expect(population(p) - before).toBeCloseTo(expected, 4);
  });

  it('farms add growth, double on Fertile, Agriculture x1.5, Medicine +20%', () => {
    const rate = (setup: (s: GameState) => void): number => {
      const s = twoPlayers();
      setup(s);
      const p = s.players[1];
      p.workers = 0;
      p.troops.infantry = 0;
      updateEconomy(s);
      // pop 0: logistic part 0, so growth = max(farms, MIN_GROWTH)
      return population(p) / TICK_SECONDS;
    };
    expect(rate(() => {})).toBeCloseTo(MIN_GROWTH);
    expect(rate((s) => addBuilding(s, 1, idx(5, 5), 'farm'))).toBeCloseTo(60);
    expect(rate((s) => { s.map.resource[idx(5, 5)] = Resource.Fertile; addBuilding(s, 1, idx(5, 5), 'farm'); })).toBeCloseTo(120);
    expect(rate((s) => { s.players[1].techs.push('agriculture'); addBuilding(s, 1, idx(5, 5), 'farm'); })).toBeCloseTo(90);
    expect(rate((s) => { s.players[1].techs.push('medicine'); addBuilding(s, 1, idx(5, 5), 'farm'); })).toBeCloseTo(72);
    expect(rate((s) => { addBuilding(s, 1, idx(5, 5), 'farm').buildLeft = 2; })).toBeCloseTo(MIN_GROWTH); // unfinished
  });

  it('extra population above max (land lost) drifts away from the workers', () => {
    const s = twoPlayers();
    const p = s.players[1];
    p.workers = 100000;
    const before = p.workers;
    const inf = p.troops.infantry;
    updateEconomy(s);
    expect(p.workers).toBeLessThan(before);
    expect(p.troops.infantry).toBeLessThanOrEqual(inf); // no growth while over max
  });
});

describe('army ratio', () => {
  it('new population goes to infantry until the target share, then to workers', () => {
    const s = twoPlayers();
    const p = s.players[1];
    p.workers = 9000;
    p.troops.infantry = 1000; // 10% army, target 40%
    p.armyRatio = 0.4;
    updateEconomy(s);
    expect(p.workers).toBeCloseTo(9000, 6);
    expect(p.troops.infantry).toBeGreaterThan(1000);
    // Above the ratio: growth goes to workers, infantry only shrinks (demobilisation)
    p.armyRatio = 0.1;
    p.workers = 5000;
    p.troops.infantry = 5000;
    updateEconomy(s);
    expect(p.workers).toBeGreaterThan(5000);
    expect(p.troops.infantry).toBeLessThan(5000);
  });

  it('demobilises slowly, keeping the population', () => {
    const s = twoPlayers();
    const p = s.players[1];
    const max = computeMaxPop(s, 1);
    p.workers = max / 2;
    p.troops.infantry = max / 2; // at max pop, army 50%
    p.armyRatio = 0.1;
    updateEconomy(s);
    const moved = max / 2 - p.troops.infantry;
    expect(moved).toBeGreaterThan(0);
    expect(moved).toBeLessThan(max * 0.01); // slow
    expect(population(p)).toBeCloseTo(max, 3);
    runTicks(s, 3000);
    expect(armyTotal(p.troops) / population(p)).toBeLessThan(0.2);
  });

  it('barracks boost infantry growth (up to 3 count)', () => {
    const grown = (barracks: number): number => {
      const s = twoPlayers();
      for (let k = 0; k < barracks; k++) addBuilding(s, 1, idx(3 + 4 * k, 3), 'barracks');
      const p = s.players[1];
      p.workers = 9000;
      p.troops.infantry = 0;
      updateEconomy(s);
      return p.troops.infantry;
    };
    const base = grown(0);
    expect(grown(1)).toBeCloseTo(base * 1.15, 4);
    expect(grown(4)).toBeCloseTo(base * 1.45, 4);
  });
});

describe('income', () => {
  it('gold from workers, markets (capped), cities and Banking', () => {
    const s = twoPlayers();
    const p = s.players[1];
    p.workers = 10000;
    p.troops.infantry = 0;
    p.armyRatio = 0.1;
    const gold0 = p.gold;
    updateEconomy(s);
    const workers = p.workers; // income uses workers after growth
    expect(p.income.gold).toBeCloseTo(workers * GOLD_PER_WORKER, 6);
    expect(p.gold - gold0).toBeCloseTo(p.income.gold * TICK_SECONDS, 6);
    expect(p.stats.goldEarned).toBeCloseTo(p.income.gold * TICK_SECONDS, 6);

    addBuilding(s, 1, idx(2, 2), 'market');
    addBuilding(s, 1, idx(6, 2), 'market');
    addBuilding(s, 1, idx(10, 2), 'city', 2);
    updateEconomy(s);
    expect(p.income.gold).toBeCloseTo(p.workers * GOLD_PER_WORKER * (1 + 2 * MARKET_GOLD_BONUS) + 2 * CITY_GOLD, 6);

    for (let k = 0; k < 12; k++) addBuilding(s, 1, idx(2 + 4 * (k % 4), 10 + 4 * Math.floor(k / 4)), 'market');
    updateEconomy(s);
    expect(p.income.gold).toBeCloseTo(p.workers * GOLD_PER_WORKER * (1 + MARKET_MAX_BONUS) + 2 * CITY_GOLD, 6);

    p.techs.push('banking');
    updateEconomy(s);
    expect(p.income.gold).toBeCloseTo((p.workers * GOLD_PER_WORKER * (1 + MARKET_MAX_BONUS * 1.5) + 2 * CITY_GOLD) * 1.3, 6);
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
    s.players[1].workers = s.players[2].workers = 10000;
    s.players[1].troops.infantry = s.players[2].troops.infantry = 0;
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
    p.oil = 0.01;
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
    p.workers = 1e9; // way over max: no growth noise on the army
    p.troops = { infantry: 10000, armor: 0, artillery: 0 };
    p.armyRatio = 0.9;
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
    expect(p.troops.infantry).toBeCloseTo(10000 - n);
    expect(p.iron).toBeCloseTo(iron - n * 0.5);
    // gold: paid 4/unit, earned income
    expect(gold + p.income.gold * TICK_SECONDS - p.gold).toBeCloseTo(n * 4);
  });

  it('Industrialization doubles the rate, Metallurgy cuts iron by 25%', () => {
    const s = withFactory();
    const p = s.players[1];
    p.techs.push('metallurgy', 'industrialization');
    const iron = p.iron;
    updateEconomy(s);
    const n = CONVERT_RATE.armor * 2 * TICK_SECONDS;
    expect(p.troops.armor).toBeCloseTo(n);
    expect(iron + p.income.iron * TICK_SECONDS - p.iron).toBeCloseTo(n * 0.375);
  });

  it('stops at the target share and is limited by resources', () => {
    const s = withFactory();
    const p = s.players[1];
    runTicks(s, 3000);
    expect(p.troops.armor / armyTotal(p.troops)).toBeCloseTo(0.5, 3);
    expect(p.troops.infantry).toBeGreaterThan(0);

    const t = withFactory();
    const q = t.players[1];
    q.iron = 1; // 2 armor worth of iron, no mines
    runTicks(t, 50);
    expect(q.troops.armor).toBeCloseTo(2, 5);
    expect(q.iron).toBeCloseTo(0, 6);
    expect(q.troops.infantry + q.troops.armor).toBeGreaterThan(9990);
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
  it('validates owner, water, terrain, fallout, tech and money', () => {
    const s = twoPlayers();
    const p = s.players[1];
    p.gold = 1e6;
    p.iron = 1e6;
    expect(canBuild(s, 1, 'market', idx(5, 5)).ok).toBe(true);
    expect(canBuild(s, 1, 'market', idx(45, 5)).ok).toBe(false); // enemy land
    expect(canBuild(s, 1, 'market', idx(30, 5)).ok).toBe(false); // neutral
    s.map.terrain[idx(6, 6)] = Terrain.Mountains;
    expect(canBuild(s, 1, 'farm', idx(6, 6)).ok).toBe(false);
    expect(canBuild(s, 1, 'market', idx(6, 6)).ok).toBe(true);
    s.map.fallout[idx(10, 10)] = 30;
    expect(canBuild(s, 1, 'market', idx(10, 10)).reason).toMatch(/irradiated/);
    expect(canBuild(s, 1, 'hospital', idx(15, 15)).reason).toMatch(/research/);
    p.techs.push('medicine');
    expect(canBuild(s, 1, 'hospital', idx(15, 15)).ok).toBe(true);
    p.gold = 10;
    expect(canBuild(s, 1, 'market', idx(5, 5)).reason).toMatch(/gold/);
    p.gold = 1e6;
    p.iron = 0;
    expect(canBuild(s, 1, 'factory', idx(5, 5)).reason).toMatch(/iron/);
  });

  it('enforces spacing; cities may cluster', () => {
    const s = twoPlayers();
    s.players[1].gold = 1e6;
    s.players[1].iron = 1e6;
    addBuilding(s, 1, idx(10, 10), 'market');
    expect(canBuild(s, 1, 'farm', idx(10, 10)).ok).toBe(false); // occupied
    expect(canBuild(s, 1, 'farm', idx(12, 12)).ok).toBe(false); // 2 away
    expect(canBuild(s, 1, 'farm', idx(13, 10)).ok).toBe(true); // 3 away
    expect(canBuild(s, 1, 'city', idx(11, 10)).ok).toBe(false); // city next to a market
    addBuilding(s, 1, idx(5, 30), 'city');
    expect(canBuild(s, 1, 'city', idx(6, 30)).ok).toBe(true); // city next to a city
    expect(canBuild(s, 1, 'market', idx(6, 31)).ok).toBe(false);
  });

  it('mines and oil wells need an owned deposit within 2 tiles', () => {
    const s = twoPlayers();
    s.players[1].gold = 1e6;
    s.players[1].iron = 1e6;
    expect(canBuild(s, 1, 'mine', idx(5, 5)).ok).toBe(false);
    s.map.resource[idx(7, 7)] = Resource.Iron;
    expect(canBuild(s, 1, 'mine', idx(5, 5)).ok).toBe(true);
    expect(canBuild(s, 1, 'mine', idx(4, 5)).ok).toBe(false); // 3 away
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
    expect(canBuild(s, 1, 'port', idx(1, 5)).ok).toBe(true);
    expect(canBuild(s, 1, 'port', idx(5, 5)).ok).toBe(false);
    expect(canBuild(s, 1, 'port', idx(0, 5)).ok).toBe(false); // water
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

  it('building on an own city upgrades it (priced like a new city, keeps working, max level)', () => {
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
    expect(countBuildings(s, 1, 'city')).toBe(1);
    expect(city.level).toBe(1);
    expect(computeMaxPop(s, 1)).toBeCloseTo(20 * H * 30 + CAPITAL_POP + CITY_POP); // still working
    expect(canBuild(s, 1, 'city', city.tile).ok).toBe(false); // upgrade running
    runTicks(s, BUILDINGS.city.buildTime * TICKS_PER_SECOND, updateBuildings);
    expect(city.level).toBe(2);
    expect(countBuildings(s, 1, 'city', true)).toBe(1);
    city.level = 5;
    expect(canBuild(s, 1, 'city', city.tile).reason).toMatch(/highest/);
    // Not on an enemy city
    const enemy = addBuilding(s, 2, idx(45, 10), 'city');
    expect(canBuild(s, 1, 'city', enemy.tile).ok).toBe(false);
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
    const fort = addBuilding(s, 1, idx(10, 20), 'fort');
    expect(fortMultiplierAt(s, idx(10, 30), 1)).toBe(FORT_DEFENSE); // 10 away
    expect(fortMultiplierAt(s, idx(10, 31), 1)).toBe(1);
    expect(fortMultiplierAt(s, idx(10, 30), 2)).toBe(1); // not theirs
    s.players[1].techs.push('fortification');
    expect(fortMultiplierAt(s, idx(10, 33), 1)).toBe(FORT_DEFENSE_TECH);
    fort.buildLeft = 1;
    expect(fortMultiplierAt(s, idx(10, 20), 1)).toBe(1);
    fort.buildLeft = 0;
    addBuilding(s, 1, idx(10, 25), 'watchtower');
    expect(fortMultiplierAt(s, idx(10, 30), 1)).toBeCloseTo(FORT_DEFENSE_TECH * WATCHTOWER_DEF);
    expect(fortMultiplierAt(s, idx(17, 2), 1)).toBe(1);
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
    const far = makeFlatGame(200, 40, 2);
    claimRect(far, 1, 0, 0, 9, 39);
    claimRect(far, 2, 150, 0, 199, 39);
    addBuilding(far, 1, 5 + 20 * 200, 'watchtower');
    getTerritoryScan(far, true);
    expect(hasIntel(far, 1, 2)).toBe(false);
    far.players[1].techs.push('radar'); // radius 80
    expect(hasIntel(far, 1, 2)).toBe(false); // 145 away
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
    const need = TECHS.navigation.science;
    runTicks(s, need + 40, updateResearch); // need + 40 science banked
    expect(p.science).toBeCloseTo(need + 40);
    startResearch(s, 1, 'navigation');
    expect(p.researchProgress).toBeCloseTo(need);
    expect(p.science).toBeCloseTo(40);
    runTicks(s, 1, updateResearch);
    expect(p.techs).toContain('navigation');
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
