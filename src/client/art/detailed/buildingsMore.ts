// The other twelve map buildings in the same style as the fort, city, SAM site and port (buildings.ts): part models seen
// from above at a high camera, run through the game's own unit rasterizer, a muted miniature palette with the owner's
// colour on flags, bands, awnings and trim, shaped roofs (no plain boxes), and a land-tinted ground that carries each
// building into the terrain. farm, market, mine, oil well, barracks, factory, arsenal, watchtower, lab, hospital,
// airfield and missile silo. Every type has one clear shape of its own so it reads at normal zoom. Art in code only.
import type { Part } from './bake';
import { acUnit, barrel, band, chimney, flag, footBox, gable, hip, house, hash, moved, skylight, tree, type Ground, type Mat } from './buildings';
import { box as bx, ell as el, poly, seg } from './shapes';

export type MoreType = 'farm' | 'market' | 'mine' | 'oilWell' | 'barracks' | 'factory' | 'arsenal' | 'watchtower' | 'lab' | 'hospital' | 'airfield' | 'silo';
export const MORE_TYPES: readonly MoreType[] = ['farm', 'market', 'mine', 'oilWell', 'barracks', 'factory', 'arsenal', 'watchtower', 'lab', 'hospital', 'airfield', 'silo'];
export const isMoreType = (t: string): t is MoreType => (MORE_TYPES as readonly string[]).includes(t);

// ------------------------------------------------------------------------------------------------- small shared pieces

/** A chain-link fence round a rectangle (a gap on the south side from gu0 to gu1), with a post at every corner and gate. */
function fence(u0: number, v0: number, u1: number, v1: number, gap?: [number, number], hz = 1.7): Part[] {
  const P: Part[] = [];
  const t = 0.45;
  const wall = (a: number, b: number, c: number, d: number): void => {
    P.push(bx(a, b, c, d, 0, hz, 'sup', { tone: 0.2, pat: 'grille' }));
  };
  wall(u0, v0, u1, v0 + t);
  wall(u0, v0, u0 + t, v1);
  wall(u1 - t, v0, u1, v1);
  if (gap) {
    wall(u0, v1 - t, gap[0], v1);
    wall(gap[1], v1 - t, u1, v1);
  } else wall(u0, v1 - t, u1, v1);
  const posts: [number, number][] = [[u0, v0], [u1, v0], [u0, v1], [u1, v1]];
  if (gap) posts.push([gap[0], v1], [gap[1], v1]);
  for (const [pu, pv] of posts) P.push(el(pu, pv, 0.7, 0.7, 0, hz + 0.7, 'gun', { sh: 'cyl', tone: 0.6 }));
  return P;
}
/** A small truck facing east: wheels under a body, a cab with a glass front, an owner stripe. */
function truck(u: number, v: number, body: Mat = 'olive', len = 9): Part[] {
  return [
    bx(u + 0.8, v - 0.2, u + len - 0.8, v + 4.2, 0, 0.9, 'track'),
    bx(u, v, u + len - 3, v + 4, 0.9, 2.4, body, { tone: 0.1 }),
    bx(u + len - 3, v + 0.2, u + len, v + 3.8, 0.9, 1.9, body, { tone: 0.5 }),
    bx(u + len - 1.2, v + 0.6, u + len - 0.5, v + 3.4, 2.7, 0, 'glass'),
    bx(u + 0.4, v + 3.4, u + len - 3.4, v + 4, 3.3, 0, 'own'),
  ];
}
/** A shipping container. */
const crate = (u: number, v: number, col: Mat, z = 0): Part => bx(u, v, u + 5.6, v + 2.4, z, 2.2, col, { pat: 'ribs', tone: 0.1 });
/** A round storage tank: a white cylinder with a domed roof and a stripe of the owner's colour. */
function tank(u: number, v: number, r: number, h: number, mat: Mat = 'white'): Part[] {
  return [el(u, v, r, r * 0.92, 0, h, mat, { sh: 'cyl', tone: 0 }), el(u, v, r * 1.03, r * 0.95, h * 0.55, 0.9, 'own', { sh: 'cyl', tone: 0 }), el(u, v, r * 0.92, r * 0.84, h, 1.2, 'alu', { sh: 'dome', tone: 0.3 })];
}
/** A parked light plane seen from above, nose to the east: a long fuselage, swept wings with roundels, a tail. */
function plane(u: number, v: number, s = 1): Part[] {
  return [
    poly([u + 2 * s, v - 1 * s, u - 1.6 * s, v - 1 * s, u - 4.8 * s, v - 6.8 * s, u - 2.6 * s, v - 6.8 * s], 1.3, 0.55, 'alu', { tone: -0.1 }),
    poly([u + 2 * s, v + 1 * s, u - 1.6 * s, v + 1 * s, u - 4.8 * s, v + 6.8 * s, u - 2.6 * s, v + 6.8 * s], 1.3, 0.55, 'alu', { tone: -0.1 }),
    poly([u - 5.2 * s, v - 0.8 * s, u - 7.4 * s, v - 0.8 * s, u - 8.4 * s, v - 3.4 * s, u - 7 * s, v - 3.4 * s], 1.6, 0.4, 'alu', { tone: -0.2 }),
    poly([u - 5.2 * s, v + 0.8 * s, u - 7.4 * s, v + 0.8 * s, u - 8.4 * s, v + 3.4 * s, u - 7 * s, v + 3.4 * s], 1.6, 0.4, 'alu', { tone: -0.2 }),
    el(u - 0.6 * s, v, 7.6 * s, 1.25 * s, 0.9, 1.9 * s, 'alu', { sh: 'cyl', tone: 0.1 }),
    el(u + 3.4 * s, v, 1.5 * s, 0.9 * s, 2.5, 0.9, 'glass', { sh: 'dome', tone: 0.3 }),
    el(u - 3.1 * s, v - 4.2 * s, 0.9 * s, 0.9 * s, 1.85, 0, 'own'),
    el(u - 3.1 * s, v + 4.2 * s, 0.9 * s, 0.9 * s, 1.85, 0, 'own'),
    el(u - 7.2 * s, v, 0.9 * s, 0.9 * s, 1.8, 0, 'own'),
  ];
}
/** A thin pole with a flag in the owner's colour (a shorter, plainer one for yards). */
const pole = (u: number, v: number, z: number, h: number): Part[] => [el(u, v, 0.3, 0.3, z, h, 'gun', { sh: 'cyl', tone: 1 })];
/** Flat ground marking boxes laid in a row along u (runway dashes, parking lines). */
function dashes(u0: number, u1: number, v: number, w: number, d: number, step: number, m: Mat = 'paint', z = 0): Part[] {
  const P: Part[] = [];
  for (let u = u0; u + w <= u1; u += step) P.push(bx(u, v - d / 2, u + w, v + d / 2, z, 0, m, { tone: 0.2 }));
  return P;
}

// ------------------------------------------------------------------------------------------------- farm

