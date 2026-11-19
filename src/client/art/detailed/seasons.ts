// Seasons and day and night for the map (client only, looks only, pure): the maths the art lab's "Seasons" row draws
// with (artlab/seasonsMock.ts), kept free of the DOM so the game can later drive it from the tick. Everything is a pure
// function of the season (a continuous value: 0 spring, 1 summer, 2 autumn, 3 winter, 4 spring again) and the time of
// day (0..1 of a 2 minute day: 1.5 min of day, 30 s of night, with a gentle dawn and dusk), plus fixed hashes of where
// a pixel is. No Math.random, no Date.
//
// The ground keeps its pixel style: each art pixel of the map's ground (render/ground.ts ramps, the shader's 4-tone
// steps) is matched to its ramp and tone, and drawn in that ramp's seasonal version at the same tone, so hill shading,
// trees and fields keep their pixels and only the colours change. Snow spreads south from the poles behind a soft,
// moving edge, dithered on the art grid with the shader's 4 x 4 ordered dither; the polar sea freezes out from its
// coasts. Night darkens the ground and the art by 28% (never more than 30%) with a cool blue tint: the caller leaves
// borders, owner colours, names, numbers and the UI out of it. Lights are small warm pixels on the art grid.
import type { RGB } from '../shared/colour';
import { GROUND, type GroundRamp } from '../../render/ground';
import type { GroundPalette } from '../../render/mapThemes';
import { bayer4, shaderHash } from './buildingLinkArt';

// ------------------------------------------------------------------------------------------------- seasons and the day

export const SEASON_NAMES = ['Spring', 'Summer', 'Autumn', 'Winter'] as const;
/** The four seasons at their height. */
export const SEASON = { spring: 0, summer: 1, autumn: 2, winter: 3 } as const;
/** A full day and night, in seconds of game time, and the night's share of it. */
export const DAY_SECONDS = 120;
export const NIGHT_SHARE = 0.25;
/** Named moments of the day (0..1): dawn and dusk in the middle of their change, noon, the middle of the night. */
export const TIMES = { dawn: 0.028, noon: 0.375, dusk: 0.722, night: 0.875 } as const;
/** Brightness the ground and art lose at full night, and the most they ever lose. */
export const NIGHT_DARKEN = 0.28;
export const MAX_DARKEN = 0.3;

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
const smooth = (v: number): number => {
  const t = clamp01(v);
  return t * t * (3 - 2 * t);
};
const smoothstep = (a: number, b: number, v: number): number => smooth((v - a) / (b - a));
const luma = (c: readonly number[]): number => 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];

/** A season value folded into 0..4. */
export function wrapSeason(s: number): number {
  return ((s % 4) + 4) % 4;
}

/** The plain name of a season value: "Early winter", "Autumn", "Late spring". */
export function seasonName(s: number): string {
  const w = wrapSeason(s);
  const n = Math.round(w);
  const d = w - n;
  const base = SEASON_NAMES[n % 4];
  if (d < -0.15) return `Early ${base.toLowerCase()}`;
  if (d > 0.15) return `Late ${base.toLowerCase()}`;
  return base;
}

/** The time of day folded into 0..1. */
export function wrapDay(t: number): number {
  return ((t % 1) + 1) % 1;
}

/** The time of day at `seconds` of game time (a 2 minute day). */
export function dayTimeAt(seconds: number): number {
  return wrapDay(seconds / DAY_SECONDS);
}

/** Half the length of dawn and of dusk, as a share of the day (6 s either side of the change). */
const TWILIGHT = 0.05;
const DUSK = 1 - NIGHT_SHARE;

/** How dark it is at time of day t: 0 by day, 1 at full night, eased through dawn and dusk. */
export function darkness(t: number): number {
  const w = wrapDay(t);
  // dawn sits on the wrap: count the first moments of the day as the end of the night
  const u = w < TWILIGHT ? w + 1 : w;
  if (u < DUSK - TWILIGHT) return 0;
  if (u < DUSK + TWILIGHT) return smooth((u - (DUSK - TWILIGHT)) / (2 * TWILIGHT));
  if (u < 1 - TWILIGHT) return 1;
  return 1 - smooth((u - (1 - TWILIGHT)) / (2 * TWILIGHT));
}

