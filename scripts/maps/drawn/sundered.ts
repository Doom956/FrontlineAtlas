// "The Sundered Sea": a hand-drawn fictional map of an upside-down world. A vast mainland fills the west: our own
// Africa with the Arabian peninsula and the shore of the Middle Sea, turned north for south (so the great desert runs
// along the bottom and the far cape points up). Across a wide channel to the east lies the walled island of
// drawn/ringlands.ts, smaller, where a big island sits off that coast in the real world. A few small islands lie in the
// channel, where fleets and landings decide the war. The mainland outline is written by hand from general geography
// as [lon, lat] points, coarse but faithful, then flipped; no data set is used.
import type { DrawnMap, Pt } from './kit';
import { blob, fractal, makePlane, rngFor, smoothClosed, strip } from './kit';
import type { ExtraRegion } from '../extra';
import type { SpawnDef } from '../defs';
import { walledIsle } from './ringlands';

export const SUNDERED_PLANE = makePlane(41, 39, 38);
const pl = SUNDERED_PLANE;

/** A real-world [lon, lat] point -> plane point: half a unit per degree, latitude flipped (south is up). */
const F = (lon: number, lat: number): Pt => [(lon - 21) * 0.5, -(lat - 1) * 0.5];
const FL = (pts: number[][]): Pt[] => pts.map(([lon, lat]) => F(lon, lat));

// The mainland, [lon, lat], clockwise on a real map: the Middle Sea shore west to east, the coast of the eastern
// shore and the land bridge to the northeast, the gulf coast of the peninsula, round its south, up its west coast to
// the narrow gulfs and the isthmus, then down the long east coast to the far cape and back up the west coast.
const MAINLAND = [
  // Middle Sea shore
  [-5.9, 35.8], [-2.2, 35.1], [1, 36.4], [5, 36.8], [8.6, 36.9], [11, 37.1], [10.5, 35.6], [10.2, 34.3], [10.4, 33.6],
  [12, 32.9], [15.2, 32.3], [17, 31], [19, 30.3], [20.1, 31.5], [22, 32.9], [25, 31.7], [29, 30.9], [31, 31.6],
  [32.3, 31.2], [34.2, 31.3],
  // eastern shore, then the land bridge to the northeast
  [35, 32.8], [35.5, 34.5], [35.9, 35.9], [36.2, 36.6], [37.5, 37], [40, 37.2], [42.5, 37.3], [44.5, 36.5], [45.8, 35],
  [46.5, 33], [47.8, 31.5], [48.6, 30],
  // the inner gulf coast of the peninsula
  [48, 29.4], [48.7, 28], [49.6, 26.9], [50.1, 25.9], [50.7, 25], [51.2, 26.1], [51.6, 25.2], [51.6, 24.3], [52.6, 24.1],
  [54.3, 24.3], [55.5, 25.4], [56.3, 26.3], [56.4, 24.8], [57.5, 23.8], [58.6, 23.6], [59.8, 22.5],
  // round the south of the peninsula
  [58.6, 20.6], [57.7, 19], [56.3, 18], [55, 17.2], [52.2, 15.6], [49, 14.4], [45, 12.8], [43.4, 12.6],
  // up its west coast to the gulfs and the isthmus
  [42.7, 15.5], [41.5, 18], [40, 20.2], [39.1, 21.5], [38.2, 23.8], [37.2, 25], [36, 26.6], [35.2, 28.1], [35, 29.5],
  [34.25, 27.8], [33.6, 28.4], [32.55, 29.95],
  // the long east coast, the horn, and south to the far cape
  [33.5, 27], [34.6, 25.4], [35.6, 23.9], [36.9, 22], [37.2, 21], [37.3, 19.6], [38.6, 18], [39.5, 15.6], [40.8, 14.3],
  [41.7, 13.4], [43.3, 11.6], [44.5, 10.4], [47, 11.1], [49, 11.3], [51.2, 11.8], [51, 10.4], [50.5, 9], [49.8, 7.5],
  [48, 4.5], [46.5, 2.8], [45.3, 2], [43.5, 0.5], [42, -0.8], [40.1, -3], [39.2, -5], [39.3, -6.8], [39.6, -8.5],
  [40.4, -10.5], [40.6, -12.5], [40.6, -14.5], [39.8, -16], [38.5, -17.3], [36.5, -18.8], [34.9, -19.8], [35.3, -22],
  [35.5, -23.8], [34.5, -24.8], [32.6, -25.9], [32.8, -28.5], [31.5, -29.5], [30, -31.3], [28, -33], [25.6, -34],
  [22.5, -34], [20, -34.8], [18.5, -34.4],
  // the west coast, north to the strait
  [18, -32.5], [17.2, -30], [16.5, -28.6], [15.2, -26.7], [14.5, -22.9], [13.2, -20.5], [11.8, -17.3], [12.2, -15.5],
  [12.3, -13.8], [13.5, -11.5], [13.2, -8.8], [12.2, -6], [11.8, -4.6], [10.5, -3], [9.3, -0.7], [9.5, 1], [9.7, 3],
  [9.6, 3.9], [8.5, 4.6], [7.2, 4.4], [6, 4.3], [5, 5.6], [3.4, 6.4], [1, 5.9], [-1, 5], [-2, 4.8], [-4.5, 5.2],
  [-7.5, 4.4], [-9.5, 5.4], [-10.8, 6.6], [-12.5, 7.6], [-13.2, 8.5], [-14.6, 10.5], [-15.5, 11.5], [-16.7, 12.4],
  [-17.5, 14.7], [-16.5, 16.2], [-16.1, 18], [-16.3, 19.5], [-17.1, 20.8], [-16.5, 22.8], [-15, 24.5], [-13.2, 27.6],
  [-11.5, 28.3], [-9.8, 29.5], [-9.7, 31.5], [-8.6, 33.2], [-7.6, 33.6], [-6.8, 34.1], [-6, 35.5],
];

