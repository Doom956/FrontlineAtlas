// "The Sundered Sea": a hand-drawn fictional map. A strong island nation (with a small version of the walled rings:
// three mountain walls round a core) lies across a strait from a much bigger mainland with many nations, a great
// desert, mountain ranges and a long, bitten coast of peninsulas. A scatter of small islands lies in the strait, where
// landings and fleets decide the war. Drawn for this project from our own shapes (see drawn/kit.ts).
import type { DrawnMap } from './kit';
import { blob, fractal, islandChain, makePlane, path, rngFor, smoothClosed, strip, walledRings } from './kit';
import type { Pt } from './kit';
import type { SpawnDef } from '../defs';

export const SUNDERED_PLANE = makePlane(96, 50, 38);
const pl = SUNDERED_PLANE;
const deg = (d: number): number => (d * Math.PI) / 180;

const IX = -35;
const IY = 0;
const rings = walledRings({
  cx: IX,
  cy: IY,
  radii: [1.7, 3.3, 5.9],
  thick: 0.27,
  gates: [[90, 270], [10, 160, 235], [60, 190, 310]],
  gateWidth: 0.25,
  wobble: 0.03,
  foot: 0.4,
  rng: rngFor(201),
  plane: pl,
});

const island: Pt[] = fractal(blob(IX, IY, 9.8, 11, rngFor(11), 0.14, 0.3), rngFor(12), 0.14, 4, 0.1);

const mainland: Pt[] = fractal(
  smoothClosed([
    [-12, 16], [-6, 21], [4, 19], [10, 23], [14, 19], [24, 21], [34, 18], [39, 17], [41, 20.5], [43, 15.5], [46, 12], [44, 5], [47.5, -3], [43, -9],
    [47, -11], [46, -16], [40, -21.5], [33, -17], [28, -22], [20, -20], [14, -24], [9, -19], [0, -21], [-8, -17], [-12, -9], [-8, -3], [-13, 4],
  ]),
  rngFor(13),
  0.22,
  5,
  0.1,
);

const strait = islandChain([[-20, 10], [-22, 2], [-20, -6], [-18, -13]], 4, 0.7, 1.5, rngFor(14), 1.2).concat(
  islandChain([[-26, 16], [-24, -17]], 2, 0.6, 1.0, rngFor(15), 0.8),
  islandChain([[52, 6], [53, -8]], 2, 1.0, 1.6, rngFor(16), 0.8),
);

const rngR = rngFor(71);
const rangeN = path([4, 15], [22, 8], rngR, 1.4);
const rangeS = path([22, 8], [20, -14], rngR, 1.2);
const rangeE = path([42, 14], [40, -4], rngR, 1.0);
const river1 = path([6, 14], [-4, -4], rngR, 2).concat(path([-4, -4], [-11, -7], rngR, 1).slice(1));
const river2 = path([34, 10], [44, -4], rngR, 2);
const river3 = path([22, -16], [30, -20], rngR, 1.2);

export const SUNDERED: DrawnMap = {
  land: [island, mainland, ...strait].map((p) => pl.ring(p)),
  lakes: [pl.ring(fractal(blob(-33, -8, 0.9, 0.6, rngR, 0.1, 0.4), rngR, 0.12, 3, 0.08)), pl.ring(fractal(blob(14, -2, 1.6, 1.0, rngR, 0.12, 0.3), rngR, 0.12, 3, 0.08))],
  rivers: [river1, river2, river3].map((p) => pl.ring(p)),
  regions: [
    ...rings.regions,
    { name: 'Northern spine', kind: 'mountains', strength: 0.8, poly: pl.ring(strip(rangeN, 0.9)) },
    { name: 'Southern spine', kind: 'mountains', strength: 0.78, poly: pl.ring(strip(rangeS, 0.8)) },
    { name: 'Eastern ridge', kind: 'mountains', strength: 0.78, poly: pl.ring(strip(rangeE, 0.8)) },
    { name: 'Spine foothills', kind: 'hills', poly: pl.ring(strip(rangeN, 2.4)) },
    { name: 'Southern foothills', kind: 'hills', poly: pl.ring(strip(rangeS, 2.2)) },
    { name: 'Eastern foothills', kind: 'hills', poly: pl.ring(strip(rangeE, 2)) },
    { name: 'Southwest hills', kind: 'hills', poly: pl.ring(blob(-2, -14, 4, 2.5, rngR, 0.2)) },
    { name: 'Southeast hills', kind: 'hills', poly: pl.ring(blob(41, -14.5, 3.2, 2, rngR, 0.2)) },
    { name: 'Island fells', kind: 'hills', poly: pl.ring(blob(-40, 6, 3, 2, rngR, 0.2)) },
    { name: 'Great waste', kind: 'desert', poly: pl.ring(blob(31, -3, 9.5, 7, rngR, 0.18)) },
    { name: 'Western waste', kind: 'desert', poly: pl.ring(blob(10, -11, 4, 3, rngR, 0.2)) },
    { name: 'Northern steppe', kind: 'steppe', poly: pl.ring(blob(24, 16, 9, 3.5, rngR, 0.15)) },
    { name: 'Island wood', kind: 'woods', poly: pl.ring(blob(IX, IY, 5.5, 5.5, rngR, 0.1)) },
    { name: 'Western forest', kind: 'woods', poly: pl.ring(blob(-2, 8, 5, 7, rngR, 0.15)) },
    { name: 'Southern jungle', kind: 'wet', poly: pl.ring(blob(36, -17, 8, 3, rngR, 0.15)) },
    { name: 'Delta fen', kind: 'swamp', poly: pl.ring(blob(43.5, -6, 2, 3, rngR, 0.2)) },
    { name: 'Coast fen', kind: 'swamp', poly: pl.ring(blob(-8, -13, 2, 1.5, rngR, 0.2)) },
    { name: 'Cold cape', kind: 'tundra', poly: pl.ring(blob(37, 20, 5, 1.6, rngR, 0.2)) },
  ],
  oilZones: [pl.ring(blob(31, -3, 8.5, 6, rngR, 0.15)), pl.ring(blob(-30, 8, 2.5, 2, rngR, 0.15))],
  paint: rings.paint,
};

const sp = (name: string, p: Pt, major = false): SpawnDef => ({ name, at: pl.P(p[0], p[1]), major, pop: major ? 2_000_000 : 1_000_000 });

export const SUNDERED_SPAWNS: SpawnDef[] = [
  // the island: a strong nation in the walled core and one in its outer lands
  sp('Taruvan', [IX, IY], true),
  sp('Selvane', rings.between(2, deg(100))),
  // the mainland
  sp('Brenmar', [-6, 14]),
  sp('Khoril', [10, 20]),
  sp('Vashti', [24, 17], true),
  sp('Dorrin', [12, 8]),
  sp('Zephren', [31, -3], true),
  sp('Oskaren', [40, 12]),
  sp('Marlowe', [-3, -9]),
  sp('Tyrnak', [42, -17]),
  sp('Ulvane', [16, -20], true),
  sp('Calvern', [28, 10]),
];
