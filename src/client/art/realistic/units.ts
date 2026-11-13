// The realistic style's units on the map and in portraits (client only): ships, tanks, planes and missiles painted
// with the canvas API (ships.ts, land.ts, air.ts) and baked into this style's atlas (art/shared/atlas.ts), then put
// together every frame from a few cheap blits. Nothing complex is painted per unit per frame.
//
// Baking: each layer of a model (model.ts) is painted once per heading bucket (16, so the top-left light and the
// cast shadows inside a model stay right at every heading) and per resolution (map scale times the device pixel
// ratio, so it is drawn finer than one CSS px where the screen allows). The owner's marks are a separate small layer
// per owner colour, so many nations do not multiply the big body pictures. The ground shadow is baked once facing
// east and turned freely.
//
// Drawing: the body is turned by what is left between the unit's heading and its bucket (at most 11 degrees), so it
// rotates smoothly, never in steps. Motion comes only from the clock and the MotionParams numbers:
//   ships     roll a little over their shadow (bob, bobMs)
//   tanks     the turret scans (turretSway), the hull shakes while driving (jiggle), the tracks kick up dust
//             (treadDust)
//   planes    bank into turns (turnRate, bankPerTurn, bankMax: the wings foreshorten, the lower wing darkens), the
//             shadow far below shows the height and rises and falls a little (altitudeBob), propellers are blurred
//             discs with a flickering blade (propellers, propFps)
//   missiles  a flickering exhaust flame (flameMs) and a shadow far below
// Reduced motion: no roll, sway, shake, bob or flicker.
import type { MotionParams } from '../motion';
import { atlasStats, SpriteAtlas, type AtlasEntry } from '../shared/atlas';
import { M_JET, M_MASTERY, M_NIGHT, M_PATH3, M_SPECIAL, SPRITE_KEYS, unitCategoryOf, type SpriteKey } from '../shared/keys';
import type { PortraitDraw, UnitArt, UnitDraw } from '../types';
import { missileModel, planeModel } from './air';
import { tankModel } from './land';
import { type Bounds, type Layer, type OwnerLayer, tonesOf, type UnitModel } from './model';
import { LIGHT_X, LIGHT_Y, painter, TAU } from './paint';
import { Puff, puff } from './puffs';
import { rnd } from '../shared/noise';
import { shipModel } from './ships';
import { makeCanvas } from '../../render/common';

/** Which upgrade details each unit shows (other bits are ignored, so the cache stays small). */
export const MOD_MASK: Record<SpriteKey, number> = {
  warship: M_MASTERY | M_SPECIAL,
  destroyer: M_MASTERY | M_SPECIAL,
  battleship: M_MASTERY | M_SPECIAL,
  submarine: M_MASTERY | M_SPECIAL,
  carrier: M_MASTERY | M_SPECIAL,
  transport: 0,
  tradeShip: 0,
  tankDivision: M_MASTERY | M_SPECIAL,
  lightTank: M_MASTERY | M_PATH3 | M_SPECIAL,
  heavyTank: M_MASTERY | M_PATH3 | M_SPECIAL,
  bomber: M_MASTERY | M_JET | M_SPECIAL | M_NIGHT,
  groundAttack: M_MASTERY | M_JET | M_SPECIAL | M_NIGHT,
  heavyBomber: M_MASTERY | M_PATH3 | M_SPECIAL | M_NIGHT,
  fighter: M_MASTERY | M_JET | M_SPECIAL,
  transportPlane: M_JET | M_SPECIAL,
  reconPlane: M_SPECIAL,
  rocket: 0,
  atomBomb: 0,
};

const HEADINGS = 16;
const STEP = TAU / HEADINGS;
const KEY_INDEX = new Map<SpriteKey, number>(SPRITE_KEYS.map((k, i) => [k, i]));

/** Heading bucket of an angle (0 = east, clockwise). */
export function bucketOf(angle: number): number {
  return ((Math.round(angle / STEP) % HEADINGS) + HEADINGS) % HEADINGS;
}

// ------------------------------------------------------------------------------------------------- models

const models = new Map<number, UnitModel>();

