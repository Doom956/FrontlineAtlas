// The refined style's unit sprite rasterizer (client only). A unit is a small model: parts with a footprint (box,
// ellipse, polygon or thick segment) in model units (1 unit = 1 art pixel at full size; nose at +u, starboard at +v), a
// base height and a height. A model is rasterized per facing (16 headings), size and bank, never rotated as an image, so
// the pixels stay square and crisp at every heading and the light stays where it belongs:
//   - one view for every unit: a slight 3/4 top-down angle (the ground is foreshortened by FORE, height lifts a part
//     up by LIFT per unit), so the top of each part and a hint of its near (south) side show;
//   - one light for every unit: from the top left. Tops get a light rim on their upper and left edges (flat parts) or
//     a 4-tone curve (domes and cylinders: turrets, fuselages, barrels); sides are dark with a deep bottom row; a raised
//     part casts a 1 px shadow down and right onto what is under it;
//   - a soft 1 px edge round the silhouette only: dark slate (not black) on the shadow side, the deep tone of the part it
//     borders on the lit side (selective outline), so a unit reads on any ground without a cartoon ink line;
//   - planes bank: a roll about the fuselage tilts the whole model (one wing dips and its paint turns toward or away
//     from the light), baked in a few steps per side (sprites.ts picks the step from the turn rate);
//   - missiles are drawn flat from straight above (Model.flat), so a slender body stays slender at every heading;
//   - an owner plate (Shade 'plate') is a flat 2-tone slab in the toned-down owner colour ('ownDim').
// Materials are muted 4-tone ramps (palette.ts); the owner's colour is one more material ('own') used only for small
// marks, so the metal keeps its own tones. Propellers are not part of a model: a model lists its propeller hubs
// (Model.props) and sprites.ts draws spinning blur discs there.
// The result is a plain RGBA buffer (no canvas): sprites.ts copies it into an atlas page once and draws it with
// whole-number scaling. Pure and deterministic for the same input, so tests can check the art without a browser.
import { ownerRamp, type RGB } from '../shared/colour';
import { EDGE, HELMET, ownerDim, PAINT, RAMPS, type BaseMat } from './palette';

export { ownerRamp };

/** Ground foreshortening of the 3/4 view (screen y per model y). */
export const FORE = 0.84;
/** Screen px a part rises per model unit of height (at full size). */
export const LIFT = 0.55;
/** Headings a model is baked at. */
export const FACINGS = 16;
/** The edge colour on the shadow side of every sprite (dark slate, not black). */
export const OUTLINE: RGB = EDGE;

/** Material ramps (deep, dark, base, light). */
export const MATERIALS = RAMPS;

export type MatId = BaseMat | 'own' | 'ownDim';

/** 'plate': a flat 2-tone slab (the owner plate under a vehicle): base colour with a darker lower and right rim. */
export type Shade = 'flat' | 'dome' | 'cyl' | 'plate';
export type Pattern = 'tread' | 'grille' | 'deckline' | 'planks' | 'helmets' | 'rivets' | 'hatch' | 'wheels' | 'tubes';

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
  /**
   * with `a`: water washing over what is under it (a submarine's decks awash): the pixels below keep their shape but take
   * this material's colour by `a`, and lose their edge (a submerged part has no outline); where nothing is under it, it
   * is drawn translucent like any `a` part
   */
  wash?: boolean;
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

/** A propeller hub: where sprites.ts draws a spinning disc (model units; r = blade length). */
export interface Prop {
  u: number;
  v: number;
  z: number;
  r: number;
}

