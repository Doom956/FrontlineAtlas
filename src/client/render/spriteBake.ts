// The unit sprite rasterizer (client only). A unit is a small model: parts with a footprint (box, ellipse, polygon or
// thick segment) in model units (1 unit = 1 art pixel at full size; nose at +u, starboard at +v), a base height and a
// height. A model is rasterized per facing (16 headings) and size, never rotated as an image, so the pixels stay
// square and crisp at every heading and the light stays where it belongs:
//   - one view for every unit: a slight 3/4 top-down angle (the ground is foreshortened by FORE, height lifts a part
//     up by LIFT per unit), so the top of each part and a hint of its near (south) side show;
//   - one light for every unit: from the top left. Tops get a light rim on their upper and left edges (flat parts) or
//     a 4-tone curve (domes and cylinders: turrets, fuselages, barrels); sides are dark with a deep bottom row; a raised
//     part casts a 1 px shadow down and right onto what is under it;
//   - a 1 px near-black outline around the whole sprite (translucent water parts and flames get none);
//   - missiles are drawn flat from straight above (Model.flat), so a slender body stays slender at every heading;
//   - an owner plate (Shade 'plate') is a flat 2-tone slab: the owner colour with a darker lower and right rim.
// Each material is a 4-tone ramp (deep, dark, base, light) holding one hue; the owner's colour is one more material
// ('own') used only for small bands and plates, so the metal keeps its own tones.
// The result is a plain RGBA buffer (no canvas): pixelSprites.ts copies it into an atlas page once and draws it with
// whole-number scaling. Pure and deterministic for the same input, so tests can check the art without a browser.
import type { RGB } from './common';

/** Ground foreshortening of the 3/4 view (screen y per model y). */
export const FORE = 0.84;
/** Screen px a part rises per model unit of height (at full size). */
export const LIFT = 0.55;
/** Headings a model is baked at. */
export const FACINGS = 16;

/** A 4-tone ramp: deep, dark, base, light (hex). */
type Ramp = readonly [string, string, string, string];

/**
 * Materials. Painted steel and aluminium stay cool and light so units read on the bright map; olive and tan for the
 * tanks; dark steel for submarines; bright signal colours only on small parts (nose cones, hazard bands, flames).
 */
export const MATERIALS = {
  hull: ['#262d34', '#48525a', '#7a858c', '#a9b3b7'],
  deck: ['#2b3136', '#3f464b', '#575f64', '#737b7f'],
  turret: ['#394249', '#68737a', '#a2acb0', '#d4dadb'],
  sup: ['#475055', '#7a858a', '#bcc4c4', '#eaeeea'],
  gun: ['#101418', '#232930', '#3b434c', '#646e78'],
  tread: ['#0f1215', '#20252b', '#343b42', '#545c64'],
  olive: ['#272c1c', '#465030', '#6c7848', '#9aa76a'],
  sand: ['#46371f', '#77613d', '#a58c5b', '#d2bc86'],
  steel: ['#1f2522', '#3a4540', '#5c6b63', '#8a9a8f'],
  camo: ['#1c2619', '#30412a', '#4b6240', '#769163'],
  plane: ['#36404b', '#5a6774', '#8f9daa', '#c4d0d8'],
  metal: ['#4a4f55', '#7c838a', '#b2b9bf', '#e2e7ea'],
  night: ['#0b0e11', '#181d22', '#282f36', '#424b55'],
  sub: ['#1b2228', '#2e3a42', '#44535c', '#6b7d88'],
  tarmac: ['#1f2327', '#30353a', '#43494f', '#5f666d'],
  rust: ['#37170f', '#5a281c', '#82402b', '#ad6448'],
  glass: ['#1c4560', '#2c6a90', '#5ea7d4', '#c2e8fb'],
  white: ['#646b71', '#9fa6ab', '#dde1e1', '#ffffff'],
  red: ['#561510', '#8a261b', '#c6412d', '#ef7b5e'],
  gold: ['#5a410d', '#967018', '#d4a82d', '#f7de7c'],
  yellow: ['#665007', '#a3800f', '#e5bd1d', '#fbe77c'],
  black: ['#06080a', '#101317', '#1d2228', '#363e46'],
  teal: ['#123a3a', '#1f5c5a', '#2f8580', '#5fb6ab'],
  mustard: ['#4f3a0c', '#7f5f16', '#b38a26', '#dcb85a'],
  navy: ['#121c33', '#203056', '#36508a', '#6585c0'],
  foam: ['#8fa7b8', '#b9cbd6', '#e3edf2', '#ffffff'],
  sea: ['#24384a', '#24384a', '#2f4a60', '#3d5c74'],
  flame: ['#b5341a', '#e8661f', '#ffb02f', '#fff2ab'],
  skin: ['#5a3a26', '#8c5d3f', '#c08a62', '#e8b98f'],
} as const satisfies Record<string, Ramp>;

