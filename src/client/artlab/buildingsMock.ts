// The art lab's "Buildings mockup" (art lab builds only): map buildings as small painted tabletop miniatures. A muted,
// earthy palette (concrete, steel, earth, clay and slate, nothing saturated), no outline pass: the form comes from
// shading (lit from the top left, a darker right side and base), a soft drop shadow and fine surface detail (panel
// seams, brick and stone courses, sandbag rows, roof tiles, rivets, window grids). One silhouette per type; the
// owner's colour sits only on flags, bands and small trim. The level is a number on a small dark plate in the corner.
// It is a MOCKUP: the game's map still draws buildings with render/buildings.ts. Flak, tank traps, the radar dish and
// coastal guns are not game features yet; they are visual add-ons here. Everything is drawn in code (no image files)
// into a small buffer (3 sub-pixels per sprite pixel) and shown at two zooms, next to today's marker icon. No
// module-level side effects.
import { drawMarker, ICON_INFO, type BuildingIconId } from '../icons';
import { CATEGORY_PLATES } from '../render/buildings';
import type { RGB } from '../art/shared/colour';
import { backdrop } from './backdrop';
import { label } from './scenes';

const W = 46;
const H = 48;
/** sub-pixels per sprite pixel (the finer grid the detail is drawn on) */
const K = 3;
const SW = W * K;
const SH = H * K;
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
  /** one sub-pixel, blended over what is there */
  sp(x: number, y: number, c: C, a = 255): void {
    if (x < 0 || y < 0 || x >= SW || y >= SH || a <= 0) return;
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
  /** a soft ground shadow: dark, fading to nothing at the rim */
  shadow(cx: number, cy: number, rx: number, ry: number, a: number): void {
    const x0 = Math.floor((cx - rx) * K);
    const x1 = Math.ceil((cx + rx) * K);
    const y0 = Math.floor((cy - ry) * K);
    const y1 = Math.ceil((cy + ry) * K);
    for (let j = y0; j <= y1; j++) {
      for (let i = x0; i <= x1; i++) {
        const nx = ((i + 0.5) / K - cx) / rx;
        const ny = ((j + 0.5) / K - cy) / ry;
        const q = nx * nx + ny * ny;
        if (q < 1) this.sp(i, j, [14, 16, 14], a * Math.pow(1 - q, 0.7));
      }
    }
  }
}

// ------------------------------------------------------------------------------------------------- forms

interface BoxOpt {
  /** depth of the top and side faces, up and to the right */
  d?: number;
  top?: C;
  side?: C;
  /** vertical panel seams every n px (concrete slabs) */
  seam?: number;
  /** courses of blocks: block width and height in px (brick, stone) */
  course?: [number, number];
  /** grain strength */
  tex?: number;
  /** a lighter coping line on the top front edge */
  coping?: boolean;
}

