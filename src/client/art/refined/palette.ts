// The refined style's colours (client only, pure): every material is a 4-tone ramp (deep, dark, base, light) built in
// OKLCH from one base colour, so a ramp keeps its hue end to end and the steps are even in perceived lightness. The
// bases are muted military colours (haze grey, olive drab, dark yellow, panzer grey, natural metal), low in chroma, so
// the units read as painted steel and not as toys; strong colour is kept for the owner's marks and small signal parts.
// The effects share one fire, smoke, dust and foam palette (fxCommon.ts takes its colours from here).
import type { RGB } from '../shared/colour';

/** sRGB (0..255) of an OKLCH colour (L 0..1, C chroma, h degrees), clamped to the sRGB gamut. */
export function oklch(L: number, C: number, h: number): RGB {
  const hr = (h * Math.PI) / 180;
  const a = C * Math.cos(hr);
  const b = C * Math.sin(hr);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const lin = [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s];
  return lin.map((x) => {
    const v = x <= 0.0031308 ? 12.92 * x : 1.055 * Math.max(0, x) ** (1 / 2.4) - 0.055;
    return Math.round(Math.max(0, Math.min(1, v)) * 255);
  }) as RGB;
}

/** CSS hex of an RGB triple. */
export function hexOf(c: readonly number[]): string {
  return `#${((1 << 24) | (c[0] << 16) | (c[1] << 8) | c[2]).toString(16).slice(1)}`;
}

/**
 * A material ramp from its base (L, C, h): deep and dark a fifth and a tenth of the lightness range below, light a little
 * above; chroma eases off toward both ends (dark paint and sunlit paint both look greyer than the mid tone).
 */
export function ramp(L: number, C: number, h: number, step = 0.1): RGB[] {
  return [oklch(L - step * 2.05, C * 0.7, h), oklch(L - step, C * 0.88, h), oklch(L, C, h), oklch(L + step * 0.95, C * 0.78, h)];
}

/** Base colours of the materials (OKLCH L, C, h; optional lightness step). */
const BASES = {
  // ships: haze grey hull and turrets, a lighter superstructure, dark steel guns, a teak or steel deck
  hull: [0.6, 0.014, 245],
  turret: [0.64, 0.012, 245],
  // the battleship's big gunhouses: dark gun grey, heavier than the hull
  turretDark: [0.49, 0.01, 245, 0.09],
  sup: [0.73, 0.011, 245, 0.085],
  deck: [0.53, 0.036, 68, 0.08],
  deckGrey: [0.47, 0.01, 245, 0.08],
  gun: [0.4, 0.01, 245, 0.085],
  // tracks and wheels
  tread: [0.36, 0.006, 80, 0.085],
  rubber: [0.3, 0.004, 80, 0.07],
  // tanks: olive drab (medium), dark yellow (light), panzer grey (heavy)
  olive: [0.5, 0.046, 118],
  sand: [0.66, 0.055, 84],
  steel: [0.46, 0.012, 225],
  // planes: neutral grey, natural metal, a green ground-attack scheme, night black
  plane: [0.66, 0.012, 232],
  metal: [0.75, 0.008, 232, 0.085],
  camo: [0.5, 0.042, 138],
  night: [0.32, 0.01, 255, 0.075],
  // navy odds and ends
  sub: [0.38, 0.012, 232, 0.08],
  tarmac: [0.42, 0.008, 245, 0.07],
  // a merchant's 'black' hull, lifted to a dark blue-grey so it reads as paint and not as an ink outline
  hullBlack: [0.38, 0.02, 250, 0.08],
  rust: [0.44, 0.075, 35],
  glass: [0.48, 0.035, 225, 0.09],
  white: [0.85, 0.012, 95, 0.075],
  red: [0.5, 0.11, 30],
  gold: [0.68, 0.075, 85],
  yellow: [0.76, 0.1, 95, 0.08],
  black: [0.26, 0.006, 250, 0.065],
  teal: [0.53, 0.045, 190],
  mustard: [0.63, 0.075, 80],
  navy: [0.44, 0.05, 255],
  brick: [0.48, 0.07, 38],
  khaki: [0.54, 0.04, 108, 0.085],
  canvas: [0.58, 0.035, 98, 0.085],
  // a landing ship's well deck: light khaki, so the troops' helmets stand out on it
  wellDeck: [0.68, 0.035, 92, 0.08],
  foam: [0.92, 0.008, 230, 0.05],
  // the map's sea is OKLCH L 0.26 (open) to 0.39 (shelf), hue 230 to 246
  sea: [0.31, 0.035, 238, 0.04],
  flame: [0.8, 0.13, 70, 0.08],
  skin: [0.62, 0.06, 55],
} as const satisfies Record<string, readonly number[]>;

