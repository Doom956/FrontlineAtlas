// Where the turning guns of the Defense row point and when they fire (client only, read-only like the rest of fx/: it
// reads the sim state and never writes to it, so the sim, its hash and multiplayer are untouched). The art is
// art/detailed/guns.ts (the heads) and render/gunLayer.ts (draws them over the cached building sprite).
//
// Targets, as the client knows them:
//   flak pit      the nearest plane under fire in the pit's zone: fx/defenseFx.ts walks the planes inside hostile flak
//                 zones (sim/defense.flakZonesAt) and tells every zone's building about the plane (aimAt); the pit
//                 flashes together with the flak bursts it throws round the plane (flakFire)
//   coastal gun   the nearest hostile ship inside its range (scanBatteries, the sim's own picking in short), and the
//                 ship of every 'battery' shot the sim reports (fire), so the gun is already turned when the shell leaves
// Without a target a head swings back to its idle pose (flak: skyward, up and right; coastal: out to sea).
//
// Fog of war: only planes and ships this client sees (FogView.unitShown) and buildings in view are tracked. Zoom: the
// guns exist from ART_ZOOM (the building art); the flash and smoke are the tank gun's (art tank.drawFlash, TankFire's
// level 'full'). Reduced motion: the head snaps to its target, no recoil, a still flash, flak flashes further apart.
// Effects off (Settings): nothing is tracked, the heads stay idle. Caps: FLASH_CAP flashes at once.
// Client randomness only: none, flashes are seeded by a counter.
import { atWar } from '../../sim/naval2';
import { batteryRange, batterySites, batteryWorking } from '../../sim/defense';
import { unitVisibleTo } from '../../sim/techtree';
import type { GameState, Unit } from '../../sim/types';
import { artFor, motionFor, styleModule } from '../art/registry';
import { FORE } from '../art/detailed/bake';
import { GUN_FACINGS, type GunKind } from '../art/detailed/guns';
import type { TankGunArt, TankShotDraw } from '../art/types';
import type { Camera } from '../camera';
import type { FogView } from '../fog/fogView';
import { artScale } from '../render/buildingArt';
import { fxEnabled, prefersReducedMotion } from './settings';
import { tankFxLevel } from './tankFire';

/** How fast a head turns (radians a second): the flak mount quick, the naval turret slow and heavy. */
export const TRAVERSE: Record<GunKind, number> = { flak: 3.6, coastal: 1.3 };
/** A head stays on its last target this long (ms) before it swings back to its idle pose. */
export const AIM_HOLD_MS = 1500;
/** Flak pits flash this far apart at least (ms); reduced motion x REDUCED_MUL. */
export const FLAK_FLASH_GAP_MS = 300;
export const REDUCED_MUL = 2.5;
/** How long a head recoils (ms) and how far it slides back along its barrel (model units). */
export const RECOIL_MS: Record<GunKind, number> = { flak: 110, coastal: 300 };
export const RECOIL_BACK: Record<GunKind, number> = { flak: 1.0, coastal: 2.6 };
/** Flashes drawn at once at most. */
export const FLASH_CAP = 24;
/** Ships are looked for at most this often (ms of the frame clock). */
const SCAN_EVERY_MS = 250;
/** A fire request older than this is dropped unrendered (the building was off screen). */
const STALE_MS = 400;

// ------------------------------------------------------------------------------------------------- pure aim maths

/** The angle on screen (radians, clockwise from east; tile space is screen space) from a mount to its target. */
export const aimAngle = (mx: number, my: number, tx: number, ty: number): number => Math.atan2(ty - my, tx - mx);

/** The model heading of a screen angle: the models are foreshortened by FORE across the map, so a screen angle maps to atan2(sin / FORE, cos). */
export const modelHeading = (a: number): number => Math.atan2(Math.sin(a) / FORE, Math.cos(a));

/** The model heading a baked facing stands for. */
export const facingHeading = (f: number, n = GUN_FACINGS): number => (f * Math.PI * 2) / n;

/** The baked facing (0..n - 1) nearest to a screen angle. */
export function quantFacing(a: number, n = GUN_FACINGS): number {
  const th = modelHeading(a);
  return ((Math.round((th / (Math.PI * 2)) * n) % n) + n) % n;
}

