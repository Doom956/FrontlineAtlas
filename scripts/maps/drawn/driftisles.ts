// "The Drifting Isles": a hand-drawn fictional map. One large central island is ringed by medium islands, split from it
// and from each other by narrow straits; chains and clusters of small islets fill the gaps between. Fleets and aircraft
// decide the war. Drawn for this project from our own shapes (see drawn/kit.ts).
import type { DrawnMap } from './kit';
import { blob, fractal, makePlane, rngFor } from './kit';
import type { Pt } from './kit';
import type { SpawnDef } from '../defs';
import type { ExtraRegion } from '../extra';

// shapes are drawn in a 100 x 64 design space and shrunk by S so the climate band stays mid-latitude
const S = 0.78;
export const DRIFTISLES_PLANE = makePlane(100 * S, 64 * S, 38);
const pl = {
  ring: (pts: Pt[]) => DRIFTISLES_PLANE.ring(pts.map(([u, v]): Pt => [u * S, v * S])),
  P: (u: number, v: number) => DRIFTISLES_PLANE.P(u * S, v * S),
};

interface Isle {
  c: Pt;
  r: number;
  poly: Pt[];
  rich: boolean;
}
const isles: Isle[] = [];
const rngI = rngFor(401);
const rngR = rngFor(402);

/** adds an island unless it comes within `gap` units of another one (circle test); returns its index or -1 */
function addIsle(cx: number, cy: number, r: number, gap: number, rich: boolean, squash = 0.75, wob = 0.2): number {
  for (const o of isles) if (Math.hypot(o.c[0] - cx, o.c[1] - cy) < o.r + r + gap) return -1;
  const poly = fractal(blob(cx, cy, r, r * squash, rngI, wob, rngI() * 3), rngI, 0.2, 4, 0.06);
  isles.push({ c: [cx, cy], r, poly, rich });
  return isles.length - 1;
}
function scatter(box: [number, number, number, number], count: number, rmin: number, rmax: number, gap: number): void {
  let placed = 0;
  for (let tries = 0; tries < 4000 && placed < count; tries++) {
    const r = rmin + (rmax - rmin) * rngI();
    const cx = box[0] + (box[1] - box[0]) * rngI();
    const cy = box[2] + (box[3] - box[2]) * rngI();
    if (addIsle(cx, cy, r, gap, false) >= 0) placed++;
  }
}
/** a chain of islets along a line */
function chain(a: Pt, b: Pt, count: number, rmin: number, rmax: number, gap: number): void {
  for (let i = 0; i < count; i++) {
    const t = (i + 0.5) / count;
    for (let k = 0; k < 20; k++) {
      const r = rmin + (rmax - rmin) * rngI();
      if (addIsle(a[0] + (b[0] - a[0]) * t + (rngI() - 0.5) * 2.2, a[1] + (b[1] - a[1]) * t + (rngI() - 0.5) * 2.2, r, gap, false) >= 0) break;
    }
  }
}

// the great central island, then the medium islands round it (gap -3: the circle test is loose for flat blobs)
const central = addIsle(0, 0, 11.5, 0, true, 0.74, 0.12);
isles[central].poly = fractal(blob(0, 0, 13, 9.6, rngI, 0.1, 0.1), rngI, 0.13, 4, 0.1);
const med: number[] = [
  addIsle(22, 1, 6.5, -3, true),
  addIsle(-22, -1, 6.5, -3, true),
  addIsle(2, 17.6, 6, -3, true),
  addIsle(-2, -17.6, 6, -3, true),
  addIsle(25, 17, 5, -3, true),
  addIsle(-25, 16.5, 5.5, -3, true),
  addIsle(25, -16.5, 5.5, -3, true),
  addIsle(-26, -16.5, 5, -3, true),
];
// outer mediums at the rim
addIsle(40, 7, 5, 1, true);
addIsle(-40, -6, 5, 1, true);
addIsle(41, -9, 4, 1, true);
addIsle(-41, 9, 4.4, 1, true);
addIsle(13, 27, 4, 1, true);
addIsle(-13, -27, 4, 1, true);
addIsle(-14, 26, 3.5, 1, true);
addIsle(14, -26, 3.5, 1, true);
// chains of small islets across the gaps between the big ones
chain([8, 22], [20, 20], 4, 0.7, 1.6, 0.5);
chain([-8, 21], [-20, 20], 4, 0.7, 1.6, 0.5);
chain([8, -22], [20, -21], 4, 0.7, 1.6, 0.5);
chain([-8, -22], [-20, -21], 4, 0.7, 1.6, 0.5);
chain([30, 10], [30, -9], 5, 0.7, 1.6, 0.5);
chain([-31, 10], [-31, -9], 5, 0.7, 1.6, 0.5);
chain([30, 22], [42, 18], 4, 0.7, 1.5, 0.5);
chain([-32, 22], [-44, 20], 4, 0.7, 1.5, 0.5);
chain([30, -22], [43, -20], 4, 0.7, 1.5, 0.5);
chain([-32, -22], [-44, -19], 4, 0.7, 1.5, 0.5);
// clusters
scatter([12, 20, 8, 12], 4, 0.6, 1.4, 0.5);
scatter([-20, -12, -12, -8], 4, 0.6, 1.4, 0.5);
scatter([34, 47, -5, 2], 6, 0.6, 1.6, 0.6);
scatter([-47, -34, 0, 7], 6, 0.6, 1.6, 0.6);
scatter([-49, 49, -31, 31], 30, 0.6, 1.6, 1.4);

