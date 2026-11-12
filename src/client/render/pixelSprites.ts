// Shaded pixel sprites for the mobile units on the map, used from mid zoom in (render/units.ts picks the level of
// detail: far = small calm markers and fleet counts, mid and near = these sprites), and for the HUD portraits (the unit
// card and the Forces list call drawUnitSprite).
//
// The art is a small model per unit and arsenal variant (spriteArt.ts), rasterized per heading (16 facings), owner
// colour and upgrade set by spriteBake.ts, never rotated as an image: every facing has square, crisp pixels and the
// same top-left light. Each bake lands once in a shared atlas (a few 1024 px canvases, shelf-packed) and is drawn with
// whole-number scaling and smoothing off. Planes and missiles also get a baked ground shadow. Baking is lazy and has a
// per-frame budget on the map (a unit whose sprite is not baked yet shows its marker for a frame).
//
// What a player owns shows on their units (unitSpriteMods reads the owner's techs, read-only): arsenal variants have
// their own silhouettes and the upgrades add details (spriteArt.ts lists them). All art is original and drawn in code.
import type { GameState, Player, Unit, UnitType, UnitVariant } from '../../sim/types';
import { makeCanvas, type RGB } from './common';
import { FORE, LIFT, rasterize, shadowOf, type Baked, type Model } from './spriteBake';
import { ANIMATED, buildModel, M_JET, M_MASTERY, M_NIGHT, M_PATH3, M_SPECIAL, MOD_MASK, modelLength, SPRITE_KEYS, type SpriteKey } from './spriteArt';

export { M_JET, M_MASTERY, M_NIGHT, M_PATH3, M_SPECIAL, SPRITE_KEYS, type SpriteKey };

const AIR_TYPES: ReadonlySet<UnitType> = new Set<UnitType>(['bomber', 'fighter', 'transportPlane', 'reconPlane', 'rocket', 'atomBomb']);
const AIR_KEYS: ReadonlySet<SpriteKey> = new Set<SpriteKey>(['bomber', 'groundAttack', 'heavyBomber', 'fighter', 'transportPlane', 'reconPlane', 'rocket', 'atomBomb']);

/** Sprite key of a unit: arsenal variants have their own art; the unit before any arsenal pick keeps its plain look. */
export function spriteKey(type: UnitType, variant: UnitVariant | undefined): SpriteKey {
  if (type === 'warship') return variant === 'destroyer' || variant === 'battleship' || variant === 'submarine' || variant === 'carrier' ? variant : 'warship';
  if (type === 'tankDivision') return variant === 'lightTank' || variant === 'heavyTank' ? variant : 'tankDivision';
  if (type === 'bomber') return variant === 'groundAttack' || variant === 'heavyBomber' ? variant : 'bomber';
  return type;
}

/** True when the unit has pixel art (every unit type and variant does). */
export function hasSprite(type: UnitType, variant?: UnitVariant): boolean {
  return SPRITE_KEYS.includes(spriteKey(type, variant));
}

/** True for planes and missiles (drawn above ships and tanks, with a ground shadow). */
export function isAirType(type: UnitType): boolean {
  return AIR_TYPES.has(type);
}

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

/** Length of a unit's sprite along its heading, in art pixels (screen px at scale 1). */
export function spriteLength(type: UnitType, variant: UnitVariant | undefined, mods = 0): number {
  return modelInfo(spriteKey(type, variant), mods, 0).len;
}

// ------------------------------------------------------------------------------------------------- atlas

const PAGE = 1024;
const MAX_PAGES = 6;
interface Page {
  c: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
}
interface Entry {
  page: HTMLCanvasElement;
  sx: number;
  sy: number;
  w: number;
  h: number;
  ox: number;
  oy: number;
}
const pages: Page[] = [];
let shelfX = 0;
let shelfY = 0;
let shelfH = 0;
const entries = new Map<number, Entry | null>();
/** bakes left this frame (the map sets it; portraits are not limited) */
let budget = Infinity;
/** sprites baked since the page loaded (stats) */
export const spriteStats = { baked: 0, resets: 0 };

