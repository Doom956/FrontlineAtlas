// Seasons (src/sim/seasons.ts, game rule Modifiers.seasonEffects): the cycle, the effects and their switch, the snow
// line, sea ice, the AI plan, the hash and determinism.
import { describe, expect, it } from 'vitest';
import { applyAction } from '../src/sim/actions';
import { aiDivisionModes } from '../src/sim/armor2';
import { markBuildingsChanged } from '../src/sim/buildings';
import { estimateAttack } from '../src/sim/combat';
import { SEASON, TICKS_PER_SECOND } from '../src/sim/config';
import { goldIncome } from '../src/sim/economy';
import { hashState } from '../src/sim/hash';
import {
  aiArmorPause,
  aiSeasonTrigger,
  harvestGoldMul,
  iceBand,
  iceRowsFor,
  isIcedTile,
  isSnowTile,
  SEASON_TICKS,
  seasonAt,
  seasonAtTick,
  seasonEffectLine,
  seasonTankSpeed,
  snowLineRows,
  snowMaxRows,
  snowRowsAt,
} from '../src/sim/seasons';
import { activeModifiers, DEFAULT_MODIFIERS, DEFAULT_SETUP, sanitizeSetup, validateSetup } from '../src/sim/setup';
import { tick } from '../src/sim/sim';
import { newId } from '../src/sim/state';
import { spawnTankDivision } from '../src/sim/tanks';
import { spawnWarshipAt, moveWarship } from '../src/sim/units';
import { Resource, Terrain } from '../src/sim/types';
import type { Building, GameState } from '../src/sim/types';
import { computeCoastAndLand } from '../src/sim/mapgen';
import { validateLobbySettings } from '../server/validate';
import { claimRect, makeFlatGame, makeTestGame } from './helpers';

const at = (s: GameState, x: number, y: number): number => y * s.map.width + x;
/** Puts the game `k` seasons (and `into` ticks) after the start: 0 spring, 1 summer, 2 autumn, 3 winter, 4 spring again. */
function setSeason(s: GameState, k: number, into = 0): void {
  s.playStartTick = s.tick - (k * SEASON_TICKS + into);
}
function noEffects(s: GameState): void {
  s.settings.modifiers = { ...s.settings.modifiers, seasonEffects: false };
}
function run(s: GameState, n: number): void {
  for (let k = 0; k < n; k++) tick(s);
}

describe('season cycle', () => {
  it('Spring, Summer, Autumn, Winter, 4 minutes each, from the play clock', () => {
    expect(SEASON.seconds).toBe(240);
    expect(SEASON_TICKS).toBe(240 * TICKS_PER_SECOND);
    expect(seasonAtTick(0)).toMatchObject({ season: 'spring', index: 0, progress: 0, secondsLeft: 240, count: 0 });
    expect(seasonAtTick(SEASON_TICKS - 1).season).toBe('spring');
    expect(seasonAtTick(SEASON_TICKS).season).toBe('summer');
    expect(seasonAtTick(2 * SEASON_TICKS).season).toBe('autumn');
    const w = seasonAtTick(3 * SEASON_TICKS + SEASON_TICKS / 2);
    expect(w).toMatchObject({ season: 'winter', progress: 0.5, secondsLeft: 120 });
    expect(seasonAtTick(4 * SEASON_TICKS)).toMatchObject({ season: 'spring', count: 4 });
    expect(seasonAtTick(0, 3).season).toBe('winter');
  });

  it('the spawn phase is the start of spring; the clock runs from the end of it', () => {
    const s = makeTestGame();
    s.phase = 'spawn';
    s.tick = 500;
    expect(seasonAt(s)).toMatchObject({ season: 'spring', progress: 0 });
    s.phase = 'playing';
    s.playStartTick = 500 - SEASON_TICKS;
    expect(seasonAt(s).season).toBe('summer');
  });
});

describe('the Season effects rule', () => {
  it('is on by default, validated, kept by the lobby and shows a chip only when off', () => {
    expect(DEFAULT_MODIFIERS.seasonEffects).toBe(true);
    expect(DEFAULT_SETUP.modifiers.seasonEffects).toBe(true);
    expect(validateSetup({ modifiers: { seasonEffects: false } })).toBeNull();
    expect(validateSetup({ modifiers: { seasonEffects: 'no' } })).toMatch(/seasonEffects/);
    const v = validateLobbySettings({ modifiers: { seasonEffects: false } });
    expect(v.ok && v.value.modifiers?.seasonEffects).toBe(false);
    const old = JSON.parse(JSON.stringify(DEFAULT_SETUP));
    delete old.modifiers.seasonEffects; // a lobby saved before the rule
    expect(sanitizeSetup(old).modifiers.seasonEffects).toBe(true);
    expect(activeModifiers(DEFAULT_SETUP).some((m) => m.id === 'seasonEffects')).toBe(false);
    const off = { ...DEFAULT_SETUP, modifiers: { ...DEFAULT_SETUP.modifiers, seasonEffects: false } };
    expect(activeModifiers(off).find((m) => m.id === 'seasonEffects')?.label).toBe('Seasons look only');
  });

  it('effect lines in plain words', () => {
    const s = makeTestGame();
    setSeason(s, 3);
    expect(seasonEffectLine(s)).toMatch(/^Attacks through snow are slower/);
    setSeason(s, 0);
    expect(seasonEffectLine(s)).toMatch(/^Mud/);
    noEffects(s);
    expect(seasonEffectLine(s)).toBe('Season effects are off in this game');
  });
});

