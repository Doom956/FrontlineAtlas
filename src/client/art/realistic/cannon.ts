// The realistic style's cannon fire (client only):
//   muzzle   each barrel of the turret flashes along the line of fire: a white-hot core at the muzzles, a cone of fire
//            out of every barrel (the middle one longest; a triple turret's barrels go off a few ms apart), a side jet
//            out of the outer barrels, all merging into a bulb of fire, the shell leaving as a bright slug racing out
//            through the flash, a brief strong light on the deck and the water round the gun, the blast slapping the
//            water flat into a ring of spray
//            (recoil), then a puff of brown-grey gun smoke shoved out along the line of fire from each barrel, lit by
//            the flash for a moment, slowing, swelling and drifting off with the wind as it thins (muzzleSmoke). The
//            flash grows with flashSize and lasts with flashTime; the ship's salvo ripples from turret to turret (the
//            map starts each gun's flash a little after the last)
//   shell    a glowing tracer streaking along its arc (lifted up the screen with height, shellArc), its faint shadow
//            running straight along the water or ground below it
//   tracer   anti-aircraft fire: bursts of short red-orange streaks racing up at the plane, a little scattered
//   torpedo  a dark shape under the surface pulling a line of white bubbles behind it
import type { MotionParams } from '../motion';
import { rnd } from '../shared/noise';
import type { CannonArt, MuzzleDraw, ShellDraw } from '../types';
import { unitPx } from './explosions';
import { Flame, flame } from './fire';
import { clamp01, easeOut, easeOut3, flashOver, glow, Puff, puff, ramp, WIND_X, WIND_Y } from './puffs';

/** Smooth 0..1 (smoothstep). */
const smooth = (t: number): number => {
  const k = clamp01(t);
  return k * k * (3 - 2 * k);
};

/** The fire of the flash at flashTime 1 (ms); the smoke takes the rest of flashMs. */
const FLASH = 130;
const SMOKE = 620;
/** The barrels a flash comes out of (a turret's guns side by side) and how far apart they are (art units). */
const BARRELS = 3;
const GAP = 1.05;
/** How far apart the barrels' tongues of fire start (art units): closer than the smoke, so they fuse into one blast. */
const GAP_FIRE = 0.75;
/** The shell leaving the muzzle (ms), before the map's own shell takes over. */
const SLUG = 60;

function flashMs(m: MotionParams): number {
  return (FLASH + SMOKE * m.muzzleSmoke) * m.flashTime;
}

/** An art unit of the flash on screen (px) at map scale `scale`: a little over the ship's own, so it reads at mid zoom. */
const flashUnit = (scale: number): number => Math.max(1.6, scale * 1.4);

/**
 * The size of a flash at map scale `scale` (CSS px): the fireball's length along the line of fire and its width, how
 * far the barrels' tongues reach, and how many barrels flash (flashSize scales them).
 */
export function muzzleFlash(scale: number, m: MotionParams): { length: number; width: number; tongue: number; barrels: number } {
  const U = flashUnit(scale);
  return { length: U * 8.5 * m.flashSize, width: U * 6 * m.flashSize, tongue: U * 9 * m.flashSize, barrels: BARRELS };
}

