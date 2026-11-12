// The detailed style's craters (client only). A crater is a baked pixel bitmap on the style's grid (four shapes per
// size): a dark pit with its far inner wall catching the light, a ragged rim of thrown-up earth lit on the top left and
// shadowed on the lower right, scorched ground spreading out in uneven rays of soot, and clods of earth scattered
// round it, all in the earth and soot tones of the style's palette, foreshortened by the 3/4 view. Fresh, it glows with
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

/** The crater's pixels: radius `r` cells (2..60), shape `variant` (0..3). Origin at the pit's centre. */
export function craterBitmap(r: number, variant: number): RGBABitmap {
  const R = Math.max(2, Math.min(60, Math.round(r)));
  const reach = 1.75;
  const hw = Math.ceil(R * reach) + 2;
  const hh = Math.ceil(R * reach * 0.84) + 2;
  const W = hw * 2 + 1;
  const H = hh * 2 + 1;
  const data = new Uint8ClampedArray(W * H * 4);
  // rays of soot: a few directions where the scorch reaches further
  const rays: [number, number][] = [];
  const nr = 5 + (variant % 3);
  for (let i = 0; i < nr; i++) rays.push([rnd(variant * 7 + R, i) * Math.PI * 2, 0.35 + 0.45 * rnd(variant + R * 3, i + 9)]);
  const rayAt = (a: number): number => {
    let v = 0;
    for (const [ra, len] of rays) {
      let d = Math.abs(a - ra);
      if (d > Math.PI) d = Math.PI * 2 - d;
      v = Math.max(v, len * Math.max(0, 1 - d / 0.32));
    }
    return v;
  };
  const wob = (a: number): number => 1 + 0.1 * Math.sin(a * 3 + variant * 1.9) + 0.06 * Math.sin(a * 7 + variant * 0.7);
  const set = (x: number, y: number, c: readonly number[], a: number): void => {
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    const o = (y * W + x) * 4;
    data[o] = c[0];
    data[o + 1] = c[1];
    data[o + 2] = c[2];
    data[o + 3] = a;
  };
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const dx = x - hw;
      const dy = (y - hh) / 0.84;
      const a = Math.atan2(dy, dx);
      const d = Math.hypot(dx, dy) / (R * wob(a));
      const dith = BAYER[(x & 1) + ((y & 1) << 1)];
      const grain = hash2(x, y, variant + 3);
      if (d <= 0.62) {
        // the pit: darkest at the bottom, its lower right inner wall (facing the light) lit
        const wall = (dx + dy) / (R * 0.62);
        const t = d < 0.3 ? 0 : wall > 0.35 && d > 0.38 ? (grain > 0.7 ? 4 : 3) : 1;
        set(x, y, SC[t], 255);
      } else if (d <= 0.82) {
        set(x, y, SC[grain > 0.75 ? 2 : 1], 255);
      } else if (d <= 1.08) {
        // the raised rim of thrown earth: lit top left, shadowed lower right, ragged
        const lit = dx + dy < -R * 0.1;
        const ragged = hash2(Math.floor(a * 9), variant, 5) * 0.12;
        if (d > 1.08 - ragged && grain < 0.5) continue;
        set(x, y, SC[lit ? (grain > 0.6 ? 6 : 5) : grain > 0.5 ? 3 : 4], 255);
      } else {
        // scorched ground thinning out, further along the rays
        const reachHere = 1.18 + rayAt(a);
        if (d > reachHere) continue;
        const f = (d - 1.08) / (reachHere - 1.08);
        if (f > 0.35 && dith + grain * 0.4 < f * 1.15) continue;
        set(x, y, SC[f < 0.4 ? 1 : 2], f < 0.4 ? 220 : 170);
      }
    }
  }
  // clods of earth thrown round it
  const n = 4 + (R >> 1);
  for (let i = 0; i < n; i++) {
    const a = rnd(variant + R, i) * Math.PI * 2;
    const d = R * (1.2 + 0.55 * rnd(R, i + variant));
    const cx = Math.round(hw + Math.cos(a) * d);
    const cy = Math.round(hh + Math.sin(a) * d * 0.84);
    set(cx, cy, SC[5], 255);
    if (R >= 5) {
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
