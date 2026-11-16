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
   * The Sundering Wall: a bright cartoon look. Red-brown and rust-red rock for the wall and every peak, bright
   * saturated greens, warm sandy beaches and deserts, ochre hills, and a vivid sea from turquoise shallows out to deep
   * blue.
   */
  brightseas: {
    ground: {
      grass: ramp('#3f8f2a', '#55aa37', '#6fc246', '#8fd85e'),
      grassDry: ramp('#6f9a32', '#88b443', '#a2c957', '#bbdb70'),
      grassLush: ramp('#2f8030', '#3f9a3e', '#55b44f', '#71ca64'),
      forest: ramp('#1c5a22', '#267030', '#348a3e', '#45a24d'),
      hills: ramp('#7a5a2c', '#977238', '#b38c4a', '#cba664'),
      rock: ramp('#6e2a1c', '#8f3a25', '#b24e30', '#cf6d48'),
      snow: ramp('#c9b9b4', '#ddd0cb', '#eee6e2', '#fbf7f4'),
      sand: ramp('#c99a55', '#dcb46c', '#ebca86', '#f6dea2'),
      swamp: ramp('#355a2c', '#47703a', '#5c874a', '#73a05e'),
      tundra: ramp('#9aa58e', '#b2bca5', '#c8d0bb', '#dce3d0'),
      wheat: ramp('#b59a3e', '#cdb24f', '#dfc662', '#ecd87a'),
      crop: ramp('#4f8f2f', '#62a83b', '#79bf4b', '#93d35f'),
      soil: ramp('#8a5f33', '#a47440', '#bb8a52', '#cfa067'),
      pool: ramp('#1d7fa0', '#2a95b6', '#3dabc8', '#5cc2d8'),
      sea: [hx('#3fc4d6'), hx('#22a6c8'), hx('#1585b8'), hx('#106aa3'), hx('#0d5690')],
      foam: ramp('#5fd0e0', '#8fe0ea', '#bdeef3', '#e6fafb'),
    },
    flat: [
      [13, 86, 144], // open sea: deep blue
      [34, 166, 200], // shelf: turquoise
      [96, 186, 70], // plains: bright green
      [45, 132, 58], // forest
      [179, 140, 74], // hills: ochre
      [178, 78, 48], // mountains and the wall: rust-red rock
      [235, 202, 134], // desert: warm sand
      [80, 130, 70], // swamp
      [200, 208, 187], // tundra
    ],
    waterMid: [20, 120, 175],
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
