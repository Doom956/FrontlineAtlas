// The detailed style's damaged units (client only): how hurt a unit is (UnitDraw.damage, 0 full health .. 1 about to
// go down) shown as burning, drawn with the unit every frame so the fire and the smoke go wherever it goes:
//   ships   from about a quarter a thin pale wisp climbing off one hit spot; from about half small flickering fires
//           on deck, each with its warm light on the deck round it and a blackened, scorched patch of plating under
//           it, and dark smoke streaming downwind and back along its wake as it sails (the columns of spots close
//           together merged into one stream, no dotted line); from 0.8 fires in several places, a heavy black column
//           and a slight list (units.ts bakes the hull rolled a little to one side). The spots are fixed per ship
//           (its seed, the unit id).
//   tanks   grey smoke from the engine deck, oily soot from about half, then a fire there, a blaze from 0.8
//   planes  a smoke trail from an engine (soot from about half, at least a few puffs long), then fire streaming from it
// Cheap at mid zoom (fewer and smaller puffs, at most two fires per ship); far out the map draws markers instead.
import type { MotionParams } from '../motion';
import { rnd } from '../shared/noise';
import type { UnitDraw } from '../types';
import { project } from './bake';
import { drawBlob } from './blobs';
import { drawFlame, drawSmokeTrail, WIND_X, type SmokeSource } from './burning';
import type { Grid } from './grid';
import { modelLength, modelSpan, type UnitModel } from './models';

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/** How a ship burns at a level of damage (pure). */
export interface Burn {
  /** smoke at all (0 none .. 1 a full trail) */
  smoke: number;
  /** fires on deck, and how big they are (times the grid's art px per model unit) */
  fires: number;
  fireR: number;
  /** smoke columns (one per burning spot, at most three) */
  columns: number;
  /** the share of a puff's life it stays black (0 grey wisp .. near 1 oily black) */
  dark: number;
  /** 0..1: how far it has gone toward the heavy black column */
  heavy: number;
}

/** The burning of a ship `damage` hurt: nothing under 0.2, a wisp, then fires and dark smoke, then a heavy column. */
export function burnOf(damage: number): Burn {
  const d = damage;
  if (!(d >= 0.2)) return { smoke: 0, fires: 0, fireR: 0, columns: 0, dark: 0, heavy: 0 };
  return {
    smoke: clamp01((d - 0.2) / 0.3) * 0.6 + 0.4,
    fires: d < 0.45 ? 0 : d < 0.62 ? 1 : d < 0.78 ? 2 : d < 0.9 ? 3 : 4,
    fireR: 0.55 + 0.5 * clamp01((d - 0.45) / 0.5),
    columns: d < 0.62 ? 1 : d < 0.85 ? 2 : 3,
    dark: d < 0.45 ? 0 : 0.3 + 0.6 * clamp01((d - 0.45) / 0.45),
    heavy: clamp01((d - 0.75) / 0.2),
  };
}

/** The list of a badly hurt ship: -1 or 1 bank level (a slight roll to one side, fixed per ship), 0 when not listing. */
export function listOf(damage: number, seed: number): number {
  return damage >= 0.8 ? ((Math.floor(seed) & 1) === 1 ? 1 : -1) : 0;
}

/** A ship's hit spots on deck (model units: u along, v across, z the deck), fixed per ship by its seed (pure). */
export function hitSpot(um: UnitModel, seed: number, i: number): [number, number, number] {
  const L = lengthOf(um);
  const B = spanOf(um);
  const hull = um.model.parts[0];
  const z = hull ? hull.z + hull.h + 0.2 : 2;
  const s = Math.floor(seed) * 1.618 + (seed % 1) * 97;
  // the first spot near midships, the others spread fore and aft
  const along = i === 0 ? (rnd(s, 1) - 0.5) * 0.36 : (rnd(s, i * 3 + 1) - 0.5) * 0.66;
  return [along * L, (rnd(s, i * 3 + 2) - 0.5) * B * 0.42, z];
}

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

const src: SmokeSource = { x: 0, y: 0, vx: 0, vy: 0, turn: 0, calm: 0, n: 1, lifeMs: 1000, r0: 1, r1: 2, dark: 0, alpha: 1, u: 1, wind: 1, rise: 1, seed: 0 };

