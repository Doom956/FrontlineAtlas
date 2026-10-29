// Land combat and supply (WP-C).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { estimateAttack, launchAttack, retreat, supplyEfficiency, updateAttacks, updateSupply, borders, defensePower } from '../src/sim/combat';
import { MIN_ATTACK_TROOPS, MIN_SUPPLY_EFF, NEUTRAL_TILE_DEF, RETREAT_LOSS, START_INFANTRY } from '../src/sim/config';
import { formAlliance, requestAlliance } from '../src/sim/diplomacy';
import { Terrain } from '../src/sim/types';
import type { GameState, Troops } from '../src/sim/types';
import { claimRect, makeFlatGame, troopSum } from './helpers';

// Forts come from buildings.ts (another work package). Tests can override the fort multiplier; by default the
// real function is used.
const fortOverride = vi.hoisted(() => ({ fn: null as null | ((tile: number, owner: number) => number) }));
vi.mock('../src/sim/buildings', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../src/sim/buildings')>();
  return {
    ...orig,
    fortMultiplierAt: (state: GameState, tile: number, owner: number): number =>
      fortOverride.fn ? fortOverride.fn(tile, owner) : orig.fortMultiplierAt(state, tile, owner),
  };
});
// Oil shortage flags come from economy.ts; same pattern.
const oilOverride = vi.hoisted(() => ({ short: null as null | Set<number> }));
vi.mock('../src/sim/economy', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../src/sim/economy')>();
  return {
    ...orig,
    hasOilShortage: (state: GameState, playerId: number): boolean =>
      oilOverride.short ? oilOverride.short.has(playerId) : orig.hasOilShortage(state, playerId),
  };
});
afterEach(() => {
  fortOverride.fn = null;
  oilOverride.short = null;
});

const inf = (n: number): Troops => ({ infantry: n, armor: 0, artillery: 0 });
const at = (s: GameState, x: number, y: number): number => y * s.map.width + x;

/** Runs supply + attacks until no attack is left (or maxTicks). */
function runAttacks(s: GameState, maxTicks = 30000): void {
  for (let k = 0; k < maxTicks && s.attacks.length; k++) {
    updateSupply(s);
    updateAttacks(s);
    s.tick++;
  }
}

/**
 * Player 1 (10 columns) attacks player 2 (90 columns, 27000 infantry => density 10) with `force` until the force
 * is spent. Returns tiles taken.
 */
function fight(terrain: number, force: Troops, fort = 1): number {
  const s = makeFlatGame(100, 30, 2, { terrain });
  claimRect(s, 1, 0, 0, 9, 29);
  claimRect(s, 2, 10, 0, 99, 29);
  s.players[1].troops = { ...force };
  s.players[1].oil = 1e6;
  s.players[2].troops = inf(27000);
  // Always (re)set: a fort override left by an earlier call would leak into an "open" fight.
  fortOverride.fn = fort !== 1 ? (_tile, owner) => (owner === 2 ? fort : 1) : null;
  const before = s.players[1].tiles;
  expect(launchAttack(s, 1, at(s, 10, 15), force).ok).toBe(true);
  runAttacks(s);
  expect(s.attacks.length).toBe(0);
  // The force ran out before the 2700 defender tiles did.
  expect(s.players[2].alive).toBe(true);
  return s.players[1].tiles - before;
}

