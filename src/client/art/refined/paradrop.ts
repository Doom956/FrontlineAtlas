// The refined style's paratroopers (client only): line parachutes in the owner's colour over a dark under-stroke,
// drifting down onto a ring round the drop point with a little sway and fading out on the ground, and the tiny
// parachute mark (canopy arc and two strings) next to a cargo plane in flight. This is the look the map had before
// the art switch, moved here unchanged from render/units.ts.
import type { MotionParams } from '../motion';
import { rgbCss } from '../shared/colour';
import type { ParachuteMarkDraw, ParadropArt, ParadropDraw } from '../types';

/** A drop shows this long (ms), from the plane arriving to the last canopy faded on the ground. */
const DROP_MS = 1800;
/** The dark stroke under the owner's colour, so a canopy reads on any ground. */
const UNDER = 'rgba(6,9,15,0.6)';

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
/** How far the parachutes scatter round the drop point (CSS px). */
const spreadOf = (zoom: number): number => Math.max(10, zoom * 2.4);

function draw(ctx: CanvasRenderingContext2D, d: ParadropDraw, _m: MotionParams): void {
  const t = d.t;
  if (t < 0 || t >= 1) return;
  const spread = spreadOf(d.zoom);
  const size = clamp(d.zoom * 0.6, 5, 9);
  const turn = d.seed * Math.PI * 2;
  const prevAlpha = ctx.globalAlpha;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.globalAlpha = t < 0.75 ? 1 : 1 - (t - 0.75) / 0.25;
  for (const pass of [0, 1]) {
    ctx.beginPath();
    for (let k = 0; k < d.count; k++) {
      const a = (k / d.count) * Math.PI * 2 + turn;
      const r = spread * (0.35 + (0.65 * ((k * 37) % 10)) / 10);
      // fall from above onto the ground, swaying a little
      const x = d.x + Math.cos(a) * r + Math.sin(t * 6 + k) * size * 0.25;
      const y = d.y + Math.sin(a) * r * 0.6 - (1 - t) * spread * 1.6;
      const s = size * (1 - 0.3 * t);
      ctx.moveTo(x + s * 0.6, y - s * 0.5);
      ctx.arc(x, y - s * 0.5, s * 0.6, 0, Math.PI, true);
      ctx.moveTo(x - s * 0.6, y - s * 0.5);
      ctx.lineTo(x, y + s * 0.4);
      ctx.lineTo(x + s * 0.6, y - s * 0.5);
    }
    ctx.lineWidth = pass === 0 ? 3 : 1.4;
    ctx.strokeStyle = pass === 0 ? UNDER : rgbCss(d.owner);
    ctx.stroke();
  }
  ctx.globalAlpha = prevAlpha;
}

/** Tiny parachute (canopy arc and two strings) off the lower right of a cargo plane. */
function drawMark(ctx: CanvasRenderingContext2D, p: ParachuteMarkDraw, _m: MotionParams): void {
  const x = p.x + p.half + 4;
  const y = p.y + p.half * 0.6 + 4;
  const color = rgbCss(p.owner);
  for (const pass of [0, 1]) {
    ctx.beginPath();
    ctx.moveTo(x - 3, y);
    ctx.arc(x, y, 3, Math.PI, 0);
    ctx.moveTo(x - 3, y);
    ctx.lineTo(x, y + 4.5);
    ctx.lineTo(x + 3, y);
    ctx.lineWidth = pass === 0 ? 2.8 : 1.2;
    ctx.strokeStyle = pass === 0 ? UNDER : color;
    ctx.stroke();
  }
}

export const refinedParadrop: ParadropArt = {
  durationMs: () => DROP_MS,
  reachPx: (zoom) => spreadOf(zoom) * 3,
  draw,
  drawMark,
};
