// Minimap: one pixel per minimap pixel sampled from the map (terrain colour, nation colour on top), kept up to date
// from the tile change feed (only tiles that are a pixel's sample point matter), pushed to the canvas at most every
// MINIMAP_MS. Each frame draws it with the viewport rectangle and your capital.
import { isTribe, type GameState } from '../../sim/types';
import type { Camera } from '../camera';
import { clamp, ctx2d, makeCanvas, type RGB } from './common';
import { displayColor, NATION_ALPHA, paintOver, TRIBE_ALPHA, type DisplayRole } from './palette';
import type { TerrainData } from './terrain';
import { OWNER_MASK, type TileFeed } from './tiles';

const MINIMAP_CSS_W = 220;
const MINIMAP_MS = 250;

export class Minimap {
  private ctx: CanvasRenderingContext2D;
  private base: HTMLCanvasElement | null = null;
  private img: ImageData | null = null;
  private cssW = MINIMAP_CSS_W;
  private cssH = 140;
  private mw = 1;
  private mh = 1;
  private w = 1;
  private h = 1;
  private colOf = new Int32Array(0);
  private rowOf = new Int32Array(0);
  private sample = new Int32Array(0);
  private terr: TerrainData | null = null;
  private colors: readonly RGB[] = [];
  /** palette.ts display colour and fill opacity per owner (rebuilt when the colours, the player count or you change) */
  private shown: RGB[] = [];
  private shownAlpha: number[] = [];
  private shownKey = '';
  private colorsStale = true;
  private dirty = false;
  private pushedMs = -Infinity;
  private gen = -1;
  private pending: number[] = [];

  constructor(public canvas: HTMLCanvasElement) {
    this.ctx = ctx2d(canvas);
  }

  setGame(state: GameState, terr: TerrainData): void {
    const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
    const { width: w, height: h } = state.map;
    this.w = w;
    this.h = h;
    this.terr = terr;
    this.cssW = MINIMAP_CSS_W;
    this.cssH = Math.max(1, Math.round((MINIMAP_CSS_W * h) / w));
    this.canvas.style.width = `${this.cssW}px`;
    this.canvas.style.height = `${this.cssH}px`;
    this.mw = Math.max(1, Math.round(this.cssW * dpr));
    this.mh = Math.max(1, Math.round(this.cssH * dpr));
    this.canvas.width = this.mw;
    this.canvas.height = this.mh;
    this.base = makeCanvas(this.mw, this.mh);
    this.img = ctx2d(this.base).createImageData(this.mw, this.mh);
    this.colOf = new Int32Array(w).fill(-1);
    this.rowOf = new Int32Array(h).fill(-1);
    // Several minimap pixels may sample the same tile when the map is small: keep a list per tile via `sample`.
    this.sample = new Int32Array(this.mw * this.mh);
    for (let py = 0; py < this.mh; py++) {
      const ty = Math.min(h - 1, Math.floor(((py + 0.5) * h) / this.mh));
      this.rowOf[ty] = py;
      for (let px = 0; px < this.mw; px++) {
        const tx = Math.min(w - 1, Math.floor(((px + 0.5) * w) / this.mw));
        this.colOf[tx] = px;
        this.sample[py * this.mw + px] = ty * w + tx;
      }
    }
    this.gen = -1;
  }

  setColors(colors: readonly RGB[]): void {
    this.colors = colors;
    this.colorsStale = true;
  }

  /** Same palette as the map (palette.ts): your nation keeps a little more chroma, tribes are the calmest. */
  private syncShown(state: GameState, humanId: number): void {
    const key = `${state.players.length}:${humanId}`;
    if (!this.colorsStale && key === this.shownKey) return;
    this.colorsStale = false;
    this.shownKey = key;
    for (let id = 0; id < this.colors.length; id++) {
      const p = state.players[id];
      const role: DisplayRole = id === humanId ? 'own' : p && isTribe(p) ? 'tribe' : 'nation';
      this.shown[id] = displayColor(this.colors[id], { role });
      this.shownAlpha[id] = role === 'tribe' ? TRIBE_ALPHA : NATION_ALPHA;
    }
    this.gen = -1; // repaint every pixel with the new colours
  }

