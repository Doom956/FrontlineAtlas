// The detailed style's unit models (client only, pure data): one model per unit and arsenal variant, rasterized by
// bake.ts at about twice the refined style's pixels. Model units are screen px at mid zoom; the nose points at +u, the
// starboard side at +v. All art is original and lives here as code.
//
// Told apart by size and silhouette first, colour second:
//   ships        the warship, destroyer, battleship, submarine, carrier, transport and trade ship: ships.ts
//   tank division  a medium tank in olive drab; light tank: small, narrow, short gun, tan; heavy tank: wide and long,
//                an angular turret and a long gun with a muzzle brake, field grey
//   bomber       twin engines, a glazed nose, one fin; ground attack: one engine, stubby wings with rocket rails,
//                camouflage; heavy bomber: four engines on long wings, aluminium; fighter: small, elliptic wing;
//                transport plane: a fat fuselage under a high wing; recon plane: twin booms in photo-recon blue
// The owner's colour is only ever a small plate, band or roundel: a turret roof or deck band on ships, a funnel band,
// a recognition panel on a tank's engine deck, roundels and a fuselage band on planes.
// Upgrades show as real details: the modern refit (Naval Mastery) and mine rails (Naval Mines) on ships, armour skirts
// (Armor Mastery), a snorkel (Amphibious Tanks), jerrycans and a fuel drum (Deep Raids), a dozer blade (Siege Tanks),
// jet engines in place of propellers (Jet Engines), drop tanks (Drop Tanks), night paint with flame dampers (Night
// Bombing), a chequered cowling (Air Mastery) and gun turrets (Strategic Bombing).
import { M_JET, M_MASTERY, M_NIGHT, M_PATH3, M_SPECIAL, SPRITE_KEYS, type SpriteKey } from '../shared/keys';
import type { MatId, Model, Part } from './bake';
import { box, ell, poly, seg, sym } from './shapes';
import { battleship, carrier, destroyer, submarine, tradeShip, transport, warship } from './ships';

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
// ------------------------------------------------------------------------------------------------- armor

/** Tracks: the run of links (tread pattern on top and on the near side), the drive sprocket and idler. */
function tracks(u0: number, u1: number, vIn: number, vOut: number, h: number): Part[] {
  const out: Part[] = [];
  for (const s of [-1, 1]) {
    const a = Math.min(s * vIn, s * vOut);
    const b = Math.max(s * vIn, s * vOut);
    out.push(box(u0, a, u1, b, 0, h, 'track', { pat: 'tread' }));
    // fenders over the tracks
  }
  return out;
}

/** Armour skirts over both tracks (Armor Mastery). */
function skirts(u0: number, u1: number, vOut: number, z: number, h: number, m: MatId): Part[] {
  return [box(u0, -vOut - 0.55, u1, -vOut + 0.3, z, h, m, { pat: 'rivets' }), box(u0, vOut - 0.3, u1, vOut + 0.55, z, h, m, { pat: 'rivets' })];
}

/** A snorkel pipe at the rear (Amphibious Tanks). */
function snorkel(u: number, v: number, z: number): Part[] {
  return [ell(u, v, 0.55, 0.55, z, 4.4, 'gun', { sh: 'cyl' }), ell(u, v, 0.85, 0.85, z + 4.4, 0.4, 'gun')];
}

