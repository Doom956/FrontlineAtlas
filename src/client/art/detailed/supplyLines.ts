// Supply lines (client only, pure: no DOM, no random, no clock): where the rails, the rail yards and the sea lanes of a
// nation's supply network run, as pictures drawn from the network state. Art lab mockup for now; nothing here changes a
// rule. The hubs are the capital, cities, factories, ports and forts.
//   rails      each hub runs a rail to its RAIL_LINKS nearest hubs of the same owner (within RAIL_MAX_DIST tiles), laid
//              over the owner's own dry land by a shortest-path search that follows the terrain: flat ground is cheap,
//              hills cost more (the rail winds along the valleys and the coast), mountains and swamps are never
//              entered (the rail goes round them) and a river or a narrow strait is crossed on a short straight bridge
//              (at most BRIDGE_MAX water tiles). The tile route is then pulled straight where the land allows and its
//              corners rounded, so it reads as a laid rail, not a staircase.
//   junctions  a hub where 3 or more rails meet gets a small rail yard, its sidings laid along the rails' main axis
//   sea lanes  a port reaches a port or beachhead on another landmass over open water, keeping a tile off the shore
// The results depend only on the hubs and the terrain (ties broken by id and tile index), so every player sees the
// same lines and the game can rebuild them only when a hub or the land under a line changes.

/** Supply hub kinds (the buildings that feed and pass on supply). */
export type HubType = 'capital' | 'city' | 'factory' | 'port' | 'fort';

export interface Hub {
  id: number;
  type: HubType;
  /** anchor tile */
  x: number;
  y: number;
  owner: number;
  /** half size of its building's footprint, tiles (Chebyshev; default HUB_FOOT) */
  foot?: number;
}

/**
 * A hub's building covers the tiles within this many tiles of its own (a 5 x 5 square): rails go round other hubs'
 * footprints and only run into their own two hubs, from the footprint's edge to its centre, under the building.
 */
export const HUB_FOOT = 2;

/** Whether tile (x, y) lies in the footprint of the building on tile (hx, hy) with half size r. */
export function inFootprint(x: number, y: number, hx: number, hy: number, r = HUB_FOOT): boolean {
  return Math.abs(x - hx) <= r && Math.abs(y - hy) <= r;
}

export interface SupplyTerrain {
  /** terrain id of a tile (sim/types.ts Terrain: 0 and 1 water, 5 mountains, 7 swamp); off the map: 0 */
  terrain: (x: number, y: number) => number;
  /** owner of a land tile (0 none) */
  owner: (x: number, y: number) => number;
}

export type P = [number, number];

export interface Rail {
  /** hub ids, a < b */
  a: number;
  b: number;
  /** the route in tile coordinates, from hub a's tile centre to hub b's */
  path: P[];
  /** the bridges: arc-length ranges along the path (tiles), each a straight run over water */
  bridges: [number, number][];
}

export interface Junction {
  hub: number;
  /** centre (tile coordinates) and the yard's long axis (radians, 0 = east) */
  x: number;
  y: number;
  angle: number;
  /** rails meeting there */
  degree: number;
}

/** Rails a hub lays to its nearest hubs. */
export const RAIL_LINKS = 2;
/** Longest rail, in tiles between the two hubs. */
export const RAIL_MAX_DIST = 60;
/** Longest bridge, in water tiles crossed. */
export const BRIDGE_MAX = 3;
/** A junction needs this many rails at one hub. */
export const JUNCTION_DEGREE = 3;
/** Search margin round the two ends, in tiles (a detour round a mountain range may go this far out). */
const MARGIN = 14;

const WATER = (t: number): boolean => t <= 1;
/** Terrain a rail never runs on: mountains and swamps. */
const BLOCKED = (t: number): boolean => t === 5 || t === 7;

/** Cost to lay one tile of rail on a terrain (flat 1; null: never). */
function landCost(t: number): number | null {
  switch (t) {
    case 2: return 1;
    case 6: return 1.05;
    case 8: return 1.1;
    case 3: return 1.45;
    case 4: return 2.4;
    default: return null;
  }
}

