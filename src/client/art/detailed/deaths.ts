// The detailed style's deaths (client only): a unit destroyed, played where it was (fx/pixelFx.ts finds them). Built
// from the style's own wrecks (wrecks.ts: the unit's model baked rolled, smaller, burnt or going under), its puffs and
// flames (blobs.ts, burning.ts) and its blasts (explosions.ts), so a death speaks the same muted pixel language as the
// rest; every length of time comes from the MotionParams (blastTime, smokeLinger, fireLinger, debris, flashSize):
//   plane    hit (a flash and a black burst where it was), it catches fire at an engine and trails black smoke as it
//            falls: it turns and rolls over (a fighter spins hard, a bomber or a cargo plane turns slowly and dives),
//            corkscrews a little and gets smaller as it falls away from the viewer, its shadow closing in under it.
//            Then it hits the ground a little way on: a flash and a fireball, burning pieces thrown out on arcs, its
//            burnt-out wreck burning on the ground (the map leaves a crater there) under a column of smoke; or the sea:
//            the same fire, a big splash, an oil slick, floating pieces and bubbles.
//   missile  shot down in the air: a flash, a fireball and a cloud of black smoke left hanging where it burst, its pieces
//            thrown out burning and falling, trailing smoke, each landing as a small blast on land or a splash on the
//            sea, the biggest last. An atom bomb only bursts bigger, with more pieces: never like its detonation.
//   tank     a blast and a fireball, the turret thrown off tumbling (its shadow under it) and landing beside the hull,
//            the hull a burning wreck (a fire roaring from the turret ring, fires on the engine deck) under black
//            smoke, burning black in patches, then a charred hull with a few embers on a scorched patch that fades.
//   ship     hit (one blast, more on a big ship), it lists to one side and burns on deck under a heavy black column,
//            goes under from one end (the sea climbing the hull, foam at the waterline, fires going out in a puff of
//            steam), leaving an oil slick, churned foam, bubbles and floating wreckage that fade.
// Close up the whole sequence; at mid zoom fewer puffs and pieces; zoomed out (the map draws unit markers, zoom under
// 3) only the blasts, fire and smoke; farther out the map's far blink. Reduced motion: still frames.
import type { MotionParams } from '../motion';
import { rnd } from '../shared/noise';
import type { SpriteKey } from '../shared/keys';
import { DEATH_GLIDE_TILES, type DeathDraw, type DeathKind, type DeathTimes, type ExplosionArt } from '../types';
import { FORE, LIFT, project } from './bake';
import { drawBlob, type BlobKind } from './blobs';
import { drawFlame, drawSmokeTrail, RISE, WIND_X, WIND_Y, type SmokeSource } from './burning';
import { hitSpot } from './damage';
import { blastAt, detailedExplosions, flashCore, flashGlow, speck } from './explosions';
import { facingIndex, facingsFor, gridOf, type Grid } from './grid';
import { modelLength, modelSpan, MOD_MASK, unitModel, type UnitModel } from './models';
import { DEBRIS, FIRE, MATERIALS, SPRAY, TRACER } from './palette';
import { CHAR_STEPS, drawWreck, SINK_STEPS, sinkReach, WRECK_ROLLS, type WreckPose } from './wrecks';

const TAU = Math.PI * 2;
const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
const easeOut = (t: number): number => 1 - (1 - t) * (1 - t);
const easeOut3 = (t: number): number => 1 - (1 - t) ** 3;
const smooth = (t: number): number => t * t * (3 - 2 * t);
/** How long smoke stays: the motion's smokeLinger, kept in a sane range. */
const lingerOf = (m: MotionParams): number => Math.max(0.6, Math.min(2.2, m.smokeLinger));

// ------------------------------------------------------------------------------------------------- times

/** The phases of each death (ms), from the motion. */
const planeFall = (m: MotionParams): number => 1500 * m.blastTime;
const missileImpact = (m: MotionParams): number => 40 + 1160 * m.blastTime;
const TANK_FADE = 1100;
const tankBlast = (m: MotionParams): number => 500 * m.blastTime;
const tankBurn = (m: MotionParams): number => 3400 * lingerOf(m);
const shipHit = (m: MotionParams): number => 500 * m.blastTime;
const shipList = (m: MotionParams): number => 1000 * m.blastTime;
const shipSink = (m: MotionParams): number => 2600 * m.blastTime;

const times: DeathTimes = { durMs: 1, impactMs: 0 };

/** How long a death takes and when it is down (pure; the returned object is reused). */
export function deathTimesOf(kind: DeathKind, m: MotionParams): DeathTimes {
  const bt = m.blastTime;
  const sl = lingerOf(m);
  switch (kind) {
    case 'plane':
      times.impactMs = planeFall(m);
      times.durMs = times.impactMs + 700 * bt + 2600 * sl;
      break;
    case 'missile':
      times.impactMs = missileImpact(m);
      times.durMs = times.impactMs + 500 * bt + 1500 * sl;
      break;
    case 'tank':
      times.impactMs = 0;
      times.durMs = tankBlast(m) + tankBurn(m) + TANK_FADE;
      break;
    case 'ship':
      times.impactMs = shipHit(m) + shipList(m) + shipSink(m);
      times.durMs = times.impactMs + 3000 * sl;
      break;
  }
  return times;
}

// ------------------------------------------------------------------------------------------------- shared parts

const lengths = new WeakMap<UnitModel, number>();
const spans = new WeakMap<UnitModel, number>();
function lengthOf(um: UnitModel): number {
  let v = lengths.get(um);
  if (v === undefined) lengths.set(um, (v = modelLength(um)));
  return v;
}
function spanOf(um: UnitModel): number {
  let v = spans.get(um);
  if (v === undefined) spans.set(um, (v = modelSpan(um)));
  return v;
}

/** The pose the wrecks are drawn with (reused). */
const pose: WreckPose = { key: 'bomber', mods: 0, owner: [128, 128, 128], angle: 0, res: 1, roll: 0, char: 0, sink: 0, sinkDir: -1, layer: 'body' };
function setPose(d: DeathDraw, layer: WreckPose['layer'], angle: number, res: number, roll = 0, char = 0, sink = 0, sinkDir = -1): WreckPose {
  pose.key = d.key;
  pose.mods = d.mods;
  pose.owner = d.owner;
  pose.layer = layer;
  pose.angle = angle;
  pose.res = res;
  pose.roll = roll;
  pose.char = char;
  pose.sink = sink;
  pose.sinkDir = sinkDir;
  return pose;
}

/**
 * A fireball `age` ms into its `fT` ms life: `n` fire puffs that swell fast, rise a little and cool from white hot to
 * deep red as they shrink, the hottest drawn last. R in model units.
 */
