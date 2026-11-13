// The detailed style's wrecks (client only): units as their deaths draw them (deaths.ts), baked from the same models
// and rasterizer as the living units (models.ts, bake.ts), in the poses a death needs, never a scaled or rotated image:
//   - a plane rolled on its side and turning as it falls, and smaller as it falls away from the viewer (baked at fewer
//     art pixels per model unit, so the pixels stay the map's size);
//   - a tank's hull and its turret on their own, burnt black in steps (charOf: patchy at first, then all of it);
//   - a ship listing and going under (sinkOf): the part under the water dark and see-through, deeper parts gone, a
//     ragged line of foam where the sea meets the hull.
// Their own atlas, so a big battle's deaths never push the units' bakes out, and a small bake budget per frame (about
// 2 ms); a death warms the poses it is about to need (warmWreck) and a pose that cannot be baked this frame borrows the
// nearest one already baked (a neighbouring heading or an earlier step; deaths.ts draws the live unit when there is
// none at all).
import { canBake, SpriteAtlas, type AtlasEntry } from '../shared/atlas';
import { hex, type RGB } from '../shared/colour';
import { SPRITE_KEYS, unitCategoryOf, type SpriteKey } from '../shared/keys';
import { FORE, rasterize, shadowOf, type Baked } from './bake';
import { facingIndex, facingsFor, type Grid } from './grid';
import { MOD_MASK, unitModel } from './models';
import { SPRAY } from './palette';

/** What of a unit is drawn: its body (a tank without its turret), a tank's turret, or the ground shadow of either. */
export type WreckLayer = 'body' | 'turret' | 'shadow' | 'turretShadow';
const LAYERS: WreckLayer[] = ['body', 'turret', 'shadow', 'turretShadow'];

/** Steps of burning (0 none .. CHAR_STEPS burnt black all over) and of going under (0 afloat .. SINK_STEPS gone). */
export const CHAR_STEPS = 3;
export const SINK_STEPS = 8;
/** The rolls a wreck is baked at (radians, each side): the planes' banks. */
export const WRECK_ROLLS = [0, 0.18, 0.4, 0.7] as const;

/** One pose of a wreck (reused by the caller). */
export interface WreckPose {
  key: SpriteKey;
  mods: number;
  owner: readonly number[];
  /** heading (radians, 0 = east, clockwise on screen) */
  angle: number;
  /** art px per model unit (rounded to quarters, at least 0.5) */
  res: number;
  /** roll level -3..3 (WRECK_ROLLS; positive = right side down) */
  roll: number;
  /** 0..CHAR_STEPS */
  char: number;
  /** 0..SINK_STEPS, and which end goes first (1 the bow, -1 the stern) */
  sink: number;
  sinkDir: number;
  layer: WreckLayer;
}

const atlas = new SpriteAtlas(1024, 6);
const KEY_INDEX = new Map<SpriteKey, number>(SPRITE_KEYS.map((k, i) => [k, i]));
const owners = new Map<number, number>();
function ownerIndex(o: readonly number[]): number {
  const k = ((o[0] & 255) << 16) | ((o[1] & 255) << 8) | (o[2] & 255);
  let i = owners.get(k);
  if (i === undefined) {
    if (owners.size >= 250) {
      // the colours' numbers start over: every bake keyed by the old ones goes too, so none comes back in the wrong colour
      owners.clear();
      atlas.clear();
      raws.clear();
    }
    owners.set(k, (i = owners.size));
  }
  return i;
}

/** Bake time per 16 ms of wall clock (ms): a death's poses bake over a few frames, never more than an eighth of one. */
const BAKE_MS = 2;
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

/** The plain rasterized poses (before burning or sinking) of the last few wrecks: the steps of one death share one. */
const raws = new Map<number, Baked>();
const RAW_KEEP = 24;

const quarter = (res: number): number => Math.max(0.5, Math.round(res * 4) / 4);
const facingsOf = (key: SpriteKey, res: number, layer: WreckLayer): number => {
  if (layer === 'turret' || layer === 'turretShadow') return facingsFor(res, 'other');
  const c = unitCategoryOf(key);
  return facingsFor(res, c === 'ships' ? 'ship' : c === 'air' ? 'plane' : 'other');
};
const rollOf = (level: number): number => {
  const l = Math.max(-3, Math.min(3, Math.round(level)));
  return l >= 0 ? WRECK_ROLLS[l] : -WRECK_ROLLS[-l];
};

