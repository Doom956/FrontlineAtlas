// The detailed style's troop icons (client/art/detailed/troopIcons.ts): tiny pixel units with no tile round them (the
// corners of the icon box stay transparent), the nation colour on the unit the way the map units carry it (uniform,
// turret and hull band, gun shield), the field gun's trail and wheel in gun metal and rubber that read on the dark pill,
// an unknown mix drawn as the rifleman's own silhouette in neutral greys with a question mark, the kinds told apart at
// both sizes, every kind on one ground row, the 2x set, every nation colour (near black and near white too) clear of
// the dark outline and of the dark pill, and the shared pills (render/troopIcons.ts) setting the bare units side by
// side by their real widths on their own plate.
import { afterEach, describe, expect, it } from 'vitest';
import { artStyleOf, setArtStyle } from '../src/client/art/artStyle';
import { bakeTroopIcon, iconTones, lightRimFor, OUTLINE, troopIconSpan, UNKNOWN_GREYS, type IconBitmap } from '../src/client/art/detailed/troopIcons';
import { styleModule } from '../src/client/art/registry';
import { luma } from '../src/client/art/shared/colour';
import { formatCount } from '../src/client/render/common';
import { troopKinds, troopPill, troopPillSize, type TroopIconKind } from '../src/client/render/troopIcons';

const KINDS = ['infantry', 'armor', 'artillery', 'troops'] as const;
const SIZES = [16, 12];
const RES = [1, 2] as const;
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
  [128, 128, 128],
  [44, 46, 56],
  [12, 12, 14],
  [0, 0, 0],
];
const BLUE: [number, number, number] = [64, 160, 255];
const RED: [number, number, number] = [226, 74, 60];
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
/** The bounding box of the unit's own (opaque) pixels. */
function box(b: IconBitmap): { x0: number; y0: number; x1: number; y1: number } {
  let x0 = b.w;
  let y0 = b.h;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < b.h; y++)
    for (let x = 0; x < b.w; x++)
      if (px(b, x, y)[3] === 255) {
        x0 = Math.min(x0, x);
        y0 = Math.min(y0, y);
        x1 = Math.max(x1, x);
        y1 = Math.max(y1, y);
      }
  return { x0, y0, x1, y1 };
}
const isBlue = ([r, g, b]: number[]): boolean => b - r > 50 && b - g > 10;

