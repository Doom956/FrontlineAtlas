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

/** Strokes a polyline (screen px) with half width `hw` model units; the style paints (or skips) each cell it reaches. */
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
      if (col) c.put(i, j, col);
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

// ------------------------------------------------------------------------------------------------- the four connectors

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
