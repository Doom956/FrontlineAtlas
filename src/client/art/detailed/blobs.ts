// The detailed style's puffs (client only): smoke, soot, dust, spray and fire as small baked pixel blobs. A blob is a
// lumpy round mass (its edge wobbles with the angle, never a clean circle) shaded like a ball lit from the top left
// with a billowing noise inside, in one 4-tone ramp (smoke, soot, dust, spray) or, for fire, by temperature from a
// white-hot core to a red edge. Every explosion, crater wisp, wake foam patch, contrail puff and gun smoke of the style
// is built from these, so the effects share one look and one palette, and drawing one is a single drawImage from an
// atlas (cheap with many on screen). Pure bitmaps (testable without a canvas) plus the atlas lookup.
import { canBake, SpriteAtlas, type AtlasEntry, type RGBABitmap } from '../shared/atlas';
import { hex, type RGB } from '../shared/colour';
import type { Grid } from './grid';
import { DUST, FIRE, SMOKE, SOOT, SPRAY } from './palette';

export type BlobKind = 'smoke' | 'soot' | 'dust' | 'spray' | 'fire';
const KINDS: BlobKind[] = ['smoke', 'soot', 'dust', 'spray', 'fire'];

const RAMP: Record<Exclude<BlobKind, 'fire'>, RGB[]> = {
  smoke: SMOKE.map(hex),
  soot: SOOT.map(hex),
  dust: DUST.map(hex),
  spray: SPRAY.map(hex),
};
const FIRE_RGB: RGB[] = FIRE.map(hex);

const BAYER = [-0.375, 0.125, 0.375, -0.125];

function hash2(x: number, y: number, s: number): number {
  const v = Math.sin(x * 127.1 + y * 311.7 + s * 74.7) * 43758.5453;
  return v - Math.floor(v);
}
function vnoise(x: number, y: number, s: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const a = hash2(x0, y0, s);
  const b = hash2(x0 + 1, y0, s);
  const c = hash2(x0, y0 + 1, s);
  const d = hash2(x0 + 1, y0 + 1, s);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}

/**
 * A blob's pixels: radius `r` cells (1..48), shape `variant` (0..3), and for fire the heat (0 white hot .. 4 cooling
 * to red and brown). The origin (ox, oy) is the blob's centre.
 */
export function blobBitmap(kind: BlobKind, r: number, variant: number, heat = 0): RGBABitmap {
  const R = Math.max(1, Math.min(48, Math.round(r)));
  const half = Math.ceil(R * 1.22) + 1;
  const W = half * 2 + 1;
  const data = new Uint8ClampedArray(W * W * 4);
  const ph = variant * 1.731 + 0.4;
  const s = variant * 13 + R;
  const ramp = kind === 'fire' ? null : RAMP[kind];
  for (let y = 0; y < W; y++) {
    for (let x = 0; x < W; x++) {
      const dx = x - half;
      const dy = y - half;
      const a = Math.atan2(dy, dx);
      // a lumpy edge: billows of a few sizes round the rim, bigger toward the top (a puff rises)
      let e = R * (0.9 + 0.11 * Math.sin(3 * a + ph) + 0.07 * Math.sin(5 * a + ph * 2.3) + 0.04 * Math.sin(8 * a + ph * 3.1));
      if (R >= 3) e *= 1 + 0.06 * Math.max(0, -Math.sin(a));
      if (R <= 1) e = 1.15;
      else if (R === 2) e = 2.05 + 0.18 * Math.sin(2 * a + ph);
      const d = Math.hypot(dx, dy);
      if (d > e) continue;
      const o = (y * W + x) * 4;
      const nx = dx / e;
      const ny = dy / e;
      const nz = Math.sqrt(Math.max(0, 1 - nx * nx - ny * ny));
      const grain = vnoise(x * 0.42 + variant * 3.1, y * 0.42, s) - 0.5;
      const dith = BAYER[(x & 1) + ((y & 1) << 1)];
      let c: RGB;
      if (ramp) {
        // a ball lit from the top left, billowing inside
        const lum = -0.55 * nx - 0.62 * ny + 0.55 * nz + grain * 0.5;
        // dust is soft (a narrow range of tones), smoke and soot billow with more contrast
        const soft = kind === 'dust' ? 0.55 : kind === 'spray' ? 0.8 : 1;
        const tf = 1.6 + ((lum + 0.25) * 2.6 - 1.6) * soft;
        let t = Math.max(0, Math.min(3, Math.floor(tf + 0.5 + dith * 0.45)));
        // the lower right rim a tone deeper
        if (d > e - 1.05 && dx + dy > 0 && kind !== 'dust') t = Math.min(t, 1);
        c = ramp[t];
      } else {
        // fire by temperature: hot core (a little up and left), cooling outward, flickering grain
        const q = d / e;
        let temp = 1 - q * 0.95 + grain * 0.55 - (dx + dy) / (e * 6);
        temp -= heat * 0.17;
        const idx = Math.max(0, Math.min(6, Math.floor((1 - temp) * 5.2 + dith * 0.9)));
        c = FIRE_RGB[idx];
      }
      data[o] = c[0];
      data[o + 1] = c[1];
      data[o + 2] = c[2];
      data[o + 3] = 255;
    }
  }
  return { w: W, h: W, ox: half, oy: half, data };
}

// ------------------------------------------------------------------------------------------------- drawing

const atlas = new SpriteAtlas(1024, 6);

function entry(kind: BlobKind, r: number, variant: number, heat: number): AtlasEntry | null {
  const R = Math.max(1, Math.min(48, Math.round(r)));
  const v = variant & 3;
  const h = kind === 'fire' ? Math.max(0, Math.min(4, Math.round(heat))) : 0;
  const key = ((KINDS.indexOf(kind) * 64 + R) * 4 + v) * 8 + h;
  return atlas.get(key, () => blobBitmap(kind, R, v, h));
}

/**
 * Draws a blob centred at (x, y) CSS px, `r` cells of grid `g` (bigger than 48 cells: drawn with coarser cells),
 * at `alpha`. Fire heat 0..4. Returns false when it could not be drawn (no canvas).
 */
export function drawBlob(ctx: CanvasRenderingContext2D, kind: BlobKind, r: number, variant: number, x: number, y: number, g: Grid, alpha = 1, heat = 0): boolean {
  if (alpha <= 0.01 || r < 0.5) return true;
  let f = 1;
  while (r / f > 40) f *= 2;
  const e = entry(kind, r / f, variant, heat);
  if (!e) return false;
  const k = g.k * f;
  const cx = (Math.round((x * g.dpr) / (g.p * f)) * g.p * f) / g.dpr;
  const cy = (Math.round((y * g.dpr) / (g.p * f)) * g.p * f) / g.dpr;
  const prev = ctx.globalAlpha;
  const sm = ctx.imageSmoothingEnabled;
  ctx.imageSmoothingEnabled = false;
  ctx.globalAlpha = prev * Math.min(1, alpha);
  ctx.drawImage(e.page, e.sx, e.sy, e.w, e.h, cx - e.ox * k, cy - e.oy * k, e.w * k, e.h * k);
  ctx.globalAlpha = prev;
  ctx.imageSmoothingEnabled = sm;
  return true;
}

/** True where blobs can be drawn (a DOM canvas). */
export function blobsReady(): boolean {
  return canBake();
}
