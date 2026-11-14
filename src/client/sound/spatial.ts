// Where on the map a sound happens decides whether it is heard (pure functions, client only).
//
// Sounds at a map place (shots, blasts, tank fire and kills, plane crashes, ship sinkings, missile launches, sonar, the
// front's gunfire) play only when the place is on screen or just off its edge, and their volume follows the zoom:
// full when zoomed in close (units are drawn as sprites from zoom 5, render/units.ts), fading as the camera pulls
// out. Zoom is screen px per tile (camera.ts: from 0.8 x the whole-map fit, about 0.7 to 2.3 by map size, up to 40).
//
//   tier     full at   silent at or below           what
//   small    6         2.5                           shots, small blasts, tank shots
//   medium   4.5       1.6                           tank kills, plane crashes, launches, sonar, barrages
//   big      3         never: 0.22 of full at 1      atom bombs, big blasts, ships sinking
//
// The fade is even in log(zoom), so each wheel step changes the level by about the same amount.

export type SpatialTier = 'small' | 'medium' | 'big';

export const ZOOM_FULL: Readonly<Record<SpatialTier, number>> = { small: 6, medium: 4.5, big: 3 };
export const ZOOM_SILENT: Readonly<Record<SpatialTier, number>> = { small: 2.5, medium: 1.6, big: 1 };
/** A big sound never fades below this share while it is on screen. */
export const BIG_FLOOR = 0.22;
/** How far past the screen edge a sound is still heard, as a share of the larger view side (big ones further). */
export const EDGE_MARGIN: Readonly<Record<SpatialTier, number>> = { small: 0.08, medium: 0.12, big: 0.25 };

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** 0..1: how loud a sound of `tier` is at camera zoom `zoom` (px per tile). Unknown zoom counts as close. */
export function zoomGain(tier: SpatialTier, zoom: number | undefined): number {
  if (zoom === undefined || !Number.isFinite(zoom)) return 1;
  const hi = ZOOM_FULL[tier];
  const lo = ZOOM_SILENT[tier];
  if (zoom >= hi) return 1;
  const t = zoom <= lo ? 0 : clamp01(Math.log(zoom / lo) / Math.log(hi / lo));
  // ease in: the level drops off quickly once the camera leaves close range
  const g = t * t;
  return tier === 'big' ? BIG_FLOOR + (1 - BIG_FLOOR) * g : g;
}

/**
 * 0..1: 1 on screen, fading to 0 over the margin past the edge, 0 beyond it. (sx, sy) are screen px in a view
 * `viewW` x `viewH`.
 */
export function screenGain(tier: SpatialTier, sx: number, sy: number, viewW: number, viewH: number): number {
  if (!(viewW > 0) || !(viewH > 0) || !Number.isFinite(sx) || !Number.isFinite(sy)) return 0;
  const m = Math.max(viewW, viewH) * EDGE_MARGIN[tier];
  const dx = sx < 0 ? -sx : sx > viewW ? sx - viewW : 0;
  const dy = sy < 0 ? -sy : sy > viewH ? sy - viewH : 0;
  const d = Math.max(dx, dy);
  if (d <= 0) return 1;
  if (d >= m) return 0;
  return 1 - d / m;
}

/** Both together: the share of its full volume a sound of `tier` at screen (sx, sy) plays with (0 = not heard). */
export function spatialGain(tier: SpatialTier, zoom: number | undefined, sx: number, sy: number, viewW: number, viewH: number): number {
  const s = screenGain(tier, sx, sy, viewW, viewH);
  if (s <= 0) return 0;
  return s * zoomGain(tier, zoom);
}

/** Below this a positional sound is not worth a voice. */
export const MIN_AUDIBLE = 0.03;

/**
 * The gunfire bed under the fronts on screen: `heat` is how much fighting is in view (captures and tanks firing,
 * decayed, 0..), the result its 0..1 level. Close up only: silent below zoom 2.5, full from 5.
 */
export function gunfireLevel(heat: number, zoom: number | undefined): number {
  if (!(heat > 0)) return 0;
  const z = zoom === undefined || !Number.isFinite(zoom) ? 5 : zoom;
  const t = z >= 5 ? 1 : z <= 2.5 ? 0 : Math.log(z / 2.5) / Math.log(2);
  const amount = 1 - Math.exp(-heat / 3); // a few captures in view already make a front, more only thicken it
  return clamp01(amount * t * t);
}

/** Picks a variant index in 0..n-1 with `rand` 0..1, never `last` again when there are several. */
export function pickVariant(n: number, last: number, rand: number): number {
  if (!(n > 1)) return 0;
  const r = Math.min(0.999999, Math.max(0, Number.isFinite(rand) ? rand : 0));
  if (last < 0 || last >= n) return Math.floor(r * n);
  const k = Math.floor(r * (n - 1));
  return k >= last ? k + 1 : k;
}

/** Per-play variation: a playback rate within +-`spread` and a gain within +-`db` dB, from two 0..1 numbers. */
export function playVariation(spread: number, db: number, r1: number, r2: number): { rate: number; gain: number } {
  const s = Math.max(0, spread);
  const rate = 1 + (clamp01(r1) * 2 - 1) * s;
  const gain = Math.pow(10, ((clamp01(r2) * 2 - 1) * db) / 20);
  return { rate, gain };
}
