// The detailed art style after the owner's picks: a carrier that reads as a ship (an angled landing deck, the island
// to starboard, sparse broken markings, no long dashed centre line, a small owner mark), explosions that open with a
// short bright flash, and an atom bomb that plays as a sequence (flash, rising fireball, stem, rolling cap, uneven
// surge, slow dissipation).
import { describe, expect, it } from 'vitest';
import { rasterize, type Part } from '../src/client/art/detailed/bake';
import { blobBitmap, glowBitmap } from '../src/client/art/detailed/blobs';
import { AHALF, ALEN, DECK_PAINT, flightDeckTone, onAngled } from '../src/client/art/detailed/carrierDeck';
import { atomShape, flashAt } from '../src/client/art/detailed/explosions';
import { modelLength, unitModel } from '../src/client/art/detailed/models';
import { FIRE } from '../src/client/art/detailed/palette';
import { motionParams } from '../src/client/art/motion';
import { styleModule } from '../src/client/art/registry';
import { hex } from '../src/client/art/shared/colour';
import { ALL_MODS } from '../src/client/art/shared/keys';
import { BLAST_KINDS } from '../src/client/art/types';

const OWNER = [64, 160, 255] as const;

/** Share of solid pixels in the blue owner's colour family. */
function ownerShare(data: Uint8ClampedArray): number {
  let own = 0;
  let solid = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] !== 255) continue;
    solid++;
    if (data[i + 2] - data[i] > 60 && data[i + 2] - data[i + 1] > 10) own++;
  }
  return own / Math.max(1, solid);
}

describe('detailed carrier', () => {
  const parts = unitModel('carrier', 0).model.parts as Part[];
  const deck = parts.find((p) => p.pat === 'flightDeck')!;

  it('has a flight deck with an angled landing deck reaching out to port, the island to starboard', () => {
    expect(deck).toBeTruthy();
    const vs = deck.p.filter((_, i) => i % 2 === 1);
    // the sponson of the angled deck: the deck reaches clearly further to port (-v) than to starboard
    expect(-Math.min(...vs)).toBeGreaterThan(Math.max(...vs) + 1.5);
    // the island (the superstructure) stands on the starboard side
    const sup = parts.filter((p) => p.m === 'sup' && p.k === 'box');
    expect(sup.length).toBeGreaterThan(1);
    for (const p of sup) expect(p.p[1]).toBeGreaterThan(3);
    // broad: about four times as long as its deck is wide, not a long thin strip
    const w = Math.max(...vs) - Math.min(...vs);
    expect(modelLength(unitModel('carrier', 0)) / w).toBeLessThan(4.6);
  });

  it('paints no long line along the deck: every line along the hull crosses only short, sparse marks', () => {
    for (const res of [1, 2, 3]) {
      for (let v = -7; v <= 5; v += 0.25) {
        let paint = 0;
        let run = 0;
        let longest = 0;
        let n = 0;
        for (let u = -26; u <= 26; u += 0.1, n++) {
          // sample on an odd/even pixel pair, so worn pixels do not hide a line
          const a = flightDeckTone(2, u, v, res, 1, 0) >= DECK_PAINT || flightDeckTone(2, u, v, res, 0, 0) >= DECK_PAINT;
          if (a) {
            paint++;
            run++;
            longest = Math.max(longest, run);
          } else run = 0;
        }
        expect(paint / n, `res ${res} v ${v}`).toBeLessThan(0.12);
        // no mark runs more than 3.5 units along the hull
        expect(longest * 0.1, `res ${res} v ${v}`).toBeLessThan(3.5);
      }
    }
  });

  it('darkens the landing area with tyre marks and keeps parked planes clear of it', () => {
    let dark = 0;
    let n = 0;
    for (let s = 4; s < 12; s += 0.25)
      for (let w = -1.5; w <= 1.5; w += 0.25) {
        const [u, v] = onAngled(s, w);
        n++;
        if (flightDeckTone(2, u, v, 2, Math.round(u * 7), Math.round(v * 5)) < 2) dark++;
      }
    expect(dark / n).toBeGreaterThan(0.15);
    // the planes (fuselages in sea grey) sit outside the landing area
    for (const p of parts) {
      if (p.m !== 'seagrey' || p.k !== 'seg' || p.h < 0.5) continue;
      for (const [u, v] of [
        [p.p[0], p.p[1]],
        [p.p[2], p.p[3]],
      ]) {
        const [au, av] = onAngled(0, 0);
        const du = u - au;
        const dv = v - av;
        const s = du * Math.cos(0.16) - dv * Math.sin(0.16);
        const w = du * Math.sin(0.16) + dv * Math.cos(0.16);
        const inside = s > 0 && s < ALEN && Math.abs(w) < AHALF;
        // the plane on the bow catapult is past the landing area's forward end
        expect(inside, `plane at ${u.toFixed(1)}, ${v.toFixed(1)}`).toBe(false);
      }
    }
  });

  it('keeps the owner colour a small mark and shows the upgrades', () => {
    for (const res of [1, 2]) {
      const b = rasterize(unitModel('carrier', 0).model, res, 0, { facings: 32, owner: OWNER, roll: 0 });
      const share = ownerShare(b.data);
      expect(share).toBeGreaterThan(0);
      expect(share).toBeLessThan(0.025);
    }
    const plain = unitModel('carrier', 0).model.parts.length;
    const all = unitModel('carrier', ALL_MODS).model.parts.length;
    expect(all).toBeGreaterThan(plain + 10);
  });
});

