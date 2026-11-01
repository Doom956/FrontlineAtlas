// Gameplay feel pass: whole-border fronts, send more lose less, clashes on terrain, beachhead supply, fast cleanup,
// enclaves, overtime, tribes, start now, auto-manage (advisor), alliance polish.
import { describe, expect, it } from 'vitest';
import { applyAction } from '../src/sim/actions';
import { aiWantsAlliance } from '../src/sim/ai';
import { mainFoe, recommendMix, updateAdvisor } from '../src/sim/advisor';
import { markBuildingsChanged } from '../src/sim/buildings';
import { annexTiles, collapseThreshold, estimateAttack, frontLength, humanGraceSeconds, launchAttack, supplyEfficiency, updateAttacks, updateSupply } from '../src/sim/combat';
import {
  AUTO_EMBARGO_SECONDS,
  BEACHHEAD_SUPPLY_SECONDS,
  ENDGAME_SMALL_TILES,
  HUMAN_GRACE_SECONDS,
  OUTNUMBER_LOSS,
  OVERTIME_MIN_SHARE,
  OVERTIME_MINUTES,
  RULES_TEXT,
  SPAWN_SECONDS,
  TICKS_PER_SECOND,
  TRAITOR_DEFENSE,
  TRAITOR_DURATION,
  TRIBE_COUNT,
  VICTORY_LAND_SHARE,
} from '../src/sim/config';
import { breakAlliance, canTrade, formAlliance, requestAlliance, updateDiplomacy } from '../src/sim/diplomacy';
import { annexEnclaves } from '../src/sim/endgame';
import { computeCoastAndLand } from '../src/sim/mapgen';
import { tick } from '../src/sim/sim';
import { createGame, gameSeconds, isTribe, newId, setOwner, tribeCountFor } from '../src/sim/state';
import { Terrain } from '../src/sim/types';
import type { Building, BuildingType, Difficulty, GameState, Troops } from '../src/sim/types';
import { inOvertime, updateVictory, victoryShareNow } from '../src/sim/victory';
import { claimRect, makeFlatGame, testSettings, troopSum } from './helpers';

const inf = (n: number): Troops => ({ infantry: n, armor: 0, artillery: 0 });
const at = (s: GameState, x: number, y: number): number => y * s.map.width + x;
function step(s: GameState, n = 1): void {
  for (let k = 0; k < n; k++) {
    updateSupply(s);
    updateAttacks(s);
    s.tick++;
  }
}
function addBuilding(s: GameState, type: BuildingType, owner: number, tile: number): Building {
  const id = newId(s);
  const b: Building = { id, type, owner, tile, level: 1, buildLeft: 0, upgradeLeft: 0, fighters: 0, bombers: 0, cooldown: 0, dropCooldown: 0, disabledUntil: 0, hp: 1, queuedLevels: 0 };
  s.buildings.set(id, b);
  s.map.building[tile] = id + 1;
  markBuildingsChanged(s);
  return b;
}
function ownedInColumn(s: GameState, playerId: number, x: number): number {
  let n = 0;
  for (let y = 0; y < s.map.height; y++) if (s.map.owner[at(s, x, y)] === playerId) n++;
  return n;
}