/** A block seen from the front and a little above, lit from the top left. (x, yb) is the front face's bottom left. */
function box(p: Pix, x: number, yb: number, w: number, h: number, m: C, o: BoxOpt = {}): void {
  const d = o.d ?? 4;
  const tex = o.tex ?? 0.045;
  const yt = yb - h + 1;
  const top = o.top ?? m;
  const side = o.side ?? m;
  const n = Math.round(d * K);
  for (let s = 0; s < n; s++) {
    const t = s / Math.max(1, n);
    // right side
    const xs = x + w + s / K;
    const ys = yt - (s + 1) / K;
    p.fill(xs, ys, 1 / K, h, (_u, v, sx, sy) => sh(side, (0.7 - 0.1 * t - 0.06 * v) * (1 + (hash(sx, sy) - 0.5) * 2 * tex)));
    // top face
    p.fill(x + (s + 1) / K, yt - (s + 1) / K, w, 1 / K, (u, _v, sx, sy) => sh(top, (1.2 - 0.12 * u - 0.05 * t) * (1 + (hash(sx, sy) - 0.5) * 2 * tex)));
  }
  const ca = o.course;
  p.fill(x, yt, w, h, (u, v, sx, sy) => {
    let f = (1.08 - 0.18 * u) * (1.05 - 0.12 * v);
    const rx = sx - Math.round(x * K);
    const ry = sy - Math.round(yt * K);
    if (o.seam) {
      const m2 = rx % Math.round(o.seam * K);
      if (m2 === 0 && rx > 0) f *= 0.8;
      else if (m2 === 1) f *= 1.05;
    }
    if (ca) {
      const bh = Math.max(3, Math.round(ca[1] * K));
      const bw = Math.max(4, Math.round(ca[0] * K));
      const row = Math.floor(ry / bh);
      const rr = ry - row * bh;
      const off = (row % 2) * Math.round(bw / 2);
      const col = Math.floor((rx + off) / bw);
      if (rr === 0) f *= 0.8;
      else if ((rx + off) % bw === 0) f *= 0.82;
      else f *= 1 + (hash(row * 7 + 1, col * 13 + 5) - 0.5) * 0.14;
    }
    return sh(m, f * (1 + (hash(sx, sy) - 0.5) * 2 * tex));
  });
  // darker edges and a lit top left, in place of an outline
  p.rect(x, yb, w, 1 / K, sh(m, 0.62));
  p.rect(x + w - 1 / K, yt, 1 / K, h, sh(m, 0.68));
  p.rect(x, yt, 1 / K, h, sh(m, 1.2));
  p.rect(x, yt, w, 1 / K, sh(top, 1.3));
  if (o.coping) p.rect(x, yt, w, 0.6, sh(top, 1.22));
}

/** A tiny flag-pole pennant in the owner's colour, waving. */
function flag(p: Pix, x: number, yTop: number, h: number, own: C, wide = 6): void {
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

/** A window: dark glass, a lit warm one now and then, a pale glint top left. */
function win(p: Pix, x: number, y: number, lit: boolean, w = 1.3, h = 1.7): void {
  p.rect(x - 0.15, y - 0.15, w + 0.3, h + 0.3, [30, 34, 36], 120);
  p.rect(x, y, w, h, lit ? M.lamp : M.glass);
  p.rect(x, y, w, 1 / K, lit ? sh(M.lamp, 1.25) : [92, 106, 116]);
  p.rect(x, y, 1 / K, h, lit ? sh(M.lamp, 1.12) : [70, 82, 92]);
  p.rect(x, y + h - 1 / K, w, 1 / K, sh(lit ? M.lamp : M.glass, 0.7));
}

/** A grid of windows on a face. */
function windowGrid(p: Pix, x: number, y: number, w: number, h: number, seed: number): void {
  const px = 2.7;
  const py = 3.1;
  const cols = Math.max(1, Math.floor((w - 1.2) / px));
  const rows = Math.max(1, Math.floor((h - 0.5) / py));
  const gx = x + (w - (cols * px - (px - 1.3))) / 2;
  for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) win(p, gx + i * px, y + j * py, hash(i + seed, j * 3 + seed) > 0.62);
}

/** A band of the owner's colour with a lit top edge and dark bottom edge (flag-cloth trim on a wall). */
function band(p: Pix, x: number, y: number, w: number, own: C, hgt = 1.1): void {
  p.fill(x, y, w, hgt, (_u, v) => sh(own, 1.18 - 0.5 * v));
}

/** Rows of sandbags: stacked, offset rounded bags with a lit top and a dark underside. */
function sandbags(p: Pix, x: number, y: number, w: number, rows: number, tone: C = M.sand): void {
  for (let r = rows - 1; r >= 0; r--) {
    const off = (r % 2) * 1.6;
    for (let bx = x - off; bx < x + w - 2; bx += 3.2) {
      const v = hash(Math.round(bx * 3), r * 5 + 2);
      p.blob(bx + 1.8, y - r * 1.3 + 0.4, 1.75, 0.85, sh(tone, 0.92 + v * 0.16), 255, 0.6);
    }
  }
}

