// The detailed style's ship models (client only, pure data), rasterized by bake.ts like every other unit model. Model
// units are screen px at mid zoom; the bow points at +u, the starboard side at +v. All art is original and lives here
// as code.
//
// Each ship reads by its silhouette first, then its colour:
//   carrier      the biggest (60 long): a broad dark flight deck, the angled landing deck to port, the island to
//                starboard, planes parked along the starboard edge
//   battleship   52 long and broad: a dark steel deck with four big pale triple turrets (two forward, two aft, the
//                inner ones superfiring) whose thick barrels lie far over the deck, a tall stepped tower, one big funnel
//   warship      (no arsenal pick) a 34 long cruiser with a warm teak deck, three twin turrets, two upright funnels
//   destroyer    a 27 long light grey needle, seven times as long as wide: a sharp flared bow, single gun mounts, two
//                thin raked funnels and two pale torpedo tube banks across the deck
//   submarine    a dark cigar outlined in white water, one raised sail in the middle and a deck gun
//   transport    a boxy landing ship: bow doors, an open well deck full of helmeted troops, the bridge aft
//   trade ship   a black merchant hull with a cream house aft, deck containers and cargo cranes, clearly no guns
// Upgrades change the ship you see:
//   Naval Mastery  the modern refit: a lattice mast with a radar array and a white radar dome, white close-in gun
//                  domes, missile launchers in place of some of the old guns (vertical launch cells, canister racks,
//                  armoured box launchers, a twin-arm launcher, a helicopter pad); the submarine becomes a nuclear boat
//                  (a longer teardrop hull, a tall sail set forward with fin planes on it); the carrier a supercarrier
//                  (a bigger angled deck, a radar dome and array on the island, jets on deck)
//   Naval Mines    mine rails along both sides aft: black mines with a yellow band, a mine chute at the stern
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

/** Hull, deck (inset, planked if teak) and the railing round it; `tone` lightens or darkens hull and deck together. */
function shipBase(L: number, b: number, bow: number, H: number, deck: MatId, transom = false, tone = 0): Part[] {
  const inner = hullShape(L - 0.55, b - 0.45, bow - 0.4, transom);
  return [
    poly(hullShape(L, b, bow, transom), 0, H, 'hull', { tone }),
    // a darker band along the waterline: the hull's lowest strake
    poly(hullShape(L + 0.05, b + 0.05, bow, transom), 0, 0.55, 'hullDark'),
    poly(inner, H, 0, deck, { inset: true, pat: deck === 'teak' ? 'planks' : undefined, tone }),
    // the railing only close up: at mid zoom it would outline the whole hull
    poly(inner, H, 0.32, 'sup', { edge: true, minRes: 1.5 }),
  ];
}

/**
 * A gun turret facing `dir` (1 forward, -1 aft): a dark barbette ring on the deck, the gun house (flat roof, sloped
 * face, rounded back) and `n` barrels. `roof` paints a stripe across the roof (the owner's recognition panel), `m`
 * is the gun house's material and `tone` its shade (a battleship's turrets are a step lighter than its deck).
 */
function turret(u: number, z: number, dir: 1 | -1, len: number, wid: number, h: number, n: number, barrel: number, bw: number, roof: MatId | null = null, m: MatId = 'hull', tone = 0): Part[] {
  const f = dir;
  const house = sym([u + f * len * 0.62, -wid * 0.6, u + f * len * 0.34, -wid, u - f * len * 0.7, -wid, u - f * len, -wid * 0.55]);
  const out: Part[] = [ell(u, 0, len * 0.9 + 0.3, wid + 0.3, z, 0, 'deck'), poly(house, z, h, m, { tone })];
  if (roof) out.push(box(Math.min(u - f * len * 0.5, u - f * len * 0.22), -wid * 0.72, Math.max(u - f * len * 0.5, u - f * len * 0.22), wid * 0.72, z + h, 0, roof));
  // a rangefinder hood across the back of the roof
  if (len > 2) out.push(box(u - f * len * 0.62 - 0.3, -wid - 0.5, u - f * len * 0.62 + 0.3, wid + 0.5, z + h * 0.5, h * 0.5, m, { tone: tone - 1 }));
  const gap = gunGap(n, wid, bw);
  for (let i = 0; i < n; i++) {
    const v = n === 1 ? 0 : -gap + (2 * gap * i) / (n - 1);
    const u0 = u + f * len * 0.5;
    out.push(seg(u0, v, u0 + f * barrel, v, bw, z + h * 0.35, h * 0.4, 'hull', { sh: 'cyl', tone: -0.4 }));
  }
  return out;
}
/** Half the spread of a turret's barrels: a clear gap between them, so a triple turret reads as three guns. */
function gunGap(n: number, wid: number, bw: number): number {
  if (n === 1) return 0;
  return n === 3 ? Math.min(wid * 0.68, bw * 1.95) : Math.min(wid * 0.6, 0.7 + bw * 0.5);
}
/** Where the barrels of a turret end (u, v, z), for the muzzle flashes. */
function muzzles(u: number, z: number, dir: 1 | -1, len: number, wid: number, h: number, n: number, barrel: number, bw: number): [number, number, number][] {
  const gap = gunGap(n, wid, bw);
  const out: [number, number, number][] = [];
  for (let i = 0; i < n; i++) out.push([u + dir * (len * 0.5 + barrel), n === 1 ? 0 : -gap + (2 * gap * i) / (n - 1), z + h * 0.6]);
  return out;
}