function fireball(ctx: CanvasRenderingContext2D, x: number, y: number, R: number, age: number, fT: number, g: Grid, u: number, sd: number, n: number): void {
  if (age < 0 || age >= fT) return;
  const fq = age / fT;
  const Rc = R * g.res;
  for (let i = n - 1; i >= 0; i--) {
    const ang = rnd(sd, i + 20) * TAU;
    const dd = i === 0 ? 0 : R * 0.5 * rnd(sd, i + 30);
    const grow = easeOut3(clamp01(fq * 3.5));
    const shrink = 1 - 0.55 * clamp01((fq - 0.4) / 0.6);
    const r = Rc * (i === 0 ? 0.8 : 0.5 + 0.3 * rnd(sd, i + 35)) * grow * shrink;
    const px = x + Math.cos(ang) * dd * u;
    const py = y + Math.sin(ang) * dd * u * 0.7 - R * 0.9 * fq * u;
    drawBlob(ctx, 'fire', Math.max(1, r), i + 3, px, py, g, 1, Math.min(4, fq * 5 + (i === 0 ? 0 : 0.6)));
  }
}

/**
 * Smoke boiling up out of a fire and hanging: `n` puffs born over its first moments, swelling, rising and drifting
 * downwind, oily black at first, then a dark grey, then grey, fading by `end` ms. R in model units.
 */
function smokeCloud(ctx: CanvasRenderingContext2D, x: number, y: number, R: number, age: number, born0: number, born1: number, end: number, g: Grid, u: number, sd: number, n: number, alpha = 0.92, rise = 1): void {
  const Rc = R * g.res;
  for (let i = n - 1; i >= 0; i--) {
    const born = born0 + (born1 - born0) * (i / Math.max(1, n - 1));
    const life = end - born;
    const a = age - born;
    if (a < 0 || a >= life) continue;
    const k = a / life;
    const sec = a / 1000;
    const dir = rnd(sd, i + 140) * TAU;
    const d0 = R * 0.6 * rnd(sd, i + 141) * (1 + 0.7 * k);
    const px = x + Math.cos(dir) * d0 * u + WIND_X * u * sec * 0.85;
    const py = y + Math.sin(dir) * d0 * u * 0.75 + (WIND_Y * 0.85 - RISE * 0.45 * rise) * u * sec;
    const r = Rc * (0.42 + 0.26 * rnd(sd, i + 142)) * (0.75 + 0.95 * easeOut(k));
    const kind: BlobKind = k < 0.32 + 0.1 * rnd(sd, i + 143) ? 'soot' : k < 0.62 ? 'shade' : 'smoke';
    drawBlob(ctx, kind, r, i, px, py, g, alpha * (1 - k) ** 1.2 * Math.min(1, a / 60));
  }
}

/**
 * Pieces thrown out of a blast on the ground on ballistic arcs (up the screen and falling back), hot at first, then
 * dark, the burning ones trailing a little smoke; once down they lie where they fell, a few still burning, fading by
 * `end`. R in model units; `life` ms is the flight of the slowest.
 */
function groundDebris(ctx: CanvasRenderingContext2D, x: number, y: number, R: number, age: number, life: number, end: number, g: Grid, u: number, sd: number, n: number, m: MotionParams, timeMs: number, fires: number): void {
  const prev = ctx.globalAlpha;
  for (let i = 0; i < n; i++) {
    const fl = life * (0.6 + 0.4 * rnd(sd, i + 200));
    const k = age / fl;
    const ang = -Math.PI / 2 + (rnd(sd, i + 201) - 0.5) * 2.9;
    const v = R * (2.2 + 2.8 * rnd(sd, i + 202));
    const big = i % 3 === 0;
    if (k < 1) {
      const px = x + Math.cos(ang) * v * k * u;
      const py = y + (Math.sin(ang) * v * k * 0.8 + 3.3 * R * k * k) * u;
      const hot = k < 0.3 + 0.2 * rnd(sd, i + 203);
      if (i < 4) {
        // the burning ones trail smoke
        for (let j = 3; j >= 1; j--) {
          const kk = Math.max(0, k - j * 0.06);
          const qx = x + Math.cos(ang) * v * kk * u;
          const qy = y + (Math.sin(ang) * v * kk * 0.8 + 3.3 * R * kk * kk) * u;
          drawBlob(ctx, j === 1 && hot ? 'fire' : 'soot', Math.max(1, g.res * (0.5 + j * 0.35)), i + j, qx, qy, g, (1 - k * 0.7) * (1 - j * 0.2), 2);
        }
      }
      ctx.globalAlpha = prev;
      const c = hot ? (i & 1 ? TRACER[0] : TRACER[1]) : DEBRIS[i % 3];
      speck(ctx, px, py, g, big ? 2 : 1, c);
      if (big) {
        // a plate tumbling: a second cell on alternate sides
        const tumble = (Math.floor(age / 70) + i) & 1;
        speck(ctx, px + (tumble ? g.k * 2 : 0), py + (tumble ? 0 : g.k * 2), g, 1, hot ? TRACER[2] : DEBRIS[(i + 1) % 3]);
      }
      continue;
    }
    // down: lying where it fell, fading; the first few still burn a while
    const a = 1 - smooth(clamp01((age - fl) / Math.max(1, end - fl)));
    if (a <= 0.02) continue;
    const px = x + Math.cos(ang) * v * u;
    const py = y + (Math.sin(ang) * v * 0.8 + 3.3 * R) * u;
    ctx.globalAlpha = prev * a;
    speck(ctx, px, py, g, big ? 2 : 1, DEBRIS[i % 2]);
    if (i < fires) {
      const fk = clamp01((age - fl) / ((end - fl) * (0.3 + 0.5 * m.fireLinger)));
      if (fk < 1) drawFlame(ctx, px + g.k * (big ? 1 : 0.5), py + g.k, g.res * 0.7 * (1 - fk * 0.6), g, timeMs + i * 97, rnd(sd, i + 205), m, a * (1 - fk * fk), 1);
    }
    ctx.globalAlpha = prev;
  }
}

const smokeSrc: SmokeSource = { x: 0, y: 0, vx: 0, vy: 0, turn: 0, calm: 0.6, n: 6, lifeMs: 1800, r0: 1, r1: 3, dark: 0.7, alpha: 1, u: 1, wind: 1, rise: 1, seed: 0 };

/** A column of smoke standing on a fire at (x, y) (burning.ts), `alpha` 0..1. */
function column(ctx: CanvasRenderingContext2D, x: number, y: number, g: Grid, u: number, timeMs: number, m: MotionParams, n: number, lifeMs: number, r0: number, r1: number, dark: number, alpha: number, seed: number, rise = 1): void {
  if (alpha <= 0.02) return;
  const s = smokeSrc;
  s.x = x;
  s.y = y;
  // a longer life (cinematic) gets more puffs, so the column stays one mass instead of a string of beads
  s.n = Math.min(18, Math.round(n * Math.max(1, lifeMs / 2100)));
  s.lifeMs = lifeMs;
  s.r0 = r0;
  s.r1 = r1;
  s.dark = dark;
  s.alpha = alpha;
  s.u = u;
  s.rise = rise;
  s.seed = seed;
  drawSmokeTrail(ctx, s, g, timeMs, m);
}

