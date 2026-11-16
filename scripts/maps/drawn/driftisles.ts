// "The Drifting Isles": a hand-drawn fictional map of islands adrift in a sky-blue sea. In the middle lies one great
// horseshoe island whose two arms curl round a round inner bay opening south; round it, across narrow straits, lie a
// long curved ridge to the north, a terraced plateau isle to the west, a bent ridge to the east, a long crescent in the
// northwest, a stepped plateau in the northeast, a fjord isle in the southeast, a cluster of isles in the southwest and
// a low isle off the bay mouth, with curving chains of islets between them. Fleets and aircraft decide the war. Drawn
// for this project by hand, point by point (see drawn/kit.ts).
import type { DrawnMap, Pt } from './kit';
import { blob, dense, fractal, islandChain, makePlane, path, rngFor, smoothClosed } from './kit';
import type { SpawnDef } from '../defs';
import type { ExtraRegion } from '../extra';

// shapes are drawn in a 100 x 64 design space (u east, v north, origin at the centre) and shrunk by S so the climate
// band stays mid-latitude
const S = 0.78;
export const DRIFTISLES_PLANE = makePlane(100 * S, 64 * S, 38);
const pl = {
  ring: (pts: Pt[]) => DRIFTISLES_PLANE.ring(pts.map(([u, v]): Pt => [u * S, v * S])),
  P: (u: number, v: number) => DRIFTISLES_PLANE.P(u * S, v * S),
};

/** a hand-drawn outline (design units), smoothed, resampled about every unit, with a fractal coastline of coves and capes */
function isle(ctrl: Pt[], seed: number, rough = 0.32, step = 1.8): Pt[] {
  return fractal(dense(smoothClosed(ctrl, 6), step), rngFor(seed), rough, 6, 0.04);
}

/**
 * The great central island as [x %, y %] of its box: x from the west edge, y from the NORTH edge. Clockwise from the
 * northwest shoulder: a broad rounded north, a straight-ish west coast, then the two arms round the inner bay.
 */
const CENTRAL: Pt[] = [
  // north coast: broad and round, a small notch in the middle
  [6.5, 10], [14.5, 3.4], [27.5, 1.2], [38, 1.8], [45.5, 2.6], [49.5, 6], [53, 2.4], [60, 1.1], [73, 2.2], [83, 4.5],
  // the northeast shoulder and the east coast, an inlet halfway down
  [91, 10], [96, 19], [98.5, 30], [99.2, 41], [95, 46.5], [99, 51], [98.4, 58], [96.7, 68.5], [92.7, 78.7],
  // the east arm, long and narrowing, its hooked tip turning in toward the bay mouth
  [89.5, 86], [86.5, 92.5], [82, 97.6], [76.6, 98.6], [73.4, 95.4], [75.4, 90], [76.2, 82],
  // round the inner bay, from the east arm back to the west arm: deep and round, a harbour for whole fleets
  [75.2, 70.4], [71.2, 59.4], [64, 52.2], [55, 49.6], [46, 51.2], [39.2, 57], [35, 66], [33.6, 77], [35, 87.6],
  // the west arm: broader, running further south to a blunt tip that curls east under the bay
  [39.4, 93.6], [42.6, 98], [39, 101.6], [32.4, 101], [26, 97.6], [20.4, 92.6], [12.6, 86.4],
  // the southwest shoulder, a small cape on the west coast, and up to the start
  [5, 77.5], [1.6, 66.3], [0.4, 56], [-1.8, 49.5], [1.2, 44], [1.6, 35], [2.4, 26], [4.1, 17],
];
/** central island box: 30 x 22.8 units, its middle at (0, 0.8) */
const cen = (x: number, y: number): Pt => [-15 + x * 0.3, 12.2 - y * 0.228];

const land: Pt[][] = [];
const add = (p: Pt[]): number => land.push(p) - 1;

add(isle(CENTRAL.map(([x, y]) => cen(x, y)), 501, 0.32, 2));

