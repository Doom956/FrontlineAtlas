// Which same-owner buildings are drawn as one place (client only, pure: no DOM, no random). Given the buildings and a
// terrain query it returns the connectors to draw UNDER the buildings: a quay between ports on the same coast, a trench
// between forts, a road with suburbs between cities, and (pairTracks) a thin dirt track from every other building to the
// owner's nearest city.
// It changes no game rule and no hit area. The result depends only on the buildings and the terrain, so the game can
// compute it per owner, bake it into tiles or per-pair sprites and rebuild only the pairs whose buildings changed.

import type { BuildingType } from '../../../sim/types';

/** The building types a link can start or end at (pairLinks joins ports, forts and cities; tracks start at any type). */
export type LinkType = BuildingType;
export type LinkKind = 'quay' | 'trench' | 'road' | 'track';

export interface LinkBuilding {
  id: number;
  type: LinkType;
  /** tile the building stands on (its anchor tile) */
  x: number;
  y: number;
  /** nation id (any number; 0 is nobody) */
  owner: number;
  level: number;
}

export interface LinkTerrain {
  water: (x: number, y: number) => boolean;
  /** nation that owns the land tile (0 none) */
  owner: (x: number, y: number) => number;
}

export interface BuildingLink {
  kind: LinkKind;
  /** ids of the two buildings: a < b for a chain link; for a track a is the building and b its city */
  a: number;
  b: number;
  /** quay: the polyline along the shore, in tile centres, from a to b; track: the winding route from a to b */
  path?: [number, number][];
  /** quay only: the path continued along the shore past each port (its own frontage), and the indices of the two ports in it */
  full?: [number, number][];
  core?: [number, number];
}

/** Longest connector, in tiles between the two anchors. */
export const LINK_MAX_DIST: Record<LinkKind, number> = { quay: 16, trench: 18, road: 20, track: 20 };
/** How many same-kind links one building takes (a chain, never a mesh). */
export const LINK_MAX_DEGREE = 2;
/** A quay needs this share of its path on the shore (land touching water). */
export const QUAY_MIN_SHORE = 0.6;
/** How far a quay runs on along the shore past each port, in tiles. */
export const QUAY_FRONTAGE = 7;

const dist = (a: LinkBuilding, b: LinkBuilding): number => Math.hypot(a.x - b.x, a.y - b.y);

/** The tile centres along a straight line between two tiles, every half tile. */
function samples(a: LinkBuilding, b: LinkBuilding): [number, number][] {
  const n = Math.max(1, Math.ceil(dist(a, b) * 2));
  const out: [number, number][] = [];
  for (let i = 0; i <= n; i++) out.push([a.x + ((b.x - a.x) * i) / n, a.y + ((b.y - a.y) * i) / n]);
  return out;
}

/** True when every sample is dry land of the owner (no water, no enemy or neutral land in between). */
function clear(pts: [number, number][], owner: number, t: LinkTerrain): boolean {
  for (const [x, y] of pts) {
    const tx = Math.floor(x);
    const ty = Math.floor(y);
    if (t.water(tx, ty) || t.owner(tx, ty) !== owner) return false;
  }
  return true;
}

const shoreTile = (x: number, y: number, t: LinkTerrain): boolean => !t.water(x, y) && (t.water(x + 1, y) || t.water(x - 1, y) || t.water(x, y + 1) || t.water(x, y - 1));

/**
 * The quay line between two ports: from each point of the straight line the nearest shore tile within 3 tiles, then
 * smoothed, ends pinned on the ports. `shore` is the share of points that found a shore tile.
 */
function snapShore(px: number, py: number, t: LinkTerrain, r: number): [number, number] | null {
  let best: [number, number] | null = null;
  let bd = 1e9;
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      const tx = Math.floor(px) + dx;
      const ty = Math.floor(py) + dy;
      if (!shoreTile(tx, ty, t)) continue;
      const d = Math.hypot(tx + 0.5 - px, ty + 0.5 - py);
      if (d < bd) {
        bd = d;
        best = [tx + 0.5, ty + 0.5];
      }
    }
  }
  return best;
}