/** Pieces floating on the sea round (x, y), bobbing and drifting downwind, `alpha` 0..1. */
function floating(ctx: CanvasRenderingContext2D, x: number, y: number, rx: number, ry: number, n: number, age: number, g: Grid, u: number, sd: number, alpha: number, still: boolean): void {
  if (alpha <= 0.02) return;
  const prev = ctx.globalAlpha;
  const plank = MATERIALS.teak[2];
  const pale = MATERIALS.canvas[2];
  for (let i = 0; i < n; i++) {
    const a = rnd(sd, i + 300) * TAU;
    const d = Math.sqrt(rnd(sd, i + 301));
    const sec = still ? 0 : age / 1000;
    const px = x + Math.cos(a) * d * rx + WIND_X * u * sec * 0.22;
    const py = y + Math.sin(a) * d * ry + (still ? 0 : Math.sin(age / 430 + i * 1.7) * 0.6 * u);
    ctx.globalAlpha = prev * alpha * (0.75 + 0.25 * rnd(sd, i + 302));
    const c = i % 6 === 5 ? pale : i % 3 === 0 ? plank : DEBRIS[i % 3];
    speck(ctx, px, py, g, 1, c);
    if (i % 3 === 0) speck(ctx, px + g.k, py, g, 1, c);
  }
  ctx.globalAlpha = prev;
}

/** Bubbles coming up and popping round (x, y) (rx, ry px): `n` at a time, each a moment, densest at `rate` 1. */
function bubbles(ctx: CanvasRenderingContext2D, x: number, y: number, rx: number, ry: number, n: number, age: number, g: Grid, sd: number, alpha: number): void {
  if (alpha <= 0.02 || n <= 0) return;
  const prev = ctx.globalAlpha;
  for (let i = 0; i < n; i++) {
    const per = 380 + 200 * rnd(sd, i + 400);
    const cyc = Math.floor((age + i * 137) / per);
    const k = ((age + i * 137) % per) / per;
    const a = rnd(sd + cyc, i + 401) * TAU;
    const d = Math.sqrt(rnd(sd + cyc, i + 402));
    ctx.globalAlpha = prev * alpha * (1 - k);
    speck(ctx, x + Math.cos(a) * d * rx, y + Math.sin(a) * d * ry - k * g.k * 1.5, g, 1, k < 0.6 ? SPRAY[3] : SPRAY[2]);
  }
  ctx.globalAlpha = prev;
}

// ------------------------------------------------------------------------------------------------- planes

/** How many turns a plane makes as it falls (a fighter spins, a big plane turns slowly) and its corkscrew (in lengths). */
const SPIN: Partial<Record<SpriteKey, [number, number]>> = {
  fighter: [1.7, 0.42],
  reconPlane: [1.25, 0.34],
  groundAttack: [0.95, 0.28],
  bomber: [0.42, 0.16],
  heavyBomber: [0.3, 0.12],
  transportPlane: [0.34, 0.14],
};

interface Fall {
  x: number;
  y: number;
  hd: number;
  roll: number;
  /** how big it looks (1 at the hit, smaller as it falls away) and how high it still is (model units) */
  s: number;
  alt: number;
  q: number;
}
const fallNow: Fall = { x: 0, y: 0, hd: 0, roll: 0, s: 1, alt: 0, q: 0 };

/** Where a falling plane is `a` ms after the hit (pure; reused). */
function fallAt(d: DeathDraw, um: UnitModel, a: number, fall: number, turns: number, cork: number, spin: number, L: number): Fall {
  const f = fallNow;
  const q = clamp01(a / fall);
  const G = DEATH_GLIDE_TILES * d.zoom;
  const fwd = G * (1 - (1 - q) ** 1.6);
  const hd = d.angle + spin * turns * TAU * q ** 1.35;
  // a corkscrew round its line of fall, widening as it gets going
  const cr = L * d.scale * cork * Math.min(1, q * 3) * (1 - 0.6 * q);
  const side = spin * Math.PI * 0.5;
  f.x = d.x + Math.cos(d.angle) * fwd + cr * (Math.cos(hd + side) - Math.cos(d.angle + side));
  f.y = d.y + Math.sin(d.angle) * fwd + cr * (Math.sin(hd + side) - Math.sin(d.angle + side)) * FORE;
  f.hd = hd;
  f.roll = spin * (q < 0.1 ? 1 : q < 0.32 ? 2 : 3);
  f.s = 1 - 0.45 * q ** 1.4;
  f.alt = um.alt * (1 - q * q);
  f.q = q;
  return f;
}

/** Where a plane burns from: its first engine, else a wing root (u, v, z model units). */
function engineOf(um: UnitModel, spin: number): [number, number, number] {
  const p = um.props[0] ?? um.nozzles[0];
  if (p) return [p.u, p.v, p.z];
  return [0, spin * spanOf(um) * 0.22, 1.5];
}

