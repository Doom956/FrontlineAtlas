// Pixel battle effects (client only): explosions, ship cannon fire, shells, flak and scorch craters, in the same
// chunky pixel style and top-left light as the unit sprites (render/pixelSprites.ts). Read-only like the rest of fx/:
// each frame it reads the effects the sim already records (state.effects: 'explosion', 'nuke', 'barrage', 'shot') and
// the units it sees, and never writes to the state, so the sim, its hash and multiplayer are untouched.
//
// Explosions are short pixel flipbooks with one 5-step ramp (white, yellow, orange, red, smoke grey) for every size:
// a near-white flash, a yellow to orange fireball with a hot rim, a thin bright ring running past it, the fireball
// darkening to red, then a grey smoke puff, with a few dark debris specks flung out. Sizes by event: a shell (barrage
// shells, a ship's shell on land), a bomb (a stick of them over a bomber's or air strike's disc), a missile (big, with
// a ring and a short smoke column), the atom bomb (a flash, a huge fireball, two rings and a mushroom cloud that rises
// and fades; fx/battleFx.ts adds its wave rings and the camera shake). Reduced motion: a still burst, no flipbook.
//
// Ship cannon fire: when a warship fires (a 'shot' starting at a warship), its turrets flash in a ripple (one for a
// destroyer, two for a plain warship, three for a battleship), shells arc to the target and land as a white splash
// on water or a small explosion and a crater on land. Submarines send a torpedo wake; carriers, SAM sites and
// airfields send tracer bursts that end in a flak puff.
//
// Craters: every blast on land leaves a scorch mark (a dark pit, a lighter rim, debris pixels) that fades out over
// about a minute of game time (atom bombs bigger and longer). A capped ring buffer (CRATER_CAP); drawn under units;
// hidden far out, a plain dark spot at the middle zooms. Every pool is fixed size, nothing is allocated per effect.
import type { Effect, GameState, Unit, UnitVariant } from '../../sim/types';
import type { FogView } from '../fog/fogView';
import { fxEnabled, prefersReducedMotion } from './settings';

export const CRATER_CAP = 200;
/** Game ticks between a blast and its crater showing (the fireball hides the moment it appears). */
const CRATER_DELAY = 1.5;
const BLAST_CAP = 72;
const SHELL_CAP = 48;
const FLASH_CAP = 48;
/** A muzzle flash: flash, fire, smoke (ms). */
const FLASH_MS = 300;
/** Things older than this (ticks) are history, not news (as fx/battleFx.ts). */
const FRESH_TICKS = 15;
const JUMP_TICKS = 30;

/** The explosion ramp, light to dark. */
const WHITE = '#fffbe8';
const YELLOW = '#ffd84a';
const ORANGE = '#ff8a1f';
const RED = '#d4361c';
const EMBER = '#7a2412';
const SMOKE_DARK = '#3d3b3a';
const SMOKE = '#6e6b68';
const SMOKE_LIGHT = '#a19d98';
const DEBRIS = '#241e1a';
const FOAM = '#eef6fa';
const FOAM_DIM = '#b9d2df';

export type BlastKind = 'shell' | 'bomb' | 'hit' | 'air' | 'missile' | 'atom' | 'splash' | 'flak';

interface BlastSpec {
  /** fireball radius in art px at pixel size 1 */
  r: number;
  dur: number;
  debris: number;
  ring: boolean;
  /** smoke puffs at the end */
  smoke: number;
}
const SPEC: Record<BlastKind, BlastSpec> = {
  shell: { r: 5, dur: 460, debris: 3, ring: true, smoke: 2 },
  bomb: { r: 6, dur: 560, debris: 4, ring: true, smoke: 3 },
  hit: { r: 6, dur: 560, debris: 5, ring: true, smoke: 3 },
  air: { r: 4, dur: 480, debris: 5, ring: false, smoke: 2 },
  missile: { r: 10, dur: 760, debris: 7, ring: true, smoke: 4 },
  atom: { r: 26, dur: 2800, debris: 10, ring: true, smoke: 6 },
  splash: { r: 4, dur: 560, debris: 0, ring: true, smoke: 0 },
  flak: { r: 3, dur: 420, debris: 2, ring: false, smoke: 2 },
};

interface Blast {
  kind: BlastKind;
  /** tile coordinates */
  x: number;
  y: number;
  /** blast radius in tiles (missiles, atom bombs: the fireball grows with it) */
  rt: number;
  t0: number;
  seed: number;
  live: boolean;
}
interface Shell {
  kind: 'cannon' | 'tracer' | 'torpedo';
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  t0: number;
  dur: number;
  /** lands on water (a splash) or land (a blast and a crater) */
  water: boolean;
  live: boolean;
  landed: boolean;
}
interface Flash {
  /** the firing ship (its pose is read from the unit layer each frame); -1 = a fixed point */
  unit: number;
  /** turret position along / across the hull, art px */
  u: number;
  v: number;
  /** fixed point (tile) when unit is -1, and the target (tile) for the direction */
  x: number;
  y: number;
  tx: number;
  ty: number;
  t0: number;
  live: boolean;
}
interface Crater {
  x: number;
  y: number;
  /** radius in tiles */
  r: number;
  /** game time (ticks) it was made and how long it lasts */
  born: number;
  life: number;
  seed: number;
}

/** What the effects need from the unit layer: where a ship was drawn and which way it faces. */
export interface UnitPoses {
  screenOf(id: number): { x: number; y: number } | null;
  headingOf(id: number): number | null;
}

export interface FxCam {
  zoom: number;
  x: number;
  y: number;
  viewW: number;
  viewH: number;
}

/** Turret centres (art px along / across the hull) of the ships that fire, by variant. */
const TURRETS: Record<string, readonly (readonly [number, number])[]> = {
  warship: [
    [7, 0],
    [-10, 0],
  ],
  destroyer: [
    [6.4, 0],
    [6.4, 0],
  ],
  battleship: [
    [11.8, 0],
    [7.2, 0],
    [-12.4, 0],
  ],
};

