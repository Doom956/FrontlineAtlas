// Procedural map generation: continents, mountain ranges, climate biomes and clustered resources.
//
// Pipeline (all deterministic: only + - * /, sqrt, floor, abs; no Math.sin/exp/...):
//  1. Landmass layout per map type (groups of soft blobs; island chains on archipelago).
//  2. Coarse fields on a grid every C tiles (C = 2..4, ~280k nodes for any map size): domain-warped continental
//     elevation, moisture, temperature noise and ridged "upland" noise. Full resolution is bilinear upsampling, so
//     every field is smooth at the scale of the map and terrain forms large coherent regions.
//  3. Sea level = quantile giving the map type's land share; land mask smoothed (3x3 majority), inland lakes carved,
//     islands / lakes below a minimum size removed.
//  4. A few long mountain ranges walked across the land (with passes) + ridged hill belts -> ruggedness; mountains
//     and hills are its top quantiles. Climate (latitude, moisture, coast distance, lowland) gives the biomes.
//  5. Cleanup: 8-neighbour majority filter, regions smaller than N tiles merged into their neighbours, last pass on
//     tiles that differ from 3+ of their 4 neighbours. Shallow-water band along every coast.
//  6. Resources as small deposits (3-12 tiles), seeded on a stratified grid so every region gets some.
import { MAP_SIZES } from './config';
import { powInt } from './fmath';
import { Resource, Terrain } from './types';
import type { GameSettings, MapData, MapType } from './types';

// Local copies of the terrain / resource ids: hot loops should not go through imported bindings.
const T_DEEP: number = Terrain.DeepWater;
const T_SHALLOW: number = Terrain.ShallowWater;
const T_PLAINS: number = Terrain.Plains;
const T_FOREST: number = Terrain.Forest;
const T_HILLS: number = Terrain.Hills;
const T_MOUNTAINS: number = Terrain.Mountains;
const T_DESERT: number = Terrain.Desert;
const T_SWAMP: number = Terrain.Swamp;
const T_TUNDRA: number = Terrain.Tundra;
const R_IRON: number = Resource.Iron;
const R_OIL: number = Resource.Oil;
const R_FERTILE: number = Resource.Fertile;

/** Integer in [0, n) (same as rng.ts randInt; local so hot loops avoid imported bindings). */
function rint(rng: () => number, n: number): number {
  return Math.floor(rng() * n);
}

/** Writes the 4-neighbours of i into out (same order as grid.ts neighbors4), returns how many. */
function nb4(w: number, h: number, i: number, out: number[]): number {
  const x = i % w;
  const y = (i - x) / w;
  let k = 0;
  if (x > 0) out[k++] = i - 1;
  if (x < w - 1) out[k++] = i + 1;
  if (y > 0) out[k++] = i - w;
  if (y < h - 1) out[k++] = i + w;
  return k;
}

/** Empty map (all deep water, nothing owned). Also used by tests to build hand-made maps. */
export function createMapData(width: number, height: number): MapData {
  const n = width * height;
  return {
    width,
    height,
    terrain: new Uint8Array(n),
    resource: new Uint8Array(n),
    owner: new Uint16Array(n),
    building: new Int32Array(n),
    coastal: new Uint8Array(n),
    fallout: new Float32Array(n),
    landTileCount: 0,
  };
}

/** Recomputes map.coastal and map.landTileCount from map.terrain. */
export function computeCoastAndLand(map: MapData): void {
  const { width: w, height: h, terrain, coastal } = map;
  let land = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (terrain[i] <= 1) {
        coastal[i] = 0;
        continue;
      }
      land++;
      coastal[i] =
        (x > 0 && (terrain[i - 1] <= 1)) ||
        (x < w - 1 && (terrain[i + 1] <= 1)) ||
        (y > 0 && (terrain[i - w] <= 1)) ||
        (y < h - 1 && (terrain[i + w] <= 1))
          ? 1
          : 0;
    }
  }
  map.landTileCount = land;
}

// ---------- noise ----------

type Noise2 = (x: number, y: number) => number;

const R2 = 0.7071067811865476;
const GX = new Float64Array([1, -1, 0, 0, R2, -R2, R2, -R2]);
const GY = new Float64Array([0, 0, 1, -1, R2, R2, -R2, -R2]);

/** Seeded 2D gradient noise (256-periodic lattice, quintic fade), output about -1..1. */
function makeNoise(rng: () => number): Noise2 {
  const perm = new Uint8Array(512);
  for (let i = 0; i < 256; i++) perm[i] = i;
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const t = perm[i];
    perm[i] = perm[j];
    perm[j] = t;
  }
  for (let i = 0; i < 256; i++) perm[i + 256] = perm[i];
  const ox = rng() * 256;
  const oy = rng() * 256;
  return (x: number, y: number): number => {
    x += ox;
    y += oy;
    const xf = Math.floor(x);
    const yf = Math.floor(y);
    const fx = x - xf;
    const fy = y - yf;
    const X = xf & 255;
    const Y = yf & 255;
    const p0 = perm[X];
    const p1 = perm[X + 1];
    const h00 = perm[p0 + Y] & 7;
    const h01 = perm[p0 + Y + 1] & 7;
    const h10 = perm[p1 + Y] & 7;
    const h11 = perm[p1 + Y + 1] & 7;
    const n00 = GX[h00] * fx + GY[h00] * fy;
    const n10 = GX[h10] * (fx - 1) + GY[h10] * fy;
    const n01 = GX[h01] * fx + GY[h01] * (fy - 1);
    const n11 = GX[h11] * (fx - 1) + GY[h11] * (fy - 1);
    const u = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
    const v = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
    const a = n00 + (n10 - n00) * u;
    const b = n01 + (n11 - n01) * u;
    return (a + (b - a) * v) * 1.4;
  };
}

/** Fractal sum of `octaves` octaves (lacunarity 2, gain 0.5), about -1..1. x, y already in noise units. */
function fbm(noise: Noise2, x: number, y: number, octaves: number): number {
  let sum = 0;
  let amp = 1;
  let norm = 0;
  let f = 1;
  for (let o = 0; o < octaves; o++) {
    sum += amp * noise(x * f + o * 19.13, y * f + o * 7.71);
    norm += amp;
    amp *= 0.5;
    f *= 2;
  }
  return sum / norm;
}

/** Octaves so that the finest one still spans >= minWave tiles (base wavelength S / freq tiles). */
function octavesFor(S: number, freq: number, minWave: number, max: number): number {
  let o = 0;
  let wave = S / freq;
  while (wave >= minWave && o < max) {
    o++;
    wave /= 2;
  }
  return Math.max(1, o);
}

// ---------- field helpers ----------

