// The art lab's "Buildings mockup" (art lab builds only): map buildings as small painted tabletop miniatures seen from
// a high camera (about 60 degrees down, like the units): mostly roofs, a fort's courtyard and wall tops, launcher racks,
// dock and crane tops, a city's roofs and streets, with only a thin strip of the front wall. Light comes from the top
// left and a long shadow falls toward the bottom right onto the ground. A muted, earthy palette; the owner's colour
// sits only on flags, bands and small trim. The level is a number on a small dark plate in the corner.
// It is a MOCKUP: the game's map still draws buildings with render/buildings.ts. Flak, tank traps, the radar dish and
// coastal guns are not game features yet; they are visual add-ons here. Everything is drawn in code (no image files)
// into a small buffer (3 sub-pixels per sprite pixel) and shown at two zooms, next to today's marker icon, and then
// over a crop of a real game map (the game's own map loader and terrain colours). No module-level side effects.
import { drawMarker, ICON_INFO, type BuildingIconId } from '../icons';
import { CATEGORY_PLATES, markerSize } from '../render/buildings';
import { buildTerrain, waterRGB } from '../render/terrain';
import { themeForMap } from '../render/mapThemes';
import { makeCanvas } from '../render/common';
import { isWater, type MapData } from '../../sim/types';
import { decodeWorldMapBlob } from '../../sim/worldmaps';
import balticBlob from '../../maps/data/baltic';
import type { RGB } from '../art/shared/colour';
import { backdrop } from './backdrop';
import { label } from './scenes';

const W = 56;
const H = 54;
/** sub-pixels per sprite pixel (the finer grid the detail is drawn on) */
const K = 3;
const SW = W * K;
const SH = H * K;
const BADGE_X = W - 10;
const SCALE_CLOSE = 3;
const SCALE_NORMAL = 2;

type C = readonly number[];

// ------------------------------------------------------------------------------------------------- colour

const cl = (v: number): number => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));
/** a colour scaled in brightness (f < 1 darker, f > 1 lighter) */
const sh = (c: C, f: number): RGB => [cl(c[0] * f), cl(c[1] * f), cl(c[2] * f)];
const mix = (a: C, b: C, t: number): RGB => [cl(a[0] + (b[0] - a[0]) * t), cl(a[1] + (b[1] - a[1]) * t), cl(a[2] + (b[2] - a[2]) * t)];
/** deterministic 0..1 noise from two integers (surface grain, no Math.random) */
function hash(x: number, y: number): number {
  let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

/** The muted material palette: weathered concrete, steel, earth and clay. Nothing here is a bright fill. */
const M = {
  conc: [152, 150, 140],
  stone: [138, 132, 118],
  steel: [100, 108, 112],
  dkSteel: [60, 66, 70],
  earth: [112, 98, 74],
  clay: [138, 98, 78],
  slate: [92, 98, 104],
  cream: [176, 166, 146],
  brick: [130, 96, 80],
  olive: [84, 92, 66],
  white: [202, 202, 194],
  teak: [124, 98, 70],
  sea: [70, 96, 106],
  rust: [136, 84, 64],
  fadedBlue: [86, 106, 122],
  ochre: [146, 124, 76],
  moss: [88, 104, 84],
  sand: [166, 148, 110],
  glass: [40, 50, 58],
  lamp: [196, 174, 118],
  asphalt: [74, 76, 76],
} as const satisfies Record<string, C>;

/** The owner's colour, a touch toned down so it sits with the muted palette (flags, bands and trim only). */
const ownTone = (o: C): RGB => mix(o, [128, 128, 122], 0.16);

// ------------------------------------------------------------------------------------------------- sub-pixel buffer

class Pix {
  readonly d = new Uint8ClampedArray(SW * SH * 4);
  /** 'shadow': only cast() records into the shadow mask and nothing is painted; 'draw': everything paints */
  mode: 'draw' | 'shadow' = 'draw';
  readonly sm = new Float32Array(SW * SH);
  /** one sub-pixel, blended over what is there */
  sp(x: number, y: number, c: C, a = 255): void {
    if (this.mode === 'shadow' || x < 0 || y < 0 || x >= SW || y >= SH || a <= 0) return;
    const o = (y * SW + x) * 4;
    if (a >= 255) {
      this.d[o] = c[0];
      this.d[o + 1] = c[1];
      this.d[o + 2] = c[2];
      this.d[o + 3] = 255;
      return;
    }
    const sa = a / 255;
    const da = this.d[o + 3] / 255;
    const oa = sa + da * (1 - sa);
    const w = da * (1 - sa);
    this.d[o] = (c[0] * sa + this.d[o] * w) / oa;
    this.d[o + 1] = (c[1] * sa + this.d[o + 1] * w) / oa;
    this.d[o + 2] = (c[2] * sa + this.d[o + 2] * w) / oa;
    this.d[o + 3] = oa * 255;
  }
  /** a rectangle in sprite pixels (fractions allowed) */
  rect(x: number, y: number, w: number, h: number, c: C, a = 255): void {
    const x0 = Math.round(x * K);
    const x1 = Math.round((x + w) * K);
    const y0 = Math.round(y * K);
    const y1 = Math.round((y + h) * K);
    for (let j = y0; j < y1; j++) for (let i = x0; i < x1; i++) this.sp(i, j, c, a);
  }
  /** a rectangle filled per sub-pixel by fn(u, v, sx, sy), u and v running 0..1 across it */
  fill(x: number, y: number, w: number, h: number, fn: (u: number, v: number, sx: number, sy: number) => C | null, a = 255): void {
    const x0 = Math.round(x * K);
    const x1 = Math.round((x + w) * K);
    const y0 = Math.round(y * K);
    const y1 = Math.round((y + h) * K);
    for (let j = y0; j < y1; j++) {
      for (let i = x0; i < x1; i++) {
        const c = fn((i - x0 + 0.5) / (x1 - x0), (j - y0 + 0.5) / (y1 - y0), i, j);
        if (c) this.sp(i, j, c, a);
      }
    }
  }
  /** a line in sprite pixels, t sub-pixels thick */
  line(x0: number, y0: number, x1: number, y1: number, c: C, t = 1, a = 255): void {
    const n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), 0.01) * K;
    const half = Math.floor((t - 1) / 2);
    for (let i = 0; i <= n; i++) {
      const sx = Math.round((x0 + ((x1 - x0) * i) / n) * K - 0.5);
      const sy = Math.round((y0 + ((y1 - y0) * i) / n) * K - 0.5);
      for (let j = 0; j < t; j++) for (let k = 0; k < t; k++) this.sp(sx - half + k, sy - half + j, c, a);
    }
  }
  /** a shaded ball or dome: an ellipse lit from the top left, soft at the rim */
  blob(cx: number, cy: number, rx: number, ry: number, c: C, a = 255, lift = 0.55): void {
    const x0 = Math.floor((cx - rx) * K);
    const x1 = Math.ceil((cx + rx) * K);
    const y0 = Math.floor((cy - ry) * K);
    const y1 = Math.ceil((cy + ry) * K);
    for (let j = y0; j <= y1; j++) {
      for (let i = x0; i <= x1; i++) {
        const nx = ((i + 0.5) / K - cx) / rx;
        const ny = ((j + 0.5) / K - cy) / ry;
        const q = nx * nx + ny * ny;
        if (q > 1) continue;
        const z = Math.sqrt(1 - q);
        const lam = -0.5 * nx - 0.6 * ny + 0.62 * z;
        const f = 0.6 + lift * Math.max(0, Math.min(1, lam + 0.25));
        this.sp(i, j, sh(c, f), q > 0.86 ? a * Math.min(1, (1 - q) / 0.14 + 0.35) : a);
      }
    }
  }
  /** casts the shadow of a footprint (ground rect) z tall: swept toward the bottom right into the shadow mask */
  cast(x: number, y: number, w: number, d: number, z: number): void {
    if (this.mode !== 'shadow') return;
    const lx = z * 0.8;
    const ly = z * 0.46;
    const x0 = x * K;
    const x1 = (x + w) * K;
    const y0 = y * K;
    const y1 = (y + d) * K;
    const jy0 = Math.max(0, Math.floor(y0));
    const jy1 = Math.min(SH - 1, Math.ceil(y1 + ly * K));
    for (let j = jy0; j <= jy1; j++) {
      const py = j + 0.5;
      // the swept offset t (0..1) for which this row is inside the footprint
      const ta = ly > 0 ? Math.max(0, (py - y1) / (ly * K)) : 0;
      const tb = ly > 0 ? Math.min(1, (py - y0) / (ly * K)) : 1;
      if (tb < ta) continue;
      const xa = Math.max(0, Math.floor(x0 + lx * K * ta));
      const xb = Math.min(SW - 1, Math.ceil(x1 + lx * K * tb));
      for (let i = xa; i <= xb; i++) this.sm[j * SW + i] = 1;
    }
  }
  /** the same for a round footprint */
  castEllipse(cx: number, cy: number, rx: number, ry: number, z: number): void {
    if (this.mode !== 'shadow') return;
    const lx = z * 0.8;
    const ly = z * 0.46;
    const steps = Math.max(2, Math.ceil(Math.max(lx, ly) * K));
    for (let s = 0; s <= steps; s++) {
      const ox = (lx * s) / steps;
      const oy = (ly * s) / steps;
      const j0 = Math.floor((cy + oy - ry) * K);
      const j1 = Math.ceil((cy + oy + ry) * K);
      for (let j = Math.max(0, j0); j <= Math.min(SH - 1, j1); j++) {
        const ny = ((j + 0.5) / K - cy - oy) / ry;
        if (Math.abs(ny) > 1) continue;
        const hw = rx * Math.sqrt(1 - ny * ny);
        const i0 = Math.max(0, Math.floor((cx + ox - hw) * K));
        const i1 = Math.min(SW - 1, Math.ceil((cx + ox + hw) * K));
        for (let i = i0; i <= i1; i++) this.sm[j * SW + i] = 1;
      }
    }
  }
  /** softens the shadow mask's edge a little (one box blur) */
  blurShadow(): void {
    const src = this.sm.slice();
    for (let j = 1; j < SH - 1; j++) {
      for (let i = 1; i < SW - 1; i++) {
        let t = 0;
        for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) t += src[(j + dj) * SW + i + di];
        this.sm[j * SW + i] = t / 9;
      }
    }
  }
  /** paints the collected shadow over a region (default: everything): dark, soft, on whatever is there */
  flush(x = 0, y = 0, w = W, h = H): void {
    const x0 = Math.max(0, Math.floor(x * K));
    const x1 = Math.min(SW, Math.ceil((x + w) * K));
    const y0 = Math.max(0, Math.floor(y * K));
    const y1 = Math.min(SH, Math.ceil((y + h) * K));
    for (let j = y0; j < y1; j++) {
      for (let i = x0; i < x1; i++) {
        const m = this.sm[j * SW + i];
        if (m > 0.03) this.sp(i, j, [14, 18, 16], 128 * m);
      }
    }
  }
}

