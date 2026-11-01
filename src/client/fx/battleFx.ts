// Battle effects director: once per frame it reads what is new in the game state (events, sim effects, units that
// died, forts that disappeared), turns it into map effects (fx/map.ts) and draws them (fx/layer.ts). Read-only:
// it never writes to the state, so the sim, its hash and multiplayer are untouched.
//
// Only fresh things count: on a new game, after a jump of more than a few seconds (an online catch-up, a test's
// advance()) or with the effects switched off, everything already there is history. Effects off screen are skipped
// before they use any of the rate budget. The nuke shake (a few px, decaying in 0.6 s) only plays when the blast is
// near the camera, never with prefers-reduced-motion.

import type { BuildingType, Effect, GameEvent, GameState, Unit } from '../../sim/types';
import { FxPool, type ScreenCam } from './layer';
import { FxLimiter, fxForEffect, fxForEvent, isPlane, isShip, type FxSpawn } from './map';
import { fxEnabled, prefersReducedMotion } from './settings';

/** Things older than this (ticks, 10 per second) are history, not news. */
const FRESH_TICKS = 15;
/** A tick jump bigger than this between two frames means a catch-up: treat it all as history. */
const JUMP_TICKS = 30;
const FORT_SCAN_MS = 250;
const SHAKE_MS = 600;
const SHAKE_PX = 6;

export class BattleFx {
  readonly pool = new FxPool();
  readonly limiter = new FxLimiter();
  /** ms spent in update + draw last frame (renderer stats) */
  ms = 0;
  /** effects started since the game began (tests) */
  spawned = 0;

  private state: GameState | null = null;
  private lastTick = -1;
  private seenEvents = new WeakSet<GameEvent>();
  private seenEffects = new WeakSet<Effect>();
  /** ships and planes alive last frame (references: a dead one keeps its last position and hp 0) */
  private prevUnits: Unit[] = [];
  private forts = new Map<number, number>();
  private fortsNext = new Map<number, number>();
  private fortScanAt = 0;
  private shakeAmp = 0;
  private shakeT0 = 0;
  private shakeOut = { x: 0, y: 0 };
  private reduced = prefersReducedMotion();
  private wasOn = true;
  private spawnsThisFrame: FxSpawn[] = [];

  /** Reads what is new in `state` and starts its effects. Call once per frame before drawing. */
  update(state: GameState, cam: ScreenCam, now: number): void {
    const t0 = performance.now();
    try {
      const on = fxEnabled();
      if (!on) {
        if (this.wasOn) this.forget();
        this.wasOn = false;
        return;
      }
      this.wasOn = true;
      if (state !== this.state || this.lastTick < 0 || state.tick - this.lastTick > JUMP_TICKS || state.tick < this.lastTick) {
        this.history(state, now);
        return;
      }
      this.lastTick = state.tick;
      const spawns = this.spawnsThisFrame;
      spawns.length = 0;
      this.readEvents(state, spawns);
      this.readEffects(state, spawns);
      if (now - this.fortScanAt >= FORT_SCAN_MS) this.scanForts(state, spawns, now);
      this.snapshotUnits(state);
      this.pool.prune(now);
      for (const s of spawns) this.spawn(s, cam, now);
    } catch {
      /* never break the frame */
    } finally {
      this.ms = performance.now() - t0;
    }
  }

  /** Draws the live effects (overlay canvas, CSS px transform already set). */
  draw(ctx: CanvasRenderingContext2D, cam: ScreenCam, now: number): void {
    if (!this.wasOn || this.pool.live === 0) return;
    const t0 = performance.now();
    try {
      this.pool.draw(ctx, cam, now);
    } catch {
      /* ignore */
    }
    this.ms += performance.now() - t0;
  }

  /** Screen shake offset in CSS px for this frame (0, 0 most of the time). The object is reused. */
  shake(now: number): { x: number; y: number } {
    const o = this.shakeOut;
    o.x = 0;
    o.y = 0;
    if (this.shakeAmp <= 0) return o;
    const t = now - this.shakeT0;
    if (t >= SHAKE_MS || t < 0 || !this.wasOn) {
      this.shakeAmp = 0;
      return o;
    }
    const a = this.shakeAmp * (1 - t / SHAKE_MS) * (1 - t / SHAKE_MS);
    o.x = a * (Math.sin(t * 0.071) * 0.7 + Math.sin(t * 0.153 + 1.1) * 0.3);
    o.y = a * (Math.sin(t * 0.083 + 2.3) * 0.7 + Math.sin(t * 0.137) * 0.3);
    return o;
  }

  // ---------------------------------------------------------------------------------------------- internals

  private forget(): void {
    this.state = null;
    this.lastTick = -1;
    this.pool.clear();
    this.shakeAmp = 0;
    this.prevUnits.length = 0;
  }

  /** Everything `state` holds now is old news. */
  private history(state: GameState, now: number): void {
    if (state !== this.state) this.pool.clear();
    this.state = state;
    this.lastTick = state.tick;
    this.seenEvents = new WeakSet();
    this.seenEffects = new WeakSet();
    for (const e of state.events) this.seenEvents.add(e);
    for (const e of state.effects) this.seenEffects.add(e);
    this.forts.clear();
    for (const b of state.buildings.values()) if (b.type === 'fort') this.forts.set(b.id, b.tile);
    this.fortScanAt = now;
    this.snapshotUnits(state);
  }

