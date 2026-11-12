// The refined style's wakes and contrails (client only).
//
// Contrails and wakes are short lines of small pixel PUFFS, not lines: smoke behind missiles (white-hot at the engine,
// then light grey, tapering from about one missile width to two or three, fading out within a second), faint smoke
// behind planes, and foam puffs at both sides of a moving ship's stern that drift apart into a V. Puffs stay where
// they were made (world coordinates) and fade there, so a trail lingers and breaks up behind the unit. One small ring
// buffer of puffs (TrailPuffs) per unit layer; drawn as whole-pixel discs on the sprites' pixel grid. Without a
// buffer (tests, previews) the same puffs are laid out along the heading instead.

import { GLYPHS, type Inst, type TrailKind } from '../../render/unitGlyphs';
import type { MotionParams } from '../motion';
import { unitTypeOf } from '../shared/keys';
import type { TrailArt, TrailLayer, TrailUnit, TrailView } from '../types';

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
        ctx.globalAlpha = prev * 0.7 * (1 - q);
        ctx.fillStyle = q < 0.3 ? '#ffffff' : '#dcebf3';
      } else {
        // white-hot at the engine, then a neutral light grey; from 0.7 at the front to nothing at the tail
        ctx.globalAlpha = prev * (k === FAINT ? 0.45 : 0.7) * (1 - q);
        ctx.fillStyle = q < 0.12 && k === SMOKE ? '#fffbe8' : q < 0.45 ? '#e6e6e1' : '#c6c6c0';
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
 * Contrails (missiles at every zoom; planes and ship wakes only with `wakes`, i.e. not far out) behind the units.
 * With a puff buffer and a view, puffs are dropped along the way each unit went (Inst.id, tx, ty needed) and drawn
 * where they were dropped; without, the same puffs are laid out along each unit's heading.
 */
export function drawTrails(ctx: CanvasRenderingContext2D, list: readonly TrailInst[], wakes: boolean, puffs?: TrailPuffs, view?: PuffView): void {
  if (puffs && view) {
    const { z, g, now } = view;
    puffs.begin();
    for (const e of list) {
      const gl = GLYPHS[e.type];
      if (gl.trail === 'none' || e.id === undefined || e.tx === undefined || e.ty === undefined) continue;
      if (gl.trail !== 'missile' && !wakes) continue;
      const cos = Math.cos(e.angle);
      const sin = Math.sin(e.angle);
      const back = (e.S * 0.9) / z;
      if (gl.trail === 'missile') {
        // narrow and white-hot at the engine, growing from one to three cells and broken up toward the back, about
        // five missile lengths long
        const big = e.type === 'atomBomb';
        const lm = e.motion?.missileTrailLife ?? 1;
        const life = (z < 3 ? 1100 : 600) * lm;
        puffs.emit(e.id * 4, e.tx - cos * back, e.ty - sin * back, (2.5 * g) / z, now, life, 1, big ? 3.4 : 3, SMOKE, 1.2 / z, -2 / z, (1.2 * g) / z, ((5 * 2 * e.S) / z) * lm);
      } else if (gl.trail === 'air') {
        puffs.emit(e.id * 4, e.tx - cos * back, e.ty - sin * back, (3.5 * g) / z, now, 300 * (e.motion?.contrailLife ?? 1), 0.5, 1.6, FAINT, 0, 0, (0.8 * g) / z);
      } else if (e.moving) {
        // foam at both sides of the stern, drifting outward: a V behind the ship
        const side = (e.S * 0.22) / z;
        const spread = (0.9 / Math.max(1, z * 0.15)) * (e.motion?.wakeSpread ?? 1);
        const life = 1100 * (e.motion?.wakeLength ?? 1);
        for (const sd of [1, -1]) puffs.emit(e.id * 4 + (sd > 0 ? 1 : 2), e.tx - cos * back * 0.95 - sin * side * sd, e.ty - sin * back * 0.95 + cos * side * sd, (3 * g) / z, now, life, 0.4, 1.1, FOAM, -sin * sd * spread, cos * sd * spread);
      }
    }
    puffs.draw(ctx, view.ox, view.oy, z, g, now, view.viewW, view.viewH);
    // the white-hot core at each missile's nozzle: two near-white cells just behind the flame
    const pa = ctx.globalAlpha;
    for (const e of list) {
      if (GLYPHS[e.type].trail !== 'missile') continue;
      const cos = Math.cos(e.angle);
      const sin = Math.sin(e.angle);
      ctx.globalAlpha = pa * 0.95;
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(Math.round((e.x - cos * (e.S + 0.5 * g)) / g) * g, Math.round((e.y - sin * (e.S + 0.5 * g)) / g) * g, g, g);
      ctx.fillStyle = '#fff3c4';
      ctx.fillRect(Math.round((e.x - cos * (e.S + 1.6 * g)) / g) * g, Math.round((e.y - sin * (e.S + 1.6 * g)) / g) * g, g, g);
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
      ctx.globalAlpha = prev * (gl.trail === 'missile' ? 0.72 : 0.45) * (1 - q * 0.85);
      ctx.fillStyle = gl.trail === 'wake' ? '#ffffff' : q < 0.15 ? '#fffbe8' : '#e0e0db';
      if (gl.trail === 'wake') for (const sd of [1, -1]) puffDisc(ctx, e.x - cos * d - sin * sd * (e.S * 0.2 + L * 0.3 * q), e.y - sin * d + cos * sd * (e.S * 0.2 + L * 0.3 * q), 0.5 + q, 1);
      else puffDisc(ctx, e.x - cos * d, e.y - sin * d, 0.5 + q * 1.7, 1);
    }
  }
  ctx.globalAlpha = prev;
}


// ------------------------------------------------------------------------------------------------- layers

/** A unit glyph instance with the motion of the unit its trail follows (multipliers; lively = 1). */
export type TrailInst = Inst & { motion?: MotionParams };

/** One live set of puff trails for the kinds of units it draws (ships: wakes; planes and missiles: contrails). */
class PuffLayer implements TrailLayer {
  readonly puffs = new TrailPuffs();
  private list: TrailInst[] = [];

  constructor(private readonly kinds: ReadonlySet<TrailKind>) {}

  clear(): void {
    this.puffs.clear();
  }

  frame(ctx: CanvasRenderingContext2D, units: readonly TrailUnit[], view: TrailView): void {
    const list = this.list;
    list.length = 0;
    for (const u of units) {
      const type = unitTypeOf(u.key);
      if (!this.kinds.has(GLYPHS[type].trail)) continue;
      list.push({ type, x: u.x, y: u.y, angle: u.angle, S: u.half, moving: u.moving, id: u.id, tx: u.tx, ty: u.ty, motion: u.motion });
    }
    drawTrails(ctx, list, view.full, this.puffs, { ox: view.ox, oy: view.oy, z: view.zoom, g: view.scale, now: view.now, viewW: view.viewW, viewH: view.viewH });
  }
}

const WAKE_KINDS: ReadonlySet<TrailKind> = new Set<TrailKind>(['wake']);
const CONTRAIL_KINDS: ReadonlySet<TrailKind> = new Set<TrailKind>(['air', 'missile']);

export const refinedWakes: TrailArt = { createLayer: () => new PuffLayer(WAKE_KINDS) };
export const refinedContrails: TrailArt = { createLayer: () => new PuffLayer(CONTRAIL_KINDS) };
