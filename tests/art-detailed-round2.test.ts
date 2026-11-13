// The detailed art style, round two: damaged ships that burn (a wisp, then fires and dark smoke, then a heavy column
// and a list), smoke that follows the unit along its course, flame tongues and foam patches, crater fires that die
// down (longer for bigger blasts), the atom bomb's blast zone (wide, scorched, no ring) and the muzzle flash.
import { describe, expect, it } from 'vitest';
import { blobBitmap, flameBitmap, foamBitmap, flameCode } from '../src/client/art/detailed/blobs';
import { puffOf, RISE, WIND_X, type SmokeSource } from '../src/client/art/detailed/burning';
import { BARRELS, FLASH_FIRE_MS, tongueAt } from '../src/client/art/detailed/cannon';
import { blastZoneBitmap, burnShare, craterBitmap, fireClock, sizeClass, ZONE } from '../src/client/art/detailed/craters';
import { burnOf, hitSpot, listOf } from '../src/client/art/detailed/damage';
import { modelLength, modelSpan, unitModel } from '../src/client/art/detailed/models';
import { FIRE, SPRAY } from '../src/client/art/detailed/palette';
import { motionParams } from '../src/client/art/motion';
import { styleModule } from '../src/client/art/registry';
import { hex } from '../src/client/art/shared/colour';
import type { RGBABitmap } from '../src/client/art/shared/atlas';

const lively = motionParams('lively', false);
const subtle = motionParams('subtle', false);
const cinematic = motionParams('cinematic', false);

const luma = (d: Uint8ClampedArray, o: number): number => 0.3 * d[o] + 0.59 * d[o + 1] + 0.11 * d[o + 2];
function solid(b: RGBABitmap): number {
  let n = 0;
  for (let i = 3; i < b.data.length; i += 4) if (b.data[i] > 0) n++;
  return n;
}

describe('detailed damaged ships', () => {
  it('burn more as they are hurt more: nothing, a wisp, fires and dark smoke, a heavy column', () => {
    expect(burnOf(0).smoke).toBe(0);
    expect(burnOf(0.1).smoke).toBe(0);
    const wisp = burnOf(0.3);
    expect(wisp.smoke).toBeGreaterThan(0);
    expect(wisp.fires).toBe(0);
    expect(wisp.dark).toBe(0);
    const burning = burnOf(0.6);
    expect(burning.fires).toBeGreaterThanOrEqual(1);
    expect(burning.dark).toBeGreaterThan(0.3);
    const heavy = burnOf(0.9);
    expect(heavy.fires).toBeGreaterThanOrEqual(3);
    expect(heavy.columns).toBe(3);
    expect(heavy.heavy).toBeGreaterThan(0.5);
    let prev = burnOf(0.2);
    for (let d = 0.25; d <= 1.001; d += 0.05) {
      const b = burnOf(d);
      expect(b.fires).toBeGreaterThanOrEqual(prev.fires);
      expect(b.dark).toBeGreaterThanOrEqual(prev.dark);
      expect(b.smoke).toBeGreaterThanOrEqual(prev.smoke);
      prev = b;
    }
  });

  it('list a little only when badly hurt, always to the same side for the same ship', () => {
    expect(listOf(0.5, 7)).toBe(0);
    expect(listOf(0.79, 7)).toBe(0);
    expect(Math.abs(listOf(0.85, 7))).toBe(1);
    expect(listOf(0.85, 7)).toBe(listOf(0.95, 7));
    expect(listOf(0.85, 7)).toBe(-listOf(0.85, 8));
  });

  it('are hit in the same spots every frame, on deck, different per ship', () => {
    for (const key of ['warship', 'destroyer', 'battleship', 'carrier'] as const) {
      const um = unitModel(key, 0);
      const L = modelLength(um);
      const B = modelSpan(um);
      for (let i = 0; i < 4; i++) {
        const a = hitSpot(um, 1234, i);
        expect(hitSpot(um, 1234, i)).toEqual(a);
        expect(Math.abs(a[0])).toBeLessThan(L * 0.4);
        expect(Math.abs(a[1])).toBeLessThan(B * 0.3);
        expect(a[2]).toBeGreaterThan(0.5);
      }
      expect(hitSpot(um, 1234, 0)).not.toEqual(hitSpot(um, 98765, 0));
    }
  });
});

