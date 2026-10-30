// Builds the real-world maps from Natural Earth data.
//   npx vite-node scripts/maps/build.ts            (all maps)
//   npx vite-node scripts/maps/build.ts -- europe  (only some; the rest of the manifest is kept)
// Downloads the source layers once into /tmp/borderfall-mapdata (outside the repo), writes
//   src/maps/data/<id>.ts      base64 of the gzip-compressed map blob (format: src/sim/worldmaps.ts)
//   src/maps/manifest.ts       entries + lazy loaders (imported by src/sim/worldmaps.ts)
//   src/maps/manifest.json     the same entries as plain JSON (for tools)
//   /tmp/borderfall-shots/worldmap-<id>.png   preview (terrain, resources, spawns)
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { RESOURCE_COLORS, TERRAIN } from '../../src/sim/config';
import type { WorldMapInfo, WorldMapPresets } from '../../src/sim/worldmaps';
import { MAP_DEFS } from './defs';
import type { MapDef } from './defs';
import { encodePng, fillFeature, fitBox, makeFrame, makeProjection, parseFeatures, projectedBox, toPixel } from './lib';
import type { Feature, Frame } from './lib';
import { buildTerrain } from './terrain';
import type { Layers } from './terrain';

declare const process: { argv: string[]; exit(code: number): never };

const CACHE = '/tmp/borderfall-mapdata';
const SHOTS = '/tmp/borderfall-shots';
const OUT_DIR = new URL('../../src/maps/', import.meta.url).pathname;
const NE = 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/';
const MAX_W = 2600;
const MAX_H = 1600;

function layer(name: string): Feature[] {
  const file = `${CACHE}/${name}.geojson`;
  if (!existsSync(file)) {
    mkdirSync(CACHE, { recursive: true });
    console.log(`downloading ${name}`);
    execFileSync('curl', ['-sSfL', '-o', file, `${NE}${name}.geojson`], { stdio: 'inherit' });
  }
  return parseFeatures(JSON.parse(readFileSync(file, 'utf8')));
}

/**
 * Natural Earth's lakes, split three ways: open water; reservoirs (only the wide ones are kept: long thin dammed rivers
 * would cut the land apart); dry salt lakes ("Alkaline Lake" features in Australia's deserts: Eyre, Torrens, Gairdner,
 * Mackay, Amadeus, ... are salt pans, so they become desert). Salt lakes that hold water (Great Salt Lake, Qinghai,
 * Van, Urmia, Balkhash, Issyk-Kul, Turkana, the Dead Sea, ...) stay water.
 */
function splitLakes(all: Feature[]): { lakes: Feature[]; reservoirs: Feature[]; dryLakes: Feature[] } {
  const lakes: Feature[] = [];
  const reservoirs: Feature[] = [];
  const dryLakes: Feature[] = [];
  for (const f of all) {
    const cla = String(f.props.featurecla ?? '');
    const b = f.bbox;
    const inAustralia = b.west >= 112 && b.east <= 155 && b.north <= -10 && b.south >= -45;
    if (cla === 'Alkaline Lake' && inAustralia) dryLakes.push(f);
    else if (cla === 'Reservoir') reservoirs.push(f);
    else lakes.push(f);
  }
  return { lakes, reservoirs, dryLakes };
}

function loadLayers(): { layers: Layers; places: Feature[] } {
  const lk = splitLakes(layer('ne_10m_lakes'));
  const layers: Layers = {
    land: layer('ne_10m_land'),
    minorIslands: layer('ne_10m_minor_islands'),
    lakes: lk.lakes,
    reservoirs: lk.reservoirs,
    dryLakes: lk.dryLakes,
    regions: layer('ne_10m_geography_regions_polys'),
    glaciers: layer('ne_10m_glaciated_areas'),
    rivers: layer('ne_10m_rivers_lake_centerlines'),
    peaks: layer('ne_10m_geography_regions_elevation_points'),
    deep: layer('ne_10m_bathymetry_K_200'),
  };
  return { layers, places: layer('ne_10m_populated_places_simple') };
}

