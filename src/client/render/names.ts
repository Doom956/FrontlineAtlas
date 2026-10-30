// Nation labels at scale (hundreds of players): name + army size in the largest inscribed rectangle of each
// player's territory, with status icons (crown #1, handshake ally, envelope pending request, broken shield traitor),
// tribes smaller and muted, and a troop-mix bar under your own label.
//
// Placement works on a coarse owner grid (one sample tile per F x F cell, F chosen so the grid has at most
// ~GRID_CELLS cells), kept current from the tile change feed. Bounding boxes come from one pass over the grid every
// BBOX_MS; the largest-rectangle search (labels.ts sizing rules) runs for a few players per frame so every label is
// refreshed about every REFRESH_MS. Labels glide to their new place and size.
import { areAllied, isTraitor } from '../../sim/diplomacy';
import { armyTotal } from '../../sim/economy';
import { isTribe } from '../../sim/types';
import type { GameState, Player } from '../../sim/types';
import type { Camera } from '../camera';
import { drawIcon, type StatusIconId } from '../icons';
import { fitSize, LABEL_BLOCK_H, LABEL_CHAR_W } from '../labels';
import { clamp, formatCount, haloText, MAP_LABEL_FAMILY, MAP_NUM_FAMILY, setTracking } from './common';
import { OWNER_MASK, type TileFeed } from './tiles';

/** Tribe labels only from this zoom (device px per tile) on, except the hovered tribe. */
export const TRIBE_LABEL_ZOOM = 3.2;
/** Below this zoom a tribe shows only its army number (its full name on hover and from here on). */
export const TRIBE_NAME_ZOOM = 6;
/** From this zoom building markers are drawn: a label over them fades so the icons stay readable. */
const ICON_ZOOM = 1.7;

const GRID_CELLS = 250_000;
const MAX_RECT_CELLS = 2400;
const BBOX_MS = 1000;
const REFRESH_MS = 2500;
const GLIDE_MS = 600;
const MIX_COLORS = ['#e4dccb', '#76b3ec', '#f0a15e'];
void LABEL_BLOCK_H;

interface Label {
  id: number;
  fx: number;
  fy: number;
  fs: number;
  tx: number;
  ty: number;
  ts: number;
  t0: number;
  tiles: number;
  /** coarse cells owned when placed */
  cells: number;
  done: number;
}

export interface NameStyle {
  hoverOwner: number;
  targeting: boolean;
  /** hovered point on screen (labels under it fade), or null */
  hover: { x: number; y: number } | null;
}

export class NameLayer {
  private F = 1;
  private gw = 0;
  private gh = 0;
  private w = 0;
  private h = 0;
  private grid = new Uint16Array(0);
  private gen = -1;
  private bboxMs = -Infinity;
  private minX = new Int32Array(0);
  private minY = new Int32Array(0);
  private maxX = new Int32Array(0);
  private maxY = new Int32Array(0);
  private count = new Int32Array(0);
  private heights = new Int32Array(0);
  private stack = new Int32Array(0);
  private labels = new Map<number, Label>();
  private cursor = 1;
  /** labels drawn last frame (stats) */
  drawn = 0;
  computed = 0;

  setGame(state: GameState): void {
    const { width: w, height: h } = state.map;
    this.w = w;
    this.h = h;
    this.F = Math.max(1, Math.ceil(Math.sqrt((w * h) / GRID_CELLS)));
    this.gw = Math.ceil(w / this.F);
    this.gh = Math.ceil(h / this.F);
    this.grid = new Uint16Array(this.gw * this.gh);
    this.gen = -1;
    this.bboxMs = -Infinity;
    this.labels.clear();
    this.cursor = 1;
  }

  /** Tile feed listener: keeps the coarse grid current (only a cell's sample tile matters). */
  readonly onChange = (tile: number, _old: number, nw: number): void => {
    const F = this.F;
    const x = tile % this.w;
    const y = (tile / this.w) | 0;
    const gx = (x / F) | 0;
    const gy = (y / F) | 0;
    const half = F >> 1;
    if (x !== Math.min(this.w - 1, gx * F + half) || y !== Math.min(this.h - 1, gy * F + half)) return;
    this.grid[gy * this.gw + gx] = nw;
  };

