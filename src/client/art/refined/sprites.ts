// The refined style's unit sprites (client only): the shaded pixel models of spriteArt.ts, rasterized per heading
// (16 facings), owner colour, upgrade set and bank by spriteBake.ts, never rotated as an image: every facing has square,
// crisp pixels and the same top-left light. Each bake lands once in this style's atlas (art/shared/atlas.ts) and is
// drawn with whole-number scaling and smoothing off. Planes and missiles also get a baked ground shadow.
//
// Motion, all from the clock and the MotionParams numbers (art/motion.ts), none of it baked per frame:
//   ships     bob on the swell (m.bob over m.bobMs, each ship in its own phase) and rock back when their guns fire
//             (m.recoil, recoil.ts)
//   tanks     shake a little while driving (m.jiggle) and kick up dust from their tracks (m.treadDust)
//   planes    bank into turns (u.turnRate times m.bankPerTurn, at most m.bankMax, baked in steps), spin their
//             propellers as blur discs with a blade sweeping round (m.propellers, m.propFps), and fly over a shadow set
//             off by their height (low attackers, high bombers) that rises and falls a little (m.altitudeBob)
//   missiles  flicker their exhaust (m.flameMs); the atom bomb carries a faint ring so it reads as the big one
// Reduced motion keeps the pictures and drops the idle motion (no bob, bank, blade sweep or flicker).
import type { MotionParams } from '../motion';
import { drawEntry, SpriteAtlas, type AtlasEntry, type RGBABitmap } from '../shared/atlas';
import type { RGB } from '../shared/colour';
import { facingOf, isAirKey, unitCategoryOf, type SpriteKey } from '../shared/keys';
import { fract } from '../shared/noise';
import { pixelRing } from '../shared/pixel';
import type { PortraitDraw, UnitArt, UnitDraw } from '../types';
import { FX, hexOf, oklch } from './palette';
import { recoilAt, seeClock } from './recoil';
import { ALTITUDE, ANIMATED, buildModel, GUNS, MOD_MASK, modelLength, SPRITE_KEYS } from './spriteArt';
import { FORE, LIFT, projector, rasterize, shadowOf, type Model, type Prop } from './spriteBake';

// ------------------------------------------------------------------------------------------------- models

const KEY_INDEX = new Map<SpriteKey, number>(SPRITE_KEYS.map((k, i) => [k, i]));

interface ModelInfo {
  model: Model;
  /** bow to stern / nose to tail, model units */
  len: number;
  /** the larger of the length and the foreshortened span: what must fit a portrait box */
  fit: number;
  /** half the width across the heading, model units (ships: the wakes size their bow wave with it) */
  beam: number;
}
const models = new Map<number, ModelInfo>();
function modelInfo(key: SpriteKey, mods: number, frame: number): ModelInfo {
  const m = mods & MOD_MASK[key];
  const f = ANIMATED.has(key) ? frame & 1 : 0;
  const k = ((KEY_INDEX.get(key) ?? 0) * 32 + m) * 2 + f;
  let info = models.get(k);
  if (!info) {
    const model = buildModel(key, m, f);
    let v0 = Infinity;
    let v1 = -Infinity;
    for (const p of model.parts) {
      const q = p.p;
      if (p.k === 'ell') {
        v0 = Math.min(v0, q[1] - q[3]);
        v1 = Math.max(v1, q[1] + q[3]);
      } else if (p.k === 'box') {
        v0 = Math.min(v0, q[1]);
        v1 = Math.max(v1, q[3]);
      } else if (p.k === 'seg') {
        v0 = Math.min(v0, q[1], q[3]);
        v1 = Math.max(v1, q[1], q[3]);
      } else
        for (let i = 1; i < q.length; i += 2) {
          v0 = Math.min(v0, q[i]);
          v1 = Math.max(v1, q[i]);
        }
    }
    const len = modelLength(model);
    info = { model, len, fit: Math.max(len, (v1 - v0) * FORE + 6 * LIFT), beam: (v1 - v0) / 2 };
    models.set(k, info);
  }
  return info;
}