/** Value v such that `share` of the values in arr where mask[i] !== 0 are >= v (4096-bin histogram). */
function quantileAbove(arr: Float32Array, mask: Uint8Array | null, share: number): number {
  let min = Infinity;
  let max = -Infinity;
  let count = 0;
  for (let i = 0; i < arr.length; i++) {
    if (mask && mask[i] === 0) continue;
    const v = arr[i];
    if (v < min) min = v;
    if (v > max) max = v;
    count++;
  }
  if (count === 0 || max <= min) return max;
  const BINS = 4096;
  const hist = new Uint32Array(BINS);
  const scale = (BINS - 1) / (max - min);
  for (let i = 0; i < arr.length; i++) {
    if (mask && mask[i] === 0) continue;
    hist[Math.floor((arr[i] - min) * scale)]++;
  }
  const want = share * count;
  let acc = 0;
  for (let b = BINS - 1; b >= 0; b--) {
    acc += hist[b];
    if (acc >= want) return min + b / scale;
  }
  return min;
}

/** quantileAbove for several shares from one histogram (same results as separate calls). */
function quantilesAbove(arr: Float32Array, mask: Uint8Array, shares: number[]): number[] {
  let min = Infinity;
  let max = -Infinity;
  let count = 0;
  for (let i = 0; i < arr.length; i++) {
    if (mask[i] === 0) continue;
    const v = arr[i];
    if (v < min) min = v;
    if (v > max) max = v;
    count++;
  }
  if (count === 0 || max <= min) return shares.map(() => max);
  const BINS = 4096;
  const hist = new Uint32Array(BINS);
  const scale = (BINS - 1) / (max - min);
  for (let i = 0; i < arr.length; i++) if (mask[i] !== 0) hist[Math.floor((arr[i] - min) * scale)]++;
  return shares.map((share) => {
    const want = share * count;
    let acc = 0;
    for (let b = BINS - 1; b >= 0; b--) {
      acc += hist[b];
      if (acc >= want) return min + b / scale;
    }
    return min;
  });
}

/** Chamfer (3-4) distance from every tile to the nearest tile with mask[i] === v, in thirds of a tile, <= 65535. */
function chamfer(mask: Uint8Array, v: number, w: number, h: number, out: Uint16Array): void {
  const INF = 65535;
  const n = w * h;
  for (let i = 0; i < n; i++) out[i] = mask[i] === v ? 0 : INF;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      let d = out[i];
      if (d === 0) continue;
      if (x > 0 && out[i - 1] + 3 < d) d = out[i - 1] + 3;
      if (y > 0) {
        if (out[i - w] + 3 < d) d = out[i - w] + 3;
        if (x > 0 && out[i - w - 1] + 4 < d) d = out[i - w - 1] + 4;
        if (x < w - 1 && out[i - w + 1] + 4 < d) d = out[i - w + 1] + 4;
      }
      out[i] = d;
    }
  }
  for (let y = h - 1; y >= 0; y--) {
    for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x;
      let d = out[i];
      if (d === 0) continue;
      if (x < w - 1 && out[i + 1] + 3 < d) d = out[i + 1] + 3;
      if (y < h - 1) {
        if (out[i + w] + 3 < d) d = out[i + w] + 3;
        if (x < w - 1 && out[i + w + 1] + 4 < d) d = out[i + w + 1] + 4;
        if (x > 0 && out[i + w - 1] + 4 < d) d = out[i + w - 1] + 4;
      }
      out[i] = d;
    }
  }
}

/** 3x3 majority filter on a 0/1 mask (>= 5 of 9 set -> 1); tiles outside the map count as 0. */
function smoothMask(mask: Uint8Array, w: number, h: number, passes: number): void {
  const row = new Uint8Array(w * h);
  for (let p = 0; p < passes; p++) {
    for (let y = 0; y < h; y++) {
      const r = y * w;
      for (let x = 0; x < w; x++) {
        const i = r + x;
        row[i] = mask[i] + (x > 0 ? mask[i - 1] : 0) + (x < w - 1 ? mask[i + 1] : 0);
      }
    }
    for (let y = 0; y < h; y++) {
      const r = y * w;
      for (let x = 0; x < w; x++) {
        const i = r + x;
        const s = row[i] + (y > 0 ? row[i - w] : 0) + (y < h - 1 ? row[i + w] : 0);
        mask[i] = s >= 5 ? 1 : 0;
      }
    }
  }
}

/**
 * Flips small 4-connected components of the 0/1 mask: land components (1) under minLand tiles become 0, and
 * components of 0 not touching the map border (lakes) under minWater tiles become 1.
 */
function removeSmallComponents(mask: Uint8Array, w: number, h: number, minLand: number, minWater: number): void {
  const n = w * h;
  const seen = new Uint8Array(n);
  const buf = new Int32Array(n);
  for (let s = 0; s < n; s++) {
    if (seen[s]) continue;
    const v = mask[s];
    let head = 0;
    let tail = 0;
    let border = false;
    buf[tail++] = s;
    seen[s] = 1;
    while (head < tail) {
      const i = buf[head++];
      const x = i % w;
      const y = (i - x) / w;
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) border = true;
      if (x > 0 && !seen[i - 1] && mask[i - 1] === v) {
        seen[i - 1] = 1;
        buf[tail++] = i - 1;
      }
      if (x < w - 1 && !seen[i + 1] && mask[i + 1] === v) {
        seen[i + 1] = 1;
        buf[tail++] = i + 1;
      }
      if (y > 0 && !seen[i - w] && mask[i - w] === v) {
        seen[i - w] = 1;
        buf[tail++] = i - w;
      }
      if (y < h - 1 && !seen[i + w] && mask[i + w] === v) {
        seen[i + w] = 1;
        buf[tail++] = i + w;
      }
    }
    const flip = v === 1 ? tail < minLand : !border && tail < minWater;
    if (flip) for (let k = 0; k < tail; k++) mask[buf[k]] = 1 - v;
  }
}

/** Fills the coarse nodes with an odd x or y from their even neighbours (bilinear in node space). */
function fillOddNodes(a: Float32Array, cw: number, ch: number): void {
  for (let cy = 0; cy < ch; cy += 2) {
    const r = cy * cw;
    for (let cx = 1; cx < cw; cx += 2) a[r + cx] = cx + 1 < cw ? (a[r + cx - 1] + a[r + cx + 1]) * 0.5 : a[r + cx - 1];
  }
  for (let cy = 1; cy < ch; cy += 2) {
    const r = cy * cw;
    for (let cx = 0; cx < cw; cx++) a[r + cx] = cy + 1 < ch ? (a[r - cw + cx] + a[r + cw + cx]) * 0.5 : a[r - cw + cx];
  }
}

/** Bilinear upsampling of a coarse grid (node every C tiles, cw nodes per row) to w x h tiles. */
function upsample(src: Float32Array, cw: number, C: number, w: number, h: number, out: Float32Array): void {
  const ix = new Int32Array(w);
  const fx = new Float32Array(w);
  for (let x = 0; x < w; x++) {
    ix[x] = Math.floor(x / C);
    fx[x] = (x - ix[x] * C) / C;
  }
  for (let y = 0; y < h; y++) {
    const cy = Math.floor(y / C);
    const ty = (y - cy * C) / C;
    const r0 = cy * cw;
    const r1 = r0 + cw;
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const cx = ix[x];
      const tx = fx[x];
      const a = src[r0 + cx];
      const b = src[r0 + cx + 1];
      const c = src[r1 + cx];
      const d = src[r1 + cx + 1];
      const top = a + (b - a) * tx;
      const bot = c + (d - c) * tx;
      out[row + x] = top + (bot - top) * ty;
    }
  }
}

