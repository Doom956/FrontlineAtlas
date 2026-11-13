// The detailed style's craters (client only). A crater is a baked pixel bitmap on the style's grid (four shapes per
// size): a dark pit with its far inner wall catching the light, a rim of thrown-up earth broken into clods (lit on the
// top left, shadowed on the lower right) whose outline and width wander with noise, heavier on one side, scorched
// ground thinning out in uneven rays of soot, charred splinters and clods of earth scattered round it, all in the earth
// and soot tones of the style's palette, foreshortened by the 3/4 view. Fresh, it burns: small flickering tongues of
// flame here and there in the pit and on the rim going out one by one, glowing embers that outlast them, the warm light
// of the fires on the earth, and smoke rising and drifting downwind from each fire, thinning to grey wisps after;
// bigger blasts burn longer (craterSmoke makes more and longer smoke). Then it weathers and fades out by itself. Far
// out (below zoom 3) it is a small dark scorch.
//
// The atom bomb's ground mark (CraterDraw.atom) is not a crater but a blast zone about three crater radii wide:
// scorched, flattened ground with an uneven edge, radial streaks of soot and blown-down rubble pointing away from
// ground zero, a shallow pan of earth fused to dull green glass in the middle that glows white, then red hot and cools,
// fires scattered over the zone going out one by one (the outer ones last), smoke rising from many points and a pall
// drifting off; it fades over its long life.
//
// A crater has no clock of its own (only its age over its life, q), and lives differ: the lab gives every crater 9 s
// (craterLife 1), the game 30 s for a shell's to 3 minutes for an atom bomb's. The fires run on a clock between the two
// (fireClock), so they neither race in the lab nor crawl in the game.
import type { MotionParams } from '../motion';
import { canBake, SpriteAtlas, type RGBABitmap } from '../shared/atlas';
import { hex } from '../shared/colour';
import { rnd } from '../shared/noise';
import type { CraterArt, CraterDraw } from '../types';
import { drawBlob } from './blobs';
import { drawFlame, drawSmokeTrail, type SmokeSource } from './burning';
import { gridOf, type Grid } from './grid';
import { ASH, FIRE, GLASS, SCORCH } from './palette';

const SC = SCORCH.map(hex);
const BAYER = [0.125, 0.625, 0.875, 0.375];

function hash2(x: number, y: number, s: number): number {
  const v = Math.sin(x * 127.1 + y * 311.7 + s * 74.7) * 43758.5453;
  return v - Math.floor(v);
}

/** Smooth value noise 0..1. */
function vnoise(x: number, y: number, s: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const a = hash2(x0, y0, s);
  const b = hash2(x0 + 1, y0, s);
  const c = hash2(x0, y0 + 1, s);
  const d = hash2(x0 + 1, y0 + 1, s);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}
/** Noise round the rim: 2D noise sampled on a circle (seamless all the way round), two octaves, 0..1. */
function ringNoise(a: number, freq: number, s: number): number {
  const c = Math.cos(a);
  const n = Math.sin(a);
  return vnoise(c * freq + 9.3, n * freq + 4.1, s) * 0.65 + vnoise(c * freq * 2.3 + 1.7, n * freq * 2.3 + 7.9, s + 1) * 0.35;
}

/**
 * The crater's pixels: radius `r` cells (2..60), shape `variant` (0..3). Origin at the pit's centre. No ring is drawn
 * anywhere: the outline, the rim's width and the reach of the scorch all wander with noise round the crater, the rim
 * is broken into clods with gaps, the earth is thrown further to one side (each variant its own), and the scorch
 * thins out into the ground by dithering instead of ending on an edge.
 */
