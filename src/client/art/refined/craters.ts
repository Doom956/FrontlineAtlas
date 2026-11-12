// The refined style's craters (client only): every blast on land leaves a scorched crater that stays for most of its
// life and then fades out. Close up a small baked bitmap on the sprites' pixel grid (four shapes per size): a ragged
// pit lit on its lower right inner wall (the light comes from the top left), a broken lip of thrown-up earth, mottled
// scorch fading out into the ground and dark rays of ejecta, all in the effects' earth and soot colours (no drawn
// ring, no clean circle). A fresh crater still smokes: thin wisps rise from it and thin out (MotionParams.craterSmoke).
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

/** The crater pixels (RGBA), testable without a canvas. */
export function craterBitmap(r: number, variant: number): { w: number; h: number; data: Uint8ClampedArray } {
  const pad = Math.max(2, Math.ceil(r * 0.75));
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
  // a ragged outline: two wobbles and a little noise per angle
  const wob = (a: number): number => 1 + 0.08 * Math.sin(a * 3 + variant * 1.9) + 0.05 * Math.sin(a * 5 + variant * 0.7) + 0.05 * (rnd(Math.round(a * 6), variant + 2) - 0.5);
  // rays of thrown earth: a few directions where the scorch reaches further
  const rays = 4 + (variant % 3);
  const rayAt = (a: number): number => {
    let best = 0;
    for (let i = 0; i < rays; i++) {
      const ra = rnd(variant + 40, i) * Math.PI * 2;
      let da = Math.abs(a - ra) % (Math.PI * 2);
      if (da > Math.PI) da = Math.PI * 2 - da;
      best = Math.max(best, Math.max(0, 1 - da / 0.28));
    }
    return best;
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = x - cx;
      const dy = y - cy;
      const a = Math.atan2(dy, dx);
      const d = Math.sqrt((dx / r) ** 2 + (dy / ry) ** 2) / wob(a);
      const n = vnoise(x, y, Math.max(2, r * 0.45), variant);
      if (d <= 0.5) {
        // the pit: its lower right inner wall catches the light
        const lit = dx + dy > r * 0.22 && d > 0.28;
        set(x, y, lit ? WALL : PIT, 238);
      } else if (d <= 0.86) {
        set(x, y, n > 0.55 ? SCORCH_LIGHT : SCORCH, 222);
      } else if (d <= 1.12) {
        // the lip of thrown-up earth, broken: lit on the top left, shaded on the bottom right, gaps of scorch
        if (n < 0.28) set(x, y, SCORCH, 200);
        else set(x, y, dx + dy < 0 ? LIP : LIP_SHADE, 205);
      } else {
        // scorch fading out into the ground, mottled, reaching further along the rays
        const ray = rayAt(a) * (n > 0.35 ? 1 : 0.3);
        const reach = 1.4 + 0.4 * ray;
        if (d <= reach && n < 0.7 * (reach - d) * 2.2) set(x, y, SCORCH, Math.round(60 + 70 * (reach - d)));
      }
    }
  }
  // clods of earth thrown around
  const k = 3 + (r >> 2);
  for (let i = 0; i < k; i++) {
    const a = rnd(variant + r, i) * Math.PI * 2;
    const d = r * (1.2 + 0.5 * rnd(r, i + variant));
    set(Math.round(cx + Math.cos(a) * d), Math.round(cy + Math.sin(a) * d * 0.82), i % 2 ? CLOD : LIP_SHADE, 225);
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
      // a fresh crater still smokes: a thin column of wisps rising from the pit close enough to merge, leaning
      // downwind as it climbs, so it reads as one drifting column and not a stack of beads
      const fresh = 1 - c.q / 0.35;
      if (m.craterSmoke > 0 && fresh > 0) {
        const base = Math.max(1.2, cells * 0.6);
        smokeReset();
        for (let i = 0; i < 5; i++) {
          const p = (((c.q * 26 + i / 5 + c.seed) % 1) + 1) % 1;
          const rise = (0.8 + p * 4.8) * base;
          const lean = p * p * 3.2 + Math.sin(p * 5 + i) * 0.5;
          // each wisp swells as it rises and thins away at the top, so the cycle never pops
          smokeAdd(c.x + (rnd(c.seed * 50, i) - 0.5) * cells * 0.6 * g + lean * g, c.y - rise * g, Math.max(0.8, cells * 0.26) * (0.5 + 1.1 * Math.sin(Math.PI * p)), c.seed * 40 + i);
        }
        smokeDraw(ctx, g, 0.5 * m.craterSmoke * fresh * f, FX.smokeDark, FX.smoke, FX.smokeLight);
      }
    }
    ctx.globalAlpha = prevA;
    ctx.imageSmoothingEnabled = prevS;
  },
};
