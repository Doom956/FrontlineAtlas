// Supply lines (docs/DESIGN.md, Supply): the network that carries supply from the capital to the forts and beachheads
// at the front. Lockstep code: an integer route search, ties broken by tile index, no clock and no randomness.
//
// Hubs: the capital, the finished cities, factories, ports and forts a nation owns, and its live beachheads. Each hub
// lays a rail to its SUPPLY_LINES.railLinks nearest own hubs within railMaxDist that a route over its own land reaches
// (the next nearest when one cannot, up to two more tries; a pair is laid once). The route search prefers flat land,
// goes round mountains and swamps where it can and crosses up to bridgeMax water tiles on a straight bridge. A port
// runs a convoy lane to its nearest own port or beachhead on another landmass of the same sea; a beachhead that no port
// picked gets a lane from its nearest port. A hub where junctionDegree rails meet is a junction (a rail yard).
//
// Join: hubs the nearest-hub rails leave apart from the capital's network are joined to it: first a rail search to the
// nearest joined hub within railMaxDist, then a flood over own dry land at any distance (landJoin). So a hub on own land
// that touches the capital's land is always linked; only enemy land or the sea keeps a cluster apart.
//
// Connected: a walk from the capital (breadth first, hubs in tile order) over the rails and the lanes that are open,
// never on past a damaged hub (the damaged hub itself is still supplied). A fort the walk does not reach is cut:
// combat.supplyCache leaves it out of the supply sources until a route reaches it again. A beachhead is cut only when
// it has a convoy lane and every lane to it is closed (no lane: its supply window runs as before). A cluster on a
// landmass none of the capital's hubs is on, with no lane, has no network there and is never counted cut. Cities stay
// sources (they feed themselves), the capital always is one and can never be damaged. Another route round a damaged
// hub keeps everything behind it supplied.
//
// When: each nation's network is checked every checkTicks ticks (staggered by id). The rails are rebuilt when its hubs
// change (buildings.buildingStamp, its capital, its beachheads), when land under a rail was lost (the stored routes are
// checked tile by tile) and every retrySeconds while a rail could not be laid; routes still valid are kept. The walk
// runs again after a rebuild, when a hub is damaged or repaired and when a lane is cut or opens again.
//
// State: damage and guard timers, sunk convoys and the cut lists live in state.supplyNet (hashed). The rails and lanes
// are derived data kept in a WeakMap; they depend on when they were last rebuilt (game history, the same in every
// client because lockstep replays the same ticks, never on client reads), so hashSupplyLines hashes their ends too.
// The client reads (supplyNetworkOf, hubCutValue, supplyRiskOf) never rebuild anything.
import { buildingAt, buildingsOf, buildingStamp, isDisabled, samRadius } from './buildings';
import { beachheadTiles } from './combat';
import { SUPPLY_LINES, TICKS_PER_SECOND } from './config';
import { flakRadius, flakWorking, hasFlak } from './defense';
import { areAllied } from './diplomacy';
import { forEachInRadius } from './grid';
import { atWar, portBlockadedBy } from './naval2';
import { atPeace } from './rules';
import { addEvent } from './state';
import { hasTech } from './tech';
import { landComponents } from './territory';
import { isTribe } from './types';
import type { BuildingType, GameState, MapData, SupplyEventInfo, SupplyHubKind, SupplyNetState } from './types';

const L = SUPPLY_LINES;
/** Building types that are supply hubs. */
const HUB_TYPES: ReadonlySet<BuildingType> = new Set<BuildingType>(['city', 'factory', 'port', 'fort']);
const KIND_NAME: Record<SupplyHubKind, string> = { capital: 'Capital', city: 'City', factory: 'Factory', port: 'Port', fort: 'Fort', beachhead: 'Beachhead' };

function hostile(state: GameState, a: number, b: number): boolean {
  return a !== b && a > 0 && b > 0 && !areAllied(state, a, b) && !atPeace(state, a, b);
}
function isSourceKind(k: SupplyHubKind): boolean {
  return k === 'fort' || k === 'beachhead';
}
/**
 * True if source hub i is cut with these reach flags: a fort when not reached; a beachhead only when not reached and
 * every convoy lane to it is closed (a landing with no lane at all keeps its supply window, as before supply lines).
 */
function sourceCut(net: Net, i: number, reached: Uint8Array): boolean {
  const h = net.hubs[i];
  if (reached[i] || !isSourceKind(h.kind) || net.exempt[i]) return false;
  if (h.kind === 'fort') return true;
  let lanes = 0;
  for (const k of net.adj[i]) {
    const l = net.links[k];
    if (!l.sea) continue;
    if (!l.cut) return false;
    lanes++;
  }
  return lanes > 0;
}

// ---------------------------------------------------------------------------------------------------------------
// Derived network per nation (WeakMap; see the header)
// ---------------------------------------------------------------------------------------------------------------

interface Hub {
  tile: number;
  kind: SupplyHubKind;
  x: number;
  y: number;
}
interface Link {
  /** hub indices, a < b for rails; a = the port end for lanes */
  a: number;
  b: number;
  sea: boolean;
  /** rails: the route, tiles from hub a to hub b (bridges included) */
  path: Int32Array | null;
  /** lanes: closed now (a sunk convoy or a blockade) */
  cut: boolean;
}
interface Route {
  path: Int32Array | null;
  /** tick of the last search (failed routes are tried again after retrySeconds) */
  tried: number;
}
interface Net {
  built: boolean;
  stamp: number;
  capital: number;
  heads: string;
  hubs: Hub[];
  /** tile -> hub index */
  index: Map<number, number>;
  links: Link[];
  /** link indices per hub, ordered by the other end's index */
  adj: number[][];
  /** rails per hub (junctions) */
  degree: Int32Array;
  routes: Map<number, Route>;
  retryAt: number;
  /** after the last walk: reached from the capital / damaged */
  reached: Uint8Array;
  blocked: Uint8Array;
  /** source tiles the walk ever reached (a newly built fort that was never linked is not "cut off") */
  known: Set<number>;
  /** bumped by every walk (memo key) */
  walks: number;
  memo: Map<number, number[]>;
  memoWalks: number;
  /** sources the last walk of a check newly cut off (for the convoy event) */
  lastCut: number[];
  /** hub clusters no flood over own land could join: their hub tiles -> tick of that flood */
  floodFails: Map<string, number>;
  /** hubs apart from the capital's network on a landmass none of its hubs is on (no lane): never counted cut */
  exempt: Uint8Array;
}
interface Nets {
  byPlayer: Map<number, Net>;
}
const netData = new WeakMap<GameState, Nets>();
function netsOf(state: GameState): Nets {
  let n = netData.get(state);
  if (!n) netData.set(state, (n = { byPlayer: new Map() }));
  return n;
}
function readNet(state: GameState, pid: number): Net | undefined {
  return netData.get(state)?.byPlayer.get(pid);
}
function emptyNet(): Net {
  return {
    built: false,
    stamp: -1,
    capital: -2,
    heads: '',
    hubs: [],
    index: new Map(),
    links: [],
    adj: [],
    degree: new Int32Array(0),
    routes: new Map(),
    retryAt: 0,
    reached: new Uint8Array(0),
    blocked: new Uint8Array(0),
    known: new Set(),
    walks: 0,
    memo: new Map(),
    memoWalks: -1,
    lastCut: [],
    floodFails: new Map(),
    exempt: new Uint8Array(0),
  };
}

function supplyNetOf(state: GameState): SupplyNetState {
  return (state.supplyNet ??= { hubs: [], sunk: [], cut: [], version: 0 });
}

// ---------------------------------------------------------------------------------------------------------------
// Reads for combat.ts
// ---------------------------------------------------------------------------------------------------------------

/** Bumped whenever a nation's cut list changes (combat.supplyCache key). */
export function cutVersion(state: GameState): number {
  return state.supplyNet?.version ?? 0;
}
const cutSets = new WeakMap<GameState, Map<number, { v: number; set: Set<number> | null }>>();
/** The forts and beachheads of pid its network does not reach now (null = none). Pure read. */
export function cutSourceSet(state: GameState, pid: number): Set<number> | null {
  const sn = state.supplyNet;
  const list = sn?.cut[pid];
  if (!sn || !list || !list.length) return null;
  let m = cutSets.get(state);
  if (!m) cutSets.set(state, (m = new Map()));
  const e = m.get(pid);
  if (e && e.v === sn.version) return e.set;
  const set = new Set(list);
  m.set(pid, { v: sn.version, set });
  return set;
}

