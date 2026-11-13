// The refined style's wakes and contrails (client only). Everything a unit leaves behind stays where it was laid (map
// coordinates) and fades there, so a trail lingers and curves with the path the unit really took.
//
// Ships: a proper wake, sized by the ship's speed and beam. A bow wave folds out from the stem along both sides (drawn
// with the ship each frame); behind it the two arms of the V spread out at the Kelvin angle (about 19 degrees,
// MotionParams.wakeSpread) as short broken foam dashes that widen and fade with age, no longer than about a ship length
// (wakeLength); down the middle the churned water from the screws is one continuous taper, narrow and bright at the
// stern, widening and fading behind (foamLife), filled as one strip per fade step, never a chain of round discs. The
// submarine, low in the water, leaves only a thin line and a small ripple at its tower.
// Planes: thin white contrails from the engines (four from a heavy bomber, two from a twin, faint wingtip trails from
// a fighter or a low ground-attack plane), widening, softening and drifting a little downwind with age, breaking up
// toward the tail and fading out over their last third (contrailLife).
// Missiles: puffs of smoke (white-hot at the engine, then light grey, tapering from about one missile width to two or
// three, breaking up; missileTrailLife), one ring buffer of puffs per layer.
// The lines and strips of every ship or plane in a layer go into a fixed handful of paths (one per fade step), so a sea
// full of ships costs a few strokes and fills per frame, not a few per ship.

import { GLYPHS, type Inst } from '../../render/unitGlyphs';
import type { MotionParams } from '../motion';
import { unitCategoryOf, unitTypeOf, type SpriteKey } from '../shared/keys';
import type { TrailArt, TrailLayer, TrailUnit, TrailView } from '../types';
import { FX } from './palette';
import { FORE } from './spriteBake';
import { refinedBeam } from './sprites';

/** Puff kinds. */
const SMOKE = 0;
const FAINT = 1;
const FOAM = 2;
const PUFF_CAP = 1800;

/** World-anchored puffs (tile coordinates), a fixed ring buffer: nothing is allocated per puff. */
export class TrailPuffs {
  readonly x = new Float32Array(PUFF_CAP);
  readonly y = new Float32Array(PUFF_CAP);
  readonly vx = new Float32Array(PUFF_CAP);
  readonly vy = new Float32Array(PUFF_CAP);
  readonly born = new Float64Array(PUFF_CAP);
  readonly life = new Float32Array(PUFF_CAP);
  readonly r0 = new Float32Array(PUFF_CAP);
  readonly r1 = new Float32Array(PUFF_CAP);
  readonly kind = new Uint8Array(PUFF_CAP);
  /** next slot (the oldest puff is overwritten when full) */
  private head = 0;
  /** where each emitter (unit id * 4 + side) dropped its last puff, and the frame it was seen */
  private last = new Map<number, { x: number; y: number; frame: number; t: number; v: number }>();
  private frame = 0;
  /** puffs made since the start (tests, stats) */
  made = 0;

  clear(): void {
    this.life.fill(0);
    this.last.clear();
    this.head = 0;
  }

  /** Starts a frame: forgets emitters not seen for a while. */
  begin(): void {
    this.frame++;
    if (this.frame % 60 === 0) for (const [k, v] of this.last) if (this.frame - v.frame > 30) this.last.delete(k);
  }

  private put(x: number, y: number, vx: number, vy: number, now: number, life: number, r0: number, r1: number, kind: number): void {
    const i = this.head;
    this.x[i] = x;
    this.y[i] = y;
    this.vx[i] = vx;
    this.vy[i] = vy;
    this.born[i] = now;
    this.life[i] = life;
    this.r0[i] = r0;
    this.r1[i] = r1;
    this.kind[i] = kind;
    this.head = (i + 1) % PUFF_CAP;
    this.made++;
  }

