// The art switch's lookup (client only): the style module that draws an art category now (art/artStyle.ts picks), and
// the motion numbers it animates with. The renderer, the HUD portraits, the troop pills and the battle effects reach
// the art only through here; the art lab reaches each style module directly (styleModule).
import { artStyleOf, motionPresetOf, type ArtCategory, type ArtStyle, type MotionCategory, type MotionPreset } from './artStyle';
import { detailed } from './detailed';
import { motionParams, type MotionParams } from './motion';
import { realistic } from './realistic';
import { refined } from './refined';
import type { StyleModule } from './types';

const MODULES: Record<ArtStyle, StyleModule> = { refined, detailed, realistic };

/** The module of a style. */
export function styleModule(s: ArtStyle): StyleModule {
  return MODULES[s] ?? refined;
}

/** What draws an art category now, e.g. artFor('ships').drawUnit(...). */
export function artFor<C extends ArtCategory>(c: C): StyleModule[C] {
  return styleModule(artStyleOf(c))[c];
}

let reduced: boolean | null = null;
/** The motion numbers of a preset, honouring prefers-reduced-motion (read once). */
export function motionOf(p: MotionPreset): MotionParams {
  if (reduced === null) reduced = motionParams('lively').reduced;
  return motionParams(p, reduced);
}

/** The motion numbers a motion category animates with now. */
export function motionFor(c: MotionCategory): MotionParams {
  return motionOf(motionPresetOf(c));
}