/** A small gun mount (secondary or deck gun): a round shield and one thin barrel (two for a twin mount). */
function smallGun(u: number, v: number, z: number, dir: number, r = 0.85, barrel = 2.2, twin = false): Part[] {
  const c = Math.cos(dir);
  const s = Math.sin(dir);
  const out: Part[] = [ell(u, v, r + 0.2, r + 0.2, z, 0, 'deck'), ell(u, v, r, r * 0.9, z, 0.8, 'hull', { sh: 'dome' })];
  for (const o of twin ? [-0.38, 0.38] : [0]) out.push(seg(u - s * o, v + c * o, u - s * o + c * barrel, v + c * o + s * barrel, twin ? 0.4 : 0.45, z + 0.45, 0.3, 'hull', { tone: -1 }));
  return out;
}

/** A funnel: lower part, the owner band, the upper part raked aft by `rake`, the dark smoke opening. */
function funnel(u: number, ru: number, rv: number, z: number, h: number, rake: number, band = true, m: MatId = 'sup'): Part[] {
  const h1 = Math.max(0.6, h - 1.5);
  const hb = 0.7;
  const r1 = rake * (h1 / h);
  const r2 = rake * ((h1 + hb) / h);
  return [
    ell(u, 0, ru, rv, z, h1, m, { sh: 'cyl' }),
    ell(u - r1, 0, ru, rv, z + h1, hb, band ? 'own' : m, { sh: 'cyl' }),
    ell(u - r2, 0, ru * 0.98, rv * 0.98, z + h1 + hb, h - h1 - hb, m, { sh: 'cyl' }),
    ell(u - rake, 0, ru * 0.98, rv * 0.98, z + h, 0, 'gun', { edge: true, tone: 1 }),
    ell(u - rake, 0, ru * 0.5, rv * 0.46, z + h, 0, 'black'),
  ];
}

/** A pole mast with a yard across. */
function mast(u: number, z: number, h: number, yard: number): Part[] {
  return [ell(u, 0, 0.32, 0.32, z, h, 'gun'), seg(u, -yard, u, yard, 0.35, z + h * 0.72, 0.2, 'gun')];
}

/**
 * The modern refit's mast (Naval Mastery): a stout lattice tower, a wide pale radar array across its top (3.2 across,
 * it stands highest so it shows above the ship) and a white radar dome on a post above it.
 */
function radarMast(u: number, z: number, h: number, w = 1.6, span = 1.6, dome = 0.9): Part[] {
  return [
    poly(sym([u + w * 0.5, -w * 0.5, u - w * 0.5, -w * 0.5]), z, h * 0.55, 'gun', { tone: 1, pat: 'grille' }),
    poly(sym([u + w * 0.3, -w * 0.3, u - w * 0.3, -w * 0.3]), z + h * 0.55, h * 0.45, 'gun', { tone: 1 }),
    box(u - 0.35, -span, u + 0.35, span, z + h, 0.45, 'sup', { tone: 1 }),
    seg(u, -span, u, span, 0.25, z + h + 0.45, 0, 'gun'),
    ell(u, 0, 0.18, 0.18, z + h + 0.45, 0.5, 'gun'),
    ell(u, 0, dome, dome, z + h + 0.95, dome * 1.2, 'white', { sh: 'dome' }),
  ];
}

/** A white radar dome on a short post. */
function radome(u: number, v: number, z: number, r: number): Part[] {
  return [ell(u, v, r * 0.4, r * 0.4, z, 0.5, 'sup'), ell(u, v, r, r, z + 0.5, r * 1.2, 'white', { sh: 'dome' })];
}

/** A close-in gun (Naval Mastery): a white radar dome on a small mount, its gun out to one side. */
function ciws(u: number, v: number, z: number, dir: number, r = 0.75): Part[] {
  return [ell(u, v, r + 0.25, r + 0.25, z, 0.45, 'sup', { tone: -1 }), ell(u, v, r, r, z + 0.45, r * 1.25, 'white', { sh: 'dome' }), seg(u, v, u + Math.cos(dir) * (r + 1.1), v + Math.sin(dir) * (r + 1.1), 0.4, z + 0.6, 0.25, 'gun')];
}

/** Vertical launch cells (Naval Mastery): a dark block on the deck with a grid of pale hatches. */
function vls(u0: number, v0: number, u1: number, v1: number, z: number, cell = 1.15): Part[] {
  const out: Part[] = [box(u0, v0, u1, v1, z, 0.4, 'gun')];
  const nu = Math.max(1, Math.floor((u1 - u0 - 0.2) / cell));
  const nv = Math.max(1, Math.floor((v1 - v0 - 0.2) / cell));
  const su = (u1 - u0 - nu * cell) / 2;
  const sv = (v1 - v0 - nv * cell) / 2;
  for (let i = 0; i < nu; i++)
    for (let j = 0; j < nv; j++) {
      const a = u0 + su + i * cell + 0.12;
      const b = v0 + sv + j * cell + 0.12;
      out.push(box(a, b, a + cell - 0.24, b + cell - 0.24, z + 0.4, 0, 'sup'));
    }
  return out;
}