/** The shortest signed turn from `a` to `b` (-PI..PI). */
export function wrapAngle(d: number): number {
  let r = d % (Math.PI * 2);
  if (r > Math.PI) r -= Math.PI * 2;
  if (r < -Math.PI) r += Math.PI * 2;
  return r;
}

/** `cur` turned toward `want` by at most `maxStep` radians, the short way round. */
export function turnToward(cur: number, want: number, maxStep: number): number {
  const d = wrapAngle(want - cur);
  return Math.abs(d) <= maxStep ? want : cur + Math.sign(d) * maxStep;
}

/** The idle pose (screen angle): a flak gun looks up and to the right at the sky, a coastal gun out to sea (`sea` = the direction of the sea in screen radians). */
export const idleAngle = (kind: GunKind, sea = 0): number => (kind === 'flak' ? -Math.PI * 0.3 : sea);

// ------------------------------------------------------------------------------------------------- the tracker

interface Track {
  kind: GunKind;
  /** the target, tile coordinates of its centre */
  tx: number;
  ty: number;
  /** frame clock (ms) the target was last seen; -Infinity = never */
  seenAt: number;
  /** a ship being followed (coastal guns): its position is read every frame */
  unit: Unit | null;
  scanAt: number;
  /** per mount: the heading now (screen radians, NaN = not yet placed), the frame clock of its last update and of its last shot */
  angle: number[];
  stamp: number[];
  firedAt: number[];
  /** this frame's nearest candidate (flak), see aimAt */
  frame: number;
  near: number;
  /** the pending shot: frame clock, which mount (-1 = all) and whether it has been drawn */
  fireAt: number;
  fireMount: number;
  fireDone: boolean;
  /** last flash of a flak pit, and the shots a coastal site fired (they take turns) */
  flashAt: number;
  shots: number;
}

export interface Flash {
  live: boolean;
  /** muzzle, tile coordinates; direction of fire (screen radians) */
  x: number;
  y: number;
  aim: number;
  t0: number;
  kind: GunKind;
  seed: number;
}

export class GunAim {
  fog: FogView | null = null;
  private tracks = new Map<number, Track>();
  private muzzles = new Map<number, { x: number; y: number; at: number }>();
  readonly flashes: Flash[] = [];
  private lastScan = -1e9;
  private seed = 1;
  private reducedPick: boolean | null = null;
  /** flashes drawn last frame (tests, stats) */
  drawnFlashes = 0;

  constructor() {
    for (let i = 0; i < FLASH_CAP; i++) this.flashes.push({ live: false, x: 0, y: 0, aim: 0, t0: 0, kind: 'flak', seed: 0 });
  }

  /** Reduced motion on or off (tests; the page follows the Settings pick live). */
  setReduced(on: boolean | null): void {
    this.reducedPick = on;
  }
  get reduced(): boolean {
    return this.reducedPick ?? prefersReducedMotion();
  }

  private track(tile: number, kind: GunKind): Track {
    let t = this.tracks.get(tile);
    if (!t) {
      t = { kind, tx: 0, ty: 0, seenAt: -Infinity, unit: null, scanAt: -Infinity, angle: [NaN, NaN], stamp: [0, 0], firedAt: [-1e9, -1e9], frame: -1, near: Infinity, fireAt: -1e9, fireMount: -1, fireDone: true, flashAt: -1e9, shots: 0 };
      this.tracks.set(tile, t);
      if (this.tracks.size > 400) {
        const first = this.tracks.keys().next().value;
        if (first !== undefined && first !== tile) this.tracks.delete(first);
      }
    }
    return t;
  }

  /** The tile a gun of the building at `tile` aims at now, or null (tests). */
  targetOf(tile: number, nowMs: number): { x: number; y: number } | null {
    const t = this.tracks.get(tile);
    return t && nowMs - t.seenAt < AIM_HOLD_MS ? { x: t.tx, y: t.ty } : null;
  }

  /**
   * A flak site's building (at `tile`) has a plane at tile (x, y) under fire: the pit trains on the nearest one (several
   * planes in one frame: the nearest to the pit wins). Once per plane and zone each frame.
   */
  aimAt(tile: number, kind: GunKind, bx: number, by: number, x: number, y: number, nowMs: number): void {
    const t = this.track(tile, kind);
    const d = (x - bx) * (x - bx) + (y - by) * (y - by);
    if (t.frame !== nowMs) {
      t.frame = nowMs;
      t.near = Infinity;
    }
    if (d >= t.near) return;
    t.near = d;
    t.tx = x;
    t.ty = y;
    t.seenAt = nowMs;
    t.unit = null;
  }

