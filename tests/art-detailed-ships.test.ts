// The detailed ships after the owner asked for every type to be told apart and every upgrade to show: a battleship
// much bigger than the cruiser with four big triple turrets, a destroyer that is a long thin needle with torpedo tubes,
// a submarine outlined in white water, the plain warship with its teak deck; Naval Mastery as a modern refit (radar
// domes, missile launchers, a nuclear boat, a supercarrier) and Naval Mines as yellow banded mines on rails aft, each
// a change of many pixels at the game's normal zoom, with the guns that fire still where the flashes come from.
import { describe, expect, it } from 'vitest';
import { partBox, rasterize, solidCount, type Baked, type Part } from '../src/client/art/detailed/bake';
import { modelLength, modelSpan, MOD_MASK, unitModel } from '../src/client/art/detailed/models';
import { detailedUnits } from '../src/client/art/detailed/units';
import { ALL_MODS, M_MASTERY, M_SPECIAL, SHIP_KEYS, type SpriteKey } from '../src/client/art/shared/keys';

const OWNER = [196, 70, 56] as const;
const bake = (key: SpriteKey, mods: number, res = 1, facing = 4): Baked => rasterize(unitModel(key, mods).model, res, facing, { facings: 32, owner: OWNER, roll: 0 });
const parts = (key: SpriteKey, mods = 0): Part[] => unitModel(key, mods).model.parts as Part[];

/** Art pixels that differ clearly between two bakes laid over each other by their origins, and the first's solid count. */
function changed(a: Baked, b: Baked): number {
  const at = (B: Baked, x: number, y: number): number[] => {
    const X = x + B.ox;
    const Y = y + B.oy;
    if (X < 0 || Y < 0 || X >= B.w || Y >= B.h) return [0, 0, 0, 0];
    const o = (Y * B.w + X) * 4;
    return [B.data[o], B.data[o + 1], B.data[o + 2], B.data[o + 3]];
  };
  let n = 0;
  for (let y = -Math.max(a.oy, b.oy); y < Math.max(a.h - a.oy, b.h - b.oy); y++)
    for (let x = -Math.max(a.ox, b.ox); x < Math.max(a.w - a.ox, b.w - b.ox); x++) {
      const p = at(a, x, y);
      const q = at(b, x, y);
      if (Math.abs(p[0] - q[0]) + Math.abs(p[1] - q[1]) + Math.abs(p[2] - q[2]) + Math.abs(p[3] - q[3]) > 60) n++;
    }
  return n;
}

const WARSHIPS = ['warship', 'destroyer', 'battleship', 'submarine', 'carrier'] as const;

/** A turret's guns: one bar along the centreline, standing on the deck (not a decal, not a mine rail). */
const gunBars = (k: SpriteKey, m = 0): Part[] => parts(k, m).filter((p) => p.k === 'seg' && p.p[1] === 0 && p.p[3] === 0 && (p.m === 'sup' || p.m === 'black') && p.h >= 0.4 && !p.minRes);

function inPoly(p: readonly number[], u: number, v: number): boolean {
  let inside = false;
  for (let i = 0, j = p.length - 2; i < p.length; j = i, i += 2) {
    if (p[i + 1] > v !== p[j + 1] > v && u < ((p[j] - p[i]) * (v - p[i + 1])) / (p[j + 1] - p[i + 1]) + p[i]) inside = !inside;
  }
  return inside;
}

