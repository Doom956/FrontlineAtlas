// The look of the supply lines (client only; art lab mockup now). Where the lines run is supplyLines.ts (pure). The
// lines are drawn IN the ground, the way the dirt tracks are (buildingLinkArt.ts trackArt): hard pixels on the map's own
// art-pixel grid (render/glmap.ts artPixelsPerTile), the map shader's 4 x 4 ordered dither, every colour from the ramps of
// the terrain under that pixel and the owner's tint over it, and nothing over a tree crown, a peak or a swamp pool.
// The trains, the yard's parked wagons and the convoy ships are sprites on top, like units: the detailed unit models
// (bake.ts rasterize, lit from the top left, with their soft cast shadow), outlined in the owner's colour (outline.ts).
//
// Looks by zoom (P = art px per tile):
//   rail       close (P 8 and up): a gravel bed tinted by the land, dark wooden sleepers across it, two thin steel
//              rails, the one toward the light lit, each throwing a one-pixel shadow; a straight steel girder bridge
//              over water. Normal (P 4): one thin dark line. Far (P 2 and less): nothing.
//   yard       close only: sidings fanning out of the main line where 3 or more rails meet.
//   train      close: an engine with its tender and 2 to 3 wagons in the owner's colour, a smoke puff trailing off the
//              stack. Normal zoom: none (the map shows the line only).
//   sea lane   close and normal: a dotted line of pale water from the port, the dots a lighter tone of the sea.
//   damage     a broken rail: the bed scorched black round a crater, the rails gone, two bent pieces thrown aside.
//   cut front  the front border shimmers grey (a band of hard grey pixels whose light and dark move along it).
import { MAP_LABEL_FAMILY } from '../../render/common';
import { unitModel } from './models';
import { project, rasterize, type Baked, type Model, partBox, type MatId, type Part } from './bake';
import { drawBlob } from './blobs';
import { bayer4, swampPool, trackTones, underCrown, underPeak, type TrackGround, type TrackPixels } from './buildingLinkArt';
import { facingIndex, facingsFor, gridOf, type Grid } from './grid';
import { outlineOf, ringWidth } from './outline';
import { box, ell, seg } from './shapes';
import { pathLength, pointAt, type Junction, type P } from './supplyLines';
import type { RGB } from '../shared/colour';

type C = readonly number[];

/** What a rail looks like at a ground grid of P art px per tile. */
export type RailLook = 'close' | 'line' | 'none';
export function railLook(P: number): RailLook {
  return P >= 8 ? 'close' : P >= 4 ? 'line' : 'none';
}

const STEEL_LIT: C = [146, 148, 150];
const STEEL: C = [96, 98, 102];
const STEEL_DARK: C = [46, 48, 52];
const SLEEPER: C = [62, 48, 36];
const SLEEPER_BRIDGE: C = [96, 74, 52];
const GRAVEL: C = [112, 108, 100];
const SOOT: C = [34, 30, 28];
const SOOT_LIGHT: C = [66, 58, 50];
const GIRDER_LIT: C = [132, 134, 138];
const GIRDER: C = [70, 72, 78];
const GIRDER_DARK: C = [34, 36, 40];

const mixC = (a: C, b: C, t: number): RGB => [Math.round(a[0] + (b[0] - a[0]) * t), Math.round(a[1] + (b[1] - a[1]) * t), Math.round(a[2] + (b[2] - a[2]) * t)];
const mul = (a: C, f: number): RGB => [Math.min(255, Math.round(a[0] * f)), Math.min(255, Math.round(a[1] * f)), Math.min(255, Math.round(a[2] * f))];
const lumaC = (c: C): number => 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];

/** A rail's broken stretch (a strike hit the line): arc-length range (tiles) along line `line`. */
export interface RailBreak {
  line: number;
  s0: number;
  s1: number;
}

/** The pixel sizes of a rail at a grid (art px): rail centre offset, sleeper reach, bed and verge radius, sleeper pitch. */
function railSizes(P: number): { rail: number; sleeper: number; bed: number; verge: number; pitch: number } {
  return P >= 16 ? { rail: 2.0, sleeper: 3.4, bed: 4.0, verge: 5.0, pitch: 3 } : { rail: 1.7, sleeper: 2.9, bed: 3.3, verge: 4.2, pitch: 2 };
}

/**
 * The pixels of rails along `lines` (tile coordinates) on the ground grid of `g` (see the header for the looks). Pure.
 * Several lines (a yard's sidings, a switch) merge into one gravel apron. `brk` scorches and breaks one stretch or more;
 * `clip` (tiles) bakes only that box of the lines.
 */