/** How much of the warm dawn or dusk glow there is at time t (0..1, highest in the middle of the change). */
export function twilight(t: number): number {
  const w = wrapDay(t);
  const u = w < 0.5 ? w + 1 : w;
  const d = Math.min(Math.abs(u - DUSK), Math.abs(u - 1));
  return smooth(1 - d / (3.5 * TWILIGHT));
}

/** The words for a time of day. */
export function dayName(t: number): string {
  const d = darkness(t);
  if (twilight(t) > 0.35) return wrapDay(t) > 0.5 && wrapDay(t) < 0.9 ? 'Dusk' : 'Dawn';
  return d > 0.5 ? 'Night' : 'Day';
}

/** The light at a time of day: how dark, how warm, the brightness kept and the colour tint (its luma is 1). */
export interface DayLight {
  dark: number;
  warm: number;
  /** brightness kept, 0.72 at full night */
  k: number;
  /** per channel tint, normalised so it keeps brightness */
  tint: RGB;
  /** how much colour is let go at night (towards grey of the same brightness) */
  desat: number;
}

const WARM: RGB = [1.42, 0.92, 0.78];
const COOL: RGB = [0.89, 0.99, 1.18];
const normTint = (c: readonly number[]): RGB => {
  const y = luma(c);
  return [c[0] / y, c[1] / y, c[2] / y];
};

export function dayLight(t: number): DayLight {
  const dark = darkness(t);
  const warm = twilight(t);
  const a = warm * (1 - dark * 0.45);
  const raw: RGB = [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    const wv = 1 + (WARM[i] - 1) * a;
    raw[i] = wv + (COOL[i] - wv) * dark;
  }
  return { dark, warm, k: 1 - NIGHT_DARKEN * dark, tint: normTint(raw), desat: 0.18 * dark };
}

/**
 * A colour under the light of `l`: brightness kept by l.k (0.72 at full night, never under 0.7), tinted cool at night
 * and warm at dawn and dusk without changing its brightness, a little colour let go at night.
 */
export function shadeLight(c: readonly number[], l: DayLight): RGB {
  if (l.k >= 1 && l.warm <= 0) return [c[0], c[1], c[2]];
  const y = luma(c);
  const out: RGB = [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    const v = c[i] + (y - c[i]) * l.desat;
    const tv = l.k * (v + y * (l.tint[i] - 1));
    out[i] = Math.round(tv < 0 ? 0 : tv > 255 ? 255 : tv);
  }
  return out;
}

// ------------------------------------------------------------------------------------------------- night lights

/** Things on the map, for lights: only the lit kinds get any. */
export type LightKind = 'capital' | 'city' | 'port' | 'factory' | 'fort' | 'train' | 'ship' | 'fire' | 'blast' | 'plains' | 'farm' | 'forest' | 'hills' | 'mountains' | 'desert' | 'water' | 'empty';
export const LIT_KINDS: ReadonlySet<LightKind> = new Set<LightKind>(['capital', 'city', 'port', 'factory', 'fort', 'train', 'ship', 'fire', 'blast']);

/** Light colours: warm windows, amber street lamps, pale lamps, white lamps, red and green running lights, fire. */
export const LIGHT_TONES = {
  warm: [255, 214, 122],
  amber: [255, 178, 79],
  pale: [255, 236, 186],
  white: [246, 243, 228],
  red: [255, 78, 60],
  green: [96, 255, 128],
  fire: [255, 150, 56],
} as const satisfies Record<string, readonly [number, number, number]>;
export type LightTone = keyof typeof LIGHT_TONES;

/** One light on a building: where in its picture (0..1 across, 0..1 down), its colour, and how dark it must be to be on. */
export interface LightSpot {
  u: number;
  v: number;
  tone: LightTone;
  /** on once darkness passes this (lights come on one by one at dusk) */
  on: number;
  /** 2: a bigger lamp (two art pixels square) */
  size: 1 | 2;
}

/** How many lights a building of `kind` shows at night (a bigger city level, more lights; plain land none). */
export function lightCount(kind: LightKind, level = 1): number {
  const L = Math.max(1, Math.min(6, Math.round(level)));
  switch (kind) {
    case 'capital':
      return 14 + 8 * L;
    case 'city':
      return 6 + 6 * L;
    case 'port':
      return 4;
    case 'factory':
      return 3;
    case 'fort':
      return 2;
    default:
      return 0;
  }
}

