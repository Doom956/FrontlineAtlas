// The detailed art style, round three: the atom bomb's ground mark in three tones (a pale ash pan, a black charred band,
// radial streaks) that weathers to ash before it fades, foam as white lace (not a grey mat), smoke trails whose puffs
// always join (no dotted line, straight or turning), a column that climbs before the wind takes it, the burnt patch on
// a deck and the pressed-flat water of a gun's blast.
import { describe, expect, it } from 'vitest';
import { blobBitmap, foamBitmap, scorchBitmap } from '../src/client/art/detailed/blobs';
import { joinRadius, puffOf, type SmokeSource } from '../src/client/art/detailed/burning';
import { blastZoneBitmap } from '../src/client/art/detailed/craters';
import { ASH, GLASS, SPRAY } from '../src/client/art/detailed/palette';
import { hex } from '../src/client/art/shared/colour';
import type { RGBABitmap } from '../src/client/art/shared/atlas';

const luma = (d: Uint8ClampedArray, o: number): number => 0.3 * d[o] + 0.59 * d[o + 1] + 0.11 * d[o + 2];

/** Mean luma and coverage of a bitmap's pixels between two radii (in units of `R`, the 3/4 view squashed by `sq`). */
function band(b: RGBABitmap, R: number, sq: number, d0: number, d1: number): { lum: number; cov: number } {
  let sum = 0;
  let n = 0;
  let all = 0;
  for (let y = 0; y < b.h; y++) {
    for (let x = 0; x < b.w; x++) {
      const d = Math.hypot(x - b.ox, (y - b.oy) / sq) / R;
      if (d < d0 || d >= d1) continue;
      all++;
      const o = (y * b.w + x) * 4;
      if (!b.data[o + 3]) continue;
      sum += luma(b.data, o);
      n++;
    }
  }
  return { lum: sum / Math.max(1, n), cov: n / Math.max(1, all) };
}

describe('detailed atom blast zone, three tones', () => {
  it('a pale ash pan at ground zero, a black charred band round it, streaks out past that', () => {
    for (const v of [0, 1, 2, 3]) {
      const R = 64;
      const z = blastZoneBitmap(R, v);
      const pan = band(z, R, 0.84, 0, 0.15);
      const charred = band(z, R, 0.84, 0.33, 0.43);
      const streaks = band(z, R, 0.84, 0.62, 0.8);
      // the pan reads light (lighter than a mid green land), the band near black
      expect(pan.lum).toBeGreaterThan(150);
      expect(charred.lum).toBeLessThan(45);
      expect(pan.lum - charred.lum).toBeGreaterThan(110);
      // solid in the middle, open streaks further out (gaps of bare ground between them)
      expect(pan.cov).toBeGreaterThan(0.98);
      expect(charred.cov).toBeGreaterThan(0.95);
      expect(streaks.cov).toBeLessThan(0.8);
      expect(streaks.cov).toBeGreaterThan(0.15);
    }
  });

  it('streaks run out from ground zero: a pixel on a streak has its neighbours along the ray drawn more often than across it', () => {
    const R = 64;
    const z = blastZoneBitmap(R, 2);
    const on = (x: number, y: number): boolean => x >= 0 && y >= 0 && x < z.w && y < z.h && z.data[(y * z.w + x) * 4 + 3] > 0;
    let along = 0;
    let across = 0;
    for (let y = 0; y < z.h; y++) {
      for (let x = 0; x < z.w; x++) {
        const dx = x - z.ox;
        const dy = (y - z.oy) / 0.84;
        const d = Math.hypot(dx, dy) / R;
        if (d < 0.62 || d > 0.85 || !on(x, y)) continue;
        const ux = dx / Math.hypot(dx, dy);
        const uy = (dy / Math.hypot(dx, dy)) * 0.84;
        const step = (sx: number, sy: number): boolean => on(Math.round(x + sx * 2), Math.round(y + sy * 2));
        if (step(ux, uy)) along++;
        if (step(-uy, ux)) across++;
      }
    }
    expect(along).toBeGreaterThan(across * 1.15);
  });

  it('weathers to ash before it fades: the charred band lightens with age, the outline stays the same', () => {
    const R = 48;
    const fresh = blastZoneBitmap(R, 1, 0);
    const mid = blastZoneBitmap(R, 1, 1);
    const old = blastZoneBitmap(R, 1, 2);
    const c0 = band(fresh, R, 0.84, 0.33, 0.43).lum;
    const c1 = band(mid, R, 0.84, 0.33, 0.43).lum;
    const c2 = band(old, R, 0.84, 0.33, 0.43).lum;
    expect(c1).toBeGreaterThan(c0 + 8);
    expect(c2).toBeGreaterThan(c1 + 15);
    // the same pixels drawn at every age (they cross-fade)
    for (let i = 3; i < fresh.data.length; i += 4) expect(fresh.data[i] > 0).toBe(old.data[i] > 0);
  });

  it('its glass is a dull olive, never teal (green over blue), and the ash a warm light grey', () => {
    for (const c of GLASS.map(hex)) expect(c[1]).toBeGreaterThan(c[2] + 10);
    for (const c of ASH.map(hex)) expect(c[0]).toBeGreaterThanOrEqual(c[2]);
  });
});

