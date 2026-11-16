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
export const THEME_DEFS: Record<string, MapThemeDef> = {
  /**
   * The walled country (the Ringlands and its island in the Sundered Sea): a soft painted look instead of a realistic
   * one. Muted greens and olive fields, warm sandy farmland, grey-beige stone for the walls and mountains, dusty sepia
   * hills, and a dull teal-grey sea.
   */
  stonewall: {
    ground: {
      grass: ramp('#5a6a45', '#71825a', '#8c9c70', '#a5b386'),
      grassDry: ramp('#6b6a45', '#86845a', '#a19e70', '#b8b487'),
      grassLush: ramp('#4c5f40', '#617752', '#7a9166', '#93a97b'),
      forest: ramp('#29361f', '#3b4d2e', '#53673f', '#6d8253'),
      hills: ramp('#5f4c37', '#7d6549', '#9a7f5f', '#b59b79'),
      rock: ramp('#5b564c', '#7a7467', '#9c9585', '#bfb8a6'),
      snow: ramp('#9da3a1', '#bfc4bf', '#dcdfd8', '#f1f2ea'),
      sand: ramp('#9a8159', '#b79b6e', '#cfb486', '#e3cc9f'),
      swamp: ramp('#323a2c', '#4a5339', '#626b49', '#7a825c'),
      tundra: ramp('#76796a', '#919382', '#aaab98', '#c0c0ad'),
      wheat: ramp('#86764f', '#a38f63', '#bba676', '#cfbb8a'),
      crop: ramp('#5b663d', '#727d4c', '#8a945e', '#a0a971'),
      soil: ramp('#6a5539', '#846b4b', '#9c835f', '#b39a74'),
      pool: ramp('#2b4140', '#385251', '#486563', '#647f7b'),
      sea: [hx('#4a6764'), hx('#3f5b59'), hx('#35504f'), hx('#2d4646'), hx('#273c3d')],
      foam: ramp('#4f6d69', '#6f8a85', '#9fb3ab', '#cad6cd'),
    },
    flat: [
      [39, 60, 61], // open sea
      [63, 91, 89], // shelf
      [140, 156, 112], // plains: soft green
      [84, 104, 68], // forest
      [156, 128, 96], // hills: dusty sepia
      [184, 174, 154], // mountains and walls: grey-beige stone
      [207, 180, 134], // desert: warm sand
      [100, 110, 80], // swamp
      [192, 193, 178], // tundra
    ],
    waterMid: [51, 75, 75],
  },
  /**
   * The Fivefold Lands: a warm painted-scroll look. Warm parchment greens and ochre hills, deep lush forest, orange-tan
   * desert, grey-violet rock, and a vivid but soft blue sea.
   */
  warmscroll: {
    ground: {
      grass: ramp('#71894a', '#8aa25d', '#a3b973', '#bccd8b'),
      grassDry: ramp('#8b874c', '#a6a05f', '#bfb875', '#d3cb8d'),
      grassLush: ramp('#5b7f41', '#719651', '#89ad64', '#a1c27a'),
      forest: ramp('#2d5a2e', '#3c6f3a', '#52864a', '#6a9c5d'),
      hills: ramp('#7f6240', '#9c7c52', '#b79766', '#cdb07f'),
      rock: ramp('#5d566b', '#776f86', '#948ca2', '#b3acbf'),
      snow: ramp('#a9adc2', '#c6c9da', '#dfe1ed', '#f4f4f9'),
      sand: ramp('#b5793f', '#cc9357', '#deab6e', '#ecc58c'),
      swamp: ramp('#3f5c47', '#52725a', '#6a896c', '#83a083'),
      tundra: ramp('#8d8b97', '#a5a3ad', '#bcbac2', '#d1cfd5'),
      wheat: ramp('#a08a4b', '#bba45f', '#d0b975', '#e1cd8e'),
      crop: ramp('#66823f', '#7c984f', '#93ad63', '#a9c179'),
      soil: ramp('#7d5c3a', '#98734c', '#b08b61', '#c6a277'),
      pool: ramp('#2f73a0', '#3e88b6', '#529ec9', '#70b4d9'),
      sea: [hx('#73b7dc'), hx('#5ea8d4'), hx('#4d97c8'), hx('#4389bd'), hx('#3c7cb1')],
      foam: ramp('#80c0e2', '#9dcfe8', '#c1e0f1', '#e4f2f9'),
    },
    flat: [
      [60, 124, 177], // open sea
      [94, 168, 212], // shelf
      [163, 185, 115], // plains: warm parchment green
      [80, 132, 72], // forest
      [183, 151, 102], // hills: ochre
      [148, 140, 162], // mountains: grey-violet rock
      [222, 171, 110], // desert: orange-tan
      [106, 137, 108], // swamp
      [188, 186, 194], // tundra
    ],
    waterMid: [74, 146, 196],
  },
};

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
