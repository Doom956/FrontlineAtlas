// Backgrounds of the art lab's cells (art lab builds only): the map's own sea and land colours, so the art is judged
// where it will stand. The sea is the map's smooth slate ramp by distance to the coast (render/terrain.ts waterRGB);
// the land is fresh plains with softer forest and hill patches (render/terrain.ts TERRAIN_RGB). Painted once per size
// into a canvas and reused every frame. No module-level side effects (a normal build drops all of this).
import { makeCanvas } from '../render/common';
import { TERRAIN_RGB, waterRGB } from '../render/terrain';

export type Ground = 'sea' | 'land' | 'coastRight' | 'coastLeft' | 'split';

const cache = new Map<string, HTMLCanvasElement>();

/** A repeatable 0..1 value for a grid point (soft land patches). */
function hash(x: number, y: number, s: number): number {
  const v = Math.sin(x * 127.1 + y * 311.7 + s * 74.7) * 43758.5453;
  return v - Math.floor(v);
}
/** Smooth value noise (0..1) at (x, y) on a grid of `cell` px. */
function noise(x: number, y: number, cell: number, s: number): number {
  const gx = x / cell;
  const gy = y / cell;
  const x0 = Math.floor(gx);
  const y0 = Math.floor(gy);
  const fx = gx - x0;
  const fy = gy - y0;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const a = hash(x0, y0, s);
  const b = hash(x0 + 1, y0, s);
  const c = hash(x0, y0 + 1, s);
  const d = hash(x0 + 1, y0 + 1, s);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}

/** Land colour at a point: plains, with forest and hill patches blended in softly. */
function landAt(x: number, y: number): [number, number, number] {
  const plains = TERRAIN_RGB[2];
  const forest = TERRAIN_RGB[3];
  const hills = TERRAIN_RGB[4];
  const n1 = noise(x, y, 46, 1);
  const n2 = noise(x, y, 70, 2);
  const f = Math.max(0, Math.min(1, (n1 - 0.55) * 4));
  const h = Math.max(0, Math.min(1, (n2 - 0.62) * 4));
  const grain = (noise(x, y, 5, 3) - 0.5) * 6;
  const out: [number, number, number] = [0, 0, 0];
  for (let i = 0; i < 3; i++) out[i] = Math.round(plains[i] + (forest[i] - plains[i]) * f * 0.8 + (hills[i] - plains[i]) * h * 0.7 + grain);
  return out;
}

/**
 * A w x h background: open sea, plain land, a coast (land on the right or left, the shelf lighter near it), or land on
 * the left half and sea on the right ('split', for planes: their shadows show on both).
 */
export function backdrop(kind: Ground, w: number, h: number, zoom: number): HTMLCanvasElement {
  const W = Math.max(1, Math.round(w));
  const H = Math.max(1, Math.round(h));
  const key = `${kind}|${W}|${H}|${zoom}`;
  const hit = cache.get(key);
  if (hit) return hit;
  if (cache.size > 80) cache.clear();
  const c = makeCanvas(W, H);
  const ctx = c.getContext('2d');
  if (!ctx) return c;
  const img = ctx.createImageData(W, H);
  const d = img.data;
  // where the coast is (px from the left), and how far each point is from it in tiles
  const coastX = kind === 'coastRight' ? Math.round(W * 0.72) : kind === 'coastLeft' ? Math.round(W * 0.26) : kind === 'split' ? Math.round(W * 0.5) : -1;
  for (let y = 0; y < H; y++) {
    // a wavy coast line, a few px in and out
    const wob = coastX >= 0 ? Math.round((noise(0, y, 24, 7) - 0.5) * 18) : 0;
    for (let x = 0; x < W; x++) {
      let land: boolean;
      let dist: number;
      if (kind === 'land') {
        land = true;
        dist = 0;
      } else if (kind === 'sea') {
        land = false;
        dist = 8 + (y / H) * 10;
      } else if (kind === 'coastLeft') {
        land = x < coastX + wob;
        dist = (x - coastX - wob) / zoom;
      } else {
        land = x >= coastX + wob;
        dist = (coastX + wob - x) / zoom;
      }
      const rgb = land ? landAt(x, y) : waterRGB(1 + Math.max(0, dist));
      const o = (y * W + x) * 4;
      d[o] = rgb[0];
      d[o + 1] = rgb[1];
      d[o + 2] = rgb[2];
      d[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  if (kind !== 'land') {
    // a light sandy rim along the coast and the faint wave marks of the map's open sea
    ctx.fillStyle = 'rgba(214,200,160,0.55)';
    if (coastX >= 0) {
      for (let y = 0; y < H; y++) {
        const wob = Math.round((noise(0, y, 24, 7) - 0.5) * 18);
        ctx.fillRect(kind === 'coastLeft' ? coastX + wob - 2 : coastX + wob, y, 2, 1);
      }
    }
    ctx.strokeStyle = 'rgba(160,190,210,0.10)';
    ctx.lineWidth = 1.2;
    for (let i = 0; i < Math.round((W * H) / 9000); i++) {
      const x = hash(i, 1, 9) * W;
      const y = hash(i, 2, 9) * H;
      const deep = coastX < 0 || (kind === 'coastLeft' ? x > coastX + 60 : x < coastX - 60);
      if (!deep) continue;
      ctx.beginPath();
      ctx.arc(x, y + 6, 7, Math.PI * 1.2, Math.PI * 1.8);
      ctx.stroke();
    }
  }
  cache.set(key, c);
  return c;
}
