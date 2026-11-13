// The refined style's cannon fire (client only), in the effects' one palette (palette.ts FX):
//   - a muzzle blast: a cone of fire thrown out toward the target (lumpy, hottest at the barrel), the blast flattening
//     the water under it, then a cloud of brown-grey gun smoke rolling out and drifting downwind (MotionParams
//     flashSize, flashTime, muzzleSmoke); the ship rocks back from each shot (recoil.ts notes the flash for sprites.ts);
//   - a shell lobbed in an arc (shellArc): a dark round with a dull glowing base and a short smoke trail;
//   - anti-aircraft tracer: short dull-gold dashes racing to the plane;
//   - a torpedo: a thin line of bubbles drawn out along the water.
// The landing is a blast (explosions.ts: shell, splash or flak).
import type { MotionParams } from '../motion';
import { rnd } from '../shared/noise';
import type { CannonArt, MuzzleDraw, ShellDraw } from '../types';
import { blob, FX, smokeAdd, smokeDraw, smokeReset } from './fxCommon';
import { noteMuzzle } from './recoil';

/** A muzzle blast, fire and smoke (ms, before the preset's multipliers). */
const FLASH_MS = 300;

/** The muzzle blast, `t` 0..1: fire for the first fifth, then the gun smoke rolling out and thinning. */
function drawMuzzle(ctx: CanvasRenderingContext2D, f: MuzzleDraw, m: MotionParams): void {
  const g = f.scale;
  const t = f.t;
  const c = Math.cos(f.aim);
  const s = Math.sin(f.aim);
  const size = m.flashSize;
  const seed = f.seed * 131 + 7;
  const prev = ctx.globalAlpha;
  // the gun smoke: rolling out along the shot, then drifting downwind and up, as long as the preset lets it linger
  const ts = Math.max(0, (t - 0.1) / 0.9);
  if (t > 0.1 && m.muzzleSmoke > 0) {
    smokeReset();
    const n = 3;
    for (let i = 0; i < n; i++) {
      const d = (2 + 3 * i) * (0.6 + 0.6 * Math.sqrt(ts)) * size;
      smokeAdd(f.x + c * d * g + ts * 3 * g, f.y + s * d * g - ts * (2 + i) * g, (1 + 0.9 * i * 0.5 + 1.6 * ts) * Math.min(1.6, 0.7 + 0.3 * m.muzzleSmoke) * size, seed + i);
    }
    smokeDraw(ctx, g, 0.8 * (1 - ts) * Math.min(1, 0.45 + 0.35 * m.muzzleSmoke), FX.smokeDark, FX.smoke, FX.ash);
  }
  if (t < 0.32) {
    const k = t / 0.32;
    // the blast pressing the water flat under the muzzle
    ctx.globalAlpha = prev * 0.45 * (1 - k);
    ctx.fillStyle = FX.foamDim;
    blob(ctx, f.x + c * 2 * g, f.y + s * 2 * g + g, (2.2 + 1.6 * k) * size, g, seed + 9);
    ctx.globalAlpha = prev;
    // the cone of fire: lumps shrinking away from the barrel, white-hot only at the very first moment
    const L = (k < 0.4 ? 7 : 5) * size;
    for (let i = 0; i < 4; i++) {
      const d = (i / 3) * L;
      const r = (1.9 - i * 0.4) * size * (1 - k * 0.4);
      ctx.fillStyle = k < 0.35 ? (i === 0 ? FX.hot : i === 1 ? FX.flame : FX.fire) : i === 0 ? FX.flame : FX.fireDeep;
      blob(ctx, f.x + c * d * g + (rnd(seed, i) - 0.5) * g, f.y + s * d * g + (rnd(seed, i + 4) - 0.5) * g, Math.max(0.4, r), g, seed + i);
    }
  }
  ctx.globalAlpha = prev;
}

/** A shell in flight (an arc with a short trail), a tracer burst at a plane, or a torpedo's line of bubbles. */
function drawShell(ctx: CanvasRenderingContext2D, s: ShellDraw, arc: number): void {
  const { x0, y0, x1, y1, t } = s;
  const g = s.scale;
  const dist = Math.hypot(x1 - x0, y1 - y0);
  const prev = ctx.globalAlpha;
  if (s.kind === 'torpedo') {
    // a thin line of bubbles drawn out along the water, densest behind the torpedo
    ctx.fillStyle = FX.foam;
    const n = Math.max(2, Math.floor((dist * t) / (2 * g)));
    for (let i = 0; i < n; i++) {
      const q = (i / Math.max(1, dist / (2 * g))) * 1;
      const px = x0 + (x1 - x0) * Math.min(t, q);
      const py = y0 + (y1 - y0) * Math.min(t, q);
      ctx.globalAlpha = prev * (0.15 + 0.55 * (i / n));
      ctx.fillRect(Math.round(px / g) * g, Math.round(py / g) * g, g, g);
    }
    ctx.globalAlpha = prev;
    return;
  }
  if (s.kind === 'tracer') {
    // three short dull-gold dashes racing to the plane
    ctx.fillStyle = FX.flame;
    for (let i = 0; i < 3; i++) {
      const q = t - i * 0.12;
      if (q < 0 || q > 1) continue;
      const px = x0 + (x1 - x0) * q;
      const py = y0 + (y1 - y0) * q;
      ctx.globalAlpha = prev * (0.9 - i * 0.2);
      ctx.fillRect(Math.round(px / g) * g, Math.round(py / g) * g, g * 2, g);
    }
    ctx.globalAlpha = prev;
    return;
  }
  // a cannon shell: lobbed in an arc (up on screen), a short trail of thin smoke behind it
  const H = Math.min(60, dist * 0.22) * arc;
  const at = (q: number): [number, number] => [x0 + (x1 - x0) * q, y0 + (y1 - y0) * q - 4 * H * q * (1 - q)];
  for (let i = 4; i >= 1; i--) {
    const q = t - i * 0.035;
    if (q < 0) continue;
    const [px, py] = at(q);
    ctx.globalAlpha = prev * (0.55 - i * 0.1);
    ctx.fillStyle = i === 1 ? FX.fireDeep : FX.smokeLight;
    ctx.fillRect(Math.round(px / g) * g, Math.round(py / g) * g, g, g);
  }
  ctx.globalAlpha = prev;
  const [px, py] = at(t);
  const X = Math.round(px / g) * g;
  const Y = Math.round(py / g) * g;
  // the shell: a dark round, its base glowing dully
  ctx.fillStyle = FX.debris;
  ctx.fillRect(X - g, Y - g, g * 2, g * 2);
  ctx.fillStyle = FX.fire;
  ctx.fillRect(X - g, Y, g, g);
}

export const refinedCannon: CannonArt = {
  flashMs: (m: MotionParams) => FLASH_MS * m.flashTime * (0.75 + 0.3 * m.muzzleSmoke),
  drawMuzzle(ctx: CanvasRenderingContext2D, f: MuzzleDraw, m: MotionParams): void {
    noteMuzzle(f.x, f.y, f.aim, f.t);
    drawMuzzle(ctx, f, m);
  },
  drawShell(ctx: CanvasRenderingContext2D, s: ShellDraw, m: MotionParams): void {
    drawShell(ctx, s, m.shellArc);
  },
};