  /** Brings the grid and boxes up to date and recomputes a few labels. */
  update(state: GameState, feed: TileFeed, nowMs: number): void {
    if (feed.fullGen !== this.gen) {
      this.gen = feed.fullGen;
      this.rebuildGrid(feed);
      this.bboxMs = -Infinity;
    }
    const n = state.players.length;
    if (this.count.length < n) {
      this.minX = new Int32Array(n);
      this.minY = new Int32Array(n);
      this.maxX = new Int32Array(n);
      this.maxY = new Int32Array(n);
      this.count = new Int32Array(n);
    }
    if (nowMs - this.bboxMs >= BBOX_MS) {
      this.bboxMs = nowMs;
      this.boxes(n);
    }
    // Round robin: about every player each REFRESH_MS (at 60 fps), new labels first.
    const alive = state.players.filter((p) => p && p.alive && p.id > 0).length;
    let budget = Math.max(3, Math.ceil(alive / ((REFRESH_MS / 1000) * 60)));
    let urgent = Math.max(budget, 12);
    this.computed = 0;
    for (const p of state.players) {
      if (urgent <= 0) break;
      if (!p || !p.alive || p.id === 0 || this.count[p.id] === 0) continue;
      // new labels, and labels whose land grew or shrank a lot since they were placed, go first
      const l = this.labels.get(p.id);
      if (l) {
        const cells = this.count[p.id];
        if (cells < l.cells * 1.35 && cells > l.cells * 0.7) continue;
      }
      this.place(state, p.id, nowMs);
      urgent--;
    }
    budget -= Math.max(0, Math.max(budget, 12) - urgent);
    for (let k = 0; k < n && budget > 0; k++) {
      const id = this.cursor;
      this.cursor = this.cursor + 1 >= n ? 1 : this.cursor + 1;
      const p = state.players[id];
      if (!p || !p.alive) {
        this.labels.delete(id);
        continue;
      }
      const l = this.labels.get(id);
      if (l && nowMs - l.done < REFRESH_MS) continue;
      this.place(state, id, nowMs);
      budget--;
    }
  }

  /** Bounding box of a player's land in tiles (inclusive, from the coarse grid, padded by one cell), or null. */
  bbox(id: number): [number, number, number, number] | null {
    if (id <= 0 || id >= this.count.length || this.count[id] === 0) return null;
    const F = this.F;
    return [
      Math.max(0, (this.minX[id] - 1) * F),
      Math.max(0, (this.minY[id] - 1) * F),
      Math.min(this.w - 1, (this.maxX[id] + 2) * F - 1),
      Math.min(this.h - 1, (this.maxY[id] + 2) * F - 1),
    ];
  }

  private rebuildGrid(feed: TileFeed): void {
    const { F, gw, gh, w, h } = this;
    const m = feed.mirror;
    const half = F >> 1;
    for (let gy = 0; gy < gh; gy++) {
      const ty = Math.min(h - 1, gy * F + half);
      for (let gx = 0; gx < gw; gx++) {
        const tx = Math.min(w - 1, gx * F + half);
        this.grid[gy * gw + gx] = m[ty * w + tx] & OWNER_MASK;
      }
    }
  }

  private boxes(n: number): void {
    const { minX, minY, maxX, maxY, count, gw, gh, grid } = this;
    for (let id = 0; id < n; id++) {
      minX[id] = gw;
      minY[id] = gh;
      maxX[id] = -1;
      maxY[id] = -1;
      count[id] = 0;
    }
    for (let y = 0; y < gh; y++) {
      const row = y * gw;
      for (let x = 0; x < gw; x++) {
        const o = grid[row + x];
        if (o === 0 || o >= n) continue;
        count[o]++;
        if (x < minX[o]) minX[o] = x;
        if (x > maxX[o]) maxX[o] = x;
        if (y < minY[o]) minY[o] = y;
        if (y > maxY[o]) maxY[o] = y;
      }
    }
  }

