// Blitz (blitz.ts): a tank division's special order with Armor Mastery: rules, held land, cooldown, AI use, hash.
import { describe, expect, it } from 'vitest';
import { applyAction } from '../src/sim/actions';
import { blitzBlock, blitzPreview, heldBy } from '../src/sim/blitz';
import { BLITZ, BLITZ_NAME, TICKS_PER_SECOND } from '../src/sim/config';
import { hashState } from '../src/sim/hash';
import { updateWarMemory } from '../src/sim/naval2';
import { tick } from '../src/sim/sim';
import { setOwner } from '../src/sim/state';
import { spawnTankDivision, spearheadPreview } from '../src/sim/tanks';
import type { Difficulty, GameState, Unit } from '../src/sim/types';
import { validateAction } from '../server/validate';
import { claimRect, makeFlatGame } from './helpers';

const at = (s: GameState, x: number, y: number): number => y * s.map.width + x;

/** 120x40 plains: player 1 owns x 0..39, player 2 (AI) x 40..119; player 1 has Armor Mastery. AIs frozen. */
function game(difficulty: Difficulty = 'normal', human = true): GameState {
  const s = makeFlatGame(120, 40, 2, { human, seed: 4 });
  claimRect(s, 1, 0, 0, 39, 39);
  claimRect(s, 2, 40, 0, 119, 39);
  s.players[2].capital = at(s, 115, 20);
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
  s.players[1].techs.push('mechanization', 'armorMastery');
  s.players[1].troops = { infantry: 50000, armor: 20000, artillery: 5000 };
  s.players[2].troops = { infantry: 30000, armor: 0, artillery: 0 };
  return s;
}
function asAI<T>(s: GameState, fn: () => T): T {
  s.admin!.aiFrozen = false;
  try {
    return fn();
  } finally {
    s.admin!.aiFrozen = true;
  }
}
const run = (s: GameState, n: number): void => {
  for (let k = 0; k < n; k++) tick(s);
};
const untilEnd = (s: GameState, d: Unit): void => {
  for (let k = 0; k < 400 && !(d.state === 0 && d.launch === undefined && s.tick > 5); k++) tick(s);
};

describe('the rules', () => {
  it('needs Armor Mastery, strength, oil and a recharged division; says why in plain words', () => {
    const s = game();
    const d = spawnTankDivision(s, 1, at(s, 36, 20));
    expect(blitzBlock(s, 1, d)).toBe('');
    s.players[1].techs = s.players[1].techs.filter((t) => t !== 'armorMastery');
    expect(blitzBlock(s, 1, d)).toBe('Needs Armor Mastery');
    s.players[1].techs.push('armorMastery');
    s.players[1].oil = BLITZ.oil - 1;
    expect(blitzBlock(s, 1, d)).toBe(`Needs ${BLITZ.oil} oil`);
    s.players[1].oil = 1e5;
    for (const k of ['armor', 'infantry', 'artillery'] as const) d.troops[k] *= 0.4;
    expect(blitzBlock(s, 1, d)).toMatch(/^Too weak/);
    for (const k of ['armor', 'infantry', 'artillery'] as const) d.troops[k] /= 0.4;
    d.blitzReady = s.tick + 40 * TICKS_PER_SECOND;
    expect(blitzBlock(s, 1, d)).toBe('Recharging 40 s');
    expect(applyAction(s, 1, { type: 'blitz', unitId: d.id, tile: at(s, 42, 20) }).reason).toBe('Recharging 40 s');
    expect(applyAction(s, 2, { type: 'blitz', unitId: d.id, tile: at(s, 42, 20) }).ok).toBe(false); // not theirs
    expect(validateAction({ type: 'blitz', unitId: 3, tile: 5 }).ok).toBe(true);
    expect(validateAction({ type: 'blitz', unitId: 'x', tile: 5 }).ok).toBe(false);
    expect(BLITZ_NAME.length).toBeGreaterThan(0);
  });

  it('surges deeper than a plain spearhead, costs oil and starts the cooldown', () => {
    const s = game();
    const d = spawnTankDivision(s, 1, at(s, 36, 20));
    const plain = spearheadPreview(s, 1, d.id, at(s, 42, 20));
    const surge = blitzPreview(s, 1, d.id, at(s, 42, 20));
    expect(surge.expectedDepth).toBeGreaterThan(plain.expectedDepth);
    const oil = s.players[1].oil;
    expect(applyAction(s, 1, { type: 'blitz', unitId: d.id, tile: at(s, 42, 20) }).ok).toBe(true);
    expect(s.players[1].oil).toBe(oil - BLITZ.oil);
    expect(d.blitzReady).toBe(s.tick + BLITZ.cooldownSeconds * TICKS_PER_SECOND);
    run(s, 10);
    expect(s.effects.some((e) => e.kind === 'smokeScreen')).toBe(true);
    untilEnd(s, d);
    expect(d.blitz).toBeUndefined();
    // the wedge is BLITZ.width tiles wide: 2 tiles either side of the line are ours
    let wide = 0;
    for (let y = 16; y <= 24; y++) if (s.map.owner[at(s, 50, y)] === 1) wide++;
    expect(wide).toBeGreaterThanOrEqual(BLITZ.width);
  });

  it('the land it takes holds for a while: no attack takes it back until the hold runs out', () => {
    const s = game();
    const d = spawnTankDivision(s, 1, at(s, 36, 20));
    expect(applyAction(s, 1, { type: 'blitz', unitId: d.id, tile: at(s, 42, 20) }).ok).toBe(true);
    untilEnd(s, d);
    const t = at(s, 48, 20);
    expect(s.map.owner[t]).toBe(1);
    expect(heldBy(s, t)).toBe(1);
    // Player 2 attacks hard right away: the held wedge stays ours.
    asAI(s, () => applyAction(s, 2, { type: 'attack', tile: at(s, 41, 30), troops: { infantry: 25000, armor: 0, artillery: 0 } }));
    run(s, 50);
    expect(s.map.owner[t]).toBe(1);
    run(s, BLITZ.holdSeconds * TICKS_PER_SECOND);
    expect(heldBy(s, t)).toBe(0);
    expect(s.blitzHolds ?? []).toEqual((s.blitzHolds ?? []).filter((_, k) => k % 3 !== 2 || (s.blitzHolds ?? [])[k] > s.tick));
  });
});