function drawMuzzle(ctx: CanvasRenderingContext2D, f: MuzzleDraw, m: MotionParams): void {
  const total = flashMs(m);
  // ms on a flashTime-1 clock, so a longer flashTime plays the same flash slower
  const tt = (f.t * total) / Math.max(0.2, m.flashTime);
  if (tt < 0) return;
  const U = flashUnit(f.scale);
  const fz = m.flashSize;
  const c = Math.cos(f.aim);
  const s = Math.sin(f.aim);
  const nx = -s;
  const ny = c;
  const seed = Math.floor(f.seed * 613) + 3;
  const prev = ctx.globalAlpha;
  // the muzzles, a little out from the gun along the line of fire
  const mx = f.x + c * U * 1.1;
  const my = f.y + s * U * 1.1;

  // the blast slapping the water round the gun: an uneven ring of spray thrown out, most of it on the firing side,
  // each puff flattened along the water (low sheets of spray, never a tidy fan of balls)
  if (m.recoil > 0 && tt < 420) {
    const q = tt / 420;
    const n = 7 + (seed % 3);
    const ql = easeOut(q);
    const fade = 0.42 * m.recoil * (1 - q) * (1 - q);
    for (let i = 0; i < n; i++) {
      // spread round the gun, bunched toward the line of fire, each a little off its place
      const u = i / (n - 1) - 0.5;
      const a = f.aim + u * Math.abs(u) * 5.2 + (rnd(seed, i + 70) - 0.5) * 0.4;
      const reach = 0.55 + 0.75 * rnd(seed, i + 80) * (1 - Math.abs(u));
      const d = U * (1.6 + 4.8 * reach * ql) * (0.8 + 0.2 * fz);
      const r = U * (0.8 + 0.7 * rnd(seed, i + 90)) * (1 + 1.3 * q);
      const x = mx + Math.cos(a) * d;
      const y = my + Math.sin(a) * d;
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(a);
      ctx.scale(0.55, 1);
      puff(ctx, Puff.SPRAY, i, 0, 0, r, fade * (0.6 + 0.4 * rnd(seed, i + 100)));
      ctx.restore();
    }
  }

  // gun smoke: brown-grey, shoved out along the line of fire from each barrel, slowing, swelling, drifting off
  const smokeT = SMOKE * m.muzzleSmoke + FLASH * 0.5;
  if (m.muzzleSmoke > 0 && tt > 10) {
    const n = Math.max(3, Math.round(2 + 2.5 * m.muzzleSmoke));
    for (let i = n - 1; i >= 0; i--) {
      const t0 = 10 + i * 14;
      const q = clamp01((tt - t0) / smokeT);
      if (q <= 0 || q >= 1) continue;
      const lane = ((i % BARRELS) - 1) * GAP * U;
      const push = U * (2.4 + i * 1.6) * fz * easeOut3(Math.min(1, q * 2.4));
      const drift = U * 7 * Math.pow(q, 1.3);
      const rise = U * 2.4 * q;
      const r = U * (1.5 + 0.4 * i) * (0.5 + 2 * easeOut(q)) * (0.7 + 0.3 * fz);
      const x = mx + c * push + nx * lane * (1 + q) + WIND_X * drift;
      const y = my + s * push + ny * lane * (1 + q) + WIND_Y * drift - rise;
      // lit from inside by the flash for a moment
      if (tt < FLASH * 1.3 && i < BARRELS) puff(ctx, Puff.EMBER, i, x, y, r * 0.85, 0.6 * (1 - tt / (FLASH * 1.3)));
      const kind = i % 3 === 1 ? Puff.DUST : Puff.GREY;
      puff(ctx, kind, i + seed, x, y, r, 0.85 * ramp(q, 0, 0.05) * Math.pow(1 - q, 1.4));
    }
  }

  // the flash: longest and sharpest in its first frame (the blast thrown straight out of the barrels), then drawn
  // back into one ragged ball of fire rolling out along the line of fire into the smoke
  if (tt < FLASH) {
    const q = tt / FLASH;
    // the light of it on the deck and the water, lying out ahead of the muzzles along the line of fire, strong and
    // gone at once
    const lr = U * 8 * fz * (0.85 + 0.3 * q);
    ctx.save();
    ctx.translate(mx + c * U * 3, my + s * U * 3);
    ctx.rotate(f.aim);
    ctx.scale(1.6, 1);
    glow(ctx, 0, 0, lr, 0.6 * Math.exp(-tt / 34));
    ctx.restore();
    // the fused blast in front of the barrels: long at once, shrinking and fading by about 60 ms as the ball takes over
    {
      const L = U * 8.5 * fz * (1 - 0.6 * easeOut(clamp01(q / 0.5)));
      const W = U * 5.4 * fz * (0.75 + 0.5 * q);
      const A = 1 - smooth(q / 0.45);
      flame(ctx, Flame.CONE, false, seed + 5, mx, my, f.aim, L, W, A);
      flame(ctx, Flame.CONE, true, seed + 5, mx, my, f.aim, L, W, A * (1 - smooth(q / 0.25)));
    }
    for (let b = 0; b < BARRELS; b++) {
      // the barrels go off a few ms apart, in their own order each turret
      const delay = ((b + seed) % BARRELS) * 4;
      const tb = tt - delay;
      if (tb < 0) continue;
      const qb = tb / FLASH;
      // out by about 28 ms: the comb of tongues never outlives the first frames
      const A = 1 - smooth(qb / 0.22);
      if (A <= 0.01) continue;
      const lane = (b - 1) * GAP_FIRE * U;
      const main = b === 1 ? 1 : 0.85;
      const grow = clamp01(tb / 4);
      const L = U * 9.5 * fz * main * (0.8 + 0.2 * grow) * (1 - 0.85 * easeOut(qb));
      const W = U * 2.4 * fz * main * (0.8 + 0.6 * qb);
      // each barrel's tongue a little off the others' line (they splay; never parallel)
      const ba = f.aim + (b - 1) * 0.1 + (rnd(seed, b + 7) - 0.5) * 0.1;
      const bx = mx + nx * lane;
      const by = my + ny * lane;
      const v = seed + b;
      // a tongue of fire out of each barrel, white hot, cooling to orange and red as it dies
      flame(ctx, Flame.BOLT, false, v, bx, by, ba, L, W, A);
      flame(ctx, Flame.BOLT, true, v, bx, by, ba, L, W, A * (1 - smooth(qb / 0.15)));
      // a side jet out of each outer barrel
      if (b !== 1 && qb < 0.3) {
        const side = b === 0 ? -1 : 1;
        const ja = f.aim + side * 1.15;
        flame(ctx, Flame.CONE, qb < 0.12, v + 1, bx + c * U * 0.6, by + s * U * 0.6, ja, U * 3.8 * fz * (1 - qb * 1.4), U * 2.2 * fz, 1 - qb / 0.3);
      }
    }
    // the barrels' blasts fused into one ragged ball of fire rolling out along the line of fire, cooling as the smoke
    // takes over: two lobes of fire off each other's centre, so it is never a clean round ball
    const fuse = ramp(q, 0.04, 0.16) * Math.pow(1 - q, 1.1);
    if (fuse > 0.01) {
      const d = U * (2.6 + 2 * q) * fz;
      const r = U * 3.6 * fz * (0.75 + 0.4 * q);
      const off = (rnd(seed, 3) - 0.5) * 1.4 * U * fz;
      puff(ctx, Puff.FIRE, seed, mx + c * d + nx * off, my + s * d + ny * off, r, 0.95 * fuse);
      puff(ctx, Puff.FIRE, seed + 1, mx + c * (d + r * 0.55) - nx * off * 0.8, my + s * (d + r * 0.55) - ny * off * 0.8, r * 0.7, 0.8 * fuse);
    }
    // the white-hot core at the muzzles, drawn out along the line of fire
    const core = Math.exp(-tt / 22);
    if (core > 0.02) {
      ctx.save();
      ctx.translate(mx + c * U * 1.6, my + s * U * 1.6);
      ctx.rotate(f.aim);
      ctx.scale(1.8, 0.7);
      flashOver(ctx, 0, 0, U * 2.6 * fz, core);
      flashOver(ctx, U * 1.6, 0, U * 1.8 * fz, core * 0.8);
      ctx.restore();
    }
  }

  // the shell leaving: a bright slug racing out through the flash, gone before the map's own shell is far out
  if (tt < SLUG) {
    const q = tt / SLUG;
    const d = U * (2 + 30 * easeOut(q));
    const hx = mx + c * d;
    const hy = my + s * d;
    const back = U * 3 * (1 - q * 0.4);
    ctx.lineCap = 'round';
    ctx.globalAlpha = prev * (1 - q) * 0.9;
    ctx.strokeStyle = 'rgba(255,214,140,0.75)';
    ctx.lineWidth = Math.max(0.8, U * 0.3);
    ctx.beginPath();
    ctx.moveTo(hx - c * back, hy - s * back);
    ctx.lineTo(hx, hy);
    ctx.stroke();
    ctx.fillStyle = '#fff6d8';
    ctx.beginPath();
    ctx.arc(hx, hy, Math.max(0.7, U * 0.26), 0, Math.PI * 2);
    ctx.fill();
    ctx.lineCap = 'butt';
  }
  ctx.globalAlpha = prev;
}

