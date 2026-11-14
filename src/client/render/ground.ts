// Ground data for the pixel map styles (render/mapStyle.ts: pixel, muted, ground), built once per game on the client:
// a made-up height field from the terrain (mountains high and rugged, hills rolling, plains and swamp low, rising a
// little away from the coast) and its hill shading, lit from the top left like the unit art. The shader samples it at
// the centre of each art pixel, so the shading steps with the pixels instead of blurring.
//
// RGBA8 per tile: R shade (128 = flat, brighter facing the top left), G height (0..255), B a slow variety value (grass
// hue, field patches), A ruggedness (how broken the ground is: mountains, then hills). Pure and deterministic (a fixed
// hash, no Math.random), read-only: nothing here touches the sim.
//
// For natural ground (real ground's pixel ground) three more RGBA8 textures, sampled linearly by the shader:
//   mixA  the share of each terrain on a tile, 255 or 0 (forest, desert, mountains, hills): sampled between tiles they
//         give smooth fields, so a terrain's edge follows a rounded line instead of the tile staircase (a lone tile
//         keeps its place: the field is full at its centre)
//   mixB  the same for swamp, tundra and plains, and A the moisture: a slow made-up field (wetter in the north, drier
//         in the south, broad patches), for drier or lusher grass and darker woods
//   mixC  forest, desert, mountains and hills blurred over a few tiles: how near each is, for the soft edges (lone
//         trees out from a forest, scree at a mountain's foot, grass at a desert's edge); half size (it is soft anyway)
// The terrain itself (what a tile is, what it does in the game) never changes; only how its edges and insides look.
import type { MapData } from '../../sim/types';
import type { RGB } from './common';

/** A 4-tone ramp (deep, dark, base, light), the unit art's way of shading (art/detailed/palette.ts). */
export type GroundRamp = readonly [RGB, RGB, RGB, RGB];
const hx = (h: string): RGB => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const ramp = (a: string, b: string, c: string, d: string): GroundRamp => [hx(a), hx(b), hx(c), hx(d)];

/**
 * The ground's colours: muted military tones that sit with the unit art (olive, tan, field grey), each terrain a ramp
 * lit from the top left. Values stay near today's terrain colours so units keep their contrast against the ground.
 */
export const GROUND = {
  grass: ramp('#56633f', '#6f7d52', '#8a9967', '#a2b07b'),
  /** drier grass (the south, dry patches) and lusher grass (the north, wet patches) */
  grassDry: ramp('#5e5f3c', '#78794e', '#939465', '#aaab7c'),
  grassLush: ramp('#45573a', '#5a6f47', '#718a59', '#8aa26c'),
  forest: ramp('#1a2517', '#2b3b24', '#3f5534', '#5a7446'),
  hills: ramp('#5b5a3f', '#787350', '#968f67', '#b1a982'),
  rock: ramp('#3f4043', '#5c5d5e', '#7e7e7b', '#a3a29c'),
  snow: ramp('#8f9aa3', '#b4bec5', '#d3dadf', '#eef2f4'),
  sand: ramp('#8e7a54', '#ab9568', '#c5ae7f', '#dcc89a'),
  swamp: ramp('#2c3426', '#414b33', '#57603f', '#6e774f'),
  tundra: ramp('#6f7a70', '#8a958a', '#a2ab9f', '#b9c1b5'),
  wheat: ramp('#6f6b47', '#8a845a', '#a39d68', '#b7b07c'),
  crop: ramp('#4f5d38', '#647346', '#7b8b56', '#90a068'),
  soil: ramp('#5e5139', '#75654a', '#8b7a5c', '#a08f70'),
  pool: ramp('#1f3134', '#2a4043', '#385356', '#577276'),
  /** sea bands from the shore out: shallows, shelf, middle, deep, open sea (slate, as today) */
  sea: [hx('#2f5867'), hx('#284b5b'), hx('#213d4e'), hx('#1b3142'), hx('#172836')] as readonly RGB[],
  /** wave marks and shore foam */
  foam: ramp('#3b6273', '#5d8290', '#93aeb5', '#c4d4d7'),
} as const;

const mixc = (a: RGB, b: RGB, k: number): RGB => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];

