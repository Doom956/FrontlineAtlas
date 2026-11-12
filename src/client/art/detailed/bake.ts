// The detailed style's unit rasterizer (client only, pure). A unit is a small model of parts: a footprint (box,
// ellipse, polygon or thick segment) in model units (1 unit = 1 screen px at mid zoom, the refined style's art pixel;
// nose at +u, starboard at +v), a base height and a height. A model is rasterized per heading and resolution, never
// rotated as an image, so every heading has square, crisp pixels and the same light:
//   - resolution: `res` art px per model unit; the map bakes at about 2 (twice the refined pixels in the same space),
//     so a destroyer has room for its deck guns, bridge, funnel and railings;
//   - the view: a slight 3/4 top-down angle (the ground foreshortened by FORE, height lifting a part by LIFT per unit),
//     so the top of each part and a sliver of its near (south) side show;
//   - the light from the top left: flat tops have a light rim on their upper and left edges when raised; domes and
//     cylinders (turrets, fuselages, barrels) shade in 4 tones with a 2 x 2 ordered dither on the tone borders; sides
//     are darker with a deep bottom row; a raised part casts a short shadow down and right onto what is under it;
//   - no black outline: a translucent dark rim of one art px round the silhouette (heavier on the lower right), and
//     for vehicles a soft cast shadow on the ground, so the edge reads by value, not by a drawn line;
//   - planes can be rolled (bank): the span narrows, the parts on the low wing sink and the light on the surfaces
//     shifts with the tilt.
// Patterns (planking, grilles, track links, container ribs, panel lines, camouflage blotches) live in model space so
// they turn with the unit, and only draw where the resolution has room for them.
import type { RGB } from '../shared/colour';
import { rampOf, ownerTones, type MaterialId } from './palette';

/** Ground foreshortening of the 3/4 view (screen y per model y). */
export const FORE = 0.84;
/** Screen px a part rises per model unit of height, per art px per model unit. */
export const LIFT = 0.55;

export type MatId = MaterialId | 'own';
export type Shade = 'flat' | 'dome' | 'cyl' | 'plate';
export type Pattern = 'planks' | 'grille' | 'tread' | 'ribs' | 'panels' | 'blotch' | 'frames' | 'helmets' | 'hatches' | 'rivets' | 'deckLines';

/**
 * One part. Footprints in model units: box [u0, v0, u1, v1], ell [u, v, ru, rv], poly [u, v, u, v, ...],
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
  /** second material of a 'blotch' camouflage */
  alt?: MatId;
  /** translucent part (foam round a submarine): this alpha, no rim */
  a?: number;
  /** glowing part (flames, exhaust): full colour, no rim, casts no shadow */
  glow?: boolean;
  /** a recessed decal (a deck inside its bulwark, a well deck): its upper and left edges are in shadow */
  inset?: boolean;
  /** only the rim of the footprint is drawn (railings, bulwarks, deck edge lines), one art px wide */
  edge?: boolean;
  /** tone shift of the whole part (-1 darker, +1 lighter) */
  tone?: number;
  /** shading centre and half sizes (u, v, ru, rv) for domes and cylinders, when not the part's own shape */
  sc?: readonly [number, number, number, number];
  /** the footprint is also cut to this ellipse (u, v, ru, rv) or polygon */
  clip?: readonly number[];
  clipPoly?: readonly number[];
}

export interface Model {
  parts: readonly Part[];
  /** drawn straight from above (missiles): no foreshortening, no lift */
  flat?: boolean;
  /** alpha of the soft cast shadow on the ground (0 = none: planes get a separate ground shadow) */
  ground?: number;
}

export interface Baked {
  w: number;
  h: number;
  /** where the model's origin (u 0, v 0, ground) lands in the buffer */
  ox: number;
  oy: number;
  data: Uint8ClampedArray;
}

