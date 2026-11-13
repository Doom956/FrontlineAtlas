// The realistic style's cannon fire (client only). It is drawn over the ships of whatever style draws them (the game's
// ships are detailed pixel art), so it is sized from the map scale and painted bold enough to read at mid zoom, in the
// fire ramp every style shares (white hot #fff4d6, yellow #ffd98a, orange #f6a53e, deep orange #dc7426, red #b04a1c)
// and lit from the same top left.
//
//   muzzle   one gun turret of a salvo going off (the map starts each gun of a ship a little after the last, so a
//            battleship's salvo ripples from turret to turret and builds the big mass, while a destroyer's one turret
//            stays a gun going off, never the ship blowing up). In order:
//              the blast   HOLD ms at full strength (three frames at 60 fps at Lively, more with flashTime), never the
//                          same shape two frames running: a white-hot core drawn out along the line of fire, a ragged
//                          tongue of fire out of each of the turret's three barrels (uneven, a few ms apart, each
//                          bursting out wider at its tip) and a ragged cone over them fusing them into one flash
//              the light   a warm light on the deck and the water lying out ahead of the gun (an ellipse along the
//                          line of fire, never a round halo over the hull)
//              the water   the blast slapping the water: a ring of low spray, most of it on the firing side
//                          (recoil; none at Subtle)
//              the ball    the blast drawn back into a ragged ball of fire rolling out along the line of fire, cooling
//                          from yellow through orange to a dull red glow inside the smoke (FLASH ms in all)
//              the smoke   brown-grey gun smoke shoved out of the ball along the line of fire, sooty and lit from
//                          inside at first, slowing, rising and drifting off with the wind as it thins, smaller than the
//                          ship under it (muzzleSmoke)
//            At mid zoom (map scale 1) it is a short cone out of the bow about a ship's beam wide with a small ball
//            ahead of it, no light and no spray. flashSize scales it; flashTime plays it slower (Cinematic) or
//            quicker (Subtle)
//   shell    a burning shell lobbed in an arc (lifted up the screen with height, shellArc): a small white-hot head with
//            a glow drawn out along its flight, a trail of fire behind it tapering to nothing along its arc, close up a
//            few small puffs of smoke behind that and a faint streak of shadow on the water near launch and landing.
//            Its flight starts at the firing ship's middle: it shows from the far edge of the flash's ball of fire on
//            (shellClear), and nothing of it reaches back behind that point
//   tracer   anti-aircraft fire: bursts of short red-orange streaks racing up at the plane, a little scattered
//   torpedo  a dark shape under the surface pulling a line of white bubbles behind it
// Where a shell lands (a splash, a hit on a ship, a shell on land) is a blast of the explosions style: the cannon fire
// interface ends with the flight.
import type { MotionParams } from '../motion';
import { rnd } from '../shared/noise';
import type { CannonArt, MuzzleDraw, ShellDraw } from '../types';
import { unitPx } from './explosions';
import { fireLight, Flame, flame } from './fire';
import { clamp01, easeOut, easeOut3, flashOver, glow, Puff, puff, puffTurned, ramp, WIND_X, WIND_Y } from './puffs';

/** Smooth 0..1 (smoothstep). */
const smooth = (t: number): number => {
  const k = clamp01(t);
  return k * k * (3 - 2 * k);
};

/** The fire of the flash at flashTime 1 (ms): the blast, then the ball of fire cooling; the smoke takes the rest. */
const FLASH = 220;
const SMOKE = 620;
/** How long the blast stays at full strength at flashTime 1 (ms): three frames at 60 fps. */
const HOLD = 50;
/** The blast's cone and tongues are gone by then (ms): the ball of fire has taken over. */
const BLAST = 125;
/** One frame at 60 fps (ms): the blast's shape flickers from one to the next while it holds. */
const FRAME = 1000 / 60;
/** The barrels a flash comes out of (a turret's guns side by side) and how far apart they are (art units). */
const BARRELS = 3;
const GAP = 1.05;
/** How far apart the barrels' tongues of fire start (art units): closer than the smoke, so they fuse into one blast. */
const GAP_FIRE = 0.55;
/** The spray on the water (ms). */
const WATER = 440;
/**
 * One turret's flash against the bold flash it was sized from: a destroyer's single turret stays a gun going off, not
 * the ship blowing up, and a battleship's ripple of three turrets builds the big mass.
 */