/**
 * A rack of `n` missile canisters side by side at (u, v), pointing `dir` radians off the bow: tubes in `m` (pale on a
 * dark deck, dark on a light one), dark mouths.
 */
function canisters(u: number, v: number, z: number, dir: number, n: number, len = 3.2, w = 0.55, m: MatId = 'sup'): Part[] {
  const c = Math.cos(dir);
  const s = Math.sin(dir);
  const out: Part[] = [box(u - 0.6, v - (n * w) / 2 - 0.2, u + 0.6, v + (n * w) / 2 + 0.2, z, 0.35, 'gun')];
  for (let i = 0; i < n; i++) {
    const o = (i - (n - 1) / 2) * w;
    const a = u - s * o - (c * len) / 2;
    const b = v + c * o - (s * len) / 2;
    out.push(seg(a, b, a + c * len, b + s * len, w * 0.9, z + 0.35, 0.5, m, { sh: 'cyl', tone: m === 'sup' ? 1 : 0 }));
    out.push(ell(a + c * len, b + s * len, w * 0.4, w * 0.4, z + 0.85, 0, 'black'));
  }
  return out;
}

/** An armoured box launcher (Naval Mastery, the battleship's cruise missiles): a pale steel box with lid seams. */
function boxLauncher(u0: number, v0: number, u1: number, v1: number, z: number): Part[] {
  return [box(u0, v0, u1, v1, z, 1.2, 'sup', { pat: 'hatches' }), box(u0 + 0.3, (v0 + v1) / 2 - 0.15, u1 - 0.3, (v0 + v1) / 2 + 0.15, z + 1.2, 0, 'gun')];
}

/** A helicopter pad on the deck aft (Naval Mastery): a pale ring with an H. */
function helipad(u: number, z: number, r: number): Part[] {
  return [
    ell(u, 0, r, r, z, 0, 'deck', { tone: -0.5 }),
    ell(u, 0, r, r, z, 0.02, 'paint', { edge: true }),
    seg(u - r * 0.4, -r * 0.35, u + r * 0.4, -r * 0.35, 0.4, z, 0.02, 'paint'),
    seg(u - r * 0.4, r * 0.35, u + r * 0.4, r * 0.35, 0.4, z, 0.02, 'paint'),
    seg(u, -r * 0.35, u, r * 0.35, 0.4, z, 0.02, 'paint'),
  ];
}

/** A lifeboat on its davits along the side. */
function boat(u: number, v: number, z: number, len = 1.6): Part[] {
  return [ell(u, v, len, 0.55, z, 0.55, 'white', { sh: 'cyl' }), ell(u, v, len * 0.75, 0.32, z + 0.55, 0, 'canvas')];
}

/** A sea mine on its rail: a black ball with a yellow band round its middle. */
function mine(u: number, v: number, z: number, r = 1): Part[] {
  return [ell(u, v, r, r, z, r * 0.45, 'hazard', { sh: 'cyl' }), ell(u, v, r * 0.62, r * 0.62, z + r * 0.45, r * 0.5, 'black', { sh: 'dome' })];
}
/**
 * Mine rails (Naval Mines): a rail along each side from `u0` forward with `n` mines each, `gap` apart, at `v` either
 * side of the centreline, and the dark mine chute at the stern (`chute` is the stern's u, or null for none).
 */
function mineRails(u0: number, n: number, gap: number, v: number, z: number, r: number, chute: number | null): Part[] {
  const out: Part[] = [];
  for (const s of [-1, 1]) {
    // the rail on a pale steel strip, so the dark mines stand out on any deck
    out.push(seg(u0 - r, s * v, u0 + (n - 1) * gap + r, s * v, r * 2 + 0.3, z, 0, 'deck', { tone: 1.6 }));
    out.push(seg(u0 - r, s * v, u0 + (n - 1) * gap + r, s * v, 0.45, z, 0.15, 'gun'));
    for (let i = 0; i < n; i++) out.push(...mine(u0 + i * gap, s * v, z + 0.15, r));
  }
  if (chute !== null) out.push(box(chute, -0.8, chute + 1.2, 0.8, z, 0, 'black'), seg(chute + 1.2, -v, chute + 1.2, v, 0.35, z, 0.1, 'gun'));
  return out;
}

// ------------------------------------------------------------------------------------------------- warships

