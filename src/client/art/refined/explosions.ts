// The refined style's explosions (client only): short pixel flipbooks with one 5-step ramp (white, yellow, orange,
// red, smoke grey) for every size: a near-white flash, a yellow to orange fireball with a hot rim, a thin bright ring
// running past it, the fireball darkening to red, then a grey smoke puff, with a few dark debris specks flung out. Sizes
// by kind: a shell, a bomb (one of a stick), a missile (big, with a ring and a short smoke column), the atom bomb (a
// flash, a huge fireball, a shockwave ring and a mushroom cloud that rises and fades), a splash on water (a white
// column, spray and a foam ring). Reduced motion: a still burst, no flipbook.
//
// Also the aftermath of the map's event layer (fx/layer.ts): a ship sinking (foam rings, spray, dark pieces going
// under), a plane going down (grey puffs rising and drifting) and dust (earth after shells; a heavier ring when a fort
// comes down).
import type { MotionParams } from '../motion';
import { rnd } from '../shared/noise';
import { pixelDisc, pixelRing, sparseRing } from '../shared/pixel';
import type { BlastDraw, BlastKind, ExplosionArt, MapFxDraw } from '../types';
import { DEBRIS, EMBER, FOAM, FOAM_DIM, ORANGE, puff, RED, smokeAdd, smokeDraw, smokeReset, WHITE, YELLOW } from './fxCommon';

/** What a blast frame needs: its kind, the sim's blast radius in tiles (missile, atom) and its own look (0..1). */
type BlastLike = Pick<BlastDraw, 'kind' | 'rt' | 'seed'>;

interface BlastSpec {
  /** fireball radius in art px at pixel size 1 */
  r: number;
  dur: number;
  debris: number;
  ring: boolean;
  /** smoke puffs at the end */
  smoke: number;
}
const SPEC: Record<BlastKind, BlastSpec> = {
  shell: { r: 5, dur: 460, debris: 3, ring: true, smoke: 2 },
  bomb: { r: 6, dur: 560, debris: 4, ring: true, smoke: 3 },
  hit: { r: 6, dur: 560, debris: 5, ring: true, smoke: 3 },
  air: { r: 4, dur: 480, debris: 5, ring: false, smoke: 2 },
  missile: { r: 10, dur: 760, debris: 7, ring: true, smoke: 4 },
  atom: { r: 26, dur: 2800, debris: 10, ring: true, smoke: 6 },
  splash: { r: 4, dur: 560, debris: 0, ring: true, smoke: 0 },
  flak: { r: 3, dur: 420, debris: 2, ring: false, smoke: 2 },
};


/**
 * One explosion frame. Time `t` 0..1 is cut into a flipbook (6 frames; the atom bomb 14), so the motion steps like
 * pixel art. Sizes are in cells of `g` px (the sprites' pixel size); missiles and atom bombs also grow with the blast.
 */
