// Buildings on the map, as calm, minimal markers: a small plate in the owner's colour with a white silhouette
// (icons.ts marker mode), one size per zoom, the same marker family at every zoom (no illustrated icons on the
// map). Zoom tiers (zoom = CSS px per tile):
//   far   (< FAR_ZOOM)      only cities (light squares, bigger per level) and forts (dark squares)
//   from FAR_ZOOM on        every building as a marker (at least 14 px, so it reads at normal play zoom)
// The hovered or selected building is drawn as a bigger marker. Unfinished buildings are faded with a progress
// ring; levels above 1 get a badge; damaged ones a health bar.
// Culling: a spatial grid (CELL tiles) rebuilt when the buildings change (GameState.buildingsVersion).
// Fog of war (fog/fogView.ts): buildings in view are drawn live; in explored blocks out of view the ones last seen
// there are drawn greyed, without level badge or progress; nothing in blocks never seen.
import { BUILDINGS } from '../../sim/config';
import type { Building, GameState } from '../../sim/types';
import type { Camera } from '../camera';
import { CATEGORY_COLORS, drawMarker, ICON_INFO, markerReady, type BuildingIconId } from '../icons';
import type { FogView } from '../fog/fogView';
import { buildingsKey, clamp, haloText, MAP_LABEL_FAMILY, MAP_NUM_FAMILY, setTracking, type RGB, type View } from './common';

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
    const z = cam.zoom;
    if (z < FAR_ZOOM) {
      this.drawFar(ctx, state, cam, v, z);
      return;
    }
    const size = markerSize(z);
    const ox = cam.viewW / 2 - cam.x * z;
    const oy = cam.viewH / 2 - cam.y * z;
    const pad = Math.ceil(size / z) + 1;
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
          this.drawOne(ctx, b, sx, sy, s, colors, dpr);
        }
      }
    }
    for (const b of focus) {
      const tx = b.tile % w;
      const ty = (b.tile / w) | 0;
      this.drawOne(ctx, b, ox + (tx + 0.5) * z, oy + (ty + 0.5) * z, Math.max(30, size * 1.35), colors, dpr);
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
        ctx.fillStyle = '#e3c04e';
        ctx.fill();
        ctx.lineWidth = 1;
        ctx.strokeStyle = 'rgba(20,16,6,0.9)';
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
