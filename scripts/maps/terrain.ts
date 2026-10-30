// Turns Natural Earth layers into a Borderfall tile map for one frame: land / water, continental shelf, terrain from
// physical regions (mountain ranges, plateaus, deserts, wetlands, glaciers, tundra), peaks and climate belts, then
// cleanup (no speckle) and resources. Everything is deterministic for a given map id.
import { EXTRA_REGIONS, OIL_REGIONS } from './extra';
import type { ExtraKind } from './extra';
import { chamfer, components, drawLine, fbm, fillFeature, fillRings, hashString, makeNoise, makeRng, projectPolygon } from './lib';
import type { Feature, Frame } from './lib';

export interface Layers {
  land: Feature[];
  minorIslands: Feature[];
  /** open water (natural lakes and salt lakes that hold water) */
  lakes: Feature[];
  /** dammed lakes: only the wide ones become water */
  reservoirs: Feature[];
  /** dry salt pans: land (desert), never water */
  dryLakes: Feature[];
  regions: Feature[];
  glaciers: Feature[];
  rivers: Feature[];
  peaks: Feature[];
  deep: Feature[];
}

const T_DEEP = 0;
const T_SHALLOW = 1;
const T_PLAINS = 2;
const T_FOREST = 3;
const T_HILLS = 4;
const T_MOUNTAINS = 5;
const T_DESERT = 6;
const T_SWAMP = 7;
const T_TUNDRA = 8;
const R_IRON = 1;
const R_OIL = 2;
const R_FERTILE = 3;

const MOUNTAIN_R = 0.62;
const HILL_R = 0.42;
/** Forest needs at least this moisture (absolute, the same on every map). */
const FOREST_M = 0.6;
/** Default cap on the forest share of plains + forest land (a map of one wet region would otherwise be one forest). */
const FOREST_MAX = 0.48;
/** Reservoirs narrower than about 2 x this many tiles stay land (dammed rivers would read as cuts through the land). */
const RESERVOIR_MIN_HALF_WIDTH = 3;
/** Oil on desert / swamp / tundra: at most this share of those tiles (the rest of the oil goes to inland plains). */
const OIL_MAX_SHARE = 0.025;
/** Changtang, the cold high plateau of north-western Tibet (rough lon / lat outline): the only "cold plateau" tundra. */
const CHANGTANG = [[79.6, 34.6], [80.6, 35.6], [82.4, 35.7], [84.6, 35.9], [86.8, 35.6], [89.0, 35.8], [90.8, 35.2], [91.6, 34.2], [90.2, 33.4], [88.4, 32.6], [86.2, 32.3], [84.0, 31.9], [82.0, 32.2], [80.4, 33.0]];
/** Deltas that are real wetlands stay swamp; the other deltas are farmland (fertile plains). */
const WET_DELTAS = /Danube|Niger/;

export interface TerrainOptions {
  /** cap on the forest share of plains + forest land (default FOREST_MAX) */
  forestMax?: number;
}

export interface BuiltTerrain {
  terrain: Uint8Array;
  resource: Uint8Array;
  landTiles: number;
  /** moisture of the plains / forest tiles (for tools) */
  moist: Float32Array;
}

function prop(f: Feature, k: string): string {
  const v = f.props[k] ?? f.props[k.toLowerCase()];
  return typeof v === 'string' ? v : '';
}
function propNum(f: Feature, k: string): number {
  const v = f.props[k] ?? f.props[k.toLowerCase()];
  return typeof v === 'number' ? v : Number(v ?? NaN);
}

/** Linear interpolation in a sorted [x, y] table. */
function table(tab: number[][], x: number): number {
  if (x <= tab[0][0]) return tab[0][1];
  for (let i = 1; i < tab.length; i++) {
    if (x <= tab[i][0]) {
      const [x0, y0] = tab[i - 1];
      const [x1, y1] = tab[i];
      return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
    }
  }
  return tab[tab.length - 1][1];
}

// Northern tree line by longitude (degrees north): tundra above it. Rough climate geography, assumed.
const TREELINE: number[][] = [
  [-180, 65],
  [-165, 64],
  [-145, 67.5],
  [-120, 66],
  [-100, 61],
  [-90, 58.5],
  [-75, 57.5],
  [-62, 57],
  [-55, 58],
  [-50, 59],
  [-20, 59],
  [-16, 64],
  [-10, 70],
  [5, 70],
  [30, 69],
  [45, 67.5],
  [60, 66.5],
  [80, 67],
  [100, 70],
  [130, 70],
  [150, 66],
  [165, 61],
  [180, 64],
];

