// Attack fronts, drawn on the overlay canvas (client only: reads the state, never changes it).
//
// Front lines: where two nations are at war (an attack running either way, or one in the last WAR_MEMORY_TICKS),
//   their shared border gets a crisp line over the territory edge: brass on your own fronts, pale bone on others',
//   with a dark casing and a slow pulse. Quiet borders stay as the shader draws them. The border edges of each
//   warring pair are kept incrementally from the tile feed (seeded from the sim's border lists when a war starts,
//   re-seeded every RESEED_MS), merged into straight runs and cached as one Path2D per pair.
// Push arrows: 1-3 chevrons per attack along its front, pointing into the land being taken, in the attacker's
//   colour, sized by the measured speed and the troops left; they fade out when the attack ends. Your fights first,
//   nearby arrows merged, at most MAX_ARROWS on screen, others' fights only when zoomed in a little.
// Troop pills: a count at each active front (your attacks with an up arrow, attacks on you with a down arrow, your
//   allies' attacks on your enemies at any zoom, other nations' fights when zoomed in), on the most recent capture
//   nearest to the attack's focus, learnt from the tile feed.
// Hover a front: a small card "Your attack on X: +N tiles/s, troops left Y" next to the pointer.
import { estimateAttack } from '../../sim/combat';
import { areAllied } from '../../sim/diplomacy';
import { armyTotal } from '../../sim/economy';
import { borderTiles } from '../../sim/territory';
import { isTribe } from '../../sim/types';
import type { Attack, GameState } from '../../sim/types';
import type { Camera } from '../camera';
import type { UiState } from '../uiState';
import { clamp, css, formatCount, MAP_NUM_FAMILY, mix, pill, type RGB } from './common';
import { OWNER_MASK, type TileFeed } from './tiles';

/** An anchor older than this is replaced by any newer capture. */
const STALE_MS = 1500;
/** A border stays a front line this long after the last attack across it ended (ticks of 100 ms: 30 s). */
export const WAR_MEMORY_TICKS = 300;
/** ...and fades out over the last this many ticks. */
const FADE_TICKS = 60;
/**
 * A pair's front path is rebuilt at most every this many frames (it changes on most frames during a fight): close
 * up every 2nd frame, zoomed out (a tile under 1.5 px) every 8th.
 */
function rebuildFrames(zoom: number): number {
  return zoom >= 3 ? 2 : zoom >= 1.5 ? 4 : 8;
}
/** ...and at most about this many edges of paths are rebuilt per frame (the rest wait a frame or two). */
const REBUILD_EDGES = 3000;
/** Push arrow spots are recomputed at most every this many frames (or when the zoom changes a step). */
const SPOT_FRAMES = 8;
/** Each warring pair's edge set is rebuilt from the border lists this often (heals any drift from feed lag). */
const RESEED_MS = 2500;
const MAX_ARROWS = 28;
/** Arrows from different attacks closer than this (CSS px) merge into the stronger one. */
const MERGE_PX = 34;
/** Ended attacks' arrows fade over this long. */
const ARROW_FADE_MS = 700;
/** Other nations' arrows show from this zoom (px per tile); yours, attacks on you and your allies' at any zoom. */
const OTHERS_ARROW_ZOOM = 1.6;
const SPEED_WINDOW_TICKS = 30;
/** Pair keys: lower id * PAIR_K + higher id (ids fit in 12 bits, OWNER_MASK). */
const PAIR_K = 4096;

const BRASS: RGB = [227, 192, 78];
const BONE: RGB = [228, 223, 210];
const SIGNAL = '#ff6b5e';

interface Anchor {
  tile: number;
  ms: number;
  d: number;
}

/** A place along a front for a push arrow: tile coords on the border, unit direction from `lo` into `hi`, weight. */
export interface FrontSpot {
  x: number;
  y: number;
  dx: number;
  dy: number;
  n: number;
}

interface Pair {
  lo: number;
  hi: number;
  edges: Set<number>;
  lastTick: number;
  active: boolean;
  bornMs: number;
  seedMs: number;
  seedTick: number;
  dirty: boolean;
  builtFrame: number;
  path: Path2D | null;
  /** zoomed far out: a lighter copy of the path (stair steps under a pixel dropped), rebuilt with the path */
  farPath: Path2D | null;
  farStep: number;
  /** the lines cut into short pieces with their boxes: zoomed in, only the pieces in view are stroked */
  chunks: { box: [number, number, number, number]; pts: number[] }[];
  segs: number[];
  /** the runs joined into polylines [x0, y0, x1, y1, ...] (clean corners, fewer caps) */
  lines: number[][];
  box: [number, number, number, number];
  spots: FrontSpot[];
  spotFrame: number;
  spotZoom: number;
  spotsDirty: boolean;
}

interface Arrow {
  x: number;
  y: number;
  dx: number;
  dy: number;
  size: number;
  double: boolean;
  color: RGB;
  edge: string;
  alpha: number;
  prio: number;
  phase: number;
}

interface ArrowMemo {
  arrows: Arrow[];
  endMs: number;
}

// ------------------------------------------------------------------------------------------------ pure helpers

/** Edge between tile i and its right neighbour (dir 0) or the one below (dir 1). */
export function edgeId(i: number, dir: 0 | 1): number {
  return i * 2 + dir;
}
export function pairKey(a: number, b: number): number {
  return a < b ? a * PAIR_K + b : b * PAIR_K + a;
}

