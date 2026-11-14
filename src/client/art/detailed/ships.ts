// The detailed style's ship models (client only, pure data), rasterized by bake.ts like every other unit model. Model
// units are screen px at mid zoom; the bow points at +u, the starboard side at +v. All art is original and lives here
// as code.
//
// Each ship reads by its silhouette first, then its colour (at mid zoom one unit is one screen px, so every detail is
// a few px big and set off by value; see the value plan under "hull and fittings"):
//   carrier      the biggest (60 long): a broad dark flight deck with its edge lit on the sides toward the light,
//                the angled landing deck to port, the tall light island to starboard, three pale planes parked on deck
//   battleship   52 long and broad: a dark steel deck with four big pale turrets ringed dark (two forward, two aft,
//                the inner ones superfiring) with dark deck between them, their guns as thick light bars, a stepped
//                tower with light roofs and dark sides
//   warship      (no arsenal pick) a 35 long cruiser with a warm teak deck, three dark twin turrets with black gun
//                bars, a light bridge, two upright light funnels, teak showing between every part
//   destroyer    a 28 long needle with the lightest deck, a dark gun mount at each end, the light bridge, two raked
//                light funnels and two banks of torpedo tubes as thick black bars across the deck
//   submarine    a dark cigar outlined in white water, one big grey sail in the middle and a deck gun
//   transport    a boxy landing ship: bow doors, an open well deck full of helmeted troops, the bridge aft
//   trade ship   a black merchant hull with a cream house aft, deck containers and cargo cranes, clearly no guns
// Every funnel top is the owner's colour, lit from above so it shows at mid zoom.
// Upgrades change the ship you see, in bold colours:
//   Naval Mastery  the modern refit: a dark lattice mast under a big white radar dome, launch cells (a few big dark
//                  hatches on a pale patch) and pale box launchers in place of some of the old guns; the submarine
//                  becomes a nuclear boat (a longer teardrop hull, a tall sail set forward with wide fin planes on
//                  it); the carrier a supercarrier (a bigger angled deck, a white radar dome on the island, jets on
//                  deck, launch cells inside the bow corners and domes on the quarters)
//   Naval Mines    a yellow and black row of mines on a dark rail along each side aft (one row along the submarine's
//                  casing), a mine chute at the stern; the destroyer lands its aft tubes and gun for them
import { M_MASTERY, M_SPECIAL } from '../shared/keys';
import type { MatId, Part } from './bake';
import { CL } from './carrierDeck';
import type { UnitModel } from './models';
import { box, ell, poly, seg, sym } from './shapes';

type Gun = readonly [number, number, number];

function ship(parts: Part[], guns: readonly Gun[]): UnitModel {
  return { model: { parts, ground: 0.22 }, guns, props: [], nozzles: [], alt: 0, dust: [] };
}

/** Parts scaled by ku along the hull and kv across it (heights kept). */
function scaled(parts: Part[], ku: number, kv: number): Part[] {
  const sc = (q: readonly number[] | undefined, k: Part['k'] | 'clip'): number[] | undefined => {
    if (!q) return undefined;
    if (k === 'poly') return q.map((x, i) => x * (i % 2 ? kv : ku));
    if (k === 'box') return [q[0] * ku, q[1] * kv, q[2] * ku, q[3] * kv];
    if (k === 'seg') return [q[0] * ku, q[1] * kv, q[2] * ku, q[3] * kv, q[4]];
    return [q[0] * ku, q[1] * kv, q[2] * ku, q[3] * kv];
  };
  return parts.map((p) => ({ ...p, p: sc(p.p, p.k)!, sc: p.sc ? ([p.sc[0] * ku, p.sc[1] * kv, p.sc[2] * ku, p.sc[3] * kv] as const) : undefined, clip: sc(p.clip, 'clip'), clipPoly: sc(p.clipPoly, 'poly') }));
}
/** Parts moved by (du, dv). */
function moved(parts: Part[], du: number, dv: number): Part[] {
  const mv = (q: readonly number[] | undefined, k: Part['k'] | 'clip'): number[] | undefined => {
    if (!q) return undefined;
    if (k === 'poly') return q.map((x, i) => (i % 2 ? x + dv : x + du));
    if (k === 'box') return [q[0] + du, q[1] + dv, q[2] + du, q[3] + dv];
    if (k === 'seg') return [q[0] + du, q[1] + dv, q[2] + du, q[3] + dv, q[4]];
    return [q[0] + du, q[1] + dv, ...q.slice(2)];
  };
  return parts.map((p) => ({ ...p, p: mv(p.p, p.k)!, sc: p.sc ? ([p.sc[0] + du, p.sc[1] + dv, p.sc[2], p.sc[3]] as const) : undefined, clip: mv(p.clip, 'clip'), clipPoly: mv(p.clipPoly, 'poly') }));
}

// ------------------------------------------------------------------------------------------------- hull and fittings
//
// Read at game scale: at mid zoom one model unit is one screen pixel, so a ship is a few dozen pixels long and every
// detail has to be a few pixels big and stand off its neighbour by value. So the warships follow one value plan:
//   - the hull's sides dark, the deck clearly lighter (or warmer), and a light edge round the deck so the hull's shape
//     reads against the sea;
//   - few, big fittings with deck showing between them: guns dark on a light deck (or light on the battleship's dark
//     one), each turret's guns one bar two px thick, the superstructure light with a dark shadow side, the owner's
//     colour on the funnel tops;
//   - upgrades in bold colours: white radar domes at least three px across, launch cells as a dark grid on a pale
//     patch, mines as a yellow and black row on a dark rail.

/**
 * A hull outline: a fine clipper bow at +L flaring to the full beam over `bow` units, straight sides, and a rounded
 * cruiser stern (or a square transom).
 */
