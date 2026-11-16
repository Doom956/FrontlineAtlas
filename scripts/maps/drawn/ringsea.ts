// "The Dark Beyond": a hand-drawn fictional map. A known world of six continents (a hooked northern land, a tall
// western land with a long spine of a peninsula, a broad southwestern land trailing islands to the south, a great
// eastern land split by a narrow channel into a northern and a southern half with a long southern cape, and a square
// southern isle) sits in the middle of an enormous lake. All round the lake, out to every edge of the map, lies a vast
// unsettled dark continent of bleak heath, sickly fens and dark purple-grey ranges, rich in iron and oil, with a rough
// coast and no nations at all: the prize for the late game. Drawn for this project by hand, point by point (see
// drawn/kit.ts).
import type { DrawnMap, Pt } from './kit';
import { blob, fractal, islandChain, makePlane, path, rngFor, smoothClosed, strip } from './kit';
import type { ExtraRegion } from '../extra';
import type { SpawnDef } from '../defs';

const deg = (d: number): number => (d * Math.PI) / 180;

// ---------- the known world ----------
//
// The continents are drawn on a sketch grid 1900 wide and 1080 tall (x east, y SOUTH), then scaled into the plane:
// S units per grid step, the grid point (KX, KY) at the plane's centre.
const S = 0.044;
const KX = 995;
const KY = 545;
/** sketch grid point -> plane point */
const K = (x: number, y: number): Pt => [(x - KX) * S * 0.93, (KY - y) * S];
/** a coast through sketch grid control points: a few small kinks, smoothed, then light fractal detail */
const shape = (pts: number[][], seed: number, rough = 0.24, per = 5): Pt[] => {
  const rng = rngFor(seed);
  return fractal(smoothClosed(fractal(pts.map(([x, y]) => K(x, y)), rng, 0.1, 2, 0.4), Math.max(2, per - 2)), rng, rough, 4, 0.04);
};

/** stretch a coast's points: x about an anchor, y about a centre */
const stretch = (pts: number[][], ax: number, fx: number, cy: number, fy: number): number[][] => pts.map(([x, y]) => [ax + (x - ax) * fx, cy + (y - cy) * fy]);
/** a small island on the sketch grid: a rough round of radius r (grid steps) */
const isl = (x: number, y: number, r: number, seed: number): Pt[] =>
  shape([0, 1, 2, 3, 4, 5, 6].map((i) => [x + Math.cos(i * 0.9) * r * (i % 2 ? 0.8 : 1.1), y + Math.sin(i * 0.9) * r * 0.85]), seed, 0.25, 4);
const nx = (x: number): number => 353 + (x - 353) * 1.15;

/** The hooked northern land: a round west end, a high north coast, a long hook bending south to the east. */
const NORTH = shape(
  stretch([
    [353, 168], [358, 135], [372, 104], [396, 76], [422, 58], [452, 52], [480, 46], [505, 31], [530, 28], [550, 42], [576, 52],
    [606, 56], [640, 50], [660, 30], [682, 28], [692, 56], [692, 96], [700, 134], [716, 160], [738, 184], [751, 220],
    [757, 262], [754, 300], [746, 328], [722, 327], [690, 313], [656, 300], [628, 283], [598, 262], [568, 242], [540, 246],
    [508, 263], [476, 281], [440, 283], [404, 271], [378, 251], [362, 222],
  ], 353, 1.15, 190, 1.1),
  11,
);
/** the small isle east of the hook */
const NORTH_ISLE = shape([[842, 138], [868, 126], [890, 148], [896, 186], [876, 200], [850, 190], [844, 162]], 12, 0.25, 4);

/** pull the south base of a coast down so it joins the land below */
const lowerBase = (pts: number[][]): number[][] => pts.map(([x, y]) => (y > 470 ? [x, y + 70] : y > 400 ? [x, y + 25] : [x, y]));