describe('detailed troop icons', () => {
  it('draws every kind as a bare unit: no tile, the corners and most of the box edge transparent', () => {
    for (const res of RES)
      for (const size of SIZES)
        for (const kind of KINDS)
          for (const owner of NATIONS) {
            const b = bakeTroopIcon(kind, owner, size, res);
            const W = (size + 2) * res;
            expect(b.w).toBe(W);
            expect(b.h).toBe(W);
            for (const [x, y] of [
              [0, 0],
              [W - 1, 0],
              [0, W - 1],
              [W - 1, W - 1],
            ])
              expect(px(b, x, y)[3], `${kind} ${size} ${res}x corner ${x},${y}`).toBe(0);
            // the box edge is not a frame: at most a few outline pixels touch it
            let edge = 0;
            for (let i = 0; i < W; i++) for (const [x, y] of [[i, 0], [i, W - 1], [0, i], [W - 1, i]]) if (px(b, x, y)[3] > 0) edge++;
            expect(edge, `${kind} ${size} ${res}x edge`).toBeLessThan(W);
            // and the unit covers well under the whole box
            const cover = opaque(b).length / (W * W);
            expect(cover, `${kind} ${size} ${res}x cover`).toBeGreaterThan(0.15);
            expect(cover, `${kind} ${size} ${res}x cover`).toBeLessThan(0.6);
          }
  });

  it('puts the nation colour on the unit the way the map units carry it: uniform, turret and hull band, gun shield', () => {
    for (const size of SIZES)
      for (const kind of ['infantry', 'armor', 'artillery'] as const) {
        const b = bakeTroopIcon(kind, BLUE, size);
        const blue = opaque(b).filter(isBlue).length;
        const red = opaque(bakeTroopIcon(kind, RED, size)).filter(([r, g, bb]) => r - g > 50 && r - bb > 50).length;
        const min = kind === 'artillery' ? (size < 16 ? 5 : 8) : size < 16 ? 6 : 12;
        expect(blue, `${kind} ${size} blue`).toBeGreaterThan(min);
        expect(red, `${kind} ${size} red`).toBeGreaterThan(min);
      }
    // the tank's hull stays olive like the map tanks: the nation colour is well under half of it
    for (const size of SIZES) {
      const tank = opaque(bakeTroopIcon('armor', BLUE, size));
      expect(tank.filter(isBlue).length / tank.length, `armor ${size}`).toBeLessThan(0.45);
    }
  });

  it('draws the field gun as one silhouette whose trail and wheel are gun metal and rubber, the wheel lighter than the pill', () => {
    for (const size of SIZES)
      for (const res of RES) {
        const b = bakeTroopIcon('artillery', BLUE, size, res);
        const { x0, y0, x1, y1 } = box(b);
        // the lower part (wheel and trail) carries no owner colour
        for (let y = Math.ceil(y0 + (y1 - y0) * 0.6); y <= y1; y++) for (let x = x0; x <= x1; x++) if (px(b, x, y)[3] === 255) expect(isBlue(px(b, x, y)), `${size} ${res}x ${x},${y}`).toBe(false);
        // the wheel (round the middle of the lower half) reads on the near-black pill
        let lit = 0;
        for (let y = Math.ceil((y0 + y1) / 2); y <= y1; y++) for (let x = x0; x <= x1; x++) if (px(b, x, y)[3] === 255 && luma(px(b, x, y)) - luma(PILL) > 40) lit++;
        expect(lit, `${size} ${res}x wheel`).toBeGreaterThan((size < 16 ? 10 : 18) * res * res);
        // one silhouette: every opaque pixel is joined to the others (4-connected through opaque or outline pixels)
        const seen = new Set<number>();
        const start = (() => {
          for (let i = 0; i < b.w * b.h; i++) if (b.data[i * 4 + 3] === 255) return i;
          return -1;
        })();
        const stack = [start];
        seen.add(start);
        while (stack.length) {
          const i = stack.pop()!;
          const x = i % b.w;
          const y = (i / b.w) | 0;
          for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const nx = x + dx;
            const ny = y + dy;
            const j = ny * b.w + nx;
            if (nx < 0 || ny < 0 || nx >= b.w || ny >= b.h || seen.has(j) || b.data[j * 4 + 3] !== 255) continue;
            seen.add(j);
            stack.push(j);
          }
        }
        expect(seen.size, `${size} ${res}x one piece`).toBe(opaque(b).length);
      }
  });

  it('keeps the nation colour muted: no fully saturated pixels, even for a pure yellow nation', () => {
    for (const kind of KINDS) {
      for (const [r, g, b] of opaque(bakeTroopIcon(kind, [255, 240, 0], 16))) {
        const sat = Math.max(r, g, b) - Math.min(r, g, b);
        expect(sat, kind).toBeLessThan(200);
      }
    }
    // and white and pale yellow are held to a light grey, so they do not shine next to the muted art
    for (const owner of [[250, 250, 250], [255, 240, 0], [255, 255, 160]]) expect(luma(iconTones(owner)[2])).toBeLessThan(190);
  });

  it('tells infantry, armor and artillery apart at both sizes by shape, and an unknown mix by its greys and question mark', () => {
    for (const res of RES)
      for (const size of SIZES)
        for (const owner of [NATIONS[0], NATIONS[7], NATIONS[11]]) {
          const icons = KINDS.map((k) => bakeTroopIcon(k, owner, size, res));
          const n = size * res * res;
          for (let i = 0; i < icons.length; i++)
            for (let j = i + 1; j < icons.length; j++) {
              expect(diff(icons[i], icons[j]), `${KINDS[i]} vs ${KINDS[j]} ${size} ${res}x`).toBeGreaterThan(n * 3);
              // the unknown mix is the rifleman's own silhouette: told from him by colour and the question mark
              const shape = KINDS[i] === 'infantry' && KINDS[j] === 'troops' ? n * 0.75 : n * 2;
              expect(shapeDiff(icons[i], icons[j]), `${KINDS[i]} vs ${KINDS[j]} ${size} ${res}x shape`).toBeGreaterThan(shape);
            }
        }
  });

  it('draws an unknown mix as the rifleman in two neutral greys with a light question mark, the same for every nation', () => {
    for (const res of RES)
      for (const size of SIZES) {
        const blue = bakeTroopIcon('troops', BLUE, size, res);
        // no owner tint at all: the same picture for every nation
        for (const owner of NATIONS) expect(diff(blue, bakeTroopIcon('troops', owner, size, res)), `${owner}`).toBe(0);
        const greys = new Set(UNKNOWN_GREYS.map((c) => c.join(',')));
        const all = opaque(blue);
        expect(all.every((c) => greys.has(c.join(','))), `${size} ${res}x greys only`).toBe(true);
        // the question mark: at least 7 light pixels (a hook of 5 or 4 rows and the dot), at 1x
        expect(all.filter(([r, g, b]) => r > 200 && g > 200 && b > 190).length).toBeGreaterThanOrEqual((size < 16 ? 7 : 9) * res * res);
        // the figure is the rifleman's silhouette: every pixel he covers, the unknown mix covers too (the mix is
        // wider, with its question mark, so it sits further left in its box)
        const inf = bakeTroopIcon('infantry', BLUE, size, res);
        const dx = (troopIconSpan('infantry', size).x - troopIconSpan('troops', size).x) * res;
        for (let y = 0; y < inf.h; y++) for (let x = 0; x < inf.w; x++) if (px(inf, x, y)[3] === 255) expect(px(blue, x - dx, y)[3], `${size} ${res}x ${x},${y}`).toBe(255);
      }
  });

  it('stands every kind on the same ground row at both sizes and in both sets', () => {
    for (const res of RES)
      for (const size of SIZES) {
        const ground = KINDS.map((k) => box(bakeTroopIcon(k, BLUE, size, res)).y1);
        expect(new Set(ground).size, `${size} ${res}x ${ground}`).toBe(1);
      }
  });

  it('bakes the 2x set as the same unit at twice the pixels, with a 1 px outline', () => {
    for (const size of SIZES)
      for (const kind of KINDS) {
        const a = box(bakeTroopIcon(kind, BLUE, size, 1));
        const b = box(bakeTroopIcon(kind, BLUE, size, 2));
        expect(b.x0).toBe(2 * a.x0);
        expect(b.y0).toBe(2 * a.y0);
        expect(Math.abs(b.x1 - (2 * a.x1 + 1)), kind).toBeLessThanOrEqual(1);
        expect(b.y1).toBe(2 * a.y1 + 1);
        // the outline is one pixel: no outline pixel lies two pixels from the unit
        const hi = bakeTroopIcon(kind, BLUE, size, 2);
        const solid = (x: number, y: number): boolean => x >= 0 && y >= 0 && x < hi.w && y < hi.h && px(hi, x, y)[3] === 255;
        for (let y = 0; y < hi.h; y++)
          for (let x = 0; x < hi.w; x++)
            if (px(hi, x, y)[3] === 235) expect(solid(x - 1, y) || solid(x + 1, y) || solid(x, y - 1) || solid(x, y + 1)).toBe(true);
      }
  });

  it('keeps every nation colour, near black and near white too, clear of the dark outline and of the dark pill', () => {
    const ol = luma(OUTLINE);
    for (const owner of NATIONS) {
      const tones = iconTones(owner);
      // the base tone parts from the outline by value (a near-black nation's least, its rim carries the rest)
      expect(luma(tones[2]) - ol, `${owner} base vs outline`).toBeGreaterThan(30);
      for (const res of RES)
        for (const size of SIZES)
          for (const kind of KINDS) {
            const b = bakeTroopIcon(kind, owner, size, res);
            // the outline is the dark ink, round the whole silhouette
            let ring = 0;
            for (let i = 0; i < b.data.length; i += 4)
              if (b.data[i + 3] > 0 && b.data[i + 3] < 255) {
                ring++;
                expect([b.data[i], b.data[i + 1], b.data[i + 2]]).toEqual([...OUTLINE]);
              }
            expect(ring, `${owner} ${kind} ${size} outline`).toBeGreaterThan(size * 2 * res);
            // and enough of the unit is lighter than the dark pill to read on it
            const lit = opaque(b).filter((c) => luma(c) - luma(PILL) > 45).length;
            expect(lit, `${owner} ${kind} ${size} ${res}x on the pill`).toBeGreaterThan((size < 16 ? 8 : 14) * res * res);
          }
    }
  });

  it('keeps a near-black nation dark with a lighter rim on its parts, apart from a grey nation', () => {
    for (const owner of [[44, 46, 56], [12, 12, 14], [0, 0, 0]] as [number, number, number][]) {
      expect(lightRimFor(owner)).toBe(true);
      const t = iconTones(owner);
      expect(luma(t[2])).toBeGreaterThanOrEqual(45);
      expect(luma(t[2])).toBeLessThanOrEqual(55);
      // black and grey players still look different
      expect(luma(iconTones([128, 128, 128])[2]) - luma(t[2])).toBeGreaterThan(50);
      for (const size of SIZES) {
        const rim = opaque(bakeTroopIcon('infantry', owner, size)).filter((c) => luma(c) > luma(t[2]) + 70 && Math.abs(c[0] - c[2]) < 30).length;
        expect(rim, `${owner} ${size}`).toBeGreaterThan(size < 16 ? 3 : 6);
      }
    }
    for (const owner of [[64, 160, 255], [232, 232, 228], [236, 196, 64]] as [number, number, number][]) expect(lightRimFor(owner)).toBe(false);
  });

  it('is deterministic and crisp: the same bitmap every time, every pixel either solid, the outline or empty', () => {
    for (const res of RES)
      for (const size of SIZES)
        for (const kind of KINDS) {
          const a = bakeTroopIcon(kind, [92, 178, 84], size, res);
          const b = bakeTroopIcon(kind, [92, 178, 84], size, res);
          expect(diff(a, b)).toBe(0);
          for (let i = 3; i < a.data.length; i += 4) expect([0, 235, 255]).toContain(a.data[i]);
        }
  });
});

