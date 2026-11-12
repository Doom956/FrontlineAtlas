// The unit art (client only): one small model per unit and arsenal variant, rasterized by spriteBake.ts. Model units
// are art pixels at full size; the nose points at +u, the starboard side at +v. All art is original and lives here
// as code.
//
// Every vehicle has its own silhouette, not just its own colour:
//   warship (before any arsenal pick)  a plain gunboat: one gun fore, one aft, a small bridge and funnel
//   destroyer    long and slim, a sharp bow, ONE turret, torpedo tubes, a raked funnel
//   battleship   the longest and widest hull, THREE big twin turrets (two forward, one superfiring), a tall tower
//   submarine    a low dark cigar, half under water (translucent sea around it), a conning tower, bow foam
//   carrier      a flat dark flight deck with a dashed centre line, an island on the starboard side, parked planes
//   tank division  a medium tank: tracks, a round turret, a medium gun (olive)
//   light tank   small and quick: narrow tracks, a little turret set forward, a thin short gun, an aerial (tan)
//   heavy tank   wide and long: broad tracks, an angular turret, a long thick gun with a muzzle brake (dark steel)
//   bomber       twin engines, straight wings, glazed nose
//   ground-attack  a stubby single-engine plane with rows of red-tipped rockets under its wings (camouflage green)
//   heavy bomber   four engines on long wings, twin tail fins, natural metal
// Upgrades a player owns add small details (mods): a gold bow chevron and an AA mount (Naval Mastery), mines at the
// stern (Naval Mines), armour skirts over the tracks (Armor Mastery), jerrycans (Deep Raids), a dozer ram (Siege
// Tanks), a snorkel (Amphibious Tanks), jet engines and swept wings (Jet Engines), gun turrets (Strategic Bombing),
// drop tanks (Drop Tanks), dark night paint (Night Bombing) and a gold tail (Air Mastery). The owner's colour is a
// small band or plate on each one (funnel, turret band, wingtips), never the whole unit.
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
  bomber: M_MASTERY | M_SPECIAL | M_NIGHT,
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
/** A ship hull: bow point at +L, shoulders `bow` back, a square stern with cut corners. */
const hull = (L: number, b: number, bow: number): number[] => sym([L, 0, L - bow, -b, -L + 1, -b, -L, -b + 1]);
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
/** A dome / cylinder shading frame for a band laid over an ellipse. */
const over = (u: number, v: number, ru: number, rv: number): readonly [number, number, number, number] => [u, v, ru, rv];

// ------------------------------------------------------------------------------------------------- navy

/** Gold chevron on the bow deck (Naval Mastery). */
function chevron(L: number, b: number, z: number): Part {
  return poly([L - 2.4, 0, L - 5.2, -b, L - 6.4, -b, L - 3.8, 0, L - 6.4, b, L - 5.2, b], z, 0, 'gold');
}
/** Two pairs of mines on rails at the stern (Naval Mines). */
function mines(L: number, z: number): Part[] {
  return [ell(-L + 2.6, -1.1, 0.85, 0.85, z, 0.9, 'rust', { sh: 'dome' }), ell(-L + 2.6, 1.1, 0.85, 0.85, z, 0.9, 'rust', { sh: 'dome' }), ell(-L + 4.6, -1.1, 0.85, 0.85, z, 0.9, 'rust', { sh: 'dome' }), ell(-L + 4.6, 1.1, 0.85, 0.85, z, 0.9, 'rust', { sh: 'dome' })];
}
/** A small twin AA mount (Naval Mastery). */
function aaMount(u: number, z: number): Part[] {
  return [ell(u, 0, 1.2, 1.1, z, 0.9, 'turret', { sh: 'dome' }), seg(u + 0.4, -0.45, u + 2.6, -0.45, 0.5, z + 0.6, 0.3, 'gun'), seg(u + 0.4, 0.45, u + 2.6, 0.45, 0.5, z + 0.6, 0.3, 'gun')];
}

