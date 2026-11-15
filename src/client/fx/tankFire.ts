// Tank divisions fighting (client only, read-only like the rest of fx/: it reads the sim state and never writes to
// it, so the sim, its hash and multiplayer are untouched). The sim has no gun shots for tanks: a division fights by
// being where it is. This reads that from the state and shows it:
//
//   attacking   a spearhead (Unit.state 3, tanks.ts) is fighting its way in: it fires at the enemy land ahead of its
//               head, along its line from the launch tile toward its target, often; a Breakthrough (Unit.blitz,
//               sim/blitz.ts) is a spearhead too and fires more often still (BLITZ_FIRE_MUL)
//   holding     a division not attacking that has land of a nation it is at war with (an attack running between the
//               two either way, or one lately: the sim's war memory) within TANK_DEFENSE_RADIUS, the reach of its
//               defence in the sim: it fires at the nearest such tile, less often
//
// Each division in a fight trains its turret on the enemy (UnitLayer.gunnery: the art draws the turret there), and once
// the turret is on target it fires now and then: the muzzle flash, a recoil jolt and gun smoke at the tank, a shell
// flying to the enemy side of the front and a small dirt burst, a spark or a splash where it lands. How often and how
// big comes from the gun (gunOf): light tanks small and quick, heavy and siege tanks big and slow, Armor Mastery's long
// gun a sharp flash. Each shot also goes on the tank shot bus (tankShotBus): sound/battle.ts plays the tank shot for it,
// so a flash comes with its bang.
//
// Fog of war: another nation's division fires only while this client sees it (FogView.unitShown), its sound too. Only
// divisions on screen or just off it are watched. Reduced motion: fewer shots, a still flash, no recoil, no traverse.
// Far out (below zoom FAR_FX_ZOOM) nothing is drawn; until the sprites show (SPRITE_ZOOM) only a faint blink. At most
// SHOTS_PER_FRAME new shots a frame and SHOT_CAP drawn at once, so a huge battle costs a fixed amount.
// Client randomness only (Math.random): every client sees its own shots.
import { TANK_DEFENSE_RADIUS, TICKS_PER_SECOND } from '../../sim/config';
import { areAllied } from '../../sim/diplomacy';
import type { GameState, Unit, UnitVariant } from '../../sim/types';
import type { FogView } from '../fog/fogView';
import { artFor, motionFor, styleModule } from '../art/registry';
import { M_MASTERY, M_PATH3, spriteKey, type SpriteKey } from '../art/shared/keys';
import type { TankGunArt, TankGunClass, TankShotDraw } from '../art/types';
import { unitSpriteMods } from '../render/pixelSprites';
import { spriteScale, SPRITE_ZOOM } from '../render/units';
import type { FxCam, UnitPoses } from './pixelFx';
import { fxEnabled, prefersReducedMotion } from './settings';

/** New shots a frame at most (the rest wait a moment), and shots drawn at once (the oldest gives way). */
export const SHOTS_PER_FRAME = 6;
export const SHOT_CAP = 40;
/** Below this zoom nothing is drawn (shells and flashes would be noise); until SPRITE_ZOOM a faint blink only. */
export const FAR_FX_ZOOM = 2;
/** Reduced motion: shots this many times further apart. */
export const REDUCED_FIRE_MUL = 2.5;
/** A Breakthrough's surge (Unit.blitz, sim/blitz.ts): shots this many times as far apart as a plain spearhead's. */
export const BLITZ_FIRE_MUL = 0.7;
/** How far ahead of a spearhead's head it looks for the enemy (tiles). */
const LOOK_AHEAD = 6;
/** The turret's traverse (radians per second of game time) and how close to the target it must be to fire. */
const TRAVERSE = 2.6;
const ON_TARGET = 0.3;
/** How long the recoil jolt lasts (ms). */
const RECOIL_MS = 170;
/** How long the far blink lasts (ms). */
const FAR_MS = 110;
/** Watched past the screen edge by this share of the view (sound is heard just off screen). */
const VIEW_MARGIN = 0.35;