function tank(mods: number): UnitModel {
  // a medium tank in olive drab: tracks, a sloped glacis, the engine deck with grilles and the owner's recognition
  // panel, a rounded cast turret with a medium gun and a commander's cupola
  const m: MatId = 'olive';
  const hull: Part[] = [
    ...tracks(-8, 8, 3.1, 4.6, 1.9),
    poly(sym([8.6, -2.4, 7.4, -3.4, -8, -3.4, -8.4, -2.9]), 0.5, 2.1, m),
    // fenders
    box(-8.2, -4.7, 8.2, -3.3, 1.9, 0.25, m, { tone: -1 }),
    box(-8.2, 3.3, 8.2, 4.7, 1.9, 0.25, m, { tone: -1 }),
    // the glacis: a lower, darker sloped plate at the front
    poly(sym([8.6, -2.4, 7.4, -3.4, 5.6, -3.4, 5.6, 0]), 2.6, 0, m, { tone: -1 }),
    box(-7.8, -2.6, -3.6, 2.6, 2.6, 0, m, { pat: 'grille', tone: -1 }),
    box(-5.6, -2.5, -4.2, 2.5, 2.6, 0.12, 'own'),
    // hatches for the driver and the bow gunner, headlights, tools
    ell(6, -1.4, 0.65, 0.6, 2.6, 0.2, m, { tone: 1 }),
    ell(6, 1.4, 0.65, 0.6, 2.6, 0.2, m, { tone: 1 }),
    ell(8.4, -2.9, 0.35, 0.35, 2, 0.4, 'sup'),
    ell(8.4, 2.9, 0.35, 0.35, 2, 0.4, 'sup'),
    seg(-2.8, 2.9, 3.4, 2.9, 0.4, 2.6, 0.2, 'canvas'),
  ];
  if (mods & M_MASTERY) hull.push(...skirts(-7.4, 7, 4.6, 0.6, 1.5, m));
  if (mods & M_SPECIAL) hull.push(...snorkel(-6.4, -2.6, 2.6));
  // the turret round its pivot at (0.6, 0)
  const tur: Part[] = [
    ell(0, 0, 4.1, 3.3, 2.6, 2, m, { sh: 'dome' }),
    box(3, -1.5, 4.6, 1.5, 3, 1.4, m, { tone: -1 }),
    seg(4.2, 0, 11.8, 0, 0.95, 3.5, 0.75, 'gun', { sh: 'cyl' }),
    ell(-1.4, -1.3, 1, 1, 4.6, 0.55, m, { sh: 'dome' }),
    ell(-1.4, -1.3, 0.55, 0.55, 5.15, 0, m, { tone: -1 }),
    ell(-1.2, 1.5, 0.6, 0.6, 4.6, 0.12, m, { tone: 1 }),
    seg(-3.1, 1.8, -3.1, 1.8, 0.3, 4.4, 3.6, 'gun'),
  ];
  return armor(hull, tur, 0.6, 0, [
    [-8.2, -3.9],
    [-8.2, 3.9],
  ]);
}

function lightTank(mods: number): UnitModel {
  // small and quick, in tan: narrow tracks, a short hull, a little turret with a thin short gun and a tall aerial
  const m: MatId = 'tan';
  const hull: Part[] = [
    ...tracks(-6, 6, 2.4, 3.5, 1.5),
    poly(sym([6.6, -1.8, 5.6, -2.6, -6, -2.6, -6.4, -2]), 0.4, 1.7, m),
    box(-6.2, -3.6, 6.2, -2.5, 1.5, 0.22, m, { tone: -1 }),
    box(-6.2, 2.5, 6.2, 3.6, 1.5, 0.22, m, { tone: -1 }),
    box(-5.8, -2, -2.8, 2, 2.1, 0, m, { pat: 'grille', tone: -1 }),
    box(-4.6, -1.9, -3.4, 1.9, 2.1, 0.12, 'own'),
    ell(4.8, -1, 0.55, 0.5, 2.1, 0.18, m, { tone: 1 }),
    ell(6.4, -2.2, 0.3, 0.3, 1.6, 0.35, 'sup'),
    ell(6.4, 2.2, 0.3, 0.3, 1.6, 0.35, 'sup'),
  ];
  if (mods & M_MASTERY) hull.push(...skirts(-5.4, 5.2, 3.5, 0.5, 1.2, m));
  if (mods & M_PATH3) {
    // Deep Raids: jerrycans along the rear deck and a fuel drum
    for (const v of [-1.8, -0.7, 0.4]) hull.push(box(-6.7, v, -5.7, v + 0.9, 1.6, 1, 'olive', { tone: v < 0 ? 0 : 1 }));
    hull.push(ell(-6.2, 1.9, 0.75, 0.75, 1.6, 1, 'rust', { sh: 'dome' }));
  }
  if (mods & M_SPECIAL) hull.push(...snorkel(-4.4, 2, 2.1));
  const tur: Part[] = [
    poly(sym([2.6, -1.2, 1.8, -2, -2, -2, -2.6, -1.4]), 2.1, 1.4, m),
    box(2.2, -0.8, 3.2, 0.8, 2.4, 1, m, { tone: -1 }),
    seg(2.8, 0, 7.6, 0, 0.55, 2.9, 0.5, 'gun', { sh: 'cyl' }),
    ell(-0.8, 0.9, 0.7, 0.7, 3.5, 0.15, m, { tone: 1 }),
    seg(-2, -1.4, -2, -1.4, 0.25, 3.5, 4.8, 'gun'),
  ];
  return armor(hull, tur, 0.8, 0, [
    [-6.2, -3],
    [-6.2, 3],
  ]);
}

