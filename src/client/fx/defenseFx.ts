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
//   batteries     a coastal battery shot (the sim's 'battery' effect): a muzzle flash at the gun, a shell on a high arc,
//                 then a white splash with an orange hit spark on the ship.
//   radar         a green ring opening where a tracking radar locks onto a stealth bomber ('radarLock'), and green
//                 lock brackets on every spotted stealth bomber this client sees (Unit.radarSeen).
//
// Zoom gating: nothing below FAR_FX_ZOOM; hedgehogs from TRAP_ZOOM. Reduced motion: a third of the puffs, no drift,
// no dirt fling. Effects off (Settings): nothing. Fog of war: only planes this client sees, trap tiles it sees (and
// its own). Caps: PUFF_CAP puffs and DIRT_CAP dirt bursts at once, PUFFS_PER_FRAME new puffs a frame.
// Client randomness only (Math.random): every client sees its own puffs.
import { TICKS_PER_SECOND } from '../../sim/config';
import { flakZonesAt, isTrapTile, trapReach } from '../../sim/defense';
import { hasTech } from '../../sim/tech';
import { unitVisibleTo } from '../../sim/techtree';
import { trenchLevel } from '../../sim/trenches';
import type { Effect, GameState, Unit } from '../../sim/types';
import { DIRT, drawFlakPuff, drawHedgehog } from '../art/detailed/flak';
import type { Camera } from '../camera';
import type { FogView } from '../fog/fogView';
import type { UnitPoses } from './pixelFx';
import { fxEnabled, prefersReducedMotion } from './settings';
import { flakBus } from './tankShotBus';
import type { GunAim } from './gunAim';
import { ART_ZOOM } from '../render/buildingArt';

/** Puff life (ms), cap, and new puffs a frame at most. */
export const PUFF_MS = 800;
export const PUFF_CAP = 90;
const PUFFS_PER_FRAME = 10;
/** Puffs a second around one plane per flak zone holding it. */
const PUFF_RATE = 18;
/** Below this zoom no puffs or bursts; hedgehogs from TRAP_ZOOM. */
export const FAR_FX_ZOOM = 2;
export const TRAP_ZOOM = 4;
/** Dirt bursts at once, and how long one lasts (ms). */
const DIRT_CAP = 16;
const DIRT_MS = 700;
/** Battery shells at once; flight and splash time (ms). */
const SHELL_CAP = 24;
export const SHELL_FLIGHT_MS = 520;
const SHELL_SPLASH_MS = 420;
/** Radar lock rings at once, and their life (ms). */
const RING_CAP = 8;
const RING_MS = 900;
/** The green of Tracking Radar (sweep, rings, lock brackets). */
export const RADAR_GREEN = '#5dff8a';
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

interface Shell {
  live: boolean;
  x: number;
  y: number;
  x2: number;
  y2: number;
  t0: number;
  /** a warship hit (else a transport: a smaller spark) */
  big: boolean;
  /** the battery's tile (the turning gun's muzzle is looked up by it) */
  tile: number;
}
interface Ring {
  live: boolean;
  x: number;
  y: number;
  t0: number;
}

const PLANE_TYPES = new Set(['bomber', 'transportPlane', 'stealthBomber']);

export class DefenseFx {
  fog: FogView | null = null;
  /** the turning guns of flak pits and coastal batteries (fx/gunAim.ts): told of every plane under fire and every battery shot; null = none */
  guns: GunAim | null = null;
  private puffs: Puff[] = [];
  private dirt: Dirt[] = [];
  private shells: Shell[] = [];
  private rings: Ring[] = [];
  private seen = new WeakSet<Effect>();
  private lastMs = 0;
  private reducedPick: boolean | null = null;
  private trapKey = '';
  private trapAt = 0;
  private traps: number[] = [];
  /** puffs drawn last frame, hedgehogs drawn (tests, stats) */
  drawnPuffs = 0;
  drawnTraps = 0;
  drawnDirt = 0;
  drawnShells = 0;
  drawnLocks = 0;

