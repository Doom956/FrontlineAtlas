// The art switch (client only): which art style draws each category of map art, and which motion preset animates it.
//
// Two independent axes, both chosen per category:
//   - ArtStyle: 'refined' (the shaded pixel style), 'detailed' (finer pixel art in muted military colours) or
//     'realistic' (painted top-down miniatures). The style modules live in art/refined, art/detailed, art/realistic and
//     are reached through art/registry.ts (artFor), never imported directly by the renderer.
//   - MotionPreset: 'subtle', 'lively' or 'cinematic'. A style never gets the preset name alone: it gets the numbers
//     derived from it (art/motion.ts motionParams), so every style supports all three without three implementations.
//
// Defaults: the owner's picks (OWNER_PICKS: detailed pixel art, with realistic craters and cannon fire) and 'lively'
// motion. A build can
// override them for whole-game comparison builds:
//   VITE_ART_STYLE=realistic                         every category in one style
//   VITE_ART_STYLE="ships: realistic (subtle motion), land: detailed (lively motion), ..."   the art lab's copied picks
//   VITE_ART_MOTION=cinematic                        every motion category with one preset (or "ships: subtle, ...")
// and the art lab (art lab builds only) sets them at run time with setArtStyle / setMotionPreset.
//
// Read-only for the game: nothing here touches the sim, its hash or multiplayer.

export type ArtStyle = 'refined' | 'detailed' | 'realistic';
export const ART_STYLES: readonly ArtStyle[] = ['refined', 'detailed', 'realistic'];

/**
 * What a style draws, one switch each. Wakes and contrails can be mixed with any ship or plane style; 'paradrop' is the
 * paratroopers (parachutes coming down round a drop point, the parachute mark on a cargo plane).
 */
export type ArtCategory = 'ships' | 'land' | 'air' | 'missiles' | 'troopIcons' | 'explosions' | 'craters' | 'wakes' | 'contrails' | 'cannonFire' | 'paradrop';
export const ART_CATEGORIES: readonly ArtCategory[] = ['ships', 'land', 'air', 'missiles', 'troopIcons', 'explosions', 'craters', 'wakes', 'contrails', 'cannonFire', 'paradrop'];

export type MotionPreset = 'subtle' | 'lively' | 'cinematic';
export const MOTION_PRESETS: readonly MotionPreset[] = ['subtle', 'lively', 'cinematic'];

/**
 * What a motion preset is chosen for. 'ships' animates the ships and their wakes, 'air' the planes, their contrails
 * and the paratroopers they drop, 'missiles' the missiles and their smoke trails; troop icons do not move.
 */
export type MotionCategory = 'ships' | 'land' | 'air' | 'missiles' | 'explosions' | 'craters' | 'cannonFire';
export const MOTION_CATEGORIES: readonly MotionCategory[] = ['ships', 'land', 'air', 'missiles', 'explosions', 'craters', 'cannonFire'];

/** The motion category that animates an art category (wakes: ships; contrails, paradrop: air; null: troop icons stand still). */
export function motionCategoryOf(c: ArtCategory): MotionCategory | null {
  switch (c) {
    case 'wakes':
      return 'ships';
    case 'contrails':
    case 'paradrop':
      return 'air';
    case 'troopIcons':
      return null;
    default:
      return c;
  }
}

/** Plain words for a category (the art lab, the copied picks line). */
export const CATEGORY_LABEL: Record<ArtCategory, string> = {
  ships: 'Ships',
  land: 'Land units',
  air: 'Planes',
  missiles: 'Missiles',
  troopIcons: 'Troop icons',
  explosions: 'Explosions',
  craters: 'Craters',
  wakes: 'Wakes',
  contrails: 'Contrails',
  cannonFire: 'Cannon fire',
  paradrop: 'Paratroopers',
};
export const STYLE_LABEL: Record<ArtStyle, string> = { refined: 'Refined pixel', detailed: 'Detailed pixel', realistic: 'Realistic' };
export const MOTION_LABEL: Record<MotionPreset, string> = { subtle: 'Subtle', lively: 'Lively', cinematic: 'Cinematic' };

export const DEFAULT_STYLE: ArtStyle = 'refined';
export const DEFAULT_MOTION: MotionPreset = 'lively';
/** The owner's picks from the art lab: the look the game starts with. */
export const OWNER_PICKS: Readonly<Record<ArtCategory, ArtStyle>> = {
  ships: 'detailed', wakes: 'detailed', land: 'detailed', air: 'detailed', contrails: 'detailed', paradrop: 'detailed',
  missiles: 'detailed', troopIcons: 'detailed', explosions: 'detailed', craters: 'realistic', cannonFire: 'realistic',
};

export type StylePicks = Record<ArtCategory, ArtStyle>;
export type MotionPicks = Record<MotionCategory, MotionPreset>;

const isStyle = (s: string): s is ArtStyle => (ART_STYLES as readonly string[]).includes(s);
const isMotion = (s: string): s is MotionPreset => (MOTION_PRESETS as readonly string[]).includes(s);
const isCategory = (s: string): s is ArtCategory => (ART_CATEGORIES as readonly string[]).includes(s);
const isMotionCategory = (s: string): s is MotionCategory => (MOTION_CATEGORIES as readonly string[]).includes(s);

export function defaultStylePicks(style: ArtStyle = DEFAULT_STYLE): StylePicks {
  return Object.fromEntries(ART_CATEGORIES.map((c) => [c, style])) as StylePicks;
}
export function defaultMotionPicks(preset: MotionPreset = DEFAULT_MOTION): MotionPicks {
  return Object.fromEntries(MOTION_CATEGORIES.map((c) => [c, preset])) as MotionPicks;
}

