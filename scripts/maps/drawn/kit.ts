// Toolkit for hand-drawn (fictional) maps. A drawn map is authored on a flat "plane": u east, v north, one unit about
// 111 km, origin at the centre of the map box. `makePlane` turns plane points into lon / lat (an equirectangular frame
// around a chosen latitude, so the climate rules of terrain.ts see a normal mid-latitude band and shapes keep their
// proportions). Shapes are built in code with a seeded RNG of our own, so coastlines look natural, not polygonal.
//
// To add a drawn map: copy drawn/<an existing id>.ts, change the shapes and the seed, import it in defs.ts and spread
// `plane.def` into the MapDef (see the first drawn map there). All shape helpers return plane points ([u, v][]); wrap a
// ring with `plane.ring(...)` (or use `plane.P` for single points) before putting it into the DrawnMap.
import type { ExtraRegion } from '../extra';
import type { PaintDef } from '../terrain';
import { makeRng } from '../lib';
import type { LonLatBox, ProjDef } from '../lib';

export interface DrawnMap {
  /** land polygons ([lon, lat] rings), mainland and islands; each is filled on its own (do not rely on holes) */
  land: number[][][];
  /** lakes: carved out of the land */
  lakes: number[][][];
  /** rivers as lon / lat polylines (fertile banks, green valleys through desert) */
  rivers: number[][][];
  /** hand-drawn relief and biome regions, same kinds as extra.ts */
  regions: ExtraRegion[];
  /** rough oil provinces (extra oil on top of the desert / swamp / tundra rule) */
  oilZones?: number[][][];
  /** terrain forced onto the finished map, in order (walls, gates, roads) */
  paint?: PaintDef[];
}

export type Pt = [number, number];

export interface Plane {
  /** the MapDef fields that come from the plane: proj and frame */
  def: { proj: ProjDef; frame: LonLatBox };
  /** plane point -> [lon, lat] */
  P(u: number, v: number): number[];
  /** plane ring -> lon / lat ring */
  ring(pts: Pt[]): number[][];
}

/** A plane `w` x `h` units centred on latitude `lat0` (the climate belt of the map). */
export function makePlane(w: number, h: number, lat0: number): Plane {
  const k = Math.cos((lat0 * Math.PI) / 180);
  const P = (u: number, v: number): number[] => [u / k, lat0 + v];
  return {
    def: {
      proj: { type: 'eqc', lon0: 0, latTs: lat0 },
      frame: { west: -w / 2 / k, east: w / 2 / k, south: lat0 - h / 2, north: lat0 + h / 2 },
    },
    P,
    ring: (pts) => pts.map(([u, v]) => P(u, v)),
  };
}

/** Smooth periodic function of the angle with values about -1..1 (a few random harmonics). */
export function wobbler(rng: () => number, harmonics = 5, lowest = 2): (theta: number) => number {
  const hs: { f: number; a: number; ph: number }[] = [];
  let norm = 0;
  for (let k = 0; k < harmonics; k++) {
    const f = lowest + k;
    const a = 1 / (1 + k * 0.6);
    hs.push({ f, a, ph: rng() * Math.PI * 2 });
    norm += a;
  }
  return (t) => {
    let s = 0;
    for (const h of hs) s += h.a * Math.sin(h.f * t + h.ph);
    return s / norm;
  };
}

/** A closed blob: an ellipse (rx, ry, rotated by `rot` radians) whose radius is wobbled by `wobble` (0.1 = +-10 %). */
export function blob(cx: number, cy: number, rx: number, ry: number, rng: () => number, wobble = 0.12, rot = 0, n = 120): Pt[] {
  const w = wobbler(rng, 6, 2);
  const out: Pt[] = [];
  const c = Math.cos(rot);
  const s = Math.sin(rot);
  for (let i = 0; i < n; i++) {
    const t = (i / n) * Math.PI * 2;
    const f = 1 + wobble * w(t);
    const x = Math.cos(t) * rx * f;
    const y = Math.sin(t) * ry * f;
    out.push([cx + x * c - y * s, cy + x * s + y * c]);
  }
  return out;
}

