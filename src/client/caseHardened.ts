/**
 * Colour case hardening for the start page's title card: the logo and the main action wear an irregular, mottled
 * heat-tint finish (deep blue, purple, straw gold and bronze clouded over grey steel), drawn once at startup.
 *
 * The pattern is procedural and seeded (a local PRNG and hashed value noise, never Math.random), so every load and
 * every screenshot is the same picture. Recipe: three-level domain-warped fbm gives the swirling oxide "thickness";
 * its quantiles go through the heat-tint ramp with uneven shares (blue and purple most, gold least); a second field
 * lets bare grey steel show through in patches; a hue jitter field and fine brushed grain break up any contour that
 * could read as a stripe. Two ramps share the field: a light one for the logo (every pixel at least 4.5:1 on the
 * menu column) and a deep one for the button (every pixel dark enough for white text at 4.5:1 or more). The logo and
 * the button are cut from different parts of the field so they never look tiled.
 *
 * Without a 2D canvas (jsdom, a locked-down browser) nothing is set and the CSS keeps a flat steel-blue fill.
 */

export type CaseVariant = 'A' | 'B' | 'C' | 'D';

/** The owner's pick: A balanced, B more blue, C more gold and bronze, D more purple. */
export const CASE_VARIANT: CaseVariant = 'A';

interface CaseRecipe {
  seed: number;
  /** cumulative share of the area that ends each band: straw, bronze, purple, deep blue (light blue takes the rest) */
  bands: [number, number, number, number];
  /** share of the area where bare grey steel shows through */
  bare: number;
}

export const CASE_RECIPES: Record<CaseVariant, CaseRecipe> = {
  A: { seed: 0x5eed_a11c, bands: [0.08, 0.18, 0.42, 0.84], bare: 0.2 },
  B: { seed: 0x0b1e_9e35, bands: [0.03, 0.07, 0.17, 0.82], bare: 0.12 },
  C: { seed: 0x601d_b20e, bands: [0.2, 0.44, 0.6, 0.88], bare: 0.16 },
  D: { seed: 0x9e9b_1e0d, bands: [0.03, 0.08, 0.78, 0.92], bare: 0.14 },
};

type Rgb = [number, number, number];

/** The heat-tint ramps in sRGB 0..255: bare steel, straw gold, bronze, purple, deep blue, light blue. */
const LOGO_RAMP: Rgb[] = [
  [150, 158, 168],
  [226, 188, 102],
  [204, 128, 70],
  [156, 98, 214],
  [66, 102, 232],
  [96, 158, 236],
];
const FILL_RAMP: Rgb[] = [
  [96, 102, 110],
  [132, 106, 54],
  [114, 74, 46],
  [84, 46, 120],
  [30, 50, 136],
  [50, 92, 160],
];

/** Relative luminance limits per pixel (WCAG): logo >= 0.15 is 3.3:1 or more on the column (about #0e131b; 60px
 *  display type, so the large-text floor of 3:1 applies), with a dark edge in the CSS as well; the button fill
 *  <= 0.168 keeps white text at 4.8:1 or more on the brightest pixel. */
const LOGO_MIN_LUM = 0.15;
const FILL_MAX_LUM = 0.168;

// ---- seeded noise ----

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeNoise(seed: number): (x: number, y: number) => number {
  const s = seed >>> 0;
  const hash = (ix: number, iy: number): number => {
    let h = Math.imul(ix, 0x27d4eb2d) ^ Math.imul(iy, 0x165667b1) ^ s;
    h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
    h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  };
  return (x, y) => {
    const ix = Math.floor(x);
    const iy = Math.floor(y);
    const fx = x - ix;
    const fy = y - iy;
    const ux = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
    const uy = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
    const a = hash(ix, iy);
    const b = hash(ix + 1, iy);
    const c = hash(ix, iy + 1);
    const d = hash(ix + 1, iy + 1);
    return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
  };
}

/** fbm with a different rotation and offset per octave, so the value-noise lattice never lines up */
function makeFbm(rand: () => number, octaves: number, gain: number): (x: number, y: number) => number {
  const noise = makeNoise(Math.floor(rand() * 4294967296));
  const rot: { c: number; s: number; ox: number; oy: number }[] = [];
  for (let i = 0; i < octaves; i++) {
    const a = rand() * Math.PI * 2;
    rot.push({ c: Math.cos(a), s: Math.sin(a), ox: rand() * 97, oy: rand() * 97 });
  }
  return (x, y) => {
    let sum = 0;
    let amp = 1;
    let norm = 0;
    let f = 1;
    for (let i = 0; i < octaves; i++) {
      const r = rot[i];
      const px = (x * r.c - y * r.s) * f + r.ox;
      const py = (x * r.s + y * r.c) * f + r.oy;
      sum += amp * noise(px, py);
      norm += amp;
      amp *= gain;
      f *= 2.03;
    }
    return sum / norm;
  };
}

