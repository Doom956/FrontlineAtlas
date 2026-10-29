// Procedural map generation: terrain + resources from seeded fractal value noise.
import type { GameSettings, MapData } from './types';

export function generateMap(settings: GameSettings, rng: () => number): MapData {
  // TODO(WP-A): continents / pangaea / archipelago / highlands, see docs/DESIGN.md section 2.
  throw new Error('generateMap not implemented');
}
