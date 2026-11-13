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

/**
 * The rows of a lumpy blob of radius `r` cells: calls `row(dy, left, len)` for each row (cells, relative to the centre
 * cell). The edge swells and dents smoothly over a few rows (lumps), with a little row-to-row grain on small blobs only,
 * and the rows lean a little left or right, so the outline is ragged, not a stamp.
 */
function blobRows(r: number, seed: number, row: (dy: number, left: number, len: number) => void): void {
  const ri = Math.max(0, Math.round(r));
  if (ri === 0) {
    row(0, 0, 1);
    return;
  }
  for (let dy = -ri; dy <= ri; dy++) {
    const lump = 0.5 + 0.5 * Math.sin(dy * (2.4 / Math.max(2, ri * 0.5)) + seed * 2.1);
    const grain = ri > 6 ? 0.03 : 0.12;
    const w = Math.sqrt(Math.max(0, ri * ri - dy * dy)) * (0.86 + 0.18 * lump + grain * (hash(seed, dy + 11) - 0.5)) + 0.35;
    const half = Math.floor(w);
    if (half < 0) continue;
    const off = ri > 2 && Math.abs(dy) < ri - 1 ? Math.round(Math.sin(dy * (1.7 / Math.max(2, ri * 0.4)) + seed * 1.3) * Math.min(2, ri * 0.12 + 0.4)) : 0;
    row(dy, off - half, half * 2 + 1);
  }
}

