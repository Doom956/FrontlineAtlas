// Pan / zoom and screen <-> tile conversion. zoom = screen pixels per tile.
export class Camera {
  x = 0; // tile coordinate at the screen centre
  y = 0;
  zoom = 3;
  viewW = 800; // canvas css pixels
  viewH = 600;
  constructor(public mapW: number, public mapH: number) {
    // TODO(WP-F)
  }
  resize(w: number, h: number): void {
    // TODO(WP-F)
  }
  /** Returns float tile coords. */
  screenToTile(sx: number, sy: number): { x: number; y: number } {
    // TODO(WP-F)
    return { x: 0, y: 0 };
  }
  tileToScreen(tx: number, ty: number): { x: number; y: number } {
    // TODO(WP-F)
    return { x: 0, y: 0 };
  }
  pan(dxScreen: number, dyScreen: number): void {
    // TODO(WP-F)
  }
  /** Zooms keeping the tile under (sx, sy) fixed. factor > 1 zooms in. Clamped to [minZoom, 40]. */
  zoomAt(sx: number, sy: number, factor: number): void {
    // TODO(WP-F)
  }
  centerOn(tx: number, ty: number): void {
    // TODO(WP-F)
  }
  /** Zoom that fits the whole map. */
  fit(): void {
    // TODO(WP-F)
  }
}
