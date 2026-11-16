// "The Ringlands": a hand-drawn fictional map of a walled country. Three round walls (thick continuous mountain rings),
// each with four half-round gate districts bulging outward at north, east, south and west, fill most of a tall island;
// rivers run out from the centre through the gates to every coast, forests and fields lie between the walls, and a
// band of open country runs round the outer wall to the coast. Drawn for this project by hand, point by point (see
// drawn/kit.ts). `walledIsle` below is the same island seen from far (the walls a small cluster in its middle), used
// by drawn/sundered.ts; the Ringlands map itself is laid out further down.
import type { DrawnMap, Plane, Pt, WalledRings } from './kit';
import { blob, fractal, islandChain, makePlane, path, rngFor, smoothClosed, strip, walledRings } from './kit';
import type { ExtraRegion } from '../extra';
import type { SpawnDef } from '../defs';

const deg = (d: number): number => (d * Math.PI) / 180;

/**
 * The island outline as [x %, y %] of its bounding box: x from the west edge, y from the NORTH edge. Clockwise from the
 * pointed northwest corner.
 */
const OUTLINE: Pt[] = [
  // north coast: fairly flat, a few shallow bays
  [0.5, 0.5], [5, 1.8], [10, 1.4], [15, 2.6], [23, 1.2], [31, 2.4], [39, 0.6], [47, 1.9], [55, 0.8], [63, 2.4], [70, 1.4], [77, 3.2],
  // northeast: a short stretch south, then out to the first bulge
  [80.5, 6.5], [79.5, 10.5], [82.5, 14], [87, 16.5], [89.5, 21], [91.5, 26.5], [95, 31], [96.5, 35],
  // a bite in the east coast, then south-southeast to the widest point
  [93.5, 39], [89.5, 42], [88.5, 46], [91, 51], [94.5, 56], [98, 61], [99.5, 65], [97.5, 69], [94.5, 72.5], [95.5, 76.5], [97.5, 80],
  // the southeast lobe and its peninsula
  [94, 84], [89, 86.5], [85.5, 90], [83.5, 94.5], [80.5, 98.5], [76.5, 99.5], [74, 96], [73, 91.5], [68.5, 90], [63.5, 90.5], [60, 88.5],
  // the slanting southwest shore with a small bay
  [56, 88.5], [52, 86.5], [49, 83], [45.5, 84.5], [42.5, 84], [39.5, 81], [34, 77.5], [29.5, 74], [25, 70],
  // the west coast, nearly straight, with a notch about 45 % of the way down
  [21, 67], [18, 63], [15.5, 58.5], [13, 53.5], [11, 49], [12, 46.5], [19, 45.6], [18.5, 43.8], [10.5, 42.5], [8, 38.5],
  [7, 33.5], [5, 28.5], [6, 23.5], [4, 18.5], [5, 13.5], [3, 8.5], [2, 4],
];

/** Where the walls are centred, % of the island box. */
const WALL_X = 50;
const WALL_Y = 48;

export interface WalledIsleOpts {
  plane: Plane;
  /** plane point where the walls are centred */
  cx: number;
  cy: number;
  /** island width (units); its height is 1.6 times this */
  width: number;
  /** outer wall diameter as a share of the island width */
  wallFrac: number;
  /** wall thickness, gate district radius and gate gap, units */
  thick: number;
  district: number;
  gap: number;
  seed: number;
  /** add the small islets round the coast */
  islets?: boolean;
}

export interface WalledIsle {
  land: Pt[][];
  rivers: Pt[][];
  regions: ExtraRegion[];
  oil: Pt[][];
  rings: WalledRings;
  /** island box point [x %, y %] -> plane point */
  at(x: number, y: number): Pt;
}