/** The tall western land: a long thin spine running north, widening to a broad south with a smooth south coast. */
const WEST = shape(
  lowerBase([
    [258, 138], [270, 148], [281, 178], [291, 222], [308, 272], [333, 309], [365, 344], [404, 378], [428, 410], [446, 444],
    [446, 478], [418, 502], [380, 512], [340, 518], [298, 521], [258, 516], [232, 506], [212, 488], [203, 446], [206, 386],
    [220, 316], [238, 256], [246, 200], [249, 164],
  ]),
  13,
);

/** The island arc between the western land and the hook: two long islands and an islet. */
const ARC: Pt[][] = [
  shape([[476, 455], [490, 438], [510, 420], [528, 408], [534, 418], [518, 436], [498, 452], [484, 462]], 14, 0.2, 4),
  shape([[530, 398], [538, 380], [550, 360], [562, 348], [570, 356], [562, 380], [548, 402], [536, 408]], 15, 0.2, 4),
  shape([[600, 330], [612, 324], [618, 336], [606, 342]], 16, 0.2, 4),
];

/** The broad southwestern land: a straight north coast, a jagged east with a northeast horn, a ragged south. */
const SOUTHWEST = shape(
  [
    [222, 580], [260, 570], [300, 566], [350, 563], [400, 565], [445, 573], [480, 586], [510, 603], [535, 622], [552, 645],
    [574, 650], [602, 634], [636, 612], [666, 590], [690, 566], [704, 544], [722, 548], [746, 568], [780, 600], [815, 630],
    [840, 660], [826, 686], [796, 706], [766, 728], [738, 748], [712, 772], [696, 798], [684, 826], [662, 848], [640, 842],
    [614, 828], [590, 840], [564, 860], [540, 880], [510, 900], [480, 898], [455, 916], [425, 936], [398, 934], [384, 908],
    [374, 878], [352, 860], [328, 876], [305, 896], [282, 918], [258, 906], [240, 876], [221, 850], [218, 815], [232, 780],
    [245, 746], [238, 712], [228, 682], [240, 656], [229, 626], [219, 602],
  ],
  17,
);
/** islands off its south and east */
const SW_ISLES: Pt[][] = [
  shape([[654, 880], [680, 870], [706, 888], [702, 924], [676, 936], [658, 912]], 19, 0.25, 4),
  shape([[948, 778], [964, 790], [952, 822], [936, 852], [922, 878], [908, 868], [918, 838], [934, 806]], 21, 0.25, 4),
  isl(430, 985, 30, 60), isl(500, 1010, 28, 61), isl(575, 1030, 26, 62), isl(650, 1020, 24, 63), isl(730, 990, 24, 64), isl(790, 955, 22, 65),
];
/** the lake in the southwestern land */
const SW_LAKE = shape([[318, 758], [340, 744], [366, 752], [373, 776], [356, 796], [330, 792]], 23, 0.15, 4);

/** The ringed isle in the north of the lake, with a crater lake. */
const RING_ISLE = shape([[1010, 70], [1040, 50], [1078, 54], [1104, 80], [1108, 116], [1084, 142], [1046, 146], [1016, 126], [1004, 98]], 24, 0.25, 4);
const RING_LAKE = shape([[1040, 84], [1062, 80], [1072, 100], [1058, 114], [1040, 108]], 25, 0.15, 4);