export function railArt(lines: readonly (readonly P[])[], g: TrackGround, seed: number, brkIn?: RailBreak | readonly RailBreak[], clip?: readonly [number, number, number, number]): TrackPixels {
  const brks: readonly RailBreak[] = brkIn === undefined ? [] : Array.isArray(brkIn) ? (brkIn as readonly RailBreak[]) : [brkIn as RailBreak];
  const P = g.P;
  const look = railLook(P);
  const sz = railSizes(P);
  const reach = look === 'close' ? sz.verge + 1 : 1.5;
  let mx0 = Infinity;
  let my0 = Infinity;
  let mx1 = -Infinity;
  let my1 = -Infinity;
  for (const l of lines) {
    for (const [x, y] of l) {
      mx0 = Math.min(mx0, x);
      my0 = Math.min(my0, y);
      mx1 = Math.max(mx1, x);
      my1 = Math.max(my1, y);
    }
  }
  if (look === 'none' || !Number.isFinite(mx0)) return { x0: 0, y0: 0, w: 1, h: 1, rgba: new Uint8ClampedArray(4) };
  // a clip box (tiles) bakes one piece of a long network: every pixel is worked out from the whole lines, so the
  // pieces meet without a seam
  const x0 = clip ? Math.floor(clip[0] * P) : Math.floor(mx0 * P - reach) - 2;
  const y0 = clip ? Math.floor(clip[1] * P) : Math.floor(my0 * P - reach) - 2;
  const w = clip ? Math.max(1, Math.ceil(clip[2] * P) - x0) : Math.max(1, Math.ceil(mx1 * P + reach) + 3 - x0);
  const h = clip ? Math.max(1, Math.ceil(clip[3] * P) - y0) : Math.max(1, Math.ceil(my1 * P + reach) + 3 - y0);
  const n = w * h;
  const best = new Float32Array(n).fill(1e9);
  const along = new Float32Array(n);
  const side = new Int8Array(n);
  const lineOf = new Int16Array(n).fill(-1);
  /** the light side of the line at the pixel: the rail there is the lit one */
  const lit = new Uint8Array(n);
  lines.forEach((pts, li) => {
    let cum = 0;
    for (let e = 0; e + 1 < pts.length; e++) {
      const ax = pts[e][0] * P;
      const ay = pts[e][1] * P;
      const bx = pts[e + 1][0] * P;
      const by = pts[e + 1][1] * P;
      const len = Math.hypot(bx - ax, by - ay);
      if (len < 1e-9) continue;
      if (Math.max(ax, bx) + reach < x0 || Math.min(ax, bx) - reach > x0 + w || Math.max(ay, by) + reach < y0 || Math.min(ay, by) - reach > y0 + h) {
        cum += len;
        continue;
      }
      const tx = (bx - ax) / len;
      const ty = (by - ay) / len;
      const i0 = Math.max(0, Math.floor(Math.min(ax, bx) - reach) - x0);
      const i1 = Math.min(w - 1, Math.ceil(Math.max(ax, bx) + reach) - x0);
      const j0 = Math.max(0, Math.floor(Math.min(ay, by) - reach) - y0);
      const j1 = Math.min(h - 1, Math.ceil(Math.max(ay, by) + reach) - y0);
      for (let j = j0; j <= j1; j++) {
        for (let i = i0; i <= i1; i++) {
          const px = x0 + i + 0.5 - ax;
          const py = y0 + j + 0.5 - ay;
          const t = Math.max(0, Math.min(len, px * tx + py * ty));
          const ox = px - t * tx;
          const oy = py - t * ty;
          const d = Math.hypot(ox, oy);
          const k = j * w + i;
          if (d < best[k]) {
            best[k] = d;
            along[k] = (cum + t) / P;
            const cr = tx * py - ty * px;
            side[k] = cr >= 0 ? 1 : -1;
            // the offset points up and left (toward the light) on this side
            lit[k] = ox + oy < 0 ? 1 : 0;
            lineOf[k] = li;
          }
        }
      }
      cum += len;
    }
  });
  const rgba = new Uint8ClampedArray(n * 4);
  /** 0 nothing, 1 bed, 2 sleeper, 3 rail (the shadow pass darkens beds and sleepers next to a rail) */
  const kind = new Uint8Array(n);
  const put = (k: number, c: C): void => {
    const o = k * 4;
    rgba[o] = c[0];
    rgba[o + 1] = c[1];
    rgba[o + 2] = c[2];
    rgba[o + 3] = 255;
  };
  // the bent pieces thrown aside at a break (tile coordinates of their two ends)
  const pieces: [number, number, number, number][] = [];
  /** the craters at the breaks: centre (tiles) and radius (tiles) */
  const craters: [number, number, number][] = [];
  for (const brk of brks) {
    if (!lines[brk.line]) continue;
    const L = lines[brk.line];
    const mid = (brk.s0 + brk.s1) / 2;
    const cq = pointAt(L, mid);
    craters.push([cq.x, cq.y, Math.max(0.3, (brk.s1 - brk.s0) * 0.25)]);
    for (const [ds, off, turn] of [[-0.22, 0.42, 0.7], [0.3, -0.38, -0.55]] as const) {
      const q = pointAt(L, mid + ds);
      const a = q.angle + turn;
      const nx = -Math.sin(q.angle);
      const ny = Math.cos(q.angle);
      const cx = q.x + nx * off;
      const cy = q.y + ny * off;
      const hl = 0.32;
      pieces.push([cx - Math.cos(a) * hl, cy - Math.sin(a) * hl, cx + Math.cos(a) * hl, cy + Math.sin(a) * hl]);
    }
  }
  const nearPiece = (qx: number, qy: number): boolean => {
    for (const [ax, ay, bx, by] of pieces) {
      const dx = bx - ax;
      const dy = by - ay;
      const L2 = dx * dx + dy * dy;
      const t = Math.max(0, Math.min(1, ((qx - ax) * dx + (qy - ay) * dy) / L2));
      if (Math.hypot(qx - ax - dx * t, qy - ay - dy * t) * P < 0.8) return true;
    }
    return false;
  };
  // where each line runs over water (arc ranges, tiles), widened a little: the bridge's ends on the banks
  const wetRuns = lines.map((pts) => {
    const runs: [number, number][] = [];
    const L = pathLength(pts);
    let start = -1;
    for (let q = 0; q <= L + 1e-9; q += 0.05) {
      const p = pointAt(pts, q);
      const wetQ = g.terrainAt(Math.floor(p.x), Math.floor(p.y)) <= 1;
      if (wetQ && start < 0) start = q;
      if (!wetQ && start >= 0) {
        runs.push([start - 0.5, q + 0.45]);
        start = -1;
      }
    }
    if (start >= 0) runs.push([start - 0.5, L]);
    return runs;
  });
  /** distance (tiles) from a land point to the nearest edge of a water tile beside its tile (9: none) */
  const bankEdge = (qx: number, qy: number): number => {
    const tx = Math.floor(qx);
    const ty = Math.floor(qy);
    const fx = qx - tx;
    const fy = qy - ty;
    let m = 9;
    if (g.terrainAt(tx - 1, ty) <= 1) m = Math.min(m, fx);
    if (g.terrainAt(tx + 1, ty) <= 1) m = Math.min(m, 1 - fx);
    if (g.terrainAt(tx, ty - 1) <= 1) m = Math.min(m, fy);
    if (g.terrainAt(tx, ty + 1) <= 1) m = Math.min(m, 1 - fy);
    return m;
  };
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const k = j * w + i;
      const d = best[k];
      if (d > reach && !brks.length) continue;
      const ai = x0 + i;
      const aj = y0 + j;
      const qx = (ai + 0.5) / P;
      const qy = (aj + 0.5) / P;
      const ter = g.terrainAt(Math.floor(qx), Math.floor(qy));
      const wet = ter <= 1;
      const dth = bayer4(ai, aj);
      const s = along[k];
      // broken: on a break's stretch of its line, or in a crater (the nearest crater shapes the pixel)
      let crater: [number, number, number] = [0, 0, 1];
      let cd = Infinity;
      for (const c of craters) {
        const e = Math.hypot(qx - c[0], qy - c[1]) / c[2];
        if (e < cd) (cd = e, crater = c);
      }
      let broken = cd < 1.3;
      for (let bi = 0; bi < brks.length && !broken; bi++) {
        const brk = brks[bi];
        if (lineOf[k] === brk.line && s >= brk.s0 && s <= brk.s1) broken = true;
      }
      if (pieces.length && !wet && nearPiece(qx, qy)) {
        put(k, g.tint([...STEEL_LIT] as RGB, 120));
        kind[k] = 3;
        continue;
      }
      if (d > reach && !broken) continue;
      if (look === 'line') {
        // normal zoom: one thin dark line (the pixel the line runs through), broken where the line is cut
        if (!(d < 1.0 || (d < 1.4 && side[k] > 0))) continue;
        if (broken) continue;
        if (wet) {
          put(k, STEEL_DARK);
          continue;
        }
        const tones = trackTones(ter, g.ramps);
        if (!tones) continue;
        put(k, g.tint(mixC(tones.path, [30, 30, 32], d < 0.8 ? 0.78 : 0.4), lumaC(tones.ground)));
        continue;
      }
      // the bridge's ends rest on the bank: its deck runs on over the shore strip (where the map draws the coast)
      const bank = !wet && lineOf[k] >= 0 && wetRuns[lineOf[k]].some(([a, b]) => s >= a && s <= b) && bankEdge(qx, qy) * P < sz.bed + 2.5;
      if (wet || bank) {
        // the bridge: a steel girder deck, sleepers and rails on it, the girder side toward the light lit; on the water
        // its shadow falls down and to the right
        if (wet && !lit[k] && d > sz.bed + 0.6 && d <= sz.bed + 2.8 && !broken) {
          const o = k * 4;
          rgba[o] = 4;
          rgba[o + 1] = 10;
          rgba[o + 2] = 16;
          rgba[o + 3] = 120;
          continue;
        }
        if (d > sz.bed + 0.6) {
          if (wet) continue;
        } else {
        let col: C;
        if (d > sz.bed - 0.4) col = lit[k] ? GIRDER_LIT : GIRDER_DARK;
        else if (Math.abs(d - sz.rail) < 0.5) col = lit[k] ? STEEL_LIT : STEEL;
        else if (d <= sz.sleeper && (s * P) % sz.pitch < 1) col = SLEEPER_BRIDGE;
        else col = GIRDER;
        put(k, col);
        kind[k] = Math.abs(d - sz.rail) < 0.5 ? 3 : 2;
        continue;
        }
      }
      const tones = trackTones(ter, g.ramps);
      if (!tones) continue;
      // a pool or a peak hides only the outer verge: the bed, sleepers and rails run on unbroken
      if (ter === 7 && d > sz.bed && swampPool(qx, qy)) continue;
      if (ter === 5 && d > sz.bed && underPeak(qx, qy, P, g.heightAt ? g.heightAt(qx, qy) : 0.7)) continue;
      // a cut through the forest: the crowns overhang the outer gravel, never the sleepers and rails
      if (ter === 3 && d > sz.sleeper && underCrown(qx, qy, P)) continue;
      const avg = lumaC(tones.ground);
      if (broken) {
        // the strike's crater: a pit lit from the top left (its upper-left wall in shadow, the lower-right wall lit), a
        // ring of thrown earth round it, soot specks beyond; along the rest of the stretch the rails are gone and the
        // bed is scorched
        const cdx = qx - crater[0];
        const cdy = qy - crater[1];
        const rr = Math.hypot(cdx, cdy) / crater[2];
        let col: C | null = null;
        if (rr < 0.6) {
          const lean = (-(cdx + cdy) * 0.7071) / Math.max(1e-6, Math.hypot(cdx, cdy));
          col = rr < 0.22 ? SOOT : lean > 0.25 ? SOOT : lean < -0.25 ? mixC(tones.path, SOOT_LIGHT, 0.5) : SOOT_LIGHT;
        } else if (rr < 1) col = dth < 0.5 ? mixC(tones.path, SOOT, 0.5) : mul(tones.path, rr < 0.8 ? 1.12 : 0.9);
        else if (rr < 1.3 && dth < 0.2) col = SOOT_LIGHT;
        else if (d <= sz.bed) col = dth < 0.3 ? SOOT_LIGHT : d <= sz.sleeper && (s * P) % sz.pitch < 1 && dth < 0.6 ? SOOT : mixC(tones.path, GRAVEL, 0.3);
        if (!col) continue;
        put(k, g.tint([col[0], col[1], col[2]], avg));
        kind[k] = 1;
        continue;
      }
      let col: C;
      let kd = 1;
      if (Math.abs(d - sz.rail) < 0.5) {
        col = lit[k] ? STEEL_LIT : STEEL;
        kd = 3;
      } else if (d <= sz.sleeper && (s * P + seed) % sz.pitch < 1) {
        col = mixC(SLEEPER, tones.path, 0.18);
        kd = 2;
      } else if (d <= sz.bed) {
        // the gravel bed: the land's own trodden tone pulled toward grey stone, speckled by the dither
        const base = mixC(tones.path, GRAVEL, ter === 6 || ter === 8 ? 0.18 : 0.42);
        col = dth < 0.2 ? mul(base, 1.13) : dth > 0.82 ? mul(base, 0.84) : base;
      } else if (dth < 0.4 * (1 - (d - sz.bed) / (sz.verge - sz.bed))) col = tones.verge;
      else continue;
      put(k, g.tint([col[0], col[1], col[2]], avg));
      kind[k] = kd;
    }
  }
  // each rail throws a one-pixel shadow down and right onto the gravel and the sleepers
  for (let j = h - 1; j >= 1; j--) {
    for (let i = w - 1; i >= 1; i--) {
      const k = j * w + i;
      if (kind[k] !== 1 && kind[k] !== 2) continue;
      if (kind[k - w - 1] !== 3) continue;
      const o = k * 4;
      rgba[o] = Math.round(rgba[o] * 0.68);
      rgba[o + 1] = Math.round(rgba[o + 1] * 0.68);
      rgba[o + 2] = Math.round(rgba[o + 2] * 0.7);
    }
  }
  return { x0, y0, w, h, rgba };
}