  /** Largest inscribed rectangle (scored by the font size it allows) of player `id` on the coarse grid. */
  private place(state: GameState, id: number, nowMs: number): void {
    this.computed++;
    const p = state.players[id];
    const cnt = this.count[id];
    if (!p || cnt === 0) {
      this.labels.delete(id);
      return;
    }
    const F = this.F;
    const bx0 = this.minX[id];
    const by0 = this.minY[id];
    const bw = this.maxX[id] - bx0 + 1;
    const bh = this.maxY[id] - by0 + 1;
    const f = Math.max(1, Math.ceil(Math.sqrt((bw * bh) / MAX_RECT_CELLS)));
    const gw2 = Math.ceil(bw / f);
    const gh2 = Math.ceil(bh / f);
    if (this.heights.length < gw2 + 1) {
      this.heights = new Int32Array(gw2 + 1);
      this.stack = new Int32Array(gw2 + 1);
    }
    const heights = this.heights;
    const stack = this.stack;
    heights.fill(0, 0, gw2 + 1);
    const chars = isTribe(p) ? Math.min(10, p.name.length) : p.name.length;
    const grid = this.grid;
    const gw = this.gw;
    const half = (f - 1) >> 1;
    let best = 0;
    let bestArea = 0;
    let bcx = 0;
    let bcy = 0;
    const unit = f * F; // tiles per sampled cell
    for (let r = 0; r < gh2; r++) {
      const gy = Math.min(this.maxY[id], by0 + r * f + half);
      const rowBase = gy * gw;
      for (let c = 0; c < gw2; c++) {
        const gx = Math.min(this.maxX[id], bx0 + c * f + half);
        heights[c] = grid[rowBase + gx] === id ? heights[c] + 1 : 0;
      }
      heights[gw2] = 0;
      let sp = 0;
      for (let c = 0; c <= gw2; c++) {
        const hc = heights[c];
        while (sp > 0 && heights[stack[sp - 1]] >= hc) {
          const top = stack[--sp];
          const H = heights[top];
          if (H === 0) continue;
          const left = sp > 0 ? stack[sp - 1] + 1 : 0;
          const width = c - left;
          const s = fitSize(width * unit, H * unit, chars);
          const area = width * H;
          if (s > best + 1e-9 || (s > best - 1e-9 && area > bestArea)) {
            best = s;
            bestArea = area;
            bcx = (bx0 + (left + width / 2) * f) * F;
            bcy = (by0 + (r + 1 - H / 2) * f) * F;
          }
        }
        stack[sp++] = c;
      }
    }
    if (best <= 0) {
      best = Math.sqrt(cnt * F * F) * 0.15;
      bcx = (bx0 + bw / 2) * F;
      bcy = (by0 + bh / 2) * F;
    }
    bcx = clamp(bcx, 0, this.w);
    bcy = clamp(bcy, 0, this.h);
    const old = this.labels.get(id);
    let fx = bcx;
    let fy = bcy;
    let fs = best;
    if (old) {
      const g = this.glide(old, nowMs);
      const ox = old.fx + (old.tx - old.fx) * g;
      const oy = old.fy + (old.ty - old.fy) * g;
      const os = old.fs + (old.ts - old.fs) * g;
      if (Math.abs(ox - bcx) + Math.abs(oy - bcy) < Math.max(30, best * 6)) {
        fx = ox;
        fy = oy;
        fs = os;
      }
    }
    this.labels.set(id, { id, fx, fy, fs, tx: bcx, ty: bcy, ts: best, t0: nowMs, tiles: cnt * F * F, cells: cnt, done: nowMs });
  }

  private glide(l: Label, nowMs: number): number {
    const t = clamp((nowMs - l.t0) / GLIDE_MS, 0, 1);
    return t * (2 - t);
  }

