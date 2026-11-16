// "The Ringlands": a hand-drawn fictional map. Three concentric mountain walls around a small core, the gap between the
// walls growing outward, each wall with a few gates that are offset from the gates of the next wall; a wide open land
// outside the outer wall, then sea all around. Drawn for this project from our own shapes (see drawn/kit.ts).
import type { DrawnMap } from './kit';
import { blob, fractal, makePlane, path, rngFor, smoothClosed, strip, walledRings, islandChain } from './kit';
import type { Pt } from './kit';
import type { SpawnDef } from '../defs';

export const RINGLANDS_PLANE = makePlane(64, 44, 42);
const pl = RINGLANDS_PLANE;
const deg = (d: number): number => (d * Math.PI) / 180;

const CX = -4;
const CY = 0;

const rings = walledRings({
  cx: CX,
  cy: CY,
  radii: [3.4, 6.3, 11.2],
  thick: 0.27,
  gates: [
    [100, 280],
    [20, 150, 255],
    [75, 195, 315],
  ],
  gateWidth: 0.25,
  wobble: 0.025,
  foot: 0.4,
  rng: rngFor(101),
  plane: pl,
});

const continent: Pt[] = fractal(
  smoothClosed([
    [-27, 2], [-25, 9], [-19, 15], [-10, 17.5], [-2, 16], [6, 18.5], [15, 17], [23, 13], [28, 6], [27, -2], [29, -8],
    [22, -9.5], [18, -4.5], [14, -9.5], [16, -14], [9, -17], [0, -16], [-9, -17.5], [-18, -14], [-25, -8],
  ]),
  rngFor(7),
  0.16,
  4,
  0.1,
);

const smallIslands = islandChain([[24, -15], [28, -12], [30, -17]], 3, 0.5, 1.1, rngFor(31), 0.8).concat(islandChain([[-27, 14], [-30, 9]], 2, 0.6, 1.0, rngFor(32), 0.6));

const lake = fractal(blob(-8.5, -8.3, 1.0, 0.65, rngFor(41), 0.1, 0.4), rngFor(42), 0.12, 3, 0.08);
const innerRiver = path([-9.4, -7.8], [-13, -13], rngFor(51), 0.6);
const outerRiver = path([8, 14], [24, 1], rngFor(52), 2).concat(path([24, 1], [20, -6.5], rngFor(53), 1).slice(1));
const rngR = rngFor(61);

export const RINGLANDS: DrawnMap = {
  land: [continent, ...smallIslands].map((p) => pl.ring(p)),
  lakes: [pl.ring(lake)],
  rivers: [pl.ring(innerRiver), pl.ring(outerRiver)],
  regions: [
    ...rings.regions,
    { name: 'Northeast range', kind: 'mountains', strength: 0.8, poly: pl.ring(strip(path([7, 15], [19, 6], rngR, 1.2), 0.9)) },
    { name: 'South downs', kind: 'hills', poly: pl.ring(blob(8, -12, 5, 2, rngR, 0.2)) },
    { name: 'West downs', kind: 'hills', poly: pl.ring(blob(-20, -3, 3, 5, rngR, 0.2)) },
    { name: 'Eastern steppe', kind: 'steppe', poly: pl.ring(blob(15, 2, 9, 7, rngR, 0.15)) },
    { name: 'Salt waste', kind: 'desert', poly: pl.ring(blob(22, 9, 5.5, 3.8, rngR, 0.18)) },
    { name: 'Ringwood', kind: 'woods', poly: pl.ring(blob(CX, CY, 9.5, 9.5, rngR, 0.1)) },
    { name: 'Western forest', kind: 'woods', poly: pl.ring(blob(-18, 8, 6, 7, rngR, 0.15)) },
    { name: 'Southern forest', kind: 'woods', poly: pl.ring(blob(-6, -14, 9, 2.5, rngR, 0.15)) },
    { name: 'Coast fen', kind: 'swamp', poly: pl.ring(blob(3, -13.5, 2.6, 1.4, rngR, 0.2)) },
  ],
  oilZones: [pl.ring(blob(22, 9, 5, 3.5, rngR, 0.15)), pl.ring(blob(18, -9, 3, 2, rngR, 0.15))],
  paint: rings.paint,
};

const at = (p: Pt): number[] => pl.P(p[0], p[1]);
const sp = (name: string, p: Pt, major = false): SpawnDef => ({ name, at: at(p), major, pop: major ? 2_000_000 : 1_000_000 });

export const RINGLANDS_SPAWNS: SpawnDef[] = [
  sp('Aldmere', [CX, CY], true),
  sp('Brannoch', rings.between(1, deg(190))),
  sp('Corvane', rings.between(1, deg(350))),
  sp('Dunmarrow', rings.between(2, deg(55)), true),
  sp('Eskerin', rings.between(2, deg(135))),
  sp('Halvard', rings.between(2, deg(250)), true),
  sp('Ilmarsh', rings.between(2, deg(335))),
  sp('Kestrelmoor', [12, 4], true),
  sp('Norvane', [-18, 8]),
  sp('Orlith', [-6, -14.5]),
];