/** Chooses the scale (tiles per Earth radius) giving about def.targetLand land tiles within MAX_W x MAX_H. */
function chooseScale(def: MapDef, layers: Layers): number {
  const proj = makeProjection(def.proj);
  const pb = def.fit ? fitBox(proj, def.fit) : projectedBox(proj, def.frame);
  const sMax = Math.min(MAX_W / (pb.xmax - pb.xmin), MAX_H / (pb.ymax - pb.ymin));
  const s0 = sMax / 4;
  const fr = makeFrame(proj, def.frame, s0, !!def.isWorld, def.fit);
  const mask = new Uint8Array(fr.width * fr.height);
  const fill = (feats: Feature[], v: number): void => {
    for (const f of feats) fillFeature(fr, f, (row, a, b) => mask.fill(v, row * fr.width + a, row * fr.width + b));
  };
  fill(layers.land, 1);
  fill(layers.lakes, 0);
  let land0 = 0;
  for (let i = 0; i < mask.length; i++) land0 += mask[i];
  const s = s0 * Math.sqrt(def.targetLand / Math.max(1, land0));
  return Math.min(sMax * 0.9999, s);
}

const norm = (t: string): string =>
  t
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');

const resolved: string[] = [];

function findCity(places: Feature[], city: string, country?: string): { lon: number; lat: number; pop: number } | null {
  const want = norm(city);
  let best: Feature | null = null;
  let bestPop = -1;
  for (const p of places) {
    const names = [p.props.name, p.props.nameascii, p.props.namealt, p.props.namepar].filter((v) => typeof v === 'string') as string[];
    if (!names.some((nm) => norm(nm) === want)) continue;
    if (country && norm(String(p.props.adm0name ?? '')) !== norm(country) && norm(String(p.props.sov0name ?? '')) !== norm(country)) continue;
    const pop = Number(p.props.pop_max ?? 0);
    if (pop > bestPop) {
      bestPop = pop;
      best = p;
    }
  }
  if (!best) return null;
  const c = best.parts[0][0][0];
  resolved.push(`${city}/${String(best.props.adm0name)}`);
  return { lon: c[0], lat: c[1], pop: bestPop };
}

// Spawn terrain, best first: a capital on mountains (5 people per tile), swamp or tundra (8) starts crippled, so
// within SPAWN_NEAR tiles of the city a farmable tile is taken first, then desert, then anything but mountains.
const T_PLAINS = 2;
const T_FOREST = 3;
const T_HILLS = 4;
const T_MOUNTAINS = 5;
const T_DESERT = 6;
const SPAWN_NEAR = 8;
const spawnTier = (t: number): number =>
  t === T_PLAINS || t === T_FOREST || t === T_HILLS ? 0 : t === T_DESERT ? 1 : t === T_MOUNTAINS ? 3 : 2;

/**
 * Spawn tile for a city at pixel (px, py): the nearest land tile not in `used` of the best terrain tier found within
 * SPAWN_NEAR tiles; if there is no land that close, the nearest land tile at all (spiral by distance).
 */
function spawnTile(terrain: Uint8Array, W: number, H: number, px: number, py: number, used: Set<number>): number {
  const cx = Math.floor(px);
  const cy = Math.floor(py);
  let best = -1;
  let bestTier = 99;
  let bd = Infinity;
  for (let y = cy - SPAWN_NEAR; y <= cy + SPAWN_NEAR; y++)
    for (let x = cx - SPAWN_NEAR; x <= cx + SPAWN_NEAR; x++) {
      if (x < 0 || y < 0 || x >= W || y >= H) continue;
      const i = y * W + x;
      if (terrain[i] <= 1 || used.has(i)) continue;
      const d = (x + 0.5 - px) ** 2 + (y + 0.5 - py) ** 2;
      if (d > SPAWN_NEAR * SPAWN_NEAR) continue;
      const tier = spawnTier(terrain[i]);
      if (tier < bestTier || (tier === bestTier && d < bd)) (best = i), (bestTier = tier), (bd = d);
    }
  // only mountains that close: look twice as far for anything better (Denver, Quito, ... sit just off the range)
  if (best >= 0 && bestTier >= 3) {
    const far = 2 * SPAWN_NEAR;
    let bd2 = Infinity;
    let b2 = -1;
    for (let y = cy - far; y <= cy + far; y++)
      for (let x = cx - far; x <= cx + far; x++) {
        if (x < 0 || y < 0 || x >= W || y >= H) continue;
        const i = y * W + x;
        if (terrain[i] <= 1 || used.has(i) || spawnTier(terrain[i]) >= 3) continue;
        const d = (x + 0.5 - px) ** 2 + (y + 0.5 - py) ** 2;
        if (d <= far * far && d < bd2) (bd2 = d), (b2 = i);
      }
    if (b2 >= 0) return b2;
  }
  if (best >= 0) return best;
  for (let r = SPAWN_NEAR; r < 80; r++) {
    let bi = -1;
    let bdd = Infinity;
    for (let y = cy - r; y <= cy + r; y++)
      for (let x = cx - r; x <= cx + r; x++) {
        if (Math.max(Math.abs(x - cx), Math.abs(y - cy)) !== r) continue;
        if (x < 0 || y < 0 || x >= W || y >= H) continue;
        const i = y * W + x;
        if (terrain[i] <= 1 || used.has(i)) continue;
        const d = (x + 0.5 - px) ** 2 + (y + 0.5 - py) ** 2;
        if (d < bdd) (bdd = d), (bi = i);
      }
    if (bi >= 0) return bi;
  }
  return -1;
}

