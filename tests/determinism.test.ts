// Lockstep safety: same settings + same actions => bit-identical state; games running side by side don't affect
// each other; the deterministic math matches the platform's within a few ulp.
import { describe, expect, it } from 'vitest';
import { applyAction } from '../src/sim/actions';
import { TICKS_PER_SECOND } from '../src/sim/config';
import { expDet, logDet, powDet, powInt } from '../src/sim/fmath';
import { hashState } from '../src/sim/hash';
import { tick } from '../src/sim/sim';
import { canSpawnAt, createGame } from '../src/sim/state';
import type { Action, GameSettings, GameState } from '../src/sim/types';
import { testSettings, type TestOverrides } from './helpers';

function settings(overrides: TestOverrides = {}): GameSettings {
  return testSettings({ seed: 4242, aiCount: 4, tribeCount: 6, humanPlayer: true, ...overrides });
}

/** A fixed script of human actions, keyed by tick (tiles are found deterministically from the state). */
function scriptedActions(state: GameState): Action[] {
  const me = state.players[1];
  const out: Action[] = [];
  if (state.tick === 3) {
    // First valid spawn tile from the map centre outward.
    const { width: w, height: h } = state.map;
    for (let r = 0; r < Math.max(w, h) && !out.length; r++) {
      for (let dx = -r; dx <= r && !out.length; dx++) {
        const t = ((h >> 1) + (r - Math.abs(dx))) * w + (w >> 1) + dx;
        if (t >= 0 && t < w * h && canSpawnAt(state, 1, t)) out.push({ type: 'spawn', tile: t });
      }
    }
  }
  if (state.tick === 30) out.push({ type: 'startNow' });
  if (state.phase === 'playing' && state.tick % 50 === 0 && me.alive) {
    // Attack the owner of a tile next to our capital's row: neutral or a neighbour.
    const w = state.map.width;
    for (let k = 1; k < w; k++) {
      const t = me.capital + k;
      if (t >= state.map.owner.length) break;
      const o = state.map.owner[t];
      if (o !== 1 && state.map.terrain[t] > 1) {
        const n = Math.floor(me.troops.infantry * 0.3);
        if (n >= 50) out.push({ type: 'attack', tile: t, troops: { infantry: n, armor: 0, artillery: 0 } });
        break;
      }
    }
  }
  if (state.tick === 400) out.push({ type: 'setArmyMix', armor: 0.2, artillery: 0.1 });
  if (state.tick === 500) out.push({ type: 'setAuto', research: false });
  return out;
}

function run(state: GameState, ticks: number, hashes?: number[]): void {
  for (let k = 0; k < ticks; k++) {
    for (const a of scriptedActions(state)) applyAction(state, 1, a);
    tick(state);
    if (hashes && state.tick % 100 === 0) hashes.push(hashState(state));
  }
}

describe('determinism', () => {
  it('two games from the same settings and actions have identical state hashes', () => {
    const ticks = 90 * TICKS_PER_SECOND;
    const ha: number[] = [];
    const hb: number[] = [];
    const a = createGame(settings());
    const b = createGame(settings());
    run(a, ticks, ha);
    run(b, ticks, hb);
    expect(a.phase).toBe('playing');
    expect(ha.length).toBeGreaterThan(5);
    expect(ha).toEqual(hb);
    expect(hashState(a)).toBe(hashState(b));
    // The hash notices a change.
    const before = hashState(a);
    a.players[2].gold += 1;
    expect(hashState(a)).not.toBe(before);
    // ... also in diplomacy, research, auto flags, embargoes and the spawn clock
    const changes: ((g: typeof a) => void)[] = [
      (g) => g.alliances.push({ a: 2, b: 3, expiresTick: 9999 }),
      (g) => g.allianceRequests.push({ from: 3, to: 2, expiresTick: 9999 }),
      (g) => (g.players[2].researchProgress += 0.5),
      (g) => (g.players[2].researching = g.players[2].researching ? null : 'agriculture'),
      (g) => (g.players[2].auto.mix = !g.players[2].auto.mix),
      (g) => g.players[2].embargoes.push(3),
      (g) => (g.players[2].traitorUntil += 10),
      (g) => (g.spawnLeft += 1),
    ];
    for (const change of changes) {
      const h0 = hashState(a);
      change(a);
      expect(hashState(a), change.toString()).not.toBe(h0);
    }
  }, 60_000);

  it('a second game ticking in between does not change the first one', () => {
    const ticks = 60 * TICKS_PER_SECOND;
    const alone = createGame(settings());
    run(alone, ticks);
    const expected = hashState(alone);

    const a = createGame(settings());
    const other = createGame(settings({ seed: 99, mapType: 'pangaea', aiCount: 6, tribeCount: 10, humanPlayer: false }));
    for (let k = 0; k < ticks; k++) {
      for (const act of scriptedActions(a)) applyAction(a, 1, act);
      tick(a);
      tick(other);
      tick(other); // a different pace, so the two never share a tick number
    }
    expect(hashState(a)).toBe(expected);
  }, 60_000);
});

describe('deterministic math', () => {
  it('expDet / logDet / powDet match Math within a few ulp', () => {
    for (const x of [-700, -50, -3.3, -1, -1e-9, 0, 1e-12, 0.5, 1, 2.302585, 10, 88.7, 700]) {
      const e = Math.exp(x);
      expect(Math.abs(expDet(x) - e)).toBeLessThanOrEqual(Math.abs(e) * 4e-16 + 1e-300);
    }
    for (const x of [1e-300, 1e-10, 0.1, 0.5, 1, 1.5, 2, Math.E, 10, 12345.678, 1e10, 1e300]) {
      const l = Math.log(x);
      expect(Math.abs(logDet(x) - l)).toBeLessThanOrEqual(Math.abs(l) * 4e-16 + 4e-16);
    }
    expect(logDet(1)).toBe(0);
    expect(logDet(0)).toBe(-Infinity);
    for (const [x, y] of [[30000, 0.75], [1500, 0.75], [2, 10], [0.5, 3], [123.4, 0.5]]) {
      expect(powDet(x, y)).toBeCloseTo(Math.pow(x, y), 8);
    }
    expect(powDet(0, 0.75)).toBe(0);
    expect(powDet(5, 0)).toBe(1);
    expect(powInt(0.5, 3)).toBe(0.125);
    expect(powInt(3, 0)).toBe(1);
  });
});