// ------------------------------------------------------------------------------------------------- high-camera forms
// The camera is high (about 60 degrees down). A footprint keeps its width and is only slightly squashed; a height z
// (sprite px) lifts a roof by z / 2 on screen, so a wall is a thin strip under its roof. Light comes from the top
// left: roofs are bright at the top left, the visible (south) wall strips are mid dark, and a long cast shadow falls
// toward the bottom right onto the ground. Shadows are collected in a mask first (mode 'shadow'), then painted once
// on the ground under the buildings, and again on ground-level floors (courtyard, streets).

const gr = (sx: number, sy: number, t = 0.05): number => 1 + (hash(sx, sy) - 0.5) * 2 * t;

interface SlabO {
  top?: C;
  wall?: C;
  /** a pitched roof: 'v' ridge runs up and down, 'h' runs left to right */
  ridge?: 'v' | 'h';
  courses?: boolean;
  tex?: number;
  windows?: boolean;
  seam?: number;
}

/** A block seen from above: (x, yb) is the ground bottom left of its footprint, w by d, z tall. */
function slab(p: Pix, x: number, yb: number, w: number, d: number, z: number, m: C, o: SlabO = {}): void {
  const zh = Math.max(0.8, z * 0.5);
  const y0 = yb - d - zh;
  if (p.mode === 'shadow') {
    p.cast(x, yb - d, w, d, z);
    return;
  }
  const top = o.top ?? m;
  const wall = o.wall ?? sh(m, 0.92);
  const tex = o.tex ?? 0.05;
  // the south wall strip
  p.fill(x, yb - zh, w, zh, (u, v, sx, sy) => {
    let f = 0.64 * (1.08 - 0.22 * v) * (1.04 - 0.1 * u);
    if (o.courses) {
      const ry = sy - Math.round((yb - zh) * K);
      const rx = sx - Math.round(x * K);
      const bh = 3;
      if (ry % bh === 0) f *= 0.82;
      else if ((rx + Math.floor(ry / bh) * 4) % 8 === 0) f *= 0.88;
    }
    return sh(wall, f * gr(sx, sy, tex));
  });
  if (o.windows && zh >= 2.2) {
    for (let r = 0; r + 1.4 <= zh - 0.8; r += 2.2) {
      for (let c = 1; c + 1 < w; c += 2) {
        const lit = hash(Math.round(x + c) * 7, Math.round(r) * 13 + 3) > 0.75;
        p.rect(x + c, yb - zh + 0.8 + r, 1, 1.1, lit ? sh(M.lamp, 0.95) : M.glass, 235);
      }
    }
  }
  // the roof
  p.fill(x, y0, w, d, (u, v, sx, sy) => {
    let f = 1.14 - 0.2 * u - 0.14 * v;
    if (o.ridge === 'v') f *= u < 0.5 ? 1.1 : 0.8;
    else if (o.ridge === 'h') f *= v < 0.5 ? 1.08 : 0.82;
    if (o.seam) {
      const rx = sx - Math.round(x * K);
      if (rx % Math.round(o.seam * K) === 0 && rx > 0) f *= 0.86;
    }
    return sh(top, f * gr(sx, sy, tex));
  });
  if (o.ridge === 'v') p.rect(x + w / 2 - 0.2, y0, 0.4, d, sh(top, 1.3));
  if (o.ridge === 'h') p.rect(x, y0 + d / 2 - 0.2, w, 0.4, sh(top, 1.3));
  p.rect(x, y0, w, 1 / K, sh(top, 1.34));
  p.rect(x, y0, 1 / K, d, sh(top, 1.24));
  p.rect(x + w - 1 / K, y0, 1 / K, d + zh, sh(wall, 0.5));
  p.rect(x, y0 + d - 1 / K, w, 1 / K, sh(top, 0.7));
  p.rect(x, yb - 1 / K, w, 1 / K, sh(wall, 0.4));
}

interface CylO {
  hollow?: boolean;
  dome?: boolean;
  top?: C;
}

/** A round tower, drum or pit seen from above. (cx, yb) is the bottom of its ground ellipse. */
function cyl(p: Pix, cx: number, yb: number, r: number, z: number, m: C, o: CylO = {}): void {
  const ry = r * 0.87;
  const gy = yb - ry;
  const zh = Math.max(0.7, z * 0.5);
  const ty = gy - zh;
  if (p.mode === 'shadow') {
    p.castEllipse(cx, gy, r, ry, z);
    return;
  }
  const top = o.top ?? m;
  const x0 = Math.floor((cx - r) * K);
  const x1 = Math.ceil((cx + r) * K);
  const y0 = Math.floor((ty - ry) * K);
  const y1 = Math.ceil((gy + ry) * K);
  for (let j = y0; j <= y1; j++) {
    for (let i = x0; i <= x1; i++) {
      const dx = (i + 0.5) / K - cx;
      const py = (j + 0.5) / K;
      const nx = dx / r;
      const qt = nx * nx + ((py - ty) / ry) ** 2;
      const qg = nx * nx + ((py - gy) / ry) ** 2;
      if (qt <= 1) {
        const ny = (py - ty) / ry;
        if (o.dome) {
          const z2 = Math.sqrt(Math.max(0, 1 - qt));
          const lam = -0.5 * nx - 0.6 * ny + 0.62 * z2;
          p.sp(i, j, sh(top, (0.62 + 0.62 * Math.max(0, Math.min(1, lam + 0.25))) * gr(i, j, 0.03)));
        } else if (o.hollow && qt < 0.5) {
          p.sp(i, j, sh(M.earth, (0.62 + 0.14 * (nx - ny)) * gr(i, j, 0.07)));
        } else {
          let f = 1.16 - 0.1 * (nx + ny) - 0.1 * qt;
          if (qt > 0.9) f *= 0.8;
          if (o.hollow && qt > 0.5 && qt < 0.56) f *= 0.72;
          p.sp(i, j, sh(top, f * gr(i, j, 0.05)));
        }
      } else if (Math.abs(nx) <= 1 && py > ty && (qg <= 1 || py <= gy)) {
        const f = 0.8 - 0.36 * ((nx + 1) / 2) - (qg > 0.86 ? 0.1 : 0);
        p.sp(i, j, sh(m, f * gr(i, j, 0.05)));
      }
    }
  }
}

/** A ground patch with a soft, slightly ragged edge: packed earth, paving or a concrete apron. */
function pad(p: Pix, x: number, y: number, w: number, h: number, c: C, a = 235, rr = 3.5, tex = 0.06): void {
  if (p.mode === 'shadow') return;
  const x0 = Math.floor(x * K);
  const x1 = Math.ceil((x + w) * K);
  const y0 = Math.floor(y * K);
  const y1 = Math.ceil((y + h) * K);
  const cx = x + w / 2;
  const cy = y + h / 2;
  for (let j = y0; j < y1; j++) {
    for (let i = x0; i < x1; i++) {
      const px = (i + 0.5) / K;
      const py = (j + 0.5) / K;
      const qx = Math.abs(px - cx) - (w / 2 - rr);
      const qy = Math.abs(py - cy) - (h / 2 - rr);
      const e = rr - (Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0));
      const al = Math.max(0, Math.min(1, e / 1.5 + (hash(i, j) - 0.5) * 0.5));
      if (al <= 0) continue;
      let f = 1.04 - 0.1 * ((px - x) / w) - 0.06 * ((py - y) / h);
      if (e < 0.8) f *= 0.84;
      p.sp(i, j, sh(c, f * gr(i, j, tex)), a * al);
    }
  }
}

/** Crenellations along a roof edge: small lit blocks with a gap between. */
function merlonsH(p: Pix, x: number, y: number, w: number, m: C, step = 2.2): void {
  if (p.mode === 'shadow') return;
  for (let s = 0; s + 1.2 <= w; s += step) {
    p.rect(x + s, y, 1.2, 0.9, sh(m, 1.18));
    p.rect(x + s, y + 0.9, 1.2, 0.34, sh(m, 0.6));
    p.rect(x + s + 1.2, y, step - 1.2, 0.6, sh(m, 0.62), 160);
  }
}
function merlonsV(p: Pix, x: number, y: number, h: number, m: C, step = 2.2): void {
  if (p.mode === 'shadow') return;
  for (let s = 0; s + 1.2 <= h; s += step) {
    p.rect(x, y + s, 0.9, 1.2, sh(m, 1.18));
    p.rect(x + 0.9, y + s, 0.34, 1.2, sh(m, 0.6));
  }
}

/** A tiny flag-pole pennant in the owner's colour, waving. */
function flag(p: Pix, x: number, yTop: number, h: number, own: C, wide = 6): void {
  if (p.mode === 'shadow') return;
  p.rect(x, yTop, 0.45, h, M.dkSteel);
  p.rect(x, yTop, 0.45, h, [255, 255, 255], 30);
  p.blob(x + 0.2, yTop - 0.3, 0.55, 0.55, [200, 190, 150]);
  const fh = Math.max(3.2, wide * 0.55);
  const cols = Math.round(wide * K);
  for (let i = 0; i < cols; i++) {
    const t = i / cols;
    const wave = Math.sin(i * 0.5) * 0.45 * t;
    const hh = fh * (1 - t * 0.35);
    p.fill(x + 0.45 + i / K, yTop + wave, 1 / K, hh, (_u, v) => sh(own, (1.12 - 0.34 * v) * (0.9 + 0.1 * Math.cos(i * 0.5))));
  }
  p.rect(x + 0.45, yTop, wide, 1 / K, sh(own, 1.3));
}

/** A band in the owner's colour: a stripe along a roof edge or wall. */
function band(p: Pix, x: number, y: number, w: number, own: C, hgt = 1.1): void {
  if (p.mode === 'shadow') return;
  p.fill(x, y, w, hgt, (_u, v) => sh(own, 1.2 - 0.4 * v));
}

