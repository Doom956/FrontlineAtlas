// The detailed style's craters (client only). A crater is a baked pixel bitmap on the style's grid (four shapes per
// size): a dark pit with its far inner wall catching the light, a rim of thrown-up earth broken into clods (lit on the
// top left, shadowed on the lower right) whose outline and width wander with noise, heavier on one side, scorched
// ground thinning out in uneven rays of soot, and clods of earth scattered round it, all in the earth and soot tones of the style's palette, foreshortened by the 3/4 view. Fresh, it glows with
// a few embers and wisps of smoke rise from it (craterSmoke); then it weathers and fades out by itself. Far out (below
// zoom 3) it is a small dark scorch.
import type { MotionParams } from '../motion';
import { canBake, SpriteAtlas, type RGBABitmap } from '../shared/atlas';
import { hex } from '../shared/colour';
import { rnd } from '../shared/noise';
import type { CraterArt, CraterDraw } from '../types';
import { drawBlob } from './blobs';
import { gridOf } from './grid';
import { SCORCH } from './palette';

const SC = SCORCH.map(hex);
const BAYER = [0.125, 0.625, 0.875, 0.375];

function hash2(x: number, y: number, s: number): number {
  const v = Math.sin(x * 127.1 + y * 311.7 + s * 74.7) * 43758.5453;
  return v - Math.floor(v);
}

/** Smooth value noise 0..1. */
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
/** Noise round the rim: 2D noise sampled on a circle (seamless all the way round), two octaves, 0..1. */
function ringNoise(a: number, freq: number, s: number): number {
  const c = Math.cos(a);
  const n = Math.sin(a);
  return vnoise(c * freq + 9.3, n * freq + 4.1, s) * 0.65 + vnoise(c * freq * 2.3 + 1.7, n * freq * 2.3 + 7.9, s + 1) * 0.35;
}

/**
 * The crater's pixels: radius `r` cells (2..60), shape `variant` (0..3). Origin at the pit's centre. No ring is drawn
 * anywhere: the outline, the rim's width and the reach of the scorch all wander with noise round the crater, the rim
 * is broken into clods with gaps, the earth is thrown further to one side (each variant its own), and the scorch
 * thins out into the ground by dithering instead of ending on an edge.
 */