/** Midpoint displacement along every side of a closed polygon: a rough, fractal coastline. */
export function fractal(poly: Pt[], rng: () => number, rough = 0.25, depth = 5, minStep = 0.05): Pt[] {
  let cur = poly;
  let amp = rough;
  for (let d = 0; d < depth; d++) {
    const next: Pt[] = [];
    for (let i = 0; i < cur.length; i++) {
      const a = cur[i];
      const b = cur[(i + 1) % cur.length];
      next.push(a);
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (len < minStep) continue;
      const off = (rng() - 0.5) * 2 * amp * len;
      next.push([(a[0] + b[0]) / 2 + (-(b[1] - a[1]) / len) * off, (a[1] + b[1]) / 2 + ((b[0] - a[0]) / len) * off]);
    }
    cur = next;
    amp *= 0.62;
  }
  return cur;
}

/** Densifies a polygon given by its corners: `step` units between points. */
export function dense(poly: Pt[], step = 0.2): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const k = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / step));
    for (let q = 0; q < k; q++) out.push([a[0] + ((b[0] - a[0]) * q) / k, a[1] + ((b[1] - a[1]) * q) / k]);
  }
  return out;
}

/** A smooth closed curve through the given control points (Catmull-Rom), for drawing a continent by its outline. */
export function smoothClosed(ctrl: Pt[], per = 12): Pt[] {
  const n = ctrl.length;
  const out: Pt[] = [];
  for (let i = 0; i < n; i++) {
    const p0 = ctrl[(i + n - 1) % n];
    const p1 = ctrl[i];
    const p2 = ctrl[(i + 1) % n];
    const p3 = ctrl[(i + 2) % n];
    for (let q = 0; q < per; q++) {
      const t = q / per;
      const t2 = t * t;
      const t3 = t2 * t;
      const f = (a: number, b: number, c: number, d: number): number => 0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
      out.push([f(p0[0], p1[0], p2[0], p3[0]), f(p0[1], p1[1], p2[1], p3[1])]);
    }
  }
  return out;
}

/** A thick polyline as a polygon (a river bank, a road, a ridge): `half` = half width in units. */
export function strip(line: Pt[], half: number): Pt[] {
  const left: Pt[] = [];
  const right: Pt[] = [];
  for (let i = 0; i < line.length; i++) {
    const a = line[Math.max(0, i - 1)];
    const b = line[Math.min(line.length - 1, i + 1)];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    const nx = -(b[1] - a[1]) / len;
    const ny = (b[0] - a[0]) / len;
    left.push([line[i][0] + nx * half, line[i][1] + ny * half]);
    right.push([line[i][0] - nx * half, line[i][1] - ny * half]);
  }
  return left.concat(right.reverse());
}

/** Points along a wobbling path from a to b (a river, a range, a road): `bend` = sideways swing in units. */
export function path(a: Pt, b: Pt, rng: () => number, bend = 0.5, n = 40): Pt[] {
  const w = wobbler(rng, 4, 1);
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
  const nx = -(b[1] - a[1]) / len;
  const ny = (b[0] - a[0]) / len;
  const out: Pt[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const off = bend * w(t * Math.PI * 2) * Math.sin(Math.PI * t);
    out.push([a[0] + (b[0] - a[0]) * t + nx * off, a[1] + (b[1] - a[1]) * t + ny * off]);
  }
  return out;
}

/** Island chain: `count` blobs scattered along a path, radii between rmin and rmax. */
export function islandChain(line: Pt[], count: number, rmin: number, rmax: number, rng: () => number, spread = 0.4): Pt[][] {
  const out: Pt[][] = [];
  for (let i = 0; i < count; i++) {
    const t = count === 1 ? 0.5 : i / (count - 1);
    const at = line[Math.min(line.length - 1, Math.round(t * (line.length - 1)))];
    const r = rmin + (rmax - rmin) * rng();
    const cx = at[0] + (rng() - 0.5) * 2 * spread;
    const cy = at[1] + (rng() - 0.5) * 2 * spread;
    out.push(fractal(blob(cx, cy, r, r * (0.6 + 0.4 * rng()), rng, 0.25, rng() * 3), rng, 0.2, 3, 0.04));
  }
  return out;
}