// unit vectors at 22.5 degree steps
const RING16_X = [1, 0.9238795, 0.7071068, 0.3826834, 0, -0.3826834, -0.7071068, -0.9238795, -1, -0.9238795, -0.7071068, -0.3826834, 0, 0.3826834, 0.7071068, 0.9238795];
const RING16_Y = [0, 0.3826834, 0.7071068, 0.9238795, 1, 0.9238795, 0.7071068, 0.3826834, 0, -0.3826834, -0.7071068, -0.9238795, -1, -0.9238795, -0.7071068, -0.3826834];

/** True when 16 points on the circle of radius r around tile i are all land inside the map. */
function landAround(land: Uint8Array, w: number, h: number, i: number, r: number): boolean {
  const x = i % w;
  const y = (i - x) / w;
  for (let k = 0; k < 16; k++) {
    const px = Math.floor(x + RING16_X[k] * r);
    const py = Math.floor(y + RING16_Y[k] * r);
    if (px < 0 || py < 0 || px >= w || py >= h || !land[py * w + px]) return false;
  }
  return true;
}

function unitDir(rng: () => number): [number, number] {
  for (let k = 0; k < 20; k++) {
    const dx = rng() * 2 - 1;
    const dy = rng() * 2 - 1;
    const l2 = dx * dx + dy * dy;
    if (l2 > 0.04 && l2 <= 1) {
      const l = Math.sqrt(l2);
      return [dx / l, dy / l];
    }
  }
  return [1, 0];
}

// ---------- map type parameters ----------

interface TypeParams {
  landShare: number;
  /** blob weight vs noise weight in the continental elevation */
  blobWeight: number;
  noiseWeight: number;
  /** domain warp strength (share of the smaller map side) and frequency (cycles per smaller side) */
  warp: number;
  warpFreq: number;
  /** base frequency of the elevation noise (cycles per smaller map side) */
  noiseFreq: number;
  /** how strongly the sea between two landmass groups is pushed down (0 = they may merge) */
  separation: number;
  /** depth of the strait cut where two groups meet (0 = none) */
  strait: number;
  /** strait width, in blob-strength difference */
  straitWidth: number;
  mountainShare: number; // of land
  hillShare: number; // of land
  /** mountain ranges per (land tiles / S^2) and range length as a share of S */
  rangeK: number;
  rangeLen: [number, number];
  /** inland lakes per (land tiles / S^2) */
  lakeK: number;
}

const TYPE_PARAMS: Record<MapType, TypeParams> = {
  continents: { landShare: 0.45, blobWeight: 1.0, noiseWeight: 0.75, warp: 0.22, warpFreq: 1.6, noiseFreq: 2.6, separation: 0.9, strait: 0.8, straitWidth: 0.12, mountainShare: 0.06, hillShare: 0.12, rangeK: 9, rangeLen: [0.35, 0.75], lakeK: 9 },
  pangaea: { landShare: 0.6, blobWeight: 1.0, noiseWeight: 0.7, warp: 0.2, warpFreq: 1.5, noiseFreq: 2.4, separation: 0, strait: 0, straitWidth: 0.1, mountainShare: 0.06, hillShare: 0.12, rangeK: 8, rangeLen: [0.4, 0.8], lakeK: 9 },
  archipelago: { landShare: 0.3, blobWeight: 1.0, noiseWeight: 0.8, warp: 0.15, warpFreq: 2.5, noiseFreq: 4.5, separation: 0.6, strait: 0.9, straitWidth: 0.35, mountainShare: 0.05, hillShare: 0.11, rangeK: 10, rangeLen: [0.12, 0.3], lakeK: 4 },
  highlands: { landShare: 0.55, blobWeight: 0.8, noiseWeight: 0.85, warp: 0.22, warpFreq: 1.6, noiseFreq: 2.8, separation: 0.3, strait: 0, straitWidth: 0.1, mountainShare: 0.15, hillShare: 0.27, rangeK: 15, rangeLen: [0.3, 0.7], lakeK: 7 },
};

interface Blob {
  x: number;
  y: number;
  r: number;
  g: number; // group (landmass) index; blobs are stored grouped
}

/** Landmass layout in tile coordinates. Kernel radius r: the blob has weight (1 - d^2/r^2)^2 within r. */
function placeLandmasses(type: MapType, w: number, h: number, landShare: number, rng: () => number): Blob[] {
  const S = Math.min(w, h);
  const blobs: Blob[] = [];
  const area = landShare * w * h;
  if (type === 'archipelago') {
    let g = 0;
    let next = 0;
    const chains = 7 + rint(rng, 4);
    for (let c = 0; c < chains; c++) {
      let x = w * (0.12 + rng() * 0.76);
      let y = h * (0.12 + rng() * 0.76);
      let [dx, dy] = unitDir(rng);
      const count = 5 + rint(rng, 6);
      const bend = (rng() * 2 - 1) * 0.35;
      for (let k = 0; k < count; k++) {
        const r = S * (0.05 + rng() * 0.07);
        if (k % 2 === 0) g = next++;
        blobs.push({ x, y, r, g });
        const step = r * (1.2 + rng() * 0.6);
        const ndx = dx - dy * bend;
        const ndy = dy + dx * bend;
        const l = Math.sqrt(ndx * ndx + ndy * ndy);
        dx = ndx / l;
        dy = ndy / l;
        x += dx * step;
        y += dy * step;
        if (x < w * 0.08 || x > w * 0.92 || y < h * 0.08 || y > h * 0.92) break;
      }
    }
    const singles = 4 + rint(rng, 5);
    for (let k = 0; k < singles; k++) blobs.push({ x: w * (0.1 + rng() * 0.8), y: h * (0.1 + rng() * 0.8), r: S * (0.05 + rng() * 0.06), g: next++ });
    return blobs;
  }
  const groups = type === 'pangaea' ? 1 : type === 'continents' ? 3 + rint(rng, 4) : 2 + rint(rng, 2);
  const centres: [number, number][] = [];
  if (groups === 1) centres.push([w * (0.45 + rng() * 0.1), h * (0.45 + rng() * 0.1)]);
  else {
    // best of 24 candidates: farthest from the landmasses so far and from the map edge (fills the map evenly)
    for (let k = 0; k < groups; k++) {
      let best: [number, number] = [w / 2, h / 2];
      let bestD = -Infinity;
      for (let tries = 0; tries < 24; tries++) {
        const x = w * (0.16 + rng() * 0.68);
        const y = h * (0.2 + rng() * 0.6);
        let d = Math.min(x, w - x, y, h - y) * 1.6;
        d = d * d;
        for (const [cx, cy] of centres) d = Math.min(d, (cx - x) * (cx - x) + (cy - y) * (cy - y));
        if (d > bestD) {
          bestD = d;
          best = [x, y];
        }
      }
      centres.push(best);
    }
  }
  const rg = Math.sqrt(area / groups / Math.PI); // radius of a round landmass of the right area
  for (let g = 0; g < groups; g++) {
    const [cx, cy] = centres[g];
    const subs = (type === 'pangaea' ? 5 : 2) + rint(rng, 3);
    // spread the sub-blobs along a random axis so landmasses aren't round
    const [ax, ay] = unitDir(rng);
    const stretch = type === 'pangaea' ? 1.1 : 0.9;
    for (let k = 0; k < subs; k++) {
      const t = (k / Math.max(1, subs - 1) - 0.5) * 2 * stretch + (rng() - 0.5) * 0.5;
      const side = (rng() - 0.5) * 0.7;
      const ox = (ax * t - ay * side) * rg * (type === 'pangaea' ? 1.1 : 1);
      const oy = (ay * t + ax * side) * rg * (type === 'pangaea' ? 0.6 : 1);
      blobs.push({ x: cx + ox, y: cy + oy, r: rg * (type === 'pangaea' ? 0.8 + rng() * 0.4 : 1.0 + rng() * 0.5), g });
    }
  }
  return blobs;
}

