// Troop markers (client/render/troopIcons.ts, the refined art in client/art/refined/troopIcons.ts): every kind has its own symbol on the owner plate; an unknown mix is a
// question mark, never the soldier.
import { describe, expect, it } from 'vitest';
import { PLATE } from '../src/client/render/troopIcons';
import { bakeTroopIcon } from '../src/client/art/refined/troopIcons';

const BLUE: [number, number, number] = [64, 160, 255];
function diff(a: Uint8ClampedArray, b: Uint8ClampedArray): number {
  let d = 0;
  for (let i = 0; i < a.length; i += 4) if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2]) d++;
  return d;
}

describe('troop icons', () => {
  it('draws an unknown mix as its own symbol, not the infantry soldier, at both sizes', () => {
    for (const size of [PLATE, 12]) {
      const inf = bakeTroopIcon('infantry', BLUE, size);
      const unk = bakeTroopIcon('troops', BLUE, size);
      const art = bakeTroopIcon('artillery', BLUE, size);
      expect(inf.w).toBe(size + 2);
      expect(diff(inf.data, unk.data)).toBeGreaterThan(size * 2);
      expect(diff(art.data, unk.data)).toBeGreaterThan(size * 2);
    }
  });
});