// ------------------------------------------------------------------------------------------------- the guns

export interface GunSpec {
  gun: TankGunClass;
  /** Armor Mastery's long gun (a sharp flash) */
  sharp: boolean;
  /** flash, shell and burst size (1 = a medium tank's gun) */
  size: number;
  /** mean ms of game time between shots attacking and holding */
  attackMs: number;
  holdMs: number;
  /** shell speed (tiles per second) */
  speed: number;
  /** the tank shot sound's volume */
  volume: number;
}

const GUNS: Record<TankGunClass, Omit<GunSpec, 'sharp'>> = {
  light: { gun: 'light', size: 0.65, attackMs: 950, holdMs: 2300, speed: 34, volume: 0.7 },
  medium: { gun: 'medium', size: 1, attackMs: 1500, holdMs: 3400, speed: 28, volume: 0.85 },
  heavy: { gun: 'heavy', size: 1.35, attackMs: 2300, holdMs: 4800, speed: 24, volume: 1 },
  siege: { gun: 'siege', size: 1.6, attackMs: 3000, holdMs: 6000, speed: 13, volume: 1 },
};

/** The gun of a division by its arsenal variant and upgrades (art/shared/keys.ts M_* bits). */
export function gunOf(variant: UnitVariant | undefined, mods: number): GunSpec {
  const gun: TankGunClass = variant === 'lightTank' ? 'light' : variant === 'heavyTank' ? (mods & M_PATH3 ? 'siege' : 'heavy') : 'medium';
  const base = GUNS[gun];
  const sharp = gun !== 'siege' && (mods & M_MASTERY) !== 0;
  // the modern long gun: a little bigger and quicker to reload
  return sharp ? { ...base, sharp, size: base.size * 1.1, attackMs: base.attackMs * 0.9, holdMs: base.holdMs * 0.9 } : { ...base, sharp };
}

/**
 * Mean game ms between shots for a gun attacking or holding (reduced motion: REDUCED_FIRE_MUL times longer; a
 * Breakthrough's spearhead: BLITZ_FIRE_MUL times as long, so more often).
 */
export function fireInterval(g: GunSpec, attacking: boolean, reduced = false, blitz = false): number {
  return (attacking ? g.attackMs : g.holdMs) * (reduced ? REDUCED_FIRE_MUL : 1) * (attacking && blitz ? BLITZ_FIRE_MUL : 1);
}

/** The game ms to the next shot, for a random number r in [0, 1): 0.6 to 1.4 times the mean, so a line never fires in step. */
export function nextShotIn(g: GunSpec, attacking: boolean, reduced: boolean, r: number, blitz = false): number {
  return fireInterval(g, attacking, reduced, blitz) * (0.6 + 0.8 * r);
}

/** How the fire is drawn at zoom z: not at all, a faint blink, or in full. */
export function tankFxLevel(z: number): 'none' | 'faint' | 'full' {
  return z < FAR_FX_ZOOM ? 'none' : z < SPRITE_ZOOM ? 'faint' : 'full';
}

// ------------------------------------------------------------------------------------------------- the fight

/**
 * Who fights whom (key a * 4096 + b, both ways): nations with an attack running between them, or one in the last
 * NAVY_WAR_MEMORY seconds (state.warMemory, as the sim's own "at war"), never allies.
 */
export function warPairs(state: GameState): Set<number> {
  const s = new Set<number>();
  const add = (a: number, b: number): void => {
    if (a <= 0 || b <= 0 || a === b || areAllied(state, a, b)) return;
    s.add(a * 4096 + b);
    s.add(b * 4096 + a);
  };
  for (const a of state.attacks) add(a.attacker, a.target);
  const wm = state.warMemory;
  if (wm) for (let k = 0; k + 2 < wm.length; k += 3) if (wm[k + 2] > state.tick) add(wm[k], wm[k + 1]);
  return s;
}

