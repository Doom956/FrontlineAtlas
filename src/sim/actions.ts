// Single entry point for player and AI actions.
import type { Action, ActionResult, GameState } from './types';

export function applyAction(state: GameState, playerId: number, action: Action): ActionResult {
  // TODO(WP-A): phase checks (spawn only in 'spawn', everything else in 'playing'), alive check, then dispatch to
  // state.spawnPlayer / combat / buildings / tech / units / diplomacy / economy setters.
  return { ok: false, reason: 'not implemented' };
}