  /** The flak pit at `tile` fires with the bursts round its plane: both guns flash (at most every FLAK_FLASH_GAP_MS). */
  flakFire(tile: number, nowMs: number): void {
    const t = this.tracks.get(tile);
    if (!t) return;
    const gap = FLAK_FLASH_GAP_MS * (this.reduced ? REDUCED_MUL : 1);
    if (nowMs - t.flashAt < gap) return;
    t.flashAt = nowMs;
    t.fireAt = nowMs;
    t.fireMount = -1;
    t.fireDone = false;
  }

  /** A coastal battery at `tile` fired at the ship at (x, y): the gun turns to it and one of the two guns shoots (they take turns). */
  fireCoastal(tile: number, x: number, y: number, nowMs: number): void {
    const t = this.track(tile, 'coastal');
    t.tx = x;
    t.ty = y;
    t.seenAt = nowMs;
    t.fireAt = nowMs;
    t.fireMount = t.shots++ % 2;
    t.fireDone = false;
  }

  /**
   * Looks for the ship every working coastal battery in view would shell (the nearest hostile warship or transport in
   * range it can see), and follows ships already picked. Every SCAN_EVERY_MS. Fog of war: only buildings and ships in view.
   */
  update(state: GameState, cam: Camera, nowMs: number): void {
    if (!fxEnabled() || cam.zoom < 8) return;
    for (const t of this.tracks.values()) {
      if (t.unit && nowMs - t.scanAt < SCAN_EVERY_MS * 2.5 && t.unit.hp > 0) {
        t.tx = t.unit.x + 0.5;
        t.ty = t.unit.y + 0.5;
        t.seenAt = nowMs;
      } else t.unit = null;
    }
    if (nowMs - this.lastScan < SCAN_EVERY_MS) return;
    this.lastScan = nowMs;
    const sites = batterySites(state);
    if (!sites.length) return;
    const w = state.map.width;
    const view = cam.visibleTiles(3);
    const fog = this.fog?.active ? this.fog : null;
    let ships: Unit[] | null = null;
    for (const b of sites) {
      const bx = b.tile % w;
      const by = (b.tile / w) | 0;
      if (bx < view.x0 || by < view.y0 || bx > view.x1 || by > view.y1 || !batteryWorking(state, b) || (fog && !fog.visible(b.tile))) continue;
      ships ??= state.units.filter((u) => u.hp > 0 && (u.type === 'warship' || u.type === 'transport'));
      const r = batteryRange(b);
      let best: Unit | null = null;
      let bestD = r * r;
      for (const s of ships) {
        if (s.owner === b.owner) continue;
        const dx = s.x - bx;
        const dy = s.y - by;
        const d = dx * dx + dy * dy;
        if (d > bestD || !atWar(state, b.owner, s.owner) || !unitVisibleTo(state, b.owner, s) || (fog && !fog.unitShown(state, s))) continue;
        best = s;
        bestD = d;
      }
      if (!best) continue;
      const t = this.track(b.tile, 'coastal');
      t.unit = best;
      t.scanAt = nowMs;
      t.tx = best.x + 0.5;
      t.ty = best.y + 0.5;
      t.seenAt = nowMs;
    }
  }

  /**
   * The heading (screen radians) of mount `i` of the building at `tile` standing at tile (mx, my), moved toward its
   * target (or its idle pose) by the traverse since the last call. Reduced motion: straight to it.
   */
  headingOf(tile: number, kind: GunKind, i: number, mx: number, my: number, idle: number, nowMs: number): number {
    const t = this.tracks.get(tile);
    if (!t) return idle;
    const aiming = nowMs - t.seenAt < AIM_HOLD_MS;
    const want = aiming ? aimAngle(mx, my, t.tx, t.ty) : idle;
    let cur = t.angle[i];
    if (Number.isNaN(cur)) cur = idle;
    const dt = Math.max(0, Math.min(100, nowMs - (t.stamp[i] || nowMs)));
    t.stamp[i] = nowMs;
    cur = this.reduced ? want : turnToward(cur, want, (TRAVERSE[kind] * dt) / 1000);
    t.angle[i] = cur;
    return cur;
  }