/** A strip field (ploughed, ripening or green), furrows running along its length. */
function field(u0: number, v0: number, u1: number, v1: number, i: number): Part[] {
  const mats: [Mat, number][] = [['tan', -0.9], ['ochre', 0.1], ['olive', 0.2], ['ochre', -0.5]];
  const [m, t] = mats[i % 4];
  return [bx(u0, v0, u1, v1, 0, 0, m, { tone: t, pat: 'planks' }), bx(u0, v1 - 0.5, u1, v1, 0, 0, 'tan', { tone: -1.2 })];
}
function barn(u: number, v: number, w: number, d: number, h: number): Part[] {
  return [
    bx(u, v, u + w, v + d, 0, h, 'brick', { tone: -0.2 }),
    ...gable(u, v, u + w, v + d, h, 'rust', { rh: d * 0.32, over: 0.7, metal: true, alongU: true }),
    band(u + 1, v + d * 0.5 - 0.5 + d * 0.5 * 0.0, u + w - 1, v + d * 0.5 + 0.5, h + d * 0.32 + 0.3),
    bx(u + w * 0.4, v + d, u + w * 0.6, v + d + 0.2, 0, h * 0.8, 'ochre', { tone: -0.3 }),
  ];
}
function grainSilo(u: number, v: number, r: number, h: number): Part[] {
  return [el(u, v, r, r * 0.92, 0, h, 'alu', { sh: 'cyl', tone: 0.1 }), el(u, v, r * 1.02, r * 0.94, h * 0.45, 0.7, 'sup', { sh: 'cyl', tone: -0.1 }), el(u, v, r * 0.98, r * 0.9, h, r * 0.9, 'own', { sh: 'dome', tone: 0.2 })];
}
function tractor(u: number, v: number): Part[] {
  return [bx(u, v + 0.2, u + 4.6, v + 3.4, 0, 1.2, 'track', { tone: 0.2 }), bx(u + 0.4, v + 0.9, u + 3.6, v + 2.7, 1.2, 1.7, 'olive', { tone: 0.5 }), bx(u + 2.2, v + 1.0, u + 3.6, v + 2.6, 2.9, 0.8, 'glass', { tone: 0.3 }), bx(u + 3.6, v + 1.2, u + 5.2, v + 2.4, 0.8, 1.0, 'olive', { tone: 0.2 }), el(u + 1.2, v + 0.3, 1.0, 0.4, 0.4, 1.6, 'gun', { sh: 'cyl', tone: 0.3 }), bx(u + 0.4, v + 2.9, u + 3.2, v + 3.2, 2.6, 0, 'own')];
}
function greenhouse(u: number, v: number, w: number, d: number): Part[] {
  return [bx(u, v, u + w, v + d, 0, 1.2, 'sup', { tone: 0.3 }), bx(u + 0.3, v + 0.3, u + w - 0.3, v + d - 0.3, 1.2, 1.2, 'glass', { tone: 0.5, pat: 'frames' }), bx(u + 0.5, v + d / 2 - 0.25, u + w - 0.5, v + d / 2 + 0.25, 2.4, 0.3, 'sup', { tone: 0.5 })];
}
function farmModel(lv: number): Part[] {
  const P: Part[] = [];
  if (lv >= 5) {
    for (let i = 0; i < 4; i++) P.push(...field(-26, -18 + i * 5.4, -2, -13.2 + i * 5.4, i));
    for (let i = 0; i < 3; i++) P.push(...field(-26, 4 + i * 5.2, -2, 8.8 + i * 5.2, i + 1));
    P.push(...barn(3, -16, 17, 10, 4.6), ...barn(3, 1, 11, 7, 3.6), ...grainSilo(25, -12, 3.0, 13), ...grainSilo(25, -4.6, 3.0, 11), ...grainSilo(18, 7.4, 2.4, 9));
    P.push(...house(2, 11, 9, 16, 2.6, 'brick', 'cream', { chim: 0.7 }), ...greenhouse(13, 10.4, 9, 5.4), ...tractor(-1, 14.4));
    for (const [u, v] of [[-25, -19], [27.5, 6], [24, 14.5]]) P.push(...tree(u, v, 2.4, u));
    P.push(...pole(11.3, -4.2, 0, 0.1), bx(0.4, 8.6, 1.8, 9.9, 0, 1.3, 'ochre', { tone: 0.3, sh: 'dome' }));
  } else if (lv >= 3) {
    for (let i = 0; i < 3; i++) P.push(...field(-24, -15 + i * 5.4, -2, -10.2 + i * 5.4, i));
    for (let i = 0; i < 2; i++) P.push(...field(-24, 2 + i * 5.2, -2, 6.8 + i * 5.2, i + 1));
    P.push(...barn(3, -13, 15, 9, 4.2), ...grainSilo(22.5, -9.4, 2.8, 12), ...house(3, 0.4, 9.4, 5.4, 2.6, 'brick', 'cream', { chim: 0.6 }), ...tractor(11, 7));
    for (const [u, v] of [[-26, -17], [20, 4]]) P.push(...tree(u, v, 2.2, u));
    P.push(el(15.2, 2.2, 1.6, 1.2, 0, 2.0, 'ochre', { sh: 'dome', tone: 0.3 }));
  } else {
    for (let i = 0; i < 2; i++) P.push(...field(-20, -12 + i * 5.4, -2, -6.6 + i * 5.4, i));
    P.push(...field(-20, 0, -2, 5, 2));
    P.push(...barn(3, -11, 12, 8, 3.6), ...house(3, 0, 8.6, 4.6, 2.4, 'brick', 'cream', { chim: 0.6 }), el(14, 3, 1.7, 1.3, 0, 2.2, 'ochre', { sh: 'dome', tone: 0.3 }), ...tree(-22, -14, 2.2, 3), ...tree(12, 9, 2, 5));
  }
  return P;
}

// ------------------------------------------------------------------------------------------------- market

function stall(u: number, v: number, w: number, d: number, col: Mat, alongU: boolean): Part[] {
  const P: Part[] = [bx(u, v, u + w, v + d, 0, 1.3, 'teak', { pat: 'planks' })];
  const n = 4;
  for (let i = 0; i < n; i++) {
    const c: Mat = i % 2 ? 'white' : col;
    if (alongU) P.push(bx(u - 0.4 + (i * (w + 0.8)) / n, v - 1.0, u - 0.4 + ((i + 1) * (w + 0.8)) / n, v + d + 0.5, 2.7, 0.5, c, { tone: i % 2 ? 0.2 : 0.1 }));
    else P.push(bx(u - 0.5, v - 0.4 + (i * (d + 0.8)) / n, u + w + 1.0, v - 0.4 + ((i + 1) * (d + 0.8)) / n, 2.7, 0.5, c, { tone: i % 2 ? 0.2 : 0.1 }));
  }
  for (const [pu, pv] of [[u, v], [u + w, v], [u, v + d], [u + w, v + d]]) P.push(el(pu, pv, 0.3, 0.3, 0, 2.7, 'gun', { sh: 'cyl', tone: 0.5 }));
  P.push(bx(u + w * 0.2, v + d * 0.25, u + w * 0.45, v + d * 0.7, 1.3, 0.6, 'ochre', { tone: 0.4 }), bx(u + w * 0.55, v + d * 0.3, u + w * 0.8, v + d * 0.7, 1.3, 0.6, 'brick', { tone: 0.3 }));
  return P;
}
const AWN: Mat[] = ['own', 'fadedBlue', 'own', 'ochre', 'own', 'brick'];
function marketHall(u0: number, v0: number, u1: number, v1: number, h: number, tower: boolean): Part[] {
  const P: Part[] = [bx(u0, v0, u1, v1, 0, h, 'cream', { tone: -0.3 }), ...gable(u0, v0, u1, v1, h, 'rust', { rh: 3, over: 0.7, alongU: true }), band(u0 + 1, (v0 + v1) / 2 - 0.5, u1 - 1, (v0 + v1) / 2 + 0.5, h + 3.3)];
  for (let u = u0 + 2; u < u1 - 2; u += 3.4) P.push(bx(u, v1, u + 1.8, v1 + 0.2, 0, h * 0.7, 'black', { tone: 0.6 }));
  if (tower) {
    const tu = (u0 + u1) / 2;
    P.push(bx(tu - 2, v0 + 0.4, tu + 2, v0 + 4.4, h, 6, 'cream', { tone: -0.2 }), ...hip(tu - 2, v0 + 0.4, tu + 2, v0 + 4.4, h + 6, 'fadedBlue', { rh: 3.6, over: 0.4 }), el(tu, v0 + 2.4, 0.9, 0.9, h + 9.7, 2.2, 'brass', { sh: 'cyl', tone: 0.3 }), ...flag(tu + 0.2, v0 + 2.4, h + 11.8, 4, 3.4));
  }
  return P;
}
function marketModel(lv: number): Part[] {
  const P: Part[] = [];
  const hw = lv >= 5 ? 20 : lv >= 3 ? 17 : 14;
  const hd = lv >= 5 ? 11 : lv >= 3 ? 9 : 7;
  // the square: a paved plaza with a fountain in its middle
  P.push(bx(-hw - 2, -hd - 2, hw + 2, hd + 2, 0, 0, 'tan', { tone: 0.5, pat: 'hatches' }), bx(-hw - 2, -hd - 2, hw + 2, hd + 2, 0, 0.3, 'tan', { tone: 0.1, edge: true }));
  P.push(el(0, 0, 3.4, 2.9, 0, 0.9, 'sup', { sh: 'cyl', tone: 0.3 }), el(0, 0, 2.5, 2.1, 0.9, 0, 'sea'), el(0, 0, 0.7, 0.6, 0.9, 1.6, 'sup', { sh: 'cyl', tone: 0.5 }));
  // stalls ringing the square, awnings facing inward
  const n = lv >= 5 ? 5 : lv >= 3 ? 4 : 3;
  const sw = 5.6;
  let k = 0;
  for (let i = 0; i < n; i++) {
    const u = -hw + 1 + (i * (2 * hw - 2 - sw)) / Math.max(1, n - 1);
    P.push(...stall(u, hd - 3.4, sw, 3, AWN[k++ % AWN.length], true));
    if (lv >= 3 || i % 2 === 0) P.push(...stall(u, -hd - 0.6, sw, 3, AWN[k++ % AWN.length], true));
  }
  const m = lv >= 5 ? 3 : lv >= 3 ? 2 : 1;
  for (let i = 0; i < m; i++) {
    const v = -hd + 5.4 + (i * (2 * hd - 11)) / Math.max(1, m - 1) - (m === 1 ? -((hd - 5.4) * 0.0) : 0);
    P.push(...stall(-hw - 0.5, v - 1.5, 3, 5.6, AWN[k++ % AWN.length], false), ...stall(hw - 2.6, v - 1.5, 3, 5.6, AWN[k++ % AWN.length], false));
  }
  // crates, barrels and a hand cart on the square
  P.push(bx(-6, 3.4, -4, 5, 0, 1.2, 'teak', { pat: 'planks' }), bx(-5.4, 3.7, -4.4, 4.7, 1.2, 1, 'teak', { pat: 'planks', tone: 0.3 }), el(6.4, 3.6, 0.9, 0.9, 0, 1.4, 'rust', { sh: 'cyl', tone: 0.2 }), el(8.2, 3.9, 0.9, 0.9, 0, 1.4, 'rust', { sh: 'cyl', tone: -0.1 }));
  if (lv >= 3) {
    P.push(...marketHall(-hw - 2, -hd - 12, hw * 0.35, -hd - 3.6, 3.6, lv >= 5));
    P.push(...flag(hw + 2.4, -hd - 1, 0, 9, 4.2));
  } else P.push(...flag(hw + 2.2, -hd - 1, 0, 7, 3.4));
  if (lv >= 5) {
    P.push(...marketHall(hw * 0.5, -hd - 12, hw + 2, -hd - 3.6, 3, false), ...flag(-hw - 2.4, hd + 1, 0, 8, 4));
    P.push(...tree(-hw - 4, -3, 2.2, 1), ...tree(hw + 4.4, 3, 2.2, 2));
  }
  return P;
}

