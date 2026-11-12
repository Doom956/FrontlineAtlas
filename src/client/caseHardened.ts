/**
 * Colour case hardening for the start page's title card: the logo and the main action wear a heat-treated metal
 * finish instead of a smooth gradient, drawn once at startup. Two styles, each in four colour balances; the owner's
 * pick is the two constants below.
 *
 * - "swirl": fluid mottled swirls of blue, purple and gold over grey steel. Three-level domain-warped fbm gives the
 *   oxide "thickness"; its quantiles go through a heat-tint ramp with uneven shares; a second field lets bare steel
 *   show through; a hue jitter field and brushed grain break up any contour that could read as a stripe.
 * - "steel": classic colour case-hardened steel. A warm gold steel base (straw gold to brass, hue 35 to 50, mottled,
 *   with fine directional grain) carries blotchy light-blue islands with broken fractal edges (a warped, high-gain
 *   fbm cut at a quantile, so the blue share is an exact area), small blue specks, holes of gold inside the blue, a
 *   thin navy or purple rim right at the blue, an orange-gold halo bleeding out into the gold (box blurs of the blue
 *   mask, so rims keep an even width on any edge), a few pale hot spots in the halo and magenta flecks on the rims.
 *
 * Both are procedural and seeded (a local PRNG and hashed value noise, never Math.random), so every load and every
 * screenshot is the same picture. Two keys of the same metal: a light one for the logo (every pixel 3:1 or more on the
 * dark menu column, the large-text floor for 60px display type) and a deep one for the button (every pixel dark
 * enough for white text at 4.5:1 or more). The logo and the button are cut from different parts of the field.
 *
 * Without a 2D canvas (jsdom, a locked-down browser) nothing is set and the CSS keeps a flat steel-blue fill.
 */

export type CaseStyle = 'swirl' | 'steel';
export type CaseVariant = 'A' | 'B' | 'C' | 'D';

/** The owner's pick, one line each. Style: 'swirl' (fluid swirls) or 'steel' (classic case-hardened steel). */
export const CASE_STYLE: CaseStyle = 'steel';
/** Colour balance: A balanced, B mostly blue, C gold-heavy, D purple-heavy. */
export const CASE_VARIANT: CaseVariant = 'A';

interface SwirlRecipe {
  seed: number;
  /** cumulative share of the area that ends each band: straw, bronze, purple, deep blue (light blue takes the rest) */
  bands: [number, number, number, number];
  /** share of the area where bare grey steel shows through */
  bare: number;
}

export const SWIRL_RECIPES: Record<CaseVariant, SwirlRecipe> = {
  A: { seed: 0x5eed_a11c, bands: [0.08, 0.18, 0.42, 0.84], bare: 0.2 },
  B: { seed: 0x0b1e_9e35, bands: [0.03, 0.07, 0.17, 0.82], bare: 0.12 },
  C: { seed: 0x601d_b20e, bands: [0.2, 0.44, 0.6, 0.88], bare: 0.16 },
  D: { seed: 0x9e9b_1e0d, bands: [0.03, 0.08, 0.78, 0.92], bare: 0.14 },
};

type Rgb = [number, number, number];

/** The swirl's heat-tint ramps in sRGB 0..255: bare steel, straw gold, bronze, purple, deep blue, light blue. */
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

/** Relative luminance limits per pixel (WCAG), both styles: logo >= 0.15 is 3.3:1 or more on the column (about
 *  #0e131b; 60px display type, so the large-text floor of 3:1 applies), with a dark edge in the CSS as well; the
 *  button fill <= 0.168 keeps white text at 4.8:1 or more on the brightest pixel. */
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
  /** logo: the light key; fill: the deep key; plain: the metal as drawn (previews only) */
  ramp: 'logo' | 'fill' | 'plain';
  /** displayed size per field px: below 1 shrinks the pattern (more patches per letter), above 1 enlarges it */
  zoom?: number;
}

// ---- style "swirl" ----

const fields = new Map<CaseVariant, ReturnType<typeof buildField>>();