function warship(mods: number): Part[] {
  const L = 15;
  const out: Part[] = [
    poly(hull(L, 3.5, 6), 0, 3, 'hull'),
    poly(hull(L - 1.2, 2.6, 5.4), 3, 0, 'deck', { inset: true }),
    // gun forward
    ell(7, 0, 1.9, 1.7, 3, 1.4, 'turret', { sh: 'dome' }),
    seg(7.6, 0, 12.6, 0, 0.9, 3.8, 0.6, 'gun', { sh: 'cyl' }),
    // bridge, its windows, the mast
    box(-2.5, -2.2, 3, 2.2, 3, 3, 'sup'),
    box(2.2, -1.8, 3, 1.8, 6, 0, 'glass'),
    ell(0.2, 0, 0.55, 0.55, 6, 3.4, 'gun'),
    // funnel: the owner band
    ell(-5.6, 0, 1.7, 1.5, 3, 3.4, 'own', { sh: 'dome' }),
    ell(-5.6, 0, 0.9, 0.8, 6.4, 0, 'black'),
    // small gun aft
    ell(-10, 0, 1.3, 1.2, 3, 1, 'turret', { sh: 'dome' }),
    seg(-10.5, 0, -13.6, 0, 0.7, 3.6, 0.5, 'gun', { sh: 'cyl' }),
  ];
  if (mods & M_MASTERY) out.push(chevron(L, 1.6, 3), ...aaMount(-7.8, 3));
  if (mods & M_SPECIAL) out.push(...mines(L, 3).slice(0, 2));
  return out;
}

function destroyer(mods: number): Part[] {
  const L = 14;
  const out: Part[] = [
    poly(hull(L, 2.6, 8), 0, 2.6, 'hull'),
    poly(hull(L - 1.1, 1.8, 7.4), 2.6, 0, 'deck', { inset: true }),
    // the one turret
    ell(6.4, 0, 1.6, 1.4, 2.6, 1.3, 'turret', { sh: 'dome' }),
    seg(7, 0, 11.6, 0, 0.8, 3.4, 0.5, 'gun', { sh: 'cyl' }),
    // low bridge
    box(1, -1.7, 4, 1.7, 2.6, 2.6, 'sup'),
    box(3.3, -1.3, 4, 1.3, 5.2, 0, 'glass'),
    ell(1.6, 0, 0.5, 0.5, 5.2, 3, 'gun'),
    // raked funnel in the owner colour
    poly([-1, -1.1, -1.6, 1.1, -3.8, 1.1, -3.2, -1.1], 2.6, 2.8, 'own'),
    box(-3.2, -0.7, -1.9, 0.7, 5.4, 0, 'black'),
    // torpedo tubes and depth charges
    seg(-9, -0.55, -5.2, -0.55, 0.8, 2.6, 0.7, 'gun', { sh: 'cyl' }),
    seg(-9, 0.55, -5.2, 0.55, 0.8, 2.6, 0.7, 'gun', { sh: 'cyl' }),
    box(-13, -1, -11.4, 1, 2.6, 0.6, 'gun'),
  ];
  if (mods & M_MASTERY) out.push(chevron(L, 1.2, 2.6), ...aaMount(-3.8 - 2.6, 2.6).map((p) => ({ ...p, z: p.z + 0.2 })));
  if (mods & M_SPECIAL) out.push(...mines(L, 2.6).slice(0, 2));
  return out;
}

/** A big twin turret at u facing forward (dir 1) or aft (-1). */
function bigTurret(u: number, z: number, dir: 1 | -1): Part[] {
  return [ell(u, 0, 2.6, 2.2, z, 1.8, 'turret', { sh: 'dome' }), seg(u + dir * 0.6, -0.75, u + dir * 7, -0.75, 0.7, z + 1, 0.5, 'gun', { sh: 'cyl' }), seg(u + dir * 0.6, 0.75, u + dir * 7, 0.75, 0.7, z + 1, 0.5, 'gun', { sh: 'cyl' })];
}

