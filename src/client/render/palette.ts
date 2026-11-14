// Display palette for territory: the game's nation colours are bright and saturated (they have to be told apart in
// lists, chips and flags), but painted over the map they look cartoonish. Territory is drawn with a calmer version
// of each colour (less chroma, narrower lightness range, OKLCH so the hue stays put), semi-transparent over a
// quiet copy of the terrain, with crisp borders in a darker, slightly more saturated shade of the same colour.
// Everything here runs when the palette changes (a few hundred colours), never per frame; the shader, the minimap
// and the 2D fallback read the same constants so they agree.
import type { MapStyle } from './mapStyle';

export type Rgb = [number, number, number];
export type DisplayRole = 'nation' | 'own' | 'tribe';

// ---- tunables (see colors-*.png in /tmp/borderfall-shots for the before / after) ----
/** Chroma kept (x the colour's own) per role: you keep more so you can find yourself; tribes are the calmest. */
const CHROMA_KEEP: Record<DisplayRole, number> = { nation: 0.88, own: 1.0, tribe: 0.85 };
/** Lightness is pulled towards this by LIGHT_KEEP (1 = unchanged): bright yellows and dark navies meet in the middle. */
const LIGHT_MID = 0.68;
const LIGHT_KEEP = 0.72;
/** Opacity of the territory fill over the (calmed) terrain. */
export const NATION_ALPHA = 0.7;
export const TRIBE_ALPHA = 0.26;
/** How much of its own colour the terrain keeps under a nation (0 = grey of the same brightness, 1 = unchanged). */
export const UNDER_CHROMA = 0.55;
/** Brightness range the terrain keeps under a nation, around UNDER_MID (1 = unchanged): forest and desert barely stripe the land. */
export const UNDER_LUM = 0.45;
export const UNDER_MID = 0.42;
/** Terrain pattern strength under a nation (1 = as on free land): detail shows through softly, not as patches. */
export const UNDER_DETAIL = 0.15;
/**
 * Per map style (render/mapStyle.ts): the fill's share over the ground (nation, tribe), extra chroma kept and the
 * lightness range. Pixel terrain tints the ground (the nation colour carries its light and dark); the muted war map is
 * today's opaque fill in a greyer, narrower military palette (you keep more colour, to find yourself); real ground
 * shows nations by their border bands and only a light tint.
 */
const STYLE_FILL: Record<MapStyle, { nation: number; tribe: number; chroma: number; ownChroma: number; lightMid: number; lightKeep: number }> = {
  today: { nation: NATION_ALPHA, tribe: TRIBE_ALPHA, chroma: 1, ownChroma: 1, lightMid: LIGHT_MID, lightKeep: LIGHT_KEEP },
  pixel: { nation: 0.66, tribe: 0.22, chroma: 0.92, ownChroma: 1.0, lightMid: 0.64, lightKeep: 0.72 },
  muted: { nation: 0.88, tribe: 0.24, chroma: 0.62, ownChroma: 0.82, lightMid: 0.6, lightKeep: 0.6 },
  ground: { nation: 0.18, tribe: 0.1, chroma: 1.08, ownChroma: 1.08, lightMid: 0.62, lightKeep: 0.72 },
};

/**
 * Real ground (map style C): how a nation colours the ground under it. A plain blend of a red nation over green grass
 * comes out brown (the two hues cancel), so the ground's own colour is mostly taken out and the nation's hue put in at
 * the ground's brightness: the land keeps its light and dark (trees, fields, hill shading), the hue is the nation's on
 * any ground. Per strength: [ground colour kept, nation colour added, broad brightness kept, small detail kept].
 * Close in the tint is light (the border bands carry the nation), far out it takes over (the bands get too thin).
 */
export type TintK = readonly [number, number, number, number];
export const GROUND_TINT: { near: TintK; far: TintK; band: TintK; tribe: TintK } = {
  near: [0.6, 0.3, 0.85, 1],
  far: [0.2, 0.76, 0.3, 0.85],
  band: [0.08, 1, 0.15, 0.4],
  tribe: [0.75, 0.28, 0.9, 1],
};
/** Zoom (CSS px per tile) where the far tint ends and the near one is full. */
export const GROUND_TINT_ZOOM: readonly [number, number] = [2.2, 7];
/**
 * The nation colour is moved to the ground's brightness by at most this much: never brightened past TINT_LIFT_MAX (a
 * navy on snow stays a navy), never darkened below TINT_LIFT_MIN (on dark forest the colour keeps its strength).
 */
export const TINT_LIFT_MAX = 1.6;
export const TINT_LIFT_MIN = 0.75;

const lumaOf = (c: readonly number[]): number => 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];

/** Mix of two tint strengths (t = 0 a, 1 b). */
export function tintMix(a: TintK, b: TintK, t: number): TintK {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t, a[3] + (b[3] - a[3]) * t];
}

/**
 * Nation colour `fill` on ground colour `ground` (bytes), the same maths as the map shader's tintGround. `avgY` is the
 * ground's broad brightness (0..255; the minimap and the 2D fallback pass the ground's own).
 */
