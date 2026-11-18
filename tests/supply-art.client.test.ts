// The supply lines' ground pixels (art/detailed/supplyArt.ts railArt, pure): drawn on the map's own art-pixel grid,
// the same every time, hidden far out, one thin line at normal zoom, the full rail close up, and a train of 3 to 5
// wagons behind its engine.
import { describe, expect, it } from 'vitest';
import { MILITARY_CARS, SUPPLY_CARS, railArt, railLook, trainCars } from '../src/client/art/detailed/supplyArt';
import type { TrackGround } from '../src/client/art/detailed/buildingLinkArt';
import { GROUND } from '../src/client/render/ground';
import type { RGB } from '../src/client/render/common';

const ground = (P: number, terrainAt: (x: number, y: number) => number = () => 2): TrackGround => ({ P, terrainAt, ramps: GROUND, tint: (c: RGB) => c });
const line: [number, number][] = [[2.5, 5.5], [8.5, 6.5], [14.5, 5.5]];
const solid = (rgba: Uint8ClampedArray): number => {
  let n = 0;
  for (let i = 3; i < rgba.length; i += 4) if (rgba[i]) n++;
  return n;
};

describe('rail pixels', () => {
  it('has a look per zoom: none far out, a line at normal zoom, the full rail close up', () => {
    expect(railLook(2)).toBe('none');
    expect(railLook(4)).toBe('line');
    expect(railLook(8)).toBe('close');
    expect(railLook(16)).toBe('close');
    expect(solid(railArt([line], ground(2), 1).rgba)).toBe(0);
    const thin = railArt([line], ground(4), 1);
    const full = railArt([line], ground(16), 1);
    // the normal look is a soft dark line, about two art pixels wide (12 tiles long)
    expect(solid(thin.rgba)).toBeGreaterThan(40);
    expect(solid(thin.rgba)).toBeLessThan(190);
    expect(solid(full.rgba)).toBeGreaterThan(solid(thin.rgba) * 10);
  });

  it('is the same every time', () => {
    const a = railArt([line], ground(16), 3, { line: 0, s0: 4, s1: 5.4 });
    const b = railArt([line], ground(16), 3, { line: 0, s0: 4, s1: 5.4 });
    expect(Array.from(b.rgba)).toEqual(Array.from(a.rgba));
  });

  it('paints only land and the bridge over the water it crosses', () => {
    // a river at x 7..8: the bridge pixels stay within the rail's width
    const wet = (x: number): boolean => x >= 7 && x <= 8;
    const px = railArt([line], ground(16, (x) => (wet(x) ? 1 : 2)), 1);
    let onWater = 0;
    for (let j = 0; j < px.h; j++) {
      for (let i = 0; i < px.w; i++) {
        const o = (j * px.w + i) * 4;
        if (!px.rgba[o + 3]) continue;
        const qx = (px.x0 + i + 0.5) / 16;
        if (wet(Math.floor(qx))) onWater++;
      }
    }
    expect(onWater).toBeGreaterThan(0);
    // a line wholly over water is all bridge deck: no land colours, still drawn
    const sea = railArt([[[2.5, 2.5], [6.5, 2.5]]], ground(16, () => 0), 1);
    expect(solid(sea.rgba)).toBeGreaterThan(0);
  });
});

describe('trains', () => {
  it('runs an engine and tender with 2 to 3 wagons', () => {
    for (const load of [0, 1, 2, 3, 9]) {
      const cars = trainCars(load);
      expect(cars.slice(0, 2)).toEqual(['engine', 'tender']);
      expect(cars.length - 2).toBeGreaterThanOrEqual(2);
      expect(cars.length - 2).toBeLessThanOrEqual(3);
    }
  });

  it('always carries a military load and a supply load, the same every time', () => {
    for (let seed = 0; seed < 40; seed++) {
      for (const load of [0, 1, 2, 3]) {
        const cars = trainCars(load, seed);
        expect(cars.some((c) => MILITARY_CARS.includes(c))).toBe(true);
        expect(cars.some((c) => SUPPLY_CARS.includes(c))).toBe(true);
        expect(trainCars(load, seed)).toEqual(cars);
      }
    }
    expect(new Set(Array.from({ length: 40 }, (_, i) => trainCars(3, i).join())).size).toBeGreaterThan(5);
  });
});
