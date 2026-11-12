// The detailed style's units on the map and in portraits (client only). Each model (models.ts) is rasterized per
// heading (32 headings at near zoom, 16 at mid on a 1x screen), resolution, owner colour, upgrade set and, for planes,
// bank (bake.ts), never rotated as an image; each bake lands once in this style's atlas and is drawn with whole device
// pixels per art pixel (grid.ts), so the pixels stay square and crisp. What moves is drawn from the clock and the
// MotionParams numbers only:
//   ships     bob on the swell (bob, bobMs), out of step with each other (seed)
//   tanks     the turret traverses a little (turretSway, baked on its own at twice the headings), the hull shakes
//             while driving (jiggle), the track links turn, dust puffs from the track ends (treadDust)
//   planes    bank into turns (turnRate times bankPerTurn, up to bankMax), propellers show as a blur disc with a
//             flickering blade (propellers, propFps), jets glow at the nozzle, the ground shadow lies off by the
//             altitude and breathes with altitudeBob
//   missiles  a flickering exhaust flame (flameMs)
// Reduced motion keeps every unit still (no bob, sway, shake, bank or spin).
import type { MotionParams } from '../motion';
import { canBake, SpriteAtlas, type AtlasEntry } from '../shared/atlas';
import { hex } from '../shared/colour';
import { isAirKey, SPRITE_KEYS, unitCategoryOf, type SpriteKey } from '../shared/keys';
import type { PortraitDraw, UnitArt, UnitDraw } from '../types';
import { FORE, LIFT, rasterize, shadowOf, type Baked } from './bake';
import { drawBlob } from './blobs';
import { facingIndex, facingsFor, gridOf, type Grid } from './grid';
import { modelLength, modelSpan, MOD_MASK, unitModel, type UnitModel } from './models';
import { FIRE } from './palette';

const atlas = new SpriteAtlas(1024, 12);
const KEY_INDEX = new Map<SpriteKey, number>(SPRITE_KEYS.map((k, i) => [k, i]));

/** Bank angles a plane is baked at (each side), matched to the presets' largest banks. */
const BANKS = [0, 0.18, 0.4, 0.7];

/** Bake time per 16 ms of wall clock (ms): a screen of new sprites bakes over a few frames instead of one long one. */
const BAKE_MS = 7;
let bakeWindow = -1;
let bakeSpent = 0;
function bakeAllowed(): boolean {
  const now = typeof performance !== 'undefined' ? performance.now() : 0;
  const w = Math.floor(now / 16);
  if (w !== bakeWindow) {
    bakeWindow = w;
    bakeSpent = 0;
  }
  return bakeSpent < BAKE_MS;
}
function timed(make: () => Baked): Baked {
  const t0 = typeof performance !== 'undefined' ? performance.now() : 0;
  const b = make();
  if (typeof performance !== 'undefined') bakeSpent += performance.now() - t0;
  return b;
}

/** The roll (radians) of a bank level 0..6 (3 = level). */
function bankRoll(bank: number): number {
  return bank >= 3 ? BANKS[bank - 3] : -BANKS[3 - bank];
}

/** Layers of a unit in the atlas. */
const BODY = 0;
const TURRET = 1;
const SHADOW = 2;

function entryKey(key: SpriteKey, mods: number, facing: number, bank: number, frame: number, owner: readonly number[], res: number, layer: number): number {
  const o = layer === SHADOW ? 0 : ((owner[0] & 255) << 16) | ((owner[1] & 255) << 8) | (owner[2] & 255);
  return ((((((o * 32 + (KEY_INDEX.get(key) ?? 0)) * 32 + mods) * 64 + facing) * 8 + bank) * 2 + frame) * 32 + Math.round(res * 4)) * 4 + layer;
}

/**
 * The baked picture of one layer of a unit, or null when it cannot be baked now (no canvas, or this frame's bake
 * budget is spent).
 */
