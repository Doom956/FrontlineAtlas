// Map renderer for maps up to 2600 x 1600 tiles and hundreds of players.
//
// Two stacked canvases:
//   map     WebGL2 (render/glmap.ts + shaders.ts): terrain with per-terrain patterns, nations as one solid colour
//           with crisp borders, capture flashes along the fronts, fort coverage, fallout, supply / spawn / resource
//           overlays. Falls back to Canvas2D (render/map2d.ts) without WebGL2.
//   overlay Canvas2D on top (the canvas main.ts gives us; input listens on it): deposits, buildings, capitals,
//           front lines, units, effects, labels, front pills and push arrows, reticles, floaters, hover and previews.
// Tile ownership reaches the GPU through the sim's change feed (render/tiles.ts): no per-frame map scans. Labels,
// fronts and the minimap listen to the same feed. Everything in screen space is culled through spatial grids.
import { supplyEfficiency } from '../sim/combat';
import { MIN_SUPPLY_EFF } from '../sim/config';
import { areAllied, isTraitor } from '../sim/diplomacy';
import { armyTotal } from '../sim/economy';
import { spawnMinDistance } from '../sim/state';
import { isTribe, isWater } from '../sim/types';
import type { GameState } from '../sim/types';
import type { Camera } from './camera';
import type { Snap } from './placement';
import { BuildTargetCache } from './simx';
import { BuildingLayer, FAR_ZOOM } from './render/buildings';
import { buildingsKey, clamp, ctx2d, shade, type RGB } from './render/common';
import { DepositLayer } from './render/deposits';
import { FrontLayer } from './render/fronts';
import { HeartlandLayer } from './render/heartland';
import { MapGL } from './render/glmap';
import { Map2D } from './render/map2d';
import { Minimap } from './render/minimap';
import { NameLayer } from './render/names';
import { Overlays, ringRadius } from './render/overlays';
import { buildTerrain, type TerrainData } from './render/terrain';
import { TileFeed } from './render/tiles';
import { UnitLayer } from './render/units';
import { SelectionOverlay } from './render/selectionOverlay';
import { PillarOverlay } from './render/pillarOverlay';
import { BattleFx } from './fx/battleFx';
import type { UiState } from './uiState';

export { formatCount } from './render/common';

const SUPPLY_MS = 1000;
const SPAWN_MS = 400;
const PALETTE_FRAMES = 12;

/** Per-frame numbers for tests and profiling. */
export interface RenderStats {
  gl: boolean;
  uploads: number;
  /** owner-texture tiles uploaded this frame (4 bytes each) */
  uploadTiles: number;
  tilesApplied: number;
  buildings: number;
  deposits: number;
  units: number;
  labels: number;
  labelsComputed: number;
  /** ms this frame: tile feed + labels + palette/forts/aux, GPU uploads + draw call, overlay, minimap */
  msPrep: number;
  msMap: number;
  msOverlay: number;
  msMinimap: number;
  /** ms this frame in the front lines layer (lines, push arrows, pills, hover card; part of msPrep + msOverlay) */
  msFronts: number;
  /** front line runs drawn this frame */
  frontSegments: number;
  /** ms this frame in the battle effects (fx/battleFx.ts: reading new events + drawing; part of msPrep + msOverlay) */
  msFx: number;
}

export class Renderer {
  private ctx: CanvasRenderingContext2D;
  private glCanvas: HTMLCanvasElement | null = null;
  private gl: MapGL | null = null;
  private map2d: Map2D | null = null;
  private dpr = 1;
  private cssW = 0;
  private cssH = 0;

  private state: GameState | null = null;
  private w = 0;
  private h = 0;
  private humanId = 0;
  private terr: TerrainData | null = null;
  private colors: RGB[] = [];
  private frame = 0;
  private lastFrameMs = 0;
  private frameMs = 16.7;