export function craterBitmap(r: number, variant: number): RGBABitmap {
  const R = Math.max(2, Math.min(60, Math.round(r)));
  const reach = 2;
  const hw = Math.ceil(R * reach) + 2;
  const hh = Math.ceil(R * reach * 0.84) + 2;
  const W = hw * 2 + 1;
  const H = hh * 2 + 1;
  const data = new Uint8ClampedArray(W * H * 4);
  const sd = variant * 17 + 3;
  // the side the earth was thrown to, and how lumpy the outline is (variants differ)
  const heavy = variant * 1.71 + 0.6 + rnd(R, variant) * 0.8;
  const lumps = 1.1 + 0.35 * variant + rnd(variant, R) * 0.4;
  // rays of soot: a few directions where the scorch reaches further
  const rays: [number, number][] = [];
  const nr = 4 + (variant % 3);
  for (let i = 0; i < nr; i++) rays.push([rnd(variant * 7 + R, i) * Math.PI * 2, 0.25 + 0.45 * rnd(variant + R * 3, i + 9)]);
  const rayAt = (a: number): number => {
    let v = 0;
    for (const [ra, len] of rays) {
      const d = Math.abs((((a - ra) % (Math.PI * 2)) + Math.PI * 3) % (Math.PI * 2) - Math.PI);
      v = Math.max(v, len * Math.max(0, 1 - d / 0.38));
    }
    return v;
  };
  const set = (x: number, y: number, c: readonly number[], a: number): void => {
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    const o = (y * W + x) * 4;
    data[o] = c[0];
    data[o + 1] = c[1];
    data[o + 2] = c[2];
    data[o + 3] = a;
  };
  // grain scales with the crater, so a big one has big clods, not pepper
  const gs = Math.max(0.18, Math.min(0.6, 3.2 / R));
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const dx = x - hw;
      const dy = (y - hh) / 0.84;
      const a = Math.atan2(dy, dx);
      const side = Math.cos(a - heavy);
      const shape = 1 + 0.26 * (ringNoise(a, lumps, sd) - 0.5) + 0.06 * side;
      const d = Math.hypot(dx, dy) / (R * shape);
      const dith = BAYER[(x & 1) + ((y & 1) << 1)];
      const grain = hash2(x, y, variant + 3);
      const clump = vnoise(x * gs + variant * 5.1, y * gs, sd + 7);
      const rimIn = 0.6 + 0.12 * (ringNoise(a, lumps * 1.7, sd + 3) - 0.5);
      const rimOut = rimIn + (0.3 + 0.24 * ringNoise(a, lumps * 2.1, sd + 5)) * (1 + 0.38 * side);
      if (d < rimIn) {
        // the pit: darkest at the bottom, shading up its walls; the lower right inner wall faces the light
        const q = d / rimIn;
        const wall = (dx + dy) / (R * rimIn * 1.2);
        let tf = 0.2 + 1.6 * q * q + (q > 0.45 ? wall * 1.5 * q : 0) + (clump - 0.5) * 0.9;
        tf += dith * 0.9;
        set(x, y, SC[Math.max(0, Math.min(4, Math.floor(tf + 0.5)))], 255);
      } else if (d < rimOut) {
        // the rim of thrown earth, broken into clods: lit on their top left, shadowed lower right, gaps of scorch
        const f = (d - rimIn) / (rimOut - rimIn);
        const keep = clump + grain * 0.22 - Math.abs(f - 0.35) * 0.55;
        if (keep < 0.36) {
          // a gap between clods: scorched earth, sometimes thinned out
          if (grain + dith * 0.3 < 0.15 + f * 0.25) continue;
          set(x, y, SC[grain > 0.6 ? 2 : 1], 235);
          continue;
        }
        const lit = (dx + dy) / R + (clump - 0.55) * 1.6 + dith * 0.4;
        set(x, y, SC[lit < -0.35 ? (grain > 0.55 ? 6 : 5) : lit < 0.35 ? 4 : 3], 255);
      } else {
        // scorch thinning out into the ground: dithered, never a hard edge, reaching further along the rays and on the
        // side the earth was thrown to
        const span = 0.35 + rayAt(a) + 0.22 * Math.max(0, side) + 0.12 * ringNoise(a, lumps * 3, sd + 9);
        const f = (d - rimOut) / span;
        if (f >= 1) continue;
        const dens = (1 - f) * (1 - f) * (0.55 + 0.6 * clump);
        if (grain * 0.75 + (dith + 0.5) * 0.25 > dens) continue;
        set(x, y, SC[clump > 0.62 && f < 0.4 ? 3 : grain > 0.5 ? 2 : 1], Math.round(150 + 80 * (1 - f)));
      }
    }
  }
  // clods of earth thrown out, most of them to the heavy side
  const n = 5 + Math.round(R * 0.7);
  for (let i = 0; i < n; i++) {
    const toHeavy = rnd(R + 5, i + variant) < 0.65;
    const a = toHeavy ? heavy + (rnd(variant + R, i) - 0.5) * 2.2 : rnd(variant + R, i) * Math.PI * 2;
    const d = R * (1.1 + (toHeavy ? 0.9 : 0.5) * rnd(R, i + variant));
    const cx = Math.round(hw + Math.cos(a) * d);
    const cy = Math.round(hh + Math.sin(a) * d * 0.84);
    set(cx, cy, SC[5], 255);
    if (R >= 5 && rnd(i, R) > 0.35) {
      set(cx + 1, cy, SC[3], 255);
      set(cx, cy + 1, SC[2], 255);
    }
  }
  // charred splinters and blackened stones lying out in the scorch, pointing away from the pit
  if (R >= 4) {
    const ns = 2 + Math.round(R * 0.35);
    for (let i = 0; i < ns; i++) {
      const a = rnd(variant + 40, i + R) * Math.PI * 2;
      const d = R * (1.05 + 0.7 * rnd(R + 40, i + variant));
      const len = 1 + Math.round(rnd(i + 3, R) * 2);
      for (let j = 0; j <= len; j++) set(Math.round(hw + Math.cos(a) * (d + j)), Math.round(hh + Math.sin(a) * (d + j) * 0.84), SC[j === len ? 2 : 0], 255);
    }
  }
  return { w: W, h: H, ox: hw, oy: hh, data };
}

