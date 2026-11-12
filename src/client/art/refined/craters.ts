// The refined style's craters (client only): every blast on land leaves a scorched crater that stays for most of its
// life and then fades out. Close up a small baked bitmap on the sprites' pixel grid (four shapes per size): a ragged
// pit lit on its lower right inner wall (the light comes from the top left), an uneven lip of thrown-up earth, heavier
// on one side and broken in places, mottled scorch dithered out into the ground along rays of ejecta of different
// lengths and scattered clods, all in the effects' earth and soot colours; every boundary is broken by noise, so it never
// reads as concentric bands. A fresh crater still smokes: one leaning plume widening as it rises, thinning at the top
// (MotionParams.craterSmoke).
// At the middle zooms a small ragged dark patch.
import type { MotionParams } from '../motion';
import { rnd } from '../shared/noise';
import type { CraterArt, CraterDraw } from '../types';
import { FX, smokeAdd, smokeDraw, smokeReset } from './fxCommon';
import { oklch } from './palette';

const craterCache = new Map<number, HTMLCanvasElement | null>();
function craterSprite(r: number, variant: number): HTMLCanvasElement | null {
  const key = r * 4 + variant;
  const hit = craterCache.get(key);
  if (hit !== undefined) return hit;
  let cv: HTMLCanvasElement | null = null;
  if (typeof document !== 'undefined') {
    const bm = craterBitmap(r, variant);
    cv = document.createElement('canvas');
    cv.width = bm.w;
    cv.height = bm.h;
    const ctx = cv.getContext('2d');
    if (ctx && typeof ImageData !== 'undefined') ctx.putImageData(new ImageData(bm.data, bm.w, bm.h), 0, 0);
    else cv = null;
  }
  if (craterCache.size > 300) craterCache.clear();
  craterCache.set(key, cv);
  return cv;
}

/** Smooth value noise (0..1) on a grid of `cell` px, for the mottled scorch. */
function vnoise(x: number, y: number, cell: number, s: number): number {
  const gx = x / cell;
  const gy = y / cell;
  const x0 = Math.floor(gx);
  const y0 = Math.floor(gy);
  const fx = gx - x0;
  const fy = gy - y0;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const h = (a: number, b: number): number => rnd(a * 57 + b * 131 + s * 17, 3);
  const a = h(x0, y0);
  const b = h(x0 + 1, y0);
  const c = h(x0, y0 + 1);
  const d = h(x0 + 1, y0 + 1);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}

const PIT = oklch(0.2, 0.01, 60);
const WALL = oklch(0.4, 0.03, 65);
const SCORCH = oklch(0.27, 0.012, 60);
const SCORCH_LIGHT = oklch(0.34, 0.018, 65);
const LIP = oklch(0.62, 0.035, 78);
const LIP_SHADE = oklch(0.47, 0.03, 70);
const CLOD = oklch(0.32, 0.02, 60);

/**
 * The crater pixels (RGBA), testable without a canvas. No band follows a circle: every boundary (pit, inner slope, lip,
 * scorch) is pushed in and out by its own noise, the thrown-up earth is heavier on one side (variant) and broken in
 * places, the scorch reaches out in rays of ejecta of different lengths, and clods lie scattered round it.
 */
