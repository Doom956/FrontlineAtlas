// "The Fivefold Lands": a hand-drawn fictional map. One continent holds five great countries: a big forested heartland
// in the centre-south, a desert in the southwest, a rocky highland in the northwest, a stormy mountain peninsula in the
// northeast reaching up past a deep northern bay, and a misty island realm (an archipelago) off the east coast. Small
// buffer states sit between them: a rainy one, a stony one, a waterfall valley, a river valley, a grassland, a bell
// valley on the northern peninsula and a frosty one at the neck of the stormy peninsula.
//
// Drawn for this project by hand, point by point. Points are written in a 1500 x 882 drawing box (x east, y SOUTH),
// then turned into plane units by `R`; the continent runs off three sides of that box, so its far coasts (west, south
// and the north end of the stormy peninsula) are closed just outside it.
import type { DrawnMap, Pt } from './kit';
import { blob, fractal, makePlane, path, rngFor, smoothClosed, strip } from './kit';
import type { ExtraRegion } from '../extra';
import type { SpawnDef } from '../defs';

/** plane units per drawing-box pixel */
const S = 0.045;
/** sea margin round the drawing box, pixels */
const M = 45;
export const FIVEFOLD_PLANE = makePlane((1500 + 2 * M) * S, (882 + 2 * M) * S, 36);
const pl = FIVEFOLD_PLANE;

/** drawing-box point (x east, y south, pixels) -> plane point */
const R = (x: number, y: number): Pt => [(x - 750) * S, (441 - y) * S];
const Rs = (pts: number[][]): Pt[] => pts.map(([x, y]) => R(x, y));

const SEED = 505;

/** The continent, clockwise from the northwest corner (outside the box). */
const MAIN: number[][] = [
  // the far north coast of the rocky country (outside the box)
  [-25, -24], [60, -32], [150, -18], [250, -30], [340, -20], [402, -28], [424, -10],
  // the west shore of the great northern bay
  [420, 0], [432, 28], [442, 50], [434, 72], [430, 92], [440, 108], [440, 130], [424, 150], [422, 168], [430, 192], [450, 218],
  [460, 230], [481, 211], [494, 209], [503, 216], [528, 212], [537, 219], [531, 237], [516, 247], [516, 266],
  // the bay's south shore, then round the blunt northern peninsula
  [569, 269], [591, 272], [616, 269], [625, 250], [644, 239], [637, 212], [641, 203], [656, 194], [669, 181], [691, 172],
  [700, 153], [725, 150], [741, 156], [750, 169], [759, 178], [766, 194], [762, 209], [766, 234], [759, 247], [744, 256],
  [725, 272], [709, 278], [703, 294], [691, 312], [694, 334],
  // the inlet east of the peninsula and the frosty neck
  [725, 337], [762, 336], [775, 312], [800, 306], [837, 306], [862, 309],
  // the stormy peninsula: west coast north to the box edge
  [883, 288], [900, 283], [925, 271], [937, 250], [958, 233], [967, 229], [979, 217], [987, 200], [983, 179], [987, 158],
  [1004, 146], [1017, 129], [1021, 108], [1025, 79], [1037, 58], [1048, 54], [1050, 25], [1053, 0],
  // its north end (outside the box)
  [1060, -22], [1120, -30], [1200, -24], [1290, -28], [1314, -10],
  // east coast south, then the ragged south coast back west
  [1308, 0], [1292, 42], [1275, 67], [1267, 96], [1252, 108], [1252, 154], [1262, 179], [1275, 204], [1271, 242], [1258, 267],
  [1246, 300], [1233, 325], [1217, 333], [1200, 338], [1183, 333], [1179, 317], [1150, 329], [1133, 342], [1117, 340],
  [1083, 346], [1062, 358], [1050, 379], [1025, 388], [1000, 375], [975, 367], [933, 367], [900, 375], [880, 385],
  // the heartland's east coast: the hot-spring cape, the bulge and the long straight shore
  [862, 382], [850, 386], [840, 396], [834, 412], [838, 437], [850, 456], [862, 469], [881, 481], [906, 497], [925, 484],
  [941, 481], [956, 491], [962, 509], [959, 522], [950, 528], [947, 541], [937, 556], [925, 569], [912, 566], [903, 559],
  [903, 575], [906, 587], [912, 612], [906, 625], [900, 637], [894, 656], [887, 675], [881, 700], [878, 712], [891, 725],
  // the long southeast arm reaching for the islands, and its south shore
  [912, 728], [925, 719], [950, 709], [975, 706], [1000, 700], [1019, 694], [1041, 691], [1062, 697], [1072, 703], [1074, 716],
  [1072, 725], [1050, 731], [1025, 734], [1000, 744], [975, 756], [956, 769], [941, 781], [928, 794], [925, 812], [916, 825],
  [900, 837], [894, 856], [891, 882],
  // round the south end (outside the box) into the southern bay
  [895, 904], [840, 914], [785, 904],
  [781, 882], [787, 850], [800, 825], [819, 816], [837, 806], [850, 794], [856, 775], [850, 762], [837, 753], [825, 744],
  [806, 744], [775, 753], [747, 762], [725, 759], [700, 756], [669, 753], [656, 762], [650, 781], [637, 806], [619, 819],
  [600, 825], [575, 828], [540, 830], [510, 836], [490, 846], [480, 862], [476, 882],
  // the far south and west coasts of the desert and the rocky country (outside the box)
  [470, 906], [380, 914], [280, 902], [180, 912], [80, 904], [-22, 908],
  [-30, 800], [-18, 700], [-36, 600], [-24, 500], [-32, 400], [-20, 300], [-34, 200], [-24, 100],
];

