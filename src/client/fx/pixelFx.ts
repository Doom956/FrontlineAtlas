// Battle effects (client only): explosions, ship cannon fire, shells, flak and craters. Read-only like the rest of
// fx/: each frame it reads the effects the sim already records (state.effects: 'explosion', 'nuke', 'barrage', 'shot')
// and the units it sees, and never writes to the state, so the sim, its hash and multiplayer are untouched. This file
// decides WHAT happens where and when (the pools, the events, the timing); HOW it looks is the current art style of
// each category (art/registry.ts: 'explosions', 'craters', 'cannonFire'; the refined pixel art is art/refined/).
//
// Explosions by event: a shell (barrage shells, a ship's shell on land), a stick of bombs over a bomber's or air
// strike's disc, a missile (where a rocket was going), the atom bomb (fx/battleFx.ts adds its wave rings and the camera
// shake), a ship or fort hit, a plane shot down, a splash on water, a flak burst. Far out (below zoom 2) small blasts
// are a shared two-pixel blink and shells and muzzle flashes are not drawn.
//
// Ship cannon fire: when a warship fires (a 'shot' starting at a warship), the guns of its salvo flash in a ripple
// (SALVO: two for a plain warship, two for a destroyer's one turret, three for a battleship; the ship's art style says
// where each gun is), shells arc to the target and land as a splash on water or a small explosion and a crater on
// land. Submarines send a torpedo; carriers, SAM sites and airfields send tracer bursts that end in a flak puff.
//
// Deaths: a unit destroyed (fx/deaths.ts tells it from one that arrived) plays its death where it was, in the
// explosions style (ExplosionArt.drawDeath): a plane shot down falls and crashes (a crater where it hits land), a missile
// shot down bursts in the air, a tank division burns out, a ship goes under. A style without death animations shows its
// small blast there instead, as before (a plane's burst in the air, a hit and a crater).
//
// Craters: every blast on land leaves one that fades out over about a minute of game time (atom bombs bigger and
// longer; the motion preset's craterLife scales it). None at the coast; one reaching water is clipped to the land
// tiles. A capped ring buffer (CRATER_CAP); drawn under units; hidden far out. Every pool is fixed size, nothing is
// allocated per effect.
import type { Effect, GameState, Unit, UnitVariant } from '../../sim/types';
import type { FogView } from '../fog/fogView';
import { artFor, motionFor } from '../art/registry';
import type { RGB } from '../art/shared/colour';
import { spriteKey, type SpriteKey } from '../art/shared/keys';
import { fract, rnd } from '../art/shared/noise';
import { CRATER_ATOM_REACH, CRATER_REACH, DEATH_GLIDE_TILES, type BlastDraw, type BlastKind, type CraterDraw, type DeathDraw, type DeathKind, type ExplosionArt, type MotionParams, type MuzzleDraw, type ShellDraw } from '../art/types';
import { unitSpriteMods } from '../render/pixelSprites';
import { DeathWatch, deathKindOf, isKillBlast } from './deaths';
import { fxEnabled, prefersReducedMotion } from './settings';

export type { BlastKind } from '../art/types';
export { pixelDisc, pixelRing } from '../art/shared/pixel';

export const CRATER_CAP = 200;
/** Game ticks between a blast and its crater showing (the fireball hides the moment it appears). */
const CRATER_DELAY = 1.5;
const BLAST_CAP = 72;
const DEATH_CAP = 32;
const SHELL_CAP = 48;
const FLASH_CAP = 48;
/** Things older than this (ticks) are history, not news (as fx/battleFx.ts). */
const FRESH_TICKS = 15;
const JUMP_TICKS = 30;

/** The far blink's ramp (the same light to dark steps as the pixel explosions). */
const WHITE = '#fffbe8';
const YELLOW = '#ffd84a';
const ORANGE = '#ff8a1f';
const RED = '#d4361c';
const SMOKE = '#6e6b68';
const FOAM = '#eef6fa';
const FOAM_DIM = '#b9d2df';

