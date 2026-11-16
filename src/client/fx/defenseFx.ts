// The Defense row on the map (client only, read-only like the rest of fx/: it reads the sim state and never writes
// to it, so the sim, its hash and multiplayer are untouched). Sim rules: sim/defense.ts.
//
//   flak bursts   black 3 x 3 px puffs with a one-frame orange core, scattered around every bomber, ground-attack
//                 plane, cargo plane or stealth bomber flying out inside a flak zone hostile to it, drifting and
//                 fading over PUFF_MS. More zones, more puffs.
//   smoke trail   a plane flak wore (Unit.flakWear) trails a thin grey line, longer the more it is worn; one that
//                 turned home flies home by itself (the sim turns it).
//   tank traps    small steel hedgehogs on every third trap tile (sim/defense.isTrapTile) in view from TRAP_ZOOM, and a
//                 dirt burst where a spearhead hits them (the sim's 'trapHit' effect).
//
// Zoom gating: nothing below FAR_FX_ZOOM; hedgehogs from TRAP_ZOOM. Reduced motion: a third of the puffs, no drift,
// no dirt fling. Effects off (Settings): nothing. Fog of war: only planes this client sees, trap tiles it sees (and
// its own). Caps: PUFF_CAP puffs and DIRT_CAP dirt bursts at once, PUFFS_PER_FRAME new puffs a frame.
// Client randomness only (Math.random): every client sees its own puffs.
import { TICKS_PER_SECOND } from '../../sim/config';
import { flakZonesAt, isTrapTile } from '../../sim/defense';
import { fortRadius } from '../../sim/buildings';
import { hasTech } from '../../sim/tech';
import { trenchLevel } from '../../sim/trenches';
import type { Effect, GameState, Unit } from '../../sim/types';
import { DIRT, drawFlakPuff, drawHedgehog } from '../art/detailed/flak';
import type { Camera } from '../camera';
import type { FogView } from '../fog/fogView';
import type { UnitPoses } from './pixelFx';
import { fxEnabled, prefersReducedMotion } from './settings';
import { flakBus } from './tankShotBus';

/** Puff life (ms), cap, and new puffs a frame at most. */
export const PUFF_MS = 800;
export const PUFF_CAP = 90;
const PUFFS_PER_FRAME = 8;
/** Puffs a second around one plane per flak zone holding it. */
const PUFF_RATE = 7;
/** Below this zoom no puffs or bursts; hedgehogs from TRAP_ZOOM. */
export const FAR_FX_ZOOM = 2;
export const TRAP_ZOOM = 4;
/** Dirt bursts at once, and how long one lasts (ms). */
const DIRT_CAP = 16;
const DIRT_MS = 550;
/** The trap tile list is recomputed at most this often (ms). */
const TRAP_REFRESH_MS = 700;

interface Puff {
  live: boolean;
  /** tile coordinates (float) and drift (tiles per second) */
  x: number;
  y: number;
  vx: number;
  vy: number;
  t0: number;
}
interface Dirt {
  live: boolean;
  x: number;
  y: number;
  t0: number;
  seed: number;
}

const PLANE_TYPES = new Set(['bomber', 'transportPlane', 'stealthBomber']);

export class DefenseFx {
  fog: FogView | null = null;
  private puffs: Puff[] = [];
  private dirt: Dirt[] = [];
  private seen = new WeakSet<Effect>();
  private lastMs = 0;
  private reducedPick: boolean | null = null;
  private trapKey = '';
  private trapAt = 0;
  private traps: number[] = [];
  /** puffs drawn last frame, hedgehogs drawn (tests, stats) */
  drawnPuffs = 0;
  drawnTraps = 0;

  constructor(private rand: () => number = Math.random) {
    for (let i = 0; i < PUFF_CAP; i++) this.puffs.push({ live: false, x: 0, y: 0, vx: 0, vy: 0, t0: 0 });
    for (let i = 0; i < DIRT_CAP; i++) this.dirt.push({ live: false, x: 0, y: 0, t0: 0, seed: 0 });
  }

  /** Reduced motion on or off (tests; the page follows the Settings pick live). */
  setReduced(on: boolean | null): void {
    this.reducedPick = on;
  }
  private get reduced(): boolean {
    return this.reducedPick ?? prefersReducedMotion();
  }
  private get active(): FogView | null {
    return this.fog?.active ? this.fog : null;
  }

  private shown(state: GameState, u: Unit): boolean {
    const f = this.active;
    return !f || f.unitShown(state, u);
  }