/** A small binary heap of node indices keyed by cost (ties: lower index first, so the result is stable). */
class Heap {
  private k: number[] = [];
  private v: number[] = [];
  get size(): number {
    return this.v.length;
  }
  push(v: number, k: number): void {
    const K = this.k;
    const V = this.v;
    let i = V.length;
    K.push(k);
    V.push(v);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (K[p] < k || (K[p] === k && V[p] <= v)) break;
      K[i] = K[p];
      V[i] = V[p];
      i = p;
    }
    K[i] = k;
    V[i] = v;
  }
  pop(): number {
    const K = this.k;
    const V = this.v;
    const top = V[0];
    const lk = K.pop() as number;
    const lv = V.pop() as number;
    const n = V.length;
    if (n) {
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        if (l >= n) break;
        const r = l + 1;
        const c = r < n && (K[r] < K[l] || (K[r] === K[l] && V[r] < V[l])) ? r : l;
        if (K[c] > lk || (K[c] === lk && V[c] >= lv)) break;
        K[i] = K[c];
        V[i] = V[c];
        i = c;
      }
      K[i] = lk;
      V[i] = lv;
    }
    return top;
  }
}

const DIRS: readonly [number, number][] = [[1, 0], [0, 1], [-1, 0], [0, -1], [1, 1], [-1, 1], [-1, -1], [1, -1]];

/** Arc length of a polyline. */
export function pathLength(pts: readonly P[]): number {
  let s = 0;
  for (let i = 0; i + 1 < pts.length; i++) s += Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]);
  return s;
}

/** The point and heading (radians, 0 = east, clockwise on screen) at arc length `s` along a polyline (clamped). */
export function pointAt(pts: readonly P[], s: number): { x: number; y: number; angle: number } {
  let rest = Math.max(0, s);
  for (let i = 0; i + 1 < pts.length; i++) {
    const dx = pts[i + 1][0] - pts[i][0];
    const dy = pts[i + 1][1] - pts[i][1];
    const len = Math.hypot(dx, dy);
    if (rest <= len || i + 2 === pts.length) {
      const t = len > 0 ? Math.min(1, rest / len) : 0;
      return { x: pts[i][0] + dx * t, y: pts[i][1] + dy * t, angle: Math.atan2(dy, dx) };
    }
    rest -= len;
  }
  return { x: pts[0]?.[0] ?? 0, y: pts[0]?.[1] ?? 0, angle: 0 };
}

/** Corner rounding (Chaikin), the two ends kept. */
function chaikin(pts: P[], rounds: number): P[] {
  let cur = pts;
  for (let r = 0; r < rounds && cur.length > 2; r++) {
    const out: P[] = [cur[0]];
    for (let i = 0; i + 1 < cur.length; i++) {
      const [ax, ay] = cur[i];
      const [bx, by] = cur[i + 1];
      if (i > 0) out.push([ax * 0.75 + bx * 0.25, ay * 0.75 + by * 0.25]);
      if (i + 2 < cur.length) out.push([ax * 0.25 + bx * 0.75, ay * 0.25 + by * 0.75]);
    }
    out.push(cur[cur.length - 1]);
    cur = out;
  }
  return cur;
}

/** True when the straight run from p to q stays on tiles `ok` accepts (sampled every quarter tile). */
function lineOk(p: P, q: P, ok: (x: number, y: number) => boolean): boolean {
  const n = Math.max(1, Math.ceil(Math.hypot(q[0] - p[0], q[1] - p[1]) * 4));
  for (let i = 0; i <= n; i++) {
    const x = p[0] + ((q[0] - p[0]) * i) / n;
    const y = p[1] + ((q[1] - p[1]) * i) / n;
    if (!ok(Math.floor(x), Math.floor(y))) return false;
    // a quarter tile of room either side, so the rounded curve never cuts a blocked corner
    if (!ok(Math.floor(x + 0.22), Math.floor(y + 0.22)) || !ok(Math.floor(x - 0.22), Math.floor(y - 0.22)) || !ok(Math.floor(x + 0.22), Math.floor(y - 0.22)) || !ok(Math.floor(x - 0.22), Math.floor(y + 0.22))) return false;
  }
  return true;
}

/** String pulling: from each kept point on to the farthest point still in straight sight over `ok` tiles. */
function pull(pts: P[], ok: (x: number, y: number) => boolean): P[] {
  if (pts.length <= 2) return pts.slice();
  const out: P[] = [pts[0]];
  let i = 0;
  while (i < pts.length - 1) {
    let j = pts.length - 1;
    while (j > i + 1 && !lineOk(pts[i], pts[j], ok)) j--;
    out.push(pts[j]);
    i = j;
  }
  return out;
}

