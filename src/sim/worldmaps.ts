// Real-world maps (an alternative to the procedural generator in mapgen.ts). The maps are baked by
// scripts/maps/build.ts from Natural Earth data (see docs/MAPS.md) into compact gzip-compressed blobs that live in
// src/maps/data/*.ts as base64 strings; this module lists them and turns one into MapData exactly like the generator
// would hand it to createGame (terrain + resources set, coastal / landTileCount from computeCoastAndLand, nothing
// owned or built).
//
// Blob layout (after gunzip), little endian:
//   'BFM1' | u16 width | u16 height | u32 landTiles | u32 terrain section bytes | terrain RLE | resource RLE
// RLE = repeated (u8 value, varint run - 1) over the whole width * height array, row by row.
import { WORLD_MAP_DATA, WORLD_MAPS } from '../maps/manifest';
import { computeCoastAndLand, createMapData } from './mapgen';
import type { MapData } from './types';

export interface WorldMapSpawn {
  /** nation name (a real country or region) */
  name: string;
  /** tile index (y * width + x) of its capital; always land, unique per map */
  tile: number;
}

/** Nation / tribe counts for a game on one map. */
export interface WorldMapPreset {
  /** nations on the map: in multiplayer the human players count, so aiCount = nations - humans */
  nations: number;
  /** tribeCount */
  tribes: number;
}

export interface WorldMapPresets {
  /** a few nations and many tribes to conquer (quick games) */
  singlePlayer: WorldMapPreset;
  /** about ten nations (players + AI), fewer tribes */
  multiplayer: WorldMapPreset;
}

export interface WorldMapInfo {
  id: string;
  name: string;
  description: string;
  width: number;
  height: number;
  landTiles: number;
  /** suggested AI nations (aiCount) for a quick single-player game (same as presets.singlePlayer.nations) */
  recommendedNations: number;
  /** suggested tribes (tribeCount) for a quick single-player game (same as presets.singlePlayer.tribes) */
  recommendedTribes: number;
  /** nation / tribe counts for single player and multiplayer */
  presets: WorldMapPresets;
  /**
   * Real countries / regions at their capitals (18-40 per map), in spread-out order: the first is the most populous,
   * each next one the farthest from all before it, so nations taking the first N spawns are spread over the map.
   */
  spawns: WorldMapSpawn[];
}

export const BFM_MAGIC = 'BFM1';

/** All real-world maps, in menu order. */
export function listWorldMaps(): readonly WorldMapInfo[] {
  return WORLD_MAPS;
}

export function getWorldMap(id: string): WorldMapInfo | undefined {
  return WORLD_MAPS.find((m) => m.id === id);
}

export function isWorldMapId(id: string): boolean {
  return getWorldMap(id) !== undefined;
}

/** Nation spawns of a map: name + capital tile. Empty for an unknown id. */
export function worldMapSpawns(id: string): WorldMapSpawn[] {
  const m = getWorldMap(id);
  return m ? m.spawns.map((s) => ({ name: s.name, tile: s.tile })) : [];
}

interface Decoded {
  width: number;
  height: number;
  landTiles: number;
  terrain: Uint8Array;
  resource: Uint8Array;
}

const cache = new Map<string, Promise<Decoded>>();

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function gunzip(data: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream === 'undefined') throw new Error('worldmaps: DecompressionStream is not available');
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Decodes one RLE section into out; returns the offset after it. */
function decodeRle(src: Uint8Array, pos: number, end: number, out: Uint8Array): number {
  let o = 0;
  while (pos < end && o < out.length) {
    const v = src[pos++];
    let run = 0;
    let shift = 0;
    for (;;) {
      const b = src[pos++];
      run += (b & 0x7f) * 2 ** shift;
      if (b < 0x80) break;
      shift += 7;
    }
    run += 1;
    out.fill(v, o, o + run);
    o += run;
  }
  if (o !== out.length) throw new Error('worldmaps: corrupt map data');
  return pos;
}