/**
 * Adds every edge between a tile of `a` in `list[0..len)` and a 4-neighbour owned by `b` (owners read through
 * `ownerAt`) to `out`. The list is the sim's border list of `a` (tiles with a foreign neighbour).
 */
export function seedEdges(ownerAt: (i: number) => number, list: ArrayLike<number>, len: number, a: number, b: number, w: number, n: number, out: Set<number>): void {
  for (let k = 0; k < len; k++) {
    const i = list[k];
    if (ownerAt(i) !== a) continue;
    const x = i % w;
    if (x > 0 && ownerAt(i - 1) === b) out.add(edgeId(i - 1, 0));
    if (x < w - 1 && ownerAt(i + 1) === b) out.add(edgeId(i, 0));
    if (i >= w && ownerAt(i - w) === b) out.add(edgeId(i - w, 1));
    if (i + w < n && ownerAt(i + w) === b) out.add(edgeId(i, 1));
  }
}

/**
 * Border edges as straight line runs in tile coordinates: [x0, y0, x1, y1, ...]. An edge between i and its right
 * neighbour is the vertical unit line at x + 1; one between i and the tile below is the horizontal line at y + 1.
 * Touching collinear edges merge into one run. Map sides must stay under 4096 tiles.
 */
export function mergeSegments(edges: Iterable<number>, w: number): number[] {
  const vert: number[] = [];
  const horz: number[] = [];
  for (const id of edges) {
    const i = id >>> 1;
    const x = i % w;
    const y = (i - x) / w;
    if ((id & 1) === 0) vert.push((x + 1) * PAIR_K + y);
    else horz.push((y + 1) * PAIR_K + x);
  }
  const out: number[] = [];
  const runs = (keys: number[], vertical: boolean): void => {
    if (keys.length === 0) return;
    const a = Int32Array.from(keys).sort();
    let start = a[0];
    let prev = a[0];
    const emit = (): void => {
      const line = (start / PAIR_K) | 0;
      const from = start % PAIR_K;
      const to = (prev % PAIR_K) + 1;
      if (vertical) out.push(line, from, line, to);
      else out.push(from, line, to, line);
    };
    for (let k = 1; k < a.length; k++) {
      const v = a[k];
      if (v === prev) continue;
      if (v === prev + 1 && ((v / PAIR_K) | 0) === ((prev / PAIR_K) | 0)) {
        prev = v;
        continue;
      }
      emit();
      start = prev = v;
    }
    emit();
  };
  runs(vert, true);
  runs(horz, false);
  return out;
}

/**
 * Push arrow spots along a front: the edges are grouped into `cell` x `cell` tile cells; each cell gives the edge
 * midpoint nearest its centre and the summed push direction from `lo` into the other side, normalised, with the
 * cell's edge count as weight. Cells whose edges point every way (a ragged pocket) are dropped. Heaviest first.
 */
export function frontSpots(edges: Iterable<number>, ownerAt: (i: number) => number, lo: number, w: number, cell: number): FrontSpot[] {
  const cells = new Map<number, { n: number; sx: number; sy: number; dx: number; dy: number; bx: number; by: number; bd: number }>();
  const list: number[] = [];
  for (const id of edges) {
    list.push(id);
    const i = id >>> 1;
    const x = i % w;
    const y = (i - x) / w;
    const vert = (id & 1) === 0;
    const mx = vert ? x + 1 : x + 0.5;
    const my = vert ? y + 0.5 : y + 1;
    const s = ownerAt(i) === lo ? 1 : -1;
    const key = ((my / cell) | 0) * 65536 + ((mx / cell) | 0);
    let c = cells.get(key);
    if (!c) cells.set(key, (c = { n: 0, sx: 0, sy: 0, dx: 0, dy: 0, bx: mx, by: my, bd: Infinity }));
    c.n++;
    c.sx += mx;
    c.sy += my;
    if (vert) c.dx += s;
    else c.dy += s;
  }
  // nearest edge midpoint to each cell's centroid, so the arrow sits on the line
  for (const id of list) {
    const i = id >>> 1;
    const x = i % w;
    const y = (i - x) / w;
    const vert = (id & 1) === 0;
    const mx = vert ? x + 1 : x + 0.5;
    const my = vert ? y + 0.5 : y + 1;
    const c = cells.get(((my / cell) | 0) * 65536 + ((mx / cell) | 0))!;
    const d = (mx - c.sx / c.n) ** 2 + (my - c.sy / c.n) ** 2;
    if (d < c.bd) {
      c.bd = d;
      c.bx = mx;
      c.by = my;
    }
  }
  const out: FrontSpot[] = [];
  for (const c of cells.values()) {
    const len = Math.hypot(c.dx, c.dy);
    if (len < c.n * 0.2) continue;
    out.push({ x: c.bx, y: c.by, dx: c.dx / len, dy: c.dy / len, n: c.n });
  }
  out.sort((a, b) => b.n - a.n);
  return out;
}

/**
 * Joins line runs [x0, y0, x1, y1, ...] that meet end to end into polylines, so corners join instead of overlapping
 * caps. Starts at loose ends first, then walks the closed loops that remain.
 */
