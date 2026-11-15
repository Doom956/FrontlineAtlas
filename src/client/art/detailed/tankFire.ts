// The detailed style's tank gun fire (client only), in the same pixels, puffs and palette as the ship cannon fire
// (cannon.ts) and the explosions. fx/tankFire.ts decides who fires when and where the shell lands; this draws it:
//   muzzle flash  one tongue of flame out of the gun along the line of fire: a white-yellow core at the muzzle, the
//                 tongue at full length for the first frame or two and drawn back within about 70 ms, the fire balling
//                 up just ahead of it, a warm light thrown on the ground round the muzzle. Heavy and siege guns add short
//                 side jets out of the muzzle brake; Armor Mastery's long gun gives a sharp narrow flash, white nearly
//                 to its tip, with a thin spike reaching on past it
//   blast         dust kicked up off the ground ahead of the gun, then gun smoke pushed out along the line of fire that
//                 slows, swells and drifts off downwind
//   shell         a bright tracer dot with a short trail cooling to orange, flat and fast from the tank guns, lobbed in
//                 a high arc (its shadow running along the ground below it) from the siege tank's howitzer
//   burst         where it lands: a small dirt burst (a hot spark, dark clods thrown up, a puff of dust and smoke), a
//                 spark of steel struck (bright specks flying out), or a splash on water
// Light guns fire small and quick, heavy and siege guns big and slow (TankShotDraw.size; the gun class sets the shape).
// Reduced motion: one still frame of the flash, no flicker.
import type { MotionParams } from '../motion';
import { rnd } from '../shared/noise';
import type { TankGunArt, TankShotDraw } from '../types';
import { drawBlob, type BlobKind } from './blobs';
import { WIND_X, WIND_Y } from './burning';
import { jet, speck } from './cannon';
import { gridOf } from './grid';
import { DEBRIS, FIRE, TRACER } from './palette';

/** The fire of the flash (ms at flashTime 1); the gun smoke takes up to SMOKE_MS more. */
const FIRE_MS = 90;
const SMOKE_MS = 700;
/** How long the burst where a shell lands lasts (ms at blastTime 1). */
export const BURST_MS = 560;

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
const easeOut = (t: number): number => 1 - (1 - t) * (1 - t);
const easeOut3 = (t: number): number => 1 - (1 - t) ** 3;

/** A model unit of the flash on screen (CSS px) at map scale `scale`: a little more than the tank's own at mid zoom, so it reads. */
const flashUnit = (scale: number): number => (scale < 2 ? Math.max(1.3, scale * 1.2) : scale);

function smokeMs(m: MotionParams): number {
  return SMOKE_MS * Math.min(1.6, m.muzzleSmoke);
}

/** How long the tongue of flame is (model units) `tt` ms after the shot, at full length `full`: held, then drawn back. */
export function tankTongueAt(tt: number, full: number): number {
  if (tt < 0 || tt >= 72) return 0;
  return tt < 22 ? full : full * (1 - easeOut((tt - 22) / 50));
}

function shotMs(d: Pick<TankShotDraw, 'gun' | 'flightMs'>, m: MotionParams): number {
  const flash = (FIRE_MS + smokeMs(m)) * m.flashTime;
  return Math.max(flash, d.flightMs + BURST_MS * m.blastTime) + 20;
}