// ------------------------------------------------------------------------------------------------- mine

function headframe(u: number, v: number, s: number): Part[] {
  const P: Part[] = [];
  P.push(bx(u - 3.4 * s, v - 3 * s, u + 3.4 * s, v + 3 * s, 0, 5 * s, 'gun', { tone: 0.4, pat: 'grille' }));
  P.push(bx(u - 2.6 * s, v - 2.2 * s, u + 2.6 * s, v + 2.2 * s, 5 * s, 5 * s, 'gun', { tone: 0.5, pat: 'grille' }));
  P.push(bx(u - 1.8 * s, v - 1.5 * s, u + 1.8 * s, v + 1.5 * s, 10 * s, 5 * s, 'gun', { tone: 0.6, pat: 'grille' }));
  // posts at the corners of the lowest tier so it reads as a lattice
  for (const [a, b] of [[-3.4, -3], [3.4, -3], [-3.4, 3], [3.4, 3]]) P.push(el(u + a * s, v + b * s, 0.5 * s, 0.5 * s, 0, 5 * s, 'rust', { sh: 'cyl', tone: 0.3 }));
  // the winding wheel: a big dark sheave in the owner's colour rim over the top
  P.push(seg(u - 3 * s, v, u + 3 * s, v, 1.2 * s, 15 * s, 0.6 * s, 'gun'), el(u - 1.5 * s, v, 2.5 * s, 2.5 * s, 15.6 * s, 0.9 * s, 'own', { sh: 'cyl', tone: 0.2 }), el(u - 1.5 * s, v, 1.3 * s, 1.3 * s, 16.5 * s, 0.4, 'gun', { tone: 0.2 }), el(u + 1.6 * s, v, 1.6 * s, 1.6 * s, 15.6 * s, 0.9 * s, 'gun', { sh: 'cyl', tone: 0.4 }));
  return P;
}
function heap(u: number, v: number, ru: number, rv: number, h: number, mat: Mat = 'tan', lift = 0): Part[] {
  return [el(u, v, ru, rv, 0, h, mat, { sh: 'dome', tone: -0.4 + lift }), el(u - ru * 0.2, v - rv * 0.18, ru * 0.62, rv * 0.6, h * 0.55, h * 0.45, mat, { sh: 'dome', tone: 0.3 + lift }), el(u - ru * 0.35, v - rv * 0.3, ru * 0.25, rv * 0.25, h * 0.9, h * 0.2, 'fieldgrey', { sh: 'dome', tone: 0.9 })];
}
function cart(u: number, v: number, own = false): Part[] {
  return [bx(u, v, u + 3.6, v + 2.6, 0.5, 1.5, own ? 'rust' : 'rust', { tone: -0.2 }), el(u + 1.8, v + 1.3, 1.4, 1.0, 1.9, 0.9, 'black', { sh: 'dome', tone: 0.4 }), bx(u + 0.2, v + 0.1, u + 3.4, v + 0.5, 1.9, 0, 'own')];
}
function rails(u0: number, v0: number, u1: number, v1: number): Part[] {
  const P: Part[] = [];
  const L = Math.hypot(u1 - u0, v1 - v0);
  const nu = -(v1 - v0) / L;
  const nv = (u1 - u0) / L;
  for (const o of [-1, 1]) P.push(seg(u0 + nu * o, v0 + nv * o, u1 + nu * o, v1 + nv * o, 0.5, 0, 0.45, 'gun', { tone: 0.5 }));
  for (let t = 0.5; t < L; t += 2) P.push(seg(u0 + ((u1 - u0) * t) / L + nu * 1.5, v0 + ((v1 - v0) * t) / L + nv * 1.5, u0 + ((u1 - u0) * t) / L - nu * 1.5, v0 + ((v1 - v0) * t) / L - nv * 1.5, 0.5, 0, 0.2, 'teak'));
  return P;
}
function mineModel(lv: number): Part[] {
  const P: Part[] = [];
  if (lv >= 5) {
    P.push(...heap(-17, -9, 9, 6.4, 7.6), ...heap(-8, 9.6, 8, 5.6, 6, 'fieldgrey', 0.5), ...heap(22, 8, 6.4, 5, 5));
    P.push(...rails(-14, 1.4, 17, 1.4), ...cart(-6, -0.6), ...cart(-1.6, -0.6), ...cart(2.8, -0.6, true));
    P.push(...headframe(8, -9, 1.35), ...headframe(19, -9, 1.0));
    P.push(bx(2, -2.6, 11, 4, 0, 3.4, 'cream', { tone: -0.3 }), ...gable(2, -2.6, 11, 4, 3.4, 'rust', { rh: 1.8, over: 0.5, metal: true }), ...chimney(9, -1.8, 3.4, 4));
    P.push(bx(13, -2, 25, 7, 0, 3, 'fieldgrey', { tone: 0.2, pat: 'grille' }), ...gable(13, -2, 25, 7, 3, 'cargo', { rh: 1.5, over: 0.4, metal: true }), seg(-6, -4, 12, -4, 1.2, 4.6, 0.5, 'gun'));
    P.push(...tree(-26, 3, 2.2, 3), ...tree(30, -5, 2.2, 4));
  } else if (lv >= 3) {
    P.push(...heap(-15, -8, 8, 5.8, 6.4), ...heap(-6, 9, 7, 5, 5, 'fieldgrey', 0.5));
    P.push(...rails(-13, 1.4, 14, 1.4), ...cart(-5, -0.6), ...cart(-0.6, -0.6, true));
    P.push(...headframe(8, -10, 1.15));
    P.push(bx(15, -4, 24, 3.6, 0, 3.2, 'cream', { tone: -0.3 }), ...gable(15, -4, 24, 3.6, 3.2, 'rust', { rh: 1.8, over: 0.5, metal: true }), ...chimney(22, -3.2, 3.2, 3.6));
    P.push(...tree(-24, 4, 2.2, 3));
  } else {
    P.push(...heap(-13, -6, 7, 5, 5.2));
    P.push(...rails(-11, 3, 9, 3), ...cart(-4, 1));
    P.push(...headframe(6, -8, 0.95));
    P.push(bx(12, -6, 19, 0, 0, 3, 'cream', { tone: -0.3 }), ...gable(12, -6, 19, 0, 3, 'rust', { rh: 1.6, over: 0.5, metal: true }));
  }
  // the adit: a timbered black mouth at the foot of the track
  P.push(bx(-16, lv >= 5 ? -0.2 : lv >= 3 ? 0.2 : 1.8, -12, lv >= 5 ? 3 : lv >= 3 ? 3.4 : 4.6, 0, 2.4, 'teak', { tone: -0.2, pat: 'planks' }), bx(-15.4, lv >= 5 ? 0.4 : lv >= 3 ? 0.8 : 2.4, -12.6, lv >= 5 ? 2.4 : lv >= 3 ? 2.8 : 4, 0, 2.0, 'black', { tone: 0.3 }));
  return P;
}

// ------------------------------------------------------------------------------------------------- oil well