// ---------- generation ----------

export function generateMap(settings: GameSettings, rng: () => number): MapData {
  const size = MAP_SIZES[settings.mapSize] ?? MAP_SIZES.medium;
  const w = size.width;
  const h = size.height;
  const n = w * h;
  const mapType: MapType = TYPE_PARAMS[settings.mapType] ? settings.mapType : 'continents';
  const P = TYPE_PARAMS[mapType];
  const map = createMapData(w, h);
  const S = Math.min(w, h);

  const nElev = makeNoise(rng);
  const nWarpX = makeNoise(rng);
  const nWarpY = makeNoise(rng);
  const nMoist = makeNoise(rng);
  const nTemp = makeNoise(rng);
  const nUpl = makeNoise(rng);
  const nPass = makeNoise(rng);
  const nLake = makeNoise(rng);
  const nSwamp = makeNoise(rng);

  const players = settings.aiCount + (settings.humanPlayer ? 1 : 0);
  const landShare = Math.min(0.85, Math.max(P.landShare, (players * 400) / n));
  const blobs = placeLandmasses(mapType, w, h, landShare, rng);

  // ---- coarse fields ----
  const C = Math.max(2, Math.round(S / 330));
  const cw = Math.floor((w - 1) / C) + 2;
  const ch = Math.floor((h - 1) / C) + 2;
  const cn = cw * ch;
  const cElev = new Float32Array(cn);
  const cMoist = new Float32Array(cn);
  const cTemp = new Float32Array(cn);
  const cUpl = new Float32Array(cn);
  const cDet = new Float32Array(cn);
  const elevOct = octavesFor(S, P.noiseFreq, 2.5 * C, 9);
  const warp2Freq = 6;
  const warp2Oct = octavesFor(S, warp2Freq, 6 * C, 3);
  const warpOct = octavesFor(S, P.warpFreq, 8 * C, 4);
  const uplFreq = 2.4;
  const uplOct = octavesFor(S, uplFreq, 6 * C, 4);
  const edgeMargin = 0.07;
  const invS = 1 / S;
  for (let cy = 0; cy < ch; cy++) {
    const Y = cy * C;
    for (let cx = 0; cx < cw; cx++) {
      const X = cx * C;
      const u = X * invS;
      const v = Y * invS;
      const wu0 = u + P.warp * fbm(nWarpX, u * P.warpFreq, v * P.warpFreq, warpOct);
      const wv0 = v + P.warp * fbm(nWarpY, u * P.warpFreq + 5.2, v * P.warpFreq + 1.3, warpOct);
      // second, finer warp: bays, capes and peninsulas
      const wu = wu0 + 0.035 * fbm(nWarpX, wu0 * warp2Freq + 41.7, wv0 * warp2Freq + 3.1, warp2Oct);
      const wv = wv0 + 0.035 * fbm(nWarpY, wu0 * warp2Freq + 13.9, wv0 * warp2Freq + 77.2, warp2Oct);
      const wx = wu * S;
      const wy = wv * S;
      // strongest and second strongest landmass group (soft union of the group's blobs)
      let b1 = 0;
      let b2 = 0;
      let cur = 0;
      let curG = -1;
      for (let k = 0; k <= blobs.length; k++) {
        const b = k < blobs.length ? blobs[k] : null;
        if (!b || b.g !== curG) {
          if (cur > b1) {
            b2 = b1;
            b1 = cur;
          } else if (cur > b2) b2 = cur;
          if (!b) break;
          cur = 0;
          curG = b.g;
        }
        const ddx = wx - b.x;
        const ddy = wy - b.y;
        const t = (ddx * ddx + ddy * ddy) / (b.r * b.r);
        if (t < 1) {
          const f = (1 - t) * (1 - t);
          cur = 1 - (1 - cur) * (1 - f);
        }
      }
      let blob = b1 - P.separation * b2;
      // a strait along the line where two landmass groups are equally strong, so they stay apart
      if (P.strait > 0 && b2 > 0.05) blob -= P.strait * Math.max(0, 1 - (b1 - b2) / P.straitWidth) * Math.min(1, b2 * 6);
      let e = P.blobWeight * blob + P.noiseWeight * 0.5 * fbm(nElev, wu * P.noiseFreq, wv * P.noiseFreq, elevOct);
      const edge = Math.min(X, Y, w - 1 - X, h - 1 - Y) * invS;
      if (edge < edgeMargin) {
        const t = 1 - edge / edgeMargin;
        e -= t * t * 1.5;
      }
      // rounded (superellipse) falloff on warped coordinates, so land masses don't take the map's rectangle shape
      const ea = (2 * wx) / w - 1;
      const eb = (2 * wy) / h - 1;
      const q = ea * ea * ea * ea + eb * eb * eb * eb;
      if (q > 0.35) e -= (q - 0.35) * 1.2;
      const ci = cy * cw + cx;
      cElev[ci] = e;
      // ridged noise: lines where the noise crosses zero -> long hill belts
      const r = 1 - Math.abs(fbm(nUpl, wu * uplFreq, wv * uplFreq, uplOct));
      cUpl[ci] = r * r;
      // Climate noise is smooth at this scale: every other node, the rest interpolated below.
      if ((cx & 1) === 0 && (cy & 1) === 0) {
        cMoist[ci] = fbm(nMoist, wu * 2.2, wv * 2.2, 4);
        cTemp[ci] = fbm(nTemp, wu * 3, wv * 3, 3);
        cDet[ci] = fbm(nSwamp, wu * 14, wv * 14, 2);
      }
    }
  }
  fillOddNodes(cMoist, cw, ch);
  fillOddNodes(cTemp, cw, ch);
  fillOddNodes(cDet, cw, ch);

  // ---- land mask ----
  const elev = new Float32Array(n);
  upsample(cElev, cw, C, w, h, elev);
  const sea = quantileAbove(elev, null, landShare);
  const land = new Uint8Array(n);
  for (let i = 0; i < n; i++) land[i] = elev[i] >= sea ? 1 : 0;
  smoothMask(land, w, h, 2);
  const BORDER = 3;
  const clearBorder = (): void => {
    for (let y = 0; y < h; y++) {
      const row = y * w;
      if (y < BORDER || y >= h - BORDER) {
        land.fill(0, row, row + w);
        continue;
      }
      for (let x = 0; x < BORDER; x++) {
        land[row + x] = 0;
        land[row + w - 1 - x] = 0;
      }
    }
  };
  clearBorder();

  // Inland lakes: organic blobs carved into the interior.
  let landCount = 0;
  for (let i = 0; i < n; i++) landCount += land[i];
  const lakes = Math.round(P.lakeK * (landCount / (S * S))) + rint(rng, 3);
  for (let k = 0; k < lakes; k++) {
    const R = S * (0.008 + rng() * 0.02);
    let c = -1;
    for (let t = 0; t < 200 && c < 0; t++) {
      const i = rint(rng, n);
      if (land[i] && landAround(land, w, h, i, R + S * 0.03)) c = i;
    }
    if (c < 0) continue;
    const cx = c % w;
    const cy = (c - cx) / w;
    const ex = 0.7 + rng() * 0.8; // ellipse axes
    const ey = 1.7 - ex;
    const Rmax = Math.ceil(R * 2.2);
    const nf = 0.6 / R;
    for (let y = Math.max(0, cy - Rmax); y <= Math.min(h - 1, cy + Rmax); y++) {
      for (let x = Math.max(0, cx - Rmax); x <= Math.min(w - 1, cx + Rmax); x++) {
        const dx = (x - cx) / ex;
        const dy = (y - cy) / ey;
        const rr = R * (0.9 + 0.7 * fbm(nLake, x * nf, y * nf, 2));
        if (dx * dx + dy * dy < rr * rr) land[y * w + x] = 0;
      }
    }
  }
  smoothMask(land, w, h, 1);
  clearBorder();
  // Small islands and lakes are removed once, after the coast detail (below).
  const minLake = Math.max(16, Math.round((S * S) / 15000));
  const distW = new Uint16Array(n); // distance to water, thirds of a tile
  chamfer(land, 0, w, h, distW);

  // ---- ruggedness: mountain ranges + hill belts ----
  const rugged = new Float32Array(n);
  upsample(cUpl, cw, C, w, h, rugged);
  for (let i = 0; i < n; i++) rugged[i] *= 0.45;
  landCount = 0;
  for (let i = 0; i < n; i++) landCount += land[i];
  const ranges = Math.round(P.rangeK * (landCount / (S * S))) + rint(rng, 2);
  for (let k = 0; k < ranges; k++) {
    let c = -1;
    const inland = 3 * S * 0.04;
    for (let t = 0; t < 300 && c < 0; t++) {
      const i = rint(rng, n);
      if (land[i] && distW[i] > inland * (t < 150 ? 1 : 0.3) && rugged[i] < 0.5) c = i;
    }
    if (c < 0) continue;
    const len = S * (P.rangeLen[0] + rng() * (P.rangeLen[1] - P.rangeLen[0]));
    const R = S * (0.034 + rng() * 0.016);
    const step = Math.max(1, R * 0.15);
    const [d0x, d0y] = unitDir(rng);
    const bend = (rng() * 2 - 1) * 0.02;
    const passOff = rng() * 200;
    for (let side = 0; side < 2; side++) {
      let x = c % w;
      let y = (c - x) / w;
      let dx = side === 0 ? d0x : -d0x;
      let dy = side === 0 ? d0y : -d0y;
      let wet = 0;
      const steps = Math.ceil(len / 2 / step);
      for (let s = 0; s < steps; s++) {
        const along = (side === 0 ? s : -s) * step * invS;
        // passes: the range dips to hill height where this 1D noise is low
        // taper over the last quarter of each half so ranges end in foothills, not blunt
        const taper = Math.min(1, (steps - s) / (steps * 0.25));
        const str = Math.min(1, Math.max(0.25, 0.95 + 0.9 * nPass(along * 7 + passOff, passOff))) * (0.45 + 0.55 * taper);
        // stop before running into another range (no criss-crossing)
        if (s > 0 && rangeAhead(rugged, w, h, x, y, dx, dy, R * 1.4)) break;
        const rw = R * (0.85 + 0.5 * nPass(along * 11 + passOff, passOff + 90)) * (0.6 + 0.4 * taper);
        stampRange(rugged, w, h, x, y, rw, str);
        const turn = (side === 0 ? bend : -bend) + 0.12 * nPass(along * 4 + passOff, passOff + 50);
        const ndx = dx - dy * turn;
        const ndy = dy + dx * turn;
        const l = Math.sqrt(ndx * ndx + ndy * ndy);
        dx = ndx / l;
        dy = ndy / l;
        x += dx * step;
        y += dy * step;
        if (x < 1 || y < 1 || x > w - 2 || y > h - 2) break;
        if (!land[Math.floor(y) * w + Math.floor(x)]) {
          wet += step;
          if (wet > R) break;
        } else wet = 0;
      }
    }
  }
  // ---- fractal coastline: bays, peninsulas, capes, islets, fjords ----
  roughenCoast(land, distW, rugged, w, h, S, C, cw, ch, rng);
  clearBorder();
  removeSmallComponents(land, w, h, Math.max(10, Math.round((S * S) / 60000)), minLake);
  chamfer(land, 0, w, h, distW);

  // ragged edges for mountains and hills
  const det = new Float32Array(n);
  upsample(cDet, cw, C, w, h, det);
  for (let i = 0; i < n; i++) rugged[i] += 0.1 * det[i];
  const [mThr, hThr] = quantilesAbove(rugged, land, [P.mountainShare, P.mountainShare + P.hillShare]);

  // ---- climate ----
  const moist = new Float32Array(n);
  upsample(cMoist, cw, C, w, h, moist);
  const temp = new Float32Array(n);
  upsample(cTemp, cw, C, w, h, temp);
  const coastScale = 3 * S * 0.08;
  for (let y = 0; y < h; y++) {
    const lat = Math.abs((y / (h - 1)) * 2 - 1); // 0 at the equator, 1 at the top / bottom edge
    const sub = Math.max(0, 1 - Math.abs(lat - 0.38) / 0.2); // dry subtropical belts
    const eq = Math.max(0, 1 - lat / 0.2); // wet equator
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!land[i]) continue;
      const coast = Math.max(0, 1 - distW[i] / coastScale);
      moist[i] = moist[i] * 0.6 + coast * 0.3 - sub * 0.35 + eq * 0.25 + det[i] * 0.06;
      temp[i] = 1 - lat + temp[i] * 0.2 + det[i] * 0.04;
    }
  }
  // driest 16 % (desert), wettest 42 % (forest), 13 % (swamp, where also low and warm)
  const [swampThr, forestThr, borealThr, dryThr] = quantilesAbove(moist, land, [0.13, 0.42, 0.62, 0.84]);
  const lowThr = quantileAbove(elev, land, 0.72); // lowest 28 % of the land
  // tundra: the coldest ~8 % of the land (toward the top and bottom edges), temp 0.22..0.4
  const tundraThr = Math.min(0.4, Math.max(0.22, quantileAbove(temp, land, 0.92)));
  const coastSwampD = 3 * S * 0.025;

  const terrain = map.terrain;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!land[i]) {
        terrain[i] = T_DEEP;
        continue;
      }
      const r = rugged[i];
      if (r >= mThr) {
        terrain[i] = T_MOUNTAINS;
        continue;
      }
      if (r >= hThr) {
        terrain[i] = T_HILLS;
        continue;
      }
      const t = temp[i];
      const m = moist[i];
      const low = elev[i] < lowThr;
      if (t < tundraThr) terrain[i] = T_TUNDRA;
      else if (t > 0.42 && m < dryThr) terrain[i] = T_DESERT;
      else if (t > 0.3 && low && (m > swampThr || (distW[i] < coastSwampD && m > forestThr && nSwamp(x * invS * 9, y * invS * 9) > 0.3))) terrain[i] = T_SWAMP;
      else if (m > forestThr || (t < 0.38 && m > borealThr)) terrain[i] = T_FOREST;
      else terrain[i] = T_PLAINS;
    }
  }

  // ---- cleanup ----
  majorityFilter(terrain, land, w, h, 1);
  const minRegion = Math.max(12, Math.round((S * S) / 16000));
  mergeSmallRegions(terrain, land, w, h, minRegion);
  fixSpeckle(terrain, land, w, h, 2);

  // ---- water: shallow band along every coast ----
  shallowBand(terrain, land, w, h, S >= 1200 ? 3 : 2);

  computeCoastAndLand(map);

  // ---- resources ----
  // Which resource each tile may hold: iron on hills / mountains, oil on desert / swamp / tundra, fertile on plains
  // near the coast or a lake.
  const landN = map.landTileCount;
  const kind = new Uint8Array(n);
  const fertileD = 3 * Math.max(10, Math.round(S * 0.08));
  for (let i = 0; i < n; i++) {
    const t = terrain[i];
    if (t === T_HILLS || t === T_MOUNTAINS) kind[i] = R_IRON;
    else if (t === T_DESERT || t === T_SWAMP || t === T_TUNDRA) kind[i] = R_OIL;
    else if (t === T_PLAINS && distW[i] <= fertileD) kind[i] = R_FERTILE;
  }
  placeResources(map, rng, kind, [0, Math.round(landN * 0.015), Math.round(landN * 0.01), Math.round(landN * 0.03)], S);

  return map;
}

