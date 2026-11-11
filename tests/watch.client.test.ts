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
import { PROTOCOL_VERSION } from '../src/net/protocol';
import type { SpLogMsg, WatchLogEntry } from '../src/net/protocol';
import { SpLink } from '../src/client/spLink';
import type { SpLinkEnv, SpWatchSource } from '../src/client/spLink';
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

  it('rebuilds exactly through the real spLink stream when the backlog spans many chunks (regression: finding 2)', async () => {
    const set = settings();
    const start = createGame(set, null);
    const tile = start.map.terrain.findIndex((t, i) => t > 1 && start.map.owner[i] === 0);
    // A spawn, then many orders at distinct ticks 0..149 -> several backlog chunks (> SP_WATCH_BATCH).
    const orders: WatchLogEntry[] = [[0, { type: 'spawn', tile } as Action]];
    for (let i = 1; i < 150; i++) orders.push([i, { type: 'setArmyMix', armor: (i % 5) / 10, artillery: (i % 4) / 10 } as Action]);
    const ref = reference(set, orders, 200);

    // Stream the backlog through the real spLink: a synchronous flush sends every chunk (150 < 10*48), each tagged as
    // the live client would tag it. Before the fix every chunk carried the final tick, so the rebuild raced ahead.
    const frames: SpLogMsg[] = [];
    const fake = {
      readyState: 1,
      onopen: null as null | (() => void),
      onmessage: null as null | ((ev: { data: string }) => void),
      onclose: null as null | ((ev: { code: number }) => void),
      onerror: null as null | (() => void),
      send(text: string) {
        const m = JSON.parse(text);
        if (m.type === 'spLog') frames.push(m);
      },
      close() {},
    };
    const env: SpLinkEnv = {
      makeSocket: () => fake as unknown as WebSocket,
      online: () => true,
      hidden: () => false,
      watch: () => () => {},
      setTimeout: () => 0,
      clearTimeout: () => {},
      setInterval: () => 0, // the immediate flush is enough; no live orders here
      clearInterval: () => {},
      random: () => 0,
    };
    const source: SpWatchSource = { snapshot: () => ({ settings: set, log: ref.log.slice() }), tick: () => 200 };
    const link = new SpLink('wss://x/ws', () => null, () => {}, env);
    link.setWatchSource(source);
    link.start();
    fake.onopen?.();
    fake.onmessage?.({ data: JSON.stringify({ type: 'spWelcome', protocol: PROTOCOL_VERSION, spId: 1 }) });
    fake.onmessage?.({ data: JSON.stringify({ type: 'spWatch', on: true }) });
    expect(frames.length).toBeGreaterThan(1); // the backlog really was chunked
    expect(frames.at(-1)!.final).toBe(true);
    // each non-final chunk is tagged with its own last order's tick, well below the game's current tick (200)
    expect(frames.slice(0, -1).every((f) => f.tick < 200)).toBe(true);

    // Feed the frames one at a time, and between each let the sim fully catch up to the frame's tick, as it does over
    // the ~1 s between flushes. The symptom of the old bug (every frame tagged tick 200) is directly observable: the
    // sim would race to tick 200 on the very first frame instead of stopping at that chunk's tick.
    const wg = new WatchGame(set);
    await wg.loading;
    wg.add(frames[0].entries, frames[0].tick, true, frames[0].final === true);
    wg.pump(10_000);
    expect(wg.state!.tick).toBe(frames[0].tick); // stops at the chunk's tick; the bug raced to 200 here
    expect(wg.state!.tick).toBeLessThan(200);
    for (const f of frames.slice(1)) {
      wg.add(f.entries, f.tick, f.base === true, f.final === true);
      wg.pump(10_000); // catch right up to this frame's tick before the next frame arrives
    }
    while (!wg.caughtUp) wg.pump(50);
    expect(wg.state!.tick).toBe(200);
    expect(hashState(wg.state!)).toBe(ref.hash); // and the whole rebuild matches the watched game
  });

  it('is one-way: it only reads the stream (no dispatch, no network, no owner writes)', () => {
    const src = readFileSync('src/client/watch.ts', 'utf8');
    const code = src.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(code).not.toMatch(/dispatch|WebSocket|spLink|net\.send|adminWatch/);
  });
});