function pumpjack(u: number, v: number, s: number, ph = 0): Part[] {
  const P: Part[] = [];
  P.push(bx(u - 5.2 * s, v - 2.6 * s, u + 5.6 * s, v + 2.6 * s, 0, 0.9, 'sup', { tone: -0.3 }));
  // the samson post, the walking beam in the owner's colour, horse head, counterweight, motor
  P.push(bx(u - 0.9 * s, v - 0.9 * s, u + 0.9 * s, v + 0.9 * s, 0.9, 5.4 * s, 'gun', { tone: 0.5, pat: 'grille' }), seg(u - 4.8 * s, v + ph, u + 4.6 * s, v - ph, 1.3 * s, 6.3 * s, 1.0 * s, 'own', { tone: 0.2 }));
  P.push(el(u - 5.0 * s, v + ph, 1.7 * s, 1.5 * s, 5.8 * s, 1.8 * s, 'gun', { sh: 'dome', tone: 0.5 }), el(u + 4.2 * s, v - ph, 1.9 * s, 1.5 * s, 3.6 * s, 3.4 * s, 'gun', { sh: 'cyl', tone: 0.4 }), seg(u + 3.4 * s, v - ph, u + 3.4 * s, v - ph, 0.7, 0.9, 2.8 * s, 'gun'));
  P.push(bx(u + 0.8 * s, v + 1.2 * s, u + 4 * s, v + 2.4 * s, 0.9, 1.6, 'olive', { tone: 0.3 }), el(u - 4.6 * s, v + 1.6 * s, 0.6, 0.6, 0.9, 0.7, 'rust', { sh: 'cyl' }));
  return P;
}
function pipe(u0: number, v0: number, u1: number, v1: number): Part[] {
  return [seg(u0, v0, u1, v1, 0.9, 0.5, 0.9, 'rust', { sh: 'cyl', tone: 0.2 }), el(u1, v1, 0.9, 0.9, 0.4, 1.3, 'rust', { sh: 'cyl', tone: 0.5 })];
}
function oilModel(lv: number): Part[] {
  const P: Part[] = [];
  if (lv >= 5) {
    P.push(...pumpjack(-15, -10, 1.1, 0.5), ...pumpjack(-15, 4, 1.1, -0.4), ...pumpjack(-4, 14, 1.1, 0.3));
    P.push(...tank(10, -9, 5, 6), ...tank(22, -9, 5, 6), ...tank(10, 3, 5, 6), ...tank(22, 3, 5, 6), ...tank(32, -3, 3.6, 4.6));
    P.push(...pipe(-9, -10, 5, -9), ...pipe(-9, 4, 5, 3), ...pipe(5, -9, 5, 3), ...pipe(15, -9, 17, -9), ...pipe(15, 3, 17, 3), ...pipe(27, -4, 28, -4));
    // the flare stack with a burning tip
    P.push(el(-25, 12, 0.6, 0.6, 0, 18, 'gun', { sh: 'cyl', tone: 0.6 }), el(-25, 12, 1.1, 1.1, 18, 0.6, 'own', { sh: 'cyl' }), el(-25, 11, 1.3, 1.5, 18.6, 3.4, 'flame', { sh: 'dome', glow: true }));
    P.push(bx(12, 12, 24, 19, 0, 2.8, 'cream', { tone: -0.3 }), ...gable(12, 12, 24, 19, 2.8, 'fieldgrey', { rh: 1.4, over: 0.4, metal: true }), ...truck(-2, 15, 'cargo', 11));
  } else if (lv >= 3) {
    P.push(...pumpjack(-14, -8, 1.0, 0.45), ...pumpjack(-14, 6, 1.0, -0.35));
    P.push(...tank(9, -8, 4.6, 5.4), ...tank(20, -8, 4.6, 5.4), ...tank(15, 4, 4.6, 5.4));
    P.push(...pipe(-9, -8, 4, -8), ...pipe(-9, 6, 10, 5), ...pipe(4, -8, 4, 5), ...pipe(14, -8, 15.4, -8));
    P.push(bx(-4, 12, 8, 17, 0, 2.6, 'cream', { tone: -0.3 }), ...gable(-4, 12, 8, 17, 2.6, 'fieldgrey', { rh: 1.3, over: 0.4, metal: true }), ...truck(14, 12, 'cargo', 10));
  } else {
    P.push(...pumpjack(-10, -2, 1.0, 0.45));
    P.push(...tank(12, -4, 4.8, 5.6), ...tank(12, 8, 3.6, 4.2));
    P.push(...pipe(-4, -2, 8, -4), ...pipe(8, -4, 8, 7), ...pipe(8, 7, 9.4, 8));
    P.push(bx(-4, 8, 4, 13, 0, 2.4, 'cream', { tone: -0.3 }), ...gable(-4, 8, 4, 13, 2.4, 'fieldgrey', { rh: 1.2, over: 0.4, metal: true }));
  }
  return P;
}

// ------------------------------------------------------------------------------------------------- barracks

function hut(u: number, v: number, w: number, d: number): Part[] {
  const P: Part[] = [bx(u, v, u + w, v + d, 0, 2.4, 'canvas', { tone: -0.3 }), ...gable(u, v, u + w, v + d, 2.4, 'olive', { rh: d * 0.34, over: 0.5, metal: true, alongU: true })];
  P.push(band(u + 0.6, v + d * 0.5 - 0.4, u + w - 0.6, v + d * 0.5 + 0.4, 2.4 + d * 0.34 + 0.3));
  for (let x = u + 2; x < u + w - 2.4; x += 3.2) P.push(bx(x, v + d, x + 1.4, v + d + 0.2, 0.4, 1.4, 'glass', { tone: 0.3 }));
  return P;
}
function tent(u: number, v: number): Part[] {
  return [bx(u, v, u + 5, v + 3.4, 0, 0.8, 'canvas', { tone: -0.5 }), ...gable(u, v, u + 5, v + 3.4, 0.8, 'canvas', { rh: 1.8, over: 0.3, alongU: true })];
}
function barracksModel(lv: number): Part[] {
  const P: Part[] = [];
  if (lv >= 3) {
    // a U of long huts round a parade ground, a headquarters with a porch, tents, a truck, a fence with a gate
    P.push(bx(-8, -6, 14, 9, 0, 0, 'tan', { tone: 0.4, pat: 'hatches' }));
    P.push(...hut(-27, -16, 20, 6), ...hut(-27, 11, 20, 6), ...hut(-4, -16, 20, 6), ...hut(-4, 11, 20, 6));
    P.push(bx(20, -8, 31, 4, 0, 4, 'cream', { tone: -0.3 }), ...hip(20, -8, 31, 4, 4, 'brick', { rh: 2.6, over: 0.6 }), band(19.6, 4, 31.4, 4.7, 4), bx(23, 4, 28, 6.4, 0, 1.6, 'sup', { tone: 0.1 }));
    P.push(...flag(3, 1, 0, 15, 6.4), el(3, 1, 1.5, 1.2, 0, 0.6, 'sup', { sh: 'cyl', tone: 0.3 }));
    for (let i = 0; i < 3; i++) P.push(...tent(-26 + i * 6.4, -8));
    P.push(...truck(-24, 4, 'olive', 9), ...fence(-29, -19, 34, 20, [-4, 4]));
  } else {
    P.push(bx(-10, -5, 10, 8, 0, 0, 'tan', { tone: 0.4, pat: 'hatches' }));
    P.push(...hut(-22, -14, 22, 6), ...hut(-22, 11, 22, 6), ...hut(4, -14, 16, 6));
    P.push(...flag(0, 2, 0, 12, 5.4), el(0, 2, 1.4, 1.1, 0, 0.6, 'sup', { sh: 'cyl', tone: 0.3 }));
    P.push(...tent(14, 8), ...tent(20, 6), ...truck(-18, 3.4, 'olive', 9));
  }
  return P;
}

// ------------------------------------------------------------------------------------------------- factory

/** A sawtooth roof over a hall: lit slopes alternating with dark glazed strips. */
function sawtooth(u0: number, v0: number, u1: number, v1: number, z: number, pitch: number): Part[] {
  const P: Part[] = [];
  for (let u = u0; u + pitch <= u1 + 0.01; u += pitch) {
    P.push(bx(u, v0, u + pitch * 0.72, v1, z, 1.0, 'cargo', { tone: 0.7, pat: 'grille' }), bx(u + pitch * 0.3, v0, u + pitch * 0.72, v1, z + 1.0, 0.9, 'cargo', { tone: 1.1, pat: 'grille' }), bx(u + pitch * 0.72, v0, u + pitch, v1, z, 1.9, 'glass', { tone: 0.3, pat: 'frames' }), bx(u + pitch * 0.72, v0, u + pitch, v1, z + 1.9, 0.2, 'sup', { tone: 0.6 }));
  }
  return P;
}
function stack(u: number, v: number, h: number, r: number): Part[] {
  return [
    el(u, v, r * 1.25, r * 1.15, 0, h * 0.5, 'brick', { sh: 'cyl', tone: -0.3 }),
    el(u, v, r, r * 0.92, h * 0.5, h * 0.5, 'brick', { sh: 'cyl', tone: 0 }),
    el(u, v, r * 1.12, r * 1.02, h * 0.92, 0.9, 'own', { sh: 'cyl', tone: 0 }),
    el(u, v, r * 0.78, r * 0.7, h, 0, 'black'),
  ];
}
function smoke(u: number, v: number, h: number, k: number): Part[] {
  return [
    el(u + 1.5 * k, v - 2.4 * k, 2.6, 2.2, h + 1, 1.6, 'foam', { a: 0.7, sh: 'dome', tone: -0.7 }),
    el(u + 3.4 * k, v - 5.2 * k, 3.4, 2.9, h + 3.4, 1.8, 'foam', { a: 0.55, sh: 'dome', tone: -0.5 }),
    el(u + 6 * k, v - 8.2 * k, 4.2, 3.5, h + 6, 2, 'foam', { a: 0.42, sh: 'dome', tone: -0.3 }),
  ];
}
function factoryModel(lv: number, simple: boolean): Part[] {
  const P: Part[] = [];
  const hall = (u0: number, v0: number, u1: number, v1: number, wz: number): void => {
    P.push(bx(u0, v0, u1, v1, 0, wz, 'brick', { tone: -0.4 }), bx(u0 + 0.4, v0 + 0.4, u1 - 0.4, v1 - 0.4, wz, 0, 'fieldgrey', { inset: true, tone: -0.4 }));
    P.push(...sawtooth(u0 + 0.4, v0 + 0.4, u1 - 0.4, v1 - 0.4, wz, 4.4));
    for (let u = u0 + 2; u < u1 - 3; u += 4.6) P.push(bx(u, v1, u + 2, v1 + 0.2, 0.2, 2.2, 'glass', { tone: 0.2 }));
    P.push(band(u0 - 0.2, v1 - 0.2, u1 + 0.2, v1 + 0.6, wz + 0.2));
  };
  if (lv >= 5) {
    hall(-24, -14, 4, 2, 4.4);
    hall(-24, 5, 4, 19, 4.4);
    hall(8, -14, 22, 2, 4.4);
    P.push(...stack(-27, -16, 17, 1.7), ...stack(10, -17, 15, 1.5), ...stack(20, -16, 13, 1.4));
    if (!simple) P.push(...smoke(-27, -16, 17, 1), ...smoke(10, -17, 15, 1));
    P.push(...tank(14, 11, 4.2, 6), ...tank(25, 11, 3.4, 5));
    P.push(bx(8, 4, 30, 8, 0, 0, 'tan', { tone: 0.3, pat: 'hatches' }), crate(9, 5, 'rust'), crate(15.4, 5, 'fadedBlue'), crate(21.8, 5, 'ochre'), crate(9, 5, 'cargo', 2.2), ...truck(24, 16, 'olive', 9));
    P.push(seg(6, -17, 28, -17, 1.0, 9, 0.6, 'ochre'), el(6, -17, 0.7, 0.7, 0, 9, 'ochre', { sh: 'cyl' }), el(28, -17, 0.7, 0.7, 0, 9, 'ochre', { sh: 'cyl' }), bx(15, -18, 19, -16, 9.6, 1.8, 'ochre', { tone: 0.2 }));
  } else if (lv >= 3) {
    hall(-24, -12, 6, 4, 4);
    hall(-24, 8, 6, 18, 3.6);
    P.push(...stack(-27, -14, 15, 1.6), ...stack(10, -9, 13, 1.4));
    if (!simple) P.push(...smoke(-27, -14, 15, 1), ...smoke(10, -9, 13, 1));
    P.push(bx(10, -2, 28, 6, 0, 0, 'tan', { tone: 0.3, pat: 'hatches' }), crate(11, -1, 'rust'), crate(17.6, -1, 'fadedBlue'), crate(11, -1, 'ochre', 2.2), ...truck(20, 10, 'olive', 9));
  } else {
    hall(-20, -10, 6, 8, 4);
    P.push(...stack(-23, -12, 14, 1.6));
    if (!simple) P.push(...smoke(-23, -12, 14, 1));
    P.push(bx(10, -2, 24, 8, 0, 0, 'tan', { tone: 0.3, pat: 'hatches' }), crate(11, 0, 'rust'), crate(11, 3.4, 'fadedBlue'), ...truck(16, 5, 'olive', 9));
  }
  return P;
}

