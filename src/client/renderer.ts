// Canvas renderer: terrain, territory, borders, buildings, units, fronts, effects, overlays, minimap.
//
// Layers that cover the whole map are offscreen canvases with 1 pixel per tile, drawn scaled through the camera
// transform with image smoothing off:
//   terrain   built once in setGame (colours + noise + water depth + coast highlight)
//   resources built once (deposit tint, shown with the resource overlay when zoomed out)
//   territory updated incrementally: map.owner (and the fallout flag) is diffed against a copy every frame and
//             only changed tiles and their 4-neighbours are recomputed and uploaded (dirty rectangle)
//   supply    own territory tinted by supply distance, rebuilt about once a second while the overlay is on
//   spawn     valid spawn area, rebuilt twice a second during the spawn phase
// Everything else (buildings, units, fronts, effects, names, previews) is drawn per frame in screen space and
// culled to the visible tile window, so no per-frame work scales with the map size except the owner diff.
import { buildingAt, canBuild, hasIntel } from '../sim/buildings';
import {
  ATOM_CORE_RADIUS,
  ATOM_RADIUS,
  BOMBER_RADIUS,
  BUILDINGS,
  FORT_RADIUS_TECH,
  RESOURCE_COLORS,
  ROCKET_RADIUS,
  SUPPLY_RANGE,
  TERRAIN,
  TICKS_PER_SECOND,
} from '../sim/config';
import { armyTotal } from '../sim/economy';
import { SPAWN_MIN_DISTANCE } from '../sim/state';
import { hasTech } from '../sim/tech';
import { isWater } from '../sim/types';
import type { Attack, Building, BuildingType, Effect, GameState, MapData, Player, TerrainId, Unit } from '../sim/types';
import type { Camera } from './camera';
import type { UiState } from './uiState';

type RGB = [number, number, number];

const BACKGROUND = '#0a111c';
const TERRITORY_ALPHA = 140; // ~0.55 owner colour over terrain
const FALLOUT_RGB: RGB = [128, 142, 104];
const BUILDING_ZOOM = 2.5; // building icons from this zoom on
const RESOURCE_MARKER_ZOOM = 6; // resource markers instead of tint from this zoom on
const EFFECT_SECONDS = 1.5;
const FRONT_REFRESH_FRAMES = 8;
const FRONT_RADIUS = 40; // scan window around the attack focus
const FRONT_RADIUS_FAR = 90; // second try when the near window holds no frontier
const FRONT_MAX_TILES = 4000;
const FRONT_MAX_ATTACKS = 24;
const NAMES_REFRESH_MS = 1000;
const MINIMAP_REFRESH_MS = 500;
const SUPPLY_REFRESH_MS = 1000;
const SPAWN_REFRESH_MS = 500;
/** The spawn rule in state.canSpawnAt (min distance to other spawned capitals). */
const SPAWN_MIN_DIST = SPAWN_MIN_DISTANCE;
const MINIMAP_CSS_W = 220;
const RING_TYPES: readonly BuildingType[] = ['fort', 'sam', 'airfield', 'watchtower'];

type Shape = 'circle' | 'square' | 'diamond';
/** Icon per building: short label, outline shape (economy circle, military square, strategic diamond), fill. */
const GLYPHS: Record<BuildingType, { label: string; shape: Shape; fill: string }> = {
  city: { label: 'C', shape: 'circle', fill: '#f3ecd8' },
  farm: { label: 'Fa', shape: 'circle', fill: '#c9e08a' },
  market: { label: '$', shape: 'circle', fill: '#f2d36b' },
  mine: { label: 'Mi', shape: 'circle', fill: '#b4b7bf' },
  oilWell: { label: 'Oi', shape: 'circle', fill: '#8a8178' },
  barracks: { label: 'Ba', shape: 'square', fill: '#d9b48a' },
  factory: { label: 'Fy', shape: 'square', fill: '#c0a080' },
  arsenal: { label: 'Ar', shape: 'square', fill: '#d79a7a' },
  fort: { label: 'Ft', shape: 'square', fill: '#a9b3c2' },
  supplyDepot: { label: 'Sd', shape: 'square', fill: '#b9d1a6' },
  watchtower: { label: 'W', shape: 'square', fill: '#d4e2ee' },
  port: { label: 'Po', shape: 'circle', fill: '#9cc6ea' },
  lab: { label: 'Rl', shape: 'circle', fill: '#c6b3ee' },
  hospital: { label: '+', shape: 'circle', fill: '#f2f2f2' },
  airfield: { label: 'Af', shape: 'diamond', fill: '#b6d7f0' },
  sam: { label: 'SA', shape: 'diamond', fill: '#e6a6a6' },
  silo: { label: 'Si', shape: 'diamond', fill: '#eec07a' },
};

interface FrontCache {
  tiles: Int32Array;
  frame: number;
}
interface UnitTrack {
  px: number;
  py: number;
  cx: number;
  cy: number;
  angle: number;
  seen: number;
}
interface NameLabel {
  id: number;
  x: number; // tile coords of the label anchor
  y: number;
  tiles: number;
}

function makeCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = Math.max(1, w);
  c.height = Math.max(1, h);
  return c;
}
function ctx2d(c: HTMLCanvasElement, opts?: CanvasRenderingContext2DSettings): CanvasRenderingContext2D {
  const ctx = c.getContext('2d', opts);
  if (!ctx) throw new Error('2D canvas not supported');
  return ctx;
}
/** Deterministic 32-bit integer hash -> [0, 1). */
function hash01(v: number): number {
  let x = v | 0;
  x = Math.imul(x ^ (x >>> 16), 0x7feb352d);
  x = Math.imul(x ^ (x >>> 15), 0x846ca68b);
  x ^= x >>> 16;
  return (x >>> 0) / 4294967296;
}
function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
function css(c: RGB, a = 1): string {
  return a >= 1 ? `rgb(${c[0]},${c[1]},${c[2]})` : `rgba(${c[0]},${c[1]},${c[2]},${a})`;
}
function shade(c: RGB, f: number): RGB {
  return [clamp(Math.round(c[0] * f), 0, 255), clamp(Math.round(c[1] * f), 0, 255), clamp(Math.round(c[2] * f), 0, 255)];
}
function mix(a: RGB, b: RGB, t: number): RGB {
  return [Math.round(a[0] + (b[0] - a[0]) * t), Math.round(a[1] + (b[1] - a[1]) * t), Math.round(a[2] + (b[2] - a[2]) * t)];
}
export function formatCount(n: number): string {
  const v = Math.max(0, n);
  if (v < 1000) return String(Math.round(v));
  if (v < 1e6) return (v / 1000).toFixed(v < 1e4 ? 1 : 0) + 'k';
  return (v / 1e6).toFixed(v < 1e7 ? 2 : 1) + 'M';
}

export class Renderer {
  private ctx: CanvasRenderingContext2D;
  private mmCtx: CanvasRenderingContext2D;
  private dpr = 1;
  private cssW = 0;
  private cssH = 0;

  private map: MapData | null = null;
  private w = 0;
  private h = 0;
  private humanId = 0;

  private terrainCv: HTMLCanvasElement | null = null;
  private resourceCv: HTMLCanvasElement | null = null;
  private territoryCv: HTMLCanvasElement | null = null;
  private territoryCtx: CanvasRenderingContext2D | null = null;
  private territoryImg: ImageData | null = null;
  private ownerCopy = new Uint16Array(0);
  private falloutCopy = new Uint8Array(0);
  private changed = new Int32Array(0);
  private territoryFull = true;
  /** RGBA per player id: interior, border, and the human's border */
  private fillPal = new Uint8Array(0);
  private borderPal = new Uint8Array(0);
  private humanBorder: [number, number, number, number] = [255, 255, 255, 255];
  private colorCss: string[] = [];
  private darkCss: string[] = [];