/** The walled island: outline, three walls with gate districts, rivers, relief, forests, oil. */
export function walledIsle(o: WalledIsleOpts): WalledIsle {
  const W = o.width;
  const H = o.width * 1.6;
  const at = (x: number, y: number): Pt => [o.cx + ((x - WALL_X) / 100) * W, o.cy - ((y - WALL_Y) / 100) * H];
  const ctrl = OUTLINE.map(([x, y]) => at(x, y));
  const outline = fractal(smoothClosed(ctrl, 6), rngFor(o.seed + 1), 0.16, 4, W * 0.006);

  const ro = (o.wallFrac * W) / 2;
  const rings = walledRings({
    cx: o.cx,
    cy: o.cy,
    radii: [ro * 0.37, ro * 0.64, ro],
    thick: o.thick,
    gates: [
      [0, 90, 180, 270],
      [0, 90, 180, 270],
      [0, 90, 180, 270],
    ],
    gateWidth: o.gap,
    wobble: 0.004,
    foot: 0,
    district: { radius: o.district, gap: o.gap },
    rng: rngFor(o.seed + 2),
    plane: o.plane,
  });
  // a point at radius r (share of the outer wall) and angle a (degrees) from the wall centre
  const polar = (r: number, a: number): Pt => [o.cx + Math.cos(deg(a)) * r * ro, o.cy + Math.sin(deg(a)) * r * ro];

  const land: Pt[][] = [outline];
  if (o.islets) {
    const sz = W * 0.012;
    land.push(
      ...islandChain([at(-5, 30), at(-4, 36)], 2, sz, sz * 2, rngFor(o.seed + 3), sz),
      ...islandChain([at(1, 60), at(6, 68)], 2, sz, sz * 1.6, rngFor(o.seed + 4), sz),
      ...islandChain([at(103, 44)], 1, sz * 1.4, sz * 2, rngFor(o.seed + 5), sz),
      ...islandChain([at(88, 99), at(96, 94)], 2, sz, sz * 1.8, rngFor(o.seed + 6), sz),
      ...islandChain([at(46, 92)], 1, sz, sz * 1.5, rngFor(o.seed + 7), sz),
    );
  }

  // rivers: straight out of the centre through the gates (north, south, east, west), then winding to the coasts,
  // and three more running from the walls to the northeast, the southeast and the southwest
  const rr = rngFor(o.seed + 8);
  const wind = W * 0.03;
  const out = (a: number): Pt => polar(1.25, a);
  const rivers: Pt[][] = [
    [polar(0.05, 90), out(90)].concat(path(out(90), at(47, 18), rr, wind).slice(1), path(at(47, 18), at(51, 2.5), rr, wind * 0.6).slice(1)),
    [polar(0.05, 270), out(270)].concat(path(out(270), at(49, 72), rr, wind).slice(1), path(at(49, 72), at(44, 84), rr, wind * 0.6).slice(1)),
    [polar(0.05, 0), out(0)].concat(path(out(0), at(89, 46), rr, wind).slice(1)),
    [polar(0.05, 180), out(180)].concat(path(out(180), at(16, 45), rr, wind).slice(1)),
    path(polar(1.15, 40), at(88, 18), rr, wind * 1.5),
    path(polar(1.15, 310), at(84, 88), rr, wind * 1.5),
    path(polar(1.15, 220), at(26, 70), rr, wind),
  ];

  const rg = rngFor(o.seed + 9);
  const b = (x: number, y: number, rx: number, ry: number, wob = 0.2, rot = 0): Pt[] => blob(...at(x, y), (rx / 100) * W, (ry / 100) * H, rg, wob, rot);
  const pb = (r: number, a: number, rx: number, ry: number, rot = 0): Pt[] => blob(...polar(r, a), rx * ro, ry * ro, rg, 0.2, rot);
  const range = (pts: Pt[], half: number): Pt[] => {
    const line: Pt[] = [];
    for (let i = 0; i + 1 < pts.length; i++) line.push(...path(at(...pts[i]), at(...pts[i + 1]), rg, W * 0.02, 16).slice(i ? 1 : 0));
    return strip(line, (half / 100) * W);
  };
  const north1 = range([[6, 7], [18, 9], [30, 7], [42, 11], [55, 9]], 2.6);
  const north2 = range([[24, 15], [38, 18], [52, 15], [64, 8], [76, 6]], 2.2);
  const regions: ExtraRegion[] = [
    // the snowy north: two mountain chains, snow on the high ground, hills below
    { name: 'North range', kind: 'mountains', strength: 0.85, poly: o.plane.ring(north1) },
    { name: 'North range east', kind: 'mountains', strength: 0.82, poly: o.plane.ring(north2) },
    { name: 'Snowfields', kind: 'cold', poly: o.plane.ring(b(24, 7, 17, 4.5, 0.25)) },
    { name: 'Snowfields east', kind: 'cold', poly: o.plane.ring(b(66, 6, 9, 3, 0.25)) },
    { name: 'North downs', kind: 'hills', poly: o.plane.ring(b(40, 18, 24, 5, 0.2)) },
    { name: 'Northwest downs', kind: 'hills', poly: o.plane.ring(b(14, 27, 6, 6, 0.2)) },
    { name: 'East downs', kind: 'hills', poly: o.plane.ring(b(84, 29, 6, 6, 0.2)) },
    { name: 'East hills', kind: 'hills', poly: o.plane.ring(b(88, 63, 5, 6, 0.2)) },
    { name: 'Southeast hills', kind: 'hills', poly: o.plane.ring(b(82, 90, 6, 5, 0.2)) },
    { name: 'South downs', kind: 'hills', poly: o.plane.ring(b(33, 73, 5, 3, 0.25)) },
    { name: 'West ridge', kind: 'hills', poly: o.plane.ring(b(19, 57, 4, 4, 0.25)) },
    // the south coast: a sandy waste, and a wetland in the southeast
    { name: 'South sands', kind: 'desert', poly: o.plane.ring(b(50, 80.5, 9, 4.5, 0.18)) },
    { name: 'Southeast fen', kind: 'swamp', poly: o.plane.ring(b(70, 78, 7, 4, 0.2)) },
    // farmland inside the inner wall
    { name: 'Crown fields', kind: 'open', poly: o.plane.ring(pb(0, 0, 0.33, 0.33)) },
    // planting fields between the walls (open farmland, so the rings stand out on plain green)
    { name: 'Inner fields', kind: 'open', poly: o.plane.ring(pb(0.5, 35, 0.13, 0.09, 2.2)) },
    { name: 'Inner fields east', kind: 'open', poly: o.plane.ring(pb(0.5, 320, 0.1, 0.08, 0.9)) },
    { name: 'North fields', kind: 'open', poly: o.plane.ring(pb(0.82, 60, 0.15, 0.1, 2.6)) },
    { name: 'West fields', kind: 'open', poly: o.plane.ring(pb(0.82, 160, 0.13, 0.1, 1.2)) },
    { name: 'South fields', kind: 'open', poly: o.plane.ring(pb(0.82, 285, 0.13, 0.1, 0.3)) },
    // forests by the walls: west and south between the inner and middle wall, southwest and east between the middle
    // and outer wall
    { name: 'West wood', kind: 'woods', poly: o.plane.ring(pb(0.5, 196, 0.1, 0.07)) },
    { name: 'South wood', kind: 'woods', poly: o.plane.ring(pb(0.5, 240, 0.08, 0.06)) },
    { name: 'Southwest forest', kind: 'woods', poly: o.plane.ring(pb(0.82, 228, 0.14, 0.1, 0.8)) },
    { name: 'Giant wood', kind: 'woods', poly: o.plane.ring(pb(0.82, 330, 0.08, 0.2, 0.9)) },
    // scattered forests over the green land outside
    ...(
      [
        [22, 40, 5, 3], [33, 30, 5, 3], [62, 27, 6, 3], [76, 40, 5, 4], [27, 61, 5, 3], [38, 70, 6, 3], [66, 66, 6, 4],
        [84, 74, 5, 4], [58, 75, 4, 3], [12, 20, 4, 4], [88, 52, 4, 3], [70, 53, 4, 3],
      ] as const
    ).map(([x, y, rx, ry], i): ExtraRegion => ({ name: `Wood ${i + 1}`, kind: 'woods', poly: o.plane.ring(b(x, y, rx, ry, 0.3)) })),
  ];
  // oil: the fen, the sands, the snow, and gas pockets inside each ring of walls
  const oil: Pt[][] = [b(70, 78, 6, 3.5), b(50, 80, 8, 4), b(30, 9, 12, 4), pb(0.2, 300, 0.1, 0.1), pb(0.5, 60, 0.08, 0.08), pb(0.82, 120, 0.08, 0.08), pb(0.82, 280, 0.08, 0.08)];
  return { land, rivers, regions, oil, rings, at };
}