export interface BakeOpts {
  /** headings in a full turn (facing is 0..facings-1, 0 = east, clockwise on screen) */
  facings: number;
  /** bank angle in radians (planes; positive = right wing down) */
  roll?: number;
  /** owner colour for the 'own' parts */
  owner: readonly number[];
  /** moves the track links along by this many model units (a moving tank's tracks turn) */
  tread?: number;
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

function segDist(p: readonly number[], u: number, v: number): { d: number; side: number } {
  const du = p[2] - p[0];
  const dv = p[3] - p[1];
  const L2 = du * du + dv * dv || 1e-9;
  let t = ((u - p[0]) * du + (v - p[1]) * dv) / L2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const cu = p[0] + du * t;
  const cv = p[1] + dv * t;
  const L = Math.sqrt(L2);
  return { d: Math.hypot(u - cu, v - cv), side: ((u - p[0]) * -dv + (v - p[1]) * du) / L };
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

/** Bounding box of a footprint in model units: u0, v0, u1, v1. */
export function partBox(part: Part): [number, number, number, number] {
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

/**
 * A model banked by `roll` radians about its nose axis (positive = right wing down): every across-coordinate shrinks
 * by cos(roll) and each part sinks or rises by its centre's distance from the axis times sin(roll).
 */
export function rolled(parts: readonly Part[], roll: number): Part[] {
  if (!roll) return parts.slice();
  const c = Math.cos(roll);
  const s = Math.sin(roll);
  const sv = (q: readonly number[] | undefined, k: Part['k'] | 'clip'): number[] | undefined => {
    if (!q) return undefined;
    if (k === 'poly') return q.map((x, i) => (i % 2 ? x * c : x));
    if (k === 'box') return [q[0], q[1] * c, q[2], q[3] * c];
    if (k === 'seg') return [q[0], q[1] * c, q[2], q[3] * c, q[4]];
    // ellipse and clip ellipse: centre v and v radius
    return [q[0], q[1] * c, q[2], q[3] * c];
  };
  return parts.map((p) => {
    const b = partBox(p);
    const vc = (b[1] + b[3]) / 2;
    return {
      ...p,
      p: sv(p.p, p.k)!,
      z: Math.max(0, p.z - vc * s * 0.9),
      sc: p.sc ? ([p.sc[0], p.sc[1] * c, p.sc[2], p.sc[3] * c] as const) : undefined,
      clip: sv(p.clip, 'clip'),
      clipPoly: sv(p.clipPoly, 'poly'),
    };
  });
}

// --------------------------------------------------------------------------------------------- lighting

// light from the top left and above (screen x, y, up), normalised
const LX = -0.52;
const LY = -0.58;
const LZ = 0.63;

/** 2 x 2 ordered dither offsets (-0.5..0.5) at a screen pixel. */
const BAYER = [-0.375, 0.125, 0.375, -0.125];
const bayer = (x: number, y: number): number => BAYER[(x & 1) + ((y & 1) << 1)];

/** Light on a surface (n dot l) to a fractional tone 0..3: borders at 0.05, 0.42 and 0.8 like the refined ramp. */
function toneOf(d: number): number {
  if (d <= -0.25) return 0;
  if (d <= 0.05) return ((d + 0.25) / 0.3) * 0.5;
  if (d <= 0.42) return 0.5 + (d - 0.05) / 0.37;
  if (d <= 0.8) return 1.5 + (d - 0.42) / 0.38;
  return Math.min(3, 2.5 + (d - 0.8) / 0.4);
}

/** A repeatable 0..1 hash of a lattice point. */
function hash2(x: number, y: number, s: number): number {
  const v = Math.sin(x * 127.1 + y * 311.7 + s * 74.7) * 43758.5453;
  return v - Math.floor(v);
}
/** Smooth value noise 0..1 at (x, y). */
function vnoise(x: number, y: number, s: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const a = hash2(x0, y0, s);
  const b = hash2(x0 + 1, y0, s);
  const c = hash2(x0, y0 + 1, s);
  const d = hash2(x0 + 1, y0 + 1, s);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}

// --------------------------------------------------------------------------------------------- rasterizer

interface Prep {
  part: Part;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  g: Uint8Array;
  gw: number;
  B: number;
  T: number;
  top: number;
}

/** Marks a pixel tone as the part's second (camouflage) material. */
const ALT = 8;

/**
 * Rasterizes a model at `res` art px per model unit, heading `facing` of `o.facings`, with the owner's colour for
 * the 'own' parts and an optional bank.
 */
export function rasterize(model: Model, res: number, facing: number, o: BakeOpts): Baked {
  const N = o.facings;
  const th = (((facing % N) + N) % N) * ((Math.PI * 2) / N);
  const cos = Math.cos(th);
  const sin = Math.sin(th);
  const roll = o.roll ?? 0;
  const tread = o.tread ?? 0;
  const parts = (roll ? rolled(model.parts, roll) : model.parts).map((p) => minSize(p, res));
  const fy = model.flat ? res : res * FORE;
  const lift = model.flat ? 0 : res * LIFT;
  // the bank tilts every surface: its normal leans toward the low wing (model v), seen on screen
  const rs = Math.sin(roll);
  const rc = Math.cos(roll);
  const flatLight = -sin * rs * LX + cos * rs * LY + rc * LZ;
  const flatShift = roll ? (flatLight - LZ) * 2.6 : 0;
  // cast shadow on the ground (vehicles): the silhouette moved down and right by about a model unit
  const gsh = model.ground ?? 0;
  const gdx = gsh ? Math.max(1, Math.round(res * 0.9)) : 0;
  const gdy = gsh ? Math.max(1, Math.round(res * 0.75)) : 0;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const boxes: [number, number, number, number][] = [];
  for (const part of parts) {
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
    minX = Math.min(minX, bx0);
    maxX = Math.max(maxX, bx1);
    minY = Math.min(minY, by0 - Math.round((part.z + part.h) * lift));
    maxY = Math.max(maxY, by1 - Math.round(part.z * lift));
  }
  const pad = 2;
  const ox = Math.ceil(-minX) + pad;
  const oy = Math.ceil(-minY) + pad;
  const W = Math.ceil(maxX) + ox + pad + 1 + gdx;
  const H = Math.ceil(maxY) + oy + pad + 1 + gdy;
  const n = W * H;
  const pid = new Int16Array(n).fill(-1);
  const zb = new Int16Array(n).fill(-1);
  const tone = new Uint8Array(n);
  const own = ownerTones(o.owner);
  const ramps: (RGB[] | null)[] = [];
  const alts: (RGB[] | null)[] = [];

  const preps: Prep[] = [];
  parts.forEach((part, i) => {
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
        if (contains(part, X * cos + Y * sin, -X * sin + Y * cos)) g[(y - y0) * gw + (x - x0)] = 1;
      }
    }
    const B = Math.round(part.z * lift);
    const T = Math.max(B, Math.round((part.z + part.h) * lift));
    preps.push({ part, x0, y0, x1, y1, g, gw, B, T, top: part.z + part.h });
    ramps.push(part.m === 'own' ? own : rampOf(part.m));
    alts.push(part.alt ? (part.alt === 'own' ? own : rampOf(part.alt)) : null);
  });
  const G = (pp: Prep, x: number, y: number): boolean => x >= pp.x0 && x <= pp.x1 && y >= pp.y0 && y <= pp.y1 && pp.g[(y - pp.y0) * pp.gw + (x - pp.x0)] === 1;
  const isTop = (pp: Prep, x: number, y: number): boolean => G(pp, x, y + pp.T);
  const isSide = (pp: Prep, x: number, y: number): boolean => {
    for (let t = pp.B; t < pp.T; t++) if (G(pp, x, y + t)) return true;
    return false;
  };
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
    const shift = part.tone ?? 0;
    for (let y = ya; y <= yb; y++) {
      for (let x = pp.x0; x <= pp.x1; x++) {
        const top = isTop(pp, x, y);
        // the highest point of this part on the ray through the pixel: its top, or where it meets its near side
        let hit = top ? pp.T : -1;
        if (!top && part.h > 0) for (let t = pp.T - 1; t >= pp.B; t--) if (G(pp, x, y + t)) {
          hit = t;
          break;
        }
        if (hit < 0) continue;
        const side = !top;
        if (part.edge && top && isTop(pp, x - 1, y) && isTop(pp, x + 1, y) && isTop(pp, x, y - 1) && isTop(pp, x, y + 1)) continue;
        const idx = y * W + x;
        // depth: the visible surface is the highest one along the view ray (ties go to the later part: decals)
        if (zb[idx] > hit) continue;
        zb[idx] = hit;
        let t: number;
        let alt = false;
        if (top) {
          const [u, v] = toModel(x, y + pp.T);
          let tf: number;
          if (sh === 'plate') {
            tf = !isTop(pp, x + 1, y) || !isTop(pp, x, y + 1) ? 1 : !isTop(pp, x - 1, y) || !isTop(pp, x, y - 1) ? 3 : 2;
          } else if (sh === 'flat') {
            const rim = !isTop(pp, x, y - 1) || !isTop(pp, x - 1, y);
            tf = part.h > 0 ? (rim ? 3 : 2) : rim && part.inset ? 1 : 2;
            if (part.edge) tf = part.h > 0 ? 3 : 2;
            tf += flatShift;
          } else tf = curved(part, sh, u, v, cos, sin, rs, rc);
          tf += shift;
          t = Math.floor(tf + 0.5 + bayer(x, y) * (sh === 'flat' || sh === 'plate' ? 0.5 : 0.8));
          t = t < 0 ? 0 : t > 3 ? 3 : t;
          const r = pattern(part, t, part.pat === 'tread' ? u + tread : u, v, res, x, y);
          t = r & 7;
          alt = (r & ALT) !== 0;
        } else {
          // sides: dark, the bottom row deeper; the lit (west) end of a side a little lighter
          t = isSide(pp, x, y + 1) || isTop(pp, x, y + 1) ? 1 : 0;
          t = Math.max(0, Math.min(3, t + shift));
          if (part.pat === 'tread') {
            const [u] = toModel(x, y + pp.B);
            const q = (u + tread) / 1.4 - Math.floor((u + tread) / 1.4);
            if (q < 0.5) t = Math.max(0, t - 1);
          }
        }
        pid[idx] = i;
        tone[idx] = t | (alt ? ALT : 0);
      }
    }
  }