function hullShape(L: number, b: number, bow: number, transom = false, s = 3): number[] {
  const pts = [L, 0, L - bow * 0.22, -b * 0.34, L - bow * 0.5, -b * 0.72, L - bow * 0.8, -b * 0.94, L - bow, -b];
  if (transom) pts.push(-L + 1.4, -b, -L + 0.4, -b * 0.92, -L, -b * 0.8);
  else pts.push(-L + s, -b, -L + s * 0.5, -b * 0.86, -L + s * 0.15, -b * 0.58, -L, -b * 0.2);
  return sym(pts);
}

interface BaseLook {
  /** the deck's material and tone */
  deck: MatId;
  deckTone?: number;
  /** the hull sides' tone (hull material) */
  side?: number;
  /** the light edge round the deck: material and tone */
  edge?: MatId;
  edgeTone?: number;
  transom?: boolean;
}

/**
 * Hull (dark sides, the darkest strake at the waterline), the deck (planked if teak) and a light edge round it: the
 * top of the bulwark catching the light, so the hull's outline reads at one pixel per unit.
 */
function shipBase(L: number, b: number, bow: number, H: number, o: BaseLook): Part[] {
  const inner = hullShape(L - 0.4, b - 0.35, bow - 0.3, o.transom);
  return [
    poly(hullShape(L, b, bow, o.transom), 0, H, 'hull', { tone: o.side ?? 0 }),
    poly(hullShape(L + 0.05, b + 0.05, bow, o.transom), 0, 0.55, 'hullDark', { tone: -1 }),
    poly(inner, H, 0, o.deck, { pat: o.deck === 'teak' ? 'planks' : undefined, tone: o.deckTone ?? 0 }),
    poly(hullShape(L, b, bow, o.transom), H, 0.3, o.edge ?? 'sup', { edge: true, tone: o.edgeTone ?? -1 }),
  ];
}

/** A gun house and its guns: where it stands, which way it points and how big it is. */
interface Tur {
  u: number;
  z: number;
  /** 1 forward, -1 aft */
  dir: 1 | -1;
  len: number;
  wid: number;
  h: number;
  /** barrels side by side (drawn as one bar) */
  n: number;
  barrel: number;
  /** one barrel's width */
  bw: number;
  m: MatId;
  tone: number;
  bm: MatId;
  /** a dark ring round its foot, so a pale house on a dark deck keeps its outline */
  ring?: boolean;
}

/** The gap between two barrels of a bar. */
const SEAM = 0.45;
/** How wide a turret's barrels lie side by side: one bar at least two px thick. */
const barW = (t: Tur): number => t.n * t.bw + (t.n - 1) * SEAM;

/**
 * A gun turret: the gun house (flat roof, sloped face, rounded back) in `m` at `tone`, and its guns as one thick bar
 * (dark on a light deck, light on a dark one): at mid zoom a solid bar two px thick that reads as the guns, and from
 * two art px per unit the dark seams between the barrels show each gun.
 */
function turret(t: Tur): Part[] {
  const { u, z, dir: f, len, wid, h, n } = t;
  const house = sym([u + f * len * 0.62, -wid * 0.6, u + f * len * 0.34, -wid, u - f * len * 0.7, -wid, u - f * len, -wid * 0.55]);
  const out: Part[] = [];
  if (t.ring) out.push(ell(u - f * len * 0.1, 0, len * 0.95 + 0.45, wid + 0.5, z, 0, 'black'));
  out.push(poly(house, z, h, t.m, { tone: t.tone }));
  const u0 = u + f * len * 0.4;
  const u1 = u0 + f * t.barrel;
  const zb = z + h * 0.3;
  const hb = h * 0.45;
  out.push(seg(u0, 0, u1, 0, barW(t), zb, hb, t.bm, { tone: t.bm === 'gun' ? 0 : 1 }));
  // the seams between the barrels, and the muzzles, only where the resolution has room
  for (let i = 1; i < n; i++) {
    const v = -barW(t) / 2 + i * (t.bw + SEAM) - SEAM / 2;
    out.push(seg(u0 + f * 0.6, v, u1, v, SEAM, zb + hb, 0, t.bm === 'black' ? 'gun' : 'black', { minRes: 1.75 }));
  }
  return out;
}
/** Where a turret's guns end (u, v, z), for the muzzle flashes: the middle of the bar. */
function muzzle(t: Tur): [number, number, number] {
  return [t.u + t.dir * (t.len * 0.4 + t.barrel), 0, t.z + t.h * 0.6];
}

/** A small gun mount (a submarine's deck gun, a carrier's gun tubs): a round shield and one barrel. */
function smallGun(u: number, v: number, z: number, dir: number, r = 0.85, barrel = 2.2, m: MatId = 'hull', tone = 0): Part[] {
  const c = Math.cos(dir);
  const s = Math.sin(dir);
  return [ell(u, v, r, r * 0.9, z, 0.8, m, { sh: 'dome', tone }), seg(u, v, u + c * barrel, v + s * barrel, 0.6, z + 0.45, 0.3, m, { tone: tone - 1 })];
}

/**
 * A funnel: a light stack (a tone lighter in superstructure grey) raked aft by `rake`, its top in the owner's colour (lit from above, so it shows at every
 * zoom, not just on the dark side of the stack) round the dark smoke opening.
 */
function funnel(u: number, ru: number, rv: number, z: number, h: number, rake: number, band = true, m: MatId = 'sup'): Part[] {
  const h1 = h * 0.55;
  const r1 = rake * 0.55;
  const tone = m === 'sup' ? 1 : 0;
  return [
    ell(u, 0, ru, rv, z, h1, m, { sh: 'cyl', tone }),
    ell(u - r1, 0, ru * 0.98, rv * 0.98, z + h1, h - h1, m, { sh: 'cyl', tone }),
    ell(u - rake, 0, ru * 0.98, rv * 0.98, z + h, 0, band ? 'own' : 'gun', band ? {} : { edge: true, tone: 1 }),
    ell(u - rake, 0, ru * 0.42, rv * 0.4, z + h, 0, 'black'),
  ];
}

