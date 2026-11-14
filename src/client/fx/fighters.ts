// Fighters in the picture (client only, decoration): the sim keeps fighters as a number on their airfield
// (Building.fighters) and on carriers, and they intercept at once, so nothing showed them. This layer draws them from
// the real state each frame and never writes to it (the sim, its hash and multiplayer are untouched; two clients may
// show their fighters in a different place on the circle, which is fine for decoration):
//   - an airfield with fighters: up to MAX_PER_BASE of its owner's fighters circle lazily above it, as many as it
//     holds (the jet fighter once the owner has Jet Engines: render/pixelSprites.ts modsFor);
//   - an airfield flying air superiority (sim/airwings.ts airMissionOf): its fighters fly the patrol circle instead,
//     round the patrol's centre, just inside the ring render/pillarOverlay.ts draws;
//   - a carrier: its wing of CARRIER_FIGHTERS circles the ship and follows it;
//   - an interception: when fighters hit a bomber or a cargo plane (a 'shot' from a superiority airfield or a carrier,
//     or a plane shot down inside a hostile airfield's reach with no SAM shot at it), a fighter streaks in from that
//     side past the kill firing tracers, banks round and heads home.
// Fog of war: your own and allied fighters always show; other nations' only over tiles you see now (as planes in
// render/units.ts). Drawn with the unit sprites: none far out where units are kind icons, fading in with the
// sprites (render/units.ts unitBands). Fixed pools, no allocation per
// frame or per fighter.
import { wingOf, airMissionOf, airPatrolRadius } from '../../sim/airwings';
import { airfieldRadius, buildingAt, isDisabled } from '../../sim/buildings';
import { areAllied } from '../../sim/diplomacy';
import { atPeace } from '../../sim/rules';
import { earlyWarningMul } from '../../sim/specials';
import type { Building, Effect, GameState, Unit } from '../../sim/types';
import { motionFor } from '../art/registry';
import type { RGB } from '../art/shared/colour';
import type { MotionParams, TrailUnit } from '../art/types';
import { drawMapSprite, modsFor, spriteLength, type MapSpriteState } from '../render/pixelSprites';
import { drawUnitIcon } from '../render/unitIcons';
import { spriteScale, unitBands } from '../render/units';
import { DeathWatch, isKillBlast } from './deaths';
import { fxEnabled } from './settings';

/** Fighters drawn over one airfield at most (it may hold more). */
export const MAX_PER_BASE = 3;
/** A carrier's wing on the map. */
export const CARRIER_FIGHTERS = 2;
/** Circling fighters drawn at most (the nearest bases first is not needed: the cap is far above a normal game). */
export const FLIGHT_CAP = 48;
/** Interception sorties at once. */
export const SORTIE_CAP = 12;
/** Circle radius (tiles) over an idle airfield and round a carrier. */
const IDLE_R = 4.8;
const CARRIER_R = 3.4;
/** Patrols fly just inside the patrol ring. */
const PATROL_SHARE = 0.86;
/** Cruise speed on the circle and in a sortie (tiles per second of game time). */
const CRUISE = 2.2;
/** A sortie: how long (ms), how far out it starts at most (tiles), how far past the kill it runs before turning. */
const SORTIE_MS = 2600;
const SORTIE_REACH = 9;
const OVERSHOOT = 1.6;
const TURN_R = 1.3;
const TRACER: readonly string[] = ['#fff1c2', '#ffc95c', '#e5832f'];
const TAU = Math.PI * 2;
/** Things older than this (ticks) are history, not news (as fx/pixelFx.ts). */
const FRESH_TICKS = 15;
const JUMP_TICKS = 30;

/** What the viewer may see (fog/fogView.ts FogView fits). */
export interface FighterSight {
  readonly active: boolean;
  visible(tile: number): boolean;
}

/** The camera the effects use (fx/pixelFx.ts FxCam). */
interface Cam {
  zoom: number;
  x: number;
  y: number;
  viewW: number;
  viewH: number;
}

