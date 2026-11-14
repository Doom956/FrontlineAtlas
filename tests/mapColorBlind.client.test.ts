// Real ground (map style C) against the classic map for colour-blind players: the first nation colours, as each map
// paints them over grass, forest and desert, simulated for protanopia, deuteranopia and tritanopia (Machado, Oliveira
// and Fernandes 2009, full severity, in linear RGB). The nations must stay at least as far apart (OKLab distance) as on
// the classic map, the closest pair and on average. Client only.
import { describe, expect, it } from 'vitest';
import { AI_COLORS } from '../src/sim/config';
import { GROUND } from '../src/client/render/ground';
import { displayColor, GROUND_TINT, groundTint, NATION_ALPHA, paintOver } from '../src/client/render/palette';
import { TERRAIN_RGB } from '../src/client/render/terrain';

type M3 = readonly [readonly number[], readonly number[], readonly number[]];
const CVD: Record<string, M3 | null> = {
  normal: null,
  protan: [[0.152286, 1.052583, -0.204868], [0.114503, 0.786281, 0.099216], [-0.003882, -0.048116, 1.051998]],
  deutan: [[0.367322, 0.860646, -0.227968], [0.280085, 0.672501, 0.047413], [-0.01182, 0.04294, 0.968881]],
  tritan: [[1.255528, -0.076749, -0.178779], [-0.078411, 0.930809, 0.147602], [0.004733, 0.691367, 0.3039]],
};
const lin = (c: number): number => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));

/** OKLab of an sRGB byte colour as seen with a colour vision type. */
function seen(rgb: readonly number[], m: M3 | null): [number, number, number] {
  let v = rgb.map((c) => lin(c / 255));
  if (m) v = m.map((row) => Math.max(0, Math.min(1, row[0] * v[0] + row[1] * v[1] + row[2] * v[2])));
  const l = Math.cbrt(0.4122214708 * v[0] + 0.5363325363 * v[1] + 0.0514459929 * v[2]);
  const mm = Math.cbrt(0.2119034982 * v[0] + 0.6806995451 * v[1] + 0.1073969566 * v[2]);
  const s = Math.cbrt(0.0883024619 * v[0] + 0.2817188376 * v[1] + 0.6299787005 * v[2]);
  return [0.2104542553 * l + 0.793617785 * mm - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * mm + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * mm - 0.808675766 * s];
}

/** Closest pair and mean distance between the painted nations. */
function spread(painted: readonly (readonly number[])[], m: M3 | null): { min: number; mean: number } {
  const p = painted.map((c) => seen(c, m));
  let min = Infinity;
  let sum = 0;
  let n = 0;
  for (let i = 0; i < p.length; i++)
    for (let j = i + 1; j < p.length; j++) {
      const d = Math.hypot(p[i][0] - p[j][0], p[i][1] - p[j][1], p[i][2] - p[j][2]);
      min = Math.min(min, d);
      sum += d;
      n++;
    }
  return { min, mean: sum / n };
}

// a game's nations: the first ten nation colours (single player has 8 and you)
const NATIONS = AI_COLORS.slice(0, 10);
// the same three grounds in each map: classic flat colour (index = TerrainId) and real ground's base tone
const GROUNDS: [string, readonly number[], readonly number[]][] = [
  ['grass', TERRAIN_RGB[2], GROUND.grass[2]],
  ['forest', TERRAIN_RGB[3], GROUND.forest[2]],
  ['desert', TERRAIN_RGB[6], GROUND.sand[2]],
];

describe('real ground for colour-blind players', () => {
  for (const [g, classicGround, realGround] of GROUNDS)
    it(`keeps nations on ${g} at least as far apart as the classic map, for every colour vision`, () => {
      const classic = NATIONS.map((c) => paintOver(classicGround, displayColor(c), NATION_ALPHA));
      const far = NATIONS.map((c) => groundTint(realGround, displayColor(c, { style: 'ground' }), GROUND_TINT.far));
      const band = NATIONS.map((c) => groundTint(realGround, displayColor(c, { style: 'ground' }), GROUND_TINT.band));
      for (const [name, m] of Object.entries(CVD)) {
        const a = spread(classic, m);
        // far out (the tint is all you see) and the border band (what tells nations apart close in)
        for (const [what, painted] of [['far tint', far], ['band', band]] as const) {
          const b = spread(painted, m);
          expect(b.min, `${name} ${what} closest pair`).toBeGreaterThanOrEqual(a.min * 0.98);
          expect(b.mean, `${name} ${what} mean`).toBeGreaterThanOrEqual(a.mean);
        }
      }
    });
});