const atlas = new SpriteAtlas(1024, 4);

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/** How big a blast a crater is from, 0 a shell's (half a tile) .. 1 an atom bomb's (11 tiles), on a log scale. */
export const sizeClass = (rt: number): number => clamp01(Math.log(Math.max(0.5, rt) / 0.5) / Math.log(22));

/** The fires' clock (ms) at age q: a life of 16 s for a shell's crater up to 40 s for an atom bomb's (see the header). */
export const fireClock = (q: number, size: number, m: MotionParams): number => q * m.craterLife * (16000 + 24000 * size);

/**
 * The share of a crater's life its fires burn (they die down over it), for a crater `rt` tiles across: a shell's
 * about a sixth, a missile's about a third, longer with craterSmoke (cinematic) and shorter without (subtle).
 */
export function burnShare(rt: number, m: MotionParams): number {
  const big = clamp01((rt - 0.4) / 1.7);
  return (0.15 + 0.2 * big) * (0.75 + 0.5 * m.craterSmoke);
}

/** A small square of colour on the grid. */
function speck(ctx: CanvasRenderingContext2D, x: number, y: number, g: Grid, n = 1): void {
  const s = g.p * n;
  ctx.fillRect((Math.round((x * g.dpr) / g.p) * g.p) / g.dpr, (Math.round((y * g.dpr) / g.p) * g.p) / g.dpr, s / g.dpr, s / g.dpr);
}

const src: SmokeSource = { x: 0, y: 0, vx: 0, vy: 0, turn: 0, calm: 0, n: 3, lifeMs: 2000, r0: 1, r1: 3, dark: 0, alpha: 1, u: 1, wind: 1, rise: 1, seed: 0 };

/**
 * A fresh crater burning: tongues of flame going out one by one, embers outlasting them, the fires' light on the earth
 * and smoke rising from each fire and drifting off, thinning to grey wisps after the fires are out.
 */