function drawBlast(ctx: CanvasRenderingContext2D, b: BlastLike, x: number, y: number, t: number, z: number, g: number, reduced: boolean): void {
  if (b.kind === 'atom') {
    drawAtom(ctx, b, x, y, t, z, g, reduced);
    return;
  }
  if (b.kind === 'splash') {
    drawSplash(ctx, b, x, y, t, g);
    return;
  }
  const spec = SPEC[b.kind];
  let R = spec.r;
  if (b.kind === 'missile') R = Math.max(R, Math.min(26, (b.rt * z * 0.34) / g));
  else if (b.kind === 'bomb') R = Math.max(R, Math.min(12, (1.4 * z) / g));
  // planes burst in the air: a little above their shadow
  const yy = b.kind === 'air' ? y - 4 * g : y;
  const frames = 6;
  let f = Math.min(frames - 1, Math.floor(t * frames));
  if (reduced) f = t < 0.5 ? 1 : 4;
  const s = b.seed;
  const cell = (k: number): number => k * g;
  ctx.globalAlpha = 1;
  // debris: dark specks flung out (hot on the first frames), falling a little
  if (spec.debris && f >= 1 && f <= 4 && !reduced) {
    const d = R * (0.5 + f * 0.35);
    ctx.fillStyle = f <= 1 ? ORANGE : DEBRIS;
    for (let i = 0; i < spec.debris; i++) {
      const a = rnd(s, i) * Math.PI * 2;
      const dd = d * (0.7 + 0.5 * rnd(s, i + 9));
      const fall = b.kind === 'air' ? f * f * 0.8 : f * f * 0.35;
      // specks of 2 to 3 px, shrinking as they fly
      const sz = (b.kind === 'missile' && f <= 2 ? 3 : f >= 4 ? 1 : 2) * g;
      ctx.fillRect(Math.round((x + Math.cos(a) * cell(dd)) / g) * g, Math.round((yy + Math.sin(a) * cell(dd) * 0.8 + cell(fall)) / g) * g, sz, sz);
    }
  }
  switch (f) {
    case 0: {
      // the flash: a near-white core with a yellow edge and four short rays
      ctx.fillStyle = YELLOW;
      pixelDisc(ctx, x, yy, R * 0.6, g);
      ctx.fillStyle = WHITE;
      pixelDisc(ctx, x, yy, R * 0.42, g);
      const ray = Math.round(R * 0.9);
      ctx.fillRect(Math.round(x / g) * g - ray * g, Math.round(yy / g) * g, (ray * 2 + 1) * g, g);
      ctx.fillRect(Math.round(x / g) * g, Math.round(yy / g) * g - ray * g, g, (ray * 2 + 1) * g);
      break;
    }
    case 1:
    case 2: {
      // the fireball: orange with a yellow and white core toward the light, a hot yellow rim on the top left
      const r = R * (f === 1 ? 0.85 : 1);
      ctx.fillStyle = f === 1 ? ORANGE : RED;
      pixelDisc(ctx, x + g, yy + g, r, g);
      ctx.fillStyle = ORANGE;
      pixelDisc(ctx, x, yy, r, g);
      ctx.fillStyle = YELLOW;
      pixelDisc(ctx, x - cell(r * 0.18), yy - cell(r * 0.2), r * 0.62, g);
      ctx.fillStyle = WHITE;
      pixelDisc(ctx, x - cell(r * 0.25), yy - cell(r * 0.28), r * (f === 1 ? 0.34 : 0.2), g);
      if (spec.ring) {
        ctx.fillStyle = f === 1 ? WHITE : '#fff1b8';
        pixelRing(ctx, x, yy, r * (f === 1 ? 1.25 : 1.7), g, f === 2);
      }
      break;
    }
    case 3: {
      // darkening to red, the ring breaking up far out, first smoke on top
      ctx.fillStyle = EMBER;
      pixelDisc(ctx, x + g, yy + g, R * 0.85, g);
      ctx.fillStyle = RED;
      pixelDisc(ctx, x, yy, R * 0.85, g);
      ctx.fillStyle = ORANGE;
      pixelDisc(ctx, x - cell(R * 0.15), yy - cell(R * 0.15), R * 0.5, g);
      if (spec.ring) {
        ctx.globalAlpha = 0.6;
        ctx.fillStyle = '#fff1b8';
        pixelRing(ctx, x, yy, R * 2.1, g, true);
        ctx.globalAlpha = 1;
      }
      puff(ctx, x + cell(R * 0.3), yy - cell(R * 0.6), R * 0.45, g);
      break;
    }
    default: {
      // smoke rising and drifting as one soft mass, embers underneath, then thinning out
      const k = f - 4;
      ctx.globalAlpha = 1;
      if (k === 0) {
        ctx.fillStyle = RED;
        pixelDisc(ctx, x, yy, R * 0.35, g);
      }
      smokeReset();
      const n = Math.max(1, spec.smoke);
      for (let i = 0; i < n; i++) {
        const a = rnd(s, i + 20) * Math.PI * 2;
        const d = R * (0.15 + 0.3 * rnd(s, i + 30));
        const px = x + Math.cos(a) * cell(d) + cell(k * 1.5);
        const py = yy + Math.sin(a) * cell(d) * 0.6 - cell(R * (0.45 + 0.3 * k));
        smokeAdd(px, py, R * (0.42 + 0.14 * k) * (0.85 + 0.3 * rnd(s, i + 40)));
      }
      if (b.kind === 'missile') {
        // a short smoke column over the impact, its puffs overlapping so it reads as one rising plume
        for (let i = 0; i < 4; i++) smokeAdd(x + cell(k + Math.sin(i * 2.1 + s * 6) * R * 0.08), yy - cell(R * (0.9 + i * 0.36 + k * 0.4)), R * (0.36 + 0.04 * i));
      }
      smokeDraw(ctx, g, k === 0 ? 1 : 0.7);
      ctx.globalAlpha = 1;
    }
  }
}

/**
 * A splash on water: a white column thrown up (lit on its left, shaded on its right), spray droplets falling back
 * out of it, and a foam ring spreading on the water and breaking up. Five frames.
 */
