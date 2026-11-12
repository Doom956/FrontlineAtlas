// The unit art (client only): one small model per unit and arsenal variant, rasterized by spriteBake.ts. Model units
// are art pixels at full size; the nose points at +u, the starboard side at +v. All art is original and lives here
// as code.
//
// Every vehicle has its own silhouette, not just its own colour:
//   warship (before any arsenal pick)  a plain gunboat: a sharp bow, a full blunt stern, one gun fore, one aft
//   destroyer    long and slim, a sharp bow and a tapered stern, ONE turret, a tall raked funnel, light torpedo tubes
//   battleship   the longest and widest hull, THREE big twin turrets read as turret, turret, tower, turret
//   submarine    a low steel cigar awash (a pale foam band round it), the conning tower its only raised part
//   carrier      a flat dark flight deck with a dashed centre line, an island on the starboard side, parked planes
//   tank division  a medium tank: tracks, a round turret, a medium gun (olive)
//   light tank   small and quick: narrow tracks, a little turret, a thin short light gun, an aerial (tan)
//   heavy tank   wide and long: broad tracks, an angular turret, a long thick gun with a muzzle brake (dark steel)
//   bomber       twin engines, straight wings, glazed nose
//   ground-attack  a stubby single-engine plane with rows of red-tipped rockets under its wings (camouflage green)
//   heavy bomber   four engines on long wings, twin tail fins, natural metal
// Upgrades a player owns add details of at least 2 x 2 art px in colours that are never an owner hue: a gold bow
// chevron and an AA mount (Naval Mastery), dark mines with a yellow dot (Naval Mines), armour skirts that widen the
// tracks (Armor Mastery), jerrycans (Deep Raids), a dozer ram (Siege Tanks), a snorkel (Amphibious Tanks), pale jet
// pods with an orange exhaust on every plane that has them, each keeping its own outline (Jet Engines), gun turrets
// (Strategic Bombing), drop tanks (Drop Tanks), dark night paint (Night Bombing) and a gold tail (Air Mastery).
// The owner's colour: an owner plate under each tank plus a turret band, the deckhouse of each ship, a fuselage band
// and wingtips on planes; never the whole unit, so the metal keeps its own tones.
import type { MatId, Model, Part, Pattern, Shade } from './spriteBake';

/** Upgrade details (bit mask). */
export const M_MASTERY = 1;
export const M_PATH3 = 2;
export const M_JET = 4;
export const M_SPECIAL = 8;
export const M_NIGHT = 16;

export type SpriteKey =
  | 'warship'
  | 'destroyer'
  | 'battleship'
  | 'submarine'
  | 'carrier'
  | 'transport'
  | 'tradeShip'
  | 'tankDivision'
  | 'lightTank'
  | 'heavyTank'
  | 'bomber'
  | 'groundAttack'
  | 'heavyBomber'
  | 'fighter'
  | 'transportPlane'
  | 'reconPlane'
  | 'rocket'
  | 'atomBomb';

export const SPRITE_KEYS: readonly SpriteKey[] = ['warship', 'destroyer', 'battleship', 'submarine', 'carrier', 'transport', 'tradeShip', 'tankDivision', 'lightTank', 'heavyTank', 'bomber', 'groundAttack', 'heavyBomber', 'fighter', 'transportPlane', 'reconPlane', 'rocket', 'atomBomb'];

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

// ------------------------------------------------------------------------------------------------- helpers

