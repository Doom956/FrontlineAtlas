// The realistic style after its art review: the owner's colour is muted paint (never the raw nation colour, chroma
// capped, still told apart by hue), ships carry it on a deck band and a funnel ring rather than turret roofs, the
// destroyer is clearly smaller than the cruiser, and the trails stay deterministic and cheap. Pictures are checked in
// the art lab.
import { describe, expect, it } from 'vitest';
import { motionParams } from '../src/client/art/motion';
import { realistic } from '../src/client/art/realistic';
import { chromaOf, OWNER_CHROMA, toLab, tonesOf } from '../src/client/art/realistic/model';
import { modelOf } from '../src/client/art/realistic/units';
import type { TrailUnit } from '../src/client/art/types';

const lively = motionParams('lively', false);
const OWNERS: [number, number, number][] = [
  [40, 120, 255],
  [226, 74, 60],
  [60, 200, 90],
  [250, 220, 40],
  [170, 60, 220],
  [20, 20, 24],
  [245, 245, 245],
];

const hue = (c: readonly number[]): number => {
  const [, a, b] = toLab(c);
  return Math.atan2(b, a);
};

describe('realistic owner colour', () => {
  it('mutes every owner colour: chroma capped, lightness kept mid, never the raw colour', () => {
    for (const o of OWNERS) {
      const t = tonesOf(o);
      expect(chromaOf(t.base), String(o)).toBeLessThanOrEqual(OWNER_CHROMA + 0.005);
      expect(chromaOf(t.accent), String(o)).toBeLessThanOrEqual(0.135);
      const L = toLab(t.base)[0];
      expect(L).toBeGreaterThanOrEqual(0.41);
      expect(L).toBeLessThanOrEqual(0.61);
      expect(t.base.map(Math.round)).not.toEqual(o);
      // the ramp runs dark to light
      expect(toLab(t.deep)[0]).toBeLessThan(toLab(t.dark)[0]);
      expect(toLab(t.dark)[0]).toBeLessThan(L);
      expect(toLab(t.light)[0]).toBeGreaterThan(L);
    }
  });

  it('keeps nations apart by hue after muting', () => {
    const vivid = OWNERS.slice(0, 5).map((o) => hue(tonesOf(o).base));
    for (let i = 0; i < vivid.length; i++)
      for (let j = i + 1; j < vivid.length; j++) {
        let d = Math.abs(vivid[i] - vivid[j]);
        if (d > Math.PI) d = Math.PI * 2 - d;
        expect(d, `${OWNERS[i]} vs ${OWNERS[j]}`).toBeGreaterThan(0.35);
      }
  });

  it('marks a warship with a deck band and a funnel ring, not its turret roofs', () => {
    const bb = modelOf('battleship', 0);
    expect(bb.owners?.length).toBe(2);
    // no owner mark sits over the second or the aft turret (x 5.6 and -12)
    for (const o of bb.owners ?? []) for (const x of [5.6, -12]) expect(o.b.x0 > x || o.b.x1 < x, `mark ${o.b.x0}..${o.b.x1}`).toBe(true);
    // the destroyer is clearly shorter and slimmer than the cruiser
    const dd = modelOf('destroyer', 0);
    const cr = modelOf('warship', 0);
    expect(dd.len / cr.len).toBeLessThan(0.75);
    expect((dd.beam ?? 0) / (cr.beam ?? 1)).toBeLessThan(0.6);
  });
});

describe('realistic trails', () => {
  const view = { ox: 0, oy: 0, zoom: 14, scale: 2, now: 0, viewW: 900, viewH: 700, dpr: 1, full: true };
  const calls = (log: string[]): string[] => log.filter((l) => l.startsWith('fill(') || l.startsWith('stroke(') || l.startsWith('lineTo('));
  function recorder(): { ctx: CanvasRenderingContext2D; log: string[] } {
    const log: string[] = [];
    const grad = { addColorStop: (...a: unknown[]) => log.push(`stop(${a.join(',')})`) };
    const state: Record<string, unknown> = { globalAlpha: 1, globalCompositeOperation: 'source-over', lineWidth: 1 };
    const ctx = new Proxy(state, {
      get: (o, k) => {
        if (k in o) return o[k as string];
        if (k === 'createLinearGradient' || k === 'createRadialGradient') return () => grad;
        return (...args: unknown[]) => log.push(`${String(k)}(${args.map((a) => (typeof a === 'number' ? a.toFixed(2) : typeof a)).join(',')})`);
      },
      set: (o, k, v) => {
        o[k as string] = v;
        return true;
      },
    }) as unknown as CanvasRenderingContext2D;
    return { ctx, log };
  }

  it('draws the same wake, contrail and missile smoke for the same frames (deterministic)', () => {
    const run = (key: 'battleship' | 'bomber' | 'rocket', turn: number): string => {
      const layer = key === 'battleship' ? realistic.wakes.createLayer() : realistic.contrails.createLayer();
      let out = '';
      for (let f = 0; f < 90; f++) {
        const a = f * turn;
        const u: TrailUnit = { id: 5, key, x: 0, y: 0, tx: 20 + Math.cos(a) * f * 0.08, ty: 20 + Math.sin(a) * f * 0.08, angle: a, half: 20, moving: true, speed: 3, turnRate: turn * 60, motion: lively };
        const r = recorder();
        layer.frame(r.ctx, [u], { ...view, now: f * 16 });
        out = r.log.join('|');
      }
      return out;
    };
    for (const key of ['battleship', 'bomber', 'rocket'] as const)
      for (const turn of [0, 0.02]) {
        const a = run(key, turn);
        expect(a.length, key).toBeGreaterThan(0);
        expect(run(key, turn), key).toBe(a);
      }
  });

  it('keeps the Kelvin arms a few hull lengths long, however long the ship has sailed', () => {
    const layer = realistic.wakes.createLayer();
    let last = recorder();
    for (let f = 0; f < 240; f++) {
      last = recorder();
      layer.frame(last.ctx, [{ id: 1, key: 'destroyer', x: 0, y: 0, tx: 5 + f * 0.05, ty: 20, angle: 0, half: 20, moving: true, speed: 3, turnRate: 0, motion: lively }], { ...view, now: f * 16 });
    }
    // every point drawn lies within about four hull lengths of the stern (screen px)
    const hull = modelOf('destroyer', 0).len * view.scale;
    const stern = (5 + 239 * 0.05) * view.zoom - hull / 2;
    const xs = calls(last.log)
      .filter((l) => l.startsWith('lineTo('))
      .map((l) => Number(l.slice(7).split(',')[0]));
    expect(xs.length).toBeGreaterThan(0);
    for (const x of xs) expect(stern - x).toBeLessThan(hull * 6.5);
  });
});