function battleship(mods: number): Part[] {
  const L = 20;
  const out: Part[] = [
    poly(hull(L, 4.2, 9), 0, 3.6, 'hull'),
    poly(hull(L - 1.2, 3.2, 8.4), 3.6, 0, 'deck', { inset: true }),
    ...bigTurret(11.8, 3.6, 1),
    // the superfiring turret on its barbette
    ell(7.2, 0, 2.2, 2, 3.6, 1, 'hull', { sh: 'dome' }),
    ...bigTurret(7.2, 4.6, 1),
    // superstructure and the tall tower
    box(-6, -2.8, 4, 2.8, 3.6, 2.2, 'sup'),
    box(-1, -1.8, 3, 1.8, 5.8, 3.2, 'sup'),
    box(2.3, -1.4, 3, 1.4, 9, 0, 'glass'),
    ell(1, 0, 1.1, 1.1, 9, 1.4, 'gun', { sh: 'dome' }),
    // funnel (owner) and secondary guns
    ell(-4, 0, 1.8, 1.5, 5.8, 2.4, 'own', { sh: 'dome' }),
    ell(-4, 0, 1, 0.8, 8.2, 0, 'black'),
    ell(-2, -3.5, 0.9, 0.8, 3.6, 0.9, 'turret', { sh: 'dome' }),
    ell(-2, 3.5, 0.9, 0.8, 3.6, 0.9, 'turret', { sh: 'dome' }),
    ell(1.8, -3.5, 0.9, 0.8, 3.6, 0.9, 'turret', { sh: 'dome' }),
    ell(1.8, 3.5, 0.9, 0.8, 3.6, 0.9, 'turret', { sh: 'dome' }),
    ...bigTurret(-12.4, 3.6, -1),
  ];
  if (mods & M_MASTERY) out.push(chevron(L, 2.2, 3.6), ...aaMount(-8.2, 3.6));
  if (mods & M_SPECIAL) out.push(...mines(L, 3.6).slice(0, 2));
  return out;
}

function submarine(mods: number): Part[] {
  const out: Part[] = [
    // the sea over the hull: a darker translucent cigar, foam at the bow
    ell(0, 0, 15.6, 3.1, 0, 0, 'sea', { a: 0.5 }),
    poly(sym([16.4, 0, 13, -2.7, 12.4, -2.4, 14.9, 0]), 0, 0, 'foam', { a: 0.75 }),
    // the low hull, its deck strip, the stern fins
    ell(0, 0, 14.4, 2.1, 0, 1.1, 'sub', { sh: 'cyl' }),
    box(-7, -0.55, 9.5, 0.55, 1.1, 0, 'black'),
    poly(sym([-13, 0, -15.6, -2.6, -16.2, -2.6, -15.2, 0]), 0.5, 0.4, 'sub'),
    // conning tower with dive planes, the owner band on top, a periscope
    ell(3, 0, 3, 1.25, 1.1, 2.4, 'sub'),
    seg(4, -2.5, 4, 2.5, 0.8, 2.4, 0.3, 'sub'),
    ell(3, 0, 3, 1.25, 3.5, 0.5, 'own'),
    ell(2, 0, 0.45, 0.45, 4, 1.8, 'gun'),
  ];
  if (mods & M_MASTERY) out.push(box(-1.8, -0.6, 0.2, 0.6, 1.1, 0, 'gold'), box(-4.6, -0.6, -2.6, 0.6, 1.1, 0, 'gold'));
  if (mods & M_SPECIAL) out.push(ell(-8.6, 0, 0.9, 0.9, 1.1, 0.8, 'rust', { sh: 'dome' }), ell(-10.6, 0, 0.9, 0.9, 1.1, 0.8, 'rust', { sh: 'dome' }), ell(-12.4, 0, 0.8, 0.8, 1.1, 0.7, 'rust', { sh: 'dome' }));
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
    // the island on the starboard side: bridge, owner funnel, mast
    box(-8, 3.2, -1, 5.8, 3.8, 4, 'sup'),
    box(-1.8, 3.5, -1, 5.5, 7.8, 0, 'glass'),
    box(-6.4, 3.7, -4, 5.3, 7.8, 1.4, 'own'),
    ell(-2.8, 4.5, 0.6, 0.6, 7.8, 3, 'gun'),
  ];
  if (mods & M_MASTERY) out.push(chevron(21, 2.4, 3.8), ...aaMount(-18, 3.8));
  if (mods & M_SPECIAL) out.push(...mines(20, 3.8).slice(0, 2).map((p) => ({ ...p, p: [p.p[0] - 1, p.p[1] + 3.4, p.p[2], p.p[3]] })));
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