/** The northern half of the great eastern land: a northern peninsula, two north inlets, a ragged east coast. */
const EAST_NORTH = shape(
  [
    [1192, 440], [1215, 428], [1242, 410], [1255, 378], [1250, 342], [1258, 292], [1266, 262], [1296, 240], [1345, 232],
    [1385, 226], [1405, 213], [1428, 204], [1446, 214], [1453, 242], [1462, 274], [1480, 272], [1486, 240], [1478, 210],
    [1462, 190], [1444, 180], [1440, 164], [1462, 150], [1482, 138], [1496, 118], [1494, 94], [1474, 70], [1462, 44],
    [1472, 22], [1496, 17], [1516, 30], [1526, 58], [1542, 66], [1556, 74], [1560, 100], [1585, 126], [1600, 146],
    [1594, 172], [1592, 210], [1602, 244], [1616, 246], [1620, 210], [1614, 168], [1616, 132], [1634, 116], [1652, 120],
    [1670, 134], [1688, 160], [1716, 194], [1744, 226], [1757, 262], [1752, 290], [1730, 303], [1702, 316], [1688, 354],
    [1702, 400], [1696, 450], [1722, 478], [1742, 508], [1700, 502], [1640, 496], [1600, 502], [1560, 510], [1500, 526],
    [1460, 540], [1415, 532], [1365, 540], [1295, 540], [1256, 530], [1232, 496], [1205, 460],
  ],
  26,
);
/** the isle off its north */
const EAST_ISLE = shape([[1572, 52], [1592, 46], [1612, 58], [1640, 66], [1650, 82], [1630, 94], [1600, 90], [1578, 76]], 27, 0.25, 4);

/** lift the north shore of the southern half so the channel between the halves is thin */
const raiseNorth = (pts: number[][]): number[][] => pts.map(([x, y]) => (x > 1330 && y < 700 ? [x, y - 62] : [x, y]));

/** The southern half: a long channel along its north shore, a bulging east, a long cape to the south. */
const EAST_SOUTH = shape(
  raiseNorth([
    [1160, 560], [1200, 550], [1252, 553], [1292, 566], [1332, 590], [1366, 614], [1402, 632], [1442, 642], [1482, 641],
    [1520, 626], [1560, 618], [1600, 625], [1640, 628], [1680, 646], [1720, 636], [1756, 631], [1786, 646], [1780, 668],
    [1752, 664], [1726, 688], [1708, 724], [1702, 760], [1692, 788], [1652, 808], [1650, 854], [1642, 896], [1624, 928],
    [1592, 974], [1568, 1012], [1536, 1050], [1504, 1040], [1476, 1002], [1466, 956], [1486, 938], [1460, 912], [1428, 892],
    [1404, 872], [1432, 878], [1470, 864], [1466, 834], [1446, 808], [1418, 816], [1390, 806], [1360, 778], [1345, 742],
    [1336, 718], [1303, 704], [1288, 686], [1256, 672], [1234, 644], [1220, 604], [1196, 598], [1169, 585], [1158, 571],
  ]),
  28,
);
const squash = (pts: number[][]): number[][] => pts.map(([x, y]) => [x, 780 + (y - 780) * 0.8]);
/** The square southern isle, and its islet. */
const SQUARE_ISLE = shape(
  squash([
    [1000, 800], [1060, 780], [1130, 786], [1200, 778], [1270, 790], [1310, 830], [1320, 890], [1316, 950], [1290, 1000],
    [1250, 1030], [1210, 1010], [1180, 960], [1150, 950], [1120, 972], [1090, 1030], [1050, 1034], [1012, 1000], [992, 940],
    [986, 870], [990, 830],
  ]),
  29,
);

/** islets strewn between the southwestern land and the eastern land */
const MID_ISLES: Pt[][] = [isl(1085, 585, 48, 66), isl(1100, 680, 30, 67)];

// ---------- the lake and the dark continent ----------
//
// The lake is a rough ellipse round the known world. The dark continent is everything between its shore and the map
// edges, drawn as four overlapping pieces (land polygons are filled one by one, without holes).
const W = 98;
const H = 68;
export const RINGSEA_PLANE = makePlane(W, H, 38);
const pl = RINGSEA_PLANE;
const LRX = 40;
const LRY = 26;
/** the base ellipse's radius at angle a (degrees, 0 = east, counter-clockwise) */
const ell = (a: number): number => {
  const t = deg(a);
  return 1 / Math.hypot(Math.cos(t) / LRX, Math.sin(t) / LRY);
};
/** a point d units out from the base ellipse at angle a */
const out = (a: number, d: number): Pt => {
  const r = ell(a) + d;
  return [Math.cos(deg(a)) * r, Math.sin(deg(a)) * r];
};