/** 60x40 plains: player 1 owns x 0..29, player 2 x 30..59; AI frozen. */
function landGame(): GameState {
  const s = makeFlatGame(60, 40, 2, { human: true, seed: 5 });
  claimRect(s, 1, 0, 0, 29, 39);
  claimRect(s, 2, 30, 0, 59, 39);
  s.admin = { aiPassive: [], godMode: [], aiFrozen: true, revealIntel: [] };
  s.settings.victoryLandShare = 0.99;
  s.players[1].troops = { infantry: 50000, armor: 30000, artillery: 0 };
  s.players[2].troops = { infantry: 20000, armor: 0, artillery: 0 };
  return s;
}

describe('spring mud', () => {
  it('slows tanks on plains and fertile land by a quarter, attacks by their armor share', () => {
    const s = landGame();
    const mid = at(s, 30, 20);
    const armor = { infantry: 0, armor: 20000, artillery: 0 };
    const inf = { infantry: 20000, armor: 0, artillery: 0 };
    setSeason(s, 1);
    const summerA = estimateAttack(s, 1, mid, armor, 20)!.tilesPerSecond;
    const summerI = estimateAttack(s, 1, mid, inf, 20)!.tilesPerSecond;
    expect(seasonTankSpeed(s, mid)).toBe(1);
    setSeason(s, 0, 100);
    expect(estimateAttack(s, 1, mid, armor, 20)!.tilesPerSecond).toBeCloseTo(summerA * SEASON.mudArmor, 6);
    expect(estimateAttack(s, 1, mid, inf, 20)!.tilesPerSecond).toBeCloseTo(summerI, 6);
    expect(seasonTankSpeed(s, mid)).toBe(SEASON.mudArmor);
    // forest is not mud; fertile forest is (farmland)
    s.map.terrain[mid] = Terrain.Forest;
    expect(seasonTankSpeed(s, mid)).toBe(1);
    s.map.resource[mid] = Resource.Fertile;
    expect(seasonTankSpeed(s, mid)).toBe(SEASON.mudArmor);
    noEffects(s);
    expect(seasonTankSpeed(s, mid)).toBe(1);
  });

  it('a tank division spearhead gets less far in spring mud than in summer', () => {
    const depth = (k: number): number => {
      const s = landGame();
      s.players[1].techs.push('mechanization');
      setSeason(s, k, 10);
      const d = spawnTankDivision(s, 1, at(s, 25, 20));
      expect(applyAction(s, 1, { type: 'moveTankDivision', unitIds: [d.id], tile: at(s, 34, 20) })).toEqual({ ok: true });
      const out: number[] = [];
      for (let k = 0; k < 4; k++) {
        run(s, 5);
        let taken = 0;
        for (let x = 30; x < 60; x++) if (s.map.owner[at(s, x, 20)] === 1) taken++;
        out.push(taken);
      }
      return out[3];
    };
    const summer = depth(1);
    const spring = depth(0);
    expect(summer).toBeGreaterThan(8);
    expect(spring).toBeLessThan(summer);
    expect(spring).toBeGreaterThan(summer * 0.6);
  });
});

describe('autumn harvest', () => {
  it('farms add gold in autumn only, 2% per farm level up to 10%, and not with effects off', () => {
    const s = landGame();
    const farmAt = (x: number, level: number): void => {
      const id = newId(s);
      const t = at(s, x, 5);
      const b: Building = { id, type: 'farm', owner: 1, tile: t, level, buildLeft: 0, upgradeLeft: 0, fighters: 0, bombers: 0, cooldown: 0, dropCooldown: 0, disabledUntil: 0, hp: 1, queuedLevels: 0 };
      s.buildings.set(id, b);
      s.map.building[t] = id + 1;
      markBuildingsChanged(s);
    };
    farmAt(5, 2);
    setSeason(s, 1);
    const summer = goldIncome(s, s.players[1]);
    setSeason(s, 2);
    expect(harvestGoldMul(s, 2)).toBeCloseTo(1.04, 9);
    expect(goldIncome(s, s.players[1])).toBeCloseTo(summer * 1.04, 6);
    farmAt(10, 5);
    expect(goldIncome(s, s.players[1])).toBeCloseTo(summer * (1 + SEASON.harvestMax), 6);
    noEffects(s);
    expect(goldIncome(s, s.players[1])).toBeCloseTo(summer, 6);
  });
});