/**
 * The candidate lights of a building, best first: three times its count, so the caller keeps the first ones that land
 * on the building's own pixels. Deterministic per seed. Empty for every kind that is not a lit building.
 */
export function lightSpots(kind: LightKind, level: number, seed: number): LightSpot[] {
  const n = lightCount(kind, level);
  if (!n) return [];
  const out: LightSpot[] = [];
  for (let i = 0; i < n * 3; i++) {
    const h1 = shaderHash(seed, i, 701);
    const h2 = shaderHash(seed, i, 703);
    const h3 = shaderHash(seed, i, 707);
    const tone: LightTone =
      kind === 'factory' ? (i === 0 ? 'red' : 'amber')
      : kind === 'port' ? (i === 0 ? 'white' : h3 < 0.5 ? 'pale' : 'amber')
      : kind === 'fort' ? 'amber'
      : h3 < 0.55 ? 'warm' : h3 < 0.85 ? 'amber' : 'pale';
    out.push({ u: 0.12 + 0.76 * h1, v: 0.3 + 0.62 * h2, tone, on: 0.18 + 0.42 * shaderHash(seed, i, 709), size: (kind === 'capital' || kind === 'city') && h3 > 0.9 ? 2 : 1 });
  }
  return out;
}

/** Street lights on the ground round a city: tile offsets from its centre (more and further out with its level). */
export function suburbLights(kind: LightKind, level: number, seed: number): { dx: number; dy: number; tone: LightTone; on: number }[] {
  if (kind !== 'city' && kind !== 'capital') return [];
  const L = Math.max(1, Math.min(6, Math.round(level))) + (kind === 'capital' ? 1 : 0);
  const n = L * L + 1;
  const R = 1.2 + 0.5 * L;
  const out: { dx: number; dy: number; tone: LightTone; on: number }[] = [];
  for (let i = 0; i < n; i++) {
    const a = shaderHash(seed, i, 711) * Math.PI * 2;
    // denser near the middle, thinning out
    const r = R * (0.45 + 0.55 * Math.sqrt(shaderHash(seed, i, 713)));
    out.push({ dx: Math.cos(a) * r, dy: Math.sin(a) * r * 0.8, tone: shaderHash(seed, i, 717) < 0.7 ? 'amber' : 'warm', on: 0.2 + 0.45 * shaderHash(seed, i, 719) });
  }
  return out;
}

/** How strong the lights are at time t (off by day, coming on through dusk, full at night). */
export function lightAmount(t: number): number {
  return smoothstep(0.12, 0.7, darkness(t));
}

/** Fires and blasts glow at any time, brighter at night. */
export function fireGlow(t: number): number {
  return 0.35 + 0.65 * darkness(t);
}

/** A glow's strength at `d` art pixels from its centre, `R` its radius: stepped rings, not a smooth blur. */
export function glowStep(d: number, R: number): number {
  if (d > R) return 0;
  const f = d / R;
  return f < 0.3 ? 0.42 : f < 0.62 ? 0.24 : 0.12;
}

// ------------------------------------------------------------------------------------------------- snow and sea ice

/** [season, how far south the snow reaches (0 pole .. 1 equator), how broken its edge is] round the year */
const SNOW_KEYS: readonly (readonly [number, number, number])[] = [
  [0, 0.07, 0.3],
  [0.5, 0.04, 0.2],
  [1, 0.03, 0.12],
  [2, 0.05, 0.12],
  [2.4, 0.16, 0.22],
  [2.7, 0.38, 0.2],
  [3, 0.62, 0.14],
  [3.5, 0.56, 0.2],
  [4, 0.07, 0.3],
];

function keyed(s: number, col: 1 | 2): number {
  const w = wrapSeason(s);
  for (let i = 0; i + 1 < SNOW_KEYS.length; i++) {
    const a = SNOW_KEYS[i];
    const b = SNOW_KEYS[i + 1];
    if (w <= b[0]) return a[col] + (b[col] - a[col]) * ((w - a[0]) / (b[0] - a[0]));
  }
  return SNOW_KEYS[SNOW_KEYS.length - 1][col];
}

/** How far south the snow line reaches in season s, 0 at the pole, 1 at the equator. */
export function snowReach(s: number): number {
  return keyed(s, 1);
}

/** How broken the snow's edge is: patches in the spring thaw, a cleaner line in deep winter. */
export function snowPatchiness(s: number): number {
  return keyed(s, 2);
}

