// Night lights on the game map (client only, looks only): small warm pixels, never big blurs, drawn over the night's
// shade (renderer.ts) so they stay bright. The art lab's owner-approved lights (artlab/seasonsMock.ts, the maths in
// art/detailed/seasons.ts): lit window pixels on cities (more for a bigger city, most on a capital), ports, factories
// and forts, street lamps on the ground round cities, a train's headlamp, cab and wagon lamps and red tail lamp, a
// ship's running lights (white mast and stern, red to port, green to starboard), and stepped glows round blasts that
// are brighter at night. Plain land stays dark.
//
// The layers that draw the art (buildings.ts, supplyLayer.ts, units.ts) note here what they drew this frame while the
// lights are wanted (collecting), all culled to the view already; this file caps the counts and draws.
import { isWater, type GameState } from '../../sim/types';
import { bayer4, shaderHash } from '../art/detailed/buildingLinkArt';
import { LIGHT_TONES, glowStep, lightSpots, suburbLights, type LightKind, type LightTone } from '../art/detailed/seasons';
import { pointAt, type P } from '../art/detailed/supplyLines';
import { trainLength, type CarKind } from '../art/detailed/supplyArt';
import type { Camera } from '../camera';
import type { MapLook } from './seasonView';
import { artPixelsPerTile } from './glmap';

/** A building picture drawn this frame: where its baked canvas went (one canvas pixel = k CSS px), turned by rot about (ox, oy). */
export interface LitSprite {
  kind: LightKind;
  level: number;
  seed: number;
  /** the tile it stands on (street lamps round cities) */
  tile: number;
  canvas: HTMLCanvasElement;
  /** CSS px per canvas pixel */
  k: number;
  /** the canvas's top left in CSS px, before the turn */
  x: number;
  y: number;
  /** the picture's frame: turned by rot (radians; a port toward its sea) and moved to (ox, oy); x, y are in it */
  rot: number;
  ox: number;
  oy: number;
  /** the picture's first row (canvas px): lights sit below its roofline only */
  top: number;
}

/** A flat building marker or a far-zoom dot: lights round its centre (CSS px), `size` its width. */
export interface LitMarker {
  kind: LightKind;
  level: number;
  seed: number;
  tile: number;
  x: number;
  y: number;
  size: number;
}

/** A train drawn this frame: its path on screen (CSS px), its head along it, its cars and pixel scale. */
export interface TrainLamp {
  path: P[];
  head: number;
  cars: CarKind[];
  scale: number;
  alpha: number;
}

/** A ship drawn this frame: its centre (CSS px), heading, length (CSS px). */
export interface ShipLamp {
  x: number;
  y: number;
  angle: number;
  len: number;
}

/** A blast going off: tile point, radius (tiles), 0..1 through its life. */
export interface BlastGlow {
  x: number;
  y: number;
  r: number;
  t: number;
}

/** Caps per frame, so a crowded view never costs more than a few thousand small fills. */
export const LIGHT_CAPS = { sprites: 220, markers: 700, trains: 16, ships: 160, glows: 40 } as const;

/** The light kind of a building type (null: not lit at night). */
export function lightKindOf(type: string, capital: boolean): LightKind | null {
  if (type === 'city') return capital ? 'capital' : 'city';
  if (type === 'port' || type === 'factory' || type === 'fort') return type;
  return null;
}

/**
 * The cells of a building picture where a light can sit, best first: its dark window pixels (darker than the wall on
 * both sides), then any other cell well inside its outline (the art lab's rule). Read once per baked picture.
 */
const cellsOf = new WeakMap<HTMLCanvasElement, { win: [number, number][]; body: [number, number][] }>();
export function lightCells(c: HTMLCanvasElement, top: number): { win: [number, number][]; body: [number, number][] } {
  let r = cellsOf.get(c);
  if (r) return r;
  r = { win: [], body: [] };
  let img: ImageData | null = null;
  try {
    img = c.getContext('2d')?.getImageData(0, 0, c.width, c.height) ?? null;
  } catch {
    img = null;
  }
  if (img) {
    const W = img.width;
    const H = img.height;
    const d = img.data;
    const at = (X: number, Y: number): number => {
      if (X < 0 || Y < 0 || X >= W || Y >= H) return -1;
      const o = (Y * W + X) * 4;
      return d[o + 3] > 220 ? 0.299 * d[o] + 0.587 * d[o + 1] + 0.114 * d[o + 2] : -1;
    };
    for (let Y = Math.max(0, top); Y < H; Y++) {
      for (let X = 0; X < W; X++) {
        const m = at(X, Y);
        const l = at(X - 1, Y);
        const rr = at(X + 1, Y);
        const u = at(X, Y - 1);
        const dn = at(X, Y + 1);
        if (m < 0 || l < 0 || rr < 0 || u < 0 || dn < 0) continue;
        if (at(X - 2, Y) < 0 || at(X + 2, Y) < 0 || at(X, Y - 2) < 0 || at(X, Y + 2) < 0) continue;
        if (m < 120 && ((m + 16 < l && m + 16 < rr) || (m + 16 < u && m + 16 < dn))) r.win.push([X, Y]);
        else r.body.push([X, Y]);
      }
    }
  }
  cellsOf.set(c, r);
  return r;
}

