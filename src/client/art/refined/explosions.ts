// The refined style's explosions (client only): pixel flipbooks in one muted fire and smoke palette (palette.ts FX),
// built from lumpy blobs so nothing reads as a clean circle or a drawn ring:
//   - a short flash, then a ball of fire that is a cluster of smaller fireballs (white-hot core toward the light, an
//     ember rim on the lower right), cooling as it rises and turning into smoke;
//   - smoke that merges into one lit mass, rising and drifting downwind (black for burning ships and planes, browner
//     for earth thrown up by shells and bombs);
//   - debris and sparks thrown out on ballistic arcs, falling back;
//   - instead of a shockwave ring, a skirt of dust rolling out low along the ground (MotionParams.shockwave);
//   - after the burst: fire left burning at the spot (fireLinger) and the smoke staying and thinning (smokeLinger),
//     both inside the blast's own duration, so every preset is the same picture with a longer or shorter tail.
// The atom bomb: a blinding flash, a huge fireball, the base surge rolling out over the ground and the mushroom cloud
// rising on its stem, glowing underneath while it is young. A shell or bomb in water: a column of white water, spray
// falling back and foam spreading in patches. Flak: a black puff round a quick orange flash.
// Reduced motion: one still frame of the burst.
//
// Also the aftermath of the map's event layer (fx/layer.ts): a ship sinking (foam, bubbles, an oil slick and dark
// pieces going under), a plane going down (black smoke rising and drifting) and dust (earth after shells; heavier, with
// debris, when a fort comes down).
import type { MotionParams } from '../motion';
import { rnd } from '../shared/noise';
import type { BlastDraw, BlastKind, ExplosionArt, MapFxDraw } from '../types';
import { blob, debris, fireBall, foamPatch, FX, smokeAdd, smokeDraw, smokeReset } from './fxCommon';

interface BlastSpec {
  /** fireball radius in cells at pixel size 1 */
  r: number;
  /** the burst (ms, before MotionParams.blastTime) */
  dur: number;
  debris: number;
  /** puffs in the dust skirt (0 = none: in the air, on a ship) */
  dust: number;
  /** smoke puffs */
  smoke: number;
  /** black smoke (burning fuel) rather than brown (earth) */
  black: boolean;
  /** fire can keep burning at the spot afterwards */
  burns: boolean;
}
const SPEC: Record<BlastKind, BlastSpec> = {
  shell: { r: 4, dur: 520, debris: 5, dust: 5, smoke: 3, black: false, burns: true },
  bomb: { r: 5, dur: 640, debris: 6, dust: 6, smoke: 4, black: false, burns: true },
  hit: { r: 5, dur: 640, debris: 7, dust: 0, smoke: 4, black: true, burns: true },
  air: { r: 3.6, dur: 560, debris: 6, dust: 0, smoke: 3, black: true, burns: false },
  missile: { r: 9, dur: 900, debris: 9, dust: 8, smoke: 6, black: false, burns: true },
  atom: { r: 26, dur: 3200, debris: 10, dust: 12, smoke: 8, black: false, burns: false },
  splash: { r: 3, dur: 620, debris: 0, dust: 0, smoke: 0, black: false, burns: false },
  flak: { r: 2.6, dur: 560, debris: 3, dust: 0, smoke: 2, black: true, burns: false },
};

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
const easeOut = (t: number): number => 1 - (1 - t) * (1 - t);

/** The burst's own length (ms) at a preset. */
function burstMs(kind: BlastKind, m: MotionParams): number {
  return SPEC[kind].dur * m.blastTime;
}
/** What follows the burst (ms): fire left burning and the smoke staying on. */
function lingerMs(kind: BlastKind, m: MotionParams): number {
  const s = SPEC[kind];
  const fire = s.burns ? 1.7 * m.fireLinger : 0;
  const smoke = s.smoke ? 0.55 * Math.max(0, m.smokeLinger - 0.6) : 0;
  return s.dur * (kind === 'atom' ? smoke * 0.8 : fire + smoke);
}

/** What a blast frame needs. */
type BlastLike = Pick<BlastDraw, 'kind' | 'x' | 'y' | 'rt' | 'seed' | 'zoom' | 'scale' | 'ageMs' | 'durMs' | 't' | 'reduced'>;

