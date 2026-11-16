// "The Ringlands": a hand-drawn fictional map. A tall island leaning from northwest to southeast, snowy mountains across
// its north end, a pointed northwest corner, a notch in the west coast, an east coast that bulges out twice, a slanting
// southwest shore and a broad southeast lobe. In the middle a compact cluster of three round walls (thin continuous
// mountain rings), each wall with four half-round gate districts bulging outward at north, east, south and west;
// rivers run out from the centre through the gates to every coast. Drawn for this project by hand, point by point
// (see drawn/kit.ts). The island is also used, smaller, in drawn/sundered.ts.
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

export const RINGLANDS_PLANE = makePlane(23, 31.5, 44);
const pl = RINGLANDS_PLANE;

const isle = walledIsle({ plane: pl, cx: 0, cy: 0.3, width: 16, wallFrac: 0.3, thick: 0.125, district: 0.3, gap: 0.13, seed: 300, islets: true });

export const RINGLANDS: DrawnMap = {
  land: isle.land.map((p) => pl.ring(p)),
  lakes: [],
  rivers: isle.rivers.map((p) => pl.ring(p)),
  regions: isle.regions,
  oilZones: isle.oil.map((p) => pl.ring(p)),
  paint: isle.rings.paint,
};

const sp = (name: string, p: Pt, major = false): SpawnDef => ({ name, at: pl.P(p[0], p[1]), major, pop: major ? 2_000_000 : 1_000_000 });
const r = isle.rings;

export const RINGLANDS_SPAWNS: SpawnDef[] = [
  // inside the walls: the crown in the core, then the two rings
  sp('Aldmere', [0, 0.3], true),
  sp('Brannoch', r.between(1, deg(135))),
  sp('Corvane', r.between(2, deg(45))),
  sp('Dunmarrow', r.between(2, deg(225))),
  // the open country outside the outer wall
  sp('Eskerin', isle.at(28, 22), true),
  sp('Halvard', isle.at(72, 24)),
  sp('Ilmarsh', isle.at(24, 56)),
  sp('Kestrelmoor', isle.at(86, 58), true),
  sp('Norvane', isle.at(40, 76)),
  sp('Orlith', isle.at(78, 88)),
];