/** The sidings of a rail yard (tile coordinates): `n` parallel tracks `gap` tiles apart, `len` long, fanning out of the main line at both ends. */
export function yardLines(j: Junction, n = 4, len = 5.2, gap = 0.44, shift = 0): P[][] {
  const c = Math.cos(j.angle);
  const s = Math.sin(j.angle);
  // `shift` moves the yard along its axis, so the hub stands at one throat and the sidings lie beside it
  const at = (u: number, v: number): P => [j.x + (u + shift) * c - v * s, j.y + (u + shift) * s + v * c];
  const out: P[][] = [];
  const fan = 1.5;
  for (let k = 0; k < n; k++) {
    const v = (k - (n - 1) / 2) * gap;
    const pts: P[] = [];
    const half = len / 2 - Math.abs(v) * 0.6;
    pts.push(at(-half - fan, 0));
    for (let q = 0; q <= 8; q++) {
      const t = q / 8;
      const e = t * t * (3 - 2 * t);
      pts.push(at(-half - fan + fan * t, v * e));
    }
    pts.push(at(half, v));
    for (let q = 0; q <= 8; q++) {
      const t = q / 8;
      const e = t * t * (3 - 2 * t);
      pts.push(at(half + fan * t, v * (1 - e)));
    }
    out.push(pts);
  }
  return out;
}

// ------------------------------------------------------------------------------------------------- sea lane

/**
 * The pixels of a dotted sea lane along `path` (tile coordinates) on the ground grid P: short dashes of a lighter tone
 * of the water under each pixel (`waterAt`, null on land: no dot), every DOT tiles. Pure.
 */