export interface Model {
  parts: readonly Part[];
  /** flies: drawn with a ground shadow */
  air?: boolean;
  /** drawn straight from above (missiles): no ground foreshortening and no height lift, so a slender body stays slender at every heading */
  flat?: boolean;
  /** propeller hubs (planes without jets) */
  props?: readonly Prop[];
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

// ------------------------------------------------------------------------------------------------ projection

/**
 * The screen offset (art px from the model origin) of a model point (u, v, height z) at `res` art px per model unit,
 * heading `facing` and bank `roll` (radians, positive = starboard wing down): the same projection the rasterizer
 * uses, for parts drawn over a sprite (propellers, muzzles).
 */
export function projector(res: number, facing: number, roll = 0, flat = false): (u: number, v: number, z: number) => [number, number] {
  const th = (((facing % FACINGS) + FACINGS) % FACINGS) * ((Math.PI * 2) / FACINGS);
  const cos = Math.cos(th);
  const sin = Math.sin(th);
  const fy = flat ? res : res * FORE;
  const lift = flat ? 0 : res * LIFT;
  const cr = Math.cos(roll);
  const sr = Math.sin(roll);
  return (u, v, z) => [(u * cos - v * cr * sin) * res, u * sin * fy + v * (cr * cos * fy + sr * lift) - z * lift];
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
const PAINT_T = 4;
const HELMET_T = 5;

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
 * banked by `roll` radians (planes; positive = starboard wing down), with the owner's colour for the 'own' parts.
 */
export function rasterize(model: Model, res: number, facing: number, owner: RGB, roll = 0): Baked {
  const th = (((facing % FACINGS) + FACINGS) % FACINGS) * ((Math.PI * 2) / FACINGS);
  const cos = Math.cos(th);
  const sin = Math.sin(th);
  const fy = model.flat ? res : res * FORE;
  const lift = model.flat ? 0 : res * LIFT;
  const rl = model.flat ? 0 : roll;
  const cr = Math.cos(rl);
  const sr = Math.sin(rl);
  // ground (u, v) to screen (X, Y): a rotation, the 3/4 foreshortening and the bank (a dipped wing is lower, so it
  // sits lower on screen); and back
  const ma = cos * res;
  const mb = -sin * cr * res;
  const mc = sin * fy;
  const md = cos * cr * fy + sr * lift;
  const det = ma * md - mb * mc || 1e-9;
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
      const x = ma * u + mb * v;
      const y = mc * u + md * v;
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
  const washOf = new Int16Array(n).fill(-1);
  const tone = new Uint8Array(n);
  const mat = new Array<RGB[] | undefined>(model.parts.length);
  const own = ownerRamp(owner);
  const dim = ownerDim(own[2]);
  /** model coordinates of a screen pixel's ground point */
  const toModel = (x: number, y: number): [number, number] => {
    const X = x + 0.5 - ox;
    const Y = y + 0.5 - oy;
    return [(md * X - mb * Y) / det, (-mc * X + ma * Y) / det];
  };
  // the bank turns flat tops toward or away from the light: a tone lighter or darker
  const tilt = rl === 0 ? 0 : -sr * sin * LX + sr * cos * LY + cr * LZ - LZ;
  const flatShift = tilt > 0.1 ? 1 : tilt < -0.12 ? -1 : 0;

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
      for (let x = x0; x <= x1; x++) {
        const [u, v] = toModel(x, y);
        if (contains(part, u, v)) g[(y - y0) * gw + (x - x0)] = 1;
      }
    }
    const B = Math.round(part.z * lift);
    const T = Math.max(B, Math.round((part.z + part.h) * lift));
    preps.push({ part, x0, y0, x1, y1, g, gw, B, T, top: part.z + part.h });
    mat[i] = part.m === 'own' ? own : part.m === 'ownDim' ? dim : RAMPS[part.m];
  });
  const G = (pp: Prep, x: number, y: number): boolean => x >= pp.x0 && x <= pp.x1 && y >= pp.y0 && y <= pp.y1 && pp.g[(y - pp.y0) * pp.gw + (x - pp.x0)] === 1;
  const isTop = (pp: Prep, x: number, y: number): boolean => G(pp, x, y + pp.T);
  const isSide = (pp: Prep, x: number, y: number): boolean => {
    for (let t = pp.B; t < pp.T; t++) if (G(pp, x, y + t)) return true;
    return false;
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
        if (part.wash && pid[idx] >= 0) {
          if (top) washOf[idx] = i;
          continue;
        }
        let t: number;
        if (top) {
          const [u, v] = toModel(x, y + pp.T);
          if (sh === 'plate') {
            t = !isTop(pp, x + 1, y) || !isTop(pp, x, y + 1) ? 1 : 2;
          } else if (sh === 'flat') {
            const rim = !isTop(pp, x, y - 1) || !isTop(pp, x - 1, y);
            t = part.h > 0 ? (rim ? 3 : 2) : rim && part.inset ? 1 : 2;
            if (flatShift) t = Math.max(0, Math.min(3, t + flatShift));
          } else {
            t = curved(part, sh, u, v, cos, sin, cr, sr);
          }
          t = pattern(part.pat, t, u, v, true);
        } else {
          t = isSide(pp, x, y + 1) || isTop(pp, x, y + 1) ? 1 : 0;
          if (part.pat === 'tread' || part.pat === 'wheels') {
            const [u] = toModel(x, y + pp.B);
            t = Math.floor(u / (part.pat === 'wheels' ? 2.2 : 1.5)) % 2 === 0 ? Math.max(0, t - 1) : Math.min(2, t + (part.pat === 'wheels' ? 1 : 0));
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
    let c: readonly number[] = t === PAINT_T ? PAINT : t === HELMET_T ? HELMET : ramp[t];
    const w = washOf[idx];
    const wa = w >= 0 ? (preps[w].part.a ?? 0.5) : 0;
    if (w >= 0) {
      const wc = mat[w]?.[2] ?? c;
      c = [c[0] + (wc[0] - c[0]) * wa, c[1] + (wc[1] - c[1]) * wa, c[2] + (wc[2] - c[2]) * wa];
    }
    const o = idx * 4;
    data[o] = c[0];
    data[o + 1] = c[1];
    data[o + 2] = c[2];
    const a = part.a ?? 1;
    data[o + 3] = Math.round(a * 255);
    if (a >= 1 && !part.glow && w < 0) solid[idx] = 1;
  }
  // the edge: empty pixels next to a solid one (4-neighbours). Below or right of the unit (the shadow side) dark slate;
  // above or left of it (the lit side) the deep tone of the part it borders
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const idx = y * W + x;
      if (data[idx * 4 + 3] === 255) continue;
      const left = x > 0 && solid[idx - 1];
      const up = y > 0 && solid[idx - W];
      const right = x < W - 1 && solid[idx + 1];
      const down = y < H - 1 && solid[idx + W];
      if (!left && !up && !right && !down) continue;
      let c: readonly number[] = OUTLINE;
      if (!left && !up) {
        const j = pid[right ? idx + 1 : idx + W];
        const r = j >= 0 ? mat[j] : undefined;
        if (r) c = r[0];
      }
      const o = idx * 4;
      data[o] = c[0];
      data[o + 1] = c[1];
      data[o + 2] = c[2];
      data[o + 3] = 255;
    }
  }
  return { w: W, h: H, ox, oy, data };
}