/** The pose's unit, owner, heading, roll and resolution as one number (under 2e9). */
function baseKey(p: WreckPose, facing: number, resQ: number): number {
  const roll = Math.max(-3, Math.min(3, Math.round(p.roll))) + 3;
  return ((((ownerIndex(p.owner) * 32 + (KEY_INDEX.get(p.key) ?? 0)) * 32 + (p.mods & MOD_MASK[p.key])) * 64 + facing) * 7 + roll) * 17 + Math.min(16, resQ);
}

function keyOf(p: WreckPose, facing: number, resQ: number, char: number, sink: number): number {
  return (((baseKey(p, facing, resQ) * 4 + LAYERS.indexOf(p.layer)) * 4 + char) * 9 + sink) * 2 + (p.sinkDir < 0 ? 0 : 1);
}

function bake(p: WreckPose, facing: number, n: number, res: number, char: number, sink: number): Baked | null {
  const um = unitModel(p.key, p.mods & MOD_MASK[p.key]);
  const turret = p.layer === 'turret' || p.layer === 'turretShadow';
  if (turret && !um.turret) return null;
  const rk = baseKey(p, facing, Math.round(res * 4)) * 2 + (turret ? 1 : 0);
  let raw = raws.get(rk);
  if (!raw) {
    const model = turret ? um.turret!.model : um.model;
    const ship = unitCategoryOf(p.key) === 'ships';
    // a ship lists further than a plane banks at the same level, so its lean shows at a glance (the deck and the
    // funnels shifted toward the low side)
    const roll = turret ? 0 : rollOf(p.roll) * (ship ? 1.45 : 1);
    raw = rasterize(model, res, facing, { facings: n, owner: p.owner, roll, list: roll !== 0 && ship });
    if (raws.size >= RAW_KEEP) raws.delete(raws.keys().next().value as number);
    raws.set(rk, raw);
  }
  if (p.layer === 'shadow' || p.layer === 'turretShadow') return shadowOf(raw);
  let b = raw;
  // a listing ship: its low side darker and narrower (the hull turned away from the light, under the water's edge)
  if (!turret && p.roll !== 0 && unitCategoryOf(p.key) === 'ships') b = heelOf(b, facing * ((Math.PI * 2) / n), res, Math.sign(p.roll), Math.abs(Math.round(p.roll)));
  if (char > 0) b = charOf(b, char);
  if (sink > 0) b = sinkOf(b, sink, facing * ((Math.PI * 2) / n), res, p.sinkDir, Math.sign(p.roll));
  return b;
}

function entryAt(p: WreckPose, facing: number, n: number, res: number, char: number, sink: number, mayBake: boolean): AtlasEntry | null {
  const k = keyOf(p, facing, Math.round(res * 4), char, sink);
  const hit = atlas.peek(k);
  if (hit !== undefined) return hit;
  if (!mayBake || !canBake() || !bakeAllowed()) return null;
  const t0 = typeof performance !== 'undefined' ? performance.now() : 0;
  const e = atlas.get(k, () => bake(p, facing, n, res, char, sink));
  if (typeof performance !== 'undefined') bakeSpent += performance.now() - t0;
  return e;
}

/** The neighbouring headings a pose borrows when its own is not baked yet. */
const NEAR_FACINGS = [1, -1, 2, -2] as const;

/**
 * The baked picture of a pose, or the nearest one already baked (a neighbouring heading, then the steps before it)
 * when this one cannot be baked this frame; null when there is none (no canvas, nothing baked yet).
 */
export function wreckEntry(p: WreckPose): AtlasEntry | null {
  const res = quarter(p.res);
  const n = facingsOf(p.key, res, p.layer);
  const f = facingIndex(p.angle, n);
  const char = Math.max(0, Math.min(CHAR_STEPS, Math.round(p.char)));
  const sink = Math.max(0, Math.min(SINK_STEPS, Math.round(p.sink)));
  const e = entryAt(p, f, n, res, char, sink, true);
  if (e) return e;
  for (let i = 0; i < NEAR_FACINGS.length; i++) {
    const near = entryAt(p, (f + NEAR_FACINGS[i] + n) % n, n, res, char, sink, false);
    if (near) return near;
  }
  // an earlier step of the same heading (less burnt, less far under)
  for (let c = char, k = sink; c > 0 || k > 0; ) {
    if (c > 0) c--;
    if (k > 0) k--;
    const back = entryAt(p, f, n, res, c, k, false);
    if (back) return back;
  }
  return null;
}