/** Half the width of the snow's soft edge (in the same units as polar). */
export const SNOW_EDGE = 0.035;

/** Terrain id (sim/types.ts) to how much earlier it takes snow: mountains, tundra and hills first, desert last. */
const SNOW_BIAS = [0, 0, 0, 0.01, 0.06, 0.12, -0.1, -0.02, 0.16];

/**
 * How much snow covers ground at `polar` (0 pole .. 1 equator) in season s, 0..1 before the dither: `n` is a slow 0..1
 * noise at the spot (snowNoise), which breaks the edge into a wandering line and, in the thaw, into patches.
 */
export function snowCover(s: number, polar: number, n: number, terrain: number): number {
  const edge = snowReach(s) - polar + (n - 0.5) * snowPatchiness(s) + (SNOW_BIAS[terrain] ?? 0);
  return smoothstep(-SNOW_EDGE, SNOW_EDGE, edge);
}

/** A value noise on the shader's hash (0..1). */
export function vnoise(x: number, y: number, salt: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = smooth(x - ix);
  const fy = smooth(y - iy);
  const a = shaderHash(ix, iy, salt);
  const b = shaderHash(ix + 1, iy, salt);
  const c = shaderHash(ix, iy + 1, salt);
  const d = shaderHash(ix + 1, iy + 1, salt);
  return (a + (b - a) * fx) * (1 - fy) + (c + (d - c) * fx) * fy;
}

/**
 * The slow noise that shapes the snow's edge at tile point (qx, qy): it drifts as the season turns, so the edge creeps
 * and wanders instead of sliding south as a straight line. `cell` = its size in tiles.
 */
export function snowNoise(qx: number, qy: number, s: number, cell = 5): number {
  const w = wrapSeason(s);
  const ox = w * 2.3;
  const oy = w * 1.1;
  return vnoise(qx / cell + ox, qy / cell + oy, 811) * 0.65 + vnoise((qx * 2.3) / cell - oy, (qy * 2.3) / cell + ox, 813) * 0.35;
}

/** Whether an art pixel (ax, ay) with snow cover `cover` shows snow: the shader's ordered dither over the soft edge. */
export function snowAt(cover: number, ax: number, ay: number): boolean {
  return cover > bayer4(ax, ay);
}

/**
 * How much the sea is frozen at `polar` and `landDist` tiles from the nearest land, in season s (0..1, before the
 * dither): the polar sea freezes later than the land and only out from its coasts, further as winter deepens.
 */
export function seaIce(s: number, polar: number, landDist: number, n: number): number {
  const reach = snowReach(s) * 0.72 - 0.05;
  const depth = clamp01((reach - 0.02) / 0.38);
  if (depth <= 0) return 0;
  const out = 1 + 3.5 * depth;
  const a = smoothstep(-0.012, 0.012, reach - polar + (n - 0.5) * 0.14);
  const b = smoothstep(-0.25, 0.25, out - landDist + (n - 0.5) * 3);
  return a * b;
}

// ------------------------------------------------------------------------------------------------- seasonal ramps

const hx = (h: string): RGB => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const r4 = (a: string, b: string, c: string, d: string): GroundRamp => [hx(a), hx(b), hx(c), hx(d)];

/** The ground's ramps by name, plus the variants the seasons need (autumn trees in three colours and evergreens, spring mud). */
export type RampName = 'grass' | 'grassDry' | 'grassLush' | 'forest' | 'hills' | 'rock' | 'snow' | 'sand' | 'swamp' | 'tundra' | 'wheat' | 'crop' | 'soil' | 'pool';
type Variant = RampName | 'forestRed' | 'forestGold' | 'forestEver' | 'mud';

/**
 * Each ramp in spring, summer, autumn and winter (bare ground, no snow), then under snow. Today's ramps (render/ground.ts)
 * sit between spring and summer; summer is brighter and drier, autumn tawny with golden fields, winter grey-brown.
 */
