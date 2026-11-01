// Lockstep after a rejoin and with HUD reads between ticks.
//
// What a (re)joining client gets is the turn log, not a state snapshot: the server never runs the sim and keeps every
// non-empty turn (server/room.ts catch-up); a client that joins late or reloads after a desync builds the game with
// createGame and replays every turn from 0 in bursts (mpgame.ts: CATCHUP_BUDGET_MS of turns per frame, the HUD drawn
// only between frames); a reconnect keeps its game and replays the missed turns the same way. So the "snapshot" of a
// rejoin is (settings, turns 0..T), and the restored game must match the live one from T on, while each client reads
// the sim for its HUD on its own schedule: every turn on an idle machine, every few turns on a busy one, none while
// catching up.
//
// Game "live" reads the HUD (tests/hudReads.ts) before every tick; "quiet" never reads; "rejoin@T" is rebuilt at tick
// T by replaying the turn log (no reads), then reads every third tick like a busy client. A scripted human seat sends
// attacks (the same intents in every game) so actions land between a HUD read and the tick. Every game must hash
// the same at every compared tick.
import { describe, expect, it } from 'vitest';
import { applyAction } from '../src/sim/actions';
import { hashState } from '../src/sim/hash';
import { tick } from '../src/sim/sim';
import { createGame } from '../src/sim/state';
import { borderTiles } from '../src/sim/territory';
import type { Action, GameSettings, GameState } from '../src/sim/types';
import { testSettings } from './helpers';
import { GROUPS, hudReads } from './hudReads';

type Turn = { playerId: number; action: Action }[];

/** The human seat's intents for this turn, decided from the reference game (as the human's client would). */
function humanIntents(s: GameState, n: number): Turn {
  const p = s.players[1];
  if (s.phase !== 'playing' || !p?.alive || n % 40 !== 0) return [];
  const b = borderTiles(s, 1);
  if (!b.len) return [];
  const w = s.map.width;
  for (let j = 0; j < 8; j++) {
    const t = b.list[(n * 13 + j * 97) % b.len];
    for (const d of [1, -1, w, -w]) {
      const u = t + d;
      if (u < 0 || u >= s.map.owner.length || s.map.owner[u] === 1 || s.map.terrain[u] <= 1) continue;
      const tr = p.troops;
      return [{ playerId: 1, action: { type: 'attack', tile: u, troops: { infantry: tr.infantry * 0.3, armor: tr.armor * 0.3, artillery: tr.artillery * 0.3 } } }];
    }
  }
  return [];
}

function runTurn(s: GameState, turn: Turn): void {
  for (const { playerId, action } of turn) applyAction(s, playerId, action);
  tick(s);
}

interface Client {
  name: string;
  state: GameState;
  /** HUD reads before every `readEvery`-th turn (0 = never) */
  readEvery: number;
}

/** Runs the scenario; returns the first mismatch ("name@tick") or null, and how much the shop was used. */
function scenario(settings: GameSettings, ticks: number, rejoinAt: readonly number[]): { mismatch: string | null; orders: number } {
  const log: Turn[] = [];
  const quiet: Client = { name: 'quiet', state: createGame(settings), readEvery: 0 };
  const clients: Client[] = [quiet, { name: 'live', state: createGame(settings), readEvery: 1 }];
  let orders = 0;
  for (let n = 0; n < ticks; n++) {
    if (rejoinAt.includes(n)) {
      // Catch-up: a fresh game replays the turn log in one burst (no HUD in between), then plays on as a busy client.
      const s = createGame(settings);
      for (let k = 0; k < n; k++) runTurn(s, log[k]);
      clients.push({ name: `rejoin@${n}`, state: s, readEvery: 3 });
    }
    log.push(humanIntents(quiet.state, n));
    for (const c of clients) {
      if (c.readEvery && n % c.readEvery === 0) hudReads(c.state, GROUPS, n);
      runTurn(c.state, log[n]);
    }
    for (const p of quiet.state.players) orders = Math.max(orders, p.procuring?.length ?? 0);
    if (n % 10 === 9 || n === ticks - 1) {
      const h = hashState(quiet.state);
      for (const c of clients) if (hashState(c.state) !== h) return { mismatch: `${c.name}@${c.state.tick}`, orders };
    }
  }
  return { mismatch: null, orders };
}

describe('lockstep: rejoin (turn-log replay) and HUD reads between ticks', () => {
  // Medium continents, 8 AI nations + a scripted human, normal research (the Arsenal shop is on), 17 game minutes.
  for (const seed of [1, 5]) {
    it(`seed ${seed}: live, quiet and rejoined clients hash the same`, () => {
      const settings = testSettings({ seed, mapType: 'continents', mapSize: 'medium', aiCount: 8, humanPlayer: true, tribeCount: -1 });
      const r = scenario(settings, 17 * 600, [3000, 7000]);
      expect(r.orders).toBeGreaterThan(0); // AIs bought from the Arsenal shop
      expect(r.mismatch).toBeNull();
    }, 900_000);
  }
});
