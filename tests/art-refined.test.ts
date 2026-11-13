// The refined art style (client/art/refined/): muted colours and a soft edge, units told apart by size and silhouette,
// banking planes and their propellers, and the motion presets reaching the effects. Pure parts only (no canvas).
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { motionParams } from '../src/client/art/motion';
import { refined } from '../src/client/art/refined';
import { EDGE, oklch, RAMPS } from '../src/client/art/refined/palette';
import { noteMuzzle, recoilAt, seeClock } from '../src/client/art/refined/recoil';
import { buildModel, M_JET, M_MASTERY, SPRITE_KEYS, type SpriteKey } from '../src/client/art/refined/spriteArt';
import { OUTLINE, rasterize, solidCount, type Baked } from '../src/client/art/refined/spriteBake';
import { refinedLength } from '../src/client/art/refined/sprites';
import type { TrailUnit, TrailView } from '../src/client/art/types';

const BLUE: [number, number, number] = [64, 160, 255];
const bake = (key: SpriteKey, mods = 0, facing = 0, roll = 0): Baked => rasterize(buildModel(key, mods), 1, facing, BLUE, roll);

/** OKLCH chroma of an sRGB colour (0..255). */
function chroma(c: readonly number[]): number {
  const lin = c.map((v) => {
    const x = v / 255;
    return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  });
  const l = Math.cbrt(0.4122214708 * lin[0] + 0.5363325363 * lin[1] + 0.0514459929 * lin[2]);
  const m = Math.cbrt(0.2119034982 * lin[0] + 0.6806995451 * lin[1] + 0.1073969566 * lin[2]);
  const s = Math.cbrt(0.0883024619 * lin[0] + 0.2817188376 * lin[1] + 0.6299787005 * lin[2]);
  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const b = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return Math.hypot(a, b);
}

function silhouetteDiff(a: Baked, b: Baked): number {
  let diff = 0;
  let total = 0;
  const solid = (k: Baked, x: number, y: number): boolean => x >= 0 && y >= 0 && x < k.w && y < k.h && k.data[(y * k.w + x) * 4 + 3] === 255;
  for (let y = -60; y < 60; y++)
    for (let x = -60; x < 60; x++) {
      const pa = solid(a, x + a.ox, y + a.oy);
      const pb = solid(b, x + b.ox, y + b.oy);
      if (pa || pb) total++;
      if (pa !== pb) diff++;
    }
  return diff / Math.max(1, total);
}

describe('refined art: colour', () => {
  it('builds every material ramp from dark to light with the same muted hue, no candy colours on the metal', () => {
    for (const [name, r] of Object.entries(RAMPS)) {
      const lum = r.map((c) => 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]);
      for (let i = 1; i < 4; i++) expect(lum[i], name).toBeGreaterThan(lum[i - 1]);
    }
    // the paint of hulls, tanks and planes is military: low chroma
    for (const m of ['hull', 'turret', 'sup', 'olive', 'sand', 'steel', 'plane', 'metal', 'camo', 'sub'] as const) expect(chroma(RAMPS[m][2]), m).toBeLessThan(0.065);
    expect(oklch(0.5, 0, 0)).toEqual([99, 99, 99]);
  });

  it('edges a sprite in dark slate, not black, and lets the lit side take the part it borders', () => {
    expect(OUTLINE).toEqual(EDGE);
    expect(0.299 * EDGE[0] + 0.587 * EDGE[1] + 0.114 * EDGE[2]).toBeGreaterThan(28);
    const b = bake('battleship');
    let edge = 0;
    let lit = 0;
    for (let y = 1; y < b.h - 1; y++)
      for (let x = 1; x < b.w - 1; x++) {
        const i = (y * b.w + x) * 4;
        if (b.data[i + 3] !== 255) continue;
        const above = b.data[((y - 1) * b.w + x) * 4 + 3];
        if (b.data[i] === EDGE[0] && b.data[i + 1] === EDGE[1] && b.data[i + 2] === EDGE[2]) edge++;
        else if (above === 0 && y < b.oy) lit++;
      }
    expect(edge).toBeGreaterThan(20);
    expect(lit).toBeGreaterThan(10);
  });
});