export function laneArt(path: readonly P[], P: number, waterAt: (qx: number, qy: number) => C | null): TrackPixels {
  const DOT = P >= 16 ? 0.55 : P >= 8 ? 0.7 : 1;
  const dash = P >= 16 ? 0.22 : P >= 8 ? 0.26 : 0.34;
  const r = P >= 16 ? 1.0 : 0.6;
  let mx0 = Infinity;
  let my0 = Infinity;
  let mx1 = -Infinity;
  let my1 = -Infinity;
  for (const [x, y] of path) {
    mx0 = Math.min(mx0, x);
    my0 = Math.min(my0, y);
    mx1 = Math.max(mx1, x);
    my1 = Math.max(my1, y);
  }
  const x0 = Math.floor(mx0 * P) - 3;
  const y0 = Math.floor(my0 * P) - 3;
  const w = Math.ceil(mx1 * P) + 4 - x0;
  const h = Math.ceil(my1 * P) + 4 - y0;
  const rgba = new Uint8ClampedArray(w * h * 4);
  const best = new Float32Array(w * h).fill(1e9);
  const along = new Float32Array(w * h);
  let cum = 0;
  for (let e = 0; e + 1 < path.length; e++) {
    const ax = path[e][0] * P;
    const ay = path[e][1] * P;
    const bx = path[e + 1][0] * P;
    const by = path[e + 1][1] * P;
    const len = Math.hypot(bx - ax, by - ay);
    if (len < 1e-9) continue;
    const tx = (bx - ax) / len;
    const ty = (by - ay) / len;
    for (let j = Math.max(0, Math.floor(Math.min(ay, by) - 2) - y0); j <= Math.min(h - 1, Math.ceil(Math.max(ay, by) + 2) - y0); j++) {
      for (let i = Math.max(0, Math.floor(Math.min(ax, bx) - 2) - x0); i <= Math.min(w - 1, Math.ceil(Math.max(ax, bx) + 2) - x0); i++) {
        const px = x0 + i + 0.5 - ax;
        const py = y0 + j + 0.5 - ay;
        const t = Math.max(0, Math.min(len, px * tx + py * ty));
        const d = Math.hypot(px - t * tx, py - t * ty);
        const k = j * w + i;
        if (d < best[k]) {
          best[k] = d;
          along[k] = (cum + t) / P;
        }
      }
    }
    cum += len;
  }
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const k = j * w + i;
      if (best[k] > r) continue;
      if (along[k] % DOT > dash) continue;
      const qx = (x0 + i + 0.5) / P;
      const qy = (y0 + j + 0.5) / P;
      const wc = waterAt(qx, qy);
      if (!wc) continue;
      const c = mixC(wc, [222, 232, 236], 0.62);
      const o = k * 4;
      rgba[o] = c[0];
      rgba[o + 1] = c[1];
      rgba[o + 2] = c[2];
      rgba[o + 3] = 255;
    }
  }
  return { x0, y0, w, h, rgba };
}

// ------------------------------------------------------------------------------------------------- cut front

/**
 * The grey shimmer of a cut front on the ground grid P, inside the art-pixel rectangle (x0, y0, w, h): a band
 * `band` art px wide on `owner`'s side of every tile edge it shares with another nation's land, hard grey pixels whose
 * light and dark move along the border with the clock (`timeMs`). Pure.
 */
export function frontArt(x0: number, y0: number, w: number, h: number, P: number, ownerAt: (tx: number, ty: number) => number, owner: number, timeMs: number): TrackPixels {
  const band = P >= 16 ? 7 : P >= 8 ? 4 : P >= 4 ? 2 : 1;
  const rgba = new Uint8ClampedArray(w * h * 4);
  const foe = (tx: number, ty: number): boolean => {
    const o = ownerAt(tx, ty);
    return o !== 0 && o !== owner;
  };
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const ai = x0 + i;
      const aj = y0 + j;
      const qx = (ai + 0.5) / P;
      const qy = (aj + 0.5) / P;
      const tx = Math.floor(qx);
      const ty = Math.floor(qy);
      if (ownerAt(tx, ty) !== owner) continue;
      const fx = (qx - tx) * P;
      const fy = (qy - ty) * P;
      let d = 1e9;
      if (foe(tx - 1, ty)) d = Math.min(d, fx);
      if (foe(tx + 1, ty)) d = Math.min(d, P - fx);
      if (foe(tx, ty - 1)) d = Math.min(d, fy);
      if (foe(tx, ty + 1)) d = Math.min(d, P - fy);
      if (foe(tx - 1, ty - 1)) d = Math.min(d, Math.hypot(fx, fy));
      if (foe(tx + 1, ty - 1)) d = Math.min(d, Math.hypot(P - fx, fy));
      if (foe(tx - 1, ty + 1)) d = Math.min(d, Math.hypot(fx, P - fy));
      if (foe(tx + 1, ty + 1)) d = Math.min(d, Math.hypot(P - fx, P - fy));
      if (d > band) continue;
      const dth = bayer4(ai, aj);
      // a slow wave of light running along the border (one way along the diagonal), stepped by the dither
      const wave = 0.5 + 0.5 * Math.sin((qx * 0.8 - qy * 0.55) * 2.4 - timeMs / 260);
      const c: C = dth < wave * 0.85 ? (d < band * 0.5 ? [206, 208, 210] : [168, 170, 174]) : d < band * 0.5 ? [120, 122, 126] : [92, 94, 98];
      const o = (j * w + i) * 4;
      rgba[o] = c[0];
      rgba[o + 1] = c[1];
      rgba[o + 2] = c[2];
      rgba[o + 3] = 255;
    }
  }
  return { x0, y0, w, h, rgba };
}

// ------------------------------------------------------------------------------------------------- drawing ground pixels

/** The screen view the ground pixels are drawn for: CSS px of tile (0, 0) and CSS px per tile. */
export interface GroundView {
  ox: number;
  oy: number;
  zoom: number;
  dpr: number;
  w: number;
  h: number;
}

/**
 * Draws ground pixels on `ctx` (CSS px) the way the map shader draws its ground: every device pixel takes the art pixel
 * its centre falls in, so the line's pixels sit on the terrain's own.
 */
export function blitGround(ctx: CanvasRenderingContext2D, t: TrackPixels, P: number, v: GroundView): void {
  const { dpr } = v;
  const W = Math.ceil(v.w * dpr);
  const H = Math.ceil(v.h * dpr);
  const sx0 = v.ox + (t.x0 / P) * v.zoom;
  const sy0 = v.oy + (t.y0 / P) * v.zoom;
  const sx1 = v.ox + ((t.x0 + t.w) / P) * v.zoom;
  const sy1 = v.oy + ((t.y0 + t.h) / P) * v.zoom;
  const X0 = Math.max(0, Math.floor(sx0 * dpr));
  const Y0 = Math.max(0, Math.floor(sy0 * dpr));
  const X1 = Math.min(W, Math.ceil(sx1 * dpr));
  const Y1 = Math.min(H, Math.ceil(sy1 * dpr));
  if (X1 <= X0 || Y1 <= Y0) return;
  const cv = document.createElement('canvas');
  cv.width = X1 - X0;
  cv.height = Y1 - Y0;
  const cc = cv.getContext('2d');
  if (!cc) return;
  const img = cc.createImageData(cv.width, cv.height);
  const out = img.data;
  for (let y = Y0; y < Y1; y++) {
    const ty = ((y + 0.5) / dpr - v.oy) / v.zoom;
    const j = Math.floor(ty * P) - t.y0;
    if (j < 0 || j >= t.h) continue;
    for (let x = X0; x < X1; x++) {
      const tx = ((x + 0.5) / dpr - v.ox) / v.zoom;
      const i = Math.floor(tx * P) - t.x0;
      if (i < 0 || i >= t.w) continue;
      const s = (j * t.w + i) * 4;
      if (!t.rgba[s + 3]) continue;
      const o = ((y - Y0) * cv.width + (x - X0)) * 4;
      out[o] = t.rgba[s];
      out[o + 1] = t.rgba[s + 1];
      out[o + 2] = t.rgba[s + 2];
      out[o + 3] = t.rgba[s + 3];
    }
  }
  cc.putImageData(img, 0, 0);
  ctx.save();
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(cv, X0 / dpr, Y0 / dpr, cv.width / dpr, cv.height / dpr);
  ctx.restore();
}

// ------------------------------------------------------------------------------------------------- trains

/**
 * Car kinds. Military loads: 'flatTank' (a medium tank chained down on a flatcar), 'flatHeavy' (a heavy tank on a flatcar).
 * Supply loads: 'crates' (an open wagon of crates), 'drums' (fuel drums), 'sandbags' (sandbags and a tarp), 'tarp'
 * (cargo lashed under a tarpaulin), 'tank' (a silver fuel tank wagon).
 */