function drawSplash(ctx: CanvasRenderingContext2D, b: BlastLike, x: number, y: number, t: number, g: number): void {
  const f = Math.min(4, Math.floor(t * 5));
  const X = Math.round(x / g) * g;
  const Y = Math.round(y / g) * g;
  // the foam ring on the water first (the column stands in front of it)
  ctx.globalAlpha = f >= 3 ? 0.55 : 0.9;
  ctx.fillStyle = f >= 2 ? FOAM_DIM : FOAM;
  pixelRing(ctx, x, y, 1.6 + f * 1.15, g, f >= 3);
  if (f <= 2) {
    // the column: 3 cells wide, rising then falling back; a wider foot
    const hgt = [4, 7, 4][f];
    ctx.globalAlpha = 1;
    ctx.fillStyle = FOAM;
    ctx.fillRect(X - g, Y - hgt * g, g * 3, hgt * g);
    ctx.fillRect(X - 2 * g, Y - g, g * 5, g * 2);
    ctx.fillStyle = FOAM_DIM;
    ctx.fillRect(X + g, Y - hgt * g + g, g, hgt * g);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(X - g, Y - hgt * g, g, g);
    if (f === 1) {
      // the top breaking into two droplets
      ctx.fillStyle = FOAM;
      ctx.fillRect(X - 2 * g, Y - (hgt + 2) * g, g, g);
      ctx.fillRect(X + 2 * g, Y - (hgt + 1) * g, g, g);
    }
  }
  if (f >= 1) {
    // spray: droplets thrown out and falling back
    ctx.globalAlpha = f >= 3 ? 0.6 : 1;
    ctx.fillStyle = FOAM;
    for (let i = 0; i < 6; i++) {
      const a = rnd(b.seed, i) * Math.PI * 2;
      const d = 1.5 + f * 1.1 + rnd(b.seed, i + 7);
      const up = f === 1 ? 4 : f === 2 ? 3 : f === 3 ? 1 : 0;
      ctx.fillRect(Math.round((x + Math.cos(a) * d * g) / g) * g, Math.round((y + Math.sin(a) * d * g * 0.6 - up * g) / g) * g, g, g);
    }
  }
  ctx.globalAlpha = 1;
}

