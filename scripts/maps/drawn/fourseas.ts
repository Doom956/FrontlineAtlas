// "The Sundering Wall": a hand-drawn fictional map. One red-rock continent runs the whole height of the world, a little
// west of centre: wide sprawling lobes in the north and south, a narrow neck in the middle, and a spine of impassable
// high peaks with livable coasts on both sides. A belt of islands crosses the world west to east and meets the neck at
// a mountain crossing, where five channels climb from all sides to a single peak. Calm, empty strips of sea run along
// both edges of the belt. The wall and the belt cut four seas, each with its own coasts and islands, and the far side
// of the wall shows again along the west and east edges of the map.
//
// Every outline is drawn by hand below as points on a 1000 x 1000 sketch grid ([x east, y down], 0..1000 over the
// whole map), then smoothed and roughened a little so the coasts look natural.
import type { DrawnMap } from './kit';
import { blob, fractal, makePlane, rngFor, smoothClosed, strip, wobbler } from './kit';
import type { Pt } from './kit';
import type { SpawnDef } from '../defs';
import type { ExtraKind, ExtraRegion } from '../extra';

// plane size in units (about 111 km each); centred on 38 N so the climate stays mid-latitude
const W = 79;
const H = 50;
export const FOURSEAS_PLANE = makePlane(W, H, 38);

type G = [number, number];
/** sketch grid point -> plane point */
const F = (x: number, y: number): Pt => [(x / 1000 - 0.5) * W, (0.5 - y / 1000) * H];
const ring = (pts: Pt[]): number[][] => FOURSEAS_PLANE.ring(pts);

/** a coast drawn by its outline on the sketch grid: smoothed, then roughened lightly */
function coast(pts: G[], seed: number, rough = 0.16, per = 6): Pt[] {
  const rng = rngFor(seed);
  return fractal(smoothClosed(pts.map(([x, y]) => F(x, y)), per), rng, rough, 4, 0.05);
}
/** a small island: a wobbly ellipse at a sketch point, radii in plane units */
function isle(x: number, y: number, rx: number, ry: number, rot: number, seed: number, wob = 0.22): Pt[] {
  const rng = rngFor(seed);
  const [u, v] = F(x, y);
  return fractal(blob(u, v, rx, ry, rng, wob, rot, 48), rng, 0.2, 4, 0.04);
}
/** an island drawn by hand around a sketch point: its corners on a little square grid of its own ([x east, y down],
 * one step = `s` plane units, so the shape keeps its true proportions), smoothed and roughened lightly */
function shape(x0: number, y0: number, s: number, pts: G[], seed: number, rough = 0.1, per = 5): Pt[] {
  return fractal(smoothClosed(local(x0, y0, s, pts), per), rngFor(seed), rough, 4, 0.04);
}
/** the same little grid as `shape`, as plain plane points (for lines drawn across an island) */
function local(x0: number, y0: number, s: number, pts: G[]): Pt[] {
  const [u0, v0] = F(x0, y0);
  return pts.map(([x, y]): Pt => [u0 + x * s, v0 - y * s]);
}
/** a crescent island opening towards `dir` (radians): an arc of land around a sheltered bay */
function crescent(x: number, y: number, r: number, dir: number, seed: number): Pt[] {
  const [u, v] = F(x, y);
  const out: Pt[] = [];
  const n = 28;
  for (let i = 0; i <= n; i++) {
    const a = dir + 0.75 + ((Math.PI * 2 - 1.5) * i) / n;
    out.push([u + Math.cos(a) * r, v + Math.sin(a) * r]);
  }
  const ic: Pt = [u + Math.cos(dir) * r * 0.42, v + Math.sin(dir) * r * 0.42];
  for (let i = n; i >= 0; i--) {
    const a = dir + 0.95 + ((Math.PI * 2 - 1.9) * i) / n;
    out.push([ic[0] + Math.cos(a) * r * 0.72, ic[1] + Math.sin(a) * r * 0.72]);
  }
  return fractal(out, rngFor(seed), 0.18, 3, 0.04);
}
/** points along a hand-drawn open line on the sketch grid, densified (straight pieces between the given points) */
function line(pts: G[], step = 0.3): Pt[] {
  const p = pts.map(([x, y]) => F(x, y));
  const out: Pt[] = [];
  for (let i = 0; i < p.length - 1; i++) {
    const [a, b] = [p[i], p[i + 1]];
    const k = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / step));
    for (let q = 0; q < k; q++) out.push([a[0] + ((b[0] - a[0]) * q) / k, a[1] + ((b[1] - a[1]) * q) / k]);
  }
  out.push(p[p.length - 1]);
  return out;
}
/** a mountain ridge along a hand-drawn line: the line swings sideways and the width swells and narrows, then the
 * edges are roughened, so it reads as a range of peaks rather than a road */