function drawBlast(ctx: CanvasRenderingContext2D, b: BlastLike, m: MotionParams): void {
  const main = burstMs(b.kind, m);
  let age = b.ageMs >= 0 && b.durMs > 0 ? b.ageMs : b.t * (main + lingerMs(b.kind, m));
  if (b.reduced) age = main * 0.34;
  const prev = ctx.globalAlpha;
  ctx.globalAlpha = prev;
  if (b.kind === 'atom') atom(ctx, b, age, main, m);
  else if (b.kind === 'splash') splash(ctx, b, age / main, m);
  else if (b.kind === 'flak') flak(ctx, b, age / main, m);
  else burst(ctx, b, age, main, m);
  ctx.globalAlpha = prev;
}

/** The flipbook step of a 0..1 time: `n` frames, so the motion steps like pixel art. */
const step = (t: number, n: number): number => (Math.min(n - 1, Math.floor(t * n)) + 0.5) / n;

/**
 * A flame `r` cells wide at its foot (x, y): an ember bed, then tongues of fire narrowing upward and leaning a little,
 * yellow at the heart, never a ball.
 */
function flame(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, g: number, seed: number): void {
  if (r < 0.35) return;
  const hgt = Math.max(2, Math.round(r * 2.4));
  const lean = (rnd(seed, 1) - 0.5) * 0.6;
  ctx.fillStyle = FX.ember;
  blob(ctx, x, y, Math.max(0.5, r * 0.8), g, seed);
  for (let k = 0; k < hgt; k++) {
    const f = k / hgt;
    const w = Math.max(0, Math.round(r * (1 - f) * (0.9 + 0.3 * rnd(seed, k + 3))));
    const cx = Math.round((x + lean * k * g) / g) * g;
    const cy = Math.round((y - (k + 0.5) * g) / g) * g;
    ctx.fillStyle = f < 0.35 ? FX.fireDeep : FX.fire;
    ctx.fillRect(cx - w * g, cy, (w * 2 + 1) * g, g);
    if (w >= 1 && f < 0.7) {
      ctx.fillStyle = f < 0.3 ? FX.flame : FX.fire;
      ctx.fillRect(cx - Math.max(0, w - 1) * g, cy, (Math.max(0, w - 1) * 2 + 1) * g, g);
    }
  }
}

