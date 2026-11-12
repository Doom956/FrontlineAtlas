// Shared parts of the refined style's battle effects (client only): the effect palette (palette.ts FX), lumpy pixel
// blobs (no clean geometric circles), the smoke painter that merges puffs into one lit mass, fire balls shaded from a
// hot core to an ember rim, and debris thrown on ballistic arcs.
import { rnd } from '../shared/noise';
import { FX } from './palette';

export { FX };

/**
 * A lumpy pixel blob: a disc of `r` cells of `g` px whose edge wobbles row by row (the wobble is the same for the same
 * `seed`), snapped to the grid. Fire, smoke and foam are built from these, never from perfect circles.
 */
/** A cheap repeatable 0..1 value for (seed, i): integer hashing, no trigonometry (blobs call it for every row). */
function hash(seed: number, i: number): number {
  let h = Math.imul((seed * 1013) | 0, 0x27d4eb2d) ^ Math.imul(i + 0x9e37, 0x165667b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
}

export function blob(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, g: number, seed: number): void {
  const x0 = Math.round(cx / g) * g;
  const y0 = Math.round(cy / g) * g;
  const ri = Math.max(0, Math.round(r));
  if (ri === 0) {
    ctx.fillRect(x0, y0, g, g);
    return;
  }
  for (let dy = -ri; dy <= ri; dy++) {
    const w = Math.sqrt(Math.max(0, ri * ri - dy * dy)) * (0.86 + 0.26 * hash(seed, dy + 11)) + 0.35;
    const half = Math.floor(w);
    if (half < 0) continue;
    // the row slides a little left or right, so the outline is ragged, not a stamp
    const off = ri > 2 && Math.abs(dy) < ri - 1 ? Math.round((hash(seed, dy + 31) - 0.5) * 1.2) : 0;
    ctx.fillRect(x0 + (off - half) * g, y0 + dy * g, (half * 2 + 1) * g, g);
  }
}

/**
 * A patch of foam on the water: flattened (wider than tall, as water lies flat in the 3/4 view), ragged at its ends,
 * `w` cells to each side of its centre.
 */
export function foamPatch(ctx: CanvasRenderingContext2D, cx: number, cy: number, w: number, g: number, seed: number): void {
  const x0 = Math.round(cx / g) * g;
  const y0 = Math.round(cy / g) * g;
  const half = Math.max(0, Math.round(w));
  const a = Math.round(rnd(seed, 1) * 1.6);
  const b = Math.round(rnd(seed, 2) * 1.6);
  ctx.fillRect(x0 - half * g, y0, (half * 2 + 1) * g, g);
  if (half >= 1) ctx.fillRect(x0 - (half - 1 - a + 1) * g, y0 - g, Math.max(1, half * 2 - 1 - a) * g, g);
  if (half >= 2) ctx.fillRect(x0 - (half - 1 - b) * g, y0 + g, Math.max(1, half * 2 - 2 - b) * g, g);
}

// Smoke is painted as one mass: the puffs of a group are collected (smokeAdd), then drawn in layered passes (all the
// shadow blobs, then all the body blobs, then the lit tops), so overlapping puffs merge into one cloud with a top-left
// light instead of a stack of separately outlined beads. A see-through group is drawn straight onto the map at its
// alpha (no scratch canvas: a copy between canvases per group costs far more than it shows); where its puffs overlap
// the smoke is a little denser, as real smoke is.
const SMOKE_MAX = 48;
const smX = new Float32Array(SMOKE_MAX);
const smY = new Float32Array(SMOKE_MAX);
const smR = new Float32Array(SMOKE_MAX);
const smS = new Float32Array(SMOKE_MAX);
let smN = 0;

/** Starts a new smoke group (drops what was collected). */
export function smokeReset(): void {
  smN = 0;
}

/** Adds a puff (centre in px, radius in cells, its own lumpiness) to the smoke group being built. */
export function smokeAdd(x: number, y: number, r: number, seed = 0): void {
  if (smN < SMOKE_MAX && r > 0.2) {
    smX[smN] = x;
    smY[smN] = y;
    smR[smN] = r;
    smS[smN] = seed + smN * 0.37;
    smN++;
  }
}

function smokePasses(ctx: CanvasRenderingContext2D, dx: number, dy: number, g: number, dark: string, mid: string, light: string): void {
  ctx.fillStyle = dark;
  for (let i = 0; i < smN; i++) blob(ctx, smX[i] + dx + g * 0.6, smY[i] + dy + g * 0.8, smR[i], g, smS[i]);
  ctx.fillStyle = mid;
  for (let i = 0; i < smN; i++) blob(ctx, smX[i] + dx, smY[i] + dy, smR[i] - 0.5, g, smS[i] + 3);
  // the lit tops: only the puffs on the upper side of the mass catch the light, so it reads as one cloud, not a stack
  // of spotted beads
  let my = 0;
  for (let i = 0; i < smN; i++) my += smY[i];
  my /= Math.max(1, smN);
  ctx.fillStyle = light;
  for (let i = 0; i < smN; i++) if (smR[i] >= 1.6 && (smN < 3 || smY[i] <= my + smR[i] * g * 0.2)) blob(ctx, smX[i] + dx - smR[i] * 0.3 * g, smY[i] + dy - smR[i] * 0.38 * g, smR[i] * 0.48, g, smS[i] + 5);
}

/** Draws the smoke group built with smokeAdd at `alpha` and empties it. */
export function smokeDraw(ctx: CanvasRenderingContext2D, g: number, alpha: number, dark: string = FX.soot, mid: string = FX.smokeDark, light: string = FX.smoke): void {
  if (smN === 0) return;
  if (alpha > 0.01) {
    const prev = ctx.globalAlpha;
    ctx.globalAlpha = prev * Math.min(1, alpha);
    smokePasses(ctx, 0, 0, g, dark, mid, light);
    ctx.globalAlpha = prev;
  }
  smN = 0;
}

/** One shaded puff on its own (a group of one). */
export function puff(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, g: number, alpha = 1, dark: string = FX.soot, mid: string = FX.smokeDark, light: string = FX.smoke, seed = 0): void {
  smN = 0;
  smokeAdd(x, y, r, seed);
  smokeDraw(ctx, g, alpha, dark, mid, light);
}

/**
 * A ball of fire `r` cells across at temperature `heat` (1 = just burst, white-hot inside; 0 = cooling to embers):
 * a dark ember rim on its lower right, the flame body, a hotter core toward the top left. Lumpy, never round.
 */
export function fireBall(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, g: number, heat: number, seed: number): void {
  if (r < 0.4) return;
  ctx.fillStyle = heat > 0.55 ? FX.fireDeep : FX.ember;
  blob(ctx, x + g * 0.7, y + g * 0.8, r, g, seed);
  ctx.fillStyle = heat > 0.75 ? FX.fire : heat > 0.35 ? FX.fireDeep : FX.ember;
  blob(ctx, x, y, r * 0.9, g, seed + 1);
  if (heat > 0.3) {
    ctx.fillStyle = heat > 0.7 ? FX.flame : FX.fire;
    blob(ctx, x - r * 0.22 * g, y - r * 0.26 * g, r * 0.55 * Math.min(1, heat + 0.2), g, seed + 2);
  }
  if (heat > 0.78) {
    ctx.fillStyle = FX.hot;
    blob(ctx, x - r * 0.3 * g, y - r * 0.32 * g, r * 0.28 * heat, g, seed + 3);
  }
}

/**
 * Debris and sparks thrown out from (x, y) on ballistic arcs: `n` pieces, `t` 0..1 through their flight, `reach` cells
 * at most; hot (sparks) early, dark chunks after; each a cell or two, falling back toward the ground line.
 */
export function debris(ctx: CanvasRenderingContext2D, x: number, y: number, n: number, t: number, reach: number, g: number, seed: number, ground = true): void {
  if (n <= 0 || t <= 0 || t >= 1) return;
  for (let i = 0; i < n; i++) {
    const a = rnd(seed, i) * Math.PI * 2;
    const sp = reach * (0.55 + 0.45 * rnd(seed, i + 13));
    const up = reach * (0.5 + 0.8 * rnd(seed, i + 29));
    // out along the ground plane (foreshortened), up then down again
    const k = 1 - (1 - t) * (1 - t);
    const px = x + Math.cos(a) * sp * k * g;
    const lift = up * 4 * t * (1 - t) * (ground ? 1 : 0.3) - (ground ? 0 : up * t * t * 1.4);
    const py = y + Math.sin(a) * sp * k * 0.6 * g - lift * g;
    ctx.fillStyle = t < 0.25 ? (i % 2 ? FX.flame : FX.fire) : i % 3 ? FX.debris : FX.soot;
    const s = (t < 0.5 && i % 2 === 0 ? 2 : 1) * g;
    ctx.fillRect(Math.round(px / g) * g, Math.round(py / g) * g, s, s);
  }
}
