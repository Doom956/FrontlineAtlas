// The start page's case-hardened finish (src/client/caseHardened.ts): two styles in four colour balances, seeded and
// repeatable, inside their legibility limits, and a quiet no-op where there is no DOM or canvas.
import { describe, expect, it } from 'vitest';
import {
  applyCaseHardened,
  CASE_CUTS,
  CASE_STYLE,
  CASE_VARIANT,
  drawCaseRegion,
  STEEL_RECIPES,
  SWIRL_RECIPES,
  type CaseStyle,
  type CaseVariant,
} from '../src/client/caseHardened';

const lin = (c: number): number => {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};
const lum = (d: Uint8ClampedArray, o: number): number => 0.2126 * lin(d[o]) + 0.7152 * lin(d[o + 1]) + 0.0722 * lin(d[o + 2]);
const STYLES: CaseStyle[] = ['swirl', 'steel'];
const VARIANTS: CaseVariant[] = ['A', 'B', 'C', 'D'];

describe('case-hardened finish', () => {
  it('defaults to steel A and has four colour balances per style', () => {
    expect(CASE_STYLE).toBe('steel');
    expect(CASE_VARIANT).toBe('A');
    expect(Object.keys(SWIRL_RECIPES).sort()).toEqual(VARIANTS);
    expect(Object.keys(STEEL_RECIPES).sort()).toEqual(VARIANTS);
  });

  it('draws the same pixels every time (seeded, no Math.random)', () => {
    for (const style of STYLES) {
      const cut = { x: 40, y: 40, w: 60, h: 20, ramp: 'fill' as const };
      const a = drawCaseRegion(style, 'A', cut, 1);
      const b = drawCaseRegion(style, 'A', cut, 1);
      expect(a.width).toBe(60);
      expect(a.height).toBe(20);
      expect(Array.from(a.data)).toEqual(Array.from(b.data));
      // a different balance is a different picture
      const c = drawCaseRegion(style, 'B', cut, 1);
      expect(Array.from(c.data)).not.toEqual(Array.from(a.data));
    }
  });

  it('keeps white text at 4.5:1 on every button pixel and the logo light enough on the dark column', () => {
    for (const style of STYLES) {
      for (const v of VARIANTS) {
        const { logo: lc, fill: fc } = CASE_CUTS[style];
        const fill = drawCaseRegion(style, v, { ...fc, w: 160, h: 48 }, 1);
        const logo = drawCaseRegion(style, v, { ...lc, w: 160, h: 48 }, 1);
        let maxFill = 0;
        let minLogo = 1;
        for (let o = 0; o < fill.data.length; o += 4) maxFill = Math.max(maxFill, lum(fill.data, o));
        for (let o = 0; o < logo.data.length; o += 4) minLogo = Math.min(minLogo, lum(logo.data, o));
        expect(1.05 / (maxFill + 0.05)).toBeGreaterThanOrEqual(4.5);
        // the column renders about #0e131b (luminance 0.0065): 3:1 is the large-text floor for the 60px logo
        expect((minLogo + 0.05) / (0.0065 + 0.05)).toBeGreaterThanOrEqual(3);
      }
    }
  });

  it('keeps the steel base warm gold, never khaki or green', () => {
    for (const v of VARIANTS) {
      // every warm pixel (red and green above blue, clearly coloured) sits below hue 52; most of the area is gold
      const t = drawCaseRegion('steel', v, { x: 0, y: 0, w: 200, h: 120, ramp: 'plain' }, 1);
      let warm = 0;
      let worst = 0;
      for (let o = 0; o < t.data.length; o += 4) {
        const [r, g, b] = [t.data[o], t.data[o + 1], t.data[o + 2]];
        const max = Math.max(r, g, b);
        const min = Math.min(r, g, b);
        if (max - min < 30 || b >= g || b >= r) continue;
        const hue = max === r ? (60 * (g - b)) / (max - min) : 60 * (2 + (b - r) / (max - min));
        warm++;
        worst = Math.max(worst, hue);
      }
      expect(worst).toBeLessThan(52);
      expect(warm).toBeGreaterThan(t.width * t.height * 0.2);
    }
  });

  it('does nothing (and does not throw) without a DOM', () => {
    expect(typeof document).toBe('undefined');
    expect(applyCaseHardened()).toBe(false);
  });
});
