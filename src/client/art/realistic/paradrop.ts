// The realistic style's paratroopers (client only): round canopies seen from above in period cloth (olive drab, khaki
// or off-white silk, gores in two tones of it, a soft dome light from the top left), the owner's colour only on two
// gores and the crown vent, muted (model.ts tonesOf), the rigging lines running down to a small soldier
// hanging under each, and each one's shadow on the ground, small and sharp as it lands. A drop: the canopies snap open
// one after another (a quick bloom), drift down swaying (the planes' motion: more sway when they bank harder), touch
// down round the drop point, collapse into a crumpled heap of cloth beside the soldier and fade.
// Far out a drop is a few small round cloth canopies with the owner's vent (cheap); the canopy pictures are baked once
// per owner colour, cloth and size.
import { makeCanvas } from '../../render/common';
import type { MotionParams } from '../motion';
import type { ParachuteMarkDraw, ParadropArt, ParadropDraw } from '../types';
import { tonesOf } from './model';
import { type Col, css, darken, hexCol, lighten, TAU } from './paint';
import { clamp01, ramp } from './puffs';

const DROP_MS = 2600;
const spreadOf = (zoom: number): number => Math.max(10, zoom * 2.4);

const canopies = new Map<number, HTMLCanvasElement | null>();

/** Parachute cloth: olive drab, khaki, off-white silk. */
const CLOTH: readonly Col[] = [hexCol('#6c6c4a'), hexCol('#9c8f66'), hexCol('#cfc9b4')];
const clothOf = (k: number): number => (k * 7 + 3) % 5 === 0 ? 2 : k % 2;
/** The owner's tones on cloth: muted toward the canopy's own colour. */
const ownerOnCloth = (owner: readonly number[], cloth: Col): ReturnType<typeof tonesOf> => tonesOf(owner, cloth, 0.38, 0.44, 0.6);

/** A canopy seen from above, radius r device px (the picture is 2r + 4 square), in cloth `cl` (CLOTH index). */
function canopy(owner: readonly number[], r: number, cl = 0): HTMLCanvasElement | null {
  const key = ((((owner[0] & 255) << 16) | ((owner[1] & 255) << 8) | (owner[2] & 255)) * 64 + Math.min(63, r)) * 4 + cl;
  const hit = canopies.get(key);
  if (hit !== undefined) return hit;
  if (typeof document === 'undefined') return null;
  if (canopies.size > 160) canopies.clear();
  const S = r * 2 + 4;
  const cv = makeCanvas(S, S);
  const c = cv.getContext('2d');
  if (!c) {
    canopies.set(key, null);
    return null;
  }
  const cloth = CLOTH[cl] ?? CLOTH[0];
  const t = ownerOnCloth(owner, cloth);
  const cx = S / 2;
  const cy = S / 2;
  const gores = 10;
  for (let i = 0; i < gores; i++) {
    const a0 = (i / gores) * TAU;
    const a1 = ((i + 1) / gores) * TAU;
    c.beginPath();
    c.moveTo(cx, cy);
    // each gore bulges a little between its seams
    const am = (a0 + a1) / 2;
    c.lineTo(cx + Math.cos(a0) * r, cy + Math.sin(a0) * r);
    c.quadraticCurveTo(cx + Math.cos(am) * r * 1.08, cy + Math.sin(am) * r * 1.08, cx + Math.cos(a1) * r, cy + Math.sin(a1) * r);
    c.closePath();
    // the cloth's own two tones; two opposite gores in the owner's colour
    const own = i === 0 || i === 5;
    c.fillStyle = own ? css(i % 2 ? t.base : lighten(t.base, 0.1)) : css(i % 2 ? cloth : lighten(cloth, 0.1));
    c.fill();
  }
  // the dome's light: bright toward the top left, the far rim in shade
  const g = c.createRadialGradient(cx - r * 0.35, cy - r * 0.42, r * 0.05, cx, cy, r * 1.05);
  g.addColorStop(0, 'rgba(255,255,255,0.45)');
  g.addColorStop(0.4, 'rgba(255,255,255,0.05)');
  g.addColorStop(0.8, 'rgba(0,0,0,0.12)');
  g.addColorStop(1, 'rgba(0,0,0,0.38)');
  c.fillStyle = g;
  c.beginPath();
  c.arc(cx, cy, r * 1.04, 0, TAU);
  c.fill();
  // seams, the vent at the crown, the hem
  if (r >= 5) {
    c.strokeStyle = css(darken(cloth, 0.4), 0.45);
    c.lineWidth = 0.6;
    c.beginPath();
    for (let i = 0; i < gores; i++) {
      const a = (i / gores) * TAU;
      c.moveTo(cx + Math.cos(a) * r * 0.16, cy + Math.sin(a) * r * 0.16);
      c.lineTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
    }
    c.stroke();
  }
  // the crown: a small ring of the owner's colour round the dark vent
  c.fillStyle = css(t.base);
  c.beginPath();
  c.arc(cx, cy, Math.max(1.1, r * 0.22), 0, TAU);
  c.fill();
  c.fillStyle = css(darken(cloth, 0.6));
  c.beginPath();
  c.arc(cx, cy, Math.max(0.6, r * 0.1), 0, TAU);
  c.fill();
  c.strokeStyle = css(darken(cloth, 0.45), 0.7);
  c.lineWidth = Math.max(0.8, r * 0.08);
  c.beginPath();
  c.arc(cx, cy, r * 1.0, 0, TAU);
  c.stroke();
  canopies.set(key, cv);
  return cv;
}