/**
 * The lake shore as [angle, units out from the base ellipse]: a ragged line of small capes and coves, with long capes
 * reaching into the lake where it is widest (north-northeast, north-northwest, southwest, south and southeast) and
 * deep bays at the corners.
 */
const SHORE: [number, number][] = [
  [0, -3.5], [6, -2], [9, -4.2], [14, -0.6], [22, 1.6], [26, 0.4], [29, 2.6], [38, 3], [43, 1.8], [47, 3], [52, 0.6],
  [56, -2.4], [60, -5], [63, -6.6], [66, -2.4], [74, -1.8], [80, -3.4], [85, -2.4], [90, -3.2], [95, -5], [99, -6.6],
  [103, -3.4], [110, 0], [116, -0.6], [122, 1.4], [133, 2.4], [137, 1], [141, 2.4], [150, 1.6], [156, 0], [161, -2.4],
  [167, -1.6], [173, -4.6], [181, -3.8], [188, -2.6], [192, -3.8], [197, -0.4], [204, 1.4], [212, 1.2], [216, 2.6],
  [224, 2.4], [231, 1], [236, -1], [241, -4.4], [245, -5], [249, -4], [254, -3], [260, -5], [266, -5.5], [271, -7],
  [276, -3.6], [282, -3.8], [288, -1], [294, -3], [299, -6.4], [303, -3.6], [308, 0.6], [316, 1.4], [322, 2.6],
  [328, 2.2], [334, 0.4], [340, -0.8], [345, -2.6], [351, -1.8], [356, -3.8],
];
const SHORE_LINE = fractal(smoothClosed(SHORE.map(([a, d]) => out(a, d)), 5), rngFor(40), 0.45, 5, 0.06);
/** the shore's distance out from the base ellipse at angle a (degrees), linear between the control points */
const shoreD = (a: number): number => {
  const t = ((a % 360) + 360) % 360;
  for (let i = 0; i < SHORE.length; i++) {
    const [a0, d0] = SHORE[i];
    const [a1, d1] = i + 1 < SHORE.length ? SHORE[i + 1] : [360, SHORE[0][1]];
    if (t >= a0 && t <= a1) return d0 + ((d1 - d0) * (t - a0)) / (a1 - a0);
  }
  return SHORE[0][1];
};
/** a point d units inland from the lake shore (negative: out into the lake) at angle a */
const sh = (a: number, d: number): Pt => out(a, shoreD(a) + d);
/** the dark continent in four pieces: a stretch of shore closed far outside the map */
const FAR = 120;
const darkPieces: Pt[][] = [];
{
  const n = SHORE_LINE.length;
  const q = Math.floor(n / 4);
  for (let k = 0; k < 4; k++) {
    const a = k * q;
    const b = k === 3 ? n : (k + 1) * q + 3;
    const arc = SHORE_LINE.slice(a, Math.min(n, b)).concat(k === 3 ? SHORE_LINE.slice(0, 3) : []);
    const ang = (p: Pt): number => Math.atan2(p[1], p[0]);
    const a0 = ang(arc[0]);
    let a1 = ang(arc[arc.length - 1]);
    if (a1 < a0) a1 += Math.PI * 2;
    const back: Pt[] = [];
    for (let i = 0; i <= 12; i++) {
      const t = a1 + ((a0 - a1) * i) / 12;
      back.push([Math.cos(t) * FAR, Math.sin(t) * FAR]);
    }
    darkPieces.push(arc.concat(back));
  }
}
/** rocks and skerries off the dark shore */
const rk = rngFor(41);
const skerries: Pt[][] = [
  ...islandChain([sh(36, -1.6), sh(44, -1.4)], 3, 0.25, 0.55, rk, 0.4),
  ...islandChain([sh(128, -1.4), sh(136, -1.2)], 2, 0.25, 0.5, rk, 0.4),
  ...islandChain([sh(214, -1.4), sh(224, -1.2)], 3, 0.25, 0.5, rk, 0.4),
  ...islandChain([sh(316, -1.6), sh(326, -1.4)], 3, 0.25, 0.55, rk, 0.4),
  ...islandChain([sh(196, -1.6)], 1, 0.4, 0.6, rk, 0.3),
  ...islandChain([sh(300, -1.6)], 1, 0.4, 0.6, rk, 0.3),
];

