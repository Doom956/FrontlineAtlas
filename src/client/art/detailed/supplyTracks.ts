// A nation's rail links as one laid track network (client only, pure: no DOM, no random, no clock). The sim gives each
// rail link its own tile route (sim/supplylines.ts supplyNetworkOf); routes to nearby hubs share corridors, so drawn one
// by one they double up and cross each other. Here they are laid as one network the way a railway is built:
//   1. corridor   links are laid shortest first; a route tile within two tiles of track already laid snaps onto it, so
//                 a later route joins the existing line (a switch) instead of running beside it. The result is a graph
//                 of tiles; a small loop the snapping would make is closed through the track already there.
//   2. tracks     the graph splits at hubs and at switches; at a switch the two most nearly straight pieces run on as
//                 one through line and the third is a branch.
//   3. alignment  each track is pulled toward easy ground (away from hills, mountains, forest and swamp), simplified
//                 (Ramer-Douglas-Peucker: long straight runs over open land, a bend only where the straight run would
//                 cross water or rougher ground than the route did), and its corners eased into wide curves (radius
//                 up to CURVE_R tiles), so it reads as a railway: long gentle curves and straight runs, no wiggle.
//   4. switches   a branch's last tiles bend in to leave the through line along its heading.
// Every track runs from hub centre to hub centre (under the buildings, as a station spur) or into a switch. Each link
// gets the path its trains run on: the pieces of the tracks along its corridor, end to end.
import { pathLength, pointAt, type P } from './supplyLines';

/** One rail link of the sim: hub tiles a and b, and its route (tile ids from a to b). */
export interface TrackLink {
  a: number;
  b: number;
  tiles: ArrayLike<number>;
}

/** A laid track: its tile chain and the smooth line drawn (tile coordinates). */
export interface Track {
  /** a stable id: the end tiles and a hash of the chain */
  id: string;
  /** the two end tiles (hubs, or a switch on another track) */
  a: number;
  b: number;
  /** whether each end is a hub (a station under a building) */
  hubA: boolean;
  hubB: boolean;
  nodes: number[];
  path: P[];
}

export interface TrackNet {
  tracks: Track[];
  /** per link (input order): the path its trains run on from hub a to hub b, or null when none */
  paths: (P[] | null)[];
}

/** Snap radius (tiles) onto a track already laid. */
const SNAP = 2;
/** Widest curve radius (tiles). */
const CURVE_R = 10;
const WATER = (t: number): boolean => t <= 1;
/** How rough a terrain is to lay a rail on (the alignment keeps off rough ground). */
function rough(t: number): number {
  switch (t) {
    case 5: return 4;
    case 7: return 3;
    case 4: return 1.6;
    case 3: return 0.7;
    default: return t <= 1 ? 5 : 0;
  }
}

const centre = (t: number, w: number): P => [(t % w) + 0.5, ((t / w) | 0) + 0.5];
const edgeKey = (u: number, v: number): number => (u < v ? u * 4194304 + v : v * 4194304 + u);

/** Ramer-Douglas-Peucker with a terrain test: a straight run stands when it keeps within `eps` and `fine` accepts it. */
function simplify(pts: readonly P[], eps: number, fine: (i: number, j: number) => boolean): P[] {
  const keep = new Uint8Array(pts.length);
  keep[0] = 1;
  keep[pts.length - 1] = 1;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length) {
    const [i, j] = stack.pop() as [number, number];
    if (j <= i + 1) continue;
    const [ax, ay] = pts[i];
    const [bx, by] = pts[j];
    const dx = bx - ax;
    const dy = by - ay;
    const L = Math.hypot(dx, dy) || 1e-9;
    let worst = -1;
    let at = -1;
    for (let k = i + 1; k < j; k++) {
      const d = Math.abs((pts[k][0] - ax) * dy - (pts[k][1] - ay) * dx) / L;
      if (d > worst) (worst = d, at = k);
    }
    if (worst > eps || !fine(i, j)) {
      keep[at] = 1;
      stack.push([i, at], [at, j]);
    }
  }
  const out: P[] = [];
  for (let k = 0; k < pts.length; k++) if (keep[k]) out.push(pts[k]);
  return out;
}