interface Blast {
  kind: BlastKind;
  /** tile coordinates */
  x: number;
  y: number;
  /** blast radius in tiles (missiles, atom bombs: the fireball grows with it) */
  rt: number;
  t0: number;
  /** how long it lasts (ms; the explosions style and motion preset at the start) */
  dur: number;
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
  seed: number;
}
interface Flash {
  /** the firing ship (its pose is read from the unit layer each frame); -1 = a fixed point */
  unit: number;
  /** the ship's picture and which gun of its salvo fires (the ships style says where that gun is) */
  key: SpriteKey;
  gun: number;
  /** fixed point (tile) when unit is -1, and the target (tile) for the direction */
  x: number;
  y: number;
  tx: number;
  ty: number;
  t0: number;
  /** how long the flash lasts (ms; the cannon fire style and motion preset at the start) */
  dur: number;
  live: boolean;
}
export interface Crater {
  x: number;
  y: number;
  /** radius in tiles */
  r: number;
  /** game time (ticks) it was made and how long it lasts */
  born: number;
  life: number;
  seed: number;
  /** the crater reaches water: it is drawn clipped to the land tiles */
  coast: boolean;
  /** the atom bomb's ground mark (it reaches CRATER_ATOM_REACH radii, its blast zone; others CRATER_REACH) */
  atom: boolean;
}

interface Death {
  kind: DeathKind;
  key: SpriteKey;
  mods: number;
  /** the owner's player id (its colour is read when drawing) */
  owner: number;
  /** where it was hit (tile coordinates of its centre) and its heading */
  x: number;
  y: number;
  angle: number;
  water: boolean;
  t0: number;
  dur: number;
  /** when it reaches the ground or goes under (ms after t0) */
  impact: number;
  seed: number;
  live: boolean;
}

/** How far a crater's drawing reaches, in tiles. */
const craterReach = (c: { r: number; atom: boolean }): number => c.r * (c.atom ? CRATER_ATOM_REACH : CRATER_REACH);

/** What the effects need from the unit layer: where a ship was drawn and which way it faces. */
export interface UnitPoses {
  screenOf(id: number): { x: number; y: number } | null;
  headingOf(id: number): number | null;
  /** the heading a unit was last drawn at, eased and not snapped (a unit that died this tick still has one) */
  angleOf?(id: number): number | null;
}

export interface FxCam {
  zoom: number;
  x: number;
  y: number;
  viewW: number;
  viewH: number;
}

/** How many guns fire in a ship's salvo (a destroyer's one turret fires twice). */
const SALVO: Record<string, number> = { warship: 2, destroyer: 2, battleship: 3 };

/** Below this zoom small blasts are a blink and shells and muzzle flashes are not drawn. */
const FAR_FX_ZOOM = 2;

/** Screen px per art pixel at zoom z (the unit sprites' scale, render/units.ts spriteScale). */
export function pixelSize(z: number): number {
  return z < 11 ? 1 : z < 22 ? 2 : z < 32 ? 3 : 4;
}

export class PixelFx {
  /** ms spent in update + draws last frame (renderer stats) */
  ms = 0;
  /** effects started since the game began (tests) */
  spawned = 0;
  fog: FogView | null = null;

  readonly blasts: Blast[] = [];
  readonly deaths: Death[] = [];
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
  /** units destroyed since the last tick (fx/deaths.ts) */
  private watch = new DeathWatch();
  private gone: Unit[] = [];
  private scanTick = -1;
  private reduced = prefersReducedMotion();
  private wasOn = true;

  constructor() {
    for (let i = 0; i < BLAST_CAP; i++) this.blasts.push({ kind: 'shell', x: 0, y: 0, rt: 0, t0: 0, dur: 1, seed: 0, live: false });
    for (let i = 0; i < DEATH_CAP; i++) this.deaths.push({ kind: 'plane', key: 'bomber', mods: 0, owner: 0, x: 0, y: 0, angle: 0, water: false, t0: 0, dur: 1, impact: 0, seed: 0, live: false });
    for (let i = 0; i < SHELL_CAP; i++) this.shells.push({ kind: 'cannon', x0: 0, y0: 0, x1: 0, y1: 0, t0: 0, dur: 1, water: false, live: false, landed: false, seed: 0 });
    for (let i = 0; i < FLASH_CAP; i++) this.flashes.push({ unit: -1, key: 'warship', gun: 0, x: 0, y: 0, tx: 0, ty: 0, t0: 0, dur: 1, live: false });
  }

