// The look of the connectors between same-owner buildings (art lab mockup now, the game's ground layer later; client
// only). Which pairs join is decided by buildingLinks.ts (pure). Here every connector is rasterized on the building art's
// own pixel grid (grid.ts), in the same muted military colours, and every colour is the terrain colour under that pixel
// pulled toward the material, so it reads as part of the land. Connectors are drawn UNDER the buildings: each building keeps
// its own core and level chip on top.
//
// Caching in the game: paintLinks draws into one transparent pixel layer for the rectangle it is given. The game can call
// it per link (or per owner and map tile) with that rectangle, keep the canvas, and rebuild only when the buildings of
// that owner change (the key is the link list from pairLinks plus the terrain under it); it never runs per frame.
import { FORE } from './bake';
import { gridOf } from './grid';
import { cl, dark, hash, mix, type C } from './buildings';
import { rampOf } from './palette';
import type { Extent } from './buildings';
import type { BuildingLink, LinkType } from './buildingLinks';
import type { RGB } from '../shared/colour';

type P = [number, number];

/** A building's anchor on the screen (CSS px) and the reach of its picture. */
export interface LinkSite {
  type: LinkType;
  sx: number;
  sy: number;
  ext: Extent;
}

export interface LinkPaint {
  links: readonly BuildingLink[];
  sites: ReadonlyMap<number, LinkSite>;
  /** map scale in screen px per model unit (art/detailed units) and the device pixel ratio */
  scale: number;
  dpr: number;
  /** the rectangle painted, in CSS px */
  w: number;
  h: number;
  /** screen CSS px to tile coordinates, tile coordinates to screen */
  tileOf: (sx: number, sy: number) => P;
  toScreen: (tx: number, ty: number) => P;
  rgbAt: (tx: number, ty: number) => RGB;
  waterAt: (tx: number, ty: number) => boolean;
  /** the map's pixel ground under the links, for the dirt tracks (no ground: no tracks drawn) */
  ground?: TrackGround;
}

interface Q {
  i: number;
  j: number;
  /** along the line and across it, in model units; d > 0 on the line's normal side */
  s: number;
  d: number;
  nx: number;
  ny: number;
  base: RGB;
  water: boolean;
}

class Cells {
  readonly W: number;
  readonly H: number;
  readonly data: Uint8ClampedArray;
  constructor(readonly k: number, readonly res: number, readonly p: LinkPaint) {
    this.W = Math.ceil(p.w / k);
    this.H = Math.ceil(p.h / k);
    this.data = new Uint8ClampedArray(this.W * this.H * 4);
  }
  put(i: number, j: number, c: C, a = 255): void {
    if (i < 0 || j < 0 || i >= this.W || j >= this.H) return;
    const o = (j * this.W + i) * 4;
    this.data[o] = c[0];
    this.data[o + 1] = c[1];
    this.data[o + 2] = c[2];
    this.data[o + 3] = a;
  }
  /** terrain colour and water flag under a cell */
  under(i: number, j: number): { base: RGB; water: boolean } {
    const [tx, ty] = this.p.tileOf((i + 0.5) * this.k, (j + 0.5) * this.k);
    return { base: this.p.rgbAt(tx, ty), water: this.p.waterAt(Math.floor(tx), Math.floor(ty)) };
  }
}

/** Light from the top left: how much a surface whose outward normal is (nx, ny) faces it, -1 to 1. */
const face = (nx: number, ny: number): number => -(nx + ny) * 0.7071;
const shade = (c: C, f: number): RGB => [cl(c[0] * f), cl(c[1] * f), cl(c[2] * f)];