/** A division's fight: whether it attacks, and the enemy point it fires at (tile coordinates, a tile's centre). */
export interface Engagement {
  attacking: boolean;
  x: number;
  y: number;
  /** the enemy it fights */
  foe: number;
  /** a Breakthrough's spearhead (Unit.blitz, sim/blitz.ts): it fires more often */
  blitz: boolean;
}

/** The fight division `u` is in, or null (read-only). `pairs` from warPairs. */
export function engagementOf(state: GameState, u: Unit, pairs: ReadonlySet<number>): Engagement | null {
  if (u.type !== 'tankDivision' || u.hp <= 0) return null;
  const map = state.map;
  const w = map.width;
  const h = map.height;
  const own = u.owner;
  if (u.state === 3) {
    // a spearhead: the first enemy land ahead of its head along its line
    const lt = u.launch ?? Math.round(u.y) * w + Math.round(u.x);
    const lx = lt % w;
    const ly = (lt / w) | 0;
    let dx = (u.target % w) - lx;
    let dy = ((u.target / w) | 0) - ly;
    const len = Math.hypot(dx, dy);
    if (len < 1e-6) return null;
    dx /= len;
    dy /= len;
    for (let d = 1; d <= LOOK_AHEAD; d++) {
      const x = Math.round(u.x + dx * d);
      const y = Math.round(u.y + dy * d);
      if (x < 0 || y < 0 || x >= w || y >= h) return null;
      const t = y * w + x;
      const o = map.owner[t];
      if (o > 0 && o !== own && map.terrain[t] > 1) return { attacking: true, x: x + 0.5, y: y + 0.5, foe: o, blitz: !!u.blitz };
    }
    return null;
  }
  if (!pairs.size) return null;
  // holding (or driving): the nearest land of a nation it is at war with, within its defence's reach
  const R = TANK_DEFENSE_RADIUS;
  const cx = Math.round(u.x);
  const cy = Math.round(u.y);
  let best = -1;
  let bd = R * R + 0.5;
  let foe = 0;
  for (let y = Math.max(0, cy - R); y <= Math.min(h - 1, cy + R); y++) {
    for (let x = Math.max(0, cx - R); x <= Math.min(w - 1, cx + R); x++) {
      const d = (x - cx) * (x - cx) + (y - cy) * (y - cy);
      if (d >= bd) continue;
      const t = y * w + x;
      const o = map.owner[t];
      if (o <= 0 || o === own || map.terrain[t] <= 1 || !pairs.has(own * 4096 + o)) continue;
      bd = d;
      best = t;
      foe = o;
    }
  }
  return best < 0 ? null : { attacking: false, x: (best % w) + 0.5, y: ((best / w) | 0) + 0.5, foe, blitz: false };
}

/** What of the fog the shots need. */
export type FogLike = Pick<FogView, 'active' | 'unitShown'>;

/** May this client see division u fire: its own always, another's only while it sees the division (fog of war). */
export function fireSeen(fog: FogLike | null, state: GameState, u: Unit): boolean {
  if (!fog || !fog.active) return true;
  return fog.unitShown(state, u);
}

// ------------------------------------------------------------------------------------------------- the sound bus

/** A tank shot for the sound (tile coordinates of the tank). */
export interface TankShotCue {
  state: GameState;
  x: number;
  y: number;
  volume: number;
}
const BUS_CAP = 32;

/** The shots fired since the sound last looked (sound/battle.ts drains it every frame). */
export class TankShotBus {
  private q: TankShotCue[] = [];
  push(c: TankShotCue): void {
    if (this.q.length >= BUS_CAP) this.q.shift();
    this.q.push(c);
  }
  /** Hands over the shots of game `state` (others are dropped: the menu's background game) and empties the bus. */
  drain(state: GameState, take: (c: TankShotCue) => void): void {
    for (const c of this.q) if (c.state === state) take(c);
    this.q.length = 0;
  }
  clear(): void {
    this.q.length = 0;
  }
  get size(): number {
    return this.q.length;
  }
}
export const tankShotBus = new TankShotBus();