export function chainSegments(segs: readonly number[]): number[][] {
  const m = segs.length / 4;
  const at = new Map<number, number[]>();
  const key = (x: number, y: number): number => x * 8192 + y;
  for (let s = 0; s < m; s++) {
    for (const e of [0, 2]) {
      const k = key(segs[s * 4 + e], segs[s * 4 + e + 1]);
      const l = at.get(k);
      if (l) l.push(s);
      else at.set(k, [s]);
    }
  }
  const used = new Uint8Array(m);
  const out: number[][] = [];
  const walk = (s0: number, fromEnd: number): void => {
    // fromEnd: which end of s0 the chain starts at (0 = first point, 2 = second)
    const line = [segs[s0 * 4 + fromEnd], segs[s0 * 4 + fromEnd + 1]];
    let s = s0;
    let e = fromEnd;
    for (;;) {
      used[s] = 1;
      const o = 2 - e;
      const x = segs[s * 4 + o];
      const y = segs[s * 4 + o + 1];
      line.push(x, y);
      const next = at.get(key(x, y))?.find((t) => !used[t]);
      if (next === undefined) break;
      s = next;
      e = segs[s * 4] === x && segs[s * 4 + 1] === y ? 0 : 2;
    }
    out.push(line);
  };
  for (let s = 0; s < m; s++) {
    if (used[s]) continue;
    for (const e of [0, 2]) {
      if (used[s]) break;
      if ((at.get(key(segs[s * 4 + e], segs[s * 4 + e + 1]))?.length ?? 0) !== 2) walk(s, e);
    }
  }
  for (let s = 0; s < m; s++) if (!used[s]) walk(s, 0);
  return out;
}

/**
 * Zoomed far out a tile is about a pixel, and a diagonal border's one-tile stair steps cost a lot to stroke without
 * showing: the line then drops points closer than this many tiles (about a pixel on screen). 0 = keep every point.
 */
export function farStep(zoom: number): number {
  return zoom >= 1.2 ? 0 : Math.max(1, 2 ** Math.floor(Math.log2(1.2 / zoom)));
}

/** Points per piece when a front's lines are cut up for culling (pieces share their end points, so lines stay joined). */
const CHUNK_POINTS = 48;

/** Cuts polylines into pieces of at most `n` points, each with its box; neighbouring pieces share an end point. */
export function chunkLines(lines: readonly number[][], n: number): { box: [number, number, number, number]; pts: number[] }[] {
  const out: { box: [number, number, number, number]; pts: number[] }[] = [];
  for (const l of lines) {
    const m = l.length / 2;
    for (let a = 0; a < m - 1; a += n - 1) {
      const e = Math.min(m, a + n);
      const pts = l.slice(a * 2, e * 2);
      let x0 = Infinity;
      let y0 = Infinity;
      let x1 = -Infinity;
      let y1 = -Infinity;
      for (let k = 0; k < pts.length; k += 2) {
        if (pts[k] < x0) x0 = pts[k];
        if (pts[k] > x1) x1 = pts[k];
        if (pts[k + 1] < y0) y0 = pts[k + 1];
        if (pts[k + 1] > y1) y1 = pts[k + 1];
      }
      out.push({ box: [x0, y0, x1, y1], pts });
    }
  }
  return out;
}

/** Drops the points of a polyline within `step` tiles of the last kept one (the ends always stay). */
export function simplifyLine(l: readonly number[], step: number): number[] {
  if (l.length <= 4) return l.slice();
  const out = [l[0], l[1]];
  const t2 = step * step;
  for (let k = 2; k < l.length - 2; k += 2) {
    const dx = l[k] - out[out.length - 2];
    const dy = l[k + 1] - out[out.length - 1];
    if (dx * dx + dy * dy > t2) out.push(l[k], l[k + 1]);
  }
  out.push(l[l.length - 2], l[l.length - 1]);
  return out;
}

function near(b: readonly number[], x0: number, y0: number, x1: number, y1: number, margin: number): boolean {
  return !(b[2] < x0 - margin || b[3] < y0 - margin || b[0] > x1 + margin || b[1] > y1 + margin);
}

/** Measured tiles per second of game time from (tick, tilesTaken) samples, oldest first. */
export function measuredSpeed(samples: readonly number[]): number {
  const m = samples.length;
  if (m < 4) return 0;
  const dt = (samples[m - 2] - samples[0]) / 10;
  return dt > 0 ? Math.max(0, (samples[m - 1] - samples[1]) / dt) : 0;
}

