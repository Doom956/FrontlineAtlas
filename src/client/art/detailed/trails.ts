// The detailed style's wakes and contrails (client only). Everything is laid on the map (tile coordinates) where the
// unit was and fades there, so a trail stays behind and breaks up as the unit moves on:
//   wakes      a moving ship drops foam at both sides of its stern that drifts outward at a fixed fraction of its
//              speed, so the two arms open into the V of a real (Kelvin) wake whose length grows with speed; a
//              churned wash runs down the middle; a bow wave curls off both sides of the bow, bigger the faster the
//              ship goes. A submarine leaves only a thin wash and a small bow ripple.
//   contrails  thin white lines from each engine of a plane that widen and fade; a missile leaves a white smoke
//              trail of puffs that swell as they age, with the hot glow of the motor at its head.
// Motion: wakeLength, foamLife and wakeSpread (ships), contrailLife (planes), missileTrailLife (missiles).
// Foam and contrail specks are small squares on the art pixel grid, collected into a few batches by tone and drawn
// with one fill each, so hundreds of ships and planes stay cheap; missile smoke is the shared puffs (blobs.ts).
import { unitCategoryOf } from '../shared/keys';
import type { TrailArt, TrailLayer, TrailUnit, TrailView } from '../types';
import { drawBlob } from './blobs';
import { gridOf, type Grid } from './grid';
import { unitModel } from './models';

/** Particle kinds. */
const ARM = 0;
const WASH = 1;
const TRAIL = 2;
const SMOKE = 3;

/** Tones of foam and vapour, light to dim. */
const FOAM_TONES = ['#eef3f4', '#d3dde1', '#aebdc4'];
const BATCH_LEVELS = 8;

class Particles {
  readonly x: Float32Array;
  readonly y: Float32Array;
  readonly vx: Float32Array;
  readonly vy: Float32Array;
  readonly born: Float64Array;
  readonly life: Float32Array;
  readonly r0: Float32Array;
  readonly r1: Float32Array;
  readonly a0: Float32Array;
  readonly kind: Uint8Array;
  readonly seed: Float32Array;
  private head = 0;
  made = 0;
  constructor(readonly cap: number) {
    this.x = new Float32Array(cap);
    this.y = new Float32Array(cap);
    this.vx = new Float32Array(cap);
    this.vy = new Float32Array(cap);
    this.born = new Float64Array(cap);
    this.life = new Float32Array(cap);
    this.r0 = new Float32Array(cap);
    this.r1 = new Float32Array(cap);
    this.a0 = new Float32Array(cap);
    this.kind = new Uint8Array(cap);
    this.seed = new Float32Array(cap);
  }
  clear(): void {
    this.life.fill(0);
    this.head = 0;
  }
  put(x: number, y: number, vx: number, vy: number, born: number, life: number, r0: number, r1: number, a0: number, kind: number): void {
    const i = this.head;
    this.x[i] = x;
    this.y[i] = y;
    this.vx[i] = vx;
    this.vy[i] = vy;
    this.born[i] = born;
    this.life[i] = life;
    this.r0[i] = r0;
    this.r1[i] = r1;
    this.a0[i] = a0;
    this.kind[i] = kind;
    const s = Math.sin(this.made * 12.9898 + 4.1) * 43758.5453;
    this.seed[i] = s - Math.floor(s);
    this.head = (i + 1) % this.cap;
    this.made++;
  }
}

interface Emitter {
  x: number;
  y: number;
  frame: number;
  /** clock of the last frame it was seen (ms) */
  t: number;
}

/** One live set of trails (wakes, or contrails and missile smoke). */
class DetailedTrails implements TrailLayer {
  private parts: Particles;
  private emitters = new Map<number, Emitter>();
  private frameNo = 0;
  private paths: Path2D[] = [];
  private used: boolean[] = [];

  constructor(private readonly wakes: boolean) {
    this.parts = new Particles(wakes ? 5000 : 7000);
  }