describe('launchAttack validation', () => {
  it('rejects bad targets and troop counts', () => {
    const s = makeFlatGame(30, 10, 3);
    claimRect(s, 1, 0, 0, 4, 9);
    claimRect(s, 2, 5, 0, 9, 9);
    claimRect(s, 3, 20, 0, 29, 9);
    expect(launchAttack(s, 1, at(s, 2, 2), inf(100)).ok).toBe(false); // own land
    expect(launchAttack(s, 1, at(s, 6, 2), inf(MIN_ATTACK_TROOPS - 1)).ok).toBe(false); // too few
    expect(launchAttack(s, 1, at(s, 6, 2), inf(START_INFANTRY + 1)).ok).toBe(false); // not available
    expect(launchAttack(s, 1, at(s, 25, 2), inf(100)).ok).toBe(false); // player 3 does not border player 1
    expect(launchAttack(s, 1, at(s, 15, 2), inf(100)).ok).toBe(false); // neutral land not next to player 1
    expect(s.players[1].troops.infantry).toBe(START_INFANTRY);
    expect(s.attacks.length).toBe(0);
    formAlliance(s, 1, 2);
    expect(launchAttack(s, 1, at(s, 6, 2), inf(100)).ok).toBe(false); // ally
  });

  it('takes troops, sends events, clears alliance requests and merges repeat launches', () => {
    const s = makeFlatGame(30, 10, 2);
    claimRect(s, 1, 0, 0, 4, 9);
    claimRect(s, 2, 5, 0, 9, 9);
    expect(requestAlliance(s, 2, 1).ok).toBe(true);
    expect(launchAttack(s, 1, at(s, 5, 2), inf(500)).ok).toBe(true);
    expect(s.players[1].troops.infantry).toBe(START_INFANTRY - 500);
    expect(s.allianceRequests.length).toBe(0);
    expect(s.events.some((e) => e.kind === 'attackStarted' && e.players.includes(1))).toBe(true);
    expect(s.events.some((e) => e.kind === 'underAttack' && e.players.includes(2))).toBe(true);
    expect(launchAttack(s, 1, at(s, 5, 8), inf(300)).ok).toBe(true);
    expect(s.attacks.length).toBe(1);
    expect(s.attacks[0].troops.infantry).toBe(800);
    expect(s.attacks[0].focusTile).toBe(at(s, 5, 8));
    // Neutral expansion: no 'underAttack' event for nobody.
    const n = s.events.length;
    expect(launchAttack(s, 2, at(s, 10, 2), inf(100)).ok).toBe(true);
    expect(s.events.slice(n).some((e) => e.kind === 'underAttack')).toBe(false);
  });
});

describe('neutral expansion', () => {
  it('costs troops and gains tiles', () => {
    const s = makeFlatGame(60, 60, 1);
    claimRect(s, 1, 0, 0, 4, 4);
    expect(launchAttack(s, 1, at(s, 5, 2), inf(1000)).ok).toBe(true);
    runAttacks(s, 20);
    expect(s.players[1].tiles).toBeGreaterThan(25);
    expect(s.attacks[0].troops.infantry).toBeLessThan(1000);
    expect(s.players[1].stats.tilesCaptured).toBeGreaterThan(0);
    runAttacks(s);
    // Plains neutral tiles cost NEUTRAL_TILE_DEF infantry each: 1000 troops take about 111 tiles.
    const gained = s.players[1].tiles - 25;
    expect(gained).toBeGreaterThanOrEqual(Math.floor(1000 / NEUTRAL_TILE_DEF) - 1);
    expect(gained).toBeLessThanOrEqual(Math.ceil(1000 / NEUTRAL_TILE_DEF));
    expect(s.players[1].troops.infantry).toBe(START_INFANTRY - 1000);
    expect(s.players[1].stats.troopsLost).toBeCloseTo(1000, 3);
  });

  it('ends when no frontier is left and sends the rest home', () => {
    const s = makeFlatGame(10, 10, 1);
    claimRect(s, 1, 0, 0, 8, 9); // column x = 9 stays neutral: 10 tiles
    expect(launchAttack(s, 1, at(s, 9, 5), inf(1000)).ok).toBe(true);
    runAttacks(s);
    expect(s.attacks.length).toBe(0);
    expect(s.players[1].tiles).toBe(100);
    expect(s.players[1].troops.infantry).toBeCloseTo(START_INFANTRY - 10 * NEUTRAL_TILE_DEF, 6);
  });
});