function ridge(pts: G[], half: number[], seed: number, swing = 0.5, swell = 0.35): Pt[] {
  const rng = rngFor(seed);
  const side = wobbler(rng, 5, 2);
  const wide = wobbler(rng, 6, 3);
  const c = line(pts, 0.25);
  const hw = c.map((_, i) => {
    const t = (i / (c.length - 1)) * (half.length - 1);
    const j = Math.min(half.length - 2, Math.floor(t));
    return half[j] + (half[j + 1] - half[j]) * (t - j);
  });
  const left: Pt[] = [];
  const right: Pt[] = [];
  for (let i = 0; i < c.length; i++) {
    const a = c[Math.max(0, i - 1)];
    const b = c[Math.min(c.length - 1, i + 1)];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    const nx = -(b[1] - a[1]) / len;
    const ny = (b[0] - a[0]) / len;
    const t = (i / (c.length - 1)) * Math.PI * 2;
    const off = swing * side(t * 1.5);
    const w = hw[i] * (1 + swell * wide(t * 2.2));
    left.push([c[i][0] + nx * (off + w), c[i][1] + ny * (off + w)]);
    right.push([c[i][0] + nx * (off - w), c[i][1] + ny * (off - w)]);
  }
  return fractal(left.concat(right.reverse()), rng, 0.3, 4, 0.05);
}

// ======================= the wall continent =======================

// the northern half: a broad mass at the top edge, a big western lobe with a hooked cape and a fingered arm, a long
// east coast with a fjord, and a smaller lobe on the east near the belt; it narrows to the neck
const NORTH = coast(
  [
    [362, -30], [368, 0], [380, 25], [391, 55], [386, 80], [371, 104], [353, 124], [338, 147], [318, 159], [298, 166],
    [285, 177], [301, 186], [306, 196], [284, 203], [255, 206], [226, 203], [202, 205], [188, 213], [194, 227], [184, 243],
    [173, 258], [167, 271], [179, 274], [191, 259], [202, 249], [212, 259], [224, 273], [233, 292], [238, 316], [241, 340],
    [247, 362], [254, 373], [261, 353], [264, 331], [269, 317], [283, 310], [301, 300], [326, 295], [347, 302], [353, 322],
    [348, 345], [336, 361], [312, 367], [292, 371], [286, 382], [301, 392], [289, 403], [293, 420], [311, 427], [296, 441],
    [289, 456], [306, 462], [330, 458], [348, 466], [380, 470], [420, 470], [452, 465], [452, 440], [451, 410],
    [461, 402], [471, 426], [481, 458], [490, 481], [498, 487], [508, 471], [516, 453], [529, 445], [529, 424], [520, 405],
    [515, 385], [508, 369], [512, 344], [522, 318], [532, 290], [535, 262], [537, 232], [534, 205], [537, 180], [531, 161],
    [515, 154], [501, 150], [499, 140], [511, 129], [528, 112], [548, 104], [570, 103], [588, 91], [598, 62], [602, 30],
    [597, 0], [600, -30],
  ],
  11,
);

// the neck at the belt: one block that the channels of the crossing cut into five pieces
const NECK = coast(
  [
    [336, 466], [346, 482], [356, 504], [370, 528], [383, 548], [389, 577], [384, 603], [372, 628], [352, 650], [331, 664],
    [322, 677], [342, 690], [380, 690], [420, 692], [470, 690], [484, 672], [484, 640], [482, 600], [489, 586], [483, 572],
    [482, 540], [479, 506], [473, 489], [464, 474], [452, 460], [420, 455], [380, 455], [350, 456],
  ],
  12,
  0.1,
);

// the southern half: a western lobe with a hooked cape over a sound, a long boot-shaped peninsula below it, and a
// narrow east coast down to the bottom edge
const SOUTH = coast(
  [
    [431, 572], [455, 600], [470, 625], [481, 650], [484, 690], [490, 720], [496, 760], [494, 800], [490, 840], [485, 880],
    [475, 905], [460, 930], [448, 960], [442, 1000], [440, 1030], [352, 1030], [357, 985], [364, 965], [375, 948],
    [390, 930], [392, 900], [395, 870], [400, 850], [398, 830], [402, 816], [380, 808], [350, 805], [322, 803], [300, 797],
    [278, 790], [263, 798], [252, 806], [247, 791], [256, 779], [251, 764], [246, 747], [248, 723], [257, 705], [271, 697],
    [300, 692], [325, 690], [350, 683], [372, 672], [392, 656], [405, 635], [415, 610],
  ],
  13,
);
const BOOT = coast(
  [
    [283, 868], [297, 863], [313, 877], [329, 871], [337, 858], [332, 836], [329, 819], [340, 815], [353, 827], [356, 847],
    [354, 865], [362, 883], [378, 889], [392, 878], [404, 900], [402, 946], [386, 947], [362, 921], [341, 909], [321, 921],
    [305, 933], [296, 910], [288, 886],
  ],
  14,
);