// ------------------------------------------------------------------------------------------------- the layer

interface Gunner {
  id: number;
  key: SpriteKey;
  mods: number;
  spec: GunSpec;
  engaged: boolean;
  attacking: boolean;
  /** a Breakthrough's spearhead: fires more often (BLITZ_FIRE_MUL) */
  blitz: boolean;
  /** the enemy point and the tank (tile coordinates of their centres) */
  ex: number;
  ey: number;
  ux: number;
  uy: number;
  /** the turret's heading (radians, on screen) */
  aim: number;
  /** game ms of its next shot, and the clock (ms) of its last */
  nextAt: number;
  firedAt: number;
  scan: number;
}

interface Shot {
  live: boolean;
  unit: number;
  key: SpriteKey;
  mods: number;
  spec: GunSpec;
  /** the muzzle when it fired and where the shell lands (tile coordinates) */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  aim: number;
  t0: number;
  flight: number;
  dur: number;
  water: boolean;
  spark: boolean;
  seed: number;
}

const wrap = (a: number): number => {
  let d = a % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
};

export class TankFire {
  /** ms spent last frame (renderer stats) */
  ms = 0;
  /** shots fired (seen) since the game began, and shots drawn (tests, stats) */
  fired = 0;
  drawnShots = 0;
  fog: FogView | null = null;
  readonly shots: Shot[] = [];
  private gunners = new Map<number, Gunner>();
  private state: GameState | null = null;
  private lastTick = -1;
  private lastGame = -1;
  private scanNo = 0;
  /** the screen's device px per CSS px (last draw) */
  private dpr = 1;
  /** a test's pick (setReduced); null = the Settings pick, read live (Reduce motion: Auto follows the device) */
  private reducedPick: boolean | null = null;
  private get reduced(): boolean {
    return this.reducedPick ?? prefersReducedMotion();
  }
  private draw0: TankShotDraw = { gun: 'medium', sharp: false, size: 1, x0: 0, y0: 0, x1: 0, y1: 0, aim: 0, ageMs: 0, flightMs: 1, water: false, spark: false, zoom: 1, scale: 1, seed: 0, dpr: 1 };

  constructor(
    private rand: () => number = Math.random,
    private bus: TankShotBus = tankShotBus,
  ) {
    for (let i = 0; i < SHOT_CAP; i++) this.shots.push({ live: false, unit: -1, key: 'tankDivision', mods: 0, spec: GUNS.medium as GunSpec, x0: 0, y0: 0, x1: 0, y1: 0, aim: 0, t0: 0, flight: 1, dur: 1, water: false, spark: false, seed: 0 });
  }

  /** Reduced motion on or off (tests; the page follows the Settings pick live). */
  setReduced(on: boolean): void {
    this.reducedPick = on;
  }

  /** The turret heading of division `id` while it fights (or swings back after), or null: it looks along the hull. */
  aimOf(id: number): number | null {
    const g = this.gunners.get(id);
    return g ? g.aim : null;
  }

  /** How hard division `id`'s gun is recoiling at `nowMs`: 1 as it fires, down to 0 within RECOIL_MS. */
  recoilOf(id: number, nowMs: number): number {
    const g = this.gunners.get(id);
    if (!g || this.reduced) return 0;
    const k = (nowMs - g.firedAt) / RECOIL_MS;
    return k >= 0 && k < 1 ? (1 - k) * (1 - k) : 0;
  }

  /** Divisions in a fight now (tests, stats). */
  get fighting(): number {
    let n = 0;
    for (const g of this.gunners.values()) if (g.engaged) n++;
    return n;
  }

  private reset(state: GameState): void {
    this.state = state;
    this.gunners.clear();
    this.lastTick = -1;
    this.lastGame = -1;
    for (const s of this.shots) s.live = false;
  }

