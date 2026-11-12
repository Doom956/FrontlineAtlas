// The refined style's unit art (client only): one small model per unit and arsenal variant, rasterized by
// spriteBake.ts. Model units are art pixels at full size; the nose points at +u, the starboard side at +v. All art is
// original and lives here as code.
//
// Every unit is told apart by SIZE and SILHOUETTE first, colour second (lengths in art px at mid zoom):
//   carrier (50)      the biggest: a long flat flight deck overhanging the hull, painted edge and centre lines,
//                     elevators, the island on the starboard side, small planes parked fore and aft
//   battleship (44)   long, broad and heavy: three big twin turrets (two forward, the second raised), a tall tower
//                     superstructure, one big funnel, secondary guns along the sides, a teak deck
//   warship (34)      the plain warship (before an arsenal pick) is a mid-size cruiser: a turret fore and aft, a bridge,
//                     two funnels, a mast, a teak deck
//   destroyer (26)    small and slim: a single gun fore and aft, two torpedo tube mounts, one raked funnel, grey deck
//   submarine (30)    long, low and dark, the bow and stern awash under the sea, the conning tower its only raised part
//   transport (25)    a boxy landing ship: a bow ramp, an open well deck full of troops and two trucks, the bridge aft
//   trade ship (36)   a merchant hull (black with a red boot top), cargo hatches and derrick cranes, containers, a cream
//                     superstructure aft with the funnel in the owner's colours: no guns
//   tank division (24)  a medium tank: tracks, a round turret, a medium gun (olive drab)
//   light tank (20)   small and quick: narrow tracks, a little turret, a thin short gun, an aerial (dark yellow)
//   heavy tank (35)   wide and long: broad tracks under side skirts, an angular turret, a long gun with a muzzle brake
//   bomber            twin engines, straight wings, glazed nose
//   ground attack     single engine, stubby wings with rows of rockets under them (green)
//   heavy bomber      four engines on long wings, twin tail fins, natural metal (the biggest plane)
//   fighter           small: one engine, short wings, a bubble canopy (the smallest plane)
//   transport plane   a fat fuselage under a high wing, two engines, a tall tail (it carries the paratroopers)
//   recon plane       twin booms, a short glazed central nacelle
// Planes have no propeller blades in the model: Model.props lists the hubs and sprites.ts draws spinning discs.
// Upgrades a player owns add real details, never an owner hue: radar and extra anti-aircraft guns (Naval Mastery),
// mines on stern rails (Naval Mines), armour skirts (Armor Mastery), jerrycans and a fuel drum (Deep Raids), a dozer
// ram (Siege Tanks), a snorkel (Amphibious Tanks), jet pods with a hot exhaust and swept wings (Jet Engines), gun
// turrets (Strategic Bombing), drop tanks (Drop Tanks), black night paint (Night Bombing), a brass tail (Air Mastery).
// The owner's colour: the bridge roof and turret roofs of warships (air recognition paint), the funnel of a trade ship,
// a toned-down plate under each tank plus a turret band, a fuselage band and wingtips on planes.
import type { MatId, Model, Part, Pattern, Prop, Shade } from './spriteBake';
import { M_JET, M_MASTERY, M_NIGHT, M_PATH3, M_SPECIAL, SPRITE_KEYS, type SpriteKey } from '../shared/keys';

// The unit keys and upgrade bits are shared by every style (art/shared/keys.ts); re-exported for the refined art.
export { M_JET, M_MASTERY, M_NIGHT, M_PATH3, M_SPECIAL, SPRITE_KEYS, type SpriteKey };

/** Which upgrade details each sprite can show (other bits are ignored, so the cache stays small). */
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

/** Sprites with a flickering flame (two frames). */
export const ANIMATED: ReadonlySet<SpriteKey> = new Set<SpriteKey>(['rocket', 'atomBomb']);

/**
 * Where the turrets of a salvo sit (model u along the hull, height z of the turret roof), by ship, in the order
 * fx/pixelFx.ts fires them (SALVO: the plain warship 2, the destroyer 2, the battleship 3). sprites.ts turretPoint
 * projects them.
 */
export const GUNS: Partial<Record<SpriteKey, readonly (readonly [number, number])[]>> = {
  warship: [
    [9.8, 4.1],
    [-12.2, 4.1],
  ],
  // a single gun fore and one aft
  destroyer: [
    [7.6, 3.5],
    [-10, 3.5],
  ],
  battleship: [
    [13.6, 4.5],
    [8, 5.6],
    [-14.6, 4.5],
  ],
};

/** How high a plane flies over its shadow (art px): low and fast attackers low, the big bombers high. */
export const ALTITUDE: Partial<Record<SpriteKey, number>> = {
  fighter: 6,
  groundAttack: 4,
  bomber: 7,
  heavyBomber: 8,
  transportPlane: 6,
  reconPlane: 8,
  rocket: 3,
  atomBomb: 3,
};

// ------------------------------------------------------------------------------------------------- helpers

interface Opt {
  sh?: Shade;
  pat?: Pattern;
  a?: number;
  wash?: boolean;
  glow?: boolean;
  inset?: boolean;
  sc?: readonly [number, number, number, number];
  clip?: readonly number[];
  clipPoly?: readonly number[];
}
const box = (u0: number, v0: number, u1: number, v1: number, z: number, h: number, m: MatId, o: Opt = {}): Part => ({ k: 'box', p: [u0, v0, u1, v1], z, h, m, ...o });
const ell = (u: number, v: number, ru: number, rv: number, z: number, h: number, m: MatId, o: Opt = {}): Part => ({ k: 'ell', p: [u, v, ru, rv], z, h, m, ...o });
const poly = (p: number[], z: number, h: number, m: MatId, o: Opt = {}): Part => ({ k: 'poly', p, z, h, m, ...o });
const seg = (u0: number, v0: number, u1: number, v1: number, w: number, z: number, h: number, m: MatId, o: Opt = {}): Part => ({ k: 'seg', p: [u0, v0, u1, v1, w], z, h, m, ...o });
/** A polygon given by its port half (v <= 0, bow to stern), closed through its mirror. */
function sym(half: number[]): number[] {
  const out = [...half];
  for (let i = half.length - 2; i >= 0; i -= 2) if (half[i + 1] !== 0) out.push(half[i], -half[i + 1]);
  return out;
}
/** The same parts on both sides (v mirrored). */
function both(make: (s: 1 | -1) => Part[]): Part[] {
  return [...make(-1), ...make(1)];
}
/**
 * A ship hull seen from above: a fine bow that flares over `bow` model units to the full half beam `b`, straight sides,
 * and a stern that rounds in over `stern` units to a transom `transom` of the beam wide.
 */
function hullShape(L: number, b: number, bow: number, stern: number, transom = 0.62): number[] {
  return sym([L, 0, L - bow * 0.3, -b * 0.42, L - bow * 0.64, -b * 0.82, L - bow, -b, -L + stern, -b, -L + stern * 0.35, -b * 0.88, -L, -b * transom]);
}
/**
 * The owner plate under a vehicle: a flat slab in the toned-down owner colour (a darker rim on the lower and right
 * edge), a little larger than the vehicle, so who it belongs to reads at a glance without a bright slab.
 */
const plate = (u0: number, u1: number, v: number, c: number): Part => poly(sym([u1, -v + c, u1 - c, -v, u0 + c, -v, u0, -v + c]), 0, 0.3, 'ownDim', { sh: 'plate' });
/** A part list scaled about the origin (footprints, heights stay). */
function scaled(parts: Part[], k: number): Part[] {
  const sc = (q: readonly number[] | undefined, all: boolean): number[] | undefined => q && q.map((x, i) => (all || i < 2 || i === 2 || i === 3 ? x * k : x));
  return parts.map((p) => ({
    ...p,
    p: p.k === 'seg' ? [p.p[0] * k, p.p[1] * k, p.p[2] * k, p.p[3] * k, p.p[4] * k] : p.p.map((x) => x * k),
    sc: p.sc ? ([p.sc[0] * k, p.sc[1] * k, p.sc[2] * k, p.sc[3] * k] as const) : undefined,
    clip: sc(p.clip, true),
    clipPoly: sc(p.clipPoly, true),
  }));
}
/**
 * A thin model moved half a pixel row to the side (+v), so its centre line runs through the middle of a pixel row
 * when it flies east or west and through a pixel column going north or south: a pointed nose then ends in one
 * pixel and the body is an odd number of pixels tall, instead of the tip falling between two rows and vanishing.
 */