/** The atom bomb: flash, fireball, two rings, then a mushroom cloud rising on its column and fading. */
function drawAtom(ctx: CanvasRenderingContext2D, b: BlastLike, x: number, y: number, t: number, z: number, g0: number, reduced: boolean): void {
  // the blast is big on screen: coarser cells keep it chunky and cheap
  const R = Math.max(18, Math.min(220, b.rt * z * 0.45));
  const g = Math.max(g0, Math.round(R / 22));
  const r = R / g;
  const n = 14;
  let f = Math.min(n - 1, Math.floor(t * n));
  if (reduced) f = t < 0.3 ? 2 : 8;
  const cell = (k: number): number => k * g;
  if (f <= 1) {
    ctx.globalAlpha = f === 0 ? 0.9 : 0.6;
    ctx.fillStyle = WHITE;
    pixelDisc(ctx, x, y, r * (f === 0 ? 1.3 : 1.6), g);
    ctx.globalAlpha = 1;
    ctx.fillStyle = '#ffffff';
    pixelDisc(ctx, x, y, r * 0.7, g);
    return;
  }
  // one white shockwave ring running out and breaking into dots as it grows, and one faint follow ring
  if (f <= 7) {
    const rr = r * (1.1 + (f - 2) * 0.5);
    ctx.globalAlpha = 1 - (f - 2) / 7;
    ctx.fillStyle = WHITE;
    if (f <= 3) pixelRing(ctx, x, y, rr, g);
    else sparseRing(ctx, x, y, rr, g, f <= 5 ? 2 : 3);
    if (f >= 4) {
      ctx.globalAlpha = 0.22 * (1 - (f - 4) / 4);
      pixelRing(ctx, x, y, rr * 0.72, g, true);
    }
    ctx.globalAlpha = 1;
  }
  // the column and the cap rise from frame 4; the fireball shrinks into the cap
  const rise = Math.max(0, f - 3) / (n - 4);
  const fade = f >= n - 4 ? 1 - (f - (n - 4)) / 4 : 1;
  ctx.globalAlpha = fade;
  if (f >= 4) {
    const top = r * (0.6 + 1.6 * rise);
    // the column: close, overlapping puffs (one mass, a little wavy), narrowing toward the cap
    smokeReset();
    for (let i = 0; i < 7; i++) {
      const h = (i / 6) * top;
      smokeAdd(x + cell(Math.sin(i * 1.3 + b.seed * 5) * r * 0.05), y - cell(h), r * (0.3 - i * 0.012));
    }
    smokeDraw(ctx, g, fade);
    // the cap glows on its underside early on: a red and orange crescent under the cap, its top hidden by the puffs
    const cy = y - cell(top + r * 0.3);
    if (f <= 8) {
      ctx.globalAlpha = fade;
      ctx.fillStyle = f <= 6 ? RED : EMBER;
      pixelDisc(ctx, x, cy + cell(r * 0.62), r * 0.46, g);
      ctx.fillStyle = f <= 6 ? ORANGE : RED;
      pixelDisc(ctx, x - cell(r * 0.05), cy + cell(r * 0.52), r * 0.36, g);
    }
    // the cap: a ring of puffs round a big top puff, drawn as one mass
    for (let i = 0; i < 7; i++) {
      const a = (i / 7) * Math.PI * 2;
      smokeAdd(x + Math.cos(a) * cell(r * 0.6), cy + Math.sin(a) * cell(r * 0.28), r * 0.42);
    }
    smokeAdd(x, cy - cell(r * 0.15), r * 0.5);
    smokeDraw(ctx, g, fade);
    ctx.globalAlpha = fade;
  }
  if (f <= 7) {
    // the fireball: lumpy orange edge, a red rim on the lower right, orange body, the hot side yellow and white
    // toward the light; it cools to red and sinks into the column
    const fr = r * (f <= 3 ? 1 : 1 - (f - 3) * 0.16);
    const hot = f <= 4;
    ctx.fillStyle = hot ? ORANGE : RED;
    for (let i = 0; i < 9; i++) {
      const a = (i / 9) * Math.PI * 2 + b.seed * 6;
      pixelDisc(ctx, x + Math.cos(a) * cell(fr * 0.92), y + Math.sin(a) * cell(fr * 0.92), fr * (0.2 + 0.08 * rnd(b.seed, i)), g);
    }
    ctx.fillStyle = hot ? RED : EMBER;
    pixelDisc(ctx, x + g, y + g, fr, g);
    ctx.fillStyle = hot ? ORANGE : RED;
    pixelDisc(ctx, x, y, fr, g);
    ctx.fillStyle = hot ? YELLOW : ORANGE;
    pixelDisc(ctx, x - cell(fr * 0.14), y - cell(fr * 0.16), fr * 0.7, g);
    if (f <= 5) {
      ctx.fillStyle = f <= 3 ? WHITE : YELLOW;
      pixelDisc(ctx, x - cell(fr * 0.3), y - cell(fr * 0.32), fr * 0.34, g);
    }
  }
  ctx.globalAlpha = 1;
}

// ------------------------------------------------------------------------------------------------- aftermath

const TAU = Math.PI * 2;
const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
const easeOut = (t: number): number => 1 - (1 - t) * (1 - t);
const fract = (v: number): number => v - Math.floor(v);
/** A repeatable 0..1 spray direction for frame f, droplet j of the effect at x. */
function fx(f: number, j: number, x: number): number {
  return fract(Math.sin(f * 3.1 + j * 12.9898 + x * 0.37) * 43758.5453);
}

