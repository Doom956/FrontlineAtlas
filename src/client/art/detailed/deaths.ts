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
//   missile  shot down in the air: a flash, a fireball and black smoke left hanging where it burst in two or three
//            lumps drifting apart, its pieces thrown out unevenly (a few long burning ones downwind trailing smoke from
//            the fireball's edge, short stubs, bare bits), the trails sagging and breaking up from their near end, a
//            few landing as small blasts on land or low bursts of spray on the sea, the biggest last; never one stalk
//            under one cap. An atom bomb only bursts bigger, with more pieces: never like its detonation.
//   tank     a blast and a fireball, the turret thrown off tumbling (its shadow under it) and landing beside the hull,
//            the hull a burning wreck (a fire roaring from the turret ring, fires on the engine deck) under black
//            smoke, burning black in patches, then a charred hull with a few embers on a scorched patch that fades.
//   ship     hit (one blast, more on a big ship), it lists to one side (its low side darker and narrower, the smoke
//            leaning) and burns on deck under a heavy black column, goes under from one end (the sea climbing the hull
//            in a ragged line of foam, spray flicking off, fires going out in a puff of steam), leaving a dark oil
//            slick, loose specks and lace of foam, bubbles and a few floating planks that fade.
// Close up the whole sequence; at mid zoom fewer puffs and pieces; zoomed out (the map draws unit markers, zoom under
// 3) only the blasts, fire and smoke; farther out the map's far blink. Reduced motion: still frames.
// Each death draws in two layers (DeathDraw.layer): what lies on the ground or the sea (slick, foam, floating and sunk
// wreckage, a burnt hull, a landed turret, scorch, shadows) under the units, the rest (a falling plane, a turret in the
// air, fireballs, flashes, flames, smoke) over them; the art lab draws both at once.
import type { MotionParams } from '../motion';
import { rnd } from '../shared/noise';
import type { SpriteKey } from '../shared/keys';
import { DEATH_GLIDE_TILES, type DeathDraw, type DeathKind, type DeathTimes, type ExplosionArt, type UnitDraw } from '../types';
import { FORE, LIFT, project } from './bake';
import { drawBlob, type BlobKind } from './blobs';
import { drawFlame, RISE, WIND_X, WIND_Y } from './burning';
import { hitSpot } from './damage';
import { blastAt, detailedExplosions, flashCore, flashGlow, speck } from './explosions';
import { facingIndex, facingsFor, gridOf, type Grid } from './grid';
import { modelLength, modelSpan, MOD_MASK, unitModel, type UnitModel } from './models';
import { DEBRIS, FIRE, MATERIALS, SPRAY, TRACER, type MaterialId } from './palette';
import { detailedUnits } from './units';
import { CHAR_STEPS, drawWreck, SINK_STEPS, sinkReach, warmWreck, WRECK_ROLLS, type WreckPose } from './wrecks';

const TAU = Math.PI * 2;
const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
const easeOut = (t: number): number => 1 - (1 - t) * (1 - t);
const easeOut3 = (t: number): number => 1 - (1 - t) ** 3;
const smooth = (t: number): number => t * t * (3 - 2 * t);
const frac = (v: number): number => v - Math.floor(v);
/** How long smoke stays: the motion's smokeLinger, kept in a sane range. */
const lingerOf = (m: MotionParams): number => Math.max(0.6, Math.min(2.2, m.smokeLinger));
/** Whether this call draws what lies on the ground or the sea, and what stands up or flies (DeathDraw.layer). */
const onGround = (d: DeathDraw): boolean => d.layer !== 'air';
const inAir = (d: DeathDraw): boolean => d.layer !== 'ground';

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

const liveArgs: UnitDraw = { key: 'bomber', mods: 0, owner: [128, 128, 128], x: 0, y: 0, angle: 0, zoom: 1, scale: 1, lod: 'near', dpr: 1, timeMs: 0, turnRate: 0, speed: 0, moving: false, seed: 0, alpha: 1, shadow: false, damage: 0 };

/**
 * Draws a wreck's pose; when nothing of it is baked yet (not even a neighbouring heading or an earlier step) and it
 * still looks much as it did alive (hardly burnt, hardly under), the unit as it was from the units' own atlas, so a
 * falling plane or a sinking hull never vanishes for a few frames.
 */