  /** New puffs around planes in hostile flak zones, new dirt bursts from 'trapHit' effects. Once per frame. */
  update(state: GameState, cam: Camera, nowMs: number): void {
    const dt = this.lastMs > 0 ? Math.min(100, Math.max(0, nowMs - this.lastMs)) : 16;
    this.lastMs = nowMs;
    if (!fxEnabled()) return;
    const w = state.map.width;
    for (const e of state.effects) {
      if (e.kind !== 'trapHit' || this.seen.has(e)) continue;
      this.seen.add(e);
      if ((state.tick - e.tick) / TICKS_PER_SECOND > 1) continue;
      const f = this.active;
      if (f && !f.visible(Math.floor(e.y) * w + Math.floor(e.x))) continue;
      if (cam.zoom < FAR_FX_ZOOM) continue;
      const d = this.dirt.find((q) => !q.live) ?? this.dirt.reduce((a, b) => (a.t0 < b.t0 ? a : b));
      d.live = true;
      d.x = e.x;
      d.y = e.y;
      d.t0 = nowMs;
      d.seed = Math.floor(this.rand() * 1e6);
    }
    if (cam.zoom < FAR_FX_ZOOM) return;
    const view = cam.visibleTiles(4);
    const rate = (PUFF_RATE * (this.reduced ? 1 / 3 : 1) * dt) / 1000;
    let made = 0;
    for (const u of state.units) {
      if (made >= PUFFS_PER_FRAME) break;
      if (u.hp <= 0 || u.state !== 0 || !PLANE_TYPES.has(u.type)) continue;
      if (u.x < view.x0 || u.y < view.y0 || u.x > view.x1 || u.y > view.y1) continue;
      const zones = flakZonesAt(state, u.owner, u.x, u.y).length;
      if (!zones || !this.shown(state, u)) continue;
      let n = rate * zones;
      while (n > 0 && made < PUFFS_PER_FRAME) {
        if (n < 1 && this.rand() > n) break;
        n -= 1;
        made++;
        this.spawn(u.x + 0.5, u.y + 0.5, nowMs);
        if (made === 1) flakBus.push({ state, x: u.x + 0.5, y: u.y + 0.5, volume: 0.22 }); // the soft anti-air shot (sound/battle.ts)
      }
    }
  }

  private spawn(x: number, y: number, nowMs: number): void {
    let p = this.puffs.find((q) => !q.live);
    if (!p) p = this.puffs.reduce((a, b) => (a.t0 < b.t0 ? a : b));
    const a = this.rand() * Math.PI * 2;
    const r = 0.6 + this.rand() * 2.2; // tiles from the plane
    p.live = true;
    p.x = x + Math.cos(a) * r;
    p.y = y + Math.sin(a) * r;
    const still = this.reduced;
    p.vx = still ? 0 : (this.rand() - 0.5) * 0.8;
    p.vy = still ? 0 : -0.2 - this.rand() * 0.4; // smoke rises a little
    p.t0 = nowMs;
  }