/**
 * Fractal coast detail on the land mask, at every scale. The coast is moved by a signed distance (thirds of a tile,
 * > 0 inside land) plus a displacement whose octaves have an amplitude proportional to their wavelength (a fractal
 * curve): wavelengths S/5 down to a few tiles. The large octaves are evaluated on the coarse grid and upsampled; the
 * fine ones only next to the coast. A slow noise varies the roughness along the coast (some coasts smooth, some
 * ragged), so it does not look uniform. Pushing water up makes capes, peninsulas and offshore islets; pushing land
 * down makes bays. On mountain coasts and at high latitude, narrow ridged-noise channels cut fjord-like inlets.
 * One 3x3 majority pass afterwards removes single-tile notches, so the shore stays crisp.
 */
function roughenCoast(
  land: Uint8Array,
  distW: Uint16Array,
  rugged: Float32Array,
  w: number,
  h: number,
  S: number,
  C: number,
  cw: number,
  ch: number,
  rng: () => number,
): void {
  const n = w * h;
  const nCoast = makeNoise(rng);
  const nAmp = makeNoise(rng);
  const nFjord = makeNoise(rng);
  const invS = 1 / S;
  // Octaves: frequency f0 * 2^k cycles per S, amplitude amp0 * GAIN^k tiles (GAIN > 0.5: rougher at small scales).
  const f0 = 5;
  const amp0 = 0.04 * S;
  const GAIN = 0.6;
  let coarseOct = 0;
  while (coarseOct < 6 && S / (f0 * (1 << coarseOct)) >= 4 * C) coarseOct++;
  let fineOct = 0;
  while (fineOct < 4 && S / (f0 * (1 << (coarseOct + fineOct))) >= 3) fineOct++;
  // Coarse octaves and the roughness modulation on the coarse grid (values in thirds of a tile).
  const cn = cw * ch;
  const cDisp = new Float32Array(cn);
  const cMod = new Float32Array(cn);
  for (let cy = 0; cy < ch; cy++) {
    for (let cx = 0; cx < cw; cx++) {
      const u = cx * C * invS;
      const v = cy * C * invS;
      const mod = 0.35 + 1.3 * Math.max(0, Math.min(1, 0.5 + 0.8 * fbm(nAmp, u * 1.7, v * 1.7, 2)));
      let s = 0;
      let a = amp0;
      let f = f0;
      for (let k = 0; k < coarseOct; k++) {
        s += a * nCoast(u * f + k * 31.7, v * f + k * 17.3);
        a *= GAIN;
        f *= 2;
      }
      const ci = cy * cw + cx;
      cDisp[ci] = s * mod * 3;
      cMod[ci] = mod;
    }
  }
  // Bilinear lookups of the coarse fields, only where needed (near the coast).
  const invC = 1 / C;
  const coarseAt = (src: Float32Array, x: number, y: number): number => {
    const fx = x * invC;
    const fy = y * invC;
    const cx = Math.floor(fx);
    const cy = Math.floor(fy);
    const tx = fx - cx;
    const ty = fy - cy;
    const r0 = cy * cw + cx;
    const a = src[r0];
    const b = src[r0 + 1];
    const c = src[r0 + cw];
    const d = src[r0 + cw + 1];
    const top = a + (b - a) * tx;
    return top + (c + (d - c) * tx - top) * ty;
  };
  // Bound of the displacement: tiles farther from the coast than this can't change.
  let ampSum = 0;
  let fineAmp = 0; // sum of the fine octaves' amplitudes (tiles)
  for (let k = 0, a = amp0; k < coarseOct + fineOct; k++, a *= GAIN) {
    ampSum += a;
    if (k >= coarseOct) fineAmp += a;
  }
  const fineStart = amp0 * powInt(GAIN, coarseOct);
  const fjordDepth = 0.045 * S * 3; // thirds of a tile
  const fjordFreq = 11;
  // The detail erodes convex coasts and fjords cut land away: a small outward bias keeps the land share.
  const bias = 0.1 * amp0 * 3;
  const band = Math.ceil(Math.max(ampSum * 1.65 * 1.4, fjordDepth / 3) * 3) + 3;
  const fineBand = fineAmp * 1.65 * 1.4 * 3 + 3;
  const distL = new Uint16Array(n);
  chamfer(land, 1, w, h, distL);
  const out = land.slice();
  for (let y = 0; y < h; y++) {
    const lat = Math.abs((y / (h - 1)) * 2 - 1);
    const cold = Math.max(0, Math.min(1, (lat - 0.58) / 0.2));
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const i = row + x;
      const sd = land[i] ? distW[i] - 1.5 : 1.5 - distL[i];
      if (sd > band || sd < -band) continue;
      let v = sd + coarseAt(cDisp, x, y) + bias;
      // Fine octaves only right at the coast.
      if (v < fineBand && v > -fineBand) {
        const u = x * invS;
        const vv = y * invS;
        let a = fineStart;
        let f = f0 * (1 << coarseOct);
        let s = 0;
        for (let k = 0; k < fineOct; k++) {
          s += a * nCoast(u * f + (coarseOct + k) * 31.7, vv * f + (coarseOct + k) * 17.3);
          a *= GAIN;
          f *= 2;
        }
        v += s * coarseAt(cMod, x, y) * 3;
      }
      // Fjords: land near a mountain or cold coast is cut along thin ridged-noise lines.
      if (v > 0 && v < fjordDepth) {
        const m = Math.max(Math.max(0, Math.min(1, (rugged[i] - 0.3) / 0.25)), cold);
        if (m > 0) {
          const r = 1 - Math.abs(nFjord(x * invS * fjordFreq, y * invS * fjordFreq));
          if (r > 0.93) v -= fjordDepth * m * Math.sqrt((r - 0.93) / 0.07) * 1.2;
        }
      }
      out[i] = v > 0 ? 1 : 0;
    }
  }
  // Straits stay open: new land (water pushed up) that would join two landmasses is turned back into water.
  const label = new Int32Array(n);
  const queue = new Int32Array(n);
  let comps = 0;
  for (let s0 = 0; s0 < n; s0++) {
    if (!land[s0] || label[s0]) continue;
    comps++;
    let head = 0;
    let tail = 0;
    queue[tail++] = s0;
    label[s0] = comps;
    while (head < tail) {
      const i = queue[head++];
      const x = i % w;
      if (x > 0 && land[i - 1] && !label[i - 1]) (label[i - 1] = comps), (queue[tail++] = i - 1);
      if (x < w - 1 && land[i + 1] && !label[i + 1]) (label[i + 1] = comps), (queue[tail++] = i + 1);
      if (i >= w && land[i - w] && !label[i - w]) (label[i - w] = comps), (queue[tail++] = i - w);
      if (i < n - w && land[i + w] && !label[i + w]) (label[i + w] = comps), (queue[tail++] = i + w);
    }
  }
  land.set(out);
  smoothMask(land, w, h, 1);
  // New-land clusters: label -1 once visited.
  const nbs = [0, 0, 0, 0];
  for (let s0 = 0; s0 < n; s0++) {
    if (!land[s0] || label[s0] !== 0) continue;
    let head = 0;
    let tail = 0;
    queue[tail++] = s0;
    label[s0] = -1;
    let first = 0;
    let joins = false;
    while (head < tail) {
      const i = queue[head++];
      const k = nb4(w, h, i, nbs);
      for (let q = 0; q < k; q++) {
        const j = nbs[q];
        if (!land[j]) continue;
        const l = label[j];
        if (l === 0) {
          label[j] = -1;
          queue[tail++] = j;
        } else if (l > 0) {
          if (first === 0) first = l;
          else if (l !== first) joins = true;
        }
      }
    }
    if (joins) for (let q = 0; q < tail; q++) land[queue[q]] = 0;
  }
}

