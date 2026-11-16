// "The Sundering Wall": a hand-drawn fictional map. One very high mountain continent runs top to bottom through the
// whole map, broken only by a sea channel on the equator and two high passes. A belt of islands crosses the map west
// to east along the equator, flanked by calm, empty strips of sea. Together they cut the world into four seas, each
// with a large home island, medium islands and a scatter of small ones. Drawn for this project from our own shapes.
import type { DrawnMap } from './kit';
import { blob, fractal, makePlane, path, rngFor, strip } from './kit';
import type { Pt } from './kit';
import type { SpawnDef } from '../defs';
import type { ExtraRegion } from '../extra';

// shapes are drawn in a 104 x 66 design space and shrunk by S so the climate band stays mid-latitude
const S = 0.76;
export const FOURSEAS_PLANE = makePlane(104 * S, 66 * S, 38);
const pl = {
  ring: (pts: Pt[]) => FOURSEAS_PLANE.ring(pts.map(([u, v]): Pt => [u * S, v * S])),
  P: (u: number, v: number) => FOURSEAS_PLANE.P(u * S, v * S),
};

interface Isle {
  c: Pt;
  r: number;
  poly: Pt[];
  /** gets iron and oil regions */
  rich: boolean;
}
const isles: Isle[] = [];
const rngI = rngFor(301);
const rngR = rngFor(302);

/** adds an island unless it would touch an existing one (keeps `gap` units of open water) */
function addIsle(cx: number, cy: number, r: number, gap: number, rich: boolean, squash = 0.75): number {
  for (const o of isles) if (Math.hypot(o.c[0] - cx, o.c[1] - cy) < o.r + r + gap) return -1;
  const poly = fractal(blob(cx, cy, r, r * squash, rngI, 0.22, rngI() * 3), rngI, 0.2, 4, 0.06);
  isles.push({ c: [cx, cy], r, poly, rich });
  return isles.length - 1;
}
function scatter(box: [number, number, number, number], count: number, rmin: number, rmax: number, gap: number, rich = false): void {
  let placed = 0;
  for (let tries = 0; tries < 4000 && placed < count; tries++) {
    const r = rmin + (rmax - rmin) * rngI();
    const cx = box[0] + (box[1] - box[0]) * rngI();
    const cy = box[2] + (box[3] - box[2]) * rngI();
    if (addIsle(cx, cy, r, gap, rich) >= 0) placed++;
  }
}

// the home islands and medium islands of each sea (quadrant), then the belt giants
const SEA: [number, number][] = [[-1, 1], [1, 1], [-1, -1], [1, -1]];
const homeIdx: number[] = [];
const medIdx: number[] = [];
SEA.forEach(([sx, sy], i) => {
  const jx = i % 2 === 0 ? 1 : -1;
  homeIdx.push(addIsle(sx * 27 + jx * 1, sy * 20, 8.5, 1, false));
  medIdx.push(addIsle(sx * 40, sy * 12, 4.6, 1, true));
  addIsle(sx * 15, sy * 23, 4.2, 1, true);
  addIsle(sx * 25, sy * 9.5, 3.6, 1, true);
  addIsle(sx * 41, sy * 26, 3.4, 1, true);
});
// belt giants (nations can grow here)
const beltW = addIsle(-37, 0.3, 5.2, 1, true, 0.7);
const beltE = addIsle(37, -0.3, 5.2, 1, true, 0.7);
addIsle(-17, -0.4, 4.0, 1, true, 0.7);
addIsle(17, 0.4, 4.0, 1, true, 0.7);
addIsle(-27, 0, 2.6, 1, true, 0.8);
addIsle(27, 0, 2.6, 1, true, 0.8);
// the belt: many small and medium islands on the equator, never in the calm strips (|v| 4.5 to 8)
scatter([-50, -6, -3.4, 3.4], 16, 0.8, 2.0, 0.8);
scatter([6, 50, -3.4, 3.4], 16, 0.8, 2.0, 0.8);
// four seas, each with scattered islands of varied size (keep clear of the wall, the strips and the map edge)
scatter([-49, -7, 9, 31], 16, 0.7, 2.4, 1);
scatter([7, 49, 9, 31], 16, 0.7, 2.4, 1);
scatter([-49, -7, -31, -9], 16, 0.7, 2.4, 1);
scatter([7, 49, -31, -9], 16, 0.7, 2.4, 1);