const regions: ExtraRegion[] = [];
const oilZones: number[][][] = [];
isles.forEach((it, k) => {
  const [x, y] = it.c;
  const big = it.r > 8;
  const r = big ? 13 : it.r;
  const small = !it.rich;
  if (small && (it.r < 0.9 || it.r > 3)) return;
  const kinds = small ? [k % 3 === 0 ? 'desert' : k % 3 === 1 ? 'hills' : 'mountains'] : ['rich'];
  if (small) {
    const kind = kinds[0] as 'desert' | 'hills' | 'mountains';
    regions.push({ name: `Islet ${k}`, kind, poly: pl.ring(blob(x, y, it.r * 0.9, it.r * 0.8, rngR, 0.15)) });
    if (kind === 'desert') oilZones.push(pl.ring(blob(x, y, it.r * 0.8, it.r * 0.7, rngR, 0.15)));
    return;
  }
  const sets = big ? 2 : 1;
  for (let q = 0; q < sets; q++) {
    const a = rngR() * Math.PI * 2 + q * Math.PI;
    const d = big ? 0.5 : 0.45;
    const ox = Math.cos(a) * r * d;
    const oy = Math.sin(a) * r * d * 0.75;
    regions.push({ name: `Highlands ${k}.${q}`, kind: 'hills', poly: pl.ring(blob(x + ox, y + oy, r * 0.5, r * 0.4, rngR, 0.2)) });
    if (it.r > 3.3) regions.push({ name: `Peaks ${k}.${q}`, kind: 'mountains', strength: 0.8, poly: pl.ring(blob(x + ox, y + oy, r * 0.28, r * 0.22, rngR, 0.2)) });
    regions.push({ name: `Dry coast ${k}.${q}`, kind: 'desert', poly: pl.ring(blob(x - ox, y - oy, r * 0.42, r * 0.33, rngR, 0.2)) });
    oilZones.push(pl.ring(blob(x - ox, y - oy, r * 0.38, r * 0.3, rngR, 0.2)));
  }
  if (it.r > 4) regions.push({ name: `Fen ${k}`, kind: 'swamp', poly: pl.ring(blob(x + r * 0.1, y - r * 0.55 * 0.75, r * 0.22, r * 0.18, rngR, 0.2)) });
});

export const DRIFTISLES: DrawnMap = {
  land: isles.map((i) => pl.ring(i.poly)),
  lakes: [],
  rivers: [],
  regions,
  oilZones,
};

const sp = (name: string, p: Pt, major = false): SpawnDef => ({ name, at: pl.P(p[0], p[1]), major, pop: major ? 2_000_000 : 1_000_000 });
const at = (i: number): Pt => [isles[i].c[0], isles[i].c[1]];

export const DRIFTISLES_SPAWNS: SpawnDef[] = [
  sp('Veyra', [-5, 2], true),
  sp('Orsund', [6, -3], true),
  sp('Kelmar', at(med[0])),
  sp('Thessaly', at(med[1])),
  sp('Ravenne', at(med[2])),
  sp('Pellor', at(med[3])),
  sp('Dravik', at(med[4])),
  sp('Sunnach', at(med[5])),
  sp('Imbria', at(med[6])),
  sp('Norwick', at(med[7])),
];
