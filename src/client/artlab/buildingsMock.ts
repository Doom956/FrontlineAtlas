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
import { FORE, rasterize, type Part } from '../art/detailed/bake';
import { gridOf } from '../art/detailed/grid';
import { outlineOf, ringWidth } from '../art/detailed/outline';
import { box, ell, poly, seg } from '../art/detailed/shapes';
import { detailedUnits } from '../art/detailed/units';
import type { SpriteKey } from '../art/shared/keys';
import type { UnitDraw } from '../art/types';
import { backdrop } from './backdrop';
import { label } from './scenes';

/** The cell a building is baked into, in model units (1 unit = 1 map screen px at mid zoom, like the units). */
const CU = 46;
const CV = 50;
/** where the model origin (u 0, v 0, on the ground) sits in the cell, in model units */
const OU = 23;
const OV = 32;
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

/** A pitched roof over a footprint: a lit slope, a darker slope, a bright ridge cap. */
function roof(u0: number, v0: number, u1: number, v1: number, z: number, m: Mat, rh = 1.3, over = 0.5): Part[] {
  const a = u0 - over;
  const b = v0 - over;
  const c = u1 + over;
  const d = v1 + over;
  if (c - a >= d - b) {
    const vm = (b + d) / 2;
    return [bx(a, b, c, vm, z, rh, m, { tone: 0.8 }), bx(a, vm, c, d, z, rh * 0.55, m, { tone: -0.9 }), bx(a, vm - 0.25, c, vm + 0.25, z + rh, 0.2, m, { tone: 1.7 })];
  }
  const um = (a + c) / 2;
  return [bx(a, b, um, d, z, rh, m, { tone: 0.8 }), bx(um, b, c, d, z, rh * 0.55, m, { tone: -0.9 }), bx(um - 0.25, b, um + 0.25, d, z + rh, 0.2, m, { tone: 1.7 })];
}
/** A house: walls and a pitched roof. */
function house(u0: number, v0: number, u1: number, v1: number, z: number, roofM: Mat, wall: Mat = 'cream'): Part[] {
  return [bx(u0, v0, u1, v1, 0, z, wall, { tone: -0.4 }), ...roof(u0, v0, u1, v1, z, roofM)];
}
/** A flag: a pole standing up and a small flag in the owner's colour. */
function flag(u: number, v: number, z: number, h: number, w = 3.2): Part[] {
  return [el(u, v, 0.3, 0.3, z, h, 'gun', { sh: 'cyl', tone: 1 }), bx(u + 0.3, v - 0.5, u + 0.3 + w, v + 1.0, z + h - 1.5, 1.4, 'own')];
}
/** A thin band of the owner's colour lying on a roof or wall top. */
const band = (u0: number, v0: number, u1: number, v1: number, z: number): Part => bx(u0, v0, u1, v1, z, 0.35, 'own');
/** A round tower with a conical cap. */
function tower(u: number, v: number, r: number, z: number): Part[] {
  return [el(u, v, r, r * 0.9, 0, z, 'sup', { sh: 'cyl', tone: -0.2 }), el(u, v, r * 0.78, r * 0.7, z, 1.4, 'fieldgrey', { sh: 'dome', tone: 0.4 })];
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
function flakGun(u: number, v: number): Part[] {
  return [
    el(u, v, 2.6, 2.2, 0, 1.0, 'canvas', { edge: true, tone: 0.2 }),
    el(u, v, 1.6, 1.4, 0, 1.0, 'gun', { sh: 'dome' }),
    seg(u, v - 0.5, u + 3.8, v - 2.6, 0.8, 1.6, 0.8, 'gun', { sh: 'cyl', tone: 1 }),
    seg(u, v + 0.5, u + 3.8, v - 1.5, 0.8, 1.6, 0.8, 'gun', { sh: 'cyl', tone: 1 }),
    bx(u - 0.9, v + 0.3, u + 0.9, v + 1.3, 1.0, 1.0, 'gun', { tone: 1 }),
  ];
}
function coastalGun(u: number, v: number): Part[] {
  return [
    el(u, v, 3.0, 2.6, 0, 2.2, 'fieldgrey', { sh: 'dome', tone: 0.3 }),
    seg(u, v, u + 7, v - 1.6, 1.4, 1.6, 0.9, 'gun', { sh: 'cyl', tone: 1 }),
    el(u + 7.2, v - 1.6, 0.8, 0.8, 1.5, 1.0, 'gun', { tone: 1.2 }),
    el(u - 0.4, v + 0.2, 1.0, 1.0, 2.2, 0.35, 'own'),
  ];
}
function radarDish(u: number, v: number): Part[] {
  return [
    bx(u - 2.4, v + 0.4, u + 2.4, v + 3.2, 0, 1.4, 'canvas', { tone: -0.2 }),
    el(u, v, 1.0, 1.0, 1.4, 4.0, 'gun', { sh: 'cyl', tone: 0.8 }),
    el(u, v - 1.0, 4.4, 3.4, 5.4, 0.8, 'alu', { sh: 'dome' }),
    seg(u, v - 1.0, u + 2.8, v - 3.4, 0.6, 6.3, 0.8, 'gun'),
    el(u + 3.0, v - 3.6, 0.6, 0.6, 6.3, 0.9, 'own'),
  ];
}

// ---- fort

function fortModel(lv: number, addon: Addon): Part[] {
  const cfg = lv >= 5 ? { w: 36, d: 24, t: 3.2, wz: 8, tz: 12, r: 4.0 } : lv >= 3 ? { w: 30, d: 20, t: 2.8, wz: 6, tz: 9, r: 3.3 } : { w: 24, d: 15, t: 2.2, wz: 4.2, tz: 6.5, r: 2.6 };
  const { w, d, t, wz, tz, r } = cfg;
  const x0 = -w / 2;
  const x1 = w / 2;
  const y0 = -d / 2;
  const y1 = d / 2;
  const gate = lv >= 5 ? 4.6 : 3.6;
  const P: Part[] = [];
  // the courtyard floor: trampled earth
  P.push(bx(x0 + t, y0 + t, x1 - t, y1 - t, 0, 0, 'tan', { inset: true, tone: -1.2 }));
  // the wall ring (the south wall has the gate gap)
  P.push(bx(x0, y0, x1, y0 + t, 0, wz, 'sup', { tone: -0.3 }));
  P.push(bx(x0, y0, x0 + t, y1, 0, wz, 'sup', { tone: -0.3 }));
  P.push(bx(x1 - t, y0, x1, y1, 0, wz, 'sup', { tone: -0.3 }));
  P.push(bx(x0, y1 - t, -gate, y1, 0, wz, 'sup', { tone: -0.3 }));
  P.push(bx(gate, y1 - t, x1, y1, 0, wz, 'sup', { tone: -0.3 }));
  P.push(...merlonsH(x0 + 1, x1 - 1, y0 + 0.2, wz), ...merlonsH(x0 + 1, -gate - 0.5, y1 - 1.1, wz), ...merlonsH(gate + 0.5, x1 - 1, y1 - 1.1, wz));
  P.push(...merlonsV(y0 + 2, y1 - 2, x0 + 0.2, wz), ...merlonsV(y0 + 2, y1 - 2, x1 - 1.1, wz));
  // the gate house: a lintel over a dark arch, a band of the owner's colour on its roof
  P.push(bx(-gate - 0.6, y1 - t - 0.6, gate + 0.6, y1 + 0.4, 0, wz + 1.6, 'sup', { tone: 0.1 }));
  P.push(bx(-gate * 0.6, y1 + 0.4, gate * 0.6, y1 + 0.7, 0, (wz + 1.6) * 0.62, 'black', { tone: 0.5 }));
  P.push(band(-gate - 0.2, y1 - 1.4, gate + 0.2, y1 - 0.4, wz + 1.6));
  // what stands inside
  if (lv <= 1) {
    P.push(...house(-4, -1, 3, 3.4, 3.2, 'rust'), ...house(-9, -2.6, -5.4, 0.6, 2.6, 'brick'));
  } else if (lv <= 3) {
    P.push(bx(-5, -3, 5, 3.6, 0, 8, 'cream', { tone: -0.3 }), ...roof(-5, -3, 5, 3.6, 8, 'fieldgrey', 1.6, 0.6), band(-5.4, 3.6, 5.4, 4.2, 8));
    P.push(...house(-12, -1, -7, 3, 3.6, 'brick'), ...house(7.4, -1, 12, 3, 3.6, 'brick'));
    P.push(...flag(0, -1.6, 9.6, 8, 4));
  } else {
    // an inner wall, a tall keep with a dome and a banner band, barracks
    P.push(bx(-12, -6, 12, 7, 0, 3.4, 'sup', { tone: -0.5 }), bx(-10.8, -4.8, 10.8, 5.8, 0, 0, 'tan', { inset: true, tone: -1.4 }));
    P.push(bx(-6.5, -4.6, 6.5, 3.4, 0, 12, 'cream', { tone: -0.3 }), ...roof(-6.5, -4.6, 6.5, 3.4, 12, 'fieldgrey', 1.8, 0.6));
    P.push(el(0, -0.6, 3.0, 2.6, 13.4, 2.6, 'brass', { sh: 'dome' }), band(-6.9, 3.4, 6.9, 4.2, 12));
    P.push(...flag(0.4, -0.6, 16, 9, 5));
    P.push(...house(-16, -2, -12.6, 2, 4.2, 'brick'), ...house(12.6, -2, 16, 2, 4.2, 'brick'));
  }
  // the corner towers and (level 5) the back one
  P.push(...tower(x0, y0, r, tz), ...tower(x1, y0, r, tz));
  if (lv >= 5) P.push(...tower(0, y0 + 0.2, r * 0.9, tz - 1));
  P.push(...tower(x0, y1, r, tz), ...tower(x1, y1, r, tz));
  P.push(...flag(x1 - 0.2, y0 - 0.4, tz + 1.4, lv >= 3 ? 7 : 5.5, 4.4));
  for (const cx of [x0, x1]) P.push(band(cx - r * 0.6, y1 + r * 0.55, cx + r * 0.6, y1 + r * 0.55 + 0.9, 0.5));
  if (lv >= 5) P.push(bx(-2.3, y1, 2.3, y1 + 4.4, 0, 0.6, 'teak', { pat: 'planks' }));
  if (addon === 'flak') P.push(...flakGun(x0 - 5, y1 + 5), ...flakGun(x1 + 5, y1 + 5));
  if (addon === 'traps') {
    for (let h = x0 - 5; h <= x1 + 5; h += 6) if (Math.abs(h) > 5) P.push(...hedgehog(h, y1 + 8 + (hash(Math.round(h), 4) - 0.5) * 1.6));
    for (let h = y0 + 3; h < y1 + 5; h += 7) P.push(...hedgehog(x0 - 6, h), ...hedgehog(x1 + 6, h));
  }
  return P;
}

// ---- city

interface Lot {
  u: number;
  v: number;
  w: number;
  d: number;
  z: number;
  k: 'house' | 'tower' | 'hall';
  roof: Mat;
}
function cityLots(lv: number): Lot[] {
  return plots(lv).map((l) => ({ ...l, w: l.w - 1.8, d: l.d - 1.4 }));
}
function plots(lv: number): Lot[] {
  if (lv >= 5) {
    return [
      { u: -17, v: -9, w: 8, d: 7, z: 20, k: 'tower', roof: 'fieldgrey' },
      { u: -6, v: -10, w: 8, d: 6, z: 7, k: 'house', roof: 'brick' },
      { u: 5, v: -9, w: 8, d: 7, z: 8, k: 'house', roof: 'fieldgrey' },
      { u: 16, v: -10, w: 8, d: 6, z: 6, k: 'house', roof: 'rust' },
      { u: -17, v: 2, w: 8, d: 7, z: 9, k: 'house', roof: 'ochre' },
      { u: -6, v: 2.4, w: 9, d: 8, z: 15, k: 'tower', roof: 'cream' },
      { u: 6, v: 2, w: 8, d: 7, z: 6, k: 'house', roof: 'fadedBlue' },
      { u: 17, v: 2.4, w: 8, d: 8, z: 11, k: 'house', roof: 'brick' },
      { u: -16.5, v: 13, w: 8, d: 7, z: 6, k: 'house', roof: 'rust' },
      { u: -6, v: 13, w: 7, d: 6, z: 5, k: 'house', roof: 'brick' },
      { u: 5, v: 13.4, w: 10, d: 8, z: 13, k: 'tower', roof: 'fieldgrey' },
      { u: 17, v: 13, w: 8, d: 7, z: 6, k: 'house', roof: 'ochre' },
    ];
  }
  if (lv >= 3) {
    return [
      { u: -14, v: -7, w: 8, d: 7, z: 12, k: 'tower', roof: 'fieldgrey' },
      { u: -3.4, v: -8, w: 8, d: 6, z: 6, k: 'house', roof: 'brick' },
      { u: 7, v: -7, w: 8, d: 7, z: 6, k: 'house', roof: 'rust' },
      { u: 17, v: -8, w: 6, d: 6, z: 5, k: 'house', roof: 'ochre' },
      { u: -15, v: 5, w: 8, d: 7, z: 5, k: 'house', roof: 'fadedBlue' },
      { u: -3, v: 5.4, w: 11, d: 8, z: 7, k: 'hall', roof: 'tan' },
      { u: 10, v: 5, w: 8, d: 7, z: 9, k: 'house', roof: 'brick' },
      { u: 19, v: 5, w: 5, d: 6, z: 5, k: 'house', roof: 'rust' },
    ];
  }
  return [
    { u: -11, v: -5, w: 8, d: 6, z: 3.4, k: 'house', roof: 'brick' },
    { u: 0, v: -6, w: 8, d: 6, z: 3.4, k: 'house', roof: 'fieldgrey' },
    { u: 11, v: -5, w: 7, d: 6, z: 3.4, k: 'house', roof: 'rust' },
    { u: -11.5, v: 6, w: 7, d: 6, z: 3, k: 'house', roof: 'ochre' },
    { u: -1, v: 6.6, w: 11, d: 8, z: 5.5, k: 'hall', roof: 'tan' },
    { u: 12, v: 6, w: 7, d: 6, z: 3.4, k: 'house', roof: 'fadedBlue' },
  ];
}
function cityModel(lv: number, addon: Addon): Part[] {
  const P: Part[] = [];
  const lots = cityLots(lv).sort((a, b) => a.v - b.v || a.u - b.u);
  for (const l of lots) {
    const u0 = l.u - l.w / 2;
    const u1 = l.u + l.w / 2;
    const v0 = l.v - l.d / 2;
    const v1 = l.v + l.d / 2;
    if (l.k === 'tower') {
      P.push(bx(u0, v0, u1, v1, 0, l.z, 'sup', { tone: -0.2 }), bx(u0 + 0.5, v0 + 0.5, u1 - 0.5, v1 - 0.5, l.z, 0, l.roof, { inset: true, tone: -0.6 }));
      P.push(bx(u0 + 1.2, v0 + 1.2, u0 + 3.8, v0 + 3, l.z, 1.2, 'gun', { tone: 0.6 }), bx(u1 - 3.6, v1 - 3.4, u1 - 1.4, v1 - 1.6, l.z, 1.0, 'gun', { tone: 0.2 }));
      if (l.z >= 12) {
        P.push(band(u0, v1 - 1.5, u1, v1 - 0.3, l.z));
        P.push(el(u1 - 2, v0 + 2, 0.3, 0.3, l.z, 5, 'gun', { sh: 'cyl' }), el(u1 - 2, v0 + 2, 0.45, 0.45, l.z + 5, 0.4, 'brass'));
      }
    } else if (l.k === 'hall') {
      P.push(bx(u0, v0, u1, v1, 0, l.z, 'cream', { tone: 0.1 }), ...roof(u0, v0, u1, v1, l.z, l.roof, 1.8, 0.6), band(u0 - 0.2, v1 + 0.2, u1 + 0.2, v1 + 1.0, l.z), ...flag(u1 - 1, v0 + 0.4, l.z + 1.8, 6, 4));
    } else {
      P.push(...house(u0, v0, u1, v1, l.z, l.roof));
      if (l.z >= 9) P.push(band(u0, v1 - 0.2, u1, v1 + 0.6, l.z));
    }
  }
  // a few trees in the gaps
  const trees: [number, number][] = lv >= 5 ? [[-0.4, -1.6], [0.8, -2.2]] : lv >= 3 ? [[7.5, -0.4], [12.5, -0.4]] : [[8.2, 1.6]];
  for (const [u, v] of trees) P.push(el(u, v, 1.9, 1.7, 0.6, 2.4, 'olive', { sh: 'dome', tone: 0.3 }));
  if (addon === 'flak') {
    const ext = lv >= 5 ? 24 : lv >= 3 ? 22 : 16;
    P.push(...flakGun(ext, 12), ...flakGun(-ext, 12));
  }
  return P;
}

// ---- SAM site

/** A truck launcher: chassis, cab, wheels, a cradle and three missiles with the owner's colour on the nose. */
function launcher(u: number, v: number): Part[] {
  const P: Part[] = [];
  for (const wu of [-4.2, -1.2, 2.2]) P.push(el(u + wu, v + 2.7, 1.1, 0.6, 0, 1.5, 'track', { sh: 'cyl' }), el(u + wu, v - 2.7, 1.1, 0.6, 0, 1.2, 'track', { sh: 'cyl' }));
  P.push(bx(u - 6, v - 2.5, u + 3.2, v + 2.5, 0.8, 1.8, 'olive'));
  P.push(bx(u + 3.4, v - 2.3, u + 6.4, v + 2.3, 0.8, 2.6, 'olive', { tone: 0.4 }), bx(u + 5.8, v - 1.8, u + 6.4, v + 1.8, 2.9, 0, 'glass'));
  P.push(bx(u - 5.6, v + 1.7, u + 2.8, v + 2.3, 2.6, 0, 'own'));
  P.push(bx(u - 5.4, v - 1.6, u + 2.6, v + 1.6, 2.6, 0.7, 'gun', { tone: 0.4 }));
  for (let i = -1; i <= 1; i++) {
    const vv = v + i * 1.15;
    P.push(seg(u - 5, vv + 0.5, u + 4.6, vv - 0.9, 1.0, 3.2, 0.9, 'white', { sh: 'cyl' }), el(u + 4.9, vv - 0.95, 0.75, 0.6, 3.2, 0.9, 'own', { sh: 'dome' }));
  }
  return P;
}
/** A low sandbag wall round three sides of a bay (open to the east). */
function revetment(u0: number, v0: number, u1: number, v1: number): Part[] {
  const o = { tone: -0.2 };
  return [bx(u0, v0, u1, v0 + 1.2, 0, 1.3, 'canvas', o), bx(u0, v1 - 1.2, u1, v1, 0, 1.3, 'canvas', o), bx(u0, v0, u0 + 1.2, v1, 0, 1.3, 'canvas', o)];
}
function samModel(lv: number, addon: Addon): Part[] {
  const P: Part[] = [];
  if (lv >= 3) {
    P.push(...revetment(-18, -2, -4, 7), ...revetment(-4, 6, 10, 15));
    P.push(...launcher(-9, 2.4), ...launcher(2, 11), ...launcher(14, 2.4));
    P.push(...revetment(8, -2, 22, 7));
    P.push(...house(-17, -11, -9, -6, 4, 'fieldgrey'), band(-17.4, -6.2, -8.6, -5.5, 4));
    P.push(bx(15, -11, 20, -7.4, 0, 3.6, 'gun', { tone: 0.4 }), el(17.5, -9.2, 1.4, 1.2, 3.6, 0.8, 'alu', { sh: 'dome' }));
    P.push(el(21, -9, 0.3, 0.3, 0, 9, 'gun', { sh: 'cyl' }), el(21, -9, 0.5, 0.5, 9, 0.4, 'brass'));
  } else {
    P.push(...revetment(-12, 0, 4, 9));
    P.push(...launcher(-3.4, 4.6));
    P.push(...house(5, -6, 13, -1, 3.6, 'fieldgrey'), band(4.6, -1.2, 13.4, -0.5, 3.6));
    P.push(el(14, -3, 0.3, 0.3, 0, 7, 'gun', { sh: 'cyl' }), el(14, -3, 0.5, 0.5, 7, 0.4, 'brass'));
  }
  if (addon === 'radar') P.push(...radarDish(lv >= 3 ? -2 : -3, lv >= 3 ? -7 : -4));
  return P;
}

// ---- port: the coast is at u = COAST, land to the west, the sea and the piers to the east

const COAST = 1.5;
function pier(u0: number, v0: number, u1: number, v1: number): Part[] {
  const P: Part[] = [bx(u0, v0, u1, v1, 0, 0.7, 'teak', { pat: 'planks' })];
  for (let u = u0 + 2; u < u1 - 1; u += 4.6) P.push(el(u, v1 - 0.3, 0.45, 0.4, 0.7, 0.5, 'gun', { tone: 0.6 }));
  return P;
}
function crane(u: number, v: number, len: number): Part[] {
  return [
    bx(u - 1.6, v - 1.6, u + 1.6, v + 1.6, 0, 7, 'ochre', { tone: -0.4 }),
    bx(u - 3.6, v - 1.0, u + len, v + 0.2, 7, 0.9, 'ochre', { tone: 0.4, pat: 'grille' }),
    bx(u - 3.6, v - 1.4, u - 1.4, v + 0.6, 7.2, 1.0, 'gun', { tone: 0.6 }),
    bx(u + len - 1.2, v - 1.1, u + len, v + 0.3, 6.6, 0.8, 'gun', { tone: 0.6 }),
    bx(u - 1.0, v + 1.6, u + 1.0, v + 2.4, 0, 0, 'own'),
    bx(u - 1.2, v + 0.2, u + 1.2, v + 1.4, 7.9, 0, 'own'),
  ];
}
const BOX_COLS: Mat[] = ['rust', 'fadedBlue', 'ochre', 'olive', 'brick', 'fieldgrey'];
function containers(u: number, v: number, nu: number, nv: number, seed: number, ownerFirst: boolean): Part[] {
  const P: Part[] = [];
  for (let j = 0; j < nv; j++) {
    for (let i = 0; i < nu; i++) {
      const m = BOX_COLS[Math.floor(hash(i + seed, j * 5 + seed) * BOX_COLS.length)];
      const tall = hash(i, j + seed) > 0.62;
      const u0 = u + i * 4.4;
      const v0 = v + j * 2.7;
      P.push(bx(u0, v0, u0 + 4.1, v0 + 2.4, 0, tall ? 4.6 : 2.3, m, { pat: 'ribs', tone: hash(i + 3, j + seed) * 0.8 - 0.4 }));
    }
  }
  if (ownerFirst) P.push(bx(u, v + nv * 2.7 - 0.9, u + 4.1, v + nv * 2.7 - 0.2, 2.5, 0, 'own'));
  return P;
}
function ship(u: number, v: number, len: number, wid: number): Part[] {
  const hw = wid / 2;
  const P: Part[] = [];
  P.push(poly([u, v - hw, u + len - 4, v - hw, u + len, v, u + len - 4, v + hw, u, v + hw], 0, 2.2, 'merchant', { tone: 0.6 }));
  P.push(poly([u + 0.4, v - hw + 0.5, u + len - 4.4, v - hw + 0.5, u + len - 1.2, v, u + len - 4.4, v + hw - 0.5, u + 0.4, v + hw - 0.5], 2.2, 0, 'deck'));
  P.push(bx(u, v + hw - 0.7, u + len - 4, v + hw, 0.2, 1.4, 'redlead', { tone: 0.2 }));
  const cols: Mat[] = ['rust', 'fadedBlue', 'ochre', 'olive'];
  for (let i = 0; i < 3; i++) P.push(bx(u + 7.4 + i * 2.9, v - hw + 0.7, u + 10 + i * 2.9, v + hw - 0.7, 2.2, 1.8, cols[i % 4], { pat: 'ribs', tone: i * 0.3 - 0.4 }));
  P.push(bx(u + 1.2, v - hw + 0.7, u + 5.4, v + hw - 0.7, 2.2, 3.6, 'white'), bx(u + 1.0, v - hw + 0.5, u + 5.6, v + hw - 0.5, 5.8, 0.5, 'sup', { tone: 0.6 }), band(u + 1.6, v + hw - 1.5, u + 5.0, v + hw - 0.9, 6.3));
  P.push(el(u + 6.4, v, 1.0, 1.0, 2.2, 3.2, 'redlead', { sh: 'cyl' }));
  return P;
}
function portModel(lv: number, addon: Addon): Part[] {
  const P: Part[] = [];
  if (lv >= 3) {
    P.push(...pier(COAST, -13, 20, -8.6), ...pier(COAST, 8.6, 20, 13));
    P.push(...ship(3.4, 0, 16.6, 7.4));
    P.push(...house(-19, -9, -8, -2, 6, 'fieldgrey'), band(-19.4, -2.2, -7.6, -1.4, 6), ...flag(-8.4, -9.4, 6, 6.5, 4));
    P.push(...house(-6, -9, 3, -2, 5.4, 'brick'));
    P.push(...containers(-18, 6, 3, 2, 2, true), ...containers(-4.5, 8, 2, 2, 7, false));
    P.push(...crane(-0.4, -10.8, 15), ...crane(-0.4, 10.8, 15));
    if (addon === 'guns') P.push(...coastalGun(-5, -17), ...coastalGun(-5, 18));
  } else {
    P.push(...pier(COAST, -2, 18, 2.8));
    P.push(...house(-18, -2.4, -7, 4.6, 5, 'fieldgrey'), band(-18.4, 4.4, -6.6, 5.2, 5), ...flag(-7.6, -2.8, 5, 6, 4));
    P.push(...containers(-17, 8, 2, 2, 4, true), ...containers(-7, 8.4, 1, 2, 9, false));
    P.push(...crane(-0.4, -4.6, 14));
    if (addon === 'guns') P.push(...coastalGun(-6, -10), ...coastalGun(-6, 15));
  }
  return P;
}

function modelOf(spec: BuildingSpec): Part[] {
  switch (spec.type) {
    case 'fort':
      return fortModel(spec.level, spec.addon);
    case 'city':
      return cityModel(spec.level, spec.addon);
    case 'sam':
      return samModel(spec.level, spec.addon);
    case 'port':
      return portModel(spec.level, spec.addon);
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
  foam: (c) => mix(c, [226, 234, 236], 0.5),
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
    const lvl = Math.floor(m * 3 + bayer(ax, ay));
    if (lvl <= 0) return;
    const a = (amax * Math.min(3, lvl)) / 3;
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
  shadows(parts: readonly Part[], amax: number): void {
    const m = new Float32Array(this.W * this.H);
    const dirU = 0.62;
    const dirV = 0.5;
    for (const p of parts) {
      const top = p.z + p.h;
      if (top < 0.7 || p.glow || (p.a ?? 1) < 1 || p.edge) continue;
      const reach = top * 0.55;
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
        if (cov > 0.05) this.put(ax, ay, 'shadow', Math.min(1, cov * 1.25), amax);
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
        if (sea) this.put(ax, ay, 'foam', best <= 1 ? 1 : best <= 2 ? 0.55 : 0, 0.5);
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
      const lots = cityLots(lv);
      let u0 = 99;
      let u1 = -99;
      let v0 = 99;
      let v1 = -99;
      for (const l of lots) {
        u0 = Math.min(u0, l.u - l.w / 2);
        u1 = Math.max(u1, l.u + l.w / 2);
        v0 = Math.min(v0, l.v - l.d / 2);
        v1 = Math.max(v1, l.v + l.d / 2);
      }
      g.slab('dark', u0 - 5, v0 - 4, u1 + 5, v1 + 5, 7, 0.4, 5, 12);
      g.slab('dirt', u0 - 2.4, v0 - 2, u1 + 2.4, v1 + 2.6, 5, 0.7, 3, 13);
      // streets: a lane between the rows, lanes between the columns
      const mid = (v0 + v1) / 2 + (lv >= 5 ? -2.6 : lv >= 3 ? -1.6 : 0.2);
      g.strip('road', u0 - 3, mid, u1 + 3, mid + (lv >= 5 ? 0.6 : 0.2), 3.2, 0.62, 14);
      if (lv >= 3) {
        const row = [...new Set(lots.filter((l) => l.v < mid).map((l) => l.u))].sort((a, b) => a - b);
        for (let i = 0; i + 1 < row.length; i++) g.strip('road', (row[i] + row[i + 1]) / 2, v0 - 3, (row[i] + row[i + 1]) / 2, v1 + 3, 2.4, 0.5, 15 + i);
      }
      if (lv >= 5) g.strip('road', u0 - 3, v1 + 2.5, u1 + 3, v1 + 2.8, 2.4, 0.5, 30);
      g.strip('dirtL', u1 + 2, mid, u1 + 14, mid + 3, 2.6, 0.5, 16);
      g.blob('dark', u0 - 5, v1 + 2, 4, 2.4, 0.5, 0.4, 17);
      break;
    }
    case 'sam': {
      const rx = lv >= 3 ? 25 : 18;
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
      const L = lv >= 3 ? 23 : 21;
      const top = lv >= 3 ? -20 : -13;
      const bot = lv >= 3 ? 21 : 17;
      g.slab('dark', -L - 5, top - 3, COAST + 2, bot + 3, 6, 0.4, 5, 25);
      g.slab('dirt', -L, top, COAST + 1, bot, 4, 0.78, 3, 26);
      g.slab('dirtL', -L + 2, lv >= 3 ? 3 : 0.5, COAST + 1.5, lv >= 3 ? 8.6 : 6.6, 2, 0.5, 2.4, 27);
      g.blob('dark', -23, bot - 2, 4, 3, 0.5, 0.4, 28);
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
  const parts = modelOf(spec);
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
  const b = outlineOf(rasterize({ parts, ground: 0.3 }, res, 0, { facings: 32, owner }), owner, ringWidth(g.k));
  const d = gr.d;
  let topRow = CH;
  const bx0 = ox - b.ox;
  const by0 = oy - b.oy;
  for (let y = 0; y < b.h; y++) {
    for (let x = 0; x < b.w; x++) {
      const s = (y * b.w + x) * 4;
      const sa = b.data[s + 3] / 255;
      if (sa <= 0) continue;
      if (sa >= 0.78) topRow = Math.min(topRow, y + by0);
      const X = x + bx0;
      const Y = y + by0;
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
  const cv = makeCanvas(CW, CH);
  const cx = cv.getContext('2d');
  if (cx) {
    const img = cx.createImageData(CW, CH);
    img.data.set(d);
    cx.putImageData(img, 0, 0);
  }
  return { canvas: cv, w: CW * g.k, h: CH * g.k, top: topRow * g.k, cx: ox * g.k };
}

/** The level pill: the army count pill's look (a near-black outline, a dark plate, a faint light top row), the owner's colour on its left edge. */
function levelPill(ctx: CanvasRenderingContext2D, x: number, y: number, level: number, owner: RGB): void {
  const text = `Level ${level}`;
  ctx.font = `600 11px ${MAP_NUM_FAMILY}`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  const tw = Math.ceil(ctx.measureText(text).width);
  const w = tw + 14;
  const h = 15;
  const x0 = Math.round(x);
  const y0 = Math.round(y);
  ctx.fillStyle = 'rgb(8,10,13)';
  ctx.fillRect(x0, y0, w, h);
  ctx.fillStyle = 'rgba(20,23,29,0.96)';
  ctx.fillRect(x0 + 1, y0 + 1, w - 2, h - 2);
  ctx.fillStyle = 'rgba(255,255,255,0.08)';
  ctx.fillRect(x0 + 1, y0 + 1, w - 2, 1);
  ctx.fillStyle = `rgb(${owner[0]},${owner[1]},${owner[2]})`;
  ctx.fillRect(x0 + 1, y0 + 1, 4, h - 2);
  ctx.fillStyle = '#ffffff';
  ctx.fillText(text, x0 + 9, y0 + h / 2 + 0.5);
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

/** The sheet's terrain under a cell: plains, and for a port the sea east of a slightly wavy coast (the game's shelf and shore colours). */
function sheetUnder(spec: BuildingSpec, res: number, scale: number): Under {
  const plains = TERRAIN_RGB[2];
  const ox = OU * res;
  const coastAt = (ay: number): number => ox + (COAST + Math.sin((ay * 0.21) / (res / 2)) * 0.7) * res;
  const isSea = (ax: number, ay: number): boolean => spec.type === 'port' && ax > coastAt(ay);
  const tilePx = (4 / scale) * res;
  return {
    water: isSea,
    rgb: (ax, ay) => {
      if (!isSea(ax, ay)) return plains;
      return waterRGB(1 + ((ax - coastAt(ay)) / tilePx) * 1.5);
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
        const spr = bakeBuilding(row.spec, owners[i], s, dpr, sheetUnder(row.spec, grid.res, s), true);
        const px = xs[i] + (COLS[i].w - spr.w) / 2;
        const py = cy - spr.h / 2;
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(spr.canvas, Math.round(px * dpr) / dpr, Math.round(py * dpr) / dpr, spr.w, spr.h);
        levelPill(ctx, px + spr.cx - 28, py + spr.top - 18, row.spec.level, owners[i]);
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
    { type: 'port', level: 3, addon: null, x: px, y: py, blue: false },
    mk('fort', 3, null, px - 12, py - 22, false),
    mk('city', 3, null, px - 20, py + 24, false),
    mk('sam', 1, null, px - 22, py + 8, false),
    mk('fort', 5, null, px - 54, py - 22, true),
    mk('city', 1, null, px - 52, py + 24, true),
    mk('sam', 3, null, px - 46, py + 1, true),
  ];
  const troops: Troop[] = [];
  const pills: Pill[] = [];
  const addTank = (site: number, key: SpriteKey, u: number, v: number, angle: number): void => {
    troops.push({ key, site, u, v, angle, blue: sites[site].blue });
  };
  // beside the red level 3 fort and the blue level 5 fort: columns of tanks and an army count pill; a tank by each
  // other building; a destroyer and a trade ship at sea off the port
  addTank(1, 'tankDivision', -14, 20, 0);
  addTank(1, 'tankDivision', 1, 20, 0);
  addTank(1, 'heavyTank', 17, 20, 0);
  pills.push({ site: 1, u: 2, v: 29, troops: 12400, kinds: ['armor', 'artillery'], blue: false });
  addTank(4, 'tankDivision', -8, 23, 0.3);
  addTank(4, 'lightTank', 9, 24, 0.3);
  pills.push({ site: 4, u: 0, v: 32, troops: 50000, kinds: [], blue: true });
  addTank(2, 'lightTank', 30, 6, 0.4);
  addTank(3, 'heavyTank', 22, 12, 0);
  addTank(5, 'tankDivision', 27, 6, 0.2);
  addTank(6, 'lightTank', 32, 10, 0.1);
  troops.push({ key: 'destroyer', site: 0, u: 15, v: -36, angle: 0.05, blue: false }, { key: 'tradeShip', site: 0, u: 17, v: 28, angle: -0.1, blue: false });
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
function drawMapPreview(cv: HTMLCanvasElement, crop: Crop, zoom: number, dpr: number, shiftX: number): void {
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
    const spr = bakeBuilding({ type: s.type, level: s.level, addon: s.addon }, owner, scale, dpr, under);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(spr.canvas, Math.round(cellX * dpr) / dpr, Math.round(cellY * dpr) / dpr, spr.w, spr.h);
    levels.push([cellX + spr.cx - 28, cellY + spr.top - 18, s.level, owner]);
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
  note.textContent = 'Map buildings drawn like the troops: the same shaded pixels, four tones per material, lit from the top left, a dark edge and an outline in the nation\'s colour. They stand on the land with a shadow, dirt and paths made from the land\'s own colour, and the level is on a small dark pill like the army count. Each building is shown for a blue and a red nation, at close and normal zoom, next to today\'s icon.';
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
  mn.textContent = `The same buildings over a crop of the game's ${MAP_ID} map (its own loader and terrain colours), with the border of two nations, at the same size as the game's units for each zoom (zoom ${ZOOM_NORMAL} and zoom ${ZOOM_CLOSE}). Next to them are the game's real tanks, ships and army count pills, so the two can be compared side by side.`;
  mh.append(mt, mn);
  sec.append(mh);
  const previews: [string, number, number, number][] = [
    [`Normal zoom (zoom ${ZOOM_NORMAL})`, ZOOM_NORMAL, 300, 0],
    [`Close zoom (zoom ${ZOOM_CLOSE})`, ZOOM_CLOSE, 680, -10],
  ];
  const mcs: { cv: HTMLCanvasElement; zoom: number; shift: number }[] = [];
  for (const [name, zoom, hh, shift] of previews) {
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
    mcs.push({ cv: mc, zoom, shift });
  }
  root.append(sec);
  void buildCrop().then(
    (crop) => {
      const go = (): void => {
        for (const m of mcs) drawMapPreview(m.cv, crop, m.zoom, dpr, m.shift);
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
