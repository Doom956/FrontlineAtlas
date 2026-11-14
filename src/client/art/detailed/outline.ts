// The detailed style's map outline (client only, pure): a post-process on a baked unit (bake.ts Baked) that makes it
// stand out from any land or sea and shows whose it is at a glance. The translucent dark rim of the bake is replaced
// by a ring in the owner's full colour, `ring` art px wide (about 1 CSS px on screen: render/units.ts picks it from
// the grid), and a dark outer edge 1 art px wide (light for very dark nations, so it still separates them from the
// sea). The buffer grows by ring + 1 cells on each side and its origin moves with it, so the unit stays where it was.
// Only map sprites get it; the HUD portraits keep the plain bake.
import type { Baked } from './bake';

/** The outer edge round the owner ring: dark, or light for owners whose colour is itself very dark. */
export function outlineEdge(owner: readonly number[]): readonly number[] {
  const l = (0.299 * owner[0] + 0.587 * owner[1] + 0.114 * owner[2]) / 255;
  return l < 0.3 ? [232, 238, 246] : [8, 11, 17];
}
/** Alpha of the outer edge. */
export const EDGE_ALPHA = 215;

/** Ring width in art px for a grid of `k` CSS px per art px: about one CSS px, 1 to 3 art px. */
export function ringWidth(k: number): number {
  return Math.max(1, Math.min(3, Math.round(1 / Math.max(0.01, k))));
}

/** True for a pixel of the bake's translucent dark rim (bake.ts: colour 10, 13, 17 at alpha 120 or 72). */
function isRim(d: Uint8ClampedArray, o: number): boolean {
  return d[o] === 10 && d[o + 1] === 13 && d[o + 2] === 17 && d[o + 3] < 200;
}

/** The outlined copy of a baked unit (see the header). Solid pixels (alpha 200 and up) are the silhouette. */
export function outlineOf(b: Baked, owner: readonly number[], ring = 1): Baked {
  const G = ring + 1;
  const W = b.w + 2 * G;
  const H = b.h + 2 * G;
  const n = W * H;
  const data = new Uint8ClampedArray(n * 4);
  const dist = new Uint8Array(n).fill(255);
  let front: number[] = [];
  for (let y = 0; y < b.h; y++) {
    for (let x = 0; x < b.w; x++) {
      const s = (y * b.w + x) * 4;
      const a = b.data[s + 3];
      if (a === 0 || isRim(b.data, s)) continue;
      const idx = (y + G) * W + x + G;
      const o = idx * 4;
      data[o] = b.data[s];
      data[o + 1] = b.data[s + 1];
      data[o + 2] = b.data[s + 2];
      data[o + 3] = a;
      if (a >= 200) {
        dist[idx] = 0;
        front.push(idx);
      }
    }
  }
  // grow the silhouette one art px at a time (4 neighbours: crisp pixel steps, no blurred corners)
  const edge = outlineEdge(owner);
  for (let d = 1; d <= G; d++) {
    const next: number[] = [];
    for (const idx of front) {
      const x = idx % W;
      const y = (idx / W) | 0;
      const nb = [x > 0 ? idx - 1 : -1, x < W - 1 ? idx + 1 : -1, y > 0 ? idx - W : -1, y < H - 1 ? idx + W : -1];
      for (const j of nb) {
        if (j < 0 || dist[j] !== 255) continue;
        dist[j] = d;
        next.push(j);
        const o = j * 4;
        const c = d <= ring ? owner : edge;
        data[o] = c[0];
        data[o + 1] = c[1];
        data[o + 2] = c[2];
        data[o + 3] = d <= ring ? 255 : EDGE_ALPHA;
      }
    }
    front = next;
  }
  return { w: W, h: H, ox: b.ox + G, oy: b.oy + G, data };
}