/** How long smoke stays for a motion (smokeLinger): a little shorter under subtle, longer under cinematic. */
const lingerOf = (m: MotionParams): number => Math.max(0.8, Math.min(1.4, 0.7 + 0.3 * m.smokeLinger));

/**
 * The unit's velocity on screen (CSS px per second), slowed so its trail is at most `maxBack` px long over `lifeMs`
 * (a fast unit's smoke would otherwise string out across the map).
 */
function velocity(u: UnitDraw, lifeMs: number, maxBack: number): [number, number] {
  if (!(u.moving || u.speed > 0)) return [0, 0];
  let v = u.speed * u.zoom;
  if (v * (lifeMs / 1000) > maxBack) v = maxBack / (lifeMs / 1000);
  return [Math.cos(u.angle) * v, Math.sin(u.angle) * v];
}

/** Burning on a damaged unit drawn at (x, y) with baked heading `th` and roll `roll`. */
export function drawDamage(ctx: CanvasRenderingContext2D, u: UnitDraw, um: UnitModel, m: MotionParams, g: Grid, th: number, roll: number, x: number, y: number, cat: string): void {
  const prev = ctx.globalAlpha;
  if (cat === 'ships') drawShipBurning(ctx, u, um, m, g, th, roll, x, y);
  else if (cat === 'land') drawTankBurning(ctx, u, um, m, g, th, x, y);
  else if (cat === 'air') drawPlaneSmoke(ctx, u, um, m, g, th, roll, x, y);
  ctx.globalAlpha = prev;
}