  /**
   * Drops puffs every `spacing` tiles along the way emitter `key` went since last frame, ending at (x, y) (tiles).
   * vx, vy: drift in tiles per second. `maxLen` (tiles, 0 = none) caps the trail's length: a fast emitter's puffs
   * live just long enough to reach that far behind it.
   */
  emit(key: number, x: number, y: number, spacing: number, now: number, life: number, r0: number, r1: number, kind: number, vx: number, vy: number, jit = 0, maxLen = 0): void {
    const l = this.last.get(key);
    if (!l || this.frame - l.frame > 3) {
      this.last.set(key, { x, y, frame: this.frame, t: now, v: 0 });
      this.put(x, y, vx, vy, now, life, r0, r1, kind);
      return;
    }
    l.frame = this.frame;
    const dx = x - l.x;
    const dy = y - l.y;
    const d = Math.hypot(dx, dy);
    if (d < spacing) return;
    // speed (tiles per ms, smoothed) for the length cap
    const dt = now - l.t;
    if (dt > 0) l.v = l.v ? l.v * 0.6 + (d / dt) * 0.4 : d / dt;
    l.t = now;
    if (maxLen > 0 && l.v > 0) life = Math.max(120, Math.min(life, maxLen / l.v));
    // a jump (a teleport, a long pause) starts a fresh trail
    if (d > spacing * 60) {
      l.x = x;
      l.y = y;
      this.put(x, y, vx, vy, now, life, r0, r1, kind);
      return;
    }
    const n = Math.floor(d / spacing);
    for (let k = 1; k <= n; k++) {
      const q = (k * spacing) / d;
      // a little off the line, so the smoke looks irregular; the puff dropped earlier along the way is older
      const j = jit ? (Math.sin(this.made * 12.9898) * 43758.5453) % 1 : 0;
      this.put(l.x + dx * q - (dy / d) * j * jit, l.y + dy * q + (dx / d) * j * jit, vx, vy, now - (1 - q) * 16, life * (0.85 + 0.3 * Math.abs(j)), r0, r1 * (0.8 + 0.4 * Math.abs(j)), kind);
    }
    l.x += (dx * n * spacing) / d;
    l.y += (dy * n * spacing) / d;
  }

  /** Draws the live puffs: (ox, oy) = screen position of tile (0, 0), z px per tile, g px per art pixel. */
  draw(ctx: CanvasRenderingContext2D, ox: number, oy: number, z: number, g: number, now: number, viewW: number, viewH: number): number {
    const prev = ctx.globalAlpha;
    let drawn = 0;
    for (let i = 0; i < PUFF_CAP; i++) {
      const life = this.life[i];
      if (life <= 0) continue;
      const age = now - this.born[i];
      if (age >= life) {
        this.life[i] = 0;
        continue;
      }
      if (age < 0) continue;
      const q = age / life;
      const sx = ox + (this.x[i] + (this.vx[i] * age) / 1000) * z;
      const sy = oy + (this.y[i] + (this.vy[i] * age) / 1000) * z;
      if (sx < -20 || sy < -20 || sx > viewW + 20 || sy > viewH + 20) continue;
      const r = this.r0[i] + (this.r1[i] - this.r0[i]) * Math.sqrt(q);
      const k = this.kind[i];
      if (k === FOAM) {
        ctx.globalAlpha = prev * 0.6 * (1 - q);
        ctx.fillStyle = q < 0.3 ? FX.foam : FX.foamDim;
      } else {
        // hot at the engine, then a warm light grey thinning to ash; from 0.65 at the front to nothing at the tail
        ctx.globalAlpha = prev * (k === FAINT ? 0.4 : 0.65) * (1 - q) * (1 - q * 0.3);
        ctx.fillStyle = q < 0.1 && k === SMOKE ? FX.hot : q < 0.45 ? FX.ash : FX.smokeLight;
      }
      puffDisc(ctx, sx, sy, r, g);
      drawn++;
    }
    ctx.globalAlpha = prev;
    return drawn;
  }
}

/** A whole-pixel puff of radius r cells (g px each): one cell, a 2 cell square, a 3 cell blob or a round disc. */
function puffDisc(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, g: number): void {
  const X = Math.round(x / g) * g;
  const Y = Math.round(y / g) * g;
  if (r < 0.75) {
    ctx.fillRect(X, Y, g, g);
    return;
  }
  if (r < 1.15) {
    // a 2 px puff (a plus would read as a sparkle)
    ctx.fillRect(X - g, Y - g, g * 2, g * 2);
    return;
  }
  if (r < 1.5) {
    // two overlapping 2 px squares: a round 3 px blob without its top right and bottom left corners
    ctx.fillRect(X - g, Y - g, g * 2, g * 2);
    ctx.fillRect(X, Y, g * 2, g * 2);
    return;
  }
  const ri = Math.round(r);
  for (let dy = -ri; dy <= ri; dy++) {
    const half = Math.floor(Math.sqrt(ri * ri - dy * dy) + 0.3);
    ctx.fillRect(X - half * g, Y + dy * g, (half * 2 + 1) * g, g);
  }
}

/** Where the camera puts tile (0, 0), the zoom, the sprites' pixel size and the time, for world-anchored trails. */
export interface PuffView {
  ox: number;
  oy: number;
  z: number;
  g: number;
  now: number;
  viewW: number;
  viewH: number;
}