const ONE = 0.62;

function flashMs(m: MotionParams): number {
  return (FLASH + SMOKE * m.muzzleSmoke) * m.flashTime;
}

/**
 * The bold art unit the flash was first sized from (px) at map scale `scale`. Below zoom 3 the ships are small far
 * markers: it shrinks with them down to zoom 2 (none is drawn farther out).
 */
const boldUnit = (scale: number, zoom: number): number => (scale > 1 ? scale * 1.5 : 2.1 * clamp01(0.45 + 0.55 * (zoom - 2)));
/** An art unit of one turret's flash on screen (px). */
const flashUnit = (scale: number, zoom: number): number => ONE * boldUnit(scale, zoom);

/**
 * The size of a flash at map scale `scale` and zoom `zoom` (CSS px): the blast's length along the line of fire and its
 * width, how far the barrels' tongues reach, and how many barrels flash (flashSize scales them). At mid zoom (map scale
 * 1) it is about a ship's beam wide.
 */
export function muzzleFlash(scale: number, m: MotionParams, zoom = 6): { length: number; width: number; tongue: number; barrels: number } {
  const U = flashUnit(scale, zoom);
  return { length: U * 8.5 * m.flashSize, width: U * 6 * m.flashSize, tongue: U * 8 * m.flashSize, barrels: BARRELS };
}

/**
 * How far a flash reaches out from its turret along the line of fire (CSS px): the far edge of its ball of fire once it
 * has rolled out. A shell shows from about there on (shellClear).
 */
export function muzzleReach(scale: number, m: MotionParams, zoom = 6): number {
  const fz = m.flashSize;
  return flashUnit(scale, zoom) * (1.1 + (7 + 4.6 * (scale > 1 ? 1 : MID_BALL)) * fz);
}

/**
 * How long the parts of a flash show (real ms, after flashTime): the blast at full strength, the fire (blast and ball)
 * in all, and the whole flash with its smoke (CannonArt.flashMs).
 */
export function muzzleTiming(m: MotionParams): { hold: number; fire: number; total: number } {
  return { hold: HOLD * m.flashTime, fire: FLASH * m.flashTime, total: flashMs(m) };
}

/** The look of a shell in flight at map scale `scale` (CSS px): its head's radius and the length of its trail of fire. */
export function shellLook(scale: number): { head: number; trail: number } {
  const sc = Math.max(1, scale);
  return { head: 0.85 + 0.45 * sc, trail: 10 + 5 * sc };
}

/**
 * The part of a shell's flight (0..1) hidden under the firing ship and its flash (`dist` the flight's length on screen,
 * CSS px). The flight starts at the ship's middle while the flash is at a turret: the shell shows once it is past the far
 * edge of the ball of fire (with room for a turret off the middle), so it comes out of the fire, never beside it.
 */
export function shellClear(scale: number, dist: number, m?: MotionParams, zoom = 6): number {
  const clear = (m ? muzzleReach(scale, m, zoom) : flashUnit(scale, zoom) * 12.7) + 4 * Math.max(1, scale) + 3;
  return dist > clear / 0.36 ? clear / dist : 0.36;
}

/** The ball of fire at mid zoom against close up: kept inside about a ship's beam, out ahead of the bow. */
const MID_BALL = 0.7;

/** A flash at one moment (its parts' strengths 0..1 and where its ball of fire is). */
export interface FlashState {
  /** the neck of the blast (the barrels' tongues and the cone over them): 1 while it holds */
  blast: number;
  /** the white-hot core at the muzzles */
  core: number;
  /** the light on the deck and the water */
  light: number;
  /** the ball of fire and how far it has cooled (0 yellow, 1 a dull red) */
  ball: number;
  cool: number;
  /** the ball's centre ahead of the muzzles along the line of fire and its radius (art units of the flash) */
  ballD: number;
  ballR: number;
}

