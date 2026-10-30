// Geometry, raster and noise helpers for the real-world map pipeline (scripts/maps/build.ts). Build time only: the
// game never runs this code, it loads the baked result (src/sim/worldmaps.ts).
import { deflateSync } from 'node:zlib';

// ---------- seeded randomness ----------

/** mulberry32: small, fast, deterministic PRNG in [0, 1). */
export function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Integer hash of a string (FNV-1a), for per-map / per-layer seeds. */
export function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export type Noise2 = (x: number, y: number) => number;

/** 2D gradient noise, about -1..1, seeded. */
export function makeNoise(seed: number): Noise2 {
  const rng = makeRng(seed);
  const perm = new Uint8Array(512);
  for (let i = 0; i < 256; i++) perm[i] = i;
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const t = perm[i];
    perm[i] = perm[j];
    perm[j] = t;
  }
  for (let i = 0; i < 256; i++) perm[i + 256] = perm[i];
  const gx = new Float64Array(256);
  const gy = new Float64Array(256);
  for (let i = 0; i < 256; i++) {
    const a = rng() * Math.PI * 2;
    gx[i] = Math.cos(a);
    gy[i] = Math.sin(a);
  }
  const fade = (t: number): number => t * t * t * (t * (t * 6 - 15) + 10);
  return (x: number, y: number): number => {
    const xf = Math.floor(x);
    const yf = Math.floor(y);
    const fx = x - xf;
    const fy = y - yf;
    const X = xf & 255;
    const Y = yf & 255;
    const g = (ix: number, iy: number, dx: number, dy: number): number => {
      const h = perm[perm[ix] + iy];
      return gx[h] * dx + gy[h] * dy;
    };
    const n00 = g(X, Y, fx, fy);
    const n10 = g(X + 1, Y, fx - 1, fy);
    const n01 = g(X, Y + 1, fx, fy - 1);
    const n11 = g(X + 1, Y + 1, fx - 1, fy - 1);
    const u = fade(fx);
    const v = fade(fy);
    const a = n00 + u * (n10 - n00);
    const b = n01 + u * (n11 - n01);
    return (a + v * (b - a)) * 1.6;
  };
}

/** Fractal sum of `oct` octaves (gain 0.5), normalised to about -1..1. */
export function fbm(n: Noise2, x: number, y: number, oct: number): number {
  let s = 0;
  let a = 1;
  let norm = 0;
  for (let k = 0; k < oct; k++) {
    s += a * n(x + k * 17.31, y + k * 9.71);
    norm += a;
    a *= 0.5;
    x *= 2;
    y *= 2;
  }
  return s / norm;
}

// ---------- projections ----------

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;

export interface Projection {
  /** lon/lat in degrees -> plane coordinates in Earth radii (x east, y north) */
  fwd(lon: number, lat: number): [number, number];
  inv(x: number, y: number): [number, number];
}

export type ProjDef =
  | { type: 'eqc'; lon0: number; latTs: number }
  | { type: 'lcc'; lon0: number; lat0: number; lat1: number; lat2: number };

export function makeProjection(def: ProjDef): Projection {
  if (def.type === 'eqc') {
    const k = Math.cos(def.latTs * D2R);
    return {
      fwd: (lon, lat) => [(lon - def.lon0) * D2R * k, lat * D2R],
      inv: (x, y) => [def.lon0 + (x / k) * R2D, y * R2D],
    };
  }
  // Lambert conformal conic, spherical.
  const p1 = def.lat1 * D2R;
  const p2 = def.lat2 * D2R;
  const p0 = def.lat0 * D2R;
  const t = (p: number): number => Math.tan(Math.PI / 4 + p / 2);
  const n = Math.abs(p1 - p2) < 1e-9 ? Math.sin(p1) : Math.log(Math.cos(p1) / Math.cos(p2)) / Math.log(t(p2) / t(p1));
  const F = (Math.cos(p1) * Math.pow(t(p1), n)) / n;
  const rho0 = F / Math.pow(t(p0), n);
  return {
    fwd: (lon, lat) => {
      const rho = F / Math.pow(t(Math.max(-89.9, Math.min(89.9, lat)) * D2R), n);
      const th = n * (lon - def.lon0) * D2R;
      return [rho * Math.sin(th), rho0 - rho * Math.cos(th)];
    },
    inv: (x, y) => {
      const dy = rho0 - y;
      let rho = Math.sqrt(x * x + dy * dy);
      if (n < 0) rho = -rho;
      const th = n > 0 ? Math.atan2(x, dy) : Math.atan2(-x, -dy);
      const lat = 2 * Math.atan(Math.pow(F / rho, 1 / n)) - Math.PI / 2;
      return [def.lon0 + (th / n) * R2D, lat * R2D];
    },
  };
}