  clear(): void {
    this.parts.clear();
    this.emitters.clear();
  }

  /**
   * Lays particles every `spacing` tiles along the way emitter `key` went since last frame, ending at (x, y) tiles. A
   * jump (a new unit, a teleport, a long pause) starts afresh without a streak.
   */
  private emit(key: number, x: number, y: number, spacing: number, now: number, lay: (px: number, py: number, born: number) => void): void {
    const e = this.emitters.get(key);
    // not seen last frame, or the clock jumped (a hidden view, a pause): start afresh instead of drawing a streak
    if (!e || this.frameNo - e.frame > 3 || Math.abs(now - e.t) > 250) {
      if (e) {
        e.x = x;
        e.y = y;
        e.frame = this.frameNo;
        e.t = now;
      } else this.emitters.set(key, { x, y, frame: this.frameNo, t: now });
      lay(x, y, now);
      return;
    }
    e.frame = this.frameNo;
    e.t = now;
    const dx = x - e.x;
    const dy = y - e.y;
    const d = Math.hypot(dx, dy);
    if (d < spacing) return;
    if (d > spacing * 40) {
      e.x = x;
      e.y = y;
      lay(x, y, now);
      return;
    }
    const n = Math.min(40, Math.floor(d / spacing));
    for (let k = 1; k <= n; k++) {
      const q = (k * spacing) / d;
      lay(e.x + dx * q, e.y + dy * q, now - (1 - q) * 16);
    }
    e.x += (dx * n * spacing) / d;
    e.y += (dy * n * spacing) / d;
  }

  frame(ctx: CanvasRenderingContext2D, units: readonly TrailUnit[], view: TrailView): void {
    this.frameNo++;
    if (this.frameNo % 120 === 0) for (const [k, e] of this.emitters) if (this.frameNo - e.frame > 60) this.emitters.delete(k);
    const g = gridOf(view.scale, view.dpr);
    const z = Math.max(0.05, view.zoom);
    const cellT = g.k / z;
    const now = view.now;
    const P = this.parts;
    for (const u of units) {
      const cat = unitCategoryOf(u.key);
      const m = u.motion;
      const c = Math.cos(u.angle);
      const s = Math.sin(u.angle);
      const halfT = u.half / z;
      if (this.wakes) {
        if (cat !== 'ships' || !view.full || !u.moving) continue;
        const sub = u.key === 'submarine';
        const sp = Math.max(0.25, Math.min(1.6, u.speed / 2.4));
        // the stern, and the arms' outward drift: about a third of the speed, so the V keeps its angle
        const sx = u.tx - c * halfT * 0.9;
        const sy = u.ty - s * halfT * 0.9;
        const side = halfT * (sub ? 0.06 : 0.13);
        const out = Math.max(0.15, u.speed) * 0.36 * m.wakeSpread;
        const armLife = 1500 * m.wakeLength * (0.7 + 0.3 * sp);
        if (!sub) {
          for (const sd of [1, -1]) {
            this.emit(u.id * 4 + (sd > 0 ? 1 : 2), sx - s * side * sd, sy + c * side * sd, cellT * 1.2, now, (px, py, born) => {
              P.put(px, py, -s * sd * out, c * sd * out, born, armLife, 0.8, 2 + 0.6 * sp, 0.85, ARM);
              // a second, slower fleck inside the arm: the foam band has some width
              P.put(px, py, -s * sd * out * 0.7, c * sd * out * 0.7, born, armLife * 0.8, 0.6, 1.4 + 0.4 * sp, 0.6, ARM);
            });
          }
        }
        this.emit(u.id * 4 + 3, sx, sy, cellT * 1.3, now, (px, py, born) => {
          const j = (Math.sin(P.made * 7.31) * 0.5) * side;
          P.put(px - s * j, py + c * j, -s * j * 0.4, c * j * 0.4, born, (sub ? 700 : 1100) * m.foamLife * (0.7 + 0.3 * sp), sub ? 0.5 : 0.9, sub ? 1 : 1.8 + 0.6 * sp, sub ? 0.5 : 0.8, WASH);
        });
      } else {
        if (cat === 'missiles') {
          const big = u.key === 'atomBomb';
          const back = halfT * 1.05;
          const life = (view.zoom < 3 ? 1700 : 1200) * m.missileTrailLife;
          this.emit(u.id * 4, u.tx - c * back, u.ty - s * back, cellT * (big ? 2.2 : 1.8), now, (px, py, born) => {
            P.put(px, py, 0, -0.06 / Math.max(0.3, z * 0.05), born, life, big ? 1.1 : 0.8, big ? 4.2 : 3.2, 0.8, SMOKE);
          });
          continue;
        }
        if (cat !== 'air' || !view.full) continue;
        // a thin line from each engine (twin, four engines, or one), from just behind the wing
        const um = unitModel(u.key, 0);
        const src = um.props.length ? um.props : um.nozzles;
        const scaleT = view.scale / z;
        const life = 1700 * m.contrailLife;
        src.forEach((p, i) => {
          const du = (um.props.length ? p.u - 4 : p.u) * scaleT;
          const dv = p.v * scaleT;
          this.emit(u.id * 8 + i, u.tx + c * du - s * dv, u.ty + s * du + c * dv, cellT, now, (px, py, born) => {
            P.put(px, py, 0, 0, born, life, 0.6, 2.2, 0.75, TRAIL);
          });
        });
      }
    }
    this.used.length = 0;
    if (this.wakes && view.full) for (const u of units) if (u.moving && unitCategoryOf(u.key) === 'ships') this.bowWave(u, g, view);
    this.draw(ctx, view, g, z);
  }

