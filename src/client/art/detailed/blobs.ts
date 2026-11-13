// The detailed style's puffs (client only): smoke, soot, dust, spray and fire as small baked pixel blobs. A blob is a
// lumpy round mass (its edge wobbles with the angle, never a clean circle) shaded like a ball lit from the top left
// with a billowing noise inside, in one 4-tone ramp (smoke, soot, dust, spray) or, for fire, by temperature from a
// white-hot core to a red edge. Every explosion, crater wisp, wake foam patch, contrail puff and gun smoke of the style
// is built from these, so the effects share one look and one palette, and drawing one is a single drawImage from an
// atlas (cheap with many on screen). Pure bitmaps (testable without a canvas) plus the atlas lookup.
import { canBake, SpriteAtlas, type AtlasEntry, type RGBABitmap } from '../shared/atlas';
import { hex, type RGB } from '../shared/colour';
import type { Grid } from './grid';
import { DUST, FIRE, SHADE, SMOKE, SOOT, SPRAY, VAPOUR } from './palette';

export type BlobKind = 'smoke' | 'soot' | 'dust' | 'spray' | 'fire' | 'vapour' | 'flash' | 'glow' | 'halo' | 'shade' | 'haze';
const KINDS: BlobKind[] = ['smoke', 'soot', 'dust', 'spray', 'fire', 'vapour', 'flash', 'glow', 'halo', 'shade', 'haze'];