// ---------- map frame: projection + pixel box ----------

export interface LonLatBox {
  west: number;
  east: number;
  south: number;
  north: number;
}

export interface Frame {
  proj: Projection;
  /** plane-coordinate box of the map */
  xmin: number;
  ymax: number;
  /** pixels (tiles) per Earth radius */
  scale: number;
  width: number;
  height: number;
  /** lon/lat box that covers every tile (geometry is clipped to it, with a margin) */
  clip: LonLatBox;
  /** nominal km per tile */
  kmPerTile: number;
}

/** Plane-coordinate bbox of a lon/lat box's outline. */
export function projectedBox(proj: Projection, b: LonLatBox): { xmin: number; xmax: number; ymin: number; ymax: number } {
  let xmin = Infinity;
  let xmax = -Infinity;
  let ymin = Infinity;
  let ymax = -Infinity;
  const N = 200;
  for (let k = 0; k <= N; k++) {
    const f = k / N;
    const pts: [number, number][] = [
      [b.west + (b.east - b.west) * f, b.south],
      [b.west + (b.east - b.west) * f, b.north],
      [b.west, b.south + (b.north - b.south) * f],
      [b.east, b.south + (b.north - b.south) * f],
    ];
    for (const [lo, la] of pts) {
      const [x, y] = proj.fwd(lo, la);
      if (x < xmin) xmin = x;
      if (x > xmax) xmax = x;
      if (y < ymin) ymin = y;
      if (y > ymax) ymax = y;
    }
  }
  return { xmin, xmax, ymin, ymax };
}

/** Plane-coordinate bbox of a set of lon/lat points. */
export function fitBox(proj: Projection, pts: number[][]): { xmin: number; xmax: number; ymin: number; ymax: number } {
  let xmin = Infinity;
  let xmax = -Infinity;
  let ymin = Infinity;
  let ymax = -Infinity;
  for (const [lo, la] of pts) {
    const [x, y] = proj.fwd(lo, la);
    xmin = Math.min(xmin, x);
    xmax = Math.max(xmax, x);
    ymin = Math.min(ymin, y);
    ymax = Math.max(ymax, y);
  }
  return { xmin, xmax, ymin, ymax };
}

export function makeFrame(proj: Projection, frameBox: LonLatBox, scale: number, isWorld: boolean, fit?: number[][]): Frame {
  const pb = fit ? fitBox(proj, fit) : projectedBox(proj, frameBox);
  const width = Math.round((pb.xmax - pb.xmin) * scale);
  const height = Math.round((pb.ymax - pb.ymin) * scale);
  let clip: LonLatBox;
  if (isWorld) clip = { ...frameBox };
  else {
    // inverse-project the pixel box outline: geometry is clipped to its lon/lat bbox (+ margin)
    let west = Infinity;
    let east = -Infinity;
    let south = Infinity;
    let north = -Infinity;
    const N = 400;
    for (let k = 0; k <= N; k++) {
      const f = k / N;
      const pts: [number, number][] = [
        [pb.xmin + (pb.xmax - pb.xmin) * f, pb.ymin],
        [pb.xmin + (pb.xmax - pb.xmin) * f, pb.ymax],
        [pb.xmin, pb.ymin + (pb.ymax - pb.ymin) * f],
        [pb.xmax, pb.ymin + (pb.ymax - pb.ymin) * f],
      ];
      for (const [x, y] of pts) {
        const [lo, la] = proj.inv(x, y);
        west = Math.min(west, lo);
        east = Math.max(east, lo);
        south = Math.min(south, la);
        north = Math.max(north, la);
      }
    }
    clip = {
      west: Math.max(-180, west - 1),
      east: Math.min(180, east + 1),
      south: Math.max(-89.5, south - 1),
      north: Math.min(89.5, north + 1),
    };
  }
  return { proj, xmin: pb.xmin, ymax: pb.ymax, scale, width, height, clip, kmPerTile: 6371 / scale };
}