function centred(parts: Part[], dv = 0.6): Part[] {
  const mv = (q: readonly number[] | undefined, k: 'box' | 'ell' | 'poly' | 'seg' | 'clip'): number[] | undefined => {
    if (!q) return undefined;
    if (k === 'poly') return q.map((x, i) => (i % 2 ? x + dv : x));
    if (k === 'box') return [q[0], q[1] + dv, q[2], q[3] + dv];
    if (k === 'seg') return [q[0], q[1] + dv, q[2], q[3] + dv, q[4]];
    return q.map((x, i) => (i === 1 ? x + dv : x));
  };
  return parts.map((p) => ({
    ...p,
    p: mv(p.p, p.k)!,
    sc: p.sc ? ([p.sc[0], p.sc[1] + dv, p.sc[2], p.sc[3]] as const) : undefined,
    clip: mv(p.clip, 'clip'),
    clipPoly: mv(p.clipPoly, 'poly'),
  }));
}
/** A dome / cylinder shading frame for a band laid over an ellipse. */
const over = (u: number, v: number, ru: number, rv: number): readonly [number, number, number, number] => [u, v, ru, rv];

// ------------------------------------------------------------------------------------------------- navy

/** A sea mine on a stern rail: a dark sphere with a brass horn on top (never an owner hue). */
function mine(u: number, v: number, z: number): Part[] {
  return [ell(u, v, 1.1, 1.1, z, 0.9, 'black', { sh: 'dome' }), ell(u - 0.1, v - 0.1, 0.5, 0.5, z + 0.9, 0, 'gold')];
}
/** A pair of mine rails at the stern, two mines each (Naval Mines). */
function mines(u: number, v: number, z: number): Part[] {
  return [box(u - 3.4, -v - 0.4, u + 0.6, -v + 0.4, z, 0, 'gun'), box(u - 3.4, v - 0.4, u + 0.6, v + 0.4, z, 0, 'gun'), ...mine(u, -v, z), ...mine(u - 2.4, -v, z), ...mine(u, v, z), ...mine(u - 2.4, v, z)];
}
/** A small twin anti-aircraft mount in a round tub (Naval Mastery): two thin barrels pointing up and out. */
function aaMount(u: number, v: number, z: number, dir = 1): Part[] {
  return [ell(u, v, 1.15, 1.05, z, 0.7, 'turret'), ell(u, v, 0.6, 0.55, z + 0.7, 0.3, 'gun'), seg(u + 0.2, v - 0.35, u + 2.1 * dir, v - 0.35, 0.5, z + 0.9, 0.3, 'gun'), seg(u + 0.2, v + 0.35, u + 2.1 * dir, v + 0.35, 0.5, z + 0.9, 0.3, 'gun')];
}
/** A radar on a mast top: a pale lattice bar across the ship (Naval Mastery). */
function radar(u: number, z: number, w: number): Part[] {
  return [box(u - 0.6, -w, u + 0.6, w, z, 0.8, 'white', { pat: 'grille' }), ell(u, 0, 0.6, 0.6, z - 1.6, 1.6, 'gun')];
}
/**
 * A gun turret: a dark ring at deck level round a flat-topped turret with its roof in the owner's colour (air
 * recognition paint), and one to three barrels toward `dir` (1 forward, -1 aft) reaching past it.
 */
function turretAt(u: number, ru: number, rv: number, z: number, dir: 1 | -1, barrels: number[], len: number, w = 0.9): Part[] {
  const out: Part[] = [ell(u, 0, ru + 0.7, rv + 0.7, z, 0, 'gun'), ell(u, 0, ru, rv, z, 1.3, 'turret')];
  // the roof: a recognition panel set in from the turret's edge
  out.push(ell(u - dir * 0.15, 0, Math.max(0.6, ru - 0.75), Math.max(0.6, rv - 0.75), z + 1.3, 0, 'own'));
  for (const v of barrels) out.push(seg(u + dir * (ru - 0.5), v, u + dir * (ru + len), v, w, z + 0.7, 0.5, 'gun', { sh: 'cyl' }));
  return out;
}
/** A funnel: haze grey with a dark cap; `rake` moves the top aft (a raked funnel). */
function funnel(u: number, ru: number, rv: number, z: number, h: number, rake = 0, m: MatId = 'sup'): Part[] {
  if (!rake) return [ell(u, 0, ru, rv, z, h, m, { sh: 'cyl' }), ell(u, 0, ru * 0.62, rv * 0.62, z + h, 0, 'black')];
  return [ell(u, 0, ru, rv, z, h * 0.5, m, { sh: 'cyl' }), ell(u - rake, 0, ru, rv, z + h * 0.5, h * 0.5, m, { sh: 'cyl' }), ell(u - rake, 0, ru * 0.62, rv * 0.62, z + h, 0, 'black')];
}
/** A mast: a thin dark post with a yard across it. */
function mast(u: number, z: number, h: number, yard: number): Part[] {
  return [ell(u, 0, 0.55, 0.55, z, h, 'gun'), seg(u, -yard, u, yard, 0.5, z + h * 0.8, 0.2, 'gun')];
}
/** A ship's boat in davits on the deck edge. */
function boat(u: number, v: number, z: number, len = 1.8): Part {
  return ell(u, v, len, 0.75, z, 0.7, 'white', { sh: 'cyl' });
}

function warship(mods: number): Part[] {
  // a mid-size cruiser: a turret fore and aft, a bridge, two funnels, a mast, a teak deck
  const out: Part[] = [
    poly(hullShape(17, 3.3, 8.5, 4.5, 0.55), 0, 2.8, 'hull'),
    poly(hullShape(16.1, 2.65, 8, 4, 0.55), 2.8, 0, 'deck', { inset: true }),
    ...turretAt(9.8, 2, 1.8, 2.8, 1, [-0.75, 0.75], 4.2),
    // the bridge: a two-deck block, its windows forward, the roof in the owner colour
    box(1.6, -2.5, 6.6, 2.5, 2.8, 2.4, 'sup'),
    box(3.4, -1.8, 6.2, 1.8, 5.2, 1.7, 'sup'),
    box(5.7, -1.6, 6.2, 1.6, 6.9, 0, 'glass'),
    box(3.6, -1.6, 5.7, 1.6, 6.9, 0, 'own'),
    ...mast(2.6, 5.2, 4.2, 2),
    // two funnels and the boats between them
    ...funnel(-0.8, 1.35, 1.2, 2.8, 3.8),
    ...funnel(-4.6, 1.35, 1.2, 2.8, 3.8),
    boat(-2.7, -2.4, 2.8),
    boat(-2.7, 2.4, 2.8),
    // the aft deckhouse with a small mast
    box(-9.6, -2.1, -6.6, 2.1, 2.8, 1.6, 'sup'),
    ell(-7.8, 0, 0.45, 0.45, 4.4, 2.2, 'gun'),
    ...turretAt(-12.2, 2, 1.8, 2.8, -1, [-0.75, 0.75], 3.8),
  ];
  if (mods & M_MASTERY) out.push(...radar(2.6, 9.8, 1.8), ...aaMount(-8.1, -1.1, 4.4, -1), ...aaMount(-8.1, 1.1, 4.4, -1), ...aaMount(0.6, -3, 2.8), ...aaMount(0.6, 3, 2.8));
  if (mods & M_SPECIAL) out.push(...mines(-14.4, 1.5, 2.8));
  return out;
}

