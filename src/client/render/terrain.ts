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
  [26, 50, 84], // deep water
  [44, 88, 128], // shallow water
  [138, 170, 98], // plains
  [70, 114, 64], // forest
  [160, 150, 102], // hills
  [134, 130, 126], // mountains
  [224, 204, 146], // desert
  [94, 110, 78], // swamp
  [208, 216, 216], // tundra
];
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
  const shallow = TERRAIN_RGB[1];
  const deep = TERRAIN_RGB[0];
  for (let i = 0; i < n; i++) {
    const t = terrain[i];
    const o = i * 4;
    if (isWater(t)) {
      const d = depth[i];
      const k = Math.min(1, (d - 1) / 10);
      const s = k * k * (3 - 2 * k);
      let r = shallow[0] + (deep[0] - shallow[0]) * s;
      let g = shallow[1] + (deep[1] - shallow[1]) * s;
      let b = shallow[2] + (deep[2] - shallow[2]) * s;
      if (d === 1) {
        r += 14;
        g += 18;
        b += 18;
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