describe('fronts advance along the whole border', () => {
  it('neutral expansion floods the whole shared border, not just around the click', () => {
    const s = makeFlatGame(80, 60, 1);
    claimRect(s, 1, 0, 0, 3, 59); // a 60-tile border at x = 4
    expect(launchAttack(s, 1, at(s, 4, 2), inf(3000)).ok).toBe(true);
    expect(frontLength(s, s.attacks[0])).toBe(60);
    step(s, 16);
    // Rows far from the clicked point (y = 2) moved too (the next column is ragged: fronts are organic, not ruled).
    expect(ownedInColumn(s, 1, 4)).toBe(60);
    expect(ownedInColumn(s, 1, 5)).toBeGreaterThan(36);
  });

  it('wilderness expansion grows a round blob, not a square', () => {
    const s = makeFlatGame(120, 90, 1);
    claimRect(s, 1, 58, 43, 62, 47);
    s.players[1].troops.infantry = 1e6;
    expect(launchAttack(s, 1, at(s, 57, 45), inf(200000)).ok).toBe(true);
    step(s, 50);
    let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1, n = 0;
    for (let y = 0; y < s.map.height; y++) {
      for (let x = 0; x < s.map.width; x++) {
        if (s.map.owner[at(s, x, y)] !== 1) continue;
        n++;
        x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
      }
    }
    expect(n).toBeGreaterThan(1000);
    // a square fills its bounding box (1.0), a disc about 0.79
    expect(n / ((x1 - x0 + 1) * (y1 - y0 + 1))).toBeLessThan(0.9);
  });

  it('a click picks the target owner, not a point: the front is the same wherever you click', () => {
    const run = (clickY: number): number[] => {
      const s = makeFlatGame(60, 40, 2, { seed: 3 });
      claimRect(s, 1, 0, 0, 19, 39);
      claimRect(s, 2, 20, 0, 59, 39);
      s.players[1].troops = inf(60000);
      expect(launchAttack(s, 1, at(s, 20 + (clickY % 5), clickY), inf(60000)).ok).toBe(true);
      step(s, 8);
      return Array.from(s.map.owner);
    };
    const top = run(1);
    expect(run(38)).toEqual(top);
    // ... and the whole border moved, top to bottom.
    let rows = 0;
    for (let y = 0; y < 40; y++) if (top[y * 60 + 20] === 1) rows++;
    expect(rows).toBeGreaterThan(30);
  });

  it('a longer front takes proportionally more tiles per second', () => {
    const rate = (height: number): number => {
      const s = makeFlatGame(60, height, 1);
      claimRect(s, 1, 0, 0, 3, height - 1);
      s.players[1].troops = inf(20000);
      expect(launchAttack(s, 1, at(s, 4, 0), inf(20000)).ok).toBe(true);
      step(s, 10);
      return s.players[1].tiles - 4 * height;
    };
    const short = rate(10);
    const long = rate(60);
    // Speed is linear in the front length: 6x the border, about 6x the tiles.
    expect(long / short).toBeGreaterThan(4.5);
    expect(long / short).toBeLessThan(7.5);
  });

  it('fills notches first: a dent in the border is taken before the flat parts', () => {
    const s = makeFlatGame(40, 40, 1);
    claimRect(s, 1, 0, 0, 9, 39);
    claimRect(s, 1, 10, 0, 10, 18); // a column that leaves a notch at (10, 19)
    claimRect(s, 1, 10, 20, 10, 39);
    s.rng = () => 0.5; // no jitter differences
    expect(launchAttack(s, 1, at(s, 30, 0), inf(2000)).ok).toBe(true); // clicked far away from the notch
    step(s, 1);
    expect(s.map.owner[at(s, 10, 19)]).toBe(1);
  });

  it('clicking the same target again merges into the running attack (the click is only a label anchor)', () => {
    const s = makeFlatGame(40, 20, 2);
    claimRect(s, 1, 0, 0, 19, 19);
    claimRect(s, 2, 20, 0, 39, 19);
    expect(launchAttack(s, 1, at(s, 20, 2), inf(500)).ok).toBe(true);
    expect(launchAttack(s, 1, at(s, 25, 17), inf(700)).ok).toBe(true); // deep inside: fine for a merge
    expect(s.attacks.length).toBe(1);
    expect(troopSum(s.attacks[0].troops)).toBe(1200);
    expect(s.attacks[0].focusTile).toBe(at(s, 25, 17));
    expect(frontLength(s, s.attacks[0])).toBe(20);
  });
});