/**
 * Spread-out order: the most populous major power first, then again and again a spawn far from all those already
 * chosen: of the spawns at least SPREAD_SLACK x the largest such distance away, a major power if there is one, else the
 * most populous (so the first few are both spread over the map and the big powers). AI nations take spawns in list order, so any first N are spread out.
 */
const SPREAD_SLACK = 0.6;
function spreadOrder<T extends { tile: number; pop: number; major: boolean }>(list: T[], W: number): T[] {
  if (list.length === 0) return [];
  const xy = list.map((s) => [s.tile % W, Math.floor(s.tile / W)]);
  const left = list.map((_, k) => k);
  let first = 0;
  const better = (a: T, b: T): boolean => (a.major !== b.major ? a.major : a.pop > b.pop);
  for (let k = 1; k < list.length; k++) if (better(list[k], list[first])) first = k;
  const order = [first];
  left.splice(first, 1);
  const dmin = list.map((_, k) => Math.hypot(xy[k][0] - xy[first][0], xy[k][1] - xy[first][1]));
  while (left.length) {
    let far = 0;
    for (const k of left) far = Math.max(far, dmin[k]);
    let bi = -1;
    for (let q = 0; q < left.length; q++) {
      const k = left[q];
      if (dmin[k] < SPREAD_SLACK * far) continue;
      if (bi < 0 || better(list[k], list[left[bi]])) bi = q;
    }
    const k = left[bi];
    left.splice(bi, 1);
    order.push(k);
    for (const j of left) dmin[j] = Math.min(dmin[j], Math.hypot(xy[j][0] - xy[k][0], xy[j][1] - xy[k][1]));
  }
  return order.map((k) => list[k]);
}

/** Capitals closer than this many tiles are reported (the game refuses spawns closer than 26 tiles on huge maps). */
const SPAWN_MIN_APART = 28;

function writeVarint(out: number[], v: number): void {
  while (v >= 0x80) {
    out.push((v & 0x7f) | 0x80);
    v = Math.floor(v / 128);
  }
  out.push(v);
}

function rle(a: Uint8Array): number[] {
  const out: number[] = [];
  let i = 0;
  while (i < a.length) {
    const v = a[i];
    let j = i + 1;
    while (j < a.length && a[j] === v) j++;
    out.push(v);
    writeVarint(out, j - i - 1);
    i = j;
  }
  return out;
}

function encodeBlob(W: number, H: number, land: number, terrain: Uint8Array, resource: Uint8Array): Uint8Array {
  const t = rle(terrain);
  const r = rle(resource);
  const raw = new Uint8Array(16 + t.length + r.length);
  const dv = new DataView(raw.buffer);
  for (let k = 0; k < 4; k++) raw[k] = 'BFM1'.charCodeAt(k);
  dv.setUint16(4, W, true);
  dv.setUint16(6, H, true);
  dv.setUint32(8, land, true);
  dv.setUint32(12, t.length, true);
  raw.set(t, 16);
  raw.set(r, 16 + t.length);
  // mtime 0 in the gzip header: same input -> same bytes
  return new Uint8Array(gzipSync(raw, { level: 9 }));
}