/** Screen positions of units drawn last frame (render/units.ts): a carrier's fighters follow its eased position. */
interface Poses {
  screenOf(id: number): { x: number; y: number } | null;
}

/** One fighter to draw this frame. */
export interface Flight {
  /** stable id for its contrail (never a unit id: negative) */
  id: number;
  owner: number;
  mods: number;
  /** on the map (tiles, float) and on screen (CSS px) */
  tx: number;
  ty: number;
  x: number;
  y: number;
  angle: number;
  turn: number;
  alpha: number;
  /** a sortie firing now: tracers ahead of its nose */
  firing: boolean;
  /** what it belongs to: an airfield (building id), a carrier (unit id) or a sortie */
  kind: 'base' | 'patrol' | 'carrier' | 'sortie';
  from: number;
}

interface Sortie {
  live: boolean;
  owner: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  t0: number;
  seed: number;
  gen: number;
}

const hostileTo = (state: GameState, a: number, b: number): boolean => a !== b && a > 0 && b > 0 && !areAllied(state, a, b) && !atPeace(state, a, b);

export class FighterFx {
  fog: FighterSight | null = null;
  /** the fighters laid out for this frame (flights[0..count)) */
  readonly flights: Flight[] = [];
  count = 0;
  readonly sorties: Sortie[] = [];
  /** sorties started since the game began (tests), and sorties among this frame's fighters (renderer stats) */
  launched = 0;
  sortiesDrawn = 0;

  private state: GameState | null = null;
  private lastTick = -1;
  private seen = new WeakSet<Effect>();
  private watch = new DeathWatch();
  private gone: Unit[] = [];
  /** this tick's SAM shots and sorties: their targets (a kill there is not a fighter's, or already has one) */
  private samX: number[] = [];
  private samY: number[] = [];
  private nSam = 0;
  private ss: MapSpriteState = { zoom: 1, scale: 1, dpr: 1, timeMs: 0, turnRate: 0, speed: 0, moving: false, seed: 0, damage: 0 };
  private trailPool: TrailUnit[] = [];
  private zoom = 1;
  private ox = 0;
  private oy = 0;
  private gen = 0;

  constructor() {
    for (let i = 0; i < FLIGHT_CAP + SORTIE_CAP; i++) this.flights.push({ id: 0, owner: 0, mods: 0, tx: 0, ty: 0, x: 0, y: 0, angle: 0, turn: 0, alpha: 1, firing: false, kind: 'base', from: 0 });
    for (let i = 0; i < SORTIE_CAP; i++) this.sorties.push({ live: false, owner: 0, x0: 0, y0: 0, x1: 0, y1: 0, t0: 0, seed: 0, gen: 0 });
  }

  // ------------------------------------------------------------------------------------------- reading the game

  /** Reads this frame's new shots and kills: interceptions start a sortie. Call once per frame before drawing. */
  update(state: GameState, nowMs: number): void {
    if (!fxEnabled()) {
      for (const s of this.sorties) s.live = false;
      return;
    }
    if (state !== this.state || this.lastTick < 0 || state.tick - this.lastTick > JUMP_TICKS || state.tick < this.lastTick) {
      // a new game, a load or a jump: what happened before is history
      this.state = state;
      this.lastTick = state.tick;
      for (const e of state.effects) this.seen.add(e);
      this.watch.reset(state);
      for (const s of this.sorties) s.live = false;
      return;
    }
    const fresh = state.tick !== this.lastTick;
    this.lastTick = state.tick;
    const fx = state.effects;
    let k = fx.length - 1;
    while (k >= 0 && !this.seen.has(fx[k])) k--;
    for (let i = k + 1; i < fx.length; i++) {
      const e = fx[i];
      this.seen.add(e);
      if (e.tick < state.tick - FRESH_TICKS) continue;
      if (e.kind === 'explosion' && isKillBlast(e.radius)) this.watch.blast(e.x, e.y);
      else if (e.kind === 'shot') this.readShot(state, e, nowMs);
    }
    if (fresh || this.watch.blasts > 0) {
      const n = this.watch.scan(state, this.gone);
      for (let i = 0; i < n; i++) this.readKill(state, this.gone[i], nowMs);
      this.watch.endTick();
      this.gone.length = 0;
      this.nSam = 0;
    }
  }