describe('detailed explosion flashes', () => {
  const lively = motionParams('lively', false);
  const subtle = motionParams('subtle', false);
  const cinematic = motionParams('cinematic', false);
  const kinds = BLAST_KINDS.filter((k) => k !== 'atom');
  /** The first age (ms) at which the core no longer shows. */
  const coreEnd = (k: (typeof kinds)[number], m: typeof lively): number => {
    let a = 0;
    while (flashAt(k, a, m).coreA > 0) a++;
    return a;
  };

  it('opens every blast with a white-hot core for two or three frames and a light that fades fast', () => {
    for (const k of kinds) {
      const f0 = { ...flashAt(k, 0, lively) };
      expect(f0.coreA, k).toBe(1);
      expect(f0.coreR, k).toBeGreaterThan(0.5);
      expect(f0.glowA, k).toBeGreaterThan(0.25);
      expect(f0.glowR, k).toBeGreaterThan(f0.coreR * 1.8);
      // still there on the second frame at 60 frames a second, gone by the fourth
      expect(flashAt(k, 17, lively).coreA, k).toBeGreaterThan(0.5);
      expect(flashAt(k, 50, lively).coreA, k).toBe(0);
      // the light halves within an eighth of a second and is gone well inside half a second
      expect(flashAt(k, 120, lively).glowA, k).toBeLessThan(f0.glowA * 0.5);
      expect(flashAt(k, 400, lively).glowA, k).toBe(0);
      // the core shrinks into the fireball instead of fading to a pale veil over it
      expect(flashAt(k, 30, lively).coreR, k).toBeLessThan(f0.coreR);
    }
  });

  it('makes the flash smaller and shorter with subtle motion, bigger and longer with cinematic', () => {
    for (const k of kinds) {
      const r = (m: typeof lively): [number, number] => {
        const f = flashAt(k, 0, m);
        return [f.coreR, f.glowR];
      };
      const [cs, gs] = r(subtle);
      const [cl, gl] = r(lively);
      const [cc, gc] = r(cinematic);
      expect(cs).toBeLessThan(cl);
      expect(cl).toBeLessThan(cc);
      expect(gs).toBeLessThan(gl);
      expect(gl).toBeLessThan(gc);
      expect(coreEnd(k, subtle)).toBeLessThan(coreEnd(k, cinematic));
      expect(coreEnd(k, subtle)).toBeGreaterThanOrEqual(17);
      expect(flashAt(k, 0, subtle).glowA).toBeLessThan(flashAt(k, 0, cinematic).glowA);
    }
  });

  it('paints the core white to yellow (never red) and the light as a soft stepped pool, not a ring', () => {
    const allowed = new Set([FIRE[0], FIRE[1], FIRE[2]].map((c) => hex(c).join(',')));
    const core = blobBitmap('flash', 12, 1);
    let lit = 0;
    for (let i = 0; i < core.data.length; i += 4) {
      if (!core.data[i + 3]) continue;
      lit++;
      expect(allowed.has(`${core.data[i]},${core.data[i + 1]},${core.data[i + 2]}`)).toBe(true);
    }
    expect(lit).toBeGreaterThan(200);
    const gl = glowBitmap('glow', 24, 2);
    // lying on the ground: wider than tall; translucent everywhere, in several steps
    expect(gl.h).toBeLessThan(gl.w * 0.75);
    const alphas = new Set<number>();
    for (let i = 3; i < gl.data.length; i += 4) {
      expect(gl.data[i]).toBeLessThan(255);
      if (gl.data[i]) alphas.add(gl.data[i]);
    }
    expect(alphas.size).toBeGreaterThan(4);
    // densest in the middle, thinning outward band by band (no bright rim)
    const bands = [0, 0, 0, 0, 0];
    const counts = [0, 0, 0, 0, 0];
    for (let y = 0; y < gl.h; y++)
      for (let x = 0; x < gl.w; x++) {
        const d = Math.hypot((x - gl.ox) / gl.ox, (y - gl.oy) / gl.oy);
        if (d >= 1) continue;
        const b = Math.floor(d * 5);
        bands[b] += gl.data[(y * gl.w + x) * 4 + 3];
        counts[b]++;
      }
    const mean = bands.map((v, i) => v / Math.max(1, counts[i]));
    for (let i = 1; i < 5; i++) expect(mean[i]).toBeLessThan(mean[i - 1]);
    const halo = glowBitmap('halo', 24, 2);
    expect(halo.h).toBe(halo.w);
  });
});

