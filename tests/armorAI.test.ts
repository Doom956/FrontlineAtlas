// Smarter tank divisions (armor2.ts): steady fronts between attack waves, strikes together, lines that cut the
// enemy's land, off a spearhead's thin tip, by difficulty (Easy keeps the old habits) and for a player's divisions
// on their automatic modes.
import { describe, expect, it } from 'vitest';
import { applyAction } from '../src/sim/actions';
import { aiDivisionModes, armorLevel, bestStrike, cutClicks } from '../src/sim/armor2';
import { markBuildingsChanged } from '../src/sim/buildings';
import { TICKS_PER_SECOND } from '../src/sim/config';
import { hashState } from '../src/sim/hash';
import { updateWarMemory } from '../src/sim/naval2';
import { tick } from '../src/sim/sim';
import { newId, setOwner } from '../src/sim/state';
import { spawnTankDivision } from '../src/sim/tanks';
import type { Building, Difficulty, GameState } from '../src/sim/types';
import { claimRect, makeFlatGame } from './helpers';

const at = (s: GameState, x: number, y: number): number => y * s.map.width + x;

/** 60x30 plains: player 1 owns x 0..29 (AI unless human), player 2 (AI) x 30..59; AIs frozen (only our calls act). */
function game(difficulty: Difficulty = 'normal', human = false, seed = 5): GameState {
  const s = makeFlatGame(60, 30, 2, { human, seed });
  claimRect(s, 1, 0, 0, 29, 29);
  claimRect(s, 2, 30, 0, 59, 29);
  s.players[2].capital = at(s, 55, 15);
  s.settings.difficulty = difficulty;
  s.settings.victoryLandShare = 0.99;
  s.admin = { aiPassive: [], godMode: [], aiFrozen: true, revealIntel: [] };
  for (const p of s.players) {
    if (p.id === 0) continue;
    p.gold = 1e6;
    p.iron = 1e5;
    p.oil = 1e5;
    p.personality = 'warlord';
  }
  s.players[1].techs.push('mechanization');
  s.players[1].troops = { infantry: 50000, armor: 20000, artillery: 5000 };
  s.players[2].troops = { infantry: 20000, armor: 0, artillery: 0 };
  return s;
}
function factory(s: GameState, tile: number): Building {
  const id = newId(s);
  const b: Building = { id, type: 'factory', owner: 1, tile, level: 2, buildLeft: 0, upgradeLeft: 0, fighters: 0, bombers: 0, cooldown: 0, dropCooldown: 0, disabledUntil: 0, hp: 1, queuedLevels: 0 };
  s.buildings.set(id, b);
  s.map.building[tile] = id + 1;
  markBuildingsChanged(s);
  return b;
}
function asAI<T>(s: GameState, fn: () => T): T {
  s.admin!.aiFrozen = false;
  try {
    return fn();
  } finally {
    s.admin!.aiFrozen = true;
  }
}
/** One short wave of player 1 on player 2 (it ends at once); the war stays live in the war memory. */
function wave(s: GameState, by = 1, tile = at(s, 30, 2)): void {
  expect(asAI(s, () => applyAction(s, by, { type: 'attack', tile, troops: { infantry: 4000, armor: 0, artillery: 0 } })).ok).toBe(true);
  while (s.tick % TICKS_PER_SECOND !== 0) s.tick++;
  updateWarMemory(s);
  s.attacks = s.attacks.filter((a) => a.attacker !== by);
}
/** A finger of player 2's land 3 tiles wide (y 14..16) reaching from the border into ours to x = 10. */
function finger(s: GameState): void {
  for (let x = 10; x <= 29; x++) for (let y = 14; y <= 16; y++) setOwner(s, at(s, x, y), 2);
}

describe('steady fronts between attack waves', () => {
  it('from Normal up an AI keeps its divisions on support at the front between waves; Easy stands them down', () => {
    for (const d of ['normal', 'hard', 'easy'] as Difficulty[]) {
      const s = game(d);
      const div = spawnTankDivision(s, 1, at(s, 20, 20));
      expect(asAI(s, () => applyAction(s, 1, { type: 'attack', tile: at(s, 30, 20), troops: { infantry: 4000, armor: 0, artillery: 0 } })).ok).toBe(true);
      asAI(s, () => aiDivisionModes(s, 1, (a) => applyAction(s, 1, a)));
      expect(div.mode).toBe('support');
      const station = div.station;
      wave(s); // the attack is over, the war is not
      expect(s.attacks.length).toBe(0);
      asAI(s, () => aiDivisionModes(s, 1, (a) => applyAction(s, 1, a)));
      if (d === 'easy') expect(div.mode).toBe('hold');
      else {
        expect(div.mode).toBe('support');
        expect(div.station).toBe(station);
      }
    }
  });

  it('a player\'s divisions count as Normal at every difficulty; AI ones follow the difficulty', () => {
    const s = game('easy', true);
    expect(armorLevel(s, 1)).toBe(1);
    expect(armorLevel(s, 2)).toBe(0);
    s.settings.difficulty = 'brutal';
    expect(armorLevel(s, 2)).toBe(3);
  });
});