/** Strokes a polyline (screen px) with half width `hw` model units; the style paints (or skips) each cell it reaches (a fourth channel, when given, is the cell's alpha). */
function stroke(c: Cells, pts: P[], hw: number, closed: boolean, style: (q: Q) => C | null): void {
  const k = c.k;
  const hc = hw * c.res;
  const cp = pts.map((p): P => [p[0] / k, p[1] / k]);
  const n = closed ? cp.length : cp.length - 1;
  const best = new Float32Array(c.W * c.H).fill(1e9);
  const sA = new Float32Array(c.W * c.H);
  const dA = new Float32Array(c.W * c.H);
  const nxA = new Float32Array(c.W * c.H);
  const nyA = new Float32Array(c.W * c.H);
  let cum = 0;
  for (let e = 0; e < n; e++) {
    const a = cp[e];
    const b = cp[(e + 1) % cp.length];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len < 1e-6) continue;
    const tx = (b[0] - a[0]) / len;
    const ty = (b[1] - a[1]) / len;
    const nx = -ty;
    const ny = tx;
    const i0 = Math.max(0, Math.floor(Math.min(a[0], b[0]) - hc - 1));
    const i1 = Math.min(c.W - 1, Math.ceil(Math.max(a[0], b[0]) + hc + 1));
    const j0 = Math.max(0, Math.floor(Math.min(a[1], b[1]) - hc - 1));
    const j1 = Math.min(c.H - 1, Math.ceil(Math.max(a[1], b[1]) + hc + 1));
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const px = i + 0.5 - a[0];
        const py = j + 0.5 - a[1];
        const t = Math.max(0, Math.min(len, px * tx + py * ty));
        const dd = Math.hypot(px - t * tx, py - t * ty);
        const idx = j * c.W + i;
        if (dd > hc || dd >= best[idx]) continue;
        best[idx] = dd;
        sA[idx] = (cum + t) / c.res;
        dA[idx] = (px * nx + py * ny) / c.res;
        nxA[idx] = nx;
        nyA[idx] = ny;
      }
    }
    cum += len;
  }
  for (let j = 0; j < c.H; j++) {
    for (let i = 0; i < c.W; i++) {
      const idx = j * c.W + i;
      if (best[idx] >= 1e8) continue;
      const u = c.under(i, j);
      const col = style({ i, j, s: sA[idx], d: dA[idx], nx: nxA[idx], ny: nyA[idx], base: u.base, water: u.water });
      if (col) c.put(i, j, col, col.length > 3 ? col[3] : 255);
    }
  }
}

/** A polyline broken into short steps with a sideways wobble (a trench is never ruler straight). */
function wobble(pts: P[], step: number, amp: number, seed: number): P[] {
  const out: P[] = [];
  let cum = 0;
  for (let e = 0; e + 1 < pts.length; e++) {
    const a = pts[e];
    const b = pts[e + 1];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const nx = -(b[1] - a[1]) / (len || 1);
    const ny = (b[0] - a[0]) / (len || 1);
    const m = Math.max(1, Math.round(len / step));
    for (let q = e === 0 ? 0 : 1; q <= m; q++) {
      const t = q / m;
      const off = q === m && e + 2 === pts.length ? 0 : (Math.sin((cum + t * len) / step * 0.9 + seed) * 0.6 + (hash(Math.round(cum + t * len), seed, 3) - 0.5) * 0.8) * amp;
      out.push([a[0] + (b[0] - a[0]) * t + nx * off, a[1] + (b[1] - a[1]) * t + ny * off]);
    }
    cum += len;
  }
  return out;
}

const lengthOf = (pts: P[]): number => {
  let s = 0;
  for (let i = 0; i + 1 < pts.length; i++) s += Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]);
  return s;
};

/** The point and unit tangent at arc length `s` (screen px) along a polyline. */
function at(pts: P[], s: number): { x: number; y: number; tx: number; ty: number } {
  let rest = s;
  for (let i = 0; i + 1 < pts.length; i++) {
    const len = Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]);
    if (rest <= len || i + 2 === pts.length) {
      const t = len > 0 ? Math.min(1, rest / len) : 0;
      return { x: pts[i][0] + (pts[i + 1][0] - pts[i][0]) * t, y: pts[i][1] + (pts[i + 1][1] - pts[i][1]) * t, tx: len > 0 ? (pts[i + 1][0] - pts[i][0]) / len : 1, ty: len > 0 ? (pts[i + 1][1] - pts[i][1]) / len : 0 };
    }
    rest -= len;
  }
  return { x: pts[0][0], y: pts[0][1], tx: 1, ty: 0 };
}

// ------------------------------------------------------------------------------------------------- the connectors

const CONCRETE: C = [176, 174, 164];
const KERB: C = [66, 68, 72];
const EARTH: C = [134, 108, 72];
const ASPHALT: C = [98, 94, 88];
const ROOFS: C[] = [[156, 124, 104], [132, 132, 128], [160, 150, 128], [122, 104, 96], [138, 118, 88]];

/** A pitched roof seen from above on cells: lit slope and dark slope split by a bright ridge, dark gable ends, a strip of wall below. */
function roofBox(c: Cells, i0: number, j0: number, wc: number, hc: number, ramp: readonly C[], base: C, horizontal: boolean, wall?: readonly C[]): void {
  const tone = (k: number): RGB => mix(ramp[k], base, 0.1);
  const sh = mix(base, [10, 12, 14], 0.42);
  for (let j = 0; j <= hc; j++) for (let i = 0; i <= wc; i++) if (i === wc || j === hc) c.put(i0 + i + 1, j0 + j + 1, sh);
  for (let j = 0; j < hc; j++) {
    for (let i = 0; i < wc; i++) {
      const along = horizontal ? i : j;
      const across = horizontal ? j : i;
      const lenA = horizontal ? wc : hc;
      const lenB = horizontal ? hc : wc;
      const mid = (lenB - 1) / 2;
      let col: RGB;
      if (Math.abs(across - mid) < 0.5 || (lenB % 2 === 0 && Math.abs(across - mid) <= 0.5)) col = tone(3);
      else if (across < mid) col = tone(2);
      else col = tone(1);
      if (along === 0 && lenA > 3) col = shade(col, 1.12);
      else if (along === lenA - 1 && lenA > 3) col = shade(col, 0.72);
      c.put(i0 + i, j0 + j, col);
    }
  }
  if (wall && horizontal) for (let i = 1; i < wc; i++) c.put(i0 + i, j0 + hc, mix(wall[1], base, 0.12));
}