export function craterBitmap(r: number, variant: number): { w: number; h: number; data: Uint8ClampedArray } {
  const pad = Math.max(2, Math.ceil(r * 0.8));
  const w = r * 2 + 1 + pad * 2;
  const h = Math.ceil(r * 1.7) + 1 + pad * 2;
  const data = new Uint8ClampedArray(w * h * 4);
  const cx = Math.floor(w / 2);
  const cy = Math.floor(h / 2);
  const set = (x: number, y: number, c: readonly number[], a: number): void => {
    if (x < 0 || y < 0 || x >= w || y >= h) return;
    const o = (y * w + x) * 4;
    data[o] = c[0];
    data[o + 1] = c[1];
    data[o + 2] = c[2];
    data[o + 3] = a;
  };
  const ry = r * 0.82;
  // the side the earth was thrown toward (heavier lip, longer rays there)
  const heavy = rnd(variant + 7, 1) * Math.PI * 2;
  // a ragged outline from smooth wobbles only (no per-sector steps, which leave lobes stuck to the rim)
  const wob = (a: number): number => 1 + 0.07 * Math.sin(a * 3 + variant * 1.9) + 0.045 * Math.sin(a * 5 + variant * 0.7) + 0.03 * Math.sin(a * 7 + variant * 2.3);
  // rays of thrown earth: a few directions (more on the heavy side) where the scorch reaches further, each its own length
  const rays = 5 + (variant % 3);
  const rayDir: number[] = [];
  const rayLen: number[] = [];
  for (let i = 0; i < rays; i++) {
    const side = rnd(variant + 40, i + 9) < 0.6;
    rayDir.push(side ? heavy + (rnd(variant + 40, i) - 0.5) * 2.2 : rnd(variant + 40, i) * Math.PI * 2);
    rayLen.push(0.35 + 0.6 * rnd(variant + 41, i));
  }
  const rayAt = (a: number): number => {
    let best = 0;
    for (let i = 0; i < rays; i++) {
      let da = Math.abs(a - rayDir[i]) % (Math.PI * 2);
      if (da > Math.PI) da = Math.PI * 2 - da;
      best = Math.max(best, Math.max(0, 1 - da / 0.22) * rayLen[i]);
    }
    return best;
  };
  const fine = Math.max(2.4, r * 0.22);
  // small craters take less edge noise: at a few pixels across it would only read as grain
  const jag = r < 8 ? 0.14 : 0.22;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = x - cx;
      const dy = y - cy;
      const a = Math.atan2(dy, dx);
      const n = vnoise(x, y, Math.max(2, r * 0.45), variant);
      const nf = vnoise(x, y, fine, variant + 11);
      // the distance from the middle, pushed in and out by the fine noise so no boundary is a clean curve
      const d = Math.sqrt((dx / r) ** 2 + (dy / ry) ** 2) / wob(a) + (nf - 0.5) * jag;
      const side = Math.cos(a - heavy);
      // the lip is thicker toward the heavy side, thin and broken on the other
      const lipOut = 1.02 + 0.16 * side + 0.06 * (n - 0.5);
      const lit = dx + dy < 0;
      if (d <= 0.46) {
        // the pit: its lower right inner wall catches the light, the rest dark, a little mottled
        const wall = dx + dy > r * 0.18 && d > 0.24;
        set(x, y, wall ? (n > 0.62 ? SCORCH_LIGHT : WALL) : n > 0.7 ? SCORCH : PIT, 238);
      } else if (d <= 0.8) {
        // the inner slope: lit where it faces the light (lower right), shaded where it faces away, broken by the noise
        const tone = !lit ? (nf > 0.38 ? WALL : SCORCH_LIGHT) : nf > 0.66 ? SCORCH_LIGHT : SCORCH;
        set(x, y, tone, 226);
      } else if (d <= lipOut) {
        // the lip of thrown-up earth: lit on the top left, shaded on the bottom right, broken in places
        const broken = nf < 0.3 + 0.18 * (1 - side);
        if (broken) set(x, y, n > 0.5 ? SCORCH_LIGHT : SCORCH, 190);
        else set(x, y, lit ? (nf > 0.7 ? LIP_SHADE : LIP) : nf > 0.72 ? LIP : LIP_SHADE, 210);
      } else {
        // scorch fading out into the ground, mottled and dithered, reaching further along the rays
        const reach = lipOut + 0.22 + 0.15 * side + rayAt(a) * (0.55 + 0.45 * n);
        const k = (reach - d) / Math.max(0.1, reach - lipOut);
        if (k > 0 && nf < 0.25 + 0.75 * k) set(x, y, k > 0.55 && n < 0.45 ? CLOD : SCORCH, Math.round(70 + 110 * Math.min(1, k)));
      }
    }
  }
  // clods of earth thrown round it, more on the heavy side, some two cells across
  const k = 4 + Math.round(r * 0.7);
  for (let i = 0; i < k; i++) {
    const toHeavy = rnd(variant + r, i + 30) < 0.6;
    const a = toHeavy ? heavy + (rnd(variant + r, i) - 0.5) * 2.4 : rnd(variant + r, i) * Math.PI * 2;
    const d = r * (1.15 + 0.75 * rnd(r, i + variant));
    const X = Math.round(cx + Math.cos(a) * d);
    const Y = Math.round(cy + Math.sin(a) * d * 0.82);
    const c = i % 3 === 0 ? LIP : i % 3 === 1 ? CLOD : LIP_SHADE;
    set(X, Y, c, 225);
    if (r >= 6 && i % 2 === 0) set(X + 1, Y, i % 4 === 0 ? LIP_SHADE : CLOD, 225);
  }
  return { w, h, data };
}