interface Opt {
  sh?: Shade;
  pat?: Pattern;
  a?: number;
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
/**
 * A ship hull: a sharp bow point at +L that widens to the full beam `b` over `bow` art px (a narrow point first, then
 * the shoulders flare, so the bow ends in a clear spike at one art pixel), straight sides, and a stern with corners
 * cut by `cut` (small = a full, blunt stern).
 */
const hull = (L: number, b: number, bow: number, cut = 1): number[] => sym([L, 0, L - bow * 0.5, -b * 0.3, L - bow, -b, -L + cut, -b, -L, -b + cut]);
/**
 * The owner plate under a vehicle: a flat slab in the owner's colour (base tone, a darker lower and right rim, the dark
 * outline round the sprite), a little larger than the vehicle, so who it belongs to reads at a glance on the map.
 */
const plate = (u0: number, u1: number, v: number, c: number): Part => poly(sym([u1, -v + c, u1 - c, -v, u0 + c, -v, u0, -v + c]), 0, 0.3, 'own', { sh: 'plate' });
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

/** A gold chevron on the bow deck, two art px thick, its tip at `u` (Naval Mastery). */
function chevron(u: number, b: number, z: number): Part {
  return poly([u, 0, u - 2.6, -b, u - 4.6, -b, u - 2, 0, u - 4.6, b, u - 2.6, b], z, 0.3, 'gold');
}
/** A sea mine: a dark sphere with a yellow detonator dot on top (never an owner hue). */
function mine(u: number, v: number, z: number): Part[] {
  return [ell(u, v, 1.15, 1.15, z, 0.9, 'black', { sh: 'dome' }), ell(u + 0.1, v - 0.1, 0.55, 0.55, z + 0.9, 0, 'yellow')];
}
/** A pair of mines on rails at the stern (Naval Mines). */
function mines(L: number, z: number): Part[] {
  return [...mine(-L + 2.8, -1.3, z), ...mine(-L + 2.8, 1.3, z)];
}
/** A small twin AA mount (Naval Mastery). */
function aaMount(u: number, z: number): Part[] {
  return [ell(u, 0, 1.3, 1.2, z, 0.9, 'white', { sh: 'dome' }), seg(u + 0.4, -0.5, u + 2.8, -0.5, 0.5, z + 0.6, 0.3, 'gun'), seg(u + 0.4, 0.5, u + 2.8, 0.5, 0.5, z + 0.6, 0.3, 'gun')];
}
/**
 * A gun turret: a dark ring at deck level round a light flat-topped turret, so it stands out from the deck as one
 * block, with one or two short barrels toward `dir` (1 forward, -1 aft) that reach past the turret.
 */
function turretAt(u: number, ru: number, rv: number, z: number, dir: 1 | -1, barrels: number[], len: number, w = 0.9): Part[] {
  const out: Part[] = [ell(u, 0, ru + 0.8, rv + 0.8, z, 0, 'gun'), ell(u, 0, ru, rv, z, 1.4, 'turret')];
  for (const v of barrels) out.push(seg(u + dir * (ru - 0.4), v, u + dir * (ru + len), v, w, z + 0.8, 0.5, 'gun', { sh: 'cyl' }));
  return out;
}
/** A funnel: light grey with a black top; `rake` moves the top aft (a raked funnel). */
function funnel(u: number, ru: number, rv: number, z: number, h: number, rake = 0): Part[] {
  if (!rake) return [ell(u, 0, ru, rv, z, h, 'sup', { sh: 'cyl' }), ell(u, 0, ru * 0.55, rv * 0.55, z + h, 0, 'black')];
  return [ell(u, 0, ru, rv, z, h * 0.5, 'sup', { sh: 'cyl' }), ell(u - rake, 0, ru, rv, z + h * 0.5, h * 0.5, 'sup', { sh: 'cyl' }), ell(u - rake, 0, ru * 0.55, rv * 0.55, z + h, 0, 'black')];
}

// The owner colour on ships is the deckhouse (bridge block) under the light tower: wide enough (3+ art px) to read at
// map zoom, while the hull and deck keep their metal tones.

function warship(mods: number): Part[] {
  const L = 15;
  const out: Part[] = [
    // a full blunt stern, a sharp bow
    poly(hull(L, 3.6, 4.5, 0.5), 0, 3, 'hull'),
    poly(hull(L - 1.2, 2.7, 4, 0.5), 3, 0, 'deck', { inset: true }),
    ...turretAt(7.6, 1.8, 1.6, 3, 1, [0], 4.4, 1),
    // the deckhouse in the owner colour, its windows, the mast
    box(-3, -2.6, 3.2, 2.6, 3, 2.6, 'own'),
    box(2.4, -1.8, 3.2, 1.8, 5.6, 0, 'glass'),
    ell(0, 0, 0.6, 0.6, 5.6, 3.4, 'gun'),
    ...funnel(-5.6, 1.5, 1.3, 3, 3.4),
    ...turretAt(-10.2, 1.4, 1.3, 3, -1, [0], 3.2, 0.8),
  ];
  if (mods & M_MASTERY) out.push(chevron(L - 3, 1.8, 3), ...aaMount(-7.9, 3));
  if (mods & M_SPECIAL) out.push(...mines(L, 3));
  return out;
}

function destroyer(mods: number): Part[] {
  const L = 14;
  const out: Part[] = [
    // long and slim: a sharp bow, a narrow tapered stern
    poly(hull(L, 2.7, 4, 1.8), 0, 2.6, 'hull'),
    poly(hull(L - 1.1, 1.9, 3.6, 1.6), 2.6, 0, 'deck', { inset: true }),
    ...turretAt(7.2, 1.5, 1.3, 2.6, 1, [0], 3.8, 0.9),
    // low deckhouse in the owner colour
    box(1.2, -2, 4.6, 2, 2.6, 2.4, 'own'),
    box(3.9, -1.4, 4.6, 1.4, 5, 0, 'glass'),
    ell(2, 0, 0.5, 0.5, 5, 3, 'gun'),
    // a tall raked funnel
    ...funnel(-1, 1.3, 1.2, 2.6, 4, 1.4),
    // light torpedo tubes midships, depth charges at the stern
    seg(-8.6, -0.8, -4.6, -0.8, 1.1, 2.6, 0.8, 'white', { sh: 'cyl' }),
    seg(-8.6, 0.8, -4.6, 0.8, 1.1, 2.6, 0.8, 'white', { sh: 'cyl' }),
    box(-12.4, -0.9, -10.8, 0.9, 2.6, 0.6, 'gun'),
  ];
  if (mods & M_MASTERY) out.push(chevron(L - 2.6, 1.3, 2.6), ...aaMount(-2.6, 2.6).map((p) => ({ ...p, z: p.z + 0.2 })));
  if (mods & M_SPECIAL) out.push(...mines(L - 0.6, 2.6));
  return out;
}

function battleship(mods: number): Part[] {
  const L = 20;
  const out: Part[] = [
    poly(hull(L, 4.4, 6.5, 1.4), 0, 3.6, 'hull'),
    poly(hull(L - 1.3, 3.4, 5.8, 1.2), 3.6, 0, 'deck', { inset: true }),
    // turret, turret, tower, turret: two forward (the second raised on its barbette), one aft
    ...turretAt(11.6, 2.4, 2, 3.6, 1, [-0.9, 0.9], 4),
    ell(6, 0, 3.2, 2.8, 3.6, 1.1, 'hull'),
    ...turretAt(6, 2.4, 2, 4.7, 1, [-0.9, 0.9], 3.6),
    // the deckhouse in the owner colour, the tall light tower on it, the funnel behind
    box(-7.6, -3, 2.8, 3, 3.6, 2, 'own'),
    box(-1.6, -1.9, 2.2, 1.9, 5.6, 3.4, 'sup'),
    box(1.5, -1.4, 2.2, 1.4, 9, 0, 'glass'),
    ...funnel(-5, 1.6, 1.5, 5.6, 2.6),
    ...turretAt(-12.8, 2.4, 2, 3.6, -1, [-0.9, 0.9], 4.4),
  ];
  if (mods & M_MASTERY) out.push(chevron(L - 2.4, 2.4, 3.6), ...aaMount(-8.4, 5.6));
  if (mods & M_SPECIAL) out.push(...mines(L - 0.6, 3.6));
  return out;
}

function submarine(mods: number): Part[] {
  const out: Part[] = [
    // awash: a pale translucent band of foam round the hull at the waterline, more at the bow
    ell(0, 0, 16.6, 4.2, 0, 0, 'foam', { a: 0.5 }),
    poly(sym([17, 0, 13, -3.4, 12, -3, 14.9, 0]), 0, 0, 'foam', { a: 0.8 }),
    // the low steel hull, flush with the sea (only the tower stands up): a light top ridge, mid sides, a dark keel side
    ell(0, 0, 14.4, 2.4, 0, 0.6, 'sub', { sh: 'cyl' }),
    seg(-10.5, -0.9, 10, -0.9, 0.9, 0.6, 0, 'hull'),
    poly(sym([-13, 0, -15.6, -2.8, -16.2, -2.8, -15.2, 0]), 0, 0.4, 'sub'),
    // the conning tower with dive planes, the owner colour on top, a periscope
    ell(3, 0, 3.2, 1.6, 0.6, 2.4, 'sub'),
    seg(4.2, -2.8, 4.2, 2.8, 0.8, 0.6, 0.3, 'sub'),
    ell(3, 0, 3.2, 1.6, 3, 0.5, 'own'),
    ell(2, 0, 0.45, 0.45, 3.5, 1.8, 'gun'),
  ];
  if (mods & M_MASTERY) out.push(box(-2, -0.9, 0, 0.9, 0.6, 0.2, 'gold'), box(-4.8, -0.9, -2.8, 0.9, 0.6, 0.2, 'gold'));
  if (mods & M_SPECIAL) out.push(...mine(-8.4, 0, 0.6), ...mine(-11, 0, 0.6));
  return out;
}

/** A tiny plane parked on a flight deck. */
function parked(u: number, v: number, z: number): Part[] {
  return [seg(u + 1.4, v, u - 1.4, v, 0.8, z, 0.4, 'plane'), seg(u + 0.3, v - 1.7, u + 0.3, v + 1.7, 0.75, z, 0.4, 'plane'), seg(u - 1.2, v - 0.8, u - 1.2, v + 0.8, 0.6, z, 0.4, 'plane')];
}

function carrier(mods: number): Part[] {
  const out: Part[] = [
    poly(hull(20, 4.4, 7), 0, 3, 'hull'),
    poly(sym([21, -1.5, 18.5, -5.7, -21, -5.7]), 3, 0.8, 'tarmac', { pat: 'deckline' }),
    ...parked(14, -2.8, 3.8),
    ...parked(9.5, -2.8, 3.8),
    ...parked(-12.5, -2.6, 3.8),
    ...parked(-16.5, -2.6, 3.8),
    // the island on the starboard side in the owner colour: bridge windows, a light funnel, the mast
    box(-8, 3, -1, 6, 3.8, 3.4, 'own'),
    box(-1.8, 3.4, -1, 5.6, 7.2, 0, 'glass'),
    box(-6.2, 3.7, -4.2, 5.3, 7.2, 1.2, 'sup'),
    box(-5.8, 4.1, -4.6, 4.9, 8.4, 0, 'black'),
    ell(-2.8, 4.5, 0.6, 0.6, 7.2, 3, 'gun'),
  ];
  if (mods & M_MASTERY) out.push(chevron(19.4, 2.4, 3.8), ...aaMount(-18, 3.8));
  if (mods & M_SPECIAL) out.push(...mine(-18.4, 3.6, 3.8), ...mine(-15.8, 3.6, 3.8));
  return out;
}

function transport(): Part[] {
  return [
    poly(sym([11, -3.4, 10, -4, -11, -4]), 0, 2.6, 'hull'),
    // bow ramp, the open hold with troops, the wheelhouse with an owner plate on its roof
    box(8.4, -3.4, 11, 3.4, 2.6, 0.5, 'deck', { pat: 'planks' }),
    box(-4.4, -3, 8.4, 3, 2.6, 0, 'tarmac', { pat: 'helmets', inset: true }),
    box(-10.2, -2.6, -5.6, 2.6, 2.6, 2.6, 'sup'),
    box(-6.3, -2.2, -5.6, 2.2, 5.2, 0, 'glass'),
    box(-9.7, -2.2, -7.2, 2.2, 5.2, 0, 'own'),
  ];
}

function tradeShip(): Part[] {
  const out: Part[] = [
    poly(sym([16, 0, 14.5, -2.4, 12, -3.6, -14, -3.6, -16, -2.6]), 0, 3, 'rust'),
    poly(sym([14.6, 0, 13.4, -1.9, 11.4, -2.8, -13.4, -2.8, -15, -2]), 3, 0, 'deck', { inset: true }),
    ell(12, 0, 0.5, 0.5, 3, 3, 'gun'),
  ];
  // three stacks of containers, two rows each, in mixed colours
  const colors: MatId[] = ['teal', 'mustard', 'red', 'navy', 'white', 'teal'];
  const stacks = [
    [-7.4, -2.4],
    [-1.8, 3.4],
    [3.8, 9],
  ];
  stacks.forEach(([u0, u1], i) => {
    out.push(box(u0, -2.6, u1, -0.1, 3, i === 1 ? 3 : 2.4, colors[i * 2], { pat: 'grille' }));
    out.push(box(u0, 0.1, u1, 2.6, 3, i === 2 ? 3 : 2.4, colors[i * 2 + 1], { pat: 'grille' }));
  });
  out.push(box(-15, -2.8, -9.6, 2.8, 3, 4, 'sup'), box(-10.3, -2.4, -9.6, 2.4, 7, 0, 'glass'), ell(-13, 0, 1.4, 1.2, 7, 2, 'own', { sh: 'dome' }), ell(-13, 0, 0.8, 0.7, 9, 0, 'black'));
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

// Tanks stand on the owner plate (plate()), and carry an owner band 3 art px wide across the turret.

function tank(mods: number): Part[] {
  const out: Part[] = [
    plate(-12, 11, 8, 2.4),
    box(-9.5, -6, 8.5, -3.6, 0, 2.2, 'tread', { pat: 'tread' }),
    box(-9.5, 3.6, 8.5, 6, 0, 2.2, 'tread', { pat: 'tread' }),
    poly(sym([9.5, -2.8, 8, -3.8, -9.5, -3.8]), 0.5, 2.3, 'olive'),
    box(-9, -2.6, -4.8, 2.6, 2.8, 0, 'olive', { pat: 'grille' }),
  ];
  if (mods & M_MASTERY) out.push(...skirts(-9.2, 8.2, 3.6, 6, 2.2, 'olive'));
  if (mods & M_SPECIAL) out.push(...snorkel(-7.4, 2.6, 2.8));
  out.push(
    ell(0.5, 0, 4.2, 3.4, 2.8, 2, 'olive', { sh: 'dome' }),
    // the owner band across the turret
    box(-3.7, -3.4, -0.7, 3.4, 2.8, 2.05, 'own', { sh: 'dome', sc: over(0.5, 0, 4.2, 3.4), clip: [0.5, 0, 4.2, 3.4] }),
    ell(-1.2, -1.4, 1.1, 1.1, 4.8, 0.4, 'olive', { sh: 'dome' }),
    seg(3.6, 0, 14, 0, 1.2, 3.8, 1, 'gun', { sh: 'cyl' }),
    box(13.2, -0.9, 14.8, 0.9, 3.7, 1.2, 'gun'),
  );
  return out;
}

function lightTank(mods: number): Part[] {
  // half a pixel row off the centre line, so the thin gun is one clean pixel row side on (not two)
  return centred(scaled(lightTankParts(mods), 1.12));
}
function lightTankParts(mods: number): Part[] {
  const out: Part[] = [
    // a round plate: the small quick tank's outline differs from the medium's slab, not only its size
    ell(-0.2, 0, 10.6, 7.4, 0, 0.3, 'own', { sh: 'plate' }),
    box(-7.5, -4.8, 6.5, -3, 0, 1.7, 'tread', { pat: 'tread' }),
    box(-7.5, 3, 6.5, 4.8, 0, 1.7, 'tread', { pat: 'tread' }),
    poly(sym([7.5, -2, 6, -3.1, -7.5, -3.1, -8, -2.4]), 0.4, 1.8, 'sand'),
    box(-7.6, -2, -5.6, 2, 2.2, 0.6, 'sand'),
  ];
  if (mods & M_MASTERY) out.push(...skirts(-7.2, 6.2, 3, 4.8, 1.7, 'sand'));
  if (mods & M_PATH3) {
    // Deep Raids: jerrycans and a spare fuel drum on the rear deck
    out.push(box(-5.6, -3, -4, -1.5, 2.2, 1, 'olive'), box(-5.6, -1.2, -4, 0.3, 2.2, 1, 'olive'), box(-5.6, 0.6, -4, 2.1, 2.2, 1, 'olive'), ell(-7, 2.4, 1, 1, 2.2, 1.1, 'red', { sh: 'dome' }));
  }
  if (mods & M_SPECIAL) out.push(...snorkel(-6.6, -2.2, 2.2));
  out.push(
    ell(1.2, 0, 2.7, 2.2, 2.2, 1.5, 'sand', { sh: 'dome' }),
    box(-1.6, -2.3, 1, 2.3, 2.2, 1.55, 'own', { sh: 'dome', sc: over(1.2, 0, 2.7, 2.2), clip: [1.2, 0, 2.7, 2.2] }),
    // a thin short gun in light steel: it reaches about 5 art px past the nose (the medium and heavy guns are longer
    // and thicker)
    seg(3, 0, 12.4, 0, 1, 3, 0.7, 'steel', { sh: 'cyl' }),
    ell(-1.4, -1.5, 0.5, 0.5, 3.7, 3.6, 'gun'),
  );
  return out;
}

function heavyTank(mods: number): Part[] {
  const out: Part[] = [
    plate(-14, 13, 9.2, 2.6),
    box(-11.5, -7, 10.5, -4.4, 0, 2.8, 'tread', { pat: 'tread' }),
    box(-11.5, 4.4, 10.5, 7, 0, 2.8, 'tread', { pat: 'tread' }),
    poly(sym([11.5, -3.4, 9.5, -4.7, -11.5, -4.7]), 0.6, 3, 'steel'),
    box(-11, -3, -6, 3, 3.6, 0, 'steel', { pat: 'grille' }),
  ];
  if (mods & M_MASTERY) out.push(...skirts(-11.2, 10.2, 4.4, 7, 2.8, 'steel'));
  if (mods & M_PATH3) {
    // Siege Tanks: a dozer ram ahead of the tracks
    out.push(poly(sym([14.6, -6, 13.6, -7.6, 11.6, -7.6]), 0.3, 2.6, 'steel', { pat: 'rivets' }), box(11, -2.6, 12, 2.6, 0.6, 2, 'gun'));
  }
  if (mods & M_SPECIAL) out.push(...snorkel(-9.6, 3, 3.6));
  const turret = sym([6, -2.6, 3.6, -4.2, -5.5, -4.2, -6.5, -3]);
  out.push(
    poly(turret, 3.6, 2.6, 'steel'),
    box(-5.6, -4.3, -2.6, 4.3, 3.6, 2.65, 'own', { clipPoly: turret }),
    ell(-1.4, -1.8, 1.3, 1.3, 6.2, 0.9, 'steel', { sh: 'dome' }),
    seg(4.5, 0, 20, 0, 1.6, 5, 1.2, 'gun', { sh: 'cyl' }),
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
 * front and a small orange exhaust glow at the back.
 */
function jetPod(u: number, v: number, z: number, len = 2.4, r = 0.9): Part[] {
  return [ell(u, v, len, r, z, 1, 'white', { sh: 'cyl' }), ell(u + len - 0.5, v, 0.6, Math.max(0.6, r - 0.3), z + 0.2, 0.9, 'black'), ell(u - len - 0.3, v, 0.6, 0.6, z, 0.6, 'flame', { glow: true })];
}

function bomber(mods: number): Part[] {
  const m: MatId = mods & M_NIGHT ? 'night' : 'plane';
  const tail: MatId = mods & M_MASTERY ? 'gold' : m;
  const out: Part[] = [];
  const jet = !!(mods & M_JET);
  if (mods & M_SPECIAL) out.push(...dropTanks(jet ? 3.4 : 5.4, 2.9, 2.1));
  if (jet) {
    // Jet Engines: the same twin-engine bomber with wings swept back and a jet pod under each wing, no propellers
    out.push(poly(sym([4.5, -1.6, -0.6, -13, -2.8, -13, -0.6, -1.6]), 2.6, 0.6, m), ...tips(-2.8, -0.4, 11.4, 13, 3.2), ...jetPod(2.8, -5.2, 2.2), ...jetPod(2.8, 5.2, 2.2));
  } else {
    out.push(
      poly(sym([4.5, -1.6, 3.4, -13, 1.2, -13, -0.6, -1.6]), 2.6, 0.6, m),
      ...tips(1, 3.6, 11.4, 13, 3.2),
      ell(4, -5, 3, 1.15, 2.8, 1.3, m, { sh: 'cyl' }),
      ell(4, 5, 3, 1.15, 2.8, 1.3, m, { sh: 'cyl' }),
      seg(7.4, -7.4, 7.4, -2.6, 0.5, 3.2, 0.3, 'gun'),
      seg(7.4, 2.6, 7.4, 7.4, 0.5, 3.2, 0.3, 'gun'),
    );
  }
  out.push(
    ell(0, 0, 10.5, 1.9, 2.4, 1.8, m, { sh: 'cyl' }),
    box(-5, -2, -3.8, 2, 2.4, 1.85, 'own', { sh: 'cyl', sc: over(0, 0, 10.5, 1.9), clip: [0, 0, 10.5, 1.9] }),
    ell(9, 0, 1.6, 1.3, 2.8, 1.2, 'glass', { sh: 'dome' }),
    box(5, -0.9, 6.6, 0.9, 4.1, 0, 'glass'),
    poly(sym([-7.2, -1, -8.2, -5, -9.8, -5, -10, -1]), 2.6, 0.5, tail),
    seg(-10.2, 0, -6.5, 0, 0.8, 4, 2, tail),
  );
  return out;
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

function groundAttack(mods: number): Part[] {
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
    return out;
  }
  if (mods & M_SPECIAL) out.push(...dropTanks(4.8, 2.6, 2.1));
  out.push(...wingRockets([{ v: 4.4, le: 3.6 }, { v: 6, le: 3.5 }, { v: 7.6, le: 3.4 }], 2.1));
  out.push(
    poly(sym([4, -1.4, 3.4, -10, 0.4, -10, -1.6, -1.4]), 2.6, 0.6, m),
    ...tips(0.4, 3.4, 8.8, 10, 3.2),
    ell(0, 0, 8.4, 1.7, 2.4, 1.7, m, { sh: 'cyl' }),
    box(-3.6, -1.8, -2.4, 1.8, 2.4, 1.75, 'own', { sh: 'cyl', sc: over(0, 0, 8.4, 1.7), clip: [0, 0, 8.4, 1.7] }),
    ell(6.8, 0, 1.9, 2, 2.4, 1.8, 'gun', { sh: 'dome' }),
    seg(8.9, -2.9, 8.9, 2.9, 0.5, 3.4, 0.3, 'gun'),
    ell(1.6, 0, 1.7, 1, 4.1, 0.6, 'glass', { sh: 'dome' }),
    poly(sym([-6.2, -0.8, -7, -3.8, -8.4, -3.8, -8.6, -0.8]), 2.6, 0.5, tail),
    seg(-8.8, 0, -6, 0, 0.7, 3.8, 1.6, tail),
  );
  return out;
}

function heavyBomber(mods: number): Part[] {
  const m: MatId = mods & M_NIGHT ? 'night' : 'metal';
  const tail: MatId = mods & M_MASTERY ? 'gold' : m;
  const out: Part[] = [];
  if (mods & M_SPECIAL) out.push(...dropTanks(6.6, 8.2, 2.3));
  out.push(poly(sym([5, -2, 3.4, -18, 0.6, -18, -2, -2]), 2.8, 0.7, m), ...tips(0.6, 3.4, 16.4, 18, 3.5));
  for (const v of [-11, -5.5, 5.5, 11]) out.push(ell(4.2, v, 2.8, 1.1, 3, 1.3, m, { sh: 'cyl' }), seg(7.3, v - 2.3, 7.3, v + 2.3, 0.5, 3.5, 0.3, 'gun'));
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
  return out;
}

function fighter(mods: number): Part[] {
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
    return out;
  }
  if (mods & M_SPECIAL) out.push(...dropTanks(3.4, 2.8, 2.1));
  out.push(
    poly(sym([2.6, -1, 1.8, -7.5, 0, -7.5, -1.8, -1]), 2.7, 0.5, m),
    ...tips(0, 1.8, 6.3, 7.5, 3.2),
    ell(0, 0, 7, 1.25, 2.6, 1.3, m, { sh: 'cyl' }),
    ell(7, 0, 0.8, 0.8, 2.8, 1, 'own', { sh: 'dome' }),
    seg(7.5, -2.3, 7.5, 2.3, 0.45, 3.4, 0.2, 'gun'),
    ell(0.8, 0, 1.4, 0.75, 3.9, 0.5, 'glass', { sh: 'dome' }),
    poly(sym([-5, -0.6, -5.6, -2.8, -6.8, -2.8, -7, -0.6]), 2.7, 0.4, tail),
    seg(-7, 0, -4.8, 0, 0.6, 3.6, 1.4, tail),
  );
  return out;
}

function transportPlane(mods: number): Part[] {
  const m: MatId = 'plane';
  const out: Part[] = [];
  const jet = !!(mods & M_JET);
  if (mods & M_SPECIAL) out.push(...dropTanks(jet ? 1.6 : 4.4, 10.5, 3.6));
  if (jet) {
    out.push(poly(sym([3, -2, -3.4, -15, -5.4, -15, -1.4, -2]), 4.6, 0.5, m), ...tips(-5.2, -3.4, 13.6, 15, 5.1));
    for (const v of [-6.5, 6.5]) out.push(...jetPod(2.6, v, 3.6, 2.6, 1));
  } else {
    out.push(poly(sym([3, -2, 2.2, -15, 0, -15, -1, -2]), 4.6, 0.5, m), ...tips(0, 2.2, 13.6, 15, 5.1));
    for (const v of [-6.5, 6.5]) out.push(ell(3.2, v, 2.6, 1.1, 4.2, 1.2, m, { sh: 'cyl' }), seg(5.9, v - 2.3, 5.9, v + 2.3, 0.5, 4.8, 0.3, 'gun'));
  }
  out.push(
    ell(0, 0, 12, 2.6, 2.2, 2.6, m, { sh: 'cyl' }),
    box(-4.2, -2.7, -2.8, 2.7, 2.2, 2.65, 'own', { sh: 'cyl', sc: over(0, 0, 12, 2.6), clip: [0, 0, 12, 2.6] }),
    ell(10.4, 0, 1.2, 1.6, 4, 0.6, 'glass', { sh: 'dome' }),
    seg(-12.4, 0, -8.6, 0, 0.9, 4.6, 3.2, m),
    box(-12.6, -5.6, -10.4, 5.6, 7.6, 0.4, m),
    box(-12.6, -5.6, -10.4, -4.4, 8, 0, 'own'),
    box(-12.6, 4.4, -10.4, 5.6, 8, 0, 'own'),
  );
  return out;
}

function reconPlane(mods: number): Part[] {
  const m: MatId = 'plane';
  const out: Part[] = [];
  if (mods & M_SPECIAL) out.push(...dropTanks(3.8, 7.4, 2.2));
  out.push(
    poly(sym([2.4, -1.4, 1.8, -12, 0.4, -12, -0.6, -1.4]), 2.6, 0.4, m),
    ...tips(0.4, 1.8, 10.6, 12, 3),
    seg(4, -3.4, -8.4, -3.4, 1, 2.4, 1, m, { sh: 'cyl' }),
    seg(4, 3.4, -8.4, 3.4, 1, 2.4, 1, m, { sh: 'cyl' }),
    ell(3.6, -3.4, 1.6, 1, 2.4, 1.2, m, { sh: 'cyl' }),
    ell(3.6, 3.4, 1.6, 1, 2.4, 1.2, m, { sh: 'cyl' }),
    seg(5.4, -5.2, 5.4, -1.6, 0.45, 3.2, 0.2, 'gun'),
    seg(5.4, 1.6, 5.4, 5.2, 0.45, 3.2, 0.2, 'gun'),
    ell(2.2, 0, 4.8, 1.3, 2.6, 1.4, m, { sh: 'cyl' }),
    ell(6.2, 0, 1.3, 1.1, 2.8, 1.2, 'glass', { sh: 'dome' }),
    ell(3.4, 0, 0.6, 0.6, 4, 0, 'black'),
    box(-9.2, -3.4, -7.6, 3.4, 2.6, 0.4, m),
    seg(-9.4, -3.4, -7.4, -3.4, 0.6, 3, 1.4, m),
    seg(-9.4, 3.4, -7.4, 3.4, 0.6, 3, 1.4, m),
  );
  return out;
}

// ------------------------------------------------------------------------------------------------- missiles

/**
 * The exhaust: a small white-yellow flame at the nozzle (flat shaded, so it stays light: a pale yellow rim, yellow
 * inside) with a white-hot core; frame 1 is a pixel longer (flicker).
 */
function flame(u: number, r: number, len: number, z: number, frame: number): Part[] {
  const L = len + (frame ? 1.2 : 0);
  return [poly([u, -r, u, r, u - L, 0], z, 0.6, 'flame', { glow: true }), ell(u - 0.5, 0, 1, 0.55, z + 0.2, 0.6, 'white', { glow: true })];
}

/**
 * The rocket: a slender grey body about five times longer than wide (light top stripe, mid, dark underside), a long
 * tapering nose that still ends in a point at one art pixel, with a white tip, a yellow warning band, swept tail fins
 * sticking out past the body on both sides, a short top fin, a dark nozzle and a small bright flame. A projectile:
 * no owner colour.
 */
function rocket(frame: number): Part[] {
  const body = over(-1.2, 0, 6, 1.5);
  return [
    ...flame(-7.2, 0.8, 2.4, 1.6, frame),
    // side fins: swept back, mid grey so they read against the outline; their span is twice the body's width
    poly(sym([-2.8, -1.4, -6.2, -3, -7.6, -3, -6.6, -1.4]), 1.5, 0.5, 'hull'),
    box(-7.2, -0.9, -6.2, 0.9, 1.7, 1.2, 'gun'),
    box(-6.4, -1.5, 3, 1.5, 1.4, 1.8, 'metal', { sh: 'cyl', sc: body }),
    box(-1.4, -1.55, -0.4, 1.55, 1.4, 1.85, 'yellow', { sh: 'cyl', sc: body }),
    poly([9.2, 0, 6.6, -1, 3, -1.5, 3, 1.5, 6.6, 1], 1.4, 1.8, 'metal', { sh: 'cyl', sc: over(5, 0, 3, 1.5) }),
    ell(8.4, 0, 1.1, 0.62, 1.9, 1, 'white'),
  ];
}

/**
 * The atom bomb: larger and thicker, olive with a yellow and black hazard band, bigger swept fins, a long nose with a
 * sand tip. The map draws a faint ring round it (render/units.ts).
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
      parts = bomber(m);
      break;
    case 'groundAttack':
      parts = groundAttack(m);
      break;
    case 'heavyBomber':
      parts = heavyBomber(m);
      break;
    case 'fighter':
      parts = fighter(m);
      break;
    case 'transportPlane':
      parts = transportPlane(m);
      break;
    case 'reconPlane':
      parts = reconPlane(m);
      break;
    case 'rocket':
      parts = centred(rocket(frame & 1));
      break;
    case 'atomBomb':
      parts = centred(atomBomb(frame & 1));
      break;
  }
  // missiles fly: drawn flat from straight above, so the slender body stays slender at every heading
  return { parts: parts.map(minSize), air: AIR.has(key), flat: key === 'rocket' || key === 'atomBomb' };
}

/**
 * Lines and posts at least one art pixel wide, so barrels, masts and propellers never break up: a line on the centre
 * line seen side on must still cover the middle of one foreshortened pixel row (half a row is 0.5 / FORE = 0.6 model
 * units away), so lines are at least 1.25 wide.
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
    } else for (let i = 0; i < q.length; i += 2) {
      a = Math.min(a, q[i]);
      b = Math.max(b, q[i]);
    }
  }
  return b - a;
}