/** A shell, bomb, missile, ship or fort hit, or a plane bursting in the air. */
function burst(ctx: CanvasRenderingContext2D, b: BlastLike, age: number, main: number, m: MotionParams): void {
  const s = SPEC[b.kind];
  const g = b.scale;
  const z = b.zoom;
  let R = s.r;
  if (b.kind === 'missile') R = Math.max(R, Math.min(24, (b.rt * z * 0.3) / g));
  else if (b.kind === 'bomb') R = Math.max(R, Math.min(10, (1.2 * z) / g));
  const air = b.kind === 'air';
  const x = b.x;
  const y = air ? b.y - 4 * g : b.y;
  const seed = b.seed * 97;
  const t = step(clamp01(age / main), b.kind === 'missile' ? 12 : 9);
  const linger = age > main ? clamp01((age - main) / Math.max(1, lingerMs(b.kind, m))) : -1;
  const wind = R * 0.5 * g;

  // the dust skirt rolling out low along the ground
  if (s.dust && t < 0.95) {
    const k = easeOut(t);
    smokeReset();
    for (let i = 0; i < s.dust; i++) {
      const a = (i / s.dust) * Math.PI * 2 + b.seed * 5;
      const d = R * (0.5 + 1.5 * k * m.shockwave) * (0.85 + 0.3 * rnd(seed, i));
      smokeAdd(x + Math.cos(a) * d * g, y + Math.sin(a) * d * 0.5 * g + R * 0.2 * g, R * (0.25 + 0.3 * k) * (0.8 + 0.4 * rnd(seed, i + 5)), seed + i);
    }
    smokeDraw(ctx, g, 0.75 * (1 - t) * (1 - t * 0.5), FX.dustDark, FX.dust, FX.dustLight);
  }
  // smoke: from a third of the way through it rises and drifts as one mass; it stays on through the linger
  if (t > 0.28 || linger >= 0) {
    const ts = linger >= 0 ? 1 + linger * 0.8 * m.smokeLinger : t;
    const fadeIn = clamp01((t - 0.28) * 4);
    const fadeOut = linger >= 0 ? (1 - linger) * Math.min(1, 0.4 + 0.4 * m.smokeLinger) : 1;
    smokeReset();
    for (let i = 0; i < s.smoke; i++) {
      const rise = R * (0.5 + 1.5 * ts + 0.5 * i) * g;
      const px = x + (rnd(seed, i + 20) - 0.5) * R * g + wind * ts * (0.6 + 0.2 * i);
      smokeAdd(px, y - rise, R * (0.42 + 0.3 * Math.min(ts, 1.6)) * (0.8 + 0.35 * rnd(seed, i + 40)), seed + i * 3);
    }
    const dark = s.black ? FX.soot : FX.smokeDark;
    const mid = s.black ? FX.smokeDark : FX.smoke;
    const light = s.black ? FX.smoke : FX.smokeLight;
    smokeDraw(ctx, g, (linger >= 0 ? 0.8 : 0.92) * fadeIn * fadeOut, dark, mid, light);
  }
  // fire left burning at the spot: a few small flames scattered over it, each flickering on its own and dying down
  if (linger >= 0 && s.burns && m.fireLinger > 0) {
    const n = R > 6 ? 4 : 3;
    for (let i = 0; i < n; i++) {
      const life = 1 - linger * (0.7 + 0.5 * rnd(seed, i + 90));
      if (life <= 0.05) continue;
      const a = rnd(seed, i + 100) * Math.PI * 2;
      const d = R * 0.55 * Math.sqrt(rnd(seed, i + 110));
      const fx = x + Math.cos(a) * d * g;
      const fy = y + Math.sin(a) * d * 0.55 * g + R * 0.1 * g;
      const fl = Math.floor(age / (70 + 30 * rnd(seed, i + 120)));
      const flick = 0.7 + 0.45 * rnd(seed + fl, i);
      flame(ctx, fx, fy, R * (0.22 + 0.18 * rnd(seed, i + 130)) * life * flick, g, seed + i * 3 + (fl % 3));
    }
  }
  if (linger >= 0) return;
  // the flash, then the fireball: a cluster of smaller balls of fire, rising a little and cooling
  if (t < 0.12) {
    ctx.fillStyle = FX.flame;
    blob(ctx, x, y - R * 0.2 * g, R * 0.9, g, seed);
    ctx.fillStyle = FX.hot;
    blob(ctx, x - g, y - R * 0.3 * g, R * 0.55, g, seed + 1);
  } else if (t < 0.62) {
    const tf = (t - 0.12) / 0.5;
    const grow = 0.75 + 0.35 * easeOut(Math.min(1, tf * 2));
    const heat = 1 - tf;
    const lift = R * 0.9 * tf * g;
    const balls = R > 6 ? 5 : 4;
    for (let i = 0; i < balls; i++) {
      const a = rnd(seed, i + 60) * Math.PI * 2;
      const d = R * 0.45 * grow * (i === 0 ? 0 : 0.7 + 0.3 * rnd(seed, i + 70));
      const r = R * (i === 0 ? 0.62 : 0.4 + 0.15 * rnd(seed, i + 80)) * grow * (1 - tf * 0.35);
      fireBall(ctx, x + Math.cos(a) * d * g, y - lift - R * 0.25 * g + Math.sin(a) * d * 0.7 * g - i * 0.2 * R * tf * g, r, g, heat * (i === 0 ? 1 : 0.85), seed + i * 7);
    }
  } else if (t < 0.8) {
    // embers glowing at the foot of the smoke
    fireBall(ctx, x, y - R * 0.3 * g, R * 0.35 * (1 - (t - 0.62) * 3), g, 0.25, seed + 9);
  }
  debris(ctx, x, y, Math.round(s.debris * m.debris), clamp01(t / 0.75), R * 2.1, g, seed, !air);
}

/** Flak: a quick orange flash inside a puff of black smoke that spreads and thins. */
function flak(ctx: CanvasRenderingContext2D, b: BlastLike, t0: number, m: MotionParams): void {
  const g = b.scale;
  const R = SPEC.flak.r;
  const t = step(clamp01(t0), 7);
  const seed = b.seed * 97;
  if (t > 0.1) {
    smokeReset();
    for (let i = 0; i < 3; i++) smokeAdd(b.x + (rnd(seed, i) - 0.5) * R * g + t * R * 0.8 * g, b.y + (rnd(seed, i + 3) - 0.5) * R * 0.8 * g - t * R * 0.5 * g, R * (0.55 + 0.6 * t) * (0.8 + 0.3 * rnd(seed, i + 6)), seed + i);
    smokeDraw(ctx, g, 0.9 * (1 - t * t), FX.soot, FX.smokeDark, FX.smoke);
  }
  if (t < 0.3) fireBall(ctx, b.x, b.y, R * (t < 0.15 ? 0.55 : 0.4), g, t < 0.15 ? 0.9 : 0.6, seed);
  debris(ctx, b.x, b.y, Math.round(SPEC.flak.debris * m.debris), t, R * 1.6, g, seed, false);
}