/** A hip roof seen from the front with tile courses; owner trim at the eave. */
function hipRoof(p: Pix, x: number, yb: number, w: number, h: number, m: C, own: C): void {
  const n = Math.round(h * K);
  for (let s = 0; s < n; s++) {
    const t = s / n;
    const inset = t * w * 0.34;
    const y = yb - (s + 1) / K;
    p.fill(x - 0.6 + inset, y, w + 1.2 - inset * 2, 1 / K, (u, _v, sx, sy) => {
      const course = Math.floor(s / 4);
      let f = 1.12 - 0.3 * u - 0.12 * t;
      if (s % 4 === 0) f *= 0.74;
      else if (s % 4 === 3) f *= 1.06;
      else if (Math.floor((sx + (course % 2) * 3) / 6) !== Math.floor((sx - 1 + (course % 2) * 3) / 6) && sy >= 0) f *= 0.86;
      return sh(m, f * (0.95 + hash(course, Math.floor(sx / 6)) * 0.1));
    });
  }
  band(p, x - 0.6, yb - 0.7, w + 1.2, own, 0.8);
}

/** An anti-aircraft gun: a squat mount, a turret and two barrels raised up and to the right. */
function flakGun(p: Pix, cx: number, cy: number): void {
  p.shadow(cx + 1, cy + 0.4, 4.2, 1.1, 90);
  p.rect(cx - 2.8, cy - 1.2, 5.6, 1.8, sh(M.dkSteel, 1.1));
  p.rect(cx - 2.8, cy - 1.2, 5.6, 1 / K, sh(M.steel, 1.2));
  for (const [dx, dy, c] of [[-0.6, 0, sh(M.steel, 1.25)], [0.8, 0.6, sh(M.steel, 0.9)]] as [number, number, RGB][]) {
    p.line(cx + dx - 0.6, cy - 2.2 + dy, cx + 4.6 + dx, cy - 9.6 + dy, c, 4);
    p.line(cx + dx - 0.6, cy - 2.4 + dy, cx + 4.4 + dx, cy - 9.6 + dy, sh(c, 1.25), 1);
    p.rect(cx + 4.2 + dx, cy - 10.2 + dy, 1.1, 1, M.dkSteel);
  }
  p.blob(cx, cy - 2, 2.9, 2.3, M.olive);
  p.rect(cx - 0.5, cy - 3.2, 1.2, 0.7, [24, 28, 24], 160);
}

/** A sandbag ring with a flak gun in it (an anti-aircraft pit). */
function flakPit(p: Pix, cx: number, cy: number): void {
  p.shadow(cx + 1, cy + 1, 8.5, 3, 80);
  p.blob(cx, cy, 7.6, 3.1, M.earth, 255, 0.35);
  p.blob(cx, cy + 0.3, 5.2, 1.9, sh(M.earth, 0.55), 255, 0.2);
  flakGun(p, cx, cy);
  for (let a = 0; a < 18; a++) {
    const t = (a / 18) * Math.PI * 2;
    const bx = cx + Math.cos(t) * 6.4;
    const by = cy + Math.sin(t) * 2.5;
    if (Math.sin(t) < 0.2 || a % 2 === 0) p.blob(bx, by, 1.6, 0.95, sh(M.sand, 0.9 + hash(a, 4) * 0.2), 255, 0.6);
  }
}

/** A czech hedgehog: three angle-iron bars crossed at the middle, each a clear bar with a lit edge. */
function hedgehog(p: Pix, cx: number, cy: number): void {
  p.shadow(cx + 0.8, cy + 3.4, 4.6, 1.1, 90);
  const bars: [number, number, number, number][] = [
    [-4.2, -4.2, 4.2, 4.2],
    [4.2, -4.2, -4.2, 4.2],
    [-4.8, 0.2, 4.8, 0.2],
  ];
  for (const [ax, ay, bx, by] of bars) {
    p.line(cx + ax, cy + ay, cx + bx, cy + by, sh(M.dkSteel, 0.8), 5);
    p.line(cx + ax, cy + ay, cx + bx, cy + by, M.steel, 3);
    p.line(cx + ax - 0.2, cy + ay - 0.3, cx + bx - 0.2, cy + by - 0.3, sh(M.steel, 1.4), 1);
  }
  p.blob(cx, cy + 0.2, 1.1, 1.1, sh(M.steel, 1.1));
}