  /**
   * Once per frame before the units are drawn: reads who fights (once per new tick), turns the turrets and fires.
   * `gameMs` = the game clock in ms ((tick + fraction) * 100: it stands still while paused, runs faster at speed),
   * `nowMs` the frame clock the shots are drawn on, `poses` the unit layer (where each tank was drawn last frame).
   */
  update(state: GameState, cam: FxCam, nowMs: number, gameMs: number, poses: UnitPoses | null): void {
    const t0 = performance.now();
    try {
      if (state !== this.state) this.reset(state);
      if (state.tick !== this.lastTick) {
        this.lastTick = state.tick;
        this.scan(state, cam);
      }
      const dt = this.lastGame < 0 ? 0 : Math.max(0, Math.min(250, gameMs - this.lastGame));
      this.lastGame = gameMs;
      this.step(state, cam, nowMs, gameMs, dt, poses);
    } catch {
      /* never break the frame */
    } finally {
      this.ms = performance.now() - t0;
    }
  }

  /** Who fights, for the divisions on screen and just off it. */
  private scan(state: GameState, cam: FxCam): void {
    const no = ++this.scanNo;
    const z = Math.max(1e-6, cam.zoom);
    const hw = (cam.viewW / z / 2) * (1 + VIEW_MARGIN * 2);
    const hh = (cam.viewH / z / 2) * (1 + VIEW_MARGIN * 2);
    const pairs = warPairs(state);
    const fog = this.fog?.active ? this.fog : null;
    for (const u of state.units) {
      if (u.type !== 'tankDivision' || u.hp <= 0) continue;
      if (Math.abs(u.x + 0.5 - cam.x) > hw + 2 || Math.abs(u.y + 0.5 - cam.y) > hh + 2) continue;
      if (!fireSeen(fog, state, u)) continue;
      const e = engagementOf(state, u, pairs);
      let g = this.gunners.get(u.id);
      if (!e) {
        if (g) {
          g.engaged = false;
          g.scan = no;
        }
        continue;
      }
      const ux = u.x + 0.5;
      const uy = u.y + 0.5;
      if (!g) {
        const mods = unitSpriteMods(state, u);
        const spec = gunOf(u.variant, mods);
        // the turret starts along the hull (its heading is read on the next step) and swings round to the enemy
        g = { id: u.id, key: spriteKey(u.type, u.variant), mods, spec, engaged: true, attacking: e.attacking, blitz: e.blitz, ex: e.x, ey: e.y, ux, uy, aim: NaN, nextAt: -1, firedAt: -Infinity, scan: no };
        this.gunners.set(u.id, g);
      }
      if (!g.engaged || g.attacking !== e.attacking) g.nextAt = -1; // a new fight: its first shot comes after a while
      g.engaged = true;
      g.attacking = e.attacking;
      g.blitz = e.blitz;
      g.ex = e.x;
      g.ey = e.y;
      g.ux = ux;
      g.uy = uy;
      g.scan = no;
    }
    // divisions gone, out of view or out of sight: forgotten (their turrets look along the hull again)
    for (const [id, g] of this.gunners) if (g.scan !== no) this.gunners.delete(id);
  }

  private step(state: GameState, cam: FxCam, nowMs: number, gameMs: number, dt: number, poses: UnitPoses | null): void {
    let started = 0;
    const turn = TRAVERSE * (dt / 1000);
    for (const [id, g] of this.gunners) {
      const hull = poses?.angleOf?.(id) ?? null;
      const want = g.engaged ? Math.atan2(g.ey - g.uy, g.ex - g.ux) : (hull ?? g.aim);
      if (Number.isNaN(g.aim)) g.aim = hull ?? want;
      const d = wrap(want - g.aim);
      if (this.reduced) g.aim = want;
      else g.aim = wrap(g.aim + Math.max(-turn, Math.min(turn, d)));
      if (!g.engaged) {
        // back along the hull: no longer this layer's turret
        if (Math.abs(wrap(want - g.aim)) < 0.03 && nowMs - g.firedAt > RECOIL_MS) this.gunners.delete(id);
        continue;
      }
      if (g.nextAt < 0) g.nextAt = gameMs + nextShotIn(g.spec, g.attacking, this.reduced, this.rand(), g.blitz) * (0.2 + 0.6 * this.rand());
      if (gameMs < g.nextAt) continue;
      // the turret must be on target first
      if (Math.abs(wrap(want - g.aim)) > ON_TARGET) continue;
      if (started >= SHOTS_PER_FRAME) {
        g.nextAt = gameMs + 60 + this.rand() * 240;
        continue;
      }
      started++;
      g.nextAt = gameMs + nextShotIn(g.spec, g.attacking, this.reduced, this.rand(), g.blitz);
      this.fire(state, cam, g, nowMs, poses);
    }
  }