// the crossing: five channels climb from the four seas and the belt to one peak in a small basin
const CROSS = F(431, 568);
const ARMS: G[] = [
  [341, 474], // from the north-west sea
  [326, 674], // from the south-west sea
  [474, 482], // from the north-east sea
  [486, 680], // from the south-east sea
  [500, 580], // down into the belt, eastwards
];
const ARM_HALF = 0.36;
const BASIN_IN = 0.5;
const BASIN_OUT = 1.05;
const channels: Pt[][] = ARMS.map(([x, y]) => {
  const [u, v] = F(x, y);
  const dx = u - CROSS[0];
  const dy = v - CROSS[1];
  const len = Math.hypot(dx, dy);
  const ex = dx / len;
  const ey = dy / len;
  const r0 = BASIN_IN + 0.15;
  const r1 = len + 0.8;
  const nx = -ey * ARM_HALF;
  const ny = ex * ARM_HALF;
  const a: Pt = [CROSS[0] + ex * r0, CROSS[1] + ey * r0];
  const b: Pt = [CROSS[0] + ex * r1, CROSS[1] + ey * r1];
  return [
    [a[0] + nx, a[1] + ny],
    [b[0] + nx, b[1] + ny],
    [b[0] - nx, b[1] - ny],
    [a[0] - nx, a[1] - ny],
  ];
});
// the basin around the peak: a ring of water in six arcs (lakes carve the land, so the peak itself stays land)
const basin: Pt[][] = [];
for (let s = 0; s < 6; s++) {
  const a0 = (s / 6) * Math.PI * 2;
  const a1 = ((s + 1) / 6) * Math.PI * 2 + 0.05;
  const pts: Pt[] = [];
  for (let i = 0; i <= 8; i++) {
    const a = a0 + ((a1 - a0) * i) / 8;
    pts.push([CROSS[0] + Math.cos(a) * BASIN_OUT, CROSS[1] + Math.sin(a) * BASIN_OUT]);
  }
  for (let i = 8; i >= 0; i--) {
    const a = a0 + ((a1 - a0) * i) / 8;
    pts.push([CROSS[0] + Math.cos(a) * BASIN_IN, CROSS[1] + Math.sin(a) * BASIN_IN]);
  }
  basin.push(pts);
}

// the far side of the wall, seen again along the west and east edges of the map
const WEST_EDGE_N = coast(
  [
    [-30, -30], [76, -30], [76, 0], [68, 20], [60, 40], [52, 60], [50, 80], [53, 100], [57, 125], [52, 150], [48, 180],
    [51, 205], [45, 230], [36, 250], [28, 266], [14, 275], [27, 285], [19, 294], [-30, 294],
  ],
  21,
);
const WEST_EDGE_S = coast(
  [
    [-30, 304], [20, 309], [45, 311], [64, 315], [60, 323], [40, 329], [26, 341], [25, 362], [22, 400], [18, 440],
    [22, 470], [25, 495], [28, 520], [30, 550], [26, 575], [31, 592], [46, 602], [57, 618], [62, 638], [75, 650], [80, 680],
    [78, 702], [66, 730], [60, 750], [74, 762], [77, 786], [66, 802], [51, 821], [40, 836], [20, 850], [2, 862], [-30, 864],
  ],
  22,
);
const EAST_EDGE = coast(
  [
    [1030, -30], [938, -30], [933, 30], [936, 80], [943, 130], [946, 180], [947, 230], [953, 262], [958, 300], [951, 325],
    [948, 360], [952, 395], [938, 410], [934, 432], [946, 446], [955, 470], [958, 500], [955, 530], [953, 570], [956, 610],
    [957, 650], [955, 700], [958, 740], [962, 773], [966, 820], [969, 860], [968, 900], [976, 926], [1030, 932],
  ],
  23,
);

// ======================= the four seas =======================

// north-west: a long fish-shaped island off the western lobe, an islet off the west coast and a few rocks
const NW_FISH = coast(
  [
    [124, 335], [145, 338], [163, 346], [185, 357], [205, 363], [213, 376], [209, 398], [203, 428], [192, 419], [177, 410],
    [160, 392], [140, 381], [124, 372], [118, 352],
  ],
  31,
);
const NW_SMALL = [isle(29, 302, 0.75, 0.45, 0.2, 32), isle(118, 240, 0.6, 0.4, 0.8, 33), isle(265, 440, 0.55, 0.35, 0.4, 34), isle(95, 430, 0.5, 0.35, 1.1, 35)];