/** A radar dish on a mast: a tilted bowl with a feed horn, the owner's colour on the cab band, and a clear sweep. */
function radar(p: Pix, cx: number, cy: number, own: C): void {
  p.shadow(cx + 1, cy + 11.5, 6, 1.6, 90);
  box(p, cx - 3, cy + 11, 6, 3, M.conc, { d: 2, seam: 2 });
  p.rect(cx - 1, cy + 1, 2.2, 10, sh(M.steel, 0.85));
  p.rect(cx - 1, cy + 1, 0.7, 10, sh(M.steel, 1.25));
  box(p, cx - 3.5, cy + 4, 8, 3.2, M.steel, { d: 2, seam: 2 });
  band(p, cx - 3.5, cy + 3.2, 8, own, 0.8);
  // the bowl: a deep ellipse, rim lighter, inside darker
  p.blob(cx, cy - 3, 6.8, 5, sh(M.white, 0.95), 255, 0.6);
  p.blob(cx + 1, cy - 2.4, 5.2, 3.9, sh(M.steel, 0.75), 255, 0.4);
  p.line(cx + 1, cy - 2.4, cx - 4.8, cy - 8.8, M.dkSteel, 2);
  p.blob(cx - 5, cy - 9, 0.9, 0.9, sh(M.white, 1.05));
  // the sweep: a pale wedge and three clear arcs in front of the dish
  const ox = cx - 1;
  const oy = cy - 3.5;
  for (let a = -2.7; a <= -1.15; a += 0.02) {
    for (let r = 7.5; r < 15; r += 0.34) p.sp(Math.round((ox + Math.cos(a) * r) * K), Math.round((oy + Math.sin(a) * r) * K), [200, 226, 200], 34);
  }
  for (const [r, al] of [[8.2, 255], [11.4, 215], [14.6, 170]] as [number, number][]) {
    for (let a = -2.7; a <= -1.15; a += 0.012) {
      const x = ox + Math.cos(a) * r;
      const y = oy + Math.sin(a) * r;
      p.rect(x - 0.2, y - 0.2, 0.55, 0.55, [214, 236, 210], al);
    }
  }
}

/** A coastal gun emplacement: a concrete casemate, a steel gun house with an owner band, and one long barrel out over the sea. */
function coastalGun(p: Pix, cx: number, cy: number, own: C): void {
  p.shadow(cx + 2, cy + 4, 11, 2.2, 90);
  box(p, cx - 7, cy + 4.5, 14, 4, M.conc, { d: 3, seam: 2.6 });
  // the barrel, behind the gun house: long and clearly a gun, lit along its top, a dark muzzle
  p.line(cx + 2, cy - 1.4, cx + 14.5, cy + 2.2, sh(M.dkSteel, 0.85), 7);
  p.line(cx + 2, cy - 1.7, cx + 14.5, cy + 1.9, M.steel, 4);
  p.line(cx + 2, cy - 2.4, cx + 14.5, cy + 1.2, sh(M.steel, 1.5), 1);
  p.rect(cx + 13.6, cy + 0.6, 1.8, 2.6, M.dkSteel);
  box(p, cx - 5, cy + 1, 10, 5, M.steel, { d: 3, seam: 2.5 });
  band(p, cx - 5, cy - 1.8, 10, ownTone(own), 0.9);
  p.rect(cx + 1.6, cy - 0.4, 2.6, 1.7, [24, 28, 30]);
}

// ------------------------------------------------------------------------------------------------- the level badge

/** The dark plate for the level number in the corner (the digit itself is printed on it after the bake, like today's icon). */
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

// ------------------------------------------------------------------------------------------------- buildings

type Addon = 'flak' | 'traps' | 'radar' | 'guns' | null;

/** A crenellated parapet along a wall top: small blocks with a lit left edge. */
function merlons(p: Pix, x0: number, x1: number, yt: number, m: C, step = 3.6): void {
  for (let x = x0; x < x1 - 1; x += step) box(p, x, yt, 2.2, 2, m, { d: 1.4, tex: 0.04 });
}

/** A narrow arrow slit. */
function slit(p: Pix, x: number, y: number, h = 2.6): void {
  p.rect(x - 0.3, y - 0.3, 1.1, h + 0.6, [20, 22, 22], 110);
  p.rect(x, y, 0.5, h, [24, 26, 28]);
}

