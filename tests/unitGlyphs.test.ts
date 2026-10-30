// Line glyphs of the mobile units on the map (client/render/unitGlyphs.ts).
import { describe, expect, it } from 'vitest';
import { UNITS } from '../src/sim/config';
import { addGlyph, drawTrails, GLYPHS, type Inst } from '../src/client/render/unitGlyphs';

function fakeCtx() {
  const calls: string[] = [];
  const pts: number[][] = [];
  const ctx = {
    beginPath: () => calls.push('b'),
    moveTo: (x: number, y: number) => (calls.push('m'), pts.push([x, y])),
    lineTo: (x: number, y: number) => (calls.push('l'), pts.push([x, y])),
    closePath: () => calls.push('z'),
    arc: () => calls.push('a'),
    fill: () => calls.push('fill'),
    stroke: () => calls.push('stroke'),
  } as unknown as CanvasRenderingContext2D;
  return { ctx, calls, pts };
}

const count = (g: (typeof GLYPHS)[keyof typeof GLYPHS], k: string): number => g.shapes.filter((s) => s.k === k).length;

describe('unit glyphs', () => {
  it('has a glyph for every unit type, inside the unit square', () => {
    for (const type of Object.keys(UNITS)) {
      const g = GLYPHS[type as keyof typeof GLYPHS];
      expect(g, type).toBeTruthy();
      expect(g.len).toBeGreaterThan(0.5);
      expect(g.len).toBeLessThanOrEqual(1.2);
      expect(g.shapes.length).toBeGreaterThan(0);
      expect(g.trailLen).toBeGreaterThan(0);
      for (const sh of g.shapes) {
        const pts = sh.k === 'ring' ? [sh.p[0] + sh.p[2], sh.p[1] + sh.p[2], sh.p[0] - sh.p[2], sh.p[1] - sh.p[2]] : sh.p;
        if (sh.k !== 'ring' && sh.k !== 'dot') expect(sh.p.length % 2).toBe(0);
        for (const v of pts) expect(Math.abs(v), type).toBeLessThanOrEqual(1.1);
      }
    }
  });

  it('keeps the three planes and the three boats apart by their parts', () => {
    // bomber: four engine ticks (open lines besides fuselage and tail), two wing outlines
    expect(count(GLYPHS.bomber, 'poly')).toBe(2);
    expect(count(GLYPHS.bomber, 'line')).toBeGreaterThanOrEqual(6);
    // fighter: one delta outline plus the twin tail prongs
    expect(count(GLYPHS.fighter, 'poly')).toBe(1);
    expect(count(GLYPHS.fighter, 'line')).toBe(3); // centre line + two prongs
    // cargo plane: fuselage + two boxy wings, T-tail
    expect(count(GLYPHS.transportPlane, 'poly')).toBe(3);
    // warship: two round turrets; landing craft: square bow, ramp line, cargo block; trade ship: three containers
    expect(count(GLYPHS.warship, 'ring')).toBe(2);
    expect(count(GLYPHS.transport, 'block')).toBe(1);
    expect(count(GLYPHS.tradeShip, 'block')).toBe(3);
    expect(GLYPHS.warship.len).toBeGreaterThan(GLYPHS.transport.len);
    // the bomber is the biggest plane, the fighter the smallest; the warship is the longest ship
    expect(GLYPHS.bomber.len).toBeGreaterThan(GLYPHS.fighter.len);
    expect(GLYPHS.warship.len).toBeGreaterThanOrEqual(GLYPHS.tradeShip.len);
    // both missiles share the same body, the bomb is larger and has the extra ring
    expect(GLYPHS.atomBomb.len).toBeGreaterThan(GLYPHS.rocket.len);
    expect(count(GLYPHS.atomBomb, 'ring')).toBe(1);
    expect(count(GLYPHS.rocket, 'ring')).toBe(0);
  });

  it('gives missiles a longer trail than planes and every ship a wake', () => {
    expect(GLYPHS.rocket.trail).toBe('missile');
    expect(GLYPHS.atomBomb.trail).toBe('missile');
    for (const t of ['rocket', 'atomBomb'] as const) for (const a of ['fighter', 'bomber', 'transportPlane'] as const) expect(GLYPHS[t].trailLen).toBeGreaterThan(GLYPHS[a].trailLen);
    // faster missile, longer trail
    expect(UNITS.rocket.speed).toBeGreaterThan(UNITS.atomBomb.speed);
    expect(GLYPHS.rocket.trailLen).toBeGreaterThan(GLYPHS.atomBomb.trailLen);
    for (const t of ['warship', 'transport', 'tradeShip'] as const) expect(GLYPHS[t].trail).toBe('wake');
  });

  it('draws into the current path rotated and scaled, and the passes take their own shapes', () => {
    const { ctx, calls, pts } = fakeCtx();
    addGlyph(ctx, GLYPHS.fighter, 100, 50, 0, 1, 10, 'stroke'); // pointing down (+y), 10 px per half-length
    expect(pts[0][0]).toBeCloseTo(100, 6);
    expect(pts[0][1]).toBeCloseTo(60, 6); // the nose
    expect(calls.includes('z')).toBe(true);
    calls.length = 0;
    addGlyph(ctx, GLYPHS.bomber, 0, 0, 1, 0, 10, 'solid'); // bomber has no blocks
    expect(calls.length).toBe(0);
    addGlyph(ctx, GLYPHS.tradeShip, 0, 0, 1, 0, 10, 'solid');
    expect(calls.filter((c) => c === 'z').length).toBe(3);
    calls.length = 0;
    addGlyph(ctx, GLYPHS.warship, 0, 0, 1, 0, 10, 'fill'); // only the hull outline
    expect(calls.filter((c) => c === 'z').length).toBe(1);
    expect(calls.includes('a')).toBe(false);
    addGlyph(ctx, GLYPHS.atomBomb, 0, 0, 1, 0, 10, 'stroke');
    expect(calls.includes('a')).toBe(true);
  });

  it('draws the trails behind the unit: missile contrail points opposite the heading, ships only while moving, far zoom only missiles', () => {
    const { ctx, calls, pts } = fakeCtx();
    const rocket: Inst = { type: 'rocket', x: 100, y: 100, angle: 0, S: 4, moving: true };
    drawTrails(ctx, [rocket], true);
    expect(Math.min(...pts.map((p) => p[0]))).toBeLessThan(100 - 4 * 2 * 3); // tail reaches back (heading +x)
    expect(Math.max(...pts.map((p) => p[0]))).toBeLessThan(100);
    expect(calls.filter((c) => c === 'fill').length).toBe(3); // three fading tiers
    calls.length = 0;
    const ship: Inst = { type: 'warship', x: 0, y: 0, angle: 0, S: 5, moving: false };
    drawTrails(ctx, [ship], true);
    expect(calls.includes('stroke')).toBe(false); // standing still: no wake
    drawTrails(ctx, [{ ...ship, moving: true }], true);
    expect(calls.includes('stroke')).toBe(true);
    calls.length = 0;
    drawTrails(ctx, [{ ...ship, moving: true }, { type: 'fighter', x: 0, y: 0, angle: 0, S: 4 }], false); // far zoom
    expect(calls.includes('fill') || calls.includes('stroke')).toBe(false);
  });
});
