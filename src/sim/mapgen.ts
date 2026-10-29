// Procedural map generation: terrain + resources from seeded fractal value noise.
//
// Pipeline: elevation (fractal noise + landmass blobs - edge falloff) -> sea level chosen as the quantile that gives
// the map type's land share -> shallow-water ring along coasts -> land split into mountains / hills (by a
// "ruggedness" rank) and biomes (latitude temperature + moisture rank) -> clustered resources.
import { MAP_SIZES } from './config';
import { distanceField, neighbors4 } from './grid';
import { randInt } from './rng';
import { Resource, Terrain, isWater } from './types';
import type { GameSettings, MapData, MapType } from './types';

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
      if (isWater(terrain[i])) {
        coastal[i] = 0;
        continue;
      }
      land++;
      coastal[i] =
        (x > 0 && isWater(terrain[i - 1])) ||
        (x < w - 1 && isWater(terrain[i + 1])) ||
        (y > 0 && isWater(terrain[i - w])) ||
        (y < h - 1 && isWater(terrain[i + w]))
          ? 1
          : 0;
    }
  }
  map.landTileCount = land;
}

// ---------- noise ----------

type Noise2 = (x: number, y: number) => number;

/** Seeded 2D value noise on a 256-periodic lattice, smoothstep-interpolated, output 0..1. */
function makeValueNoise(rng: () => number): Noise2 {
  const perm = new Uint8Array(512);
  for (let i = 0; i < 256; i++) perm[i] = i;
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const t = perm[i];
    perm[i] = perm[j];
    perm[j] = t;
  }
  for (let i = 0; i < 256; i++) perm[i + 256] = perm[i];
  const vals = new Float32Array(256);
  for (let i = 0; i < 256; i++) vals[i] = rng();
  const ox = rng() * 256;
  const oy = rng() * 256;
  return (x: number, y: number): number => {
    x += ox;
    y += oy;
    const xf = Math.floor(x);
    const yf = Math.floor(y);
    const fx = x - xf;
    const fy = y - yf;
    const u = fx * fx * (3 - 2 * fx);
    const v = fy * fy * (3 - 2 * fy);
    const X = xf & 255;
    const Y = yf & 255;
    const X1 = (X + 1) & 255;
    const Y1 = (Y + 1) & 255;
    const a = vals[perm[perm[X] + Y]];
    const b = vals[perm[perm[X1] + Y]];
    const c = vals[perm[perm[X] + Y1]];
    const d = vals[perm[perm[X1] + Y1]];
    const top = a + (b - a) * u;
    const bot = c + (d - c) * u;
    return top + (bot - top) * v;
  };
}

/** Fractal sum of octaves, normalised to 0..1. */
function fbm(noise: Noise2, x: number, y: number, freq: number, octaves: number): number {
  let sum = 0;
  let amp = 1;
  let norm = 0;
  let f = freq;
  for (let o = 0; o < octaves; o++) {
    sum += amp * noise(x * f + o * 31.7, y * f + o * 17.3);
    norm += amp;
    amp *= 0.5;
    f *= 2;
  }
  return sum / norm;
}