const mainland = fractal(smoothClosed(FL(MAINLAND), 4), rngFor(13), 0.16, 4, 0.06);

// the walled island, where the big island lies off that coast in the real world
const IC = F(49.5, -19);
const isle = walledIsle({ plane: pl, cx: IC[0], cy: IC[1], width: 6, wallFrac: 0.4, thick: 0.08, district: 0.16, gap: 0.1, seed: 400 });

const rI = rngFor(14);
const isl = (lon: number, lat: number, rx: number, ry: number, rot = 0): Pt[] => fractal(blob(...F(lon, lat), rx * 0.5, ry * 0.5, rI, 0.2, rot), rI, 0.18, 3, 0.03);
const islands: Pt[][] = [
  // the channel between the mainland and the walled island
  isl(43.3, -11.6, 0.8, 0.5, 0.5), isl(44.5, -12.3, 0.55, 0.4), isl(42.7, -17.1, 0.55, 0.45), isl(40.4, -22.4, 0.7, 0.5),
  isl(39.6, -20.6, 0.45, 0.35),
  // the Middle Sea and the other coasts
  isl(24.9, 35.25, 1.4, 0.32, 0.1), isl(33.2, 35.1, 0.85, 0.35, 0.3), isl(14, 37.5, 1.2, 0.6), isl(-15.5, 28.2, 0.5, 0.35),
  isl(-13.8, 28.6, 0.4, 0.3), isl(53.8, 12.5, 0.8, 0.25), isl(8.7, 3.5, 0.35, 0.3), isl(39.4, -6.1, 0.3, 0.45),
];

const rR = rngFor(71);
const B = (lon: number, lat: number, rx: number, ry: number, rot = 0): number[][] => pl.ring(blob(...F(lon, lat), rx * 0.5, ry * 0.5, rR, 0.2, rot));
const P = (pts: number[][]): number[][] => pl.ring(FL(pts));
const R = (pts: number[][], half: number): number[][] => pl.ring(strip(smoothOpen(FL(pts)), half * 0.5));
/** a polyline through the points, rounded a little (each corner cut once) */
function smoothOpen(pts: Pt[]): Pt[] {
  const out: Pt[] = [pts[0]];
  for (let i = 0; i + 1 < pts.length; i++) {
    const [a, b] = [pts[i], pts[i + 1]];
    out.push([a[0] * 0.75 + b[0] * 0.25, a[1] * 0.75 + b[1] * 0.25], [a[0] * 0.25 + b[0] * 0.75, a[1] * 0.25 + b[1] * 0.75]);
  }
  out.push(pts[pts.length - 1]);
  return out;
}

