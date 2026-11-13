// The realistic style's flames (client only): a few flame pictures painted once into small canvases, then drawn
// turned and stretched wherever a fire or a gun flash needs them (craters.ts, cannon.ts). Each picture points along +x
// from its base (x = 0) to its tip and is painted in nested bands, as a flame burns: a white-hot core at the base,
// then yellow, orange and a deep orange-red skin whose ragged tips fade out, with a soft glow round it. The bands have
// clean edges (no blur inside the flame), so a flame stays crisp next to the pixel art it may be mixed with, and the
// colours are the fire ramp every style shares (white hot #fff4d6, yellow #ffd98a, orange #f6a53e, deep orange
// #dc7426, red #b04a1c, dark red #7a2c14).
//
// Shapes: TONGUE a fire burning on the ground (a wide rounded base, two or three tongues licking up from it); CONE a
// gun's muzzle flash (narrow at the muzzle, a bulb of fire, then ragged fingers); JET a thin side jet of a muzzle
// blast; BOLT a single barrel's tongue of fire (the cone's body with no fingers, so three barrels side by side never
// stack up into a comb of parallel tips). Each shape in two heats: HOT (with its white core) and COOL (a dying fire: orange, red and dark red only), so
// a fire cools by fading from one to the other. Three variants of each.
import { makeCanvas } from '../../render/common';
import { rnd } from '../shared/noise';

export const Flame = { TONGUE: 0, CONE: 1, JET: 2, BOLT: 3 } as const;
export type Flame = (typeof Flame)[keyof typeof Flame];
const SHAPES = 4;
const VARIANTS = 3;
/** Picture size (device px): long enough for the biggest muzzle cone drawn close up. */
const LEN = 128;
const WID = 64;
/** Room behind the base (canvas px) for its rounded end and glow. */
const PAD = 12;

interface Profile {
  /** half width at the base (0..1 of the widest) */
  b0: number;
  /** where the flame is widest (0..1 of its length) */
  pk: number;
  /** how it narrows toward the tip (bigger = a thinner tip) */
  tp: number;
  /** the extra tongues licking out of it */
  fingers: number;
}

const PROFILES: readonly Profile[] = [
  { b0: 0.78, pk: 0.3, tp: 1.35, fingers: 1 },
  { b0: 0.3, pk: 0.34, tp: 1.05, fingers: 2 },
  { b0: 0.42, pk: 0.14, tp: 1.7, fingers: 0 },
  { b0: 0.3, pk: 0.3, tp: 1.25, fingers: 0 },
];

/** The bands of a flame, outer first: length and width (0..1 of the flame), base colour, tip colour, tip alpha. */
type Band = readonly [number, number, string, string, number];
const HOT: readonly Band[] = [
  [1, 1, '#dc7426', '#b04a1c', 0.55],
  [0.8, 0.74, '#f6a53e', '#dc7426', 0.85],
  [0.58, 0.52, '#ffd98a', '#f6a53e', 0.9],
  [0.36, 0.32, '#fff4d6', '#ffe6a8', 1],
];
const COOL: readonly Band[] = [
  [1, 1, '#b04a1c', '#7a2c14', 0.45],
  [0.72, 0.68, '#dc7426', '#b04a1c', 0.8],
  [0.44, 0.44, '#f6a53e', '#dc7426', 0.85],
];

const sprites: (HTMLCanvasElement | null)[] = new Array(SHAPES * 2 * VARIANTS).fill(null);
let lightSprite: HTMLCanvasElement | null = null;
let ready = false;
let failed = false;

/**
 * One lobe of a flame as a closed path: from its base at (x0, y0) along `ang`, `len` long, its half width following
 * the profile (`hw` at its widest), its centre line bending by `bend`, its edges a little ragged.
 */