function heavyTank(mods: number): UnitModel {
  // wide and long, in field grey: broad tracks, a big flat hull, a boxy turret with spare track links on its sides
  // and a long thick gun with a muzzle brake reaching far past the nose
  const m: MatId = 'fieldgrey';
  const hull: Part[] = [
    ...tracks(-10, 10, 4, 5.9, 2.4),
    poly(sym([10.6, -3.2, 9.4, -4.3, -10, -4.3, -10.4, -3.6]), 0.6, 2.6, m),
    box(-10.2, -6, 10.4, -4.1, 2.4, 0.3, m, { tone: -1 }),
    box(-10.2, 4.1, 10.4, 6, 2.4, 0.3, m, { tone: -1 }),
    poly(sym([10.6, -3.2, 9.4, -4.3, 7, -4.3, 7, 0]), 3.2, 0, m, { tone: -1 }),
    box(-9.8, -3.3, -4.4, 3.3, 3.2, 0, m, { pat: 'grille', tone: -1 }),
    box(-7, -3.1, -5.4, 3.1, 3.2, 0.12, 'own'),
    ell(7.4, -2, 0.75, 0.7, 3.2, 0.2, m, { tone: 1 }),
    ell(7.4, 2, 0.75, 0.7, 3.2, 0.2, m, { tone: 1 }),
    seg(-3.6, 3.7, 4.4, 3.7, 0.5, 3.2, 0.25, 'gun'),
  ];
  if (mods & M_MASTERY) hull.push(...skirts(-9.6, 9.2, 5.9, 0.8, 2, m));
  if (mods & M_PATH3) {
    // Siege Tanks: a dozer blade ahead of the tracks on its arms
    // Siege Tanks: a dozer blade right at the track fronts, pushed by an arm along the outside of each track; its
    // curved face darker low down, its top edge catching the light
    for (const s of [-1, 1]) hull.push(seg(4.6, s * 6.25, 10.9, s * 6.25, 0.7, 0.7, 0.7, 'gun', { sh: 'cyl' }), ell(4.6, s * 6.25, 0.5, 0.5, 0.6, 1, 'gun'));
    hull.push(box(10.5, -6.9, 11.8, 6.9, 0.1, 1.5, 'gun', { tone: 1 }), box(10.9, -6.9, 12.6, 6.9, 1.6, 1.3, 'fieldgrey', { tone: -1 }), box(11.8, -6.9, 12.6, 6.9, 2.9, 0, 'alu', { tone: -1 }));
  }
  if (mods & M_SPECIAL) hull.push(...snorkel(-8.4, 3, 3.2));
  const shape = sym([5.4, -2.6, 4.2, -3.9, -5.4, -3.9, -6, -3.1]);
  const tur: Part[] = [
    poly(shape, 3.2, 2.6, m),
    box(4.4, -1.7, 6.2, 1.7, 3.7, 1.8, m, { tone: -1 }),
    seg(5.6, 0, 19.4, 0, 1.25, 4.6, 1, 'gun', { sh: 'cyl' }),
    box(18.6, -1, 20.6, 1, 4.5, 1.2, 'gun'),
    ell(-2.4, -1.6, 1.15, 1.15, 5.8, 0.6, m, { sh: 'dome' }),
    ell(-2.4, -1.6, 0.6, 0.6, 6.4, 0, m, { tone: -1 }),
    ell(-1.4, 1.8, 0.75, 0.7, 5.8, 0.12, m, { tone: 1 }),
    // spare track links on the turret sides
    box(-3.6, -4.15, 1.6, -3.85, 3.6, 1.6, 'track', { pat: 'tread' }),
    box(-3.6, 3.85, 1.6, 4.15, 3.6, 1.6, 'track', { pat: 'tread' }),
  ];
  return armor(hull, tur, -0.4, 0, [
    [-10.2, -5],
    [-10.2, 5],
  ]);
}