/** The lit cells of a building picture for a seed, in order (windows first), at most `n`. */
const picked = new WeakMap<HTMLCanvasElement, Map<number, [number, number][]>>();
function pickCells(c: HTMLCanvasElement, top: number, seed: number, n: number): [number, number][] {
  let bySeed = picked.get(c);
  if (!bySeed) picked.set(c, (bySeed = new Map()));
  const key = seed * 128 + n;
  let out = bySeed.get(key);
  if (out) return out;
  const cells = lightCells(c, top);
  const order = (list: [number, number][]): [number, number][] => list.slice().sort((a, b) => shaderHash(a[0], a[1], seed) - shaderHash(b[0], b[1], seed));
  out = [...order(cells.win), ...order(cells.body)].slice(0, n);
  if (bySeed.size > 64) bySeed.clear();
  bySeed.set(key, out);
  return out;
}

/** lightSpots and suburbLights by (kind, level, seed): the same few buildings ask every frame. */
const spotMemo = new Map<string, ReturnType<typeof lightSpots>>();
const streetMemo = new Map<string, ReturnType<typeof suburbLights>>();
function spotsOf(kind: LightKind, level: number, seed: number): ReturnType<typeof lightSpots> {
  const key = `${kind}:${level}:${seed}`;
  let v = spotMemo.get(key);
  if (!v) {
    if (spotMemo.size > 2000) spotMemo.clear();
    spotMemo.set(key, (v = lightSpots(kind, level, seed)));
  }
  return v;
}
function streetOf(kind: LightKind, level: number, seed: number): ReturnType<typeof suburbLights> {
  const key = `${kind}:${level}:${seed}`;
  let v = streetMemo.get(key);
  if (!v) {
    if (streetMemo.size > 2000) streetMemo.clear();
    streetMemo.set(key, (v = suburbLights(kind, level, seed)));
  }
  return v;
}

const rgba = (c: readonly number[], a: number): string => `rgba(${c[0]},${c[1]},${c[2]},${a.toFixed(3)})`;

/** One lamp: a square of `size` art pixels (p device px each) with a one-pixel spill round it (device px, top left at X, Y). */
function lamp(ctx: CanvasRenderingContext2D, X: number, Y: number, p: number, tone: LightTone, a: number, size: 1 | 2 = 1, spill = 0.3): void {
  if (a <= 0.01) return;
  const c = LIGHT_TONES[tone];
  const s = p * size;
  ctx.fillStyle = rgba(c, spill * a);
  ctx.fillRect(X - p, Y, p, s);
  ctx.fillRect(X + s, Y, p, s);
  ctx.fillRect(X, Y - p, s, p);
  ctx.fillRect(X, Y + s, s, p);
  ctx.fillStyle = rgba(c, a);
  ctx.fillRect(X, Y, s, s);
}

/** A glow round a blast: stepped rings of whole cells (device px), the outer ring dithered; at most 17 cells across. */
function glow(ctx: CanvasRenderingContext2D, X: number, Y: number, Rpx: number, a: number): void {
  if (a <= 0.01 || Rpx < 2) return;
  const cell = Math.max(2, Math.ceil(Rpx / 8));
  const R = Rpx / cell;
  const r = Math.ceil(R);
  const c = LIGHT_TONES.fire;
  const X0 = Math.round(X / cell);
  const Y0 = Math.round(Y / cell);
  for (let j = -r; j <= r; j++) {
    for (let i = -r; i <= r; i++) {
      const s = glowStep(Math.hypot(i, j * 1.25), R);
      if (!s) continue;
      if (s < 0.2 && bayer4(X0 + i, Y0 + j) > 0.5) continue;
      ctx.fillStyle = rgba(c, s * a);
      ctx.fillRect((X0 + i) * cell, (Y0 + j) * cell, cell, cell);
    }
  }
}

