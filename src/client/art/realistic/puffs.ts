// The realistic style's smoke, fire, dust and spray (client only): a few soft billowing puffs painted once into small
// canvases, then drawn scaled wherever an effect needs them. A puff is a cauliflower of overlapping lobes, each a
// radial gradient lit from the top left (light on the upper left of every lobe, the cloud's own shade on its lower
// right), with a fine speckle; fire puffs glow from a near-white core to deep orange. Effects stack many of these,
// growing, rising and drifting with the wind, so smoke looks like a body of smoke and never a flat disc or a ring.
//
// One palette for every effect (explosions, craters, cannon fire, trails, tank dust):
//   fire     #fff6d6 core, #ffc25a, #f07a26, #b8401a edge     embers  #ffb46b, #c9471c, #5e1c0b
//   smoke    dark #5b544e / #37322f / #1d1a18, grey #a29b93 / #736d67 / #48433f, white #f4f3ee / #d5d3cd / #a6a49e
//   dust     #c4b08c / #957f60 / #63523c                      soot    #3a3530 / #1f1c1a / #0d0c0b
//   spray    #ffffff / #e0edf2 / #a6c0cd
// Wind: smoke drifts toward the east north east everywhere (WIND), so every column on the map leans the same way.
import { makeCanvas } from '../../render/common';
import { rnd } from '../shared/noise';
import { type Col, css, hexCol, LIGHT_X, LIGHT_Y, TAU } from './paint';

/** Puff kinds. */
export const Puff = { DARK: 0, GREY: 1, WHITE: 2, DUST: 3, FIRE: 4, EMBER: 5, SPRAY: 6, SOOT: 7 } as const;
export type Puff = (typeof Puff)[keyof typeof Puff];
const KINDS = 8;
const VARIANTS = 6;
/** Sprite size (device px): big enough for the atom bomb's cloud, small enough to keep 48 of them cheap. */
const SIZE = 112;

/** light, mid, dark tones of each kind */
const TONES: readonly (readonly [Col, Col, Col])[] = [
  [hexCol('#5b544e'), hexCol('#37322f'), hexCol('#1d1a18')],
  [hexCol('#a29b93'), hexCol('#736d67'), hexCol('#48433f')],
  [hexCol('#f4f3ee'), hexCol('#d5d3cd'), hexCol('#a6a49e')],
  [hexCol('#c4b08c'), hexCol('#957f60'), hexCol('#63523c')],
  [hexCol('#fff6d6'), hexCol('#ffb84f'), hexCol('#d9581f')],
  [hexCol('#ffb46b'), hexCol('#c9471c'), hexCol('#5e1c0b')],
  [hexCol('#ffffff'), hexCol('#e0edf2'), hexCol('#a6c0cd')],
  [hexCol('#3a3530'), hexCol('#1f1c1a'), hexCol('#0d0c0b')],
];

/** The wind (screen direction smoke drifts toward, per second of drift at the effect's scale). */
export const WIND_X = 0.86;
export const WIND_Y = -0.5;

const sprites: (HTMLCanvasElement | null)[] = new Array(KINDS * VARIANTS).fill(null);
let flashSprite: HTMLCanvasElement | null = null;
let ready = false;
let failed = false;

