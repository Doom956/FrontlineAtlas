// The map style switch (client only): how the WebGL map paints the ground, the nations and the sea. Read-only for the
// game: nothing here touches the sim, its hash or multiplayer, and every style draws the same tiles, borders, fronts,
// fog and overlays (render/shaders.ts builds one fragment shader per style).
//
//   today   the current look: calm flat nation colours over a quiet copy of the terrain, a smooth slate sea
//   pixel   (A, "Pixel terrain") the ground in the units' detailed pixel style, lit from the top left, nations as a
//           translucent tint with crisp pixel borders, a pixel sea with depth bands, waves and shore foam
//   muted   (B, "Muted war map") today's layout in a muted military palette, hill shading and a fine pixel texture
//           under the fill, crisp pixel borders, the pixel sea
//   ground  (C, "Real ground") the pixel ground everywhere, nations shown by thick coloured border bands and a light
//           tint, so a blast lands on real ground
//
// Picked at startup: ?map=a|b|c|today in the page address (also remembered in this browser), else the remembered
// pick (localStorage 'fa.mapStyle'), else the build's VITE_MAP_STYLE, else today. setMapStyle switches at run time.

export type MapStyle = 'today' | 'pixel' | 'muted' | 'ground';
export const MAP_STYLES: readonly MapStyle[] = ['today', 'pixel', 'muted', 'ground'];
export const DEFAULT_MAP_STYLE: MapStyle = 'today';
export const MAP_STYLE_KEY = 'fa.mapStyle';
/** Button words for each style (the Menu's Map look switch). */
export const MAP_STYLE_SHORT: Record<MapStyle, string> = {
  today: 'Today',
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

function startStyle(): MapStyle {
  let fromUrl: MapStyle | null = null;
  try {
    if (typeof location !== 'undefined') fromUrl = parseMapStyle(new URLSearchParams(location.search).get('map'));
  } catch {
    fromUrl = null;
  }
  if (fromUrl) {
    remember(fromUrl);
    return fromUrl;
  }
  try {
    const kept = parseMapStyle(typeof localStorage !== 'undefined' ? localStorage.getItem(MAP_STYLE_KEY) : null);
    if (kept) return kept;
  } catch {
    // storage blocked: fall through
  }
  try {
    const env = (import.meta as ImportMeta).env;
    const built = parseMapStyle(env?.VITE_MAP_STYLE);
    if (built) return built;
  } catch {
    // no build env (tests)
  }
  return DEFAULT_MAP_STYLE;
}

function remember(s: MapStyle): void {
  try {
    if (typeof localStorage === 'undefined') return;
    if (s === DEFAULT_MAP_STYLE) localStorage.removeItem(MAP_STYLE_KEY);
    else localStorage.setItem(MAP_STYLE_KEY, s);
  } catch {
    // storage blocked: the pick lasts for this page only
  }
}

let current: MapStyle | null = null;
let version = 0;

/** The map style now. */
export function mapStyle(): MapStyle {
  if (current === null) current = startStyle();
  return current;
}
/** Switches the map style (the map layer rebuilds its shader on the next frame) and remembers it in this browser. */
export function setMapStyle(s: MapStyle): void {
  if (!MAP_STYLES.includes(s)) return;
  current = s;
  version++;
  remember(s);
}
/** Changes whenever the style changes. */
export function mapStyleVersion(): number {
  return version;
}