// Moisture by |latitude|: equatorial wet belt, subtropical dry belt, temperate, boreal. Assumed climate shape.
const BELT: number[][] = [
  [0, 0.8],
  [8, 0.76],
  [14, 0.5],
  [20, 0.3],
  [28, 0.27],
  [35, 0.4],
  [42, 0.47],
  [50, 0.5],
  [56, 0.6],
  [62, 0.68],
  [68, 0.55],
  [75, 0.4],
];

/** Fills a mask (value v) from a list of features (polygons). */
function fillMask(fr: Frame, feats: Feature[], mask: Uint8Array, v: number): void {
  const W = fr.width;
  for (const f of feats) fillFeature(fr, f, (row, x0, x1) => mask.fill(v, row * W + x0, row * W + x1));
}

function fillLonLatPoly(fr: Frame, poly: number[][], mask: Uint8Array, v: number): void {
  const W = fr.width;
  const rings = projectPolygon(fr, [poly]);
  if (rings.length) fillRings(rings, fr.width, fr.height, (row, x0, x1) => mask.fill(v, row * W + x0, row * W + x1));
}

/** Signed distance in tiles (> 0 inside the mask, < 0 outside). */
function signedDist(mask: Uint8Array, W: number, H: number): Float32Array {
  const dOut = chamfer(mask, 1, W, H); // outside: distance to the mask
  const dIn = chamfer(mask, 0, W, H); // inside: distance to the outside
  const out = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) out[i] = mask[i] ? dIn[i] : -dOut[i];
  return out;
}

