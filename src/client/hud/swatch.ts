// Colour chips in the HUD (standings, nation card, diplomacy, tooltips, radial menu) use the same calmed colour the
// map paints the nation with (render/palette.ts displayColor), so a chip and its territory match. Text next to a chip
// keeps the normal text colours, so contrast is unchanged.
import type { Player } from '../../sim/types';
import { isTribe } from '../compat';
import { rgbCss } from '../dom';
import { displayColor, type DisplayRole } from '../render/palette';

const cache = new Map<string, string>();

/** CSS colour of a nation's map shade; `meId` is the human's player id (their own land keeps full chroma). */
export function swatchCss(p: Player, meId: number): string {
  const role: DisplayRole = p.id === meId ? 'own' : isTribe(p) ? 'tribe' : 'nation';
  const key = `${p.color[0]},${p.color[1]},${p.color[2]}|${role}`;
  let v = cache.get(key);
  if (v === undefined) {
    const d = displayColor(p.color, { role });
    v = rgbCss([d[0], d[1], d[2]]);
    if (cache.size > 512) cache.clear();
    cache.set(key, v);
  }
  return v;
}