describe('send more, lose less', () => {
  it('outnumbering the defender cuts losses per tile (clamped) and raises the odds', () => {
    const s = makeFlatGame(40, 20, 2);
    claimRect(s, 1, 0, 0, 19, 19);
    claimRect(s, 2, 20, 0, 39, 19);
    s.players[1].troops = inf(100000);
    s.players[2].troops = inf(10000);
    const t = at(s, 20, 10);
    const small = estimateAttack(s, 1, t, inf(2000))!;
    const even = estimateAttack(s, 1, t, inf(10000))!;
    const big = estimateAttack(s, 1, t, inf(40000))!;
    expect(small.odds).toBeCloseTo(0.2, 6);
    expect(even.odds).toBeCloseTo(1, 6);
    expect(small.lossFactor).toBe(OUTNUMBER_LOSS[1]);
    expect(even.lossFactor).toBeCloseTo(1, 6);
    // 4:1 is past the force limit: close to the floor, never under it.
    expect(big.lossFactor).toBeGreaterThan(OUTNUMBER_LOSS[0]);
    expect(big.lossFactor).toBeLessThan(0.56);
    expect(small.lossPerTile).toBeCloseTo(even.lossPerTile * OUTNUMBER_LOSS[1], 6);
    expect(big.lossPerTile).toBeCloseTo(even.lossPerTile * big.lossFactor, 6);
    expect(big.tilesPerSecond).toBeGreaterThan(even.tilesPerSecond);
    expect(even.tilesPerSecond).toBeGreaterThan(small.tilesPerSecond);
    // Neutral land: no odds.
    const n = makeFlatGame(20, 10, 1);
    claimRect(n, 1, 0, 0, 4, 9);
    const e = estimateAttack(n, 1, at(n, 5, 5), inf(1000))!;
    expect(e.odds).toBe(0);
    expect(e.lossFactor).toBe(1);
  });

  it('two half-size attacks take fewer tiles than one full-size attack', () => {
    const fight = (waves: number): number => {
      const s = makeFlatGame(100, 30, 2);
      claimRect(s, 1, 0, 0, 9, 29);
      claimRect(s, 2, 10, 0, 99, 29);
      s.players[1].troops = inf(40000);
      s.players[2].troops = inf(20000);
      for (let w = 0; w < waves; w++) {
        launchAttack(s, 1, at(s, 10, 15), inf(20000 / waves));
        for (let k = 0; k < 3000 && s.attacks.length; k++) step(s);
      }
      return s.players[1].tiles - 300;
    };
    expect(fight(1)).toBeGreaterThan(fight(2) * 1.2);
  });
});

describe('counter-attacks cancel the attack first, on the contact terrain', () => {
  it('infantry holds a forest clash against armor better than a plains clash', () => {
    const clash = (terrain: number): number => {
      const s = makeFlatGame(40, 20, 2, { terrain });
      claimRect(s, 1, 0, 0, 19, 19);
      claimRect(s, 2, 20, 0, 39, 19);
      s.players[1].oil = 1e6;
      s.players[1].troops = { infantry: 0, armor: 2000, artillery: 0 };
      launchAttack(s, 1, at(s, 20, 10), { infantry: 0, armor: 2000, artillery: 0 });
      launchAttack(s, 2, at(s, 19, 10), inf(3000));
      step(s, 1);
      const a2 = s.attacks.find((a) => a.attacker === 2);
      return a2 ? troopSum(a2.troops) : -troopSum(s.attacks.find((a) => a.attacker === 1)?.troops ?? inf(0));
    };
    expect(clash(Terrain.Forest)).toBeGreaterThan(clash(Terrain.Plains));
  });
});

describe('beachheads supply the invasion', () => {
  it('a landing far from any city is supplied for BEACHHEAD_SUPPLY_SECONDS', () => {
    const s = makeFlatGame(300, 10, 2);
    for (let y = 0; y < 10; y++) for (let x = 20; x < 40; x++) s.map.terrain[at(s, x, y)] = Terrain.DeepWater;
    computeCoastAndLand(s.map);
    claimRect(s, 1, 0, 0, 19, 9);
    s.players[1].capital = at(s, 0, 5);
    claimRect(s, 2, 280, 0, 299, 9);
    s.players[2].troops = inf(100);
    updateSupply(s);
    const landing = at(s, 200, 5); // neutral land 200 tiles from player 1's capital
    expect(launchAttack(s, 1, landing, inf(3000), true).ok).toBe(true);
    expect(supplyEfficiency(s, 1, landing)).toBe(1);
    step(s, 20);
    expect(supplyEfficiency(s, 1, at(s, 202, 5))).toBe(1);
    s.tick += BEACHHEAD_SUPPLY_SECONDS * TICKS_PER_SECOND;
    updateSupply(s);
    expect(supplyEfficiency(s, 1, landing)).toBeLessThan(1);
  });
});