function drawPlane(ctx: CanvasRenderingContext2D, d: DeathDraw, m: MotionParams): void {
  const g = gridOf(d.scale, d.dpr);
  const u = d.scale;
  const mid = g.res < 1.5;
  const sprite = d.zoom >= 3;
  const um = unitModel(d.key, d.mods & MOD_MASK[d.key]);
  const L = lengthOf(um);
  const size = Math.max(0.8, Math.min(1.35, Math.sqrt(L / 18)));
  const fall = planeFall(m);
  const dur = Math.max(1, d.durMs);
  let age = d.ageMs;
  if (d.reduced) age = d.t < 0.34 ? fall * 0.55 : d.t < 0.67 ? fall + 260 * m.blastTime : fall + (dur - fall) * 0.5;
  const sd = d.seed * 89.3 + 3;
  const spin = rnd(sd, 1) < 0.5 ? -1 : 1;
  const [turns0, cork] = SPIN[d.key] ?? [0.6, 0.15];
  const turns = turns0 * Math.max(0.5, Math.min(1.6, m.bankMax / 0.4));
  const G = DEATH_GLIDE_TILES * d.zoom;
  const cx = d.x + Math.cos(d.angle) * G;
  const cy = d.y + Math.sin(d.angle) * G;
  const lin = lingerOf(m);
  const prev = ctx.globalAlpha;
  const after = age - fall;
  const R = Math.max(4.5, Math.min(10, L * 0.42));
  const fT = 600 * m.blastTime;
  const timeMs = d.reduced ? 0 : d.ageMs;

  // ---- on the sea where it came down: the slick, wreckage and bubbles lie under the smoke it trailed
  if (after >= 0 && d.water) crashSea(ctx, d, m, g, u, cx, cy, R, after, fT, dur - fall, size, sd, mid, timeMs, 0);

  // ---- the smoke it trailed as it fell: puffs left along its way down, rising and drifting off, fading
  const step = mid ? 80 : 40;
  const life = 2300 * lin;
  const tEnd = Math.min(age, fall);
  const j1 = Math.floor(tEnd / step);
  const j0 = Math.max(1, Math.ceil((age - life) / step));
  for (let j = j0; j <= j1; j++) {
    const tb = j * step;
    const a = age - tb;
    const k = a / life;
    if (k >= 1 || a < 0) continue;
    const f = fallAt(d, um, tb, fall, turns, cork, spin, L);
    const thick = 0.45 + 0.55 * clamp01(f.q / 0.25);
    const sec = d.reduced ? 0 : a / 1000;
    const back = L * 0.18 * u * f.s;
    const px = f.x - Math.cos(f.hd) * back + WIND_X * u * sec * 0.9 + Math.sin(a / 260 + j) * 0.5 * u * k;
    const py = f.y - Math.sin(f.hd) * back * FORE + (WIND_Y * 0.9 - RISE * 0.55) * u * sec;
    const r = g.res * size * (0.7 + 0.7 * thick + 2.8 * easeOut(k)) * Math.sqrt(f.s);
    const kind: BlobKind = k < 0.42 ? 'soot' : k < 0.72 ? 'shade' : 'smoke';
    drawBlob(ctx, kind, r, j & 3, px, py, g, 0.95 * thick * (1 - k) ** 1.15 * Math.min(1, a / 50));
  }

  // ---- the crash over the smoke it trailed down (its newest puffs lie right there): fire, splash, pieces, smoke
  if (after >= 0) {
    if (d.water) crashSea(ctx, d, m, g, u, cx, cy, R, after, fT, dur - fall, size, sd, mid, timeMs, 1);
    else crashLand(ctx, d, m, g, u, cx, cy, R, after, fT, dur - fall, size, sd, mid, timeMs, sprite, fallAt(d, um, fall, fall, turns, cork, spin, L).hd);
  }

  // ---- the plane falling: its shadow closing in under it, the plane turning, rolling and smaller, burning
  if (age < fall) {
    const f = fallAt(d, um, age, fall, turns, cork, spin, L);
    const res = g.res * f.s;
    if (sprite) {
      const sx = f.x + f.alt * 0.62 * u;
      const sy = f.y + f.alt * 0.86 * u;
      drawWreck(ctx, setPose(d, 'shadow', f.hd, res, f.roll), sx, sy, g, 0.8 + 0.4 * f.q);
      drawWreck(ctx, setPose(d, 'body', f.hd, res, f.roll, f.q > 0.55 ? 1 : 0), f.x, f.y, g);
    }
    // fire at an engine, streaming back along its way
    const fireK = clamp01((f.q - 0.04) / 0.22);
    if (fireK > 0) {
      const [eu, ev, ez] = engineOf(um, spin);
      const rr = WRECK_ROLLS[Math.min(3, Math.abs(f.roll))] * Math.sign(f.roll);
      const [ex, ey] = project(eu, ev, ez, f.hd, rr, u * f.s, false);
      const lean = Math.max(-2, Math.min(2, Math.round(-Math.cos(f.hd) * 2)));
      for (let i = mid ? 1 : 2; i >= 1; i--) {
        const bk = i * 1.6 * u * f.s;
        drawBlob(ctx, 'fire', Math.max(1, g.res * f.s * size * (0.75 - 0.18 * i)), i, f.x + ex - Math.cos(f.hd) * bk, f.y + ey - Math.sin(f.hd) * bk * FORE, g, fireK * 0.9, 1 + i);
      }
      drawFlame(ctx, f.x + ex, f.y + ey + g.k, g.res * f.s * size * (0.55 + 0.45 * fireK), g, timeMs, rnd(sd, 7), m, fireK, lean);
    }
  }

  // ---- the hit: a flash and a black burst left hanging where it was
  if (!d.reduced || d.t < 0.34) blastAt(ctx, 'flak', d.x, d.y, d.reduced ? 120 : age, d.zoom, d.scale, d.dpr, d.seed, m, d.reduced);
  ctx.globalAlpha = prev;
}

/** A plane crashing on land: a flash, a fireball, pieces thrown out, its burnt wreck burning under a smoke column. */
function crashLand(ctx: CanvasRenderingContext2D, d: DeathDraw, m: MotionParams, g: Grid, u: number, x: number, y: number, R: number, a: number, fT: number, rest: number, size: number, sd: number, mid: boolean, timeMs: number, sprite: boolean, hd: number): void {
  const Rc = R * g.res;
  const lin = lingerOf(m);
  const fade = 1 - smooth(clamp01((a - (rest - 1000)) / 1000));
  // the flash's light on the ground
  if (!d.reduced) flashGlow(ctx, 'bomb', x, y, Rc, a, g, m, sd, false);
  // the burnt wreck lying there, under the fire once the fireball has covered it
  const wreckIn = clamp01((a - fT * 0.3) / 120);
  if (sprite && wreckIn > 0) drawWreck(ctx, setPose(d, 'body', hd, g.res * 0.55, 0, CHAR_STEPS), x, y, g, wreckIn * fade);
  // fires on the wreck, dying down (fireLinger)
  const fireEnd = fT + (rest - fT) * (0.35 + 0.45 * m.fireLinger);
  if (a > fT * 0.4 && a < fireEnd) {
    const k = clamp01((a - fT * 0.4) / (fireEnd - fT * 0.4));
    const n = mid ? 1 : 3;
    for (let i = 0; i < n; i++) {
      const fx = x + (rnd(sd, i + 60) - 0.5) * R * 0.9 * u;
      const fy = y + (rnd(sd, i + 61) - 0.4) * R * 0.4 * u;
      drawFlame(ctx, fx, fy, g.res * size * (i === 0 ? 1.15 : 0.8) * (1 - k * 0.6), g, timeMs + i * 131, rnd(sd, i + 62), m, 1 - k * k, 1);
    }
  }
  // the column of smoke standing on it, then thinning away
  const colA = clamp01((a - fT * 0.3) / 300) * (1 - smooth(clamp01((a - (rest - 1500 * lin)) / (1500 * lin))));
  column(ctx, x, y - R * 0.3 * u, g, u, timeMs, m, mid ? 4 : 8, 2100 * lin, g.res * size * 1.2, g.res * size * 4.4, 0.82, colA, d.seed, 1.25);
  // the burst's own smoke
  smokeCloud(ctx, x, y - R * 0.4 * u, R, a, fT * 0.2, fT * 0.8, fT + 1400 * lin, g, u, sd, mid ? 3 : 5);
  // pieces thrown out, some burning where they fall
  const nd = Math.round((mid ? 6 : 11) * m.debris);
  if (!d.reduced) groundDebris(ctx, x, y, R * 0.9, a, fT * 1.7 + 200, rest, g, u, sd, nd, m, timeMs, mid ? 1 : 3);
  // the fireball and the flash's white core over it all
  fireball(ctx, x, y, R, a, fT, g, u, sd, mid ? 4 : 6);
  if (!d.reduced) flashCore(ctx, 'bomb', x, y, Rc, a, g, m, sd);
}

/**
 * A plane crashing into the sea: the fire on the water, a big splash, an oil slick, floating pieces and bubbles.
 * `layer` 0 is what lies on the water (under the smoke it trailed down), 1 the rest.
 */