  private fire(state: GameState, cam: FxCam, g: Gunner, nowMs: number, poses: UnitPoses | null): void {
    g.firedAt = nowMs;
    this.fired++;
    this.bus.push({ state, x: g.ux, y: g.uy, volume: g.spec.volume });
    // where it lands: on the enemy side, a little past the enemy point and to either side of the line
    const bx = g.ex - g.ux;
    const by = g.ey - g.uy;
    const bl = Math.hypot(bx, by) || 1;
    const fx = bx / bl;
    const fy = by / bl;
    const deeper = g.attacking ? 0.5 + this.rand() * 2.5 : 0.6 + this.rand() * 2;
    const side = (this.rand() - 0.5) * (g.attacking ? 1.6 : 1.8);
    const w = state.map.width;
    const h = state.map.height;
    const x1 = Math.max(0.2, Math.min(w - 0.2, g.ex + fx * deeper - fy * side));
    const y1 = Math.max(0.2, Math.min(h - 0.2, g.ey + fy * deeper + fx * side));
    // the shell is drawn only where the tank is drawn, close enough in, with the effects on
    const z = cam.zoom;
    if (tankFxLevel(z) === 'none' || !fxEnabled()) return;
    const at = poses?.screenOf(g.id) ?? null;
    if (!at) return;
    const ox = cam.viewW / 2 - cam.x * z;
    const oy = cam.viewH / 2 - cam.y * z;
    const mz = this.muzzle(g.key, g.mods, at.x, at.y, poses?.angleOf?.(g.id) ?? g.aim, g.aim, spriteScale(z), this.dpr);
    const slot = this.slot(nowMs);
    const tx = Math.floor(x1);
    const ty = Math.floor(y1);
    const water = state.map.terrain[Math.max(0, Math.min(h - 1, ty)) * w + Math.max(0, Math.min(w - 1, tx))] <= 1;
    const x0 = (mz.x - ox) / z;
    const y0 = (mz.y - oy) / z;
    const flight = 50 + (Math.hypot(x1 - x0, y1 - y0) / g.spec.speed) * 1000;
    slot.live = true;
    slot.unit = g.id;
    slot.key = g.key;
    slot.mods = g.mods;
    slot.spec = g.spec;
    slot.x0 = x0;
    slot.y0 = y0;
    slot.x1 = x1;
    slot.y1 = y1;
    slot.aim = g.aim;
    slot.t0 = nowMs;
    slot.flight = flight;
    slot.water = water;
    slot.spark = !water && this.rand() < 0.25;
    slot.seed = this.rand();
    slot.dur = Math.max(1, this.art().shotMs({ gun: g.spec.gun, flightMs: flight }, motionFor('cannonFire')));
  }

  /** A free shot, or the oldest (the cap). */
  private slot(nowMs: number): Shot {
    let oldest = this.shots[0];
    for (const s of this.shots) {
      if (!s.live || nowMs - s.t0 > s.dur) return s;
      if (s.t0 < oldest.t0) oldest = s;
    }
    return oldest;
  }

  private art(): TankGunArt {
    return artFor('cannonFire').tank ?? styleModule('detailed').cannonFire.tank!;
  }

