// Map decor (client only, looks only): towns, gate districts, a palace, villages, farm fields and roads that a world
// map lists in its manifest entry (WorldMapInfo.decor, from scripts/maps/defs.ts), painted once per map in the
// game's pixel-art style: clusters of small rooftops (warm red-brown and slate) over beige walls, tiny streets, church
// spires, a palace block, patchwork fields with hedges. Not buildings: the sim never sees any of it.
//
// The map shader draws it over the ground and under everything else (nations, borders, units, labels, fog), in art
// pixels of a quarter tile. It is kept sparse: blocks of BLOCK x BLOCK tiles that hold decor go into one texture, an
// atlas of BLOCK * SCALE px squares, whose first rows are the block index (slot + 1 per block, in R + G * 256; 0 =
// nothing there). Far out the shader shows the map's flat or far colours, so `withDecor` lays each tile's average
// decor colour into those too (calm patches of rooftops at whole-map zoom instead of shimmering pixels).
//
// Deterministic (a fixed hash per piece), no Math.random.
import type { MapData } from '../../sim/types';
import type { MapChoice } from '../../sim/types';
import { getWorldMap, type WorldMapDecor } from '../../sim/worldmaps';
import type { RGB } from './common';

/** tiles per block side */
export const DECOR_BLOCK = 32;
/** art pixels per tile */
export const DECOR_SCALE = 4;
/** px per block side */
const BP = DECOR_BLOCK * DECOR_SCALE;
/** blocks per atlas row */
const PER_ROW = 16;

export interface DecorLayer {
  /** RGBA8, premultiplied: the block index (idxW x idxH texels at the top left), then the atlas */
  data: Uint8Array;
  texW: number;
  texH: number;
  idxW: number;
  idxH: number;
  perRow: number;
  /** each tile's average decor colour (premultiplied RGBA), by tile index; only tiles with decor */
  far: Map<number, [number, number, number, number]>;
}

/** The decor a map's manifest entry lists (none for generated maps and maps without). */
export function decorForMap(map: MapChoice | undefined): readonly WorldMapDecor[] {
  return map?.kind === 'world' ? (getWorldMap(map.id)?.decor ?? []) : [];
}

const hx = (h: string): RGB => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const shade = (c: RGB, k: number): RGB => [c[0] * k, c[1] * k, c[2] * k];
const ROOF_WARM = ['#9c4b35', '#a9573c', '#8d4530', '#b36745', '#a35a42'].map(hx);
const ROOF_SLATE = ['#5f6872', '#6e7782', '#55606b'].map(hx);
const WALL = hx('#dccdaa');
const PAVE = hx('#c2b08a');
const ROAD = hx('#cfb98f');
const STONE = hx('#9a958a');
const SPIRE = hx('#4c5560');
const TIP = hx('#d6cfbd');
const PALACE_ROOF = hx('#56606c');
const COURT = hx('#d7c9a5');
const FIELDS: [RGB, number][] = [
  [hx('#c9b47d'), 0.55],
  [hx('#a7a065'), 0.5],
  [hx('#7f8f56'), 0.45],
  [hx('#8c6d4a'), 0.42],
  [hx('#b9a46f'), 0.5],
];
const HEDGE = hx('#4f5c37');