  private readEvents(state: GameState, out: FxSpawn[]): void {
    const evs = state.events;
    let k = evs.length - 1;
    while (k >= 0 && !this.seenEvents.has(evs[k])) k--;
    const h = state.humanId;
    const map = state.map;
    let capitalTile = -1;
    const first = out.length;
    for (let i = k + 1; i < evs.length; i++) {
      const e = evs[i];
      this.seenEvents.add(e);
      if (e.tick < state.tick - FRESH_TICKS) continue;
      let bt: BuildingType | null = null;
      if (e.kind === 'buildingCaptured' && e.tile >= 0 && e.tile < map.building.length) {
        const idx = map.building[e.tile] - 1;
        bt = idx >= 0 ? (state.buildings.get(idx)?.type ?? null) : null;
      }
      const s = fxForEvent(e, h, bt, map.width);
      if (!s) continue;
      if (s.kind === 'capitalLost' || s.kind === 'capitalTaken') capitalTile = e.tile;
      out.push(s);
    }
    // the capital's own city capture: the capital pulse says it already
    if (capitalTile >= 0) {
      const cx = (capitalTile % map.width) + 0.5;
      const cy = Math.floor(capitalTile / map.width) + 0.5;
      for (let i = out.length - 1; i >= first; i--) {
        const s = out[i];
        if ((s.kind === 'cityTaken' || s.kind === 'cityLost') && s.x === cx && s.y === cy) out.splice(i, 1);
      }
    }
  }

  private readEffects(state: GameState, out: FxSpawn[]): void {
    const fxs = state.effects;
    // effects are appended in order and pruned with order kept: new ones are a run at the end
    let k = fxs.length - 1;
    while (k >= 0 && !this.seenEffects.has(fxs[k])) k--;
    const h = state.humanId;
    const map = state.map;
    const w = map.width;
    for (let i = k + 1; i < fxs.length; i++) {
      const e = fxs[i];
      this.seenEffects.add(e);
      if (e.tick < state.tick - FRESH_TICKS) continue;
      let mine = false;
      let lost: Unit['type'] | null = null;
      if (e.kind === 'capture') {
        if (h <= 0) continue;
        const tile = Math.floor(e.y) * w + Math.floor(e.x);
        mine = map.owner[tile] === h;
        if (!mine) continue;
      } else if (e.kind === 'explosion' && e.radius < 4) {
        lost = this.lostAt(e.x, e.y);
        if (!lost) continue;
      }
      const s = fxForEffect(e, mine, lost);
      if (s) out.push(s);
    }
  }

  /** Type of the ship or plane that died at (x, y) since last frame, or null. */
  private lostAt(x: number, y: number): Unit['type'] | null {
    let best: Unit | null = null;
    let bestD = 2.25; // within 1.5 tiles
    for (const u of this.prevUnits) {
      if (u.hp > 0) continue;
      const dx = u.x + 0.5 - x;
      const dy = u.y + 0.5 - y;
      const d = dx * dx + dy * dy;
      if (d < bestD) {
        bestD = d;
        best = u;
      }
    }
    return best ? best.type : null;
  }

  private snapshotUnits(state: GameState): void {
    const p = this.prevUnits;
    p.length = 0;
    for (const u of state.units) if (isShip(u.type) || isPlane(u.type)) p.push(u);
  }

  /** Forts that are gone since the last scan were destroyed (a captured fort keeps its id). */
  private scanForts(state: GameState, out: FxSpawn[], now: number): void {
    this.fortScanAt = now;
    const next = this.fortsNext;
    next.clear();
    for (const b of state.buildings.values()) if (b.type === 'fort') next.set(b.id, b.tile);
    const w = state.map.width;
    for (const [id, tile] of this.forts) {
      if (next.has(id)) continue;
      out.push({ kind: 'fortDust', x: (tile % w) + 0.5, y: Math.floor(tile / w) + 0.5, r: 0 });
    }
    this.fortsNext = this.forts;
    this.forts = next;
  }

  private spawn(s: FxSpawn, cam: ScreenCam, now: number): void {
    const p = cam.tileToScreen(s.x, s.y);
    const vw = cam.viewW;
    const vh = cam.viewH;
    if (s.kind === 'nukeWave' && !this.reduced) {
      // shake by distance from the view centre: full within half a view, none 1.5 views away
      const dx = p.x - vw / 2;
      const dy = p.y - vh / 2;
      const d = Math.sqrt(dx * dx + dy * dy) / Math.max(vw, vh);
      const amp = SHAKE_PX * Math.max(0, Math.min(1, 1.5 - d));
      if (amp > 0.5 && amp >= this.shakeAmp * (1 - (now - this.shakeT0) / SHAKE_MS)) {
        this.shakeAmp = amp;
        this.shakeT0 = now;
      }
    }
    const reach = Math.max(60, s.r * cam.zoom * 2.4);
    if (p.x < -reach || p.y < -reach || p.x > vw + reach || p.y > vh + reach) return;
    if (s.kind === 'ripple' && cam.zoom < 2) return; // a 1-tile ring is noise zoomed out
    if (!this.limiter.accept(s.kind, now, this.pool.countOf(s.kind), this.pool.live, this.pool.cap)) return;
    if (this.pool.add(s.kind, s.x, s.y, s.r, now)) this.spawned++;
  }
}