function resetAtlas(): void {
  for (const p of pages) p.ctx.clearRect(0, 0, PAGE, PAGE);
  shelfX = 0;
  shelfY = 0;
  shelfH = 0;
  entries.clear();
  spriteStats.resets++;
}

function alloc(w: number, h: number): { page: Page; x: number; y: number } | null {
  if (w + 1 > PAGE || h + 1 > PAGE) return null;
  if (shelfX + w + 1 > PAGE) {
    shelfX = 0;
    shelfY += shelfH + 1;
    shelfH = 0;
  }
  let pi = pages.length - 1;
  if (pi < 0 || shelfY + h + 1 > PAGE) {
    if (pages.length >= MAX_PAGES) {
      // every page is full: start over (the visible sprites bake again over the next frames)
      resetAtlas();
      pi = 0;
    } else {
      const c = makeCanvas(PAGE, PAGE);
      const ctx = c.getContext('2d');
      if (!ctx) return null;
      pages.push({ c, ctx });
      pi = pages.length - 1;
      shelfX = 0;
      shelfY = 0;
      shelfH = 0;
    }
  }
  const x = shelfX;
  const y = shelfY;
  shelfX += w + 1;
  shelfH = Math.max(shelfH, h);
  return { page: pages[pi], x, y };
}

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

function entry(key: SpriteKey, mods: number, facing: number, frame: number, owner: RGB, res: number, shadow: boolean): Entry | null {
  const m = mods & MOD_MASK[key];
  const f = ANIMATED.has(key) ? frame & 1 : 0;
  const ek = entryKey(key, m, facing, f, owner, res, shadow);
  const hit = entries.get(ek);
  if (hit !== undefined) return hit;
  if (typeof document === 'undefined' || typeof ImageData === 'undefined') return null;
  if (budget <= 0) return null;
  budget--;
  let b: Baked = rasterize(modelInfo(key, m, f).model, RES[res] ?? 1, facing, owner);
  if (shadow) b = shadowOf(b);
  const spot = alloc(b.w, b.h);
  if (!spot) {
    entries.set(ek, null);
    return null;
  }
  spot.page.ctx.putImageData(new ImageData(b.data, b.w, b.h), spot.x, spot.y);
  spriteStats.baked++;
  const e: Entry = { page: spot.page.c, sx: spot.x, sy: spot.y, w: b.w, h: b.h, ox: b.ox, oy: b.oy };
  entries.set(ek, e);
  return e;
}

/** The map limits how many sprites it bakes per frame (Infinity = no limit; the map sets it back after drawing). */
export function setSpriteBakeBudget(n: number): void {
  budget = n;
}

// ------------------------------------------------------------------------------------------------- drawing

const STEP = (Math.PI * 2) / 16;
/** Heading in radians to one of the 16 baked facings (0 = east, clockwise on screen). */
export function facingOf(angle: number): number {
  return ((Math.round(angle / STEP) % 16) + 16) % 16;
}

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
  const sh = AIR_KEYS.has(key) && shadow ? entry(key, mods, facing, frame, owner, res, true) : null;
  const prevSmooth = ctx.imageSmoothingEnabled;
  const prevAlpha = ctx.globalAlpha;
  ctx.imageSmoothingEnabled = false;
  if (alpha !== 1) ctx.globalAlpha = prevAlpha * alpha;
  const dx = Math.round(x) - e.ox * k;
  const dy = Math.round(y) - e.oy * k;
  if (sh) {
    // a short drop down and right (the light is top left), so the shadow stays one shape under the plane
    const off = key === 'rocket' || key === 'atomBomb' ? 2 : 3;
    ctx.drawImage(sh.page, sh.sx, sh.sy, sh.w, sh.h, dx + off * k, dy + off * k, sh.w * k, sh.h * k);
  }
  ctx.drawImage(e.page, e.sx, e.sy, e.w, e.h, dx, dy, e.w * k, e.h * k);
  ctx.imageSmoothingEnabled = prevSmooth;
  ctx.globalAlpha = prevAlpha;
  return true;
}