export type MatId = keyof typeof MATERIALS | 'own';
export const OUTLINE: RGB = [17, 21, 27];

/** 'plate': a flat 2-tone slab (the owner plate under a vehicle): base colour with a darker lower and right rim. */
export type Shade = 'flat' | 'dome' | 'cyl' | 'plate';
export type Pattern = 'tread' | 'grille' | 'deckline' | 'planks' | 'helmets' | 'rivets';

/**
 * One part of a model. Footprints in model units: box [u0, v0, u1, v1], ell [u, v, ru, rv], poly [u, v, u, v, ...],
 * seg [u0, v0, u1, v1, width]. `z` base height, `h` height (0 = a decal on whatever is below).
 */
export interface Part {
  k: 'box' | 'ell' | 'poly' | 'seg';
  p: readonly number[];
  z: number;
  h: number;
  m: MatId;
  sh?: Shade;
  pat?: Pattern;
  /** translucent part (water around a submarine): drawn with this alpha, no outline */
  a?: number;
  /** glowing part (flames): full colour, no outline around it */
  glow?: boolean;
  /** a recessed decal (a deck inside its bulwark, an open hold): its upper and left edges are in shadow */
  inset?: boolean;
  /** shading centre and half sizes (u, v, ru, rv) for domes and cylinders, when not the part's own shape */
  sc?: readonly [number, number, number, number];
  /** the footprint is also cut to this ellipse (u, v, ru, rv) or polygon: a band laid over a turret or fuselage */
  clip?: readonly number[];
  clipPoly?: readonly number[];
}

export interface Model {
  parts: readonly Part[];
  /** flies: drawn with a ground shadow */
  air?: boolean;
  /** drawn straight from above (missiles): no ground foreshortening and no height lift, so a slender body stays slender at every heading */
  flat?: boolean;
}

export interface Baked {
  w: number;
  h: number;
  /** where the model's origin (u 0, v 0, ground) lands in the buffer */
  ox: number;
  oy: number;
  /** RGBA, w * h * 4 */
  data: Uint8ClampedArray;
}

// ------------------------------------------------------------------------------------------------- colours

