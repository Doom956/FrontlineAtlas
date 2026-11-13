// The 'detailed' art style (client only): detailed pixel art at about twice the refined style's pixels, in muted real
// military colours (haze and deck greys, teak, olive drab, field grey, aluminium), with no black outline (edges by
// value, a translucent dark rim at most), 3 to 4 tone shading lit from the top left and the same slight 3/4 top-down
// view as the refined set. The owner's colour is only a small plate, band or roundel. Effects (wakes, contrails,
// explosions, craters, cannon fire, parachutes, troop icons) speak the same muted pixel language and share one
// palette and one set of puffs.
//
// Files: palette.ts (materials and the effect palette), grid.ts (the pixel grid: device px per art pixel), bake.ts
// (the rasterizer), models.ts (the unit models), units.ts (units on the map and in portraits), blobs.ts (smoke, soot,
// dust, spray and fire puffs), trails.ts (wakes and contrails), explosions.ts, craters.ts, cannon.ts, paradrop.ts,
// troopIcons.ts.
import type { StyleModule } from '../types';
import { detailedCannon } from './cannon';
import { detailedCraters } from './craters';
import { detailedExplosions } from './explosions';
import { detailedParadrop } from './paradrop';
import { detailedContrails, detailedWakes } from './trails';
import { detailedTroopIcons } from './troopIcons';
import { detailedUnits } from './units';

export const detailed: StyleModule = {
  id: 'detailed',
  ships: detailedUnits,
  land: detailedUnits,
  air: detailedUnits,
  missiles: detailedUnits,
  troopIcons: detailedTroopIcons,
  wakes: detailedWakes,
  contrails: detailedContrails,
  explosions: detailedExplosions,
  craters: detailedCraters,
  cannonFire: detailedCannon,
  paradrop: detailedParadrop,
};