/** A ring of sandbags (top view), a lit top and a dark underside. */
function sandRing(p: Pix, cx: number, cy: number, rx: number, ry: number): void {
  if (p.mode === 'shadow') {
    p.castEllipse(cx, cy, rx, ry, 1.6);
    return;
  }
  p.blob(cx, cy, rx - 0.6, ry - 0.5, [58, 52, 40], 255, 0.2);
  const n = 14;
  for (let i = 0; i < n; i++) {
    const a = (Math.PI * 2 * (i + 0.3)) / n;
    const bx = cx + Math.cos(a) * rx;
    const by = cy + Math.sin(a) * ry;
    const t = hash(i, 9);
    p.blob(bx, by + 0.25, 1.35, 0.95, sh(M.sand, 0.5), 255, 0.1);
    p.blob(bx, by, 1.3, 0.9, sh(M.sand, 0.9 + t * 0.2), 255, 0.5);
  }
}

/** A twin flak gun in a sandbag ring, barrels up and to the right. */
function flakGun(p: Pix, cx: number, cy: number): void {
  sandRing(p, cx, cy, 4.4, 3.7);
  if (p.mode === 'shadow') return;
  p.blob(cx + 0.7, cy + 0.9, 2.1, 1.5, [10, 12, 10], 120, 0.2);
  p.line(cx + 0.5, cy + 0.9, cx + 5.2, cy - 2.2, [16, 18, 18], 3, 110);
  p.blob(cx, cy, 1.9, 1.6, M.steel, 255, 0.6);
  p.line(cx - 0.4, cy - 0.4, cx + 4.6, cy - 3.2, M.dkSteel, 3);
  p.line(cx + 0.5, cy + 0.3, cx + 5.2, cy - 2.4, M.dkSteel, 3);
  p.line(cx - 0.4, cy - 0.7, cx + 4.4, cy - 3.5, sh(M.steel, 1.4), 1);
  p.rect(cx - 1.2, cy - 0.8, 2.3, 1.8, M.slate);
}

/** A czech hedgehog tank trap: three crossed steel bars, seen from above. */
function hedgehog(p: Pix, cx: number, cy: number): void {
  if (p.mode === 'shadow') {
    p.castEllipse(cx, cy, 1.9, 1.5, 2.6);
    return;
  }
  const bars: [number, number][] = [
    [2.5, 0.2],
    [1.3, -2.1],
    [-1.4, -2.0],
  ];
  for (const [dx, dy] of bars) p.line(cx - dx + 0.8, cy - dy + 0.9, cx + dx + 0.8, cy + dy + 0.9, [14, 16, 16], 3, 100);
  for (const [dx, dy] of bars) {
    p.line(cx - dx, cy - dy, cx + dx, cy + dy, M.dkSteel, 4);
    p.line(cx - dx - 0.1, cy - dy - 0.1, cx + dx - 0.1, cy + dy - 0.1, sh(M.steel, 1.25), 2);
  }
  p.blob(cx, cy, 0.7, 0.6, sh(M.steel, 1.2));
}

/** A radar dish on a low mast: a tilted dish, and a pale sweep wedge toward the upper right (kept inside the sprite). */
function radar(p: Pix, cx: number, cy: number, own: C): void {
  if (p.mode === 'shadow') {
    p.castEllipse(cx, cy + 1.5, 2.6, 2.2, 7);
    return;
  }
  const R = 10.5;
  const a0 = (-85 * Math.PI) / 180;
  const a1 = (-15 * Math.PI) / 180;
  const x0 = Math.floor((cx - 1) * K);
  const x1 = Math.ceil((cx + R) * K);
  const y0 = Math.floor((cy - R - 1) * K);
  const y1 = Math.ceil((cy + 2) * K);
  for (let j = y0; j <= y1; j++) {
    for (let i = x0; i <= x1; i++) {
      const dx = (i + 0.5) / K - cx;
      const dy = (j + 0.5) / K - cy;
      const rr = Math.hypot(dx, dy);
      if (rr > R || rr < 1.5) continue;
      const a = Math.atan2(dy, dx);
      if (a < a0 || a > a1) continue;
      const k = 1 - rr / R;
      const edge = Math.min(1, (a - a0) / 0.12, (a1 - a) / 0.12);
      p.sp(i, j, [90, 235, 140], 120 * k * Math.max(0.3, edge) + 22);
    }
  }
  cyl(p, cx, cy + 3.2, 2.5, 3.5, M.conc);
  // the dish: a bright rim, a hollow inside, a feed arm
  p.blob(cx + 0.3, cy - 1.8, 4.9, 3.9, sh(M.white, 0.95), 255, 0.5);
  p.blob(cx + 0.9, cy - 1.5, 3.7, 2.9, M.slate, 255, 0.3);
  p.line(cx + 0.9, cy - 1.5, cx + 4.6, cy - 5.2, M.dkSteel, 2);
  p.blob(cx + 4.6, cy - 5.2, 0.8, 0.8, M.dkSteel);
  band(p, cx - 2.2, cy + 1.4, 4.4, own, 0.9);
}

/** A coastal gun in a round concrete pit, the barrel out toward the sea (right and down). */
function coastalGun(p: Pix, cx: number, cy: number, own: C): void {
  cyl(p, cx, cy + 4.3, 4.9, 2.4, M.conc, { hollow: true });
  if (p.mode === 'shadow') return;
  p.line(cx + 1, cy + 1.6, cx + 9.2, cy + 5.6, [12, 14, 12], 4, 100);
  p.blob(cx, cy, 3.1, 2.7, sh(M.steel, 1.0), 255, 0.6);
  p.line(cx + 0.5, cy + 0.2, cx + 8.2, cy + 3.8, M.dkSteel, 4);
  p.line(cx + 0.5, cy - 0.2, cx + 8.0, cy + 3.4, sh(M.steel, 1.4), 1);
  p.blob(cx + 8.2, cy + 3.8, 0.9, 0.8, [24, 26, 26]);
  band(p, cx - 1.6, cy - 0.4, 3.2, own, 0.9);
}

/** The small level number plate in the corner (the digit is drawn on the canvas afterwards). */
function levelBadge(p: Pix, x: number, y: number): void {
  const bw = 9;
  const bh = 10;
  p.rect(x + 0.4, y + 0.6, bw, bh, [8, 10, 12], 90);
  p.fill(x, y, bw, bh, (u, v) => {
    const cx = Math.abs(u - 0.5) * 2;
    const cy = Math.abs(v - 0.5) * 2;
    if (cx > 0.82 && cy > 0.82) return null;
    if (cx > 0.9 || cy > 0.9) return [166, 168, 160];
    return sh([30, 34, 38], 1.08 - 0.25 * v);
  });
}

type Addon = 'flak' | 'traps' | 'radar' | 'guns' | null;

interface Builder {
  /** flat ground work under the shadows: pads, moats, paths */
  ground: (p: Pix, own: C, lv: number, addon: Addon) => void;
  /** everything standing up, drawn twice: once to collect shadows, once for real */
  body: (p: Pix, own: C, lv: number, addon: Addon) => void;
}

// ------------------------------------------------------------------------------------------------- fort

interface FortCfg {
  x: number;
  yb: number;
  w: number;
  d: number;
  t: number;
  wz: number;
  tz: number;
  r: number;
}
function fortCfg(lv: number): FortCfg {
  if (lv >= 5) return { x: 6, yb: 42, w: 38, d: 26, t: 4.2, wz: 11, tz: 15, r: 4.8 };
  if (lv >= 3) return { x: 8, yb: 38, w: 29, d: 21, t: 3.4, wz: 8, tz: 12, r: 4.1 };
  return { x: 10, yb: 35, w: 25, d: 17, t: 2.8, wz: 6, tz: 8, r: 3.1 };
}

function fortGround(p: Pix, _own: C, lv: number, _addon: Addon): void {
  const c = fortCfg(lv);
  const mo = lv >= 5 ? 3.4 : 0;
  pad(p, c.x - 3 - mo, c.yb - c.d - 4 - mo, c.w + 6 + mo * 2, c.d + 9 + mo * 2, M.earth, 205, 4.5);
  if (lv >= 5) {
    // a moat ring around the wall, a plank bridge in front of the gate
    const mx = c.x - mo;
    const my = c.yb - c.d - mo;
    pad(p, mx, my, c.w + mo * 2, c.d + mo * 2, [52, 86, 100], 250, 3.2, 0.04);
    pad(p, c.x - 0.8, c.yb - c.d - 0.8, c.w + 1.6, c.d + 1.6, M.earth, 255, 2, 0.05);
    p.rect(c.x + c.w / 2 - 2.2, c.yb, 4.4, mo + 0.6, M.teak);
    for (let s = 0.4; s < mo + 0.6; s += 1) p.rect(c.x + c.w / 2 - 2.2, c.yb + s, 4.4, 0.25, sh(M.teak, 0.7));
  } else {
    p.rect(c.x + c.w / 2 - 2, c.yb, 4, 5, sh(M.sand, 0.92), 220);
  }
}