// north-east: a dense patchwork of islands under the top edge, split by narrow sounds. A broad blocky island with a
// lobed east side, a long broken chain running down from the top edge, a wide island in the top right with a spur
// hanging south, a lumpy island with a little sister to its east, short chains below, an oval island hard by the east
// wall and a scatter of islets between them
const NE_BIG = coast(
  [
    [660, -30], [760, -30], [757, 22], [766, 52], [768, 78], [757, 93], [740, 88], [732, 108], [720, 130], [706, 134],
    [696, 117], [686, 99], [674, 74], [664, 49], [658, 20],
  ],
  41,
);
const NE_ROUND = coast(
  [[748, 128], [762, 121], [776, 130], [787, 126], [794, 141], [788, 160], [784, 178], [772, 187], [760, 181], [750, 170], [743, 150]],
  42,
);
const NE_LONG = coast(
  [[804, 145], [797, 138], [801, 118], [809, 97], [814, 76], [822, 58], [832, 46], [841, 50], [838, 66], [830, 86], [823, 108], [816, 128]],
  43,
);
const NE_LONG_TOP = coast([[826, -30], [856, -30], [852, 8], [846, 30], [836, 38], [828, 22]], 39);
const NE_TOP = coast(
  [
    [870, -30], [920, -30], [916, 8], [906, 30], [900, 56], [902, 88], [898, 116], [887, 124], [880, 104], [878, 80],
    [871, 70], [866, 52], [866, 24],
  ],
  44,
);
const NE_SMALL = [
  coast([[650, 126], [665, 117], [679, 124], [683, 141], [678, 159], [667, 167], [654, 162], [648, 145]], 45),
  coast([[680, 148], [690, 143], [697, 156], [694, 176], [690, 196], [680, 204], [673, 190], [676, 170]], 46),
  coast([[700, 130], [712, 126], [718, 138], [713, 155], [702, 160], [697, 146]], 47),
  coast([[797, 150], [807, 146], [813, 158], [810, 174], [800, 181], [794, 168]], 48),
  coast([[740, 186], [750, 182], [754, 196], [749, 211], [740, 208], [737, 196]], 49),
  coast([[726, 216], [736, 212], [741, 226], [736, 241], [727, 239], [723, 227]], 50),
  coast([[916, 104], [926, 108], [931, 128], [928, 152], [921, 168], [913, 160], [911, 132]], 55),
  coast([[773, 98], [784, 94], [791, 104], [786, 117], [775, 116]], 58),
  isle(624, 14, 1.0, 0.7, 0.4, 51),
  isle(545, 118, 0.7, 0.35, 0.2, 52),
  isle(570, 121, 0.6, 0.32, 0.1, 53),
  isle(866, 115, 0.55, 0.3, 0.1, 54),
  isle(790, 30, 0.8, 0.5, 0.7, 59),
  isle(788, 62, 0.45, 0.3, 1.0, 60),
  isle(848, 118, 0.5, 0.35, 0.4, 65),
  isle(866, 150, 0.4, 0.3, 0.2, 66),
  isle(640, 82, 0.6, 0.4, 0.9, 67),
  isle(727, 163, 0.45, 0.35, 0.3, 68),
  isle(712, 215, 0.4, 0.3, 0.6, 69),
  isle(762, 216, 0.45, 0.3, 0.2, 70),
  isle(612, 450, 0.55, 0.4, 0.6, 56),
  isle(548, 428, 0.5, 0.3, 0.3, 57),
];

// south-west: islets off the hooked cape and in the open sea
const SW_SMALL = [isle(240, 868, 0.85, 0.5, 0.1, 61), isle(150, 720, 0.55, 0.4, 0.5, 62), isle(182, 935, 0.7, 0.45, 1.0, 63), isle(110, 870, 0.45, 0.35, 0.3, 64)];

// south-east: one big island mass with a bay on its east side, a long islet off its north-west, an island with arms by
// the east wall, and a fish-shaped island near the bottom
const SE_BIG = coast(
  [
    [594, 711], [600, 723], [604, 748], [613, 773], [629, 779], [637, 773], [643, 785], [645, 810], [653, 822], [665, 810],
    [677, 816], [680, 835], [681, 853], [690, 862], [681, 872], [669, 865], [657, 872], [649, 884], [657, 896], [660, 921],
    [653, 940], [637, 940], [625, 921], [629, 902], [633, 890], [621, 884], [613, 902], [592, 921], [580, 946], [560, 964],
    [540, 977], [520, 973], [514, 958], [518, 933], [528, 909], [520, 890], [508, 872], [504, 859], [510, 835], [524, 822],
    [520, 806], [505, 799], [508, 789], [532, 785], [552, 785], [568, 773], [580, 748], [586, 723],
  ],
  71,
);
const SE_SMALL = [
  coast([[526, 790], [530, 772], [541, 756], [554, 754], [556, 765], [545, 782], [535, 797]], 72),
  coast([[895, 672], [905, 661], [918, 668], [929, 659], [943, 662], [949, 673], [939, 681], [941, 700], [930, 714], [915, 712], [905, 700], [898, 688]], 73),
  coast([[797, 975], [805, 960], [818, 955], [829, 944], [843, 945], [851, 961], [848, 980], [838, 992], [820, 995], [805, 990]], 74),
  isle(759, 955, 0.5, 0.4, 0.3, 75),
  isle(720, 760, 0.55, 0.4, 0.8, 76),
  isle(800, 840, 0.6, 0.4, 0.2, 77),
];

// ======================= the island belt =======================
// Islands between the calm strips (sketch y 519..624). The route runs east from the crossing to the east wall (the
// first half: many islands, each with its own look, one big desert island the largest), then comes back in from the
// west edge and runs east to the crossing again (the second half: fewer islands, but larger and stranger).

