// "The Drifting Isles": a hand-drawn fictional map of islands adrift in a sky-blue sea. In the middle lies one great
// horseshoe island whose two arms curl round a round inner bay opening south; round it, across narrow straits, lie a
// long curved ridge to the north, a terraced plateau isle to the west, a bent ridge to the east, a long crescent in the
// northwest, a stepped plateau in the northeast, a fjord isle in the southeast, a hooked cluster of isles in the southwest and
// a long low ridge off the bay mouth, with curving chains of islets between them. Fleets and aircraft decide the war. Drawn
// for this project by hand, point by point (see drawn/kit.ts).
import type { DrawnMap, Pt } from './kit';
import { blob, dense, fractal, islandChain, makePlane, path, rngFor, smoothClosed } from './kit';
import type { SpawnDef } from '../defs';
import type { ExtraRegion } from '../extra';

// shapes are drawn in a 100 x 64 design space (u east, v north, origin at the centre) and shrunk by S so the climate
// band stays mid-latitude
const S = 0.74;
export const DRIFTISLES_PLANE = makePlane(100 * S, 64 * S, 38);
const pl = {
  ring: (pts: Pt[]) => DRIFTISLES_PLANE.ring(pts.map(([u, v]): Pt => [u * S, v * S])),
  P: (u: number, v: number) => DRIFTISLES_PLANE.P(u * S, v * S),
};

/** a hand-drawn outline (design units), smoothed, resampled about every unit, with a fractal coastline of coves and capes */
/** shift a hand-drawn outline by (du, dv) */
const mv = (pts: Pt[], du: number, dv: number): Pt[] => pts.map(([u, v]): Pt => [u + du, v + dv]);

function isle(ctrl: Pt[], seed: number, rough = 0.32, step = 1.8): Pt[] {
  return fractal(dense(smoothClosed(ctrl, 6), step), rngFor(seed), rough, 6, 0.04);
}

/**
 * The great central island as [x %, y %] of its box: x from the west edge, y from the NORTH edge. Clockwise from the
 * northwest shoulder: a broad rounded north, a straight-ish west coast, then the two arms round the inner bay.
 */
const CENTRAL: Pt[] = [
  // north coast: terrace-step headlands and a deep notch near the middle
  [6.5, 10], [10, 6], [16, 5.4], [16, 2.4], [24, 2.2], [24, 0.6], [34, 0.8], [38, 3.4], [45, 4], [49.5, 13], [53.5, 3.2], [58, 1.2], [63, 1.4], [63, 3.6], [72, 3.8], [72, 2], [82, 3.6], [85, 7],
  // the northeast shoulder and the east coast, an inlet halfway down
  [91, 10], [96, 19], [98.5, 30], [99.2, 41], [95, 46.5], [99, 51], [98.4, 58], [96.7, 68.5], [92.7, 78.7],
  // the east arm: cut short, ending in a terraced, blunt cape
  [90.5, 84], [88, 88.4], [84.2, 88.6], [84.2, 92.4], [79.6, 92.4], [78.6, 88.2], [76.2, 82],
  // round the inner bay, from the east arm back to the west arm: deep and round, a harbour for whole fleets
  [75.2, 70.4], [71.2, 59.4], [64, 52.2], [55, 49.6], [46, 51.2], [39.2, 57], [35, 66], [33.6, 77], [35, 87.6],
  // the west arm: long, running far to the southwest, its tip turning west
  [34.6, 94], [31, 100], [25, 104], [17, 106], [10.5, 105], [8.6, 101.6], [12.6, 100.2], [17.6, 97.4], [16.4, 91.6], [11.6, 85.6],
  // the southwest shoulder, a small cape on the west coast, and up to the start
  [5, 77.5], [1.6, 66.3], [0.4, 56], [-1.8, 49.5], [1.2, 44], [1.6, 35], [2.4, 26], [4.1, 17],
];
/** central island box: 30 x 22.8 units, its middle at (0, 0.8) */
const cen = (x: number, y: number): Pt => [-15 + x * 0.3, 12.2 - y * 0.228];

const land: Pt[][] = [];
const add = (p: Pt[]): number => land.push(p) - 1;

add(isle(CENTRAL.map(([x, y]) => cen(x, y)), 501, 0.36, 2));