function drawFires(ctx: CanvasRenderingContext2D, c: CraterDraw, m: MotionParams, g: Grid, cells: number, fade: number): void {
  const rt = c.radiusPx / Math.max(0.01, c.zoom);
  const burn = burnShare(rt, m);
  const embersEnd = burn * 1.8;
  const smokeEnd = Math.min(0.8, burn * 2.6);
  const q = c.q;
  if (q >= smokeEnd) return;
  const big = clamp01((rt - 0.4) / 1.7);
  const clock = fireClock(q, sizeClass(rt), m);
  const mid = g.res < 1.5;
  const sd = c.seed * 977;
  const prev = ctx.globalAlpha;
  const nF = Math.max(1, Math.min(mid ? 2 : 5, Math.round(1 + big * 3 + (cells > 16 ? 1 : 0))));
  // how hard it burns overall: catching in the first moments, then dying down
  const catchUp = clamp01(q / 0.008);
  const I = clamp01(1 - q / burn) * catchUp;
  // the fires' warm light on the earth round them (from near zoom in: at mid zoom it is a pixel or two)
  if (I > 0.02 && !mid) drawBlob(ctx, 'glow', Math.max(2, cells * 0.9), Math.floor(sd) & 3, c.x, c.y, g, 0.32 * I * fade);
  // embers glowing in the pit and on the rim, flickering, cooling from orange to a dull red
  if (q < embersEnd) {
    const E = 1 - q / embersEnd;
    const n = mid ? 2 : Math.min(14, 3 + Math.round(cells * 0.5));
    const fl = Math.floor(clock / 140);
    for (let i = 0; i < n; i++) {
      if (!m.reduced && rnd(fl + i * 3, i) < 0.3) continue;
      const a = rnd(sd, i + 10) * Math.PI * 2;
      const d = cells * 0.7 * Math.sqrt(rnd(sd, i + 11));
      const hot = E * (0.6 + 0.4 * rnd(sd, i + 12));
      ctx.globalAlpha = prev * fade * Math.min(1, 0.4 + E);
      ctx.fillStyle = FIRE[hot > 0.7 ? 2 : hot > 0.45 ? 3 : hot > 0.2 ? 4 : 5];
      speck(ctx, c.x + Math.cos(a) * d * g.k, c.y + Math.sin(a) * d * g.k * 0.84, g);
    }
    ctx.globalAlpha = prev;
  }
  // smoke: a column from each fire while it burns, then grey wisps from the pit
  const S = clamp01(1 - q / smokeEnd);
  const smokeA = (0.78 + 0.25 * m.craterSmoke) * fade;
  // at mid zoom one column for the crater, from near zoom in one for each fire
  for (let i = 0; i < (mid ? 1 : nF); i++) {
    const end = burn * (0.55 + 0.45 * rnd(sd, i + 30));
    const Ii = clamp01(1 - q / end) * catchUp;
    const a = rnd(sd, i + 20) * Math.PI * 2;
    const d = cells * (i === 0 ? 0.12 : 0.2 + 0.5 * rnd(sd, i + 21));
    const fx = c.x + Math.cos(a) * d * g.k;
    const fy = c.y + Math.sin(a) * d * g.k * 0.84;
    src.x = fx;
    src.y = fy - g.k;
    src.n = mid ? 2 : 4;
    src.lifeMs = 2200 + 1000 * big;
    src.r0 = 1 + cells * 0.1;
    src.r1 = 2 + cells * (0.3 + 0.12 * big) + (mid ? 0 : 1);
    // dark and dense at the flame (oily soot), grey and thin only higher up; the first puffs climb straight up
    // before the wind takes them, so the column stands on its fire
    src.dark = 0.88 * Ii;
    src.alpha = Math.min(1, smokeA * Math.max(Ii, 0.45 * S) * (i === 0 ? 1 : 0.85));
    src.u = c.scale;
    src.wind = 1;
    src.rise = 1.2 + 0.4 * big;
    src.calm = 0.45;
    src.seed = rnd(sd, i + 31);
    if (src.alpha > 0.02 && (Ii > 0 || i === 0)) drawSmokeTrail(ctx, src, g, clock, m);
    src.calm = 0;
  }
  // the flames, over their smoke
  for (let i = 0; i < nF; i++) {
    const end = burn * (0.55 + 0.45 * rnd(sd, i + 30));
    const Ii = clamp01(1 - q / end) * catchUp;
    if (Ii <= 0.03) continue;
    const a = rnd(sd, i + 20) * Math.PI * 2;
    const d = cells * (i === 0 ? 0.12 : 0.2 + 0.5 * rnd(sd, i + 21));
    const r = Math.min(6, Math.max(0.6, cells * (i === 0 ? 0.19 : 0.08 + 0.1 * rnd(sd, i + 22)) * (0.35 + 0.65 * Ii)));
    drawFlame(ctx, c.x + Math.cos(a) * d * g.k, c.y + Math.sin(a) * d * g.k * 0.84, r, g, clock + i * 53, rnd(sd, i + 23), m, fade * Math.min(1, Ii * 3), 1);
  }
  ctx.globalAlpha = prev;
}

function draw(ctx: CanvasRenderingContext2D, c: CraterDraw, m: MotionParams): void {
  if (c.atom) return drawZone(ctx, c, m);
  // whole for the first part of its life, then weathering away
  const f = c.q < 0.55 ? 1 : 1 - (c.q - 0.55) / 0.45;
  if (f <= 0.02) return;
  const g = gridOf(c.scale, c.dpr);
  const prevA = ctx.globalAlpha;
  const prevS = ctx.imageSmoothingEnabled;
  ctx.imageSmoothingEnabled = false;
  const cells = c.radiusPx / g.k;
  if (c.zoom < 3 || cells < 2 || !canBake()) {
    // far out: a small dark scorch
    ctx.globalAlpha = prevA * 0.5 * f;
    ctx.fillStyle = SCORCH[1];
    const r = Math.max(1, Math.round(c.radiusPx));
    ctx.fillRect(Math.round(c.x - r), Math.round(c.y - r * 0.8), r * 2, Math.max(1, Math.round(r * 1.6)));
    ctx.fillRect(Math.round(c.x - r * 0.6), Math.round(c.y - r * 1.1), Math.round(r * 1.2), Math.max(1, Math.round(r * 2.2)));
  } else {
    let k = 1;
    while (cells / k > 60) k *= 2;
    const R = Math.round(cells / k);
    const v = Math.floor(c.seed * 4) & 3;
    const e = atlas.get(R * 4 + v, () => craterBitmap(R, v));
    if (e) {
      const cell = g.k * k;
      const x = (Math.round((c.x * g.dpr) / (g.p * k)) * g.p * k) / g.dpr;
      const y = (Math.round((c.y * g.dpr) / (g.p * k)) * g.p * k) / g.dpr;
      // weathered craters lighten as the scorch fades into the ground
      ctx.globalAlpha = prevA * f * (c.q < 0.3 ? 1 : 0.92);
      ctx.drawImage(e.page, e.sx, e.sy, e.w, e.h, x - e.ox * cell, y - e.oy * cell, e.w * cell, e.h * cell);
    }
    ctx.globalAlpha = prevA;
    drawFires(ctx, c, m, g, cells, f);
  }
  ctx.globalAlpha = prevA;
  ctx.imageSmoothingEnabled = prevS;
}