/** Average colour of each land terrain's pixel ground (index = TerrainId), for the far view. */
const FAR_LAND: readonly RGB[] = [
  GROUND.sea[4],
  GROUND.sea[1],
  mixc(GROUND.grass[2], GROUND.wheat[2], 0.12),
  mixc(GROUND.forest[2], GROUND.forest[1], 0.3),
  mixc(GROUND.hills[2], GROUND.hills[1], 0.3),
  mixc(mixc(GROUND.rock[2], GROUND.rock[1], 0.5), GROUND.hills[1], 0.18),
  mixc(GROUND.sand[2], GROUND.sand[3], 0.15),
  mixc(GROUND.swamp[2], GROUND.pool[1], 0.3),
  mixc(GROUND.tundra[2], GROUND.snow[2], 0.15),
];

/** Sea band of a water depth (tiles to land, smooth): 0 shallows .. 4 open sea, with the fraction to the next. */
export const SEA_BANDS = [1.6, 4, 8.5, 14] as const;

/** Flat colour of the sea at depth d (tiles to land), the bands blended (far view). */
function farSea(d: number): RGB {
  let k = 0;
  while (k < SEA_BANDS.length && d >= SEA_BANDS[k]) k++;
  return GROUND.sea[k];
}

/** Base height of each terrain (index = TerrainId), 0..1. */
const BASE = [0, 0, 0.14, 0.2, 0.42, 0.78, 0.18, 0.05, 0.24];
/** Noise strength of each terrain: how much its own ground rolls. */
const ROUGH = [0, 0, 0.05, 0.07, 0.2, 0.42, 0.06, 0.02, 0.08];
/** Hill shading gain (height difference between neighbours to shade). */
const SHADE_GAIN = 2.6;

