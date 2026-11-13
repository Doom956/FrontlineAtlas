// The detailed style's troop icons (client/art/detailed/troopIcons.ts): tiny pixel units with no tile round them (the
// corners of the icon box stay transparent), the nation colour on the unit itself, the three kinds and the unknown mix
// told apart at both sizes, every nation colour (near black and near white too) clear of the dark outline and of the
// dark pill.
import { describe, expect, it } from 'vitest';
import { bakeTroopIcon, iconTones, lightRimFor, OUTLINE, type IconBitmap } from '../src/client/art/detailed/troopIcons';
import { luma } from '../src/client/art/shared/colour';

const KINDS = ['infantry', 'armor', 'artillery', 'troops'] as const;
const SIZES = [16, 12];
const NATIONS: [number, number, number][] = [
  [64, 160, 255],
  [226, 74, 60],
  [92, 178, 84],
  [236, 196, 64],
  [255, 240, 0],
  [152, 104, 220],
  [232, 232, 228],
  [250, 250, 250],
  [120, 70, 30],
  [44, 46, 56],
  [12, 12, 14],
  [0, 0, 0],
];
/** The pill's fill (render/troopIcons.ts troopPill) */
const PILL = [20, 23, 29];

const px = (b: IconBitmap, x: number, y: number): number[] => {
  const o = (y * b.w + x) * 4;
  return [b.data[o], b.data[o + 1], b.data[o + 2], b.data[o + 3]];
};
function opaque(b: IconBitmap): number[][] {
  const out: number[][] = [];
  for (let i = 0; i < b.data.length; i += 4) if (b.data[i + 3] === 255) out.push([b.data[i], b.data[i + 1], b.data[i + 2]]);
  return out;
}
/** Pixels whose colour or coverage differ. */
function diff(a: IconBitmap, b: IconBitmap): number {
  let d = 0;
  for (let i = 0; i < a.data.length; i += 4) if (a.data[i] !== b.data[i] || a.data[i + 1] !== b.data[i + 1] || a.data[i + 2] !== b.data[i + 2] || a.data[i + 3] !== b.data[i + 3]) d++;
  return d;
}
/** Pixels covered by one icon and not the other (the silhouettes). */
function shapeDiff(a: IconBitmap, b: IconBitmap): number {
  let d = 0;
  for (let i = 3; i < a.data.length; i += 4) if (a.data[i] > 0 !== b.data[i] > 0) d++;
  return d;
}

