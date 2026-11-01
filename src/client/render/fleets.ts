// Fleet markers: zoomed out, warships of one owner close together draw as ONE marker with a count badge
// (render/units.ts); zoomed in they are individual ships again. Clicking an own marker selects that fleet (input.ts).
// Single linkage: two ships of the same owner within FLEET_RADIUS tiles are in the same fleet (so a line of ships
// strung out a few tiles apart is one fleet). Grid buckets of the radius keep it linear in the number of ships.
// Client only, deterministic for the same input (ids order the members; the lowest id leads).

/** Ships closer than this (tiles) join one fleet. */
export const FLEET_RADIUS = 4;
/** Fleets are drawn as markers below this zoom (screen px per tile): 4 tiles are then under ~16 px apart. */
export const FLEET_ZOOM = 4;

export interface FleetPoint {
  id: number;
  owner: number;
  /** any unit as long as all points use the same one (tiles or screen px) */
  x: number;
  y: number;
}

export interface Fleet {
  owner: number;
  /** member ids, ascending */
  ids: number[];
  /** centre of the members */
  x: number;
  y: number;
}

/** Fleets of two or more ships (single ships are not returned), ordered by their lowest id. */
export function clusterFleets(pts: readonly FleetPoint[], radius: number): Fleet[] {
  const n = pts.length;
  if (n < 2 || radius <= 0) return [];
  const parent = new Int32Array(n);
  for (let i = 0; i < n; i++) parent[i] = i;
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  const r2 = radius * radius;
  const cell = new Map<number, number[]>();
  const key = (cx: number, cy: number): number => (cx + 32768) * 65536 + (cy + 32768);
  for (let i = 0; i < n; i++) {
    const p = pts[i];
    const cx = Math.floor(p.x / radius);
    const cy = Math.floor(p.y / radius);
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const list = cell.get(key(cx + dx, cy + dy));
        if (!list) continue;
        for (const j of list) {
          const q = pts[j];
          if (q.owner !== p.owner) continue;
          const ddx = q.x - p.x;
          const ddy = q.y - p.y;
          if (ddx * ddx + ddy * ddy > r2) continue;
          const a = find(i);
          const b = find(j);
          if (a !== b) parent[Math.max(a, b)] = Math.min(a, b);
        }
      }
    }
    const k = key(cx, cy);
    const l = cell.get(k);
    if (l) l.push(i);
    else cell.set(k, [i]);
  }
  const groups = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    const g = groups.get(r);
    if (g) g.push(i);
    else groups.set(r, [i]);
  }
  const out: Fleet[] = [];
  for (const g of groups.values()) {
    if (g.length < 2) continue;
    let sx = 0;
    let sy = 0;
    for (const i of g) {
      sx += pts[i].x;
      sy += pts[i].y;
    }
    out.push({ owner: pts[g[0]].owner, ids: g.map((i) => pts[i].id).sort((a, b) => a - b), x: sx / g.length, y: sy / g.length });
  }
  out.sort((a, b) => a.ids[0] - b.ids[0]);
  return out;
}
