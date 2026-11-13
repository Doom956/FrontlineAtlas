// The refined art style's effects and propellers (client/art/refined/): fire that billows and turns to soot instead of
// a flat slab, a muted fire palette, dust that spreads unevenly instead of a ring of beads, and propeller discs that
// read at every heading. Pure parts only: a fake context records what would be painted.
import { describe, expect, it } from 'vitest';
import { motionParams } from '../src/client/art/motion';
import { refined } from '../src/client/art/refined';
import { fireBall, FX } from '../src/client/art/refined/fxCommon';
import { propBitmap } from '../src/client/art/refined/sprites';
import type { BlastDraw } from '../src/client/art/types';

interface Fill {
  style: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A context that only records the rectangles filled and their colour. */
function recorder(): { ctx: CanvasRenderingContext2D; fills: Fill[] } {
  const fills: Fill[] = [];
  const state: Record<string, unknown> = { globalAlpha: 1, fillStyle: '#000' };
  const ctx = new Proxy(state, {
    get: (o, k) => (k === 'fillRect' ? (x: number, y: number, w: number, h: number) => fills.push({ style: String(o.fillStyle), x, y, w, h }) : k in o ? o[k as string] : () => undefined),
    set: (o, k, v) => ((o[k as string] = v), true),
  }) as unknown as CanvasRenderingContext2D;
  return { ctx, fills };
}

/** OKLCH chroma of a #rrggbb colour. */
function chroma(hex: string): number {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const lin = c.map((x) => (x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4));
  const l = Math.cbrt(0.4122214708 * lin[0] + 0.5363325363 * lin[1] + 0.0514459929 * lin[2]);
  const m = Math.cbrt(0.2119034982 * lin[0] + 0.6806995451 * lin[1] + 0.1073969566 * lin[2]);
  const s = Math.cbrt(0.0883024619 * lin[0] + 0.2817188376 * lin[1] + 0.6299787005 * lin[2]);
  return Math.hypot(1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s);
}

describe('refined effects: fire', () => {
  it('keeps the fire palette warm but muted, never neon', () => {
    for (const k of ['flame', 'fire', 'fireDeep', 'ember'] as const) expect(chroma(FX[k]), k).toBeLessThan(0.14);
    // and it still reads as fire: clearly warmer than the smoke
    expect(chroma(FX.fire)).toBeGreaterThan(chroma(FX.smoke) * 5);
  });

  it('rolls a big fireball in separately lit billows, not one flat slab', () => {
    const { ctx, fills } = recorder();
    fireBall(ctx, 100, 100, 10, 1, 0.9, 7);
    // the lit tone is laid down in several patches (one per billow plus the core), each its own run of rows
    let patches = 0;
    let prev = '';
    for (const f of fills) {
      if (f.style === FX.flame && prev !== FX.flame) patches++;
      prev = f.style;
    }
    expect(patches).toBeGreaterThanOrEqual(4);
    expect(new Set(fills.map((f) => f.style)).size).toBeGreaterThanOrEqual(4);
  });

  it('turns a cooling fireball to soot from its edges, and a hot one has none', () => {
    const sooty = (heat: number): number => {
      const { ctx, fills } = recorder();
      fireBall(ctx, 100, 100, 8, 1, heat, 3);
      return fills.filter((f) => f.style === FX.soot || f.style === FX.smokeDark).reduce((a, f) => a + f.w * f.h, 0);
    };
    expect(sooty(1)).toBe(0);
    expect(sooty(0.4)).toBeGreaterThan(0);
    expect(sooty(0.15)).toBeGreaterThan(sooty(0.4));
  });
});

describe('refined effects: dust', () => {
  it('rolls the dust skirt out unevenly: its puffs are not spaced round a ring', () => {
    const m = motionParams('lively', false);
    const { ctx, fills } = recorder();
    const b: BlastDraw = { kind: 'missile', x: 400, y: 300, t: 0, ageMs: 250, durMs: refined.explosions.durationMs('missile', m), zoom: 8, scale: 2, rt: 2, seed: 0.37, reduced: false, dpr: 1 };
    refined.explosions.draw(ctx, b, m);
    // the dust rows: their distance from the centre varies widely (a ring of beads would sit at one distance)
    const dust = fills.filter((f) => f.style === FX.dust);
    expect(dust.length).toBeGreaterThan(20);
    const d = dust.map((f) => Math.hypot(f.x + f.w / 2 - 400, (f.y - 300) * 2));
    const mean = d.reduce((a, v) => a + v, 0) / d.length;
    const sd = Math.sqrt(d.reduce((a, v) => a + (v - mean) ** 2, 0) / d.length);
    expect(sd / mean).toBeGreaterThan(0.3);
  });
});

describe('refined propellers', () => {
  it('shows a disc at every heading, not a one-pixel line seen edge-on', () => {
    for (let facing = 0; facing < 16; facing++) {
      const b = propBitmap(2.5, 1, facing, 0, 0);
      let x0 = Infinity;
      let x1 = -Infinity;
      let y0 = Infinity;
      let y1 = -Infinity;
      let firm = 0;
      for (let y = 0; y < b.h; y++)
        for (let x = 0; x < b.w; x++) {
          const a = b.data[(y * b.w + x) * 4 + 3];
          if (a === 0) continue;
          x0 = Math.min(x0, x);
          x1 = Math.max(x1, x);
          y0 = Math.min(y0, y);
          y1 = Math.max(y1, y);
          if (a >= 150) firm++;
        }
      expect(Math.min(x1 - x0, y1 - y0) + 1, `facing ${facing}`).toBeGreaterThanOrEqual(3);
      expect(firm, `facing ${facing}`).toBeGreaterThan(3);
    }
  });

  it('sweeps its blades round from frame to frame', () => {
    const a = propBitmap(3, 1, 4, 0, 0).data;
    const b = propBitmap(3, 1, 4, 0, 1).data;
    expect(Array.from(a)).not.toEqual(Array.from(b));
  });
});
