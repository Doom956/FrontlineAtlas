// The start page's case-hardened finish (src/client/caseHardened.ts): four colour balances of the swirl, seeded and
// repeatable, inside their legibility limits, one balance per visit in turn, and a quiet no-op without a DOM or canvas.
import { describe, expect, it } from 'vitest';
import {
  applyCaseHardened,
  CASE_CUTS,
  CASE_VARIANTS,
  CASE_VISIT_KEY,
  drawCaseRegion,
  SWIRL_RECIPES,
  visitVariant,
} from '../src/client/caseHardened';

const lin = (c: number): number => {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};
const lum = (d: Uint8ClampedArray, o: number): number => 0.2126 * lin(d[o]) + 0.7152 * lin(d[o + 1]) + 0.0722 * lin(d[o + 2]);

function memoryStore(start?: string) {
  const m = new Map<string, string>();
  if (start) m.set(CASE_VISIT_KEY, start);
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), m };
}

describe('case-hardened finish', () => {
  it('has four colour balances', () => {
    expect([...CASE_VARIANTS]).toEqual(['A', 'B', 'C', 'D']);
    expect(Object.keys(SWIRL_RECIPES).sort()).toEqual(['A', 'B', 'C', 'D']);
  });

  it('shows the next balance on each visit, A after D, and remembers it', () => {
    const store = memoryStore();
    const seen = [1, 2, 3, 4, 5].map(() => visitVariant(store));
    expect(seen).toEqual(['A', 'B', 'C', 'D', 'A']);
    expect(store.m.get(CASE_VISIT_KEY)).toBe('A');
    // an unknown stored value starts again at A
    expect(visitVariant(memoryStore('zzz'))).toBe('A');
  });

  it('picks a random balance when storage is missing or refuses', () => {
    expect(visitVariant(null, () => 0)).toBe('A');
    expect(visitVariant(null, () => 0.99)).toBe('D');
    const broken = { getItem: () => { throw new Error('blocked'); }, setItem: () => {} };
    expect(visitVariant(broken, () => 0.5)).toBe('C');
  });

  it('draws the same pixels every time for a balance (seeded)', () => {
    const cut = { x: 40, y: 40, w: 60, h: 20, ramp: 'fill' as const };
    const a = drawCaseRegion('A', cut, 1);
    const b = drawCaseRegion('A', cut, 1);
    expect(a.width).toBe(60);
    expect(a.height).toBe(20);
    expect(Array.from(a.data)).toEqual(Array.from(b.data));
    expect(Array.from(drawCaseRegion('B', cut, 1).data)).not.toEqual(Array.from(a.data));
  });

  it('keeps white text at 4.5:1 on every button pixel and the logo light enough on the dark column', () => {
    for (const v of CASE_VARIANTS) {
      const fill = drawCaseRegion(v, { ...CASE_CUTS.fill, w: 160, h: 48 }, 1);
      const logo = drawCaseRegion(v, { ...CASE_CUTS.logo, w: 160, h: 48 }, 1);
      let maxFill = 0;
      let minLogo = 1;
      for (let o = 0; o < fill.data.length; o += 4) maxFill = Math.max(maxFill, lum(fill.data, o));
      for (let o = 0; o < logo.data.length; o += 4) minLogo = Math.min(minLogo, lum(logo.data, o));
      expect(1.05 / (maxFill + 0.05)).toBeGreaterThanOrEqual(4.5);
      // the column renders about #0e131b (luminance 0.0065): 3:1 is the large-text floor for the 60px logo
      expect((minLogo + 0.05) / (0.0065 + 0.05)).toBeGreaterThanOrEqual(3);
    }
  });

  it('does nothing (and does not throw) without a DOM', () => {
    expect(typeof document).toBe('undefined');
    expect(applyCaseHardened()).toBe(false);
  });
});