function drawFlash(ctx: CanvasRenderingContext2D, d: TankShotDraw, m: MotionParams): void {
  const g = gridOf(d.scale, d.dpr);
  const tt = d.ageMs / Math.max(0.2, m.flashTime);
  if (tt < 0) return;
  const U = flashUnit(d.scale);
  const cpu = U / g.k;
  const c = Math.cos(d.aim);
  const s = Math.sin(d.aim);
  const size = d.size * m.flashSize;
  const sd = d.seed * 53;
  const mid = g.res < 1.5;
  const still = m.reduced;
  const prev = ctx.globalAlpha;
  const big = d.gun === 'heavy' || d.gun === 'siege';
  const x = d.x0;
  const y = d.y0;
  // ---- the light of the shot on the ground round the muzzle (two frames, then gone within a tenth of a second)
  if (!still && tt < 80) {
    const k = tt < 26 ? 0 : (tt - 26) / 54;
    drawBlob(ctx, 'lamp', Math.max(3, 5.5 * cpu * (0.6 + 0.4 * size)), Math.floor(sd) & 3, x - c * U, y - s * U + 0.5 * U, g, 0.45 * (1 - k) ** 1.5);
  }
  // ---- the blast kicking dust up off the ground ahead of the gun and to its sides
  const dustMs = 650 * (0.7 + 0.3 * size);
  if (tt < dustMs) {
    const k = tt / dustMs;
    const n = (mid ? 2 : 3) + (big ? 1 : 0);
    for (let i = 0; i < n; i++) {
      const a = d.aim + (rnd(sd, i + 40) - 0.5) * 2.2;
      const r0 = (1.4 + 2.2 * rnd(sd, i + 44)) * size;
      const dd = r0 * (0.6 + 0.6 * easeOut(k));
      const px = x + Math.cos(a) * dd * U;
      const py = y + Math.sin(a) * dd * U * 0.8 + U - k * 2 * U;
      const r = Math.max(1, (1 + 0.5 * i) * cpu * (0.55 + 0.45 * size) * (0.7 + 1.1 * easeOut(k)));
      drawBlob(ctx, 'dust', r, (i + Math.floor(sd)) & 3, px, py, g, 0.55 * (1 - k) ** 1.2);
    }
  }
  // ---- gun smoke: pale puffs pushed out along the line of fire, slowing, swelling, rising and drifting downwind
  const end = FIRE_MS + smokeMs(m);
  if (tt > 25 && tt < end) {
    const k = clamp01((tt - 25) / (end - 25));
    const n = (mid ? 2 : 3) + (big ? 1 : 0);
    const sec = (tt - 25) / 1000;
    for (let i = n - 1; i >= 0; i--) {
      const push = (1.6 + 1.7 * i) * size * easeOut3(clamp01((tt - 25) / 220));
      const side = (rnd(sd, i) - 0.5) * 1.4;
      const px = x + (c * push - s * side) * U + WIND_X * U * sec * 0.7;
      const py = y + (s * push + c * side) * U + (WIND_Y - 3.5) * U * sec * 0.7;
      const r = (1.05 + 0.4 * i) * cpu * (0.6 + 0.4 * size) * (1 + 1.4 * easeOut(k)) * Math.sqrt(Math.min(1.6, m.muzzleSmoke));
      const kind: BlobKind = tt < 90 + i * 25 ? 'smoke' : 'vapour';
      drawBlob(ctx, kind, Math.max(1, r), i, px, py, g, 0.78 * (1 - k) ** 1.3 * Math.min(1, 0.35 + m.muzzleSmoke * 0.65));
    }
  }
  // ---- the fire balling up just ahead of the muzzle as the tongue draws back
  if (!d.sharp && tt > 14 && tt < 80) {
    const k = (tt - 14) / 66;
    for (let i = 1; i >= 0; i--) {
      const dd = (1.8 + 1.8 * i) * size * (0.8 + 0.4 * k);
      const r = Math.max(1, (1.2 - 0.25 * i) * cpu * (0.6 + 0.4 * size) * (0.8 + 0.6 * easeOut(k)));
      drawBlob(ctx, 'fire', r, i + 1, x + c * dd * U, y + s * dd * U - k * U, g, (1 - k) ** 1.5, Math.min(2, k * 2.4 + i * 0.3));
    }
  }
  // ---- the blast itself: the tongue of flame, side jets, the white-yellow core
  const tf = still ? (d.ageMs < 60 ? 8 : 999) : tt;
  const full = (d.gun === 'siege' ? 4.6 : 6) * size * (d.sharp ? 1.45 : 1);
  const tongue = tankTongueAt(tf, full);
  if (tongue > 0.3) {
    const step = still ? 0 : Math.floor(tt / 16);
    const w = Math.max(d.sharp ? 1 : 1.5, (d.sharp ? 0.95 : d.gun === 'siege' ? 2.4 : 1.7) * cpu * (0.65 + 0.35 * size));
    // an orange envelope, then the white and yellow core over it (the sharp flash stays white-hot nearly to its tip)
    jet(ctx, x, y, c, s, tongue * cpu, w, g, sd, step, d.sharp ? 0.3 : 0.9);
    jet(ctx, x, y, c, s, tongue * cpu * (d.sharp ? 0.9 : 0.8), Math.max(1, w * 0.45), g, sd + 7, step, d.sharp ? -0.6 : 0);
    if (d.sharp && tf < 40) {
      // the spike: a thin bright line reaching on past the tongue
      ctx.fillStyle = TRACER[0];
      const n = Math.round(tongue * 0.6 * cpu);
      for (let j = 0; j < n; j++) {
        ctx.globalAlpha = prev * (1 - j / n) * 0.9;
        speck(ctx, x + c * (tongue * cpu + j) * g.k, y + s * (tongue * cpu + j) * g.k, g);
      }
      ctx.globalAlpha = prev;
    }
    if (big && tf < 40) {
      // side jets out of the muzzle brake, short and splayed
      for (const side of [-1, 1]) {
        const a = d.aim + side * 1.35;
        jet(ctx, x, y, Math.cos(a), Math.sin(a), 2.4 * size * cpu * (1 - tf / 60), Math.max(1.2, w * 0.5), g, sd + side * 31, step, 0.6);
      }
    }
    if (tf < 45) drawBlob(ctx, 'flash', Math.max(1, (d.sharp ? 1.5 : 1.9) * cpu * (0.6 + 0.4 * size) * (1 - tf / 90)), Math.floor(sd) & 3, x + c * U * 0.8, y + s * U * 0.8, g, 1);
  }
  ctx.globalAlpha = prev;
}

