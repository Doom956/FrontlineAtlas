// Shared test fixtures for the sim tests.
import { START_TROOPS, VICTORY_LAND_SHARE } from '../src/sim/config';
import { computeCoastAndLand, createMapData } from '../src/sim/mapgen';
import { makeRng } from '../src/sim/rng';
import { autoSpawnRemaining, createGame, makeGameState, makePlayer, setOwner } from '../src/sim/state';
import { Terrain } from '../src/sim/types';
import type { GameSettings, GameState } from '../src/sim/types';

export function testSettings(overrides: Partial<GameSettings> = {}): GameSettings {
  return {
    seed: 12345,
    mapType: 'continents',
    mapSize: 'small',
    aiCount: 3,
    difficulty: 'normal',
    playerName: 'Tester',
    playerColor: [255, 255, 255],
    humanPlayer: true,
    timeLimit: 0,
    victoryLandShare: VICTORY_LAND_SHARE,
    tribeCount: 0,
    ...overrides,
  };
}

/**
 * Small generated game (small continents map, 3 AIs, seed 12345, human id 1) with everyone spawned and phase
 * 'playing'.
 */
export function makeTestGame(overrides: Partial<GameSettings> = {}): GameState {
  const state = createGame(testSettings(overrides));
  autoSpawnRemaining(state);
  state.phase = 'playing';
  state.spawnLeft = 0;
  return state;
}

/**
 * All-plains map (no water, no resources) with `playerCount` players (ids 1..playerCount), all AIs unless
 * opts.human (then id 1 is human). Players are alive and marked spawned but own nothing: give them land with
 * setOwner / claimRect. Phase 'playing'. Starting troops and gold come from config.
 */
export function makeFlatGame(
  width: number,
  height: number,
  playerCount: number,
  opts: { human?: boolean; seed?: number; terrain?: number } = {},
): GameState {
  const map = createMapData(width, height);
  map.terrain.fill(opts.terrain ?? Terrain.Plains);
  computeCoastAndLand(map);
  const players = [makePlayer(0, 'Neutral', [128, 128, 128], false, null)];
  players[0].gold = 0;
  for (let id = 1; id <= playerCount; id++) {
    const human = !!opts.human && id === 1;
    const p = makePlayer(id, human ? 'Tester' : `AI ${id}`, [(40 * id) % 256, 100, Math.max(0, 200 - 10 * id)], human, human ? null : 'balanced');
    p.spawned = true;
    p.troops = { infantry: START_TROOPS, armor: 0, artillery: 0 };
    players.push(p);
  }
  const settings = testSettings({ seed: opts.seed ?? 1, aiCount: opts.human ? playerCount - 1 : playerCount, humanPlayer: !!opts.human });
  const state = makeGameState(settings, map, players, makeRng(settings.seed));
  state.phase = 'playing';
  state.spawnLeft = 0;
  return state;
}

/** Gives playerId every tile in the rectangle [x0..x1] x [y0..y1] (inclusive); sets the capital if it has none. */
export function claimRect(state: GameState, playerId: number, x0: number, y0: number, x1: number, y1: number): void {
  const w = state.map.width;
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) setOwner(state, y * w + x, playerId);
  const p = state.players[playerId];
  if (p.capital < 0) p.capital = Math.floor((y0 + y1) / 2) * w + Math.floor((x0 + x1) / 2);
}

/** Total of a Troops record. */
export function troopSum(t: { infantry: number; armor: number; artillery: number }): number {
  return t.infantry + t.armor + t.artillery;
}