  /** A 'shot': from a superiority airfield's tile or a carrier, a fighter flies at its target; a SAM's is noted. */
  private readShot(state: GameState, e: Effect, now: number): void {
    const w = state.map.width;
    const tile = Math.floor(e.y) * w + Math.floor(e.x);
    const at = Math.abs(e.x - Math.floor(e.x) - 0.5) < 0.01 && Math.abs(e.y - Math.floor(e.y) - 0.5) < 0.01;
    const b = at ? buildingAt(state, tile) : undefined;
    if (b && b.tile === tile && b.type === 'sam') {
      this.noteSam(e.x2 ?? e.x, e.y2 ?? e.y);
      return;
    }
    if (b && b.tile === tile && b.type === 'airfield') {
      this.launch(b.owner, e.x, e.y, e.x2 ?? e.x, e.y2 ?? e.y, now);
      this.noteSam(e.x2 ?? e.x, e.y2 ?? e.y); // its kill already has a fighter
      return;
    }
    for (const u of state.units) {
      if (u.type !== 'warship' || u.variant !== 'carrier' || u.hp <= 0) continue;
      if (Math.abs(u.x + 0.5 - e.x) < 0.01 && Math.abs(u.y + 0.5 - e.y) < 0.01) {
        this.launch(u.owner, e.x, e.y, e.x2 ?? e.x, e.y2 ?? e.y, now);
        this.noteSam(e.x2 ?? e.x, e.y2 ?? e.y);
        return;
      }
    }
  }

  private noteSam(x: number, y: number): void {
    if (this.nSam >= 16) return;
    this.samX[this.nSam] = x;
    this.samY[this.nSam] = y;
    this.nSam++;
  }

  /** A bomber or cargo plane shot down where no SAM fired at it: the nearest hostile airfield whose fighters reach it. */
  private readKill(state: GameState, u: Unit, now: number): void {
    if (u.type !== 'bomber' && u.type !== 'transportPlane') return;
    const x = u.x + 0.5;
    const y = u.y + 0.5;
    for (let i = 0; i < this.nSam; i++) if (Math.abs(this.samX[i] - x) < 1.5 && Math.abs(this.samY[i] - y) < 1.5) return;
    const w = state.map.width;
    let best: Building | null = null;
    let bd = Infinity;
    for (const b of state.buildings.values()) {
      if (b.type !== 'airfield' || b.buildLeft > 0 || !hostileTo(state, u.owner, b.owner)) continue;
      const dx = (b.tile % w) + 0.5 - x;
      const dy = ((b.tile / w) | 0) + 0.5 - y;
      const d2 = dx * dx + dy * dy;
      const r = airfieldRadius(b) * earlyWarningMul(state, b.owner);
      if (d2 > r * r || d2 >= bd) continue;
      bd = d2;
      best = b;
    }
    if (best) this.launch(best.owner, (best.tile % w) + 0.5, ((best.tile / w) | 0) + 0.5, x, y, now);
  }

  /** Starts a sortie (the oldest one gives way when all are flying). */
  private launch(owner: number, x0: number, y0: number, x1: number, y1: number, now: number): void {
    let slot: Sortie | null = null;
    let oldest: Sortie | null = null;
    for (const s of this.sorties) {
      if (!s.live || now - s.t0 > SORTIE_MS) {
        slot = s;
        break;
      }
      if (!oldest || s.t0 < oldest.t0) oldest = s;
    }
    slot = slot ?? oldest;
    if (!slot) return;
    // it comes from that side, at most SORTIE_REACH tiles out
    const dx = x1 - x0;
    const dy = y1 - y0;
    const d = Math.hypot(dx, dy);
    const back = Math.min(d, SORTIE_REACH);
    slot.live = true;
    slot.owner = owner;
    slot.x0 = d > 0 ? x1 - (dx / d) * back : x1 - SORTIE_REACH;
    slot.y0 = d > 0 ? y1 - (dy / d) * back : y1;
    slot.x1 = x1;
    slot.y1 = y1;
    slot.t0 = now;
    slot.seed = (x1 * 12.9898 + y1 * 78.233) % 1;
    slot.gen = ++this.gen;
    this.launched++;
  }

