// Which same-owner buildings are drawn as one place (client only, pure: no DOM, no random). Given the buildings and a
// terrain query it returns the connectors to draw UNDER the buildings: a quay between ports on the same coast, a trench
// between forts, a road with suburbs between cities, and a perimeter fence round a SAM site and the fort it stands by.
// It changes no game rule and no hit area. The result depends only on the buildings and the terrain, so the game can
// compute it per owner, bake it into tiles or per-pair sprites and rebuild only the pairs whose buildings changed.

export type LinkType = 'fort' | 'city' | 'sam' | 'port';
export type LinkKind = 'quay' | 'trench' | 'road' | 'perimeter';

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
  /** ids of the two buildings, a < b for a chain link; for a perimeter a is the SAM site and b the fort */
  a: number;
  b: number;
  /** quay only: the polyline along the shore, in tile centres, from a to b */
  path?: [number, number][];
  /** quay only: the path continued along the shore past each port (its own frontage), and the indices of the two ports in it */
  full?: [number, number][];
  core?: [number, number];
}

/** Longest connector, in tiles between the two anchors. */
export const LINK_MAX_DIST: Record<LinkKind, number> = { quay: 16, trench: 18, road: 20, perimeter: 12 };
/** How many same-kind links one building takes (a chain, never a mesh). A SAM site joins one fort. */
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
 * city-city) or a SAM site and a fort; within LINK_MAX_DIST tiles; every point between them dry land of that owner (never
 * across water or enemy land; ports instead follow a shore that is at least QUAY_MIN_SHORE of the way). Nearest pairs
 * first, each building takes at most LINK_MAX_DEGREE chain links and a SAM site joins only its nearest fort. The result
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
  // a SAM site beside a fort of its owner sits inside the fort's perimeter
  for (const s of bs.filter((b) => b.type === 'sam' && b.owner !== 0)) {
    let best: LinkBuilding | null = null;
    let bd = 1e9;
    for (const f of bs) {
      if (f.type !== 'fort' || f.owner !== s.owner) continue;
      const d = dist(s, f);
      if (d <= LINK_MAX_DIST.perimeter && d < bd && clear(samples(s, f), s.owner, t)) {
        bd = d;
        best = f;
      }
    }
    if (best) out.push({ kind: 'perimeter', a: s.id, b: best.id });
  }
  return out;
}
