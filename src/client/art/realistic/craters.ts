// The realistic style's craters (client only): scorched earth that weathers away. Two painted layers per crater, baked
// once per shape (six) and size (steps of 1.25x in device px) and drawn scaled to the exact radius:
//   scorch   soot burnt into the ground round the hole and radial streaks of soot thrown out, ragged and uneven; it
//            fades first, as rain and wind wash it out
//   pit      the bowl (its upper left inner wall in shade, its lower right wall lit, since the light comes from the
//            top left), the raised rim of thrown earth (lit on its upper left outer slope) and clods scattered round it;
//            it stays longest
// A fresh crater still glows red in the bottom of the pit and, with craterSmoke, lets thin smoke wisps rise and drift.
import type { MotionParams } from '../motion';
import { SpriteAtlas, type AtlasEntry } from '../shared/atlas';
import { rnd } from '../shared/noise';
import type { CraterArt, CraterDraw } from '../types';
import { LIGHT_X, LIGHT_Y, TAU } from './paint';
import { clamp01, glow, Puff, puff, ramp, WIND_X, WIND_Y } from './puffs';

const atlas = new SpriteAtlas(1024, 3);
const VARIANTS = 6;
/** The biggest crater radius baked (device px); bigger ones are drawn enlarged (soft paint stays soft). */
const MAX_R = 64;
/** A crater's sprite reaches this many radii from its centre (the longest streaks). */
const REACH = 2.6;

function bucketR(rd: number): { b: number; r: number } {
  const b = Math.max(0, Math.round(Math.log(Math.max(1.5, Math.min(MAX_R, rd))) / Math.log(1.25)));
  return { b, r: Math.pow(1.25, b) };
}

const RX: number[] = [];
const RY: number[] = [];

/**
 * A ragged closed outline round (cx, cy): radius r with a wobble of `w` (0..1), drawn as one smooth curve through the
 * midpoints of its corners (an uneven lump of earth, never a polygon with straight facets).
 */
function ragged(c: CanvasRenderingContext2D, cx: number, cy: number, r: number, w: number, seed: number, n = 18): void {
  for (let i = 0; i < n; i++) {
    const a = (i / n) * TAU + (rnd(seed, i + 500) - 0.5) * (TAU / n) * 0.5;
    const k = 1 + (rnd(seed, i) - 0.5) * 2 * w;
    RX[i] = cx + Math.cos(a) * r * k;
    RY[i] = cy + Math.sin(a) * r * k * 0.9;
  }
  c.moveTo((RX[n - 1] + RX[0]) / 2, (RY[n - 1] + RY[0]) / 2);
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    c.quadraticCurveTo(RX[i], RY[i], (RX[i] + RX[j]) / 2, (RY[i] + RY[j]) / 2);
  }
  c.closePath();
}

function paintScorch(c: CanvasRenderingContext2D, r: number, v: number): void {
  const seed = 41 + v * 17;
  const g = c.createRadialGradient(0, 0, r * 0.3, 0, 0, r * 2);
  g.addColorStop(0, 'rgba(22,17,13,0.75)');
  g.addColorStop(0.45, 'rgba(28,22,17,0.45)');
  g.addColorStop(1, 'rgba(30,24,18,0)');
  c.fillStyle = g;
  c.beginPath();
  ragged(c, 0, 0, r * 2, 0.18, seed, 22);
  c.fill();
  // radial streaks of soot thrown out: feathered plumes of uneven length and width, bowed a little (blast soot, not a
  // drawn star), fading out along their length
  const n = 14 + (v % 3) * 3;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * TAU + (rnd(seed, i + 30) - 0.5) * 0.35;
    const len = r * (1.25 + Math.pow(rnd(seed, i + 50), 1.4) * (REACH - 1.35));
    const w = r * (0.08 + rnd(seed, i + 70) * 0.14);
    const bow = (rnd(seed, i + 110) - 0.5) * w * 1.6;
    const c0 = Math.cos(a);
    const s0 = Math.sin(a);
    const x0 = c0 * r * 0.6;
    const y0 = s0 * r * 0.6 * 0.9;
    const x1 = c0 * len;
    const y1 = s0 * len * 0.9;
    // the plume's widest point a third of the way out, its tip rounded off
    const xm = c0 * (r * 0.6 + (len - r * 0.6) * 0.38) - s0 * bow;
    const ym = (s0 * (r * 0.6 + (len - r * 0.6) * 0.38)) * 0.9 + c0 * bow;
    const sg = c.createLinearGradient(x0, y0, x1, y1);
    const a0 = 0.3 + rnd(seed, i + 90) * 0.22;
    sg.addColorStop(0, `rgba(18,14,11,${a0.toFixed(3)})`);
    sg.addColorStop(0.55, `rgba(18,14,11,${(a0 * 0.4).toFixed(3)})`);
    sg.addColorStop(1, 'rgba(18,14,11,0)');
    c.fillStyle = sg;
    c.beginPath();
    c.moveTo(x0 - s0 * w * 0.7, y0 + c0 * w * 0.7);
    c.quadraticCurveTo(xm - s0 * w * 1.1, ym + c0 * w * 1.1, x1 - s0 * w * 0.15, y1 + c0 * w * 0.15);
    c.quadraticCurveTo(x1 + c0 * w * 0.3, y1 + s0 * w * 0.3, x1 + s0 * w * 0.15, y1 - c0 * w * 0.15);
    c.quadraticCurveTo(xm + s0 * w * 1.1, ym - c0 * w * 1.1, x0 + s0 * w * 0.7, y0 - c0 * w * 0.7);
    c.closePath();
    c.fill();
  }
  // burnt specks
  for (let i = 0; i < 26; i++) {
    const a = rnd(seed, i + 200) * TAU;
    const d = r * (0.8 + rnd(seed, i + 220) * 1.3);
    c.fillStyle = `rgba(14,11,9,${(0.25 + rnd(seed, i + 240) * 0.35).toFixed(3)})`;
    c.beginPath();
    c.arc(Math.cos(a) * d, Math.sin(a) * d * 0.9, Math.max(0.5, r * 0.05 * (0.5 + rnd(seed, i + 260))), 0, TAU);
    c.fill();
  }
}