describe('detailed smoke trails', () => {
  const src = (o: Partial<SmokeSource>): SmokeSource => ({ x: 100, y: 100, vx: 0, vy: 0, turn: 0, n: 6, lifeMs: 2000, r0: 1, r1: 4, dark: 0.5, alpha: 1, u: 2, wind: 1, rise: 1, seed: 0.3, ...o });

  it('rise and drift downwind from a source standing still, older puffs further and bigger', () => {
    const s = src({});
    const young = { ...puffOf(s, 0.2, 0) };
    const old = { ...puffOf(s, 0.8, 0) };
    expect(old.y).toBeLessThan(young.y);
    expect(old.y).toBeLessThan(s.y - RISE * s.u * 1);
    expect(old.x).toBeGreaterThan(s.x + WIND_X * s.u * 0.8);
    expect(old.r).toBeGreaterThan(young.r);
    expect(old.alpha).toBeLessThan(young.alpha);
    // young puffs are the dark ones
    expect(puffOf(s, 0.1, 0).kind).toBe('soot');
    expect(puffOf(s, 0.9, 0).kind).toBe('smoke');
    // a thin wisp (no dark smoke) pales as it thins, so it shows over a dark hull
    expect(puffOf(src({ dark: 0 }), 0.1, 0).kind).toBe('smoke');
    expect(puffOf(src({ dark: 0 }), 0.7, 0).kind).toBe('vapour');
  });

  it('stream back along the course of a moving ship, so they follow it instead of floating where they were', () => {
    // a ship sailing north (up the screen) at 40 px/s: its smoke lies south of it (behind), not over the water ahead
    const north = src({ vx: 0, vy: -40 });
    const p = { ...puffOf(north, 0.6, 0) };
    const still = { ...puffOf(src({}), 0.6, 0) };
    expect(p.y - still.y).toBeCloseTo(40 * 1.2, 0);
    // sailing east: the trail lies to the west of where it would drift on its own
    const east = puffOf(src({ vx: 40 }), 0.6, 0);
    expect(east.x).toBeLessThan(still.x - 40);
    // turning: the older the puff, the more its place swings off the straight line astern
    const straight = { ...puffOf(src({ vx: 40 }), 0.9, 0) };
    const turning = { ...puffOf(src({ vx: 40, turn: 0.6 }), 0.9, 0) };
    expect(Math.abs(turning.y - straight.y)).toBeGreaterThan(3);
  });
});

describe('detailed flames and foam', () => {
  const FIRE_RGB = FIRE.map(hex);
  const isFire = (d: Uint8ClampedArray, o: number, i: number): boolean => d[o] === FIRE_RGB[i][0] && d[o + 1] === FIRE_RGB[i][1] && d[o + 2] === FIRE_RGB[i][2];

  it('a flame is a tongue standing on its base: taller than wide, white and yellow low, red toward its tip', () => {
    const b = flameBitmap(4, 1, 0, 0);
    let top = b.h;
    let bottom = 0;
    let left = b.w;
    let right = 0;
    let hotLow = 0;
    let redHigh = 0;
    for (let y = 0; y < b.h; y++) {
      for (let x = 0; x < b.w; x++) {
        const o = (y * b.w + x) * 4;
        if (!b.data[o + 3]) continue;
        top = Math.min(top, y);
        bottom = Math.max(bottom, y);
        left = Math.min(left, x);
        right = Math.max(right, x);
        const up = b.oy - y;
        if (up < 4 && (isFire(b.data, o, 0) || isFire(b.data, o, 1))) hotLow++;
        if (up > 8 && (isFire(b.data, o, 4) || isFire(b.data, o, 5))) redHigh++;
      }
    }
    expect(bottom - top).toBeGreaterThan((right - left) * 1.2);
    expect(hotLow).toBeGreaterThan(0);
    expect(redHigh).toBeGreaterThan(0);
    // the origin is the middle of its base: most of it stands above
    expect(b.oy - top).toBeGreaterThan((bottom - b.oy) * 3);
  });

  it('flickers (its four frames differ) and leans with the wind', () => {
    const f0 = flameBitmap(3, 0, 0, 0);
    const f1 = flameBitmap(3, 0, 1, 0);
    expect(Buffer.from(f0.data).equals(Buffer.from(f1.data))).toBe(false);
    const tipX = (b: RGBABitmap): number => {
      for (let y = 0; y < b.h; y++) for (let x = 0; x < b.w; x++) if (b.data[(y * b.w + x) * 4 + 3]) return x - b.ox;
      return 0;
    };
    expect(tipX(flameBitmap(4, 2, 0, 2))).toBeGreaterThan(tipX(flameBitmap(4, 2, 0, -2)));
    expect(flameCode(3, 2)).toBe(3 + 16);
    expect(blobBitmap('flame', 3, 0, flameCode(1, 0)).data).toEqual(flameBitmap(3, 0, 1, 0).data);
  });

  it('foam is a flat lacy patch, densest in its middle, thinning to its edge (no ring), breaking up as it ages', () => {
    const b = foamBitmap(16, 1, 0);
    expect(b.w).toBeGreaterThan(b.h * 1.5);
    let inner = 0;
    let innerN = 0;
    let outer = 0;
    let outerN = 0;
    for (let y = 0; y < b.h; y++) {
      for (let x = 0; x < b.w; x++) {
        const d = Math.hypot(x - b.ox, (y - b.oy) / 0.55) / 16;
        const on = b.data[(y * b.w + x) * 4 + 3] > 0 ? 1 : 0;
        if (d < 0.4) {
          inner += on;
          innerN++;
        } else if (d > 0.7 && d < 0.95) {
          outer += on;
          outerN++;
        }
      }
    }
    expect(inner / innerN).toBeGreaterThan(outer / outerN + 0.15);
    expect(solid(foamBitmap(16, 1, 3))).toBeLessThan(solid(b) * 0.85);
    // white and blue grey, the spray's tones
    const tones = new Set(SPRAY.map((c) => hex(c).join(',')));
    for (let i = 0; i < b.data.length; i += 4) if (b.data[i + 3]) expect(tones.has(`${b.data[i]},${b.data[i + 1]},${b.data[i + 2]}`)).toBe(true);
  });
});