/** Water tiles within `ring` 4-steps of land become ShallowWater (others stay DeepWater). */
function shallowBand(terrain: Uint8Array, land: Uint8Array, w: number, h: number, ring: number): void {
  const n = w * h;
  const queue: number[] = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (land[i]) continue;
      if ((x > 0 && land[i - 1]) || (x < w - 1 && land[i + 1]) || (y > 0 && land[i - w]) || (y < h - 1 && land[i + w])) {
        terrain[i] = T_SHALLOW;
        queue.push(i);
      }
    }
  }
  let head = 0;
  for (let d = 2; d <= ring; d++) {
    const end = queue.length;
    for (; head < end; head++) {
      const i = queue[head];
      const x = i % w;
      if (x > 0 && !land[i - 1] && terrain[i - 1] === T_DEEP) (terrain[i - 1] = T_SHALLOW), queue.push(i - 1);
      if (x < w - 1 && !land[i + 1] && terrain[i + 1] === T_DEEP) (terrain[i + 1] = T_SHALLOW), queue.push(i + 1);
      if (i >= w && !land[i - w] && terrain[i - w] === T_DEEP) (terrain[i - w] = T_SHALLOW), queue.push(i - w);
      if (i < n - w && !land[i + w] && terrain[i + w] === T_DEEP) (terrain[i + w] = T_SHALLOW), queue.push(i + w);
    }
  }
}