function toBase64(a: Uint8Array): string {
  let s = '';
  for (let i = 0; i < a.length; i += 0x8000) s += String.fromCharCode(...a.subarray(i, i + 0x8000));
  return btoa(s);
}

function preview(id: string, W: number, H: number, terrain: Uint8Array, resource: Uint8Array, spawns: { name: string; tile: number }[]): void {
  const rgb = new Uint8Array(W * H * 3);
  for (let i = 0; i < W * H; i++) {
    let c = TERRAIN[terrain[i] as keyof typeof TERRAIN].color;
    const r = resource[i];
    if (r) {
      const rc = RESOURCE_COLORS[r];
      c = [(c[0] + rc[0] * 2) / 3, (c[1] + rc[1] * 2) / 3, (c[2] + rc[2] * 2) / 3];
    }
    rgb[i * 3] = c[0];
    rgb[i * 3 + 1] = c[1];
    rgb[i * 3 + 2] = c[2];
  }
  const R = Math.max(3, Math.round(Math.min(W, H) / 220));
  for (const s of spawns) {
    const sx = s.tile % W;
    const sy = Math.floor(s.tile / W);
    for (let y = sy - R; y <= sy + R; y++)
      for (let x = sx - R; x <= sx + R; x++) {
        if (x < 0 || y < 0 || x >= W || y >= H) continue;
        const edge = Math.abs(x - sx) === R || Math.abs(y - sy) === R;
        const k = (y * W + x) * 3;
        rgb[k] = edge ? 20 : 230;
        rgb[k + 1] = edge ? 20 : 40;
        rgb[k + 2] = edge ? 20 : 40;
      }
  }
  mkdirSync(SHOTS, { recursive: true });
  writeFileSync(`${SHOTS}/worldmap-${id}.png`, encodePng(rgb, W, H));
}

const round5 = (v: number): number => Math.round(v / 5) * 5;

/**
 * Presets per map. Single player: a few nations and many tribes to conquer (quick games). Multiplayer: about ten
 * nations (players + AI) and fewer tribes. Tribe counts follow the land area (the game allows at most 500).
 */
function presets(land: number, spawns: number): WorldMapPresets {
  return {
    singlePlayer: {
      nations: Math.min(spawns, Math.max(5, Math.min(8, Math.round(land / 180_000)))),
      tribes: Math.max(60, Math.min(400, round5(land / 4000))),
    },
    multiplayer: {
      nations: Math.min(spawns, 10),
      tribes: Math.max(40, Math.min(250, round5(land / 9000))),
    },
  };
}