/** Corners eased into curves: each corner becomes a quadratic curve whose ends sit up to CURVE_R * tan(turn / 2) back along its legs. */
function ease(pts: readonly P[], R: number): P[] {
  if (pts.length < 3) return pts.slice();
  const n = pts.length;
  const len: number[] = [];
  for (let i = 0; i + 1 < n; i++) len.push(Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]));
  const out: P[] = [pts[0]];
  for (let i = 1; i + 1 < n; i++) {
    const [vx, vy] = pts[i];
    const l1 = len[i - 1];
    const l2 = len[i];
    if (l1 < 1e-6 || l2 < 1e-6) continue;
    const u1x = (vx - pts[i - 1][0]) / l1;
    const u1y = (vy - pts[i - 1][1]) / l1;
    const u2x = (pts[i + 1][0] - vx) / l2;
    const u2y = (pts[i + 1][1] - vy) / l2;
    const turn = Math.acos(Math.max(-1, Math.min(1, u1x * u2x + u1y * u2y)));
    if (turn < 0.01) {
      out.push([vx, vy]);
      continue;
    }
    const room1 = i - 1 === 0 ? l1 * 0.9 : l1 * 0.5;
    const room2 = i + 1 === n - 1 ? l2 * 0.9 : l2 * 0.5;
    const d = Math.min(R * Math.tan(Math.min(turn, 2.6) / 2), room1, room2);
    const ax = vx - u1x * d;
    const ay = vy - u1y * d;
    const bx = vx + u2x * d;
    const by = vy + u2y * d;
    const steps = Math.max(2, Math.ceil((d * 2) / 0.35));
    for (let k = 0; k <= steps; k++) {
      const t = k / steps;
      const s = 1 - t;
      out.push([s * s * ax + 2 * s * t * vx + t * t * bx, s * s * ay + 2 * s * t * vy + t * t * by]);
    }
  }
  out.push(pts[n - 1]);
  const clean: P[] = [out[0]];
  for (const q of out) {
    const l = clean[clean.length - 1];
    if (Math.hypot(q[0] - l[0], q[1] - l[1]) > 1e-4) clean.push(q);
  }
  if (clean.length < 2) clean.push(pts[n - 1]);
  return clean;
}

/** The closest point (arc length) to q on a polyline, searched from segment `from` on. */
function project(path: readonly P[], q: P, from = 0, to = path.length - 1): { s: number; seg: number; d: number } {
  let best = { s: 0, seg: from, d: Infinity };
  let cum = 0;
  for (let i = 0; i < from; i++) cum += Math.hypot(path[i + 1][0] - path[i][0], path[i + 1][1] - path[i][1]);
  for (let i = from; i < to; i++) {
    const [ax, ay] = path[i];
    const dx = path[i + 1][0] - ax;
    const dy = path[i + 1][1] - ay;
    const L = Math.hypot(dx, dy);
    const t = L > 0 ? Math.max(0, Math.min(1, ((q[0] - ax) * dx + (q[1] - ay) * dy) / (L * L))) : 0;
    const d = Math.hypot(ax + dx * t - q[0], ay + dy * t - q[1]);
    if (d < best.d - 1e-9) best = { s: cum + L * t, seg: i, d };
    cum += L;
  }
  return best;
}

/** The piece of a polyline between arc lengths s0 and s1 (reversed when s1 < s0). */
export function subPath(path: readonly P[], s0: number, s1: number): P[] {
  if (s1 < s0) return subPath(path, s1, s0).reverse();
  const out: P[] = [];
  const a = pointAt(path, s0);
  out.push([a.x, a.y]);
  let cum = 0;
  for (let i = 0; i + 1 < path.length; i++) {
    const L = Math.hypot(path[i + 1][0] - path[i][0], path[i + 1][1] - path[i][1]);
    const end = cum + L;
    if (end > s0 + 1e-6 && end < s1 - 1e-6) out.push([path[i + 1][0], path[i + 1][1]]);
    cum = end;
  }
  const b = pointAt(path, s1);
  out.push([b.x, b.y]);
  return out;
}

/**
 * The rail links of one nation laid as one track network (see the header). `terrain` is the terrain id of a tile
 * (off the map: water); `own` the land a straight run may cross (the owner's). Deterministic: the same links give the same tracks. Pure.
 */
