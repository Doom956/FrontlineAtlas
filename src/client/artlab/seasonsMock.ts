// The art lab's "Seasons" row (art lab builds only): the first look of seasons and of day and night on the map. A
// small made-up region (a polar coast with a frozen sea in winter, a fjord with a port, a capital, a factory, forts, a
// second nation across a border, forest, fields, hills, mountains, rails with trains, ships) drawn by the game's own map
// shader (render/glmap.ts MapGL, the real ground pass), then recoloured on the CPU, art pixel by art pixel, by the pure
// maths in art/detailed/seasons.ts: each ground pixel drawn in its ramp's seasonal colours, snow spreading south behind
// a dithered edge, the night's cool shade over the ground and the art (never the borders, the owner bands, names,
// numbers or labels), and small warm lights on cities, ports, factories, forts, trains and ships.
//
// The ground is drawn without owners by the shader and the owner layer (fill tint, the border band, the border line) is
// put back here with the shader's own maths (render/palette.ts groundTint, borderColor; shaders.ts edgeDist), so the
// seasons and the night shade only the land under it while borders and owner bands stay at day brightness.
// Lab only: the game's map drawing is not touched.
import { MapGL, artPixelsPerTile } from '../render/glmap';
import { buildTerrain, type TerrainData } from '../render/terrain';
import { DEFAULT_THEME } from '../render/mapThemes';
import { groundBuilt } from '../render/ground';
import { mapStyle } from '../render/mapStyle';
import { ownedGround } from '../render/linkLayer';
import { borderColor, displayColor, groundTint, GROUND_TINT } from '../render/palette';
import { haloText, MAP_LABEL_FAMILY, MAP_NUM_FAMILY, setTracking } from '../render/common';
import { isWater, type MapData } from '../../sim/types';
import type { RGB } from '../art/shared/colour';
import { bakeBuilding, COAST, levelPill, OU, OV, type BakedBuilding, type BuildingSpec, type Under } from '../art/detailed/buildings';
import { bayer4, shaderHash } from '../art/detailed/buildingLinkArt';
import { gridOf, type Grid } from '../art/detailed/grid';
import { drawBlob } from '../art/detailed/blobs';
import { drawFlame } from '../art/detailed/burning';
import { blastAt } from '../art/detailed/explosions';
import { detailedUnits } from '../art/detailed/units';
import { detailedWakes } from '../art/detailed/trails';
import { motionOf } from '../art/registry';
import { pathLength, pointAt, railNetwork, type Hub, type P, type Rail, type SupplyTerrain } from '../art/detailed/supplyLines';
import { blitGround, drawTrain, railArt, trainCars, trainLength, type CarKind, type GroundView } from '../art/detailed/supplyArt';
import {
  DAY_SECONDS,
  LIGHT_TONES,
  SEASON,
  TIMES,
  dayLight,
  dayName,
  fireGlow,
  glowStep,
  lightAmount,
  lightSpots,
  seasonGround,
  seasonLook,
  seasonName,
  seasonPalette,
  shadeLight,
  snowCover,
  snowNoise,
  suburbLights,
  type DayLight,
  type LightKind,
  type LightTone,
  type SeasonLook,
} from '../art/detailed/seasons';
import type { TrailUnit, UnitDraw } from '../art/types';

const BLUE: RGB = [64, 160, 255];
const RED: RGB = [226, 74, 60];
const OWNERS: Record<number, RGB> = { 1: BLUE, 2: RED };
const MW = 50;
const MH = 32;
/** the sheet's zoom (CSS px per tile: the whole region in view, sprites drawn), the close-ups at twice that */
const SHEET_ZOOM = 10;
const CLOSE_ZOOM = 20;
const unitScale = (z: number): number => (z < 18 ? 2 : z < 30 ? 3 : 4);
/** 0 at the pole .. 1 at the equator: the region runs from a polar coast (top) down to mild farmland */
const polarOf = (qy: number): number => 0.04 + (0.7 * qy) / MH;

// ------------------------------------------------------------------------------------------------- the made-up map

function hash(x: number, y: number, s: number): number {
  const v = Math.sin(x * 127.1 + y * 311.7 + s * 74.7) * 43758.5453;
  return v - Math.floor(v);
}
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
const fbm = (x: number, y: number, s: number): number => noise(x, y, 7, s) * 0.6 + noise(x, y, 3, s + 3) * 0.3 + noise(x, y, 1.5, s + 7) * 0.1;
const blob = (x: number, y: number, cx: number, cy: number, rx: number, ry: number, s: number): boolean => ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 < 0.75 + 0.5 * fbm(x, y, s);

/** The polar coast: rows above it are sea (deeper to the north-east, where the ships sail). */
const coastN = (x: number): number => 3.4 + 1.2 * Math.sin(0.23 * x + 1) + 0.7 * Math.sin(0.61 * x) + 1.9 * Math.max(0, Math.min(1, (x - 27) / 8));
/** The fjord running south from the polar sea: its middle and half width on row y. */
const fjordX = (y: number): number => 8.5 + 0.9 * Math.sin(0.35 * y);
const fjordHW = (y: number): number => 2.3 * (y < 19 ? 1 : Math.max(0, 1 - (y - 19) / 3.5));

function paint(x: number, y: number): number {
  const n = fbm(x, y, 1);
  const hilly = fbm(x + 40, y + 9, 5);
  const cn = coastN(x) + 0.9 * (fbm(x, y, 41) - 0.5);
  if (y < cn) return y < cn - 2 ? 0 : 1;
  const hw = fjordHW(y);
  if (hw > 0 && Math.abs(x + 0.5 - fjordX(y)) < hw + 0.5 * (fbm(x, y, 43) - 0.5)) return Math.abs(x + 0.5 - fjordX(y)) < hw - 1.4 ? 0 : 1;
  // the polar coast's tundra, then mountains with a hilly foot
  if (y < cn + 2.6 && n > 0.32) return 8;
  if (blob(x, y, 34, 8.5, 3.6, 2.2, 11)) return 5;
  if (blob(x, y, 34, 9, 7, 4, 12) && hilly > 0.42) return 4;
  if (blob(x, y, 8, 28, 3, 2, 13)) return 4;
  // woods: one by the coast, one in the south-west by the fields, one in the east
  if (blob(x, y, 15, 8.5, 5, 2.6, 21)) return 3;
  if (blob(x, y, 21, 27, 4.2, 2.6, 22)) return 3;
  if (blob(x, y, 45, 13, 3.5, 2.5, 23)) return 3;
  if (n > 0.74) return 3;
  return 2;
}

/** Blue holds the north and west, red the south-east across a wavy border. */
function ownerOf(x: number, y: number, t: number): number {
  if (isWater(t)) return 0;
  if (x > 31 + 2 * Math.sin(0.4 * y) && y > 15 + 1.5 * Math.sin(0.35 * x)) return 2;
  return 1;
}

interface World {
  map: MapData;
  terr: TerrainData;
  mirror: Uint32Array;
  bare: Uint32Array;
  t: SupplyTerrain;
  ter: (x: number, y: number) => number;
  own: (x: number, y: number) => number;
  /** tiles from each tile to the nearest land (0 on land) */
  landDist: Float32Array;
  heightAt?: (qx: number, qy: number) => number;
}