// ------------------------------------------------------------------------------------------------- the atom bomb

/** The atom bomb's blast zone, in crater radii (within CRATER_ATOM_REACH). */
export const ZONE = 3;
const zoneAtlas = new SpriteAtlas(1024, 3);

/**
 * The atom bomb's ground mark: radius `r` cells for the whole zone (8..96), shape `variant` (0..3), weathered `age`
 * (0 fresh .. 2 weathered). Origin at ground zero. Three tones that read at a glance: a pan of pale ash at ground zero
 * (lighter than the land round it, flecked with earth fused to dull olive glass), a band of black charred ground round
 * it, then long brown and black streaks running straight out from ground zero to a lobed edge, with blown-down rubble
 * lying along them. The edge is the ends of the streaks, not a dithered fringe. As it weathers the charred band and the
 * streaks go to ash before the zone fades; every age has the same outline, so they cross-fade.
 */
export function blastZoneBitmap(r: number, variant: number, age = 0): RGBABitmap {
  const R = Math.max(8, Math.min(96, Math.round(r)));
  const A = Math.max(0, Math.min(2, Math.round(age)));
  const sq = 0.84;
  const hw = Math.ceil(R * 1.12) + 2;
  const hh = Math.ceil(R * 1.12 * sq) + 2;
  const W = hw * 2 + 1;
  const H = hh * 2 + 1;
  const data = new Uint8ClampedArray(W * H * 4);
  const sd = variant * 29 + 7;
  const GL = GLASS.map(hex);
  const AS = ASH.map(hex);
  const ph = variant * 1.9 + 0.7;
  // lobes of scorch: a few broad directions where the zone reaches further
  const rays: [number, number, number][] = [];
  const nr = 4 + variant;
  for (let i = 0; i < nr; i++) rays.push([rnd(sd, i) * Math.PI * 2, 0.04 + 0.08 * rnd(sd, i + 50), 0.2 + 0.16 * rnd(sd, i + 60)]);
  const reachAt = (a: number): number => {
    let v = 0;
    for (const [ra, len, wd] of rays) {
      const d = Math.abs((((a - ra) % (Math.PI * 2)) + Math.PI * 3) % (Math.PI * 2) - Math.PI);
      const f = Math.max(0, 1 - d / wd);
      v = Math.max(v, len * f * f * (3 - 2 * f));
    }
    return v;
  };
  // the tones as it weathers: fresh black char and brown and black streaks, then greyer, then ash
  const charT = [
    [SC[0], SC[1], SC[0], SC[2]],
    [SC[2], SC[3], SC[1], SC[3]],
    [AS[0], SC[4], SC[3], AS[0]],
  ][A];
  const streakDark = [SC[0], SC[2], SC[4]][A];
  const streakMid = [SC[3], SC[4], AS[0]][A];
  const streakLight = [SC[5], SC[5], AS[1]][A];
  const set = (x: number, y: number, c: readonly number[], a: number): void => {
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    const o = (y * W + x) * 4;
    data[o] = c[0];
    data[o + 1] = c[1];
    data[o + 2] = c[2];
    data[o + 3] = a;
  };
  const gs = Math.max(0.12, Math.min(0.5, 6 / R));
  // the streaks' angular fineness: about one streak every 2 to 3 cells round the charred band, whatever the size
  const sf = Math.max(7, R * 0.3);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const dx = x - hw;
      const dy = (y - hh) / sq;
      const a = Math.atan2(dy, dx);
      const d = Math.hypot(dx, dy) / R;
      // a lobed edge: two big swells round the zone, the broad rays and a little noise
      const edge = 0.84 + 0.07 * Math.sin(3 * a + ph) + 0.05 * Math.sin(5 * a + ph * 2.1) + 0.06 * (ringNoise(a, 1.7, sd) - 0.5) + reachAt(a);
      if (d > Math.min(1.1, edge * 1.22)) continue;
      const dith = BAYER[(x & 1) + ((y & 1) << 1)];
      const grain = hash2(x, y, sd);
      const clump = vnoise(x * gs + variant * 3.3, y * gs, sd + 3);
      // streaks: noise round a circle (it changes with the angle, so it runs straight out from ground zero), broken
      // into long dashes along their length
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      const fine = vnoise(ca * sf + 3.1, sa * sf + 5.3, sd + 9) * 0.7 + vnoise(ca * sf * 2.2 + 1.3, sa * sf * 2.2 + 2.9, sd + 11) * 0.3;
      const dash = vnoise(ca * sf * 0.5 + d * 5, sa * sf * 0.5 + 7.7, sd + 13);
      const streak = fine * 0.8 + dash * 0.2;
      // each streak its own length: some stop short, some run past the lobes
      const reach = edge * (0.8 + 0.42 * vnoise(ca * sf * 0.7 + 9.9, sa * sf * 0.7 + 1.1, sd + 15));
      // ground zero: a pan of pale ash with its edge wandering round it
      const pan = 0.25 * (1 + 0.3 * (ringNoise(a, 2.6, sd + 5) - 0.5) + (clump - 0.5) * 0.25);
      if (d < pan) {
        const q = d / pan;
        const glassy = clump * 0.7 + grain * 0.35 + q * 0.08;
        if (glassy > 0.94) set(x, y, GL[grain > 0.93 ? 2 : grain > 0.6 ? 1 : 0], 255);
        else {
          // palest in the middle, darkening a little toward its edge, mottled
          const t = 3.4 - q * 1.6 - (clump - 0.5) * 1.6 + dith * 0.8 + (q > 0.85 ? -1 : 0);
          set(x, y, AS[Math.max(0, Math.min(3, Math.floor(t)))], 255);
        }
        continue;
      }
      // the charred band round the pan, its outer edge wandering and running out along the streaks
      const band = pan + 0.24 + 0.1 * (ringNoise(a, 3.1, sd + 7) - 0.5) + (streak - 0.5) * 0.18;
      if (d < band) {
        const t = (d - pan) / Math.max(0.05, band - pan);
        const k = clump * 1.6 + grain * 0.6 + dith * 0.5 + (t < 0.12 ? 0.9 : 0);
        set(x, y, charT[Math.max(0, Math.min(3, Math.floor(k)))], 255);
        continue;
      }
      if (d > reach) continue;
      // past the band: the streaks, thinning out as they go (fewer and narrower toward their ends)
      const t = (d - band) / Math.max(0.05, reach - band);
      const thr = 0.46 + 0.16 * t;
      if (streak > thr) {
        const s2 = (streak - thr) / (1 - thr);
        set(x, y, s2 > 0.28 ? streakDark : s2 > 0.1 ? streakMid : streakLight, Math.round(255 - 60 * t));
        continue;
      }
      // between the streaks near the band: singed ground in clumps (not a dither), gone further out
      if (t < 0.28 * clump + 0.06 && grain > 0.12) set(x, y, streakMid, 210);
    }
  }
  // blown-down rubble: dashes lying along the blast's path, out across the streaks
  const n = Math.round(R * 1.1);
  for (let i = 0; i < n; i++) {
    const a = rnd(sd + 100, i) * Math.PI * 2;
    const d = R * (0.5 + 0.32 * rnd(sd + 101, i) ** 0.8);
    const len = 1 + Math.round(rnd(sd + 102, i) * (R > 40 ? 2 : 1));
    const c = Math.cos(a);
    const s = Math.sin(a);
    for (let j = 0; j <= len; j++) set(Math.round(hw + c * (d + j)), Math.round(hh + s * (d + j) * sq), j === len && rnd(i, j) > 0.5 ? streakLight : streakDark, 255);
  }
  return { w: W, h: H, ox: hw, oy: hh, data };
}