// the north ridge: long and gently arched, across a narrow strait from the central island
add(isle([[-15.8, 19.4], [-11.8, 20.4], [-9.5, 18.8], [-8, 21.2], [-4.5, 19.6], [-2.5, 21.8], [1, 20], [3.5, 21.6], [6, 19.8], [9.5, 20.2], [12.2, 18.4], [14.5, 16.4], [12.6, 14.8], [8.5, 15.9], [4, 16.6], [-1, 16.6], [-5.5, 16], [-9.8, 14.6], [-12.2, 14.2], [-14.6, 14.6], [-12.6, 16.8]], 502, 0.45));
// the northwest crescent: a long thin arc, its hollow facing the centre
add(isle([
  [-21.5, 25.3], [-26, 26.9], [-31.5, 27.4], [-37, 27], [-42, 24.6], [-45.8, 20.6], [-47.8, 15.4], [-47.8, 10.1], [-47, 5.5], [-45.6, 2.1],
  [-43.6, 2.7], [-42.9, 6.1], [-42.4, 10.1], [-40.4, 15.4], [-37.4, 19.4], [-33.6, 22.4], [-29.4, 23.8], [-25.6, 23.8], [-22.4, 23.4],
], 503, 0.42));
// the west plateau: a stepped terrace isle curled round a cove that opens east
add(isle(mv([[-31, 6], [-27, 7], [-23.5, 6.2], [-19.5, 5.6], [-18.2, 3.4], [-20.4, 2], [-23.6, 1.8], [-24.6, -0.6], [-22.4, -3], [-20.6, -6], [-21.8, -8.6], [-25, -8.2], [-27.6, -5.6], [-29.4, -2.4], [-31.4, 0.4], [-32.2, 3.6]], -4, 0), 504));
// the east ridge: a long bent ridge running north to south, hollow toward the centre
add(isle([[18.4, 9.4], [21, 10.6], [24, 9.6], [26.4, 5.6], [27.4, 1], [25, -1.4], [24.6, -2.8], [26.6, -4.8], [28.4, -8.6], [29.6, -11.6], [28.4, -14.8], [25.6, -13.8], [23.6, -10], [22.4, -5.8], [22.6, -2.8], [21, -1.4], [19, 1.6], [17.8, 5.6]], 505, 0.45));
// the northeast plateau: the largest outer isle, stepped like terraces, with a bight on its south shore
add(isle([
  [20.4, 20.4], [22.2, 24.6], [26, 27], [30, 27.8], [34, 27.4], [38, 28], [42, 26.6], [44.6, 23], [44.8, 17.8], [43, 17.6], [43, 14.8], [39.2, 14.6], [39, 12.2], [34, 12.4], [33.8, 13.6], [29, 13.6], [28.8, 11.4], [24, 11.6], [22, 13.4], [21, 16.4],
], 506));
// the east crescent: a small arc facing the east ridge
add(isle([[36, 6.4], [38.6, 8], [41.2, 6.2], [42.4, 1.8], [42.2, -3.2], [40.6, -7.6], [38, -10.4], [35.4, -10.8], [36.8, -7.2], [38.4, -3.2], [38.6, 1], [37.6, 4]], 507, 0.45));
// the south isle, off the mouth of the inner bay
add(isle([[-15, -17], [-14, -15], [-11, -14.2], [-8.6, -15], [-7, -16.2], [-5, -15.2], [-2, -14.4], [1, -15], [2.6, -16.2], [4.4, -15], [7, -14.6], [9.4, -16], [9.2, -18.4], [7, -19.4], [4.6, -19], [2.8, -18.2], [1, -19.6], [-2, -20.2], [-5, -19.6], [-6.8, -18.4], [-8.4, -19.8], [-11.5, -20.4], [-14.4, -19.4]], 508, 0.45));
// the southeast fjord isle: a deep narrow inlet bites in from the north
add(isle([
  [13, -19], [16, -16.6], [19.8, -16.8], [22.2, -18.2], [23, -22], [23.2, -26], [24, -26], [24, -22], [24.8, -18.2], [29, -17.4], [33, -18.4], [37, -17.4],
  [40.2, -19.4], [41.4, -21], [37.8, -22], [37.8, -23], [41.6, -24], [39.2, -26.6], [35, -28.6], [30, -27.4], [26, -29.6], [21, -29.2], [17, -27], [13.6, -24.6], [12, -21.6],
], 509));
// the southwest cluster: one main isle and four smaller ones split by narrow channels
add(isle(mv([[-45, -13.6], [-42.4, -12.8], [-40.6, -14.6], [-41.2, -17.4], [-39.2, -19.6], [-36, -20.2], [-33, -18.8], [-31.6, -20.6], [-33.4, -23.4], [-37.4, -24.4], [-41.4, -23.6], [-44.6, -21.2], [-46.4, -17.6]], 3, 2), 510));
add(isle(mv([[-30.2, -12.8], [-27.6, -12.4], [-25.8, -14.6], [-26.4, -18], [-28.4, -19.4], [-29.8, -16.4]], 3, 2), 511));
add(isle(mv([[-34.6, -26.4], [-31.4, -25], [-28, -25.2], [-25.2, -26.6], [-25.8, -27.8], [-28.6, -27.2], [-31.8, -27.6], [-34.4, -28.6]], 3, 2), 512));
add(isle(mv([[-48, -24.6], [-45.6, -25.4], [-43.2, -27.6], [-43.6, -29.4], [-45, -28.2], [-46.8, -27.4], [-48.4, -27.2]], 3, 2), 513));
add(isle(mv([[-38.6, -26.4], [-36.4, -26], [-36, -28.4], [-38.4, -29.2]], 3, 2), 514));
// a small round isle inside the inner bay, and one off the east arm's tip
add(isle([[3.6, -2.8], [5.2, -2.2], [6.2, -3], [5.2, -3.8], [4, -3.6]], 515, 0.2, 0.6));
add(isle([[5.2, -5.2], [6, -4.8], [6.2, -5.8], [5.4, -6.2]], 517, 0.15, 0.5));
add(isle([[13.2, -11.6], [15, -11.2], [15.8, -12.6], [14.6, -14], [13, -13.4]], 516, 0.2, 0.6));