/**
 * A unit's sprite on the map: full art resolution, `k` screen px per art pixel (the same for every unit at one zoom,
 * so they read as one set). False when it could not be drawn this frame (draw its marker instead).
 */
export function drawMapSprite(ctx: CanvasRenderingContext2D, type: UnitType, variant: UnitVariant | undefined, x: number, y: number, k: number, angle: number, owner: RGB, mods: number, nowMs: number): boolean {
  const key = spriteKey(type, variant);
  const frame = ANIMATED.has(key) ? Math.floor(nowMs / 90) & 1 : 0;
  return drawSpriteKey(ctx, key, mods, x, y, k, angle, owner, frame, 0);
}

/**
 * Draws a unit's pixel sprite centred at (x, y), fitting in `lenPx` px (its length, or its span for wide planes),
 * turned to `angle` (snapped to 16 headings). Used by the HUD portraits: the scale is a whole number so the pixels
 * stay crisp, and the art resolution fills the rest of the box in quarter steps (a smaller one when even the
 * whole-number scale 1 does not fit), so every unit fills its portrait about equally. `mods` are the upgrade details to show;
 * without it, the details of the player whose colour `owner` is are used (in the game the map shows), and a tank
 * division without a variant gets that player's armor path.
 */
export function drawUnitSprite(ctx: CanvasRenderingContext2D, type: UnitType, variant: UnitVariant | undefined, x: number, y: number, lenPx: number, angle: number, owner: RGB, alpha = 1, mods?: number): boolean {
  let v = variant;
  let m = mods;
  if (m === undefined) {
    m = 0;
    const p = playerByColour(owner);
    if (p && seenState) {
      if (type === 'tankDivision' && !v) v = armorVariantOf(p);
      m = modsFor(seenState, p.id, type, v);
    }
  }
  const key = spriteKey(type, v);
  const info = modelInfo(key, m, 0);
  const s = lenPx / info.fit;
  let res = 0;
  let k = 1;
  if (s < 1) res = s >= 0.75 ? 1 : 2;
  else {
    k = Math.min(8, Math.floor(s));
    // 1.25, 1.5 or 1.75 art px per model unit when the box has that much room left at this whole-number scale
    const q = Math.min(3, Math.floor((s / k - 1) * 4));
    res = q <= 0 ? 0 : 2 + q;
  }
  return drawSpriteKey(ctx, key, m, x, y, k, angle, owner, 0, res, alpha);
}

// ------------------------------------------------------------------------------------------------- upgrades

/** The game whose players the portraits look up by colour (the renderer sets it every frame). */
let seenState: GameState | null = null;
export function setSpriteState(state: GameState | null): void {
  seenState = state;
}
function playerByColour(c: RGB): Player | null {
  const s = seenState;
  if (!s) return null;
  for (const p of s.players) if (p && p.color && p.color[0] === c[0] && p.color[1] === c[1] && p.color[2] === c[2]) return p;
  return null;
}
function armorVariantOf(p: Player): UnitVariant | undefined {
  return p.techs.includes('lightTanks') ? 'lightTank' : p.techs.includes('heavyTanks') ? 'heavyTank' : undefined;
}

interface OwnerMods {
  n: number;
  navy: number;
  armor: number;
  light: number;
  heavy: number;
  bomber: number;
  heavyBomber: number;
  fighter: number;
  cargo: number;
  recon: number;
}
const ownerMods = new WeakMap<GameState, Map<number, OwnerMods>>();

