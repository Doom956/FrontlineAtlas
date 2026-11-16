// Map colour themes (client only): a world map may name a theme (`theme` in its manifest entry, scripts/maps/defs.ts)
// to be drawn in its own colours instead of the realistic default. A theme overrides some of the ground ramps of the
// pixel styles (render/ground.ts GROUND, baked into the shaders) and the flat terrain colours (the classic style, the
// minimap, the far texture and the map picker's thumbnails). Anything it leaves out keeps the default.
//
// Looks only: a theme never reaches the sim, hashState or multiplayer messages. The terrain and what it does in the
// game are the same in every theme.
import { TERRAIN } from '../../sim/config';
import type { MapChoice } from '../../sim/types';
import { getWorldMap } from '../../sim/worldmaps';
import type { RGB } from './common';
import { GROUND, type GroundRamp } from './ground';
import { TERRAIN_RGB, WATER_MID } from './terrain';

/** The ground ramps of the pixel styles (the shape of render/ground.ts GROUND). */
export interface GroundPalette {
  grass: GroundRamp;
  grassDry: GroundRamp;
  grassLush: GroundRamp;
  forest: GroundRamp;
  hills: GroundRamp;
  rock: GroundRamp;
  snow: GroundRamp;
  sand: GroundRamp;
  swamp: GroundRamp;
  tundra: GroundRamp;
  wheat: GroundRamp;
  crop: GroundRamp;
  soil: GroundRamp;
  pool: GroundRamp;
  /** sea bands from the shore out: shallows, shelf, middle, deep, open sea */
  sea: readonly RGB[];
  foam: GroundRamp;
}

export interface MapTheme {
  id: string;
  ground: GroundPalette;
  /** flat colour per TerrainId (classic style, minimap, far texture); [0] open sea, [1] shelf */
  flat: readonly RGB[];
  /** the middle of the flat water fade between the shelf and the open sea */
  waterMid: RGB;
  /** map picker thumbnails, per TerrainId */
  thumb: readonly RGB[];
}

/** A theme as written below: only what differs from the default. Flat colours by TerrainId (holes keep the default). */
export interface MapThemeDef {
  ground?: Partial<GroundPalette>;
  flat?: readonly (RGB | undefined)[];
  waterMid?: RGB;
  /** thumbnail colours; when left out a theme's thumbnails use its flat colours */
  thumb?: readonly (RGB | undefined)[];
}

/** Today's palette, unchanged: the maps without a theme. */
export const DEFAULT_THEME: MapTheme = {
  id: 'default',
  ground: GROUND,
  flat: TERRAIN_RGB,
  waterMid: WATER_MID,
  thumb: Object.values(TERRAIN).map((t) => t.color),
};

export const hx = (h: string): RGB => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
export const ramp = (a: string, b: string, c: string, d: string): GroundRamp => [hx(a), hx(b), hx(c), hx(d)];

/** The named themes (ids are what a map's `theme` says). */
export const THEME_DEFS: Record<string, MapThemeDef> = {};

const made = new Map<string, MapTheme>();

/** Default colours with a theme's overrides laid over them. */
export function makeTheme(id: string, def: MapThemeDef): MapTheme {
  const over = <T>(base: readonly T[], o: readonly (T | undefined)[] | undefined): readonly T[] => (o ? base.map((c, k) => o[k] ?? c) : base);
  const flat = over(DEFAULT_THEME.flat, def.flat);
  return {
    id,
    ground: { ...DEFAULT_THEME.ground, ...def.ground },
    flat,
    waterMid: def.waterMid ?? DEFAULT_THEME.waterMid,
    thumb: def.thumb ? over(DEFAULT_THEME.thumb, def.thumb) : def.flat ? flat : DEFAULT_THEME.thumb,
  };
}

/** A theme by id; an unknown or missing id is the default. */
export function mapTheme(id: string | undefined): MapTheme {
  const def = id ? THEME_DEFS[id] : undefined;
  if (!id || !def) return DEFAULT_THEME;
  let t = made.get(id);
  if (!t) made.set(id, (t = makeTheme(id, def)));
  return t;
}

/** The theme a map is drawn in: its manifest entry's theme for a world map, the default for anything else. */
export function themeForMap(map: MapChoice | string | undefined): MapTheme {
  const id = typeof map === 'string' ? map : map?.kind === 'world' ? map.id : undefined;
  return mapTheme(id ? getWorldMap(id)?.theme : undefined);
}