function crashSea(ctx: CanvasRenderingContext2D, d: DeathDraw, m: MotionParams, g: Grid, u: number, x: number, y: number, R: number, a: number, fT: number, rest: number, size: number, sd: number, mid: boolean, timeMs: number, layer: 0 | 1): void {
  const Rc = R * g.res;
  const lin = lingerOf(m);
  const k = clamp01(a / rest);
  const fade = 1 - smooth(clamp01((a - rest * 0.55) / (rest * 0.45)));
  if (layer === 0) {
    if (!d.reduced) flashGlow(ctx, 'shell', x, y, Rc, a, g, m, sd, false);
    // the oil slick spreading where it went in, thinning out
    if (a > 120) drawBlob(ctx, 'oil', Rc * (0.55 + 1.1 * easeOut(clamp01(a / (rest * 0.6)))), Math.floor(sd) & 3, x + WIND_X * u * (a / 1000) * 0.15, y, g, 0.85 * fade, Math.min(3, Math.floor(k * 3.6)));
    // floating pieces and bubbles
    const spread = easeOut(clamp01((a - 150) / 1200));
    if (a > 150) floating(ctx, x, y, R * (0.6 + 1.2 * spread) * u, R * (0.35 + 0.6 * spread) * u, mid ? 4 : 8, a, g, u, sd, fade, d.reduced);
    bubbles(ctx, x, y, R * 0.9 * u, R * 0.5 * u, mid ? 2 : 4, a, g, sd, (1 - clamp01((a - 400) / 1600)) * 0.9);
    return;
  }
  // burning fuel on the water for a while
  const fireEnd = fT + (rest - fT) * (0.2 + 0.3 * m.fireLinger);
  if (a > fT * 0.5 && a < fireEnd) {
    const kk = clamp01((a - fT * 0.5) / (fireEnd - fT * 0.5));
    for (let i = 0; i < (mid ? 1 : 2); i++) drawFlame(ctx, x + (i ? 0.6 : -0.4) * R * u, y + (i ? -0.1 : 0.15) * R * u, g.res * size * (0.85 - 0.25 * i) * (1 - kk * 0.6), g, timeMs + i * 151, rnd(sd, i + 70), m, 1 - kk * kk, 1);
  }
  // a short column of smoke off the burning fuel
  const colA = clamp01((a - fT * 0.4) / 300) * (1 - smooth(clamp01((a - fireEnd * 0.8) / (fireEnd * 0.5))));
  column(ctx, x, y, g, u, timeMs, m, mid ? 3 : 5, 1500 * lin, g.res * size * 0.9, g.res * size * 3, 0.55, colA * 0.85, d.seed, 1);
  // the splash: a big column of water thrown up and falling back, foam spreading
  // (at most 1.15 times a shell's: its foam stays in fine cells close up)
  if (!d.reduced || d.t < 0.67) blastAt(ctx, 'splash', x, y, d.reduced ? 200 : a, d.zoom, d.scale, d.dpr, d.seed, m, d.reduced, Math.min(1.15, 0.75 + 0.35 * size));
  // a quick fireball of fuel at the surface and the flash
  fireball(ctx, x, y - R * 0.2 * u, R * 0.75, a, fT * 0.6, g, u, sd, mid ? 3 : 4);
  if (!d.reduced) flashCore(ctx, 'air', x, y, Rc * 0.8, a, g, m, sd);
}

// ------------------------------------------------------------------------------------------------- missiles

/** A point worked out without allocating (a falling piece's place). */
const PT = { x: 0, y: 0 };
/** Both sides of a hull (across, in spans). */
const SIDES = [-0.55, 0.55] as const;

function drawMissile(ctx: CanvasRenderingContext2D, d: DeathDraw, m: MotionParams): void {
  const g = gridOf(d.scale, d.dpr);
  const u = d.scale;
  const mid = g.res < 1.5;
  const atom = d.key === 'atomBomb';
  const um = unitModel(d.key, 0);
  const R = atom ? 7.5 : 5.5;
  const Rc = R * g.res;
  const fT = 450 * m.blastTime;
  const dur = Math.max(1, d.durMs);
  const impact = missileImpact(m);
  let age = d.ageMs;
  if (d.reduced) age = d.t < 0.5 ? fT * 0.45 : impact * 0.75;
  const sd = d.seed * 73.1 + 5;
  const lin = lingerOf(m);
  const prev = ctx.globalAlpha;
  const x = d.x;
  const y = d.y;
  // the ground below the burst (where its shadow lay)
  const ox = um.alt * 0.62 * u;
  const oy = um.alt * 0.86 * u;
  const timeMs = d.reduced ? 0 : d.ageMs;
  // the burst's light on the ground under it
  if (!d.reduced) flashGlow(ctx, 'shell', x + ox, y + oy, Rc * 0.8, age, g, m, sd, false);

  // ---- the pieces: thrown out burning, falling to the ground below, each landing as a small blast or a splash
  const n = Math.max(3, Math.round((atom ? 12 : 8) * m.debris * (mid ? 0.6 : 1)));
  const landMs = 450 * m.blastTime;
  const trailLife = 900 * lin;
  const step = mid ? 90 : 50;
  for (let pass = 0; pass < 3; pass++) {
    for (let i = 0; i < n; i++) {
      const main = i === 0;
      const tf = main ? impact - 40 : (700 + 400 * rnd(sd, i + 40)) * m.blastTime;
      const a = age - 40;
      if (a < 0) continue;
      const k = a / tf;
      const dir = rnd(sd, i + 41) * TAU;
      const vh = R * (main ? 0.6 : 1.3 + 2.6 * rnd(sd, i + 42));
      const pop = main ? 0.15 : 0.25 + 0.5 * rnd(sd, i + 43);
      // about half of them burn (and trail smoke), some only for part of the way down; each its own thickness
      const burning = main || rnd(sd, i + 44) < 0.5;
      const burnEnd = main ? 1 : 0.45 + 0.55 * rnd(sd, i + 45);
      const thick = main ? 1.4 : 0.6 + 0.7 * rnd(sd, i + 46);
      const cdx = Math.cos(dir) * vh * u;
      const cdy = Math.sin(dir) * vh * u * FORE;
      /** Where the piece is `kk` of its way down (into PT: no allocation per puff). */
      const at = (kk: number): void => {
        const sp = easeOut(Math.min(1, kk));
        const h = 1 - kk * kk + pop * 4 * kk * (1 - kk);
        PT.x = x + ox + cdx * sp - h * ox;
        PT.y = y + oy + cdy * sp - h * oy;
      };
      if (pass === 1) {
        // the smoke a burning piece leaves along its way down, lingering and drifting off after it
        if (!burning) continue;
        const tEnd = Math.min(a, tf * burnEnd);
        const life = trailLife * (main ? 1 : 0.55 + 0.45 * thick);
        for (let j = Math.max(1, Math.ceil((a - life) / step)); j * step <= tEnd; j++) {
          const tb = j * step;
          const pa = a - tb;
          const pk = pa / life;
          if (pk >= 1) continue;
          at(tb / tf);
          const qx = PT.x;
          const qy = PT.y;
          const sec = d.reduced ? 0 : pa / 1000;
          const r = g.res * (0.4 + 1.15 * easeOut(pk)) * thick * (atom ? 1.1 : 1);
          drawBlob(ctx, pk < 0.4 ? 'soot' : pk < 0.7 ? 'shade' : 'smoke', r, (i + j) & 3, qx + WIND_X * u * sec * 0.6, qy - RISE * u * sec * 0.3, g, 0.85 * (1 - pk) ** 1.2 * Math.min(1, pa / 40));
        }
        continue;
      }
      if (k < 1) {
        if (pass !== 2) continue;
        // in the air: a burning piece (the small cold ones dark)
        at(k);
        const px = PT.x;
        const py = PT.y;
        const hot = (burning && k < burnEnd) || k < 0.25;
        speck(ctx, px, py, g, main ? 2 : 1, hot ? (i & 1 ? TRACER[0] : TRACER[1]) : DEBRIS[i % 3]);
        if (main || (burning && k < burnEnd && !mid)) drawBlob(ctx, 'fire', Math.max(1, g.res * (main ? 0.9 : 0.55)), i, px, py - g.k * 0.5, g, 1, 2);
        continue;
      }
      if (pass !== 0) continue;
      // down: a small blast on land, a splash on the sea (the main piece a little bigger), then a wisp
      const la = a - tf;
      at(1);
      const gx = PT.x;
      const gy = PT.y;
      if (main) {
        if (d.water) blastAt(ctx, 'splash', gx, gy, la, d.zoom, d.scale, d.dpr, d.seed, m, d.reduced, atom ? 0.75 : 0.6);
        else blastAt(ctx, 'shell', gx, gy, la, d.zoom, d.scale, d.dpr, d.seed, m, d.reduced);
        continue;
      }
      if (d.water) {
        blastAt(ctx, 'splash', gx, gy, la, d.zoom, d.scale, d.dpr, (d.seed + i * 0.137) % 1, m, d.reduced, (atom ? 0.36 : 0.3) * (0.8 + 0.4 * rnd(sd, i + 47)));
        continue;
      }
      if (la >= landMs + 900 * lin) continue;
      const lk = la / landMs;
      if (lk < 1) {
        // a little burst: a spark of light, a puff of fire, earth kicked up and a few clods
        if (la < 50 && !d.reduced) speck(ctx, gx, gy - g.k, g, 2, FIRE[0]);
        drawBlob(ctx, 'dust', g.res * (1 + 1.8 * easeOut(lk)), i, gx, gy - lk * g.k * 2, g, 0.85 * (1 - lk));
        drawBlob(ctx, 'fire', Math.max(1, g.res * (1.4 - 0.9 * lk)), i, gx, gy - g.k, g, 1 - lk * lk, Math.min(4, lk * 5));
        ctx.globalAlpha = prev * (1 - lk);
        for (let c = 0; c < 3; c++) {
          const ca = -Math.PI / 2 + (c - 1) * 0.9;
          speck(ctx, gx + Math.cos(ca) * 2.2 * lk * g.res * g.k, gy + (Math.sin(ca) * 2.2 * lk + 3 * lk * lk) * g.res * g.k, g, 1, DEBRIS[c % 3]);
        }
        ctx.globalAlpha = prev;
      } else {
        const wk = (la - landMs) / (900 * lin);
        drawBlob(ctx, 'smoke', g.res * (0.9 + 1.5 * wk), i, gx + (WIND_X * u * (la - landMs)) / 1000, gy - ((RISE * u * (la - landMs)) / 1000) * 0.6, g, 0.6 * (1 - wk));
      }
    }
  }

  // ---- the burst: black smoke left hanging where it was, the fireball, the flash
  smokeCloud(ctx, x, y, R, age, fT * 0.15, fT * 0.7, dur, g, u, sd, mid ? 4 : atom ? 8 : 6, 0.95, 0.6);
  fireball(ctx, x, y, R, age, fT, g, u, sd, mid ? 4 : atom ? 7 : 6);
  if (!d.reduced) {
    flashGlow(ctx, 'missile', x, y, Rc * 0.75, age, g, m, sd, true);
    flashCore(ctx, 'missile', x, y, Rc, age, g, m, sd);
  }
  ctx.globalAlpha = prev;
}