export function warship(mods: number): UnitModel {
  // the cruiser: 34 long, a warm teak deck (its signature: every other warship has a grey deck), a medium twin turret
  // forward, B raised behind it with the owner's stripe on its roof, the bridge tower, two tall upright funnels, boats,
  // a catapult with its aircraft aft, X turret at the stern
  const modern = !!(mods & M_MASTERY);
  const L = 17;
  const H = 2.2;
  // twin turrets: length, width, height, barrels, barrel length, barrel width
  const tl = 3.1;
  const tw = 1.5;
  const th = 1.1;
  const tb = 3.8;
  const tbw = 0.6;
  const out: Part[] = [...shipBase(L, 3.5, 6.5, H, 'teak')];
  out.push(ell(L - 2.4, -0.6, 0.35, 0.35, H, 0.2, 'gun'), ell(L - 2.4, 0.6, 0.35, 0.35, H, 0.2, 'gun'));
  out.push(...turret(10, H, 1, tl, tw, th, 2, tb, tbw));
  if (modern) {
    // a twin-arm missile launcher on B's barbette: two white missiles on their rails
    out.push(ell(6.4, 0, 2.2, 1.8, H, 0.9, 'hull'), ell(6.4, 0, 1.3, 1.2, H + 0.9, 0.7, 'sup', { sh: 'dome' }));
    for (const v of [-0.65, 0.65]) out.push(seg(5.2, v, 8.6, v, 0.6, H + 1.4, 0.5, 'white', { sh: 'cyl' }), ell(8.7, v, 0.35, 0.3, H + 1.5, 0.3, 'brick'));
  } else out.push(ell(6.4, 0, 2.6, 1.9, H, 0.9, 'hull'), ...turret(6.4, H + 0.9, 1, tl, tw, th, 2, tb, tbw, 'own'));
  // the bridge: a deckhouse, the tower with its windows, the fire control top
  out.push(box(0.4, -2.2, 3.2, 2.2, H, 1.5, 'sup'));
  out.push(poly(sym([3, -1.1, 2.6, -1.5, 0.8, -1.5, 0.6, -1.1]), H + 1.5, 1.5, 'sup'));
  out.push(box(2.65, -1.25, 3.05, 1.25, H + 3, 0, 'glass'));
  if (modern) out.push(...radome(1.6, 0, H + 3, 1.1), ...radarMast(0.2, H + 1.5, 4.4, 1.5, 1.7, 0.75));
  else out.push(ell(1.6, 0, 0.85, 0.8, H + 3, 0.8, 'sup', { sh: 'dome' }), ...mast(0.2, H + 1.5, 4.6, 1.7));
  // two tall upright funnels, close together, banded in the owner's colour
  out.push(...funnel(-1.7, 1.15, 1.05, H, 4.8, 0.25), ...funnel(-4.5, 1.15, 1.05, H, 4.6, 0.25));
  out.push(...boat(-3.1, -2.6, H + 0.2), ...boat(-3.1, 2.6, H + 0.2));
  if (modern) {
    // close-in guns where the secondaries stood, missile canisters between the funnels and the pad
    out.push(...ciws(-0.6, -2.4, H, -1.4), ...ciws(-0.6, 2.4, H, 1.4));
    out.push(...canisters(-6.3, -1.3, H, -0.5, 2), ...canisters(-6.3, 1.3, H, 0.5, 2));
    out.push(...helipad(-8.8, H, 2.1));
  } else {
    out.push(...smallGun(-0.6, -2.6, H, -1.6, 0.8, 2), ...smallGun(-0.6, 2.6, H, 1.6, 0.8, 2));
    // the catapult and its aircraft
    out.push(seg(-7.6, -2.6, -7.6, 2.6, 0.6, H, 0.3, 'gun'), seg(-8.3, -1.6, -8.3, 1.6, 0.6, H + 0.4, 0.2, 'alu'), seg(-7.4, 0, -9.5, 0, 0.7, H + 0.4, 0.35, 'alu'));
  }
  out.push(...turret(-12.4, H, -1, tl, tw, th, 2, 3, tbw));
  if (mods & M_SPECIAL) out.push(...mineRails(-15.2, 4, 1.95, 2.55, H, 0.9, -L + 0.1));
  return ship(out, [muzzles(10, H, 1, tl, tw, th, 2, tb, tbw)[0], muzzles(-12.4, H, -1, tl, tw, th, 2, 3, tbw)[0]]);
}