/** A pole mast with a yard across. */
function mast(u: number, z: number, h: number, yard: number): Part[] {
  return [ell(u, 0, 0.32, 0.32, z, h, 'gun'), seg(u, -yard, u, yard, 0.35, z + h * 0.72, 0.2, 'gun')];
}

/**
 * The modern refit's radar (Naval Mastery): a dark platform and stout dark lattice tower, a big white radar dome on
 * top (`dome` its radius: 1.5 and more is three px across at mid zoom), so the white always has dark round it.
 */
function radarMast(u: number, z: number, h: number, w = 1.6, dome = 1.5): Part[] {
  return [
    ell(u, 0, dome + 0.5, dome + 0.4, z, 0.3, 'gun'),
    poly(sym([u + w * 0.5, -w * 0.5, u - w * 0.5, -w * 0.5]), z + 0.3, h * 0.6 - 0.3, 'gun', { tone: 1, pat: 'grille' }),
    poly(sym([u + w * 0.3, -w * 0.3, u - w * 0.3, -w * 0.3]), z + h * 0.6, h * 0.4, 'gun', { tone: 1 }),
    ell(u, 0, dome, dome, z + h, dome * 1.1, 'white', { sh: 'dome', tone: 1 }),
  ];
}

/** A white radar dome on a short dark post (Naval Mastery). */
function radome(u: number, v: number, z: number, r: number): Part[] {
  return [ell(u, v, r + 0.35, r + 0.35, z, 0.5, 'gun'), ell(u, v, r, r, z + 0.5, r * 1.1, 'white', { sh: 'dome', tone: 1 })];
}

/**
 * Vertical launch cells (Naval Mastery): a pale steel patch with a dark border on the deck and a few big dark hatches
 * on it, `nu` x `nv` of them `p` apart, each half that square with a pale gap as wide between, so at mid zoom the patch
 * reads as a dark-on-pale grid, not a pale block with a stray dark pixel.
 */
function vls(u: number, v: number, nu: number, nv: number, z: number, p = 2.5): Part[] {
  const c = p / 2;
  const hu = (nu * p) / 2 + 0.15;
  const hv = (nv * p) / 2 + 0.15;
  const out: Part[] = [box(u - hu - 0.5, v - hv - 0.5, u + hu + 0.5, v + hv + 0.5, z, 0.25, 'black'), box(u - hu, v - hv, u + hu, v + hv, z + 0.25, 0.25, 'white', { tone: -1 })];
  for (let i = 0; i < nu; i++)
    for (let j = 0; j < nv; j++) {
      const a = u - (nu * p) / 2 + i * p + (p - c) / 2;
      const b = v - (nv * p) / 2 + j * p + (p - c) / 2;
      out.push(box(a, b, a + c, b + c, z + 0.5, 0, 'black', { tone: 1 }));
    }
  return out;
}

/** An armoured box launcher (Naval Mastery): one solid pale box on a dark footing, dark lid seams across it close up. */
function boxLauncher(u0: number, v0: number, u1: number, v1: number, z: number, h = 1.2): Part[] {
  const out: Part[] = [box(u0 - 0.3, v0 - 0.3, u1 + 0.3, v1 + 0.3, z, 0.2, 'black'), box(u0, v0, u1, v1, z + 0.2, h, 'white', { tone: -1 })];
  const long = u1 - u0 >= v1 - v0;
  if (long) for (let u = u0 + 1.5; u < u1 - 0.7; u += 1.9) out.push(box(u, v0 + 0.3, u + 0.7, v1 - 0.3, z + 0.2 + h, 0, 'black', { tone: 1, minRes: 1.5 }));
  else for (let v = v0 + 1.5; v < v1 - 0.7; v += 1.9) out.push(box(u0 + 0.3, v, u1 - 0.3, v + 0.7, z + 0.2 + h, 0, 'black', { tone: 1, minRes: 1.5 }));
  return out;
}

/** A lifeboat on its davits along the side. */
function boat(u: number, v: number, z: number, len = 1.6): Part[] {
  return [ell(u, v, len, 0.55, z, 0.55, 'white', { sh: 'cyl' }), ell(u, v, len * 0.75, 0.32, z + 0.55, 0, 'canvas')];
}

/**
 * Mine rails (Naval Mines): a dark rail along each side from `u0` forward, with `n` yellow mines `gap` apart
 * at `v` either side of the centreline (one rail on it for `v` 0), so each side reads as a yellow and black row; close
 * up each mine shows its black cap. `chute` is the stern's u for the dark mine chute (null for none).
 */
function mineRails(u0: number, n: number, gap: number, v: number, z: number, r: number, chute: number | null): Part[] {
  const out: Part[] = [];
  for (const s of v === 0 ? [0] : [-1, 1]) {
    out.push(seg(u0 - r - 0.4, s * v, u0 + (n - 1) * gap + r + 0.4, s * v, r * 2 + 0.7, z, 0.1, 'black'));
    for (let i = 0; i < n; i++) {
      const u = u0 + i * gap;
      out.push(ell(u, s * v, r, r, z + 0.1, r * 0.8, 'hazard', { tone: 1 }));
      out.push(ell(u, s * v, r * 0.42, r * 0.42, z + 0.1 + r * 0.8, 0, 'black', { minRes: Math.max(1.75, 2 / r) }));
    }
  }
  if (chute !== null) out.push(box(chute, -v + r, chute + 1.4, v - r, z, 0.1, 'black'));
  return out;
}