describe('lines that cut', () => {
  it('finds the lines across an enemy finger in our land, with the piece they would close off', () => {
    const s = game('normal');
    finger(s);
    wave(s);
    const cuts = cutClicks(s, 1, 18, 12, 10, 6);
    expect(cuts.length).toBeGreaterThan(0);
    const y = (cuts[0].click / s.map.width) | 0;
    expect(y).toBeGreaterThanOrEqual(14);
    expect(y).toBeLessThanOrEqual(16);
    expect(cuts[0].pocket).toBeGreaterThan(10); // the finger's tip west of the cut
    expect(cuts[0].pocket).toBeLessThan(60);
    // Not at war: nothing to cut.
    const t = game('normal');
    finger(t);
    expect(cutClicks(t, 1, 18, 12, 10, 6).length).toBe(0);
  });

  it('an AI division on support cuts the finger off and the cut-off part collapses to us', () => {
    const s = game('normal');
    finger(s);
    const div = spawnTankDivision(s, 1, at(s, 18, 10));
    asAI(s, () => applyAction(s, 1, { type: 'setDivisionMode', unitIds: [div.id], mode: 'support', front: at(s, 18, 14) }));
    wave(s);
    for (let k = 0; k < 300 && s.map.owner[at(s, 11, 15)] === 2; k++) tick(s);
    expect(s.map.owner[at(s, 11, 15)]).toBe(1); // the finger's tip is ours
  });
});

describe('strikes together', () => {
  it('from Normal up the ready divisions near a strike go in together, side by side; Easy goes one at a time', () => {
    for (const d of ['normal', 'easy'] as Difficulty[]) {
      const s = game(d);
      const a = spawnTankDivision(s, 1, at(s, 24, 12));
      const b = spawnTankDivision(s, 1, at(s, 24, 18));
      asAI(s, () => applyAction(s, 1, { type: 'setDivisionMode', unitIds: [a.id, b.id], mode: 'support', front: at(s, 30, 15) }));
      wave(s);
      const moving = (): number => [a, b].filter((u) => u.state === 2 || u.state === 3).length;
      let first = 0;
      for (let k = 0; k < 200 && !(first = moving()); k++) tick(s);
      expect(first).toBe(d === 'easy' ? 1 : 2);
    }
  });
});

describe("off a spearhead's thin tip", () => {
  /** Our finger (y 15, x 30..40) into player 2 with the division at its tip, just after a spearhead ended there. */
  function tip(human: boolean): { s: GameState; id: number } {
    const s = game('normal', human);
    for (let x = 30; x <= 40; x++) setOwner(s, at(s, x, 15), 1);
    const div = spawnTankDivision(s, 1, at(s, 40, 15));
    for (const k of ['armor', 'infantry', 'artillery'] as const) div.troops[k] *= 0.45; // worn: no strike on from there
    asAI(s, () => applyAction(s, 1, { type: 'setDivisionMode', unitIds: [div.id], mode: 'support', front: at(s, 41, 15) }));
    div.ended = s.tick;
    return { s, id: div.id };
  }
  it("a player's division on support pulls back off the tip after its spearhead, unless the player moved it there", () => {
    const a = tip(true);
    for (let k = 0; k < 40; k++) tick(a.s);
    expect(a.s.units.find((u) => u.id === a.id)!.x).toBeLessThan(30);
    const b = tip(true);
    const u = b.s.units.find((q) => q.id === b.id)!;
    expect(applyAction(b.s, 1, { type: 'moveTankDivision', unitIds: [u.id], tile: at(b.s, 40, 15) }).ok).toBe(true);
    expect(u.ended).toBeUndefined();
    for (let k = 0; k < 40; k++) tick(b.s);
    expect(u.x).toBe(40);
  });
});

describe('determinism', () => {
  it('the last spearhead end is part of the hash, and two games with the new habits hash the same', () => {
    const s = game('hard');
    const div = spawnTankDivision(s, 1, at(s, 20, 15));
    const h0 = hashState(s);
    div.ended = 7;
    expect(hashState(s)).not.toBe(h0);
    const go = (): number => {
      const g = game('hard', false, 9);
      finger(g);
      factory(g, at(g, 4, 4));
      const a = spawnTankDivision(g, 1, at(g, 20, 8));
      const b = spawnTankDivision(g, 1, at(g, 20, 22));
      g.admin!.aiFrozen = false;
      g.players[2].troops = { infantry: 60000, armor: 0, artillery: 0 };
      void a;
      void b;
      for (let k = 0; k < 900; k++) tick(g);
      return hashState(g);
    };
    expect(go()).toBe(go());
  });
});