function drawShell(ctx: CanvasRenderingContext2D, sh: ShellDraw, m: MotionParams): void {
  const { x0, y0, x1, y1, t } = sh;
  if (t < 0 || t > 1) return;
  const dist = Math.hypot(x1 - x0, y1 - y0);
  const u = unitPx(sh.zoom);
  const prev = ctx.globalAlpha;
  ctx.lineCap = 'round';
  if (sh.kind === 'torpedo') {
    // a line of bubbles drawn out behind a dark shape running just under the surface
    const hx = x0 + (x1 - x0) * t;
    const hy = y0 + (y1 - y0) * t;
    const g = ctx.createLinearGradient(x0, y0, hx, hy);
    g.addColorStop(0, 'rgba(230,242,246,0)');
    g.addColorStop(0.7, 'rgba(230,242,246,0.35)');
    g.addColorStop(1, 'rgba(250,253,254,0.85)');
    ctx.strokeStyle = g;
    ctx.lineWidth = Math.max(1, u * 0.28);
    ctx.beginPath();
    ctx.moveTo(x0 + (hx - x0) * 0.15, y0 + (hy - y0) * 0.15);
    ctx.lineTo(hx, hy);
    ctx.stroke();
    ctx.fillStyle = 'rgba(245,250,252,0.8)';
    const n = Math.min(14, Math.floor((dist * t) / Math.max(3, u * 0.7)));
    for (let i = 0; i < n; i++) {
      const q = t - (i + 1) * (Math.max(3, u * 0.7) / Math.max(1, dist));
      if (q < 0) break;
      const r = Math.max(0.5, u * 0.09 * (1 + (i % 3) * 0.4));
      const j = (rnd(sh.seed * 100, i) - 0.5) * u * 0.3;
      ctx.globalAlpha = prev * (1 - i / 14);
      ctx.beginPath();
      ctx.arc(x0 + (x1 - x0) * q - ((y1 - y0) / dist) * j, y0 + (y1 - y0) * q + ((x1 - x0) / dist) * j, r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = prev * 0.85;
    ctx.fillStyle = '#1d2427';
    ctx.save();
    ctx.translate(hx, hy);
    ctx.rotate(Math.atan2(y1 - y0, x1 - x0));
    ctx.beginPath();
    ctx.ellipse(0, 0, Math.max(1.5, u * 0.45), Math.max(0.6, u * 0.1), 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    ctx.globalAlpha = prev;
    return;
  }
  if (sh.kind === 'tracer') {
    // three short bursts of red-orange streaks racing up at the plane, a little scattered
    for (let i = 0; i < 5; i++) {
      const q = t - i * 0.09;
      if (q < 0 || q > 1) continue;
      const j = (rnd(sh.seed * 50, i) - 0.5) * u * 0.8 * (1 - q);
      const nx = -(y1 - y0) / Math.max(1, dist);
      const ny = (x1 - x0) / Math.max(1, dist);
      const px = x0 + (x1 - x0) * q + nx * j;
      const py = y0 + (y1 - y0) * q + ny * j;
      const back = Math.min(0.08, q);
      const bx = x0 + (x1 - x0) * (q - back) + nx * j;
      const by = y0 + (y1 - y0) * (q - back) + ny * j;
      ctx.globalAlpha = prev * 0.9;
      ctx.strokeStyle = 'rgba(255,120,60,0.55)';
      ctx.lineWidth = Math.max(1.4, u * 0.3);
      ctx.beginPath();
      ctx.moveTo(bx, by);
      ctx.lineTo(px, py);
      ctx.stroke();
      ctx.strokeStyle = '#ffe2a0';
      ctx.lineWidth = Math.max(0.7, u * 0.12);
      ctx.stroke();
    }
    ctx.globalAlpha = prev;
    return;
  }
  // a cannon shell: lifted up the screen with height along its arc, a glowing streak, its shadow straight below it
  const H = Math.min(80, dist * 0.24) * m.shellArc;
  const at = (q: number): [number, number] => [x0 + (x1 - x0) * q, y0 + (y1 - y0) * q - 4 * H * q * (1 - q)];
  const [px, py] = at(t);
  const [bx, by] = at(Math.max(0, t - 0.07));
  // the flight starts at the ship's middle while the flash and the slug leave the turret: the shell shows only once it
  // has cleared the hull (on a short shot, after the first part of its flight)
  const show = dist > u * 6 ? clamp01((dist * t - u * 1.4) / (u * 1.6)) : ramp(t, 0.1, 0.3);
  if (show <= 0) return;
  // the shadow on the ground or the water
  ctx.globalAlpha = prev * 0.3 * (1 - Math.abs(0.5 - t)) * show;
  ctx.fillStyle = '#0a0c0e';
  ctx.beginPath();
  ctx.ellipse(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, Math.max(0.8, u * 0.18), Math.max(0.5, u * 0.11), 0, 0, Math.PI * 2);
  ctx.fill();
  // the glowing streak and the hot shell at its head
  const g = ctx.createLinearGradient(bx, by, px, py);
  g.addColorStop(0, 'rgba(255,150,60,0)');
  g.addColorStop(1, 'rgba(255,190,100,0.85)');
  ctx.globalAlpha = prev * show;
  ctx.strokeStyle = g;
  ctx.lineWidth = Math.max(1.1, u * 0.22);
  ctx.beginPath();
  ctx.moveTo(bx, by);
  ctx.lineTo(px, py);
  ctx.stroke();
  ctx.fillStyle = '#fff6d8';
  ctx.beginPath();
  ctx.arc(px, py, Math.max(0.8, u * 0.13), 0, Math.PI * 2);
  ctx.fill();
  glow(ctx, px, py, Math.max(2.5, u * 0.6), 0.5 * show);
  ctx.globalAlpha = prev;
  ctx.lineCap = 'butt';
}

export const realisticCannon: CannonArt = { flashMs, drawMuzzle, drawShell };