/** A tank: the hull baked with a soft ground shadow, the turret on its own round its pivot (pu, pv). */
function armor(hull: Part[], tur: Part[], pu: number, pv: number, dust: readonly (readonly [number, number])[]): UnitModel {
  return { model: { parts: hull, ground: 0.26 }, turret: { model: { parts: tur, ground: 0.2 }, u: pu, v: pv }, guns: [], props: [], nozzles: [], alt: 0, dust };
}

// ------------------------------------------------------------------------------------------------- air

/** A roundel in the owner's colour on each wing: a dark ring round the colour. */
function roundels(u: number, v: number, z: number, r: number): Part[] {
  const out: Part[] = [];
  for (const s of [-1, 1]) out.push(ell(u, s * v, r, r, z, 0, 'black', { tone: 2 }), ell(u, s * v, r * 0.72, r * 0.72, z, 0, 'own'));
  return out;
}
/** The owner band round a fuselage. */
function band(u: number, w: number, ru: number, rv: number, z: number, h: number): Part {
  return box(u - w / 2, -rv - 0.1, u + w / 2, rv + 0.1, z, h + 0.05, 'own', { sh: 'cyl', sc: over(0, 0, ru, rv), clip: [0, 0, ru, rv] });
}
/** An engine nacelle with its cowling and spinner, pointing forward. */
function nacelle(u: number, v: number, z: number, len: number, r: number, m: MatId, cowl: MatId = m): Part[] {
  return [ell(u, v, len, r, z, r * 1.1, m, { sh: 'cyl' }), ell(u + len - 0.6, v, 0.7, r, z + 0.05, r * 1.05, cowl, { sh: 'cyl' }), ell(u + len + 0.1, v, 0.45, 0.45, z + r * 0.3, 0.5, 'gun', { sh: 'dome' })];
}
/** A jet engine pod: a pale pod with a dark intake at the front and a dark nozzle at the back. */
function jetPod(u: number, v: number, z: number, len: number, r: number, m: MatId = 'alu'): Part[] {
  return [ell(u, v, len, r, z, r * 1.1, m, { sh: 'cyl' }), ell(u + len - 0.45, v, 0.5, r * 0.7, z + r * 0.2, r * 0.9, 'black'), ell(u - len + 0.3, v, 0.5, r * 0.6, z + r * 0.15, r * 0.8, 'gun')];
}
/** Two drop tanks under the wings (Drop Tanks). */
function dropTanks(u: number, v: number, z: number): Part[] {
  return [ell(u, -v, 1.9, 0.6, z, 0.7, 'alu', { sh: 'cyl' }), ell(u, v, 1.9, 0.6, z, 0.7, 'alu', { sh: 'cyl' })];
}
/** A chequered cowling ring (Air Mastery), black and white. */
function checks(u: number, v: number, z: number, r: number): Part[] {
  return [ell(u, v, 0.45, r, z, r * 1.15, 'white', { sh: 'cyl' }), ell(u, v - r * 0.5, 0.45, r * 0.32, z + 0.02, r * 1.15, 'black'), ell(u, v + r * 0.5, 0.45, r * 0.32, z + 0.02, r * 1.15, 'black')];
}

function plane(parts: Part[], props: Prop[], nozzles: Nozzle[], alt: number): UnitModel {
  return { model: { parts }, guns: [], props, nozzles, alt, dust: [] };
}

