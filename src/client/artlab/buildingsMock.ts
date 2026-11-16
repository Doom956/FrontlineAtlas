// The art lab's "Buildings mockup" (art lab builds only): map buildings in the troops' own shaded pixel style, seen from
// above. Each building is a model of parts (the game's detailed-style part format, art/detailed/bake.ts) rasterized by
// the game's own unit rasterizer, so it has the units' pixel density, 4 tone material ramps, top-left light, ordered
// dither on the tone borders, rim shading and the owner-coloured outline ring with a dark outer edge (outline.ts).
// Nothing grey sits under a building. The ground round it is painted from the terrain colour under it (a contact
// shadow cast by the real parts, dirt yards, paths, a moat, a shore) as soft, dithered shades of that colour.
// The level is a small dark pill like the army count pill. It is a MOCKUP: the game's map still draws buildings with
// render/buildings.ts. Flak, tank traps, the radar dish and coastal guns are not game features yet; they are visual
// add-ons here. Everything is drawn in code (no image files). No module-level side effects.
import { drawMarker, ICON_INFO, type BuildingIconId } from '../icons';
import { CATEGORY_PLATES } from '../render/buildings';
import { buildTerrain, TERRAIN_RGB, waterRGB } from '../render/terrain';
import { themeForMap } from '../render/mapThemes';
import { makeCanvas, MAP_NUM_FAMILY } from '../render/common';
import { troopPill, type TroopIconKind } from '../render/troopIcons';
import { isWater, type MapData } from '../../sim/types';
import { decodeWorldMapBlob } from '../../sim/worldmaps';
import balticBlob from '../../maps/data/baltic';
import type { RGB } from '../art/shared/colour';
import { motionParams } from '../art/motion';
import { FORE, rasterize, type Baked, type Part, type Pattern } from '../art/detailed/bake';
import { gridOf } from '../art/detailed/grid';
import { outlineOf, ringWidth } from '../art/detailed/outline';
import { box, ell, grown, poly, seg } from '../art/detailed/shapes';
import { detailedUnits } from '../art/detailed/units';
import type { SpriteKey } from '../art/shared/keys';
import type { UnitDraw } from '../art/types';
import { backdrop } from './backdrop';
import { label } from './scenes';

/** The cell a building is baked into, in model units (1 unit = 1 map screen px at mid zoom, like the units). */
const CU = 68;
const CV = 73;
/** where the model origin (u 0, v 0, on the ground) sits in the cell, in model units (room above for skyscrapers, room right and below for their long shadows) */
const OU = 29;
const OV = 47;
const SCALE_CLOSE = 3;
const SCALE_NORMAL = 1.5;

type C = readonly number[];
type Mat = Part['m'];

// ------------------------------------------------------------------------------------------------- small helpers

const cl = (v: number): number => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));
const dark = (c: C, f: number): RGB => [cl(c[0] * f), cl(c[1] * f), cl(c[2] * f)];
const mix = (a: C, b: C, t: number): RGB => [cl(a[0] + (b[0] - a[0]) * t), cl(a[1] + (b[1] - a[1]) * t), cl(a[2] + (b[2] - a[2]) * t)];
/** deterministic 0..1 noise from two integers (no Math.random) */
function hash(x: number, y: number, s = 0): number {
  let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(s, 144665)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}
/** smooth value noise 0..1 */
function vnoise(x: number, y: number, s: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const a = hash(x0, y0, s);
  const b = hash(x0 + 1, y0, s);
  const c = hash(x0, y0 + 1, s);
  const d = hash(x0 + 1, y0 + 1, s);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}
const BAYER4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
const bayer = (x: number, y: number): number => (BAYER4[(y & 3) * 4 + (x & 3)] + 0.5) / 16;

// ------------------------------------------------------------------------------------------------- the part models

type Addon = 'flak' | 'traps' | 'radar' | 'guns' | null;

export interface BuildingSpec {
  type: 'fort' | 'city' | 'sam' | 'port';
  level: number;
  addon: Addon;
}

const bx = box;
const el = ell;

interface RoofOpt {
  rh?: number;
  over?: number;
  /** corrugated metal (lines run down the slope) instead of tiles (courses across it) */
  metal?: boolean;
  /** the ridge runs along u (default: along the longer side) */
  alongU?: boolean;
}
/** A gable roof over a footprint: a lit slope, a darker slope, a bright ridge cap, tile courses or metal corrugation on both. */
function gable(u0: number, v0: number, u1: number, v1: number, z: number, m: Mat, o: RoofOpt = {}): Part[] {
  const rh = o.rh ?? 1.4;
  const ov = o.over ?? 0.5;
  const a = u0 - ov;
  const b = v0 - ov;
  const c = u1 + ov;
  const d = v1 + ov;
  const alongU = o.alongU ?? c - a >= d - b;
  if (alongU) {
    const vm = (b + d) / 2;
    const pat: Pattern = o.metal ? 'grille' : 'planks';
    return [bx(a, b, c, vm, z, rh, m, { tone: 0.8, pat }), bx(a, vm, c, d, z, rh * 0.6, m, { tone: -1, pat }), bx(a, vm - 0.22, c, vm + 0.22, z + rh, 0.25, m, { tone: 1.6 })];
  }
  const um = (a + c) / 2;
  const pat: Pattern = o.metal ? 'planks' : 'grille';
  return [bx(a, b, um, d, z, rh, m, { tone: 0.8, pat }), bx(um, b, c, d, z, rh * 0.6, m, { tone: -1, pat }), bx(um - 0.22, b, um + 0.22, d, z + rh, 0.25, m, { tone: 1.6 })];
}
/** A hip roof: four slopes (lit north and west, shaded south and east) meeting in a ridge or a point. */
function hip(u0: number, v0: number, u1: number, v1: number, z: number, m: Mat, o: RoofOpt = {}): Part[] {
  const rh = o.rh ?? 1.6;
  const ov = o.over ?? 0.5;
  const a = u0 - ov;
  const b = v0 - ov;
  const c = u1 + ov;
  const d = v1 + ov;
  const s = Math.min(rh * 1.6, Math.min(c - a, d - b) / 2);
  const vm = (b + d) / 2;
  const um = (a + c) / 2;
  const tp: Pattern = o.metal ? 'grille' : 'planks';
  const P: Part[] = [
    poly([a, b, c, b, c - s, b + s, a + s, b + s], z, rh, m, { tone: 0.7, pat: tp }),
    poly([a, b, a + s, b + s, a + s, d - s, a, d], z, rh, m, { tone: 1.0, pat: 'grille' }),
    poly([c, b, c, d, c - s, d - s, c - s, b + s], z, rh, m, { tone: -1.3, pat: 'grille' }),
    poly([a, d, a + s, d - s, c - s, d - s, c, d], z, rh, m, { tone: -0.9, pat: tp }),
  ];
  if (c - a - 2 * s > 0.4) P.push(bx(a + s, vm - 0.2, c - s, vm + 0.2, z + rh, 0.25, m, { tone: 1.6 }));
  else if (d - b - 2 * s > 0.4) P.push(bx(um - 0.2, b + s, um + 0.2, d - s, z + rh, 0.25, m, { tone: 1.6 }));
  else P.push(el(um, vm, 0.5, 0.5, z + rh, 0.5, m, { sh: 'dome', tone: 1 }));
  return P;
}
/** A pitched roof over a footprint (a gable). */
const roof = (u0: number, v0: number, u1: number, v1: number, z: number, m: Mat, rh = 1.3, over = 0.5, metal = false): Part[] => gable(u0, v0, u1, v1, z, m, { rh, over, metal });
/** A brick chimney with a dark flue. */
const chimney = (u: number, v: number, z: number, h: number): Part[] => [bx(u, v, u + 1.1, v + 1.1, z, h, 'brick', { tone: -0.2 }), bx(u + 0.25, v + 0.25, u + 0.85, v + 0.85, z + h, 0, 'black')];
/** A rooftop air-conditioning unit: a grilled casing with a dark fan. */
const acUnit = (u: number, v: number, z: number): Part[] => [bx(u, v, u + 2.4, v + 1.7, z, 1.1, 'alu', { tone: -0.2, pat: 'grille' }), el(u + 0.8, v + 0.85, 0.55, 0.5, z + 1.1, 0, 'gun')];
const skylight = (u: number, v: number, z: number, w = 2, d = 1.3): Part[] => [bx(u - 0.2, v - 0.2, u + w + 0.2, v + d + 0.2, z, 0.5, 'sup', { tone: 0.3 }), bx(u, v, u + w, v + d, z + 0.5, 0, 'glass', { tone: 0.3, pat: 'frames' })];
const ventPipe = (u: number, v: number, z: number): Part[] => [el(u, v, 0.45, 0.45, z, 1.6, 'gun', { sh: 'cyl', tone: 0.7 }), el(u, v, 0.7, 0.7, z + 1.6, 0.25, 'alu', { sh: 'dome' })];
const waterTank = (u: number, v: number, z: number): Part[] => [el(u, v, 1.3, 1.2, z, 2.3, 'canvas', { sh: 'cyl', tone: -0.2 }), el(u, v, 1.35, 1.25, z + 2.3, 0.5, 'alu', { sh: 'dome', tone: 0.3 })];
/** Gear scattered on a flat roof: units, skylights, vents, a stair box, a tank, picked by a seed. */
function roofGear(u0: number, v0: number, u1: number, v1: number, z: number, seed: number, simple: boolean): Part[] {
  const P: Part[] = [];
  const w = u1 - u0;
  const d = v1 - v0;
  if (w < 5 || d < 3.4) return [...ventPipe((u0 + u1) / 2, (v0 + v1) / 2, z)];
  const n = simple ? 2 : 3;
  for (let i = 0; i < n; i++) {
    const kind = Math.floor(hash(seed, i, 5) * 5);
    const fu = u0 + 0.9 + ((i + 0.3 + hash(seed, i, 6) * 0.4) / n) * (w - 4.4);
    const fv = v0 + 0.9 + hash(seed, i, 7) * Math.max(0, d - 3.8);
    if (kind === 0) P.push(...acUnit(fu, fv, z));
    else if (kind === 1) P.push(...skylight(fu, fv, z, 2.2, 1.3));
    else if (kind === 2) P.push(...bx2(fu, fv, z));
    else if (kind === 3) P.push(...waterTank(fu + 1.2, fv + 1.2, z));
    else P.push(...ventPipe(fu + 0.5, fv + 0.5, z), ...acUnit(fu + 1.3, fv + 0.2, z));
  }
  return P;
}
/** A roof stair house. */
const bx2 = (u: number, v: number, z: number): Part[] => [bx(u, v, u + 2.4, v + 2, z, 1.8, 'sup', { tone: 0.1 }), bx(u + 0.4, v + 2, u + 1.4, v + 2.14, z, 1.2, 'black', { tone: 0.5 })];
/** A tree: a round crown with a lighter top, in the muted greens. */
const tree = (u: number, v: number, r: number, seed = 0): Part[] => [
  el(u, v, r, r * 0.92, 0.5, 2.4, hash(seed, 3) > 0.5 ? 'camo' : 'olive', { sh: 'dome', tone: 0.3 }),
  el(u - r * 0.25, v - r * 0.25, r * 0.5, r * 0.45, 2.9, 0.8, 'olive', { sh: 'dome', tone: 0.7 }),
];
/** Polygon points of a rectangle shrunk by m. */
const ptsRect = (u0: number, v0: number, u1: number, v1: number, m = 0): number[] => [u0 + m, v0 + m, u1 - m, v0 + m, u1 - m, v1 - m, u0 + m, v1 - m];
/** An L footprint: the rectangle less its north-east corner (cw wide, cd deep), shrunk by m, optionally mirrored west to east. */
function ptsL(u0: number, v0: number, u1: number, v1: number, cw: number, cd: number, m: number, flipU: boolean): number[] {
  const p = [u0 + m, v0 + m, u1 - cw - m, v0 + m, u1 - cw - m, v0 + cd + m, u1 - m, v0 + cd + m, u1 - m, v1 - m, u0 + m, v1 - m];
  if (!flipU) return p;
  const out: number[] = [];
  for (let i = 0; i < p.length; i += 2) out.push(u0 + u1 - p[i], p[i + 1]);
  return out;
}
/** A T footprint: a bar along the north (bd deep) and a stem (sw wide) running south from its middle, shrunk by m. */
function ptsT(u0: number, v0: number, u1: number, v1: number, sw: number, bd: number, m: number): number[] {
  const um = (u0 + u1) / 2;
  return [u0 + m, v0 + m, u1 - m, v0 + m, u1 - m, v0 + bd - m, um + sw / 2 - m, v0 + bd - m, um + sw / 2 - m, v1 - m, um - sw / 2 + m, v1 - m, um - sw / 2 + m, v0 + bd - m, u0 + m, v0 + bd - m];
}
/** A house: walls and a gable or hip roof, with a chimney. */
function house(u0: number, v0: number, u1: number, v1: number, z: number, roofM: Mat, wall: Mat = 'cream', o: { hip?: boolean; chim?: number; metal?: boolean } = {}): Part[] {
  const P: Part[] = [bx(u0, v0, u1, v1, 0, z, wall, { tone: -0.4 })];
  const rh = Math.min(2, Math.max(1.2, Math.min(u1 - u0, v1 - v0) * 0.3));
  P.push(...(o.hip ? hip(u0, v0, u1, v1, z, roofM, { rh, metal: o.metal }) : gable(u0, v0, u1, v1, z, roofM, { rh, metal: o.metal })));
  if (o.chim !== undefined) P.push(...chimney(u0 + (u1 - u0) * o.chim, v0 + 0.5, z, rh + 1.3));
  return P;
}
/** An L house: an L of walls, a gable along each wing, the east-west one lower, a chimney. */
function houseL(u0: number, v0: number, u1: number, v1: number, z: number, roofM: Mat, wall: Mat, flipU: boolean): Part[] {
  const ww = (u1 - u0) * 0.5;
  const wd = (v1 - v0) * 0.55;
  const P: Part[] = [poly(ptsL(u0, v0, u1, v1, u1 - u0 - ww, v1 - v0 - wd, 0, flipU), 0, z, wall, { tone: -0.4 })];
  const a0 = flipU ? u1 - ww : u0;
  const a1 = flipU ? u1 : u0 + ww;
  P.push(...gable(u0, v1 - wd, u1, v1, z - 0.5, roofM, { rh: 1.2, alongU: true }));
  P.push(...gable(a0, v0, a1, v1, z, roofM, { rh: 1.5, alongU: false }));
  P.push(...chimney(flipU ? a1 - 1.8 : a0 + 0.8, v0 + 0.8, z, 2.6));
  return P;
}
/** A T house: a bar gable and a lower stem gable, two chimneys. */
function houseT(u0: number, v0: number, u1: number, v1: number, z: number, roofM: Mat, wall: Mat): Part[] {
  const bd = (v1 - v0) * 0.5;
  const sw = (u1 - u0) * 0.42;
  const um = (u0 + u1) / 2;
  return [
    poly(ptsT(u0, v0, u1, v1, sw, bd, 0), 0, z, wall, { tone: -0.4 }),
    ...gable(um - sw / 2, v0 + bd - 0.4, um + sw / 2, v1, z - 0.5, roofM, { rh: 1.2, alongU: false }),
    ...gable(u0, v0, u1, v0 + bd, z, roofM, { rh: 1.5, alongU: true }),
    ...chimney(u0 + 1.4, v0 + 0.5, z, 2.6),
    ...chimney(u1 - 2.6, v0 + 0.5, z, 2.6),
  ];
}
/** A flag: a pole standing up and a small flag in the owner's colour. */
function flag(u: number, v: number, z: number, h: number, w = 3.2): Part[] {
  return [el(u, v, 0.3, 0.3, z, h, 'gun', { sh: 'cyl', tone: 1 }), bx(u + 0.3, v - 0.5, u + 0.3 + w, v + 1.0, z + h - 1.5, 1.4, 'own')];
}
/** A thin band of the owner's colour lying on a roof or wall top. */
const band = (u0: number, v0: number, u1: number, v1: number, z: number): Part => bx(u0, v0, u1, v1, z, 0.35, 'own');
/** A round tower: a stone drum with a crenellated ring and a stepped conical slate cap. */
function tower(u: number, v: number, r: number, z: number, cap: Mat = 'rust'): Part[] {
  return [
    el(u, v, r, r * 0.9, 0, z, 'sup', { sh: 'cyl', tone: -0.2 }),
    el(u, v, r * 1.05, r * 0.95, z, 0.9, 'sup', { sh: 'cyl', tone: 0.5 }),
    el(u, v, r * 0.9, r * 0.8, z + 0.9, 1.3, cap, { sh: 'dome', tone: 0.5 }),
    el(u, v, r * 0.62, r * 0.55, z + 2.2, 1.3, cap, { sh: 'dome', tone: 0.8 }),
    el(u, v, r * 0.34, r * 0.3, z + 3.5, 1.2, cap, { sh: 'dome', tone: 1.1 }),
  ];
}
function merlonsH(u0: number, u1: number, v: number, z: number, step = 2.4): Part[] {
  const out: Part[] = [];
  for (let u = u0; u < u1 - 0.9; u += step) out.push(bx(u, v, u + 1.2, v + 0.9, z, 1.1, 'sup', { tone: 0.5 }));
  return out;
}
function merlonsV(v0: number, v1: number, u: number, z: number, step = 2.4): Part[] {
  const out: Part[] = [];
  for (let v = v0; v < v1 - 0.9; v += step) out.push(bx(u, v, u + 0.9, v + 1.2, z, 1.1, 'sup', { tone: 0.5 }));
  return out;
}
function hedgehog(u: number, v: number): Part[] {
  const o = { sh: 'cyl' as const, tone: 0.5 };
  return [seg(u - 1.2, v - 1.0, u + 1.2, v + 1.0, 0.8, 0.5, 0.8, 'gun', o), seg(u - 1.2, v + 1.0, u + 1.2, v - 1.0, 0.8, 0.5, 0.8, 'gun', o), seg(u, v - 1.4, u, v + 1.4, 0.8, 0.5, 0.8, 'gun', o)];
}
/**
 * A gun barrel: a near-black round tube with a thin light stripe along its lit (upper left) side, so it reads on any
 * ground. From (u0, v0) to (u1, v1), `w` wide, standing at height z.
 */
function barrel(u0: number, v0: number, u1: number, v1: number, w: number, z: number): Part[] {
  const du = u1 - u0;
  const dv = v1 - v0;
  const L = Math.hypot(du, dv) || 1;
  let nu = -dv / L;
  let nv = du / L;
  if (nu + nv > 0) {
    nu = -nu;
    nv = -nv;
  }
  const o = w * 0.2;
  return [seg(u0, v0, u1, v1, w, z, w * 0.9, 'black', { sh: 'cyl', tone: 0.3 }), seg(u0 + nu * o, v0 + nv * o, u1 + nu * o, v1 + nv * o, w * 0.32, z + w * 0.9, 0.25, 'alu', { tone: 0.7 })];
}
/** A round sandbag emplacement: a ring of pale sandbags round a pit of trodden earth (z is the height it stands at). */
function sandRing(u: number, v: number, ru: number, rv: number, z: number, simple: boolean): Part[] {
  const P: Part[] = [el(u, v, ru, rv, z, 0, 'tan', { inset: true, tone: -1.2 })];
  const n = Math.max(9, Math.round((Math.PI * (ru + rv)) / (simple ? 2.1 : 1.8)));
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + 0.3;
    P.push(el(u + Math.cos(a) * (ru - 0.5), v + Math.sin(a) * (rv - 0.4), 1.15, 0.9, z, 1.1, 'canvas', { sh: 'dome', tone: i % 3 === 0 ? 0.6 : i % 3 === 1 ? 0.1 : -0.2 }));
  }
  return P;
}
/** An anti-aircraft gun: a round sandbag ring, a mount in the owner's colour, a dark gun house and two long barrels pointing up to the right. */
function flakGun(u: number, v: number, simple = false): Part[] {
  return [
    ...sandRing(u, v, 4.4, 3.7, 0, simple),
    el(u, v, 2.3, 1.9, 0.4, 1.0, 'own', { sh: 'dome', tone: 0.2 }),
    bx(u - 1.5, v - 0.8, u + 1.5, v + 1.5, 1.4, 1.2, 'black', { tone: 0.2 }),
    ...barrel(u + 0.4, v - 0.7, u + 7.4, v - 4.1, 1.15, 2.0),
    ...barrel(u + 0.4, v + 0.7, u + 7.4, v - 2.7, 1.15, 2.0),
    el(u + 7.5, v - 4.1, 0.75, 0.75, 2.0, 1.3, 'gun', { tone: 0.2 }),
    el(u + 7.5, v - 2.7, 0.75, 0.75, 2.0, 1.3, 'gun', { tone: 0.2 }),
  ];
}
function radarDish(u: number, v: number, simple = false): Part[] {
  if (simple) return [el(u, v, 1.0, 1.0, 0, 4.0, 'gun', { sh: 'cyl', tone: 0.8 }), el(u, v - 1.0, 4.4, 3.4, 4.0, 0.9, 'alu', { sh: 'dome' })];
  return [
    bx(u - 2.4, v + 0.4, u + 2.4, v + 3.2, 0, 1.4, 'canvas', { tone: -0.2 }),
    el(u, v, 1.0, 1.0, 1.4, 4.0, 'gun', { sh: 'cyl', tone: 0.8 }),
    el(u, v - 1.0, 4.4, 3.4, 5.4, 0.8, 'alu', { sh: 'dome' }),
    seg(u, v - 1.0, u + 2.8, v - 3.4, 0.6, 6.3, 0.8, 'gun'),
    el(u + 3.0, v - 3.6, 0.6, 0.6, 6.3, 0.9, 'own'),
  ];
}