const ROOF_SETS: readonly (readonly C[])[] = [rampOf('rust'), rampOf('brick'), rampOf('ochre'), rampOf('fadedBlue')];
const BOX_SETS: readonly C[] = [[168, 66, 52], [60, 98, 150], [196, 160, 70], [74, 120, 82], [150, 150, 146]];

/** A stack of shipping containers (two rows of coloured boxes with a lit top edge), on cells. */
function containers(c: Cells, cx: number, cy: number, seed: number): void {
  const wc = Math.max(3, Math.round(4 * c.res));
  const hc = Math.max(2, Math.round(2.2 * c.res));
  for (let r = 0; r < 2; r++) {
    for (let q = 0; q < 2; q++) {
      const i0 = Math.round(cx) + q * (wc + 1) - wc;
      const j0 = Math.round(cy) + r * (hc + 1) - hc;
      const { base, water } = c.under(i0, j0);
      if (water) continue;
      const col = BOX_SETS[Math.floor(hash(seed, r * 2 + q, 7) * BOX_SETS.length)];
      for (let j = 0; j < hc; j++) for (let i = 0; i < wc; i++) c.put(i0 + i, j0 + j, mix(base, j === 0 ? shade(col, 1.2) : j === hc - 1 || i === wc - 1 ? shade(col, 0.68) : col, 0.88));
      for (let j = 0; j <= hc; j++) c.put(i0 + wc, j0 + j + 1, mix(base, [10, 12, 14], 0.4));
    }
  }
}

/**
 * A harbour wall along the shore, running on past each port's own frontage: a stone slab with seams, a dark kerb on the sea
 * side, bollards, a paved apron behind it, and between the ports a few sheds and container stacks on the apron.
 * `gap` is the arc length (screen px) of the stretch between the two ports.
 */
function quay(c: Cells, pts: P[], seaSign: number, gap: [number, number], seed: number): void {
  stroke(c, pts, 12, false, (q) => {
    // the wall stands out over the shallows: the slab and kerb may cover water, the apron only land
    const d = q.d * seaSign - 3;
    if (q.water && d < -3.6) return null;
    if (d > 3.9 || d < -9.4) return null;
    if (d > 2.8) return mix(q.base, KERB, 0.78);
    if (d >= -3.6) {
      if (q.s % 10 < 1.2 && d > 1.1 && d < 2.2) return dark(KERB, 0.7);
      let col: RGB = mix(q.base, CONCRETE, 0.82);
      if (q.s % 8 < 0.6) col = shade(col, 0.82);
      else if (d < -3.0) col = shade(col, 1.12);
      else if (d > 2.0) col = shade(col, 0.9);
      return col;
    }
    if (d >= -7.4) return (q.i + q.j) & 1 ? mix(q.base, [140, 136, 124], 0.7) : mix(q.base, [124, 120, 108], 0.55);
    return hash(q.i, q.j, 17) < 0.55 ? mix(q.base, [124, 118, 104], 0.3) : null;
  });
  const sc = c.p.scale;
  const L = lengthOf(pts) / sc;
  const s0 = gap[0] / sc + 8;
  const s1 = gap[1] / sc - 8;
  let n = 0;
  for (let s = s0; s <= s1; s += 15) {
    const p = at(pts, s * sc);
    let nx = -p.ty;
    let ny = p.tx;
    if (seaSign > 0) {
      nx = -nx;
      ny = -ny;
    }
    const off = 7.5 * sc;
    const cx = (p.x + nx * off) / c.k;
    const cy = (p.y + ny * off) / c.k;
    const u = c.under(Math.round(cx), Math.round(cy));
    if (u.water || s > L) continue;
    if (n++ % 2 === 0) {
      const wc = Math.round(11 * c.res);
      const hc = Math.round(6.4 * c.res);
      roofBox(c, Math.round(cx - wc / 2), Math.round(cy - hc / 2), wc, hc, rampOf('sup'), u.base, true, rampOf('cream'));
    } else containers(c, cx, cy, seed + n);
  }
}