/** Other traced coasts: the eastern lands that run off the box, the long island and the big southern isle. */
const NE_LAND: number[][] = [
  [1500, 242], [1471, 271], [1433, 275], [1417, 292], [1400, 300], [1383, 313], [1371, 329], [1367, 358], [1371, 371], [1362, 388],
  [1379, 408], [1392, 392], [1404, 388], [1408, 412], [1425, 421], [1446, 425], [1458, 408], [1500, 408], [1526, 398], [1532, 320], [1524, 250],
];
const E_LAND: number[][] = [
  [1500, 537], [1489, 544], [1475, 566], [1464, 594], [1457, 619], [1450, 644], [1429, 659], [1407, 673], [1389, 691], [1382, 705],
  [1389, 719], [1400, 730], [1404, 716], [1411, 698], [1429, 687], [1457, 680], [1475, 666], [1500, 651], [1526, 640], [1530, 560],
];
const LONG_ISLE: number[][] = [
  [1054, 451], [1061, 437], [1079, 423], [1089, 409], [1107, 405], [1129, 405], [1146, 401], [1157, 412], [1146, 426], [1132, 441],
  [1118, 451], [1104, 466], [1093, 484], [1071, 491], [1054, 487], [1050, 469],
];
const LONG_ISLE_S: number[][] = [[1003, 560], [1000, 548], [1008, 535], [1015, 527], [1025, 525], [1028, 535], [1024, 548], [1015, 560], [1008, 569]];
const S_ISLE: number[][] = [
  [1096, 776], [1118, 766], [1136, 784], [1154, 791], [1168, 794], [1171, 819], [1179, 844], [1175, 880], [1172, 906], [1100, 908],
  [1100, 880], [1100, 837], [1096, 809],
];
/** the misty realm: its main island and the bigger isles round it */
const MIST_MAIN: number[][] = [
  [1221, 587], [1229, 580], [1257, 584], [1286, 580], [1296, 587], [1307, 609], [1318, 623], [1332, 637], [1336, 655], [1325, 669],
  [1318, 694], [1300, 712], [1275, 716], [1254, 709], [1239, 698], [1221, 687], [1211, 673], [1209, 644], [1207, 630], [1218, 609],
];
const MIST_W: number[][] = [[1164, 555], [1186, 555], [1204, 573], [1207, 591], [1200, 612], [1175, 616], [1168, 594], [1159, 580]];
const MIST_N: number[][] = [[1250, 537], [1268, 531], [1286, 541], [1296, 551], [1289, 562], [1271, 567], [1254, 566], [1246, 551]];
const MIST_NE: number[][] = [
  [1314, 509], [1332, 503], [1350, 512], [1357, 530], [1357, 555], [1366, 566], [1354, 594], [1343, 598], [1332, 584], [1325, 566],
  [1318, 544], [1311, 523],
];
const MIST_E: number[][] = [[1354, 634], [1368, 626], [1375, 637], [1375, 666], [1368, 680], [1350, 676], [1346, 659], [1349, 641]];

