// The other twelve map buildings in the same style as the fort, city, SAM site and port (buildings.ts): part models seen
// from above at a high camera, run through the game's own unit rasterizer, a muted miniature palette with the owner's
// colour on flags, bands, awnings and trim, shaped roofs (no plain boxes), and a land-tinted ground that carries each
// building into the terrain. farm, market, mine, oil well, barracks, factory, arsenal, watchtower, lab, hospital,
// airfield and missile silo. Every type has one clear shape of its own so it reads at normal zoom. Art in code only.
import type { Part } from './bake';
import { barrel, band, chimney, flag, footBox, gable, hip, house, hash, moved, sandRing, tree, ventPipe, type Ground, type Mat } from './buildings';
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

/** An open steel A-frame headframe: four leaning legs with rungs, two big pale wheels on top, a cable down to the hoist house. */
function headframe(u: number, v: number, s: number): Part[] {
  const P: Part[] = [];
  const n = 4;
  const H = 20 * s;
  const wb = 5.6 * s;
  const wt = 2.4 * s;
  const db = 3 * s;
  const dt = 1.4 * s;
  for (let k = 0; k < n; k++) {
    const t0 = k / n;
    const t1 = (k + 1) / n;
    const w0 = wb + (wt - wb) * t0;
    const w1 = wb + (wt - wb) * t1;
    const d0 = db + (dt - db) * t0;
    const z0 = H * t0;
    const dz = H / n;
    for (const [a, b] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      const wm = (w0 + w1) / 2;
      const dm = (d0 + (db + (dt - db) * t1)) / 2;
      P.push(el(u + a * wm, v + b * dm, 0.6 * s + 0.2, 0.6 * s + 0.2, z0, dz, 'sup', { sh: 'cyl', tone: a < 0 ? 0.3 : -0.2 }));
    }
    const wr = w1;
    const dr = db + (dt - db) * t1;
    P.push(seg(u - wr, v + dr, u + wr, v + dr, 0.7, z0 + dz - 0.4, 0.5, 'sup', { tone: 0.4 }), seg(u - wr, v - dr, u + wr, v - dr, 0.7, z0 + dz - 0.4, 0.5, 'sup', { tone: 0.1 }), seg(u - wr, v - dr, u - wr, v + dr, 0.7, z0 + dz - 0.4, 0.5, 'sup', { tone: 0.2 }), seg(u + wr, v - dr, u + wr, v + dr, 0.7, z0 + dz - 0.4, 0.5, 'sup', { tone: -0.2 }));
    // a cross brace on the south face
    P.push(seg(u - w0, v + d0, u + w1, v + db + (dt - db) * t1, 0.45, z0 + dz * 0.5, 0.4, 'sup', { tone: 0.5 }));
  }
  // two big wheels on the top, pale steel with an owner-coloured hub and spokes
  for (const a of [-1, 1]) {
    const wu = u + a * 3.0 * s;
    P.push(el(wu, v, 3.0 * s, 3.0 * s, H, 0.8, 'alu', { sh: 'cyl', tone: 0.4 }), el(wu, v, 2.2 * s, 2.2 * s, H + 0.8, 0.3, 'gun', { tone: 0.3 }), seg(wu - 2.4 * s, v, wu + 2.4 * s, v, 0.5, H + 1.1, 0.3, 'alu', { tone: 0.6 }), seg(wu, v - 2.4 * s, wu, v + 2.4 * s, 0.5, H + 1.1, 0.3, 'alu', { tone: 0.6 }), el(wu, v, 0.9 * s, 0.9 * s, H + 0.8, 0.9, 'own', { sh: 'dome' }));
  }
  return P;
}
/** A cable from the top of a headframe down to a hoist house, as a few stepped segments. */
function cable(u0: number, v0: number, z0: number, u1: number, v1: number, z1: number): Part[] {
  const P: Part[] = [];
  const n = 4;
  for (let i = 0; i < n; i++) {
    const a = i / n;
    const b = (i + 1) / n;
    P.push(seg(u0 + (u1 - u0) * a, v0 + (v1 - v0) * a, u0 + (u1 - u0) * b, v0 + (v1 - v0) * b, 0.45, z0 + (z1 - z0) * a, 0.3, 'black', { tone: 0.5 }));
  }
  return P;
}
/** A spoil heap in lit terraces: three stacked cones, lighter toward the top left, flecked with ore. */
function heap(u: number, v: number, ru: number, rv: number, h: number, mat: Mat = 'ochre', lift = 0): Part[] {
  return [
    el(u, v, ru, rv, 0, h * 0.4, mat, { sh: 'dome', tone: -0.6 + lift }),
    el(u - ru * 0.08, v - rv * 0.08, ru * 0.76, rv * 0.74, h * 0.38, h * 0.32, mat, { sh: 'dome', tone: 0.1 + lift }),
    el(u - ru * 0.17, v - rv * 0.16, ru * 0.5, rv * 0.48, h * 0.68, h * 0.32, mat, { sh: 'dome', tone: 0.7 + lift }),
    el(u - ru * 0.5, v + rv * 0.3, 0.7, 0.55, h * 0.3, 0.6, 'rust', { sh: 'dome', tone: 0.3 }),
    el(u + ru * 0.4, v - rv * 0.2, 0.6, 0.5, h * 0.3, 0.5, 'black', { sh: 'dome', tone: 0.8 }),
  ];
}
function cart(u: number, v: number, alongV = false): Part[] {
  const w = alongV ? 2.6 : 3.6;
  const d = alongV ? 3.6 : 2.6;
  return [bx(u, v, u + w, v + d, 0.5, 1.5, 'rust', { tone: -0.2 }), el(u + w / 2, v + d / 2, w * 0.38, d * 0.38, 1.9, 0.9, 'black', { sh: 'dome', tone: 0.5 }), bx(u + 0.2, v + 0.1, u + w - 0.2, v + 0.5, 1.9, 0, 'own')];
}
function rails(u0: number, v0: number, u1: number, v1: number): Part[] {
  const P: Part[] = [];
  const L = Math.hypot(u1 - u0, v1 - v0);
  const nu = -(v1 - v0) / L;
  const nv = (u1 - u0) / L;
  for (const o of [-1, 1]) P.push(seg(u0 + nu * o, v0 + nv * o, u1 + nu * o, v1 + nv * o, 0.55, 0, 0.5, 'gun', { tone: 0.6 }));
  for (let t = 0.5; t < L; t += 2) P.push(seg(u0 + ((u1 - u0) * t) / L + nu * 1.6, v0 + ((v1 - v0) * t) / L + nv * 1.6, u0 + ((u1 - u0) * t) / L - nu * 1.6, v0 + ((v1 - v0) * t) / L - nv * 1.6, 0.5, 0, 0.2, 'teak'));
  return P;
}
/** A small hill with a timbered tunnel mouth cut into its south face. */
function adit(u: number, v: number, r: number): Part[] {
  return [
    el(u, v, r, r * 0.72, 0, r * 0.5, 'olive', { sh: 'dome', tone: -0.2 }),
    el(u - r * 0.15, v - r * 0.12, r * 0.62, r * 0.45, r * 0.4, r * 0.3, 'camo', { sh: 'dome', tone: 0.7 }),
    bx(u - 2.9, v + r * 0.5, u + 2.9, v + r * 0.5 + 1.2, 0, 3.0, 'teak', { tone: -0.1, pat: 'planks' }),
    bx(u - 1.9, v + r * 0.5 + 0.6, u + 1.9, v + r * 0.5 + 1.4, 0, 2.3, 'black', { tone: 0.2 }),
    bx(u - 2.9, v + r * 0.5 - 0.1, u + 2.9, v + r * 0.5 + 0.7, 3.0, 0.5, 'teak', { tone: 0.5 }),
  ];
}
function hoist(u0: number, v0: number, u1: number, v1: number): Part[] {
  return [bx(u0, v0, u1, v1, 0, 3.2, 'cream', { tone: -0.2 }), ...gable(u0, v0, u1, v1, 3.2, 'rust', { rh: 1.8, over: 0.5, metal: true }), band(u0 + 0.6, (v0 + v1) / 2 - 0.4, u1 - 0.6, (v0 + v1) / 2 + 0.4, 5.2)];
}
function mineModel(lv: number): Part[] {
  const P: Part[] = [];
  if (lv >= 5) {
    P.push(...adit(-18, -9, 8), ...rails(-18, -2, -18, 9), ...rails(-18, 9, 2, 9), ...cart(-20, 1, true), ...cart(-9, 7.7), ...cart(-3.4, 7.7));
    P.push(...heap(8, 14, 8, 5.4, 8, 'ochre'), ...heap(-8, 17, 6, 4.4, 6, 'fieldgrey', 0.6), ...heap(22, 10, 6, 4.5, 6, 'ochre', 0.2));
    P.push(...headframe(6, -10, 1.35), ...headframe(21, -10, 1.0));
    P.push(...hoist(0, -2, 9, 5), ...cable(6, -10, 27, 4.5, 1, 6), ...hoist(15, -3, 26, 4), ...cable(21, -10, 20, 20, 0, 5));
    P.push(...tree(-26, 4, 2.2, 3), ...tree(30, -6, 2.2, 4));
  } else if (lv >= 3) {
    P.push(...adit(-16, -8, 7), ...rails(-16, -2, -16, 9), ...rails(-16, 9, -2, 9), ...cart(-17.3, 1, true), ...cart(-8, 7.7), ...cart(-3.4, 7.7));
    P.push(...heap(8, 12, 7.4, 5, 7, 'ochre'), ...heap(-10, 16, 5.4, 4, 5, 'fieldgrey', 0.6));
    P.push(...headframe(8, -9, 1.2), ...hoist(14, -4, 23, 3), ...cable(8, -9, 24, 14, -0.5, 5));
    P.push(...tree(-24, 4, 2.2, 3));
  } else {
    P.push(...adit(-13, -6, 6), ...rails(-13, -1, -13, 8), ...rails(-13, 8, -2, 8), ...cart(-14.3, 2, true));
    P.push(...heap(6, 11, 6, 4.2, 5.6, 'ochre'));
    P.push(...headframe(7, -8, 1.0), ...hoist(12, -3, 19, 2), ...cable(7, -8, 20, 12, -1, 5));
  }
  return P;
}

