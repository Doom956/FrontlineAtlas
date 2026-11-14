// Footprint helpers for the detailed style's unit models (client only, pure): short builders for the rasterizer's
// parts (bake.ts Part) in model units, nose at +u, starboard at +v. Shared by models.ts and ships.ts.
import type { MatId, Part, Pattern, Shade } from './bake';

export interface Opt {
  sh?: Shade;
  pat?: Pattern;
  alt?: MatId;
  a?: number;
  glow?: boolean;
  inset?: boolean;
  edge?: boolean;
  tone?: number;
  sc?: readonly [number, number, number, number];
  clip?: readonly number[];
  clipPoly?: readonly number[];
  minRes?: number;
}
export const box = (u0: number, v0: number, u1: number, v1: number, z: number, h: number, m: MatId, o: Opt = {}): Part => ({ k: 'box', p: [u0, v0, u1, v1], z, h, m, ...o });
export const ell = (u: number, v: number, ru: number, rv: number, z: number, h: number, m: MatId, o: Opt = {}): Part => ({ k: 'ell', p: [u, v, ru, rv], z, h, m, ...o });
export const poly = (p: number[], z: number, h: number, m: MatId, o: Opt = {}): Part => ({ k: 'poly', p, z, h, m, ...o });
export const seg = (u0: number, v0: number, u1: number, v1: number, w: number, z: number, h: number, m: MatId, o: Opt = {}): Part => ({ k: 'seg', p: [u0, v0, u1, v1, w], z, h, m, ...o });
/** A polygon given by its port half (v <= 0) from one end to the other, closed through its mirror. */
export function sym(half: number[]): number[] {
  const out = [...half];
  for (let i = half.length - 2; i >= 0; i -= 2) if (half[i + 1] !== 0) out.push(half[i], -half[i + 1]);
  return out;
}

/** Parts scaled by `k` round the origin (footprints, heights, shading frames, clip shapes). */
export function grown(parts: readonly Part[], k: number): Part[] {
  const sc = (q: readonly number[] | undefined): number[] | undefined => q && q.map((x) => x * k);
  return parts.map((p) => ({ ...p, p: sc(p.p)!, z: p.z * k, h: p.h * k, sc: p.sc && ([p.sc[0] * k, p.sc[1] * k, p.sc[2] * k, p.sc[3] * k] as const), clip: sc(p.clip), clipPoly: sc(p.clipPoly) }));
}

/** Parts in material `m` shifted `dt` tones lighter (a unit's paint lifted off the ground it stands on). */
export function toned(parts: readonly Part[], m: MatId, dt: number): Part[] {
  return parts.map((p) => (p.m === m ? { ...p, tone: (p.tone ?? 0) + dt } : p));
}