const traced = (pts: number[][], seed: number, per = 4, rough = 0.16): Pt[] => fractal(smoothClosed(Rs(pts), per), rngFor(seed), rough, 4, 0.03);
const rI = rngFor(SEED + 40);
/** a small round isle: centre and radii in pixels */
const isle = (x: number, y: number, rx: number, ry: number, rot = 0): Pt[] => fractal(blob(...R(x, y), rx * S, ry * S, rI, 0.22, rot), rI, 0.18, 3, 0.03);

const continent = traced(MAIN, SEED + 1, 4, 0.18);
const isles: Pt[][] = [
  traced(NE_LAND, SEED + 2),
  traced(E_LAND, SEED + 3),
  traced(LONG_ISLE, SEED + 4),
  traced(LONG_ISLE_S, SEED + 5),
  traced(S_ISLE, SEED + 6),
  traced(MIST_MAIN, SEED + 7),
  traced(MIST_W, SEED + 8),
  traced(MIST_N, SEED + 9),
  traced(MIST_NE, SEED + 10),
  traced(MIST_E, SEED + 11),
  // the scattered small isles of the misty realm
  isle(1150, 678, 21, 22), isle(1114, 713, 14, 14), isle(1150, 736, 23, 22), isle(1221, 722, 21, 14), isle(1270, 745, 9, 10),
  isle(1269, 786, 7, 9), isle(1325, 737, 20, 23), isle(1381, 790, 30, 32),
  // the whirlpool isle off the heartland's coast, and a small isle in the southern bay
  isle(946, 633, 16, 15, 0.6), isle(705, 800, 26, 15, 0.2),
];

// ---------- rivers ----------
const rr = rngFor(SEED + 20);
const river = (pts: number[][], bend = 18): Pt[] => {
  const out: Pt[] = [];
  for (let i = 0; i + 1 < pts.length; i++) out.push(...path(R(pts[i][0], pts[i][1]), R(pts[i + 1][0], pts[i + 1][1]), rr, bend * S, 24).slice(i ? 1 : 0));
  return out;
};
const rivers: Pt[][] = [
  // from the waterfall gorge on the northern border down through the forest to the southern bay
  river([[688, 418], [690, 470], [705, 560], [700, 660], [712, 758]], 22),
  // east through the forest to the bulging coast
  river([[760, 540], [840, 560], [905, 566]], 16),
  // the river valley in the south-west of the heartland
  river([[470, 600], [500, 700], [510, 780], [505, 840]], 20),
  // the waterfall country's stream west to the stony plain
  river([[440, 470], [380, 500], [330, 540]], 12),
  // the rocky country: one river north to the far coast
  river([[300, 210], [280, 100], [250, -24]], 26),
  // the stormy peninsula: a short river to its south coast
  river([[1130, 260], [1135, 310], [1120, 338]], 10),
];

