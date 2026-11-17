// Buildings on the map, as calm, minimal markers: a small plate in the owner's colour with a white silhouette
// (icons.ts marker mode), one size per zoom, the same marker family at every zoom (no illustrated icons on the
// map). Zoom tiers (zoom = CSS px per tile):
//   far   (< FAR_ZOOM)      only cities (light squares, bigger per level) and forts (dark squares)
//   from FAR_ZOOM on        every building as a marker (at least 14 px, so it reads at normal play zoom)
// The hovered or selected building is drawn as a bigger marker. Unfinished buildings are faded with a progress
// ring; levels above 1 get a badge; damaged ones a health bar.
// From ART_ZOOM (buildingArt.ts) fort, city, SAM site and port are drawn as detailed art instead (art/detailed/buildings.ts:
// far look A at normal zoom, the close look with a "Lv N" chip from CLOSE_ZOOM); the other types keep their markers.
// Forts and Cities of a Flak Guns holder (sim/defense.ts) carry AA gun pits on the art, and two small AA guns on their
// marker below ART_ZOOM (art/detailed/flak.ts).
// Culling: a spatial grid (CELL tiles) rebuilt when the buildings change (GameState.buildingsVersion).
// Fog of war (fog/fogView.ts): buildings in view are drawn live; in explored blocks out of view the ones last seen
// there are drawn greyed, without level badge or progress; nothing in blocks never seen.
import { BUILDINGS } from '../../sim/config';
import { buildingSpacing } from '../../sim/buildings';
import { isWater, type Building, type GameState } from '../../sim/types';
import { COAST, CU, levelPill, OU, OV } from '../art/detailed/buildings';
import type { TerrainData } from './terrain';
import { ART_ZOOM, artScale, bakeArt, balanceShift, BuildingSprites, fitScale, hasArt, lookFor, quantTint, seaFacing, specOf, spriteKey, type AddonState, type ArtLook, type Facing } from './buildingArt';
import type { Camera } from '../camera';
import { CATEGORY_COLORS, drawMarker, ICON_INFO, markerReady, type BuildingIconId } from '../icons';
import type { FogView } from '../fog/fogView';
import { drawFlakGuns } from '../art/detailed/flak';
import { isBatterySite } from '../../sim/defense';
import { RADAR_GREEN } from '../fx/defenseFx';
import { prefersReducedMotion } from '../fx/settings';
import type { GunAim } from '../fx/gunAim';
import { GunLayer } from './gunLayer';
import { LinkLayer, linkInput, linkKey, linksShown, type LinkEnd } from './linkLayer';
import { gridOf } from '../art/detailed/grid';
import { hasTech } from '../../sim/tech';
import { ACCENT, buildingsKey, clamp, haloText, MAP_LABEL_FAMILY, MAP_NUM_FAMILY, setTracking, type RGB, type View } from './common';

export const FAR_ZOOM = 1.7;
const CELL = 32;
/** New marker sprites rendered per frame at most (the rest use a neutral plate until their turn). */
const SPRITE_BUDGET = 24;
const NEUTRAL_PLATE = '#5d6573';
/** Markers at least this big (zoom 8+, markerSize) get the building's name underneath. */
const NAME_MARKER_PX = markerSize(8);
/** Marker plates by building category: the legend's category colours, darkened so the white glyph reads. */
export const CATEGORY_PLATES: Record<keyof typeof CATEGORY_COLORS, string> = {
  economy: '#a57c14',
  production: '#a8481a',
  defence: '#2f5fa6',
  logistics: '#2a7a4b',
  advanced: '#6e3ca3',
};

/** How far a marker plate is pulled toward the land under it (its category colour stays the main colour, the glyph stays white). */
const PLATE_LAND_PULL = 0.34;
/** A category plate colour (hex) pulled toward the land colour under it, snapped to steps of 12 so the marker sprites stay few. */
export function landPlate(hex: string, land: readonly number[]): string {
  const q = (v: number): number => Math.max(0, Math.min(255, Math.round(v / 12) * 12));
  const ch = (k: number): number => {
    const base = parseInt(hex.slice(1 + k * 2, 3 + k * 2), 16);
    return q(base + (land[k] - base) * PLATE_LAND_PULL);
  };
  return `rgb(${ch(0)},${ch(1)},${ch(2)})`;
}