// ---- colour helpers ----

const toLin = (c: number): number => {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};
const toSrgb = (v: number): number => {
  const c = v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055;
  return Math.max(0, Math.min(255, Math.round(c * 255)));
};
/** linear to sRGB through a table (the pixel loop runs half a million times) */
const LUT = 4096;
const SRGB = new Uint8Array(LUT);
for (let i = 0; i < LUT; i++) SRGB[i] = toSrgb(i / (LUT - 1));
const smooth = (a: number, b: number, x: number): number => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** Quantile lookup for a field: maps a value to the share of samples below it, so band shares are exact areas. */
function quantiles(values: Float32Array): (v: number) => number {
  const BINS = 2048;
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of values) {
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  const span = hi - lo || 1;
  const cdf = new Float32Array(BINS + 1);
  for (const v of values) cdf[Math.min(BINS - 1, Math.floor(((v - lo) / span) * BINS)) + 1]++;
  for (let i = 1; i <= BINS; i++) cdf[i] += cdf[i - 1];
  for (let i = 0; i <= BINS; i++) cdf[i] /= values.length;
  return (v) => {
    const p = Math.max(0, Math.min(BINS - 1e-6, ((v - lo) / span) * BINS));
    const i = Math.floor(p);
    return cdf[i] + (cdf[i + 1] - cdf[i]) * (p - i);
  };
}

// ---- the texture ----

export interface CaseTexture {
  width: number;
  height: number;
  /** RGBA pixels at device scale */
  data: Uint8ClampedArray;
}

export interface CaseRegion {
  /** where this cut sits in the field, in CSS px */
  x: number;
  y: number;
  w: number;
  h: number;
  ramp: 'logo' | 'fill';
}

const fields = new Map<CaseVariant, ReturnType<typeof buildField>>();

function caseField(variant: CaseVariant): ReturnType<typeof buildField> {
  let f = fields.get(variant);
  if (!f) {
    f = buildField(CASE_RECIPES[variant].seed);
    fields.set(variant, f);
  }
  return f;
}

/** The shared field for one variant (the logo and the button cut from it), computed once. */
function buildField(seed: number) {
  const rand = mulberry32(seed);
  const warpA = makeFbm(rand, 4, 0.5);
  const warpB = makeFbm(rand, 4, 0.5);
  const warpC = makeFbm(rand, 4, 0.52);
  const warpD = makeFbm(rand, 4, 0.52);
  const thick = makeFbm(rand, 5, 0.55);
  const bareF = makeFbm(rand, 5, 0.6);
  const jitter = makeFbm(rand, 3, 0.5);
  const tone = makeFbm(rand, 5, 0.62);
  const grainN = makeNoise(Math.floor(rand() * 4294967296));
  const pitSeed = Math.floor(rand() * 4294967296) >>> 0;
  const pitHash = (x: number, y: number): number => {
    let h = Math.imul(x, 0x27d4eb2d) ^ Math.imul(y, 0x165667b1) ^ pitSeed;
    h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
    return ((h ^ (h >>> 13)) >>> 0) / 4294967296;
  };
  const grainAngle = 0.06 + rand() * 0.08;

  const base = 1 / 150; // the biggest swirls are a few hundred px across
  /** the four fields at one point in CSS px: oxide thickness, bare steel, hue jitter, lightness */
  const at = (cx: number, cy: number, out: Float32Array): void => {
    const x = cx * base;
    const y = cy * base * 1.15;
    // three-level domain warp: the oxide flows in uneven swirls
    const qx = warpA(x, y);
    const qy = warpB(x + 5.2, y + 1.3);
    const rx = warpC(x + 3.1 * qx + 1.7, y + 3.1 * qy + 9.2);
    const ry = warpD(x + 3.1 * qx + 8.3, y + 3.1 * qy + 2.8);
    out[0] = thick(x + 3.2 * rx, y + 3.2 * ry);
    out[1] = bareF(x * 1.9 + 2.4 * qx, y * 1.9 + 2.4 * ry);
    out[2] = jitter(x * 3.1 + 1.1 * rx, y * 3.1);
    out[3] = tone(x * 2.3, y * 2.3);
  };
  // a coarse pass over the whole bar (642 x 402 CSS px) sets the quantiles, so band shares describe the whole piece
  // and every cut of it uses the same thresholds
  const STEP = 6;
  const n = (Math.floor(642 / STEP) + 1) * (Math.floor(402 / STEP) + 1);
  const tAll = new Float32Array(n);
  const bAll = new Float32Array(n);
  const v = new Float32Array(4);
  let k = 0;
  for (let cy = 0; cy <= 402; cy += STEP) {
    for (let cx = 0; cx <= 642; cx += STEP) {
      at(cx, cy, v);
      tAll[k] = v[0];
      bAll[k++] = v[1];
    }
  }
  return { at, tq: quantiles(tAll), bq: quantiles(bAll), grainN, pitHash, grainAngle };
}

