// Tile index helpers and grid algorithms. Index i = y * width + x.
import type { MapData } from './types';

export function tileIndex(map: MapData, x: number, y: number): number {
  return y * map.width + x;
}
export function tileX(map: MapData, i: number): number {
  return i % map.width;
}
export function tileY(map: MapData, i: number): number {
  return (i / map.width) | 0;
}
export function inBounds(map: MapData, x: number, y: number): boolean {
  return x >= 0 && y >= 0 && x < map.width && y < map.height;
}
/** Writes the 4-neighbours of i into out, returns how many. */
export function neighbors4(map: MapData, i: number, out: number[]): number {
  // TODO(WP-A)
  return 0;
}
/** Euclidean distance between two tiles. */
export function tileDist(map: MapData, a: number, b: number): number {
  const dx = tileX(map, a) - tileX(map, b);
  const dy = tileY(map, a) - tileY(map, b);
  return Math.sqrt(dx * dx + dy * dy);
}
/** Calls fn for every in-bounds tile within radius r (euclidean) of center. */
export function forEachInRadius(map: MapData, center: number, r: number, fn: (i: number, d: number) => void): void {
  // TODO(WP-A)
}
/**
 * Multi-source BFS (4-neighbour steps) over tiles where passable(i) is true.
 * Returns distance per tile, 65535 where unreachable or beyond maxDist.
 */
export function distanceField(map: MapData, sources: number[], passable: (i: number) => boolean, maxDist: number): Uint16Array {
  // TODO(WP-A)
  return new Uint16Array(map.width * map.height).fill(65535);
}
/**
 * Water path for ships from a coastal land tile (or water tile) to another coastal land tile.
 * Returns the list of WATER tiles to follow (8-neighbour BFS), ending next to `to`; null if unreachable.
 */
export function waterPath(map: MapData, from: number, to: number): number[] | null {
  // TODO(WP-A)
  return null;
}
/** Nearest tile satisfying pred within radius r of center (spiral/BFS), or -1. */
export function nearestTile(map: MapData, center: number, r: number, pred: (i: number) => boolean): number {
  // TODO(WP-A)
  return -1;
}