/** Marker size (CSS px) for a zoom level. */
export function markerSize(zoom: number): number {
  return clamp(6 + zoom * 2.3, 16, 40);
}

/** One turn of the radar sweep (ms). */
export const SWEEP_MS = 4200;
/**
 * The radar sweep: a faint green ring on the ground ellipse (rx x ry px round (x, y)) and a beam turning once every
 * SWEEP_MS with a fading wedge behind it (a still beam with reduced motion).
 */
export function radarSweep(ctx: CanvasRenderingContext2D, x: number, y: number, rx: number, ry: number, nowMs: number): void {
  const a0 = prefersReducedMotion() ? -Math.PI / 4 : ((nowMs % SWEEP_MS) / SWEEP_MS) * Math.PI * 2;
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(1, ry / rx);
  ctx.strokeStyle = 'rgba(93,255,138,0.55)';
  ctx.lineWidth = 1.25;
  ctx.beginPath();
  ctx.arc(0, 0, rx, 0, Math.PI * 2);
  ctx.stroke();
  const steps = 8;
  for (let k = 0; k < steps; k++) {
    ctx.globalAlpha = 0.32 * (1 - k / steps);
    ctx.fillStyle = RADAR_GREEN;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.arc(0, 0, rx, a0 - (k + 1) * 0.12, a0 - k * 0.12);
    ctx.closePath();
    ctx.fill();
  }
  ctx.globalAlpha = 0.9;
  ctx.strokeStyle = RADAR_GREEN;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(Math.cos(a0) * rx, Math.sin(a0) * rx);
  ctx.stroke();
  ctx.restore();
}

/** Milliseconds the flat icon over a hovered or selected building takes to fade in. */
export const POP_FADE_MS = 140;

/**
 * Which of the focused buildings (hovered, selected or tapped tiles) show their flat icon floating above the art: none below
 * ART_ZOOM (there every building is already a flat marker), all of them from ART_ZOOM on.
 */
export function popIconTiles(focus: readonly number[], zoom: number): number[] {
  return zoom >= ART_ZOOM ? focus.filter((t, i) => focus.indexOf(t) === i) : [];
}

/** Fade-in progress (0..1) of a popped icon that started at `since` (ms), eased. */
export function popFade(since: number, now: number): number {
  const t = clamp((now - since) / POP_FADE_MS, 0, 1);
  return t * (2 - t);
}

/** Remembered (last seen, out of view) markers: drawn greyed. */
const ghosts = new WeakSet<Building>();

export class BuildingLayer {
  private key = -1;
  private fogGen = -1;
  /** fog of war view (set by the renderer each frame; null or inactive = no fog) */
  fog: FogView | null = null;
  private w = 0;
  private gw = 0;
  private gh = 0;
  private cells: Building[][] = [];
  private cities: Building[] = [];
  private forts: Building[] = [];
  private budget = 0;
  /** the map's terrain colours (set by the renderer; null = flat grey ground under the art) */
  terr: TerrainData | null = null;
  private readonly sprites = new BuildingSprites();
  private tints = new Map<number, RGB>();
  private facings = new Map<number, Facing>();
  /** buildings drawn last frame (stats) */
  drawn = 0;
  /** owners holding Flak Guns (their Forts and Cities get AA guns on the marker); set each frame */
  private flak = new Set<number>();
  /** where the turning guns point and fire (fx/gunAim.ts); set by the renderer, null = guns stay idle */
  guns: GunAim | null = null;
  private readonly gunLayer = new GunLayer();
  /** the connected buildings (quay, trench, road, fence) drawn under the art at art zoom */
  readonly links = new LinkLayer();
  private shown: Building[] = [];
  private shownByTile = new Map<number, Building>();