/** A small seeded generator (mulberry32). */
function rngOf(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Where a piece may draw: houses and fields on open land, roads on any land but walls (mountains) and water. */
const T_FOREST = 3;
const T_MOUNTAINS = 5;
const T_SWAMP = 7;

class Painter {
  readonly blocks = new Map<number, Uint8Array>();
  readonly W: number;
  readonly H: number;
  readonly idxW: number;
  /** the block written last (most writes land in the same one) */
  private lastK = -1;
  private lastB: Uint8Array | undefined;
  constructor(readonly map: MapData) {
    this.W = map.width * DECOR_SCALE;
    this.H = map.height * DECOR_SCALE;
    this.idxW = Math.ceil(map.width / DECOR_BLOCK);
  }
  /** terrain of the tile under art pixel (x, y), -1 off the map */
  ter(x: number, y: number): number {
    if (x < 0 || y < 0 || x >= this.W || y >= this.H) return -1;
    return this.map.terrain[Math.floor(y / DECOR_SCALE) * this.map.width + Math.floor(x / DECOR_SCALE)];
  }
  /** open land a building or field can stand on */
  open(x: number, y: number): boolean {
    const t = this.ter(x, y);
    return t >= 2 && t !== T_FOREST && t !== T_MOUNTAINS && t !== T_SWAMP;
  }
  /** land a road can run over */
  land(x: number, y: number): boolean {
    const t = this.ter(x, y);
    return t >= 2 && t !== T_MOUNTAINS;
  }
  /** colour c at alpha a over the pixel (premultiplied "over"); never on water or walls (mountains) */
  put(x: number, y: number, c: RGB, a = 1): void {
    x = Math.floor(x);
    y = Math.floor(y);
    if (!this.land(x, y)) return;
    const bx = Math.floor(x / BP);
    const by = Math.floor(y / BP);
    const k = by * this.idxW + bx;
    let b = k === this.lastK ? this.lastB : this.blocks.get(k);
    if (!b) this.blocks.set(k, (b = new Uint8Array(BP * BP * 4)));
    this.lastK = k;
    this.lastB = b;
    const o = ((y - by * BP) * BP + (x - bx * BP)) * 4;
    const keep = 1 - a;
    b[o] = Math.round(c[0] * a + b[o] * keep);
    b[o + 1] = Math.round(c[1] * a + b[o + 1] * keep);
    b[o + 2] = Math.round(c[2] * a + b[o + 2] * keep);
    b[o + 3] = Math.round(255 * a + b[o + 3] * keep);
  }
  /** a filled rectangle, only on pixels `ok` allows */
  rect(x: number, y: number, w: number, h: number, c: RGB, a: number, ok: (x: number, y: number) => boolean): void {
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) if (ok(x + i, y + j)) this.put(x + i, y + j, c, a);
  }
}

/** A rooftop w x h px at (x, y): a sunlit upper slope, a shaded lower one, its beige wall below. False if it does not fit. */
function house(p: Painter, x: number, y: number, w: number, h: number, roof: RGB): boolean {
  for (let j = 0; j <= h; j++) for (let i = 0; i < w; i++) if (!p.open(x + i, y + j)) return false;
  for (let j = 0; j < h; j++)
    for (let i = 0; i < w; i++) {
      const slope = j === 0 ? 1.2 : j === h - 1 ? 0.78 : 1;
      const side = i === 0 ? 1.06 : i === w - 1 ? 0.86 : 1;
      p.put(x + i, y + j, shade(roof, slope * side));
    }
  for (let i = 0; i < w; i++) p.put(x + i, y + h, i === w - 1 ? shade(WALL, 0.7) : WALL);
  return true;
}

/** A church: a slate nave, a stone tower beside it with a dark spire and a light tip. */
function church(p: Painter, x: number, y: number): void {
  if (!house(p, x, y + 1, 5, 3, ROOF_SLATE[0])) return;
  p.rect(x + 5, y + 2, 2, 3, STONE, 1, () => true);
  p.put(x + 6, y + 2, shade(STONE, 0.75));
  p.put(x + 6, y + 3, shade(STONE, 0.75));
  p.put(x + 5, y + 4, WALL);
  p.put(x + 5, y + 1, SPIRE);
  p.put(x + 5, y, SPIRE);
  p.put(x + 5, y - 1, TIP);
}

/** A roof colour: mostly warm red-brown, some slate, each a little lighter or darker. */
function roofColour(rng: () => number, slateShare: number): RGB {
  const list = rng() < slateShare ? ROOF_SLATE : ROOF_WARM;
  return shade(list[Math.floor(rng() * list.length)], 0.9 + rng() * 0.2);
}

/**
 * A town: rows of joined rooftops back to back, cut by tiny streets (a lane between every two rows, cross streets at
 * random), dense in the middle and thinning out to the edge. `inside(dx, dy)` (px from the centre) says where the
 * town may go (0..1); `dense` 0..1.
 */