export function craterBitmap(r: number, variant: number): RGBABitmap {
  const R = Math.max(2, Math.min(60, Math.round(r)));
  const reach = 2;
  const hw = Math.ceil(R * reach) + 2;
  const hh = Math.ceil(R * reach * 0.84) + 2;
  const W = hw * 2 + 1;
  const H = hh * 2 + 1;
  const data = new Uint8ClampedArray(W * H * 4);
  const sd = variant * 17 + 3;
  // the side the earth was thrown to, and how lumpy the outline is (variants differ)
  const heavy = variant * 1.71 + 0.6 + rnd(R, variant) * 0.8;
  const lumps = 1.1 + 0.35 * variant + rnd(variant, R) * 0.4;
  // rays of soot: a few directions where the scorch reaches further
  const rays: [number, number][] = [];
  const nr = 4 + (variant % 3);
  for (let i = 0; i < nr; i++) rays.push([rnd(variant * 7 + R, i) * Math.PI * 2, 0.25 + 0.45 * rnd(variant + R * 3, i + 9)]);
  const rayAt = (a: number): number => {
    let v = 0;
    for (const [ra, len] of rays) {
      const d = Math.abs((((a - ra) % (Math.PI * 2)) + Math.PI * 3) % (Math.PI * 2) - Math.PI);
      v = Math.max(v, len * Math.max(0, 1 - d / 0.38));
    }
    return v;
  };
  const set = (x: number, y: number, c: readonly number[], a: number): void => {
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    const o = (y * W + x) * 4;
    data[o] = c[0];
    data[o + 1] = c[1];
    data[o + 2] = c[2];
    data[o + 3] = a;
  };
  // grain scales with the crater, so a big one has big clods, not pepper
  const gs = Math.max(0.18, Math.min(0.6, 3.2 / R));
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const dx = x - hw;
      const dy = (y - hh) / 0.84;
      const a = Math.atan2(dy, dx);
      const side = Math.cos(a - heavy);
      const shape = 1 + 0.26 * (ringNoise(a, lumps, sd) - 0.5) + 0.06 * side;
      const d = Math.hypot(dx, dy) / (R * shape);
      const dith = BAYER[(x & 1) + ((y & 1) << 1)];
      const grain = hash2(x, y, variant + 3);
      const clump = vnoise(x * gs + variant * 5.1, y * gs, sd + 7);
      const rimIn = 0.6 + 0.12 * (ringNoise(a, lumps * 1.7, sd + 3) - 0.5);
      const rimOut = rimIn + (0.3 + 0.24 * ringNoise(a, lumps * 2.1, sd + 5)) * (1 + 0.38 * side);
      if (d < rimIn) {
        // the pit: darkest at the bottom, shading up its walls; the lower right inner wall faces the light
        const q = d / rimIn;
        const wall = (dx + dy) / (R * rimIn * 1.2);
        let tf = 0.2 + 1.6 * q * q + (q > 0.45 ? wall * 1.5 * q : 0) + (clump - 0.5) * 0.9;
        tf += dith * 0.9;
        set(x, y, SC[Math.max(0, Math.min(4, Math.floor(tf + 0.5)))], 255);
      } else if (d < rimOut) {
        // the rim of thrown earth, broken into clods: lit on their top left, shadowed lower right, gaps of scorch
        const f = (d - rimIn) / (rimOut - rimIn);
        const keep = clump + grain * 0.22 - Math.abs(f - 0.35) * 0.55;
        if (keep < 0.36) {
          // a gap between clods: scorched earth, sometimes thinned out
          if (grain + dith * 0.3 < 0.15 + f * 0.25) continue;
          set(x, y, SC[grain > 0.6 ? 2 : 1], 235);
          continue;
        }
        const lit = (dx + dy) / R + (clump - 0.55) * 1.6 + dith * 0.4;
        set(x, y, SC[lit < -0.35 ? (grain > 0.55 ? 6 : 5) : lit < 0.35 ? 4 : 3], 255);
      } else {
        // scorch thinning out into the ground: dithered, never a hard edge, reaching further along the rays and on the
        // side the earth was thrown to
        const span = 0.35 + rayAt(a) + 0.22 * Math.max(0, side) + 0.12 * ringNoise(a, lumps * 3, sd + 9);
        const f = (d - rimOut) / span;
        if (f >= 1) continue;
        const dens = (1 - f) * (1 - f) * (0.55 + 0.6 * clump);
        if (grain * 0.75 + (dith + 0.5) * 0.25 > dens) continue;
        set(x, y, SC[clump > 0.62 && f < 0.4 ? 3 : grain > 0.5 ? 2 : 1], Math.round(150 + 80 * (1 - f)));
      }
    }
  }
  // clods of earth thrown out, most of them to the heavy side
  const n = 5 + Math.round(R * 0.7);
  for (let i = 0; i < n; i++) {
    const toHeavy = rnd(R + 5, i + variant) < 0.65;
    const a = toHeavy ? heavy + (rnd(variant + R, i) - 0.5) * 2.2 : rnd(variant + R, i) * Math.PI * 2;
    const d = R * (1.1 + (toHeavy ? 0.9 : 0.5) * rnd(R, i + variant));
    const cx = Math.round(hw + Math.cos(a) * d);
    const cy = Math.round(hh + Math.sin(a) * d * 0.84);
    set(cx, cy, SC[5], 255);
    if (R >= 5 && rnd(i, R) > 0.35) {
      set(cx + 1, cy, SC[3], 255);
      set(cx, cy + 1, SC[2], 255);
    }
  }
  return { w: W, h: H, ox: hw, oy: hh, data };
}

