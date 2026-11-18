// The rail links laid as one track network (art/detailed/supplyTracks.ts layTracks, pure): routes that share a corridor
// draw as one track with a switch, a route over open land is a straight run, a bend goes round rough ground in a wide
// curve, every link's train path runs unbroken from hub centre to hub centre, and the result is the same every time.
import { describe, expect, it } from 'vitest';
import { layTracks, type TrackLink } from '../src/client/art/detailed/supplyTracks';
import { pathLength, type P } from '../src/client/art/detailed/supplyLines';

const W = 120;
const H = 80;
const flat = (): number => 2;
/** a tile route of straight 8-way steps through the given points (tile coords) */
function route(...pts: [number, number][]): number[] {
  const out: number[] = [pts[0][1] * W + pts[0][0]];
  let [x, y] = pts[0];
  for (const [tx, ty] of pts.slice(1)) {
    while (x !== tx || y !== ty) {
      x += Math.sign(tx - x);
      y += Math.sign(ty - y);
      out.push(y * W + x);
    }
  }
  return out;
}
const tile = (x: number, y: number): number => y * W + x;
/** the distance from a point to a polyline */
const distTo = (q: P, p: readonly P[]): number => {
  let m = Infinity;
  for (let i = 0; i + 1 < p.length; i++) {
    const [ax, ay] = p[i];
    const dx = p[i + 1][0] - ax;
    const dy = p[i + 1][1] - ay;
    const L2 = dx * dx + dy * dy || 1e-9;
    const t = Math.max(0, Math.min(1, ((q[0] - ax) * dx + (q[1] - ay) * dy) / L2));
    m = Math.min(m, Math.hypot(ax + dx * t - q[0], ay + dy * t - q[1]));
  }
  return m;
};
/** how far a train path strays from the drawn tracks, sampled every half tile (tiles) */
const offTrack = (path: readonly P[], tracks: readonly { path: P[] }[]): number => {
  let worst = 0;
  for (let i = 0; i + 1 < path.length; i++) {
    const n = Math.ceil(Math.hypot(path[i + 1][0] - path[i][0], path[i + 1][1] - path[i][1]) * 2);
    for (let k = 0; k <= n; k++) {
      const q: P = [path[i][0] + ((path[i + 1][0] - path[i][0]) * k) / Math.max(1, n), path[i][1] + ((path[i + 1][1] - path[i][1]) * k) / Math.max(1, n)];
      worst = Math.max(worst, Math.min(...tracks.map((t) => distTo(q, t.path))));
    }
  }
  return worst;
};
/** how far a path strays from the straight line between its ends (tiles) */
const stray = (p: readonly P[]): number => {
  const [ax, ay] = p[0];
  const [bx, by] = p[p.length - 1];
  const L = Math.hypot(bx - ax, by - ay);
  return Math.max(...p.map(([x, y]) => Math.abs((x - ax) * (by - ay) - (y - ay) * (bx - ax)) / L));
};

describe('the laid track network', () => {
  it('runs a staircase route over open land as one straight run', () => {
    // a shallow line on the grid: steps east with a diagonal now and then
    const tiles = route([5, 10], [30, 12], [60, 15]);
    const net = layTracks([{ a: tiles[0], b: tiles[tiles.length - 1], tiles }], W, flat);
    expect(net.tracks).toHaveLength(1);
    expect(stray(net.tracks[0].path)).toBeLessThan(0.6);
    const p = net.paths[0]!;
    expect(p[0]).toEqual([5.5, 10.5]);
    expect(p[p.length - 1]).toEqual([60.5, 15.5]);
  });

  it('lays routes that share a corridor as one track with a switch, not side by side', () => {
    // A to B runs east; A to C runs the same way one tile beside it, then turns off north
    const ab = route([10, 40], [90, 40]);
    const ac = route([10, 40], [11, 41], [60, 41], [80, 15]);
    const links: TrackLink[] = [
      { a: tile(10, 40), b: tile(90, 40), tiles: ab },
      { a: tile(10, 40), b: tile(80, 15), tiles: ac },
    ];
    const net = layTracks(links, W, flat);
    const drawn = net.tracks.reduce((s, t) => s + pathLength(t.path), 0);
    const apart = pathLength(net.paths[0]!) + pathLength(net.paths[1]!);
    // the shared 50 tiles are laid once
    expect(drawn).toBeLessThan(apart - 35);
    // the through line and a branch off it
    expect(net.tracks.length).toBe(2);
    for (const p of net.paths) {
      expect(p).not.toBeNull();
      expect(offTrack(p!, net.tracks)).toBeLessThan(0.15);
    }
    expect(net.paths[1]![0]).toEqual([10.5, 40.5]);
    expect(net.paths[1]![net.paths[1]!.length - 1]).toEqual([80.5, 15.5]);
  });

  it('bends round a mountain in a wide curve, never across it', () => {
    // a mountain block in the middle; the route goes round its south side
    const mtn = (x: number, y: number): number => (x >= 40 && x <= 60 && y >= 20 && y <= 38 ? 5 : 2);
    const tiles = route([10, 30], [38, 40], [62, 40], [90, 30]);
    const net = layTracks([{ a: tiles[0], b: tiles[tiles.length - 1], tiles }], W, mtn);
    const path = net.tracks[0].path;
    const L = pathLength(path);
    for (let s = 0; s <= L; s += 0.25) {
      let rest = s;
      let q: P = path[0];
      for (let i = 0; i + 1 < path.length; i++) {
        const d = Math.hypot(path[i + 1][0] - path[i][0], path[i + 1][1] - path[i][1]);
        if (rest <= d) {
          const t = d ? rest / d : 0;
          q = [path[i][0] + (path[i + 1][0] - path[i][0]) * t, path[i][1] + (path[i + 1][1] - path[i][1]) * t];
          break;
        }
        rest -= d;
      }
      expect(mtn(Math.floor(q[0]), Math.floor(q[1]))).toBe(2);
    }
    // no sharp kink: neighbouring headings 0.3 tile apart differ by little
    let worst = 0;
    for (let i = 1; i + 1 < path.length; i++) {
      const a = Math.atan2(path[i][1] - path[i - 1][1], path[i][0] - path[i - 1][0]);
      const b = Math.atan2(path[i + 1][1] - path[i][1], path[i + 1][0] - path[i][0]);
      let d = Math.abs(b - a);
      if (d > Math.PI) d = 2 * Math.PI - d;
      worst = Math.max(worst, d);
    }
    expect(worst).toBeLessThan(0.25);
  });

  it('is the same every time', () => {
    const ab = route([10, 40], [90, 40]);
    const ac = route([10, 40], [11, 41], [60, 41], [80, 15]);
    const links: TrackLink[] = [
      { a: tile(10, 40), b: tile(90, 40), tiles: ab },
      { a: tile(10, 40), b: tile(80, 15), tiles: ac },
    ];
    expect(JSON.stringify(layTracks(links, W, flat))).toBe(JSON.stringify(layTracks(links, W, flat)));
    void H;
  });
});