const TABLE: Record<Variant, readonly [GroundRamp, GroundRamp, GroundRamp, GroundRamp, GroundRamp]> = {
  grass: [
    r4('#335f26', '#4a8034', '#64a044', '#84bd5a'),
    r4('#827238', '#a28e44', '#c2ac56', '#dac46c'),
    r4('#625a38', '#7e7449', '#9b8e5c', '#b4a671'),
    r4('#565850', '#6d6f63', '#86877a', '#9d9d8f'),
    r4('#97a3ad', '#bac4cc', '#d8dfe4', '#eff3f6'),
  ],
  grassDry: [
    r4('#4a6a2c', '#62883a', '#7ea64c', '#9cc062'),
    r4('#8a6e36', '#aa8a44', '#c8a656', '#e0be6c'),
    r4('#6b5c37', '#887448', '#a58e5b', '#bfa670'),
    r4('#5c5a50', '#737064', '#8c897b', '#a4a091'),
    r4('#99a4ad', '#bcc5cc', '#d9e0e4', '#f0f3f5'),
  ],
  grassLush: [
    r4('#2e6226', '#418234', '#59a046', '#78bc5c'),
    r4('#787438', '#968e46', '#b4a858', '#ccc06e'),
    r4('#585a35', '#727044', '#8d8856', '#a7a06a'),
    r4('#4e5349', '#63695c', '#7b8172', '#929788'),
    r4('#95a1ab', '#b8c2ca', '#d6dde3', '#eef2f5'),
  ],
  mud: [
    r4('#4e3a26', '#664c32', '#7e6040', '#957552'),
    r4('#827238', '#a28e44', '#c2ac56', '#dac46c'),
    r4('#625a38', '#7e7449', '#9b8e5c', '#b4a671'),
    r4('#565850', '#6d6f63', '#86877a', '#9d9d8f'),
    r4('#97a3ad', '#bac4cc', '#d8dfe4', '#eff3f6'),
  ],
  forest: [
    r4('#1c3416', '#2f5a24', '#458034', '#64a448'),
    r4('#1a2716', '#2c3f22', '#405a31', '#5b7943'),
    r4('#3a2312', '#6e3b17', '#a3591e', '#cf8935'),
    r4('#1d211a', '#3a3a2f', '#57554a', '#757263'),
    r4('#1f2c27', '#71818a', '#c6d0d6', '#eef2f4'),
  ],
  forestRed: [
    r4('#1c3416', '#2f5a24', '#458034', '#64a448'),
    r4('#1a2716', '#2c3f22', '#405a31', '#5b7943'),
    r4('#33150f', '#642617', '#953a20', '#be5b31'),
    r4('#1d211a', '#3a3a2f', '#57554a', '#757263'),
    r4('#1f2c27', '#71818a', '#c6d0d6', '#eef2f4'),
  ],
  forestGold: [
    r4('#1c3416', '#2f5a24', '#458034', '#64a448'),
    r4('#1a2716', '#2c3f22', '#405a31', '#5b7943'),
    r4('#3b3012', '#6c5a1c', '#9c8327', '#c8ad45'),
    r4('#1d211a', '#3a3a2f', '#57554a', '#757263'),
    r4('#1f2c27', '#71818a', '#c6d0d6', '#eef2f4'),
  ],
  forestEver: [
    r4('#172517', '#263b24', '#375433', '#4f7445'),
    r4('#172416', '#263a23', '#365232', '#4c6f44'),
    r4('#17221a', '#263726', '#364d34', '#4c6646'),
    r4('#16211b', '#24352a', '#33493a', '#4a6350'),
    r4('#1a2a24', '#5d7076', '#b7c4cb', '#e8eef1'),
  ],
  hills: [
    r4('#55603c', '#707c4e', '#8c9963', '#a8b47c'),
    r4('#66603d', '#847b4f', '#a49865', '#c1b47e'),
    r4('#64563a', '#82704a', '#a08b5f', '#bba578'),
    r4('#5a5850', '#737065', '#8d897c', '#a6a194'),
    r4('#8f9aa3', '#b4bec5', '#d3dadf', '#eef2f4'),
  ],
  rock: [
    r4('#3f4043', '#5c5d5e', '#7e7e7b', '#a3a29c'),
    r4('#424140', '#605f5c', '#83817b', '#a8a69d'),
    r4('#413f3e', '#5e5b58', '#807b76', '#a59f97'),
    r4('#3c3e43', '#595c60', '#7b7e81', '#a0a3a5'),
    r4('#3c3f45', '#5d6369', '#d3dadf', '#eef2f4'),
  ],
  snow: [
    r4('#8f9aa3', '#b4bec5', '#d3dadf', '#eef2f4'),
    r4('#8f9aa3', '#b4bec5', '#d3dadf', '#eef2f4'),
    r4('#8f9aa3', '#b4bec5', '#d3dadf', '#eef2f4'),
    r4('#8f9aa3', '#b4bec5', '#d3dadf', '#eef2f4'),
    r4('#8f9aa3', '#b4bec5', '#d3dadf', '#eef2f4'),
  ],
  sand: [
    r4('#8e7a54', '#ab9568', '#c5ae7f', '#dcc89a'),
    r4('#97805a', '#b59d6d', '#cfb684', '#e5d0a0'),
    r4('#8b7552', '#a88f66', '#c1a87d', '#d8c297'),
    r4('#837765', '#9e927d', '#b7ab95', '#cdc2ad'),
    r4('#a09f9c', '#c2c4c4', '#dcdfe0', '#f1f3f4'),
  ],
  swamp: [
    r4('#2c3a26', '#42563a', '#58693f', '#70814f'),
    r4('#2e3426', '#434b33', '#59613f', '#70784f'),
    r4('#3a3626', '#544c33', '#6d6342', '#857b53'),
    r4('#33372f', '#4a5045', '#61675a', '#787e70'),
    r4('#5c6a70', '#8395a0', '#b6c5cd', '#dfe8ec'),
  ],
  tundra: [
    r4('#6b7766', '#869383', '#9fab9a', '#b6c0b1'),
    r4('#707a62', '#8b967c', '#a4ae94', '#bbc3aa'),
    r4('#6f6655', '#8a7f69', '#a39780', '#b9ae98'),
    r4('#7d8790', '#9ea8af', '#bdc5cb', '#d6dce0'),
    r4('#8f9aa3', '#b4bec5', '#d3dadf', '#eef2f4'),
  ],
  wheat: [
    r4('#3f6a2a', '#558a36', '#70a848', '#8ec45e'),
    r4('#9a7e34', '#bc9c40', '#d8b852', '#ecd06a'),
    r4('#8a6c35', '#a98945', '#c6a55a', '#dabd72'),
    r4('#5f5a4c', '#77715f', '#8e8873', '#a39d87'),
    r4('#9ca7b0', '#bec8cf', '#dbe1e6', '#f1f4f6'),
  ],
  crop: [
    r4('#36662a', '#4a8836', '#62a648', '#80c05e'),
    r4('#8a843a', '#a8a248', '#c4bc5a', '#d8d070'),
    r4('#7f6331', '#9d7d3f', '#b99851', '#cfaf66'),
    r4('#57594b', '#6e705f', '#858673', '#9b9b87'),
    r4('#9ca7b0', '#bec8cf', '#dbe1e6', '#f1f4f6'),
  ],
  soil: [
    r4('#47331f', '#5e442a', '#765838', '#8c6b4a'),
    r4('#7a6644', '#957e56', '#ae966a', '#c4ac80'),
    r4('#54432d', '#6c573b', '#846b4c', '#9a805f'),
    r4('#554c40', '#6b6153', '#827767', '#988d7c'),
    r4('#9aa4ac', '#bcc5cc', '#d9e0e4', '#f0f3f5'),
  ],
  pool: [
    r4('#1f3436', '#2a4446', '#385858', '#577678'),
    r4('#1f3134', '#2a4043', '#385356', '#577276'),
    r4('#22302f', '#2e3e3c', '#3c504c', '#5b6e69'),
    r4('#6f8791', '#9fb3bc', '#c7d6dc', '#e6eef1'),
    r4('#6f8791', '#9fb3bc', '#c7d6dc', '#e6eef1'),
  ],
};