describe('detailed crater fires and the atom blast zone', () => {
  it('fires burn longer in bigger craters and under cinematic motion, shorter under subtle', () => {
    expect(burnShare(2.1, lively)).toBeGreaterThan(burnShare(0.9, lively));
    expect(burnShare(0.9, lively)).toBeGreaterThan(burnShare(0.5, lively));
    expect(burnShare(0.9, cinematic)).toBeGreaterThan(burnShare(0.9, lively));
    expect(burnShare(0.9, subtle)).toBeLessThan(burnShare(0.9, lively));
    for (const rt of [0.5, 0.9, 2.1]) for (const m of [subtle, lively, cinematic]) expect(burnShare(rt, m)).toBeLessThan(0.5);
    expect(sizeClass(0.5)).toBe(0);
    expect(sizeClass(11)).toBeCloseTo(1, 1);
    // the fires' clock runs on through a crater's life and is longer for a bigger one
    expect(fireClock(0.5, 1, lively)).toBeGreaterThan(fireClock(0.5, 0, lively));
  });

  it('the atom bomb leaves a wide blast zone, not a big crater: scorched ground out to three crater radii', () => {
    const R = 60;
    const z = blastZoneBitmap(R, 1);
    const crater = craterBitmap(Math.round(R / ZONE), 1);
    // reaches out to about three crater radii, a normal crater to about two
    expect(z.w).toBeGreaterThan(crater.w * 1.4);
    // scorched ground lies well past two crater radii, where a normal crater has nothing left
    const beyond = (b: RGBABitmap, k: number): number => {
      let n = 0;
      for (let y = 0; y < b.h; y++) for (let x = 0; x < b.w; x++) if (b.data[(y * b.w + x) * 4 + 3] && Math.hypot(x - b.ox, (y - b.oy) / 0.84) > (R / ZONE) * k) n++;
      return n;
    };
    expect(beyond(z, 2)).toBeGreaterThan(R * R * 0.15);
    expect(beyond(crater, 2)).toBe(0);
    expect(beyond(z, 1.6)).toBeGreaterThan(beyond(crater, 1.6) * 20);
  });

  it('its zone has no ring: no band of radii stands out brighter than the bands either side, and it thins at its edge', () => {
    for (const v of [0, 1, 2, 3]) {
      const R = 64;
      const z = blastZoneBitmap(R, v);
      const bins = 16;
      const sum = new Array(bins).fill(0);
      const cnt = new Array(bins).fill(0);
      const cov = new Array(bins).fill(0);
      for (let y = 0; y < z.h; y++) {
        for (let x = 0; x < z.w; x++) {
          const d = Math.hypot(x - z.ox, (y - z.oy) / 0.84) / R;
          const b = Math.floor(d * bins);
          if (b >= bins) continue;
          const o = (y * z.w + x) * 4;
          cov[b]++;
          if (!z.data[o + 3]) continue;
          sum[b] += luma(z.data, o);
          cnt[b]++;
        }
      }
      const mean = sum.map((s, i) => s / Math.max(1, cnt[i]));
      for (let i = 1; i < bins - 4; i++) expect(mean[i] - Math.max(mean[i - 1], mean[i + 1])).toBeLessThan(14);
      // dense close in, thin toward the edge
      expect(cnt[bins - 3] / cov[bins - 3]).toBeLessThan(cnt[6] / cov[6]);
    }
  });
});

describe('detailed cannon fire', () => {
  it('the tongues of flame are at full length in the first frame and drawn back within a tenth of a second', () => {
    expect(tongueAt(0, lively)).toBeGreaterThan(8);
    expect(tongueAt(16, lively)).toBe(tongueAt(0, lively));
    expect(tongueAt(60, lively)).toBeLessThan(tongueAt(16, lively));
    expect(tongueAt(100, lively)).toBe(0);
    expect(tongueAt(0, cinematic)).toBeGreaterThan(tongueAt(0, subtle));
    expect(BARRELS).toBeGreaterThanOrEqual(2);
  });

  it('the flash lasts long enough for its gun smoke to drift, longer under cinematic motion', () => {
    const c = styleModule('detailed').cannonFire;
    expect(c.flashMs(lively)).toBeGreaterThan(FLASH_FIRE_MS * 4);
    expect(c.flashMs(cinematic)).toBeGreaterThan(c.flashMs(lively));
    expect(c.flashMs(subtle)).toBeLessThan(c.flashMs(lively));
  });

  it('a ship hit lingers in smoke longer than a shell landing, and a splash outlasts its column with its foam', () => {
    const ex = styleModule('detailed').explosions;
    expect(ex.durationMs('hit', lively)).toBeGreaterThan(ex.durationMs('shell', lively));
    expect(ex.durationMs('splash', lively)).toBeGreaterThan(1200);
  });
});