function computeOwner(p: Player): OwnerMods {
  const t = new Set(p.techs);
  const armor = (t.has('armorMastery') ? M_MASTERY : 0) | (t.has('amphibiousTanks') ? M_SPECIAL : 0);
  const air = (t.has('airMastery') ? M_MASTERY : 0) | (t.has('dropTanks') ? M_SPECIAL : 0);
  const jet = t.has('jetEngines') ? M_JET : 0;
  const night = t.has('nightBombing') ? M_NIGHT : 0;
  return {
    n: p.techs.length,
    navy: (t.has('navalMastery') ? M_MASTERY : 0) | (t.has('navalMines') ? M_SPECIAL : 0),
    armor,
    light: armor | (t.has('deepRaids') ? M_PATH3 : 0),
    heavy: armor | (t.has('siegeTanks') ? M_PATH3 : 0),
    bomber: air | jet | night,
    heavyBomber: air | night | (t.has('strategicBombing') ? M_PATH3 : 0),
    fighter: air | jet,
    cargo: (t.has('dropTanks') ? M_SPECIAL : 0) | jet,
    recon: t.has('dropTanks') ? M_SPECIAL : 0,
  };
}

/** Upgrade details (spriteArt.ts M_*) a unit of `owner` shows, from the owner's techs (read only, cached per owner). */
export function modsFor(state: GameState, owner: number, type: UnitType, variant: UnitVariant | undefined): number {
  const p = state.players[owner];
  if (!p || !p.techs) return 0;
  let per = ownerMods.get(state);
  if (!per) ownerMods.set(state, (per = new Map()));
  let o = per.get(owner);
  if (!o || o.n !== p.techs.length) per.set(owner, (o = computeOwner(p)));
  switch (type) {
    case 'warship':
      return o.navy;
    case 'tankDivision':
      return variant === 'lightTank' ? o.light : variant === 'heavyTank' ? o.heavy : o.armor;
    case 'bomber':
      return variant === 'heavyBomber' ? o.heavyBomber : o.bomber;
    case 'fighter':
      return o.fighter;
    case 'transportPlane':
      return o.cargo;
    case 'reconPlane':
      return o.recon;
    default:
      return 0;
  }
}

/** Upgrade details of one unit on the map. */
export function unitSpriteMods(state: GameState, u: Unit): number {
  return modsFor(state, u.owner, u.type, u.variant);
}

// ------------------------------------------------------------------------------------------------- far zoom

/**
 * Far zoom marker: a tiny solid shape in the owner's colour with a dark edge, one per unit class (ship = lozenge,
 * tank = square, plane = small arrow, missile = dot). No detail, so hundreds of them stay calm.
 */
export function drawUnitMarker(ctx: CanvasRenderingContext2D, type: UnitType, x: number, y: number, size: number, angle: number, fill: string): void {
  const s = size;
  ctx.save();
  ctx.translate(x, y);
  ctx.beginPath();
  if (type === 'tankDivision') {
    ctx.rect(-s * 0.42, -s * 0.42, s * 0.84, s * 0.84);
  } else if (type === 'rocket' || type === 'atomBomb') {
    ctx.arc(0, 0, s * (type === 'atomBomb' ? 0.42 : 0.32), 0, Math.PI * 2);
  } else if (type === 'bomber' || type === 'fighter' || type === 'transportPlane' || type === 'reconPlane') {
    ctx.rotate(angle);
    ctx.moveTo(s * 0.55, 0);
    ctx.lineTo(-s * 0.45, s * 0.45);
    ctx.lineTo(-s * 0.2, 0);
    ctx.lineTo(-s * 0.45, -s * 0.45);
    ctx.closePath();
  } else {
    ctx.rotate(angle);
    ctx.moveTo(s * 0.62, 0);
    ctx.lineTo(s * 0.2, s * 0.3);
    ctx.lineTo(-s * 0.55, s * 0.3);
    ctx.lineTo(-s * 0.55, -s * 0.3);
    ctx.lineTo(s * 0.2, -s * 0.3);
    ctx.closePath();
  }
  ctx.lineWidth = 2.5;
  ctx.lineJoin = 'round';
  ctx.strokeStyle = 'rgba(14,18,24,0.8)';
  ctx.stroke();
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.restore();
}