/**
 * Missile smoke as world-anchored puffs: with a puff buffer and a view, puffs are dropped along the way each missile
 * went (Inst.id, tx, ty needed) and drawn where they were dropped, with a white-hot core at each nozzle (ships and
 * planes in `list` are left to the line trails of the layers). Without a buffer (tests, previews), the trails of every
 * kind are laid out as puffs along each unit's heading: missiles at every zoom, planes and moving ships' wakes only
 * with `wakes` (not far out).
 */
export function drawTrails(ctx: CanvasRenderingContext2D, list: readonly TrailInst[], wakes: boolean, puffs?: TrailPuffs, view?: PuffView): void {
  if (puffs && view) {
    const { z, g, now } = view;
    puffs.begin();
    for (const e of list) {
      const gl = GLYPHS[e.type];
      if (gl.trail !== 'missile' || e.id === undefined || e.tx === undefined || e.ty === undefined) continue;
      const cos = Math.cos(e.angle);
      const sin = Math.sin(e.angle);
      const back = (e.S * 0.9) / z;
      // narrow and white-hot at the engine, growing from one to three cells and broken up toward the back, about
      // five missile lengths long
      const big = e.type === 'atomBomb';
      const lm = e.motion?.missileTrailLife ?? 1;
      const life = (z < 3 ? 1100 : 600) * lm;
      puffs.emit(e.id * 4, e.tx - cos * back, e.ty - sin * back, (2.5 * g) / z, now, big ? life * 1.25 : life, big ? 1.6 : 1, big ? 4.6 : 3, SMOKE, 1.2 / z, -2 / z, (1.2 * g) / z, ((5 * 2 * e.S) / z) * lm);
    }
    puffs.draw(ctx, view.ox, view.oy, z, g, now, view.viewW, view.viewH);
    // the hot core at each missile's nozzle: two near-white cells just behind the flame
    const pa = ctx.globalAlpha;
    for (const e of list) {
      if (GLYPHS[e.type].trail !== 'missile') continue;
      const cos = Math.cos(e.angle);
      const sin = Math.sin(e.angle);
      ctx.globalAlpha = pa * 0.9;
      // the atom bomb's exhaust is longer and brighter: a two cell wide white core and a longer flame
      const w = e.type === 'atomBomb' ? 2 * g : g;
      const n = e.type === 'atomBomb' ? 2 : 1;
      ctx.fillStyle = FX.hot;
      for (let k = 0; k < n; k++) ctx.fillRect(Math.round((e.x - cos * (e.S + (0.5 + k) * g)) / g) * g, Math.round((e.y - sin * (e.S + (0.5 + k) * g)) / g) * g, w, w);
      ctx.fillStyle = FX.flame;
      for (let k = 0; k < n; k++) ctx.fillRect(Math.round((e.x - cos * (e.S + (1.6 + n - 1 + k * 1.1) * g)) / g) * g, Math.round((e.y - sin * (e.S + (1.6 + n - 1 + k * 1.1) * g)) / g) * g, w, w);
    }
    ctx.globalAlpha = pa;
    return;
  }
  // no buffer: the puffs laid out along the heading (oldest and widest at the tail)
  const prev = ctx.globalAlpha;
  for (const e of list) {
    const gl = GLYPHS[e.type];
    if (gl.trail === 'none' || (gl.trail !== 'missile' && !wakes)) continue;
    if (gl.trail === 'wake' && !e.moving) continue;
    const cos = Math.cos(e.angle);
    const sin = Math.sin(e.angle);
    const L = e.S * 2 * gl.trailLen;
    const n = gl.trail === 'missile' ? 7 : 4;
    for (let i = 0; i < n; i++) {
      const q = i / (n - 1);
      const d = e.S * 0.85 + L * q;
      ctx.globalAlpha = prev * (gl.trail === 'missile' ? 0.7 : 0.45) * (1 - q * 0.85);
      ctx.fillStyle = gl.trail === 'wake' ? FX.foam : q < 0.15 ? FX.hot : FX.ash;
      if (gl.trail === 'wake') for (const sd of [1, -1]) puffDisc(ctx, e.x - cos * d - sin * sd * (e.S * 0.2 + L * 0.3 * q), e.y - sin * d + cos * sd * (e.S * 0.2 + L * 0.3 * q), 0.5 + q, 1);
      else puffDisc(ctx, e.x - cos * d, e.y - sin * d, 0.5 + q * 1.7, 1);
    }
  }
  ctx.globalAlpha = prev;
}

// ------------------------------------------------------------------------------------------------- line trails

