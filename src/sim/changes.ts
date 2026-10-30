// Tile change feed for the renderer.
//
// The sim records every tile whose owner changed (setOwner) or whose fallout started or ended. The client drains the
// list once per frame and redraws only those tiles. The list has a fixed capacity: when it is full, `overflow` is set
// and nothing more is recorded until the next drain; the consumer then refreshes the whole map. Duplicates are
// allowed (a tile taken twice in one tick is listed twice). Headless games never drain: the list just fills up once
// and stays in overflow, which costs nothing.
import type { GameState } from './types';

/** Capacity of the change list (tiles). */
export const TILE_CHANGES_CAPACITY = 1 << 18;

export interface TileChanges {
  tiles: Int32Array;
  count: number;
  overflow: boolean;
}

export function createTileChanges(): TileChanges {
  return { tiles: new Int32Array(TILE_CHANGES_CAPACITY), count: 0, overflow: false };
}

/** Records that a tile changed (owner or fallout). */
export function recordTileChange(state: GameState, tile: number): void {
  const c = state.changes;
  if (c.overflow) return;
  if (c.count >= c.tiles.length) {
    c.overflow = true;
    return;
  }
  c.tiles[c.count++] = tile;
}

/**
 * The tiles changed since the last drain, and clears the list. The returned `tiles` array is reused: read the first
 * `count` entries before the next tick. `overflow` = too many changes were made: refresh everything.
 */
export function drainTileChanges(state: GameState): { tiles: Int32Array; count: number; overflow: boolean } {
  const c = state.changes;
  const out = { tiles: c.tiles, count: c.count, overflow: c.overflow };
  c.count = 0;
  c.overflow = false;
  return out;
}