// ---------- the map ----------
//
// The Ringlands map itself is the walled country seen close: the outer wall fills about three quarters of the island's
// width, with a modest band of open country between it and the coast. Shapes are laid out around the wall centre in
// polar terms (radius as a share of the outer wall's radius RO, angle in degrees, 0 = east, counter-clockwise), so the
// island keeps its character (a tall island leaning NW to SE, snowy mountains at the north end, a pointed northwest
// corner, a notch in the west coast, two bulges in the east coast, sands on the south coast and a wetland and a long
// lobe in the southeast) squeezed into the band outside the outer wall.

/** outer wall radius (units) */
const RO = 6;
/** wall thickness, gate district radius and gate gap (units): bold enough to read at whole-map zoom */
const THICK = 0.24;
const DISTRICT = 0.75;
const GAP = 0.3;

/** The coast as [angle (degrees), radius (share of RO)] round the wall centre, counter-clockwise from the east. */
const COAST: [number, number][] = [
  [0, 1.28], [12, 1.23], [28, 1.37], [45, 1.33], [60, 1.45], [75, 1.6], [90, 1.64], [110, 1.68], [128, 1.74], [140, 1.82],
  [152, 1.64], [164, 1.38], [174, 1.29], [181, 1.23], [189, 1.3], [208, 1.3], [228, 1.34], [245, 1.42], [262, 1.56],
  [280, 1.58], [295, 1.66], [307, 1.8], [317, 1.86], [327, 1.66], [339, 1.4], [351, 1.31],
];
/** Coast radius (share of RO) at an angle, linear between the control points. */
function coastR(a: number): number {
  const t = ((a % 360) + 360) % 360;
  for (let i = 0; i < COAST.length; i++) {
    const [a0, r0] = COAST[i];
    const [a1, r1] = i + 1 < COAST.length ? COAST[i + 1] : [COAST[0][0] + 360, COAST[0][1]];
    if (t >= a0 && t <= a1) return r0 + ((r1 - r0) * (t - a0)) / (a1 - a0);
  }
  return COAST[0][1];
}