/** A trench with a berm either side (the berm lit on its upper left face) and a small concrete bunker now and then. */
function trench(c: Cells, pts: P[], seed: number): void {
  stroke(c, wobble(pts, 3 * c.p.scale, 1.1 * c.p.scale, seed), 3.7, false, (q) => {
    if (q.water) return null;
    const a = Math.abs(q.d);
    const bunker = (q.s + 12) % 26 < 5.5;
    if (bunker && a <= 2.8) {
      if (a < 0.7 && (q.s + 12) % 26 > 1.5 && (q.s + 12) % 26 < 4) return [26, 26, 28];
      return shade(mix(q.base, [150, 148, 140], 0.72), 1 + 0.12 * face(q.nx * Math.sign(q.d), q.ny * Math.sign(q.d)));
    }
    if (a < 1.3) return mix(q.base, [30, 25, 20], 0.86);
    if (a <= 3.0) {
      const sg = Math.sign(q.d);
      const f = 1 + 0.2 * face(q.nx * sg, q.ny * sg);
      const bag = (hash(q.i, q.j, 29) - 0.5) * 9;
      const col = mix(q.base, EARTH, 0.58);
      return [cl(col[0] * f + bag), cl(col[1] * f + bag), cl(col[2] * f + bag)];
    }
    return a <= 3.7 && hash(q.i, q.j, 23) < 0.4 ? mix(q.base, EARTH, 0.28) : null;
  });
}

/** A little tree seen from above: a dark round crown with a lit top left. */
function tree(c: Cells, cx: number, cy: number): void {
  const r = Math.max(1.5, 1.2 * c.res);
  for (let j = -Math.ceil(r); j <= Math.ceil(r); j++) {
    for (let i = -Math.ceil(r); i <= Math.ceil(r); i++) {
      if (Math.hypot(i, j) > r) continue;
      const x = Math.round(cx) + i;
      const y = Math.round(cy) + j;
      const { base, water } = c.under(x, y);
      if (water) continue;
      const lit = i + j < -r * 0.6 ? 1.25 : i + j > r * 0.7 ? 0.7 : 1;
      c.put(x, y, shade(mix(base, [58, 92, 56], 0.85), lit));
    }
  }
}

/** A two lane road with a dashed centre line, with houses (pitched roofs, little gardens, trees) in a row either side. */
function road(c: Cells, pts: P[], seed: number): void {
  const k = c.k;
  const sc = c.p.scale;
  const L = lengthOf(pts) / sc;
  const core = 4;
  stroke(c, pts, 3.2, false, (q) => {
    if (q.water || q.s < core || q.s > L - core) return null;
    const a = Math.abs(q.d);
    if (a < 2.1) {
      if (a < 0.35 && q.s % 6 < 3) return mix(q.base, [214, 206, 170], 0.78);
      const col = mix(q.base, ASPHALT, 0.72);
      return a > 1.7 ? shade(col, 0.84) : col;
    }
    return hash(q.i, q.j, 41) < 0.5 ? mix(q.base, [140, 120, 92], 0.34) : null;
  });
  const wc = Math.max(4, Math.round(5 * c.res));
  const hc = Math.max(3, Math.round(3.6 * c.res));
  const step = 6.6;
  for (let s = core + 4; s < L - core - 2; s += step) {
    const e = Math.min(s, L - s);
    const dens = e < 24 ? 0.97 : e < 40 ? 0.6 : 0.22;
    for (const side of [-1, 1]) {
      const p = at(pts, s * sc);
      const horizontal = Math.abs(p.tx) >= Math.abs(p.ty);
      const put = (along: number, off: number): { cx: number; cy: number } => {
        const q = at(pts, (s + along) * sc);
        return { cx: (q.x - q.ty * off * sc * side) / k, cy: (q.y + q.tx * off * sc * side) / k };
      };
      const r = hash(Math.round(s * 3), side, seed);
      if (r > dens) {
        if (r < dens + 0.25) {
          const t = put(0, 5.4);
          tree(c, t.cx, t.cy);
        }
        continue;
      }
      const h = put(0, 5.8 + hash(Math.round(s), side, seed + 5) * 0.8);
      const i0 = Math.round(h.cx - wc / 2);
      const j0 = Math.round(h.cy - hc / 2);
      const u = c.under(Math.round(h.cx), Math.round(h.cy));
      if (u.water) continue;
      // garden: a green lot round the house
      for (let j = -2; j <= hc + 2; j++) for (let i = -2; i <= wc + 2; i++) if (hash(i0 + i, j0 + j, 71) < 0.7) c.put(i0 + i, j0 + j, mix(c.under(i0 + i, j0 + j).base, [92, 120, 70], 0.34));
      const ramp = ROOF_SETS[Math.floor(hash(Math.round(s), side, seed + 9) * ROOF_SETS.length)];
      roofBox(c, i0, j0, wc, hc, ramp, u.base, horizontal, rampOf('cream'));
      if (hash(Math.round(s), side, seed + 13) < 0.5) {
        const t = put(step / 2, 5.4);
        tree(c, t.cx, t.cy);
      }
    }
  }
}

