// The detailed style's paratroopers (client only). A parachute is a small baked pixel picture: a canopy of panels
// (gores) in the owner's colour, lit from the top left and darker at its skirt, thin rigging lines and a soldier in
// olive drab hanging under it. A stick of troops jumps one after the other: each canopy streams out, opens, drifts
// down swaying (the planes' motion sets how much), its shadow closing in on it on the ground; on landing the canopy
// collapses into a crumpled heap beside the soldier, then fades. Drawn at every zoom (small and cheap far out). The
// cargo plane in flight carries a small parachute mark.
import type { MotionParams } from '../motion';
import { canBake, SpriteAtlas, type RGBABitmap } from '../shared/atlas';
import { rnd } from '../shared/noise';
import type { ParachuteMarkDraw, ParadropArt, ParadropDraw } from '../types';
import { gridOf, type Grid } from './grid';
import { ownerTones, rampOf } from './palette';

const DROP_MS = 2000;
const spreadOf = (zoom: number): number => Math.max(10, zoom * 2.4);
const scaleAt = (z: number): number => (z < 11 ? 1 : z < 22 ? 2 : z < 32 ? 3 : 4);

/** Parachute states: hanging with the canopy tilted left, straight, right; collapsed on the ground; streaming open. */
const LEFT = 0;
const STRAIGHT = 1;
const RIGHT = 2;
const DOWN = 3;
const STREAM = 4;

const OLIVE = rampOf('olive');
const DARK: readonly number[] = [20, 22, 18];

/**
 * A parachute's pixels: canopy `w` cells wide (5..24) in the owner's colour, in a state. The origin is the soldier's
 * feet (where he lands).
 */
export function chuteBitmap(owner: readonly number[], w: number, state: number): RGBABitmap {
  const W0 = Math.max(5, Math.min(24, Math.round(w)));
  const tones = ownerTones(owner);
  const ch = Math.max(3, Math.round(W0 * 0.5));
  const lines = Math.max(3, Math.round(W0 * 0.85));
  const W = W0 + 4;
  const H = ch + lines + 6;
  const data = new Uint8ClampedArray(W * H * 4);
  const set = (x: number, y: number, c: readonly number[], a = 255): void => {
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    const o = (y * W + x) * 4;
    data[o] = c[0];
    data[o + 1] = c[1];
    data[o + 2] = c[2];
    data[o + 3] = a;
  };
  const cx = Math.floor(W / 2);
  const feet = H - 2;
  // the soldier: helmet, body with a pack, legs
  const soldier = (x: number, y: number): void => {
    set(x, y - 3, OLIVE[3]);
    set(x, y - 2, OLIVE[2]);
    set(x + 1, y - 2, OLIVE[1]);
    set(x, y - 1, OLIVE[1]);
    set(x + 1, y - 1, OLIVE[0]);
    set(x, y, DARK);
  };
  if (state === DOWN) {
    // the canopy collapsed in a crumpled heap beside the soldier, folds in the darker tone
    const hw = Math.round(W0 * 0.45);
    for (let x = -hw; x <= hw; x++) {
      const hh = Math.max(1, Math.round(1.6 * (1 - (x / (hw + 1)) ** 2)));
      for (let y = 0; y < hh; y++) set(cx + 2 + x, feet - y, (x + y) % 3 === 0 ? tones[1] : y === hh - 1 ? tones[3] : tones[2]);
    }
    soldier(cx - hw - 1, feet);
    return { w: W, h: H, ox: cx, oy: feet, data };
  }
  const tilt = state === LEFT ? -1 : state === RIGHT ? 1 : 0;
  const top = 1;
  if (state === STREAM) {
    // a streamer: the canopy still a narrow column of cloth
    for (let y = 0; y < ch + 2; y++) for (let x = -1; x <= 0; x++) set(cx + x, top + y, x === -1 ? tones[3] : tones[1]);
  } else {
    // the canopy: a dome of gores, lit on the left, the skirt darker
    const hw = W0 / 2;
    for (let y = 0; y < ch; y++) {
      const yy = 1 - y / ch;
      const half = hw * Math.sqrt(Math.max(0, 1 - yy * yy * 0.95));
      for (let x = Math.round(-half); x <= Math.round(half) - 1; x++) {
        const gore = Math.floor(((x + hw) / W0) * 5);
        const lit = x < -half * 0.25 ? 1 : x > half * 0.35 ? -1 : 0;
        let t = 2 + lit + (gore % 2 === 0 ? 0 : -1);
        if (y === ch - 1) t = 0;
        else if (y === 0 && x < 0) t = 3;
        set(cx + x + tilt, top + y, tones[Math.max(0, Math.min(3, t))]);
      }
    }
  }
  // rigging: lines from the skirt's edges and middle to the soldier's shoulders
  const sy = top + ch;
  const ey = feet - 3;
  for (const ex of [-W0 / 2 + 1, 0, W0 / 2 - 1]) {
    for (let y = sy; y < ey; y++) {
      const q = (y - sy) / Math.max(1, ey - sy);
      const x = Math.round(cx + tilt + (state === STREAM ? 0 : ex) * (1 - q));
      set(x, y, [52, 54, 50], 200);
    }
  }
  soldier(cx, feet);
  return { w: W, h: H, ox: cx, oy: feet, data };
}