/**
 * A deckhouse block with a lit roof: the box in `m` (so its sides keep the dark shadow tones) and its roof a decal a
 * tone or two lighter, so the superstructure stands off the deck by value from above.
 */
function house(u0: number, v0: number, u1: number, v1: number, z: number, h: number, m: MatId = 'sup', roof: MatId = 'sup', roofTone = 1): Part[] {
  return [box(u0, v0, u1, v1, z, h, m), box(u0, v0, u1, v1, z + h, 0, roof, { tone: roofTone })];
}

// ------------------------------------------------------------------------------------------------- warships

export function warship(mods: number): UnitModel {
  // the cruiser: 34 long, a warm teak deck (its signature: every other warship has a grey deck) with a light edge,
  // three dark twin turrets (A forward, B raised behind it, X aft) whose barrels lie as thick black bars on the teak,
  // a light bridge with dark sides, two upright light funnels with tops in the owner's colour, and teak showing
  // between every one of them, so the centreline breaks into separate parts at every heading
  const modern = !!(mods & M_MASTERY);
  const L = 17.3;
  const H = 2.2;
  const T = (u: number, z: number, dir: 1 | -1, barrel: number): Tur => ({ u, z, dir, len: 2.5, wid: 1.7, h: 1.2, n: 2, barrel, bw: 0.8, m: 'gun', tone: 1, bm: 'black' });
  const A = T(11.6, H, 1, 2.6);
  const X = T(-12, H, -1, 2.6);
  const out: Part[] = [...shipBase(L, 3.5, 6.5, H, { deck: 'teak', side: 0, edge: 'teak', edgeTone: 0 })];
  out.push(...turret(A));
  if (modern) {
    // B turret's place: a block of launch cells
    out.push(...vls(5.4, 0, 2, 1, H, 2.3));
  } else out.push(ell(5.4, 0, 2, 1.8, H, 0.9, 'gun'), ...turret(T(5.6, H + 0.9, 1, 1.6)));
  // the bridge: a light deckhouse and tower, their roofs lit, the windows facing forward
  out.push(...house(-0.6, -2.1, 1.6, 2.1, H, 1.6, 'sup', 'white', 0), ...house(-0.3, -1.3, 1.2, 1.3, H + 1.6, 1.4, 'sup', 'white', 0));
  out.push(box(0.95, -1.2, 1.2, 1.2, H + 3, 0, 'glass'));
  if (modern) out.push(...radarMast(0.3, H + 3, 2.2, 1.2, 1.6));
  else out.push(...mast(0.4, H + 3, 3.4, 1.8));
  // two upright funnels, their tops in the owner's colour
  out.push(...funnel(-2.8, 1.1, 1.15, H, 4.4, 0.25), ...funnel(-6, 1.1, 1.15, H, 4.2, 0.25));
  // the refit: a box launcher across the deck aft of the funnels
  if (modern) out.push(...boxLauncher(-9, -2, -7.9, 2, H, 1.1));
  // X turret aft, the owner's recognition stripe across its roof
  out.push(...turret(X), box(-11.9, -1.7 * 0.62, -10.8, 1.7 * 0.62, H + 1.2, 0, 'own'));
  if (mods & M_SPECIAL) out.push(...mineRails(-15.4, 4, 2.9, 2.55, H, 0.95, -L + 0.2));
  return ship(out, [muzzle(A), muzzle(X)]);
}

export function destroyer(mods: number): UnitModel {
  // the fast one: a 28 long needle, the lightest deck of all (flat, clear) over dark sides, a long sharp bow with a
  // bow wave, a dark single gun mount forward, the light bridge, two raked light funnels with owner-coloured tops, two
  // banks of torpedo tubes as thick black bars across the deck aft (the destroyer's own mark), one gun aft. Few, big
  // parts with light deck between them: at mid zoom the whole ship is only five px wide.
  const modern = !!(mods & M_MASTERY);
  const mines = !!(mods & M_SPECIAL);
  const L = 14;
  const H = 1.5;
  const M = (u: number, dir: 1 | -1, len: number, barrel: number): Tur => ({ u, z: H, dir, len, wid: 1.6, h: 0.9, n: 1, barrel, bw: 1.1, m: 'gun', tone: 1, bm: 'black' });
  const A = M(10, 1, 2.1, 1.8);
  const out: Part[] = [...shipBase(L, 2.6, 7, H, { deck: 'hull', deckTone: 1, side: -1, edge: 'sup', edgeTone: 0, transom: true })];
  // the bow wave curling off the stem
  out.push(seg(L + 0.2, -0.15, L - 2.4, -2.6, 0.6, 0, 0, 'foam', { a: 0.6 }), seg(L + 0.2, 0.15, L - 2.4, 2.6, 0.6, 0, 0, 'foam', { a: 0.6 }));
  out.push(...turret(A));
  // the refit: launch cells on the clear deck between the gun and the bridge
  if (modern) out.push(...vls(5.1, 0, 2, 1, H, 2));
  // the bridge: light, its roof lit, its sides dark, windows forward
  out.push(...house(0.4, -1.9, 2.6, 1.9, H, 1.3, 'sup', 'white', 0), ...house(0.8, -1.3, 2.3, 1.3, H + 1.3, 0.9, 'sup', 'white', 0));
  out.push(box(2.05, -1.2, 2.3, 1.2, H + 2.2, 0, 'glass'));
  if (modern) out.push(...radarMast(1.3, H + 2.2, 2.2, 1.2, 1.55));
  else out.push(...mast(1.4, H + 2.2, 3.4, 1.4));
  // two raked funnels, their tops in the owner's colour
  out.push(...funnel(-1, 1.1, 1.15, H, 3.4, 0.6), ...funnel(-3.4, 1.1, 1.15, H, 3.2, 0.6));
  // torpedo tube banks: three tubes side by side on a turntable, trained across the deck, read as one thick black bar
  // across most of the beam (the seams between the tubes from two art px per unit). A minelayer lands the aft bank.
  for (const [u, a] of mines ? ([[-5.8, 1.4]] as const) : ([[-5.8, 1.4], [-8.9, -1.4]] as const)) {
    const c = Math.cos(a);
    const s = Math.sin(a);
    const half = 2.05;
    out.push(ell(u, 0, 1.05, 1.05, H, 0.2, 'gun'));
    out.push(seg(u - c * half, -s * half, u + c * half, s * half, 1.75, H + 0.2, 0.55, 'black', { tone: 1 }));
    for (const o of [-0.3, 0.3]) out.push(seg(u - c * half - s * o, -s * half + c * o, u + c * half - s * o, s * half + c * o, 0.3, H + 0.75, 0, 'gun', { minRes: 1.75 }));
  }
  if (modern && !mines) out.push(...boxLauncher(-12.9, -1.4, -11.2, 1.4, H, 0.9));
  else if (!modern && !mines) out.push(...turret(M(-12.4, -1, 1.7, 0.7)));
  // the minelayer: rails over the quarterdeck where the aft gun and tubes stood
  if (mines) out.push(...mineRails(-12.9, 3, 2.6, 1.55, H, 0.9, null));
  const g = muzzle(A);
  return ship(out, [g, g]);
}