export function groundTint(ground: readonly number[], fill: readonly number[], k: TintK, avgY = lumaOf(ground)): Rgb {
  const gy = lumaOf(ground);
  const oy = Math.max(10, lumaOf(fill));
  const y = oy + (avgY - oy) * k[2] + (gy - avgY) * k[3];
  const lift = Math.max(TINT_LIFT_MIN, Math.min(TINT_LIFT_MAX, y / oy));
  const ch = (i: number): number => Math.round(Math.max(0, Math.min(255, y + (fill[i] - oy) * lift * k[1] + (ground[i] - gy) * k[0])));
  return [ch(0), ch(1), ch(2)];
}

/** Opacity of a territory fill in a map style. */
export function fillAlpha(style: MapStyle, tribe: boolean): number {
  const f = STYLE_FILL[style] ?? STYLE_FILL.today;
  return tribe ? f.tribe : f.nation;
}

/** Border: lightness x, chroma x of the display colour, and the chroma ceiling (borders stay muted too). */
const BORDER_LIGHT = 0.7;
const BORDER_CHROMA = 1.2;
const BORDER_CHROMA_MAX = 0.1;

// ---- OKLab ----
const lin = (c: number): number => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const gam = (c: number): number => (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);

export function toOklch(rgb: readonly number[]): [number, number, number] {
  const r = lin(rgb[0] / 255);
  const g = lin(rgb[1] / 255);
  const b = lin(rgb[2] / 255);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return [L, Math.hypot(a, bb), Math.atan2(bb, a)];
}

/** Raw (unclipped) linear sRGB of an OKLCH colour. */
function linear(L: number, C: number, h: number): [number, number, number] {
  const a = C * Math.cos(h);
  const b = C * Math.sin(h);
  const l = Math.pow(L + 0.3963377774 * a + 0.2158037573 * b, 3);
  const m = Math.pow(L - 0.1055613458 * a - 0.0638541728 * b, 3);
  const s = Math.pow(L - 0.0894841775 * a - 1.291485548 * b, 3);
  return [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s];
}

/** OKLCH -> sRGB bytes; a colour outside the gamut loses chroma (hue and lightness kept) instead of clipping. */
export function fromOklch(L: number, C: number, h: number): Rgb {
  let lo = 0;
  let hi = C;
  let v = linear(L, C, h);
  const inside = (x: number[]): boolean => x[0] >= -0.0005 && x[0] <= 1.0005 && x[1] >= -0.0005 && x[1] <= 1.0005 && x[2] >= -0.0005 && x[2] <= 1.0005;
  if (!inside(v)) {
    for (let k = 0; k < 18; k++) {
      const mid = (lo + hi) / 2;
      if (inside(linear(L, mid, h))) lo = mid;
      else hi = mid;
    }
    v = linear(L, lo, h);
  }
  const q = (x: number): number => Math.max(0, Math.min(255, Math.round(gam(Math.max(0, Math.min(1, x))) * 255)));
  return [q(v[0]), q(v[1]), q(v[2])];
}

/** The colour territory is painted with: muted, narrower lightness range, same hue. */
export function displayColor(rgb: readonly number[], opts: { role?: DisplayRole; style?: MapStyle } = {}): Rgb {
  const role = opts.role ?? 'nation';
  const f = STYLE_FILL[opts.style ?? 'today'] ?? STYLE_FILL.today;
  const [L, C, h] = toOklch(rgb);
  const L2 = f.lightMid + (L - f.lightMid) * f.lightKeep;
  return fromOklch(L2, C * CHROMA_KEEP[role] * (role === 'own' ? f.ownChroma : f.chroma), h);
}

/** Border colour for a display colour: darker and a little more saturated, still muted. */
export function borderColor(display: readonly number[]): Rgb {
  const [L, C, h] = toOklch(display);
  return fromOklch(L * BORDER_LIGHT, Math.min(BORDER_CHROMA_MAX, Math.max(C * BORDER_CHROMA, C + 0.02)), h);
}

const luma = (c: readonly number[]): number => 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];

/**
 * The calm layer under a nation's fill: the terrain colour pulled towards grey of the same brightness, so terrain
 * still shades the land (forest darker, desert lighter) without competing with the nation's hue. Same maths as the
 * shader (minimap and 2D fallback use this).
 */
export function calmTerrain(terr: readonly number[]): Rgb {
  const y = luma(terr);
  const y2 = (UNDER_MID + (y / 255 - UNDER_MID) * UNDER_LUM) * 255;
  return [y2 + (terr[0] - y) * UNDER_CHROMA, y2 + (terr[1] - y) * UNDER_CHROMA, y2 + (terr[2] - y) * UNDER_CHROMA];
}

/** Nation fill over terrain (minimap, 2D fallback): opaque result of the translucent fill. */
export function paintOver(terr: readonly number[], fill: readonly number[], alpha: number): Rgb {
  const u = calmTerrain(terr);
  return [Math.round(u[0] + (fill[0] - u[0]) * alpha), Math.round(u[1] + (fill[1] - u[1]) * alpha), Math.round(u[2] + (fill[2] - u[2]) * alpha)];
}
