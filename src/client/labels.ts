// Name label placement: for each player, the biggest text block that fits inside their territory.
//
// One pass over map.owner gives every player's bounding box. Each box is sampled on a coarse grid (cell size f
// chosen so a box has at most ~MAX_CELLS cells), and the largest inscribed rectangle of owned cells is found with the
// classic "largest rectangle in a histogram" sweep. Rectangles are scored by the font size a name of that length
// could use in them (wide and short beats tall and thin), not by area. Cost: one map pass plus ~MAX_CELLS per player.

/** Text block in font-size units: name width per character, height of name + troop line. */
export const LABEL_CHAR_W = 0.6;
export const LABEL_BLOCK_H = 2.1;
const MAX_CELLS = 1600;

export interface LabelPlacement {
  id: number;
  /** centre of the text block, tile coordinates */
  cx: number;
  cy: number;
  /** name font size in tiles (the troop line uses ~0.72 of it) */
  size: number;
  tiles: number;
  /** bounding box of the territory (inclusive tile coords) */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Reusable buffers (one per renderer) so a recompute allocates little. */
export class LabelScratch {
  minX = new Int32Array(0);
  minY = new Int32Array(0);
  maxX = new Int32Array(0);
  maxY = new Int32Array(0);
  count = new Int32Array(0);
  heights = new Int32Array(0);
  stack = new Int32Array(0);
  ensure(players: number, cells: number): void {
    if (this.count.length < players) {
      this.minX = new Int32Array(players);
      this.minY = new Int32Array(players);
      this.maxX = new Int32Array(players);
      this.maxY = new Int32Array(players);
      this.count = new Int32Array(players);
    }
    if (this.heights.length < cells + 1) {
      this.heights = new Int32Array(cells + 1);
      this.stack = new Int32Array(cells + 1);
    }
  }
}

/** Font size (tiles) a name of `chars` characters can use inside a W x H tile rectangle. */
export function fitSize(W: number, H: number, chars: number): number {
  return Math.min(W / (Math.max(3, chars) * LABEL_CHAR_W + 0.6), H / LABEL_BLOCK_H);
}

/**
 * Label placements for players 1..playerCount-1 that own tiles and pass `include`.
 * `chars(id)` = length of the longest text line (usually the name).
 */
export function computeLabels(
  owner: Uint16Array,
  w: number,
  h: number,
  playerCount: number,
  include: (id: number) => boolean,
  chars: (id: number) => number,
  scratch: LabelScratch = new LabelScratch(),
): LabelPlacement[] {
  scratch.ensure(playerCount, 4096);
  const { minX, minY, maxX, maxY, count } = scratch;
  for (let id = 0; id < playerCount; id++) {
    minX[id] = w;
    minY[id] = h;
    maxX[id] = -1;
    maxY[id] = -1;
    count[id] = 0;
  }
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const o = owner[row + x];
      if (o === 0 || o >= playerCount) continue;
      count[o]++;
      if (x < minX[o]) minX[o] = x;
      if (x > maxX[o]) maxX[o] = x;
      if (y < minY[o]) minY[o] = y;
      if (y > maxY[o]) maxY[o] = y;
    }
  }

  const out: LabelPlacement[] = [];
  for (let id = 1; id < playerCount; id++) {
    if (count[id] === 0 || !include(id)) continue;
    const bx0 = minX[id];
    const by0 = minY[id];
    const bw = maxX[id] - bx0 + 1;
    const bh = maxY[id] - by0 + 1;
    const f = Math.max(1, Math.ceil(Math.sqrt((bw * bh) / MAX_CELLS)));
    const gw = Math.ceil(bw / f);
    const gh = Math.ceil(bh / f);
    scratch.ensure(playerCount, gw);
    const heights = scratch.heights;
    const stack = scratch.stack;
    heights.fill(0, 0, gw + 1);
    const n = chars(id);
    let best = 0;
    let bestArea = 0;
    let bcx = 0;
    let bcy = 0;
    const half = (f - 1) >> 1;
    for (let r = 0; r < gh; r++) {
      const ty = Math.min(maxY[id], by0 + r * f + half);
      const rowBase = ty * w;
      for (let c = 0; c < gw; c++) {
        const tx = Math.min(maxX[id], bx0 + c * f + half);
        heights[c] = owner[rowBase + tx] === id ? heights[c] + 1 : 0;
      }
      heights[gw] = 0;
      // Largest rectangles in the histogram ending at row r.
      let sp = 0;
      for (let c = 0; c <= gw; c++) {
        const hc = heights[c];
        while (sp > 0 && heights[stack[sp - 1]] >= hc) {
          const top = stack[--sp];
          const H = heights[top];
          if (H === 0) continue;
          const left = sp > 0 ? stack[sp - 1] + 1 : 0;
          const width = c - left;
          const s = fitSize(width * f, H * f, n);
          const area = width * H;
          // Same font size: the bigger rectangle centres the label better (more margin around the text).
          if (s > best + 1e-9 || (s > best - 1e-9 && area > bestArea)) {
            best = s;
            bestArea = area;
            bcx = bx0 + (left + width / 2) * f;
            bcy = by0 + (r + 1 - H / 2) * f;
          }
        }
        stack[sp++] = c;
      }
    }
    if (best <= 0) {
      // Thin or speckled land the coarse grid missed: put a small label on the box centre.
      best = Math.sqrt(count[id]) * 0.15;
      bcx = bx0 + bw / 2;
      bcy = by0 + bh / 2;
    }
    // Keep inside the map.
    bcx = Math.min(w, Math.max(0, bcx));
    bcy = Math.min(h, Math.max(0, bcy));
    out.push({ id, cx: bcx, cy: bcy, size: best, tiles: count[id], x0: bx0, y0: by0, x1: maxX[id], y1: maxY[id] });
  }
  return out;
}