function buildWorld(): World {
  const n = MW * MH;
  const terrain = new Uint8Array(n);
  for (let y = 0; y < MH; y++) for (let x = 0; x < MW; x++) terrain[y * MW + x] = paint(x, y);
  const owner = new Uint16Array(n);
  const mirror = new Uint32Array(n);
  let landCount = 0;
  for (let i = 0; i < n; i++) {
    owner[i] = ownerOf(i % MW, Math.floor(i / MW), terrain[i]);
    mirror[i] = owner[i];
    if (!isWater(terrain[i])) landCount++;
  }
  const map = { width: MW, height: MH, terrain, resource: new Uint8Array(n), owner, building: new Int32Array(n), coastal: new Uint8Array(n), fallout: new Float32Array(n), landTileCount: landCount } as MapData;
  const terr = buildTerrain(map, DEFAULT_THEME);
  const ter = (x: number, y: number): number => (x < 0 || y < 0 || x >= MW || y >= MH ? 0 : terrain[y * MW + x]);
  const own = (x: number, y: number): number => (x < 0 || y < 0 || x >= MW || y >= MH ? 0 : owner[y * MW + x]);
  // distance to land: a few chamfer sweeps are plenty on a map this small
  const landDist = new Float32Array(n);
  for (let i = 0; i < n; i++) landDist[i] = isWater(terrain[i]) ? 99 : 0;
  for (let pass = 0; pass < 2; pass++) {
    for (let y = 0; y < MH; y++) {
      for (let x = 0; x < MW; x++) {
        const i = y * MW + x;
        if (x > 0) landDist[i] = Math.min(landDist[i], landDist[i - 1] + 1);
        if (y > 0) landDist[i] = Math.min(landDist[i], landDist[i - MW] + 1);
        if (x > 0 && y > 0) landDist[i] = Math.min(landDist[i], landDist[i - MW - 1] + 1.414);
        if (x < MW - 1 && y > 0) landDist[i] = Math.min(landDist[i], landDist[i - MW + 1] + 1.414);
      }
    }
    for (let y = MH - 1; y >= 0; y--) {
      for (let x = MW - 1; x >= 0; x--) {
        const i = y * MW + x;
        if (x < MW - 1) landDist[i] = Math.min(landDist[i], landDist[i + 1] + 1);
        if (y < MH - 1) landDist[i] = Math.min(landDist[i], landDist[i + MW] + 1);
        if (x < MW - 1 && y < MH - 1) landDist[i] = Math.min(landDist[i], landDist[i + MW + 1] + 1.414);
        if (x > 0 && y < MH - 1) landDist[i] = Math.min(landDist[i], landDist[i + MW - 1] + 1.414);
      }
    }
  }
  return { map, terr, mirror, bare: new Uint32Array(n), t: { terrain: ter, owner: own }, ter, own, landDist };
}

// ------------------------------------------------------------------------------------------------- the scene

type SiteType = 'city' | 'factory' | 'port' | 'fort';
interface Site extends Hub {
  type: SiteType;
  level: number;
  capital?: boolean;
  burning?: boolean;
}

/** The last land tile on row y before the fjord, scanning east (the port's harbour faces east, onto the water). */
function coastX(y: number): number {
  let x = 1;
  while (x < MW && !isWater(paint(x + 1, y))) x++;
  return x;
}

let nextId = 1;
const site = (type: SiteType, x: number, y: number, owner: number, level: number, extra: Partial<Site> = {}): Site => ({ id: nextId++, type, x, y, owner, level, ...extra });

interface Ship {
  key: 'tradeShip' | 'warship';
  owner: RGB;
  x: number;
  y: number;
  angle: number;
  speed: number;
  seed: number;
}

interface Scene {
  sites: Site[];
  rails: Rail[];
  trains: { rail: Rail; from: number; at: number; load: number }[];
  ships: Ship[];
  names: { text: string; army: string; x: number; y: number; px: number }[];
  blast: P;
}

function buildScene(w: World): Scene {
  const cap = site('city', 17, 16, 1, 4, { capital: true });
  const port = site('port', coastX(18), 18, 1, 2);
  const fac = site('factory', 27, 10, 1, 2);
  const fort = site('fort', 27, 22, 1, 2);
  const town = site('city', 42, 9, 1, 2);
  const rcity = site('city', 42, 26, 2, 3);
  const rfac = site('factory', 35, 29, 2, 2, { burning: true });
  const rfort = site('fort', 36, 19, 2, 1);
  const sites = [cap, port, fac, fort, town, rcity, rfac, rfort];
  const rails = railNetwork(sites, w.t);
  const railOf = (a: Site, b: Site): Rail | undefined => rails.find((r) => (r.a === a.id && r.b === b.id) || (r.a === b.id && r.b === a.id));
  const trains: Scene['trains'] = [];
  const r1 = railOf(cap, port);
  if (r1) trains.push({ rail: r1, from: cap.id, at: 0.55, load: 2 });
  const r2 = railOf(cap, fac) ?? railOf(fac, town);
  if (r2) trains.push({ rail: r2, from: r2.a, at: 0.5, load: 3 });
  const r3 = railOf(rcity, rfort) ?? railOf(rcity, rfac);
  if (r3) trains.push({ rail: r3, from: r3.a, at: 0.5, load: 1 });
  const ships: Ship[] = [
    { key: 'tradeShip', owner: BLUE, x: fjordX(13.5), y: 13.5, angle: Math.PI / 2, speed: 0.5, seed: 11 },
    { key: 'warship', owner: BLUE, x: 40, y: 2.4, angle: 0.08, speed: 0.6, seed: 23 },
  ];
  const names = [
    { text: 'Arventa', army: '48k troops', x: 13.5, y: 26.2, px: 20 },
    { text: 'Korvel', army: '31k troops', x: 44.5, y: 19.4, px: 18 },
  ];
  return { sites, rails, trains, ships, names, blast: [31.6, 25.2] };
}

// ------------------------------------------------------------------------------------------------- the map shader

class Backdrop {
  readonly cv = document.createElement('canvas');
  readonly gl: MapGL | null;
  constructor(readonly w: World, mirror: Uint32Array) {
    this.gl = MapGL.create(this.cv);
    if (!this.gl) return;
    this.gl.setLite(false);
    this.gl.setGame(w.map, w.terr, mirror);
    this.gl.setPalette(0, [0, 0, 0], 0, false, 0);
    this.gl.setPalette(1, BLUE, 0, false, 0);
    this.gl.setPalette(2, RED, 0, false, 0);
    this.gl.uploadPalette();
  }
  get ready(): boolean {
    return !!groundBuilt(this.w.map, DEFAULT_THEME);
  }
  /** Draws the map round (cx, cy) at `zoom` into ctx (device px), as the game draws it. */
  draw(ctx: CanvasRenderingContext2D, cx: number, cy: number, zoom: number, W: number, H: number, dpr: number, timeMs: number): void {
    if (!this.gl) return;
    this.cv.width = W;
    this.cv.height = H;
    this.gl.draw(W, H, { centerX: cx, centerY: cy, zoom: zoom * dpr, timeS: timeMs / 1000, nowDs: Math.floor(timeMs / 100), auxMode: 0, showRes: false, fortOn: false, trenchOn: false, fogOn: false, dpr });
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(this.cv, 0, 0);
    ctx.restore();
  }
}

// ------------------------------------------------------------------------------------------------- the ground, recoloured

interface View extends GroundView {
  cx: number;
  cy: number;
}
const toS = (v: View, p: P): P => [v.ox + p[0] * v.zoom, v.oy + p[1] * v.zoom];

/** The owner layer's colours: the shader's display colour, its border line colour. */
const DISPLAY: Record<number, RGB> = { 1: displayColor(BLUE, { style: 'ground' }) as RGB, 2: displayColor(RED, { style: 'ground' }) as RGB };
const BORDER: Record<number, RGB> = { 1: borderColor(DISPLAY[1]) as RGB, 2: borderColor(DISPLAY[2]) as RGB };

/**
 * Bright snow under a nation: its brightness squeezed above SNOW_Y before the tint, so a red or blue nation on snow keeps
 * its colour instead of washing out to pink or pale blue (the snow's light and dark detail stays).
 */
const SNOW_Y = 160;
/** Snow or ice: bright and nearly grey (by day or under the night's blue). */
const snowLike = (c: readonly number[]): boolean => 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2] > 140 && Math.max(c[0], c[1], c[2]) - Math.min(c[0], c[1], c[2]) < 48;
/** How much of the nation's tint goes over snow inside its border band. */
const SNOW_WASH = 0.2;

function tame(c: readonly number[]): readonly number[] {
  const y = 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];
  // snow and ice only: bright and nearly grey (sand and summer grass keep their light)
  if (y <= SNOW_Y || Math.max(c[0], c[1], c[2]) - Math.min(c[0], c[1], c[2]) > 40) return c;
  const k = (SNOW_Y + (y - SNOW_Y) * 0.35) / y;
  return [c[0] * k, c[1] * k, c[2] * k];
}

