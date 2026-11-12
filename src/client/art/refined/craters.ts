// The refined style's craters (client only): every blast on land leaves a scorch mark (a dark pit, a lighter rim,
// debris pixels) that stays for most of its life and then fades out. Close up a small baked bitmap on the sprites'
// pixel grid (four shapes per size); at the middle zooms a plain dark spot.
import type { MotionParams } from '../motion';
import { rnd } from '../shared/noise';
import type { CraterArt, CraterDraw } from '../types';

/**
 * A crater as a small baked bitmap (cells across = 2 * radius + 4): a scorched disc, a darker pit lit on its lower
 * right inner wall (the light comes from the top left), a light earth rim on the top left of the raised edge, and a
 * few debris pixels around. Four shapes per size.
 */
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

/** The crater pixels (RGBA), testable without a canvas. */
export function craterBitmap(r: number, variant: number): { w: number; h: number; data: Uint8ClampedArray } {
  const pad = Math.max(2, Math.ceil(r * 0.6));
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
  const SCORCH = [40, 33, 28];
  const PIT = [22, 18, 16];
  const WALL = [92, 74, 58];
  const RIM = [168, 146, 112];
  const RIM_SHADE = [112, 94, 72];
  const ry = r * 0.82;
  const wob = (a: number): number => 1 + 0.12 * Math.sin(a * 3 + variant * 1.9) + 0.06 * Math.sin(a * 5 + variant);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = x - cx;
      const dy = y - cy;
      const a = Math.atan2(dy, dx);
      const d = Math.sqrt((dx / r) ** 2 + (dy / ry) ** 2) / wob(a);
      if (d <= 0.5) {
        // the pit: its lower right inner wall catches the light
        const lit = dx + dy > r * 0.25 && d > 0.3;
        set(x, y, lit ? WALL : PIT, 235);
      } else if (d <= 0.92) set(x, y, SCORCH, 215);
      else if (d <= 1.12) {
        // the raised rim: light on the top left, shaded on the bottom right
        set(x, y, dx + dy < 0 ? RIM : RIM_SHADE, 200);
      } else if (d <= 1.45) {
        // scorched ground fading out, broken up
        if (rnd(x * 31 + y * 17, variant + 5) < 0.42 * (1.45 - d) * 2.2) set(x, y, SCORCH, 120);
      }
    }
  }
  // debris pixels thrown around
  const n = 3 + (r >> 2);
  for (let i = 0; i < n; i++) {
    const a = rnd(variant + r, i) * Math.PI * 2;
    const d = r * (1.25 + 0.45 * rnd(r, i + variant));
    set(Math.round(cx + Math.cos(a) * d), Math.round(cy + Math.sin(a) * d * 0.82), i % 2 ? PIT : RIM_SHADE, 230);
  }
  return { w, h, data };
}

export const refinedCraters: CraterArt = {
  draw(ctx: CanvasRenderingContext2D, c: CraterDraw, m: MotionParams): void {
    void m; // TODO(refined): smoke on fresh craters (m.craterSmoke)
    // full for the first 60 % of its life, then fading out
    const f = c.q < 0.6 ? 1 : 1 - (c.q - 0.6) / 0.4;
    if (f <= 0.02) return;
    const prevA = ctx.globalAlpha;
    const prevS = ctx.imageSmoothingEnabled;
    ctx.imageSmoothingEnabled = false;
    const R = c.radiusPx;
    const g = c.scale;
    if (c.zoom < 3) {
      // middle zooms: a plain dark spot
      ctx.globalAlpha = prevA * 0.45 * f;
      ctx.fillStyle = '#211b17';
      const r = Math.max(1, Math.round(R));
      ctx.fillRect(Math.round(c.x - r), Math.round(c.y - r * 0.8), r * 2, Math.max(1, Math.round(r * 1.6)));
    } else {
      const cells = Math.max(2, Math.min(40, Math.round(R / g)));
      const img = craterSprite(cells, Math.floor(c.seed * 4));
      if (img) {
        ctx.globalAlpha = prevA * f;
        const s = img.width * g;
        ctx.drawImage(img, Math.round(c.x - s / 2), Math.round(c.y - (img.height * g) / 2), s, img.height * g);
      }
    }
    ctx.globalAlpha = prevA;
    ctx.imageSmoothingEnabled = prevS;
  },
};