function fortBody(p: Pix, o: C, lv: number, addon: Addon): void {
  const own = ownTone(o);
  const c = fortCfg(lv);
  const { x, yb, w, d, t, wz, tz, r } = c;
  const zh = Math.max(0.8, wz * 0.5);
  const y0 = yb - d - zh;
  const cxm = x + w / 2;
  const shadow = p.mode === 'shadow';
  const corners: [number, number][] = [
    [x, yb - d],
    [x + w, yb - d],
    [x, yb],
    [x + w, yb],
  ];

  // the wall ring
  if (shadow) {
    p.cast(x, yb - d, w, t, wz);
    p.cast(x, yb - t, w, t, wz);
    p.cast(x, yb - d, t, d, wz);
    p.cast(x + w - t, yb - d, t, d, wz);
  } else {
    slab(p, x, yb, w, d, wz, M.stone, { courses: true, top: M.conc, tex: 0.05 });
    // inside: the far wall's inner face, then the courtyard floor
    const fy = y0 + t;
    p.fill(x + t, fy, w - 2 * t, zh, (u, v, sx, sy) => sh(M.stone, (0.98 - 0.24 * v) * (1.04 - 0.1 * u) * gr(sx, sy, 0.06)));
    for (let s = x + t + 2; s < x + w - t - 1; s += 3.4) p.rect(s, fy + zh * 0.35, 0.7, Math.min(1.6, zh * 0.5), [26, 28, 28]);
    const fh = y0 + d - t - fy - zh;
    p.fill(x + t, fy + zh, w - 2 * t, fh, (u, v, sx, sy) => sh(M.earth, (1.0 - 0.14 * u) * (0.98 + 0.06 * v) * gr(sx, sy, 0.08)));
    p.flush(x + t, fy + zh, w - 2 * t, fh);
    // crenellations on the outer edges of the wall top
    merlonsH(p, x + 0.4, y0, w - 0.8, M.conc);
    merlonsH(p, x + 0.4, y0 + d - 1.3, w - 0.8, M.conc);
    merlonsV(p, x, y0 + 1, d - 2, M.conc);
    merlonsV(p, x + w - 1.3, y0 + 1, d - 2, M.conc);
  }

  // inside the walls: huts (level 1), a keep (level 3), a keep and barracks inside an inner wall (level 5)
  const ky = y0 + d - t - 1.2;
  if (lv <= 1) {
    slab(p, cxm - 3.5, ky, 7, 4.2, 4, M.clay, { ridge: 'h', top: M.clay });
    slab(p, x + t + 1.6, ky - 0.6, 4, 3, 3, M.brick, { ridge: 'v', top: M.brick });
  } else if (lv <= 3) {
    slab(p, cxm - 5.2, ky, 10.4, 6.4, 10, M.cream, { top: M.slate, ridge: 'h', courses: true });
    band(p, cxm - 5.2, ky - 6.4 - 5 + 0.2, 10.4, own, 1.2);
    slab(p, x + t + 1.4, ky + 0.2, 5, 3.6, 4, M.brick, { ridge: 'v', top: M.clay });
    slab(p, x + w - t - 6.4, ky + 0.2, 5, 3.6, 4, M.brick, { ridge: 'v', top: M.clay });
  } else {
    // the inner wall and a tall keep with a dome and a coloured banner band
    slab(p, cxm - 11, ky + 0.6, 22, 12.4, 5, M.stone, { courses: true, top: M.conc });
    if (!shadow) {
      const iy = ky + 0.6 - 12.4 - 2.5 + 1.4;
      p.fill(cxm - 9.6, iy, 19.2, 9.4, (u, v, sx, sy) => sh(M.earth, (1.0 - 0.14 * u) * gr(sx, sy, 0.08)));
      p.flush(cxm - 9.6, iy, 19.2, 9.4);
    }
    slab(p, cxm - 6.5, ky - 1.4, 13, 8.2, 14, M.cream, { top: M.slate, ridge: 'h', courses: true, windows: true });
    cyl(p, cxm, ky - 8.6, 3.3, 5, M.cream, { dome: true, top: sh(M.moss, 1.05) });
    band(p, cxm - 6.5, ky - 1.4 - 8.2 - 7 + 0.2, 13, own, 1.4);
    flag(p, cxm + 0.2, ky - 21, 8, own, 5.6);
    slab(p, x + t + 1.4, ky - 4.4, 6, 4.2, 6, M.brick, { ridge: 'v', top: M.clay });
    slab(p, x + w - t - 7.4, ky - 4.4, 6, 4.2, 6, M.brick, { ridge: 'v', top: M.clay });
  }

  // the towers: back ones first, front ones after the gate house (they stand in front)
  const towerAt = (cx: number, cyG: number): void => {
    cyl(p, cx, cyG + r * 0.87, r, tz, M.stone, { hollow: true, top: M.conc });
  };
  if (lv >= 5) towerAt(cxm, yb - d + 0.4);
  towerAt(corners[0][0], corners[0][1]);
  towerAt(corners[1][0], corners[1][1]);

  // the gate house in the middle of the south wall (a dark arch in the wall strip, a coloured band on its roof)
  const gw = lv >= 5 ? 9 : lv >= 3 ? 7.4 : 6.2;
  const gd = t + 1.6;
  slab(p, cxm - gw / 2, yb + 0.4, gw, gd, wz + 2, M.stone, { top: M.conc, courses: true });
  if (!shadow) {
    const gzh = Math.max(0.8, (wz + 2) * 0.5);
    const aw = gw * 0.5;
    p.fill(cxm - aw / 2, yb + 0.4 - gzh + 0.6, aw, gzh - 0.6, (_u, v) => sh([22, 22, 24], 1.1 - 0.5 * v));
    p.rect(cxm - aw / 2 - 0.4, yb + 0.4 - gzh + 0.2, aw + 0.8, 0.6, sh(M.conc, 1.2));
    band(p, cxm - gw / 2, yb + 0.4 - gd - gzh + 0.2, gw, own, 1.2);
    merlonsH(p, cxm - gw / 2 + 0.3, yb + 0.4 - gd - gzh + 1.5, gw - 0.6, M.conc);
  }
  towerAt(corners[2][0], corners[2][1]);
  towerAt(corners[3][0], corners[3][1]);
  if (!shadow) {
    const fl = lv >= 5 ? 7 : lv >= 3 ? 7 : 5.5;
    const tcy = corners[1][1] - tz * 0.5;
    if (lv < 5) flag(p, corners[1][0] - 0.2, tcy - fl - 0.8, fl, own, 5);
    if (lv >= 5) flag(p, corners[0][0] - 0.2, tcy - fl - 0.8, fl, own, 6.4);
    // trim: a coloured stripe on the front pair of tower drums
    for (const [cx, cy] of [corners[2], corners[3]]) band(p, cx - r * 0.55, cy - tz * 0.5 + r * 0.87 + 0.1, r * 1.1, own, 0.8);
  }

  // add-ons
  if (addon === 'flak') {
    flakGun(p, x - 1.5, yb + 8.5);
    flakGun(p, x + w + 1.5, yb + 8.5);
  }
  if (addon === 'traps') {
    const ty = yb + 8;
    for (let hx = x - 4; hx <= x + w + 4; hx += 5.6) if (Math.abs(hx - cxm) > 4) hedgehog(p, hx, ty + (hash(Math.round(hx), 4) - 0.5) * 1.4);
    for (let hy = yb - d + 8; hy < yb; hy += 7) {
      hedgehog(p, x - 4.2, hy);
      hedgehog(p, x + w + 4.2, hy);
    }
  }
}

// ------------------------------------------------------------------------------------------------- city

interface Lot {
  x: number;
  yb: number;
  w: number;
  d: number;
  z: number;
  roof: C;
  kind: 'house' | 'tower' | 'hall';
}

function cityLots(lv: number): Lot[] {
  const R = [M.clay, M.slate, M.brick, M.cream, M.ochre, M.rust, M.fadedBlue];
  const k = (i: number): C => R[i % R.length];
  if (lv >= 5) {
    return [
      { x: 6, yb: 24, w: 9, d: 7, z: 20, roof: M.slate, kind: 'tower' },
      { x: 17.5, yb: 23, w: 8, d: 6, z: 7, roof: k(0), kind: 'house' },
      { x: 28, yb: 24, w: 9, d: 7, z: 8, roof: k(3), kind: 'house' },
      { x: 39.5, yb: 23, w: 8, d: 6, z: 6, roof: k(2), kind: 'house' },
      { x: 5, yb: 35, w: 8, d: 7, z: 9, roof: k(4), kind: 'house' },
      { x: 15.5, yb: 36, w: 10, d: 8, z: 16, roof: M.cream, kind: 'tower' },
      { x: 28, yb: 35, w: 8, d: 7, z: 6, roof: k(6), kind: 'house' },
      { x: 38.5, yb: 36, w: 9, d: 8, z: 11, roof: k(1), kind: 'house' },
      { x: 5.5, yb: 46, w: 9, d: 7, z: 6, roof: k(5), kind: 'house' },
      { x: 17, yb: 46, w: 7, d: 6, z: 5, roof: k(0), kind: 'house' },
      { x: 26.5, yb: 47, w: 11, d: 8, z: 13, roof: M.slate, kind: 'tower' },
      { x: 39.5, yb: 46, w: 8, d: 7, z: 6, roof: k(3), kind: 'house' },
    ];
  }
  if (lv >= 3) {
    return [
      { x: 6, yb: 25, w: 8, d: 7, z: 12, roof: M.slate, kind: 'tower' },
      { x: 16.5, yb: 24, w: 8, d: 6, z: 6, roof: k(0), kind: 'house' },
      { x: 27, yb: 25, w: 8, d: 7, z: 6, roof: k(2), kind: 'house' },
      { x: 37.5, yb: 24, w: 7, d: 6, z: 5, roof: k(4), kind: 'house' },
      { x: 6, yb: 36, w: 8, d: 7, z: 5, roof: k(5), kind: 'house' },
      { x: 16.5, yb: 37, w: 10, d: 8, z: 7, roof: M.cream, kind: 'hall' },
      { x: 29, yb: 36, w: 8, d: 7, z: 9, roof: k(6), kind: 'house' },
      { x: 39.5, yb: 36, w: 6, d: 6, z: 5, roof: k(3), kind: 'house' },
    ];
  }
  return [
    { x: 9, yb: 30, w: 8, d: 6, z: 3.4, roof: M.clay, kind: 'house' },
    { x: 21, yb: 29, w: 8, d: 6, z: 3.4, roof: M.slate, kind: 'house' },
    { x: 32, yb: 30, w: 7, d: 6, z: 3.4, roof: M.brick, kind: 'house' },
    { x: 8, yb: 41, w: 7, d: 6, z: 3, roof: M.ochre, kind: 'house' },
    { x: 18.5, yb: 42, w: 11, d: 8, z: 5.5, roof: M.cream, kind: 'hall' },
    { x: 32.5, yb: 41, w: 7, d: 6, z: 3.4, roof: M.rust, kind: 'house' },
  ];
}

function cityPadRect(lv: number): [number, number, number, number] {
  if (lv >= 5) return [2, 9, 50, 45];
  if (lv >= 3) return [3, 13, 46, 35];
  return [5, 18, 38, 31];
}

function cityGround(p: Pix, _own: C, lv: number, _addon: Addon): void {
  const [x, y, w, h] = cityPadRect(lv);
  pad(p, x, y, w, h, M.asphalt, 235, 4);
  if (lv >= 3) for (let s = x + 3; s < x + w - 3; s += 4) p.rect(s, y + h * 0.5 - 0.1, 1.8, 0.4, [190, 186, 160], 150);
  if (lv >= 5) pad(p, 23.5, 25, 6, 5, M.moss, 245, 1.6, 0.1);
  else if (lv >= 3) pad(p, 33, 27.2, 5.4, 4.4, M.moss, 245, 1.6, 0.1);
  else pad(p, 33.5, 35.2, 6, 5, M.moss, 245, 1.6, 0.1);
}