function swirlField(variant: CaseVariant): ReturnType<typeof buildField> {
  let f = fields.get(variant);
  if (!f) {
    f = buildField(SWIRL_RECIPES[variant].seed);
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

/** Draws one region of the swirl field at `scale` device pixels per field px. */
function drawSwirlRegion(variant: CaseVariant, region: CaseRegion, scale: number): CaseTexture {
  const recipe = SWIRL_RECIPES[variant];
  const { at, tq, bq, grainN, pitHash, grainAngle } = swirlField(variant);
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

// ---- style "steel" ----

interface SteelRecipe {
  seed: number;
  /** share of the area that is blue (islands and specks before rims) */
  blue: number;
  /** island size: the field's base wavelength in CSS px */
  size: number;
  /** dark rim width at the blue, and the orange-gold halo's reach, in displayed CSS px */
  rim: number;
  halo: number;
  /** rim hue from navy (0) to purple (1), and how often a rim turns magenta (0..1) */
  purple: number;
  magenta: number;
  /** how many small blue fragments and specks (0..1) */
  speck: number;
  /** how far the blue itself leans to violet (0..1) */
  violet: number;
}

export const STEEL_RECIPES: Record<CaseVariant, SteelRecipe> = {
  A: { seed: 0xc45e_57e1, blue: 0.34, size: 64, rim: 2.4, halo: 6, purple: 0.3, magenta: 0.35, speck: 0.6, violet: 0 },
  B: { seed: 0xb1e6_e3a0, blue: 0.66, size: 90, rim: 1.6, halo: 5, purple: 0.2, magenta: 0.25, speck: 0.5, violet: 0 },
  C: { seed: 0x60_1d5e, blue: 0.18, size: 44, rim: 1.6, halo: 6, purple: 0.25, magenta: 0.3, speck: 0.75, violet: 0 },
  D: { seed: 0xd9e9_71e5, blue: 0.38, size: 64, rim: 3.2, halo: 5.5, purple: 1, magenta: 0.8, speck: 0.6, violet: 0.6 },
};

/** The steel's colours in sRGB 0..255, the light key (the logo). Gold steel stays at hue 35 to 50 (never toward 60,
 *  where it turns khaki or green). */
const STEEL = {
  bronze: [158, 116, 52] as Rgb, // hue 36
  brass: [192, 148, 66] as Rgb, // hue 39
  straw: [220, 182, 100] as Rgb, // hue 41
  scorch: [112, 70, 40] as Rgb, // the dark brown just outside the rim, hue 25
  amber: [176, 108, 44] as Rgb, // the halo near the blue, hue 29
  goldHalo: [206, 152, 62] as Rgb, // the halo further out, hue 38
  hot: [240, 226, 182] as Rgb,
  blueDeep: [84, 104, 186] as Rgb,
  periwinkle: [112, 150, 222] as Rgb,
  sky: [164, 200, 238] as Rgb,
  navy: [38, 42, 100] as Rgb,
  purple: [78, 44, 112] as Rgb,
  magenta: [148, 46, 108] as Rgb,
  violet: [150, 122, 222] as Rgb,
};

/** The deep key (the button, white text on every pixel): the same metal in deeper colours. A darkened gold turns
 *  olive, so the deep gold leans to amber (hue 30 to 35) and the blue to royal blue; the brightest are softly capped. */
const STEEL_DEEP: typeof STEEL = {
  bronze: [104, 68, 28], // hue 32
  brass: [134, 88, 32], // hue 33
  straw: [152, 106, 40], // hue 35
  scorch: [64, 34, 22],
  amber: [146, 74, 26], // hue 24
  goldHalo: [174, 120, 40], // hue 36
  hot: [186, 150, 84],
  blueDeep: [40, 58, 150],
  periwinkle: [52, 84, 184],
  sky: [92, 132, 216],
  navy: [20, 22, 64],
  purple: [52, 24, 84],
  magenta: [110, 26, 80],
  violet: [96, 62, 180],
};

const steelFields = new Map<CaseVariant, ReturnType<typeof buildSteelField>>();

function steelField(variant: CaseVariant): ReturnType<typeof buildSteelField> {
  let f = steelFields.get(variant);
  if (!f) {
    f = buildSteelField(STEEL_RECIPES[variant]);
    steelFields.set(variant, f);
  }
  return f;
}

function buildSteelField(rec: SteelRecipe) {
  const rand = mulberry32(rec.seed);
  const warpA = makeFbm(rand, 4, 0.5);
  const warpB = makeFbm(rand, 4, 0.5);
  const island = makeFbm(rand, 6, 0.64); // high gain: broken, fractal edges
  const fineF = makeFbm(rand, 3, 0.6); // the finest raggedness
  const broad = makeFbm(rand, 2, 0.45); // where the islands sit: separate blobs of mixed sizes
  const cloud = makeFbm(rand, 4, 0.55); // lighter clouds inside the blue
  const mottle = makeFbm(rand, 4, 0.6); // the gold's lighter and darker patches
  const halo = makeFbm(rand, 3, 0.5); // how far the halo bleeds, and its hue
  const speckN = makeNoise(Math.floor(rand() * 4294967296));
  const grainN = makeNoise(Math.floor(rand() * 4294967296));
  const pickN = makeNoise(Math.floor(rand() * 4294967296));
  const pixSeed = Math.floor(rand() * 4294967296) >>> 0;
  const pixHash = (x: number, y: number): number => {
    let h = Math.imul(x, 0x27d4eb2d) ^ Math.imul(y, 0x165667b1) ^ pixSeed;
    h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
    return ((h ^ (h >>> 13)) >>> 0) / 4294967296;
  };
  // a slight directional flow: the field is stretched along a shallow slant
  const flow = -0.32 + rand() * 0.2;
  const fc = Math.cos(flow);
  const fs = Math.sin(flow);
  const k = 1 / rec.size;
  // where the islands sit: one blob per cell of a jittered grid (some cells empty), of mixed sizes, so the blue
  // forms separate islands rather than one connected sea
  const cellSeed = Math.floor(rand() * 4294967296) >>> 0;
  const cellHash = (i: number, j: number, n: number): number => {
    let h = Math.imul(i, 0x27d4eb2d) ^ Math.imul(j, 0x165667b1) ^ Math.imul(n, 0x1b873593) ^ cellSeed;
    h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
    h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  };
  const CELL = 1.8;
  const blobs = (u: number, v: number): number => {
    const ci = Math.floor(u / CELL);
    const cj = Math.floor(v / CELL);
    let sum = 0;
    for (let j = cj - 1; j <= cj + 1; j++) {
      for (let i = ci - 1; i <= ci + 1; i++) {
        if (cellHash(i, j, 0) > 0.8) continue;
        const bx = (i + 0.15 + 0.7 * cellHash(i, j, 1)) * CELL;
        const by = (j + 0.15 + 0.7 * cellHash(i, j, 2)) * CELL;
        const r = CELL * (0.22 + 0.5 * cellHash(i, j, 3) ** 1.5);
        const d2 = ((u - bx) ** 2 + (v - by) ** 2) / (r * r);
        if (d2 < 1) sum += (1 - d2) * (1 - d2);
      }
    }
    return Math.min(1.2, sum);
  };
  /** island value at a field point in CSS px (higher is bluer) */
  const islandAt = (cx: number, cy: number): number => {
    const u = (cx * fc + cy * fs) * k * 0.86;
    const v = (-cx * fs + cy * fc) * k * 1.12;
    const qx = warpA(u, v) - 0.5;
    const qy = warpB(u + 7.3, v + 2.1) - 0.5;
    const fr = island(u * 1.6 + 1.4 * qx, v * 1.6 + 1.4 * qy);
    const fine = fineF(u * 5.3 + 3.1, v * 5.3 + 1.7);
    return (
      blobs(u + 2.2 * qx, v + 2.2 * qy) + 3.2 * (fr - 0.5) + 1.8 * (fine - 0.5) + 0.12 * (broad(u * 0.5, v * 0.5) - 0.5)
    );
  };
  // a coarse pass over the whole bar sets the island threshold, so the blue share is an exact area
  const CS = 6;
  const cols = Math.floor(642 / CS) + 1;
  const rows = Math.floor(402 / CS) + 1;
  const coarse = new Float32Array(cols * rows);
  for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) coarse[j * cols + i] = islandAt(i * CS, j * CS);
  const sorted = Array.from(coarse).sort((a, b) => a - b);
  const T = sorted[Math.floor(sorted.length * (1 - rec.blue))];
  /** the blue share of a cut, from the coarse pass */
  const shareOf = (x: number, y: number, w: number, h: number): number => {
    let n = 0;
    let b = 0;
    for (let j = Math.ceil(y / CS); j * CS <= y + h && j < rows; j++) {
      for (let i = Math.ceil(x / CS); i * CS <= x + w && i < cols; i++) {
        n++;
        if (coarse[j * cols + i] > T) b++;
      }
    }
    return n ? b / n : 0;
  };
  return { islandAt, T, shareOf, cloud, mottle, halo, speckN, grainN, pickN, pixHash, flow, k };
}

/** Separable box blur, run twice (close to a gaussian), radius in pixels. */
function blur2(src: Float32Array, w: number, h: number, r: number): Float32Array {
  const rad = Math.max(1, Math.round(r));
  let a = src;
  const tmp = new Float32Array(w * h);
  for (let pass = 0; pass < 2; pass++) {
    const out = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      let sum = 0;
      const row = y * w;
      for (let x = -rad; x <= rad; x++) sum += a[row + Math.max(0, Math.min(w - 1, x))];
      for (let x = 0; x < w; x++) {
        tmp[row + x] = sum / (2 * rad + 1);
        sum += a[row + Math.min(w - 1, x + rad + 1)] - a[row + Math.max(0, x - rad)];
      }
    }
    for (let x = 0; x < w; x++) {
      let sum = 0;
      for (let y = -rad; y <= rad; y++) sum += tmp[Math.max(0, Math.min(h - 1, y)) * w + x];
      for (let y = 0; y < h; y++) {
        out[y * w + x] = sum / (2 * rad + 1);
        sum += tmp[Math.min(h - 1, y + rad + 1) * w + x] - tmp[Math.max(0, y - rad) * w + x];
      }
    }
    a = out;
  }
  return a;
}

/** Draws one region of the steel field at `scale` device pixels per field px; `dpr` device px per displayed CSS px. */
function drawSteelRegion(variant: CaseVariant, region: CaseRegion, scale: number, dpr: number): CaseTexture {
  const rec = STEEL_RECIPES[variant];
  const F = steelField(variant);
  const W = Math.round(region.w * scale);
  const H = Math.round(region.h * scale);
  const N = W * H;
  const lin = (c: Rgb): Rgb => c.map(toLin) as Rgb;
  const C = Object.fromEntries(Object.entries(region.ramp === 'fill' ? STEEL_DEEP : STEEL).map(([n, c]) => [n, lin(c)])) as Record<keyof typeof STEEL, Rgb>;
  // every smooth field on a grid of one sample per field px, bilinear between (the finest of them repeats every 7 px
  // or more, so this loses nothing and saves most of the work): island value, two speck fields, gold mottling, halo
  // reach, the halo's brown, hot spots, blue clouds and the rim's hue
  const gw = Math.ceil(region.w) + 2;
  const gh = Math.ceil(region.h) + 2;
  const LAYERS = 9;
  const grid = new Float32Array(gw * gh * LAYERS);
  const speckK = F.k * 9; // specks about a ninth of an island across
  const ca = Math.cos(F.flow);
  const sa = Math.sin(F.flow);
  for (let j = 0; j < gh; j++) {
    for (let i = 0; i < gw; i++) {
      const cx = region.x + i;
      const cy = region.y + j;
      const u = (cx * ca + cy * sa) * F.k;
      const v = (-cx * sa + cy * ca) * F.k;
      const o = (j * gw + i) * LAYERS;
      grid[o] = F.islandAt(cx, cy);
      grid[o + 1] = F.speckN(cx * speckK, cy * speckK * 1.3);
      grid[o + 2] = F.speckN(cx * speckK * 0.8 + 41.3, cy * speckK + 7.9);
      grid[o + 3] = F.mottle(u * 2.2, v * 2.2);
      grid[o + 4] = F.halo(u * 4.2, v * 4.2);
      grid[o + 5] = F.pickN(u * 8 + 5, v * 8);
      grid[o + 6] = F.pickN(u * 1.7 + 31, v * 1.7);
      grid[o + 7] = F.cloud(u * 3.4, v * 3.4);
      grid[o + 8] = F.pickN(u * 9 + 11, v * 9);
    }
  }
  const at = new Float32Array(LAYERS);
  /** fills `at` with layers [from, to) at a field position (in field px from the region's corner) */
  const sample = (fx: number, fy: number, from: number, to: number): void => {
    const i = Math.min(gw - 2, Math.floor(fx));
    const j = Math.min(gh - 2, Math.floor(fy));
    const ax = fx - i;
    const ay = fy - j;
    const w00 = (1 - ax) * (1 - ay);
    const w10 = ax * (1 - ay);
    const w01 = (1 - ax) * ay;
    const w11 = ax * ay;
    const o = (j * gw + i) * LAYERS;
    const o2 = o + gw * LAYERS;
    for (let l = from; l < to; l++) {
      at[l] = grid[o + l] * w00 + grid[o + LAYERS + l] * w10 + grid[o2 + l] * w01 + grid[o2 + LAYERS + l] * w11;
    }
  };
  // pass 1: the blue mask (islands plus specks) and the island value, per device pixel
  const mask = new Float32Array(N);
  const isl = new Float32Array(N);
  const aa = 0.012; // a soft, anti-aliased step at the threshold
  for (let py = 0; py < H; py++) {
    for (let px = 0; px < W; px++) {
      sample(px / scale, py / scale, 0, 3);
      const v = at[0];
      isl[py * W + px] = v;
      let m = smooth(F.T - aa, F.T + aa, v);
      // small fragments and specks near the islands (each gets its own rim and halo below)
      if (m < 1 && v > F.T - 0.1) {
        const sp = at[1];
        const th = 0.9 - rec.speck * 0.14 + (F.T - v) * 1.4;
        m = Math.max(m, smooth(th, th + 0.03, sp));
      }
      // pits: small holes of gold inside the blue, most near the edges (each gets a dark rim of its own below)
      if (m > 0) {
        const pn = at[2];
        const th = 0.74 + (v - F.T) * 1.6 - rec.speck * 0.08;
        m *= 1 - smooth(th, th + 0.04, pn);
      }
      mask[py * W + px] = m;
    }
  }
  const px1 = dpr; // device px per displayed CSS px
  const near = blur2(mask, W, H, rec.rim * px1 * 0.8);
  const far = blur2(mask, W, H, rec.halo * px1);
  const out = new Uint8ClampedArray(N * 4);
  const fill = region.ramp === 'fill';
  const mix = (a: Rgb, b: Rgb, t: number): Rgb => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  for (let py = 0; py < H; py++) {
    const cy = region.y + py / scale;
    for (let px = 0; px < W; px++) {
      const cx = region.x + px / scale;
      const i = py * W + px;
      const m = mask[i];
      sample(px / scale, py / scale, 3, LAYERS);
      // gold steel: bronze to brass to straw in soft mottled patches
      const mt = at[3];
      let col = mt < 0.5 ? mix(C.bronze, C.brass, smooth(0.2, 0.5, mt)) : mix(C.brass, C.straw, smooth(0.5, 0.82, mt));
      // the orange-gold halo bleeding out from the blue, uneven in reach and hue
      const hn = at[4];
      // patchy: in places the halo bleeds far, in others the blue meets the gold almost bare
      const reach = Math.min(1, far[i] * (0.8 + smooth(0.25, 0.7, hn) * 4));
      const h = (1 - m) * smooth(0.05, 0.5, reach);
      if (h > 0) {
        // brown and amber close to the blue, orange-gold further out
        const close = smooth(0.1, 0.55, near[i]) * (0.7 + 0.9 * at[5]);
        let hc = mix(C.goldHalo, C.amber, smooth(0.45, 0.85, reach));
        hc = mix(hc, C.scorch, Math.min(1, close));
        col = mix(col, hc, h * 0.82);
        // here and there a pale hot spot at an edge
        const hot = smooth(0.8, 0.9, at[6]) * smooth(0.4, 0.75, reach) * (1 - m);
        if (hot > 0) col = mix(col, C.hot, hot * 0.85);
      }
      if (m > 0) {
        // blue: lighter clouds inside, deeper toward the edge
        const cl = at[7];
        let bl = mix(C.periwinkle, C.sky, smooth(0.42, 0.72, cl));
        const depth = smooth(0.0, 0.035, isl[i] - F.T);
        bl = mix(C.blueDeep, bl, 0.35 + 0.65 * depth);
        if (rec.violet > 0) bl = mix(bl, C.violet, rec.violet * (0.55 + 0.45 * (1 - smooth(0.42, 0.72, cl))));
        // the thin dark rim right at the blue: navy to purple, magenta in flecks
        const edge = smooth(0.985, 0.7, near[i]);
        if (edge > 0) {
          const pk = at[8];
          let rc = mix(C.navy, C.purple, Math.min(1, rec.purple + (pk - 0.5) * 0.6));
          rc = mix(rc, C.magenta, smooth(0.86 - rec.magenta * 0.16, 0.92 - rec.magenta * 0.16, pk) * 0.85);
          bl = mix(bl, rc, edge);
        }
        col = mix(col, bl, m);
      }
      // fine grain along the flow, and a little per-pixel tooth (matte, no specular)
      const gu = cx * ca + cy * sa;
      const gv = -cx * sa + cy * ca;
      const grain =
        (F.grainN(gu * 0.25, gv * 2.2) - 0.5) * 0.18 +
        (F.grainN(gu * 1.1 + 17, gv * 1.1) - 0.5) * 0.14 +
        (F.pixHash(px, py) - 0.5) * 0.1;
      const lt = 1 + grain;
      let r = col[0] * lt;
      let g = col[1] * lt;
      let b = col[2] * lt;
      const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      if (fill) {
        // a soft knee, so the brightest patches still differ but never pass the cap
        const key = lum;
        const knee = 0.12;
        const t = key <= knee ? key : knee + (FILL_MAX_LUM - knee) * (1 - Math.exp(-(key - knee) / (FILL_MAX_LUM - knee)));
        const f = t / Math.max(lum, 1e-5);
        r *= f;
        g *= f;
        b *= f;
      } else if (region.ramp === 'logo' && lum < LOGO_MIN_LUM) {
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
      const o = i * 4;
      out[o] = SRGB[Math.max(0, Math.min(LUT - 1, Math.round(r * (LUT - 1))))];
      out[o + 1] = SRGB[Math.max(0, Math.min(LUT - 1, Math.round(g * (LUT - 1))))];
      out[o + 2] = SRGB[Math.max(0, Math.min(LUT - 1, Math.round(b * (LUT - 1))))];
      out[o + 3] = 255;
    }
  }
  return { width: W, height: H, data: out };
}

// ---- both styles ----

/** The cuts per style: far apart in the field, so the logo and the button show different metal. The swirl's logo cut
 *  is shown at 0.6, so its thin pixel strokes cross several patches (at full size each letter would be one colour);
 *  the steel's is shown a little larger, so the patches inside the letters are calmer than on the button. */
export const CASE_CUTS: Record<CaseStyle, { logo: CaseRegion; fill: CaseRegion }> = {
  swirl: {
    logo: { x: 30, y: 24, w: 600, h: 130, ramp: 'logo', zoom: 0.6 },
    fill: { x: 120, y: 262, w: 480, h: 72, ramp: 'fill' },
  },
  steel: {
    logo: { x: 40, y: 30, w: 300, h: 60, ramp: 'logo', zoom: 1.2 },
    fill: { x: 140, y: 250, w: 480, h: 72, ramp: 'fill' },
  },
};

/**
 * The cuts for one style and balance. The steel's are moved (logo in the top half of the bar, button in the bottom)
 * to where the blue share is closest to the balance's own, across the whole cut and in each third of it, so a small
 * cut never lands on plain gold or plain blue.
 */
export function caseCuts(style: CaseStyle, variant: CaseVariant): { logo: CaseRegion; fill: CaseRegion } {
  const base = CASE_CUTS[style];
  if (style === 'swirl') return base;
  const F = steelField(variant);
  const target = STEEL_RECIPES[variant].blue;
  const place = (r: CaseRegion, y0: number, y1: number): CaseRegion => {
    let best = r;
    let bestErr = Infinity;
    for (let y = y0; y + r.h <= y1; y += 12) {
      for (let x = 0; x + r.w <= 642; x += 24) {
        // the whole cut near the target share, and each third of it too (so no letter run is all one colour)
        const t3 = r.w / 3;
        let err = Math.abs(F.shareOf(x, y, r.w, r.h) - target);
        for (let k = 0; k < 3; k++) err += Math.abs(F.shareOf(x + k * t3, y, t3, r.h) - target) / 3;
        if (err < bestErr - 1e-9) {
          bestErr = err;
          best = { ...r, x, y };
        }
      }
    }
    return best;
  };
  return { logo: place(base.logo, 0, 200), fill: place(base.fill, 200, 402) };
}

/**
 * Draws one region of a style's field at `dpr` device pixels per displayed CSS px (the region's zoom is applied on
 * top). Pure (no DOM), so tests and the scratch screenshot scripts can call it directly.
 */
export function drawCaseRegion(style: CaseStyle, variant: CaseVariant, region: CaseRegion, dpr = 2): CaseTexture {
  const scale = dpr * (region.zoom ?? 1);
  return style === 'swirl' ? drawSwirlRegion(variant, region, scale) : drawSteelRegion(variant, region, scale, dpr);
}

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

let applied: string | null = null;

/**
 * Draws the finish once and hands it to the CSS as custom properties on the root, plus the `case-ready` class that
 * switches the title card from its flat fallback to the textures. Safe to call more than once.
 */
export function applyCaseHardened(
  target?: HTMLElement,
  style: CaseStyle = CASE_STYLE,
  variant: CaseVariant = CASE_VARIANT,
): boolean {
  const key = `${style}-${variant}`;
  if (applied === key) return true;
  if (!canDraw()) return false;
  const root = target ?? document.documentElement;
  // two device pixels per CSS px on dense screens (the grain stays crisp), one elsewhere (a quarter of the work)
  const dpr = (typeof devicePixelRatio === 'number' ? devicePixelRatio : 1) > 1.25 ? 2 : 1;
  const { logo: lc, fill: fc } = caseCuts(style, variant);
  const logo = toDataUrl(drawCaseRegion(style, variant, lc, dpr));
  const fill = toDataUrl(drawCaseRegion(style, variant, fc, dpr));
  if (!logo || !fill) return false;
  const size = (r: CaseRegion): string => `${r.w * (r.zoom ?? 1)}px ${r.h * (r.zoom ?? 1)}px`;
  root.style.setProperty('--case-logo', `url("${logo}")`);
  root.style.setProperty('--case-logo-size', size(lc));
  root.style.setProperty('--case-fill', `url("${fill}")`);
  root.style.setProperty('--case-fill-size', size(fc));
  root.dataset.caseStyle = style;
  root.classList.add('case-ready');
  applied = key;
  return true;
}