  private feed = new TileFeed();
  private buildings = new BuildingLayer();
  private deposits = new DepositLayer();
  private units = new UnitLayer();
  /** selection box, warship placement area, spearhead preview (render/selectionOverlay.ts) */
  private selectionOverlay = new SelectionOverlay();
  /** stance ranges, blockades, escorts, supported fronts, air zones (render/pillarOverlay.ts) */
  private pillarOverlay = new PillarOverlay();
  private selectedSet = new Set<number>();
  private selectedFrom: readonly number[] | null = null;
  private fronts = new FrontLayer();
  private heartland = new HeartlandLayer();
  private names = new NameLayer();
  private overlays = new Overlays();
  /** capture ripples, city pulses, splashes, smoke, dust, shockwaves, the nuke shake (fx/) */
  private fx = new BattleFx();
  private shookBy = { x: 0, y: 0 };
  private mini: Minimap;
  private snapCache = new BuildTargetCache();

  private palSig = '';
  private hoverFlag = { owner: 0, v: 0 };
  // fort coverage (owner of the covering fort per tile)
  private fortOwner = new Uint16Array(0);
  private forts = new Map<number, { tile: number; owner: number; r: number }>();
  private fortKey = -1;
  // aux overlay: supply classes or spawn blocks
  private aux = new Uint8Array(0);
  private auxMode: 0 | 1 | 2 = 0;
  private auxMs = -Infinity;
  private auxRect: [number, number, number, number] | null = null;
  private auxSig = '';

  stats: RenderStats = { gl: false, uploads: 0, uploadTiles: 0, tilesApplied: 0, buildings: 0, deposits: 0, units: 0, labels: 0, labelsComputed: 0, msPrep: 0, msMap: 0, msOverlay: 0, msMinimap: 0, msFronts: 0, frontSegments: 0, msFx: 0 };

  constructor(public canvas: HTMLCanvasElement, public minimap: HTMLCanvasElement) {
    this.ctx = ctx2d(canvas);
    this.mini = new Minimap(minimap);
    this.feed.listeners.push(this.fronts.onChange, this.mini.onChange, this.names.onChange);
    if (typeof document !== 'undefined') {
      const gc = document.createElement('canvas');
      gc.className = 'map-gl';
      Object.assign(gc.style, { position: 'absolute', inset: '0', width: '100%', height: '100%', display: 'block', pointerEvents: 'none' });
      this.gl = MapGL.create(gc);
      if (this.gl) this.glCanvas = gc;
    }
  }

  /** Call once per new game (builds the terrain and uploads the map textures). */
  setGame(state: GameState): void {
    const map = state.map;
    this.state = state;
    this.w = map.width;
    this.h = map.height;
    this.humanId = state.humanId;
    this.terr = buildTerrain(map);
    this.feed.reset(state);
    this.colors = [];
    this.palSig = '';
    this.syncColors(state);
    if (this.gl && this.gl.maxSize < Math.max(map.width, map.height)) this.dropGl();
    if (this.gl && !this.gl.lost) {
      this.gl.setGame(map, this.terr, this.feed.mirror);
    } else {
      this.map2d = null; // a new game may have another map size (the 2D layers are sized per map)
      this.ensure2d();
    }
    this.buildings.reset();
    this.deposits.setGame(state);
    this.units.reset(map.width);
    this.fronts.reset(map.width, this.feed);
    this.names.setGame(state);
    this.overlays.reset(map.width);
    this.mini.setGame(state, this.terr);
    this.mini.setColors(this.colors);
    this.snapCache = new BuildTargetCache();
    this.fortOwner = new Uint16Array(map.width * map.height);
    this.forts.clear();
    this.fortKey = -1;
    this.aux = new Uint8Array(map.width * map.height);
    this.auxMode = 0;
    this.auxMs = -Infinity;
    this.auxRect = null;
    this.auxSig = '';
    this.feed.clearDirty();
  }