describe('winter snow', () => {
  it('the snow line moves from the poles over winter, holds, and recedes in spring', () => {
    const h = 200;
    const max = snowMaxRows(h);
    expect(max).toBe(44);
    expect(snowRowsAt(0, h)).toBe(0); // the first spring has no snow
    expect(snowRowsAt(SEASON_TICKS + 5, h)).toBe(0);
    expect(snowRowsAt(2 * SEASON_TICKS + 5, h)).toBe(0);
    const w0 = 3 * SEASON_TICKS;
    const rows = [0, 0.15, 0.3, 0.45, 0.6, 0.8, 0.99].map((f) => snowRowsAt(w0 + Math.floor(f * SEASON_TICKS), h));
    for (let k = 1; k < rows.length; k++) expect(rows[k]).toBeGreaterThanOrEqual(rows[k - 1]);
    expect(rows[0]).toBe(0);
    expect(rows[2]).toBeGreaterThan(0);
    expect(rows[2]).toBeLessThan(max);
    expect(rows[4]).toBe(max);
    expect(rows[6]).toBe(max);
    const sp = 4 * SEASON_TICKS;
    expect(snowRowsAt(sp, h)).toBe(max);
    expect(snowRowsAt(sp + SEASON_TICKS / 5, h)).toBeLessThan(max);
    expect(snowRowsAt(sp + SEASON_TICKS / 2, h)).toBe(0);
  });

  it('attacks through snow are 25% slower, tanks 40%; tundra is snow in winter; off = no slowdown', () => {
    const s = landGame();
    const north = at(s, 30, 1);
    const south = at(s, 30, 38);
    const mid = at(s, 30, 20);
    const armor = { infantry: 0, armor: 20000, artillery: 0 };
    const inf = { infantry: 20000, armor: 0, artillery: 0 };
    setSeason(s, 1);
    const baseA = estimateAttack(s, 1, north, armor, 20)!.tilesPerSecond;
    const baseI = estimateAttack(s, 1, north, inf, 20)!.tilesPerSecond;
    setSeason(s, 3, SEASON_TICKS - 10);
    expect(snowLineRows(s)).toEqual({ north: snowMaxRows(40), south: 40 - snowMaxRows(40) });
    expect(isSnowTile(s, north)).toBe(true);
    expect(isSnowTile(s, south)).toBe(true);
    expect(isSnowTile(s, mid)).toBe(false);
    expect(estimateAttack(s, 1, north, inf, 20)!.tilesPerSecond).toBeCloseTo(baseI * SEASON.snowInfantry, 6);
    expect(estimateAttack(s, 1, south, armor, 20)!.tilesPerSecond).toBeCloseTo(baseA * SEASON.snowArmor, 6);
    expect(estimateAttack(s, 1, mid, inf, 20)!.tilesPerSecond).toBeCloseTo(baseI, 6);
    expect(seasonTankSpeed(s, north)).toBe(SEASON.snowArmor);
    s.map.terrain[mid] = Terrain.Tundra;
    expect(isSnowTile(s, mid)).toBe(true);
    expect(seasonTankSpeed(s, mid)).toBe(SEASON.snowArmor);
    noEffects(s);
    expect(isSnowTile(s, north)).toBe(true); // still shows
    expect(estimateAttack(s, 1, north, inf, 20)!.tilesPerSecond).toBeCloseTo(baseI, 6);
  });
});

/** 40x60 sea with a land strip at rows 50..56 (players 1 and 2), a warship of player 1 in mid sea. */
function seaGame(): { s: GameState; shipId: number } {
  const s = makeFlatGame(40, 60, 2, { human: true, seed: 9, terrain: Terrain.DeepWater });
  for (let y = 50; y <= 56; y++) for (let x = 0; x < 40; x++) s.map.terrain[at(s, x, y)] = Terrain.Plains;
  computeCoastAndLand(s.map);
  claimRect(s, 1, 0, 50, 19, 56);
  claimRect(s, 2, 20, 50, 39, 56);
  s.admin = { aiPassive: [], godMode: [], aiFrozen: true, revealIntel: [] };
  s.settings.victoryLandShare = 0.99;
  const ship = spawnWarshipAt(s, 1, at(s, 10, 50), at(s, 20, 30));
  return { s, shipId: ship.id };
}

