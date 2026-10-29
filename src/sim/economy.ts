// Population, gold, iron, oil, science, upkeep, army ratio, army mix conversion.
import type { GameState, Player, Troops } from './types';

export function armyTotal(t: Troops): number {
  return t.infantry + t.armor + t.artillery;
}
export function population(p: Player): number {
  return p.workers + armyTotal(p.troops);
}
/** Max population from land (minus fallout tiles), city levels, capital. */
export function computeMaxPop(state: GameState, playerId: number): number {
  // TODO(WP-B)
  return 0;
}
/** Runs one tick of economy for every alive, spawned player; fills Player.maxPop and Player.income. */
export function updateEconomy(state: GameState): void {
  // TODO(WP-B)
}