export type CarKind = 'engine' | 'tender' | 'tank' | 'flatTank' | 'flatHeavy' | 'crates' | 'drums' | 'sandbags' | 'tarp';

export const MILITARY_CARS: readonly CarKind[] = ['flatTank', 'flatHeavy'];
export const SUPPLY_CARS: readonly CarKind[] = ['crates', 'drums', 'sandbags', 'tarp', 'tank'];

/** Length of each car along the rail (model units) and the gap between cars (the couplings show in it). */
const CAR_LEN: Record<CarKind, number> = { engine: 9, tender: 4.6, tank: 10.5, flatTank: 10.5, flatHeavy: 10.5, crates: 10.5, drums: 10.5, sandbags: 10.5, tarp: 10.5 };
const CAR_GAP = 1.2;
/** Half width of the wagons (model units). The engine and tender are laid out at 1.8 and stretched across to match. */
const HW = 2.7;
/** The train is drawn this much larger than the units' model scale, so its loads read at the close zooms. */
const TRAIN_K = 0.8;

function chassis(L: number, hw: number): Part[] {
  // the dark frame and wheels under the body (they show on the side toward the viewer) and the couplers at both ends
  return [box(-L / 2 + 0.4, -hw + 0.1, L / 2 - 0.4, hw - 0.1, 0, 0.8, 'track'), seg(-L / 2, 0, -L / 2 - 0.7, 0, 0.5, 0.4, 0.4, 'gun'), seg(L / 2, 0, L / 2 + 0.7, 0, 0.5, 0.4, 0.4, 'gun')];
}

/** Parts of another model scaled by `k` and moved by (du, dv, dz): the game's own tank sitting on a car. */
function placed(parts: readonly Part[], k: number, du: number, dv: number, dz: number, swap: (m: MatId) => MatId = (m) => m): Part[] {
  const mv = (q: readonly number[] | undefined, all: boolean, pairs: number): number[] | undefined =>
    q && q.map((x, i) => (all || i < pairs ? x * k + (i % 2 === 0 ? du : dv) : x * k));
  return parts.map((p) => {
    const pairs = p.k === 'ell' ? 2 : p.k === 'seg' ? 4 : 99;
    return {
      ...p,
      m: swap(p.m),
      p: mv(p.p, false, pairs)!,
      z: p.z * k + dz,
      h: p.h * k,
      sc: p.sc && ([p.sc[0] * k + du, p.sc[1] * k + dv, p.sc[2] * k, p.sc[3] * k] as const),
      clip: p.clip && p.clip.map((x, i) => x * k + (i === 0 ? du : i === 1 ? dv : 0)),
      clipPoly: mv(p.clipPoly, true, 99),
    };
  });
}

/** Parts stretched along (u, by `fu`) and across (v, by `fv`) the car: footprints only, heights stay. */
function stretch(parts: readonly Part[], fu: number, fv: number): Part[] {
  const f = (q: readonly number[] | undefined, n = 99): number[] | undefined => q && q.map((x, i) => (i < n ? x * (i % 2 === 0 ? fu : fv) : x));
  return parts.map((p) => ({ ...p, p: f(p.p, p.k === 'seg' ? 4 : 99)!, sc: p.sc && ([p.sc[0] * fu, p.sc[1] * fv, p.sc[2] * fu, p.sc[3] * fv] as const), clip: f(p.clip, 4), clipPoly: f(p.clipPoly) }));
}

/**
 * One of the game's tanks from the unit models shrunk to ride a flatcar: its hull fills about 80% of the car, the gun
 * sticks out past the car's front end, the hull keeps its olive paint and the turret is in the owner's colour.
 */
function tankLoad(key: 'tankDivision' | 'heavyTank', dz: number): Part[] {
  const um = unitModel(key, 0);
  let u0 = Infinity;
  let u1 = -Infinity;
  let v1 = 0;
  for (const p of um.model.parts) {
    const b = partBox(p);
    u0 = Math.min(u0, b[0]);
    u1 = Math.max(u1, b[2]);
    v1 = Math.max(v1, Math.abs(b[1]), Math.abs(b[3]));
  }
  const k = Math.min((0.8 * CAR_LEN.flatTank) / (u1 - u0), (HW - 0.2) / v1);
  const du = -0.5 - ((u0 + u1) / 2) * k;
  const own = (m: MatId): MatId => (m === 'olive' || m === 'fieldgrey' ? 'own' : m);
  const parts = [...placed(um.model.parts, k, du, 0, dz)];
  if (um.turret) parts.push(...placed(um.turret.model.parts, k, du + um.turret.u * k, um.turret.v * k, dz, own));
  return parts;
}

/** A crate: a plank box, a lighter top with a dark outline and a stencilled cross, a dark strap. */
function crate(u: number, v: number, du: number, dv: number, z: number, h: number, m: MatId): Part[] {
  const t = z + h;
  return [
    box(u - du, v - dv, u + du, v + dv, z, h, m, { pat: 'planks', tone: -0.3 }),
    box(u - du, v - dv, u + du, v + dv, t, 0, 'black'),
    box(u - du + 0.2, v - dv + 0.2, u + du - 0.2, v + dv - 0.2, t, 0, m, { tone: 1 }),
    seg(u - du * 0.5, v, u + du * 0.5, v, 0.25, t, 0, m, { tone: -0.8 }),
    seg(u, v - dv * 0.5, u, v + dv * 0.5, 0.25, t, 0, m, { tone: -0.8 }),
  ];
}

/** An open wagon: a dark floor in the owner's colour, light wooden walls with a plank pattern all round. */
function openWagon(L: number): Part[] {
  const t = 0.5;
  const w = (a: number, b: number, c: number, d: number, tone: number): Part => box(a, b, c, d, 0.8, 1.7, 'tan', { pat: 'planks', tone });
  return [box(-L / 2, -HW, L / 2, HW, 0.8, 0.3, 'own', { tone: -0.7 }), w(-L / 2, -HW, L / 2, -HW + t, -0.2), w(-L / 2, HW - t, L / 2, HW, 0.5), w(-L / 2, -HW, -L / 2 + t, HW, 0), w(L / 2 - t, -HW, L / 2, HW, 0)];
}

/** A flatcar: a light plank deck with the owner's colour on the side beams. */
function flatCar(L: number): Part[] {
  return [
    box(-L / 2, -HW, L / 2, HW, 0.8, 0.5, 'tan', { pat: 'planks', tone: 0.2 }),
    box(-L / 2, -HW, L / 2, -HW + 0.45, 1.3, 0.3, 'own', { tone: 0.1 }),
    box(-L / 2, HW - 0.45, L / 2, HW, 1.3, 0.3, 'own', { tone: 0.5 }),
  ];
}

/** A fuel drum seen from above: a body, a light rim round a lid, a bung. */
function drum(u: number, v: number, z: number, m: MatId): Part[] {
  return [
    ell(u, v, 0.98, 0.98, z, 1.6, m, { sh: 'cyl' }),
    ell(u, v, 0.98, 0.98, z + 1.6, 0.05, 'alu', { edge: true, tone: 0.6 }),
    ell(u, v, 0.7, 0.7, z + 1.6, 0, m, { tone: 0.8 }),
    ell(u + 0.2, v - 0.15, 0.2, 0.2, z + 1.6, 0.1, 'black'),
  ];
}