function destroyer(mods: number): Part[] {
  // small and slim: one gun fore and aft, torpedo tubes amidships, a raked funnel, a grey steel deck
  const out: Part[] = [
    poly(hullShape(13, 2.5, 6.5, 2.6, 0.55), 0, 2.2, 'hull'),
    poly(hullShape(12.2, 1.9, 6.1, 2.3, 0.55), 2.2, 0, 'deckGrey', { inset: true }),
    ...turretAt(7.6, 1.35, 1.2, 2.2, 1, [0], 3.4, 0.9),
    box(2.6, -1.75, 5.4, 1.75, 2.2, 2.1, 'sup'),
    box(5, -1.4, 5.4, 1.4, 4.3, 0, 'glass'),
    box(2.8, -1.3, 4.9, 1.3, 4.3, 0, 'own'),
    ...mast(2.2, 4.3, 3, 1.4),
    ...funnel(-0.4, 1.2, 1.05, 2.2, 3.6, 1.1),
    // two torpedo tube mounts on the centre line
    ell(-3.7, 0, 1.05, 1.05, 2.2, 0.4, 'gun'),
    box(-5.4, -1.05, -2, 1.05, 2.6, 0.6, 'turret', { pat: 'tubes' }),
    ell(-7.3, 0, 1.05, 1.05, 2.2, 0.4, 'gun'),
    box(-9, -1.05, -5.6, 1.05, 2.6, 0.6, 'turret', { pat: 'tubes' }),
    ...turretAt(-10, 1.2, 1.05, 2.2, -1, [0], 2.6, 0.8),
    // depth charge racks on the stern
    box(-12.4, -1.4, -11.4, -0.6, 2.2, 0.5, 'gun'),
    box(-12.4, 0.6, -11.4, 1.4, 2.2, 0.5, 'gun'),
  ];
  if (mods & M_MASTERY) out.push(...radar(2.2, 7.3, 1.3), ...aaMount(1.2, -1.9, 2.2), ...aaMount(1.2, 1.9, 2.2));
  if (mods & M_SPECIAL) out.push(...mines(-10.6, 1.2, 2.2).map((p) => ({ ...p, z: p.z + 0.1 })));
  return out;
}

function battleship(mods: number): Part[] {
  // long, broad and heavy: two big turrets forward (the second raised), a tower, one big funnel, one turret aft
  const out: Part[] = [
    poly(hullShape(22, 4.8, 10, 5.5, 0.7), 0, 3.2, 'hull'),
    poly(hullShape(21, 4.05, 9.6, 5, 0.7), 3.2, 0, 'deck', { inset: true }),
    ...turretAt(13.6, 2.8, 2.5, 3.2, 1, [-1, 1], 5, 1),
    ell(8, 0, 3.5, 3.1, 3.2, 1.1, 'hull'),
    ...turretAt(8, 2.8, 2.5, 4.3, 1, [-1, 1], 4.6, 1),
    // the superstructure: a wide base, a second deck, the tall tower with the bridge at the top
    box(-5, -3.5, 4.2, 3.5, 3.2, 1.7, 'sup'),
    box(-2, -2.6, 3.4, 2.6, 4.9, 1.9, 'sup'),
    box(0.4, -1.7, 2.9, 1.7, 6.8, 3.6, 'sup'),
    box(2.4, -1.5, 2.9, 1.5, 10.4, 0, 'glass'),
    box(0.6, -1.3, 2.4, 1.3, 10.4, 0, 'own'),
    ...mast(-0.6, 6.8, 5.4, 2.4),
    ...funnel(-6.4, 2, 1.8, 3.2, 4.4),
    // the aft deckhouse
    box(-10.6, -2.5, -8.2, 2.5, 3.2, 1.4, 'sup'),
    ...turretAt(-14.6, 2.8, 2.5, 3.2, -1, [-1, 1], 5, 1),
  ];
  // secondary guns along both sides
  for (const u of [3.4, -0.8, -5]) out.push(...both((s) => [ell(u, s * 4, 0.95, 0.85, 3.2, 0.8, 'turret'), seg(u + 0.3, s * 4, u + 2.2, s * 4.3, 0.5, 3.6, 0.3, 'gun')]));
  if (mods & M_MASTERY) out.push(...radar(-0.6, 12.4, 2.2), ...aaMount(-9.4, -1.3, 4.6, -1), ...aaMount(-9.4, 1.3, 4.6, -1), ...aaMount(5.8, -3.4, 3.2), ...aaMount(5.8, 3.4, 3.2));
  if (mods & M_SPECIAL) out.push(...mines(-18.4, 1.8, 3.2));
  return out;
}

function submarine(mods: number): Part[] {
  const out: Part[] = [
    // the long dark hull, low on the water: a light deck casing on top, a darker keel side
    ell(0, 0, 15, 2.1, 0, 0.6, 'sub', { sh: 'cyl' }),
    seg(-11, 0, 10.5, 0, 1.3, 0.6, 0, 'deckGrey'),
    // the stern planes and rudder, under the water
    poly(sym([-13.2, 0, -14.6, -2.2, -15.4, -2.2, -15.2, 0]), 0, 0.4, 'sub'),
    // the deck gun forward of the tower
    ell(6.2, 0, 0.8, 0.8, 0.6, 0.5, 'sub'),
    seg(6.4, 0, 9, 0, 0.6, 1, 0.4, 'gun', { sh: 'cyl' }),
    // the conning tower: the bridge well on top (the owner colour on its rim), periscopes and a mast
    poly([5.2, 0, 4, -1.25, 0, -1.3, -1.6, -0.8, -1.6, 0.8, 0, 1.3, 4, 1.25], 0.6, 2.6, 'sub'),
    poly([4.4, 0, 3.6, -0.95, 0.2, -1, -1, -0.5, -1, 0.5, 0.2, 1, 3.6, 0.95], 3.2, 0, 'own'),
    ell(2, 0, 1.1, 0.55, 3.2, 0, 'black'),
    ell(0.6, 0, 0.45, 0.45, 3.2, 2, 'gun'),
    ell(-0.4, 0, 0.4, 0.4, 3.2, 1.4, 'gun'),
    // awash: the sea over the bow and the stern (the hull shows dimly through it), foam along the bow
    poly(sym([16, 0, 13, -2.4, 8.5, -2.4, 8.5, 0]), 0.6, 0, 'sea', { a: 0.62, wash: true }),
    poly(sym([-8.5, 0, -8.5, -2.4, -16.5, -2.4, -16.5, 0]), 0.6, 0, 'sea', { a: 0.55, wash: true }),
    poly(sym([16.2, 0, 14.6, -1.5, 13.4, -2.2, 13.8, -0.6]), 0.6, 0, 'foam', { a: 0.55 }),
  ];
  if (mods & M_MASTERY) out.push(ell(-2.6, 0, 1.4, 1.1, 0.6, 2, 'sub'), seg(-2.4, -0.4, -4.4, -0.4, 0.5, 2.4, 0.3, 'gun'), seg(-2.4, 0.4, -4.4, 0.4, 0.5, 2.4, 0.3, 'gun'), ell(-0.4, 0, 0.6, 0.6, 4.6, 0.6, 'white'));
  if (mods & M_SPECIAL) out.push(...mine(-5.6, 0, 0.6), ...mine(-7.8, 0, 0.6));
  return out;
}

/** A small plane parked on a flight deck, nose toward +u. */
function parked(u: number, v: number, z: number): Part[] {
  return [seg(u + 1.5, v, u - 1.5, v, 0.85, z, 0.45, 'plane', { sh: 'cyl' }), seg(u + 0.4, v - 1.8, u + 0.4, v + 1.8, 0.8, z, 0.35, 'plane'), seg(u - 1.3, v - 0.8, u - 1.3, v + 0.8, 0.6, z, 0.35, 'plane')];
}