/** A shell or bomb in water: a column of white water, spray falling back, foam spreading in patches. */
function splash(ctx: CanvasRenderingContext2D, b: BlastLike, t0: number, m: MotionParams): void {
  const g = b.scale;
  const x = b.x;
  const y = b.y;
  const seed = b.seed * 97;
  const t = step(clamp01(t0), 8);
  // foam patches on the water, spreading and breaking up (under the column)
  const prev = ctx.globalAlpha;
  const n = 6;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + b.seed * 4;
    const d = (1 + 3.2 * easeOut(t) * m.shockwave) * (0.8 + 0.4 * rnd(seed, i));
    ctx.globalAlpha = prev * 0.75 * (1 - t);
    ctx.fillStyle = t < 0.4 ? FX.foam : FX.foamDim;
    foamPatch(ctx, x + Math.cos(a) * d * g, y + Math.sin(a) * d * 0.5 * g, 0.6 + 1.6 * t * rnd(seed, i + 9), g, seed + i);
  }
  ctx.globalAlpha = prev;
  // the column: up fast, then falling back and spreading at its foot
  const up = Math.sin(Math.PI * Math.min(1, t / 0.75));
  const H = 7 * up;
  if (H > 0.5) {
    const w = 1.1 + 0.9 * t;
    ctx.fillStyle = FX.water;
    blob(ctx, x + g, y - g * 0.5, w + 0.6, g, seed + 1);
    for (let k = 0; k < 4; k++) {
      const hy = y - (k / 3) * H * g;
      ctx.fillStyle = k === 3 ? FX.foam : FX.foamDim;
      blob(ctx, x + (k % 2) * g * 0.5, hy, w * (1 - k * 0.15) + (k === 3 ? 0.3 : 0), g, seed + k);
      ctx.fillStyle = FX.foam;
      blob(ctx, x - g * 0.6, hy - g * 0.4, Math.max(0.4, w * 0.5 - k * 0.1), g, seed + k + 9);
    }
  }
  // spray: droplets thrown up and out, falling back
  ctx.globalAlpha = prev * (1 - t * 0.6);
  ctx.fillStyle = FX.foam;
  for (let i = 0; i < 8; i++) {
    const a = rnd(seed, i + 20) * Math.PI * 2;
    const sp = 2 + 3 * rnd(seed, i + 30);
    const hu = 5 + 4 * rnd(seed, i + 40);
    const px = x + Math.cos(a) * sp * t * g;
    const py = y + Math.sin(a) * sp * t * 0.5 * g - hu * 4 * t * (1 - t) * g;
    if (t > 0.08) ctx.fillRect(Math.round(px / g) * g, Math.round(py / g) * g, g, g);
  }
  ctx.globalAlpha = prev;
}