function drawShipBurning(ctx: CanvasRenderingContext2D, u: UnitDraw, um: UnitModel, m: MotionParams, g: Grid, th: number, roll: number, x: number, y: number): void {
  const b = burnOf(u.damage);
  if (!b.smoke) return;
  const sc = u.scale;
  const res = g.res;
  const mid = res < 1.5;
  const L = lengthOf(um);
  // a destroyer burns smaller than a battleship
  const size = Math.max(0.75, Math.min(1.3, Math.sqrt(L / 32)));
  const linger = lingerOf(m);
  const life = (1700 + 1300 * b.heavy + (b.fires ? 500 : 0)) * linger;
  // the main column's puffs, and how big they are on average (cells)
  const moving = (u.moving || u.speed > 0) && !m.reduced;
  const nMain = Math.round((mid ? 2 : 5) + (mid ? 2 : 5) * b.heavy + (b.fires ? 1 : 0) + (moving && !mid ? 1 : 0));
  const r0 = res * (0.7 + 0.5 * b.heavy) * size;
  const r1 = (main: boolean): number => res * (2.4 + (b.fires ? 1 : 0) + 2.2 * b.heavy * (main ? 1 : 0.6)) * size;
  // a fast ship would string its puffs out into a dotted line: the trail is kept as long as its puffs can cover
  const [vx, vy] = velocity(u, life, Math.min(L * sc * 2.6, nMain * ((r0 + r1(true)) / 2) * g.k * 2));
  // flames stream with the wind they feel: the wind less the ship's own way through it
  const lean = Math.max(-2, Math.min(2, Math.round((WIND_X - vx / sc) / 4)));
  const base = ctx.globalAlpha;
  // scorched, blackened plates round the spots that were hit (from about half), and the fires' warm light on the deck
  // round them (near zoom only)
  const scorched = mid || b.fires === 0 ? 0 : Math.min(3, b.fires + 1);
  for (let i = 0; i < scorched; i++) {
    const [su, sv, sz] = hitSpot(um, u.seed, i);
    const [dx, dy] = project(su, sv, sz, th, roll, sc, false);
    drawBlob(ctx, 'scorch', res * size * (i === 0 ? 1.5 : 1.1), Math.floor(u.seed + i) & 3, x + dx, y + dy + 0.4 * sc, g, 0.92);
  }
  if (!mid) {
    for (let i = 0; i < b.fires; i++) {
      const [su, sv, sz] = hitSpot(um, u.seed, i);
      const [dx, dy] = project(su, sv, sz, th, roll, sc, false);
      const flick = m.reduced ? 1 : 0.85 + 0.15 * Math.sin(u.timeMs / 90 + i * 2.1);
      drawBlob(ctx, 'glow', Math.max(2, res * b.fireR * size * 2.2), i & 3, x + dx, y + dy, g, 0.42 * flick);
    }
  }
  ctx.globalAlpha = base;
  // the smoke: one column per burning spot, the first the biggest; grey and thin at first, black and heavy later. Under
  // way the columns from spots close together would run astern as parallel strings: they merge into one stream from
  // the middle of the spots, as wide as they were together.
  const columns = moving ? 1 : mid ? Math.min(2, b.columns) : b.columns;
  const merged = moving ? Math.min(mid ? 2 : 3, b.columns) : 1;
  for (let i = 0; i < columns; i++) {
    let su = 0;
    let sv = 0;
    let sz = 0;
    for (let j = 0; j < merged; j++) {
      const h = hitSpot(um, u.seed, i + j);
      su += h[0] / merged;
      sv += h[1] / merged;
      sz += h[2] / merged;
    }
    const [dx, dy] = project(su, sv, sz + 1, th, roll, sc, false);
    const main = i === 0;
    src.x = x + dx;
    src.y = y + dy;
    src.vx = vx;
    src.vy = vy;
    src.turn = m.reduced ? 0 : u.turnRate;
    src.n = (main ? nMain : mid ? 2 : 5) + (merged - 1) * 2;
    src.lifeMs = life * (main ? 1 : 0.8);
    src.r0 = r0 * (1 + 0.2 * (merged - 1));
    src.r1 = r1(main) * (1 + 0.22 * (merged - 1));
    src.dark = b.dark;
    src.alpha = (0.62 + 0.3 * Math.min(1, b.smoke - 0.4 + b.dark * 0.5)) * (main ? 1 : 0.85);
    src.u = sc;
    src.wind = 1 - 0.25 * b.heavy;
    // under way the smoke is laid down low and long astern by the wind of its passage; lying still it climbs off the
    // deck a few cells before the wind bends it over (a thin wisp would otherwise lie on the deck like a stain)
    src.rise = (1 + 0.6 * b.heavy) * (moving ? 0.5 : b.fires ? 1 : 1.8);
    src.calm = moving ? 0 : b.fires ? 0.35 : 0.8;
    if (!b.fires && !moving) {
      // a thin wisp: it climbs well clear of the deck, slowly, and only then leans downwind
      src.lifeMs *= 1.4;
      src.wind = 0.7;
    }
    src.seed = rnd(u.seed, i + 40);
    drawSmokeTrail(ctx, src, g, u.timeMs, m);
  }
  src.calm = 0;
  // the fires on deck, flickering, over their own smoke
  const fires = mid ? Math.min(2, b.fires) : b.fires;
  for (let i = 0; i < fires; i++) {
    const [su, sv, sz] = hitSpot(um, u.seed, i);
    const [dx, dy] = project(su, sv, sz, th, roll, sc, false);
    const r = res * b.fireR * size * (i === 0 ? 1 : 0.8);
    drawFlame(ctx, x + dx, y + dy, r, g, u.timeMs, rnd(u.seed, i + 60), m, 1, lean);
  }
}