  // ------------------------------------------------------------------------------------------- laying out

  /** May the viewer see a fighter of `owner` over tile (tx, ty)? */
  private shown(state: GameState, me: number, owner: number, tx: number, ty: number): boolean {
    const fog = this.fog;
    if (!fog || !fog.active || owner === me || (me > 0 && areAllied(state, me, owner))) return true;
    const w = state.map.width;
    const x = Math.floor(tx);
    const y = Math.floor(ty);
    if (x < 0 || y < 0 || x >= w || y >= state.map.height) return false;
    return fog.visible(y * w + x);
  }

  private put(state: GameState, me: number, id: number, owner: number, tx: number, ty: number, angle: number, turn: number, alpha: number, firing: boolean, kind: Flight['kind'], from: number, cam: Cam | null): boolean {
    if (this.count >= this.flights.length) return false;
    if (!this.shown(state, me, owner, tx, ty)) return true;
    const f = this.flights[this.count];
    if (cam) {
      f.x = this.ox + tx * this.zoom;
      f.y = this.oy + ty * this.zoom;
      const m = 40;
      if (f.x < -m || f.y < -m || f.x > cam.viewW + m || f.y > cam.viewH + m) return true;
    }
    f.id = id;
    f.owner = owner;
    f.mods = modsFor(state, owner, 'fighter', undefined);
    f.tx = tx;
    f.ty = ty;
    f.angle = angle;
    f.turn = turn;
    f.alpha = alpha;
    f.firing = firing;
    f.kind = kind;
    f.from = from;
    this.count++;
    return true;
  }