/** A gate: an arched dark-steel door with plank lines and rivets in a stone frame. */
function gate(p: Pix, x: number, yb: number, w: number, h: number): void {
  p.fill(x - 0.7, yb - h - 0.7, w + 1.4, h + 0.7, (u, v) => {
    const dx = (u - 0.5) * 2;
    if (v < 0.4 && dx * dx + ((v - 0.4) / 0.4) ** 2 > 1) return null;
    return sh(M.stone, 1.12 - 0.3 * v);
  });
  p.fill(x, yb - h, w, h, (u, v, sx) => {
    const dx = (u - 0.5) * 2;
    if (v < 0.35 && dx * dx + ((v - 0.35) / 0.35) ** 2 > 1) return null;
    let f = 0.95 - 0.25 * v;
    if (Math.floor(sx / 3) !== Math.floor((sx - 1) / 3)) f *= 0.8;
    return sh(M.dkSteel, f);
  });
  for (let j = 0.32; j < 0.95; j += 0.24) for (let i = 0.2; i <= 0.81; i += 0.3) p.rect(x + w * i, yb - h + h * j, 0.4, 0.4, [150, 156, 158]);
}

function fort(p: Pix, o: C, lv: number, addon: Addon): void {
  const own = ownTone(o);
  const yg = 43;
  p.shadow(24, yg - 0.5, 21, 2.6, 105);
  const stone = M.stone;
  if (lv === 1) {
    // a low field fort: a stone wall, sandbag rows on top, an arched gate, one flag
    box(p, 5, yg - 2, 34, 10, stone, { d: 4, course: [3.4, 1.7] });
    sandbags(p, 5.5, yg - 12.6, 36, 2);
    band(p, 5.4, yg - 9.8, 33, own, 1.1);
    gate(p, 19.5, yg - 2, 6, 7);
    flag(p, 9, 12, 17, own);
  } else if (lv === 3) {
    box(p, 12, yg - 4, 16, 22, stone, { d: 4, course: [3.4, 1.7] });
    merlons(p, 12, 29, yg - 25, stone);
    band(p, 12.4, yg - 22, 15, own, 1.1);
    slit(p, 19.2, yg - 20);
    slit(p, 24, yg - 20);
    box(p, 3, yg - 2, 34, 11, stone, { d: 4, course: [3.4, 1.7] });
    merlons(p, 3, 37, yg - 12, stone);
    gate(p, 18.5, yg - 2, 6, 7);
    band(p, 3.4, yg - 10.2, 33, own, 1);
    for (const x of [0, 31]) {
      box(p, x, yg, 9, 17, stone, { d: 4, course: [3.4, 1.7] });
      merlons(p, x, x + 9, yg - 17, stone, 3.2);
      band(p, x + 0.4, yg - 14.8, 8, own, 1);
      slit(p, x + 4, yg - 12);
    }
    flag(p, 19.5, 2, 15, own);
  } else {
    // level 5: a stepped keep and two heavy towers, one flag; the walls plain
    box(p, 11, yg - 4, 18, 14, stone, { d: 4, course: [3.4, 1.7] });
    box(p, 14, yg - 17, 12, 13, stone, { d: 4, course: [3.4, 1.7] });
    merlons(p, 14, 26, yg - 29, stone, 3.4);
    band(p, 14.4, yg - 26, 11, own, 1.1);
    slit(p, 19, yg - 24);
    slit(p, 22, yg - 24);
    band(p, 11.4, yg - 15.4, 17, own, 0.9);
    box(p, 2, yg - 2, 36, 10, stone, { d: 4, course: [3.4, 1.7] });
    merlons(p, 2, 38, yg - 11, stone);
    gate(p, 18.5, yg - 2, 6, 7);
    for (const x of [0, 31]) {
      box(p, x, yg, 10, 19, stone, { d: 4, course: [3.4, 1.7] });
      merlons(p, x, x + 10, yg - 19, stone, 3.2);
      band(p, x + 0.4, yg - 16.6, 9, own, 1);
      slit(p, x + 4.6, yg - 13);
    }
    flag(p, 19.5, 0, 14, own);
  }
  if (addon === 'flak') {
    flakPit(p, 7, 43);
    flakPit(p, 38, 43);
  } else if (addon === 'traps') {
    hedgehog(p, 7, 43.6);
    hedgehog(p, 23, 44);
    hedgehog(p, 39, 43.6);
  }
}