// ---- fort

/** A stone wall run with a worn walkway on top (the merlons are added by the caller). */
function wallRun(u0: number, v0: number, u1: number, v1: number, wz: number): Part[] {
  return [bx(u0, v0, u1, v1, 0, wz, 'sup', { tone: -0.3, pat: 'planks' })];
}
function fortModel(lv: number, addon: Addon, simple = false): Part[] {
  const cfg = lv >= 5 ? { w: 36, d: 24, t: 3.2, wz: 8, tz: 12, r: 4.0 } : lv >= 3 ? { w: 30, d: 20, t: 2.8, wz: 6, tz: 9, r: 3.3 } : { w: 24, d: 15, t: 2.2, wz: 4.2, tz: 6.5, r: 2.6 };
  const { w, d, t, wz, tz, r } = cfg;
  const x0 = -w / 2;
  const x1 = w / 2;
  const y0 = -d / 2;
  const y1 = d / 2;
  const gate = lv >= 5 ? 4.6 : 3.6;
  const P: Part[] = [];
  // the courtyard floor: trampled earth with a worn flagstone lane from the gate
  P.push(bx(x0 + t, y0 + t, x1 - t, y1 - t, 0, 0, 'tan', { inset: true, tone: -1.2 }));
  P.push(bx(-1.6, y0 + t + 3, 1.6, y1 - t, 0, 0, 'tan', { tone: 0.3, pat: 'hatches' }));
  // the wall ring (the south wall has the gate gap), with a darker walkway behind the merlons
  P.push(...wallRun(x0, y0, x1, y0 + t, wz), ...wallRun(x0, y0, x0 + t, y1, wz), ...wallRun(x1 - t, y0, x1, y1, wz), ...wallRun(x0, y1 - t, -gate, y1, wz), ...wallRun(gate, y1 - t, x1, y1, wz));
  P.push(bx(x0 + 1.4, y0 + 1.2, x1 - 1.4, y0 + t - 0.3, wz, 0, 'tan', { inset: true, tone: -0.9 }), bx(x0 + 1.2, y0 + 1.4, x0 + t - 0.3, y1 - 1.4, wz, 0, 'tan', { inset: true, tone: -0.9 }), bx(x1 - t + 0.3, y0 + 1.4, x1 - 1.2, y1 - 1.4, wz, 0, 'tan', { inset: true, tone: -0.9 }));
  P.push(...merlonsH(x0 + 1, x1 - 1, y0 + 0.2, wz), ...merlonsH(x0 + 1, -gate - 0.5, y1 - 1.1, wz), ...merlonsH(gate + 0.5, x1 - 1, y1 - 1.1, wz));
  P.push(...merlonsV(y0 + 2, y1 - 2, x0 + 0.2, wz), ...merlonsV(y0 + 2, y1 - 2, x1 - 1.1, wz));
  // buttresses against the outer faces
  if (!simple) {
    for (let u = x0 + r + 2.5; u < x1 - r - 2; u += 5.5) P.push(bx(u, y0 - 0.9, u + 1.5, y0, 0, wz * 0.72, 'sup', { tone: 0.1 }));
    for (let v = y0 + r + 2; v < y1 - r - 1; v += 5.5) P.push(bx(x0 - 0.9, v, x0, v + 1.5, 0, wz * 0.72, 'sup', { tone: 0.1 }), bx(x1, v, x1 + 0.9, v + 1.5, 0, wz * 0.72, 'sup', { tone: 0.1 }));
  }
  // the gate house: stone piers either side of a dark arch with a portcullis, a tiled hip roof, the owner's band on its ridge
  P.push(bx(-gate - 0.9, y1 - t - 0.6, -gate + 0.4, y1 + 0.4, 0, wz + 1.2, 'sup', { tone: 0.1 }), bx(gate - 0.4, y1 - t - 0.6, gate + 0.9, y1 + 0.4, 0, wz + 1.2, 'sup', { tone: 0.1 }));
  P.push(bx(-gate, y1 - t - 0.2, gate, y1 + 0.3, 0, wz + 1.0, 'cream', { tone: -0.2 }));
  P.push(...hip(-gate - 0.9, y1 - t - 0.6, gate + 0.9, y1 + 0.4, wz + 1.2, 'rust', { rh: 1.6, over: 0.3 }));
  P.push(bx(-gate * 0.66, y1 + 0.3, gate * 0.66, y1 + 0.9, 0, (wz + 1.0) * 0.66, 'black', { tone: 0.5 }), bx(-gate * 0.66, y1 + 0.9, gate * 0.66, y1 + 1.3, 0.6, (wz + 1.0) * 0.5, 'gun', { tone: 0.4, pat: 'grille' }));
  P.push(band(-gate - 0.2, y1 - 1.6, gate + 0.2, y1 - 0.8, wz + 2.8));
  // what stands inside
  if (lv <= 1) {
    P.push(...house(-8.4, -3.9, 0.6, -0.3, 3.0, 'rust', 'cream', { chim: 0.7 }), ...house(3.2, -3.8, 8.6, 0.8, 2.6, 'brick', 'canvas', { hip: true }));
    // a well, a haystack, a heap of crates
    P.push(el(4.6, 3, 1.3, 1.2, 0, 1.1, 'sup', { sh: 'cyl', tone: 0.3 }), el(4.6, 3, 0.85, 0.75, 1.1, 0, 'sea'), el(-6.2, 2.9, 2.0, 1.6, 0, 2.1, 'ochre', { sh: 'dome', tone: 0.3 }), bx(-2.6, 2.6, -0.8, 3.9, 0, 1.2, 'teak', { pat: 'planks' }), bx(-1.0, 3.0, 0.4, 4.1, 0, 0.9, 'teak', { pat: 'planks', tone: -0.3 }), bx(-2.2, 2.9, -1.2, 3.8, 1.2, 0.9, 'teak', { pat: 'planks', tone: 0.3 }));
  } else if (lv <= 3) {
    // a keep with a slate hip roof and four round corner turrets, a banner on a pole, two barracks, a well
    P.push(bx(-5.2, -4.4, 5.2, 2.4, 0, 7.6, 'cream', { tone: -0.3 }), ...hip(-5.2, -4.4, 5.2, 2.4, 7.6, 'fieldgrey', { rh: 2.6, over: 0.7 }), band(-5.6, 2.4, 5.6, 3.1, 7.6));
    for (const [tu, tv] of [[-5.2, -4.4], [5.2, -4.4], [-5.2, 2.4], [5.2, 2.4]]) P.push(...tower(tu, tv, 1.2, 8.6, 'ochre'));
    P.push(...chimney(-2.4, -3.4, 7.6, 4));
    P.push(...flag(0, -1.0, 10.4, 7.5, 4));
    P.push(...house(-11.6, -4.6, -7.4, 3.4, 3.4, 'brick', 'cream', { chim: 0.5 }), ...house(7.4, -4.6, 11.6, 3.4, 3.4, 'rust', 'canvas', { chim: 0.5 }));
    P.push(el(0, 5.2, 1.3, 1.2, 0, 1.1, 'sup', { sh: 'cyl', tone: 0.3 }), el(0, 5.2, 0.85, 0.75, 1.1, 0, 'sea'));
  } else {
    // an inner wall round a tall keep (stepped slate roof, a brass dome, corner turrets), cottages in the yard
    P.push(bx(-12, -6, 12, 7, 0, 3.4, 'sup', { tone: -0.5, pat: 'planks' }), bx(-10.8, -4.8, 10.8, 5.8, 0, 0, 'tan', { inset: true, tone: -1.4 }));
    P.push(...merlonsH(-11.4, 11, -6, 3.4, 2.6), ...merlonsH(-11.4, 11, 6.1, 3.4, 2.6));
    P.push(bx(-6.5, -4.6, 6.5, 3.4, 0, 12, 'cream', { tone: -0.3 }), ...hip(-6.5, -4.6, 6.5, 3.4, 12, 'fieldgrey', { rh: 2.4, over: 0.7 }));
    P.push(bx(-3.4, -3.2, 3.4, 1.6, 14.4, 1.2, 'sup', { tone: 0.2 }), ...hip(-3.4, -3.2, 3.4, 1.6, 15.6, 'fadedBlue', { rh: 1.8, over: 0.4 }), el(0, -0.8, 1.2, 1.1, 17.4, 1.8, 'brass', { sh: 'dome' }));
    for (const [tu, tv] of [[-6.5, -4.6], [6.5, -4.6], [-6.5, 3.4], [6.5, 3.4]]) P.push(...tower(tu, tv, 1.5, 13.4, 'rust'));
    P.push(band(-6.9, 3.4, 6.9, 4.2, 12), ...flag(0.4, -0.8, 19, 8, 5));
    P.push(...house(-10.4, -3.8, -7.4, 0.4, 3.4, 'brick', 'cream', { chim: 0.5 }), ...house(7.4, -3.8, 10.4, 0.4, 3.4, 'rust', 'canvas', { hip: true }));
  }
  // the corner towers (round drums with stepped slate caps) and (level 5) the back one
  const caps: Mat[] = ['rust', 'ochre', 'ochre', 'rust'];
  P.push(...tower(x0, y0, r, tz, caps[0]), ...tower(x1, y0, r, tz, caps[1]));
  if (lv >= 5) P.push(...tower(0, y0 + 0.2, r * 0.9, tz - 1, 'rust'));
  P.push(...tower(x0, y1, r, tz, caps[2]), ...tower(x1, y1, r, tz, caps[3]));
  P.push(...flag(x1 - 0.2, y0 - 0.4, tz + 4.6, lv >= 3 ? 7 : 5.5, 4.4));
  for (const cx of [x0, x1]) P.push(band(cx - r * 0.6, y1 + r * 0.55, cx + r * 0.6, y1 + r * 0.55 + 0.9, 0.5));
  if (lv >= 5) P.push(bx(-2.3, y1, 2.3, y1 + 4.4, 0, 0.6, 'teak', { pat: 'planks' }));
  P.push(...fortAddon(lv, addon, simple));
  return P;
}
/** The fort's add-ons: flak guns in front of the corner towers, or a belt of tank traps. */
function fortAddon(lv: number, addon: Addon, simple: boolean): Part[] {
  const P: Part[] = [];
  const w = lv >= 5 ? 36 : lv >= 3 ? 30 : 24;
  const d = lv >= 5 ? 24 : lv >= 3 ? 20 : 15;
  const x0 = -w / 2;
  const x1 = w / 2;
  const y0 = -d / 2;
  const y1 = d / 2;
  if (addon === 'flak') P.push(...flakGun(x0 - 5, y1 + 6, simple), ...flakGun(x1 + 5, y1 + 6, simple));
  if (addon === 'traps') {
    for (let h = x0 - 5; h <= x1 + 5; h += simple ? 9 : 6) if (Math.abs(h) > 5) P.push(...hedgehog(h, y1 + 8 + (hash(Math.round(h), 4) - 0.5) * 1.6));
    for (let h = y0 + 3; h < y1 + 5; h += simple ? 11 : 7) P.push(...hedgehog(x0 - 6, h), ...hedgehog(x1 + 6, h));
  }
  return P;
}

// ---- city

type LotKind = 'gable' | 'hip' | 'L' | 'T' | 'block' | 'blockL' | 'tower' | 'sky' | 'park' | 'shed' | 'tanks' | 'church';
/** How a tower or skyscraper stands up: tiers of (height, inset from the lot edge) from the ground up, and what crowns it. */
interface Stack {
  tiers: [number, number][];
  fin: 'helipad' | 'mast' | 'spire' | 'crown';
  lit: number;
}
interface Lot {
  u: number;
  v: number;
  w: number;
  d: number;
  z: number;
  k: LotKind;
  roof: Mat;
  wall?: Mat;
  stack?: Stack;
}
const lot = (u: number, v: number, w: number, d: number, z: number, k: LotKind, roofM: Mat, wall?: Mat, stack?: Stack): Lot => ({ u, v, w, d, z, k, roof: roofM, wall, stack });
/** The blocks of a town. The streets are the gaps between them (3 to 7 model units wide). Level 3 is a modern city of mid-rise blocks, level 5 a skyline. */
function cityLots(lv: number): Lot[] {
  if (lv >= 5) {
    // three columns by three rows: skyscrapers of different heights at the back and in the middle, mid-rise blocks and a plaza in front
    return [
      lot(-17, -14, 10, 8.5, 0, 'sky', 'fieldgrey', 'prublue', { tiers: [[30, 0], [39, 2.4]], fin: 'helipad', lit: 0.33 }),
      lot(0, -14, 11, 9, 0, 'sky', 'fieldgrey', 'alu', { tiers: [[24, 0], [34, 2], [41, 3.8]], fin: 'spire', lit: 0.3 }),
      lot(17, -14, 10, 8.5, 0, 'sky', 'fieldgrey', 'seagrey', { tiers: [[31, 0], [37, 2.2]], fin: 'helipad', lit: 0.36 }),
      lot(-17, -3, 9.5, 7.5, 0, 'sky', 'sup', 'alu', { tiers: [[20, 0]], fin: 'helipad', lit: 0.4 }),
      lot(0, -3, 10, 8, 0, 'sky', 'fieldgrey', 'fadedBlue', { tiers: [[17, 0], [29, 2.2]], fin: 'crown', lit: 0.35 }),
      lot(17, -3, 9.5, 7.5, 0, 'sky', 'sup', 'prublue', { tiers: [[25, 0]], fin: 'mast', lit: 0.38 }),
      lot(-17, 9, 9.5, 7, 12, 'block', 'fieldgrey', 'cream'),
      lot(0, 9.5, 10, 6, 0, 'park', 'olive'),
      lot(17, 9, 9.5, 7, 14, 'blockL', 'fieldgrey', 'tan'),
    ];
  }
  if (lv >= 3) {
    // three columns by three rows: mid-rise blocks of 4 to 8 storeys, two taller towers, a small park
    return [
      lot(-14.5, -13, 9.5, 6, 13.8, 'blockL', 'fieldgrey', 'sup'),
      lot(0, -13, 9, 6.5, 0, 'tower', 'fieldgrey', 'prublue', { tiers: [[27, 0], [33, 2.4]], fin: 'mast', lit: 0.4 }),
      lot(14.5, -13, 9.5, 6, 16.1, 'block', 'fieldgrey', 'cream'),
      lot(-14.5, -1, 9.5, 6, 9.2, 'blockL', 'fieldgrey', 'tan'),
      lot(0, -0.5, 9, 7, 0, 'park', 'olive'),
      lot(14.5, -1, 9.5, 6.5, 0, 'tower', 'fieldgrey', 'alu', { tiers: [[9, 0], [23, 1.8]], fin: 'crown', lit: 0.4 }),
      lot(-14.5, 12, 9.5, 6, 11.5, 'block', 'fieldgrey', 'white'),
      lot(0, 12.5, 8, 5.5, 9.2, 'block', 'fieldgrey', 'tan'),
      lot(14.5, 12, 9.5, 6, 9.2, 'blockL', 'fieldgrey', 'cream'),
    ];
  }
  return [lot(-12, -5.5, 7.5, 5.5, 3.6, 'gable', 'brick', 'cream'), lot(12, -5.5, 7.5, 5.5, 3.8, 'L', 'rust', 'tan'), lot(0, 0.5, 7, 12, 4.5, 'church', 'brick'), lot(-12, 5.5, 7.5, 5.5, 3.4, 'hip', 'ochre', 'canvas'), lot(12, 5.5, 7.5, 5.5, 3.4, 'gable', 'fadedBlue', 'cream')];
}
/** The streets of a level: the middles of the gaps between its rows and columns, as [horizontal v values, vertical u values]. */
function cityStreets(lv: number): [number[], number[]] {
  return lv >= 5 ? [[-8.4, 3.2], [-8.7, 8.7]] : lv >= 3 ? [[-7, 6], [-7.2, 7.2]] : [[], []];
}
/** The outer edge of the town (all lots plus a little margin), for its ground. */
function cityBounds(lv: number): [number, number, number, number] {
  let u0 = 99;
  let u1 = -99;
  let v0 = 99;
  let v1 = -99;
  for (const l of cityLots(lv)) {
    u0 = Math.min(u0, l.u - l.w / 2);
    u1 = Math.max(u1, l.u + l.w / 2);
    v0 = Math.min(v0, l.v - l.d / 2);
    v1 = Math.max(v1, l.v + l.d / 2);
  }
  return [u0 - 1.4, v0 - 1.4, u1 + 1.4, v1 + 1.4];
}
/** Small windows on a wall facing the viewer (the south wall): rows of lit (yellow) and dark panes. `simple` keeps a few. */
function windows(u0: number, u1: number, v: number, z0: number, z1: number, simple: boolean, seed: number, litP = 0.5): Part[] {
  const P: Part[] = [];
  const cs = simple ? 2.8 : 1.9;
  const rs = simple ? 3.4 : 2.3;
  for (let z = z0; z + 1 <= z1; z += rs) {
    for (let u = u0 + 0.9; u + 0.9 <= u1 - 0.5; u += cs) {
      const lit = hash(Math.round(u * 3), Math.round(z * 3), seed) < litP;
      P.push(bx(u, v, u + 0.85, v + 0.6, z, 1.05, lit ? 'brass' : 'glass', lit ? { glow: true } : { tone: -0.6 }));
    }
  }
  return P;
}
/**
 * A glass curtain wall on a south face: rows of wide panes (a few lit, most dark) with solid floor bands between them.
 * `simple` keeps fewer, bigger panes.
 */
function facade(u0: number, u1: number, v: number, z0: number, z1: number, simple: boolean, seed: number, litP: number): Part[] {
  const P: Part[] = [];
  const cs = simple ? 2.7 : 1.9;
  const rs = simple ? 3.3 : 2.4;
  const pw = cs * 0.66;
  const n = Math.floor((u1 - u0 - 0.9) / cs);
  const off = (u1 - u0 - n * cs + (cs - pw)) / 2;
  for (let z = z0; z + 1.4 <= z1; z += rs) {
    for (let i = 0; i < n; i++) {
      const u = u0 + off + i * cs;
      const lit = hash(i, Math.round(z * 2), seed) < litP;
      P.push(bx(u, v, u + pw, v + 0.6, z, 1.25, lit ? 'brass' : 'glass', lit ? { glow: true } : { tone: -0.2 }));
    }
  }
  return P;
}
/** The crown of a tower, standing on its top roof (a x b to c x d at height z). */
function crown(a: number, b: number, c: number, d: number, z: number, fin: Stack['fin'], seed: number): Part[] {
  const cu = (a + c) / 2;
  const cv = (b + d) / 2;
  const mast = (u: number, v: number, h: number): Part[] => [el(u, v, 0.28, 0.28, z, h, 'gun', { sh: 'cyl', tone: 0.8 }), seg(u - 1.2, v, u + 1.2, v, 0.3, z + h * 0.7, 0.3, 'gun'), el(u, v, 0.55, 0.5, z + h, 0.5, 'own', { sh: 'dome', tone: 0.5 })];
  switch (fin) {
    case 'helipad': {
      const r = Math.max(2.2, Math.min(c - a, d - b) / 2 - 0.9);
      return [
        el(cu, cv, r, r, z, 0.3, 'fieldgrey', { tone: -0.3 }),
        el(cu, cv, r - 0.45, r - 0.45, z + 0.3, 0, 'white', { edge: true, tone: 0.3 }),
        bx(cu - r * 0.42, cv - r * 0.5, cu - r * 0.42 + 0.45, cv + r * 0.5, z + 0.3, 0, 'paintYellow'),
        bx(cu + r * 0.42 - 0.45, cv - r * 0.5, cu + r * 0.42, cv + r * 0.5, z + 0.3, 0, 'paintYellow'),
        bx(cu - r * 0.42, cv - 0.22, cu + r * 0.42, cv + 0.22, z + 0.3, 0, 'paintYellow'),
        ...mast(c - 0.9, b + 0.9, 6.5),
        ...mast(a + 0.9, d - 0.9, 4),
      ];
    }
    case 'mast':
      return [bx(cu - 1.3, cv - 1.3, cu + 1.3, cv + 1.3, z, 1.2, 'sup', { tone: 0.3 }), ...mast(cu, cv, 9), ...acUnit(a + 0.9, d - 2.7, z)];
    case 'spire':
      return [bx(cu - 2.6, cv - 2.4, cu + 2.6, cv + 2.4, z, 2.0, 'alu', { tone: 0.2 }), bx(cu - 1.8, cv - 1.7, cu + 1.8, cv + 1.7, z + 2.0, 2.0, 'white', { tone: 0.2 }), bx(cu - 1.0, cv - 1.0, cu + 1.0, cv + 1.0, z + 4.0, 2.0, 'alu', { tone: 0.5 }), ...mast(cu, cv, 11).map((q) => ({ ...q, z: q.z + 6 }))];
    case 'crown':
      return [bx(a + 1.0, b + 1.0, c - 1.0, d - 1.0, z, 2.4, 'white', { tone: 0.1, pat: 'frames' }), bx(a + 0.7, b + 0.7, c - 0.7, d - 0.7, z + 2.4, 0.5, 'brass', { glow: true }), el(cu, cv, 1.4, 1.2, z + 2.9, 1.2, 'alu', { sh: 'dome', tone: 0.3 }), ...mast(cu, cv, 6).map((q) => ({ ...q, z: q.z + 4 }))];
  }
}
/**
 * A tower or skyscraper: tiers that step in (setbacks), each a wall with a glass curtain facade, a parapet and a roof; the
 * lower roofs carry a cooling unit, the top one a crown (helipad, mast, spire or lit crown).
 */