/** A sinking ship, a falling plane's smoke or dust, at (f.x, f.y), `t` 0..1 of its life. */
function drawMapFx(ctx: CanvasRenderingContext2D, f: MapFxDraw): void {
  const { x, y, t } = f;
  const z = f.zoom;
  // size scale for the small effects: readable zoomed out, not huge zoomed in
  const k = Math.min(1.6, Math.max(0.7, z / 8));
  switch (f.kind) {
    case 'splash': {
      // a ship sinking (pixel style, fx/pixelFx.ts): foam rings spreading, spray, dark hull pieces going under
      const g = z < 11 ? 1 : 2;
      const fr = Math.min(5, Math.floor(t * 6));
      ctx.globalAlpha = 0.85 * (1 - t);
      ctx.fillStyle = fr < 2 ? '#ffffff' : '#dcebf3';
      pixelRing(ctx, x, y, (3 + fr * 2.2) * k, g, fr >= 3);
      if (fr >= 1) pixelRing(ctx, x, y, (1.5 + fr * 1.2) * k, g, fr >= 4);
      if (fr <= 2) {
        for (let j = 0; j < 5; j++) {
          const a = j * 1.26 + 6.283 * fx(fr, j, x);
          const d = (3 + fr * 3) * k;
          ctx.fillRect(Math.round((x + Math.cos(a) * d) / g) * g, Math.round((y + Math.sin(a) * d * 0.6 - (fr === 1 ? 3 : 1) * g) / g) * g, g, g);
        }
      }
      const sink = 1 - easeOut(t);
      if (sink > 0.08) {
        ctx.globalAlpha = 0.9 * sink;
        ctx.fillStyle = '#343a42';
        for (let j = 0; j < 3; j++) {
          const a = j * 2.1 + x * 0.1;
          const d = (3 + 6 * easeOut(t)) * k;
          const w = Math.max(1, Math.round((3 - j) * sink * k));
          ctx.fillRect(Math.round(x + Math.cos(a) * d) - w * g, Math.round(y + Math.sin(a) * d * 0.7), w * 2 * g, g);
        }
      }
      ctx.globalAlpha = 1;
      break;
    }
    case 'smoke': {
      // a plane going down: grey pixel puffs rising and drifting off (the burst itself is fx/pixelFx.ts)
      const g = z < 11 ? 1 : 2;
      for (let j = 0; j < 4; j++) {
        const tj = clamp01((t - j * 0.08) / 0.92);
        if (tj <= 0) continue;
        const a = j * 1.7 + x * 0.05;
        const r = (1.5 + 2.5 * easeOut(tj)) * k;
        const px = x + Math.cos(a) * 4 * k + tj * 8 * k;
        const py = y + Math.sin(a) * 3 * k - tj * 12 * k;
        ctx.globalAlpha = 0.6 * (1 - tj);
        ctx.fillStyle = '#5f5c59';
        pixelDisc(ctx, px + g, py + g, r, g);
        ctx.fillStyle = '#8f8b86';
        pixelDisc(ctx, px, py, r - 0.6, g);
      }
      ctx.globalAlpha = 1;
      break;
    }
    case 'dust':
    case 'fortDust': {
      // earth thrown up after shells or a fort coming down: brown pixel puffs settling
      const fort = f.kind === 'fortDust';
      const g = z < 11 ? 1 : 2;
      const n = fort ? 7 : 4;
      const spread = fort ? Math.max(10, z * 1.2) : Math.max(10, f.rt * z * 0.55);
      for (let j = 0; j < n; j++) {
        const tj = clamp01((t - (fort ? 0 : 0.25 + j * 0.06)) / (fort ? 1 : 0.7));
        if (tj <= 0) continue;
        const a = f.seed * TAU + (j * TAU) / n;
        const d = fort ? spread * (0.4 + 0.9 * easeOut(tj)) : spread * (0.3 + 0.6 * fract(f.seed * 7 + j * 0.37));
        const r = (fort ? 2 + 3 * easeOut(tj) : 1.5 + 2.5 * easeOut(tj)) * k;
        const px = x + Math.cos(a) * d;
        const py = y + Math.sin(a) * d * 0.75 - tj * 3 * k;
        ctx.globalAlpha = (fort ? 0.55 : 0.4) * (1 - tj) * (1 - tj);
        ctx.fillStyle = '#7d6a52';
        pixelDisc(ctx, px + g, py + g, r, g);
        ctx.fillStyle = '#b09c7c';
        pixelDisc(ctx, px, py, r - 0.6, g);
      }
      ctx.globalAlpha = 1;
      if (fort && t < 0.4) {
        const td = t / 0.4;
        ctx.fillStyle = `rgba(90,80,66,${(0.9 * (1 - td)).toFixed(3)})`;
        for (let j = 0; j < 6; j++) {
          const a = f.seed * 3 + j * 1.05;
          const d = 4 * k + 14 * k * td;
          ctx.fillRect(Math.round(x + Math.cos(a) * d) - 1, Math.round(y + Math.sin(a) * d - 8 * k * td * (1 - td)) - 1, 2, 2);
        }
      }
      break;
    }
  }
}

export const refinedExplosions: ExplosionArt = {
  durationMs: (kind: BlastKind, m: MotionParams) => SPEC[kind].dur * m.blastTime,
  draw(ctx: CanvasRenderingContext2D, b: BlastDraw, m: MotionParams): void {
    void m; // TODO(refined): smoke linger, lingering fire, debris and shockwave size from the motion preset
    drawBlast(ctx, b, b.x, b.y, b.t, b.zoom, b.scale, b.reduced);
  },
  drawMapFx(ctx: CanvasRenderingContext2D, f: MapFxDraw, m: MotionParams): void {
    void m;
    drawMapFx(ctx, f);
  },
};