/** Samples kept per ship or plane (the spacing grows with speed so the ring always covers the trail's whole life). */
const CAP = 44;
/** Fade steps: every line of a layer goes into one of these paths. */
const STEPS = 4;
/** Fade steps of the wake's centre taper (fine, so it reads as one smooth fade) and of its arms. */
const WASH_STEPS = 10;
const ARM_STEPS = 6;
/** Fade steps of a contrail. */
const TRAIL_STEPS = 6;
/** Whether a trail sample starts a piece of foam or a gap: about three in five on, in short irregular runs. */
function dashOn(seq: number): boolean {
  const h = Math.imul(seq ^ 0x5bd1e995, 0x27d4eb2d) >>> 0;
  return seq % 4 !== 3 && (h >>> 29) !== 0;
}
/** tan of the Kelvin wake's half angle (19.5 degrees) */
const KELVIN = 0.354;

/** A batch of paths, one per fade step, filled from many units and stroked (or filled) once each. */
class Batch {
  paths: Path2D[] = [];
  used = 0;
  constructor(readonly steps = STEPS) {}
  reset(): void {
    this.paths = [];
    this.used = 0;
    if (typeof Path2D === 'undefined') return;
    for (let i = 0; i < this.steps; i++) this.paths.push(new Path2D());
  }
  // a strip being built: its left and right edge points while they stay in one fade step
  private sl: number[] = [];
  private sr: number[] = [];
  private sStep = -1;
  /**
   * Adds the next pair of edge points of a strip (a taper along a path). Points in the same fade step become one filled
   * polygon, so a strip is a handful of shapes with no seams between its pieces; a change of step starts a new shape
   * sharing the last pair, so the steps join edge to edge.
   */
  stripPoint(step: number, lx: number, ly: number, rx: number, ry: number): void {
    if (step !== this.sStep && this.sl.length) {
      const [x0, y0] = [this.sl[this.sl.length - 2], this.sl[this.sl.length - 1]];
      const [x1, y1] = [this.sr[this.sr.length - 2], this.sr[this.sr.length - 1]];
      this.stripEnd();
      this.sl.push(x0, y0);
      this.sr.push(x1, y1);
    }
    this.sStep = step;
    this.sl.push(lx, ly);
    this.sr.push(rx, ry);
  }
  /** Ends the strip being built (fills its last shape). */
  stripEnd(): void {
    const p = this.paths[this.sStep];
    const n = this.sl.length;
    if (p && n >= 4) {
      p.moveTo(this.sl[0], this.sl[1]);
      for (let i = 2; i < n; i += 2) p.lineTo(this.sl[i], this.sl[i + 1]);
      for (let i = n - 2; i >= 0; i -= 2) p.lineTo(this.sr[i], this.sr[i + 1]);
      p.closePath();
      this.used++;
    }
    this.sl.length = 0;
    this.sr.length = 0;
    this.sStep = -1;
  }
  fill(ctx: CanvasRenderingContext2D, color: string, alpha: (i: number) => number): void {
    if (!this.used) return;
    const prev = ctx.globalAlpha;
    ctx.fillStyle = color;
    for (let i = 0; i < this.paths.length; i++) {
      const a = alpha(i);
      if (a <= 0.01) continue;
      ctx.globalAlpha = prev * a;
      ctx.fill(this.paths[i]);
    }
    ctx.globalAlpha = prev;
  }
  seg(step: number, x0: number, y0: number, x1: number, y1: number): void {
    const p = this.paths[step];
    if (!p) return;
    p.moveTo(x0, y0);
    p.lineTo(x1, y1);
    this.used++;
  }
  stroke(ctx: CanvasRenderingContext2D, color: string, alpha: readonly number[], width: readonly number[], cap: CanvasLineCap = 'round'): void {
    if (!this.used) return;
    const prev = ctx.globalAlpha;
    ctx.strokeStyle = color;
    ctx.lineCap = cap;
    ctx.lineJoin = 'round';
    for (let i = 0; i < this.paths.length; i++) {
      if (alpha[i] <= 0.01) continue;
      ctx.globalAlpha = prev * alpha[i];
      ctx.lineWidth = width[i];
      ctx.stroke(this.paths[i]);
    }
    ctx.globalAlpha = prev;
  }
}