export function battleship(mods: number): UnitModel {
  // the heavy hitter: 52 long on a 13 wide beam, a dark steel deck with a light edge, four big pale turrets ringed dark
  // (A and raised B forward, raised X and Y aft) with dark deck between them, their guns as thick light bars over
  // the deck, a stepped tower with light roofs and dark sides, one big funnel with an owner-coloured top
  const modern = !!(mods & M_MASTERY);
  const L = 25;
  const H = 3;
  const B = 6.5;
  const T = (u: number, z: number, dir: 1 | -1, barrel: number): Tur => ({ u, z, dir, len: 3.3, wid: 3.3, h: 2.2, n: 2, barrel, bw: 1.15, m: 'sup', tone: 0, bm: 'sup', ring: true });
  const A = T(14.2, H, 1, 4.4);
  const Bt = T(7, H + 1.4, 1, 2);
  const Xt = T(-12.6, H + 1.4, -1, 1.7);
  const Y = T(-19.5, H, -1, 2.9);
  const out: Part[] = [...shipBase(L, B, 11, H, { deck: 'bbdeck', deckTone: 1, side: -1, edge: 'sup', edgeTone: -1, transom: true })];
  out.push(...turret(A));
  // B raised behind A on its dark barbette, the owner's recognition stripe across its roof
  out.push(ell(6.7, 0, 3.9, 3.9, H, 1.4, 'black'), ...turret(Bt), box(4.1, -3.3 * 0.62, 5.3, 3.3 * 0.62, H + 1.4 + 2.2, 0, 'own'));
  // the tower: a broad armoured base and two stepped decks, all with lit roofs and dark sides, the bridge windows and
  // the fire control top (a dark platform for the radar on the refit)
  out.push(...house(-4.2, -3.7, 2.4, 3.7, H, 1.8, 'sup', 'white', 0));
  out.push(...house(-3.4, -2.6, 1.4, 2.6, H + 1.8, 1.6, 'sup', 'white', 0));
  out.push(box(1.1, -2.4, 1.4, 2.4, H + 3.4, 0, 'glass'));
  out.push(...house(-2.4, -1.5, 0.4, 1.5, H + 3.4, 1.2, 'sup', 'white', 0));
  if (modern) out.push(...radarMast(-1, H + 4.6, 1.6, 1.4, 1.8));
  else out.push(...mast(-1.4, H + 4.6, 3, 2.6));
  out.push(...funnel(-6.5, 2.2, 2, H + 1, 3.6, 0.5));
  if (modern) {
    // armoured box launchers on both sides amidships and close-in gun domes by the tower
    for (const s of [-1, 1]) out.push(...boxLauncher(-6, s > 0 ? 4.1 : -5.8, -1, s > 0 ? 5.8 : -4.1, H, 1.1), ...radome(3, s * 4.7, H, 1.2));
  }
  // aft: X raised over Y (the refit swaps X for a big block of vertical launch cells)
  if (modern) out.push(...vls(-12.6, 0, 2, 2, H));
  else out.push(ell(-12.3, 0, 3.9, 3.9, H, 1.4, 'black'), ...turret(Xt));
  out.push(...turret(Y));
  if (mods & M_SPECIAL) out.push(...mineRails(-23.2, 5, 3.2, 5.2, H, 1, -L + 0.2));
  return ship(out, [muzzle(A), muzzle(Bt), muzzle(Y)]);
}

/** A nuclear boat's teardrop hull outline (port half mirrored): a round bow, a long body, a long taper to a blunt tail. */
function teardrop(bow: number, stern: number, r: number): number[] {
  const pts: number[] = [];
  const Lb = 4.2;
  for (let i = 0; i <= 6; i++) {
    const a = (i / 6) * (Math.PI / 2);
    pts.push(bow - Lb + Math.cos(a) * Lb, -Math.sin(a) * r);
  }
  pts.push(stern + 10, -r, stern + 5, -r * 0.7, stern + 1.4, -r * 0.4, stern, -r * 0.25);
  return sym(pts);
}