describe('sea ice', () => {
  it('a band near the top and bottom edge freezes in winter only', () => {
    expect(iceRowsFor(60)).toBe(3);
    expect(iceRowsFor(20)).toBe(SEASON.iceMinRows);
    const { s } = seaGame();
    setSeason(s, 2);
    expect(iceBand(s)).toEqual({ north: 0, south: 60 });
    expect(isIcedTile(s, at(s, 5, 0))).toBe(false);
    setSeason(s, 3);
    expect(iceBand(s)).toEqual({ north: 3, south: 57 });
    expect(isIcedTile(s, at(s, 5, 2))).toBe(true);
    expect(isIcedTile(s, at(s, 5, 3))).toBe(false);
    expect(isIcedTile(s, at(s, 5, 58))).toBe(true);
  });

  it('ships stop at the ice edge in winter and sail on in spring; with effects off they sail through', () => {
    const sail = (k: number, off = false): number => {
      const { s, shipId } = seaGame();
      if (off) noEffects(s);
      setSeason(s, k, k === 3 ? 10 : 0);
      expect(moveWarship(s, 1, shipId, at(s, 20, 0)).ok).toBe(true);
      run(s, 400);
      return s.units.find((u) => u.id === shipId)!.y;
    };
    expect(sail(1)).toBe(0);
    expect(sail(3)).toBeGreaterThanOrEqual(3);
    expect(sail(3, true)).toBe(0);
  });

  it('a ship caught in the ice when it forms sails out', () => {
    const { s, shipId } = seaGame();
    const u = s.units.find((q) => q.id === shipId)!;
    u.x = 20;
    u.y = 1;
    u.path = [];
    u.pathPos = 0;
    setSeason(s, 3, 10);
    expect(moveWarship(s, 1, shipId, at(s, 20, 20)).ok).toBe(true);
    for (let k = 0; k < 400 && u.state === 1; k++) tick(s);
    expect(u.state).toBe(0); // arrived, now on patrol there
    expect(u.y).toBe(20);
  });
});

describe('AI season plan', () => {
  it('pushes sooner in summer and early autumn, holds in winter, waits with armor in mud and snow', () => {
    const s = landGame();
    setSeason(s, 1);
    expect(aiSeasonTrigger(s)).toBe(SEASON.aiPushTrigger);
    expect(aiArmorPause(s)).toBe(false);
    setSeason(s, 2, SEASON_TICKS * 0.7);
    expect(aiSeasonTrigger(s)).toBe(1);
    setSeason(s, 3);
    expect(aiSeasonTrigger(s)).toBe(SEASON.aiWinterTrigger);
    expect(aiArmorPause(s)).toBe(true);
    setSeason(s, 0);
    expect(aiArmorPause(s)).toBe(true);
    noEffects(s);
    expect(aiArmorPause(s)).toBe(false);
    expect(aiSeasonTrigger(s)).toBe(1);
  });

  it('AI divisions hold instead of supporting a push in spring mud; in summer they support it', () => {
    const mode = (k: number): string | undefined => {
      const s = landGame();
      s.players[1].isHuman = false;
      s.players[2].isHuman = false;
      s.admin = undefined;
      s.players[2].troops = { infantry: 60000, armor: 30000, artillery: 0 };
      s.players[2].techs.push('mechanization');
      setSeason(s, k, 50);
      const d = spawnTankDivision(s, 2, at(s, 40, 20));
      d.mode = 'support';
      expect(applyAction(s, 2, { type: 'attack', tile: at(s, 29, 20), troops: { infantry: 30000, armor: 0, artillery: 0 } })).toEqual({ ok: true });
      aiDivisionModes(s, 2, (a) => applyAction(s, 2, a));
      return d.mode;
    };
    expect(mode(1)).toBe('support');
    expect(mode(0)).toBe('hold');
  });
});

describe('hash and determinism', () => {
  it('the hash covers the rule and the play clock', () => {
    const s = makeTestGame({ seed: 4 });
    const h = hashState(s);
    noEffects(s);
    expect(hashState(s)).not.toBe(h);
    s.settings.modifiers.seasonEffects = true;
    expect(hashState(s)).toBe(h);
    s.playStartTick -= 1;
    expect(hashState(s)).not.toBe(h);
  });

  it('two games through a winter and into spring agree tick for tick (snow and ice are derived, not stored)', () => {
    const mk = (): GameState => {
      const s = makeTestGame({ seed: 7, aiCount: 3 });
      setSeason(s, 3, SEASON_TICKS - 150);
      return s;
    };
    const a = mk();
    const b = mk();
    for (let k = 0; k < 300; k++) {
      tick(a);
      tick(b);
      if (k % 50 === 0) expect(hashState(a)).toBe(hashState(b));
    }
    expect(seasonAt(a).season).toBe('spring');
    expect(hashState(a)).toBe(hashState(b));
    expect(snowLineRows(a)).toEqual(snowLineRows(b));
  });
});
