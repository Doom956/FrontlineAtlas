// Tile index helpers and grid algorithms. Index i = y * width + x.
import { isWater } from './types';
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
  const w = map.width;
  const x = i % w;
  const y = (i / w) | 0;
  let n = 0;
  if (x > 0) out[n++] = i - 1;
  if (x < w - 1) out[n++] = i + 1;
  if (y > 0) out[n++] = i - w;
  if (y < map.height - 1) out[n++] = i + w;
  return n;
}
/** Writes the 8-neighbours of i into out, returns how many. */
export function neighbors8(map: MapData, i: number, out: number[]): number {
  const w = map.width;
  const h = map.height;
  const x = i % w;
  const y = (i / w) | 0;
  let n = 0;
  for (let dy = -1; dy <= 1; dy++) {
    const ny = y + dy;
    if (ny < 0 || ny >= h) continue;
    for (let dx = -1; dx <= 1; dx++) {
      if (dx === 0 && dy === 0) continue;
      const nx = x + dx;
      if (nx < 0 || nx >= w) continue;
      out[n++] = ny * w + nx;
    }
  }
  return n;
}
/** Euclidean distance between two tiles. */
export function tileDist(map: MapData, a: number, b: number): number {
  const dx = tileX(map, a) - tileX(map, b);
  const dy = tileY(map, a) - tileY(map, b);
  return Math.sqrt(dx * dx + dy * dy);
}
/** Calls fn for every in-bounds tile within radius r (euclidean) of center. */
export function forEachInRadius(map: MapData, center: number, r: number, fn: (i: number, d: number) => void): void {
  const w = map.width;
  const cx = center % w;
  const cy = (center / w) | 0;
  const ri = Math.floor(r);
  const r2 = r * r;
  const y0 = Math.max(0, cy - ri);
  const y1 = Math.min(map.height - 1, cy + ri);
  const x0 = Math.max(0, cx - ri);
  const x1 = Math.min(w - 1, cx + ri);
  for (let y = y0; y <= y1; y++) {
    const dy = y - cy;
    const row = y * w;
    for (let x = x0; x <= x1; x++) {
      const dx = x - cx;
      const d2 = dx * dx + dy * dy;
      if (d2 <= r2) fn(row + x, Math.sqrt(d2));
    }
  }
}

// ---- reusable BFS buffers (one set per map size; the sim is single-threaded) ----
let bufSize = 0;
let queue = new Int32Array(0);
let prev = new Int32Array(0);
let stamp = new Uint32Array(0);
let stampGen = 0;

function ensureBuffers(n: number): void {
  if (bufSize === n) return;
  bufSize = n;
  queue = new Int32Array(n);
  prev = new Int32Array(n);
  stamp = new Uint32Array(n);
  stampGen = 0;
}
/** Starts a new "visited" generation so stamp[] never needs clearing. */
function nextStamp(): number {
  stampGen++;
  if (stampGen >= 0xffffffff) {
    stamp.fill(0);
    stampGen = 1;
  }
  return stampGen;
}

/**
 * Multi-source BFS (4-neighbour steps) over tiles where passable(i) is true.
 * Returns distance per tile, 65535 where unreachable or beyond maxDist.
 * Sources are always distance 0, even if not passable themselves.
 */
export function distanceField(map: MapData, sources: number[], passable: (i: number) => boolean, maxDist: number): Uint16Array {
  const w = map.width;
  const h = map.height;
  const n = w * h;
  ensureBuffers(n);
  const dist = new Uint16Array(n).fill(65535);
  const limit = Math.min(maxDist, 65534);
  let head = 0;
  let tail = 0;
  for (const s of sources) {
    if (s < 0 || s >= n || dist[s] === 0) continue;
    dist[s] = 0;
    queue[tail++] = s;
  }
  while (head < tail) {
    const i = queue[head++];
    const d = dist[i] + 1;
    if (d > limit) continue;
    const x = i % w;
    // Inline 4-neighbours (hot loop).
    if (x > 0) {
      const j = i - 1;
      if (dist[j] === 65535 && passable(j)) {
        dist[j] = d;
        queue[tail++] = j;
      }
    }
    if (x < w - 1) {
      const j = i + 1;
      if (dist[j] === 65535 && passable(j)) {
        dist[j] = d;
        queue[tail++] = j;
      }
    }
    if (i >= w) {
      const j = i - w;
      if (dist[j] === 65535 && passable(j)) {
        dist[j] = d;
        queue[tail++] = j;
      }
    }
    if (i < n - w) {
      const j = i + w;
      if (dist[j] === 65535 && passable(j)) {
        dist[j] = d;
        queue[tail++] = j;
      }
    }
  }
  return dist;
}

