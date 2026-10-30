// Several humans in one game (online multiplayer): seats, teams, victory rules, and lockstep determinism (same
// settings + same turn intents => the same hash on every client, whichever player a client controls).
import { describe, expect, it } from 'vitest';
import { applyAction } from '../src/sim/actions';
import { hashState } from '../src/sim/hash';
import { areAllied } from '../src/sim/diplomacy';
import { assignTeams, humanSeats } from '../src/sim/setup';
import { tick } from '../src/sim/sim';
import { autoSpawnRemaining, canSpawnAt, createGame } from '../src/sim/state';
import { isTribe } from '../src/sim/types';
import type { Action, GameSettings, GameState, HumanSeat } from '../src/sim/types';
import { testSettings, type TestOverrides } from './helpers';

const SEATS: HumanSeat[] = [
  { name: 'Ann', color: [52, 120, 246], team: 0 },
  { name: 'Bob', color: [230, 57, 70], team: 0 },
  { name: 'Cy', color: [46, 196, 102], team: 0 },
];

function mpSettings(overrides: TestOverrides = {}): GameSettings {
  return testSettings({ seed: 777, aiCount: 3, tribeCount: 8, humans: SEATS.map((s) => ({ ...s })), ...overrides });
}

/** First valid start for `id`, searching from a point that differs per player. */
function startTile(state: GameState, id: number): number {
  const { width: w, height: h } = state.map;
  const cx = Math.floor((w * id) / 4);
  const cy = h >> 1;
  for (let r = 0; r < Math.max(w, h); r++) {
    for (let dx = -r; dx <= r; dx++) {
      for (const dy of [r - Math.abs(dx), Math.abs(dx) - r]) {
        const x = cx + dx;
        const y = cy + dy;
        if (x < 0 || y < 0 || x >= w || y >= h) continue;
        if (canSpawnAt(state, id, y * w + x)) return y * w + x;
      }
    }
  }
  return -1;
}

/** Turn intents a server would relay: spawns, then attacks on a neighbour tile every few seconds. */
function turnIntents(state: GameState, humans: number): { playerId: number; action: Action }[] {
  const out: { playerId: number; action: Action }[] = [];
  for (let id = 1; id <= humans; id++) {
    const p = state.players[id];
    if (state.tick === 2 + id) out.push({ playerId: id, action: { type: 'spawn', tile: startTile(state, id) } });
    if (state.phase !== 'playing' || !p.alive || (state.tick + id * 7) % 40 !== 0) continue;
    const w = state.map.width;
    for (let k = 1; k < 60; k++) {
      const t = p.capital + k * (id % 2 ? 1 : -1);
      if (t < 0 || t >= state.map.owner.length) break;
      if (state.map.owner[t] !== id && state.map.terrain[t] > 1) {
        out.push({ playerId: id, action: { type: 'attack', tile: t, troops: { infantry: Math.floor(p.troops.infantry * 0.25), armor: 0, artillery: 0 } } });
        break;
      }
    }
    if (state.tick % 120 === 0) out.push({ playerId: id, action: { type: 'build', building: 'city', tile: p.capital + w } });
  }
  return out;
}

describe('multiplayer seats', () => {
  it('humans get ids 1..H in seat order, then the AI nations, then the tribes', () => {
    const s = createGame(mpSettings());
    expect(s.players.slice(1, 4).map((p) => [p.name, p.isHuman])).toEqual([
      ['Ann', true],
      ['Bob', true],
      ['Cy', true],
    ]);
    expect(s.players[1].color).toEqual([52, 120, 246]);
    expect(s.players.slice(4, 7).every((p) => !p.isHuman && !isTribe(p))).toBe(true);
    expect(s.players.slice(7).every((p) => isTribe(p))).toBe(true);
    expect(s.players.length).toBe(1 + 3 + 3 + 8);
  });

  it('single player settings map to one seat and build the same game as humans[0]', () => {
    const sp = testSettings({ seed: 99, tribeCount: 4 });
    expect(humanSeats(sp)).toEqual([{ name: 'Tester', color: [255, 255, 255], team: 0 }]);
    expect(humanSeats({ ...sp, humanPlayer: false })).toEqual([]);
    const a = createGame(sp);
    const b = createGame({ ...sp, humans: [{ name: 'Tester', color: [255, 255, 255], team: 0 }] });
    expect(hashState(b)).toBe(hashState(a));
    expect(b.players.map((p) => p.color)).toEqual(a.players.map((p) => p.color));
  });

  it('two clients stay in lockstep whichever human they control; a third game in between changes nothing', () => {
    const settings = mpSettings();
    const clients = [createGame(settings), createGame(settings), createGame(settings)];
    clients[0].humanId = 1;
    clients[1].humanId = 3;
    clients[2].humanId = 0; // spectator
    const other = createGame(testSettings({ seed: 5, tribeCount: 3 }));
    const hashes: number[][] = [[], [], []];
    for (let n = 0; n < 900; n++) {
      const intents = turnIntents(clients[0], 3);
      clients.forEach((c, k) => {
        for (const it of intents) applyAction(c, it.playerId, it.action);
        tick(c);
        if ((n + 1) % 10 === 0) hashes[k].push(hashState(c));
        if (k === 0) tick(other);
      });
    }
    expect(clients[0].phase).toBe('playing');
    expect(clients[0].players[1].spawned && clients[0].players[2].spawned).toBe(true);
    expect(hashes[1]).toEqual(hashes[0]);
    expect(hashes[2]).toEqual(hashes[0]);
  }, 30000);
});