/** shaders.ts edgeDist: tile units from in-tile point (fx, fy) to the nearest edge of tile (tx, ty) facing another owner. */
function edgeDist(w: World, tx: number, ty: number, fx: number, fy: number, o: number, maxW: number): number {
  let d = 9;
  const l = fx < maxW;
  const r = 1 - fx < maxW;
  const u = fy < maxW;
  const dn = 1 - fy < maxW;
  const other = (x: number, y: number): boolean => w.own(x, y) !== o;
  if (l && other(tx - 1, ty)) d = Math.min(d, fx);
  if (r && other(tx + 1, ty)) d = Math.min(d, 1 - fx);
  if (u && other(tx, ty - 1)) d = Math.min(d, fy);
  if (dn && other(tx, ty + 1)) d = Math.min(d, 1 - fy);
  if (l && u && other(tx - 1, ty - 1)) d = Math.min(d, Math.max(fx, fy));
  if (r && u && other(tx + 1, ty - 1)) d = Math.min(d, Math.max(1 - fx, fy));
  if (l && dn && other(tx - 1, ty + 1)) d = Math.min(d, Math.max(fx, 1 - fy));
  if (r && dn && other(tx + 1, ty + 1)) d = Math.min(d, Math.max(1 - fx, 1 - fy));
  return d;
}

/**
 * The season and the night over the shader's owner-free ground, then the owner layer on top: the fill tint over the
 * shaded ground, the border band and line at day brightness. `src` = the shader's pixels (device px), written to `out`.
 */
function gradeGround(src: Uint8ClampedArray, out: ImageData, v: View, w: World, look: SeasonLook, light: DayLight): void {
  const W = out.width;
  const H = out.height;
  const P = artPixelsPerTile(v.zoom);
  const zd = v.zoom * v.dpr;
  const tAtX = (X: number): number => v.cx + (X + 0.5 - W / 2) / zd;
  const tAtY = (Y: number): number => v.cy + (Y + 0.5 - H / 2) / zd;
  const ax0 = Math.floor(tAtX(0) * P);
  const ay0 = Math.floor(tAtY(0) * P);
  const aw = Math.floor(tAtX(W - 1) * P) - ax0 + 1;
  const ah = Math.floor(tAtY(H - 1) * P) - ay0 + 1;
  const day = new Uint8ClampedArray(aw * ah * 3);
  const night = new Uint8ClampedArray(aw * ah * 3);
  // per tile mean brightness of the day and the night ground (the shader's broad brightness, a mip of the far colours)
  const tx0 = Math.floor(ax0 / P);
  const ty0 = Math.floor(ay0 / P);
  const tw = Math.floor((ax0 + aw - 1) / P) - tx0 + 1;
  const th = Math.floor((ay0 + ah - 1) / P) - ty0 + 1;
  const sumD = new Float32Array(tw * th);
  const sumN = new Float32Array(tw * th);
  const cnt = new Float32Array(tw * th);
  for (let j = 0; j < ah; j++) {
    const ay = ay0 + j;
    const qy = (ay + 0.5) / P;
    const Y = Math.max(0, Math.min(H - 1, Math.floor((qy - v.cy) * zd + H / 2)));
    const ty = Math.floor(qy);
    for (let i = 0; i < aw; i++) {
      const ax = ax0 + i;
      const qx = (ax + 0.5) / P;
      const X = Math.max(0, Math.min(W - 1, Math.floor((qx - v.cx) * zd + W / 2)));
      const o = (Y * W + X) * 4;
      const tx = Math.floor(qx);
      const inMap = tx >= 0 && ty >= 0 && tx < MW && ty < MH;
      const k = (j * aw + i) * 3;
      let c: readonly number[] = [src[o], src[o + 1], src[o + 2]];
      if (inMap) c = seasonGround(c, { terrain: w.ter(tx, ty), qx, qy, ax, ay, polar: polarOf(qy), landDist: w.landDist[ty * MW + tx], P }, look);
      day[k] = c[0];
      day[k + 1] = c[1];
      day[k + 2] = c[2];
      const nc = inMap ? shadeLight(c, light) : c;
      night[k] = nc[0];
      night[k + 1] = nc[1];
      night[k + 2] = nc[2];
      const ti = (ty - ty0) * tw + (tx - tx0);
      sumD[ti] += 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];
      sumN[ti] += 0.299 * nc[0] + 0.587 * nc[1] + 0.114 * nc[2];
      cnt[ti]++;
    }
  }
  const blurOf = (sum: Float32Array): Float32Array => {
    const m = new Float32Array(tw * th);
    for (let i = 0; i < m.length; i++) m[i] = cnt[i] ? sum[i] / cnt[i] : 128;
    const b = new Float32Array(tw * th);
    for (let y = 0; y < th; y++) {
      for (let x = 0; x < tw; x++) {
        let s = 0;
        let n = 0;
        for (let dy = -2; dy <= 2; dy++) {
          for (let dx = -2; dx <= 2; dx++) {
            const xx = x + dx;
            const yy = y + dy;
            if (xx < 0 || yy < 0 || xx >= tw || yy >= th) continue;
            s += m[yy * tw + xx];
            n++;
          }
        }
        b[y * tw + x] = s / n;
      }
    }
    return b;
  };
  const avgD = blurOf(sumD);
  const avgN = blurOf(sumN);
  // the owner layer (shaders.ts, real ground): fill, then the band just inside the border, then the line
  const a1 = 1 / P;
  const zc = v.zoom;
  const bandCss = 10 + (7 - 10) * Math.max(0, Math.min(1, (zc - 12) / 20));
  const bandW = Math.min(Math.max(Math.floor((bandCss / zc) * P + 0.5) / P, 3 * a1), 1);
  const fin = new Uint8ClampedArray(aw * ah * 3);
  for (let j = 0; j < ah; j++) {
    const qy = (ay0 + j + 0.5) / P;
    const ty = Math.floor(qy);
    for (let i = 0; i < aw; i++) {
      const qx = (ax0 + i + 0.5) / P;
      const tx = Math.floor(qx);
      const k = (j * aw + i) * 3;
      const o = w.own(tx, ty);
      let c: readonly number[] = [night[k], night[k + 1], night[k + 2]];
      if (o) {
        const ti = (ty - ty0) * tw + (tx - tx0);
        const oc = DISPLAY[o];
        const dE = edgeDist(w, tx, ty, qx - tx, qy - ty, o, bandW);
        if (dE < a1) c = BORDER[o];
        else {
          let fill = groundTint(tame(c), oc, GROUND_TINT.near, Math.min(SNOW_Y, avgN[ti]));
          // on snow only a light wash of the nation: the snow stays white with its drifts, the band carries the colour
          if (snowLike(c)) fill = [c[0] + (fill[0] - c[0]) * SNOW_WASH, c[1] + (fill[1] - c[1]) * SNOW_WASH, c[2] + (fill[2] - c[2]) * SNOW_WASH];
          if (dE < bandW) {
            const dc: readonly number[] = [day[k], day[k + 1], day[k + 2]];
            const band = groundTint(tame(dc), oc, GROUND_TINT.band, Math.min(SNOW_Y, avgD[ti]));
            c = dE >= bandW - a1 ? [(fill[0] + band[0]) / 2, (fill[1] + band[1]) / 2, (fill[2] + band[2]) / 2] : band;
          } else c = fill;
        }
      }
      fin[k] = c[0];
      fin[k + 1] = c[1];
      fin[k + 2] = c[2];
    }
  }
  const d = out.data;
  for (let Y = 0; Y < H; Y++) {
    const j = Math.floor(tAtY(Y) * P) - ay0;
    for (let X = 0; X < W; X++) {
      const i = Math.floor(tAtX(X) * P) - ax0;
      const k = (j * aw + i) * 3;
      const o = (Y * W + X) * 4;
      const tx = tAtX(X);
      const ty = tAtY(Y);
      if (tx < 0 || ty < 0 || tx >= MW || ty >= MH) {
        d[o] = src[o];
        d[o + 1] = src[o + 1];
        d[o + 2] = src[o + 2];
      } else {
        d[o] = fin[k];
        d[o + 1] = fin[k + 1];
        d[o + 2] = fin[k + 2];
      }
      d[o + 3] = 255;
    }
  }
}

// ------------------------------------------------------------------------------------------------- the art on top

const pixelCache = new Map<string, ReturnType<typeof railArt>>();

