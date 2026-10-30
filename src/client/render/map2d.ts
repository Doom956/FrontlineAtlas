// Canvas2D fallback for the map layer (no WebGL2): 1 px per tile canvases drawn scaled through the camera with
// smoothing off. Flat terrain colours, nation fill with darker borders (your border white), fallout tint, and the
// supply / spawn / resource overlays. No terrain patterns or capture flashes.
import type { MapData } from '../../sim/types';
import { ctx2d, makeCanvas, type View } from './common';
import { RESOURCE_RGB, type TerrainData } from './terrain';
import { dirtyRects, FALLOUT_BIT, OWNER_MASK, type TileFeed } from './tiles';

const FILL_ALPHA = 225;

export class Map2D {
  private w = 0;
  private h = 0;
  private terrainCv: HTMLCanvasElement | null = null;
  private resCv: HTMLCanvasElement | null = null;
  private terrCv: HTMLCanvasElement | null = null;
  private terrCtx: CanvasRenderingContext2D | null = null;
  private img: ImageData | null = null;
  private auxCv: HTMLCanvasElement | null = null;
  /** RGBA per owner: fill and border */
  fill = new Uint8Array(4096 * 4);
  border = new Uint8Array(4096 * 4);

  setGame(map: MapData, terr: TerrainData): void {
    const w = map.width;
    const h = map.height;
    this.w = w;
    this.h = h;
    this.terrainCv = makeCanvas(w, h);
    ctx2d(this.terrainCv).putImageData(new ImageData(terr.rgba.slice(), w, h), 0, 0);
    this.resCv = makeCanvas(w, h);
    const rc = ctx2d(this.resCv);
    const ri = rc.createImageData(w, h);
    for (let i = 0; i < w * h; i++) {
      const r = map.resource[i];
      const o = i * 4;
      if (r === 0) {
        ri.data[o + 3] = 120;
        continue;
      }
      const c = RESOURCE_RGB[r];
      ri.data[o] = c[0];
      ri.data[o + 1] = c[1];
      ri.data[o + 2] = c[2];
      ri.data[o + 3] = 235;
    }
    rc.putImageData(ri, 0, 0);
    this.terrCv = makeCanvas(w, h);
    this.terrCtx = ctx2d(this.terrCv);
    this.img = this.terrCtx.createImageData(w, h);
    this.auxCv = makeCanvas(w, h);
  }

  setColor(id: number, c: readonly number[], borderRgb: readonly number[]): void {
    if (id < 0 || id >= 4096) return;
    this.fill.set([c[0], c[1], c[2], FILL_ALPHA], id * 4);
    this.border.set([borderRgb[0], borderRgb[1], borderRgb[2], 255], id * 4);
  }

  /** Recomputes the dirty blocks (and their 1-tile rim, whose borders may change) of the territory image. */
  update(feed: TileFeed): void {
    const img = this.img;
    const ctx = this.terrCtx;
    if (!img || !ctx || feed.dirtyList.length === 0) return;
    for (const [x, y, rw, rh] of dirtyRects(feed, 0)) {
      const x0 = Math.max(0, x - 1);
      const y0 = Math.max(0, y - 1);
      const x1 = Math.min(this.w, x + rw + 1);
      const y1 = Math.min(this.h, y + rh + 1);
      for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) this.pixel(feed.mirror, yy * this.w + xx);
      ctx.putImageData(img, 0, 0, x0, y0, x1 - x0, y1 - y0);
    }
  }

  /** Aux overlay (supply classes or spawn mask) as a translucent canvas. mode 1 supply, 2 spawn. */
  setAux(aux: Uint8Array, mode: 1 | 2): void {
    if (!this.auxCv) return;
    const c = ctx2d(this.auxCv);
    const im = c.createImageData(this.w, this.h);
    const d = im.data;
    for (let i = 0; i < aux.length; i++) {
      const v = aux[i];
      if (v === 0) continue;
      const o = i * 4;
      if (mode === 2) {
        if (v === 1) d.set([255, 255, 255, 46], o);
        else d.set([200, 40, 40, 70], o);
      } else {
        const r = (v - 1) / 84;
        if (r <= 1) d.set([60, 210, 90, 80], o);
        else if (r <= 3) d.set([235, 215 - 85 * ((r - 1) / 2), 50, 100], o);
        else d.set([225, 45, 40, 130], o);
      }
    }
    c.putImageData(im, 0, 0);
  }

  /** Draws the layers (the context's transform must map tile units to pixels). */
  draw(ctx: CanvasRenderingContext2D, v: View, showRes: boolean, aux: boolean): void {
    if (!this.terrainCv || !this.terrCv) return;
    const sw = v.x1 - v.x0;
    const sh = v.y1 - v.y0;
    if (sw <= 0 || sh <= 0) return;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(this.terrainCv, v.x0, v.y0, sw, sh, v.x0, v.y0, sw, sh);
    ctx.drawImage(this.terrCv, v.x0, v.y0, sw, sh, v.x0, v.y0, sw, sh);
    if (aux && this.auxCv) ctx.drawImage(this.auxCv, v.x0, v.y0, sw, sh, v.x0, v.y0, sw, sh);
    if (showRes && this.resCv) ctx.drawImage(this.resCv, v.x0, v.y0, sw, sh, v.x0, v.y0, sw, sh);
  }

  private pixel(m: Uint32Array, i: number): void {
    const px = this.img!.data;
    const w = this.w;
    const n = m.length;
    const raw = m[i];
    const o = raw & OWNER_MASK;
    const k = i * 4;
    let r = 0;
    let g = 0;
    let b = 0;
    let a = 0;
    if (o !== 0) {
      const x = i % w;
      const edge =
        (x > 0 && (m[i - 1] & OWNER_MASK) !== o) ||
        (x < w - 1 && (m[i + 1] & OWNER_MASK) !== o) ||
        (i >= w && (m[i - w] & OWNER_MASK) !== o) ||
        (i + w < n && (m[i + w] & OWNER_MASK) !== o);
      const p = edge ? this.border : this.fill;
      const o4 = o * 4;
      r = p[o4];
      g = p[o4 + 1];
      b = p[o4 + 2];
      a = p[o4 + 3];
    }
    if (raw & FALLOUT_BIT) {
      const t = a === 0 ? 1 : 0.6;
      r += (128 - r) * t;
      g += (148 - g) * t;
      b += (92 - b) * t;
      a = Math.max(a, 190);
    }
    px[k] = r;
    px[k + 1] = g;
    px[k + 2] = b;
    px[k + 3] = a;
  }
}
