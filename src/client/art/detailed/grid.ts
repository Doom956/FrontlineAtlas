// The detailed style's pixel grid (client only, pure): how big one art pixel is on screen. The style draws about twice
// the refined style's pixels in the same space: one art pixel is half a refined art pixel, measured in device pixels
// so it stays crisp on high-density screens (at mid zoom on a 1x screen it falls back to one device pixel, the refined
// size). Units, trails and effects all use the same grid, so a scene has one pixel size.

/** One art pixel at a map scale: `p` device px wide, `res` art px per model unit, `k` CSS px wide. */
export interface Grid {
  p: number;
  res: number;
  k: number;
  dpr: number;
}

const grids = new Map<number, Grid>();

/**
 * The grid at map scale `scale` (screen px per refined art pixel) on a screen of `dpr` device px per CSS px: the
 * largest whole number of device px per art pixel that still gives at least two art pixels per model unit, and the
 * resolution that keeps the unit's size on screen (rounded to quarters).
 */
export function gridOf(scale: number, dpr: number): Grid {
  const d = dpr > 0 ? dpr : 1;
  const key = Math.round(scale * 64) * 4096 + Math.round(d * 64);
  let g = grids.get(key);
  if (!g) {
    const D = Math.max(0.5, scale * d);
    const p = Math.max(1, Math.floor(D / 2 + 1e-6));
    const res = Math.max(0.5, Math.round((D / p) * 4) / 4);
    g = { p, res, k: p / d, dpr: d };
    grids.set(key, g);
  }
  return g;
}

/** A CSS coordinate snapped to the device pixel grid. */
export function snap(v: number, dpr: number): number {
  return Math.round(v * dpr) / dpr;
}

/** A CSS coordinate snapped to the art pixel grid of `g` (whole cells from the canvas origin). */
export function snapCell(v: number, g: Grid): number {
  return (Math.round((v * g.dpr) / g.p) * g.p) / g.dpr;
}

/**
 * Headings a unit is baked at for a resolution: 32 at about two art px per unit and more, 16 below; ships and planes
 * (`fine`), whose long hulls and wings would visibly step as they turn, twice as many (64 near, 32 at mid). The atlas
 * bakes them lazily under a per-frame budget, so only the headings on screen cost anything.
 */
export function facingsFor(res: number, fine = false): number {
  return (res >= 1.5 ? 32 : 16) * (fine ? 2 : 1);
}

/** Heading in radians to one of `n` facings (0 = east, clockwise on screen). */
export function facingIndex(angle: number, n: number): number {
  const step = (Math.PI * 2) / n;
  return ((Math.round(angle / step) % n) + n) % n;
}