function wreckOrLive(ctx: CanvasRenderingContext2D, d: DeathDraw, m: MotionParams, p: WreckPose, x: number, y: number, g: Grid, alpha = 1): void {
  if (drawWreck(ctx, p, x, y, g, alpha)) return;
  if (p.layer !== 'body' || p.sink > 1 || p.char > 1) return;
  const a = liveArgs;
  a.key = d.key;
  a.mods = d.mods;
  a.owner = d.owner;
  a.x = x;
  a.y = y;
  a.angle = p.angle;
  a.zoom = d.zoom;
  a.scale = d.scale;
  a.dpr = d.dpr;
  a.timeMs = d.ageMs;
  a.seed = d.seed;
  a.alpha = alpha;
  const prev = ctx.globalAlpha;
  detailedUnits.drawUnit(ctx, a, m);
  ctx.globalAlpha = prev;
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
function groundDebris(ctx: CanvasRenderingContext2D, x: number, y: number, R: number, age: number, life: number, end: number, g: Grid, u: number, sd: number, n: number, m: MotionParams, timeMs: number, fires: number, fly: boolean, lie: boolean): void {
  const prev = ctx.globalAlpha;
  for (let i = 0; i < n; i++) {
    const fl = life * (0.6 + 0.4 * rnd(sd, i + 200));
    const k = age / fl;
    const ang = -Math.PI / 2 + (rnd(sd, i + 201) - 0.5) * 2.9;
    const v = R * (2.2 + 2.8 * rnd(sd, i + 202));
    const big = i % 3 === 0;
    if (k < 1) {
      if (!fly) continue;
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
    if (!lie) continue;
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

/**
 * A column of smoke standing on a fire at (x, y): puffs born at the fire in turn, climbing and carried off downwind as
 * they age, each its own size and a little off the line, so it billows instead of reading as a tube; it widens and
 * bends (the whole column sways, more the higher it is) as it rises, thins out near its top (puffs fall away and
 * fade) and is at most `maxLen` CSS px long (a short life when the wind and the rise would carry it farther), so it
 * stays near its wreck. `lean` (art units a second) tilts it, as a listing ship's funnel smoke. `alpha` 0..1.
 */
function column(ctx: CanvasRenderingContext2D, x: number, y: number, g: Grid, u: number, timeMs: number, m: MotionParams, n: number, lifeMs: number, r0: number, r1: number, dark: number, alpha: number, seed: number, rise: number, maxLen: number, lean = 0): void {
  if (alpha <= 0.02) return;
  const speed = Math.hypot(WIND_X * 0.8 + lean, RISE * rise) * u;
  const life = Math.max(700, Math.min(lifeMs, (maxLen / Math.max(1e-3, speed)) * 1000));
  // a longer life gets more puffs, so the column stays one mass instead of a string of beads
  const N = Math.max(3, Math.min(18, Math.round(n * Math.max(1, life / 2100))));
  const t0 = m.reduced ? 0.5 / N : timeMs / life + seed * 0.37;
  // the gap between two puffs born one after the other (cells): the low ones are at least that wide, so they join
  const join = ((speed * life) / 1000 / N / g.k) * 0.55;
  const sd = seed * 97.1 + 13;
  const calm = 0.6;
  // the oldest puff first, so the fresh dark ones at the fire lie on top
  const k0 = (((Math.ceil((1 - frac(t0)) * N) - 1) % N) + N) % N;
  for (let j = 0; j < N; j++) {
    const k = (k0 - j + N) % N;
    const ph = t0 + k / N;
    const a = frac(ph);
    const id = (Math.floor(ph) * 31 + k) % 997;
    // thinning out toward the top: puffs drop out
    if (a > 0.55 && rnd(sd + id, 4) < (a - 0.55) * 1.7) continue;
    const sec = (a * life) / 1000;
    const ws = (sec * sec) / (sec + calm);
    const sz = 0.7 + 0.6 * rnd(sd + id, 3);
    const r = Math.max(1, (r0 + (r1 - r0) * easeOut(a)) * sz);
    const sway = Math.sin((m.reduced ? 0 : timeMs) / 2300 + seed * 6.1 + a * 2.6) * u * 4 * a * a;
    const px = x + WIND_X * u * 0.8 * ws + lean * u * sec + sway + (rnd(sd + id, 1) - 0.5) * r * g.k * (0.6 + 1.3 * a);
    const py = y + WIND_Y * u * 0.8 * ws - RISE * rise * u * sec + (rnd(sd + id, 2) - 0.5) * r * g.k * 0.35;
    const rr = a < 0.5 ? Math.max(r, join * (0.85 + 0.3 * a)) : r;
    const pa = alpha * (a < 0.08 ? a / 0.08 : 1) * (1 - a) ** 1.5;
    const kind: BlobKind = dark > 0 ? (a < dark * 0.6 ? 'soot' : a < dark ? 'shade' : 'smoke') : a < 0.12 ? 'smoke' : 'vapour';
    drawBlob(ctx, kind, rr, id & 3, px, py, g, pa);
  }
}

/** A floating plank: dark wood, and the edge of it catching the light. */
const PLANK = ['#3a332c', '#463d33'] as const;
const PLANK_LIT = '#aca596';

/**
 * Wreckage floating on the sea round (x, y): `n` planks, each 2 or 3 art pixels of dark wood lying one of three ways
 * with one pixel of a lighter edge, bobbing and drifting downwind, `alpha` 0..1.
 */
function floating(ctx: CanvasRenderingContext2D, x: number, y: number, rx: number, ry: number, n: number, age: number, g: Grid, u: number, sd: number, alpha: number, still: boolean, paint?: readonly [string, string, string]): void {
  if (alpha <= 0.02) return;
  const prev = ctx.globalAlpha;
  for (let i = 0; i < n; i++) {
    const a = rnd(sd, i + 300) * TAU;
    const d = Math.sqrt(rnd(sd, i + 301));
    const sec = still ? 0 : age / 1000;
    const px = x + Math.cos(a) * d * rx + WIND_X * u * sec * 0.22;
    const py = y + Math.sin(a) * d * ry + (still ? 0 : Math.sin(age / 430 + i * 1.7) * 0.6 * u);
    ctx.globalAlpha = prev * alpha * (0.8 + 0.2 * rnd(sd, i + 302));
    const len = rnd(sd, i + 303) < 0.45 ? 3 : 2;
    const way = Math.floor(rnd(sd, i + 304) * 3);
    const sy = way === 0 ? 0 : way === 1 ? g.k : -g.k;
    for (let j = 0; j < len; j++) speck(ctx, px + j * g.k, py + j * sy, g, 1, paint ? paint[(i + j) & 1] : PLANK[(i + j) & 1]);
    speck(ctx, px + (way === 2 ? (len - 1) * g.k : 0), py + (way === 2 ? (len - 1) * sy : 0) - g.k, g, 1, paint ? paint[2] : PLANK_LIT);
  }
  ctx.globalAlpha = prev;
}

/** A plane's own paint (two tones and a lit edge) for the pieces of it floating where it went in. */
const PLANE_PAINT: Partial<Record<SpriteKey, MaterialId>> = { bomber: 'odplane', groundAttack: 'camo', heavyBomber: 'alu', fighter: 'seagrey', transportPlane: 'cargo', reconPlane: 'prublue' };
function paintOf(key: SpriteKey): readonly [string, string, string] | undefined {
  const m = PLANE_PAINT[key];
  if (!m) return undefined;
  const r = MATERIALS[m];
  return [r[2], r[1], r[3]];
}

/** A ragged rim of light sheen round an oil slick at (x, y), radii (rx, ry) px, one art pixel specks. */
function sheen(ctx: CanvasRenderingContext2D, x: number, y: number, rx: number, ry: number, g: Grid, sd: number, alpha: number, mid: boolean): void {
  if (alpha <= 0.02) return;
  const prev = ctx.globalAlpha;
  ctx.globalAlpha = prev * alpha;
  const n = mid ? 14 : 28;
  for (let i = 0; i < n; i++) {
    const t = (i / n) * TAU + rnd(sd, i + 960) * 0.2;
    const k = 0.9 + 0.2 * rnd(sd, i + 961);
    speck(ctx, x + Math.cos(t) * rx * k, y + Math.sin(t) * ry * k, g, 1, SPRAY[2]);
  }
  ctx.globalAlpha = prev;
}

/**
 * The foam churned up where a ship went down, round (x, y) (rx, ry px): loose broken white specks, thickest in the
 * middle and thinning out toward the edge, and short curved strands of lace, each a single art pixel wide; `k` 0..1 its
 * age (the outer specks and the lace go first), `alpha` 0..1.
 */
function churn(ctx: CanvasRenderingContext2D, x: number, y: number, rx: number, ry: number, k: number, g: Grid, sd: number, alpha: number, mid: boolean): void {
  if (alpha <= 0.02) return;
  const prev = ctx.globalAlpha;
  const n = mid ? 34 : 76;
  for (let i = 0; i < n; i++) {
    const life = 0.35 + 0.65 * rnd(sd, i + 500);
    const d = rnd(sd, i + 502) ** 1.6;
    if (k > life * (1 - 0.45 * d)) continue;
    const ang = rnd(sd, i + 501) * TAU;
    ctx.globalAlpha = prev * alpha * (0.55 + 0.45 * (1 - d));
    speck(ctx, x + Math.cos(ang) * d * rx, y + Math.sin(ang) * d * ry, g, 1, d < 0.45 || i % 3 === 0 ? SPRAY[3] : SPRAY[2]);
  }
  const nl = mid ? 3 : 8;
  for (let l = 0; l < nl; l++) {
    const life = 0.3 + 0.55 * rnd(sd, l + 520);
    if (k > life) continue;
    const ang = rnd(sd, l + 521) * TAU;
    const d = 0.2 + 0.7 * rnd(sd, l + 522);
    const cx = x + Math.cos(ang) * d * rx;
    const cy = y + Math.sin(ang) * d * ry;
    const rho = (2 + 2.5 * rnd(sd, l + 523)) * g.k;
    const a0 = rnd(sd, l + 524) * TAU;
    const len = 3 + Math.floor(rnd(sd, l + 525) * 3);
    ctx.globalAlpha = prev * alpha * 0.85 * (1 - k / life);
    for (let j = 0; j < len; j++) {
      const t = a0 + j * (g.k / rho) * 1.15;
      speck(ctx, cx + Math.cos(t) * rho, cy + Math.sin(t) * rho * 0.55, g, 1, SPRAY[3]);
    }
  }
  ctx.globalAlpha = prev;
}

/**
 * An oil slick of radius `r` cells at (x, y): one blob, or past 38 cells three overlapping lobes of one (a big blob
 * is drawn with coarser cells, which would show as square blocks on the water).
 */
function slick(ctx: CanvasRenderingContext2D, r: number, variant: number, x: number, y: number, g: Grid, alpha: number, age: number): void {
  if (r <= 38) {
    drawBlob(ctx, 'oil', r, variant, x, y, g, alpha, age);
    return;
  }
  const rr = Math.min(38, r * 0.64);
  const off = (r - rr) * g.k;
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * TAU + variant * 0.7;
    drawBlob(ctx, 'oil', rr, (variant + i) & 3, x + Math.cos(a) * off * 0.8, y + Math.sin(a) * off * 0.42, g, alpha, age);
  }
}

/**
 * A plane going into the sea at (x, y), `a` ms in: a wide ragged foot (a low skirt of spray and a ring of specks
 * thrown out over the water) and a thick column of water thrown up, whose top then spreads into a crown and falls
 * back on itself, its edges broken by loose specks. `R` model units, about the crash's fireball.
 */
function crashSplash(ctx: CanvasRenderingContext2D, x: number, y: number, a: number, g: Grid, u: number, R: number, sd: number, m: MotionParams, mid: boolean): void {
  const T = 1300 * m.blastTime;
  if (a < 0 || a >= T) return;
  const q = a / T;
  const prev = ctx.globalAlpha;
  // the foot: spray thrown out round it, flicking up a little and falling, fading
  const nf = mid ? 10 : 22;
  for (let i = 0; i < nf; i++) {
    const ang = ((i + 0.7 * rnd(sd, i + 800)) / nf) * TAU;
    const spd = 0.55 + 0.7 * rnd(sd, i + 801);
    const qq = Math.min(1, q * (1.4 + 0.6 * spd));
    const rr = R * u * (0.3 + 1.15 * easeOut(qq) * spd);
    const lift = 4 * qq * (1 - qq) * R * u * 0.22 * rnd(sd, i + 802);
    ctx.globalAlpha = prev * (1 - q) ** 1.1;
    speck(ctx, x + Math.cos(ang) * rr, y + Math.sin(ang) * rr * 0.5 - lift, g, i % 5 === 0 && q < 0.3 ? 2 : 1, i % 3 === 0 ? SPRAY[2] : SPRAY[3]);
  }
  // a broad low skirt of spray at its foot, spreading out
  const foot = R * g.res * (0.35 + 0.45 * easeOut(clamp01(q * 2)));
  const fa = 0.8 * (1 - smooth(clamp01((q - 0.35) / 0.65)));
  for (let i = 0; i < 3; i++) drawBlob(ctx, 'spray', Math.max(1, foot * (i === 1 ? 0.75 : 0.55)), (i + 2) & 3, x + (i - 1) * foot * g.k * 0.9, y - g.k * (i === 1 ? 1 : 0), g, fa);
  // the column: thick at its foot (never pinched there), thrown up fast, then its top spreading out into a crown and
  // falling back on itself as the column sinks
  const up = clamp01(q / 0.32);
  const back = clamp01((q - 0.32) / 0.68);
  const H = R * u * 1.15 * easeOut(up) * (1 - back * back);
  const ca = 0.9 * (1 - smooth(clamp01((q - 0.45) / 0.55)));
  const J = mid ? 4 : 6;
  for (let j = 0; j < J; j++) {
    const f = j / (J - 1);
    const w = R * g.res * (0.46 - 0.1 * f) * (1 + 0.4 * back);
    const crown = f > 0.5 ? ((f - 0.5) / 0.5) * back : 0;
    const spread = crown * R * u * 0.9;
    const yy = y - f * H + crown * R * u * 0.5;
    const jx = (rnd(sd, j + 820) - 0.5) * w * g.k * 0.6;
    if (spread < g.k) drawBlob(ctx, 'spray', Math.max(1, w), j & 3, x + jx, yy, g, ca);
    else {
      drawBlob(ctx, 'spray', Math.max(1, w * 0.7), j & 3, x - spread + jx, yy, g, ca * 0.85);
      drawBlob(ctx, 'spray', Math.max(1, w * 0.7), (j + 1) & 3, x + spread + jx, yy, g, ca * 0.85);
    }
  }
  // loose specks round the column and drops falling off it, so its edge never reads as a regular dither
  const ns = mid ? 6 : 16;
  ctx.globalAlpha = prev * ca;
  for (let i = 0; i < ns; i++) {
    const f = rnd(sd, i + 840);
    const w = R * u * (0.45 + 0.35 * f * back) * (1 + back);
    const px = x + (rnd(sd, i + 841) - 0.5) * 2 * w;
    const py = y - f * H + back * R * u * 0.9 * rnd(sd, i + 842);
    speck(ctx, px, py, g, 1, rnd(sd, i + 843) < 0.7 ? SPRAY[3] : SPRAY[1]);
  }
  ctx.globalAlpha = prev;
}

/**
 * A piece of a shot down missile falling into the sea at (x, y), `la` ms after: a low burst of foam and spray, a ragged
 * white ring of specks spreading out over the water and a short column of a few pixels that collapses within about
 * 300 ms. `sz` its size (1 a piece, about 1.6 the biggest).
 */
function debrisSplash(ctx: CanvasRenderingContext2D, x: number, y: number, la: number, g: Grid, sz: number, sd: number, i: number): void {
  const T = 650;
  if (la < 0 || la >= T) return;
  const q = la / T;
  const prev = ctx.globalAlpha;
  const n = sz > 1.2 ? 9 : 6;
  const rr = g.k * (1 + 3 * sz * easeOut(q));
  ctx.globalAlpha = prev * (1 - q) ** 1.1;
  for (let c = 0; c < n; c++) {
    const ang = ((c + 0.8 * rnd(sd, i * 17 + c + 860)) / n) * TAU;
    const r = rr * (0.7 + 0.5 * rnd(sd, i * 17 + c + 861));
    speck(ctx, x + Math.cos(ang) * r, y + Math.sin(ang) * r * 0.55, g, 1, q < 0.45 && c & 1 ? SPRAY[3] : SPRAY[2]);
  }
  if (la < 300) {
    const hh = Math.round((sz > 1.2 ? 4 : 2.6) * Math.sin((Math.PI * la) / 300));
    ctx.globalAlpha = prev;
    for (let h = 0; h < hh; h++) speck(ctx, x, y - (h + 1) * g.k, g, 1, h === hh - 1 ? SPRAY[2] : SPRAY[3]);
    if (la < 70) speck(ctx, x - g.k * 0.5, y - g.k * 0.5, g, 2, SPRAY[3]);
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
export const SPIN: Partial<Record<SpriteKey, [number, number]>> = {
  fighter: [1.7, 0.42],
  // a twin-engine plane that lost an engine: one slow turn into the dead side and a steady dive, not a whirl
  reconPlane: [0.45, 0.16],
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
  // the twin booms of the recon plane read as a ladder rolled far over: it rolls no further than level 2
  f.roll = spin * Math.min(d.key === 'reconPlane' ? 2 : 3, q < 0.1 ? 1 : q < 0.32 ? 2 : 3);
  // it falls away from the eye, but a small plane must stay readable to the water, not shrink into a smudge
  f.s = Math.max(L < 20 ? 0.72 : 0, 1 - 0.45 * q ** 1.4);
  f.alt = um.alt * (1 - q * q);
  f.q = q;
  return f;
}

/** Where a plane burns from: its first engine, else a wing root (u, v, z model units). */
function engineOf(um: UnitModel, spin: number, key?: SpriteKey): [number, number, number] {
  const p = um.props[0] ?? um.nozzles[0];
  // the recon plane burns at the hit boom's engine nacelle, behind its propeller, not out at the propeller hub
  if (p && key === 'reconPlane') return [p.u - 1.9, p.v, p.z - 0.2];
  if (p) return [p.u, p.v, p.z];
  return [0, spin * spanOf(um) * 0.22, 1.5];
}

/**
 * The hit on a plane at its wing root or engine: a white-yellow flash held for its first 80 to 120 ms (flashTime),
 * then a small ragged black burst off the centre (about half a fighter's span across), see-through enough that the
 * plane shows through it, drifting off downwind and fading, with a few sparks.
 */
function planeHit(ctx: CanvasRenderingContext2D, d: DeathDraw, um: UnitModel, m: MotionParams, g: Grid, u: number, age: number, sd: number, spin: number, mid: boolean): void {
  const [eu, ev, ez] = engineOf(um, spin);
  const [ex, ey] = project(eu * 0.8, ev * 0.8, ez, d.angle, 0, u, false);
  const hx = d.x + ex;
  const hy = d.y + ey;
  const span = Math.min(spanOf(um), 20);
  const Rb = Math.max(1.5, span * 0.24 * g.res);
  const prev = ctx.globalAlpha;
  // the flash: held, then gone in a few frames
  const hold = 110 * m.flashTime;
  if (!d.reduced && age < hold + 60) {
    const fa = age < hold ? 1 : 1 - (age - hold) / 60;
    flashGlow(ctx, 'flak', hx, hy, Rb * 1.1, Math.min(age, 40), g, m, sd, true);
    drawBlob(ctx, 'flash', Rb * (age < 40 ? 0.55 + age / 110 : 0.9), Math.floor(sd) & 3, hx, hy, g, fa);
  }
  // the burst: a few ragged black puffs round the hit, swelling, drifting, fading
  const life = 900 * lingerOf(m);
  const a = d.reduced ? 160 : age - 60;
  if (a < 0 || a >= life) return;
  const k = a / life;
  const sec = a / 1000;
  const n = mid ? 3 : 5;
  for (let i = n - 1; i >= 0; i--) {
    const ang = rnd(sd, i + 900) * TAU;
    const dd = Rb * g.k * (0.25 + 0.5 * rnd(sd, i + 901)) * (1 + 0.6 * k);
    const r = Rb * (0.3 + 0.28 * rnd(sd, i + 902)) * (0.65 + 0.6 * easeOut(clamp01(k * 2.5)));
    const px = hx + Math.cos(ang) * dd + WIND_X * u * sec * 0.8;
    const py = hy + Math.sin(ang) * dd * 0.8 + (WIND_Y * 0.8 - RISE * 0.2) * u * sec;
    drawBlob(ctx, k < 0.45 ? 'soot' : 'shade', Math.max(1, r), i, px, py, g, 0.74 * (1 - k) ** 1.1 * Math.min(1, a / 40));
  }
  if (!d.reduced && a < 160) {
    ctx.globalAlpha = prev * (1 - a / 160);
    for (let i = 0; i < 3; i++) {
      const ang = rnd(sd, i + 910) * TAU;
      const dd = Rb * g.k * (0.6 + 1.2 * (a / 160)) * (0.7 + 0.5 * rnd(sd, i + 911));
      speck(ctx, hx + Math.cos(ang) * dd, hy + Math.sin(ang) * dd * 0.8, g, 1, TRACER[i % 3]);
    }
  }
  ctx.globalAlpha = prev;
}

function drawPlane(ctx: CanvasRenderingContext2D, d: DeathDraw, m: MotionParams): void {
  const g = gridOf(d.scale, d.dpr);
  const u = d.scale;
  const mid = g.res < 1.5;
  const sprite = d.zoom >= 3;
  const G = onGround(d);
  const A = inAir(d);
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
  const G0 = DEATH_GLIDE_TILES * d.zoom;
  const cx = d.x + Math.cos(d.angle) * G0;
  const cy = d.y + Math.sin(d.angle) * G0;
  const lin = lingerOf(m);
  const prev = ctx.globalAlpha;
  const after = age - fall;
  const R = Math.max(4.5, Math.min(10, L * 0.42));
  // a small plane keeps its paint until late in the fall (charred early it is a dark smudge in its own smoke)
  const charQ = L < 20 ? 0.8 : 0.55;
  const fT = 600 * m.blastTime;
  const timeMs = d.reduced ? 0 : d.ageMs;

  // ---- on the ground or the sea where it came down: the slick, wreckage and bubbles, or the burnt wreck and pieces
  if (G && after >= 0) {
    if (d.water) crashSea(ctx, d, m, g, u, cx, cy, R, after, fT, dur - fall, size, sd, mid, timeMs, 0);
    else crashLand(ctx, d, m, g, u, cx, cy, R, after, fT, dur - fall, size, sd, mid, timeMs, sprite, fallAt(d, um, fall, fall, turns, cork, spin, L).hd, L, 0);
  }
  // ---- the falling plane's shadow closing in under it
  if (G && sprite && age < fall) {
    const f = fallAt(d, um, age, fall, turns, cork, spin, L);
    drawWreck(ctx, setPose(d, 'shadow', f.hd, g.res * f.s, f.roll), f.x + f.alt * 0.62 * u, f.y + f.alt * 0.86 * u, g, 0.8 + 0.4 * f.q);
  }
  if (!A) {
    ctx.globalAlpha = prev;
    return;
  }

  // ---- the smoke it trailed as it fell: distinct puffs left along its way down, each its own size, rising and
  // drifting off and breaking up as they age (every other one goes first), never one smooth band
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
    if ((k > 0.4 && j % 2 === 1) || (k > 0.7 && j % 4 !== 0)) continue;
    const f = fallAt(d, um, tb, fall, turns, cork, spin, L);
    const thick = 0.45 + 0.55 * clamp01(f.q / 0.25);
    const sec = d.reduced ? 0 : a / 1000;
    const back = L * 0.18 * u * f.s;
    const jit = rnd(sd, j + 600) - 0.5;
    const px = f.x - Math.cos(f.hd) * back + WIND_X * u * sec * 0.9 + (Math.sin(a / 260 + j) * 0.5 + jit * 1.6) * u * k;
    const py = f.y - Math.sin(f.hd) * back * FORE + (WIND_Y * 0.9 - RISE * 0.55) * u * sec + (rnd(sd, j + 601) - 0.5) * u * 1.2 * k;
    const r = g.res * size * (0.7 + 0.7 * thick + 1.25 * easeOut(k) * (0.55 + 0.9 * rnd(sd, j + 602))) * Math.sqrt(f.s);
    const kind: BlobKind = k < 0.42 ? 'soot' : k < 0.72 ? (j & 4 ? 'soot' : 'shade') : 'smoke';
    drawBlob(ctx, kind, r, j & 3, px, py, g, 0.95 * thick * (1 - k) ** 1.15 * Math.min(1, a / 50) * (k > 0.3 ? 0.65 + 0.35 * rnd(sd, j + 603) : 1));
  }

  // ---- the crash over the smoke it trailed down (its newest puffs lie right there): fire, splash, pieces, smoke
  if (after >= 0) {
    if (d.water) crashSea(ctx, d, m, g, u, cx, cy, R, after, fT, dur - fall, size, sd, mid, timeMs, 1);
    else crashLand(ctx, d, m, g, u, cx, cy, R, after, fT, dur - fall, size, sd, mid, timeMs, sprite, 0, L, 1);
  }

  // ---- the plane falling: turning, rolling and smaller, burning
  if (age < fall) {
    const f = fallAt(d, um, age, fall, turns, cork, spin, L);
    const res = g.res * f.s;
    if (sprite) {
      wreckOrLive(ctx, d, m, setPose(d, 'body', f.hd, res, f.roll, f.q > charQ ? 1 : 0), f.x, f.y, g);
      // the pose a moment on, baked ahead so it is ready
      if (!d.reduced) {
        const nx = fallAt(d, um, age + 90, fall, turns, cork, spin, L);
        warmWreck(setPose(d, 'body', nx.hd, g.res * nx.s, nx.roll, nx.q > charQ ? 1 : 0));
      }
    }
    // fire at an engine, streaming back along its way
    const fireK = clamp01((f.q - 0.04) / 0.22);
    if (fireK > 0) {
      const [eu, ev, ez] = engineOf(um, spin, d.key);
      const rr = WRECK_ROLLS[Math.min(3, Math.abs(f.roll))] * Math.sign(f.roll);
      const [ex, ey] = project(eu, ev, ez, f.hd, rr, u * f.s, false);
      const lean = Math.max(-2, Math.min(2, Math.round(-Math.cos(f.hd) * 2)));
      // a small plane's engine fire is as big as a bomber's, so it reads as burning, not as a spark
      const fs = Math.max(1, size);
      for (let i = mid ? 1 : 2; i >= 1; i--) {
        const bk = i * 1.6 * u * f.s;
        drawBlob(ctx, 'fire', Math.max(1, g.res * f.s * fs * (0.75 - 0.18 * i)), i, f.x + ex - Math.cos(f.hd) * bk, f.y + ey - Math.sin(f.hd) * bk * FORE, g, fireK * 0.9, 1 + i);
      }
      drawFlame(ctx, f.x + ex, f.y + ey + g.k, g.res * f.s * fs * (0.55 + 0.45 * fireK), g, timeMs, rnd(sd, 7), m, fireK, lean);
      // a short trail of sparks streaming back from the fire, new ones every frame
      if (!d.reduced) {
        const prevA = ctx.globalAlpha;
        ctx.globalAlpha = prevA * fireK;
        for (let i = 0; i < 3; i++) {
          const bk = (2.6 + 3.2 * rnd(sd + Math.floor(timeMs / 60), i + 940)) * u * f.s;
          const off = (rnd(sd + Math.floor(timeMs / 60), i + 941) - 0.5) * 1.6 * u;
          speck(ctx, f.x + ex - Math.cos(f.hd) * bk - Math.sin(f.hd) * off, f.y + ey - Math.sin(f.hd) * bk * FORE + Math.cos(f.hd) * off * FORE, g, 1, FIRE[1 + i]);
        }
        ctx.globalAlpha = prevA;
      }
    }
  }

  // ---- the hit: a held flash and a small black burst at the wing root, left hanging where it was
  if (!d.reduced || d.t < 0.34) planeHit(ctx, d, um, m, g, u, age, sd, spin, mid);
  ctx.globalAlpha = prev;
}

/**
 * A plane crashing on land: a flash, a fireball, pieces thrown out, its burnt wreck burning under a smoke column.
 * `layer` 0 is what lies on the ground (the flash's light, the wreck, the pieces that fell), 1 the rest.
 */
function crashLand(ctx: CanvasRenderingContext2D, d: DeathDraw, m: MotionParams, g: Grid, u: number, x: number, y: number, R: number, a: number, fT: number, rest: number, size: number, sd: number, mid: boolean, timeMs: number, sprite: boolean, hd: number, L: number, layer: 0 | 1): void {
  const Rc = R * g.res;
  const lin = lingerOf(m);
  const fade = 1 - smooth(clamp01((a - (rest - 1000)) / 1000));
  const nd = Math.round((mid ? 6 : 11) * m.debris);
  if (layer === 0) {
    // the flash's light on the ground
    if (!d.reduced) flashGlow(ctx, 'bomb', x, y, Rc, a, g, m, sd, false);
    // the burnt wreck lying there, under the fire once the fireball has covered it
    const wreckIn = clamp01((a - fT * 0.3) / 120);
    if (sprite && wreckIn > 0) drawWreck(ctx, setPose(d, 'body', hd, g.res * 0.55, 0, CHAR_STEPS), x, y, g, wreckIn * fade);
    else if (sprite && !d.reduced) warmWreck(setPose(d, 'body', hd, g.res * 0.55, 0, CHAR_STEPS));
    // the pieces that fell, some still burning
    if (!d.reduced) groundDebris(ctx, x, y, R * 0.9, a, fT * 1.7 + 200, rest, g, u, sd, nd, m, timeMs, mid ? 1 : 3, false, true);
    return;
  }
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
  // the column of smoke standing on it, then thinning away (at most about three and a half lengths of the plane)
  const colA = clamp01((a - fT * 0.3) / 300) * (1 - smooth(clamp01((a - (rest - 1500 * lin)) / (1500 * lin))));
  column(ctx, x, y - R * 0.3 * u, g, u, timeMs, m, mid ? 4 : 8, 2100 * lin, g.res * size * 1.2, g.res * size * 4.4, 0.82, colA, d.seed, 1.25, 3.5 * L * u);
  // the burst's own smoke
  smokeCloud(ctx, x, y - R * 0.4 * u, R, a, fT * 0.2, fT * 0.8, fT + 1400 * lin, g, u, sd, mid ? 3 : 5);
  // pieces thrown out
  if (!d.reduced) groundDebris(ctx, x, y, R * 0.9, a, fT * 1.7 + 200, rest, g, u, sd, nd, m, timeMs, mid ? 1 : 3, true, false);
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
    if (a > 120) {
      const sr = Rc * (0.55 + 1.1 * easeOut(clamp01(a / (rest * 0.6))));
      const sx = x + WIND_X * u * (a / 1000) * 0.15;
      slick(ctx, sr, Math.floor(sd) & 3, sx, y, g, 0.65 * fade, Math.min(3, Math.floor(k * 3.6)));
      // a lighter sheen round its ragged rim, so the slick shows on the dark sea
      if (!d.reduced) sheen(ctx, sx, y, sr * g.k * 0.8, sr * g.k * 0.45, g, sd, 0.35 * fade, mid);
    }
    // floating pieces of the plane in its own paint, and bubbles
    const spread = easeOut(clamp01((a - 150) / 1200));
    if (a > 150) floating(ctx, x, y, R * (0.6 + 1.2 * spread) * u, R * (0.35 + 0.6 * spread) * u, mid ? 3 : 5, a, g, u, sd, fade, d.reduced, paintOf(d.key));
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
  column(ctx, x, y, g, u, timeMs, m, mid ? 3 : 5, 1500 * lin, g.res * size * 0.9, g.res * size * 3, 0.55, colA * 0.85, d.seed, 1, 4.5 * R * 2.4 * u);
  // the splash: a wide ragged foot and a column of water that spreads and falls back on itself
  if (!d.reduced || d.t < 0.67) crashSplash(ctx, x, y, d.reduced ? 380 : a, g, u, R * Math.min(1.15, 0.75 + 0.35 * size), sd, m, mid);
  // a quick fireball of fuel at the surface and the flash
  fireball(ctx, x, y - R * 0.2 * u, R * 0.75, a, fT * 0.6, g, u, sd, mid ? 3 : 4);
  if (!d.reduced) flashCore(ctx, 'air', x, y, Rc * 0.8, a, g, m, sd);
}

// ------------------------------------------------------------------------------------------------- missiles

/** A point worked out without allocating (a falling piece's place). */
const PT = { x: 0, y: 0 };
/** Both sides of a hull (across, in spans). */
const SIDES = [-0.55, 0.55] as const;
/** The way the wind blows on screen (radians). */
const WIND_ANG = Math.atan2(WIND_Y, WIND_X);

function drawMissile(ctx: CanvasRenderingContext2D, d: DeathDraw, m: MotionParams): void {
  const g = gridOf(d.scale, d.dpr);
  const u = d.scale;
  const mid = g.res < 1.5;
  const G = onGround(d);
  const A = inAir(d);
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
  // the burst's light on the ground under it
  if (G && !d.reduced) flashGlow(ctx, 'shell', x + ox, y + oy, Rc * 0.8, age, g, m, sd, false);

  // ---- the pieces, thrown out unevenly: a few long burning ones to one side downwind, short stubs that burn only a
  // moment, bare bits with no smoke at all; none falls straight down under the burst. Their trails start at the
  // fireball's edge, sag and break up from their near end first. A few land as small blasts, or low bursts of spray
  // on the sea (4 to 6 at most), all within about 2.5 fireball radii of the burst.
  const n = Math.max(4, Math.round((atom ? 11 : 8) * m.debris * (mid ? 0.6 : 1)));
  const nLong = atom ? 3 : 2;
  const maxSplash = atom ? 6 : 4;
  const side = rnd(sd, 9) < 0.5 ? -0.75 : 0.75;
  const landMs = 450 * m.blastTime;
  const trailLife = 900 * lin;
  const step = mid ? 90 : 50;
  const edge = R * 0.7 * u;
  for (let pass = 0; pass < 3; pass++) {
    if (pass === 0 ? !G : !A) continue;
    let splashes = 0;
    for (let i = 0; i < n; i++) {
      const main = i === 0;
      // 2 long, 1 stub, 0 bare
      const cls = i < nLong ? 2 : rnd(sd, i + 48) < 0.55 ? 1 : 0;
      const tf = main ? impact - 40 : (700 + 400 * rnd(sd, i + 40)) * m.blastTime;
      const a = age - 40;
      if (a < 0) continue;
      const k = a / tf;
      let dir = cls === 2 ? WIND_ANG + side + (i - (nLong - 1) / 2) * 0.55 + (rnd(sd, i + 41) - 0.5) * 0.35 : WIND_ANG + (rnd(sd, i + 41) - 0.5) * TAU * 0.9;
      // never straight down the screen (that is under the burst): swung out to the side
      if (Math.sin(dir) > 0.5) dir = Math.cos(dir) >= 0 ? 0.5 - 0.3 * rnd(sd, i + 49) : Math.PI - 0.5 + 0.3 * rnd(sd, i + 49);
      const vh = R * (main ? 2.3 : cls === 2 ? 1.8 + 0.6 * rnd(sd, i + 42) : cls === 1 ? 1.05 + 0.5 * rnd(sd, i + 42) : 0.9 + 1.0 * rnd(sd, i + 42));
      let cdx = Math.cos(dir) * vh * u;
      const cdy = Math.sin(dir) * vh * u * FORE;
      // where it lands; one that would come down under the cloud's middle is thrown downwind instead
      if (Math.abs(ox + cdx) < R * 0.8 * u && oy + cdy > -R * 0.3 * u) cdx = Math.abs(cdx) + R * 0.8 * u;
      const pop = main ? 0.15 : 0.25 + 0.5 * rnd(sd, i + 43);
      const burning = cls >= 1;
      const burnEnd = main ? 1 : cls === 2 ? 0.7 + 0.3 * rnd(sd, i + 45) : 0.2 + 0.25 * rnd(sd, i + 45);
      const thick = main ? 1.15 : cls === 2 ? 0.8 + 0.4 * rnd(sd, i + 46) : 0.5 + 0.25 * rnd(sd, i + 46);
      /** Where the piece is `kk` of its way down (into PT: no allocation per puff). */
      const at = (kk: number): void => {
        const sp = easeOut(Math.min(1, kk));
        const h = 1 - kk * kk + pop * 4 * kk * (1 - kk);
        PT.x = x + ox + cdx * sp - h * ox;
        PT.y = y + oy + cdy * sp - h * oy;
      };
      if (pass === 1) {
        // the smoke a burning piece leaves along its way down, from the fireball's edge on
        if (!burning) continue;
        const tEnd = Math.min(a, tf * burnEnd);
        const life = trailLife * (cls === 2 ? 1.25 : 0.6);
        for (let j = Math.max(1, Math.ceil((a - life) / step)); j * step <= tEnd; j++) {
          const tb = j * step;
          at(tb / tf);
          const qx = PT.x;
          const qy = PT.y;
          if (Math.hypot(qx - x, qy - y) < edge) continue;
          // the near part thins and breaks up first: a puff laid early lives shorter, and gaps open as it ages
          const near = clamp01(tb / (tf * burnEnd));
          const lifeJ = life * (0.45 + 0.55 * near);
          const pa = a - tb;
          const pk = pa / lifeJ;
          if (pk >= 1) continue;
          if (rnd(sd + i * 13, j + 700) < pk * 1.2 - 0.4) continue;
          const sec = d.reduced ? 0 : pa / 1000;
          const r = g.res * (0.4 + 1.0 * easeOut(pk)) * thick * (atom ? 1.1 : 1) * (0.8 + 0.4 * rnd(sd + i, j + 701));
          // drifting downwind and sagging a little toward the ground
          drawBlob(ctx, pk < 0.4 ? 'soot' : pk < 0.7 ? 'shade' : 'smoke', r, (i + j) & 3, qx + WIND_X * u * sec * 0.6, qy + RISE * u * sec * 0.18, g, 0.85 * (1 - pk) ** 1.2 * Math.min(1, pa / 40));
        }
        continue;
      }
      if (k < 1) {
        if (pass !== 2) continue;
        // in the air: a burning piece (the small cold ones dark); only the long ones still glow at their tip
        at(k);
        const px = PT.x;
        const py = PT.y;
        const hot = (burning && k < burnEnd) || k < 0.2;
        speck(ctx, px, py, g, main ? 2 : 1, hot ? (i & 1 ? TRACER[0] : TRACER[1]) : DEBRIS[i % 3]);
        if (cls === 2 && k < burnEnd && (main || !mid)) drawBlob(ctx, 'fire', Math.max(1, g.res * (main ? 0.9 : 0.55)), i, px, py - g.k * 0.5, g, 1, 2);
        continue;
      }
      if (pass !== 0) continue;
      // down: a small blast on land, a low burst of spray on the sea; the bare bits go unseen
      if (cls === 0) continue;
      const la = a - tf;
      at(1);
      const gx = PT.x;
      const gy = PT.y;
      if (d.water) {
        if (splashes >= maxSplash) continue;
        splashes++;
        debrisSplash(ctx, gx, gy, la, g, main ? 1.6 : cls === 2 ? 1.1 : 0.8, sd, i);
        continue;
      }
      if (main) {
        blastAt(ctx, 'shell', gx, gy, la, d.zoom, d.scale, d.dpr, d.seed, m, d.reduced);
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
  if (!A) {
    ctx.globalAlpha = prev;
    return;
  }

  // ---- the burst: black smoke left hanging in two or three lumps drifting apart (never one round cap), the
  // fireball, the flash
  const lumps = atom ? 3 : 2;
  const per = Math.max(2, Math.round((mid ? 4 : atom ? 9 : 6) / lumps) + 1);
  const apart = R * (0.25 + 0.85 * easeOut(clamp01(age / (dur * 0.75))));
  for (let j = 0; j < lumps; j++) {
    const la = WIND_ANG + Math.PI * 0.5 + (j * TAU) / lumps + (rnd(sd, j + 60) - 0.5) * 0.9;
    const dd = apart * (0.8 + 0.45 * rnd(sd, j + 61));
    const Rj = R * (j === 0 ? 0.68 : 0.52) * (0.9 + 0.2 * rnd(sd, j + 62));
    smokeCloud(ctx, x + Math.cos(la) * dd * u, y + Math.sin(la) * dd * u * 0.6, Rj, age, fT * (0.15 + 0.12 * j), fT * 0.75, dur * (0.82 + 0.18 * rnd(sd, j + 63)), g, u, sd + j * 17, per, 0.95, 0.35);
  }
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
  const G = onGround(d);
  const A = inAir(d);
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
  if (G) {
    drawBlob(ctx, 'scorch', g.res * L * 0.42, Math.floor(sd) & 3, x, y + 0.6 * u, g, 0.85 * fadeA * clamp01(age / 200));
    if (sprite) {
      wreckOrLive(ctx, d, m, setPose(d, 'body', d.angle, g.res, 0, char), x, y, g, fadeA);
      if (char < CHAR_STEPS && !d.reduced) warmWreck(setPose(d, 'body', d.angle, g.res, 0, char + 1));
    }
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
  }
  // fires: roaring out of the turret ring, on the engine deck, then dying down to the embers
  const fireA = clamp01(age / 90) * (1 - smooth(clamp01((burnK - 0.5) / 0.35)));
  if (A && fireA > 0.02) {
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
    // on the ground once it is down (it then fades with the hull), in the air while it flies
    const down = k >= 1 && h < H * 0.02;
    if (age > 30) {
      // its shadow only while it is up: none under it once it lies there, so it fades with the hull
      if (G && sprite && h > 0) drawWreck(ctx, setPose(d, 'turretShadow', turn, g.res), gx, gy, g, fadeA * (1 - 0.5 * Math.min(1, h / H)) * clamp01(h / (H * 0.12)));
      if (down ? G : A) {
        if (sprite) drawWreck(ctx, setPose(d, 'turret', turn, g.res, 0, k >= 1 ? char : 0), gx, gy - h * LIFT * u, g, fadeA);
        else speck(ctx, gx, gy - h * LIFT * u, g, 2, DEBRIS[1]);
      }
    }
    // a puff of dust where it lands
    if (A && k >= 1 && k2 < 1) drawBlob(ctx, 'dust', g.res * size * (0.8 + 1.4 * easeOut(k2)), 3, gx, gy, g, 0.75 * (1 - k2));
  }
  if (!A) {
    ctx.globalAlpha = prev;
    return;
  }

  // ---- the column of black smoke off the wreck, thinning away as the fires go out (at most about 4 hull lengths)
  const colA = clamp01((age - 100) / 300) * (1 - smooth(clamp01((age - (endBurn - 700)) / (TANK_FADE + 700))));
  column(ctx, px, py, g, u, timeMs, m, mid ? 4 : 8, 2100 * lingerOf(m), g.res * size * 1.1, g.res * size * 4.4, 1, colA, d.seed, 1.3, 4 * L * u);

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
  const G = onGround(d);
  const A = inAir(d);
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
  const nF = mid ? (L > 30 ? 2 : 1) : L > 30 ? 3 : 2;
  const seedInt = Math.floor(d.seed * 997);

  if (G) {
    // ---- the oil slick spreading round it as it goes down and after (under the hull): a few ragged lobes along it
    if (sinkQ > 0.25) {
      const k = clamp01((age - hitT - listT - sinkT * 0.25) / (sinkT * 0.75 + rest * 0.6));
      const oa = 0.52 * clamp01((sinkQ - 0.25) / 0.3) * fadeAfter;
      const sp = 1 + 0.4 * easeOut(k);
      const wx = WIND_X * u * (Math.max(0, age - under) / 1000) * 0.12;
      for (let i = 0; i < 5; i++) {
        const au = (i / 4 - 0.5) * L * 0.62;
        const av = (i & 1 ? 1 : -1) * B * (0.1 + 0.25 * rnd(sd, i + 90));
        const r = Math.min(38, g.res * L * (0.15 + 0.1 * easeOut(k)) * (0.8 + 0.4 * rnd(sd, i + 91)));
        const dx = (au * ca - av * sa) * u * sp + wx;
        const dy = (au * sa + av * ca) * u * FORE * sp;
        drawBlob(ctx, 'oil', r, (Math.floor(sd) + i) & 3, x + dx, y + dy, g, oa, Math.min(3, Math.floor(post * 3.6)));
      }
    }
    // ---- foam churned up where it went down: loose specks and short lace, thinning out
    if (age > under - sinkT * 0.2 && post < 0.6) {
      const k = clamp01((age - under + sinkT * 0.2) / (rest * 0.6 + sinkT * 0.2));
      const gr = 0.55 + 0.6 * easeOut(k);
      churn(ctx, x, y, L * 0.42 * u * gr, L * 0.16 * u * gr, k, g, sd, 0.95, mid);
    }

    // ---- the hull: listing, then going under from one end (the next pose baked ahead)
    if (sprite && sink < SINK_STEPS) {
      wreckOrLive(ctx, d, m, setPose(d, 'body', d.angle, g.res, roll, 0, sink, dir), x, y, g);
      if (!d.reduced) {
        const nextRoll = Math.abs(roll) < 2 ? roll + side : roll;
        warmWreck(setPose(d, 'body', d.angle, g.res, sinkQ > 0 ? side * (sinkQ < 0.45 ? 2 : 3) : nextRoll, 0, Math.min(SINK_STEPS, sink + 1), dir));
      }
    }

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

    // ---- foam where the sea meets the hull's sides at its waterline, spray flicking off, and bubbles boiling up
    if (sinkQ > 0 && sinkQ < 1) {
      const aw = dir < 0 ? -L / 2 + L * Math.min(1, Math.max(0, p)) : L / 2 - L * Math.min(1, Math.max(0, p));
      for (const sv of SIDES) {
        const [fx, fy] = project(aw, sv * B, 0, th, rollRad, u, false);
        drawBlob(ctx, 'foam', g.res * size * (1.2 + 0.6 * Math.sin(age / 210 + sv * 3) ** 2), (Math.floor(age / 260) + (sv > 0 ? 1 : 0)) & 3, x + fx, y + fy, g, 0.85, 1);
        if (!mid && !d.reduced) {
          // spray thrown up and out off the side as the end goes under
          const ox = -sa * Math.sign(sv);
          const oy = ca * Math.sign(sv) * FORE;
          for (let c = 0; c < 3; c++) {
            const ph = ((age + c * 113 + (sv > 0 ? 57 : 0)) % 340) / 340;
            const reach = (1.5 + 2.5 * rnd(sd, c + 950)) * u * ph;
            ctx.globalAlpha = prev * (1 - ph);
            speck(ctx, x + fx + ox * reach - dir * ca * u * ph, y + fy + oy * reach - 4 * ph * (1 - ph) * 3 * u, g, 1, c ? SPRAY[3] : SPRAY[2]);
          }
          ctx.globalAlpha = prev;
        }
      }
      const [bx, by] = project(aw - dir * L * 0.08, 0, 0, th, rollRad, u, false);
      bubbles(ctx, x + bx, y + by, L * 0.15 * u, B * 0.6 * u, mid ? 3 : 6, age, g, sd, 0.95);
    }
    if (age >= under) bubbles(ctx, x, y, L * 0.3 * u, L * 0.12 * u, mid ? 2 : 5, age, g, sd + 1, 0.9 * (1 - clamp01(post / 0.6)));

    // ---- wreckage left floating: a few planks let go as the water reaches them, drifting off and fading
    if (sinkQ > 0.15) floating(ctx, x, y, L * 0.5 * u, Math.max(B, L * 0.22) * u, mid ? 3 : 6, age, g, u, sd, clamp01((sinkQ - 0.15) / 0.4) * fadeAfter, d.reduced);

    // ---- the deck burnt black round the fires (on the hull, under the flames)
    if (!mid) {
      for (let i = 0; i < nF; i++) {
        const [su, sv, sz] = hitSpot(um, seedInt, i);
        const e = fromEnd(su);
        const goneAt = hitT + listT + clamp01((e + 0.1) / 1.6) ** (1 / 1.5) * sinkT;
        const start = 80 + i * 380;
        if (age < start || age >= goneAt) continue;
        const [fx, fy] = project(su, sv, sz, th, rollRad, u, false);
        drawBlob(ctx, 'scorch', g.res * size * (i === 0 ? 1.5 : 1.1), (seedInt + i) & 3, x + fx, y + fy + 0.4 * u, g, 0.9 * clamp01((age - start) / 700));
      }
    }
  }
  if (!A) {
    ctx.globalAlpha = prev;
    return;
  }

  // ---- fires on deck at the hit spots (each going out in a puff of steam as the sea reaches it)
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
  // the heavy black column: from the fires while it floats (leaning over toward its low side as it lists), then
  // thinning off the slick
  const colA = clamp01((age - 120) / 500) * (smokeOn ? 1 : 0.55 * (1 - smooth(clamp01(post / 0.7))));
  const lean = -sa * side * 2.6 * listQ;
  column(ctx, smokeOn ? smokeX : x, smokeOn ? smokeY : y, g, u, timeMs, m, mid ? 4 : 8, 2200 * lin * size, g.res * size * 0.9, g.res * size * 4.2, 1, colA, d.seed, 1.2, 5 * L * u, smokeOn ? lean : 0);

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