function main(): void {
  const args = process.argv.slice(2).filter((a) => a !== '--');
  const defs = args.length ? MAP_DEFS.filter((d) => args.includes(d.id)) : MAP_DEFS;
  if (defs.length === 0) {
    console.error(`unknown map id; known: ${MAP_DEFS.map((d) => d.id).join(', ')}`);
    process.exit(1);
  }
  const { layers, places } = loadLayers();
  mkdirSync(`${OUT_DIR}data`, { recursive: true });
  const manifestFile = `${OUT_DIR}manifest.json`;
  const old: WorldMapInfo[] = existsSync(manifestFile) ? JSON.parse(readFileSync(manifestFile, 'utf8')) : [];
  const built = new Map<string, WorldMapInfo>();
  for (const e of old) built.set(e.id, e);

  for (const def of defs) {
    const t0 = Date.now();
    const scale = chooseScale(def, layers);
    const fr: Frame = makeFrame(makeProjection(def.proj), def.frame, scale, !!def.isWorld, def.fit);
    const { terrain, resource, landTiles } = buildTerrain(fr, layers, def.id, { forestMax: def.forestMax });
    const W = fr.width;
    const H = fr.height;
    const used = new Set<number>();
    const placed: { name: string; tile: number; pop: number; major: boolean }[] = [];
    const moved: string[] = [];
    for (const sp of def.spawns) {
      const c = findCity(places, sp.city, sp.country);
      if (!c) throw new Error(`${def.id}: city not found: ${sp.city}`);
      const [px, py] = toPixel(fr, c.lon, c.lat);
      if (px < 0 || py < 0 || px >= W || py >= H) throw new Error(`${def.id}: ${sp.city} is outside the map`);
      const tile = spawnTile(terrain, W, H, px, py, used);
      if (tile < 0) throw new Error(`${def.id}: no land near ${sp.city}`);
      const off = Math.hypot((tile % W) + 0.5 - px, Math.floor(tile / W) + 0.5 - py);
      if (off > 1.5) moved.push(`${sp.city} ${off.toFixed(1)}`);
      used.add(tile);
      placed.push({ name: sp.name, tile, pop: c.pop, major: !!sp.major });
    }
    const spawns = spreadOrder(placed, W).map((p) => ({ name: p.name, tile: p.tile }));
    console.log(`   spawns: ${resolved.splice(0).join(', ')}`);
    console.log(`   order: ${spawns.map((p) => p.name).join(', ')}`);
    if (moved.length) console.log(`   moved off poor terrain (tiles): ${moved.join(', ')}`);
    const poor = spawns.filter((p) => spawnTier(terrain[p.tile]) >= 2).map((p) => `${p.name} (${TERRAIN[terrain[p.tile] as keyof typeof TERRAIN].name})`);
    if (poor.length) console.log(`   WARNING spawns on poor terrain: ${poor.join(', ')}`);
    for (let a = 0; a < spawns.length; a++)
      for (let b = a + 1; b < spawns.length; b++) {
        const d = Math.hypot((spawns[a].tile % W) - (spawns[b].tile % W), Math.floor(spawns[a].tile / W) - Math.floor(spawns[b].tile / W));
        if (d < SPAWN_MIN_APART) console.log(`   WARNING spawns ${spawns[a].name} / ${spawns[b].name} only ${d.toFixed(0)} tiles apart`);
      }
    const blob = encodeBlob(W, H, landTiles, terrain, resource);
    const b64 = toBase64(blob);
    writeFileSync(`${OUT_DIR}data/${def.id}.ts`, `// Generated by scripts/maps/build.ts from Natural Earth data (public domain). Do not edit.\nexport default '${b64}';\n`);
    preview(def.id, W, H, terrain, resource, spawns);
    const pre = presets(landTiles, spawns.length);
    built.set(def.id, {
      id: def.id,
      name: def.name,
      description: def.description,
      width: W,
      height: H,
      landTiles,
      recommendedNations: pre.singlePlayer.nations,
      recommendedTribes: pre.singlePlayer.tribes,
      presets: pre,
      spawns,
    });
    const counts = new Array(9).fill(0);
    for (let i = 0; i < W * H; i++) counts[terrain[i]]++;
    let oil = 0;
    for (let i = 0; i < W * H; i++) oil += resource[i] === 2 ? 1 : 0;
    console.log(`   oil ${((100 * oil) / landTiles).toFixed(2)}% of land`);
    const pct = counts.slice(2).map((c, k) => `${TERRAIN[(k + 2) as keyof typeof TERRAIN].name} ${((100 * c) / landTiles).toFixed(1)}%`);
    console.log(
      `${def.id}: ${W}x${H}, land ${landTiles}, ${(blob.length / 1024).toFixed(0)} KB gzip (${(b64.length / 1024).toFixed(0)} KB base64), ${((Date.now() - t0) / 1000).toFixed(1)} s\n   ${pct.join(', ')}`,
    );
  }

  // manifest in MAP_DEFS order
  const entries = MAP_DEFS.map((d) => built.get(d.id)).filter((e): e is WorldMapInfo => !!e);
  writeFileSync(manifestFile, JSON.stringify(entries, null, 1) + '\n');
  const ts =
    `// Generated by scripts/maps/build.ts. Do not edit.\n` +
    `import type { WorldMapInfo } from '../sim/worldmaps';\n\n` +
    `export const WORLD_MAPS: WorldMapInfo[] = ${JSON.stringify(entries)};\n\n` +
    `/** Lazy loaders: each map's data is only parsed when it is first loaded. */\n` +
    `export const WORLD_MAP_DATA: Record<string, () => Promise<{ default: string }>> = {\n` +
    entries.map((e) => `  '${e.id}': () => import('./data/${e.id}'),\n`).join('') +
    `};\n`;
  writeFileSync(`${OUT_DIR}manifest.ts`, ts);
}

main();