// ------------------------------------------------------------------------------------------------- oil well

/** A pumpjack: a black frame, a yellow walking beam with a black horsehead, a dark red counterweight, a motor. */
function pumpjack(u: number, v: number, s: number, ph = 0): Part[] {
  const P: Part[] = [];
  P.push(el(u, v, 8 * s, 5.4 * s, 0, 0, 'black', { a: 0.5 }), bx(u - 5.2 * s, v - 2.8 * s, u + 5.6 * s, v + 2.8 * s, 0, 1.0, 'gun', { tone: -0.3 }));
  P.push(bx(u - 1.1 * s, v - 1.1 * s, u + 1.1 * s, v + 1.1 * s, 1.0, 6.0 * s, 'black', { tone: 0.5, pat: 'grille' }));
  P.push(seg(u - 5.2 * s, v + ph, u + 4.8 * s, v - ph, 1.5 * s, 7.0 * s, 1.1 * s, 'hazard', { tone: 0.3 }));
  P.push(el(u - 5.4 * s, v + ph, 2.0 * s, 1.8 * s, 6.4 * s, 2.2 * s, 'black', { sh: 'dome', tone: 0.6 }), el(u - 5.4 * s, v + ph, 1.0 * s, 0.9 * s, 8.6 * s, 0.3, 'hazard', { tone: 0.4 }));
  P.push(el(u + 4.4 * s, v - ph, 2.2 * s, 1.7 * s, 3.4 * s, 3.6 * s, 'brick', { sh: 'cyl', tone: 0.2 }), el(u + 4.4 * s, v - ph, 1.2 * s, 1.0 * s, 7.0 * s, 0.4, 'own', { sh: 'dome' }));
  P.push(bx(u + 0.4 * s, v + 1.4 * s, u + 4 * s, v + 2.6 * s, 1.0, 1.6, 'black', { tone: 0.5 }), seg(u - 0.2, v + 0.3, u - 0.2, v + 0.3, 0.7, 1.0, 4.4 * s, 'black'));
  return P;
}
function pipe(u0: number, v0: number, u1: number, v1: number): Part[] {
  return [seg(u0, v0, u1, v1, 1.1, 0.6, 1.0, 'redlead', { sh: 'cyl', tone: 0.6 }), el(u1, v1, 1.0, 1.0, 0.5, 1.4, 'redlead', { sh: 'cyl', tone: 0.8 })];
}
/** A storage tank: dark steel with a coloured band and a flat dark roof with a hatch. */
function oilTank(u: number, v: number, r: number, h: number): Part[] {
  return [el(u, v, r, r * 0.92, 0, h, 'gun', { sh: 'cyl', tone: 0.6 }), el(u, v, r * 1.03, r * 0.95, h * 0.5, 1.2, 'own', { sh: 'cyl', tone: 0.1 }), el(u, v, r * 0.92, r * 0.84, h, 0.8, 'black', { sh: 'dome', tone: 0.9 }), el(u - r * 0.3, v - r * 0.25, r * 0.28, r * 0.25, h + 0.8, 0.4, 'hazard', { sh: 'dome', tone: 0.2 })];
}
function flareStack(u: number, v: number, h: number): Part[] {
  return [el(u, v, 0.7, 0.7, 0, h, 'black', { sh: 'cyl', tone: 0.8 }), el(u, v, 1.3, 1.3, h, 0.6, 'hazard', { sh: 'cyl' }), el(u + 0.2, v - 0.8, 1.9, 2.1, h + 0.6, 4.4, 'flame', { sh: 'dome', glow: true }), el(u + 0.2, v - 1.0, 0.9, 1.1, h + 3.4, 2.4, 'flame', { sh: 'dome', glow: true, tone: 1.2 })];
}
function oilModel(lv: number): Part[] {
  const P: Part[] = [];
  const stain = (u: number, v: number, ru: number, rv: number): Part => el(u, v, ru, rv, 0, 0, 'black', { a: 0.55 });
  if (lv >= 5) {
    P.push(stain(-8, -10, 12, 6), stain(-6, 6, 12, 6), stain(4, 18, 9, 4.4));
    P.push(...pumpjack(-14, -11, 1.3, 0.5), ...pumpjack(-14, 4, 1.3, -0.4), ...pumpjack(-3, 17, 1.3, 0.3));
    P.push(...oilTank(12, -10, 5.6, 6), ...oilTank(25, -10, 5.6, 6), ...oilTank(12, 3, 5.6, 6), ...oilTank(25, 3, 5.6, 6), ...oilTank(34, -3, 4, 4.6));
    P.push(...pipe(-7, -11, 6, -10), ...pipe(-7, 4, 6, 3), ...pipe(6, -10, 6, 3), ...pipe(18, -10, 19, -10), ...pipe(18, 3, 19, 3), ...pipe(6, 3, 6, 16), ...pipe(6, 16, -1, 17), ...pipe(30, -3, 31, -3));
    P.push(...flareStack(-24, 14, 20), bx(11, 12, 24, 20, 0, 3, 'cream', { tone: -0.3 }), ...gable(11, 12, 24, 20, 3, 'brick', { rh: 1.6, over: 0.4, metal: true }), ...truck(26, 15, 'cargo', 11));
  } else if (lv >= 3) {
    P.push(stain(-8, -9, 11, 5.4), stain(-8, 6, 11, 5.4));
    P.push(...pumpjack(-14, -9, 1.2, 0.45), ...pumpjack(-14, 6, 1.2, -0.35));
    P.push(...oilTank(10, -9, 5.2, 5.6), ...oilTank(22, -9, 5.2, 5.6), ...oilTank(16, 4, 5.2, 5.6));
    P.push(...pipe(-7, -9, 5, -9), ...pipe(-7, 6, 11, 5), ...pipe(5, -9, 5, 5), ...pipe(15, -9, 16, -9));
    P.push(...flareStack(-22, 15, 15), bx(-4, 12, 9, 18, 0, 2.8, 'cream', { tone: -0.3 }), ...gable(-4, 12, 9, 18, 2.8, 'brick', { rh: 1.4, over: 0.4, metal: true }), ...truck(15, 13, 'cargo', 10));
  } else {
    P.push(stain(-8, -2, 11, 5.4));
    P.push(...pumpjack(-11, -2, 1.2, 0.45));
    P.push(...oilTank(12, -4, 5.4, 5.6), ...oilTank(12, 9, 4, 4.2));
    P.push(...pipe(-4, -2, 8, -4), ...pipe(8, -4, 8, 8), ...pipe(8, 8, 10, 9));
    P.push(...flareStack(-18, 8, 12), bx(-4, 8, 4, 14, 0, 2.6, 'cream', { tone: -0.3 }), ...gable(-4, 8, 4, 14, 2.6, 'brick', { rh: 1.2, over: 0.4, metal: true }));
  }
  return P;
}