export function layTracks(links: readonly TrackLink[], w: number, terrain: (x: number, y: number) => number, own: (x: number, y: number) => boolean = () => true): TrackNet {
  const ter = (t: number): number => terrain(t % w, (t / w) | 0);
  const hubs = new Set<number>();
  for (const l of links) (hubs.add(l.a), hubs.add(l.b));
  const adj = new Map<number, number[]>();
  const link = (u: number, v: number): void => {
    let x = adj.get(u);
    if (!x) adj.set(u, (x = []));
    if (!x.includes(v)) x.push(v);
    let y = adj.get(v);
    if (!y) adj.set(v, (y = []));
    if (!y.includes(u)) y.push(u);
  };
  /** a short way between two laid tiles over the graph (at most `hops` steps), or null */
  const shortWay = (u: number, v: number, hops: number): number[] | null => {
    if (!adj.has(u) || !adj.has(v)) return null;
    const prev = new Map<number, number>([[u, -1]]);
    let front = [u];
    for (let h = 0; h < hops && front.length; h++) {
      const next: number[] = [];
      for (const x of front) {
        for (const y of adj.get(x) as number[]) {
          if (prev.has(y)) continue;
          prev.set(y, x);
          if (y === v) {
            const way = [v];
            for (let c = x; c !== -1; c = prev.get(c) as number) way.push(c);
            return way.reverse();
          }
          next.push(y);
        }
      }
      front = next;
    }
    return null;
  };
  const wetRoute = new Set<number>();
  const order = links.map((_, i) => i).sort((i, j) => links[i].tiles.length - links[j].tiles.length || links[i].a - links[j].a || links[i].b - links[j].b);
  const chains: (number[] | null)[] = links.map(() => null);
  for (const li of order) {
    const { tiles } = links[li];
    const n = tiles.length;
    if (n < 2) continue;
    // 1. snap onto the track already laid
    const snapped: number[] = [];
    for (let i = 0; i < n; i++) {
      const t = tiles[i];
      if (WATER(ter(t))) wetRoute.add(t);
      let s = t;
      if (i > 0 && i < n - 1 && !adj.has(t)) {
        const tx = t % w;
        const ty = (t / w) | 0;
        const wet = WATER(ter(t));
        let bd = Infinity;
        for (let dy = -SNAP; dy <= SNAP; dy++) {
          for (let dx = -SNAP; dx <= SNAP; dx++) {
            const d = dx * dx + dy * dy;
            if (d === 0 || d > SNAP * SNAP + 1 || d > bd) continue;
            const c = (ty + dy) * w + tx + dx;
            if (tx + dx < 0 || tx + dx >= w || !adj.has(c) || WATER(ter(c)) !== wet) continue;
            if (d < bd || c < s) (bd = d, s = c);
          }
        }
      }
      if (snapped[snapped.length - 1] !== s) snapped.push(s);
    }
    // 2. join the pieces, closing short loops through the track already there, then erase any loop left
    const chain: number[] = [snapped[0]];
    for (let i = 1; i < snapped.length; i++) {
      const u = chain[chain.length - 1];
      const v = snapped[i];
      if (u === v) continue;
      if (adj.get(u)?.includes(v)) {
        chain.push(v);
        continue;
      }
      const way = shortWay(u, v, 6);
      if (way) chain.push(...way.slice(1));
      else {
        link(u, v);
        chain.push(v);
      }
    }
    const seen = new Map<number, number>();
    const erased: number[] = [];
    for (const c of chain) {
      const at = seen.get(c);
      if (at !== undefined) {
        for (let k = at + 1; k < erased.length; k++) seen.delete(erased[k]);
        erased.length = at + 1;
        continue;
      }
      seen.set(c, erased.length);
      erased.push(c);
    }
    if (erased.length < 2) {
      erased.push(snapped[snapped.length - 1]);
      link(erased[0], erased[1]);
    }
    chains[li] = erased;
  }
  // 3. the graph's pieces between hubs and switches
  const isJoint = (t: number): boolean => hubs.has(t) || (adj.get(t)?.length ?? 0) !== 2;
  const used = new Set<number>();
  const pieces: number[][] = [];
  const walk = (start: number, first: number): number[] => {
    const out = [start, first];
    used.add(edgeKey(start, first));
    let prev = start;
    let cur = first;
    while (!isJoint(cur)) {
      const nx = (adj.get(cur) as number[]).find((x) => x !== prev) as number;
      if (used.has(edgeKey(cur, nx))) break;
      used.add(edgeKey(cur, nx));
      out.push(nx);
      prev = cur;
      cur = nx;
    }
    return out;
  };
  const nodes = [...adj.keys()].sort((p, q) => p - q);
  for (const j of nodes) {
    if (!isJoint(j)) continue;
    for (const nb of (adj.get(j) as number[]).slice().sort((p, q) => p - q)) if (!used.has(edgeKey(j, nb))) pieces.push(walk(j, nb));
  }
  for (const j of nodes) for (const nb of (adj.get(j) as number[]).slice().sort((p, q) => p - q)) if (!used.has(edgeKey(j, nb))) pieces.push(walk(j, nb));
  // through lines at a switch: the two most nearly opposite pieces run on as one
  const heading = (pc: readonly number[], fromEnd: boolean): P => {
    const seq = fromEnd ? pc.slice().reverse() : pc;
    const [x0, y0] = centre(seq[0], w);
    let q = centre(seq[seq.length - 1], w);
    for (const t of seq) {
      const c = centre(t, w);
      if (Math.hypot(c[0] - x0, c[1] - y0) >= 7) {
        q = c;
        break;
      }
    }
    const L = Math.hypot(q[0] - x0, q[1] - y0) || 1;
    return [(q[0] - x0) / L, (q[1] - y0) / L];
  };
  const ends = new Map<number, { piece: number; end: 0 | 1 }[]>();
  pieces.forEach((pc, i) => {
    for (const end of [0, 1] as const) {
      const t = end ? pc[pc.length - 1] : pc[0];
      if (hubs.has(t)) continue;
      let e = ends.get(t);
      if (!e) ends.set(t, (e = []));
      e.push({ piece: i, end });
    }
  });
  const partner = new Map<string, { piece: number; end: 0 | 1 }>();
  const pk = (p: number, e: number): string => `${p}:${e}`;
  /** switches: tile -> the through line's two piece ends */
  const throughAt = new Map<number, string[]>();
  for (const [t, e] of [...ends].sort((p, q) => p[0] - q[0])) {
    if (e.length < 2) continue;
    const pairs: [number, number, number][] = [];
    for (let i = 0; i < e.length; i++) {
      for (let k = i + 1; k < e.length; k++) {
        if (e[i].piece === e[k].piece) continue;
        const hi = heading(pieces[e[i].piece], e[i].end === 1);
        const hk = heading(pieces[e[k].piece], e[k].end === 1);
        pairs.push([hi[0] * hk[0] + hi[1] * hk[1], i, k]);
      }
    }
    pairs.sort((p, q) => p[0] - q[0] || p[1] - q[1] || p[2] - q[2]);
    const taken = new Set<number>();
    for (const [c, i, k] of pairs) {
      if (c > -0.5 || taken.has(i) || taken.has(k)) continue;
      taken.add(i);
      taken.add(k);
      partner.set(pk(e[i].piece, e[i].end), e[k]);
      partner.set(pk(e[k].piece, e[k].end), e[i]);
      if (!throughAt.has(t)) throughAt.set(t, [pk(e[i].piece, e[i].end), pk(e[k].piece, e[k].end)]);
    }
  }
  // chain the pieces into tracks
  const pieceUsed = new Uint8Array(pieces.length);
  const chainsOfTracks: number[][] = [];
  const orient = (i: number, fromEnd: 0 | 1): number[] => (fromEnd ? pieces[i].slice().reverse() : pieces[i].slice());
  for (let i = 0; i < pieces.length; i++) {
    if (pieceUsed[i]) continue;
    // go back to the start of this through line
    let p = i;
    let startEnd: 0 | 1 = 0;
    const guard = new Set<number>([p]);
    for (;;) {
      const back = partner.get(pk(p, startEnd));
      if (!back || guard.has(back.piece) || pieceUsed[back.piece]) break;
      guard.add(back.piece);
      p = back.piece;
      startEnd = back.end === 0 ? 1 : 0;
    }
    const seq: number[] = [];
    let cur = p;
    let from: 0 | 1 = startEnd;
    for (;;) {
      pieceUsed[cur] = 1;
      const part = orient(cur, from);
      seq.push(...(seq.length ? part.slice(1) : part));
      const exit: 0 | 1 = from === 0 ? 1 : 0;
      const nx = partner.get(pk(cur, exit));
      if (!nx || pieceUsed[nx.piece]) break;
      cur = nx.piece;
      from = nx.end;
    }
    chainsOfTracks.push(seq);
  }
  // 4. the alignment of each track
  const tracks: Track[] = chainsOfTracks.map((seq) => {
    const pts = seq.map((t) => centre(t, w));
    // pulled a little toward easy ground, across the line only (the ends stay)
    for (let i = 1; i + 1 < pts.length; i++) {
      const t = seq[i];
      const tx = t % w;
      const ty = (t / w) | 0;
      let gx = 0;
      let gy = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (dx || dy) {
        const r = rough(terrain(tx + dx, ty + dy));
        gx -= dx * r;
        gy -= dy * r;
      }
      const tdx = pts[i + 1][0] - pts[i - 1][0];
      const tdy = pts[i + 1][1] - pts[i - 1][1];
      const tl = Math.hypot(tdx, tdy) || 1;
      const nx = -tdy / tl;
      const ny = tdx / tl;
      const push = Math.max(-0.45, Math.min(0.45, (gx * nx + gy * ny) * 0.08));
      const qx = pts[i][0] + nx * push;
      const qy = pts[i][1] + ny * push;
      if (!WATER(terrain(Math.floor(qx), Math.floor(qy))) || WATER(ter(t))) pts[i] = [qx, qy];
    }
    const roughAt = (x: number, y: number): number => rough(terrain(Math.floor(x), Math.floor(y)));
    /** a straight run is fine when it crosses no water the route did not, and no rougher ground than the route on average */
    const fine = (i: number, j: number): boolean => {
      let along = 0;
      for (let k = i; k <= j; k++) along += rough(ter(seq[k]));
      along /= j - i + 1;
      const [ax, ay] = pts[i];
      const [bx, by] = pts[j];
      const m = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) * 3));
      let sum = 0;
      for (let k = 0; k <= m; k++) {
        const x = ax + ((bx - ax) * k) / m;
        const y = ay + ((by - ay) * k) / m;
        const tt = terrain(Math.floor(x), Math.floor(y));
        if (WATER(tt) ? !wetRoute.has(Math.floor(y) * w + Math.floor(x)) : !own(Math.floor(x), Math.floor(y))) return false;
        sum += WATER(tt) ? 0 : roughAt(x, y);
      }
      return sum / (m + 1) <= along + 0.35;
    };
    const dryOk = (path: readonly P[]): boolean => {
      const L = pathLength(path);
      for (let s = 0; s <= L; s += 0.25) {
        const q = pointAt(path, s);
        const tx = Math.floor(q.x);
        const ty = Math.floor(q.y);
        if (!WATER(terrain(tx, ty))) continue;
        let near = false;
        for (let dy = -1; dy <= 1 && !near; dy++) for (let dx = -1; dx <= 1 && !near; dx++) near = wetRoute.has((ty + dy) * w + tx + dx);
        if (!near) return false;
      }
      return true;
    };
    let path: P[] = pts;
    for (const [eps, R] of [[2.6, CURVE_R], [1.4, CURVE_R * 0.6], [0.7, 3], [0.4, 1.5]] as const) {
      const cand = ease(simplify(pts, eps, fine), R);
      if (dryOk(cand)) {
        path = cand;
        break;
      }
    }
    const a = seq[0];
    const b = seq[seq.length - 1];
    let h = seq.length;
    for (const t of seq) h = (Math.imul(h, 31) + t) | 0;
    return { id: `${a}-${b}-${(h >>> 0).toString(36)}`, a, b, hubA: hubs.has(a), hubB: hubs.has(b), nodes: seq, path };
  });
  // where each node of each track lies along its drawn line
  const at: number[][] = tracks.map((tr) => {
    const out: number[] = [];
    let seg = 0;
    const L = pathLength(tr.path);
    tr.nodes.forEach((t, i) => {
      if (i === 0) return out.push(0);
      if (i === tr.nodes.length - 1) return out.push(L);
      const p = project(tr.path, centre(t, w), seg, Math.min(tr.path.length - 1, seg + 60));
      seg = p.seg;
      out.push(Math.max(out[out.length - 1], p.s));
    });
    return out;
  });
  // 5. a branch bends in to leave the through line along its heading
  const trackOfEnd = new Map<string, number>();
  tracks.forEach((tr, i) => {
    trackOfEnd.set(`${tr.a}|${tr.id}|0`, i);
    trackOfEnd.set(`${tr.b}|${tr.id}|1`, i);
  });
  const nodeIn = new Map<number, { track: number; idx: number }[]>();
  tracks.forEach((tr, ti) => tr.nodes.forEach((t, idx) => {
    if (idx === 0 || idx === tr.nodes.length - 1) return;
    let e = nodeIn.get(t);
    if (!e) nodeIn.set(t, (e = []));
    e.push({ track: ti, idx });
  }));
  tracks.forEach((tr, ti) => {
    for (const end of [0, 1] as const) {
      const j = end ? tr.b : tr.a;
      if (hubs.has(j)) continue;
      const host = (nodeIn.get(j) ?? []).find((e) => e.track !== ti);
      if (!host) continue;
      const main = tracks[host.track];
      const Lm = pathLength(main.path);
      const sj = at[host.track][host.idx];
      const C = pointAt(main.path, sj);
      const back = pointAt(main.path, Math.max(0, sj - 0.5));
      const fwd = pointAt(main.path, Math.min(Lm, sj + 0.5));
      let Tx = fwd.x - back.x;
      let Ty = fwd.y - back.y;
      const Tl = Math.hypot(Tx, Ty) || 1;
      Tx /= Tl;
      Ty /= Tl;
      const path = end ? tr.path : tr.path.slice().reverse();
      const L = pathLength(path);
      if (L < 2.5) continue;
      const cut = Math.max(L * 0.45, L - 4);
      const Pc = pointAt(path, cut);
      const dirx = C.x - Pc.x;
      const diry = C.y - Pc.y;
      const sgn = Tx * dirx + Ty * diry >= 0 ? 1 : -1;
      const m = Math.hypot(dirx, diry);
      const h0x = Math.cos(Pc.angle) * m;
      const h0y = Math.sin(Pc.angle) * m;
      const h1x = Tx * sgn * m;
      const h1y = Ty * sgn * m;
      const head = subPath(path, 0, cut);
      const steps = Math.max(4, Math.ceil(m / 0.3));
      for (let k = 1; k <= steps; k++) {
        const t = k / steps;
        const t2 = t * t;
        const t3 = t2 * t;
        const a0 = 2 * t3 - 3 * t2 + 1;
        const a1 = t3 - 2 * t2 + t;
        const a2 = -2 * t3 + 3 * t2;
        const a3 = t3 - t2;
        head.push([a0 * Pc.x + a1 * h0x + a2 * C.x + a3 * h1x, a0 * Pc.y + a1 * h0y + a2 * C.y + a3 * h1y]);
      }
      tr.path = end ? head : head.reverse();
      // the nodes keep their places along the new line (the tail ones settle on its end)
      const Ln = pathLength(tr.path);
      const ats = at[ti];
      if (end) ats[ats.length - 1] = Ln;
      else {
        const shift = Ln - L;
        for (let k = 1; k < ats.length; k++) ats[k] = Math.max(0, ats[k] + shift);
        ats[0] = 0;
      }
    }
  });
  void trackOfEnd;
  // 6. each link's train path: the pieces of the tracks along its chain
  const edgeAt = new Map<number, { track: number; idx: number }>();
  tracks.forEach((tr, ti) => {
    for (let i = 0; i + 1 < tr.nodes.length; i++) edgeAt.set(edgeKey(tr.nodes[i], tr.nodes[i + 1]), { track: ti, idx: i });
  });
  const paths = chains.map((chain) => {
    if (!chain) return null;
    const out: P[] = [];
    let i = 0;
    while (i + 1 < chain.length) {
      const e = edgeAt.get(edgeKey(chain[i], chain[i + 1]));
      if (!e) {
        const q = centre(chain[i + 1], w);
        out.push(q);
        i++;
        continue;
      }
      const tr = tracks[e.track];
      const fwd = tr.nodes[e.idx] === chain[i];
      let k = fwd ? e.idx : e.idx + 1;
      const s0 = at[e.track][k];
      let j = i;
      // run on along the same track
      for (;;) {
        const nk = fwd ? k + 1 : k - 1;
        if (nk < 0 || nk >= tr.nodes.length || chain[j + 1] !== tr.nodes[nk]) break;
        k = nk;
        j++;
        if (j + 1 >= chain.length) break;
      }
      const piece = subPath(tr.path, s0, at[e.track][k]);
      out.push(...(out.length ? piece.slice(1) : piece));
      i = j;
    }
    // the ends are the hub centres exactly
    if (out.length) {
      out[0] = centre(chain[0], w);
      out[out.length - 1] = centre(chain[chain.length - 1], w);
    }
    const clean: P[] = [];
    for (const q of out) {
      const l = clean[clean.length - 1];
      if (!l || Math.hypot(q[0] - l[0], q[1] - l[1]) > 1e-6) clean.push(q);
    }
    return clean.length >= 2 ? clean : null;
  });
  return { tracks, paths };
}
