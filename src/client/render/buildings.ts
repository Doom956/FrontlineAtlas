// Buildings on the map, as calm, minimal markers: a small plate in the owner's colour with a white silhouette
// (icons.ts marker mode), one size per zoom, the same marker family at every zoom (no illustrated icons on the
// map). Zoom tiers (zoom = CSS px per tile):
//   far   (< FAR_ZOOM)      only cities (light squares, bigger per level) and forts (dark squares)
//   from FAR_ZOOM on        every building as a marker (at least 14 px, so it reads at normal play zoom)
// The hovered or selected building is drawn as a bigger marker. Unfinished buildings are faded with a progress
// ring; levels above 1 get a badge; damaged ones a health bar.
// From ART_ZOOM (buildingArt.ts) fort, city, SAM site and port are drawn as detailed art instead (art/detailed/buildings.ts:
// far look A at normal zoom, the close look with a "Lv N" chip from CLOSE_ZOOM); the other types keep their markers.
// Culling: a spatial grid (CELL tiles) rebuilt when the buildings change (GameState.buildingsVersion).
// Fog of war (fog/fogView.ts): buildings in view are drawn live; in explored blocks out of view the ones last seen
// there are drawn greyed, without level badge or progress; nothing in blocks never seen.
import { BUILDINGS } from '../../sim/config';
import { samRadius } from '../../sim/buildings';
import { isWater, type Building, type GameState } from '../../sim/types';
import { COAST, CU, levelPill, OU, OV } from '../art/detailed/buildings';
import type { TerrainData } from './terrain';
import { artScale, bakeArt, BuildingSprites, hasArt, lookFor, quantTint, seaFacing, specOf, spriteKey, type AddonState, type ArtLook, type Facing } from './buildingArt';
import type { Camera } from '../camera';
import { CATEGORY_COLORS, drawMarker, ICON_INFO, markerReady, type BuildingIconId } from '../icons';
import type { FogView } from '../fog/fogView';
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