interface TowerOpt {
  roof?: 'flat' | 'hip';
  antenna?: boolean;
  course?: [number, number];
  seam?: number;
  seed?: number;
  tank?: boolean;
}

function tower(p: Pix, x: number, yb: number, w: number, h: number, wall: C, own: C, t: TowerOpt = {}): void {
  const yt = yb - h + 1;
  const flat = (t.roof ?? 'flat') === 'flat';
  box(p, x, yb, w, h, wall, { d: 3, course: t.course, seam: t.seam, coping: flat });
  if (flat) {
    band(p, x, yt + 1.2, w, own, 1);
    windowGrid(p, x + 0.4, yt + 3.6, w - 0.8, h - 5.4, t.seed ?? 1);
    // a little plant on the roof: a vent box
    box(p, x + 1.6, yt, 2.6, 1.5, sh(M.conc, 0.95), { d: 1.4, tex: 0.04 });
  } else {
    windowGrid(p, x + 0.4, yt + 1.6, w - 0.8, h - 2.4, t.seed ?? 1);
    hipRoof(p, x, yt, w, 4.2, M.clay, own);
  }
  if (t.antenna) {
    p.rect(x + w / 2 + 1.4, yt - 10, 0.5, 10, M.dkSteel);
    p.rect(x + w / 2 + 0.6, yt - 7, 2.1, 0.4, M.dkSteel);
    p.blob(x + w / 2 + 1.65, yt - 10.4, 0.7, 0.7, [190, 90, 76]);
  }
}

function city(p: Pix, o: C, lv: number, addon: Addon): void {
  const own = ownTone(o);
  p.shadow(24, 44.5, 22, 2.4, 105);
  if (lv === 1) {
    tower(p, 3, 38, 13, 11, M.cream, own, { roof: 'hip', seed: 3 });
    tower(p, 19, 38, 12, 15, M.brick, own, { course: [2.6, 1.3], seed: 7 });
    tower(p, 11, 45, 11, 8, M.conc, own, { seam: 3.5, seed: 11 });
    tower(p, 26, 45, 10, 8, M.cream, own, { roof: 'hip', seed: 5 });
  } else if (lv === 3) {
    tower(p, 2, 38, 9, 22, M.conc, own, { seam: 3, seed: 2 });
    tower(p, 14, 38, 11, 28, M.cream, own, { seed: 9 });
    tower(p, 28, 38, 9, 19, M.brick, own, { course: [2.6, 1.3], seed: 4 });
    tower(p, 4, 45, 12, 11, M.brick, own, { course: [2.6, 1.3], seed: 6 });
    tower(p, 19, 45, 13, 9, M.cream, own, { roof: 'hip', seed: 8 });
    tower(p, 34, 45, 8, 7, M.conc, own, { seam: 3, seed: 12 });
  } else {
    tower(p, 1, 38, 8, 21, M.brick, own, { course: [2.6, 1.3], seed: 4 });
    tower(p, 11, 38, 12, 30, M.fadedBlue, own, { seam: 4, antenna: true, seed: 13 });
    tower(p, 26, 38, 10, 25, M.conc, own, { seam: 3.3, seed: 1 });
    tower(p, 3, 45, 11, 13, M.cream, own, { seed: 15 });
    tower(p, 17, 45, 13, 10, M.brick, own, { course: [2.6, 1.3], seed: 2 });
    tower(p, 33, 45, 8, 11, M.conc, own, { seam: 3.5, seed: 6 });
  }
  if (addon === 'flak') {
    // flak on the middle tower's roof and a sandbag pit on the ground
    flakGun(p, 20, lv === 3 ? 9.2 : 13);
    flakPit(p, 38, 44);
  }
}