function carrier(mods: number): Part[] {
  const deckZ = 3.6;
  const out: Part[] = [
    poly(hullShape(24, 4.6, 10, 4, 0.7), 0, 2.6, 'hull'),
    // the flight deck: a dark slab wider than the hull, overhanging both sides
    poly(sym([25, -2.4, 22.6, -5, 19, -5.9, -23.4, -5.9, -25, -5.1]), 2.6, 1, 'tarmac', { pat: 'deckline' }),
    // painted edge lines, three elevators, the aft landing marks
    box(-23, -5.4, 21, -4.95, deckZ, 0, 'white'),
    box(-23, 4.95, 21, 5.4, deckZ, 0, 'white'),
    box(12, -3.6, 15.4, 0.4, deckZ, 0, 'deckGrey', { inset: true }),
    box(-4, -3.9, -0.6, 0.1, deckZ, 0, 'deckGrey', { inset: true }),
    box(-17, -2.2, -13.6, 1.8, deckZ, 0, 'deckGrey', { inset: true }),
    box(-23.4, -2.6, -22.6, 2.6, deckZ, 0, 'white'),
    ...parked(19, -2.6, deckZ),
    ...parked(19, 1.4, deckZ),
    ...parked(-19.6, -3, deckZ),
    ...parked(-19.6, 0.6, deckZ),
    ...parked(-8.4, -3, deckZ),
    // the island on the starboard side: a long block, the bridge on top with the owner colour on its roof, the funnel,
    // the mast
    box(-6.4, 3.4, 3, 6.3, deckZ, 2.8, 'sup'),
    box(-3.4, 3.9, 1.8, 5.9, deckZ + 2.8, 1.5, 'sup'),
    box(1.3, 4.1, 1.8, 5.7, deckZ + 4.3, 0, 'glass'),
    box(-3.2, 4.1, 1.3, 5.7, deckZ + 4.3, 0, 'own'),
    box(-6, 3.9, -4, 5.9, deckZ + 2.8, 1.8, 'sup'),
    box(-5.7, 4.2, -4.3, 5.6, deckZ + 4.6, 0, 'black'),
    ell(-1, 4.9, 0.55, 0.55, deckZ + 4.3, 3.6, 'gun'),
  ];
  if (mods & M_MASTERY) out.push(ell(-1, 4.9, 0.6, 0.6, deckZ + 7.9, 0.2, 'gun'), box(-1.6, 3.4, -0.4, 6.4, deckZ + 7.9, 0.7, 'white', { pat: 'grille' }), ...[16, 6, -6, -16].flatMap((u) => aaMount(u, -6.6, 2.6)));
  if (mods & M_SPECIAL) out.push(...mines(-18.6, 3.6, deckZ).slice(0, 2), ...mine(-18.6, 3.6, deckZ), ...mine(-18.6, -3.6, deckZ), ...mine(-21, 3.6, deckZ), ...mine(-21, -3.6, deckZ));
  return out;
}

function transport(): Part[] {
  // a boxy landing ship: a blunt bow with its ramp, a well deck full of troops and two trucks, the bridge aft
  return [
    poly(sym([12.5, -2.6, 11.7, -3.8, -12, -3.8, -12.5, -3.3]), 0, 2.6, 'hull'),
    box(10, -3.1, 12.2, 3.1, 2.6, 0.4, 'deckGrey', { pat: 'planks' }),
    box(-4.6, -3.2, 9.8, 3.2, 2.6, 0, 'deckGrey', { inset: true }),
    box(-4.2, -2.8, 4.6, 2.8, 2.6, 0, 'deckGrey', { pat: 'helmets' }),
    // two trucks: a canvas-covered load and a cab
    box(5.4, -2.7, 8.6, -0.5, 2.6, 1.4, 'canvas'),
    box(8.6, -2.4, 9.6, -0.8, 2.6, 1.1, 'olive'),
    box(5.4, 0.5, 8.6, 2.7, 2.6, 1.4, 'canvas'),
    box(8.6, 0.8, 9.6, 2.4, 2.6, 1.1, 'olive'),
    // the superstructure aft, the bridge with the owner colour on its roof, a small funnel, a mast
    box(-11.8, -3.3, -5, 3.3, 2.6, 2.3, 'sup'),
    box(-9.4, -2.3, -6, 2.3, 4.9, 1.4, 'sup'),
    box(-6.4, -2.1, -6, 2.1, 6.3, 0, 'glass'),
    box(-8.8, -1.7, -6.6, 1.7, 6.3, 0, 'own'),
    ...funnel(-10.6, 0.95, 0.85, 4.9, 1.6),
    ell(-7.6, 0, 0.45, 0.45, 6.3, 2.6, 'gun'),
    boat(-8.2, -3.7, 2.8, 1.4),
    boat(-8.2, 3.7, 2.8, 1.4),
  ];
}

function tradeShip(): Part[] {
  // a merchant: a black hull with a red boot top, a red-brown deck, hatches with derricks, containers, a cream
  // superstructure aft and the funnel in the owner's colours; no guns
  const out: Part[] = [
    // a full merchant hull: wide, a short blunt bow, a broad transom stern
    poly(hullShape(18.5, 4.3, 5.2, 2.6, 0.86), 0, 0.9, 'rust'),
    poly(hullShape(18.5, 4.3, 5.2, 2.6, 0.86), 0.9, 2.1, 'hullBlack'),
    poly(hullShape(17.7, 3.6, 4.8, 2.3, 0.84), 3, 0, 'rust', { inset: true }),
    // the forecastle and two hatches with a derrick mast between them (buff masts and booms)
    box(13.4, -2.4, 15.6, 2.4, 3, 0.7, 'hullBlack'),
    box(8.6, -2.3, 12.6, 2.3, 3, 0.6, 'teal', { pat: 'hatch' }),
    box(2.6, -2.3, 6.8, 2.3, 3, 0.6, 'teal', { pat: 'hatch' }),
    ell(7.7, 0, 0.6, 0.6, 3, 5.2, 'mustard'),
    seg(7.7, -0.3, 11.6, -1.5, 0.5, 7, 0.3, 'mustard'),
    seg(7.7, 0.3, 3.6, 1.5, 0.5, 7, 0.3, 'mustard'),
  ];
  // containers amidships: two rows, three bays, stacked to different heights in faded colours
  const colors: MatId[] = ['brick', 'navy', 'mustard', 'teal', 'white', 'brick'];
  const bays = [
    [-9.2, -5.6],
    [-5.2, -1.6],
    [-1.2, 1.9],
  ];
  bays.forEach(([u0, u1], i) => {
    out.push(box(u0, -3.1, u1, -0.15, 3, i === 1 ? 3 : 2.2, colors[i * 2], { pat: 'grille' }));
    out.push(box(u0, 0.15, u1, 3.1, 3, i === 2 ? 3 : 2.2, colors[i * 2 + 1], { pat: 'grille' }));
  });
  out.push(
    ell(-10.2, 0, 0.55, 0.55, 3, 4.4, 'mustard'),
    seg(-10.2, 0, -6.6, 1.6, 0.5, 6.4, 0.3, 'mustard'),
    // the superstructure aft: cream, bridge wings, the funnel in the owner colour with a black top, the boats
    box(-17.2, -3.6, -11, 3.6, 3, 3.4, 'white'),
    box(-12.2, -4.4, -11.2, 4.4, 6.4, 0.5, 'white'),
    box(-11.6, -2.9, -11, 2.9, 6.4, 0, 'glass'),
    ell(-14.6, 0, 1.45, 1.25, 6.4, 2.4, 'own', { sh: 'cyl' }),
    ell(-14.6, 0, 1, 0.85, 8.8, 0, 'black'),
    boat(-15, -4, 3.6, 1.5),
    boat(-15, 4, 3.6, 1.5),
  );
  return out;
}