function stackTower(u0: number, v0: number, u1: number, v1: number, st: Stack, wall: Mat, roofM: Mat, seed: number, simple: boolean, far = false): Part[] {
  const P: Part[] = [];
  let zb = 0;
  st.tiers.forEach(([z, ins], k) => {
    const a = u0 + ins;
    const c = u1 - ins;
    const b = v0 + ins * 0.8;
    const d = v1 - ins * 0.8;
    P.push(bx(a, b, c, d, zb, z - zb, wall, { tone: -0.3 }));
    if (!far) P.push(...facade(a, c, d, k === 0 ? 2.8 : zb + 1.1, z - 0.8, simple, seed + k * 7, st.lit));
    P.push(bx(a - 0.15, b - 0.15, c + 0.15, d + 0.15, z, 0.7, wall, { tone: 0.5, edge: true }), bx(a + 0.7, b + 0.7, c - 0.7, d - 0.7, z, 0, roofM, { inset: true, tone: -0.2 }));
    const next = st.tiers[k + 1];
    if (next) {
      // the strip of this roof left in front of the next tier carries a cooling unit when it is deep enough
      const strip = (next[1] - ins) * 0.8;
      if (!far && strip >= 2.4 && c - a > 6) P.push(...acUnit(a + 1.0, d - strip + 0.4, z));
    } else if (!far) {
      P.push(...crown(a, b, c, d, z, st.fin, seed));
    } else if (st.fin === 'spire' || st.fin === 'mast') {
      P.push(el((a + c) / 2, (b + d) / 2, 0.5, 0.5, z, 6, 'alu', { sh: 'cyl' }));
    }
    zb = z;
  });
  return P;
}
/** A small park: a lawn with crossing paths, a round pond and a few trees. */
function park(l: Lot, far: boolean): Part[] {
  const u0 = l.u - l.w / 2 + 0.5;
  const u1 = l.u + l.w / 2 - 0.5;
  const v0 = l.v - l.d / 2 + 0.5;
  const v1 = l.v + l.d / 2 - 0.5;
  const P: Part[] = [bx(u0, v0, u1, v1, 0, 0, 'olive', { inset: true, tone: -0.2 })];
  if (far) return P;
  P.push(bx(l.u - 0.6, v0, l.u + 0.6, v1, 0, 0, 'tan', { tone: 0.4 }), bx(u0, l.v - 0.6, u1, l.v + 0.6, 0, 0, 'tan', { tone: 0.4 }));
  P.push(el(l.u, l.v, 1.9, 1.6, 0, 0.5, 'sup', { sh: 'cyl', tone: 0.4 }), el(l.u, l.v, 1.35, 1.1, 0.5, 0, 'sea'));
  for (const [du, dv] of [[-2.8, -1.6], [2.9, -1.8], [-2.6, 1.9], [2.8, 2.0]]) P.push(...tree(l.u + du, l.v + dv, 1.3, Math.round(du * 7 + dv)));
  return P;
}
/** A church: a nave with a tiled pitched roof and a round apse, a transept from level 3, a front tower (two at level 5) with a spire and the owner's banner. */
function church(l: Lot, lv: number, simple: boolean): Part[] {
  const P: Part[] = [];
  const u0 = l.u - l.w / 2;
  const u1 = l.u + l.w / 2;
  const v0 = l.v - l.d / 2;
  const v1 = l.v + l.d / 2;
  const tw = lv >= 5 ? 3.8 : lv >= 3 ? 3.6 : 3.2;
  const tz = lv >= 5 ? 19 : lv >= 3 ? 14 : 10;
  const nz = l.z;
  const nv1 = v1 - tw + 0.3;
  // the apse: a half drum with a little conical cap
  P.push(el(l.u, v0 + 0.4, l.w * 0.36, 2.5, 0, nz * 0.85, 'cream', { sh: 'cyl', tone: -0.3 }), el(l.u, v0 + 0.4, l.w * 0.4, 2.7, nz * 0.85, 1.0, l.roof, { sh: 'dome', tone: 0.2 }), el(l.u, v0 + 0.4, l.w * 0.22, 1.6, nz * 0.85 + 1.0, 1.0, l.roof, { sh: 'dome', tone: 0.6 }));
  P.push(bx(u0, v0, u1, nv1, 0, nz, 'cream', { tone: -0.3 }), ...roof(u0, v0 + 0.8, u1, nv1, nz, l.roof, 1.9, 0.5));
  if (lv >= 3) {
    const vm = v0 + (nv1 - v0) * 0.45;
    P.push(bx(u0 - 2.4, vm - 1.7, u1 + 2.4, vm + 1.7, 0, nz - 0.8, 'cream', { tone: -0.3 }), ...roof(u0 - 2.4, vm - 1.7, u1 + 2.4, vm + 1.7, nz - 0.8, l.roof, 1.4, 0.3));
    P.push(...roof(u0, v0 + 0.8, u1, nv1, nz, l.roof, 1.9, 0.5));
  }
  const towers = lv >= 5 ? [u0 + tw / 2, u1 - tw / 2] : [l.u];
  for (const tu of towers) {
    const a = tu - tw / 2;
    const b = tu + tw / 2;
    P.push(bx(a, v1 - tw, b, v1, 0, tz, 'cream', { tone: -0.1 }));
    P.push(bx(a + 0.9, v1, b - 0.9, v1 + 0.6, tz - 5.2, 3.2, 'black', { tone: 0.5 }));
    if (!simple) P.push(bx(a + 1.1, v1, b - 1.1, v1 + 0.6, 1.2, 1.1, 'glass', { tone: -0.5 }));
    P.push(band(a - 0.2, v1 - 0.3, b + 0.2, v1 + 0.5, tz));
    for (let i = 0; i < 4; i++) {
      const s = tw * (0.92 - i * 0.22);
      P.push(bx(tu - s / 2, v1 - tw / 2 - s / 2, tu + s / 2, v1 - tw / 2 + s / 2, tz + i * 1.6, 1.6, 'fadedBlue', { tone: i * 0.35 - 0.2 }));
    }
    P.push(...flag(tu, v1 - tw / 2, tz + 6.4, lv >= 5 ? 5 : 4, 3.4));
  }
  return P;
}
/** A round-tank yard: a low pad, two or three cylinders with domed lids, a pipe between them and a pump shed. */
function tankYard(u0: number, v0: number, u1: number, v1: number, seed: number): Part[] {
  const P: Part[] = [bx(u0, v0, u1, v1, 0, 0.4, 'sup', { tone: -0.6 })];
  const n = u1 - u0 > 8 ? 3 : 2;
  const r = Math.min((v1 - v0) / 2 - 0.3, (u1 - u0) / (n * 2) - 0.2);
  const mats: Mat[] = ['white', 'alu', 'cargo'];
  for (let i = 0; i < n; i++) {
    const cu = u0 + (u1 - u0) * ((i + 0.5) / n);
    const cv = (v0 + v1) / 2 + (hash(seed, i, 2) - 0.5) * 0.6;
    const h = 3.4 + hash(seed, i, 3) * 2.2;
    P.push(el(cu, cv, r, r * 0.96, 0.4, h, mats[(i + seed) % 3], { sh: 'cyl' }), el(cu, cv, r * 0.96, r * 0.92, 0.4 + h, 0.7, 'alu', { sh: 'dome', tone: 0.3 }));
    P.push(seg(cu + r * 0.6, cv + r * 0.8, cu + r * 0.9, cv + r * 0.2, 0.35, 0.8, h, 'gun', { tone: 0.2 }));
    if (i > 0) P.push(seg(cu - (u1 - u0) / n + r, cv + r * 0.55, cu - r, cv + r * 0.55, 0.5, 1.4, 0.5, 'gun', { sh: 'cyl', tone: 0.5 }));
  }
  return P;
}
/** The parts of one lot (a house, a block, a shed, a tank yard) with its own small details. */
function lotParts(l: Lot, i: number, lv: number, simple: boolean): Part[] {
  const P: Part[] = [];
  // each lot a little smaller than its slot and nudged within it, so no two are the same size
  const su0 = hash(i, 11, 1) * 1.1;
  const su1 = hash(i, 12, 1) * 1.1;
  const sv0 = hash(i, 13, 1) * 0.8;
  const sv1 = hash(i, 14, 1) * 0.4;
  const u0 = l.u - l.w / 2 + su0;
  const u1 = l.u + l.w / 2 - su1;
  const v0 = l.v - l.d / 2 + sv0;
  const v1 = l.v + l.d / 2 - sv1;
  const wall = l.wall ?? 'sup';
  const flipU = hash(i, 15, 1) > 0.5;
  switch (l.k) {
    case 'church':
      return church(l, lv, simple);
    case 'gable':
      P.push(...house(u0, v0, u1, v1, l.z, l.roof, wall, { chim: 0.2 + hash(i, 2, 2) * 0.5 }), ...windows(u0, u1, v1, 1.1, l.z - 0.3, simple, i + 80));
      break;
    case 'hip':
      P.push(...house(u0, v0, u1, v1, l.z, l.roof, wall, { hip: true, chim: 0.3 + hash(i, 2, 2) * 0.4 }), ...windows(u0, u1, v1, 1.1, l.z - 0.3, simple, i + 80));
      break;
    case 'L':
      P.push(...houseL(u0, v0, u1, v1, l.z, l.roof, wall, flipU), ...windows(u0, u1, v1, 1.1, l.z - 0.3, simple, i + 80));
      break;
    case 'T':
      P.push(...houseT(u0, v0, u1, v1, l.z, l.roof, wall), ...windows(u0 + (u1 - u0) * 0.3, u1 - (u1 - u0) * 0.3, v1, 1.1, l.z - 0.3, simple, i + 80));
      break;
    case 'block':
    case 'blockL': {
      const L = l.k === 'blockL';
      const cw = (u1 - u0) * 0.42;
      const cd = (v1 - v0) * 0.45;
      const outer = L ? ptsL(u0, v0, u1, v1, cw, cd, 0, flipU) : ptsRect(u0, v0, u1, v1, 0);
      const inner = L ? ptsL(u0, v0, u1, v1, cw, cd, 0.7, flipU) : ptsRect(u0, v0, u1, v1, 0.7);
      P.push(poly(outer, 0, l.z, wall, { tone: -0.3 }), poly(outer, l.z, 0.7, wall, { tone: 0.5, edge: true }), poly(inner, l.z, 0, l.roof, { inset: true, tone: -0.2 }));
      P.push(...windows(u0, u1, v1, 1.4, l.z - 0.4, simple, i));
      // gear on the roof (in the south wing of an L)
      P.push(...roofGear(u0 + 0.7, L ? v0 + cd + 0.7 : v0 + 0.7, u1 - 0.7, v1 - 0.7, l.z, i, simple));
      if (L) P.push(...skylight(flipU ? u1 - cw + 0.3 : u0 + 0.9, v0 + 1.1, l.z, cw - 1.2, 1.2));
      P.push(band(u0, v1 - 1.1, u1, v1 - 0.4, l.z + 0.7));
      break;
    }
    case 'tower':
    case 'sky':
      P.push(...stackTower(l.u - l.w / 2, l.v - l.d / 2, l.u + l.w / 2, l.v + l.d / 2, l.stack ?? { tiers: [[l.z, 0]], fin: 'mast', lit: 0.4 }, wall, l.roof, i * 13 + 5, simple));
      break;
    case 'park':
      P.push(...park(l, false));
      break;
    case 'shed':
      P.push(...warehouse(u0, v0, u1, v1, wall, l.roof, i, simple, l.z));
      break;
    case 'tanks':
      P.push(...tankYard(u0, v0, u1, v1, i));
      break;
  }
  // a tree or two in the yard of the small houses
  if (!simple && (l.k === 'gable' || l.k === 'hip' || l.k === 'L' || l.k === 'T') && hash(i, 17, 1) > 0.35) {
    const side = hash(i, 18, 1) > 0.5 ? 1 : -1;
    P.push(...tree(side > 0 ? u1 + 0.6 : u0 - 0.6, v0 + 1.2 + hash(i, 19, 1) * 1.2, 1.15 + hash(i, 20, 1) * 0.4, i));
  }
  return P;
}
function cityModel(lv: number, addon: Addon, simple: boolean): Part[] {
  const P: Part[] = [];
  const lots = cityLots(lv).sort((a, b) => a.v - b.v || a.u - b.u);
  lots.forEach((l, i) => P.push(...lotParts(l, i, lv, simple)));
  P.push(...cityAddon(lv, addon, simple));
  return P;
}
/** The city's add-on parts (flak guns beside the town), which wear their own outline. */
function cityAddon(lv: number, addon: Addon, simple: boolean): Part[] {
  if (addon !== 'flak') return [];
  const [, , , bv1] = cityBounds(lv);
  const ux = lv >= 5 ? 17 : lv >= 3 ? 14 : 10.5;
  return [...flakGun(-ux, bv1 + 6, simple), ...flakGun(ux, bv1 + 6, simple)];
}

// ---- SAM site

/**
 * A tracked launcher in the tanks' own detail: tracks with tread and road wheels, a hull with a sloped nose, a cab with
 * a glass slit, a raised cradle carrying four angled missile tubes (each a white missile with an owner-coloured nose
 * cone and dark tail fins). Faces east.
 */
function launcher(u: number, v: number): Part[] {
  const P: Part[] = [];
  const o = (a: number): number => u + a;
  // tracks and wheels
  P.push(bx(o(-6.4), v - 3.6, o(5.6), v - 2.2, 0, 1.7, 'track', { pat: 'tread' }), bx(o(-6.4), v + 2.2, o(5.6), v + 3.6, 0, 1.7, 'track', { pat: 'tread' }));
  for (let i = 0; i < 5; i++) {
    const wu = o(-5 + i * 2.5);
    P.push(el(wu, v - 3.7, 0.8, 0.28, 0.2, 1.2, 'gun', { tone: 1, sh: 'cyl', minRes: 1.5 }), el(wu, v + 3.7, 0.8, 0.28, 0.2, 1.2, 'gun', { tone: 1, sh: 'cyl', minRes: 1.5 }));
  }
  // hull with a sloped nose, the owner's stripe on its side
  P.push(bx(o(-6.2), v - 2.7, o(5.2), v + 2.7, 0.9, 1.5, 'olive'));
  P.push(poly([o(5.2), v - 2.7, o(7.6), v - 1.7, o(7.6), v + 1.7, o(5.2), v + 2.7], 0.9, 1.1, 'olive', { tone: 0.5 }));
  P.push(bx(o(-6), v + 2.1, o(4), v + 2.7, 2.4, 0, 'own'));
  // the cab: a boxy crew compartment with a glass slit and a hatch
  P.push(bx(o(3.6), v - 2.4, o(7.0), v + 0.6, 2.4, 1.6, 'olive', { tone: 0.5 }), bx(o(6.5), v - 2.0, o(7.1), v + 0.2, 3.3, 0, 'glass'), el(o(4.6), v - 0.6, 0.6, 0.6, 4.0, 0.3, 'gun', { tone: 0.6 }));
  // the cradle: a raised black frame on a turntable in the owner's colour
  P.push(el(o(-1.6), v, 2.9, 2.7, 2.4, 0.9, 'own', { sh: 'dome', tone: 0.1 }), bx(o(-6), v - 2.5, o(3.2), v + 2.5, 3.2, 0.8, 'black', { tone: 0.3, pat: 'grille' }));
  // three angled tubes: a black casing, a thick white missile rising toward the nose with a light stripe, a big owner-coloured nose cone, black tail fins
  for (let i = 0; i < 3; i++) {
    const vv = v - 1.95 + i * 1.95;
    const u0 = o(-5.8);
    const dv = -1.5;
    P.push(seg(u0, vv, o(3.2), vv + dv, 1.75, 3.9, 0.7, 'black', { sh: 'cyl', tone: 0.2 }));
    P.push(seg(u0 + 0.5, vv, o(2.4), vv + dv * 0.7, 1.3, 4.5, 1.0, 'white', { sh: 'cyl', tone: i === 1 ? 0.5 : 0.2 }));
    P.push(seg(o(2.4), vv + dv * 0.7, o(4.3), vv + dv * 1.2, 1.25, 5.0, 0.9, 'white', { sh: 'cyl', tone: 0.6 }));
    P.push(el(o(5.1), vv + dv * 1.35, 1.25, 0.8, 5.0, 1.1, 'own', { sh: 'dome', tone: 0.3 }));
    P.push(bx(u0 - 0.1, vv - 1.3, u0 + 1.3, vv + 1.3, 4.9, 0.35, 'black'), bx(u0 + 0.5, vv - 0.5, u0 + 1.1, vv + 0.5, 5.1, 0.3, 'gun'));
  }
  return P;
}
/**
 * A command truck: six wheels under mud guards, a chamfered cab with a sloped windscreen, mirrors and a light bar, a
 * grey shelter with a corrugated roof carrying a radome, a dish, a cooling unit, a hatch and whip aerials, a door with
 * steps, a cable reel on the back. Faces east.
 */