// ------------------------------------------------------------------------------------------------- arsenal

/** An earth-covered bunker: a grassy mound with a concrete face, a black door, an owner stripe over it. */
function bunker(u: number, v: number, w: number, d: number, h: number): Part[] {
  return [
    el(u, v, w * 0.5, d * 0.5, 0, h, 'olive', { sh: 'dome', tone: -0.5 }),
    el(u - w * 0.08, v - d * 0.1, w * 0.36, d * 0.34, h * 0.6, h * 0.5, 'camo', { sh: 'dome', tone: 0.6 }),
    bx(u - w * 0.26, v + d * 0.32, u + w * 0.26, v + d * 0.52, 0, h * 0.9, 'sup', { tone: -0.1 }),
    bx(u - w * 0.18, v + d * 0.5, u + w * 0.18, v + d * 0.55, 0, h * 0.66, 'black', { tone: 0.6 }),
    bx(u - w * 0.26, v + d * 0.3, u + w * 0.26, v + d * 0.52, h * 0.9, 0.5, 'own'),
  ];
}
function crateStack(u: number, v: number, n: number): Part[] {
  const P: Part[] = [];
  for (let i = 0; i < n; i++) P.push(bx(u + (i % 3) * 2.4, v + Math.floor(i / 3) * 1.9, u + (i % 3) * 2.4 + 2.2, v + Math.floor(i / 3) * 1.9 + 1.7, 0, 1.4, i % 2 ? 'teak' : 'canvas', { pat: 'planks', tone: i % 2 ? 0 : -0.2 }));
  P.push(bx(u + 0.2, v + 0.1, u + 2.4, v + 1.8, 1.4, 1.2, 'teak', { pat: 'planks', tone: 0.3 }));
  return P;
}
function howitzer(u: number, v: number): Part[] {
  return [bx(u - 3.2, v - 1.4, u + 0.8, v + 1.4, 0, 1.0, 'olive', { tone: 0.2 }), el(u - 0.5, v, 1.7, 1.5, 1.0, 1.0, 'olive', { sh: 'dome', tone: 0.5 }), ...barrel(u - 0.5, v, u + 7, v - 3.2, 1.3, 1.6), seg(u - 3.2, v, u - 6, v + 0.6, 0.8, 0.4, 0.8, 'olive', { tone: -0.2 }), el(u - 0.5, v, 0.7, 0.7, 2.0, 0.4, 'own', { sh: 'dome' })];
}
function arsenalModel(lv: number): Part[] {
  const P: Part[] = [];
  if (lv >= 5) {
    P.push(...bunker(-18, -8, 13, 11, 4.4), ...bunker(-3, -8, 13, 11, 4.4), ...bunker(12, -8, 13, 11, 4.4), ...bunker(-18, 8, 13, 10, 4), ...bunker(-3, 8, 13, 10, 4));
    P.push(bx(19, 1, 30, 12, 0, 3.6, 'cream', { tone: -0.3 }), ...gable(19, 1, 30, 12, 3.6, 'fieldgrey', { rh: 2.4, over: 0.5, metal: true, alongU: true }), band(19.4, 6, 29.6, 7, 6.3));
    P.push(...crateStack(-25, 17, 6), ...crateStack(-13, 18, 6), ...howitzer(8, 18), ...howitzer(18, 16));
    for (const [u, v] of [[-27, -17], [30, -17], [30, 19]]) P.push(...[bx(u - 1.4, v - 1.4, u + 1.4, v + 1.4, 0, 6.5, 'sup', { tone: 0.1 }), bx(u - 2.1, v - 2.1, u + 2.1, v + 2.1, 6.5, 1.5, 'fieldgrey', { tone: 0.5 }), ...hip(u - 2.1, v - 2.1, u + 2.1, v + 2.1, 8, 'rust', { rh: 1.4, over: 0.3 })]);
    P.push(...fence(-27, -20, 31, 22, [-3, 5]));
  } else if (lv >= 3) {
    P.push(...bunker(-17, -7, 14, 10, 4.2), ...bunker(0, -7, 14, 10, 4.2), ...bunker(-17, 8, 14, 9, 3.8), ...bunker(0, 8, 14, 9, 3.8));
    P.push(bx(15, -3, 26, 8, 0, 3.4, 'cream', { tone: -0.3 }), ...gable(15, -3, 26, 8, 3.4, 'fieldgrey', { rh: 2.2, over: 0.5, metal: true, alongU: true }), band(15.4, 2, 25.6, 3, 5.8));
    P.push(...crateStack(-24, 16, 6), ...howitzer(8, 17));
    P.push(...fence(-27, -15, 29, 22, [-3, 4]));
  } else {
    P.push(...bunker(-12, -4, 13, 9, 3.8), ...bunker(6, -4, 13, 9, 3.8));
    P.push(...crateStack(-18, 8, 6), ...crateStack(8, 9, 3));
    P.push(...fence(-22, -12, 20, 15, [-3, 4]));
  }
  return P;
}

// ------------------------------------------------------------------------------------------------- watchtower