export function submarine(mods: number): UnitModel {
  // a dark cigar half under water, outlined by the white water where it breaks the surface: a soft bow wave at the
  // stem, a swirl at the stern, a lighter casing along the top, a deck gun forward and the big raised sail (conning
  // tower) in the middle, a step lighter than the hull with a dark shadow side, its top the owner panel. The hull runs
  // whole from bow to tail. With Naval Mastery it is a nuclear boat: a longer smooth teardrop hull and a tall sail set
  // forward with wide fin planes on it, a rudder fin and short planes on the tail.
  const nuke = !!(mods & M_MASTERY);
  const out: Part[] = [];
  if (nuke) {
    out.push(
      poly(teardrop(13.9, -13.6, 2.8), 0, 0, 'foam', { a: 0.7 }),
      seg(13.6, -0.4, 11.4, -2.4, 0.5, 0, 0, 'foam', { a: 0.55 }),
      seg(13.6, 0.4, 11.4, 2.4, 0.5, 0, 0, 'foam', { a: 0.55 }),
      ell(-14, 0, 1.6, 1, 0, 0, 'foam', { a: 0.5 }),
      poly(teardrop(13, -13, 2.1), 0, 0.65, 'sub', { sh: 'cyl', sc: [0, 0, 13, 2.1] }),
      // the casing's lit top
      seg(-10, 0, 11.4, 0, 1, 0.65, 0.05, 'hullDark', { tone: -1 }),
      // the tail: short planes across and the rudder fin standing up, joined to the hull
      seg(-10.8, -1.25, -10.8, 1.25, 1, 0.35, 0.25, 'hullDark'),
      box(-12.8, -0.3, -10.2, 0.3, 0.6, 1.4, 'hullDark'),
      // the tall sail set forward, wide fin planes out to both sides, the owner panel on top, masts
      poly(sym([9.6, 0, 8.9, -1.05, 4.6, -1.05, 3.9, 0]), 0.6, 3.6, 'hull'),
      seg(7.4, -3.2, 7.4, 3.2, 1, 2.8, 0.25, 'hull'),
      box(4.8, -0.6, 6.6, 0.6, 4.2, 0, 'own'),
      ell(6.2, 0, 0.3, 0.3, 4.2, 1.4, 'gun'),
    );
  } else {
    out.push(
      // the white water round the hull where it breaks the surface, a soft bow wave and a swirl at the stern
      ell(0.2, 0, 12.6, 2.5, 0, 0, 'foam', { a: 0.7 }),
      seg(12.4, -0.3, 10.4, -2.3, 0.5, 0, 0, 'foam', { a: 0.55 }),
      seg(12.4, 0.3, 10.4, 2.3, 0.5, 0, 0, 'foam', { a: 0.55 }),
      ell(-12.6, 0, 1.5, 0.9, 0, 0, 'foam', { a: 0.5 }),
      ell(0, 0, 12, 2, 0, 0.6, 'sub', { sh: 'cyl' }),
      // the flat deck casing along the top, lighter
      seg(-9.5, 0, 9.5, 0, 1.2, 0.6, 0.1, 'hullDark', { tone: -1 }),
      // stern planes: short and stout, joined to the hull
      seg(-10.2, -1.6, -10.2, 1.6, 0.9, 0.3, 0.2, 'hullDark'),
      ...smallGun(5.6, 0, 0.7, 0, 0.95, 2.6, 'hull', 0),
      // the sail: a big streamlined fin a step lighter, the bridge on top in the owner colour, a periscope
      poly(sym([3.8, 0, 3, -1.4, -2, -1.4, -2.6, -0.55]), 0.6, 2.8, 'hull'),
      box(-2, -0.75, -0.2, 0.75, 3.4, 0, 'own'),
      ell(0.8, 0, 0.3, 0.3, 3.4, 1.5, 'gun'),
    );
  }
  // a mine-laying boat: a row of mines on a dark rail along the aft casing
  if (mods & M_SPECIAL) out.push(...mineRails(-10.8, 4, 2.7, 0, 0.65, 0.95, null));
  // torpedoes leave from the bow
  const bow: Gun = [nuke ? 12.6 : 11.2, 0, 0.3];
  return ship(out, [bow, bow]);
}

/**
 * A plane parked on a flight deck at (u, v), its nose turned `ang` radians from the bow (toward starboard): a simple
 * pale cross big enough to read from above, a thick fuselage, straight wings and a tailplane (`jet`: a swept delta
 * with no prop). Pale on the dark deck.
 */
function parked(u: number, v: number, z: number, ang: number, jet = false): Part[] {
  const c = Math.cos(ang);
  const s = Math.sin(ang);
  const P = (a: number, b: number): [number, number] => [u + a * c - b * s, v + a * s + b * c];
  if (jet)
    return [
      seg(...P(2.8, 0), ...P(-2.6, 0), 1.2, z, 0.55, 'alu', { tone: 0 }),
      poly([...P(1.2, -0.5), ...P(-1.6, -2.4), ...P(-2.4, -2.4), ...P(-2.4, 2.4), ...P(-1.6, 2.4), ...P(1.2, 0.5)], z + 0.2, 0.3, 'alu', { tone: 0 }),
    ];
  return [
    seg(...P(2.4, 0), ...P(-2.4, 0), 1.2, z, 0.55, 'seagrey', { tone: 2 }),
    poly([...P(1.2, -2.5), ...P(1.2, 2.5), ...P(-0.2, 2.5), ...P(-0.2, -2.5)], z + 0.2, 0.3, 'seagrey', { tone: 2 }),
    seg(...P(-1.9, -1.2), ...P(-1.9, 1.2), 0.8, z + 0.2, 0.3, 'seagrey', { tone: 2 }),
  ];
}

/** The carrier is laid out on a 54 long frame and drawn this much longer and wider (60 long, its deck 14.2 wide). */
const CU = CL / 27;
const CV = 1.1;