/** lon/lat -> pixel coordinates (tile centres are at integer + 0.5). */
export function toPixel(fr: Frame, lon: number, lat: number): [number, number] {
  const [x, y] = fr.proj.fwd(lon, lat);
  return [(x - fr.xmin) * fr.scale, (fr.ymax - y) * fr.scale];
}

/** Tile centre -> lon/lat. */
export function tileLonLat(fr: Frame, px: number, py: number): [number, number] {
  return fr.proj.inv(fr.xmin + (px + 0.5) / fr.scale, fr.ymax - (py + 0.5) / fr.scale);
}

// ---------- GeoJSON ----------

export type Ring = number[][]; // [lon, lat][]
export interface Feature {
  props: Record<string, unknown>;
  /** polygons: each a list of rings (outer + holes); lines: each a list with one line */
  parts: Ring[][];
  bbox: LonLatBox;
}

interface GeoJsonFeature {
  properties: Record<string, unknown> | null;
  geometry: { type: string; coordinates: unknown } | null;
}

export function parseFeatures(json: { features: GeoJsonFeature[] }): Feature[] {
  const out: Feature[] = [];
  for (const f of json.features) {
    const g = f.geometry;
    if (!g) continue;
    let parts: Ring[][];
    if (g.type === 'Polygon') parts = [g.coordinates as Ring[]];
    else if (g.type === 'MultiPolygon') parts = g.coordinates as Ring[][];
    else if (g.type === 'LineString') parts = [[g.coordinates as Ring]];
    else if (g.type === 'MultiLineString') parts = (g.coordinates as Ring[]).map((l) => [l]);
    else if (g.type === 'Point') parts = [[[g.coordinates as number[]]]];
    else continue;
    let west = Infinity;
    let east = -Infinity;
    let south = Infinity;
    let north = -Infinity;
    for (const p of parts)
      for (const r of p)
        for (const c of r) {
          if (c[0] < west) west = c[0];
          if (c[0] > east) east = c[0];
          if (c[1] < south) south = c[1];
          if (c[1] > north) north = c[1];
        }
    out.push({ props: f.properties ?? {}, parts, bbox: { west, east, south, north } });
  }
  return out;
}

export function boxesOverlap(a: LonLatBox, b: LonLatBox): boolean {
  return a.west <= b.east && a.east >= b.west && a.south <= b.north && a.north >= b.south;
}

/** Sutherland-Hodgman clip of a closed ring to a lon/lat box. */
export function clipRing(ring: Ring, b: LonLatBox): Ring {
  let pts = ring;
  const edges: [number, number, boolean][] = [
    [0, b.west, true],
    [0, b.east, false],
    [1, b.south, true],
    [1, b.north, false],
  ];
  for (const [axis, v, keepAbove] of edges) {
    if (pts.length === 0) break;
    const out: Ring = [];
    const inside = (p: number[]): boolean => (keepAbove ? p[axis] >= v : p[axis] <= v);
    for (let i = 0; i < pts.length; i++) {
      const cur = pts[i];
      const prev = pts[(i + pts.length - 1) % pts.length];
      const ci = inside(cur);
      const pi = inside(prev);
      if (ci) {
        if (!pi) out.push(intersect(prev, cur, axis, v));
        out.push(cur);
      } else if (pi) out.push(intersect(prev, cur, axis, v));
    }
    pts = out;
  }
  return pts;
}

function intersect(a: number[], b: number[], axis: number, v: number): number[] {
  const t = (v - a[axis]) / (b[axis] - a[axis]);
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}

/**
 * Clips and projects a polygon's rings into pixel space (flat [x0, y0, x1, y1, ...] per ring). Long segments (the clip
 * box's sides above all) are split first, so they follow the projection's curves instead of cutting across as chords.
 */
