// Watching a single-player game (src/client/watch.ts): the owner rebuilds another player's game in its own sim from
// the streamed setup + order log, exactly as save/replay does, and ends in the same state (hash-checked). One-way:
// the WatchGame only reads the stream; it has no way to change the watched game.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { applyAction } from '../src/sim/actions';
import { tick as stepSim } from '../src/sim/sim';
import { createGame } from '../src/sim/state';
import { hashState } from '../src/sim/hash';
import { cloneSetup, DEFAULT_SETUP } from '../src/sim/setup';
import type { Action, GameSettings } from '../src/sim/types';
import type { WatchLogEntry } from '../src/net/protocol';
import { WatchGame } from '../src/client/watch';

const settings = (): GameSettings => ({
  ...cloneSetup(DEFAULT_SETUP),
  seed: 42,
  map: { kind: 'generated', type: 'continents', size: 'small' },
  aiCount: 4,
  playerName: 'Watched',
  playerColor: [10, 20, 30],
  humanPlayer: true,
});

/** Plays a reference game to `toTick`, recording the given orders at their ticks (as the recorder would). */
function reference(set: GameSettings, orders: WatchLogEntry[], toTick: number): { hash: number; log: WatchLogEntry[] } {
  const s = createGame(set, null);
  const log: WatchLogEntry[] = [];
  let k = 0;
  while (s.tick < toTick) {
    while (k < orders.length && orders[k][0] === s.tick) {
      const [t, a] = orders[k++];
      log.push([t, a]);
      applyAction(s, s.humanId, a as Action);
    }
    stepSim(s);
  }
  return { hash: hashState(s), log };
}

describe('watch: deterministic rebuild from the stream', () => {
  it('ends in the same state as the watched game (whole history in one backlog batch)', async () => {
    const set = settings();
    const start = createGame(set, null);
    const tile = start.map.terrain.findIndex((t, i) => t > 1 && start.map.owner[i] === 0);
    const orders: WatchLogEntry[] = [
      [0, { type: 'spawn', tile } as Action],
      [15, { type: 'setArmyMix', armor: 0.3, artillery: 0.2 } as Action],
    ];
    const ref = reference(set, orders, 120);

    const wg = new WatchGame(set);
    await wg.loading;
    expect(wg.state).not.toBeNull();
    // the whole history arrives as one final backlog batch at tick 120
    wg.add(ref.log, 120, true, true);
    wg.pump(10_000);
    expect(wg.state!.tick).toBe(120);
    expect(wg.caughtUp).toBe(true);
    expect(hashState(wg.state!)).toBe(ref.hash);
  });

  it('matches after catching up, then following live batches (sliced pump, idle ticks included)', async () => {
    const set = settings();
    const start = createGame(set, null);
    const tile = start.map.terrain.findIndex((t, i) => t > 1 && start.map.owner[i] === 0);
    const orders: WatchLogEntry[] = [[0, { type: 'spawn', tile } as Action], [40, { type: 'setArmyMix', armor: 0.5, artillery: 0.1 } as Action]];
    const ref = reference(set, orders, 90);

    const wg = new WatchGame(set);
    await wg.loading;
    // backlog up to tick 30 (only the spawn so far), final
    wg.add([orders[0]], 30, true, true);
    while (wg.state!.tick < 30) wg.pump(7); // sliced, like the frame loop
    expect(wg.caughtUp).toBe(true);
    expect(wg.state!.tick).toBe(30);
    // live: the later order, then an idle tick advance to 90
    wg.add([orders[1]], 60, false, false);
    wg.add([], 90, false, false);
    while (wg.state!.tick < 90) wg.pump(7);
    expect(wg.state!.tick).toBe(90);
    expect(hashState(wg.state!)).toBe(ref.hash);
  });

  it('is one-way: it only reads the stream (no dispatch, no network, no owner writes)', () => {
    const src = readFileSync('src/client/watch.ts', 'utf8');
    const code = src.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(code).not.toMatch(/dispatch|WebSocket|spLink|net\.send|adminWatch/);
  });
});