/** Screen px per art pixel at zoom z (the unit sprites' scale, render/units.ts spriteScale). */
export function pixelSize(z: number): number {
  return z < 11 ? 1 : z < 22 ? 2 : z < 32 ? 3 : 4;
}

function fract(v: number): number {
  return v - Math.floor(v);
}
/** A repeatable 0..1 value for (seed, i). */
function rnd(seed: number, i: number): number {
  return fract(Math.sin(seed * 91.17 + i * 12.9898) * 43758.5453);
}

export class PixelFx {
  /** ms spent in update + draws last frame (renderer stats) */
  ms = 0;
  /** effects started since the game began (tests) */
  spawned = 0;
  fog: FogView | null = null;

  readonly blasts: Blast[] = [];
  readonly shells: Shell[] = [];
  readonly flashes: Flash[] = [];
  readonly craters: Crater[] = [];
  private craterNext = 0;

  private state: GameState | null = null;
  private lastTick = -1;
  private seen = new WeakSet<Effect>();
  /** missiles in flight last frame: their target tiles (a blast there is a missile, not a bomb) */
  private missileTargets = new Map<number, 'rocket' | 'atomBomb'>();
  private missileNext = new Map<number, 'rocket' | 'atomBomb'>();
  /** ships and planes alive last frame (a small blast where one died says what it was) */
  private prev: Unit[] = [];
  private reduced = prefersReducedMotion();
  private wasOn = true;

  constructor() {
    for (let i = 0; i < BLAST_CAP; i++) this.blasts.push({ kind: 'shell', x: 0, y: 0, rt: 0, t0: 0, seed: 0, live: false });
    for (let i = 0; i < SHELL_CAP; i++) this.shells.push({ kind: 'cannon', x0: 0, y0: 0, x1: 0, y1: 0, t0: 0, dur: 1, water: false, live: false, landed: false });
    for (let i = 0; i < FLASH_CAP; i++) this.flashes.push({ unit: -1, u: 0, v: 0, x: 0, y: 0, tx: 0, ty: 0, t0: 0, live: false });
  }

  // ------------------------------------------------------------------------------------------- reading the game

  /** Reads what is new in `state` and starts its effects. Call once per frame before drawing. */
  update(state: GameState, nowMs: number): void {
    const t0 = performance.now();
    try {
      if (!fxEnabled()) {
        if (this.wasOn) this.clear();
        this.wasOn = false;
        return;
      }
      this.wasOn = true;
      if (state !== this.state || this.lastTick < 0 || state.tick - this.lastTick > JUMP_TICKS || state.tick < this.lastTick) {
        this.history(state);
        return;
      }
      this.lastTick = state.tick;
      const fx = state.effects;
      let k = fx.length - 1;
      while (k >= 0 && !this.seen.has(fx[k])) k--;
      for (let i = k + 1; i < fx.length; i++) {
        const e = fx[i];
        this.seen.add(e);
        if (e.tick < state.tick - FRESH_TICKS) continue;
        if (!this.inSight(state, e.x, e.y)) continue;
        this.ingest(state, e, nowMs);
      }
      this.snapshot(state);
      this.land(state, nowMs);
    } catch {
      /* never break the frame */
    } finally {
      this.ms = performance.now() - t0;
    }
  }

  private clear(): void {
    this.state = null;
    this.lastTick = -1;
    for (const b of this.blasts) b.live = false;
    for (const s of this.shells) s.live = false;
    for (const f of this.flashes) f.live = false;
    this.craters.length = 0;
    this.craterNext = 0;
  }

  private history(state: GameState): void {
    if (state !== this.state) this.clear();
    this.state = state;
    this.lastTick = state.tick;
    this.seen = new WeakSet();
    for (const e of state.effects) this.seen.add(e);
    this.snapshot(state);
  }

  private inSight(state: GameState, x: number, y: number): boolean {
    const fog = this.fog?.active ? this.fog : null;
    if (!fog) return true;
    const w = state.map.width;
    const h = state.map.height;
    return fog.visible(Math.max(0, Math.min(h - 1, Math.floor(y))) * w + Math.max(0, Math.min(w - 1, Math.floor(x))));
  }

  private snapshot(state: GameState): void {
    const p = this.prev;
    p.length = 0;
    const next = this.missileNext;
    next.clear();
    for (const u of state.units) {
      if (u.type === 'rocket' || u.type === 'atomBomb') next.set(u.target, u.type);
      else if (u.type !== 'tankDivision') p.push(u);
    }
    this.missileNext = this.missileTargets;
    this.missileTargets = next;
  }

  private isWater(state: GameState, x: number, y: number): boolean {
    const w = state.map.width;
    const tx = Math.floor(x);
    const ty = Math.floor(y);
    if (tx < 0 || ty < 0 || tx >= w || ty >= state.map.height) return true;
    return state.map.terrain[ty * w + tx] <= 1;
  }

  /** The unit that died at (x, y) since last frame, or null. */
  private lostAt(x: number, y: number): Unit | null {
    let best: Unit | null = null;
    let bd = 2.25;
    for (const u of this.prev) {
      if (u.hp > 0) continue;
      const d = (u.x + 0.5 - x) ** 2 + (u.y + 0.5 - y) ** 2;
      if (d < bd) {
        bd = d;
        best = u;
      }
    }
    return best;
  }