/** Length of a sprite along its heading, in art pixels (screen px at scale 1). */
export function refinedLength(key: SpriteKey, mods = 0): number {
  return modelInfo(key, mods, 0).len;
}

/** Half the width of a sprite across its heading, in art pixels (ships' wakes). */
export function refinedBeam(key: SpriteKey): number {
  return modelInfo(key, 0, 0).beam;
}

// ------------------------------------------------------------------------------------------------- atlas

const atlas = new SpriteAtlas();
/**
 * Art resolutions (art px per model unit): the map always uses full size; small portraits may use less, and a
 * portrait between two whole scales a little more (so a battleship is not drawn smaller than a destroyer).
 */
const RES = [1, 0.75, 0.5, 1.25, 1.5, 1.75];
/** Bank steps: a plane banks in steps of this many radians, at most BANK_LEVELS steps each way. */
export const BANK_STEP = 0.18;
const BANK_LEVELS = 4;

function entryKey(key: SpriteKey, mods: number, facing: number, frame: number, owner: RGB, res: number, shadow: boolean, bank: number): number {
  const o = shadow ? 0 : ((owner[0] & 255) << 16) | ((owner[1] & 255) << 8) | (owner[2] & 255);
  return ((((((o * 32 + (KEY_INDEX.get(key) ?? 0)) * 32 + mods) * 16 + facing) * 2 + frame) * 8 + res) * 2 + (shadow ? 1 : 0)) * 9 + (bank + BANK_LEVELS);
}

function entry(key: SpriteKey, mods: number, facing: number, frame: number, owner: RGB, res: number, shadow: boolean, bank = 0): AtlasEntry | null {
  const m = mods & MOD_MASK[key];
  const f = ANIMATED.has(key) ? frame & 1 : 0;
  return atlas.get(entryKey(key, m, facing, f, owner, res, shadow, bank), () => {
    const b = rasterize(modelInfo(key, m, f).model, RES[res] ?? 1, facing, owner, bank * BANK_STEP);
    return shadow ? shadowOf(b) : b;
  });
}

// ------------------------------------------------------------------------------------------------- propellers

const PROP_FRAMES = 4;

/**
 * A spinning propeller as one small picture: the blur disc (pale, see-through, a firmer rim) standing across the
 * nose, seen in the 3/4 view, with three faint blade smears at the angle of `frame`. Sampled from the disc's plane,
 * so it is right at every heading and bank.
 */
function propBitmap(r: number, res: number, facing: number, bank: number, frame: number): RGBABitmap {
  const P = projector(res, facing, bank * BANK_STEP);
  const [cx, cy] = P(0, 0, 0);
  const [ax, ay] = P(0, 1, 0);
  const A = [ax - cx, ay - cy];
  const B = [0, -LIFT * res];
  const [dx, dy] = P(1, 0, 0);
  const D = [dx - cx, dy - cy];
  const R = Math.ceil(r * res * 1.2) + 2;
  const w = R * 2 + 1;
  const h = R * 2 + 1;
  const level = new Uint8Array(w * h);
  const beta = (frame / PROP_FRAMES) * ((Math.PI * 2) / 3);
  const put = (x: number, y: number, l: number): void => {
    const X = Math.floor(x + R + 0.5);
    const Y = Math.floor(y + R + 0.5);
    if (X < 0 || Y < 0 || X >= w || Y >= h) return;
    const i = Y * w + X;
    if (l > level[i]) level[i] = l;
  };
  const steps = Math.max(8, Math.ceil(r * res * 5));
  for (let i = -steps; i <= steps; i++) {
    for (let j = -steps; j <= steps; j++) {
      const s = i / steps;
      const t = j / steps;
      const d2 = s * s + t * t;
      if (d2 > 1) continue;
      // the blade smears: three arms of the disc near the blade angles
      const ang = Math.atan2(t, s);
      let near = Infinity;
      for (let b = 0; b < 3; b++) {
        let da = Math.abs(ang - beta - (b * Math.PI * 2) / 3) % (Math.PI * 2);
        if (da > Math.PI) da = Math.PI * 2 - da;
        near = Math.min(near, da);
      }
      const l = d2 > 0.72 ? 2 : near < 0.32 && d2 > 0.06 ? 3 : 1;
      for (const k of [-0.2, 0.2]) put(s * r * A[0] + t * r * B[0] + k * D[0], s * r * A[1] + t * r * B[1] + k * D[1], l);
    }
  }
  const data = new Uint8ClampedArray(w * h * 4);
  // disc, rim, blade: a pale haze over whatever is behind, the blades a darker grey
  const col: number[][] = [
    [0, 0, 0, 0],
    [214, 220, 222, 70],
    [196, 202, 205, 120],
    [70, 76, 80, 150],
  ];
  for (let i = 0; i < w * h; i++) data.set(col[level[i]], i * 4);
  return { w, h, ox: R, oy: R, data };
}