/** Decodes a gunzipped map blob (exported for tests and tools). */
export function decodeWorldMapBlob(raw: Uint8Array): Decoded {
  const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const magic = String.fromCharCode(raw[0], raw[1], raw[2], raw[3]);
  if (magic !== BFM_MAGIC) throw new Error('worldmaps: bad map data');
  const width = dv.getUint16(4, true);
  const height = dv.getUint16(6, true);
  const landTiles = dv.getUint32(8, true);
  const tLen = dv.getUint32(12, true);
  const terrain = new Uint8Array(width * height);
  const resource = new Uint8Array(width * height);
  decodeRle(raw, 16, 16 + tLen, terrain);
  decodeRle(raw, 16 + tLen, raw.length, resource);
  return { width, height, landTiles, terrain, resource };
}

function decoded(id: string): Promise<Decoded> {
  let p = cache.get(id);
  if (!p) {
    const load = WORLD_MAP_DATA[id];
    if (!load) return Promise.reject(new Error(`worldmaps: unknown map '${id}'`));
    p = load().then(async (mod) => decodeWorldMapBlob(await gunzip(base64ToBytes(mod.default))));
    p.catch(() => cache.delete(id));
    cache.set(id, p);
  }
  return p;
}

/**
 * Loads a real-world map as a fresh MapData (nothing owned, no buildings, coastal + landTileCount computed). The
 * decoded tiles are cached, so loading the same map again is quick; every call returns new arrays. Deterministic.
 */
export async function loadWorldMap(id: string): Promise<MapData> {
  const d = await decoded(id);
  const map = createMapData(d.width, d.height);
  map.terrain.set(d.terrain);
  map.resource.set(d.resource);
  computeCoastAndLand(map);
  if (map.landTileCount !== d.landTiles) throw new Error(`worldmaps: land count mismatch on '${id}'`);
  return map;
}

/**
 * Compact version of a loaded map (the 'compact map' modifier): half the width and height, so a quarter of the land.
 * Each new tile looks at a 2 x 2 block: land if at least two of the four are land (the most common land terrain,
 * ties to the first in reading order), else water (deep if any is deep); its resource is the first one on a land
 * tile of the block. Deterministic; returns a new MapData with coastal / landTileCount computed.
 */
export function compactWorldMap(src: MapData): MapData {
  const w = Math.max(1, Math.floor(src.width / 2));
  const h = Math.max(1, Math.floor(src.height / 2));
  const map = createMapData(w, h);
  const sw = src.width;
  const counts = new Uint8Array(16);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i0 = 2 * y * sw + 2 * x;
      const block = [i0, i0 + 1, i0 + sw, i0 + sw + 1];
      counts.fill(0);
      let land = 0;
      let deep = false;
      let res = 0;
      for (const i of block) {
        const t = src.terrain[i];
        if (t <= 1) {
          if (t === 0) deep = true;
          continue;
        }
        land++;
        counts[t]++;
        if (!res && src.resource[i]) res = src.resource[i];
      }
      const o = y * w + x;
      if (land >= 2) {
        let best = 0;
        for (const i of block) {
          const t = src.terrain[i];
          if (t > 1 && (best === 0 || counts[t] > counts[best])) best = t;
        }
        map.terrain[o] = best;
        map.resource[o] = res;
      } else {
        map.terrain[o] = deep ? 0 : 1;
      }
    }
  }
  computeCoastAndLand(map);
  return map;
}

/** Where a tile of the full map lands on its compact version (compactWorldMap). */
export function compactWorldTile(full: MapData, compact: MapData, tile: number): number {
  const x = Math.min(compact.width - 1, Math.floor((tile % full.width) / 2));
  const y = Math.min(compact.height - 1, Math.floor(Math.floor(tile / full.width) / 2));
  return y * compact.width + x;
}