const RAMP: Record<Exclude<BlobKind, 'fire' | 'flash' | 'glow' | 'halo' | 'haze'>, RGB[]> = {
  smoke: SMOKE.map(hex),
  soot: SOOT.map(hex),
  dust: DUST.map(hex),
  spray: SPRAY.map(hex),
  vapour: VAPOUR.map(hex),
  shade: SHADE.map(hex),
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
 * The light of a blast on the ground or in the air: a soft lumpy pool, densest in the middle, its alpha falling off in
 * seven dithered steps (no smooth gradient and no ring), white hot in the middle through yellow to an orange edge.
 * 'glow' lies on the ground (squashed by the 3/4 view), 'halo' hangs in the air (round). Radius `r` cells (1..48).
 */
export function glowBitmap(kind: 'glow' | 'halo', r: number, variant: number): RGBABitmap {
  const R = Math.max(1, Math.min(48, Math.round(r)));
  const sq = kind === 'glow' ? 0.6 : 1;
  const half = Math.ceil(R * 1.15) + 1;
  const hy = Math.ceil(R * sq * 1.15) + 1;
  const W = half * 2 + 1;
  const Hh = hy * 2 + 1;
  const data = new Uint8ClampedArray(W * Hh * 4);
  const ph = variant * 1.731 + 0.4;
  const s = variant * 13 + R + 5;
  // seven alpha steps a little apart: the dither between two of them stays quiet even when a big light is drawn
  // with coarse cells
  const ALPHA = [0, 30, 60, 92, 124, 158, 192, 226];
  const COL = [FIRE_RGB[2], FIRE_RGB[2], FIRE_RGB[2], FIRE_RGB[1], FIRE_RGB[1], FIRE_RGB[1], FIRE_RGB[0], FIRE_RGB[0]];
  for (let y = 0; y < Hh; y++) {
    for (let x = 0; x < W; x++) {
      const dx = x - half;
      const dy = (y - hy) / sq;
      const a = Math.atan2(dy, dx);
      const e = R * (0.92 + 0.1 * Math.sin(3 * a + ph) + 0.06 * Math.sin(5 * a + ph * 2.3));
      const d = Math.hypot(dx, dy) / e;
      if (d >= 1) continue;
      const grain = vnoise(x * 0.5 + variant * 3.1, y * 0.5, s) - 0.5;
      const i = (1 - d) ** 1.6 + grain * 0.15;
      const lv = Math.max(0, Math.min(7, Math.floor(i * 8 + 0.4 + BAYER[(x & 1) + ((y & 1) << 1)] * 0.95)));
      if (!lv) continue;
      const o = (y * W + x) * 4;
      const c = COL[lv];
      data[o] = c[0];
      data[o + 1] = c[1];
      data[o + 2] = c[2];
      data[o + 3] = ALPHA[lv];
    }
  }
  return { w: W, h: Hh, ox: half, oy: hy, data };
}

/**
 * A sheet of dust lying low on the ground (the atom bomb's base surge): flat (squashed by the 3/4 view), its edge in
 * big uneven lobes, dense inside and thinning toward the edge in dithered steps, lit a shade lighter toward the top
 * left. Radius `r` cells (1..48).
 */
export function hazeBitmap(r: number, variant: number): RGBABitmap {
  const R = Math.max(1, Math.min(48, Math.round(r)));
  const sq = 0.5;
  const half = Math.ceil(R * 1.3) + 1;
  const hy = Math.ceil(R * sq * 1.3) + 1;
  const W = half * 2 + 1;
  const Hh = hy * 2 + 1;
  const data = new Uint8ClampedArray(W * Hh * 4);
  const ph = variant * 1.731 + 0.9;
  const s = variant * 17 + R + 9;
  const ALPHA = [0, 44, 88, 128, 168, 206];
  const ramp = RAMP.dust;
  for (let y = 0; y < Hh; y++) {
    for (let x = 0; x < W; x++) {
      const dx = x - half;
      const dy = (y - hy) / sq;
      const a = Math.atan2(dy, dx);
      const e = R * (0.86 + 0.16 * Math.sin(3 * a + ph) + 0.11 * Math.sin(5 * a + ph * 2.3) + 0.06 * Math.sin(9 * a + ph * 1.7));
      const d = Math.hypot(dx, dy) / e;
      if (d >= 1) continue;
      const grain = vnoise(x * 0.35 + variant * 3.1, y * 0.6, s) - 0.5;
      const dith = BAYER[(x & 1) + ((y & 1) << 1)];
      const i = (1 - d) ** 0.7 + grain * 0.35;
      const lv = Math.max(0, Math.min(5, Math.floor(i * 5.5 + dith * 0.95)));
      if (!lv) continue;
      const t = Math.max(1, Math.min(3, Math.floor(2 + (-dx - dy * 1.4) / (e * 1.6) + grain * 1.2 + dith * 0.6)));
      const c = ramp[t];
      const o = (y * W + x) * 4;
      data[o] = c[0];
      data[o + 1] = c[1];
      data[o + 2] = c[2];
      data[o + 3] = ALPHA[lv];
    }
  }
  return { w: W, h: Hh, ox: half, oy: hy, data };
}

/**
 * A blob's pixels: radius `r` cells (1..48), shape `variant` (0..3), and for fire the heat (0 white hot .. 4 cooling
 * to red and brown). 'flash' is the white-hot core of a blast's first frames: white through pale yellow to a yellow
 * rim, never red. The origin (ox, oy) is the blob's centre.
 */
export function blobBitmap(kind: BlobKind, r: number, variant: number, heat = 0): RGBABitmap {
  if (kind === 'glow' || kind === 'halo') return glowBitmap(kind, r, variant);
  if (kind === 'haze') return hazeBitmap(r, variant);
  const R = Math.max(1, Math.min(48, Math.round(r)));
  const half = Math.ceil(R * 1.22) + 1;
  const W = half * 2 + 1;
  const data = new Uint8ClampedArray(W * W * 4);
  const ph = variant * 1.731 + 0.4;
  const s = variant * 13 + R;
  const ramp = kind === 'fire' || kind === 'flash' ? null : RAMP[kind];
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
        const soft = kind === 'dust' ? 0.55 : kind === 'spray' || kind === 'vapour' ? 0.8 : 1;
        const tf = 1.6 + ((lum + 0.25) * 2.6 - 1.6) * soft;
        let t = Math.max(0, Math.min(3, Math.floor(tf + 0.5 + dith * 0.45)));
        // the lower right rim a tone deeper
        if (d > e - 1.05 && dx + dy > 0 && kind !== 'dust') t = Math.min(t, 1);
        c = ramp[t];
      } else if (kind === 'flash') {
        // the flash: white hot, a pale yellow skin, a thin yellow rim (a little up and left the hottest)
        const q = d / e + grain * 0.35 + (dx + dy) / (e * 8);
        const idx = q + dith * 0.25 < 0.58 ? 0 : q + dith * 0.25 < 0.86 ? 1 : 2;
        c = FIRE_RGB[idx === 2 && R < 3 ? 1 : idx];
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
  // a soft light or dust sheet drawn with coarse cells (a big one) is smoothed, so its dither never shows as a
  // checkerboard of big squares; every other blob keeps crisp pixels
  ctx.imageSmoothingEnabled = f >= 4 && (kind === 'glow' || kind === 'halo' || kind === 'haze');
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