export type BaseMat = keyof typeof BASES;

/** Every material's ramp (deep, dark, base, light). */
export const RAMPS: Record<BaseMat, RGB[]> = Object.fromEntries(Object.entries(BASES).map(([k, b]) => [k, ramp(b[0], b[1], b[2], b[3] ?? 0.1)])) as Record<BaseMat, RGB[]>;

/** The 1 px edge round a sprite on its shadow side: dark slate, not black. */
export const EDGE: RGB = oklch(0.3, 0.012, 245);
/** The shadow-side edge of planes and missiles: a step darker, so they hold their outline over light ground. */
export const AIR_EDGE: RGB = oklch(0.245, 0.012, 245);

/** Painted marks (flight deck lines) and troop helmets: fixed colours, not from a part's ramp. */
export const PAINT: RGB = oklch(0.86, 0.01, 95);
export const HELMET: RGB = oklch(0.5, 0.04, 115);

/**
 * The owner colour toned down for large areas (the plate under a tank): the same hue, darker and greyer, so it reads as
 * the owner's at a glance without a candy-bright slab under every vehicle. Two tones: rim, face.
 */
export function ownerDim(base: readonly number[]): RGB[] {
  const mix = (t: number, g: number): RGB => [Math.round(base[0] + (g - base[0]) * t), Math.round(base[1] + (g - base[1]) * t), Math.round(base[2] + (g - base[2]) * t)];
  // toward a dark neutral (most of the way for the rim, less for the face)
  return [mix(0.62, 34), mix(0.52, 38), mix(0.34, 48), mix(0.22, 70)];
}

// ------------------------------------------------------------------------------------------------- effects

/**
 * One palette for every battle effect (explosions, cannon fire, craters, missiles' exhaust): fire from white-hot to
 * ember, smoke from soot to light ash, earth and dust, water foam. Muted and warm, never neon.
 */
export const FX = {
  hot: hexOf(oklch(0.96, 0.04, 95)),
  flame: hexOf(oklch(0.86, 0.11, 82)),
  fire: hexOf(oklch(0.73, 0.135, 60)),
  fireDeep: hexOf(oklch(0.58, 0.13, 42)),
  ember: hexOf(oklch(0.42, 0.095, 35)),
  soot: hexOf(oklch(0.27, 0.008, 60)),
  smokeDark: hexOf(oklch(0.36, 0.008, 60)),
  smoke: hexOf(oklch(0.48, 0.008, 70)),
  smokeLight: hexOf(oklch(0.62, 0.008, 75)),
  ash: hexOf(oklch(0.74, 0.008, 80)),
  dustDark: hexOf(oklch(0.46, 0.03, 70)),
  dust: hexOf(oklch(0.6, 0.035, 75)),
  dustLight: hexOf(oklch(0.72, 0.03, 80)),
  debris: hexOf(oklch(0.25, 0.01, 60)),
  foam: hexOf(oklch(0.95, 0.008, 230)),
  foamDim: hexOf(oklch(0.83, 0.02, 230)),
  water: hexOf(oklch(0.62, 0.035, 235)),
} as const;