/** Armour skirts over both tracks (Armor Mastery). */
function skirts(u0: number, u1: number, vIn: number, vOut: number, z: number, m: MatId): Part[] {
  return [box(u0, -vOut - 0.2, u1, -vIn, z, 0.6, m, { pat: 'rivets' }), box(u0, vIn, u1, vOut + 0.2, z, 0.6, m, { pat: 'rivets' })];
}
/** A snorkel pipe at the rear (Amphibious Tanks). */
function snorkel(u: number, v: number, z: number): Part[] {
  return [ell(u, v, 0.7, 0.7, z, 5, 'gun', { sh: 'dome' }), ell(u, v, 1, 1, z + 5, 0.4, 'gun')];
}

function tank(mods: number): Part[] {
  const out: Part[] = [
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
    box(-3.2, -3.4, -1.2, 3.4, 2.8, 2.05, 'own', { sh: 'dome', sc: over(0.5, 0, 4.2, 3.4), clip: [0.5, 0, 4.2, 3.4] }),
    ell(-0.8, -1.2, 1.1, 1.1, 4.8, 0.4, 'olive', { sh: 'dome' }),
    seg(3.6, 0, 14, 0, 1.2, 3.8, 1, 'gun', { sh: 'cyl' }),
    box(13.2, -0.9, 14.8, 0.9, 3.7, 1.2, 'gun'),
  );
  return out;
}

function lightTank(mods: number): Part[] {
  return scaled(lightTankParts(mods), 1.12);
}
function lightTankParts(mods: number): Part[] {
  const out: Part[] = [
    box(-7.5, -4.8, 6.5, -3, 0, 1.7, 'tread', { pat: 'tread' }),
    box(-7.5, 3, 6.5, 4.8, 0, 1.7, 'tread', { pat: 'tread' }),
    poly(sym([7.5, -2, 6, -3.1, -7.5, -3.1, -8, -2.4]), 0.4, 1.8, 'sand'),
    box(-7.6, -2, -5.6, 2, 2.2, 0.6, 'sand'),
  ];
  if (mods & M_MASTERY) out.push(...skirts(-7.2, 6.2, 3, 4.8, 1.7, 'sand'));
  if (mods & M_PATH3) {
    // Deep Raids: jerrycans and a spare fuel drum on the rear deck
    out.push(box(-5.4, -2.9, -4.2, -1.5, 2.2, 1, 'olive'), box(-5.4, -1.3, -4.2, 0.1, 2.2, 1, 'olive'), box(-5.4, 0.3, -4.2, 1.7, 2.2, 1, 'olive'), ell(-6.8, 2.4, 0.9, 0.9, 2.2, 1.1, 'red', { sh: 'dome' }));
  }
  if (mods & M_SPECIAL) out.push(...snorkel(-6.6, -2.2, 2.2));
  out.push(
    ell(1.2, 0, 2.7, 2.2, 2.2, 1.5, 'sand', { sh: 'dome' }),
    box(-1.1, -2.3, 0.5, 2.3, 2.2, 1.55, 'own', { sh: 'dome', sc: over(1.2, 0, 2.7, 2.2), clip: [1.2, 0, 2.7, 2.2] }),
    seg(3, 0, 9.6, 0, 1, 3, 0.7, 'gun', { sh: 'cyl' }),
    ell(-1.4, -1.5, 0.5, 0.5, 3.7, 3.6, 'gun'),
  );
  return out;
}