function lookoutTower(u: number, v: number, lv: number): Part[] {
  const P: Part[] = [];
  const concrete = lv >= 3;
  const legMat: Mat = concrete ? 'sup' : 'teak';
  const H = concrete ? 38 : 24;
  const w = concrete ? 3.4 : 3.8;
  if (concrete) {
    P.push(bx(u - w - 1.4, v - w - 1.4, u + w + 1.4, v + w + 1.4, 0, 2, 'sup', { tone: -0.3 }), bx(u - w, v - w, u + w, v + w, 2, H - 2, 'sup', { tone: -0.1, pat: 'panels' }), bx(u - w * 0.68, v - w * 0.68, u + w * 0.68, v + w * 0.68, 0, 0, 'black', { inset: true }));
    P.push(bx(u - w - 0.2, v + w, u + w + 0.2, v + w + 0.3, 3, H - 6, 'sup', { tone: 0.3, pat: 'grille' }));
  } else {
    for (const [a, b] of [[-w, -w], [w, -w], [-w, w], [w, w]]) P.push(el(u + a, v + b, 0.7, 0.7, 0, H - 2, legMat, { sh: 'cyl', tone: 0.2 }));
    for (const z of [3, 9, 15]) P.push(bx(u - w, v - w, u + w, v - w + 0.4, z, 0.5, legMat, { tone: 0.3 }), bx(u - w, v + w - 0.4, u + w, v + w, z, 0.5, legMat, { tone: 0.3 }), bx(u - w, v - w, u - w + 0.4, v + w, z, 0.5, legMat, { tone: 0.3 }), bx(u + w - 0.4, v - w, u + w, v + w, z, 0.5, legMat, { tone: 0.3 }));
    P.push(seg(u - w, v + w, u + w, v + w, 0.5, 3.4, 0.4, legMat, { tone: 0.6 }), seg(u + w, v + w, u - w, v + w, 0.5, 8, 0.4, legMat, { tone: 0.6 }));
  }
  // the lookout platform, wider than the shaft, with a rail round it, a glazed cabin and a roof, the owner's flag on top
  const pw = w + (concrete ? 2.2 : 1.6);
  P.push(bx(u - pw, v - pw, u + pw, v + pw, H - 2, 1.0, concrete ? 'sup' : 'teak', { tone: 0.3, pat: 'planks' }), bx(u - pw, v - pw, u + pw, v + pw, H - 1, 1.3, 'gun', { edge: true, tone: 0.6 }));
  const cw = w + (concrete ? 0.4 : 0.1);
  P.push(bx(u - cw, v - cw, u + cw, v + cw, H - 1, 3.0, concrete ? 'cream' : 'canvas', { tone: -0.2 }), bx(u - cw + 0.4, v + cw, u + cw - 0.4, v + cw + 0.2, H, 1.4, 'glass', { tone: 0.4, pat: 'frames' }), bx(u - cw - 0.1, v - cw + 0.4, u - cw, v + cw - 0.4, H, 1.4, 'glass', { tone: 0.2, pat: 'frames' }));
  P.push(...hip(u - cw, v - cw, u + cw, v + cw, H + 2, concrete ? 'fieldgrey' : 'rust', { rh: 2.4, over: 0.9 }), band(u - cw - 0.8, v + cw + 0.9, u + cw + 0.8, v + cw + 1.6, H + 2.2));
  P.push(...flag(u + cw * 0.3, v - cw * 0.3, H + 4.4, concrete ? 8 : 6, 4));
  if (concrete) {
    P.push(el(u + pw - 0.6, v - pw + 0.6, 0.55, 0.55, H - 1, 4, 'gun', { sh: 'cyl', tone: 0.6 }), el(u - pw + 0.6, v - pw + 0.6, 0.5, 0.5, H - 1, 6.4, 'gun', { sh: 'cyl', tone: 0.6 }), el(u - pw + 0.6, v - pw + 0.6, 1.0, 0.9, H + 5.4, 0.9, 'own', { sh: 'dome' }));
    P.push(el(u + pw - 0.2, v + pw - 0.2, 1.3, 1.0, H - 1, 1.0, 'alu', { sh: 'dome', tone: 0.4 }));
  }
  return P;
}
function watchtowerModel(lv: number): Part[] {
  const P: Part[] = [];
  if (lv >= 3) {
    P.push(...lookoutTower(0, -3, 3));
    P.push(bx(-22, 6, -10, 14, 0, 3, 'cream', { tone: -0.3 }), ...gable(-22, 6, -10, 14, 3, 'fieldgrey', { rh: 1.6, over: 0.5, metal: true }), bx(10, 4, 18, 11, 0, 2.6, 'sup', { tone: -0.2 }), ...gable(10, 4, 18, 11, 2.6, 'fieldgrey', { rh: 1.4, over: 0.4, metal: true }));
    P.push(el(-14, -6, 4.4, 3.6, 0, 4, 'sup', { sh: 'cyl', tone: 0.2 }), el(-14, -6, 4.6, 3.8, 4, 0.9, 'own', { sh: 'cyl', tone: 0.2 }), ...fence(-26, -14, 24, 18, [-3, 5]));
  } else {
    P.push(...lookoutTower(0, -2, 1));
    P.push(bx(-14, 6, -6, 12, 0, 2.2, 'canvas', { tone: -0.3 }), ...gable(-14, 6, -6, 12, 2.2, 'olive', { rh: 1.4, over: 0.4, metal: true }), ...tree(12, 4, 2.4, 3), ...tree(-15, -8, 2.2, 5));
    P.push(el(8, 8, 3.2, 2.6, 0, 1.2, 'canvas', { sh: 'dome', tone: 0.2 }));
  }
  return P;
}

// ------------------------------------------------------------------------------------------------- lab

function dish(u: number, v: number, r: number, z: number): Part[] {
  return [el(u, v, 0.9, 0.9, z, 1.4, 'gun', { sh: 'cyl', tone: 0.6 }), el(u, v - 0.8, r, r * 0.8, z + 1.4, 0.9, 'alu', { sh: 'dome', tone: 0.2 }), seg(u, v - 0.8, u + r * 0.5, v - r * 0.9, 0.5, z + 2.4, 0.5, 'gun'), el(u + r * 0.52, v - r * 0.95, 0.5, 0.5, z + 2.4, 0.5, 'own')];
}
function solar(u: number, v: number, w: number, d: number): Part[] {
  const P: Part[] = [];
  for (let i = 0; i < w / 2.6; i++) P.push(bx(u + i * 2.6, v, u + i * 2.6 + 2.2, v + d, 0.4, 0.7, 'fadedBlue', { tone: 0.5, pat: 'panels' }));
  return P;
}
function labModel(lv: number): Part[] {
  const P: Part[] = [];
  const wing = (u0: number, v0: number, u1: number, v1: number, h: number): void => {
    P.push(bx(u0, v0, u1, v1, 0, h, 'white', { tone: -0.3 }), bx(u0 + 0.6, v1 - 0.1, u1 - 0.6, v1 + 0.3, 0.6, h * 0.4, 'glass', { tone: 0.4, pat: 'frames' }), bx(u0 - 0.3, v0 - 0.3, u1 + 0.3, v1 + 0.3, h, 0.5, 'sup', { tone: 0.5 }), bx(u0 + 0.6, v0 + 0.6, u1 - 0.6, v1 - 0.6, h + 0.5, 0, 'sup', { inset: true, tone: -0.3 }), band(u0 - 0.3, v1 - 0.3, u1 + 0.3, v1 + 0.6, h + 0.6));
    if (u1 - u0 > 8) P.push(...skylight(u0 + 2, v0 + 1.6, h + 0.5, 3.4, 1.8), ...skylight(u1 - 5.6, v0 + 1.6, h + 0.5, 3.4, 1.8), ...acUnit(u0 + (u1 - u0) / 2 - 1, v1 - 3.6, h + 0.5));
  };
  const dome = (u: number, v: number, r: number, z: number): void => {
    P.push(el(u, v, r * 1.12, r * 1.05, z, 0.8, 'sup', { sh: 'cyl', tone: 0.2 }), el(u, v, r, r * 0.94, z + 0.8, r * 0.95, 'white', { sh: 'dome', tone: 0.1 }), el(u - r * 0.3, v - r * 0.3, r * 0.2, r * 0.2, z + r * 0.9, 0.2, 'white', { sh: 'dome', tone: 1.0 }));
  };
  if (lv >= 5) {
    wing(-24, -15, -2, 0, 6);
    wing(2, -15, 24, 0, 6);
    wing(-24, 4, -6, 18, 5);
    wing(-2, -2, 2, 10, 4.5);
    wing(6, 4, 24, 18, 6.8);
    dome(-13, -8, 5.2, 6);
    dome(13, -8, 4.2, 6);
    P.push(...dish(15, 11, 4.6, 6.8), ...dish(-15, 11, 3.6, 5), ...solar(-3, 14, 5, 3));
    P.push(el(0, 4, 0.5, 0.5, 4.5, 18, 'gun', { sh: 'cyl', tone: 0.7 }), el(0, 4, 0.9, 0.9, 22.5, 0.8, 'own', { sh: 'cyl' }), bx(-1.6, 4, 1.6, 5.6, 0, 3, 'cream', { tone: 0.2 }));
    P.push(...tree(-27, 8, 2.2, 1), ...tree(29, 12, 2.2, 3));
  } else if (lv >= 3) {
    wing(-20, -12, 4, 2, 5.6);
    wing(-20, 6, -6, 15, 4.6);
    wing(8, -12, 22, 8, 4.6);
    dome(-8, -5, 4.6, 5.6);
    P.push(...dish(15, 10, 3.8, 4.6), el(-1, 11, 0.5, 0.5, 0, 12, 'gun', { sh: 'cyl', tone: 0.7 }), ...solar(-3, 8, 8, 3));
    P.push(...tree(-24, 12, 2.2, 3));
  } else {
    wing(-14, -9, 10, 3, 4.4);
    dome(-3, -3, 3.6, 4.4);
    P.push(...dish(15, 6, 3, 0), ...tree(-19, 6, 2.2, 3), bx(-12, 8, -3, 11, 0, 0, 'flightdeck', { tone: 0.6 }));
  }
  return P;
}

// ------------------------------------------------------------------------------------------------- hospital