const mainRegions: ExtraRegion[] = [
  // the great desert, the peninsula's desert and the dry southwest of the far cape
  { name: 'Great waste', kind: 'desert', poly: P([[-15, 17], [-14, 22], [-12.5, 26.5], [-8, 28.5], [-3, 30.5], [3, 31.5], [9, 32], [11, 31], [15, 30.5], [19, 29.5], [21, 30.6], [25, 30.3], [29.5, 29.8], [32, 27], [34, 23.5], [36, 20], [35, 17], [31, 16.5], [26, 15.8], [20, 16.5], [15, 16.5], [9, 17], [4, 16], [-2, 16], [-8, 16.5]]) },
  { name: 'Peninsula waste', kind: 'desert', poly: P([[37.5, 29.5], [39, 32], [42, 33], [45, 31.5], [47.5, 28.5], [49.5, 25.5], [51, 23.5], [55, 22.5], [56, 20], [53, 17.5], [49, 17], [45, 17], [43.5, 19], [41.5, 22], [39.5, 25]]) },
  { name: 'Coast waste', kind: 'desert', poly: P([[12, -17], [13.8, -17.5], [15.3, -22], [16, -27], [17, -29], [15.5, -28.5], [14.5, -25], [13.5, -21], [12.2, -18]]) },
  // dry grassland: the belt south of the desert (north of it, on this flipped world), the horn, the far cape's basin
  { name: 'Dry belt', kind: 'steppe', poly: P([[-16, 16.5], [-16, 12.5], [-8, 12.5], [0, 12.5], [10, 12], [20, 12], [28, 11.5], [35, 13], [38, 15.5], [35, 17], [26, 16], [15, 17], [4, 16.5], [-6, 16.5]]) },
  { name: 'Horn steppe', kind: 'steppe', poly: P([[42, 8], [46, 10.5], [50, 11], [49.5, 7], [46.5, 3], [42, 3.5], [40, 4.5]]) },
  { name: 'Cape basin', kind: 'steppe', poly: P([[18.5, -19], [24, -19], [26, -22], [25.5, -27], [21, -28.5], [18.5, -25]]) },
  // the wet tropics: the great basin and the bight coast; open woodland south of them
  { name: 'Basin jungle', kind: 'wet', poly: P([[9.5, 4.5], [15, 5], [22, 4.5], [28.5, 3.5], [30, 0], [28.5, -4], [24, -5], [18, -5], [13, -4], [10, -2.5], [9, 1]]) },
  { name: 'Bight jungle', kind: 'wet', poly: P([[-13, 9], [-8, 8.5], [-3, 7.5], [3, 7.5], [8, 6.5], [9, 4.5], [5, 4.2], [0, 5.2], [-5, 4.8], [-8, 4.4], [-11, 6.5]]) },
  { name: 'Southern woodland', kind: 'woods', poly: P([[13, -9], [22, -7.5], [30, -7], [38, -9], [39, -15], [34, -17], [27, -17], [20, -16], [14, -13]]) },
  { name: 'Savanna woods', kind: 'woods', poly: P([[-12, 11], [0, 10], [12, 8.5], [25, 8], [32, 9], [30, 6], [20, 6], [8, 7], [-4, 8], [-12, 9.5]]) },
  // mountains where the real ranges are
  { name: 'Atlas', kind: 'mountains', strength: 0.82, poly: R([[-9.5, 30.5], [-6, 31.8], [-3, 33.5], [1, 35], [5, 35.8], [9, 36]], 0.9) },
  { name: 'Atlas foothills', kind: 'hills', poly: R([[-9.5, 30.5], [-6, 31.8], [-3, 33.5], [1, 35], [5, 35.8], [9, 36]], 2) },
  { name: 'High plateau', kind: 'mountains', strength: 0.78, poly: B(38.5, 10, 2.6, 3.4) },
  { name: 'High plateau hills', kind: 'hills', poly: B(38.5, 9.5, 4.5, 5.2) },
  { name: 'Rift highlands', kind: 'mountains', strength: 0.78, poly: R([[36.5, 3], [36.8, -1], [37.3, -3.1], [35.5, -7], [34, -10], [34.5, -14]], 0.9) },
  { name: 'Rift hills', kind: 'hills', poly: R([[35, 4], [36, -1], [34, -6], [32, -10], [33, -14]], 3.2) },
  { name: 'Dragon range', kind: 'mountains', strength: 0.8, poly: R([[31, -25], [29.5, -28.5], [27.5, -31.5], [24, -32.8], [20, -33.6]], 0.8) },
  { name: 'Dragon foothills', kind: 'hills', poly: R([[31, -25], [29.5, -28.5], [27.5, -31.5], [24, -32.8], [20, -33.6]], 2.2) },
  { name: 'Gulf range', kind: 'mountains', strength: 0.76, poly: R([[35.5, 28.5], [37.5, 25], [40, 20.5], [42.5, 16.5], [44, 14]], 0.8) },
  { name: 'Gulf hills', kind: 'hills', poly: R([[35.5, 28.5], [37.5, 25], [40, 20.5], [42.5, 16.5], [44, 14]], 2) },
  { name: 'Point range', kind: 'mountains', strength: 0.75, poly: R([[56.3, 25.5], [57.5, 23.5], [59, 22.6]], 0.6) },
  { name: 'Northern ridges', kind: 'hills', poly: R([[36, 36], [39, 37], [43, 37], [45.5, 35], [46.5, 33]], 1.4) },
  { name: 'Black peaks', kind: 'hills', poly: B(18, 21, 2.4, 1.8) },
  { name: 'Stone plateau', kind: 'hills', poly: B(5.5, 23.3, 2.4, 2.2) },
  { name: 'Western heights', kind: 'hills', poly: B(12.5, 7, 2, 1.6) },
  { name: 'Spring highlands', kind: 'hills', poly: B(-11.5, 11, 2.4, 1.7) },
  { name: 'Desert massif', kind: 'hills', poly: B(8.5, 18.5, 1.6, 1.6) },
  { name: 'Far cape heights', kind: 'hills', poly: B(28, -27, 4, 3) },
  // wetlands
  { name: 'Great marsh', kind: 'swamp', poly: B(30.5, 7.5, 2, 1.5) },
  { name: 'Inland delta', kind: 'swamp', poly: B(22.8, -19.3, 1.4, 1) },
  { name: 'Upper delta', kind: 'swamp', poly: B(-4.5, 14.5, 1.6, 1) },
  { name: 'Bight delta', kind: 'swamp', poly: B(6, 5, 1.4, 0.8) },
  { name: 'Twin river marsh', kind: 'swamp', poly: B(47, 31, 1.2, 0.9) },
  { name: 'Delta fields', kind: 'open', poly: B(31, 30.8, 1.4, 0.7) },
];

