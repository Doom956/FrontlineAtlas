// The refined style's paratroopers (client only): round canopies in the owner's colour, shaded like the units (lit on
// the left, a darker right half, two gores), the hem in the owner's full colour over a soft dark edge so a canopy reads
// on any ground, the cords and the trooper under it. Each comes down from above round the drop point swaying a little
// (more with the livelier presets, none with reduced motion), its shadow on the ground growing and sharpening as it
// nears; on landing the canopy collapses sideways onto the ground and fades. A cargo plane in flight carries a small
// parachute mark beside it.
import type { MotionParams } from '../motion';
import { rgbCss, type RGB } from '../shared/colour';
import type { ParachuteMarkDraw, ParadropArt, ParadropDraw } from '../types';
import { oklch } from './palette';
import { ownerRamp } from './spriteBake';

/** A drop shows this long (ms), from the plane arriving to the last canopy faded on the ground. */
const DROP_MS = 1800;
/** The soft dark edge under every canopy line. */
const UNDER = 'rgba(18,22,26,0.55)';
const CORD = 'rgba(28,32,36,0.6)';
const TROOPER = (() => {
  const c = oklch(0.36, 0.035, 115);
  return `rgb(${c[0]},${c[1]},${c[2]})`;
})();

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
/** How far the parachutes scatter round the drop point (CSS px). */
const spreadOf = (zoom: number): number => Math.max(10, zoom * 2.4);

const tones = new Map<string, [string, string, string]>();
/** The canopy's three tones (shade, cloth, lit) from the owner colour, a little toned down for the large cloth. */
function canopyTones(owner: RGB): [string, string, string] {
  const key = `${owner[0]},${owner[1]},${owner[2]}`;
  let t = tones.get(key);
  if (!t) {
    const r = ownerRamp(owner);
    t = [rgbCss(r[1]), rgbCss(r[2].map((v, i) => Math.round(v * 0.86 + r[1][i] * 0.14))), rgbCss(r[3].map((v, i) => Math.round(v * 0.7 + r[2][i] * 0.3)))];
    if (tones.size > 64) tones.clear();
    tones.set(key, t);
  }
  return t;
}

/**
 * One canopy of half-width `s` px with its hem at (x, y): `open` 0..1 (a streamer opening), `flat` 0..1 (collapsed on
 * the ground), `lean` px the canopy is pushed sideways over its trooper.
 */
function canopy(ctx: CanvasRenderingContext2D, x: number, y: number, s: number, owner: RGB, open: number, flat: number, lean: number, trooper: boolean): void {
  const w = s * (0.35 + 0.65 * open);
  const hgt = s * 0.78 * (1 - flat * 0.8) * (0.6 + 0.4 * open);
  const X = Math.round(x + lean);
  const Y = Math.round(y);
  const [shade, cloth, lit] = canopyTones(owner);
  const dome = (dx: number, ww: number, hh: number): void => {
    ctx.beginPath();
    ctx.ellipse(X + dx, Y, ww, hh, 0, Math.PI, Math.PI * 2);
    ctx.closePath();
  };
  // cords and the trooper hanging under the canopy
  if (trooper && flat < 0.5) {
    const ty = Math.round(y + s * 1.2);
    const tx = Math.round(x);
    ctx.beginPath();
    ctx.moveTo(X - w, Y);
    ctx.lineTo(tx, ty);
    ctx.lineTo(X + w, Y);
    ctx.moveTo(X, Y);
    ctx.lineTo(tx, ty);
    ctx.lineWidth = 0.8;
    ctx.strokeStyle = CORD;
    ctx.stroke();
    const b = Math.max(1, Math.round(s / 4));
    ctx.fillStyle = TROOPER;
    ctx.fillRect(tx - b / 2, ty - b * 0.5, b, b * 2);
  }
  // the cloth: dark edge, the cloth, the lit left part, two gores; the hem in the owner's colour
  dome(0, w + 0.8, hgt + 0.8);
  ctx.fillStyle = UNDER;
  ctx.fill();
  dome(0, w, hgt);
  ctx.fillStyle = shade;
  ctx.fill();
  dome(-w * 0.18, w * 0.78, hgt * 0.96);
  ctx.fillStyle = cloth;
  ctx.fill();
  dome(-w * 0.42, w * 0.4, hgt * 0.8);
  ctx.fillStyle = lit;
  ctx.fill();
  if (w > 3 && flat < 0.5) {
    ctx.fillStyle = shade;
    ctx.fillRect(Math.round(X - w * 0.36), Math.round(Y - hgt * 0.78), 1, Math.max(1, Math.round(hgt * 0.7)));
    ctx.fillRect(Math.round(X + w * 0.3), Math.round(Y - hgt * 0.8), 1, Math.max(1, Math.round(hgt * 0.72)));
  }
  ctx.beginPath();
  ctx.moveTo(X - w, Y);
  ctx.quadraticCurveTo(X, Y + s * 0.18, X + w, Y);
  ctx.lineWidth = Math.max(1, s * 0.16);
  ctx.strokeStyle = rgbCss(owner);
  ctx.stroke();
}