/** The model of a unit and upgrade set (built once, kept). */
export function modelOf(key: SpriteKey, mods: number): UnitModel {
  const m = mods & MOD_MASK[key];
  const id = (KEY_INDEX.get(key) ?? 0) * 32 + m;
  let model = models.get(id);
  if (!model) {
    const cat = unitCategoryOf(key);
    model = cat === 'ships' ? shipModel(key, m) : cat === 'land' ? tankModel(key, m) : cat === 'air' ? planeModel(key, m) : missileModel(key);
    models.set(id, model);
  }
  return model;
}

/** Length of a unit along its heading (art units; CSS px at map scale 1). */
export function realisticLength(key: SpriteKey, mods = 0): number {
  return modelOf(key, mods).len;
}

// ------------------------------------------------------------------------------------------------- atlas

/**
 * One atlas per kind of unit, so a screen full of ships never evicts the planes (pages are made as needed). 'whole' holds
 * the mid zoom pictures put together from those layers (see wholeEntry), so it never evicts the layers it copies from.
 */
const atlases: Record<string, SpriteAtlas> = {
  ships: new SpriteAtlas(1024, 6),
  land: new SpriteAtlas(1024, 4),
  air: new SpriteAtlas(1024, 6),
  missiles: new SpriteAtlas(512, 2),
  whole: new SpriteAtlas(1024, 6),
};

const L_BODY = 0;
const L_SHADOW = 2;
const L_TURRET = 3;
const L_BANK = 4;
const L_OWNERS = [1, 5, 6, 7];

/**
 * Device px per art unit, in steps of 1/8 (bakes are shared between close resolutions), at most 5: closer than that
 * a picture is drawn a little enlarged (soft paint stays soft) instead of filling the atlas.
 */
const quant = (R: number): number => Math.max(0.25, Math.min(5, Math.round(R * 8) / 8));

function layerId(layer: number, ki: number, mods: number, bucket: number, R: number, rgb: number): number {
  return ((((rgb * 32 + ki) * 32 + mods) * 16 + bucket) * 8 + layer) * 256 + Math.round(R * 8);
}

const rgbOf = (c: readonly number[]): number => ((c[0] & 255) << 16) | ((c[1] & 255) << 8) | (c[2] & 255);

/** A layer baked at heading `angle` and `R` device px per art unit (painted on first use, then kept). */
function entry(atlas: SpriteAtlas, id: number, b: Bounds, angle: number, R: number, layer: Layer | OwnerLayer, owner: readonly number[] | null): AtlasEntry | null {
  const hit = atlas.peek(id);
  if (hit !== undefined) return hit;
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const [u, v] of [
    [b.x0, b.y0],
    [b.x1, b.y0],
    [b.x0, b.y1],
    [b.x1, b.y1],
  ]) {
    const X = (u * c - v * s) * R;
    const Y = (u * s + v * c) * R;
    x0 = Math.min(x0, X);
    y0 = Math.min(y0, Y);
    x1 = Math.max(x1, X);
    y1 = Math.max(y1, Y);
  }
  const ox = Math.ceil(-x0) + 2;
  const oy = Math.ceil(-y0) + 2;
  const w = ox + Math.ceil(x1) + 2;
  const h = oy + Math.ceil(y1) + 2;
  return atlas.getPainted(id, w, h, ox, oy, (ctx) => {
    ctx.translate(ox, oy);
    ctx.rotate(angle);
    ctx.scale(R, R);
    ctx.lineJoin = 'round';
    const p = painter(ctx, angle, R);
    (layer as OwnerLayer).paint(p, owner ? tonesOf(owner) : tonesOf([128, 128, 128]));
  });
}

/** Draws an entry with its origin at (0, 0) of the current transform, `k` entry px per current unit. */
function blit(ctx: CanvasRenderingContext2D, e: AtlasEntry, k: number): void {
  ctx.drawImage(e.page, e.sx, e.sy, e.w, e.h, -e.ox / k, -e.oy / k, e.w / k, e.h / k);
}

/**
 * Mid zoom: the body, the owner's marks and (ships) the water shadow of one heading bucket put together into one
 * picture, copied from their baked layers (a few blits, no painting), so a screen full of ships and planes costs one
 * drawImage each instead of up to six. Baked per owner colour like the marks; null when it is not baked yet (the
 * frame's bake budget is spent): the caller then draws the layers one by one.
 */