export function buildTerrain(fr: Frame, L: Layers, id: string, opts: TerrainOptions = {}): BuiltTerrain {
  const W = fr.width;
  const H = fr.height;
  const n = W * H;
  const S = Math.min(W, H);
  const km = fr.kmPerTile;
  const seed = hashString(id);

  // ---------- land / water ----------
  const land = new Uint8Array(n);
  fillMask(fr, L.land, land, 1);
  fillMask(fr, L.minorIslands, land, 1);
  fillMask(fr, L.lakes, land, 0);
  // reservoirs: only the wide ones (a component whose widest point is at least 2 x RESERVOIR_MIN_HALF_WIDTH tiles)
  {
    const resM = new Uint8Array(n);
    fillMask(fr, L.reservoirs, resM, 1);
    const half = chamfer(resM, 0, W, H);
    const { label, sizes } = components(resM, 1, W, H);
    const widest = new Float32Array(sizes.length);
    for (let i = 0; i < n; i++) if (resM[i] && half[i] > widest[label[i]]) widest[label[i]] = half[i];
    for (let i = 0; i < n; i++) if (resM[i] && widest[label[i]] >= RESERVOIR_MIN_HALF_WIDTH) land[i] = 0;
  }
  // drop islets and ponds that would only be speckle
  const minIsland = Math.max(6, Math.round(S / 160));
  const minLake = Math.max(30, Math.round((S * S) / 40000));
  {
    const { label, sizes } = components(land, 1, W, H);
    for (let i = 0; i < n; i++) if (land[i] && sizes[label[i]] < minIsland) land[i] = 0;
    const wc = components(land, 0, W, H);
    for (let i = 0; i < n; i++) if (!land[i] && wc.sizes[wc.label[i]] < minLake) land[i] = 1;
  }
  // one pass of smoothing for one-tile notches and spurs (only flips tiles with 3+ of 4 neighbours the other way)
  {
    const src = land.slice();
    for (let y = 1; y < H - 1; y++)
      for (let x = 1; x < W - 1; x++) {
        const i = y * W + x;
        const s4 = src[i - 1] + src[i + 1] + src[i - W] + src[i + W];
        if (src[i] && s4 === 0) land[i] = 0;
        else if (!src[i] && s4 === 4) land[i] = 1;
      }
  }

  // ---------- per-tile lat / lon ----------
  const lat = new Float32Array(n);
  const lon = new Float32Array(n);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const [lo, la] = fr.proj.inv(fr.xmin + (x + 0.5) / fr.scale, fr.ymax - (y + 0.5) / fr.scale);
      lat[y * W + x] = la;
      lon[y * W + x] = lo;
    }

  const distW = chamfer(land, 0, W, H); // land tile -> nearest water (tiles)

  // noise fields (tile space). Wavelengths: a fraction of the map, but no larger than a fixed distance on Earth.
  const nA = makeNoise(seed ^ 0x1234);
  const nB = makeNoise(seed ^ 0x5678);
  const nC = makeNoise(seed ^ 0x9abc);
  const nD = makeNoise(seed ^ 0xdef0);
  const big = Math.min(S / 3, 1400 / km);
  const mid = Math.max(6, Math.min(S / 12, 350 / km));
  const fine = Math.max(4, Math.min(S / 40, 110 / km));
  const edgeNoise = (i: number, k: number): number => {
    const x = i % W;
    const y = (i - x) / W;
    return fbm(k === 0 ? nC : nD, x / mid, y / mid, 3);
  };

  // ---------- ruggedness ----------
  const rug = new Float32Array(n);
  // bounding box of the tiles last written by fillTmp (so each region only costs its own area)
  let bx0 = 0;
  let by0 = 0;
  let bx1 = -1;
  let by1 = -1;
  let bcount = 0;
  const tmp = new Uint8Array(n);
  const fillTmp = (draw: (span: (row: number, x0: number, x1: number) => void) => void): void => {
    if (bx1 >= 0) for (let y = by0; y <= by1; y++) tmp.fill(0, y * W + bx0, y * W + bx1 + 1);
    bx0 = W;
    by0 = H;
    bx1 = -1;
    by1 = -1;
    bcount = 0;
    draw((row, a, b) => {
      tmp.fill(1, row * W + a, row * W + b);
      bcount += b - a;
      if (a < bx0) bx0 = a;
      if (b - 1 > bx1) bx1 = b - 1;
      if (row < by0) by0 = row;
      if (row > by1) by1 = row;
    });
  };
  const stamp = (mask: Uint8Array, top: number, base: number, footBand: number): void => {
    if (bx1 < 0) return;
    let x0 = bx0;
    let y0 = by0;
    let x1 = bx1;
    let y1 = by1;
    const pad = Math.ceil(footBand) + 2;
    x0 = Math.max(0, x0 - pad);
    y0 = Math.max(0, y0 - pad);
    x1 = Math.min(W - 1, x1 + pad);
    y1 = Math.min(H - 1, y1 + pad);
    const bw = x1 - x0 + 1;
    const bh = y1 - y0 + 1;
    const sub = new Uint8Array(bw * bh);
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) sub[(y - y0) * bw + (x - x0)] = mask[y * W + x];
    const dIn = chamfer(sub, 0, bw, bh);
    const dOut = chamfer(sub, 1, bw, bh);
    let dmax = 0;
    for (let k = 0; k < bw * bh; k++) if (sub[k] && dIn[k] > dmax) dmax = dIn[k];
    const core = 0.45 * dmax + 1;
    const fb = Math.max(1.5, footBand);
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++) {
        const k = (y - y0) * bw + (x - x0);
        let v: number;
        if (sub[k]) v = base + (top - base) * Math.min(1, dIn[k] / core);
        else if (dOut[k] < fb) v = base * 0.95 * (1 - dOut[k] / fb);
        else continue;
        const i = y * W + x;
        if (v > rug[i]) rug[i] = v;
      }
  };

  for (const f of L.regions) {
    const cla = prop(f, 'FEATURECLA');
    const name = prop(f, 'NAME');
    const sr = propNum(f, 'SCALERANK');
    let top = 0;
    let base = 0;
    let foot = 0;
    if (cla === 'Range/mtn') {
      top = sr <= 2 ? 0.92 : sr === 3 ? 0.84 : sr === 4 ? 0.76 : 0.66;
      // old, worn-down ranges: mostly hills with a few high ridges
      if (name === 'ATLAS MOUNTAINS') top = 0.6; // the broad outline (high plateaus too); Haut Atlas etc. are separate
      if (/APPALACHIAN|GREAT DIVIDING|URAL|Serra|Ghats|EASTERN GHATS|Satpura|Vindhya|CRYSTAL|GUIANA|Muchinga|MITUMBA/i.test(name)) top = 0.66;
      base = 0.45;
      foot = 0.6;
    } else if (cla === 'Plateau') {
      if (name === 'PLATEAU OF TIBET') (top = 0.5), (base = 0.4), (foot = 0.2);
      else if (/ALTIPLANO|ALTI-PLANICIE|COLORADO|ETHIOP/i.test(name)) (top = 0.46), (base = 0.38), (foot = 0.2);
      else (top = 0.36), (base = 0.32), (foot = 0.1);
    } else if (cla === 'Foothills' && name === 'PIEDMONT') (top = 0.4), (base = 0.36), (foot = 0.2);
    else continue;
    if (!f.bbox || f.bbox.east < fr.clip.west || f.bbox.west > fr.clip.east || f.bbox.south > fr.clip.north || f.bbox.north < fr.clip.south) continue;
    fillTmp((span) => fillFeature(fr, f, span));
    if (bcount === 0) continue;
    // foothill band in tiles: a share of the range's own size, at least ~25 km
    stamp(tmp, top, base, Math.max(25 / km, Math.sqrt(bcount) * 0.08) * (foot / 0.6));
  }
  for (const ex of EXTRA_REGIONS) {
    if (ex.kind !== 'mountains' && ex.kind !== 'hills' && ex.kind !== 'highland') continue;
    fillTmp((span) => {
      const rings = projectPolygon(fr, [ex.poly]);
      if (rings.length) fillRings(rings, W, H, span);
    });
    if (bcount === 0) continue;
    const top = ex.kind === 'mountains' ? (ex.strength ?? 0.82) : ex.kind === 'highland' ? 0.62 : 0.5;
    stamp(tmp, top, 0.44, Math.max(15 / km, Math.sqrt(bcount) * 0.06));
  }
  // mountain glaciers (Alps, Himalaya, Andes, ...) mark high ground
  for (const f of L.glaciers) {
    const midLat = (f.bbox.south + f.bbox.north) / 2;
    if (Math.abs(midLat) >= 55) continue;
    fillTmp((span) => fillFeature(fr, f, span));
    if (bcount === 0) continue;
    stamp(tmp, 0.9, 0.7, Math.max(10 / km, 1.5));
  }
  // peaks: a cone whose radius grows with height
  for (const f of L.peaks) {
    const cla = prop(f, 'featurecla');
    if (cla !== 'mountain') continue;
    const elev = propNum(f, 'elevation');
    if (!(elev >= 500)) continue;
    const c = f.parts[0][0][0];
    if (c[0] < fr.clip.west || c[0] > fr.clip.east || c[1] < fr.clip.south || c[1] > fr.clip.north) continue;
    const p = fr.proj.fwd(c[0], c[1]);
    const px = (p[0] - fr.xmin) * fr.scale;
    const py = (fr.ymax - p[1]) * fr.scale;
    const amp = elev >= 3000 ? 0.88 : elev >= 2000 ? 0.8 : elev >= 1200 ? 0.72 : elev >= 800 ? 0.6 : 0.5;
    const R = Math.max(3, (30 + elev / 30) / km);
    const xa = Math.max(0, Math.floor(px - R));
    const xb = Math.min(W - 1, Math.ceil(px + R));
    const ya = Math.max(0, Math.floor(py - R));
    const yb = Math.min(H - 1, Math.ceil(py + R));
    for (let y = ya; y <= yb; y++)
      for (let x = xa; x <= xb; x++) {
        const d = Math.hypot(x + 0.5 - px, y + 0.5 - py) / R;
        if (d >= 1) continue;
        const v = amp * (1 - d);
        const i = y * W + x;
        if (v > rug[i]) rug[i] = v;
      }
  }
  // domain warp: every region edge (polygon sides, peak cones) becomes ragged and natural-looking
  const nWx = makeNoise(seed ^ 0x2468);
  const nWy = makeNoise(seed ^ 0x1357);
  const warpA = Math.max(3, 0.4 * mid);
  const warpIdx = new Int32Array(n);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const u = x / mid;
      const v = y / mid;
      const wx = Math.round(x + warpA * fbm(nWx, u, v, 3));
      const wy = Math.round(y + warpA * fbm(nWy, u + 5.3, v + 1.7, 3));
      warpIdx[y * W + x] = Math.min(H - 1, Math.max(0, wy)) * W + Math.min(W - 1, Math.max(0, wx));
    }
  const warped = (a: Float32Array): Float32Array => {
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) out[i] = a[warpIdx[i]];
    return out;
  };
  rug.set(warped(rug));
  // texture: valleys and spurs inside the rugged areas (no new hills in flat land)
  // In high ranges the noise is stronger and ridged, so they get valleys and passes instead of one solid block.
  for (let i = 0; i < n; i++) {
    const r = rug[i];
    if (r < 0.15 || !land[i]) continue;
    const x = i % W;
    const y = (i - x) / W;
    const t = 0.13 * fbm(nA, x / mid, y / mid, 3) + 0.07 * fbm(nB, x / fine, y / fine, 2);
    let v = r + t * Math.min(1, r / 0.35);
    if (r > 0.6) {
      const ridge = Math.abs(fbm(nD, x / mid + 3.3, y / mid + 8.1, 3));
      if (ridge < 0.14) v -= (0.14 - ridge) * 3.2 * Math.min(1, (r - 0.6) / 0.15);
    }
    rug[i] = v;
  }

  // ---------- region masks ----------
  const desertM = new Uint8Array(n);
  const swampM = new Uint8Array(n);
  const tundraM = new Uint8Array(n);
  const steppeM = new Uint8Array(n);
  const wetM = new Uint8Array(n);
  const woodsM = new Uint8Array(n);
  const coldM = new Uint8Array(n);
  const openM = new Uint8Array(n);
  const deltaM = new Uint8Array(n);
  for (const f of L.regions) {
    const cla = prop(f, 'FEATURECLA');
    const name = prop(f, 'NAME');
    let m: Uint8Array | null = null;
    if (cla === 'Desert' && name !== 'PUNJAB' && name !== 'CAATINGAS') m = desertM;
    else if (cla === 'Basin' && /GREAT BASIN|TARIM|Junggar|Qaidam/.test(name)) m = desertM;
    else if ((cla === 'Depression' || cla === 'Geoarea') && /Bodélé|Aoukâr|Ogaden|BALUCHISTAN/.test(name)) m = desertM;
    else if (cla === 'Wetlands' || name === 'SUDD' || (cla === 'Delta' && WET_DELTAS.test(name))) m = swampM;
    else if (cla === 'Delta') {
      fillMask(fr, [f], deltaM, 1);
      m = openM;
    }
    else if (cla === 'Tundra' && name !== 'CANADIAN SHIELD') m = tundraM;
    else if (cla === 'Plain' && !/NORTHERN EUROPEAN|COASTAL PLAIN|CENTRAL LOWLAND|NORTH SLOPE|LES LAURENTIDES|Baltic/.test(name)) m = steppeM;
    else if (cla === 'Basin' && /AMAZON|CONGO/.test(name)) m = wetM;
    else if (cla === 'Foothills' && /SELVAS|YUNGAS/.test(name)) m = wetM;
    else if (cla === 'Plateau' && name === 'PLATEAU OF TIBET') m = coldM;
    if (m) fillMask(fr, [f], m, 1);
  }
  fillMask(fr, L.glaciers.filter((f) => Math.abs((f.bbox.south + f.bbox.north) / 2) >= 55), tundraM, 1);
  fillMask(fr, L.dryLakes, desertM, 1); // salt pans
  // the Tibet plateau polygon reaches far east (104 E); only its cold high north-west (Changtang) is tundra
  {
    const ct = new Uint8Array(n);
    fillLonLatPoly(fr, CHANGTANG, ct, 1);
    for (let i = 0; i < n; i++) if (coldM[i] && !ct[i]) coldM[i] = 0;
  }
  const kindMask: Partial<Record<ExtraKind, Uint8Array>> = {
    desert: desertM,
    swamp: swampM,
    steppe: steppeM,
    wet: wetM,
    woods: woodsM,
    open: openM,
    tundra: tundraM,
    cold: coldM,
  };
  for (const ex of EXTRA_REGIONS) {
    const m = kindMask[ex.kind];
    if (m) fillLonLatPoly(fr, ex.poly, m, 1);
  }
  const band = (k: number): number => Math.max(3, k / km);
  const desertD = warped(signedDist(desertM, W, H));
  const swampD = warped(signedDist(swampM, W, H));
  const steppeD = warped(signedDist(steppeM, W, H));
  const wetD = warped(signedDist(wetM, W, H));
  const woodsD = warped(signedDist(woodsM, W, H));
  const tundraD = warped(signedDist(tundraM, W, H));
  const coldD = warped(signedDist(coldM, W, H));
  const openD = warped(signedDist(openM, W, H));

  // major rivers: fertile land along them, and green valleys through deserts (Nile, Tigris, Euphrates, Indus, ...)
  const rivers = new Uint8Array(n);
  const bigRivers = new Uint8Array(n);
  for (const f of L.rivers) {
    const sr = propNum(f, 'scalerank');
    if (!(sr <= 6)) continue;
    if (f.bbox.east < fr.clip.west || f.bbox.west > fr.clip.east || f.bbox.south > fr.clip.north || f.bbox.north < fr.clip.south) continue;
    for (const p of f.parts) {
      drawLine(fr, p[0], rivers, 1, 0);
      if (sr <= 3) drawLine(fr, p[0], bigRivers, 1, 0);
    }
  }
  const distR = chamfer(rivers, 1, W, H);
  const distBig = chamfer(bigRivers, 1, W, H);
  const valley = Math.max(1, 12 / km);

  // ---------- terrain ----------
  const terrain = new Uint8Array(n);
  const moist = new Float32Array(n);
  const soft = (d: number, b: number): number => Math.max(-1, Math.min(1, d / b)); // -1..1 across the edge
  for (let i = 0; i < n; i++) {
    if (!land[i]) {
      terrain[i] = T_DEEP;
      continue;
    }
    const r = rug[i];
    if (r >= MOUNTAIN_R) {
      terrain[i] = T_MOUNTAINS;
      continue;
    }
    const e0 = edgeNoise(i, 0);
    const e1 = edgeNoise(i, 1);
    const la = lat[i];
    const alat = Math.abs(la);
    // deserts: region polygons with ragged edges
    const des = soft(desertD[i], band(120)) + 0.55 * e0;
    // cold high plateau: tundra even where the plateau is hilly
    if (soft(coldD[i], band(80)) + 0.45 * e1 > 0.2) {
      terrain[i] = T_TUNDRA;
      continue;
    }
    if (r >= HILL_R) {
      terrain[i] = T_HILLS;
      continue;
    }
    if (des > 0.15 && distBig[i] > valley) {
      terrain[i] = T_DESERT;
      continue;
    }
    // tundra: north of the tree line, glaciers, cold plateau, subantarctic
    const tl = la >= 0 ? table(TREELINE, lon[i]) : 999;
    const tun = Math.max(soft(tundraD[i], band(60)), (la - tl) / 2.5, (-la - 52) / 2);
    if (tun + 0.45 * e1 > 0.2) {
      terrain[i] = T_TUNDRA;
      continue;
    }
    const sw = Math.min(0.6, soft(swampD[i], band(60))) + 0.6 * e1;
    if (sw > 0.35) {
      terrain[i] = T_SWAMP;
      continue;
    }
    const x = i % W;
    const y = (i - x) / W;
    const dkm = distW[i] * km;
    let m = table(BELT, alat);
    m += 0.12 * Math.max(0, 1 - dkm / 600);
    m -= 0.12 * Math.min(1, Math.max(0, dkm - 900) / 1500);
    m += 0.45 * Math.max(0, soft(wetD[i], band(80)));
    m += 0.15 * Math.max(0, soft(woodsD[i], band(150)) + 0.5);
    m -= 0.45 * Math.min(1, Math.max(0, 0.5 + 0.5 * soft(openD[i], band(20)))); // farmland / treeless: never forest
    m -= 0.3 * Math.max(0, soft(steppeD[i], band(150)) + 0.3);
    m -= 0.25 * Math.max(0, soft(desertD[i], band(500)) + 1) * 0.5; // drier around deserts
    m += 0.24 * fbm(nB, x / big, y / big, 3) + 0.14 * fbm(nC, x / mid + 7.7, y / mid + 3.1, 3);
    moist[i] = m;
    terrain[i] = T_PLAINS;
  }
  // Forest where it is wet enough (m > FOREST_M, the same everywhere), but never more than the map's cap of the plains /
  // forest land (a map of one temperate or boreal region would otherwise be one forest).
  {
    const cap = opts.forestMax ?? FOREST_MAX;
    const vals: number[] = [];
    for (let i = 0; i < n; i += 7) if (land[i] && terrain[i] === T_PLAINS) vals.push(moist[i]);
    vals.sort((a, b) => a - b);
    const q = vals.length ? vals[Math.min(vals.length - 1, Math.floor(vals.length * (1 - cap)))] : FOREST_M;
    const thr = Math.max(FOREST_M, q);
    for (let i = 0; i < n; i++) if (land[i] && terrain[i] === T_PLAINS && moist[i] > thr) terrain[i] = T_FOREST;
  }

  // ---------- cleanup ----------
  majorityFilter(terrain, land, W, H, 1);
  mergeSmallRegions(terrain, land, W, H, Math.max(12, Math.round((S * S) / 16000)));
  fixSpeckle(terrain, land, W, H, 2);

  // ---------- water: continental shelf as shallow water (and always a thin coastal band) ----------
  const deepM = new Uint8Array(n);
  fillMask(fr, L.deep, deepM, 1);
  const dL = chamfer(land, 1, W, H);
  const ring = S >= 1200 ? 3 : 2;
  const shelfMax = Math.max(ring + 2, Math.min(14, 160 / km));
  for (let i = 0; i < n; i++) {
    if (land[i]) continue;
    terrain[i] = dL[i] <= ring || (!deepM[i] && dL[i] <= shelfMax) ? T_SHALLOW : T_DEEP;
  }
  // lakes: all shallow
  {
    const wc = components(land, 0, W, H);
    let ocean = 0;
    let best = 0;
    for (let k = 1; k < wc.sizes.length; k++) if (wc.sizes[k] > best) (best = wc.sizes[k]), (ocean = k);
    for (let i = 0; i < n; i++) if (!land[i] && wc.label[i] !== ocean && wc.sizes[wc.label[i]] < best / 50) terrain[i] = T_SHALLOW;
  }

  let landTiles = 0;
  for (let i = 0; i < n; i++) if (land[i]) landTiles++;

  // ---------- resources ----------

  const oilZone = new Uint8Array(n);
  for (const poly of OIL_REGIONS) fillLonLatPoly(fr, poly, oilZone, 1);
  const kindA = new Uint8Array(n);
  const kindB = new Uint8Array(n);
  const kindC = new Uint8Array(n); // plains: oil that does not fit on desert / swamp / tundra (placed last, on free tiles)
  const kindD = new Uint8Array(n); // farmland deltas: extra fertile land
  const fertileCoast = Math.max(8, S * 0.05);
  const fertileRiver = Math.max(4, Math.min(S * 0.03, 60 / km));
  for (let i = 0; i < n; i++) {
    if (!land[i]) continue;
    const t = terrain[i];
    if (t === T_HILLS || t === T_MOUNTAINS) kindA[i] = R_IRON;
    else if (t === T_DESERT || t === T_SWAMP || t === T_TUNDRA) kindA[i] = R_OIL;
    else if (t === T_PLAINS && (distW[i] <= fertileCoast || distR[i] <= fertileRiver)) kindA[i] = R_FERTILE;
    if (oilZone[i] && t !== T_MOUNTAINS) kindB[i] = R_OIL;
    if (t === T_PLAINS) kindC[i] = R_OIL;
    if (deltaM[i] && t === T_PLAINS) kindD[i] = R_FERTILE;
  }
  const resource = new Uint8Array(n);
  const rng = makeRng(seed ^ 0x51ed);
  let zone = 0;
  let deltas = 0;
  let oilLand = 0;
  for (let i = 0; i < n; i++) {
    zone += kindB[i] ? 1 : 0;
    deltas += kindD[i] ? 1 : 0;
    oilLand += kindA[i] === R_OIL ? 1 : 0;
  }
  const oilTotal = Math.round(landTiles * 0.007);
  const oilOnLand = Math.min(oilTotal, Math.round(oilLand * OIL_MAX_SHARE));
  placeResources(resource, W, H, rng, kindB, [0, 0, Math.round(Math.min(landTiles * 0.004, zone * 0.06)), 0], S);
  placeResources(resource, W, H, rng, kindD, [0, 0, 0, Math.round(Math.min(landTiles * 0.003, deltas * 0.08))], S);
  placeResources(resource, W, H, rng, kindA, [0, Math.round(landTiles * 0.015), oilOnLand, Math.round(landTiles * 0.03)], S);
  placeResources(resource, W, H, rng, kindC, [0, 0, oilTotal - oilOnLand, 0], S);

  return { terrain, resource, landTiles, moist };
}

