// Seasons and day and night (art/detailed/seasons.ts, pure): the same pixel every time, night never darker than 30%,
// the snow line moving south as winter deepens, sea ice only near coasts in winter, lights only on lit things.
import { describe, expect, it } from 'vitest';
import {
  DAY_SECONDS,
  LIT_KINDS,
  MAX_DARKEN,
  SEASON,
  TIMES,
  darkness,
  dayLight,
  dayTimeAt,
  lightAmount,
  lightCount,
  lightSpots,
  matchGround,
  seaIce,
  seasonGround,
  seasonLook,
  seasonName,
  shadeLight,
  snowCover,
  snowReach,
  suburbLights,
  type GroundSpot,
  type LightKind,
} from '../src/client/art/detailed/seasons';
import { GROUND } from '../src/client/render/ground';

const luma = (c: readonly number[]): number => 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];
const spot = (o: Partial<GroundSpot> = {}): GroundSpot => ({ terrain: 2, qx: 10.3, qy: 7.6, ax: 82, ay: 61, polar: 0.5, landDist: 0, ...o });

// a spread of colours: every ground ramp, plus a grid of others (bright enough that rounding does not decide the ratio)
const COLOURS: number[][] = [];
for (const k of ['grass', 'forest', 'hills', 'rock', 'snow', 'sand', 'swamp', 'tundra', 'wheat', 'crop', 'soil'] as const) for (const c of GROUND[k]) COLOURS.push([...c]);
for (let r = 0; r <= 255; r += 51) for (let g = 0; g <= 255; g += 51) for (let b = 0; b <= 255; b += 51) if (luma([r, g, b]) >= 40) COLOURS.push([r, g, b]);

describe('day and night', () => {
  it('runs a 2 minute day: 1.5 minutes of day, 30 s of night', () => {
    expect(DAY_SECONDS).toBe(120);
    expect(darkness(dayTimeAt(45))).toBe(0);
    expect(darkness(dayTimeAt(105))).toBe(1);
    let night = 0;
    for (let s = 0; s < 120; s += 0.5) night += darkness(dayTimeAt(s)) > 0.5 ? 0.5 : 0;
    expect(night).toBeGreaterThan(28);
    expect(night).toBeLessThan(32);
  });

  it('keeps noon as today and eases through dawn and dusk', () => {
    const noon = dayLight(TIMES.noon);
    expect(noon.dark).toBe(0);
    expect(shadeLight([120, 140, 90], noon)).toEqual([120, 140, 90]);
    expect(darkness(TIMES.dawn)).toBeGreaterThan(0.1);
    expect(darkness(TIMES.dawn)).toBeLessThan(0.9);
    expect(darkness(TIMES.dusk)).toBeGreaterThan(0.1);
    expect(darkness(TIMES.dusk)).toBeLessThan(0.9);
    // no jumps: the darkness changes by little from one moment to the next
    for (let t = 0; t < 1; t += 0.002) expect(Math.abs(darkness(t + 0.002) - darkness(t))).toBeLessThan(0.05);
  });

  it('darkens the ground 25 to 30% at full night with a cool tint, and never more than 30%', () => {
    const night = dayLight(TIMES.night);
    for (const c of COLOURS) {
      const out = shadeLight(c, night);
      const k = luma(out) / luma(c);
      expect(k).toBeGreaterThanOrEqual(0.7 - 0.01);
      expect(k).toBeLessThanOrEqual(0.75 + 0.01);
    }
    // the tint is cool: grey goes blue
    const g = shadeLight([150, 150, 150], night);
    expect(g[2]).toBeGreaterThan(g[0]);
    // at every moment of the day nothing loses more than 30%
    for (let t = 0; t < 1; t += 0.01) {
      const l = dayLight(t);
      for (const c of COLOURS) expect(luma(shadeLight(c, l)) / luma(c)).toBeGreaterThanOrEqual(1 - MAX_DARKEN - 0.012);
    }
  });

  it('is the same every time', () => {
    const a = shadeLight([90, 120, 60], dayLight(0.8));
    const b = shadeLight([90, 120, 60], dayLight(0.8));
    expect(a).toEqual(b);
  });
});

