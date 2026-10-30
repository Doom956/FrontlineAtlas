// The online lockstep runner (src/client/mpgame.ts) with a fake connection: turns run in order, a catchUp after a
// reconnect only fills the gap, a missing turn asks for a resync, hashes go out every HASH_INTERVAL_TURNS turns and
// actions are sent as intents (never applied locally).
import { describe, expect, it } from 'vitest';
import type { ClientMessage, GameStartMsg, Turn } from '../src/net/protocol';
import { HASH_INTERVAL_TURNS, resolveServerUrl } from '../src/net/protocol';
import { MpGame } from '../src/client/mpgame';
import { applyAction } from '../src/sim/actions';
import { hashState } from '../src/sim/hash';
import { tick } from '../src/sim/sim';
import { canSpawnAt, createGame } from '../src/sim/state';
import type { NetClient } from '../src/net/client';
import { testSettings } from './helpers';

class FakeNet {
  sent: ClientMessage[] = [];
  reconnects = 0;
  online = true;
  send(m: ClientMessage): boolean {
    this.sent.push(m);
    return true;
  }
  reconnectNow(): void {
    this.reconnects++;
  }
}

const settings = testSettings({ seed: 4321, aiCount: 2, tribeCount: 4, humans: [
  { name: 'A', color: [52, 120, 246], team: 0 },
  { name: 'B', color: [230, 57, 70], team: 0 },
] });

function start(yourPlayerId: number, turnsPlayed = 0): GameStartMsg {
  return {
    type: 'gameStart',
    code: 'ABCDEF',
    mode: 'ffa',
    settings,
    playerSlots: [
      { playerId: 1, name: 'A', color: [52, 120, 246], team: 0 },
      { playerId: 2, name: 'B', color: [230, 57, 70], team: 0 },
    ],
    teams: null,
    yourPlayerId,
    startTurn: 0,
    turnsPlayed,
    turnMs: 100,
    hashInterval: HASH_INTERVAL_TURNS,
  };
}

/** A script of turns: both humans spawn early (tiles found on a reference game). */
function makeTurns(count: number): Turn[] {
  const ref = createGame(settings);
  const turns: Turn[] = [];
  for (let n = 0; n < count; n++) {
    const intents: Turn['intents'] = [];
    if (n === 2 || n === 3) {
      const id = n === 2 ? 1 : 2;
      for (let t = id * 5000; t < ref.map.owner.length; t += 37) {
        if (canSpawnAt(ref, id, t)) {
          intents.push({ playerId: id, action: { type: 'spawn', tile: t } });
          break;
        }
      }
    }
    for (const it of intents) applyAction(ref, it.playerId, it.action);
    tick(ref);
    turns.push({ n, intents });
  }
  return turns;
}

async function ready(mp: MpGame): Promise<void> {
  await mp.loading;
  expect(mp.state).not.toBeNull();
}

describe('online lockstep runner', () => {
  const turns = makeTurns(60);
  const reference = (() => {
    const s = createGame(settings);
    for (const t of turns) {
      for (const it of t.intents) applyAction(s, it.playerId, it.action);
      tick(s);
    }
    return hashState(s);
  })();

  it('runs turns in order, sends hashes, and matches a plain run of the same turns', async () => {
    const net = new FakeNet();
    const mp = new MpGame(net as unknown as NetClient, start(1));
    // turns may arrive before the game is built
    for (const t of turns.slice(0, 5)) mp.handle({ type: 'turn', ...t });
    await ready(mp);
    expect(mp.state!.humanId).toBe(1);
    for (const t of turns.slice(5)) mp.handle({ type: 'turn', ...t });
    while (mp.behind) mp.pump();
    expect(mp.nextTurn).toBe(60);
    expect(hashState(mp.state!)).toBe(reference);
    const hashes = net.sent.filter((m) => m.type === 'hash');
    expect(hashes.map((m) => (m as { turn: number }).turn)).toEqual([9, 19, 29, 39, 49, 59]);
    expect(mp.state!.players[1].spawned && mp.state!.players[2].spawned).toBe(true);
  });

  it('a catchUp after a reconnect only fills the gap; a missing turn asks for a resync', async () => {
    const net = new FakeNet();
    const mp = new MpGame(net as unknown as NetClient, start(2));
    await ready(mp);
    for (const t of turns.slice(0, 20)) mp.handle({ type: 'turn', ...t });
    expect(mp.haveTurns()).toBe(20); // queued turns count: the reconnect asks for 20 onwards
    mp.pump();
    expect(mp.haveTurns()).toBe(20);
    // turns 20..29 were lost while disconnected; the server resends from the turn we said we need, in two chunks
    mp.handle({ type: 'catchUp', fromTurn: 20, toTurn: 25, turns: turns.slice(20, 25).filter((t) => t.intents.length) });
    mp.handle({ type: 'catchUp', fromTurn: 25, toTurn: 30, turns: turns.slice(25, 30).filter((t) => t.intents.length) });
    for (const t of turns.slice(30)) mp.handle({ type: 'turn', ...t });
    while (mp.behind) mp.pump();
    expect(net.reconnects).toBe(0);
    expect(hashState(mp.state!)).toBe(reference);
    mp.handle({ type: 'turn', n: 62, intents: [] }); // 60 and 61 never came
    expect(net.reconnects).toBe(1);
    expect(mp.behind).toBe(0);
  });

  it('a spectator joining late replays the catchUp and only hashes the recent turns', async () => {
    const net = new FakeNet();
    const mp = new MpGame(net as unknown as NetClient, start(0, 60));
    mp.handle({ type: 'catchUp', fromTurn: 0, toTurn: 60, turns: turns.filter((t) => t.intents.length) });
    await ready(mp);
    expect(mp.state!.humanId).toBe(0);
    while (mp.behind) mp.pump();
    expect(hashState(mp.state!)).toBe(reference);
    expect(net.sent.filter((m) => m.type === 'hash').map((m) => (m as { turn: number }).turn)).toEqual([59]); // turns >= toTurn - HASH_INTERVAL_TURNS
    expect(mp.dispatch({ type: 'startNow' }).ok).toBe(false);
    expect(net.sent.some((m) => m.type === 'intent')).toBe(false);
  });

  it('actions become intents and are never applied locally', async () => {
    const net = new FakeNet();
    const mp = new MpGame(net as unknown as NetClient, start(1));
    await ready(mp);
    const tile = turns[2].intents[0].action;
    const r = mp.dispatch(tile);
    expect(r.ok).toBe(true);
    expect(net.sent).toEqual([{ type: 'intent', action: tile }]);
    expect(mp.state!.players[1].spawned).toBe(false);
    expect(mp.dispatch({ type: 'startNow' }).ok).toBe(false); // only the private lobby's host
    mp.canStartNow = true;
    expect(mp.dispatch({ type: 'startNow' }).ok).toBe(true);
  });

  it('finds the server: ?server=, then the build-time URL, then the page origin', () => {
    expect(resolveServerUrl({ protocol: 'https:', host: 'x.io', search: '?server=play.example.com' }, 'wss://b.example')).toBe('wss://play.example.com/ws');
    expect(resolveServerUrl({ protocol: 'https:', host: 'x.io', search: '' }, 'https://b.example')).toBe('wss://b.example/ws');
    expect(resolveServerUrl({ protocol: 'http:', host: 'localhost:8080', search: '' })).toBe('ws://localhost:8080/ws');
    expect(resolveServerUrl({ protocol: 'file:', host: '', search: '' })).toBeNull();
  });
});
