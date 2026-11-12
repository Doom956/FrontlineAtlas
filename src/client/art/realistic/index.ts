// The 'realistic' art style (client only): painted top-down art, like model miniatures seen from directly above, lit
// from the top left. No pixel look: every picture is painted with canvas paths and gradients (soft light, ambient
// occlusion along inner edges, soft cast shadows) into an atlas at the device pixel ratio, once per heading bucket and
// owner colour, then drawn with a few blits per unit (units.ts). Real military colours (haze grey, teak, olive drab,
// natural metal); the owner's colour is a recognition panel, a roundel, a funnel or a band, never a tint.
//
// Files: paint.ts (brushes), model.ts (the layers of a unit), ships.ts, land.ts, air.ts (the models), units.ts (the
// atlas and the map), puffs.ts (smoke, fire, dust and spray sprites, debris).
import { refined } from '../refined';
import type { StyleModule } from '../types';
import { realisticUnits } from './units';

export const realistic: StyleModule = {
  ...refined,
  id: 'realistic',
  ships: realisticUnits,
  land: realisticUnits,
  air: realisticUnits,
  missiles: realisticUnits,
};
