// Minimal line glyphs for the mobile units on the map (client only). Each glyph is a handful of strokes in a unit
// square: nose at +x, half-length 1, lateral axis y. units.ts strokes them in the owner's colour over a thin dark
// under-stroke, so dozens of ships and planes in one area stay readable. The detailed pictures live in icons.ts (HUD).
import type { UnitType } from '../../sim/types';

/**
 * poly: closed outline (also gets a faint fill), line: open polyline, dot: a point (round cap), ring: x, y, radius.
 * Coordinates are [x0, y0, x1, y1, ...] in half-lengths.
 */
export interface Shape {
  k: 'poly' | 'line' | 'dot' | 'ring';
  p: number[];
}
export interface Glyph {
  /** Length on screen relative to the base size of the zoom level. */
  len: number;
  shapes: Shape[];
}

export const GLYPHS: Record<UnitType, Glyph> = {
  // slim hull: pointed bow, flat stern
  tradeShip: {
    len: 0.8,
    shapes: [
      { k: 'poly', p: [-1, -0.34, -1, 0.34, 0.4, 0.34, 1, 0, 0.4, -0.34] },
      { k: 'dot', p: [-0.1, 0] },
    ],
  },
  // short wide hull
  transport: {
    len: 0.85,
    shapes: [{ k: 'poly', p: [-1, -0.46, -1, 0.46, 0.25, 0.46, 1, 0, 0.25, -0.46] }],
  },
  // longer hull with a short line across for the turret
  warship: {
    len: 1.12,
    shapes: [
      { k: 'poly', p: [-1, -0.3, -1, 0.3, 0.5, 0.3, 1, 0, 0.5, -0.3] },
      { k: 'line', p: [0.05, -0.3, 0.05, 0.3] },
    ],
  },
  // small, sharp delta
  fighter: {
    len: 0.8,
    shapes: [{ k: 'poly', p: [1, 0, -0.75, 0.55, -0.35, 0, -0.75, -0.55] }],
  },
  // fuselage, wide swept wings, small tail
  bomber: {
    len: 1.05,
    shapes: [
      { k: 'line', p: [1, 0, -0.9, 0] },
      { k: 'line', p: [-0.45, -1.05, 0.3, 0, -0.45, 1.05] },
      { k: 'line', p: [-1, -0.38, -0.8, 0, -1, 0.38] },
    ],
  },
  // fuselage, straight wings, tail
  transportPlane: {
    len: 1.05,
    shapes: [
      { k: 'line', p: [1, 0, -0.9, 0] },
      { k: 'line', p: [0.1, -0.95, 0.1, 0.95] },
      { k: 'line', p: [-0.85, -0.38, -0.85, 0.38] },
    ],
  },
  // short line with a tiny tail
  rocket: {
    len: 0.7,
    shapes: [
      { k: 'line', p: [1, 0, -0.8, 0] },
      { k: 'line', p: [-1, -0.4, -0.55, 0, -1, 0.4] },
    ],
  },
  // a slightly bigger line with a small ring at the nose
  atomBomb: {
    len: 0.95,
    shapes: [
      { k: 'line', p: [-0.95, 0, 0.1, 0] },
      { k: 'line', p: [-1, -0.38, -0.65, 0, -1, 0.38] },
      { k: 'ring', p: [0.55, 0, 0.4] },
    ],
  },
};

/**
 * Appends a glyph to the current path of ctx, centred at (x, y), rotated by (cos, sin), scaled by s px per half-length.
 * `closedOnly` adds just the closed outlines (for the faint fill).
 */
export function addGlyph(ctx: CanvasRenderingContext2D, g: Glyph, x: number, y: number, cos: number, sin: number, s: number, closedOnly: boolean): void {
  for (const sh of g.shapes) {
    const p = sh.p;
    if (closedOnly && sh.k !== 'poly') continue;
    switch (sh.k) {
      case 'poly':
      case 'line': {
        for (let i = 0; i < p.length; i += 2) {
          const px = x + (p[i] * cos - p[i + 1] * sin) * s;
          const py = y + (p[i] * sin + p[i + 1] * cos) * s;
          if (i === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        }
        if (sh.k === 'poly') ctx.closePath();
        break;
      }
      case 'dot': {
        const px = x + (p[0] * cos - p[1] * sin) * s;
        const py = y + (p[0] * sin + p[1] * cos) * s;
        ctx.moveTo(px, py);
        ctx.lineTo(px + 0.01, py);
        break;
      }
      case 'ring': {
        const px = x + (p[0] * cos - p[1] * sin) * s;
        const py = y + (p[0] * sin + p[1] * cos) * s;
        ctx.moveTo(px + p[2] * s, py);
        ctx.arc(px, py, p[2] * s, 0, Math.PI * 2);
        break;
      }
    }
  }
}