function hash2(x: number, y: number, salt: number): number {
  let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(salt, 2246822519);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** Smooth value noise in 0..1 with period `cell` tiles. */
function vnoise(x: number, y: number, cell: number, salt: number): number {
  const fx = x / cell;
  const fy = y / cell;
  const ix = Math.floor(fx);
  const iy = Math.floor(fy);
  let tx = fx - ix;
  let ty = fy - iy;
  tx = tx * tx * (3 - 2 * tx);
  ty = ty * ty * (3 - 2 * ty);
  const a = hash2(ix, iy, salt);
  const b = hash2(ix + 1, iy, salt);
  const c = hash2(ix, iy + 1, salt);
  const d = hash2(ix + 1, iy + 1, salt);
  return a + (b - a) * tx + (c - a) * ty + (a - b - c + d) * tx * ty;
}

/** Separable box blur of radius r, in place (edges clamp). */
function blur(src: Float32Array, w: number, h: number, r: number): void {
  const tmp = new Float32Array(Math.max(w, h));
  const n = 2 * r + 1;
  for (let y = 0; y < h; y++) {
    const o = y * w;
    let acc = 0;
    for (let k = -r; k <= r; k++) acc += src[o + Math.min(w - 1, Math.max(0, k))];
    for (let x = 0; x < w; x++) {
      tmp[x] = acc / n;
      acc += src[o + Math.min(w - 1, x + r + 1)] - src[o + Math.max(0, x - r)];
    }
    for (let x = 0; x < w; x++) src[o + x] = tmp[x];
  }
  // down the columns: a running sum per column, moved one row at a time (rows are read whole, so this stays fast on
  // big maps instead of striding down one column after another)
  const acc = new Float64Array(w);
  const out = new Float32Array(w * h);
  for (let k = -r; k <= r; k++) {
    const o = Math.min(h - 1, Math.max(0, k)) * w;
    for (let x = 0; x < w; x++) acc[x] += src[o + x];
  }
  for (let y = 0; y < h; y++) {
    const o = y * w;
    for (let x = 0; x < w; x++) out[o + x] = acc[x] / n;
    const add = Math.min(h - 1, y + r + 1) * w;
    const sub = Math.max(0, y - r) * w;
    for (let x = 0; x < w; x++) acc[x] += src[add + x] - src[sub + x];
  }
  src.set(out);
}

export interface GroundData {
  /** RGBA8 per tile: shade, height, variety, ruggedness (see the top of this file) */
  data: Uint8Array;
  /** RGBA8 per tile: terrain shares and moisture, and the blurred shares (see the top of this file) */
  mixA: Uint8Array;
  mixB: Uint8Array;
  /** at half size: mixCW x mixCH cells of 2 x 2 tiles */
  mixC: Uint8Array;
  mixCW: number;
  mixCH: number;
  /** RGBA8 per tile: the pixel ground's average colour, hill shaded (far view, mipmapped) */
  far: Uint8Array;
}

const built = new WeakMap<MapData, GroundData>();
/** The ground textures of a map, built once and shared (map layer, minimap, 2D fallback). */
export function groundFor(map: MapData, depth: Uint8Array): GroundData {
  let g = built.get(map);
  if (!g) {
    g = buildGround(map, depth);
    built.set(map, g);
  }
  return g;
}

/** The ground textures. `depth`: water distance to land (terrain.ts). */
export function buildGround(map: MapData, depth: Uint8Array): GroundData {
  const { width: w, height: h, terrain } = map;
  const n = w * h;
  const base = new Float32Array(n);
  const rough = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = terrain[i];
    base[i] = t <= 1 ? -0.04 * Math.min(6, depth[i]) : BASE[t] ?? 0.14;
    rough[i] = ROUGH[t] ?? 0.05;
  }
  // the land's broad shape: terrain heights blurred over a few tiles, so ranges rise out of the plains
  blur(base, w, h, 2);
  blur(base, w, h, 2);
  blur(rough, w, h, 1);
  const height = new Float32Array(n);
  // snow on a mountain tile (0..1): snowfields on the high cores of a range, in patches, on high ground
  const snowy = new Float32Array(n);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const r = rough[i];
      // ridged noise for rugged ground (sharp crests), plain rolling noise for the rest; mountains get two crossing
      // ridge scales (about 7 and 3.5 tiles), so a range reads as many ridges, not a few smooth lumps
      const n1 = vnoise(x, y, 11, 3);
      const n2 = vnoise(x, y, 5, 7);
      const n3 = vnoise(x, y, 2.5, 11);
      let ridge = 1 - Math.abs(n1 * 2 - 1);
      if (terrain[i] === 5) {
        ridge = (1 - Math.abs(vnoise(x, y, 7, 13) * 2 - 1)) * 0.6 + (1 - Math.abs(vnoise(x, y, 3.5, 17) * 2 - 1)) * 0.4;
        const deep = Math.min(1, Math.max(0, (base[i] - 0.45) / 0.3));
        const field = deep * 0.6 + vnoise(x, y, 9, 23) * 0.55 - 0.95;
        snowy[i] = Math.max(0, Math.min(1, field * 4)) * Math.min(1, Math.max(0, (ridge - 0.3) * 2.5));
      }
      const roll = n2 * 0.6 + n3 * 0.4;
      const k = Math.min(1, r / 0.3);
      height[i] = base[i] + r * ((ridge * 0.7 + n3 * 0.3) * k + roll * (1 - k));
    }
  }
  // terrain shares (mixA, mixB) and how near each terrain is (mixC: worked out on a half-size grid, 2 x 2 tiles a
  // cell, blurred over about four tiles; the GPU's linear filter smooths it back to tiles)
  const mixA = new Uint8Array(n * 4);
  const mixB = new Uint8Array(n * 4);
  const hw = Math.ceil(w / 2);
  const hh = Math.ceil(h / 2);
  const near: Float32Array[] = [0, 1, 2, 3].map(() => new Float32Array(hw * hh));
  const moist = moisture(w, h);
  for (let y = 0; y < h; y++) {
    const hrow = (y >> 1) * hw;
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const t = terrain[i];
      const o = i * 4;
      const a = SHARE_A_OF[t];
      if (a >= 0) mixA[o + a] = 255;
      const b = SHARE_B_OF[t];
      if (b >= 0) mixB[o + b] = 255;
      mixB[o + 3] = Math.round(moist[i] * 255);
      const c = NEAR_OF[t];
      if (c >= 0) near[c][hrow + (x >> 1)] += 0.25;
    }
  }
  const mixC = new Uint8Array(hw * hh * 4);
  for (let c = 0; c < 4; c++) {
    blur(near[c], hw, hh, 1);
    blur(near[c], hw, hh, 1);
    const f = near[c];
    for (let j = 0; j < hw * hh; j++) mixC[j * 4 + c] = Math.round(Math.min(1, f[j]) * 255);
  }
  // the far colour of the terrains nearby, per half-size cell: the sum of their colours x 0.45 x nearness (RGB) and of
  // their weights (A); a tile takes out its own terrain's part
  const nearMix = new Float32Array(hw * hh * 4);
  for (let j = 0; j < hw * hh; j++) {
    for (let k = 0; k < 4; k++) {
      const v = near[k][j] * 0.45;
      if (v <= 0.002) continue;
      const fl = FAR_LAND[NEAR_TERRAINS[k]];
      nearMix[j * 4] += fl[0] * v;
      nearMix[j * 4 + 1] += fl[1] * v;
      nearMix[j * 4 + 2] += fl[2] * v;
      nearMix[j * 4 + 3] += v;
    }
  }
  // the slow variety value (fields, grass hue): smooth, so worked out every 2 tiles and smoothed between
  const variety = smoothField(w, h, 2, (x, y) => vnoise(x, y, 23, 17) * 0.65 + vnoise(x, y, 7, 19) * 0.35);
  const out = new Uint8Array(n * 4);
  const far = new Uint8Array(n * 4);
  finishTiles({ w, h, hw, terrain, depth, height, rough, variety, moist, snowy, near, nearMix, out, far });
  return { data: out, far, mixA, mixB, mixC, mixCW: hw, mixCH: hh };
}