const MODELS = new Map<CarKind, Model>();
/** The model of one car (bake.ts parts; +u forward, +v to the right, z up). */
export function carModel(kind: CarKind): Model {
  let m = MODELS.get(kind);
  if (m) return m;
  const L = CAR_LEN[kind];
  const parts: Part[] = [];
  switch (kind) {
    case 'engine': {
      // a steam locomotive from above: a long narrow boiler (about 65% of the length) with thin dark bands, a darker
      // smokebox and a small chimney at the front, a steam dome and a sand dome on top, running boards down both sides,
      // a short cab at the back with a flat roof and a modest owner stripe, a buffer beam on the nose
      parts.push(box(-L / 2 + 0.3, -2.0, L / 2 - 0.3, 2.0, 0, 0.8, 'track'), seg(-L / 2, 0, -L / 2 - 0.6, 0, 0.5, 0.4, 0.4, 'gun'), seg(L / 2, 0, L / 2 + 0.6, 0, 0.5, 0.4, 0.4, 'gun'));
      parts.push(box(-L / 2 + 0.2, -2.0, L / 2 - 0.2, 2.0, 0.8, 0.4, 'gun', { tone: -0.2 }));
      parts.push(seg(-1.8, -1.8, 4.1, -1.8, 0.22, 1.2, 0.1, 'fieldgrey', { tone: 0.4 }), seg(-1.8, 1.8, 4.1, 1.8, 0.22, 1.2, 0.1, 'fieldgrey', { tone: -0.2 }));
      // the boiler: -2.0 .. 3.9, a lit cylinder with bands
      parts.push(box(-2.0, -1.3, 3.9, 1.3, 1.2, 2.0, 'gun', { sh: 'cyl', tone: 1.4 }));
      for (const u of [-0.6, 0.9, 2.3]) parts.push(seg(u, -1.3, u, 1.3, 0.2, 3.2, 0.05, 'black', { tone: 0.6 }));
      parts.push(box(3.3, -1.35, 4.2, 1.35, 1.2, 2.1, 'gun', { sh: 'cyl', tone: 0.3 }), ell(3.75, 0, 0.35, 0.8, 3.3, 0, 'black', { tone: 0.4 }));
      parts.push(ell(3.5, 0, 0.42, 0.42, 3.3, 1.2, 'black', { sh: 'cyl', tone: 0.6 }), ell(3.5, 0, 0.62, 0.62, 4.5, 0.25, 'gun', { sh: 'dome', tone: 0.4 }), ell(3.5, 0, 0.3, 0.3, 4.75, 0, 'black'));
      parts.push(ell(0.5, 0, 0.7, 0.7, 3.2, 0.9, 'gun', { sh: 'dome', tone: 1.5 }), ell(0.5, 0, 0.25, 0.25, 4.1, 0.15, 'brass', { sh: 'dome' }), ell(1.9, 0, 0.5, 0.5, 3.2, 0.6, 'gun', { sh: 'dome', tone: 1.5 }));
      // the cab: walls, a flat roof overhanging a little, an owner stripe along it
      parts.push(box(-4.3, -1.75, -1.9, 1.75, 0.8, 2.5, 'gun', { tone: 1.0 }), box(-4.5, -1.9, -1.8, 1.9, 3.3, 0.3, 'gun', { tone: 0.6 }), box(-4.5, -0.45, -1.8, 0.45, 3.6, 0, 'own', { tone: -0.2 }));
      parts.push(box(-3.6, -1.9, -2.6, -1.75, 1.6, 1.0, 'black'), box(-3.6, 1.75, -2.6, 1.9, 1.6, 1.0, 'black'));
      parts.push(box(L / 2 - 0.5, -2.0, L / 2 - 0.1, 2.0, 0.5, 0.8, 'redpaint', { tone: -0.3 }));
      break;
    }
    case 'tender':
      // a low box on its frame, a textured heap of dark coal with small lit lumps
      parts.push(box(-L / 2 + 0.3, -2.0, L / 2 - 0.3, 2.0, 0, 0.8, 'track'), seg(-L / 2, 0, -L / 2 - 0.6, 0, 0.5, 0.4, 0.4, 'gun'));
      parts.push(box(-L / 2, -1.95, L / 2, 1.95, 0.8, 1.4, 'gun', { tone: 0.4 }), box(-L / 2 + 0.4, -1.55, L / 2 - 0.4, 1.55, 2.0, 0.2, 'black'));
      parts.push(ell(0, 0, 1.8, 1.35, 2.1, 0.6, 'black', { sh: 'dome', tone: 0.5 }));
      for (let i = 0; i < 11; i++) {
        const a = i * 2.399;
        const r = 0.25 + ((i * 37) % 10) / 12;
        parts.push(ell(Math.cos(a) * r * 1.9, Math.sin(a) * r * 1.2, 0.34 + (i % 3) * 0.08, 0.3 + (i % 2) * 0.08, 2.5, 0.35, 'black', { sh: 'dome', tone: 1.6 + (i % 3) * 0.4 }));
      }
      parts.push(box(L / 2 - 0.5, -0.4, L / 2 - 0.1, 0.4, 2.0, 0, 'own', { tone: -0.2 }));
      break;
    case 'flatTank':
    case 'flatHeavy': {
      // a flatcar with one of the game's tanks on it, held down by chains and wheel chocks
      parts.push(...chassis(L, HW), ...flatCar(L), ...tankLoad(kind === 'flatTank' ? 'tankDivision' : 'heavyTank', 1.3));
      for (const u of [-3.4, 0.2]) {
        parts.push(seg(u, -HW + 0.1, u + 0.8, -2.1, 0.26, 2.9, 0.12, 'gun', { tone: 1 }), seg(u, HW - 0.1, u + 0.8, 2.1, 0.26, 2.9, 0.12, 'gun', { tone: 1 }));
      }
      parts.push(box(-5, -1.9, -4.5, 1.9, 1.3, 0.6, 'ochre', { pat: 'planks' }));
      break;
    }
    case 'crates': {
      // an open wagon of six big crates in two rows of three, with olive ammo boxes among the plain wooden ones
      parts.push(...chassis(L, HW), ...openWagon(L));
      const mat: MatId[] = ['ochre', 'olive', 'ochre', 'olive', 'ochre', 'ochre'];
      for (let i = 0; i < 6; i++) parts.push(...crate(-3.1 + (i % 3) * 3.1, i < 3 ? -1.25 : 1.25, 1.3, 1.0, 1.1, i === 1 || i === 3 ? 1.5 : 1.9, mat[i]));
      break;
    }
    case 'drums':
      // an open wagon of fuel drums standing in two rows of four: rusty red, blue and olive, each a round light-rimmed lid
      parts.push(...chassis(L, HW), ...openWagon(L));
      for (let i = 0; i < 4; i++) {
        const u = -3.4 + i * 2.27;
        parts.push(...drum(u, -1.35, 1.1, i % 2 ? 'rust' : 'fadedBlue'), ...drum(u, 1.35, 1.1, i % 2 ? 'olive' : 'rust'));
      }
      break;
    case 'sandbags':
      // an open wagon of sandbags in staggered rounded rows, a lashed tarp over one end
      parts.push(...chassis(L, HW), ...openWagon(L));
      for (let r = 0; r < 4; r++) {
        for (let c = 0; c < 4; c++) parts.push(ell(-3.5 + c * 2.1 + (r % 2) * 1.0, -2.0 + r * 1.35, 1.05, 0.62, 1.1 + ((r + c) % 2) * 0.35, 0.8, 'tan', { sh: 'dome', tone: (r + c) % 2 ? 0.4 : 0 }));
      }
      break;
    case 'tarp':
      // an open wagon with its cargo lashed under a tarpaulin: a rounded hump with ropes across
      parts.push(...chassis(L, HW), ...openWagon(L));
      parts.push(box(-L / 2 + 0.8, -HW + 0.7, L / 2 - 0.8, HW - 0.7, 1.1, 1.8, 'canvas', { sh: 'cyl' }), ell(0, 0, 4.2, 1.7, 2.6, 0.5, 'canvas', { sh: 'dome', tone: 0.4 }));
      for (const u of [-3.2, -1.1, 1.1, 3.2]) parts.push(seg(u, -HW + 0.4, u, HW - 0.4, 0.26, 3.1, 0.1, 'rust', { tone: -0.2 }));
      break;
    case 'tank':
      // a fuel tank wagon: an owner-coloured frame and a long silver-grey cylinder with bands and a filler dome
      parts.push(...chassis(L, HW), box(-L / 2, -HW, L / 2, HW, 0.8, 0.6, 'own', { tone: -0.3 }));
      parts.push(box(-L / 2 + 0.5, -2.2, L / 2 - 0.5, 2.2, 1.4, 2.8, 'alu', { sh: 'cyl' }));
      parts.push(ell(0, 0, 0.9, 0.9, 4.2, 0.4, 'alu', { sh: 'dome', tone: 0.5 }), ell(0, 0, 0.45, 0.45, 4.6, 0.1, 'black'));
      for (const u of [-3.2, 3.2]) parts.push(seg(u, -2.35, u, 2.35, 0.3, 3.0, 0.1, 'gun'));
      break;
  }
  m = { parts, ground: 0.26 };
  MODELS.set(kind, m);
  return m;
}