  private supplyCv: HTMLCanvasElement | null = null;
  private supplyArr: Uint16Array | null = null;
  private supplyMs = -Infinity;
  private spawnCv: HTMLCanvasElement | null = null;
  private spawnMs = -Infinity;

  private mmBase: HTMLCanvasElement | null = null;
  private mmCssW = MINIMAP_CSS_W;
  private mmCssH = 147;
  private mmMs = -Infinity;

  private labels: NameLabel[] = [];
  private labelsMs = -Infinity;
  private fronts = new Map<number, FrontCache>();
  private frontScratch = new Int32Array(FRONT_MAX_TILES);
  private frame = 0;
  private tracks = new Map<number, UnitTrack>();
  private lastTick = -1;
  private lastTickMs = 0;
  private buildCheck = { key: '', ok: false };

  constructor(public canvas: HTMLCanvasElement, public minimap: HTMLCanvasElement) {
    this.ctx = ctx2d(canvas, { alpha: false });
    this.mmCtx = ctx2d(minimap);
  }

  /** Call once per new game (builds the terrain image). */
  setGame(state: GameState): void {
    const map = state.map;
    this.map = map;
    this.w = map.width;
    this.h = map.height;
    this.humanId = state.humanId;
    const n = map.width * map.height;

    this.terrainCv = this.buildTerrain(map);
    this.resourceCv = this.buildResources(map);
    this.territoryCv = makeCanvas(map.width, map.height);
    this.territoryCtx = ctx2d(this.territoryCv);
    this.territoryImg = this.territoryCtx.createImageData(map.width, map.height);
    this.ownerCopy = new Uint16Array(n);
    this.falloutCopy = new Uint8Array(n);
    this.changed = new Int32Array(n);
    this.territoryFull = true;
    this.buildPalette(state);

    this.supplyCv = makeCanvas(map.width, map.height);
    this.supplyArr = null;
    this.supplyMs = -Infinity;
    this.spawnCv = makeCanvas(map.width, map.height);
    this.spawnMs = -Infinity;
    this.labels = [];
    this.labelsMs = -Infinity;
    this.fronts.clear();
    this.tracks.clear();
    this.lastTick = -1;
    this.buildCheck = { key: '', ok: false };

    // Minimap keeps the map's aspect ratio at a fixed CSS width.
    const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
    this.mmCssW = MINIMAP_CSS_W;
    this.mmCssH = Math.max(1, Math.round((MINIMAP_CSS_W * map.height) / map.width));
    this.minimap.style.width = `${this.mmCssW}px`;
    this.minimap.style.height = `${this.mmCssH}px`;
    this.minimap.width = Math.round(this.mmCssW * dpr);
    this.minimap.height = Math.round(this.mmCssH * dpr);
    this.mmBase = makeCanvas(this.minimap.width, this.minimap.height);
    this.mmMs = -Infinity;
  }

  /** Draws a frame. Diffs map.owner against its own copy to update only changed tiles of the territory layer. */
  render(state: GameState, camera: Camera, ui: UiState, nowMs: number): void {
    if (state.map !== this.map) this.setGame(state);
    if (state.players.length * 4 > this.fillPal.length) this.buildPalette(state);
    this.frame++;
    this.resizeIfNeeded(camera);
    this.trackTicks(state, nowMs);
    this.updateTerritory(state);

    const ctx = this.ctx;
    const z = camera.zoom;
    const view = camera.visibleTiles(1);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = BACKGROUND;
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

    // ---- map layers in world space ----
    this.setWorld(camera);
    ctx.imageSmoothingEnabled = false;
    this.drawLayer(this.terrainCv, view);
    if (ui.showResources && z < RESOURCE_MARKER_ZOOM) this.drawLayer(this.resourceCv, view, 0.8);
    this.drawLayer(this.territoryCv, view);
    if (ui.showSupply && this.humanId > 0) {
      this.updateSupplyLayer(state, nowMs);
      if (this.supplyArr) this.drawLayer(this.supplyCv, view);
    }
    if (state.phase === 'spawn') {
      this.updateSpawnLayer(state, nowMs);
      this.drawLayer(this.spawnCv, view);
    }
    this.drawFronts(state, camera, view, nowMs);

    // ---- everything else in screen space ----
    this.setScreen();
    if (z >= RESOURCE_MARKER_ZOOM) this.drawResourceMarkers(state, camera, view);
    this.drawRings(state, camera, ui);
    if (z >= BUILDING_ZOOM) this.drawBuildings(state, camera, view);
    this.drawCapitals(state, camera, view);
    const frac = this.subTick(nowMs, ui);
    this.drawUnits(state, camera, frac);
    this.drawEffects(state, camera, frac);
    this.drawNames(state, camera, nowMs);
    this.drawHoverAndPreview(state, camera, ui);

    this.drawMinimap(state, camera, nowMs);
  }

  /** Minimap click -> tile coords, or null if outside. */
  minimapToTile(mx: number, my: number): { x: number; y: number } | null {
    if (!this.map) return null;
    if (mx < 0 || my < 0 || mx >= this.mmCssW || my >= this.mmCssH) return null;
    return { x: (mx / this.mmCssW) * this.w, y: (my / this.mmCssH) * this.h };
  }

  // ------------------------------------------------------------------ setup

  private resizeIfNeeded(camera: Camera): void {
    const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
    // CSS size; if the canvas is not laid out (0), keep the last size rather than reading the dpr-scaled backing size
    const cw = this.canvas.clientWidth || this.cssW || this.canvas.width;
    const ch = this.canvas.clientHeight || this.cssH || this.canvas.height;
    if (cw !== this.cssW || ch !== this.cssH || dpr !== this.dpr) {
      this.cssW = cw;
      this.cssH = ch;
      this.dpr = dpr;
      this.canvas.width = Math.max(1, Math.round(cw * dpr));
      this.canvas.height = Math.max(1, Math.round(ch * dpr));
    }
    if (camera.viewW !== cw || camera.viewH !== ch) camera.resize(cw, ch);
  }

  private setWorld(cam: Camera): void {
    const d = this.dpr;
    const z = cam.zoom;
    this.ctx.setTransform(d * z, 0, 0, d * z, d * (cam.viewW / 2 - cam.x * z), d * (cam.viewH / 2 - cam.y * z));
  }
  private setScreen(): void {
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
  }
  /** Draws the visible part of a 1-px-per-tile layer (world transform must be set). */
  private drawLayer(cv: HTMLCanvasElement | null, v: { x0: number; y0: number; x1: number; y1: number }, alpha = 1): void {
    if (!cv || v.x1 <= v.x0 || v.y1 <= v.y0) return;
    const ctx = this.ctx;
    ctx.globalAlpha = alpha;
    const sw = v.x1 - v.x0;
    const sh = v.y1 - v.y0;
    ctx.drawImage(cv, v.x0, v.y0, sw, sh, v.x0, v.y0, sw, sh);
    ctx.globalAlpha = 1;
  }

  private buildPalette(state: GameState): void {
    const n = state.players.length;
    this.fillPal = new Uint8Array(n * 4);
    this.borderPal = new Uint8Array(n * 4);
    this.colorCss = [];
    this.darkCss = [];
    for (let id = 0; id < n; id++) {
      const c: RGB = state.players[id]?.color ?? [128, 128, 128];
      const b = shade(c, 0.62);
      this.fillPal.set([c[0], c[1], c[2], TERRITORY_ALPHA], id * 4);
      this.borderPal.set([b[0], b[1], b[2], 255], id * 4);
      this.colorCss[id] = css(c);
      this.darkCss[id] = css(shade(c, 0.5));
      if (id === state.humanId && id > 0) {
        const hb = mix(shade(c, 0.85), [255, 255, 255], 0.3);
        this.humanBorder = [hb[0], hb[1], hb[2], 255];
      }
    }
  }