export function destroyer(mods: number): UnitModel {
  // the fast one: a 27 long needle in light haze grey (hull and deck a tone lighter than the cruiser), seven times as
  // long as wide, a long sharp flared bow with a bow wave, a raised forecastle, two single gun mounts forward (the
  // second raised), the bridge, two thin raked funnels, two quintuple torpedo tube banks swung off the centreline,
  // one gun aft, depth charge racks at the square stern
  const modern = !!(mods & M_MASTERY);
  const L = 13.5;
  const H = 1.5;
  const F = H + 0.4;
  // single mounts: length, width, height, barrel length, barrel width
  const ml = 1.15;
  const mw = 0.85;
  const mh = 0.85;
  const mb = 2.4;
  const mbw = 0.5;
  const out: Part[] = [...shipBase(L, 1.8, 6.5, H, 'deck', true, 1)];
  // the bow wave curling off the stem
  out.push(seg(L + 0.2, -0.15, L - 2.8, -1.85, 0.55, 0, 0, 'foam', { a: 0.8 }), seg(L + 0.2, 0.15, L - 2.8, 1.85, 0.55, 0, 0, 'foam', { a: 0.8 }));
  // the raised forecastle, its break at u 6
  out.push(poly(sym([L - 0.6, 0, L - 2, -0.62, L - 3.6, -1.08, L - 5.4, -1.3, 6, -1.32]), H, 0.4, 'deck', { tone: 1.4 }));
  out.push(...turret(10, F, 1, ml, mw, mh, 1, mb, mbw, null, 'hull', 1));
  if (modern) out.push(...vls(5.6, -1.1, 8.8, 1.1, F, 1.05));
  else out.push(ell(7.3, 0, 1, 0.95, F, 0.6, 'hull', { tone: 1 }), ...turret(7.3, F + 0.6, 1, ml, mw, mh, 1, mb, mbw, null, 'hull', 1));
  // the bridge, the owner panel on its roof
  out.push(box(3, -1.2, 5.6, 1.2, H, 1.3, 'sup'), box(4, -1, 5.3, 1, H + 1.3, 0.8, 'sup'), box(5.05, -1, 5.3, 1, H + 2.1, 0, 'glass'));
  out.push(box(3.2, -1, 3.8, 1, H + 1.3, 0, 'own'));
  if (modern) out.push(...radome(4.7, 0, H + 2.1, 0.7), ...radarMast(3.2, H + 1.3, 3.4, 1.2, 1.8, 0.95));
  else out.push(...mast(3.5, H + 1.3, 3.8, 1.2));
  // two thin raked funnels close together
  out.push(...funnel(1.1, 0.8, 0.75, H, 3.4, 1.1), ...funnel(-1.4, 0.8, 0.75, H, 3.2, 1.1));
  // torpedo tube banks: five long pale tubes each, swung 12 degrees off the centreline (one to port, one to starboard)
  for (const [u, a] of [
    [-3.8, 0.21],
    [-7.2, -0.21],
  ] as const) {
    const c = Math.cos(a);
    const s = Math.sin(a);
    out.push(ell(u, 0, 0.8, 0.8, H, 0.3, 'gun'));
    for (let i = 0; i < 5; i++) {
      const o = (i - 2) * 0.36;
      out.push(seg(u - s * o - c * 2.1, c * o - s * 2.1, u - s * o + c * 2.1, c * o + s * 2.1, 0.36, H + 0.3, 0.35, 'sup', { sh: 'cyl', tone: 1.6 }));
    }
    out.push(seg(u + c * 2.1 + s * 0.85, s * 2.1 - c * 0.85, u + c * 2.1 - s * 0.85, s * 2.1 + c * 0.85, 0.35, H + 0.65, 0, 'gun'));
  }
  if (modern) {
    // a close-in gun behind the funnels, missile canisters crossed where the aft gun stood
    out.push(...ciws(-0.2, 0, H + 0.6, Math.PI, 0.6), ell(-0.2, 0, 0.9, 0.9, H, 0.6, 'sup'));
    out.push(...canisters(-10.2, -0.55, H, Math.PI - 0.35, 2, 2.8, 0.5, 'gun'), ...canisters(-10.2, 0.55, H, Math.PI + 0.35, 2, 2.8, 0.5, 'gun'));
  } else out.push(...turret(-10, H, -1, ml, mw, mh, 1, mb, mbw, null, 'hull', 1));
  // depth charge racks at the stern
  out.push(box(-13, -1.3, -11.8, -0.7, H, 0.5, 'gun'), box(-13, 0.7, -11.8, 1.3, H, 0.5, 'gun'));
  if (mods & M_SPECIAL) out.push(...mineRails(-12.6, 4, 1.9, 1.2, H, 0.9, null));
  const g = muzzles(10, F, 1, ml, mw, mh, 1, mb, mbw)[0];
  return ship(out, [g, g]);
}

