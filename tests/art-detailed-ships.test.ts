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

describe('detailed ships told apart', () => {
  it('sizes them so the battleship is much bigger than the cruiser and the destroyer a long thin needle', () => {
    const len = (k: SpriteKey): number => modelLength(unitModel(k, 0));
    expect(len('battleship')).toBeGreaterThan(48);
    expect(len('battleship')).toBeGreaterThan(len('warship') * 1.4);
    expect(len('carrier')).toBeGreaterThan(len('battleship') * 1.15);
    expect(len('warship')).toBeGreaterThan(len('destroyer') * 1.2);
    // the hull (the first part) of the destroyer: at least 6.5 times as long as it is wide
    const [u0, v0, u1, v1] = partBox(parts('destroyer')[0]);
    expect((u1 - u0) / (v1 - v0)).toBeGreaterThan(6.5);
    // the battleship's beam is nearly three destroyers'
    const beam = (k: SpriteKey): number => {
      const b = partBox(parts(k)[0]);
      return b[3] - b[1];
    };
    expect(beam('battleship')).toBeGreaterThan(beam('destroyer') * 2.8);
    expect(modelSpan(unitModel('submarine', 0))).toBeLessThan(modelSpan(unitModel('warship', 0)));
  });

  it('arms them differently: four triple turrets of thick barrels, three twin turrets, single mounts', () => {
    const barrels = (k: SpriteKey, w: number): number => parts(k).filter((p) => p.k === 'seg' && p.sh === 'cyl' && Math.abs(p.p[4] - w) < 1e-6).length;
    expect(barrels('battleship', 1.2)).toBe(12);
    expect(barrels('warship', 0.8)).toBe(6);
    expect(barrels('destroyer', 0.9)).toBe(3);
    // the destroyer's torpedo tubes: two banks of three long tubes swung across the deck, the one thing no other ship has
    const tubes = (k: SpriteKey): number => parts(k).filter((p) => p.k === 'seg' && Math.abs(p.p[4] - 0.75) < 1e-6 && Math.hypot(p.p[2] - p.p[0], p.p[3] - p.p[1]) > 3).length;
    expect(tubes('destroyer')).toBe(6);
    for (const k of ['warship', 'battleship', 'submarine', 'carrier'] as const) expect(tubes(k), k).toBe(0);
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
    // fewer old guns: the battleship loses its X turret, the cruiser its B turret, the destroyer two of its mounts
    const barrels = (k: SpriteKey, m: number): number => parts(k, m).filter((p) => p.k === 'seg' && p.sh === 'cyl' && (p.m === 'gun' || p.m === 'sup')).length;
    expect(barrels('battleship', M_MASTERY)).toBe(barrels('battleship', 0) - 3);
    expect(barrels('warship', M_MASTERY)).toBe(barrels('warship', 0) - 2);
    expect(barrels('destroyer', M_MASTERY)).toBe(barrels('destroyer', 0) - 2);
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
          const end = parts(k, m).some((p) => p.k === 'seg' && p.sh === 'cyl' && Math.hypot(p.p[2] - g[0], p.p[3] - g[1]) < 0.05);
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