/** One unit's ring of samples (tile coordinates), up to `E` points per sample (engines, or the wake's centre). */
class Track {
  readonly x: Float32Array;
  readonly y: Float32Array;
  /** unit normal of the path at each sample (tiles; wakes spread along it) */
  readonly nx = new Float32Array(CAP);
  readonly ny = new Float32Array(CAP);
  readonly born = new Float64Array(CAP);
  /** half the ship's beam (tiles) and its speed (tiles/s) at each sample */
  readonly hw = new Float32Array(CAP);
  readonly sp = new Float32Array(CAP);
  /** each sample's running number (stable while it lives: the broken dashes of a wake or contrail stay put) */
  readonly seq = new Uint32Array(CAP);
  private count = 0;
  /** half the ship's length (tiles): its wake's arms reach a multiple of it */
  half = 0;
  n = 0;
  head = 0;
  lx = 0;
  ly = 0;
  seen = 0;
  sub = false;
  /** contrails: how strong this plane's trails are (0..1), how long they last (ms), the engines now (tiles) */
  weight = 1;
  life = 0;
  live = false;
  readonly ex = new Float32Array(4);
  readonly ey = new Float32Array(4);
  constructor(readonly E: number) {
    this.x = new Float32Array(CAP * E);
    this.y = new Float32Array(CAP * E);
  }
  /** index of the k-th newest sample */
  at(k: number): number {
    return (this.head - 1 - k + CAP * 4) % CAP;
  }
  push(born: number): number {
    const i = this.head;
    this.born[i] = born;
    this.seq[i] = this.count++;
    this.head = (i + 1) % CAP;
    this.n = Math.min(CAP, this.n + 1);
    return i;
  }
}

/** Contrail emitters of a plane (model units across the wing, + = starboard) and how strong they are. */
const ENGINES: Partial<Record<SpriteKey, { v: readonly number[]; w: number }>> = {
  bomber: { v: [-5, 5], w: 0.85 },
  heavyBomber: { v: [-11.4, -5.4, 5.4, 11.4], w: 1 },
  transportPlane: { v: [-6.5, 6.5], w: 0.8 },
  reconPlane: { v: [-3.4, 3.4], w: 0.7 },
  // wingtip vortices only: faint
  fighter: { v: [-7, 7], w: 0.45 },
  groundAttack: { v: [-9.5, 9.5], w: 0.3 },
};

/** The wakes of the ships of one layer. */
class WakeLayer implements TrailLayer {
  private tracks = new Map<number, Track>();
  private frameNo = 0;
  private arms = new Batch(ARM_STEPS);
  private wash = new Batch(WASH_STEPS);
  private core = new Batch(WASH_STEPS);
  private bow = new Batch();

  clear(): void {
    this.tracks.clear();
  }

