// The detailed style's cruise missile (client only; the sim flies it straight from the ship, units.ts): its own
// launch, drawn as a visual offset over the first part of the sim's flight so it still lands when the sim's does.
//   1. pop-up   it rises straight up out of the ship's deck cell on its booster: a white-hot flash and a smoke puff
//               at the ship
//   2. pitch    it climbs a little more and pitches over toward the target (90, 60 and 30 degrees, then level)
//   3. unfold   level now, its small wings and tail fins swing out (folded, half, out) as it settles to cruise height;
//               the spent booster drops away with a small puff and tumbles into the sea
//   4. cruise   low and level along the route, a small flickering exhaust and a short trail of puffs
//   5. dive     over the target it noses down (25 and 50 degrees) onto it
// Models are parts like every unit of the style (models.ts, bake.ts), baked per stage, heading and resolution into
// this file's atlas; the ground shadow is the bake's own silhouette. All timing comes from the CruiseDraw clock, so
// the art never reads the game state. Seen from far out (the shared far icons) it is a plain small missile.
import type { MotionParams } from '../motion';
import { canBake, SpriteAtlas, type AtlasEntry } from '../shared/atlas';
import type { CruiseDraw } from '../types';
import { rasterize, shadowOf, type Model, type Part } from './bake';
import { drawBlob } from './blobs';
import { facingIndex, facingsFor, gridOf, type Grid } from './grid';
import { FIRE } from './palette';
import { box, ell, poly, sym } from './shapes';

// ------------------------------------------------------------------------------------------------- the timeline

/** Phase lengths (ms at a full-length flight; a short flight squeezes them, see cruisePhase). */
export const CRUISE_TIMES = { pop: 380, pitch: 360, unfold: 360, dive: 360, puff: 800, boosterFall: 560 } as const;
/** Heights over the ground in model units (screen px at mid zoom per spriteScale step). */
const ALT = { deck: 1, top: 9, cruise: 3.6 } as const;

/** One of the baked looks (the stages below), and its pitch in degrees (90 = straight up, negative = nose down). */
export const CRUISE_STAGES = [
  { pitch: 90, wings: 0, booster: true },
  { pitch: 60, wings: 0, booster: true },
  { pitch: 30, wings: 0, booster: true },
  { pitch: 0, wings: 0, booster: true },
  { pitch: 0, wings: 0.5, booster: true },
  { pitch: 0, wings: 1, booster: true },
  { pitch: 0, wings: 1, booster: false },
  { pitch: -25, wings: 1, booster: false },
  { pitch: -50, wings: 1, booster: false },
] as const;

