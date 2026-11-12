// The refined style's unit sprites (client only): the shaded pixel models of spriteArt.ts, rasterized per heading
// (16 facings), owner colour and upgrade set by spriteBake.ts, never rotated as an image: every facing has square,
// crisp pixels and the same top-left light. Each bake lands once in this style's atlas (art/shared/atlas.ts) and is
// drawn with whole-number scaling and smoothing off. Planes and missiles also get a baked ground shadow. The atom bomb
// gets a faint pixel ring round it on the map so it reads as the big one.
import type { MotionParams } from '../motion';
import { drawEntry, SpriteAtlas, type AtlasEntry } from '../shared/atlas';
import type { RGB } from '../shared/colour';
import { facingOf, isAirKey, type SpriteKey } from '../shared/keys';
import { pixelRing } from '../shared/pixel';
import type { PortraitDraw, UnitArt, UnitDraw } from '../types';
import { ANIMATED, buildModel, MOD_MASK, modelLength, SPRITE_KEYS } from './spriteArt';
import { FORE, LIFT, rasterize, shadowOf, type Model } from './spriteBake';

// ------------------------------------------------------------------------------------------------- models

interface ModelInfo {
  model: Model;
  /** bow to stern / nose to tail, model units */
  len: number;
  /** the larger of the length and the foreshortened span: what must fit a portrait box */
  fit: number;
}
const models = new Map<string, ModelInfo>();
function modelInfo(key: SpriteKey, mods: number, frame: number): ModelInfo {
  const m = mods & MOD_MASK[key];
  const f = ANIMATED.has(key) ? frame & 1 : 0;
  const k = `${key}|${m}|${f}`;
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
    info = { model, len, fit: Math.max(len, (v1 - v0) * FORE + 6 * LIFT) };
    models.set(k, info);
  }
  return info;
}

/** Length of a sprite along its heading, in art pixels (screen px at scale 1). */
export function refinedLength(key: SpriteKey, mods = 0): number {
  return modelInfo(key, mods, 0).len;
}

// ------------------------------------------------------------------------------------------------- atlas

const atlas = new SpriteAtlas();
const KEY_INDEX = new Map<SpriteKey, number>(SPRITE_KEYS.map((k, i) => [k, i]));
/**
 * Art resolutions (art px per model unit): the map always uses full size; small portraits may use less, and a
 * portrait between two whole scales a little more (so a battleship is not drawn smaller than a destroyer).
 */
const RES = [1, 0.75, 0.5, 1.25, 1.5, 1.75];

function entryKey(key: SpriteKey, mods: number, facing: number, frame: number, owner: RGB, res: number, shadow: boolean): number {
  const o = shadow ? 0 : ((owner[0] & 255) << 16) | ((owner[1] & 255) << 8) | (owner[2] & 255);
  return (((((o * 32 + (KEY_INDEX.get(key) ?? 0)) * 32 + mods) * 16 + facing) * 2 + frame) * 8 + res) * 2 + (shadow ? 1 : 0);
}

function entry(key: SpriteKey, mods: number, facing: number, frame: number, owner: RGB, res: number, shadow: boolean): AtlasEntry | null {
  const m = mods & MOD_MASK[key];
  const f = ANIMATED.has(key) ? frame & 1 : 0;
  return atlas.get(entryKey(key, m, facing, f, owner, res, shadow), () => {
    const b = rasterize(modelInfo(key, m, f).model, RES[res] ?? 1, facing, owner);
    return shadow ? shadowOf(b) : b;
  });
}

// ------------------------------------------------------------------------------------------------- drawing

/**
 * Draws a sprite with its centre (the model origin) at (x, y), `k` screen px per art pixel, at the art resolution
 * index `res` into RES (0 = full, 1 = 3/4, 2 = half, 3 to 5 = 1.25 to 1.75 for portraits). Planes and missiles get
 * their ground shadow first (unless `shadow` is false). False when it could not be drawn (no canvas, or this frame's
 * bake budget is spent).
 */
export function drawSpriteKey(ctx: CanvasRenderingContext2D, key: SpriteKey, mods: number, x: number, y: number, k: number, angle: number, owner: RGB, frame = 0, res = 0, alpha = 1, shadow = true): boolean {
  const facing = facingOf(angle);
  const e = entry(key, mods, facing, frame, owner, res, false);
  if (!e) return false;
  const sh = isAirKey(key) && shadow ? entry(key, mods, facing, frame, owner, res, true) : null;
  const prevAlpha = ctx.globalAlpha;
  if (alpha !== 1) ctx.globalAlpha = prevAlpha * alpha;
  if (sh) {
    // a short drop down and right (the light is top left), so the shadow stays one shape under the plane
    const off = key === 'rocket' || key === 'atomBomb' ? 2 : 3;
    drawEntry(ctx, sh, Math.round(x) + off * k, Math.round(y) + off * k, k);
  }
  drawEntry(ctx, e, x, y, k);
  ctx.globalAlpha = prevAlpha;
  return true;
}

/** Turret centres (art px along / across the hull) of the guns of a salvo, by ship (fx/pixelFx.ts SALVO). */
const TURRETS: Partial<Record<SpriteKey, readonly (readonly [number, number])[]>> = {
  warship: [
    [7.6, 0],
    [-10.2, 0],
  ],
  // one turret firing twice
  destroyer: [
    [7.2, 0],
    [7.2, 0],
  ],
  battleship: [
    [11.6, 0],
    [6, 0],
    [-12.8, 0],
  ],
};

/** The refined units: one implementation for ships, land units, planes and missiles. */
export const refinedUnits: UnitArt = {
  lengthPx(key, mods, scale) {
    return refinedLength(key, mods) * scale;
  },

  drawUnit(ctx: CanvasRenderingContext2D, u: UnitDraw, m: MotionParams): boolean {
    void m; // TODO(refined): bob, banking, propellers and the other motion presets (art/motion.ts)
    const frame = ANIMATED.has(u.key) ? Math.floor(u.timeMs / 90) & 1 : 0;
    const ok = drawSpriteKey(ctx, u.key, u.mods, u.x, u.y, u.scale, u.angle, u.owner, frame, 0, u.alpha, u.shadow);
    if (ok && u.key === 'atomBomb') {
      // a faint pixel ring round it so it reads as the big one
      const half = Math.max(6, (refinedLength(u.key, 0) * u.scale) / 2);
      ctx.fillStyle = 'rgba(255,214,120,0.4)';
      pixelRing(ctx, u.x, u.y, (half + 5) / u.scale, u.scale, true);
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
    return drawSpriteKey(ctx, p.key, p.mods, p.x, p.y, k, p.angle, p.owner, 0, res, p.alpha);
  },

  turretPoint(key, _mods, index, x, y, angle, scale) {
    const list = TURRETS[key] ?? TURRETS.warship!;
    const t = list[Math.min(list.length - 1, Math.max(0, index))] ?? [0, 0];
    // the heading the sprite was baked at, the deck foreshortened and lifted like the model
    const h = facingOf(angle) * (Math.PI / 8);
    return { x: x + (Math.cos(h) * t[0] - Math.sin(h) * t[1]) * scale, y: y + (Math.sin(h) * t[0] + Math.cos(h) * t[1]) * scale * 0.84 - 2 * scale };
  },
};
