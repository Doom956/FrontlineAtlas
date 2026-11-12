// The refined art style after the art review (client/art/refined/): ships told apart by outline and size rather than by
// owner-coloured roofs, no salt-and-pepper speckle at oblique headings, mines that stay inside the hull, planes told
// apart by span and engines, a real-looking Air Mastery detail, effects without rings or flat discs, craters without
// concentric bands, and troop markers with a toned-down plate and a full-colour rim. Pure parts only (no canvas).
import { describe, expect, it } from 'vitest';
import { motionParams } from '../src/client/art/motion';
import { refined } from '../src/client/art/refined';
import { craterBitmap } from '../src/client/art/refined/craters';
import { FX } from '../src/client/art/refined/fxCommon';
import { ownerDim } from '../src/client/art/refined/palette';
import { buildModel, M_MASTERY, M_NIGHT, M_SPECIAL, type SpriteKey } from '../src/client/art/refined/spriteArt';
import { rasterize, solidCount, type Baked } from '../src/client/art/refined/spriteBake';
import { refinedLength } from '../src/client/art/refined/sprites';
import { bakeTroopIcon } from '../src/client/art/refined/troopIcons';
import { ownerRamp } from '../src/client/art/shared/colour';
import type { BlastDraw } from '../src/client/art/types';

const BLUE: [number, number, number] = [64, 160, 255];
const bake = (key: SpriteKey, mods = 0, facing = 0): Baked => rasterize(buildModel(key, mods), 1, facing, BLUE);
const lum = (b: Baked, x: number, y: number): number => {
  const i = (y * b.w + x) * 4;
  return b.data[i + 3] === 255 ? 0.3 * b.data[i] + 0.59 * b.data[i + 1] + 0.11 * b.data[i + 2] : -1;
};
/** Share of solid pixels much lighter or darker than all four of their neighbours (salt and pepper). */
function speckle(b: Baked): number {
  let n = 0;
  let s = 0;
  for (let y = 1; y < b.h - 1; y++)
    for (let x = 1; x < b.w - 1; x++) {
      const c = lum(b, x, y);
      if (c < 0) continue;
      s++;
      const nb = [lum(b, x - 1, y), lum(b, x + 1, y), lum(b, x, y - 1), lum(b, x, y + 1)];
      if (nb.some((v) => v < 0)) continue;
      if (nb.every((v) => v < c - 30) || nb.every((v) => v > c + 30)) n++;
    }
  return n / Math.max(1, s);
}
/** Pixels of exactly the owner's colour. */
function ownPixels(b: Baked): number {
  const own = ownerRamp(BLUE);
  let n = 0;
  for (let i = 0; i < b.data.length; i += 4) if (b.data[i + 3] === 255 && own.some((c) => c[0] === b.data[i] && c[1] === b.data[i + 1] && c[2] === b.data[i + 2])) n++;
  return n;
}

describe('refined review: ships', () => {
  it('sets the battleship well apart from the plain warship by length and beam', () => {
    expect(refinedLength('battleship') / refinedLength('warship')).toBeGreaterThan(1.5);
    const beam = (k: SpriteKey): number => Math.max(...buildModel(k, 0).parts.filter((p) => p.k === 'poly' && p.m === 'hull').flatMap((p) => p.p.filter((_, i) => i % 2 === 1).map(Math.abs)));
    expect(beam('battleship') / beam('warship')).toBeGreaterThan(1.8);
    // three big dark gunhouses on the battleship, none in the owner's colour
    expect(buildModel('battleship', 0).parts.filter((p) => p.m === 'turretDark' && p.h > 1).length).toBe(3);
  });

  it('keeps the owner colour off turret roofs and towers: a thin band, a few pixels', () => {
    for (const k of ['warship', 'destroyer', 'battleship', 'submarine', 'transport', 'carrier'] as const) {
      const b = bake(k);
      const own = ownPixels(b);
      expect(own, k).toBeGreaterThan(0);
      expect(own / solidCount(b), k).toBeLessThan(0.04);
    }
  });

  it('bakes the big ships without salt-and-pepper speckle at oblique headings', () => {
    for (const k of ['carrier', 'battleship', 'warship', 'transport'] as const) for (const f of [1, 2, 3, 5, 6, 7]) expect(speckle(bake(k, 0, f)), `${k} facing ${f}`).toBeLessThan(0.035);
  });

  it('parks light T-shaped planes on the carrier and puts its island in hull grey hard to starboard', () => {
    const parts = buildModel('carrier', 0).parts;
    expect(parts.filter((p) => p.m === 'white' && p.k === 'seg').length).toBeGreaterThanOrEqual(8);
    const island = parts.filter((p) => p.m === 'sup' && p.k === 'box' && p.h > 1);
    expect(island.length).toBeGreaterThan(0);
    for (const p of island) expect(p.p[1], 'starboard').toBeGreaterThan(1.5);
  });

  it('fills the landing ship with troops on a light floor', () => {
    const parts = buildModel('transport', 0).parts;
    expect(parts.filter((p) => p.m === 'olive' && p.k === 'ell').length).toBeGreaterThanOrEqual(9);
    expect(parts.some((p) => p.m === 'wellDeck')).toBe(true);
  });

  it('draws Naval Mines as small dark mines on rails inside the hull, never black blocks past the stern', () => {
    for (const k of ['warship', 'destroyer', 'battleship'] as const) {
      const extra = buildModel(k, M_SPECIAL).parts.filter((p) => !buildModel(k, 0).parts.some((q) => JSON.stringify(q) === JSON.stringify(p)));
      expect(extra.length, k).toBeGreaterThan(0);
      expect(extra.some((p) => p.m === 'black'), k).toBe(false);
      // the outline does not grow: the mines stay inside the stern
      expect(refinedLength(k, M_SPECIAL), k).toBeCloseTo(refinedLength(k, 0), 5);
      expect(solidCount(bake(k, M_SPECIAL)) - solidCount(bake(k, 0)), k).toBeLessThan(4);
    }
  });
});