const flashNow: FlashState = { blast: 0, core: 0, light: 0, ball: 0, cool: 0, ballD: 0, ballR: 0 };

/**
 * A flash `tt` ms after the gun went off, on its flashTime-1 clock (a longer flashTime plays the same flash slower).
 * Fills and returns `out` (one shared object by default: nothing is allocated per frame).
 */
export function flashState(tt: number, m: MotionParams, out: FlashState = flashNow): FlashState {
  const fz = m.flashSize;
  const e = easeOut(clamp01(tt / FLASH));
  const on = tt >= 0;
  out.blast = !on || tt >= BLAST ? 0 : tt < HOLD ? 1 : 1 - smooth((tt - HOLD) / (BLAST - HOLD));
  const core = !on ? 0 : tt < HOLD * 0.8 ? 1 : Math.exp(-(tt - HOLD * 0.8) / 26);
  out.core = core > 0.02 ? core : 0;
  out.light = !on || tt >= FLASH ? 0 : tt < HOLD ? 1 : Math.exp(-(tt - HOLD) / 45);
  out.ball = !on || tt >= FLASH ? 0 : 1 - smooth(ramp(tt, FLASH * 0.55, FLASH));
  out.cool = ramp(tt, BLAST * 0.8, FLASH);
  out.ballD = (4.6 + 2.4 * e) * fz;
  out.ballR = (3.3 + 1.3 * e) * fz;
  return out;
}

/**
 * A soft light pushed out along `aim` (an ellipse `long` times longer than it is wide, never a round lamp over the
 * hull) at (x, y), `r` across; `fire` picks the low warm light of a fire, otherwise the white light of a flash.
 */
function lightAlong(ctx: CanvasRenderingContext2D, x: number, y: number, aim: number, r: number, long: number, alpha: number, fire: boolean): void {
  ctx.translate(x, y);
  ctx.rotate(aim);
  ctx.scale(long, 1);
  if (fire) fireLight(ctx, 0, 0, r, alpha);
  else glow(ctx, 0, 0, r, alpha);
  ctx.scale(1 / long, 1);
  ctx.rotate(-aim);
  ctx.translate(-x, -y);
}