function propEntry(r: number, res: number, facing: number, bank: number, frame: number): AtlasEntry | null {
  const rq = Math.round(r * 4);
  // negative keys: never the same as a sprite's
  const key = -1 - ((((rq * 8 + res) * 16 + facing) * 9 + bank + BANK_LEVELS) * PROP_FRAMES + frame);
  return atlas.get(key, () => propBitmap(rq / 4, RES[res] ?? 1, facing, bank, frame));
}

/** Draws the propeller discs of a plane whose origin is drawn at (x, y). */
function drawProps(ctx: CanvasRenderingContext2D, props: readonly Prop[], x: number, y: number, k: number, res: number, facing: number, bank: number, frame: number, alpha: number): void {
  if (alpha <= 0.02) return;
  const P = projector(RES[res] ?? 1, facing, bank * BANK_STEP);
  const prev = ctx.globalAlpha;
  ctx.globalAlpha = prev * Math.min(1, alpha);
  const X = Math.round(x);
  const Y = Math.round(y);
  for (const p of props) {
    const e = propEntry(p.r, res, facing, bank, frame);
    if (!e) continue;
    const [px, py] = P(p.u, p.v, p.z);
    drawEntry(ctx, e, X + Math.round(px) * k, Y + Math.round(py) * k, k);
  }
  ctx.globalAlpha = prev;
}

// ------------------------------------------------------------------------------------------------- drawing

/**
 * Draws a sprite with its centre (the model origin) at (x, y), `k` screen px per art pixel, at the art resolution
 * index `res` into RES (0 = full, 1 = 3/4, 2 = half, 3 to 5 = 1.25 to 1.75 for portraits), banked `bank` steps.
 * Planes and missiles get their ground shadow first (unless `shadow` is false), set off by how high they fly; `bob`
 * lifts the plane (screen px) while its shadow stays put. False when it could not be drawn (no canvas, or this
 * frame's bake budget is spent).
 */
export function drawSpriteKey(ctx: CanvasRenderingContext2D, key: SpriteKey, mods: number, x: number, y: number, k: number, angle: number, owner: RGB, frame = 0, res = 0, alpha = 1, shadow = true, bank = 0, bob = 0): boolean {
  const facing = facingOf(angle);
  const e = entry(key, mods, facing, frame, owner, res, false, bank);
  if (!e) return false;
  const sh = isAirKey(key) && shadow ? entry(key, mods, facing, frame, owner, res, true, bank) : null;
  const prevAlpha = ctx.globalAlpha;
  if (alpha !== 1) ctx.globalAlpha = prevAlpha * alpha;
  if (sh) {
    // the light is top left, so the shadow falls down and right, as far off as the plane flies high
    const alt = ALTITUDE[key] ?? 3;
    drawEntry(ctx, sh, Math.round(x) + Math.round(alt * 0.6) * k, Math.round(y) + Math.round(alt * 0.8) * k, k);
  }
  drawEntry(ctx, e, x, y - bob, k);
  ctx.globalAlpha = prevAlpha;
  return true;
}