  /** The bow wave of a moving ship: foam curling off both sides of the bow, longer the faster it goes (batched). */
  private bowWave(u: TrailUnit, g: Grid, view: TrailView): void {
    const sub = u.key === 'submarine';
    const sp = Math.max(0.2, Math.min(1.6, u.speed / 2.4));
    const c = Math.cos(u.angle);
    const s = Math.sin(u.angle);
    const bx = u.x + c * u.half * 0.98;
    const by = u.y + s * u.half * 0.98;
    if (bx < -40 || by < -40 || bx > view.viewW + 40 || by > view.viewH + 40) return;
    const cell = g.p / g.dpr;
    const n = Math.round((sub ? 2 : 3 + 5 * sp) * Math.min(1.6, u.motion.wakeLength));
    const spread = (sub ? 0.45 : 0.62) * u.motion.wakeSpread;
    for (const sd of [1, -1]) {
      // the arm runs back from the bow at an angle
      const ax = -c * Math.cos(spread) + s * Math.sin(spread) * sd;
      const ay = -s * Math.cos(spread) - c * Math.sin(spread) * sd;
      for (let j = 0; j < n; j++) {
        const d = (j + 0.5) * cell * 1.4;
        const a = (sub ? 0.45 : 0.85) * (1 - j / n) * (0.55 + 0.45 * Math.min(1, sp));
        const level = Math.max(1, Math.min(BATCH_LEVELS, Math.round(a * BATCH_LEVELS)));
        const path = this.batch(level, j < 2 ? 0 : 1);
        if (!path) return;
        const X = (Math.round(((bx + ax * d) * g.dpr) / g.p) * g.p) / g.dpr;
        const Y = (Math.round(((by + ay * d) * g.dpr) / g.p) * g.p) / g.dpr;
        path.rect(X, Y, cell, cell);
        if (j < n / 2 && !sub) path.rect(X - ax * cell, Y + cell, cell, cell);
      }
    }
  }

  private batch(level: number, tone: number): Path2D | null {
    if (typeof Path2D === 'undefined') return null;
    const k = tone * (BATCH_LEVELS + 1) + level;
    if (!this.used[k] || !this.paths[k]) {
      this.paths[k] = new Path2D();
      this.used[k] = true;
    }
    return this.paths[k];
  }