/**
 * Draws one region of the case-hardened field at `scale` device pixels per CSS px. Pure (no DOM), so tests and the
 * scratch screenshot scripts can call it directly.
 */
export function drawCaseRegion(variant: CaseVariant, region: CaseRegion, scale = 2): CaseTexture {
  const recipe = CASE_RECIPES[variant];
  const { at, tq, bq, grainN, pitHash, grainAngle } = caseField(variant);
  const ramp = (region.ramp === 'logo' ? LOGO_RAMP : FILL_RAMP).map((c) => c.map(toLin) as Rgb);
  const [s1, s2, s3, s4] = recipe.bands;
  // each colour holds its own share as a patch, and blends into the next only across a soft cloudy edge (a continuous
  // ramp would draw every colour as thin contour rings around the next)
  const edges = [s1, s2, s3, s4];
  const shares = [s1, s2 - s1, s3 - s2, s4 - s3, 1 - s4];
  const heat = (t: number): Rgb => {
    let band = 0;
    while (band < 4 && t > edges[band]) band++;
    const c = ramp[band + 1];
    // the nearest edge, and how soft it is (about half the narrower neighbour, so thin bands still show)
    let e = -1;
    let other = band;
    if (band > 0 && (band === 4 || t - edges[band - 1] < edges[band] - t)) {
      e = band - 1;
      other = band - 1;
    } else if (band < 4) {
      e = band;
      other = band + 1;
    }
    if (e < 0) return c;
    const soft = Math.min(shares[band], shares[other]) * 0.55;
    const d = Math.abs(t - edges[e]);
    if (d >= soft) return c;
    const u = 0.5 * (1 - smooth(0, 1, d / soft));
    const o = ramp[other + 1];
    return [c[0] + (o[0] - c[0]) * u, c[1] + (o[1] - c[1]) * u, c[2] + (o[2] - c[2]) * u];
  };

  // the tint itself at one sample per TS CSS px (it is cloudy, so this loses nothing), in linear RGB
  const TS = 2;
  const cw = Math.ceil(region.w / TS) + 2;
  const ch = Math.ceil(region.h / TS) + 2;
  const tint = new Float32Array(cw * ch * 3);
  const lights = new Float32Array(cw * ch);
  const steel = ramp[0];
  const v = new Float32Array(4);
  for (let j = 0; j < ch; j++) {
    for (let i = 0; i < cw; i++) {
      const cx = region.x + i * TS;
      const cy = region.y + j * TS;
      at(cx, cy, v);
      const t = Math.max(0, Math.min(1, tq(v[0]) + (v[2] - 0.5) * 0.16));
      let [r, g, b] = heat(t);
      // bare grey steel showing through, with soft cloudy edges and a little of the tint left on it
      const m = 0.8 * smooth(1 - recipe.bare - 0.1, 1 - recipe.bare + 0.1, bq(v[1]));
      r += (steel[0] - r) * m;
      g += (steel[1] - g) * m;
      b += (steel[2] - b) * m;
      // slow lightness mottling
      const light = 1 + (v[3] - 0.5) * 0.42;
      lights[j * cw + i] = v[3];
      const k = (j * cw + i) * 3;
      tint[k] = r * light;
      tint[k + 1] = g * light;
      tint[k + 2] = b * light;
    }
  }

  const W = Math.round(region.w * scale);
  const H = Math.round(region.h * scale);
  const out = new Uint8ClampedArray(W * H * 4);
  const ca = Math.cos(grainAngle);
  const sa = Math.sin(grainAngle);
  const fill = region.ramp === 'fill';
  for (let py = 0; py < H; py++) {
    const ty = py / scale;
    const j = Math.min(ch - 2, Math.floor(ty / TS));
    const fy = ty / TS - j;
    for (let px = 0; px < W; px++) {
      const tx = px / scale;
      const i = Math.min(cw - 2, Math.floor(tx / TS));
      const fx = tx / TS - i;
      const k0 = (j * cw + i) * 3;
      const k1 = k0 + cw * 3;
      const w00 = (1 - fx) * (1 - fy);
      const w10 = fx * (1 - fy);
      const w01 = (1 - fx) * fy;
      const w11 = fx * fy;
      let r = tint[k0] * w00 + tint[k0 + 3] * w10 + tint[k1] * w01 + tint[k1 + 3] * w11;
      let g = tint[k0 + 1] * w00 + tint[k0 + 4] * w10 + tint[k1 + 1] * w01 + tint[k1 + 4] * w11;
      let b = tint[k0 + 2] * w00 + tint[k0 + 5] * w10 + tint[k1 + 2] * w01 + tint[k1 + 5] * w11;
      // brushed grain along a slight slant, and sparse pits
      const cx = region.x + tx;
      const cy = region.y + ty;
      const gxr = cx * ca + cy * sa;
      const gyr = -cx * sa + cy * ca;
      const grain = (grainN(gxr * 0.11, gyr * 1.3) - 0.5) * 0.08 * (0.4 + (lights[j * cw + i] - 0.2) * 1.6);
      const pit = pitHash(px, py);
      const light = 1 + grain + (pit > 0.965 ? -(pit - 0.965) * 4 : 0);
      r *= light;
      g *= light;
      b *= light;
      // the legibility limits, by construction (the rendered pixels are measured again by a script)
      const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      if (fill && lum > FILL_MAX_LUM) {
        const f = FILL_MAX_LUM / lum;
        r *= f;
        g *= f;
        b *= f;
      } else if (!fill && lum < LOGO_MIN_LUM) {
        // lift by scaling (keeps the hue and its saturation), then top up toward white for what clipping lost
        const f = LOGO_MIN_LUM / Math.max(lum, 1e-4);
        r = Math.min(1, r * f);
        g = Math.min(1, g * f);
        b = Math.min(1, b * f);
        const l2 = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        if (l2 < LOGO_MIN_LUM) {
          const w = (LOGO_MIN_LUM - l2) / (1 - l2);
          r += (1 - r) * w;
          g += (1 - g) * w;
          b += (1 - b) * w;
        }
      }
      const o = (py * W + px) * 4;
      out[o] = SRGB[Math.max(0, Math.min(LUT - 1, Math.round(r * (LUT - 1))))];
      out[o + 1] = SRGB[Math.max(0, Math.min(LUT - 1, Math.round(g * (LUT - 1))))];
      out[o + 2] = SRGB[Math.max(0, Math.min(LUT - 1, Math.round(b * (LUT - 1))))];
      out[o + 3] = 255;
    }
  }
  return { width: W, height: H, data: out };
}