/** Total length of a train (model units, at the train's own larger scale). */
export function trainLength(cars: readonly CarKind[]): number {
  return TRAIN_K * (cars.reduce((s, c) => s + CAR_LEN[c], 0) + CAR_GAP * Math.max(0, cars.length - 1));
}

const mix = (a: number): number => {
  let h = (a ^ 0x9e3779b9) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
};

/**
 * The cars of a supply train carrying `load` (1 light .. 3 heavy): engine and tender, then 2 to 3 wagons. The wagons are
 * picked from `seed` (the same train every time) and always hold a tank on a flatcar (or a heavy one) and at least one
 * supply load (crates, drums, sandbags, a tarp or fuel).
 */
export function trainCars(load: number, seed = 0): CarKind[] {
  const n = Math.max(2, Math.min(3, 1 + Math.round(load)));
  const all = [...MILITARY_CARS, ...SUPPLY_CARS];
  let r = mix(seed + 1);
  const next = (m: number): number => {
    r = mix(r + 7);
    return r % m;
  };
  // every train shows a tank on a flatcar (the headline load); guns turn up among the other wagons
  const wagons: CarKind[] = ['flatTank', SUPPLY_CARS[next(SUPPLY_CARS.length)]];
  while (wagons.length < n) {
    const k = all[next(all.length)];
    // every wagon a different kind, so the mix reads
    if (!wagons.includes(k)) wagons.push(k);
  }
  for (let i = n - 1; i > 0; i--) {
    const j = next(i + 1);
    [wagons[i], wagons[j]] = [wagons[j], wagons[i]];
  }
  return ['engine', 'tender', ...wagons];
}

const bakes = new Map<string, Baked>();
function carBake(kind: CarKind, facing: number, n: number, res: number, owner: RGB, ring: number): Baked {
  const key = `${kind}|${facing}|${n}|${res}|${ring}|${owner.join(',')}`;
  let b = bakes.get(key);
  if (!b) {
    // each car gets the unit outline (owner ring, dark edge), so the cars read one by one with the couplings between
    b = outlineOf(rasterize(carModel(kind), res, facing, { facings: n, owner }), owner, ring);
    if (bakes.size > 600) bakes.clear();
    bakes.set(key, b);
  }
  return b;
}

export interface TrainDraw {
  /** the rail on screen (CSS px), the train runs toward its end */
  path: readonly P[];
  /** arc length (CSS px) of the engine's nose along the path */
  head: number;
  cars: readonly CarKind[];
  owner: RGB;
  /** screen px per model unit (the units' map scale) and device px per CSS px */
  scale: number;
  dpr: number;
  timeMs: number;
  /** the smoke puff (off when standing in a yard) */
  smoke?: boolean;
}

/**
 * Draws a train along its rail: every car baked at its own heading (the chord between its two bogies) and outlined in
 * the owner's colour like a unit, all cars put into one picture (nearer cars over farther ones), then the smoke puff.
 */
export function drawTrain(ctx: CanvasRenderingContext2D, t: TrainDraw): void {
  const sc = t.scale * TRAIN_K;
  const g = gridOf(sc, t.dpr);
  const n = facingsFor(g.res, 'ship');
  const total = pathLength(t.path);
  type Placed = { b: Baked; X: number; Y: number; cy: number };
  const placed: Placed[] = [];
  let s = t.head;
  const toCell = (v: number): number => Math.round((v * t.dpr) / g.p);
  let engine: { x: number; y: number; th: number } | null = null;
  for (const kind of t.cars) {
    const L = CAR_LEN[kind] * sc;
    const c = s - L / 2;
    const f = pointAt(t.path, Math.max(0, Math.min(total, c + L * 0.36)));
    const r = pointAt(t.path, Math.max(0, Math.min(total, c - L * 0.36)));
    const m = pointAt(t.path, Math.max(0, Math.min(total, c)));
    const ang = Math.atan2(f.y - r.y, f.x - r.x);
    const facing = facingIndex(ang, n);
    const b = carBake(kind, facing, n, g.res, t.owner, 0);
    placed.push({ b, X: toCell(m.x) - b.ox, Y: toCell(m.y) - b.oy, cy: m.y });
    if (kind === 'engine') engine = { x: m.x, y: m.y, th: facing * ((Math.PI * 2) / n) };
    s -= L + CAR_GAP * sc;
  }
  if (!placed.length) return;
  let X0 = Infinity;
  let Y0 = Infinity;
  let X1 = -Infinity;
  let Y1 = -Infinity;
  for (const p of placed) {
    X0 = Math.min(X0, p.X);
    Y0 = Math.min(Y0, p.Y);
    X1 = Math.max(X1, p.X + p.b.w);
    Y1 = Math.max(Y1, p.Y + p.b.h);
  }
  const W = X1 - X0;
  const H = Y1 - Y0;
  const data = new Uint8ClampedArray(W * H * 4);
  // back to front (lower on the screen is nearer): a nearer car's body covers the coupling behind it
  for (const p of placed.slice().sort((a, b) => a.cy - b.cy)) {
    for (let y = 0; y < p.b.h; y++) {
      for (let x = 0; x < p.b.w; x++) {
        const si = (y * p.b.w + x) * 4;
        const a = p.b.data[si + 3];
        if (!a) continue;
        const di = ((p.Y - Y0 + y) * W + (p.X - X0 + x)) * 4;
        const da = data[di + 3];
        // a solid pixel wins over a shadow or rim; a shadow never covers a solid pixel
        if (a < 200 && da >= 200) continue;
        if (a < 200 && da > 0) {
          data[di + 3] = Math.max(da, a);
          continue;
        }
        data[di] = p.b.data[si];
        data[di + 1] = p.b.data[si + 1];
        data[di + 2] = p.b.data[si + 2];
        data[di + 3] = a;
      }
    }
  }
  const out: Baked = { w: W, h: H, ox: 0, oy: 0, data };
  const cv = document.createElement('canvas');
  cv.width = out.w;
  cv.height = out.h;
  const cc = cv.getContext('2d');
  if (!cc) return;
  const img = cc.createImageData(out.w, out.h);
  img.data.set(out.data);
  cc.putImageData(img, 0, 0);
  ctx.save();
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(cv, ((X0 - out.ox) * g.p) / t.dpr, ((Y0 - out.oy) * g.p) / t.dpr, (out.w * g.p) / t.dpr, (out.h * g.p) / t.dpr);
  ctx.restore();
  if (t.smoke !== false && engine) drawSmoke(ctx, engine.x, engine.y, engine.th, t, g);
}