  /**
   * Lays out this frame's fighters into `flights` (from the state, the clock and the sorties). `gameTicks` is the game
   * clock in ticks (tick + the fraction drawn), so circling stops while the game is paused. With `cam` they get screen
   * positions and the ones off screen are left out; without it (tests) every one the viewer may see is listed.
   */
  layout(state: GameState, me: number, gameTicks: number, nowMs: number, cam: Cam | null = null, poses: Poses | null = null): number {
    this.count = 0;
    this.sortiesDrawn = 0;
    // far out the units are kind icons: no fighters there; they fade in with the sprites (render/units.ts unitBands)
    if (!fxEnabled() || (cam && unitBands(cam.zoom).sprite <= 0)) return 0;
    if (cam) {
      this.zoom = cam.zoom;
      this.ox = cam.viewW / 2 - cam.x * cam.zoom;
      this.oy = cam.viewH / 2 - cam.y * cam.zoom;
    }
    const sec = gameTicks / 10;
    const w = state.map.width;
    let base = 0;
    // airfields: circling over the field, or flying the superiority patrol
    for (const b of state.buildings.values()) {
      if (b.type !== 'airfield' || b.fighters <= 0 || b.buildLeft > 0 || isDisabled(state, b)) continue;
      if (base >= FLIGHT_CAP) break;
      const patrol = airMissionOf(state, b) === 'superiority';
      const wing = patrol ? wingOf(state, b) : undefined;
      const c = patrol && wing && wing.target >= 0 ? wing.target : b.tile;
      const cx = (c % w) + 0.5;
      const cy = ((c / w) | 0) + 0.5;
      const R = patrol ? Math.max(IDLE_R, airPatrolRadius(b, state) * PATROL_SHARE) : IDLE_R;
      const n = Math.min(MAX_PER_BASE, Math.floor(b.fighters));
      const om = CRUISE / R;
      const ph0 = b.id * 2.39996;
      for (let i = 0; i < n; i++) {
        // spread round the circle; idle ones a little in and out so they do not fly in one ring
        const th = ph0 + (i * TAU) / n + om * sec;
        const r = patrol ? R : R * (1 + 0.18 * Math.sin(b.id + i * 2.1));
        this.put(state, me, -(1000 + b.id * 8 + i), b.owner, cx + Math.cos(th) * r, cy + Math.sin(th) * r, th + Math.PI / 2, om, 1, false, patrol ? 'patrol' : 'base', b.id, cam);
        base++;
      }
    }
    // carriers: their wing round the ship, following its drawn position
    for (const u of state.units) {
      if (u.type !== 'warship' || u.variant !== 'carrier' || u.hp <= 0) continue;
      if (base >= FLIGHT_CAP) break;
      let cx = u.x + 0.5;
      let cy = u.y + 0.5;
      const p = cam && poses ? poses.screenOf(u.id) : null;
      if (p && cam) {
        cx = (p.x - this.ox) / this.zoom;
        cy = (p.y - this.oy) / this.zoom;
      }
      const om = CRUISE / CARRIER_R;
      for (let i = 0; i < CARRIER_FIGHTERS; i++) {
        const th = u.id * 1.618 + (i * TAU) / CARRIER_FIGHTERS + om * sec;
        this.put(state, me, -(5_000_000 + u.id * 4 + i), u.owner, cx + Math.cos(th) * CARRIER_R, cy + Math.sin(th) * CARRIER_R, th + Math.PI / 2, om, 1, false, 'carrier', u.id, cam);
        base++;
      }
    }
    // sorties: in past the kill, round, and home
    for (let i = 0; i < this.sorties.length; i++) {
      const s = this.sorties[i];
      if (!s.live) continue;
      const t = (nowMs - s.t0) / SORTIE_MS;
      if (t >= 1 || t < 0) {
        s.live = false;
        continue;
      }
      this.sortiePose(s, t);
      const before = this.count;
      this.put(state, me, -(9_000_000 + (s.gen % 100000) * 16 + i), s.owner, P.x, P.y, P.angle, P.turn, P.alpha, P.firing, 'sortie', i, cam);
      if (this.count > before) this.sortiesDrawn++;
    }
    return this.count;
  }

  /** Where a sortie is at t (0..1 of its time): written to P. */
  private sortiePose(s: Sortie, t: number): void {
    const dx = s.x1 - s.x0;
    const dy = s.y1 - s.y0;
    const d = Math.max(0.001, Math.hypot(dx, dy));
    const ux = dx / d;
    const uy = dy / d;
    const a0 = Math.atan2(uy, ux);
    const side = s.seed < 0.5 ? 1 : -1;
    const A = 0.36;
    const B = 0.56;
    if (t < A) {
      // in fast and straight past the kill, firing as it closes
      const k = t / A;
      const run = d + OVERSHOOT;
      P.x = s.x0 + ux * run * k;
      P.y = s.y0 + uy * run * k;
      P.angle = a0;
      P.turn = 0;
      P.alpha = Math.min(1, k * 4);
      P.firing = k > 0.55 && k < 0.95;
      return;
    }
    // the turn: a half circle off to one side, then home the way it came
    const ex = s.x1 + ux * OVERSHOOT;
    const ey = s.y1 + uy * OVERSHOOT;
    const cx = ex - uy * TURN_R * side;
    const cy = ey + ux * TURN_R * side;
    if (t < B) {
      const k = (t - A) / (B - A);
      const th = Math.atan2(ey - cy, ex - cx) + side * Math.PI * k;
      P.x = cx + Math.cos(th) * TURN_R;
      P.y = cy + Math.sin(th) * TURN_R;
      P.angle = a0 + side * Math.PI * k;
      P.turn = (side * Math.PI) / (((B - A) * SORTIE_MS) / 1000);
      P.alpha = 1;
      P.firing = false;
      return;
    }
    const k = (t - B) / (1 - B);
    const bx = cx - (ex - cx);
    const by = cy - (ey - cy);
    const home = Math.min(d, SORTIE_REACH);
    P.x = bx - ux * home * k;
    P.y = by - uy * home * k;
    P.angle = a0 + Math.PI;
    P.turn = 0;
    P.alpha = k > 0.6 ? 1 - (k - 0.6) / 0.4 : 1;
    P.firing = false;
  }

