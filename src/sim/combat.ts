// Land attacks, fronts, supply, losses.
import type { ActionResult, Attack, GameState, Troops } from './types';

/**
 * Starts an attack from playerId toward the owner of `tile` (0 = neutral land) with these troops, which are
 * removed from the player's pool. Validates: tile is land, not own, not allied, target borders the attacker
 * (or amphibious), troops >= MIN_ATTACK_TROOPS and available, attack count limit. If an attack on the same
 * target already exists, troops are merged into it and the focus moves.
 */
export function launchAttack(state: GameState, playerId: number, tile: number, troops: Troops, amphibious = false): ActionResult {
  // TODO(WP-C)
  return { ok: false, reason: 'not implemented' };
}
export function retreat(state: GameState, playerId: number, attackId: number): ActionResult {
  // TODO(WP-C)
  return { ok: false, reason: 'not implemented' };
}
/** One tick of every attack (capture tiles, losses, counter-attacks, end/return troops). */
export function updateAttacks(state: GameState): void {
  // TODO(WP-C)
}
/** Recomputes state.supplyDist every SUPPLY_RECALC_TICKS (all players). */
export function updateSupply(state: GameState): void {
  // TODO(WP-C)
}
/** 0..1 supply efficiency of playerId at tile (uses distance to nearest own tile's supplyDist). */
export function supplyEfficiency(state: GameState, playerId: number, tile: number): number {
  // TODO(WP-C)
  return 1;
}
/** Defence power of a player's whole army (count x TROOP_DEFENSE x tech), used for density. */
export function defensePower(state: GameState, playerId: number): number {
  // TODO(WP-C)
  return 0;
}
/**
 * For UI/AI: estimated troops lost per tile and tiles/s if `troops` attacked `tile` now.
 * Returns null if the tile can't be attacked.
 */
export function estimateAttack(state: GameState, playerId: number, tile: number, troops: Troops): { lossPerTile: number; tilesPerSecond: number; defensePerTile: number } | null {
  // TODO(WP-C)
  return null;
}
/** True if any tile of `owner` (0 = neutral land) is 4-adjacent to a tile of playerId. */
export function borders(state: GameState, playerId: number, owner: number): boolean {
  // TODO(WP-C)
  return false;
}
export function attacksOf(state: GameState, playerId: number): Attack[] {
  return state.attacks.filter((a) => a.attacker === playerId);
}