function crossMark(u: number, v: number, z: number, s: number): Part[] {
  return [el(u, v, s * 1.05, s * 0.95, z, 0, 'white', { tone: 0.4 }), bx(u - s * 0.78, v - s * 0.24, u + s * 0.78, v + s * 0.24, z, 0, 'redlead', { tone: 1.3 }), bx(u - s * 0.24, v - s * 0.78, u + s * 0.24, v + s * 0.78, z, 0, 'redlead', { tone: 1.3 })];
}
function helipad(u: number, v: number, r: number): Part[] {
  return [el(u, v, r, r * 0.94, 0, 0.4, 'fieldgrey', { tone: 0.2 }), el(u, v, r * 0.82, r * 0.76, 0.4, 0, 'paintYellow', { tone: 0.1 }), el(u, v, r * 0.74, r * 0.69, 0.4, 0, 'fieldgrey', { tone: 0.2 }), bx(u - r * 0.34, v - r * 0.38, u - r * 0.2, v + r * 0.38, 0.4, 0, 'paint'), bx(u + r * 0.2, v - r * 0.38, u + r * 0.34, v + r * 0.38, 0.4, 0, 'paint'), bx(u - r * 0.2, v - r * 0.07, u + r * 0.2, v + r * 0.07, 0.4, 0, 'paint')];
}
function ambulance(u: number, v: number): Part[] {
  return [bx(u + 0.7, v - 0.2, u + 7.3, v + 3.4, 0, 0.8, 'track'), bx(u, v, u + 5, v + 3.2, 0.8, 2.4, 'white', { tone: 0.2 }), bx(u + 5, v + 0.2, u + 8, v + 3, 0.8, 1.8, 'white', { tone: 0.4 }), bx(u + 6.6, v + 0.5, u + 7.2, v + 2.7, 2.6, 0, 'glass'), bx(u + 1.4, v + 1.0, u + 3.6, v + 2.2, 3.2, 0, 'redlead', { tone: 1.3 }), bx(u + 5.2, v + 1.2, u + 6, v + 2.0, 2.6, 0.5, 'own')];
}
function hospitalModel(lv: number): Part[] {
  const P: Part[] = [];
  const block = (u0: number, v0: number, u1: number, v1: number, h: number): void => {
    P.push(bx(u0, v0, u1, v1, 0, h, 'white', { tone: -0.2 }), bx(u0 + 1, v1 - 0.1, u1 - 1, v1 + 0.3, 0.6, h * 0.5, 'glass', { tone: 0.3, pat: 'frames' }), bx(u0 - 0.3, v0 - 0.3, u1 + 0.3, v1 + 0.3, h, 0.5, 'white', { tone: 0.4 }), bx(u0 + 0.8, v0 + 0.8, u1 - 0.8, v1 - 0.8, h + 0.5, 0, 'paint', { inset: true, tone: -0.2 }));
  };
  if (lv >= 2) {
    block(-24, -10, -6, 6, 5);
    block(6, -10, 24, 6, 5);
    block(-6, -12, 6, 10, 8.4);
    P.push(...crossMark(0, -1, 8.9, 3.8), bx(-8, 10, 8, 13, 0, 1.0, 'sup', { tone: 0.3 }), bx(-8, 10, 8, 13, 3, 0.5, 'own'), el(-7, 12, 0.5, 0.5, 0, 3, 'gun', { sh: 'cyl' }), el(7, 12, 0.5, 0.5, 0, 3, 'gun', { sh: 'cyl' }));
    P.push(...crossMark(-15, -2, 5.5, 2.8), ...crossMark(15, -2, 5.5, 2.8), ...helipad(-20, 18, 6), ...ambulance(8, 16), ...ambulance(18, 16), ...flag(26, 10, 0, 9, 4), ...tree(-29, 4, 2.2, 3));
  } else {
    block(-14, -9, 8, 5, 4.4);
    P.push(...crossMark(-3, -2, 4.9, 3.2), bx(-5, 5, 0, 8, 0, 0.8, 'sup', { tone: 0.3 }), bx(-5, 5, 0, 8, 2.8, 0.5, 'own'), el(-4.6, 7.6, 0.4, 0.4, 0, 2.8, 'gun', { sh: 'cyl' }), el(-0.4, 7.6, 0.4, 0.4, 0, 2.8, 'gun', { sh: 'cyl' }));
    P.push(...helipad(18, 4, 6), ...ambulance(-12, 9), ...flag(-17, -10, 0, 8, 3.6), ...tree(-18, 4, 2.2, 3));
  }
  return P;
}

// ------------------------------------------------------------------------------------------------- airfield

function hangar(u0: number, v0: number, u1: number, v1: number, h: number): Part[] {
  const P: Part[] = [];
  // a barrel-vaulted hangar: stepped round roof in steel, the owner's stripe along the crown, doors on the south face
  P.push(bx(u0, v0, u1, v1, 0, h, 'cargo', { tone: -0.3, pat: 'ribs' }));
  const vm = (v0 + v1) / 2;
  P.push(bx(u0, v0, u1, v0 + (v1 - v0) * 0.28, h, 1.2, 'cargo', { tone: 0.9, pat: 'grille' }), bx(u0, v0 + (v1 - v0) * 0.28, u1, v0 + (v1 - v0) * 0.72, h, 2.6, 'cargo', { tone: 0.5, pat: 'grille' }), bx(u0, v0 + (v1 - v0) * 0.72, u1, v1, h, 1.2, 'cargo', { tone: -0.9, pat: 'grille' }));
  P.push(bx(u0, vm - 0.5, u1, vm + 0.5, h + 2.6, 0.4, 'own'));
  P.push(bx(u0 + 1.4, v1, u1 - 1.4, v1 + 0.3, 0, h * 0.85, 'black', { tone: 0.5 }), bx(u0 + 1.4, v1 + 0.3, u1 - 1.4, v1 + 0.6, 0, h * 0.85, 'gun', { tone: 0.4, pat: 'grille' }));
  return P;
}
function controlTower(u: number, v: number): Part[] {
  return [bx(u - 1.6, v - 1.6, u + 1.6, v + 1.6, 0, 8, 'cream', { tone: -0.2 }), bx(u - 3, v - 3, u + 3, v + 3, 8, 2.2, 'glass', { tone: 0.3, pat: 'frames' }), bx(u - 3.4, v - 3.4, u + 3.4, v + 3.4, 10.2, 0.7, 'own'), el(u + 1, v - 1, 0.4, 0.4, 10.9, 4.6, 'gun', { sh: 'cyl', tone: 0.7 }), el(u - 1.6, v + 0.4, 0.9, 0.9, 10.9, 0.9, 'alu', { sh: 'dome', tone: 0.3 })];
}
function airfieldModel(lv: number): Part[] {
  const P: Part[] = [];
  const run = (u0: number, u1: number, v: number, w: number): void => {
    P.push(bx(u0, v - w / 2, u1, v + w / 2, 0, 0, 'flightdeck', { tone: 0.2 }), bx(u0, v - w / 2, u1, v - w / 2 + 0.4, 0, 0, 'paint', { tone: 0.1 }), bx(u0, v + w / 2 - 0.4, u1, v + w / 2, 0, 0, 'paint', { tone: 0.1 }));
    P.push(...dashes(u0 + 7, u1 - 5, v, 3, 0.5, 6.4, 'paint'));
    for (let k = 0; k < 4; k++) P.push(bx(u0 + 1.2, v - w / 2 + 0.9 + k * (w - 2.2) / 3, u0 + 4.2, v - w / 2 + 1.4 + k * (w - 2.2) / 3, 0, 0, 'paint'), bx(u1 - 4.2, v - w / 2 + 0.9 + k * (w - 2.2) / 3, u1 - 1.2, v - w / 2 + 1.4 + k * (w - 2.2) / 3, 0, 0, 'paint'));
  };
  if (lv >= 3) {
    run(-30, 36, 12, 9);
    // apron, taxiway
    P.push(bx(-22, -4, 22, 5, 0, 0, 'flightdeck', { tone: 0.5 }), bx(-4, 5, 4, 7.6, 0, 0, 'flightdeck', { tone: 0.5 }), bx(-4, 7.6, 4, 7.9, 0, 0, 'paintYellow'));
    P.push(...hangar(-26, -18, -9, -7, 5.4), ...hangar(-7, -18, 10, -7, 5.4));
    P.push(...controlTower(16, -11), bx(21, -13, 30, -6, 0, 2.6, 'cream', { tone: -0.3 }), ...gable(21, -13, 30, -6, 2.6, 'fieldgrey', { rh: 1.4, over: 0.4, metal: true }));
    P.push(...plane(-12, 0.5, 0.95), ...plane(6, 0.5, 0.95), ...plane(18, 0, 0.9));
    P.push(...tank(32, -3, 2.8, 4.2), ...tank(32, 4.4, 2.8, 4.2), ...flag(-28, 3, 0, 9, 4));
  } else {
    run(-26, 30, 11, 8);
    P.push(bx(-18, -4, 8, 4, 0, 0, 'flightdeck', { tone: 0.5 }), bx(-4, 4, 4, 6.6, 0, 0, 'flightdeck', { tone: 0.5 }));
    P.push(...hangar(-24, -17, -6, -6, 5));
    P.push(...controlTower(12, -9), ...plane(0, 0, 0.95));
    P.push(...flag(-26, 3, 0, 8, 3.6));
  }
  return P;
}

// ------------------------------------------------------------------------------------------------- missile silo