export function battleship(mods: number): UnitModel {
  // the heavy hitter: 52 long on a 13 wide beam, a dark steel deck with four big triple turrets a step lighter than
  // the deck (A and raised B forward with the owner's stripe across their roofs, raised X and Y aft) whose thick
  // barrels lie far over the deck, a tall stepped tower, one big trunked funnel, twin secondaries along both sides
  const modern = !!(mods & M_MASTERY);
  const L = 25;
  const H = 3;
  const B = 6.5;
  // main turrets: length, width, height, barrel length, barrel width (three barrels each)
  const tl = 4;
  const tw = 3.6;
  const th = 2.2;
  const tb = 7.5;
  const tbw = 1.2;
  // the gun houses a step lighter than the dark deck (sup one tone down), so the big guns stand out
  const tt = -1;
  const out: Part[] = [...shipBase(L, B, 11, H, 'bbdeck', true)];
  out.push(ell(L - 3, -1, 0.5, 0.5, H, 0.2, 'gun'), ell(L - 3, 1, 0.5, 0.5, H, 0.2, 'gun'));
  out.push(...turret(14, H, 1, tl, tw, th, 3, tb, tbw, 'own', 'sup', tt));
  out.push(ell(7.6, 0, 4.4, 4, H, 1.6, 'hull'), ...turret(7.6, H + 1.6, 1, tl, tw, th, 3, tb, tbw, 'own', 'sup', tt));
  // the tower: a broad armoured base, two stepped decks, the bridge windows, the fire control top
  out.push(box(-4.6, -4, 2.6, 4, H, 1.8, 'sup'));
  out.push(poly(sym([2.2, -2.9, 1.6, -3.4, -3.8, -3.4, -4.2, -2.9]), H + 1.8, 1.6, 'sup'));
  out.push(poly(sym([1.4, -2.1, 0.9, -2.6, -3, -2.6, -3.4, -2.1]), H + 3.4, 1.6, 'sup'));
  out.push(box(1, -2.2, 1.4, 2.2, H + 5, 0, 'glass'));
  out.push(box(-2.4, -1.5, 0.4, 1.5, H + 5, 1.2, 'sup'));
  if (modern) out.push(...radome(-1, 0, H + 6.2, 1.2), ...radarMast(-3.4, H + 5, 2.6, 1.6, 2.2, 0.9));
  else out.push(ell(-1, 0, 0.9, 1.7, H + 6.2, 0.6, 'gun'), ...mast(-3.4, H + 5, 3.2, 2.4));
  out.push(...funnel(-6.8, 2.4, 2, H + 1, 3.8, 0.5));
  // secondaries: four twin mounts each side on the deck edge (the refit lands close-in guns and armoured missile
  // launchers on the same places)
  for (const s of [-1, 1]) {
    if (modern) {
      out.push(...ciws(2.4, s * 5, H, s * 1.2), ...ciws(-7.4, s * 5, H, s * 1.6));
      out.push(...boxLauncher(-4.9, s > 0 ? 4 : -6, -0.3, s > 0 ? 6 : -4, H));
    } else for (const u of [2.4, -0.8, -4, -7.2]) out.push(...smallGun(u, s * 5.1, H, s * 1.3, 1.1, 2.6, true));
    out.push(...boat(-10.2, s * 5.3, H + 0.2, 1.8));
  }
  // aft: X raised over Y (the refit swaps X for a big block of vertical launch cells)
  if (modern) out.push(...vls(-15.4, -3.2, -9.4, 3.2, H, 1.3));
  else out.push(ell(-12.6, 0, 4.4, 4, H, 1.6, 'hull'), ...turret(-12.6, H + 1.6, -1, tl, tw, th, 3, tb, tbw, null, 'sup', tt));
  out.push(...turret(-18.2, H, -1, tl, tw, th, 3, 5, tbw, null, 'sup', tt));
  if (mods & M_SPECIAL) out.push(...mineRails(-23.4, 6, 2.6, 5, H, 1.35, -L + 0.1));
  const m1 = muzzles(14, H, 1, tl, tw, th, 3, tb, tbw);
  const m2 = muzzles(7.6, H + 1.6, 1, tl, tw, th, 3, tb, tbw);
  const m4 = muzzles(-18.2, H, -1, tl, tw, th, 3, 5, tbw);
  return ship(out, [m1[1], m2[1], m4[1]]);
}

/** A nuclear boat's teardrop hull outline (port half mirrored): a round bow, a long body, a long taper aft. */
function teardrop(bow: number, stern: number, r: number): number[] {
  const pts: number[] = [];
  const Lb = 4.2;
  for (let i = 0; i <= 6; i++) {
    const a = (i / 6) * (Math.PI / 2);
    pts.push(bow - Lb + Math.cos(a) * Lb, -Math.sin(a) * r);
  }
  pts.push(stern + 10, -r, stern + 5, -r * 0.62, stern + 1.4, -r * 0.22, stern, 0);
  return sym(pts);
}