function entry(um: UnitModel, key: SpriteKey, mods: number, facing: number, n: number, bank: number, frame: number, owner: readonly number[], res: number, layer: number): AtlasEntry | null {
  const k = entryKey(key, mods, facing, bank, frame, owner, res, layer);
  const hit = atlas.peek(k);
  if (hit !== undefined) return hit;
  if (!canBake() || !bakeAllowed()) return null;
  const roll = bankRoll(bank);
  return atlas.get(k, () =>
    timed(() => {
      if (layer === TURRET && um.turret) return rasterize(um.turret.model, res, facing, { facings: n, owner });
      const b = rasterize(um.model, res, facing, { facings: n, owner: layer === SHADOW ? [0, 0, 0] : owner, roll: layer === SHADOW ? 0 : roll, tread: frame ? 0.7 : 0 });
      return layer === SHADOW ? shadowOf(b) : b;
    }),
  );
}

/** Draws an atlas entry with its origin at (x, y) CSS px, `k` CSS px per art px, on whole device px. */
function blit(ctx: CanvasRenderingContext2D, e: AtlasEntry, x: number, y: number, k: number, dpr: number): void {
  const X = Math.round(x * dpr) / dpr - e.ox * k;
  const Y = Math.round(y * dpr) / dpr - e.oy * k;
  ctx.drawImage(e.page, e.sx, e.sy, e.w, e.h, X, Y, e.w * k, e.h * k);
}

// ------------------------------------------------------------------------------------------------- propellers

/**
 * A propeller disc seen in the 3/4 view: the disc stands across the heading, so a plane flying east or west shows it
 * nearly edge-on and one flying north or south shows a flattened ellipse. A faint grey blur and one blade, at a
 * quarter turn per frame. Pure pixels, `rp` px radius at heading `th` (radians) with the bank's `roll`.
 */
function propBitmap(rp: number, th: number, roll: number, frame: number, strength: number): Baked {
  const ax = -Math.sin(th) * Math.cos(roll);
  const ay = Math.cos(th) * FORE * Math.cos(roll);
  const ux = 0;
  const uy = -LIFT;
  const half = Math.ceil(rp) + 1;
  const W = half * 2 + 1;
  const data = new Uint8ClampedArray(W * W * 4);
  const put = (px: number, py: number, c: readonly number[], a: number): void => {
    const x = Math.round(px) + half;
    const y = Math.round(py) + half;
    if (x < 0 || y < 0 || x >= W || y >= W) return;
    const o = (y * W + x) * 4;
    if (data[o + 3] >= a) return;
    data[o] = c[0];
    data[o + 1] = c[1];
    data[o + 2] = c[2];
    data[o + 3] = a;
  };
  const discA = Math.round(70 * strength);
  if (discA > 4) {
    for (let rr = 0; rr <= 1.0001; rr += 0.5 / Math.max(1, rp)) {
      for (let q = 0; q < Math.PI * 2; q += 0.5 / Math.max(1, rp)) {
        const cx = Math.cos(q) * rr * rp;
        const cy = Math.sin(q) * rr * rp;
        put(ax * cx + ux * cy, ay * cx + uy * cy, [196, 201, 204], rr > 0.8 ? discA + 20 : discA);
      }
    }
  }
  // one blade across the hub at this frame's angle (two blades seen as one bar)
  const b = (frame / 4) * Math.PI;
  const bladeA = Math.round(strength > 0 ? 200 - 110 * strength : 220);
  for (let t = -1; t <= 1.0001; t += 0.5 / Math.max(1, rp)) {
    const cx = Math.cos(b) * t * rp;
    const cy = Math.sin(b) * t * rp;
    put(ax * cx + ux * cy, ay * cx + uy * cy, [36, 40, 44], bladeA);
  }
  return { w: W, h: W, ox: half, oy: half, data };
}

function propEntry(rp: number, facing: number, n: number, bank: number, frame: number, strength: number): AtlasEntry | null {
  const R = Math.max(1, Math.min(30, Math.round(rp)));
  const s = Math.max(0, Math.min(4, Math.round(strength * 4)));
  const k = -((((((R * 64 + facing) * 2 + (n === 32 ? 1 : 0)) * 8 + bank) * 4 + frame) * 8 + s) + 1);
  const hit = atlas.peek(k);
  if (hit !== undefined) return hit;
  if (!canBake()) return null;
  const th = facing * ((Math.PI * 2) / n);
  return atlas.get(k, () => propBitmap(R, th, bankRoll(bank), frame, s / 4));
}