// ---------- relief, biomes, oil ----------

const rg = rngFor(50);
const R = (name: string, kind: ExtraRegion['kind'], p: Pt[], strength?: number): ExtraRegion => ({ name, kind, poly: pl.ring(p), ...(strength ? { strength } : {}) });
/** a blob on the sketch grid (radii in grid steps) */
const kb = (x: number, y: number, rx: number, ry: number, rot = 0, wob = 0.25): Pt[] => blob(...K(x, y), rx * S, ry * S, rg, wob, rot);
/** a ridge through sketch grid points, half width in grid steps */
const kridge = (pts: number[][], half: number): Pt[] => {
  const line: Pt[] = [];
  for (let i = 0; i + 1 < pts.length; i++) line.push(...path(K(pts[i][0], pts[i][1]), K(pts[i + 1][0], pts[i + 1][1]), rg, 0.3, 14).slice(i ? 1 : 0));
  return strip(line, half * S);
};
/** a band of the dark continent from angle a0 to a1 (degrees, counter-clockwise), d0 to d1 units inland from the shore */
const band = (a0: number, a1: number, d0: number, d1: number, wob = 0.8): Pt[] => {
  const w = rngFor(Math.round(a0 * 7 + a1 * 13 + d0 * 17 + d1 * 19));
  const n = Math.max(6, Math.round((a1 - a0) / 3));
  const outer: Pt[] = [];
  const inner: Pt[] = [];
  for (let i = 0; i <= n; i++) {
    const a = a0 + ((a1 - a0) * i) / n;
    outer.push(sh(a, d1 + (w() - 0.5) * 2 * wob));
    inner.push(sh(a, d0 + (w() - 0.5) * 2 * wob));
  }
  return fractal(outer.concat(inner.reverse()), w, 0.18, 3, 0.2);
};
/** a mountain ridge of the dark continent running along the ring from a0 to a1, d0 to d1 units inland, half width hw */
const darkRidge = (a0: number, a1: number, d0: number, d1: number, hw: number): Pt[] => {
  const n = Math.max(3, Math.round((a1 - a0) / 6));
  const line: Pt[] = [];
  for (let i = 0; i < n; i++) {
    const p = sh(a0 + ((a1 - a0) * i) / n, d0 + ((d1 - d0) * i) / n);
    const q = sh(a0 + ((a1 - a0) * (i + 1)) / n, d0 + ((d1 - d0) * (i + 1)) / n);
    line.push(...path(p, q, rg, 0.8, 10).slice(i ? 1 : 0));
  }
  return strip(line, hw);
};
/** a spur of the dark continent running inland at angle a from d0 to d1 units from the shore */
const darkSpur = (a: number, d0: number, d1: number, hw: number): Pt[] => strip(path(sh(a, d0), sh(a + 3, d1), rg, 1, 20), hw);