// ------------------------------------------------------------------------------------------------- tanks

function drawTank(ctx: CanvasRenderingContext2D, d: DeathDraw, m: MotionParams): void {
  const g = gridOf(d.scale, d.dpr);
  const u = d.scale;
  const mid = g.res < 1.5;
  const sprite = d.zoom >= 3;
  const um = unitModel(d.key, d.mods & MOD_MASK[d.key]);
  const L = lengthOf(um);
  const size = Math.max(0.8, Math.min(1.3, Math.sqrt(L / 14)));
  const blastT = tankBlast(m);
  const burn = tankBurn(m);
  const endBurn = blastT + burn;
  let age = d.ageMs;
  if (d.reduced) age = d.t < 0.3 ? 260 : d.t < 0.7 ? blastT + burn * 0.4 : endBurn + TANK_FADE * 0.3;
  const sd = d.seed * 67.9 + 7;
  const spin = rnd(sd, 1) < 0.5 ? -1 : 1;
  const prev = ctx.globalAlpha;
  const x = d.x;
  const y = d.y;
  const timeMs = d.reduced ? 0 : d.ageMs;
  const n = facingsFor(g.res, 'other');
  const th = facingIndex(d.angle, n) * (TAU / n);
  const burnK = clamp01((age - 120) / burn);
  const char = age < 160 ? 0 : burnK < 0.18 ? 1 : burnK < 0.45 ? 2 : CHAR_STEPS;
  // the charred wreck stands a moment, then goes quickly (a long see-through fade would read as a ghost)
  const fadeA = 1 - smooth(clamp01((age - endBurn - TANK_FADE * 0.45) / (TANK_FADE * 0.55)));
  const piv = um.turret ? project(um.turret.u, um.turret.v, 1.5, th, 0, u, false) : [0, -u];
  const px = x + piv[0];
  const py = y + piv[1];
  const R = Math.max(3.5, L * 0.32);

  // ---- the ground scorched black under it, the hull burning, then a charred wreck
  drawBlob(ctx, 'scorch', g.res * L * 0.42, Math.floor(sd) & 3, x, y + 0.6 * u, g, 0.85 * fadeA * clamp01(age / 200));
  if (sprite) drawWreck(ctx, setPose(d, 'body', d.angle, g.res, 0, char), x, y, g, fadeA);
  // where the turret was: a black hole in the hull
  if (sprite && um.turret && age > 60) drawBlob(ctx, 'soot', g.res * 1.1 * size, 2, px, py + 0.3 * u, g, 0.9 * fadeA);
  // embers glowing on the burnt hull late on
  if (burnK > 0.4 && !d.reduced && !mid) {
    const ek = clamp01((burnK - 0.4) / 0.2) * fadeA;
    for (let i = 0; i < 5; i++) {
      const on = ((Math.floor(age / 160) + i * 3) % 5) < 3;
      if (!on) continue;
      const [ex, ey] = project((rnd(sd, i + 80) - 0.5) * L * 0.7, (rnd(sd, i + 81) - 0.5) * L * 0.35, 1.8, th, 0, u, false);
      ctx.globalAlpha = prev * ek * (0.5 + 0.5 * rnd(sd, i + 82));
      speck(ctx, x + ex, y + ey, g, 1, i & 1 ? FIRE[4] : FIRE[3]);
    }
    ctx.globalAlpha = prev;
  }
  // fires: roaring out of the turret ring, on the engine deck, then dying down to the embers
  const fireA = clamp01(age / 90) * (1 - smooth(clamp01((burnK - 0.5) / 0.35)));
  if (fireA > 0.02) {
    const [ex, ey] = project(-L * 0.32, 0, 1.6, th, 0, u, false);
    if (age > 220) drawFlame(ctx, x + ex, y + ey, g.res * size * 0.85, g, timeMs + 91, rnd(sd, 11), m, fireA * clamp01((age - 220) / 150), 1);
    drawFlame(ctx, px, py, g.res * size * (1.35 - 0.55 * burnK), g, timeMs, rnd(sd, 12), m, fireA, 1);
    if (!mid) {
      const [fx, fy] = project(L * 0.22, (spin * L) / 9, 1.4, th, 0, u, false);
      drawFlame(ctx, x + fx, y + fy, g.res * size * 0.6, g, timeMs + 173, rnd(sd, 13), m, fireA * 0.9, 1);
    }
  }

  // ---- the turret thrown off: up on an arc, tumbling, its shadow on the ground under it, landing beside the hull
  if (um.turret) {
    const tf = 800 * m.blastTime;
    const k = clamp01((age - 30) / tf);
    const side = d.angle + spin * (Math.PI / 2 + (rnd(sd, 20) - 0.5) * 0.9);
    const D = L * (0.55 + 0.25 * rnd(sd, 21)) * (0.8 + 0.2 * m.debris);
    const H = L * (0.7 + 0.35 * Math.min(1.5, m.debris));
    const k2 = clamp01((age - 30 - tf) / (240 * m.blastTime));
    const along = D * (k + 0.12 * k2);
    const h = H * 4 * k * (1 - k) + H * 0.12 * 4 * k2 * (1 - k2);
    const gx = px + Math.cos(side) * along * u;
    const gy = py + Math.sin(side) * along * u * FORE;
    const turn = d.angle + spin * TAU * (1.3 + 0.6 * rnd(sd, 22)) * (k + 0.1 * k2);
    if (age > 30) {
      if (sprite) drawWreck(ctx, setPose(d, 'turretShadow', turn, g.res), gx, gy, g, fadeA * (1 - 0.5 * Math.min(1, h / H)));
      if (sprite) drawWreck(ctx, setPose(d, 'turret', turn, g.res, 0, k >= 1 ? char : 0), gx, gy - h * LIFT * u, g, fadeA);
      else speck(ctx, gx, gy - h * LIFT * u, g, 2, DEBRIS[1]);
    }
    // a puff of dust where it lands
    if (k >= 1 && k2 < 1) drawBlob(ctx, 'dust', g.res * size * (0.8 + 1.4 * easeOut(k2)), 3, gx, gy, g, 0.75 * (1 - k2));
  }

  // ---- the column of black smoke off the wreck, thinning away as the fires go out
  const colA = clamp01((age - 100) / 300) * (1 - smooth(clamp01((age - (endBurn - 700)) / (TANK_FADE + 700))));
  column(ctx, px, py, g, u, timeMs, m, mid ? 4 : 8, 2100 * lingerOf(m), g.res * size * 1.1, g.res * size * 4.4, 1, colA, d.seed, 1.3);

  // ---- the blast: steel struck, a fireball out of the turret ring, the flash
  if (!d.reduced || d.t < 0.3) blastAt(ctx, 'hit', px, py, d.reduced ? 150 : age, d.zoom, d.scale, d.dpr, d.seed, m, d.reduced);
  fireball(ctx, px, py, R, age - 20, 420 * m.blastTime, g, u, sd, mid ? 3 : 5);
  if (!d.reduced) flashCore(ctx, 'bomb', px, py, R * g.res, age, g, m, sd);
  ctx.globalAlpha = prev;
}

