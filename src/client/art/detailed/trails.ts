// The detailed style's wakes and contrails (client only). Everything is laid on the map (tile coordinates) where the
// unit was and fades there, so a trail stays behind and breaks up as the unit moves on:
//   wakes      a moving ship drops foam at both sides of its stern that drifts outward at a varied fraction of its
//              speed, so the two arms open into the feathered V of a real (Kelvin) wake: each speck is thrown a little
//              sideways and has its own strength, only the newest foam at the stern is bright, the outer edge is
//              dimmer, and the arm frays and fades out within a ship length or two (never a long straight line); a
//              churned wash runs down the middle; a bow wave curls off both sides of the bow, bigger the faster the
//              ship goes. A submarine leaves only a thin wash and a small bow ripple.
//   contrails  vapour from each engine of a plane: a bright thread a cell wide right behind the engine that widens to
//              5 or 6 cells, drifts sideways and breaks up as it ages, no longer than a few plane lengths (a
//              circling plane never closes a ring); a missile leaves a billowing column of smoke puffs that swell
//              fast, drift and fray, warm grey turning pale, with the hot glow of the motor at its head.
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

/** Tones of foam and vapour, light to dim (0..2), and of small smoke specks, warm to pale (3..5). */
const FOAM_TONES = ['#eef3f4', '#d3dde1', '#aebdc4', '#8a857e', '#a8a39b', '#c6c1b9'];
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
  /** a second random 0..1 per particle, chosen by the layer (how far a speck drifts, which tone it takes) */
  readonly k2: Float32Array;
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
    this.k2 = new Float32Array(cap);
  }
  clear(): void {
    this.life.fill(0);
    this.head = 0;
  }
  put(x: number, y: number, vx: number, vy: number, born: number, life: number, r0: number, r1: number, a0: number, kind: number, k2 = 0): void {
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
    this.k2[i] = k2;
    const s = Math.sin(this.made * 12.9898 + 4.1) * 43758.5453;
    this.seed[i] = s - Math.floor(s);
    this.head = (i + 1) % this.cap;
    this.made++;
  }
}

/** A repeatable 0..1 for the n-th draw. */
function r01(n: number, salt: number): number {
  const v = Math.sin(n * 78.233 + salt * 12.9898) * 43758.5453;
  return v - Math.floor(v);
}

/** How fast a unit really moves over the map (tiles per ms, smoothed), from where it was seen last frame. */
interface Track {
  x: number;
  y: number;
  t: number;
  v: number;
  frame: number;
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
  private tracks = new Map<number, Track>();
  private frameNo = 0;
  private paths: Path2D[] = [];
  private used: boolean[] = [];

  constructor(private readonly wakes: boolean) {
    this.parts = new Particles(wakes ? 3500 : 5000);
  }