/** The shore continued QUAY_FRONTAGE tiles from `end` in direction (dx, dy), stopping where there is no shore. */
function frontage(end: [number, number], dx: number, dy: number, t: LinkTerrain): [number, number][] {
  const out: [number, number][] = [];
  const len = Math.hypot(dx, dy) || 1;
  for (let i = 1; i <= QUAY_FRONTAGE; i++) {
    const q = snapShore(end[0] + (dx / len) * i, end[1] + (dy / len) * i, t, 2);
    if (!q) break;
    out.push(q);
  }
  return out;
}

export function quayPath(a: LinkBuilding, b: LinkBuilding, t: LinkTerrain): { path: [number, number][]; shore: number; full: [number, number][]; core: [number, number] } {
  const n = Math.max(2, Math.ceil(dist(a, b)));
  const raw: [number, number][] = [];
  let hits = 0;
  for (let i = 0; i <= n; i++) {
    const px = a.x + 0.5 + ((b.x - a.x) * i) / n;
    const py = a.y + 0.5 + ((b.y - a.y) * i) / n;
    const best = snapShore(px, py, t, 3);
    if (best) hits++;
    raw.push(best ?? [px, py]);
  }
  const path = raw.map((p, i): [number, number] => {
    if (i === 0) return [a.x + 0.5, a.y + 0.5];
    if (i === n) return [b.x + 0.5, b.y + 0.5];
    let sx = 0;
    let sy = 0;
    let c = 0;
    for (let k = -2; k <= 2; k++) {
      const q = raw[Math.max(0, Math.min(n, i + k))];
      sx += q[0];
      sy += q[1];
      c++;
    }
    return [sx / c, sy / c];
  });
  const ea = frontage(path[0], a.x - b.x, a.y - b.y, t).reverse();
  const eb = frontage(path[path.length - 1], b.x - a.x, b.y - a.y, t);
  return { path, shore: hits / (n + 1), full: [...ea, ...path, ...eb], core: [ea.length, ea.length + path.length - 1] };
}

/**
 * The connectors for a set of buildings. Rules: both buildings the same owner and the same kind (port-port, fort-fort,
 * city-city); within LINK_MAX_DIST tiles; every point between them dry land of that owner (never
 * across water or enemy land; ports instead follow a shore that is at least QUAY_MIN_SHORE of the way). Nearest pairs
 * first, each building takes at most LINK_MAX_DEGREE chain links. The result
 * is the same for any input order.
 */
export function pairLinks(buildings: readonly LinkBuilding[], t: LinkTerrain): BuildingLink[] {
  const bs = buildings.slice().sort((p, q) => p.id - q.id);
  const out: BuildingLink[] = [];
  const degree = new Map<number, number>();
  const take = (id: number): number => degree.get(id) ?? 0;
  const chains: [LinkType, LinkKind][] = [['port', 'quay'], ['fort', 'trench'], ['city', 'road']];
  for (const [type, kind] of chains) {
    const list = bs.filter((b) => b.type === type && b.owner !== 0);
    const cand: { a: LinkBuilding; b: LinkBuilding; d: number }[] = [];
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const d = dist(list[i], list[j]);
        if (list[i].owner === list[j].owner && d <= LINK_MAX_DIST[kind]) cand.push({ a: list[i], b: list[j], d });
      }
    }
    cand.sort((p, q) => p.d - q.d || p.a.id - q.a.id || p.b.id - q.b.id);
    for (const { a, b } of cand) {
      if (take(a.id) >= LINK_MAX_DEGREE || take(b.id) >= LINK_MAX_DEGREE) continue;
      if (kind === 'quay') {
        const q = quayPath(a, b, t);
        if (q.shore < QUAY_MIN_SHORE || !clear(q.path, a.owner, t)) continue;
        out.push({ kind, a: a.id, b: b.id, path: q.path, full: q.full, core: q.core });
      } else {
        if (!clear(samples(a, b), a.owner, t)) continue;
        out.push({ kind, a: a.id, b: b.id });
      }
      degree.set(a.id, take(a.id) + 1);
      degree.set(b.id, take(b.id) + 1);
    }
  }
  return out;
}

// ------------------------------------------------------------------------------------------------- dirt tracks