function commandTruck(u: number, v: number): Part[] {
  const P: Part[] = [];
  for (const wu of [-3.6, -0.6, 2.8]) {
    P.push(el(u + wu, v + 2.7, 1.1, 0.5, 0, 1.5, 'track', { sh: 'cyl' }), el(u + wu, v - 2.7, 1.1, 0.5, 0, 1.3, 'track', { sh: 'cyl' }));
    P.push(bx(u + wu - 1.4, v + 2.2, u + wu + 1.4, v + 3.3, 1.5, 0.4, 'olive', { tone: -0.3 }), bx(u + wu - 1.4, v - 3.3, u + wu + 1.4, v - 2.2, 1.5, 0.4, 'olive', { tone: -0.3 }));
  }
  P.push(bx(u - 5.2, v - 2.3, u + 3.6, v + 2.3, 0.8, 1.3, 'olive', { tone: -0.2 }));
  // the cab and bonnet
  P.push(poly([u + 3.6, v - 2.2, u + 5.8, v - 2.2, u + 6.8, v - 1.2, u + 6.8, v + 1.2, u + 5.8, v + 2.2, u + 3.6, v + 2.2], 0.8, 1.6, 'olive', { tone: 0.1 }));
  P.push(poly([u + 3.6, v - 2.1, u + 5.0, v - 2.1, u + 5.0, v + 2.1, u + 3.6, v + 2.1], 0.8, 2.6, 'olive', { tone: 0.6 }));
  P.push(poly([u + 5.0, v - 1.9, u + 5.9, v - 1.5, u + 5.9, v + 1.5, u + 5.0, v + 1.9], 2.4, 0.9, 'glass', { tone: 0.3 }));
  P.push(bx(u + 5.2, v - 2.6, u + 5.8, v - 2.2, 2.6, 0.8, 'gun'), bx(u + 5.2, v + 2.2, u + 5.8, v + 2.6, 2.6, 0.8, 'gun'), bx(u + 3.9, v - 1.3, u + 4.5, v + 1.3, 3.4, 0.3, 'black', { tone: 0.5 }));
  // the shelter: a corrugated roof with its fittings, a door and steps on the side
  P.push(bx(u - 5.0, v - 2.1, u + 3.2, v + 2.1, 2.1, 3.2, 'cargo', { tone: 0.1, pat: 'grille' }));
  P.push(bx(u - 5.0, v + 1.5, u + 3.2, v + 2.1, 5.3, 0, 'own'));
  P.push(...acUnit(u - 4.4, v - 1.6, 5.3));
  P.push(bx(u - 1.8, v + 0.2, u - 0.4, v + 1.3, 5.3, 0.4, 'sup', { tone: 0.2 }), el(u + 1.0, v - 0.5, 1.5, 1.4, 5.3, 1.1, 'alu', { sh: 'dome' }), el(u - 2.4, v - 1.0, 1.15, 0.9, 5.3, 0.7, 'alu', { sh: 'dome', tone: -0.2 }));
  P.push(el(u - 4.4, v + 1.0, 0.22, 0.22, 5.3, 4.8, 'gun', { sh: 'cyl' }), el(u + 2.5, v + 1.0, 0.22, 0.22, 5.3, 4.2, 'gun', { sh: 'cyl' }));
  P.push(bx(u - 2.6, v + 2.1, u - 0.8, v + 2.24, 2.1, 2.5, 'black', { tone: 0.5 }), bx(u - 2.8, v + 2.1, u - 0.6, v + 2.9, 0.8, 0.5, 'sup', { tone: 0.2, pat: 'grille' }));
  P.push(el(u - 5.6, v, 0.9, 1.5, 0.8, 1.3, 'gun', { sh: 'cyl', tone: 0.3 }));
  return P;
}
/** A sandbag and earth bank round three sides of a bay (open to the east): a wide earth foot topped by a staggered course of sandbags. */
function revetment(u0: number, v0: number, u1: number, v1: number): Part[] {
  const P: Part[] = [];
  const t = 1.5;
  const sides: [number, number, number, number][] = [[u0, v0, u1, v0 + t], [u0, v1 - t, u1, v1], [u0, v0, u0 + t, v1]];
  for (const [a, b, c, d] of sides) P.push(bx(a, b, c, d, 0, 1.0, 'tan', { tone: -0.9 }));
  let i = 0;
  for (let u = u0 + 0.9; u < u1 - 0.4; u += 1.55, i++) {
    P.push(el(u, v0 + t / 2 + (i % 2 ? 0.22 : -0.22), 0.85, 0.62, 1.0, 0.8, 'canvas', { sh: 'dome', tone: i % 3 === 0 ? 0.3 : -0.1 }));
    P.push(el(u, v1 - t / 2 + (i % 2 ? -0.22 : 0.22), 0.85, 0.62, 1.0, 0.8, 'canvas', { sh: 'dome', tone: i % 3 === 1 ? 0.3 : -0.1 }));
  }
  for (let v = v0 + 2.0; v < v1 - 2.0; v += 1.5, i++) P.push(el(u0 + t / 2 + (i % 2 ? 0.22 : -0.22), v, 0.62, 0.85, 1.0, 0.8, 'canvas', { sh: 'dome', tone: i % 3 === 2 ? 0.3 : -0.1 }));
  return P;
}
/** The parts moved by (du, dv). */
function moved(parts: readonly Part[], du: number, dv: number): Part[] {
  return parts.map((p) => {
    const q = p.p.map((x, i) => (p.k === 'ell' ? (i === 0 ? x + du : i === 1 ? x + dv : x) : p.k === 'seg' ? (i < 4 ? x + (i % 2 ? dv : du) : x) : x + (i % 2 ? dv : du)));
    return { ...p, p: q, sc: p.sc && ([p.sc[0] + du, p.sc[1] + dv, p.sc[2], p.sc[3]] as const) };
  });
}
/** A launcher drawn 1.15 times larger than laid out, standing at (u, v), with its sandbag bay. */
function samBay(u: number, v: number): Part[] {
  return [...revetment(u - 10, v - 5.6, u + 11.5, v + 5.6), ...moved(grown(launcher(0, 0), 1.15), u, v)];
}
function samModel(lv: number, addon: Addon, simple: boolean): Part[] {
  const P: Part[] = [];
  if (lv >= 3) {
    P.push(...moved(grown(commandTruck(0, 0), 1.1), -1, -17.5));
    P.push(...samBay(-15.5, -4), ...samBay(11, -4), ...samBay(-2, 14));
  } else {
    P.push(...moved(grown(commandTruck(0, 0), 1.1), 12, -7));
    P.push(...samBay(-7, 4));
  }
  P.push(...samAddon(lv, addon, simple));
  return P;
}
function samAddon(lv: number, addon: Addon, simple: boolean): Part[] {
  return addon === 'radar' ? (lv >= 3 ? radarDish(21, 12, simple) : radarDish(-5, -11, simple)) : [];
}

// ---- port: the coast is at u = COAST, land to the west, the sea and the piers to the east

const COAST = 1.5;
/** wharf decks stand on pilings: the deck's underside and its top, in model height */
const PIER_Z = 2.0;
const DECK = PIER_Z + 0.8;

interface Pier {
  u0: number;
  v0: number;
  u1: number;
  v1: number;
  wood: boolean;
}
interface Hull {
  u: number;
  v: number;
  len: number;
  wid: number;
  kind: 'tug' | 'cargo' | 'coaster';
}
/** The piers of a port level: one long wooden pier at level 1, two concrete ones from level 3. */
function pierList(lv: number): Pier[] {
  return lv >= 3
    ? [
        { u0: -1, v0: -12.4, u1: 22, v1: -8.8, wood: false },
        { u0: -1, v0: 7.6, u1: 19, v1: 11, wood: false },
      ]
    : [{ u0: -1, v0: -1.2, u1: 22, v1: 1.6, wood: true }];
}
/** The ships moored at them. */
function hullList(lv: number): Hull[] {
  return lv >= 3
    ? [
        { u: 4, v: -5.2, len: 17, wid: 5.2, kind: 'cargo' },
        { u: 9, v: 4.9, len: 8.4, wid: 3.4, kind: 'tug' },
      ]
    : [
        { u: 5, v: 4.3, len: 12.6, wid: 4.2, kind: 'coaster' },
        { u: 9, v: -4.3, len: 7, wid: 3, kind: 'tug' },
      ];
}
const MOLE: [number, number][] = [[-1, -22], [8, -21.6], [15.5, -20.8], [21.5, -19.4]];

/** A pier on pilings: planks (wood) or concrete slabs, a kerb, pile caps along both edges, bollards, a lamp, dark piles standing under its south edge and head. */
function pier(p: Pier, simple: boolean): Part[] {
  const { u0, v0, u1, v1, wood } = p;
  const m: Mat = wood ? 'teak' : 'sup';
  const P: Part[] = [];
  for (let u = u0 + 1.5; u <= u1; u += 2.4) P.push(el(u, v1 + 0.4, 0.5, 0.42, 0, PIER_Z + 0.6, 'teak', { sh: 'cyl', tone: -0.7 }));
  for (let v = v0 + 0.6; v <= v1; v += 1.4) P.push(el(u1 + 0.4, v, 0.46, 0.4, 0, PIER_Z + 0.6, 'teak', { sh: 'cyl', tone: -0.7 }));
  P.push(bx(u0, v0, u1, v1, PIER_Z, 0.8, m, wood ? { pat: 'planks' } : { pat: 'hatches', tone: -0.1 }));
  P.push(bx(u0, v1 - 0.4, u1, v1, DECK, 0.3, m, { tone: 0.7 }), bx(u1 - 0.4, v0, u1, v1, DECK, 0.3, m, { tone: 0.7 }));
  if (!simple) for (let u = u0 + 1.5; u <= u1 - 0.8; u += 2.4) P.push(el(u, v1 - 0.2, 0.34, 0.3, DECK + 0.3, 0.3, 'gun', { sh: 'cyl', tone: 0.6 }));
  for (let u = u0 + 3.5; u < u1 - 1; u += 5.5) P.push(el(u, v1 - 1.0, 0.45, 0.42, DECK, 0.8, 'gun', { sh: 'cyl', tone: 0.9 }));
  P.push(el(u1 - 1.0, v0 + 0.8, 0.2, 0.2, DECK, 3.4, 'gun', { sh: 'cyl' }), el(u1 - 1.0, v0 + 0.8, 0.55, 0.5, DECK + 3.4, 0.4, 'brass', { glow: true }));
  return P;
}
/** A mooring line from a ship's rail to a bollard on the pier. */
const rope = (u: number, vShip: number, vPier: number): Part => seg(u, vShip, u + 0.9, vPier, 0.22, 2.7, 0.15, 'canvas', { tone: 0.2 });

/** A quay gantry crane: four tall legs, girders, a long boom reaching out over the water (toward `dir` along v), a cab and a machinery house at the back. */
function gantry(u: number, v: number, dir: 1 | -1, len: number, z0: number): Part[] {
  const H = 8;
  const P: Part[] = [];
  const tip = v + dir * (1.3 + len);
  const tail = v - dir * 4.4;
  for (const su of [-1.8, 1.8]) {
    for (const sv of [-1.3, 1.3]) P.push(bx(u + su - 0.35, v + sv - 0.35, u + su + 0.35, v + sv + 0.35, z0, H, 'ochre', { tone: -0.2 }));
    P.push(bx(u + su - 0.3, v - 1.4, u + su + 0.3, v + 1.4, z0 + 4.2, 0.4, 'ochre', { tone: -0.1 }), bx(u + su - 0.35, v - 1.5, u + su + 0.35, v + 1.5, z0 + H, 0.8, 'ochre', { tone: 0.3 }));
  }
  P.push(bx(u - 2.2, v - 0.55, u + 2.2, v + 0.55, z0 + H + 0.8, 0.7, 'ochre', { tone: 0.5 }));
  // the boom and its rungs, a tall apex, the cab on its trolley, the machinery house at the tail
  P.push(bx(u - 0.8, Math.min(tip, tail), u + 0.8, Math.max(tip, tail), z0 + H + 1.5, 0.6, 'ochre', { tone: 0.4 }));
  for (let k = 0; k < len + 4; k += 1.7) {
    const vk = tail + (tip - tail) * (k / (len + 4.4));
    P.push(bx(u - 0.95, vk - 0.12, u + 0.95, vk + 0.12, z0 + H + 1.2, 0.4, 'gun', { tone: 0.3 }));
  }
  P.push(bx(u - 0.5, v - 0.5, u + 0.5, v + 0.5, z0 + H + 2.1, 2.6, 'ochre', { tone: 0.2 }));
  const tc = v + dir * (len * 0.55);
  P.push(bx(u - 1.0, tc - 0.9, u + 1.0, tc + 0.9, z0 + H - 0.4, 1.0, 'white'), bx(u - 0.8, tc + dir * 0.9, u + 0.8, tc + dir * 1.05, z0 + H - 0.2, 0.6, 'glass', { tone: 0.3 }), band(u - 0.9, tc - 0.5, u + 0.9, tc + 0.5, z0 + H + 0.65));
  P.push(bx(u - 1.5, tail - dir * 0.2 - 1.1, u + 1.5, tail - dir * 0.2 + 1.1, z0 + H + 1.2, 1.6, 'gun', { tone: 0.2 }));
  P.push(bx(u - 1.9, tip - dir * 0.4 - 0.4, u + 1.9, tip - dir * 0.4 + 0.4, z0 + H + 1.2, 0.5, 'hazard'));
  return P;
}
/** A slewing jib crane on a tower: a cab, a long lattice jib toward (tipU, tipV), a short counter-jib with ballast, a hook. */
function jibCrane(u: number, v: number, z0: number, tipU: number, tipV: number): Part[] {
  const du = tipU - u;
  const dv = tipV - v;
  const L = Math.hypot(du, dv) || 1;
  const cu = -du / L;
  const cvv = -dv / L;
  return [
    el(u, v, 1.9, 1.7, z0, 0.9, 'gun', { sh: 'cyl', tone: 0.2 }),
    bx(u - 1.0, v - 1.0, u + 1.0, v + 1.0, z0 + 0.9, 6.6, 'ochre', { tone: -0.3, pat: 'grille' }),
    bx(u - 1.6, v - 1.8, u + 1.2, v - 0.1, z0 + 6.5, 2.0, 'white'),
    bx(u - 1.5, v - 0.12, u + 1.1, v + 0.02, z0 + 6.7, 1.0, 'glass', { tone: 0.3 }),
    seg(u + cu * 0.3, v + cvv * 0.3, u + cu * 4.2, v + cvv * 4.2, 1.9, z0 + 7.2, 1.0, 'gun', { tone: 0.2 }),
    seg(u, v, tipU, tipV, 1.0, z0 + 8.3, 0.7, 'ochre', { tone: 0.5 }),
    seg(u + du * 0.1, v + dv * 0.1, tipU - du * 0.1, tipV - dv * 0.1, 0.35, z0 + 9.0, 0.3, 'gun', { tone: 0.6 }),
    band(u - 1.2, v - 1.5, u + 0.9, v - 0.8, z0 + 8.5),
    el(tipU, tipV, 0.16, 0.16, z0 + 3.5, 4.8, 'black', { sh: 'cyl' }),
    bx(tipU - 0.4, tipV - 0.3, tipU + 0.4, tipV + 0.3, z0 + 3.0, 0.7, 'hazard'),
  ];
}
/** A long warehouse: a ridged metal roof with a ridge vent, skylights, bay doors on the south wall, pilasters. */
function warehouse(u0: number, v0: number, u1: number, v1: number, wall: Mat, roofM: Mat, seed: number, simple: boolean, wz = 3.8): Part[] {
  const P: Part[] = [bx(u0, v0, u1, v1, 0, wz, wall, { tone: -0.3 })];
  const rh = Math.min(2.2, Math.max(1.3, (v1 - v0) * 0.3));
  P.push(...gable(u0, v0, u1, v1, wz, roofM, { rh, over: 0.6, metal: true }));
  const vm = (v0 + v1) / 2;
  if (u1 - u0 > 8) {
    for (let u = u0 + 2; u < u1 - 4.6; u += 6.2) P.push(bx(u, vm - 0.7, u + 3.2, vm + 0.7, wz + rh + 0.25, 0.8, 'alu', { pat: 'grille', tone: 0.3 }));
    if (!simple) for (let u = u0 + 3; u < u1 - 3; u += 4.8) P.push(bx(u, v0 - 0.1, u + 2.2, v0 + 0.9, wz + rh, 0.2, 'glass', { tone: 0.4, pat: 'frames' }));
  } else P.push(...ventPipe((u0 + u1) / 2, vm, wz + rh), ...skylight(u0 + 1.2, v0 + 0.4, wz + rh, 2, 1.1));
  const nd = Math.max(1, Math.floor((u1 - u0) / 6.5));
  for (let i = 0; i < nd; i++) {
    const du = u0 + ((i + 0.5) / nd) * (u1 - u0) - 1.4;
    P.push(bx(du, v1, du + 2.8, v1 + 0.6, 0, 2.7, 'black', { tone: 0.5 }), bx(du - 0.2, v1, du + 3.0, v1 + 0.2, 2.7, 0.35, 'sup', { tone: 0.5 }));
  }
  if (!simple) for (let u = u0 + 4; u < u1 - 1; u += 6.5) P.push(bx(u, v1, u + 0.5, v1 + 0.28, 0, wz, wall, { tone: 0.2 }));
  P.push(band(u0 + 0.3, v1 - 0.7, u0 + 3.6, v1 - 0.2, wz + 0.3));
  return P;
}
const BOX_COLS: Mat[] = ['rust', 'fadedBlue', 'ochre', 'olive', 'brick', 'fieldgrey', 'cargo', 'canvas'];
/** Neat rows of shipping containers on a 4 unit grid (the ribs line up with their ends), some stacked two high, in muted colours. */
function containers(u: number, v: number, nu: number, nv: number, seed: number, ownerFirst: boolean, z0 = 0): Part[] {
  const P: Part[] = [];
  const U0 = Math.round(u / 4) * 4;
  for (let j = 0; j < nv; j++) {
    for (let i = 0; i < nu; i++) {
      const pick = (k: number): Mat => BOX_COLS[Math.floor(hash(i + seed + k, j * 5 + seed, k) * BOX_COLS.length)];
      const u0 = U0 + i * 4;
      const v0 = v + j * 2.7;
      const two = hash(i, j + seed, 8) > 0.5;
      P.push(bx(u0, v0, u0 + 4, v0 + 2.4, z0, 2.3, pick(0), { pat: 'ribs', tone: hash(i + 3, j + seed, 1) * 0.7 - 0.35 }));
      if (two) P.push(bx(u0, v0, u0 + 4, v0 + 2.4, z0 + 2.3, 2.3, pick(5), { pat: 'ribs', tone: hash(i + 9, j + seed, 2) * 0.7 - 0.35 }));
    }
  }
  if (ownerFirst) P.push(bx(U0 + 0.4, v + 0.4, U0 + 3.6, v + 0.9, 2.3 + z0, 0, 'own'));
  return P;
}
/** A tug: a rounded dark hull with a red stripe, a white wheelhouse, a red funnel, tyre fenders, bow fender. Bow to the east. */
function tug(u: number, v: number, len: number, wid: number): Part[] {
  const hw = wid / 2;
  const hull = [u, v - hw * 0.8, u + len - 2.4, v - hw, u + len - 0.6, v - hw * 0.55, u + len, v, u + len - 0.6, v + hw * 0.55, u + len - 2.4, v + hw, u, v + hw * 0.8];
  const deckPts = [u + 0.4, v - hw * 0.8 + 0.4, u + len - 2.4, v - hw + 0.4, u + len - 1.0, v - hw * 0.5, u + len - 0.5, v, u + len - 1.0, v + hw * 0.5, u + len - 2.4, v + hw - 0.4, u + 0.4, v + hw * 0.8 - 0.4];
  const P: Part[] = [poly(hull, 0, 1.7, 'merchant', { tone: 0.5 }), poly(deckPts, 1.7, 0, 'deck', { tone: 0.5 })];
  P.push(bx(u + 0.3, v + hw * 0.8 - 0.55, u + len - 3, v + hw * 0.8, 0.2, 1.3, 'redlead', { tone: 0.2 }));
  P.push(bx(u + 1.8, v - hw + 0.8, u + 5.4, v + hw - 0.8, 1.7, 1.8, 'white'), bx(u + 1.6, v - hw + 0.6, u + 5.6, v + hw - 0.6, 3.5, 0.3, 'sup', { tone: 0.5 }), bx(u + 5.2, v - hw + 1.1, u + 5.34, v + hw - 1.1, 2.1, 0.9, 'glass', { tone: 0.3 }));
  P.push(bx(u + 2.6, v - hw + 1.2, u + 4.6, v + hw - 1.2, 3.8, 1.3, 'white', { tone: 0.3 }), bx(u + 4.5, v - hw + 1.5, u + 4.64, v + hw - 1.5, 4.1, 0.7, 'glass', { tone: 0.3 }), band(u + 2.8, v + hw - 1.6, u + 4.4, v + hw - 1.2, 5.1));
  P.push(el(u + 1.0, v, 0.9, 0.8, 3.5, 2.0, 'redlead', { sh: 'cyl' }), el(u + 1.0, v, 0.92, 0.82, 5.5, 0.3, 'black'));
  for (let i = 0; i < 4; i++) P.push(el(u + 1.4 + i * 1.4, v + hw * 0.95, 0.5, 0.28, 0.6, 0.9, 'black', { sh: 'cyl' }));
  P.push(el(u + len - 0.4, v, 0.5, 0.5, 0.7, 0.9, 'black', { sh: 'cyl' }), el(u + len - 2.9, v, 0.55, 0.55, 1.7, 0.7, 'gun', { sh: 'cyl', tone: 0.6 }));
  return P;
}
/** A small cargo ship (hull, hatches, a stern house, a funnel) of any length; bow to the east. */
function ship(u: number, v: number, len: number, wid: number): Part[] {
  const hw = wid / 2;
  const P: Part[] = [];
  P.push(poly([u, v - hw, u + len - 4, v - hw, u + len, v, u + len - 4, v + hw, u, v + hw], 0, 2.2, 'merchant', { tone: 0.6 }));
  P.push(poly([u + 0.4, v - hw + 0.5, u + len - 4.4, v - hw + 0.5, u + len - 1.2, v, u + len - 4.4, v + hw - 0.5, u + 0.4, v + hw - 0.5], 2.2, 0, 'deck'));
  P.push(bx(u, v + hw - 0.7, u + len - 4, v + hw, 0.2, 1.4, 'redlead', { tone: 0.2 }));
  const cols: Mat[] = ['rust', 'fadedBlue', 'ochre', 'olive'];
  const nh = Math.max(1, Math.floor((len - 7.4) / 2.9));
  for (let i = 0; i < nh; i++) P.push(bx(u + 7.4 + i * 2.9, v - hw + 0.7, u + 10 + i * 2.9, v + hw - 0.7, 2.2, 1.8, cols[i % 4], { pat: 'ribs', tone: i * 0.3 - 0.4 }));
  P.push(bx(u + 1.2, v - hw + 0.7, u + 5.4, v + hw - 0.7, 2.2, 3.6, 'white'), bx(u + 1.0, v - hw + 0.5, u + 5.6, v + hw - 0.5, 5.8, 0.5, 'sup', { tone: 0.6 }), band(u + 1.6, v + hw - 1.5, u + 5.0, v + hw - 0.9, 6.3));
  P.push(el(u + 6.4, v, 1.0, 1.0, 2.2, 3.2, 'redlead', { sh: 'cyl' }));
  return P;
}
/** A lighthouse: a rock plinth, a white tower with a red band, a gallery, a glowing lantern under a red cap. */
function lighthouse(u: number, v: number, h = 11): Part[] {
  const z1 = 1.2 + h * 0.84;
  return [
    el(u, v, 2.8, 2.5, 0, 1.2, 'sup', { sh: 'cyl', tone: -0.2 }),
    el(u, v, 1.9, 1.7, 1.2, h * 0.34, 'white', { sh: 'cyl' }),
    el(u, v, 1.65, 1.5, 1.2 + h * 0.34, h * 0.22, 'redlead', { sh: 'cyl' }),
    el(u, v, 1.45, 1.3, 1.2 + h * 0.56, h * 0.28, 'white', { sh: 'cyl' }),
    el(u, v, 2.3, 2.1, z1, 0.5, 'sup', { sh: 'cyl', tone: 0.4 }),
    el(u, v, 1.0, 0.95, z1 + 0.5, 1.5, 'brass', { sh: 'cyl', glow: true }),
    el(u, v, 1.4, 1.3, z1 + 2.0, 1.1, 'redlead', { sh: 'dome', tone: 0.2 }),
    el(u, v, 0.25, 0.25, z1 + 3.1, 1.0, 'gun', { sh: 'cyl' }),
  ];
}
/** The harbour office: a white house with a tiled hip roof, a chimney, windows, a flag. */
function harbourOffice(u0: number, v0: number, u1: number, v1: number): Part[] {
  return [...house(u0, v0, u1, v1, 3.6, 'brick', 'white', { hip: true, chim: 0.7 }), ...windows(u0, u1, v1, 1.0, 3.2, false, 91), band(u0, v1 - 0.8, u1, v1 - 0.2, 3.9), bx(u0 + 1.6, v1, u0 + 2.8, v1 + 0.6, 0, 2.0, 'black', { tone: 0.5 }), ...flag(u1 + 0.6, v0 + 0.8, 0, 8, 4)];
}
/** A concrete breakwater (a mole) along a path: a wide low wall with a cap, rubble boulders on both flanks, a lighthouse at the tip. */
function breakwater(pts: [number, number][], simple: boolean): Part[] {
  const P: Part[] = [];
  for (let i = 0; i + 1 < pts.length; i++) {
    const [a, b] = pts[i];
    const [c, d] = pts[i + 1];
    P.push(seg(a, b, c, d, 2.8, 0.4, 2.0, 'sup', { tone: -0.2 }), seg(a, b, c, d, 1.5, 2.4, 0.5, 'sup', { tone: 0.5 }));
    const n = Math.max(2, Math.round(Math.hypot(c - a, d - b) / 1.7));
    for (let k = 0; k < n; k++) {
      const t = (k + 0.5) / n;
      const pu = a + (c - a) * t;
      const pv = b + (d - b) * t;
      if (simple && k % 2) continue;
      P.push(el(pu, pv + 1.8 + (hash(i, k, 3) - 0.5) * 0.5, 0.95, 0.75, 0, 1.4, 'fieldgrey', { sh: 'dome', tone: hash(i, k, 4) * 0.8 - 0.2 }), el(pu + 0.6, pv - 1.8 + (hash(i, k, 5) - 0.5) * 0.5, 0.9, 0.7, 0, 1.3, 'fieldgrey', { sh: 'dome', tone: hash(i, k, 6) * 0.8 - 0.3 }));
    }
  }
  const [tu, tv] = pts[pts.length - 1];
  P.push(...lighthouse(tu - 0.3, tv, 9));
  return P;
}
/**
 * A coastal gun emplacement: a concrete casemate with chamfered seaward corners, banked with earth on its landward
 * side, a gun in a round pit on its roof and a long barrel pointing east over the water, a door on its south side.
 */