// ---------- relief and land cover ----------
const rg = rngFor(SEED + 30);
/** a blob: centre and radii in pixels, rotation in radians */
const b = (x: number, y: number, rx: number, ry: number, wob = 0.2, rot = 0): Pt[] => blob(...R(x, y), rx * S, ry * S, rg, wob, rot);
/** a ridge along pixel points, half width in pixels */
const range = (pts: number[][], half: number): Pt[] => strip(river(pts, 10), half * S);
const reg = (name: string, kind: ExtraRegion['kind'], poly: Pt[], strength?: number): ExtraRegion => ({ name, kind, poly: pl.ring(poly), ...(strength ? { strength } : {}) });

const regions: ExtraRegion[] = [
  // the rocky country: broken hills everywhere, three grey ridges, a bare plateau in the north
  reg('Rock hills', 'hills', b(210, 200, 200, 160, 0.15)),
  reg('Rock hills south', 'hills', b(160, 360, 140, 60, 0.2)),
  reg('North ridge', 'mountains', range([[20, 120], [100, 70], [190, 100], [270, 45], [360, 70], [405, 30]], 30), 0.95),
  reg('Middle ridge', 'mountains', range([[40, 300], [120, 245], [200, 285], [280, 225], [330, 160]], 28), 0.95),
  reg('West ridge', 'mountains', range([[30, 200], [90, 170], [150, 190]], 22), 0.9),
  reg('Crag knot', 'mountains', b(210, 175, 55, 42, 0.25), 0.92),
  reg('Bay ridge', 'mountains', range([[360, 150], [395, 205], [470, 250]], 14), 0.8),
  reg('Rock plateau', 'highland', b(120, 30, 110, 40, 0.2)),
  reg('North coast heath', 'steppe', b(230, 5, 240, 45, 0.2)),
  reg('Rock moor', 'steppe', b(360, 330, 60, 40, 0.2)),
  // the desert: sand from the border hills to the far coasts, red canyon hills round the hidden town
  reg('Great sands', 'desert', b(200, 700, 240, 185, 0.14)),
  reg('West sands', 'desert', b(70, 520, 90, 55, 0.2)),
  reg('Canyon north', 'hills', b(300, 700, 60, 22, 0.25)),
  reg('Canyon south', 'hills', b(305, 800, 60, 22, 0.25)),
  reg('Dune crags', 'hills', b(110, 810, 50, 30, 0.25)),
  reg('Border downs', 'hills', range([[0, 455], [100, 440], [200, 470]], 18)),
  // the buffer states between the rocky country, the desert and the heartland
  reg('Stony plain', 'hills', b(290, 515, 55, 32, 0.2)),
  reg('Falls wood', 'woods', b(440, 470, 38, 35, 0.2)),
  reg('Rain fen', 'swamp', b(420, 568, 55, 24, 0.2)),
  reg('River valley hills', 'hills', b(555, 705, 35, 55, 0.2)),
  reg('River valley wood', 'woods', b(470, 760, 30, 50, 0.2)),
  reg('Grass country', 'steppe', b(535, 345, 50, 55, 0.2)),
  reg('Grave crags', 'mountains', b(712, 205, 38, 30, 0.2), 0.7),
  reg('Bell hills', 'hills', b(670, 365, 40, 30, 0.2)),
  reg('Frost moor', 'cold', b(822, 334, 24, 15, 0.2)),
  reg('Spring marsh', 'swamp', b(835, 455, 26, 18, 0.2)),
  reg('Falls gorge west', 'mountains', range([[668, 418], [672, 470]], 7), 0.7),
  reg('Falls gorge east', 'mountains', range([[710, 418], [706, 470]], 7), 0.7),
  // the heartland: one great wet forest, with some hills and coastal marshes
  reg('Heartland forest', 'wet', b(720, 580, 140, 95, 0.3, 0.3)),
  reg('Heartland forest east', 'wet', b(800, 660, 90, 110, 0.3)),
  reg('Heartland forest north', 'wet', b(610, 480, 105, 50, 0.3, -0.2)),
  reg('Heartland forest south', 'wet', b(640, 690, 85, 55, 0.3)),
  reg('Heartland forest west', 'wet', b(545, 570, 55, 60, 0.3)),
  reg('Heartland wood south', 'woods', b(820, 790, 60, 50, 0.2)),
  reg('Heartland wood neck', 'woods', b(780, 440, 50, 30, 0.2)),
  reg('Crown fields', 'open', b(605, 585, 30, 22, 0.2)),
  reg('Heart hills', 'hills', b(800, 520, 38, 28, 0.2)),
  reg('South hills', 'hills', b(755, 700, 40, 22, 0.2)),
  reg('Arm hills', 'hills', b(1005, 716, 50, 14, 0.2, 0.05)),
  reg('Coast marsh', 'swamp', b(865, 640, 22, 40, 0.2)),
  reg('Delta marsh', 'swamp', b(690, 745, 30, 14, 0.2)),
  // the stormy peninsula: a mountain spine, cloud hills, snow at the far north end
  reg('Storm spine', 'mountains', range([[1180, -20], [1170, 60], [1190, 130], [1160, 200], [1200, 260], [1180, 320]], 28), 0.95),
  reg('Storm spur', 'mountains', range([[1005, 175], [1050, 140], [1100, 90], [1120, 30]], 16), 0.85),
  reg('Storm east ridge', 'mountains', range([[1250, 120], [1235, 200], [1240, 270]], 14), 0.8),
  reg('Cloud hills', 'hills', b(1130, 190, 100, 140, 0.15)),
  reg('Storm snow', 'cold', b(1170, 20, 110, 35, 0.2)),
  reg('Storm fen', 'swamp', b(980, 350, 40, 14, 0.2)),
  // the misty realm: crags and fens on its islands
  reg('Mist crags', 'hills', b(1250, 625, 30, 28, 0.2)),
  reg('Mist fen', 'swamp', b(1290, 690, 22, 14, 0.2)),
  reg('Mist isle hills', 'hills', b(1338, 545, 18, 35, 0.2)),
  reg('Mist isle fen', 'swamp', b(1185, 588, 16, 20, 0.2)),
  reg('Long isle hills', 'hills', b(1105, 440, 40, 22, 0.2, -0.6)),
  reg('South isle hills', 'hills', b(1138, 830, 30, 40, 0.2)),
  reg('East land hills', 'hills', b(1450, 330, 50, 40, 0.2)),
  reg('East land fen', 'swamp', b(1440, 620, 25, 30, 0.2)),
];