// --- first half, east of the wall, in route order ---
// a lone rock where the channel of the crossing spills into the belt
const B_ROCK = isle(514, 603, 0.3, 0.22, 0.3, 120);
// a tall island crowned with round rock pillars along its north shore
const B_PILLARS = shape(536, 562, 0.08, [
  [-5, 10], [-6, 4], [-7, -2], [-9, -6], [-8, -10], [-5, -9], [-4, -13], [-1, -15], [1, -11], [3, -14], [6, -12], [6, -7],
  [8, -4], [7, 2], [5, 8], [1, 11],
], 121);
// a lumpy jungle island where old beasts still roam
const B_JUNGLE = shape(565, 593, 0.095, [
  [0, -12], [7, -10], [12, -4], [11, 4], [13, 9], [6, 12], [-2, 11], [-9, 12], [-12, 5], [-11, -3], [-8, -9],
], 122);
// a winter island: a squat round plateau with sheer sides and one deep cove on its west side
const B_WINTER = shape(606, 546, 0.085, [
  [-9, -9], [-3, -11], [4, -11], [10, -8], [12, -1], [10, 7], [4, 11], [-3, 11], [-9, 8], [-11, 3], [-6, 1], [-11, -2],
], 123);
// an empty islet south of the winter island
const B_EMPTY = isle(626, 614, 0.32, 0.24, 0.5, 124);
// the desert kingdom: the biggest island of the first half, a broad bean with a river bay on its south coast and a
// sandy cape to the north-east
const B_DESERT = shape(672, 571, 0.17, [
  [-13, 1], [-12, -3], [-11, -7], [-6, -9], [0, -10], [5, -8], [9, -11], [13, -7], [13, 0], [11, 5], [7, 8], [2, 9],
  [-1, 6], [-3, 9], [-8, 8], [-11, 5],
], 125, 0.08);
// the bitten island: a round island with its east half torn away, leaving a hollow coast facing east
const B_BITTEN = shape(727, 558, 0.1, [
  [-2, -12], [-8, -9], [-12, -3], [-12, 4], [-8, 10], [-1, 12], [5, 11], [2, 7], [-1, 3], [0, -1], [3, -5], [5, -9],
  [3, -12],
], 126);
// islands in the clouds: a ring of tiny islets in the open sea beside the bitten island
const B_SKY: Pt[][] = [];
for (let i = 0; i < 8; i++) {
  const a = (i / 8) * Math.PI * 2 + 0.3;
  const [u, v] = F(752, 604);
  const r = 0.85 + 0.12 * Math.sin(i * 2.3);
  B_SKY.push(fractal(blob(u + Math.cos(a) * r * 1.15, v + Math.sin(a) * r, 0.17 + 0.05 * ((i * 5) % 3), 0.15, rngFor(130 + i), 0.2, a, 24), rngFor(140 + i), 0.15, 3, 0.04));
}
// the long chain: thin islands in an arc, end to end
const B_LONG = [
  isle(779, 619, 0.36, 0.13, 0.12, 151, 0.15),
  isle(790, 616, 0.36, 0.13, 0.2, 152, 0.15),
  isle(801, 613, 0.36, 0.13, 0.25, 153, 0.15),
  isle(812, 609, 0.36, 0.13, 0.35, 154, 0.15),
  isle(822, 603, 0.32, 0.13, 0.6, 155, 0.15),
];
// the water city: a round island cut by four straight canals to its centre
const B_WATER = shape(794, 549, 0.075, [
  [0, -11], [3, -11], [1.5, -4], [5, -10], [9, -7], [11, -2], [5, -0.8], [11, 2], [10, 7], [5, 10], [1.5, 4], [0, 11],
  [-5, 10], [-9, 7], [-11, 2], [-5, 0.8], [-11, -2], [-10, -7], [-5, -10], [-1.5, -4],
], 156, 0.05, 3);
// the court island: a ring of land around a deep hole, open on its south side
const B_RING = shape(827, 572, 0.06, [
  [0, -10], [7, -7], [10, 0], [7, 7], [2.5, 10], [2.5, 5], [4, 3], [5, 0], [4, -3], [0, -5], [-4, -3], [-5, 0], [-4, 3],
  [-2.5, 5], [-2.5, 10], [-7, 7], [-10, 0], [-7, -7],
], 157, 0.05, 3);
// the ghost ship isle: a sharp triangle of marsh in a foggy patch of sea
const B_TRIANGLE = shape(861, 598, 0.08, [[0, -10], [3, -4], [6, 2], [9, 8], [3, 8], [-3, 8], [-9, 8], [-6, 2], [-3, -4]], 158, 0.06, 2);
// the mangrove archipelago before the east wall: a tight oval of small tree islets
const B_MANGROVE = (
  [
    [888, 545, 0.28, 0.22], [899, 541, 0.25, 0.2], [910, 548, 0.3, 0.22], [884, 560, 0.3, 0.25], [896, 558, 0.22, 0.2],
    [908, 563, 0.28, 0.24], [918, 559, 0.2, 0.18], [887, 577, 0.26, 0.22], [899, 575, 0.3, 0.22], [911, 580, 0.25, 0.2],
    [893, 592, 0.24, 0.2], [905, 594, 0.28, 0.2], [880, 590, 0.2, 0.16],
  ] as number[][]
).map(([x, y, rx, ry], i) => isle(x, y, rx, ry, i * 0.7, 160 + i, 0.25));
// the fortress bay against the east wall: a hooked crescent around a harbour, opening west
const B_FORT = crescent(936, 616, 0.6, 3.1, 139);