// ------------------------------------------------------------------------------------------------- dirt tracks
// A track is drawn by the terrain's own hand, not the building art's: on the map's pixel ground grid (P art pixels per
// tile, the same grid the map shader snaps to, render/glmap.ts artPixelsPerTile), every pixel a hard colour from the
// map theme's ground ramps for the terrain under it (render/ground.ts), worn and edged with the shader's own 4 x 4
// ordered dither, then tinted by the owner the way the map tints owned ground. In forest the tree crowns (the shader's
// own crown grid) stay on top along part of its way, so the track slips under the trees; mountain peaks always stand in
// front of it and swamp pools swallow it.

/** A track's half width in tiles: the trodden path, then the dithered verge. */
export const TRACK_CORE = 0.07;
export const TRACK_EDGE = 0.13;

/** The ground ramps a track takes its colours from (the shape of render/ground.ts GROUND, any map theme's palette). */
export interface TrackRamps {
  grass: readonly C[];
  forest: readonly C[];
  hills: readonly C[];
  rock: readonly C[];
  snow: readonly C[];
  sand: readonly C[];
  swamp: readonly C[];
  tundra: readonly C[];
  soil: readonly C[];
  pool: readonly C[];
}

/** What a track needs to know of the map under it. */
export interface TrackGround {
  /** art pixels per tile of the map's pixel ground at this zoom */
  P: number;
  /** the terrain id of a tile (sim/types.ts Terrain; 0 and 1 are water) */
  terrainAt: (tx: number, ty: number) => number;
  ramps: TrackRamps;
  /** the ground's height 0..1 at a tile point (render/ground.ts, as the shader samples it); it sets where peaks stand */
  heightAt?: (qx: number, qy: number) => number;
  /** the owner's tint over a ground colour, as the map paints owned ground (`avgY` the ground's broad brightness, 0..255) */
  tint: (c: RGB, avgY: number) => RGB;
}

/** The map shader's 4 x 4 ordered dither threshold of an art pixel, 0..1 (shaders.ts bayer4). */
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
export const bayer4 = (i: number, j: number): number => (BAYER[(j & 3) * 4 + (i & 3)] + 0.5) / 16;

/** The map shader's hash of a cell (shaders.ts hash), 0..1. */
export function shaderHash(cx: number, cy: number, salt: number): number {
  let x = (Math.imul(cx, 1664525) ^ Math.imul(cy, 1013904223) ^ Math.imul(salt, 2654435761 | 0)) >>> 0;
  x = (x ^ (x >>> 16)) >>> 0;
  x = Math.imul(x, 0x7feb352d) >>> 0;
  x = (x ^ (x >>> 15)) >>> 0;
  x = Math.imul(x, 0x846ca68b | 0) >>> 0;
  x = (x ^ (x >>> 16)) >>> 0;
  return x / 4294967296;
}
function shaderNoise(px: number, py: number, salt: number): number {
  const ix = Math.floor(px);
  const iy = Math.floor(py);
  let fx = px - ix;
  let fy = py - iy;
  fx = fx * fx * (3 - 2 * fx);
  fy = fy * fy * (3 - 2 * fy);
  const a = shaderHash(ix, iy, salt);
  const b = shaderHash(ix + 1, iy, salt);
  const c = shaderHash(ix, iy + 1, salt);
  const d = shaderHash(ix + 1, iy + 1, salt);
  return (a + (b - a) * fx) * (1 - fy) + (c + (d - c) * fx) * fy;
}

/** Whether tile point (qx, qy) lies under one of the forest's tree crowns (shaders.ts treeAt, its grid and sizes). */
export function underCrown(qx: number, qy: number, P: number): boolean {
  const tc = P >= 8 ? 2 : 1;
  const c2x = qx * tc;
  const c2y = qy * tc;
  const c0x = Math.floor(c2x - 0.5);
  const c0y = Math.floor(c2y - 0.5);
  // glades: the shader leaves out some crowns where its clearing noise is high
  const dens = 1 - 0.5 * Math.min(1, Math.max(0, (shaderNoise(qx / 2.2, qy / 2.2, 411) - 0.74) / 0.06));
  for (let j = 0; j < 2; j++) {
    for (let i = 0; i < 2; i++) {
      const cx = c0x + i;
      const cy = c0y + j;
      if (dens < 1 && shaderHash(cx, cy, 109) >= dens) continue;
      const ox = cx + 0.5 + (shaderHash(cx, cy, 101) - 0.5) * 0.5;
      const oy = cy + 0.5 + (shaderHash(cx, cy, 103) - 0.5) * 0.5;
      const r = 0.66 + 0.2 * shaderHash(cx, cy, 107);
      if (Math.hypot(c2x - ox, c2y - oy) <= r * 0.92) return true;
    }
  }
  return false;
}