describe('seasons on the ground', () => {
  it('matches the ground pass colours to their ramp and tone', () => {
    expect(matchGround(GROUND.forest[2])).toEqual({ name: 'forest', tone: 2, rest: [0, 0, 0] });
    expect(matchGround(GROUND.wheat[1]).name).toBe('wheat');
  });

  it('gives the same pixel for the same colour and spot', () => {
    const at = spot({ terrain: 3 });
    const a = seasonGround(GROUND.forest[2], at, seasonLook(2));
    const b = seasonGround(GROUND.forest[2], at, seasonLook(2));
    expect(a).toEqual(b);
  });

  it('turns trees red and gold in autumn and fields golden', () => {
    let warm = 0;
    for (let i = 0; i < 40; i++) {
      const c = seasonGround(GROUND.forest[2], spot({ terrain: 3, qx: i * 0.61, qy: i * 0.37, ax: i, ay: i * 3 }), seasonLook(SEASON.autumn));
      if (c[0] > c[1]) warm++;
    }
    expect(warm).toBeGreaterThan(20);
    const summer = seasonGround(GROUND.forest[2], spot({ terrain: 3 }), seasonLook(SEASON.summer));
    expect(summer[1]).toBeGreaterThan(summer[0]);
    const field = seasonGround(GROUND.wheat[2], spot(), seasonLook(SEASON.autumn));
    expect(field[0]).toBeGreaterThan(field[2] + 60);
  });

  it('moves the snow line south as winter deepens', () => {
    expect(snowReach(2.55)).toBeLessThan(snowReach(2.8));
    expect(snowReach(2.8)).toBeLessThan(snowReach(3));
    expect(snowReach(SEASON.summer)).toBeLessThan(0.06);
    // plains half way to the equator: bare in late autumn and early winter, white in deep winter
    expect(snowCover(2.5, 0.5, 0.5, 2)).toBe(0);
    expect(snowCover(3, 0.5, 0.5, 2)).toBe(1);
    // the edge is soft: a band of part cover that the dither breaks up
    expect(snowCover(3, 0.62, 0.5, 2)).toBeGreaterThan(0.2);
    expect(snowCover(3, 0.62, 0.5, 2)).toBeLessThan(0.8);
    // in deep winter the snow pixels are white
    const c = seasonGround(GROUND.grass[2], spot({ polar: 0.2 }), seasonLook(SEASON.winter));
    expect(luma(c)).toBeGreaterThan(200);
  });

  it('freezes the polar sea near coasts in winter only', () => {
    expect(seaIce(SEASON.summer, 0.05, 1, 0.5)).toBe(0);
    expect(seaIce(SEASON.winter, 0.05, 1, 0.5)).toBeGreaterThan(0.9);
    expect(seaIce(SEASON.winter, 0.05, 12, 0.5)).toBe(0);
    expect(seaIce(SEASON.winter, 0.9, 1, 0.5)).toBe(0);
  });

  it('names the season in plain words', () => {
    expect(seasonName(2)).toBe('Autumn');
    expect(seasonName(2.8)).toBe('Early winter');
    expect(seasonName(3.4)).toBe('Late winter');
  });
});

describe('night lights', () => {
  it('lights only lit things: cities, ports, factories, forts, trains, ships, fires', () => {
    const dark: LightKind[] = ['plains', 'farm', 'forest', 'hills', 'mountains', 'desert', 'water', 'empty'];
    for (const k of dark) {
      expect(LIT_KINDS.has(k)).toBe(false);
      expect(lightCount(k, 3)).toBe(0);
      expect(lightSpots(k, 3, 7)).toEqual([]);
      expect(suburbLights(k, 3, 7)).toEqual([]);
    }
    for (const k of ['capital', 'city', 'port', 'factory', 'fort'] as const) {
      expect(LIT_KINDS.has(k)).toBe(true);
      expect(lightSpots(k, 2, 7).length).toBeGreaterThan(0);
    }
  });

  it('gives a bigger city more lights', () => {
    for (let L = 1; L < 5; L++) {
      expect(lightCount('city', L + 1)).toBeGreaterThan(lightCount('city', L));
      expect(suburbLights('city', L + 1, 3).length).toBeGreaterThan(suburbLights('city', L, 3).length);
    }
    expect(lightCount('city', 3)).toBeGreaterThan(lightCount('factory', 3));
  });

  it('turns the lights on at dusk and off by day, the same every time', () => {
    expect(lightAmount(TIMES.noon)).toBe(0);
    expect(lightAmount(TIMES.night)).toBe(1);
    expect(lightSpots('city', 3, 11)).toEqual(lightSpots('city', 3, 11));
  });
});