export class NightLights {
  /** collecting this frame: the art layers note what they draw (set by the renderer) */
  on = false;
  readonly sprites: LitSprite[] = [];
  readonly markers: LitMarker[] = [];
  readonly trains: TrainLamp[] = [];
  readonly ships: ShipLamp[] = [];
  /** lamps drawn last frame (stats, tests) */
  drawn = 0;

  begin(on: boolean): void {
    this.on = on;
    this.sprites.length = 0;
    this.markers.length = 0;
    this.trains.length = 0;
    this.ships.length = 0;
  }

  addSprite(s: LitSprite): void {
    if (this.on && this.sprites.length < LIGHT_CAPS.sprites) this.sprites.push(s);
  }
  addMarker(m: LitMarker): void {
    if (this.on && this.markers.length < LIGHT_CAPS.markers) this.markers.push(m);
  }
  addTrain(t: TrainLamp): void {
    if (this.on && this.trains.length < LIGHT_CAPS.trains) this.trains.push(t);
  }
  addShip(s: ShipLamp): void {
    if (this.on && this.ships.length < LIGHT_CAPS.ships) this.ships.push(s);
  }

  /** Glows round the blasts going off (any time, brighter at night): under the blasts' own pictures. */
  drawGlows(ctx: CanvasRenderingContext2D, cam: Camera, look: MapLook, blasts: readonly BlastGlow[], dpr: number): void {
    if (look.fire <= 0) return;
    const z = cam.zoom;
    if (z < 2) return;
    const ox = cam.viewW / 2 - cam.x * z;
    const oy = cam.viewH / 2 - cam.y * z;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    let n = 0;
    for (const b of blasts) {
      if (n >= LIGHT_CAPS.glows) break;
      const X = (ox + b.x * z) * dpr;
      const Y = (oy + b.y * z) * dpr;
      if (X < -200 || Y < -200 || X > (cam.viewW + 200) * dpr || Y > (cam.viewH + 200) * dpr) continue;
      glow(ctx, X, Y, b.r * z * dpr, look.fire * (1 - b.t) * (b.t < 0.08 ? b.t / 0.08 : 1));
      n++;
    }
    ctx.restore();
  }