function cityBody(p: Pix, o: C, lv: number, addon: Addon): void {
  const own = ownTone(o);
  const shadow = p.mode === 'shadow';
  const lots = cityLots(lv).slice().sort((a, b) => a.yb - b.yb || a.x - b.x);
  if (!shadow && lv >= 3) {
    const tr: [number, number][] = lv >= 5 ? [[25.5, 28], [28, 29]] : [[35.4, 30.6]];
    for (const [tx, ty] of tr) {
      p.blob(tx + 0.8, ty + 0.9, 2.0, 1.6, [20, 28, 20], 120, 0.2);
      p.blob(tx, ty, 1.9, 1.7, sh(M.olive, 0.95), 255, 0.6);
    }
  }
  for (const l of lots) {
    const tall = l.kind === 'tower';
    slab(p, l.x, l.yb, l.w, l.d, l.z, tall ? M.conc : sh(M.cream, 0.92), {
      top: l.roof,
      ridge: !tall && l.kind !== undefined ? (l.w >= l.d ? 'h' : 'v') : undefined,
      windows: l.z >= 8,
      courses: !tall && l.z < 8,
      seam: tall ? 3 : undefined,
    });
    if (shadow) continue;
    const zh = Math.max(0.8, l.z * 0.5);
    const y0 = l.yb - l.d - zh;
    if (tall) {
      p.rect(l.x + 1.2, y0 + 1.2, 2.6, 1.8, sh(l.roof, 0.7));
      p.rect(l.x + l.w - 3.8, y0 + l.d - 3, 2.4, 1.6, sh(l.roof, 0.78));
      if (l.z >= 15) {
        band(p, l.x, y0 + l.d - 1.5, l.w, own, 1.3);
        p.line(l.x + l.w - 2, y0 + 2, l.x + l.w - 2, y0 - 3, M.dkSteel, 1);
        p.blob(l.x + l.w - 2, y0 - 3, 0.5, 0.5, [210, 80, 70]);
      }
    }
    if (l.kind === 'hall') {
      band(p, l.x, y0 + l.d - 1.5, l.w, own, 1.0);
      flag(p, l.x + l.w - 2.4, y0 - 5, 6.8, own, 5);
    }
    if (l.kind === 'house' && l.z >= 9) band(p, l.x, y0 + l.d - 1.3, l.w, own, 0.9);
  }
  if (addon === 'flak') {
    const [x, y, w, h] = cityPadRect(lv);
    flakGun(p, x + w - 4, y + h - 5);
    flakGun(p, x + 5, y + h - 4);
  }
}

// ------------------------------------------------------------------------------------------------- SAM site

/** A truck launcher seen from above: chassis, cab, wheels and a rack of missiles leaning to the upper right. */
function launcher(p: Pix, x: number, yb: number, own: C): void {
  const cw = 12;
  const cd = 5.2;
  if (p.mode === 'shadow') {
    p.cast(x, yb - cd, cw, cd, 4);
    p.cast(x + 3, yb - cd - 3, 8, 3, 7);
    return;
  }
  for (const wx of [x + 1.2, x + 5, x + 8.6]) p.rect(wx, yb - 0.4, 2, 1.2, [24, 26, 26]);
  slab(p, x, yb, cw, cd, 2.6, M.olive, { top: sh(M.olive, 1.05), tex: 0.07 });
  const zh = 1.3;
  const y0 = yb - cd - zh;
  p.fill(x, y0, 3.4, cd, (u, v, sx, sy) => sh(M.olive, (1.2 - 0.2 * u - 0.1 * v) * gr(sx, sy)));
  p.rect(x + 0.4, y0 + 0.6, 0.9, cd - 1.2, M.glass);
  p.rect(x, y0, 3.4, 1 / K, sh(M.olive, 1.5));
  band(p, x + 3.8, y0 + cd - 1.2, 7.6, own, 0.9);
  for (let m = 0; m < 4; m++) {
    const mx = x + 4.2 + m * 1.55;
    const my = y0 + cd * 0.62;
    p.line(mx + 0.7, my + 1.0, mx + 7.2, my - 3.0, [12, 14, 12], 3, 90);
  }
  for (let m = 0; m < 4; m++) {
    const mx = x + 4.2 + m * 1.55;
    const my = y0 + cd * 0.62;
    p.line(mx, my, mx + 6.6, my - 4.0, sh(M.white, 0.82), 4);
    p.line(mx - 0.2, my - 0.2, mx + 6.4, my - 4.2, sh(M.white, 1.1), 2);
    p.blob(mx + 6.9, my - 4.2, 0.65, 0.65, own);
  }
}

function samPad(lv: number): [number, number, number, number] {
  return lv >= 3 ? [3, 12, 46, 36] : [6, 20, 38, 27];
}

function samGround(p: Pix, _own: C, lv: number, _addon: Addon): void {
  const [x, y, w, h] = samPad(lv);
  pad(p, x - 1.2, y - 1.2, w + 2.4, h + 2.4, M.earth, 190, 4.5);
  pad(p, x, y, w, h, sh(M.conc, 0.98), 245, 3.5, 0.05);
}

function samBody(p: Pix, o: C, lv: number, addon: Addon): void {
  const own = ownTone(o);
  const shadow = p.mode === 'shadow';
  const [x, y, w, h] = samPad(lv);
  if (!shadow) {
    for (let s = x + 1; s < x + w - 1; s += 3) {
      p.rect(s, y + 0.7, 0.5, 0.9, M.dkSteel);
      p.rect(s, y + h - 1.6, 0.5, 0.9, M.dkSteel);
    }
    for (let s = y + 2; s < y + h - 1; s += 3) {
      p.rect(x + 0.7, s, 0.9, 0.5, M.dkSteel);
      p.rect(x + w - 1.6, s, 0.9, 0.5, M.dkSteel);
    }
    p.rect(x + 0.9, y + 0.9, w - 1.8, 0.25, [150, 154, 150], 110);
    p.rect(x + 0.9, y + h - 1.4, w - 1.8, 0.25, [150, 154, 150], 110);
  }
  if (lv >= 3) {
    // a control hut and a mast at the back, three launchers (two in front, one behind between them)
    slab(p, x + 4, y + 13, 8, 5, 4.5, M.cream, { top: M.slate, ridge: 'h' });
    band(p, x + 4, y + 13 - 5 - 2.25 + 0.2, 8, own, 0.9);
    slab(p, x + 36, y + 11, 5, 3.6, 3.6, M.dkSteel, { top: M.steel });
    launcher(p, 17, 28, own);
    launcher(p, 7, 42, own);
    launcher(p, 27, 42, own);
    if (!shadow) {
      p.line(x + 40, y + 6, x + 40, y + 11, M.dkSteel, 1);
      p.blob(x + 40, y + 5.6, 0.6, 0.6, [210, 80, 70]);
    }
  } else {
    slab(p, x + 27, y + 12, 8, 5, 4.2, M.cream, { top: M.slate, ridge: 'h' });
    band(p, x + 27, y + 12 - 5 - 2.1 + 0.2, 8, own, 0.9);
    launcher(p, x + 4, y + 24, own);
  }
  if (addon === 'radar') radar(p, lv >= 3 ? 15 : x + 8, lv >= 3 ? 24 : y + 8, own);
}

// ------------------------------------------------------------------------------------------------- port

function portGround(p: Pix, _own: C, lv: number, _addon: Addon): void {
  if (lv >= 3) pad(p, 2, 9, 33, 41, sh(M.conc, 0.92), 245, 3.5);
  else pad(p, 2, 14, 32, 32, sh(M.conc, 0.92), 245, 3.5);
}

function pier(p: Pix, x: number, y: number, w: number, d: number): void {
  if (p.mode === 'shadow') {
    p.cast(x, y, w, d, 1.2);
    return;
  }
  p.fill(x, y, w, d, (u, v, sx, sy) => {
    const rx = sx - Math.round(x * K);
    let f = (Math.floor(rx / 6) % 2 === 0 ? 1.04 : 0.94) * (1.08 - 0.14 * v - 0.06 * u);
    if (rx % 6 === 0) f *= 0.8;
    return sh(M.teak, f * gr(sx, sy, 0.06));
  });
  p.rect(x, y, w, 1 / K, sh(M.teak, 1.3));
  p.rect(x, y + d - 1 / K, w, 1 / K, sh(M.teak, 0.55));
  for (let s = x + 3; s < x + w - 1; s += 6) p.blob(s, y + d - 0.2, 0.55, 0.45, M.dkSteel);
}

/** A gantry crane from above: a base block on the quay, a long boom out over the water, a counterweight. */
function crane(p: Pix, x: number, yb: number, len: number, own: C): void {
  slab(p, x, yb, 5, 4.4, 9, M.ochre, { top: sh(M.ochre, 1.05) });
  if (p.mode === 'shadow') {
    p.cast(x + 3, yb - 4.4 - 2, len, 1.3, 11);
    return;
  }
  const by = yb - 4.4 - 4.5 + 2.2;
  p.line(x + 3, by + 0.2, x + 3 + len, by - 0.9, [12, 14, 12], 4, 90);
  p.line(x + 3, by, x + 3 + len, by - 1.1, M.ochre, 4);
  p.line(x + 3, by - 0.3, x + 3 + len, by - 1.4, sh(M.ochre, 1.3), 1);
  for (let s = 2; s < len; s += 2.6) p.rect(x + 3 + s, by - 1.4, 0.4, 1.5, sh(M.ochre, 0.7));
  p.rect(x - 2.6, by - 1.4, 3.2, 2.6, M.dkSteel);
  p.rect(x + 3 + len - 1.4, by - 1.6, 1.4, 1.6, M.dkSteel);
  band(p, x + 0.4, by + 1.6, 4.2, own, 0.9);
}

function containers(p: Pix, x: number, yb: number, nx: number, ny: number, seed: number, own: C | null): void {
  const cols: C[] = [M.rust, M.fadedBlue, M.ochre, M.moss, M.brick, M.slate];
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const c = cols[Math.floor(hash(i + seed, j * 5 + seed) * cols.length)];
      slab(p, x + i * 5.4, yb + j * 3.5 - (ny - 1) * 3.5, 5, 3, 2.6 + (hash(i, j + seed) > 0.6 ? 2.6 : 0), c, { seam: 1.25, tex: 0.07 });
    }
  }
  if (own) band(p, x, yb - (ny - 1) * 3.5 - 3 - 1.3 + 0.3, 5, own, 0.8);
}

