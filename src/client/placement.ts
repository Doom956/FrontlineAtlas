// Forgiving building placement, as the sim decides it: buildings.resolveBuildTarget snaps a build order to the
// nearest valid own tile near the click, or upgrades a building of the same type close by. The client only shows
// that decision (the build preview) and sends the click; it never applies rules of its own.
import { resolveBuildTarget } from '../sim/buildings';
import type { BuildingType, GameState } from '../sim/types';

export interface Snap {
  /** tile the building would go on (or the building upgraded), -1 when the order is impossible */
  tile: number;
  /** true when the target is an existing building that would be upgraded */
  upgrade: boolean;
  /** false when it can't be built right now (impossible, or not enough gold / iron) */
  ok: boolean;
  /** level after building (build preview) */
  level?: number;
  /** why not, when !ok (build preview) */
  error?: string;
}

/** Where a build click on `tile` places `type` (resolveBuildTarget's tile and upgrade flag). */
export function snapBuild(state: GameState, playerId: number, type: BuildingType, tile: number): Snap {
  const r = resolveBuildTarget(state, playerId, type, tile);
  if ('error' in r) return { tile: -1, upgrade: false, ok: false, error: r.error };
  return { tile: r.tile, upgrade: r.upgrade, ok: r.affordable, level: r.level, error: r.affordable ? undefined : r.reason };
}