// ------------------------------------------------------------------------------------------------- drawing

const FIRE_RGB = FIRE.map(hex);

/** Screen offset (CSS px) of a model point at a baked heading and bank, at map scale `scale`. */
function project(u: number, v: number, z: number, th: number, roll: number, scale: number, flat: boolean): [number, number] {
  const vv = v * Math.cos(roll);
  const zz = z - v * Math.sin(roll) * 0.9;
  const c = Math.cos(th);
  const s = Math.sin(th);
  return [(u * c - vv * s) * scale, ((u * s + vv * c) * (flat ? 1 : FORE) - (flat ? 0 : zz * LIFT)) * scale];
}

/** The bank level (0..6, 3 = level) of a plane turning at `turnRate` rad/s. */
function bankLevel(turnRate: number, m: MotionParams): number {
  if (m.reduced) return 3;
  const b = Math.max(-m.bankMax, Math.min(m.bankMax, turnRate * m.bankPerTurn));
  const a = Math.abs(b);
  let best = 0;
  for (let i = 1; i < BANKS.length; i++) if (Math.abs(BANKS[i] - a) < Math.abs(BANKS[best] - a)) best = i;
  return 3 + (b < 0 ? -best : best);
}

/** One small square of colour on the art grid (CSS px centre). */
function cell(ctx: CanvasRenderingContext2D, x: number, y: number, g: Grid, size = 1): void {
  const s = g.p * size;
  ctx.fillRect((Math.round((x * g.dpr) / g.p) * g.p - (size > 1 ? Math.floor(s / 2) : 0)) / g.dpr, (Math.round((y * g.dpr) / g.p) * g.p - (size > 1 ? Math.floor(s / 2) : 0)) / g.dpr, s / g.dpr, s / g.dpr);
}

function drawAt(ctx: CanvasRenderingContext2D, u: UnitDraw, m: MotionParams, g: Grid): boolean {
  const key = u.key;
  const mods = u.mods & MOD_MASK[key];
  const um = unitModel(key, mods);
  const cat = unitCategoryOf(key);
  const n = facingsFor(g.res);
  const facing = facingIndex(u.angle, n);
  const th = facing * ((Math.PI * 2) / n);
  const t = u.timeMs;
  const still = m.reduced;
  const air = cat === 'air';
  const bank = air ? bankLevel(u.turnRate, m) : 3;
  const roll = bankRoll(bank);
  const moving = u.moving || u.speed > 0;
  const tank = cat === 'land';
  const frame = tank && moving && !still && g.res >= 1.6 ? Math.floor(t / 110) & 1 : 0;
  const body = entry(um, key, mods, facing, n, bank, frame, u.owner, g.res, BODY);
  if (!body) return false;
  let turret: AtlasEntry | null = null;
  let tFacing = 0;
  if (um.turret) {
    const sway = still ? 0 : m.turretSway * Math.sin(t / 1900 + u.seed * 1.37) * (0.6 + 0.4 * Math.sin(t / 830 + u.seed));
    tFacing = facingIndex(u.angle + sway, n * 2);
    turret = entry(um, key, mods, tFacing, n * 2, 3, 0, u.owner, g.res, TURRET);
    if (!turret) return false;
  }
  const shadow = isAirKey(key) && u.shadow ? entry(um, key, mods, facing, n, 3, 0, u.owner, g.res, SHADOW) : null;
  const k = g.k;
  const dpr = g.dpr;
  const prevA = ctx.globalAlpha;
  const prevS = ctx.imageSmoothingEnabled;
  ctx.imageSmoothingEnabled = false;
  if (u.alpha !== 1) ctx.globalAlpha = prevA * u.alpha;
  let x = u.x;
  let y = u.y;
  if (cat === 'ships' && !still && m.bob > 0) {
    // bob on the swell, out of step with the rest of the fleet
    y += m.bob * Math.sin((t / Math.max(400, m.bobMs)) * Math.PI * 2 + u.seed * 1.71) * u.scale * 0.5;
  }
  if (tank && moving && !still && m.jiggle > 0) {
    // the engine shaking the hull, a device px or so
    const j = Math.round(m.jiggle * u.scale * dpr * 0.6) / dpr;
    if ((Math.floor(t / 47 + u.seed) & 1) === 1) y -= j;
  }
  if (tank && moving && !still && m.treadDust > 0 && um.dust.length) drawTreadDust(ctx, u, um, m, g, th);
  if (shadow) {
    const alt = um.alt + (still ? 0 : m.altitudeBob * 1.6 * Math.sin(t / 1300 + u.seed * 0.9));
    blit(ctx, shadow, u.x + alt * 0.62 * u.scale, u.y + alt * 0.86 * u.scale, k, dpr);
  }
  blit(ctx, body, x, y, k, dpr);
  if (turret && um.turret) {
    const [px, py] = project(um.turret.u, um.turret.v, 0, th, 0, 1, false);
    blit(ctx, turret, x + px * u.scale, y + py * u.scale, k, dpr);
  }
  if (um.props.length) drawProps(ctx, u, um, m, g, facing, n, bank, th, roll, x, y);
  if (um.nozzles.length) drawNozzles(ctx, u, um, m, g, th, roll, x, y, cat === 'missiles');
  ctx.globalAlpha = prevA;
  ctx.imageSmoothingEnabled = prevS;
  return true;
}