/**
 * Reads style picks from text: one style name for every category ("realistic"), or a list of "category: style" pairs
 * separated by commas, each optionally followed by "(preset motion)" (the art lab's "Copy my picks" line). Unknown
 * words are ignored, so a typo falls back to the default instead of breaking the build.
 */
export function parseStylePicks(text: string | undefined | null, base: StylePicks = defaultStylePicks()): StylePicks {
  const out = { ...base };
  const t = (text ?? '').trim().toLowerCase();
  if (!t) return out;
  if (isStyle(t)) return defaultStylePicks(t);
  for (const part of t.split(',')) {
    const m = /^\s*([a-z]+)\s*[:=]\s*([a-z]+)/i.exec(part);
    if (!m) continue;
    const cat = lookupCategory(m[1]);
    if (cat && isStyle(m[2])) out[cat] = m[2];
  }
  return out;
}

/**
 * Reads motion picks from text: one preset for every category ("cinematic"), "category: preset" pairs, or the art lab's
 * picks line ("ships: realistic (subtle motion), ..."): a wakes, contrails or paradrop entry sets the motion of the
 * ships or planes it follows only when they are not listed themselves.
 */
export function parseMotionPicks(text: string | undefined | null, base: MotionPicks = defaultMotionPicks()): MotionPicks {
  const out = { ...base };
  const t = (text ?? '').trim().toLowerCase();
  if (!t) return out;
  if (isMotion(t)) return defaultMotionPicks(t);
  const direct = new Set<MotionCategory>();
  const later: [MotionCategory, MotionPreset][] = [];
  for (const part of t.split(',')) {
    const m = /^\s*([a-z]+)\s*[:=]\s*(?:([a-z]+)\s*\(\s*([a-z]+)\s+motion\s*\)|([a-z]+))/i.exec(part);
    if (!m) continue;
    const cat = lookupCategory(m[1]);
    const preset = (m[3] ?? m[4] ?? '').toLowerCase();
    if (!cat || !isMotion(preset)) continue;
    const mc = motionCategoryOf(cat);
    if (!mc) continue;
    if (mc === cat) {
      out[mc] = preset;
      direct.add(mc);
    } else later.push([mc, preset]);
  }
  for (const [mc, p] of later) if (!direct.has(mc)) out[mc] = p;
  return out;
}

function lookupCategory(word: string): ArtCategory | null {
  const w = word.toLowerCase();
  for (const c of ART_CATEGORIES) if (c.toLowerCase() === w) return c;
  return isCategory(word) ? word : null;
}

/**
 * The picks as one line, e.g. "ships: realistic (subtle motion), land: detailed (lively motion), troopIcons: refined,
 * ...". Wakes, contrails and paradrop carry the motion of what they follow. parseStylePicks and parseMotionPicks read it back.
 */
export function picksLine(styles: StylePicks, motions: MotionPicks): string {
  return ART_CATEGORIES.map((c) => {
    const mc = motionCategoryOf(c);
    return mc ? `${c}: ${styles[c]} (${motions[mc]} motion)` : `${c}: ${styles[c]}`;
  }).join(', ');
}

// ------------------------------------------------------------------------------------------------- current picks

function buildEnv(): { style?: string; motion?: string } {
  try {
    const env = (import.meta as ImportMeta).env;
    return { style: env?.VITE_ART_STYLE, motion: env?.VITE_ART_MOTION };
  } catch {
    return {};
  }
}

const env = buildEnv();
const styles: StylePicks = parseStylePicks(env.style, { ...OWNER_PICKS });
const motions: MotionPicks = parseMotionPicks(env.motion ?? env.style);
let version = 0;

/** The style that draws a category now. */
export function artStyleOf(c: ArtCategory): ArtStyle {
  return styles[c];
}
/** The motion preset of a motion category now. */
export function motionPresetOf(c: MotionCategory): MotionPreset {
  return motions[c];
}
/** The motion preset that animates an art category now (troop icons: the default, they do not move). */
export function motionPresetFor(c: ArtCategory): MotionPreset {
  const mc = motionCategoryOf(c);
  return mc ? motions[mc] : DEFAULT_MOTION;
}
/** Every pick now (copies). */
export function currentStylePicks(): StylePicks {
  return { ...styles };
}
export function currentMotionPicks(): MotionPicks {
  return { ...motions };
}

/** Sets the style of one category, or of every category (art lab and comparison builds). */
export function setArtStyle(c: ArtCategory | 'all', s: ArtStyle): void {
  if (!isStyle(s)) return;
  if (c === 'all') for (const k of ART_CATEGORIES) styles[k] = s;
  else if (isCategory(c)) styles[c] = s;
  version++;
}
/** Sets the motion preset of one motion category, or of every one. */
export function setMotionPreset(c: MotionCategory | 'all', p: MotionPreset): void {
  if (!isMotion(p)) return;
  if (c === 'all') for (const k of MOTION_CATEGORIES) motions[k] = p;
  else if (isMotionCategory(c)) motions[c] = p;
  version++;
}
/** Applies a whole set of picks at once. */
export function applyPicks(s: Partial<StylePicks>, m: Partial<MotionPicks> = {}): void {
  for (const c of ART_CATEGORIES) {
    const v = s[c];
    if (v && isStyle(v)) styles[c] = v;
  }
  for (const c of MOTION_CATEGORIES) {
    const v = m[c];
    if (v && isMotion(v)) motions[c] = v;
  }
  version++;
}

/** Changes whenever a pick changes (caches that hold drawn art, such as HUD portraits, can redraw). */
export function artVersion(): number {
  return version;
}
