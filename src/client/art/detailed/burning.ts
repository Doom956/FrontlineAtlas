// The detailed style's fires and smoke that keep going (client only): a damaged unit burning, a fresh crater, the atom
// bomb's blast zone. Built from the shared puffs (blobs.ts: 'flame' tongues, 'soot', 'shade' and 'smoke' balls) and
// animated from the clock alone, with no state: a smoke trail is a ring of puffs, each born at its source in turn and
// carried off by the wind as it ages, and a source that moves leaves its puffs behind along the way it came (they are
// placed by the source's own speed, heading and turn), so the smoke follows a ship instead of floating on the water.
// Reduced motion: still flames and still puffs.
import type { MotionParams } from '../motion';
import { drawBlob, flameCode, type BlobKind } from './blobs';
import type { Grid } from './grid';

/** The wind over the map, CSS px per second at map scale 1: to the right and a little up the screen. */
export const WIND_X = 5.5;
export const WIND_Y = -1.1;
/** How fast warm smoke rises, CSS px per second at map scale 1 (up the screen in the 3/4 view). */
export const RISE = 6.5;

const frac = (v: number): number => v - Math.floor(v);
const easeOut = (t: number): number => 1 - (1 - t) * (1 - t);

/** A flicker frame 0..3 at `timeMs` for a fire with phase `seed` (still under reduced motion). */
export function flickerFrame(timeMs: number, seed: number, m: MotionParams): number {
  if (m.reduced) return Math.floor(seed * 4) & 3;
  return Math.floor(timeMs / Math.max(40, m.flameMs) + seed * 13.7) & 3;
}

/**
 * A fire burning on a spot: a flickering tongue of flame standing at (x, y) (its base), `r` cells half-wide at the base,
 * leaning `lean` (-2..2) with the wind. Under 1 cell it is a flickering speck of fire.
 */
export function drawFlame(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, g: Grid, timeMs: number, seed: number, m: MotionParams, alpha = 1, lean = 1): void {
  const fr = flickerFrame(timeMs, seed, m);
  if (r < 0.75) {
    drawBlob(ctx, 'fire', 1, fr, x, y - g.k * 0.5, g, alpha, fr & 1 ? 1 : 2);
    return;
  }
  // the size breathes a little with the flicker, so a small fire does not hold one height
  const R = Math.max(1, Math.round(r * (fr === 1 ? 1.15 : fr === 3 ? 0.88 : 1)));
  drawBlob(ctx, 'flame', R, Math.floor(seed * 7) & 3, x, y, g, alpha, flameCode(fr, lean));
}

/** A smoke trail's source this frame. */
export interface SmokeSource {
  /** where the smoke comes out now (CSS px) */
  x: number;
  y: number;
  /** how the source moves (CSS px per second) and turns (rad/s, clockwise on screen): its smoke is left behind it */
  vx: number;
  vy: number;
  turn: number;
  /** puffs alive at once, how long one lives (ms), its radius at birth and at the end (cells) */
  n: number;
  lifeMs: number;
  r0: number;
  r1: number;
  /** the share of a puff's life it stays oily black (0 grey smoke throughout .. 1 soot throughout) */
  dark: number;
  alpha: number;
  /** CSS px per art unit of motion (the map scale): the wind and the rise are this much faster on screen */
  u: number;
  /** multipliers of the wind and the rise (a heavy column climbs faster) */
  wind: number;
  rise: number;
  /** phase, so neighbouring trails do not puff in step */
  seed: number;
}

/**
 * Draws a smoke trail: `n` puffs, each born at the source in turn, swelling, rising and drifting downwind as it ages
 * and fading out, oldest first so the fresh dark puffs at the source lie on top. A moving source leaves its puffs
 * behind along its path (bent by its turn), so the trail streams aft of a ship and curves where it turned.
 */
export function drawSmokeTrail(ctx: CanvasRenderingContext2D, s: SmokeSource, g: Grid, timeMs: number, m: MotionParams): void {
  const n = Math.max(1, Math.round(s.n));
  const base = m.reduced ? 0.5 / n : frac(timeMs / Math.max(1, s.lifeMs) + s.seed * 0.37);
  // the oldest puff first: the k whose age is closest to 1
  const k0 = (((Math.ceil((1 - base) * n) - 1) % n) + n) % n;
  const life = s.lifeMs / 1000;
  const sd = Math.floor(s.seed * 64);
  for (let j = 0; j < n; j++) {
    const k = (k0 - j + n) % n;
    const a = frac(base + k / n);
    const sec = a * life;
    // where the source was when it gave off this puff: back along its course, which bends by its turn
    const phi = -s.turn * sec * 0.5;
    const c = Math.cos(phi);
    const sn = Math.sin(phi);
    const bx = -(s.vx * c - s.vy * sn) * sec;
    const by = -(s.vx * sn + s.vy * c) * sec;
    const wob = Math.sin(a * 5.3 + k * 1.9 + s.seed * 6) * s.u * 0.7 * a;
    const px = s.x + bx + WIND_X * s.u * s.wind * sec + wob;
    const py = s.y + by + (WIND_Y * s.wind - RISE * s.rise) * s.u * sec;
    const r = s.r0 + (s.r1 - s.r0) * easeOut(a);
    const fade = (a < 0.08 ? a / 0.08 : 1) * (1 - a) ** 1.25;
    const kind: BlobKind = a < s.dark * 0.6 ? 'soot' : a < s.dark ? 'shade' : 'smoke';
    drawBlob(ctx, kind, Math.max(1, r), (k + sd) & 3, px, py, g, s.alpha * fade);
  }
}