describe('troop pills with bare units', () => {
  const prev = artStyleOf('troopIcons');
  afterEach(() => setArtStyle('troopIcons', prev));

  function fakeCtx(rects: [number, number, number, number][]): CanvasRenderingContext2D {
    return new Proxy({ fillStyle: '', font: '', textAlign: 'left', textBaseline: 'alphabetic', imageSmoothingEnabled: true } as Record<string, unknown>, {
      get: (o, k) => {
        if (k in o) return o[k as string];
        if (k === 'measureText') return (t: string) => ({ width: t.length * 6 });
        if (k === 'fillRect') return (x: number, y: number, w: number, h: number) => rects.push([x, y, w, h]);
        return () => undefined;
      },
      set: (o, k, v) => ((o[k as string] = v), true),
    }) as unknown as CanvasRenderingContext2D;
  }

  it('marks the detailed icons as bare and the other styles as plated', () => {
    expect(styleModule('detailed').troopIcons.bare).toBe(true);
    expect(styleModule('refined').troopIcons.bare).toBeFalsy();
    expect(styleModule('realistic').troopIcons.bare).toBeFalsy();
  });

  it('runs the pill plate under the bare units and sets them side by side by their real widths', () => {
    setArtStyle('troopIcons', 'detailed');
    const mixes: TroopIconKind[][] = [['infantry', 'armor', 'artillery'], ['armor', 'infantry'], ['troops'], ['artillery', 'infantry']];
    for (const small of [false, true])
      for (const kinds of mixes) {
        const rects: [number, number, number, number][] = [];
        const ctx = fakeCtx(rects);
        const size = troopPillSize(ctx, 12400, kinds, { arrow: 'up', small });
        const w = troopPill(ctx, 200, 100, 12400, kinds, [64, 160, 255], { edge: '#ffe98a', arrow: 'up', small });
        expect(w).toBe(size.w);
        const x0 = Math.round(200 - w / 2);
        // the plate's outline is the first rect: the whole pill
        expect(rects[0]).toEqual([x0, Math.round(100 - size.h / 2), w, size.h]);
        // the units' real widths with 3 px of air before, between and after them, then the count and the arrow
        const plate = small ? 12 : 16;
        const units = kinds.reduce((s, k) => s + troopIconSpan(k, plate).w, 0);
        expect(w).toBe(3 + units + 3 * (kinds.length - 1) + 3 + `${formatCount(12400)} troops`.length * 6 + 6 + (small ? 7 : 9));
      }
  });

  it('measures each kind by its own width: a tank or gun is wider than the soldier', () => {
    for (const size of SIZES) {
      expect(troopIconSpan('armor', size).w).toBeGreaterThan(troopIconSpan('infantry', size).w);
      expect(troopIconSpan('artillery', size).w).toBeGreaterThan(troopIconSpan('infantry', size).w);
      for (const k of KINDS) {
        const s = troopIconSpan(k, size);
        expect(s.x).toBeGreaterThanOrEqual(0);
        expect(s.x + s.w).toBeLessThanOrEqual(size + 2);
      }
    }
  });

  it('keeps the plated layout for the refined style', () => {
    setArtStyle('troopIcons', 'refined');
    const rects: [number, number, number, number][] = [];
    const ctx = fakeCtx(rects);
    const w = troopPill(ctx, 200, 100, 12400, ['infantry', 'armor'], [64, 160, 255], { edge: '#ffe98a', arrow: 'up' });
    expect(w).toBe(troopPillSize(ctx, 12400, ['infantry', 'armor'], { arrow: 'up' }).w);
    const x0 = Math.round(200 - w / 2);
    // the plate starts under the markers' right end, not at the pill's left edge
    expect(rects[0][0]).toBeGreaterThan(x0 + 16);
  });

  it('shows no infantry marker: armor and artillery only, a plain infantry army is the count alone', () => {
    expect(troopKinds({ infantry: 1000, armor: 0, artillery: 0 })).toEqual([]);
    expect(troopKinds({ infantry: 0, armor: 0, artillery: 0 })).toEqual([]);
    expect(troopKinds({ infantry: 700, armor: 200, artillery: 100 })).toEqual(['armor']);
    expect(troopKinds({ infantry: 500, armor: 300, artillery: 200 })).toEqual(['armor', 'artillery']);
    expect(troopKinds({ infantry: 950, armor: 50, artillery: 0 })).toEqual([]);
    expect(troopKinds({ infantry: 100, armor: 50, artillery: 850 })).toEqual(['artillery']);
    expect(troopKinds(null)).toEqual(['troops']);
    for (const style of ['refined', 'detailed', 'realistic'] as const) {
      setArtStyle('troopIcons', style);
      const rects: [number, number, number, number][] = [];
      const ctx = fakeCtx(rects);
      const w = troopPill(ctx, 200, 100, 5400, [], [64, 160, 255], { edge: '#ffe98a', arrow: 'up' });
      expect(w, style).toBe(troopPillSize(ctx, 5400, [], { arrow: 'up' }).w);
      // the plate covers the whole pill (no marker room on its left), with even padding round the count
      expect(rects[0][0], style).toBe(Math.round(200 - w / 2));
      expect(rects[0][2], style).toBe(w);
      expect(w, style).toBe(6 + '5.4k troops'.length * 6 + 6 + 9);
    }
  });
});
