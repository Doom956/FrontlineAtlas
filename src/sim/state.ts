// Game creation, spawning, ownership changes, events, ids.
import type { GameEventKind, GameSettings, GameState } from './types';

export function createGame(settings: GameSettings): GameState {
  // TODO(WP-A): map, players (human id 1 if settings.humanPlayer, then AIs), opinion matrix, phase 'spawn'.
  throw new Error('createGame not implemented');
}
/** Valid spawn: land, unowned, no fallout, at least 12 tiles from other spawned capitals. */
export function canSpawnAt(state: GameState, playerId: number, tile: number): boolean {
  // TODO(WP-A)
  return false;
}
/** Places (or moves, during the spawn phase) a player's start territory (SPAWN_RADIUS) and capital. */
export function spawnPlayer(state: GameState, playerId: number, tile: number): boolean {
  // TODO(WP-A)
  return false;
}
/** Spawns every player who has not spawned yet at a random valid spot (end of spawn phase). */
export function autoSpawnRemaining(state: GameState): void {
  // TODO(WP-A)
}
/**
 * The single way to change a tile's owner. Keeps Player.tiles in sync, handles the building on the tile
 * (capture if BUILDINGS[type].capturable and newOwner != 0, else destroy), capital loss (move capital, -30% gold,
 * 'capitalLost' event), and elimination when a player's tiles reach 0 (alive=false, attacks/units removed,
 * 'eliminated' event, stats).
 */
export function setOwner(state: GameState, tile: number, newOwner: number): void {
  // TODO(WP-A)
}
export function addEvent(state: GameState, kind: GameEventKind, message: string, players: number[], tile = -1): void {
  // TODO(WP-A): push, cap at MAX_EVENTS (drop oldest)
}
export function newId(state: GameState): number {
  return state.nextId++;
}