export function carrier(mods: number): UnitModel {
  // the biggest: 60 long on a broad flight deck (about four times as long as wide) in dark weathered steel over dark
  // hull sides, its edge lit on the sides toward the light and dark on the far ones, the angled landing deck reaching
  // out over a sponson to port with its white edge line, the tall light island on the starboard side (its funnel top
  // the owner colour), three pale planes parked clear of the landing area. The deck's plates, tyre marks and sparse
  // worn markings are its pattern (carrierDeck.ts). Laid out at 54 long (L 27) and stretched to the real size at the
  // end. With Naval Mastery it is a supercarrier: the angled deck's sponson reaches further out, the island carries a
  // big white radar dome, jets sit on deck in place of the propeller planes, launch cells stand at the bow corners.
  const modern = !!(mods & M_MASTERY);
  const L = 27;
  const H = 2.4;
  const out: Part[] = [poly(hullShape(L - 1, 4.4, 10, true), 0, H, 'hull', { tone: -1 }), poly(hullShape(L - 0.95, 4.45, 10, true), 0, 0.55, 'hullDark', { tone: -1 })];
  // sponsons just under the deck edge, so the edge reads as a ship's, not a straight kerb
  for (const [u0, v0, u1, v1] of [
    [14, 4.9, 17.6, 5.9],
    [-20.4, 4.8, -16.8, 5.8],
    [15.4, -6.1, 19, -5],
    [-20.6, -6.2, -16.4, -5],
  ] as const)
    out.push(box(u0, v0, u1, v1, H - 0.1, 0.55, 'hull', { tone: -1 }));
  const deck = modern
    ? [L, -1.5, L - 1.5, -3.6, L - 4.4, -4.9, 15.4, -5.4, 12.2, -6.4, 8.4, -8.4, 3.4, -8.8, -6, -7.2, -L + 1, -4.8, -L, -3.9, -L, 3.9, -L + 1, 5, L - 6.5, 5.2, L - 3.4, 4.5, L - 1.3, 3.2, L, 1.5]
    : [L, -1.5, L - 1.5, -3.6, L - 4.4, -4.9, 13.4, -5.4, 10.2, -6.1, 7.2, -7.5, 4.2, -7.7, -L + 1, -4.8, -L, -3.9, -L, 3.9, -L + 1, 5, L - 6.5, 5.2, L - 3.4, 4.5, L - 1.3, 3.2, L, 1.5];
  if (modern) out.push(box(-6, -7.6, 4, -4, H - 0.1, 0.55, 'hull', { tone: -1 }));
  out.push(poly(deck, H, 0.8, 'flightdeck', { pat: 'flightDeck', alt: 'paint' }));
  const D = H + 0.8;
  // the deck edge: light on the sides that face the light (top left on screen), dark on the far sides
  out.push(poly(deck, D, 0.2, 'sup', { edge: true, sh: 'plate', tone: -1 }));
  // the island on the starboard side: one tall light block (so its lit roof and shadow side read at mid zoom), the
  // bridge on it with its windows, a big raked funnel with an owner-coloured top, the mast
  out.push(...house(-8.4, 3.4, 3.2, 6.7, D, 3.8, 'sup', 'sup', 1), box(2.85, 3.45, 3.2, 6.65, D + 3.8, 0, 'glass'));
  out.push(...house(-0.4, 3.9, 2.6, 6.2, D + 3.8, 1.2, 'sup', 'white', 0), box(2.25, 3.95, 2.6, 6.15, D + 5, 0, 'glass'));
  out.push(...moved(funnel(-4.2, 1.7, 1.1, D + 3.8, 2.4, 0.9), 0, 5.05));
  if (modern) out.push(...moved(radarMast(1, D + 5, 1.6, 1.3, 1.5), 0, 5.05));
  else out.push(...moved(mast(1, D + 5, 3, 1.3), 0, 5.05));
  // three planes: one on the bow catapult, one parked on the starboard bow, one aft of the island
  out.push(...parked(L - 4.8, -1.3, D, 0, modern), ...parked(10.6, 2.2, D, -0.5, modern), ...parked(-16.6, 2.9, D, -0.5, modern));
  if (modern) {
    // the supercarrier's launch cells inside the bow corners, white radar domes on the quarters
    out.push(...vls(16.4, -3.5, 2, 1, D), ...vls(16.4, 3.1, 2, 1, D));
    out.push(...radome(L - 5.6, 5.6, H + 0.2, 1.1), ...radome(-L + 3, -5.3, H + 0.2, 1.1));
  } else
    for (const [u, v] of [
      [L - 5.4, -5.4],
      [L - 6.4, 5.5],
      [-L + 3, -5.1],
      [-L + 3, 5.4],
    ] as const)
      out.push(...smallGun(u, v, H + 0.2, v < 0 ? -1.4 : 1.4, 0.8, 1.8, 'hull', 0));
  // mine rails on catwalks outboard of the deck along both quarters
  if (mods & M_SPECIAL) {
    out.push(box(-25.6, -7.6, -11.8, -5.2, H - 0.4, 0.4, 'hull', { tone: -1 }), box(-25.6, 5.2, -11.8, 7.6, H - 0.4, 0.4, 'hull', { tone: -1 }));
    out.push(...mineRails(-24.2, 5, 2.9, 6.4, H, 1.05, null));
  }
  return ship(scaled(out, CU, CV), [
    [(L - 5.4) * CU, -5.4 * CV, H + 1],
    [(L - 6.4) * CU, 5.5 * CV, H + 1],
  ]);
}

// ------------------------------------------------------------------------------------------------- other ships