const atlas = new SpriteAtlas(512, 4);

function drawChute(ctx: CanvasRenderingContext2D, owner: readonly number[], w: number, state: number, x: number, y: number, g: Grid, alpha: number): void {
  if (!canBake() || alpha <= 0.01) return;
  const W = Math.max(5, Math.min(24, Math.round(w)));
  const key = (((((owner[0] & 255) << 16) | ((owner[1] & 255) << 8) | (owner[2] & 255)) * 32 + W) * 8 + state);
  const e = atlas.get(key, () => chuteBitmap(owner, W, state));
  if (!e) return;
  const prev = ctx.globalAlpha;
  const sm = ctx.imageSmoothingEnabled;
  ctx.imageSmoothingEnabled = false;
  ctx.globalAlpha = prev * alpha;
  const X = (Math.round((x * g.dpr) / g.p) * g.p) / g.dpr - e.ox * g.k;
  const Y = (Math.round((y * g.dpr) / g.p) * g.p) / g.dpr - e.oy * g.k;
  ctx.drawImage(e.page, e.sx, e.sy, e.w, e.h, X, Y, e.w * g.k, e.h * g.k);
  ctx.globalAlpha = prev;
  ctx.imageSmoothingEnabled = sm;
}

function draw(ctx: CanvasRenderingContext2D, d: ParadropDraw, m: MotionParams): void {
  const t = d.t;
  if (t < 0 || t >= 1) return;
  const g = gridOf(Math.max(1, d.scale || scaleAt(d.zoom)), d.dpr);
  const spread = spreadOf(d.zoom);
  const size = Math.max(5, Math.min(10, d.zoom * 0.65)) / g.k;
  const sway = m.reduced ? 0 : Math.min(1.8, m.bankMax / 0.4);
  const turn = d.seed * Math.PI * 2;
  const fade = t < 0.8 ? 1 : 1 - (t - 0.8) / 0.2;
  const prev = ctx.globalAlpha;
  for (let k = 0; k < d.count; k++) {
    const a = (k / d.count) * Math.PI * 2 + turn;
    const r = spread * (0.35 + (0.65 * ((k * 37) % 10)) / 10);
    const gx = d.x + Math.cos(a) * r;
    const gy = d.y + Math.sin(a) * r * 0.6;
    // a stick: each jumps a moment after the last, lands a little later
    const t0 = k * 0.025;
    const tl = 0.6 + 0.12 * rnd(d.seed * 10, k) + t0;
    if (t < t0) continue;
    if (t >= tl) {
      drawChute(ctx, d.owner, size, DOWN, gx, gy, g, fade);
      continue;
    }
    const q = (t - t0) / (tl - t0);
    const h = (1 - q) * spread * 1.6;
    const sw = Math.sin(t * 7 + k * 1.3) * sway;
    const x = gx + sw * size * g.k * 0.18;
    // the shadow on the ground closing in as he comes down
    ctx.globalAlpha = prev * 0.3 * fade * (0.4 + 0.6 * q);
    ctx.fillStyle = '#0a0c0e';
    const cell = g.k;
    ctx.fillRect((Math.round(((gx + h * 0.35) * g.dpr) / g.p) * g.p) / g.dpr, (Math.round(((gy + h * 0.1) * g.dpr) / g.p) * g.p) / g.dpr, cell * 2, cell);
    ctx.globalAlpha = prev;
    const state = q < 0.08 ? STREAM : sw < -0.35 ? LEFT : sw > 0.35 ? RIGHT : STRAIGHT;
    drawChute(ctx, d.owner, size * (q < 0.12 ? 0.7 + q * 2.5 : 1), state, x, gy - h, g, fade);
  }
  ctx.globalAlpha = prev;
}

function drawMark(ctx: CanvasRenderingContext2D, p: ParachuteMarkDraw, _m: MotionParams): void {
  const g = gridOf(scaleAt(p.zoom), p.dpr);
  drawChute(ctx, p.owner, 7 / g.k + 1, STRAIGHT, p.x + p.half + 5, p.y + p.half * 0.6 + 9, g, 1);
}

export const detailedParadrop: ParadropArt = {
  durationMs: (m) => DROP_MS * (0.85 + 0.15 * Math.min(2, m.contrailLife)),
  reachPx: (zoom) => spreadOf(zoom) * 3,
  draw,
  drawMark,
};