/** True when another range's core (rugged > 0.6) lies at distance d straight ahead or 30 degrees to either side. */
function rangeAhead(rugged: Float32Array, w: number, h: number, x: number, y: number, dx: number, dy: number, d: number): boolean {
  for (let k = -1; k <= 1; k++) {
    // rotate (dx, dy) by k * 30 degrees: cos 30 = 0.8660254, sin 30 = 0.5
    const c = k === 0 ? 1 : 0.8660254;
    const sn = k * 0.5;
    const px = Math.floor(x + (dx * c - dy * sn) * d);
    const py = Math.floor(y + (dy * c + dx * sn) * d);
    if (px >= 0 && py >= 0 && px < w && py < h && rugged[py * w + px] > 0.6) return true;
  }
  return false;
}

/** Raises rugged[] to a tent profile str * (1 - d / R) around (cx, cy). */
function stampRange(rugged: Float32Array, w: number, h: number, cx: number, cy: number, R: number, str: number): void {
  const x0 = Math.max(0, Math.floor(cx - R));
  const x1 = Math.min(w - 1, Math.ceil(cx + R));
  const y0 = Math.max(0, Math.floor(cy - R));
  const y1 = Math.min(h - 1, Math.ceil(cy + R));
  const R2s = R * R;
  const inv = 1 / R;
  for (let y = y0; y <= y1; y++) {
    const dy = y - cy;
    const row = y * w;
    for (let x = x0; x <= x1; x++) {
      const dx = x - cx;
      const d2 = dx * dx + dy * dy;
      if (d2 >= R2s) continue;
      const v = str * (1 - Math.sqrt(d2) * inv);
      if (v > rugged[row + x]) rugged[row + x] = v;
    }
  }
}

const TERRAIN_COUNT = 9; // terrain ids 0..8; land is 2..8

/** Land tiles with < 3 of 8 neighbours like them take the terrain most of their land neighbours have (>= 4). */
function majorityFilter(terrain: Uint8Array, land: Uint8Array, w: number, h: number, passes: number): void {
  const cnt = new Int32Array(TERRAIN_COUNT);
  const offs = [-w - 1, -w, -w + 1, -1, 1, w - 1, w, w + 1];
  for (let p = 0; p < passes; p++) {
    const src = terrain.slice();
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        if (!land[i]) continue;
        const t = src[i];
        if ((src[i - 1] === t ? 1 : 0) + (src[i + 1] === t ? 1 : 0) + (src[i - w] === t ? 1 : 0) + (src[i + w] === t ? 1 : 0) >= 3) continue;
        cnt.fill(0);
        for (let k = 0; k < 8; k++) {
          const j = i + offs[k];
          if (land[j]) cnt[src[j]]++;
        }
        if (cnt[t] >= 3) continue;
        let best = t;
        let bc = 3;
        for (let q = 2; q < TERRAIN_COUNT; q++) {
          if (q !== t && cnt[q] > bc) {
            bc = cnt[q];
            best = q;
          }
        }
        terrain[i] = best;
      }
    }
  }
}

