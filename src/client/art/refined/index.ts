// The 'refined' art style (client only): the shaded pixel style the game shipped with, to be improved per the owner's
// notes (less cartoonish, more detail, ships and planes easy to tell apart, wakes, banking planes with propellers,
// less cartoonish explosions and craters). Pixel art drawn from rectangles in code: one top-left light, 4-tone
// materials, a 1 px dark outline, whole-pixel scaling.
//
// Files: spriteArt.ts (the unit models), spriteBake.ts (the rasterizer), sprites.ts (units on the map and in
// portraits), troopIcons.ts, trails.ts (wakes and contrails), explosions.ts, craters.ts, cannon.ts, paradrop.ts (paratroopers), fxCommon.ts.
//
// TODO(refined) motion presets (art/motion.ts): durations and lengths already scale (blastTime, craterLife,
// flashTime, shellArc, wakeLength, wakeSpread, contrailLife, missileTrailLife); the idle motion is not drawn yet
// (bob, banking, propellers, tread dust, turret sway, smoke linger, lingering fire, crater smoke, recoil).
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