function drawShell(ctx: CanvasRenderingContext2D, d: TankShotDraw, m: MotionParams): void {
  const g = gridOf(d.scale, d.dpr);
  const prev = ctx.globalAlpha;
  const { x0, y0, x1, y1 } = d;
  const dx = x1 - x0;
  const dy = y1 - y0;
  const dist = Math.hypot(dx, dy) || 1;
  const cell = g.k;
  const t = d.ageMs / Math.max(1, d.flightMs);
  const lob = d.gun === 'siege';
  if (t >= 0.04 && t <= 1) {
    const H = (lob ? Math.min(46, dist * 0.3) : Math.min(6, dist * 0.03)) * m.shellArc;
    const at = (q: number): [number, number] => [x0 + dx * q, y0 + dy * q - 4 * H * q * (1 - q)];
    if (lob) {
      // the shadow straight along the ground below the lobbed shell, so its height reads
      ctx.globalAlpha = prev * 0.3;
      ctx.fillStyle = '#0a0d10';
      speck(ctx, x0 + dx * t + cell, y0 + dy * t + cell, g, 2);
    }
    const [px, py] = at(t);
    const [qx, qy] = at(Math.max(0, t - 0.02));
    const dl = Math.hypot(px - qx, py - qy) || 1;
    const ux = (px - qx) / dl;
    const uy = (py - qy) / dl;
    ctx.globalAlpha = prev;
    if (d.size >= 0.9) drawBlob(ctx, 'halo', Math.max(1.2, 1.3 * g.res * Math.min(1.4, d.size)), Math.floor(d.seed * 4) & 3, px, py, g, 0.36);
    // the trail: short and unbroken, yellow behind the head cooling to orange and a red tail
    const len = Math.max(3, Math.round((2.4 * g.res + 1.5) * Math.min(1.5, 0.6 + 0.5 * d.size)));
    for (let j = len; j >= 1; j--) {
      const q = j / len;
      ctx.globalAlpha = prev * (1 - q * 0.75);
      ctx.fillStyle = q < 0.3 ? TRACER[1] : q < 0.65 ? TRACER[2] : FIRE[4];
      speck(ctx, px - ux * j * cell, py - uy * j * cell, g);
    }
    ctx.globalAlpha = prev;
    ctx.fillStyle = TRACER[0];
    const head = g.res >= 1.5 && d.size >= 1.2 ? 2 : 1;
    speck(ctx, px - (cell * (head - 1)) / 2, py - (cell * (head - 1)) / 2, g, head);
  }
  const bt = d.ageMs - d.flightMs;
  const burst = BURST_MS * m.blastTime;
  if (bt >= 0 && bt < burst) drawBurst(ctx, d, bt, burst, m);
  ctx.globalAlpha = prev;
}