/** The engine's smoke: puffs rising off the stack and drifting back over the train, growing and thinning. */
function drawSmoke(ctx: CanvasRenderingContext2D, x: number, y: number, th: number, t: TrainDraw, g: Grid): void {
  const sc = t.scale * TRAIN_K;
  const [sx, sy] = project(3.5, 0, 5.0, th, 0, sc, false);
  const PUFFS = 7;
  for (let i = PUFFS - 1; i >= 0; i--) {
    const age = (t.timeMs / 1400 + i / PUFFS) % 1;
    const back = age * 16;
    const [dx, dy] = project(-back, 0.9 * age, age * 6, th, 0, sc, false);
    const r = (0.8 + age * 1.9) * g.res;
    drawBlob(ctx, age < 0.12 ? 'vapour' : 'smoke', r, (i + Math.floor(t.timeMs / 1400)) & 3, x + sx + dx, y + sy + dy, g, 0.55 * (1 - age) ** 1.6);
  }
}

/** A train or convoy as a dot in the owner's colour (5 CSS px) with a dark edge and a lit corner, on whole device px (art lab). */
export function drawTrainDot(ctx: CanvasRenderingContext2D, x: number, y: number, owner: RGB, dpr: number): void {
  const px = (v: number): number => Math.round(v * dpr) / dpr;
  const u = Math.max(1, Math.round(dpr)) / dpr;
  const X = px(x - 3.5);
  const Y = px(y - 3.5);
  ctx.fillStyle = 'rgba(8,11,17,0.9)';
  ctx.fillRect(X, Y, 7, 7);
  ctx.fillStyle = `rgb(${owner.join(',')})`;
  ctx.fillRect(X + 1, Y + 1, 5, 5);
  ctx.fillStyle = `rgb(${mixC(owner, [255, 255, 255], 0.6).join(',')})`;
  ctx.fillRect(X + 1, Y + 1, 2, u);
  ctx.fillRect(X + 1, Y + 1, u, 2);
}

// ------------------------------------------------------------------------------------------------- labels

/**
 * A map label in the level chip's style (buildings.ts levelPill): a dark plate, a coloured bar on the left, a small
 * drawn icon and a plain word with its unit. `icon` 'cut' is a broken rail, 'repair' a clock.
 */
export function supplyLabel(ctx: CanvasRenderingContext2D, cx: number, y: number, text: string, icon: 'cut' | 'repair', progress = 0): void {
  ctx.font = `600 11px ${MAP_LABEL_FAMILY}`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  const tw = Math.ceil(ctx.measureText(text).width);
  const w = tw + 28;
  const h = 17;
  const x0 = Math.round(cx - w / 2);
  const y0 = Math.round(y - h / 2);
  const bar = icon === 'cut' ? 'rgb(176,180,186)' : 'rgb(232,170,64)';
  ctx.fillStyle = 'rgb(8,10,13)';
  ctx.fillRect(x0, y0, w, h);
  ctx.fillStyle = 'rgba(20,23,29,0.96)';
  ctx.fillRect(x0 + 1, y0 + 1, w - 2, h - 2);
  ctx.fillStyle = 'rgba(255,255,255,0.08)';
  ctx.fillRect(x0 + 1, y0 + 1, w - 2, 1);
  ctx.fillStyle = bar;
  ctx.fillRect(x0 + 1, y0 + 1, 3, h - 2);
  const ix = x0 + 8;
  const iy = y0 + 4;
  if (icon === 'cut') {
    // two rail ends with a gap: rails, sleepers, a break in the middle
    ctx.fillStyle = '#c9ccd1';
    ctx.fillRect(ix, iy + 2, 4, 1);
    ctx.fillRect(ix, iy + 6, 4, 1);
    ctx.fillRect(ix + 7, iy + 3, 4, 1);
    ctx.fillRect(ix + 7, iy + 7, 4, 1);
    ctx.fillStyle = '#8a6a4c';
    ctx.fillRect(ix + 1, iy + 1, 1, 7);
    ctx.fillRect(ix + 9, iy + 2, 1, 7);
    ctx.fillStyle = '#e25a48';
    ctx.fillRect(ix + 5, iy + 1, 1, 1);
    ctx.fillRect(ix + 5, iy + 4, 1, 1);
    ctx.fillRect(ix + 5, iy + 7, 1, 1);
  } else {
    // a clock face with the part still to repair filled
    ctx.fillStyle = '#e8aa40';
    ctx.beginPath();
    ctx.arc(ix + 4.5, iy + 4.5, 4.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = 'rgb(20,23,29)';
    ctx.beginPath();
    ctx.arc(ix + 4.5, iy + 4.5, 3.3, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#e8aa40';
    ctx.beginPath();
    ctx.moveTo(ix + 4.5, iy + 4.5);
    ctx.arc(ix + 4.5, iy + 4.5, 3.3, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * (1 - progress));
    ctx.closePath();
    ctx.fill();
  }
  ctx.fillStyle = '#ffffff';
  ctx.fillText(text, x0 + 22, y0 + h / 2 + 0.5);
}

/** The far-zoom damage mark on a hub's marker: a red badge with a white cross at its top right corner. */
export function damageCross(ctx: CanvasRenderingContext2D, x: number, y: number, size: number): void {
  const r = Math.max(4, Math.round(size * 0.24));
  const cx = Math.round(x + size / 2 - r * 0.4);
  const cy = Math.round(y - size / 2 + r * 0.4);
  ctx.fillStyle = 'rgb(8,10,13)';
  ctx.beginPath();
  ctx.arc(cx, cy, r + 1, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#d93b2e';
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = Math.max(1.5, r * 0.36);
  ctx.lineCap = 'square';
  const q = r * 0.42;
  ctx.beginPath();
  ctx.moveTo(cx - q, cy - q);
  ctx.lineTo(cx + q, cy + q);
  ctx.moveTo(cx + q, cy - q);
  ctx.lineTo(cx - q, cy + q);
  ctx.stroke();
}