describe('refined review: planes', () => {
  const span = (k: SpriteKey): number => Math.max(...buildModel(k, 0).parts.flatMap((p) => (p.k === 'poly' ? p.p.filter((_, i) => i % 2 === 1).map(Math.abs) : [])));

  it('gives the heavy bomber about 1.4 times the bomber span and four separate dark engines', () => {
    expect(span('heavyBomber') / span('bomber')).toBeGreaterThan(1.3);
    expect(buildModel('heavyBomber', 0).parts.filter((p) => p.m === 'gun' && p.k === 'ell' && p.p[2] >= 2.5).length).toBe(4);
    expect(buildModel('bomber', 0).parts.filter((p) => p.m === 'gun' && p.k === 'ell' && p.p[2] >= 2.5).length).toBe(2);
  });

  it('gives the transport plane a fat, lighter fuselage under its wing', () => {
    const parts = buildModel('transportPlane', 0).parts;
    const body = parts.find((p) => p.k === 'ell' && p.p[2] > 10);
    const wing = parts.find((p) => p.k === 'poly' && p.m === 'plane');
    expect(body?.m).toBe('sup');
    expect(body!.p[3]).toBeGreaterThan(3);
    expect(wing!.z).toBeGreaterThanOrEqual(body!.z + body!.h);
  });

  it('shows Air Mastery as a natural metal rudder with a thin brass trim, not a brass tail', () => {
    for (const k of ['bomber', 'heavyBomber', 'groundAttack', 'fighter'] as const) {
      for (const night of [0, M_NIGHT]) {
        const gold = buildModel(k, M_MASTERY | night).parts.filter((p) => p.m === 'gold');
        expect(gold.length, k).toBeGreaterThan(0);
        // only thin trim lines on the fins
        for (const p of gold) expect(p.k === 'seg' && p.h <= 0.5, k).toBe(true);
      }
    }
  });
});

/** A context that only records the rectangles filled and their colour. */
function recorder(): { ctx: CanvasRenderingContext2D; fills: { style: string; x: number; y: number; w: number; h: number }[] } {
  const fills: { style: string; x: number; y: number; w: number; h: number }[] = [];
  const state: Record<string, unknown> = { globalAlpha: 1, fillStyle: '#000' };
  const ctx = new Proxy(state, {
    get: (o, k) => (k === 'fillRect' ? (x: number, y: number, w: number, h: number) => fills.push({ style: String(o.fillStyle), x, y, w, h }) : k in o ? o[k as string] : () => undefined),
    set: (o, k, v) => ((o[k as string] = v), true),
  }) as unknown as CanvasRenderingContext2D;
  return { ctx, fills };
}