function town(p: Painter, cx: number, cy: number, R: number, rng: () => number, dense: number, inside: (dx: number, dy: number) => number): void {
  const x0 = Math.floor(cx - R);
  const y0 = Math.floor(cy - R);
  // paving under the town first, so the streets read as beige lanes between the roofs
  for (let y = y0; y <= cy + R; y++)
    for (let x = x0; x <= cx + R; x++) {
      const k = inside(x - cx, y - cy);
      if (k > 0.05 && p.open(x, y)) p.put(x, y, PAVE, 0.55 * Math.min(1, k * 1.6));
    }
  let n = 0;
  // two rows of houses (3 px roof + 1 px wall each) back to back, then a 2 px street
  for (let by = y0; by <= cy + R; by += 10) {
    for (let row = 0; row < 2; row++) {
      const y = by + row * 4;
      let x = x0 + Math.floor(rng() * 6);
      let run = 0;
      let block = 12 + Math.floor(rng() * 14);
      while (x <= cx + R) {
        const w = 3 + Math.floor(rng() * 4);
        const k = inside(x + w / 2 - cx, y + 2 - cy);
        if (k > 0 && rng() < k * dense) {
          if (++n % 53 === 0) church(p, x, y - 1);
          else house(p, x, y, w, 3, roofColour(rng, 0.2));
        }
        x += w + (rng() < 0.25 ? 1 : 0);
        run += w;
        if (run >= block) {
          // a cross street
          x += 2;
          run = 0;
          block = 12 + Math.floor(rng() * 14);
        }
      }
    }
  }
}

/** Inside a disc of radius R: 1 in the middle, falling off to 0 at the rim (a ragged edge from rng). */
const discFalloff = (R: number) => (dx: number, dy: number): number => {
  const r = Math.hypot(dx, dy) / R;
  return r >= 1 ? 0 : Math.min(1, (1 - r * r) * 1.6);
};

function palace(p: Painter, cx: number, cy: number, R: number): void {
  const w = Math.max(10, Math.round(R * 1.6));
  const h = Math.max(8, Math.round(R * 1.15));
  const x = Math.round(cx - w / 2);
  const y = Math.round(cy - h / 2);
  const all = (): boolean => true;
  // a plaza round it, the block with its courtyard, towers at the corners
  p.rect(x - 4, y - 4, w + 8, h + 9, PAVE, 0.9, (i, j) => p.land(i, j));
  p.rect(x, y, w, h, PALACE_ROOF, 1, all);
  p.rect(x, y, w, 1, shade(PALACE_ROOF, 1.25), 1, all);
  p.rect(x, y, 1, h, shade(PALACE_ROOF, 1.15), 1, all);
  p.rect(x + w - 1, y, 1, h, shade(PALACE_ROOF, 0.78), 1, all);
  p.rect(x + 3, y + 3, w - 6, h - 6, COURT, 1, all);
  p.rect(x, y + h, w, 2, WALL, 1, all);
  p.rect(x + Math.floor(w / 2) - 1, y + h, 2, 2, shade(PALACE_ROOF, 0.6), 1, all);
  for (const [tx, ty] of [[x - 1, y - 1], [x + w - 2, y - 1], [x - 1, y + h - 2], [x + w - 2, y + h - 2]]) {
    p.rect(tx, ty, 3, 3, shade(PALACE_ROOF, 0.82), 1, all);
    p.put(tx, ty, shade(PALACE_ROOF, 1.3));
    p.put(tx + 1, ty + 3, WALL);
  }
  // a spire over the middle of the north wing
  p.put(x + Math.floor(w / 2), y - 1, SPIRE);
  p.put(x + Math.floor(w / 2), y - 2, TIP);
}