const regions: ExtraRegion[] = [
  // the hooked northern land: a crag in the west, downs across the north, woods and a dry strip on the hook
  R('Crag of the west', 'mountains', kridge([[400, 118], [432, 140], [462, 170]], 11), 0.78),
  R('North downs', 'hills', kb(500, 100, 50, 26, 0.2)),
  R('Hook downs', 'hills', kb(700, 120, 22, 42)),
  R('Hook hills', 'hills', kb(728, 262, 18, 26)),
  R('North wood', 'woods', kb(420, 210, 42, 30)),
  R('North wood east', 'woods', kb(590, 130, 44, 26)),
  R('Hook wood', 'woods', kb(690, 200, 28, 30)),
  R('Hook sands', 'desert', kb(610, 250, 30, 12, -0.5)),
  R('Hook dunes', 'desert', kb(684, 276, 16, 10, 0.3)),
  R('Isle downs', 'hills', kb(786, 164, 14, 22)),
  // the tall western land: hills down the spine, a wetland on the south coast, woods
  R('Spine hills', 'hills', kridge([[262, 162], [270, 220], [284, 280], [306, 320]], 16)),
  R('West hills', 'hills', kb(236, 420, 20, 34)),
  R('South wetland', 'swamp', kb(376, 478, 34, 16)),
  R('West wood', 'woods', kb(300, 360, 34, 38)),
  R('West wood south', 'woods', kb(262, 476, 26, 22)),
  R('Arc woods', 'woods', kb(522, 410, 40, 14, 0.8)),
  // the southwestern land: a desert on the west coast by its lake, a north-south range, hills, woods, a steppe
  R('West desert', 'desert', kb(272, 722, 42, 46)),
  R('Middle range', 'mountains', kridge([[468, 618], [508, 690], [530, 762], [540, 812]], 13), 0.78),
  R('Middle foothills', 'hills', kridge([[460, 610], [506, 696], [536, 820]], 32)),
  R('Horn hills', 'hills', kb(716, 590, 24, 34)),
  R('East hills', 'hills', kb(780, 650, 34, 18, -0.5)),
  R('South hills', 'hills', kb(424, 892, 30, 20)),
  R('Southwest hills', 'hills', kb(292, 852, 30, 26)),
  R('Arm hills', 'hills', kb(520, 990, 40, 12, -0.4)),
  R('North wood of the southwest', 'woods', kb(372, 612, 50, 26)),
  R('East wood', 'woods', kb(620, 760, 54, 40)),
  R('Horn wood', 'woods', kb(740, 700, 34, 22)),
  R('Middle steppe', 'steppe', kb(430, 770, 50, 44)),
  R('Isle woods', 'woods', kb(680, 902, 20, 24)),
  // the ringed isle
  R('Ring downs', 'hills', kb(1056, 98, 44, 40)),
  // the northern half of the eastern land: mountains down the northern peninsula and the east, a dry heart
  R('Peninsula range', 'mountains', kridge([[1484, 36], [1488, 110], [1474, 186], [1430, 230]], 12), 0.8),
  R('East range', 'mountains', kridge([[1650, 138], [1700, 214], [1724, 290]], 11), 0.78),
  R('Peninsula downs', 'hills', kb(1520, 130, 32, 60)),
  R('Northwest hills', 'hills', kb(1340, 290, 44, 34)),
  R('South hills of the north half', 'hills', kb(1600, 440, 54, 30)),
  R('Port hills', 'hills', kb(1268, 456, 30, 28)),
  R('Dry heart', 'desert', kb(1460, 410, 62, 36)),
  R('Dry steppe', 'steppe', kb(1470, 380, 120, 80)),
  R('Peninsula wood', 'woods', kb(1550, 240, 60, 40)),
  R('East wood of the north half', 'woods', kb(1690, 360, 30, 46)),
  R('West wood of the north half', 'woods', kb(1330, 360, 40, 30)),
  R('North isle downs', 'hills', kb(1612, 70, 30, 14)),
  // the southern half: a coastal range in the east, hills, a dry west, woods down the cape
  R('Coast range', 'mountains', kridge([[1640, 660], [1684, 716], [1690, 780]], 10), 0.76),
  R('Channel hills', 'hills', kb(1500, 690, 52, 28)),
  R('Cape hills', 'hills', kb(1580, 900, 30, 48)),
  R('Southwest dry', 'desert', kb(1418, 760, 34, 26)),
  R('West wood of the south half', 'woods', kb(1320, 640, 52, 34)),
  R('Middle wood of the south half', 'woods', kb(1600, 760, 52, 36)),
  R('Cape wood', 'wet', kb(1530, 1004, 34, 30)),
  R('Arm wood', 'woods', kb(1446, 884, 30, 14, 0.6)),
  // the square southern isle
  R('Square downs', 'hills', kb(1200, 878, 42, 34)),
  R('Square wood', 'woods', kb(1080, 900, 38, 34)),
  R('Square steppe', 'steppe', kb(1150, 920, 50, 30)),
  R('Horn dunes', 'desert', kb(770, 640, 26, 20, 0.3)),
  R('Mid isles woods', 'woods', kb(1110, 600, 60, 50)),

  // the dark continent: a bleak heath everywhere beyond the shore, sickly fens on the shore between, crags on the
  // shore, ranges of dark rock along the ring and great massifs in the corners
  // (a cold heath: tundra even over the foothills, so the hinterland is all heath, fen and dark rock)
  R('Dark heath', 'cold', band(-6, 186, 2.4, 40, 0.4)),
  R('Dark heath south', 'cold', band(174, 366, 2.4, 40, 0.4)),
  ...(
    [
      [64, 82], [94, 120], [160, 200], [244, 260], [274, 294], [336, 376],
    ] as const
  ).map(([a0, a1], i) => R(`Shore heath ${i + 1}`, 'tundra', band(a0, a1, -2, 2.6, 0.3))),
  R('Fen of the northeast', 'swamp', band(12, 66, -3, 2.4)),
  R('Fen of the northwest', 'swamp', band(118, 162, -2, 2.4)),
  R('Fen of the southwest', 'swamp', band(198, 246, -2, 2.4)),
  R('Fen of the southeast', 'swamp', band(292, 338, -2, 2.4)),
  R('Fen of the north cape', 'swamp', band(80, 96, -2, 2.2)),
  R('Fen of the south cape', 'swamp', band(258, 276, -3, 2.2)),
  R('Shore crags east', 'hills', band(-10, 8, 0.6, 2.6)),
  R('Shore crags west', 'hills', band(170, 190, 0.6, 2.6)),
  // ranges along the ring
  R('Dark range north', 'mountains', darkRidge(64, 118, 5, 5.4, 1.2), 0.86),
  R('Dark range south', 'mountains', darkRidge(242, 296, 5.2, 4.8, 1.2), 0.86),
  R('Dark range east', 'mountains', darkRidge(-30, 28, 6.6, 6.2, 1.6), 0.88),
  R('Dark range west', 'mountains', darkRidge(152, 208, 6.2, 6.8, 1.6), 0.88),
  // the corner massifs
  R('Northeast massif', 'mountains', band(26, 56, 9, 40, 1.4), 0.9),
  R('Northwest massif', 'mountains', band(124, 156, 9, 40, 1.4), 0.9),
  R('Southwest massif', 'mountains', band(204, 236, 9, 40, 1.4), 0.9),
  R('Southeast massif', 'mountains', band(304, 336, 9, 40, 1.4), 0.9),
  // spurs running from the corners toward the lake
  R('Spur 1', 'mountains', darkSpur(40, 1, 10, 0.9), 0.84),
  R('Spur 2', 'mountains', darkSpur(140, 1, 10, 0.9), 0.84),
  R('Spur 3', 'mountains', darkSpur(220, 1, 10, 0.9), 0.84),
  R('Spur 4', 'mountains', darkSpur(320, 1, 10, 0.9), 0.84),
];