describe('detailed atom bomb', () => {
  const ex = styleModule('detailed').explosions;

  it('lasts longer than every other blast, longer with cinematic motion, never past about twelve seconds', () => {
    const d = (p: 'subtle' | 'lively' | 'cinematic'): number => ex.durationMs('atom', motionParams(p, false));
    expect(d('subtle')).toBeLessThan(d('lively'));
    expect(d('lively')).toBeLessThan(d('cinematic'));
    expect(d('lively')).toBeGreaterThan(6000);
    expect(d('cinematic')).toBeLessThanOrEqual(12000);
    for (const k of BLAST_KINDS) if (k !== 'atom') expect(ex.durationMs(k, motionParams('lively', false))).toBeLessThan(d('lively') / 2);
  });

  it('plays as a sequence: a fireball that rises into a broad rolling cap, cools, then drifts and thins away', () => {
    const fT = 2400;
    const dur = 7600;
    let prev = { ...atomShape(0, fT, dur) };
    // the first moment: the fireball near the ground, no cap yet, all fire
    expect(prev.capIn).toBe(0);
    expect(prev.young).toBe(1);
    expect(prev.glow).toBe(1);
    expect(prev.capH).toBeLessThan(0.6);
    for (let age = 100; age <= dur; age += 100) {
      const a = { ...atomShape(age, fT, dur) };
      // it only rises, widens and cools; the cap never shrinks back
      expect(a.capH).toBeGreaterThanOrEqual(prev.capH);
      expect(a.Rm).toBeGreaterThanOrEqual(prev.Rm);
      expect(a.glow).toBeLessThanOrEqual(prev.glow);
      expect(a.young).toBeLessThanOrEqual(prev.young);
      expect(a.fade).toBeLessThanOrEqual(prev.fade);
      expect(a.wind).toBeGreaterThanOrEqual(prev.wind);
      // a cap wider than tall, its top within about three fireball radii of the ground
      if (a.capIn > 0.5) expect(2 * (a.Rm + a.rm)).toBeGreaterThan(3 * a.rm);
      expect(a.capH + a.rm).toBeLessThan(2.9);
      prev = a;
    }
    // by the end of the fire phase: a full cap, cooled to smoke, the stem long under it
    const mid = { ...atomShape(fT, fT, dur) };
    expect(mid.capIn).toBe(1);
    expect(mid.young).toBe(0);
    expect(mid.capH).toBeGreaterThan(1.7);
    // at the end it has drifted downwind and thinned away
    const end = atomShape(dur, fT, dur);
    expect(end.fade).toBeLessThan(0.01);
    expect(end.wind).toBeGreaterThan(0.5);
  });

  it('burns, then glows red inside its soot, then cools to pale tops, each stage overlapping the next', () => {
    const fT = 2400;
    const dur = 7600;
    let prevCool = 0;
    for (let age = 0; age <= dur; age += 50) {
      const a = atomShape(age, fT, dur);
      expect(a.cool).toBeGreaterThanOrEqual(prevCool);
      prevCool = a.cool;
    }
    expect(atomShape(0, fT, dur).cool).toBe(0);
    // the fire is out before the glow inside fades, and the glow outlasts the start of the cooling
    const at = (age: number) => ({ ...atomShape(age, fT, dur) });
    expect(at(fT * 0.7).young).toBe(0);
    expect(at(fT * 0.7).glow).toBeGreaterThan(0.3);
    expect(at(fT * 0.7).cool).toBeGreaterThan(0.3);
    expect(at(fT).cool).toBe(1);
    expect(at(fT * 1.3).glow).toBe(0);
  });

  it('builds the cloud from soft billows (a narrow tone range, no dark rim) and the surge from low flat ones', () => {
    /** The share of a blob's pixels in its two commonest tones, and in its darkest tone. */
    const tones = (kind: 'cloud' | 'cloudTop' | 'cloudUnder' | 'smoke' | 'roll'): [number, number] => {
      const bm = blobBitmap(kind, 14, 1);
      const count = new Map<number, number>();
      let n = 0;
      for (let i = 0; i < bm.data.length; i += 4) {
        if (!bm.data[i + 3]) continue;
        n++;
        const lum = bm.data[i] + bm.data[i + 1] + bm.data[i + 2];
        count.set(lum, (count.get(lum) ?? 0) + 1);
      }
      const byLum = [...count.entries()].sort((a, b) => a[0] - b[0]);
      const top2 = [...count.values()].sort((a, b) => b - a);
      return [(top2[0] + (top2[1] ?? 0)) / n, byLum[0][1] / n];
    };
    const [smokeMain, smokeDark] = tones('smoke');
    expect(smokeMain).toBeLessThan(0.7);
    expect(smokeDark).toBeGreaterThan(0.12);
    for (const k of ['cloud', 'cloudTop', 'cloudUnder', 'roll'] as const) {
      const [main, dark] = tones(k);
      expect(main, k).toBeGreaterThan(0.75);
      expect(dark, k).toBeLessThan(0.1);
    }
    const roll = blobBitmap('roll', 14, 1);
    expect(roll.h).toBeLessThan(roll.w * 0.8);
    // the tops stay below white (only the flash and the fire glare)
    const top = blobBitmap('cloudTop', 14, 1);
    for (let i = 0; i < top.data.length; i += 4) if (top.data[i + 3]) expect(top.data[i] + top.data[i + 1] + top.data[i + 2]).toBeLessThan(3 * 215);
  });
});