  /** The lamps noted this frame, at the look's strength (nothing by day). */
  draw(ctx: CanvasRenderingContext2D, state: GameState, cam: Camera, look: MapLook, dpr: number): void {
    this.drawn = 0;
    const amt = look.lights;
    if (amt <= 0.01) return;
    const dark = look.dark;
    const z = cam.zoom;
    const ox = cam.viewW / 2 - cam.x * z;
    const oy = cam.viewH / 2 - cam.y * z;
    const map = state.map;
    const P = artPixelsPerTile(z);
    const gp = (z / P) * dpr; // a ground art pixel in device px
    let n = 0;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    // street lamps on the ground round the cities (under the buildings' own lights), from the middle zooms in
    const street = (kind: LightKind, level: number, seed: number, tile: number): void => {
      if (z < 4) return;
      const tx = tile % map.width;
      const ty = (tile / map.width) | 0;
      for (const l of streetOf(kind, level, seed)) {
        if (dark < l.on) continue;
        const qx = tx + 0.5 + l.dx;
        const qy = ty + 0.5 + l.dy;
        const ix = Math.floor(qx);
        const iy = Math.floor(qy);
        if (ix < 0 || iy < 0 || ix >= map.width || iy >= map.height || isWater(map.terrain[iy * map.width + ix])) continue;
        const X = Math.round((ox + (Math.floor(qx * P) / P) * z) * dpr);
        const Y = Math.round((oy + (Math.floor(qy * P) / P) * z) * dpr);
        lamp(ctx, X, Y, Math.max(2, Math.round(gp * 1.2)), l.tone, amt, 1, 0.2);
        n++;
      }
    };
    for (const s of this.sprites) street(s.kind, s.level, s.tile * 31, s.tile);
    for (const m of this.markers) if (m.size >= 10) street(m.kind, m.level, m.tile * 31, m.tile);
    // windows and yard lamps on the buildings: their own dark window pixels lit, a few at random, more on bigger cities
    for (const s of this.sprites) {
      const spots = spotsOf(s.kind, s.level, s.seed);
      if (!spots.length) continue;
      // cities: about two thirds of the candidates lit (busy windows), the others a third
      const share = s.kind === 'city' || s.kind === 'capital' ? 0.6 : 0.34;
      const cells = pickCells(s.canvas, s.top, s.seed, Math.round(spots.length * share));
      const p = Math.max(1, Math.round(s.k * dpr));
      const cos = Math.cos(s.rot);
      const sin = Math.sin(s.rot);
      cells.forEach(([cx, cy], i) => {
        const l = spots[i % spots.length];
        if (dark < l.on) return;
        const lx = s.x + cx * s.k;
        const ly = s.y + cy * s.k;
        const X = s.ox + lx * cos - ly * sin;
        const Y = s.oy + lx * sin + ly * cos;
        lamp(ctx, Math.round(X * dpr), Math.round(Y * dpr), p, l.tone, amt, s.k * dpr < 1.5 ? 2 : 1, 0.25);
        n++;
      });
    }
    // flat markers and far dots: a few lamps round the centre (a cluster that grows with the city's level)
    for (const m of this.markers) {
      const spots = spotsOf(m.kind, m.level, m.seed);
      const want = Math.min(spots.length, Math.max(1, Math.round(m.size / 3)));
      const p = Math.max(1, Math.round(Math.min(2, m.size / 8) * dpr));
      for (let i = 0; i < want; i++) {
        const l = spots[i];
        if (dark < l.on) continue;
        const X = Math.round((m.x + (l.u - 0.5) * m.size) * dpr);
        const Y = Math.round((m.y + (l.v - 0.6) * m.size) * dpr);
        lamp(ctx, X, Y, p, l.tone, amt, 1, m.size < 6 ? 0 : 0.25);
        n++;
      }
    }
    // trains: a headlamp with a short beam ahead, lit cab windows, a lamp on each wagon, a red lamp at the tail
    for (const t of this.trains) {
      const a = amt * t.alpha;
      const k = t.scale;
      const p = Math.max(1, Math.round(k * dpr));
      const cell = (x: number, y: number): [number, number] => [Math.round((x * dpr) / p) * p, Math.round((y * dpr) / p) * p];
      const nose = pointAt(t.path, t.head);
      const fx = Math.cos(nose.angle);
      const fy = Math.sin(nose.angle);
      for (let s = 3; s >= 1; s--) {
        const [X, Y] = cell(nose.x + fx * s * k * 1.6, nose.y + fy * s * k * 1.6 - k);
        ctx.fillStyle = `rgba(255,240,200,${((0.5 - s * 0.12) * a).toFixed(3)})`;
        ctx.fillRect(X - p, Y - p, p * 3, p * 3);
      }
      const [hX, hY] = cell(nose.x, nose.y - k);
      lamp(ctx, hX, hY, p, 'white', a);
      let s = t.head;
      const gap = (trainLength(['engine', 'tender']) - trainLength(['engine']) - trainLength(['tender'])) * k;
      t.cars.forEach((kind, i) => {
        const L = trainLength([kind]) * k;
        if (kind === 'engine') {
          const m = pointAt(t.path, s - L * 0.72);
          const [X, Y] = cell(m.x, m.y - k * 2);
          lamp(ctx, X, Y, p, 'warm', a);
        } else if (kind !== 'tender') {
          const m = pointAt(t.path, s - L * 0.5);
          const [X, Y] = cell(m.x, m.y - k * 2);
          lamp(ctx, X, Y, p, 'amber', a * 0.85);
        }
        s -= L + gap;
        if (i === t.cars.length - 1) {
          const m = pointAt(t.path, s + gap + 0.5);
          const [X, Y] = cell(m.x, m.y - k);
          lamp(ctx, X, Y, p, 'red', a);
        }
      });
      n += t.cars.length + 2;
    }
    // ships: white mast and stern lights, red to port and green to starboard
    for (const sh of this.ships) {
      const p = Math.max(1, Math.round(Math.min(3, sh.len / 14) * dpr));
      const fx = Math.cos(sh.angle);
      const fy = Math.sin(sh.angle);
      const at = (along: number, side: number, tone: LightTone): void => {
        const x = sh.x + fx * along * sh.len - fy * side * sh.len;
        const y = sh.y + fy * along * sh.len + fx * side * sh.len;
        lamp(ctx, Math.round((x * dpr) / p) * p, Math.round((y * dpr) / p) * p, p, tone, amt);
      };
      at(0.44, 0, 'white');
      if (sh.len >= 10) {
        at(0.12, 0, 'pale');
        at(0.18, -0.09, 'red');
        at(0.18, 0.09, 'green');
      }
      at(-0.46, 0, 'white');
      n += 5;
    }
    ctx.restore();
    this.drawn = n;
  }
}