function siteUnder(w: World, s: Site): Under {
  const tint = ownedGround(mapStyle(), OWNERS[s.owner] ?? null);
  return {
    rgb: () => {
      const o = (s.y * MW + s.x) * 4;
      const c: RGB = [w.terr.rgba[o], w.terr.rgba[o + 1], w.terr.rgba[o + 2]];
      return tint(c, 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]);
    },
    water: () => false,
  };
}

interface Placed {
  s: Site;
  spr: BakedBuilding;
  /** the picture's top left (CSS px) */
  x: number;
  y: number;
  scale: number;
}

/**
 * A building picture with snow on it (winter): the top two pixels of every roof edge (under the outline, or under a
 * dark edge line) turn white, the second a shade greyer. One canvas pixel per art pixel, cached per picture.
 */
const capped = new WeakMap<HTMLCanvasElement, HTMLCanvasElement>();
function snowCap(src: HTMLCanvasElement): HTMLCanvasElement {
  let out = capped.get(src);
  if (out) return out;
  out = document.createElement('canvas');
  out.width = src.width;
  out.height = src.height;
  const ox = out.getContext('2d');
  const img = spritePixels(src);
  if (!ox || !img) return src;
  const W = img.width;
  const H = img.height;
  const d = new Uint8ClampedArray(img.data);
  const a = (X: number, Y: number): boolean => Y >= 0 && img.data[(Y * W + X) * 4 + 3] > 200;
  const y = (X: number, Y: number): number => {
    const o = (Y * W + X) * 4;
    return 0.299 * img.data[o] + 0.587 * img.data[o + 1] + 0.114 * img.data[o + 2];
  };
  const paint = (X: number, Y: number, c: readonly number[]): void => {
    if (Y >= H || !a(X, Y)) return;
    const o = (Y * W + X) * 4;
    d[o] = c[0];
    d[o + 1] = c[1];
    d[o + 2] = c[2];
  };
  for (let X = 0; X < W; X++) {
    for (let Y = 1; Y < H; Y++) {
      if (!a(X, Y)) continue;
      const edgeTop = !a(X, Y - 1) && a(X, Y + 1);
      const lineTop = a(X, Y - 1) && y(X, Y - 1) < 60 && y(X, Y) > 85 && (Y < 2 || !a(X, Y - 2) || y(X, Y - 2) > 60);
      if (edgeTop) {
        // the outline pixel stays, the two under it take the snow
        paint(X, Y + 1, [236, 241, 244]);
        paint(X, Y + 2, [206, 216, 223]);
      } else if (lineTop) {
        paint(X, Y, [236, 241, 244]);
        paint(X, Y + 1, [206, 216, 223]);
      }
    }
  }
  const im = ox.createImageData(W, H);
  im.data.set(d);
  ox.putImageData(im, 0, 0);
  capped.set(src, out);
  return out;
}

function drawSites(ctx: CanvasRenderingContext2D, w: World, sc: Scene, v: View, season: number | null = null): Placed[] {
  const out: Placed[] = [];
  const scale = unitScale(v.zoom);
  for (const s of sc.sites.slice().sort((a, b) => a.y - b.y)) {
    const owner = OWNERS[s.owner];
    const [sx, sy] = toS(v, [s.x + 0.5, s.y + 0.5]);
    const spec: BuildingSpec = { type: s.type, level: s.level, addon: null };
    const spr = bakeBuilding(spec, owner, scale, v.dpr, siteUnder(w, s));
    const ax = s.type === 'port' ? v.ox + (s.x + 1) * v.zoom - COAST * scale : sx;
    const x = Math.round((ax - OU * scale) * v.dpr) / v.dpr;
    const y = Math.round((sy - OV * scale) * v.dpr) / v.dpr;
    ctx.imageSmoothingEnabled = false;
    const snowy = season !== null && snowCover(season, polarOf(s.y + 0.5), snowNoise(s.x + 0.5, s.y + 0.5, season), w.ter(s.x, s.y)) > 0.5;
    ctx.drawImage(snowy ? snowCap(spr.canvas) : spr.canvas, x, y, spr.w, spr.h);
    out.push({ s, spr, x, y, scale });
  }
  return out;
}

/** Rails in the season's ground colours; where the snow lies the bed is drawn as on tundra (pale, bluish). */
function drawRails(ctx: CanvasRenderingContext2D, w: World, sc: Scene, v: View, season: number | null): void {
  const P = artPixelsPerTile(v.zoom);
  const key0 = season === null ? 'today' : season.toFixed(2);
  const ramps = season === null ? DEFAULT_THEME.ground : seasonPalette(season);
  const terrainAt = season === null
    ? w.ter
    : (x: number, y: number): number => {
        const t = w.ter(x, y);
        if (t <= 1 || t === 5) return t;
        return snowCover(season, polarOf(y + 0.5), snowNoise(x + 0.5, y + 0.5, season), t) > 0.5 ? 8 : t;
      };
  for (const r of sc.rails) {
    const owner = sc.sites.find((s) => s.id === r.a)?.owner ?? 1;
    const key = `${r.a}-${r.b}|${P}|${key0}`;
    let px = pixelCache.get(key);
    if (!px) {
      px = railArt([r.path], { P, terrainAt, ramps, heightAt: w.heightAt, tint: ownedGround(mapStyle(), OWNERS[owner] ?? null) }, 3);
      pixelCache.set(key, px);
    }
    blitGround(ctx, px, P, v);
  }
}

interface TrainLamp {
  path: P[];
  head: number;
  cars: CarKind[];
  scale: number;
}

function drawTrains(ctx: CanvasRenderingContext2D, sc: Scene, v: View, timeMs: number): TrainLamp[] {
  const out: TrainLamp[] = [];
  for (const t of sc.trains) {
    const owner = OWNERS[sc.sites.find((s) => s.id === t.from)?.owner ?? 1];
    const tiles = t.rail.a === t.from ? t.rail.path : t.rail.path.slice().reverse();
    const path = tiles.map((p) => toS(v, p));
    const L = pathLength(path);
    const scale = unitScale(v.zoom);
    const cars = trainCars(t.load, t.rail.a * 7 + t.rail.b);
    const head = Math.max(trainLength(cars) * scale, Math.min(L, t.at * L));
    drawTrain(ctx, { path, head, cars, owner, scale, dpr: v.dpr, timeMs });
    out.push({ path, head, cars, scale });
  }
  return out;
}

function shipDraw(s: Ship, v: View, timeMs: number): UnitDraw {
  const [x, y] = toS(v, [s.x, s.y]);
  const scale = unitScale(v.zoom);
  return { key: s.key, mods: 0, owner: s.owner, x, y, angle: s.angle, zoom: v.zoom, scale, lod: 'near', dpr: v.dpr, timeMs, turnRate: 0, speed: s.speed, moving: true, seed: s.seed, alpha: 1, shadow: true, damage: 0, outline: true } as UnitDraw;
}

/** Ships with their wakes, laid over the last few seconds as on the map. */
function drawShips(ctx: CanvasRenderingContext2D, sc: Scene, v: View, timeMs: number): void {
  const motion = motionOf('lively');
  const layer = detailedWakes.createLayer();
  const scratch = document.createElement('canvas');
  scratch.width = 4;
  scratch.height = 4;
  const sctx = scratch.getContext('2d');
  const scale = unitScale(v.zoom);
  const STEP = 50;
  const at = (s: Ship, t: number): P => {
    const back = ((timeMs - t) / 1000) * s.speed;
    return [s.x - Math.cos(s.angle) * back, s.y - Math.sin(s.angle) * back];
  };
  for (let t = timeMs - 5000; t <= timeMs; t += STEP) {
    const units: TrailUnit[] = sc.ships.map((s, i) => {
      const [qx, qy] = at(s, t);
      const [x, y] = toS(v, [qx, qy]);
      const half = detailedUnits.lengthPx(s.key, 0, scale) / 2;
      return { id: 600 + i, key: s.key, x, y, tx: qx, ty: qy, angle: s.angle, half, moving: true, speed: s.speed, turnRate: 0, motion };
    });
    const target = t + STEP > timeMs ? ctx : sctx;
    if (target) layer.frame(target, units, { ox: v.ox, oy: v.oy, zoom: v.zoom, scale, now: t, viewW: v.w, viewH: v.h, dpr: v.dpr, full: true });
  }
  for (const s of sc.ships) detailedUnits.drawUnit(ctx, shipDraw(s, v, timeMs), motion);
}