// --- second half, from the west edge back east to the crossing ---
// the fire and ice island: two half islands split by a narrow north-south strait (scorched west, frozen east)
const B_FIRE = shape(62, 576, 0.09, [[-1.3, -10], [-6, -9], [-10, -4], [-10, 3], [-6, 9], [-1.3, 10], [-1.3, 5], [-1.3, 0], [-1.3, -5]], 171, 0.06, 3);
const B_ICE = shape(62, 576, 0.09, [[1.3, -10], [6, -9], [10, -4], [10, 3], [6, 9], [1.3, 10], [1.3, 5], [1.3, 0], [1.3, -5]], 172, 0.06, 3);
// the kidney island: a big island with a deep south bay and a green islet off its south shore
const B_KIDNEY = shape(114, 551, 0.12, [
  [-11, -4], [-8, -10], [-1, -12], [6, -10], [11, -5], [12, 2], [8, 8], [3, 9], [0, 5], [-3, 9], [-9, 8], [-12, 3],
], 173);
const B_KIDNEY_ISLET = isle(116, 597, 0.45, 0.3, 0.2, 174);
// the walking beast island: an oval body on four stubby legs, its trunk curling out to the west
const B_BEAST = shape(172, 573, 0.075, [
  [-8, -6], [-2, -9], [5, -8], [10, -5], [12, 0], [10, 4], [9, 8], [7, 8], [6, 5], [3, 6], [2, 9], [0, 9], [-1, 6],
  [-4, 6], [-5, 9], [-7, 9], [-8, 5], [-10, 3], [-13, 2], [-15, 4], [-17, 2], [-15, -1], [-11, -2],
], 175, 0.05, 3);
// the sweets archipelago: a big round island inside a ring of islets
const B_SWEETS = shape(234, 570, 0.12, [
  [0, -12], [6, -11], [11, -6], [12, 0], [10, 7], [5, 11], [-1, 12], [-7, 10], [-12, 4], [-11, -3], [-7, -10],
], 176);
const B_SWEETS_RING: Pt[][] = [];
for (let i = 0; i < 11; i++) {
  const a = (i / 11) * Math.PI * 2 + 0.2;
  const [u, v] = F(234, 570);
  const r = 2.4 + 0.15 * Math.sin(i * 1.7);
  B_SWEETS_RING.push(fractal(blob(u + Math.cos(a) * r, v + Math.sin(a) * r, 0.24 + 0.05 * ((i * 7) % 3), 0.2, rngFor(180 + i), 0.25, a, 30), rngFor(195 + i), 0.18, 3, 0.04));
}
// the walled country: the biggest island of the second half, craggy, ringed by a wall of peaks with one gap in the
// south-east where a river reaches the sea
const WALLED: G[] = [
  [-11, -3], [-9, -8], [-4, -9], [-1, -6], [2, -10], [7, -9], [10, -5], [11, 1], [8, 4], [10, 8], [5, 9], [1, 7], [-3, 10],
  [-8, 8], [-10, 4], [-7, 1],
];
const B_WALLED = shape(298, 560, 0.12, WALLED, 177);
const WALLED_RIM = local(298, 560, 0.12 * 0.78, [...WALLED.slice(9), ...WALLED.slice(0, 8)]);
// the giants' island: a tall forest island just west of the crossing
const B_GIANTS = shape(331, 607, 0.075, [[-6, -9], [2, -10], [7, -6], [8, 1], [6, 8], [0, 10], [-6, 8], [-8, 0]], 178);

const BELT: Pt[][] = [
  B_ROCK, B_PILLARS, B_JUNGLE, B_WINTER, B_EMPTY, B_DESERT, B_BITTEN, ...B_SKY, ...B_LONG, B_WATER, B_RING, B_TRIANGLE,
  ...B_MANGROVE, B_FORT, B_FIRE, B_ICE, B_KIDNEY, B_KIDNEY_ISLET, B_BEAST, B_SWEETS, ...B_SWEETS_RING, B_WALLED, B_GIANTS,
];

// ======================= relief, biomes and oil =======================
const regions: ExtraRegion[] = [];
const oilZones: number[][][] = [];
const rngR = rngFor(201);
let k = 0;
/** a hand-placed region: a wobbly ellipse at a sketch point, radii in plane units */
const R = (kind: ExtraKind, x: number, y: number, rx: number, ry: number, rot = 0, strength?: number): void => {
  const [u, v] = F(x, y);
  regions.push({ name: `${kind} ${k++}`, kind, poly: ring(blob(u, v, rx, ry, rngR, 0.25, rot, 40)), ...(strength ? { strength } : {}) });
};
/** an oil province (on top of the desert, swamp and tundra rule) */
const OIL = (x: number, y: number, rx: number, ry: number): void => {
  const [u, v] = F(x, y);
  oilZones.push(ring(blob(u, v, rx, ry, rngR, 0.2, 0, 32)));
};