  draw(ctx: CanvasRenderingContext2D, state: GameState, cam: Camera, humanId: number, style: NameStyle, nowMs: number, dpr: number): void {
    this.drawn = 0;
    // during the spawn phase the capitals carry the names
    if (state.phase === 'spawn') return;
    const me = humanId;
    const z = cam.zoom;
    let topId = 0;
    let topTiles = 0;
    for (const p of state.players) {
      if (p && p.id !== 0 && p.alive && !isTribe(p) && p.tiles > topTiles) {
        topTiles = p.tiles;
        topId = p.id;
      }
    }
    const requests = new Set<number>();
    if (me > 0) {
      for (const r of state.allianceRequests) {
        if (r.to === me) requests.add(r.from);
        else if (r.from === me) requests.add(r.to);
      }
    }
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    const drawn: number[] = [];
    const order = [...this.labels.values()].sort((a, b) => b.tiles - a.tiles);
    for (const l of order) {
      const p: Player | undefined = state.players[l.id];
      if (!p || !p.alive) continue;
      const tribe = isTribe(p);
      const g = this.glide(l, nowMs);
      const size = (l.fs + (l.ts - l.fs) * g) * z * (tribe ? 0.8 : 1);
      const minPx = tribe ? (l.id === style.hoverOwner ? 9 : 11.5) : p.id === me ? 7 : 8;
      if (size < minPx) continue;
      // Tribe names only once zoomed in (or the one under the cursor): far out they were just clutter.
      if (tribe && z < TRIBE_LABEL_ZOOM && l.id !== style.hoverOwner) continue;
      const px = Math.min(size, tribe ? 14 : 28);
      const s = cam.tileToScreen(l.fx + (l.tx - l.fx) * g, l.fy + (l.ty - l.fy) * g);
      if (s.x < -200 || s.y < -60 || s.x > cam.viewW + 200 || s.y > cam.viewH + 60) continue;
      const icons: StatusIconId[] = [];
      const traitor = isTraitor(state, p.id);
      if (p.id === topId) icons.push('crown');
      if (traitor) icons.push('brokenShield');
      if (me > 0 && p.id !== me) {
        if (areAllied(state, me, p.id)) icons.push('handshake');
        else if (requests.has(p.id)) icons.push('envelope');
      }
      const iconPx = clamp(px * 0.85, 12, 20);
      // Clean map type: nations in tracked uppercase Barlow Condensed 600, tribes in mixed-case 500. Big countries
      // keep a capped size and spread their letters over the spare width instead of growing into giant letters.
      ctx.font = tribe ? `500 ${Math.round(px * 1.04)}px ${MAP_LABEL_FAMILY}` : `600 ${Math.round(px)}px ${MAP_LABEL_FAMILY}`;
      const nameFont = ctx.font;
      // a tribe far out: just its army number (the name on hover), so dozens of "Tribe of the ..." don't pile up
      const raw = tribe && z < TRIBE_NAME_ZOOM && l.id !== style.hoverOwner ? '' : p.name;
      const name = tribe ? raw : raw.toUpperCase();
      let track = tribe ? px * 0.01 : px * 0.07;
      setTracking(ctx, track);
      let tw = name ? ctx.measureText(name).width : 0;
      if (!tribe && name.length > 1 && size > px) {
        // spare width the region offers at its fitted size (fitSize keeps this inside the territory)
        const budget = size * (name.length * LABEL_CHAR_W + 0.6) * 0.8;
        const extra = clamp((budget - tw) / (name.length - 1), 0, px * 0.45);
        if (extra > 0.5) {
          track += extra;
          setTracking(ctx, track);
          tw = ctx.measureText(name).width;
        }
      }
      const iconsW = icons.length ? icons.length * (iconPx + 2) + 2 : 0;
      const totalW = tw + iconsW;
      const small = clamp(px * 0.6, 8, 14);
      // Army sizes are public (sim armyTotalOf); only the troop mix needs intel, and only your own mix is drawn.
      const showArmy = !tribe || px >= 13.5 || !name;
      const mixBar = p.id === me && showArmy;
      const bottom = showArmy ? small * 1.2 + px * 0.2 + (mixBar ? 7 : 0) : px * 0.5;
      const x0 = s.x - totalW / 2 - 2;
      const y0 = s.y - px * 0.9;
      const x1 = s.x + totalW / 2 + 2;
      const y1 = s.y + bottom;
      let overlap = false;
      for (let k = 0; k < drawn.length; k += 4) {
        if (x0 < drawn[k + 2] && x1 > drawn[k] && y0 < drawn[k + 3] && y1 > drawn[k + 1]) {
          overlap = true;
          break;
        }
      }
      if (overlap) continue;
      drawn.push(x0, y0, x1, y1);
      this.drawn++;
      const hs = style.hover;
      const under = !!hs && hs.x > x0 - 6 && hs.x < x1 + 6 && hs.y > y0 - 6 && hs.y < y1 + 6;
      const overIcons = z >= ICON_ZOOM && coversBuilding(state, cam, x0, y0, x1, y1);
      ctx.globalAlpha = style.targeting ? (under ? 0.15 : 0.45) : under && px > 14 ? 0.35 : overIcons ? 0.5 : tribe ? 0.85 : 1;
      const nameY = showArmy ? s.y - small * 0.45 : s.y;
      const left = s.x - totalW / 2;
      for (let k = 0; k < icons.length; k++) {
        drawIcon(ctx, icons[k], left + k * (iconPx + 2), nameY - iconPx / 2, iconPx, { dpr });
      }
      // canvas letter-spacing also trails the last letter: shift back by half of it to stay centred
      const nameX = left + iconsW + tw / 2 + (name ? track / 2 : 0);
      if (name) {
        ctx.font = nameFont;
        setTracking(ctx, track);
        const fill = traitor ? '#ff9d92' : tribe ? 'rgba(232,234,238,0.86)' : p.id === me ? 'rgba(255,240,196,0.96)' : 'rgba(255,255,255,0.93)';
        haloText(ctx, name, nameX, nameY, fill, px, tribe ? 0.85 : 1);
      }
      if (showArmy) {
        const army = formatCount(armyTotal(p.troops));
        ctx.font = `500 ${Math.round(small)}px ${MAP_NUM_FAMILY}`;
        setTracking(ctx, small * 0.02);
        const ay = nameY + px * 0.55 + small * 0.55;
        const fill = tribe ? 'rgba(222,224,228,0.78)' : traitor ? 'rgba(255,196,189,0.85)' : 'rgba(238,241,246,0.8)';
        haloText(ctx, army, s.x, ay, fill, small, 0.9);
        if (mixBar) this.mixBar(ctx, p, s.x, ay + small * 0.6 + 3, Math.max(28, Math.min(tw, 90)));
      }
    }
    setTracking(ctx, 0);
    ctx.globalAlpha = 1;
  }

