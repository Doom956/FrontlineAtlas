// The detailed building art on the map (art/detailed/buildings.ts, buildingsMore.ts) for all 16 building types: which game
// state maps to which picture (level look, add-ons, owner colour, ground tint), the two looks by zoom, and a sprite cache so
// a picture is baked once per type, level, add-on, owner colour, look, pixel scale and ground colour (never per frame).
// Below ART_ZOOM the flat markers stay (render/buildings.ts). No Math.random or Date here.
import { BUILDINGS } from '../../sim/config';
import type { BuildingType } from '../../sim/types';
import { bakeBuilding, bakeBuildingFar, COAST, modelExtent, OU, OV, vnoise, type Addon, type BakedBuilding, type BuildingSpec, type Extent, type Under } from '../art/detailed/buildings';
import { FORE } from '../art/detailed/bake';
import { gridOf } from '../art/detailed/grid';
import type { RGB } from '../art/shared/colour';
import { waterRGB } from './terrain';
import type { MapTheme } from './mapThemes';

/**
 * From this map zoom (CSS px per tile) the building art replaces the flat marker; below it the flat markers stay. Picked
 * from the numbers: on the smallest map (buildings 10 tiles apart) at zoom 8 every picture fits its share of the space at
 * a pixel scale of 0.75 or more (fitScale); further out it would be too small to read.
 */
export const ART_ZOOM = 8;
/** The smallest pixel scale the art is drawn at; where a building would need less, the flat marker stays. */
export const MIN_ART_SCALE = 0.75;
/** Pictures take up at most this share of the minimum spacing between buildings (two neighbours half each). */
export const SPACE_SHARE = 0.7;
/** Scales come in steps of this size, so the cache stays small. */
export const SCALE_STEP = 0.25;
/** Room a "Lv N" chip needs above a picture and a name label needs below it and beside it (CSS px); without it they are left out. */
export const CHIP_ROOM = 15;
export const NAME_ROOM = 22;
export const NAME_HALF_WIDTH = 30;
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
  /** the owner holds Flak Guns (Defense row): AA gun pits on its Forts and Cities */
  flak: boolean;
  /** the owner holds Tracking Radar (Defense row): a radar dish on its SAM sites */
  radar: boolean;
  /** this building is a coastal battery (Coastal Batteries: a Port, or a Fort near the coast): big guns on it */
  guns: boolean;
}

/** Every building type in the game has building art. */
export const ART_TYPES: readonly BuildingType[] = ['city', 'farm', 'market', 'mine', 'oilWell', 'barracks', 'factory', 'arsenal', 'fort', 'watchtower', 'port', 'lab', 'hospital', 'airfield', 'sam', 'silo'];
export function hasArt(type: BuildingType): boolean {
  return (ART_TYPES as readonly string[]).includes(type);
}

/** The highest level the models tell apart (city level 6 uses the level 5 skyline). */
function modelLevel(type: BuildingSpec['type'], level: number): number {
  const top = Math.min(BUILDINGS[type].maxLevel, 5);
  return Math.max(1, Math.min(top, Math.round(level)));
}

/**
 * Add-ons exist only where the game has the state: flak gun pits on a fort or city of a Flak Guns holder, the radar dish
 * on a SAM site of a Tracking Radar holder, big coastal guns on a battery Port or coastal Fort of a Coastal Batteries
 * holder. (Tank traps are drawn on the trap tiles themselves, fx/defenseFx.) The two lanes exclude each other, so a
 * fort has one add-on at most.
 */
export function addonOf(type: BuildingType, s: AddonState): Addon {
  switch (type) {
    case 'fort':
      return s.flak ? 'flak' : s.guns ? 'guns' : null;
    case 'city':
      return s.flak ? 'flak' : null;
    case 'sam':
      return s.radar ? 'radar' : null;
    case 'port':
      return s.guns ? 'guns' : null;
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

/** Every spec that has art, for the size budget. */
export function allSpecs(): BuildingSpec[] {
  const out: BuildingSpec[] = [];
  for (const type of ART_TYPES) {
    const addons: Addon[] = type === 'fort' ? [null, 'flak', 'traps', 'guns'] : type === 'city' ? [null, 'flak'] : type === 'sam' ? [null, 'radar'] : type === 'port' ? [null, 'guns'] : [null];
    const top = Math.min(BUILDINGS[type].maxLevel, 5);
    for (let level = 1; level <= top; level++) for (const addon of addons) out.push({ type: type as BuildingSpec['type'], level, addon });
  }
  return out;
}

/** How the vertical space between two buildings is split between the up side and the down side (the biggest up and down reach of any picture). */
let upShare = 0;
function upShareOf(): number {
  if (upShare > 0) return upShare;
  let u = 1;
  let d = 1;
  for (const spec of allSpecs()) {
    for (const look of ['close', 'far'] as const) {
      for (let f = 0; f < (spec.type === 'port' ? 4 : 1); f++) {
        const e = rotated(modelExtent(spec, look), f);
        u = Math.max(u, e.u);
        d = Math.max(d, e.d);
      }
    }
  }
  upShare = u / (u + d);
  return upShare;
}

/** An extent turned by facing quarter turns clockwise (a port facing the sea on another side). */
export function rotated(e: Extent, facing: number): Extent {
  let o = e;
  for (let k = 0; k < facing; k++) o = { r: o.u, d: o.r, l: o.d, u: o.l };
  return o;
}

/**
 * Sideways shift (model units, times the pixel scale on screen) that puts the middle of a picture's reach on its tile: a
 * wide, lopsided picture (an airfield, a big oil field) then takes the same room to each side, so it fits tight spacing.
 * Ports turn to face the sea and are not shifted.
 */
export function balanceShift(spec: BuildingSpec, look: ArtLook): number {
  if (spec.type === 'port') return 0;
  const e = modelExtent(spec, look);
  return (e.l - e.r) / 2;
}

/** The reach of a picture as drawn: balanced left and right (see balanceShift), a port turned to its facing. */
export function drawnExtent(spec: BuildingSpec, look: ArtLook, facing: number): Extent {
  const e = rotated(modelExtent(spec, look), facing);
  if (spec.type === 'port') return e;
  const m = (e.l + e.r) / 2;
  return { l: m, r: m, u: e.u, d: e.d };
}

/** What a picture may take: the scale it is baked at (null = too small, keep the flat marker) and the room left round it for labels. */
export interface ArtFit {
  scale: number;
  chip: boolean;
  name: boolean;
}

/**
 * The art scale that fits the map: neighbours stand at least `spacing` tiles apart, so every picture may reach SPACE_SHARE/2
 * of it to each side (and the up and down reaches share the vertical space). The largest scale that fits, never above the
 * units' own scale (artScale) and in steps of SCALE_STEP; the picture is baked at that scale from the part models.
 */
export function fitScale(spec: BuildingSpec, look: ArtLook, facing: number, zoom: number, spacing: number): ArtFit | null {
  const e = drawnExtent(spec, look, facing);
  const total = SPACE_SHARE * spacing * zoom;
  const wb = total / 2;
  const ub = total * upShareOf();
  const db = total - ub;
  const raw = Math.min(artScale(zoom), wb / Math.max(e.l, e.r), ub / e.u, db / e.d);
  const scale = Math.floor(raw / SCALE_STEP + 1e-9) * SCALE_STEP;
  if (scale < MIN_ART_SCALE) return null;
  return { scale, chip: ub - e.u * scale >= CHIP_ROOM, name: db - e.d * scale >= NAME_ROOM && wb >= NAME_HALF_WIDTH };
}

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