function casemate(u: number, v: number, simple = false): Part[] {
  const P: Part[] = [];
  P.push(el(u - 3.6, v, 3.0, 4.6, 0, 2.4, 'camo', { sh: 'dome', tone: -0.3 }), el(u - 1.0, v - 3.9, 3.8, 1.5, 0, 1.6, 'camo', { sh: 'dome', tone: -0.2 }), el(u - 1.0, v + 3.9, 3.8, 1.5, 0, 1.6, 'camo', { sh: 'dome', tone: -0.2 }));
  const shell = [u - 4, v - 3, u + 2.6, v - 3, u + 4.2, v - 1.4, u + 4.2, v + 1.4, u + 2.6, v + 3, u - 4, v + 3];
  const lid = [u - 3.4, v - 2.4, u + 2.4, v - 2.4, u + 3.6, v - 1.2, u + 3.6, v + 1.2, u + 2.4, v + 2.4, u - 3.4, v + 2.4];
  P.push(poly(shell, 0, 3.0, 'sup', { tone: -0.2 }), poly(shell, 3.0, 0.5, 'sup', { tone: 0.5, edge: true }), poly(lid, 3.0, 0, 'sup', { inset: true, tone: -0.1 }));
  // the gun on the roof: a round sandbag ring round its pit, a mount in the owner's colour, a dark turret and a long barrel out to sea
  P.push(...sandRing(u + 0.2, v, 3.1, 2.5, 3.0, simple));
  P.push(el(u + 0.2, v, 2.3, 1.9, 3.0, 1.0, 'own', { sh: 'dome', tone: 0.2 }), el(u + 0.2, v, 1.5, 1.3, 4.0, 0.9, 'gun', { sh: 'dome', tone: 0.3 }));
  P.push(...barrel(u + 0.6, v, u + 11, v - 0.4, 1.6, 4.2), el(u + 11.2, v - 0.4, 1.1, 1.1, 4.2, 1.5, 'gun', { tone: 0.3 }));
  P.push(bx(u - 2.6, v + 3.0, u - 1.0, v + 3.14, 0, 2.0, 'black', { tone: 0.5 }), band(u - 3.0, v + 1.4, u - 1.0, v + 2.0, 3.0));
  return P;
}
function portModel(lv: number, addon: Addon, simple = false): Part[] {
  const P: Part[] = [];
  for (const p of pierList(lv)) P.push(...pier(p, simple));
  for (const h of hullList(lv)) P.push(...(h.kind === 'tug' ? tug(h.u, h.v, h.len, h.wid) : ship(h.u, h.v, h.len, h.wid)));
  if (lv >= 3) {
    // fewer, bigger pieces with open water between them: one gantry over the cargo ship, one tug, one big warehouse
    P.push(...gantry(11, -10.6, 1, 6.2, DECK));
    P.push(...warehouse(-26, -19.5, -10.5, -12.8, 'tan', 'cargo', 1, simple, 4.0));
    P.push(...containers(-24, -4, 3, 2, 2, true));
    P.push(...breakwater(MOLE, simple));
  } else {
    P.push(...jibCrane(3.5, -0.2, DECK, 9.5, 6.5));
    P.push(rope(8, 4.3 - 2.1, 1.2), rope(14, 4.3 - 2.1, 1.2), rope(10, -4.3 + 1.5, -0.8), rope(14, -4.3 + 1.5, -0.8));
    P.push(...warehouse(-24, -11, -8, -4.6, 'tan', 'fieldgrey', 3, simple, 3.8), ...harbourOffice(-6.5, -9.6, -2, -5.6));
    P.push(...containers(-24, 3, 4, 2, 4, true), ...containers(-24, 10, 3, 1, 9, false), ...lighthouse(-3.2, 10.4, 10));
  }
  P.push(...portAddon(lv, addon, simple));
  return P;
}
/** The port's add-on: two coastal gun emplacements on the shore. */
function portAddon(lv: number, addon: Addon, simple: boolean): Part[] {
  if (addon !== 'guns') return [];
  return lv >= 3 ? [...casemate(-4.8, -17.2, simple), ...casemate(-5.2, 3.4, simple)] : [...casemate(-4.5, -14.2, simple), ...casemate(-4.5, 15, simple)];
}

function modelOf(spec: BuildingSpec, simple: boolean): Part[] {
  switch (spec.type) {
    case 'fort':
      return fortModel(spec.level, spec.addon, simple);
    case 'city':
      return cityModel(spec.level, spec.addon, simple);
    case 'sam':
      return samModel(spec.level, spec.addon, simple);
    case 'port':
      return portModel(spec.level, spec.addon, simple);
  }
}

// ------------------------------------------------------------------------------------------------- the ground

/** The terrain under a building: its colour at a cell pixel, and whether that pixel is water. */
export interface Under {
  rgb: (ax: number, ay: number) => RGB;
  water: (ax: number, ay: number) => boolean;
}

type Kind = 'dirt' | 'dirtL' | 'dark' | 'road' | 'water' | 'sand' | 'foam' | 'shadow';
/** What each kind does to the colour of the land under it (so it is always a shade of that land). */
const KIND: Record<Kind, (c: C) => RGB> = {
  dirt: (c) => dark(mix(c, [118, 94, 62], 0.55), 0.94),
  dirtL: (c) => mix(c, [184, 164, 122], 0.42),
  dark: (c) => dark(mix(c, [60, 78, 52], 0.25), 0.78),
  road: (c) => dark(mix(c, [96, 92, 82], 0.5), 0.72),
  water: (c) => mix(c, [56, 92, 108], 0.8),
  sand: (c) => mix(c, [196, 176, 132], 0.55),
  foam: (c) => mix(c, [232, 238, 238], 0.66),
  shadow: (c) => [cl(c[0] * 0.44), cl(c[1] * 0.46), cl(c[2] * 0.54)],
};

function inFoot(p: Part, u: number, v: number): boolean {
  const q = p.p;
  switch (p.k) {
    case 'box':
      return u >= q[0] && u < q[2] && v >= q[1] && v < q[3];
    case 'ell': {
      const a = (u - q[0]) / q[2];
      const b = (v - q[1]) / q[3];
      return a * a + b * b <= 1;
    }
    case 'poly': {
      let inside = false;
      for (let i = 0, j = q.length - 2; i < q.length; j = i, i += 2) {
        if (q[i + 1] > v !== q[j + 1] > v && u < ((q[j] - q[i]) * (v - q[i + 1])) / (q[j + 1] - q[i + 1]) + q[i]) inside = !inside;
      }
      return inside;
    }
    case 'seg': {
      const du = q[2] - q[0];
      const dv = q[3] - q[1];
      const L2 = du * du + dv * dv || 1e-9;
      const t = Math.max(0, Math.min(1, ((u - q[0]) * du + (v - q[1]) * dv) / L2));
      return Math.hypot(u - q[0] - du * t, v - q[1] - dv * t) <= q[4] / 2;
    }
  }
}
function footBox(p: Part): [number, number, number, number] {
  const q = p.p;
  switch (p.k) {
    case 'box':
      return [q[0], q[1], q[2], q[3]];
    case 'ell':
      return [q[0] - q[2], q[1] - q[3], q[0] + q[2], q[1] + q[3]];
    case 'seg': {
      const r = q[4] / 2;
      return [Math.min(q[0], q[2]) - r, Math.min(q[1], q[3]) - r, Math.max(q[0], q[2]) + r, Math.max(q[1], q[3]) + r];
    }
    case 'poly': {
      let a = Infinity;
      let b = Infinity;
      let c = -Infinity;
      let d = -Infinity;
      for (let i = 0; i < q.length; i += 2) {
        a = Math.min(a, q[i]);
        b = Math.min(b, q[i + 1]);
        c = Math.max(c, q[i]);
        d = Math.max(d, q[i + 1]);
      }
      return [a, b, c, d];
    }
  }
}

/** The painted ground of a cell: soft dithered overlays whose colours are derived from the terrain colour under them. */
class Ground {
  readonly d: Uint8ClampedArray;
  /** far look: coverage becomes a smooth alpha (no dither steps) so the patch fades into the terrain */
  smooth = false;
  constructor(
    readonly W: number,
    readonly H: number,
    readonly res: number,
    readonly ox: number,
    readonly oy: number,
    readonly under: Under,
  ) {
    this.d = new Uint8ClampedArray(W * H * 4);
  }
  /** model coordinates of a cell pixel's centre (on the ground) */
  private u(ax: number): number {
    return (ax + 0.5 - this.ox) / this.res;
  }
  private v(ay: number): number {
    return (ay + 0.5 - this.oy) / (this.res * FORE);
  }
  /** a pixel of a kind with coverage m (0..1, the strongest alpha amax), quantised to 4 dithered steps */
  put(ax: number, ay: number, kind: Kind, m: number, amax: number): void {
    if (m <= 0 || ax < 0 || ay < 0 || ax >= this.W || ay >= this.H) return;
    let a: number;
    if (this.smooth) {
      a = amax * Math.min(1, m);
      if (a < 0.01) return;
    } else {
      const lvl = Math.floor(m * 3 + bayer(ax, ay));
      if (lvl <= 0) return;
      a = (amax * Math.min(3, lvl)) / 3;
    }
    const sea = this.under.water(ax, ay);
    if (sea && kind !== 'shadow' && kind !== 'foam') return;
    if (!sea && kind === 'foam') return;
    const base = this.under.rgb(ax, ay);
    const col = KIND[kind](base);
    const o = (ay * this.W + ax) * 4;
    const da = this.d[o + 3] / 255;
    const oa = a + da * (1 - a);
    const w = da * (1 - a);
    this.d[o] = (col[0] * a + this.d[o] * w) / oa;
    this.d[o + 1] = (col[1] * a + this.d[o + 1] * w) / oa;
    this.d[o + 2] = (col[2] * a + this.d[o + 2] * w) / oa;
    this.d[o + 3] = oa * 255;
  }
  /** paints coverage fn(u, v) (0..1) over a model box */
  paint(kind: Kind, u0: number, v0: number, u1: number, v1: number, amax: number, fn: (u: number, v: number) => number): void {
    const ax0 = Math.floor(this.ox + u0 * this.res);
    const ax1 = Math.ceil(this.ox + u1 * this.res);
    const ay0 = Math.floor(this.oy + v0 * this.res * FORE);
    const ay1 = Math.ceil(this.oy + v1 * this.res * FORE);
    for (let ay = ay0; ay <= ay1; ay++) for (let ax = ax0; ax <= ax1; ax++) this.put(ax, ay, kind, fn(this.u(ax), this.v(ay)), amax);
  }
  /** a ragged-edged ellipse */
  blob(kind: Kind, cu: number, cv: number, ru: number, rv: number, amax: number, soft = 0.35, seed = 1): void {
    this.paint(kind, cu - ru * 1.3, cv - rv * 1.3, cu + ru * 1.3, cv + rv * 1.3, amax, (u, v) => {
      const r = Math.hypot((u - cu) / ru, (v - cv) / rv) + (vnoise(u * 0.45, v * 0.45, seed) - 0.5) * 0.42;
      return Math.max(0, Math.min(1, (1 - r) / soft));
    });
  }
  /** a ragged-edged rounded rectangle; `inner` > 0 makes it a ring that wide */
  slab(kind: Kind, u0: number, v0: number, u1: number, v1: number, rad: number, amax: number, soft = 2.2, seed = 2, inner = 0): void {
    const cu = (u0 + u1) / 2;
    const cv = (v0 + v1) / 2;
    const hw = (u1 - u0) / 2;
    const hh = (v1 - v0) / 2;
    this.paint(kind, u0 - 3, v0 - 3, u1 + 3, v1 + 3, amax, (u, v) => {
      const dx = Math.max(Math.abs(u - cu) - (hw - rad), 0);
      const dy = Math.max(Math.abs(v - cv) - (hh - rad), 0);
      const dist = Math.hypot(dx, dy) - rad + (vnoise(u * 0.4, v * 0.4, seed) - 0.5) * 1.6;
      let m = Math.max(0, Math.min(1, -dist / soft));
      if (inner > 0) m = Math.min(m, Math.max(0, Math.min(1, (dist + inner) / soft)));
      return m;
    });
  }
  /** a worn strip along a line */
  strip(kind: Kind, u0: number, v0: number, u1: number, v1: number, w: number, amax: number, seed = 3): void {
    const du = u1 - u0;
    const dv = v1 - v0;
    const L2 = du * du + dv * dv || 1e-9;
    this.paint(kind, Math.min(u0, u1) - w, Math.min(v0, v1) - w, Math.max(u0, u1) + w, Math.max(v0, v1) + w, amax, (u, v) => {
      const t = Math.max(0, Math.min(1, ((u - u0) * du + (v - v0) * dv) / L2));
      const d = Math.hypot(u - u0 - du * t, v - v0 - dv * t) + (vnoise(u * 0.7, v * 0.7, seed) - 0.5) * 0.7;
      return Math.max(0, Math.min(1, (w / 2 - d) / (w * 0.3)));
    });
  }
  /** the shadow cast by the parts: each part's footprint swept toward the lower right by its height (light from the upper left) */
  shadows(parts: readonly Part[], amax: number, soft = 0, wide = 1): void {
    let m = new Float32Array(this.W * this.H);
    const dirU = 0.62;
    const dirV = 0.5;
    for (const p of parts) {
      const top = p.z + p.h;
      if (top < 0.7 || p.glow || (p.a ?? 1) < 1 || p.edge) continue;
      // thin things hung on a wall (window panes, doors) cast no shadow of their own
      if (p.k === 'box' && p.p[3] - p.p[1] <= 0.7) continue;
      const reach = top * 0.55 * wide;
      const n = Math.max(1, Math.ceil(reach * this.res * 0.8));
      const [a, b, c, e] = footBox(p);
      const ax0 = Math.max(0, Math.floor(this.ox + a * this.res) - 1);
      const ax1 = Math.min(this.W - 1, Math.ceil(this.ox + (c + reach * dirU) * this.res) + 1);
      const ay0 = Math.max(0, Math.floor(this.oy + b * this.res * FORE) - 1);
      const ay1 = Math.min(this.H - 1, Math.ceil(this.oy + (e + reach * dirV) * this.res * FORE) + 1);
      for (let ay = ay0; ay <= ay1; ay++) {
        const v = this.v(ay);
        for (let ax = ax0; ax <= ax1; ax++) {
          const u = this.u(ax);
          for (let s = 0; s <= n; s++) {
            const f = (s / n) * reach;
            if (inFoot(p, u - f * dirU, v - f * dirV)) {
              m[ay * this.W + ax] = 1;
              break;
            }
          }
        }
      }
    }
    // far look: blur the mask several times so the shadow is wide and soft
    for (let pass = 0; pass < soft; pass++) {
      const o = new Float32Array(m.length);
      const r = 2;
      for (let ay = 0; ay < this.H; ay++) {
        for (let ax = 0; ax < this.W; ax++) {
          let t = 0;
          let n = 0;
          for (let j = -r; j <= r; j++) {
            for (let i = -r; i <= r; i++) {
              const x = ax + i;
              const y = ay + j;
              if (x >= 0 && y >= 0 && x < this.W && y < this.H) t += m[y * this.W + x];
              n++;
            }
          }
          o[ay * this.W + ax] = t / n;
        }
      }
      m = o;
    }
    // soften by one pixel so the penumbra dithers
    for (let ay = 0; ay < this.H; ay++) {
      for (let ax = 0; ax < this.W; ax++) {
        let s = 0;
        for (let j = -1; j <= 1; j++) {
          for (let i = -1; i <= 1; i++) {
            const x = ax + i;
            const y = ay + j;
            if (x >= 0 && y >= 0 && x < this.W && y < this.H) s += m[y * this.W + x];
          }
        }
        const cov = s / 9;
        if (cov > 0.04) this.put(ax, ay, 'shadow', Math.min(1, cov * (soft ? 1.6 : 1.25)), amax);
      }
    }
  }
  /** the coast: wet sand on the land within a few units of the water, foam on the water next to it */
  shore(): void {
    const R = Math.max(2, Math.round(this.res * 3));
    for (let ay = 0; ay < this.H; ay++) {
      for (let ax = 0; ax < this.W; ax++) {
        const sea = this.under.water(ax, ay);
        let best = 99;
        for (let r = 1; r <= R && best === 99; r++) {
          for (const [i, j] of [[r, 0], [-r, 0], [0, r], [0, -r], [r, r], [-r, -r], [r, -r], [-r, r]]) {
            if (this.under.water(ax + i, ay + j) !== sea) {
              best = r;
              break;
            }
          }
        }
        if (best === 99) continue;
        if (sea) {
          // a broken band of foam along the water's edge, wider where the noise is high
          const n = 0.55 + vnoise(this.u(ax) * 0.8, this.v(ay) * 0.8, 77) * 0.9;
          const reach = this.res * 1.6 * n;
          this.put(ax, ay, 'foam', best <= 1 ? 1 : Math.max(0, 1 - (best - 1) / reach), 0.62);
        }
        else this.put(ax, ay, 'sand', 1 - (best - 1) / R, 0.6);
      }
    }
  }
}