// the wall's spine: high peaks top to bottom (painted as mountains below), foothills (iron) on both sides
const SPINE_N: G[] = [[472, -40], [470, 30], [462, 90], [452, 150], [446, 205], [438, 260], [430, 320], [421, 385], [414, 445], [418, 505], [427, 550]];
const SPINE_N_HALF = [5.6, 5.4, 4.8, 4.2, 3.8, 3.4, 3.0, 2.5, 1.9, 1.3, 0.8];
const SPINE_S: G[] = [[434, 586], [438, 630], [441, 690], [438, 750], [444, 810], [441, 870], [428, 940], [410, 1040]];
const SPINE_S_HALF = [1.0, 1.4, 2.0, 2.4, 2.6, 2.8, 3.0, 3.2];
const PEAKS_N = ridge(SPINE_N, SPINE_N_HALF, 401, 0.6);
const PEAKS_S = ridge(SPINE_S, SPINE_S_HALF, 402, 0.4);
// spurs of the spine reaching out into the big lobes, so their hearts are high rock too and only the coasts are low
const SPUR_NW: G[] = [[440, 250], [390, 245], [335, 262], [290, 290]];
const SPUR_SW: G[] = [[438, 765], [392, 762], [350, 772]];
const SPUR_NE: G[] = [[452, 120], [505, 95], [555, 60]];
const PEAKS_SPURS = [ridge(SPUR_NW, [1.6, 1.3, 0.9, 0.5], 407, 0.3), ridge(SPUR_SW, [1.4, 1.0, 0.5], 408, 0.25), ridge(SPUR_NE, [1.5, 1.2, 0.7], 409, 0.25)];
regions.push({ name: 'Wall foothills north', kind: 'hills', poly: ring(ridge(SPINE_N, SPINE_N_HALF.map((h) => h + 1.5), 403, 0.6, 0.5)) });
regions.push({ name: 'Wall foothills south', kind: 'hills', poly: ring(ridge(SPINE_S, SPINE_S_HALF.map((h) => h + 1.3), 404, 0.4, 0.5)) });
// the far side of the wall along both map edges: peaks on the outer side, a livable coast on the inner side
const PEAKS_W = ridge([[-5, -40], [-5, 300], [-5, 640], [-5, 1040]], [1.4, 1.3, 1.5, 1.4], 405, 0.25, 0.4);
const PEAKS_E = ridge([[1004, -40], [1004, 300], [1004, 640], [1004, 1040]], [1.9, 1.8, 1.9, 1.8], 406, 0.3, 0.4);

// the north lobes: forest on the big western lobe, hills on its hooked cape, a dry plain on the east coast
R('woods', 255, 240, 3.2, 1.6, 0.1);
R('hills', 190, 245, 1.0, 0.8);
R('mountains', 226, 290, 1.0, 1.0, 0, 0.75);
R('open', 330, 230, 2.5, 1.6);
R('hills', 300, 420, 1.2, 0.9);
R('swamp', 320, 445, 1.0, 0.5);
OIL(320, 445, 1.0, 0.6);
R('desert', 515, 230, 1.0, 2.2);
OIL(515, 230, 0.9, 1.8);
R('tundra', 420, 40, 3.0, 1.4);
R('tundra', 520, 40, 3.0, 1.4);
R('woods', 510, 300, 1.0, 1.5);
R('hills', 500, 430, 0.9, 1.0);
R('desert', 515, 450, 0.7, 0.6);
OIL(512, 445, 0.8, 0.7);
R('steppe', 380, 380, 2.0, 1.4);
// the neck pieces around the crossing: high rocky ground
R('hills', 372, 560, 0.9, 1.6, 0.4);
R('hills', 466, 530, 0.6, 1.2);
R('hills', 470, 635, 0.6, 1.0);
// the south lobes: a dry western lobe, a marshy boot, a forested east coast
R('desert', 300, 735, 2.4, 1.6, 0.2);
OIL(300, 735, 2.0, 1.4);
R('hills', 360, 705, 1.2, 0.8);
R('mountains', 268, 770, 0.8, 0.6, 0, 0.75);
R('swamp', 330, 900, 1.3, 0.6, 0.3);
OIL(330, 900, 1.2, 0.6);
R('hills', 370, 870, 0.8, 0.8);
R('woods', 475, 820, 0.6, 2.0);
R('steppe', 400, 980, 1.5, 0.8);
// the edges: hills along the far wall, a desert and a swamp so each coast has oil
R('hills', 25, 120, 1.0, 3.0);
R('hills', 20, 420, 0.8, 3.0);
R('hills', 45, 700, 1.4, 2.4);
R('desert', 55, 770, 1.0, 1.0);
OIL(55, 770, 1.0, 1.0);
R('swamp', 40, 330, 1.0, 0.4);
R('hills', 968, 150, 1.4, 3.5);
R('desert', 956, 330, 0.9, 1.4);
OIL(956, 330, 0.9, 1.4);
R('hills', 975, 560, 1.4, 3.5);
R('hills', 978, 820, 1.4, 2.5);
R('swamp', 968, 880, 0.8, 0.9);
OIL(968, 880, 0.8, 0.9);
R('woods', 968, 720, 0.9, 1.5);
// north-west sea
R('hills', 185, 385, 1.0, 0.8, 0.5);
R('desert', 140, 360, 1.0, 0.6, 0.5);
OIL(140, 360, 1.0, 0.6);
// north-east sea: a cold north, a hilly big island, a forested round island
R('tundra', 690, 30, 2.2, 1.4);
OIL(690, 30, 2.0, 1.2);
R('hills', 725, 95, 1.2, 0.9);
R('mountains', 700, 60, 0.9, 0.9, 0, 0.8);
R('woods', 768, 155, 0.9, 1.0);
R('hills', 770, 140, 0.8, 0.7);
R('swamp', 764, 174, 0.6, 0.4);
OIL(764, 174, 0.7, 0.5);
R('hills', 822, 105, 0.6, 1.5, -0.8);
R('tundra', 886, 22, 1.6, 1.2);
// south-west sea: islets
R('hills', 240, 868, 0.7, 0.4);
// south-east sea: the big island has hills in the middle, forest in the north, a dry south and a marshy bay
R('hills', 580, 860, 2.0, 1.6, 0.3);
R('mountains', 585, 865, 1.0, 0.9, 0, 0.8);
R('woods', 590, 760, 1.2, 1.5);
R('desert', 545, 945, 1.8, 0.8, 0.2);
OIL(545, 945, 1.6, 0.7);
R('swamp', 655, 870, 0.9, 0.6);
OIL(655, 870, 0.9, 0.6);
R('hills', 922, 690, 0.8, 0.6);
R('desert', 823, 970, 1.0, 0.6);
OIL(823, 970, 0.9, 0.5);
// the belt, first half: rock pillars, a jungle, a frozen plateau, the desert kingdom with its river, a wooded bitten
// island, a marshy triangle and the mangroves
R('hills', 536, 560, 0.4, 0.7);
R('woods', 565, 593, 1.0, 1.0);
R('hills', 570, 585, 0.5, 0.4);
R('tundra', 606, 546, 0.95, 0.95);
R('mountains', 607, 543, 0.35, 0.35, 0, 0.85);
R('desert', 672, 571, 2.9, 2.1);
OIL(672, 571, 2.7, 1.9);
R('hills', 692, 552, 0.8, 0.6);
R('mountains', 650, 560, 0.5, 0.5, 0, 0.7);
R('woods', 722, 556, 0.6, 0.9);
R('hills', 794, 549, 0.35, 0.35);
R('swamp', 861, 600, 0.6, 0.4);
R('swamp', 898, 568, 1.2, 1.5);
R('woods', 899, 560, 0.8, 1.0);
// the belt, second half: scorched and frozen halves, a hilly kidney island, the forested beast, the sweets island with
// a marsh, the walled country's inner valleys and the giants' forest
R('desert', 57, 576, 0.5, 0.95);
OIL(57, 576, 0.5, 0.9);
R('tundra', 68, 576, 0.5, 0.95);
R('hills', 118, 545, 0.8, 0.6);
R('woods', 105, 560, 0.6, 0.5);
R('woods', 170, 572, 0.8, 0.5);
R('hills', 234, 560, 0.9, 0.6);
R('swamp', 236, 585, 0.6, 0.4);
OIL(236, 585, 0.7, 0.5);
R('woods', 296, 556, 0.7, 0.6);
R('hills', 300, 566, 0.6, 0.5);
R('woods', 331, 607, 0.6, 0.7);