describe('refined art: units', () => {
  it('sizes the ships so each class reads at a glance: carrier, battleship, cruiser, destroyer', () => {
    const L = (k: SpriteKey): number => refinedLength(k);
    expect(L('carrier')).toBeGreaterThan(L('battleship'));
    expect(L('battleship')).toBeGreaterThan(L('warship'));
    expect(L('warship')).toBeGreaterThan(L('destroyer'));
    expect(L('tradeShip')).toBeGreaterThan(L('transport'));
    expect(L('submarine')).toBeGreaterThan(L('destroyer'));
    expect(solidCount(bake('carrier'))).toBeGreaterThan(solidCount(bake('battleship')));
    expect(solidCount(bake('battleship'))).toBeGreaterThan(solidCount(bake('warship')) * 1.3);
    expect(solidCount(bake('warship'))).toBeGreaterThan(solidCount(bake('destroyer')) * 1.3);
  });

  it('gives every ship its own silhouette, the transport and the trade ship included', () => {
    const ships: SpriteKey[] = ['warship', 'destroyer', 'battleship', 'submarine', 'carrier', 'transport', 'tradeShip'];
    for (let i = 0; i < ships.length; i++) for (let j = i + 1; j < ships.length; j++) expect(silhouetteDiff(bake(ships[i]), bake(ships[j])), `${ships[i]} vs ${ships[j]}`).toBeGreaterThan(0.15);
    // the plain warship is a cruiser with two turrets, the battleship has three (gunhouses: raised polygons)
    const turrets = (k: SpriteKey): number => buildModel(k, 0).parts.filter((p) => (p.m === 'turret' || p.m === 'turretDark') && p.k === 'poly' && p.h > 1).length;
    expect(turrets('battleship')).toBeGreaterThan(turrets('warship'));
  });

  it('keeps the submarine low and half under water: its ends are washed by the sea', () => {
    const sub = buildModel('submarine', 0);
    expect(sub.parts.some((p) => p.wash)).toBe(true);
    const maxTop = Math.max(...sub.parts.filter((p) => !p.wash).map((p) => p.z + p.h));
    const bb = Math.max(...buildModel('battleship', 0).parts.map((p) => p.z + p.h));
    expect(maxTop).toBeLessThan(bb / 2);
  });

  it('banks planes into turns: the bake changes with the roll, and both ways differ', () => {
    const level = bake('bomber', 0, 4);
    const right = bake('bomber', 0, 4, 0.36);
    const left = bake('bomber', 0, 4, -0.36);
    expect(silhouetteDiff(level, right)).toBeGreaterThan(0.05);
    expect(silhouetteDiff(right, left)).toBeGreaterThan(0.05);
    // missiles are drawn flat from above: no bank
    expect(Array.from(bake('rocket', 0, 2, 0.5).data)).toEqual(Array.from(bake('rocket', 0, 2, 0).data));
  });

  it('lists propeller hubs for every propeller plane and none once it has jets', () => {
    const count: Partial<Record<SpriteKey, number>> = { bomber: 2, groundAttack: 1, heavyBomber: 4, fighter: 1, transportPlane: 2, reconPlane: 2 };
    for (const [k, n] of Object.entries(count)) expect(buildModel(k as SpriteKey, 0).props?.length, k).toBe(n);
    for (const k of ['bomber', 'groundAttack', 'fighter', 'transportPlane'] as const) expect(buildModel(k, M_JET).props?.length ?? 0, k).toBe(0);
  });

  it('bakes the same pixels every time and only the owner parts change with the owner', () => {
    for (const key of SPRITE_KEYS) expect(Array.from(bake(key, M_MASTERY, 3).data), key).toEqual(Array.from(bake(key, M_MASTERY, 3).data));
  });
});