const oil: Pt[][] = [
  // the known world: by the deserts, the wetland and a few plains fields
  kb(610, 250, 30, 14), kb(684, 276, 18, 12), kb(400, 240, 26, 16), kb(376, 478, 32, 16), kb(320, 400, 24, 20), kb(272, 722, 40, 44), kb(700, 780, 26, 20), kb(770, 640, 28, 22),
  kb(560, 1006, 30, 10), kb(480, 860, 22, 18), kb(1460, 410, 60, 34), kb(1640, 300, 26, 22), kb(1418, 760, 32, 24),
  kb(1560, 940, 22, 30), kb(1150, 930, 40, 20),
  // the dark continent: every fen and broad fields under the heath
  band(14, 60, -1, 2.2), band(118, 162, -1, 2.2), band(198, 246, -1, 2.2), band(292, 338, -1, 2.2), band(80, 96, -1, 2), band(258, 276, -1, 2),
  band(66, 116, 2, 4.4), band(244, 294, 2, 4.4), band(-24, 8, 3.5, 6), band(170, 200, 3.5, 6),
  band(30, 52, 6, 20), band(128, 150, 6, 20), band(208, 230, 6, 20), band(308, 330, 6, 20),
];

// rivers: a few in the known world, and dark rivers running from the ranges down to the lake
const rr = rngFor(60);
const kpath = (a: number[], b: number[], bend: number): Pt[] => path(K(a[0], a[1]), K(b[0], b[1]), rr, bend * S, 24);
const rivers: Pt[][] = [
  kpath([520, 110], [560, 244], 20),
  kpath([300, 330], [262, 512], 20),
  kpath([520, 700], [600, 836], 26),
  kpath([400, 640], [348, 752], 16),
  kpath([1520, 300], [1420, 534], 30),
  kpath([1660, 330], [1720, 480], 20),
  kpath([1560, 700], [1690, 800], 24),
  kpath([1540, 860], [1500, 1036], 20),
  path(sh(48, 8.5), sh(46, -0.5), rr, 1.2, 24),
  path(sh(132, 8.5), sh(134, -0.5), rr, 1.2, 24),
  path(sh(228, 8.5), sh(226, -0.5), rr, 1.2, 24),
  path(sh(312, 8.5), sh(314, -0.5), rr, 1.2, 24),
];

