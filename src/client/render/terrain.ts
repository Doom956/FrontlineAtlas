// Terrain data for the map layers, built once per game: calm flat colours (far zoom, minimap, Canvas2D fallback),
// water depth (distance to land) and deposit clusters.
import { isWater } from '../../sim/types';
import type { MapData } from '../../sim/types';
import type { RGB } from './common';

/**
 * One calm, distinct colour per terrain (index = TerrainId). Water: deep, shallow. Chosen so the terrains stay
 * apart at a glance (plains light green, forest dark green, hills khaki, mountains grey, desert sand, swamp olive,
 * tundra pale grey-blue) without shouting over the nation colours.
 */
export const TERRAIN_RGB: readonly RGB[] = [
  [23, 38, 52], // deep water: open sea, slate close to the UI ink so the land carries the picture
  [38, 74, 91], // shallow water: the coastal shelf, a lighter steel blue (3:1 against a blue nation's fill)
  [146, 162, 120], // plains
  [100, 124, 92], // forest
  [160, 152, 124], // hills
  [138, 138, 136], // mountains
  [204, 192, 156], // desert
  [108, 118, 96], // swamp
  [208, 214, 218], // tundra
];

// ---- Water depth: one slate ramp, OKLCH lightness 0.39 (shelf) / 0.34 (middle) / 0.26 (open sea), hue 230 to 246
// (bluer further out), faded smoothly, so a blue nation (lighter and more saturated) never blends into the sea.
/** Middle of the fade between the shelf (TERRAIN_RGB[1]) and the open sea (TERRAIN_RGB[0]). */
export const WATER_MID: RGB = [32, 59, 76];
/** Depth (tiles) where the smooth fade reaches the open sea colour. */
export const WATER_FADE_END = 14;

function mixRgb(a: RGB, b: RGB, k: number): RGB {
  return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
}

/** Flat water colour at `d` whole tiles from land (minimap, Canvas2D map, the far-zoom texture); the shader fades the same way. */
export function waterRGB(d: number): RGB {
  const k = Math.min(1, Math.max(0, (d - 1) / (WATER_FADE_END - 1)));
  const s = k * k * (3 - 2 * k);
  return s < 0.5 ? mixRgb(TERRAIN_RGB[1], WATER_MID, s * 2) : mixRgb(WATER_MID, TERRAIN_RGB[0], s * 2 - 1);
}

/** Deposit colours (marker fills and the resource overlay). Index = ResourceId. */
export const RESOURCE_RGB: readonly RGB[] = [
  [0, 0, 0],
  [150, 146, 140], // iron: grey ore
  [22, 22, 26], // oil: black
  [232, 188, 64], // fertile: golden wheat
];
/** Water tiles further than this from land all count as fully deep. */
export const MAX_DEPTH = 24;

export interface TerrainData {
  /** distance of water tiles to the nearest land tile (1..MAX_DEPTH), 0 on land */
  depth: Uint8Array;
  /** RGBA flat colours, water shaded by depth, light sand on the coast */
  rgba: Uint8ClampedArray;
}