/** Long straight legs get a point every `step` tiles, so the corner rounding only bends near the corners. */
function densify(pts: P[], step: number): P[] {
  const out: P[] = [pts[0]];
  for (let i = 0; i + 1 < pts.length; i++) {
    const [ax, ay] = pts[i];
    const [bx, by] = pts[i + 1];
    const m = Math.max(1, Math.round(Math.hypot(bx - ax, by - ay) / step));
    for (let k = 1; k <= m; k++) out.push([ax + ((bx - ax) * k) / m, ay + ((by - ay) * k) / m]);
  }
  return out;
}

/**
 * One dry stretch of a rail smoothed: string-pulled over `landOk` tiles, then rounded (wide curves first, the tile route
 * as the last resort). `ok` is where the rounded line may run (land, or water for the straight run of a bridge).
 */
function smoothRun(leg: P[], ends: [P | null, P | null], landOk: (x: number, y: number) => boolean, ok: (x: number, y: number) => boolean): P[] {
  const core = pull(leg, landOk);
  for (const [step, rounds] of [[4, 4], [3, 3], [1.5, 3]] as const) {
    const out: P[] = [];
    if (ends[0]) out.push(ends[0]);
    out.push(...chaikin(densify(core, step), rounds));
    if (ends[1]) out.push(ends[1]);
    let good = true;
    for (let i = 0; good && i + 1 < out.length; i++) if (!lineOk(out[i], out[i + 1], ok)) good = false;
    if (good) return out;
  }
  return leg;
}

/**
 * The sim's rail route (tile ids on a map `w` wide, from hub a to hub b) as the smooth line the art draws: the same
 * smoothing a route of railRoute gets, over the owner's own dry land (the two end tiles always count). Water tiles on the
 * route (a bridge) split it into dry stretches joined by a straight run. Null for fewer than two tiles. Pure.
 */
export function smoothRoute(tiles: ArrayLike<number>, w: number, t: SupplyTerrain, own: number): { path: P[]; bridges: [number, number][] } | null {
  const n = tiles.length;
  if (n < 2) return null;
  const centre = (c: number): P => [(c % w) + 0.5, ((c / w) | 0) + 0.5];
  const a = tiles[0];
  const b = tiles[n - 1];
  const isEnd = (x: number, y: number): boolean => y * w + x === a || y * w + x === b;
  const landOk = (x: number, y: number): boolean => isEnd(x, y) || (!WATER(t.terrain(x, y)) && t.owner(x, y) === own);
  const ok = (x: number, y: number): boolean => landOk(x, y) || WATER(t.terrain(x, y));
  const legs: P[][] = [[centre(tiles[0])]];
  for (let i = 1; i < n; i++) {
    const c = tiles[i];
    if (WATER(t.terrain(c % w, (c / w) | 0)) && !isEnd(c % w, (c / w) | 0)) continue;
    const prev = tiles[i - 1];
    if (WATER(t.terrain(prev % w, (prev / w) | 0)) && !isEnd(prev % w, (prev / w) | 0)) legs.push([centre(c)]);
    else legs[legs.length - 1].push(centre(c));
  }
  const path: P[] = [];
  const bridges: [number, number][] = [];
  for (const leg of legs) {
    const pts = leg.length < 2 ? leg : smoothRun(leg, [null, null], landOk, ok);
    if (path.length) {
      const s0 = pathLength(path);
      const last = path[path.length - 1];
      bridges.push([s0 + 0.35, s0 + Math.hypot(pts[0][0] - last[0], pts[0][1] - last[1]) - 0.35]);
    }
    path.push(...pts);
  }
  const clean: P[] = [path[0]];
  for (const q of path) {
    const l = clean[clean.length - 1];
    if (Math.hypot(q[0] - l[0], q[1] - l[1]) > 1e-6) clean.push(q);
  }
  return clean.length < 2 ? null : { path: clean, bridges };
}

/**
 * The rail route from hub `a` to hub `b` over `a`'s owner's dry land (see the header), or null when there is none
 * (enemy or neutral land in the way, a water gap wider than a bridge, the hubs on different owners).
 */