/** The burning red factory's smoke (art, shaded by the night like the rest). */
function drawSmoke(ctx: CanvasRenderingContext2D, sc: Scene, v: View, timeMs: number): void {
  const k = unitScale(v.zoom);
  const g = gridOf(k, v.dpr);
  for (const s of sc.sites) {
    if (!s.burning) continue;
    const [sx, sy] = toS(v, [s.x + 0.5, s.y + 0.5]);
    for (let i = 8; i >= 0; i--) {
      const age = (timeMs / 2600 + i / 9) % 1;
      const x = sx + (3 + age * 16 + Math.sin(age * 5 + i) * 2) * k;
      const y = sy - (8 + age * 36) * k;
      drawBlob(ctx, age < 0.35 ? 'soot' : 'smoke', (2.4 + age * 6) * g.res, i & 3, x, y, g, 0.92 * (1 - age * 0.85));
    }
  }
}

// ------------------------------------------------------------------------------------------------- lights

/** A lamp: one art pixel (or two square) of light with a dimmer pixel of spill on each side, in device px. */
function lamp(ctx: CanvasRenderingContext2D, X: number, Y: number, p: number, tone: LightTone, a: number, size: 1 | 2 = 1, spill = 0.3): void {
  if (a <= 0.01) return;
  const c = LIGHT_TONES[tone];
  const s = p * size;
  ctx.fillStyle = `rgba(${c[0]},${c[1]},${c[2]},${(spill * a).toFixed(3)})`;
  ctx.fillRect(X - p, Y, p, s);
  ctx.fillRect(X + s, Y, p, s);
  ctx.fillRect(X, Y - p, s, p);
  ctx.fillRect(X, Y + s, s, p);
  ctx.fillStyle = `rgba(${c[0]},${c[1]},${c[2]},${a.toFixed(3)})`;
  ctx.fillRect(X, Y, s, s);
}

/** A glow round a fire or a blast: stepped rings of whole art pixels, the outer ring dithered. */
function glow(ctx: CanvasRenderingContext2D, x: number, y: number, R: number, g: Grid, tone: LightTone, a: number): void {
  const c = LIGHT_TONES[tone];
  const p = g.p;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  const X0 = Math.round((x * g.dpr) / p);
  const Y0 = Math.round((y * g.dpr) / p);
  const r = Math.ceil(R);
  for (let j = -r; j <= r; j++) {
    for (let i = -r; i <= r; i++) {
      const d = Math.hypot(i, j * 1.25);
      const s = glowStep(d, R);
      if (!s) continue;
      if (s < 0.2 && bayer4(X0 + i, Y0 + j) > 0.5) continue;
      ctx.fillStyle = `rgba(${c[0]},${c[1]},${c[2]},${(s * a).toFixed(3)})`;
      ctx.fillRect((X0 + i) * p, (Y0 + j) * p, p, p);
    }
  }
  ctx.restore();
}

/**
 * The cells of a building picture where a light can sit, best first: its dark window pixels (darker than the wall on
 * both sides), then any other cell inside its outline. The picture is baked one canvas pixel per art pixel.
 */
const cellsOf = new WeakMap<HTMLCanvasElement, { win: [number, number][]; body: [number, number][] }>();
function lightCells(c: HTMLCanvasElement, top: number): { win: [number, number][]; body: [number, number][] } {
  let r = cellsOf.get(c);
  if (r) return r;
  r = { win: [], body: [] };
  const img = spritePixels(c);
  if (img) {
    const W = img.width;
    const H = img.height;
    const d = img.data;
    const at = (X: number, Y: number): number => (X < 0 || Y < 0 || X >= W || Y >= H ? -1 : d[(Y * W + X) * 4 + 3] > 220 ? 0.299 * d[(Y * W + X) * 4] + 0.587 * d[(Y * W + X) * 4 + 1] + 0.114 * d[(Y * W + X) * 4 + 2] : -1);
    for (let Y = top; Y < H; Y++) {
      for (let X = 0; X < W; X++) {
        const m = at(X, Y);
        const l = at(X - 1, Y);
        const rr = at(X + 1, Y);
        const u = at(X, Y - 1);
        const dn = at(X, Y + 1);
        if (m < 0 || l < 0 || rr < 0 || u < 0 || dn < 0) continue;
        // keep off the outline: two cells in on every side
        if (at(X - 2, Y) < 0 || at(X + 2, Y) < 0 || at(X, Y - 2) < 0 || at(X, Y + 2) < 0) continue;
        if (m < 120 && ((m + 16 < l && m + 16 < rr) || (m + 16 < u && m + 16 < dn))) r.win.push([X, Y]);
        else r.body.push([X, Y]);
      }
    }
  }
  cellsOf.set(c, r);
  return r;
}

const opaque = new WeakMap<HTMLCanvasElement, ImageData>();
function spritePixels(c: HTMLCanvasElement): ImageData | null {
  let d = opaque.get(c);
  if (!d) {
    const cx = c.getContext('2d');
    if (!cx) return null;
    d = cx.getImageData(0, 0, c.width, c.height);
    opaque.set(c, d);
  }
  return d;
}

/** Lights at night: windows on the buildings, street lamps round cities, train headlamps and windows, ship lights. */
function drawLights(ctx: CanvasRenderingContext2D, w: World, sc: Scene, v: View, placed: Placed[], trains: TrainLamp[], tod: number): void {
  const amt = lightAmount(tod);
  if (amt <= 0) return;
  const dark = dayLight(tod).dark;
  const dpr = v.dpr;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  const P = artPixelsPerTile(v.zoom);
  const gp = (v.zoom / P) * dpr; // a ground art pixel in device px
  // street lamps on the ground round the cities (under the buildings' own lights)
  for (const pl of placed) {
    const s = pl.s;
    const kind: LightKind = s.capital ? 'capital' : s.type;
    for (const l of suburbLights(kind, s.level, s.id * 31)) {
      if (dark < l.on) continue;
      const qx = s.x + 0.5 + l.dx;
      const qy = s.y + 0.5 + l.dy;
      if (isWater(w.ter(Math.floor(qx), Math.floor(qy)))) continue;
      const ax = Math.floor(qx * P);
      const ay = Math.floor(qy * P);
      const X = Math.round((v.ox + (ax / P) * v.zoom) * dpr);
      const Y = Math.round((v.oy + (ay / P) * v.zoom) * dpr);
      lamp(ctx, X, Y, Math.max(3, Math.round(gp * 1.2)), l.tone, amt, 1, 0.2);
    }
  }
  // windows and yard lamps on the buildings: their own dark window pixels lit, a few at random, more on bigger cities
  for (const pl of placed) {
    const s = pl.s;
    const kind: LightKind = s.capital ? 'capital' : s.type;
    const g = gridOf(pl.scale, dpr);
    const spots = lightSpots(kind, s.level, s.id * 17 + 5);
    const want = Math.round(spots.length / 3);
    const cells = lightCells(pl.spr.canvas, Math.round(pl.spr.top / g.k));
    const order = (list: [number, number][]): [number, number][] => list.slice().sort((a, b) => shaderHash(a[0], a[1], s.id) - shaderHash(b[0], b[1], s.id));
    const pickCells = [...order(cells.win), ...order(cells.body)].slice(0, want);
    pickCells.forEach(([X, Y], i) => {
      const l = spots[i % spots.length];
      if (dark < l.on) return;
      lamp(ctx, Math.round(pl.x * dpr) + X * g.p, Math.round(pl.y * dpr) + Y * g.p, g.p, l.tone, amt, g.k < 1.5 ? 2 : 1, i < cells.win.length ? 0.22 : 0.3);
    });
  }
  // trains: a headlamp with a short beam ahead, lit cab windows, a lamp on each wagon, a red lamp at the tail
  for (const t of trains) {
    const g = gridOf(t.scale, dpr);
    const p = g.p;
    const cell = (x: number, y: number): [number, number] => [Math.round((x * dpr) / p) * p, Math.round((y * dpr) / p) * p];
    const nose = pointAt(t.path, t.head);
    const fx = Math.cos(nose.angle);
    const fy = Math.sin(nose.angle);
    for (let k = 3; k >= 1; k--) {
      const [X, Y] = cell(nose.x + fx * k * g.k * 1.6, nose.y + fy * k * g.k * 1.6 - g.k);
      ctx.fillStyle = `rgba(255,240,200,${((0.5 - k * 0.12) * amt).toFixed(3)})`;
      ctx.fillRect(X - p, Y - p, p * 3, p * 3);
    }
    const [hX, hY] = cell(nose.x, nose.y - g.k);
    lamp(ctx, hX, hY, p, 'white', amt);
    let s = t.head;
    const gap = (trainLength(['engine', 'tender']) - trainLength(['engine']) - trainLength(['tender'])) * t.scale;
    t.cars.forEach((kind, i) => {
      const L = trainLength([kind]) * t.scale;
      if (kind === 'engine') {
        const m = pointAt(t.path, s - L * 0.72);
        const [X, Y] = cell(m.x, m.y - g.k * 2);
        lamp(ctx, X, Y, p, 'warm', amt);
      } else if (kind !== 'tender') {
        const m = pointAt(t.path, s - L * 0.5);
        const [X, Y] = cell(m.x, m.y - g.k * 2);
        lamp(ctx, X, Y, p, 'amber', amt * 0.85);
      }
      s -= L + gap;
      if (i === t.cars.length - 1) {
        const m = pointAt(t.path, s + gap + 0.5);
        const [X, Y] = cell(m.x, m.y - g.k);
        lamp(ctx, X, Y, p, 'red', amt);
      }
    });
  }
  // ships: white mast and stern lights, red to port and green to starboard
  for (const sh of sc.ships) {
    const u = shipDraw(sh, v, 0);
    const g = gridOf(u.scale, dpr);
    const p = g.p;
    const len = detailedUnits.lengthPx(sh.key, 0, u.scale);
    const fx = Math.cos(sh.angle);
    const fy = Math.sin(sh.angle);
    const at = (along: number, side: number, tone: LightTone): void => {
      const x = u.x + fx * along * len - fy * side * len;
      const y = u.y + fy * along * len + fx * side * len;
      lamp(ctx, Math.round((x * dpr) / p) * p, Math.round((y * dpr) / p) * p, p, tone, amt);
    };
    at(0.44, 0, 'white');
    at(0.12, 0, 'pale');
    at(0.18, -0.09, 'red');
    at(0.18, 0.09, 'green');
    at(-0.46, 0, 'white');
  }
  ctx.restore();
}