/** Tone of a dome or cylinder top at model point (u, v). */
function curved(part: Part, sh: Shade, u: number, v: number, cos: number, sin: number, cr: number, sr: number): number {
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
  let nz = Math.sqrt(Math.max(0, 1 - nu * nu - nv * nv));
  // the bank rolls the normal about the fuselage
  if (sr !== 0) {
    const v2 = nv * cr + nz * sr;
    nz = -nv * sr + nz * cr;
    nv = v2;
  }
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
    case 'wheels':
      return t;
    case 'grille':
      return Math.floor(u) % 2 === 0 ? Math.max(0, t - 1) : t;
    case 'planks':
      return Math.floor(u * 1.2) % 2 === 0 ? Math.max(0, t - 1) : t;
    case 'tubes':
      // torpedo tubes side by side along the mount
      return Math.floor((v + 20) * 1.5) % 2 === 0 ? Math.max(0, t - 1) : Math.min(3, t + 1);
    case 'hatch':
      // hatch boards across a cargo hatch
      return Math.floor(u * 0.8) % 2 === 0 ? Math.max(0, t - 1) : t;
    case 'rivets':
      return Math.floor(u / 2) % 2 === 0 && Math.abs(((v % 2) + 2) % 2) < 0.9 ? Math.min(3, t + 1) : t;
    case 'deckline':
      // a dashed white centre line on a flight deck
      return Math.abs(v) < 0.5 && Math.floor(u / 2.5) % 2 === 0 ? PAINT_T : t;
    case 'helmets':
      // rows of troops in a landing ship's well deck
      return (((u * 0.62) % 1) + 1) % 1 < 0.5 && (((v * 0.62) % 1) + 1) % 1 < 0.5 ? HELMET_T : t;
  }
  return t;
}

/** A dark translucent silhouette of a baked sprite (ground shadow of planes and missiles), same size. */
export function shadowOf(b: Baked, alpha = 0.24): Baked {
  const data = new Uint8ClampedArray(b.data.length);
  const a = Math.round(alpha * 255);
  for (let i = 3; i < data.length; i += 4) {
    if (b.data[i] === 0) continue;
    data[i - 3] = 10;
    data[i - 2] = 14;
    data[i - 1] = 18;
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