export function blob(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, g: number, seed: number): void {
  const x0 = Math.round(cx / g) * g;
  const y0 = Math.round(cy / g) * g;
  blobRows(r, seed, (dy, left, len) => ctx.fillRect(x0 + left * g, y0 + dy * g, len * g, g));
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

// Smoke is painted as one mass: the puffs of a group are collected (smokeAdd), then stamped in layered passes onto a
// small cell mask (all the shadow blobs, then all the body blobs, then the lit tops), and the mask is filled run by run
// at the group's alpha. Overlapping puffs therefore merge into one cloud with a top-left light, never a stack of
// see-through discs whose overlaps show as hard rings; and a whole group costs one fill per run of cells, however many
// puffs it has. No scratch canvas: a copy between canvases per group costs far more than it shows.
const SMOKE_MAX = 64;
const smX = new Float32Array(SMOKE_MAX);
const smY = new Float32Array(SMOKE_MAX);
const smR = new Float32Array(SMOKE_MAX);
const smS = new Float32Array(SMOKE_MAX);
let smN = 0;
let mask = new Uint8Array(4096);
/** Runs of the mask: layer, first cell, length, row. */
let runs = new Int32Array(4096);
/** The touched span of each mask row (first cell, one past the last). */
let rowLo = new Int32Array(256);
let rowHi = new Int32Array(256);

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

/** Puffs at least this big (cells) catch the light on their upper left. */
const LIT_MIN = 1.1;

/**
 * Stamps a blob (the same rows as blobRows) onto the smoke mask at cell (cx, cy), in a mask W cells wide and H tall,
 * keeping each row's touched span. A plain function with no callback: it runs for every puff of every smoke group.
 */
function stampBlob(layer: number, cx: number, cy: number, r: number, seed: number, W: number, H: number): void {
  const ri = Math.max(0, Math.round(r));
  for (let dy = -ri; dy <= ri; dy++) {
    const y = cy + dy;
    if (y < 0 || y >= H) continue;
    let left = 0;
    let len = 1;
    if (ri > 0) {
      const lump = 0.5 + 0.5 * Math.sin(dy * (2.4 / Math.max(2, ri * 0.5)) + seed * 2.1);
      const grain = ri > 6 ? 0.03 : 0.12;
      const w = Math.sqrt(Math.max(0, ri * ri - dy * dy)) * (0.86 + 0.18 * lump + grain * (hash(seed, dy + 11) - 0.5)) + 0.35;
      const half = Math.floor(w);
      const off = ri > 2 && Math.abs(dy) < ri - 1 ? Math.round(Math.sin(dy * (1.7 / Math.max(2, ri * 0.4)) + seed * 1.3) * Math.min(2, ri * 0.12 + 0.4)) : 0;
      left = off - half;
      len = half * 2 + 1;
    }
    const a = Math.max(0, cx + left);
    const b = Math.min(W, cx + left + len);
    if (b <= a) continue;
    const o = y * W;
    for (let i = o + a; i < o + b; i++) mask[i] = layer;
    if (a < rowLo[y]) rowLo[y] = a;
    if (b > rowHi[y]) rowHi[y] = b;
  }
}

function smokePasses(ctx: CanvasRenderingContext2D, g: number, dark: string, mid: string, light: string): void {
  // the mask's extent in cells (every blob is centred on a whole cell: round(px / g))
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (let i = 0; i < smN; i++) {
    // a blob reaches at most its radius plus a cell and its two-cell lean; the shadow pass sits a cell further
    const R = Math.round(smR[i]) + 4;
    const cx = smX[i] / g;
    const cy = smY[i] / g;
    if (cx - R < x0) x0 = cx - R;
    if (cx + R > x1) x1 = cx + R;
    if (cy - R < y0) y0 = cy - R;
    if (cy + R > y1) y1 = cy + R;
  }
  x0 = Math.floor(x0);
  y0 = Math.floor(y0);
  const W = Math.ceil(x1) - x0 + 1;
  const H = Math.ceil(y1) - y0 + 1;
  if (W <= 0 || H <= 0 || W * H > 1 << 20) return;
  // the mask is all zero between groups: only the touched span of each row is scanned and cleared again
  if (mask.length < W * H) mask = new Uint8Array(W * H * 2);
  if (rowLo.length < H) {
    rowLo = new Int32Array(H * 2);
    rowHi = new Int32Array(H * 2);
  }
  rowLo.fill(W, 0, H);
  rowHi.fill(0, 0, H);
  const stamp = (layer: number, px: number, py: number, r: number, seed: number): void => stampBlob(layer, Math.round(px / g) - x0, Math.round(py / g) - y0, r, seed, W, H);
  for (let i = 0; i < smN; i++) stamp(1, smX[i] + g * 0.6, smY[i] + g * 0.8, smR[i], smS[i]);
  for (let i = 0; i < smN; i++) stamp(2, smX[i], smY[i], smR[i] - 0.5, smS[i] + 3);
  // the lit tops: only the puffs on the upper side of the mass catch the light, so it reads as one cloud, not a stack
  // of spotted beads
  let my = 0;
  for (let i = 0; i < smN; i++) my += smY[i];
  my /= Math.max(1, smN);
  for (let i = 0; i < smN; i++) if (smR[i] >= LIT_MIN && (smN < 3 || smY[i] <= my + smR[i] * g * 0.2)) stamp(3, smX[i] - smR[i] * 0.3 * g, smY[i] - smR[i] * 0.38 * g, smR[i] * 0.48, smS[i] + 5);
  // one scan for the runs of all three layers, then one colour at a time
  let nr = 0;
  for (let y = 0; y < H; y++) {
    const hi = rowHi[y];
    if (hi === 0) continue;
    const row = y * W;
    let x = rowLo[y];
    while (x < hi) {
      const layer = mask[row + x];
      if (layer === 0) {
        x++;
        continue;
      }
      const s0 = x;
      while (x < hi && mask[row + x] === layer) x++;
      if (nr * 4 + 4 > runs.length) {
        const bigger = new Int32Array(runs.length * 2);
        bigger.set(runs);
        runs = bigger;
      }
      runs[nr * 4] = layer;
      runs[nr * 4 + 1] = s0;
      runs[nr * 4 + 2] = x - s0;
      runs[nr * 4 + 3] = y;
      nr++;
    }
    for (let i = row + rowLo[y]; i < row + hi; i++) mask[i] = 0;
  }
  const cols = [dark, mid, light];
  for (let layer = 1; layer <= 3; layer++) {
    ctx.fillStyle = cols[layer - 1];
    for (let r = 0; r < nr; r++) if (runs[r * 4] === layer) ctx.fillRect((x0 + runs[r * 4 + 1]) * g, (y0 + runs[r * 4 + 3]) * g, runs[r * 4 + 2] * g, g);
  }
}

/** Draws the smoke group built with smokeAdd at `alpha` and empties it. */
export function smokeDraw(ctx: CanvasRenderingContext2D, g: number, alpha: number, dark: string = FX.soot, mid: string = FX.smokeDark, light: string = FX.smoke): void {
  if (smN === 0) return;
  if (alpha > 0.01) {
    const prev = ctx.globalAlpha;
    ctx.globalAlpha = prev * Math.min(1, alpha);
    if (smN === 1) {
      // a lone puff overlaps nothing: its three blobs straight onto the map
      ctx.fillStyle = dark;
      blob(ctx, smX[0] + g * 0.6, smY[0] + g * 0.8, smR[0], g, smS[0]);
      ctx.fillStyle = mid;
      blob(ctx, smX[0], smY[0], smR[0] - 0.5, g, smS[0] + 3);
      if (smR[0] >= LIT_MIN) {
        ctx.fillStyle = light;
        blob(ctx, smX[0] - smR[0] * 0.3 * g, smY[0] - smR[0] * 0.38 * g, smR[0] * 0.48, g, smS[0] + 5);
      }
    } else smokePasses(ctx, g, dark, mid, light);
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

// Fire is painted like smoke, as one mass: the balls of a cluster are collected (fireAdd) and drawn in layered passes
// over all of them (the soot behind, then the ember rims, the bodies, the billows, the flame and the white-hot cores),
// so one ball's dark rim never lands inside another's core as a black speck.
const FIRE_MAX = 16;
const fiX = new Float32Array(FIRE_MAX);
const fiY = new Float32Array(FIRE_MAX);
const fiR = new Float32Array(FIRE_MAX);
const fiH = new Float32Array(FIRE_MAX);
const fiS = new Float32Array(FIRE_MAX);
let fiN = 0;

/** Starts a new fire cluster. */
export function fireReset(): void {
  fiN = 0;
}

/** Adds a ball of fire (centre px, radius cells, heat 0..1, its own lumpiness) to the cluster being built. */
export function fireAdd(x: number, y: number, r: number, heat: number, seed: number): void {
  if (fiN < FIRE_MAX && r >= 0.4) {
    fiX[fiN] = x;
    fiY[fiN] = y;
    fiR[fiN] = r;
    fiH[fiN] = heat;
    fiS[fiN] = seed;
    fiN++;
  }
}

/** The tones of a ball at a heat: its rim, body and billow light (the fire cooling from the outside in). */
const fireRim = (heat: number): string => (heat > 0.55 ? FX.fireDeep : FX.ember);
const fireBody = (heat: number): string => (heat > 0.6 ? FX.fire : heat > 0.32 ? FX.fireDeep : FX.ember);
const fireLit = (heat: number): string => (heat > 0.55 ? FX.flame : heat > 0.3 ? FX.fire : FX.fireDeep);

/**
 * Draws the fire cluster built with fireAdd and empties it. Each ball at its heat (1 = just burst, white-hot inside; 0
 * = cooling to embers): a white-hot core toward the top left, then flame, fire and a deep red rim on the lower right,
 * and as it cools soot rolling in from its upper edge (behind the fire, so it shows only round the outside). Lumpy,
 * never round.
 */
export function fireDraw(ctx: CanvasRenderingContext2D, g: number): void {
  const n = fiN;
  fiN = 0;
  // soot first: it shows only where it reaches past the fire
  for (let i = 0; i < n; i++) {
    const r = fiR[i];
    const heat = fiH[i];
    if (heat >= 0.62 || r < 1.8) continue;
    const k = Math.min(1, (0.62 - heat) / 0.45);
    const x = fiX[i];
    const y = fiY[i];
    const seed = fiS[i];
    ctx.fillStyle = FX.smokeDark;
    blob(ctx, x + r * 0.42 * g, y - r * 0.62 * g, r * (0.3 + 0.3 * k), g, seed + 31);
    ctx.fillStyle = FX.soot;
    blob(ctx, x + r * 0.7 * g, y - r * 0.2 * g, r * (0.22 + 0.28 * k), g, seed + 32);
    if (k > 0.4) {
      ctx.fillStyle = FX.smokeDark;
      blob(ctx, x - r * 0.5 * g, y - r * 0.62 * g, r * 0.34 * k, g, seed + 33);
    }
  }
  for (let i = 0; i < n; i++) {
    ctx.fillStyle = fireRim(fiH[i]);
    blob(ctx, fiX[i] + g * 0.7, fiY[i] + g * 0.8, fiR[i], g, fiS[i]);
  }
  for (let i = 0; i < n; i++) {
    ctx.fillStyle = fireBody(fiH[i]);
    blob(ctx, fiX[i], fiY[i], fiR[i] * 0.9, g, fiS[i] + 1);
  }
  // a big ball is not one flat slab: it rolls in billows, each lit on its upper left and shaded on its lower right
  // (small ones keep the plain core: a billow under a cell across shows nothing and only costs fills)
  for (let i = 0; i < n; i++) {
    const r = fiR[i];
    if (r < 3.5) continue;
    const rim = fireRim(fiH[i]);
    const body = fireBody(fiH[i]);
    const lit = fireLit(fiH[i]);
    const seed = fiS[i];
    const m = r >= 8 ? 4 : 3;
    for (let j = 0; j < m; j++) {
      const a = Math.PI * (0.55 + 1.5 * (j / m)) + (hash(seed, j + 7) - 0.5) * 0.9;
      const d = r * (0.32 + 0.22 * hash(seed, j + 17));
      const bx = fiX[i] + Math.cos(a) * d * g;
      const by = fiY[i] + Math.sin(a) * d * 0.85 * g;
      const br = r * (0.26 + 0.12 * hash(seed, j + 27));
      ctx.fillStyle = rim;
      blob(ctx, bx + g * 0.6, by + g * 0.7, br, g, seed + 11 + j);
      ctx.fillStyle = j === 0 || fiH[i] > 0.5 ? lit : body;
      blob(ctx, bx - br * 0.15 * g, by - br * 0.2 * g, br * 0.72, g, seed + 21 + j);
    }
  }
  // the hot heart: flame, then white-hot at the very centre while it is young
  for (let i = 0; i < n; i++) {
    const heat = fiH[i];
    if (heat <= 0.28) continue;
    const r = fiR[i];
    ctx.fillStyle = heat > 0.55 ? FX.flame : FX.fire;
    blob(ctx, fiX[i] - r * 0.2 * g, fiY[i] - r * 0.24 * g, r * 0.5 * Math.min(1, heat + 0.2), g, fiS[i] + 2);
  }
  for (let i = 0; i < n; i++) {
    const heat = fiH[i];
    if (heat <= 0.6) continue;
    const r = fiR[i];
    ctx.fillStyle = FX.hot;
    blob(ctx, fiX[i] - r * 0.28 * g, fiY[i] - r * 0.3 * g, r * 0.26 * heat, g, fiS[i] + 3);
  }
}

/** One ball of fire on its own (a cluster of one). */
export function fireBall(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, g: number, heat: number, seed: number): void {
  fiN = 0;
  fireAdd(x, y, r, heat, seed);
  fireDraw(ctx, g);
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
