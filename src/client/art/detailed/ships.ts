// The detailed style's ship models (client only, pure data), rasterized by bake.ts like every other unit model. Model
// units are screen px at mid zoom; the bow points at +u, the starboard side at +v. All art is original and lives here
// as code.
//
// Each ship reads by its silhouette first, then its colour (at mid zoom one unit is one screen px, so every detail is
// a few px big and set off by value; see the value plan under "hull and fittings"):
//   carrier      the biggest (60 long): a broad dark flight deck with a light edge, the angled landing deck to port,
//                the tall light island to starboard, a few pale planes parked along the starboard edge
//   battleship   52 long and broad: a dark steel deck with four big pale triple turrets ringed dark (two forward, two
//                aft, the inner ones superfiring) whose thick light barrels lie far over the deck, a tall light tower
//   warship      (no arsenal pick) a 35 long cruiser with a warm teak deck, three dark twin turrets, two upright funnels
//   destroyer    a 28 long needle with the lightest deck, dark single gun mounts, two raked funnels and two dark banks
//                of three torpedo tubes swung across the deck
//   submarine    a dark cigar outlined in white water, one big grey sail in the middle and a deck gun
//   transport    a boxy landing ship: bow doors, an open well deck full of helmeted troops, the bridge aft
//   trade ship   a black merchant hull with a cream house aft, deck containers and cargo cranes, clearly no guns
// Upgrades change the ship you see, in bold colours:
//   Naval Mastery  the modern refit: a dark lattice mast under a big white radar dome, launch cells (a dark grid on a
//                  pale patch) and pale missile canisters or box launchers in place of some of the old guns; the
//                  submarine becomes a nuclear boat (a longer teardrop hull, a tall sail set forward with wide fin
//                  planes on it); the carrier a supercarrier (a bigger angled deck, a white radar dome on the island,
//                  jets on deck, launch cells and domes at the corners)
//   Naval Mines    a yellow and black row of mines on a dark rail along each side aft (one row along the submarine's
//                  casing), a mine chute at the stern
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
//   - few, big fittings: guns dark on a light deck (or light on the battleship's dark one), barrels long and thick,
//     the superstructure light with a dark shadow side, the owner's colour as a band on the funnels;
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

/**
 * A gun turret facing `dir` (1 forward, -1 aft): the gun house (flat roof, sloped face, rounded back) in `m` at
 * `tone`, `n` barrels of width `bw` and length `barrel` in `bm` (dark on a light deck, light on a dark one), and a
 * dark ring round its foot when it stands on a dark deck (`ring`), so a pale house keeps its outline.
 */