  private ingest(state: GameState, e: Effect, now: number): void {
    const w = state.map.width;
    const tick = state.tick;
    switch (e.kind) {
      case 'nuke':
        this.blast('atom', e.x, e.y, e.radius, now);
        this.crater(e.x, e.y, Math.max(4, e.radius * 0.32), tick, 1800);
        return;
      case 'barrage': {
        // shells land over the disc in a quick ripple, each with its own small crater
        const n = 7;
        for (let i = 0; i < n; i++) {
          const a = rnd(e.x + e.y, i) * Math.PI * 2;
          const d = Math.sqrt(rnd(e.y, i + 7)) * e.radius * 0.85;
          const x = e.x + Math.cos(a) * d;
          const y = e.y + Math.sin(a) * d;
          const at = now + i * 70 + rnd(e.x, i) * 60;
          if (this.isWater(state, x, y)) this.blast('splash', x, y, 0, at);
          else {
            this.blast('shell', x, y, 0, at);
            this.crater(x, y, 0.45 + rnd(e.x, i + 3) * 0.25, tick + (at - now) / 100, 450);
          }
        }
        return;
      }
      case 'explosion': {
        const tile = Math.floor(e.y) * w + Math.floor(e.x);
        if (e.radius >= 4) {
          if (this.missileTargets.has(tile)) {
            this.blast('missile', e.x, e.y, e.radius, now);
            if (!this.isWater(state, e.x, e.y)) this.crater(e.x, e.y, Math.max(1.6, e.radius * 0.3), tick, 650);
            return;
          }
          // a bomber's or an air strike's run: a stick of bombs over the disc
          const n = 4;
          for (let i = 0; i < n; i++) {
            const a = rnd(e.x * 3 + e.y, i) * Math.PI * 2;
            const d = (0.15 + 0.55 * rnd(e.y + 1, i)) * e.radius;
            const x = e.x + Math.cos(a) * d;
            const y = e.y + Math.sin(a) * d;
            const at = now + i * 110;
            if (this.isWater(state, x, y)) this.blast('splash', x, y, 0, at);
            else {
              this.blast('bomb', x, y, 0, at);
              this.crater(x, y, 0.75 + rnd(e.x, i) * 0.35, tick + (at - now) / 100, 550);
            }
          }
          return;
        }
        const lost = this.lostAt(e.x, e.y);
        if (lost && (lost.type === 'bomber' || lost.type === 'fighter' || lost.type === 'transportPlane' || lost.type === 'reconPlane')) this.blast('air', e.x, e.y, 0, now);
        else if (this.isWater(state, e.x, e.y)) this.blast('hit', e.x, e.y, 0, now);
        else {
          this.blast('hit', e.x, e.y, 0, now);
          this.crater(e.x, e.y, 0.7, tick, 500);
        }
        return;
      }
      case 'shot':
        this.shot(state, e, now);
        return;
      default:
        return;
    }
  }

  /** A 'shot' effect: warship cannon fire (turret flashes and shells), a torpedo, or anti-air tracers and flak. */
  private shot(state: GameState, e: Effect, now: number): void {
    if (e.x2 === undefined || e.y2 === undefined) return;
    let ship: Unit | null = null;
    let bd = 1.2;
    for (const u of state.units) {
      if (u.type !== 'warship') continue;
      const d = Math.abs(u.x + 0.5 - e.x) + Math.abs(u.y + 0.5 - e.y);
      if (d < bd) {
        bd = d;
        ship = u;
      }
    }
    const water = this.isWater(state, e.x2, e.y2);
    const dist = Math.hypot(e.x2 - e.x, e.y2 - e.y);
    // aimed at a plane: tracers (SAM sites, airfields, carriers)
    let atPlane = false;
    for (const u of state.units) {
      if ((u.type === 'bomber' || u.type === 'transportPlane' || u.type === 'fighter' || u.type === 'reconPlane') && Math.abs(u.x + 0.5 - e.x2) + Math.abs(u.y + 0.5 - e.y2) < 1.5) {
        atPlane = true;
        break;
      }
    }
    if (atPlane || !ship || ship.variant === 'carrier') {
      this.addShell('tracer', e.x, e.y, e.x2, e.y2, now, 180 + Math.min(220, dist * 6), false);
      return;
    }
    if (ship.variant === 'submarine') {
      this.addShell('torpedo', e.x, e.y, e.x2, e.y2, now, 400 + Math.min(900, dist * 30), true);
      return;
    }
    const turrets = TURRETS[ship.variant ?? 'warship'] ?? TURRETS.warship;
    turrets.forEach(([u, v], i) => {
      const at = now + i * 80;
      this.addFlash(ship.id, u, v, e.x, e.y, e.x2!, e.y2!, at);
      // each turret's shell lands a little apart
      const sx = e.x2! + (rnd(e.x2! + i, ship.id) - 0.5) * 1.6;
      const sy = e.y2! + (rnd(e.y2! - i, ship.id) - 0.5) * 1.6;
      this.addShell('cannon', e.x, e.y, sx, sy, at + 30, 260 + Math.min(700, dist * 18), water && this.isWater(state, sx, sy));
    });
  }

  /** Shells that arrived: a splash on water, a small blast and a crater on land. */
  private land(state: GameState, now: number): void {
    for (const s of this.shells) {
      if (!s.live || s.landed || now < s.t0 + s.dur) continue;
      s.landed = true;
      if (s.kind === 'tracer') this.blast('flak', s.x1, s.y1, 0, now);
      else if (s.water || this.isWater(state, s.x1, s.y1)) this.blast('splash', s.x1, s.y1, 0, now);
      else {
        this.blast('shell', s.x1, s.y1, 0, now);
        this.crater(s.x1, s.y1, 0.5, state.tick, 300);
      }
    }
  }

  // ------------------------------------------------------------------------------------------------ pools

  /** Starts a blast at `t0` (it may lie a little in the future: a ripple); a full pool replaces the oldest. */
  blast(kind: BlastKind, x: number, y: number, rt: number, t0: number): void {
    let slot: Blast | null = null;
    let oldest: Blast | null = null;
    for (const b of this.blasts) {
      if (!b.live || t0 - b.t0 > SPEC[b.kind].dur * 1.2) {
        slot = b;
        break;
      }
      if (b.kind !== 'atom' && (!oldest || b.t0 < oldest.t0)) oldest = b;
    }
    slot = slot ?? oldest;
    if (!slot) return;
    slot.kind = kind;
    slot.x = x;
    slot.y = y;
    slot.rt = rt;
    slot.t0 = t0;
    slot.seed = fract(Math.sin(x * 12.9898 + y * 78.233 + t0 * 0.001) * 43758.5453);
    slot.live = true;
    this.spawned++;
  }

  private addShell(kind: Shell['kind'], x0: number, y0: number, x1: number, y1: number, t0: number, dur: number, water: boolean): void {
    let slot: Shell | null = null;
    let oldest: Shell | null = null;
    for (const s of this.shells) {
      if (!s.live || (s.landed && t0 > s.t0 + s.dur + 200)) {
        slot = s;
        break;
      }
      if (!oldest || s.t0 < oldest.t0) oldest = s;
    }
    slot = slot ?? oldest;
    if (!slot) return;
    Object.assign(slot, { kind, x0, y0, x1, y1, t0, dur, water, live: true, landed: false });
    this.spawned++;
  }