// ------------------------------------------------------------------------------------------------- barracks

/** A long hut with a pitched green roof, a stripe of the owner's colour along the ridge, windows on the south wall. */
function hut(u: number, v: number, w: number, d: number): Part[] {
  const P: Part[] = [bx(u, v, u + w, v + d, 0, 2.4, 'canvas', { tone: -0.2 }), ...gable(u, v, u + w, v + d, 2.4, 'camo', { rh: d * 0.38, over: 0.6, metal: true, alongU: true, })];
  P.push(band(u + 0.6, v + d * 0.5 - 0.35, u + w - 0.6, v + d * 0.5 + 0.35, 2.4 + d * 0.38 + 0.3));
  for (let x = u + 2; x < u + w - 2.4; x += 3.2) P.push(bx(x, v + d + 0.1, x + 1.4, v + d + 0.3, 0.4, 1.4, 'glass', { tone: 0.3 }));
  return P;
}
function guardPost(u: number, v: number): Part[] {
  return [bx(u, v, u + 4, v + 4, 0, 2.6, 'sup', { tone: -0.1 }), ...hip(u, v, u + 4, v + 4, 2.6, 'camo', { rh: 1.6, over: 0.5 }), bx(u + 0.4, v + 4, u + 3.6, v + 4.2, 0.8, 1.2, 'glass', { tone: 0.3 })];
}
/** A gate: two posts, an owner-coloured beam across, a striped barrier pole. */
function gate(u: number, v: number, w: number): Part[] {
  return [el(u, v, 0.7, 0.7, 0, 4.2, 'gun', { sh: 'cyl', tone: 0.6 }), el(u + w, v, 0.7, 0.7, 0, 4.2, 'gun', { sh: 'cyl', tone: 0.6 }), seg(u, v, u + w, v, 1.0, 4.2, 0.9, 'own'), seg(u + 0.8, v + 1.4, u + w * 0.62, v + 1.4, 0.55, 1.3, 0.5, 'hazard', { tone: 0.6 })];
}
function assaultCourse(u: number, v: number): Part[] {
  const P: Part[] = [];
  P.push(bx(u, v, u + 1.1, v + 8, 0, 2.2, 'teak', { pat: 'planks' }), seg(u + 3.4, v + 0.4, u + 3.4, v + 7.6, 1.0, 0.4, 0.9, 'teak', { sh: 'cyl' }), bx(u + 6, v, u + 7.2, v + 1.2, 0, 2.6, 'teak'), bx(u + 6, v + 6.8, u + 7.2, v + 8, 0, 2.6, 'teak'), bx(u + 6, v, u + 7.2, v + 8, 2.6, 0.4, 'canvas', { pat: 'grille' }));
  for (let i = 0; i < 4; i++) P.push(el(u + 9.8, v + 0.9 + i * 2.1, 0.95, 0.95, 0, 0.7, 'black', { sh: 'cyl', tone: 0.3 }));
  return P;
}
function barracksModel(lv: number): Part[] {
  const P: Part[] = [];
  if (lv >= 3) {
    P.push(bx(-23, -7, 20, 10, 0, 0, 'ochre', { tone: 0.8, pat: 'hatches' }));
    P.push(...hut(-26, -19, 17, 6), ...hut(-7, -19, 17, 6), ...hut(12, -19, 17, 6));
    P.push(...hut(-26, 12, 17, 6), ...hut(-7, 12, 17, 6));
    P.push(...flag(-1, 1, 0, 18, 7.4), el(-1, 1, 1.7, 1.4, 0, 0.7, 'sup', { sh: 'cyl', tone: 0.3 }));
    P.push(bx(23, -17, 35, -8, 0, 4.2, 'cream', { tone: -0.3 }), ...hip(23, -17, 35, -8, 4.2, 'camo', { rh: 2.6, over: 0.6 }), band(22.6, -8, 35.4, -7.2, 4.2));
    P.push(...gate(13, 15, 8), ...guardPost(23, 13), ...assaultCourse(24, -3));
    P.push(...truck(-22, 6, 'olive', 9), ...truck(-11, 6, 'olive', 9), bx(0, 5.6, 8, 9, 0.5, 2.0, 'olive', { tone: 0.2 }), el(4, 7.3, 2.1, 1.5, 2.5, 0.9, 'olive', { sh: 'dome', tone: 0.5 }), seg(4, 7.3, 9.6, 7.3, 0.9, 2.7, 0.7, 'black'));
    P.push(...tent(26, 11), ...tent(26, 17));
  } else {
    P.push(bx(-10, -6, 12, 8, 0, 0, 'ochre', { tone: 0.8, pat: 'hatches' }));
    P.push(...hut(-22, -16, 20, 6), ...hut(2, -16, 18, 6), ...hut(-22, 11, 20, 6));
    P.push(...flag(0, 1, 0, 14, 6), el(0, 1, 1.5, 1.2, 0, 0.6, 'sup', { sh: 'cyl', tone: 0.3 }));
    P.push(...gate(6, 12, 7), ...guardPost(15, 10), ...truck(-18, 3.4, 'olive', 9));
  }
  return P;
}
function tent(u: number, v: number): Part[] {
  return [bx(u, v, u + 5, v + 3.4, 0, 0.8, 'canvas', { tone: -0.5 }), ...gable(u, v, u + 5, v + 3.4, 0.8, 'canvas', { rh: 1.8, over: 0.3, alongU: true })];
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

/** A lookout tower: a tapering open lattice shaft, a lit top platform with a rail, a roofed cabin, a searchlight. */
function lookoutTower(u: number, v: number, lv: number): Part[] {
  const P: Part[] = [];
  const tall = lv >= 3;
  const H = tall ? 40 : 27;
  const n = tall ? 8 : 6;
  const wb = tall ? 5 : 4.4;
  const wt = tall ? 2.7 : 2.4;
  const mat: Mat = tall ? 'sup' : 'teak';
  for (let k = 0; k < n; k++) {
    const t0 = k / n;
    const t1 = (k + 1) / n;
    const w0 = wb + (wt - wb) * t0;
    const w1 = wb + (wt - wb) * t1;
    const wm = (w0 + w1) / 2;
    const z0 = H * t0;
    const dz = H / n;
    for (const [a, b] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) P.push(el(u + a * wm, v + b * wm, 0.65, 0.65, z0, dz, mat, { sh: 'cyl', tone: a < 0 ? 0.4 : -0.1 }));
    const zr = z0 + dz - 0.4;
    P.push(seg(u - w1, v + w1, u + w1, v + w1, 0.6, zr, 0.5, mat, { tone: 0.5 }), seg(u - w1, v - w1, u + w1, v - w1, 0.6, zr, 0.5, mat, { tone: 0.2 }), seg(u - w1, v - w1, u - w1, v + w1, 0.6, zr, 0.5, mat, { tone: 0.3 }), seg(u + w1, v - w1, u + w1, v + w1, 0.6, zr, 0.5, mat, { tone: -0.2 }));
    P.push(seg(u - w0, v + w0, u + w1, v + w1, 0.45, z0 + dz * 0.5, 0.4, mat, { tone: 0.6 }));
  }
  // the lit platform: pale, wide, with a dark rail round it, then the roofed cabin and the searchlight
  const pw = wt + 2.8;
  P.push(bx(u - pw, v - pw, u + pw, v + pw, H, 1.0, 'sup', { tone: 1.1 }), bx(u - pw, v - pw, u + pw, v + pw, H + 1.0, 1.6, 'black', { edge: true, tone: 0.6 }));
  const cw = wt + 0.9;
  P.push(bx(u - cw, v - cw, u + cw, v + cw, H + 1.0, 3.2, tall ? 'cream' : 'canvas', { tone: -0.1 }), bx(u - cw + 0.4, v + cw, u + cw - 0.4, v + cw + 0.2, H + 1.6, 1.4, 'glass', { tone: 0.6, pat: 'frames' }), bx(u - cw - 0.1, v - cw + 0.4, u - cw, v + cw - 0.4, H + 1.6, 1.4, 'glass', { tone: 0.4, pat: 'frames' }));
  P.push(...hip(u - cw, v - cw, u + cw, v + cw, H + 4.2, tall ? 'fieldgrey' : 'rust', { rh: 2.6, over: 1.0 }), band(u - cw - 0.8, v + cw + 1.0, u + cw + 0.8, v + cw + 1.7, H + 4.4));
  // the searchlight on the platform's south east corner, its beam pale
  P.push(el(u + pw - 0.9, v + pw - 0.9, 1.3, 1.1, H + 1.0, 1.4, 'gun', { sh: 'cyl', tone: 0.4 }), el(u + pw - 0.5, v + pw - 0.5, 0.9, 0.8, H + 2.4, 0.5, 'hazard', { glow: true, tone: 1 }), poly([u + pw, v + pw, u + pw + 7, v + pw + 2.2, u + pw + 2.2, v + pw + 7], H + 1.2, 0, 'hazard', { glow: true, a: 0.35 }));
  P.push(...flag(u - cw + 0.5, v - cw + 0.5, H + 6.4, tall ? 8 : 6, 4.2));
  if (tall) P.push(el(u + pw - 0.7, v - pw + 0.7, 0.45, 0.45, H + 1.0, 14, 'gun', { sh: 'cyl', tone: 0.7 }), el(u + pw - 0.7, v - pw + 0.7, 0.9, 0.9, H + 15, 0.6, 'own', { sh: 'dome' }), seg(u + pw - 3.4, v - pw + 0.7, u + pw + 2, v - pw + 0.7, 0.4, H + 11, 0.3, 'gun', { tone: 0.7 }));
  return P;
}
function watchtowerModel(lv: number): Part[] {
  const P: Part[] = [];
  const bag = (r1: number, r2: number): Part[] => sandRing(0, -4, r1, r2, 0, false);
  if (lv >= 3) {
    P.push(...bag(9.4, 8), ...lookoutTower(0, -4, 3));
    P.push(bx(-17, 5, -9, 11, 0, 2.6, 'cream', { tone: -0.3 }), ...gable(-17, 5, -9, 11, 2.6, 'camo', { rh: 1.4, over: 0.4, metal: true }), ...truck(8, 9, 'olive', 8));
  } else {
    P.push(...bag(8, 7), ...lookoutTower(0, -4, 1));
    P.push(bx(-15, 5, -8, 10, 0, 2.2, 'canvas', { tone: -0.3 }), ...gable(-15, 5, -8, 10, 2.2, 'camo', { rh: 1.3, over: 0.4, metal: true }), ...tree(11, 6, 2.4, 3));
  }
  return P;
}

// ------------------------------------------------------------------------------------------------- lab

function dish(u: number, v: number, r: number, z: number): Part[] {
  return [el(u, v, 1.0, 1.0, z, 1.4, 'gun', { sh: 'cyl', tone: 0.6 }), el(u, v - 0.8, r, r * 0.8, z + 1.4, 0.9, 'white', { sh: 'dome', tone: 0.3 }), el(u, v - 0.8, r * 0.5, r * 0.4, z + 2.1, 0.3, 'prublue', { sh: 'dome', tone: 0.3 }), seg(u, v - 0.8, u + r * 0.5, v - r * 0.9, 0.5, z + 2.5, 0.5, 'gun'), el(u + r * 0.52, v - r * 0.95, 0.55, 0.55, z + 2.5, 0.6, 'own')];
}
function solar(u: number, v: number, w: number, d: number): Part[] {
  const P: Part[] = [];
  for (let i = 0; i < w / 2.6; i++) P.push(bx(u + i * 2.6, v, u + i * 2.6 + 2.2, v + d, 0.5, 0.7, 'prublue', { tone: 0.3, pat: 'panels' }));
  return P;
}
/** A big white observatory dome with a dark slit and an owner-coloured collar. */
function observatory(u: number, v: number, r: number, z: number): Part[] {
  return [
    el(u, v, r * 1.14, r * 1.07, z, 1.0, 'sup', { sh: 'cyl', tone: 0.3 }),
    el(u, v, r * 1.14, r * 1.07, z + 0.9, 0.5, 'own', { sh: 'cyl', tone: 0.1 }),
    el(u, v, r, r * 0.94, z + 1.2, r * 1.15, 'white', { sh: 'dome', tone: 0.4 }),
    bx(u - 0.55, v - r * 0.95, u + 0.55, v + r * 0.1, z + 1.2 + r * 0.98, 0, 'black'),
    el(u - r * 0.3, v - r * 0.35, r * 0.22, r * 0.2, z + 1.2 + r * 1.1, 0.2, 'white', { sh: 'dome', tone: 1.2 }),
  ];
}
function labModel(lv: number): Part[] {
  const P: Part[] = [];
  const wing = (u0: number, v0: number, u1: number, v1: number, h: number, glass = true): void => {
    P.push(bx(u0, v0, u1, v1, 0, h, 'white', { tone: -0.2 }), bx(u0 + 0.6, v1 - 0.1, u1 - 0.6, v1 + 0.3, 0.6, h * 0.5, 'glass', { tone: 0.5, pat: 'frames' }));
    P.push(bx(u0 - 0.3, v0 - 0.3, u1 + 0.3, v1 + 0.3, h, 0.5, 'white', { tone: 0.9 }), bx(u0 - 0.3, v1 - 0.2, u1 + 0.3, v1 + 0.5, h, 0.8, 'prublue', { tone: 0.5 }), band(u0 - 0.3, v0 - 0.3, u0 + 0.5, v1 + 0.3, h + 0.5));
    P.push(bx(u0 + 0.6, v0 + 0.6, u1 - 0.6, v1 - 0.6, h + 0.5, 0, 'white', { inset: true, tone: 0.7 }));
    if (glass && u1 - u0 > 8) {
      P.push(bx(u0 + 2, v0 + 1.4, u1 - 2, v0 + 4.6, h + 0.5, 0.6, 'glass', { tone: 0.9, pat: 'frames' }), bx(u0 + 2, v0 + 1.4, u1 - 2, v0 + 1.8, h + 0.5, 0.9, 'prublue', { tone: 0.6 }));
      P.push(...ventPipe(u1 - 3, v1 - 3, h + 0.5), ...ventPipe(u1 - 5, v1 - 3, h + 0.5));
    }
  };
  if (lv >= 5) {
    wing(-24, -15, -2, 0, 6);
    wing(2, -15, 24, 0, 6);
    wing(-24, 4, -6, 18, 5);
    wing(-2, -2, 2, 10, 4.5, false);
    wing(6, 4, 24, 18, 6.8);
    P.push(...observatory(-13, -8, 5.6, 6), ...observatory(14, -8, 3.6, 6));
    P.push(...dish(15, 12, 4.8, 6.8), ...dish(-15, 12, 3.6, 5), ...solar(-3, 14, 5, 3));
    P.push(el(0, 4, 0.5, 0.5, 4.5, 18, 'gun', { sh: 'cyl', tone: 0.7 }), el(0, 4, 0.9, 0.9, 22.5, 0.8, 'own', { sh: 'cyl' }));
    P.push(...tree(-27, 8, 2.2, 1), ...tree(29, 12, 2.2, 3));
  } else if (lv >= 3) {
    wing(-20, -12, 4, 2, 5.6);
    wing(-20, 6, -6, 15, 4.6);
    wing(8, -12, 22, 8, 4.6);
    P.push(...observatory(-8, -5, 4.8, 5.6), ...dish(15, 12, 3.8, 0), ...solar(-3, 8, 8, 3));
    P.push(...tree(-24, 12, 2.2, 3));
  } else {
    wing(-14, -9, 10, 3, 4.4);
    P.push(...observatory(-4, -3, 4.0, 4.4), ...dish(15, 6, 3, 0), ...solar(-12, 7, 8, 3), ...tree(-19, 6, 2.2, 3));
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

/** A round silo lid: a hazard-striped ring, two door leaves; open slides one back to show the shaft and the missile nose. */
function hatch(u: number, v: number, r: number, open: boolean): Part[] {
  const P: Part[] = [];
  P.push(el(u, v, r * 1.22, r * 1.12, 0, 0.8, 'hazard', { sh: 'cyl', tone: -0.2 }), el(u, v, r * 1.04, r * 0.96, 0.8, 0.5, 'gun', { sh: 'cyl', tone: 0.4 }));
  if (open) {
    P.push(el(u, v, r * 0.9, r * 0.82, 1.3, 0, 'black'));
    P.push(bx(u - r * 0.96, v - r * 0.84, u - r * 0.1, v - r * 0.05, 1.3, 0.8, 'fieldgrey', { tone: 0.4, pat: 'panels', clip: [u, v, r * 0.98, r * 0.9] }));
    P.push(el(u, v - r * 0.2, r * 0.42, r * 0.36, 1.3, 7.4, 'white', { sh: 'cyl', tone: 0.5 }), el(u, v - r * 0.2, r * 0.42, r * 0.36, 8.7, 2.4, 'own', { sh: 'dome', tone: 0.2 }), el(u, v - r * 0.2, r * 0.46, r * 0.4, 4.2, 0.5, 'black', { sh: 'cyl' }));
  } else {
    P.push(bx(u - r * 0.96, v - r * 0.84, u - 0.35, v + r * 0.84, 1.3, 0.7, 'fieldgrey', { tone: 0.3, pat: 'panels', clip: [u, v, r * 0.98, r * 0.9] }), bx(u + 0.35, v - r * 0.84, u + r * 0.96, v + r * 0.84, 1.3, 0.7, 'fieldgrey', { tone: -0.1, pat: 'panels', clip: [u, v, r * 0.98, r * 0.9] }));
    P.push(bx(u - 0.35, v - r * 0.84, u + 0.35, v + r * 0.84, 1.3, 0.2, 'black'), bx(u - r * 0.66, v - 0.5, u - r * 0.14, v + 0.5, 2.0, 0, 'own'), bx(u + r * 0.14, v - 0.5, u + r * 0.66, v + 0.5, 2.0, 0, 'own'));
  }
  return P;
}
/** Thick sloped concrete blast walls curving round the back of a silo (open to the south). */
function blastWall(u: number, v: number, r: number): Part[] {
  const P: Part[] = [];
  const n = 7;
  for (let i = 0; i < n; i++) {
    const a = Math.PI * (1.12 + (i / (n - 1)) * 0.76);
    const cu = u + Math.cos(a) * (r + 2.6);
    const cv = v + Math.sin(a) * (r + 2.2);
    P.push(el(cu, cv, 2.1, 1.8, 0, 3.6, 'sup', { sh: 'dome', tone: Math.cos(a) < 0 ? 0.3 : -0.3 }));
  }
  return P;
}
/** A bunker entrance: an earth mound with a stepped ramp down to a dark blast door under a hazard lintel. */
function bunkerRamp(u: number, v: number): Part[] {
  const P: Part[] = [el(u, v - 1, 7.6, 5.2, 0, 3.4, 'olive', { sh: 'dome', tone: -0.3 }), el(u - 1.2, v - 2, 4.6, 3.2, 2.6, 2, 'camo', { sh: 'dome', tone: 0.7 })];
  for (let i = 0; i < 4; i++) P.push(bx(u - 3.4 + i * 0.3, v + 2.6 + i * 1.4, u + 3.4 - i * 0.3, v + 3.9 + i * 1.4, 0, 0.6 + (3 - i) * 0.0, 'sup', { tone: 0.8 - i * 0.35 }));
  P.push(bx(u - 2.2, v + 2.4, u + 2.2, v + 3.2, 0, 2.6, 'black', { tone: 0.4 }), bx(u - 3, v + 2.1, u + 3, v + 2.6, 2.6, 0.7, 'hazard'), bx(u - 3, v + 2.1, u - 2.2, v + 2.6, 0, 2.6, 'sup', { tone: 0.2 }), bx(u + 2.2, v + 2.1, u + 3, v + 2.6, 0, 2.6, 'sup', { tone: -0.2 }));
  return P;
}
function radarMast(u: number, v: number, h: number): Part[] {
  return [bx(u - 1.4, v - 1.4, u + 1.4, v + 1.4, 0, 1.2, 'sup', { tone: -0.2 }), el(u, v, 0.45, 0.45, 1.2, h, 'gun', { sh: 'cyl', tone: 0.8 }), seg(u - 3.2, v, u + 3.2, v, 1.0, h, 0.9, 'alu', { tone: 0.5 }), el(u + 3.2, v, 0.8, 0.8, h, 1.0, 'own', { sh: 'dome' }), el(u, v, 1.0, 1.0, h + 0.9, 1.0, 'gun', { sh: 'dome', tone: 0.6 })];
}
/** A dotted perimeter: a thin ring of posts far out. */
function postRing(rx: number, ry: number, cv: number, n: number): Part[] {
  const P: Part[] = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    if (Math.sin(a) > 0.9 && Math.abs(Math.cos(a)) < 0.3) continue;
    P.push(el(Math.cos(a) * rx, cv + Math.sin(a) * ry, 0.4, 0.4, 0, 1.5, 'gun', { sh: 'cyl', tone: 0.7 }));
  }
  return P;
}
function siloModel(lv: number): Part[] {
  const P: Part[] = [];
  if (lv >= 3) {
    // a wide round pad with a ring of inset panels, three lids (the middle one open, its missile nose showing)
    P.push(el(0, 0, 27, 19, 0, 0.7, 'sup', { tone: -0.5 }), el(0, 0, 25.6, 17.8, 0.7, 0, 'sup', { tone: -0.1, pat: 'panels', inset: true }));
    P.push(...hatch(-15, -3, 5.4, false), ...hatch(0, -3, 5.4, true), ...hatch(15, -3, 5.4, false));
    P.push(...blastWall(-15, -3, 5.4), ...blastWall(0, -3, 5.4), ...blastWall(15, -3, 5.4));
    P.push(...bunkerRamp(-4, 11), ...radarMast(19, 10, 16), ...radarMast(-21, 10, 11), ...postRing(30, 21, 0, 26));
  } else {
    P.push(el(0, 0, 16, 13, 0, 0.7, 'sup', { tone: -0.5 }), el(0, 0, 14.8, 11.8, 0.7, 0, 'sup', { tone: -0.1, pat: 'panels', inset: true }));
    P.push(...hatch(0, -2, 6, false), ...blastWall(0, -2, 6));
    P.push(...bunkerRamp(9, 7), ...radarMast(-11, 6, 12), ...postRing(21, 17, 0, 20));
  }
  return P;
}

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
    if (p.m === 'foam' || p.glow || (p.a ?? 1) < 1) continue;
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
  if (type === 'watchtower') {
    // the long sharp cast shadow of a tall tower: a tapering band to the lower right ending in the platform's shadow
    const H = lv >= 3 ? 40 : 27;
    const du = H * 0.62 * 0.8;
    const dv = H * 0.5 * 0.8;
    const a = far ? 0.8 : 0.9;
    g.strip('shadow', 0, -4, du * 0.5, -4 + dv * 0.5, 5.4, a, 41);
    g.strip('shadow', du * 0.3, -4 + dv * 0.3, du * 0.78, -4 + dv * 0.78, 4.2, a, 42);
    g.strip('shadow', du * 0.6, -4 + dv * 0.6, du, -4 + dv, 3.2, a, 43);
    g.blob('shadow', du + 1, -4 + dv + 1, 5.6, 4.2, a, 0.3, 44);
  }
  if (type === 'silo') {
    const rx = lv >= 3 ? 29 : 18;
    const ry = lv >= 3 ? 21 : 15;
    g.blob('dark', 0, 1, rx + 6 + wide, ry + 6 + wide, far ? 0.38 : 0.45, 0.4, 31);
    g.blob('dirt', 0, 1, rx, ry, far ? 0.5 : 0.7, 0.3, 32);
    if (!far) g.strip('dark', -3, ry - 2, -3, ry + 12, 3, 0.5, 34);
    return;
  }
  if (type === 'oilWell') {
    g.slab('dark', u0 - 4 - wide, v0 - 3 - wide, u1 + 4 + wide, v1 + 6 + wide, 7, far ? 0.4 : 0.45, far ? 9 : 5, 31);
    g.slab('dirt', u0 - 2, v0 - 1.4, u1 + 2, v1 + 3, 5, far ? 0.55 : 0.8, far ? 6 : 3, 32);
    return;
  }
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
    case 'lab':
      g.slab('road', u0 - 2, v1 - 8, u1, v1 + 1, 2, 0.35, 1.6, 33);
      break;
    case 'hospital':
      g.strip('road', 0, v1, 4, v1 + 9, 3.4, 0.5, 33);
      break;
    case 'airfield':
      g.slab('road', u0 - 1, 5, u1 + 1, 19, 2, 0.35, 1.6, 33);
      break;
  }
}

void hash;