/**
 * Bakes a pose a death is about to need (the next step of its burning or sinking, its next heading as it turns),
 * if this frame's budget allows, so it is ready when it is drawn instead of borrowed. Draws nothing.
 */
export function warmWreck(p: WreckPose): void {
  const res = quarter(p.res);
  const n = facingsOf(p.key, res, p.layer);
  entryAt(p, facingIndex(p.angle, n), n, res, Math.max(0, Math.min(CHAR_STEPS, Math.round(p.char))), Math.max(0, Math.min(SINK_STEPS, Math.round(p.sink))), true);
}

/** Draws a pose with its origin at (x, y) CSS px on the art grid `g`, at `alpha`. False when nothing could be drawn. */
export function drawWreck(ctx: CanvasRenderingContext2D, p: WreckPose, x: number, y: number, g: Grid, alpha = 1): boolean {
  if (alpha <= 0.01) return true;
  const e = wreckEntry(p);
  if (!e) return false;
  const k = g.k;
  const X = Math.round(x * g.dpr) / g.dpr - e.ox * k;
  const Y = Math.round(y * g.dpr) / g.dpr - e.oy * k;
  const prev = ctx.globalAlpha;
  const sm = ctx.imageSmoothingEnabled;
  ctx.imageSmoothingEnabled = false;
  ctx.globalAlpha = prev * Math.min(1, alpha);
  ctx.drawImage(e.page, e.sx, e.sy, e.w, e.h, X, Y, e.w * k, e.h * k);
  ctx.globalAlpha = prev;
  ctx.imageSmoothingEnabled = sm;
  return true;
}

// ------------------------------------------------------------------------------------------------- burning and sinking

/** Burnt metal: soot black to a dull burnt brown, darkest first. */
const CHAR: RGB[] = ['#0d0b0a', '#1a1512', '#29211b', '#3a2f26'].map(hex);
/** The sea over a sunken hull. */
const UNDER: RGB = hex('#122029');
const FOAM: RGB = hex(SPRAY[3]);

function hash2(x: number, y: number, s: number): number {
  const v = Math.sin(x * 127.1 + y * 311.7 + s * 74.7) * 43758.5453;
  return v - Math.floor(v);
}
function vnoise(x: number, y: number, s: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const a = hash2(x0, y0, s);
  const b = hash2(x0 + 1, y0, s);
  const c = hash2(x0, y0 + 1, s);
  const d = hash2(x0 + 1, y0 + 1, s);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}

/** Rust and burnt paint at the edges of a burnt hull: a few warm pixels so the outline still reads as a vehicle. */
const RUST: RGB[] = ['#4a2e1d', '#5e3b23'].map(hex);

/**
 * A baked unit burnt `level` of CHAR_STEPS (pure): patches of it burnt black, more of them each step, all of it at the
 * last; what is not burnt yet a little darker. Each burnt pixel takes the burnt tone of its place in the unit's own
 * range of lightness (not of its lightness as such), so a hull painted in one narrow band of tones (a light tank, a
 * tank division) keeps its tracks, deck lines and plates apart instead of turning into one flat slab; its outline stays
 * a shade lighter than the plates inside it, with a few rusty pixels along it. Its rim and shadow are kept.
 */