  reset(): void {
    this.key = -1;
    this.links.reset();
  }

  private rebuild(state: GameState): void {
    const map = state.map;
    this.w = map.width;
    this.gw = Math.ceil(map.width / CELL);
    this.gh = Math.ceil(map.height / CELL);
    const cells: Building[][] = new Array(this.gw * this.gh);
    for (let k = 0; k < cells.length; k++) cells[k] = [];
    this.cities = [];
    this.forts = [];
    this.tints.clear();
    this.facings.clear();
    const fog = this.fog?.active ? this.fog : null;
    const shown: Building[] = [];
    if (!fog) for (const b of state.buildings.values()) shown.push(b);
    else {
      for (const b of state.buildings.values()) if (fog.visible(b.tile)) shown.push(b);
      for (const [tile, r] of fog.buildings) {
        if (fog.visible(tile)) continue;
        const g: Building = { id: -1 - tile, type: r.type, owner: r.owner, tile, level: r.level, buildLeft: 0, upgradeLeft: 0, fighters: 0, bombers: 0, cooldown: 0, dropCooldown: 0, disabledUntil: 0, hp: 1, queuedLevels: 0 };
        ghosts.add(g);
        shown.push(g);
      }
    }
    for (const b of shown) {
      const x = b.tile % map.width;
      const y = (b.tile / map.width) | 0;
      cells[((y / CELL) | 0) * this.gw + ((x / CELL) | 0)].push(b);
      if (b.type === 'city') this.cities.push(b);
      else if (b.type === 'fort') this.forts.push(b);
    }
    // Inside a cell: top to bottom (lower markers overlap upper ones), cities last (on top).
    for (const c of cells) c.sort((a, b) => (a.type === 'city' ? 1 : 0) - (b.type === 'city' ? 1 : 0) || a.tile - b.tile);
    this.cells = cells;
    this.shown = shown;
    this.shownByTile = new Map(shown.map((b) => [b.tile, b]));
  }