  frame(ctx: CanvasRenderingContext2D, units: readonly TrailUnit[], view: TrailView): void {
    const z = view.zoom;
    const g = view.scale;
    const now = view.now;
    this.frameNo++;
    // lay new samples at each moving ship's stern
    let m: MotionParams | null = null;
    for (const u of units) {
      if (unitCategoryOf(u.key) !== 'ships') continue;
      m = u.motion;
      let t = this.tracks.get(u.id);
      // far out no new wake is laid (the old foam still fades out)
      if (!t && !view.full) continue;
      if (!t) this.tracks.set(u.id, (t = new Track(1)));
      t.seen = this.frameNo;
      if (!u.moving || !view.full || u.speed <= 0) continue;
      t.sub = u.key === 'submarine';
      t.half = u.half / z;
      const c = Math.cos(u.angle);
      const s = Math.sin(u.angle);
      const back = (u.half * 0.92) / z;
      const sx = u.tx - c * back;
      const sy = u.ty - s * back * FORE;
      const life = this.lifeMs(u.motion);
      const spacing = Math.max((1.6 * g) / z, (u.speed * life) / 1000 / (CAP - 4));
      const d = Math.hypot(sx - t.lx, sy - t.ly);
      if (t.n && d < spacing) continue;
      // a jump (a teleport, a long pause) starts a fresh wake
      if (t.n && d > spacing * 40) t.n = 0;
      const i = t.push(now);
      t.x[i] = sx;
      t.y[i] = sy;
      t.nx[i] = -s;
      t.ny[i] = c;
      t.hw[i] = ((refinedBeam(u.key) * 0.8 * g) / z) * (t.sub ? 0.5 : 1);
      t.sp[i] = u.speed;
      t.lx = sx;
      t.ly = sy;
    }
    if (typeof Path2D === 'undefined') return;
    this.arms.reset();
    this.wash.reset();
    this.core.reset();
    this.bow.reset();
    const spread = m?.wakeSpread ?? 1;
    const life = this.lifeMs(m);
    const foamLife = 950 * (m?.foamLife ?? 1);
    // the arms reach about a ship length (less in the subtle preset, a little more in the cinematic one)
    const armReach = 0.55 + 0.4 * (m?.wakeLength ?? 1);
    const { ox, oy } = view;
    const W = view.viewW + 60;
    const H = view.viewH + 60;
    for (const [id, t] of this.tracks) {
      if (this.frameNo - t.seen > 120 && (!t.n || now - t.born[t.at(0)] > life)) {
        this.tracks.delete(id);
        continue;
      }
      const armCap = t.half * 2 * armReach;
      let dist = 0;
      let px = 0;
      let py = 0;
      let pax = 0;
      let pay = 0;
      let pbx = 0;
      let pby = 0;
      let pwo = 0;
      let pwc = 0;
      let pnx = 0;
      let pny = 0;
      for (let k = 0; k < t.n; k++) {
        const i = t.at(k);
        const age = now - t.born[i];
        if (age >= life) break;
        const q = age / life;
        const sp = t.sp[i];
        const sf = Math.min(1.4, Math.max(0.2, sp / 5));
        const cx = ox + t.x[i] * z;
        const cy = oy + t.y[i] * z;
        const nx = t.nx[i];
        const ny = t.ny[i];
        // the V: both arms move out from the hull at the Kelvin angle as the wake ages
        const lat = (t.hw[i] + ((sp * age) / 1000) * KELVIN * spread) * z;
        const ax = cx + nx * lat;
        const ay = cy + ny * lat;
        const bx = cx - nx * lat;
        const by = cy - ny * lat;
        // the churned water: one taper, narrow at the stern and widening behind; a brighter core near the stern
        const qf = age / foamLife;
        const hwpx = t.hw[i] * z;
        const wo = Math.max(0.8 * g, hwpx * (0.5 + 0.5 * Math.min(1, qf)));
        const wc = Math.max(0.5 * g, hwpx * 0.3 * (1 - 0.5 * Math.min(1, qf)));
        if (k > 0) {
          const j = t.at(k - 1);
          dist += Math.hypot(t.x[i] - t.x[j], t.y[i] - t.y[j]);
          if (cx > -60 && cy > -60 && cx < W && cy < H) {
            // the arms: short broken foam dashes, fading and widening with age, no further back than armCap
            const qa = Math.max(q / 0.65, armCap > 0 ? dist / armCap : 0);
            if (!t.sub && qa < 1) {
              // each arm broken on its own: pieces of foam of uneven strength, a little off the line
              const sq = t.seq[i];
              const base = Math.floor(qa * ARM_STEPS) + (sf < 0.45 ? 1 : 0);
              for (let side = 0; side < 2; side++) {
                const h = Math.imul((sq * 2 + side) ^ 0x2c1b3c6d, 0x297a2d39) >>> 0;
                if ((h & 7) < 3) continue;
                const step = Math.min(ARM_STEPS - 1, base + ((h >>> 4) % 3 === 0 ? 1 : 0));
                const j = (((h >>> 8) & 255) / 255 - 0.5) * g;
                // a fleck of foam: only part of the way between the two samples, starting and ending anywhere
                const f0 = ((h >>> 16) & 255) / 640;
                const f1 = f0 + 0.3 + ((h >>> 24) & 255) / 640;
                const [x0, y0, x1, y1] = side === 0 ? [pax + nx * j, pay + ny * j, ax + nx * j, ay + ny * j] : [pbx - nx * j, pby - ny * j, bx - nx * j, by - ny * j];
                this.arms.seg(step, x0 + (x1 - x0) * f0, y0 + (y1 - y0) * f0, x0 + (x1 - x0) * f1, y0 + (y1 - y0) * f1);
              }
            }
            if (qf < 1) {
              if (k === 1) this.wash.stripPoint(0, px + pnx * pwo, py + pny * pwo, px - pnx * pwo, py - pny * pwo);
              this.wash.stripPoint(Math.min(WASH_STEPS - 1, Math.floor(qf * WASH_STEPS)), cx + nx * wo, cy + ny * wo, cx - nx * wo, cy - ny * wo);
              const qc = qf / 0.55;
              if (qc < 1) {
                if (k === 1) this.core.stripPoint(0, px + pnx * pwc, py + pny * pwc, px - pnx * pwc, py - pny * pwc);
                this.core.stripPoint(Math.min(WASH_STEPS - 1, Math.floor(qc * WASH_STEPS)), cx + nx * wc, cy + ny * wc, cx - nx * wc, cy - ny * wc);
              }
            }
          }
        }
        px = cx;
        py = cy;
        pax = ax;
        pay = ay;
        pbx = bx;
        pby = by;
        pwo = wo;
        pwc = wc;
        pnx = nx;
        pny = ny;
      }
      this.wash.stripEnd();
      this.core.stripEnd();
    }
    // the bow waves of the ships under way, folded out from the stem along both sides (not far out)
    for (const u of view.full ? units : []) {
      if (!u.moving || unitCategoryOf(u.key) !== 'ships' || u.speed <= 0) continue;
      const sf = Math.min(1.4, Math.max(0.2, u.speed / 5));
      const c = Math.cos(u.angle);
      const s = Math.sin(u.angle);
      const sub = u.key === 'submarine';
      const fwd = sub ? 0.25 : 0.95;
      const bx = u.x + c * u.half * fwd;
      const by = u.y + s * u.half * fwd * FORE;
      const hw = refinedBeam(u.key) * g * (sub ? 0.5 : 0.9);
      const L = u.half * (0.35 + 0.35 * sf);
      const out = hw * (0.5 + 0.6 * sf);
      for (const sd of [-1, 1]) {
        const nx = -s * sd;
        const ny = c * FORE * sd;
        let x0 = bx;
        let y0 = by;
        for (let j = 1; j <= 3; j++) {
          const f = j / 3;
          const x1 = bx - c * L * f + nx * (hw * 0.55 + out * Math.sqrt(f));
          const y1 = by - s * L * f * FORE + ny * (hw * 0.55 + out * Math.sqrt(f));
          this.bow.seg(Math.min(STEPS - 1, j - 1 + (sf < 0.45 ? 1 : 0)), x0, y0, x1, y1);
          x0 = x1;
          y0 = y1;
        }
      }
    }
    const k = g;
    this.wash.fill(ctx, FX.foamDim, (i) => 0.4 * (1 - (i + 0.5) / WASH_STEPS) ** 1.3);
    this.core.fill(ctx, FX.foam, (i) => 0.5 * (1 - (i + 0.5) / WASH_STEPS) ** 1.6);
    this.arms.stroke(ctx, FX.foam, [0.36, 0.29, 0.22, 0.15, 0.09, 0.04], [0.9 * k, 1.1 * k, 1.3 * k, 1.5 * k, 1.8 * k, 2.1 * k], 'butt');
    this.bow.stroke(ctx, FX.foam, [0.85, 0.6, 0.35, 0.2], [1.2 * k, 1.1 * k, 1 * k, 1 * k]);
  }

