// The start page's case-hardened finish (src/client/caseHardened.ts): seeded and repeatable, inside its legibility
// limits for every variant, and a quiet no-op where there is no DOM or canvas.
import { describe, expect, it } from 'vitest';
import { applyCaseHardened, CASE_RECIPES, CASE_VARIANT, drawCaseRegion, type CaseVariant } from '../src/client/caseHardened';

const lin = (c: number): number => {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};
const lum = (d: Uint8ClampedArray, o: number): number => 0.2126 * lin(d[o]) + 0.7152 * lin(d[o + 1]) + 0.0722 * lin(d[o + 2]);

describe('case-hardened finish', () => {
  it('defaults to variant A and has four variants', () => {
    expect(CASE_VARIANT).toBe('A');
    expect(Object.keys(CASE_RECIPES).sort()).toEqual(['A', 'B', 'C', 'D']);
  });

  it('draws the same pixels every time (seeded, no Math.random)', () => {
    const cut = { x: 40, y: 40, w: 60, h: 20, ramp: 'fill' as const };
    const a = drawCaseRegion('A', cut, 1);
    const b = drawCaseRegion('A', cut, 1);
    expect(a.width).toBe(60);
    expect(a.height).toBe(20);
    expect(Array.from(a.data)).toEqual(Array.from(b.data));
    // a different variant is a different picture
    const c = drawCaseRegion('B', cut, 1);
    expect(Array.from(c.data)).not.toEqual(Array.from(a.data));
  });

  it('keeps white text at 4.5:1 on every button pixel and the logo light enough on the dark column', () => {
    for (const v of ['A', 'B', 'C', 'D'] as CaseVariant[]) {
      const fill = drawCaseRegion(v, { x: 100, y: 250, w: 120, h: 40, ramp: 'fill' }, 1);
      const logo = drawCaseRegion(v, { x: 30, y: 24, w: 120, h: 40, ramp: 'logo' }, 1);
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
