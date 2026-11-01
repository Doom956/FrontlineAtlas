// Which map effect a sim event or effect makes. Pure and read-only: the same input always gives the same answer,
// nothing here touches the game state. The director (fx/battleFx.ts) feeds it and draws the result.

import type { BuildingType, Effect, GameEvent, UnitType } from '../../sim/types';

export type FxKind =
  /** soft ring on a tile you just took at the front */
  | 'ripple'
  /** pulse + short label: a city of yours changed hands */
  | 'cityTaken'
  | 'cityLost'
  | 'capitalTaken'
  | 'capitalLost'
  /** ship sunk: splash rings and sinking fragments */
  | 'splash'
  /** plane shot down: smoke puff */
  | 'smoke'
  /** artillery shells landing: dust that settles */
  | 'dust'
  /** fort destroyed: a ring of heavier dust */
  | 'fortDust'
  /** rocket / bomb impact: one shockwave ring */
  | 'shockwave'
  /** atom bomb: two wide rings (and the screen shake near the camera) */
  | 'nukeWave';

export interface FxSpawn {
  kind: FxKind;
  /** tile coordinates (float, tile centre = +0.5) */
  x: number;
  y: number;
  /** blast radius in tiles (shockwave, nukeWave, dust); 0 otherwise */
  r: number;
}

export interface FxInfo {
  /** life in ms */
  dur: number;
  /** minimum real time between two spawns of this kind, ms */
  gapMs: number;
  /** most alive at once */
  maxLive: number;
  /** 0 = cosmetic (dropped first when the pool is busy), 1 = normal, 2 = news (may replace a cosmetic one) */
  priority: 0 | 1 | 2;
}

export const FX_INFO: Readonly<Record<FxKind, FxInfo>> = {
  ripple: { dur: 650, gapMs: 90, maxLive: 8, priority: 0 },
  cityTaken: { dur: 2200, gapMs: 300, maxLive: 3, priority: 2 },
  cityLost: { dur: 2200, gapMs: 300, maxLive: 3, priority: 2 },
  capitalTaken: { dur: 2800, gapMs: 1000, maxLive: 2, priority: 2 },
  capitalLost: { dur: 2800, gapMs: 1000, maxLive: 2, priority: 2 },
  splash: { dur: 1400, gapMs: 150, maxLive: 4, priority: 1 },
  smoke: { dur: 1600, gapMs: 150, maxLive: 4, priority: 1 },
  dust: { dur: 1500, gapMs: 200, maxLive: 4, priority: 0 },
  fortDust: { dur: 1800, gapMs: 300, maxLive: 3, priority: 1 },
  shockwave: { dur: 900, gapMs: 120, maxLive: 4, priority: 1 },
  nukeWave: { dur: 2200, gapMs: 300, maxLive: 2, priority: 2 },
};

export const FX_KINDS = Object.keys(FX_INFO) as FxKind[];

/** Blasts at least this wide (tiles) get a shockwave ring: rockets, bomber runs, air support; not the 1.5 tile hits. */
export const SHOCKWAVE_MIN_RADIUS = 4;

const SHIPS: ReadonlySet<UnitType> = new Set<UnitType>(['transport', 'warship', 'tradeShip']);
const PLANES: ReadonlySet<UnitType> = new Set<UnitType>(['bomber', 'fighter', 'transportPlane', 'reconPlane']);

export const isShip = (t: UnitType): boolean => SHIPS.has(t);
export const isPlane = (t: UnitType): boolean => PLANES.has(t);

/**
 * Map effect for a sim visual effect.
 * - `mineCapture`: for a 'capture', whether the tile is now the human's (only your own captures ripple).
 * - `lost`: for a small 'explosion', the type of the unit that died there (ships splash, planes smoke), if any.
 */
export function fxForEffect(e: Effect, mineCapture = false, lost: UnitType | null = null): FxSpawn | null {
  switch (e.kind) {
    case 'capture':
      return mineCapture ? { kind: 'ripple', x: e.x, y: e.y, r: 0 } : null;
    case 'nuke':
      return { kind: 'nukeWave', x: e.x, y: e.y, r: e.radius };
    case 'barrage':
      return { kind: 'dust', x: e.x, y: e.y, r: e.radius };
    case 'explosion':
      if (e.radius >= SHOCKWAVE_MIN_RADIUS) return { kind: 'shockwave', x: e.x, y: e.y, r: e.radius };
      if (lost && isShip(lost)) return { kind: 'splash', x: e.x, y: e.y, r: 0 };
      if (lost && isPlane(lost)) return { kind: 'smoke', x: e.x, y: e.y, r: 0 };
      return null;
    default:
      return null;
  }
}

/**
 * Map effect for a sim event, for the human `humanId`. Only cities and capitals the human takes or loses.
 * `building` is the type of the building on the event's tile (the city is still there after a capture).
 */
export function fxForEvent(e: GameEvent, humanId: number, building: BuildingType | null, mapWidth: number): FxSpawn | null {
  if (humanId <= 0 || e.tile < 0 || mapWidth <= 0) return null;
  const first = e.players[0] === humanId;
  const mine = e.players.includes(humanId);
  if (!mine) return null;
  const x = (e.tile % mapWidth) + 0.5;
  const y = Math.floor(e.tile / mapWidth) + 0.5;
  switch (e.kind) {
    case 'buildingCaptured':
      // players = [new owner, previous owner]
      if (building !== 'city') return null;
      return { kind: first ? 'cityTaken' : 'cityLost', x, y, r: 0 };
    case 'capitalLost':
      // players = [the nation that lost it, the taker]
      return { kind: first ? 'capitalLost' : 'capitalTaken', x, y, r: 0 };
    default:
      return null;
  }
}

/** Short label drawn with a pulse, or null. A city you take has none: the HUD's "+City" floater says it. */
export function fxLabel(kind: FxKind): string | null {
  switch (kind) {
    case 'cityLost':
      return 'City lost';
    case 'capitalTaken':
      return 'Capital taken';
    case 'capitalLost':
      return 'Capital lost';
    default:
      return null;
  }
}

// ================================================================================================ rate limiter

/** Per-kind gaps and live caps plus a pool cap: pure bookkeeping (real-time ms, so game speed x4 adds no clutter). */
export class FxLimiter {
  private lastAt = new Map<FxKind, number>();

  /**
   * True when `kind` may spawn at `now`, given how many of that kind (`liveOfKind`) and in all (`liveTotal`) are
   * alive and the pool size `cap`. Records the spawn when it says yes. A news effect (priority 2) is also accepted
   * with a full pool: the caller then replaces a cosmetic one.
   */
  accept(kind: FxKind, now: number, liveOfKind: number, liveTotal: number, cap: number): boolean {
    const info = FX_INFO[kind];
    if (!info) return false;
    const last = this.lastAt.get(kind);
    if (last !== undefined && now >= last && now - last < info.gapMs) return false;
    if (liveOfKind >= info.maxLive) return false;
    if (info.priority === 0 && liveTotal >= cap * 0.75) return false;
    if (info.priority < 2 && liveTotal >= cap) return false;
    this.lastAt.set(kind, now);
    return true;
  }

  reset(): void {
    this.lastAt.clear();
  }
}