  private addFlash(unit: number, u: number, v: number, x: number, y: number, tx: number, ty: number, t0: number): void {
    let slot: Flash | null = null;
    let oldest: Flash | null = null;
    for (const f of this.flashes) {
      if (!f.live || t0 - f.t0 > FLASH_MS + 40) {
        slot = f;
        break;
      }
      if (!oldest || f.t0 < oldest.t0) oldest = f;
    }
    slot = slot ?? oldest;
    if (!slot) return;
    Object.assign(slot, { unit, u, v, x, y, tx, ty, t0, live: true });
  }

  /** A scorch crater at (x, y) tiles, radius r tiles, made at game time `born` (ticks), lasting `life` ticks. */
  crater(x: number, y: number, r: number, born: number, life: number): void {
    // it shows once the fireball covers the spot, not under the first flash
    const c = { x, y, r, born: born + CRATER_DELAY, life, seed: fract(Math.sin(x * 7.13 + y * 3.71) * 9157.31) };
    if (this.craters.length < CRATER_CAP) this.craters.push(c);
    else {
      this.craters[this.craterNext] = c;
      this.craterNext = (this.craterNext + 1) % CRATER_CAP;
    }
  }

  // ------------------------------------------------------------------------------------------------ drawing

  /** Craters, under the units (overlay canvas in CSS px). `gameTime` = tick + fraction. */
  drawGround(ctx: CanvasRenderingContext2D, cam: FxCam, gameTime: number): void {
    if (!this.wasOn || this.craters.length === 0) return;
    const z = cam.zoom;
    if (z < 1.5) return; // far out: nothing (a crater is a fraction of a pixel)
    const t0 = performance.now();
    const g = pixelSize(z);
    const ox = cam.viewW / 2 - cam.x * z;
    const oy = cam.viewH / 2 - cam.y * z;
    const prevA = ctx.globalAlpha;
    const prevS = ctx.imageSmoothingEnabled;
    ctx.imageSmoothingEnabled = false;
    for (const c of this.craters) {
      const age = gameTime - c.born;
      if (age < 0 || age > c.life) continue;
      const R = c.r * z;
      const sx = ox + c.x * z;
      const sy = oy + c.y * z;
      if (sx < -R - 8 || sy < -R - 8 || sx > cam.viewW + R + 8 || sy > cam.viewH + R + 8) continue;
      // full for the first 60 % of its life, then fading out
      const f = age < c.life * 0.6 ? 1 : 1 - (age - c.life * 0.6) / (c.life * 0.4);
      if (f <= 0.02) continue;
      if (z < 3) {
        // middle zooms: a plain dark spot
        ctx.globalAlpha = prevA * 0.45 * f;
        ctx.fillStyle = '#211b17';
        const r = Math.max(1, Math.round(R));
        ctx.fillRect(Math.round(sx - r), Math.round(sy - r * 0.8), r * 2, Math.max(1, Math.round(r * 1.6)));
        continue;
      }
      const cells = Math.max(2, Math.min(40, Math.round(R / g)));
      const img = craterSprite(cells, Math.floor(c.seed * 4));
      if (!img) continue;
      ctx.globalAlpha = prevA * f;
      const s = img.width * g;
      ctx.drawImage(img, Math.round(sx - s / 2), Math.round(sy - (img.height * g) / 2), s, img.height * g);
    }
    ctx.globalAlpha = prevA;
    ctx.imageSmoothingEnabled = prevS;
    this.ms += performance.now() - t0;
  }

  /** Shells, tracers, turret flashes and explosions, over the units. */
  drawAir(ctx: CanvasRenderingContext2D, cam: FxCam, now: number, poses: UnitPoses | null): void {
    if (!this.wasOn) return;
    const t0 = performance.now();
    const z = cam.zoom;
    const g = pixelSize(z);
    const ox = cam.viewW / 2 - cam.x * z;
    const oy = cam.viewH / 2 - cam.y * z;
    const prevA = ctx.globalAlpha;
    try {
      for (const s of this.shells) {
        if (!s.live) continue;
        const t = (now - s.t0) / s.dur;
        if (t > 1.2) {
          s.live = false;
          continue;
        }
        if (t < 0 || t > 1) continue;
        drawShell(ctx, s, t, ox, oy, z, g);
      }
      for (const f of this.flashes) {
        if (!f.live) continue;
        const t = (now - f.t0) / FLASH_MS;
        if (t > 1) {
          f.live = false;
          continue;
        }
        if (t < 0) continue;
        let px = ox + f.x * z;
        let py = oy + f.y * z;
        const at = f.unit >= 0 && poses ? poses.screenOf(f.unit) : null;
        const h = f.unit >= 0 && poses ? poses.headingOf(f.unit) : null;
        if (at && h !== null) {
          px = at.x + (Math.cos(h) * f.u - Math.sin(h) * f.v) * g;
          py = at.y + (Math.sin(h) * f.u + Math.cos(h) * f.v) * g * 0.84 - 2 * g;
        }
        const aim = Math.atan2(oy + f.ty * z - py, ox + f.tx * z - px);
        drawMuzzle(ctx, px, py, aim, t, g);
      }
      for (const b of this.blasts) {
        if (!b.live) continue;
        const spec = SPEC[b.kind];
        const t = (now - b.t0) / spec.dur;
        if (t > 1) {
          b.live = false;
          continue;
        }
        if (t < 0) continue;
        const sx = ox + b.x * z;
        const sy = oy + b.y * z;
        const reach = (b.kind === 'atom' ? Math.max(300, b.rt * z * 1.5) : 120) + 40;
        if (sx < -reach || sy < -reach || sx > cam.viewW + reach || sy > cam.viewH + reach) continue;
        drawBlast(ctx, b, sx, sy, t, z, g, this.reduced);
      }
    } catch {
      /* ignore */
    }
    ctx.globalAlpha = prevA;
    this.ms += performance.now() - t0;
  }