  // ------------------------------------------------------------------------------------------- reading the game

  /**
   * Reads what is new in `state` and starts its effects. Call once per frame before drawing; `poses` (the unit layer,
   * before it tracks this tick) gives the heading a unit that died was drawn at.
   */
  update(state: GameState, nowMs: number, poses: UnitPoses | null = null): void {
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
        // the sim's kill blast: a unit's death, or a ship or fort hit (told apart once the tick's units are read)
        if (e.kind === 'explosion' && isKillBlast(e.radius)) {
          this.watch.blast(e.x, e.y);
          continue;
        }
        if (!this.inSight(state, e.x, e.y)) continue;
        this.ingest(state, e, nowMs);
      }
      if (state.tick !== this.scanTick || this.watch.blasts > 0) {
        this.scanTick = state.tick;
        this.readDeaths(state, nowMs, poses);
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
    this.scanTick = -1;
    this.watch.reset(null);
    for (const d of this.deaths) d.live = false;
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
    this.watch.reset(state);
    this.scanTick = state.tick;
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

  /** True when the tile under (x, y) and its four neighbours are all land: only there is a crater left. */
  private landAround(state: GameState, x: number, y: number): boolean {
    return !this.isWater(state, x, y) && !this.isWater(state, x + 1, y) && !this.isWater(state, x - 1, y) && !this.isWater(state, x, y + 1) && !this.isWater(state, x, y - 1);
  }

  /**
   * A crater from a blast on land: none at the coast (the centre tile or one of its four neighbours is water), and
   * one whose bitmap reaches water is drawn clipped to the land tiles. Water hits splash instead.
   */
  private scar(state: GameState, x: number, y: number, r: number, born: number, life: number, atom = false): void {
    if (!this.landAround(state, x, y)) return;
    const c = this.crater(x, y, r, born, life);
    c.atom = atom;
    const reach = Math.ceil(craterReach(c)) + 1;
    const w = state.map.width;
    const h = state.map.height;
    const T = state.map.terrain;
    const cx = Math.floor(x);
    const cy = Math.floor(y);
    for (let ty = cy - reach; ty <= cy + reach && !c.coast; ty++)
      for (let tx = cx - reach; tx <= cx + reach; tx++)
        if (tx < 0 || ty < 0 || tx >= w || ty >= h || T[ty * w + tx] <= 1) {
          c.coast = true;
          break;
        }
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
        this.scar(state, e.x, e.y, Math.max(4, e.radius * 0.32), tick, 1800, true);
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
            this.scar(state, x, y, 0.45 + rnd(e.x, i + 3) * 0.25, tick + (at - now) / 100, 450);
          }
        }
        return;
      }
      case 'explosion': {
        const tile = Math.floor(e.y) * w + Math.floor(e.x);
        if (e.radius >= 4) {
          if (this.missileTargets.has(tile)) {
            this.blast('missile', e.x, e.y, e.radius, now);
            if (!this.isWater(state, e.x, e.y)) this.scar(state, e.x, e.y, Math.max(1.6, e.radius * 0.3), tick, 650);
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
              this.scar(state, x, y, 0.75 + rnd(e.x, i) * 0.35, tick + (at - now) / 100, 550);
            }
          }
          return;
        }
        this.smallBlast(state, e.x, e.y, now);
        return;
      }
      case 'shot':
        this.shot(state, e, now);
        return;
      default:
        return;
    }
  }

  /** The sim's kill blast where no death animation plays: a plane's burst in the air, else a hit (and a crater on land). */
  private smallBlast(state: GameState, x: number, y: number, now: number): void {
    const lost = this.lostAt(x, y);
    if (lost && (lost.type === 'bomber' || lost.type === 'fighter' || lost.type === 'transportPlane' || lost.type === 'reconPlane')) this.blast('air', x, y, 0, now);
    else if (this.isWater(state, x, y)) this.blast('hit', x, y, 0, now);
    else {
      this.blast('hit', x, y, 0, now);
      this.scar(state, x, y, 0.7, state.tick, 500);
    }
  }

  /**
   * This tick's deaths (fx/deaths.ts): with a style that animates them, each one in sight plays its death and its kill
   * blast is not drawn again; the other kill blasts (ships and forts hit, and every one with a style that does not
   * animate deaths) are small blasts as before.
   */
  private readDeaths(state: GameState, now: number, poses: UnitPoses | null): void {
    const art = artFor('explosions');
    const m = motionFor('explosions');
    const animate = typeof art.drawDeath === 'function' && typeof art.deathTimes === 'function';
    const n = this.watch.scan(state, this.gone);
    if (animate) for (let i = 0; i < n; i++) {
      const u = this.gone[i];
      if (this.inSight(state, u.x + 0.5, u.y + 0.5)) this.addDeath(state, u, now, poses, art, m);
    }
    const w = this.watch;
    for (let i = 0; i < w.blasts; i++) {
      if (animate && w.wasDeath(i)) continue;
      const x = w.blastX(i);
      const y = w.blastY(i);
      if (this.inSight(state, x, y)) this.smallBlast(state, x, y, now);
    }
    w.endTick();
    this.gone.length = 0;
  }

  private addDeath(state: GameState, u: Unit, now: number, poses: UnitPoses | null, art: ExplosionArt, m: MotionParams): void {
    const kind = deathKindOf(u.type);
    if (!kind || !art.deathTimes) return;
    let slot: Death | null = null;
    let oldest: Death | null = null;
    for (const d of this.deaths) {
      if (!d.live || now - d.t0 > d.dur) {
        slot = d;
        break;
      }
      if (!oldest || d.t0 < oldest.t0) oldest = d;
    }
    slot = slot ?? oldest;
    if (!slot) return;
    const cx = u.x + 0.5;
    const cy = u.y + 0.5;
    const angle = poses?.angleOf?.(u.id) ?? headingOf(state, u);
    const times = art.deathTimes(kind, m);
    slot.kind = kind;
    slot.key = spriteKey(u.type, u.variant);
    slot.mods = unitSpriteMods(state, u);
    slot.owner = u.owner;
    slot.x = cx;
    slot.y = cy;
    slot.angle = angle;
    slot.t0 = now;
    slot.dur = Math.max(1, times.durMs);
    slot.impact = times.impactMs;
    slot.seed = fract(Math.sin(cx * 12.9898 + cy * 78.233 + u.id * 0.618) * 43758.5453);
    slot.live = true;
    if (kind === 'plane') {
      // it comes down a little way on along its heading: water there, or a crater once it has crashed
      const gx = cx + Math.cos(angle) * DEATH_GLIDE_TILES;
      const gy = cy + Math.sin(angle) * DEATH_GLIDE_TILES;
      slot.water = this.isWater(state, gx, gy);
      if (!slot.water) this.scar(state, gx, gy, 0.55, state.tick + times.impactMs / 100, 450);
    } else slot.water = kind === 'ship' || this.isWater(state, cx, cy);
    this.spawned++;
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
    const key = spriteKey('warship', ship.variant);
    const guns = SALVO[key] ?? SALVO.warship;
    for (let i = 0; i < guns; i++) {
      const at = now + i * 80;
      this.addFlash(ship.id, key, i, e.x, e.y, e.x2!, e.y2!, at);
      // each turret's shell lands a little apart
      const sx = e.x2! + (rnd(e.x2! + i, ship.id) - 0.5) * 1.6;
      const sy = e.y2! + (rnd(e.y2! - i, ship.id) - 0.5) * 1.6;
      this.addShell('cannon', e.x, e.y, sx, sy, at + 30, 260 + Math.min(700, dist * 18), water && this.isWater(state, sx, sy));
    }
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
        this.scar(state, s.x1, s.y1, 0.5, state.tick, 300);
      }
    }
  }

  // ------------------------------------------------------------------------------------------------ pools

  /** Starts a blast at `t0` (it may lie a little in the future: a ripple); a full pool replaces the oldest. */
  blast(kind: BlastKind, x: number, y: number, rt: number, t0: number): void {
    let slot: Blast | null = null;
    let oldest: Blast | null = null;
    for (const b of this.blasts) {
      if (!b.live || t0 - b.t0 > b.dur * 1.2) {
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
    slot.dur = Math.max(1, artFor('explosions').durationMs(kind, motionFor('explosions')));
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
    Object.assign(slot, { kind, x0, y0, x1, y1, t0, dur, water, live: true, landed: false, seed: fract(Math.sin(x1 * 12.9898 + y1 * 78.233 + t0 * 0.001) * 43758.5453) });
    this.spawned++;
  }

  private addFlash(unit: number, key: SpriteKey, gun: number, x: number, y: number, tx: number, ty: number, t0: number): void {
    let slot: Flash | null = null;
    let oldest: Flash | null = null;
    for (const f of this.flashes) {
      if (!f.live || t0 - f.t0 > f.dur + 40) {
        slot = f;
        break;
      }
      if (!oldest || f.t0 < oldest.t0) oldest = f;
    }
    slot = slot ?? oldest;
    if (!slot) return;
    const dur = Math.max(1, artFor('cannonFire').flashMs(motionFor('cannonFire')));
    Object.assign(slot, { unit, key, gun, x, y, tx, ty, t0, dur, live: true });
  }

  /** A scorch crater at (x, y) tiles, radius r tiles, made at game time `born` (ticks), lasting `life` ticks. */
  crater(x: number, y: number, r: number, born: number, life: number): Crater {
    // it shows once the fireball covers the spot, not under the first flash
    const c = { x, y, r, born: born + CRATER_DELAY, life, seed: fract(Math.sin(x * 7.13 + y * 3.71) * 9157.31), coast: false, atom: false };
    if (this.craters.length < CRATER_CAP) this.craters.push(c);
    else {
      this.craters[this.craterNext] = c;
      this.craterNext = (this.craterNext + 1) % CRATER_CAP;
    }
    return c;
  }

  // ------------------------------------------------------------------------------------------------ drawing

  /** Craters, under the units (overlay canvas in CSS px). `gameTime` = tick + fraction. */
  drawGround(ctx: CanvasRenderingContext2D, cam: FxCam, gameTime: number, dpr = 1): void {
    if (!this.wasOn || this.craters.length === 0) return;
    const z = cam.zoom;
    if (z < 1.5) return; // far out: nothing (a crater is a fraction of a pixel)
    const t0 = performance.now();
    const g = pixelSize(z);
    const ox = cam.viewW / 2 - cam.x * z;
    const oy = cam.viewH / 2 - cam.y * z;
    const prevA = ctx.globalAlpha;
    const prevS = ctx.imageSmoothingEnabled;
    const map = this.state?.map ?? null;
    const art = artFor('craters');
    const m = motionFor('craters');
    const d = this.craterDraw;
    d.zoom = z;
    d.scale = g;
    d.dpr = dpr;
    for (const c of this.craters) {
      const age = gameTime - c.born;
      const life = c.life * m.craterLife;
      if (age < 0 || age > life) continue;
      const R = c.r * z;
      const sx = ox + c.x * z;
      const sy = oy + c.y * z;
      const reach = craterReach(c) * z + 8;
      if (sx < -reach || sy < -reach || sx > cam.viewW + reach || sy > cam.viewH + reach) continue;
      // at the coast: clipped to the land tiles, so no scorch lies on the water
      const clip = c.coast && map ? clipToLand(ctx, map.terrain, map.width, map.height, c, ox, oy, z) : false;
      if (c.coast && map && !clip) continue;
      d.x = sx;
      d.y = sy;
      d.radiusPx = R;
      d.q = age / life;
      d.seed = c.seed;
      d.atom = c.atom;
      art.draw(ctx, d, m);
      if (clip) ctx.restore();
    }
    ctx.globalAlpha = prevA;
    ctx.imageSmoothingEnabled = prevS;
    this.ms += performance.now() - t0;
  }

  private craterDraw: CraterDraw = { x: 0, y: 0, radiusPx: 0, q: 0, zoom: 1, scale: 1, seed: 0, dpr: 1, atom: false };
  private deathDraw: DeathDraw = { kind: 'plane', key: 'bomber', mods: 0, owner: [128, 128, 128], x: 0, y: 0, angle: 0, water: false, t: 0, ageMs: 0, durMs: 1, zoom: 1, scale: 1, seed: 0, reduced: false, dpr: 1 };
  private blastDraw: BlastDraw = { kind: 'shell', x: 0, y: 0, t: 0, ageMs: 0, durMs: 1, zoom: 1, scale: 1, rt: 0, seed: 0, reduced: false, dpr: 1 };
  private muzzleDraw: MuzzleDraw = { x: 0, y: 0, aim: 0, t: 0, zoom: 1, scale: 1, seed: 0, dpr: 1 };
  private shellDraw: ShellDraw = { kind: 'cannon', x0: 0, y0: 0, x1: 0, y1: 0, t: 0, zoom: 1, scale: 1, seed: 0, dpr: 1 };

  /** Shells, tracers, turret flashes, deaths and explosions, over the units; `colors` the players' colours by id. */
  drawAir(ctx: CanvasRenderingContext2D, cam: FxCam, now: number, poses: UnitPoses | null, dpr = 1, colors: readonly RGB[] | null = null): void {
    if (!this.wasOn) return;
    const t0 = performance.now();
    const z = cam.zoom;
    const g = pixelSize(z);
    const ox = cam.viewW / 2 - cam.x * z;
    const oy = cam.viewH / 2 - cam.y * z;
    const prevA = ctx.globalAlpha;
    // far out (whole regions on screen) shells and muzzle flashes would be single-pixel noise: skipped; small blasts
    // are a two-pixel blink (drawBlastFar), only missiles and atom bombs keep their full flipbook
    const far = z < FAR_FX_ZOOM;
    try {
      const cannon = artFor('cannonFire');
      const cm = motionFor('cannonFire');
      const sd = this.shellDraw;
      sd.zoom = z;
      sd.scale = g;
      sd.dpr = dpr;
      for (const s of this.shells) {
        if (!s.live) continue;
        const t = (now - s.t0) / s.dur;
        if (t > 1.2) {
          s.live = false;
          continue;
        }
        if (t < 0 || t > 1 || far) continue;
        sd.kind = s.kind;
        sd.x0 = ox + s.x0 * z;
        sd.y0 = oy + s.y0 * z;
        sd.x1 = ox + s.x1 * z;
        sd.y1 = oy + s.y1 * z;
        sd.t = t;
        sd.seed = s.seed;
        cannon.drawShell(ctx, sd, cm);
      }
      const ships = artFor('ships');
      const md = this.muzzleDraw;
      md.zoom = z;
      md.scale = g;
      md.dpr = dpr;
      for (const f of this.flashes) {
        if (!f.live) continue;
        const t = (now - f.t0) / f.dur;
        if (t > 1) {
          f.live = false;
          continue;
        }
        if (t < 0 || far) continue;
        let px = ox + f.x * z;
        let py = oy + f.y * z;
        const at = f.unit >= 0 && poses ? poses.screenOf(f.unit) : null;
        const h = f.unit >= 0 && poses ? poses.headingOf(f.unit) : null;
        if (at && h !== null) {
          const p = ships.turretPoint(f.key, 0, f.gun, at.x, at.y, h, g);
          px = p.x;
          py = p.y;
        }
        md.x = px;
        md.y = py;
        md.aim = Math.atan2(oy + f.ty * z - py, ox + f.tx * z - px);
        md.t = t;
        md.seed = (f.unit * 7 + f.gun) % 97 / 97;
        cannon.drawMuzzle(ctx, md, cm);
      }
      const blasts = artFor('explosions');
      const bm = motionFor('explosions');
      this.drawDeaths(ctx, cam, now, dpr, colors, blasts, bm, far, ox, oy, z, g);
      const bd = this.blastDraw;
      bd.zoom = z;
      bd.scale = g;
      bd.dpr = dpr;
      bd.reduced = this.reduced;
      for (const b of this.blasts) {
        if (!b.live) continue;
        const t = (now - b.t0) / b.dur;
        if (t > 1) {
          b.live = false;
          continue;
        }
        if (t < 0) continue;
        const sx = ox + b.x * z;
        const sy = oy + b.y * z;
        const reach = (b.kind === 'atom' ? Math.max(300, b.rt * z * 1.5) : 120) + 40;
        if (sx < -reach || sy < -reach || sx > cam.viewW + reach || sy > cam.viewH + reach) continue;
        if (far && b.kind !== 'missile' && b.kind !== 'atom') drawBlastFar(ctx, b, sx, sy, t);
        else {
          bd.kind = b.kind;
          bd.x = sx;
          bd.y = sy;
          bd.t = t;
          bd.ageMs = now - b.t0;
          bd.durMs = b.dur;
          bd.rt = b.rt;
          bd.seed = b.seed;
          blasts.draw(ctx, bd, bm);
        }
      }
    } catch {
      /* ignore */
    }
    ctx.globalAlpha = prevA;
    this.ms += performance.now() - t0;
  }

  private drawDeaths(ctx: CanvasRenderingContext2D, cam: FxCam, now: number, dpr: number, colors: readonly RGB[] | null, art: ExplosionArt, m: MotionParams, far: boolean, ox: number, oy: number, z: number, g: number): void {
    const dd = this.deathDraw;
    dd.zoom = z;
    dd.scale = g;
    dd.dpr = dpr;
    dd.reduced = this.reduced;
    for (const d of this.deaths) {
      if (!d.live) continue;
      const age = now - d.t0;
      if (age > d.dur) {
        d.live = false;
        continue;
      }
      if (age < 0) continue;
      const sx = ox + d.x * z;
      const sy = oy + d.y * z;
      const reach = Math.max(160, (DEATH_GLIDE_TILES + 2) * z);
      if (sx < -reach || sy < -reach || sx > cam.viewW + reach || sy > cam.viewH + reach) continue;
      if (far || !art.drawDeath) {
        // far out (or a style without death animations now): the far blink where it was hit, and where a plane came down
        if (age < FAR_DEATH_MS) drawBlastFar(ctx, FAR_HIT, sx, sy, age / FAR_DEATH_MS);
        const ia = age - d.impact;
        if (d.kind === 'plane' && ia >= 0 && ia < FAR_DEATH_MS) drawBlastFar(ctx, d.water ? FAR_SPLASH : FAR_HIT, sx + Math.cos(d.angle) * DEATH_GLIDE_TILES * z, sy + Math.sin(d.angle) * DEATH_GLIDE_TILES * z, ia / FAR_DEATH_MS);
        continue;
      }
      dd.kind = d.kind;
      dd.key = d.key;
      dd.mods = d.mods;
      dd.owner = colors?.[d.owner] ?? GREY;
      dd.x = sx;
      dd.y = sy;
      dd.angle = d.angle;
      dd.water = d.water;
      dd.t = age / d.dur;
      dd.ageMs = age;
      dd.durMs = d.dur;
      dd.seed = d.seed;
      art.drawDeath(ctx, dd, m);
      ctx.globalAlpha = 1;
    }
  }

  /** Live counts (tests, stats). */
  liveCounts(): { blasts: number; shells: number; flashes: number; craters: number; deaths: number } {
    return { blasts: this.blasts.filter((b) => b.live).length, shells: this.shells.filter((s) => s.live).length, flashes: this.flashes.filter((f) => f.live).length, craters: this.craters.length, deaths: this.deaths.filter((d) => d.live).length };
  }
}

/** The heading of a unit toward where it was going (when the unit layer has no drawn heading for it). */
function headingOf(state: GameState, u: Unit): number {
  const w = state.map.width;
  const dest = (u.type === 'bomber' || u.type === 'reconPlane') && u.state === 1 ? u.home : u.target;
  if (typeof dest !== 'number' || dest < 0 || w <= 0) return 0;
  const dx = (dest % w) + 0.5 - (u.x + 0.5);
  const dy = Math.floor(dest / w) + 0.5 - (u.y + 0.5);
  return dx * dx + dy * dy > 1e-6 ? Math.atan2(dy, dx) : 0;
}

const GREY: RGB = [128, 128, 128];
/** How long a death's far blink lasts (ms), and the blasts it blinks like. */
const FAR_DEATH_MS = 900;
const FAR_HIT = { kind: 'hit' } as Blast;
const FAR_SPLASH = { kind: 'splash' } as Blast;

/**
 * A small blast far out: a two-pixel blink in the same ramp (white, yellow, orange, red, smoke grey; a splash white
 * then foam), two fills at most, so a hundred of them across a continent cost next to nothing. Flak is not drawn.
 */
function drawBlastFar(ctx: CanvasRenderingContext2D, b: Blast, x: number, y: number, t: number): void {
  if (b.kind === 'flak') return;
  const big = b.kind === 'bomb' || b.kind === 'hit' ? 3 : 2;
  const X = Math.round(x) - (big >> 1);
  const Y = Math.round(y) - (big >> 1);
  if (b.kind === 'splash') ctx.fillStyle = t < 0.4 ? FOAM : FOAM_DIM;
  else ctx.fillStyle = t < 0.2 ? WHITE : t < 0.45 ? YELLOW : t < 0.7 ? ORANGE : t < 0.85 ? RED : SMOKE;
  ctx.globalAlpha = t < 0.85 ? 1 : 0.7;
  ctx.fillRect(X, Y, big, big);
  if (t >= 0.2 && t < 0.7 && b.kind !== 'splash') {
    // the hot core toward the light
    ctx.fillStyle = t < 0.45 ? WHITE : YELLOW;
    ctx.fillRect(X, Y, 1, 1);
  }
  ctx.globalAlpha = 1;
}

// ================================================================================================ craters

/**
 * Clips the canvas to the land tiles around a crater (its bitmap reaches about 1.8 radii, at least one tile). True
 * when a clip was set (call ctx.restore() after drawing); false when no land tile is there.
 */
function clipToLand(ctx: CanvasRenderingContext2D, T: ArrayLike<number>, w: number, h: number, c: Crater, ox: number, oy: number, z: number): boolean {
  const reach = Math.ceil(craterReach(c)) + 1;
  const cx = Math.floor(c.x);
  const cy = Math.floor(c.y);
  const xa = Math.max(0, cx - reach);
  const xb = Math.min(w - 1, cx + reach);
  let any = false;
  ctx.save();
  ctx.beginPath();
  // one rect per run of land tiles in a row (an atom bomb's blast zone spans thousands of tiles)
  for (let ty = Math.max(0, cy - reach); ty <= Math.min(h - 1, cy + reach); ty++) {
    const y0 = Math.round(oy + ty * z);
    const y1 = Math.round(oy + (ty + 1) * z);
    for (let tx = xa; tx <= xb; tx++) {
      if (T[ty * w + tx] <= 1) continue;
      let te = tx;
      while (te < xb && T[ty * w + te + 1] > 1) te++;
      const x0 = Math.round(ox + tx * z);
      ctx.rect(x0, y0, Math.round(ox + (te + 1) * z) - x0, y1 - y0);
      any = true;
      tx = te;
    }
  }
  if (!any) {
    ctx.restore();
    return false;
  }
  ctx.clip();
  return true;
}

/** How many guns of a ship variant fire in a salvo (tests). */
export function turretCount(variant: UnitVariant | undefined): number {
  if (variant === 'submarine' || variant === 'carrier') return 0;
  return SALVO[spriteKey('warship', variant)] ?? SALVO.warship;
}