// ------------------------------------------------------------------------------------------------- armor

/** Armour skirts over both tracks, reaching out past them so the outline grows (Armor Mastery). */
function skirts(u0: number, u1: number, vIn: number, vOut: number, z: number, m: MatId): Part[] {
  return [box(u0, -vOut - 0.9, u1, -vIn, z, 0.7, m, { pat: 'rivets' }), box(u0, vIn, u1, vOut + 0.9, z, 0.7, m, { pat: 'rivets' })];
}
/** A snorkel pipe at the rear (Amphibious Tanks). */
function snorkel(u: number, v: number, z: number): Part[] {
  return [ell(u, v, 0.8, 0.8, z, 5, 'gun', { sh: 'dome' }), ell(u, v, 1.1, 1.1, z + 5, 0.4, 'gun')];
}
/** A pair of tracks: dark links with road wheels showing on the near side. */
function tracks(u0: number, u1: number, vIn: number, vOut: number, h: number): Part[] {
  return [box(u0, -vOut, u1, -vIn, 0, h, 'tread', { pat: 'tread' }), box(u0, vIn, u1, vOut, 0, h, 'tread', { pat: 'wheels' })];
}

// Tanks stand on a toned-down owner plate (plate()), and carry an owner band across the turret.

function tank(mods: number): Part[] {
  const out: Part[] = [
    plate(-11, 10, 7.1, 2),
    ...tracks(-9.5, 8.5, 3.6, 6, 2.2),
    // the hull with a sloped glacis, the engine deck grille, a tool box
    poly(sym([9.6, -2.6, 8, -3.8, -9.5, -3.8, -9.5, -3]), 0.5, 2.3, 'olive'),
    box(-9, -2.6, -4.8, 2.6, 2.8, 0, 'olive', { pat: 'grille' }),
    box(-9.6, -3.6, -8.6, -1.4, 1.6, 1, 'gun'),
    box(5.6, -3.4, 7.6, -2.4, 2.8, 0.4, 'olive'),
  ];
  if (mods & M_MASTERY) out.push(...skirts(-9.2, 8.2, 3.6, 6, 2.2, 'olive'));
  if (mods & M_SPECIAL) out.push(...snorkel(-7.4, 2.6, 2.8));
  out.push(
    ell(0.5, 0, 4.2, 3.4, 2.8, 2, 'olive', { sh: 'dome' }),
    // the owner band across the turret
    box(-3.7, -3.4, -0.9, 3.4, 2.8, 2.05, 'own', { sh: 'dome', sc: over(0.5, 0, 4.2, 3.4), clip: [0.5, 0, 4.2, 3.4] }),
    ell(-1.2, -1.4, 1.1, 1.1, 4.8, 0.4, 'olive', { sh: 'dome' }),
    ell(0.8, 1.6, 0.8, 0.7, 4.8, 0, 'black'),
    box(3.6, -1.2, 4.8, 1.2, 3.4, 1.2, 'olive'),
    seg(4.2, 0, 14, 0, 1.2, 3.8, 1, 'gun', { sh: 'cyl' }),
    box(13.2, -0.9, 14.6, 0.9, 3.7, 1.2, 'gun'),
  );
  return out;
}

function lightTank(mods: number): Part[] {
  // half a pixel row off the centre line, so the thin gun is one clean pixel row side on (not two)
  return centred(scaled(lightTankParts(mods), 1.06));
}
function lightTankParts(mods: number): Part[] {
  const out: Part[] = [
    // a round plate: the small quick tank's outline differs from the medium's slab, not only its size
    ell(-0.2, 0, 9.4, 6.3, 0, 0.3, 'ownDim', { sh: 'plate' }),
    ...tracks(-7.5, 6.5, 3, 4.8, 1.7),
    poly(sym([7.5, -2, 6, -3.1, -7.5, -3.1, -8, -2.4]), 0.4, 1.8, 'sand'),
    box(-7.6, -2, -5.6, 2, 2.2, 0.6, 'sand'),
    box(-7.2, -1.6, -6, 1.6, 2.8, 0, 'sand', { pat: 'grille' }),
  ];
  if (mods & M_MASTERY) out.push(...skirts(-7.2, 6.2, 3, 4.8, 1.7, 'sand'));
  if (mods & M_PATH3) {
    // Deep Raids: jerrycans and a spare fuel drum on the rear deck
    out.push(box(-5.6, -3, -4, -1.5, 2.2, 1, 'olive'), box(-5.6, -1.2, -4, 0.3, 2.2, 1, 'olive'), box(-5.6, 0.6, -4, 2.1, 2.2, 1, 'olive'), ell(-7, 2.4, 1, 1, 2.2, 1.1, 'red', { sh: 'dome' }));
  }
  if (mods & M_SPECIAL) out.push(...snorkel(-6.6, -2.2, 2.2));
  out.push(
    ell(1.2, 0, 2.7, 2.2, 2.2, 1.5, 'sand', { sh: 'dome' }),
    box(-1.6, -2.3, 0.8, 2.3, 2.2, 1.55, 'own', { sh: 'dome', sc: over(1.2, 0, 2.7, 2.2), clip: [1.2, 0, 2.7, 2.2] }),
    // a thin short gun in light steel: about 5 art px past the nose (the medium and heavy guns are longer and thicker)
    seg(3, 0, 12.2, 0, 1, 3, 0.7, 'steel', { sh: 'cyl' }),
    // the aerial
    ell(-1.4, -1.5, 0.5, 0.5, 3.7, 3.6, 'gun'),
  );
  return out;
}

function heavyTank(mods: number): Part[] {
  const out: Part[] = [
    plate(-13, 12, 8.3, 2.2),
    ...tracks(-11.5, 10.5, 4.4, 7, 2.8),
    // fixed side skirts along the upper run of the tracks (a heavy tank's flat flanks)
    box(-11, -7.2, 10, -6.2, 2, 0.8, 'steel'),
    box(-11, 6.2, 10, 7.2, 2, 0.8, 'steel'),
    poly(sym([11.5, -3.4, 9.5, -4.7, -11.5, -4.7]), 0.6, 3, 'steel'),
    box(-11, -3, -6, 3, 3.6, 0, 'steel', { pat: 'grille' }),
    box(-11.8, -4, -10.8, -2, 2, 1.2, 'gun'),
    box(-11.8, 2, -10.8, 4, 2, 1.2, 'gun'),
  ];
  if (mods & M_MASTERY) out.push(...skirts(-11.2, 10.2, 4.4, 7.2, 2.8, 'steel'));
  if (mods & M_PATH3) {
    // Siege Tanks: a dozer ram ahead of the tracks
    out.push(poly(sym([14.6, -6, 13.6, -7.6, 11.6, -7.6]), 0.3, 2.6, 'steel', { pat: 'rivets' }), box(11, -2.6, 12, 2.6, 0.6, 2, 'gun'));
  }
  if (mods & M_SPECIAL) out.push(...snorkel(-9.6, 3, 3.6));
  const turret = sym([6, -2.6, 3.6, -4.2, -5.5, -4.2, -6.5, -3]);
  out.push(
    poly(turret, 3.6, 2.6, 'steel'),
    box(-4.6, -4.3, -2.8, 4.3, 3.6, 2.65, 'own', { clipPoly: turret }),
    ell(-1.4, -1.8, 1.3, 1.3, 6.2, 0.9, 'steel', { sh: 'dome' }),
    ell(1, 2, 0.9, 0.8, 6.2, 0, 'black'),
    box(4.8, -1.6, 6.4, 1.6, 4.4, 1.6, 'steel'),
    seg(5.5, 0, 20, 0, 1.6, 5, 1.2, 'gun', { sh: 'cyl' }),
    box(19, -1.3, 21, 1.3, 4.9, 1.4, 'gun'),
  );
  return out;
}

