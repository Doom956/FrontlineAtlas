// The detailed style's cannon fire (client only), in the same pixels, puffs and palette as the explosions:
//   muzzle flash  out of each barrel of the turret (two tongues side by side) along the line of fire: a white-yellow
//                 core at the muzzle, a long orange tongue of flame, short side jets out of the muzzle brakes, all at
//                 full length in the first frame and drawn back within about a tenth of a second; a soft light thrown
//                 on the deck and the water round it; the fire balling up and cooling ahead of the muzzle; the blast
//                 pressing the water flat (a pale patch, spray thrown off); then a big puff of pale gun smoke pushed out
//                 along the line of fire that slows, swells, rises and drifts off downwind (flashSize, flashTime,
//                 muzzleSmoke). The interface gives a ship's drawing no target, so its turrets cannot train on it: the
//                 flash comes from the gun's resting position (UnitArt.turretPoint) and points at the target. A
//                 battleship's salvo ripples across its turrets because the map fires them 80 ms apart.
//   shell         a bright tracer dot (a white-hot head with a faint glow) and a short trail cooling to orange and red,
//                 lobbed in an arc (shellArc) with its shadow running straight along the ground below it, so the height
//                 reads; it shows once it has cleared the firing ship's hull (its flight starts at the ship's middle)
//   tracer        anti-air fire: bright streaks racing up to the plane, each with a fading tail
//   torpedo       a dark torpedo running just under the surface, its thin bubbly wake drawn out behind it
import type { MotionParams } from '../motion';
import { rnd } from '../shared/noise';
import type { CannonArt, MuzzleDraw, ShellDraw } from '../types';
import { drawBlob, type BlobKind } from './blobs';
import { WIND_X, WIND_Y } from './burning';
import { gridOf, type Grid } from './grid';
import { DEBRIS, FIRE, SPRAY, TRACER } from './palette';

/** The fire of the flash (ms at flashTime 1); the gun smoke takes the rest of flashMs. */
export const FLASH_FIRE_MS = 150;
const SMOKE_MS = 850;
/** Barrels a flash comes out of (a twin turret's guns side by side) and how far apart (model units). */
export const BARRELS = 2;
const GAP = 0.55;
/** How far a shell flies before it shows (CSS px per unit of map scale): clear of the firing ship's hull. */
const CLEAR = 13;

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
const easeOut = (t: number): number => 1 - (1 - t) * (1 - t);
const easeOut3 = (t: number): number => 1 - (1 - t) ** 3;

function flashMs(m: MotionParams): number {
  return (FLASH_FIRE_MS + SMOKE_MS * Math.min(1.6, m.muzzleSmoke)) * m.flashTime;
}

/** A model unit of the flash on screen (CSS px) at map scale `scale`: a little more than the ship's own at mid zoom, so it reads. */
export const flashUnit = (scale: number): number => (scale < 2 ? Math.max(1.4, scale * 1.4) : scale);

/** How long a barrel's tongue of flame is (model units) `tt` ms after the shot (flashSize scales it): full at once, then drawn back. */
export function tongueAt(tt: number, m: MotionParams): number {
  if (tt < 0 || tt >= 95) return 0;
  const full = 12 * m.flashSize;
  return tt < 28 ? full : full * (1 - easeOut((tt - 28) / 67));
}

function speck(ctx: CanvasRenderingContext2D, x: number, y: number, g: Grid, n = 1): void {
  const s = Math.max(1, Math.round(n)) * g.p;
  ctx.fillRect((Math.round((x * g.dpr) / g.p) * g.p) / g.dpr, (Math.round((y * g.dpr) / g.p) * g.p) / g.dpr, s / g.dpr, s / g.dpr);
}

/**
 * A tapered jet of fire from (x, y) along (c, s): `len` cells long, `w` cells wide at its root, white hot at the root,
 * yellow, orange and deep orange toward a ragged tip; hotter along its middle than at its sides. Stepped finer than a
 * cell along its length, so a slanting jet has no gaps.
 */