function paintPuff(c: CanvasRenderingContext2D, kind: number, v: number): void {
  const [light, mid, dark] = TONES[kind];
  const R = SIZE / 2;
  const fire = kind === Puff.FIRE || kind === Puff.EMBER;
  const seed = kind * 31 + v * 7 + 3;
  // the body: one big soft blob and many smaller soft lobes packed round it (bigger toward the middle), all one tone,
  // their edges fading out so they merge into one mass
  const blob = (x: number, y: number, r: number, a: number): void => {
    const g = c.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, css(mid, a));
    g.addColorStop(0.55, css(mid, a * 0.92));
    g.addColorStop(0.8, css(mid, a * 0.45));
    g.addColorStop(1, css(mid, 0));
    c.fillStyle = g;
    c.beginPath();
    c.arc(x, y, r, 0, TAU);
    c.fill();
  };
  blob(R, R, R * 0.66, 0.9);
  const lobes: [number, number, number][] = [];
  const n = 13 + (v % 3) * 2;
  for (let i = 0; i < n; i++) {
    const a = rnd(seed, i) * TAU;
    const d = Math.sqrt(rnd(seed, i + 20)) * 0.5;
    const r = (0.2 + rnd(seed, i + 40) * 0.2) * (1 - d * 0.5);
    lobes.push([Math.cos(a) * d, Math.sin(a) * d * 0.92, r]);
    blob(R + Math.cos(a) * d * R, R + Math.sin(a) * d * 0.92 * R, r * R, 0.85);
  }
  c.save();
  c.globalCompositeOperation = 'source-atop';
  if (fire) {
    // a hot core fading to deep orange and red at the edge
    const g = c.createRadialGradient(R, R, 0, R, R, R);
    g.addColorStop(0, css(light, 0.95));
    g.addColorStop(0.32, css(light, 0.55));
    g.addColorStop(0.6, css(mid, 0.2));
    g.addColorStop(0.85, css(dark, 0.7));
    g.addColorStop(1, css(dark, 0.9));
    c.fillStyle = g;
    c.fillRect(0, 0, SIZE, SIZE);
  } else {
    // the whole cloud lit from the top left: its own shade on the lower right
    const g = c.createLinearGradient(R + LIGHT_X * R, R + LIGHT_Y * R, R - LIGHT_X * R, R - LIGHT_Y * R);
    g.addColorStop(0, css(light, 0.8));
    g.addColorStop(0.42, css(light, 0.12));
    g.addColorStop(0.58, css(dark, 0.12));
    g.addColorStop(1, css(dark, 0.85));
    c.fillStyle = g;
    c.fillRect(0, 0, SIZE, SIZE);
  }
  // each billow catches the light on its upper left and has a soft shade under its lower right
  for (const [lx, ly, lr] of lobes) {
    const x = R + lx * R;
    const y = R + ly * R;
    const r = lr * R;
    const h = c.createRadialGradient(x + LIGHT_X * r * 0.45, y + LIGHT_Y * r * 0.45, 0, x + LIGHT_X * r * 0.45, y + LIGHT_Y * r * 0.45, r * 0.75);
    h.addColorStop(0, css(light, fire ? 0.35 : 0.42));
    h.addColorStop(1, css(light, 0));
    c.fillStyle = h;
    c.beginPath();
    c.arc(x, y, r, 0, TAU);
    c.fill();
    const sh = c.createRadialGradient(x - LIGHT_X * r * 0.5, y - LIGHT_Y * r * 0.5, 0, x - LIGHT_X * r * 0.5, y - LIGHT_Y * r * 0.5, r * 0.7);
    sh.addColorStop(0, css(dark, fire ? 0.18 : 0.3));
    sh.addColorStop(1, css(dark, 0));
    c.fillStyle = sh;
    c.beginPath();
    c.arc(x, y, r, 0, TAU);
    c.fill();
  }
  // a fine grain
  for (let i = 0; i < 90; i++) {
    const a = rnd(seed, i + 90) * TAU;
    const d = Math.sqrt(rnd(seed, i + 190)) * R * 0.85;
    const x = R + Math.cos(a) * d;
    const y = R + Math.sin(a) * d;
    const r = 1 + rnd(seed, i + 290) * 2.5;
    const lit = (x - R) * LIGHT_X + (y - R) * LIGHT_Y > 0;
    c.fillStyle = fire ? (lit ? 'rgba(255,250,220,0.2)' : 'rgba(120,30,8,0.18)') : lit ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.1)';
    c.beginPath();
    c.arc(x, y, r, 0, TAU);
    c.fill();
  }
  c.restore();
}

function init(): boolean {
  if (ready) return true;
  if (failed || typeof document === 'undefined') return false;
  try {
    for (let k = 0; k < KINDS; k++)
      for (let v = 0; v < VARIANTS; v++) {
        const cv = makeCanvas(SIZE, SIZE);
        const c = cv.getContext('2d');
        if (!c) throw new Error('no 2d');
        paintPuff(c, k, v);
        sprites[k * VARIANTS + v] = cv;
      }
    const f = makeCanvas(SIZE, SIZE);
    const c = f.getContext('2d');
    if (!c) throw new Error('no 2d');
    const g = c.createRadialGradient(SIZE / 2, SIZE / 2, 0, SIZE / 2, SIZE / 2, SIZE / 2);
    g.addColorStop(0, 'rgba(255,255,246,1)');
    g.addColorStop(0.18, 'rgba(255,240,190,0.9)');
    g.addColorStop(0.45, 'rgba(255,170,70,0.45)');
    g.addColorStop(1, 'rgba(255,120,40,0)');
    c.fillStyle = g;
    c.fillRect(0, 0, SIZE, SIZE);
    flashSprite = f;
    ready = true;
  } catch {
    failed = true;
  }
  return ready;
}

/** True once the puffs are painted (false without a canvas: tests in node). */
export function puffsReady(): boolean {
  return init();
}

/** One puff of `kind` (variant from `v`) centred at (x, y), radius r (CSS px), at `alpha`. */
export function puff(ctx: CanvasRenderingContext2D, kind: Puff, v: number, x: number, y: number, r: number, alpha: number): void {
  if (alpha <= 0.004 || r <= 0.2 || !init()) return;
  const s = sprites[kind * VARIANTS + (((v % VARIANTS) + VARIANTS) % VARIANTS)];
  if (!s) return;
  const prev = ctx.globalAlpha;
  ctx.globalAlpha = prev * Math.min(1, alpha);
  ctx.drawImage(s, x - r, y - r, r * 2, r * 2);
  ctx.globalAlpha = prev;
}