/** 4-connected regions of one land terrain smaller than minSize take their most common neighbouring land terrain. */
function mergeSmallRegions(terrain: Uint8Array, land: Uint8Array, w: number, h: number, minSize: number): void {
  const n = w * h;
  const seen = new Uint8Array(n);
  const buf = new Int32Array(n);
  const cnt = new Int32Array(TERRAIN_COUNT);
  for (let s = 0; s < n; s++) {
    if (seen[s] || !land[s]) continue;
    const t = terrain[s];
    let head = 0;
    let tail = 0;
    buf[tail++] = s;
    seen[s] = 1;
    cnt.fill(0);
    while (head < tail) {
      const i = buf[head++];
      const x = i % w;
      const y = (i - x) / w;
      for (let k = 0; k < 4; k++) {
        let j: number;
        if (k === 0) {
          if (x === 0) continue;
          j = i - 1;
        } else if (k === 1) {
          if (x === w - 1) continue;
          j = i + 1;
        } else if (k === 2) {
          if (y === 0) continue;
          j = i - w;
        } else {
          if (y === h - 1) continue;
          j = i + w;
        }
        if (!land[j]) continue;
        const tj = terrain[j];
        if (tj === t) {
          if (!seen[j]) {
            seen[j] = 1;
            buf[tail++] = j;
          }
        } else cnt[tj]++;
      }
    }
    if (tail >= minSize) continue;
    let best = -1;
    let bc = 0;
    for (let q = 2; q < TERRAIN_COUNT; q++) {
      if (cnt[q] > bc) {
        bc = cnt[q];
        best = q;
      }
    }
    if (best < 0) continue; // an island of a single terrain: keep it
    for (let k = 0; k < tail; k++) terrain[buf[k]] = best;
  }
}

/** Land tiles that differ from >= 3 of their 4 neighbours take the most common 4-neighbour land terrain (if >= 2). */
function fixSpeckle(terrain: Uint8Array, land: Uint8Array, w: number, h: number, passes: number): void {
  const nb = [0, 0, 0, 0];
  for (let p = 0; p < passes; p++) {
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        if (!land[i]) continue;
        const t = terrain[i];
        nb[0] = terrain[i - 1];
        nb[1] = terrain[i + 1];
        nb[2] = terrain[i - w];
        nb[3] = terrain[i + w];
        if ((nb[0] === t ? 1 : 0) + (nb[1] === t ? 1 : 0) + (nb[2] === t ? 1 : 0) + (nb[3] === t ? 1 : 0) >= 2) continue;
        let best = -1;
        let bc = 1;
        for (let k = 0; k < 4; k++) {
          const q = nb[k];
          if (q <= 1 || q === t) continue;
          let cq = 0;
          for (let m = 0; m < 4; m++) if (nb[m] === q) cq++;
          if (cq > bc) {
            bc = cq;
            best = q;
          }
        }
        if (best >= 0) terrain[i] = best;
      }
    }
  }
}

/**
 * For each resource r, places about targets[r] tiles on tiles with kind[i] === r, as fields of 2-5 deposits of 3-12
 * tiles each. Fields are seeded on a grid of cells (each cell gets fields in proportion to its eligible tiles), so
 * every region with suitable terrain gets some.
 */
function placeResources(map: MapData, rng: () => number, kind: Uint8Array, targets: number[], S: number): void {
  const { width: w, height: h, resource } = map;
  const K = targets.length;
  const g = Math.max(20, Math.round(S / 16));
  const fieldR = Math.max(4, Math.round(S * 0.012));
  const gw = Math.ceil(w / g);
  const gh = Math.ceil(h / g);
  const cells = gw * gh;
  // eligible tiles grouped by (kind, cell) with a counting sort: bucket b = kind * cells + cell
  const cellOf = new Int32Array(w);
  for (let x = 0; x < w; x++) cellOf[x] = Math.floor(x / g);
  const start = new Int32Array(K * cells + 1);
  for (let y = 0; y < h; y++) {
    const gy = Math.floor(y / g) * gw;
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const k = kind[row + x];
      if (k !== 0) start[k * cells + gy + cellOf[x] + 1]++;
    }
  }
  for (let b = 0; b < K * cells; b++) start[b + 1] += start[b];
  const fill = start.slice(0, K * cells);
  const list = new Int32Array(start[K * cells]);
  for (let y = 0; y < h; y++) {
    const gy = Math.floor(y / g) * gw;
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const k = kind[row + x];
      if (k !== 0) list[fill[k * cells + gy + cellOf[x]]++] = row + x;
    }
  }
  const nb: number[] = [];
  const cluster: number[] = [];
  for (let res = 1; res < K; res++) {
    const target = targets[res];
    const total = start[(res + 1) * cells] - start[res * cells];
    if (target <= 0 || total === 0) continue;
    const density = Math.max(1, Math.round(target / (7.5 * 3.5))) / total;
    let placed = 0;
    const deposit = (seed: number): void => {
      if (resource[seed] !== 0 || kind[seed] !== res) return;
      const size = Math.min(target - placed, 3 + rint(rng, 10));
      cluster.length = 0;
      cluster.push(seed);
      resource[seed] = res;
      placed++;
      for (let grow = 0; cluster.length < size && grow < size * 8; grow++) {
        const from = cluster[rint(rng, cluster.length)];
        const m = nb4(w, h, from, nb);
        const j = nb[rint(rng, m)];
        if (resource[j] !== 0 || kind[j] !== res) continue;
        resource[j] = res;
        cluster.push(j);
        placed++;
      }
    };
    for (let c = 0; c < cells; c++) {
      const b = res * cells + c;
      const cc = start[b + 1] - start[b];
      if (cc === 0) continue;
      const fields = Math.floor(cc * density + rng());
      for (let q = 0; q < fields && placed < target; q++) {
        const centre = list[start[b] + rint(rng, cc)];
        deposit(centre);
        const cx = centre % w;
        const cy = (centre - cx) / w;
        const more = 1 + rint(rng, 4);
        for (let d = 0; d < more && placed < target; d++) {
          for (let t = 0; t < 12; t++) {
            const x = cx + rint(rng, 2 * fieldR + 1) - fieldR;
            const y = cy + rint(rng, 2 * fieldR + 1) - fieldR;
            if (x < 0 || y < 0 || x >= w || y >= h) continue;
            const i = y * w + x;
            if (kind[i] !== res || resource[i] !== 0) continue;
            deposit(i);
            break;
          }
        }
      }
    }
  }
}