export function railRoute(a: Hub, b: Hub, t: SupplyTerrain, others: readonly Hub[] = []): { path: P[]; bridges: [number, number][] } | null {
  if (a.owner === 0 || a.owner !== b.owner) return null;
  const own = a.owner;
  // other buildings' footprints are off limits (except where they overlap the two ends' own)
  const feet = others.filter((h) => h.id !== a.id && h.id !== b.id && !(h.x === a.x && h.y === a.y) && !(h.x === b.x && h.y === b.y));
  const ownFoot = (x: number, y: number): boolean => inFootprint(x, y, a.x, a.y, a.foot ?? HUB_FOOT) || inFootprint(x, y, b.x, b.y, b.foot ?? HUB_FOOT);
  const foreign = (x: number, y: number): boolean => {
    for (const h of feet) if (inFootprint(x, y, h.x, h.y, h.foot ?? HUB_FOOT)) return !ownFoot(x, y);
    return false;
  };
  const x0 = Math.min(a.x, b.x) - MARGIN;
  const y0 = Math.min(a.y, b.y) - MARGIN;
  const W = Math.max(a.x, b.x) + MARGIN - x0 + 1;
  const H = Math.max(a.y, b.y) + MARGIN - y0 + 1;
  const ter = (x: number, y: number): number => t.terrain(x, y);
  const lay = (x: number, y: number): number | null => {
    const tt = ter(x, y);
    if (WATER(tt) || t.owner(x, y) !== own || foreign(x, y)) return null;
    const c = landCost(tt);
    if (c === null) return null;
    // a tile next to a mountain or a swamp costs more: the rail keeps off the foot of the peaks and the reeds
    let near = 0;
    for (const [dx, dy] of DIRS) if (BLOCKED(ter(x + dx, y + dy))) near = 1;
    return c + near * 1.2;
  };
  // the hub tiles themselves are always enterable (a fort on a hill, a city on a swamp's edge)
  const hubOk = (x: number, y: number): boolean => (x === a.x && y === a.y) || (x === b.x && y === b.y);
  const cost = new Float64Array(W * H).fill(Infinity);
  const from = new Int32Array(W * H).fill(-1);
  /** a node reached over a bridge (its predecessor is across the water) */
  const bridged = new Uint8Array(W * H);
  const idx = (x: number, y: number): number => (y - y0) * W + (x - x0);
  const inBox = (x: number, y: number): boolean => x >= x0 && y >= y0 && x < x0 + W && y < y0 + H;
  const goal = idx(b.x, b.y);
  const hx = (x: number, y: number): number => Math.hypot(x - b.x, y - b.y);
  const heap = new Heap();
  const s0 = idx(a.x, a.y);
  cost[s0] = 0;
  heap.push(s0, hx(a.x, a.y));
  const done = new Uint8Array(W * H);
  while (heap.size) {
    const cur = heap.pop();
    if (done[cur]) continue;
    done[cur] = 1;
    if (cur === goal) break;
    const cx = (cur % W) + x0;
    const cy = ((cur / W) | 0) + y0;
    for (const [dx, dy] of DIRS) {
      const diag = dx !== 0 && dy !== 0;
      const nx = cx + dx;
      const ny = cy + dy;
      if (!inBox(nx, ny)) continue;
      const step = diag ? Math.SQRT2 : 1;
      const tt = ter(nx, ny);
      if (WATER(tt)) {
        // a bridge: straight on over the water to own dry land within BRIDGE_MAX tiles
        let k = 1;
        while (k <= BRIDGE_MAX && WATER(ter(cx + dx * k, cy + dy * k))) k++;
        if (k > BRIDGE_MAX) continue;
        const ex = cx + dx * k;
        const ey = cy + dy * k;
        if (!inBox(ex, ey)) continue;
        const lc = hubOk(ex, ey) ? 1 : lay(ex, ey);
        if (lc === null) continue;
        const j = idx(ex, ey);
        const nc = cost[cur] + step * k * 3 + 4 + lc;
        if (nc < cost[j]) {
          cost[j] = nc;
          from[j] = cur;
          bridged[j] = 1;
          heap.push(j, nc + hx(ex, ey));
        }
        continue;
      }
      const lc = hubOk(nx, ny) ? 1 : lay(nx, ny);
      if (lc === null) continue;
      // no corner cutting past a blocked or wet tile
      if (diag && (lay(cx + dx, cy) === null || lay(cx, cy + dy) === null) && !hubOk(nx, ny)) continue;
      const j = idx(nx, ny);
      const nc = cost[cur] + step * lc;
      if (nc < cost[j]) {
        cost[j] = nc;
        from[j] = cur;
        bridged[j] = 0;
        heap.push(j, nc + hx(nx, ny));
      }
    }
  }
  if (!done[goal]) return null;
  // the tile route, then split at the bridges: land legs are pulled straight and rounded, bridges stay straight
  const tiles: number[] = [];
  for (let c = goal; c !== -1; c = from[c]) tiles.push(c);
  tiles.reverse();
  const centre = (c: number): P => [(c % W) + x0 + 0.5, ((c / W) | 0) + y0 + 0.5];
  const landOk = (x: number, y: number): boolean => hubOk(x, y) || lay(x, y) !== null;
  const legs: P[][] = [[centre(tiles[0])]];
  const bridgeAfter: boolean[] = [];
  for (let i = 1; i < tiles.length; i++) {
    if (bridged[tiles[i]]) {
      bridgeAfter.push(true);
      legs.push([centre(tiles[i])]);
    } else legs[legs.length - 1].push(centre(tiles[i]));
  }
  const smoothLeg = (leg: P[], ends: [P | null, P | null]): P[] => smoothRun(leg, ends, landOk, (x, y) => landOk(x, y) || WATER(ter(x, y)));
  const path: P[] = [];
  const bridges: [number, number][] = [];
  for (let L = 0; L < legs.length; L++) {
    const leg = legs[L];
    const pts = smoothLeg(leg, [null, null]);
    if (path.length) {
      // the bridge from the last point to this leg's first
      const s0b = pathLength(path);
      const last = path[path.length - 1];
      const first = pts[0];
      bridges.push([s0b + 0.35, s0b + Math.hypot(first[0] - last[0], first[1] - last[1]) - 0.35]);
    }
    path.push(...pts);
  }
  // drop repeated points
  const clean: P[] = [path[0]];
  for (const q of path) {
    const l = clean[clean.length - 1];
    if (Math.hypot(q[0] - l[0], q[1] - l[1]) > 1e-6) clean.push(q);
  }
  return { path: clean, bridges };
}