export function submarine(mods: number): UnitModel {
  // a dark cigar half under water, outlined by the white water where it breaks the surface: a bow wave at the stem,
  // a swirl at the stern, the casing a tone lighter along the top, a deck gun forward and the sail (conning tower) in
  // the middle, its top the owner panel. With Naval Mastery it is a nuclear boat: a longer smooth teardrop hull and a
  // tall slim sail set forward with fin planes out to both sides, a rudder fin and planes at the tail.
  const nuke = !!(mods & M_MASTERY);
  const out: Part[] = [];
  if (nuke) {
    out.push(
      poly(teardrop(13.9, -13.7, 2.6), 0, 0, 'foam', { a: 0.75 }),
      seg(13.4, -0.3, 10, -2.7, 0.55, 0, 0, 'foam', { a: 0.85 }),
      seg(13.4, 0.3, 10, 2.7, 0.55, 0, 0, 'foam', { a: 0.85 }),
      ell(-14, 0, 1.8, 1.1, 0, 0, 'foam', { a: 0.6 }),
      poly(teardrop(13, -13, 1.95), 0, 0.65, 'sub', { sh: 'cyl', sc: [0, 0, 13, 1.95] }),
      // the sea washing over the long tail
      poly(sym([-6, 0, -7, -1.6, -11.6, -0.9, -13, 0]), 0.7, 0, 'sea', { a: 0.3 }),
      // the tail: planes across and the rudder fin standing up
      seg(-11.4, -2.4, -11.4, 2.4, 0.7, 0.35, 0.2, 'sub', { tone: 1 }),
      box(-12.8, -0.22, -10.6, 0.22, 0.6, 1.5, 'sub', { tone: 1 }),
      // the tall slim sail set forward, fin planes out to both sides, the owner panel on top, masts
      poly(sym([9.4, 0, 8.7, -0.8, 5, -0.8, 4.3, 0]), 0.6, 3.6, 'sub', { tone: 2 }),
      seg(7.6, -2.8, 7.6, 2.8, 0.75, 2.8, 0.22, 'sub', { tone: 2 }),
      poly(sym([8.7, 0, 8.2, -0.55, 5.4, -0.55, 4.9, 0]), 4.2, 0, 'own'),
      ell(6.6, 0, 0.28, 0.28, 4.2, 1.6, 'gun'),
      ell(5.7, 0, 0.28, 0.28, 4.2, 1.1, 'gun'),
    );
  } else {
    out.push(
      // the white water round the hull where it breaks the surface, the bow wave and a swirl at the stern
      ell(0.2, 0, 12.6, 2.2, 0, 0, 'foam', { a: 0.75 }),
      seg(12.4, -0.2, 9.4, -2.4, 0.55, 0, 0, 'foam', { a: 0.85 }),
      seg(12.4, 0.2, 9.4, 2.4, 0.55, 0, 0, 'foam', { a: 0.85 }),
      ell(-12.6, 0, 1.6, 1, 0, 0, 'foam', { a: 0.6 }),
      ell(0, 0, 12, 1.7, 0, 0.6, 'sub', { sh: 'cyl' }),
      // the flat deck casing along the top, a tone lighter
      seg(-8.5, 0, 9, 0, 1.1, 0.6, 0.1, 'sub', { tone: 1 }),
      // the bow and stern awash: the sea running over them, foam where it breaks
      poly(sym([11.6, 0, 11, -1.2, 7.6, -1.6, 6.8, 0]), 0.75, 0, 'sea', { a: 0.3 }),
      poly(sym([-6, 0, -6.8, -1.6, -11, -1.2, -11.6, 0]), 0.75, 0, 'sea', { a: 0.3 }),
      // stern planes
      seg(-10.4, -2, -10.4, 2, 0.5, 0.3, 0.15, 'sub'),
      ...smallGun(5.4, 0, 0.7, 0, 0.9, 2.4),
      // the sail: a streamlined fin, the bridge on top in the owner colour, periscopes and masts
      poly(sym([3.6, 0, 2.8, -1.2, -1.8, -1.2, -2.4, -0.5]), 0.6, 2.8, 'sub', { tone: 2 }),
      poly(sym([2.8, 0, 2.2, -0.8, -1.2, -0.85, -1.9, -0.35]), 3.4, 0, 'own'),
      ell(0.4, 0, 0.3, 0.3, 3.4, 1.6, 'gun'),
      ell(-0.6, 0, 0.3, 0.3, 3.4, 1.2, 'gun'),
    );
  }
  // a mine-laying boat: two rows of three mines on the aft casing, their rails showing
  if (mods & M_SPECIAL) out.push(...mineRails(nuke ? -9 : -8.6, 3, 2, 0.95, 0.65, 0.95, null));
  // torpedoes leave from the bow
  const bow: Gun = [nuke ? 12.6 : 11.2, 0, 0.3];
  return ship(out, [bow, bow]);
}

/**
 * A small plane parked on a flight deck at (u, v), its nose turned `ang` radians from the bow (toward starboard), its
 * wings spread `span` units each side (less with the wings folded). `jet`: a swept-wing jet with twin fins, no prop.
 */
function parked(u: number, v: number, z: number, ang: number, span = 2, jet = false): Part[] {
  const c = Math.cos(ang);
  const s = Math.sin(ang);
  const P = (a: number, b: number): [number, number] => [u + a * c - b * s, v + a * s + b * c];
  if (jet)
    return [
      seg(...P(2.4, 0), ...P(-2.2, 0), 0.8, z, 0.55, 'hull', { sh: 'cyl', tone: 1 }),
      poly([...P(0.9, -0.3), ...P(-1, -span - 0.3), ...P(-1.7, -span - 0.3), ...P(-1.1, -0.3), ...P(-1.1, 0.3), ...P(-1.7, span + 0.3), ...P(-1, span + 0.3), ...P(0.9, 0.3)], z + 0.2, 0.25, 'hull', { tone: 1 }),
      seg(...P(-1.6, -0.45), ...P(-2.3, -0.6), 0.35, z + 0.4, 0.6, 'hull'),
      seg(...P(-1.6, 0.45), ...P(-2.3, 0.6), 0.35, z + 0.4, 0.6, 'hull'),
      ell(...P(1.3, 0), 0.5, 0.3, z + 0.55, 0, 'glass'),
    ];
  return [
    seg(...P(1.8, 0), ...P(-1.8, 0), 0.85, z, 0.55, 'seagrey', { sh: 'cyl' }),
    poly([...P(1, -span), ...P(1, span), ...P(-0.1, span), ...P(-0.1, -span)], z + 0.2, 0.25, 'seagrey'),
    seg(...P(-1.5, -0.9), ...P(-1.5, 0.9), 0.6, z + 0.2, 0.25, 'seagrey'),
    ell(...P(0.5, 0), 0.4, 0.4, z + 0.55, 0, 'glass'),
  ];
}

/** The carrier is laid out on a 54 long frame and drawn this much longer and wider (60 long, its deck 14.2 wide). */
const CU = CL / 27;
const CV = 1.1;