// ------------------------------------------------------------------------------------------------- air

/** Two drop tanks hanging under the wings, poking out ahead of the leading edge (Drop Tanks). */
function dropTanks(u: number, v: number, z: number): Part[] {
  return [ell(u, -v, 2.3, 0.75, z, 0.8, 'white', { sh: 'cyl' }), ell(u, v, 2.3, 0.75, z, 0.8, 'white', { sh: 'cyl' }), ell(u + 2, -v, 0.5, 0.5, z, 0.8, 'red'), ell(u + 2, v, 0.5, 0.5, z, 0.8, 'red')];
}
/** Owner bands at both wingtips. */
function tips(u0: number, u1: number, v0: number, v1: number, z: number): Part[] {
  return [box(u0, -v1, u1, -v0, z, 0, 'own'), box(u0, v0, u1, v1, z, 0, 'own')];
}

/**
 * A jet engine pod (Jet Engines): the same mark on every plane that has jets, a pale pod with a dark intake at the
 * front and a dull hot exhaust at the back.
 */
function jetPod(u: number, v: number, z: number, len = 2.4, r = 0.9): Part[] {
  return [ell(u, v, len, r, z, 1, 'metal', { sh: 'cyl' }), ell(u + len - 0.5, v, 0.6, Math.max(0.6, r - 0.3), z + 0.2, 0.9, 'black'), ell(u - len - 0.3, v, 0.6, 0.6, z, 0.6, 'flame', { glow: true })];
}
/** A propeller engine nacelle: a cylinder with a dark spinner at its nose. */
function nacelle(u: number, v: number, z: number, len: number, r: number, m: MatId): Part[] {
  return [ell(u, v, len, r, z, 1.3, m, { sh: 'cyl' }), ell(u + len - 0.2, v, 0.6, 0.6, z + 0.4, 0.8, 'gun', { sh: 'dome' })];
}

interface Plane {
  parts: Part[];
  props: Prop[];
}

function bomber(mods: number): Plane {
  const m: MatId = mods & M_NIGHT ? 'night' : 'plane';
  const tail: MatId = mods & M_MASTERY ? 'gold' : m;
  const out: Part[] = [];
  const props: Prop[] = [];
  const jet = !!(mods & M_JET);
  if (mods & M_SPECIAL) out.push(...dropTanks(jet ? 3.4 : 5.4, 2.9, 2.1));
  if (jet) {
    // Jet Engines: the same twin-engine bomber with wings swept back and a jet pod under each wing, no propellers
    out.push(poly(sym([4.5, -1.6, -0.6, -13, -2.8, -13, -0.6, -1.6]), 2.6, 0.6, m), ...tips(-2.8, -0.4, 11.4, 13, 3.2), ...jetPod(2.8, -5.2, 2.2), ...jetPod(2.8, 5.2, 2.2));
  } else {
    out.push(poly(sym([4.5, -1.6, 3.4, -13, 1.2, -13, -0.6, -1.6]), 2.6, 0.6, m), ...tips(1, 3.6, 11.4, 13, 3.2), ...nacelle(4, -5, 2.8, 3, 1.15, m), ...nacelle(4, 5, 2.8, 3, 1.15, m));
    props.push({ u: 7.4, v: -5, z: 3.5, r: 2.5 }, { u: 7.4, v: 5, z: 3.5, r: 2.5 });
  }
  out.push(
    ell(0, 0, 10.5, 1.9, 2.4, 1.8, m, { sh: 'cyl' }),
    box(-5, -2, -3.8, 2, 2.4, 1.85, 'own', { sh: 'cyl', sc: over(0, 0, 10.5, 1.9), clip: [0, 0, 10.5, 1.9] }),
    ell(9, 0, 1.6, 1.3, 2.8, 1.2, 'glass', { sh: 'dome' }),
    box(5, -0.9, 6.6, 0.9, 4.1, 0, 'glass'),
    poly(sym([-7.2, -1, -8.2, -5, -9.8, -5, -10, -1]), 2.6, 0.5, tail),
    seg(-10.2, 0, -6.5, 0, 0.8, 4, 2, tail),
  );
  return { parts: out, props };
}

/** Rockets on rails under a wing (pairs at the given spans), tips ahead of the leading edge. */
function wingRockets(spans: { v: number; le: number }[], z: number): Part[] {
  const out: Part[] = [];
  for (const { v, le } of spans) {
    for (const s of [-1, 1]) {
      out.push(seg(le - 3.2, s * v, le + 1.6, s * v, 0.75, z, 0.5, 'white', { sh: 'cyl' }));
      out.push(box(le + 1, s * v - 0.42, le + 2.1, s * v + 0.42, z, 0.5, 'red'));
    }
  }
  return out;
}

function groundAttack(mods: number): Plane {
  const m: MatId = mods & M_NIGHT ? 'night' : 'camo';
  const tail: MatId = mods & M_MASTERY ? 'gold' : m;
  const out: Part[] = [];
  if (mods & M_JET) {
    // Jet Engines: the same stubby straight wings with their rockets (swept back a little), a pointed nose instead of
    // the propeller, a jet pod on each side of the fuselage
    if (mods & M_SPECIAL) out.push(...dropTanks(3.8, 2.6, 2.1));
    out.push(...wingRockets([{ v: 4.4, le: 3.1 }, { v: 6, le: 2.7 }, { v: 7.6, le: 2.3 }], 2.1));
    out.push(
      poly(sym([4, -1.4, 2.2, -10, -0.8, -10, -2, -1.4]), 2.6, 0.6, m),
      ...tips(-0.8, 2.2, 8.8, 10, 3.2),
      ...jetPod(0.4, -2.3, 2.3, 2.2, 0.8),
      ...jetPod(0.4, 2.3, 2.3, 2.2, 0.8),
      ell(0, 0, 8.4, 1.7, 2.4, 1.7, m, { sh: 'cyl' }),
      poly([10.8, 0, 8, -1.2, 8, 1.2], 2.6, 1.3, m, { sh: 'cyl', sc: over(9.4, 0, 1.4, 1.2) }),
      box(-3.6, -1.8, -2.4, 1.8, 2.4, 1.75, 'own', { sh: 'cyl', sc: over(0, 0, 8.4, 1.7), clip: [0, 0, 8.4, 1.7] }),
      ell(3.4, 0, 1.8, 0.95, 4, 0.6, 'glass', { sh: 'dome' }),
      poly(sym([-6.2, -0.8, -7.4, -3.8, -8.8, -3.8, -8.6, -0.8]), 2.6, 0.5, tail),
      seg(-8.8, 0, -6, 0, 0.7, 3.8, 1.6, tail),
    );
    return { parts: out, props: [] };
  }
  if (mods & M_SPECIAL) out.push(...dropTanks(4.8, 2.6, 2.1));
  out.push(...wingRockets([{ v: 4.4, le: 3.6 }, { v: 6, le: 3.5 }, { v: 7.6, le: 3.4 }], 2.1));
  out.push(
    poly(sym([4, -1.4, 3.4, -10, 0.4, -10, -1.6, -1.4]), 2.6, 0.6, m),
    ...tips(0.4, 3.4, 8.8, 10, 3.2),
    ell(0, 0, 8.4, 1.7, 2.4, 1.7, m, { sh: 'cyl' }),
    box(-3.6, -1.8, -2.4, 1.8, 2.4, 1.75, 'own', { sh: 'cyl', sc: over(0, 0, 8.4, 1.7), clip: [0, 0, 8.4, 1.7] }),
    // the big radial engine cowling and its spinner
    ell(6.8, 0, 1.9, 2, 2.4, 1.8, m, { sh: 'dome' }),
    ell(8.6, 0, 0.7, 0.7, 2.9, 0.9, 'gun', { sh: 'dome' }),
    ell(1.6, 0, 1.7, 1, 4.1, 0.6, 'glass', { sh: 'dome' }),
    poly(sym([-6.2, -0.8, -7, -3.8, -8.4, -3.8, -8.6, -0.8]), 2.6, 0.5, tail),
    seg(-8.8, 0, -6, 0, 0.7, 3.8, 1.6, tail),
  );
  return { parts: out, props: [{ u: 9.2, v: 0, z: 3.3, r: 3 }] };
}

