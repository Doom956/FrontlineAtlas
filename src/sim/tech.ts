// Research tree.
import type { ActionResult, GameState, Player, TechId } from './types';

export function hasTech(p: Player, t: TechId): boolean {
  return p.techs.includes(t);
}
export function canResearch(state: GameState, playerId: number, t: TechId): ActionResult {
  // TODO(WP-B): not known, prerequisites, gold, not already researching it
  return { ok: false, reason: 'not implemented' };
}
/** Pays gold and starts (replacing the current research loses its progress). */
export function startResearch(state: GameState, playerId: number, t: TechId): ActionResult {
  // TODO(WP-B)
  return { ok: false, reason: 'not implemented' };
}
/** Science income goes into the current tech; on completion push to techs, 'researchDone' event. */
export function updateResearch(state: GameState): void {
  // TODO(WP-B)
}
