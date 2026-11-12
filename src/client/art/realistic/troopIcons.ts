// The realistic style's troop icons (client only): the same meaning as every style (infantry, armor, artillery, and a
// question mark for a mix the viewer does not know, on a plate in the owner's colour), painted like a small enamel
// badge rather than a cartoon: a rounded plate with a soft top-left light, a bevelled rim and a thin dark edge, and a
// true-proportioned silhouette in ivory (dark on a pale plate) with a soft shadow: a soldier advancing with his rifle,
// a tank in side view (track run, road wheels, turret and gun), a field gun (barrel, shield, spoked wheel, trail).
// Baked once per kind, owner colour and size at twice the CSS size (or the screen's ratio), drawn smoothly.
import { makeCanvas } from '../../render/common';
import { luma } from '../shared/colour';
import type { TroopIconArt, TroopIconKind } from '../types';
import { tonesOf } from './model';
import { css, darken, lighten, TAU } from './paint';

const KINDS: Record<TroopIconKind, number> = { infantry: 0, armor: 1, artillery: 2, troops: 3 };
const cache = new Map<number, HTMLCanvasElement | null>();

type Sym = (c: CanvasRenderingContext2D) => void;

/** The symbols in a unit box (y down), facing right. Each fills or strokes in the current style. */
const SYMBOLS: Record<TroopIconKind, Sym> = {
  infantry: (c) => {
    // rifle held across the body, pointing up and forward
    c.lineCap = 'round';
    c.lineWidth = 0.07;
    c.beginPath();
    c.moveTo(0.22, 0.66);
    c.lineTo(0.9, 0.16);
    c.stroke();
    // legs in stride
    c.lineWidth = 0.12;
    c.beginPath();
    c.moveTo(0.52, 0.56);
    c.lineTo(0.66, 0.74);
    c.lineTo(0.7, 0.94);
    c.moveTo(0.44, 0.56);
    c.lineTo(0.36, 0.76);
    c.lineTo(0.24, 0.92);
    c.stroke();
    // torso leaning forward, the pack on the back
    c.beginPath();
    c.moveTo(0.37, 0.3);
    c.lineTo(0.58, 0.29);
    c.lineTo(0.62, 0.6);
    c.lineTo(0.4, 0.61);
    c.closePath();
    c.fill();
    c.beginPath();
    c.moveTo(0.27, 0.32);
    c.lineTo(0.38, 0.31);
    c.lineTo(0.39, 0.52);
    c.lineTo(0.28, 0.5);
    c.closePath();
    c.fill();
    // arm to the rifle
    c.lineWidth = 0.09;
    c.beginPath();
    c.moveTo(0.53, 0.34);
    c.lineTo(0.62, 0.47);
    c.lineTo(0.7, 0.36);
    c.stroke();
    // head and the helmet with its brim
    c.beginPath();
    c.arc(0.5, 0.24, 0.07, 0, TAU);
    c.fill();
    c.beginPath();
    c.ellipse(0.48, 0.18, 0.15, 0.1, 0, Math.PI, 0);
    c.closePath();
    c.fill();
    c.lineWidth = 0.05;
    c.beginPath();
    c.moveTo(0.3, 0.19);
    c.lineTo(0.67, 0.19);
    c.stroke();
  },
  armor: (c) => {
    // track run with road wheels cut out of it
    c.beginPath();
    c.roundRect(0.05, 0.6, 0.86, 0.26, 0.13);
    c.fill();
    // hull, turret, cupola, gun
    c.beginPath();
    c.moveTo(0.08, 0.61);
    c.lineTo(0.14, 0.47);
    c.lineTo(0.84, 0.47);
    c.lineTo(0.93, 0.61);
    c.closePath();
    c.fill();
    c.beginPath();
    c.moveTo(0.28, 0.48);
    c.lineTo(0.33, 0.31);
    c.lineTo(0.63, 0.3);
    c.lineTo(0.69, 0.48);
    c.closePath();
    c.fill();
    c.fillRect(0.4, 0.25, 0.1, 0.07);
    c.fillRect(0.62, 0.355, 0.36, 0.06);
  },
  artillery: (c) => {
    c.lineCap = 'round';
    // the barrel raised toward the top right, the recuperator under it
    c.lineWidth = 0.1;
    c.beginPath();
    c.moveTo(0.36, 0.56);
    c.lineTo(0.94, 0.16);
    c.stroke();
    c.lineWidth = 0.06;
    c.beginPath();
    c.moveTo(0.38, 0.63);
    c.lineTo(0.72, 0.4);
    c.stroke();
    // the trail down to the ground behind
    c.lineWidth = 0.09;
    c.beginPath();
    c.moveTo(0.44, 0.66);
    c.lineTo(0.06, 0.93);
    c.stroke();
    // the shield
    c.beginPath();
    c.moveTo(0.42, 0.33);
    c.lineTo(0.56, 0.3);
    c.lineTo(0.58, 0.66);
    c.lineTo(0.44, 0.69);
    c.closePath();
    c.fill();
    // the wheel
    c.beginPath();
    c.arc(0.52, 0.76, 0.19, 0, TAU);
    c.fill();
  },
  troops: (c) => {
    c.lineCap = 'round';
    c.lineWidth = 0.14;
    c.beginPath();
    c.arc(0.5, 0.34, 0.19, Math.PI * 1.08, Math.PI * 0.4, false);
    c.quadraticCurveTo(0.5, 0.52, 0.5, 0.64);
    c.stroke();
    c.beginPath();
    c.arc(0.5, 0.85, 0.08, 0, TAU);
    c.fill();
  },
};