function heavyBomber(mods: number): Plane {
  const m: MatId = mods & M_NIGHT ? 'night' : 'metal';
  const tail: MatId = mods & M_MASTERY ? 'gold' : m;
  const out: Part[] = [];
  const props: Prop[] = [];
  if (mods & M_SPECIAL) out.push(...dropTanks(6.6, 8.2, 2.3));
  out.push(poly(sym([5, -2, 3.4, -18, 0.6, -18, -2, -2]), 2.8, 0.7, m), ...tips(0.6, 3.4, 16.4, 18, 3.5));
  for (const v of [-11, -5.5, 5.5, 11]) {
    out.push(...nacelle(4.2, v, 3, 2.8, 1.1, m));
    props.push({ u: 7.3, v, z: 3.7, r: 2.3 });
  }
  out.push(
    ell(0, 0, 13, 2.2, 2.6, 2.2, m, { sh: 'cyl' }),
    box(-6.4, -2.3, -5, 2.3, 2.6, 2.25, 'own', { sh: 'cyl', sc: over(0, 0, 13, 2.2), clip: [0, 0, 13, 2.2] }),
    ell(11.6, 0, 1.6, 1.6, 3, 1.4, 'glass', { sh: 'dome' }),
    box(8, -1, 9.6, 1, 4.8, 0, 'glass'),
    poly(sym([-9.5, -1.4, -10.5, -7, -12.8, -7, -13, -1.4]), 2.8, 0.5, tail),
    seg(-13, -6.6, -10, -6.6, 0.9, 3.3, 2.4, tail),
    seg(-13, 6.6, -10, 6.6, 0.9, 3.3, 2.4, tail),
  );
  if (mods & M_PATH3) {
    // Strategic Bombing: dorsal and tail gun turrets
    out.push(ell(3.6, 0, 1.4, 1.2, 4.8, 0.9, 'glass', { sh: 'dome' }), ell(-3.4, 0, 1.2, 1.1, 4.8, 0.8, 'glass', { sh: 'dome' }), ell(-13.4, 0, 1.1, 1, 2.8, 1.3, 'glass', { sh: 'dome' }));
  }
  return { parts: out, props };
}

function fighter(mods: number): Plane {
  const m: MatId = 'plane';
  const tail: MatId = mods & M_MASTERY ? 'gold' : m;
  const out: Part[] = [];
  if (mods & M_JET) {
    if (mods & M_SPECIAL) out.push(...dropTanks(1.4, 3, 2.1));
    out.push(
      poly(sym([2, -1.1, -3.6, -6.8, -5.2, -6.8, -4.2, -1.1]), 2.7, 0.5, m),
      ...tips(-5.1, -3.8, 5.8, 6.8, 3.2),
      ell(0, 0, 7.4, 1.15, 2.6, 1.3, m, { sh: 'cyl' }),
      poly([9.6, 0, 6.4, -0.9, 6.4, 0.9], 2.7, 1.1, m, { sh: 'cyl', sc: over(8, 0, 1.6, 0.9) }),
      ...jetPod(0, -1.6, 2.7, 2, 0.7),
      ...jetPod(0, 1.6, 2.7, 2, 0.7),
      ell(2.4, 0, 1.6, 0.75, 3.9, 0.5, 'glass', { sh: 'dome' }),
      poly(sym([-5.2, -0.6, -6.4, -2.6, -7.6, -2.6, -7.4, -0.6]), 2.7, 0.4, tail),
      seg(-7.6, 0, -5, 0, 0.6, 3.6, 1.4, tail),
    );
    return { parts: out, props: [] };
  }
  if (mods & M_SPECIAL) out.push(...dropTanks(3.4, 2.8, 2.1));
  out.push(
    poly(sym([2.6, -1, 1.8, -7.5, 0, -7.5, -1.8, -1]), 2.7, 0.5, m),
    ...tips(0, 1.8, 6.3, 7.5, 3.2),
    ell(0, 0, 7, 1.25, 2.6, 1.3, m, { sh: 'cyl' }),
    ell(7, 0, 0.8, 0.8, 2.8, 1, 'own', { sh: 'dome' }),
    ell(0.8, 0, 1.4, 0.75, 3.9, 0.5, 'glass', { sh: 'dome' }),
    poly(sym([-5, -0.6, -5.6, -2.8, -6.8, -2.8, -7, -0.6]), 2.7, 0.4, tail),
    seg(-7, 0, -4.8, 0, 0.6, 3.6, 1.4, tail),
  );
  return { parts: out, props: [{ u: 7.8, v: 0, z: 3.3, r: 2.4 }] };
}

function transportPlane(mods: number): Plane {
  const m: MatId = 'plane';
  const out: Part[] = [];
  const props: Prop[] = [];
  const jet = !!(mods & M_JET);
  if (mods & M_SPECIAL) out.push(...dropTanks(jet ? 1.6 : 4.4, 10.5, 3.6));
  // the fat fuselage first: the high wing lies over it
  out.push(ell(0, 0, 12, 2.7, 2.2, 2.6, m, { sh: 'cyl' }), box(-4.2, -2.8, -2.8, 2.8, 2.2, 2.65, 'own', { sh: 'cyl', sc: over(0, 0, 12, 2.7), clip: [0, 0, 12, 2.7] }));
  if (jet) {
    out.push(poly(sym([3, -2, -3.4, -15, -5.4, -15, -1.4, -2]), 4.8, 0.5, m), ...tips(-5.2, -3.4, 13.6, 15, 5.3));
    for (const v of [-6.5, 6.5]) out.push(...jetPod(2.6, v, 3.8, 2.6, 1));
  } else {
    out.push(poly(sym([3, -2, 2.2, -15, 0, -15, -1, -2]), 4.8, 0.5, m), ...tips(0, 2.2, 13.6, 15, 5.3));
    for (const v of [-6.5, 6.5]) {
      out.push(...nacelle(3.2, v, 4.2, 2.6, 1.1, m));
      props.push({ u: 6.2, v, z: 4.9, r: 2.4 });
    }
  }
  out.push(
    ell(10.4, 0, 1.2, 1.6, 4, 0.6, 'glass', { sh: 'dome' }),
    // the tall tail and the wide stabilizer
    seg(-12.4, 0, -8.6, 0, 0.9, 4.6, 3.2, m),
    box(-12.6, -5.6, -10.4, 5.6, 7.6, 0.4, m),
    box(-12.6, -5.6, -10.4, -4.4, 8, 0, 'own'),
    box(-12.6, 4.4, -10.4, 5.6, 8, 0, 'own'),
    // the paratroop door on the port side
    box(-6.4, -2.5, -5.2, -1.6, 4.6, 0, 'black'),
  );
  return { parts: out, props };
}

