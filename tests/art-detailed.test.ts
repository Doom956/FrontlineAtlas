// The detailed pixel art style (client/art/detailed): every unit bakes at twice the refined pixels, the units are told
// apart by size and silhouette, the owner's colour stays a small mark, there is no black outline, planes bank, the
// effects are lumpy and physical (no clean circles), trails lay a V wake and never streak after a clock jump, and the
// whole style is deterministic.
import { describe, expect, it } from 'vitest';
import { ART_CATEGORIES } from '../src/client/art/artStyle';
import { blobBitmap } from '../src/client/art/detailed/blobs';
import { rasterize, solidCount, type Baked } from '../src/client/art/detailed/bake';
import { craterBitmap } from '../src/client/art/detailed/craters';
import { gridOf } from '../src/client/art/detailed/grid';
import { modelLength, modelSpan, unitModel } from '../src/client/art/detailed/models';
import { chuteBitmap } from '../src/client/art/detailed/paradrop';
import { detailedWakes } from '../src/client/art/detailed/trails';
import { bakeTroopIcon } from '../src/client/art/detailed/troopIcons';
import { detailedUnits } from '../src/client/art/detailed/units';
import { motionParams } from '../src/client/art/motion';
import { styleModule } from '../src/client/art/registry';
import { refined } from '../src/client/art/refined';
import { ALL_MODS, SPRITE_KEYS, type SpriteKey } from '../src/client/art/shared/keys';
import { BLAST_KINDS, type TrailUnit } from '../src/client/art/types';

const OWNER = [64, 160, 255] as const;
const bake = (key: SpriteKey, mods = 0, res = 2, facing = 0, roll = 0): Baked => rasterize(unitModel(key, mods).model, res, facing, { facings: 32, owner: OWNER, roll });

/** Pixels within a few steps of the owner's colour family (the plates, bands and roundels). */
function ownerShare(b: Baked): number {
  let own = 0;
  let solid = 0;
  for (let i = 0; i < b.data.length; i += 4) {
    if (b.data[i + 3] !== 255) continue;
    solid++;
    const r = b.data[i];
    const g = b.data[i + 1];
    const bl = b.data[i + 2];
    // the blue owner reads as clearly bluer than every material (the greys, olives and tans are near neutral)
    if (bl - r > 60 && bl - g > 10) own++;
  }
  return own / Math.max(1, solid);
}