function lobe(c: CanvasRenderingContext2D, pr: Profile, x0: number, y0: number, ang: number, len: number, hw: number, bend: number, seed: number): void {
  const n = 14;
  const ca = Math.cos(ang);
  const sa = Math.sin(ang);
  const half = (u: number, side: number): number => {
    const p = u < pr.pk ? pr.b0 + (1 - pr.b0) * Math.pow(Math.sin(((u / pr.pk) * Math.PI) / 2), 0.7) : Math.pow((1 - u) / (1 - pr.pk), pr.tp);
    // ragged edges, more toward the tip
    const rag = 1 + (rnd(seed, Math.round(u * n) + (side > 0 ? 40 : 80)) - 0.5) * 0.24 * u;
    return hw * p * rag;
  };
  const at = (u: number, side: number): [number, number] => {
    const along = u * len;
    const off = bend * u * u * hw + side * half(u, side);
    return [x0 + ca * along - sa * off, y0 + sa * along + ca * off];
  };
  c.beginPath();
  let [x, y] = at(0, -1);
  c.moveTo(x, y);
  for (let i = 1; i <= n; i++) {
    [x, y] = at(i / n, -1);
    c.lineTo(x, y);
  }
  for (let i = n - 1; i >= 0; i--) {
    [x, y] = at(i / n, 1);
    c.lineTo(x, y);
  }
  // a rounded base
  const [bx, by] = at(0, 0);
  c.quadraticCurveTo(bx - ca * hw * pr.b0 * 0.9, by - sa * hw * pr.b0 * 0.9, ...at(0, -1));
  c.closePath();
}

/** The lobes of a flame (main body and its fingers) scaled by (k, kw) toward the base, filled with `style`. */
function body(c: CanvasRenderingContext2D, pr: Profile, v: number, kind: number, k: number, kw: number, style: (x0: number, x1: number) => CanvasGradient | string): void {
  const seed = 11 + kind * 37 + v * 13;
  const y = WID / 2;
  const hw = WID * 0.34 * kw;
  const len = (LEN - PAD - 4) * k;
  const bend = (rnd(seed, 1) - 0.5) * (kind === 0 ? 1.4 : 0.9);
  c.fillStyle = style(PAD, PAD + len);
  lobe(c, pr, PAD, y, 0, len, hw, bend, seed);
  c.fill();
  for (let i = 0; i < pr.fingers; i++) {
    const side = i % 2 ? 1 : -1;
    const ground = kind === 0;
    const at = (ground ? 0.12 : 0.22) + rnd(seed, i + 5) * 0.2;
    const fl = len * (ground ? 0.55 + rnd(seed, i + 9) * 0.15 : 0.5 + rnd(seed, i + 9) * 0.25);
    const fa = side * (ground ? 0.1 + rnd(seed, i + 12) * 0.08 : 0.16 + rnd(seed, i + 12) * 0.16);
    const fw = hw * (ground ? 0.55 : 0.42 + rnd(seed, i + 15) * 0.14);
    const fx = PAD + len * at;
    const fy = y + side * hw * 0.28 + bend * at * at * hw;
    lobe(c, pr, fx, fy, fa, Math.min(fl, LEN - fx - 4), fw, -side * 0.5, seed + i * 7 + 3);
    c.fill();
  }
}

function paintFlame(c: CanvasRenderingContext2D, kind: number, hot: boolean, v: number): void {
  const pr = PROFILES[kind];
  const bands = hot ? HOT : COOL;
  // a soft glow round the flame (the only soft part)
  if ('filter' in c) {
    c.save();
    c.filter = 'blur(5px)';
    c.globalAlpha = hot ? 0.5 : 0.35;
    body(c, pr, v, kind, 0.92, 1.05, () => (hot ? '#ff9a3c' : '#c4501e'));
    c.restore();
  }
  // the bands melt a little into each other (a fraction of a pixel once drawn at map size: the flame stays crisp)
  const soft = 'filter' in c;
  for (const [k, kw, base, tip, ta] of bands) {
    if (soft) c.filter = k < 1 ? 'blur(1.6px)' : 'blur(0.6px)';
    body(c, pr, v, kind, k, kw, (x0, x1) => {
      const g = c.createLinearGradient(x0, 0, x1, 0);
      g.addColorStop(0, base);
      g.addColorStop(0.55, base);
      g.addColorStop(1, hexA(tip, ta));
      return g;
    });
  }
  if (soft) c.filter = 'none';
}