  /** Live counts (tests, stats). */
  liveCounts(): { blasts: number; shells: number; flashes: number; craters: number } {
    return { blasts: this.blasts.filter((b) => b.live).length, shells: this.shells.filter((s) => s.live).length, flashes: this.flashes.filter((f) => f.live).length, craters: this.craters.length };
  }
}

// ================================================================================================ pixel helpers

/** A filled pixel disc of `r` cells of `g` px centred on (cx, cy) (snapped to the grid). */
export function pixelDisc(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, g: number): void {
  const x0 = Math.round(cx / g) * g;
  const y0 = Math.round(cy / g) * g;
  const ri = Math.max(0, Math.round(r));
  if (ri === 0) {
    ctx.fillRect(x0, y0, g, g);
    return;
  }
  for (let dy = -ri; dy <= ri; dy++) {
    const half = Math.floor(Math.sqrt(ri * ri - dy * dy) + 0.35);
    ctx.fillRect(x0 - half * g, y0 + dy * g, (half * 2 + 1) * g, g);
  }
}

/** A 1-cell pixel ring of radius `r` cells (`dash`: every other cell, a ring breaking up as it fades). */
export function pixelRing(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, g: number, dash = false): void {
  const x0 = Math.round(cx / g) * g;
  const y0 = Math.round(cy / g) * g;
  const ri = Math.max(1, Math.round(r));
  const n = Math.max(8, Math.round(ri * 6.3));
  for (let i = 0; i < n; i++) {
    if (dash && i % 2) continue;
    const a = (i / n) * Math.PI * 2;
    ctx.fillRect(x0 + Math.round(Math.cos(a) * ri) * g, y0 + Math.round(Math.sin(a) * ri) * g, g, g);
  }
}

/** A shaded puff: a disc with a lighter disc toward the top left (the light) and a darker rim below right. */
function puff(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, g: number, dark: string, mid: string, light: string): void {
  ctx.fillStyle = dark;
  pixelDisc(ctx, x + g * 0.5, y + g * 0.5, r, g);
  ctx.fillStyle = mid;
  pixelDisc(ctx, x, y, r - 0.6, g);
  if (r >= 2) {
    ctx.fillStyle = light;
    pixelDisc(ctx, x - r * 0.3 * g, y - r * 0.3 * g, r * 0.45, g);
  }
}

/**
 * One explosion frame. Time `t` 0..1 is cut into a flipbook (6 frames; the atom bomb 14), so the motion steps like
 * pixel art. Sizes are in cells of `g` px (the sprites' pixel size); missiles and atom bombs also grow with the blast.
 */
function drawBlast(ctx: CanvasRenderingContext2D, b: Blast, x: number, y: number, t: number, z: number, g: number, reduced: boolean): void {
  if (b.kind === 'atom') {
    drawAtom(ctx, b, x, y, t, z, g, reduced);
    return;
  }
  if (b.kind === 'splash') {
    drawSplash(ctx, b, x, y, t, g);
    return;
  }
  const spec = SPEC[b.kind];
  let R = spec.r;
  if (b.kind === 'missile') R = Math.max(R, Math.min(26, (b.rt * z * 0.34) / g));
  else if (b.kind === 'bomb') R = Math.max(R, Math.min(12, (1.4 * z) / g));
  // planes burst in the air: a little above their shadow
  const yy = b.kind === 'air' ? y - 4 * g : y;
  const frames = 6;
  let f = Math.min(frames - 1, Math.floor(t * frames));
  if (reduced) f = t < 0.5 ? 1 : 4;
  const s = b.seed;
  const cell = (k: number): number => k * g;
  ctx.globalAlpha = 1;
  // debris: dark specks flung out (hot on the first frames), falling a little
  if (spec.debris && f >= 1 && f <= 4 && !reduced) {
    const d = R * (0.5 + f * 0.35);
    ctx.fillStyle = f <= 1 ? ORANGE : DEBRIS;
    for (let i = 0; i < spec.debris; i++) {
      const a = rnd(s, i) * Math.PI * 2;
      const dd = d * (0.7 + 0.5 * rnd(s, i + 9));
      const fall = b.kind === 'air' ? f * f * 0.8 : f * f * 0.35;
      // specks of 2 to 3 px, shrinking as they fly
      const sz = (b.kind === 'missile' && f <= 2 ? 3 : f >= 4 ? 1 : 2) * g;
      ctx.fillRect(Math.round((x + Math.cos(a) * cell(dd)) / g) * g, Math.round((yy + Math.sin(a) * cell(dd) * 0.8 + cell(fall)) / g) * g, sz, sz);
    }
  }
  switch (f) {
    case 0: {
      // the flash: a near-white core with a yellow edge and four short rays
      ctx.fillStyle = YELLOW;
      pixelDisc(ctx, x, yy, R * 0.6, g);
      ctx.fillStyle = WHITE;
      pixelDisc(ctx, x, yy, R * 0.42, g);
      const ray = Math.round(R * 0.9);
      ctx.fillRect(Math.round(x / g) * g - ray * g, Math.round(yy / g) * g, (ray * 2 + 1) * g, g);
      ctx.fillRect(Math.round(x / g) * g, Math.round(yy / g) * g - ray * g, g, (ray * 2 + 1) * g);
      break;
    }
    case 1:
    case 2: {
      // the fireball: orange with a yellow and white core toward the light, a hot yellow rim on the top left
      const r = R * (f === 1 ? 0.85 : 1);
      ctx.fillStyle = f === 1 ? ORANGE : RED;
      pixelDisc(ctx, x + g, yy + g, r, g);
      ctx.fillStyle = ORANGE;
      pixelDisc(ctx, x, yy, r, g);
      ctx.fillStyle = YELLOW;
      pixelDisc(ctx, x - cell(r * 0.18), yy - cell(r * 0.2), r * 0.62, g);
      ctx.fillStyle = WHITE;
      pixelDisc(ctx, x - cell(r * 0.25), yy - cell(r * 0.28), r * (f === 1 ? 0.34 : 0.2), g);
      if (spec.ring) {
        ctx.fillStyle = f === 1 ? WHITE : '#fff1b8';
        pixelRing(ctx, x, yy, r * (f === 1 ? 1.25 : 1.7), g, f === 2);
      }
      break;
    }
    case 3: {
      // darkening to red, the ring breaking up far out, first smoke on top
      ctx.fillStyle = EMBER;
      pixelDisc(ctx, x + g, yy + g, R * 0.85, g);
      ctx.fillStyle = RED;
      pixelDisc(ctx, x, yy, R * 0.85, g);
      ctx.fillStyle = ORANGE;
      pixelDisc(ctx, x - cell(R * 0.15), yy - cell(R * 0.15), R * 0.5, g);
      if (spec.ring) {
        ctx.globalAlpha = 0.6;
        ctx.fillStyle = '#fff1b8';
        pixelRing(ctx, x, yy, R * 2.1, g, true);
        ctx.globalAlpha = 1;
      }
      puff(ctx, x + cell(R * 0.3), yy - cell(R * 0.6), R * 0.45, g, SMOKE_DARK, SMOKE, SMOKE_LIGHT);
      break;
    }
    default: {
      // smoke puffs rising and drifting, embers underneath, then thinning out
      const k = f - 4;
      ctx.globalAlpha = k === 0 ? 1 : 0.62;
      if (k === 0) {
        ctx.fillStyle = RED;
        pixelDisc(ctx, x, yy, R * 0.35, g);
      }
      const n = Math.max(1, spec.smoke);
      for (let i = 0; i < n; i++) {
        const a = rnd(s, i + 20) * Math.PI * 2;
        const d = R * (0.2 + 0.4 * rnd(s, i + 30));
        const px = x + Math.cos(a) * cell(d) + cell(k * 1.5);
        const py = yy + Math.sin(a) * cell(d) * 0.6 - cell(R * (0.5 + 0.35 * k));
        puff(ctx, px, py, R * (0.4 + 0.12 * k) * (0.8 + 0.4 * rnd(s, i + 40)), g, SMOKE_DARK, SMOKE, SMOKE_LIGHT);
      }
      if (b.kind === 'missile') {
        // a short smoke column over the impact
        for (let i = 0; i < 3; i++) puff(ctx, x + cell(k), yy - cell(R * (1 + i * 0.55 + k * 0.4)), R * (0.3 + 0.05 * i), g, SMOKE_DARK, SMOKE, SMOKE_LIGHT);
      }
      ctx.globalAlpha = 1;
    }
  }
}