export function transport(): UnitModel {
  // a boxy landing ship: blunt bow doors, an open well deck packed with helmeted troops and two vehicles, side
  // bulwarks, the bridge aft with the owner panel on its roof, landing craft on davits
  const L = 13;
  const H = 2.2;
  const hullP = sym([L, -1.6, L - 0.9, -3.6, L - 2.2, -4, -L + 0.8, -4, -L, -3.4]);
  const out: Part[] = [poly(hullP, 0, H, 'hull'), poly(sym([L + 0.05, -1.65, L - 0.85, -3.65, L - 2.2, -4.05, -L + 0.8, -4.05, -L - 0.05, -3.45]), 0, 0.55, 'hullDark')];
  out.push(poly(sym([L - 0.4, -1.4, L - 1.1, -3.2, L - 2.3, -3.5, -L + 1, -3.5, -L + 0.4, -3]), H, 0, 'deck', { inset: true }));
  // bow doors: two leaves with their seam
  out.push(poly(sym([L - 0.2, -1.5, L - 1, -3.3, L - 2.6, -3.5, L - 2.6, 0]), H, 0.25, 'hull', { tone: 1 }), seg(L - 2.6, 0, L - 0.2, 0, 0.3, H + 0.25, 0, 'gun'));
  // the well deck with troops and two trucks at its back
  out.push(box(-4.6, -3, 9.6, 3, H, 0, 'deck', { inset: true, pat: 'helmets', alt: 'helmet', tone: 1 }));
  out.push(box(-4.4, -2.6, -1.6, -0.5, H, 1.1, 'olive'), box(-2.4, -2.5, -1.6, -0.6, H + 1.1, 0, 'glass'), box(-4.4, 0.5, -1.6, 2.6, H, 1.1, 'olive', { pat: 'grille' }), box(-4.3, 0.6, -2.7, 2.5, H + 1.1, 0, 'canvas'));
  // bulwarks round the well
  out.push(box(-4.8, -3.5, 10, -3, H, 0.7, 'hull'), box(-4.8, 3, 10, 3.5, H, 0.7, 'hull'));
  // the bridge aft: two decks, windows, the owner panel on its roof, a funnel, the mast, two landing craft
  out.push(box(-12.2, -3.2, -5.2, 3.2, H, 1.8, 'sup'), box(-10, -2.2, -6.2, 2.2, H + 1.8, 1.2, 'sup'), box(-6.6, -2, -6.2, 2, H + 3, 0, 'glass'));
  out.push(box(-9.2, -1.9, -8.2, 1.9, H + 3, 0, 'own'));
  out.push(...funnel(-11, 0.75, 0.9, H + 1.8, 1.6, 0.3, false), ...mast(-8.6, H + 3, 2.6, 1.2));
  for (const s of [-1, 1]) out.push(ell(-8.6, s * 3.8, 1.8, 0.75, H + 0.6, 0.6, 'olive', { sh: 'cyl' }), box(-9.8, s * 3.8 - 0.4, -7.6, s * 3.8 + 0.4, H + 1.2, 0, 'deck', { tone: -1 }));
  return ship(out, [[0, 0, H]]);
}

export function tradeShip(): UnitModel {
  // a merchant: a black hull with a red boot topping, a forecastle, deck containers in faded colours over the holds,
  // cargo cranes, the cream house aft with the funnel in the owner's colours, hatches aft
  const L = 16;
  const H = 2.6;
  const out: Part[] = [
    poly(hullShape(L + 0.1, 3.5, 5.5, true), 0, 0.7, 'redlead'),
    poly(hullShape(L, 3.4, 5.5, true), 0.7, H - 0.7, 'merchant'),
    poly(hullShape(L - 0.5, 3, 5.1, true), H, 0, 'deck', { inset: true }),
    poly(hullShape(L - 0.5, 3, 5.1, true), H, 0.3, 'white', { edge: true, tone: -1 }),
    // the forecastle
    poly(sym([L - 0.3, 0, L - 1.6, -2.2, L - 3.4, -2.9, L - 4.2, -2.9, L - 4.2, 0]), H, 0.6, 'merchant'),
    ...mast(L - 3.4, H + 0.6, 3.2, 1.4),
  ];
  // containers in two rows over the forward holds (stacks of one and two)
  const cols: MatId[] = ['rust', 'fadedBlue', 'ochre', 'brick', 'olive', 'fadedBlue', 'rust', 'ochre'];
  const stacks = [
    [8, 11.4],
    [4.2, 7.6],
    [-0.8, 2.6],
  ];
  stacks.forEach(([u0, u1], i) => {
    out.push(box(u0, -2.6, u1, -0.08, H, i === 1 ? 2.4 : 1.2, cols[i * 2], { pat: 'ribs' }));
    out.push(box(u0, 0.08, u1, 2.6, H, i === 0 ? 2.4 : 1.2, cols[i * 2 + 1], { pat: 'ribs' }));
  });
  // cargo cranes: a pedestal and a jib swung out over the containers
  out.push(ell(3.3, 0, 0.6, 0.6, H, 3, 'ochre', { sh: 'cyl' }), seg(3.3, 0, 7.6, -1.2, 0.5, H + 2.6, 0.4, 'ochre'));
  out.push(ell(-1.6, 0, 0.6, 0.6, H, 3, 'ochre', { sh: 'cyl' }), seg(-1.6, 0, 2.2, 1.4, 0.5, H + 2.6, 0.4, 'ochre'));
  // the house: three decks in cream, windows, boats, the funnel with the owner band
  out.push(box(-11, -2.9, -4.4, 2.9, H, 1.7, 'cream'), box(-9.4, -2.4, -4.8, 2.4, H + 1.7, 1.2, 'cream'), box(-5.2, -2.3, -4.8, 2.3, H + 2.9, 0, 'glass'));
  out.push(...boat(-8, -3.15, H + 1, 1.6), ...boat(-8, 3.15, H + 1, 1.6));
  out.push(...funnel(-9.8, 1.15, 1.25, H + 1.7, 2.6, 0.4, true, 'merchant'));
  // a hatch and a crane aft
  out.push(box(-15, -1.8, -11.6, 1.8, H, 0.5, 'canvas', { pat: 'hatches' }));
  return ship(out, [[0, 0, H]]);
}