function hex(h: string): RGB {
  const n = parseInt(h.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
const RAMPS = new Map<string, RGB[]>();
for (const [k, v] of Object.entries(MATERIALS)) RAMPS.set(k, (v as readonly string[]).map(hex));

const lerp = (a: RGB, b: RGB, t: number): RGB => [Math.round(a[0] + (b[0] - a[0]) * t), Math.round(a[1] + (b[1] - a[1]) * t), Math.round(a[2] + (b[2] - a[2]) * t)];

/**
 * The owner's colour as a 4-tone ramp: evened toward a mid lightness first (a very dark or very pale nation colour
 * still shows as a band), then darkened and lightened along its own hue.
 */
export function ownerRamp(c: RGB): RGB[] {
  const l = 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];
  let base = c;
  if (l < 70) base = lerp(c, [150, 150, 150], (70 - l) / 140);
  else if (l > 205) base = lerp(c, [120, 120, 120], (l - 205) / 160);
  return [lerp(base, [8, 10, 14], 0.62), lerp(base, [8, 10, 14], 0.36), base, lerp(base, [255, 255, 255], 0.42)];
}

// ------------------------------------------------------------------------------------------------ geometry

function inPoly(p: readonly number[], u: number, v: number): boolean {
  let inside = false;
  const n = p.length;
  for (let i = 0, j = n - 2; i < n; j = i, i += 2) {
    const ui = p[i];
    const vi = p[i + 1];
    const uj = p[j];
    const vj = p[j + 1];
    if (vi > v !== vj > v && u < ((uj - ui) * (v - vi)) / (vj - vi) + ui) inside = !inside;
  }
  return inside;
}

/** Distance from (u, v) to the segment's axis, and the position along it (0..1). */
function segDist(p: readonly number[], u: number, v: number): { d: number; t: number; side: number } {
  const du = p[2] - p[0];
  const dv = p[3] - p[1];
  const L2 = du * du + dv * dv || 1e-9;
  let t = ((u - p[0]) * du + (v - p[1]) * dv) / L2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const cu = p[0] + du * t;
  const cv = p[1] + dv * t;
  const L = Math.sqrt(L2);
  // signed: + on the starboard side of the axis
  const side = ((u - p[0]) * -dv + (v - p[1]) * du) / L;
  return { d: Math.hypot(u - cu, v - cv), t, side };
}

function contains(part: Part, u: number, v: number): boolean {
  if (part.clip) {
    const c = part.clip;
    const a = (u - c[0]) / c[2];
    const b = (v - c[1]) / c[3];
    if (a * a + b * b > 1) return false;
  }
  if (part.clipPoly && !inPoly(part.clipPoly, u, v)) return false;
  const p = part.p;
  switch (part.k) {
    case 'box':
      return u >= p[0] && u < p[2] && v >= p[1] && v < p[3];
    case 'ell': {
      const a = (u - p[0]) / p[2];
      const b = (v - p[1]) / p[3];
      return a * a + b * b <= 1;
    }
    case 'poly':
      return inPoly(p, u, v);
    case 'seg':
      return segDist(p, u, v).d <= p[4] / 2;
  }
}

/** Bounding box of a part's footprint in model units: u0, v0, u1, v1. */
function partBox(part: Part): [number, number, number, number] {
  const p = part.p;
  switch (part.k) {
    case 'box':
      return [p[0], p[1], p[2], p[3]];
    case 'ell':
      return [p[0] - p[2], p[1] - p[3], p[0] + p[2], p[1] + p[3]];
    case 'seg': {
      const r = p[4] / 2;
      return [Math.min(p[0], p[2]) - r, Math.min(p[1], p[3]) - r, Math.max(p[0], p[2]) + r, Math.max(p[1], p[3]) + r];
    }
    case 'poly': {
      let a = Infinity;
      let b = Infinity;
      let c = -Infinity;
      let d = -Infinity;
      for (let i = 0; i < p.length; i += 2) {
        a = Math.min(a, p[i]);
        b = Math.min(b, p[i + 1]);
        c = Math.max(c, p[i]);
        d = Math.max(d, p[i + 1]);
      }
      return [a, b, c, d];
    }
  }
}

// light from the top left and above (screen x, y, up), normalised
const LX = -0.52;
const LY = -0.58;
const LZ = 0.63;

/** Tone 0..3 of a curved surface whose normal is (nx, ny) in screen space and nz up. */
function curveTone(nx: number, ny: number, nz: number): number {
  const d = nx * LX + ny * LY + nz * LZ;
  return d > 0.8 ? 3 : d > 0.42 ? 2 : d > 0.05 ? 1 : 0;
}

// --------------------------------------------------------------------------------------------- rasterizer

/** Special tones set by patterns: deck paint and troop helmets (fixed colours, not from the part's ramp). */
const PAINT = 4;
const HELMET = 5;
const PAINT_RGB: RGB = [236, 238, 232];
const HELMET_RGB: RGB = [122, 136, 82];

interface Prep {
  part: Part;
  /** pixel bounds of the ground footprint */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** ground mask over the bounds */
  g: Uint8Array;
  gw: number;
  /** integer lifts of the bottom and top face (px) */
  B: number;
  T: number;
  top: number;
}

/**
 * Rasterizes a model at `res` art px per model unit, heading `facing` (0 = east, clockwise in 16 steps on screen),
 * with the owner's colour for the 'own' parts.
 */
export function rasterize(model: Model, res: number, facing: number, owner: RGB): Baked {
  const th = (((facing % FACINGS) + FACINGS) % FACINGS) * ((Math.PI * 2) / FACINGS);
  const cos = Math.cos(th);
  const sin = Math.sin(th);
  const fy = model.flat ? res : res * FORE;
  const lift = model.flat ? 0 : res * LIFT;
  // screen bounds of everything (ground footprints and lifted tops)
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const boxes: [number, number, number, number][] = [];
  for (const part of model.parts) {
    const [u0, v0, u1, v1] = partBox(part);
    let bx0 = Infinity;
    let by0 = Infinity;
    let bx1 = -Infinity;
    let by1 = -Infinity;
    for (const [u, v] of [
      [u0, v0],
      [u1, v0],
      [u0, v1],
      [u1, v1],
    ]) {
      const x = (u * cos - v * sin) * res;
      const y = (u * sin + v * cos) * fy;
      bx0 = Math.min(bx0, x);
      bx1 = Math.max(bx1, x);
      by0 = Math.min(by0, y);
      by1 = Math.max(by1, y);
    }
    boxes.push([bx0, by0, bx1, by1]);
    const T = Math.round((part.z + part.h) * lift);
    minX = Math.min(minX, bx0);
    maxX = Math.max(maxX, bx1);
    minY = Math.min(minY, by0 - T);
    maxY = Math.max(maxY, by1 - Math.round(part.z * lift));
  }
  const pad = 2;
  const ox = Math.ceil(-minX) + pad;
  const oy = Math.ceil(-minY) + pad;
  const W = Math.ceil(maxX) + ox + pad + 1;
  const H = Math.ceil(maxY) + oy + pad + 1;
  const n = W * H;
  const pid = new Int16Array(n).fill(-1);
  const tone = new Uint8Array(n);
  const mat = new Array<RGB[] | undefined>(model.parts.length);
  const own = ownerRamp(owner);

  // ground masks
  const preps: Prep[] = [];
  model.parts.forEach((part, i) => {
    const b = boxes[i];
    const x0 = Math.max(0, Math.floor(b[0] + ox) - 1);
    const y0 = Math.max(0, Math.floor(b[1] + oy) - 1);
    const x1 = Math.min(W - 1, Math.ceil(b[2] + ox) + 1);
    const y1 = Math.ceil(b[3] + oy) + 1;
    const gw = x1 - x0 + 1;
    const gh = y1 - y0 + 1;
    const g = new Uint8Array(gw * gh);
    for (let y = y0; y <= y1; y++) {
      const Y = (y + 0.5 - oy) / fy;
      for (let x = x0; x <= x1; x++) {
        const X = (x + 0.5 - ox) / res;
        const u = X * cos + Y * sin;
        const v = -X * sin + Y * cos;
        if (contains(part, u, v)) g[(y - y0) * gw + (x - x0)] = 1;
      }
    }
    const B = Math.round(part.z * lift);
    const T = Math.max(B, Math.round((part.z + part.h) * lift));
    preps.push({ part, x0, y0, x1, y1, g, gw, B, T, top: part.z + part.h });
    mat[i] = part.m === 'own' ? own : RAMPS.get(part.m);
  });
  const G = (pp: Prep, x: number, y: number): boolean => x >= pp.x0 && x <= pp.x1 && y >= pp.y0 && y <= pp.y1 && pp.g[(y - pp.y0) * pp.gw + (x - pp.x0)] === 1;
  const isTop = (pp: Prep, x: number, y: number): boolean => G(pp, x, y + pp.T);
  const isSide = (pp: Prep, x: number, y: number): boolean => {
    for (let t = pp.B; t < pp.T; t++) if (G(pp, x, y + t)) return true;
    return false;
  };
  /** model coordinates of a screen pixel's ground point */
  const toModel = (x: number, y: number): [number, number] => {
    const X = (x + 0.5 - ox) / res;
    const Y = (y + 0.5 - oy) / fy;
    return [X * cos + Y * sin, -X * sin + Y * cos];
  };

  for (let i = 0; i < preps.length; i++) {
    const pp = preps[i];
    const part = pp.part;
    const sh = part.sh ?? 'flat';
    const ya = Math.max(0, pp.y0 - pp.T - 1);
    const yb = Math.min(H - 1, pp.y1 - pp.B);
    for (let y = ya; y <= yb; y++) {
      for (let x = pp.x0; x <= pp.x1; x++) {
        const top = isTop(pp, x, y);
        const side = !top && isSide(pp, x, y);
        if (!top && !side) continue;
        const idx = y * W + x;
        let t: number;
        if (top) {
          const [u, v] = toModel(x, y + pp.T);
          if (sh === 'plate') {
            t = !isTop(pp, x + 1, y) || !isTop(pp, x, y + 1) ? 1 : 2;
          } else if (sh === 'flat') {
            const rim = !isTop(pp, x, y - 1) || !isTop(pp, x - 1, y);
            t = part.h > 0 ? (rim ? 3 : 2) : rim && part.inset ? 1 : 2;
          } else {
            t = curved(part, sh, u, v, cos, sin);
          }
          t = pattern(part.pat, t, u, v, true);
        } else {
          t = isSide(pp, x, y + 1) || isTop(pp, x, y + 1) ? 1 : 0;
          if (part.pat === 'tread') {
            const [u] = toModel(x, y + pp.B);
            t = Math.floor(u / 1.5) % 2 === 0 ? Math.max(0, t - 1) : t;
          }
        }
        pid[idx] = i;
        tone[idx] = t;
      }
    }
  }

  // cast shadow: a pixel whose left, upper-left or upper neighbour belongs to a higher part is a tone darker (the
  // light comes from the top left, so a raised part darkens a 1 px rim to its right and below it)
  const shadowed = new Uint8Array(n);
  const casts = (me: number, j: number): boolean => j >= 0 && j !== me && preps[j].top > preps[me].top + 0.5 && !preps[j].part.glow && (preps[j].part.a ?? 1) >= 1;
  for (let y = 1; y < H; y++) {
    for (let x = 1; x < W; x++) {
      const idx = y * W + x;
      const me = pid[idx];
      if (me < 0) continue;
      if (casts(me, pid[idx - W - 1]) || casts(me, pid[idx - 1]) || casts(me, pid[idx - W])) shadowed[idx] = 1;
    }
  }

  const data = new Uint8ClampedArray(n * 4);
  const solid = new Uint8Array(n);
  for (let idx = 0; idx < n; idx++) {
    const i = pid[idx];
    if (i < 0) continue;
    const part = preps[i].part;
    const ramp = mat[i];
    if (!ramp) continue;
    const t0 = tone[idx];
    const t = t0 >= 4 ? t0 : shadowed[idx] ? Math.max(0, t0 - 1) : t0;
    const c = t === PAINT ? PAINT_RGB : t === HELMET ? HELMET_RGB : ramp[t];
    const o = idx * 4;
    data[o] = c[0];
    data[o + 1] = c[1];
    data[o + 2] = c[2];
    const a = part.a ?? 1;
    data[o + 3] = Math.round(a * 255);
    if (a >= 1 && !part.glow) solid[idx] = 1;
  }
  // outline: empty pixels next to a solid one (4-neighbours)
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const idx = y * W + x;
      if (data[idx * 4 + 3] === 255) continue;
      if ((x > 0 && solid[idx - 1]) || (x < W - 1 && solid[idx + 1]) || (y > 0 && solid[idx - W]) || (y < H - 1 && solid[idx + W])) {
        const o = idx * 4;
        data[o] = OUTLINE[0];
        data[o + 1] = OUTLINE[1];
        data[o + 2] = OUTLINE[2];
        data[o + 3] = 255;
      }
    }
  }
  return { w: W, h: H, ox, oy, data };
}