export function projectPolygon(fr: Frame, rings: Ring[]): Float64Array[] {
  const out: Float64Array[] = [];
  const STEP = 0.25;
  for (const r of rings) {
    const c = clipRing(r, fr.clip);
    if (c.length < 3) continue;
    const pts: number[] = [];
    for (let i = 0; i < c.length; i++) {
      const a = c[i];
      const b = c[(i + 1) % c.length];
      const k = Math.max(1, Math.ceil(Math.max(Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1])) / STEP));
      for (let q = 0; q < k; q++) {
        const [px, py] = toPixel(fr, a[0] + ((b[0] - a[0]) * q) / k, a[1] + ((b[1] - a[1]) * q) / k);
        pts.push(px, py);
      }
    }
    out.push(Float64Array.from(pts));
  }
  return out;
}

/**
 * Even-odd scanline fill of pixel-space rings: calls span(row, x0, x1) for every run of tiles whose centre lies
 * inside (x1 exclusive).
 */
export function fillRings(rings: Float64Array[], W: number, H: number, span: (row: number, x0: number, x1: number) => void): void {
  let ymin = Infinity;
  let ymax = -Infinity;
  for (const r of rings)
    for (let i = 1; i < r.length; i += 2) {
      if (r[i] < ymin) ymin = r[i];
      if (r[i] > ymax) ymax = r[i];
    }
  const r0 = Math.max(0, Math.ceil(ymin - 0.5));
  const r1 = Math.min(H - 1, Math.floor(ymax - 0.5));
  if (r1 < r0) return;
  const rows: number[][] = [];
  for (let k = r0; k <= r1; k++) rows.push([]);
  for (const r of rings) {
    const n = r.length / 2;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      let x0 = r[2 * i];
      let y0 = r[2 * i + 1];
      let x1 = r[2 * j];
      let y1 = r[2 * j + 1];
      if (y0 === y1) continue;
      if (y0 > y1) {
        [x0, x1] = [x1, x0];
        [y0, y1] = [y1, y0];
      }
      // rows whose centre yc = row + 0.5 satisfies y0 <= yc < y1
      const a = Math.max(r0, Math.ceil(y0 - 0.5));
      const b = Math.min(r1, Math.ceil(y1 - 0.5) - 1);
      const k = (x1 - x0) / (y1 - y0);
      for (let row = a; row <= b; row++) rows[row - r0].push(x0 + (row + 0.5 - y0) * k);
    }
  }
  for (let k = 0; k < rows.length; k++) {
    const xs = rows[k];
    if (xs.length < 2) continue;
    xs.sort((p, q) => p - q);
    for (let i = 0; i + 1 < xs.length; i += 2) {
      const a = Math.max(0, Math.ceil(xs[i] - 0.5));
      const b = Math.min(W, Math.ceil(xs[i + 1] - 0.5));
      if (b > a) span(r0 + k, a, b);
    }
  }
}

/** Rasterises every polygon feature that overlaps the frame, giving each one's spans to `span`. */
export function fillFeature(fr: Frame, f: Feature, span: (row: number, x0: number, x1: number) => void): void {
  if (!boxesOverlap(f.bbox, fr.clip)) return;
  for (const poly of f.parts) {
    const rings = projectPolygon(fr, poly);
    if (rings.length) fillRings(rings, fr.width, fr.height, span);
  }
}

/** Draws a polyline (lon/lat) into a mask with value v, `thick` = extra radius in tiles (0 = 1 tile wide). */
export function drawLine(fr: Frame, line: Ring, mask: Uint8Array, v: number, thick: number): void {
  const W = fr.width;
  const H = fr.height;
  let prev: [number, number] | null = null;
  for (const c of line) {
    if (c[0] < fr.clip.west || c[0] > fr.clip.east || c[1] < fr.clip.south || c[1] > fr.clip.north) {
      prev = null;
      continue;
    }
    const p = toPixel(fr, c[0], c[1]);
    if (prev) {
      const dx = p[0] - prev[0];
      const dy = p[1] - prev[1];
      const steps = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)) * 2));
      for (let s = 0; s <= steps; s++) {
        const x = Math.floor(prev[0] + (dx * s) / steps);
        const y = Math.floor(prev[1] + (dy * s) / steps);
        for (let oy = -thick; oy <= thick; oy++)
          for (let ox = -thick; ox <= thick; ox++) {
            const xx = x + ox;
            const yy = y + oy;
            if (xx >= 0 && yy >= 0 && xx < W && yy < H && ox * ox + oy * oy <= thick * thick + thick) mask[yy * W + xx] = v;
          }
      }
    }
    prev = p;
  }
}