/** Where the shell lands, `bt` ms after: a dirt burst, a spark of steel struck, or a splash. */
function drawBurst(ctx: CanvasRenderingContext2D, d: TankShotDraw, bt: number, dur: number, m: MotionParams): void {
  const g = gridOf(d.scale, d.dpr);
  const U = flashUnit(d.scale);
  const cpu = U / g.k;
  const k = bt / dur;
  const size = d.size;
  const sd = d.seed * 71;
  const prev = ctx.globalAlpha;
  const x = d.x1;
  const y = d.y1;
  const still = m.reduced;
  if (d.water) {
    // a small splash: a white column thrown up, falling back as spray
    const h = (still ? 0.6 : Math.sin(Math.min(1, k * 1.6) * Math.PI)) * 3.2 * size * U;
    drawBlob(ctx, 'spray', Math.max(1, 1.3 * cpu * (0.6 + 0.4 * size)), Math.floor(sd) & 3, x, y - h * 0.5, g, 0.85 * (1 - k));
    drawBlob(ctx, 'foam', Math.max(1, 1.8 * cpu * size * (0.6 + 0.6 * k)), (Math.floor(sd) + 1) & 3, x, y + U * 0.3, g, 0.5 * (1 - k), k < 0.4 ? 1 : 3);
    return;
  }
  // the hot flash of the hit
  if (bt < 70) drawBlob(ctx, d.spark ? 'flash' : 'fire', Math.max(1, (d.spark ? 1.3 : 1.1) * cpu * (0.6 + 0.4 * size) * (1 - bt / 110)), Math.floor(sd) & 3, x, y, g, 1, d.spark ? 0 : bt / 50);
  if (d.spark) {
    // steel struck: bright specks flying out and fading
    if (bt < 220) {
      const q = bt / 220;
      const n = Math.round(5 + 3 * size);
      for (let i = 0; i < n; i++) {
        const a = rnd(sd, i) * Math.PI * 2;
        const r = (1 + 4 * easeOut(q) * (0.5 + 0.5 * rnd(sd, i + 9))) * U * (0.7 + 0.3 * size);
        ctx.globalAlpha = prev * (1 - q);
        ctx.fillStyle = q < 0.35 ? TRACER[0] : q < 0.7 ? TRACER[1] : TRACER[2];
        speck(ctx, x + Math.cos(a) * r, y + Math.sin(a) * r * 0.8 - q * U, g);
      }
      ctx.globalAlpha = prev;
    }
    if (bt > 40) drawBlob(ctx, 'smoke', Math.max(1, 1.1 * cpu * size * (0.8 + 0.8 * easeOut(k))), (Math.floor(sd) + 2) & 3, x + WIND_X * U * k * 0.3, y - 2 * U * k, g, 0.6 * (1 - k) ** 1.4);
    return;
  }
  // a dirt burst: dark clods thrown up on arcs and falling back, a puff of dust and smoke rising and swelling
  if (!still && bt < 420) {
    const q = bt / 420;
    const n = Math.round(4 + 3 * size);
    ctx.fillStyle = DEBRIS[1];
    for (let i = 0; i < n; i++) {
      const a = (rnd(sd, i + 3) - 0.5) * 2.6 - Math.PI / 2;
      const v = (2 + 3 * rnd(sd, i + 5)) * U * (0.7 + 0.3 * size);
      const px = x + Math.cos(a) * v * q;
      const py = y + Math.sin(a) * v * q + 5 * U * q * q;
      ctx.globalAlpha = prev * (1 - q * q);
      ctx.fillStyle = i % 3 === 0 ? DEBRIS[2] : DEBRIS[1];
      speck(ctx, px, py, g, size >= 1.3 && i % 2 === 0 ? 2 : 1);
    }
    ctx.globalAlpha = prev;
  }
  for (let i = 0; i < 2; i++) {
    const r = Math.max(1, (1.2 + 0.5 * i) * cpu * (0.55 + 0.45 * size) * (0.7 + 1.2 * easeOut(k)));
    drawBlob(ctx, i === 0 ? 'dust' : 'smoke', r, (Math.floor(sd) + i) & 3, x + (i - 0.5) * U * 1.2 + WIND_X * U * k * 0.25, y - (1 + i) * U * easeOut(k) * 1.4, g, (i === 0 ? 0.75 : 0.55) * (1 - k) ** 1.3);
  }
}

/** Far out: a faint two or three pixel blink at the muzzle. */
function drawFar(ctx: CanvasRenderingContext2D, x: number, y: number, t: number, size: number): void {
  if (t < 0 || t >= 1) return;
  const prev = ctx.globalAlpha;
  const n = size >= 1.2 ? 3 : 2;
  ctx.globalAlpha = prev * 0.7 * (1 - t);
  ctx.fillStyle = t < 0.4 ? '#fffbe8' : '#ffd84a';
  ctx.fillRect(Math.round(x) - (n >> 1), Math.round(y) - (n >> 1), n, n);
  ctx.globalAlpha = prev;
}

export const detailedTankGun: TankGunArt = { shotMs, drawFlash, drawShell, drawFar };