function launcher(p: Pix, x: number, yb: number, tilt: number, own: C, len = 14): void {
  p.shadow(x + 5, yb + 0.8, 8, 1.4, 70);
  // the trailer: a flat steel bed with wheels, and a lifting arm
  box(p, x - 1, yb, 11, 2.4, M.steel, { d: 2, seam: 2.2 });
  for (const wx of [x + 0.6, x + 4, x + 7.4]) {
    p.blob(wx + 1.1, yb + 0.5, 1.2, 1.2, M.dkSteel, 255, 0.5);
  }
  p.line(x + 3, yb - 1.6, x + 3 + tilt, yb - 8, sh(M.steel, 0.9), 4);
  for (const dx of [0.4, 5.8]) {
    const x0 = x + dx;
    const x1 = x0 + tilt;
    // the missile: a pale tube with a dark steel cradle, an owner stripe and an owner tinted tip
    for (let i = 0; i <= len * K; i++) {
      const t = i / (len * K);
      const mx = x0 + (x1 - x0) * t;
      const my = yb - 1.6 - len * t;
      const tip = t > 0.86;
      const stripe = t > 0.56 && t < 0.64;
      const base = tip || stripe ? own : M.white;
      for (let k = 0; k < 4; k++) p.sp(Math.round(mx * K - 2 + k), Math.round(my * K), sh(base, [1.18, 1.0, 0.82, 0.62][k]));
    }
    p.line(x0 - 0.8, yb - 4.6, x0 + tilt * 0.3 + 0.8, yb - 4.6 - len * 0.3, sh(M.dkSteel, 1), 2);
  }
}

function sam(p: Pix, o: C, lv: number, addon: Addon): void {
  const own = ownTone(o);
  p.shadow(25, 44, 21, 2.4, 105);
  // the pad: a dark concrete slab with panel seams
  box(p, 2, 44, lv === 1 ? 30 : 37, 4, sh(M.conc, 0.72), { d: 4, top: sh(M.conc, 0.9), seam: 3.2 });
  if (lv === 1) {
    launcher(p, 5, 41, 4, own);
  } else {
    // three launchers staggered in two ranks so the site stays compact
    launcher(p, 1, 30, 3, own, 11);
    launcher(p, 16, 30, 3, own, 11);
    launcher(p, 8, 41, 3, own, 11);
  }
  // the command cabin: an olive shelter with a roof band and a window
  const cx = lv === 1 ? 24 : 29;
  box(p, cx, 43, 10, 9, M.olive, { d: 3, seam: 2.5 });
  band(p, cx, 36.4, 10, own, 1);
  win(p, cx + 2, 38.8, true);
  win(p, cx + 6, 38.8, false);
  p.rect(cx + 3.6, 41.2, 2.8, 1.8, [34, 38, 30]);
  if (addon === 'radar') radar(p, 30, 17, own);
}