// ---------- cleanup filters (same rules as the procedural generator) ----------

const TERRAIN_COUNT = 9;

function majorityFilter(terrain: Uint8Array, land: Uint8Array, w: number, h: number, passes: number): void {
  const cnt = new Int32Array(TERRAIN_COUNT);
  const offs = [-w - 1, -w, -w + 1, -1, 1, w - 1, w, w + 1];
  for (let p = 0; p < passes; p++) {
    const src = terrain.slice();
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        if (!land[i]) continue;
        const t = src[i];
        if ((src[i - 1] === t ? 1 : 0) + (src[i + 1] === t ? 1 : 0) + (src[i - w] === t ? 1 : 0) + (src[i + w] === t ? 1 : 0) >= 3) continue;
        cnt.fill(0);
        for (let k = 0; k < 8; k++) {
          const j = i + offs[k];
          if (land[j]) cnt[src[j]]++;
        }
        if (cnt[t] >= 3) continue;
        let best = t;
        let bc = 3;
        for (let q = 2; q < TERRAIN_COUNT; q++) {
          if (q !== t && cnt[q] > bc) {
            bc = cnt[q];
            best = q;
          }
        }
        terrain[i] = best;
      }
    }
  }
}

function mergeSmallRegions(terrain: Uint8Array, land: Uint8Array, w: number, h: number, minSize: number): void {
  const n = w * h;
  const seen = new Uint8Array(n);
  const buf = new Int32Array(n);
  const cnt = new Int32Array(TERRAIN_COUNT);
  for (let s = 0; s < n; s++) {
    if (seen[s] || !land[s]) continue;
    const t = terrain[s];
    let head = 0;
    let tail = 0;
    buf[tail++] = s;
    seen[s] = 1;
    cnt.fill(0);
    while (head < tail) {
      const i = buf[head++];
      const x = i % w;
      const nbs = [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, i >= w ? i - w : -1, i < n - w ? i + w : -1];
      for (const j of nbs) {
        if (j < 0 || !land[j]) continue;
        const tj = terrain[j];
        if (tj === t) {
          if (!seen[j]) {
            seen[j] = 1;
            buf[tail++] = j;
          }
        } else cnt[tj]++;
      }
    }
    if (tail >= minSize) continue;
    let best = -1;
    let bc = 0;
    for (let q = 2; q < TERRAIN_COUNT; q++) {
      if (cnt[q] > bc) {
        bc = cnt[q];
        best = q;
      }
    }
    if (best < 0) continue;
    for (let k = 0; k < tail; k++) terrain[buf[k]] = best;
  }
}