/**
 * A splash on water: a white column thrown up (lit on its left, shaded on its right), spray droplets falling back
 * out of it, and a foam ring spreading on the water and breaking up. Five frames.
 */
function drawSplash(ctx: CanvasRenderingContext2D, b: Blast, x: number, y: number, t: number, g: number): void {
  const f = Math.min(4, Math.floor(t * 5));
  const X = Math.round(x / g) * g;
  const Y = Math.round(y / g) * g;
  // the foam ring on the water first (the column stands in front of it)
  ctx.globalAlpha = f >= 3 ? 0.55 : 0.9;
  ctx.fillStyle = f >= 2 ? FOAM_DIM : FOAM;
  pixelRing(ctx, x, y, 1.6 + f * 1.15, g, f >= 3);
  if (f <= 2) {
    // the column: 3 cells wide, rising then falling back; a wider foot
    const hgt = [4, 7, 4][f];
    ctx.globalAlpha = 1;
    ctx.fillStyle = FOAM;
    ctx.fillRect(X - g, Y - hgt * g, g * 3, hgt * g);
    ctx.fillRect(X - 2 * g, Y - g, g * 5, g * 2);
    ctx.fillStyle = FOAM_DIM;
    ctx.fillRect(X + g, Y - hgt * g + g, g, hgt * g);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(X - g, Y - hgt * g, g, g);
    if (f === 1) {
      // the top breaking into two droplets
      ctx.fillStyle = FOAM;
      ctx.fillRect(X - 2 * g, Y - (hgt + 2) * g, g, g);
      ctx.fillRect(X + 2 * g, Y - (hgt + 1) * g, g, g);
    }
  }
  if (f >= 1) {
    // spray: droplets thrown out and falling back
    ctx.globalAlpha = f >= 3 ? 0.6 : 1;
    ctx.fillStyle = FOAM;
    for (let i = 0; i < 6; i++) {
      const a = rnd(b.seed, i) * Math.PI * 2;
      const d = 1.5 + f * 1.1 + rnd(b.seed, i + 7);
      const up = f === 1 ? 4 : f === 2 ? 3 : f === 3 ? 1 : 0;
      ctx.fillRect(Math.round((x + Math.cos(a) * d * g) / g) * g, Math.round((y + Math.sin(a) * d * g * 0.6 - up * g) / g) * g, g, g);
    }
  }
  ctx.globalAlpha = 1;
}