function wholeEntry(id: number, body: AtlasEntry, own: readonly AtlasEntry[], sh: AtlasEntry | null, shX: number, shY: number, ba: number): AtlasEntry | null {
  const atlas = atlases.whole;
  const hit = atlas.peek(id);
  if (hit !== undefined) return hit;
  let x0 = -body.ox;
  let y0 = -body.oy;
  let x1 = body.w - body.ox;
  let y1 = body.h - body.oy;
  for (const e of own) {
    x0 = Math.min(x0, -e.ox);
    y0 = Math.min(y0, -e.oy);
    x1 = Math.max(x1, e.w - e.ox);
    y1 = Math.max(y1, e.h - e.oy);
  }
  const c = Math.cos(ba);
  const s = Math.sin(ba);
  if (sh)
    for (const [u, v] of [
      [-sh.ox, -sh.oy],
      [sh.w - sh.ox, -sh.oy],
      [-sh.ox, sh.h - sh.oy],
      [sh.w - sh.ox, sh.h - sh.oy],
    ]) {
      const X = shX + u * c - v * s;
      const Y = shY + u * s + v * c;
      x0 = Math.min(x0, X);
      y0 = Math.min(y0, Y);
      x1 = Math.max(x1, X);
      y1 = Math.max(y1, Y);
    }
  const ox = Math.ceil(-x0) + 1;
  const oy = Math.ceil(-y0) + 1;
  return atlas.getPainted(id, ox + Math.ceil(x1) + 1, oy + Math.ceil(y1) + 1, ox, oy, (ctx) => {
    ctx.translate(ox, oy);
    ctx.imageSmoothingEnabled = true;
    if (sh) {
      ctx.save();
      ctx.translate(shX, shY);
      ctx.rotate(ba);
      blit(ctx, sh, 1);
      ctx.restore();
    }
    blit(ctx, body, 1);
    for (const e of own) blit(ctx, e, 1);
  });
}

// ------------------------------------------------------------------------------------------------- moving parts

let propSprite: HTMLCanvasElement | null = null;
const flameSprites: HTMLCanvasElement[] = [];

/**
 * A spinning propeller's blur disc, seen from above and very slightly ahead: an ellipse (the disc's height across, a
 * little less than half of it along the heading), pale and almost clear in the middle, a slightly darker band where the
 * blade tips run, no outline.
 */
function propImage(): HTMLCanvasElement | null {
  if (propSprite || typeof document === 'undefined') return propSprite;
  const cv = makeCanvas(64, 64);
  const c = cv.getContext('2d');
  if (!c) return null;
  const g = c.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(226,230,226,0.2)');
  g.addColorStop(0.55, 'rgba(206,210,206,0.15)');
  g.addColorStop(0.78, 'rgba(120,124,122,0.24)');
  g.addColorStop(0.9, 'rgba(48,50,50,0.32)');
  g.addColorStop(1, 'rgba(40,42,42,0)');
  c.fillStyle = g;
  c.beginPath();
  c.arc(32, 32, 32, 0, TAU);
  c.fill();
  propSprite = cv;
  return cv;
}

/** Exhaust flames (three flickers), pointing back along -x from the nozzle at the image's right edge. */
function flameImage(i: number): HTMLCanvasElement | null {
  if (flameSprites[i] || typeof document === 'undefined') return flameSprites[i] ?? null;
  for (let f = 0; f < 3; f++) {
    const cv = makeCanvas(96, 32);
    const c = cv.getContext('2d');
    if (!c) return null;
    const L = 70 + f * 11;
    c.save();
    c.translate(96, 16);
    c.scale(L / 16, 1 - f * 0.1);
    const g = c.createRadialGradient(-2, 0, 0, -2, 0, 16);
    g.addColorStop(0, 'rgba(255,255,240,1)');
    g.addColorStop(0.18, 'rgba(255,236,160,0.95)');
    g.addColorStop(0.45, 'rgba(255,160,60,0.75)');
    g.addColorStop(0.75, 'rgba(220,80,30,0.35)');
    g.addColorStop(1, 'rgba(160,50,20,0)');
    c.fillStyle = g;
    c.beginPath();
    c.arc(0, 0, 16, Math.PI / 2, Math.PI * 1.5);
    c.closePath();
    c.fill();
    c.restore();
    flameSprites[f] = cv;
  }
  return flameSprites[i] ?? null;
}