describe('AI', () => {
  /** A finger of player 2's land (y 18..22) into ours to x = 20: a line across it cuts it off. */
  function fingerGame(d: Difficulty, humanTarget: boolean): { s: GameState; div: Unit } {
    const s = game(d, false);
    s.players[2].isHuman = humanTarget;
    s.players[2].troops = { infantry: 300000, armor: 0, artillery: 0 }; // dense: a straight line runs dry, the cut wins
    for (let x = 20; x <= 39; x++) for (let y = 18; y <= 22; y++) setOwner(s, at(s, x, y), 2);
    const div = spawnTankDivision(s, 1, at(s, 28, 12));
    asAI(s, () => applyAction(s, 1, { type: 'setDivisionMode', unitIds: [div.id], mode: 'support', front: at(s, 28, 18) }));
    asAI(s, () => applyAction(s, 1, { type: 'attack', tile: at(s, 40, 2), troops: { infantry: 4000, armor: 0, artillery: 0 } }));
    while (s.tick % TICKS_PER_SECOND !== 0) s.tick++;
    updateWarMemory(s);
    s.attacks = [];
    return { s, div };
  }
  it('from Normal up an AI division blitzes a cut; not on Easy, not into a player at Normal; a player never by itself', () => {
    const cases: [Difficulty, boolean, boolean][] = [
      ['normal', false, true],
      ['hard', false, true],
      ['easy', false, false],
      ['normal', true, false],
    ];
    for (const [d, humanTarget, expected] of cases) {
      const { s, div } = fingerGame(d, humanTarget);
      let blitzed = false;
      for (let k = 0; k < 60 && !blitzed; k++) {
        tick(s);
        blitzed = (div.blitzReady ?? 0) > 0;
      }
      expect(`${d} ${humanTarget} ${blitzed}`).toBe(`${d} ${humanTarget} ${expected}`);
    }
    // A player's division on support strikes by itself but never blitzes.
    const s = game('normal', true);
    for (let x = 20; x <= 39; x++) for (let y = 18; y <= 22; y++) setOwner(s, at(s, x, y), 2);
    const div = spawnTankDivision(s, 1, at(s, 28, 12));
    applyAction(s, 1, { type: 'setDivisionMode', unitIds: [div.id], mode: 'support', front: at(s, 28, 18) });
    applyAction(s, 1, { type: 'attack', tile: at(s, 40, 2), troops: { infantry: 4000, armor: 0, artillery: 0 } });
    run(s, 80);
    expect(div.blitzReady).toBeUndefined();
  });
});

describe('determinism', () => {
  it('the cooldown, a blitz under way and the held land are in the hash; two runs hash the same', () => {
    const s = game();
    const d = spawnTankDivision(s, 1, at(s, 36, 20));
    const h0 = hashState(s);
    d.blitzReady = 99;
    const h1 = hashState(s);
    expect(h1).not.toBe(h0);
    d.blitz = 1;
    expect(hashState(s)).not.toBe(h1);
    delete d.blitz;
    s.blitzHolds = [at(s, 2, 2), 1, 500];
    expect(hashState(s)).not.toBe(h1);
    const go = (): number => {
      const g = game('hard', false);
      const a = spawnTankDivision(g, 1, at(g, 36, 10));
      asAI(g, () => applyAction(g, 1, { type: 'blitz', unitId: a.id, tile: at(g, 42, 10) }));
      g.admin!.aiFrozen = false;
      run(g, 600);
      return hashState(g);
    };
    expect(go()).toBe(go());
  });
});