// ---------------------------------------------------------------------------------------------------------------
// Rail route search (integer A* in a box round the two hubs)
// ---------------------------------------------------------------------------------------------------------------

/** Cost of one straight step onto a land tile by terrain id (-1 = water); diagonal steps cost DIAG. */
const STEP = [-1, -1, 10, 14, 24, 45, 10, 45, 11];
const DIAG = [-1, -1, 14, 20, 34, 63, 14, 63, 15];
const DX = [1, 0, -1, 0, 1, -1, -1, 1];
const DY = [0, 1, 0, -1, 1, 1, -1, -1];

interface Scratch {
  size: number;
  g: Int32Array;
  from: Int32Array;
  mark: Int32Array;
  closed: Int32Array;
  gen: number;
  hk: number[];
  hv: number[];
}
const scratches = new WeakMap<GameState, Scratch>();
function scratchOf(state: GameState, size: number): Scratch {
  let s = scratches.get(state);
  if (!s || s.size < size || s.gen > 2e9) {
    s = { size, g: new Int32Array(size), from: new Int32Array(size), mark: new Int32Array(size), closed: new Int32Array(size), gen: 0, hk: [], hv: [] };
    scratches.set(state, s);
  }
  s.gen++;
  s.hk.length = 0;
  s.hv.length = 0;
  return s;
}
function heapPush(s: Scratch, v: number, k: number): void {
  const K = s.hk;
  const V = s.hv;
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
function heapPop(s: Scratch): number {
  const K = s.hk;
  const V = s.hv;
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

/**
 * The rail route from hub tile a to hub tile b over pid's own land (both hub tiles always enterable), or null. Pure
 * (scratch buffers only). The result depends on the terrain and the owners only.
 */
export function railRouteTiles(state: GameState, pid: number, a: number, b: number): Int32Array | null {
  const map = state.map;
  const w = map.width;
  const ax = a % w;
  const ay = (a / w) | 0;
  const bx = b % w;
  const by = (b / w) | 0;
  const M = L.railMargin;
  const x0 = Math.max(0, Math.min(ax, bx) - M);
  const y0 = Math.max(0, Math.min(ay, by) - M);
  const x1 = Math.min(w - 1, Math.max(ax, bx) + M);
  const y1 = Math.min(map.height - 1, Math.max(ay, by) + M);
  const BW = x1 - x0 + 1;
  const s = scratchOf(state, BW * (y1 - y0 + 1));
  const { g, from, mark, closed } = s;
  const gen = s.gen;
  const owner = map.owner;
  const ter = map.terrain;
  /** straight step cost onto global tile t (-1 = not enterable) */
  const cost = (t: number, diag: boolean): number => {
    if (t === a || t === b) return diag ? 14 : 10;
    const tt = ter[t];
    if (tt <= 1 || owner[t] !== pid) return -1;
    return diag ? DIAG[tt] : STEP[tt];
  };
  const loc = (x: number, y: number): number => (y - y0) * BW + (x - x0);
  const heur = (x: number, y: number): number => {
    const dx = Math.abs(x - bx);
    const dy = Math.abs(y - by);
    return dx > dy ? 10 * dx + 4 * dy : 10 * dy + 4 * dx;
  };
  const start = loc(ax, ay);
  const goal = loc(bx, by);
  g[start] = 0;
  mark[start] = gen;
  from[start] = -1;
  heapPush(s, start, heur(ax, ay));
  let found = false;
  let budget = L.railSearchNodes;
  const relax = (j: number, nc: number, f: number, x: number, y: number): void => {
    if (mark[j] === gen && g[j] <= nc) return;
    mark[j] = gen;
    g[j] = nc;
    from[j] = f;
    heapPush(s, j, nc + heur(x, y));
  };
  while (s.hv.length) {
    const cur = heapPop(s);
    if (closed[cur] === gen) continue;
    closed[cur] = gen;
    if (cur === goal) {
      found = true;
      break;
    }
    if (--budget < 0) break;
    const cx = (cur % BW) + x0;
    const cy = ((cur / BW) | 0) + y0;
    const gc = g[cur];
    for (let d = 0; d < 8; d++) {
      const dx = DX[d];
      const dy = DY[d];
      const diag = d >= 4;
      const nx = cx + dx;
      const ny = cy + dy;
      if (nx < x0 || ny < y0 || nx > x1 || ny > y1) continue;
      const nt = ny * w + nx;
      if (ter[nt] <= 1 && nt !== b) {
        // A bridge: straight on over the water to own land within bridgeMax tiles.
        let k = 1;
        let ex = nx;
        let ey = ny;
        while (k <= L.bridgeMax && ex >= x0 && ey >= y0 && ex <= x1 && ey <= y1 && ter[ey * w + ex] <= 1) {
          k++;
          ex = cx + dx * k;
          ey = cy + dy * k;
        }
        if (k > L.bridgeMax || ex < x0 || ey < y0 || ex > x1 || ey > y1) continue;
        const lc = cost(ey * w + ex, false);
        if (lc < 0) continue;
        relax(loc(ex, ey), gc + (diag ? 14 : 10) * k * 3 + 40 + lc, cur, ex, ey);
        continue;
      }
      const lc = cost(nt, diag);
      if (lc < 0) continue;
      // no corner cutting past a tile the rail cannot use
      if (diag && nt !== b && (cost(cy * w + nx, false) < 0 || cost(ny * w + cx, false) < 0)) continue;
      relax(loc(nx, ny), gc + lc, cur, nx, ny);
    }
  }
  const wk = supplyLinesWork(state);
  wk.searches++;
  wk.searchNodes += L.railSearchNodes - budget;
  if (!found) return null;
  const tiles: number[] = [];
  for (let c = goal; c !== -1; c = from[c]) {
    const x = (c % BW) + x0;
    const y = ((c / BW) | 0) + y0;
    const f = from[c];
    tiles.push(y * w + x);
    if (f < 0) break;
    // the water tiles of a bridge between the bank tiles
    const fx = (f % BW) + x0;
    const fy = ((f / BW) | 0) + y0;
    const sx = Math.sign(fx - x);
    const sy = Math.sign(fy - y);
    for (let px = x + sx, py = y + sy; px !== fx || py !== fy; px += sx, py += sy) tiles.push(py * w + px);
  }
  tiles.reverse();
  return Int32Array.from(tiles);
}

/** True while every land tile of a stored route is still pid's. */
function routeHolds(map: MapData, pid: number, path: Int32Array): boolean {
  const owner = map.owner;
  const ter = map.terrain;
  for (let k = 0; k < path.length; k++) {
    const t = path[k];
    if (ter[t] > 1 && owner[t] !== pid) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------------------------------------------
// Seas (static per map)
// ---------------------------------------------------------------------------------------------------------------

const seaLabels = new WeakMap<MapData, Int32Array>();
/** Water body id of every tile (4-connected water; 0 = land). Computed once per map. */
function seaComponents(map: MapData): Int32Array {
  let c = seaLabels.get(map);
  if (c && c.length === map.terrain.length) return c;
  const { width: w, terrain } = map;
  const n = terrain.length;
  c = new Int32Array(n);
  const queue = new Int32Array(n);
  let id = 0;
  for (let s = 0; s < n; s++) {
    if (terrain[s] > 1 || c[s]) continue;
    id++;
    let head = 0;
    let tail = 0;
    queue[tail++] = s;
    c[s] = id;
    while (head < tail) {
      const t = queue[head++];
      const x = t % w;
      if (x > 0 && terrain[t - 1] <= 1 && !c[t - 1]) (c[t - 1] = id), (queue[tail++] = t - 1);
      if (x < w - 1 && terrain[t + 1] <= 1 && !c[t + 1]) (c[t + 1] = id), (queue[tail++] = t + 1);
      if (t >= w && terrain[t - w] <= 1 && !c[t - w]) (c[t - w] = id), (queue[tail++] = t - w);
      if (t + w < n && terrain[t + w] <= 1 && !c[t + w]) (c[t + w] = id), (queue[tail++] = t + w);
    }
  }
  seaLabels.set(map, c);
  return c;
}
/** The sea a coastal tile opens on: the first water tile within 2 tiles (row by row); 0 = none. */
function seaOf(map: MapData, tile: number): number {
  const w = map.width;
  const x = tile % w;
  const y = (tile / w) | 0;
  const sea = seaComponents(map);
  for (let dy = -2; dy <= 2; dy++) {
    const yy = y + dy;
    if (yy < 0 || yy >= map.height) continue;
    for (let dx = -2; dx <= 2; dx++) {
      const xx = x + dx;
      if (xx < 0 || xx >= w) continue;
      const v = sea[yy * w + xx];
      if (v) return v;
    }
  }
  return 0;
}

// ---------------------------------------------------------------------------------------------------------------
// Building the network
// ---------------------------------------------------------------------------------------------------------------

/** The hubs of pid now, in tile order. */
function hubsOf(state: GameState, pid: number): Hub[] {
  const p = state.players[pid];
  const owner = state.map.owner;
  const w = state.map.width;
  const out: Hub[] = [];
  const seen = new Set<number>();
  const add = (tile: number, kind: SupplyHubKind): void => {
    if (seen.has(tile) || owner[tile] !== pid) return;
    seen.add(tile);
    out.push({ tile, kind, x: tile % w, y: (tile / w) | 0 });
  };
  if (p && p.capital >= 0) add(p.capital, 'capital');
  for (const type of ['city', 'factory', 'port', 'fort'] as const) {
    for (const b of buildingsOf(state, pid, type)) if (b.buildLeft <= 0) add(b.tile, type);
  }
  for (const t of beachheadTiles(state, pid)) add(t, 'beachhead');
  return out.sort((a, b) => a.tile - b.tile);
}

function headsKey(state: GameState, pid: number): string {
  const owner = state.map.owner;
  return beachheadTiles(state, pid)
    .filter((t) => owner[t] === pid)
    .sort((a, b) => a - b)
    .join(',');
}

const floods = new WeakMap<GameState, { par: Int32Array; queue: Int32Array }>();

/** Work counters (perf probes, scripts): network rebuilds, route searches and the tiles they looked at, floods. */
export interface SupplyLinesWork {
  relinks: number;
  searches: number;
  searchNodes: number;
  floods: number;
  floodTiles: number;
}
const works = new WeakMap<GameState, SupplyLinesWork>();
export function supplyLinesWork(state: GameState): SupplyLinesWork {
  let w = works.get(state);
  if (!w) works.set(state, (w = { relinks: 0, searches: 0, searchNodes: 0, floods: 0, floodTiles: 0 }));
  return w;
}

/**
 * Joins hubs apart from the capital's cluster (find / union over the links so far) to it over own dry land: first a
 * stored route that still holds, then, cluster by cluster, a flood over own land (4-connected) from the cluster's hubs
 * that lays a rail to the first joined hub it meets. A cluster no flood can join is cut off by enemy land; the same
 * cluster is flooded again after floodRetrySeconds (or at once when it changes). Only clusters on a landmass of a
 * joined hub are tried (other landmasses need a convoy lane).
 */
function landJoin(
  state: GameState,
  pid: number,
  net: Net,
  hubs: Hub[],
  find: (i: number) => number,
  union: (a: number, b: number) => void,
  cap: number,
  add: (a: number, b: number, path: Int32Array) => void,
): void {
  const map = state.map;
  const land = landComponents(map);
  const joinedIn = (i: number): boolean => find(i) === find(cap);
  const lands = new Set<number>();
  for (let i = 0; i < hubs.length; i++) if (joinedIn(i)) lands.add(land[hubs[i].tile]);
  const want = (i: number): boolean => !joinedIn(i) && hubs[i].kind !== 'beachhead' && lands.has(land[hubs[i].tile]);
  const anyWanted = (): boolean => {
    for (let i = 0; i < hubs.length; i++) if (want(i)) return true;
    return false;
  };
  if (!anyWanted()) return;
  // stored routes first (no flood while they hold)
  const index = new Map<number, number>();
  hubs.forEach((h, i) => index.set(h.tile, i));
  for (const r of [...net.routes.values()].sort((p, q) => (p.path?.[0] ?? 0) - (q.path?.[0] ?? 0) || (p.path?.length ?? 0) - (q.path?.length ?? 0))) {
    if (!r.path || !r.path.length) continue;
    const a = index.get(r.path[0]);
    const b = index.get(r.path[r.path.length - 1]);
    if (a === undefined || b === undefined || joinedIn(a) === joinedIn(b) || !routeHolds(map, pid, r.path)) continue;
    add(a, b, r.path);
    union(a, b);
  }
  if (!anyWanted()) return;
  const n = map.terrain.length;
  let f = floods.get(state);
  if (!f || f.par.length !== n) floods.set(state, (f = { par: new Int32Array(n), queue: new Int32Array(1024) }));
  const par = f.par; // parent tile + 1 (0 = not seen; a start points at itself)
  const owner = map.owner;
  const ter = map.terrain;
  const w = map.width;
  const fails = new Map<string, number>();
  const retry = L.floodRetrySeconds * TICKS_PER_SECOND;
  for (let i = 0; i < hubs.length; i++) {
    if (!want(i)) continue;
    // the cluster of hub i (lowest index first, so the order is fixed)
    const root = find(i);
    const members: number[] = [];
    for (let j = 0; j < hubs.length; j++) if (find(j) === root) members.push(j);
    if (members[0] !== i) continue;
    const key = members.map((j) => hubs[j].tile).join(',');
    const last = net.floodFails.get(key);
    if (last !== undefined && state.tick - last < retry) {
      fails.set(key, last);
      continue;
    }
    let queue = f.queue;
    let head = 0;
    let tail = 0;
    const push = (t: number, from: number): void => {
      if (tail >= queue.length) {
        const q2 = new Int32Array(queue.length * 2);
        q2.set(queue);
        queue = f!.queue = q2;
      }
      par[t] = from + 1;
      queue[tail++] = t;
    };
    for (const j of members) if (!par[hubs[j].tile]) push(hubs[j].tile, hubs[j].tile);
    let hit = -1;
    try {
      while (head < tail) {
        const t = queue[head++];
        const hj = index.get(t);
        if (hj !== undefined && joinedIn(hj)) {
          hit = t;
          break;
        }
        const x = t % w;
        if (x > 0 && !par[t - 1] && ter[t - 1] > 1 && owner[t - 1] === pid) push(t - 1, t);
        if (x < w - 1 && !par[t + 1] && ter[t + 1] > 1 && owner[t + 1] === pid) push(t + 1, t);
        if (t >= w && !par[t - w] && ter[t - w] > 1 && owner[t - w] === pid) push(t - w, t);
        if (t + w < n && !par[t + w] && ter[t + w] > 1 && owner[t + w] === pid) push(t + w, t);
      }
      if (hit >= 0) {
        const tiles: number[] = [hit];
        let c = hit;
        while (par[c] - 1 !== c) {
          c = par[c] - 1;
          tiles.push(c);
        }
        const from = index.get(c) as number;
        const to = index.get(hit) as number;
        add(from, to, Int32Array.from(tiles.reverse()));
        union(from, to);
      } else fails.set(key, state.tick);
    } finally {
      for (let k = 0; k < tail; k++) par[queue[k]] = 0;
      const wk = supplyLinesWork(state);
      wk.floods++;
      wk.floodTiles += tail;
    }
  }
  net.floodFails = fails;
}

function relink(state: GameState, pid: number, net: Net): void {
  supplyLinesWork(state).relinks++;
  const map = state.map;
  const n = map.terrain.length;
  const hubs = hubsOf(state, pid);
  const index = new Map<number, number>();
  hubs.forEach((h, i) => index.set(h.tile, i));
  const links: Link[] = [];
  const pairs = new Set<number>();
  const used = new Map<number, Route>();
  const retry = L.retrySeconds * TICKS_PER_SECOND;
  let failed = false;
  let deferred = false;
  let searches = L.railSearchesPerCheck;
  const max2 = L.railMaxDist * L.railMaxDist;
  const tryRail = (i: number, j: number): boolean => {
    const lo = Math.min(i, j);
    const hi = Math.max(i, j);
    const key = hubs[lo].tile * n + hubs[hi].tile;
    if (pairs.has(key)) return true;
    let r = used.get(key) ?? net.routes.get(key);
    if (r && r.path && !routeHolds(map, pid, r.path)) r = undefined;
    if (!r || (!r.path && state.tick - r.tried >= retry)) {
      if (searches <= 0) {
        // out of searches for this check: the next check lays it
        deferred = true;
        if (r) used.set(key, r);
        return false;
      }
      searches--;
      r = { path: railRouteTiles(state, pid, hubs[lo].tile, hubs[hi].tile), tried: state.tick };
    }
    used.set(key, r);
    if (!r.path) {
      failed = true;
      return false;
    }
    pairs.add(key);
    links.push({ a: lo, b: hi, sea: false, path: r.path, cut: false });
    return true;
  };
  for (let i = 0; i < hubs.length; i++) {
    const h = hubs[i];
    const near: { j: number; d: number }[] = [];
    for (let j = 0; j < hubs.length; j++) {
      if (j === i) continue;
      const dx = hubs[j].x - h.x;
      const dy = hubs[j].y - h.y;
      const d = dx * dx + dy * dy;
      if (d <= max2) near.push({ j, d });
    }
    near.sort((p, q) => p.d - q.d || hubs[p.j].tile - hubs[q.j].tile);
    let made = 0;
    for (let k = 0; k < near.length && k < L.railLinks + 2 && made < L.railLinks; k++) if (tryRail(i, near[k].j)) made++;
  }
  // Sea lanes: ports and beachheads on different landmasses of the same sea.
  const ends: number[] = [];
  for (let i = 0; i < hubs.length; i++) if (hubs[i].kind === 'port' || hubs[i].kind === 'beachhead') ends.push(i);
  if (ends.length >= 2) {
    const land = landComponents(map);
    const seas = new Map<number, number>();
    for (const i of ends) seas.set(i, seaOf(map, hubs[i].tile));
    const sea2 = L.seaMaxDist * L.seaMaxDist;
    const lanes = new Set<number>();
    const nearestEnd = (i: number, portsOnly: boolean): number => {
      let best = -1;
      let bd = Infinity;
      const si = seas.get(i) ?? 0;
      if (!si) return -1;
      for (const j of ends) {
        if (j === i || (portsOnly && hubs[j].kind !== 'port') || land[hubs[j].tile] === land[hubs[i].tile] || seas.get(j) !== si) continue;
        const dx = hubs[j].x - hubs[i].x;
        const dy = hubs[j].y - hubs[i].y;
        const d = dx * dx + dy * dy;
        if (d <= sea2 && (d < bd || (d === bd && hubs[j].tile < hubs[best].tile))) {
          bd = d;
          best = j;
        }
      }
      return best;
    };
    const addLane = (port: number, other: number): void => {
      // a = the port end (the lower index when both are ports)
      const [a, b] = hubs[other].kind === 'port' && other < port ? [other, port] : [port, other];
      const key = a * 65536 + b;
      if (lanes.has(key)) return;
      lanes.add(key);
      links.push({ a, b, sea: true, path: null, cut: false });
    };
    for (const i of ends) {
      if (hubs[i].kind !== 'port') continue;
      const j = nearestEnd(i, false);
      if (j >= 0) addLane(i, j);
    }
    for (const j of ends) {
      if (hubs[j].kind !== 'beachhead') continue;
      let has = false;
      for (const l of links) if (l.sea && (l.a === j || l.b === j)) has = true;
      if (has) continue;
      const i = nearestEnd(j, true);
      if (i >= 0) addLane(i, j);
    }
  }
  // Join: the nearest-hub rails can leave a cluster (forts along a border linked only to each other) apart from the
  // capital's. Such a cluster gets a rail to the nearest hub that is joined (the shortest pair first, a few tries a
  // round), until no cluster can be joined. Hubs no rail can reach stay apart (cut).
  const cap = hubs.findIndex((h) => h.kind === 'capital');
  const exempt = new Uint8Array(hubs.length);
  if (cap >= 0 && hubs.length > 1) {
    const parent = hubs.map((_, i) => i);
    const find = (i: number): number => {
      while (parent[i] !== i) i = parent[i] = parent[parent[i]];
      return i;
    };
    const union = (a: number, b: number): void => {
      const ra = find(a);
      const rb = find(b);
      if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
    };
    for (const l of links) union(l.a, l.b);
    const gaveUp = new Set<number>();
    for (let round = 0; round < hubs.length; round++) {
      const root = find(cap);
      const pairs: { i: number; j: number; d: number }[] = [];
      for (let i = 0; i < hubs.length; i++) {
        if (find(i) === root) continue;
        for (let j = 0; j < hubs.length; j++) {
          if (find(j) !== root) continue;
          const dx = hubs[j].x - hubs[i].x;
          const dy = hubs[j].y - hubs[i].y;
          const d = dx * dx + dy * dy;
          if (d <= max2 && !gaveUp.has(i * hubs.length + j)) pairs.push({ i, j, d });
        }
      }
      if (!pairs.length) break;
      pairs.sort((p, q) => p.d - q.d || hubs[p.i].tile - hubs[q.i].tile || hubs[p.j].tile - hubs[q.j].tile);
      let joined = false;
      for (let k = 0; k < pairs.length && k < 4; k++) {
        const { i, j } = pairs[k];
        if (tryRail(i, j)) {
          union(i, j);
          joined = true;
          break;
        }
        gaveUp.add(i * hubs.length + j);
      }
      if (!joined && pairs.length <= 4) break;
    }
    // Own land guarantee: a hub still apart that own dry land joins to a joined hub gets a rail along that land, at
    // any distance and whatever the search budget (a flood over own land from the joined hubs). Only land actually
    // split by an enemy (or the sea) leaves a hub apart.
    landJoin(state, pid, net, hubs, find, union, cap, (a, b, path) => {
      const lo = Math.min(a, b);
      const hi = Math.max(a, b);
      const key = hubs[lo].tile * n + hubs[hi].tile;
      if (pairs.has(key)) return;
      const fwd = hubs[lo].tile === path[0] ? path : path.slice().reverse();
      pairs.add(key);
      used.set(key, { path: fwd, tried: state.tick });
      links.push({ a: lo, b: hi, sea: false, path: fwd, cut: false });
    });
    // Clusters on a landmass none of the joined hubs is on, with no lane to them: no network there (not cut).
    const land = landComponents(map);
    const lands = new Set<number>();
    for (let i = 0; i < hubs.length; i++) if (find(i) === find(cap)) lands.add(land[hubs[i].tile]);
    for (let i = 0; i < hubs.length; i++) if (find(i) !== find(cap) && !lands.has(land[hubs[i].tile])) exempt[i] = 1;
  }
  links.sort((p, q) => p.a - q.a || p.b - q.b || Number(p.sea) - Number(q.sea));
  const adj: number[][] = hubs.map(() => []);
  const degree = new Int32Array(hubs.length);
  links.forEach((l, k) => {
    adj[l.a].push(k);
    adj[l.b].push(k);
    if (!l.sea) {
      degree[l.a]++;
      degree[l.b]++;
    }
  });
  for (let i = 0; i < adj.length; i++) {
    adj[i].sort((p, q) => {
      const op = links[p].a === i ? links[p].b : links[p].a;
      const oq = links[q].a === i ? links[q].b : links[q].a;
      return op - oq || p - q;
    });
  }
  net.hubs = hubs;
  net.index = index;
  net.links = links;
  net.adj = adj;
  net.degree = degree;
  net.routes = used;
  net.retryAt = deferred ? state.tick + 1 : failed ? state.tick + retry : Infinity;
  if (net.floodFails.size) net.retryAt = Math.min(net.retryAt, state.tick + L.floodRetrySeconds * TICKS_PER_SECOND);
  net.exempt = exempt;
  net.built = true;
}

// ---------------------------------------------------------------------------------------------------------------
// Damage, guard and repair
// ---------------------------------------------------------------------------------------------------------------

const HUB_STRIDE = 6; // tile, owner, damagedUntil, guardedUntil, by, repaired
const SUNK_STRIDE = 5; // port, other end, owner, untilTick, by

function hubEntry(sn: SupplyNetState | undefined, pid: number, tile: number): number {
  if (!sn) return -1;
  const h = sn.hubs;
  for (let k = 0; k < h.length; k += HUB_STRIDE) if (h[k] === tile && h[k + 1] === pid) return k;
  return -1;
}
/** True while pid's hub on tile is damaged (routes do not pass it). */
export function hubDamaged(state: GameState, pid: number, tile: number): boolean {
  const sn = state.supplyNet;
  const k = hubEntry(sn, pid, tile);
  return k >= 0 && state.tick < (sn as SupplyNetState).hubs[k + 2];
}
/** Damage and guard ticks of pid's hub on tile ({0, 0} = untouched). */
export function hubTimers(state: GameState, pid: number, tile: number): { damagedUntil: number; guardedUntil: number } {
  const sn = state.supplyNet;
  const k = hubEntry(sn, pid, tile);
  if (k < 0) return { damagedUntil: 0, guardedUntil: 0 };
  const h = (sn as SupplyNetState).hubs;
  return { damagedUntil: h[k + 2], guardedUntil: h[k + 3] };
}
function canDamage(state: GameState, pid: number, tile: number): boolean {
  const t = hubTimers(state, pid, tile);
  return state.tick >= t.damagedUntil && state.tick >= t.guardedUntil;
}

/** True when a working Flak site or SAM site of pid covers tile (a hub there repairs repairAirDefenseCut s sooner). */
export function hubAirCover(state: GameState, pid: number, tile: number): boolean {
  const w = state.map.width;
  const x = tile % w;
  const y = (tile / w) | 0;
  const near = (t: number, r: number): boolean => {
    const dx = (t % w) - x;
    const dy = ((t / w) | 0) - y;
    return dx * dx + dy * dy <= r * r;
  };
  for (const s of buildingsOf(state, pid, 'sam')) if (s.buildLeft <= 0 && !isDisabled(state, s) && near(s.tile, samRadius(s))) return true;
  if (hasFlak(state, pid)) {
    for (const type of ['fort', 'city'] as const) {
      for (const b of buildingsOf(state, pid, type)) if (flakWorking(state, b) && near(b.tile, flakRadius(b))) return true;
    }
  }
  return false;
}

/** Seconds a hub of pid on tile takes to repair after a hit now (45, 30 with Logistics, minus 10 under air cover). */
export function hubRepairSeconds(state: GameState, pid: number, tile: number): number {
  const p = state.players[pid];
  const base = p && hasTech(p, 'logistics') ? L.repairSecondsLogistics : L.repairSeconds;
  return Math.max(1, base - (hubAirCover(state, pid, tile) ? L.repairAirDefenseCut : 0));
}

/** True if tile holds a hub of its owner that a hit can damage (a finished city, factory, port or fort; not the capital). */
function damageableHub(state: GameState, tile: number): number {
  const b = buildingAt(state, tile);
  if (!b || !HUB_TYPES.has(b.type) || b.buildLeft > 0 || state.map.owner[tile] !== b.owner) return 0;
  if (state.players[b.owner]?.capital === tile) return 0;
  return b.owner;
}

/**
 * A bomb, missile or shell by `attacker` landed on `center` with blast radius r: every hostile supply hub in the blast
 * is damaged (a damaged or freshly repaired one is not hit again). Returns the hubs damaged.
 */
export function damageSupplyHubs(state: GameState, attacker: number, center: number, r: number): number {
  const map = state.map;
  const hit: number[] = [];
  forEachInRadius(map, center, Math.max(0, r), (i) => {
    if (!map.building[i]) return;
    const o = damageableHub(state, i);
    if (o > 0 && hostile(state, attacker, o)) hit.push(i);
  });
  let n = 0;
  for (const t of hit) if (damageHub(state, map.owner[t], t, attacker)) n++;
  return n;
}

/** Damages pid's hub on tile (by `by`): false when it is damaged or guarded already, or not a hub. */
export function damageHub(state: GameState, pid: number, tile: number, by: number): boolean {
  if (damageableHub(state, tile) !== pid || !canDamage(state, pid, tile)) return false;
  const sn = supplyNetOf(state);
  const k = hubEntry(sn, pid, tile);
  if (k >= 0) sn.hubs.splice(k, HUB_STRIDE);
  const secs = hubRepairSeconds(state, pid, tile);
  const until = state.tick + secs * TICKS_PER_SECOND;
  sn.hubs.push(tile, pid, until, until + L.guardSeconds * TICKS_PER_SECOND, by, 0);
  const net = readNet(state, pid);
  const cut = net && net.built ? walk(state, pid, net, true).cut : [];
  const kind = kindAt(state, net, tile);
  const info = eventInfo(state, pid, by, tile, kind, secs, cut);
  const where = KIND_NAME[kind].toLowerCase();
  const ownerName = state.players[pid]?.name ?? 'The enemy';
  if (cut.length) {
    addEvent(state, 'supplyHubDamaged', `Your supply is cut at your ${where}: repair in ${secs} s (${sourceCount(state, cut)} cut off)`, [pid], tile, info);
    if (by > 0) addEvent(state, 'supplyHubDamaged', `Supply cut: ${ownerName}'s ${info.direction ? info.direction + ' ' : ''}front is slower for ${secs} s`, [by], tile, info);
  } else {
    addEvent(state, 'supplyHubDamaged', `Your ${where} supply hub was hit: repair in ${secs} s (supply rerouted, nothing cut)`, [pid], tile, info);
    if (by > 0) addEvent(state, 'supplyHubDamaged', `You hit ${ownerName}'s ${where} supply hub: they rerouted, nothing cut`, [by], tile, info);
  }
  return true;
}

function kindAt(state: GameState, net: Net | undefined, tile: number): SupplyHubKind {
  const i = net?.index.get(tile);
  if (net && i !== undefined) return net.hubs[i].kind;
  const b = buildingAt(state, tile);
  return b && HUB_TYPES.has(b.type) ? (b.type as SupplyHubKind) : 'city';
}

/** "2 forts", "a fort and a beachhead" ... */
function sourceCount(state: GameState, tiles: readonly number[]): string {
  let forts = 0;
  let heads = 0;
  for (const t of tiles) {
    const b = buildingAt(state, t);
    if (b && b.type === 'fort') forts++;
    else heads++;
  }
  const part = (n: number, one: string): string => (n === 1 ? `1 ${one}` : `${n} ${one}s`);
  if (forts && heads) return `${part(forts, 'fort')} and ${part(heads, 'beachhead')}`;
  return heads ? part(heads, 'beachhead') : part(forts, 'fort');
}

// ---------------------------------------------------------------------------------------------------------------
// Directions (for event text: "Red's eastern front")
// ---------------------------------------------------------------------------------------------------------------

/** Compass word for a direction (screen y grows south): 'eastern', 'north-western', ... ('' for none). */
export function compassWord(dx: number, dy: number): string {
  if (dx === 0 && dy === 0) return '';
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  const ns = dy < 0 ? 'north' : 'south';
  const ew = dx > 0 ? 'east' : 'west';
  if (ay * 5 < ax * 2) return `${ew}ern`;
  if (ax * 5 < ay * 2) return `${ns}ern`;
  return `${ns}-${ew}ern`;
}
/** Where tiles lie seen from pid's capital ('' without a capital or tiles). */
export function directionOf(state: GameState, pid: number, tiles: readonly number[]): string {
  const cap = state.players[pid]?.capital ?? -1;
  if (cap < 0 || !tiles.length) return '';
  const w = state.map.width;
  let sx = 0;
  let sy = 0;
  for (const t of tiles) {
    sx += t % w;
    sy += (t / w) | 0;
  }
  const n = tiles.length;
  return compassWord(Math.round(sx / n) - (cap % w), Math.round(sy / n) - ((cap / w) | 0));
}

function eventInfo(state: GameState, owner: number, by: number, hub: number, kind: SupplyHubKind | null, seconds: number, sources: number[]): SupplyEventInfo {
  return { owner, by, hub, hubKind: kind, seconds, sources, direction: directionOf(state, owner, sources) };
}

// ---------------------------------------------------------------------------------------------------------------
// The walk
// ---------------------------------------------------------------------------------------------------------------

/** BFS from the capital over open links, never on past a blocked hub (extra = one more hub treated as blocked). */
function reach(net: Net, blocked: Uint8Array, extra: number): Uint8Array {
  const h = net.hubs.length;
  const reached = new Uint8Array(h);
  let cap = -1;
  for (let i = 0; i < h; i++) if (net.hubs[i].kind === 'capital') cap = i;
  if (cap < 0) {
    // no capital: nothing to cut from (every source counts, as before supply lines)
    reached.fill(1);
    return reached;
  }
  const queue = new Int32Array(h);
  let head = 0;
  let tail = 0;
  reached[cap] = 1;
  queue[tail++] = cap;
  while (head < tail) {
    const i = queue[head++];
    for (const k of net.adj[i]) {
      const l = net.links[k];
      if (l.cut) continue;
      const j = l.a === i ? l.b : l.a;
      if (reached[j]) continue;
      reached[j] = 1;
      // a damaged hub still gets its own supply; routes do not pass through it
      if (!blocked[j] && j !== extra) queue[tail++] = j;
    }
  }
  return reached;
}

/**
 * Walks pid's network again and stores its cut list. Returns the sources newly cut off (that were reached before) and
 * the ones reached again. quiet: the caller reports them (damage, repair, convoy events), else supplyCut /
 * supplyRestored events go out here.
 */
function walk(state: GameState, pid: number, net: Net, quiet: boolean, by = 0): { cut: number[]; restored: number[] } {
  const h = net.hubs.length;
  const blocked = new Uint8Array(h);
  for (let i = 0; i < h; i++) if (net.hubs[i].kind !== 'capital' && hubDamaged(state, pid, net.hubs[i].tile)) blocked[i] = 1;
  const reached = reach(net, blocked, -1);
  net.reached = reached;
  net.blocked = blocked;
  net.walks++;
  const cut: number[] = [];
  const live = new Set<number>();
  for (let i = 0; i < h; i++) {
    const hb = net.hubs[i];
    if (!isSourceKind(hb.kind)) continue;
    live.add(hb.tile);
    if (sourceCut(net, i, reached)) cut.push(hb.tile);
  }
  const sn = supplyNetOf(state);
  const old = sn.cut[pid] ?? [];
  const oldSet = new Set(old);
  const cutSet = new Set(cut);
  const newly = cut.filter((t) => !oldSet.has(t) && net.known.has(t));
  const restored = old.filter((t) => !cutSet.has(t) && live.has(t));
  for (const t of [...net.known]) if (!live.has(t)) net.known.delete(t);
  for (let i = 0; i < h; i++) if (isSourceKind(net.hubs[i].kind) && !sourceCut(net, i, reached)) net.known.add(net.hubs[i].tile);
  const same = old.length === cut.length && cut.every((t, k) => t === old[k]);
  if (!same) {
    while (sn.cut.length <= pid) sn.cut.push(null);
    sn.cut[pid] = cut.length ? cut : null;
    sn.version++;
  }
  if (!quiet) {
    if (newly.length) {
      const dir = directionOf(state, pid, newly);
      addEvent(state, 'supplyCut', `Your ${dir ? dir + ' ' : ''}supply is cut: ${sourceCount(state, newly)} out of reach`, by > 0 ? [pid, by] : [pid], newly[0], eventInfo(state, pid, by, -1, null, 0, newly));
    }
    if (restored.length) {
      const dir = directionOf(state, pid, restored);
      addEvent(state, 'supplyRestored', `Your ${dir ? dir + ' ' : ''}supply is restored: ${sourceCount(state, restored)} reached again`, [pid], restored[0], eventInfo(state, pid, 0, -1, null, 0, restored));
    }
  }
  return { cut: newly, restored };
}

/** Sources (forts, beachheads) supplied now that a hit on hub i would cut off (the ones behind it). Memoized per walk. */
function cutIfBlocked(net: Net, i: number): number[] {
  if (net.memoWalks !== net.walks) {
    net.memo.clear();
    net.memoWalks = net.walks;
  }
  const m = net.memo.get(i);
  if (m) return m;
  const out: number[] = [];
  if (i >= 0 && i < net.hubs.length && net.reached[i] && !net.blocked[i] && net.hubs[i].kind !== 'capital') {
    const r = reach(net, net.blocked, i);
    for (let j = 0; j < net.hubs.length; j++) if (!sourceCut(net, j, net.reached) && sourceCut(net, j, r)) out.push(net.hubs[j].tile);
  }
  net.memo.set(i, out);
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Convoys
// ---------------------------------------------------------------------------------------------------------------

function sunkEntry(sn: SupplyNetState | undefined, pid: number, a: number, b: number): number {
  if (!sn) return -1;
  const s = sn.sunk;
  for (let k = 0; k < s.length; k += SUNK_STRIDE) if (s[k] === a && s[k + 1] === b && s[k + 2] === pid) return k;
  return -1;
}
/** Ticks into the current convoy cycle of the lane a-b (0 = a convoy leaves now). */
export function convoyPhase(tick: number, a: number, b: number): number {
  const period = L.convoyEverySeconds * TICKS_PER_SECOND;
  const off = (a % period) + ((b * 7) % period);
  return (((tick - off) % period) + period) % period;
}
/** The first warship (unit order) of a nation at war with pid within convoySinkRadius of the lane a-b; null = none. */
function sinker(state: GameState, pid: number, a: number, b: number): { owner: number } | null {
  const w = state.map.width;
  const ax = (a % w) + 0.5;
  const ay = ((a / w) | 0) + 0.5;
  const bx = (b % w) + 0.5;
  const by = ((b / w) | 0) + 0.5;
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const r2 = L.convoySinkRadius * L.convoySinkRadius;
  for (const u of state.units) {
    if (u.type !== 'warship' || u.hp <= 0 || u.owner === pid || !atWar(state, u.owner, pid)) continue;
    const ux = u.x + 0.5;
    const uy = u.y + 0.5;
    let t = len2 > 0 ? ((ux - ax) * dx + (uy - ay) * dy) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    const px = ax + dx * t - ux;
    const py = ay + dy * t - uy;
    if (px * px + py * py <= r2) return { owner: u.owner };
  }
  return null;
}

/** Opens / closes pid's lanes now (sunk convoys, blockades; a sailing convoy may be sunk here). True if any changed. */
function updateLanes(state: GameState, pid: number, net: Net, events: (() => void)[]): { changed: boolean; by: number } {
  let changed = false;
  let by = 0;
  const period = L.convoyEverySeconds * TICKS_PER_SECOND;
  const sail = L.convoySailSeconds * TICKS_PER_SECOND;
  for (const l of net.links) {
    if (!l.sea) continue;
    const a = net.hubs[l.a];
    const b = net.hubs[l.b];
    const sn = state.supplyNet;
    let cut = sunkEntry(sn, pid, a.tile, b.tile) >= 0;
    if (!cut) {
      const bl = (a.kind === 'port' ? portBlockadedBy(state, a.tile) : 0) || (b.kind === 'port' ? portBlockadedBy(state, b.tile) : 0);
      if (bl) {
        cut = true;
        if (!l.cut) by = bl;
      }
    }
    if (!cut) {
      const ph = convoyPhase(state.tick, a.tile, b.tile);
      const ship = ph < sail ? sinker(state, pid, a.tile, b.tile) : null;
      if (ship) {
        const until = state.tick + (period - ph);
        const secs = Math.round((until - state.tick) / TICKS_PER_SECOND);
        supplyNetOf(state).sunk.push(a.tile, b.tile, pid, until, ship.owner);
        cut = true;
        const s = ship.owner;
        const port = a.tile;
        const kind = a.kind;
        events.push(() => {
          // after the walk: the event lists what the lost convoy cut off
          const lost = net.lastCut;
          const info = eventInfo(state, pid, s, port, kind, secs, lost);
          const tail = lost.length ? `, ${sourceCount(state, lost)} cut off` : '';
          addEvent(state, 'convoySunk', `Your convoy was sunk by ${state.players[s]?.name ?? 'the enemy'}: sea lane cut for ${secs} s${tail}`, [pid], port, info);
          addEvent(state, 'convoySunk', `You sank a convoy of ${state.players[pid]?.name ?? 'the enemy'}: their sea lane is cut for ${secs} s`, [s], port, info);
        });
      }
    }
    if (cut !== l.cut) {
      l.cut = cut;
      changed = true;
    }
  }
  return { changed, by };
}

// ---------------------------------------------------------------------------------------------------------------
// The tick
// ---------------------------------------------------------------------------------------------------------------

/** Checks pid's network now: rebuild the rails when needed, open / close lanes, walk again when anything changed. */
function checkPlayer(state: GameState, pid: number): void {
  const p = state.players[pid];
  if (!p || !p.alive || isTribe(p)) return;
  const nets = netsOf(state);
  let net = nets.byPlayer.get(pid);
  if (!net) nets.byPlayer.set(pid, (net = emptyNet()));
  const stamp = buildingStamp(state, pid);
  const heads = headsKey(state, pid);
  let rebuild = !net.built || net.stamp !== stamp || net.capital !== p.capital || net.heads !== heads || state.tick >= net.retryAt;
  if (!rebuild) {
    for (const l of net.links) {
      if (l.path && !routeHolds(state.map, pid, l.path)) {
        // land under this rail was lost: search again (another route may exist)
        const n = state.map.terrain.length;
        net.routes.delete(net.hubs[l.a].tile * n + net.hubs[l.b].tile);
        rebuild = true;
      }
    }
  }
  let changed = false;
  if (rebuild) {
    const oldLanes = new Map<string, boolean>();
    for (const l of net.links) if (l.sea) oldLanes.set(`${net.hubs[l.a].tile}:${net.hubs[l.b].tile}`, l.cut);
    relink(state, pid, net);
    for (const l of net.links) if (l.sea) l.cut = oldLanes.get(`${net.hubs[l.a].tile}:${net.hubs[l.b].tile}`) ?? false;
    net.stamp = stamp;
    net.capital = p.capital;
    net.heads = heads;
    changed = true;
  }
  const events: (() => void)[] = [];
  const lanes = updateLanes(state, pid, net, events);
  if (lanes.changed) changed = true;
  if (!changed) return;
  const r = walk(state, pid, net, events.length > 0, lanes.by);
  net.lastCut = r.cut;
  for (const e of events) e();
}

/** Repairs, guards ending, hubs gone; convoys that sail again. */
function updateTimers(state: GameState): void {
  const sn = state.supplyNet;
  if (!sn) return;
  const tick = state.tick;
  const recheck = new Set<number>();
  const h = sn.hubs;
  for (let k = 0; k < h.length; ) {
    const [tile, pid, until, guard, by, done] = [h[k], h[k + 1], h[k + 2], h[k + 3], h[k + 4], h[k + 5]];
    if (damageableHub(state, tile) !== pid) {
      // destroyed or captured: the next check rebuilds the network without it
      h.splice(k, HUB_STRIDE);
      continue;
    }
    if (!done && tick >= until) {
      h[k + 5] = 1;
      const net = readNet(state, pid);
      const restored = net && net.built ? walk(state, pid, net, true).restored : [];
      const kind = kindAt(state, net, tile);
      const where = KIND_NAME[kind].toLowerCase();
      const secs = L.guardSeconds;
      const info = eventInfo(state, pid, by, tile, kind, secs, restored);
      const back = restored.length ? `: supply restored to ${sourceCount(state, restored)}` : '';
      addEvent(state, 'supplyHubRepaired', `Your ${where} supply hub is repaired${back} (safe from hits for ${secs} s)`, [pid], tile, info);
      if (by > 0 && state.players[by]?.alive) addEvent(state, 'supplyHubRepaired', `${state.players[pid]?.name ?? 'The enemy'} repaired its ${where} supply hub${restored.length ? ': its supply runs again' : ''}`, [by], tile, info);
    }
    if (tick >= guard) {
      h.splice(k, HUB_STRIDE);
      continue;
    }
    k += HUB_STRIDE;
  }
  const s = sn.sunk;
  for (let k = 0; k < s.length; ) {
    if (tick >= s[k + 3]) {
      recheck.add(s[k + 2]);
      s.splice(k, SUNK_STRIDE);
      continue;
    }
    k += SUNK_STRIDE;
  }
  for (const pid of [...recheck].sort((a, b) => a - b)) checkPlayer(state, pid);
}

/** Supply lines, every tick (sim.ts, after the buildings and before the attacks). */
export function updateSupplyLines(state: GameState): void {
  if (state.phase !== 'playing') return;
  supplyNetOf(state);
  updateTimers(state);
  const ct = L.checkTicks;
  for (const p of state.players) {
    if (!p || p.id <= 0 || !p.alive) continue;
    if ((state.tick + p.id) % ct === 0) checkPlayer(state, p.id);
  }
}

/** Checks pid's network now (tests, tools). */
export function refreshSupplyLines(state: GameState, pid: number): void {
  supplyNetOf(state);
  checkPlayer(state, pid);
}

// ---------------------------------------------------------------------------------------------------------------
// Reads for the client, the AI and the advisor (pure)
// ---------------------------------------------------------------------------------------------------------------

export interface SupplyHubView {
  tile: number;
  kind: SupplyHubKind;
  /** junctionDegree or more rails meet here (a rail yard) */
  junction: boolean;
  /** reached from the capital at the last walk */
  connected: boolean;
  /** ticks; 0 = never hit */
  damagedUntil: number;
  guardedUntil: number;
}
export interface SupplyLinkView {
  a: number;
  b: number;
  kind: 'rail' | 'sea';
  /** closed: a lane with a sunk convoy or a blockade, or a rail with a damaged end */
  cut: boolean;
  /** rails: the route tiles from a to b (bridges included); the art smooths it */
  path: Int32Array | null;
}
export interface SupplyNetworkView {
  hubs: SupplyHubView[];
  links: SupplyLinkView[];
  /** forts and beachheads the network does not reach now */
  cut: number[];
}

/** pid's supply network as of its last check (empty before the first one). Pure read. */
export function supplyNetworkOf(state: GameState, pid: number): SupplyNetworkView {
  const net = readNet(state, pid);
  const cut = [...(state.supplyNet?.cut[pid] ?? [])];
  if (!net || !net.built) return { hubs: [], links: [], cut };
  const hubs = net.hubs.map((h, i) => {
    const t = hubTimers(state, pid, h.tile);
    return { tile: h.tile, kind: h.kind, junction: net.degree[i] >= L.junctionDegree, connected: !!net.reached[i], damagedUntil: t.damagedUntil, guardedUntil: t.guardedUntil };
  });
  const links = net.links.map((l) => ({
    a: net.hubs[l.a].tile,
    b: net.hubs[l.b].tile,
    kind: l.sea ? ('sea' as const) : ('rail' as const),
    cut: l.cut || !!net.blocked[l.a] || !!net.blocked[l.b],
    path: l.path,
  }));
  return { hubs, links, cut };
}

/** The sources (fort and beachhead tiles) a hit by `attacker` on hubTile would cut off now ([] = none, or no hub). */
export function hubCutSources(state: GameState, attacker: number, hubTile: number): number[] {
  const owner = damageableHub(state, hubTile);
  if (owner <= 0 || (attacker > 0 && !hostile(state, attacker, owner)) || !canDamage(state, owner, hubTile)) return [];
  const net = readNet(state, owner);
  const i = net?.index.get(hubTile);
  if (!net || i === undefined) return [];
  return [...cutIfBlocked(net, i)];
}
/** How many enemy supply sources a hit by `attacker` on hubTile would cut ("cuts supply to 2 forts"). Pure read. */
export function hubCutValue(state: GameState, attacker: number, hubTile: number): number {
  return hubCutSources(state, attacker, hubTile).length;
}

/**
 * The hub of `foe` whose damage would cut the most of its sources near `front` (within frontRadius; front < 0: all),
 * then the most in all, lower tile first; only hubs `ok` accepts. Null when no hit would cut anything.
 */
export function bestSupplyHub(state: GameState, attacker: number, foe: number, front: number, ok?: (tile: number) => boolean): { tile: number; near: number; total: number } | null {
  const net = readNet(state, foe);
  if (!net || !net.built || !hostile(state, attacker, foe)) return null;
  const w = state.map.width;
  const fx = front >= 0 ? front % w : 0;
  const fy = front >= 0 ? (front / w) | 0 : 0;
  const r2 = L.frontRadius * L.frontRadius;
  let best: { tile: number; near: number; total: number } | null = null;
  for (let i = 0; i < net.hubs.length; i++) {
    const h = net.hubs[i];
    if (h.kind === 'capital' || h.kind === 'beachhead' || damageableHub(state, h.tile) !== foe || !canDamage(state, foe, h.tile)) continue;
    const srcs = cutIfBlocked(net, i);
    if (!srcs.length || (ok && !ok(h.tile))) continue;
    let near = 0;
    for (const t of srcs) {
      const dx = (t % w) - fx;
      const dy = ((t / w) | 0) - fy;
      if (front < 0 || dx * dx + dy * dy <= r2) near++;
    }
    if (front >= 0 && !near) continue;
    if (!best || near > best.near || (near === best.near && srcs.length > best.total)) best = { tile: h.tile, near, total: srcs.length };
  }
  return best;
}

/** True when a hub of pid the network reaches lies within rail reach (railMaxDist) of tile (no network yet: true). */
export function withinRailReach(state: GameState, pid: number, tile: number): boolean {
  const net = readNet(state, pid);
  if (!net || !net.built) return true;
  const w = state.map.width;
  const x = tile % w;
  const y = (tile / w) | 0;
  const max2 = L.railMaxDist * L.railMaxDist;
  for (let i = 0; i < net.hubs.length; i++) {
    if (!net.reached[i]) continue;
    const dx = net.hubs[i].x - x;
    const dy = net.hubs[i].y - y;
    if (dx * dx + dy * dy <= max2) return true;
  }
  return false;
}

export interface SupplyRisk {
  /** the hub the most of pid's supply hangs on */
  hub: number;
  /** the sources behind it (a hit there would cut them; the hub itself not counted) */
  sources: number[];
  /** where they lie seen from the capital ('' = unknown) */
  direction: string;
}

/**
 * The one hub most of pid's reached forts and beachheads hang on (at least riskMinSources of them, or most of them),
 * or null. The hub's own fort does not count (a second route cannot save a fort that is hit itself). Pure read.
 */
export function supplyRiskOf(state: GameState, pid: number): SupplyRisk | null {
  const net = readNet(state, pid);
  if (!net || !net.built) return null;
  let reached = 0;
  for (let i = 0; i < net.hubs.length; i++) if (net.reached[i] && isSourceKind(net.hubs[i].kind)) reached++;
  if (!reached) return null;
  let best = -1;
  let bestSrc: number[] = [];
  for (let i = 0; i < net.hubs.length; i++) {
    const h = net.hubs[i];
    if (h.kind === 'capital' || h.kind === 'beachhead' || net.blocked[i]) continue;
    const srcs = cutIfBlocked(net, i).filter((t) => t !== h.tile);
    if (srcs.length > bestSrc.length) {
      best = i;
      bestSrc = srcs;
    }
  }
  if (best < 0 || !(bestSrc.length >= L.riskMinSources || bestSrc.length * 2 > reached)) return null;
  return { hub: net.hubs[best].tile, sources: bestSrc, direction: directionOf(state, pid, bestSrc) };
}

/**
 * Spots for a fort that would give the sources behind risk.hub a second route: own land between a hub that would be cut
 * off and one that would not, within rail reach of both and at least 10 tiles from the risky hub (one bomb should not
 * hit both). Best first (the shorter longer leg), at most 8. The rails still need own land between. Pure read.
 */
export function secondRouteSpots(state: GameState, pid: number, risk: SupplyRisk): number[] {
  const net = readNet(state, pid);
  const i = net?.index.get(risk.hub);
  if (!net || i === undefined) return [];
  const without = reach(net, net.blocked, i);
  const w = state.map.width;
  const hgt = state.map.height;
  const owner = state.map.owner;
  const hub = net.hubs[i];
  const lost: number[] = [];
  const keep: number[] = [];
  for (let j = 0; j < net.hubs.length; j++) {
    if (j === i || !net.reached[j]) continue;
    (without[j] ? keep : lost).push(j);
  }
  const d2 = (ax: number, ay: number, bx: number, by: number): number => (ax - bx) * (ax - bx) + (ay - by) * (ay - by);
  lost.sort((p, q) => d2(net.hubs[p].x, net.hubs[p].y, hub.x, hub.y) - d2(net.hubs[q].x, net.hubs[q].y, hub.x, hub.y) || p - q);
  const max2 = L.railMaxDist * L.railMaxDist;
  const cand = new Map<number, number>();
  for (const li of lost.slice(0, 3)) {
    const lh = net.hubs[li];
    const ks = keep
      .filter((k) => d2(net.hubs[k].x, net.hubs[k].y, lh.x, lh.y) <= 4 * max2)
      .sort((p, q) => d2(net.hubs[p].x, net.hubs[p].y, lh.x, lh.y) - d2(net.hubs[q].x, net.hubs[q].y, lh.x, lh.y) || p - q)
      .slice(0, 3);
    for (const ki of ks) {
      const kh = net.hubs[ki];
      const mx = (lh.x + kh.x) / 2;
      const my = (lh.y + kh.y) / 2;
      const dx = kh.x - lh.x;
      const dy = kh.y - lh.y;
      const len = Math.sqrt(dx * dx + dy * dy) || 1;
      for (const off of [0, 20, -20, 35, -35]) {
        const x = Math.round(mx + (-dy / len) * off);
        const y = Math.round(my + (dx / len) * off);
        if (x < 0 || y < 0 || x >= w || y >= hgt) continue;
        const t = y * w + x;
        if (owner[t] !== pid || state.map.terrain[t] <= 1) continue;
        if (d2(x, y, hub.x, hub.y) < 100) continue;
        const dl = d2(x, y, lh.x, lh.y);
        const dk = d2(x, y, kh.x, kh.y);
        if (dl > max2 || dk > max2) continue;
        const score = Math.max(dl, dk);
        const prev = cand.get(t);
        if (prev === undefined || score < prev) cand.set(t, score);
      }
    }
  }
  return [...cand]
    .sort((p, q) => p[1] - q[1] || p[0] - q[0])
    .slice(0, 8)
    .map((e) => e[0]);
}

// ---------------------------------------------------------------------------------------------------------------
// Hash
// ---------------------------------------------------------------------------------------------------------------

/** Mixes the supply line state into the state hash: timers, sunk convoys, cut lists and every nation's link ends. */
export function hashSupplyLines(state: GameState, h: number, mixInt: (h: number, v: number) => number): number {
  const sn = state.supplyNet;
  if (!sn) return h;
  h = mixInt(h, 0x53504c4e);
  h = mixInt(h, sn.hubs.length);
  for (const v of sn.hubs) h = mixInt(h, v);
  h = mixInt(h, sn.sunk.length);
  for (const v of sn.sunk) h = mixInt(h, v);
  for (let pid = 0; pid < sn.cut.length; pid++) {
    const l = sn.cut[pid];
    if (!l) continue;
    h = mixInt(mixInt(h, pid), l.length);
    for (const v of l) h = mixInt(h, v);
  }
  h = mixInt(h, sn.version);
  const nets = netData.get(state);
  if (nets) {
    for (const pid of [...nets.byPlayer.keys()].sort((a, b) => a - b)) {
      const net = nets.byPlayer.get(pid) as Net;
      h = mixInt(mixInt(h, pid), net.links.length);
      for (const l of net.links) {
        h = mixInt(h, net.hubs[l.a].tile);
        h = mixInt(h, net.hubs[l.b].tile);
        h = mixInt(h, (l.sea ? 1 : 0) | (l.cut ? 2 : 0));
      }
    }
  }
  return h;
}