// ------------------------------------------------------------------------------------------------- composing

/** The exact heading of each ship drawn this frame by screen position, for turretPoint (see there). */
const shipAngles = new Map<number, number>();
let shipAnglesAt = NaN;
const posKey = (x: number, y: number): number => Math.round(x * 4) * 65536 + Math.round(y * 4);

const ownList: AtlasEntry[] = [];

interface Pose {
  key: SpriteKey;
  mods: number;
  owner: readonly number[];
  x: number;
  y: number;
  angle: number;
  /** CSS px (or portrait px) per art unit, and device px per art unit for the bake */
  sc: number;
  R: number;
  timeMs: number;
  turnRate: number;
  moving: boolean;
  seed: number;
  shadow: boolean;
  /** near zoom or a portrait: fine moving parts (blade flicker) */
  near: boolean;
  /** a portrait: no motion at all */
  still: boolean;
}

function compose(ctx: CanvasRenderingContext2D, q: Pose, m: MotionParams): boolean {
  const model = modelOf(q.key, q.mods);
  const mods = q.mods & MOD_MASK[q.key];
  const ki = KEY_INDEX.get(q.key) ?? 0;
  const R = quant(q.R);
  const k = R / q.sc;
  const bucket = bucketOf(q.angle);
  const ba = bucket * STEP;
  const cat = unitCategoryOf(q.key);
  const atlas = atlases[cat];
  const resets = atlasStats.resets;
  const body = entry(atlas, layerId(L_BODY, ki, mods, bucket, R, 0), model.body.b, ba, R, model.body, null);
  if (!body) return false;
  const rgb = rgbOf(q.owner);
  const owners = model.owners;
  const own = ownList;
  own.length = 0;
  if (owners)
    for (let i = 0; i < owners.length && i < L_OWNERS.length; i++) {
      const e = entry(atlas, layerId(L_OWNERS[i], ki, mods, bucket, R, rgb), owners[i].b, ba, R, owners[i], q.owner);
      if (e) own.push(e);
    }
  const sh = model.shadow && q.shadow ? entry(atlas, layerId(L_SHADOW, ki, mods, 0, R, 0), model.shadow.b, 0, R, model.shadow, null) : null;
  const tur = model.turret ? entry(atlas, layerId(L_TURRET, ki, mods, bucket, R, rgb), model.turret.layer.b, ba, R, model.turret.layer, q.owner) : null;
  if (model.turret && !tur) return false;
  // a bake above filled the atlas and it started over: the pictures fetched before it are gone (next frame)
  if (atlasStats.resets !== resets) return false;
  // every mark is baked (a picture put together from fewer would keep the missing ones out for good)
  const allOwn = own.length === (owners ? Math.min(owners.length, L_OWNERS.length) : 0);
  const still = q.still || m.reduced;
  const t = q.timeMs;
  const sc = q.sc;
  const ca = Math.cos(q.angle);
  const sa = Math.sin(q.angle);
  let x = q.x;
  let y = q.y;
  const rot = q.angle - ba;
  ctx.save();
  ctx.imageSmoothingEnabled = true;
  if (cat === 'ships') {
    // mid zoom: shadow, hull and marks as one picture (the roll then sways the ship with its shadow, under a pixel)
    const whole = !q.near && !q.still && sh && allOwn ? wholeEntry(layerId(0, ki, mods, bucket, R, rgb), body, own, sh, -LIGHT_X * model.alt * R, -LIGHT_Y * model.alt * R, ba) : null;
    if (sh && !whole) {
      ctx.save();
      ctx.translate(x - LIGHT_X * model.alt * sc, y - LIGHT_Y * model.alt * sc);
      ctx.rotate(q.angle);
      blit(ctx, sh, k);
      ctx.restore();
    }
    // a slow roll: the ship leans a little to each side over its own shadow
    const roll = still ? 0 : Math.sin((t / Math.max(400, m.bobMs)) * TAU + q.seed * 1.7) * m.bob * 0.45 * sc;
    x -= sa * roll;
    y += ca * roll;
    if (Math.abs(rot) < 0.002 && !roll) {
      const d = k / R;
      x = Math.round(x / d) * d;
      y = Math.round(y / d) * d;
    }
    ctx.translate(x, y);
    ctx.rotate(rot);
    if (whole) blit(ctx, whole, k);
    else {
      blit(ctx, body, k);
      for (const e of own) blit(ctx, e, k);
    }
    if (!q.still) {
      if (t !== shipAnglesAt) {
        shipAngles.clear();
        shipAnglesAt = t;
      }
      shipAngles.set(posKey(q.x, q.y), q.angle);
    }
  } else if (cat === 'land') {
    const moving = q.moving && !still;
    if (moving && m.treadDust > 0 && model.dust) tankDust(ctx, model, q, m.treadDust, ca, sa);
    if (moving && m.jiggle > 0) {
      // engine shake: a fast small tremble along and across the hull
      const j = m.jiggle * 0.35 * sc;
      x += Math.sin(t * 0.083 + q.seed * 3.1) * j * ca * 0.6 - Math.sin(t * 0.061 + q.seed) * j * sa * 0.4;
      y += Math.sin(t * 0.083 + q.seed * 3.1) * j * sa * 0.6 + Math.sin(t * 0.061 + q.seed) * j * ca * 0.4;
    }
    ctx.translate(x, y);
    ctx.rotate(rot);
    blit(ctx, body, k);
    if (tur && model.turret) {
      const sway = still ? 0 : m.turretSway * (Math.sin(t / 2300 + q.seed * 1.3) * 0.8 + Math.sin(t / 900 + q.seed) * 0.2);
      ctx.rotate(-rot);
      ctx.translate(ca * model.turret.x * sc, sa * model.turret.x * sc);
      ctx.rotate(rot + sway);
      blit(ctx, tur, k);
    }
  } else if (cat === 'air') {
    const bank = still ? 0 : Math.max(-m.bankMax, Math.min(m.bankMax, q.turnRate * m.bankPerTurn));
    const cb = Math.cos(bank);
    const sb = Math.sin(bank);
    const bob = still ? 0 : Math.sin(t / 1700 + q.seed * 2.3) * m.altitudeBob;
    // (a portrait keeps the shadow close, so it stays in its box; never more than about 1.5 lengths off on the map)
    const alt = Math.min(q.still ? Math.min(2.5, model.alt) : model.alt + bob, model.len * 1.5) * sc;
    // a banking plane slips a little sideways over its shadow, toward the lower wing (the harder the preset banks, the
    // more), and its shadow swings out the other way as the wings tilt
    const slip = sb * m.bankMax * 1.6 * sc;
    const swing = -sb * alt * 0.35;
    if (sh) {
      ctx.save();
      ctx.globalAlpha *= 0.9;
      ctx.translate(x - LIGHT_X * alt - sa * swing, y - LIGHT_Y * alt + ca * swing);
      ctx.rotate(q.angle);
      ctx.scale(1, cb);
      blit(ctx, sh, k);
      ctx.restore();
    }
    x -= sa * slip;
    y += ca * slip;
    ctx.translate(x, y);
    ctx.rotate(q.angle);
    if (cb !== 1) ctx.scale(1, cb);
    ctx.rotate(-ba);
    // mid zoom: the plane and its marks as one picture
    const whole = !q.near && !q.still && own.length && allOwn ? wholeEntry(layerId(0, ki, mods, bucket, R, rgb), body, own, null, 0, 0, ba) : null;
    if (whole) blit(ctx, whole, k);
    else {
      blit(ctx, body, k);
      for (const e of own) blit(ctx, e, k);
    }
    // the lower wing of a banking plane goes into shade (turning to starboard, +y, the starboard wing dips)
    if (Math.abs(bank) > 0.04 && model.wingShade) {
      const ws = entry(atlas, layerId(L_BANK, ki, mods, bucket, R, 0), model.wingShade.b, ba, R, model.wingShade, null);
      if (ws) {
        const prev = ctx.globalAlpha;
        ctx.globalAlpha = prev * Math.min(0.55, Math.abs(bank) * 0.75);
        if (bank < 0) {
          ctx.rotate(ba);
          ctx.scale(1, -1);
          ctx.rotate(-ba);
        }
        blit(ctx, ws, k);
        if (bank < 0) {
          ctx.rotate(ba);
          ctx.scale(1, -1);
          ctx.rotate(-ba);
        }
        ctx.globalAlpha = prev;
      }
    }
    ctx.rotate(ba);
    if (model.props && model.props.length) props(ctx, model, q, m, sc, still);
  } else {
    // missiles: the shadow far below, the flame, the body
    if (sh) {
      ctx.save();
      ctx.globalAlpha *= 0.7;
      const malt = (q.still ? 2.5 : model.alt) * sc;
      ctx.translate(x - LIGHT_X * malt, y - LIGHT_Y * malt);
      ctx.rotate(q.angle);
      blit(ctx, sh, k);
      ctx.restore();
    }
    ctx.translate(x, y);
    ctx.rotate(q.angle);
    if (model.flame) {
      const f = still ? 0 : Math.floor(t / Math.max(20, m.flameMs) + q.seed * 1.37) % 3;
      const img = flameImage(f);
      if (img) {
        const r = model.flame.r * sc;
        const L = r * (q.key === 'atomBomb' ? 4.2 : 3.6);
        ctx.drawImage(img, model.flame.x * sc - L, -r, L, r * 2);
      }
    }
    ctx.rotate(-ba);
    blit(ctx, body, k);
  }
  ctx.restore();
  return true;
}