function port(p: Pix, o: C, lv: number, addon: Addon): void {
  const own = ownTone(o);
  // the sea off the quay: a muted patch with wave marks and a light foam line at the quay edge
  p.fill(0, 32, 46, 14, (u, v, sx, sy) => {
    const wave = (Math.sin(sx * 0.35 + sy * 0.9) + Math.sin(sx * 0.13 - sy * 0.5)) * 0.04;
    return sh(M.sea, 1.04 - 0.22 * v + wave + (hash(sx, sy) - 0.5) * 0.05);
  });
  for (let i = 0; i < 16; i++) p.rect(hash(i, 1) * 44, 35 + hash(i, 2) * 9, 2 + hash(i, 3) * 2, 0.35, [150, 176, 182], 120);
  // the quay: a concrete apron along the top with a front face to the sea and mooring bollards
  box(p, 0, 31, 46, 10, M.conc, { d: 0, seam: 4.4 });
  p.rect(0, 31.5, 46, 1.1, sh(M.conc, 0.6));
  p.rect(0, 32.5, 46, 0.5, [186, 202, 204], 190);
  for (const bx of [4, 14, 33, 42]) {
    p.blob(bx, 29.6, 0.9, 0.75, M.dkSteel, 255, 0.6);
  }
  // the pier: planks running out over the water
  const pw = lv === 1 ? 7 : 10;
  box(p, 21, 43, pw, 12, M.teak, { d: 0, tex: 0.07 });
  for (let y = 33; y < 44; y += 1.6) p.rect(21, y, pw, 1 / K, sh(M.teak, 0.7));
  p.rect(21 + pw - 1 / K, 32, 1 / K, 12, sh(M.teak, 0.55));
  for (const by of [34, 40]) p.blob(21 + pw + 0.2, by, 0.8, 0.7, M.dkSteel, 255, 0.6);
  p.shadow(26 + pw / 2, 43.8, pw / 2 + 2, 1.2, 80);
  // a crane on the quay: lattice legs, a truss boom out over the water, the owner's colour on the cab band
  const crane = (x: number): void => {
    p.shadow(x + 5, 27, 7, 1.2, 80);
    for (const lx of [x, x + 6.6]) {
      p.rect(lx, 12, 0.9, 15, sh(M.steel, 0.95));
      p.rect(lx, 12, 0.3, 15, sh(M.steel, 1.4));
    }
    for (let y = 13; y < 26; y += 3) {
      p.line(x + 0.9, y, x + 6.6, y + 3, sh(M.dkSteel, 1.2), 1);
      p.line(x + 6.6, y, x + 0.9, y + 3, sh(M.dkSteel, 1.2), 1);
    }
    box(p, x - 1.5, 15, 10, 4, M.steel, { d: 2, seam: 2.4 });
    band(p, x - 1.5, 11.8, 10, own, 0.8);
    p.rect(x - 2, 8.6, 21, 1.6, sh(M.steel, 1));
    p.rect(x - 2, 8.6, 21, 0.4, sh(M.steel, 1.5));
    for (let i = 0; i < 10; i++) p.line(x - 2 + i * 2.1, 10.2, x - 0.9 + i * 2.1, 8.6, sh(M.dkSteel, 1.15), 1);
    p.line(x + 17, 10.2, x + 17, 17.4, [60, 62, 60], 1);
    box(p, x + 15.2, 20, 3.6, 2.2, M.rust, { d: 1, seam: 1.2 });
  };
  // the warehouse on the quay: ribbed walls, a roof in clay, an owner eave band
  box(p, 2, 28, 14, 9, M.cream, { d: 3, seam: 2.3 });
  hipRoof(p, 2, 19.6, 14, 3.8, M.slate, own);
  p.rect(7, 22.4, 4.4, 5.6, sh(M.dkSteel, 1));
  for (let x = 7.6; x < 11.4; x += 1) p.rect(x, 22.4, 1 / K, 5.6, sh(M.dkSteel, 1.4));
  // containers: ribbed steel boxes
  const cont = (x: number, y: number, m: C): void => {
    box(p, x, y, 6.4, 3.2, m, { d: 2, seam: 0.9, tex: 0.05 });
    p.rect(x + 5.4, y - 2.2, 1 / K, 3.2, sh(m, 0.55));
  };
  if (lv === 1) {
    crane(24);
    cont(33, 27, M.rust);
    cont(39, 27, M.fadedBlue);
  } else {
    crane(14);
    crane(29);
    cont(19, 29, M.ochre);
    cont(36, 24, M.fadedBlue);
    cont(36, 28, M.rust);
    cont(3.4, 30.4, M.moss);
  }
  if (addon === 'guns') {
    coastalGun(p, 9, 28, own);
    coastalGun(p, 33, 28, own);
  }
}

const BUILDERS: Record<string, (p: Pix, own: C, lv: number, addon: Addon) => void> = { fort, city, sam, port };

// ------------------------------------------------------------------------------------------------- bake

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
  BUILDERS[spec.type](p, owner, spec.level, spec.addon);
  if (spec.type === 'port') anchorBadge(p, 0.5, 1);
  levelBadge(p, 36.2, 0.6);
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
    cx.fillText(String(spec.level), (36.2 + 4.5) * K, (0.6 + 5) * K + 1.5);
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
  root.append(sec);
  const ctx = cv.getContext('2d');
  const go = (): void => {
    if (ctx) drawSheet(ctx, dpr);
  };
  go();
  // the fonts may arrive after the first draw: draw again once they have
  void document.fonts?.ready.then(go);
  return sec;
}