function hatch(u: number, v: number, r: number): Part[] {
  const P: Part[] = [];
  P.push(el(u, v, r * 1.22, r * 1.12, 0, 0.8, 'hazard', { sh: 'cyl', tone: -0.2 }), el(u, v, r * 1.04, r * 0.96, 0.8, 0.5, 'gun', { sh: 'cyl', tone: 0.4 }));
  // two door leaves meeting in a dark slit, an owner bar on each, a hazard edge
  P.push(bx(u - r * 0.96, v - r * 0.84, u - 0.35, v + r * 0.84, 1.2, 0.7, 'fieldgrey', { tone: 0.3, pat: 'panels', clip: [u, v, r * 0.98, r * 0.9] }), bx(u + 0.35, v - r * 0.84, u + r * 0.96, v + r * 0.84, 1.2, 0.7, 'fieldgrey', { tone: -0.1, pat: 'panels', clip: [u, v, r * 0.98, r * 0.9] }));
  P.push(bx(u - 0.35, v - r * 0.84, u + 0.35, v + r * 0.84, 1.2, 0.2, 'black'));
  P.push(bx(u - r * 0.66, v - 0.5, u - r * 0.14, v + 0.5, 1.9, 0, 'own'), bx(u + r * 0.14, v - 0.5, u + r * 0.66, v + 0.5, 1.9, 0, 'own'));
  return P;
}
function siloModel(lv: number): Part[] {
  const P: Part[] = [];
  const pad = (u0: number, v0: number, u1: number, v1: number): void => {
    P.push(bx(u0, v0, u1, v1, 0, 0.6, 'sup', { tone: -0.5 }), bx(u0 + 0.8, v0 + 0.8, u1 - 0.8, v1 - 0.8, 0.6, 0, 'sup', { tone: -0.1, pat: 'panels', inset: true }));
  };
  const blast = (u: number, v: number): void => {
    // the blast door: a steel slab in a concrete frame, hazard stripes across it
    P.push(bx(u - 3.4, v - 0.2, u + 3.4, v + 2.6, 0, 2.6, 'sup', { tone: -0.2 }), bx(u - 2.6, v + 2.6, u + 2.6, v + 3, 0, 2.0, 'fieldgrey', { tone: 0.3, pat: 'grille' }), bx(u - 2.6, v + 2.6, u + 2.6, v + 3.0, 2.0, 0.4, 'hazard', { pat: 'hatches' }), bx(u - 3.4, v - 0.2, u + 3.4, v + 0.6, 2.6, 0.5, 'own'));
  };
  const service = (u0: number, v0: number, u1: number, v1: number, h: number): void => {
    P.push(bx(u0, v0, u1, v1, 0, h, 'cream', { tone: -0.3 }), bx(u0 - 0.4, v0 - 0.4, u1 + 0.4, v1 + 0.4, h, 0.6, 'sup', { tone: 0.4 }), bx(u0 + 0.8, v0 + 0.8, u1 - 0.8, v1 - 0.8, h + 0.6, 0, 'sup', { inset: true, tone: -0.3 }), band(u0 - 0.4, v1 - 0.3, u1 + 0.4, v1 + 0.5, h + 0.7), ...acUnitSimple(u0 + 1.2, v0 + 1.2, h + 0.6));
    P.push(el((u0 + u1) / 2, v0 + 1.4, 0.3, 0.3, h + 0.6, 6, 'gun', { sh: 'cyl', tone: 0.7 }), el((u0 + u1) / 2, v0 + 1.4, 0.7, 0.7, h + 6.6, 0.5, 'own', { sh: 'dome' }));
  };
  if (lv >= 3) {
    pad(-24, -15, 27, 19);
    P.push(...hatch(-12, -3, 5.2), ...hatch(3, -3, 5.2), ...hatch(18, -3, 5.2));
    blast(-4, 12);
    service(8, 9, 23, 17, 3.4);
    P.push(...dish(-18, 11, 3.2, 0), ...fence(-28, -19, 31, 24, [-9, 1]));
    for (const [u, v] of [[-28, -19], [31, -19], [31, 24]]) P.push(el(u, v, 1.4, 1.4, 0, 6, 'sup', { sh: 'cyl', tone: 0.2 }), el(u, v, 1.9, 1.9, 6, 1.4, 'own', { sh: 'dome' }));
  } else {
    pad(-17, -13, 20, 16);
    P.push(...hatch(-3, -3, 6));
    blast(-3, 9);
    service(8, 5, 18, 14, 3.2);
    P.push(...fence(-21, -17, 24, 20, [-9, 3]));
    for (const [u, v] of [[-21, -17], [24, -17], [24, 20]]) P.push(el(u, v, 1.1, 1.1, 0, 4.6, 'sup', { sh: 'cyl', tone: 0.2 }), el(u, v, 1.5, 1.5, 4.6, 1.0, 'own', { sh: 'dome' }));
  }
  return P;
}
const acUnitSimple = (u: number, v: number, z: number): Part[] => [bx(u, v, u + 2.4, v + 1.7, z, 1.1, 'alu', { tone: -0.2, pat: 'grille' })];

// ------------------------------------------------------------------------------------------------- entry points

/** The model, slid sideways when it would reach past the cell (the cell holds u from -29 to 39). */
export function moreModel(type: MoreType, lv: number, simple: boolean): Part[] {
  const P = rawModel(type, lv, simple);
  const [u0, , u1] = footprint(P);
  const du = u0 < -26 ? -26 - u0 : u1 > 36 ? 36 - u1 : 0;
  return du ? moved(P, du, 0) : P;
}
function rawModel(type: MoreType, lv: number, simple: boolean): Part[] {
  switch (type) {
    case 'farm':
      return farmModel(lv);
    case 'market':
      return marketModel(lv);
    case 'mine':
      return mineModel(lv);
    case 'oilWell':
      return oilModel(lv);
    case 'barracks':
      return barracksModel(lv);
    case 'factory':
      return factoryModel(lv, simple);
    case 'arsenal':
      return arsenalModel(lv);
    case 'watchtower':
      return watchtowerModel(lv);
    case 'lab':
      return labModel(lv);
    case 'hospital':
      return hospitalModel(lv);
    case 'airfield':
      return airfieldModel(lv);
    case 'silo':
      return siloModel(lv);
  }
}

/** The ground footprint of a model (smoke and the like left out): u0, v0, u1, v1. */
function footprint(parts: readonly Part[]): [number, number, number, number] {
  let a = Infinity;
  let b = Infinity;
  let c = -Infinity;
  let d = -Infinity;
  for (const p of parts) {
    if (p.m === 'foam' || p.glow) continue;
    const [x0, y0, x1, y1] = footBox(p);
    a = Math.min(a, x0);
    b = Math.min(b, y0);
    c = Math.max(c, x1);
    d = Math.max(d, y1);
  }
  return [a, b, c, d];
}

/** The ground of a building: a dark halo, a dirt yard, and the marks of its trade (furrows, spoil, oil, tarmac, concrete). */
export function moreGround(g: Ground, type: MoreType, lv: number, far: boolean): void {
  const [u0, v0, u1, v1] = footprint(moreModel(type, lv, true));
  const wide = far ? 3 : 0;
  g.slab('dark', u0 - 5 - wide, v0 - 4 - wide, u1 + 5 + wide, v1 + 7 + wide, 7, far ? 0.38 : 0.4, far ? 9 : 5, 31);
  g.slab('dirt', u0 - 2.4, v0 - 2, u1 + 2.4, v1 + 3.6, 5, far ? 0.5 : 0.7, far ? 6 : 3, 32);
  if (far) return;
  switch (type) {
    case 'farm':
      g.strip('dirtL', 6, v1, 12, v1 + 8, 3, 0.5, 33);
      g.blob('dark', u0 - 2, v1 + 3, 5, 2.6, 0.45, 0.4, 34);
      break;
    case 'market':
      g.strip('dirtL', 0, v1 + 1, 4, v1 + 10, 3, 0.5, 33);
      g.strip('dirtL', u0 - 8, 0, u0, 3, 3, 0.4, 35);
      break;
    case 'mine':
      g.blob('dark', -12, -4, 11, 8, 0.5, 0.4, 33);
      g.strip('dark', -3, 3, -3, v1 + 9, 2.4, 0.4, 36);
      break;
    case 'oilWell':
      g.blob('dark', -10, 0, 9, 6.5, 0.6, 0.4, 33);
      g.blob('dark', 14, 4, 11, 8, 0.4, 0.4, 34);
      break;
    case 'barracks':
      g.strip('dirtL', 0, v1, 4, v1 + 10, 3.4, 0.5, 33);
      break;
    case 'factory':
      g.slab('road', 8, -2, u1 - 2, 8, 2, 0.4, 1.8, 33);
      g.strip('road', 12, v1 - 2, 12, v1 + 9, 3, 0.45, 34);
      break;
    case 'arsenal':
      g.strip('dark', -3, v1 - 1, 1, v1 + 8, 3, 0.5, 33);
      g.slab('dirtL', u0 + 2, v0 + 2, u1 - 2, v1 - 2, 3, 0.35, 3, 34);
      break;
    case 'watchtower':
      g.blob('dark', 0, -3, 8, 6, 0.5, 0.4, 33);
      g.strip('dirtL', 4, 8, 8, v1 + 8, 2.8, 0.5, 34);
      break;
    case 'lab':
      g.slab('road', u0 - 2, v1 - 8, u1, v1 + 1, 2, 0.35, 1.6, 33);
      break;
    case 'hospital':
      g.strip('road', 0, v1, 4, v1 + 9, 3.4, 0.5, 33);
      break;
    case 'airfield':
      g.slab('road', u0 - 1, 5, u1 + 1, 19, 2, 0.35, 1.6, 33);
      break;
    case 'silo':
      g.slab('dirtL', u0 - 1, v0 - 1, u1 + 1, v1 + 1, 3, 0.4, 2, 33);
      g.strip('dark', -3, v1 - 2, -2, v1 + 8, 3, 0.45, 34);
      break;
  }
}

void hash;