interface TileInputs {
  w: number;
  h: number;
  hw: number;
  terrain: Uint8Array;
  depth: Uint8Array;
  height: Float32Array;
  rough: Float32Array;
  variety: Float32Array;
  moist: Float32Array;
  snowy: Float32Array;
  near: Float32Array[];
  nearMix: Float32Array;
  out: Uint8Array;
  far: Uint8Array;
}

/** The per-tile pass: hill shading, the packed ground data and the far colours (its own function, so it stays fast). */
function finishTiles(p: TileInputs): void {
  const { w, h, hw, terrain, depth, height, rough, variety, moist, snowy, near, nearMix, out, far } = p;
  for (let y = 0; y < h; y++) {
    const ym = Math.max(0, y - 1) * w;
    const yp = Math.min(h - 1, y + 1) * w;
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const xm = Math.max(0, x - 1);
      const xp = Math.min(w - 1, x + 1);
      // light from the top left: a slope rising towards the bottom right faces the light
      const dx = height[y * w + xp] - height[y * w + xm];
      const dy = height[yp + x] - height[ym + x];
      const s = Math.max(-1, Math.min(1, (dx + dy) * SHADE_GAIN));
      const o = i * 4;
      out[o] = Math.round(128 + s * 127);
      out[o + 1] = Math.round(Math.max(0, Math.min(1, height[i])) * 255);
      out[o + 2] = Math.round(variety[i] * 255);
      out[o + 3] = Math.round(Math.min(1, rough[i] / 0.42) * 255);
      const t = terrain[i];
      let cr: number;
      let cg: number;
      let cb: number;
      if (t <= 1) {
        const sc = farSea(depth[i]);
        cr = sc[0];
        cg = sc[1];
        cb = sc[2];
      } else {
        farLandInto(t, moist[i], FL);
        cr = FL[0];
        cg = FL[1];
        cb = FL[2];
        // terrains nearby show a little in the far colour too (soft edges far out, like the pixel ground close in)
        const hj = (y >> 1) * hw + (x >> 1);
        let mr = nearMix[hj * 4];
        let mg = nearMix[hj * 4 + 1];
        let mbl = nearMix[hj * 4 + 2];
        let rest = 1 - nearMix[hj * 4 + 3];
        const own = NEAR_OF[t];
        if (own >= 0) {
          const v = near[own][hj] * 0.45;
          if (v > 0.002) {
            const fl = FAR_LAND[t];
            mr -= fl[0] * v;
            mg -= fl[1] * v;
            mbl -= fl[2] * v;
            rest += v;
          }
        }
        if (rest < 0.999) {
          rest = Math.max(0, rest);
          cr = mr + cr * rest;
          cg = mg + cg * rest;
          cb = mbl + cb * rest;
        }
        // mountains: grey rock, snowfields only on the high cores of a range and their sunlit side (far out a range
        // reads as rugged rock with some snow, not a pale lump)
        if (t === 5 && snowy[i] > 0 && s > -0.3) {
          const a = snowy[i] * 0.6;
          const sn = GROUND.snow[2];
          cr += (sn[0] - cr) * a;
          cg += (sn[1] - cg) * a;
          cb += (sn[2] - cb) * a;
        }
        const k = 1 + s * (t === 5 ? 0.3 : 0.22);
        cr *= k;
        cg *= k;
        cb *= k;
      }
      far[o] = Math.max(0, Math.min(255, Math.round(cr)));
      far[o + 1] = Math.max(0, Math.min(255, Math.round(cg)));
      far[o + 2] = Math.max(0, Math.min(255, Math.round(cb)));
      far[o + 3] = 255;
    }
  }
}