describe('terrain and troop types', () => {
  it('plains favour armor, forest favours infantry', () => {
    const plainsInf = fight(Terrain.Plains, inf(1000));
    const plainsArmor = fight(Terrain.Plains, { infantry: 0, armor: 1000, artillery: 0 });
    const forestInf = fight(Terrain.Forest, inf(1000));
    const forestArmor = fight(Terrain.Forest, { infantry: 0, armor: 1000, artillery: 0 });
    expect(plainsArmor).toBeGreaterThan(plainsInf * 2);
    // Armor's edge over infantry shrinks a lot in forest.
    expect(forestArmor / forestInf).toBeLessThan((plainsArmor / plainsInf) * 0.6);
    // Forest is harder ground for everyone.
    expect(forestInf).toBeLessThan(plainsInf);
  });

  it('armor without oil fights at half strength', () => {
    const s = makeFlatGame(20, 10, 2);
    claimRect(s, 1, 0, 0, 9, 9);
    claimRect(s, 2, 10, 0, 19, 9);
    const armor = { infantry: 0, armor: 500, artillery: 0 };
    oilOverride.short = new Set();
    const withOil = estimateAttack(s, 1, at(s, 10, 5), armor)!;
    oilOverride.short = new Set([1]);
    const noOil = estimateAttack(s, 1, at(s, 10, 5), armor)!;
    expect(noOil.lossPerTile).toBeCloseTo(withOil.lossPerTile * 2, 6);
  });
});

describe('forts and artillery', () => {
  it('forts make attacks cost more, artillery offsets it', () => {
    const infOpen = fight(Terrain.Plains, inf(1000));
    const infFort = fight(Terrain.Plains, inf(1000), 2);
    const art = { infantry: 0, armor: 0, artillery: 1000 };
    const artOpen = fight(Terrain.Plains, art);
    const artFort = fight(Terrain.Plains, art, 2);
    expect(infFort).toBeLessThan(infOpen * 0.6);
    expect(artFort / artOpen).toBeGreaterThan((infFort / infOpen) * 2);
    expect(artFort).toBeGreaterThan(infFort * 3);
  });
});

describe('supply', () => {
  it('efficiency falls with distance from supply sources', () => {
    const s = makeFlatGame(200, 3, 1);
    claimRect(s, 1, 0, 0, 179, 1); // row 2 stays neutral
    s.players[1].capital = at(s, 0, 1);
    updateSupply(s);
    expect(supplyEfficiency(s, 1, at(s, 10, 1))).toBe(1);
    expect(supplyEfficiency(s, 1, at(s, 44, 1))).toBe(1);
    const mid = supplyEfficiency(s, 1, at(s, 90, 1));
    expect(mid).toBeLessThan(1);
    expect(mid).toBeGreaterThan(MIN_SUPPLY_EFF);
    expect(supplyEfficiency(s, 1, at(s, 120, 1))).toBeLessThan(mid);
    expect(supplyEfficiency(s, 1, at(s, 170, 1))).toBe(MIN_SUPPLY_EFF);
    // Neutral tiles are judged through the neighbouring own tile.
    expect(supplyEfficiency(s, 1, at(s, 10, 2))).toBe(1);
    const near = estimateAttack(s, 1, at(s, 10, 2), inf(1000))!;
    const far = estimateAttack(s, 1, at(s, 170, 2), inf(1000))!;
    expect(far.lossPerTile).toBeCloseTo(near.lossPerTile / MIN_SUPPLY_EFF, 6);
    // Logistics: +50% range.
    expect(supplyEfficiency(s, 1, at(s, 60, 1))).toBeLessThan(1);
    s.players[1].techs.push('logistics');
    s.tick = 20; // next recalculation
    updateSupply(s);
    expect(supplyEfficiency(s, 1, at(s, 60, 1))).toBe(1);
  });
});