describe('detailed foam is lace, not a mat', () => {
  it('is mostly near-white froth with holes in it, the blue grey only a thin low veil', () => {
    const b = foamBitmap(16, 1, 0);
    const top = hex(SPRAY[3]).join(',');
    const veil = hex(SPRAY[1]).join(',');
    let white = 0;
    let thin = 0;
    for (let i = 0; i < b.data.length; i += 4) {
      if (!b.data[i + 3]) continue;
      const c = `${b.data[i]},${b.data[i + 1]},${b.data[i + 2]}`;
      if (c === top) white++;
      else {
        expect(c).toBe(veil);
        expect(b.data[i + 3]).toBeLessThanOrEqual(100);
        thin++;
      }
    }
    expect(white).toBeGreaterThan(thin);
    // holes even in its middle (lace), where the old mat was solid
    const mid = band(b, 16, 0.55, 0, 0.5);
    expect(mid.cov).toBeLessThan(0.85);
    expect(mid.cov).toBeGreaterThan(0.35);
  });

  it('breaks into loose bubbles past its edge (no straight top or bottom)', () => {
    let out = 0;
    for (const v of [0, 1, 2, 3]) out += band(foamBitmap(20, v, 0), 20, 0.55, 1.12, 1.4).cov;
    expect(out).toBeGreaterThan(0);
  });
});

describe('detailed smoke trails join up', () => {
  const src = (o: Partial<SmokeSource>): SmokeSource => ({ x: 100, y: 100, vx: 0, vy: 0, turn: 0, n: 6, lifeMs: 2000, r0: 1, r1: 4, dark: 0.5, alpha: 1, u: 2, wind: 1, rise: 1, seed: 0.3, ...o });

  it('puffs are drawn at least about as wide as the path between neighbours, straight or turning', () => {
    // (a trail as the ships draw it: its speed kept to what its puffs can cover)
    for (const s of [src({ vx: 60, n: 10 }), src({ vx: 60, n: 10, turn: 0.7 }), src({ vx: -30, vy: 45, n: 10, turn: -0.5 })]) {
      const k = 2;
      const r = joinRadius(s, k);
      const n = s.n;
      for (let i = 0; i < n - 1; i++) {
        const a = { ...puffOf(s, (i + 0.5) / n, i) };
        const b = { ...puffOf(s, (i + 1.5) / n, i + 1) };
        const gap = Math.hypot(b.x - a.x, b.y - a.y) / k;
        // drawSmokeTrail draws each at least 0.85 x joinRadius: two neighbours overlap
        const ra = Math.max(a.r, r * (0.85 + 0.3 * ((i + 0.5) / n)));
        const rb = Math.max(b.r, r * (0.85 + 0.3 * ((i + 1.5) / n)));
        expect(ra + rb).toBeGreaterThan(gap);
      }
    }
  });

  it('a column climbs before the wind takes it when it is calm', () => {
    const windy = { ...puffOf(src({}), 0.15, 0) };
    const calm = { ...puffOf(src({ calm: 0.6 }), 0.15, 0) };
    expect(calm.y).toBeCloseTo(windy.y, 0);
    expect(calm.x - 100).toBeLessThan((windy.x - 100) * 0.5);
  });
});

describe('detailed burnt decks and the gun blast on the water', () => {
  it('a burnt patch is flat and dark, densest in its middle', () => {
    const b = scorchBitmap(6, 1);
    expect(b.w).toBeGreaterThan(b.h * 1.4);
    const inner = band(b, 6, 0.6, 0, 0.4);
    expect(inner.cov).toBeGreaterThan(0.85);
    expect(inner.lum).toBeLessThan(40);
    expect(blobBitmap('scorch', 6, 1).data).toEqual(b.data);
  });

  it('the pressed-flat water is a pale patch in spray tones', () => {
    const b = blobBitmap('press', 8, 0);
    const tones = new Set(SPRAY.map((c) => hex(c).join(',')));
    let n = 0;
    for (let i = 0; i < b.data.length; i += 4) {
      if (!b.data[i + 3]) continue;
      n++;
      expect(tones.has(`${b.data[i]},${b.data[i + 1]},${b.data[i + 2]}`)).toBe(true);
    }
    expect(n).toBeGreaterThan(40);
  });
});