// ---------- distance transforms ----------

/**
 * 3-4 chamfer distance (in tiles, approximate Euclidean) from every tile to the nearest tile where src[i] === target.
 * Returns Float32Array; tiles with no target anywhere get a large value.
 */
export function chamfer(src: Uint8Array, target: number, W: number, H: number): Float32Array {
  const INF = 1e9;
  const d = new Int32Array(W * H);
  for (let i = 0; i < W * H; i++) d[i] = src[i] === target ? 0 : INF;
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      let v = d[i];
      if (v === 0) continue;
      if (x > 0) v = Math.min(v, d[i - 1] + 3);
      if (y > 0) {
        v = Math.min(v, d[i - W] + 3);
        if (x > 0) v = Math.min(v, d[i - W - 1] + 4);
        if (x < W - 1) v = Math.min(v, d[i - W + 1] + 4);
      }
      d[i] = v;
    }
  for (let y = H - 1; y >= 0; y--)
    for (let x = W - 1; x >= 0; x--) {
      const i = y * W + x;
      let v = d[i];
      if (v === 0) continue;
      if (x < W - 1) v = Math.min(v, d[i + 1] + 3);
      if (y < H - 1) {
        v = Math.min(v, d[i + W] + 3);
        if (x < W - 1) v = Math.min(v, d[i + W + 1] + 4);
        if (x > 0) v = Math.min(v, d[i + W - 1] + 4);
      }
      d[i] = v;
    }
  const out = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) out[i] = d[i] / 3;
  return out;
}

/** Labels 4-connected components of tiles where mask[i] === v; returns labels (0 = not v) and their sizes. */
export function components(mask: Uint8Array, v: number, W: number, H: number): { label: Int32Array; sizes: number[] } {
  const n = W * H;
  const label = new Int32Array(n);
  const sizes: number[] = [0];
  const q = new Int32Array(n);
  for (let s = 0; s < n; s++) {
    if (mask[s] !== v || label[s]) continue;
    const id = sizes.length;
    let head = 0;
    let tail = 0;
    q[tail++] = s;
    label[s] = id;
    while (head < tail) {
      const i = q[head++];
      const x = i % W;
      if (x > 0 && mask[i - 1] === v && !label[i - 1]) (label[i - 1] = id), (q[tail++] = i - 1);
      if (x < W - 1 && mask[i + 1] === v && !label[i + 1]) (label[i + 1] = id), (q[tail++] = i + 1);
      if (i >= W && mask[i - W] === v && !label[i - W]) (label[i - W] = id), (q[tail++] = i - W);
      if (i < n - W && mask[i + W] === v && !label[i + W]) (label[i + W] = id), (q[tail++] = i + W);
    }
    sizes.push(tail);
  }
  return { label, sizes };
}

// ---------- PNG ----------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Encodes an RGB image (3 bytes per pixel) as PNG. */
export function encodePng(rgb: Uint8Array, W: number, H: number): Uint8Array {
  const raw = new Uint8Array((W * 3 + 1) * H);
  for (let y = 0; y < H; y++) {
    raw[y * (W * 3 + 1)] = 0;
    raw.set(rgb.subarray(y * W * 3, (y + 1) * W * 3), y * (W * 3 + 1) + 1);
  }
  const idat = deflateSync(raw, { level: 6 });
  const chunks: Uint8Array[] = [];
  const chunk = (type: string, data: Uint8Array): void => {
    const b = new Uint8Array(12 + data.length);
    const dv = new DataView(b.buffer);
    dv.setUint32(0, data.length);
    for (let i = 0; i < 4; i++) b[4 + i] = type.charCodeAt(i);
    b.set(data, 8);
    dv.setUint32(8 + data.length, crc32(b.subarray(4, 8 + data.length)));
    chunks.push(b);
  };
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, W);
  dv.setUint32(4, H);
  ihdr[8] = 8;
  ihdr[9] = 2;
  chunk('IHDR', ihdr);
  chunk('IDAT', new Uint8Array(idat));
  chunk('IEND', new Uint8Array(0));
  const sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  let len = sig.length;
  for (const c of chunks) len += c.length;
  const out = new Uint8Array(len);
  out.set(sig, 0);
  let o = sig.length;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}