  private muzzle(key: SpriteKey, mods: number, x: number, y: number, angle: number, aim: number, scale: number, dpr: number): { x: number; y: number } {
    const land = artFor('land');
    if (land.muzzlePoint) return land.muzzlePoint(key, mods, x, y, angle, aim, scale, dpr);
    const r = land.lengthPx(key, mods, scale) * 0.5;
    return { x: x + Math.cos(aim) * r, y: y + Math.sin(aim) * r };
  }

  /** Live shots (tests, stats). */
  liveShots(nowMs: number): number {
    let n = 0;
    for (const s of this.shots) if (s.live && nowMs - s.t0 <= s.dur) n++;
    return n;
  }

  /** The shots, over the units (overlay canvas in CSS px). */
  draw(ctx: CanvasRenderingContext2D, cam: FxCam, nowMs: number, poses: UnitPoses | null, dpr = 1): void {
    this.drawnShots = 0;
    this.dpr = dpr;
    if (!fxEnabled()) return;
    const t0 = performance.now();
    const z = cam.zoom;
    const level = tankFxLevel(z);
    const prevA = ctx.globalAlpha;
    try {
      if (level === 'none') return;
      const art = this.art();
      const m = motionFor('cannonFire');
      const ox = cam.viewW / 2 - cam.x * z;
      const oy = cam.viewH / 2 - cam.y * z;
      const scale = spriteScale(z);
      const d = this.draw0;
      d.zoom = z;
      d.scale = scale;
      d.dpr = dpr;
      for (const s of this.shots) {
        if (!s.live) continue;
        const age = nowMs - s.t0;
        if (age > s.dur || age < -1000) {
          s.live = false;
          continue;
        }
        if (age < 0) continue;
        // the muzzle rides with its tank; the shell flies from where it fired
        const at = poses?.screenOf(s.unit) ?? null;
        const aim = this.aimOf(s.unit) ?? s.aim;
        const sx0 = ox + s.x0 * z;
        const sy0 = oy + s.y0 * z;
        const sx1 = ox + s.x1 * z;
        const sy1 = oy + s.y1 * z;
        const reach = 80 + Math.abs(sx1 - sx0) + Math.abs(sy1 - sy0);
        if (Math.max(sx0, sx1) < -reach || Math.min(sx0, sx1) > cam.viewW + reach || Math.max(sy0, sy1) < -reach || Math.min(sy0, sy1) > cam.viewH + reach) continue;
        if (level === 'faint') {
          if (age < FAR_MS) art.drawFar(ctx, at ? at.x + Math.cos(aim) * 4 : sx0, at ? at.y + Math.sin(aim) * 4 : sy0, age / FAR_MS, s.spec.size);
          this.drawnShots++;
          continue;
        }
        const mz = at ? this.muzzle(s.key, s.mods, at.x, at.y, poses?.angleOf?.(s.unit) ?? aim, aim, scale, dpr) : { x: sx0, y: sy0 };
        d.gun = s.spec.gun;
        d.sharp = s.spec.sharp;
        d.size = s.spec.size;
        d.x0 = sx0;
        d.y0 = sy0;
        d.x1 = sx1;
        d.y1 = sy1;
        d.aim = Math.atan2(sy1 - sy0, sx1 - sx0);
        d.ageMs = age;
        d.flightMs = s.flight;
        d.water = s.water;
        d.spark = s.spark;
        d.seed = s.seed;
        art.drawShell(ctx, d, m);
        d.x0 = mz.x;
        d.y0 = mz.y;
        d.aim = aim;
        art.drawFlash(ctx, d, m);
        this.drawnShots++;
      }
    } catch {
      /* ignore */
    } finally {
      ctx.globalAlpha = prevA;
      this.ms += performance.now() - t0;
    }
  }
}

/** The game clock (ms) at tick + fraction, for TankFire.update. */
export function gameClockMs(tick: number, frac: number): number {
  return ((tick + frac) * 1000) / TICKS_PER_SECOND;
}