function heavyTank(mods: number): Part[] {
  const out: Part[] = [
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
    box(-5.4, -4.3, -3.4, 4.3, 3.6, 2.65, 'own', { clipPoly: turret }),
    ell(-3, -1.8, 1.3, 1.3, 6.2, 0.9, 'steel', { sh: 'dome' }),
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

function bomber(mods: number): Part[] {
  const m: MatId = mods & M_NIGHT ? 'night' : 'plane';
  const tail: MatId = mods & M_MASTERY ? 'gold' : m;
  const out: Part[] = [];
  if (mods & M_SPECIAL) out.push(...dropTanks(5.4, 2.9, 2.1));
  out.push(
    poly(sym([4.5, -1.6, 3.4, -13, 1.2, -13, -0.6, -1.6]), 2.6, 0.6, m),
    ...tips(1, 3.6, 11.4, 13, 3.2),
    ell(4, -5, 3, 1.15, 2.8, 1.3, m, { sh: 'cyl' }),
    ell(4, 5, 3, 1.15, 2.8, 1.3, m, { sh: 'cyl' }),
    seg(7.4, -7.4, 7.4, -2.6, 0.5, 3.2, 0.3, 'gun'),
    seg(7.4, 2.6, 7.4, 7.4, 0.5, 3.2, 0.3, 'gun'),
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
    // Jet Engines: swept wings, a pointed nose, intakes and a jet pipe, no propeller
    const le = (v: number): number => 3 - ((v - 1.6) * 5.6) / 7.8;
    if (mods & M_SPECIAL) out.push(...dropTanks(le(2.9) + 1.2, 2.9, 2.1));
    out.push(...wingRockets([{ v: 4.2, le: le(4.2) }, { v: 6, le: le(6) }], 2.1));
    out.push(
      poly(sym([3, -1.6, -2.6, -9.4, -4.6, -9.4, -3.4, -1.6]), 2.6, 0.6, m),
      ...tips(-4.4, -2.8, 8.2, 9.4, 3.2),
      ell(0, 0, 8.6, 1.6, 2.4, 1.7, m, { sh: 'cyl' }),
      poly([11, 0, 8, -1.1, 8, 1.1], 2.6, 1.3, m, { sh: 'cyl', sc: over(9.5, 0, 1.5, 1.1) }),
      ell(1.6, -1.9, 1.5, 0.75, 2.6, 1.1, 'gun', { sh: 'cyl' }),
      ell(1.6, 1.9, 1.5, 0.75, 2.6, 1.1, 'gun', { sh: 'cyl' }),
      box(-9.4, -0.8, -8.4, 0.8, 2.6, 1.3, 'gun'),
      box(-3.8, -1.7, -2.6, 1.7, 2.4, 1.75, 'own', { sh: 'cyl', sc: over(0, 0, 8.6, 1.6), clip: [0, 0, 8.6, 1.6] }),
      ell(3.4, 0, 1.8, 0.95, 4, 0.6, 'glass', { sh: 'dome' }),
      poly(sym([-6, -0.8, -7.6, -3.6, -8.8, -3.6, -8.6, -0.8]), 2.6, 0.5, tail),
      seg(-8.8, 0, -5.6, 0, 0.7, 3.8, 1.8, tail),
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
      ell(1, -1.4, 1.2, 0.6, 2.7, 1, 'gun', { sh: 'cyl' }),
      ell(1, 1.4, 1.2, 0.6, 2.7, 1, 'gun', { sh: 'cyl' }),
      box(-8.2, -0.6, -7.3, 0.6, 2.7, 1, 'gun'),
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
    for (const v of [-6.5, 6.5]) out.push(ell(3, v, 2.6, 0.95, 3.6, 1, 'metal', { sh: 'cyl' }), ell(5.4, v, 0.55, 0.7, 3.6, 1, 'black'));
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

/** The exhaust: a tiny white-yellow flame at the tail; frame 1 is a pixel longer (flicker). */
function flame(u: number, r: number, len: number, z: number, frame: number): Part[] {
  const L = len + (frame ? 1 : 0);
  return [poly([u, -r, u, r, u - L, 0], z, 1, 'flame', { glow: true, sh: 'cyl', sc: over(u - L / 2, 0, L / 2, r) }), ell(u - 0.4, 0, 0.9, 0.6, z + 0.3, 0.8, 'white', { glow: true })];
}

/**
 * The rocket: a slender grey tube about six times longer than wide (light top stripe, mid, dark underside), a pointed
 * nose with a light tip, small dark fins, a 1 px yellow warning band and a tiny flame. A projectile: no owner colour.
 */
function rocket(frame: number): Part[] {
  const body = over(-1.4, 0, 6, 1.2);
  return [
    ...flame(-7.4, 0.7, 2.2, 1.6, frame),
    poly(sym([-4.2, -1.1, -6.6, -3, -7.4, -3, -7, -1.1]), 1.4, 0.4, 'gun'),
    box(-7.4, -0.7, -6.8, 0.7, 1.6, 1.1, 'gun'),
    box(-6.8, -1.2, 4, 1.2, 1.4, 1.7, 'metal', { sh: 'cyl', sc: body }),
    box(-1.6, -1.25, -0.6, 1.25, 1.4, 1.75, 'yellow', { sh: 'cyl', sc: body }),
    poly([7.6, 0, 6.2, -0.75, 4, -1.2, 4, 1.2, 6.2, 0.75], 1.4, 1.7, 'metal', { sh: 'cyl', sc: over(5.8, 0, 1.8, 1.2) }),
    ell(7.1, 0, 0.8, 0.6, 2.4, 0.6, 'white'),
    seg(-7, 0, -4.4, 0, 1.1, 3, 1.2, 'gun'),
  ];
}

/** The atom bomb: larger and thicker, olive with a yellow and black hazard band, bigger fins, a light nose tip. */
function atomBomb(frame: number): Part[] {
  const body = over(-1.8, 0, 7, 1.9);
  return [
    ...flame(-9.4, 0.9, 2.6, 1.8, frame),
    poly(sym([-5, -1.8, -8.2, -4.4, -9.4, -4.4, -8.8, -1.8]), 1.4, 0.5, 'gun'),
    box(-9.4, -1, -8.8, 1, 1.8, 1.4, 'gun'),
    box(-8.8, -1.9, 4.6, 1.9, 1.4, 2.3, 'olive', { sh: 'cyl', sc: body }),
    box(-3.6, -1.95, -2.4, 1.95, 1.4, 2.35, 'yellow', { sh: 'cyl', sc: body }),
    box(-2.4, -1.95, -1.4, 1.95, 1.4, 2.35, 'black', { sh: 'cyl', sc: body }),
    box(-1.4, -1.95, -0.2, 1.95, 1.4, 2.35, 'yellow', { sh: 'cyl', sc: body }),
    poly([9.4, 0, 8, -1.2, 4.6, -1.9, 4.6, 1.9, 8, 1.2], 1.4, 2.3, 'olive', { sh: 'cyl', sc: over(7, 0, 2.4, 1.9) }),
    ell(8.9, 0, 0.8, 0.7, 2.6, 0.8, 'sand'),
    seg(-9, 0, -5.2, 0, 1.2, 3.7, 1.6, 'gun'),
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
      parts = rocket(frame & 1);
      break;
    case 'atomBomb':
      parts = atomBomb(frame & 1);
      break;
  }
  return { parts: parts.map(minSize), air: AIR.has(key) };
}

/** Lines and posts at least one art pixel wide, so barrels, masts and propellers never break up. */
function minSize(p: Part): Part {
  if (p.k === 'seg' && p.p[4] < 1.1) return { ...p, p: [p.p[0], p.p[1], p.p[2], p.p[3], 1.1] };
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
