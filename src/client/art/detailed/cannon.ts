// The detailed style's cannon fire (client only), in the same puffs and palette as the explosions:
//   muzzle flash  a ragged burst of flame thrown out along the line of fire (white hot at the muzzle, orange at its
//                 tips), then a cloud of grey gun smoke pushed forward that slows, swells and drifts off (flashSize,
//                 flashTime, muzzleSmoke)
//   shell         a dark round with a faint hot glow and a short tracer streak, lobbed in an arc (shellArc), with its
//                 shadow running straight along the ground below it, so the height reads
//   tracer        anti-air fire: bright streaks racing up to the plane, each with a fading tail
//   torpedo       a dark torpedo running just under the surface, its thin bubbly wake drawn out behind it
import type { MotionParams } from '../motion';
import { rnd } from '../shared/noise';
import type { CannonArt, MuzzleDraw, ShellDraw } from '../types';
import { drawBlob } from './blobs';
import { gridOf, type Grid } from './grid';
import { DEBRIS, SPRAY, TRACER } from './palette';

const FLASH_MS = 340;

function speck(ctx: CanvasRenderingContext2D, x: number, y: number, g: Grid, n = 1): void {
  const s = Math.max(1, Math.round(n)) * g.p;
  ctx.fillRect((Math.round((x * g.dpr) / g.p) * g.p) / g.dpr, (Math.round((y * g.dpr) / g.p) * g.p) / g.dpr, s / g.dpr, s / g.dpr);
}

function drawMuzzle(ctx: CanvasRenderingContext2D, f: MuzzleDraw, m: MotionParams): void {
  const g = gridOf(f.scale, f.dpr);
  const u = f.scale;
  const c = Math.cos(f.aim);
  const s = Math.sin(f.aim);
  const t = f.t;
  const size = m.flashSize;
  const sd = f.seed * 41;
  // gun smoke: pushed out along the line of fire, slowing, swelling and drifting up and off
  if (t > 0.08) {
    const k = (t - 0.08) / 0.92;
    const n = 3;
    for (let i = 0; i < n; i++) {
      const push = (2.4 + i * 1.6) * (1 - (1 - k) ** 3) * size;
      const px = f.x + c * push * u + (rnd(sd, i) - 0.5) * 1.2 * u + k * 1.5 * u;
      const py = f.y + s * push * u - k * 2.2 * u;
      const r = (1 + 0.6 * i + 1.6 * k) * g.res * 0.6 * Math.sqrt(m.muzzleSmoke) * size;
      drawBlob(ctx, 'smoke', Math.max(1, r), i, px, py, g, 0.75 * (1 - k) * Math.min(1, m.muzzleSmoke));
    }
  }
  // the flash: flame thrown forward in a ragged tongue, gone in a moment
  if (t < 0.32) {
    const k = t / 0.32;
    const len = (3.2 + 1.4 * rnd(sd, 9)) * size * (1 - k * 0.4);
    for (let i = 3; i >= 0; i--) {
      const d = (i / 3) * len;
      const side = (rnd(sd, i + 3) - 0.5) * 0.8;
      const r = Math.max(1, (1.25 - i * 0.22) * g.res * 0.7 * size * (1 - k * 0.5));
      drawBlob(ctx, 'fire', r, i, f.x + (c * d - s * side) * u, f.y + (s * d + c * side) * u, g, 1 - k * 0.3, Math.min(4, i * 0.8 + k * 3));
    }
    // two side spurts on the first moment
    if (k < 0.4) {
      ctx.fillStyle = TRACER[1];
      for (const sdn of [-1, 1]) speck(ctx, f.x + (c * 1.2 - s * sdn * 1.4) * u, f.y + (s * 1.2 + c * sdn * 1.4) * u, g);
    }
  }
  // the blast slapping the water by the gun: spray thrown off sideways, more with a harder recoil
  if (m.recoil > 0 && t < 0.45) {
    const k = t / 0.45;
    const prev = ctx.globalAlpha;
    ctx.fillStyle = SPRAY[3];
    const n = Math.round(3 + 4 * m.recoil);
    for (let i = 0; i < n; i++) {
      const a = f.aim + Math.PI / 2 + (i % 2 ? Math.PI : 0) + (rnd(sd, i + 20) - 0.5) * 1.2;
      const d = (1 + 3 * k * (0.6 + 0.4 * rnd(sd, i + 30))) * u * (0.6 + 0.4 * m.recoil);
      ctx.globalAlpha = prev * 0.7 * (1 - k);
      speck(ctx, f.x + Math.cos(a) * d, f.y + Math.sin(a) * d * 0.7 + 1.5 * u, g);
    }
    ctx.globalAlpha = prev;
  }
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
  // a cannon shell lobbed in an arc: its shadow straight along the ground, a short glowing streak behind it
  const H = Math.min(70, dist * 0.24) * m.shellArc;
  const at = (q: number): [number, number] => [x0 + dx * q, y0 + dy * q - 4 * H * q * (1 - q)];
  ctx.globalAlpha = prev * 0.3;
  ctx.fillStyle = '#0a0d10';
  speck(ctx, x0 + dx * t + g.k, y0 + dy * t + g.k, g, 2);
  for (let i = 5; i >= 1; i--) {
    const q = t - i * 0.022;
    if (q < 0) continue;
    const [px, py] = at(q);
    ctx.globalAlpha = prev * (0.75 - i * 0.13);
    ctx.fillStyle = i <= 1 ? TRACER[1] : i <= 3 ? TRACER[2] : '#8d8a84';
    speck(ctx, px, py, g);
  }
  const [px, py] = at(t);
  ctx.globalAlpha = prev;
  ctx.fillStyle = DEBRIS[0];
  speck(ctx, px, py, g, 2);
  ctx.fillStyle = TRACER[0];
  speck(ctx, px, py, g);
  ctx.globalAlpha = prev;
}

export const detailedCannon: CannonArt = {
  flashMs: (m: MotionParams) => FLASH_MS * m.flashTime,
  drawMuzzle,
  drawShell,
};