function drawProps(ctx: CanvasRenderingContext2D, u: UnitDraw, um: UnitModel, m: MotionParams, g: Grid, facing: number, n: number, bank: number, th: number, roll: number, x: number, y: number): void {
  const still = m.reduced;
  const strength = still ? 0.25 : m.propellers;
  const frame = still ? 1 : Math.floor((u.timeMs * Math.max(1, m.propFps)) / 1000 + u.seed) & 3;
  for (const p of um.props) {
    const e = propEntry(p.r * g.res, facing, n, bank, frame, strength);
    if (!e) continue;
    const [dx, dy] = project(p.u, p.v, p.z, th, roll, u.scale, false);
    blit(ctx, e, x + dx, y + dy, g.k, g.dpr);
  }
}

function drawNozzles(ctx: CanvasRenderingContext2D, u: UnitDraw, um: UnitModel, m: MotionParams, g: Grid, th: number, roll: number, x: number, y: number, missile: boolean): void {
  const t = u.timeMs;
  const flick = m.reduced ? 0 : Math.floor(t / Math.max(20, m.flameMs) + u.seed) & 3;
  const c = Math.cos(th);
  const s = Math.sin(th);
  for (const z of um.nozzles) {
    const [dx, dy] = project(z.u, z.v, z.z, th, roll, u.scale, missile);
    const bx = x + dx;
    const by = y + dy;
    if (missile) {
      // the motor's flame: a white-hot root, then yellow, orange and a ragged red tip, flickering in length
      const len = (z.r * 3.2 + (flick & 1 ? 1.2 : 0) + (flick === 3 ? 0.8 : 0)) * g.res;
      const steps = Math.max(2, Math.round(len));
      for (let i = steps; i >= 0; i--) {
        const q = i / steps;
        const d = (i / g.res) * u.scale;
        const wob = (flick & 2 ? 0.3 : -0.3) * q;
        const px = bx - c * d - s * wob * u.scale;
        const py = by - s * d + c * wob * u.scale;
        ctx.globalAlpha = 1 - q * 0.35;
        ctx.fillStyle = q < 0.2 ? '#fff6e0' : `rgb(${FIRE_RGB[Math.min(6, 1 + Math.floor(q * 4.5))].join(',')})`;
        const w = Math.max(1, Math.round((1 - q * 0.7) * z.r * 2 * g.res * 0.8));
        cell(ctx, px, py, g, w);
      }
      ctx.globalAlpha = 1;
    } else {
      // a jet's nozzle glowing dull orange, brighter on alternate frames
      ctx.fillStyle = flick & 1 ? '#f6a53e' : '#dc7426';
      ctx.globalAlpha = 0.85;
      const d = 0.5 * u.scale;
      cell(ctx, bx - c * d, by - s * d, g, Math.max(1, Math.round(z.r * g.res * 0.9)));
      ctx.globalAlpha = 1;
    }
  }
}