  /** Draws a frame. */
  render(state: GameState, camera: Camera, ui: UiState, nowMs: number): void {
    if (state !== this.state) this.setGame(state);
    if (this.gl && this.gl.lost) this.dropGl();
    this.frame++;
    if (this.lastFrameMs > 0) this.frameMs = this.frameMs * 0.9 + clamp(nowMs - this.lastFrameMs, 4, 100) * 0.1;
    this.lastFrameMs = nowMs;
    this.resizeIfNeeded(camera);
    // battle effects: read what is new, then shake the view a few px after a nearby nuke (undone after drawing)
    if (this.shookBy.x !== 0 || this.shookBy.y !== 0) this.unshake(camera);
    this.fx.update(state, camera, nowMs);
    const sh = this.fx.shake(nowMs);
    if (sh.x !== 0 || sh.y !== 0) {
      this.shookBy.x = sh.x / camera.zoom;
      this.shookBy.y = sh.y / camera.zoom;
      camera.x += this.shookBy.x;
      camera.y += this.shookBy.y;
    }
    if (state.players.length > this.colors.length) this.syncColors(state);

    const tPrep = performance.now();
    // ---- tiles: this frame's share of the changes (spread over the frames of one tick)
    let tf = performance.now();
    this.fronts.begin(state, nowMs);
    let msFronts = performance.now() - tf;
    const tickMs = 100 / ui.speed;
    this.feed.update(nowMs, ui.paused ? 1 : Math.round(tickMs / this.frameMs));
    this.names.update(state, this.feed, nowMs);
    this.updatePalette(state, ui);
    this.updateForts(state);
    this.updateAux(state, ui, nowMs);

    // ---- map layer
    const tMap = performance.now();
    this.stats.msPrep = tMap - tPrep;
    const z = camera.zoom;
    const d = this.dpr;
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    const gl = this.gl;
    if (gl) {
      gl.uploadOwner(this.feed);
      gl.draw(this.canvas.width, this.canvas.height, {
        centerX: camera.x,
        centerY: camera.y,
        zoom: z * d,
        timeS: (nowMs / 1000) % 3600,
        nowDs: Math.floor(nowMs / 100),
        auxMode: this.auxMode,
        showRes: ui.showResources,
        fortOn: this.forts.size > 0,
      });
      this.stats.uploads = gl.uploads;
      this.stats.uploadTiles = gl.uploadTiles;
    } else if (this.map2d) {
      this.map2d.update(this.feed);
      ctx.setTransform(d * z, 0, 0, d * z, d * (camera.viewW / 2 - camera.x * z), d * (camera.viewH / 2 - camera.y * z));
      ctx.fillStyle = '#0a111c';
      ctx.fillRect(0, 0, this.w, this.h);
      this.map2d.draw(ctx, camera.visibleTiles(1), ui.showResources, this.auxMode !== 0);
      this.stats.uploads = 0;
      this.stats.uploadTiles = 0;
    }
    this.stats.tilesApplied = this.feed.applied;
    this.feed.clearDirty();

    // ---- overlay (CSS px)
    const tOver = performance.now();
    this.stats.msMap = tOver - tMap;
    ctx.setTransform(d, 0, 0, d, 0, 0);
    const view = camera.visibleTiles(1);
    const me = this.humanId;
    const snap = this.currentSnap(state, ui);
    this.units.track(state, nowMs);
    this.units.focusId = this.focusShip(ui);
    if (ui.selection !== this.selectedFrom) {
      this.selectedFrom = ui.selection;
      this.selectedSet = new Set(ui.selection);
      this.units.selected = this.selectedSet;
    }
    const frac = this.units.subTick(nowMs, ui.paused, ui.speed);
    const b = ui.mode.kind === 'build' ? ui.mode.building : null;
    const depFocus = b === 'mine' ? 1 : b === 'oilWell' ? 2 : b === 'farm' ? 3 : 0;
    this.deposits.draw(ctx, state, camera, view, ui.showResources, me, depFocus, d);
    this.heartland.draw(ctx, state, camera, me, ui.showHeartland && state.phase === 'playing', d);
    tf = performance.now();
    this.fronts.drawLines(ctx, state, camera, ui, d);
    msFronts += performance.now() - tf;
    this.overlays.rings(ctx, state, camera, ui, snap, me);
    const focus: number[] = [];
    if (ui.hoverTile >= 0 && ui.hoverTile < state.map.building.length && state.map.building[ui.hoverTile] !== 0 && ui.mode.kind === 'none') focus.push(ui.hoverTile);
    if (ui.selectedTile >= 0 && ui.selectedTile < state.map.building.length && state.map.building[ui.selectedTile] !== 0) focus.push(ui.selectedTile);
    this.buildings.draw(ctx, state, camera, view, this.colors, focus, d);
    this.overlays.capitals(ctx, state, camera, this.colors, me, FAR_ZOOM, nowMs);
    this.units.draw(ctx, state, camera, frac, this.colors, me, d, nowMs);
    this.overlays.effects(ctx, state, camera, frac);
    const hs = ui.hoverTile >= 0 ? camera.tileToScreen((ui.hoverTile % this.w) + 0.5, ((ui.hoverTile / this.w) | 0) + 0.5) : null;
    const hoverOwner = ui.hoverTile >= 0 && ui.hoverTile < state.map.owner.length ? state.map.owner[ui.hoverTile] : 0;
    this.names.draw(ctx, state, camera, me, { hoverOwner, targeting: ui.mode.kind !== 'none', hover: hs }, nowMs, d);
    this.fx.draw(ctx, camera, nowMs); // over the names: a city pulse's label must stay readable
    this.overlays.telegraphs(ctx, state, camera, this.units, frac, me, nowMs, this.colors);
    this.overlays.barrages(ctx, state, camera, frac, me, nowMs, this.colors);
    tf = performance.now();
    this.fronts.draw(ctx, state, camera, me, this.colors, ui);
    msFronts += performance.now() - tf;
    this.stats.msFronts = msFronts;
    this.stats.frontSegments = this.fronts.segments;
    this.overlays.floaters(ctx, ui, camera, nowMs);
    this.overlays.strikeZones(ctx, state, camera, ui);
    this.overlays.hoverAndPreview(ctx, state, camera, ui, snap, this.units, frac, d);
    this.pillarOverlay.draw(ctx, state, camera, ui, this.units, frac, nowMs);
    this.selectionOverlay.draw(ctx, state, camera, ui, nowMs);

    const tMini = performance.now();
    this.stats.msOverlay = tMini - tOver;
    if (this.shookBy.x !== 0 || this.shookBy.y !== 0) this.unshake(camera);
    this.mini.draw(state, camera, this.feed, me, nowMs);
    this.stats.msMinimap = performance.now() - tMini;
    this.stats.msFx = this.fx.ms;
    this.stats.gl = !!this.gl;
    this.stats.buildings = this.buildings.drawn;
    this.stats.deposits = this.deposits.drawn;
    this.stats.units = this.units.drawn;
    this.stats.labels = this.names.drawn;
    this.stats.labelsComputed = this.names.computed;
  }