/** The atom bomb: flash, fireball, the base surge rolling out and the mushroom cloud rising on its stem. */
function atom(ctx: CanvasRenderingContext2D, b: BlastLike, age: number, main: number, m: MotionParams): void {
  // the blast is big on screen: coarser cells keep it chunky and cheap
  const Rpx = Math.max(18, Math.min(220, b.rt * b.zoom * 0.45));
  const g = Math.max(b.scale, Math.round(Rpx / 24));
  const r = Rpx / g;
  const x = b.x;
  const y = b.y;
  const seed = b.seed * 97;
  const t = step(clamp01(age / main), 18);
  const linger = age > main ? clamp01((age - main) / Math.max(1, lingerMs('atom', m))) : 0;
  const prev = ctx.globalAlpha;
  const cell = (k: number): number => k * g;
  // the flash
  if (t < 0.07) {
    ctx.globalAlpha = prev * 0.85;
    ctx.fillStyle = FX.hot;
    blob(ctx, x, y, r * 1.5, g, seed);
    ctx.globalAlpha = prev;
    ctx.fillStyle = '#ffffff';
    blob(ctx, x, y, r * 0.8, g, seed + 1);
    return;
  }
  // the base surge: a ring of dust and cloud rolling out low over the ground (puffs, never a drawn line)
  if (t < 0.85) {
    const k = easeOut((t - 0.05) / 0.8);
    smokeReset();
    const n = 14;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + b.seed * 3;
      const d = r * (0.9 + 2.3 * k * m.shockwave) * (0.9 + 0.2 * rnd(seed, i));
      smokeAdd(x + Math.cos(a) * cell(d), y + Math.sin(a) * cell(d) * 0.42, r * (0.22 + 0.2 * k), seed + i);
    }
    smokeDraw(ctx, g, 0.7 * (1 - k), FX.dust, FX.dustLight, FX.ash);
  }
  // the stem and the cap rise from a fifth of the way through; the cloud thins at the end and through the linger
  const fade = (t > 0.8 ? 1 - (t - 0.8) / 0.4 : 1) * (1 - linger);
  if (t > 0.18) {
    const rise = clamp01((t - 0.18) / 0.7);
    const top = r * (0.7 + 1.9 * easeOut(rise) + 0.3 * linger);
    smokeReset();
    for (let i = 0; i < 11; i++) {
      const h = (i / 10) * top;
      smokeAdd(x + cell(Math.sin(i * 1.1 + b.seed * 5) * r * 0.06 + linger * r * 0.2 * (i / 10)), y - cell(h), r * (0.3 - i * 0.011), seed + i);
    }
    smokeDraw(ctx, g, fade, FX.smokeDark, FX.smoke, FX.smokeLight);
    const cy = y - cell(top + r * 0.3);
    // the cap glows on its underside while young
    if (t < 0.6) {
      fireBall(ctx, x, cy + cell(r * 0.5), r * 0.5 * (1 - rise * 0.5), g, 0.6 - rise * 0.6, seed + 30);
    }
    smokeReset();
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      smokeAdd(x + Math.cos(a) * cell(r * (0.62 + 0.15 * rise)) + cell(linger * r * 0.4), cy + Math.sin(a) * cell(r * 0.26), r * (0.4 + 0.08 * rise), seed + i + 50);
    }
    smokeAdd(x + cell(linger * r * 0.4), cy - cell(r * 0.2), r * 0.52, seed + 60);
    smokeAdd(x - cell(r * 0.3), cy - cell(r * 0.35), r * 0.35, seed + 61);
    smokeDraw(ctx, g, fade, FX.smokeDark, FX.smoke, FX.ash);
  }
  // the fireball: a cluster of fire, white-hot first, then cooling to red and sinking into the stem
  if (t < 0.55) {
    const tf = (t - 0.07) / 0.48;
    const fr = r * (1 - tf * 0.55);
    const lift = cell(r * 0.5 * tf);
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2 + b.seed * 6;
      fireBall(ctx, x + Math.cos(a) * cell(fr * 0.5), y - lift + Math.sin(a) * cell(fr * 0.4), fr * (0.45 + 0.1 * rnd(seed, i)), g, 0.95 - tf * 0.8, seed + i * 5);
    }
    fireBall(ctx, x, y - lift, fr * 0.7, g, 1 - tf * 0.7, seed + 40);
  }
  ctx.globalAlpha = prev;
}

// ------------------------------------------------------------------------------------------------- aftermath

const TAU = Math.PI * 2;
const fract = (v: number): number => v - Math.floor(v);

