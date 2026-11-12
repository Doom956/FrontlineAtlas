// What a realistic unit is made of (client only): the painted layers of one unit model and where its moving parts
// sit. units.ts bakes each layer into the style's atlas and puts them together on the map every frame:
//   body    everything that never changes with the owner (hull, deck, turrets, wings), baked per heading bucket
//   owner   the owner's marks only (a deck band, a funnel, roundels), baked per heading bucket and owner colour: a small
//           picture, so a map with many nations does not multiply the big one
//   shadow  the soft ground shadow, baked once facing east and turned freely (ships on the water, planes on the ground
//           far below them, offset by their height)
//   turret  a tank's turret with its owner marks, drawn turning round its ring (turret sway)
// Art units: the bow or nose at +x, starboard at +y, the unit's centre at the origin; one art unit is one CSS px at
// map scale 1 (render/units.ts spriteScale).
import { ownerRamp } from '../shared/colour';
import type { Col, Paint } from './paint';

/** A box in art units round everything a layer paints (its cast shadows included). */
export interface Bounds {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface Layer {
  b: Bounds;
  paint(p: Paint): void;
}

/** The owner's colour as four painted tones (deep, dark, base, light), evened so a very dark or pale colour shows. */
export interface Tones {
  deep: Col;
  dark: Col;
  base: Col;
  light: Col;
}

export function tonesOf(owner: readonly number[]): Tones {
  const r = ownerRamp(owner);
  return { deep: r[0], dark: r[1], base: r[2], light: r[3] };
}

export interface OwnerLayer {
  b: Bounds;
  paint(p: Paint, t: Tones): void;
}

export interface Prop {
  x: number;
  y: number;
  /** blade radius (art units) */
  r: number;
}

export interface UnitModel {
  /** length along the heading (art units): what lengthPx reports */
  len: number;
  /** the larger of the length and the span: what must fit a portrait box */
  fit: number;
  body: Layer;
  /** the owner's marks, in up to four small parts (each baked on its own, so far apart marks stay small pictures) */
  owners?: OwnerLayer[];
  /** the ground shadow, drawn on its own and turned freely */
  shadow?: Layer;
  /** height of the shadow's offset at rest (art units): ships about 1, planes their altitude */
  alt: number;
  /** a tank's turret: drawn over the body, turning round (x, y) */
  turret?: { x: number; y: number; layer: OwnerLayer };
  /** planes: the starboard wing's silhouette, shaded toward the tip (the lower wing in a bank; mirrored for port) */
  wingShade?: Layer;
  /** spinning propellers (planes without jets) */
  props?: readonly Prop[];
  /** a missile's exhaust: its nozzle at x (art units, at the tail) and the flame's size */
  flame?: { x: number; r: number };
  /** ships: the guns of a salvo (fx/pixelFx.ts SALVO), as (x, y) art units */
  guns?: readonly (readonly [number, number])[];
  /** ships: half the beam (art units), for the wake */
  beam?: number;
  /** ships: where the stern is (art units, negative) */
  stern?: number;
  /** tanks: the back of the hull (x) and the tracks' distance from the centre line (y), where dust is kicked up */
  dust?: { x: number; y: number };
}

export const bounds = (x0: number, y0: number, x1: number, y1: number): Bounds => ({ x0, y0, x1, y1 });