const smooth = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** Whether tile point (qx, qy) lies inside a mountain peak (shaders.ts landAt, mountains: its grid, sizes and shoulders). */
export function underPeak(qx: number, qy: number, P: number, hgt: number): boolean {
  const csx = P >= 8 ? 1.9 : 2.8;
  const csy = P >= 8 ? 1.15 : 1.7;
  const row = Math.floor(qy / csy);
  const keep = 0.15 + 0.55 * smooth(0.45, 0.85, hgt);
  const hk = 0.25 * smooth(0.5, 0.9, hgt);
  for (let j = 2; j >= 0; j--) {
    const r = row + j;
    const ox = shaderHash(r, 17, 315);
    for (let i = -1; i <= 1; i++) {
      const cxi = Math.floor(qx / csx - ox) + i;
      if (shaderHash(cxi, r, 301) > keep) continue;
      const k = 0.55 + 0.85 * shaderHash(cxi, r, 303) * shaderHash(cxi, r, 309) + hk;
      const ax = (cxi + ox + 0.5 + (shaderHash(cxi, r, 305) - 0.5) * 0.6) * csx;
      const by = (r + 0.7 + 0.3 * shaderHash(cxi, r, 313)) * csy;
      const ht = csy * Math.min(2.6, 1.45 * k * (0.75 + 0.5 * shaderHash(cxi, r, 317)));
      const ay = by - ht;
      if (qy < ay || qy > by) continue;
      const fy = (qy - ay) / ht;
      const wl = csx * Math.min(1, k * (0.44 + 0.22 * shaderHash(cxi, r, 319))) * fy;
      const wr = csx * Math.min(1, k * (0.44 + 0.22 * shaderHash(cxi, r, 321))) * fy;
      const dx = qx - ax;
      if (dx < 0 ? -dx <= wl : dx <= wr) return true;
      const sh2 = shaderHash(cxi, r, 323);
      if (sh2 < 0.4) {
        const sx = ax + (sh2 < 0.2 ? -1 : 1) * csx * Math.min(0.55, k * 0.35);
        const sy = ay + ht * 0.38;
        const sfy = (qy - sy) / (by - sy);
        const sw = csx * Math.min(0.48, k * 0.3) * sfy;
        if (sfy >= 0 && Math.abs(qx - sx) <= sw) return true;
      }
    }
  }
  return false;
}

/** Whether tundra at tile point (qx, qy) lies under a snow drift (shaders.ts landAt, tundra). */
export function snowDrift(qx: number, qy: number): boolean {
  const rx = 0.8 * qx + 0.6 * qy;
  const ry = -0.6 * qx + 0.8 * qy;
  return shaderNoise(rx / 1.6, ry / 1.6, 95) * 0.7 + shaderNoise(rx / 3.5, ry / 3.5, 97) * 0.3 > 0.69;
}

/** Whether swamp at tile point (qx, qy) is a standing pool (shaders.ts landAt, swamp). */
export function swampPool(qx: number, qy: number): boolean {
  return shaderNoise((0.8 * qx + 0.6 * qy) / 0.8, (-0.6 * qx + 0.8 * qy) / 0.8, 91) > 0.62;
}

const lumaC = (c: C): number => 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];

/** The track's tones on a terrain: the trodden path, its worn pixels and the verge; null = no track there (water). */
export function trackTones(ter: number, r: TrackRamps): { path: C; wear: C; verge: C; ground: C } | null {
  switch (ter) {
    case 2: return { path: r.soil[3], wear: r.soil[2], verge: r.soil[2], ground: r.grass[2] };
    case 3: return { path: r.soil[0], wear: r.forest[1], verge: r.forest[0], ground: r.forest[1] };
    case 4: return { path: r.soil[2], wear: r.soil[1], verge: r.hills[1], ground: r.hills[2] };
    case 5: return { path: r.rock[2], wear: r.rock[1], verge: r.rock[1], ground: r.rock[1] };
    case 6: return { path: r.sand[1], wear: r.sand[0], verge: r.sand[1], ground: r.sand[2] };
    case 7: return { path: r.soil[0], wear: r.swamp[0], verge: r.swamp[0], ground: r.swamp[2] };
    // tundra: a bluish trodden line on the bare ground (packed snow on a drift: see trackArt)
    case 8: return { path: r.snow[0], wear: r.tundra[1], verge: r.tundra[1], ground: r.tundra[2] };
    default: return null;
  }
}

/** A track as art pixels of the map's ground grid: origin (art pixel coords), size and RGBA (alpha 0 or 255 only). */
export interface TrackPixels {
  x0: number;
  y0: number;
  w: number;
  h: number;
  rgba: Uint8ClampedArray;
}

/**
 * The pixels of a track along `path` (tile coordinates) on the ground grid of `g`: the trodden path TRACK_CORE tiles
 * either side of the line (at least the one pixel the line runs through), worn in places with the ordered dither, a
 * dithered verge out to TRACK_EDGE, every colour from the ramps of the terrain under that pixel. Pure.
 */