function turret(u: number, z: number, dir: 1 | -1, len: number, wid: number, h: number, n: number, barrel: number, bw: number, m: MatId, tone: number, bm: MatId, ring = false): Part[] {
  const f = dir;
  const house = sym([u + f * len * 0.62, -wid * 0.6, u + f * len * 0.34, -wid, u - f * len * 0.7, -wid, u - f * len, -wid * 0.55]);
  const out: Part[] = [];
  if (ring) out.push(ell(u - f * len * 0.1, 0, len * 0.95 + 0.4, wid + 0.45, z, 0, 'black'));
  out.push(poly(house, z, h, m, { tone }));
  const gap = gunGap(n, wid, bw);
  for (let i = 0; i < n; i++) {
    const v = n === 1 ? 0 : -gap + (2 * gap * i) / (n - 1);
    const u0 = u + f * len * 0.4;
    out.push(seg(u0, v, u0 + f * barrel, v, bw, z + h * 0.3, h * 0.45, bm, { sh: 'cyl', tone: bm === 'sup' ? 0 : 1 }));
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
  for (let i = 0; i < n; i++) out.push([u + dir * (len * 0.4 + barrel), n === 1 ? 0 : -gap + (2 * gap * i) / (n - 1), z + h * 0.6]);
  return out;
}

/** A small gun mount (a submarine's deck gun, a carrier's gun tubs): a round shield and one barrel. */
function smallGun(u: number, v: number, z: number, dir: number, r = 0.85, barrel = 2.2, m: MatId = 'hull', tone = 0): Part[] {
  const c = Math.cos(dir);
  const s = Math.sin(dir);
  return [ell(u, v, r, r * 0.9, z, 0.8, m, { sh: 'dome', tone }), seg(u, v, u + c * barrel, v + s * barrel, 0.6, z + 0.45, 0.3, m, { tone: tone - 1 })];
}

/**
 * A funnel: lower part, the owner band (`hb` tall), the upper part raked aft by `rake`, the dark smoke opening.
 */
function funnel(u: number, ru: number, rv: number, z: number, h: number, rake: number, band = true, m: MatId = 'sup', hb = 0.7): Part[] {
  const h1 = Math.max(0.6, h - 0.8 - hb);
  const r1 = rake * (h1 / h);
  const r2 = rake * ((h1 + hb) / h);
  return [
    ell(u, 0, ru, rv, z, h1, m, { sh: 'cyl' }),
    ell(u - r1, 0, ru, rv, z + h1, hb, band ? 'own' : m, { sh: 'cyl' }),
    ell(u - r2, 0, ru * 0.98, rv * 0.98, z + h1 + hb, h - h1 - hb, m, { sh: 'cyl' }),
    ell(u - rake, 0, ru * 0.98, rv * 0.98, z + h, 0, 'gun', { edge: true, tone: 1 }),
    ell(u - rake, 0, ru * 0.55, rv * 0.5, z + h, 0, 'black'),
  ];
}

/** A pole mast with a yard across. */
function mast(u: number, z: number, h: number, yard: number): Part[] {
  return [ell(u, 0, 0.32, 0.32, z, h, 'gun'), seg(u, -yard, u, yard, 0.35, z + h * 0.72, 0.2, 'gun')];
}

/**
 * The modern refit's radar (Naval Mastery): a stout dark lattice tower and a big white radar dome on top (`dome` its
 * radius: 1.5 and more is three px across at mid zoom).
 */
function radarMast(u: number, z: number, h: number, w = 1.6, dome = 1.5): Part[] {
  return [
    poly(sym([u + w * 0.5, -w * 0.5, u - w * 0.5, -w * 0.5]), z, h * 0.6, 'gun', { tone: 1, pat: 'grille' }),
    poly(sym([u + w * 0.3, -w * 0.3, u - w * 0.3, -w * 0.3]), z + h * 0.6, h * 0.4, 'gun', { tone: 1 }),
    ell(u, 0, dome, dome, z + h, dome * 1.1, 'white', { sh: 'dome', tone: 1 }),
  ];
}

/** A white radar dome on a short dark post (Naval Mastery). */
function radome(u: number, v: number, z: number, r: number): Part[] {
  return [ell(u, v, r * 0.45, r * 0.45, z, 0.5, 'gun'), ell(u, v, r, r, z + 0.5, r * 1.1, 'white', { sh: 'dome', tone: 1 })];
}

/**
 * Vertical launch cells (Naval Mastery): a pale steel patch on the deck with a grid of dark hatches, each hatch one
 * unit by `cv` and `pu` x `pv` apart, so at mid zoom every hatch is a dark pixel with a pale one round it.
 */
function vls(u0: number, v0: number, u1: number, v1: number, z: number, pu = 2, pv = 2.3): Part[] {
  const out: Part[] = [box(u0, v0, u1, v1, z, 0.35, 'white', { tone: -1 })];
  const nu = Math.max(1, Math.floor((u1 - u0) / pu));
  const nv = Math.max(1, Math.floor((v1 - v0) / pv));
  const su = (u1 - u0 - nu * pu) / 2;
  const sv = (v1 - v0 - nv * pv) / 2;
  for (let i = 0; i < nu; i++)
    for (let j = 0; j < nv; j++) {
      const a = u0 + su + i * pu + (pu - 1) / 2;
      const b = v0 + sv + j * pv + (pv - 1.15) / 2;
      out.push(box(a, b, a + 1, b + 1.15, z + 0.35, 0, 'black'));
    }
  return out;
}

/**
 * A missile launcher (Naval Mastery): a rack of `n` canisters side by side at (u, v), pointing `dir` radians off the
 * bow, pale tubes on a dark cradle with dark mouths.
 */
function canisters(u: number, v: number, z: number, dir: number, n: number, len = 3.4, w = 0.95): Part[] {
  const c = Math.cos(dir);
  const s = Math.sin(dir);
  const out: Part[] = [];
  for (let i = 0; i < n; i++) {
    const o = (i - (n - 1) / 2) * w * 1.25;
    const a = u - s * o - (c * len) / 2;
    const b = v + c * o - (s * len) / 2;
    out.push(seg(a, b, a + c * len, b + s * len, w + 0.5, z, 0.3, 'black'));
    out.push(seg(a, b, a + c * len, b + s * len, w, z + 0.3, 0.6, 'white', { sh: 'cyl' }));
    out.push(ell(a + c * len, b + s * len, w * 0.45, w * 0.45, z + 0.9, 0, 'black'));
  }
  return out;
}

/** An armoured box launcher (Naval Mastery, the battleship's cruise missiles): a pale box with dark lid seams. */
function boxLauncher(u0: number, v0: number, u1: number, v1: number, z: number): Part[] {
  const out: Part[] = [box(u0, v0, u1, v1, z, 1.2, 'white', { tone: -1 })];
  for (let u = u0 + 1.4; u < u1 - 0.6; u += 1.8) out.push(box(u, v0 + 0.3, u + 0.9, v1 - 0.3, z + 1.2, 0, 'black'));
  return out;
}

/** A lifeboat on its davits along the side. */
function boat(u: number, v: number, z: number, len = 1.6): Part[] {
  return [ell(u, v, len, 0.55, z, 0.55, 'white', { sh: 'cyl' }), ell(u, v, len * 0.75, 0.32, z + 0.55, 0, 'canvas')];
}

/**
 * Mine rails (Naval Mines): a dark rail along each side from `u0` forward, with `n` yellow mines `gap` apart
 * at `v` either side of the centreline (one rail on it for `v` 0), so each side reads as a yellow and black row; close up each mine shows its
 * black cap. `chute` is the stern's u for the dark mine chute (null for none).
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

// ------------------------------------------------------------------------------------------------- warships

export function warship(mods: number): UnitModel {
  // the cruiser: 34 long, a warm teak deck (its signature: every other warship has a grey deck) with a light edge,
  // three dark twin turrets (A forward, B raised behind it, X aft) whose barrels lie long over the teak, a light
  // bridge tower, two tall upright funnels banded in the owner's colour
  const modern = !!(mods & M_MASTERY);
  const L = 17.3;
  const H = 2.2;
  // twin turrets: length, width, height, barrels, barrel length, barrel width
  const tl = 3.2;
  const tw = 1.7;
  const th = 1.2;
  const tb = 4.6;
  const tbw = 0.8;
  const out: Part[] = [...shipBase(L, 3.5, 6.5, H, { deck: 'teak', side: 0, edge: 'teak', edgeTone: 0 })];
  out.push(...turret(10.4, H, 1, tl, tw, th, 2, tb, tbw, 'gun', 1, 'gun'));
  if (modern) {
    // B turret's place: a block of launch cells
    out.push(...vls(4.6, -1.9, 8.6, 1.9, H, 2, 1.8));
  } else out.push(ell(6.4, 0, 2.4, 1.9, H, 1, 'gun'), ...turret(6.4, H + 1, 1, tl, tw, th, 2, tb, tbw, 'gun', 1, 'gun'));
  // the bridge: a light deckhouse and tower with its windows (their shadow side dark under the light)
  out.push(box(0.2, -2.3, 3.4, 2.3, H, 1.6, 'sup'));
  out.push(poly(sym([3.1, -1.2, 2.7, -1.6, 0.6, -1.6, 0.4, -1.2]), H + 1.6, 1.6, 'sup'));
  out.push(box(2.75, -1.3, 3.1, 1.3, H + 3.2, 0, 'glass'));
  if (modern) out.push(...radarMast(0.8, H + 3.2, 2.2, 1.4, 1.6));
  else out.push(...mast(1.2, H + 3.2, 3.4, 1.8));
  // two tall upright funnels, banded in the owner's colour
  out.push(...funnel(-1.9, 1.3, 1.2, H, 4.8, 0.25, true, 'sup', 1.1), ...funnel(-4.9, 1.3, 1.2, H, 4.6, 0.25, true, 'sup', 1.1));
  if (modern) {
    // missile racks behind the funnels, the helicopter pad aft
    out.push(...canisters(-8, -1.6, H, -0.45, 2, 3.2, 0.9), ...canisters(-8, 1.6, H, 0.45, 2, 3.2, 0.9));
  }
  // X turret aft, the owner's recognition stripe across its roof
  out.push(...turret(-12.2, H, -1, tl, tw, th, 2, 3.8, tbw, 'gun', 1, 'gun'), box(-12.1, -tw * 0.62, -10.9, tw * 0.62, H + th, 0, 'own'));
  if (mods & M_SPECIAL) out.push(...mineRails(-15.4, 4, 2.9, 2.55, H, 0.95, -L + 0.2));
  return ship(out, [muzzles(10.4, H, 1, tl, tw, th, 2, tb, tbw)[0], muzzles(-12.2, H, -1, tl, tw, th, 2, 3.8, tbw)[0]]);
}

export function destroyer(mods: number): UnitModel {
  // the fast one: a 28 long needle (six and a half times as long as wide), the lightest deck of all over dark sides,
  // a long sharp bow with a bow wave, two dark single gun mounts forward (the second raised), the light bridge, two
  // raked funnels banded in the owner's colour, two dark banks of three torpedo tubes swung across the deck aft
  // (the destroyer's own mark), one gun aft
  const modern = !!(mods & M_MASTERY);
  const L = 14;
  const H = 1.5;
  // single mounts: length, width, height, barrel length, barrel width
  const ml = 1.8;
  const mw = 1.25;
  const mh = 0.9;
  const mb = 3.1;
  const mbw = 0.9;
  const out: Part[] = [...shipBase(L, 2.1, 7, H, { deck: 'hull', deckTone: 1, side: -1, edge: 'sup', edgeTone: 0, transom: true })];
  // the bow wave curling off the stem
  out.push(seg(L + 0.2, -0.15, L - 3, -2.3, 0.6, 0, 0, 'foam', { a: 0.8 }), seg(L + 0.2, 0.15, L - 3, 2.3, 0.6, 0, 0, 'foam', { a: 0.8 }));
  out.push(...turret(10.2, H, 1, ml, mw, mh, 1, mb, mbw, 'gun', 0, 'gun'));
  if (modern) out.push(...vls(5, -1.8, 9.2, 1.8, H, 2, 1.8));
  else out.push(ell(7.4, 0, 1.3, 1.15, H, 0.7, 'gun'), ...turret(7.4, H + 0.7, 1, ml, mw, mh, 1, mb, mbw, 'gun', 0, 'gun'));
  // the bridge: light, with its dark shadow side and windows
  out.push(box(2.6, -1.6, 5.4, 1.6, H, 1.4, 'sup'), box(3.6, -1.2, 5.1, 1.2, H + 1.4, 0.9, 'sup'), box(4.8, -1.2, 5.1, 1.2, H + 2.3, 0, 'glass'));
  if (modern) out.push(...radarMast(3.1, H + 1.4, 2.4, 1.3, 1.55));
  else out.push(...mast(3.2, H + 1.4, 3.8, 1.4));
  // two raked funnels, banded in the owner's colour
  out.push(...funnel(0.8, 1, 0.95, H, 3.6, 0.9, true, 'sup', 1.1), ...funnel(-2, 1, 0.95, H, 3.4, 0.9, true, 'sup', 1.1));
  // torpedo tube banks: three long dark tubes each on a turntable, swung across the deck (one forward of the other,
  // trained to opposite sides) so they read as dark slanted bars on the light deck
  for (const [u, a] of [
    [-4.5, 0.75],
    [-7.8, -0.75],
  ] as const) {
    const c = Math.cos(a);
    const s = Math.sin(a);
    out.push(ell(u, 0, 0.6, 0.6, H, 0.25, 'gun'));
    for (let i = 0; i < 3; i++) {
      const o = (i - 1) * 1.3;
      out.push(seg(u - s * o - c * 1.7, c * o - s * 1.7, u - s * o + c * 1.7, c * o + s * 1.7, 0.75, H + 0.25, 0.5, 'gun'));
    }
  }
  if (modern && !(mods & M_SPECIAL)) {
    // missile canisters crossed where the aft gun stood
    out.push(...canisters(-11.6, -0.9, H, Math.PI - 0.35, 2, 3, 0.8), ...canisters(-11.6, 0.9, H, Math.PI + 0.35, 2, 3, 0.8));
  } else if (!modern && !(mods & M_SPECIAL)) out.push(...turret(-10.8, H, -1, ml, mw, mh, 1, mb, mbw, 'gun', 0, 'gun'));
  // the minelayer: rails over the quarterdeck where the aft gun stood
  if (mods & M_SPECIAL) out.push(...mineRails(-13.2, 3, 2.4, 1.3, H, 0.75, null));
  const g = muzzles(10.2, H, 1, ml, mw, mh, 1, mb, mbw)[0];
  return ship(out, [g, g]);
}

export function battleship(mods: number): UnitModel {
  // the heavy hitter: 52 long on a 13 wide beam, a dark steel deck with a light edge, four big pale triple turrets
  // ringed dark (A and raised B forward, raised X and Y aft) whose thick light barrels lie far over the dark deck, a
  // tall light stepped tower, one big funnel with the owner's band
  const modern = !!(mods & M_MASTERY);
  const L = 25;
  const H = 3;
  const B = 6.5;
  // main turrets: length, width, height, barrel length, barrel width (three barrels each)
  const tl = 4.2;
  const tw = 3.6;
  const th = 2.2;
  const tb = 8;
  const tbw = 1.2;
  const T = (u: number, z: number, dir: 1 | -1, b = tb): Part[] => turret(u, z, dir, tl, tw, th, 3, b, tbw, 'sup', 0, 'sup', true);
  const out: Part[] = [...shipBase(L, B, 11, H, { deck: 'bbdeck', deckTone: 1, side: -1, edge: 'sup', edgeTone: -1, transom: true })];
  out.push(...T(14.2, H, 1));
  // B raised behind A, the owner's recognition stripe across its roof
  out.push(ell(7.8, 0, 4.5, 4.1, H, 1.6, 'black'), ...T(7.8, H + 1.6, 1), box(4.4, -tw * 0.62, 5.8, tw * 0.62, H + 1.6 + th, 0, 'own'));
  // the tower: a broad armoured base, two stepped decks, the bridge windows, the fire control top
  out.push(box(-4.6, -4, 2.6, 4, H, 1.8, 'sup'));
  out.push(poly(sym([2.2, -2.9, 1.6, -3.4, -3.8, -3.4, -4.2, -2.9]), H + 1.8, 1.6, 'sup'));
  out.push(poly(sym([1.4, -2.1, 0.9, -2.6, -3, -2.6, -3.4, -2.1]), H + 3.4, 1.6, 'sup'));
  out.push(box(1, -2.2, 1.4, 2.2, H + 5, 0, 'glass'));
  out.push(box(-2.4, -1.5, 0.4, 1.5, H + 5, 1.2, 'sup'));
  if (modern) out.push(...radarMast(-1, H + 6.2, 1.6, 1.6, 1.8));
  else out.push(...mast(-3, H + 5, 3.4, 2.6));
  out.push(...funnel(-7, 2.5, 2.2, H + 1, 3.8, 0.5, true, 'sup', 1.2));
  if (modern) {
    // armoured box launchers on both sides amidships and close-in gun domes by the tower
    for (const s of [-1, 1]) out.push(...boxLauncher(-6, s > 0 ? 3.6 : -5.8, -0.6, s > 0 ? 5.8 : -3.6, H), ...radome(3.4, s * 4.6, H, 1.2));
  }
  // aft: X raised over Y (the refit swaps X for a big block of vertical launch cells)
  if (modern) out.push(...vls(-16, -3.6, -9.4, 3.6, H, 2, 2.4));
  else out.push(ell(-12.8, 0, 4.5, 4.1, H, 1.6, 'black'), ...T(-12.8, H + 1.6, -1));
  out.push(...T(-18.6, H, -1, 5.4));
  if (mods & M_SPECIAL) out.push(...mineRails(-23.2, 5, 3.2, 5.2, H, 1, -L + 0.2));
  const m1 = muzzles(14.2, H, 1, tl, tw, th, 3, tb, tbw);
  const m2 = muzzles(7.8, H + 1.6, 1, tl, tw, th, 3, tb, tbw);
  const m4 = muzzles(-18.6, H, -1, tl, tw, th, 3, 5.4, tbw);
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
  // a swirl at the stern, a lighter casing along the top, a deck gun forward and the big raised sail (conning tower)
  // in the middle, a step lighter than the hull with a dark shadow side, its top the owner panel. With Naval Mastery
  // it is a nuclear boat: a longer smooth teardrop hull and a tall sail set forward with wide fin planes on it, a
  // rudder fin and planes at the tail.
  const nuke = !!(mods & M_MASTERY);
  const out: Part[] = [];
  if (nuke) {
    out.push(
      poly(teardrop(13.9, -13.7, 2.8), 0, 0, 'foam', { a: 0.75 }),
      seg(13.4, -0.3, 10, -2.9, 0.6, 0, 0, 'foam', { a: 0.85 }),
      seg(13.4, 0.3, 10, 2.9, 0.6, 0, 0, 'foam', { a: 0.85 }),
      ell(-14, 0, 1.8, 1.1, 0, 0, 'foam', { a: 0.6 }),
      poly(teardrop(13, -13, 2.1), 0, 0.65, 'sub', { sh: 'cyl', sc: [0, 0, 13, 2.1] }),
      // the casing's lit top
      seg(-9, 0, 11.4, 0, 1, 0.65, 0.05, 'hullDark', { tone: -1 }),
      // the sea washing over the long tail
      poly(sym([-6, 0, -7, -1.6, -11.6, -0.9, -13, 0]), 0.7, 0, 'sea', { a: 0.3 }),
      // the tail: planes across and the rudder fin standing up
      seg(-11.4, -2.6, -11.4, 2.6, 0.8, 0.35, 0.2, 'hullDark'),
      box(-12.8, -0.25, -10.4, 0.25, 0.6, 1.6, 'hullDark'),
      // the tall sail set forward, wide fin planes out to both sides, the owner panel on top, masts
      poly(sym([9.6, 0, 8.9, -1.05, 4.6, -1.05, 3.9, 0]), 0.6, 3.6, 'hull'),
      seg(7.4, -3.2, 7.4, 3.2, 1, 2.8, 0.25, 'hull'),
      box(4.8, -0.6, 6.6, 0.6, 4.2, 0, 'own'),
      ell(6.2, 0, 0.3, 0.3, 4.2, 1.4, 'gun'),
    );
  } else {
    out.push(
      // the white water round the hull where it breaks the surface, the bow wave and a swirl at the stern
      ell(0.2, 0, 12.6, 2.5, 0, 0, 'foam', { a: 0.75 }),
      seg(12.4, -0.2, 9.4, -2.6, 0.6, 0, 0, 'foam', { a: 0.85 }),
      seg(12.4, 0.2, 9.4, 2.6, 0.6, 0, 0, 'foam', { a: 0.85 }),
      ell(-12.6, 0, 1.6, 1, 0, 0, 'foam', { a: 0.6 }),
      ell(0, 0, 12, 2, 0, 0.6, 'sub', { sh: 'cyl' }),
      // the flat deck casing along the top, lighter
      seg(-8.5, 0, 9, 0, 1.2, 0.6, 0.1, 'hullDark', { tone: -1 }),
      // the bow and stern awash: the sea running over them
      poly(sym([11.6, 0, 11, -1.4, 7.6, -1.9, 6.8, 0]), 0.75, 0, 'sea', { a: 0.3 }),
      poly(sym([-6, 0, -6.8, -1.9, -11, -1.4, -11.6, 0]), 0.75, 0, 'sea', { a: 0.3 }),
      // stern planes
      seg(-10.4, -2.3, -10.4, 2.3, 0.6, 0.3, 0.15, 'hullDark'),
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
 * A small plane parked on a flight deck at (u, v), its nose turned `ang` radians from the bow (toward starboard), its
 * wings spread `span` units each side. `jet`: a swept-wing jet with twin fins, no prop. Pale on the dark deck.
 */
function parked(u: number, v: number, z: number, ang: number, span = 2, jet = false): Part[] {
  const c = Math.cos(ang);
  const s = Math.sin(ang);
  const P = (a: number, b: number): [number, number] => [u + a * c - b * s, v + a * s + b * c];
  if (jet)
    return [
      seg(...P(2.6, 0), ...P(-2.4, 0), 1, z, 0.55, 'alu', { tone: -1 }),
      poly([...P(0.9, -0.4), ...P(-1.1, -span - 0.3), ...P(-1.9, -span - 0.3), ...P(-1.3, -0.4), ...P(-1.3, 0.4), ...P(-1.9, span + 0.3), ...P(-1.1, span + 0.3), ...P(0.9, 0.4)], z + 0.2, 0.25, 'alu', { tone: -1 }),
    ];
  return [
    seg(...P(2, 0), ...P(-2, 0), 1, z, 0.55, 'seagrey', { tone: 1 }),
    poly([...P(1.1, -span), ...P(1.1, span), ...P(-0.1, span), ...P(-0.1, -span)], z + 0.2, 0.25, 'seagrey', { tone: 1 }),
    seg(...P(-1.6, -1), ...P(-1.6, 1), 0.7, z + 0.2, 0.25, 'seagrey', { tone: 1 }),
  ];
}

/** The carrier is laid out on a 54 long frame and drawn this much longer and wider (60 long, its deck 14.2 wide). */
const CU = CL / 27;
const CV = 1.1;

export function carrier(mods: number): UnitModel {
  // the biggest: 60 long on a broad flight deck (about four times as long as wide) in dark weathered steel over dark
  // hull sides, a light edge round the deck, the angled landing deck reaching out over a sponson to port with its
  // white edge line, the tall light island on the starboard side (its funnel band the owner colour), a few pale
  // planes parked along the starboard edge clear of the landing area and one on the bow catapult. The deck's plates,
  // tyre marks and sparse worn markings are its pattern (carrierDeck.ts). Laid out at 54 long (L 27) and stretched to
  // the real size at the end. With Naval Mastery it is a supercarrier: the angled deck's sponson reaches further out,
  // the island carries a big white radar dome, jets sit on deck in place of the propeller planes, missile launchers
  // stand at the corners.
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
  out.push(poly(deck, D, 0.2, 'sup', { edge: true, tone: -1 }));
  // the island on the starboard side: one tall light block (so its lit roof and shadow side read at mid zoom), the
  // bridge on it with its windows, a big raked funnel with the owner band, the mast
  out.push(box(-8.4, 3.4, 3.2, 6.7, D, 3.8, 'sup', { tone: 1 }), box(2.85, 3.45, 3.2, 6.65, D + 3.8, 0, 'glass'));
  out.push(box(-0.4, 3.9, 2.6, 6.2, D + 3.8, 1.2, 'sup', { tone: 1 }), box(2.25, 3.95, 2.6, 6.15, D + 5, 0, 'glass'));
  out.push(...moved(funnel(-4.2, 1.7, 1.1, D + 3.8, 2.4, 0.9, true, 'sup', 1), 0, 5.05));
  if (modern) out.push(...moved(radarMast(1, D + 5, 1.6, 1.3, 1.5), 0, 5.05));
  else out.push(...moved(mast(1, D + 5, 3, 1.3), 0, 5.05));
  // planes: one on the bow catapult with its wings spread, three parked on the starboard bow, two aft of the island
  out.push(...parked(L - 4.6, -1.4, D, -0.05, 2.2, modern));
  for (const u of [21.2, 16.8]) out.push(...parked(u, 2.9, D, -1.1, 1.6, modern));
  for (const u of [-14.6, -19]) out.push(...parked(u, 3.4, D, -1, 1.6, modern));
  if (modern) {
    // the supercarrier's launchers and launch cells at the corners
    out.push(...vls(15.4, -7.4, 19.6, -5.2, H + 0.2, 2, 2.2), ...vls(13.2, 5.3, 17.4, 7.5, H + 0.2, 2, 2.2));
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