function ship(p: Pix, x: number, y: number, w: number, d: number, own: C): void {
  if (p.mode === 'shadow') {
    p.cast(x, y, w, d, 3);
    return;
  }
  const n = Math.round(w * K);
  for (let i = 0; i < n; i++) {
    const u = i / n;
    const taper = u > 0.8 ? 1 - ((u - 0.8) / 0.2) ** 1.6 : 1;
    const hh = d * taper;
    const yy = y + (d - hh) / 2;
    p.fill(x + i / K, yy, 1 / K, hh, (_u, v, sx, sy) => sh(M.slate, (1.02 - 0.3 * Math.abs(v - 0.3)) * gr(sx, sy, 0.05)));
  }
  p.rect(x + w * 0.04, y, w * 0.76, 0.5, sh(M.slate, 1.3));
  band(p, x + w * 0.04, y + d - 1.1, w * 0.78, own, 0.7);
  for (let i = 0; i < 4; i++) {
    const c: C = [M.rust, M.fadedBlue, M.ochre, M.moss][i % 4];
    slab(p, x + w * 0.28 + i * 3.4, y + d - 1.2, 3, 3.2, 2, c, { seam: 1, tex: 0.07 });
  }
  slab(p, x + 1.2, y + d - 0.8, 3.6, d - 1.6, 5, M.white, { top: sh(M.white, 1.05) });
}

function portBody(p: Pix, o: C, lv: number, addon: Addon): void {
  const own = ownTone(o);
  const shadow = p.mode === 'shadow';
  if (lv >= 3) {
    pier(p, 31, 17, 22, 6.4);
    pier(p, 31, 36, 22, 6.4);
    ship(p, 33, 25, 19, 8.6, own);
    slab(p, 5, 24, 13, 8, 6, M.cream, { top: M.slate, ridge: 'h', courses: true });
    slab(p, 20, 24, 10, 8, 6, M.cream, { top: sh(M.brick, 1.0), ridge: 'h', courses: true });
    band(p, 5, 24 - 8 - 3 + 0.2, 13, own, 1.0);
    if (!shadow) flag(p, 28.2, 24 - 8 - 3 - 4.6, 7, own, 5);
    containers(p, 5, 41, 3, 2, 2, own);
    containers(p, 22, 46, 2, 2, 7, null);
    crane(p, 27, 20, 20, own);
    crane(p, 27, 40, 20, own);
    if (addon === 'guns') {
      coastalGun(p, 9, 14, own);
      coastalGun(p, 8, 48, own);
    }
  } else {
    pier(p, 29, 25, 21, 6.4);
    slab(p, 5, 31, 12, 8, 5, M.cream, { top: M.slate, ridge: 'h', courses: true });
    band(p, 5, 31 - 8 - 2.5 + 0.2, 12, own, 1.0);
    if (!shadow) flag(p, 14.6, 31 - 8 - 2.5 - 4.6, 7, own, 5);
    containers(p, 6, 44, 2, 2, 4, own);
    containers(p, 19, 43, 1, 2, 9, null);
    crane(p, 25, 28, 18, own);
    if (addon === 'guns') {
      coastalGun(p, 8, 20, own);
      coastalGun(p, 22, 46, own);
    }
  }
}

const BUILDERS: Record<string, Builder> = {
  fort: { ground: fortGround, body: fortBody },
  city: { ground: cityGround, body: cityBody },
  sam: { ground: samGround, body: samBody },
  port: { ground: portGround, body: portBody },
};

/** A tiny anchor mark for the port, where the shape alone might not say "port". */
function anchorBadge(p: Pix, x: number, y: number): void {
  const wh = [226, 228, 220];
  p.fill(x, y, 8, 8, (u, v) => {
    const dx = (u - 0.5) * 2;
    const dy = (v - 0.5) * 2;
    if (dx * dx + dy * dy > 1) return null;
    return sh([34, 40, 44], 1.1 - 0.3 * v);
  });
  p.rect(x + 3.7, y + 1.6, 0.7, 4.8, wh);
  p.rect(x + 2.5, y + 2.4, 3, 0.6, wh);
  p.line(x + 1.9, y + 4.4, x + 3.9, y + 6.4, wh, 2);
  p.line(x + 6.1, y + 4.4, x + 4.1, y + 6.4, wh, 2);
}

// ------------------------------------------------------------------------------------------------- bake

export interface BuildingSpec {
  type: 'fort' | 'city' | 'sam' | 'port';
  level: number;
  addon: Addon;
}

const cache = new Map<string, HTMLCanvasElement>();

