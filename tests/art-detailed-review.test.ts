// The detailed art style after its art review: the big ships, the bomber and the cargo plane told apart by shape and
// finish, night paint that still reads over the dark sea, quiet owner colours, smooth turns for big hulls, craters
// without ring outlines, and wakes and contrails that fade out within a few unit lengths instead of drawing lines.
import { describe, expect, it } from 'vitest';
import { rasterize, type Part } from '../src/client/art/detailed/bake';
import { craterBitmap } from '../src/client/art/detailed/craters';
import { facingsFor } from '../src/client/art/detailed/grid';
import { modelLength, modelSpan, unitModel } from '../src/client/art/detailed/models';
import { MATERIALS, ownerTones, UNIT_OWNER_QUIET } from '../src/client/art/detailed/palette';
import { detailedContrails, detailedWakes } from '../src/client/art/detailed/trails';
import { motionParams } from '../src/client/art/motion';
import { hex, luma } from '../src/client/art/shared/colour';
import { M_NIGHT, type SpriteKey } from '../src/client/art/shared/keys';
import type { TrailUnit, TrailView } from '../src/client/art/types';

const len = (k: SpriteKey): number => modelLength(unitModel(k, 0));

/** The fuselage: the widest ellipse on the plane's axis (its half width). */
function fuselage(k: SpriteKey): number {
  let w = 0;
  for (const p of unitModel(k, 0).model.parts as Part[]) if (p.k === 'ell' && p.p[1] === 0 && p.p[2] > 5) w = Math.max(w, p.p[3]);
  return w;
}

/** Rectangles drawn by a trail layer over some frames (a fake canvas that records Path2D and fillRect calls). */
function record(run: (ctx: CanvasRenderingContext2D, rects: [number, number][]) => void): void {
  const rects: [number, number][] = [];
  const ctx = new Proxy({ globalAlpha: 1, fillStyle: '', imageSmoothingEnabled: false } as Record<string, unknown>, {
    get: (o, k) => (k in o ? o[k as string] : k === 'fillRect' ? (x: number, y: number) => rects.push([x, y]) : () => undefined),
    set: (o, k, v) => ((o[k as string] = v), true),
  }) as unknown as CanvasRenderingContext2D;
  const P = (globalThis as { Path2D?: unknown }).Path2D;
  (globalThis as { Path2D?: unknown }).Path2D = class {
    rect(x: number, y: number): void {
      rects.push([x, y]);
    }
  };
  try {
    run(ctx, rects);
  } finally {
    (globalThis as { Path2D?: unknown }).Path2D = P;
  }
}