function hexA(h: string, a: number): string {
  const n = parseInt(h.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a.toFixed(3)})`;
}

function init(): boolean {
  if (ready) return true;
  if (failed || typeof document === 'undefined') return false;
  try {
    for (let k = 0; k < SHAPES; k++)
      for (let h = 0; h < 2; h++)
        for (let v = 0; v < VARIANTS; v++) {
          const cv = makeCanvas(LEN, WID);
          const c = cv.getContext('2d');
          if (!c) throw new Error('no 2d');
          paintFlame(c, k, h === 0, v);
          sprites[(k * 2 + h) * VARIANTS + v] = cv;
        }
    // the light of a fire on what is round it: warm orange to deep red, no white (the flames are the bright part)
    const L = makeCanvas(64, 64);
    const c = L.getContext('2d');
    if (!c) throw new Error('no 2d');
    const g = c.createRadialGradient(32, 32, 0, 32, 32, 32);
    g.addColorStop(0, 'rgba(255,150,60,0.85)');
    g.addColorStop(0.3, 'rgba(225,100,35,0.5)');
    g.addColorStop(0.65, 'rgba(160,55,20,0.18)');
    g.addColorStop(1, 'rgba(120,40,15,0)');
    c.fillStyle = g;
    c.fillRect(0, 0, 64, 64);
    lightSprite = L;
    ready = true;
  } catch {
    failed = true;
  }
  return ready;
}

/**
 * A flame of `shape` with its base at (x, y), pointing along `ang` (radians, 0 = east, -PI/2 = up the screen), `len`
 * long and `wid` wide (CSS px), at `alpha`; `hot` picks the white-hot picture, otherwise the dying one.
 */
export function flame(ctx: CanvasRenderingContext2D, shape: Flame, hot: boolean, v: number, x: number, y: number, ang: number, len: number, wid: number, alpha: number): void {
  if (alpha <= 0.01 || len <= 0.3 || wid <= 0.2 || !init()) return;
  const s = sprites[(shape * 2 + (hot ? 0 : 1)) * VARIANTS + (((v % VARIANTS) + VARIANTS) % VARIANTS)];
  if (!s) return;
  const prev = ctx.globalAlpha;
  ctx.globalAlpha = prev * Math.min(1, alpha);
  ctx.translate(x, y);
  ctx.rotate(ang);
  const k = len / (LEN - PAD);
  ctx.drawImage(s, -PAD * k, -wid / 2, LEN * k, wid);
  ctx.rotate(-ang);
  ctx.translate(-x, -y);
  ctx.globalAlpha = prev;
}

/** The warm light of a fire or of embers, added to the ground round (x, y), radius r (CSS px). */
export function fireLight(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, alpha: number): void {
  if (alpha <= 0.01 || r <= 0.3 || !init() || !lightSprite) return;
  const prevA = ctx.globalAlpha;
  const prevOp = ctx.globalCompositeOperation;
  ctx.globalCompositeOperation = 'lighter';
  ctx.globalAlpha = prevA * Math.min(1, alpha);
  ctx.drawImage(lightSprite, x - r, y - r, r * 2, r * 2);
  ctx.globalAlpha = prevA;
  ctx.globalCompositeOperation = prevOp;
}

/**
 * Many fire lights in one go (one change of the blend mode): `n` of them at (X, Y), radius R across, alpha A, each
 * `flat` times lower than it is wide (a light lying low on the ground, never a round lamp).
 */
export function fireLights(ctx: CanvasRenderingContext2D, n: number, X: ArrayLike<number>, Y: ArrayLike<number>, R: ArrayLike<number>, A: ArrayLike<number>, flat = 1): void {
  if (n <= 0 || !init() || !lightSprite) return;
  const prevA = ctx.globalAlpha;
  const prevOp = ctx.globalCompositeOperation;
  ctx.globalCompositeOperation = 'lighter';
  for (let i = 0; i < n; i++) {
    if (A[i] <= 0.01 || R[i] <= 0.3) continue;
    ctx.globalAlpha = prevA * Math.min(1, A[i]);
    const ry = R[i] / flat;
    ctx.drawImage(lightSprite, X[i] - R[i], Y[i] - ry, R[i] * 2, ry * 2);
  }
  ctx.globalAlpha = prevA;
  ctx.globalCompositeOperation = prevOp;
}

/** True once the flames are painted (false without a canvas: tests in node). */
export function flamesReady(): boolean {
  return init();
}