  /** How hard mount `i` of the building at `tile` is recoiling (1 as it fires, down to 0): the head slides back by RECOIL_BACK x this. */
  recoilOf(tile: number, kind: GunKind, i: number, nowMs: number): number {
    const t = this.tracks.get(tile);
    if (!t || this.reduced) return 0;
    const k = (nowMs - t.firedAt[i]) / RECOIL_MS[kind];
    return k >= 0 && k < 1 ? (1 - k) * (1 - k) : 0;
  }

  /** True if a shot of the building at `tile` waits to be drawn for mount `i` (and it marks it drawn once every mount asked). */
  takeShot(tile: number, i: number, mounts: number, nowMs: number): boolean {
    const t = this.tracks.get(tile);
    if (!t || t.fireDone) return false;
    if (nowMs - t.fireAt > STALE_MS) {
      t.fireDone = true;
      return false;
    }
    const mine = t.fireMount < 0 || t.fireMount === i;
    if (mine) t.firedAt[i] = t.fireAt;
    if (i === mounts - 1) t.fireDone = true;
    return mine;
  }

  /** A flash at a muzzle (tile coordinates), aimed along `aim`; remembers the muzzle for the shell (muzzleOf). */
  addFlash(tile: number, kind: GunKind, x: number, y: number, aim: number, nowMs: number): void {
    let f = this.flashes.find((q) => !q.live);
    if (!f) f = this.flashes.reduce((a, b) => (a.t0 < b.t0 ? a : b));
    f.live = true;
    f.x = x;
    f.y = y;
    f.aim = aim;
    f.t0 = nowMs;
    f.kind = kind;
    f.seed = this.seed++;
    this.muzzles.set(tile, { x, y, at: nowMs });
  }

  /** Where the last shot of the building at `tile` left its muzzle (tile coordinates), if lately. */
  muzzleOf(tile: number, nowMs: number): { x: number; y: number } | null {
    const m = this.muzzles.get(tile);
    return m && nowMs - m.at < 1500 ? m : null;
  }

  private art(): TankGunArt {
    return artFor('cannonFire').tank ?? styleModule('detailed').cannonFire.tank!;
  }

  /** The muzzle flashes and gun smoke, over the units: the tank gun's own flash (art tank.drawFlash). */
  draw(ctx: CanvasRenderingContext2D, cam: Camera, nowMs: number, dpr: number): void {
    this.drawnFlashes = 0;
    if (!fxEnabled() || tankFxLevel(cam.zoom) !== 'full') return;
    const prev = ctx.globalAlpha;
    try {
      const art = this.art();
      const m = motionFor('cannonFire');
      const z = cam.zoom;
      const ox = cam.viewW / 2 - cam.x * z;
      const oy = cam.viewH / 2 - cam.y * z;
      const d: TankShotDraw = { gun: 'light', sharp: false, size: 1, x0: 0, y0: 0, x1: 0, y1: 0, aim: 0, ageMs: 0, flightMs: 1, water: false, spark: false, zoom: z, scale: artScale(z), seed: 0, dpr };
      for (const f of this.flashes) {
        if (!f.live) continue;
        d.gun = f.kind === 'coastal' ? 'heavy' : 'light';
        d.size = f.kind === 'coastal' ? 1.7 : 0.7;
        const age = nowMs - f.t0;
        if (age < 0 || age > art.shotMs({ gun: d.gun, flightMs: 1 }, m)) {
          if (age >= 0) f.live = false;
          continue;
        }
        d.x0 = ox + f.x * z;
        d.y0 = oy + f.y * z;
        if (d.x0 < -80 || d.y0 < -80 || d.x0 > cam.viewW + 80 || d.y0 > cam.viewH + 80) continue;
        d.aim = f.aim;
        d.x1 = d.x0 + Math.cos(f.aim) * 40;
        d.y1 = d.y0 + Math.sin(f.aim) * 40;
        d.ageMs = age;
        d.seed = f.seed;
        art.drawFlash(ctx, d, m);
        this.drawnFlashes++;
      }
    } catch {
      /* never break the frame */
    } finally {
      ctx.globalAlpha = prev;
    }
  }
}