describe('endgame', () => {
  it('a small nation that is hit collapses: the attacker takes everything', () => {
    const s = makeFlatGame(40, 20, 2);
    claimRect(s, 1, 0, 0, 19, 19);
    claimRect(s, 2, 20, 0, 26, 19); // 140 tiles
    claimRect(s, 2, 30, 0, 30, 14); // a far-away piece too: just above the threshold
    s.players[2].troops = inf(200);
    s.players[2].gold = 1234;
    expect(s.players[2].tiles).toBe(ENDGAME_SMALL_TILES + 5);
    launchAttack(s, 1, at(s, 20, 10), inf(3000));
    const gold = s.players[1].gold;
    for (let k = 0; k < 50 && s.players[2].alive; k++) step(s);
    expect(s.players[2].alive).toBe(false);
    expect(s.players[1].gold).toBeGreaterThan(gold + 1234 * 0.7 - 1e-6); // the treasury (after the capital loss) goes to the conqueror
    expect(s.map.owner[at(s, 30, 12)]).toBe(1);
    expect(s.events.some((e) => e.message.includes('collapsed'))).toBe(true);
  });

  it('pockets fully surrounded by one hostile nation are annexed; open or allied ones are not', () => {
    const s = makeFlatGame(60, 30, 3);
    claimRect(s, 1, 0, 0, 39, 29);
    claimRect(s, 2, 45, 0, 59, 29); // player 2's main body (touches neutral land at x 40..44)
    claimRect(s, 2, 10, 10, 14, 14); // a 25-tile pocket inside player 1
    claimRect(s, 2, 38, 0, 39, 1); // touches neutral land: not surrounded
    claimRect(s, 3, 0, 0, 0, 0); // player 3: one tile in a corner of player 1 (map edge doesn't count)
    claimRect(s, 3, 50, 0, 55, 5); // ... and its main body inside player 2
    expect(annexEnclaves(s)).toBeGreaterThan(0);
    expect(s.map.owner[at(s, 12, 12)]).toBe(1);
    expect(s.map.owner[at(s, 38, 0)]).toBe(2);
    expect(s.map.owner[at(s, 0, 0)]).toBe(1);
    // Player 3's main body (36 tiles < ENDGAME_SMALL_TILES) is surrounded by player 2: absorbed.
    expect(s.players[3].alive).toBe(false);
    expect(s.map.owner[at(s, 52, 2)]).toBe(2);
    expect(s.events.some((e) => e.message.includes('encircled pocket'))).toBe(true);

    const t = makeFlatGame(30, 30, 2);
    claimRect(t, 1, 0, 0, 29, 29);
    claimRect(t, 2, 10, 10, 12, 12);
    setOwner(t, at(t, 0, 0), 2);
    formAlliance(t, 1, 2);
    annexEnclaves(t);
    expect(t.map.owner[at(t, 11, 11)]).toBe(2); // allies keep their pockets
    expect(annexTiles(t, 2, 1, [at(t, 11, 11)])).toBe(1);
  });

  it('a small human is neither absorbed nor collapsed in its grace time, but warned; afterwards it is', () => {
    const s = makeFlatGame(40, 40, 2, { human: true });
    claimRect(s, 2, 0, 0, 39, 39);
    claimRect(s, 1, 15, 15, 23, 23); // the 81-tile start, walled in by player 2
    s.players[1].capital = at(s, 19, 19);
    s.tick = s.playStartTick + 60 * TICKS_PER_SECOND; // 1 minute into the game
    expect(collapseThreshold(s, s.players[1])).toBe(0);
    annexEnclaves(s);
    expect(s.players[1].alive).toBe(true);
    expect(s.players[1].tiles).toBe(81);
    expect(s.events.some((e) => e.kind === 'surrounded' && e.players[0] === 1)).toBe(true);
    s.tick = s.playStartTick + (humanGraceSeconds(s) + 1) * TICKS_PER_SECOND;
    expect(collapseThreshold(s, s.players[1])).toBe(ENDGAME_SMALL_TILES);
    annexEnclaves(s);
    expect(s.players[1].alive).toBe(false);
  });

  it('the human grace is longer on Easy and Normal (an idle new player is not swallowed at once), 3 min on Hard and Brutal', () => {
    const s = makeFlatGame(10, 10, 2, { human: true });
    const graceOf = (d: Difficulty): number => {
      s.settings.difficulty = d;
      return humanGraceSeconds(s);
    };
    expect(graceOf('hard')).toBe(HUMAN_GRACE_SECONDS);
    expect(graceOf('brutal')).toBe(HUMAN_GRACE_SECONDS);
    expect(graceOf('normal')).toBeGreaterThanOrEqual(300);
    expect(graceOf('easy')).toBeGreaterThanOrEqual(480);
    expect(graceOf('easy')).toBeGreaterThan(graceOf('normal'));
    s.settings.difficulty = 'easy';
    s.tick = s.playStartTick + (HUMAN_GRACE_SECONDS + 60) * TICKS_PER_SECOND;
    expect(collapseThreshold(s, s.players[1])).toBe(0);
    s.settings.difficulty = 'hard';
    expect(collapseThreshold(s, s.players[1])).toBe(ENDGAME_SMALL_TILES);
  });

  it('overtime lowers the land share needed to win by 1% a minute, down to 50%', () => {
    const s = makeFlatGame(10, 10, 2);
    expect(victoryShareNow(s)).toBe(VICTORY_LAND_SHARE);
    s.tick = OVERTIME_MINUTES * 60 * TICKS_PER_SECOND;
    expect(victoryShareNow(s)).toBe(VICTORY_LAND_SHARE);
    s.tick = (OVERTIME_MINUTES + 5) * 60 * TICKS_PER_SECOND;
    expect(victoryShareNow(s)).toBeCloseTo(VICTORY_LAND_SHARE - 0.05, 9);
    s.tick = (OVERTIME_MINUTES + 120) * 60 * TICKS_PER_SECOND;
    expect(victoryShareNow(s)).toBe(OVERTIME_MIN_SHARE);
    // 60% of the land wins in overtime.
    claimRect(s, 1, 0, 0, 9, 5);
    claimRect(s, 2, 0, 6, 9, 9);
    updateVictory(s);
    expect(s.winner).toBe(1);
  });
});