// the north ridge: long and gently arched, across a narrow strait from the central island
add(isle([[-13.5, 15.4], [-11, 17.6], [-6.5, 19.2], [-1, 20], [4.5, 19.9], [9.5, 19], [13.2, 17.6], [14.5, 15.8], [12.6, 14.8], [8.5, 15.9], [4, 16.6], [-1, 16.6], [-5.5, 16], [-9.8, 14.6]], 502));
// the northwest crescent: a long thin arc, its hollow facing the centre
add(isle([
  [-21.5, 27.8], [-26, 29.4], [-31.5, 29.6], [-36.5, 28.6], [-41, 26], [-44.6, 22.3], [-46.8, 17.6], [-47.6, 12.6], [-47, 8], [-45.6, 4.6],
  [-43.6, 5.2], [-42.9, 8.6], [-42.4, 12.6], [-41, 17], [-38.4, 20.8], [-34.6, 23.8], [-30, 25.4], [-25.6, 25.6], [-22.4, 25.6],
], 503));
// the west plateau: a squat terraced isle with stepped lobes
add(isle([[-30.4, 3], [-28.6, 5.8], [-26.4, 5.4], [-25.2, 3.4], [-23.6, 5.8], [-20.8, 5.2], [-18.8, 3], [-18.4, -0.2], [-20.4, -2], [-18.6, -4.4], [-19.4, -7.4], [-22.4, -7.8], [-24.4, -6], [-26.2, -8.6], [-29.6, -7.8], [-31.6, -5], [-30, -2.6], [-31.8, -0.4]], 504));
// the east ridge: a long bent ridge running north to south, hollow toward the centre
add(isle([[18.4, 9.4], [21, 10.4], [23.2, 8.4], [24.6, 4.4], [25.6, 0.2], [26.4, -3.8], [27.8, -7.8], [29.6, -11.2], [28.6, -14.6], [25.8, -13.8], [23.6, -10.2], [22, -6.2], [20.8, -2.2], [19.4, 1.8], [18, 5.6]], 505));
// the northeast plateau: the largest outer isle, stepped like terraces, with a bight on its south shore
add(isle([
  [20.4, 20.4], [22.2, 24.6], [26, 27], [30.6, 27.8], [34.6, 26.4], [38, 27.6], [42, 26.2], [44.6, 22.6], [44, 18.6], [46.2, 15.4], [44.2, 12.4],
  [40.4, 11.8], [37.4, 13.8], [35.6, 16.4], [33.4, 13.4], [30, 12.6], [26.8, 11.4], [23, 13.2], [21, 16.4],
], 506));
// the east crescent: a small arc facing the east ridge
add(isle([[36, 6.4], [38.6, 8], [41.2, 6.2], [42.4, 1.8], [42.2, -3.2], [40.6, -7.6], [38, -10.4], [35.4, -10.8], [36.8, -7.2], [38.4, -3.2], [38.6, 1], [37.6, 4]], 507));
// the south isle, off the mouth of the inner bay
add(isle([[-13.2, -15], [-9, -13.8], [-4.2, -14.2], [0, -13.6], [4, -14.6], [6.6, -16.6], [5, -19.2], [1, -19.6], [-3, -18.6], [-7, -19.8], [-11, -19.2], [-13.8, -17.2]], 508));
// the southeast fjord isle: a deep narrow inlet bites in from the north
add(isle([
  [13, -19], [16, -16.6], [19.8, -16.8], [21.8, -18.2], [22.6, -21.2], [23.2, -25], [24.2, -25.2], [24.6, -21.2], [25.8, -18.4], [29, -17.4], [33, -18.4], [37, -17.4],
  [40.2, -19.4], [41.2, -23], [39.2, -26.6], [35, -28.6], [30, -27.4], [26, -29.6], [21, -29.2], [17, -27], [13.6, -24.6], [12, -21.6],
], 509));
// the southwest cluster: one main isle and four smaller ones split by narrow channels
add(isle([[-43, -15.8], [-40, -14.4], [-36, -15], [-33.2, -16.6], [-32.6, -19.6], [-34, -22.6], [-37.6, -23.6], [-41, -23], [-44, -21], [-44.8, -18.4]], 510));
add(isle([[-30.2, -12.8], [-27.6, -12.4], [-25.8, -14.6], [-26.4, -18], [-28.4, -19.4], [-29.8, -16.4]], 511));
add(isle([[-33.2, -25.6], [-29.2, -24.8], [-26.4, -26.4], [-27.4, -29.2], [-31, -29.8], [-34.2, -28.2]], 512));
add(isle([[-47.2, -25], [-44, -25.6], [-42.8, -28], [-46, -29.6], [-48, -28]], 513));
add(isle([[-38.6, -26.4], [-36.4, -26], [-36, -28.4], [-38.4, -29.2]], 514));
// a small round isle inside the inner bay, and one off the east arm's tip
add(isle([[1.2, -4], [2.8, -3.6], [3.8, -4.8], [3.2, -6.4], [1.4, -6.6], [0.6, -5.2]], 515, 0.2, 0.6));
add(isle([[13.2, -11.6], [15, -11.2], [15.8, -12.6], [14.6, -14], [13, -13.4]], 516, 0.2, 0.6));