/** Value v such that `share` of the values in arr (optionally only where mask) are >= v. */
function quantileAbove(arr: Float32Array, share: number, mask?: (i: number) => boolean): number {
  let min = Infinity;
  let max = -Infinity;
  let count = 0;
  for (let i = 0; i < arr.length; i++) {
    if (mask && !mask(i)) continue;
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
    if (mask && !mask(i)) continue;
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

/** Rank (0..1) of each masked value among the masked values, via a histogram. Unmasked entries get 0. */
function rankField(arr: Float32Array, mask: (i: number) => boolean): Float32Array {
  const out = new Float32Array(arr.length);
  let min = Infinity;
  let max = -Infinity;
  let count = 0;
  for (let i = 0; i < arr.length; i++) {
    if (!mask(i)) continue;
    if (arr[i] < min) min = arr[i];
    if (arr[i] > max) max = arr[i];
    count++;
  }
  if (count === 0 || max <= min) return out;
  const BINS = 4096;
  const hist = new Uint32Array(BINS);
  const scale = (BINS - 1) / (max - min);
  for (let i = 0; i < arr.length; i++) if (mask(i)) hist[Math.floor((arr[i] - min) * scale)]++;
  // cumulative share below the middle of each bin
  const cdf = new Float32Array(BINS);
  let acc = 0;
  for (let b = 0; b < BINS; b++) {
    cdf[b] = (acc + hist[b] / 2) / count;
    acc += hist[b];
  }
  for (let i = 0; i < arr.length; i++) if (mask(i)) out[i] = cdf[Math.floor((arr[i] - min) * scale)];
  return out;
}

// ---------- map type parameters ----------

interface TypeParams {
  landShare: number;
  /** blob count range [min, max] and blob radius as a share of the smaller map side */
  blobs: [number, number];
  blobRadius: number;
  blobWeight: number;
  /** how far blob outlines are pushed around by noise (share of the smaller map side) */
  warp: number;
  /** how strongly the area between two landmasses is pushed under water (0 = they may merge) */
  separation: number;
  noiseFreq: number; // base frequency in cycles per smaller map side
  noiseWeight: number;
  mountainShare: number; // of land
  hillShare: number; // of land
}

const TYPE_PARAMS: Record<MapType, TypeParams> = {
  continents: { landShare: 0.45, blobs: [2, 5], blobRadius: 0.2, blobWeight: 0.9, warp: 0.45, separation: 0.8, noiseFreq: 4, noiseWeight: 0.6, mountainShare: 0.06, hillShare: 0.12 },
  pangaea: { landShare: 0.6, blobs: [1, 1], blobRadius: 0.4, blobWeight: 0.9, warp: 0.4, separation: 0, noiseFreq: 3.5, noiseWeight: 0.6, mountainShare: 0.06, hillShare: 0.12 },
  archipelago: { landShare: 0.3, blobs: [14, 26], blobRadius: 0.07, blobWeight: 0.6, warp: 0.25, separation: 0.5, noiseFreq: 7, noiseWeight: 0.65, mountainShare: 0.04, hillShare: 0.1 },
  highlands: { landShare: 0.55, blobs: [2, 3], blobRadius: 0.3, blobWeight: 0.5, warp: 0.4, separation: 0, noiseFreq: 3, noiseWeight: 0.75, mountainShare: 0.15, hillShare: 0.27 },
};

const SHALLOW_RING = 2; // water tiles within this many steps of land are shallow
const FERTILE_WATER_DIST = 5; // plains within this many steps of water can be Fertile

export function generateMap(settings: GameSettings, rng: () => number): MapData {
  const size = MAP_SIZES[settings.mapSize] ?? MAP_SIZES.medium;
  const w = size.width;
  const h = size.height;
  const n = w * h;
  const params = TYPE_PARAMS[settings.mapType] ?? TYPE_PARAMS.continents;
  const map = createMapData(w, h);
  const S = Math.min(w, h);

  const elevNoise = makeValueNoise(rng);
  const ridgeNoise = makeValueNoise(rng);
  const moistNoise = makeValueNoise(rng);
  const tempNoise = makeValueNoise(rng);
  const warpX = makeValueNoise(rng);
  const warpY = makeValueNoise(rng);

  // Landmass centres, spread apart (rejection sampling with a shrinking minimum distance).
  const blobCount = params.blobs[0] + randInt(rng, params.blobs[1] - params.blobs[0] + 1);
  const blobs: { x: number; y: number; r: number }[] = [];
  const margin = 0.15;
  let minSep = blobCount === 1 ? 0 : Math.sqrt((w * h) / blobCount) * 0.7;
  for (let k = 0; k < blobCount; k++) {
    for (let tries = 0; ; tries++) {
      let x: number;
      let y: number;
      if (blobCount === 1) {
        x = w * (0.4 + rng() * 0.2);
        y = h * (0.4 + rng() * 0.2);
      } else {
        x = w * (margin + rng() * (1 - 2 * margin));
        y = h * (margin + rng() * (1 - 2 * margin));
      }
      const ok = blobs.every((b) => (b.x - x) ** 2 + (b.y - y) ** 2 >= minSep * minSep);
      if (ok || tries > 40) {
        blobs.push({ x, y, r: S * params.blobRadius * (0.75 + rng() * 0.5) });
        break;
      }
      if (tries % 10 === 9) minSep *= 0.85;
    }
  }

  // Elevation.
  const elev = new Float32Array(n);
  const freq = params.noiseFreq / S;
  const edgeMargin = S * 0.08;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      // Domain warp so landmasses get ragged outlines instead of circles.
      const wx = x + (fbm(warpX, x, y, freq * 0.8, 3) - 0.5) * S * params.warp;
      const wy = y + (fbm(warpY, x, y, freq * 0.8, 3) - 0.5) * S * params.warp;
      // Strongest and second strongest blob: tiles between two landmasses are pushed down (keeps them apart).
      let b1 = 0;
      let b2 = 0;
      for (const b of blobs) {
        const d2 = (wx - b.x) ** 2 + (wy - b.y) ** 2;
        const v = Math.exp(-d2 / (2 * b.r * b.r));
        if (v > b1) {
          b2 = b1;
          b1 = v;
        } else if (v > b2) b2 = v;
      }
      const blob = b1 - params.separation * b2;
      let e = params.noiseWeight * fbm(elevNoise, x, y, freq, 6) + params.blobWeight * blob;
      const edge = Math.min(x, y, w - 1 - x, h - 1 - y);
      if (edge < edgeMargin) {
        const t = 1 - edge / edgeMargin;
        e -= t * t * 1.2;
      }
      elev[y * w + x] = e;
    }
  }

  // Sea level: enough land for every nation (>= ~400 tiles each), else the map type's share.
  const players = settings.aiCount + (settings.humanPlayer ? 1 : 0);
  const landShare = Math.min(0.85, Math.max(params.landShare, (players * 400) / n));
  const sea = quantileAbove(elev, landShare);
  const terrain = map.terrain;
  for (let i = 0; i < n; i++) terrain[i] = elev[i] >= sea ? Terrain.Plains : Terrain.DeepWater;

  // Shallow ring along coasts.
  const isLand = (i: number): boolean => !isWater(terrain[i]);
  const landSources: number[] = [];
  const waterSources: number[] = [];
  for (let i = 0; i < n; i++) (isLand(i) ? landSources : waterSources).push(i);
  const distToLand = distanceField(map, landSources, (i) => !isLand(i), SHALLOW_RING);
  for (let i = 0; i < n; i++) if (!isLand(i) && distToLand[i] <= SHALLOW_RING) terrain[i] = Terrain.ShallowWater;
  const distToWater = distanceField(map, waterSources, isLand, FERTILE_WATER_DIST);

  // Ruggedness: elevation above sea + ridged noise; ranked among land tiles.
  const rugged = new Float32Array(n);
  const moist = new Float32Array(n);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!isLand(i)) continue;
      const ridge = 1 - Math.abs(2 * fbm(ridgeNoise, x, y, freq * 1.5, 4) - 1);
      rugged[i] = (elev[i] - sea) * 0.7 + ridge * 0.8;
      moist[i] = fbm(moistNoise, x, y, freq * 1.3, 4);
    }
  }
  const ruggedRank = rankField(rugged, isLand);
  const moistRank = rankField(moist, isLand);
  const mountainAt = 1 - params.mountainShare;
  const hillAt = 1 - params.mountainShare - params.hillShare;

  for (let y = 0; y < h; y++) {
    const lat = Math.abs((y / (h - 1)) * 2 - 1); // 0 at equator, 1 at the poles
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!isLand(i)) continue;
      const r = ruggedRank[i];
      if (r >= mountainAt) {
        terrain[i] = Terrain.Mountains;
        continue;
      }
      const temp = 1 - lat + (tempNoise(x * freq * 2, y * freq * 2) - 0.5) * 0.3 - r * 0.15;
      if (r >= hillAt) {
        terrain[i] = Terrain.Hills;
        continue;
      }
      const m = moistRank[i];
      if (temp < 0.22) terrain[i] = Terrain.Tundra;
      else if (m < 0.15 && temp > 0.45) terrain[i] = Terrain.Desert;
      else if (m > 0.9 && temp > 0.35 && r < 0.5) terrain[i] = Terrain.Swamp;
      else if (m > 0.55) terrain[i] = Terrain.Forest;
      else terrain[i] = Terrain.Plains;
    }
  }

  computeCoastAndLand(map);

  // Resources in clusters.
  const land = map.landTileCount;
  const t = terrain;
  placeClusters(map, rng, Resource.Iron, Math.round(land * 0.015), (i) => t[i] === Terrain.Hills || t[i] === Terrain.Mountains);
  placeClusters(map, rng, Resource.Oil, Math.round(land * 0.01), (i) => t[i] === Terrain.Desert || t[i] === Terrain.Swamp || t[i] === Terrain.Tundra);
  placeClusters(map, rng, Resource.Fertile, Math.round(land * 0.03), (i) => t[i] === Terrain.Plains && distToWater[i] <= FERTILE_WATER_DIST);

  return map;
}

/** Places about `target` tiles of resource `res` in clusters of 3-9 tiles on tiles where eligible(i). */
function placeClusters(map: MapData, rng: () => number, res: number, target: number, eligible: (i: number) => boolean): void {
  const n = map.width * map.height;
  const candidates: number[] = [];
  for (let i = 0; i < n; i++) if (eligible(i)) candidates.push(i);
  if (candidates.length === 0 || target <= 0) return;
  const resource = map.resource;
  const nb: number[] = [];
  let placed = 0;
  for (let attempts = 0; placed < target && attempts < target * 10 + 50; attempts++) {
    const seed = candidates[randInt(rng, candidates.length)];
    if (resource[seed] !== 0) continue;
    const size = Math.min(target - placed, 3 + randInt(rng, 7));
    const cluster = [seed];
    resource[seed] = res;
    placed++;
    for (let grow = 0; cluster.length < size && grow < size * 6; grow++) {
      const from = cluster[randInt(rng, cluster.length)];
      const k = neighbors4(map, from, nb);
      const j = nb[randInt(rng, k)];
      if (resource[j] !== 0 || !eligible(j)) continue;
      resource[j] = res;
      cluster.push(j);
      placed++;
    }
  }
}
