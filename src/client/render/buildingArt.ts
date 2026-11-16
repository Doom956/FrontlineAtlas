// The detailed building art on the map (art/detailed/buildings.ts) for fort, city, SAM site and port: which game state
// maps to which picture (level look, add-ons, owner colour, ground tint), the two looks by zoom, and a sprite cache so a
// picture is baked once per type, level, add-on, owner colour, look, pixel scale and ground colour (never per frame).
// Other building types have no art and keep their flat marker (render/buildings.ts). No Math.random or Date here.
import { BUILDINGS } from '../../sim/config';
import type { BuildingType } from '../../sim/types';
import { bakeBuilding, bakeBuildingFar, COAST, OU, OV, vnoise, type Addon, type BakedBuilding, type BuildingSpec, type Under } from '../art/detailed/buildings';
import { FORE } from '../art/detailed/bake';
import { gridOf } from '../art/detailed/grid';
import type { RGB } from '../art/shared/colour';
import { waterRGB } from './terrain';
import type { MapTheme } from './mapThemes';

/** From this map zoom (CSS px per tile) the building art replaces the flat marker; below it the flat markers stay. */
export const ART_ZOOM = 4;
/** From this zoom on the close look is used (full detail and the level chip); between ART_ZOOM and it, far look A. */
export const CLOSE_ZOOM = 11;
/** Sprites kept at most (the oldest unused are dropped first). */
const CACHE_MAX = 160;
/** New sprites baked per frame at most (a bake is heavy); the rest keep their flat marker for a frame or two. */
export const ART_BAKES_PER_FRAME = 2;

export type ArtLook = 'close' | 'far';
export type Facing = 0 | 1 | 2 | 3;

/** What the game knows about a building that the art shows as an add-on (see addonOf). */
export interface AddonState {
  /** the owner has the Fortification tech */
  fortification: boolean;
  /** the owner has the Radar tech */
  radar: boolean;
  /** the owner has Naval Mastery */
  navalMastery: boolean;
  /** a finished SAM site of the same owner covers this building (sim samRadius) */
  samCover: boolean;
}

/** The types that have building art. */
export function hasArt(type: BuildingType): boolean {
  return type === 'fort' || type === 'city' || type === 'sam' || type === 'port';
}

/** The highest level the models tell apart (city level 6 uses the level 5 skyline). */
function modelLevel(type: BuildingSpec['type'], level: number): number {
  const top = type === 'city' ? 5 : Math.min(BUILDINGS[type].maxLevel, type === 'sam' ? 3 : 5);
  return Math.max(1, Math.min(top, Math.round(level)));
}

/**
 * Add-ons exist only where the game has the state: tank traps on a fort of a nation with Fortification, flak guns on a
 * fort or city under a finished SAM site's cover, the radar dish on a SAM site of a nation with Radar, coastal guns on a
 * port of a nation with Naval Mastery. (One add-on per building: traps win over flak on a fort.)
 */
export function addonOf(type: BuildingType, s: AddonState): Addon {
  switch (type) {
    case 'fort':
      return s.fortification ? 'traps' : s.samCover ? 'flak' : null;
    case 'city':
      return s.samCover ? 'flak' : null;
    case 'sam':
      return s.radar ? 'radar' : null;
    case 'port':
      return s.navalMastery ? 'guns' : null;
    default:
      return null;
  }
}

/** The art spec of a building (level mapped to the level look), or null for a type without art. */
export function specOf(type: BuildingType, level: number, s: AddonState): BuildingSpec | null {
  if (!hasArt(type)) return null;
  const t = type as BuildingSpec['type'];
  return { type: t, level: modelLevel(t, level), addon: addonOf(type, s) };
}

/** Close look from CLOSE_ZOOM, far look A below it; null below ART_ZOOM (the flat markers). */
export function lookFor(zoom: number): ArtLook | null {
  return zoom < ART_ZOOM ? null : zoom < CLOSE_ZOOM ? 'far' : 'close';
}

/** Screen px per model unit at a zoom: the units' own sprite scale (render/units.ts spriteScale, kept in step by a test). */
export function artScale(zoom: number): number {
  return zoom < 11 ? 1.5 : zoom < 22 ? 2 : zoom < 32 ? 3 : 4;
}