/** Fire on the burning factory and a shell blast on the border: drawn after the night shade, glowing brighter at night. */
function drawFire(ctx: CanvasRenderingContext2D, sc: Scene, v: View, timeMs: number, tod: number | null): void {
  const k = unitScale(v.zoom);
  const g = gridOf(k, v.dpr);
  const m = motionOf('lively');
  const gl = tod === null ? 0 : fireGlow(tod);
  for (const s of sc.sites) {
    if (!s.burning) continue;
    const [sx, sy] = toS(v, [s.x + 0.5, s.y + 0.5]);
    if (gl > 0) glow(ctx, sx + 2 * k, sy - 4 * k, (1.5 * v.zoom * v.dpr) / g.p, g, 'fire', gl);
    drawFlame(ctx, sx + 2 * k, sy - 3 * k, 2.4 * g.res, g, timeMs, 0.31, m, 1, 1);
    drawFlame(ctx, sx - 6 * k, sy + 1 * k, 1.6 * g.res, g, timeMs + 400, 0.67, m, 1, 1);
  }
  const [bx, by] = toS(v, sc.blast);
  if (gl > 0) glow(ctx, bx, by, (1.9 * v.zoom * v.dpr) / g.p, g, 'fire', gl);
  blastAt(ctx, 'shell', bx, by, 170, v.zoom, k, v.dpr, 7, m);
}

/** Level chips, nation names and army sizes: never shaded, the same by day and night. */
function drawLabels(ctx: CanvasRenderingContext2D, sc: Scene, v: View, placed: Placed[]): void {
  for (const pl of placed) levelPill(ctx, pl.x + pl.spr.cx, pl.y + pl.spr.top - 15, pl.s.level, OWNERS[pl.s.owner]);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (const n of sc.names) {
    const [x, y] = toS(v, [n.x, n.y]);
    const px = Math.round(n.px * Math.min(1.4, v.zoom / SHEET_ZOOM));
    ctx.font = `600 ${px}px ${MAP_LABEL_FAMILY}`;
    setTracking(ctx, px * 0.02);
    const small = Math.max(10, Math.min(14, px * 0.62));
    const ny = y - small * 0.45;
    haloText(ctx, n.text, x, ny, 'rgba(255,255,255,0.93)', px, 1);
    ctx.font = `500 ${Math.round(small)}px ${MAP_NUM_FAMILY}`;
    setTracking(ctx, small * 0.02);
    haloText(ctx, n.army, x, ny + px * 0.55 + small * 0.55, 'rgba(250,251,253,0.96)', small, 1.05);
  }
  setTracking(ctx, 0);
}

// ------------------------------------------------------------------------------------------------- drawing a panel

interface Look {
  /** null = today's look (no seasons, no night): the game as it draws now */
  season: number | null;
  tod: number | null;
}

interface Ctx {
  w: World;
  sc: Scene;
  owned: Backdrop;
  bare: Backdrop;
  dpr: number;
}

const scratch = { g: document.createElement('canvas'), a: document.createElement('canvas') };

function renderPanel(cv: HTMLCanvasElement, c: Ctx, at: P, zoom: number, look: Look, timeMs = 1200): void {
  const ctx = cv.getContext('2d');
  if (!ctx) return;
  const { w, sc, dpr } = c;
  const W = cv.width;
  const H = cv.height;
  const cw = W / dpr;
  const ch = H / dpr;
  const cx = Math.max(cw / 2 / zoom, Math.min(MW - cw / 2 / zoom, at[0]));
  const cy = Math.max(ch / 2 / zoom, Math.min(MH - ch / 2 / zoom, at[1]));
  const v: View = { cx, cy, zoom, dpr, w: cw, h: ch, ox: cw / 2 - cx * zoom, oy: ch / 2 - cy * zoom };
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, W, H);
  const today = look.season === null && look.tod === null;
  const light = dayLight(look.tod ?? TIMES.noon);
  // 1. the ground: as the game draws it today, or the owner-free ground recoloured with the owner layer put back
  if (today || !c.bare.gl) c.owned.draw(ctx, cx, cy, zoom, W, H, dpr, timeMs);
  else {
    const gx = scratch.g.getContext('2d', { willReadFrequently: true });
    if (!gx) return;
    scratch.g.width = W;
    scratch.g.height = H;
    c.bare.draw(gx, cx, cy, zoom, W, H, dpr, timeMs);
    const src = gx.getImageData(0, 0, W, H).data;
    const out = ctx.createImageData(W, H);
    gradeGround(src, out, v, w, seasonLook(look.season ?? SEASON.summer), light);
    ctx.putImageData(out, 0, 0);
  }
  // 2. the art (rails, buildings, trains, ships, smoke) on its own layer, shaded by the night as a whole
  const ac = scratch.a;
  ac.width = W;
  ac.height = H;
  const ax = ac.getContext('2d', { willReadFrequently: true });
  if (!ax) return;
  ax.setTransform(dpr, 0, 0, dpr, 0, 0);
  drawRails(ax, w, sc, v, today ? null : look.season);
  const placed = drawSites(ax, w, sc, v, today ? null : look.season);
  drawShips(ax, sc, v, timeMs);
  const trains = drawTrains(ax, sc, v, timeMs);
  drawSmoke(ax, sc, v, timeMs);
  if (!today && (light.dark > 0 || light.warm > 0)) {
    const img = ax.getImageData(0, 0, W, H);
    const d = img.data;
    const px: number[] = [0, 0, 0];
    for (let o = 0; o < d.length; o += 4) {
      if (!d[o + 3]) continue;
      px[0] = d[o];
      px[1] = d[o + 1];
      px[2] = d[o + 2];
      const s = shadeLight(px, light);
      d[o] = s[0];
      d[o + 1] = s[1];
      d[o + 2] = s[2];
    }
    ax.putImageData(img, 0, 0);
  }
  ctx.drawImage(ac, 0, 0);
  // 3. what gives light: fire, blasts, lamps
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  drawFire(ctx, sc, v, timeMs, today ? null : look.tod ?? TIMES.noon);
  if (!today && look.tod !== null) drawLights(ctx, w, sc, v, placed, trains, look.tod);
  // 4. labels: always at full brightness
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  drawLabels(ctx, sc, v, placed);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}