/** a point at radius r (share of RO) and angle a (degrees) from the wall centre (0, 0) */
const polar = (r: number, a: number): Pt => [Math.cos(deg(a)) * r * RO, Math.sin(deg(a)) * r * RO];

const SEED = 310;
const coast = fractal(smoothClosed(COAST.map(([a, r]) => polar(r, a)), 8), rngFor(SEED + 1), 0.16, 4, 0.08);
const rIs = rngFor(SEED + 3);
const isletAt = (r: number, a: number, size: number): Pt[] => fractal(blob(...polar(r, a), size, size * 0.75, rIs, 0.25, a), rIs, 0.18, 3, 0.04);
const islets: Pt[][] = [isletAt(1.5, 176, 0.35), isletAt(1.62, 22, 0.4), isletAt(2.05, 322, 0.4), isletAt(1.86, 252, 0.3), isletAt(1.9, 94, 0.35), isletAt(1.98, 150, 0.3)];

// the plane: the island's box with a little sea round it, the wall centre moved so the box is centred
const allPts = coast.concat(...islets);
const minX = Math.min(...allPts.map((p) => p[0]));
const maxX = Math.max(...allPts.map((p) => p[0]));
const minY = Math.min(...allPts.map((p) => p[1]));
const maxY = Math.max(...allPts.map((p) => p[1]));
const SEA = 1.1;
export const RINGLANDS_PLANE = makePlane(maxX - minX + 2 * SEA, maxY - minY + 2 * SEA, 44);
const pl = RINGLANDS_PLANE;
const OX = -(minX + maxX) / 2;
const OY = -(minY + maxY) / 2;
const shift = (p: Pt): Pt => [p[0] + OX, p[1] + OY];
const ring = (pts: Pt[]): number[][] => pl.ring(pts.map(shift));