function drawMuzzle(ctx: CanvasRenderingContext2D, f: MuzzleDraw, m: MotionParams): void {
  // ms on a flashTime-1 clock, so a longer flashTime plays the same flash slower
  const tt = f.t * (FLASH + SMOKE * m.muzzleSmoke);
  if (tt < 0 || f.t >= 1) return;
  const U = flashUnit(f.scale, f.zoom);
  // at mid zoom (map scale 1) the ships are a few px across: the flash stays a short cone out of the bow about a beam
  // wide, its ball smaller and no light round it over the hull
  const mid = f.scale <= 1;
  const fz = m.flashSize;
  const c = Math.cos(f.aim);
  const s = Math.sin(f.aim);
  const nx = -s;
  const ny = c;
  const seed = Math.floor(f.seed * 613) + 3;
  const fs = flashState(tt, m);
  // the blast is never the same two frames running while it holds: its tongues, tips and core flicker (+-15%) at
  // the same strength
  const fr = Math.floor(tt / FRAME);
  const jit = (i: number): number => (tt < BLAST ? 0.85 + 0.3 * rnd(seed * 7 + fr, i) : 1);
  const prev = ctx.globalAlpha;
  const prevS = ctx.imageSmoothingEnabled;
  ctx.imageSmoothingEnabled = true;
  // the muzzles, a little out from the gun along the line of fire
  const mx = f.x + c * U * 1.1;
  const my = f.y + s * U * 1.1;

  // the blast slapping the water round the gun: an uneven ring of low spray thrown out, most of it on the firing
  // side, each puff flattened along the water (never a tidy fan of balls, never a drawn ring); close up only
  if (m.recoil > 0 && tt < WATER && !mid) {
    const q = tt / WATER;
    const n = 6 + (seed % 2);
    const ql = easeOut(q);
    const fade = 0.5 * m.recoil * (1 - q) * (1 - q);
    for (let i = 0; i < n; i++) {
      // spread round the gun, bunched toward the line of fire, each a little off its place
      const u = i / (n - 1) - 0.5;
      const a = f.aim + u * Math.abs(u) * 3 + (rnd(seed, i + 70) - 0.5) * 0.3;
      const reach = 0.55 + 0.75 * rnd(seed, i + 80) * (1 - Math.abs(u));
      const d = U * (3 + 5.4 * reach * ql) * (0.8 + 0.2 * fz);
      const r = U * (0.9 + 0.7 * rnd(seed, i + 90)) * (1 + 1.3 * q);
      const x = mx + Math.cos(a) * d;
      const y = my + Math.sin(a) * d;
      ctx.translate(x, y);
      ctx.rotate(a);
      ctx.scale(0.55, 1);
      puff(ctx, Puff.SPRAY, i, 0, 0, r, fade * (0.6 + 0.4 * rnd(seed, i + 100)));
      ctx.scale(1 / 0.55, 1);
      ctx.rotate(-a);
      ctx.translate(-x, -y);
    }
  }

  // the light of the blast on the water and the deck, lying out ahead of the gun along the line of fire: strong while
  // the blast holds, gone with the ball of fire (close up only)
  if (fs.light > 0 && !mid) {
    const lr = U * 6 * fz;
    lightAlong(ctx, mx + c * U * 5, my + s * U * 5, f.aim, lr, 1.7, 0.5 * fs.light, true);
  }

  // gun smoke: shoved out of the ball of fire along the line of fire from each barrel, slowing, swelling a little,
  // rising and drifting off with the wind as it thins; kept smaller than the ship under it so a fleet stays clear
  const smokeT = SMOKE * m.muzzleSmoke + FLASH * 0.45;
  if (m.muzzleSmoke > 0 && tt > 30) {
    const Us = boldUnit(f.scale, f.zoom) * (mid ? 0.5 : 0.7);
    const n = Math.max(4, Math.round(3 + 2.5 * m.muzzleSmoke));
    // lit from inside by the fire for a moment
    const lit = 1 - ramp(tt, FLASH * 0.6, FLASH * 1.2);
    for (let i = n - 1; i >= 0; i--) {
      const t0 = 30 + i * 16;
      const q = clamp01((tt - t0) / smokeT);
      if (q <= 0 || q >= 1) continue;
      const lane = ((i % BARRELS) - 1) * GAP * Us;
      const push = Us * (3.4 + i * 1.5) * fz * easeOut3(Math.min(1, q * 2.4));
      const drift = Us * 8 * Math.pow(q, 1.3);
      const rise = Us * 2.8 * q;
      const r = Us * (1.4 + 0.3 * i) * (0.55 + 1.35 * easeOut(q)) * (0.7 + 0.3 * fz);
      const x = mx + c * push + nx * lane * (1 + q) + WIND_X * drift;
      const y = my + s * push + ny * lane * (1 + q) + WIND_Y * drift - rise;
      // thinning as it drifts: gone well before its time is up
      const a = 0.62 * ramp(q, 0, 0.06) * Math.pow(1 - q, 1.9);
      if (lit > 0 && i < 3) puff(ctx, Puff.EMBER, i, x, y, r * 0.8, 0.55 * lit * a);
      // sooty as it leaves the fire, then the brown-grey of cordite smoke
      const kind = q < 0.12 && i < 2 ? Puff.DARK : i % 3 === 1 ? Puff.DUST : Puff.GREY;
      puff(ctx, kind, i + seed, x, y, r, a);
    }
  }

  // the neck of the blast: a tongue of fire out of each barrel (the barrels go off a few ms apart, in their own order
  // each turret), close together and overlapping, uneven in length, each bursting out wider at its tip than at its
  // neck (no side jets: naval guns have no muzzle brakes, and two of them read as an arrowhead at the muzzle) and a
  // ragged cone over them fusing them, longest and brightest at once, flickering a few frames, then drawn back into
  // the ball
  if (tt < BLAST) {
    for (let b = 0; b < BARRELS; b++) {
      const tb = tt - ((b + seed) % BARRELS) * 5;
      if (tb < 0) continue;
      const kb = tb < HOLD ? 0 : clamp01((tb - HOLD) / (BLAST - 20 - HOLD));
      const Ab = 1 - smooth(kb);
      if (Ab <= 0.01) continue;
      const lane = (b - 1) * GAP_FIRE * U;
      const main = b === 1 ? 1 : 0.62 + 0.3 * rnd(seed, b + 20);
      const Lb = U * 8 * fz * main * jit(b) * (0.82 + 0.18 * clamp01(tb / 6)) * (1 - 0.6 * easeOut(kb));
      const Wb = U * 2.6 * fz * main * (0.85 + 0.5 * kb);
      // each a little off the others' line (never parallel), but never a splayed claw
      const ba = f.aim + (b - 1) * 0.06 + (rnd(seed, b + 7) - 0.5) * 0.08;
      const cb = Math.cos(ba);
      const sb = Math.sin(ba);
      const bx = mx + nx * lane;
      const by = my + ny * lane;
      // a new ragged edge each frame
      const v = seed + b + fr;
      flame(ctx, Flame.BOLT, false, v, bx, by, ba, Lb, Wb, Ab);
      // the white-hot heart of the outer ones only close up (at mid zoom the cone's heart covers them)
      if (b === 1 || !mid) flame(ctx, Flame.BOLT, true, v, bx, by, ba, Lb * 0.9, Wb * 0.85, Ab * (1 - smooth(kb * 1.4)));
      // the burst at the tip: a ragged knot of fire wider than the neck
      const tip = Lb * (0.7 + 0.08 * jit(b + 4));
      const tr = Wb * (0.7 + 0.25 * main) * jit(b + 8);
      puffTurned(ctx, Puff.FIRE, v + 2, bx + cb * tip, by + sb * tip, tr, Ab * 0.95, fr * 1.3 + b);
    }
    const k = tt < HOLD ? 0 : (tt - HOLD) / (BLAST - HOLD);
    const L = U * 7 * fz * jit(12) * (1 - 0.4 * easeOut(k));
    const W = U * 5 * fz * (0.85 + 0.35 * k);
    const A = fs.blast;
    flame(ctx, Flame.CONE, false, seed + 5 + fr, mx, my, f.aim, L, W, 0.75 * A);
    flame(ctx, Flame.BOLT, true, seed + 5 + fr, mx, my, f.aim, L * 0.85, W * 0.8, A * (1 - smooth(k * 1.6)));
  }

  // the ball of fire: the blast ballooning out at the end of the neck from the first frame, then rolling on along the
  // line of fire as the blast dies, two lobes off each other's centre (never a clean round ball), cooling from yellow
  // through orange to a dull red inside the smoke
  if (fs.ball > 0) {
    const cool = fs.cool;
    const a = fs.ball;
    const d = U * fs.ballD;
    const r = U * fs.ballR * (mid ? MID_BALL : 1) * jit(14);
    const off = (rnd(seed, 3) - 0.5) * 1.4 * U * fz * (mid ? 0.5 : 1);
    const x1 = mx + c * d + nx * off;
    const y1 = my + s * d + ny * off;
    const x2 = mx + c * (d + r * 0.5) - nx * off * 0.8;
    const y2 = my + s * (d + r * 0.5) - ny * off * 0.8;
    // white hot while the blast holds: a light pushed out along the line of fire, not a halo round the gun
    if (fs.blast > 0 && !mid) lightAlong(ctx, mx + c * (d + r * 0.3), my + s * (d + r * 0.3), f.aim, r * 1.25, 1.5, 0.5 * fs.blast, false);
    if (cool < 1) {
      puffTurned(ctx, Puff.FIRE, seed, x1, y1, r, a * (1 - cool), fr * 0.7);
      puff(ctx, Puff.FIRE, seed + 1, x2, y2, r * 0.75, 0.9 * a * (1 - cool));
    }
    if (cool > 0) {
      puff(ctx, Puff.EMBER, seed, x1, y1, r * 1.04, 0.95 * a * cool);
      puff(ctx, Puff.EMBER, seed + 1, x2, y2, r * 0.78, 0.8 * a * cool);
    }
  }

  // the white-hot core at the muzzles, drawn out along the line of fire into the ball: blinding while the blast holds,
  // its size flickering frame to frame
  const core = fs.core;
  if (core > 0) {
    const cj = jit(16);
    const cx = mx + c * U * 2.4;
    const cy = my + s * U * 2.4;
    ctx.translate(cx, cy);
    ctx.rotate(f.aim);
    ctx.scale(1.9, 0.75);
    if (!mid) glow(ctx, U * 0.6, 0, U * 2.6 * fz * cj, 0.5 * core);
    flashOver(ctx, 0, 0, U * 2.4 * fz * cj, core);
    flashOver(ctx, U * 1.6, 0, U * 1.8 * fz * jit(17), core * 0.85);
    ctx.scale(1 / 1.9, 1 / 0.75);
    ctx.rotate(-f.aim);
    ctx.translate(-cx, -cy);
  }
  ctx.globalAlpha = prev;
  ctx.imageSmoothingEnabled = prevS;
}