const oil: Pt[][] = [
  b(150, 395, 45, 22), // under the rocky country's southern moor
  b(410, 565, 45, 20), // the rain fen
  b(830, 455, 22, 15), // the spring marsh
  b(860, 640, 18, 32), // the coast marsh
  b(980, 352, 35, 12), // the storm fen
  b(1170, 25, 90, 28), // the far north snow
  b(1290, 690, 20, 12), // the mist fen
  b(830, 340, 32, 20), // the frost moor
];

export const FIVEFOLD: DrawnMap = {
  land: [continent, ...isles].map((p) => pl.ring(p)),
  lakes: [],
  rivers: rivers.map((p) => pl.ring(p)),
  regions,
  oilZones: oil.map((p) => pl.ring(p)),
};

const sp = (name: string, x: number, y: number, major = false): SpawnDef => {
  const p = R(x, y);
  return { name, at: pl.P(p[0], p[1]), major, pop: major ? 2_000_000 : 1_000_000 };
};

export const FIVEFOLD_SPAWNS: SpawnDef[] = [
  sp('Verdane', 640, 570, true), // the forest heartland
  sp('Sandmoor', 300, 750, true), // the desert
  sp('Craghold', 395, 300, true), // the rocky highland
  sp('Stormreach', 1064, 262, true), // the stormy peninsula
  sp('Mistral Isles', 1268, 650, true), // the misty islands
  sp('Rainmark', 400, 540),
  sp('Stonebridge', 285, 512),
  sp('Riverholt', 520, 725),
  sp('Grassmere', 530, 350),
  sp('Chimevale', 690, 380),
  sp('Frostmere', 850, 372),
];