  draw(
    ctx: CanvasRenderingContext2D,
    state: GameState,
    cam: Camera,
    v: View,
    colors: readonly RGB[],
    focusTiles: readonly number[],
    dpr: number,
  ): void {
    const key = buildingsKey(state);
    const fg = this.fog?.active ? this.fog.gen : -1;
    if (key !== this.key || fg !== this.fogGen || state.map.width !== this.w || this.cells.length === 0) {
      this.key = key;
      this.fogGen = fg;
      this.rebuild(state);
    }
    this.drawn = 0;
    this.budget = SPRITE_BUDGET;
    this.popSeen.clear();
    this.sprites.newFrame();
    this.gunLayer.newFrame();
    this.links.newFrame();
    this.flak.clear();
    for (const p of state.players) if (p.id > 0 && p.alive && hasTech(p, 'flakGuns')) this.flak.add(p.id);
    const z = cam.zoom;
    const look = lookFor(z);
    if (z < FAR_ZOOM) {
      this.drawFar(ctx, state, cam, v, z);
      return;
    }
    const size = markerSize(z);
    const ox = cam.viewW / 2 - cam.x * z;
    const oy = cam.viewH / 2 - cam.y * z;
    const pad = Math.ceil(Math.max(size, look ? CU * artScale(z) : 0) / z) + 1;
    const cx0 = Math.max(0, Math.floor((v.x0 - pad) / CELL));
    const cy0 = Math.max(0, Math.floor((v.y0 - pad) / CELL));
    const cx1 = Math.min(this.gw - 1, Math.floor((v.x1 + pad) / CELL));
    const cy1 = Math.min(this.gh - 1, Math.floor((v.y1 + pad) / CELL));
    if (look) this.drawLinks(ctx, state, ox, oy, cam, z, look, dpr);
    const w = this.w;
    const focus: Building[] = [];
    for (let cy = cy0; cy <= cy1; cy++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        const list = this.cells[cy * this.gw + cx];
        for (let k = 0; k < list.length; k++) {
          const b = list[k];
          const tx = b.tile % w;
          const ty = (b.tile / w) | 0;
          if (tx < v.x0 - pad || tx >= v.x1 + pad || ty < v.y0 - pad || ty >= v.y1 + pad) continue;
          if (focusTiles.includes(b.tile)) {
            focus.push(b);
            continue;
          }
          const sx = ox + (tx + 0.5) * z;
          const sy = oy + (ty + 0.5) * z;
          const s = b.type === 'city' ? size * 1.18 : size;
          if (look && hasArt(b.type) && this.drawArt(ctx, state, b, sx, sy, look, z, colors, dpr, false)) continue;
          this.drawOne(ctx, b, sx, sy, s, colors, dpr, this.tintOf(b, w, state.map.height));
        }
      }
    }
    const pops = popIconTiles(focusTiles, z);
    for (const b of focus) {
      const tx = b.tile % w;
      const ty = (b.tile / w) | 0;
      const fx = ox + (tx + 0.5) * z;
      const fy = oy + (ty + 0.5) * z;
      if (look && hasArt(b.type) && this.drawArt(ctx, state, b, fx, fy, look, z, colors, dpr, true, pops.includes(b.tile))) continue;
      this.drawOne(ctx, b, fx, fy, Math.max(30, size * 1.35), colors, dpr, this.tintOf(b, w, state.map.height));
    }
    for (const t of this.popSince.keys()) if (!this.popSeen.has(t)) this.popSince.delete(t);
  }

  /** Far zoom: cities as light squares (bigger per level), forts as dark squares; two fills for all of them. */
  private drawFar(ctx: CanvasRenderingContext2D, state: GameState, cam: Camera, v: View, z: number): void {
    const w = this.w;
    const ox = cam.viewW / 2 - cam.x * z;
    const oy = cam.viewH / 2 - cam.y * z;
    const base = clamp(1.5 + z * 0.7, 2, 4);
    ctx.beginPath();
    for (const b of this.cities) {
      const tx = b.tile % w;
      const ty = (b.tile / w) | 0;
      if (tx < v.x0 - 2 || tx >= v.x1 + 2 || ty < v.y0 - 2 || ty >= v.y1 + 2) continue;
      const s = base + (b.level - 1) * 0.6;
      ctx.rect(ox + (tx + 0.5) * z - s / 2, oy + (ty + 0.5) * z - s / 2, s, s);
      this.drawn++;
    }
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(16,18,24,0.85)';
    ctx.stroke();
    ctx.fillStyle = '#f6f3ea';
    ctx.fill();
    if (z < 1.2) return;
    ctx.beginPath();
    for (const b of this.forts) {
      const tx = b.tile % w;
      const ty = (b.tile / w) | 0;
      if (tx < v.x0 - 2 || tx >= v.x1 + 2 || ty < v.y0 - 2 || ty >= v.y1 + 2 || b.buildLeft > 0) continue;
      const s = base;
      ctx.rect(ox + (tx + 0.5) * z - s / 2, oy + (ty + 0.5) * z - s / 2, s, s);
      this.drawn++;
    }
    ctx.strokeStyle = 'rgba(245,245,240,0.9)';
    ctx.stroke();
    ctx.fillStyle = '#2a2e36';
    ctx.fill();
  }

  /** The ground colour under a building: the real terrain colour of its tile and the land round it, snapped for sharing. */
  private tintOf(b: Building, w: number, h: number): RGB {
    const hit = this.tints.get(b.tile);
    if (hit) return hit;
    let out: RGB = [128, 128, 128];
    const terr = this.terr;
    if (terr && terr.rgba.length >= w * h * 4) {
      const x = b.tile % w;
      const y = (b.tile / w) | 0;
      let r = 0;
      let g = 0;
      let bl = 0;
      let n = 0;
      for (let j = -1; j <= 1; j++) {
        for (let i = -1; i <= 1; i++) {
          const tx = x + i;
          const ty = y + j;
          if (tx < 0 || ty < 0 || tx >= w || ty >= h) continue;
          const o = (ty * w + tx) * 4;
          // a coastal port's own neighbours may be sea: those do not tint the land
          if (b.type === 'port' && terr.depth[ty * w + tx] > 0) continue;
          r += terr.rgba[o];
          g += terr.rgba[o + 1];
          bl += terr.rgba[o + 2];
          n++;
        }
      }
      if (n > 0) out = quantTint([r / n, g / n, bl / n]);
    }
    this.tints.set(b.tile, out);
    return out;
  }

  /** Which way a port faces the sea (the map's real coast), cached per tile. */
  private facingOf(state: GameState, b: Building): Facing {
    const hit = this.facings.get(b.tile);
    if (hit !== undefined) return hit;
    const w = state.map.width;
    const h = state.map.height;
    const x = b.tile % w;
    const y = (b.tile / w) | 0;
    const f = seaFacing((dx, dy) => {
      const tx = x + dx;
      const ty = y + dy;
      return tx >= 0 && ty >= 0 && tx < w && ty < h && isWater(state.map.terrain[ty * w + tx]);
    });
    this.facings.set(b.tile, f);
    return f;
  }

  /** The add-ons a building shows (flak pits, radar dish, coastal guns); none on a remembered ghost. */
  private addonState(state: GameState, b: Building, ghost: boolean): AddonState {
    const p = state.players[b.owner];
    return { flak: !ghost && this.flak.has(b.owner), radar: !ghost && !!p && hasTech(p, 'trackingRadar'), guns: !ghost && isBatterySite(state, b) };
  }

  /** The connected buildings under the art (quay, trench, road, fence); art zoom only. */
  private drawLinks(ctx: CanvasRenderingContext2D, state: GameState, ox: number, oy: number, cam: Camera, z: number, look: ArtLook, dpr: number): void {
    if (!linksShown(z)) return;
    const endOf = (b: Building): LinkEnd => {
      const spec = specOf(b.type, b.level, this.addonState(state, b, ghosts.has(b)));
      return { tile: b.tile, type: b.type as LinkEnd['type'], level: b.level, facing: b.type === 'port' ? this.facingOf(state, b) : 0, sig: spec ? `${spec.type}${spec.level}${spec.addon ?? ''}` : b.type };
    };
    this.links.set.update(linkKey(this.key, this.fogGen, state.tick, state.map.width), () => {
      return linkInput(state, this.shown, endOf);
    });
    this.links.draw(ctx, {
      state,
      terr: this.terr,
      ox,
      oy,
      zoom: z,
      look,
      dpr,
      viewW: cam.viewW,
      viewH: cam.viewH,
      specOf: (e) => {
        const b = this.shownByTile.get(e.tile);
        return b ? specOf(b.type, b.level, this.addonState(state, b, ghosts.has(b))) : null;
      },
    });
  }

  /**
   * One building as detailed art, centred on its tile at (x, y) (CSS px). False = no sprite yet (the frame's bake budget is
   * spent): the caller draws the flat marker for now.
   */
  private drawArt(ctx: CanvasRenderingContext2D, state: GameState, b: Building, x: number, y: number, look: ArtLook, zoom: number, colors: readonly RGB[], dpr: number, focus: boolean, pop = false): boolean {
    const ghost = ghosts.has(b);
    const spec = specOf(b.type, b.level, this.addonState(state, b, ghost));
    if (!spec) return false;
    const owner: RGB = ghost ? [110, 114, 122] : (colors[b.owner] ?? [128, 128, 128]);
    const land = this.tintOf(b, state.map.width, state.map.height);
    const facing = b.type === 'port' ? this.facingOf(state, b) : 0;
    const fit = fitScale(spec, look, facing, zoom, buildingSpacing(state));
    if (!fit) return false;
    const scale = fit.scale;
    const key = spriteKey(spec, owner, look, scale, dpr, land, facing);
    const sp = this.sprites.get(key, () => bakeArt(spec, owner, look, scale, dpr, land, this.terr?.theme));
    if (!sp) return false;
    const bk = sp.baked;
    const unfinished = b.buildLeft > 0;
    ctx.save();
    ctx.globalAlpha = ghost ? 0.5 : unfinished ? 0.55 : 1;
    ctx.imageSmoothingEnabled = false;
    let top = y - OV * scale + bk.top - 15;
    let cx = x;
    if (facing === 0 && b.type !== 'port') {
      const sx = x + balanceShift(spec, look) * scale;
      ctx.drawImage(bk.canvas, Math.round((sx - OU * scale) * dpr) / dpr, Math.round((y - OV * scale) * dpr) / dpr, bk.w, bk.h);
      cx = sx - OU * scale + bk.cx;
    } else {
      // a port: the model's coast line (u = COAST) lies on the tile's edge toward the sea, the pier reaches out to sea
      const dx = [1, 0, -1, 0][facing];
      const dy = [0, 1, 0, -1][facing];
      const ax = x + dx * zoom * 0.5 - dx * COAST * scale;
      const ay = y + dy * zoom * 0.5 - dy * COAST * scale;
      ctx.translate(ax, ay);
      ctx.rotate((facing * Math.PI) / 2);
      ctx.drawImage(bk.canvas, -OU * scale, -OV * scale, bk.w, bk.h);
      top = y - 16 * scale;
      cx = x;
    }
    ctx.restore();
    // the turning guns (flak pits, coastal batteries) over the sprite: their heads turn toward their target and fire
    if (this.guns && spec.addon && (spec.addon === 'flak' || spec.addon === 'guns') && !ghost && !unfinished) {
      const g = gridOf(scale, dpr);
      let ax = Math.round((x + balanceShift(spec, look) * scale - OU * scale) * dpr) / dpr + Math.round(OU * g.res) * g.k;
      let ay = Math.round((y - OV * scale) * dpr) / dpr + Math.round(OV * g.res) * g.k;
      if (facing !== 0 || b.type === 'port') {
        ax = x + [1, 0, -1, 0][facing] * zoom * 0.5 - [1, 0, -1, 0][facing] * COAST * scale;
        ay = y + [0, 1, 0, -1][facing] * zoom * 0.5 - [0, 1, 0, -1][facing] * COAST * scale;
      }
      this.gunLayer.draw(ctx, this.guns, { tile: b.tile, spec, owner, look, scale, zoom, dpr, btx: (b.tile % state.map.width) + 0.5, bty: ((b.tile / state.map.width) | 0) + 0.5, x, y, ax, ay, turns: facing, sea: b.type === 'port' ? (facing * Math.PI) / 2 : 0, alpha: 1, nowMs: performance.now() });
    }
    this.drawn++;
    const bottom = y + 13 * scale;
    // Tracking Radar (sim/defense.ts): a slow green sweep over a working SAM site's ground
    if (spec.addon === 'radar' && !ghost && !unfinished && b.disabledUntil <= state.tick) radarSweep(ctx, x, y + 2 * scale, 30 * scale, 21 * scale, performance.now());
    if (focus) {
      ctx.beginPath();
      ctx.ellipse(x, y + 2 * scale, 17 * scale, 12 * scale, 0, 0, Math.PI * 2);
      ctx.lineWidth = 2;
      ctx.strokeStyle = 'rgba(255,255,255,0.9)';
      ctx.stroke();
    }
    if (look === 'close' && fit.chip && !ghost) levelPill(ctx, cx, top, b.level, owner);
    if (pop && !ghost) this.drawPop(ctx, b, cx, top, zoom, colors, dpr, state);
    // construction progress: a small bar under the building (the flat marker shows a ring)
    if (unfinished) {
      const progress = clamp(1 - b.buildLeft / Math.max(0.01, BUILDINGS[b.type].buildTime), 0, 1);
      const bw = 34;
      ctx.fillStyle = 'rgba(0,0,0,0.65)';
      ctx.fillRect(x - bw / 2, bottom, bw, 4);
      ctx.fillStyle = 'rgba(255,255,255,0.95)';
      ctx.fillRect(x - bw / 2, bottom, bw * progress, 4);
    }
    // levels queued by Build x3 / x5 or Upgrade area: small pips under the building
    const queued = Math.min(5, b.queuedLevels || 0);
    if (queued > 0 && !ghost) {
      for (let k = 0; k < queued; k++) {
        const px = x + (k - (queued - 1) / 2) * 7;
        ctx.beginPath();
        ctx.arc(px, bottom + 11, 2.6, 0, Math.PI * 2);
        ctx.fillStyle = ACCENT;
        ctx.fill();
        ctx.lineWidth = 1;
        ctx.strokeStyle = 'rgba(10,18,44,0.9)';
        ctx.stroke();
      }
    }
    if (b.hp > 0 && b.hp < 1) {
      const bw = 34;
      ctx.fillStyle = 'rgba(0,0,0,0.65)';
      ctx.fillRect(x - bw / 2, bottom + 6 + (unfinished ? 3 : 0) + (queued > 0 ? 10 : 0), bw, 3);
      ctx.fillStyle = b.hp > 0.5 ? '#e8c84a' : '#e0503c';
      ctx.fillRect(x - bw / 2, bottom + 6 + (unfinished ? 3 : 0) + (queued > 0 ? 10 : 0), bw * b.hp, 3);
    }
    if (look === 'close' && fit.name) {
      // close up: the building's name under it
      ctx.font = `500 11px ${MAP_LABEL_FAMILY}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      setTracking(ctx, 0);
      haloText(ctx, BUILDINGS[b.type].name, x, bottom + (b.hp > 0 && b.hp < 1 ? 14 : 8) + (queued > 0 ? 10 : 0) + (unfinished ? 4 : 0), 'rgba(244,245,247,0.95)', 11, 0.9);
      setTracking(ctx, 0);
    }
    return true;
  }

  /** Pop-up icons: when each focused tile started showing its icon (ms), for the fade. */
  private popSince = new Map<number, number>();
  private popSeen = new Set<number>();

  /** The flat icon (same look and size as below ART_ZOOM, with its level badge) floating above a focused building's art, clear of the "Lv N" chip that hangs under the art's top edge. */
  private drawPop(ctx: CanvasRenderingContext2D, b: Building, x: number, top: number, zoom: number, colors: readonly RGB[], dpr: number, state: GameState): void {
    const now = performance.now();
    let since = this.popSince.get(b.tile);
    if (since === undefined) {
      since = now;
      this.popSince.set(b.tile, since);
    }
    this.popSeen.add(b.tile);
    const size = markerSize(zoom);
    this.drawOne(ctx, b, x, top - 9 - size / 2, size, colors, dpr, this.tintOf(b, this.w, state.map.height), popFade(since, now), true);
  }

  private drawOne(ctx: CanvasRenderingContext2D, b: Building, x: number, y: number, size: number, colors: readonly RGB[], dpr: number, land: RGB | null = null, fade = 1, bare = false): void {
    const ghost = ghosts.has(b);
    const oc = colors[b.owner] ?? [128, 128, 128];
    // last seen (fog of war): a grey frame, faded, no level badge
    const c = ghost ? ([110, 114, 122] as RGB) : oc;
    const progress = b.buildLeft > 0 ? clamp(1 - b.buildLeft / Math.max(0.01, BUILDINGS[b.type].buildTime), 0, 1) : 1;
    const unfinished = progress < 1;
    const id = b.type as BuildingIconId;
    const alpha = (ghost ? 0.5 : unfinished ? 0.55 : 1) * fade;
    // The plate shows what the building does (category colour: economy gold, production orange, defence blue ...);
    // a frame in the owner's colour shows whose it is.
    const r = size * 0.5;
    const fw = clamp(size * 0.1, 2, 4);
    ctx.globalAlpha = alpha;
    // Pixel Clean: a soft dark edge around the category plate, and the owner as a thin band under it (not a frame)
    ctx.fillStyle = land ? 'rgba(12,15,20,0.38)' : 'rgba(12,15,20,0.55)';
    ctx.beginPath();
    ctx.roundRect(x - r - 1, y - r - 1, size + 2, size + fw + 3, size * 0.26);
    ctx.fill();
    ctx.fillStyle = `rgb(${c[0]},${c[1]},${c[2]})`;
    ctx.beginPath();
    ctx.roundRect(x - r + size * 0.12, y + r - 1, size * 0.76, fw + 1, Math.min(2, fw / 2));
    ctx.fill();
    ctx.globalAlpha = fade;
    const cat = ICON_INFO[id].category;
    const opts = { plate: land && cat ? landPlate(CATEGORY_PLATES[cat], land) : cat ? CATEGORY_PLATES[cat] : c, dpr };
    if (markerReady(id, size, opts) || this.budget-- > 0) drawMarker(ctx, id, x, y, size, { ...opts, alpha });
    else drawMarker(ctx, id, x, y, size, { plate: NEUTRAL_PLATE, dpr, alpha });
    if ((b.type === 'fort' || b.type === 'city') && !ghost && !unfinished && this.flak.has(b.owner)) drawFlakGuns(ctx, x, y, size, dpr, alpha);
    this.drawn++;
    if (unfinished) {
      ctx.beginPath();
      ctx.arc(x, y, r + 2.5, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * progress);
      ctx.lineWidth = 2;
      ctx.strokeStyle = 'rgba(255,255,255,0.95)';
      ctx.stroke();
    }
    if (b.level > 1 && !ghost) {
      const br = clamp(size * 0.22, 4.5, 8);
      const bx = x + r * 0.78;
      const by = y - r * 0.78;
      ctx.beginPath();
      ctx.arc(bx, by, br, 0, Math.PI * 2);
      ctx.fillStyle = '#f4f5f1';
      ctx.fill();
      ctx.lineWidth = 1.2;
      ctx.strokeStyle = 'rgba(14,18,24,0.85)';
      ctx.stroke();
      ctx.fillStyle = '#1a1f27';
      ctx.font = `600 ${Math.round(br * 1.3)}px ${MAP_NUM_FAMILY}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(b.level), bx, by + 0.5);
    }
    // levels queued by Build x3 / x5 or Upgrade area (Action buildMany / upgradeArea): small pips down the right edge
    const queued = bare ? 0 : Math.min(5, b.queuedLevels || 0);
    if (queued > 0 && size >= 12) {
      const pr = clamp(size * 0.075, 1.6, 2.6);
      const px = x + r + fw + pr + 1.5;
      for (let k = 0; k < queued; k++) {
        const py = y - r + pr + k * (pr * 2 + 1.5);
        ctx.beginPath();
        ctx.arc(px, py, pr, 0, Math.PI * 2);
        ctx.fillStyle = ACCENT;
        ctx.fill();
        ctx.lineWidth = 1;
        ctx.strokeStyle = 'rgba(10,18,44,0.9)';
        ctx.stroke();
      }
    }
    if (!bare && b.hp > 0 && b.hp < 1) {
      const bw = size;
      ctx.fillStyle = 'rgba(0,0,0,0.65)';
      ctx.fillRect(x - r, y + r + fw + 2, bw, 3);
      ctx.fillStyle = b.hp > 0.5 ? '#e8c84a' : '#e0503c';
      ctx.fillRect(x - r, y + r + fw + 2, bw * b.hp, 3);
    }
    if (!bare && size >= NAME_MARKER_PX) {
      // close up (zoom 8+): the building's name under its marker
      ctx.font = `500 11px ${MAP_LABEL_FAMILY}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      const ny = y + r + fw + (b.hp > 0 && b.hp < 1 ? 7 : 4);
      setTracking(ctx, 0);
      haloText(ctx, BUILDINGS[b.type].name, x, ny, 'rgba(244,245,247,0.95)', 11, 0.9);
      setTracking(ctx, 0);
    }
    ctx.globalAlpha = 1;
  }
}
