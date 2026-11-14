// Ground data for the pixel map styles (render/mapStyle.ts: pixel, muted, ground), built once per game on the client:
// a made-up height field from the terrain (mountains high and rugged, hills rolling, plains and swamp low, rising a
// little away from the coast) and its hill shading, lit from the top left like the unit art. The shader samples it at
// the centre of each art pixel, so the shading steps with the pixels instead of blurring.
//
// RGBA8 per tile: R shade (128 = flat, brighter facing the top left), G height (0..255), B a slow variety value (grass
// hue, field patches), A ruggedness (how broken the ground is: mountains, then hills). Pure and deterministic (a fixed
// hash, no Math.random), read-only: nothing here touches the sim.
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
  mixc(GROUND.rock[2], GROUND.rock[1], 0.3),
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
  for (let x = 0; x < w; x++) {
    let acc = 0;
    for (let k = -r; k <= r; k++) acc += src[Math.min(h - 1, Math.max(0, k)) * w + x];
    for (let y = 0; y < h; y++) {
      tmp[y] = acc / n;
      acc += src[Math.min(h - 1, y + r + 1) * w + x] - src[Math.max(0, y - r) * w + x];
    }
    for (let y = 0; y < h; y++) src[y * w + x] = tmp[y];
  }
}

export interface GroundData {
  /** RGBA8 per tile: shade, height, variety, ruggedness (see the top of this file) */
  data: Uint8Array;
  /** RGBA8 per tile: the pixel ground's average colour, hill shaded (far view, mipmapped) */
  far: Uint8Array;
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
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const r = rough[i];
      // ridged noise for rugged ground (sharp crests), plain rolling noise for the rest
      const n1 = vnoise(x, y, 11, 3);
      const n2 = vnoise(x, y, 5, 7);
      const n3 = vnoise(x, y, 2.5, 11);
      const ridge = 1 - Math.abs(n1 * 2 - 1);
      const roll = n2 * 0.6 + n3 * 0.4;
      const k = Math.min(1, r / 0.3);
      height[i] = base[i] + r * ((ridge * 0.7 + n3 * 0.3) * k + roll * (1 - k));
    }
  }
  const out = new Uint8Array(n * 4);
  const far = new Uint8Array(n * 4);
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
      out[o + 2] = Math.round((vnoise(x, y, 23, 17) * 0.65 + vnoise(x, y, 7, 19) * 0.35) * 255);
      out[o + 3] = Math.round(Math.min(1, rough[i] / 0.42) * 255);
      const t = terrain[i];
      let c: RGB;
      if (t <= 1) c = farSea(depth[i]);
      else {
        c = FAR_LAND[t] ?? FAR_LAND[2];
        // snow on the high peaks, light and shade from the hill shading
        if (t === 5 && height[i] > 0.85) c = mixc(c, GROUND.snow[2], Math.min(0.5, (height[i] - 0.85) * 4));
        const k = 1 + s * 0.22;
        c = [c[0] * k, c[1] * k, c[2] * k];
      }
      far[o] = Math.max(0, Math.min(255, Math.round(c[0])));
      far[o + 1] = Math.max(0, Math.min(255, Math.round(c[1])));
      far[o + 2] = Math.max(0, Math.min(255, Math.round(c[2])));
      far[o + 3] = 255;
    }
  }
  return { data: out, far };
}