function bomber(mods: number): UnitModel {
  // twin engines on a straight wing, a glazed nose, a single fin, olive drab
  const night = !!(mods & M_NIGHT);
  const m: MatId = night ? 'night' : 'odplane';
  const jet = !!(mods & M_JET);
  const out: Part[] = [];
  const props: Prop[] = [];
  const noz: Nozzle[] = [];
  const Z = 2.4;
  if (mods & M_SPECIAL) out.push(...dropTanks(jet ? 1.4 : 3, 8.6, Z - 0.6));
  if (jet) {
    out.push(poly(sym([4.2, -1.4, -1.6, -12.6, -3.6, -12.6, -1.2, -1.4]), Z + 0.3, 0.45, m, { pat: 'panels' }));
    out.push(...jetPod(2.2, -4.6, Z - 0.5, 2.8, 0.85), ...jetPod(2.2, 4.6, Z - 0.5, 2.8, 0.85));
    noz.push({ u: -0.8, v: -4.6, z: Z - 0.2, r: 0.5 }, { u: -0.8, v: 4.6, z: Z - 0.2, r: 0.5 });
    out.push(...roundels(-1.8, 8.6, Z + 0.75, 1.1));
  } else {
    out.push(poly(sym([4.4, -1.4, 3.6, -12.8, 1.6, -13, -0.4, -1.4]), Z + 0.3, 0.45, m, { pat: 'panels' }));
    for (const s of [-1, 1]) out.push(...nacelle(2.4, s * 4.6, Z - 0.1, 3.4, 0.95, m, night ? 'black' : m), seg(0, s * 4.6, -2, s * 4.6, 0.9, Z + 0.1, 0.5, m));
    props.push({ u: 6.1, v: -4.6, z: Z + 0.4, r: 2 }, { u: 6.1, v: 4.6, z: Z + 0.4, r: 2 });
    if (mods & M_MASTERY) out.push(...checks(5.1, -4.6, Z - 0.1, 0.95), ...checks(5.1, 4.6, Z - 0.1, 0.95));
    out.push(...roundels(2.2, 9.6, Z + 0.75, 1.15));
    if (night) out.push(seg(1.6, -5.8, -0.6, -5.8, 0.4, Z + 0.3, 0.3, 'black'), seg(1.6, 5.8, -0.6, 5.8, 0.4, Z + 0.3, 0.3, 'black'));
  }
  // a slim fuselage (the cargo plane's is twice as wide)
  const ru = 10.2;
  const rv = 1.1;
  out.push(
    ell(0, 0, ru, rv, Z, 1.5, m, { sh: 'cyl' }),
    band(-4.6, 1, ru, rv, Z, 1.5),
    // the glazed nose and the cockpit
    ell(9, 0, 1.7, 0.95, Z + 0.25, 1.15, 'glass', { sh: 'dome', pat: 'frames' }),
    ell(5.2, 0, 1.4, 0.75, Z + 1.55, 0.35, 'glass', { sh: 'dome' }),
    // the tail: stabilisers and one tall fin
    poly(sym([-7.2, -0.9, -8.2, -4.6, -9.6, -4.6, -10, -0.9]), Z + 0.4, 0.35, m),
    seg(-10.2, 0, -6.8, 0, 0.6, Z + 1.4, 2.2, m),
    ell(-10.2, 0, 0.5, 0.5, Z + 0.6, 0.6, 'glass'),
  );
  return plane(out, props, noz, 7);
}

function groundAttack(mods: number): UnitModel {
  // one engine, stubby straight wings with rows of rockets on rails, a dark green and brown camouflage
  const night = !!(mods & M_NIGHT);
  const m: MatId = night ? 'night' : 'camo';
  const alt: MatId | undefined = night ? undefined : 'olive';
  const jet = !!(mods & M_JET);
  const out: Part[] = [];
  const props: Prop[] = [];
  const noz: Nozzle[] = [];
  const Z = 2.2;
  if (mods & M_SPECIAL) out.push(...dropTanks(jet ? 1.6 : 2.6, 2.6, Z - 0.6));
  // rockets under both wings, their warheads ahead of the leading edge
  const le = jet ? 2.4 : 3.2;
  for (const v of [4, 5.4, 6.8]) for (const s of [-1, 1]) out.push(seg(le - 3, s * v, le + 1.2, s * v, 0.5, Z - 0.5, 0.45, 'white', { sh: 'cyl' }), ell(le + 1.1, s * v, 0.45, 0.32, Z - 0.5, 0.45, 'brick'));
  const ru = 7.6;
  const rv = 1.25;
  if (jet) {
    out.push(poly(sym([3.6, -1.2, 2.4, -9.4, -0.6, -9.4, -1.8, -1.2]), Z + 0.2, 0.45, m, { pat: 'blotch', alt }));
    // two jet pods high on the rear fuselage
    out.push(...jetPod(-3.4, -1.9, Z + 1, 2.2, 0.85), ...jetPod(-3.4, 1.9, Z + 1, 2.2, 0.85));
    noz.push({ u: -5.9, v: -1.9, z: Z + 1.3, r: 0.5 }, { u: -5.9, v: 1.9, z: Z + 1.3, r: 0.5 });
    out.push(ell(0, 0, ru, rv, Z, 1.5, m, { sh: 'cyl', pat: 'blotch', alt }), poly([9.6, 0, 7, -1.05, 7, 1.05], Z + 0.2, 1.2, m, { sh: 'cyl', sc: over(8.2, 0, 1.4, 1.05) }));
  } else {
    out.push(poly(sym([3.8, -1.2, 3.2, -9.4, 0.6, -9.4, -1.4, -1.2]), Z + 0.2, 0.45, m, { pat: 'blotch', alt }));
    out.push(ell(0, 0, ru, rv, Z, 1.5, m, { sh: 'cyl', pat: 'blotch', alt }));
    // the big radial engine cowling and spinner
    out.push(ell(6.6, 0, 1.4, 1.6, Z - 0.1, 1.75, night ? 'black' : 'camo', { sh: 'cyl' }), ell(8.1, 0, 0.5, 0.5, Z + 0.4, 0.6, 'gun', { sh: 'dome' }));
    if (mods & M_MASTERY) out.push(...checks(7.2, 0, Z - 0.1, 1.6));
    props.push({ u: 8.4, v: 0, z: Z + 0.7, r: 2.6 });
  }
  out.push(
    band(-3.6, 0.9, ru, rv, Z, 1.5),
    ell(1.6, 0, 1.6, 0.75, Z + 1.4, 0.45, 'glass', { sh: 'dome', pat: 'frames' }),
    ...roundels(1.4, 6, Z + 0.65, 0.95),
    poly(sym([-5.4, -0.7, -6.2, -3.4, -7.4, -3.4, -7.6, -0.7]), Z + 0.3, 0.3, m),
    seg(-7.8, 0, -5.4, 0, 0.55, Z + 1.3, 1.5, m),
  );
  return plane(out, props, noz, 6);
}

