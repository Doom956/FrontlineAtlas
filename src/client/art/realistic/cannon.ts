// The realistic style's cannon fire (client only):
//   muzzle   a white-hot blast thrown out along the aim with orange fire round it, the light of it on the water, the
//            blast pressing a pale disc of flattened, spraying water beside the ship (recoil), then brown-grey gun
//            smoke rolling out along the line of fire and drifting off with the wind (muzzleSmoke)
//   shell    a glowing tracer streaking along its arc (lifted up the screen with height, shellArc), its faint shadow
//            running straight along the water or ground below it
//   tracer   anti-aircraft fire: bursts of short red-orange streaks racing up at the plane, a little scattered
//   torpedo  a dark shape under the surface pulling a line of white bubbles behind it
import type { MotionParams } from '../motion';
import { rnd } from '../shared/noise';
import type { CannonArt, MuzzleDraw, ShellDraw } from '../types';
import { unitPx } from './explosions';
import { clamp01, easeOut, flashOver, glow, Puff, puff, ramp, WIND_X, WIND_Y } from './puffs';

/** The flash itself at flashTime 1 (ms); the smoke takes the rest of flashMs. */
const FLASH = 130;
const SMOKE = 520;

function flashMs(m: MotionParams): number {
  return (FLASH + SMOKE * m.muzzleSmoke) * m.flashTime;
}

function drawMuzzle(ctx: CanvasRenderingContext2D, f: MuzzleDraw, m: MotionParams): void {
  const total = flashMs(m);
  const tt = (f.t * total) / Math.max(0.2, m.flashTime);
  const u = unitPx(f.zoom) * 0.75;
  const S = u * m.flashSize;
  const c = Math.cos(f.aim);
  const s = Math.sin(f.aim);
  const seed = f.seed * 613 + 3;
  const prev = ctx.globalAlpha;
  // the blast pressing the water flat beside the gun (a pale disc of spray)
  if (m.recoil > 0 && tt < 380) {
    const q = tt / 380;
    const n = 7;
    for (let i = 0; i < n; i++) {
      const a = f.aim + (i / (n - 1) - 0.5) * 1.6;
      const d = S * (1.2 + 1.6 * easeOut(q));
      puff(ctx, Puff.SPRAY, i, f.x + Math.cos(a) * d, f.y + Math.sin(a) * d, S * (0.45 + 0.4 * q), 0.35 * m.recoil * (1 - q));
    }
  }
  // gun smoke rolling out along the line of fire and drifting off
  const smokeT = SMOKE * m.muzzleSmoke;
  if (smokeT > 0 && tt > 30) {
    const n = Math.max(2, Math.round(2 + 2 * m.muzzleSmoke));
    for (let i = n - 1; i >= 0; i--) {
      const q = clamp01((tt - 30 - i * 25) / (smokeT + FLASH * 0.5));
      if (q <= 0 || q >= 1) continue;
      const along = S * (1.3 + i * 0.9) * (0.5 + 0.8 * easeOut(q));
      const drift = S * 2.2 * q;
      const r = S * (0.55 + 0.25 * i) * (0.7 + 1.1 * easeOut(q));
      puff(ctx, i % 2 ? Puff.GREY : Puff.WHITE, i + Math.floor(seed) , f.x + c * along + WIND_X * drift, f.y + s * along + WIND_Y * drift - S * 0.6 * q, r, 0.75 * ramp(q, 0, 0.1) * (1 - q));
    }
  }
  // the flash: a white-hot blast thrown along the aim, fire round it, its light
  if (tt < FLASH) {
    const q = tt / FLASH;
    const hot = 1 - q;
    for (let i = 0; i < 4; i++) {
      const d = S * (0.4 + i * 0.75) * (0.7 + 0.6 * easeOut(q));
      const r = S * (0.95 - i * 0.16) * (0.8 + 0.4 * q);
      const jx = (rnd(seed, i) - 0.5) * S * 0.3;
      puff(ctx, Puff.EMBER, i, f.x + c * d - s * jx, f.y + s * d + c * jx, r * 1.1, 0.85 * hot);
      puff(ctx, Puff.FIRE, i + 1, f.x + c * d - s * jx, f.y + s * d + c * jx, r * (0.6 + 0.4 * hot), hot);
    }
    flashOver(ctx, f.x + c * S * 0.7, f.y + s * S * 0.7, S * 1.3 * hot + S * 0.3, hot);
    glow(ctx, f.x + c * S, f.y + s * S, S * 4, 0.6 * hot);
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
  // the shadow on the ground or the water
  ctx.globalAlpha = prev * 0.3 * (1 - Math.abs(0.5 - t));
  ctx.fillStyle = '#0a0c0e';
  ctx.beginPath();
  ctx.ellipse(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, Math.max(0.8, u * 0.18), Math.max(0.5, u * 0.11), 0, 0, Math.PI * 2);
  ctx.fill();
  // the glowing streak and the hot shell at its head
  const g = ctx.createLinearGradient(bx, by, px, py);
  g.addColorStop(0, 'rgba(255,150,60,0)');
  g.addColorStop(1, 'rgba(255,190,100,0.85)');
  ctx.globalAlpha = prev;
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
  glow(ctx, px, py, Math.max(2.5, u * 0.6), 0.5);
  ctx.globalAlpha = prev;
  ctx.lineCap = 'butt';
}

export const realisticCannon: CannonArt = { flashMs, drawMuzzle, drawShell };
