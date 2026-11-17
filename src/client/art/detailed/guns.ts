// The turning guns of the Defense row (client only, drawn in code, no asset files): the heads of the flak guns and of the
// coastal guns. The building's cached sprite (buildings.ts) holds only what stands still (a sandbag pit, a concrete
// emplacement); the head is baked here on its own at 32 headings (facing 0 = east, clockwise on screen, like the units)
// and drawn over the building at whichever heading points at its target (render/gunLayer.ts). A head is baked once per
// kind, owner colour, look, scale, dpr and heading, never per frame. No Math.random or Date here.
//   flak     a quad AA gun: four barrels climbing to the sky on a turntable, a gun shield across the front in the owner's
//            colour, a breech and two ammunition drums, the sandbag pit round it (static)
//   coastal  a naval turret: a wedge of armour in the owner's colour on a concrete barbette, one long heavy barrel with
//            a muzzle brake, a hatch (the concrete emplacement under it is static)
import { makeCanvas } from '../../render/common';
import type { RGB } from '../shared/colour';
import { FORE, LIFT, rasterize, type Part } from './bake';
import { gridOf } from './grid';
import { outlineOf, ringWidth } from './outline';
import { box, ell, grown, poly, seg } from './shapes';

export type GunKind = 'flak' | 'coastal';
/** Headings a gun head is baked at (a turn of the gun steps through these). */
export const GUN_FACINGS = 32;

/** Where the muzzle is from the mount (model units along the heading) and how high (model units): flash and shell leave here. */
/** the flak head is drawn this much bigger than its model (it has to read at normal zoom) */
const FLAK_SCALE = 1.25;
export const MUZZLE: Record<GunKind, { len: number; z: number }> = {
  flak: { len: 8.6 * FLAK_SCALE, z: 3.3 * FLAK_SCALE },
  coastal: { len: 14.8, z: 3.0 },
};

/** A steel barrel from (u0, 0) to (u1, 0) at v, `w` thick, standing at z: a dark cylinder with a bright stripe on its lit side. */
function tube(u0: number, u1: number, v: number, z: number, w: number, tip = true): Part[] {
  const P: Part[] = [seg(u0, v, u1, v, w, z, w * 0.9, 'black', { sh: 'cyl', tone: 0.3 }), seg(u0, v - w * 0.2, u1, v - w * 0.2, w * 0.34, z + w * 0.9, 0.25, 'alu', { tone: 0.8 })];
  if (tip) P.push(seg(u1 - 0.9, v, u1, v, w * 1.25, z, w * 1.0, 'gun', { sh: 'cyl', tone: 0.5 }));
  return P;
}

/** The flak gun's head, pointing east (u+) from the mount's centre; z 0 is the top of the pit. */
export function flakHead(simple: boolean): Part[] {
  const P: Part[] = [];
  // a turntable disc and the breech casing behind the shield
  P.push(ell(0, 0, 2.4, 2.1, 0.3, 0.8, 'gun', { sh: 'dome', tone: 0.1 }));
  P.push(box(-2.4, -1.5, 0.8, 1.5, 1.1, 1.5, 'black', { tone: 0.3 }), box(-2.0, -1.0, 0.2, 1.0, 2.6, 0.4, 'gun', { tone: 0.7 }));
  // two ammunition drums beside the breech
  if (!simple) P.push(el2(-1.3, -2.2), el2(-1.3, 2.2));
  // four barrels climbing: the lower pair outside, the upper pair between them, so the gun reads as a quad mount
  P.push(...tube(0.8, 5.2, -1.45, 1.5, 0.85, false), ...tube(5.2, 8.6, -1.45, 2.7, 0.85));
  P.push(...tube(0.8, 5.2, 1.45, 1.5, 0.85, false), ...tube(5.2, 8.6, 1.45, 2.7, 0.85));
  P.push(...tube(0.8, 5.4, -0.5, 2.3, 0.85, false), ...tube(5.4, 8.6, -0.5, 3.5, 0.85));
  P.push(...tube(0.8, 5.4, 0.5, 2.3, 0.85, false), ...tube(5.4, 8.6, 0.5, 3.5, 0.85));
  // the gun shield: a wide plate across the front of the breech in steel, with the owner's colour on its upper edge
  P.push(poly([0.2, -3.3, 1.7, -2.5, 1.7, 2.5, 0.2, 3.3], 0.6, 2.8, 'seagrey', { tone: 0.6, edge: true }));
  P.push(poly([0.2, -3.3, 1.7, -2.5, 1.7, 2.5, 0.2, 3.3], 3.4, 0.6, 'own', { tone: 0.3, edge: true }));
  return grown(P, FLAK_SCALE);
}
function el2(u: number, v: number): Part {
  return ell(u, v, 0.9, 0.9, 1.1, 1.1, 'brass', { sh: 'cyl', tone: 0.1 });
}

