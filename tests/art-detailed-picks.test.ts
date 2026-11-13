// The detailed art style after the owner's picks: a carrier that reads as a ship (an angled landing deck, the island
// to starboard, sparse broken markings, no long dashed centre line, a small owner mark), explosions that open with a
// short bright flash, and an atom bomb that plays as a sequence (flash, rising fireball, stem, rolling cap, uneven
// surge, slow dissipation).
import { describe, expect, it } from 'vitest';
import { rasterize, type Part } from '../src/client/art/detailed/bake';
import { AHALF, ALEN, DECK_PAINT, flightDeckTone, onAngled } from '../src/client/art/detailed/carrierDeck';
import { modelLength, unitModel } from '../src/client/art/detailed/models';
import { ALL_MODS } from '../src/client/art/shared/keys';

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