function jet(ctx: CanvasRenderingContext2D, x: number, y: number, c: number, s: number, len: number, w: number, g: Grid, sd: number, step: number, cool = 0): void {
  const cell = g.k;
  const n = Math.max(1, Math.round(len / 0.7));
  const L = Math.max(1, len);
  for (let j = 0; j <= n; j++) {
    const d = (j / n) * L;
    const q = d / L;
    const hw = (w / 2) * (1 - q) ** 0.7 + 0.35;
    // the tip frays: a cell to either side now and then
    const fray = q > 0.75 ? (rnd(sd + step, j) - 0.5) * 1.6 : 0;
    const half = Math.floor(hw);
    for (let o = -half; o <= half; o++) {
      const edge = half ? Math.abs(o) / (hw + 0.5) : 0;
      const heat = q * 3.3 + edge * 1.3 + cool;
      ctx.fillStyle = FIRE[Math.max(0, Math.min(4, Math.floor(heat)))];
      const off = o + fray;
      speck(ctx, x + (c * d - s * off) * cell, y + (s * d + c * off) * cell, g);
    }
  }
}

function drawMuzzle(ctx: CanvasRenderingContext2D, f: MuzzleDraw, m: MotionParams): void {
  const g = gridOf(f.scale, f.dpr);
  const total = flashMs(m);
  // ms on a flashTime-1 clock: a longer flashTime plays the same flash slower
  const tt = (f.t * total) / Math.max(0.2, m.flashTime);
  const end = total / Math.max(0.2, m.flashTime);
  const U = flashUnit(f.scale);
  const cpu = U / g.k; // cells per model unit
  const c = Math.cos(f.aim);
  const s = Math.sin(f.aim);
  const size = m.flashSize;
  const sd = f.seed * 41;
  const mid = g.res < 1.5;
  const prev = ctx.globalAlpha;
  const still = m.reduced;
  // ---- the light on the deck and the water round the muzzle, out ahead of it (a fifth of a second at most)
  if (!still && tt < 160) {
    const k = tt / 160;
    drawBlob(ctx, 'glow', Math.max(2, 8 * cpu * (0.55 + 0.45 * size) * (0.9 + 0.25 * k)), Math.floor(sd) & 3, f.x + c * 3.5 * U, f.y + s * 3.5 * U, g, 0.8 * (1 - k) ** 1.5);
  }
  // ---- the blast pressing the water flat ahead of the gun, and spray thrown off it
  if (tt < 900) {
    const k = tt / 900;
    drawBlob(ctx, 'foam', Math.max(1, 2.6 * cpu * size * (0.7 + 0.5 * easeOut(k))), Math.floor(sd + 1) & 3, f.x + c * 3.2 * U, f.y + s * 3.2 * U + U, g, 0.4 * (1 - k), k < 0.4 ? 1 : 3);
  }
  if (m.recoil > 0 && tt < 380) {
    const k = tt / 380;
    ctx.fillStyle = SPRAY[3];
    const n = Math.round((mid ? 4 : 7) * (0.6 + 0.4 * m.recoil));
    for (let i = 0; i < n; i++) {
      // a fan of droplets thrown out ahead and to the sides of the blast
      const a = f.aim + (rnd(sd, i + 20) - 0.5) * 2.6;
      const d = (2 + 5.5 * easeOut(k) * (0.6 + 0.4 * rnd(sd, i + 30))) * U * (0.7 + 0.3 * m.recoil);
      const h = 3 * k * (1 - k) * U * (1 + rnd(sd, i + 35));
      ctx.globalAlpha = prev * 0.8 * (1 - k);
      speck(ctx, f.x + Math.cos(a) * d, f.y + Math.sin(a) * d * 0.7 + U - h, g);
    }
    ctx.globalAlpha = prev;
  }
  // ---- gun smoke: pale puffs pushed out along the line of fire, slowing, swelling, rising and drifting downwind
  if (tt > 35) {
    const k = clamp01((tt - 35) / Math.max(1, end - 35));
    const n = mid ? 3 : 5;
    const sec = (tt - 35) / 1000;
    for (let i = n - 1; i >= 0; i--) {
      const push = (2.2 + 2.1 * i) * size * easeOut3(clamp01((tt - 35) / 260));
      const side = (rnd(sd, i) - 0.5) * 1.8;
      const px = f.x + (c * push - s * side) * U + WIND_X * U * sec * 0.8;
      const py = f.y + (s * push + c * side) * U + (WIND_Y - 4) * U * sec * 0.8;
      const r = (1.3 + 0.45 * i) * cpu * (0.65 + 0.35 * size) * (1 + 1.5 * easeOut(k)) * Math.sqrt(Math.min(1.6, m.muzzleSmoke));
      const kind: BlobKind = tt < 110 + i * 25 ? 'smoke' : 'vapour';
      drawBlob(ctx, kind, Math.max(1, r), i, px, py, g, 0.82 * (1 - k) ** 1.3 * Math.min(1, 0.35 + m.muzzleSmoke * 0.65));
    }
  }
  // ---- the fire balling up ahead of the muzzle and cooling as the tongues draw back
  if (tt > 20 && tt < 100) {
    const k = (tt - 20) / 80;
    for (let i = 2; i >= 0; i--) {
      const d = (3 + 2.2 * i) * size * (0.8 + 0.4 * k);
      const side = (rnd(sd, i + 7) - 0.5) * 1.2;
      const r = Math.max(1, (1.6 - 0.3 * i) * cpu * (0.6 + 0.4 * size) * (0.8 + 0.6 * easeOut(k)));
      drawBlob(ctx, 'fire', r, i + 1, f.x + (c * d - s * side) * U, f.y + (s * d + c * side) * U - k * U, g, (1 - k) ** 1.5, Math.min(2, k * 2.4 + i * 0.3));
    }
  }
  // ---- the blast itself: a tongue of flame out of each barrel, side jets, the white-yellow core
  // reduced motion: one still frame of the blast at the start, no flicker
  const tf = still ? (f.t < 0.12 ? 10 : 999) : tt;
  const tongue = tongueAt(tf, m);
  if (tongue > 0.3) {
    const step = still ? 0 : Math.floor(tt / 16);
    const px = -s;
    const py = c;
    const w = Math.max(2, 2.2 * cpu * (0.7 + 0.3 * size));
    // both barrels' tongues: an orange envelope first, then their white and yellow cores over it, so where they
    // overlap they fuse into one broad flame with two tips
    for (let pass = 0; pass < 2; pass++) {
      for (let b = 0; b < BARRELS; b++) {
        const off = (b - (BARRELS - 1) / 2) * 2 * GAP;
        // each barrel its own length, the second a few ms behind
        const len = tongue * (0.88 + 0.24 * rnd(sd, b + 3)) * (b && tf < 6 ? 0.7 : 1);
        if (pass === 0) jet(ctx, f.x + px * off * U, f.y + py * off * U, c, s, len * cpu, w, g, sd + b * 17, step, 0.9);
        else jet(ctx, f.x + px * off * U, f.y + py * off * U, c, s, len * cpu * 0.82, w * 0.45, g, sd + b * 17, step);
      }
    }
    if (tf < 50) {
      // side jets out of the muzzle brakes, short and splayed
      for (const side of [-1, 1]) {
        const a = f.aim + side * 1.25;
        jet(ctx, f.x, f.y, Math.cos(a), Math.sin(a), 3.4 * size * cpu * (1 - tf / 70), Math.max(1.5, w * 0.55), g, sd + side * 31, step, 0.6);
      }
    }
    // the white-yellow core at the muzzle
    if (tf < 60) drawBlob(ctx, 'flash', Math.max(1, 2.5 * cpu * (0.6 + 0.4 * size) * (1 - tf / 110)), Math.floor(sd) & 3, f.x + c * U * 1.2, f.y + s * U * 1.2, g, 1);
  }
  ctx.globalAlpha = prev;
}