const TAU = Math.PI * 2;
/** Fresh tread dust: a pale dry earth, lighter than any grass so it shows on the plains. */
const DUST_NEAR = hexOf(oklch(0.84, 0.03, 85));

/** Tread dust: tan puffs thrown up behind both tracks of a moving tank, drifting back, growing and thinning out. */
function drawDust(ctx: CanvasRenderingContext2D, u: UnitDraw, m: MotionParams, half: number): void {
  const amt = m.treadDust * (m.reduced ? 0.5 : 1);
  if (amt <= 0.01) return;
  const k = u.scale;
  const c = Math.cos(u.angle);
  const s = Math.sin(u.angle);
  const speedPx = Math.min(60, u.speed * u.zoom);
  const n = k >= 2 ? 4 : 3;
  const life = 700 + 500 * amt;
  const prev = ctx.globalAlpha;
  const side = half * 0.42;
  for (let tr = -1; tr <= 1; tr += 2) {
    for (let i = 0; i < n; i++) {
      const p = fract(u.timeMs / life + i / n + fract(u.seed * 0.618) + (tr > 0 ? 0.5 / n : 0));
      const age = p * life;
      const back = half * 0.85 + Math.min(half * 2.2, (speedPx * age) / 1000) + p * 4 * k;
      const out = side + p * k * 2.2;
      const x = u.x - c * back - s * out * tr;
      const y = u.y - s * back * FORE + c * out * tr * FORE - p * k * 1.5;
      const r = (1.1 + 3 * p) * k * (0.65 + 0.35 * amt);
      const a = Math.min(0.8, 0.25 + amt * 0.7) * (1 - p) * (1 - p * 0.4) * Math.min(1, p * 6);
      if (a < 0.02) continue;
      ctx.globalAlpha = prev * a;
      ctx.fillStyle = p < 0.4 ? DUST_NEAR : FX.dustLight;
      const R = Math.max(k, Math.round(r / k) * k);
      const X = Math.round(x / k) * k;
      const Y = Math.round(y / k) * k;
      // a rounded puff: a wide bar and a tall bar
      ctx.fillRect(X - R, Y - R + k, R * 2, Math.max(k, R * 2 - 2 * k));
      ctx.fillRect(X - R + k, Y - R, Math.max(k, R * 2 - 2 * k), R * 2);
    }
  }
  ctx.globalAlpha = prev;
}