/** A soldier from above, hanging or standing: shoulders, pack and helmet. */
function soldier(ctx: CanvasRenderingContext2D, x: number, y: number, s: number): void {
  ctx.fillStyle = '#3f4530';
  ctx.beginPath();
  ctx.ellipse(x, y, s * 0.55, s * 0.36, 0, 0, TAU);
  ctx.fill();
  ctx.fillStyle = '#5a6240';
  ctx.beginPath();
  ctx.arc(x - s * 0.06, y - s * 0.06, s * 0.27, 0, TAU);
  ctx.fill();
}

function draw(ctx: CanvasRenderingContext2D, d: ParadropDraw, m: MotionParams): void {
  const t = d.t;
  if (t < 0 || t >= 1) return;
  const spread = spreadOf(d.zoom);
  const turn = d.seed * TAU;
  const prev = ctx.globalAlpha;
  const far = d.zoom < 3;
  const size = Math.max(3, Math.min(11, d.zoom * 0.5));
  const H = spread * 1.6;
  const sway = m.reduced ? 0 : 0.3 + m.bankMax * 0.8;
  for (let k = 0; k < d.count; k++) {
    const a = (k / d.count) * TAU + turn;
    const rr = spread * (0.35 + 0.65 * ((k * 37 + Math.floor(d.seed * 10)) % 10) / 10);
    const gx = d.x + Math.cos(a) * rr;
    const gy = d.y + Math.sin(a) * rr * 0.6;
    // each one opens a moment after the one before, comes down, lands
    const open = 0.02 + k * 0.035;
    const land = 0.6 + k * 0.03;
    if (t < open) continue;
    const fall = clamp01((t - open) / (land - open));
    const alt = 1 - fall;
    const landed = t >= land;
    const fadeOut = 1 - ramp(t, 0.82, 1);
    const sw = Math.sin(d.ageMs / 520 + k * 1.9) * sway * alt;
    const px = gx + sw * size * 0.9;
    const py = gy - alt * H * 0.55;
    if (far) {
      ctx.globalAlpha = prev * fadeOut;
      ctx.fillStyle = 'rgba(8,10,14,0.7)';
      ctx.beginPath();
      ctx.arc(px, py, size * 0.75 + 0.8, 0, TAU);
      ctx.fill();
      const cloth = CLOTH[clothOf(k)];
      ctx.fillStyle = css(cloth);
      ctx.beginPath();
      ctx.arc(px, py, size * 0.75, 0, TAU);
      ctx.fill();
      ctx.fillStyle = css(ownerOnCloth(d.owner, cloth).base);
      ctx.beginPath();
      ctx.arc(px, py, size * 0.36, 0, TAU);
      ctx.fill();
      continue;
    }
    if (landed) {
      // the canopy settles into a heap of cloth beside the soldier, pushed out by the wind: a few folds of it
      const q = ramp(t, land, land + 0.1);
      const cloth = CLOTH[clothOf(k)];
      const hx = gx + size * 0.7 * q;
      const hy = gy - size * 0.25 * q;
      ctx.globalAlpha = prev * fadeOut * 0.35;
      ctx.fillStyle = '#0a0c0e';
      ctx.beginPath();
      ctx.ellipse(hx + size * 0.25, hy + size * 0.2, size * (1.2 - 0.2 * q), size * (0.9 - 0.25 * q), 0.5, 0, TAU);
      ctx.fill();
      ctx.globalAlpha = prev * fadeOut;
      for (let f = 0; f < 3; f++) {
        const fx = hx + (f - 1) * size * 0.45 * q;
        const fy = hy + (f % 2 ? -1 : 1) * size * 0.18 * q;
        ctx.fillStyle = css(f === 1 ? lighten(cloth, 0.12) : darken(cloth, 0.12 + f * 0.05));
        ctx.beginPath();
        ctx.ellipse(fx, fy, size * (1 - 0.35 * q) * (f === 1 ? 0.8 : 0.65), size * (1 - 0.45 * q) * 0.6, 0.5 + f * 0.3, 0, TAU);
        ctx.fill();
      }
      soldier(ctx, gx - size * 0.35, gy + size * 0.1, size * 0.7);
      continue;
    }
    // the shadow on the ground: larger and softer high up, small and sharp as it comes down
    ctx.globalAlpha = prev * fadeOut * (0.14 + 0.26 * fall);
    ctx.fillStyle = '#0a0c0e';
    ctx.beginPath();
    ctx.ellipse(gx + alt * size * 1.2, gy + alt * size * 0.9, size * (0.8 + alt * 0.5), size * (0.7 + alt * 0.35), 0, 0, TAU);
    ctx.fill();
    // rigging lines from the canopy's rim down to the soldier hanging below it
    const bloom = ramp(t, open, open + 0.07);
    const grow = bloom < 1 ? 0.3 + 0.7 * (1 - Math.pow(1 - bloom, 3)) * (1 + 0.12 * Math.sin(bloom * Math.PI)) : 1;
    const cs = size * (1 + 0.25 * alt) * grow;
    const sx = px - sw * size * 0.5;
    const sy = py + cs * 1.35;
    ctx.globalAlpha = prev * fadeOut * 0.75;
    ctx.strokeStyle = 'rgba(30,32,30,0.8)';
    ctx.lineWidth = Math.max(0.5, size * 0.07);
    ctx.beginPath();
    ctx.moveTo(px - cs * 0.85, py + cs * 0.25);
    ctx.lineTo(sx, sy);
    ctx.lineTo(px + cs * 0.85, py + cs * 0.25);
    ctx.moveTo(px - cs * 0.35, py + cs * 0.55);
    ctx.lineTo(sx, sy);
    ctx.lineTo(px + cs * 0.35, py + cs * 0.55);
    ctx.stroke();
    ctx.globalAlpha = prev * fadeOut;
    soldier(ctx, sx, sy, size * 0.62);
    const dpr = Math.max(1, d.dpr);
    const img = canopy(d.owner, Math.max(3, Math.round(cs * dpr)), clothOf(k));
    if (img) {
      const w = (img.width / dpr) * (cs * dpr) / Math.max(3, Math.round(cs * dpr));
      // a swaying canopy tips over a little: narrower across its swing
      const squash = 1 - Math.abs(sw) * 0.18;
      const prevS = ctx.imageSmoothingEnabled;
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(img, px - (w * squash) / 2, py - w / 2, w * squash, w);
      ctx.imageSmoothingEnabled = prevS;
    }
  }
  ctx.globalAlpha = prev;
}

