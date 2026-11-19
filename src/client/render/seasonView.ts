// Seasons and day and night on the game map (client only, looks only): turns the game clock into what the map shader
// (render/shaders.ts, uniforms set by render/glmap.ts) and the overlay (renderer.ts world tint, render/nightLights.ts)
// draw. The colours and the light are the art lab's owner-approved maths (art/detailed/seasons.ts); where the snow and
// the sea ice lie is the sim's (sim/seasons.ts snowRowsAt, iceRowsFor), only smoothed so nothing pops: the snow line
// moves by fractions of a row and the ice and the tundra snow fade in and out over a few seconds.
//
// Nothing here writes to the game state; the sim never reads it.
import { SEASON, TICKS_PER_SECOND } from '../../sim/config';
import { SEASON_TICKS, iceRowsFor, playTicks, seasonAtTick, snowMaxRows } from '../../sim/seasons';
import type { GameState } from '../../sim/types';
import { dayPhase, dayWarmth } from '../dayNight';
import { getSettings } from '../settings/store';
import { GROUND, type GroundRamp } from './ground';
import { ICE, lightOf, seasonLook, type DayLight, type SeasonLook } from '../art/detailed/seasons';

/** Ticks the sea ice and the tundra's winter snow take to come and to go (a fade, not a pop). */
const FADE_TICKS = 5 * TICKS_PER_SECOND;
/** Share of each season it keeps its own colours before blending into the next one's (its last part blends). */
const HOLD = 0.6;

/** What the map draws for the season and the time of day. */
export interface MapLook {
  /** season value: 0 spring, 1 summer, 2 autumn, 3 winter at their height (4 = spring again), as art/detailed/seasons.ts */
  s: number;
  /** rows of snow from each pole (fractional), its edge's wander (tiles), the tundra's winter snow 0..1 */
  snowRows: number;
  snowEdge: number;
  tundra: number;
  /** rows of sea ice from each pole (fractional, fading in at the start of winter) */
  iceRows: number;
  /** how much spring (mud patches) and autumn there is */
  spring: number;
  autumn: number;
  /** the light: darkness 0..1, dawn and dusk glow 0..1, and the shade for both (art/detailed/seasons.ts DayLight) */
  dark: number;
  warm: number;
  light: DayLight;
  /** night lights 0..1 and how strongly fires and blasts glow (brighter at night) */
  lights: number;
  fire: number;
}