/** A ground colour snapped to steps of 8 per channel, so near colours share one sprite. */
export function quantTint(c: readonly number[]): RGB {
  const q = (v: number): number => Math.max(0, Math.min(255, Math.round(v / 8) * 8));
  return [q(c[0]), q(c[1]), q(c[2])];
}

/** The cache key of a sprite: type, level, add-on, owner colour, look, pixel scale, dpr, ground colour, port facing. */
export function spriteKey(spec: BuildingSpec, owner: readonly number[], look: ArtLook, scale: number, dpr: number, tint: readonly number[], facing = 0): string {
  return `${spec.type}|${spec.level}|${spec.addon ?? '-'}|${owner[0]},${owner[1]},${owner[2]}|${look}|${scale}|${dpr}|${tint[0]},${tint[1]},${tint[2]}|${facing}`;
}

/** The sea side of a port: the direction (0 east, 1 south, 2 west, 3 north) with the most water in a strip ahead of it. */
export function seaFacing(waterAt: (dx: number, dy: number) => boolean): Facing {
  const dirs: [number, number][] = [[1, 0], [0, 1], [-1, 0], [0, -1]];
  let best: Facing = 0;
  let bestN = -1;
  for (let f = 0; f < 4; f++) {
    const [ux, uy] = dirs[f];
    let n = 0;
    for (let k = 1; k <= 6; k++) for (let j = -2; j <= 2; j++) if (waterAt(ux * k - uy * j, uy * k + ux * j)) n++;
    if (n > bestN) {
      bestN = n;
      best = f as Facing;
    }
  }
  return best;
}

/** The wavy shore line of a port's cell, about u = COAST. */
const coastU = (v: number): number => COAST + 2.2 * Math.sin(v * 0.19 + 0.7) + 1.1 * Math.sin(v * 0.47) + (vnoise(v * 0.3, 3, 31) - 0.5) * 1.6;

/** The ground under a cell: all land of one colour, and for a port sea east of a wavy shore (the real sea shows through). */
export function underOf(spec: BuildingSpec, land: RGB, res: number, scale: number, theme?: MapTheme): Under {
  if (spec.type !== 'port') return { water: () => false, rgb: () => land };
  const ox = OU * res;
  const oy = OV * res;
  const U = (ax: number): number => (ax + 0.5 - ox) / res;
  const V = (ay: number): number => (ay + 0.5 - oy) / (res * FORE);
  const tilePx = (4 / scale) * res;
  return {
    water: (ax, ay) => U(ax) > coastU(V(ay)),
    rgb: (ax, ay) => {
      const u = U(ax);
      const v = V(ay);
      const d = u - coastU(v);
      if (d <= 0) return land;
      return waterRGB(1 + ((d * res) / tilePx) * 1.5, theme);
    },
  };
}

export interface ArtSprite {
  baked: BakedBuilding;
  /** pixel scale it was baked at */
  scale: number;
}

/** Baked building sprites, shared by every building with the same key. */
export class BuildingSprites {
  private cache = new Map<string, ArtSprite>();
  private budget = ART_BAKES_PER_FRAME;
  /** bakes done (stats and tests) */
  baked = 0;

  /** Call once per frame. */
  newFrame(): void {
    this.budget = ART_BAKES_PER_FRAME;
  }

  clear(): void {
    this.cache.clear();
  }

  get size(): number {
    return this.cache.size;
  }

  /** The sprite for a key; bakes it (within the frame's budget) when missing, else null. */
  get(key: string, bake: () => ArtSprite): ArtSprite | null {
    const hit = this.cache.get(key);
    if (hit) {
      // most recently used goes last
      this.cache.delete(key);
      this.cache.set(key, hit);
      return hit;
    }
    if (this.budget <= 0) return null;
    this.budget--;
    const s = bake();
    this.baked++;
    this.cache.set(key, s);
    if (this.cache.size > CACHE_MAX) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    return s;
  }
}

/** Bakes the picture of a spec for a look (the cell's ground painted from `land`). */
export function bakeArt(spec: BuildingSpec, owner: RGB, look: ArtLook, scale: number, dpr: number, land: RGB, theme?: MapTheme): ArtSprite {
  const res = gridOf(scale, dpr).res;
  const under = underOf(spec, land, res, scale, theme);
  const baked = look === 'close' ? bakeBuilding(spec, owner, scale, dpr, under) : bakeBuildingFar(spec, owner, scale, dpr, under);
  return { baked, scale };
}