/** Fractional-radius ring walls. */
export interface WalledRings {
  /** the walls as mountains, then the gates as plains: put into DrawnMap.paint in this order */
  paint: PaintDef[];
  /** foothills (iron) along every wall */
  regions: ExtraRegion[];
  /** centre-line radius of ring k at angle theta (radians, 0 = east, counter-clockwise) */
  radiusAt(k: number, theta: number): number;
  /** plane point at ring k, angle theta (a good spawn spot is between rings: use `between`) */
  at(k: number, theta: number): Pt;
  /** plane point halfway between ring k-1 and ring k (k = 0: halfway between the centre and ring 0) */
  between(k: number, theta: number): Pt;
}

export interface WalledRingsOpts {
  cx: number;
  cy: number;
  /** centre-line radius of each wall, inner to outer, units */
  radii: number[];
  /** wall thickness, units */
  thick: number;
  /** gates per ring: angle in degrees (centre of the gap) */
  gates: number[][];
  /** width of a gate gap, units */
  gateWidth: number;
  /** relative radius wobble of the rings (0.02 = nearly circular) */
  wobble?: number;
  /** foothill band on each side of a wall, units (hills = iron) */
  foot?: number;
  rng: () => number;
  /** the plane that turns these points into lon / lat */
  plane: Plane;
}

/** Concentric ring walls (continuous mountain ridges) with offset gates and hilly foothills. */
export function walledRings(o: WalledRingsOpts): WalledRings {
  const wob = o.radii.map(() => wobbler(o.rng, 4, 2));
  const wobble = o.wobble ?? 0.02;
  const radiusAt = (k: number, t: number): number => o.radii[k] * (1 + wobble * wob[k](t));
  const at = (k: number, t: number): Pt => [o.cx + Math.cos(t) * radiusAt(k, t), o.cy + Math.sin(t) * radiusAt(k, t)];
  const between = (k: number, t: number): Pt => {
    const r0 = k === 0 ? 0 : radiusAt(k - 1, t);
    const r = (r0 + radiusAt(k, t)) / 2;
    return [o.cx + Math.cos(t) * r, o.cy + Math.sin(t) * r];
  };
  const band = (k: number, inner: number, outer: number, a0: number, a1: number): number[][] => {
    const n = Math.max(2, Math.ceil(((a1 - a0) * o.radii[k]) / 0.15));
    const pts: Pt[] = [];
    for (let i = 0; i <= n; i++) {
      const t = a0 + ((a1 - a0) * i) / n;
      const r = radiusAt(k, t) + outer;
      pts.push([o.cx + Math.cos(t) * r, o.cy + Math.sin(t) * r]);
    }
    for (let i = n; i >= 0; i--) {
      const t = a0 + ((a1 - a0) * i) / n;
      const r = radiusAt(k, t) + inner;
      pts.push([o.cx + Math.cos(t) * r, o.cy + Math.sin(t) * r]);
    }
    return o.plane.ring(pts);
  };
  const SECTORS = 24;
  const foot = o.foot ?? o.thick * 3;
  const paint: PaintDef[] = [];
  const regions: ExtraRegion[] = [];
  for (let k = 0; k < o.radii.length; k++)
    for (let s = 0; s < SECTORS; s++) {
      const a0 = (s / SECTORS) * Math.PI * 2;
      const a1 = ((s + 1) / SECTORS) * Math.PI * 2 + 0.02;
      paint.push({ terrain: 'mountains', poly: band(k, -o.thick / 2, o.thick / 2, a0, a1) });
      regions.push({ name: `foothills ${k}.${s}`, kind: 'hills', poly: band(k, -foot - o.thick / 2, foot + o.thick / 2, a0, a1) });
    }
  for (let k = 0; k < o.radii.length; k++)
    for (const deg of o.gates[k] ?? []) {
      const t = (deg * Math.PI) / 180;
      const half = o.gateWidth / 2 / o.radii[k];
      // the gap: the wall's own band, clipped to the gate's angular width (plus a little reach into the foothills)
      paint.push({ terrain: 'plains', poly: band(k, -o.thick * 0.9, o.thick * 0.9, t - half, t + half) });
    }
  return { paint, regions, radiusAt, at, between };
}

/** Convenience: a seeded RNG for a drawn map (use one stream per feature so editing one shape leaves the others alone). */
export const rngFor = (seed: number): (() => number) => makeRng(seed);
