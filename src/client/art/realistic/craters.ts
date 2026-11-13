// The realistic style's craters (client only): scorched earth that weathers away. Two painted layers per crater, baked
// once per shape (six) and size (steps of 1.25x in device px) and drawn scaled to the exact radius:
//   scorch   soot burnt into the ground round the hole and radial streaks of soot thrown out, ragged and uneven; it
//            fades first, as rain and wind wash it out
//   pit      the bowl (its upper left inner wall in shade, its lower right wall lit, since the light comes from the
//            top left), the raised rim of thrown earth (lit on its upper left outer slope) and clods scattered round it;
//            it stays longest
// No two look stamped: ten shapes, each pit a little elliptical and turned its own way (the light baked in stays from
// the top left), each crater drawn a little bigger or smaller by its seed; the rim is a broken ring of lumps of uneven
// size and tone, the clods are irregular chunks, the soot streaks feathered.
// A fresh crater burns (drawFire): small fires in the pit, on the rim and on clods thrown out, flames licking up and
// leaning with the wind, embers and smoke, dying down over the first part of its life (longer and bigger after a bigger
// blast), then a little grey smoke from the pit before only the scorched crater is left to fade.
import type { MotionParams } from '../motion';
import { SpriteAtlas, type AtlasEntry } from '../shared/atlas';
import { rnd } from '../shared/noise';
import type { CraterArt, CraterDraw } from '../types';
import { fireLight, fireLights, Flame, flame } from './fire';
import { LIGHT_X, LIGHT_Y, TAU } from './paint';
import { clamp01, glow, Puff, puff, ramp, WIND_X, WIND_Y } from './puffs';

const atlas = new SpriteAtlas(1024, 4);
const VARIANTS = 10;
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
  // drawn star), fading out along their length, their sides blurred (painted once, so the blur costs nothing later)
  const soft = 'filter' in c;
  if (soft) c.filter = `blur(${Math.max(0.6, r * 0.07).toFixed(2)}px)`;
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
  if (soft) c.filter = 'none';
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

/** An irregular chunk of earth: a lumpy polygon of 5 to 7 corners round (x, y), about s across. */
function chunk(c: CanvasRenderingContext2D, x: number, y: number, s: number, seed: number): void {
  const n = 5 + Math.floor(rnd(seed, 1) * 3);
  const rot = rnd(seed, 2) * TAU;
  c.beginPath();
  for (let j = 0; j < n; j++) {
    const a = rot + (j / n) * TAU + (rnd(seed, j + 10) - 0.5) * 0.8;
    const rr = s * (0.5 + rnd(seed, j + 20) * 0.6) * (j === 0 ? 1.25 : 1);
    if (j === 0) c.moveTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr * 0.85);
    else c.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr * 0.85);
  }
  c.closePath();
}

const CLODS = ['#8a7659', '#4d3e2f', '#65533f', '#3d3126', '#776448', '#2e251d'];

/**
 * The pit of variant v, radius r: clods round it, then the rim and the bowl in their own ellipse and turn (`ex`, `rot`
 * from the variant), with the light given in that turned and stretched frame so the shading still falls from the top
 * left on screen.
 */