function heavyBomber(mods: number): UnitModel {
  // four engines on long wings, a long fuselage, a tall fin, natural aluminium
  const night = !!(mods & M_NIGHT);
  const m: MatId = night ? 'night' : 'alu';
  const out: Part[] = [];
  const props: Prop[] = [];
  const Z = 2.6;
  if (mods & M_SPECIAL) out.push(...dropTanks(4.2, 13.4, Z - 0.6));
  out.push(poly(sym([5, -1.8, 3.6, -18.6, 1.4, -18.8, -1.6, -1.8]), Z + 0.3, 0.5, m, { pat: 'panels' }));
  for (const v of [-10.6, -5.4, 5.4, 10.6]) {
    out.push(...nacelle(3.4, v, Z - 0.1, 3.1, 0.85, m, night ? 'black' : 'gun'));
    props.push({ u: 6.8, v, z: Z + 0.35, r: 1.9 });
    if (mods & M_MASTERY) out.push(...checks(5.8, v, Z - 0.1, 0.85));
  }
  const ru = 13;
  const rv = 1.6;
  out.push(
    ell(0, 0, ru, rv, Z, 1.9, m, { sh: 'cyl', pat: 'panels' }),
    band(-6.6, 1.1, ru, rv, Z, 1.9),
    ...roundels(1.6, 14.2, Z + 0.85, 1.25),
    ell(11.4, 0, 1.7, 1.2, Z + 0.3, 1.4, 'glass', { sh: 'dome', pat: 'frames' }),
    ell(8, 0, 1.4, 0.8, Z + 1.85, 0.35, 'glass', { sh: 'dome' }),
    poly(sym([-9.4, -1.1, -10.8, -6.6, -12.6, -6.6, -13, -1.1]), Z + 0.4, 0.35, m),
    seg(-13.2, 0, -8.4, 0, 0.7, Z + 1.7, 2.8, m),
  );
  if (night) for (const v of [-10.6, -5.4, 5.4, 10.6]) out.push(seg(2, v - 1, -0.4, v - 1, 0.4, Z + 0.4, 0.3, 'black'));
  if (mods & M_PATH3) {
    // Strategic Bombing: chin, dorsal and tail gun turrets
    out.push(ell(10.2, 0, 0.9, 0.9, Z - 0.2, 0.7, 'glass', { sh: 'dome' }), ell(4.6, 0, 1.1, 1, Z + 1.9, 0.6, 'glass', { sh: 'dome', pat: 'frames' }), ell(-13.6, 0, 0.9, 0.85, Z + 0.4, 1.1, 'glass', { sh: 'dome' }), seg(-14, 0, -15.6, 0, 0.3, Z + 0.9, 0.2, 'gun'));
  }
  return plane(out, props, [], 9);
}