/** Points of a shell's trail along its arc, reused (nothing allocated per frame). */
const TRAIL_N = 6;
const trailX = new Float64Array(TRAIL_N + 1);
const trailY = new Float64Array(TRAIL_N + 1);

/**
 * The trail's points from `i0` to the head as one filled wedge, `w0` wide at its tail and `w1` at the head: it tapers
 * to nothing behind, so it reads as fire streaming off the shell, never a hose of even width.
 */
function fillWedge(ctx: CanvasRenderingContext2D, i0: number, w0: number, w1: number): void {
  const n = TRAIL_N - i0;
  ctx.beginPath();
  for (let side = 1; side >= -1; side -= 2) {
    for (let j = 0; j <= n; j++) {
      const i = side > 0 ? i0 + j : TRAIL_N - j;
      const a = i > i0 ? i - 1 : i0;
      const b = i < TRAIL_N ? i + 1 : TRAIL_N;
      const tx = trailX[b] - trailX[a];
      const ty = trailY[b] - trailY[a];
      const tl = Math.hypot(tx, ty) || 1;
      const hw = (0.5 * (w0 + (w1 - w0) * ((i - i0) / n)) * side) / tl;
      const x = trailX[i] - ty * hw;
      const y = trailY[i] + tx * hw;
      if (side > 0 && j === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
  }
  ctx.closePath();
  ctx.fill();
}

function drawShell(ctx: CanvasRenderingContext2D, sh: ShellDraw, m: MotionParams): void {
  const { x0, y0, x1, y1, t } = sh;
  if (t < 0 || t > 1) return;
  const dist = Math.hypot(x1 - x0, y1 - y0);
  const u = unitPx(sh.zoom);
  const prev = ctx.globalAlpha;
  const prevS = ctx.imageSmoothingEnabled;
  ctx.lineCap = 'round';
  if (sh.kind === 'torpedo') drawTorpedo(ctx, sh, dist, u);
  else if (sh.kind === 'tracer') drawTracer(ctx, sh, dist, u);
  else {
    // a cannon shell: lifted up the screen with height along its arc
    const H = Math.min(80, dist * 0.24) * m.shellArc;
    const ax = x1 - x0;
    const ay = y1 - y0;
    const lift = 4 * t * (1 - t);
    const look = shellLook(sh.scale);
    const near = sh.scale > 1;
    // a little bigger at the top of its arc, nearer the eye
    const rh = look.head * (1 + 0.3 * lift * Math.min(1, m.shellArc));
    // its flight starts at the ship's middle while the flash is at the turret: it shows once it is out past the ball
    // of fire (on a short shot, after the first part of its flight), and nothing of it, trail or smoke, ever reaches
    // back behind that point onto the ship
    const qc = shellClear(sh.scale, dist, m, sh.zoom);
    const show = ramp(t, qc, qc + Math.max(0.05, (5 + 4 * sh.scale) / Math.max(1, dist)));
    if (show > 0) {
      ctx.imageSmoothingEnabled = true;
      const room = t - qc;
      // the trail of fire along the arc behind the head (its tail grows out of the visible start, never behind it)
      const dq = Math.min(room, look.trail / Math.max(1, dist));
      for (let i = 0; i <= TRAIL_N; i++) {
        const q = t - dq * (1 - i / TRAIL_N);
        trailX[i] = x0 + ax * q;
        trailY[i] = y0 + ay * q - 4 * H * q * (1 - q);
      }
      const px = trailX[TRAIL_N];
      const py = trailY[TRAIL_N];
      // which way it is flying on screen (the arc's tangent)
      const ang = Math.atan2(ay - 4 * H * (1 - 2 * t), ax);
      if (near) {
        // its shadow close to the water or the ground: a faint short streak along its track, only near launch and
        // landing (high up it is too far below to belong to it)
        const low = Math.pow(1 - lift, 3);
        if (low > 0.05) {
          const gx = x0 + ax * t;
          const gy = y0 + ay * t;
          const bq = Math.max(qc, t - dq * 0.6);
          ctx.globalAlpha = prev * 0.15 * show * low;
          ctx.strokeStyle = '#0a0c0e';
          ctx.lineWidth = rh * 0.9;
          ctx.beginPath();
          ctx.moveTo(x0 + ax * bq, y0 + ay * bq);
          ctx.lineTo(gx, gy);
          ctx.stroke();
        }
        // a thread of smoke behind the fire: a few small overlapping puffs growing, thinning and drifting off with
        // the wind behind it (never a drawn line, never a row of dots)
        const step = (rh * 1.3) / Math.max(1, dist);
        ctx.globalAlpha = prev * show;
        for (let j = 0; j < 5; j++) {
          const q = t - dq - step * (j + 0.4);
          if (q < qc) break;
          const w = j * rh * 0.35;
          const sx = x0 + ax * q + WIND_X * w;
          const sy = y0 + ay * q - 4 * H * q * (1 - q) + WIND_Y * w;
          puffTurned(ctx, Puff.GREY, Math.floor(sh.seed * 50) + j, sx, sy, rh * (1.1 + 0.5 * j), 0.24 * (1 - j / 5) * ramp(q, qc, qc + step * 2), j * 1.7);
        }
      }
      ctx.globalAlpha = prev * show;
      // the trail of fire, tapering to nothing behind: a deep orange skin fading out behind (the one gradient), then
      // a yellow-white heart over its last part up to the head
      const g = ctx.createLinearGradient(trailX[0], trailY[0], px, py);
      g.addColorStop(0, 'rgba(176,74,28,0)');
      g.addColorStop(0.45, 'rgba(220,116,38,0.5)');
      g.addColorStop(1, 'rgba(246,165,62,0.95)');
      ctx.fillStyle = g;
      fillWedge(ctx, 0, 0, rh * 2.1);
      ctx.fillStyle = 'rgba(255,236,190,0.9)';
      fillWedge(ctx, 3, 0, rh * 1.1);
      // the glow round the head, drawn out along its flight (never a round halo), and the small white-hot head
      ctx.translate(px, py);
      ctx.rotate(ang);
      ctx.scale(1.7, 1);
      glow(ctx, -rh * 0.35, 0, rh * 2.5, 0.55 * show);
      ctx.scale(1 / 1.7, 1);
      ctx.rotate(-ang);
      ctx.translate(-px, -py);
      ctx.fillStyle = '#fff4d6';
      ctx.beginPath();
      ctx.arc(px, py, rh, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.globalAlpha = prev;
  ctx.lineCap = 'butt';
  ctx.imageSmoothingEnabled = prevS;
}

/** Anti-air fire: bursts of short red-orange streaks racing up at the plane, a little scattered. */
function drawTracer(ctx: CanvasRenderingContext2D, sh: ShellDraw, dist: number, u: number): void {
  const { x0, y0, x1, y1, t } = sh;
  const prev = ctx.globalAlpha;
  const nx = -(y1 - y0) / Math.max(1, dist);
  const ny = (x1 - x0) / Math.max(1, dist);
  for (let i = 0; i < 5; i++) {
    const q = t - i * 0.09;
    if (q < 0 || q > 1) continue;
    const j = (rnd(sh.seed * 50, i) - 0.5) * u * 0.8 * (1 - q);
    const px = x0 + (x1 - x0) * q + nx * j;
    const py = y0 + (y1 - y0) * q + ny * j;
    const back = Math.min(0.08, q);
    const bx = x0 + (x1 - x0) * (q - back) + nx * j;
    const by = y0 + (y1 - y0) * (q - back) + ny * j;
    ctx.globalAlpha = prev * 0.9;
    ctx.strokeStyle = 'rgba(255,120,60,0.55)';
    ctx.lineWidth = Math.max(1.4, u * 0.3);
    ctx.beginPath();
    ctx.moveTo(bx, by);
    ctx.lineTo(px, py);
    ctx.stroke();
    ctx.strokeStyle = '#ffe2a0';
    ctx.lineWidth = Math.max(0.7, u * 0.12);
    ctx.stroke();
  }
  ctx.globalAlpha = prev;
}

/** A torpedo: a line of bubbles drawn out behind a dark shape running just under the surface. */
function drawTorpedo(ctx: CanvasRenderingContext2D, sh: ShellDraw, dist: number, u: number): void {
  const { x0, y0, x1, y1, t } = sh;
  const prev = ctx.globalAlpha;
  const hx = x0 + (x1 - x0) * t;
  const hy = y0 + (y1 - y0) * t;
  const g = ctx.createLinearGradient(x0, y0, hx, hy);
  g.addColorStop(0, 'rgba(230,242,246,0)');
  g.addColorStop(0.7, 'rgba(230,242,246,0.35)');
  g.addColorStop(1, 'rgba(250,253,254,0.85)');
  ctx.strokeStyle = g;
  ctx.lineWidth = Math.max(1, u * 0.28);
  ctx.beginPath();
  ctx.moveTo(x0 + (hx - x0) * 0.15, y0 + (hy - y0) * 0.15);
  ctx.lineTo(hx, hy);
  ctx.stroke();
  ctx.fillStyle = 'rgba(245,250,252,0.8)';
  const n = Math.min(14, Math.floor((dist * t) / Math.max(3, u * 0.7)));
  for (let i = 0; i < n; i++) {
    const q = t - (i + 1) * (Math.max(3, u * 0.7) / Math.max(1, dist));
    if (q < 0) break;
    const r = Math.max(0.5, u * 0.09 * (1 + (i % 3) * 0.4));
    const j = (rnd(sh.seed * 100, i) - 0.5) * u * 0.3;
    ctx.globalAlpha = prev * (1 - i / 14);
    ctx.beginPath();
    ctx.arc(x0 + (x1 - x0) * q - ((y1 - y0) / dist) * j, y0 + (y1 - y0) * q + ((x1 - x0) / dist) * j, r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = prev * 0.85;
  ctx.fillStyle = '#1d2427';
  ctx.beginPath();
  ctx.ellipse(hx, hy, Math.max(1.5, u * 0.45), Math.max(0.6, u * 0.1), Math.atan2(y1 - y0, x1 - x0), 0, Math.PI * 2);
  ctx.fill();
  ctx.globalAlpha = prev;
}

export const realisticCannon: CannonArt = { flashMs, drawMuzzle, drawShell };