/** Path points per tile along a track (a smooth curve at any zoom the tracks show at). */
export const TRACK_STEPS_PER_TILE = 4;
/** Cities tried per building, nearest first, before it is left without a track. */
export const TRACK_CITY_TRIES = 3;
/** How far a track may swing off the straight line, in tiles: this share of its length plus a quarter, at most TRACK_MAX_SWING. */
export const TRACK_SWING = 0.085;
export const TRACK_MAX_SWING = 1.7;
/** The swings tried in turn when a route leaves the owner's dry land: full, mirrored, gentler, then straight. */
const TRACK_TRIES = [1, -1, 0.6, -0.6, 0.3, -0.3, 0];

/** Deterministic 0..1 from two ids and a salt (no Math.random): the same track for every player and every frame. */
function mix01(a: number, b: number, s: number): number {
  let h = (Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul(b | 0, 0x165667b1) ^ Math.imul(s, 0x9e3779b1)) | 0;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/**
 * The winding route of a dirt track from building `a` to building `b` (tile centres, a smooth meander pinned at both
 * ends), or null when no route of any swing stays on `a`'s owner's dry land. The bends come from the two ids and the
 * positions only, so the route is the same each time.
 */
export function trackPath(a: LinkBuilding, b: LinkBuilding, t: LinkTerrain): [number, number][] | null {
  const ax = a.x + 0.5;
  const ay = a.y + 0.5;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) return null;
  const nx = -dy / len;
  const ny = dx / len;
  const lo = Math.min(a.id, b.id);
  const hi = Math.max(a.id, b.id);
  const h = (s: number): number => mix01(lo * 31 + a.x * 7 + a.y, hi * 17 + b.x * 5 + b.y, s);
  // a slow bend (a wave every 8 to 14 tiles, never steeper than about 30 degrees), a small ripple on it and a slight bow
  // to one side, all fading to nothing at the two ends
  const l1 = 8 + 6 * h(1);
  const l2 = 2.6 + 1.6 * h(2);
  const p1 = h(3) * Math.PI * 2;
  const p2 = h(4) * Math.PI * 2;
  const a1 = Math.min(TRACK_MAX_SWING, TRACK_SWING * len + 0.25, (0.55 * l1) / (Math.PI * 2));
  const a2 = 0.05 + 0.06 * h(6);
  const bow = (h(5) - 0.5) * 0.6 * a1;
  const n = Math.max(4, Math.ceil(len * TRACK_STEPS_PER_TILE));
  const wave: number[] = [];
  for (let i = 0; i <= n; i++) {
    const u = i / n;
    const s = u * len;
    wave.push(Math.sin(Math.PI * u) * (a1 * Math.sin((Math.PI * 2 * s) / l1 + p1) + a2 * Math.sin((Math.PI * 2 * s) / l2 + p2) + bow));
  }
  for (const k of TRACK_TRIES) {
    const pts: [number, number][] = [];
    for (let i = 0; i <= n; i++) {
      const u = i / n;
      const off = wave[i] * k;
      pts.push([ax + dx * u + nx * off, ay + dy * u + ny * off]);
    }
    if (clear(pts, a.owner, t)) return pts;
  }
  return null;
}

/**
 * The dirt tracks of a set of buildings: every building that is not a city runs one track to the nearest city of its
 * owner within LINK_MAX_DIST.track tiles whose route stays on that owner's dry land (the next nearest, up to
 * TRACK_CITY_TRIES, when it cannot). No city in reach: no track. The result is the same for any input order.
 */
export function pairTracks(buildings: readonly LinkBuilding[], t: LinkTerrain): BuildingLink[] {
  const bs = buildings.slice().sort((p, q) => p.id - q.id);
  const cities = bs.filter((b) => b.type === 'city' && b.owner !== 0);
  const out: BuildingLink[] = [];
  if (!cities.length) return out;
  const max = LINK_MAX_DIST.track;
  for (const b of bs) {
    if (b.type === 'city' || b.owner === 0) continue;
    const near = cities
      .filter((c) => c.owner === b.owner && Math.abs(c.x - b.x) <= max && Math.abs(c.y - b.y) <= max)
      .map((c) => ({ c, d: dist(b, c) }))
      .filter((e) => e.d <= max && e.d > 0)
      .sort((p, q) => p.d - q.d || p.c.id - q.c.id)
      .slice(0, TRACK_CITY_TRIES);
    for (const { c } of near) {
      const path = trackPath(b, c, t);
      if (!path) continue;
      out.push({ kind: 'track', a: b.id, b: c.id, path });
      break;
    }
  }
  return out;
}