export const refinedCraters: CraterArt = {
  draw(ctx: CanvasRenderingContext2D, c: CraterDraw, m: MotionParams): void {
    // full for the first 60 % of its life, then fading out
    const f = c.q < 0.6 ? 1 : 1 - (c.q - 0.6) / 0.4;
    if (f <= 0.02) return;
    const prevA = ctx.globalAlpha;
    const prevS = ctx.imageSmoothingEnabled;
    ctx.imageSmoothingEnabled = false;
    const R = c.radiusPx;
    const g = c.scale;
    if (c.zoom < 3) {
      // middle zooms: a small ragged dark patch
      ctx.globalAlpha = prevA * 0.42 * f;
      ctx.fillStyle = FX.soot;
      const r = Math.max(1, Math.round(R));
      const X = Math.round(c.x);
      const Y = Math.round(c.y);
      const v = Math.round(c.seed * 3);
      ctx.fillRect(X - r, Y - Math.round(r * 0.5), r * 2, Math.max(1, Math.round(r)));
      ctx.fillRect(X - r + 1 + (v % 2), Y - Math.round(r * 0.8), Math.max(1, r * 2 - 2), Math.max(1, Math.round(r * 1.6)));
    } else {
      const cells = Math.max(2, Math.min(40, Math.round(R / g)));
      const img = craterSprite(cells, Math.floor(c.seed * 4));
      if (img) {
        ctx.globalAlpha = prevA * f;
        const s = img.width * g;
        ctx.drawImage(img, Math.round(c.x - s / 2), Math.round(c.y - (img.height * g) / 2), s, img.height * g);
      }
      // a fresh crater still smokes: one plume rising from the pit, leaning downwind and widening as it climbs. Its
      // puffs overlap so closely that the smoke painter merges them into one continuous column (they scroll upward,
      // so it rises without popping), and the top puffs shrink away, so the plume thins out at the top.
      const fresh = 1 - c.q / 0.35;
      if (m.craterSmoke > 0 && fresh > 0) {
        const base = Math.max(1, cells * 0.42);
        const N = 8;
        const flow = (((c.q * 30 + c.seed) % 1) + 1) % 1;
        smokeReset();
        for (let i = 0; i < N; i++) {
          const p = (i + flow) / N;
          const rise = (0.6 + p * 5.5) * base;
          const lean = p * p * 3.4 * base + Math.sin(p * 6 + c.seed * 9) * 0.4;
          smokeAdd(c.x + lean * g, c.y - rise * g, base * (0.55 + 0.9 * p) * Math.min(1, (1 - p) * 3.5), c.seed * 40 + i);
        }
        smokeDraw(ctx, g, 0.5 * m.craterSmoke * fresh * f, FX.smokeDark, FX.smoke, FX.smokeLight);
      }
    }
    ctx.globalAlpha = prevA;
    ctx.imageSmoothingEnabled = prevS;
  },
};