// curving chains of islets in the open water
const rngC = rngFor(520);
const chain = (pts: Pt[], count: number, rmin: number, rmax: number): void => {
  const line: Pt[] = [];
  for (let i = 0; i + 1 < pts.length; i++) line.push(...path(pts[i], pts[i + 1], rngC, 0.6, 20).slice(i ? 1 : 0));
  for (const p of islandChain(line, count, rmin, rmax, rngC, 0.35)) add(p);
};
chain([[-18, 25.6], [-11, 26.6], [-4, 25]], 4, 0.4, 2.0); // the north arc, west half
chain([[5, 24.6], [11, 26.8], [17, 25.4]], 3, 0.4, 1.6); // the north arc, east half
add(isle([[-9.2, 27.6], [-7.2, 28.4], [-5.8, 27], [-7.4, 26], [-9, 26.2]], 540, 0.3, 0.8)); // stepping stone
add(isle([[0.2, 25.4], [2.4, 26.2], [3.6, 24.8], [1.8, 23.6], [0.2, 24]], 541, 0.3, 0.8)); // stepping stone
chain([[-19, -23.6], [-12, -26.2], [-6, -26.8]], 4, 0.4, 1.8); // the south arc, west half
chain([[1, -26], [5, -25], [9, -22.6]], 3, 0.4, 1.4); // the south arc, east half
add(isle([[-5.6, -23.6], [-3.4, -24.4], [-1.4, -23.4], [-2.4, -22], [-4.8, -22]], 542, 0.3, 0.8)); // stepping stone
chain([[31.4, 9.4], [32.6, 2]], 3, 0.4, 1.4); // between the east ridge and the east crescent
chain([[32.6, -3], [33.2, -12]], 2, 0.5, 1.2);
add(isle([[44.6, 8], [46.4, 6], [47.6, 0], [47.2, -6], [45.6, -10.8], [44.4, -9], [45.4, -5.4], [45.6, 0], [44.8, 4]], 543, 0.35, 1)); // one elongated isle off the east crescent
chain([[-39.6, 11], [-39.2, 4.6]], 2, 0.5, 1.0); // between the northwest crescent and the west plateau
chain([[-19, -8.6], [-16.8, -12.4]], 2, 0.5, 0.9); // toward the south isle
chain([[42.6, -31], [46.6, -26], [47.6, -19]], 4, 0.4, 1.4); // the far southeast
chain([[-16.6, 9], [-17.4, 12.8]], 2, 0.5, 0.8); // the northwest strait

// relief and resources: hills and peaks give iron (the high cores of the peaks take snow), the pale sand beaches and
// the fens give oil
const rngR = rngFor(530);
const regions: ExtraRegion[] = [];
const oilZones: number[][][] = [];
const reg = (name: string, kind: ExtraRegion['kind'], cx: number, cy: number, rx: number, ry: number, rot = 0, strength?: number): void => {
  const r: ExtraRegion = { name, kind, poly: pl.ring(blob(cx, cy, rx, ry, rngR, 0.18, rot)) };
  if (strength !== undefined) r.strength = strength;
  regions.push(r);
};
const oil = (name: string, kind: 'desert' | 'swamp', cx: number, cy: number, rx: number, ry: number, rot = 0): void => {
  reg(name, kind, cx, cy, rx, ry, rot);
  oilZones.push(pl.ring(blob(cx, cy, rx * 0.85, ry * 0.85, rngR, 0.15, rot)));
};