  /** Infantry / armor / artillery shares of your army as a thin three-part bar. */
  private mixBar(ctx: CanvasRenderingContext2D, p: Player, cx: number, y: number, width: number): void {
    const t = p.troops;
    const total = t.infantry + t.armor + t.artillery;
    if (total <= 0) return;
    const x0 = cx - width / 2;
    const parts = [t.infantry / total, t.armor / total, t.artillery / total];
    ctx.fillStyle = 'rgba(8,10,16,0.75)';
    ctx.fillRect(x0 - 1, y - 1, width + 2, 5);
    let x = x0;
    for (let k = 0; k < 3; k++) {
      const wk = parts[k] * width;
      if (wk <= 0) continue;
      ctx.fillStyle = MIX_COLORS[k];
      ctx.fillRect(x, y, wk, 3);
      x += wk;
    }
  }
}

/** Whether a screen rectangle has a building tile under it (labels fade over building markers). */
function coversBuilding(state: GameState, cam: Camera, x0: number, y0: number, x1: number, y1: number): boolean {
  const a = cam.screenToTile(x0, y0);
  const b = cam.screenToTile(x1, y1);
  const w = state.map.width;
  const tx0 = Math.max(0, Math.floor(a.x));
  const ty0 = Math.max(0, Math.floor(a.y));
  const tx1 = Math.min(w - 1, Math.floor(b.x));
  const ty1 = Math.min(state.map.height - 1, Math.floor(b.y));
  // a big label far out covers many tiles: sample them (markers are wider than a tile there anyway)
  const step = Math.max(1, Math.floor(Math.sqrt(((tx1 - tx0 + 1) * (ty1 - ty0 + 1)) / 600)));
  const building = state.map.building;
  for (let y = ty0; y <= ty1; y += step) for (let x = tx0; x <= tx1; x += step) if (building[y * w + x] !== 0) return true;
  return false;
}