/** Dust kicked up behind a moving tank's tracks: small puffs drifting back and fading (treadDust). */
function drawTreadDust(ctx: CanvasRenderingContext2D, u: UnitDraw, um: UnitModel, m: MotionParams, g: Grid, th: number): void {
  const t = u.timeMs;
  for (let i = 0; i < 3; i++) {
    const age = (t / 520 + i / 3 + u.seed * 0.37) % 1;
    for (const [du, dv] of um.dust) {
      const back = du - age * 5;
      const [dx, dy] = project(back, dv * (1 + age * 0.4), 0.5 + age * 1.5, th, 0, u.scale, false);
      const r = (0.8 + age * 1.8) * g.res * 0.8;
      drawBlob(ctx, 'dust', r, (i + Math.round(u.seed)) & 3, u.x + dx, u.y + dy, g, m.treadDust * 0.5 * (1 - age) * (1 - age));
    }
  }
}

// ------------------------------------------------------------------------------------------------- the UnitArt

/** Length of a unit along its heading in model units (screen px at mid zoom). */
export function detailedLength(key: SpriteKey, mods = 0): number {
  return modelLength(unitModel(key, mods & MOD_MASK[key]));
}

export const detailedUnits: UnitArt = {
  lengthPx(key, mods, scale) {
    return detailedLength(key, mods) * scale;
  },

  drawUnit(ctx: CanvasRenderingContext2D, u: UnitDraw, m: MotionParams): boolean {
    return drawAt(ctx, u, m, gridOf(u.scale, u.dpr));
  },

  /**
   * Fits the unit in `boxPx` device px of the portrait canvas (its length or span, whichever is larger): the largest
   * whole number of px per art pixel that keeps about two art pixels per model unit, the resolution filling the rest.
   */
  drawPortrait(ctx: CanvasRenderingContext2D, p: PortraitDraw): boolean {
    const um = unitModel(p.key, p.mods & MOD_MASK[p.key]);
    const fit = Math.max(modelLength(um), modelSpan(um) * FORE + 6 * LIFT);
    const s = Math.max(0.5, p.boxPx / fit);
    const px = Math.max(1, Math.floor(s / 2 + 1e-6));
    const res = Math.max(0.5, Math.floor((s / px) * 4) / 4);
    const g: Grid = { p: px, res, k: px, dpr: 1 };
    const d: UnitDraw = { key: p.key, mods: p.mods, owner: p.owner, x: p.x, y: p.y, angle: p.angle, zoom: 1, scale: res * px, lod: 'near', dpr: 1, timeMs: 0, turnRate: 0, speed: 0, moving: false, seed: 0, alpha: p.alpha, shadow: false };
    const prev = bakeSpent;
    bakeSpent = 0;
    const ok = drawAt(ctx, d, PORTRAIT_MOTION, g);
    bakeSpent = prev;
    return ok;
  },

  turretPoint(key, _mods, index, x, y, angle, scale) {
    const um = unitModel(key, 0);
    if (!um.guns.length) return { x, y };
    const gun = um.guns[Math.min(um.guns.length - 1, Math.max(0, index))];
    const n = scale >= 2 ? 32 : 16;
    const th = facingIndex(angle, n) * ((Math.PI * 2) / n);
    const [dx, dy] = project(gun[0], gun[1], gun[2], th, 0, scale, false);
    return { x: x + dx, y: y + dy };
  },
};

/** Portraits stand still. */
const PORTRAIT_MOTION: MotionParams = Object.freeze({
  preset: 'subtle',
  reduced: true,
  bob: 0,
  bobMs: 3000,
  wakeLength: 1,
  foamLife: 1,
  wakeSpread: 1,
  treadDust: 0,
  turretSway: 0,
  jiggle: 0,
  bankPerTurn: 0,
  bankMax: 0,
  propellers: 0.3,
  propFps: 0,
  contrailLife: 1,
  altitudeBob: 0,
  missileTrailLife: 1,
  flameMs: 90,
  blastTime: 1,
  smokeLinger: 1,
  fireLinger: 0,
  debris: 1,
  shockwave: 1,
  craterLife: 1,
  craterSmoke: 0,
  flashSize: 1,
  flashTime: 1,
  shellArc: 1,
  muzzleSmoke: 1,
  recoil: 0,
}) as MotionParams;