function paintPit(c: CanvasRenderingContext2D, r: number, v: number): void {
  const seed = 97 + v * 23;
  // fine clods of earth thrown out round the rim, darker and smaller further out
  for (let i = 0; i < 28; i++) {
    const a = rnd(seed, i) * TAU;
    const d = r * (1.1 + Math.pow(rnd(seed, i + 20), 1.6) * 0.95);
    const s = Math.max(0.45, r * (0.03 + rnd(seed, i + 40) * 0.05) * (1.6 - (d / r - 1.1)));
    const x = Math.cos(a) * d;
    const y = Math.sin(a) * d * 0.9;
    c.fillStyle = 'rgba(10,8,6,0.35)';
    c.beginPath();
    c.ellipse(x - LIGHT_X * s * 0.5, y - LIGHT_Y * s * 0.5, s * 1.2, s * 0.9, a, 0, TAU);
    c.fill();
    c.fillStyle = i % 4 === 0 ? '#8a7659' : i % 2 ? '#4d3e2f' : '#65533f';
    c.beginPath();
    c.ellipse(x, y, s * 1.2, s * 0.9, a, 0, TAU);
    c.fill();
  }
  // the raised rim of thrown earth: solid at the lip, thinning out into the ground
  const rim = c.createRadialGradient(0, 0, r * 0.7, 0, 0, r * 1.3);
  rim.addColorStop(0, 'rgba(98,82,62,1)');
  rim.addColorStop(0.35, 'rgba(98,82,62,1)');
  rim.addColorStop(0.62, 'rgba(92,77,58,0.75)');
  rim.addColorStop(1, 'rgba(88,74,56,0)');
  c.fillStyle = rim;
  c.beginPath();
  ragged(c, 0, 0, r * 1.3, 0.12, seed + 5, 22);
  c.fill();
  // lit on its upper left outer slope, in shade on the lower right (only over the earth just painted)
  c.save();
  c.globalCompositeOperation = 'source-atop';
  const lit = c.createLinearGradient(LIGHT_X * r * 1.3, LIGHT_Y * r * 1.3, -LIGHT_X * r * 1.3, -LIGHT_Y * r * 1.3);
  lit.addColorStop(0, 'rgba(200,182,150,0.55)');
  lit.addColorStop(0.45, 'rgba(200,182,150,0)');
  lit.addColorStop(0.6, 'rgba(20,14,10,0)');
  lit.addColorStop(1, 'rgba(20,14,10,0.5)');
  c.fillStyle = lit;
  c.fillRect(-r * 2.2, -r * 2.2, r * 4.4, r * 4.4);
  for (let i = 0; i < 40; i++) {
    const a = rnd(seed, i + 300) * TAU;
    const d = r * (0.85 + rnd(seed, i + 320) * 0.4);
    c.fillStyle = i % 2 ? 'rgba(30,22,16,0.3)' : 'rgba(170,150,120,0.25)';
    c.beginPath();
    c.arc(Math.cos(a) * d, Math.sin(a) * d * 0.9, Math.max(0.4, r * 0.035), 0, TAU);
    c.fill();
  }
  c.restore();
  // the bowl: shade on the upper left inner wall, light on the lower right
  const bowl = c.createRadialGradient(-LIGHT_X * r * 0.32, -LIGHT_Y * r * 0.32, r * 0.05, 0, 0, r * 0.9);
  bowl.addColorStop(0, '#5a4a39');
  bowl.addColorStop(0.5, '#382d23');
  bowl.addColorStop(1, '#1a140f');
  c.fillStyle = bowl;
  c.beginPath();
  ragged(c, 0, 0, r * 0.86, 0.07, seed + 9, 18);
  c.fill();
  // the shadow the lip throws into the bowl, soft
  c.save();
  c.beginPath();
  ragged(c, 0, 0, r * 0.86, 0.07, seed + 9, 18);
  c.clip();
  const sh = c.createRadialGradient(LIGHT_X * r * 0.9, LIGHT_Y * r * 0.9, r * 0.2, LIGHT_X * r * 0.9, LIGHT_Y * r * 0.9, r * 1.15);
  sh.addColorStop(0, 'rgba(6,4,3,0.55)');
  sh.addColorStop(0.7, 'rgba(6,4,3,0.3)');
  sh.addColorStop(1, 'rgba(6,4,3,0)');
  c.fillStyle = sh;
  c.fillRect(-r, -r, r * 2, r * 2);
  // loose earth in the bottom
  for (let i = 0; i < 14; i++) {
    const a = rnd(seed, i + 60) * TAU;
    const d = r * 0.6 * Math.sqrt(rnd(seed, i + 70));
    c.fillStyle = i % 2 ? 'rgba(20,15,11,0.4)' : 'rgba(120,100,76,0.3)';
    c.beginPath();
    c.arc(Math.cos(a) * d, Math.sin(a) * d, Math.max(0.35, r * 0.03), 0, TAU);
    c.fill();
  }
  c.restore();
}