describe('tribes', () => {
  it('are created per map size, spawn at the end of the spawn phase, and are weak', () => {
    expect(tribeCountFor(testSettings({ tribeCount: -1, mapSize: 'large' }))).toBe(TRIBE_COUNT.large);
    expect(tribeCountFor(testSettings({ tribeCount: 3, mapSize: 'large' }))).toBe(3);
    const s = createGame(testSettings({ humanPlayer: false, aiCount: 3, tribeCount: 5 }));
    const tribes = s.players.filter((p) => isTribe(p));
    expect(tribes.length).toBe(5);
    expect(tribes.every((p) => p.name.startsWith('Tribe of') && !p.isHuman && p.personality === 'tribe')).toBe(true);
    for (let k = 0; k < SPAWN_SECONDS * TICKS_PER_SECOND - 1; k++) tick(s);
    expect(tribes.every((p) => !p.spawned)).toBe(true); // nations first
    tick(s);
    expect(s.phase).toBe('playing');
    expect(tribes.every((p) => p.spawned && p.tiles > 0)).toBe(true);
    const nation = s.players.find((p) => p.id > 0 && !isTribe(p))!;
    expect(troopSum(tribes[0].troops)).toBeLessThan(troopSum(nation.troops));
    for (let k = 0; k < 30 * TICKS_PER_SECOND; k++) tick(s);
    expect(tribes[0].maxPop).toBeLessThan(nation.maxPop);
    // They never attack nations.
    expect(s.attacks.some((a) => isTribe(s.players[a.attacker]) && a.target !== 0)).toBe(false);
  }, 30_000);

  it('in the first minutes an AI allies with a human only out of opinion', () => {
    const s = makeFlatGame(60, 10, 3, { human: true });
    claimRect(s, 1, 0, 0, 9, 9);
    claimRect(s, 2, 30, 0, 39, 9); // not neighbours, so not each other's last outlet or next target
    claimRect(s, 3, 50, 0, 59, 9);
    s.players[2].personality = 'turtle';
    s.opinion[2][1] = 0;
    s.tick = s.playStartTick + 60 * TICKS_PER_SECOND;
    expect(aiWantsAlliance(s, 2, 1)).toBe(false);
    s.opinion[2][1] = 90;
    expect(aiWantsAlliance(s, 2, 1)).toBe(true);
  });

  it('accept every alliance and never count for last nation standing', () => {
    const s = makeFlatGame(30, 10, 3);
    claimRect(s, 1, 0, 0, 9, 9);
    claimRect(s, 2, 10, 0, 19, 9);
    claimRect(s, 3, 20, 0, 29, 9);
    s.players[3].personality = 'tribe';
    s.opinion[3][1] = -90;
    expect(aiWantsAlliance(s, 3, 1)).toBe(true);
    s.players[1].traitorUntil = s.tick + 100; // ... but not a traitor (ally, break, ally again)
    expect(aiWantsAlliance(s, 3, 1)).toBe(false);
    s.players[1].traitorUntil = 0;
    updateVictory(s);
    expect(s.phase).toBe('playing');
    for (let x = 10; x < 20; x++) for (let y = 0; y < 10; y++) setOwner(s, at(s, x, y), 1);
    expect(s.players[2].alive).toBe(false);
    updateVictory(s);
    expect(s.phase).toBe('over');
    expect(s.winner).toBe(1);
  });
});

