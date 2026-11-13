// The 'refined' art style (client only): the shaded pixel style the game shipped with, reworked per the owner's notes:
// muted military colours (palette.ts, built in OKLCH), a soft dark slate edge instead of a black ink line, every unit
// told apart by size and silhouette, and all the motion of the presets (art/motion.ts): ships bob and rock back when
// they fire and leave a proper V wake with a bow wave, tanks shake and kick up dust, planes bank into turns with
// spinning propellers and a shadow that shows their height, explosions are fire, smoke, debris and dust (no drawn
// rings) with fire and smoke that linger, fresh craters smoke. Pixel art drawn from parts in code: one top-left light,
// 4-tone materials, whole-pixel scaling.
//
// Files: palette.ts (colours), spriteArt.ts (the unit models), spriteBake.ts (the rasterizer), sprites.ts (units on
// the map and in portraits, their motion), recoil.ts (a ship's guns rocking it), troopIcons.ts, trails.ts (wakes and
// contrails), explosions.ts, craters.ts, cannon.ts, paradrop.ts (paratroopers), fxCommon.ts (effect painters).
import type { StyleModule } from '../types';
import { refinedCannon } from './cannon';
import { refinedCraters } from './craters';
import { refinedExplosions } from './explosions';
import { refinedParadrop } from './paradrop';
import { refinedUnits } from './sprites';
import { refinedContrails, refinedWakes } from './trails';
import { refinedTroopIcons } from './troopIcons';

export const refined: StyleModule = {
  id: 'refined',
  ships: refinedUnits,
  land: refinedUnits,
  air: refinedUnits,
  missiles: refinedUnits,
  troopIcons: refinedTroopIcons,
  wakes: refinedWakes,
  contrails: refinedContrails,
  explosions: refinedExplosions,
  craters: refinedCraters,
  cannonFire: refinedCannon,
  paradrop: refinedParadrop,
};