const atlas = new SpriteAtlas(1024, 4);

function draw(ctx: CanvasRenderingContext2D, c: CraterDraw, m: MotionParams): void {
  // whole for the first part of its life, then weathering away
  const f = c.q < 0.55 ? 1 : 1 - (c.q - 0.55) / 0.45;
  if (f <= 0.02) return;
  const g = gridOf(c.scale, c.dpr);
  const prevA = ctx.globalAlpha;
  const prevS = ctx.imageSmoothingEnabled;
  ctx.imageSmoothingEnabled = false;
  const cells = c.radiusPx / g.k;
  if (c.zoom < 3 || cells < 2 || !canBake()) {
    // far out: a small dark scorch
    ctx.globalAlpha = prevA * 0.5 * f;
    ctx.fillStyle = SCORCH[1];
    const r = Math.max(1, Math.round(c.radiusPx));
    ctx.fillRect(Math.round(c.x - r), Math.round(c.y - r * 0.8), r * 2, Math.max(1, Math.round(r * 1.6)));
    ctx.fillRect(Math.round(c.x - r * 0.6), Math.round(c.y - r * 1.1), Math.round(r * 1.2), Math.max(1, Math.round(r * 2.2)));
  } else {
    let k = 1;
    while (cells / k > 60) k *= 2;
    const R = Math.round(cells / k);
    const v = Math.floor(c.seed * 4) & 3;
    const e = atlas.get(R * 4 + v, () => craterBitmap(R, v));
    if (e) {
      const cell = g.k * k;
      const x = (Math.round((c.x * g.dpr) / (g.p * k)) * g.p * k) / g.dpr;
      const y = (Math.round((c.y * g.dpr) / (g.p * k)) * g.p * k) / g.dpr;
      // weathered craters lighten as the scorch fades into the ground
      ctx.globalAlpha = prevA * f * (c.q < 0.3 ? 1 : 0.92);
      ctx.drawImage(e.page, e.sx, e.sy, e.w, e.h, x - e.ox * cell, y - e.oy * cell, e.w * cell, e.h * cell);
    }
    // fresh: embers glowing in the pit and wisps of smoke rising
    if (c.q < 0.18) {
      const fresh = 1 - c.q / 0.18;
      const fl = Math.floor(c.q * 400);
      ctx.globalAlpha = prevA * fresh;
      for (let i = 0; i < 3 + (R >> 2); i++) {
        if (rnd(fl, i) < 0.35) continue;
        const a = rnd(c.seed * 50, i) * Math.PI * 2;
        const d = cells * 0.45 * rnd(c.seed * 30, i);
        ctx.fillStyle = rnd(fl, i + 5) > 0.5 ? '#f6a53e' : '#b04a1c';
        ctx.fillRect((Math.round(((c.x + Math.cos(a) * d * g.k) * g.dpr) / g.p) * g.p) / g.dpr, (Math.round(((c.y + Math.sin(a) * d * g.k * 0.84) * g.dpr) / g.p) * g.p) / g.dpr, g.k, g.k);
      }
    }
    if (m.craterSmoke > 0 && c.q < 0.5) {
      const life = 0.5;
      for (let i = 0; i < 3; i++) {
        const ph = (c.q / life) * 2.2 + i / 3 + c.seed;
        const k2 = ph - Math.floor(ph);
        const a = m.craterSmoke * (1 - c.q / life) * (1 - k2) * 0.6;
        const r = Math.max(1, cells * (0.25 + 0.35 * k2));
        drawBlob(ctx, 'smoke', r, i, c.x + (k2 * 0.6 + (i - 1) * 0.2) * c.radiusPx, c.y - k2 * c.radiusPx * 2.2, g, a);
      }
    }
  }
  ctx.globalAlpha = prevA;
  ctx.imageSmoothingEnabled = prevS;
}

export const detailedCraters: CraterArt = { draw };