describe('start now', () => {
  it('ends the spawn phase once the human has picked a start', () => {
    const s = createGame(testSettings({ aiCount: 3, tribeCount: 2 }));
    expect(applyAction(s, 1, { type: 'startNow' }).ok).toBe(false); // not spawned yet
    let tile = -1;
    for (let t = 0; t < s.map.owner.length && tile < 0; t++) if (applyAction(s, 1, { type: 'spawn', tile: t }).ok) tile = t;
    expect(tile).toBeGreaterThanOrEqual(0);
    tick(s);
    // Re-picking during the spawn phase moves the start.
    const first = s.players[1].capital;
    let moved = false;
    for (let t = s.map.owner.length - 1; t >= 0 && !moved; t--) if (Math.abs(t - first) > 5000) moved = applyAction(s, 1, { type: 'spawn', tile: t }).ok;
    expect(moved).toBe(true);
    expect(s.map.owner[first]).toBe(0);
    expect(applyAction(s, 2, { type: 'startNow' }).ok).toBe(false); // AIs can't
    expect(applyAction(s, 1, { type: 'startNow' }).ok).toBe(true);
    tick(s);
    expect(s.phase).toBe('playing');
    expect(s.players.slice(1).every((p) => p.spawned || !p.alive)).toBe(true);
    expect(applyAction(s, 1, { type: 'startNow' }).ok).toBe(false);
    // Game time (clock, overtime, time limit) starts when the spawn phase really ended, not after SPAWN_SECONDS.
    expect(s.playStartTick).toBe(1);
    expect(s.playStartTick).toBeLessThan(SPAWN_SECONDS * TICKS_PER_SECOND);
    expect(gameSeconds(s)).toBeCloseTo((s.tick - 1) / TICKS_PER_SECOND, 9);
    s.tick = s.playStartTick + OVERTIME_MINUTES * 60 * TICKS_PER_SECOND - 1;
    expect(inOvertime(s)).toBe(false);
    s.tick += 1;
    expect(inOvertime(s)).toBe(true);
  });
});