export function charOf(b: Baked, level: number): Baked {
  const k = Math.max(0, Math.min(1, level / CHAR_STEPS));
  const src = b.data;
  const data = new Uint8ClampedArray(src);
  const lumAt = (o: number): number => (0.299 * src[o] + 0.587 * src[o + 1] + 0.114 * src[o + 2]) / 255;
  let lo = 1;
  let hi = 0;
  for (let o = 0; o < src.length; o += 4) {
    if (src[o + 3] < 250) continue;
    const l = lumAt(o);
    if (l < lo) lo = l;
    if (l > hi) hi = l;
  }
  const span = Math.max(0.08, hi - lo);
  const solid = (x: number, y: number): boolean => x >= 0 && y >= 0 && x < b.w && y < b.h && src[(y * b.w + x) * 4 + 3] >= 250;
  for (let y = 0; y < b.h; y++) {
    for (let x = 0; x < b.w; x++) {
      const o = (y * b.w + x) * 4;
      if (src[o + 3] < 250) continue;
      const rel = (lumAt(o) - lo) / span;
      const edge = !solid(x - 1, y) || !solid(x + 1, y) || !solid(x, y - 1) || !solid(x, y + 1);
      const t = Math.min(3, (rel < 0.3 ? 0 : rel < 0.55 ? 1 : rel < 0.8 ? 2 : 3) + (edge ? 1 : 0));
      const n = vnoise(x * 0.32, y * 0.32, 5.1) * 0.75 + hash2(x, y, 2.3) * 0.25;
      const burnt = k >= 1 || n < k * 1.05 - 0.04;
      if (burnt) {
        const c = edge && hash2(x, y, 6.1) < 0.16 ? RUST[(x + y) & 1] : CHAR[t];
        data[o] = c[0];
        data[o + 1] = c[1];
        data[o + 2] = c[2];
      } else {
        const d = 1 - 0.3 * k;
        data[o] *= d;
        data[o + 1] *= d;
        data[o + 2] *= d;
      }
    }
  }
  return { w: b.w, h: b.h, ox: b.ox, oy: b.oy, data };
}

/**
 * A baked ship listing to `side` (1 its right side down, -1 its left) at roll level `level` 1..3 (pure): its low side
 * shaded darker toward its edge, which loses a pixel or two (the hull turned away and narrower there), and its high
 * side's edge a little lighter, so a first-time viewer sees it lean before it goes. `th` its baked heading.
 */
export function heelOf(b: Baked, th: number, res: number, side: number, level: number): Baked {
  const data = new Uint8ClampedArray(b.data);
  const c = Math.cos(th);
  const s = Math.sin(th);
  const across = (x: number, y: number): number => (-(x + 0.5 - b.ox) * s + ((y + 0.5 - b.oy) / FORE) * c) / res;
  let v0 = Infinity;
  let v1 = -Infinity;
  for (let y = 0; y < b.h; y++)
    for (let x = 0; x < b.w; x++) {
      if (data[(y * b.w + x) * 4 + 3] < 250) continue;
      const v = across(x, y);
      if (v < v0) v0 = v;
      if (v > v1) v1 = v;
    }
  if (!(v1 > v0)) return { w: b.w, h: b.h, ox: b.ox, oy: b.oy, data };
  const half = (v1 - v0) / 2;
  const mid = (v0 + v1) / 2;
  const lk = Math.max(1, Math.min(3, level)) / 3;
  // the outermost pixels of the low side that go (one at a slight list, two at a heavy one), as a share of half the beam
  const trim = Math.min(0.3, (level >= 3 ? 1.6 : level >= 2 ? 1.1 : 0.5) / Math.max(1, half * res));
  for (let y = 0; y < b.h; y++) {
    for (let x = 0; x < b.w; x++) {
      const o = (y * b.w + x) * 4;
      if (data[o + 3] === 0) continue;
      const low = ((across(x, y) - mid) / half) * side;
      if (low > 1 - trim) {
        data[o + 3] = 0;
        continue;
      }
      const f = low > 0 ? 1 - (0.14 + 0.32 * low) * (0.5 + 0.5 * lk) : low < -0.55 ? 1 + 0.16 * lk * ((-low - 0.55) / 0.45) : 1;
      data[o] = data[o] * f;
      data[o + 1] = data[o + 1] * f;
      data[o + 2] = data[o + 2] * f;
    }
  }
  return { w: b.w, h: b.h, ox: b.ox, oy: b.oy, data };
}

/** How far a ship is under at sink step `level` (pure): the water's reach along it, 0 afloat .. past 1 all under. */
export function sinkReach(level: number): number {
  return (Math.max(0, Math.min(SINK_STEPS, level)) / SINK_STEPS) * 1.6 - 0.1;
}