// ------------------------------------------------------------------------------------------------- the row

const SVG = (body: string): string => `<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
const SUN_RAYS = '<path d="M8 1.5v1.6M8 12.9v1.6M1.5 8h1.6M12.9 8h1.6M3.4 3.4l1.1 1.1M11.5 11.5l1.1 1.1M3.4 12.6l1.1-1.1M11.5 4.5l1.1-1.1"/>';
const ICONS = {
  spring: SVG('<path d="M8 14.5V8"/><path d="M8 9C8 5.8 5.9 3.5 2.5 3.5c0 3.2 2.1 5.5 5.5 5.5z"/><path d="M8 10.5c0-3.2 2.1-5.5 5.5-5.5 0 3.2-2.1 5.5-5.5 5.5z"/>'),
  summer: SVG(`<circle cx="8" cy="8" r="3"/>${SUN_RAYS}`),
  autumn: SVG('<path d="M2.5 13.5C2.5 7 6.5 2.5 13.5 2.5c0 7-4.5 11-11 11z"/><path d="M2.5 13.5L9 7"/>'),
  winter: SVG('<path d="M8 1.5v13M2.4 4.75l11.2 6.5M2.4 11.25l11.2-6.5"/><path d="M6.3 2.6L8 4l1.7-1.4M6.3 13.4L8 12l1.7 1.4"/>'),
  dawn: SVG('<path d="M1.5 12.5h13"/><path d="M4.5 12.5a3.5 3.5 0 0 1 7 0"/><path d="M8 2.5v4M6.2 4.3L8 2.5l1.8 1.8"/>'),
  noon: SVG(`<circle cx="8" cy="8" r="3"/>${SUN_RAYS}`),
  dusk: SVG('<path d="M1.5 12.5h13"/><path d="M4.5 12.5a3.5 3.5 0 0 1 7 0"/><path d="M8 2.5v4M6.2 4.7L8 6.5l1.8-1.8"/>'),
  night: SVG('<path d="M12.8 10.2A5.5 5.5 0 0 1 5.8 3.2a5.5 5.5 0 1 0 7 7z"/>'),
  play: SVG('<path d="M4.5 2.8l8.5 5.2-8.5 5.2z" fill="currentColor"/>'),
  pause: SVG('<path d="M5 3v10M11 3v10" stroke-width="2.4"/>'),
} as const;

function iconButton(icon: string, word: string): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.style.cssText = 'display:inline-flex;align-items:center;gap:6px';
  b.innerHTML = icon;
  const s = document.createElement('span');
  s.textContent = word;
  b.append(s);
  return b;
}

function segRow<T extends string>(label: string, items: readonly (readonly [T, string, string])[], on: (v: T) => void): { el: HTMLElement; set: (v: T | null) => void } {
  const el = document.createElement('div');
  el.className = 'al-seg';
  el.setAttribute('role', 'group');
  el.setAttribute('aria-label', label);
  const btns = new Map<T, HTMLButtonElement>();
  const set = (v: T | null): void => {
    for (const [k, b] of btns) b.setAttribute('aria-pressed', String(k === v));
  };
  for (const [v, icon, word] of items) {
    const b = iconButton(icon, word);
    b.addEventListener('click', () => {
      set(v);
      on(v);
    });
    btns.set(v, b);
    el.append(b);
  }
  return { el, set };
}

const clock = (tod: number): string => {
  const s = Math.round(tod * DAY_SECONDS) % DAY_SECONDS;
  return `${s} s`;
};

/** Mounts the Seasons row in the lab page and draws it once the map's ground is built. */
export function mountSeasonsMock(root: HTMLElement): HTMLElement {
  const sec = document.createElement('section');
  sec.className = 'al-row al-bm';
  sec.id = 'al-seasons';
  sec.setAttribute('aria-labelledby', 'al-row-seasons');
  sec.style.display = 'block';
  const head = document.createElement('div');
  head.className = 'al-row-head';
  const t = document.createElement('h2');
  t.id = 'al-row-seasons';
  t.textContent = 'Seasons';
  const note = document.createElement('p');
  note.textContent =
    'The first look of seasons and of day and night, on a small made-up region drawn by the game\'s own map shader. Every ground pixel keeps its place and tone and takes its ramp\'s seasonal colour: fresh green and mud in spring, bright and dry in summer, orange and red woods and golden fields in autumn, snow spreading south from the pole behind a soft dithered edge and the polar sea freezing near its coasts in winter. A day is 2 minutes: 90 s of day, 30 s of night, with a gentle dawn and dusk. At night the ground and the art are 28% darker with a cool blue tint (never more than 30%); borders, owner bands, names, numbers and labels stay at full brightness. Cities, ports, factories, forts, trains and ships show small warm lights; fires and blasts glow brighter. Plain land stays dark.';
  head.append(t, note);
  sec.append(head);
  root.append(sec);
  const dpr = Math.min(3, Math.max(1, Math.round(window.devicePixelRatio || 1)));
  const w = buildWorld();
  const sc = buildScene(w);
  const c: Ctx = { w, sc, owned: new Backdrop(w, w.mirror), bare: new Backdrop(w, w.bare), dpr };
  const jobs: (() => void)[] = [];
  const canvas = (cw: number, ch: number, label: string, tag: string): HTMLCanvasElement => {
    const cv = document.createElement('canvas');
    cv.dataset.seasons = tag;
    cv.setAttribute('role', 'img');
    cv.setAttribute('aria-label', label);
    cv.style.cssText = `display:block;border-radius:8px;max-width:100%;width:${cw}px;height:${ch}px`;
    cv.width = cw * dpr;
    cv.height = ch * dpr;
    return cv;
  };
  const center: P = [MW / 2, MH / 2];

  // ---- the picker: a season and a time of day, then one big view
  const pick = { season: SEASON.summer as number, tod: TIMES.noon as number, playing: false };
  const ctrl = document.createElement('div');
  ctrl.style.cssText = 'display:flex;flex-wrap:wrap;gap:10px 18px;align-items:center;margin-top:12px';
  const seasonRead = document.createElement('span');
  const timeRead = document.createElement('span');
  for (const r of [seasonRead, timeRead]) r.style.cssText = 'color:var(--text);font-weight:600;min-width:170px';
  const seasonSlider = document.createElement('input');
  seasonSlider.type = 'range';
  seasonSlider.min = '0';
  seasonSlider.max = '3.95';
  seasonSlider.step = '0.05';
  seasonSlider.setAttribute('aria-label', 'Season, from spring through summer and autumn to winter');
  const timeSlider = document.createElement('input');
  timeSlider.type = 'range';
  timeSlider.min = '0';
  timeSlider.max = '0.995';
  timeSlider.step = '0.005';
  timeSlider.setAttribute('aria-label', 'Time of day, in seconds of the 120 s day');
  const big = canvas(800, 512, 'The region in the picked season and time of day', 'pick');
  let pending = false;
  const redraw = (): void => {
    seasonSlider.value = String(pick.season);
    timeSlider.value = String(pick.tod);
    seasonRead.textContent = `Season: ${seasonName(pick.season)}`;
    timeRead.textContent = `Time: ${dayName(pick.tod)}, ${clock(pick.tod)} of the 120 s day`;
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => {
      pending = false;
      renderPanel(big, c, center, 16, { season: pick.season, tod: pick.tod });
    });
  };
  const seasons = segRow('Season', [['0', ICONS.spring, 'Spring'], ['1', ICONS.summer, 'Summer'], ['2', ICONS.autumn, 'Autumn'], ['3', ICONS.winter, 'Winter']] as const, (v) => {
    pick.season = Number(v);
    redraw();
  });
  const times = segRow('Time of day', [['dawn', ICONS.dawn, 'Dawn'], ['noon', ICONS.noon, 'Noon'], ['dusk', ICONS.dusk, 'Dusk'], ['night', ICONS.night, 'Night']] as const, (v) => {
    pick.tod = TIMES[v];
    redraw();
  });
  seasons.set('1');
  times.set('noon');
  seasonSlider.addEventListener('input', () => {
    pick.season = Number(seasonSlider.value);
    seasons.set(Number.isInteger(pick.season) ? (String(pick.season) as '0') : null);
    redraw();
  });
  timeSlider.addEventListener('input', () => {
    pick.tod = Number(timeSlider.value);
    times.set(null);
    redraw();
  });
  const play = iconButton(ICONS.play, 'Play the day');
  play.className = 'al-btn';
  play.setAttribute('aria-pressed', 'false');
  let last = 0;
  const tick = (now: number): void => {
    if (!pick.playing) return;
    if (last) pick.tod = (pick.tod + (now - last) / 1000 / DAY_SECONDS) % 1;
    last = now;
    times.set(null);
    redraw();
    requestAnimationFrame(tick);
  };
  play.addEventListener('click', () => {
    pick.playing = !pick.playing;
    play.setAttribute('aria-pressed', String(pick.playing));
    play.innerHTML = pick.playing ? ICONS.pause : ICONS.play;
    const s = document.createElement('span');
    s.textContent = pick.playing ? 'Pause the day' : 'Play the day';
    play.append(s);
    last = 0;
    if (pick.playing) requestAnimationFrame(tick);
  });
  const fieldOf = (label: string, ...kids: HTMLElement[]): HTMLElement => {
    const f = document.createElement('div');
    f.className = 'al-field';
    const l = document.createElement('span');
    l.className = 'al-field-label';
    l.textContent = label;
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;flex-wrap:wrap;gap:8px 12px;align-items:center';
    row.append(...kids);
    f.append(l, row);
    return f;
  };
  ctrl.append(fieldOf('Season', seasons.el, seasonSlider, seasonRead), fieldOf('Time of day', times.el, timeSlider, timeRead, play));
  const pickBlk = document.createElement('div');
  pickBlk.dataset.seasons = 'picker';
  pickBlk.append(ctrl);
  const bigWrap = document.createElement('div');
  bigWrap.style.cssText = 'margin-top:10px';
  bigWrap.append(big);
  pickBlk.append(bigWrap);
  sec.append(pickBlk);
  jobs.push(redraw);

  // ---- the comparison sheet
  const sheet = document.createElement('div');
  sheet.dataset.seasons = 'sheet';
  sheet.style.cssText = 'margin-top:22px;padding:14px;background:#0a0e14;display:grid;width:max-content;grid-template-columns:repeat(4,500px);gap:6px 12px';
  const SW = 500;
  const SH = 320;
  const group = (title: string): void => {
    const h = document.createElement('h3');
    h.textContent = title;
    h.style.cssText = 'grid-column:1/-1;margin:12px 0 0;font-size:15px';
    sheet.append(h);
  };
  const fig = (cap: string, look: Look, tag: string, timeMs = 1200): void => {
    const f = document.createElement('div');
    const p = document.createElement('p');
    p.textContent = cap;
    p.style.cssText = 'margin:0 0 3px;font-weight:600;color:var(--text)';
    const cv = canvas(SW, SH, cap, tag);
    f.append(p, cv);
    sheet.append(f);
    jobs.push(() => renderPanel(cv, c, center, SHEET_ZOOM, look, timeMs));
  };
  group('Today: the map as the game draws it now');
  fig('Today (no seasons, no night)', { season: null, tod: null }, 'today');
  group('The four seasons at noon');
  fig('Spring, noon', { season: SEASON.spring + 0.15, tod: TIMES.noon }, 'spring');
  fig('Summer, noon', { season: SEASON.summer, tod: TIMES.noon }, 'summer');
  fig('Autumn, noon', { season: SEASON.autumn, tod: TIMES.noon }, 'autumn');
  fig('Winter, noon', { season: SEASON.winter, tod: TIMES.noon }, 'winter');
  group('A summer day: dawn, noon, dusk and night (2 min: 90 s day, 30 s night)');
  fig(`Summer dawn (${clock(TIMES.dawn)})`, { season: SEASON.summer, tod: TIMES.dawn }, 'dawn');
  fig(`Summer noon (${clock(TIMES.noon)})`, { season: SEASON.summer, tod: TIMES.noon }, 'noon');
  fig(`Summer dusk (${clock(TIMES.dusk)})`, { season: SEASON.summer, tod: TIMES.dusk }, 'dusk');
  fig(`Summer night (${clock(TIMES.night)})`, { season: SEASON.summer, tod: TIMES.night }, 'night');
  group('Night in winter and in summer');
  fig('Winter night', { season: SEASON.winter, tod: TIMES.night }, 'winter-night');
  fig('Summer night', { season: SEASON.summer, tod: TIMES.night }, 'summer-night');
  group('The winter snow line moving south: early, mid and deep winter');
  fig('Early winter (season 2.55)', { season: 2.55, tod: TIMES.noon }, 'snow-early');
  fig('Mid winter (season 2.80)', { season: 2.8, tod: TIMES.noon }, 'snow-mid');
  fig('Deep winter (season 3.00)', { season: 3, tod: TIMES.noon }, 'snow-deep');
  sec.append(sheet);

  // ---- close-ups at twice the sheet's zoom
  const closes = document.createElement('div');
  closes.style.cssText = 'margin-top:22px;display:grid;grid-template-columns:repeat(2,480px);gap:14px 14px';
  const close = (cap: string, at: P, look: Look, tag: string, timeMs = 1200): void => {
    const f = document.createElement('div');
    f.dataset.seasons = tag;
    f.style.cssText = 'padding:8px;background:#0a0e14';
    const p = document.createElement('p');
    p.textContent = cap;
    p.style.cssText = 'margin:0 0 3px;font-weight:600;color:var(--text)';
    const cv = canvas(480, 300, cap, `${tag}-canvas`);
    f.append(p, cv);
    closes.append(f);
    jobs.push(() => renderPanel(cv, c, at, CLOSE_ZOOM, look, timeMs));
  };
  close('Close look: a summer night, the capital, the port and a train', [12.5, 17.5], { season: SEASON.summer, tod: TIMES.night }, 'close-city');
  close('Close look: the polar coast in deep winter, sea ice along the shore', [22, 5.5], { season: SEASON.winter, tod: TIMES.noon }, 'close-polar');
  close('Close look: autumn woods and fields', [42, 17.5], { season: SEASON.autumn, tod: TIMES.noon }, 'close-autumn');
  close('Close look: night fire on the factory and a shell blast on the border', [33.5, 26], { season: SEASON.autumn, tod: TIMES.night }, 'close-fire');
  sec.append(closes);

  // the ground textures build in slices between frames: draw once the shader's ground is ready
  const drawAll = (): void => {
    for (const j of jobs) j();
  };
  let tries = 0;
  const wait = (): void => {
    if (c.owned.ready || !c.owned.gl || tries++ > 600) {
      const gd = groundBuilt(w.map, DEFAULT_THEME);
      if (gd) {
        w.heightAt = (qx, qy) => {
          const fx = Math.max(0, Math.min(MW - 1.001, qx - 0.5));
          const fy = Math.max(0, Math.min(MH - 1.001, qy - 0.5));
          const ix = Math.floor(fx);
          const iy = Math.floor(fy);
          const ux = fx - ix;
          const uy = fy - iy;
          const at = (x: number, y: number): number => gd.data[(y * MW + x) * 4 + 1] / 255;
          return (at(ix, iy) * (1 - ux) + at(ix + 1, iy) * ux) * (1 - uy) + (at(ix, iy + 1) * (1 - ux) + at(ix + 1, iy + 1) * ux) * uy;
        };
        pixelCache.clear();
      }
      requestAnimationFrame(() => {
        drawAll();
        void document.fonts?.ready.then(() => {
          drawAll();
          sec.dataset.ready = '1';
        });
      });
      return;
    }
    requestAnimationFrame(wait);
  };
  requestAnimationFrame(() => {
    // a first draw starts the ground build (the map layer asks for it when it draws)
    const cv = document.createElement('canvas');
    cv.width = 8;
    cv.height = 8;
    const x = cv.getContext('2d');
    if (x) {
      c.owned.draw(x, center[0], center[1], SHEET_ZOOM, 8, 8, 1, 0);
      c.bare.draw(x, center[0], center[1], SHEET_ZOOM, 8, 8, 1, 0);
    }
    wait();
  });
  return sec;
}