  private lifeMs(m: MotionParams | null | undefined): number {
    return 1500 * (m?.wakeLength ?? 1);
  }
}

/** Contrails of planes (lines from the engines) and missile smoke (puffs) of one layer. */
class ContrailLayer implements TrailLayer {
  readonly puffs = new TrailPuffs();
  private list: TrailInst[] = [];
  private tracks = new Map<number, Track>();
  private frameNo = 0;
  private lines = new Batch(TRAIL_STEPS);

  clear(): void {
    this.puffs.clear();
    this.tracks.clear();
  }

  frame(ctx: CanvasRenderingContext2D, units: readonly TrailUnit[], view: TrailView): void {
    const z = view.zoom;
    const g = view.scale;
    const now = view.now;
    this.frameNo++;
    const list = this.list;
    list.length = 0;
    let m: MotionParams | null = null;
    for (const u of units) {
      const cat = unitCategoryOf(u.key);
      if (cat === 'missiles') {
        list.push({ type: unitTypeOf(u.key), x: u.x, y: u.y, angle: u.angle, S: u.half, moving: u.moving, id: u.id, tx: u.tx, ty: u.ty, motion: u.motion });
        continue;
      }
      if (cat !== 'air') continue;
      const eng = ENGINES[u.key];
      if (!eng) continue;
      m = u.motion;
      let t = this.tracks.get(u.id);
      if (!t && !view.full) continue;
      if (!t || t.E !== eng.v.length) this.tracks.set(u.id, (t = new Track(eng.v.length)));
      t.seen = this.frameNo;
      t.weight = eng.w;
      const life = this.lifeMs(u.motion);
      const c = Math.cos(u.angle);
      const s = Math.sin(u.angle);
      const back = (u.half * 0.55) / z;
      const cx = u.tx - c * back;
      const cy = u.ty - s * back * FORE;
      // where the engines are now: the trail runs up to them
      for (let e = 0; e < t.E; e++) {
        const v = (eng.v[e] * g) / z;
        t.ex[e] = cx - s * v;
        t.ey[e] = cy + c * v * FORE;
      }
      t.live = view.full;
      // a fast plane's trail is capped at a few plane lengths (its samples age out sooner)
      t.life = Math.min(life, ((u.half * 9) / Math.max(1e-3, u.speed * z)) * 1000);
      if (!view.full) continue;
      const spacing = Math.max((1.5 * g) / z, (Math.max(0.5, u.speed) * t.life) / 1000 / (CAP - 4));
      const d = Math.hypot(cx - t.lx, cy - t.ly);
      if (t.n && d < spacing) continue;
      if (t.n && d > spacing * 40) t.n = 0;
      const i = t.push(now);
      for (let e = 0; e < t.E; e++) {
        t.x[i * t.E + e] = t.ex[e];
        t.y[i * t.E + e] = t.ey[e];
      }
      t.lx = cx;
      t.ly = cy;
    }
    if (typeof Path2D !== 'undefined') {
      this.lines.reset();
      const life = this.lifeMs(m);
      const { ox, oy } = view;
      for (const [id, t] of this.tracks) {
        const tl = t.life || life;
        if (this.frameNo - t.seen > 120 && (!t.n || now - t.born[t.at(0)] > tl)) {
          this.tracks.delete(id);
          continue;
        }
        const fresh = t.weight < 0.5 ? 1 : 0;
        // from the engines (while the plane is here) back along the samples, fading with age
        if (t.n && t.live && this.frameNo === t.seen) {
          const i = t.at(0);
          for (let e = 0; e < t.E; e++) this.lines.seg(fresh, ox + t.ex[e] * z, oy + t.ey[e] * z, ox + t.x[i * t.E + e] * z, oy + t.y[i * t.E + e] * z);
        }
        // back along the samples: each point drifts a little downwind with its age, the trail widens and softens, breaks
        // into pieces over its older half and fades out over its last third (no hard end)
        let pAge = now - t.born[t.at(0)];
        for (let k = 1; k < t.n; k++) {
          const i = t.at(k);
          const j = t.at(k - 1);
          const age = now - t.born[i];
          if (age >= tl) break;
          const q = age / tl;
          const ja = pAge;
          pAge = age;
          // over its older half the trail breaks into flecks of uneven length (never an even dashed line)
          const hs = Math.imul(t.seq[i] ^ 0x51ed270b, 0x2c1b3c6d) >>> 0;
          if (q > 0.45 && !dashOn(t.seq[i])) continue;
          const step = Math.min(TRAIL_STEPS - 1, Math.floor(q * TRAIL_STEPS) + fresh);
          const wi = (age / 1000) * g;
          const wj = (ja / 1000) * g;
          // the trails of a plane's engines also spread apart a little as they age (not ruler-parallel lines)
          let mxi = 0;
          let myi = 0;
          let mxj = 0;
          let myj = 0;
          for (let e = 0; e < t.E; e++) {
            mxi += t.x[i * t.E + e] / t.E;
            myi += t.y[i * t.E + e] / t.E;
            mxj += t.x[j * t.E + e] / t.E;
            myj += t.y[j * t.E + e] / t.E;
          }
          const si = 1 + (age / 1000) * 0.35;
          const sj = 1 + (ja / 1000) * 0.35;
          for (let e = 0; e < t.E; e++) {
            const xj = mxj + (t.x[j * t.E + e] - mxj) * sj;
            const yj = myj + (t.y[j * t.E + e] - myj) * sj;
            const xi = mxi + (t.x[i * t.E + e] - mxi) * si;
            const yi = myi + (t.y[i * t.E + e] - myi) * si;
            const ax = ox + xj * z + wj * 1.4;
            const ay = oy + yj * z - wj * 0.7;
            const bx = ox + xi * z + wi * 1.4;
            const by = oy + yi * z - wi * 0.7;
            // each engine's trail breaks on its own
            const cut = q > 0.45 ? ((hs >>> (e * 5 + 6)) & 255) / 512 : 0;
            this.lines.seg(step, ax + (bx - ax) * cut, ay + (by - ay) * cut, bx - (bx - ax) * cut * 0.5, by - (by - ay) * cut * 0.5);
          }
        }
      }
      this.lines.stroke(ctx, FX.foam, [0.5, 0.42, 0.32, 0.2, 0.1, 0.035], [0.8 * g, 1 * g, 1.3 * g, 1.6 * g, 2 * g, 2.4 * g], 'butt');
    }
    if (list.length || this.puffs.made) drawTrails(ctx, list, view.full, this.puffs, { ox: view.ox, oy: view.oy, z, g, now, viewW: view.viewW, viewH: view.viewH });
  }

  private lifeMs(m: MotionParams | null | undefined): number {
    return 1500 * (m?.contrailLife ?? 1);
  }
}

// ------------------------------------------------------------------------------------------------- layers

/** A unit glyph instance with the motion of the unit its trail follows (multipliers; lively = 1). */
export type TrailInst = Inst & { motion?: MotionParams };

export const refinedWakes: TrailArt = { createLayer: () => new WakeLayer() };
export const refinedContrails: TrailArt = { createLayer: () => new ContrailLayer() };
