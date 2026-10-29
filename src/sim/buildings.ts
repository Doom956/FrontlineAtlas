// Building rules and lookups.
import type { ActionResult, Building, BuildingType, GameState } from './types';

export function buildingCost(state: GameState, playerId: number, type: BuildingType): { gold: number; iron: number } {
  // TODO(WP-B): base x (1 + costGrowth * owned count incl. unfinished). City upgrade: cost x level.
  return { gold: 0, iron: 0 };
}
/** Full validation (owner, land, terrain noBuild, fallout, tech, coastal, deposits, spacing, money, city upgrade). */
export function canBuild(state: GameState, playerId: number, type: BuildingType, tile: number): ActionResult {
  // TODO(WP-B)
  return { ok: false, reason: 'not implemented' };
}
/** Validates, pays, places (or upgrades a city). */
export function build(state: GameState, playerId: number, type: BuildingType, tile: number): ActionResult {
  // TODO(WP-B)
  return { ok: false, reason: 'not implemented' };
}
export function demolish(state: GameState, playerId: number, tile: number): ActionResult {
  // TODO(WP-B)
  return { ok: false, reason: 'not implemented' };
}
/** Removes a building (map.building cleared, state.buildings entry deleted). */
export function destroyBuilding(state: GameState, b: Building): void {
  // TODO(WP-B)
}
export function buildingAt(state: GameState, tile: number): Building | undefined {
  const id = state.map.building[tile] - 1;
  return id >= 0 ? state.buildings.get(id) : undefined;
}
/** Finished buildings of a type owned by playerId (cities count once regardless of level). */
export function countBuildings(state: GameState, playerId: number, type: BuildingType, includeUnfinished = false): number {
  // TODO(WP-B): keep fast; called often (cache per tick if needed)
  return 0;
}
export function buildingsOf(state: GameState, playerId: number, type?: BuildingType): Building[] {
  // TODO(WP-B)
  return [];
}
/** Building construction countdown, 'buildingDone' events. */
export function updateBuildings(state: GameState): void {
  // TODO(WP-B)
}
/** Defence multiplier from forts (and watchtowers) of `owner` covering `tile`. 1 if none. */
export function fortMultiplierAt(state: GameState, tile: number, owner: number): number {
  // TODO(WP-B)
  return 1;
}
/** True if `viewer` can see `target`'s army numbers: same player, allied, or a viewer watchtower within its radius of any target tile near... (see DESIGN). */
export function hasIntel(state: GameState, viewer: number, target: number): boolean {
  // TODO(WP-B)
  return viewer === target;
}
/** Supply source tiles of a player: capital, finished cities, finished supply depots. */
export function supplySources(state: GameState, playerId: number): number[] {
  // TODO(WP-B)
  return [];
}