export function trackArt(path: readonly P[], g: TrackGround, seed: number): TrackPixels {
  const P = g.P;
  const r0 = Math.max(0.5, TRACK_CORE * P);
  const r1 = Math.max(r0 + 0.75, TRACK_EDGE * P);
  let mx0 = Infinity;
  let my0 = Infinity;
  let mx1 = -Infinity;
  let my1 = -Infinity;
  for (const [x, y] of path) {
    mx0 = Math.min(mx0, x);
    my0 = Math.min(my0, y);
    mx1 = Math.max(mx1, x);
    my1 = Math.max(my1, y);
  }
  const x0 = Math.floor(mx0 * P - r1) - 1;
  const y0 = Math.floor(my0 * P - r1) - 1;
  const w = Math.max(1, Math.ceil(mx1 * P + r1) + 2 - x0);
  const h = Math.max(1, Math.ceil(my1 * P + r1) + 2 - y0);
  const best = new Float32Array(w * h).fill(1e9);
  const along = new Float32Array(w * h);
  // nearest distance (art px) and arc length (tiles) of every pixel near the line
  let cum = 0;
  for (let e = 0; e + 1 < path.length; e++) {
    const ax = path[e][0] * P;
    const ay = path[e][1] * P;
    const bx = path[e + 1][0] * P;
    const by = path[e + 1][1] * P;
    const len = Math.hypot(bx - ax, by - ay);
    if (len < 1e-9) continue;
    const tx = (bx - ax) / len;
    const ty = (by - ay) / len;
    const i0 = Math.max(0, Math.floor(Math.min(ax, bx) - r1) - x0);
    const i1 = Math.min(w - 1, Math.ceil(Math.max(ax, bx) + r1) - x0);
    const j0 = Math.max(0, Math.floor(Math.min(ay, by) - r1) - y0);
    const j1 = Math.min(h - 1, Math.ceil(Math.max(ay, by) + r1) - y0);
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const px = x0 + i + 0.5 - ax;
        const py = y0 + j + 0.5 - ay;
        const t = Math.max(0, Math.min(len, px * tx + py * ty));
        const d = Math.hypot(px - t * tx, py - t * ty);
        const k = j * w + i;
        if (d < best[k]) {
          best[k] = d;
          along[k] = (cum + t) / P;
        }
      }
    }
    cum += len;
  }
  const rgba = new Uint8ClampedArray(w * h * 4);
  const ws = 1.3 + 0.6 * ((seed & 7) / 7);
  const fine = P >= 16;
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const k = j * w + i;
      const d = best[k];
      if (d > r1) continue;
      const ai = x0 + i;
      const aj = y0 + j;
      const qx = (ai + 0.5) / P;
      const qy = (aj + 0.5) / P;
      const ter = g.terrainAt(Math.floor(qx), Math.floor(qy));
      const tones = trackTones(ter, g.ramps);
      if (!tones) continue;
      const s = along[k];
      // the trees and peaks stand in front: crowns cover the track along part of its way through a forest (elsewhere
      // it is a cut through the trees), every peak covers it, so it winds between them
      if (ter === 3 && Math.sin(s * 0.9 + seed * 1.3) + 0.6 * Math.sin(s * 2.3 + seed) > 0.2 && underCrown(qx, qy, P)) continue;
      if (ter === 7 && swampPool(qx, qy)) continue;
      if (ter === 5 && underPeak(qx, qy, P, g.heightAt ? g.heightAt(qx, qy) : 0.7)) continue;
      const drift = ter === 8 && snowDrift(qx, qy);
      const dth = bayer4(ai, aj);
      // how worn the path is here: a slow wave along it, stepped by the dither (never an alpha fade)
      const wear = Math.max(0, 0.45 * Math.sin(s / ws + seed) * Math.sin(s / (ws * 0.37) + seed * 0.7) - 0.05);
      let col: C;
      // a fine grid (P 16 and up) gets a half-dithered fringe on the path; a coarse one keeps a clean one-pixel line
      if (d <= r0 || (fine && d <= r0 + 0.45 && dth < 0.5)) col = drift ? (dth < wear ? g.ramps.snow[0] : g.ramps.snow[1]) : dth < wear ? tones.wear : tones.path;
      else if (dth < (fine ? 0.45 : 0.22) * (1 - (d - r0) / (r1 - r0))) col = drift ? g.ramps.snow[1] : tones.verge;
      else continue;
      const out = g.tint([col[0], col[1], col[2]], lumaC(tones.ground));
      const o = k * 4;
      rgba[o] = out[0];
      rgba[o + 1] = out[1];
      rgba[o + 2] = out[2];
      rgba[o + 3] = 255;
    }
  }
  return { x0, y0, w, h, rgba };
}