  private buildTerrain(map: MapData): HTMLCanvasElement {
    const { width: w, height: h, terrain } = map;
    const n = w * h;
    // Distance of water tiles to land (BFS, capped) for depth shading and the shoreline highlight.
    const MAXD = 16;
    const dist = new Uint8Array(n).fill(255);
    const queue = new Int32Array(n);
    let qh = 0;
    let qt = 0;
    for (let i = 0; i < n; i++) {
      if (!isWater(terrain[i])) {
        dist[i] = 0;
        queue[qt++] = i;
      }
    }
    while (qh < qt) {
      const i = queue[qh++];
      const d = dist[i] + 1;
      if (d > MAXD) continue;
      const x = i % w;
      if (x > 0 && dist[i - 1] > d) { dist[i - 1] = d; queue[qt++] = i - 1; }
      if (x < w - 1 && dist[i + 1] > d) { dist[i + 1] = d; queue[qt++] = i + 1; }
      if (i >= w && dist[i - w] > d) { dist[i - w] = d; queue[qt++] = i - w; }
      if (i + w < n && dist[i + w] > d) { dist[i + w] = d; queue[qt++] = i + w; }
    }

    const cv = makeCanvas(w, h);
    const ctx = ctx2d(cv);
    const img = ctx.createImageData(w, h);
    const px = img.data;
    const sand: RGB = [222, 208, 160];
    for (let i = 0; i < n; i++) {
      const t = terrain[i];
      const info = TERRAIN[t as TerrainId] ?? TERRAIN[2];
      const x = i % w;
      const y = (i / w) | 0;
      // per-tile grain plus a coarser 4x4 mottling, both deterministic
      const grain = hash01(i * 7919 + 13) - 0.5;
      const mottle = hash01(((y >> 2) * 4099 + (x >> 2)) * 31 + 7) - 0.5;
      let c: RGB = info.color;
      let f: number;
      if (isWater(t)) {
        const d = Math.min(dist[i], MAXD);
        f = 1 + grain * 0.03 + mottle * 0.03;
        f *= 1 - (d / MAXD) * (t === 0 ? 0.3 : 0.12); // deeper = darker
        if (d === 1) f *= 1.14; // light shoreline foam
      } else {
        f = 1 + grain * 0.07 + mottle * 0.05;
        const coast =
          (x > 0 && isWater(terrain[i - 1])) ||
          (x < w - 1 && isWater(terrain[i + 1])) ||
          (i >= w && isWater(terrain[i - w])) ||
          (i + w < n && isWater(terrain[i + w]));
        if (coast) {
          c = mix(c, sand, 0.25);
          f *= 1.08;
        }
      }
      const o = i * 4;
      px[o] = clamp(c[0] * f, 0, 255);
      px[o + 1] = clamp(c[1] * f, 0, 255);
      px[o + 2] = clamp(c[2] * f, 0, 255);
      px[o + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    return cv;
  }

  private buildResources(map: MapData): HTMLCanvasElement {
    const { width: w, height: h, resource } = map;
    const cv = makeCanvas(w, h);
    const ctx = ctx2d(cv);
    const img = ctx.createImageData(w, h);
    const px = img.data;
    for (let i = 0; i < w * h; i++) {
      const c = RESOURCE_COLORS[resource[i]];
      if (!c) continue;
      const o = i * 4;
      px[o] = c[0];
      px[o + 1] = c[1];
      px[o + 2] = c[2];
      px[o + 3] = 200;
    }
    ctx.putImageData(img, 0, 0);
    return cv;
  }

  // ------------------------------------------------------------------ territory

  private updateTerritory(state: GameState): void {
    const map = state.map;
    const img = this.territoryImg;
    const tctx = this.territoryCtx;
    if (!img || !tctx) return;
    const owner = map.owner;
    const fallout = map.fallout;
    const copy = this.ownerCopy;
    const fcopy = this.falloutCopy;
    const n = owner.length;
    const w = this.w;

    if (this.territoryFull) {
      this.territoryFull = false;
      for (let i = 0; i < n; i++) {
        copy[i] = owner[i];
        fcopy[i] = fallout[i] > 0 ? 1 : 0;
      }
      for (let i = 0; i < n; i++) this.territoryPixel(map, i);
      tctx.putImageData(img, 0, 0);
      return;
    }

    // Cheap diff: one tight pass over the typed arrays.
    const changed = this.changed;
    let count = 0;
    for (let i = 0; i < n; i++) {
      const o = owner[i];
      const f = fallout[i] > 0 ? 1 : 0;
      if (o !== copy[i] || f !== fcopy[i]) {
        copy[i] = o;
        fcopy[i] = f;
        changed[count++] = i;
      }
    }
    if (count === 0) return;
    if (count > n / 4) {
      for (let i = 0; i < n; i++) this.territoryPixel(map, i);
      tctx.putImageData(img, 0, 0);
      return;
    }
    // Recompute changed tiles and their neighbours (their border state may have changed).
    let minX = w;
    let minY = this.h;
    let maxX = -1;
    let maxY = -1;
    for (let k = 0; k < count; k++) {
      const i = changed[k];
      const x = i % w;
      const y = (i / w) | 0;
      this.territoryPixel(map, i);
      if (x > 0) this.territoryPixel(map, i - 1);
      if (x < w - 1) this.territoryPixel(map, i + 1);
      if (y > 0) this.territoryPixel(map, i - w);
      if (y < this.h - 1) this.territoryPixel(map, i + w);
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    minX = Math.max(0, minX - 1);
    minY = Math.max(0, minY - 1);
    maxX = Math.min(w - 1, maxX + 1);
    maxY = Math.min(this.h - 1, maxY + 1);
    tctx.putImageData(img, 0, 0, minX, minY, maxX - minX + 1, maxY - minY + 1);
  }

  /** Writes one tile of the territory image: owner tint, opaque darker border, fallout tint. */
  private territoryPixel(map: MapData, i: number): void {
    const px = this.territoryImg!.data;
    const owner = map.owner;
    const w = this.w;
    const n = owner.length;
    const o = owner[i];
    let r = 0;
    let g = 0;
    let b = 0;
    let a = 0;
    if (o !== 0) {
      const x = i % w;
      const border =
        (x > 0 && owner[i - 1] !== o) ||
        (x < w - 1 && owner[i + 1] !== o) ||
        (i >= w && owner[i - w] !== o) ||
        (i + w < n && owner[i + w] !== o);
      const o4 = o * 4;
      if (border) {
        if (o === this.humanId) {
          [r, g, b, a] = this.humanBorder;
        } else {
          const p = this.borderPal;
          r = p[o4]; g = p[o4 + 1]; b = p[o4 + 2]; a = p[o4 + 3];
        }
      } else {
        const p = this.fillPal;
        r = p[o4]; g = p[o4 + 1]; b = p[o4 + 2]; a = p[o4 + 3];
      }
    }
    if (map.fallout[i] > 0) {
      const t = a === 0 ? 1 : 0.6;
      r = r + (FALLOUT_RGB[0] - r) * t;
      g = g + (FALLOUT_RGB[1] - g) * t;
      b = b + (FALLOUT_RGB[2] - b) * t;
      a = Math.max(a, 190);
    }
    const k = i * 4;
    px[k] = r;
    px[k + 1] = g;
    px[k + 2] = b;
    px[k + 3] = a;
  }

  // ------------------------------------------------------------------ overlays

  private supplyRange(state: GameState): number {
    const p = state.players[this.humanId];
    return SUPPLY_RANGE * (p && hasTech(p, 'logistics') ? 1.5 : 1);
  }

  /** Own territory tinted green (in supply range) -> yellow/orange -> red (beyond 3x range). */
  private updateSupplyLayer(state: GameState, nowMs: number): void {
    const arr = state.supplyDist.get(this.humanId) ?? null;
    if (!arr || !this.supplyCv) {
      this.supplyArr = null;
      return;
    }
    if (arr === this.supplyArr && nowMs - this.supplyMs < SUPPLY_REFRESH_MS) return;
    this.supplyArr = arr;
    this.supplyMs = nowMs;
    const ctx = ctx2d(this.supplyCv);
    const img = ctx.createImageData(this.w, this.h);
    const px = img.data;
    const owner = state.map.owner;
    const range = this.supplyRange(state);
    const me = this.humanId;
    for (let i = 0; i < owner.length; i++) {
      if (owner[i] !== me) continue;
      const d = arr[i];
      const k = i * 4;
      if (d <= range) {
        px[k] = 60; px[k + 1] = 210; px[k + 2] = 90; px[k + 3] = 80;
      } else if (d <= 3 * range) {
        const t = (d - range) / (2 * range); // yellow -> orange
        px[k] = 235; px[k + 1] = 215 - 85 * t; px[k + 2] = 60 - 20 * t; px[k + 3] = 100;
      } else {
        px[k] = 225; px[k + 1] = 45; px[k + 2] = 40; px[k + 3] = 130;
      }
    }
    ctx.putImageData(img, 0, 0);
  }

  /** Spawn phase: light tint on free land; red-ish discs where other capitals block spawning. */
  private updateSpawnLayer(state: GameState, nowMs: number): void {
    if (!this.spawnCv || nowMs - this.spawnMs < SPAWN_REFRESH_MS) return;
    this.spawnMs = nowMs;
    const ctx = ctx2d(this.spawnCv);
    const w = this.w;
    const h = this.h;
    const img = ctx.createImageData(w, h);
    const px = img.data;
    const { terrain, owner, fallout } = state.map;
    for (let i = 0; i < terrain.length; i++) {
      if (isWater(terrain[i]) || owner[i] !== 0 || fallout[i] > 0) continue;
      const k = i * 4;
      px[k] = 255; px[k + 1] = 255; px[k + 2] = 255; px[k + 3] = 46;
    }
    const r = SPAWN_MIN_DIST;
    for (const p of state.players) {
      if (!p || p.id === 0 || p.id === this.humanId || !p.spawned || p.capital < 0) continue;
      const cx = p.capital % w;
      const cy = (p.capital / w) | 0;
      for (let y = Math.max(0, cy - r); y <= Math.min(h - 1, cy + r); y++) {
        for (let x = Math.max(0, cx - r); x <= Math.min(w - 1, cx + r); x++) {
          const dx = x - cx;
          const dy = y - cy;
          if (dx * dx + dy * dy >= r * r) continue;
          const i = y * w + x;
          if (isWater(terrain[i])) continue;
          const k = i * 4;
          px[k] = 200; px[k + 1] = 40; px[k + 2] = 40; px[k + 3] = 60;
        }
      }
    }
    ctx.putImageData(img, 0, 0);
  }

  private drawResourceMarkers(state: GameState, cam: Camera, v: { x0: number; y0: number; x1: number; y1: number }): void {
    const ctx = this.ctx;
    const res = state.map.resource;
    const z = cam.zoom;
    const s = Math.max(2, z * 0.22);
    const ox = cam.viewW / 2 - cam.x * z;
    const oy = cam.viewH / 2 - cam.y * z;
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(0,0,0,0.55)';
    for (let y = v.y0; y < v.y1; y++) {
      const row = y * this.w;
      for (let x = v.x0; x < v.x1; x++) {
        const r = res[row + x];
        if (r === 0) continue;
        const cx = ox + (x + 0.5) * z;
        const cy = oy + (y + 0.5) * z;
        const c = RESOURCE_COLORS[r];
        if (!c) continue;
        ctx.fillStyle = css(c);
        ctx.beginPath();
        if (r === 1) {
          ctx.rect(cx - s, cy - s, 2 * s, 2 * s); // iron: ingot square
        } else if (r === 2) {
          // oil: drop
          ctx.moveTo(cx, cy - s * 1.4);
          ctx.quadraticCurveTo(cx + s * 1.1, cy + s * 0.2, cx, cy + s);
          ctx.quadraticCurveTo(cx - s * 1.1, cy + s * 0.2, cx, cy - s * 1.4);
        } else {
          ctx.arc(cx, cy, s * 0.9, 0, Math.PI * 2); // fertile: dot
        }
        ctx.fill();
        ctx.stroke();
      }
    }
  }

  // ------------------------------------------------------------------ attack fronts

  private isFrontAttack(state: GameState, a: Attack, cam: Camera, v: { x0: number; y0: number; x1: number; y1: number }): boolean {
    const me = this.humanId;
    if (me > 0 && (a.attacker === me || a.target === me)) return true;
    if (cam.zoom < 2 && me > 0) return false;
    const fx = a.focusTile % this.w;
    const fy = (a.focusTile / this.w) | 0;
    const m = FRONT_RADIUS;
    return fx >= v.x0 - m && fx < v.x1 + m && fy >= v.y0 - m && fy < v.y1 + m;
  }

  /** Frontier tiles (target tiles 4-adjacent to the attacker) in a window around the attack focus. */
  private scanFront(state: GameState, a: Attack): Int32Array {
    const { owner, terrain } = state.map;
    const w = this.w;
    const h = this.h;
    const n = owner.length;
    const att = a.attacker;
    const tgt = a.target;
    const fx = a.focusTile % w;
    const fy = (a.focusTile / w) | 0;
    const out = this.frontScratch;
    let count = 0;
    for (const R of [FRONT_RADIUS, FRONT_RADIUS_FAR]) {
      count = 0;
      const y0 = Math.max(0, fy - R);
      const y1 = Math.min(h - 1, fy + R);
      const x0 = Math.max(0, fx - R);
      const x1 = Math.min(w - 1, fx + R);
      for (let y = y0; y <= y1 && count < FRONT_MAX_TILES; y++) {
        for (let x = x0; x <= x1; x++) {
          const i = y * w + x;
          if (owner[i] !== tgt || (tgt === 0 && isWater(terrain[i]))) continue;
          if (
            (x > 0 && owner[i - 1] === att) ||
            (x < w - 1 && owner[i + 1] === att) ||
            (i >= w && owner[i - w] === att) ||
            (i + w < n && owner[i + w] === att)
          ) {
            out[count++] = i;
            if (count >= FRONT_MAX_TILES) break;
          }
        }
      }
      if (count > 0) break;
    }
    return out.slice(0, count);
  }

  private drawFronts(state: GameState, cam: Camera, v: { x0: number; y0: number; x1: number; y1: number }, nowMs: number): void {
    const ctx = this.ctx;
    const me = this.humanId;
    const z = cam.zoom;
    const pulse = 0.5 + 0.5 * Math.sin(nowMs / 180);
    const live = new Set<number>();
    let drawn = 0;
    for (const a of state.attacks) {
      if (drawn >= FRONT_MAX_ATTACKS) break;
      if (!this.isFrontAttack(state, a, cam, v)) continue;
      drawn++;
      live.add(a.id);
      let cache = this.fronts.get(a.id);
      // Refresh every few frames, staggered by attack id so refreshes spread over frames.
      if (!cache || (this.frame + a.id) % FRONT_REFRESH_FRAMES === 0) {
        cache = { tiles: this.scanFront(state, a), frame: this.frame };
        this.fronts.set(a.id, cache);
      }
      const tiles = cache.tiles;
      if (tiles.length === 0) continue;
      let col: string;
      if (me > 0 && a.attacker === me) col = `rgba(255,240,130,${0.45 + 0.5 * pulse})`;
      else if (me > 0 && a.target === me) col = `rgba(255,60,50,${0.5 + 0.5 * pulse})`;
      else {
        const c = state.players[a.attacker]?.color ?? [255, 255, 255];
        col = css(c as RGB, 0.35 + 0.45 * pulse);
      }
      ctx.beginPath();
      const outline = z >= 3;
      for (let k = 0; k < tiles.length; k++) {
        const i = tiles[k];
        const x = i % this.w;
        const y = (i / this.w) | 0;
        if (x < v.x0 || x >= v.x1 || y < v.y0 || y >= v.y1) continue;
        if (outline) ctx.rect(x + 0.12, y + 0.12, 0.76, 0.76);
        else ctx.rect(x, y, 1, 1);
      }
      if (outline) {
        ctx.strokeStyle = col;
        ctx.lineWidth = Math.max(1.5 / z, 0.1);
        ctx.stroke();
      } else {
        ctx.fillStyle = col;
        ctx.fill();
      }
      // focus marker for the human's own attacks
      if (me > 0 && a.attacker === me) {
        const fx = (a.focusTile % this.w) + 0.5;
        const fy = ((a.focusTile / this.w) | 0) + 0.5;
        ctx.beginPath();
        ctx.arc(fx, fy, Math.max(4 / z, 0.6), 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(255,255,255,0.8)';
        ctx.lineWidth = 1.5 / z;
        ctx.stroke();
      }
    }
    if (this.frame % 60 === 0) for (const id of this.fronts.keys()) if (!live.has(id)) this.fronts.delete(id);
  }

  // ------------------------------------------------------------------ buildings

  private ringRadius(state: GameState, type: BuildingType, owner: number): number {
    const p = state.players[owner];
    if (type === 'fort') return p && hasTech(p, 'fortification') ? FORT_RADIUS_TECH : BUILDINGS.fort.radius;
    if (type === 'watchtower') return BUILDINGS.watchtower.radius * (p && hasTech(p, 'radar') ? 2 : 1);
    return BUILDINGS[type].radius;
  }

  private drawRing(cam: Camera, tile: number, radius: number, color: RGB, strong: boolean): void {
    const ctx = this.ctx;
    const s = cam.tileToScreen((tile % this.w) + 0.5, ((tile / this.w) | 0) + 0.5);
    const r = radius * cam.zoom;
    ctx.beginPath();
    ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
    ctx.fillStyle = css(color, strong ? 0.1 : 0.05);
    ctx.fill();
    ctx.setLineDash([6, 4]);
    ctx.lineWidth = strong ? 2 : 1;
    ctx.strokeStyle = css(color, strong ? 0.9 : 0.45);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  /** Effect radius of the hovered building, or of the building being placed (plus existing ones of that type). */
  private drawRings(state: GameState, cam: Camera, ui: UiState): void {
    const hover = ui.hoverTile;
    const ringCol: RGB = [255, 255, 255];
    if (ui.mode.kind === 'build' && RING_TYPES.includes(ui.mode.building)) {
      const type = ui.mode.building;
      const me = this.humanId;
      for (const b of state.buildings.values()) {
        if (b.owner === me && b.type === type) this.drawRing(cam, b.tile, this.ringRadius(state, type, me), [180, 220, 255], false);
      }
      if (hover >= 0) this.drawRing(cam, hover, this.ringRadius(state, type, me), ringCol, true);
    }
    if (hover >= 0) {
      const b = buildingAt(state, hover);
      if (b && RING_TYPES.includes(b.type)) {
        const c = state.players[b.owner]?.color ?? ringCol;
        this.drawRing(cam, b.tile, this.ringRadius(state, b.type, b.owner), mix(c as RGB, [255, 255, 255], 0.5), true);
      }
    }
  }

  private iconRadius(z: number, type: BuildingType): number {
    const r = clamp(z * 0.7, 4.5, 13);
    return type === 'city' ? r * 1.3 : r;
  }

  private shapePath(shape: Shape, x: number, y: number, r: number): void {
    const ctx = this.ctx;
    ctx.beginPath();
    if (shape === 'circle') ctx.arc(x, y, r, 0, Math.PI * 2);
    else if (shape === 'square') ctx.rect(x - r * 0.88, y - r * 0.88, r * 1.76, r * 1.76);
    else {
      ctx.moveTo(x, y - r * 1.12);
      ctx.lineTo(x + r * 1.12, y);
      ctx.lineTo(x, y + r * 1.12);
      ctx.lineTo(x - r * 1.12, y);
      ctx.closePath();
    }
  }

  /** One building icon centred at screen (x, y). */
  private drawIcon(type: BuildingType, ownerCss: string, x: number, y: number, r: number, level: number, progress: number, hp: number): void {
    const ctx = this.ctx;
    const g = GLYPHS[type];
    const unfinished = progress < 1;
    ctx.globalAlpha = unfinished ? 0.5 : 1;
    this.shapePath(g.shape, x, y, r);
    ctx.fillStyle = g.fill;
    ctx.fill();
    ctx.lineWidth = Math.max(1.5, r * 0.22);
    ctx.strokeStyle = ownerCss;
    ctx.stroke();
    if (r >= 6.5) {
      ctx.fillStyle = '#1b1f27';
      ctx.font = `700 ${Math.round(r * (g.label.length > 1 ? 0.9 : 1.15))}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(g.label, x, y + r * 0.06);
    }
    ctx.globalAlpha = 1;
    if (type === 'city' && level > 1) {
      // level pips under the icon
      const pr = Math.max(1.3, r * 0.14);
      const total = (level - 1) * pr * 3;
      for (let k = 0; k < level; k++) {
        ctx.beginPath();
        ctx.arc(x - total / 2 + k * pr * 3, y + r + pr * 2.2, pr, 0, Math.PI * 2);
        ctx.fillStyle = '#ffe07a';
        ctx.fill();
        ctx.lineWidth = 1;
        ctx.strokeStyle = '#2a2a2a';
        ctx.stroke();
      }
    }
    if (unfinished) {
      ctx.beginPath();
      ctx.arc(x, y, r + 3, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * clamp(progress, 0, 1));
      ctx.lineWidth = 2;
      ctx.strokeStyle = 'rgba(255,255,255,0.95)';
      ctx.stroke();
    }
    if (hp < 1 && hp > 0) {
      const bw = r * 2;
      ctx.fillStyle = 'rgba(0,0,0,0.6)';
      ctx.fillRect(x - r, y - r - 5, bw, 3);
      ctx.fillStyle = hp > 0.5 ? '#e8c84a' : '#e0503c';
      ctx.fillRect(x - r, y - r - 5, bw * hp, 3);
    }
  }

  private drawBuildings(state: GameState, cam: Camera, v: { x0: number; y0: number; x1: number; y1: number }): void {
    const z = cam.zoom;
    for (const b of state.buildings.values()) {
      const x = b.tile % this.w;
      const y = (b.tile / this.w) | 0;
      if (x < v.x0 - 1 || x >= v.x1 + 1 || y < v.y0 - 1 || y >= v.y1 + 1) continue;
      const s = cam.tileToScreen(x + 0.5, y + 0.5);
      this.drawIcon(b.type, this.colorCss[b.owner] ?? '#888', s.x, s.y, this.iconRadius(z, b.type), b.level, this.progress(b), b.hp);
    }
  }

  private progress(b: Building): number {
    if (b.buildLeft <= 0) return 1;
    const total = BUILDINGS[b.type].buildTime;
    return total > 0 ? 1 - b.buildLeft / total : 1;
  }

  private star(x: number, y: number, R: number, fill: string, stroke: string): void {
    const ctx = this.ctx;
    ctx.beginPath();
    for (let k = 0; k < 10; k++) {
      const a = -Math.PI / 2 + (k * Math.PI) / 5;
      const r = k % 2 === 0 ? R : R * 0.45;
      const px = x + Math.cos(a) * r;
      const py = y + Math.sin(a) * r;
      if (k === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = stroke;
    ctx.stroke();
  }

  /** Capital stars: always in the spawn phase (with a name tag), else from the building zoom on. */
  private drawCapitals(state: GameState, cam: Camera, v: { x0: number; y0: number; x1: number; y1: number }): void {
    const spawn = state.phase === 'spawn';
    if (!spawn && cam.zoom < BUILDING_ZOOM) return;
    const ctx = this.ctx;
    for (const p of state.players) {
      if (!p || p.id === 0 || p.capital < 0 || (!p.alive && !spawn) || (spawn && !p.spawned)) continue;
      const x = p.capital % this.w;
      const y = (p.capital / this.w) | 0;
      if (x < v.x0 - 1 || x >= v.x1 + 1 || y < v.y0 - 1 || y >= v.y1 + 1) continue;
      const s = cam.tileToScreen(x + 0.5, y + 0.5);
      const hasBuilding = state.map.building[p.capital] !== 0;
      const R = clamp(cam.zoom * 0.6, 5, 11);
      const sx = hasBuilding ? s.x + R * 1.3 : s.x;
      const sy = hasBuilding ? s.y - R * 1.3 : s.y;
      this.star(sx, sy, R, this.colorCss[p.id] ?? '#fff', p.id === this.humanId ? '#ffffff' : '#141414');
      if (spawn && p.id !== this.humanId) {
        ctx.font = '600 11px system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'bottom';
        ctx.lineWidth = 3;
        ctx.strokeStyle = 'rgba(0,0,0,0.75)';
        ctx.strokeText(p.name, sx, sy - R - 2);
        ctx.fillStyle = '#fff';
        ctx.fillText(p.name, sx, sy - R - 2);
      }
    }
  }

  // ------------------------------------------------------------------ units

  /** Keeps previous/current positions per unit so drawing can interpolate between ticks and know headings. */
  private trackTicks(state: GameState, nowMs: number): void {
    if (state.tick === this.lastTick) return;
    this.lastTick = state.tick;
    this.lastTickMs = nowMs;
    for (const u of state.units) {
      const t = this.tracks.get(u.id);
      if (!t) {
        const tx = (u.target % this.w) + 0.5;
        const ty = ((u.target / this.w) | 0) + 0.5;
        this.tracks.set(u.id, { px: u.x, py: u.y, cx: u.x, cy: u.y, angle: Math.atan2(ty - u.y - 0.5, tx - u.x - 0.5), seen: state.tick });
        continue;
      }
      const dx = u.x - t.cx;
      const dy = u.y - t.cy;
      t.px = t.cx;
      t.py = t.cy;
      t.cx = u.x;
      t.cy = u.y;
      if (dx * dx + dy * dy > 1e-6) t.angle = Math.atan2(dy, dx);
      t.seen = state.tick;
    }
    for (const [id, t] of this.tracks) if (t.seen !== state.tick) this.tracks.delete(id);
  }

  /** Fraction (0..1) of the current tick that has elapsed, for smooth motion. */
  private subTick(nowMs: number, ui: UiState): number {
    if (ui.paused) return 1;
    const tickMs = 1000 / TICKS_PER_SECOND / ui.speed;
    return clamp((nowMs - this.lastTickMs) / tickMs, 0, 1);
  }

  private drawUnits(state: GameState, cam: Camera, frac: number): void {
    const ctx = this.ctx;
    const z = cam.zoom;
    const base = clamp(z, 3, 14);
    const me = this.humanId;
    for (const u of state.units) {
      const t = this.tracks.get(u.id);
      const ux = t ? t.px + (t.cx - t.px) * frac : u.x;
      const uy = t ? t.py + (t.cy - t.py) * frac : u.y;
      const s = cam.tileToScreen(ux + 0.5, uy + 0.5);
      if (s.x < -60 || s.y < -60 || s.x > cam.viewW + 60 || s.y > cam.viewH + 60) continue;
      const angle = t ? t.angle : 0;
      const col = this.colorCss[u.owner] ?? '#ccc';
      const dark = this.darkCss[u.owner] ?? '#333';
      ctx.save();
      ctx.translate(s.x, s.y);
      ctx.rotate(angle);
      this.unitShape(u, base, col, dark);
      ctx.restore();
      if (u.type === 'transport' && z >= 4) {
        const n = me === 0 || u.owner === me || hasIntel(state, me, u.owner) ? formatCount(armyTotal(u.troops)) : '?';
        ctx.font = '600 11px system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'bottom';
        ctx.lineWidth = 3;
        ctx.strokeStyle = 'rgba(0,0,0,0.75)';
        ctx.strokeText(n, s.x, s.y - base * 0.8);
        ctx.fillStyle = '#fff';
        ctx.fillText(n, s.x, s.y - base * 0.8);
      }
    }
  }

  /** Draws a unit at the origin, pointing along +x. */
  private unitShape(u: Unit, base: number, col: string, dark: string): void {
    const ctx = this.ctx;
    const poly = (pts: number[], fill: string, stroke: string, lw = 1.2) => {
      ctx.beginPath();
      ctx.moveTo(pts[0], pts[1]);
      for (let k = 2; k < pts.length; k += 2) ctx.lineTo(pts[k], pts[k + 1]);
      ctx.closePath();
      ctx.fillStyle = fill;
      ctx.fill();
      ctx.lineWidth = lw;
      ctx.strokeStyle = stroke;
      ctx.stroke();
    };
    switch (u.type) {
      case 'transport': {
        const L = Math.max(10, base * 1.8);
        const W = L * 0.42;
        poly([L / 2, 0, L / 5, -W / 2, -L / 2, -W / 2, -L / 2, W / 2, L / 5, W / 2], col, '#111');
        ctx.fillStyle = 'rgba(255,255,255,0.7)';
        ctx.fillRect(-L / 4, -W / 5, L / 3, (W * 2) / 5);
        break;
      }
      case 'warship': {
        const L = Math.max(12, base * 2.3);
        const W = L * 0.32;
        poly([L / 2, 0, L / 4, -W / 2, -L / 2, -W / 2.5, -L / 2, W / 2.5, L / 4, W / 2], '#56606b', col, 2);
        ctx.beginPath();
        ctx.arc(0, 0, W * 0.32, 0, Math.PI * 2);
        ctx.fillStyle = col;
        ctx.fill();
        ctx.fillRect(0, -W * 0.08, L * 0.32, W * 0.16); // gun
        break;
      }
      case 'tradeShip': {
        const L = Math.max(7, base * 1.2);
        const W = L * 0.45;
        poly([L / 2, 0, L / 6, -W / 2, -L / 2, -W / 2, -L / 2, W / 2, L / 6, W / 2], col, dark, 1);
        ctx.beginPath();
        ctx.arc(-L * 0.1, 0, W * 0.25, 0, Math.PI * 2);
        ctx.fillStyle = '#ffd34a';
        ctx.fill();
        break;
      }
      case 'bomber':
      case 'fighter': {
        const L = u.type === 'bomber' ? Math.max(11, base * 2) : Math.max(8, base * 1.3);
        const span = u.type === 'bomber' ? 0.5 : 0.36;
        poly([L / 2, 0, -L / 2, -L * span, -L * 0.28, 0, -L / 2, L * span], col, '#111', 1.2);
        break;
      }
      case 'rocket':
      case 'atomBomb': {
        const atom = u.type === 'atomBomb';
        const trail = Math.max(10, base * (atom ? 3.5 : 2.6));
        const grad = ctx.createLinearGradient(-trail, 0, 0, 0);
        grad.addColorStop(0, 'rgba(255,170,60,0)');
        grad.addColorStop(1, atom ? 'rgba(255,230,120,0.95)' : 'rgba(255,200,110,0.9)');
        ctx.strokeStyle = grad;
        ctx.lineCap = 'round';
        ctx.lineWidth = atom ? 7 : 4; // glow
        ctx.globalAlpha = 0.35;
        ctx.beginPath();
        ctx.moveTo(-trail, 0);
        ctx.lineTo(0, 0);
        ctx.stroke();
        ctx.globalAlpha = 1;
        ctx.lineWidth = atom ? 2.5 : 1.6;
        ctx.stroke();
        ctx.lineCap = 'butt';
        ctx.beginPath();
        ctx.arc(0, 0, atom ? 4 : 2.6, 0, Math.PI * 2);
        ctx.fillStyle = col;
        ctx.fill();
        ctx.lineWidth = 1;
        ctx.strokeStyle = atom ? '#fff6c0' : '#fff';
        ctx.stroke();
        break;
      }
    }
  }

  // ------------------------------------------------------------------ effects

  private drawEffects(state: GameState, cam: Camera, frac: number): void {
    const ctx = this.ctx;
    const z = cam.zoom;
    for (const e of state.effects) {
      const age = (state.tick - e.tick + frac) / TICKS_PER_SECOND;
      const t = age / EFFECT_SECONDS;
      if (t < 0 || t >= 1) continue;
      const s = cam.tileToScreen(e.x, e.y); // effects are stored at tile centres already
      const reach = Math.max(e.radius, 1) * z * 2 + 40;
      if (e.kind !== 'shot' && (s.x < -reach || s.y < -reach || s.x > cam.viewW + reach || s.y > cam.viewH + reach)) continue;
      this.drawEffect(e, s.x, s.y, t, cam);
    }
    ctx.globalAlpha = 1;
  }

  private drawEffect(e: Effect, x: number, y: number, t: number, cam: Camera): void {
    const ctx = this.ctx;
    const z = cam.zoom;
    const R = Math.max(e.radius, 0.5) * z;
    switch (e.kind) {
      case 'explosion': {
        const r = Math.max(5, R) * (0.3 + 0.7 * t);
        ctx.globalAlpha = 1 - t;
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(255,150,50,0.55)';
        ctx.fill();
        ctx.lineWidth = 2;
        ctx.strokeStyle = 'rgba(255,230,160,0.9)';
        ctx.stroke();
        break;
      }
      case 'nuke': {
        const big = Math.max(20, R);
        if (t < 0.3) {
          // white flash
          ctx.globalAlpha = 1 - t / 0.3;
          ctx.beginPath();
          ctx.arc(x, y, big * 1.5, 0, Math.PI * 2);
          ctx.fillStyle = 'rgba(255,255,240,0.85)';
          ctx.fill();
        }
        ctx.globalAlpha = 1 - t;
        const g = ctx.createRadialGradient(x, y, 0, x, y, big * (0.5 + 0.5 * t));
        g.addColorStop(0, 'rgba(255,250,210,0.95)');
        g.addColorStop(0.4, 'rgba(255,160,40,0.8)');
        g.addColorStop(1, 'rgba(200,60,20,0)');
        ctx.beginPath();
        ctx.arc(x, y, big * (0.5 + 0.5 * t), 0, Math.PI * 2);
        ctx.fillStyle = g;
        ctx.fill();
        ctx.beginPath();
        ctx.arc(x, y, big * (0.4 + 1.3 * t), 0, Math.PI * 2);
        ctx.lineWidth = 3;
        ctx.strokeStyle = 'rgba(255,200,120,0.9)';
        ctx.stroke();
        break;
      }
      case 'shot': {
        if (e.x2 === undefined || e.y2 === undefined) break;
        const s2 = cam.tileToScreen(e.x2, e.y2);
        ctx.globalAlpha = Math.max(0, 1 - t * 2);
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(s2.x, s2.y);
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = 'rgba(255,240,150,1)';
        ctx.stroke();
        break;
      }
      case 'capture': {
        const r = Math.max(3, z * 0.8) * (0.5 + t);
        ctx.globalAlpha = 1 - t;
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = 'rgba(255,255,220,1)';
        ctx.beginPath();
        for (let k = 0; k < 4; k++) {
          const a = (k * Math.PI) / 2 + t * 2;
          ctx.moveTo(x + Math.cos(a) * r * 0.3, y + Math.sin(a) * r * 0.3);
          ctx.lineTo(x + Math.cos(a) * r, y + Math.sin(a) * r);
        }
        ctx.stroke();
        break;
      }
    }
    ctx.globalAlpha = 1;
  }

  // ------------------------------------------------------------------ names

  /** Label anchor per player: territory centroid, moved to the nearest owned tile if the centroid isn't owned. */
  private updateLabels(state: GameState, nowMs: number): void {
    if (nowMs - this.labelsMs < NAMES_REFRESH_MS) return;
    this.labelsMs = nowMs;
    const owner = state.map.owner;
    const w = this.w;
    const np = state.players.length;
    const sx = new Float64Array(np);
    const sy = new Float64Array(np);
    const cnt = new Float64Array(np);
    for (let i = 0; i < owner.length; i++) {
      const o = owner[i];
      if (o === 0 || o >= np) continue;
      sx[o] += i % w;
      sy[o] += (i / w) | 0;
      cnt[o]++;
    }
    const labels: NameLabel[] = [];
    for (let id = 1; id < np; id++) {
      if (cnt[id] === 0 || !state.players[id]?.alive) continue;
      let cx = Math.round(sx[id] / cnt[id]);
      let cy = Math.round(sy[id] / cnt[id]);
      if (owner[cy * w + cx] !== id) {
        const near = this.nearestOwned(owner, cx, cy, id, 40);
        if (near >= 0) {
          cx = near % w;
          cy = (near / w) | 0;
        }
      }
      labels.push({ id, x: cx + 0.5, y: cy + 0.5, tiles: cnt[id] });
    }
    this.labels = labels;
  }

  /** Nearest tile owned by `id`, searching square rings outward; -1 if none within maxR. */
  private nearestOwned(owner: Uint16Array, cx: number, cy: number, id: number, maxR: number): number {
    const w = this.w;
    const h = this.h;
    for (let r = 1; r <= maxR; r++) {
      for (let dy = -r; dy <= r; dy++) {
        const y = cy + dy;
        if (y < 0 || y >= h) continue;
        const step = dy === -r || dy === r ? 1 : 2 * r; // only the ring's border
        for (let dx = -r; dx <= r; dx += step) {
          const x = cx + dx;
          if (x < 0 || x >= w) continue;
          if (owner[y * w + x] === id) return y * w + x;
        }
      }
    }
    return -1;
  }

  private drawNames(state: GameState, cam: Camera, nowMs: number): void {
    this.updateLabels(state, nowMs);
    const ctx = this.ctx;
    const me = this.humanId;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    // Biggest nations first; a label that would overlap one already drawn is skipped.
    const drawn: { x0: number; y0: number; x1: number; y1: number }[] = [];
    const order = [...this.labels].sort((a, b) => b.tiles - a.tiles);
    for (const l of order) {
      const p: Player | undefined = state.players[l.id];
      if (!p || !p.alive) continue;
      const span = Math.sqrt(l.tiles) * cam.zoom; // rough territory width in px
      let size = Math.min(44, span * 0.2);
      if (size < 8) continue;
      // Keep the name narrower than the territory.
      ctx.font = `700 ${Math.round(size)}px system-ui, sans-serif`;
      const tw = ctx.measureText(p.name).width;
      if (tw > span * 0.85) size *= (span * 0.85) / tw;
      if (size < 8) continue;
      const s = cam.tileToScreen(l.x, l.y);
      if (s.x < -200 || s.y < -50 || s.x > cam.viewW + 200 || s.y > cam.viewH + 50) continue;
      const halfW = Math.min(tw, span * 0.85) / 2;
      const box = { x0: s.x - halfW, y0: s.y - size * 1.1, x1: s.x + halfW, y1: s.y + size * 1.1 };
      if (drawn.some((d) => box.x0 < d.x1 && box.x1 > d.x0 && box.y0 < d.y1 && box.y1 > d.y0)) continue;
      drawn.push(box);
      const army = me === 0 || hasIntel(state, me, p.id) ? formatCount(armyTotal(p.troops)) : '?';
      const small = Math.max(7, size * 0.72);
      ctx.shadowColor = 'rgba(0,0,0,0.6)';
      ctx.shadowBlur = 4;
      ctx.lineWidth = Math.max(2, size * 0.18);
      ctx.strokeStyle = 'rgba(0,0,0,0.7)';
      ctx.fillStyle = p.id === me ? '#fff8d8' : '#ffffff';
      ctx.font = `700 ${Math.round(size)}px system-ui, sans-serif`;
      ctx.strokeText(p.name, s.x, s.y - small * 0.55);
      ctx.fillText(p.name, s.x, s.y - small * 0.55);
      ctx.font = `600 ${Math.round(small)}px system-ui, sans-serif`;
      ctx.lineWidth = Math.max(2, small * 0.18);
      ctx.strokeText(army, s.x, s.y + size * 0.6);
      ctx.fillText(army, s.x, s.y + size * 0.6);
      ctx.shadowBlur = 0;
      ctx.shadowColor = 'transparent';
    }
  }

  // ------------------------------------------------------------------ hover, selection, target previews

  private tileRect(cam: Camera, tile: number, minPx: number): { x: number; y: number; s: number } {
    const x = tile % this.w;
    const y = (tile / this.w) | 0;
    const c = cam.tileToScreen(x + 0.5, y + 0.5);
    const s = Math.max(minPx, cam.zoom);
    return { x: c.x - s / 2, y: c.y - s / 2, s };
  }

  private canBuildCached(state: GameState, type: BuildingType, tile: number): boolean {
    const key = `${type}|${tile}|${state.tick}`;
    if (key !== this.buildCheck.key) {
      let ok = false;
      try {
        ok = this.humanId > 0 && canBuild(state, this.humanId, type, tile).ok;
      } catch {
        ok = false;
      }
      this.buildCheck = { key, ok };
    }
    return this.buildCheck.ok;
  }

  private drawHoverAndPreview(state: GameState, cam: Camera, ui: UiState): void {
    const ctx = this.ctx;
    const n = this.w * this.h;
    const z = cam.zoom;
    if (ui.selectedTile >= 0 && ui.selectedTile < n) {
      const r = this.tileRect(cam, ui.selectedTile, 7);
      ctx.lineWidth = 2;
      ctx.strokeStyle = '#ffd84a';
      ctx.strokeRect(r.x, r.y, r.s, r.s);
    }
    const hover = ui.hoverTile;
    if (hover < 0 || hover >= n) return;
    const hx = (hover % this.w) + 0.5;
    const hy = ((hover / this.w) | 0) + 0.5;
    const hs = cam.tileToScreen(hx, hy);
    const mode = ui.mode;

    const circle = (radius: number, color: string, fill: string) => {
      ctx.beginPath();
      ctx.arc(hs.x, hs.y, Math.max(radius * z, 4), 0, Math.PI * 2);
      ctx.fillStyle = fill;
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = color;
      ctx.stroke();
    };
    const lineFrom = (tile: number, color: string) => {
      if (tile < 0 || tile >= n) return;
      const a = cam.tileToScreen((tile % this.w) + 0.5, ((tile / this.w) | 0) + 0.5);
      this.dashedLine(a.x, a.y, hs.x, hs.y, color);
    };

    switch (mode.kind) {
      case 'build': {
        const ok = this.canBuildCached(state, mode.building, hover);
        const r = this.tileRect(cam, hover, 6);
        ctx.fillStyle = ok ? 'rgba(70,220,100,0.45)' : 'rgba(230,60,50,0.45)';
        ctx.fillRect(r.x, r.y, r.s, r.s);
        ctx.globalAlpha = 0.65;
        const ir = this.iconRadius(Math.max(z, 6), mode.building);
        this.drawIcon(mode.building, ok ? '#5fe07a' : '#e85a4a', hs.x, hs.y, ir, 1, 1, 1);
        ctx.globalAlpha = 1;
        break;
      }
      case 'bomb':
        lineFrom(mode.airfield, 'rgba(255,255,255,0.7)');
        circle(BOMBER_RADIUS, 'rgba(255,120,60,0.95)', 'rgba(255,120,60,0.18)');
        break;
      case 'missile':
        lineFrom(mode.silo, 'rgba(255,255,255,0.7)');
        if (mode.missile === 'atomBomb') {
          circle(ATOM_RADIUS, 'rgba(255,200,60,0.95)', 'rgba(255,200,60,0.12)');
          circle(ATOM_CORE_RADIUS, 'rgba(255,90,40,0.95)', 'rgba(255,90,40,0.18)');
        } else {
          circle(ROCKET_RADIUS, 'rgba(255,90,60,0.95)', 'rgba(255,90,60,0.2)');
        }
        break;
      case 'transport':
        lineFrom(mode.from, 'rgba(160,220,255,0.9)');
        circle(0.8, 'rgba(160,220,255,0.95)', 'rgba(160,220,255,0.25)');
        break;
      case 'moveWarship': {
        const u = state.units.find((q) => q.id === mode.unitId);
        if (u) {
          const a = cam.tileToScreen(u.x + 0.5, u.y + 0.5);
          this.dashedLine(a.x, a.y, hs.x, hs.y, 'rgba(160,220,255,0.9)');
        }
        circle(0.8, 'rgba(160,220,255,0.95)', 'rgba(160,220,255,0.25)');
        break;
      }
      case 'none':
        break;
    }

    const r = this.tileRect(cam, hover, 6);
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = 'rgba(255,255,255,0.95)';
    ctx.strokeRect(r.x, r.y, r.s, r.s);
  }

  private dashedLine(x1: number, y1: number, x2: number, y2: number, color: string): void {
    const ctx = this.ctx;
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.setLineDash([8, 6]);
    ctx.lineWidth = 2;
    ctx.strokeStyle = color;
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // ------------------------------------------------------------------ minimap

  private drawMinimap(state: GameState, cam: Camera, nowMs: number): void {
    const base = this.mmBase;
    if (!base || !this.terrainCv || !this.territoryCv) return;
    const bw = base.width;
    const bh = base.height;
    if (nowMs - this.mmMs >= MINIMAP_REFRESH_MS) {
      this.mmMs = nowMs;
      const b = ctx2d(base);
      b.imageSmoothingEnabled = true;
      b.clearRect(0, 0, bw, bh);
      b.drawImage(this.terrainCv, 0, 0, bw, bh);
      b.drawImage(this.territoryCv, 0, 0, bw, bh);
    }
    const m = this.mmCtx;
    m.setTransform(1, 0, 0, 1, 0, 0);
    m.clearRect(0, 0, this.minimap.width, this.minimap.height);
    m.drawImage(base, 0, 0, this.minimap.width, this.minimap.height);
    // viewport rectangle
    const sx = this.minimap.width / this.w;
    const sy = this.minimap.height / this.h;
    const a = cam.screenToTile(0, 0);
    const b = cam.screenToTile(cam.viewW, cam.viewH);
    const x0 = clamp(a.x, 0, this.w) * sx;
    const y0 = clamp(a.y, 0, this.h) * sy;
    const x1 = clamp(b.x, 0, this.w) * sx;
    const y1 = clamp(b.y, 0, this.h) * sy;
    const d = this.minimap.width / this.mmCssW;
    m.lineWidth = 1.5 * d;
    m.strokeStyle = 'rgba(255,255,255,0.95)';
    m.strokeRect(x0 + 0.5, y0 + 0.5, Math.max(2, x1 - x0 - 1), Math.max(2, y1 - y0 - 1));
    // human capital marker
    const me = state.players[this.humanId];
    if (me && me.capital >= 0) {
      m.beginPath();
      m.arc(((me.capital % this.w) + 0.5) * sx, (((me.capital / this.w) | 0) + 0.5) * sy, 2.5 * d, 0, Math.PI * 2);
      m.fillStyle = '#fff';
      m.fill();
    }
  }
}
