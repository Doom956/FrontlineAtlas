// One simulation tick (100 ms of game time). Fixed system order for determinism.
import type { GameState } from './types';

export function tick(state: GameState): void {
  // TODO(WP-A): spawn phase (aiSpawn, countdown, autoSpawnRemaining -> 'playing'), then
  // updateEconomy, updateResearch, updateBuildings, updateSupply, updateAttacks, updateUnits, updateDiplomacy,
  // updateAI, updateVictory; state.tick++.
}