export function buildTerrain(map: MapData): TerrainData {
  const { width: w, height: h, terrain } = map;
  const n = w * h;
  const depth = new Uint8Array(n).fill(255);
  const queue = new Int32Array(n);
  let qh = 0;
  let qt = 0;
  for (let i = 0; i < n; i++) {
    if (!isWater(terrain[i])) {
      depth[i] = 0;
      queue[qt++] = i;
    }
  }
  while (qh < qt) {
    const i = queue[qh++];
    const d = depth[i] + 1;
    if (d > MAX_DEPTH) continue;
    const x = i % w;
    if (x > 0 && depth[i - 1] > d) { depth[i - 1] = d; queue[qt++] = i - 1; }
    if (x < w - 1 && depth[i + 1] > d) { depth[i + 1] = d; queue[qt++] = i + 1; }
    if (i >= w && depth[i - w] > d) { depth[i - w] = d; queue[qt++] = i - w; }
    if (i + w < n && depth[i + w] > d) { depth[i + w] = d; queue[qt++] = i + w; }
  }
  for (let i = 0; i < n; i++) if (depth[i] > MAX_DEPTH) depth[i] = MAX_DEPTH;

  const rgba = new Uint8ClampedArray(n * 4);
  const ramp: RGB[] = [];
  for (let d = 0; d <= MAX_DEPTH; d++) ramp.push(waterRGB(d));
  for (let i = 0; i < n; i++) {
    const t = terrain[i];
    const o = i * 4;
    if (isWater(t)) {
      const c = ramp[depth[i]];
      let r = c[0];
      let g = c[1];
      let b = c[2];
      if (depth[i] === 1) {
        // a quiet shoreline, so the coast reads at every zoom
        r += 5;
        g += 8;
        b += 9;
      }
      rgba[o] = r;
      rgba[o + 1] = g;
      rgba[o + 2] = b;
    } else {
      const c = TERRAIN_RGB[t] ?? TERRAIN_RGB[2];
      rgba[o] = c[0];
      rgba[o + 1] = c[1];
      rgba[o + 2] = c[2];
    }
    rgba[o + 3] = 255;
  }
  return { depth, rgba };
}

/** A group of deposit tiles of one resource: marker position (tile coords of the centre) and size. */
export interface DepositCluster {
  res: number;
  x: number;
  y: number;
  tiles: number;
  /** a tile of the cluster closest to its centre (for ownership checks) */
  tile: number;
}

/**
 * Deposit clusters: 8-connected tiles of the same resource (`near`), and fields of nearby clusters merged on a
 * `fieldCell`-tile grid (`far`, one marker per field when zoomed out).
 */
export function buildDeposits(map: MapData, fieldCell = 12): { near: DepositCluster[]; far: DepositCluster[] } {
  const { width: w, height: h, resource } = map;
  const n = w * h;
  const seen = new Uint8Array(n);
  const stack: number[] = [];
  const near: DepositCluster[] = [];
  for (let s = 0; s < n; s++) {
    const res = resource[s];
    if (res === 0 || seen[s]) continue;
    seen[s] = 1;
    stack.length = 0;
    stack.push(s);
    let sx = 0;
    let sy = 0;
    let count = 0;
    const members: number[] = [];
    while (stack.length) {
      const i = stack.pop()!;
      const x = i % w;
      const y = (i / w) | 0;
      sx += x;
      sy += y;
      count++;
      members.push(i);
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w || (dx === 0 && dy === 0)) continue;
          const j = yy * w + xx;
          if (seen[j] || resource[j] !== res) continue;
          seen[j] = 1;
          stack.push(j);
        }
      }
    }
    const cx = sx / count + 0.5;
    const cy = sy / count + 0.5;
    let best = members[0];
    let bd = Infinity;
    for (const i of members) {
      const dx = (i % w) + 0.5 - cx;
      const dy = ((i / w) | 0) + 0.5 - cy;
      const d = dx * dx + dy * dy;
      if (d < bd) {
        bd = d;
        best = i;
      }
    }
    near.push({ res, x: cx, y: cy, tiles: count, tile: best });
  }
  // Fields: clusters of the same resource in one grid cell, weighted by size.
  const fields = new Map<number, { res: number; sx: number; sy: number; tiles: number; tile: number; big: number }>();
  const gw = Math.ceil(w / fieldCell);
  for (const c of near) {
    const key = (Math.floor(c.y / fieldCell) * gw + Math.floor(c.x / fieldCell)) * 4 + c.res;
    const f = fields.get(key);
    if (!f) fields.set(key, { res: c.res, sx: c.x * c.tiles, sy: c.y * c.tiles, tiles: c.tiles, tile: c.tile, big: c.tiles });
    else {
      f.sx += c.x * c.tiles;
      f.sy += c.y * c.tiles;
      f.tiles += c.tiles;
      if (c.tiles > f.big) {
        f.big = c.tiles;
        f.tile = c.tile;
      }
    }
  }
  const far: DepositCluster[] = [];
  for (const f of fields.values()) far.push({ res: f.res, x: f.sx / f.tiles, y: f.sy / f.tiles, tiles: f.tiles, tile: f.tile });
  return { near, far };
}