const DX8 = [-1, 0, 1, -1, 1, -1, 0, 1];
const DY8 = [-1, -1, -1, 0, 0, 1, 1, 1];

/**
 * Water path for ships from a coastal land tile (or water tile) to another coastal land tile.
 * Returns the list of WATER tiles to follow (8-neighbour BFS), ending next to `to`; null if unreachable.
 * Starts from the water tiles 4-adjacent to `from` (or `from` itself if it is water) and ends at the first water
 * tile 4-adjacent to `to` (or `to` itself if water). Diagonal steps may not squeeze between two land tiles.
 * The search gives up after `maxLen` steps (default: 2 x (width + height)).
 */
export function waterPath(map: MapData, from: number, to: number, maxLen = 2 * (map.width + map.height)): number[] | null {
  const w = map.width;
  const h = map.height;
  const n = w * h;
  if (from < 0 || from >= n || to < 0 || to >= n) return null;
  const terrain = map.terrain;
  ensureBuffers(n);
  const gen = nextStamp();
  // At most 4 goal tiles, so a linear check is cheapest.
  const goalSet: number[] = [];
  if (isWater(terrain[to])) goalSet.push(to);
  else {
    const nb: number[] = [];
    const k = neighbors4(map, to, nb);
    for (let q = 0; q < k; q++) if (isWater(terrain[nb[q]])) goalSet.push(nb[q]);
  }
  if (goalSet.length === 0) return null;
  const isGoal = (i: number): boolean => {
    for (let q = 0; q < goalSet.length; q++) if (goalSet[q] === i) return true;
    return false;
  };

  let head = 0;
  let tail = 0;
  const pushStart = (i: number): void => {
    if (stamp[i] === gen) return;
    stamp[i] = gen;
    prev[i] = -1;
    queue[tail++] = i;
  };
  if (isWater(terrain[from])) pushStart(from);
  else {
    const nb: number[] = [];
    const k = neighbors4(map, from, nb);
    for (let q = 0; q < k; q++) if (isWater(terrain[nb[q]])) pushStart(nb[q]);
  }
  if (tail === 0) return null;

  // BFS layer by layer so we can stop at maxLen.
  let layerEnd = tail;
  let depth = 0;
  let found = -1;
  while (head < tail) {
    const i = queue[head++];
    if (isGoal(i)) {
      found = i;
      break;
    }
    const x = i % w;
    const y = (i / w) | 0;
    for (let k = 0; k < 8; k++) {
      const nx = x + DX8[k];
      const ny = y + DY8[k];
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const j = ny * w + nx;
      if (stamp[j] === gen || !isWater(terrain[j])) continue;
      // No diagonal corner-cutting between two land tiles.
      if (DX8[k] !== 0 && DY8[k] !== 0) {
        if (!isWater(terrain[y * w + nx]) && !isWater(terrain[ny * w + x])) continue;
      }
      stamp[j] = gen;
      prev[j] = i;
      queue[tail++] = j;
    }
    if (head === layerEnd) {
      depth++;
      if (depth > maxLen) break;
      layerEnd = tail;
    }
  }
  if (found < 0) return null;
  const path: number[] = [];
  for (let i = found; i !== -1; i = prev[i]) path.push(i);
  path.reverse();
  return path;
}

/** Nearest tile (euclidean) satisfying pred within radius r of center, or -1. Searches outward ring by ring. */
export function nearestTile(map: MapData, center: number, r: number, pred: (i: number) => boolean): number {
  const w = map.width;
  const h = map.height;
  const cx = center % w;
  const cy = (center / w) | 0;
  const maxRing = Math.min(Math.ceil(r), Math.max(w, h));
  const r2 = r * r;
  let best = -1;
  let bestD2 = Infinity;
  const test = (x: number, y: number): void => {
    if (x < 0 || y < 0 || x >= w || y >= h) return;
    const dx = x - cx;
    const dy = y - cy;
    const d2 = dx * dx + dy * dy;
    if (d2 > r2 || d2 >= bestD2) return;
    const i = y * w + x;
    if (pred(i)) {
      best = i;
      bestD2 = d2;
    }
  };
  for (let d = 0; d <= maxRing; d++) {
    // Every tile on Chebyshev ring d is at least d away, so stop once d exceeds the best found distance.
    if (d * d > bestD2) break;
    if (d === 0) {
      test(cx, cy);
      continue;
    }
    for (let x = cx - d; x <= cx + d; x++) {
      test(x, cy - d);
      test(x, cy + d);
    }
    for (let y = cy - d + 1; y <= cy + d - 1; y++) {
      test(cx - d, y);
      test(cx + d, y);
    }
  }
  return best;
}