/** The coastal gun's head, pointing east (u+) from the mount's centre; z 0 is the top of the concrete barbette. */
export function coastalHead(simple: boolean): Part[] {
  const P: Part[] = [];
  // the armoured house: a chamfered wedge of sea-grey armour with a bright roof edge, the owner's colour across it, a rear bulge that balances the gun
  const house = [-3.8, -2.7, 0.4, -3.1, 2.9, -1.9, 2.9, 1.9, 0.4, 3.1, -3.8, 2.7];
  P.push(ell(-3.9, 0, 1.5, 2.4, 0, 2.6, 'seagrey', { sh: 'cyl', tone: -0.3 }));
  P.push(poly(house, 0, 3.0, 'seagrey', { tone: 0.1 }), poly(house, 3.0, 0.6, 'seagrey', { tone: 0.9, edge: true }));
  P.push(box(-1.5, -3.2, -0.1, 3.2, 3.6, 0.5, 'own', { tone: 0.3 }));
  if (!simple) P.push(ell(-2.5, 1.2, 0.9, 0.9, 3.6, 0.7, 'alu', { sh: 'dome', tone: 0.5 }), box(0.6, -1.0, 2.2, 1.0, 3.6, 0.35, 'black', { tone: 0.4 }));
  // the mantlet and one long heavy barrel in steel with a dark muzzle brake
  P.push(box(2.8, -1.7, 4.0, 1.7, 0.7, 2.3, 'black', { tone: 0.3 }));
  P.push(seg(3.8, 0, 14.8, 0, 2.2, 1.1, 2.0, 'seagrey', { sh: 'cyl', tone: 0.1 }), seg(3.8, -0.45, 14.8, -0.45, 0.8, 3.0, 0.25, 'alu', { tone: 1.1 }));
  P.push(seg(13.4, 0, 14.8, 0, 3.1, 0.9, 2.4, 'black', { sh: 'cyl', tone: 0.3 }), seg(13.9, 0, 14.2, 0, 3.4, 1.1, 2.0, 'gun', { sh: 'cyl', tone: 0.3 }));
  return P;
}

/** The head of a kind (`simple`: the far look's lighter model). */
export function gunHead(kind: GunKind, simple: boolean): Part[] {
  return kind === 'flak' ? flakHead(simple) : coastalHead(simple);
}

/** A baked head: its canvas, its size and the model origin in it (CSS px). */
export interface BakedGun {
  canvas: HTMLCanvasElement;
  w: number;
  h: number;
  /** where the mount's centre (u 0, v 0, z 0) lies in the canvas */
  ox: number;
  oy: number;
}

/** Bakes one head at heading `facing` (0..GUN_FACINGS - 1) at map scale `scale` on a screen of `dpr`, with the owner's outline ring. */
export function bakeGun(kind: GunKind, owner: RGB, scale: number, dpr: number, facing: number): BakedGun {
  const g = gridOf(scale, dpr);
  const raw = rasterize({ parts: gunHead(kind, scale < 2), ground: 0 }, g.res, facing, { facings: GUN_FACINGS, owner });
  const b = outlineOf(raw, owner, ringWidth(g.k));
  const cv = makeCanvas(b.w, b.h);
  const cx = cv.getContext('2d');
  if (cx) {
    const img = cx.createImageData(b.w, b.h);
    img.data.set(b.data);
    cx.putImageData(img, 0, 0);
  }
  return { canvas: cv, w: b.w * g.k, h: b.h * g.k, ox: b.ox * g.k, oy: b.oy * g.k };
}

/** Where the muzzle of a head standing at the mount lies on screen, relative to the mount's ground point: heading `th` (model radians). */
export function muzzleOffset(kind: GunKind, th: number, scale: number): { x: number; y: number } {
  const m = MUZZLE[kind];
  return { x: Math.cos(th) * m.len * scale, y: (Math.sin(th) * m.len * FORE - m.z * LIFT) * scale };
}
