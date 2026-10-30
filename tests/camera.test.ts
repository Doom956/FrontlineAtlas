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

describe('Camera at grand scale', () => {
  it('fits a huge map below one pixel per tile and zooms in to 40 px per tile', () => {
    const c = new Camera(2600, 1600);
    c.resize(1920, 1080);
    c.fit();
    expect(c.zoom).toBeCloseTo(1080 / 1600); // height-limited
    expect(c.zoom).toBeLessThan(1);
    expect(c.minZoom).toBeCloseTo((1080 / 1600) * 0.8);
    const v = c.visibleTiles();
    expect(v).toEqual({ x0: 0, y0: 0, x1: 2600, y1: 1600 });
    c.zoomAt(960, 540, 1e6);
    expect(c.zoom).toBe(MAX_ZOOM);
    const w = c.visibleTiles();
    expect(w.x1 - w.x0).toBeLessThanOrEqual(1920 / MAX_ZOOM + 2);
    expect(w.y1 - w.y0).toBeLessThanOrEqual(1080 / MAX_ZOOM + 2);
  });

  it('keeps the cursor tile fixed across the whole zoom range on a huge map', () => {
    const c = new Camera(2600, 1600);
    c.resize(1920, 1080);
    c.fit();
    const sx = 1500;
    const sy = 300;
    const before = c.screenToTile(sx, sy);
    for (const f of [1.7, 3.1, 2.2, 0.4, 5]) {
      c.zoomAt(sx, sy, f);
      const after = c.screenToTile(sx, sy);
      // clamping the centre to the map may move the view only when zoomed out past the map edge
      if (c.zoom > c.fitZoom) {
        expect(after.x).toBeCloseTo(before.x, 4);
        expect(after.y).toBeCloseTo(before.y, 4);
      }
    }
  });

  it('round-trips tile <-> screen at sub-pixel zoom with float precision to spare', () => {
    const c = new Camera(2600, 1600);
    c.resize(1920, 1080);
    c.fit();
    c.zoomAt(100, 100, 0.9);
    for (const [tx, ty] of [[0, 0], [2599.75, 1599.5], [1300.125, 800.25]]) {
      const s = c.tileToScreen(tx, ty);
      const t = c.screenToTile(s.x, s.y);
      expect(t.x).toBeCloseTo(tx, 6);
      expect(t.y).toBeCloseTo(ty, 6);
    }
  });

  it('maps a screen pixel to the same tile the map shader samples (device pixels, dpr 2)', () => {
    // The shader computes tile = centre + (fragment - view / 2) / (zoom * dpr) in device pixels; the overlay uses
    // screenToTile in CSS pixels. They must agree for every pixel centre.
    const c = new Camera(2600, 1600);
    c.resize(1280, 720);
    c.zoomAt(640, 360, 9.3);
    c.pan(-123.4, 56.7);
    const dpr = 2;
    for (const [px, py] of [[0.5, 0.5], [1279.5, 719.5], [640.25, 360.75], [17.5, 600.5]]) {
      const a = c.screenToTile(px, py);
      const fx = px * dpr;
      const fy = py * dpr;
      const bx = c.x + (fx - c.viewW * dpr * 0.5) / (c.zoom * dpr);
      const by = c.y + (fy - c.viewH * dpr * 0.5) / (c.zoom * dpr);
      expect(Math.floor(bx)).toBe(Math.floor(a.x));
      expect(Math.floor(by)).toBe(Math.floor(a.y));
    }
  });
});