  // cast shadow: a pixel with a higher part up and left of it (one or two px, by resolution) is a tone darker
  const shadowed = new Uint8Array(n);
  const casts = (me: number, j: number): boolean => j >= 0 && j !== me && preps[j].top > preps[me].top + 0.5 && !preps[j].part.glow && (preps[j].part.a ?? 1) >= 1;
  const reach = res >= 1.9 ? 2 : 1;
  for (let y = 1; y < H; y++) {
    for (let x = 1; x < W; x++) {
      const idx = y * W + x;
      const me = pid[idx];
      if (me < 0 || preps[me].part.glow) continue;
      if (casts(me, pid[idx - W - 1]) || casts(me, pid[idx - 1]) || casts(me, pid[idx - W])) shadowed[idx] = 1;
      else if (reach > 1 && x > 1 && y > 1 && (casts(me, pid[idx - 2 * W - 2]) || casts(me, pid[idx - 2 * W - 1]) || casts(me, pid[idx - W - 2]))) shadowed[idx] = 1;
    }
  }

  const data = new Uint8ClampedArray(n * 4);
  const solid = new Uint8Array(n);
  for (let idx = 0; idx < n; idx++) {
    const i = pid[idx];
    if (i < 0) continue;
    const part = preps[i].part;
    const tv = tone[idx];
    const ramp = tv & ALT ? alts[i] ?? ramps[i] : ramps[i];
    if (!ramp) continue;
    const t0 = tv & 7;
    const t = shadowed[idx] ? Math.max(0, t0 - 1) : t0;
    const c = ramp[t];
    const o4 = idx * 4;
    data[o4] = c[0];
    data[o4 + 1] = c[1];
    data[o4 + 2] = c[2];
    const a = part.a ?? 1;
    data[o4 + 3] = Math.round(a * 255);
    if (a >= 1 && !part.glow) solid[idx] = 1;
  }
  // the rim: empty pixels next to a solid one get a translucent dark edge, heavier below and right of the unit
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const idx = y * W + x;
      if (data[idx * 4 + 3] !== 0) continue;
      const fromLeft = x > 0 && solid[idx - 1];
      const fromUp = y > 0 && solid[idx - W];
      const fromRight = x < W - 1 && solid[idx + 1];
      const fromDown = y < H - 1 && solid[idx + W];
      if (!(fromLeft || fromUp || fromRight || fromDown)) continue;
      const o4 = idx * 4;
      data[o4] = 10;
      data[o4 + 1] = 13;
      data[o4 + 2] = 17;
      data[o4 + 3] = fromLeft || fromUp ? 120 : 72;
    }
  }
  // the soft cast shadow on the ground
  if (gsh > 0) {
    const a = Math.round(gsh * 255);
    for (let y = H - 1; y >= gdy; y--) {
      for (let x = W - 1; x >= gdx; x--) {
        const idx = y * W + x;
        if (data[idx * 4 + 3] !== 0) continue;
        if (!solid[idx - gdy * W - gdx]) continue;
        const o4 = idx * 4;
        data[o4] = 8;
        data[o4 + 1] = 10;
        data[o4 + 2] = 12;
        data[o4 + 3] = a;
      }
    }
  }
  return { w: W, h: H, ox, oy, data };
}