/** A soft light: the glow of a flash or of fire, added to what is under it. */
export function glow(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, alpha: number): void {
  if (alpha <= 0.004 || r <= 0.2 || !init() || !flashSprite) return;
  const prevA = ctx.globalAlpha;
  const prevOp = ctx.globalCompositeOperation;
  ctx.globalCompositeOperation = 'lighter';
  ctx.globalAlpha = prevA * Math.min(1, alpha);
  ctx.drawImage(flashSprite, x - r, y - r, r * 2, r * 2);
  ctx.globalAlpha = prevA;
  ctx.globalCompositeOperation = prevOp;
}

/** The same light drawn over (not added), for a flash that must show on bright ground. */
export function flashOver(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, alpha: number): void {
  if (alpha <= 0.004 || r <= 0.2 || !init() || !flashSprite) return;
  const prevA = ctx.globalAlpha;
  ctx.globalAlpha = prevA * Math.min(1, alpha);
  ctx.drawImage(flashSprite, x - r, y - r, r * 2, r * 2);
  ctx.globalAlpha = prevA;
}

/** Ease out (fast start, gentle end). */
export const easeOut = (t: number): number => 1 - (1 - t) * (1 - t);
export const easeOut3 = (t: number): number => 1 - (1 - t) * (1 - t) * (1 - t);
export const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
/** 0 before a, rising to 1 at b. */
export const ramp = (t: number, a: number, b: number): number => clamp01((t - a) / (b - a));

/**
 * Debris: dark chunks thrown out from (x, y) along ballistic paths (top-down: out and slowing, a hint of rising and
 * falling back on screen), with a short hot streak while they are fresh. `n` chunks, out to `reach` px over time 0..1.
 */
export function debris(ctx: CanvasRenderingContext2D, x: number, y: number, n: number, reach: number, t: number, seed: number, size: number, hot = true): void {
  if (t <= 0 || t >= 1 || n <= 0) return;
  const prev = ctx.globalAlpha;
  const fade = 1 - ramp(t, 0.7, 1);
  for (let i = 0; i < n; i++) {
    const a = rnd(seed, i * 5) * TAU;
    const sp = 0.45 + rnd(seed, i * 5 + 1) * 0.55;
    const d = reach * sp * easeOut(t);
    const lift = reach * 0.35 * sp * Math.sin(Math.PI * Math.min(1, t * 1.15));
    const px = x + Math.cos(a) * d;
    const py = y + Math.sin(a) * d * 0.85 - lift;
    const s = size * (0.5 + rnd(seed, i * 5 + 2) * 0.8);
    if (hot && t < 0.35) {
      // the hot streak behind a fresh chunk
      const back = d * 0.25;
      ctx.globalAlpha = prev * (1 - t / 0.35) * 0.8;
      ctx.strokeStyle = 'rgba(255,190,90,0.9)';
      ctx.lineWidth = Math.max(0.6, s * 0.45);
      ctx.beginPath();
      ctx.moveTo(px - Math.cos(a) * back, py - Math.sin(a) * back * 0.85 + lift * 0.2);
      ctx.lineTo(px, py);
      ctx.stroke();
    }
    ctx.globalAlpha = prev * fade;
    ctx.fillStyle = i % 3 === 0 ? '#3b2f25' : '#1d1915';
    const rot = rnd(seed, i * 5 + 3) * TAU + t * 6 * (i % 2 ? 1 : -1);
    const c = Math.cos(rot) * s;
    const sn = Math.sin(rot) * s;
    ctx.beginPath();
    ctx.moveTo(px + c, py + sn);
    ctx.lineTo(px - sn * 0.6, py + c * 0.6);
    ctx.lineTo(px - c * 0.8, py - sn * 0.8);
    ctx.lineTo(px + sn * 0.5, py - c * 0.5);
    ctx.closePath();
    ctx.fill();
  }
  ctx.globalAlpha = prev;
}

/** Sparks: bright short streaks flying out, gone quickly. */
export function sparks(ctx: CanvasRenderingContext2D, x: number, y: number, n: number, reach: number, t: number, seed: number, w: number): void {
  if (t <= 0 || t >= 1 || n <= 0) return;
  const prev = ctx.globalAlpha;
  ctx.lineCap = 'round';
  for (let i = 0; i < n; i++) {
    const a = rnd(seed, i * 3 + 101) * TAU;
    const sp = 0.5 + rnd(seed, i * 3 + 102) * 0.5;
    const d = reach * sp * easeOut(t);
    const len = reach * 0.18 * (1 - t);
    const px = x + Math.cos(a) * d;
    const py = y + Math.sin(a) * d * 0.85;
    ctx.globalAlpha = prev * (1 - t) * (1 - t);
    ctx.strokeStyle = i % 2 ? '#fff2c0' : '#ffbd5c';
    ctx.lineWidth = w;
    ctx.beginPath();
    ctx.moveTo(px - Math.cos(a) * len, py - Math.sin(a) * len * 0.85);
    ctx.lineTo(px, py);
    ctx.stroke();
  }
  ctx.lineCap = 'butt';
  ctx.globalAlpha = prev;
}