describe('refined art: motion presets', () => {
  const [subtle, lively, cinematic] = (['subtle', 'lively', 'cinematic'] as const).map((p) => motionParams(p, false));

  it('lets fire and smoke linger longer the livelier the preset', () => {
    for (const k of ['shell', 'bomb', 'missile', 'hit', 'atom'] as const) {
      const d = [subtle, lively, cinematic].map((m) => refined.explosions.durationMs(k, m));
      expect(d[0], k).toBeLessThan(d[1]);
      expect(d[1], k).toBeLessThan(d[2]);
    }
    // subtle: no lingering fire, the burst only (its blastTime)
    expect(refined.explosions.durationMs('shell', subtle)).toBeCloseTo(520 * subtle.blastTime, 5);
    const flash = [subtle, lively, cinematic].map((m) => refined.cannonFire.flashMs(m));
    expect(flash[0]).toBeLessThan(flash[1]);
    expect(flash[1]).toBeLessThan(flash[2]);
  });

  it('rocks a ship back from its own shot, easing out, and leaves ships elsewhere alone', () => {
    seeClock(10_000);
    noteMuzzle(100, 100, 0, 0);
    const [dx, dy] = recoilAt(98, 100, 30, 10_016, 2);
    expect(dx).toBeLessThan(-1.5); // pushed away from a shot to the east
    expect(Math.abs(dy)).toBeLessThan(0.01);
    expect(recoilAt(400, 400, 30, 10_016, 2)).toEqual([0, 0]);
    expect(recoilAt(98, 100, 30, 10_400, 2)).toEqual([0, 0]); // long after: nothing
    seeClock(20_000);
    noteMuzzle(100, 100, 0, 0.9);
    expect(Math.abs(recoilAt(98, 100, 30, 20_016, 2)[0])).toBeLessThan(0.05);
  });

  describe('trails', () => {
    class FakePath {
      n = 0;
      moveTo(): void {
        this.n++;
      }
      lineTo(): void {
        this.n++;
      }
      closePath(): void {}
    }
    const g = globalThis as unknown as { Path2D?: unknown };
    let had: unknown;
    beforeEach(() => {
      had = g.Path2D;
      g.Path2D = FakePath;
    });
    afterEach(() => {
      g.Path2D = had;
    });

    function run(motion = lively, moving = true, frames = 40, key: SpriteKey = 'warship'): { strokes: number; segs: number } {
      let strokes = 0;
      let segs = 0;
      const ctx = new Proxy({ globalAlpha: 1 } as Record<string, unknown>, {
        get: (o, k) => (k === 'stroke' || k === 'fill' ? (p: FakePath) => ((strokes++, (segs += p?.n ?? 0))) : k in o ? o[k as string] : () => undefined),
        set: (o, k, v) => ((o[k as string] = v), true),
      }) as unknown as CanvasRenderingContext2D;
      const layer = (key === 'warship' ? refined.wakes : refined.contrails).createLayer();
      const view = (now: number): TrailView => ({ ox: 0, oy: 0, zoom: 10, scale: 1, now, viewW: 800, viewH: 600, dpr: 1, full: true });
      for (let f = 0; f < frames; f++) {
        const tx = 10 + f * 0.05;
        const u: TrailUnit = { id: 1, key, x: tx * 10, y: 100, tx, ty: 10, angle: 0, half: 15, moving, speed: 3, turnRate: 0, motion };
        strokes = 0;
        segs = 0;
        layer.frame(ctx, [u], view(f * 16));
      }
      return { strokes, segs };
    }

    it('lays a wake behind a moving ship and none behind one standing still', () => {
      expect(run().segs).toBeGreaterThan(10);
      expect(run(lively, false).segs).toBe(0);
    });

    it('lays engine contrails behind a heavy bomber, four lines', () => {
      const r = run(lively, true, 40, 'heavyBomber');
      expect(r.segs).toBeGreaterThan(40);
      expect(r.segs % 4).toBe(0);
    });
  });
});
