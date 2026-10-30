// Pan / zoom and screen <-> tile conversion. zoom = screen pixels per tile.
// Screen coordinates are CSS pixels relative to the map canvas; (x, y) is the tile coordinate shown at the
// centre of the canvas. Tile i = y * width + x covers [x, x + 1) x [y, y + 1) in tile coordinates.

export const MAX_ZOOM = 40;
/** The most zoomed-out view is this share of the zoom that fits the whole map. */
export const MIN_ZOOM_FIT_SHARE = 0.8;

export class Camera {
  x = 0; // tile coordinate at the screen centre
  y = 0;
  zoom = 3;
  viewW = 800; // canvas css pixels
  viewH = 600;
  /** a running flyTo; any pan / zoom / centerOn by the player cancels it */
  private anim: { x0: number; y0: number; z0: number; x1: number; y1: number; z1: number; t0: number; ms: number } | null = null;
  constructor(public mapW: number, public mapH: number) {
    this.fit();
  }

  /** Zoom at which the whole map just fits the view. */
  get fitZoom(): number {
    return Math.min(this.viewW / this.mapW, this.viewH / this.mapH);
  }
  get minZoom(): number {
    return Math.min(this.fitZoom * MIN_ZOOM_FIT_SHARE, MAX_ZOOM);
  }
  get maxZoom(): number {
    return MAX_ZOOM;
  }

  resize(w: number, h: number): void {
    this.viewW = Math.max(1, w);
    this.viewH = Math.max(1, h);
    this.clamp();
  }
  /** Returns float tile coords. */
  screenToTile(sx: number, sy: number): { x: number; y: number } {
    return {
      x: this.x + (sx - this.viewW / 2) / this.zoom,
      y: this.y + (sy - this.viewH / 2) / this.zoom,
    };
  }
  tileToScreen(tx: number, ty: number): { x: number; y: number } {
    return {
      x: (tx - this.x) * this.zoom + this.viewW / 2,
      y: (ty - this.y) * this.zoom + this.viewH / 2,
    };
  }
  /**
   * Glides to (tx, ty) at `zoom` (clamped) over `ms`: zoom changes geometrically, eased in and out. Runs while step()
   * is called every frame; ms <= 0 jumps.
   */
  flyTo(tx: number, ty: number, zoom: number, ms = 800, now = performance.now()): void {
    const z1 = clampNum(zoom, this.minZoom, MAX_ZOOM);
    if (ms <= 0) {
      this.anim = null;
      this.zoom = z1;
      this.x = tx;
      this.y = ty;
      this.clamp();
      return;
    }
    this.anim = { x0: this.x, y0: this.y, z0: this.zoom, x1: tx, y1: ty, z1, t0: now, ms };
  }
  get flying(): boolean {
    return this.anim !== null;
  }
  /** Advances a flyTo; call once per frame. */
  step(now = performance.now()): void {
    const a = this.anim;
    if (!a) return;
    const t = clampNum((now - a.t0) / a.ms, 0, 1);
    const e = t < 0.5 ? 2 * t * t : 1 - 2 * (1 - t) * (1 - t);
    const z = a.z0 * Math.pow(a.z1 / a.z0, e);
    // move the centre in screen-space terms so the target doesn't race past while zooming in
    const k = a.z1 === a.z0 ? e : (1 / z - 1 / a.z0) / (1 / a.z1 - 1 / a.z0);
    this.zoom = z;
    this.x = a.x0 + (a.x1 - a.x0) * k;
    this.y = a.y0 + (a.y1 - a.y0) * k;
    this.clamp();
    if (t >= 1) this.anim = null;
  }
  pan(dxScreen: number, dyScreen: number): void {
    this.anim = null;
    this.x -= dxScreen / this.zoom;
    this.y -= dyScreen / this.zoom;
    this.clamp();
  }
  /** Zooms keeping the tile under (sx, sy) fixed. factor > 1 zooms in. Clamped to [minZoom, 40]. */
  zoomAt(sx: number, sy: number, factor: number): void {
    if (!(factor > 0)) return;
    this.anim = null;
    const before = this.screenToTile(sx, sy);
    this.zoom = clampNum(this.zoom * factor, this.minZoom, MAX_ZOOM);
    this.x = before.x - (sx - this.viewW / 2) / this.zoom;
    this.y = before.y - (sy - this.viewH / 2) / this.zoom;
    this.clamp();
  }
  centerOn(tx: number, ty: number): void {
    this.anim = null;
    this.x = tx;
    this.y = ty;
    this.clamp();
  }
  /** Zoom that fits the whole map. */
  fit(): void {
    this.anim = null;
    this.zoom = clampNum(this.fitZoom, this.minZoom, MAX_ZOOM);
    this.x = this.mapW / 2;
    this.y = this.mapH / 2;
  }

  /** Integer tile rectangle [x0, x1) x [y0, y1) visible on screen, clipped to the map (may be empty). */
  visibleTiles(margin = 0): { x0: number; y0: number; x1: number; y1: number } {
    const a = this.screenToTile(0, 0);
    const b = this.screenToTile(this.viewW, this.viewH);
    return {
      x0: Math.max(0, Math.floor(a.x) - margin),
      y0: Math.max(0, Math.floor(a.y) - margin),
      x1: Math.min(this.mapW, Math.ceil(b.x) + margin),
      y1: Math.min(this.mapH, Math.ceil(b.y) + margin),
    };
  }

  /** Keeps zoom in range and the screen centre over the map, so the map can never leave the screen entirely. */
  private clamp(): void {
    this.zoom = clampNum(this.zoom, this.minZoom, MAX_ZOOM);
    this.x = clampNum(this.x, 0, this.mapW);
    this.y = clampNum(this.y, 0, this.mapH);
  }
}

function clampNum(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