/**
 * Propellers: a blur disc in front of each engine (bolder with the preset's `propellers`, never smaller than about 3 CSS
 * px so it still shows at mid zoom) and one blade streak flickering across it at propFps.
 */
function props(ctx: CanvasRenderingContext2D, model: UnitModel, q: Pose, m: MotionParams, sc: number, still: boolean): void {
  const img = propImage();
  if (!img || !model.props) return;
  const a = q.still ? 0.6 : m.propellers;
  if (a <= 0.02) return;
  const prev = ctx.globalAlpha;
  let i = 0;
  for (const pr of model.props) {
    const px = pr.x * sc;
    const py = pr.y * sc;
    const r = Math.max(3, pr.r * sc);
    ctx.globalAlpha = prev * Math.min(1, a * 1.15);
    ctx.drawImage(img, px - r * 0.45, py - r, r * 0.9, r * 2);
    if (!still && q.near) {
      // one blade caught by the eye as it turns: a thin dark streak across the disc, changing length every frame
      const f = Math.floor((q.timeMs * m.propFps) / 1000 + q.seed * 3 + i * 1.7);
      const len = r * (0.3 + 0.65 * Math.abs(Math.cos(f * 2.39996)));
      const off = Math.sin(f * 1.3) * r * 0.12;
      ctx.globalAlpha = prev * Math.min(0.7, a * 0.6);
      ctx.fillStyle = '#25282a';
      const w = Math.max(0.6, 0.22 * sc);
      ctx.fillRect(px + off - w / 2, py - len, w, len * 2);
    }
    i++;
  }
  ctx.globalAlpha = prev;
}

