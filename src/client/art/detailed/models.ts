// The detailed style's unit models (client only, pure data): one model per unit and arsenal variant, rasterized by
// bake.ts at about twice the refined style's pixels. Model units are screen px at mid zoom; the nose points at +u, the
// starboard side at +v. All art is original and lives here as code.
//
// Told apart by size and silhouette first, colour second:
//   ships   the warship, destroyer, battleship, submarine, carrier, transport and trade ship: ships.ts
//   tanks   the tank division, light tank and heavy tank: tanks.ts
//   planes  the bomber, ground attack plane, heavy bomber, fighter, cargo plane and recon plane: planes.ts
//   missiles  the rocket and the atom bomb: here
// The owner's colour is only ever a small plate, band or roundel: a turret roof or deck band on ships, a funnel band,
// a recognition panel on a tank's engine deck, roundels and a fuselage band on planes.
// Upgrades change the unit you see, each file says how: the modern refit and mine rails on ships; the modern main
// battle tank, raider drums, the siege gun and the amphibious screen on tanks; jets, drop tanks, night paint, heavier
// armament and the strategic jet bomber on planes.
import { M_JET, M_MASTERY, M_NIGHT, M_PATH3, M_SPECIAL, SPRITE_KEYS, type SpriteKey } from '../shared/keys';
import type { Model, Part } from './bake';
import { box, ell, poly, seg, sym } from './shapes';
import { bomber, fighter, groundAttack, heavyBomber, reconPlane, transportPlane } from './planes';
import { battleship, carrier, destroyer, submarine, tradeShip, transport, warship } from './ships';
import { heavyTank, lightTank, mediumTank } from './tanks';

/** Which upgrade details each sprite shows (other bits are ignored, so the cache stays small). */
export const MOD_MASK: Record<SpriteKey, number> = {
  warship: M_MASTERY | M_SPECIAL,
  destroyer: M_MASTERY | M_SPECIAL,
  battleship: M_MASTERY | M_SPECIAL,
  submarine: M_MASTERY | M_SPECIAL,
  carrier: M_MASTERY | M_SPECIAL,
  transport: 0,
  tradeShip: 0,
  tankDivision: M_MASTERY | M_SPECIAL,
  lightTank: M_MASTERY | M_PATH3 | M_SPECIAL,
  heavyTank: M_MASTERY | M_PATH3 | M_SPECIAL,
  bomber: M_MASTERY | M_JET | M_SPECIAL | M_NIGHT,
  groundAttack: M_MASTERY | M_JET | M_SPECIAL | M_NIGHT,
  heavyBomber: M_MASTERY | M_PATH3 | M_SPECIAL | M_NIGHT,
  fighter: M_MASTERY | M_JET | M_SPECIAL,
  transportPlane: M_JET | M_SPECIAL,
  reconPlane: M_SPECIAL,
  rocket: 0,
  atomBomb: 0,
};

/** A propeller: hub position (model units) and blade radius. */
export interface Prop {
  u: number;
  v: number;
  z: number;
  r: number;
}
/** A jet nozzle or rocket motor: where the exhaust glows, and how wide. */
export interface Nozzle {
  u: number;
  v: number;
  z: number;
  r: number;
}

export interface UnitModel {
  /** everything baked with the hull (tanks: without the turret) */
  model: Model;
  /** a tank's turret, baked on its own so it can traverse, with the pivot it turns round (u, v) */
  turret?: { model: Model; u: number; v: number };
  /** muzzles of a ship's salvo guns (u, v, z), in firing order */
  guns: readonly (readonly [number, number, number])[];
  props: readonly Prop[];
  nozzles: readonly Nozzle[];
  /** planes and missiles: how high they fly over their shadow (model units) */
  alt: number;
  /** a moving tank kicks dust from its track ends at these (u, v) points */
  dust: readonly (readonly [number, number])[];
}

// ------------------------------------------------------------------------------------------------- helpers

/** Shading frame for a band laid over an ellipse or cylinder. */
const over = (u: number, v: number, ru: number, rv: number): readonly [number, number, number, number] => [u, v, ru, rv];

// ------------------------------------------------------------------------------------------------- missiles

function rocket(): UnitModel {
  // a slender rocket seen from above: a pale grey body with a dark band, an ogive nose, four swept fins and the motor
  const body = over(-1.4, 0, 6.4, 1.2);
  const parts: Part[] = [
    poly(sym([-3.8, -1, -6.6, -2.8, -7.8, -2.8, -7.4, -1]), 0.6, 0.4, 'hull'),
    box(-7.6, -0.7, -6.6, 0.7, 0.7, 0.8, 'gun'),
    box(-6.8, -1.2, 3.4, 1.2, 0.6, 1.3, 'sup', { sh: 'cyl', sc: body }),
    box(-2.6, -1.22, -1.4, 1.22, 0.6, 1.32, 'gun', { sh: 'cyl', sc: body }),
    poly([9, 0, 6.6, -0.8, 3.4, -1.2, 3.4, 1.2, 6.6, 0.8], 0.6, 1.3, 'sup', { sh: 'cyl', sc: over(5.4, 0, 3.4, 1.2) }),
    ell(8.2, 0, 0.9, 0.45, 0.8, 0.9, 'hazard'),
    seg(-6.6, 0, -2.8, 0, 0.4, 1.95, 0.1, 'gun'),
  ];
  return { model: { parts, flat: true }, guns: [], props: [], nozzles: [{ u: -7.8, v: 0, z: 1, r: 0.7 }], alt: 4, dust: [] };
}