export interface CruisePhase {
  /** index into CRUISE_STAGES */
  stage: number;
  /** height over the ground (model units) */
  alt: number;
  /** how far along its own route the drawn missile is, against the sim's (0 = still over the ship, 1 = where the sim has it) */
  lag: number;
  /** ms since the booster fell (< 0: still on) */
  dropMs: number;
  /** the phase's name, for the art lab and the tests */
  name: 'pop-up' | 'pitch' | 'unfold' | 'cruise' | 'dive';
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
const smooth = (v: number): number => {
  const t = clamp01(v);
  return t * t * (3 - 2 * t);
};

/**
 * Where the launch stands `e` ms after it and `left` ms before impact. A flight of 1.5 s and more gets the whole
 * timeline; a shorter one squeezes every phase by the same factor, so a short shot still shows each step.
 */
export function cruisePhase(e: number, left: number): CruisePhase {
  const total = Math.max(1, e + left);
  const k = Math.min(1, total / 1500);
  const pop = CRUISE_TIMES.pop * k;
  const pitch = CRUISE_TIMES.pitch * k;
  const unfold = CRUISE_TIMES.unfold * k;
  const dive = CRUISE_TIMES.dive * k;
  const lead = pop + pitch + unfold;
  const lag = smooth((e - pop * 0.6) / (lead - pop * 0.6));
  const dropMs = e - lead;
  if (left <= dive) {
    const d = clamp01(1 - left / dive);
    return { stage: d < 0.45 ? 7 : 8, alt: ALT.cruise * (1 - d), lag: 1, dropMs, name: 'dive' };
  }
  if (e < pop) {
    const t = clamp01(e / pop);
    return { stage: 0, alt: ALT.deck + (ALT.top - 1.5 - ALT.deck) * (1 - (1 - t) * (1 - t)), lag, dropMs, name: 'pop-up' };
  }
  if (e < pop + pitch) {
    const t = clamp01((e - pop) / pitch);
    return { stage: t < 0.34 ? 1 : t < 0.67 ? 2 : 3, alt: ALT.top - 1.5 + 1.5 * t, lag, dropMs, name: 'pitch' };
  }
  if (e < lead) {
    const t = clamp01((e - pop - pitch) / unfold);
    return { stage: t < 0.34 ? 3 : t < 0.67 ? 4 : 5, alt: ALT.top + (ALT.cruise - ALT.top) * smooth(t), lag, dropMs, name: 'unfold' };
  }
  return { stage: 6, alt: ALT.cruise, lag: 1, dropMs, name: 'cruise' };
}

// ------------------------------------------------------------------------------------------------- models

/** Body length (nose to the tail, without the booster), the booster's length and the body radius (model units). */
const BODY = 7.6;
const BOOST = 2.6;
const RAD = 0.62;

/**
 * The missile at a pitch (degrees) with its wings `w` out (0 folded .. 1 out) and the booster on or off. Level, it is
 * a slim cylinder with an ogive nose, a dark owner band, small wings at mid-body and a cruciform tail; pitched, the
 * body is laid out as short round slices climbing along the axis (so it stands up off the deck in the 3/4 view).
 */
export function cruiseModel(pitch: number, w: number, booster: boolean): Model {
  const parts: Part[] = [];
  const tail = -BODY / 2;
  const nose = BODY / 2;
  if (pitch === 0) {
    const z = 0.6;
    const h = RAD * 2;
    const sc = [0, 0, BODY / 2 + 0.5, RAD] as const;
    if (w > 0) {
      // the wings swing out from under the body, swept back while unfolding
      const span = 0.8 + 1.7 * w;
      const sweep = 1.6 * (1 - w) + 0.35;
      parts.push(poly(sym([0.8, -RAD, 0.8 - sweep, -span, -0.2 - sweep, -span, -0.6, -RAD]), z + 0.2, 0.25, 'sup', { tone: -1 }));
      // tail fins (a cross: the side pair flat, the top one standing)
      const fs = 0.4 + 0.9 * w;
      parts.push(poly(sym([tail + 1.3, -RAD, tail + 0.2, -RAD - fs, tail - 0.1, -RAD - fs, tail + 0.1, -RAD]), z + 0.1, 0.2, 'sup', { tone: -1 }));
      parts.push(box(tail - 0.1, -0.18, tail + 1.2, 0.18, z + h, 0.6 + 0.9 * w, 'sup', { tone: -1 }));
    }
    if (booster) {
      parts.push(box(tail - BOOST, -RAD - 0.08, tail, RAD + 0.08, z - 0.05, h + 0.1, 'fieldgrey', { sh: 'cyl', sc: [tail - BOOST / 2, 0, BOOST / 2, RAD + 0.08] }));
      parts.push(box(tail - BOOST - 0.4, -0.5, tail - BOOST, 0.5, z, h * 0.8, 'gun'));
    } else {
      parts.push(box(tail - 0.45, -0.42, tail, 0.42, z + 0.15, h * 0.7, 'gun'));
    }
    parts.push(box(tail, -RAD, nose - 1.6, RAD, z, h, 'sup', { sh: 'cyl', sc }));
    parts.push(box(-0.9, -RAD - 0.02, -0.3, RAD + 0.02, z, h + 0.02, 'own', { sh: 'cyl', sc }));
    parts.push(poly([nose + 0.3, 0, nose - 0.6, -RAD * 0.75, nose - 1.6, -RAD, nose - 1.6, RAD, nose - 0.6, RAD * 0.75], z, h, 'sup', { sh: 'cyl', sc: [nose - 0.8, 0, 1.1, RAD] }));
    parts.push(ell(nose - 0.2, 0, 0.4, 0.3, z + 0.1, h * 0.8, 'gun'));
    return { parts, ground: 0 };
  }
  // pitched: slices along the axis s (tail to nose), u = s cos p, z = s sin p + lift so the lowest point sits on 0
  const p = (pitch * Math.PI) / 180;
  const c = Math.cos(p);
  const sn = Math.sin(p);
  const s0 = booster ? tail - BOOST : tail;
  const lift = Math.max(0, -Math.min(s0 * sn, nose * sn)) + 0.2;
  const step = 0.55;
  const slice = (s: number, r: number, m: Part['m'], tone = 0): void => {
    const u = s * c;
    const z = s * sn + lift;
    parts.push(ell(u, 0, Math.max(0.35, r * Math.max(0.55, Math.abs(sn))), r, z - r * c * 0.5, Math.max(0.5, r * 2 * c + step * Math.abs(sn)), m, { sh: 'cyl', tone }));
  };
  if (booster) for (let s = s0; s < tail; s += step) slice(s, RAD + 0.08, 'fieldgrey');
  for (let s = tail; s < nose - 1.4; s += step) slice(s, RAD, s > -0.9 && s < -0.3 ? 'own' : 'sup');
  for (let s = nose - 1.4; s <= nose + 0.01; s += step) slice(s, RAD * (1 - ((s - (nose - 1.4)) / 1.6) * 0.75), s > nose - 0.4 ? 'gun' : 'sup');
  if (w > 0) {
    // a diving missile keeps its wings out: flat at mid body, shortened along the pitch
    const z = lift + 0.3;
    const span = 0.8 + 1.7 * w;
    parts.push(poly(sym([0.8 * c, -RAD, 0.45 * c, -span, -0.25 * c, -span, -0.6 * c, -RAD]), z, 0.25, 'sup', { tone: -1 }));
  }
  return { parts, ground: 0 };
}

const models: (Model | undefined)[] = [];
function stageModel(i: number): Model {
  let m = models[i];
  if (!m) {
    const s = CRUISE_STAGES[i];
    models[i] = m = cruiseModel(s.pitch, s.wings, s.booster);
  }
  return m;
}

/** The spent booster tumbling down: a short dark can. */
const BOOSTER_MODEL: Model = { parts: [box(-BOOST / 2, -RAD - 0.08, BOOST / 2, RAD + 0.08, 0.3, RAD * 2, 'fieldgrey', { sh: 'cyl', sc: [0, 0, BOOST / 2, RAD + 0.08] })], ground: 0 };

// ------------------------------------------------------------------------------------------------- baking

const atlas = new SpriteAtlas(512, 4);
const ownerKey = (o: readonly number[]): number => ((o[0] & 255) << 16) | ((o[1] & 255) << 8) | (o[2] & 255);

function baked(stage: number, facing: number, n: number, res: number, owner: readonly number[], shadow: boolean): AtlasEntry | null {
  const key = `c${stage}|${facing}|${n}|${Math.round(res * 4)}|${shadow ? 0 : ownerKey(owner)}|${shadow ? 1 : 0}`;
  const hit = atlas.peek(key);
  if (hit !== undefined) return hit;
  if (!canBake()) return null;
  return atlas.get(key, () => {
    const model = stage < 0 ? BOOSTER_MODEL : stageModel(stage);
    const b = rasterize(model, res, facing, { facings: n, owner: shadow ? [0, 0, 0] : owner });
    return shadow ? shadowOf(b) : b;
  });
}

function blit(ctx: CanvasRenderingContext2D, e: AtlasEntry, x: number, y: number, k: number, dpr: number): void {
  const X = Math.round(x * dpr) / dpr - e.ox * k;
  const Y = Math.round(y * dpr) / dpr - e.oy * k;
  ctx.drawImage(e.page, e.sx, e.sy, e.w, e.h, X, Y, e.w * k, e.h * k);
}


/** One square cell of colour on the grid (CSS px centre, `size` cells wide). */
function cell(ctx: CanvasRenderingContext2D, x: number, y: number, g: Grid, size = 1): void {
  const s = g.p * size;
  ctx.fillRect((Math.round((x * g.dpr) / g.p) * g.p - (size > 1 ? Math.floor(s / 2) : 0)) / g.dpr, (Math.round((y * g.dpr) / g.p) * g.p - (size > 1 ? Math.floor(s / 2) : 0)) / g.dpr, s / g.dpr, s / g.dpr);
}

// ------------------------------------------------------------------------------------------------- drawing

/**
 * Draws the cruise missile of `c` (see the file comment). The body sits `alt` model units over its ground point (the
 * screen y lifted), the shadow on the ground off to the lower right like a plane's.
 */
export function drawCruise(ctx: CanvasRenderingContext2D, c: CruiseDraw, m: MotionParams): boolean {
  const g = gridOf(c.scale, c.dpr);
  const ph = cruisePhase(c.elapsedMs, c.leftMs);
  const n = facingsFor(g.res);
  const facing = facingIndex(c.angle, n);
  const body = baked(ph.stage, facing, n, g.res, c.owner, false);
  if (!body) return false;
  const shadow = baked(ph.stage, facing, n, g.res, c.owner, true);
  const S = c.scale;
  // the drawn ground point lags behind the sim's while it climbs off the ship (a visual offset only)
  const gx = c.sx + (c.x - c.sx) * ph.lag;
  const gy = c.sy + (c.y - c.sy) * ph.lag;
  const still = m.reduced;
  const bob = !still && ph.name === 'cruise' ? Math.sin(c.timeMs / 260 + c.seed) * 0.35 : 0;
  const alt = ph.alt + bob;
  const prevA = ctx.globalAlpha;
  const prevS = ctx.imageSmoothingEnabled;
  ctx.imageSmoothingEnabled = false;
  ctx.globalAlpha = prevA * c.alpha;
  const cos = Math.cos(c.angle);
  const sin = Math.sin(c.angle);
  // launch: the booster's white-hot flash in the deck cell, then a smoke puff rolling off the ship
  const e = c.elapsedMs;
  const puffMs = CRUISE_TIMES.puff * (still ? 0.6 : 1);
  if (e < puffMs) {
    const t = e / puffMs;
    if (t < 0.35) drawBlob(ctx, 'flash', (1.8 - t * 2.5) * g.res * S * 0.6, 0, c.sx, c.sy - S, g, (1 - t / 0.35) * 0.95);
    for (let i = 0; i < 3; i++) {
      const a = c.seed * 1.7 + i * 2.1;
      const d = (0.6 + t * 2.4) * S * (0.6 + 0.3 * i);
      drawBlob(ctx, i === 0 ? 'vapour' : 'smoke', (1.2 + t * 2.4) * g.res * S * 0.45, i & 3, c.sx + Math.cos(a) * d, c.sy + Math.sin(a) * d * 0.6 - t * 2 * S, g, (1 - t) * (0.8 - 0.15 * i));
    }
  }
  // the booster falling away: a small puff where it parts, the can tumbling down and fading
  if (ph.dropMs >= 0 && ph.dropMs < CRUISE_TIMES.boosterFall) {
    const t = ph.dropMs / CRUISE_TIMES.boosterFall;
    const back = (BODY / 2 + BOOST) * S;
    const bx = gx - cos * back * (1 + t * 0.6);
    const by = gy - sin * back * (1 + t * 0.6) - (ALT.cruise * (1 - t) + 0.5) * S * 0.8 + t * t * 4 * S;
    drawBlob(ctx, 'smoke', (0.9 + t * 1.6) * g.res * S * 0.45, 1, gx - cos * back * 0.8, gy - sin * back * 0.8 - ALT.cruise * S * 0.8, g, (1 - t) * 0.7);
    const can = baked(-1, facingIndex(c.angle + t * 3.2, n), n, g.res, c.owner, false);
    if (can) {
      ctx.globalAlpha = prevA * c.alpha * (1 - t * 0.8);
      blit(ctx, can, bx, by, g.k, g.dpr);
      ctx.globalAlpha = prevA * c.alpha;
    }
  }
  // the ground shadow, off to the lower right by the height (like a plane's)
  if (shadow) blit(ctx, shadow, gx + alt * 0.62 * S * 0.5, gy + alt * 0.86 * S * 0.5, g.k, g.dpr);
  const bx = gx;
  const by = gy - alt * S * 0.8;
  // cruising: a short trail of small exhaust puffs left behind along the route
  if (ph.name === 'cruise' || ph.name === 'dive') {
    const tail = (BODY / 2 + 0.6) * S;
    for (let i = 3; i >= 1; i--) {
      const d = tail + i * 1.6 * S;
      const age = ((c.timeMs / 120 + i + c.seed) % 3) / 3;
      drawBlob(ctx, 'vapour', (0.5 + i * 0.28) * g.res * S * 0.45, i & 3, bx - cos * d, by - sin * d + i * 0.15 * S, g, 0.5 - i * 0.12 - age * 0.08);
    }
  }
  blit(ctx, body, bx, by, g.k, g.dpr);
  // the motor: the booster's long flame while it burns, then the cruise engine's small flicker
  const flick = still ? 0 : Math.floor(c.timeMs / Math.max(20, m.flameMs) + c.seed) & 3;
  const st = CRUISE_STAGES[ph.stage];
  const p = (st.pitch * Math.PI) / 180;
  const back = (BODY / 2 + (st.booster ? BOOST + 0.4 : 0.45)) * S;
  // the nozzle on screen: behind along the heading, lower when the nose is up (the 3/4 view's lift)
  const nx = bx - cos * back * Math.cos(p);
  const ny = by - sin * back * Math.cos(p) * 0.84 + back * Math.sin(p) * 0.55;
  const len = (st.booster ? 3.2 : 1.3) + (flick & 1 ? 0.8 : 0);
  const steps = Math.max(2, Math.round(len * g.res));
  for (let i = steps; i >= 0; i--) {
    const q = i / steps;
    const d = (i / g.res) * S;
    const fx = nx - cos * d * Math.cos(p);
    const fy = ny - sin * d * Math.cos(p) * 0.84 + d * Math.sin(p) * 0.55;
    ctx.globalAlpha = prevA * c.alpha * (1 - q * 0.4);
    ctx.fillStyle = q < 0.2 ? '#fff6e0' : FIRE[Math.min(6, 1 + Math.floor(q * 4.5))];
    cell(ctx, fx, fy, g, Math.max(1, Math.round((1 - q * 0.7) * (st.booster ? 1.6 : 0.9) * g.res * 0.8)));
  }
  ctx.globalAlpha = prevA;
  ctx.imageSmoothingEnabled = prevS;
  return true;
}