/**
 * Dust kicked up behind a moving tank's tracks: many faint puffs of uneven size that drift back, grow and thin out, so
 * they merge into a haze and no single puff shows its edge.
 */
function tankDust(ctx: CanvasRenderingContext2D, model: UnitModel, q: Pose, amount: number, ca: number, sa: number): void {
  const d = model.dust;
  if (!d) return;
  const sc = q.sc;
  // (two puffs a side at mid zoom, where they are a few px across and a whole army may be on screen)
  const n = q.near ? 5 : 2;
  for (let side = -1; side <= 1; side += 2)
    for (let i = 0; i < n; i++) {
      const j = i + (side > 0 ? 7 : 0);
      const ph = (q.timeMs / 900 + i / n + q.seed * 0.37 + (side > 0 ? 0.17 : 0)) % 1;
      // the puff's own size and track: fixed for its whole life (a new one each cycle)
      const cyc = Math.floor(q.timeMs / 900 + i / n + q.seed * 0.37 + (side > 0 ? 0.17 : 0));
      const k = 0.6 + 0.8 * rnd(cyc * 13 + j, 5);
      const wob = (rnd(cyc * 13 + j, 6) - 0.5) * 2.2;
      // thrown up at the track, billowing out wider than the hull and settling behind it
      const back = (d.x - 1 - ph * 12) * sc;
      const across = (side * (d.y + ph * 3) + wob * ph) * sc;
      const px = q.x + ca * back - sa * across;
      const py = q.y + sa * back + ca * across;
      const r = (2.4 + ph * 7.5) * k * sc * (0.6 + 0.4 * amount);
      puff(ctx, Puff.DUST, j, px, py, r, (1 - ph) * (1 - ph) * Math.min(1, ph * 5) * 0.36 * amount);
    }
}