const walls = walledRings({
  cx: OX,
  cy: OY,
  radii: [RO * 0.37, RO * 0.64, RO],
  thick: THICK,
  gates: [
    [0, 90, 180, 270],
    [0, 90, 180, 270],
    [0, 90, 180, 270],
  ],
  gateWidth: GAP,
  wobble: 0.004,
  foot: 0,
  district: { radius: DISTRICT, gap: GAP },
  rng: rngFor(SEED + 2),
  plane: pl,
});

// rivers: from the centre straight out through the four gates of every wall and on to the coasts, and three more
// from the outer wall to the northeast, southeast and southwest coasts
const rr = rngFor(SEED + 8);
const toCoast = (r0: number, a0: number, a1: number, bend: number): Pt[] => path(polar(r0, a0), polar(coastR(a1) + 0.06, a1), rr, bend);
const gateRiver = (a: number, a1: number): Pt[] => [polar(0.03, a), polar(1.22, a)].concat(toCoast(1.22, a, a1, 0.35).slice(1));
const rivers: Pt[][] = [gateRiver(90, 96), gateRiver(270, 263), gateRiver(0, 8), gateRiver(180, 186), toCoast(1.18, 42, 52, 0.4), toCoast(1.18, 318, 320, 0.5), toCoast(1.18, 222, 218, 0.3)];

const rg = rngFor(SEED + 9);
/** a blob at radius r, angle a; rx, ry as shares of RO (rx along the ring by default), rot radians */
const pb = (r: number, a: number, rx: number, ry: number, rot = deg(a) + Math.PI / 2, wob = 0.22): Pt[] => blob(...polar(r, a), rx * RO, ry * RO, rg, wob, rot);
/** a mountain range along an arc at radius r from angle a0 to a1, half width hw (share of RO) */
const arcRange = (r: number, a0: number, a1: number, hw: number): Pt[] => {
  const n = 6;
  const line: Pt[] = [];
  for (let i = 0; i < n; i++) {
    const p = polar(r + (i % 2 ? 0.04 : -0.03), a0 + ((a1 - a0) * i) / (n - 1));
    const q = polar(r + ((i + 1) % 2 ? 0.04 : -0.03), a0 + ((a1 - a0) * (i + 1)) / (n - 1));
    if (i + 1 < n) line.push(...path(p, q, rg, 0.25, 12).slice(i ? 1 : 0));
  }
  return strip(line, hw * RO);
};
const R = (name: string, kind: ExtraRegion['kind'], poly: Pt[], strength?: number): ExtraRegion => ({ name, kind, poly: ring(poly), ...(strength ? { strength } : {}) });