  private draw(ctx: CanvasRenderingContext2D, view: TrailView, g: Grid, z: number): void {
    const P = this.parts;
    const now = view.now;
    const cell = g.p / g.dpr;
    const W = view.viewW + 40;
    const H = view.viewH + 40;
    const smoke: number[] = [];
    for (let i = 0; i < P.cap; i++) {
      const life = P.life[i];
      if (life <= 0) continue;
      const age = now - P.born[i];
      if (age >= life) {
        P.life[i] = 0;
        continue;
      }
      if (age < 0) continue;
      const q = age / life;
      const sx = view.ox + (P.x[i] + (P.vx[i] * age) / 1000) * z;
      const sy = view.oy + (P.y[i] + (P.vy[i] * age) / 1000) * z;
      if (sx < -40 || sy < -40 || sx > W || sy > H) continue;
      const k = P.kind[i];
      if (k === SMOKE) {
        smoke.push(i);
        continue;
      }
      // foam breaks up as it ages: some specks drop out
      if (q > 0.45 && P.seed[i] < (q - 0.45) * 1.3) continue;
      const r = P.r0[i] + (P.r1[i] - P.r0[i]) * Math.sqrt(q);
      const a = P.a0[i] * (1 - q) * (k === TRAIL ? 1 - q * 0.3 : 1);
      const level = Math.max(1, Math.min(BATCH_LEVELS, Math.round(a * BATCH_LEVELS)));
      const tone = k === TRAIL ? (q < 0.4 ? 0 : 1) : q < 0.25 ? 0 : q < 0.6 ? 1 : 2;
      const path = this.batch(level, tone);
      const n = Math.max(1, Math.round(r * (k === ARM ? 1.2 : 1)));
      const X = (Math.round((sx * g.dpr) / g.p - n / 2) * g.p) / g.dpr;
      const Y = (Math.round((sy * g.dpr) / g.p - n / 2) * g.p) / g.dpr;
      if (path) {
        path.rect(X, Y, n * cell, n * cell);
        // an older wash speck spreads into a ragged pair
        if (k !== TRAIL && q > 0.3 && n >= 2) path.rect(X + (P.seed[i] > 0.5 ? cell : -cell), Y + cell, cell, cell);
      } else {
        ctx.globalAlpha = level / BATCH_LEVELS;
        ctx.fillStyle = FOAM_TONES[tone];
        ctx.fillRect(X, Y, n * cell, n * cell);
      }
    }
    const prev = ctx.globalAlpha;
    for (let k = 0; k < this.paths.length; k++) {
      if (!this.used[k]) continue;
      const tone = Math.floor(k / (BATCH_LEVELS + 1));
      const level = k % (BATCH_LEVELS + 1);
      ctx.globalAlpha = prev * (level / BATCH_LEVELS);
      ctx.fillStyle = FOAM_TONES[tone];
      ctx.fill(this.paths[k]);
    }
    ctx.globalAlpha = prev;
    // missile smoke: puffs swelling as they age, the newest a hot glow
    for (const i of smoke) {
      const age = now - P.born[i];
      const q = age / P.life[i];
      const sx = view.ox + (P.x[i] + (P.vx[i] * age) / 1000) * z;
      const sy = view.oy + (P.y[i] + (P.vy[i] * age) / 1000) * z;
      const r = P.r0[i] + (P.r1[i] - P.r0[i]) * Math.sqrt(q);
      const v = Math.floor(P.seed[i] * 4);
      if (q < 0.06) drawBlob(ctx, 'fire', Math.max(1, r * 0.8), v, sx, sy, g, 0.9, 1 + q * 30);
      else drawBlob(ctx, 'spray', r, v, sx, sy, g, P.a0[i] * (1 - q) * (1 - q * 0.4));
    }
  }
}

export const detailedWakes: TrailArt = { createLayer: () => new DetailedTrails(true) };
export const detailedContrails: TrailArt = { createLayer: () => new DetailedTrails(false) };