/**
 * A baked ship `level` of SINK_STEPS under (pure): the water climbs it from one end (`dir` 1 the bow, -1 the stern) and
 * from its low side (`side`, the list), so the part under is dark and see-through just under the surface, gone deeper
 * down, with a ragged line of foam where the sea meets the hull. `th` is its baked heading, `res` its resolution.
 */
export function sinkOf(b: Baked, level: number, th: number, res: number, dir: number, side: number): Baked {
  const data = new Uint8ClampedArray(b.data);
  const c = Math.cos(th);
  const s = Math.sin(th);
  // along and across the hull for every pixel (the 3/4 view's lift ignored: the deck lies a little high)
  let u0 = Infinity;
  let u1 = -Infinity;
  let v0 = Infinity;
  let v1 = -Infinity;
  const along = (x: number, y: number): number => ((x + 0.5 - b.ox) * c + ((y + 0.5 - b.oy) / FORE) * s) / res;
  const across = (x: number, y: number): number => (-(x + 0.5 - b.ox) * s + ((y + 0.5 - b.oy) / FORE) * c) / res;
  for (let y = 0; y < b.h; y++)
    for (let x = 0; x < b.w; x++) {
      if (data[(y * b.w + x) * 4 + 3] < 250) continue;
      const a = along(x, y);
      const v = across(x, y);
      if (a < u0) u0 = a;
      if (a > u1) u1 = a;
      if (v < v0) v0 = v;
      if (v > v1) v1 = v;
    }
  if (!(u1 > u0)) return { w: b.w, h: b.h, ox: b.ox, oy: b.oy, data };
  const span = u1 - u0;
  const spanV = Math.max(1, v1 - v0);
  const p = sinkReach(level);
  // one art pixel along the hull, as a share of its length (the waterline is 1 to 2 of them wide)
  const px1 = 1 / Math.max(1, span * res);
  for (let y = 0; y < b.h; y++) {
    for (let x = 0; x < b.w; x++) {
      const o = (y * b.w + x) * 4;
      if (data[o + 3] === 0) continue;
      const a = along(x, y);
      const v = across(x, y);
      // how far up the hull the water has to climb to reach this pixel: from the sinking end, the low side first
      const e = (dir < 0 ? (a - u0) / span : (u1 - a) / span) + (side ? -side * ((v - (v0 + v1) / 2) / spanV) * 0.18 : 0);
      // the sea's edge wanders across the deck (never a ruler-straight wipe) and bunches up where it meets a side
      const wav = (vnoise((v - v0) * res * 0.22 + 2.7, a * 0.05, 4.4) - 0.5) * 7 * px1;
      const side01 = Math.min(v - v0, v1 - v) / spanV;
      const bunch = side01 < 0.2 ? 1 - side01 / 0.2 : 0;
      const d = p - e + wav + (hash2(x, y, 9.7) - 0.5) * 1.2 * px1;
      const band = px1 * (1.1 + 1.6 * bunch + 0.6 * hash2(x, y, 1.9));
      if (d < -band) continue;
      if (d < 0) {
        // the waterline: foam breaking on the hull, 1 or 2 pixels with gaps, thicker at the sides
        if (data[o + 3] >= 250 && hash2(x, y, 3.3) < 0.5 + 0.35 * bunch) {
          data[o] = FOAM[0];
          data[o + 1] = FOAM[1];
          data[o + 2] = FOAM[2];
        }
        continue;
      }
      if (data[o + 3] < 250 || d > 0.42) {
        data[o + 3] = 0;
        continue;
      }
      // under the surface: the sea's colour over it, fainter the deeper it lies (three steps, dithered between)
      const ch = (x + y) & 1;
      const step = d > 0.26 || (d > 0.22 && ch === 0) ? 2 : d > 0.11 || (d > 0.08 && ch === 0) ? 1 : 0;
      const k = step === 2 ? 0.86 : step === 1 ? 0.74 : 0.55;
      data[o] = data[o] + (UNDER[0] - data[o]) * k;
      data[o + 1] = data[o + 1] + (UNDER[1] - data[o + 1]) * k;
      data[o + 2] = data[o + 2] + (UNDER[2] - data[o + 2]) * k;
      data[o + 3] = step === 2 ? 50 : step === 1 ? 105 : 165;
    }
  }
  return { w: b.w, h: b.h, ox: b.ox, oy: b.oy, data };
}
