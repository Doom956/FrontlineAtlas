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
   * Islands adrift in the sky (the Drifting Isles): a soft, dreamy, saturated pastel look. A sea like an open sky, bright
   * cerulean far out and pale sky blue at the shores, with white cloud-like foam; lush bright greens, pale sand,
   * lavender-grey rock and white snow on the high peaks.
   */
  skyisles: {
    ground: {
      grass: ramp('#4aa54c', '#62bb5c', '#7fd06f', '#a2e28b'),
      grassDry: ramp('#86b452', '#9fc866', '#b9da7f', '#d1e99c'),
      grassLush: ramp('#389a48', '#4fb357', '#6bc968', '#8cdc80'),
      forest: ramp('#1c7448', '#288b55', '#3aa365', '#58bb7b'),
      hills: ramp('#7f9d5e', '#99b574', '#b3cb8e', '#cbdeaa'),
      rock: ramp('#77739a', '#928eb3', '#aeaacb', '#c9c6df'),
      snow: ramp('#cdd6ee', '#e1e8f8', '#f1f5fd', '#ffffff'),
      sand: ramp('#dcca97', '#e8d8aa', '#f1e5c1', '#f9f1d9'),
      swamp: ramp('#468a6d', '#5a9e7f', '#71b293', '#8bc6a8'),
      tundra: ramp('#b4bed6', '#c7d0e3', '#d9e0ee', '#eaeff8'),
      wheat: ramp('#bcc464', '#cdd47a', '#dce290', '#e8eda8'),
      crop: ramp('#62b052', '#79c265', '#91d27b', '#abe194'),
      soil: ramp('#a68f74', '#baa488', '#ccb99e', '#ddcdb3'),
      pool: ramp('#62bfe9', '#7bcdf0', '#95d9f4', '#b1e5f8'),
      sea: [hx('#a6e0f7'), hx('#86d0f2'), hx('#68bdec'), hx('#50abe5'), hx('#409ddf')],
      foam: ramp('#c6ebfa', '#ddf4fc', '#eefaff', '#ffffff'),
    },
    flat: [
      [64, 157, 223], // open sea: bright cerulean
      [134, 208, 242], // shelf: pale sky blue
      [118, 202, 104], // plains: lush bright green
      [50, 152, 92], // forest
      [176, 202, 138], // hills: light sage
      [178, 174, 206], // mountains: lavender-grey rock
      [241, 229, 193], // desert: pale sand
      [108, 172, 140], // swamp
      [222, 229, 242], // tundra: snow white
    ],
    waterMid: [98, 184, 234],
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