  private unshake(camera: Camera): void {
    camera.x -= this.shookBy.x;
    camera.y -= this.shookBy.y;
    this.shookBy.x = 0;
    this.shookBy.y = 0;
  }

  /** Minimap click -> tile coords, or null if outside. */
  minimapToTile(mx: number, my: number): { x: number; y: number } | null {
    if (!this.state) return null;
    return this.mini.toTile(mx, my);
  }

  /** The own warship to ring: the one picked for a move order, else the one under the pointer (idle mode only). */
  private focusShip(ui: UiState): number {
    if (ui.mode.kind === 'moveWarship') return ui.mode.unitId;
    if (ui.mode.kind === 'none' && ui.hoverPx) return this.units.ownWarshipAt(ui.hoverPx.x, ui.hoverPx.y);
    return -1;
  }

  /** Id of your own warship drawn under a canvas point (CSS px), or -1. */
  ownWarshipAt(sx: number, sy: number): number {
    return this.units.ownWarshipAt(sx, sy);
  }

  /** Ids of your own warships and tank divisions drawn inside a canvas rectangle (CSS px): box selection. */
  ownUnitsIn(x0: number, y0: number, x1: number, y1: number): number[] {
    return this.units.ownUnitsIn(x0, y0, x1, y1);
  }

  /** Id of any unit drawn under a canvas point (CSS px), or -1 (hover cards). */
  unitAt(sx: number, sy: number): number {
    return this.units.unitAt(sx, sy);
  }

  /** Where a unit was drawn last frame (canvas CSS px), or null when off screen. */
  unitScreen(id: number): { x: number; y: number } | null {
    return this.units.screenOf(id);
  }

  // ------------------------------------------------------------------ setup

  private currentSnap(state: GameState, ui: UiState): Snap | null {
    const m = ui.mode;
    if (m.kind !== 'build' || ui.hoverTile < 0 || this.humanId <= 0 || state.phase !== 'playing') return null;
    const t = this.snapCache.get(state, this.humanId, m.building, ui.hoverTile);
    return { tile: t.tile, upgrade: t.upgrade, ok: t.ok, level: t.level, error: t.error };
  }