function draw(ctx: CanvasRenderingContext2D, d: ParadropDraw, m: MotionParams): void {
  const t = d.t;
  if (t < 0 || t >= 1) return;
  const spread = spreadOf(d.zoom);
  const s = clamp(d.zoom * 0.42, 3.2, 8);
  const turn = d.seed * Math.PI * 2;
  const swayK = m.reduced ? 0 : 0.3 + 0.9 * m.bankMax;
  const prevAlpha = ctx.globalAlpha;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  // the canopies land at 70 % of the drop, collapse, then fade out on the ground
  const land = 0.7;
  const fade = t < 0.8 ? 1 : 1 - (t - 0.8) / 0.2;
  for (let k = 0; k < d.count; k++) {
    const a = (k / d.count) * Math.PI * 2 + turn;
    const r = spread * (0.35 + (0.65 * ((k * 37) % 10)) / 10);
    const gx = d.x + Math.cos(a) * r;
    const gy = d.y + Math.sin(a) * r * 0.6;
    // each trooper jumps a little after the one before, so they do not land as one
    const tk = clamp((t - k * 0.02) / (land - k * 0.02), 0, 1);
    const fall = 1 - tk;
    const sway = Math.sin(t * 7 + k * 1.3) * s * 0.35 * swayK * fall;
    // the shadow on the ground: small and faint while high, firmer as the trooper comes down
    ctx.globalAlpha = prevAlpha * fade * (0.15 + 0.25 * tk);
    ctx.fillStyle = '#0a0e12';
    ctx.beginPath();
    ctx.ellipse(Math.round(gx + s * 0.4 * fall), Math.round(gy + s * 1.2), s * (0.5 + 0.4 * tk), s * 0.22, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = prevAlpha * fade;
    const open = clamp(tk / 0.12, 0, 1);
    const flat = t > land ? clamp((t - land) / 0.08, 0, 1) : 0;
    const y = gy - fall * spread * 1.6;
    canopy(ctx, gx + sway, y, s * (1 - 0.15 * tk), d.owner, open, flat, flat * s * 0.9 + sway * 0.4, true);
  }
  ctx.globalAlpha = prevAlpha;
}

/** A small parachute (canopy and cords) off the lower right of a cargo plane. */
function drawMark(ctx: CanvasRenderingContext2D, p: ParachuteMarkDraw, _m: MotionParams): void {
  const x = p.x + p.half + 4;
  const y = p.y + p.half * 0.6 + 3;
  canopy(ctx, x, y, 3.6, p.owner, 1, 0, 0, true);
}

export const refinedParadrop: ParadropArt = {
  durationMs: () => DROP_MS,
  reachPx: (zoom) => spreadOf(zoom) * 3,
  draw,
  drawMark,
};