/** Tests and screenshots: show the map at these play ticks (seasons) and this tick (time of day) instead of the game's. */
let override: { playTicks?: number; tick?: number } | null = null;
export function setLookOverride(o: { playTicks?: number; tick?: number } | null): void {
  override = o;
}
export function lookOverride(): { playTicks?: number; tick?: number } | null {
  return override;
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
const smooth = (v: number): number => {
  const t = clamp01(v);
  return t * t * (3 - 2 * t);
};

/** The season value at `ticks` play ticks: each season holds its look, then blends into the next over its last part. */
export function seasonValue(ticks: number, startIndex: number = SEASON.startIndex): number {
  const si = seasonAtTick(ticks, startIndex);
  return (si.index + smooth((si.progress - HOLD) / (1 - HOLD))) % 4;
}

/** Rows of snow from each pole at `ticks`, as sim/seasons.ts snowRowsAt but not floored (the art's line moves smoothly). */
export function snowRowsSmooth(ticks: number, height: number, startIndex: number = SEASON.startIndex): number {
  const s = seasonAtTick(ticks, startIndex);
  const max = snowMaxRows(height);
  if (s.season === 'winter') return max * Math.min(1, s.ticksInto / ((SEASON_TICKS * SEASON.snowGrowPercent) / 100));
  if (s.season === 'spring' && s.count > 0) return max * (1 - Math.min(1, s.ticksInto / ((SEASON_TICKS * SEASON.snowMeltPercent) / 100)));
  return 0;
}

/** How much the winter-only looks (sea ice, snow on all tundra) show at `ticks`: in over FADE_TICKS of winter, out over the same of spring. */
export function winterLook(ticks: number, startIndex: number = SEASON.startIndex): number {
  const s = seasonAtTick(ticks, startIndex);
  if (s.season === 'winter') return smooth(s.ticksInto / FADE_TICKS);
  if (s.season === 'spring' && s.count > 0) return 1 - smooth(s.ticksInto / FADE_TICKS);
  return 0;
}

/** True when day and night show (the Settings switch). */
export function dayNightOn(): boolean {
  return getSettings().dayNight !== false;
}

/** The map's look for a game now (or at the test override). */
export function mapLook(state: Pick<GameState, 'phase' | 'tick' | 'playStartTick' | 'map'>): MapLook {
  const pt = override?.playTicks ?? playTicks(state);
  const tick = override?.tick ?? state.tick;
  const h = state.map.height;
  const s = seasonValue(pt);
  const look = seasonLook(s);
  const wl = winterLook(pt);
  const on = dayNightOn();
  const dark = on ? 1 - dayPhase(tick) : 0;
  const warm = on ? dayWarmth(tick) : 0;
  return {
    s,
    snowRows: snowRowsSmooth(pt, h),
    snowEdge: Math.max(1.5, Math.min(6, h * 0.012)),
    tundra: wl,
    iceRows: iceRowsFor(h) * wl,
    spring: look.spring,
    autumn: look.autumn,
    dark,
    warm,
    light: lightOf(dark, warm),
    lights: smooth((dark - 0.12) / (0.7 - 0.12)),
    fire: 0.35 + 0.65 * dark,
  };
}

// ------------------------------------------------------------------------------------------------- shader data

type Variant = keyof SeasonLook['ramps'];
type BaseName = 'grass' | 'grassDry' | 'grassLush' | 'forest' | 'hills' | 'rock' | 'snow' | 'sand' | 'swamp' | 'tundra' | 'wheat' | 'crop' | 'soil' | 'pool';

/**
 * The shader's ramps by id (shaders.ts R4): each one's seasonal variant and the theme ramp it starts from. The last four
 * are the seasons' own: autumn crowns in red, gold and evergreen (from the forest), spring mud (from the grass).
 */
export const RAMP_IDS: readonly { glsl: string; variant: Variant; base: BaseName }[] = [
  { glsl: 'GRASS', variant: 'grass', base: 'grass' },
  { glsl: 'GRASS_DRY', variant: 'grassDry', base: 'grassDry' },
  { glsl: 'GRASS_LUSH', variant: 'grassLush', base: 'grassLush' },
  { glsl: 'FOREST', variant: 'forest', base: 'forest' },
  { glsl: 'HILLS', variant: 'hills', base: 'hills' },
  { glsl: 'ROCK', variant: 'rock', base: 'rock' },
  { glsl: 'SNOW', variant: 'snow', base: 'snow' },
  { glsl: 'SAND', variant: 'sand', base: 'sand' },
  { glsl: 'SWAMP', variant: 'swamp', base: 'swamp' },
  { glsl: 'TUNDRA', variant: 'tundra', base: 'tundra' },
  { glsl: 'WHEAT', variant: 'wheat', base: 'wheat' },
  { glsl: 'CROP', variant: 'crop', base: 'crop' },
  { glsl: 'SOIL', variant: 'soil', base: 'soil' },
  { glsl: 'POOL', variant: 'pool', base: 'pool' },
  { glsl: 'FOREST_RED', variant: 'forestRed', base: 'forest' },
  { glsl: 'FOREST_GOLD', variant: 'forestGold', base: 'forest' },
  { glsl: 'FOREST_EVER', variant: 'forestEver', base: 'forest' },
  { glsl: 'MUD', variant: 'mud', base: 'grass' },
];
export const RAMP_COUNT = RAMP_IDS.length;

const deltas = new Map<number, Float32Array>();

/**
 * The season's change to every ramp tone (0..1 per channel, RAMP_COUNT x 4 x rgb): its colour in season s minus
 * today's ground colour, so a map theme's own ramps shift by the same amount (the default theme lands exactly on the
 * art lab's colours). Cached per hundredth of a season.
 */
export function rampDeltas(s: number): Float32Array {
  const look = seasonLook(s);
  let d = deltas.get(look.s);
  if (d) return d;
  d = new Float32Array(RAMP_COUNT * 12);
  RAMP_IDS.forEach((r, i) => {
    const to = look.ramps[r.variant];
    const from = GROUND[r.base] as GroundRamp;
    for (let t = 0; t < 4; t++) for (let c = 0; c < 3; c++) d![i * 12 + t * 3 + c] = (to[t][c] - from[t][c]) / 255;
  });
  if (deltas.size > 450) deltas.clear();
  deltas.set(look.s, d);
  return d;
}

/** The snowy tones of every ramp (RAMP_COUNT x 4 RGB, 0..255): the same in every season and theme. */
export function snowyRamps(): GroundRamp[] {
  const look = seasonLook(0);
  return RAMP_IDS.map((r) => look.snowy[r.variant]);
}

const meanTone = (r: GroundRamp, k: number): number => (r[1][k] + r[2][k]) / 2;
/** Each terrain's mix of ramps in the far view's average colours (sim/types.ts terrain ids 2..8). */
const FAR_MIX: Record<number, [Variant, BaseName, number][]> = {
  2: [['grass', 'grass', 0.7], ['wheat', 'wheat', 0.15], ['crop', 'crop', 0.15]],
  3: [['forestEver', 'forest', 0.28], ['forestRed', 'forest', 0.22], ['forestGold', 'forest', 0.18], ['forest', 'forest', 0.32]],
  4: [['hills', 'hills', 1]],
  5: [['rock', 'rock', 1]],
  6: [['sand', 'sand', 1]],
  7: [['swamp', 'swamp', 1]],
  8: [['tundra', 'tundra', 1]],
};

/** The season's change to the far view's colour of each terrain (9 x rgb, 0..1); water takes the sea's shift. */
const fars = new Map<number, Float32Array>();
export function farDeltas(s: number): Float32Array {
  const look = seasonLook(s);
  const had = fars.get(look.s);
  if (had) return had;
  const out = new Float32Array(27);
  if (fars.size > 450) fars.clear();
  fars.set(look.s, out);
  for (let ter = 0; ter < 9; ter++) {
    for (let k = 0; k < 3; k++) {
      if (ter <= 1) {
        out[ter * 3 + k] = look.sea[k] / 255;
        continue;
      }
      let v = 0;
      for (const [variant, base, w] of FAR_MIX[ter]) v += w * (meanTone(look.ramps[variant], k) - meanTone(GROUND[base] as GroundRamp, k));
      out[ter * 3 + k] = v / 255;
    }
  }
  return out;
}

/** The far view's colour of snow on each terrain and of sea ice on water (9 RGB, 0..255; the same all year). */
export function farSnow(): [number, number, number][] {
  const look = seasonLook(0);
  const out: [number, number, number][] = [];
  for (let ter = 0; ter < 9; ter++) {
    if (ter <= 1) {
      out.push([0, 1, 2].map((k) => meanTone(ICE, k)) as [number, number, number]);
      continue;
    }
    const c = [0, 0, 0];
    for (const [variant, , w] of FAR_MIX[ter]) for (let k = 0; k < 3; k++) c[k] += w * meanTone(look.snowy[variant], k);
    out.push(c.map((v) => Math.round(v)) as [number, number, number]);
  }
  return out;
}

// ------------------------------------------------------------------------------------------------- the overlay's shade

/**
 * The night and the dawn and dusk glow over the overlay's world art (buildings, rails, trains, units, effects): one
 * fill over what is drawn (renderer.ts, composite 'source-atop'), so colour c at alpha a. Close to the map's own
 * shade (art/detailed/seasons.ts shadeLight): about 28% darker and cool blue at full night, a little warm at dawn and
 * dusk. a = 0: nothing to do.
 */
export function overlayShade(l: Pick<MapLook, 'dark' | 'warm'>): { a: number; c: [number, number, number] } {
  const an = 0.3 * l.dark;
  const aw = 0.1 * l.warm * (1 - l.dark * 0.45);
  const a = an + aw;
  if (a <= 0.002) return { a: 0, c: [0, 0, 0] };
  const night = [6, 14, 44];
  const warm = [255, 150, 72];
  return { a, c: [0, 1, 2].map((k) => Math.round((night[k] * an + warm[k] * aw) / a)) as [number, number, number] };
}
