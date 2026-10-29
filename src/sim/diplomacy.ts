// Alliances, requests, betrayal, opinion, gifts, embargoes.
import type { ActionResult, GameState } from './types';

export function areAllied(state: GameState, a: number, b: number): boolean {
  // TODO(WP-A)
  return false;
}
export function isTraitor(state: GameState, playerId: number): boolean {
  return state.players[playerId].traitorUntil > state.tick;
}
export function changeOpinion(state: GameState, of: number, about: number, delta: number): void {
  // TODO(WP-A): clamp -100..100
}
/** Creates a request; if `to` is an AI, it answers via ai.ts aiWantsAlliance on its next decision. */
export function requestAlliance(state: GameState, from: number, to: number): ActionResult {
  // TODO(WP-A)
  return { ok: false, reason: 'not implemented' };
}
export function answerAlliance(state: GameState, playerId: number, from: number, accept: boolean): ActionResult {
  // TODO(WP-A)
  return { ok: false, reason: 'not implemented' };
}
/** Ends an alliance early: breaker becomes traitor, opinions drop. */
export function breakAlliance(state: GameState, playerId: number, other: number): ActionResult {
  // TODO(WP-A)
  return { ok: false, reason: 'not implemented' };
}
export function gift(state: GameState, from: number, to: number, gold: number, troops: number): ActionResult {
  // TODO(WP-A): troops = infantry
  return { ok: false, reason: 'not implemented' };
}
export function toggleEmbargo(state: GameState, playerId: number, other: number): ActionResult {
  // TODO(WP-A)
  return { ok: false, reason: 'not implemented' };
}
/** True if trade ships may run between a and b (no embargo either way, both alive, not attacking each other). */
export function canTrade(state: GameState, a: number, b: number): boolean {
  // TODO(WP-A)
  return false;
}
/** Expire alliances/requests, slow opinion drift toward 0, border friction. */
export function updateDiplomacy(state: GameState): void {
  // TODO(WP-A)
}