function paintPit(c: CanvasRenderingContext2D, r: number, v: number): void {
  const seed = 97 + v * 23;
  // fine clods of earth thrown out round the rim: irregular chunks, uneven in size and tone, smaller further out
  for (let i = 0; i < 30; i++) {
    const a = rnd(seed, i) * TAU;
    const d = r * (1.1 + Math.pow(rnd(seed, i + 20), 1.6) * 0.95);
    const sz = Math.max(0.5, r * (0.025 + Math.pow(rnd(seed, i + 40), 2) * 0.09) * (1.6 - (d / r - 1.1)));
    const x = Math.cos(a) * d;
    const y = Math.sin(a) * d * 0.9;
    c.fillStyle = 'rgba(10,8,6,0.32)';
    chunk(c, x - LIGHT_X * sz * 0.5, y - LIGHT_Y * sz * 0.5, sz, seed * 7 + i);
    c.fill();
    c.fillStyle = CLODS[Math.floor(rnd(seed, i + 60) * CLODS.length)];
    chunk(c, x, y, sz, seed * 7 + i);
    c.fill();
  }
  const ex = 1 + rnd(seed, 901) * 0.42;
  const rot = rnd(seed, 900) * Math.PI;
  c.save();
  c.rotate(rot);
  c.scale(ex, 1 / ex);
  // the light in this frame: turned back, then stretched the other way (and made a unit again)
  const cr = Math.cos(-rot);
  const sr = Math.sin(-rot);
  let lx = (LIGHT_X * cr - LIGHT_Y * sr) / ex;
  let ly = (LIGHT_X * sr + LIGHT_Y * cr) * ex;
  const ll = Math.hypot(lx, ly) || 1;
  lx /= ll;
  ly /= ll;
  // the raised rim of thrown earth: a low ring thinning out into the ground, then lumps along it of uneven size and
  // tone (thick and light in places, thin and dark in others), so it never reads as a smooth donut
  const ring = c.createRadialGradient(0, 0, r * 0.72, 0, 0, r * 1.32);
  ring.addColorStop(0, 'rgba(112,94,70,0.95)');
  ring.addColorStop(0.35, 'rgba(108,90,68,0.85)');
  ring.addColorStop(0.7, 'rgba(98,82,62,0.4)');
  ring.addColorStop(1, 'rgba(92,77,58,0)');
  c.fillStyle = ring;
  c.beginPath();
  ragged(c, 0, 0, r * 1.32, 0.16, seed + 5, 22);
  c.fill();
  const lumps = 18;
  for (let i = 0; i < lumps; i++) {
    const a = (i / lumps) * TAU + (rnd(seed, i + 600) - 0.5) * 0.35;
    const th = 0.1 + Math.pow(rnd(seed, i + 610), 1.4) * 0.3;
    const d = r * (1.0 + (rnd(seed, i + 620) - 0.5) * 0.14);
    const tone = 0.78 + rnd(seed, i + 630) * 0.5;
    const x = Math.cos(a) * d;
    const y = Math.sin(a) * d;
    const g = c.createRadialGradient(x, y, 0, x, y, r * th * 1.3);
    const col = `${Math.round(Math.min(255, 104 * tone))},${Math.round(Math.min(255, 88 * tone))},${Math.round(Math.min(255, 66 * tone))}`;
    g.addColorStop(0, `rgba(${col},0.9)`);
    g.addColorStop(0.6, `rgba(${col},0.5)`);
    g.addColorStop(1, `rgba(${col},0)`);
    c.fillStyle = g;
    c.beginPath();
    c.ellipse(x, y, r * th * 1.3, r * th * 0.9, a, 0, TAU);
    c.fill();
  }
  // lit on its upper left outer slope, in shade on the lower right (only over the earth just painted)
  c.save();
  c.globalCompositeOperation = 'source-atop';
  const lit = c.createLinearGradient(lx * r * 1.3, ly * r * 1.3, -lx * r * 1.3, -ly * r * 1.3);
  lit.addColorStop(0, 'rgba(200,182,150,0.5)');
  lit.addColorStop(0.45, 'rgba(200,182,150,0)');
  lit.addColorStop(0.6, 'rgba(20,14,10,0)');
  lit.addColorStop(1, 'rgba(20,14,10,0.5)');
  c.fillStyle = lit;
  c.fillRect(-r * 2.2, -r * 2.2, r * 4.4, r * 4.4);
  for (let i = 0; i < 40; i++) {
    const a = rnd(seed, i + 300) * TAU;
    const d = r * (0.85 + rnd(seed, i + 320) * 0.4);
    c.fillStyle = i % 2 ? 'rgba(30,22,16,0.3)' : 'rgba(170,150,120,0.25)';
    chunk(c, Math.cos(a) * d, Math.sin(a) * d * 0.9, Math.max(0.4, r * (0.02 + rnd(seed, i + 340) * 0.03)), seed * 3 + i);
    c.fill();
  }
  c.restore();
  // the bowl: shade on the upper left inner wall, light on the lower right
  const bowl = c.createRadialGradient(-lx * r * 0.32, -ly * r * 0.32, r * 0.05, 0, 0, r * 0.9);
  bowl.addColorStop(0, '#665440');
  bowl.addColorStop(0.55, '#43362a');
  bowl.addColorStop(1, '#251c15');
  c.fillStyle = bowl;
  c.beginPath();
  ragged(c, 0, 0, r * 0.86, 0.05, seed + 9, 24);
  c.fill();
  // the shadow the lip throws into the bowl, soft
  c.save();
  c.beginPath();
  ragged(c, 0, 0, r * 0.86, 0.05, seed + 9, 24);
  c.clip();
  const sh = c.createRadialGradient(lx * r * 0.9, ly * r * 0.9, r * 0.2, lx * r * 0.9, ly * r * 0.9, r * 1.15);
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
    chunk(c, Math.cos(a) * d, Math.sin(a) * d, Math.max(0.35, r * (0.02 + rnd(seed, i + 80) * 0.03)), seed * 5 + i);
    c.fill();
  }
  c.restore();
  c.restore();
}