  /** Smoke trails of worn planes (under the puffs), the puffs and the dirt bursts. After the units are drawn. */
  drawAir(ctx: CanvasRenderingContext2D, state: GameState, cam: Camera, nowMs: number, units: UnitPoses, dpr: number): void {
    this.drawnPuffs = 0;
    if (!fxEnabled() || cam.zoom < FAR_FX_ZOOM) {
      for (const p of this.puffs) p.live = false;
      return;
    }
    const w = state.map.width;
    // smoke trails
    ctx.save();
    ctx.lineCap = 'round';
    for (const u of state.units) {
      const wear = u.flakWear ?? 0;
      if (u.hp <= 0 || wear < 0.15 || !PLANE_TYPES.has(u.type) || !this.shown(state, u)) continue;
      const at = units.screenOf(u.id) ?? cam.tileToScreen(u.x + 0.5, u.y + 0.5);
      if (at.x < -60 || at.y < -60 || at.x > cam.viewW + 60 || at.y > cam.viewH + 60) continue;
      const tx = u.target % w;
      const ty = (u.target / w) | 0;
      let dx = tx - u.x;
      let dy = ty - u.y;
      const d = Math.sqrt(dx * dx + dy * dy) || 1;
      dx /= d;
      dy /= d;
      const len = 6 + wear * 22;
      const g = ctx.createLinearGradient(at.x, at.y, at.x - dx * len, at.y - dy * len);
      g.addColorStop(0, `rgba(70,72,74,${0.75})`);
      g.addColorStop(1, 'rgba(70,72,74,0)');
      ctx.strokeStyle = g;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(at.x - dx * 3, at.y - dy * 3);
      ctx.lineTo(at.x - dx * len, at.y - dy * len);
      ctx.stroke();
    }
    ctx.restore();
    // puffs
    const k = cam.zoom >= 6 ? 1.5 : 1;
    for (const p of this.puffs) {
      if (!p.live) continue;
      const age = nowMs - p.t0;
      if (age >= PUFF_MS || age < 0) {
        p.live = false;
        continue;
      }
      const s = cam.tileToScreen(p.x + (p.vx * age) / 1000, p.y + (p.vy * age) / 1000);
      if (s.x < -8 || s.y < -8 || s.x > cam.viewW + 8 || s.y > cam.viewH + 8) continue;
      const f = 1 - age / PUFF_MS;
      drawFlakPuff(ctx, s.x, s.y, k, f * f, age < 60, dpr);
      this.drawnPuffs++;
    }
    // dirt bursts
    for (const d of this.dirt) {
      if (!d.live) continue;
      const age = nowMs - d.t0;
      if (age >= DIRT_MS || age < 0) {
        d.live = false;
        continue;
      }
      const s = cam.tileToScreen(d.x, d.y);
      const t = age / DIRT_MS;
      const fly = this.reduced ? 0.3 : 1;
      let seed = d.seed;
      const rnd = (): number => {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        return seed / 0x7fffffff;
      };
      ctx.globalAlpha = 1 - t;
      for (let i = 0; i < 9; i++) {
        const a = -Math.PI * (0.15 + rnd() * 0.7);
        const v = (4 + rnd() * 8) * fly * Math.max(1, cam.zoom / 4);
        const px = s.x + Math.cos(a) * v * t * 2;
        const py = s.y + Math.sin(a) * v * t * 2 + 10 * t * t * fly;
        ctx.fillStyle = DIRT[i % DIRT.length];
        const sz = i % 3 === 0 ? 2 : 1;
        ctx.fillRect(Math.round(px * dpr) / dpr, Math.round(py * dpr) / dpr, sz, sz);
      }
      ctx.globalAlpha = 1;
    }
  }

  /** The trap tiles of the nations in view (every third one gets a hedgehog), recomputed now and then. */
  private trapTiles(state: GameState, cam: Camera, nowMs: number): number[] {
    const v = cam.visibleTiles(2);
    const key = `${state.buildingsVersion}|${v.x0},${v.y0},${v.x1},${v.y1}`;
    if (key === this.trapKey && nowMs - this.trapAt < TRAP_REFRESH_MS) return this.traps;
    this.trapKey = key;
    this.trapAt = nowMs;
    const out: number[] = [];
    const w = state.map.width;
    const seen = new Set<number>();
    for (const b of state.buildings.values()) {
      if (b.type !== 'fort' || b.buildLeft > 0 || b.disabledUntil > state.tick) continue;
      const p = state.players[b.owner];
      if (!p || !hasTech(p, 'tankTraps')) continue;
      const r = fortRadius(state, b);
      const bx = b.tile % w;
      const by = (b.tile / w) | 0;
      const x0 = Math.max(v.x0, Math.floor(bx - r));
      const x1 = Math.min(v.x1 - 1, Math.ceil(bx + r));
      const y0 = Math.max(v.y0, Math.floor(by - r));
      const y1 = Math.min(v.y1 - 1, Math.ceil(by + r));
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          if ((x + 2 * y) % 3 !== 0) continue;
          const t = y * w + x;
          if (seen.has(t) || state.map.owner[t] !== b.owner || trenchLevel(state, t) < 1) continue;
          if ((x - bx) * (x - bx) + (y - by) * (y - by) > r * r) continue;
          seen.add(t);
          if (isTrapTile(state, t, b.owner)) out.push(t);
        }
      }
    }
    this.traps = out;
    return out;
  }

  /** Steel hedgehogs along the trap bands (from TRAP_ZOOM). Before the units. */
  drawGround(ctx: CanvasRenderingContext2D, state: GameState, cam: Camera, nowMs: number, me: number, dpr: number): void {
    this.drawnTraps = 0;
    if (cam.zoom < TRAP_ZOOM) return;
    const tiles = this.trapTiles(state, cam, nowMs);
    if (!tiles.length) return;
    const w = state.map.width;
    const f = this.active;
    const k = cam.zoom >= 9 ? 2 : cam.zoom >= 6 ? 1.5 : 1;
    for (const t of tiles) {
      if (f && state.map.owner[t] !== me && !f.visible(t)) continue;
      const s = cam.tileToScreen((t % w) + 0.5, ((t / w) | 0) + 0.5);
      drawHedgehog(ctx, s.x, s.y, k, dpr);
      this.drawnTraps++;
    }
  }
}