describe('detailed troop icons', () => {
  it('draws every kind as a bare unit: no tile, the corners and most of the box edge transparent', () => {
    for (const size of SIZES)
      for (const kind of KINDS)
        for (const owner of NATIONS) {
          const b = bakeTroopIcon(kind, owner, size);
          const W = size + 2;
          expect(b.w).toBe(W);
          expect(b.h).toBe(W);
          for (const [x, y] of [
            [0, 0],
            [W - 1, 0],
            [0, W - 1],
            [W - 1, W - 1],
          ])
            expect(px(b, x, y)[3], `${kind} ${size} corner ${x},${y}`).toBe(0);
          // the box edge is not a frame: at most a few outline pixels touch it
          let edge = 0;
          for (let i = 0; i < W; i++) for (const [x, y] of [[i, 0], [i, W - 1], [0, i], [W - 1, i]]) if (px(b, x, y)[3] > 0) edge++;
          expect(edge, `${kind} ${size} edge`).toBeLessThan(W);
          // and the unit covers well under the whole box
          const cover = opaque(b).length / (W * W);
          expect(cover, `${kind} ${size} cover`).toBeGreaterThan(0.15);
          expect(cover, `${kind} ${size} cover`).toBeLessThan(0.6);
        }
  });

  it('puts the nation colour on the unit itself (uniform, hull, shield)', () => {
    for (const size of SIZES)
      for (const kind of ['infantry', 'armor', 'artillery'] as const) {
        const blue = opaque(bakeTroopIcon(kind, [64, 160, 255], size)).filter(([r, g, b]) => b - r > 50 && b - g > 10).length;
        const red = opaque(bakeTroopIcon(kind, [226, 74, 60], size)).filter(([r, g, b]) => r - g > 50 && r - b > 50).length;
        expect(blue, `${kind} ${size} blue`).toBeGreaterThan(size < 16 ? 6 : 12);
        expect(red, `${kind} ${size} red`).toBeGreaterThan(size < 16 ? 6 : 12);
      }
  });

  it('keeps the nation colour muted: no fully saturated pixels, even for a pure yellow nation', () => {
    for (const kind of KINDS) {
      for (const [r, g, b] of opaque(bakeTroopIcon(kind, [255, 240, 0], 16))) {
        const sat = Math.max(r, g, b) - Math.min(r, g, b);
        expect(sat, kind).toBeLessThan(200);
      }
    }
  });

  it('tells infantry, armor, artillery and an unknown mix apart at both sizes, by shape as well as colour', () => {
    for (const size of SIZES)
      for (const owner of [NATIONS[0], NATIONS[7], NATIONS[10]]) {
        const icons = KINDS.map((k) => bakeTroopIcon(k, owner, size));
        for (let i = 0; i < icons.length; i++)
          for (let j = i + 1; j < icons.length; j++) {
            expect(diff(icons[i], icons[j]), `${KINDS[i]} vs ${KINDS[j]} ${size}`).toBeGreaterThan(size * 3);
            expect(shapeDiff(icons[i], icons[j]), `${KINDS[i]} vs ${KINDS[j]} ${size} shape`).toBeGreaterThan(size * 2);
          }
      }
  });

  it('draws an unknown mix in greys with a light question mark, never as the coloured soldier', () => {
    for (const size of SIZES) {
      const unk = opaque(bakeTroopIcon('troops', [64, 160, 255], size));
      // no strong owner colour: the figure is grey with only a hint of it
      expect(unk.filter(([r, g, b]) => b - r > 50).length).toBe(0);
      // the question mark: near-white pixels
      expect(unk.filter(([r, g, b]) => r > 200 && g > 200 && b > 190).length).toBeGreaterThan(4);
    }
  });

  it('keeps every nation colour, near black and near white too, clear of the dark outline and of the dark pill', () => {
    const ol = luma(OUTLINE);
    for (const owner of NATIONS) {
      const tones = iconTones(owner);
      // the base tone (the most of the uniform or hull) parts from the outline by value
      expect(luma(tones[2]) - ol, `${owner} base vs outline`).toBeGreaterThan(55);
      for (const size of SIZES)
        for (const kind of KINDS) {
          const b = bakeTroopIcon(kind, owner, size);
          // the outline is the dark ink, round the whole silhouette
          let ring = 0;
          for (let i = 0; i < b.data.length; i += 4)
            if (b.data[i + 3] > 0 && b.data[i + 3] < 255) {
              ring++;
              expect([b.data[i], b.data[i + 1], b.data[i + 2]]).toEqual([...OUTLINE]);
            }
          expect(ring, `${owner} ${kind} ${size} outline`).toBeGreaterThan(size * 2);
          // and enough of the unit is lighter than the dark pill to read on it
          const lit = opaque(b).filter((c) => luma(c) - luma(PILL) > 45).length;
          expect(lit, `${owner} ${kind} ${size} on the pill`).toBeGreaterThan(size < 16 ? 8 : 14);
        }
    }
  });

  it('gives a dark nation a lighter rim on its parts, and lifts it to a charcoal', () => {
    for (const owner of [[44, 46, 56], [12, 12, 14], [0, 0, 0]] as [number, number, number][]) {
      expect(lightRimFor(owner)).toBe(true);
      const t = iconTones(owner);
      expect(luma(t[2])).toBeGreaterThanOrEqual(70);
      for (const size of SIZES) {
        const b = bakeTroopIcon('armor', owner, size);
        const rim = opaque(b).filter((c) => luma(c) > luma(t[2]) + 40).length;
        expect(rim, `${owner} ${size}`).toBeGreaterThan(size < 16 ? 5 : 10);
      }
    }
    for (const owner of [[64, 160, 255], [232, 232, 228], [236, 196, 64]] as [number, number, number][]) expect(lightRimFor(owner)).toBe(false);
  });

  it('is deterministic and crisp: the same bitmap every time, every pixel either solid, the outline or empty', () => {
    for (const size of SIZES)
      for (const kind of KINDS) {
        const a = bakeTroopIcon(kind, [92, 178, 84], size);
        const b = bakeTroopIcon(kind, [92, 178, 84], size);
        expect(diff(a, b)).toBe(0);
        for (let i = 3; i < a.data.length; i += 4) expect([0, 235, 255]).toContain(a.data[i]);
      }
  });
});