  // ------------------------------------------------------------------------------------------- drawing

  /** Contrails for the fighters laid out this frame (render/units.ts calls it while it lays its trails). */
  trails(into: TrailUnit[], motion: MotionParams): void {
    const half = spriteLength('fighter', undefined, 0, spriteScale(this.zoom)) / 2;
    for (let i = 0; i < this.count; i++) {
      const f = this.flights[i];
      let tu = this.trailPool[i];
      if (!tu) this.trailPool[i] = tu = { id: 0, key: 'fighter', x: 0, y: 0, tx: 0, ty: 0, angle: 0, half: 0, moving: true, speed: 0, turnRate: 0, motion };
      tu.id = f.id;
      tu.x = f.x;
      tu.y = f.y;
      tu.tx = f.tx;
      tu.ty = f.ty;
      tu.angle = f.angle;
      tu.half = half;
      tu.moving = true;
      tu.speed = f.kind === 'sortie' ? CRUISE * 2.5 : CRUISE;
      tu.turnRate = f.turn;
      tu.motion = motion;
      into.push(tu);
    }
  }

  /** Draws the fighters laid out this frame over the units (their shadows with them), and a sortie's tracers. */
  draw(ctx: CanvasRenderingContext2D, colors: readonly RGB[] | null, dpr: number, nowMs: number): void {
    if (!this.count) return;
    const ss = this.ss;
    ss.zoom = this.zoom;
    // the unit sprites' own pixel size, so a fighter is drawn at the same size as every other plane
    ss.scale = spriteScale(this.zoom);
    ss.dpr = dpr;
    ss.timeMs = nowMs;
    ss.moving = true;
    ss.damage = 0;
    const prev = ctx.globalAlpha;
    const band = unitBands(this.zoom).sprite;
    for (let i = 0; i < this.count; i++) {
      const f = this.flights[i];
      ss.turnRate = f.turn;
      ss.speed = f.kind === 'sortie' ? CRUISE * 2.5 : CRUISE;
      ss.seed = f.id;
      ctx.globalAlpha = prev * f.alpha * band;
      const c = (colors?.[f.owner] ?? [200, 200, 200]) as RGB;
      // the frame's bake budget spent (a new heading not baked yet): its kind icon this frame, as units.ts does
      if (!drawMapSprite(ctx, 'fighter', undefined, f.x, f.y, f.angle, c, f.mods, ss)) drawUnitIcon(ctx, 'fighter', undefined, f.x, f.y, f.angle, c, this.zoom, dpr, false, prev * f.alpha * band);
      if (f.firing) {
        // tracers: short bright streaks out ahead of the nose, a new few every frame
        const k = Math.max(1, Math.round(ss.scale)); // whole screen px, crisp at any sprite scale
        const ca = Math.cos(f.angle);
        const sa = Math.sin(f.angle);
        for (let j = 0; j < 3; j++) {
          const d = (8 + ((nowMs / 9 + j * 7 + f.id) % 22)) * k;
          ctx.fillStyle = TRACER[j];
          ctx.fillRect(Math.round(f.x + ca * d), Math.round(f.y + sa * d * 0.84), k, k);
          ctx.fillRect(Math.round(f.x + ca * (d + 2 * k)), Math.round(f.y + sa * (d + 2 * k) * 0.84), k, k);
        }
      }
    }
    ctx.globalAlpha = prev;
  }
}

/** A sortie's pose being worked out (reused). */
const P = { x: 0, y: 0, angle: 0, turn: 0, alpha: 1, firing: false };