export function carrier(mods: number): UnitModel {
  // the biggest: 60 long on a broad flight deck (about four times as long as wide) in dark weathered steel, the
  // angled landing deck reaching out over a sponson to port, the island on the starboard side (its funnel band and a
  // small panel on its roof the only owner colour), planes parked along the starboard edge clear of the landing area
  // and one on the bow catapult, gun tubs and catwalks round the edges. The deck's plates, tyre marks and sparse worn
  // markings are its pattern (carrierDeck.ts). Laid out at 54 long (L 27) and stretched to the real size at the end.
  // With Naval Mastery it is a supercarrier: the angled deck's sponson reaches further out, the island carries a radar
  // dome and a big radar array, jets sit on deck in place of the propeller planes, close-in guns and missile launchers
  // stand at the corners.
  const modern = !!(mods & M_MASTERY);
  const L = 27;
  const H = 2.4;
  const out: Part[] = [poly(hullShape(L - 1, 4.4, 10, true), 0, H, 'hull'), poly(hullShape(L - 0.95, 4.45, 10, true), 0, 0.55, 'hullDark')];
  // catwalks and sponsons just under the deck edge, so the edge reads as a ship's, not a straight kerb
  for (const [u0, v0, u1, v1] of [
    [14, 4.9, 17.6, 5.9],
    [-20.4, 4.8, -16.8, 5.8],
    [15.4, -6.1, 19, -5],
    [-20.6, -6.2, -16.4, -5],
  ] as const)
    out.push(box(u0, v0, u1, v1, H - 0.1, 0.55, 'deck'));
  const deck = modern
    ? [L, -1.5, L - 1.5, -3.6, L - 4.4, -4.9, 15.4, -5.4, 12.2, -6.4, 8.4, -8.4, 3.4, -8.8, -6, -7.2, -L + 1, -4.8, -L, -3.9, -L, 3.9, -L + 1, 5, L - 6.5, 5.2, L - 3.4, 4.5, L - 1.3, 3.2, L, 1.5]
    : [L, -1.5, L - 1.5, -3.6, L - 4.4, -4.9, 13.4, -5.4, 10.2, -6.1, 7.2, -7.5, 4.2, -7.7, -L + 1, -4.8, -L, -3.9, -L, 3.9, -L + 1, 5, L - 6.5, 5.2, L - 3.4, 4.5, L - 1.3, 3.2, L, 1.5];
  if (modern) out.push(box(-6, -7.6, 4, -4, H - 0.1, 0.55, 'deck'));
  out.push(poly(deck, H, 0.8, 'flightdeck', { pat: 'flightDeck', alt: 'paint' }));
  const D = H + 0.8;
  // the island on the starboard side: a long base, a second level, the bridge with its windows, a big raked funnel
  // with the owner band, the owner panel on the base roof, the mast
  out.push(box(-7.2, 3.9, 2.6, 6.3, D, 2, 'sup'), box(-4.6, 4.1, 2.2, 6.1, D + 2, 1.5, 'sup'), box(1.85, 4.15, 2.2, 6.05, D + 2, 0, 'glass'));
  out.push(box(-0.4, 4.25, 1.9, 5.95, D + 3.5, 1, 'sup'), box(1.55, 4.3, 1.9, 5.9, D + 4.5, 0, 'glass'));
  out.push(box(-6.8, 4.3, -5.1, 5.9, D + 2, 0, 'own'));
  out.push(...moved(funnel(-2.8, 1.35, 0.9, D + 2, 2.8, 0.9, true), 0, 5.1));
  if (modern) out.push(...moved(radarMast(0.6, D + 4.5, 2.8, 1.3, 1.8, 0.85), 0, 5.1), ...radome(-5.8, 5.1, D + 3.5, 1.1), box(-4.4, 3.85, -2, 4.15, D + 2.2, 1.2, 'gun', { tone: 1 }));
  else out.push(...moved(mast(0.6, D + 4.5, 3, 1.3), 0, 5.1));
  // planes: one on the bow catapult with its wings spread, three parked on the starboard bow and two aft of the
  // island (tails toward the edge, noses inboard, wings folded), one on the aft elevator
  out.push(...parked(L - 4.6, -1.3, D, -0.05, 2, modern));
  for (const u of [21.4, 17.8, 14.2]) out.push(...parked(u, 3.1, D, -1.1, 1.15, modern));
  for (const u of [-14.8, -18.4]) out.push(...parked(u, 3.5, D, -1, 1.15, modern));
  out.push(...parked(-10.6, 4.4, D, 0, 1.15, modern));
  // gun tubs at the corners (close-in guns after the refit)
  for (const [u, v] of [
    [L - 5.4, -5.4],
    [L - 6.4, 5.5],
    [-L + 3, -5.1],
    [-L + 3, 5.4],
  ] as const)
    out.push(...(modern ? ciws(u, v, H + 0.2, v < 0 ? -1.4 : 1.4, 0.8) : smallGun(u, v, H + 0.2, v < 0 ? -1.4 : 1.4, 0.75, 1.6)));
  if (modern) out.push(...canisters(17.2, -6.3, H + 0.2, 0, 4, 2.6, 0.5), ...canisters(-18.4, 6, H + 0.2, Math.PI, 4, 2.6, 0.5));
  // mine rails on catwalks outboard of the deck along both quarters
  if (mods & M_SPECIAL) {
    out.push(box(-25.6, -7.5, -12.2, -5.4, H - 0.4, 0.4, 'deck'), box(-25.6, 5.4, -12.2, 7.5, H - 0.4, 0.4, 'deck'));
    out.push(...mineRails(-24.4, 6, 2.2, 6.35, H, 1.15, null));
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