/** The zone's fires burn in clumps (a few fires each, mixed sizes), not dotted evenly over it. */
const CLUMPS = 6;
const PER_CLUMP = 4;

/**
 * The atom bomb's blast zone on the map: the scorched ground (baked, three tones), ground zero white hot for a moment,
 * then glowing red and cooling, fires burning in clumps over the zone and going out one by one (the outer ones last),
 * a column of smoke from each clump and a thin pall drifting off downwind, clear of the zone; as it ages the charred
 * ground weathers to ash, then the whole mark fades.
 */
function drawZone(ctx: CanvasRenderingContext2D, c: CraterDraw, m: MotionParams): void {
  const q = c.q;
  const fade = q < 0.72 ? 1 : 1 - smoothstep((q - 0.72) / 0.28);
  if (fade <= 0.01) return;
  const g = gridOf(c.scale, c.dpr);
  const prevA = ctx.globalAlpha;
  const prevS = ctx.imageSmoothingEnabled;
  ctx.imageSmoothingEnabled = false;
  const cells = c.radiusPx / g.k;
  const Z = cells * ZONE;
  // weathering: the charred ground goes to ash over the middle of its life
  const wear = 2 * smoothstep((q - 0.22) / 0.45);
  if (c.zoom < 3 || Z < 8 || !canBake()) {
    // far out: a wide dark scorch with a pale middle, in steps
    for (const [f, a, col] of [[1, 0.26, SCORCH[1]], [0.6, 0.35, SCORCH[0]], [0.27, 0.6, ASH[2]]] as const) {
      const r = Math.max(1, Math.round(c.radiusPx * ZONE * f));
      ctx.globalAlpha = prevA * a * fade;
      ctx.fillStyle = col;
      ctx.fillRect(Math.round(c.x - r), Math.round(c.y - r * 0.6), r * 2, Math.max(1, Math.round(r * 1.2)));
      ctx.fillRect(Math.round(c.x - r * 0.7), Math.round(c.y - r * 0.84), Math.round(r * 1.4), Math.max(1, Math.round(r * 1.68)));
    }
    ctx.globalAlpha = prevA;
    ctx.imageSmoothingEnabled = prevS;
    return;
  }
  // the zone in whole cells of one size or bigger, its radius in steps of four cells (it bakes a few sizes, not one
  // per zoom step; a step is under 5% of its width)
  const k = Math.max(1, Math.ceil(Z / 90));
  const Rz = Math.max(8, Math.round(Z / k / 4) * 4);
  const v = Math.floor(c.seed * 4) & 3;
  const cell = g.k * k;
  const x = (Math.round((c.x * g.dpr) / (g.p * k)) * g.p * k) / g.dpr;
  const y = (Math.round((c.y * g.dpr) / (g.p * k)) * g.p * k) / g.dpr;
  // the two ages either side of its weathering, the older laid over the younger (same outline: a cross-fade)
  const a0 = Math.min(2, Math.floor(wear));
  const fr = wear - a0;
  for (const [age, al] of [[a0, 1], [a0 + 1, fr]] as const) {
    if (age > 2 || al <= 0.02) continue;
    const e = zoneAtlas.get((Rz * 4 + v) * 3 + age, () => blastZoneBitmap(Rz, v, age));
    if (!e) continue;
    ctx.globalAlpha = prevA * fade * al;
    ctx.drawImage(e.page, e.sx, e.sy, e.w, e.h, x - e.ox * cell, y - e.oy * cell, e.w * cell, e.h * cell);
  }
  ctx.globalAlpha = prevA;
  const sd = c.seed * 613;
  const clock = fireClock(q, 1, m);
  const mid = g.res < 1.5 && Z < 60;
  const pan = cells * ZONE * 0.25;
  // ground zero: white hot (held long enough to see), then glowing red, brighter than the fires round it, cooling
  const white = q < 0.05 ? 1 : clamp01(1 - (q - 0.05) / 0.04);
  const red = clamp01(1 - q / 0.36);
  if (red > 0) {
    const breathe = m.reduced ? 1 : 0.94 + 0.06 * Math.sin(clock / 260);
    const h = Math.min(1, 1.2 * red ** 0.8) * breathe * fade;
    drawBlob(ctx, 'heat', pan * (1.1 + 0.25 * red), Math.floor(sd) & 3, c.x, c.y, g, h);
    drawBlob(ctx, 'heat', pan * (0.7 + 0.2 * red), (Math.floor(sd) + 1) & 3, c.x, c.y, g, h);
    // its hottest middle stays orange and yellow a while longer
    drawBlob(ctx, 'glow', pan * (0.4 + 0.35 * red), (Math.floor(sd) + 2) & 3, c.x, c.y, g, Math.min(1, 1.1 * red ** 1.4) * breathe * fade);
  }
  if (white > 0) {
    drawBlob(ctx, 'glow', pan * 1.45, (Math.floor(sd) + 1) & 3, c.x, c.y, g, white);
    drawBlob(ctx, 'whiteHot', pan * 1.05, (Math.floor(sd) + 3) & 3, c.x, c.y, g, white);
  }
  // the fires: clumps of two to four (one bigger, the rest small) out over the zone; the outer clumps burn longest
  const nC = mid ? 4 : CLUMPS;
  const burn = (0.16 + 0.3 * 1) * (0.75 + 0.5 * m.craterSmoke);
  const smokeA = (0.6 + 0.3 * m.craterSmoke) * fade;
  const P = clamp01(1 - q / (burn * 1.3));
  // a thin pall drifting off downwind, clear of the zone, while it burns
  if (P > 0) {
    src.vx = 0;
    src.vy = 0;
    src.turn = 0;
    src.calm = 0;
    src.u = c.scale;
    for (let i = 0; i < 2; i++) {
      src.x = c.x + Z * (0.55 + 0.25 * i) * g.k;
      src.y = c.y - Z * (0.2 + 0.25 * rnd(sd, i + 200)) * g.k;
      src.n = mid ? 3 : 4;
      src.lifeMs = 5200;
      src.r0 = Z * 0.07;
      src.r1 = Z * 0.15;
      src.dark = 0.3 * P;
      src.alpha = smokeA * 0.42 * P;
      src.wind = 1.7;
      src.rise = 1.2;
      src.seed = rnd(sd, i + 201);
      drawSmokeTrail(ctx, src, g, clock, m);
    }
  }
  for (let ci = 0; ci < nC; ci++) {
    const ca = ((ci + 0.7 * rnd(sd, ci)) / nC) * Math.PI * 2;
    const ct = 0.36 + 0.5 * rnd(sd, ci + 40);
    const cx = c.x + Math.cos(ca) * ct * Z * g.k;
    const cy = c.y + Math.sin(ca) * ct * Z * g.k * 0.84;
    // the outer clumps burn longest (the middle was blown out); each catches a moment after the flash
    const end = burn * (0.45 + 0.55 * rnd(sd, ci + 80)) * (0.55 + 0.6 * ct);
    const I = clamp01(1 - q / end) * clamp01((q - 0.006 * rnd(sd, ci + 90)) / 0.012);
    // a column of smoke from the clump, dark at its foot, rising before the wind takes it
    if (I > 0.02 || q < burn * 1.3) {
      src.x = cx;
      src.y = cy - g.k;
      src.vx = 0;
      src.vy = 0;
      src.turn = 0;
      src.calm = 0.5;
      src.n = mid ? 2 : 4;
      src.lifeMs = 2600;
      src.r0 = 1 + cells * 0.07;
      src.r1 = 2 + cells * 0.24;
      src.dark = 0.75 * I;
      src.alpha = Math.min(0.95, smokeA * 1.2 * Math.max(I, 0.3 * P));
      src.wind = 1.2;
      src.rise = 1.3;
      src.seed = rnd(sd, ci + 120);
      if (src.alpha > 0.02) drawSmokeTrail(ctx, src, g, clock, m);
      src.calm = 0;
    }
    if (I <= 0.03) continue;
    const nf = mid ? 2 : 2 + Math.floor(rnd(sd, ci + 60) * 3);
    for (let j = 0; j < nf; j++) {
      const off = j === 0 ? 0 : (1.2 + 1.8 * rnd(sd, ci * 7 + j)) * Math.max(1, cells / 14);
      const oa = rnd(sd, ci * 7 + j + 30) * Math.PI * 2;
      const fx = cx + Math.cos(oa) * off * g.k;
      const fy = cy + Math.sin(oa) * off * g.k * 0.6;
      // one fire in the clump big, the rest small, each dying at its own time
      const Ij = clamp01(1 - q / (end * (j === 0 ? 1 : 0.6 + 0.35 * rnd(sd, ci * 7 + j + 50))));
      if (Ij <= 0.03) continue;
      const big = j === 0 ? 1.7 + 0.8 * rnd(sd, ci + 140) : 0.6 + 0.6 * rnd(sd, ci * 7 + j + 140);
      const r = Math.max(0.7, big * Math.max(1, cells / 16) * (0.4 + 0.6 * Ij) * (I > 0 ? 1 : 0));
      drawFlame(ctx, fx, fy, r, g, clock + ci * 41 + j * 97, rnd(sd, ci * 7 + j + 150), m, fade * Math.min(1, Ij * 3), 1);
    }
  }
  ctx.globalAlpha = prevA;
  ctx.imageSmoothingEnabled = prevS;
}

const smoothstep = (t: number): number => {
  const k = clamp01(t);
  return k * k * (3 - 2 * k);
};

export const detailedCraters: CraterArt = { draw };
