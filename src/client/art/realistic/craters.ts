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
// A fresh crater burns (drawFire): a few patches of fire bunched on the rim and the pit floor, each a knot of flames of
// uneven height licking up and leaning with the wind over one low warm light, embers and smoke, dying down over the
// first part of its life (more, longer and bigger after a bigger blast), then a little grey smoke from the pit before
// only the scorched crater is left to fade. The bowl is charcoal brown with a crisp torn lip, so it sits well next to
// pixel art drawn on top of it.
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
  // its outline torn (never a round disc), its edge a little soft
  const soft0 = 'filter' in c;
  if (soft0) c.filter = `blur(${Math.max(0.6, r * 0.1).toFixed(2)}px)`;
  c.fillStyle = g;
  c.beginPath();
  ragged(c, 0, 0, r * 1.85, 0.25, seed, 28);
  c.fill();
  if (soft0) c.filter = 'none';
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
    chunk(c, Math.cos(a) * d, Math.sin(a) * d * 0.9, Math.max(0.6, r * 0.05 * (0.5 + rnd(seed, i + 260))), seed * 11 + i);
    c.fill();
  }
}

/** An angular chunk of earth: a polygon of 3 to 5 corners round (x, y), about s across. */
function chunk(c: CanvasRenderingContext2D, x: number, y: number, s: number, seed: number): void {
  const n = 3 + Math.floor(rnd(seed, 1) * 3);
  const rot = rnd(seed, 2) * TAU;
  c.beginPath();
  for (let j = 0; j < n; j++) {
    const a = rot + (j / n) * TAU + (rnd(seed, j + 10) - 0.5) * 0.8;
    const rr = s * (0.6 + rnd(seed, j + 20) * 0.6) * (j === 0 ? 1.25 : 1);
    if (j === 0) c.moveTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr * 0.85);
    else c.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr * 0.85);
  }
  c.closePath();
}

const CLODS = ['#6b5b47', '#3e3227', '#54463a', '#30271f', '#5f503e', '#261f19'];

/**
 * A clod of earth thrown out: an angular chunk with its shadow on the lower right, its top-left face catching the
 * light (a lighter wedge from its middle to the corners facing the light), so it reads as a lump, never a dot.
 */