/** Cut-outs in a symbol (the tank's road wheels, the field gun's spokes): drawn in the plate's colour. */
function cutouts(c: CanvasRenderingContext2D, kind: TroopIconKind): void {
  if (kind === 'armor') {
    for (const x of [0.2, 0.37, 0.54, 0.71]) {
      c.beginPath();
      c.arc(x, 0.73, 0.065, 0, TAU);
      c.fill();
    }
  } else if (kind === 'artillery') {
    c.beginPath();
    c.arc(0.52, 0.76, 0.12, 0, TAU);
    c.fill();
  }
}

function bake(kind: TroopIconKind, owner: readonly number[], size: number, K: number): HTMLCanvasElement | null {
  const W = size + 2;
  const cv = makeCanvas(Math.ceil(W * K), Math.ceil(W * K));
  const c = cv.getContext('2d');
  if (!c) return null;
  c.scale(K, K);
  const t = tonesOf(owner);
  const r = Math.max(2, size * 0.2);
  // the dark edge, then the enamel plate inside it with its light
  c.fillStyle = 'rgba(10,12,16,0.92)';
  c.beginPath();
  c.roundRect(0, 0, W, W, r + 1);
  c.fill();
  const g = c.createLinearGradient(1, 1, 1 + size, 1 + size);
  g.addColorStop(0, css(lighten(t.base, 0.22)));
  g.addColorStop(0.5, css(t.base));
  g.addColorStop(1, css(darken(t.base, 0.3)));
  c.fillStyle = g;
  c.beginPath();
  c.roundRect(1, 1, size, size, r);
  c.fill();
  // the bevel: light along the top, shade along the bottom
  const bv = c.createLinearGradient(0, 1, 0, 1 + size);
  bv.addColorStop(0, 'rgba(255,255,255,0.55)');
  bv.addColorStop(0.45, 'rgba(255,255,255,0)');
  bv.addColorStop(0.6, 'rgba(0,0,0,0)');
  bv.addColorStop(1, 'rgba(0,0,0,0.4)');
  c.strokeStyle = bv;
  c.lineWidth = 1;
  c.beginPath();
  c.roundRect(1.5, 1.5, size - 1, size - 1, r - 0.5);
  c.stroke();
  // the symbol: a soft shadow, then ivory (near black on a pale plate)
  const dark = luma(t.base) > 172;
  const ink = dark ? '#1c2024' : '#f4f0e4';
  const pad = size * 0.14;
  const s = size - pad * 2;
  const sym = SYMBOLS[kind];
  c.save();
  c.translate(1 + pad, 1 + pad);
  c.scale(s, s);
  if (!dark) {
    c.save();
    c.translate(0.6 / s, 0.8 / s);
    c.fillStyle = 'rgba(0,0,0,0.45)';
    c.strokeStyle = 'rgba(0,0,0,0.45)';
    sym(c);
    c.restore();
  }
  const ig = c.createLinearGradient(0, 0, 1, 1);
  ig.addColorStop(0, dark ? '#2a2f34' : '#ffffff');
  ig.addColorStop(1, ink);
  c.fillStyle = ig;
  c.strokeStyle = ig;
  sym(c);
  c.fillStyle = css(t.base);
  cutouts(c, kind);
  c.restore();
  return cv;
}

function draw(ctx: CanvasRenderingContext2D, kind: TroopIconKind, x: number, y: number, owner: readonly number[], size: number): number {
  if (typeof document === 'undefined') return 0;
  const K = typeof window !== 'undefined' && (window.devicePixelRatio || 1) > 2.2 ? 3 : 2;
  const key = (((((owner[0] & 255) << 16) | ((owner[1] & 255) << 8) | (owner[2] & 255)) * 4 + (KINDS[kind] ?? 3)) * 64 + Math.min(63, size)) * 4 + K;
  let cv = cache.get(key);
  if (cv === undefined) {
    if (cache.size > 600) cache.clear();
    cv = bake(kind, owner, size, K);
    cache.set(key, cv);
  }
  if (!cv) return 0;
  const W = size + 2;
  const prev = ctx.imageSmoothingEnabled;
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(cv, Math.round(x), Math.round(y), W, W);
  ctx.imageSmoothingEnabled = prev;
  return W;
}

export const realisticTroopIcons: TroopIconArt = { draw: (ctx, kind, x, y, owner, size) => draw(ctx, kind, x, y, owner, size) };