describe('detailed art style', () => {
  it('draws every category itself (no refined stand-ins)', () => {
    const d = styleModule('detailed');
    expect(d.id).toBe('detailed');
    for (const c of ART_CATEGORIES) expect(d[c], c).not.toBe(refined[c]);
  });

  it('bakes every unit, plain and upgraded, at mid and near resolution, and twice the pixels at near', () => {
    for (const key of SPRITE_KEYS) {
      for (const mods of [0, ALL_MODS]) {
        const near = bake(key, mods, 2);
        const mid = bake(key, mods, 1);
        expect(solidCount(near), key).toBeGreaterThan(40);
        expect(solidCount(mid), key).toBeGreaterThan(10);
        // about four times the area in pixels: twice the pixels each way
        expect(solidCount(near) / solidCount(mid), key).toBeGreaterThan(2.6);
      }
    }
  });

  it('tells the ships apart by size: carrier, battleship, cruiser, destroyer; the submarine low and slim', () => {
    const len = (k: SpriteKey): number => modelLength(unitModel(k, 0));
    expect(len('carrier')).toBeGreaterThan(len('battleship'));
    expect(len('battleship')).toBeGreaterThan(len('warship'));
    expect(len('warship')).toBeGreaterThan(len('destroyer'));
    expect(modelSpan(unitModel('battleship', 0))).toBeGreaterThan(modelSpan(unitModel('destroyer', 0)) * 1.6);
    expect(modelSpan(unitModel('submarine', 0))).toBeLessThan(modelSpan(unitModel('warship', 0)));
    // the battleship carries three big turret groups, the destroyer fires twice from one twin mount
    const tp = (k: SpriteKey, i: number) => detailedUnits.turretPoint(k, 0, i, 100, 100, 0, 2);
    const bb = [0, 1, 2].map((i) => tp('battleship', i).x);
    expect(new Set(bb.map((x) => Math.round(x))).size).toBe(3);
    expect(Math.abs(tp('destroyer', 0).x - tp('destroyer', 1).x)).toBeLessThan(1);
    expect(tp('destroyer', 0).x).toBeGreaterThan(100);
  });

  it('tells the tanks and planes apart by size and silhouette', () => {
    const len = (k: SpriteKey): number => modelLength(unitModel(k, 0));
    const span = (k: SpriteKey): number => modelSpan(unitModel(k, 0));
    expect(len('heavyTank')).toBeGreaterThan(len('tankDivision'));
    expect(len('tankDivision')).toBeGreaterThan(len('lightTank'));
    expect(span('heavyTank')).toBeGreaterThan(span('lightTank'));
    expect(span('heavyBomber')).toBeGreaterThan(span('transportPlane'));
    expect(span('transportPlane')).toBeGreaterThan(span('bomber'));
    expect(span('bomber')).toBeGreaterThan(span('groundAttack'));
    expect(span('groundAttack')).toBeGreaterThan(span('fighter'));
    // engines: four on the heavy bomber, two on the bomber and the cargo plane, one on the fighter; jets have none
    expect(unitModel('heavyBomber', 0).props.length).toBe(4);
    expect(unitModel('bomber', 0).props.length).toBe(2);
    expect(unitModel('fighter', 0).props.length).toBe(1);
    expect(unitModel('fighter', ALL_MODS).props.length).toBe(0);
    expect(unitModel('fighter', ALL_MODS).nozzles.length).toBeGreaterThan(0);
    // every unit's map length matches its model
    for (const key of SPRITE_KEYS) expect(detailedUnits.lengthPx(key, 0, 3)).toBeCloseTo(modelLength(unitModel(key, 0)) * 3, 5);
  });

  it('keeps the owner colour a small mark, and draws no black outline', () => {
    for (const key of SPRITE_KEYS) {
      const b = bake(key, 0, 2, 4);
      const share = ownerShare(b);
      expect(share, key).toBeLessThan(0.16);
      if (key !== 'rocket' && key !== 'atomBomb') expect(share, key).toBeGreaterThan(0);
      // the rim round the silhouette is translucent, never an opaque near-black line
      let rim = 0;
      for (let i = 0; i < b.data.length; i += 4) if (b.data[i + 3] > 0 && b.data[i + 3] < 200 && b.data[i] < 20) rim++;
      expect(rim, key).toBeGreaterThan(0);
    }
  });

  it('banks a plane: the span narrows and the picture changes', () => {
    const level = bake('bomber', 0, 2, 8, 0);
    const banked = bake('bomber', 0, 2, 8, 0.7);
    const width = (b: Baked): number => {
      let x0 = b.w;
      let x1 = 0;
      for (let y = 0; y < b.h; y++) for (let x = 0; x < b.w; x++) if (b.data[(y * b.w + x) * 4 + 3] === 255) {
        x0 = Math.min(x0, x);
        x1 = Math.max(x1, x);
      }
      return x1 - x0;
    };
    // flying south (facing 8 of 32), the span lies across the screen
    expect(width(banked)).toBeLessThan(width(level));
  });

  it('is deterministic', () => {
    expect(bake('carrier', ALL_MODS, 2, 5)).toEqual(bake('carrier', ALL_MODS, 2, 5));
    expect(blobBitmap('smoke', 9, 2)).toEqual(blobBitmap('smoke', 9, 2));
    expect(craterBitmap(14, 3)).toEqual(craterBitmap(14, 3));
  });

  it('builds effects from lumpy puffs, never a clean disc', () => {
    for (const kind of ['smoke', 'soot', 'dust', 'spray', 'fire'] as const) {
      const b = blobBitmap(kind, 12, 1, 2);
      // compare with a perfect disc of the same radius: the edge wobbles in and out
      let inside = 0;
      let outside = 0;
      for (let y = 0; y < b.h; y++)
        for (let x = 0; x < b.w; x++) {
          const on = b.data[(y * b.w + x) * 4 + 3] > 0;
          const d = Math.hypot(x - b.ox, y - b.oy);
          if (on && d > 12.5) outside++;
          if (!on && d < 11.5) inside++;
        }
      expect(outside + inside, kind).toBeGreaterThan(6);
    }
    // fire cools from a hot core to a red edge
    const f = blobBitmap('fire', 10, 0, 0);
    const core = f.data[(f.oy * f.w + f.ox) * 4];
    expect(core).toBeGreaterThan(220);
  });

  it('lasts longer with the cinematic preset and supports every blast kind', () => {
    const s = motionParams('subtle', false);
    const c = motionParams('cinematic', false);
    for (const k of BLAST_KINDS) expect(styleModule('detailed').explosions.durationMs(k, s)).toBeLessThan(styleModule('detailed').explosions.durationMs(k, c));
  });

  it('draws craters with a transparent surround and parachutes in the owner colour', () => {
    const c = craterBitmap(20, 2);
    expect(c.data[3]).toBe(0);
    expect(c.data[c.data.length - 1]).toBe(0);
    const p = chuteBitmap([226, 74, 60], 9, 1);
    let red = 0;
    for (let i = 0; i < p.data.length; i += 4) if (p.data[i + 3] === 255 && p.data[i] > p.data[i + 1] + 60) red++;
    expect(red).toBeGreaterThan(8);
  });

  it('bakes troop icons as size + 2 squares on the owner plate', () => {
    for (const kind of ['infantry', 'armor', 'artillery', 'troops'] as const) {
      for (const size of [16, 12]) {
        const b = bakeTroopIcon(kind, OWNER, size);
        expect(b.w).toBe(size + 2);
        expect(b.h).toBe(size + 2);
        // the plate centre row carries the figure (off-white) on the owner's blue
        let figure = 0;
        for (let i = 0; i < b.data.length; i += 4) if (b.data[i + 3] === 255 && b.data[i] > 200 && b.data[i + 1] > 200) figure++;
        expect(figure, `${kind} ${size}`).toBeGreaterThan(3);
      }
    }
  });

  it('lays a V wake behind a moving ship and starts afresh after the clock jumps', () => {
    const rects: [number, number][] = [];
    const ctx = new Proxy({ globalAlpha: 1, fillStyle: '' } as Record<string, unknown>, {
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
      const layer = detailedWakes.createLayer();
      const m = motionParams('lively', false);
      const unit = (x: number): TrailUnit => ({ id: 3, key: 'warship', x, y: 200, tx: x / 14, ty: 200 / 14, angle: 0, half: 32, moving: true, speed: 2.4, turnRate: 0, motion: m });
      const view = (now: number) => ({ ox: 0, oy: 0, zoom: 14, scale: 2, now, viewW: 4000, viewH: 1000, dpr: 1, full: true });
      let x = 100;
      for (let f = 0; f < 120; f++) {
        rects.length = 0;
        x += 0.54;
        layer.frame(ctx, [unit(x)], view(f * 16));
      }
      // behind the stern the foam spreads wider the further back it lies
      const stern = x - 32 * 0.9;
      const near = rects.filter(([rx]) => rx < stern && rx > stern - 12).map(([, ry]) => Math.abs(ry - 200));
      const far = rects.filter(([rx]) => rx < stern - 25).map(([, ry]) => Math.abs(ry - 200));
      expect(near.length).toBeGreaterThan(0);
      expect(far.length).toBeGreaterThan(0);
      expect(Math.max(...far)).toBeGreaterThan(Math.max(...near));
      // a jump in the clock (a hidden view) restarts the trail: nothing is laid between the old and new place
      rects.length = 0;
      layer.frame(ctx, [unit(x + 120)], view(120 * 16 + 5000));
      expect(rects.filter(([rx]) => rx > x + 10 && rx < x + 80).length).toBe(0);
    } finally {
      (globalThis as { Path2D?: unknown }).Path2D = P;
    }
  });

  it('draws art pixels on whole device pixels: twice the refined pixels close up, finer on dense screens', () => {
    expect(gridOf(2, 1)).toMatchObject({ p: 1, res: 2 });
    expect(gridOf(4, 1)).toMatchObject({ p: 2, res: 2 });
    expect(gridOf(1, 2)).toMatchObject({ p: 1, res: 2 });
    expect(gridOf(1, 1)).toMatchObject({ p: 1, res: 1 });
    expect(gridOf(3, 2)).toMatchObject({ p: 3, res: 2 });
  });
});