describe('multiplayer teams', () => {
  it('assignTeams keeps chosen teams, deals auto humans and AI nations to the smallest team', () => {
    expect(assignTeams([0], 3, 2)).toEqual([0, 1, 2, 1, 2]);
    expect(assignTeams([2, 2, 0], 3, 3)).toEqual([0, 2, 2, 1, 3, 1, 3]);
  });

  it('teammates (humans and AI) are permanently allied and cannot attack each other', () => {
    const settings = mpSettings({ mode: 'teams', teamCount: 2, humans: [{ ...SEATS[0], team: 1 }, { ...SEATS[1], team: 1 }, { ...SEATS[2], team: 2 }] });
    const s = createGame(settings);
    expect(s.teams.slice(1, 7)).toEqual([1, 1, 2, 2, 1, 2]);
    expect(s.teams.slice(7).every((t) => t === 0)).toBe(true);
    autoSpawnRemaining(s);
    s.phase = 'playing';
    expect(areAllied(s, 1, 2)).toBe(true);
    expect(areAllied(s, 1, 3)).toBe(false);
    expect(applyAction(s, 1, { type: 'breakAlliance', with: 2 }).ok).toBe(false);
    const tile = s.players[2].capital;
    const r = applyAction(s, 1, { type: 'attack', tile, troops: { infantry: 1000, armor: 0, artillery: 0 } });
    expect(r.ok).toBe(false);
    // the lobby's teams win over the seats' choices
    const given = createGame(settings, null, { teams: [0, 2, 1, 1, 1, 2, 2] });
    expect(given.teams.slice(1, 7)).toEqual([2, 1, 1, 1, 2, 2]);
  });

  it('with several humans, each human keeps a team shade and humans lead their team colours', () => {
    const s = createGame(mpSettings({ mode: 'teams', teamCount: 2 }));
    const t1 = s.players.filter((p) => s.teams[p.id] === 1).map((p) => p.color.join());
    expect(new Set(t1).size).toBe(t1.length);
  });
});

describe('multiplayer victory', () => {
  function playing(overrides: TestOverrides = {}): GameState {
    const s = createGame(mpSettings({ humans: SEATS.slice(0, 2).map((x) => ({ ...x })), ...overrides }));
    autoSpawnRemaining(s);
    s.phase = 'playing';
    s.spawnLeft = 0;
    s.playStartTick = s.tick;
    return s;
  }
  const runToCheck = (s: GameState) => {
    for (let k = 0; k < 10; k++) tick(s);
  };

  it('one eliminated human does not end the game; the last one does', () => {
    const s = playing();
    s.players[1].alive = false;
    s.players[1].eliminatedTick = s.tick;
    runToCheck(s);
    expect(s.phase).toBe('playing');
    s.players[2].alive = false;
    s.players[2].eliminatedTick = s.tick;
    runToCheck(s);
    expect(s.phase).toBe('over');
    // both humans get their own defeat event, whatever humanId says
    const defeats = s.events.filter((e) => e.kind === 'defeat').map((e) => e.players[0]);
    expect(defeats.sort()).toEqual([1, 2]);
  });

  it('single player still ends when the human is eliminated', () => {
    const s = createGame(testSettings({ seed: 31, tribeCount: 2 }));
    autoSpawnRemaining(s);
    s.phase = 'playing';
    s.players[1].alive = false;
    runToCheck(s);
    expect(s.phase).toBe('over');
    expect(s.events.some((e) => e.kind === 'defeat' && e.players[0] === 1)).toBe(true);
  });

  it('the result does not depend on which human the client controls', () => {
    const a = playing();
    const b = playing();
    b.humanId = 2;
    for (const s of [a, b]) {
      s.players[1].alive = false;
      s.players[2].alive = false;
      runToCheck(s);
    }
    expect(hashState(b)).toBe(hashState(a));
    expect(b.winner).toBe(a.winner);
    expect(b.events.map((e) => e.message)).toEqual(a.events.map((e) => e.message));
  });
});