describe('refined review: effects', () => {
  const m = motionParams('lively', false);

  it('leaves the foam of a water splash on one side, not as a ring round it', () => {
    for (const seed of [0.11, 0.37, 0.73]) {
      const { ctx, fills } = recorder();
      const dur = refined.explosions.durationMs('splash', m);
      const b: BlastDraw = { kind: 'splash', x: 400, y: 300, t: 0.55, ageMs: dur * 0.55, durMs: dur, zoom: 8, scale: 2, rt: 0, seed, reduced: false, dpr: 1 };
      refined.explosions.draw(ctx, b, m);
      // foam rows on the water around the foot: which of 8 directions they lie in
      const sectors = new Set<number>();
      for (const f of fills.filter((q) => (q.style === FX.foam || q.style === FX.foamDim) && q.y >= 296)) {
        const a = Math.atan2((f.y - 300) * 2, f.x + f.w / 2 - 400);
        if (Math.hypot(f.x + f.w / 2 - 400, (f.y - 300) * 2) > 6) sectors.add(Math.floor(((a + Math.PI) / (Math.PI * 2)) * 8) % 8);
      }
      expect(sectors.size, `seed ${seed}`).toBeLessThan(8);
    }
  });

  it('keeps a missile fireball hot in the middle and free of dark specks', () => {
    const { ctx, fills } = recorder();
    const dur = refined.explosions.durationMs('missile', m);
    const age = 900 * 0.35;
    refined.explosions.draw(ctx, { kind: 'missile', x: 400, y: 300, t: age / dur, ageMs: age, durMs: dur, zoom: 8, scale: 2, rt: 7, seed: 0.37, reduced: false, dpr: 1 }, m);
    const styles = fills.map((f) => f.style);
    expect(styles.includes(FX.flame) || styles.includes(FX.hot)).toBe(true);
    // nothing dark is painted after the fire's hottest tones
    const lastHot = Math.max(styles.lastIndexOf(FX.flame), styles.lastIndexOf(FX.hot));
    expect(styles.slice(lastHot + 1).some((s) => s === FX.soot || s === FX.debris)).toBe(false);
  });

  it('keeps the atom cloud within about three and a half fireball radii above the ground', () => {
    for (const preset of ['subtle', 'lively', 'cinematic'] as const) {
      const mp = motionParams(preset, false);
      const dur = refined.explosions.durationMs('atom', mp);
      let top = Infinity;
      for (let i = 1; i < 20; i++) {
        const { ctx, fills } = recorder();
        const age = (i / 20) * dur;
        refined.explosions.draw(ctx, { kind: 'atom', x: 400, y: 600, t: age / dur, ageMs: age, durMs: dur, zoom: 3, scale: 1, rt: 35, seed: 0.37, reduced: false, dpr: 1 }, mp);
        for (const f of fills) top = Math.min(top, f.y);
      }
      const R = Math.max(18, Math.min(220, 35 * 3 * 0.45));
      expect(600 - top, preset).toBeLessThan(R * 3.6);
    }
  });
});

describe('refined review: craters', () => {
  it('breaks the lip up: it is not one band at one distance from the middle', () => {
    for (const v of [0, 1, 2, 3]) {
      const b = craterBitmap(16, v);
      const cx = Math.floor(b.w / 2);
      const cy = Math.floor(b.h / 2);
      // the lightest pixels (the lit lip): their distance from the middle spreads widely
      const d: number[] = [];
      for (let y = 0; y < b.h; y++)
        for (let x = 0; x < b.w; x++) {
          const i = (y * b.w + x) * 4;
          if (b.data[i + 3] && b.data[i] + b.data[i + 1] + b.data[i + 2] > 380) d.push(Math.hypot(x - cx, (y - cy) / 0.82));
        }
      const mean = d.reduce((a, q) => a + q, 0) / d.length;
      const sd = Math.sqrt(d.reduce((a, q) => a + (q - mean) ** 2, 0) / d.length);
      expect(sd / mean, `variant ${v}`).toBeGreaterThan(0.12);
    }
  });
});

describe('refined review: troop icons', () => {
  it('tones the plate down and keeps the full owner colour for its 1 px rim', () => {
    for (const owner of [BLUE, [220, 60, 50], [240, 210, 60]] as [number, number, number][]) {
      const icon = bakeTroopIcon('infantry', owner, 16);
      const base = ownerRamp(owner)[2];
      const face = ownerDim(base)[1];
      const at = (x: number, y: number): number[] => Array.from(icon.data.slice((y * icon.w + x) * 4, (y * icon.w + x) * 4 + 3));
      // the rim (top edge, left of the cut corner) in the owner's colour, the face inside it toned down
      expect(at(8, 1)).toEqual(base);
      expect(at(3, 8)).toEqual(face);
    }
  });
});