/**
 * The rail network of a set of hubs: every hub runs a rail to its RAIL_LINKS nearest hubs of the same owner within
 * RAIL_MAX_DIST tiles that a route reaches (the next nearest when one cannot be reached, up to 4 tries). Each pair is
 * laid once. The result is the same for any input order.
 */
export function railNetwork(hubs: readonly Hub[], t: SupplyTerrain): Rail[] {
  const hs = hubs.slice().sort((p, q) => p.id - q.id);
  const seen = new Map<string, Rail | null>();
  const out: Rail[] = [];
  const route = (p: Hub, q: Hub): Rail | null => {
    const [lo, hi] = p.id < q.id ? [p, q] : [q, p];
    const key = `${lo.id}:${hi.id}`;
    if (seen.has(key)) return seen.get(key) ?? null;
    const r = railRoute(lo, hi, t, hs);
    const rail = r ? { a: lo.id, b: hi.id, path: r.path, bridges: r.bridges } : null;
    seen.set(key, rail);
    if (rail) out.push(rail);
    return rail;
  };
  for (const h of hs) {
    if (h.owner === 0) continue;
    const near = hs
      .filter((o) => o.id !== h.id && o.owner === h.owner)
      .map((o) => ({ o, d: Math.hypot(o.x - h.x, o.y - h.y) }))
      .filter((e) => e.d <= RAIL_MAX_DIST)
      .sort((p, q) => p.d - q.d || p.o.id - q.o.id);
    let made = 0;
    for (let i = 0; i < near.length && i < RAIL_LINKS + 2 && made < RAIL_LINKS; i++) if (route(h, near[i].o)) made++;
  }
  return out.sort((p, q) => p.a - q.a || p.b - q.b);
}

/** The rail yards: hubs where JUNCTION_DEGREE or more rails meet, the yard laid along the straightest line through the hub. */
export function junctions(hubs: readonly Hub[], rails: readonly Rail[]): Junction[] {
  const out: Junction[] = [];
  for (const h of hubs.slice().sort((p, q) => p.id - q.id)) {
    const mine = rails.filter((r) => r.a === h.id || r.b === h.id);
    if (mine.length < JUNCTION_DEGREE) continue;
    // the main axis: the most nearly straight pair of rails through the hub (a through line), else the first rail
    const dirs = mine.map((r) => {
      const pts = r.a === h.id ? r.path : r.path.slice().reverse();
      const q = pointAt(pts, 3);
      return Math.atan2(q.y - pts[0][1], q.x - pts[0][0]);
    });
    let axis = dirs[0];
    let straight = 0.5;
    for (let i = 0; i < dirs.length; i++) {
      for (let k = i + 1; k < dirs.length; k++) {
        const opp = -Math.cos(dirs[i] - dirs[k]);
        if (opp > straight) {
          straight = opp;
          axis = Math.atan2(Math.sin(dirs[i]) - Math.sin(dirs[k]), Math.cos(dirs[i]) - Math.cos(dirs[k]));
        }
      }
    }
    const angle = axis;
    out.push({ hub: h.id, x: h.x + 0.5, y: h.y + 0.5, angle, degree: mine.length });
  }
  return out;
}