/** The sprite of a building for an owner colour: a soft shadow, the shaded building, the level number plate. */
export function bakeBuilding(spec: BuildingSpec, owner: RGB): HTMLCanvasElement {
  const key = `${spec.type}|${spec.level}|${spec.addon}|${owner.join(',')}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const p = new Pix();
  const b = BUILDERS[spec.type];
  b.ground(p, owner, spec.level, spec.addon);
  // pass 1: collect the cast shadows, paint them on the ground; pass 2: the buildings (floors take the shadow again)
  p.mode = 'shadow';
  b.body(p, owner, spec.level, spec.addon);
  p.blurShadow();
  p.mode = 'draw';
  p.flush();
  b.body(p, owner, spec.level, spec.addon);
  if (spec.type === 'port') anchorBadge(p, 0.5, 1);
  levelBadge(p, BADGE_X, 0.6);
  const c = document.createElement('canvas');
  c.width = SW;
  c.height = SH;
  const cx = c.getContext('2d');
  if (cx) {
    const img = cx.createImageData(SW, SH);
    img.data.set(p.d);
    cx.putImageData(img, 0, 0);
    cx.font = '800 27px "DM Sans", system-ui, sans-serif';
    cx.textAlign = 'center';
    cx.textBaseline = 'middle';
    cx.fillStyle = '#f4f2e8';
    cx.fillText(String(spec.level), (BADGE_X + 4.5) * K, (0.6 + 5) * K + 1.5);
  }
  cache.set(key, c);
  return c;
}

// ------------------------------------------------------------------------------------------------- the sheet

const BLUE: RGB = [64, 160, 255];
const RED: RGB = [226, 74, 60];

interface Row {
  title: string;
  spec: BuildingSpec;
}
const GROUPS: { name: string; rows: Row[] }[] = [
  {
    name: 'Fort',
    rows: [
      { title: 'Fort, level 1', spec: { type: 'fort', level: 1, addon: null } },
      { title: 'Fort, level 3', spec: { type: 'fort', level: 3, addon: null } },
      { title: 'Fort, level 5', spec: { type: 'fort', level: 5, addon: null } },
      { title: 'Fort level 3 with flak guns (add-on)', spec: { type: 'fort', level: 3, addon: 'flak' } },
      { title: 'Fort level 3 with tank traps (add-on)', spec: { type: 'fort', level: 3, addon: 'traps' } },
    ],
  },
  {
    name: 'City',
    rows: [
      { title: 'City, level 1', spec: { type: 'city', level: 1, addon: null } },
      { title: 'City, level 3', spec: { type: 'city', level: 3, addon: null } },
      { title: 'City, level 5', spec: { type: 'city', level: 5, addon: null } },
      { title: 'City level 3 with flak (add-on)', spec: { type: 'city', level: 3, addon: 'flak' } },
    ],
  },
  {
    name: 'SAM site',
    rows: [
      { title: 'SAM site, level 1', spec: { type: 'sam', level: 1, addon: null } },
      { title: 'SAM site, level 3', spec: { type: 'sam', level: 3, addon: null } },
      { title: 'SAM site level 1 with radar dish (add-on)', spec: { type: 'sam', level: 1, addon: 'radar' } },
    ],
  },
  {
    name: 'Port',
    rows: [
      { title: 'Port, level 1', spec: { type: 'port', level: 1, addon: null } },
      { title: 'Port, level 3', spec: { type: 'port', level: 3, addon: null } },
      { title: 'Port level 3 with coastal guns (add-on)', spec: { type: 'port', level: 3, addon: 'guns' } },
    ],
  },
];

const LABEL_W = 232;
const PAD = 8;
const COLS = [
  { head: 'Close zoom', sub: 'Blue nation', w: W * SCALE_CLOSE + PAD * 2 },
  { head: 'Close zoom', sub: 'Red nation', w: W * SCALE_CLOSE + PAD * 2 },
  { head: 'Normal zoom', sub: 'Blue nation', w: W * SCALE_NORMAL + PAD * 2 },
  { head: 'Normal zoom', sub: 'Red nation', w: W * SCALE_NORMAL + PAD * 2 },
  { head: "Today's icon", sub: 'Blue nation', w: 84 },
  { head: "Today's icon", sub: 'Red nation', w: 84 },
];
const ROW_H = H * SCALE_CLOSE + 10;
const GROUP_H = 26;
const HEAD_H = 46;
const FLAT_H = 120;
export const SHEET_W = LABEL_W + COLS.reduce((a, c) => a + c.w, 0);

/** Row tops (CSS px) of each group on the sheet, for screenshots. */
export function sheetLayout(): { name: string; y: number; h: number }[] {
  const out: { name: string; y: number; h: number }[] = [];
  let y = HEAD_H;
  for (const g of GROUPS) {
    const h = GROUP_H + g.rows.length * ROW_H;
    out.push({ name: g.name, y, h });
    y += h;
  }
  out.push({ name: 'Flat', y, h: FLAT_H });
  return out;
}
const SHEET_H = HEAD_H + GROUPS.reduce((a, g) => a + GROUP_H + g.rows.length * ROW_H, 0) + FLAT_H;

/** Today's map marker for a building (render/buildings.ts drawOne): a category plate, a white glyph, the owner band. */
function todayIcon(ctx: CanvasRenderingContext2D, type: BuildingSpec['type'], level: number, x: number, y: number, owner: RGB, dpr: number): void {
  const size = 40;
  const r = size / 2;
  const fw = 4;
  const cat = ICON_INFO[type as BuildingIconId].category;
  ctx.fillStyle = 'rgba(12,15,20,0.55)';
  ctx.beginPath();
  ctx.roundRect(x - r - 1, y - r - 1, size + 2, size + fw + 3, size * 0.26);
  ctx.fill();
  ctx.fillStyle = `rgb(${owner[0]},${owner[1]},${owner[2]})`;
  ctx.beginPath();
  ctx.roundRect(x - r + size * 0.12, y + r - 1, size * 0.76, fw + 1, 2);
  ctx.fill();
  drawMarker(ctx, type as BuildingIconId, x, y, size, { plate: cat ? CATEGORY_PLATES[cat] : owner, dpr });
  if (level > 1) {
    const br = 8;
    const bx = x + r * 0.78;
    const by = y - r * 0.78;
    ctx.beginPath();
    ctx.arc(bx, by, br, 0, Math.PI * 2);
    ctx.fillStyle = '#f4f5f1';
    ctx.fill();
    ctx.lineWidth = 1.2;
    ctx.strokeStyle = 'rgba(14,18,24,0.85)';
    ctx.stroke();
    ctx.fillStyle = '#1a1f27';
    ctx.font = '600 10px "DM Sans", system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(level), bx, by + 0.5);
  }
}

/** The sea beside a port in the sheet: the game's shelf and shore colours, to the right of the quay. */
function seaPatch(ctx: CanvasRenderingContext2D, x: number, y: number, s: number, cellW: number): void {
  const sx = x + 31 * s;
  const sw = x + cellW - sx;
  const rgb = (c: readonly number[]): string => `rgb(${c[0] | 0},${c[1] | 0},${c[2] | 0})`;
  ctx.fillStyle = rgb(waterRGB(1));
  ctx.beginPath();
  ctx.roundRect(sx, y + 8 * s, sw, (H - 10) * s, [s * 6, 0, 0, s * 6]);
  ctx.fill();
  ctx.fillStyle = rgb(waterRGB(5));
  ctx.beginPath();
  ctx.roundRect(sx + 3.5 * s, y + 11 * s, sw - 3.5 * s, (H - 16) * s, [s * 4, 0, 0, s * 4]);
  ctx.fill();
}

function drawSheet(ctx: CanvasRenderingContext2D, dpr: number): void {
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(backdrop('land', SHEET_W, SHEET_H, 14), 0, 0);
  const xs: number[] = [];
  let x = LABEL_W;
  for (const c of COLS) {
    xs.push(x);
    x += c.w;
  }
  // column heads
  ctx.fillStyle = 'rgba(10,14,20,0.82)';
  ctx.fillRect(0, 0, SHEET_W, HEAD_H);
  COLS.forEach((c, i) => {
    label(ctx, c.head, xs[i] + c.w / 2, 14, 'center');
    label(ctx, c.sub, xs[i] + c.w / 2, 33, 'center', true);
  });
  label(ctx, 'Building (rows)', 8, 23, 'left');
  let y = HEAD_H;
  for (const g of GROUPS) {
    ctx.fillStyle = 'rgba(10,14,20,0.78)';
    ctx.fillRect(0, y, SHEET_W, GROUP_H);
    ctx.font = '700 13px "DM Sans", system-ui, sans-serif';
    ctx.fillStyle = '#edeff3';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(g.name, 10, y + GROUP_H / 2);
    y += GROUP_H;
    for (const row of g.rows) {
      const cy = y + ROW_H / 2;
      label(ctx, row.title, 8, cy, 'left');
      const owners = [BLUE, RED, BLUE, RED];
      const scales = [SCALE_CLOSE, SCALE_CLOSE, SCALE_NORMAL, SCALE_NORMAL];
      for (let i = 0; i < 4; i++) {
        const spr = bakeBuilding(row.spec, owners[i]);
        const s = scales[i];
        if (row.spec.type === 'port') seaPatch(ctx, xs[i] + (COLS[i].w - W * s) / 2, cy - (H * s) / 2, s, COLS[i].w);
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(spr, Math.round(xs[i] + (COLS[i].w - W * s) / 2), Math.round(cy - (H * s) / 2), W * s, H * s);
        ctx.imageSmoothingEnabled = false;
      }
      todayIcon(ctx, row.spec.type, row.spec.level, xs[4] + COLS[4].w / 2, cy - 4, BLUE, dpr);
      todayIcon(ctx, row.spec.type, row.spec.level, xs[5] + COLS[5].w / 2, cy - 4, RED, dpr);
      ctx.fillStyle = 'rgba(255,255,255,0.08)';
      ctx.fillRect(0, y + ROW_H - 1, SHEET_W, 1);
      y += ROW_H;
    }
  }
  // the far-zoom flat Fort (one flat level-3 fort: the flat icon is the same at every level and for every nation)
  ctx.fillStyle = 'rgba(10,14,20,0.78)';
  ctx.fillRect(0, y, SHEET_W, FLAT_H);
  label(ctx, 'Flat Fort (far zoom), level 3', 8, y + 24, 'left');
  label(ctx, 'Far zoom keeps this flat square for every fort', 8, y + 48, 'left', true);
  // today's far-zoom fort exactly as the map draws it: a 4 px square, dark fill, a 1 px pale outline (drawFar in
  // render/buildings.ts), drawn at real size and then shown enlarged with hard pixels so it stays true to the original
  const real = document.createElement('canvas');
  real.width = 12 * dpr;
  real.height = 12 * dpr;
  const rc = real.getContext('2d');
  if (rc) {
    rc.scale(dpr, dpr);
    rc.beginPath();
    rc.rect(4, 4, 4, 4);
    rc.lineWidth = 1;
    rc.strokeStyle = 'rgba(245,245,240,0.9)';
    rc.stroke();
    rc.fillStyle = '#2a2e36';
    rc.fill();
  }
  const drawFlat = (k: number, cx: number, cy: number): void => {
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(real, cx - 6 * k, cy - 6 * k, 12 * k, 12 * k);
  };
  drawFlat(1, xs[2] + COLS[2].w / 2, y + 56);
  label(ctx, 'Real size', xs[2] + COLS[2].w / 2, y + 90, 'center', true);
  drawFlat(8, xs[0] + COLS[0].w / 2, y + 56);
  label(ctx, 'Enlarged 8 times', xs[0] + COLS[0].w / 2, y + 108, 'center', true);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}

// ------------------------------------------------------------------------------------------------- on the real map

const MAP_ID = 'baltic';
/** map zoom (CSS px per tile) the two previews stand for; the game's marker size at that zoom is render/buildings.ts markerSize */
const ZOOM_NORMAL = 4;
const ZOOM_CLOSE = 10;
/** a sprite's width in markers: the new building art is drawn this many times wider than today's marker at the same zoom */
const SPRITE_PER_MARKER = 1.9;
const MAP_W = 880;

interface Site {
  type: BuildingSpec['type'];
  level: number;
  addon: Addon;
  /** tile position of the building's anchor on the ground */
  x: number;
  y: number;
  blue: boolean;
}

interface Crop {
  /** the tile window the preview shows (the normal zoom window; the close one is its middle) */
  cx: number;
  cy: number;
  /** tile colours for the whole map window, nations tinted in */
  tiles: HTMLCanvasElement;
  x0: number;
  y0: number;
  w: number;
  h: number;
  borderX: (y: number) => number;
  sites: Site[];
  water: (x: number, y: number) => boolean;
  /** which nation owns a land tile: 1 blue, 2 red, 0 none */
  owner: (x: number, y: number) => number;
}

/**
 * The Baltic map's terrain, decoded with the game's own map decoder. The lab page waits forever at the top level
 * (gate.ts), so the game's lazy map chunks never initialise in this single-file build: the data is imported directly.
 */
async function loadBalticTerrain(): Promise<MapData> {
  const bin = atob(balticBlob);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip'));
  const d = decodeWorldMapBlob(new Uint8Array(await new Response(stream).arrayBuffer()));
  return { width: d.width, height: d.height, terrain: d.terrain, resource: d.resource } as MapData;
}

/** Loads the Baltic map with the game's own loader and terrain colours and cuts a window with sea, a coast and a border. */
async function buildCrop(): Promise<Crop> {
  const map = await loadBalticTerrain();
  const theme = themeForMap(MAP_ID);
  const terr = buildTerrain(map, theme);
  const mw = map.width;
  const mh = map.height;
  const landAt = (x: number, y: number): boolean => x >= 0 && y >= 0 && x < mw && y < mh && !isWater(map.terrain[y * mw + x]);
  const WN = MAP_W / ZOOM_NORMAL;
  const HN = 84;
  // integral image of land, to find a window about half land, with an east-facing coast near its middle
  const sat = new Int32Array((mw + 1) * (mh + 1));
  for (let y = 0; y < mh; y++) {
    let row = 0;
    for (let x = 0; x < mw; x++) {
      row += landAt(x, y) ? 1 : 0;
      sat[(y + 1) * (mw + 1) + x + 1] = sat[y * (mw + 1) + x + 1] + row;
    }
  }
  const landIn = (x: number, y: number, w: number, h: number): number => sat[(y + h) * (mw + 1) + x + w] - sat[y * (mw + 1) + x + w] - sat[(y + h) * (mw + 1) + x] + sat[y * (mw + 1) + x];
  let best = { s: 1e9, x: 0, y: 0, px: 0, py: 0 };
  for (let y = 4; y + HN + 4 < mh; y += 6) {
    for (let x = 4; x + WN + 4 < mw; x += 6) {
      const f = landIn(x, y, WN, HN) / (WN * HN);
      if (f < 0.4 || f > 0.62) continue;
      const cx = x + (WN >> 1);
      const cy = y + (HN >> 1);
      // an east-facing coast near the middle: land, then 4 sea tiles to its right, deep enough for a pier
      let found = -1;
      for (let dy = -10; dy <= 10 && found < 0; dy += 2) {
        for (let dx = -14; dx <= 14; dx++) {
          const tx = cx + dx;
          const ty = cy + dy;
          if (!landAt(tx, ty) || !landAt(tx - 8, ty) || landAt(tx + 1, ty)) continue;
          let sea = true;
          for (let k = 1; k <= 7 && sea; k++) for (let j = -4; j <= 4; j++) if (landAt(tx + k, ty + j)) sea = false;
          if (sea) {
            found = tx * 4096 + ty;
            break;
          }
        }
      }
      if (found < 0) continue;
      const s = Math.abs(f - 0.5);
      if (s < best.s) best = { s, x, y, px: Math.floor(found / 4096), py: found % 4096 };
    }
  }
  const x0 = best.x;
  const y0 = best.y;
  const px = best.px;
  const py = best.py;
  // nations: a wavy border running roughly north to south west of the coast; blue to its west, red to its east
  const bx0 = px - 32;
  const borderX = (y: number): number => bx0 + (y - py) * 0.18 + 5 * Math.sin(y * 0.11);
  const owner = (x: number, y: number): number => (landAt(x, y) ? (x < borderX(y) ? 1 : 2) : 0);
  // tile colours: the game's terrain colours (render/terrain.ts buildTerrain, theme applied), nations tinted over land
  const tiles = makeCanvas(WN, HN);
  const tc = tiles.getContext('2d');
  if (tc) {
    const img = tc.createImageData(WN, HN);
    for (let y = 0; y < HN; y++) {
      for (let x = 0; x < WN; x++) {
        const mi = (y0 + y) * mw + x0 + x;
        const o = (y * WN + x) * 4;
        let r = terr.rgba[mi * 4];
        let g = terr.rgba[mi * 4 + 1];
        let b = terr.rgba[mi * 4 + 2];
        const ow = owner(x0 + x, y0 + y);
        if (ow) {
          const t = ow === 1 ? BLUE : RED;
          r += (t[0] - r) * 0.15;
          g += (t[1] - g) * 0.15;
          b += (t[2] - b) * 0.15;
        }
        img.data[o] = r;
        img.data[o + 1] = g;
        img.data[o + 2] = b;
        img.data[o + 3] = 255;
      }
    }
    tc.putImageData(img, 0, 0);
  }
  // building sites: a tile in from the coast, away from water, on land of the right nation
  const dry = (x: number, y: number): boolean => {
    for (let j = -3; j <= 3; j++) for (let i = -3; i <= 3; i++) if (!landAt(x + i, y + j)) return false;
    return true;
  };
  const near = (x: number, y: number, blue: boolean): [number, number] => {
    for (let r = 0; r < 30; r++) {
      for (let j = -r; j <= r; j++) {
        for (let i = -r; i <= r; i++) {
          if (Math.max(Math.abs(i), Math.abs(j)) !== r) continue;
          const tx = x + i;
          const ty = y + j;
          if (dry(tx, ty) && owner(tx, ty) === (blue ? 1 : 2) && Math.abs(tx - borderX(ty)) > 3) return [tx, ty];
        }
      }
    }
    return [x, y];
  };
  const mk = (type: BuildingSpec['type'], level: number, addon: Addon, x: number, y: number, blue: boolean): Site => {
    const [sx, sy] = near(x, y, blue);
    return { type, level, addon, x: sx, y: sy, blue };
  };
  const sites: Site[] = [
    // the port sits on the coast itself (the pier reaches into the sea), on the red side
    { type: 'port', level: 3, addon: null, x: px, y: py, blue: false },
    mk('fort', 3, null, px - 14, py - 14, false),
    mk('city', 3, null, px - 17, py + 13, false),
    mk('sam', 1, null, px - 8, py + 2, false),
    mk('fort', 5, null, px - 50, py - 9, true),
    mk('city', 1, null, px - 49, py + 12, true),
    mk('sam', 3, null, px - 40, py + 2, true),
  ];
  return {
    cx: px - 8,
    cy: py,
    tiles,
    x0,
    y0,
    w: WN,
    h: HN,
    borderX,
    sites,
    water: (x, y) => !landAt(x, y),
    owner,
  };
}

/** Draws a preview of the crop at a zoom (CSS px per tile) with the buildings at the game's marker size for that zoom. */
function drawMapPreview(cv: HTMLCanvasElement, crop: Crop, zoom: number, dpr: number): void {
  const cw = MAP_W;
  const ch = cv.height / dpr;
  const ctx = cv.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  // the view is centred on (cx, cy) in map tiles
  const vx0 = crop.cx - cw / 2 / zoom;
  const vy0 = crop.cy - ch / 2 / zoom;
  const toX = (tx: number): number => (tx - vx0) * zoom;
  const toY = (ty: number): number => (ty - vy0) * zoom;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(crop.tiles, vx0 - crop.x0, vy0 - crop.y0, cw / zoom, ch / zoom, 0, 0, cw, ch);
  // the border between the two nations: a dark line with a pale one on top, where the owner changes
  ctx.lineCap = 'round';
  const pts: [number, number][] = [];
  for (let ty = Math.floor(vy0); ty <= Math.ceil(vy0 + ch / zoom); ty++) {
    const bx = crop.borderX(ty);
    if (crop.owner(Math.floor(bx) - 1, ty) && crop.owner(Math.floor(bx) + 2, ty)) pts.push([toX(bx), toY(ty + 0.5)]);
    else if (pts.length) pts.push([-9999, -9999]);
  }
  for (const [lw, col] of [[Math.max(2, zoom * 0.32), 'rgba(12,16,22,0.65)'], [Math.max(1, zoom * 0.14), 'rgba(236,238,232,0.85)']] as [number, string][]) {
    ctx.strokeStyle = col;
    ctx.lineWidth = lw;
    ctx.beginPath();
    let pen = false;
    for (const [x, y] of pts) {
      if (x < -9000) {
        pen = false;
        continue;
      }
      if (!pen) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
      pen = true;
    }
    ctx.stroke();
  }
  const sizePx = markerSize(zoom) * SPRITE_PER_MARKER;
  const sprH = (sizePx * H) / W;
  const sorted = crop.sites.slice().sort((a, b) => a.y - b.y);
  ctx.imageSmoothingEnabled = true;
  for (const s of sorted) {
    const spr = bakeBuilding({ type: s.type, level: s.level, addon: s.addon }, s.blue ? BLUE : RED);
    const ax = s.type === 'port' ? 30 / W : 0.46;
    const ay = s.type === 'port' ? 0.5 : 0.56;
    const dx = toX(s.x + 0.5) - sizePx * ax;
    const dy = toY(s.y + 0.5) - sprH * ay;
    if (dx < -sizePx || dy < -sprH || dx > cw || dy > ch) continue;
    ctx.drawImage(spr, Math.round(dx), Math.round(dy), Math.round(sizePx), Math.round(sprH));
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}

/** Mounts the Buildings mockup section in the lab page and draws it. */
export function mountBuildingsMock(root: HTMLElement): HTMLElement {
  const sec = document.createElement('section');
  sec.className = 'al-row al-bm';
  sec.id = 'al-buildings';
  sec.setAttribute('aria-labelledby', 'al-row-buildings');
  sec.style.display = 'block';
  const head = document.createElement('div');
  head.className = 'al-row-head';
  const t = document.createElement('h2');
  t.id = 'al-row-buildings';
  t.textContent = 'Buildings mockup';
  const note = document.createElement('p');
  note.textContent = 'Map buildings in the troops\' shaded pixel style: slightly 3D, lit from the top left, with a drop shadow, the nation\'s colour on roofs, flags and bands, and one gold pip per level. Each building is shown for a blue and a red nation, at close and normal zoom, next to today\'s icon.';
  const note2 = document.createElement('p');
  note2.textContent = 'Flak, tank traps, the radar dish and coastal guns are not in the game yet: they are drawn as add-ons only. The build menu, the pin menu and the tabs keep today\'s icons, and far zoom keeps the flat icons. This is a mockup: the real map still draws today\'s icons.';
  head.append(t, note, note2);
  const cv = document.createElement('canvas');
  cv.setAttribute('role', 'img');
  cv.setAttribute('aria-label', 'Buildings mockup: fort, city, SAM site and port at every level, two nations, two zooms, next to today\'s icons');
  cv.style.cssText = `display:block;margin-top:12px;border-radius:8px;max-width:100%;width:${SHEET_W}px`;
  const dpr = Math.min(3, Math.max(1, Math.round(window.devicePixelRatio || 1)));
  cv.width = SHEET_W * dpr;
  cv.height = SHEET_H * dpr;
  sec.append(head, cv);
  const mh = document.createElement('div');
  mh.className = 'al-row-head';
  const mt = document.createElement('h3');
  mt.textContent = 'On the real map';
  const mn = document.createElement('p');
  mn.textContent = `The same buildings over a crop of the game's ${MAP_ID} map (its own loader and terrain colours), with the border of two nations. They are drawn at the game's marker size for each zoom (zoom ${ZOOM_NORMAL}: ${Math.round(markerSize(ZOOM_NORMAL))} px marker, zoom ${ZOOM_CLOSE}: ${Math.round(markerSize(ZOOM_CLOSE))} px marker), made ${SPRITE_PER_MARKER} times wider than the marker so the roofs read.`;
  mh.append(mt, mn);
  sec.append(mh);
  const previews: [string, number, number][] = [
    [`Normal zoom (zoom ${ZOOM_NORMAL})`, ZOOM_NORMAL, 300],
    [`Close zoom (zoom ${ZOOM_CLOSE})`, ZOOM_CLOSE, 400],
  ];
  const mcs: { cv: HTMLCanvasElement; zoom: number }[] = [];
  for (const [name, zoom, hh] of previews) {
    const sub = document.createElement('p');
    sub.textContent = name;
    sub.style.cssText = 'margin:12px 0 4px;font-weight:600';
    const mc = document.createElement('canvas');
    mc.setAttribute('role', 'img');
    mc.setAttribute('aria-label', `Buildings on a real map crop, ${name}`);
    mc.style.cssText = `display:block;border-radius:8px;max-width:100%;width:${MAP_W}px`;
    mc.width = MAP_W * dpr;
    mc.height = hh * dpr;
    mc.getContext('2d')?.fillRect(0, 0, 1, 1);
    sec.append(sub, mc);
    mcs.push({ cv: mc, zoom });
  }
  root.append(sec);
  void buildCrop().then(
    (crop) => {
      for (const m of mcs) drawMapPreview(m.cv, crop, m.zoom, dpr);
    },
    (e: unknown) => {
      for (const m of mcs) {
        const c2 = m.cv.getContext('2d');
        if (c2) {
          c2.fillStyle = '#222';
          c2.fillRect(0, 0, m.cv.width, m.cv.height);
          c2.fillStyle = '#ddd';
          c2.font = '16px sans-serif';
          c2.fillText(`The map could not be loaded: ${String(e)}`, 16, 32);
        }
      }
    },
  );
  const ctx = cv.getContext('2d');
  const go = (): void => {
    if (ctx) drawSheet(ctx, dpr);
  };
  go();
  // the fonts may arrive after the first draw: draw again once they have
  void document.fonts?.ready.then(go);
  return sec;
}