describe('auto-manage', () => {
  it('humans start with the advisor on; setAuto toggles it; manual choices turn it off', () => {
    const s = makeFlatGame(40, 20, 2, { human: true });
    claimRect(s, 1, 0, 0, 19, 19);
    claimRect(s, 2, 20, 0, 39, 19);
    const me = s.players[1];
    expect(me.auto).toEqual({ mix: true, research: true });
    expect(s.players[2].auto).toEqual({ mix: false, research: false });
    expect(applyAction(s, 1, { type: 'setAuto', mix: false }).ok).toBe(true);
    expect(me.auto).toEqual({ mix: false, research: true });
    expect(applyAction(s, 1, { type: 'setAuto', mix: true }).ok).toBe(true);
    expect(applyAction(s, 1, { type: 'setArmyMix', armor: 0.2, artillery: 0.1 }).ok).toBe(true);
    expect(me.auto.mix).toBe(false);
    me.gold = 1000;
    expect(applyAction(s, 1, { type: 'research', tech: 'logistics' }).ok).toBe(true);
    expect(me.auto.research).toBe(false);
  });

  it('the advisor researches in order and sets a mix that counters the main foe', () => {
    const s = makeFlatGame(40, 20, 2, { human: true });
    claimRect(s, 1, 0, 0, 19, 19);
    claimRect(s, 2, 20, 0, 39, 19);
    const me = s.players[1];
    me.gold = 5000;
    me.oil = 1e6;
    addBuilding(s, 'factory', 1, at(s, 3, 3));
    addBuilding(s, 'arsenal', 1, at(s, 6, 6));
    s.players[2].troops = inf(5000); // an all-infantry foe on open plains
    expect(mainFoe(s, 1).foe).toBe(2);
    for (let k = 0; k < 40; k++) {
      updateAdvisor(s);
      s.tick++;
    }
    expect(me.researching).toBe('agriculture');
    expect(me.armyMix.armor).toBeGreaterThan(0.25); // open ground
    expect(me.armyMix.artillery).toBeGreaterThan(0.1); // against infantry
    expect(me.auto).toEqual({ mix: true, research: true });
    // No factory: no armor target.
    const mix = recommendMix(s, 2, { base: { armor: 0.3, artillery: 0.2 }, foe: 1, frontTiles: [], careful: true, army: 5000 });
    expect(mix.armor).toBeLessThanOrEqual(0.05);
  });
});

describe('alliance polish', () => {
  it('an attack cancels pending requests and stops trade for a while', () => {
    const s = makeFlatGame(40, 20, 2);
    claimRect(s, 1, 0, 0, 19, 19);
    claimRect(s, 2, 20, 0, 39, 19);
    expect(requestAlliance(s, 2, 1).ok).toBe(true);
    expect(launchAttack(s, 1, at(s, 20, 5), inf(200)).ok).toBe(true);
    expect(s.allianceRequests.length).toBe(0);
    expect(s.players[2].embargoes).toContain(1);
    s.attacks.length = 0; // the war is over
    expect(canTrade(s, 1, 2)).toBe(false);
    s.tick = AUTO_EMBARGO_SECONDS * TICKS_PER_SECOND + 10;
    s.tick -= s.tick % TICKS_PER_SECOND;
    updateDiplomacy(s);
    expect(s.players[2].embargoes).not.toContain(1);
    expect(canTrade(s, 1, 2)).toBe(true);
  });

  it('traitors are marked for TRAITOR_DURATION and defend at TRAITOR_DEFENSE', () => {
    const s = makeFlatGame(40, 20, 2);
    claimRect(s, 1, 0, 0, 19, 19);
    claimRect(s, 2, 20, 0, 39, 19);
    const before = estimateAttack(s, 2, at(s, 19, 5), inf(500))!.defensePerTile;
    formAlliance(s, 1, 2);
    expect(breakAlliance(s, 1, 2).ok).toBe(true);
    expect(s.players[1].traitorUntil).toBe(s.tick + TRAITOR_DURATION * TICKS_PER_SECOND);
    expect(estimateAttack(s, 2, at(s, 19, 5), inf(500))!.defensePerTile).toBeCloseTo(before * TRAITOR_DEFENSE, 6);
  });
});

describe('rules text', () => {
  it('explains interception and the other new rules for the help page', () => {
    expect(RULES_TEXT.interception).toMatch(/SAM/);
    expect(RULES_TEXT.interception).toMatch(/atom bomb needs 2/);
    expect(Object.values(RULES_TEXT).every((t) => typeof t === 'string' && t.length > 40)).toBe(true);
  });
});