describe('detailed ships told apart', () => {
  it('sizes them so the battleship is much bigger than the cruiser and the destroyer a long thin needle', () => {
    const len = (k: SpriteKey): number => modelLength(unitModel(k, 0));
    expect(len('battleship')).toBeGreaterThan(48);
    expect(len('battleship')).toBeGreaterThan(len('warship') * 1.4);
    expect(len('carrier')).toBeGreaterThan(len('battleship') * 1.15);
    expect(len('warship')).toBeGreaterThan(len('destroyer') * 1.2);
    // the hull (the first part) of the destroyer: over five times as long as it is wide, the slimmest warship (wide
    // enough for its tube banks to read at mid zoom)
    const ratio = (k: SpriteKey): number => {
      const [u0, v0, u1, v1] = partBox(parts(k)[0]);
      return (u1 - u0) / (v1 - v0);
    };
    expect(ratio('destroyer')).toBeGreaterThan(5.2);
    for (const k of ['warship', 'battleship'] as const) expect(ratio('destroyer'), k).toBeGreaterThan(ratio(k));
    // the battleship's beam is about two and a half destroyers'
    const beam = (k: SpriteKey): number => {
      const b = partBox(parts(k)[0]);
      return b[3] - b[1];
    };
    expect(beam('battleship')).toBeGreaterThan(beam('destroyer') * 2.4);
    expect(modelSpan(unitModel('submarine', 0))).toBeLessThan(modelSpan(unitModel('warship', 0)));
  });

  it('arms them differently: four big turrets with light gun bars, three twin turrets, single mounts', () => {
    // a turret's guns lie as one bar along the centreline, at least two px thick at mid zoom where they matter
    const width = (k: SpriteKey, m = 0): number[] => gunBars(k, m).map((p) => p.p[4]);
    expect(width('battleship')).toHaveLength(4);
    expect(width('warship')).toHaveLength(3);
    expect(width('destroyer')).toHaveLength(2);
    for (const w of [...width('battleship'), ...width('warship')]) expect(w * 0.84).toBeGreaterThanOrEqual(1.7);
    // light guns on the battleship's dark deck, black guns on the lighter decks
    for (const p of gunBars('battleship')) expect(p.m).toBe('sup');
    for (const p of [...gunBars('warship'), ...gunBars('destroyer')]) expect(p.m).toBe('black');
    // every bar ends inside the deck edge
    for (const k of ['warship', 'destroyer', 'battleship'] as const) {
      const hull = parts(k)[0].p;
      for (const p of gunBars(k)) {
        const h = p.p[4] / 2;
        expect(inPoly(hull, p.p[2] + Math.sign(p.p[2] - p.p[0]) * 0.2, h), `${k} bar ${p.p[2]}`).toBe(true);
      }
    }
    // the destroyer's torpedo tubes: two banks, each one thick dark bar across most of the beam, the one thing no
    // other ship has
    const tubes = (k: SpriteKey, m = 0): Part[] => parts(k, m).filter((p) => p.k === 'seg' && p.m === 'black' && p.h > 0.4 && Math.abs(p.p[3] - p.p[1]) > 3);
    expect(tubes('destroyer')).toHaveLength(2);
    for (const t of tubes('destroyer')) {
      expect(t.p[4]).toBeGreaterThanOrEqual(1.7);
      expect(Math.abs(t.p[3] - t.p[1])).toBeGreaterThan(0.75 * 2 * 2.6);
    }
    for (const k of ['warship', 'battleship', 'submarine', 'carrier'] as const) expect(tubes(k), k).toHaveLength(0);
  });

  it('leaves dark deck between the battleship turrets and teak between the cruiser turrets', () => {
    // the gun houses along the hull: u from the house polygons; neighbours at least a pixel apart at mid zoom
    for (const k of ['battleship', 'warship'] as const) {
      const houses = parts(k)
        .filter((p) => p.k === 'poly' && (p.m === 'sup' || p.m === 'gun') && p.p.length === 16 && p.h >= 1.2)
        .map((p) => partBox(p))
        .sort((a, b) => a[0] - b[0]);
      expect(houses.length, k).toBe(k === 'battleship' ? 4 : 3);
      for (let i = 1; i < houses.length; i++) expect(houses[i][0] - houses[i - 1][2], `${k} ${i}`).toBeGreaterThanOrEqual(1);
    }
  });

  it('shows the owner colour lit on top of every funnel, so it reads from above at mid zoom', () => {
    for (const k of ['warship', 'destroyer', 'battleship', 'carrier'] as const) {
      const ps = parts(k);
      const tops = ps.filter((p) => p.m === 'own' && p.k === 'ell' && p.h === 0);
      expect(tops.length, k).toBeGreaterThanOrEqual(1);
      // a top: nothing of the funnel above it, and at least two units across
      for (const t of tops) expect(Math.min(t.p[2], t.p[3]) * 2, k).toBeGreaterThanOrEqual(2);
    }
  });

  it('gives each its own colour: a teak deck on the cruiser, a dark steel deck on the battleship, a near black submarine with a white rim', () => {
    const mats = (k: SpriteKey): Set<string> => new Set(parts(k).map((p) => p.m));
    expect(mats('warship').has('teak')).toBe(true);
    for (const k of ['destroyer', 'battleship', 'carrier', 'submarine'] as const) expect(mats(k).has('teak'), k).toBe(false);
    expect(mats('battleship').has('bbdeck')).toBe(true);
    expect(mats('submarine').has('sub') && mats('submarine').has('foam')).toBe(true);
    // the destroyer is the lightest warship: its deck (the third part) a tone lighter
    expect(parts('destroyer')[2].tone).toBeGreaterThan(0);
  });

  it('looks different from every other ship at the normal zoom', () => {
    const keys = SHIP_KEYS;
    for (let i = 0; i < keys.length; i++)
      for (let j = i + 1; j < keys.length; j++) {
        const a = bake(keys[i], 0);
        const b = bake(keys[j], 0);
        const n = changed(a, b);
        expect(n, `${keys[i]} vs ${keys[j]}`).toBeGreaterThan(0.4 * Math.min(solidCount(a), solidCount(b)));
      }
  });
});