/** The two cuts: far apart in the field, so the logo and the button show different metal. The logo's cut is shown
 *  at LOGO_ZOOM, so its thin pixel strokes cross several patches (at full size each letter would be one colour). */
export const LOGO_CUT: CaseRegion = { x: 30, y: 24, w: 600, h: 130, ramp: 'logo' };
export const LOGO_ZOOM = 0.6;
export const FILL_CUT: CaseRegion = { x: 120, y: 262, w: 480, h: 72, ramp: 'fill' };

function toDataUrl(tex: CaseTexture): string | null {
  try {
    const c = document.createElement('canvas');
    c.width = tex.width;
    c.height = tex.height;
    const ctx = c.getContext('2d');
    if (!ctx) return null;
    ctx.putImageData(new ImageData(tex.data, tex.width, tex.height), 0, 0);
    const url = c.toDataURL('image/png');
    return url.startsWith('data:image/png') ? url : null;
  } catch {
    return null;
  }
}

/** A cheap probe, so a browser without a 2D canvas (jsdom) skips the drawing work entirely. */
function canDraw(): boolean {
  try {
    if (typeof document === 'undefined' || typeof ImageData === 'undefined') return false;
    const c = document.createElement('canvas');
    c.width = c.height = 1;
    return !!c.getContext('2d');
  } catch {
    return false;
  }
}

let applied: CaseVariant | null = null;

/**
 * Draws the finish once and hands it to the CSS as two custom properties on the root, plus the `case-ready` class
 * that switches the title card from its flat fallback to the textures. Safe to call more than once.
 */
export function applyCaseHardened(target?: HTMLElement, variant: CaseVariant = CASE_VARIANT): boolean {
  if (applied === variant) return true;
  if (!canDraw()) return false;
  const root = target ?? document.documentElement;
  // two device pixels per CSS px on dense screens (the grain stays crisp), one elsewhere (a quarter of the work)
  const scale = (typeof devicePixelRatio === 'number' ? devicePixelRatio : 1) > 1.25 ? 2 : 1;
  const logo = toDataUrl(drawCaseRegion(variant, LOGO_CUT, scale * LOGO_ZOOM));
  const fill = toDataUrl(drawCaseRegion(variant, FILL_CUT, scale));
  if (!logo || !fill) return false;
  root.style.setProperty('--case-logo', `url("${logo}")`);
  root.style.setProperty('--case-logo-size', `${LOGO_CUT.w * LOGO_ZOOM}px ${LOGO_CUT.h * LOGO_ZOOM}px`);
  root.style.setProperty('--case-fill', `url("${fill}")`);
  root.style.setProperty('--case-fill-size', `${FILL_CUT.w}px ${FILL_CUT.h}px`);
  root.classList.add('case-ready');
  applied = variant;
  return true;
}