// ------------------------------------------------------------------------------------------------- ships

function drawShip(ctx: CanvasRenderingContext2D, d: DeathDraw, m: MotionParams): void {
  const g = gridOf(d.scale, d.dpr);
  const u = d.scale;
  const mid = g.res < 1.5;
  const sprite = d.zoom >= 3;
  const um = unitModel(d.key, d.mods & MOD_MASK[d.key]);
  const L = lengthOf(um);
  const B = spanOf(um);
  const size = Math.max(0.75, Math.min(1.35, Math.sqrt(L / 32)));
  const hitT = shipHit(m);
  const listT = shipList(m);
  const sinkT = shipSink(m);
  const under = hitT + listT + sinkT;
  const dur = Math.max(1, d.durMs);
  const rest = Math.max(1, dur - under);
  let age = d.ageMs;
  if (d.reduced) age = d.t < 0.3 ? hitT + listT * 0.7 : d.t < 0.6 ? hitT + listT + sinkT * 0.5 : under + rest * 0.4;
  const sd = d.seed * 59.3 + 11;
  const side = rnd(sd, 1) < 0.5 ? -1 : 1;
  const dir = rnd(sd, 2) < 0.65 ? -1 : 1;
  const lin = lingerOf(m);
  const prev = ctx.globalAlpha;
  const x = d.x;
  const y = d.y;
  const timeMs = d.reduced ? 0 : d.ageMs;
  const n = facingsFor(g.res, 'ship');
  const th = facingIndex(d.angle, n) * (TAU / n);
  const listQ = clamp01((age - hitT * 0.5) / listT);
  const sinkQ = clamp01((age - hitT - listT) / sinkT);
  // it settles slowly, then goes: the water climbs faster and faster
  const sinkE = sinkQ ** 1.5;
  const sink = Math.min(SINK_STEPS, Math.floor(sinkE * SINK_STEPS + 0.5));
  const roll = side * (listQ < 0.25 ? 0 : listQ < 0.6 ? 1 : sinkQ < 0.45 ? 2 : 3);
  const rollRad = side * WRECK_ROLLS[Math.abs(roll)];
  const p = sinkReach(sinkE * SINK_STEPS);
  const ca = Math.cos(th);
  const sa = Math.sin(th);
  /** The spot `u` along the hull (model units) as 0..1 from the end that goes first (the waterline climbs it). */
  const fromEnd = (au: number): number => (dir < 0 ? au + L / 2 : L / 2 - au) / L;
  const post = clamp01((age - under) / rest);
  const fadeAfter = 1 - smooth(clamp01((age - under - rest * 0.45) / (rest * 0.55)));

  // ---- the oil slick spreading round it as it goes down and after (under the hull)
  if (sinkQ > 0.25) {
    const k = clamp01((age - hitT - listT - sinkT * 0.25) / (sinkT * 0.75 + rest * 0.6));
    const oa = 0.85 * clamp01((sinkQ - 0.25) / 0.3) * fadeAfter;
    for (let i = -1; i <= 1; i++) {
      const au = (i * L) / 3.2;
      const r = g.res * L * (0.16 + 0.17 * easeOut(k)) * (i === 0 ? 1.2 : 0.95);
      const dx = au * ca * u + WIND_X * u * (Math.max(0, age - under) / 1000) * 0.12;
      const dy = au * sa * u * FORE;
      drawBlob(ctx, 'oil', r, (Math.floor(sd) + i + 1) & 3, x + dx, y + dy, g, oa, Math.min(3, Math.floor(post * 3.6)));
    }
  }
  // churned foam where it went down
  if (age > under - sinkT * 0.2 && post < 0.6) {
    const k = clamp01((age - under + sinkT * 0.2) / (rest * 0.6 + sinkT * 0.2));
    drawBlob(ctx, 'foam', g.res * L * (0.22 + 0.2 * easeOut(k)), Math.floor(sd) & 3, x, y, g, 0.85 * (1 - k * k), Math.min(3, 1 + Math.floor(k * 3)));
  }

  // ---- the hull: listing, then going under from one end
  if (sprite && sink < SINK_STEPS) drawWreck(ctx, setPose(d, 'body', d.angle, g.res, roll, 0, sink, dir), x, y, g);

  // ---- the sea washing over its low side as it lists (white water along that gunwale)
  if (sprite && listQ > 0.55 && sinkQ < 0.7 && !mid) {
    const wa = clamp01((listQ - 0.55) / 0.3) * (1 - clamp01((sinkQ - 0.4) / 0.3));
    for (let i = 0; i < 4; i++) {
      const au = (i / 3 - 0.5) * L * 0.75;
      if (fromEnd(au) < p) continue;
      const [fx, fy] = project(au, side * B * 0.5, 0, th, rollRad, u, false);
      drawBlob(ctx, 'foam', g.res * size * (1.1 + 0.4 * Math.sin(age / 300 + i * 1.3) ** 2), (i + Math.floor(age / 340)) & 3, x + fx, y + fy, g, 0.75 * wa, 1 + (i & 1));
    }
  }

  // ---- foam where the sea meets the hull at its waterline, and bubbles boiling up
  if (sinkQ > 0 && sinkQ < 1) {
    const aw = dir < 0 ? -L / 2 + L * Math.min(1, Math.max(0, p)) : L / 2 - L * Math.min(1, Math.max(0, p));
    for (const sv of SIDES) {
      const [fx, fy] = project(aw, sv * B, 0, th, rollRad, u, false);
      drawBlob(ctx, 'foam', g.res * size * (1.4 + 0.8 * Math.sin(age / 210 + sv * 3) ** 2), (Math.floor(age / 260) + (sv > 0 ? 1 : 0)) & 3, x + fx, y + fy, g, 0.85, 1);
    }
    const [bx, by] = project(aw - dir * L * 0.08, 0, 0, th, rollRad, u, false);
    bubbles(ctx, x + bx, y + by, L * 0.15 * u, B * 0.6 * u, mid ? 3 : 6, age, g, sd, 0.95);
  }
  if (age >= under) bubbles(ctx, x, y, L * 0.3 * u, L * 0.12 * u, mid ? 2 : 5, age, g, sd + 1, 0.9 * (1 - clamp01(post / 0.6)));

  // ---- wreckage left floating: pieces let go as the water reaches them, drifting off and fading
  if (sinkQ > 0.15) floating(ctx, x, y, L * 0.5 * u, Math.max(B, L * 0.22) * u, mid ? 5 : 10, age, g, u, sd, clamp01((sinkQ - 0.15) / 0.4) * fadeAfter, d.reduced);

  // ---- fires on deck at the hit spots (each going out in a puff of steam as the sea reaches it)
  const nF = mid ? (L > 30 ? 2 : 1) : L > 30 ? 3 : 2;
  const seedInt = Math.floor(d.seed * 997);
  let smokeX = x;
  let smokeY = y;
  let smokeOn = 0;
  for (let i = 0; i < nF; i++) {
    const [su, sv, sz] = hitSpot(um, seedInt, i);
    const [fx, fy] = project(su, sv, sz, th, rollRad, u, false);
    const e = fromEnd(su);
    const goneAt = hitT + listT + clamp01((e + 0.1) / 1.6) ** (1 / 1.5) * sinkT;
    const start = 80 + i * 380;
    if (age < start) continue;
    if (age < goneAt) {
      const grow = clamp01((age - start) / 700);
      if (!mid) drawBlob(ctx, 'scorch', g.res * size * (i === 0 ? 1.5 : 1.1), (seedInt + i) & 3, x + fx, y + fy + 0.4 * u, g, 0.9 * grow);
      drawFlame(ctx, x + fx, y + fy, g.res * size * (0.7 + 0.7 * grow + 0.3 * listQ) * (i === 0 ? 1 : 0.8), g, timeMs + i * 113, rnd(sd, i + 30), m, Math.min(1, grow * 1.5), 1);
      if (i === 0 || smokeOn === 0) {
        smokeX = x + fx;
        smokeY = y + fy;
        smokeOn = 1;
      }
    } else if (age < goneAt + 520) {
      const k = (age - goneAt) / 520;
      drawBlob(ctx, 'vapour', g.res * size * (1 + 2 * k), i, x + fx + WIND_X * u * k * 0.5, y + fy - k * 5 * u, g, 0.85 * (1 - k));
    }
  }
  // the heavy black column: from the fires while it floats, then thinning off the slick
  const colA = clamp01((age - 120) / 500) * (smokeOn ? 1 : 0.55 * (1 - smooth(clamp01(post / 0.7))));
  column(ctx, smokeOn ? smokeX : x, smokeOn ? smokeY : y, g, u, timeMs, m, mid ? 4 : 8, 2200 * lin * size, g.res * size * 0.9, g.res * size * 4.2, 1, colA, d.seed, 1.2);

  // ---- the hits: a blast on the hull, more on a big ship (a magazine going up)
  const [h0x, h0y] = project(...hitSpot(um, seedInt, 0), th, 0, u, false);
  if (!d.reduced || d.t < 0.3) blastAt(ctx, 'hit', x + h0x, y + h0y, d.reduced ? 150 : age, d.zoom, d.scale, d.dpr, d.seed, m, d.reduced);
  if (L > 24 && !d.reduced) {
    const [h1x, h1y] = project(...hitSpot(um, seedInt, 1), th, 0, u, false);
    blastAt(ctx, 'hit', x + h1x, y + h1y, age - 260, d.zoom, d.scale, d.dpr, (d.seed + 0.37) % 1, m, false);
    if (L > 34 && m.debris >= 1) {
      fireball(ctx, x + h1x, y + h1y, 5.5 * size, age - listT * 0.6, 520 * m.blastTime, g, u, sd + 3, mid ? 3 : 5);
      flashCore(ctx, 'bomb', x + h1x, y + h1y, 5.5 * size * g.res, age - listT * 0.6, g, m, sd);
    }
  }
  ctx.globalAlpha = prev;
}

// ------------------------------------------------------------------------------------------------- the art

/** One frame of a death (DeathDraw.kind picks which). */
export function drawDeathFrame(ctx: CanvasRenderingContext2D, d: DeathDraw, m: MotionParams): void {
  switch (d.kind) {
    case 'plane':
      return drawPlane(ctx, d, m);
    case 'missile':
      return drawMissile(ctx, d, m);
    case 'tank':
      return drawTank(ctx, d, m);
    case 'ship':
      return drawShip(ctx, d, m);
  }
}

/** The detailed explosions with their deaths. */
export const detailedExplosionArt: ExplosionArt = {
  durationMs: (kind, m) => detailedExplosions.durationMs(kind, m),
  draw: (ctx, b, m) => detailedExplosions.draw(ctx, b, m),
  drawMapFx: (ctx, f, m) => detailedExplosions.drawMapFx(ctx, f, m),
  deathTimes: (kind, m) => deathTimesOf(kind, m),
  drawDeath: (ctx, d, m) => drawDeathFrame(ctx, d, m),
};