/**
 * Lines and posts at least one art pixel wide at this resolution, so barrels, masts and railings never break up (a
 * line seen side on must still cover the middle of one foreshortened pixel row).
 */
function minSize(p: Part, res: number): Part {
  const w = 1.25 / res;
  const r = 0.6 / res;
  if (p.k === 'seg' && p.p[4] < w) return { ...p, p: [p.p[0], p.p[1], p.p[2], p.p[3], w] };
  if (p.k === 'ell' && (p.p[2] < r || p.p[3] < r)) return { ...p, p: [p.p[0], p.p[1], Math.max(r, p.p[2]), Math.max(r, p.p[3])] };
  return p;
}

/** Fractional tone of a dome or cylinder top at model point (u, v), with the bank's tilt. */
function curved(part: Part, sh: Shade, u: number, v: number, cos: number, sin: number, rs: number, rc: number): number {
  const p = part.p;
  let nu = 0;
  let nv = 0;
  if (part.k === 'seg' && !part.sc) {
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
  let nz = Math.sqrt(Math.max(0, 1 - nu * nu - nv * nv));
  // the bank turns the normal about the nose axis
  if (rs) {
    const nv2 = nv * rc + nz * rs;
    nz = -nv * rs + nz * rc;
    nv = nv2;
  }
  const nx = nu * cos - nv * sin;
  const ny = nu * sin + nv * cos;
  return toneOf(nx * 0.9 * LX + ny * 0.9 * LY + nz * LZ);
}

/** Surface patterns in model space (they turn with the unit); fine ones only where the resolution has room. */
function pattern(part: Part, t: number, u: number, v: number, res: number, x: number, y: number): number {
  const pat = part.pat;
  if (!pat) return t;
  const fine = res >= 1.6;
  const px = 1 / res;
  switch (pat) {
    case 'planks': {
      // planks along the hull, a dark seam every 1.5 units, butt joints staggered, a few boards a shade lighter
      if (!fine) return t;
      const row = Math.floor(v / 1.5);
      const f = v / 1.5 - row;
      if (f * 1.5 < px * 0.95) return Math.max(0, t - 1);
      const joint = (u + row * 3.7) / 7;
      if ((joint - Math.floor(joint)) * 7 < px * 0.95) return Math.max(0, t - 1);
      return hash2(row, Math.floor(joint), 3) > 0.78 ? Math.min(3, t + 1) : t;
    }
    case 'grille': {
      const f = u / 1.1 - Math.floor(u / 1.1);
      return f * 1.1 < (fine ? px : 0.55) ? Math.max(0, t - 1) : t;
    }
    case 'tread': {
      const f = u / 1.4 - Math.floor(u / 1.4);
      return f * 1.4 < (fine ? px * 1.1 : 0.7) ? Math.max(0, t - 1) : t;
    }
    case 'ribs': {
      // corrugated container walls: thin ribs across, and a seam between boxes every 4 units
      const s = u / 4 - Math.floor(u / 4);
      if (s * 4 < px * 1.05) return 0;
      if (!fine) return t;
      const f = u / 0.9 - Math.floor(u / 0.9);
      return f * 0.9 < px ? Math.max(0, t - 1) : t;
    }
    case 'hatches': {
      // cargo hatch covers: panels across with dark gaps
      const s = u / 2.2 - Math.floor(u / 2.2);
      return s * 2.2 < px * 1.05 ? Math.max(0, t - 1) : t;
    }
    case 'panels': {
      if (!fine) return t;
      const f = u / 3.2 - Math.floor(u / 3.2);
      return f * 3.2 < px * 0.9 && (x + y) % 2 === 0 ? Math.max(0, t - 1) : t;
    }
    case 'frames': {
      // canopy frames over glass
      if (!fine) return t;
      const f = u / 1.3 - Math.floor(u / 1.3);
      return f * 1.3 < px * 0.9 ? 0 : t;
    }
    case 'blotch': {
      // disruptive camouflage in the part's second material
      const n = vnoise(u * 0.32 + 7.1, v * 0.32 + 3.3, 11);
      return n > 0.56 ? t | ALT : t;
    }
    case 'helmets': {
      // rows of helmeted troops in a well deck: a lit helmet, a darker shoulder under it
      const cu = u / 1.25 - Math.floor(u / 1.25);
      const cv = v / 1.25 - Math.floor(v / 1.25);
      if (cu < 0.55 && cv < 0.55) return t | ALT;
      return cu < 0.55 && cv < 0.85 ? (Math.max(0, t - 1) | ALT) : Math.max(0, t - 1);
    }
    case 'rivets': {
      if (!fine) return t;
      const f = u / 1.6 - Math.floor(u / 1.6);
      return f < 0.3 && (x + y) % 2 === 0 ? Math.min(3, t + 1) : t;
    }
    case 'deckLines': {
      // a flight deck: the dashed centre line in paint (alt), joints between deck plates
      if (Math.abs(v) < Math.max(0.3, px * 0.6) && Math.floor(u / 2.6) % 2 === 0) return 3 | ALT;
      if (!fine) return t;
      const f = u / 3 - Math.floor(u / 3);
      return f * 3 < px * 0.9 ? Math.max(0, t - 1) : t;
    }
  }
  return t;
}

/** A dark translucent silhouette of a baked sprite (the ground shadow of planes and missiles), same size. */
export function shadowOf(b: Baked, alpha = 0.24): Baked {
  const data = new Uint8ClampedArray(b.data.length);
  const a = Math.round(alpha * 255);
  for (let i = 3; i < data.length; i += 4) {
    // the rim and translucent parts count less, so the shadow keeps the plane's own shape
    if (b.data[i] < 200) continue;
    data[i - 3] = 6;
    data[i - 2] = 9;
    data[i - 1] = 13;
    data[i] = a;
  }
  return { w: b.w, h: b.h, ox: b.ox, oy: b.oy, data };
}

/** Opaque pixel count (tests). */
export function solidCount(b: Baked): number {
  let c = 0;
  for (let i = 3; i < b.data.length; i += 4) if (b.data[i] === 255) c++;
  return c;
}