  clear(): void {
    this.parts.clear();
    this.emitters.clear();
    this.tracks.clear();
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
    if (this.frameNo % 120 === 0) {
      for (const [k, e] of this.emitters) if (this.frameNo - e.frame > 60) this.emitters.delete(k);
      for (const [k, e] of this.tracks) if (this.frameNo - e.frame > 60) this.tracks.delete(k);
    }
    const g = gridOf(view.scale, view.dpr);
    const z = Math.max(0.05, view.zoom);
    const cellT = g.k / z;
    // at mid zoom (an art pixel a screen px) specks are laid at least 2 px apart: hundreds of ships stay cheap
    const fine = g.res >= 1.5;
    const minT = fine ? 0 : 2 / z;
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
        // the foam lasts its time, but never longer than it takes the ship to sail about a ship length or two (more
        // with wakeLength), so a wake fades out behind its ship instead of running on as a long line
        const v = this.speedOf(u.id, u.tx, u.ty, now);
        const reachT = halfT * 2 * 1.3 * Math.sqrt(m.wakeLength);
        const cap = v > 1e-6 ? reachT / v : Infinity;
        const armLife = Math.min(1500 * m.wakeLength * (0.7 + 0.3 * sp), cap);
        const washLife = Math.min((sub ? 700 : 1100) * m.foamLife * (0.7 + 0.3 * sp), cap * 0.8);
        if (!sub) {
          for (const sd of [1, -1]) {
            this.emit(u.id * 4 + (sd > 0 ? 1 : 2), sx - s * side * sd, sy + c * side * sd, Math.max(cellT * 1.2, minT * 1.1), now, (px, py, born) => {
              // feathered: each speck thrown a little to either side and drifting out at its own pace, with its own
              // strength; the far-flung ones are the arm's dim outer edge
              const n = P.made;
              const k = r01(n, 1);
              const j = (r01(n, 2) - 0.5) * cellT * 1.6;
              P.put(px - s * j * sd, py + c * j * sd, -s * sd * out * (0.55 + 0.9 * k), c * sd * out * (0.55 + 0.9 * k), born, armLife * (0.75 + 0.25 * r01(n, 3)), 0.8, 1.8 + 0.6 * sp, 0.45 + 0.35 * r01(n, 4), ARM, k);
              // a second, slower fleck inside the arm: the foam band has some width
              if (fine && r01(n, 5) < 0.7) P.put(px, py, -s * sd * out * 0.45, c * sd * out * 0.45, born, armLife * 0.7, 0.6, 1.3 + 0.4 * sp, 0.4 + 0.2 * r01(n, 6), ARM, 0.3 * r01(n, 7));
            });
          }
        }
        this.emit(u.id * 4 + 3, sx, sy, Math.max(cellT * 1.3, minT * 1.2), now, (px, py, born) => {
          const j = (Math.sin(P.made * 7.31) * 0.5) * side;
          P.put(px - s * j, py + c * j, -s * j * 0.4, c * j * 0.4, born, washLife, sub ? 0.5 : 0.9, sub ? 1 : 1.8 + 0.6 * sp, sub ? 0.5 : 0.75, WASH, r01(P.made, 8));
        });
      } else {
        if (cat === 'missiles') {
          // a billowing column of puffs: laid a few cells apart, each swelling fast and drifting off to its own side
          const big = u.key === 'atomBomb';
          const back = halfT * 1.05;
          const life = (view.zoom < 3 ? 1700 : 1200) * m.missileTrailLife;
          const drift = (cellT * (big ? 5 : 3.5)) / (life / 1000);
          this.emit(u.id * 4, u.tx - c * back, u.ty - s * back, Math.max(cellT * (big ? 3.2 : 2.6), (fine ? 0 : 3) / z), now, (px, py, born) => {
            const k = r01(P.made, 11) - 0.5;
            P.put(px, py, -s * k * drift * 2, c * k * drift * 2 - 0.06 / Math.max(0.3, z * 0.05), born, life * (0.85 + 0.3 * r01(P.made, 12)), big ? 2.2 : 1.5, big ? 11 : 7, 0.85, SMOKE, r01(P.made, 13));
          });
          continue;
        }
        if (cat !== 'air' || !view.full) continue;
        // vapour from each engine (twin, four engines, or one), from just behind the wing
        const um = unitModel(u.key, 0);
        const src = um.props.length ? um.props : um.nozzles;
        const scaleT = view.scale / z;
        // a few plane lengths long whatever the plane's speed (a slow plane's trail lasts longer, a fast one's less),
        // never more, so a circling plane never closes a ring
        const v = this.speedOf(u.id, u.tx, u.ty, now);
        const reachT = halfT * 2 * 3.6 * m.contrailLife ** 0.2;
        const life = Math.min(6000 * m.contrailLife, Math.max(700, v > 1e-6 ? reachT / v : Infinity));
        const drift = (cellT * 5) / (Math.max(200, life) / 1000);
        src.forEach((p, i) => {
          const du = (um.props.length ? p.u - 4 : p.u) * scaleT;
          const dv = p.v * scaleT;
          this.emit(u.id * 8 + i, u.tx + c * du - s * dv, u.ty + s * du + c * dv, Math.max(cellT, minT), now, (px, py, born) => {
            const k = r01(P.made, 21) - 0.5;
            P.put(px, py, -s * k * drift * 2, c * k * drift * 2, born, life * (0.75 + 0.25 * r01(P.made, 22)), 1, 6, 0.9, TRAIL, r01(P.made, 23));
          });
        });
      }
    }
    this.used.length = 0;
    if (this.wakes && view.full) for (const u of units) if (u.moving && unitCategoryOf(u.key) === 'ships') this.bowWave(u, g, view);
    this.draw(ctx, view, g, z);
  }

  /** How fast unit `id` moves over the map now (tiles per ms, smoothed over a few frames). */
  private speedOf(id: number, x: number, y: number, now: number): number {
    const t = this.tracks.get(id);
    if (!t || this.frameNo - t.frame > 3 || now - t.t > 250 || now < t.t) {
      if (t) Object.assign(t, { x, y, t: now, frame: this.frameNo });
      else this.tracks.set(id, { x, y, t: now, v: 0, frame: this.frameNo });
      return t ? t.v : 0;
    }
    if (t.frame === this.frameNo) return t.v;
    const dt = now - t.t;
    if (dt > 0) {
      const v = Math.hypot(x - t.x, y - t.y) / dt;
      t.v = t.v > 0 ? t.v + (v - t.v) * 0.25 : v;
    }
    t.x = x;
    t.y = y;
    t.t = now;
    t.frame = this.frameNo;
    return t.v;
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
    const fine = Math.max(0.55, Math.min(1, g.res / 2));
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
        // swells fast, then frays: older puffs drop out here and there
        const rs = P.r0[i] + (P.r1[i] - P.r0[i]) * (1 - (1 - q) ** 2.4);
        if (q > 0.5 && P.seed[i] < (q - 0.5) * 0.9) continue;
        // small puffs (far and mid zoom) are plain specks in the batches; only big ones are drawn as shaded puffs
        if (rs * g.k >= 2.5 && smoke.length < 600) {
          smoke.push(i);
          continue;
        }
        const a = P.a0[i] * (1 - q) * (1 - q * 0.4);
        const path = this.batch(Math.max(1, Math.min(BATCH_LEVELS, Math.round(a * BATCH_LEVELS))), q < 0.3 ? 3 : q < 0.65 ? 4 : 5);
        const n = Math.max(1, Math.round(rs));
        const X = (Math.round((sx * g.dpr) / g.p - n / 2) * g.p) / g.dpr;
        const Y = (Math.round((sy * g.dpr) / g.p - n / 2) * g.p) / g.dpr;
        if (path) path.rect(X, Y, n * cell, n * cell);
        continue;
      }
      let r: number;
      let a: number;
      let tone: number;
      if (k === TRAIL) {
        // vapour: a bright thread a cell wide behind the engine, widening to 3 or 4 cells, breaking up as it ages
        if (q > 0.3 && P.seed[i] < (q - 0.3) * 1.4) continue;
        r = (P.r0[i] + (P.r1[i] - P.r0[i]) * Math.sqrt(q)) * fine;
        a = P.a0[i] * (1 - q) ** 1.2 * (0.7 + 0.3 * P.k2[i]);
        tone = q < 0.1 ? 0 : q < 0.45 ? 1 : 2;
      } else if (k === ARM) {
        // a wake arm: bright only right at the stern, the outer (far-flung) specks dimmer, fraying early and fading
        // to nothing
        if (q > 0.12 && P.seed[i] < (q - 0.12) * 1.35) continue;
        r = (P.r0[i] + (P.r1[i] - P.r0[i]) * Math.sqrt(q)) * fine;
        a = P.a0[i] * (1 - q) ** 1.6;
        tone = age < 160 ? 0 : P.k2[i] > 0.62 || q > 0.5 ? 2 : 1;
      } else {
        // foam breaks up as it ages: some specks drop out
        if (q > 0.45 && P.seed[i] < (q - 0.45) * 1.3) continue;
        // at mid zoom (about one art pixel per model unit) the foam stays finer, so a wake does not swamp its ship
        r = (P.r0[i] + (P.r1[i] - P.r0[i]) * Math.sqrt(q)) * fine;
        a = P.a0[i] * (1 - q);
        tone = q < 0.2 ? 0 : q < 0.55 ? 1 : 2;
      }
      const level = Math.max(1, Math.min(BATCH_LEVELS, Math.round(a * BATCH_LEVELS)));
      const path = this.batch(level, tone);
      const n = Math.max(1, Math.round(r));
      const X = (Math.round((sx * g.dpr) / g.p - n / 2) * g.p) / g.dpr;
      const Y = (Math.round((sy * g.dpr) / g.p - n / 2) * g.p) / g.dpr;
      if (path) {
        if (k === TRAIL && n >= 4) {
          // a wide puff of vapour is a loose cluster of three smaller ones, never a square block
          const m = Math.ceil(n * 0.55);
          const o1 = Math.floor(P.k2[i] * (n - m + 1));
          const o2 = Math.floor(P.seed[i] * (n - m + 1));
          path.rect(X + o1 * cell, Y, m * cell, m * cell);
          path.rect(X + (n - m) * cell, Y + o2 * cell, m * cell, m * cell);
          path.rect(X + o2 * cell, Y + (n - m) * cell, m * cell, m * cell);
        } else if (k === TRAIL && n === 3) {
          // a corner bitten off, a cell spilling out on one side
          const b = P.k2[i] > 0.5 ? 1 : 0;
          path.rect(X, Y + b * cell, n * cell, (n - 1) * cell);
          path.rect(X + (b ? cell : 0), Y + (b ? 0 : (n - 1) * cell), (n - 1) * cell, cell);
        } else path.rect(X, Y, n * cell, n * cell);
        // an older wash speck spreads into a ragged pair
        if (k === WASH && q > 0.3 && n >= 2 && g.res >= 1.5) path.rect(X + (P.seed[i] > 0.5 ? cell : -cell), Y + cell, cell, cell);
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
      const r = P.r0[i] + (P.r1[i] - P.r0[i]) * (1 - (1 - q) ** 2.4);
      const v = Math.floor(P.seed[i] * 4);
      // the motor's hot glow at the head, then warm grey smoke turning pale as it thins
      if (q < 0.05) drawBlob(ctx, 'fire', Math.max(1, P.r0[i] * 1.3 + q * 20), v, sx, sy, g, 0.95, 1 + q * 40);
      else drawBlob(ctx, q < 0.22 + 0.15 * P.k2[i] ? 'smoke' : 'vapour', r, v, sx, sy, g, P.a0[i] * (1 - q) * (1 - q * 0.3));
    }
  }
}

export const detailedWakes: TrailArt = { createLayer: () => new DetailedTrails(true) };
export const detailedContrails: TrailArt = { createLayer: () => new DetailedTrails(false) };