  private resizeIfNeeded(camera: Camera): void {
    const dpr = typeof window !== 'undefined' ? Math.min(3, window.devicePixelRatio || 1) : 1;
    const cw = this.canvas.clientWidth || this.cssW || this.canvas.width;
    const ch = this.canvas.clientHeight || this.cssH || this.canvas.height;
    if (cw !== this.cssW || ch !== this.cssH || dpr !== this.dpr) {
      this.cssW = cw;
      this.cssH = ch;
      this.dpr = dpr;
      this.canvas.width = Math.max(1, Math.round(cw * dpr));
      this.canvas.height = Math.max(1, Math.round(ch * dpr));
      if (this.glCanvas) {
        this.glCanvas.width = this.canvas.width;
        this.glCanvas.height = this.canvas.height;
      }
    }
    // The GL canvas sits right under the overlay canvas (inserted once the overlay is in the page).
    const gc = this.glCanvas;
    if (gc && gc.parentElement !== this.canvas.parentElement && this.canvas.parentElement) {
      this.canvas.parentElement.insertBefore(gc, this.canvas);
    }
    if (camera.viewW !== cw || camera.viewH !== ch) camera.resize(cw, ch);
  }

  private dropGl(): void {
    if (!this.gl) return;
    this.gl = null;
    this.glCanvas?.remove();
    this.glCanvas = null;
    this.ensure2d();
  }

  private ensure2d(): void {
    if (this.map2d || !this.state || !this.terr) return;
    this.map2d = new Map2D();
    this.map2d.setGame(this.state.map, this.terr);
    this.palSig = '';
    this.feed.full();
  }

  private syncColors(state: GameState): void {
    for (let id = 0; id < state.players.length; id++) {
      const p = state.players[id];
      const c = p?.color ?? [128, 128, 128];
      this.colors[id] = p && isTribe(p) ? tribeDisplayColor(c) : [c[0], c[1], c[2]];
    }
    this.mini.setColors(this.colors);
    this.palSig = '';
  }

  /** Owner colours and flags (relation, traitor, hovered) for the shader; re-sent only when they change. */
  private updatePalette(state: GameState, ui: UiState): void {
    const me = this.humanId;
    // hovered nation: highlighted border; pulsing red when it looks like an easy target
    let hover = 0;
    let hv = 0;
    const t = ui.hoverTile;
    if (me > 0 && ui.mode.kind === 'none' && state.phase === 'playing' && t >= 0 && t < state.map.owner.length) {
      const o = state.map.owner[t];
      const mp = state.players[me];
      const op = state.players[o];
      if (o !== 0 && o !== me && op && op.alive && mp && mp.alive && !areAllied(state, me, o)) {
        const send = armyTotal(mp.troops) * ui.attackShare;
        const weak = op.tiles * 4 < mp.tiles || armyTotal(op.troops) < send * 1.25;
        hover = o;
        hv = weak ? 2 : 1;
      }
    }
    const hoverChanged = hover !== this.hoverFlag.owner || hv !== this.hoverFlag.v;
    if (!hoverChanged && this.palSig !== '' && this.frame % PALETTE_FRAMES !== 0) return;
    this.hoverFlag = { owner: hover, v: hv };
    let sig = `${hover}:${hv}`;
    const rel: number[] = [];
    const trait: boolean[] = [];
    for (let id = 1; id < state.players.length; id++) {
      const p = state.players[id];
      if (!p) continue;
      const r = id === me ? 1 : me > 0 && areAllied(state, me, id) ? 2 : isTribe(p) ? 3 : 0;
      const tr = isTraitor(state, id);
      rel[id] = r;
      trait[id] = tr;
      if (r === 1 || r === 2 || tr) sig += `|${id}${r}${tr ? 't' : ''}`;
    }
    sig += `#${state.players.length}`;
    if (sig === this.palSig) return;
    this.palSig = sig;
    if (this.gl) {
      for (let id = 0; id < state.players.length; id++) {
        this.gl.setPalette(id, this.colors[id] ?? [128, 128, 128], rel[id] ?? 0, trait[id] ?? false, id === hover ? hv : 0);
      }
      this.gl.uploadPalette();
    } else if (this.map2d) {
      for (let id = 0; id < state.players.length; id++) {
        const c = this.colors[id] ?? [128, 128, 128];
        const border = id === me ? [240, 240, 240] : rel[id] === 2 ? shade(c, 1.25) : shade(c, 0.55);
        this.map2d.setColor(id, c, border);
      }
      this.feed.full();
    }
  }