/** The atom bomb: flash, fireball, two rings, then a mushroom cloud rising on its column and fading. */
function drawAtom(ctx: CanvasRenderingContext2D, b: Blast, x: number, y: number, t: number, z: number, g0: number, reduced: boolean): void {
  // the blast is big on screen: coarser cells keep it chunky and cheap
  const R = Math.max(18, Math.min(220, b.rt * z * 0.45));
  const g = Math.max(g0, Math.round(R / 22));
  const r = R / g;
  const n = 14;
  let f = Math.min(n - 1, Math.floor(t * n));
  if (reduced) f = t < 0.3 ? 2 : 8;
  const cell = (k: number): number => k * g;
  if (f <= 1) {
    ctx.globalAlpha = f === 0 ? 0.9 : 0.6;
    ctx.fillStyle = WHITE;
    pixelDisc(ctx, x, y, r * (f === 0 ? 1.3 : 1.6), g);
    ctx.globalAlpha = 1;
    ctx.fillStyle = '#ffffff';
    pixelDisc(ctx, x, y, r * 0.7, g);
    return;
  }
  // rings: white then pale yellow, running out and breaking up
  if (f <= 7) {
    ctx.globalAlpha = 1 - (f - 2) / 7;
    ctx.fillStyle = WHITE;
    pixelRing(ctx, x, y, r * (1.1 + (f - 2) * 0.45), g, f > 4);
    ctx.fillStyle = '#fff1b8';
    if (f >= 3) pixelRing(ctx, x, y, r * (0.9 + (f - 3) * 0.32), g, f > 5);
    ctx.globalAlpha = 1;
  }
  // the column and the cap rise from frame 4; the fireball shrinks into the cap
  const rise = Math.max(0, f - 3) / (n - 4);
  const fade = f >= n - 4 ? 1 - (f - (n - 4)) / 4 : 1;
  ctx.globalAlpha = fade;
  if (f >= 4) {
    const top = r * (0.6 + 1.6 * rise);
    for (let i = 0; i < 5; i++) {
      const h = (i / 4) * top;
      puff(ctx, x + cell(Math.sin(i * 1.7 + b.seed) * 0.6), y - cell(h), r * (0.32 - i * 0.025), g, SMOKE_DARK, SMOKE, SMOKE_LIGHT);
    }
    // the cap: a ring of puffs with a glowing underside early on
    const cy = y - cell(top + r * 0.3);
    for (let i = 0; i < 7; i++) {
      const a = (i / 7) * Math.PI * 2;
      puff(ctx, x + Math.cos(a) * cell(r * 0.6), cy + Math.sin(a) * cell(r * 0.28), r * 0.42, g, SMOKE_DARK, SMOKE, SMOKE_LIGHT);
    }
    puff(ctx, x, cy - cell(r * 0.15), r * 0.5, g, SMOKE_DARK, SMOKE, SMOKE_LIGHT);
    if (f <= 8) {
      ctx.fillStyle = f <= 6 ? ORANGE : RED;
      pixelDisc(ctx, x, cy + cell(r * 0.3), r * 0.35, g);
    }
  }
  if (f <= 7) {
    // the fireball: lumpy orange edge, a red rim on the lower right, orange body, the hot side yellow and white
    // toward the light; it cools to red and sinks into the column
    const fr = r * (f <= 3 ? 1 : 1 - (f - 3) * 0.16);
    const hot = f <= 4;
    ctx.fillStyle = hot ? ORANGE : RED;
    for (let i = 0; i < 9; i++) {
      const a = (i / 9) * Math.PI * 2 + b.seed * 6;
      pixelDisc(ctx, x + Math.cos(a) * cell(fr * 0.92), y + Math.sin(a) * cell(fr * 0.92), fr * (0.2 + 0.08 * rnd(b.seed, i)), g);
    }
    ctx.fillStyle = hot ? RED : EMBER;
    pixelDisc(ctx, x + g, y + g, fr, g);
    ctx.fillStyle = hot ? ORANGE : RED;
    pixelDisc(ctx, x, y, fr, g);
    ctx.fillStyle = hot ? YELLOW : ORANGE;
    pixelDisc(ctx, x - cell(fr * 0.14), y - cell(fr * 0.16), fr * 0.7, g);
    if (f <= 5) {
      ctx.fillStyle = f <= 3 ? WHITE : YELLOW;
      pixelDisc(ctx, x - cell(fr * 0.3), y - cell(fr * 0.32), fr * 0.34, g);
    }
  }
  ctx.globalAlpha = 1;
}

/**
 * A turret's muzzle flash, three frames: a white-hot star with a long tongue of fire toward the target, then a
 * smaller orange burst, then a grey smoke puff drifting off the muzzle.
 */
function drawMuzzle(ctx: CanvasRenderingContext2D, x: number, y: number, aim: number, t: number, g: number): void {
  const f = t < 0.3 ? 0 : t < 0.6 ? 1 : 2;
  const c = Math.cos(aim);
  const s = Math.sin(aim);
  const at = (d: number, side = 0): [number, number] => [Math.round((x + (c * d - s * side) * g) / g) * g, Math.round((y + (s * d + c * side) * g) / g) * g];
  if (f === 2) {
    const k = (t - 0.6) / 0.4;
    ctx.globalAlpha = 0.8 * (1 - k);
    puff(ctx, x + c * 3 * g + k * 2 * g, y + s * 3 * g - (1 + k * 3) * g, 1.6 + k, g, SMOKE, SMOKE_LIGHT, '#d2cec8');
    ctx.globalAlpha = 1;
    return;
  }
  const len = f === 0 ? 8 : 5;
  // the burst just out of the muzzle
  const [bx, by] = at(f === 0 ? 3 : 2.5);
  ctx.fillStyle = f === 0 ? YELLOW : ORANGE;
  pixelDisc(ctx, bx, by, f === 0 ? 2.4 : 1.8, g);
  // the tongue of fire, a cell wide, and two short side spikes on the first frame
  ctx.fillStyle = f === 0 ? WHITE : YELLOW;
  for (let i = 0; i <= len; i++) {
    const [px, py] = at(i);
    ctx.fillRect(px, py, g, g);
  }
  if (f === 0) {
    for (const sd of [-2, 2]) {
      const [px, py] = at(3, sd);
      ctx.fillRect(px, py, g, g);
    }
    ctx.fillStyle = WHITE;
    pixelDisc(ctx, bx, by, 1, g);
  }
}