function drawTankBurning(ctx: CanvasRenderingContext2D, u: UnitDraw, um: UnitModel, m: MotionParams, g: Grid, th: number, x: number, y: number): void {
  const d = u.damage;
  if (d < 0.3) return;
  const sc = u.scale;
  const res = g.res;
  const L = lengthOf(um);
  const fire = d >= 0.6;
  const heavy = d >= 0.5;
  const life = 1700 * lingerOf(m);
  const n = res < 1.5 ? 3 : 5;
  const r1 = res * (fire ? 3.6 : 3);
  const [vx, vy] = velocity(u, life, Math.min(L * sc * 3, n * ((res * 0.6 + r1) / 2) * g.k * 1.5));
  const [dx, dy] = project(-L * 0.28, 0, 2.2, th, 0, sc, false);
  src.x = x + dx;
  src.y = y + dy;
  src.vx = vx;
  src.vy = vy;
  src.turn = m.reduced ? 0 : u.turnRate;
  src.calm = 0.3;
  src.n = n;
  src.lifeMs = life;
  src.r0 = res * 0.8;
  src.r1 = r1;
  // oily soot from about half (it shows on green ground), a thick grey smoke before
  src.dark = heavy ? 0.75 : 0.45;
  src.alpha = heavy ? 1 : 0.88;
  src.u = sc;
  src.wind = 1;
  src.rise = 1;
  src.seed = rnd(u.seed, 70);
  drawSmokeTrail(ctx, src, g, u.timeMs, m);
  src.calm = 0;
  if (!fire) return;
  const lean = Math.max(-2, Math.min(2, Math.round((WIND_X - vx / sc) / 4)));
  // a fire on the engine deck; badly hurt, a proper blaze (two tongues, the big one at least two cells across)
  const blaze = d >= 0.8;
  const r = blaze ? Math.max(2, res * 1.1) : Math.max(1, res * 0.75);
  if (blaze && res >= 1.5) drawBlob(ctx, 'glow', r * 2.2, 1, x + dx, y + dy, g, 0.35);
  drawFlame(ctx, x + dx, y + dy, r, g, u.timeMs, rnd(u.seed, 71), m, 1, lean);
  if (blaze) drawFlame(ctx, x + dx + 1.2 * res * sc * 0.5, y + dy + 0.3 * sc, r * 0.6, g, u.timeMs + 70, rnd(u.seed, 72), m, 1, lean);
}

function drawPlaneSmoke(ctx: CanvasRenderingContext2D, u: UnitDraw, um: UnitModel, m: MotionParams, g: Grid, th: number, roll: number, x: number, y: number): void {
  const d = u.damage;
  if (d < 0.2) return;
  const sc = u.scale;
  const res = g.res;
  const L = lengthOf(um);
  const fire = d >= 0.5;
  // from an engine on the left wing (a propeller or a jet's nozzle), else from the wing root
  const e = um.props.find((p) => p.v < 0) ?? um.props[0] ?? um.nozzles[0];
  const eu = e ? e.u : 0;
  const ev = e ? e.v : -spanOf(um) * 0.2;
  const ez = e ? e.z : 1;
  const life = 1300 * lingerOf(m);
  const n = res < 1.5 ? 6 : 12;
  const r0 = res * 0.7;
  const r1 = res * (fire ? 3.2 : 2.6);
  // the trail streams back about three plane lengths (its puffs swell to join, see drawSmokeTrail), and is at least
  // two plane lengths and a few puffs long even when the plane is slow (it flies; its smoke streams back)
  const [vx0, vy0] = velocity(u, life, L * sc * 3);
  const minLen = L * sc * 2 + 2 * (r0 + r1) * g.k;
  const v0 = Math.hypot(vx0, vy0);
  const sp = v0 * (life / 1000) < minLen ? minLen / (life / 1000) : v0;
  const vx = Math.cos(u.angle) * sp;
  const vy = Math.sin(u.angle) * sp;
  const [dx, dy] = project(eu - 1, ev, ez, th, roll, sc, false);
  src.x = x + dx;
  src.y = y + dy;
  src.vx = vx;
  src.vy = vy;
  src.turn = m.reduced ? 0 : u.turnRate;
  src.calm = 0;
  src.n = n;
  src.lifeMs = life;
  src.r0 = r0;
  src.r1 = r1;
  // oily black soot from about half, dense near the engine
  src.dark = fire ? 0.8 : 0.4;
  src.alpha = fire ? 0.95 : 0.85;
  src.u = sc;
  src.wind = 0.5;
  src.rise = 0.15;
  src.seed = rnd(u.seed, 80);
  drawSmokeTrail(ctx, src, g, u.timeMs, m);
  if (fire) {
    // fire streaming back from the engine, flickering
    const c = Math.cos(u.angle);
    const s = Math.sin(u.angle);
    const fl = m.reduced ? 0 : Math.floor(u.timeMs / Math.max(40, m.flameMs) + u.seed) & 3;
    const hot = d >= 0.8 ? 1.4 : 1;
    for (let j = 0; j < 3; j++) {
      const back = (0.6 + j * 1.2 + (fl & 1) * 0.4) * sc * hot;
      drawBlob(ctx, 'fire', Math.max(1, res * (0.7 - j * 0.15) * hot), fl + j, x + dx - c * back, y + dy - s * back, g, 1 - j * 0.2, j + (fl >> 1));
    }
  }
}
