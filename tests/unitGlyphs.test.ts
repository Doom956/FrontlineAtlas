// Line glyphs of the mobile units on the map (client/render/unitGlyphs.ts).
import { describe, expect, it } from 'vitest';
import { UNITS } from '../src/sim/config';
import { addGlyph, GLYPHS } from '../src/client/render/unitGlyphs';

describe('unit glyphs', () => {
  it('has a glyph for every unit type, inside the unit square', () => {
    for (const type of Object.keys(UNITS)) {
      const g = GLYPHS[type as keyof typeof GLYPHS];
      expect(g, type).toBeTruthy();
      expect(g.len).toBeGreaterThan(0.5);
      expect(g.len).toBeLessThanOrEqual(1.2);
      expect(g.shapes.length).toBeGreaterThan(0);
      for (const sh of g.shapes) {
        const pts = sh.k === 'ring' ? [sh.p[0] + sh.p[2], sh.p[1] + sh.p[2], sh.p[0] - sh.p[2], sh.p[1] - sh.p[2]] : sh.p;
        if (sh.k === 'poly' || sh.k === 'line') expect(sh.p.length % 2).toBe(0);
        for (const v of pts) expect(Math.abs(v), type).toBeLessThanOrEqual(1.1);
      }
    }
  });

  it('draws into the current path rotated and scaled, and the fill pass takes closed outlines only', () => {
    const calls: string[] = [];
    const pts: number[][] = [];
    const ctx = {
      moveTo: (x: number, y: number) => (calls.push('m'), pts.push([x, y])),
      lineTo: (x: number, y: number) => (calls.push('l'), pts.push([x, y])),
      closePath: () => calls.push('z'),
      arc: () => calls.push('a'),
    } as unknown as CanvasRenderingContext2D;
    addGlyph(ctx, GLYPHS.fighter, 100, 50, 0, 1, 10, false); // pointing down (+y), 10 px per half-length
    expect(pts[0][0]).toBeCloseTo(100, 6);
    expect(pts[0][1]).toBeCloseTo(60, 6); // the nose
    expect(calls.includes('z')).toBe(true);
    calls.length = 0;
    addGlyph(ctx, GLYPHS.bomber, 0, 0, 1, 0, 10, true); // bomber has no closed outline
    expect(calls.length).toBe(0);
    addGlyph(ctx, GLYPHS.atomBomb, 0, 0, 1, 0, 10, false);
    expect(calls.includes('a')).toBe(true);
  });
});