/** Sea colour shift per season (spring, summer, autumn, winter): bluer in summer, colder and greyer in winter. */
const SEA_SHIFT: readonly RGB[] = [[0, 2, 2], [-1, 4, 8], [-2, -1, -3], [-3, -1, 3]];
/** Sea ice: deep crack, crack, ice, bright rim. */
export const ICE: GroundRamp = r4('#7b919d', '#a5b8c2', '#cddbe1', '#eaf1f4');

const RAMP_NAMES: readonly RampName[] = ['grass', 'grassDry', 'grassLush', 'forest', 'hills', 'rock', 'snow', 'sand', 'swamp', 'tundra', 'wheat', 'crop', 'soil', 'pool'];

/** Today's ground colours (render/ground.ts) to their ramp and tone: the ground pass draws exact ramp colours. */
const MATCH = new Map<number, [RampName, number]>();
const ALL: [RGB, RampName, number][] = [];
for (const name of RAMP_NAMES) {
  GROUND[name].forEach((c, i) => {
    const key = (c[0] << 16) | (c[1] << 8) | c[2];
    if (!MATCH.has(key)) MATCH.set(key, [name, i]);
    ALL.push([c as RGB, name, i]);
  });
}
const NEAR = new Map<number, [RampName, number, number, number, number]>();