function village(p: Painter, cx: number, cy: number, R: number, rng: () => number): void {
  const n = 5 + Math.floor(R * R * 0.012) + Math.floor(rng() * 5);
  for (let k = 0; k < n * 3 && k < 200; k++) {
    const a = rng() * Math.PI * 2;
    const r = Math.sqrt(rng()) * R;
    const x = Math.round(cx + Math.cos(a) * r);
    const y = Math.round(cy + Math.sin(a) * r);
    if (!p.open(x, y)) continue;
    p.rect(x - 1, y - 1, 7, 6, PAVE, 0.35, (i, j) => p.open(i, j));
    const roof = roofColour(rng, 0.15);
    if (k === 0) church(p, x, y);
    else house(p, x, y, rng() < 0.3 ? 5 : 4, 3, roof);
  }
}

function farms(p: Painter, cx: number, cy: number, R: number, rng: () => number): void {
  // a patchwork of fields on a loose grid, hedges along their south and east sides, a farmhouse here and there
  for (let y = Math.floor(cy - R); y < cy + R; ) {
    const fh = 5 + Math.floor(rng() * 7);
    for (let x = Math.floor(cx - R + rng() * 6); x < cx + R; ) {
      const fw = 7 + Math.floor(rng() * 10);
      const mx = x + fw / 2 - cx;
      const my = y + fh / 2 - cy;
      if (Math.hypot(mx, my) < R * (0.75 + rng() * 0.25) && rng() < 0.85) {
        const [c, a] = FIELDS[Math.floor(rng() * FIELDS.length)];
        const ok = (i: number, j: number): boolean => p.open(i, j);
        p.rect(x, y, fw - 1, fh - 1, c, a, ok);
        // furrows: every other row a little darker
        for (let j = 1; j < fh - 1; j += 2) p.rect(x, y + j, fw - 1, 1, shade(c, 0.86), a * 0.5, ok);
        p.rect(x, y + fh - 1, fw, 1, HEDGE, 0.55, ok);
        p.rect(x + fw - 1, y, 1, fh, HEDGE, 0.55, ok);
        if (rng() < 0.12) house(p, x + 2, y + 1, 4, 3, roofColour(rng, 0.1));
      }
      x += fw;
    }
    y += fh;
  }
}

function road(p: Painter, pts: [number, number][], width: number): void {
  for (let k = 0; k + 1 < pts.length; k++) {
    const [ax, ay] = pts[k];
    const [bx, by] = pts[k + 1];
    const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay)));
    for (let i = 0; i <= n; i++) {
      const x = Math.round(ax + ((bx - ax) * i) / n);
      const y = Math.round(ay + ((by - ay) * i) / n);
      for (let j = 0; j < width; j++)
        for (let q = 0; q < width; q++) if (p.land(x + q, y + j)) p.put(x + q, y + j, j === width - 1 ? shade(ROAD, 0.85) : ROAD, 0.85);
    }
  }
}

/** Paints a map's decor into blocks and packs them (null when there is none or none of it lands on the map). */
export function buildDecor(map: MapData, decor: readonly WorldMapDecor[]): DecorLayer | null {
  if (!decor.length) return null;
  const p = new Painter(map);
  const S = DECOR_SCALE;
  const px = (tile: number): [number, number] => [((tile % map.width) + 0.5) * S, (Math.floor(tile / map.width) + 0.5) * S];
  // roads first, fields, then towns over them, the palace last
  const order: Record<WorldMapDecor['kind'], number> = { road: 0, farms: 1, village: 2, town: 3, district: 4, palace: 5 };
  const list = decor.map((d, i) => ({ d, i })).sort((a, b) => order[a.d.kind] - order[b.d.kind] || a.i - b.i);
  for (const { d } of list) {
    if (d.tile < 0 || d.tile >= map.width * map.height) continue;
    const [cx, cy] = px(d.tile);
    const R = d.size * S;
    const rng = rngOf(d.tile * 7 + d.kind.length);
    if (d.kind === 'road') road(p, [[cx, cy], ...(d.path ?? []).map(px)], Math.max(2, Math.round(R)));
    else if (d.kind === 'farms') farms(p, cx, cy, R, rng);
    else if (d.kind === 'village') village(p, cx, cy, R, rng);
    else if (d.kind === 'town') town(p, cx, cy, R, rng, 0.92, discFalloff(R));
    else if (d.kind === 'palace') palace(p, cx, cy, R);
    else if (d.kind === 'district') {
      // a half disc facing dir (map north up: screen y down), packed full of roofs to its rim
      const t = ((d.dir ?? 0) * Math.PI) / 180;
      const ex = Math.cos(t);
      const ey = -Math.sin(t);
      town(p, cx, cy, R, rng, 0.97, (dx, dy) => {
        const along = dx * ex + dy * ey;
        return along < 0 || Math.hypot(dx, dy) > R ? 0 : 1;
      });
    }
  }
  return pack(p, map);
}