const lakes: Pt[][] = [
  fractal(blob(...F(33, -1), 0.65, 0.6, rR, 0.15), rR, 0.15, 3, 0.03),
  strip(FL([[29.3, -3.3], [29.7, -5.5], [30.6, -7.5], [31, -8.6]]), 0.16),
  strip(FL([[34.5, -10], [34.4, -11.8], [34.8, -13.2], [35.2, -14.2]]), 0.13),
  fractal(blob(...F(14, 13), 0.4, 0.3, rR, 0.15), rR, 0.15, 3, 0.03),
];

const rivers: number[][][] = [
  // the long river north through the desert, and the four other great rivers
  [[33, -1], [32.5, 4], [31.5, 9.5], [32.5, 15.6], [33.5, 18], [31, 21], [32.9, 24.1], [31.2, 30], [31, 31.4]],
  [[25, -11], [26, -5], [25, 0.5], [21, 1.5], [17, 0], [15.5, -4.3], [12.3, -6]],
  [[-10.5, 10], [-4, 14.5], [0, 16.5], [3, 13], [6.5, 9], [6.2, 4.6]],
  [[22.5, -12], [23.5, -17.5], [26, -17.9], [30, -15.6], [35.5, -18.5], [36.3, -18.9]],
  [[28, -29], [22, -29], [16.5, -28.6]],
  [[38.5, 37], [41, 35], [44, 33], [47.5, 30.5], [48.4, 30.1]],
].map((l) => pl.ring(smoothOpen(FL(l))));

export const SUNDERED: DrawnMap = {
  land: [mainland, ...isle.land, ...islands].map((p) => pl.ring(p)),
  lakes: lakes.map((p) => pl.ring(p)),
  rivers: [...isle.rivers.map((p) => pl.ring(p)), ...rivers],
  regions: [...isle.regions, ...mainRegions],
  oilZones: [
    P([[47, 29], [50, 27.5], [52, 24], [49, 22], [46.5, 24.5]]),
    B(20, 28, 3, 2),
    B(6, 30, 3, 2),
    B(6, 5, 1.5, 1),
    B(12.5, -6.5, 1, 1.5),
    B(29, 28, 1.5, 1),
    B(30, 8, 2, 1.5),
    B(36, -9, 2, 2),
    B(24, -24, 2, 2),
    ...isle.oil.map((p) => pl.ring(p)),
  ],
  paint: isle.rings.paint,
};

const sp = (name: string, p: Pt, major = false): SpawnDef => ({ name, at: pl.P(p[0], p[1]), major, pop: major ? 2_000_000 : 1_000_000 });

export const SUNDERED_SPAWNS: SpawnDef[] = [
  // the walled island: a strong nation behind the walls and one in its open country
  sp('Taruvan', IC, true),
  sp('Selvane', isle.at(40, 22), true),
  // the mainland
  sp('Brenmar', F(2, 34)),
  sp('Khoril', F(31, 27), true),
  sp('Vashti', F(45, 24.5), true),
  sp('Dorrin', F(-6, 13)),
  sp('Zephren', F(7, 8)),
  sp('Oskaren', F(39, 9)),
  sp('Marlowe', F(22, -2)),
  sp('Tyrnak', F(35, -5)),
  sp('Calvern', F(20, -14)),
  sp('Ulvane', F(27, -28), true),
];