/** The refined units: one implementation for ships, land units, planes and missiles. */
export const refinedUnits: UnitArt = {
  lengthPx(key, mods, scale) {
    return refinedLength(key, mods) * scale;
  },

  drawUnit(ctx: CanvasRenderingContext2D, u: UnitDraw, m: MotionParams): boolean {
    seeClock(u.timeMs);
    const key = u.key;
    const k = u.scale;
    const cat = unitCategoryOf(key);
    const phase = fract(u.seed * 0.618034) * TAU;
    const still = m.reduced;
    let x = u.x;
    let y = u.y;
    if (cat === 'ships') {
      // the swell: each ship in its own phase; the big ones bob less, a submarine hardly at all
      if (!still && m.bob > 0) {
        const size = key === 'carrier' || key === 'battleship' ? 0.65 : key === 'submarine' ? 0.4 : 1;
        y += Math.round(m.bob * size * k * Math.sin((u.timeMs / m.bobMs) * TAU + phase));
      }
      if (m.recoil > 0) {
        const [rx, ry] = recoilAt(u.x, u.y, (refinedLength(key, u.mods) * k) / 2 + 2 * k, u.timeMs, m.recoil * k);
        x += Math.round(rx);
        y += Math.round(ry);
      }
      return drawSpriteKey(ctx, key, u.mods, x, y, k, u.angle, u.owner, 0, 0, u.alpha, false);
    }
    if (cat === 'land') {
      if (u.moving) {
        drawDust(ctx, u, m, (refinedLength(key, u.mods) * k) / 2);
        if (!still && m.jiggle > 0) {
          x += Math.round(m.jiggle * k * Math.sin(u.timeMs * 0.057 + phase));
          y += Math.round(m.jiggle * k * 0.7 * Math.sin(u.timeMs * 0.083 + phase * 1.7));
        }
      }
      return drawSpriteKey(ctx, key, u.mods, x, y, k, u.angle, u.owner, 0, 0, u.alpha, false);
    }
    if (cat === 'missiles') {
      const frame = still ? 0 : Math.floor(u.timeMs / Math.max(16, m.flameMs)) & 1;
      const ok = drawSpriteKey(ctx, key, u.mods, x, y, k, u.angle, u.owner, frame, 0, u.alpha, u.shadow);
      if (ok && key === 'atomBomb') {
        // a faint broken ring round it so it reads as the big one
        const half = Math.max(6, (refinedLength(key, 0) * k) / 2);
        ctx.fillStyle = 'rgba(232,206,140,0.3)';
        pixelRing(ctx, x, y, (half + 5) / k, k, true);
      }
      return ok;
    }
    // planes: bank into the turn, fly over a shadow that shows the height, spin the propellers
    let bank = 0;
    if (!still) {
      const roll = Math.max(-m.bankMax, Math.min(m.bankMax, u.turnRate * m.bankPerTurn));
      bank = Math.max(-BANK_LEVELS, Math.min(BANK_LEVELS, Math.round(roll / BANK_STEP)));
    }
    const bob = still || m.altitudeBob <= 0 ? 0 : Math.round(m.altitudeBob * k * Math.sin((u.timeMs / 3400) * TAU + phase));
    const ok = drawSpriteKey(ctx, key, u.mods, x, y, k, u.angle, u.owner, 0, 0, u.alpha, u.shadow, bank, bob);
    if (ok) {
      const props = modelInfo(key, u.mods, 0).model.props;
      if (props?.length) {
        const frame = still ? 0 : Math.floor((u.timeMs * Math.max(1, m.propFps)) / 1000 + phase * 3) % PROP_FRAMES;
        drawProps(ctx, props, x, y - bob, k, 0, facingOf(u.angle), bank, frame, m.propellers * u.alpha);
      }
    }
    return ok;
  },

  /**
   * Fits the sprite in `boxPx` (its length, or its span for wide planes): the scale is a whole number so the pixels
   * stay crisp, and the art resolution fills the rest of the box in quarter steps (a smaller one when even scale 1
   * does not fit), so every unit fills its portrait about equally.
   */
  drawPortrait(ctx: CanvasRenderingContext2D, p: PortraitDraw): boolean {
    const info = modelInfo(p.key, p.mods, 0);
    const s = p.boxPx / info.fit;
    let res = 0;
    let k = 1;
    if (s < 1) res = s >= 0.75 ? 1 : 2;
    else {
      k = Math.min(8, Math.floor(s));
      // 1.25, 1.5 or 1.75 art px per model unit when the box has that much room left at this whole-number scale
      const q = Math.min(3, Math.floor((s / k - 1) * 4));
      res = q <= 0 ? 0 : 2 + q;
    }
    const ok = drawSpriteKey(ctx, p.key, p.mods, p.x, p.y, k, p.angle, p.owner, 0, res, p.alpha);
    if (ok && info.model.props?.length) drawProps(ctx, info.model.props, p.x, p.y, k, res, facingOf(p.angle), 0, 0, 0.7 * p.alpha);
    return ok;
  },

  turretPoint(key, _mods, index, x, y, angle, scale) {
    const list = GUNS[key] ?? GUNS.warship!;
    const t = list[Math.min(list.length - 1, Math.max(0, index))] ?? [0, 0];
    // the heading the sprite was baked at, the deck foreshortened and the turret lifted like the model
    const [px, py] = projector(1, facingOf(angle))(t[0], 0, t[1]);
    return { x: x + px * scale, y: y + py * scale };
  },
};
