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
import { blob, fractal, makePlane, rngFor, smoothClosed, wobbler } from './kit';
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

// north-east: a big island down from the top edge with a hooked spur, many island clusters near the top, a long
// diagonal island, a lone round island in the open sea and an island hard by the east wall
const NE_BIG = coast(
  [
    [652, -30], [708, -30], [713, 10], [737, 36], [762, 55], [770, 79], [757, 93], [737, 86], [726, 106], [722, 130],
    [709, 143], [696, 141], [689, 124], [680, 110], [669, 80], [662, 49], [656, 20],
  ],
  41,
);
const NE_ROUND = coast(
  [[752, 134], [765, 124], [781, 128], [790, 146], [789, 171], [780, 191], [765, 198], [751, 188], [747, 165]],
  42,
);
const NE_LONG = coast(
  [[798, 151], [806, 139], [815, 117], [825, 94], [834, 70], [842, 47], [849, 52], [846, 76], [836, 101], [823, 126], [812, 146], [803, 157]],
  43,
);
const NE_TOP = coast(
  [[826, -30], [870, -30], [867, 10], [881, 30], [884, 55], [872, 69], [858, 60], [850, 40], [838, 31], [829, 12]],
  44,
);
const NE_SMALL = [
  coast([[650, 126], [665, 117], [679, 124], [683, 141], [678, 159], [667, 167], [654, 162], [648, 145]], 45),
  isle(691, 162, 0.85, 0.7, 0.3, 46),
  isle(705, 180, 0.6, 0.5, 0.9, 47),
  isle(737, 225, 0.7, 0.55, 0.2, 48),
  isle(797, 165, 0.45, 0.6, 0.1, 49),
  isle(624, 14, 1.0, 0.7, 0.4, 50),
  isle(545, 118, 0.7, 0.35, 0.2, 51),
  isle(570, 121, 0.6, 0.32, 0.1, 52),
  isle(871, 111, 1.1, 0.5, 0.15, 53),
  isle(902, 68, 0.9, 0.55, 0.5, 54),
  coast([[916, 100], [928, 104], [934, 125], [931, 150], [924, 166], [913, 160], [910, 133]], 55),
  coast([[772, 98], [784, 92], [792, 104], [786, 118], [774, 116]], 58),
  isle(792, 30, 0.8, 0.45, 0.7, 59),
  isle(812, 68, 0.5, 0.35, 1.2, 60),
  isle(846, 128, 0.55, 0.35, 0.4, 65),
  isle(887, 92, 0.4, 0.3, 0.2, 66),
  isle(640, 82, 0.6, 0.4, 0.9, 67),
  isle(728, 160, 0.45, 0.35, 0.3, 68),
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
// Islands of every shape between the calm strips (sketch y 519..624), from the west wall to the east wall.
const BELT_W_BIG = coast(
  [[200, 538], [214, 527], [232, 526], [246, 538], [250, 558], [246, 579], [235, 595], [218, 599], [203, 590], [195, 572], [192, 552]],
  81,
);
const BELT_E_BIG = coast(
  [
    [634, 548], [645, 532], [662, 526], [680, 530], [697, 540], [703, 558], [699, 576], [688, 594], [670, 604], [652, 602],
    [640, 590], [646, 574], [632, 566],
  ],
  82,
);
const BELT: Pt[][] = [
  // west of the wall
  isle(46, 547, 0.65, 0.95, 0.2, 101),
  isle(62, 590, 1.0, 0.45, 0.5, 102),
  crescent(100, 552, 1.25, -2.4, 103),
  isle(124, 603, 0.6, 0.4, 0.3, 104),
  isle(156, 560, 1.9, 0.7, 0.45, 105), // the long island
  crescent(180, 600, 0.95, 1.2, 106),
  BELT_W_BIG,
  isle(186, 532, 0.38, 0.3, 0.2, 107), // islets around the big round island
  isle(262, 540, 0.45, 0.3, 0.6, 108),
  isle(258, 586, 0.4, 0.32, 0.1, 109),
  isle(226, 612, 0.5, 0.28, 0.0, 110),
  coast([[279, 540], [292, 530], [306, 535], [312, 552], [305, 569], [291, 574], [279, 563]], 111), // the high island
  isle(314, 603, 0.6, 0.4, 0.9, 112),
  isle(282, 608, 0.4, 0.3, 0.3, 113),
  isle(86, 612, 0.4, 0.28, 0.2, 114),
  // east of the wall
  isle(512, 578, 1.0, 0.38, -0.2, 121),
  coast([[538, 552], [552, 546], [562, 556], [560, 575], [548, 582], [538, 572]], 122), // the jungle island
  coast([[598, 537], [611, 531], [622, 541], [620, 557], [608, 563], [597, 553]], 123), // the cold peak island
  isle(612, 600, 0.5, 0.38, 0.4, 124),
  isle(578, 607, 0.42, 0.3, 0.1, 125),
  BELT_E_BIG,
  crescent(726, 556, 1.2, 0.1, 126), // the half island
  isle(738, 598, 0.95, 0.22, 0.25, 127), // the long thin chain
  isle(758, 603, 0.85, 0.2, 0.15, 128),
  isle(776, 606, 0.8, 0.22, -0.1, 129),
  coast([[765, 548], [776, 540], [788, 546], [790, 560], [781, 569], [768, 566]], 130), // the water city island
  coast([[804, 552], [822, 548], [812, 572]], 131, 0.12, 8), // the triangle island
  isle(800, 600, 0.45, 0.35, 0.3, 132),
  isle(842, 592, 0.75, 0.9, 0.2, 133),
  isle(866, 546, 0.32, 0.28, 0.0, 134), // the mangrove cluster
  isle(876, 552, 0.28, 0.25, 0.5, 135),
  isle(870, 560, 0.3, 0.24, 0.9, 136),
  isle(882, 543, 0.26, 0.22, 0.3, 137),
  isle(861, 556, 0.24, 0.2, 0.7, 138),
  crescent(905, 578, 0.8, 3.0, 139), // the fortress bay
  isle(710, 610, 0.42, 0.3, 0.2, 140),
  isle(640, 530, 0.3, 0.25, 0.1, 141),
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
const SPINE_N_HALF = [4.6, 4.4, 3.6, 3.0, 2.6, 2.3, 2.0, 1.6, 1.2, 0.9, 0.7];
const SPINE_S: G[] = [[434, 586], [438, 630], [441, 690], [438, 750], [444, 810], [441, 870], [428, 940], [410, 1040]];
const SPINE_S_HALF = [0.7, 0.9, 1.3, 1.5, 1.5, 1.6, 1.9, 2.2];
const PEAKS_N = ridge(SPINE_N, SPINE_N_HALF, 401, 0.6);
const PEAKS_S = ridge(SPINE_S, SPINE_S_HALF, 402, 0.4);
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
R('woods', 768, 175, 0.9, 1.0);
R('hills', 770, 140, 0.8, 0.7);
R('swamp', 760, 185, 0.6, 0.4);
OIL(760, 185, 0.7, 0.5);
R('hills', 822, 105, 0.6, 1.5, -0.8);
R('tundra', 855, 30, 1.4, 1.0);
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
// the belt: a forested round island with hills, a high mountain island, a big desert island with a river, a cold
// peak island, hills on the jungle island and the long island, dry crescents
R('hills', 228, 548, 0.9, 0.7);
R('swamp', 210, 580, 0.6, 0.5);
OIL(210, 580, 0.7, 0.5);
R('woods', 236, 580, 0.7, 0.5);
R('mountains', 296, 550, 0.6, 0.6, 0, 0.85);
R('hills', 156, 560, 1.4, 0.5, 0.45);
R('desert', 100, 552, 1.0, 1.0);
OIL(100, 552, 1.0, 1.0);
R('desert', 668, 565, 2.4, 1.8);
OIL(668, 565, 2.2, 1.6);
R('hills', 690, 545, 0.8, 0.6);
R('mountains', 645, 545, 0.5, 0.5, 0, 0.7);
R('tundra', 610, 547, 0.6, 0.6);
R('mountains', 610, 545, 0.35, 0.35, 0, 0.8);
R('woods', 550, 565, 0.6, 0.7);
R('desert', 726, 556, 1.2, 1.2);
OIL(726, 556, 1.0, 1.0);
R('hills', 776, 555, 0.5, 0.5);
R('hills', 842, 592, 0.6, 0.6);
R('swamp', 872, 552, 0.8, 0.6);

// a river through the big desert island of the belt (green banks across the sand)
const RIVER = line([[688, 532], [676, 548], [668, 562], [664, 580], [656, 600]]);

// ======================= the map =======================
const land: Pt[][] = [NORTH, NECK, SOUTH, BOOT, WEST_EDGE_N, WEST_EDGE_S, EAST_EDGE, NW_FISH, ...NW_SMALL, NE_BIG, NE_ROUND, NE_LONG, NE_TOP, ...NE_SMALL, ...SW_SMALL, SE_BIG, ...SE_SMALL, ...BELT];

export const FOURSEAS: DrawnMap = {
  land: land.map(ring),
  lakes: [...channels, ...basin].map(ring),
  rivers: [ring(RIVER)],
  regions,
  oilZones,
  paint: [
    // the spine of the wall: impassable peaks top to bottom, and the lone peak of the crossing
    { terrain: 'mountains', poly: ring(PEAKS_N) },
    { terrain: 'mountains', poly: ring(PEAKS_S) },
    { terrain: 'mountains', poly: ring(blob(CROSS[0], CROSS[1], BASIN_IN + 0.1, BASIN_IN + 0.1, rngR, 0.05, 0, 24)) },
    { terrain: 'mountains', poly: ring(PEAKS_W) },
    { terrain: 'mountains', poly: ring(PEAKS_E) },
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
  sp('Isenvar', 222, 562),
  sp('Jorlund', 668, 566),
];
