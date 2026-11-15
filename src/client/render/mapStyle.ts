// The map style switch (client only): how the WebGL map paints the ground, the nations and the sea. Read-only for the
// game: nothing here touches the sim, its hash or multiplayer, and every style draws the same tiles, borders, fronts,
// fog and overlays (render/shaders.ts builds one fragment shader per style).
//
//   today   ("Classic") the earlier look: calm flat nation colours over a quiet copy of the terrain, a smooth slate sea
//   pixel   (A, "Pixel terrain") the ground in the units' detailed pixel style, lit from the top left, nations as a
//           translucent tint with crisp pixel borders, a pixel sea with depth bands, waves and shore foam
//   muted   (B, "Muted war map") today's layout in a muted military palette, hill shading and a fine pixel texture
//           under the fill, crisp pixel borders, the pixel sea
//   ground  (C, "Real ground", the default) the pixel ground everywhere, nations shown by thick coloured border bands
//           and a light tint in their own hue (palette.ts groundTint), stronger far out, so a blast lands on real ground
//
// Picked at startup: ?map=a|b|c|today in the page address (for this page only), else the build's VITE_MAP_STYLE,
// else real ground. Settings has no map look: every player gets the default, and no pick is saved or read back
// (settings/store.ts LOOK_KEYS). setMapStyle switches at run time, for this page (the test hooks).

import { getSettings, setSetting } from '../settings/store';

export type MapStyle = 'today' | 'pixel' | 'muted' | 'ground';
export const MAP_STYLES: readonly MapStyle[] = ['today', 'pixel', 'muted', 'ground'];
export const DEFAULT_MAP_STYLE: MapStyle = 'ground';
/** The order of the Menu's Map look buttons: the default first, then the classic look, then the other two. */
export const MAP_STYLE_MENU: readonly MapStyle[] = ['ground', 'today', 'pixel', 'muted'];
/** Where the pick was kept before settings/store.ts (no longer read). */
export const MAP_STYLE_KEY = 'fa.mapStyle';
/** Button words for each style (the Menu's Map look switch). */
export const MAP_STYLE_SHORT: Record<MapStyle, string> = {
  today: 'Classic',
  pixel: 'Pixel terrain',
  muted: 'Muted war map',
  ground: 'Real ground',
};
/** Shader number of each style (MAP_STYLE in render/shaders.ts). */
export const MAP_STYLE_ID: Record<MapStyle, number> = { today: 0, pixel: 1, muted: 2, ground: 3 };

/** Reads a style from a word: a, b, c, a style name, or a label's first word. Unknown words give null. */
export function parseMapStyle(text: string | null | undefined): MapStyle | null {
  const t = (text ?? '').trim().toLowerCase();
  if (!t) return null;
  if (t === 'a' || t === 'pixel' || t === 'terrain') return 'pixel';
  if (t === 'b' || t === 'muted' || t === 'war') return 'muted';
  if (t === 'c' || t === 'ground' || t === 'real') return 'ground';
  if (t === 'today' || t === 'default' || t === 'classic' || t === '0') return 'today';
  return null;
}

/** The style a page address asks for (?map=a|b|c|today), once per page. */
let urlChecked = false;
function urlStyle(): void {
  if (urlChecked) return;
  urlChecked = true;
  let fromUrl: MapStyle | null = null;
  try {
    if (typeof location !== 'undefined') fromUrl = parseMapStyle(new URLSearchParams(location.search).get('map'));
  } catch {
    fromUrl = null;
  }
  // for this page only (settings/store.ts never saves the map look)
  if (fromUrl) setSetting('mapStyle', fromUrl);
}

/** The build's style (VITE_MAP_STYLE), else real ground: what every player gets. */
export function buildMapStyle(): MapStyle {
  try {
    const env = (import.meta as ImportMeta).env;
    const built = parseMapStyle(env?.VITE_MAP_STYLE);
    if (built) return built;
  } catch {
    // no build env (tests)
  }
  return DEFAULT_MAP_STYLE;
}

let current: MapStyle | null = null;
let version = 0;

/** The map style now: the page address or a switch on this page (settings/store.ts), else the build's. */
export function mapStyle(): MapStyle {
  urlStyle();
  const s = getSettings().mapStyle ?? buildMapStyle();
  if (s !== current) {
    if (current !== null) version++;
    current = s;
  }
  return current;
}
/** Switches the map style (the map layer rebuilds its shader on the next frame), for this page only. */
export function setMapStyle(s: MapStyle): void {
  if (!MAP_STYLES.includes(s)) return;
  urlStyle();
  setSetting('mapStyle', s);
  mapStyle();
}
/** Changes whenever the style changes. */
export function mapStyleVersion(): number {
  mapStyle();
  return version;
}