function fighter(mods: number): UnitModel {
  // small and fast: an elliptic wing, a slim fuselage, a bubble canopy, sea grey; the jet a swept wing and a nose
  // intake
  const m: MatId = 'seagrey';
  const out: Part[] = [];
  const props: Prop[] = [];
  const noz: Nozzle[] = [];
  const Z = 2.2;
  const ru = 6.6;
  const rv = 0.95;
  if (mods & M_JET) {
    if (mods & M_SPECIAL) out.push(...dropTanks(0.6, 3.6, Z - 0.5));
    out.push(poly(sym([1.6, -0.9, -3.6, -6.6, -5, -6.6, -3.6, -0.9]), Z + 0.15, 0.35, m));
    out.push(ell(0, 0, ru + 0.4, rv + 0.1, Z, 1.15, m, { sh: 'cyl' }), ell(6.6, 0, 0.45, 0.6, Z + 0.25, 0.7, 'black'));
    out.push(poly(sym([-4.6, -0.5, -6.2, -2.8, -7.2, -2.8, -6.8, -0.5]), Z + 0.3, 0.3, m), seg(-7, 0, -4.2, 0, 0.45, Z + 1, 1.5, m));
    noz.push({ u: -7.1, v: 0, z: Z + 0.5, r: 0.5 });
    out.push(...roundels(-3.2, 4.4, Z + 0.5, 0.75));
    if (mods & M_MASTERY) out.push(seg(-6.9, 0, -4.4, 0, 0.47, Z + 2.2, 0.3, 'white'));
  } else {
    if (mods & M_SPECIAL) out.push(...dropTanks(1.6, 3.2, Z - 0.5));
    // the elliptic wing as two half ellipses
    out.push(ell(0.6, 0, 1.9, 7.4, Z + 0.15, 0.35, m, { clipPoly: [3, -7.6, 3, 7.6, -1.4, 7.6, -1.4, -7.6] }));
    out.push(ell(0, 0, ru, rv, Z, 1.15, m, { sh: 'cyl' }), ell(5.4, 0, 0.9, 0.95, Z, 1.15, m, { sh: 'cyl' }), ell(6.6, 0, 0.42, 0.42, Z + 0.3, 0.5, 'gun', { sh: 'dome' }));
    if (mods & M_MASTERY) out.push(...checks(5.6, 0, Z, 0.95));
    props.push({ u: 6.9, v: 0, z: Z + 0.55, r: 2.1 });
    out.push(poly(sym([-4.2, -0.5, -4.8, -2.6, -6, -2.6, -6.3, -0.5]), Z + 0.3, 0.3, m), seg(-6.4, 0, -4.2, 0, 0.45, Z + 1, 1.4, m));
    out.push(...roundels(0.4, 4.6, Z + 0.5, 0.8));
  }
  out.push(band(-3, 0.7, ru, rv, Z, 1.15), ell(1, 0, 1.25, 0.6, Z + 1.1, 0.35, 'glass', { sh: 'dome' }));
  return plane(out, props, noz, 6);
}