/** A shell in flight (an arc with a short tracer), a tracer burst at a plane, or a torpedo's wake. */
function drawShell(ctx: CanvasRenderingContext2D, s: Shell, t: number, ox: number, oy: number, z: number, g: number): void {
  const x0 = ox + s.x0 * z;
  const y0 = oy + s.y0 * z;
  const x1 = ox + s.x1 * z;
  const y1 = oy + s.y1 * z;
  const dist = Math.hypot(x1 - x0, y1 - y0);
  if (s.kind === 'torpedo') {
    // a white wake drawn out along the water
    ctx.fillStyle = FOAM;
    const n = Math.max(2, Math.floor((dist * t) / (2 * g)));
    for (let i = 0; i < n; i++) {
      const q = (i / Math.max(1, dist / (2 * g))) * 1;
      const px = x0 + (x1 - x0) * Math.min(t, q);
      const py = y0 + (y1 - y0) * Math.min(t, q);
      ctx.globalAlpha = 0.25 + 0.6 * (i / n);
      ctx.fillRect(Math.round(px / g) * g, Math.round(py / g) * g, g, g);
    }
    ctx.globalAlpha = 1;
    return;
  }
  if (s.kind === 'tracer') {
    // three bright dashes racing to the plane
    ctx.fillStyle = '#ffe58a';
    for (let i = 0; i < 3; i++) {
      const q = t - i * 0.12;
      if (q < 0 || q > 1) continue;
      const px = x0 + (x1 - x0) * q;
      const py = y0 + (y1 - y0) * q;
      ctx.fillRect(Math.round(px / g) * g, Math.round(py / g) * g, g * 2, g);
    }
    return;
  }
  // a cannon shell: lobbed in an arc (up on screen), a hot core with a fading tracer behind it
  const H = Math.min(60, dist * 0.22);
  const at = (q: number): [number, number] => [x0 + (x1 - x0) * q, y0 + (y1 - y0) * q - 4 * H * q * (1 - q)];
  for (let i = 4; i >= 1; i--) {
    const q = t - i * 0.035;
    if (q < 0) continue;
    const [px, py] = at(q);
    ctx.globalAlpha = 0.7 - i * 0.13;
    ctx.fillStyle = i === 1 ? ORANGE : SMOKE_LIGHT;
    ctx.fillRect(Math.round(px / g) * g, Math.round(py / g) * g, g * (i > 2 ? 2 : 1), g * (i > 2 ? 2 : 1));
  }
  ctx.globalAlpha = 1;
  const [px, py] = at(t);
  const X = Math.round(px / g) * g;
  const Y = Math.round(py / g) * g;
  // the shell: a hot 2 cell core lit from the top left, dark on its lower right edge so it shows on bright land
  ctx.fillStyle = DEBRIS;
  ctx.fillRect(X - g, Y - g, g * 3, g * 3);
  ctx.fillStyle = YELLOW;
  ctx.fillRect(X - g, Y - g, g * 2, g * 2);
  ctx.fillStyle = WHITE;
  ctx.fillRect(X - g, Y - g, g, g);
}

// ================================================================================================ craters

/**
 * A crater as a small baked bitmap (cells across = 2 * radius + 4): a scorched disc, a darker pit lit on its lower
 * right inner wall (the light comes from the top left), a light earth rim on the top left of the raised edge, and a
 * few debris pixels around. Four shapes per size.
 */
const craterCache = new Map<number, HTMLCanvasElement | null>();
function craterSprite(r: number, variant: number): HTMLCanvasElement | null {
  const key = r * 4 + variant;
  const hit = craterCache.get(key);
  if (hit !== undefined) return hit;
  let cv: HTMLCanvasElement | null = null;
  if (typeof document !== 'undefined') {
    const bm = craterBitmap(r, variant);
    cv = document.createElement('canvas');
    cv.width = bm.w;
    cv.height = bm.h;
    const ctx = cv.getContext('2d');
    if (ctx && typeof ImageData !== 'undefined') ctx.putImageData(new ImageData(bm.data, bm.w, bm.h), 0, 0);
    else cv = null;
  }
  if (craterCache.size > 300) craterCache.clear();
  craterCache.set(key, cv);
  return cv;
}

/** The crater pixels (RGBA), testable without a canvas. */
export function craterBitmap(r: number, variant: number): { w: number; h: number; data: Uint8ClampedArray } {
  const pad = Math.max(2, Math.ceil(r * 0.6));
  const w = r * 2 + 1 + pad * 2;
  const h = Math.ceil(r * 1.7) + 1 + pad * 2;
  const data = new Uint8ClampedArray(w * h * 4);
  const cx = Math.floor(w / 2);
  const cy = Math.floor(h / 2);
  const set = (x: number, y: number, c: readonly number[], a: number): void => {
    if (x < 0 || y < 0 || x >= w || y >= h) return;
    const o = (y * w + x) * 4;
    data[o] = c[0];
    data[o + 1] = c[1];
    data[o + 2] = c[2];
    data[o + 3] = a;
  };
  const SCORCH = [40, 33, 28];
  const PIT = [22, 18, 16];
  const WALL = [92, 74, 58];
  const RIM = [168, 146, 112];
  const RIM_SHADE = [112, 94, 72];
  const ry = r * 0.82;
  const wob = (a: number): number => 1 + 0.12 * Math.sin(a * 3 + variant * 1.9) + 0.06 * Math.sin(a * 5 + variant);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = x - cx;
      const dy = y - cy;
      const a = Math.atan2(dy, dx);
      const d = Math.sqrt((dx / r) ** 2 + (dy / ry) ** 2) / wob(a);
      if (d <= 0.5) {
        // the pit: its lower right inner wall catches the light
        const lit = dx + dy > r * 0.25 && d > 0.3;
        set(x, y, lit ? WALL : PIT, 235);
      } else if (d <= 0.92) set(x, y, SCORCH, 215);
      else if (d <= 1.12) {
        // the raised rim: light on the top left, shaded on the bottom right
        set(x, y, dx + dy < 0 ? RIM : RIM_SHADE, 200);
      } else if (d <= 1.45) {
        // scorched ground fading out, broken up
        if (rnd(x * 31 + y * 17, variant + 5) < 0.42 * (1.45 - d) * 2.2) set(x, y, SCORCH, 120);
      }
    }
  }
  // debris pixels thrown around
  const n = 3 + (r >> 2);
  for (let i = 0; i < n; i++) {
    const a = rnd(variant + r, i) * Math.PI * 2;
    const d = r * (1.25 + 0.45 * rnd(r, i + variant));
    set(Math.round(cx + Math.cos(a) * d), Math.round(cy + Math.sin(a) * d * 0.82), i % 2 ? PIT : RIM_SHADE, 230);
  }
  return { w, h, data };
}

/** Which ship variant fires how many turrets (tests). */
export function turretCount(variant: UnitVariant | undefined): number {
  if (variant === 'submarine' || variant === 'carrier') return 0;
  return (TURRETS[variant ?? 'warship'] ?? TURRETS.warship).length;
}