/** Tone of a dome or cylinder top at model point (u, v). */
function curved(part: Part, sh: Shade, u: number, v: number, cos: number, sin: number): number {
  const p = part.p;
  let nu = 0;
  let nv = 0;
  if (part.k === 'seg' && !part.sc) {
    // a cylinder along the segment (barrels, booms): the normal turns across the axis
    const s = segDist(p, u, v);
    const r = p[4] / 2 || 1;
    const du = p[2] - p[0];
    const dv = p[3] - p[1];
    const L = Math.hypot(du, dv) || 1;
    const k = Math.max(-1, Math.min(1, s.side / r));
    nu = (-dv / L) * k;
    nv = (du / L) * k;
  } else {
    let cu: number;
    let cv: number;
    let ru: number;
    let rv: number;
    if (part.sc) [cu, cv, ru, rv] = part.sc;
    else {
      const [u0, v0, u1, v1] = partBox(part);
      cu = (u0 + u1) / 2;
      cv = (v0 + v1) / 2;
      ru = (u1 - u0) / 2 || 1;
      rv = (v1 - v0) / 2 || 1;
    }
    if (sh === 'dome') {
      nu = (u - cu) / ru;
      nv = (v - cv) / rv;
    } else {
      // cylinder along u: only the cross axis bends (an ellipse narrows toward its ends)
      let half = rv;
      if (part.k === 'ell' && !part.sc) half = rv * Math.sqrt(Math.max(0.05, 1 - ((u - cu) / ru) ** 2));
      nv = (v - cv) / half;
    }
  }
  const d2 = nu * nu + nv * nv;
  if (d2 > 1) {
    const s = 1 / Math.sqrt(d2);
    nu *= s;
    nv *= s;
  }
  const nz = Math.sqrt(Math.max(0, 1 - nu * nu - nv * nv));
  // model to screen (the ground's foreshortening barely changes a normal; ignored)
  const nx = nu * cos - nv * sin;
  const ny = nu * sin + nv * cos;
  return curveTone(nx * 0.9, ny * 0.9, nz);
}

