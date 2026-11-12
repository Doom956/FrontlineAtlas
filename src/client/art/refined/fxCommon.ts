// Shared parts of the refined style's battle effects (client only): the explosion ramp and the smoke painter.
import { pixelDisc } from '../shared/pixel';

/** The explosion ramp, light to dark. */
export const WHITE = '#fffbe8';
export const YELLOW = '#ffd84a';
export const ORANGE = '#ff8a1f';
export const RED = '#d4361c';
export const EMBER = '#7a2412';
export const SMOKE_DARK = '#3d3b3a';
export const SMOKE = '#6e6b68';
export const SMOKE_LIGHT = '#a19d98';
export const DEBRIS = '#241e1a';
export const FOAM = '#eef6fa';
export const FOAM_DIM = '#b9d2df';

// Smoke is painted as one mass: the puffs of a group are collected (smokeAdd), then drawn in layered passes (all the
// dark discs, then all the mid discs, then all the light highlights), so overlapping puffs merge into one outlined
// cloud with a top-left light instead of a stack of separately outlined beads. A group drawn see-through goes through
// a scratch canvas first, so the overlaps do not darken.
const SMOKE_MAX = 40;
const smX = new Float32Array(SMOKE_MAX);
const smY = new Float32Array(SMOKE_MAX);
const smR = new Float32Array(SMOKE_MAX);
let smN = 0;
let scratch: HTMLCanvasElement | null = null;
let scratchCtx: CanvasRenderingContext2D | null = null;

/** Starts a new smoke group (drops what was collected). */
export function smokeReset(): void {
  smN = 0;
}

/** Adds a puff (centre in px, radius in cells) to the smoke group being built. */
export function smokeAdd(x: number, y: number, r: number): void {
  if (smN < SMOKE_MAX) {
    smX[smN] = x;
    smY[smN] = y;
    smR[smN] = r;
    smN++;
  }
}

function smokePasses(ctx: CanvasRenderingContext2D, dx: number, dy: number, g: number, dark: string, mid: string, light: string): void {
  ctx.fillStyle = dark;
  for (let i = 0; i < smN; i++) pixelDisc(ctx, smX[i] + dx + g * 0.5, smY[i] + dy + g * 0.5, smR[i], g);
  ctx.fillStyle = mid;
  for (let i = 0; i < smN; i++) pixelDisc(ctx, smX[i] + dx, smY[i] + dy, smR[i] - 0.6, g);
  ctx.fillStyle = light;
  for (let i = 0; i < smN; i++) if (smR[i] >= 2) pixelDisc(ctx, smX[i] + dx - smR[i] * 0.3 * g, smY[i] + dy - smR[i] * 0.3 * g, smR[i] * 0.45, g);
}

/** Draws the smoke group built with smokeAdd at `alpha` and empties it. */
export function smokeDraw(ctx: CanvasRenderingContext2D, g: number, alpha: number, dark = SMOKE_DARK, mid = SMOKE, light = SMOKE_LIGHT): void {
  if (smN === 0) return;
  const prev = ctx.globalAlpha;
  if (alpha >= 0.99 || typeof document === 'undefined') {
    ctx.globalAlpha = prev * alpha;
    smokePasses(ctx, 0, 0, g, dark, mid, light);
  } else {
    // the group's box, on the cell grid so the discs snap to the same pixels as on the map
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (let i = 0; i < smN; i++) {
      const r = (smR[i] + 2) * g;
      x0 = Math.min(x0, smX[i] - r);
      y0 = Math.min(y0, smY[i] - r);
      x1 = Math.max(x1, smX[i] + r);
      y1 = Math.max(y1, smY[i] + r);
    }
    x0 = Math.floor(x0 / g) * g;
    y0 = Math.floor(y0 / g) * g;
    const w = Math.ceil(x1 - x0);
    const h = Math.ceil(y1 - y0);
    if (!scratch) {
      scratch = document.createElement('canvas');
      scratchCtx = scratch.getContext('2d');
    }
    const sc = scratchCtx;
    if (!sc || w <= 0 || h <= 0 || w > 2048 || h > 2048) {
      ctx.globalAlpha = prev * alpha;
      smokePasses(ctx, 0, 0, g, dark, mid, light);
    } else {
      if (scratch.width < w || scratch.height < h) {
        scratch.width = Math.max(scratch.width, w);
        scratch.height = Math.max(scratch.height, h);
      }
      sc.clearRect(0, 0, w, h);
      sc.globalAlpha = 1;
      smokePasses(sc, -x0, -y0, g, dark, mid, light);
      ctx.globalAlpha = prev * alpha;
      ctx.drawImage(scratch, 0, 0, w, h, x0, y0, w, h);
    }
  }
  ctx.globalAlpha = prev;
  smN = 0;
}

/** One shaded puff on its own (a group of one). */
export function puff(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, g: number, alpha = 1, dark = SMOKE_DARK, mid = SMOKE, light = SMOKE_LIGHT): void {
  smN = 0;
  smokeAdd(x, y, r);
  smokeDraw(ctx, g, alpha, dark, mid, light);
}