// dark tarns among the ranges
const tarns: Pt[][] = [
  blob(...sh(48, 12), 1.4, 0.9, rg, 0.25, 0.6),
  blob(...sh(142, 11), 1.2, 0.8, rg, 0.25, 2.2),
  blob(...sh(222, 12), 1.3, 0.9, rg, 0.25, 0.9),
  blob(...sh(318, 12), 1.4, 0.8, rg, 0.25, 2.5),
].map((b, i) => fractal(b, rngFor(70 + i), 0.15, 3, 0.05));

export const RINGSEA: DrawnMap = {
  land: [
    NORTH, NORTH_ISLE, WEST, ...ARC, SOUTHWEST, ...SW_ISLES, RING_ISLE, EAST_NORTH, EAST_ISLE, EAST_SOUTH, SQUARE_ISLE,
    ...MID_ISLES, ...darkPieces, ...skerries,
  ].map((p) => pl.ring(p)),
  lakes: [SW_LAKE, RING_LAKE, ...tarns].map((p) => pl.ring(p)),
  rivers: rivers.map((p) => pl.ring(p)),
  regions,
  oilZones: oil.map((p) => pl.ring(p)),
};

const sp = (name: string, x: number, y: number, major = false): SpawnDef => {
  const [u, v] = K(x, y);
  return { name, at: pl.P(u, v), major, pop: major ? 2_000_000 : 1_000_000 };
};

/** Eleven nations, all in the known world; the dark continent is left empty. */
export const RINGSEA_SPAWNS: SpawnDef[] = [
  sp('Ardmoor', nx(400), 195, true),
  sp('Cindral', nx(700), 240),
  sp('Verrin', 310, 380),
  sp('Galdren', 290, 610, true),
  sp('Morrowick', 500, 850),
  sp('Tessaly', 790, 640),
  sp('Ironhal', 1300, 420, true),
  sp('Quorra', 1640, 320),
  sp('Ostheim', 1450, 650, true),
  sp('Ravelle', 1540, 980),
  sp('Bellhaven', 1160, 900),
];