// the wall: two halves with the equator channel between them
const wallN = path([0.4, 34], [-0.2, 3.2], rngR, 1.6, 60);
const wallS = path([-0.2, -3.2], [0.5, -34], rngR, 1.6, 60);
const wallLand = [wallN, wallS].map((l) => fractal(strip(l, 2.4), rngR, 0.12, 4, 0.1));

const rich = isles.filter((i) => i.rich || i.r > 3);
const regions: ExtraRegion[] = [];
const oilZones: number[][][] = [];
rich.forEach((it, k) => {
  const [x, y] = it.c;
  const r = it.r;
  const a = rngR() * Math.PI * 2;
  const ox = Math.cos(a) * r * 0.45;
  const oy = Math.sin(a) * r * 0.45 * 0.75;
  regions.push({ name: `Highlands ${k}`, kind: 'hills', poly: pl.ring(blob(x + ox, y + oy, r * 0.5, r * 0.4, rngR, 0.2)) });
  if (r > 3.3) regions.push({ name: `Peaks ${k}`, kind: 'mountains', strength: 0.8, poly: pl.ring(blob(x + ox, y + oy, r * 0.28, r * 0.22, rngR, 0.2)) });
  regions.push({ name: `Dry coast ${k}`, kind: 'desert', poly: pl.ring(blob(x - ox, y - oy, r * 0.45, r * 0.36, rngR, 0.2)) });
  oilZones.push(pl.ring(blob(x - ox, y - oy, r * 0.4, r * 0.32, rngR, 0.2)));
  if (r > 4) regions.push({ name: `Fen ${k}`, kind: 'swamp', poly: pl.ring(blob(x + oy, y - ox, r * 0.25, r * 0.2, rngR, 0.2)) });
});
// small islands: some desert, some hills, so iron and oil are scattered everywhere
isles.filter((i) => !i.rich && i.r <= 3 && i.r > 0.9).forEach((it, k) => {
  const kind = k % 3 === 0 ? 'desert' : k % 3 === 1 ? 'hills' : 'mountains';
  regions.push({ name: `Isle ${k}`, kind, poly: pl.ring(blob(it.c[0], it.c[1], it.r * 0.9, it.r * 0.8, rngR, 0.15)) });
  if (kind === 'desert') oilZones.push(pl.ring(blob(it.c[0], it.c[1], it.r * 0.8, it.r * 0.7, rngR, 0.15)));
});
for (const l of [wallN, wallS]) {
  regions.push({ name: 'Wall peaks', kind: 'mountains', strength: 0.95, poly: pl.ring(strip(l, 2.4)) });
  regions.push({ name: 'Wall foothills', kind: 'hills', poly: pl.ring(strip(l, 3.4)) });
}

const rect = (u0: number, u1: number, v0: number, v1: number): Pt[] => [[u0, v0], [u1, v0], [u1, v1], [u0, v1]];

export const FOURSEAS: DrawnMap = {
  land: [...isles.map((i) => i.poly), ...wallLand].map((p) => pl.ring(p)),
  lakes: [],
  rivers: [],
  regions,
  oilZones,
  paint: [
    { terrain: 'mountains', poly: pl.ring(strip(wallN, 1.9)) },
    { terrain: 'mountains', poly: pl.ring(strip(wallS, 1.9)) },
    // the two high passes: dry plains through the wall
    { terrain: 'plains', poly: pl.ring(rect(-3.6, 3.6, 17.6, 19.0)) },
    { terrain: 'plains', poly: pl.ring(rect(-3.6, 3.6, -22.4, -21.0)) },
  ],
};

const sp = (name: string, p: Pt, major = false): SpawnDef => ({ name, at: pl.P(p[0], p[1]), major, pop: major ? 2_000_000 : 1_000_000 });
const spawnAt = (i: number): Pt => [isles[i].c[0], isles[i].c[1]];

export const FOURSEAS_SPAWNS: SpawnDef[] = [
  sp('Aldmere', spawnAt(homeIdx[0]), true),
  sp('Brisk', spawnAt(medIdx[0])),
  sp('Caldrin', spawnAt(homeIdx[1]), true),
  sp('Dunmark', spawnAt(medIdx[1])),
  sp('Eskeld', spawnAt(homeIdx[2]), true),
  sp('Fenhollow', spawnAt(medIdx[2])),
  sp('Garrowe', spawnAt(homeIdx[3]), true),
  sp('Harrowick', spawnAt(medIdx[3])),
  sp('Isenvar', spawnAt(beltW)),
  sp('Jorlund', spawnAt(beltE)),
];