// a river through the desert kingdom, from the hills in the north-east down to the bay on the south coast
const RIVER = local(672, 571, 0.17, [[8, -6], [5, -3], [2, 0], [0, 3], [-2, 7]]);
// a river out of the walled country through the gap in its peaks
const RIVER_W = local(298, 560, 0.12, [[-2, -3], [2, 0], [6, 3], [9, 4.5]]);

// ======================= the map =======================
const land: Pt[][] = [NORTH, NECK, SOUTH, BOOT, WEST_EDGE_N, WEST_EDGE_S, EAST_EDGE, NW_FISH, ...NW_SMALL, NE_BIG, NE_ROUND, NE_LONG, NE_LONG_TOP, NE_TOP, ...NE_SMALL, ...SW_SMALL, SE_BIG, ...SE_SMALL, ...BELT];

export const FOURSEAS: DrawnMap = {
  land: land.map(ring),
  lakes: [...channels, ...basin].map(ring),
  rivers: [ring(RIVER), ring(RIVER_W)],
  regions,
  oilZones,
  paint: [
    // the spine of the wall: impassable peaks top to bottom, and the lone peak of the crossing
    { terrain: 'mountains', poly: ring(PEAKS_N) },
    { terrain: 'mountains', poly: ring(PEAKS_S) },
    ...PEAKS_SPURS.map((p) => ({ terrain: 'mountains' as const, poly: ring(p) })),
    { terrain: 'mountains', poly: ring(blob(CROSS[0], CROSS[1], BASIN_IN + 0.1, BASIN_IN + 0.1, rngR, 0.05, 0, 24)) },
    { terrain: 'mountains', poly: ring(PEAKS_W) },
    { terrain: 'mountains', poly: ring(PEAKS_E) },
    // the ring of peaks around the walled country of the belt
    { terrain: 'mountains', poly: ring(strip(WALLED_RIM, 0.17)) },
    // rocky hills over the desert kingdom's north-east cape, where its river rises
    { terrain: 'hills', poly: ring(blob(...F(694, 550), 0.8, 0.6, rngFor(410), 0.2, 0.3, 32)) },
  ],
};

const sp = (name: string, x: number, y: number, major = false): SpawnDef => ({ name, at: FOURSEAS_PLANE.P(...F(x, y)), major, pop: major ? 2_000_000 : 1_000_000 });

export const FOURSEAS_SPAWNS: SpawnDef[] = [
  // north-west sea
  sp('Aldmere', 248, 250, true),
  sp('Brisk', 168, 372),
  // north-east sea
  sp('Caldrin', 712, 55, true),
  sp('Dunmark', 498, 420),
  sp('Kelmarsh', 768, 160),
  // south-west sea
  sp('Eskeld', 312, 735, true),
  sp('Fenhollow', 45, 690),
  // south-east sea
  sp('Garrowe', 585, 820, true),
  sp('Harrowick', 975, 780),
  // the belt
  sp('Isenvar', 234, 568),
  sp('Jorlund', 674, 568),
];