function prefersReducedMotion(): boolean {
  try {
    return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

// ------------------------------------------------------------------------------------------------ layer

export class FrontLayer {
  private anchors = new Map<number, Anchor>();
  private byPair = new Map<number, Attack[]>();
  private tick = -1;
  private w = 1;
  private h = 1;
  private now = 0;
  private frame = 0;
  private feed: TileFeed | null = null;
  private gen = -1;
  /** this tick: attacks by your allies on nations you are fighting */
  private allied = new Set<number>();
  /** warring pairs by pairKey */
  private pairs = new Map<number, Pair>();
  /** per attack id: [tick, tilesTaken, tick, tilesTaken, ...] over the last SPEED_WINDOW_TICKS */
  private speedLog = new Map<number, number[]>();
  private memo = new Map<number, ArrowMemo>();
  private reduced = prefersReducedMotion();
  private hoverKey = -1;
  private spotBudget = 0;
  /** front segments drawn last frame (stats / tests) */
  segments = 0;
  arrowsDrawn = 0;

  reset(w: number, feed?: TileFeed): void {
    this.anchors.clear();
    this.byPair.clear();
    this.pairs.clear();
    this.speedLog.clear();
    this.memo.clear();
    this.tick = -1;
    this.w = w;
    this.feed = feed ?? null;
    this.h = feed && feed.w === w ? feed.h : 1;
    this.gen = feed ? feed.fullGen : -1;
  }

  /** The border edges kept for a warring pair (tests), or undefined when that border isn't a front. */
  edgesOf(a: number, b: number): ReadonlySet<number> | undefined {
    return this.pairs.get(pairKey(a, b))?.edges;
  }

  private ownerAt = (i: number): number => (this.feed ? this.feed.mirror[i] & OWNER_MASK : 0);

  /** Call before the tile feed applies this frame's changes. */
  begin(state: GameState, nowMs: number): void {
    this.now = nowMs;
    this.frame++;
    const feed = this.feed;
    if (feed && feed.fullGen !== this.gen) {
      this.gen = feed.fullGen;
      for (const p of this.pairs.values()) this.seed(state, p);
    }
    // spread re-seeding: at most one pair per frame, and only once the game moved on (nothing drifts while paused)
    for (const p of this.pairs.values()) {
      if (nowMs - p.seedMs >= RESEED_MS && p.seedTick !== state.tick) {
        this.seed(state, p);
        break;
      }
    }
    if (state.tick === this.tick) return;
    if (state.tick < this.tick) this.pairs.clear();
    this.tick = state.tick;
    this.byPair.clear();
    const live = new Set<number>();
    for (const p of this.pairs.values()) p.active = false;
    for (const a of state.attacks) {
      const key = a.attacker * 4096 + a.target;
      const list = this.byPair.get(key);
      if (list) list.push(a);
      else this.byPair.set(key, [a]);
      live.add(a.id);
      let log = this.speedLog.get(a.id);
      if (!log) this.speedLog.set(a.id, (log = []));
      log.push(state.tick, a.tilesTaken);
      while (log.length > 4 && log[0] < state.tick - SPEED_WINDOW_TICKS) log.splice(0, 2);
      if (feed && this.atWar(state, a)) {
        const k = pairKey(a.attacker, a.target);
        let p = this.pairs.get(k);
        if (!p) {
          p = this.newPair(Math.min(a.attacker, a.target), Math.max(a.attacker, a.target), nowMs);
          this.pairs.set(k, p);
          this.seed(state, p);
        }
        p.lastTick = state.tick;
        p.active = true;
      }
    }
    for (const id of this.anchors.keys()) if (!live.has(id)) this.anchors.delete(id);
    for (const id of this.speedLog.keys()) if (!live.has(id)) this.speedLog.delete(id);
    for (const [k, p] of this.pairs) {
      const gone = !state.players[p.lo]?.alive || !state.players[p.hi]?.alive;
      if (gone || state.tick - p.lastTick > WAR_MEMORY_TICKS) this.pairs.delete(k);
    }
    this.allied.clear();
    const me = state.humanId;
    if (me > 0) {
      const enemies = new Set<number>();
      for (const a of state.attacks) {
        if (a.attacker === me && a.target > 0) enemies.add(a.target);
        else if (a.target === me && a.attacker > 0) enemies.add(a.attacker);
      }
      if (enemies.size) for (const a of state.attacks) if (enemies.has(a.target) && a.attacker !== me && areAllied(state, me, a.attacker)) this.allied.add(a.id);
    }
  }

  /** Nation against nation (tribes and wilderness don't make front lines). */
  private atWar(state: GameState, a: Attack): boolean {
    if (a.attacker <= 0 || a.target <= 0 || a.attacker === a.target) return false;
    const p = state.players[a.attacker];
    const q = state.players[a.target];
    return !!p && !!q && !isTribe(p) && !isTribe(q);
  }

  private newPair(lo: number, hi: number, nowMs: number): Pair {
    return { lo, hi, edges: new Set(), lastTick: -1, active: false, bornMs: nowMs, seedMs: 0, seedTick: -1, dirty: true, builtFrame: -1, path: null, farPath: null, farStep: 0, chunks: [], segs: [], lines: [], box: [0, 0, 0, 0], spots: [], spotFrame: -1e9, spotZoom: NaN, spotsDirty: true };
  }

  /** Rebuilds a pair's edges from the smaller of the two sim border lists, checked against the drawn mirror. */
  private seed(state: GameState, p: Pair): void {
    p.seedMs = this.now;
    p.seedTick = state.tick;
    if (!this.feed) return;
    const A = borderTiles(state, p.lo);
    const B = borderTiles(state, p.hi);
    const n = this.feed.n;
    const out = new Set<number>();
    if (A.len <= B.len) seedEdges(this.ownerAt, A.list, A.len, p.lo, p.hi, this.w, n, out);
    else seedEdges(this.ownerAt, B.list, B.len, p.hi, p.lo, this.w, n, out);
    // unchanged (the usual case: the feed kept it exact): keep the cached path
    if (out.size === p.edges.size && [...out].every((e) => p.edges.has(e))) return;
    p.edges = out;
    p.dirty = true;
    p.spotsDirty = true;
  }

  /** Tile feed listener: a tile went from `oldOwner` to `newOwner` (the mirror still holds the old owner). */
  readonly onChange = (tile: number, oldOwner: number, newOwner: number): void => {
    const w = this.w;
    const x = tile % w;
    const y = (tile / w) | 0;
    const list = this.byPair.get(newOwner * 4096 + oldOwner);
    if (list) {
      for (const a of list) {
        const dx = x - (a.focusTile % w);
        const dy = y - ((a.focusTile / w) | 0);
        const d = dx * dx + dy * dy;
        const cur = this.anchors.get(a.id);
        if (!cur || this.now - cur.ms > STALE_MS || d <= cur.d) this.anchors.set(a.id, { tile, ms: this.now, d });
      }
    }
    if (this.pairs.size === 0 || !this.feed) return;
    const n = this.feed.n;
    if (x > 0) this.edge(edgeId(tile - 1, 0), tile - 1, oldOwner, newOwner);
    if (x < w - 1) this.edge(edgeId(tile, 0), tile + 1, oldOwner, newOwner);
    if (tile >= w) this.edge(edgeId(tile - w, 1), tile - w, oldOwner, newOwner);
    if (tile + w < n) this.edge(edgeId(tile, 1), tile + w, oldOwner, newOwner);
  };

  private edge(id: number, j: number, oldOwner: number, newOwner: number): void {
    const nj = this.ownerAt(j);
    if (nj === 0) return;
    if (oldOwner !== 0 && oldOwner !== nj) {
      const p = this.pairs.get(pairKey(oldOwner, nj));
      if (p && p.edges.delete(id)) p.dirty = p.spotsDirty = true;
    }
    if (newOwner !== 0 && newOwner !== nj) {
      const p = this.pairs.get(pairKey(newOwner, nj));
      if (p && !p.edges.has(id)) {
        p.edges.add(id);
        p.dirty = p.spotsDirty = true;
      }
    }
  }

  /** 0..1: full while an attack runs across the pair, then 0.6 for the memory window, fading at its end. */
  private pairAlpha(p: Pair): number {
    const born = clamp((this.now - p.bornMs) / 400, 0, 1);
    if (p.active) return born;
    const age = this.tick - p.lastTick;
    const left = WAR_MEMORY_TICKS - age;
    return born * 0.6 * clamp(left / FADE_TICKS, 0, 1);
  }

  private build(p: Pair): void {
    p.dirty = false;
    p.builtFrame = this.frame;
    p.farPath = null;
    p.farStep = 0;
    const segs = mergeSegments(p.edges, this.w);
    p.segs = segs;
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (let k = 0; k < segs.length; k += 2) {
      const x = segs[k];
      const y = segs[k + 1];
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
    p.box = [x0, y0, x1, y1];
    p.lines = chainSegments(segs);
    p.chunks = chunkLines(p.lines, CHUNK_POINTS);
    if (typeof Path2D === 'undefined') {
      p.path = null;
      return;
    }
    const path = new Path2D();
    for (const l of p.lines) {
      path.moveTo(l[0], l[1]);
      for (let k = 2; k < l.length; k += 2) path.lineTo(l[k], l[k + 1]);
    }
    p.path = path;
  }

  /** Front lines (draw under labels and buildings, right over the territory). */
  drawLines(ctx: CanvasRenderingContext2D, state: GameState, cam: Camera, ui: UiState, dpr: number): void {
    this.segments = 0;
    this.hoverKey = this.hoverPair(state, cam, ui);
    if (this.pairs.size === 0) return;
    const me = state.humanId;
    const z = cam.zoom;
    const vx0 = cam.x - cam.viewW / 2 / z - 1;
    const vy0 = cam.y - cam.viewH / 2 / z - 1;
    const vx1 = cam.x + cam.viewW / 2 / z + 1;
    const vy1 = cam.y + cam.viewH / 2 / z + 1;
    const pulse = this.reduced ? 0.5 : 0.5 + 0.5 * Math.sin((this.now / 1000) * Math.PI * 1.2);
    const draw: { p: Pair; a: number; mine: boolean; hot: boolean; path: Path2D | null }[] = [];
    let budget = REBUILD_EDGES;
    const every = rebuildFrames(z);
    for (const [k, p] of this.pairs) {
      // rebuild changed paths every few frames, near the view only, a bounded number of edges per frame
      if (p.dirty && (p.builtFrame < 0 || (this.frame - p.builtFrame >= every && budget > 0 && (p.segs.length === 0 || near(p.box, vx0, vy0, vx1, vy1, 40))))) {
        budget -= p.edges.size;
        this.build(p);
      }
      if (p.segs.length === 0) continue;
      if (!near(p.box, vx0, vy0, vx1, vy1, 0)) continue;
      const a = this.pairAlpha(p);
      if (a <= 0.01) continue;
      draw.push({ p, a, mine: me > 0 && (p.lo === me || p.hi === me), hot: k === this.hoverKey, path: this.pathFor(p, z, vx0, vy0, vx1, vy1) });
      this.segments += p.segs.length / 4;
    }
    if (draw.length === 0) return;
    // the line keeps a steady screen width; yours a touch thinner when zoomed far out (others' stay readable)
    const far = z < 1.2;
    ctx.save();
    ctx.setTransform(dpr * z, 0, 0, dpr * z, dpr * (cam.viewW / 2 - cam.x * z), dpr * (cam.viewH / 2 - cam.y * z));
    ctx.lineCap = 'square';
    ctx.lineJoin = 'miter';
    ctx.miterLimit = 2;
    // casings first, so a crossing pair's casing never covers another pair's line
    for (const d of draw) {
      ctx.globalAlpha = d.a * (d.mine ? 0.7 : 0.55);
      ctx.strokeStyle = 'rgb(8,10,14)';
      ctx.lineWidth = ((d.mine ? (far ? 4 : 5) : 3.8) + (d.hot ? 1.4 : 0)) / z;
      this.stroke(ctx, d, z);
    }
    for (const d of draw) {
      const base = d.mine ? 0.85 + 0.15 * pulse : 0.72 + 0.16 * pulse;
      ctx.globalAlpha = d.a * (d.hot ? 1 : base);
      ctx.strokeStyle = css(d.mine ? BRASS : d.hot ? mix(BONE, [255, 255, 255], 0.4) : BONE);
      ctx.lineWidth = ((d.mine ? (far ? 2 : 2.4) : 1.7) + (d.hot ? 0.8 : 0)) / z;
      this.stroke(ctx, d, z);
    }
    ctx.restore();
  }

  /**
   * The path to stroke this frame (null without Path2D): far out, the lighter copy; a pair reaching past the view, only
   * its pieces in view (the stroke cost grows with every point, on screen or not); otherwise the whole cached path.
   */
  private pathFor(p: Pair, z: number, vx0: number, vy0: number, vx1: number, vy1: number): Path2D | null {
    if (!p.path) return null;
    const step = farStep(z);
    if (step > 0) {
      if (p.farStep !== step || !p.farPath) {
        const path = new Path2D();
        for (const l0 of p.lines) {
          const l = simplifyLine(l0, step);
          path.moveTo(l[0], l[1]);
          for (let k = 2; k < l.length; k += 2) path.lineTo(l[k], l[k + 1]);
        }
        p.farPath = path;
        p.farStep = step;
      }
      return p.farPath;
    }
    const b = p.box;
    if (b[0] >= vx0 && b[1] >= vy0 && b[2] <= vx1 && b[3] <= vy1) return p.path;
    const path = new Path2D();
    for (const c of p.chunks) {
      if (!near(c.box, vx0, vy0, vx1, vy1, 4)) continue; // a casing reaches ~3 tiles past its line at z 1.2
      const l = c.pts;
      path.moveTo(l[0], l[1]);
      for (let k = 2; k < l.length; k += 2) path.lineTo(l[k], l[k + 1]);
    }
    return path;
  }

  private stroke(ctx: CanvasRenderingContext2D, d: { p: Pair; path: Path2D | null }, z: number): void {
    if (d.path) {
      ctx.stroke(d.path);
      return;
    }
    const p = d.p;
    ctx.beginPath();
    for (const l of p.lines) {
      ctx.moveTo(l[0], l[1]);
      for (let k = 2; k < l.length; k += 2) ctx.lineTo(l[k], l[k + 1]);
    }
    ctx.stroke();
  }

  /** Spots of a pair for the current zoom (cells of ~120 px), cached for a few frames. */
  private spotsOf(p: Pair, z: number): FrontSpot[] {
    const zb = Math.round(Math.log2(z) * 2);
    if (p.spotZoom === zb && (!p.spotsDirty || this.frame - p.spotFrame < SPOT_FRAMES)) return p.spots;
    // a moving front keeps last frame's spots when this frame's budget is spent (a new zoom always recomputes)
    if (p.spotZoom === zb && this.spotBudget <= 0) return p.spots;
    this.spotBudget -= p.edges.size;
    p.spotZoom = zb;
    p.spotFrame = this.frame;
    p.spotsDirty = false;
    const cell = clamp(Math.round(120 / Math.pow(2, zb / 2)), 6, 600);
    p.spots = frontSpots(p.edges, this.ownerAt, p.lo, this.w, cell);
    return p.spots;
  }

  draw(ctx: CanvasRenderingContext2D, state: GameState, cam: Camera, humanId: number, colors: readonly RGB[], ui?: UiState): void {
    const me = humanId;
    const z = cam.zoom;
    const w = this.w;
    const pills: { x: number; y: number }[] = [];
    for (const a of state.attacks) {
      const mine = me > 0 && a.attacker === me;
      const incoming = me > 0 && a.target === me;
      const ally = this.allied.has(a.id);
      if (!mine && !incoming && !ally && z < 6) continue;
      const anchor = this.anchors.get(a.id);
      const tile = anchor ? anchor.tile : a.focusTile;
      if (tile < 0) continue;
      const s = cam.tileToScreen((tile % w) + 0.5, ((tile / w) | 0) + 0.5);
      if (s.x < -40 || s.y < -40 || s.x > cam.viewW + 40 || s.y > cam.viewH + 40) continue;
      const py = s.y - Math.max(12, z * 0.9);
      pills.push({ x: s.x, y: py });
      const edge = mine ? '#ffe98a' : incoming ? SIGNAL : css(colors[a.attacker] ?? [200, 200, 200]);
      pill(ctx, s.x, py, formatCount(armyTotal(a.troops)), edge, mine || ally ? 'up' : incoming ? 'down' : 'none');
      if (mine && a.focusTile >= 0) {
        const f = cam.tileToScreen((a.focusTile % w) + 0.5, ((a.focusTile / w) | 0) + 0.5);
        ctx.beginPath();
        ctx.arc(f.x, f.y, Math.max(4, z * 0.6), 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(255,255,255,0.75)';
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
    }
    this.arrows(ctx, state, cam, me, colors, pills);
    if (ui) this.hoverCard(ctx, state, cam, ui, me, colors);
  }

  // ------------------------------------------------------------------ push arrows

  private arrows(ctx: CanvasRenderingContext2D, state: GameState, cam: Camera, me: number, colors: readonly RGB[], pills: { x: number; y: number }[]): void {
    this.arrowsDrawn = 0;
    this.spotBudget = REBUILD_EDGES;
    const z = cam.zoom;
    const cands: Arrow[] = [];
    const live = new Set<number>();
    const vx0 = cam.x - cam.viewW / 2 / z;
    const vy0 = cam.y - cam.viewH / 2 / z;
    const vx1 = cam.x + cam.viewW / 2 / z;
    const vy1 = cam.y + cam.viewH / 2 / z;
    for (const a of state.attacks) {
      const p = this.pairs.get(pairKey(a.attacker, a.target));
      if (!p || !p.active) continue;
      const mine = me > 0 && a.attacker === me;
      const incoming = me > 0 && a.target === me;
      const ally = this.allied.has(a.id);
      const strong = mine || incoming || ally;
      if (!strong && z < OTHERS_ARROW_ZOOM) continue;
      live.add(a.id);
      if (!near(p.box, vx0, vy0, vx1, vy1, 0)) {
        this.memo.delete(a.id);
        continue;
      }
      const spots = this.spotsOf(p, z);
      const sign = a.attacker === p.lo ? 1 : -1;
      const speed = measuredSpeed(this.speedLog.get(a.id) ?? []);
      const troops = armyTotal(a.troops);
      const size = (mine ? 10 : 8) + clamp(Math.log2(1 + speed) * 1.3, 0, 5) + clamp(Math.log10(Math.max(1, troops)) - 3, 0, 2.5);
      const color = (colors[a.attacker] ?? [200, 200, 200]) as RGB;
      const edge = mine ? 'rgba(255,255,255,0.95)' : incoming ? SIGNAL : 'rgba(8,10,14,0.85)';
      const per = strong ? 3 : 2;
      const spacing = strong ? 150 : 190;
      const picked: Arrow[] = [];
      for (const s of spots) {
        if (picked.length >= per) break;
        const q = cam.tileToScreen(s.x, s.y);
        if (q.x < 16 || q.y < 16 || q.x > cam.viewW - 16 || q.y > cam.viewH - 16) continue;
        if (picked.some((o) => Math.hypot(o.x - q.x, o.y - q.y) < spacing)) continue;
        if (pills.some((o) => Math.hypot(o.x - q.x, o.y - q.y) < 30)) continue;
        picked.push({ x: q.x, y: q.y, dx: s.dx * sign, dy: s.dy * sign, size, double: speed >= 6, color, edge, alpha: mine ? 1 : strong ? 0.95 : 0.78, prio: (mine ? 4 : incoming ? 3 : ally ? 2 : 1) * 1e6 + s.n, phase: (a.id * 0.37) % 1 });
      }
      cands.push(...picked);
      // remember in tile coords so the arrows can fade where they were when the attack ends
      this.memo.set(a.id, { arrows: picked.map((o) => ({ ...o, ...cam.screenToTile(o.x, o.y) })), endMs: 0 });
    }
    // ended attacks: fade their last arrows
    for (const [id, m] of this.memo) {
      if (live.has(id)) continue;
      if (m.endMs === 0) m.endMs = this.now;
      const t = (this.now - m.endMs) / ARROW_FADE_MS;
      if (t >= 1) {
        this.memo.delete(id);
        continue;
      }
      for (const o of m.arrows) {
        const q = cam.tileToScreen(o.x, o.y);
        cands.push({ ...o, x: q.x, y: q.y, alpha: o.alpha * (1 - t) * (1 - t), prio: o.prio - 5e6 });
      }
    }
    if (cands.length === 0) return;
    cands.sort((a, b) => b.prio - a.prio);
    const shown: Arrow[] = [];
    for (const c of cands) {
      if (shown.length >= MAX_ARROWS) break;
      if (shown.some((o) => Math.hypot(o.x - c.x, o.y - c.y) < MERGE_PX)) continue;
      shown.push(c);
    }
    const t = this.reduced ? 0.35 : this.now / 1100;
    ctx.save();
    ctx.lineJoin = 'round';
    for (let k = shown.length - 1; k >= 0; k--) this.chevron(ctx, shown[k], t);
    ctx.restore();
    this.arrowsDrawn = shown.length;
  }

  /** A filled chevron just ahead of the line, drifting forward a few px and back (a slow march). */
  private chevron(ctx: CanvasRenderingContext2D, a: Arrow, time: number): void {
    const ph = (time + a.phase) % 1;
    const s = a.size;
    const drift = this.reduced ? 0.25 * s : ph * s * 0.55;
    const breathe = this.reduced ? 1 : 0.72 + 0.28 * Math.min(1, ph * 4, (1 - ph) * 4);
    const ux = a.dx;
    const uy = a.dy;
    const one = (back: number, alpha: number): void => {
      const cx = a.x + ux * (s * 0.55 + drift - back);
      const cy = a.y + uy * (s * 0.55 + drift - back);
      const px = -uy;
      const py = ux;
      ctx.beginPath();
      ctx.moveTo(cx + ux * s * 0.55, cy + uy * s * 0.55);
      ctx.lineTo(cx - ux * s * 0.45 + px * s * 0.62, cy - uy * s * 0.45 + py * s * 0.62);
      ctx.lineTo(cx - ux * s * 0.08, cy - uy * s * 0.08);
      ctx.lineTo(cx - ux * s * 0.45 - px * s * 0.62, cy - uy * s * 0.45 - py * s * 0.62);
      ctx.closePath();
      ctx.globalAlpha = alpha;
      ctx.fillStyle = css(a.color);
      ctx.fill();
      ctx.lineWidth = 1.4;
      ctx.strokeStyle = a.edge;
      ctx.stroke();
    };
    if (a.double) one(s * 0.95, a.alpha * breathe * 0.55);
    one(0, a.alpha * breathe);
  }

  // ------------------------------------------------------------------ hover

  /** The warring pair whose border is within a few px of the pointer (an attack running across it), or -1. */
  private hoverPair(state: GameState, cam: Camera, ui: UiState): number {
    const t = ui.hoverTile;
    if (t < 0 || !this.feed || t >= this.feed.n || this.pairs.size === 0 || ui.mode.kind !== 'none' || ui.contextMenu) return -1;
    const w = this.w;
    const h = this.h;
    const r = clamp(Math.ceil(5 / cam.zoom), 1, 8);
    const cx = t % w;
    const cy = (t / w) | 0;
    const me = state.humanId;
    let best = -1;
    let bestD = Infinity;
    for (let y = Math.max(0, cy - r); y <= Math.min(h - 1, cy + r); y++) {
      for (let x = Math.max(0, cx - r); x <= Math.min(w - 1, cx + r); x++) {
        const i = y * w + x;
        const a = this.ownerAt(i);
        if (a === 0) continue;
        const check = (j: number): void => {
          const b = this.ownerAt(j);
          if (b === 0 || b === a) return;
          const k = pairKey(a, b);
          const p = this.pairs.get(k);
          if (!p || !p.active) return;
          const d = (x - cx) ** 2 + (y - cy) ** 2 - (me > 0 && (a === me || b === me) ? 0.5 : 0);
          if (d < bestD) {
            bestD = d;
            best = k;
          }
        };
        if (x < w - 1) check(i + 1);
        if (y < h - 1) check(i + w);
      }
    }
    return best;
  }

  /** Measured tiles/s; for an attack too new to measure, the sim's own estimate at its focus (read-only). */
  private speedOf(state: GameState, a: Attack, hoverTile: number): number {
    const log = this.speedLog.get(a.id) ?? [];
    if (log.length >= 2 && log[log.length - 2] - log[0] >= 10) return measuredSpeed(log);
    const owner = state.map.owner;
    const tile = a.focusTile >= 0 && owner[a.focusTile] === a.target ? a.focusTile : owner[hoverTile] === a.target ? hoverTile : -1;
    const est = tile >= 0 ? estimateAttack(state, a.attacker, tile, a.troops) : null;
    return est ? est.tilesPerSecond : measuredSpeed(log);
  }

  private hoverCard(ctx: CanvasRenderingContext2D, state: GameState, cam: Camera, ui: UiState, me: number, colors: readonly RGB[]): void {
    const k = this.hoverKey;
    const at = ui.hoverPx;
    if (k < 0 || !at) return;
    const p = this.pairs.get(k);
    if (!p) return;
    const rows: { text: string; color: RGB }[] = [];
    const name = (id: number): string => state.players[id]?.name ?? 'Unknown';
    const list = state.attacks.filter((a) => (a.attacker === p.lo && a.target === p.hi) || (a.attacker === p.hi && a.target === p.lo));
    list.sort((a, b) => (b.attacker === me ? 1 : 0) - (a.attacker === me ? 1 : 0));
    for (const a of list.slice(0, 3)) {
      const sp = this.speedOf(state, a, ui.hoverTile);
      const rate = `+${sp >= 10 ? Math.round(sp) : sp.toFixed(1)} tiles/s`;
      const who = a.attacker === me ? `Your attack on ${name(a.target)}` : a.target === me ? `${name(a.attacker)} attacks you` : `${name(a.attacker)} attacks ${name(a.target)}`;
      rows.push({ text: `${who}: ${rate}, troops left ${formatCount(armyTotal(a.troops))}`, color: (colors[a.attacker] ?? [200, 200, 200]) as RGB });
    }
    if (rows.length === 0) return;
    const mine = me > 0 && (p.lo === me || p.hi === me);
    ctx.save();
    ctx.font = `500 12px ${MAP_NUM_FAMILY}`;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    const lh = 18;
    const tw = Math.max(...rows.map((r) => ctx.measureText(r.text).width));
    const bw = Math.ceil(tw + 16 + 14);
    const bh = rows.length * lh + 10;
    // above-left of the pointer: the tile card sits below-right and the odds badge above-right
    let x0 = at.x - 14 - bw;
    let y0 = at.y - 14 - bh;
    if (x0 < 8) x0 = Math.min(cam.viewW - bw - 8, at.x + 18);
    if (y0 < 8) y0 = 8;
    ctx.globalAlpha = 1;
    ctx.fillStyle = 'rgba(25,30,35,0.95)';
    ctx.fillRect(x0, y0, bw, bh);
    ctx.strokeStyle = '#39424b';
    ctx.lineWidth = 1;
    ctx.strokeRect(x0 + 0.5, y0 + 0.5, bw - 1, bh - 1);
    ctx.fillStyle = css(mine ? BRASS : BONE);
    ctx.fillRect(x0, y0, 3, bh);
    rows.forEach((r, n) => {
      const y = y0 + 5 + lh * n + lh / 2;
      ctx.fillStyle = css(r.color);
      ctx.fillRect(x0 + 11, y - 4, 8, 8);
      ctx.strokeStyle = 'rgba(0,0,0,0.6)';
      ctx.strokeRect(x0 + 11.5, y - 3.5, 7, 7);
      ctx.fillStyle = '#e4dfd2';
      ctx.fillText(r.text, x0 + 25, y + 0.5);
    });
    ctx.restore();
  }
}
