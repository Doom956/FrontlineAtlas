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
let prev = new Int32Array(0);
let stamp = new Uint32Array(0);
let gScore = new Int32Array(0);
let closed = new Uint32Array(0);
let stampGen = 0;

function ensureBuffers(n: number): void {
  if (bufSize === n) return;
  bufSize = n;
  prev = new Int32Array(n);
  stamp = new Uint32Array(n);
  gScore = new Int32Array(n);
  closed = new Uint32Array(n);
  stampGen = 0;
}
/** Starts a new "visited" generation so stamp[] never needs clearing. */
function nextStamp(): number {
  stampGen++;
  if (stampGen >= 0xffffffff) {
    stamp.fill(0);
    closed.fill(0);
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
  const queue = new Int32Array(n);
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
 * Returns the list of WATER tiles to follow (8-neighbour moves), ending next to `to`; null if unreachable.
 * Starts from the water tiles 4-adjacent to `from` (or `from` itself if it is water) and ends at the first water
 * tile 4-adjacent to `to` (or `to` itself if water). Diagonal steps may not squeeze between two land tiles.
 * Ports on different seas fail at once (static water bodies). Otherwise a coarse route over 8 x 8 blocks is found
 * first and a weighted A* (Chebyshev heuristic) searches only the blocks along it, so even routes around a continent
 * on the huge map expand few tiles; if that corridor is too tight, an unrestricted search follows (capped). Routes
 * are at most ASTAR_WEIGHT times the shortest.
 */
export function waterPath(
  map: MapData,
  from: number,
  to: number,
  maxLen = 2 * (map.width + map.height),
  budget = ASTAR_MAX_EXPANSIONS,
): number[] | null {
  const n = map.width * map.height;
  if (from < 0 || from >= n || to < 0 || to >= n) return null;
  if (!sameWater(map, from, to)) return null;
  expandBudget = budget;
  const corridor = coarseCorridor(map, from, to);
  if (corridor) {
    // Long routes: short searches between waypoints along the coarse route (each one tiny).
    if (corridor.cells.length > WAYPOINT_EVERY * 2) {
      const p = stitchedPath(map, from, to, corridor, maxLen);
      if (p) return p;
    }
    const p = astarWater(map, from, to, maxLen, corridor, expandBudget);
    if (p) return p;
  }
  if (expandBudget <= 0) return null;
  return astarWater(map, from, to, maxLen, null, expandBudget);
}
/** Tile expansions left for the current waterPath call (all its searches share them). */
let expandBudget = 0;
/** Running count of tiles expanded by water searches (to measure what a search cost). */
let expandedTotal = 0;
export function waterSearchSpent(): number {
  return expandedTotal;
}

/** Coarse route cells between two waypoints of a stitched path. */
const WAYPOINT_EVERY = 5;
/**
 * A route made of short A* legs between waypoints: every WAYPOINT_EVERY-th block of the coarse route contributes
 * its water tile nearest to the block centre (on the same water body). null if a leg fails.
 */
function stitchedPath(map: MapData, from: number, to: number, corridor: Corridor, maxLen: number): number[] | null {
  const cells = corridor.cells;
  const cwater = corridor.coarse.water;
  const w = map.width;
  const water = waterComponents(map);
  const ends: number[] = [];
  routeEnds(map, from, ends);
  if (!ends.length) return null;
  const body = water[ends[0]];
  const cw = (map.width >> COARSE_SHIFT) + 1;
  const B = 1 << COARSE_SHIFT;
  const waypoints: number[] = [];
  for (let k0 = WAYPOINT_EVERY; k0 < cells.length - WAYPOINT_EVERY / 2; k0 += WAYPOINT_EVERY) {
    // Prefer an open-water block near the step (a waypoint in a bay or an inlet makes the legs search around it).
    let k = k0;
    for (let d = 0; d <= 2; d++) {
      if (k0 + d < cells.length - 1 && cwater[cells[k0 + d]] >= B * B) {
        k = k0 + d;
        break;
      }
      if (d > 0 && k0 - d > 0 && cwater[cells[k0 - d]] >= B * B) {
        k = k0 - d;
        break;
      }
    }
    const cx = (cells[k] % cw) * B;
    const cy = ((cells[k] / cw) | 0) * B;
    let best = -1;
    let bd = Infinity;
    for (let y = cy; y < Math.min(map.height, cy + B); y++) {
      for (let x = cx; x < Math.min(w, cx + B); x++) {
        const i = y * w + x;
        if (water[i] !== body) continue;
        const d = (x - cx - B / 2) * (x - cx - B / 2) + (y - cy - B / 2) * (y - cy - B / 2);
        if (d < bd) {
          bd = d;
          best = i;
        }
      }
    }
    if (best >= 0) waypoints.push(best);
  }
  const out: number[] = [];
  let cur = from;
  for (let k = 0; k <= waypoints.length; k++) {
    const next = k < waypoints.length ? waypoints[k] : to;
    // Inside the corridor first (cheap); a goal in a narrow inlet may need a way around it.
    let leg = astarWater(map, cur, next, maxLen, corridor, Math.min(LEG_CORRIDOR_EXPANSIONS, expandBudget));
    if (!leg && expandBudget > 0) leg = astarWater(map, cur, next, maxLen, null, Math.min(LEG_MAX_EXPANSIONS, expandBudget));
    if (!leg) return null;
    // Legs share their joint tile.
    for (let q = out.length && leg[0] === out[out.length - 1] ? 1 : 0; q < leg.length; q++) out.push(leg[q]);
    cur = leg[leg.length - 1];
    if (out.length > maxLen * 2) return null;
  }
  return out;
}

/** Start (water next to `from`) and goal (water next to `to`) tiles of a ship route. */
function routeEnds(map: MapData, t: number, out: number[]): void {
  out.length = 0;
  if (isWater(map.terrain[t])) {
    out.push(t);
    return;
  }
  const nb: number[] = [];
  const k = neighbors4(map, t, nb);
  for (let q = 0; q < k; q++) if (isWater(map.terrain[nb[q]])) out.push(nb[q]);
}

interface Corridor {
  coarse: CoarseWater;
  gen: number;
  /** the coarse route, start to goal (block indexes) */
  cells: number[];
}

function astarWater(map: MapData, from: number, to: number, maxLen: number, corridor: Corridor | null, maxExpansions: number): number[] | null {
  const w = map.width;
  const h = map.height;
  const n = w * h;
  const terrain = map.terrain;
  ensureBuffers(n);
  const gen = nextStamp();
  const goals: number[] = [];
  routeEnds(map, to, goals);
  if (goals.length === 0) return null;
  const starts: number[] = [];
  routeEnds(map, from, starts);
  const gx = goals.map((g) => g % w);
  const gy = goals.map((g) => (g / w) | 0);
  const heur = (i: number): number => {
    const x = i % w;
    const y = (i / w) | 0;
    let best = Infinity;
    for (let q = 0; q < gx.length; q++) {
      const d = Math.max(Math.abs(x - gx[q]), Math.abs(y - gy[q]));
      if (d < best) best = d;
    }
    return best;
  };
  const isGoal = (i: number): boolean => {
    for (let q = 0; q < goals.length; q++) if (goals[q] === i) return true;
    return false;
  };
  const cmark = corridor ? corridor.coarse.mark : null;
  const cgen = corridor ? corridor.gen : 0;
  const cw = corridor ? corridor.coarse.cw : 0;
  heapSize = 0;
  for (const i of starts) {
    if (stamp[i] === gen) continue;
    stamp[i] = gen;
    prev[i] = -1;
    gScore[i] = 0;
    heapAdd(i, astarKey(0, heur(i)));
  }
  if (heapSize === 0) return null;
  let found = -1;
  let expanded = 0;
  while (heapSize > 0) {
    const i = heapNode[0];
    const f = heapKey[0];
    heapTake();
    const g = gScore[i];
    // Stale entry (a shorter way to i was found after it was queued), or already expanded (no reopening).
    if (f !== astarKey(g, heur(i)) || closed[i] === gen) continue;
    closed[i] = gen;
    if (isGoal(i)) {
      found = i;
      break;
    }
    if (++expanded > maxExpansions) break;
    expandBudget--;
    expandedTotal++;
    if (g >= maxLen) continue;
    const x = i % w;
    const y = (i / w) | 0;
    for (let k = 0; k < 8; k++) {
      const nx = x + DX8[k];
      const ny = y + DY8[k];
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const j = ny * w + nx;
      if (!isWater(terrain[j])) continue;
      if (cmark && cmark[((ny >> COARSE_SHIFT) * cw) + (nx >> COARSE_SHIFT)] !== cgen) continue;
      // No diagonal corner-cutting between two land tiles.
      if (DX8[k] !== 0 && DY8[k] !== 0) {
        if (!isWater(terrain[y * w + nx]) && !isWater(terrain[ny * w + x])) continue;
      }
      const ng = g + 1;
      if (closed[j] === gen || (stamp[j] === gen && gScore[j] <= ng)) continue;
      stamp[j] = gen;
      gScore[j] = ng;
      prev[j] = i;
      heapAdd(j, astarKey(ng, heur(j)));
    }
  }
  if (found < 0) return null;
  const path: number[] = [];
  for (let i = found; i !== -1; i = prev[i]) path.push(i);
  path.reverse();
  return path;
}

// ---- coarse water grid (8 x 8 blocks) for corridor routing, per map ----
const COARSE_SHIFT = 3;
interface CoarseWater {
  cw: number;
  ch: number;
  /** water tiles per block */
  water: Uint8Array;
  /** corridor marks (generation stamps) */
  mark: Uint32Array;
  markGen: number;
  stamp: Uint32Array;
  stampGen: number;
  g: Int32Array;
  prev: Int32Array;
}
const coarseGrids = new WeakMap<MapData, CoarseWater>();
function coarseWater(map: MapData): CoarseWater {
  let c = coarseGrids.get(map);
  if (c) return c;
  const cw = (map.width >> COARSE_SHIFT) + 1;
  const ch = (map.height >> COARSE_SHIFT) + 1;
  const water = new Uint8Array(cw * ch);
  const { width: w, terrain } = map;
  for (let i = 0; i < terrain.length; i++) {
    if (terrain[i] > 1) continue;
    const x = i % w;
    const y = (i - x) / w;
    const k = (y >> COARSE_SHIFT) * cw + (x >> COARSE_SHIFT);
    if (water[k] < 255) water[k]++;
  }
  c = { cw, ch, water, mark: new Uint32Array(cw * ch), markGen: 0, stamp: new Uint32Array(cw * ch), stampGen: 0, g: new Int32Array(cw * ch), prev: new Int32Array(cw * ch) };
  coarseGrids.set(map, c);
  return c;
}

/**
 * A corridor of blocks for a ship route: an A* over 8 x 8 blocks that hold water, from the start tiles' blocks to the
 * goal tiles' blocks; the route's blocks and their neighbours are marked. null if no coarse route.
 */
function coarseCorridor(map: MapData, from: number, to: number): Corridor | null {
  const c = coarseWater(map);
  const w = map.width;
  const cw = c.cw;
  const ch = c.ch;
  const starts: number[] = [];
  const goals: number[] = [];
  routeEnds(map, from, starts);
  routeEnds(map, to, goals);
  if (!starts.length || !goals.length) return null;
  const cellOf = (t: number): number => (((t / w) | 0) >> COARSE_SHIFT) * cw + ((t % w) >> COARSE_SHIFT);
  const goalCells = goals.map(cellOf);
  const gx = goalCells.map((k) => k % cw);
  const gy = goalCells.map((k) => (k / cw) | 0);
  const heur = (k: number): number => {
    const x = k % cw;
    const y = (k / cw) | 0;
    let best = Infinity;
    for (let q = 0; q < gx.length; q++) best = Math.min(best, Math.max(Math.abs(x - gx[q]), Math.abs(y - gy[q])));
    return best;
  };
  if (++c.stampGen >= 0xffffffff) {
    c.stamp.fill(0);
    c.stampGen = 1;
  }
  const gen = c.stampGen;
  heapSize = 0;
  for (const t of starts) {
    const k = cellOf(t);
    if (c.stamp[k] === gen) continue;
    c.stamp[k] = gen;
    c.g[k] = 0;
    c.prev[k] = -1;
    heapAdd(k, astarKey(0, heur(k)));
  }
  let found = -1;
  while (heapSize > 0) {
    const k = heapNode[0];
    const f = heapKey[0];
    heapTake();
    const g = c.g[k];
    if (f !== astarKey(g, heur(k))) continue;
    if (goalCells.includes(k)) {
      found = k;
      break;
    }
    const x = k % cw;
    const y = (k / cw) | 0;
    for (let d = 0; d < 8; d++) {
      const nx = x + DX8[d];
      const ny = y + DY8[d];
      if (nx < 0 || ny < 0 || nx >= cw || ny >= ch) continue;
      const j = ny * cw + nx;
      if (c.water[j] === 0) continue;
      const ng = g + 1;
      if (c.stamp[j] === gen && c.g[j] <= ng) continue;
      c.stamp[j] = gen;
      c.g[j] = ng;
      c.prev[j] = k;
      heapAdd(j, astarKey(ng, heur(j)));
    }
  }
  if (found < 0) return null;
  if (++c.markGen >= 0xffffffff) {
    c.mark.fill(0);
    c.markGen = 1;
  }
  const mg = c.markGen;
  const cells: number[] = [];
  for (let k = found; k !== -1; k = c.prev[k]) {
    cells.push(k);
    const x = k % cw;
    const y = (k / cw) | 0;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx >= 0 && ny >= 0 && nx < cw && ny < ch) c.mark[ny * cw + nx] = mg;
      }
    }
  }
  cells.reverse();
  return { coarse: c, gen: mg, cells };
}