describe('detailed ship upgrades', () => {
  it('change the picture by many pixels at the normal zoom, whatever the heading', () => {
    for (const k of WARSHIPS)
      for (const bit of [M_MASTERY, M_SPECIAL]) {
        expect(MOD_MASK[k] & bit, k).toBe(bit);
        for (const facing of [4, 28, 12]) {
          const plain = bake(k, 0, 1, facing);
          const n = changed(plain, bake(k, bit, 1, facing));
          expect(n, `${k} ${bit} facing ${facing}`).toBeGreaterThanOrEqual(Math.max(25, 0.12 * solidCount(plain)));
        }
      }
  });

  it('refit the ships with Naval Mastery: white radar domes, missile launchers in place of old guns', () => {
    const domes = (k: SpriteKey, m: number): number => parts(k, m).filter((p) => p.m === 'white' && p.sh === 'dome').length;
    for (const k of ['warship', 'destroyer', 'battleship', 'carrier'] as const) {
      expect(domes(k, 0), k).toBe(0);
      expect(domes(k, M_MASTERY), k).toBeGreaterThanOrEqual(1);
    }
    // fewer old guns: the battleship loses its X turret, the cruiser its B turret, the destroyer its aft mount
    for (const k of ['battleship', 'warship', 'destroyer'] as const) expect(gunBars(k, M_MASTERY).length, k).toBe(gunBars(k, 0).length - 1);
    // launch cells: a few big dark hatches (at least a pixel each at mid zoom) on a pale patch
    for (const k of ['battleship', 'warship', 'destroyer', 'carrier'] as const) {
      const cells = parts(k, M_MASTERY).filter((p) => p.k === 'box' && p.m === 'black' && p.h === 0 && !p.minRes && p.tone === 1);
      expect(cells.length, k).toBeGreaterThanOrEqual(2);
      expect(cells.length, k).toBeLessThanOrEqual(8);
      for (const c of cells) expect(Math.min(c.p[2] - c.p[0], c.p[3] - c.p[1]), k).toBeGreaterThanOrEqual(0.99);
    }
    // the carrier's parked propeller planes become jets
    expect(parts('carrier', 0).some((p) => p.m === 'seagrey')).toBe(true);
    expect(parts('carrier', M_MASTERY).some((p) => p.m === 'seagrey')).toBe(false);
  });

  it('turns the submarine into a nuclear boat: longer, no deck gun, fin planes on a sail set forward', () => {
    const plain = unitModel('submarine', 0);
    const nuke = unitModel('submarine', M_MASTERY);
    expect(modelLength(nuke)).toBeGreaterThan(modelLength(plain) + 1.5);
    // the sail: the tallest grey part, set forward of midships on the nuclear boat
    const sail = (um: typeof plain): Part => (um.model.parts as Part[]).filter((p) => p.m === 'hull').reduce((a, b) => (b.z + b.h > a.z + a.h ? b : a));
    const sb = partBox(sail(nuke));
    expect((sb[0] + sb[2]) / 2).toBeGreaterThan(3);
    expect(sail(nuke).h).toBeGreaterThan(sail(plain).h);
    // fin planes reaching out past the sail on both sides
    expect((nuke.model.parts as Part[]).some((p) => p.k === 'seg' && p.m === 'hull' && Math.abs(p.p[1]) > 2.4 && Math.abs(p.p[3]) > 2.4 && p.z > 2)).toBe(true);
    // the hull runs whole to the tail: no sea washed over it, and the tail planes stay close to the hull
    for (const um of [plain, nuke]) {
      expect((um.model.parts as Part[]).some((p) => p.m === 'sea')).toBe(false);
      for (const p of um.model.parts as Part[]) if (p.k === 'seg' && p.m === 'hullDark' && p.p[0] === p.p[2]) expect(Math.abs(p.p[1])).toBeLessThan(1.7);
    }
  });

  it('lays a yellow and black row of mines on dark rails aft with Naval Mines', () => {
    for (const k of WARSHIPS) {
      const mines = parts(k, M_SPECIAL).filter((p) => p.m === 'hazard');
      expect(parts(k, 0).filter((p) => p.m === 'hazard').length, k).toBe(0);
      // a row on each side (the submarine one row along its casing)
      expect(mines.length, k).toBeGreaterThanOrEqual(k === 'submarine' ? 4 : 6);
      expect(parts(k, M_SPECIAL).some((p) => p.m === 'black' && p.k === 'seg'), k).toBe(true);
      // all of them in the aft half
      for (const p of mines) expect(p.p[0], k).toBeLessThan(0);
    }
  });

  it('makes the upgrades big enough to read at the normal zoom: a radar dome three px across, mines a pixel apart', () => {
    for (const k of ['warship', 'destroyer', 'battleship', 'carrier'] as const) {
      const domes = parts(k, M_MASTERY).filter((p) => p.m === 'white' && p.sh === 'dome' && p.k === 'ell');
      const r = Math.max(...domes.map((p) => Math.min(p.p[2], p.p[3])));
      expect(r, k).toBeGreaterThanOrEqual(1.5);
    }
    for (const k of WARSHIPS) {
      const mines = parts(k, M_SPECIAL).filter((p) => p.m === 'hazard' && p.k === 'ell');
      for (const a of mines)
        for (const b of mines) {
          if (a === b || Math.abs(a.p[1] - b.p[1]) > 0.01) continue;
          // the black between two mines on one rail is at least most of a pixel
          expect(Math.abs(a.p[0] - b.p[0]) - a.p[2] - b.p[2], k).toBeGreaterThan(0.75);
        }
    }
  });

  it('keeps the firing guns where the muzzle flashes come from, refit or not', () => {
    for (const k of ['warship', 'destroyer', 'battleship'] as const) {
      const guns = unitModel(k, 0).guns;
      for (const m of [0, M_MASTERY, ALL_MODS]) {
        expect(unitModel(k, m).guns, k).toEqual(guns);
        // every muzzle is the end of a barrel in the model
        for (const g of guns) {
          const end = gunBars(k, m).some((p) => Math.hypot(p.p[2] - g[0], p.p[3] - g[1]) < 0.05);
          expect(end, `${k} ${m} ${g}`).toBe(true);
        }
      }
    }
    // the battleship fires from three turrets along the hull, the first forward
    const tp = (i: number) => detailedUnits.turretPoint('battleship', 0, i, 100, 100, 0, 1);
    expect(tp(0).x).toBeGreaterThan(115);
    expect(tp(2).x).toBeLessThan(80);
  });

  it('bakes every ship with clear corners and keeps the owner colour small', () => {
    for (const k of SHIP_KEYS)
      for (const m of [0, M_MASTERY, M_SPECIAL, ALL_MODS])
        for (const res of [1, 2]) {
          const b = bake(k, m, res, 5);
          for (const [x, y] of [
            [0, 0],
            [b.w - 1, 0],
            [0, b.h - 1],
            [b.w - 1, b.h - 1],
          ])
            expect(b.data[(y * b.w + x) * 4 + 3], `${k} ${m} ${res}`).toBe(0);
        }
  });
});