/** The ramp and tone of a ground colour, and what is left over (for colours mixed by the shader: beaches, far views). */
export function matchGround(c: readonly number[]): { name: RampName; tone: number; rest: RGB } {
  const key = (c[0] << 16) | (c[1] << 8) | c[2];
  const m = MATCH.get(key);
  if (m) return { name: m[0], tone: m[1], rest: [0, 0, 0] };
  let n = NEAR.get(key);
  if (!n) {
    let best = Infinity;
    let pick = ALL[0];
    for (const e of ALL) {
      const d = (e[0][0] - c[0]) ** 2 + (e[0][1] - c[1]) ** 2 + (e[0][2] - c[2]) ** 2;
      if (d < best) {
        best = d;
        pick = e;
      }
    }
    n = [pick[1], pick[2], c[0] - pick[0][0], c[1] - pick[0][1], c[2] - pick[0][2]];
    if (NEAR.size < 200_000) NEAR.set(key, n);
  }
  return { name: n[0], tone: n[1], rest: [n[2], n[3], n[4]] };
}

/** The look of one season value: every ramp blended between its two seasons, the snow and sea settings. */
export interface SeasonLook {
  s: number;
  ramps: Record<Variant, GroundRamp>;
  snowy: Record<Variant, GroundRamp>;
  sea: RGB;
  /** how much spring there is (mud patches on the plains) and autumn (trees in colour) */
  spring: number;
  autumn: number;
}

const mixRamp = (a: GroundRamp, b: GroundRamp, f: number): GroundRamp =>
  a.map((c, i) => [Math.round(c[0] + (b[i][0] - c[0]) * f), Math.round(c[1] + (b[i][1] - c[1]) * f), Math.round(c[2] + (b[i][2] - c[2]) * f)] as RGB) as unknown as GroundRamp;

const looks = new Map<number, SeasonLook>();

/** The look of season s (cached per hundredth of a season). */
export function seasonLook(s: number): SeasonLook {
  const w = Math.round(wrapSeason(s) * 100) / 100;
  let l = looks.get(w);
  if (l) return l;
  const a = Math.floor(w) % 4;
  const b = (a + 1) % 4;
  const f = w - Math.floor(w);
  const ramps = {} as Record<Variant, GroundRamp>;
  const snowy = {} as Record<Variant, GroundRamp>;
  for (const k of Object.keys(TABLE) as Variant[]) {
    ramps[k] = mixRamp(TABLE[k][a], TABLE[k][b], f);
    snowy[k] = TABLE[k][4];
  }
  const sea: RGB = [0, 1, 2].map((i) => SEA_SHIFT[a][i] + (SEA_SHIFT[b][i] - SEA_SHIFT[a][i]) * f) as RGB;
  const near = (c: number): number => {
    const d = Math.min(Math.abs(w - c), Math.abs(w - c - 4), Math.abs(w - c + 4));
    return clamp01(1 - d);
  };
  l = { s: w, ramps, snowy, sea, spring: near(0), autumn: near(2) };
  if (looks.size > 500) looks.clear();
  looks.set(w, l);
  return l;
}

/** The season's ramps as a ground palette (for things that pick ground colours by terrain, like rail beds). */
export function seasonPalette(s: number): GroundPalette {
  const l = seasonLook(s);
  const sea = GROUND.sea.map((c) => [c[0] + l.sea[0], c[1] + l.sea[1], c[2] + l.sea[2]] as RGB);
  return { ...GROUND, ...Object.fromEntries(RAMP_NAMES.map((n) => [n, l.ramps[n]])), sea } as GroundPalette;
}