const regions: ExtraRegion[] = [
  // the snowy north end: two ranges, snow on the high ground, cold downs below
  R('North range', 'mountains', arcRange(1.42, 70, 148, 0.075), 0.85),
  R('North range west', 'mountains', arcRange(1.6, 115, 145, 0.055), 0.82),
  R('Snowfields', 'cold', pb(1.54, 124, 0.26, 0.1)),
  R('Snowfields east', 'cold', pb(1.47, 82, 0.14, 0.07)),
  R('North tundra', 'tundra', pb(1.3, 62, 0.12, 0.06)),
  R('Northwest downs', 'hills', pb(1.32, 148, 0.12, 0.08)),
  // the east coast bulges and the southeast lobe
  R('East downs', 'hills', pb(1.29, 30, 0.08, 0.06)),
  R('East hills', 'hills', pb(1.36, 340, 0.06, 0.05)),
  R('Southeast hills', 'hills', pb(1.68, 316, 0.09, 0.06)),
  R('Southeast fen', 'swamp', pb(1.48, 302, 0.16, 0.1)),
  // the south coast: a sandy waste; downs and a little marsh to the southwest
  R('South sands', 'desert', pb(1.42, 270, 0.28, 0.1)),
  R('Southwest downs', 'hills', pb(1.28, 236, 0.08, 0.06)),
  R('Southwest marsh', 'swamp', pb(1.3, 213, 0.06, 0.05)),
  R('West ridge', 'hills', pb(1.24, 196, 0.05, 0.04)),
  // farmland inside the inner wall and between the walls (plain fields, so the rings stand out)
  R('Crown fields', 'open', pb(0, 0, 0.33, 0.33, 0, 0.12)),
  R('Inner fields', 'open', pb(0.5, 35, 0.12, 0.08)),
  R('Inner fields east', 'open', pb(0.5, 320, 0.1, 0.07)),
  R('North fields', 'open', pb(0.82, 60, 0.14, 0.09)),
  R('West fields', 'open', pb(0.82, 160, 0.12, 0.09)),
  R('South fields', 'open', pb(0.82, 290, 0.12, 0.09)),
  // forests between the walls: a small wood inside the middle wall, big ones in the west, southwest and east
  R('Inner wood', 'woods', pb(0.5, 228, 0.08, 0.05)),
  R('Inner wood west', 'woods', pb(0.5, 145, 0.06, 0.045)),
  R('West forest', 'woods', pb(0.82, 205, 0.12, 0.085)),
  R('Southwest forest', 'woods', pb(0.82, 245, 0.12, 0.08)),
  R('Long wood', 'woods', pb(0.83, 335, 0.07, 0.17, deg(335) + 0.2)),
  R('North wood', 'woods', pb(0.82, 115, 0.08, 0.05)),
  // scattered woods in the country outside
  ...([[1.42, 100, 0.08, 0.05], [1.3, 45, 0.06, 0.04], [1.3, 175, 0.05, 0.04], [1.36, 250, 0.07, 0.05], [1.5, 310, 0.07, 0.05], [1.4, 290, 0.06, 0.04]] as const).map(
    ([r, a, rx, ry], i) => R(`Wood ${i + 1}`, 'woods', pb(r, a, rx, ry)),
  ),
];
// oil: the fen, the sands, the snow, the marsh, and gas pockets inside each ring of walls
const oil: Pt[][] = [
  pb(1.48, 302, 0.14, 0.09), pb(1.42, 270, 0.24, 0.09), pb(1.54, 124, 0.22, 0.09), pb(1.3, 213, 0.06, 0.05), pb(1.3, 62, 0.1, 0.05),
  pb(0.18, 300, 0.08, 0.08), pb(0.5, 60, 0.06, 0.06), pb(0.5, 200, 0.06, 0.06), pb(0.5, 285, 0.05, 0.05),
  pb(0.84, 125, 0.07, 0.07), pb(0.84, 275, 0.07, 0.07), pb(0.84, 20, 0.06, 0.06), pb(0.84, 225, 0.06, 0.06),
];

export const RINGLANDS: DrawnMap = {
  land: [coast, ...islets].map(ring),
  lakes: [],
  rivers: rivers.map(ring),
  regions,
  oilZones: oil.map(ring),
  paint: walls.paint,
};

const sp = (name: string, p: Pt, major = false): SpawnDef => ({ name, at: pl.P(p[0], p[1]), major, pop: major ? 2_000_000 : 1_000_000 });
/** the middle of wall k's gate district at angle a (plane point, already shifted) */
const district = (k: number, a: number): Pt => {
  const t = deg(a);
  const r = walls.radiusAt(k, t) + THICK / 2 + DISTRICT * 0.45;
  return [OX + Math.cos(t) * r, OY + Math.sin(t) * r];
};

export const RINGLANDS_SPAWNS: SpawnDef[] = [
  // the crown in the core
  sp('Aldmere', [OX, OY], true),
  // between the inner and the middle wall
  sp('Brannoch', walls.between(1, deg(45))),
  sp('Halvard', walls.between(1, deg(150))),
  sp('Ilmarsh', walls.between(1, deg(225))),
  // the middle wall's four gate districts, between the middle and the outer wall
  sp('Corvane', district(1, 90)),
  sp('Dunmarrow', district(1, 0)),
  sp('Kestrelmoor', district(1, 270), true),
  sp('Thornwick', district(1, 180)),
  // the open country outside the outer wall
  sp('Eskerin', shift(polar(1.45, 140)), true),
  sp('Orlith', shift(polar(1.5, 312))),
  sp('Norvane', shift(polar(1.27, 228))),
];