  /** Tile feed listener. */
  readonly onChange = (tile: number): void => {
    const px = this.colOf[tile % this.w];
    const py = this.rowOf[(tile / this.w) | 0];
    if (px === undefined || py === undefined || px < 0 || py < 0) return;
    if (this.sample[py * this.mw + px] !== tile) return;
    this.dirty = true;
    this.pending.push(py * this.mw + px);
  };

  draw(state: GameState, cam: Camera, feed: TileFeed, humanId: number, nowMs: number): void {
    if (!this.base || !this.img) return;
    this.syncShown(state, humanId);
    if (feed.fullGen !== this.gen) {
      this.gen = feed.fullGen;
      this.pending.length = 0;
      for (let p = 0; p < this.mw * this.mh; p++) this.pixel(p, feed);
      this.dirty = true;
      this.pushedMs = -Infinity;
    } else if (this.pending.length) {
      for (const p of this.pending) this.pixel(p, feed);
      this.pending.length = 0;
    }
    if (this.dirty && nowMs - this.pushedMs >= MINIMAP_MS) {
      ctx2d(this.base).putImageData(this.img, 0, 0);
      this.dirty = false;
      this.pushedMs = nowMs;
    }
    const m = this.ctx;
    m.setTransform(1, 0, 0, 1, 0, 0);
    m.clearRect(0, 0, this.mw, this.mh);
    m.drawImage(this.base, 0, 0);
    const sx = this.mw / this.w;
    const sy = this.mh / this.h;
    const a = cam.screenToTile(0, 0);
    const b = cam.screenToTile(cam.viewW, cam.viewH);
    const x0 = clamp(a.x, 0, this.w) * sx;
    const y0 = clamp(a.y, 0, this.h) * sy;
    const x1 = clamp(b.x, 0, this.w) * sx;
    const y1 = clamp(b.y, 0, this.h) * sy;
    const d = this.mw / this.cssW;
    m.lineWidth = 1.5 * d;
    m.strokeStyle = 'rgba(255,255,255,0.95)';
    m.strokeRect(x0 + 0.5, y0 + 0.5, Math.max(2, x1 - x0 - 1), Math.max(2, y1 - y0 - 1));
    const me = state.players[humanId];
    if (me && me.capital >= 0) {
      m.beginPath();
      m.arc(((me.capital % this.w) + 0.5) * sx, (((me.capital / this.w) | 0) + 0.5) * sy, 2.5 * d, 0, Math.PI * 2);
      m.fillStyle = '#fff';
      m.fill();
      m.lineWidth = 1 * d;
      m.strokeStyle = '#000';
      m.stroke();
    }
  }

  /** Minimap click (CSS px) -> tile coords, or null if outside. */
  toTile(mx: number, my: number): { x: number; y: number } | null {
    if (mx < 0 || my < 0 || mx >= this.cssW || my >= this.cssH) return null;
    return { x: (mx / this.cssW) * this.w, y: (my / this.cssH) * this.h };
  }

  private pixel(p: number, feed: TileFeed): void {
    const terr = this.terr!;
    const t = this.sample[p];
    const d = this.img!.data;
    const k = p * 4;
    const tk = t * 4;
    let r = terr.rgba[tk];
    let g = terr.rgba[tk + 1];
    let b = terr.rgba[tk + 2];
    const o = feed.mirror[t] & OWNER_MASK;
    if (o !== 0) {
      const c = this.shown[o];
      if (c) {
        const m = paintOver([r, g, b], c, this.shownAlpha[o]);
        r = m[0];
        g = m[1];
        b = m[2];
      }
    }
    d[k] = r;
    d[k + 1] = g;
    d[k + 2] = b;
    d[k + 3] = 255;
  }
}