/** Where an art pixel of the ground is: its terrain, its tile point, its art pixel, how polar it is, how far from land. */
export interface GroundSpot {
  terrain: number;
  /** tile point of the art pixel's centre */
  qx: number;
  qy: number;
  /** the art pixel (for the dither) */
  ax: number;
  ay: number;
  /** 0 at the pole .. 1 at the equator */
  polar: number;
  /** water: tiles to the nearest land */
  landDist: number;
  /** size of the snow edge's noise, in tiles (5 for a small map) */
  cell?: number;
  /** art pixels per tile (the tree grid follows it) */
  P?: number;
}

/**
 * The tree crown an art pixel belongs to (shaders.ts treeAt: its grid, jitter and sizes): the cell of the nearest crown
 * centre, so a whole crown takes one autumn colour instead of being cut by a square grid.
 */
export function crownOf(qx: number, qy: number, P: number): [number, number] {
  const tc = P >= 8 ? 2 : 1;
  const c2x = qx * tc;
  const c2y = qy * tc;
  const c0x = Math.floor(c2x - 0.5);
  const c0y = Math.floor(c2y - 0.5);
  let best = Infinity;
  let bx = c0x;
  let by = c0y;
  for (let j = 0; j < 2; j++) {
    for (let i = 0; i < 2; i++) {
      const cx = c0x + i;
      const cy = c0y + j;
      const ox = cx + 0.5 + (shaderHash(cx, cy, 101) - 0.5) * 0.5;
      const oy = cy + 0.5 + (shaderHash(cx, cy, 103) - 0.5) * 0.5;
      const r = 0.66 + 0.2 * shaderHash(cx, cy, 107);
      const d = Math.hypot(c2x - ox, c2y - oy) / r;
      if (d < best) {
        best = d;
        bx = cx;
        by = cy;
      }
    }
  }
  return [bx, by];
}

const clampC = (v: number): number => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));

/**
 * A ground colour in a season: the same ramp and tone in the season's colours, snow over it where the season's snow
 * reaches (dithered edge), the polar sea frozen near its coasts. Pure: the same colour and spot give the same pixel.
 */
export function seasonGround(c: readonly number[], at: GroundSpot, look: SeasonLook): RGB {
  const s = look.s;
  const n = snowNoise(at.qx, at.qy, s, at.cell ?? 5);
  if (at.terrain <= 1) {
    const ice = seaIce(s, at.polar, at.landDist, n);
    if (ice > 0 && ice > bayer4(at.ax, at.ay)) {
      // floes: mostly plain ice, thin dark cracks, a bright rim on their upper edges
      const k = vnoise(at.qx * 1.7, at.qy * 1.7, 821);
      const tone = k > 0.47 && k < 0.53 ? 1 : k > 0.8 ? 3 : 2;
      return [ICE[tone][0], ICE[tone][1], ICE[tone][2]];
    }
    return [clampC(c[0] + look.sea[0]), clampC(c[1] + look.sea[1]), clampC(c[2] + look.sea[2])];
  }
  const m = matchGround(c);
  let v: Variant = m.name;
  if (v === 'forest') {
    // each tree crown its own colour: red, gold and orange crowns among evergreens
    const [cx, cy] = crownOf(at.qx, at.qy, at.P ?? 8);
    const h = shaderHash(cx, cy, 831);
    v = h < 0.28 ? 'forestEver' : h < 0.5 ? 'forestRed' : h < 0.68 ? 'forestGold' : 'forest';
  } else if ((v === 'grass' || v === 'grassDry' || v === 'grassLush') && look.spring > 0) {
    // spring mud on the plains, in slow patches
    if (vnoise(at.qx / 2.6, at.qy / 2.6, 841) > 1 - 0.42 * look.spring) v = 'mud';
  }
  const snow = snowAt(snowCover(s, at.polar, n, at.terrain), at.ax, at.ay);
  const ramp = snow ? look.snowy[v] : look.ramps[v];
  let tone = m.tone;
  if (snow && v !== 'rock') {
    // drifts: wind-blown ridges one tone lighter, hollows one darker, so snow keeps a pixel texture
    const d = vnoise((at.qx + at.qy * 0.4) * 1.3, at.qy * 2.2, 851);
    tone = Math.max(0, Math.min(3, tone + (d > 0.66 ? 1 : d < 0.3 ? -1 : 0)));
  }
  const base = ramp[tone];
  const k = snow ? 0.4 : 0.85;
  return [clampC(base[0] + m.rest[0] * k), clampC(base[1] + m.rest[1] * k), clampC(base[2] + m.rest[2] * k)];
}