function fixSpeckle(terrain: Uint8Array, land: Uint8Array, w: number, h: number, passes: number): void {
  const nb = [0, 0, 0, 0];
  for (let p = 0; p < passes; p++) {
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        if (!land[i]) continue;
        const t = terrain[i];
        nb[0] = terrain[i - 1];
        nb[1] = terrain[i + 1];
        nb[2] = terrain[i - w];
        nb[3] = terrain[i + w];
        if ((nb[0] === t ? 1 : 0) + (nb[1] === t ? 1 : 0) + (nb[2] === t ? 1 : 0) + (nb[3] === t ? 1 : 0) >= 2) continue;
        let best = -1;
        let bc = 1;
        for (let k = 0; k < 4; k++) {
          const q = nb[k];
          if (q <= 1 || q === t) continue;
          let cq = 0;
          for (let m = 0; m < 4; m++) if (nb[m] === q) cq++;
          if (cq > bc) {
            bc = cq;
            best = q;
          }
        }
        if (best >= 0) terrain[i] = best;
      }
    }
  }
}

/** Resource deposits of 3-12 tiles in fields of 2-5, seeded on a grid so every suitable region gets some. */
function placeResources(resource: Uint8Array, w: number, h: number, rng: () => number, kind: Uint8Array, targets: number[], S: number): void {
  const rint = (k: number): number => Math.floor(rng() * k);
  const g = Math.max(20, Math.round(S / 16));
  const fieldR = Math.max(4, Math.round(S * 0.012));
  const gw = Math.ceil(w / g);
  const gh = Math.ceil(h / g);
  const nb = (i: number): number => {
    const x = i % w;
    const d = rint(4);
    if (d === 0) return x > 0 ? i - 1 : i;
    if (d === 1) return x < w - 1 ? i + 1 : i;
    if (d === 2) return i >= w ? i - w : i;
    return i < w * h - w ? i + w : i;
  };
  for (let res = 1; res < targets.length; res++) {
    const target = targets[res];
    if (target <= 0) continue;
    const cells: number[][] = [];
    for (let c = 0; c < gw * gh; c++) cells.push([]);
    let total = 0;
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (kind[i] === res && resource[i] === 0) {
          cells[Math.floor(y / g) * gw + Math.floor(x / g)].push(i);
          total++;
        }
      }
    if (total === 0) continue;
    const density = Math.max(1, Math.round(target / (7.5 * 3.5))) / total;
    let placed = 0;
    const deposit = (seedTile: number): void => {
      if (resource[seedTile] !== 0 || kind[seedTile] !== res) return;
      const size = Math.min(target - placed, 3 + rint(10));
      const cluster = [seedTile];
      resource[seedTile] = res;
      placed++;
      for (let grow = 0; cluster.length < size && grow < size * 8; grow++) {
        const j = nb(cluster[rint(cluster.length)]);
        if (resource[j] !== 0 || kind[j] !== res) continue;
        resource[j] = res;
        cluster.push(j);
        placed++;
      }
    };
    for (const list of cells) {
      if (list.length === 0) continue;
      const fields = Math.floor(list.length * density + rng());
      for (let q = 0; q < fields && placed < target; q++) {
        const centre = list[rint(list.length)];
        deposit(centre);
        const cx = centre % w;
        const cy = (centre - cx) / w;
        const more = 1 + rint(4);
        for (let d = 0; d < more && placed < target; d++) {
          for (let t = 0; t < 12; t++) {
            const x = cx + rint(2 * fieldR + 1) - fieldR;
            const y = cy + rint(2 * fieldR + 1) - fieldR;
            if (x < 0 || y < 0 || x >= w || y >= h) continue;
            const i = y * w + x;
            if (kind[i] !== res || resource[i] !== 0) continue;
            deposit(i);
            break;
          }
        }
      }
    }
  }
}