  /** Fort coverage texture: only the areas around forts that appeared, vanished or changed are rewritten. */
  private updateForts(state: GameState): void {
    const key = buildingsKey(state);
    if (key === this.fortKey) return;
    this.fortKey = key;
    const next = new Map<number, { tile: number; owner: number; r: number }>();
    for (const b of state.buildings.values()) {
      if (b.type !== 'fort' || b.buildLeft > 0) continue;
      next.set(b.id, { tile: b.tile, owner: b.owner, r: ringRadius(state, 'fort', b.owner) });
    }
    const touched: { tile: number; r: number }[] = [];
    for (const [id, f] of this.forts) {
      const g = next.get(id);
      if (!g || g.owner !== f.owner || g.r !== f.r || g.tile !== f.tile) touched.push(f);
    }
    for (const [id, g] of next) {
      const f = this.forts.get(id);
      if (!f || f.owner !== g.owner || f.r !== g.r || f.tile !== g.tile) touched.push(g);
    }
    this.forts = next;
    if (touched.length === 0) return;
    const w = this.w;
    const h = this.h;
    const fo = this.fortOwner;
    for (const t of touched) {
      const cx = t.tile % w;
      const cy = (t.tile / w) | 0;
      const x0 = Math.max(0, cx - t.r);
      const y0 = Math.max(0, cy - t.r);
      const x1 = Math.min(w - 1, cx + t.r);
      const y1 = Math.min(h - 1, cy + t.r);
      for (let y = y0; y <= y1; y++) fo.fill(0, y * w + x0, y * w + x1 + 1);
      for (const f of next.values()) {
        const fx = f.tile % w;
        const fy = (f.tile / w) | 0;
        if (fx + f.r < x0 || fx - f.r > x1 || fy + f.r < y0 || fy - f.r > y1) continue;
        for (let y = Math.max(y0, fy - f.r); y <= Math.min(y1, fy + f.r); y++) {
          const dy = y - fy;
          for (let x = Math.max(x0, fx - f.r); x <= Math.min(x1, fx + f.r); x++) {
            const dx = x - fx;
            if (dx * dx + dy * dy <= f.r * f.r) fo[y * w + x] = f.owner;
          }
        }
      }
      this.gl?.uploadRect('fort', fo, x0, y0, x1 - x0 + 1, y1 - y0 + 1);
    }
  }