function pack(p: Painter, map: MapData): DecorLayer | null {
  const keys = [...p.blocks.keys()].sort((a, b) => a - b);
  if (!keys.length) return null;
  const idxW = p.idxW;
  const idxH = Math.ceil(map.height / DECOR_BLOCK);
  const rows = Math.ceil(keys.length / PER_ROW);
  const texW = Math.max(idxW, PER_ROW * BP);
  const texH = idxH + rows * BP;
  const data = new Uint8Array(texW * texH * 4);
  const far = new Map<number, [number, number, number, number]>();
  keys.forEach((k, slot) => {
    const bx = k % idxW;
    const by = Math.floor(k / idxW);
    const io = (by * texW + bx) * 4;
    data[io] = (slot + 1) & 255;
    data[io + 1] = (slot + 1) >> 8;
    data[io + 3] = 255;
    const sx = (slot % PER_ROW) * BP;
    const sy = idxH + Math.floor(slot / PER_ROW) * BP;
    const b = p.blocks.get(k)!;
    for (let y = 0; y < BP; y++) data.set(b.subarray(y * BP * 4, (y + 1) * BP * 4), ((sy + y) * texW + sx) * 4);
    // each tile's average (premultiplied, so empty pixels count as clear)
    for (let ty = 0; ty < DECOR_BLOCK; ty++)
      for (let tx = 0; tx < DECOR_BLOCK; tx++) {
        const gx = bx * DECOR_BLOCK + tx;
        const gy = by * DECOR_BLOCK + ty;
        if (gx >= map.width || gy >= map.height) continue;
        let r = 0;
        let g = 0;
        let bl = 0;
        let a = 0;
        for (let j = 0; j < DECOR_SCALE; j++)
          for (let i = 0; i < DECOR_SCALE; i++) {
            const o = ((ty * DECOR_SCALE + j) * BP + tx * DECOR_SCALE + i) * 4;
            r += b[o];
            g += b[o + 1];
            bl += b[o + 2];
            a += b[o + 3];
          }
        if (a > 0) {
          const n = DECOR_SCALE * DECOR_SCALE;
          far.set(gy * map.width + gx, [r / n, g / n, bl / n, a / n / 255]);
        }
      }
  });
  return { data, texW, texH, idxW, idxH, perRow: PER_ROW, far };
}

/** A copy of a map-sized RGBA colour array (the flat or far colours) with each tile's decor laid over it. */
export function withDecor(rgba: Uint8Array | Uint8ClampedArray, layer: DecorLayer | null): Uint8Array {
  const out = new Uint8Array(rgba);
  if (!layer) return out;
  for (const [i, [r, g, b, a]] of layer.far) {
    const o = i * 4;
    out[o] = Math.round(out[o] * (1 - a) + r);
    out[o + 1] = Math.round(out[o + 1] * (1 - a) + g);
    out[o + 2] = Math.round(out[o + 2] * (1 - a) + b);
  }
  return out;
}

const built = new WeakMap<MapData, { decor: readonly WorldMapDecor[]; layer: DecorLayer | null }>();
/** The decor layer of a map, painted once and kept. */
export function decorFor(map: MapData, decor: readonly WorldMapDecor[]): DecorLayer | null {
  const b = built.get(map);
  if (b && b.decor === decor) return b.layer;
  const layer = buildDecor(map, decor);
  built.set(map, { decor, layer });
  return layer;
}