/** Surface patterns in model space, so they turn with the unit. */
function pattern(pat: Pattern | undefined, t: number, u: number, v: number, top: boolean): number {
  if (!pat || !top) return t;
  switch (pat) {
    case 'tread':
      return Math.floor(u / 1.5) % 2 === 0 ? Math.max(0, t - 1) : t;
    case 'grille':
      return Math.floor(u) % 2 === 0 ? Math.max(0, t - 1) : t;
    case 'planks':
      return Math.floor(u * 1.2) % 2 === 0 ? Math.max(0, t - 1) : t;
    case 'rivets':
      return Math.floor(u / 2) % 2 === 0 && Math.abs(((v % 2) + 2) % 2) < 0.9 ? Math.min(3, t + 1) : t;
    case 'deckline':
      // a dashed white centre line on a flight deck
      return Math.abs(v) < 0.5 && Math.floor(u / 2.5) % 2 === 0 ? PAINT : t;
    case 'helmets':
      // rows of troops in a landing craft's open hold
      return (((u * 0.62) % 1) + 1) % 1 < 0.5 && (((v * 0.62) % 1) + 1) % 1 < 0.5 ? HELMET : t;
  }
  return t;
}

/** A dark translucent silhouette of a baked sprite (ground shadow of planes and missiles), same size. */
export function shadowOf(b: Baked, alpha = 0.26): Baked {
  const data = new Uint8ClampedArray(b.data.length);
  const a = Math.round(alpha * 255);
  for (let i = 3; i < data.length; i += 4) {
    if (b.data[i] === 0) continue;
    data[i - 3] = 6;
    data[i - 2] = 9;
    data[i - 1] = 14;
    data[i] = a;
  }
  return { w: b.w, h: b.h, ox: b.ox, oy: b.oy, data };
}

/** Opaque pixel count (tests: silhouettes differ). */
export function solidCount(b: Baked): number {
  let c = 0;
  for (let i = 3; i < b.data.length; i += 4) if (b.data[i] === 255) c++;
  return c;
}