function reconPlane(mods: number): Plane {
  const m: MatId = 'plane';
  const out: Part[] = [];
  if (mods & M_SPECIAL) out.push(...dropTanks(3.8, 7.4, 2.2));
  out.push(
    poly(sym([2.4, -1.4, 1.8, -12, 0.4, -12, -0.6, -1.4]), 2.6, 0.4, m),
    ...tips(0.4, 1.8, 10.6, 12, 3),
    seg(4, -3.4, -8.4, -3.4, 1, 2.4, 1, m, { sh: 'cyl' }),
    seg(4, 3.4, -8.4, 3.4, 1, 2.4, 1, m, { sh: 'cyl' }),
    ...nacelle(3.4, -3.4, 2.4, 1.8, 1, m),
    ...nacelle(3.4, 3.4, 2.4, 1.8, 1, m),
    ell(2.2, 0, 4.8, 1.3, 2.6, 1.4, m, { sh: 'cyl' }),
    // the long glazed nose
    ell(6.2, 0, 1.6, 1.1, 2.8, 1.2, 'glass', { sh: 'dome' }),
    ell(3.4, 0, 0.6, 0.6, 4, 0, 'black'),
    box(-9.2, -3.4, -7.6, 3.4, 2.6, 0.4, m),
    seg(-9.4, -3.4, -7.4, -3.4, 0.6, 3, 1.4, m),
    seg(-9.4, 3.4, -7.4, 3.4, 0.6, 3, 1.4, m),
  );
  return { parts: out, props: [{ u: 5.4, v: -3.4, z: 3, r: 2 }, { u: 5.4, v: 3.4, z: 3, r: 2 }] };
}

// ------------------------------------------------------------------------------------------------- missiles

/**
 * The exhaust: a small flame at the nozzle (flat shaded, so it stays light) with a white-hot core; frame 1 is a pixel
 * longer (flicker).
 */
function flame(u: number, r: number, len: number, z: number, frame: number): Part[] {
  const L = len + (frame ? 1.2 : 0);
  return [poly([u, -r, u, r, u - L, 0], z, 0.6, 'flame', { glow: true }), ell(u - 0.5, 0, 1, 0.55, z + 0.2, 0.6, 'white', { glow: true })];
}

/**
 * The rocket: a slender grey body about five times longer than wide, a long tapering nose that still ends in a point
 * at one art pixel, a dark warning band, swept tail fins sticking out past the body on both sides, a dark nozzle and a
 * small flame. A projectile: no owner colour.
 */
function rocket(frame: number): Part[] {
  const body = over(-1.2, 0, 6, 1.5);
  return [
    ...flame(-7.2, 0.8, 2.4, 1.6, frame),
    poly(sym([-2.8, -1.4, -6.2, -3, -7.6, -3, -6.6, -1.4]), 1.5, 0.5, 'gun'),
    box(-7.2, -0.9, -6.2, 0.9, 1.7, 1.2, 'black'),
    box(-6.4, -1.5, 3, 1.5, 1.4, 1.8, 'metal', { sh: 'cyl', sc: body }),
    box(-1.4, -1.55, -0.4, 1.55, 1.4, 1.85, 'yellow', { sh: 'cyl', sc: body }),
    poly([9.2, 0, 6.6, -1, 3, -1.5, 3, 1.5, 6.6, 1], 1.4, 1.8, 'metal', { sh: 'cyl', sc: over(5, 0, 3, 1.5) }),
    ell(8.4, 0, 1.1, 0.62, 1.9, 1, 'gun'),
  ];
}

/**
 * The atom bomb: larger and thicker, olive drab with a yellow and black hazard band, bigger swept fins, a long nose. The
 * map draws a faint ring round it (sprites.ts).
 */
function atomBomb(frame: number): Part[] {
  const body = over(-1.6, 0, 7, 2.1);
  return [
    ...flame(-9.2, 1, 2.8, 1.8, frame),
    poly(sym([-4, -1.9, -8, -4.2, -9.8, -4.2, -8.6, -1.9]), 1.5, 0.6, 'steel'),
    box(-9.2, -1.1, -8.2, 1.1, 1.8, 1.5, 'gun'),
    box(-8.4, -2.1, 4, 2.1, 1.4, 2.4, 'olive', { sh: 'cyl', sc: body }),
    box(-3.4, -2.15, -2.2, 2.15, 1.4, 2.45, 'yellow', { sh: 'cyl', sc: body }),
    box(-2.2, -2.15, -1.2, 2.15, 1.4, 2.45, 'black', { sh: 'cyl', sc: body }),
    box(-1.2, -2.15, 0, 2.15, 1.4, 2.45, 'yellow', { sh: 'cyl', sc: body }),
    poly([11, 0, 8, -1.3, 4, -2.1, 4, 2.1, 8, 1.3], 1.4, 2.4, 'olive', { sh: 'cyl', sc: over(7, 0, 4, 2.1) }),
    ell(10, 0, 1.2, 0.7, 2.2, 1.2, 'sand'),
  ];
}

// ------------------------------------------------------------------------------------------------- lookup

const AIR: ReadonlySet<SpriteKey> = new Set<SpriteKey>(['bomber', 'groundAttack', 'heavyBomber', 'fighter', 'transportPlane', 'reconPlane', 'rocket', 'atomBomb']);

/** The model of a sprite with the given upgrade details and animation frame. */
export function buildModel(key: SpriteKey, mods: number, frame = 0): Model {
  const m = mods & MOD_MASK[key];
  let parts: Part[];
  let props: Prop[] | undefined;
  const plane = (p: Plane): Part[] => {
    props = p.props;
    return p.parts;
  };
  switch (key) {
    case 'warship':
      parts = warship(m);
      break;
    case 'destroyer':
      parts = destroyer(m);
      break;
    case 'battleship':
      parts = battleship(m);
      break;
    case 'submarine':
      parts = submarine(m);
      break;
    case 'carrier':
      parts = carrier(m);
      break;
    case 'transport':
      parts = transport();
      break;
    case 'tradeShip':
      parts = tradeShip();
      break;
    case 'tankDivision':
      parts = tank(m);
      break;
    case 'lightTank':
      parts = lightTank(m);
      break;
    case 'heavyTank':
      parts = heavyTank(m);
      break;
    case 'bomber':
      parts = plane(bomber(m));
      break;
    case 'groundAttack':
      parts = plane(groundAttack(m));
      break;
    case 'heavyBomber':
      parts = plane(heavyBomber(m));
      break;
    case 'fighter':
      parts = plane(fighter(m));
      break;
    case 'transportPlane':
      parts = plane(transportPlane(m));
      break;
    case 'reconPlane':
      parts = plane(reconPlane(m));
      break;
    case 'rocket':
      parts = centred(rocket(frame & 1));
      break;
    case 'atomBomb':
      parts = centred(atomBomb(frame & 1));
      break;
  }
  // missiles fly: drawn flat from straight above, so the slender body stays slender at every heading
  return { parts: parts.map(minSize), air: AIR.has(key), flat: key === 'rocket' || key === 'atomBomb', props };
}

/**
 * Lines and posts at least one art pixel wide, so barrels, masts and booms never break up: a line on the centre line
 * seen side on must still cover the middle of one foreshortened pixel row (half a row is 0.5 / FORE = 0.6 model units
 * away), so lines are at least 1.25 wide.
 */
function minSize(p: Part): Part {
  if (p.k === 'seg' && p.p[4] < 1.25) return { ...p, p: [p.p[0], p.p[1], p.p[2], p.p[3], 1.25] };
  if (p.k === 'ell' && (p.p[2] < 0.6 || p.p[3] < 0.6)) return { ...p, p: [p.p[0], p.p[1], Math.max(0.6, p.p[2]), Math.max(0.6, p.p[3])] };
  return p;
}

/** Length of a sprite along its heading, model units (art px at full size): bow to stern, nose to tail. */
export function modelLength(model: Model): number {
  let a = Infinity;
  let b = -Infinity;
  for (const p of model.parts) {
    if (p.glow || (p.a ?? 1) < 1) continue;
    const q = p.p;
    if (p.k === 'ell') {
      a = Math.min(a, q[0] - q[2]);
      b = Math.max(b, q[0] + q[2]);
    } else if (p.k === 'seg') {
      a = Math.min(a, q[0], q[2]);
      b = Math.max(b, q[0], q[2]);
    } else if (p.k === 'box') {
      a = Math.min(a, q[0]);
      b = Math.max(b, q[2]);
    } else
      for (let i = 0; i < q.length; i += 2) {
        a = Math.min(a, q[i]);
        b = Math.max(b, q[i]);
      }
  }
  return b - a;
}