function atomBomb(): UnitModel {
  // larger and fatter: a dark olive body with a yellow and black hazard band, big box fins, a blunt nose
  const body = over(-1.8, 0, 7.4, 1.9);
  const parts: Part[] = [
    poly(sym([-4.4, -1.8, -8, -3.9, -9.8, -3.9, -9.4, -1.8]), 0.6, 0.5, 'fieldgrey'),
    box(-9.8, -3.9, -8.8, 3.9, 0.7, 0.6, 'fieldgrey', { tone: -1 }),
    box(-9.4, -1, -8.4, 1, 0.8, 1.2, 'gun'),
    box(-8.6, -1.9, 4, 1.9, 0.6, 2, 'olive', { sh: 'cyl', sc: body }),
    box(-3.6, -1.93, -2.6, 1.93, 0.6, 2.03, 'hazard', { sh: 'cyl', sc: body }),
    box(-2.6, -1.93, -1.6, 1.93, 0.6, 2.03, 'black', { sh: 'cyl', sc: body }),
    box(-1.6, -1.93, -0.6, 1.93, 0.6, 2.03, 'hazard', { sh: 'cyl', sc: body }),
    poly([10.4, 0, 9, -1.1, 4, -1.9, 4, 1.9, 9, 1.1], 0.6, 2, 'olive', { sh: 'cyl', sc: over(7, 0, 4, 1.9) }),
    ell(9.8, 0, 0.7, 0.6, 1, 1.2, 'tan'),
  ];
  return { model: { parts, flat: true }, guns: [], props: [], nozzles: [{ u: -9.6, v: 0, z: 1, r: 1 }], alt: 5, dust: [] };
}

// ------------------------------------------------------------------------------------------------- lookup

const KEY_INDEX = new Map<SpriteKey, number>(SPRITE_KEYS.map((k, i) => [k, i]));
/** Models by sprite and upgrade set (a plain array: looked up for every unit every frame, so no string keys). */
const cache: (UnitModel | undefined)[] = [];
const lengths: number[] = [];

/** The model of a sprite with the given upgrade details (masked to what it can show). */
export function unitModel(key: SpriteKey, mods: number): UnitModel {
  const m = mods & MOD_MASK[key];
  const k = (KEY_INDEX.get(key) ?? 0) * 32 + m;
  let um = cache[k];
  if (um) return um;
  switch (key) {
    case 'warship':
      um = warship(m);
      break;
    case 'destroyer':
      um = destroyer(m);
      break;
    case 'battleship':
      um = battleship(m);
      break;
    case 'submarine':
      um = submarine(m);
      break;
    case 'carrier':
      um = carrier(m);
      break;
    case 'transport':
      um = transport();
      break;
    case 'tradeShip':
      um = tradeShip();
      break;
    case 'tankDivision':
      um = mediumTank(m);
      break;
    case 'lightTank':
      um = lightTank(m);
      break;
    case 'heavyTank':
      um = heavyTank(m);
      break;
    case 'bomber':
      um = bomber(m);
      break;
    case 'groundAttack':
      um = groundAttack(m);
      break;
    case 'heavyBomber':
      um = heavyBomber(m);
      break;
    case 'fighter':
      um = fighter(m);
      break;
    case 'transportPlane':
      um = transportPlane(m);
      break;
    case 'reconPlane':
      um = reconPlane(m);
      break;
    case 'rocket':
      um = rocket();
      break;
    case 'atomBomb':
      um = atomBomb();
      break;
  }
  cache[k] = um;
  return um;
}

/** A unit's length (modelLength), cached: the renderer asks for it for every unit on the map every frame. */
export function unitLength(key: SpriteKey, mods: number): number {
  const m = mods & MOD_MASK[key];
  const k = (KEY_INDEX.get(key) ?? 0) * 32 + m;
  let L = lengths[k];
  if (L === undefined) lengths[k] = L = modelLength(unitModel(key, m));
  return L;
}

/** Bow to stern / nose to tail (model units = screen px at mid zoom), counting the turret's gun on tanks. */
export function modelLength(um: UnitModel): number {
  let a = Infinity;
  let b = -Infinity;
  const take = (parts: readonly Part[], du: number): void => {
    for (const p of parts) {
      if (p.glow || (p.a ?? 1) < 1) continue;
      const q = p.p;
      if (p.k === 'ell') {
        a = Math.min(a, q[0] - q[2] + du);
        b = Math.max(b, q[0] + q[2] + du);
      } else if (p.k === 'seg') {
        a = Math.min(a, Math.min(q[0], q[2]) + du);
        b = Math.max(b, Math.max(q[0], q[2]) + du);
      } else if (p.k === 'box') {
        a = Math.min(a, q[0] + du);
        b = Math.max(b, q[2] + du);
      } else
        for (let i = 0; i < q.length; i += 2) {
          a = Math.min(a, q[i] + du);
          b = Math.max(b, q[i] + du);
        }
    }
  };
  take(um.model.parts, 0);
  if (um.turret) take(um.turret.model.parts, um.turret.u);
  return b - a;
}

/** The widest extent across (model units): a plane's span, a ship's beam. */
export function modelSpan(um: UnitModel): number {
  let a = Infinity;
  let b = -Infinity;
  for (const p of um.model.parts) {
    const q = p.p;
    if (p.k === 'ell') {
      a = Math.min(a, q[1] - q[3]);
      b = Math.max(b, q[1] + q[3]);
    } else if (p.k === 'box') {
      a = Math.min(a, q[1]);
      b = Math.max(b, q[3]);
    } else if (p.k === 'seg') {
      a = Math.min(a, q[1], q[3]);
      b = Math.max(b, q[1], q[3]);
    } else
      for (let i = 1; i < q.length; i += 2) {
        a = Math.min(a, q[i]);
        b = Math.max(b, q[i]);
      }
  }
  return b - a;
}