function groundOf(g: Ground, spec: BuildingSpec): void {
  const lv = spec.level;
  switch (spec.type) {
    case 'fort': {
      const w = lv >= 5 ? 36 : lv >= 3 ? 30 : 24;
      const d = lv >= 5 ? 24 : lv >= 3 ? 20 : 15;
      g.slab('dark', -w / 2 - 8, -d / 2 - 7, w / 2 + 8, d / 2 + 12, 7, 0.4, 5, 5);
      g.slab('dirt', -w / 2 - 4.5, -d / 2 - 4, w / 2 + 4.5, d / 2 + 5, 5, 0.8, 3, 6);
      if (lv >= 5) {
        g.slab('water', -w / 2 - 3.6, -d / 2 - 3.6, w / 2 + 3.6, d / 2 + 3.6, 3, 0.8, 1.2, 7, 3.4);
        g.slab('dark', -w / 2 - 5.4, -d / 2 - 5.4, w / 2 + 5.4, d / 2 + 5.4, 4, 0.5, 1.4, 8, 1.7);
      }
      g.strip('dirtL', 0, d / 2, 2.4, d / 2 + 13, 3.6, 0.6);
      g.blob('dark', -w / 2 - 6, d / 2 + 6, 4, 2.6, 0.5, 0.4, 9);
      g.blob('dark', w / 2 + 7, -d / 2 - 3, 4.5, 3, 0.45, 0.4, 10);
      g.blob('dirtL', w / 2 + 3, d / 2 + 4, 3, 1.8, 0.4, 0.4, 11);
      break;
    }
    case 'city': {
      const [u0, v0, u1, v1] = cityBounds(lv);
      // the town's own ground (its streets show it between the blocks), a plaza in front of the landmark, worn lanes out
      g.slab('dark', u0 - 4, v0 - 3, u1 + 4, v1 + 4, 7, 0.4, 5, 12);
      g.slab('dirt', u0 - 1.2, v0 - 1.2, u1 + 1.2, v1 + 1.2, 4, 0.8, 2, 13);
      g.slab('dirtL', u0 + 1, v0 + 1, u1 - 1, v1 - 1, 3, 0.4, 3, 14);
      // the streets of a modern city: worn tarmac in the gaps between the blocks
      const [hs, vs] = cityStreets(lv);
      for (const sv of hs) g.strip('road', u0 + 1.5, sv, u1 - 1.5, sv, 3, 0.55, 60 + Math.round(sv));
      for (const su of vs) g.strip('road', su, v0 + 1.5, su, v1 - 1.5, 3, 0.55, 70 + Math.round(su));
      g.strip('dirtL', 0, v1, 2.8, v1 + 10, 3, 0.5, 16);
      g.blob('dark', u0 - 5, v1 + 1, 4, 2.4, 0.5, 0.4, 17);
      break;
    }
    case 'sam': {
      const rx = lv >= 3 ? 23 : 18;
      const ry = lv >= 3 ? 17 : 12;
      const cv = lv >= 3 ? 2 : 1.5;
      g.blob('dark', 1, cv, rx + 5, ry + 4, 0.45, 0.4, 18);
      g.blob('dirt', 1, cv, rx, ry, 0.78, 0.28, 19);
      g.blob('dirtL', 1, cv + 1, rx * 0.66, ry * 0.62, 0.42, 0.4, 20);
      // the earth bank round the yard, and tyre tracks running out of it
      g.slab('dark', 1 - rx, cv - ry, 1 + rx, cv + ry, ry * 0.9, 0.5, 1.6, 21, 1.8);
      g.strip('dark', -2, cv + 4, -rx - 7, cv + 17, 1.1, 0.5, 22);
      g.strip('dark', -0.6, cv + 4.4, -rx - 5.6, cv + 17.4, 1.1, 0.5, 23);
      g.strip('dirtL', rx - 3, cv, rx + 9, cv - 6, 2.8, 0.5, 24);
      break;
    }
    case 'port': {
      const L = 26;
      const top = lv >= 3 ? -24 : -15;
      const bot = lv >= 3 ? 14 : 17;
      g.slab('dark', -L - 4, top - 3, COAST + 2, bot + 3, 6, 0.4, 5, 25);
      g.slab('dirt', -L, top, COAST + 1, bot, 4, 0.78, 3, 26);
      // the concrete quay along the water, yards and a lane in light concrete
      g.slab('road', -7.5, top + 2, COAST + 2, bot - 1, 2.4, 0.5, 1.8, 27);
      if (lv >= 3) {
        g.slab('dirtL', -26, -5.4, -6, 5.6, 2, 0.5, 2.4, 28);
        g.strip('road', -26, -9.5, -3, -9.5, 2.4, 0.45, 30);
      } else {
        g.slab('dirtL', -26, 2, -6, 12.6, 2, 0.5, 2.4, 28);
        g.strip('road', -26, -2.4, -3, -2.4, 2.4, 0.45, 30);
      }
      g.blob('dark', -23, bot - 2, 4, 3, 0.5, 0.4, 31);
      // foam round every pile and the pier heads, white wash round the ships
      for (const p of pierList(lv)) {
        for (let u = p.u0 + 1.5; u <= p.u1; u += 2.4) g.blob('foam', u, p.v1 + 0.4, 1.0, 0.8, 0.55, 0.5, 40 + Math.round(u));
        for (let v = p.v0 + 0.6; v <= p.v1; v += 1.4) g.blob('foam', p.u1 + 0.4, v, 0.9, 0.8, 0.55, 0.5, 60 + Math.round(v));
        g.strip('foam', p.u0 + 1, p.v1 + 1.2, p.u1 + 0.5, p.v1 + 1.2, 1.6, 0.4, 70);
      }
      for (const h of hullList(lv)) {
        const cu = h.u + h.len / 2;
        g.paint('foam', cu - h.len / 2 - 2, h.v - h.wid / 2 - 2, cu + h.len / 2 + 2, h.v + h.wid / 2 + 2, 0.5, (u, v) => {
          const r = Math.hypot((u - cu) / (h.len / 2 + 0.7), (v - h.v) / (h.wid / 2 + 0.7));
          return Math.max(0, 1 - Math.abs(r - 1) / 0.22) * (0.45 + vnoise(u * 0.9, v * 0.9, 5) * 0.9);
        });
      }
      if (lv >= 3) {
        // the breakwater's wash
        for (let i = 0; i + 1 < MOLE.length; i++) g.strip('foam', MOLE[i][0], MOLE[i][1], MOLE[i + 1][0], MOLE[i + 1][1], 6, 0.55, 80 + i);
      }
      break;
    }
  }
}

// ------------------------------------------------------------------------------------------------- bake

export interface BakedBuilding {
  canvas: HTMLCanvasElement;
  /** the cell's size on screen (CSS px) */
  w: number;
  h: number;
  /** the highest solid row of the building and the model origin's column (CSS px in the cell), for the level pill */
  top: number;
  cx: number;
}

/**
 * The picture of a building: the ground painted from the terrain colour under it, then the part model rasterized by the
 * game's unit rasterizer (res and pixel size from the units' own grid at map scale `scale`) with the owner outline.
 * `fillWater` paints the sea under a port first (the lab sheet; on the map the sea is already there).
 */
export function bakeBuilding(spec: BuildingSpec, owner: RGB, scale: number, dpr: number, under: Under, fillWater = false): BakedBuilding {
  const g = gridOf(scale, dpr);
  const res = g.res;
  const CW = Math.round(CU * res);
  const CH = Math.round(CV * res);
  const ox = Math.round(OU * res);
  const oy = Math.round(OV * res);
  const simple = scale < 2;
  const parts = modelOf(spec, simple);
  const gr = new Ground(CW, CH, res, ox, oy, under);
  if (fillWater) {
    for (let y = 0; y < CH; y++) {
      for (let x = 0; x < CW; x++) {
        if (!under.water(x, y)) continue;
        const c = under.rgb(x, y);
        const o = (y * CW + x) * 4;
        gr.d[o] = c[0];
        gr.d[o + 1] = c[1];
        gr.d[o + 2] = c[2];
        gr.d[o + 3] = 255;
      }
    }
  }
  groundOf(gr, spec);
  if (spec.type === 'port') gr.shore();
  gr.shadows(parts, 0.62);
  const d = gr.d;
  const bx0 = (b: Baked): number => ox - b.ox;
  const by0 = (b: Baked): number => oy - b.oy;
  let topRow = CH;
  /** composites a baked sprite over the cell; `skip` leaves out pixels */
  const lay = (b: Baked, skip?: (x: number, y: number) => boolean): void => {
    for (let y = 0; y < b.h; y++) {
      for (let x = 0; x < b.w; x++) {
        const s = (y * b.w + x) * 4;
        const sa = b.data[s + 3] / 255;
        if (sa <= 0 || (skip && skip(x, y))) continue;
        const X = x + bx0(b);
        const Y = y + by0(b);
        if (sa >= 0.78) topRow = Math.min(topRow, Y);
        if (X < 0 || Y < 0 || X >= CW || Y >= CH) continue;
        const o = (Y * CW + X) * 4;
        const da = d[o + 3] / 255;
        const oa = sa + da * (1 - sa);
        const w = da * (1 - sa);
        d[o] = (b.data[s] * sa + d[o] * w) / oa;
        d[o + 1] = (b.data[s + 1] * sa + d[o + 1] * w) / oa;
        d[o + 2] = (b.data[s + 2] * sa + d[o + 2] * w) / oa;
        d[o + 3] = oa * 255;
      }
    }
  };
  if (spec.type === 'city') {
    // one outline round the whole town (and its add-ons), none round each block: the ring is cut from the silhouette of the
    // town's outer shape, then the blocks are drawn over it on their own with their dark edges, so the streets stay open
    // the shape is every lot grown by 3.6 units, so the streets close up and the ring hugs the town's real outline
    const shape: Part[] = cityLots(spec.level).map((l) => ({ k: 'box' as const, p: [l.u - l.w / 2 - 3.6, l.v - l.d / 2 - 3.6, l.u + l.w / 2 + 3.6, l.v + l.d / 2 + 3.6], z: 0, h: 0.3, m: 'tan' as const }));
    const flak = cityAddon(spec.level, spec.addon, simple).map((p) => ({ ...p, m: 'tan' as const, pat: undefined, tone: 0 }));
    const raw = rasterize({ parts: [...shape, ...flak], ground: 0 }, res, 0, { facings: 32, owner });
    const ring = outlineOf(raw, owner, ringWidth(g.k));
    const G = ring.ox - raw.ox;
    lay(ring, (x, y) => {
      const rx = x - G;
      const ry = y - G;
      return rx >= 0 && ry >= 0 && rx < raw.w && ry < raw.h && raw.data[(ry * raw.w + rx) * 4 + 3] >= 200;
    });
    lay(rasterize({ parts, ground: 0 }, res, 0, { facings: 32, owner }));
  } else {
    lay(outlineOf(rasterize({ parts, ground: 0.3 }, res, 0, { facings: 32, owner }), owner, ringWidth(g.k)));
  }
  const cv = makeCanvas(CW, CH);
  const cx = cv.getContext('2d');
  if (cx) {
    const img = cx.createImageData(CW, CH);
    img.data.set(d);
    cx.putImageData(img, 0, 0);
  }
  return { canvas: cv, w: CW * g.k, h: CH * g.k, top: topRow * g.k, cx: ox * g.k };
}

/** The level chip (close zoom only; at normal zoom the building's size and look tell its level): the army count pill's look (a near-black outline, a dark plate, a faint light top row), the owner's colour on its left edge. */
function levelPill(ctx: CanvasRenderingContext2D, cx: number, y: number, level: number, owner: RGB): void {
  const text = `Lv ${level}`;
  ctx.font = `600 10px ${MAP_NUM_FAMILY}`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  const tw = Math.ceil(ctx.measureText(text).width);
  const w = tw + 12;
  const h = 13;
  const x0 = Math.round(cx - w / 2);
  const y0 = Math.round(y);
  ctx.fillStyle = 'rgb(8,10,13)';
  ctx.fillRect(x0, y0, w, h);
  ctx.fillStyle = 'rgba(20,23,29,0.96)';
  ctx.fillRect(x0 + 1, y0 + 1, w - 2, h - 2);
  ctx.fillStyle = 'rgba(255,255,255,0.08)';
  ctx.fillRect(x0 + 1, y0 + 1, w - 2, 1);
  ctx.fillStyle = `rgb(${owner[0]},${owner[1]},${owner[2]})`;
  ctx.fillRect(x0 + 1, y0 + 1, 3, h - 2);
  ctx.fillStyle = '#ffffff';
  ctx.fillText(text, x0 + 7, y0 + h / 2 + 0.5);
}

// ------------------------------------------------------------------------------------------------- far look (normal zoom)

/** The far look (normal zoom): colours pulled toward the land, a thin soft owner outline, a wide soft shadow. */
const FAR_GAIN = 0.72;
/** the same for add-ons (guns), kept stronger so they still read */
const FAR_ADD_GAIN = 0.95;
const FAR_RING_A = 0.5;
const FAR_SHADOW_A = 0.36;

/** Simplified shapes for far zoom: big masses, no windows, merlons, gear, piles or trees. */
function farModel(spec: BuildingSpec): Part[] {
  const lv = spec.level;
  const P: Part[] = [];
  switch (spec.type) {
    case 'fort': {
      const cfg = lv >= 5 ? { w: 36, d: 24, t: 3.2, wz: 8, tz: 12, r: 4.0 } : lv >= 3 ? { w: 30, d: 20, t: 2.8, wz: 6, tz: 9, r: 3.3 } : { w: 24, d: 15, t: 2.2, wz: 4.2, tz: 6.5, r: 2.6 };
      const { w, d, t, wz, tz, r } = cfg;
      const x0 = -w / 2;
      const x1 = w / 2;
      const y0 = -d / 2;
      const y1 = d / 2;
      const gate = 3.6;
      P.push(bx(x0 + t, y0 + t, x1 - t, y1 - t, 0, 0, 'tan', { inset: true, tone: -1 }));
      P.push(bx(x0, y0, x1, y0 + t, 0, wz, 'sup', { tone: -0.2 }), bx(x0, y0, x0 + t, y1, 0, wz, 'sup', { tone: -0.2 }), bx(x1 - t, y0, x1, y1, 0, wz, 'sup', { tone: -0.2 }), bx(x0, y1 - t, -gate, y1, 0, wz, 'sup', { tone: -0.2 }), bx(gate, y1 - t, x1, y1, 0, wz, 'sup', { tone: -0.2 }));
      P.push(bx(-gate - 0.9, y1 - t - 0.6, gate + 0.9, y1 + 0.4, 0, wz + 1.2, 'sup', { tone: 0.1 }));
      if (lv >= 3) P.push(bx(-5.2, -4.4, 5.2, 2.4, 0, lv >= 5 ? 12 : 7.6, 'cream', { tone: -0.3 }), ...hip(-5.2, -4.4, 5.2, 2.4, lv >= 5 ? 12 : 7.6, 'fieldgrey', { rh: 2.4, over: 0.5 }));
      else P.push(...house(-8.4, -3.9, 0.6, -0.3, 3.0, 'rust', 'cream'), ...house(3.2, -3.8, 8.6, 0.8, 2.6, 'brick', 'canvas', { hip: true }));
      for (const [cx, cy] of [[x0, y0], [x1, y0], [x0, y1], [x1, y1]]) P.push(el(cx, cy, r, r * 0.9, 0, tz, 'sup', { sh: 'cyl', tone: -0.1 }), el(cx, cy, r * 0.9, r * 0.8, tz, 1.6, 'rust', { sh: 'dome', tone: 0.5 }));
      break;
    }
    case 'city':
      cityLots(lv).sort((a, b) => a.v - b.v || a.u - b.u).forEach((l, i) => P.push(...lotFar(l, i)));
      break;
    case 'sam': {
      const bay = (u: number, v: number): Part[] => [bx(u - 10, v - 5.6, u + 11.5, v - 4.1, 0, 1.0, 'tan', { tone: -0.5 }), bx(u - 10, v + 4.1, u + 11.5, v + 5.6, 0, 1.0, 'tan', { tone: -0.5 }), bx(u - 10, v - 5.6, u - 8.5, v + 5.6, 0, 1.0, 'tan', { tone: -0.5 }), bx(u - 6.5, v - 3, u + 6.5, v + 3, 1.0, 2.2, 'olive'), el(u - 1, v, 2.8, 2.5, 3.2, 0.8, 'own', { sh: 'dome' }), seg(u - 5, v, u + 5.5, v - 1.8, 2.4, 4.0, 0.9, 'white', { sh: 'cyl', tone: 0.4 })];
      const truck = (u: number, v: number): Part[] => [bx(u - 6, v - 2.4, u + 6, v + 2.4, 0.8, 3.4, 'olive', { tone: 0.2 }), bx(u - 5, v + 1.6, u + 2, v + 2.4, 4.2, 0, 'own')];
      if (lv >= 3) P.push(...truck(-1, -17.5), ...bay(-15.5, -4), ...bay(11, -4), ...bay(-2, 14));
      else P.push(...truck(12, -7), ...bay(-7, 4));
      break;
    }
    case 'port': {
      for (const p of pierList(lv)) P.push(bx(p.u0, p.v0, p.u1, p.v1, PIER_Z, 0.8, p.wood ? 'teak' : 'sup'));
      for (const h of hullList(lv)) {
        const hw = h.wid / 2;
        P.push(poly([h.u, h.v - hw, h.u + h.len - 3.5, h.v - hw, h.u + h.len, h.v, h.u + h.len - 3.5, h.v + hw, h.u, h.v + hw], 0, 2.2, 'merchant', { tone: 0.6 }), bx(h.u + 1.2, h.v - hw + 0.8, h.u + 5, h.v + hw - 0.8, 2.2, 3.2, 'white'));
        if (h.kind !== 'tug') P.push(bx(h.u + 7, h.v - hw + 0.8, h.u + h.len - 4, h.v + hw - 0.8, 2.2, 1.4, 'rust', { tone: -0.2 }));
      }
      if (lv >= 3) {
        P.push(bx(9.5, -11.6, 12.5, -9.6, DECK, 8, 'ochre', { tone: -0.2 }), seg(11, -10.6, 11, -2, 1.2, DECK + 8, 0.6, 'ochre', { tone: 0.3 }));
        P.push(bx(-26, -19.5, -10.5, -12.8, 0, 4.0, 'tan', { tone: -0.3 }), ...gable(-26, -19.5, -10.5, -12.8, 4.0, 'cargo', { rh: 1.8, over: 0.4, metal: true }));
        P.push(bx(-24, -4, -12, 1.4, 0, 2.3, 'rust', { tone: -0.2 }), bx(-24, -4, -18, 1.4, 2.3, 2.3, 'fadedBlue'));
        for (let i = 0; i + 1 < MOLE.length; i++) P.push(seg(MOLE[i][0], MOLE[i][1], MOLE[i + 1][0], MOLE[i + 1][1], 3.4, 0, 2.2, 'sup', { tone: 0.1 }));
        const [tu, tv] = MOLE[MOLE.length - 1];
        P.push(el(tu - 0.3, tv, 2.0, 1.8, 2.2, 7, 'white', { sh: 'cyl' }), el(tu - 0.3, tv, 1.6, 1.4, 9.2, 1.4, 'redlead', { sh: 'dome' }));
      } else {
        P.push(bx(2.5, -1.2, 4.5, 0.8, DECK, 7, 'ochre', { tone: -0.2 }), seg(3.5, -0.2, 9.5, 6.5, 1.2, DECK + 7, 0.6, 'ochre', { tone: 0.3 }));
        P.push(bx(-24, -11, -8, -4.6, 0, 3.8, 'tan', { tone: -0.3 }), ...gable(-24, -11, -8, -4.6, 3.8, 'fieldgrey', { rh: 1.6, over: 0.4, metal: true }), ...house(-6.5, -9.6, -2, -5.6, 3.6, 'brick', 'white', { hip: true }));
        P.push(bx(-24, 3, -8, 8.4, 0, 2.3, 'rust', { tone: -0.2 }), el(-3.2, 10.4, 1.9, 1.7, 1.2, 8, 'white', { sh: 'cyl' }), el(-3.2, 10.4, 1.5, 1.3, 9.2, 1.4, 'redlead', { sh: 'dome' }));
      }
      break;
    }
  }
  return P;
}
/** A lot at far zoom: one plain mass (no windows, gear, chimneys or trees). */
function lotFar(l: Lot, i: number): Part[] {
  const su0 = hash(i, 11, 1) * 1.1;
  const su1 = hash(i, 12, 1) * 1.1;
  const sv0 = hash(i, 13, 1) * 0.8;
  const sv1 = hash(i, 14, 1) * 0.4;
  const u0 = l.u - l.w / 2 + su0;
  const u1 = l.u + l.w / 2 - su1;
  const v0 = l.v - l.d / 2 + sv0;
  const v1 = l.v + l.d / 2 - sv1;
  const wall = l.wall ?? 'sup';
  switch (l.k) {
    case 'church':
      return [bx(l.u - l.w / 2, l.v - l.d / 2, l.u + l.w / 2, l.v + l.d / 2 - 3, 0, l.z, 'cream', { tone: -0.3 }), ...roof(l.u - l.w / 2, l.v - l.d / 2 + 0.8, l.u + l.w / 2, l.v + l.d / 2 - 3, l.z, l.roof, 1.9, 0.5), bx(l.u - 1.6, l.v + l.d / 2 - 3.2, l.u + 1.6, l.v + l.d / 2, 0, 10, 'cream'), bx(l.u - 1.2, l.v + l.d / 2 - 2.8, l.u + 1.2, l.v + l.d / 2 - 0.4, 10, 2.4, 'fadedBlue')];
    case 'gable':
    case 'L':
    case 'T':
      return house(u0, v0, u1, v1, l.z, l.roof, wall);
    case 'hip':
      return house(u0, v0, u1, v1, l.z, l.roof, wall, { hip: true });
    case 'block':
    case 'blockL':
      return [bx(u0, v0, u1, v1, 0, l.z, wall, { tone: -0.3 }), bx(u0 - 0.1, v0 - 0.1, u1 + 0.1, v1 + 0.1, l.z, 0.6, wall, { tone: 0.5, edge: true }), bx(u0 + 0.6, v0 + 0.6, u1 - 0.6, v1 - 0.6, l.z, 0, l.roof, { inset: true, tone: -0.2 })];
    case 'tower':
    case 'sky':
      return stackTower(l.u - l.w / 2, l.v - l.d / 2, l.u + l.w / 2, l.v + l.d / 2, l.stack ?? { tiers: [[l.z, 0]], fin: 'mast', lit: 0 }, wall, l.roof, i, true, true);
    case 'park':
      return park(l, true);
    case 'shed':
      return [bx(u0, v0, u1, v1, 0, l.z, wall, { tone: -0.3 }), ...gable(u0, v0, u1, v1, l.z, l.roof, { rh: 1.4, over: 0.4, metal: true })];
    case 'tanks':
      return [el((u0 + u1) / 2, (v0 + v1) / 2, 3, 2.8, 0, 4, 'white', { sh: 'cyl' })];
  }
}
/** Every add-on of a building (guns, traps, radar), drawn the same at every distance. */
function addonParts(spec: BuildingSpec, simple: boolean): Part[] {
  switch (spec.type) {
    case 'fort':
      return fortAddon(spec.level, spec.addon, simple);
    case 'city':
      return cityAddon(spec.level, spec.addon, simple);
    case 'sam':
      return samAddon(spec.level, spec.addon, simple);
    case 'port':
      return portAddon(spec.level, spec.addon, simple);
  }
}
/** The ground of a far-zoom building: one wide soft dark patch and a lighter one that fade into the terrain. */
function groundFar(g: Ground, spec: BuildingSpec): void {
  const lv = spec.level;
  switch (spec.type) {
    case 'fort': {
      const w = lv >= 5 ? 36 : lv >= 3 ? 30 : 24;
      const d = lv >= 5 ? 24 : lv >= 3 ? 20 : 15;
      g.slab('dark', -w / 2 - 10, -d / 2 - 9, w / 2 + 10, d / 2 + 12, 9, 0.38, 9, 5);
      g.slab('dirt', -w / 2 - 5, -d / 2 - 4, w / 2 + 5, d / 2 + 6, 6, 0.5, 6, 6);
      break;
    }
    case 'city': {
      const [u0, v0, u1, v1] = cityBounds(lv);
      g.slab('dark', u0 - 6, v0 - 5, u1 + 6, v1 + 6, 8, 0.36, 9, 12);
      g.slab('dirt', u0 - 2, v0 - 2, u1 + 2, v1 + 2, 6, 0.5, 6, 13);
      break;
    }
    case 'sam': {
      const rx = lv >= 3 ? 23 : 18;
      const ry = lv >= 3 ? 17 : 12;
      g.blob('dark', 1, 2, rx + 8, ry + 7, 0.36, 0.9, 18);
      g.blob('dirt', 1, 2, rx, ry, 0.5, 0.7, 19);
      break;
    }
    case 'port': {
      const top = lv >= 3 ? -24 : -15;
      const bot = lv >= 3 ? 14 : 17;
      g.slab('dark', -34, top - 5, COAST + 1, bot + 5, 8, 0.36, 9, 25);
      g.slab('dirt', -27, top, COAST, bot, 6, 0.5, 6, 26);
      break;
    }
  }
}