/**
 * Draws track pixels on `ctx` (CSS px, scaled by `dpr`) the way the map shader draws its ground: every device pixel
 * takes the art pixel its centre falls in, so the track's pixels line up with the terrain's own.
 */
function blitTrack(ctx: CanvasRenderingContext2D, t: TrackPixels, p: LinkPaint, P: number): void {
  const dpr = p.dpr;
  const W = Math.ceil(p.w * dpr);
  const H = Math.ceil(p.h * dpr);
  const [sx0, sy0] = p.toScreen(t.x0 / P, t.y0 / P);
  const [sx1, sy1] = p.toScreen((t.x0 + t.w) / P, (t.y0 + t.h) / P);
  const X0 = Math.max(0, Math.floor(sx0 * dpr));
  const Y0 = Math.max(0, Math.floor(sy0 * dpr));
  const X1 = Math.min(W, Math.ceil(sx1 * dpr));
  const Y1 = Math.min(H, Math.ceil(sy1 * dpr));
  if (X1 <= X0 || Y1 <= Y0) return;
  const cv = document.createElement('canvas');
  cv.width = X1 - X0;
  cv.height = Y1 - Y0;
  const cc = cv.getContext('2d');
  if (!cc) return;
  const img = cc.createImageData(cv.width, cv.height);
  const out = img.data;
  for (let y = Y0; y < Y1; y++) {
    for (let x = X0; x < X1; x++) {
      const [tx, ty] = p.tileOf((x + 0.5) / dpr, (y + 0.5) / dpr);
      const i = Math.floor(tx * P) - t.x0;
      const j = Math.floor(ty * P) - t.y0;
      if (i < 0 || j < 0 || i >= t.w || j >= t.h) continue;
      const s = (j * t.w + i) * 4;
      if (!t.rgba[s + 3]) continue;
      const o = ((y - Y0) * cv.width + (x - X0)) * 4;
      out[o] = t.rgba[s];
      out[o + 1] = t.rgba[s + 1];
      out[o + 2] = t.rgba[s + 2];
      out[o + 3] = 255;
    }
  }
  cc.putImageData(img, 0, 0);
  ctx.save();
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(cv, X0 / dpr, Y0 / dpr, cv.width / dpr, cv.height / dpr);
  ctx.restore();
}

/**
 * Paints the connectors of `p.links` into one transparent layer on `ctx` (CSS px, the rectangle p.w by p.h). Draw it
 * before the buildings. Pairs whose sites are missing are skipped.
 */
export function paintLinks(ctx: CanvasRenderingContext2D, p: LinkPaint): void {
  const g = gridOf(p.scale, p.dpr);
  const c = new Cells(g.k, g.res, p);
  const line = (l: BuildingLink): P[] => {
    if (l.full ?? l.path) return (l.full ?? l.path ?? []).map((q) => p.toScreen(q[0], q[1]));
    const a = p.sites.get(l.a);
    const b = p.sites.get(l.b);
    return a && b ? [[a.sx, a.sy], [b.sx, b.sy]] : [];
  };
  // tracks first: every other connector lies over them (they need the ground under them; without it, none)
  if (p.ground) for (const l of p.links) if (l.kind === 'track' && l.path) blitTrack(ctx, trackArt(l.path, p.ground, (l.a * 7 + l.b) | 0), p, p.ground.P);
  for (const l of p.links) {
    if (l.kind !== 'quay') continue;
    const pts = line(l);
    if (pts.length < 2) continue;
    const mid = pts[pts.length >> 1];
    const nx = -(pts[pts.length - 1][1] - pts[0][1]);
    const ny = pts[pts.length - 1][0] - pts[0][0];
    const len = Math.hypot(nx, ny) || 1;
    const probe = (sg: number): boolean => {
      const [tx, ty] = p.tileOf(mid[0] + (sg * nx * 28) / len, mid[1] + (sg * ny * 28) / len);
      return p.waterAt(Math.floor(tx), Math.floor(ty));
    };
    let gap: [number, number] = [0, lengthOf(pts)];
    if (l.core && l.full) {
      const sl = (i: number): number => lengthOf(pts.slice(0, i + 1));
      gap = [sl(l.core[0]), sl(l.core[1])];
    }
    quay(c, pts, probe(1) || !probe(-1) ? 1 : -1, gap, l.a);
  }
  for (const l of p.links) if (l.kind === 'trench') trench(c, line(l), l.a);
  for (const l of p.links) if (l.kind === 'road') road(c, line(l), l.a);
  const cv = document.createElement('canvas');
  cv.width = c.W;
  cv.height = c.H;
  const cc = cv.getContext('2d');
  if (!cc) return;
  const img = cc.createImageData(c.W, c.H);
  img.data.set(c.data);
  cc.putImageData(img, 0, 0);
  ctx.save();
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(cv, 0, 0, c.W * c.k, c.H * c.k);
  ctx.restore();
}