describe('detailed art style after review', () => {
  it('makes the carrier clearly the biggest hull, the battleship broad, and the submarine no longer than a destroyer', () => {
    expect(len('carrier')).toBeGreaterThan(len('battleship') * 1.15);
    expect(len('battleship')).toBeGreaterThan(len('warship') * 1.25);
    expect(len('submarine')).toBeLessThanOrEqual(len('destroyer'));
    expect(modelSpan(unitModel('battleship', 0))).toBeGreaterThan(modelSpan(unitModel('warship', 0)) * 1.5);
  });

  it('gives the cargo plane a fuselage about twice the bomber width, longer, in a grey finish', () => {
    expect(fuselage('transportPlane')).toBeGreaterThan(fuselage('bomber') * 1.8);
    expect(len('transportPlane')).toBeGreaterThan(len('bomber') * 1.15);
    const mats = new Set((unitModel('transportPlane', 0).model.parts as Part[]).map((p) => p.m));
    expect(mats.has('odplane')).toBe(false);
    // invasion stripes: black and white bands
    expect(mats.has('white') && mats.has('black')).toBe(true);
  });

  it('keeps night paint light enough to read over the dark sea', () => {
    const light = hex(MATERIALS.night[3]);
    expect(luma(light)).toBeGreaterThanOrEqual(luma(hex('#6a737b')));
    // the base tone stands clear of the sea's own colour
    expect(luma(hex(MATERIALS.night[2])) - luma(hex('#1f3242'))).toBeGreaterThan(30);
    const m = unitModel('heavyBomber', M_NIGHT).model.parts as Part[];
    expect(m.some((p) => p.m === 'night')).toBe(true);
  });

  it('quiets the owner colour on unit parts and shades it in several tones', () => {
    const owner = [40, 120, 255];
    const loud = ownerTones(owner);
    const quiet = ownerTones(owner, UNIT_OWNER_QUIET);
    const chroma = (c: readonly number[]): number => Math.max(...c) - Math.min(...c);
    expect(chroma(quiet[2])).toBeLessThan(chroma(loud[2]));
    // a tank's recognition strip shows at least three different owner tones close up
    const b = rasterize(unitModel('tankDivision', 0).model, 2, 3, { facings: 32, owner, roll: 0 });
    const tones = new Set<string>();
    for (let i = 0; i < b.data.length; i += 4) {
      if (b.data[i + 3] !== 255) continue;
      const c = [b.data[i], b.data[i + 1], b.data[i + 2]];
      if (c[2] - c[0] > 60) tones.add(c.join(','));
    }
    expect(tones.size).toBeGreaterThanOrEqual(3);
  });

  it('bakes ships and planes at twice the headings of tanks', () => {
    expect(facingsFor(2, true)).toBe(64);
    expect(facingsFor(1, true)).toBe(32);
    expect(facingsFor(2)).toBe(32);
  });

  it('shapes every crater irregularly, heavier on one side, with no ring outline', () => {
    for (let v = 0; v < 4; v++) {
      const c = craterBitmap(20, v);
      // how far the opaque earth reaches in each of 24 directions
      const reach: number[] = new Array(24).fill(0);
      for (let y = 0; y < c.h; y++)
        for (let x = 0; x < c.w; x++) {
          if (c.data[(y * c.w + x) * 4 + 3] < 200) continue;
          const dx = x - c.ox;
          const dy = (y - c.oy) / 0.84;
          const s = Math.floor(((Math.atan2(dy, dx) + Math.PI) / (Math.PI * 2)) * 24) % 24;
          reach[s] = Math.max(reach[s], Math.hypot(dx, dy));
        }
      const mean = reach.reduce((a, b) => a + b, 0) / 24;
      const sd = Math.sqrt(reach.reduce((a, b) => a + (b - mean) ** 2, 0) / 24);
      expect(sd / mean, `variant ${v}`).toBeGreaterThan(0.08);
    }
    // the four variants are four different shapes
    expect(craterBitmap(20, 0).data).not.toEqual(craterBitmap(20, 1).data);
  });

  it('fades a wake out within about two ship lengths even with the cinematic preset', () => {
    record((ctx, rects) => {
      const layer = detailedWakes.createLayer();
      const m = motionParams('cinematic', false);
      const half = 32;
      const unit = (x: number): TrailUnit => ({ id: 5, key: 'battleship', x, y: 300, tx: x / 14, ty: 300 / 14, angle: 0, half, moving: true, speed: 2.4, turnRate: 0, motion: m });
      const view = (now: number): TrailView => ({ ox: 0, oy: 0, zoom: 14, scale: 2, now, viewW: 6000, viewH: 1000, dpr: 1, full: true });
      let x = 100;
      for (let f = 0; f < 400; f++) {
        rects.length = 0;
        x += 1.2;
        layer.frame(ctx, [unit(x)], view(f * 16));
      }
      const stern = x - half;
      const behind = rects.map(([rx]) => stern - rx).filter((d) => d > 0);
      expect(behind.length).toBeGreaterThan(10);
      // nothing further back than about two and a half ship lengths
      expect(Math.max(...behind)).toBeLessThan(half * 2 * 2.5);
    });
  });

  it('keeps a contrail to a few plane lengths, so a circling plane never draws a ring', () => {
    record((ctx, rects) => {
      const layer = detailedContrails.createLayer();
      const m = motionParams('cinematic', false);
      const half = 11;
      // a plane flying round a circle of 120 px radius (a lap is about 750 px, far more than its trail may be)
      const unit = (a: number): TrailUnit => {
        const x = 500 + Math.cos(a) * 120;
        const y = 400 + Math.sin(a) * 120;
        return { id: 9, key: 'bomber', x, y, tx: x / 14, ty: y / 14, angle: a + Math.PI / 2, half, moving: true, speed: 3, turnRate: 0.6, motion: m };
      };
      const view = (now: number): TrailView => ({ ox: 0, oy: 0, zoom: 14, scale: 2, now, viewW: 1200, viewH: 900, dpr: 1, full: true });
      let a = 0;
      for (let f = 0; f < 600; f++) {
        rects.length = 0;
        a += 0.02;
        layer.frame(ctx, [unit(a)], view(f * 16));
      }
      // the trail covers well under half the circle: count the directions round the centre that have vapour in them
      const seen = new Set<number>();
      for (const [rx, ry] of rects) seen.add(Math.floor(((Math.atan2(ry - 400, rx - 500) + Math.PI) / (Math.PI * 2)) * 36));
      expect(seen.size).toBeGreaterThan(2);
      expect(seen.size).toBeLessThan(18);
    });
  });
});