function clod(c: CanvasRenderingContext2D, x: number, y: number, s: number, seed: number, tone: string): void {
  c.fillStyle = 'rgba(10,8,6,0.32)';
  chunk(c, x - LIGHT_X * s * 0.5, y - LIGHT_Y * s * 0.5, s, seed);
  c.fill();
  c.fillStyle = tone;
  chunk(c, x, y, s, seed);
  c.fill();
  if (s < 0.9) return;
  // the lit face: the chunk shrunk toward its top-left corner, lighter
  c.fillStyle = 'rgba(176,156,124,0.45)';
  chunk(c, x + LIGHT_X * s * 0.28, y + LIGHT_Y * s * 0.28, s * 0.55, seed);
  c.fill();
}

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
    const sz = Math.max(0.8, r * (0.03 + Math.pow(rnd(seed, i + 40), 2) * 0.09) * (1.6 - (d / r - 1.1)));
    clod(c, Math.cos(a) * d, Math.sin(a) * d * 0.9, sz, seed * 7 + i, CLODS[Math.floor(rnd(seed, i + 60) * CLODS.length)]);
  }
  // (barely out of round: at most 1.2 times longer than wide, never an egg or a bean)
  const ex = 1 + rnd(seed, 901) * 0.1;
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
  ring.addColorStop(0, 'rgba(86,72,56,0.7)');
  ring.addColorStop(0.35, 'rgba(82,69,54,0.62)');
  ring.addColorStop(0.7, 'rgba(76,64,50,0.3)');
  ring.addColorStop(1, 'rgba(72,60,47,0)');
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
    const col = `${Math.round(Math.min(255, 84 * tone))},${Math.round(Math.min(255, 71 * tone))},${Math.round(Math.min(255, 55 * tone))}`;
    g.addColorStop(0, `rgba(${col},0.72)`);
    g.addColorStop(0.6, `rgba(${col},0.4)`);
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
  lit.addColorStop(0, 'rgba(176,160,132,0.38)');
  lit.addColorStop(0.45, 'rgba(176,160,132,0)');
  lit.addColorStop(0.6, 'rgba(20,14,10,0)');
  lit.addColorStop(1, 'rgba(20,14,10,0.5)');
  c.fillStyle = lit;
  c.fillRect(-r * 2.2, -r * 2.2, r * 4.4, r * 4.4);
  for (let i = 0; i < 40; i++) {
    const a = rnd(seed, i + 300) * TAU;
    const d = r * (0.85 + rnd(seed, i + 320) * 0.4);
    c.fillStyle = i % 2 ? 'rgba(30,22,16,0.35)' : 'rgba(150,132,106,0.22)';
    chunk(c, Math.cos(a) * d, Math.sin(a) * d * 0.9, Math.max(0.4, r * (0.02 + rnd(seed, i + 340) * 0.03)), seed * 3 + i);
    c.fill();
  }
  c.restore();
  // the bowl, charcoal brown: shade on the upper left inner wall, light on the lower right; its edge torn (a ragged
  // line, never a clean ellipse), with dark notches bitten into the shaded lip
  const bowl = c.createRadialGradient(-lx * r * 0.32, -ly * r * 0.32, r * 0.05, 0, 0, r * 0.9);
  bowl.addColorStop(0, '#4a3d30');
  bowl.addColorStop(0.55, '#2a211a');
  bowl.addColorStop(1, '#17120e');
  const edge = (): void => {
    c.beginPath();
    ragged(c, 0, 0, r * 0.84, 0.14, seed + 9, 34);
  };
  c.fillStyle = bowl;
  edge();
  c.fill();
  const la = Math.atan2(ly, lx);
  const notches = 3 + Math.floor(rnd(seed, 950) * 3);
  c.fillStyle = '#17120e';
  for (let i = 0; i < notches; i++) {
    // blunt bites of the dark pit into the lip (a chunk of the rim fallen in), never thorns sticking out
    const a = la + (rnd(seed, i + 951) - 0.5) * 2.2;
    const o = r * (0.74 + 0.06 * rnd(seed, i + 970));
    chunk(c, Math.cos(a) * o, Math.sin(a) * o, r * (0.08 + 0.05 * rnd(seed, i + 960)), seed * 13 + i);
    c.fill();
  }
  // the shadow the lip throws into the bowl, soft
  c.save();
  edge();
  c.clip();
  const sh = c.createRadialGradient(lx * r * 0.9, ly * r * 0.9, r * 0.2, lx * r * 0.9, ly * r * 0.9, r * 1.15);
  sh.addColorStop(0, 'rgba(6,4,3,0.55)');
  sh.addColorStop(0.7, 'rgba(6,4,3,0.3)');
  sh.addColorStop(1, 'rgba(6,4,3,0)');
  c.fillStyle = sh;
  c.fillRect(-r, -r, r * 2, r * 2);
  // a crisp 1 px edge just inside the lip: dark on the shaded upper left, lit on the lower right inner wall (the
  // line is drawn 2 px wide on the edge, the clip keeps its inner pixel)
  const lip = c.createLinearGradient(lx * r * 0.85, ly * r * 0.85, -lx * r * 0.85, -ly * r * 0.85);
  lip.addColorStop(0, 'rgba(10,7,5,0.95)');
  lip.addColorStop(0.42, 'rgba(10,7,5,0)');
  lip.addColorStop(0.6, 'rgba(140,118,90,0)');
  lip.addColorStop(1, 'rgba(140,118,90,0.85)');
  c.strokeStyle = lip;
  c.lineWidth = 2;
  edge();
  c.stroke();
  // loose earth in the bottom
  for (let i = 0; i < 14; i++) {
    const a = rnd(seed, i + 60) * TAU;
    const d = r * 0.6 * Math.sqrt(rnd(seed, i + 70));
    c.fillStyle = i % 2 ? 'rgba(14,10,8,0.45)' : 'rgba(96,82,64,0.3)';
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

/** The most fire patches a crater has (an atom bomb's), and what is kept of each patch this frame. */
const MAX_CL = 5;
/** centre of the patch, the way along the rim it lies (radians), how wide it is spread (px) */
const SX = new Float64Array(MAX_CL);
const SY = new Float64Array(MAX_CL);
const SA = new Float64Array(MAX_CL);
const SW = new Float64Array(MAX_CL);
/** size (0..1.2), flame intensity, ember glow, smoke (0..1 each) */
const SB = new Float64Array(MAX_CL);
const SI = new Float64Array(MAX_CL);
const SE = new Float64Array(MAX_CL);
const SS = new Float64Array(MAX_CL);
/** how many tongues of flame the patch has (one tall and two to four short ones) */
const SN = new Int8Array(MAX_CL);
const ORDER = new Int8Array(MAX_CL);
/** the lights of this frame's patches (and the pit), drawn together */
const LX = new Float64Array(MAX_CL + 1);
const LY = new Float64Array(MAX_CL + 1);
const LR = new Float64Array(MAX_CL + 1);
const LA = new Float64Array(MAX_CL + 1);
/** A fire's light lies low on the ground: this many times wider than it is deep. */
const LIGHT_FLAT = 1.6;

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
 * Fires burning in and round a fresh crater: a few patches of fire, each a knot of flames grown together (one tall
 * tongue and two to four short ones of clearly uneven height) on an arc of the rim or the pit floor, bunched on the
 * downwind and lower side and never evenly spaced, each with one low warm light lying on the ground under it, embers,
 * and smoke rising off it, dark while it burns hot and grey as it dies. They catch at once, burn, shrink and cool to
 * embers (specks with no glow round them), the embers go dull, and a little grey smoke goes on rising from the pit a
 * while after. A shell leaves one small brief patch; a bomb two, a missile three and an atom bomb four or five,
 * bigger and longer. MotionParams: fireLinger sets the size and how long they burn (subtle small and short, cinematic
 * big and long), craterSmoke the smoke; reduced motion keeps them still.
 */
export interface CraterFire {
  /** how big a blast left the crater (0 a shell .. 1 an atom bomb) */
  k: number;
  /** when (q) the fires are out; embers glow to about 1.8 times that, smoke rises to 2.5 times that */
  burn: number;
  /** the tallest flame's height (CSS px) */
  flameH: number;
  /** how many patches of fire burn */
  clusters: number;
}

/**
 * The fire a crater of radius `radiusPx` at `zoom` gets: more patches, taller flames (with the crater's size too) and
 * a longer burn after a bigger blast; fireLinger makes them smaller and shorter (subtle) or bigger and longer
 * (cinematic).
 */
export function craterFire(radiusPx: number, zoom: number, m: MotionParams): CraterFire {
  const k = sizeClass(radiusPx / Math.max(0.01, zoom));
  const fd = 0.6 + 0.8 * m.fireLinger;
  const fs = 0.65 + 0.5 * m.fireLinger;
  return {
    k,
    // a shell's brief (about 0.06 of the life), an atom bomb's long (about a third at most), so even a cinematic atom
    // bomb's embers are out before the crater fades
    burn: BURN_MAX * (1 - Math.exp((-(0.08 + 0.6 * k) * fd) / BURN_MAX)),
    // about 0.8 of a tile for a shell's, 1.4 for an atom bomb's, and a share of the crater's own size
    flameH: (zoom * (0.8 + 0.6 * k) + radiusPx * (0.1 + 0.25 * k)) * fs,
    clusters: k < 0.1 ? 1 : k < 0.32 ? 2 : k < 0.6 ? 3 : k < 0.85 ? 4 : 5,
  };
}

function drawFire(ctx: CanvasRenderingContext2D, d: CraterDraw, m: MotionParams, small: boolean): void {
  const q = d.q;
  const { k, burn, flameH: fh, clusters: n } = craterFire(d.radiusPx, d.zoom, m);
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
      fireLight(ctx, d.x, d.y - fh * 0.15, fh * 1.6, 0.6 * I * flick);
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
  // the patches: where (an arc of the rim or the pit floor, bunched on the downwind and lower side, unevenly apart),
  // how big, how fierce now
  const a0 = 0.45 + (rnd(sd, 1) - 0.5) * 1.4;
  let aL = a0;
  let aR = a0;
  let maxI = 0;
  for (let i = 0; i < n; i++) {
    const s = sd + i * 17;
    let a = a0;
    if (i > 0) {
      // the next patch along the arc to one side or the other, an uneven step away
      const step = 0.5 + 0.85 * rnd(s, 2);
      if (rnd(s, 7) < 0.5 === (i % 2 === 0)) a = aL -= step;
      else a = aR += step;
    }
    // the first in the pit floor (a shell's is all in its hole); the others on the rim or the floor
    const rim = i > 0 && rnd(s, 1) < 0.6;
    const dist = n === 1 ? 0.12 + 0.3 * rnd(s, 3) : rim ? 0.78 + 0.2 * rnd(s, 3) : 0.22 + 0.33 * rnd(s, 3);
    SX[i] = d.x + Math.cos(a) * dist * R;
    SY[i] = d.y + Math.sin(a) * dist * R * 0.9;
    SA[i] = a;
    SB[i] = (rim ? 0.85 : 1) * (0.75 + 0.45 * rnd(s, 4)) * (i === 0 ? 1.1 : 1);
    SW[i] = Math.max(R * 0.15, fh * 0.28);
    SN[i] = 3 + Math.floor(rnd(s, 8) * (n === 1 ? 1.99 : 2.99));
    // each catches a moment apart and burns out at its own time (the first, in the pit, last)
    const q0 = rnd(s, 5) * 0.01;
    const qEnd = burn * (i === 0 ? 0.8 + 0.2 * rnd(s, 6) : 0.5 + 0.45 * rnd(s, 6));
    const on = clamp01((q - q0) / 0.008);
    SI[i] = on * (1 - smooth((q - qEnd * 0.4) / (qEnd * 0.6)));
    SE[i] = on * (1 - smooth((q - qEnd * 0.7) / (qEnd * 1.1)));
    // smoke goes on longest, from the pit longest of all
    SS[i] = on * (1 - smooth((q - qEnd * 0.3) / (qEnd * (i === 0 ? 2.2 : 1.6))));
    maxI = Math.max(maxI, SI[i]);
    // patches drawn top to bottom, so a nearer one stands in front
    let j = i;
    while (j > 0 && SY[ORDER[j - 1]] > SY[i]) {
      ORDER[j] = ORDER[j - 1];
      j--;
    }
    ORDER[j] = i;
  }
  // the light of the flames on the ground under them, low and flat (one a patch); after a bomb or bigger the bowl lit
  // red while the flames burn (none once only embers are left)
  let nl = 0;
  if (k > 0.12 && maxI > 0.02) {
    LX[nl] = d.x;
    LY[nl] = d.y;
    LR[nl] = R * (0.7 + 0.2 * k);
    LA[nl++] = (0.2 + 0.1 * k) * maxI * ign;
  }
  for (let i = 0; i < n; i++) {
    const I = SI[i];
    if (I <= 0.01) continue;
    const flick = 1 + (still ? 0 : 0.15 * Math.sin(TAU * (tc * 1.3 + i * 0.37)) + 0.08 * (rnd(fr, i) - 0.5));
    LX[nl] = SX[i];
    LY[nl] = SY[i] - fh * 0.1;
    LR[nl] = fh * 1.2 * SB[i] + SW[i];
    LA[nl++] = Math.min(0.45, 0.42 * I * flick);
  }
  fireLights(ctx, nl, LX, LY, LR, LA, LIGHT_FLAT);
  // embers: specks of 1 or 2 px in the ashes of each patch, twinkling, dull red as they die, each with a faint 3 px
  // halo (drawn first, all together), and a speck or two out on the clods thrown out after a bomb or bigger
  const px = 1 / d.dpr;
  const clods = k > 0.15 ? (k > 0.5 ? 2 : 1) : 0;
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 0; i < n + clods; i++) {
      const out = i >= n;
      const E = out ? SE[0] * 0.8 * (1 - smooth(q / (burn * 0.9))) : SE[i];
      if (E <= 0.02) continue;
      const s = sd + i * 17;
      const ne = out ? 1 : i === 0 ? 4 : 3;
      for (let e = ne; e > 0; e--) {
        const tw = still ? 0.7 : 0.45 + 0.55 * rnd(Math.floor(tc * 6 + e * 0.3), s + e);
        const ea = rnd(s, e + 20) * TAU;
        let ex: number;
        let ey: number;
        if (out) {
          const od = R * (1.25 + 0.55 * rnd(s, e + 26));
          ex = d.x + Math.cos(ea) * od;
          ey = d.y + Math.sin(ea) * od * 0.9;
        } else {
          const er = (SW[i] + fh * 0.3 * SB[i]) * Math.sqrt(rnd(s, e + 24));
          ex = SX[i] + Math.cos(ea) * er;
          ey = SY[i] + Math.sin(ea) * er * 0.6;
        }
        if (pass === 0) {
          ctx.globalAlpha = prevA * Math.min(0.25, 0.32 * E * tw);
          ctx.fillStyle = '#7a2c14';
          ctx.fillRect(Math.round(ex * d.dpr - 1.5) / d.dpr, Math.round(ey * d.dpr - 1.5) / d.dpr, 3 * px, 3 * px);
        } else {
          const ep = (E > 0.55 && e % 2 === 0 ? 2 : 1) * px;
          ctx.globalAlpha = prevA * E * tw;
          ctx.fillStyle = E > 0.6 && e % 2 === 0 ? '#ffb46b' : E > 0.3 ? '#dc7426' : '#9c3a16';
          ctx.fillRect(Math.round(ex * d.dpr - ep * d.dpr * 0.5) / d.dpr, Math.round(ey * d.dpr - ep * d.dpr * 0.5) / d.dpr, ep, ep);
        }
      }
    }
  }
  ctx.globalAlpha = prevA;
  // the flames: each patch a knot of tongues grown together, one tall and the others short and each its own height,
  // leaning downwind together, licking up and down
  for (let o = 0; o < n; o++) {
    const i = ORDER[o];
    const I = SI[i];
    if (I <= 0.01) continue;
    const s = sd + i * 17;
    const big = SB[i];
    const hotA = clamp01((I - 0.35) / 0.45);
    const grow = Math.pow(I, 0.6);
    const ta = SA[i] + Math.PI / 2;
    const tx = Math.cos(ta);
    const ty = Math.sin(ta) * 0.9;
    // the bed of the fire: low, wide, dying flames along the patch the tongues rise out of, so the knot reads as one
    // ragged burning patch (close up, where it shows)
    if (fh * big * d.dpr > 8) {
      for (let b = 0; b < 2; b++) {
        const along = (b === 0 ? -0.45 : 0.4) * SW[i] * (0.8 + 0.4 * rnd(s, b + 60));
        flame(ctx, Flame.TONGUE, false, Math.floor(s) + 5 + b, SX[i] + tx * along, SY[i] + ty * along + fh * 0.1 * big, -Math.PI / 2 + 0.25, fh * big * (0.3 + 0.12 * rnd(s, b + 62)) * grow, (SW[i] * 1.3 + fh * 0.35 * big) * grow, Math.min(1, I * 2));
      }
    }
    const nt = fh * big * d.dpr > 7 ? SN[i] : 2;
    // where the tall one stands in the knot
    const tallAt = rnd(s, 50) - 0.5;
    for (let t = 0; t < nt; t++) {
      const ph = rnd(s, t + 30);
      const f1 = 1.1 + 0.6 * rnd(s, t + 33);
      const flick = still ? 1 : 1 + 0.17 * Math.sin(TAU * (tc * f1 + ph)) + 0.09 * Math.sin(TAU * (tc * f1 * 2.3 + ph * 3)) + 0.1 * (rnd(fr, i * 5 + t) - 0.5);
      // the short ones: clearly uneven, from a quarter to 0.7 of the tall one, dying back a little sooner
      const frac = t === 0 ? 1 : (t - 1 + 0.25 + 0.5 * rnd(s, t + 43)) / Math.max(1, nt - 1);
      const hk = t === 0 ? 0.92 + 0.16 * rnd(s, 43) : 0.25 + 0.45 * frac;
      const It = t === 0 ? grow : Math.pow(clamp01(I * 1.2 - 0.2 * rnd(s, t + 52)), 0.6);
      if (It <= 0.02) continue;
      const h = fh * big * hk * It * flick;
      const w = fh * big * (t === 0 ? 0.7 : 0.3 + 0.5 * hk) * It;
      // spread along the arc of the patch (within about 0.15 of the crater's radius), a little in and out
      const along = (t === 0 ? tallAt : rnd(s, t + 40) - 0.5) * 2 * SW[i];
      const across = (rnd(s, t + 41) - 0.5) * SW[i] * 0.5;
      const lean = -Math.PI / 2 + 0.2 + 0.16 * rnd(s, t + 46) + (still ? 0 : 0.09 * Math.sin(TAU * (tc * 0.6 + ph)));
      const v = Math.floor(s) + t;
      const x = SX[i] + tx * along + ty * across * 0.3;
      const y = SY[i] + ty * along + across * 0.4 + fh * 0.08 * big;
      // white hot while it burns fiercely, then the dying picture (one picture each, the flicker hides the change)
      flame(ctx, Flame.TONGUE, hotA > 0.5 && t < 2, v, x, y, lean, h, w, Math.min(1, I * 2.5));
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
        const r = (fh * (0.55 + 1.6 * ph) + SW[i] * 0.6) * (0.75 + 0.45 * big);
        // (dark smoke thinner and softer than grey, so a young puff over the fire never reads as a lump)
        const dark = SI[i] > 0.3 && ph < 0.3;
        puff(ctx, dark ? Puff.DARK : Puff.GREY, i * 3 + j, SX[i] + WIND_X * drift, SY[i] - rise + WIND_Y * drift, r * (dark ? 1.15 : 1), (dark ? 0.6 : 0.8) * S * ramp(ph, 0, 0.12) * Math.pow(1 - ph, 1.2));
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