  /**
   * Aux texture: during the spawn phase, discs around other players' capitals where you can't spawn (the shader
   * lightens free land itself); with the supply overlay on, your tiles' supply distance class, about once a second.
   */
  private updateAux(state: GameState, ui: UiState, nowMs: number): void {
    const me = this.humanId;
    const spawn = state.phase === 'spawn' && me > 0;
    const supply = me > 0 && ui.showSupply && !spawn && !!state.players[me]?.alive;
    const mode: 0 | 1 | 2 = spawn ? 2 : supply ? 1 : 0;
    if (mode === 0) {
      this.auxMode = 0;
      return;
    }
    const interval = mode === 2 ? SPAWN_MS : SUPPLY_MS;
    if (mode === this.auxMode && nowMs - this.auxMs < interval) return;
    this.auxMs = nowMs;
    const w = this.w;
    const h = this.h;
    const aux = this.aux;
    const prev = this.auxRect;
    let rect: [number, number, number, number] | null = null;
    if (mode === 2) {
      // blocked discs around other spawned capitals
      const r = spawnMinDistance(state);
      let sig = '';
      const caps: number[] = [];
      for (const p of state.players) {
        if (!p || p.id === 0 || p.id === me || !p.spawned || p.capital < 0) continue;
        caps.push(p.capital);
        sig += p.capital + ',';
      }
      if (sig === this.auxSig && this.auxMode === 2) return;
      this.auxSig = sig;
      if (prev) clearRect(aux, w, prev);
      if (caps.length) {
        let x0 = w;
        let y0 = h;
        let x1 = -1;
        let y1 = -1;
        for (const c of caps) {
          const cx = c % w;
          const cy = (c / w) | 0;
          for (let y = Math.max(0, cy - r); y <= Math.min(h - 1, cy + r); y++) {
            for (let x = Math.max(0, cx - r); x <= Math.min(w - 1, cx + r); x++) {
              const dx = x - cx;
              const dy = y - cy;
              if (dx * dx + dy * dy >= r * r) continue;
              aux[y * w + x] = 2;
            }
          }
          x0 = Math.min(x0, Math.max(0, cx - r));
          y0 = Math.min(y0, Math.max(0, cy - r));
          x1 = Math.max(x1, Math.min(w - 1, cx + r));
          y1 = Math.max(y1, Math.min(h - 1, cy + r));
        }
        rect = [x0, y0, x1, y1];
      }
    } else {
      // supply efficiency of your land, sampled per 2 x 2 block, as "distance in supply ranges" for the shader:
      // < 1 in range (green), 1..3 falling (yellow to orange), 3+ at the minimum (red)
      const box = this.names.bbox(me);
      if (prev) clearRect(aux, w, prev);
      if (box) {
        const owner = state.map.owner;
        const [x0, y0, x1, y1] = box;
        for (let y = y0; y <= y1; y += 2) {
          for (let x = x0; x <= x1; x += 2) {
            const eff = supplyEfficiency(state, me, y * w + x);
            const rr = eff >= 1 ? 0.95 : 1 + ((1 - eff) / (1 - MIN_SUPPLY_EFF)) * 2.05;
            const v = 1 + Math.min(253, Math.round(rr * 84));
            for (let yy = y; yy <= Math.min(y + 1, y1); yy++) {
              for (let xx = x; xx <= Math.min(x + 1, x1); xx++) {
                const i = yy * w + xx;
                aux[i] = owner[i] === me ? v : 0;
              }
            }
          }
        }
        rect = box;
      }
    }
    this.auxMode = mode;
    this.auxRect = rect;
    const up = unionRect(prev, rect);
    if (up) {
      if (this.gl) this.gl.uploadRect('aux', aux, up[0], up[1], up[2] - up[0] + 1, up[3] - up[1] + 1);
      else if (this.map2d) this.map2d.setAux(spawn ? withFreeLand(aux, state) : aux, mode === 2 ? 2 : 1);
    }
  }
}

function clearRect(a: Uint8Array, w: number, r: [number, number, number, number]): void {
  for (let y = r[1]; y <= r[3]; y++) a.fill(0, y * w + r[0], y * w + r[2] + 1);
}
function unionRect(a: [number, number, number, number] | null, b: [number, number, number, number] | null): [number, number, number, number] | null {
  if (!a) return b;
  if (!b) return a;
  return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
}
/** Canvas2D spawn mask: free land = 1 (the GL shader works that out itself), blocked = 2. */
function withFreeLand(aux: Uint8Array, state: GameState): Uint8Array {
  const out = aux.slice();
  const { terrain, owner, fallout } = state.map;
  for (let i = 0; i < out.length; i++) if (out[i] === 0 && !isWater(terrain[i]) && owner[i] === 0 && fallout[i] <= 0) out[i] = 1;
  return out;
}

/**
 * Tribes keep a hint of their own hue as a light, dusty, solid colour: they read as small parcels of someone's
 * land (not holes, not terrain) and stay clearly calmer than the saturated nations.
 */
export function tribeDisplayColor(c: readonly number[]): RGB {
  const r = c[0] / 255;
  const g = c[1] / 255;
  const b = c[2] / 255;
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  const d = mx - mn;
  let h = 0;
  if (d > 0) h = mx === r ? ((g - b) / d + 6) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  // One neutral, nearly grey wash for every tribe (a hint of their hue and a small value step so neighbouring tribes
  // still differ; their borders separate them): saturated solid colours are for the nations only.
  const s = Math.max(0.05, Math.min(0.09, (mx > 0 ? d / mx : 0) * 0.15));
  const v = 0.6 + (mx - 0.53) * 0.12;
  const f = h - Math.floor(h);
  const p = v * (1 - s);
  const q = v * (1 - s * f);
  const t = v * (1 - s * (1 - f));
  const k = Math.floor(h) % 6;
  const rgb = k === 0 ? [v, t, p] : k === 1 ? [q, v, p] : k === 2 ? [p, v, t] : k === 3 ? [p, q, v] : k === 4 ? [t, p, v] : [v, p, q];
  return [Math.round(rgb[0] * 255), Math.round(rgb[1] * 255), Math.round(rgb[2] * 255)];
}