  constructor(private rand: () => number = Math.random) {
    for (let i = 0; i < PUFF_CAP; i++) this.puffs.push({ live: false, x: 0, y: 0, vx: 0, vy: 0, t0: 0 });
    for (let i = 0; i < DIRT_CAP; i++) this.dirt.push({ live: false, x: 0, y: 0, t0: 0, seed: 0 });
    for (let i = 0; i < SHELL_CAP; i++) this.shells.push({ live: false, x: 0, y: 0, x2: 0, y2: 0, t0: 0, big: false, tile: -1 });
    for (let i = 0; i < RING_CAP; i++) this.rings.push({ live: false, x: 0, y: 0, t0: 0 });
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
      if ((e.kind !== 'trapHit' && e.kind !== 'battery' && e.kind !== 'radarLock') || this.seen.has(e)) continue;
      this.seen.add(e);
      if ((state.tick - e.tick) / TICKS_PER_SECOND > 1) continue;
      const f = this.active;
      if (cam.zoom < FAR_FX_ZOOM) continue;
      if (e.kind === 'battery') {
        // seen when the gun or the ship is in view
        if (f && !f.visible(Math.floor(e.y) * w + Math.floor(e.x)) && !f.visible(Math.floor(e.y2 ?? e.y) * w + Math.floor(e.x2 ?? e.x))) continue;
        const sh = this.shells.find((q) => !q.live) ?? this.shells.reduce((a, b) => (a.t0 < b.t0 ? a : b));
        sh.live = true;
        sh.x = e.x;
        sh.y = e.y;
        sh.x2 = e.x2 ?? e.x;
        sh.y2 = e.y2 ?? e.y;
        sh.t0 = nowMs;
        sh.big = e.radius >= 1;
        sh.tile = Math.floor(e.y) * w + Math.floor(e.x);
        // from the art zoom on the gun on the building turns to the ship and fires (its flash replaces the plain one below)
        if (this.guns && cam.zoom >= ART_ZOOM) this.guns.fireCoastal(sh.tile, sh.x2, sh.y2, nowMs);
        continue;
      }
      if (f && !f.visible(Math.floor(e.y) * w + Math.floor(e.x))) continue;
      if (e.kind === 'radarLock') {
        const r = this.rings.find((q) => !q.live) ?? this.rings.reduce((a, b) => (a.t0 < b.t0 ? a : b));
        r.live = true;
        r.x = e.x;
        r.y = e.y;
        r.t0 = nowMs;
        continue;
      }
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
      const zs = flakZonesAt(state, u.owner, u.x, u.y);
      const zones = zs.length;
      if (!zones || !this.shown(state, u)) continue;
      // every pit whose zone holds the plane trains on it (the nearest plane to the pit wins)
      const aimed = !!this.guns && cam.zoom >= ART_ZOOM;
      if (aimed) for (const z of zs) this.guns!.aimAt(z.tile, 'flak', z.x + 0.5, z.y + 0.5, u.x + 0.5, u.y + 0.5, nowMs);
      let fired = false;
      let n = rate * zones;
      while (n > 0 && made < PUFFS_PER_FRAME) {
        if (n < 1 && this.rand() > n) break;
        n -= 1;
        made++;
        this.spawn(u.x + 0.5, u.y + 0.5, nowMs, cam.zoom);
        if (aimed && !fired) {
          fired = true;
          for (const z of zs) this.guns!.flakFire(z.tile, nowMs); // the pits flash with the bursts they throw
        }
        if (made === 1) flakBus.push({ state, x: u.x + 0.5, y: u.y + 0.5, volume: 0.22 }); // the soft anti-air shot (sound/battle.ts)
      }
    }
  }

  private spawn(x: number, y: number, nowMs: number, zoom: number): void {
    let p = this.puffs.find((q) => !q.live);
    if (!p) p = this.puffs.reduce((a, b) => (a.t0 < b.t0 ? a : b));
    const a = this.rand() * Math.PI * 2;
    const r = (12 + this.rand() * 26) / Math.max(1, zoom); // 12 to 38 px from the plane: around its sprite, not under it
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
    this.drawnDirt = 0;
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
    const k = cam.zoom >= 4 ? 1.5 : 1;
    for (const p of this.puffs) {
      if (!p.live) continue;
      const age = nowMs - p.t0;
      if (age >= PUFF_MS || age < 0) {
        p.live = false;
        continue;
      }
      const s = cam.tileToScreen(p.x + (p.vx * age) / 1000, p.y + (p.vy * age) / 1000);
      if (s.x < -8 || s.y < -8 || s.x > cam.viewW + 8 || s.y > cam.viewH + 8) continue;
      const t = age / PUFF_MS;
      const f = t < 0.35 ? 1 : 1 - (t - 0.35) / 0.65; // dense at first, then it thins out
      drawFlakPuff(ctx, s.x, s.y, k, f, age < 60, dpr);
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
      this.drawnDirt++;
      const fly = this.reduced ? 0.3 : 1;
      let seed = d.seed;
      const rnd = (): number => {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        return seed / 0x7fffffff;
      };
      // a dust cloud spreading low over the spot, then clods of earth flung up and falling back
      const zk = Math.max(1, cam.zoom / 4);
      ctx.globalAlpha = 0.7 * (1 - t);
      ctx.fillStyle = DIRT[3];
      ctx.beginPath();
      ctx.ellipse(s.x, s.y + 2, (4 + 12 * t) * zk, (2.5 + 6 * t) * zk, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1 - t * t;
      for (let i = 0; i < 14; i++) {
        const a = -Math.PI * (0.1 + rnd() * 0.8);
        const v = (6 + rnd() * 12) * fly * zk;
        const px = s.x + Math.cos(a) * v * t * 2;
        const py = s.y + Math.sin(a) * v * t * 2 + 16 * t * t * fly * zk;
        ctx.fillStyle = DIRT[i % DIRT.length];
        const sz = i % 3 === 0 ? 3 : 2;
        ctx.fillRect(Math.round(px * dpr) / dpr, Math.round(py * dpr) / dpr, sz, sz);
      }
      ctx.globalAlpha = 1;
    }
    this.drawDefense2(ctx, state, cam, nowMs, units, dpr);
  }

  /**
   * Coastal battery shells (muzzle flash, a high arc, splash and hit spark), radar lock rings and the green lock
   * brackets on spotted stealth bombers. After the units (drawAir calls it).
   */
  private drawDefense2(ctx: CanvasRenderingContext2D, state: GameState, cam: Camera, nowMs: number, units: UnitPoses, dpr: number): void {
    this.drawnShells = 0;
    this.drawnLocks = 0;
    const px = (v: number): number => Math.round(v * dpr) / dpr;
    const zk = Math.max(1, Math.min(3, cam.zoom / 4));
    for (const sh of this.shells) {
      if (!sh.live) continue;
      const age = nowMs - sh.t0;
      if (age < 0 || age >= SHELL_FLIGHT_MS + SHELL_SPLASH_MS) {
        sh.live = false;
        continue;
      }
      // a turning gun's shell leaves its muzzle (the flash is the tank gun's, fx/gunAim.ts); below the art zoom there is no gun to show
      const gun = cam.zoom >= ART_ZOOM && this.guns ? this.guns.muzzleOf(sh.tile, nowMs) : null;
      const a = cam.tileToScreen(gun ? gun.x : sh.x, gun ? gun.y : sh.y);
      const b = cam.tileToScreen(sh.x2, sh.y2);
      const dist = Math.hypot(b.x - a.x, b.y - a.y);
      if (Math.max(a.x, b.x) < -40 || Math.min(a.x, b.x) > cam.viewW + 40 || Math.max(a.y, b.y) < -80 || Math.min(a.y, b.y) > cam.viewH + 40) continue;
      this.drawnShells++;
      const lift = Math.min(160, 12 + dist * 0.3); // the arc's height (px)
      // the lob goes up the screen, and bows a little sideways so the arc reads on a north-south shot too
      const nx = dist > 0 ? -(b.y - a.y) / dist : 0;
      const ny = dist > 0 ? (b.x - a.x) / dist : 0;
      const side = (nx >= 0 ? 1 : -1) * lift * 0.35;
      const at = (t: number): { x: number; y: number } => {
        const h = 4 * t * (1 - t);
        return { x: a.x + (b.x - a.x) * t + nx * side * h, y: a.y + (b.y - a.y) * t - lift * h + ny * side * h };
      };
      // muzzle flash: a bright core and a short orange burst toward the ship
      if (age < 110 && !gun && cam.zoom < ART_ZOOM) {
        const f = 1 - age / 110;
        ctx.globalAlpha = f;
        ctx.fillStyle = '#ffe9a6';
        ctx.beginPath();
        ctx.arc(a.x, a.y - 1, (2 + 2.5 * f) * zk, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#ff9a3c';
        const ux = dist > 0 ? (b.x - a.x) / dist : 1;
        const uy = dist > 0 ? (b.y - a.y) / dist : 0;
        ctx.beginPath();
        ctx.arc(a.x + ux * 4 * zk, a.y - 1 + uy * 4 * zk - 2 * zk, 2 * f * zk, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = 'rgba(90,90,90,0.6)';
        ctx.fillRect(px(a.x - 3 * zk), px(a.y - 6 * zk - age * 0.03), 3 * zk, 2 * zk);
        ctx.globalAlpha = 1;
      }
      if (age < SHELL_FLIGHT_MS) {
        const t = age / SHELL_FLIGHT_MS;
        // a fading trail along the arc, then the shell
        for (let k = 1; k <= 8; k++) {
          const q = at(Math.max(0, t - k * 0.03));
          ctx.globalAlpha = 0.7 * (1 - k / 9);
          ctx.fillStyle = '#e6dfcf';
          ctx.fillRect(px(q.x - 1), px(q.y - 1), 2, 2);
        }
        ctx.globalAlpha = 1;
        const p = at(t);
        const r = 2 * Math.min(1.5, zk);
        ctx.fillStyle = 'rgba(255,190,90,0.35)';
        ctx.beginPath();
        ctx.arc(p.x, p.y, r + 2.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#1e1e22';
        ctx.fillRect(px(p.x - r), px(p.y - r), 2 * r, 2 * r);
        ctx.fillStyle = '#ffd27a';
        ctx.fillRect(px(p.x - 1), px(p.y - 1), 2, 2);
        continue;
      }
      // splash: a white column and a ring on the water, the orange hit spark on the ship
      const t = (age - SHELL_FLIGHT_MS) / SHELL_SPLASH_MS;
      const s = (sh.big ? 1 : 0.7) * zk;
      ctx.globalAlpha = 1 - t;
      ctx.strokeStyle = 'rgba(235,245,255,0.95)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.ellipse(b.x, b.y + 1, (3 + 9 * t) * s, (1.5 + 4 * t) * s, 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = '#f2f8ff';
      const col = (10 * (1 - t) + 2) * s;
      ctx.fillRect(px(b.x - 1.5 * s), px(b.y - col), 3 * s, col);
      if (t < 0.45) {
        const g = 1 - t / 0.45;
        ctx.globalAlpha = g;
        ctx.fillStyle = '#ffb347';
        for (let k = 0; k < 6; k++) {
          const an = (k / 6) * Math.PI * 2 + 0.4;
          const r = (2 + 6 * (1 - g)) * s;
          ctx.fillRect(px(b.x + Math.cos(an) * r - 1), px(b.y - 2 * s + Math.sin(an) * r - 1), 2, 2);
        }
        ctx.fillStyle = '#fff3c2';
        ctx.fillRect(px(b.x - 1.5), px(b.y - 2 * s - 1.5), 3, 3);
      }
      ctx.globalAlpha = 1;
    }
    for (const r of this.rings) {
      if (!r.live) continue;
      const age = nowMs - r.t0;
      if (age < 0 || age >= RING_MS) {
        r.live = false;
        continue;
      }
      const t = age / RING_MS;
      const c = cam.tileToScreen(r.x, r.y);
      ctx.globalAlpha = 1 - t;
      ctx.strokeStyle = RADAR_GREEN;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(c.x, c.y, 8 + 40 * t, 0, Math.PI * 2);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
    // spotted stealth bombers: green lock brackets round the plane
    const me = state.humanId;
    for (const u of state.units) {
      if (u.type !== 'stealthBomber' || u.hp <= 0 || !u.radarSeen?.length || !this.shown(state, u)) continue;
      if (me > 0 && u.owner !== me && !unitVisibleTo(state, me, u)) continue;
      const c = units.screenOf(u.id) ?? cam.tileToScreen(u.x + 0.5, u.y + 0.5);
      if (c.x < -30 || c.y < -30 || c.x > cam.viewW + 30 || c.y > cam.viewH + 30) continue;
      this.drawnLocks++;
      const h = Math.max(9, Math.min(46, 6 + cam.zoom * 1.9));
      const l = h * 0.45;
      const pulse = this.reduced ? 1 : 0.75 + 0.25 * Math.sin(nowMs / 140);
      ctx.globalAlpha = pulse;
      ctx.strokeStyle = 'rgba(6,24,12,0.8)';
      ctx.lineWidth = 3.5;
      this.brackets(ctx, c.x, c.y, h, l);
      ctx.strokeStyle = RADAR_GREEN;
      ctx.lineWidth = 1.5;
      this.brackets(ctx, c.x, c.y, h, l);
      ctx.globalAlpha = 1;
    }
  }
  private brackets(ctx: CanvasRenderingContext2D, x: number, y: number, h: number, l: number): void {
    ctx.beginPath();
    for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const) {
      ctx.moveTo(x + sx * h, y + sy * (h - l));
      ctx.lineTo(x + sx * h, y + sy * h);
      ctx.lineTo(x + sx * (h - l), y + sy * h);
    }
    ctx.stroke();
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
      const r = trapReach(state, b);
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
          if (seen.has(t) || state.map.owner[t] !== b.owner) continue;
          // dug-in land (full strength): every third tile; undug trap land: every sixth (sparser hedgehogs)
          const dug = trenchLevel(state, t) >= 1;
          if (!dug && (x + 2 * y) % 6 !== 0) continue;
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
