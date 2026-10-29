// AI nations. They act only through applyAction (same rules as the human).
import type { GameState } from './types';

/** During the spawn phase: pick a good spawn for every AI that hasn't spawned. */
export function aiSpawn(state: GameState): void {
  // TODO(WP-E)
}
/** Called every tick; each AI decides on its own interval (AI_DECISION_SECONDS, staggered by id). */
export function updateAI(state: GameState): void {
  // TODO(WP-E)
}
/** Whether AI `ai` accepts an alliance from `from` (opinion, threat, personality). */
export function aiWantsAlliance(state: GameState, ai: number, from: number): boolean {
  // TODO(WP-E)
  return false;
}
