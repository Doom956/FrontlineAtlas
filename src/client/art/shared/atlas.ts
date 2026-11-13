// Sprite atlas shared by the art styles (client only): baked pictures (an RGBA buffer, or a painter that draws into a
// box with the canvas API) land once in a few large canvas pages, shelf-packed, and are drawn from there with one
// drawImage each. Each style keeps its own atlas (new SpriteAtlas()), so styles never evict each other's art.
//
// Baking is lazy and has a per-frame budget shared by every atlas: the map sets it before drawing the units and sets it
// back after (render/units.ts), so a screen full of new sprites bakes over a few frames instead of in one long one (a
// sprite not baked yet shows its far marker for a frame). Portraits and the art lab are not limited.
//
// When every page is full the atlas starts over (the visible sprites bake again over the next frames).
import { makeCanvas } from '../../render/common';

export interface AtlasEntry {
  page: HTMLCanvasElement;
  /** the picture's box on the page */
  sx: number;
  sy: number;
  w: number;
  h: number;
  /** where the picture's origin (its centre on the map) lies inside the box */
  ox: number;
  oy: number;
}

/** A baked picture as plain pixels (pure, testable without a canvas). */
export interface RGBABitmap {
  w: number;
  h: number;
  ox: number;
  oy: number;
  /** RGBA, w * h * 4 */
  data: Uint8ClampedArray;
}

/** Bakes left this frame (shared by every atlas). */
let budget = Infinity;
/** Sprites baked and atlas restarts since the page loaded (stats). */
export const atlasStats = { baked: 0, resets: 0 };

/** The map limits how many sprites it bakes per frame (Infinity = no limit; the map sets it back after drawing). */
export function setBakeBudget(n: number): void {
  budget = n;
}

/** True where pictures can be baked (a DOM with canvas and ImageData). */
export function canBake(): boolean {
  return typeof document !== 'undefined' && typeof ImageData !== 'undefined';
}

interface Page {
  c: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
}

export class SpriteAtlas {
  private pages: Page[] = [];
  private shelfX = 0;
  private shelfY = 0;
  private shelfH = 0;
  private entries = new Map<number | string, AtlasEntry | null>();

  constructor(
    readonly pageSize = 1024,
    readonly maxPages = 6,
  ) {}

  /** The cached entry: undefined when not baked yet, null when it could not be baked (too big for a page). */
  peek(key: number | string): AtlasEntry | null | undefined {
    return this.entries.get(key);
  }

  /**
   * The entry for `key`, baking it with `make` (pixels) when missing; a bake spends one unit of this frame's budget.
   * Null when there is no canvas, the budget is spent, `make` gives nothing, or it does not fit a page.
   */
  get(key: number | string, make: () => RGBABitmap | null): AtlasEntry | null {
    const hit = this.entries.get(key);
    if (hit !== undefined) return hit;
    if (!canBake() || budget <= 0) return null;
    budget--;
    const b = make();
    if (!b) return null;
    const spot = this.alloc(b.w, b.h);
    if (!spot) {
      this.entries.set(key, null);
      return null;
    }
    spot.page.ctx.putImageData(new ImageData(b.data, b.w, b.h), spot.x, spot.y);
    return this.store(key, spot, b.w, b.h, b.ox, b.oy);
  }

  /**
   * The entry for `key`, painting it when missing: `paint` draws with the canvas API into a `w` x `h` box whose top
   * left is (0, 0) (clipped to the box); (ox, oy) is the picture's origin inside the box. Spends one unit of budget.
   */
  getPainted(key: number | string, w: number, h: number, ox: number, oy: number, paint: (ctx: CanvasRenderingContext2D) => void): AtlasEntry | null {
    const hit = this.entries.get(key);
    if (hit !== undefined) return hit;
    if (typeof document === 'undefined' || budget <= 0) return null;
    budget--;
    const W = Math.max(1, Math.ceil(w));
    const H = Math.max(1, Math.ceil(h));
    const spot = this.alloc(W, H);
    if (!spot) {
      this.entries.set(key, null);
      return null;
    }
    const ctx = spot.page.ctx;
    ctx.save();
    ctx.clearRect(spot.x, spot.y, W, H);
    ctx.beginPath();
    ctx.rect(spot.x, spot.y, W, H);
    ctx.clip();
    ctx.translate(spot.x, spot.y);
    try {
      paint(ctx);
    } finally {
      ctx.restore();
    }
    return this.store(key, spot, W, H, ox, oy);
  }

  /** Forgets every picture (the pages are kept and reused). */
  clear(): void {
    for (const p of this.pages) p.ctx.clearRect(0, 0, this.pageSize, this.pageSize);
    this.shelfX = 0;
    this.shelfY = 0;
    this.shelfH = 0;
    this.entries.clear();
  }

  /** Pages in use (stats, tests). */
  get pageCount(): number {
    return this.pages.length;
  }

  private store(key: number | string, spot: { page: Page; x: number; y: number }, w: number, h: number, ox: number, oy: number): AtlasEntry {
    atlasStats.baked++;
    const e: AtlasEntry = { page: spot.page.c, sx: spot.x, sy: spot.y, w, h, ox, oy };
    this.entries.set(key, e);
    return e;
  }

  private alloc(w: number, h: number): { page: Page; x: number; y: number } | null {
    const P = this.pageSize;
    if (w + 1 > P || h + 1 > P) return null;
    if (this.shelfX + w + 1 > P) {
      this.shelfX = 0;
      this.shelfY += this.shelfH + 1;
      this.shelfH = 0;
    }
    let pi = this.pages.length - 1;
    if (pi < 0 || this.shelfY + h + 1 > P) {
      if (this.pages.length >= this.maxPages) {
        // every page is full: start over (the visible sprites bake again over the next frames)
        this.clear();
        atlasStats.resets++;
        pi = 0;
      } else {
        const c = makeCanvas(P, P);
        const ctx = c.getContext('2d');
        if (!ctx) return null;
        this.pages.push({ c, ctx });
        pi = this.pages.length - 1;
        this.shelfX = 0;
        this.shelfY = 0;
        this.shelfH = 0;
      }
    }
    const x = this.shelfX;
    const y = this.shelfY;
    this.shelfX += w + 1;
    this.shelfH = Math.max(this.shelfH, h);
    return { page: this.pages[pi], x, y };
  }
}

/**
 * Draws an atlas entry with its origin at (x, y) (rounded to whole px), `k` screen px per picture px, smoothing off
 * (pixel art) unless `smooth`.
 */
export function drawEntry(ctx: CanvasRenderingContext2D, e: AtlasEntry, x: number, y: number, k: number, smooth = false): void {
  const prev = ctx.imageSmoothingEnabled;
  ctx.imageSmoothingEnabled = smooth;
  ctx.drawImage(e.page, e.sx, e.sy, e.w, e.h, Math.round(x) - e.ox * k, Math.round(y) - e.oy * k, e.w * k, e.h * k);
  ctx.imageSmoothingEnabled = prev;
}
