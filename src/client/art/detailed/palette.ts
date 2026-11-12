// The detailed style's colours (client only, pure data). Every material is a 4-tone ramp (deep, dark, base, light) that
// holds one hue end to end (built in OKLCH, low chroma): real military finishes, muted, so the owner's colour (a small
// plate, band or roundel) is the one strong colour on a unit. The effects share one physical palette: fire from white
// hot to deep red, smoke from oily black to pale grey, earth, foam and steam.
import { hex, lerpRGB, luma, ownerRamp, type RGB } from '../shared/colour';

/** A 4-tone ramp: deep, dark, base, light (hex). */
export type Ramp = readonly [string, string, string, string];

export const MATERIALS = {
  // ---- ships
  /** haze grey: hulls of warships */
  hull: ['#30363c', '#4e565e', '#707980', '#92999f'],
  /** dark hull band at the waterline, the submarine's casing */
  hullDark: ['#1c2228', '#2f363d', '#464e55', '#60676e'],
  /** steel deck (deck grey) */
  deck: ['#262c31', '#3a4146', '#4f565c', '#666d72'],
  /** teak planking */
  teak: ['#554433', '#78624a', '#987e63', '#b29a81'],
  /** superstructure, a lighter haze grey */
  sup: ['#4e5358', '#747b81', '#9ca3a8', '#bfc5c9'],
  /** gun barrels, mounts, dark fittings */
  gun: ['#101419', '#22272d', '#383e44', '#565b61'],
  /** the submarine's black-grey */
  sub: ['#0a1014', '#171e23', '#272f34', '#3e464c'],
  /** red lead: a merchant's boot topping */
  redlead: ['#47211a', '#67342b', '#82493e', '#9c6459'],
  /** a merchant hull's black */
  merchant: ['#1b1413', '#2a2220', '#3d3231', '#534745'],
  /** a merchant's cream superstructure */
  cream: ['#7e7a72', '#a6a197', '#c9c4b9', '#e5e1d7'],
  /** flight deck */
  flightdeck: ['#1e2225', '#2c3134', '#3b4145', '#4b5155'],
  /** window and canopy glass */
  glass: ['#0a1820', '#1a2b36', '#354b58', '#758996'],
  // ---- land
  olive: ['#272814', '#3d3f25', '#565839', '#727556'],
  tan: ['#54452f', '#796648', '#9c8563', '#b9a485'],
  fieldgrey: ['#1f2527', '#313a3c', '#495254', '#646e70'],
  track: ['#0e0a08', '#1c1714', '#2d2824', '#413c38'],
  // ---- air
  alu: ['#606468', '#82878b', '#a6abb0', '#cdd1d5'],
  odplane: ['#2e2f1e', '#454731', '#5e6046', '#7a7d63'],
  camo: ['#1c281a', '#2e3d2b', '#445540', '#5e6f5a'],
  seagrey: ['#363e44', '#525c64', '#707c85', '#929da6'],
  prublue: ['#334551', '#4b6475', '#678598', '#8ba6b8'],
  night: ['#05080a', '#0e1216', '#1b2025', '#2c3136'],
  // ---- cargo and small parts
  rust: ['#422518', '#623927', '#7c4e39', '#956854'],
  fadedBlue: ['#263541', '#384d5f', '#4e667c', '#6a8094'],
  ochre: ['#5b4a2d', '#80683f', '#a08557', '#b9a17a'],
  brick: ['#492923', '#693c35', '#87544b', '#9d6c63'],
  canvas: ['#4c4839', '#6b6653', '#89836e', '#a7a28d'],
  brass: ['#544627', '#7a663c', '#a0895a', '#c3af86'],
  white: ['#878682', '#b0aea8', '#d3d1cb', '#edebe7'],
  black: ['#050608', '#0b0e11', '#16191c', '#24272a'],
  lifeboat: ['#66442c', '#905f3d', '#b37a53', '#cc9874'],
  hazard: ['#645323', '#8f7835', '#b79c51', '#d4bc79'],
  skin: ['#584332', '#7f624c', '#a0826b', '#bea28c'],
  /** deck and runway paint: a dull white and a dull yellow (flat, no shading range) */
  paint: ['#8e8c84', '#a9a79f', '#c4c2b9', '#d2d0c7'],
  paintYellow: ['#7a6a3a', '#93804a', '#ad9658', '#bba364'],
  /** helmets of troops in a landing ship's well deck */
  helmet: ['#24271a', '#3a3e28', '#545a3b', '#6d7450'],
  /** the sea washing over a submarine's casing (drawn see-through) */
  sea: ['#101c26', '#172634', '#1f3242', '#2a4254'],
  /** foam round a submarine awash */
  foam: ['#6d7f8a', '#93a4ae', '#bccad1', '#dde6ea'],
  /** an exhaust flame (glowing) */
  flame: ['#ae5600', '#e88000', '#ffa84a', '#ffd9a4'],
} as const satisfies Record<string, Ramp>;

export type MaterialId = keyof typeof MATERIALS;

const RAMPS = new Map<string, RGB[]>();
for (const [k, v] of Object.entries(MATERIALS)) RAMPS.set(k, (v as readonly string[]).map(hex));

/** The RGB ramp of a material. */
export function rampOf(m: MaterialId): RGB[] {
  return RAMPS.get(m) ?? RAMPS.get('hull')!;
}

/**
 * The owner's colour as a ramp for the small plates, bands and roundels: the shared ramp (evened toward a mid
 * lightness so very dark or pale nations still show), a little quieter so it sits on the muted metal.
 */
export function ownerTones(owner: readonly number[]): RGB[] {
  const l = luma(owner);
  const quiet = lerpRGB(owner, [l, l, l], 0.1);
  return ownerRamp(quiet);
}

// ------------------------------------------------------------------------------------------------- effects

/** Fire by temperature, hottest first: white hot, yellow, orange, deep orange, red, dark red, ember brown. */
export const FIRE: readonly string[] = ['#fff4d6', '#ffd98a', '#f6a53e', '#dc7426', '#b04a1c', '#7a2c14', '#4a1d10'];
/** Smoke from a fire: oily near black to a sooty mid grey (deep, dark, base, light). */
export const SOOT: Ramp = ['#17151a', '#28252a', '#3b3739', '#55504f'];
/** Smoke as it thins and drifts: warm greys (deep, dark, base, light). */
export const SMOKE: Ramp = ['#3a3836', '#55524e', '#75716b', '#99958e'];
/** Dust and thrown earth (deep, dark, base, light). */
export const DUST: Ramp = ['#4b3d2d', '#6a5843', '#8a775c', '#a89679'];
/** Spray, foam and steam (deep, dark, base, light). */
export const SPRAY: Ramp = ['#7c909c', '#a3b4bd', '#c9d5da', '#e9eff1'];
/** Scorched ground and crater earth, darkest first. */
export const SCORCH: readonly string[] = ['#141110', '#211b18', '#2f2620', '#3f342b', '#54473a', '#6c5d4b', '#86775f'];
/** Debris chunks: dark, mid, lit. */
export const DEBRIS: readonly string[] = ['#141311', '#2b2723', '#4a443d'];
/** Tracer and shell glow. */
export const TRACER: readonly string[] = ['#fff1c2', '#ffc95c', '#e5832f'];