/** The small parachute mark off the lower right of a cargo plane in flight: a canopy with its lines and a soldier. */
function drawMark(ctx: CanvasRenderingContext2D, p: ParachuteMarkDraw, m: MotionParams): void {
  void m;
  const x = p.x + p.half + 5;
  const y = p.y + p.half * 0.6 + 2;
  const r = 4;
  const dpr = Math.max(1, p.dpr);
  ctx.strokeStyle = 'rgba(20,22,20,0.85)';
  ctx.lineWidth = 0.8;
  ctx.beginPath();
  ctx.moveTo(x - r * 0.85, y + r * 0.2);
  ctx.lineTo(x, y + r * 1.6);
  ctx.lineTo(x + r * 0.85, y + r * 0.2);
  ctx.stroke();
  soldier(ctx, x, y + r * 1.6, r * 0.75);
  const img = canopy(p.owner, Math.round(r * dpr), 2);
  if (img) {
    const w = img.width / dpr;
    const prevS = ctx.imageSmoothingEnabled;
    ctx.imageSmoothingEnabled = true;
    // a dark rim under it so the mark reads on any ground
    ctx.fillStyle = 'rgba(6,9,15,0.55)';
    ctx.beginPath();
    ctx.arc(x, y, r + 1, 0, TAU);
    ctx.fill();
    ctx.drawImage(img, x - w / 2, y - w / 2, w, w);
    ctx.imageSmoothingEnabled = prevS;
  }
}

export const realisticParadrop: ParadropArt = {
  durationMs: () => DROP_MS,
  reachPx: (zoom) => spreadOf(zoom) * 3,
  draw,
  drawMark,
};
