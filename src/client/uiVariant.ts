// Comparison switches for the UI redesign. Build time only, so the owner can compare options side by side:
//   VITE_UI_WATER=chart VITE_UI_PALETTE=violet npx vite build
// Once the owner picks, the chosen values become the only code path and this file is deleted.
export type WaterStyle = 'bands' | 'gradient' | 'chart';
export type PaletteChoice = 'amber' | 'violet' | 'teal' | 'coral';

const WATER: readonly WaterStyle[] = ['bands', 'gradient', 'chart'];
const PALETTES: readonly PaletteChoice[] = ['amber', 'violet', 'teal', 'coral'];

function pick<T extends string>(v: string | undefined, all: readonly T[], fallback: T): T {
  return (all as readonly string[]).includes(v ?? '') ? (v as T) : fallback;
}

/** Water depth style on the map: stepped bands, a smooth gradient, or bands with chart contour lines. */
export const WATER_STYLE: WaterStyle = pick(import.meta.env?.VITE_UI_WATER, WATER, 'bands');
/** Accent palette of the HUD and menus (set as data-palette on the root element). */
export const PALETTE: PaletteChoice = pick(import.meta.env?.VITE_UI_PALETTE, PALETTES, 'amber');
/** Water style as the shader's integer uniform: 0 bands, 1 gradient, 2 chart. */
export const WATER_STYLE_ID = WATER.indexOf(WATER_STYLE);