/** Marker size (CSS px) for a zoom level. */
export function markerSize(zoom: number): number {
  return clamp(6 + zoom * 2.3, 16, 40);
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
  /** buildings (of the shown list) under a finished SAM site's cover of the same owner */
  private covered = new Set<Building>();
  private tints = new Map<number, RGB>();
  private facings = new Map<number, Facing>();
  /** buildings drawn last frame (stats) */
  drawn = 0;

  reset(): void {
    this.key = -1;
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
    // flak guns on forts and cities that a finished SAM site of the same owner covers (sim samRadius)
    this.covered = new Set();
    const sams = shown.filter((b) => b.type === 'sam' && b.buildLeft <= 0 && b.hp > 0 && !ghosts.has(b));
    if (sams.length > 0) {
      for (const b of shown) {
        if ((b.type !== 'city' && b.type !== 'fort') || ghosts.has(b)) continue;
        const bx = b.tile % map.width;
        const by = (b.tile / map.width) | 0;
        for (const s of sams) {
          if (s.owner !== b.owner) continue;
          const r = samRadius(s);
          const dx = (s.tile % map.width) - bx;
          const dy = ((s.tile / map.width) | 0) - by;
          if (dx * dx + dy * dy <= r * r) {
            this.covered.add(b);
            break;
          }
        }
      }
    }
    // Inside a cell: top to bottom (lower markers overlap upper ones), cities last (on top).
    for (const c of cells) c.sort((a, b) => (a.type === 'city' ? 1 : 0) - (b.type === 'city' ? 1 : 0) || a.tile - b.tile);
    this.cells = cells;
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
    this.sprites.newFrame();
    const z = cam.zoom;
    const look = lookFor(z);
    const scale = artScale(z);
    if (z < FAR_ZOOM) {
      this.drawFar(ctx, state, cam, v, z);
      return;
    }
    const size = markerSize(z);
    const ox = cam.viewW / 2 - cam.x * z;
    const oy = cam.viewH / 2 - cam.y * z;
    const pad = Math.ceil(Math.max(size, look ? CU * scale : 0) / z) + 1;
    const cx0 = Math.max(0, Math.floor((v.x0 - pad) / CELL));
    const cy0 = Math.max(0, Math.floor((v.y0 - pad) / CELL));
    const cx1 = Math.min(this.gw - 1, Math.floor((v.x1 + pad) / CELL));
    const cy1 = Math.min(this.gh - 1, Math.floor((v.y1 + pad) / CELL));
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
          if (look && hasArt(b.type) && this.drawArt(ctx, state, b, sx, sy, look, scale, z, colors, dpr, false)) continue;
          this.drawOne(ctx, b, sx, sy, s, colors, dpr);
        }
      }
    }
    for (const b of focus) {
      const tx = b.tile % w;
      const ty = (b.tile / w) | 0;
      const fx = ox + (tx + 0.5) * z;
      const fy = oy + (ty + 0.5) * z;
      if (look && hasArt(b.type) && this.drawArt(ctx, state, b, fx, fy, look, scale, z, colors, dpr, true)) continue;
      this.drawOne(ctx, b, fx, fy, Math.max(30, size * 1.35), colors, dpr);
    }
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

  /**
   * One building as detailed art, centred on its tile at (x, y) (CSS px). False = no sprite yet (the frame's bake budget is
   * spent): the caller draws the flat marker for now.
   */
  private drawArt(ctx: CanvasRenderingContext2D, state: GameState, b: Building, x: number, y: number, look: ArtLook, scale: number, zoom: number, colors: readonly RGB[], dpr: number, focus: boolean): boolean {
    const ghost = ghosts.has(b);
    const p = state.players[b.owner];
    const st: AddonState = {
      fortification: !!p && p.techs.includes('fortification'),
      radar: !!p && p.techs.includes('radar'),
      navalMastery: !!p && p.techs.includes('navalMastery'),
      samCover: this.covered.has(b),
    };
    const spec = specOf(b.type, b.level, st);
    if (!spec) return false;
    const owner: RGB = ghost ? [110, 114, 122] : (colors[b.owner] ?? [128, 128, 128]);
    const land = this.tintOf(b, state.map.width, state.map.height);
    const facing = b.type === 'port' ? this.facingOf(state, b) : 0;
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
      ctx.drawImage(bk.canvas, Math.round((x - OU * scale) * dpr) / dpr, Math.round((y - OV * scale) * dpr) / dpr, bk.w, bk.h);
      cx = x - OU * scale + bk.cx;
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
    this.drawn++;
    const bottom = y + 13 * scale;
    if (focus) {
      ctx.beginPath();
      ctx.ellipse(x, y + 2 * scale, 17 * scale, 12 * scale, 0, 0, Math.PI * 2);
      ctx.lineWidth = 2;
      ctx.strokeStyle = 'rgba(255,255,255,0.9)';
      ctx.stroke();
    }
    if (look === 'close' && !ghost) levelPill(ctx, cx, top, b.level, owner);
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
    if (look === 'close') {
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

  private drawOne(ctx: CanvasRenderingContext2D, b: Building, x: number, y: number, size: number, colors: readonly RGB[], dpr: number): void {
    const ghost = ghosts.has(b);
    const oc = colors[b.owner] ?? [128, 128, 128];
    // last seen (fog of war): a grey frame, faded, no level badge
    const c = ghost ? ([110, 114, 122] as RGB) : oc;
    const progress = b.buildLeft > 0 ? clamp(1 - b.buildLeft / Math.max(0.01, BUILDINGS[b.type].buildTime), 0, 1) : 1;
    const unfinished = progress < 1;
    const id = b.type as BuildingIconId;
    const alpha = ghost ? 0.5 : unfinished ? 0.55 : 1;
    // The plate shows what the building does (category colour: economy gold, production orange, defence blue ...);
    // a frame in the owner's colour shows whose it is.
    const r = size * 0.5;
    const fw = clamp(size * 0.1, 2, 4);
    ctx.globalAlpha = alpha;
    // Pixel Clean: a soft dark edge around the category plate, and the owner as a thin band under it (not a frame)
    ctx.fillStyle = 'rgba(12,15,20,0.55)';
    ctx.beginPath();
    ctx.roundRect(x - r - 1, y - r - 1, size + 2, size + fw + 3, size * 0.26);
    ctx.fill();
    ctx.fillStyle = `rgb(${c[0]},${c[1]},${c[2]})`;
    ctx.beginPath();
    ctx.roundRect(x - r + size * 0.12, y + r - 1, size * 0.76, fw + 1, Math.min(2, fw / 2));
    ctx.fill();
    ctx.globalAlpha = 1;
    const cat = ICON_INFO[id].category;
    const opts = { plate: cat ? CATEGORY_PLATES[cat] : c, dpr };
    if (markerReady(id, size, opts) || this.budget-- > 0) drawMarker(ctx, id, x, y, size, { ...opts, alpha });
    else drawMarker(ctx, id, x, y, size, { plate: NEUTRAL_PLATE, dpr, alpha });
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
    const queued = Math.min(5, b.queuedLevels || 0);
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
    if (b.hp > 0 && b.hp < 1) {
      const bw = size;
      ctx.fillStyle = 'rgba(0,0,0,0.65)';
      ctx.fillRect(x - r, y + r + fw + 2, bw, 3);
      ctx.fillStyle = b.hp > 0.5 ? '#e8c84a' : '#e0503c';
      ctx.fillRect(x - r, y + r + fw + 2, bw * b.hp, 3);
    }
    if (size >= NAME_MARKER_PX) {
      // close up (zoom 8+): the building's name under its marker
      ctx.font = `500 11px ${MAP_LABEL_FAMILY}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      const ny = y + r + fw + (b.hp > 0 && b.hp < 1 ? 7 : 4);
      setTracking(ctx, 0);
      haloText(ctx, BUILDINGS[b.type].name, x, ny, 'rgba(244,245,247,0.95)', 11, 0.9);
      setTracking(ctx, 0);
    }
  }
}