/** The far-zoom picture of a building: the ground fades into the terrain, shapes are simplified, colours are pulled toward the land under them, the owner outline is thin and soft. */
export function bakeBuildingFar(spec: BuildingSpec, owner: RGB, scale: number, dpr: number, under: Under, fillWater = false): BakedBuilding {
  const g = gridOf(scale, dpr);
  const res = g.res;
  const CW = Math.round(CU * res);
  const CH = Math.round(CV * res);
  const ox = Math.round(OU * res);
  const oy = Math.round(OV * res);
  const body = farModel(spec);
  const add = addonParts(spec, true);
  const gr = new Ground(CW, CH, res, ox, oy, under);
  gr.smooth = true;
  if (fillWater) {
    for (let y = 0; y < CH; y++) {
      for (let x = 0; x < CW; x++) {
        if (!under.water(x, y)) continue;
        const c = under.rgb(x, y);
        const o = (y * CW + x) * 4;
        gr.d[o] = c[0];
        gr.d[o + 1] = c[1];
        gr.d[o + 2] = c[2];
        gr.d[o + 3] = 255;
      }
    }
  }
  groundFar(gr, spec);
  gr.shadows([...body, ...add], FAR_SHADOW_A, 3, 1.25);
  const d = gr.d;
  const blend = (X: number, Y: number, c: C, a: number): void => {
    const o = (Y * CW + X) * 4;
    const da = d[o + 3] / 255;
    const oa = a + da * (1 - a);
    const w = da * (1 - a);
    d[o] = (c[0] * a + d[o] * w) / oa;
    d[o + 1] = (c[1] * a + d[o + 1] * w) / oa;
    d[o + 2] = (c[2] * a + d[o + 2] * w) / oa;
    d[o + 3] = oa * 255;
  };
  /** the solid pixels of a bake, in cell coordinates */
  const maskOf = (b: Baked): Uint8Array => {
    const m = new Uint8Array(CW * CH);
    for (let y = 0; y < b.h; y++) {
      for (let x = 0; x < b.w; x++) {
        const X = x + ox - b.ox;
        const Y = y + oy - b.oy;
        if (X >= 0 && Y >= 0 && X < CW && Y < CH && b.data[(y * b.w + x) * 4 + 3] >= 200) m[Y * CW + X] = 1;
      }
    }
    return m;
  };
  const ringPx = Math.max(1, ringWidth(g.k) - 1);
  /** draws a layer of parts: its outline (grown from `mask`, outside it) first, then the pulled colours */
  const layer = (parts: Part[], gain: number, mask?: Uint8Array): void => {
    if (!parts.length) return;
    const b = rasterize({ parts, ground: 0 }, res, 0, { facings: 32, owner });
    const own = maskOf(b);
    const sil = mask ?? own;
    // the ring: grow the silhouette ringPx steps (4 neighbours), then one more step for the faint edge
    const dist = new Uint8Array(CW * CH).fill(255);
    let front: number[] = [];
    for (let i = 0; i < sil.length; i++) {
      if (sil[i]) {
        dist[i] = 0;
        front.push(i);
      }
    }
    for (let k = 1; k <= ringPx + 1; k++) {
      const next: number[] = [];
      for (const idx of front) {
        const x = idx % CW;
        const y = (idx / CW) | 0;
        for (const j of [x > 0 ? idx - 1 : -1, x < CW - 1 ? idx + 1 : -1, y > 0 ? idx - CW : -1, y < CH - 1 ? idx + CW : -1]) {
          if (j < 0 || dist[j] !== 255) continue;
          dist[j] = k;
          next.push(j);
          const X = j % CW;
          const Y = (j / CW) | 0;
          const land = under.rgb(X, Y);
          if (k <= ringPx) blend(X, Y, owner, FAR_RING_A);
        }
      }
      front = next;
    }
    for (let y = 0; y < b.h; y++) {
      for (let x = 0; x < b.w; x++) {
        const s = (y * b.w + x) * 4;
        if (b.data[s + 3] < 200) continue;
        const X = x + ox - b.ox;
        const Y = y + oy - b.oy;
        if (X < 0 || Y < 0 || X >= CW || Y >= CH) continue;
        const land = under.rgb(X, Y);
        const c: C = [b.data[s], b.data[s + 1], b.data[s + 2]];
        const out: RGB = [cl(land[0] + (c[0] - land[0]) * gain), cl(land[1] + (c[1] - land[1]) * gain), cl(land[2] + (c[2] - land[2]) * gain)];
        blend(X, Y, out, 1);
      }
    }
  };
  if (spec.type === 'city') {
    // one soft outline round the whole town, drawn outside the blocks
    const shape: Part[] = cityLots(spec.level).map((l) => ({ k: 'box' as const, p: [l.u - l.w / 2 - 3.6, l.v - l.d / 2 - 3.6, l.u + l.w / 2 + 3.6, l.v + l.d / 2 + 3.6], z: 0, h: 0.3, m: 'tan' as const }));
    const flak = add.map((p) => ({ ...p, m: 'tan' as const, pat: undefined, tone: 0 }));
    const m = maskOf(rasterize({ parts: [...shape, ...flak], ground: 0 }, res, 0, { facings: 32, owner }));
    layer(body, FAR_GAIN, m);
  } else layer(body, FAR_GAIN);
  layer(add, FAR_ADD_GAIN);
  const cv = makeCanvas(CW, CH);
  const cx = cv.getContext('2d');
  if (cx) {
    const img = cx.createImageData(CW, CH);
    img.data.set(d);
    cx.putImageData(img, 0, 0);
  }
  return { canvas: cv, w: CW * g.k, h: CH * g.k, top: 0, cx: ox * g.k };
}

// ------------------------------------------------------------------------------------------------- the sheet

const BLUE: RGB = [64, 160, 255];
const RED: RGB = [226, 74, 60];

interface Row {
  title: string;
  spec: BuildingSpec;
}
const GROUPS: { name: string; rows: Row[] }[] = [
  {
    name: 'Fort',
    rows: [
      { title: 'Fort, level 1', spec: { type: 'fort', level: 1, addon: null } },
      { title: 'Fort, level 3', spec: { type: 'fort', level: 3, addon: null } },
      { title: 'Fort, level 5', spec: { type: 'fort', level: 5, addon: null } },
      { title: 'Fort level 3 with flak guns (add-on)', spec: { type: 'fort', level: 3, addon: 'flak' } },
      { title: 'Fort level 3 with tank traps (add-on)', spec: { type: 'fort', level: 3, addon: 'traps' } },
    ],
  },
  {
    name: 'City',
    rows: [
      { title: 'City, level 1', spec: { type: 'city', level: 1, addon: null } },
      { title: 'City, level 3', spec: { type: 'city', level: 3, addon: null } },
      { title: 'City, level 5', spec: { type: 'city', level: 5, addon: null } },
      { title: 'City level 3 with flak (add-on)', spec: { type: 'city', level: 3, addon: 'flak' } },
    ],
  },
  {
    name: 'SAM site',
    rows: [
      { title: 'SAM site, level 1', spec: { type: 'sam', level: 1, addon: null } },
      { title: 'SAM site, level 3', spec: { type: 'sam', level: 3, addon: null } },
      { title: 'SAM site level 1 with radar dish (add-on)', spec: { type: 'sam', level: 1, addon: 'radar' } },
    ],
  },
  {
    name: 'Port',
    rows: [
      { title: 'Port, level 1', spec: { type: 'port', level: 1, addon: null } },
      { title: 'Port, level 3', spec: { type: 'port', level: 3, addon: null } },
      { title: 'Port level 3 with coastal guns (add-on)', spec: { type: 'port', level: 3, addon: 'guns' } },
    ],
  },
];

const LABEL_W = 232;
const PAD = 8;
const COLS = [
  { head: 'Close zoom', sub: 'Blue nation', w: CU * SCALE_CLOSE + PAD * 2 },
  { head: 'Close zoom', sub: 'Red nation', w: CU * SCALE_CLOSE + PAD * 2 },
  { head: 'Normal zoom', sub: 'Blue nation', w: CU * SCALE_NORMAL + PAD * 2 },
  { head: 'Normal zoom', sub: 'Red nation', w: CU * SCALE_NORMAL + PAD * 2 },
  { head: "Today's icon", sub: 'Blue nation', w: 84 },
  { head: "Today's icon", sub: 'Red nation', w: 84 },
];
export const ROW_H = CV * SCALE_CLOSE + 10;
const GROUP_H = 26;
const HEAD_H = 46;
const FLAT_H = 120;
export const SHEET_W = LABEL_W + COLS.reduce((a, c) => a + c.w, 0);

/** Row tops (CSS px) of each group on the sheet, for screenshots. */
export function sheetLayout(): { name: string; y: number; h: number }[] {
  const out: { name: string; y: number; h: number }[] = [];
  let y = HEAD_H;
  for (const g of GROUPS) {
    const h = GROUP_H + g.rows.length * ROW_H;
    out.push({ name: g.name, y, h });
    y += h;
  }
  out.push({ name: 'Flat', y, h: FLAT_H });
  return out;
}
const SHEET_H = HEAD_H + GROUPS.reduce((a, g) => a + GROUP_H + g.rows.length * ROW_H, 0) + FLAT_H;

/** Today's map marker for a building (render/buildings.ts drawOne): a category plate, a white glyph, the owner band. */
function todayIcon(ctx: CanvasRenderingContext2D, type: BuildingSpec['type'], level: number, x: number, y: number, owner: RGB, dpr: number): void {
  const size = 40;
  const r = size / 2;
  const fw = 4;
  const cat = ICON_INFO[type as BuildingIconId].category;
  ctx.fillStyle = 'rgba(12,15,20,0.55)';
  ctx.beginPath();
  ctx.roundRect(x - r - 1, y - r - 1, size + 2, size + fw + 3, size * 0.26);
  ctx.fill();
  ctx.fillStyle = `rgb(${owner[0]},${owner[1]},${owner[2]})`;
  ctx.beginPath();
  ctx.roundRect(x - r + size * 0.12, y + r - 1, size * 0.76, fw + 1, 2);
  ctx.fill();
  drawMarker(ctx, type as BuildingIconId, x, y, size, { plate: cat ? CATEGORY_PLATES[cat] : owner, dpr });
  if (level > 1) {
    const br = 8;
    const bx2 = x + r * 0.78;
    const by = y - r * 0.78;
    ctx.beginPath();
    ctx.arc(bx2, by, br, 0, Math.PI * 2);
    ctx.fillStyle = '#f4f5f1';
    ctx.fill();
    ctx.lineWidth = 1.2;
    ctx.strokeStyle = 'rgba(14,18,24,0.85)';
    ctx.stroke();
    ctx.fillStyle = '#1a1f27';
    ctx.font = '600 10px "DM Sans", system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(level), bx2, by + 0.5);
  }
}

/** The shore line of the sheet's port: a wavy coast about u = COAST. */
const coastU = (v: number): number => COAST + 2.2 * Math.sin(v * 0.19 + 0.7) + 1.1 * Math.sin(v * 0.47) + (vnoise(v * 0.3, 3, 31) - 0.5) * 1.6;
/**
 * The sheet's terrain under a cell: plains, and for a port a bay of sea inside the cell (a curved, irregular shore on the
 * west, rounded far shores on the other sides, so no hard square of water), in the game's shelf and shore colours.
 */
function sheetUnder(spec: BuildingSpec, res: number, scale: number): Under {
  const plains = TERRAIN_RGB[2];
  if (spec.type !== 'port') return { water: () => false, rgb: () => plains };
  const ox = OU * res;
  const oy = OV * res;
  const U = (ax: number): number => (ax + 0.5 - ox) / res;
  const V = (ay: number): number => (ay + 0.5 - oy) / (res * FORE);
  /** 1 at the middle of the bay, 0 on its far shore */
  const bay = (u: number, v: number): number => {
    const du = (u - 14.5) / 12.2;
    const dv = (v + 6) / 23;
    return 1 - (Math.pow(Math.abs(du), 2.6) + Math.pow(Math.abs(dv), 2.6)) ** (1 / 2.6) + (vnoise(u * 0.22, v * 0.22, 41) - 0.5) * 0.3;
  };
  const inSea = (u: number, v: number): boolean => u > coastU(v) && bay(u, v) > 0;
  const tilePx = (4 / scale) * res;
  return {
    water: (ax, ay) => inSea(U(ax), V(ay)),
    rgb: (ax, ay) => {
      const u = U(ax);
      const v = V(ay);
      if (!inSea(u, v)) return plains;
      const dist = Math.min(u - coastU(v), bay(u, v) * 13);
      return waterRGB(1 + ((dist * res) / tilePx) * 1.5);
    },
  };
}

function drawSheet(ctx: CanvasRenderingContext2D, dpr: number): void {
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(backdrop('land', SHEET_W, SHEET_H, 14), 0, 0);
  const xs: number[] = [];
  let x = LABEL_W;
  for (const c of COLS) {
    xs.push(x);
    x += c.w;
  }
  ctx.fillStyle = 'rgba(10,14,20,0.82)';
  ctx.fillRect(0, 0, SHEET_W, HEAD_H);
  COLS.forEach((c, i) => {
    label(ctx, c.head, xs[i] + c.w / 2, 14, 'center');
    label(ctx, c.sub, xs[i] + c.w / 2, 33, 'center', true);
  });
  label(ctx, 'Building (rows)', 8, 23, 'left');
  let y = HEAD_H;
  for (const g of GROUPS) {
    ctx.fillStyle = 'rgba(10,14,20,0.78)';
    ctx.fillRect(0, y, SHEET_W, GROUP_H);
    ctx.font = '700 13px "DM Sans", system-ui, sans-serif';
    ctx.fillStyle = '#edeff3';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(g.name, 10, y + GROUP_H / 2);
    y += GROUP_H;
    for (const row of g.rows) {
      const cy = y + ROW_H / 2;
      label(ctx, row.title, 8, cy, 'left');
      const owners = [BLUE, RED, BLUE, RED];
      const scales = [SCALE_CLOSE, SCALE_CLOSE, SCALE_NORMAL, SCALE_NORMAL];
      for (let i = 0; i < 4; i++) {
        const s = scales[i];
        const grid = gridOf(s, dpr);
        const spr = i < 2 ? bakeBuilding(row.spec, owners[i], s, dpr, sheetUnder(row.spec, grid.res, s), true) : bakeBuildingFar(row.spec, owners[i], s, dpr, sheetUnder(row.spec, grid.res, s), true);
        const px = xs[i] + (COLS[i].w - spr.w) / 2;
        const py = cy - spr.h / 2;
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(spr.canvas, Math.round(px * dpr) / dpr, Math.round(py * dpr) / dpr, spr.w, spr.h);
        if (i < 2) levelPill(ctx, px + spr.cx, py + spr.top - 15, row.spec.level, owners[i]);
      }
      todayIcon(ctx, row.spec.type, row.spec.level, xs[4] + COLS[4].w / 2, cy - 4, BLUE, dpr);
      todayIcon(ctx, row.spec.type, row.spec.level, xs[5] + COLS[5].w / 2, cy - 4, RED, dpr);
      ctx.fillStyle = 'rgba(255,255,255,0.08)';
      ctx.fillRect(0, y + ROW_H - 1, SHEET_W, 1);
      y += ROW_H;
    }
  }
  // the far-zoom flat Fort (one flat level-3 fort: the flat icon is the same at every level and for every nation)
  ctx.fillStyle = 'rgba(10,14,20,0.78)';
  ctx.fillRect(0, y, SHEET_W, FLAT_H);
  label(ctx, 'Flat Fort (far zoom), level 3', 8, y + 24, 'left');
  label(ctx, 'Far zoom keeps this flat square for every fort', 8, y + 48, 'left', true);
  // today's far-zoom fort exactly as the map draws it: a 4 px square, dark fill, a 1 px pale outline (drawFar in
  // render/buildings.ts), drawn at real size and then shown enlarged with hard pixels so it stays true to the original
  const real = document.createElement('canvas');
  real.width = 12 * dpr;
  real.height = 12 * dpr;
  const rc = real.getContext('2d');
  if (rc) {
    rc.scale(dpr, dpr);
    rc.beginPath();
    rc.rect(4, 4, 4, 4);
    rc.lineWidth = 1;
    rc.strokeStyle = 'rgba(245,245,240,0.9)';
    rc.stroke();
    rc.fillStyle = '#2a2e36';
    rc.fill();
  }
  const drawFlat = (k: number, cx: number, cy: number): void => {
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(real, cx - 6 * k, cy - 6 * k, 12 * k, 12 * k);
  };
  drawFlat(1, xs[2] + COLS[2].w / 2, y + 56);
  label(ctx, 'Real size', xs[2] + COLS[2].w / 2, y + 90, 'center', true);
  drawFlat(8, xs[0] + COLS[0].w / 2, y + 56);
  label(ctx, 'Enlarged 8 times', xs[0] + COLS[0].w / 2, y + 108, 'center', true);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}