/** Terrains in mixA (R, G, B, A) and mixB (R, G, B; A is the moisture), by TerrainId. */
const SHARE_A = [3, 6, 5, 4];
const SHARE_B = [7, 8, 2];
/** Terrains whose nearness is in mixC (R, G, B, A): forest, desert, mountains, hills. */
const NEAR_TERRAINS = [3, 6, 5, 4];
/** The channel of each TerrainId in mixA, mixB and mixC (-1 = none). */
const channelOf = (list: readonly number[]): Int8Array => {
  const a = new Int8Array(256).fill(-1);
  list.forEach((t, k) => (a[t] = k));
  return a;
};
const SHARE_A_OF = channelOf(SHARE_A);
const SHARE_B_OF = channelOf(SHARE_B);
const NEAR_OF = channelOf(NEAR_TERRAINS);

/**
 * Moisture 0..1 per tile: broad wet and dry patches (about 50 and 18 tiles across) and a gentle slope from a wetter
 * north to a drier south. Worked out on a grid of 4 x 4 tile cells and smoothed between them (it changes slowly).
 */
function moisture(w: number, h: number): Float32Array {
  return smoothField(w, h, 4, (tx, ty) => {
    const v = 0.5 + (vnoise(tx, ty, 50, 31) - 0.5) * 1.1 + (vnoise(tx, ty, 18, 37) - 0.5) * 0.45 + (0.5 - ty / Math.max(1, h)) * 0.3;
    return Math.max(0, Math.min(1, v));
  });
}

/** A slow field per tile: f worked out on a grid of C x C tile cells and smoothed (bilinear) between them. */
function smoothField(w: number, h: number, C: number, f: (x: number, y: number) => number): Float32Array {
  const gw = Math.ceil(w / C) + 2;
  const gh = Math.ceil(h / C) + 2;
  const g = new Float32Array(gw * gh);
  for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) g[y * gw + x] = f(x * C, y * C);
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const fy = y / C;
    const y0 = Math.floor(fy);
    const ky = fy - y0;
    for (let x = 0; x < w; x++) {
      const fx = x / C;
      const x0 = Math.floor(fx);
      const kx = fx - x0;
      const a = g[y0 * gw + x0];
      const b = g[y0 * gw + x0 + 1];
      const c = g[(y0 + 1) * gw + x0];
      const d = g[(y0 + 1) * gw + x0 + 1];
      out[y * w + x] = a + (b - a) * kx + (c - a) * ky + (a - b - c + d) * kx * ky;
    }
  }
  return out;
}

const FL = [0, 0, 0];
const FAR_DRY = mixc(GROUND.grassDry[2], GROUND.wheat[2], 0.12);
/** Far colour of a land terrain at a moisture into out: plains drier or lusher, woods darker where it is wet. */
function farLandInto(t: number, m: number, out: number[]): void {
  const c = FAR_LAND[t] ?? FAR_LAND[2];
  let to: RGB = c;
  let k = 0;
  if (t === 2) {
    to = m < 0.5 ? FAR_DRY : GROUND.grassLush[2];
    k = Math.min(1, Math.abs(m - 0.5) * 3);
  } else if (t === 3) {
    to = GROUND.forest[1];
    k = Math.max(0, m - 0.5) * 0.8;
  }
  out[0] = c[0] + (to[0] - c[0]) * k;
  out[1] = c[1] + (to[1] - c[1]) * k;
  out[2] = c[2] + (to[2] - c[2]) * k;
}
