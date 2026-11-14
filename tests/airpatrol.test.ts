// Superiority patrols fly where the enemy's bombers aim (airwings.patrolCentre): AI nations from Normal up, a player's
// following wings.
import { describe, expect, it } from 'vitest';
import { applyAction } from '../src/sim/actions';
import { markBuildingsChanged } from '../src/sim/buildings';
import { aiAirWings, patrolCentre, wingOf } from '../src/sim/airwings';
import { hashState } from '../src/sim/hash';
import { tick } from '../src/sim/sim';
import { newId } from '../src/sim/state';
import type { Building, Difficulty, GameState, Unit } from '../src/sim/types';
import { claimRect, makeFlatGame } from './helpers';

const at = (s: GameState, x: number, y: number): number => y * s.map.width + x;

/** 240x40 plains: player 1 (human) x 0..119, player 2 (AI) x 120..239; AIs frozen. */
function airGame(difficulty: Difficulty = 'normal'): GameState {
  const s = makeFlatGame(240, 40, 2, { human: true, seed: 3 });
  claimRect(s, 1, 0, 0, 119, 39);
  claimRect(s, 2, 120, 0, 239, 39);
  s.settings.difficulty = difficulty;
  s.settings.victoryLandShare = 0.99;
  s.admin = { aiPassive: [], godMode: [], aiFrozen: true, revealIntel: [] };
  for (const p of s.players.slice(1)) {
    p.gold = 1e6;
    p.iron = 1e5;
    p.oil = 1e5;
    p.techs.push('flight');
  }
  return s;
}
function airfield(s: GameState, owner: number, x: number, y: number, fighters = 3, bombers = 0): Building {
  const id = newId(s);
  const b: Building = { id, type: 'airfield', owner, tile: at(s, x, y), level: 1, buildLeft: 0, upgradeLeft: 0, fighters, bombers, cooldown: 0, dropCooldown: 0, disabledUntil: 0, hp: 1, queuedLevels: 0 };
  s.buildings.set(id, b);
  s.map.building[b.tile] = id + 1;
  markBuildingsChanged(s);
  return b;
}
/** A bomber of `owner` flying from (x, y) to the tile (tx, ty). */
function bomber(s: GameState, owner: number, x: number, y: number, tx: number, ty: number): Unit {
  const u: Unit = { id: newId(s), type: 'bomber', owner, x, y, target: at(s, tx, ty), home: at(s, x, y), path: [], pathPos: 0, troops: { infantry: 0, armor: 0, artillery: 0 }, hp: 1, cargo: 0, state: 0, targetOwner: 0 };
  s.units.push(u);
  return u;
}

describe('superiority patrols where the enemy bombers aim', () => {
  it('patrolCentre: the aim the most enemy bombers fly at, within the centre reach; none without bombers', () => {
    const s = airGame();
    const b = airfield(s, 2, 230, 20);
    expect(patrolCentre(s, 2, b)).toBe(-1);
    bomber(s, 1, 60, 20, 130, 10);
    bomber(s, 1, 60, 22, 132, 12);
    bomber(s, 1, 60, 24, 200, 35);
    expect(patrolCentre(s, 2, b)).toBe(at(s, 130, 10));
    // A bomber aimed at its own side's land is no threat.
    const s2 = airGame();
    const b2 = airfield(s2, 2, 230, 20);
    bomber(s2, 1, 60, 20, 30, 10);
    expect(patrolCentre(s2, 2, b2)).toBe(-1);
  });

  it('an AI patrol (Normal and up) flies there instead of over its airfield; Easy keeps the airfield', () => {
    for (const d of ['normal', 'easy'] as Difficulty[]) {
      const s = airGame(d);
      const b = airfield(s, 2, 230, 20);
      bomber(s, 1, 60, 20, 130, 10);
      s.admin!.aiFrozen = false;
      aiAirWings(s, 2, [], true);
      s.admin!.aiFrozen = true;
      const wing = wingOf(s, b)!;
      expect(wing.mission).toBe('superiority');
      expect(wing.target).toBe(d === 'easy' ? -1 : at(s, 130, 10));
    }
  });

  it("a player's following patrol goes where the enemy bombers aim", () => {
    const s = airGame();
    const b = airfield(s, 1, 10, 20);
    expect(applyAction(s, 1, { type: 'setAirMission', airfield: b.tile, mission: 'superiority' }).ok).toBe(true);
    bomber(s, 2, 200, 20, 100, 30);
    for (let k = 0; k < 120 && wingOf(s, b)!.target !== at(s, 100, 30); k++) tick(s);
    expect(wingOf(s, b)!.target).toBe(at(s, 100, 30));
  });

  it('deterministic: two games with patrols hash the same', () => {
    const play = (): number => {
      const s = airGame();
      airfield(s, 2, 230, 20);
      bomber(s, 1, 60, 20, 130, 10);
      s.admin!.aiFrozen = false;
      aiAirWings(s, 2, [], true);
      for (let k = 0; k < 100; k++) tick(s);
      return hashState(s);
    };
    expect(play()).toBe(play());
  });
});