describe('player vs player', () => {
  it('counter-attacks cancel troops first', () => {
    const s = makeFlatGame(40, 20, 2);
    claimRect(s, 1, 0, 0, 19, 19);
    claimRect(s, 2, 20, 0, 39, 19);
    expect(launchAttack(s, 1, at(s, 20, 10), inf(1000)).ok).toBe(true);
    expect(launchAttack(s, 2, at(s, 19, 10), inf(600)).ok).toBe(true);
    updateSupply(s);
    updateAttacks(s);
    expect(s.attacks.length).toBe(1);
    expect(s.attacks[0].attacker).toBe(1);
    // Equal infantry: 600 cancels 600; at most one tile could have been taken this tick.
    expect(troopSum(s.attacks[0].troops)).toBeLessThanOrEqual(400 + 1e-6);
    expect(troopSum(s.attacks[0].troops)).toBeGreaterThan(350);
    expect(s.players[2].stats.troopsLost).toBeGreaterThanOrEqual(600 - 1e-6);
  });

  it('retreat returns 90% of the troops', () => {
    const s = makeFlatGame(20, 10, 2);
    claimRect(s, 1, 0, 0, 9, 9);
    claimRect(s, 2, 10, 0, 19, 9);
    expect(launchAttack(s, 1, at(s, 10, 5), inf(1000)).ok).toBe(true);
    const id = s.attacks[0].id;
    expect(retreat(s, 2, id).ok).toBe(false); // not theirs
    expect(retreat(s, 1, id).ok).toBe(true);
    expect(s.attacks.length).toBe(0);
    expect(s.players[1].troops.infantry).toBeCloseTo(START_INFANTRY - 1000 * RETREAT_LOSS, 6);
    expect(retreat(s, 1, id).ok).toBe(false);
  });

  it('defender losses follow their density; defence power counts troop types', () => {
    const s = makeFlatGame(20, 10, 2);
    claimRect(s, 1, 0, 0, 9, 9);
    claimRect(s, 2, 10, 0, 19, 9);
    s.players[2].troops = { infantry: 1000, armor: 200, artillery: 100 };
    expect(defensePower(s, 2)).toBeCloseTo(1000 + 200 * 1.5 + 100 * 0.6, 6);
    oilOverride.short = new Set([2]);
    expect(defensePower(s, 2)).toBeCloseTo(1000 + 200 * 1.5 * 0.5 + 100 * 0.6, 6);
    expect(borders(s, 1, 2)).toBe(true);
    expect(borders(s, 1, 0)).toBe(false);
  });

  it('conquering every tile eliminates the defender', () => {
    const s = makeFlatGame(30, 10, 2);
    claimRect(s, 1, 0, 0, 19, 9);
    claimRect(s, 2, 20, 0, 22, 2); // 9 tiles
    s.players[2].troops = inf(50);
    expect(launchAttack(s, 1, at(s, 20, 1), inf(2000)).ok).toBe(true);
    runAttacks(s);
    expect(s.players[2].alive).toBe(false);
    expect(s.players[2].tiles).toBe(0);
    expect(s.players[1].tiles).toBe(209);
    expect(s.events.some((e) => e.kind === 'eliminated')).toBe(true);
    // Leftover troops came home.
    expect(s.players[1].troops.infantry).toBeGreaterThan(START_INFANTRY - 2000 + 1500);
  });
});

describe('amphibious attacks', () => {
  it('captures the landing tile first, then attacks from the beachhead', () => {
    const s = makeFlatGame(30, 10, 2);
    claimRect(s, 1, 0, 0, 4, 9);
    claimRect(s, 2, 15, 0, 29, 9);
    const landing = at(s, 22, 5);
    expect(launchAttack(s, 1, landing, inf(800), true).ok).toBe(true);
    expect(s.players[1].troops.infantry).toBe(START_INFANTRY); // came from the transport
    expect(s.map.owner[landing]).toBe(1);
    expect(s.attacks.length).toBe(1);
    expect(s.attacks[0].target).toBe(2);
    expect(troopSum(s.attacks[0].troops)).toBeLessThan(800);
    runAttacks(s, 50);
    expect(s.players[1].tiles).toBeGreaterThan(51);
  });

  it('is repelled when the landing tile costs more than the force', () => {
    const s = makeFlatGame(30, 10, 2);
    claimRect(s, 1, 0, 0, 4, 9);
    claimRect(s, 2, 15, 0, 29, 9);
    s.players[2].troops = inf(100000);
    expect(launchAttack(s, 1, at(s, 22, 5), inf(100), true).ok).toBe(false);
    expect(s.map.owner[at(s, 22, 5)]).toBe(2);
    expect(s.attacks.length).toBe(0);
  });
});

describe('determinism', () => {
  it('same setup gives the same result', () => {
    const play = (): number[] => {
      const s = makeFlatGame(60, 40, 1, { seed: 7 });
      claimRect(s, 1, 20, 15, 25, 20);
      launchAttack(s, 1, at(s, 26, 17), inf(1500));
      runAttacks(s, 40);
      return Array.from(s.map.owner);
    };
    expect(play()).toEqual(play());
  });
});
