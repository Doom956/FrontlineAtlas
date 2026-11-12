// What a realistic unit is made of (client only): the painted layers of one unit model and where its moving parts
// sit. units.ts bakes each layer into the style's atlas and puts them together on the map every frame:
//   body    everything that never changes with the owner (hull, deck, turrets, wings), baked per heading bucket
//   owner   the owner's marks only (a deck band, a funnel, roundels), baked per heading bucket and owner colour: a small
//           picture, so a map with many nations does not multiply the big one
//   shadow  the soft ground shadow, baked once facing east and turned freely (ships on the water, planes on the ground
//           far below them, offset by their height)
//   turret  a tank's turret with its owner marks, drawn turning round its ring (turret sway)
// Art units: the bow or nose at +x, starboard at +y, the unit's centre at the origin; one art unit is one CSS px at
// map scale 1 (render/units.ts spriteScale).
import type { Col, Paint } from './paint';

/** A box in art units round everything a layer paints (its cast shadows included). */
export interface Bounds {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface Layer {
  b: Bounds;
  paint(p: Paint): void;
}

/**
 * The owner's colour as painted tones (deep, dark, base, light) plus a small brighter `accent` (a roundel's centre) and
 * the raw colour (`owner`, for toward()). Never the full-saturation nation colour: it is mixed toward the unit's own
 * paint and its chroma capped, so a mark reads as paint on a miniature (a recognition panel, a band), not as a sticker.
 */
export interface Tones {
  deep: Col;
  dark: Col;
  base: Col;
  light: Col;
  accent: Col;
  owner: Col;
}

// ---- OKLab (the mixing and the caps are done in a perceptual space, so every hue is muted alike)

const lin = (v: number): number => {
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
};
const gam = (v: number): number => {
  const c = v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(Math.max(0, v), 1 / 2.4) - 0.055;
  return Math.max(0, Math.min(255, c * 255));
};

/** sRGB (0..255) to OKLab [L, a, b]. */
export function toLab(c: readonly number[]): [number, number, number] {
  const r = lin(c[0]);
  const g = lin(c[1]);
  const b = lin(c[2]);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
}

/** OKLab to sRGB (0..255, clamped). */
export function fromLab(L: number, A: number, B: number): Col {
  const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
  const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
  const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3;
  return [gam(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s), gam(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s), gam(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s)];
}

/** OKLCH chroma of a colour. */
export function chromaOf(c: readonly number[]): number {
  const [, a, b] = toLab(c);
  return Math.hypot(a, b);
}

/** A colour at OKLab lightness L with chroma C along the hue (a, b) (C capped at what the hue has). */
function lc(L: number, a: number, b: number, C: number): Col {
  const c0 = Math.hypot(a, b);
  const k = c0 > 1e-6 ? C / c0 : 0;
  return fromLab(Math.max(0.05, Math.min(0.97, L)), a * k, b * k);
}

/** A neutral warm grey: what the owner's colour is mixed toward when a mark has no paint of its own. */
export const NEUTRAL: Col = [128, 128, 120];

/** Most chroma a mark gets (OKLCH): a nation's colour stays clearly its hue, but as matte paint. */
export const OWNER_CHROMA = 0.1;

const toneCache = new Map<string, Tones>();

/**
 * The owner's tones mixed `k` toward the unit's own `paint` (haze grey, olive drab, cloth), the chroma capped at
 * OWNER_CHROMA and the base lightness held between lMin and lMax (decks and tank roofs lower, cloth higher).
 */
export function tonesOf(owner: readonly number[], paint: readonly number[] = NEUTRAL, k = 0.4, lMin = 0.42, lMax = 0.6): Tones {
  const key = `${owner[0] | 0},${owner[1] | 0},${owner[2] | 0}|${paint[0] | 0},${paint[1] | 0},${paint[2] | 0}|${k}|${lMin}|${lMax}`;
  const hit = toneCache.get(key);
  if (hit) return hit;
  const o = toLab(owner);
  const q = toLab(paint);
  const L = Math.max(lMin, Math.min(lMax, o[0] + (q[0] - o[0]) * k));
  const a = o[1] + (q[1] - o[1]) * k;
  const b = o[2] + (q[2] - o[2]) * k;
  const C = Math.min(OWNER_CHROMA, Math.hypot(a, b));
  // the accent keeps the owner's own hue a little brighter (a roundel's centre, a pennant), still well below the raw colour
  const Co = Math.hypot(o[1], o[2]);
  const t: Tones = {
    deep: lc(L - 0.22, a, b, C * 0.75),
    dark: lc(L - 0.11, a, b, C * 0.9),
    base: lc(L, a, b, C),
    light: lc(L + 0.12, a, b, C * 0.85),
    accent: lc(Math.max(0.5, Math.min(0.68, o[0])), o[1], o[2], Math.min(0.13, Co)),
    owner: [owner[0], owner[1], owner[2]],
  };
  if (toneCache.size > 512) toneCache.clear();
  toneCache.set(key, t);
  return t;
}

/** The same owner, its tones mixed toward another paint (a mark on olive drab rather than haze grey). */
export const toward = (t: Tones, paint: readonly number[], k = 0.4, lMin = 0.42, lMax = 0.6): Tones => tonesOf(t.owner, paint, k, lMin, lMax);

export interface OwnerLayer {
  b: Bounds;
  paint(p: Paint, t: Tones): void;
}

export interface Prop {
  x: number;
  y: number;
  /** blade radius (art units) */
  r: number;
}

export interface UnitModel {
  /** length along the heading (art units): what lengthPx reports */
  len: number;
  /** the larger of the length and the span: what must fit a portrait box */
  fit: number;
  body: Layer;
  /** the owner's marks, in up to four small parts (each baked on its own, so far apart marks stay small pictures) */
  owners?: OwnerLayer[];
  /** the ground shadow, drawn on its own and turned freely */
  shadow?: Layer;
  /** height of the shadow's offset at rest (art units): ships about 1, planes their altitude */
  alt: number;
  /** a tank's turret: drawn over the body, turning round (x, y) */
  turret?: { x: number; y: number; layer: OwnerLayer };
  /** planes: the starboard wing's silhouette, shaded toward the tip (the lower wing in a bank; mirrored for port) */
  wingShade?: Layer;
  /** spinning propellers (planes without jets) */
  props?: readonly Prop[];
  /** a missile's exhaust: its nozzle at x (art units, at the tail) and the flame's size */
  flame?: { x: number; r: number };
  /** ships: the guns of a salvo (fx/pixelFx.ts SALVO), as (x, y) art units */
  guns?: readonly (readonly [number, number])[];
  /** ships: half the beam (art units), for the wake */
  beam?: number;
  /** ships: where the stern is (art units, negative) */
  stern?: number;
  /** tanks: the back of the hull (x) and the tracks' distance from the centre line (y), where dust is kicked up */
  dust?: { x: number; y: number };
}

export const bounds = (x0: number, y0: number, x1: number, y1: number): Bounds => ({ x0, y0, x1, y1 });