function drawShell(ctx: CanvasRenderingContext2D, sh: ShellDraw, m: MotionParams): void {
  const g = gridOf(sh.scale, sh.dpr);
  const { x0, y0, x1, y1, t } = sh;
  const dx = x1 - x0;
  const dy = y1 - y0;
  const dist = Math.hypot(dx, dy) || 1;
  const prev = ctx.globalAlpha;
  if (sh.kind === 'torpedo') {
    // the wake: bubbles drawn out from the launch point to the torpedo, oldest faint
    const cell = g.k;
    const n = Math.max(2, Math.floor((dist * t) / (cell * 1.5)));
    const nx = -dy / dist;
    const ny = dx / dist;
    for (let i = 0; i < n; i++) {
      const q = (i / n) * t;
      const w = (rnd(sh.seed * 13, i) - 0.5) * 1.6;
      ctx.globalAlpha = prev * (0.15 + 0.6 * (i / n));
      ctx.fillStyle = i % 3 === 0 ? SPRAY[3] : SPRAY[2];
      speck(ctx, x0 + dx * q + nx * w * cell, y0 + dy * q + ny * w * cell, g);
    }
    ctx.globalAlpha = prev * 0.9;
    ctx.fillStyle = DEBRIS[1];
    speck(ctx, x0 + dx * t, y0 + dy * t, g, 2);
    ctx.fillStyle = SPRAY[3];
    speck(ctx, x0 + dx * t + (dx / dist) * cell * 2, y0 + dy * t + (dy / dist) * cell * 2, g);
    ctx.globalAlpha = prev;
    return;
  }
  if (sh.kind === 'tracer') {
    // bright streaks racing to the plane, each with a fading tail
    const cell = g.k;
    const ux = dx / dist;
    const uy = dy / dist;
    for (let i = 0; i < 4; i++) {
      const q = t - i * 0.1;
      if (q < 0 || q > 1) continue;
      const hx = x0 + dx * q;
      const hy = y0 + dy * q;
      for (let j = 0; j < 4; j++) {
        ctx.globalAlpha = prev * (1 - j * 0.24);
        ctx.fillStyle = TRACER[Math.min(2, j)];
        speck(ctx, hx - ux * j * cell, hy - uy * j * cell, g);
      }
    }
    ctx.globalAlpha = prev;
    return;
  }
  // a cannon shell lobbed in an arc: hidden until it clears the firing ship's hull (its flight starts at the ship's
  // middle), its shadow straight along the ground, a bright tracer dot with a short trail cooling behind it
  if (dist * t < CLEAR * sh.scale) {
    ctx.globalAlpha = prev;
    return;
  }
  const H = Math.min(70, dist * 0.24) * m.shellArc;
  const at = (q: number): [number, number] => [x0 + dx * q, y0 + dy * q - 4 * H * q * (1 - q)];
  const cell = g.k;
  ctx.globalAlpha = prev * 0.3;
  ctx.fillStyle = '#0a0d10';
  speck(ctx, x0 + dx * t + cell, y0 + dy * t + cell, g, 2);
  const [px, py] = at(t);
  const [qx, qy] = at(Math.max(0, t - 0.01));
  const dl = Math.hypot(px - qx, py - qy) || 1;
  const ux = (px - qx) / dl;
  const uy = (py - qy) / dl;
  // a faint glow round the hot shell, so it reads against the sea and the land
  ctx.globalAlpha = prev;
  drawBlob(ctx, 'halo', Math.max(1.5, 1.6 * g.res), Math.floor(sh.seed * 4) & 3, px, py, g, 0.42);
  // the trail: short and unbroken, yellow behind the head, cooling to orange and a red tail
  const len = Math.max(4, Math.round(3.4 * g.res + 2));
  for (let j = len; j >= 1; j--) {
    const q = j / len;
    ctx.globalAlpha = prev * (1 - q * 0.75);
    ctx.fillStyle = q < 0.3 ? TRACER[1] : q < 0.65 ? TRACER[2] : FIRE[4];
    speck(ctx, px - ux * j * cell, py - uy * j * cell, g);
  }
  // the head: a white-hot dot, two cells across from near zoom in
  ctx.globalAlpha = prev;
  ctx.fillStyle = TRACER[0];
  const big = g.res >= 1.5 ? 2 : 1;
  speck(ctx, px - (cell * (big - 1)) / 2, py - (cell * (big - 1)) / 2, g, big);
  ctx.globalAlpha = prev;
}

export const detailedCannon: CannonArt = { flashMs, drawMuzzle, drawShell };
