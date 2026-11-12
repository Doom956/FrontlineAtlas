// The refined style's cannon fire (client only): a turret's muzzle flash (a white-hot star with a long tongue of fire
// toward the target, a smaller orange burst, then a grey smoke puff drifting off), a shell lobbed in an arc with a short
// fading tracer, anti-air tracer dashes racing to a plane, and a torpedo's white wake drawn out along the water.
import type { MotionParams } from '../motion';
import { pixelDisc } from '../shared/pixel';
import type { CannonArt, MuzzleDraw, ShellDraw } from '../types';
import { DEBRIS, FOAM, ORANGE, puff, SMOKE, SMOKE_LIGHT, WHITE, YELLOW } from './fxCommon';

/** A muzzle flash: flash, fire, smoke (ms). */
const FLASH_MS = 300;

/**
 * A turret's muzzle flash, three frames: a white-hot star with a long tongue of fire toward the target, then a
 * smaller orange burst, then a grey smoke puff drifting off the muzzle.
 */
function drawMuzzle(ctx: CanvasRenderingContext2D, x: number, y: number, aim: number, t: number, g: number): void {
  const f = t < 0.3 ? 0 : t < 0.6 ? 1 : 2;
  const c = Math.cos(aim);
  const s = Math.sin(aim);
  const at = (d: number, side = 0): [number, number] => [Math.round((x + (c * d - s * side) * g) / g) * g, Math.round((y + (s * d + c * side) * g) / g) * g];
  if (f === 2) {
    const k = (t - 0.6) / 0.4;
    ctx.globalAlpha = 1;
    puff(ctx, x + c * 3 * g + k * 2 * g, y + s * 3 * g - (1 + k * 3) * g, 1.6 + k, g, 0.8 * (1 - k), SMOKE, SMOKE_LIGHT, '#d2cec8');
    return;
  }
  const len = f === 0 ? 8 : 5;
  // the burst just out of the muzzle
  const [bx, by] = at(f === 0 ? 3 : 2.5);
  ctx.fillStyle = f === 0 ? YELLOW : ORANGE;
  pixelDisc(ctx, bx, by, f === 0 ? 2.4 : 1.8, g);
  // the tongue of fire, a cell wide, and two short side spikes on the first frame
  ctx.fillStyle = f === 0 ? WHITE : YELLOW;
  for (let i = 0; i <= len; i++) {
    const [px, py] = at(i);
    ctx.fillRect(px, py, g, g);
  }
  if (f === 0) {
    for (const sd of [-2, 2]) {
      const [px, py] = at(3, sd);
      ctx.fillRect(px, py, g, g);
    }
    ctx.fillStyle = WHITE;
    pixelDisc(ctx, bx, by, 1, g);
  }
}

/** A shell in flight (an arc with a short tracer), a tracer burst at a plane, or a torpedo's wake. */
function drawShell(ctx: CanvasRenderingContext2D, s: ShellDraw, arc: number): void {
  const { x0, y0, x1, y1, t } = s;
  const g = s.scale;
  const dist = Math.hypot(x1 - x0, y1 - y0);
  if (s.kind === 'torpedo') {
    // a white wake drawn out along the water
    ctx.fillStyle = FOAM;
    const n = Math.max(2, Math.floor((dist * t) / (2 * g)));
    for (let i = 0; i < n; i++) {
      const q = (i / Math.max(1, dist / (2 * g))) * 1;
      const px = x0 + (x1 - x0) * Math.min(t, q);
      const py = y0 + (y1 - y0) * Math.min(t, q);
      ctx.globalAlpha = 0.25 + 0.6 * (i / n);
      ctx.fillRect(Math.round(px / g) * g, Math.round(py / g) * g, g, g);
    }
    ctx.globalAlpha = 1;
    return;
  }
  if (s.kind === 'tracer') {
    // three bright dashes racing to the plane
    ctx.fillStyle = '#ffe58a';
    for (let i = 0; i < 3; i++) {
      const q = t - i * 0.12;
      if (q < 0 || q > 1) continue;
      const px = x0 + (x1 - x0) * q;
      const py = y0 + (y1 - y0) * q;
      ctx.fillRect(Math.round(px / g) * g, Math.round(py / g) * g, g * 2, g);
    }
    return;
  }
  // a cannon shell: lobbed in an arc (up on screen), a hot core with a fading tracer behind it
  const H = Math.min(60, dist * 0.22) * arc;
  const at = (q: number): [number, number] => [x0 + (x1 - x0) * q, y0 + (y1 - y0) * q - 4 * H * q * (1 - q)];
  for (let i = 4; i >= 1; i--) {
    const q = t - i * 0.035;
    if (q < 0) continue;
    const [px, py] = at(q);
    ctx.globalAlpha = 0.7 - i * 0.13;
    ctx.fillStyle = i === 1 ? ORANGE : SMOKE_LIGHT;
    ctx.fillRect(Math.round(px / g) * g, Math.round(py / g) * g, g * (i > 2 ? 2 : 1), g * (i > 2 ? 2 : 1));
  }
  ctx.globalAlpha = 1;
  const [px, py] = at(t);
  const X = Math.round(px / g) * g;
  const Y = Math.round(py / g) * g;
  // the shell: a hot 2 cell core lit from the top left, dark on its lower right edge so it shows on bright land
  ctx.fillStyle = DEBRIS;
  ctx.fillRect(X - g, Y - g, g * 3, g * 3);
  ctx.fillStyle = YELLOW;
  ctx.fillRect(X - g, Y - g, g * 2, g * 2);
  ctx.fillStyle = WHITE;
  ctx.fillRect(X - g, Y - g, g, g);
}

export const refinedCannon: CannonArt = {
  flashMs: (m: MotionParams) => FLASH_MS * m.flashTime,
  drawMuzzle(ctx: CanvasRenderingContext2D, f: MuzzleDraw, m: MotionParams): void {
    void m; // TODO(refined): flash size and muzzle smoke from the motion preset
    drawMuzzle(ctx, f.x, f.y, f.aim, f.t, f.scale);
  },
  drawShell(ctx: CanvasRenderingContext2D, s: ShellDraw, m: MotionParams): void {
    drawShell(ctx, s, m.shellArc);
  },
};