/**
 * A* key: f = g + ASTAR_WEIGHT x h first (weighted A*: a slightly longer route, far fewer tiles searched around
 * continents), ties toward deeper nodes; exact in doubles.
 */
function astarKey(g: number, h: number): number {
  return (g + ASTAR_WEIGHT * h) * 65536 - g;
}
/** Weight of the A* heuristic (1 = shortest paths; more = faster searches, paths at most this much longer). */
const ASTAR_WEIGHT = 1.5;
/** A* gives up (no path) after expanding this many tiles (one leg of a stitched route: LEG_MAX_EXPANSIONS). */
const ASTAR_MAX_EXPANSIONS = 400000;
const LEG_MAX_EXPANSIONS = 20000;
const LEG_CORRIDOR_EXPANSIONS = 3000;

// ---- binary heap of (node, key) for A* (scratch, shared by every call; the sim is single-threaded) ----
let heapNode = new Int32Array(1024);
let heapKey = new Float64Array(1024);
let heapSize = 0;
function heapAdd(node: number, key: number): void {
  if (heapSize >= heapNode.length) {
    const n2 = new Int32Array(heapNode.length * 2);
    n2.set(heapNode);
    const k2 = new Float64Array(heapKey.length * 2);
    k2.set(heapKey);
    heapNode = n2;
    heapKey = k2;
  }
  let i = heapSize++;
  while (i > 0) {
    const p = (i - 1) >> 1;
    if (heapKey[p] <= key) break;
    heapNode[i] = heapNode[p];
    heapKey[i] = heapKey[p];
    i = p;
  }
  heapNode[i] = node;
  heapKey[i] = key;
}
function heapTake(): void {
  const n = --heapSize;
  if (n <= 0) {
    heapSize = 0;
    return;
  }
  const lastN = heapNode[n];
  const lastK = heapKey[n];
  let i = 0;
  for (;;) {
    let c = 2 * i + 1;
    if (c >= n) break;
    if (c + 1 < n && heapKey[c + 1] < heapKey[c]) c++;
    if (heapKey[c] >= lastK) break;
    heapNode[i] = heapNode[c];
    heapKey[i] = heapKey[c];
    i = c;
  }
  heapNode[i] = lastN;
  heapKey[i] = lastK;
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

// ---- static water bodies (terrain never changes): 4-connected labels, which is exactly what ships can reach ----
// (a diagonal move without corner cutting always has an orthogonal water tile next to it, so 8-moves add nothing).
const waterBodies = new WeakMap<MapData, Int32Array>();

/** Builds the static water data of a map (water bodies, coarse routing grid) now, so play never pays for it. */
export function prepareWater(map: MapData): void {
  waterComponents(map);
  coarseWater(map);
}

/** Water body id per tile (0 = land). Computed once per map. */
export function waterComponents(map: MapData): Int32Array {
  let c = waterBodies.get(map);
  if (c && c.length === map.terrain.length) return c;
  const { width: w, terrain } = map;
  const n = terrain.length;
  c = new Int32Array(n);
  const q = new Int32Array(n);
  let id = 0;
  for (let s = 0; s < n; s++) {
    if (terrain[s] > 1 || c[s] !== 0) continue;
    id++;
    let head = 0;
    let tail = 0;
    q[tail++] = s;
    c[s] = id;
    while (head < tail) {
      const i = q[head++];
      const x = i % w;
      if (x > 0 && terrain[i - 1] <= 1 && c[i - 1] === 0) (c[i - 1] = id), (q[tail++] = i - 1);
      if (x < w - 1 && terrain[i + 1] <= 1 && c[i + 1] === 0) (c[i + 1] = id), (q[tail++] = i + 1);
      if (i >= w && terrain[i - w] <= 1 && c[i - w] === 0) (c[i - w] = id), (q[tail++] = i - w);
      if (i < n - w && terrain[i + w] <= 1 && c[i + w] === 0) (c[i + w] = id), (q[tail++] = i + w);
    }
  }
  waterBodies.set(map, c);
  return c;
}

/** Water bodies a tile touches: itself if water, else its 4-adjacent water tiles' (up to 4 ids, 0 = none). */
function touchingWater(map: MapData, t: number, out: number[]): number {
  const c = waterComponents(map);
  if (map.terrain[t] <= 1) {
    out[0] = c[t];
    return 1;
  }
  const w = map.width;
  const x = t % w;
  let k = 0;
  if (x > 0 && c[t - 1]) out[k++] = c[t - 1];
  if (x < w - 1 && c[t + 1]) out[k++] = c[t + 1];
  if (t >= w && c[t - w]) out[k++] = c[t - w];
  if (t < c.length - w && c[t + w]) out[k++] = c[t + w];
  return k;
}
const wa = [0, 0, 0, 0];
const wb = [0, 0, 0, 0];
/** True if a ship could sail from (the water next to) tile a to (the water next to) tile b. */
export function sameWater(map: MapData, a: number, b: number): boolean {
  const ka = touchingWater(map, a, wa);
  const kb = touchingWater(map, b, wb);
  for (let i = 0; i < ka; i++) for (let j = 0; j < kb; j++) if (wa[i] === wb[j]) return true;
  return false;
}