/** A sinking ship, a falling plane's smoke or dust, at (f.x, f.y), `t` 0..1 of its life. */
function drawMapFx(ctx: CanvasRenderingContext2D, f: MapFxDraw, m: MotionParams): void {
  const { x, y, t } = f;
  const z = f.zoom;
  // size scale for the small effects: readable zoomed out, not huge zoomed in
  const k = Math.min(1.6, Math.max(0.7, z / 8));
  const g = z < 11 ? 1 : 2;
  const seed = f.seed * 97 + 3;
  const prev = ctx.globalAlpha;
  switch (f.kind) {
    case 'splash': {
      // a ship sinking: an oil slick spreading, foam patches breaking up, bubbles, dark pieces going under
      const e = easeOut(t);
      ctx.globalAlpha = prev * 0.35 * (1 - t);
      ctx.fillStyle = '#121a20';
      blob(ctx, x, y, ((3 + 7 * e) * k) / g, g, seed);
      for (let j = 0; j < 7; j++) {
        const a = (j / 7) * TAU + f.seed * 4;
        const d = (2 + 9 * e * m.shockwave) * k * (0.8 + 0.4 * rnd(seed, j));
        ctx.globalAlpha = prev * 0.8 * (1 - t);
        ctx.fillStyle = t < 0.3 ? FX.foam : FX.foamDim;
        foamPatch(ctx, x + Math.cos(a) * d, y + Math.sin(a) * d * 0.6, ((1 + 1.6 * e) * k) / g, g, seed + j);
      }
      // bubbles popping over the wreck
      ctx.globalAlpha = prev * (1 - t);
      ctx.fillStyle = FX.foam;
      for (let j = 0; j < 5; j++) {
        const ph = fract(t * 3 + rnd(seed, j + 20));
        if (ph > 0.6) continue;
        ctx.fillRect(Math.round((x + (rnd(seed, j + 30) - 0.5) * 8 * k) / g) * g, Math.round((y + (rnd(seed, j + 40) - 0.5) * 5 * k) / g) * g, g, g);
      }
      const sink = 1 - e;
      if (sink > 0.08) {
        ctx.globalAlpha = prev * 0.9 * sink;
        ctx.fillStyle = '#2f353b';
        for (let j = 0; j < 3; j++) {
          const a = j * 2.1 + f.seed * 6;
          const d = (2 + 5 * e) * k;
          const w = Math.max(1, Math.round((3 - j) * sink * k));
          ctx.fillRect(Math.round(x + Math.cos(a) * d) - w * g, Math.round(y + Math.sin(a) * d * 0.7), w * 2 * g, g);
        }
      }
      break;
    }
    case 'smoke': {
      // a plane going down: black smoke rising and drifting off (the burst itself is an 'air' blast)
      smokeReset();
      for (let j = 0; j < 5; j++) {
        const tj = clamp01((t - j * 0.07) / 0.9);
        if (tj <= 0) continue;
        const a = j * 1.7 + f.seed * 5;
        smokeAdd(x + Math.cos(a) * 3 * k + tj * 9 * k, y + Math.sin(a) * 2 * k - tj * 13 * k, ((1.2 + 2.4 * easeOut(tj)) * k) / g, seed + j);
      }
      smokeDraw(ctx, g, 0.75 * (1 - t) * Math.min(1, 0.5 + 0.5 * m.smokeLinger), FX.soot, FX.smokeDark, FX.smoke);
      break;
    }
    case 'dust':
    case 'fortDust': {
      // earth thrown up after shells or a fort coming down: brown puffs settling (a fort: heavier, with debris)
      const fort = f.kind === 'fortDust';
      const n = fort ? 8 : 5;
      const spread = fort ? Math.max(10, z * 1.2) : Math.max(10, f.rt * z * 0.55);
      smokeReset();
      for (let j = 0; j < n; j++) {
        const tj = clamp01((t - (fort ? 0 : 0.2 + j * 0.05)) / (fort ? 1 : 0.75));
        if (tj <= 0) continue;
        const a = f.seed * TAU + (j * TAU) / n;
        const d = fort ? spread * (0.35 + 0.8 * easeOut(tj)) : spread * (0.3 + 0.6 * fract(f.seed * 7 + j * 0.37));
        smokeAdd(x + Math.cos(a) * d, y + Math.sin(a) * d * 0.7 - tj * 3 * k, ((fort ? 2 + 3 * easeOut(tj) : 1.5 + 2.4 * easeOut(tj)) * k) / g, seed + j);
      }
      smokeDraw(ctx, g, (fort ? 0.6 : 0.45) * (1 - t) * (1 - t * 0.5), FX.dustDark, FX.dust, FX.dustLight);
      if (fort && t < 0.45) debris(ctx, x, y, Math.round(8 * m.debris), t / 0.45, (14 * k) / g, g, seed);
      break;
    }
  }
  ctx.globalAlpha = prev;
}

export const refinedExplosions: ExplosionArt = {
  durationMs: (kind: BlastKind, m: MotionParams) => burstMs(kind, m) + lingerMs(kind, m),
  draw(ctx: CanvasRenderingContext2D, b: BlastDraw, m: MotionParams): void {
    drawBlast(ctx, b, m);
  },
  drawMapFx(ctx: CanvasRenderingContext2D, f: MapFxDraw, m: MotionParams): void {
    drawMapFx(ctx, f, m);
  },
};