/** A crater's picture: 0 the scorch, 1 the pit, 2 both together (far out, where a crater is a few px). */
function sprite(layer: 0 | 1 | 2, v: number, b: number, r: number): AtlasEntry | null {
  const id = (b * VARIANTS + v) * 3 + layer;
  const hit = atlas.peek(id);
  if (hit !== undefined) return hit;
  const half = Math.ceil(r * (layer === 1 ? 2.6 : REACH)) + 2;
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

// ------------------------------------------------------------------------------------------------- fires

/** The most fire spots a crater has (an atom bomb's), and what is kept of each spot this frame. */
const MAX_SPOTS = 14;
const SX = new Float64Array(MAX_SPOTS);
const SY = new Float64Array(MAX_SPOTS);
/** size (0..1.2), flame intensity, ember glow, smoke (0..1 each) */
const SB = new Float64Array(MAX_SPOTS);
const SI = new Float64Array(MAX_SPOTS);
const SE = new Float64Array(MAX_SPOTS);
const SS = new Float64Array(MAX_SPOTS);
const ORDER = new Int8Array(MAX_SPOTS);
/** the lights of this frame's spots (and the pit), drawn together */
const LX = new Float64Array(MAX_SPOTS + 1);
const LY = new Float64Array(MAX_SPOTS + 1);
const LR = new Float64Array(MAX_SPOTS + 1);
const LA = new Float64Array(MAX_SPOTS + 1);

/**
 * How big a blast left the crater, from its radius in tiles: 0 a shell (0.5), about 0.2 a bomb (0.9), about 0.45 a
 * missile (2), 0.7 to 1 an atom bomb (4 to 11), on a log scale.
 */
const sizeClass = (rt: number): number => clamp01(Math.log(Math.max(0.5, rt) / 0.5) / Math.log(22));

/**
 * The fires' clock (ms). A crater is given only its age over its life (q), and lives differ: the art lab gives every
 * crater 9 s (at craterLife 1), the game 30 s (a shell's) to 3 minutes (an atom bomb's). The flames run on a clock
 * between the two (16 s a life for a shell's crater up to 40 s for an atom bomb's), so they neither race in the lab
 * nor crawl in the game; a fine shimmer laid over them changes every frame either way.
 */
const fireClock = (q: number, k: number, m: MotionParams): number => q * m.craterLife * (16000 + 24000 * k);

/** Smooth 0..1 (smoothstep). */
const smooth = (t: number): number => {
  const c = clamp01(t);
  return c * c * (3 - 2 * c);
};

/** The longest a fire burns (q): its embers are out by about 1.8 times that, its smoke by 2.5 times. */
const BURN_MAX = 0.34;

/**
 * Fires burning in and round a fresh crater: a few spots of fire (in the pit, on the rim, on clods thrown out), each a
 * glow on the ground, two or three flame tongues licking up and leaning with the wind, embers, and smoke rising off
 * them, dark while they burn hot and grey as they die. They catch at once, burn, shrink and cool to embers, the embers
 * go dull, and a little grey smoke goes on rising from the pit a while after. A shell leaves a small brief fire; a
 * bomb, a missile and an atom bomb more spots, bigger flames and longer fires. MotionParams: fireLinger sets the size
 * and how long they burn (subtle small and short, cinematic big and long), craterSmoke the smoke; reduced motion
 * keeps them still.
 */
export interface CraterFire {
  /** how big a blast left the crater (0 a shell .. 1 an atom bomb) */
  k: number;
  /** when (q) the fires are out; embers glow to about 1.8 times that, smoke rises to 2.5 times that */
  burn: number;
  /** a flame's height (CSS px) */
  flameH: number;
  /** how many spots burn */
  spots: number;
}

/**
 * The fire a crater of radius `radiusPx` at `zoom` gets: more spots, taller flames and a longer burn after a bigger
 * blast; fireLinger makes them smaller and shorter (subtle) or bigger and longer (cinematic).
 */
export function craterFire(radiusPx: number, zoom: number, m: MotionParams): CraterFire {
  const k = sizeClass(radiusPx / Math.max(0.01, zoom));
  const fd = 0.6 + 0.8 * m.fireLinger;
  const fs = 0.65 + 0.5 * m.fireLinger;
  return {
    k,
    // eased toward a third of the life at most, so even a cinematic atom bomb's embers are out before the crater fades
    burn: BURN_MAX * (1 - Math.exp((-(0.15 + 0.35 * k) * fd) / BURN_MAX)),
    // about 0.8 of a tile for a shell's, 1.4 for an atom bomb's, more on a big crater
    flameH: (zoom * (0.8 + 0.6 * k) + radiusPx * 0.16 * k * k) * fs,
    spots: Math.min(MAX_SPOTS, Math.round(1 + 12 * Math.pow(k, 1.15))),
  };
}

function drawFire(ctx: CanvasRenderingContext2D, d: CraterDraw, m: MotionParams, small: boolean): void {
  const q = d.q;
  const { k, burn, flameH: fh, spots: n } = craterFire(d.radiusPx, d.zoom, m);
  // past every ember and every wisp of smoke: nothing to draw
  if (q >= burn * 2.5) return;
  const smokeK = 0.5 + 0.5 * m.craterSmoke;
  const R = d.radiusPx;
  const ign = clamp01(q / 0.008);
  const sd = d.seed * 977 + 13;
  const still = m.reduced;
  const tc = still ? 0 : fireClock(q, k, m) / 1000;
  // the fine shimmer: a new value every frame (q moves every frame), none when still
  const fr = still ? 0 : Math.floor(q * 60000);
  const prevA = ctx.globalAlpha;
  if (small) {
    // far out: a warm glow and a flame when there is room, else a bright point of fire in an orange one (two fills)
    const I = ign * (1 - smooth((q - burn * 0.3) / (burn * 0.7)));
    if (I <= 0.02) return;
    const flick = 1 + (still ? 0 : 0.18 * Math.sin(TAU * (tc * 1.7 + d.seed)) + 0.12 * (rnd(fr, 3) - 0.5));
    if (fh * d.dpr >= 6) {
      fireLight(ctx, d.x, d.y - fh * 0.15, fh * 1.6, 0.8 * I * flick);
      flame(ctx, Flame.TONGUE, I > 0.45, Math.floor(sd), d.x, d.y + fh * 0.1, -Math.PI / 2 + 0.3, fh * I * flick, fh * 0.65 * I, Math.min(1, I * 2));
    } else {
      const p = Math.max(1, Math.round(fh * 0.45 * d.dpr)) / d.dpr;
      ctx.globalAlpha = prevA * Math.min(1, I * 1.2) * 0.55;
      ctx.fillStyle = '#dc7426';
      ctx.fillRect(d.x - p, d.y - p * 1.5, p * 2, p * 2);
      ctx.globalAlpha = prevA * Math.min(1, I * 1.5 * flick);
      ctx.fillStyle = I > 0.5 ? '#ffd98a' : '#f6a53e';
      ctx.fillRect(d.x - p / 2, d.y - p, p, p);
      ctx.globalAlpha = prevA;
    }
    return;
  }
  // the spots: where, how big, how fierce now
  let ic = 0;
  for (let i = 0; i < n; i++) {
    const s = sd + i * 17;
    // the first in the pit, then about a third in the pit, a third on the rim, a third on clods thrown out
    const zone = i === 0 ? 0 : rnd(s, 1);
    const a = rnd(s, 2) * TAU;
    const dist = zone < 0.3 ? 0.12 + 0.45 * rnd(s, 3) : zone < 0.68 ? 0.82 + 0.3 * rnd(s, 3) : 1.25 + 0.55 * rnd(s, 3);
    SX[i] = d.x + Math.cos(a) * dist * R;
    SY[i] = d.y + Math.sin(a) * dist * R * 0.9;
    SB[i] = (zone < 0.3 ? 1 : zone < 0.68 ? 0.85 : 0.6) * (0.6 + 0.65 * rnd(s, 4));
    // each catches a moment apart and burns out at its own time (thrown-out clods first)
    const q0 = rnd(s, 5) * 0.01;
    const qEnd = burn * (zone < 0.68 ? 0.6 + 0.4 * rnd(s, 6) : 0.35 + 0.3 * rnd(s, 6));
    const on = clamp01((q - q0) / 0.008);
    SI[i] = on * (1 - smooth((q - qEnd * 0.4) / (qEnd * 0.6)));
    SE[i] = on * (1 - smooth((q - qEnd * 0.7) / (qEnd * 1.1)));
    // smoke goes on longest, from the pit longest of all
    SS[i] = on * (1 - smooth((q - qEnd * 0.3) / (qEnd * (i === 0 ? 2.2 : 1.6))));
    ic = Math.max(ic, SE[i]);
    // flames drawn top to bottom, so a nearer one stands in front
    let j = i;
    while (j > 0 && SY[ORDER[j - 1]] > SY[i]) {
      ORDER[j] = ORDER[j - 1];
      j--;
    }
    ORDER[j] = i;
  }
  // the light of the fires on the ground round them; after a bomb or bigger, the whole bowl lit red by its embers
  let nl = 0;
  if (k > 0.12 && ic > 0.02) {
    LX[nl] = d.x;
    LY[nl] = d.y;
    LR[nl] = R * (0.8 + 0.3 * k);
    LA[nl++] = (0.3 + 0.12 * k) * ic * ign;
  }
  for (let i = 0; i < n; i++) {
    const I = SI[i];
    const E = SE[i];
    if (I <= 0.01 && E <= 0.01) continue;
    const flick = 1 + (still ? 0 : 0.2 * Math.sin(TAU * (tc * 1.3 + i * 0.37)) + 0.1 * (rnd(fr, i) - 0.5));
    LX[nl] = SX[i];
    LY[nl] = SY[i] - fh * 0.2;
    LR[nl] = fh * 1.5 * SB[i];
    LA[nl++] = (0.6 * I + 0.25 * E) * flick;
  }
  fireLights(ctx, nl, LX, LY, LR, LA);
  // embers: specks glowing in the ashes, twinkling, dull red as they die
  const ep = Math.max(1, Math.round(Math.max(0.6, fh * 0.11) * d.dpr)) / d.dpr;
  for (let i = 0; i < n; i++) {
    const E = SE[i];
    if (E <= 0.02) continue;
    const s = sd + i * 17;
    for (let e = i === 0 ? 3 : 2; e > 0; e--) {
      const tw = still ? 0.7 : 0.45 + 0.55 * rnd(Math.floor(tc * 6 + e * 0.3), s + e);
      ctx.globalAlpha = prevA * E * tw;
      ctx.fillStyle = E > 0.6 && e % 2 === 0 ? '#ffb46b' : E > 0.3 ? '#dc7426' : '#9c3a16';
      const ea = rnd(s, e + 20) * TAU;
      const er = fh * 0.55 * SB[i] * Math.sqrt(rnd(s, e + 24));
      ctx.fillRect(SX[i] + Math.cos(ea) * er - ep / 2, SY[i] + Math.sin(ea) * er * 0.8 - ep / 2, ep, ep);
    }
  }
  ctx.globalAlpha = prevA;
  // the flames: two or three tongues a spot grown together into one fire, leaning with the wind, licking up and down
  for (let o = 0; o < n; o++) {
    const i = ORDER[o];
    const I = SI[i];
    if (I <= 0.01) continue;
    const s = sd + i * 17;
    const big = SB[i];
    const nt = fh * big * d.dpr > 9 ? 3 : 2;
    const hotA = clamp01((I - 0.35) / 0.45);
    const grow = Math.pow(I, 0.6);
    // the bed of the fire, a hot glow the tongues rise out of (close up, where it shows)
    if (fh * big * d.dpr > 10) puff(ctx, Puff.FIRE, i, SX[i], SY[i] + fh * 0.05 * big, fh * 0.32 * big * grow, 0.75 * Math.min(1, I * 2));
    for (let t = nt - 1; t >= 0; t--) {
      const ph = rnd(s, t + 30);
      const f1 = 1.1 + 0.6 * rnd(s, t + 33);
      const flick = still ? 1 : 1 + 0.17 * Math.sin(TAU * (tc * f1 + ph)) + 0.09 * Math.sin(TAU * (tc * f1 * 2.3 + ph * 3)) + 0.1 * (rnd(fr, i * 3 + t) - 0.5);
      const h = fh * big * (t === 0 ? 1 : t === 1 ? 0.7 : 0.6) * grow * flick;
      const w = fh * big * (t === 0 ? 0.68 : 0.58) * grow;
      const side = t === 0 ? 0 : t === 1 ? -1 : 1;
      const ox = side * 0.2 * fh * big;
      const lean = -Math.PI / 2 + 0.18 + 0.2 * rnd(s, 36) + (still ? 0 : 0.09 * Math.sin(TAU * (tc * 0.6 + ph))) + side * 0.16;
      const v = Math.floor(s) + t;
      const x = SX[i] + ox;
      const y = SY[i] + fh * (0.12 + 0.06 * Math.abs(side)) * big;
      // white hot while it burns fiercely, then the dying picture (one picture each, the flicker hides the change)
      flame(ctx, Flame.TONGUE, hotA > 0.5, v, x, y, lean, h, w, Math.min(1, I * 2.5));
    }
  }
  // smoke off the fires: a column of puffs, dark while they burn hot, grey as they die, rising, swelling and drifting
  // off with the wind
  if (smokeK > 0) {
    for (let i = 0; i < n; i++) {
      const S = SS[i] * smokeK;
      if (S <= 0.02) continue;
      const s = sd + i * 17;
      const big = SB[i];
      const np = fh * d.dpr > 8 && SI[i] > 0.05 ? 2 : 1;
      for (let j = 0; j < np; j++) {
        const ph = still ? (j / np + rnd(s, 40)) % 1 : (tc / 2.6 + j / np + rnd(s, 40)) % 1;
        const rise = fh * big * (0.7 + 3.6 * ph);
        const drift = fh * 2.8 * ph * ph;
        const r = fh * (0.55 + 1.6 * ph) * (0.75 + 0.45 * big);
        const kind = SI[i] > 0.3 && ph < 0.3 ? Puff.DARK : Puff.GREY;
        puff(ctx, kind, i * 3 + j, SX[i] + WIND_X * drift, SY[i] - rise + WIND_Y * drift, r, 0.85 * S * ramp(ph, 0, 0.12) * Math.pow(1 - ph, 1.2));
      }
    }
  }
  ctx.globalAlpha = prevA;
}

function draw(ctx: CanvasRenderingContext2D, d: CraterDraw, m: MotionParams): void {
  const q = d.q;
  if (q < 0 || q >= 1 || d.radiusPx <= 0.3) return;
  // (the shape from a hash of the seed, so craters laid together with close seeds still differ; a little bigger or
  // smaller each)
  const v = Math.floor(rnd(d.seed * 997, 3) * VARIANTS) % VARIANTS;
  const dpr = Math.max(1, d.dpr);
  const { b, r } = bucketR(d.radiusPx * dpr);
  const k = (d.radiusPx / r) * (0.82 + 0.36 * rnd(d.seed * 997, 4));
  const prevA = ctx.globalAlpha;
  const prevS = ctx.imageSmoothingEnabled;
  ctx.imageSmoothingEnabled = true;
  // the soot washes out first, the hole and its rim last
  const a0 = 1 - ramp(q, 0.3, 0.85);
  const a1 = 1 - ramp(q, 0.55, 1);
  const small = d.radiusPx * dpr < SMALL_R;
  if (small) {
    // far out: soot and pit as one picture, fading between the two
    const both = sprite(2, v, b, r);
    if (both) {
      ctx.globalAlpha = prevA * (a0 + a1) * 0.5;
      blit(ctx, both, d.x, d.y, k);
    }
  } else {
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
  }
  ctx.globalAlpha = prevA;
  drawFire(ctx, d, m, small);
  ctx.globalAlpha = prevA;
  ctx.imageSmoothingEnabled = prevS;
}

export const realisticCraters: CraterArt = { draw };