// curving chains of islets in the open water
const rngC = rngFor(520);
const chain = (pts: Pt[], count: number, rmin: number, rmax: number): void => {
  const line: Pt[] = [];
  for (let i = 0; i + 1 < pts.length; i++) line.push(...path(pts[i], pts[i + 1], rngC, 0.6, 20).slice(i ? 1 : 0));
  for (const p of islandChain(line, count, rmin, rmax, rngC, 0.35)) add(p);
};
chain([[-17, 23.6], [-8, 26.4], [2, 27.6], [12, 26.2], [17, 23.2]], 8, 0.6, 1.3); // the north arc
chain([[-21, -23.6], [-12, -25.6], [-2, -26.4], [8, -24.2]], 7, 0.6, 1.3); // the south arc
chain([[31.4, 9.4], [32.6, 2], [32.4, -5], [33.2, -12]], 5, 0.55, 1.1); // between the east ridge and the east crescent
chain([[45.2, 9], [47, 2], [46.6, -6], [45, -12]], 4, 0.6, 1.2); // off the east crescent
chain([[-39.4, 3.2], [-37, -1.6], [-35.4, -6.4], [-36.4, -10.4]], 5, 0.6, 1.3); // inside the northwest crescent
chain([[-22, -10.6], [-18.4, -13.6], [-16.8, -17.4]], 3, 0.5, 1.0); // toward the south isle
chain([[42.6, -31], [46.6, -26], [47.6, -19]], 4, 0.6, 1.2); // the far southeast
chain([[45.6, 31], [48, 26.6]], 2, 0.6, 1.0); // the far northeast
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
reg('Crescent spine', 'mountains', -38.6, 25.4, 3, 0.9, -0.55, 0.85);
reg('Crescent hills', 'hills', -40.6, 23, 5, 1.6, -0.75);
reg('Crescent south hills', 'hills', -45, 10, 1.2, 3.2);
oil('Crescent dunes', 'desert', -45.3, 15, 1.3, 2);
oil('Crescent fen', 'swamp', -27, 27.2, 2.4, 1.1);
// the west plateau
reg('West terraces', 'hills', -24.6, -1, 4.6, 4);
reg('West peaks', 'mountains', -25, 0.2, 2.2, 1.6, 0, 0.85);
oil('West plateau dunes', 'desert', -21, -5.4, 1.8, 1.2);
// the east ridge
reg('East ridge spine', 'mountains', 25.4, -4.6, 0.8, 3.4, 0.25, 0.85);
reg('East ridge hills', 'hills', 23.6, -1, 1.6, 6, 0.3);
oil('East ridge dunes', 'desert', 20.8, 7, 1.6, 1.4);
// the northeast plateau: stepped terraces round twin peaks
reg('Northeast terraces', 'hills', 32, 21, 9, 4.4);
reg('Northeast peaks', 'mountains', 30.6, 21.8, 4.6, 2.8, 0, 1);
reg('Northeast crags', 'mountains', 40.6, 20, 1.8, 1.6, 0, 0.82);
oil('Northeast dunes', 'desert', 40.4, 14.6, 2.4, 1.4);
oil('Northeast fen', 'swamp', 25, 15, 2, 1.2);
// the east crescent
reg('East crescent hills', 'hills', 40.6, -1.4, 1.2, 4, 0.1);
oil('East crescent dunes', 'desert', 39.6, 5.6, 1.4, 1);
// the south isle
reg('South isle hills', 'hills', 0.4, -16.6, 4, 1.5);
reg('South isle crags', 'mountains', 1.2, -16.8, 1.6, 0.8, 0, 0.82);
oil('South isle dunes', 'desert', -10.4, -16.8, 2, 1.2);
// the southeast fjord isle
reg('Fjord highlands', 'hills', 33, -22.6, 6, 3.2);
reg('Fjord peaks', 'mountains', 35.6, -22.4, 2.8, 1.6, 0, 0.86);
oil('Fjord dunes', 'desert', 17.4, -24.2, 2.6, 1.8);
oil('Fjord fen', 'swamp', 27.4, -26.6, 1.8, 1.1);
// the southwest cluster
reg('Southwest hills', 'hills', -38.4, -18, 4, 2.6);
reg('Southwest crags', 'mountains', -39.4, -17.2, 1.8, 1.2, 0, 0.82);
oil('Southwest dunes', 'desert', -35.4, -21.4, 1.8, 1.2);
reg('Channel isle hills', 'hills', -28.2, -15.4, 1.2, 2.2);
oil('Channel isle dunes', 'desert', -30.6, -27.2, 2, 1.2);

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
  sp('Orsund', 9, 0.4, true),
  sp('Kelmar', -1.5, 18),
  sp('Thessaly', -43.4, 20.6),
  sp('Ravenne', -27.6, -3),
  sp('Pellor', 22.6, 2.2),
  sp('Dravik', 36.4, 19.8),
  sp('Sunnach', -4.6, -16.4),
  sp('Imbria', 30, -21.4),
  sp('Norwick', -40, -20.6),
];