// ------------------------------------------------------------------------------------------------- the UnitArt

const pose: Pose = { key: 'warship', mods: 0, owner: [0, 0, 0], x: 0, y: 0, angle: 0, sc: 1, R: 1, timeMs: 0, turnRate: 0, moving: false, seed: 0, shadow: true, near: false, still: false };

export const realisticUnits: UnitArt = {
  lengthPx(key, mods, scale) {
    return modelOf(key, mods).len * scale;
  },

  drawUnit(ctx: CanvasRenderingContext2D, u: UnitDraw, m: MotionParams): boolean {
    const q = pose;
    q.key = u.key;
    q.mods = u.mods;
    q.owner = u.owner;
    q.x = u.x;
    q.y = u.y;
    q.angle = u.angle;
    q.sc = u.scale;
    q.R = u.scale * Math.max(1, u.dpr);
    q.timeMs = u.timeMs;
    q.turnRate = u.turnRate;
    q.moving = u.moving;
    q.seed = u.seed;
    q.shadow = u.shadow;
    q.near = u.lod === 'near';
    q.still = false;
    if (u.alpha >= 0.999) return compose(ctx, q, m);
    const prev = ctx.globalAlpha;
    ctx.globalAlpha = prev * u.alpha;
    try {
      return compose(ctx, q, m);
    } finally {
      ctx.globalAlpha = prev;
    }
  },

  drawPortrait(ctx: CanvasRenderingContext2D, p: PortraitDraw): boolean {
    const model = modelOf(p.key, p.mods);
    const sc = p.boxPx / model.fit;
    const q = pose;
    q.key = p.key;
    q.mods = p.mods;
    q.owner = p.owner;
    q.x = p.x;
    q.y = p.y;
    q.angle = p.angle;
    q.sc = sc;
    q.R = sc;
    q.timeMs = 0;
    q.turnRate = 0;
    q.moving = false;
    q.seed = 0;
    q.shadow = true;
    q.near = true;
    q.still = true;
    const prev = ctx.globalAlpha;
    ctx.globalAlpha = prev * p.alpha;
    try {
      return compose(ctx, q, STILL);
    } finally {
      ctx.globalAlpha = prev;
    }
  },

  /**
   * Ships: where gun `index` of a salvo fires from. The map passes the heading snapped to 16 facings (the refined
   * style's), but this style draws ships at their exact heading, so the heading this ship was drawn at this frame is
   * looked up by its screen position (the flash then sits on the turret, not up to 11 degrees off it).
   */
  turretPoint(key, mods, index, x, y, angle, scale) {
    const model = modelOf(key, mods);
    const guns = model.guns;
    if (!guns || !guns.length) return { x, y };
    const g = guns[Math.min(guns.length - 1, Math.max(0, index))];
    let a = angle;
    const drawn = shipAngles.get(posKey(x, y));
    if (drawn !== undefined) {
      let d = drawn - angle;
      while (d > Math.PI) d -= TAU;
      while (d < -Math.PI) d += TAU;
      if (Math.abs(d) <= STEP * 0.75) a = drawn;
    }
    const c = Math.cos(a);
    const s = Math.sin(a);
    return { x: x + (c * g[0] - s * g[1]) * scale, y: y + (s * g[0] + c * g[1]) * scale };
  },
};

/** Motion numbers for portraits: nothing moves. */
const STILL = {
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
  propellers: 0.5,
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
} as const satisfies MotionParams;

/** The atlases of this style (stats, tests). */
export const realisticAtlases = atlases;