// ------------------------------------------------------------------------------------------------- on the real map

const MAP_ID = 'baltic';
/** map zoom (CSS px per tile) the two previews stand for */
const ZOOM_NORMAL = 4;
const ZOOM_CLOSE = 11;
const MAP_W = 880;
/** screen px per model unit at a zoom: the units' own scale (render/units.ts spriteScale) */
const unitScale = (z: number): number => (z < 11 ? 1.5 : z < 22 ? 2 : z < 32 ? 3 : 4);

interface Site {
  type: BuildingSpec['type'];
  level: number;
  addon: Addon;
  /** tile position of the building's anchor on the ground */
  x: number;
  y: number;
  blue: boolean;
}

/** A real unit drawn next to a building (a tank or a ship), placed in model units from the building's origin. */
interface Troop {
  key: SpriteKey;
  site: number;
  u: number;
  v: number;
  angle: number;
  blue: boolean;
}

interface Pill {
  site: number;
  u: number;
  v: number;
  troops: number;
  kinds: TroopIconKind[];
  blue: boolean;
}

interface Crop {
  /** the tile window the preview shows (the normal zoom window; the close one is its middle) */
  cx: number;
  cy: number;
  /** tile colours for the whole map window, nations tinted in */
  tiles: HTMLCanvasElement;
  rgb: Uint8ClampedArray;
  x0: number;
  y0: number;
  w: number;
  h: number;
  borderX: (y: number) => number;
  sites: Site[];
  troops: Troop[];
  pills: Pill[];
  water: (x: number, y: number) => boolean;
  /** which nation owns a land tile: 1 blue, 2 red, 0 none */
  owner: (x: number, y: number) => number;
}

/**
 * The Baltic map's terrain, decoded with the game's own map decoder. The lab page waits forever at the top level
 * (gate.ts), so the game's lazy map chunks never initialise in this single-file build: the data is imported directly.
 */
async function loadBalticTerrain(): Promise<MapData> {
  const bin = atob(balticBlob);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip'));
  const d = decodeWorldMapBlob(new Uint8Array(await new Response(stream).arrayBuffer()));
  return { width: d.width, height: d.height, terrain: d.terrain, resource: d.resource } as MapData;
}

/** Loads the Baltic map with the game's own loader and terrain colours and cuts a window with sea, a coast and a border. */
async function buildCrop(): Promise<Crop> {
  const map = await loadBalticTerrain();
  const theme = themeForMap(MAP_ID);
  const terr = buildTerrain(map, theme);
  const mw = map.width;
  const mh = map.height;
  const landAt = (x: number, y: number): boolean => x >= 0 && y >= 0 && x < mw && y < mh && !isWater(map.terrain[y * mw + x]);
  const WN = MAP_W / ZOOM_NORMAL;
  const HN = 84;
  // integral image of land, to find a window about half land, with an east-facing coast near its middle
  const sat = new Int32Array((mw + 1) * (mh + 1));
  for (let y = 0; y < mh; y++) {
    let row = 0;
    for (let x = 0; x < mw; x++) {
      row += landAt(x, y) ? 1 : 0;
      sat[(y + 1) * (mw + 1) + x + 1] = sat[y * (mw + 1) + x + 1] + row;
    }
  }
  const landIn = (x: number, y: number, w: number, h: number): number => sat[(y + h) * (mw + 1) + x + w] - sat[y * (mw + 1) + x + w] - sat[(y + h) * (mw + 1) + x] + sat[y * (mw + 1) + x];
  let best = { s: 1e9, x: 0, y: 0, px: 0, py: 0 };
  for (let y = 4; y + HN + 4 < mh; y += 6) {
    for (let x = 4; x + WN + 4 < mw; x += 6) {
      const f = landIn(x, y, WN, HN) / (WN * HN);
      if (f < 0.4 || f > 0.62) continue;
      const cx = x + (WN >> 1);
      const cy = y + (HN >> 1);
      // an east-facing coast near the middle: land, then 7 sea tiles to its right, deep enough for a pier
      let found = -1;
      for (let dy = -10; dy <= 10 && found < 0; dy += 2) {
        for (let dx = -14; dx <= 14; dx++) {
          const tx = cx + dx;
          const ty = cy + dy;
          if (!landAt(tx, ty) || !landAt(tx - 8, ty) || landAt(tx + 1, ty)) continue;
          let sea = true;
          for (let k = 1; k <= 7 && sea; k++) for (let j = -4; j <= 4; j++) if (landAt(tx + k, ty + j)) sea = false;
          if (sea) {
            found = tx * 4096 + ty;
            break;
          }
        }
      }
      if (found < 0) continue;
      const s = Math.abs(f - 0.5);
      if (s < best.s) best = { s, x, y, px: Math.floor(found / 4096), py: found % 4096 };
    }
  }
  const x0 = best.x;
  const y0 = best.y;
  const px = best.px;
  const py = best.py;
  // nations: a wavy border running roughly north to south west of the coast; blue to its west, red to its east
  const bx0 = px - 32;
  const borderX = (y: number): number => bx0 + (y - py) * 0.18 + 5 * Math.sin(y * 0.11);
  const owner = (x: number, y: number): number => (landAt(x, y) ? (x < borderX(y) ? 1 : 2) : 0);
  // tile colours: the game's terrain colours (render/terrain.ts buildTerrain, theme applied), nations tinted over land
  const tiles = makeCanvas(WN, HN);
  const rgb = new Uint8ClampedArray(WN * HN * 4);
  const tc = tiles.getContext('2d');
  if (tc) {
    const img = tc.createImageData(WN, HN);
    for (let y = 0; y < HN; y++) {
      for (let x = 0; x < WN; x++) {
        const mi = (y0 + y) * mw + x0 + x;
        const o = (y * WN + x) * 4;
        let r = terr.rgba[mi * 4];
        let g = terr.rgba[mi * 4 + 1];
        let b = terr.rgba[mi * 4 + 2];
        const ow = owner(x0 + x, y0 + y);
        if (ow) {
          const t = ow === 1 ? BLUE : RED;
          r += (t[0] - r) * 0.15;
          g += (t[1] - g) * 0.15;
          b += (t[2] - b) * 0.15;
        }
        img.data[o] = r;
        img.data[o + 1] = g;
        img.data[o + 2] = b;
        img.data[o + 3] = 255;
        rgb[o] = r;
        rgb[o + 1] = g;
        rgb[o + 2] = b;
        rgb[o + 3] = 255;
      }
    }
    tc.putImageData(img, 0, 0);
  }
  // building sites: a tile in from the coast, away from water, on land of the right nation
  const dry = (x: number, y: number): boolean => {
    for (let j = -3; j <= 3; j++) for (let i = -3; i <= 3; i++) if (!landAt(x + i, y + j)) return false;
    return true;
  };
  const near = (x: number, y: number, blue: boolean): [number, number] => {
    for (let r = 0; r < 30; r++) {
      for (let j = -r; j <= r; j++) {
        for (let i = -r; i <= r; i++) {
          if (Math.max(Math.abs(i), Math.abs(j)) !== r) continue;
          const tx = x + i;
          const ty = y + j;
          if (dry(tx, ty) && owner(tx, ty) === (blue ? 1 : 2) && Math.abs(tx - borderX(ty)) > 3) return [tx, ty];
        }
      }
    }
    return [x, y];
  };
  const mk = (type: BuildingSpec['type'], level: number, addon: Addon, x: number, y: number, blue: boolean): Site => {
    const [sx, sy] = near(x, y, blue);
    return { type, level, addon, x: sx, y: sy, blue };
  };
  const sites: Site[] = [
    // the port sits on the coast itself (the pier reaches into the sea), on the red side
    { type: 'port', level: 3, addon: 'guns', x: px, y: py, blue: false },
    mk('fort', 3, 'flak', px - 16, py - 27, false),
    mk('city', 3, 'flak', px - 24, py + 26, false),
    mk('sam', 1, null, px - 27, py + 9, false),
    mk('fort', 5, 'flak', px - 52, py - 27, true),
    mk('city', 1, null, px - 50, py + 26, true),
    mk('sam', 3, 'radar', px - 46, py + 1, true),
    mk('city', 5, null, px - 84, py + 6, true),
  ];
  const troops: Troop[] = [];
  const pills: Pill[] = [];
  const addTank = (site: number, key: SpriteKey, u: number, v: number, angle: number): void => {
    troops.push({ key, site, u, v, angle, blue: sites[site].blue });
  };
  // beside the red level 3 fort and the blue level 5 fort: columns of tanks and an army count pill; a tank by each
  // other building; a destroyer and a trade ship at sea off the port
  addTank(1, 'tankDivision', -14, 27, 0);
  addTank(1, 'tankDivision', 1, 27, 0);
  addTank(1, 'heavyTank', 17, 27, 0);
  pills.push({ site: 1, u: 2, v: 38, troops: 12400, kinds: ['armor', 'artillery'], blue: false });
  addTank(4, 'tankDivision', -8, 29, 0.3);
  addTank(4, 'lightTank', 9, 30, 0.3);
  pills.push({ site: 4, u: 0, v: 40, troops: 50000, kinds: [], blue: true });
  addTank(2, 'lightTank', 38, 8, 0.4);
  addTank(3, 'heavyTank', 30, 14, 0);
  addTank(5, 'tankDivision', 28, 6, 0.2);
  addTank(6, 'lightTank', -36, 10, 3.2);
  troops.push({ key: 'destroyer', site: 0, u: 34, v: -34, angle: 0.05, blue: false }, { key: 'tradeShip', site: 0, u: 36, v: 34, angle: -0.1, blue: false });
  return {
    cx: px - 8,
    cy: py,
    tiles,
    rgb,
    x0,
    y0,
    w: WN,
    h: HN,
    borderX,
    sites,
    troops,
    pills,
    water: (x, y) => !landAt(x, y),
    owner,
  };
}

/** Draws a preview of the crop at a zoom (CSS px per tile) with buildings and units at the units' own scale for that zoom. */
function drawMapPreview(cv: HTMLCanvasElement, crop: Crop, zoom: number, dpr: number, shiftX: number, far = false): void {
  const cw = MAP_W;
  const ch = cv.height / dpr;
  const ctx = cv.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  // the view is centred on (cx + shiftX, cy) in map tiles
  const vx0 = crop.cx + shiftX - cw / 2 / zoom;
  const vy0 = crop.cy - ch / 2 / zoom;
  const toX = (tx: number): number => (tx - vx0) * zoom;
  const toY = (ty: number): number => (ty - vy0) * zoom;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(crop.tiles, vx0 - crop.x0, vy0 - crop.y0, cw / zoom, ch / zoom, 0, 0, cw, ch);
  // the border between the two nations: a dark line with a pale one on top, where the owner changes
  ctx.lineCap = 'round';
  const pts: [number, number][] = [];
  for (let ty = Math.floor(vy0); ty <= Math.ceil(vy0 + ch / zoom); ty++) {
    const bx2 = crop.borderX(ty);
    if (crop.owner(Math.floor(bx2) - 1, ty) && crop.owner(Math.floor(bx2) + 2, ty)) pts.push([toX(bx2), toY(ty + 0.5)]);
    else if (pts.length) pts.push([-9999, -9999]);
  }
  for (const [lw, col] of [[Math.max(2, zoom * 0.32), 'rgba(12,16,22,0.65)'], [Math.max(1, zoom * 0.14), 'rgba(236,238,232,0.85)']] as [number, string][]) {
    ctx.strokeStyle = col;
    ctx.lineWidth = lw;
    ctx.beginPath();
    let pen = false;
    for (const [x, y] of pts) {
      if (x < -9000) {
        pen = false;
        continue;
      }
      if (!pen) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
      pen = true;
    }
    ctx.stroke();
  }
  const scale = unitScale(zoom);
  const grid = gridOf(scale, dpr);
  const tileAt = (tx: number, ty: number): number => {
    const ix = Math.max(0, Math.min(crop.w - 1, Math.floor(tx - crop.x0)));
    const iy = Math.max(0, Math.min(crop.h - 1, Math.floor(ty - crop.y0)));
    return (iy * crop.w + ix) * 4;
  };
  const sorted = crop.sites.slice().sort((a, b) => a.y - b.y);
  const levels: [number, number, number, RGB][] = [];
  const anchors = new Map<Site, [number, number]>();
  for (const s of sorted) {
    const owner = s.blue ? BLUE : RED;
    // the model origin stands on the site's tile centre (a port's coast line on the coast between its two tiles)
    const ax = s.type === 'port' ? toX(s.x + 1) - COAST * scale : toX(s.x + 0.5);
    const ay = toY(s.y + 0.5);
    anchors.set(s, [ax, ay]);
    const cellX = ax - OU * scale;
    const cellY = ay - OV * scale;
    if (cellX < -CU * scale || cellY < -CV * scale || cellX > cw || cellY > ch) continue;
    // a cell pixel's tile: the cell pixel's distance from the model origin, in screen px, over the zoom
    const tileOf = (px: number, py: number): [number, number] => [
      (s.type === 'port' ? s.x + 1 : s.x + 0.5) + ((px - OU * grid.res) / grid.res - (s.type === 'port' ? COAST : 0)) * (scale / zoom),
      s.y + 0.5 + ((py - OV * grid.res) / grid.res) * (scale / zoom),
    ];
    const under: Under = {
      rgb: (px, py): RGB => {
        const [tx, ty] = tileOf(px, py);
        const o = tileAt(tx, ty);
        return [crop.rgb[o], crop.rgb[o + 1], crop.rgb[o + 2]];
      },
      water: (px, py): boolean => {
        const [tx, ty] = tileOf(px, py);
        return crop.water(Math.floor(tx), Math.floor(ty));
      },
    };
    const bs: BuildingSpec = { type: s.type, level: s.level, addon: s.addon };
    const spr = far ? bakeBuildingFar(bs, owner, scale, dpr, under) : bakeBuilding(bs, owner, scale, dpr, under);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(spr.canvas, Math.round(cellX * dpr) / dpr, Math.round(cellY * dpr) / dpr, spr.w, spr.h);
    if (scale >= 2) levels.push([cellX + spr.cx, cellY + spr.top - 15, s.level, owner]);
  }
  // the game's own unit art beside the buildings, at the same zoom, with the map outline the units wear
  const motion = motionParams('subtle', true);
  const at = (site: number, u: number, v: number): [number, number] => {
    const a = anchors.get(crop.sites[site]) ?? [toX(crop.sites[site].x + 0.5), toY(crop.sites[site].y + 0.5)];
    return [a[0] + u * scale, a[1] + v * scale * FORE];
  };
  const placed = crop.troops.map((t) => ({ t, p: at(t.site, t.u, t.v) })).sort((a, b) => a.p[1] - b.p[1]);
  for (const { t, p } of placed) {
    const u: UnitDraw = { key: t.key, mods: 0, owner: t.blue ? BLUE : RED, x: p[0], y: p[1], angle: t.angle, zoom, scale, lod: 'near', dpr, timeMs: 0, turnRate: 0, speed: 0, moving: false, seed: 1, alpha: 1, shadow: false, outline: true, damage: 0 };
    detailedUnits.drawUnit(ctx, u, motion);
  }
  ctx.imageSmoothingEnabled = false;
  for (const q of crop.pills) {
    const p = at(q.site, q.u, q.v);
    troopPill(ctx, p[0], p[1], q.troops, q.kinds, q.blue ? BLUE : RED, { edge: '#ffe98a', arrow: 'up', small: true });
  }
  for (const [x, y, lv, o] of levels) levelPill(ctx, x, y, lv, o);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}

/** Mounts the Buildings mockup section in the lab page and draws it. */
export function mountBuildingsMock(root: HTMLElement): HTMLElement {
  const sec = document.createElement('section');
  sec.className = 'al-row al-bm';
  sec.id = 'al-buildings';
  sec.setAttribute('aria-labelledby', 'al-row-buildings');
  sec.style.display = 'block';
  const head = document.createElement('div');
  head.className = 'al-row-head';
  const t = document.createElement('h2');
  t.id = 'al-row-buildings';
  t.textContent = 'Buildings mockup';
  const note = document.createElement('p');
  note.textContent = 'Map buildings drawn like the troops: the same shaded pixels, four tones per material, lit from the top left, a dark edge and an outline in the nation\'s colour. They stand on the land with a shadow, dirt and paths made from the land\'s own colour, and at close zoom the level is a small dark chip like the army count (at normal zoom the size and look of the building show it). Each building is shown for a blue and a red nation, at close and normal zoom, next to today\'s icon.';
  const note2 = document.createElement('p');
  note2.textContent = 'Flak, tank traps, the radar dish and coastal guns are not in the game yet: they are drawn as add-ons only. The build menu, the pin menu and the tabs keep today\'s icons, and far zoom keeps the flat icons. This is a mockup: the real map still draws today\'s icons.';
  head.append(t, note, note2);
  const cv = document.createElement('canvas');
  cv.setAttribute('role', 'img');
  cv.setAttribute('aria-label', 'Buildings mockup: fort, city, SAM site and port at every level, two nations, two zooms, next to today\'s icons');
  cv.style.cssText = `display:block;margin-top:12px;border-radius:8px;max-width:100%;width:${SHEET_W}px`;
  const dpr = Math.min(3, Math.max(1, Math.round(window.devicePixelRatio || 1)));
  cv.width = SHEET_W * dpr;
  cv.height = SHEET_H * dpr;
  sec.append(head, cv);
  const mh = document.createElement('div');
  mh.className = 'al-row-head';
  const mt = document.createElement('h3');
  mt.textContent = 'On the real map';
  const mn = document.createElement('p');
  mn.textContent = `Normal zoom shows the far look: simplified shapes with no inner clutter, a thinner softer owner outline, colours pulled toward the land, a wide soft shadow and a ground patch that fades into the terrain. Close zoom keeps the full detail. The same buildings over a crop of the game's ${MAP_ID} map (its own loader and terrain colours), with the border of two nations, at the same size as the game's units for each zoom (zoom ${ZOOM_NORMAL} and zoom ${ZOOM_CLOSE}). Next to them are the game's real tanks, ships and army count pills, so the two can be compared side by side.`;
  mh.append(mt, mn);
  sec.append(mh);
  const previews: [string, number, number, number, boolean][] = [
    [`Normal zoom (zoom ${ZOOM_NORMAL})`, ZOOM_NORMAL, 300, 0, true],
    [`Close zoom (zoom ${ZOOM_CLOSE})`, ZOOM_CLOSE, 720, -16, false],
  ];
  const mcs: { cv: HTMLCanvasElement; zoom: number; shift: number; far: boolean }[] = [];
  for (const [name, zoom, hh, shift, far] of previews) {
    const sub = document.createElement('p');
    sub.textContent = name;
    sub.style.cssText = 'margin:12px 0 4px;font-weight:600';
    const mc = document.createElement('canvas');
    mc.setAttribute('role', 'img');
    mc.setAttribute('aria-label', `Buildings on a real map crop, ${name}`);
    mc.style.cssText = `display:block;border-radius:8px;max-width:100%;width:${MAP_W}px`;
    mc.width = MAP_W * dpr;
    mc.height = hh * dpr;
    mc.getContext('2d')?.fillRect(0, 0, 1, 1);
    sec.append(sub, mc);
    mcs.push({ cv: mc, zoom, shift, far });
  }
  root.append(sec);
  void buildCrop().then(
    (crop) => {
      const go = (): void => {
        for (const m of mcs) drawMapPreview(m.cv, crop, m.zoom, dpr, m.shift, m.far);
      };
      go();
      void document.fonts?.ready.then(go);
    },
    (e: unknown) => {
      for (const m of mcs) {
        const c2 = m.cv.getContext('2d');
        if (c2) {
          c2.fillStyle = '#222';
          c2.fillRect(0, 0, m.cv.width, m.cv.height);
          c2.fillStyle = '#ddd';
          c2.font = '16px sans-serif';
          c2.fillText(`The map could not be loaded: ${String(e)}`, 16, 32);
        }
      }
    },
  );
  const ctx = cv.getContext('2d');
  const go = (): void => {
    if (ctx) drawSheet(ctx, dpr);
  };
  go();
  // the fonts may arrive after the first draw: draw again once they have
  void document.fonts?.ready.then(go);
  return sec;
}