/** A crater's picture: 0 the scorch, 1 the pit, 2 both together (far out, where a crater is a few px). */
function sprite(layer: 0 | 1 | 2, v: number, b: number, r: number): AtlasEntry | null {
  const id = (b * VARIANTS + v) * 3 + layer;
  const hit = atlas.peek(id);
  if (hit !== undefined) return hit;
  const half = Math.ceil(r * (layer === 1 ? 2.1 : REACH)) + 2;
  return atlas.getPainted(id, half * 2, half * 2, half, half, (c) => {
    c.translate(half, half);
    if (layer !== 1) paintScorch(c, r, v);
    if (layer !== 0) paintPit(c, r, v);
  });
}

/** Below this radius (device px) a crater is one picture with no glow or smoke: a field of hundreds stays cheap. */
const SMALL_R = 5;

function blit(ctx: CanvasRenderingContext2D, e: AtlasEntry, x: number, y: number, k: number): void {
  ctx.drawImage(e.page, e.sx, e.sy, e.w, e.h, x - e.ox * k, y - e.oy * k, e.w * k, e.h * k);
}

function draw(ctx: CanvasRenderingContext2D, d: CraterDraw, m: MotionParams): void {
  const q = d.q;
  if (q < 0 || q >= 1 || d.radiusPx <= 0.3) return;
  const v = Math.floor(d.seed * VARIANTS) % VARIANTS;
  const dpr = Math.max(1, d.dpr);
  const { b, r } = bucketR(d.radiusPx * dpr);
  const k = d.radiusPx / r;
  const prevA = ctx.globalAlpha;
  const prevS = ctx.imageSmoothingEnabled;
  ctx.imageSmoothingEnabled = true;
  // the soot washes out first, the hole and its rim last
  const a0 = 1 - ramp(q, 0.3, 0.85);
  const a1 = 1 - ramp(q, 0.55, 1);
  if (d.radiusPx * dpr < SMALL_R) {
    // far out: soot and pit as one picture, fading between the two
    const both = sprite(2, v, b, r);
    if (both) {
      ctx.globalAlpha = prevA * (a0 + a1) * 0.5;
      blit(ctx, both, d.x, d.y, k);
    }
    ctx.globalAlpha = prevA;
    ctx.imageSmoothingEnabled = prevS;
    return;
  }
  const scorch = sprite(0, v, b, r);
  const pit = sprite(1, v, b, r);
  if (scorch && a0 > 0) {
    ctx.globalAlpha = prevA * a0;
    blit(ctx, scorch, d.x, d.y, k);
  }
  if (pit && a1 > 0) {
    ctx.globalAlpha = prevA * a1 * (0.85 + 0.15 * (1 - q));
    blit(ctx, pit, d.x, d.y, k);
  }
  ctx.globalAlpha = prevA;
  ctx.imageSmoothingEnabled = prevS;
  // fresh: embers glowing in the bottom of the pit
  if (q < 0.1) glow(ctx, d.x, d.y, d.radiusPx * 1.1, 0.45 * (1 - q / 0.1));
  // thin smoke wisps rising from a fresh crater and leaning with the wind (craterSmoke)
  const smoke = m.craterSmoke * (1 - ramp(q, 0.04, 0.4));
  if (smoke > 0.01 && !m.reduced) {
    const tMs = q * 9000 * m.craterLife;
    const R = Math.max(2, d.radiusPx);
    for (let i = 0; i < 3; i++) {
      const ph = (tMs / 1500 + i / 3 + d.seed) % 1;
      const rise = R * 2.2 * ph;
      const drift = R * 1.4 * ph * ph;
      puff(ctx, i === 1 ? Puff.WHITE : Puff.GREY, i + v, d.x + WIND_X * drift, d.y - rise + WIND_Y * drift, R * (0.4 + ph * 0.9), 0.4 * smoke * clamp01(ph * 6) * (1 - ph));
    }
  }
}

export const realisticCraters: CraterArt = { draw };