/**
 * A convoy's sea lane from port `a` to the port or beachhead tile `b` on another shore: open water only (from the
 * nearest water tile of each end), keeping a tile off the land where it can, pulled straight and rounded. It starts
 * and ends at the two end tiles' centres. Null when no water route links them within the search box.
 */
export function seaLane(a: { x: number; y: number }, b: { x: number; y: number }, t: SupplyTerrain, margin = 20): P[] | null {
  const x0 = Math.min(a.x, b.x) - margin;
  const y0 = Math.min(a.y, b.y) - margin;
  const W = Math.max(a.x, b.x) + margin - x0 + 1;
  const H = Math.max(a.y, b.y) + margin - y0 + 1;
  const wet = (x: number, y: number): boolean => WATER(t.terrain(x, y));
  const idx = (x: number, y: number): number => (y - y0) * W + (x - x0);
  const inBox = (x: number, y: number): boolean => x >= x0 && y >= y0 && x < x0 + W && y < y0 + H;
  const shoreCost = (x: number, y: number): number => {
    for (const [dx, dy] of DIRS) if (!wet(x + dx, y + dy)) return 2.5;
    for (const [dx, dy] of DIRS) if (!wet(x + dx * 2, y + dy * 2)) return 1.4;
    return 1;
  };
  // each end leaves from the nearest water tile within 3 tiles of its shore tile
  const wetNear = (p: { x: number; y: number }): { x: number; y: number } | null => {
    if (wet(p.x, p.y)) return p;
    let best: { x: number; y: number } | null = null;
    let bd = Infinity;
    for (let dy = -3; dy <= 3; dy++) {
      for (let dx = -3; dx <= 3; dx++) {
        const d = dx * dx + dy * dy;
        if (d < bd && wet(p.x + dx, p.y + dy)) {
          bd = d;
          best = { x: p.x + dx, y: p.y + dy };
        }
      }
    }
    return best;
  };
  const sa = wetNear(a);
  const sb = wetNear(b);
  if (!sa || !sb) return null;
  const cost = new Float64Array(W * H).fill(Infinity);
  const from = new Int32Array(W * H).fill(-1);
  const done = new Uint8Array(W * H);
  const heap = new Heap();
  const start = idx(sa.x, sa.y);
  const goal = idx(sb.x, sb.y);
  cost[start] = 0;
  heap.push(start, 0);
  while (heap.size) {
    const cur = heap.pop();
    if (done[cur]) continue;
    done[cur] = 1;
    if (cur === goal) break;
    const cx = (cur % W) + x0;
    const cy = ((cur / W) | 0) + y0;
    for (const [dx, dy] of DIRS) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (!inBox(nx, ny)) continue;
      const j = idx(nx, ny);
      const end = j === goal;
      if (!end && !wet(nx, ny)) continue;
      if (dx && dy && !end && (!wet(cx + dx, cy) || !wet(cx, cy + dy))) continue;
      const nc = cost[cur] + (dx && dy ? Math.SQRT2 : 1) * (end ? 1 : shoreCost(nx, ny));
      if (nc < cost[j]) {
        cost[j] = nc;
        from[j] = cur;
        heap.push(j, nc + Math.hypot(nx - sb.x, ny - sb.y));
      }
    }
  }
  if (!done[goal]) return null;
  const tiles: P[] = [];
  for (let c = goal; c !== -1; c = from[c]) tiles.push([(c % W) + x0 + 0.5, ((c / W) | 0) + y0 + 0.5]);
  tiles.reverse();
  const mid = chaikin(densify(pull(tiles, wet), 2), 3);
  const ends: P[] = [];
  if (sa.x !== a.x || sa.y !== a.y) ends.push([a.x + 0.5, a.y + 0.5]);
  const out = [...ends, ...mid];
  if (sb.x !== b.x || sb.y !== b.y) out.push([b.x + 0.5, b.y + 0.5]);
  return out;
}