function transportPlane(mods: number): UnitModel {
  // the cargo plane that carries the paratroopers: a deep, round fuselage about twice as wide as the bomber's and
  // longer, a high straight wing set over it with two engines, a big cargo door, a two-tone grey finish and black and
  // white invasion stripes round the wings and the rear fuselage (nothing like the slim olive bomber)
  const m: MatId = 'cargo';
  const alt: MatId = 'cargoDark';
  const jet = !!(mods & M_JET);
  const out: Part[] = [];
  const props: Prop[] = [];
  const noz: Nozzle[] = [];
  const Z = 2.2;
  const ru = 13;
  const rv = 2.3;
  const fus = over(0, 0, ru, rv);
  out.push(
    ell(0, 0, ru, rv, Z, 2.6, m, { sh: 'cyl', pat: 'blotch', alt }),
    // invasion stripes round the rear fuselage: white, black, white, black, white
    ...[0, 1, 2, 3, 4].map((i) => box(-7.4 + i * 0.75, -rv - 0.1, -6.65 + i * 0.75, rv + 0.1, Z, 2.65, i % 2 ? 'black' : 'white', { sh: 'cyl', sc: fus, clip: [0, 0, ru, rv] })),
    band(-3.2, 1.1, ru, rv, Z, 2.6),
    // the big cargo door on the port side, its frame darker
    box(-5.8, -2.35, -3.8, -1.75, Z + 1, 0, 'cargoDark', { edge: true, tone: -1 }),
    ell(11.2, 0, 1.3, 1.5, Z + 1.8, 0.6, 'glass', { sh: 'dome', pat: 'frames' }),
    poly(sym([-9.8, -1.4, -11, -6.4, -12.6, -6.4, -13, -1.4]), Z + 1.3, 0.35, m),
    seg(-13.2, 0, -9, 0, 0.8, Z + 2.4, 2.8, m),
  );
  if (mods & M_SPECIAL) out.push(...dropTanks(jet ? 0.8 : 2.6, 10.8, Z + 1.7));
  // the high wing sits on top of the fuselage
  const WZ = Z + 2.5;
  const wing = jet ? sym([3.8, -1.8, -2.2, -15.4, -4.2, -15.4, -1.4, -1.8]) : sym([3.8, -1.8, 3, -15.4, 0.8, -15.6, -1.6, -1.8]);
  out.push(poly(wing, WZ, 0.45, m, { pat: 'panels' }));
  // invasion stripes on both wings, outboard of the engines
  for (const sd of [-1, 1]) for (let i = 0; i < 5; i++) {
    const v0 = sd * (7.6 + i * 0.7);
    out.push(box(-6, Math.min(v0, v0 + sd * 0.7), 6, Math.max(v0, v0 + sd * 0.7), WZ + 0.45, 0, i % 2 ? 'black' : 'white', { clipPoly: wing }));
  }
  if (jet) {
    for (const v of [-5.2, 5.2]) {
      out.push(...jetPod(1.8, v, WZ - 1.1, 2.6, 0.95));
      noz.push({ u: -0.7, v, z: WZ - 0.7, r: 0.55 });
    }
    out.push(...roundels(-2.6, 12, WZ + 0.45, 1.25));
  } else {
    for (const v of [-5.2, 5.2]) {
      out.push(...nacelle(2.2, v, WZ - 0.8, 3.2, 1, m, 'gun'));
      props.push({ u: 5.8, v, z: WZ - 0.2, r: 2.3 });
    }
    out.push(...roundels(1.4, 12.2, WZ + 0.45, 1.25));
  }
  return plane(out, props, noz, 8);
}

function reconPlane(mods: number): UnitModel {
  // twin booms with an engine each, a short central pod with a long glazed nose, photo-recon blue
  const m: MatId = 'prublue';
  const out: Part[] = [];
  const props: Prop[] = [];
  const Z = 2.2;
  if (mods & M_SPECIAL) out.push(...dropTanks(2.4, 6.8, Z - 0.6));
  out.push(poly(sym([3, -1.2, 2.4, -12, 0.8, -12.2, -0.8, -1.2]), Z + 0.25, 0.4, m));
  for (const s of [-1, 1]) {
    out.push(seg(4.8, s * 3.4, -9.4, s * 3.4, 1.15, Z, 1.1, m, { sh: 'cyl' }), ell(4.4, s * 3.4, 1.4, 0.9, Z - 0.1, 1.3, m, { sh: 'cyl' }), ell(6, s * 3.4, 0.4, 0.4, Z + 0.4, 0.5, 'gun', { sh: 'dome' }));
    out.push(seg(-10.2, s * 3.4, -8.2, s * 3.4, 0.45, Z + 1, 1.6, m));
    props.push({ u: 6.3, v: s * 3.4, z: Z + 0.6, r: 1.9 });
  }
  out.push(box(-10.2, -3.4, -8.6, 3.4, Z + 0.4, 0.35, m));
  out.push(ell(1.8, 0, 5.2, 1.15, Z, 1.25, m, { sh: 'cyl' }), band(-1.6, 0.8, 5.2, 1.15, Z, 1.25));
  out.push(ell(6.4, 0, 1.4, 0.9, Z + 0.15, 1, 'glass', { sh: 'dome', pat: 'frames' }), ell(2.6, 0, 1.3, 0.6, Z + 1.2, 0.3, 'glass', { sh: 'dome' }));
  // a camera window under the nose
  out.push(ell(4.4, 0, 0.45, 0.45, Z + 1.25, 0, 'black'));
  out.push(...roundels(1.4, 8.2, Z + 0.65, 1));
  return plane(out, props, [], 7);
}

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
      um = tank(m);
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