// the central island: a terraced plateau in the north with snowy peaks, rolling hills on both arms
reg('Central terraces', 'hills', 1.5, 6.4, 9.4, 4.6);
reg('Central plateau', 'mountains', 2, 6.8, 6, 3.1, 0, 1);
reg('Central summit', 'mountains', 2, 6.8, 2.6, 1.4, 0, 1);
reg('West arm downs', 'hills', -10.5, -3.6, 3, 2.2);
reg('East arm downs', 'hills', 11, 4, 2.6, 2.2);
reg('East arm crags', 'mountains', 11.4, 4.4, 1.2, 1, 0, 0.8);
oil('West arm dunes', 'desert', -12.5, 2.6, 1.8, 2.6);
oil('Bay fen', 'swamp', 9.6, -5.4, 1.4, 1.4);
oil('South shore dunes', 'desert', -8.2, -7.2, 1.8, 1.1);
// the north ridge
reg('North ridge spine', 'mountains', 4, 18.1, 4, 0.9, 0.05, 0.85);
reg('North ridge hills', 'hills', 2, 17.8, 8, 1.6, 0.05);
oil('North ridge dunes', 'desert', -9.5, 16.4, 2.2, 1.1, 0.25);
// the northwest crescent
reg('Crescent spine', 'mountains', -38.6, 22.9, 3, 0.9, -0.55, 0.85);
reg('Crescent hills', 'hills', -40.6, 20.5, 5, 1.6, -0.75);
reg('Crescent south hills', 'hills', -45, 7.5, 1.2, 3.2);
oil('Crescent dunes', 'desert', -45.3, 12.5, 1.3, 2);
oil('Crescent fen', 'swamp', -27, 24.7, 2.4, 1.1);
// the west plateau
reg('West terraces', 'hills', -30.4, 0.4, 4.4, 4.6);
reg('West peaks', 'mountains', -31.4, 2.6, 2.2, 1.6, 0, 0.85);
oil('West plateau dunes', 'desert', -26.4, -6, 1.6, 1.4);
// the east ridge
reg('East ridge spine', 'mountains', 25.4, -4.6, 0.8, 3.4, 0.25, 0.85);
reg('East ridge hills', 'hills', 23.6, -1, 1.6, 6, 0.3);
oil('East ridge dunes', 'desert', 20.8, 7, 1.6, 1.4);
// the northeast plateau: stepped terraces round twin peaks
reg('Northeast terraces', 'hills', 32, 20.4, 10.4, 5.4);
reg('Northeast peaks', 'mountains', 31, 21.6, 5, 2.8, 0, 1);
reg('Northeast summit', 'mountains', 31, 21.8, 2.2, 1.3, 0, 1);
reg('Northeast crags', 'mountains', 40.6, 20, 1.8, 1.6, 0, 0.82);
oil('Northeast dunes', 'desert', 41, 16, 2, 1.3);
oil('Northeast fen', 'swamp', 25, 15.6, 2, 1.2);
// the east crescent
reg('East crescent hills', 'hills', 40.6, -1.4, 1.2, 4, 0.1);
oil('East crescent dunes', 'desert', 39.6, 5.6, 1.4, 1);
// the south isle
reg('South isle hills', 'hills', -2, -17.4, 4.4, 1.6);
reg('South isle crags', 'mountains', -2.6, -17.6, 1.6, 0.8, 0, 0.82);
oil('South isle dunes', 'desert', -11, -17.4, 1.8, 1.2);
// the southeast fjord isle
reg('Fjord highlands', 'hills', 33, -22.6, 6, 3.2);
reg('Fjord peaks', 'mountains', 31.6, -22.6, 2.6, 1.5, 0, 0.9);
oil('Fjord dunes', 'desert', 17.4, -24.2, 2.6, 1.8);
oil('Fjord fen', 'swamp', 28.4, -26.4, 1.8, 1.1);
// the southwest cluster
reg('Southwest hills', 'hills', -37, -18.8, 4.4, 2.2);
reg('Southwest crags', 'mountains', -40.6, -15, 1.8, 1.2, 0, 0.82);
oil('Southwest dunes', 'desert', -31.6, -19.6, 1.8, 1.2);
reg('Channel isle hills', 'hills', -25.2, -13.4, 1.2, 2.2);
oil('Channel isle dunes', 'desert', -27.2, -24.3, 2.4, 0.9);

export const DRIFTISLES: DrawnMap = {
  land: land.map((p) => pl.ring(p)),
  lakes: [],
  rivers: [],
  regions,
  oilZones,
};

const sp = (name: string, u: number, v: number, major = false): SpawnDef => ({ name, at: pl.P(u, v), major, pop: major ? 2_000_000 : 1_000_000 });

export const DRIFTISLES_SPAWNS: SpawnDef[] = [
  sp('Veyra', -8.5, 3, true),
  sp('Orsund', 37.4, 20, true),
  sp('Kelmar', -1.5, 18),
  sp('Thessaly', -44.2, 17.4),
  sp('Ravenne', -31.6, -3),
  sp('Pellor', 23.4, 4.4),
  sp('Dravik', 9, 0.4),
  sp('Sunnach', -2, -17.4),
  sp('Imbria', 30, -21.4),
  sp('Norwick', -35.6, -19.6),
];
