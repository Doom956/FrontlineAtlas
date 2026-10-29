import { describe, expect, it } from 'vitest';
import { Camera, MAX_ZOOM } from '../src/client/camera';

function makeCam(): Camera {
  const c = new Camera(300, 200);
  c.resize(1000, 600);
  c.fit();
  return c;
}

describe('Camera', () => {
  it('fit shows the whole map centred', () => {
    const c = makeCam();
    expect(c.zoom).toBeCloseTo(3); // min(1000/300, 600/200)
    expect(c.x).toBe(150);
    expect(c.y).toBe(100);
    const tl = c.screenToTile(c.viewW / 2 - 150 * c.zoom, c.viewH / 2 - 100 * c.zoom);
    expect(tl.x).toBeCloseTo(0);
    expect(tl.y).toBeCloseTo(0);
  });

  it('screenToTile and tileToScreen round trip', () => {
    const c = makeCam();
    c.zoomAt(500, 300, 4.3);
    c.pan(37, -12);
    for (const [sx, sy] of [[0, 0], [123.5, 456.25], [999, 1], [500, 300]]) {
      const t = c.screenToTile(sx, sy);
      const s = c.tileToScreen(t.x, t.y);
      expect(s.x).toBeCloseTo(sx, 6);
      expect(s.y).toBeCloseTo(sy, 6);
    }
    const s = c.tileToScreen(42.5, 17.25);
    const t = c.screenToTile(s.x, s.y);
    expect(t.x).toBeCloseTo(42.5, 6);
    expect(t.y).toBeCloseTo(17.25, 6);
  });

  it('zoomAt keeps the point under the cursor fixed', () => {
    const c = makeCam();
    const sx = 620;
    const sy = 250;
    const before = c.screenToTile(sx, sy);
    c.zoomAt(sx, sy, 2.5);
    const after = c.screenToTile(sx, sy);
    expect(c.zoom).toBeCloseTo(7.5);
    expect(after.x).toBeCloseTo(before.x, 6);
    expect(after.y).toBeCloseTo(before.y, 6);
    c.zoomAt(sx, sy, 0.7);
    const again = c.screenToTile(sx, sy);
    expect(again.x).toBeCloseTo(before.x, 6);
    expect(again.y).toBeCloseTo(before.y, 6);
  });

  it('clamps zoom to [0.8 x fit, 40]', () => {
    const c = makeCam();
    c.zoomAt(500, 300, 1000);
    expect(c.zoom).toBe(MAX_ZOOM);
    c.zoomAt(500, 300, 0.0001);
    expect(c.zoom).toBeCloseTo(3 * 0.8);
    expect(c.minZoom).toBeCloseTo(2.4);
  });

  it('keeps the map on screen when panning', () => {
    const c = makeCam();
    c.pan(1e6, 1e6);
    expect(c.x).toBe(0);
    expect(c.y).toBe(0);
    c.pan(-1e6, -1e6);
    expect(c.x).toBe(300);
    expect(c.y).toBe(200);
    c.centerOn(-50, 500);
    expect(c.x).toBe(0);
    expect(c.y).toBe(200);
  });

  it('resize re-clamps zoom and visibleTiles is clipped to the map', () => {
    const c = makeCam();
    c.resize(2000, 1200); // fit zoom becomes 6, min 4.8 > 3
    expect(c.zoom).toBeCloseTo(4.8);
    c.fit();
    const v = c.visibleTiles();
    expect(v).toEqual({ x0: 0, y0: 0, x1: 300, y1: 200 });
    c.zoomAt(1000, 600, 4);
    const w = c.visibleTiles();
    expect(w.x1 - w.x0).toBeLessThanOrEqual(2000 / 24 + 2);
  });
});
