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
  /**
   * The Fivefold Lands: a warm painted-scroll look. Warm parchment greens and ochre hills, deep lush forest, orange-tan
   * desert, grey-violet rock, and a vivid but soft blue sea.
   */
  warmscroll: {
    ground: {
      grass: ramp('#a2c776', '#a9cf7e', '#afd484', '#b4d889'),
      grassDry: ramp('#b3c97c', '#bbd083', '#c2d58a', '#c8d990'),
      grassLush: ramp('#a2c776', '#a9cf7e', '#afd484', '#b4d889'),
      forest: ramp('#84b062', '#8db96a', '#94bf71', '#9ac476'),
      hills: ramp('#bda878', '#c9b38a', '#d1bc94', '#d8c49c'),
      rock: ramp('#9a8eaa', '#a99cb8', '#b4a8c2', '#bdb2ca'),
      snow: ramp('#c9c9d6', '#d6d6e0', '#e2e2ea', '#ececf2'),
      sand: ramp('#e1b070', '#e8b97a', '#edc088', '#f0c692'),
      swamp: ramp('#98bb78', '#a0c080', '#a8c688', '#aecb8e'),
      tundra: ramp('#b8b8c0', '#c0c0c8', '#c8c8d0', '#d0d0d6'),
      wheat: ramp('#b9c97c', '#c1d083', '#c8d68a', '#ced98f'),
      crop: ramp('#a2c776', '#a9cf7e', '#afd484', '#b4d889'),
      soil: ramp('#c2ab82', '#c9b38a', '#d0ba92', '#d6c09a'),
      pool: ramp('#93a9d0', '#9eb0d4', '#a9b9da', '#b4c2e0'),
      sea: [hx('#b9c8e4'), hx('#b0c0e0'), hx('#a6b8da'), hx('#9eb0d4'), hx('#98aad0')],
      foam: ramp('#c9d5ea', '#d6dfef', '#e3e9f4', '#f0f3f9'),
    },
    flat: [
      [158, 176, 212], // open sea
      [185, 200, 228], // shelf
      [169, 207, 126], // plains: flat painted green
      [141, 185, 106], // forest
      [201, 179, 138], // hills: tan
      [169, 156, 184], // mountains: grey-violet rock
      [232, 185, 122], // desert: orange-tan
      [160, 192, 128], // swamp
      [192, 192, 200], // tundra
    ],
    waterMid: [158, 176, 212],
  },
  /**
   * The Dark Beyond: a painted storybook map. Fresh earthy greens and warm tans for the known world, a deep blue lake,
   * and an eerie dark continent: dark olive heath (tundra), sickly yellow-green fens (swamp) and deep purple-grey rock
   * (mountains, with pale lilac tops instead of white snow).
   */
  darkbeyond: {
    ground: {
      grass: ramp('#5e7a3c', '#6f8a4a', '#8a9a52', '#a0ad64'),
      grassDry: ramp('#6c6f3a', '#827f48', '#9a9658', '#b0aa6c'),
      grassLush: ramp('#4a6434', '#5c7a40', '#6f8a4a', '#839c58'),
      forest: ramp('#2a4020', '#33502a', '#3f5a30', '#51703c'),
      hills: ramp('#7d663f', '#99804f', '#b79a62', '#c9b27c'),
      rock: ramp('#2e2838', '#3b3347', '#4a3f55', '#5f5470'),
      snow: ramp('#6f6680', '#8a8199', '#a59db2', '#c0b9cb'),
      sand: ramp('#a8905a', '#c0a56c', '#d8bf84', '#e8d6a2'),
      swamp: ramp('#44502a', '#55603a', '#6b7a3a', '#80903f'),
      tundra: ramp('#2c2c1a', '#3b3b24', '#4a4a2e', '#5a5a3a'),
      wheat: ramp('#8a7a42', '#a69454', '#bfac68', '#d3c27e'),
      crop: ramp('#4e6a2e', '#64843a', '#7c9d4a', '#95b45d'),
      soil: ramp('#6b5232', '#856842', '#9e7f55', '#b6966a'),
      pool: ramp('#1c2d3c', '#26394b', '#32485c', '#435a70'),
      sea: [hx('#2f6aa0'), hx('#285d92'), hx('#224f82'), hx('#1b3f6e'), hx('#1b3a63')],
      foam: ramp('#3a77b4', '#5a92c8', '#8db4dc', '#c3d8ee'),
    },
    flat: [
      [27, 58, 99], // open lake: deep blue
      [47, 106, 160], // shelf
      [110, 138, 74], // plains: fresh green
      [63, 90, 48], // forest
      [183, 154, 98], // hills: warm tan
      [74, 63, 85], // mountains: purple-grey rock
      [216, 191, 132], // desert: sand
      [107, 122, 58], // swamp: sickly green
      [74, 74, 46], // tundra: dark olive heath
    ],
    waterMid: [27, 72, 128],
  },
  /**
   * Islands adrift in the sky (the Drifting Isles): a soft, dreamy, saturated pastel look. A sea like an open sky, bright
   * cerulean far out and pale sky blue at the shores, with white cloud-like foam; lush bright greens, pale sand,
   * lavender-grey rock and white snow on the high peaks.
   */
  skyisles: {
    ground: {
      grass: ramp('#6fc95a', '#8fdc6a', '#a6e57f', '#bdee98'),
      grassDry: ramp('#86b452', '#9fc866', '#b9da7f', '#d1e99c'),
      grassLush: ramp('#4fb04a', '#5fc055', '#6cc95a', '#86d673'),
      forest: ramp('#2f9a54', '#3aab5c', '#45b864', '#62c97c'),
      hills: ramp('#9db86c', '#aec47a', '#b8cf86', '#cfe2a4'),
      rock: ramp('#8f86a8', '#a399bd', '#b4a9cc', '#cdc5df'),
      snow: ramp('#e8e6f2', '#f2f1f8', '#fafaff', '#ffffff'),
      sand: ramp('#e6d29a', '#eedcaa', '#f5e6b8', '#fbf2d6'),
      swamp: ramp('#468a6d', '#5a9e7f', '#71b293', '#8bc6a8'),
      tundra: ramp('#b4bed6', '#c7d0e3', '#d9e0ee', '#eaeff8'),
      wheat: ramp('#bcc464', '#cdd47a', '#dce290', '#e8eda8'),
      crop: ramp('#62b052', '#79c265', '#91d27b', '#abe194'),
      soil: ramp('#a68f74', '#baa488', '#ccb99e', '#ddcdb3'),
      pool: ramp('#62bfe9', '#7bcdf0', '#95d9f4', '#b1e5f8'),
      sea: [hx('#e2f4ff'), hx('#bfe6fc'), hx('#92d4f9'), hx('#62bff7'), hx('#3fa9f5')],
      foam: ramp('#e4f4ff', '#f0f9ff', '#f6fbff', '#ffffff'),
    },
    flat: [
      [63, 169, 245], // open sea: bright cerulean
      [207, 238, 255], // shelf: pale sky blue
      [143, 220, 106], // plains: lush bright green
      [69, 184, 100], // forest
      [184, 207, 134], // hills: light sage
      [180, 169, 204], // mountains: lavender-grey rock
      [245, 230, 184], // desert: pale sand
      [108, 172, 140], // swamp
      [222, 229, 242], // tundra: snow white
    ],
    waterMid: [90, 190, 246],
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
