// The detailed style's explosions (client only). No clean circles and no drawn rings: a blast is built from the shared
// puffs (blobs.ts), each one lumpy and shaded, moving by simple physics from the clock:
//   - the flash: a white-hot core for two or three frames that shrinks into the fireball (a few short spikes of light
//     from the bigger blasts) and a soft stepped pool of light thrown on the ground, the water or round a burst in the
//     air that fades within a fifth of a second; its size and length follow flashSize and flashTime, and reduced
//     motion has none;
//   - a fireball of several fire puffs that swell, rise a little and cool from white through orange to deep red as
//     they burn out;
//   - smoke that starts as oily soot over the fire and thins to grey as it rises and drifts, staying longer with
//     smokeLinger;
//   - debris and earth thrown out on ballistic arcs that fall back, and for blasts on the ground a crown of dirt and a
//     skirt of dust rolling out along the ground (as far as the shockwave number says);
//   - small fires left burning on the ground after the bigger blasts (fireLinger).
// Kinds: a shell, one bomb of a stick, a ship or fort hit (sparks and black smoke), a plane bursting in the air with
// burning pieces falling, a missile (a big fireball, a dust skirt and a rising smoke column), the atom bomb (a whole
// sequence, see drawAtom), a splash (a small burst at the waterline, then a white column of spray collapsing, foam
// spreading irregularly) and flak (a black puff with a quick orange core).
// Aftermath (fx/layer.ts): a ship going under (foam, an oil slick, bubbles, wreckage), a plane's smoke, dust after
// shells and a fort coming down. Reduced motion: a still frame of the burst, then a still frame of its smoke.
import type { MotionParams } from '../motion';
import { rnd } from '../shared/noise';
import type { BlastDraw, BlastKind, ExplosionArt, MapFxDraw } from '../types';
import { drawBlob } from './blobs';
import { gridOf, type Grid } from './grid';
import { DEBRIS, FIRE, SPRAY, TRACER } from './palette';

interface Spec {
  /** fireball radius in model units (screen px at mid zoom) */
  r: number;
  /** the fire phase and the smoke after it (ms, before blastTime and smokeLinger) */
  fire: number;
  smoke: number;
  /** puffs of smoke, pieces of debris, clods of earth thrown up */
  puffs: number;
  debris: number;
  dirt: number;
  /** blasts on the ground roll a dust skirt out */
  skirt: boolean;
  /** small fires left burning */
  burn: number;
}

const SPEC: Record<BlastKind, Spec> = {
  shell: { r: 3.4, fire: 300, smoke: 650, puffs: 4, debris: 5, dirt: 6, skirt: false, burn: 1 },
  bomb: { r: 4.6, fire: 360, smoke: 800, puffs: 5, debris: 7, dirt: 9, skirt: true, burn: 2 },
  hit: { r: 4.2, fire: 380, smoke: 900, puffs: 5, debris: 8, dirt: 0, skirt: false, burn: 2 },
  air: { r: 3.4, fire: 300, smoke: 700, puffs: 3, debris: 5, dirt: 0, skirt: false, burn: 0 },
  missile: { r: 9, fire: 520, smoke: 1100, puffs: 8, debris: 10, dirt: 10, skirt: true, burn: 4 },
  atom: { r: 26, fire: 2400, smoke: 5200, puffs: 0, debris: 12, dirt: 0, skirt: true, burn: 0 },
  splash: { r: 3.8, fire: 520, smoke: 450, puffs: 0, debris: 0, dirt: 0, skirt: false, burn: 0 },
  flak: { r: 4.2, fire: 160, smoke: 700, puffs: 3, debris: 5, dirt: 0, skirt: false, burn: 0 },
};

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
const easeOut = (t: number): number => 1 - (1 - t) * (1 - t);
const easeOut3 = (t: number): number => 1 - (1 - t) ** 3;

function durationOf(kind: BlastKind, m: MotionParams): number {
  const s = SPEC[kind];
  // the atom cloud drifts and thins for a long while, but never past about twelve seconds
  return s.fire * m.blastTime + s.smoke * (kind === 'atom' ? Math.min(1.6, m.smokeLinger) : m.smokeLinger);
}

/** A small square of colour on the grid. */
function speck(ctx: CanvasRenderingContext2D, x: number, y: number, g: Grid, n: number, color: string): void {
  const s = Math.max(1, Math.round(n)) * g.p;
  ctx.fillStyle = color;
  ctx.fillRect((Math.round((x * g.dpr) / g.p) * g.p) / g.dpr, (Math.round((y * g.dpr) / g.p) * g.p) / g.dpr, s / g.dpr, s / g.dpr);
}

/** The radius of a blast's fireball in model units (missiles and the atom bomb grow with the sim's blast radius). */
function radiusOf(b: BlastDraw): number {
  const s = SPEC[b.kind];
  const sc = Math.max(1, b.scale);
  if (b.kind === 'missile') return Math.max(s.r, Math.min(30, (b.rt * b.zoom * 0.3) / sc));
  if (b.kind === 'atom') return Math.max(18, Math.min(220, b.rt * b.zoom * 0.45)) / sc;
  if (b.kind === 'bomb') return Math.max(s.r, Math.min(9, (1.2 * b.zoom) / sc));
  return s.r;
}

// ------------------------------------------------------------------------------------------------- the flash

interface FlashSpec {
  /** the light's radius on the ground (or round a burst in the air) and its peak alpha */
  glow: number;
  a: number;
  /** the white-hot core's radius (times the fireball's) */
  core: number;
  /** short spikes of light out of the core in its first frame (the bigger blasts) */
  rays: number;
  /** how long the light lasts (ms, times flashTime) */
  ms: number;
}

const FLASH: Record<BlastKind, FlashSpec> = {
  shell: { glow: 2.6, a: 0.6, core: 0.95, rays: 0, ms: 190 },
  bomb: { glow: 3, a: 0.72, core: 0.9, rays: 4, ms: 220 },
  hit: { glow: 2.8, a: 0.72, core: 0.9, rays: 4, ms: 220 },
  air: { glow: 2.5, a: 0.62, core: 0.95, rays: 3, ms: 190 },
  missile: { glow: 3, a: 0.8, core: 0.85, rays: 6, ms: 300 },
  atom: { glow: 4.5, a: 0.85, core: 1.2, rays: 0, ms: 900 },
  splash: { glow: 2, a: 0.32, core: 0.6, rays: 0, ms: 150 },
  flak: { glow: 2.3, a: 0.58, core: 0.9, rays: 3, ms: 170 },
};
/** How long the white-hot core shows (ms, times flashTime): two to three frames at 60 frames a second. */
const CORE_MS = 48;

/** The flash's size from the motion: smaller under subtle, bigger under cinematic. */
const flashScale = (m: MotionParams): number => 0.55 + 0.45 * m.flashSize;

/** A blast's flash at a moment: its light's alpha and radius, its core's alpha and radius (radii times the fireball's). */
export interface FlashAt {
  glowA: number;
  glowR: number;
  coreA: number;
  coreR: number;
}
const flashNow: FlashAt = { glowA: 0, glowR: 0, coreA: 0, coreR: 0 };

/**
 * The flash of a blast `age` ms old (pure; the returned object is reused): the light swells a little and fades fast,
 * the core shrinks into the fireball growing under it over two or three frames (it never fades to a pale veil over
 * the fire). Smaller and shorter under subtle motion, bigger and longer under cinematic.
 */
export function flashAt(kind: BlastKind, age: number, m: MotionParams): FlashAt {
  const f = FLASH[kind];
  const sc = flashScale(m);
  const gk = age / (f.ms * m.flashTime);
  flashNow.glowA = gk < 1 ? f.a * (0.75 + 0.25 * m.flashSize) * (1 - gk) * (1 - gk) : 0;
  flashNow.glowR = f.glow * sc * (0.85 + 0.3 * easeOut(Math.min(1, gk * 3)));
  const ck = age / (CORE_MS * m.flashTime);
  flashNow.coreA = ck < 1 ? (ck < 0.7 ? 1 : (1 - ck) / 0.3) : 0;
  flashNow.coreR = f.core * sc * (1.05 - 0.6 * Math.min(1, ck));
  return flashNow;
}

/**
 * The light a blast throws on the ground (or round it in the air, `air`) in its first moments: a soft dithered pool
 * that swells a little and fades fast. Drawn under the blast.
 */
function flashGlow(ctx: CanvasRenderingContext2D, kind: BlastKind, x: number, y: number, Rc: number, age: number, g: Grid, m: MotionParams, sd: number, air: boolean): void {
  const f = flashAt(kind, age, m);
  if (f.glowA > 0) drawBlob(ctx, air ? 'halo' : 'glow', Rc * f.glowR, Math.floor(sd) & 3, x, y, g, f.glowA);
}

/** The white-hot core of a blast's first two or three frames, with short spikes of light from the bigger ones. */
function flashCore(ctx: CanvasRenderingContext2D, kind: BlastKind, x: number, y: number, Rc: number, age: number, g: Grid, m: MotionParams, sd: number): void {
  const f = FLASH[kind];
  const ms = CORE_MS * m.flashTime;
  if (age >= ms) return;
  const k = age / ms;
  const sc = flashScale(m);
  const prev = ctx.globalAlpha;
  if (f.rays && k < 0.6) {
    // spikes of light: a few short, uneven rays of single cells, white near the core, yellow at their tips
    const n = f.rays;
    const fade = 1 - k / 0.6;
    for (let i = 0; i < n; i++) {
      const ang = ((i + 0.5 * rnd(sd, i + 300)) / n) * Math.PI * 2 + sd;
      const len = Rc * f.core * sc * (1.5 + 0.9 * rnd(sd, i + 310)) * (0.8 + 0.4 * k);
      const r0 = Rc * f.core * sc * 0.7;
      const cells = Math.max(1, Math.round(len - r0));
      const step = Math.max(1, cells / 9);
      const ca = Math.cos(ang) * g.k;
      const sa = Math.sin(ang) * g.k * 0.8;
      for (let j = 0; j < cells; j += step) {
        const q = j / cells;
        ctx.globalAlpha = prev * fade * (1 - q * 0.7);
        speck(ctx, x + ca * (r0 + j), y + sa * (r0 + j), g, 1, q < 0.45 ? FIRE[0] : FIRE[1]);
      }
    }
    ctx.globalAlpha = prev;
  }
  const c = flashAt(kind, age, m);
  drawBlob(ctx, 'flash', Math.max(1, Rc * c.coreR), (Math.floor(sd) + 1) & 3, x, y, g, c.coreA);
}

function drawBlast(ctx: CanvasRenderingContext2D, b: BlastDraw, m: MotionParams): void {
  if (b.kind === 'atom') return drawAtom(ctx, b, m);
  if (b.kind === 'splash') return drawSplash(ctx, b, m);
  const g = gridOf(b.scale, b.dpr);
  const s = SPEC[b.kind];
  const R = radiusOf(b);
  const u = b.scale; // CSS px per model unit
  const Rc = R * g.res; // fireball radius in cells
  const fT = s.fire * m.blastTime;
  const dur = Math.max(1, b.durMs);
  let age = b.t * dur;
  if (b.reduced) age = b.t < 0.5 ? fT * 0.35 : fT + (dur - fT) * 0.3;
  const sd = b.seed * 97.3;
  const air = b.kind === 'air';
  const x = b.x;
  const y = air ? b.y - 7 * u : b.y;
  const ground = !air && b.kind !== 'flak' && b.kind !== 'hit';
  const fq = clamp01(age / fT);
  const prev = ctx.globalAlpha;
  const flash = !b.reduced;

  // the flash's light on the ground, or round a burst in the air (a plane shot down lights the ground under it too)
  if (flash) {
    if (air) flashGlow(ctx, b.kind, x, b.y, Rc * 0.8, age, g, m, sd, false);
    flashGlow(ctx, b.kind, x, y, Rc, age, g, m, sd, air || b.kind === 'flak');
  }

  // dust rolling out along the ground (the shockwave as moving earth, never a drawn ring)
  // at mid zoom (an art pixel a screen px) the skirt and crown use fewer, so a barrage stays cheap
  const few = g.res < 1.5;
  if (s.skirt && fq > 0.05) {
    const n = (b.kind === 'missile' ? 9 : 6) >> (few ? 1 : 0);
    const reach = R * (1 + 1.7 * easeOut3(clamp01(age / (fT * 1.8)))) * m.shockwave;
    const a = 0.42 * (1 - clamp01((age - fT * 0.3) / (dur - fT * 0.3)));
    for (let i = 0; i < n; i++) {
      const ang = (i / n) * Math.PI * 2 + rnd(sd, i) * 0.6;
      const d = reach * (0.75 + 0.35 * rnd(sd, i + 40));
      drawBlob(ctx, 'dust', Rc * (0.42 + 0.3 * fq), i, x + Math.cos(ang) * d * u, y + Math.sin(ang) * d * u * 0.5, g, a);
    }
  }
  // the crown of earth thrown up and falling back
  if (s.dirt && ground) {
    const n = few ? Math.ceil(s.dirt / 2) : s.dirt;
    for (let i = 0; i < n; i++) {
      const k = clamp01(age / (fT * 1.6 + 200));
      if (k >= 1) break;
      const ang = -Math.PI / 2 + (rnd(sd, i + 60) - 0.5) * 2.2;
      const v = R * (2.2 + 1.6 * rnd(sd, i + 70));
      const px = x + Math.cos(ang) * v * k * u;
      const py = y + (Math.sin(ang) * v * k + R * 3.2 * k * k) * u;
      drawBlob(ctx, 'dust', Rc * (0.18 + 0.2 * k), i + 1, px, py, g, 0.9 * (1 - k * k));
    }
  }
  // smoke: soot over the fire, thinning to grey as it rises and drifts
  const puffs = s.puffs + (b.kind === 'missile' ? 4 : 0);
  for (let i = puffs - 1; i >= 0; i--) {
    const born = fT * (0.25 + 0.6 * (i / Math.max(1, puffs)));
    const life = dur - born;
    const k = (age - born) / life;
    if (k < 0 || k >= 1) continue;
    const column = b.kind === 'missile' && i >= s.puffs;
    const rise = (column ? R * (1.6 + (i - s.puffs) * 0.9) : R * (0.9 + 1.4 * rnd(sd, i + 5))) * easeOut(k) + R * 0.4;
    const drift = R * (0.5 + 0.8 * rnd(sd, i + 9)) * k;
    const px = x + ((rnd(sd, i + 1) - 0.5) * R * 1.1 + drift) * u;
    const py = y - rise * u;
    const r = Rc * (0.45 + 0.35 * rnd(sd, i + 3)) * (0.7 + 0.7 * easeOut(k)) * (column ? 0.85 : 1);
    const a = (1 - k) * (b.kind === 'flak' ? 0.95 : 0.9);
    // oily soot over the fire, grey smoke once it has risen (one puff each, so a barrage stays cheap); flak stays black
    drawBlob(ctx, b.kind === 'flak' || k < 0.35 + 0.1 * rnd(sd, i + 7) ? 'soot' : 'smoke', r, i, px, py, g, a);
  }
  // fires left burning on the ground, flickering through the smoke
  if (s.burn && m.fireLinger > 0 && ground && age > fT * 0.5) {
    const k = clamp01((age - fT * 0.5) / ((dur - fT * 0.5) * (0.35 + 0.65 * m.fireLinger)));
    if (k < 1) {
      const fl = Math.floor(age / 85);
      for (let i = 0; i < s.burn; i++) {
        const ang = rnd(sd, i + 80) * Math.PI * 2;
        const d = R * 0.9 * rnd(sd, i + 90);
        const px = x + Math.cos(ang) * d * u;
        const py = y + Math.sin(ang) * d * u * 0.62;
        const r = Math.max(1, Rc * 0.16 * (1 + 0.3 * rnd(fl, i)) * (1 - k * 0.6));
        drawBlob(ctx, 'fire', r, fl + i, px, py - r * g.k * 0.6, g, 0.95 * (1 - k), 1 + Math.floor(rnd(fl, i + 3) * 3));
      }
    }
  }
  // the fireball: several puffs swelling, rising and cooling; hot ones drawn last
  if (age < fT) {
    const n = b.kind === 'flak' ? 2 : b.kind === 'missile' ? 7 : 5;
    for (let i = n - 1; i >= 0; i--) {
      const ang = rnd(sd, i + 20) * Math.PI * 2;
      const d = i === 0 ? 0 : R * 0.45 * rnd(sd, i + 30);
      const grow = easeOut3(clamp01(fq * 3.2));
      const shrink = 1 - 0.55 * clamp01((fq - 0.45) / 0.55);
      const r = Rc * (i === 0 ? 0.75 : 0.5 + 0.25 * rnd(sd, i + 35)) * grow * shrink;
      const px = x + Math.cos(ang) * d * u;
      const py = y + Math.sin(ang) * d * u * 0.7 - R * 0.8 * fq * u;
      const heat = Math.min(4, fq * 5 + (i === 0 ? 0 : 0.6));
      drawBlob(ctx, 'fire', Math.max(1, r), i + 3, px, py, g, 1, heat);
    }
    if (b.kind === 'flak') {
      // flak bursts black almost at once: a lumpy black puff round the flash
      drawBlob(ctx, 'soot', Rc * (0.75 + 0.45 * fq), 1, x, y, g, Math.min(1, 0.4 + fq * 1.4));
      drawBlob(ctx, 'soot', Rc * (0.45 + 0.3 * fq), 2, x + Rc * 0.45 * g.k, y - Rc * 0.25 * g.k, g, Math.min(1, fq * 2));
    }
  }
  // debris on ballistic arcs: hot at first, then dark pieces falling back
  const nd = Math.round(s.debris * m.debris);
  if (nd && !b.reduced) {
    const k = age / (fT * 2.2 + 150);
    if (k < 1) {
      for (let i = 0; i < nd; i++) {
        const ang = air || b.kind === 'flak' ? rnd(sd, i + 100) * Math.PI * 2 : -Math.PI / 2 + (rnd(sd, i + 100) - 0.5) * 2.8;
        const v = R * (2.6 + 3 * rnd(sd, i + 110));
        const fall = (air ? 5 : 3.2) * R * k * k;
        const px = x + Math.cos(ang) * v * k * u;
        const py = y + (Math.sin(ang) * v * k * 0.8 + fall) * u;
        const hot = k < 0.25 + 0.2 * rnd(sd, i + 120);
        const color = hot ? (i % 2 ? TRACER[0] : TRACER[1]) : DEBRIS[i % 3];
        ctx.globalAlpha = prev * (1 - k * k);
        speck(ctx, px, py, g, i % 3 === 0 ? 2 : 1, color);
        if (air && i < 4) {
          // burning pieces of the plane trailing smoke
          for (let j = 1; j <= 3; j++) {
            const kk = Math.max(0, k - j * 0.05);
            const qx = x + Math.cos(ang) * v * kk * u;
            const qy = y + (Math.sin(ang) * v * kk * 0.8 + 5 * R * kk * kk) * u;
            drawBlob(ctx, j === 1 && hot ? 'fire' : 'soot', Math.max(1, Rc * 0.12 * (1 + j * 0.4)), i + j, qx, qy, g, (1 - k) * (1 - j * 0.22), 2);
          }
        }
      }
      ctx.globalAlpha = prev;
    }
  }
  // the flash: a white-hot core over everything for the first two or three frames
  if (flash) flashCore(ctx, b.kind, x, y, Rc, age, g, m, sd);
  ctx.globalAlpha = prev;
}

/**
 * A splash: a tall white column of spray thrown up, hanging a moment and collapsing, its water falling back into a
 * ragged ring of foam puffs that spreads and fades; droplets thrown out and falling back.
 */
function drawSplash(ctx: CanvasRenderingContext2D, b: BlastDraw, m: MotionParams): void {
  const g = gridOf(b.scale, b.dpr);
  const s = SPEC.splash;
  const u = b.scale;
  const R = s.r;
  const Rc = R * g.res;
  const fT = s.fire * m.blastTime;
  const dur = Math.max(1, b.durMs);
  let age = b.t * dur;
  if (b.reduced) age = fT * 0.35;
  const sd = b.seed * 53.1;
  const x = b.x;
  const y = b.y;
  const k = clamp01(age / fT);
  const end = 1 - clamp01((age - fT * 0.6) / Math.max(1, dur - fT * 0.6));
  const prev = ctx.globalAlpha;
  // the shell bursting as it strikes the water: a faint light on the sea and a small hot core at the column's foot
  if (!b.reduced) flashGlow(ctx, 'splash', x, y, Rc, age, g, m, sd, false);
  // the foam ring: the column's water landing round it, ragged puffs spreading out
  const ringK = clamp01((age - fT * 0.35) / (dur - fT * 0.35));
  if (ringK > 0) {
    const n = 9;
    for (let i = 0; i < n; i++) {
      if (rnd(sd, i + 90) < 0.15) continue;
      const ang = (i / n) * Math.PI * 2 + (rnd(sd, i) - 0.5) * 0.6;
      const d = R * (0.4 + 1.5 * easeOut(ringK)) * (0.7 + 0.45 * rnd(sd, i + 7));
      const r = Rc * (0.18 + 0.2 * rnd(sd, i + 3)) * (0.8 + 0.5 * ringK);
      drawBlob(ctx, 'spray', r, i, x + Math.cos(ang) * d * u, y + Math.sin(ang) * d * u * 0.55, g, (0.5 + 0.35 * rnd(sd, i + 5)) * end);
    }
  }
  // the column: a tall, narrow stack of spray, rising fast, hanging, then slumping back down and spreading
  if (k < 1) {
    const up = k < 0.45 ? easeOut3(k / 0.45) : 1 - easeOut((k - 0.45) / 0.55) * 0.85;
    const h = R * 5.2 * up;
    const n = 7;
    for (let i = n - 1; i >= 0; i--) {
      const f = i / (n - 1);
      const spread = 1 + (k > 0.45 ? (k - 0.45) * 2.2 : 0);
      const r = Rc * (0.62 - 0.3 * f) * spread * (0.8 + 0.2 * rnd(sd, i + 25));
      drawBlob(ctx, 'spray', r, i + 2, x + (rnd(sd, i + 20) - 0.5) * R * 0.35 * spread * u, y - h * f * u, g, (1 - k * 0.45) * (f > 0.85 ? 0.8 : 1));
    }
    // the white top of the column catching the light
    ctx.globalAlpha = prev * (1 - k);
    for (let i = 0; i < 4; i++) speck(ctx, x + (rnd(sd, i + 60) - 0.5) * R * 0.5 * u, y - (h + R * 0.4 * rnd(sd, i + 61)) * u, g, 1, SPRAY[3]);
    ctx.globalAlpha = prev;
  }
  // droplets thrown out and falling back
  for (let i = 0; i < 12; i++) {
    const ang = -Math.PI / 2 + (rnd(sd, i + 40) - 0.5) * 2.2;
    const v = R * (2.4 + 2.2 * rnd(sd, i + 50));
    const kk = clamp01(age / (fT * 1.6));
    if (kk >= 1) break;
    ctx.globalAlpha = prev * (1 - kk);
    speck(ctx, x + Math.cos(ang) * v * kk * u, y + (Math.sin(ang) * v * kk + 4.4 * R * kk * kk) * u, g, 1, i % 2 ? SPRAY[3] : SPRAY[2]);
  }
  ctx.globalAlpha = prev;
  if (!b.reduced) flashCore(ctx, 'splash', x, y - Rc * 0.3 * g.k, Rc, age, g, m, sd);
  ctx.globalAlpha = prev;
}

/** The atom cloud at a moment, lengths in fireball radii (R). */
export interface AtomShape {
  /** age over the fire phase (1 at its end) and 0..1 of the late phase (the drift and the dissipation) */
  q: number;
  late: number;
  /** the cap's height over the ground, its ring radius and the thickness of its roll */
  capH: number;
  Rm: number;
  rm: number;
  /** how far the cloud has drifted downwind at the cap's height */
  wind: number;
  /** the cap showing (0..1), still burning (1 = all fire, 0 = cooled to smoke), the fire glowing inside (0..1) */
  capIn: number;
  young: number;
  glow: number;
  /** the whole cloud's opacity as it thins away */
  fade: number;
}
const atomNow: AtomShape = { q: 0, late: 0, capH: 0, Rm: 0, rm: 0, wind: 0, capIn: 0, young: 0, glow: 0, fade: 0 };

/** The atom cloud's shape `age` ms after the flash, with a fire phase of `fT` ms in a life of `dur` ms (pure; reused). */
export function atomShape(age: number, fT: number, dur: number): AtomShape {
  const a = atomNow;
  const q = age / fT;
  const late = clamp01((age - fT) / Math.max(1, dur - fT));
  a.q = q;
  a.late = late;
  a.capH = 0.4 + 1.5 * easeOut(clamp01(q / 0.85)) + 0.25 * late;
  a.Rm = 0.14 + 0.8 * easeOut(clamp01((q - 0.04) / 0.9)) + 0.35 * late;
  a.rm = 0.18 + 0.16 * easeOut(clamp01((q - 0.04) / 0.7)) + 0.06 * late;
  a.wind = 0.75 * late * late;
  a.capIn = clamp01((q - 0.1) / 0.18);
  a.young = 1 - clamp01((q - 0.14) / 0.32);
  a.glow = clamp01(1 - (q - 0.12) / 0.85);
  // it thins away over the last two thirds of its late life
  a.fade = 1 - smooth(clamp01((late - 0.3) / 0.7));
  return a;
}

/** Scratch for the atom cap's billows, sorted far to near every frame (no allocation per frame). */
const NA = 12;
const NM = 4;
const capKey = new Float64Array(NA * NM);
const capIdx = new Int16Array(NA * NM);
const capX = new Float64Array(NA * NM);
const capY = new Float64Array(NA * NM);
const capR = new Float64Array(NA * NM);
const capLum = new Float64Array(NA * NM);
const capSin = new Float64Array(NA * NM);
// the sun, from the top left of the screen and high: x right, y toward the viewer (down the screen), z up
const SUN_X = -0.45;
const SUN_Y = -0.42;
const SUN_Z = 0.79;
/** The cap seen at the 3/4 angle: a horizontal circle is this much flatter than wide. */
const CAP_FLAT = 0.38;
const smooth = (t: number): number => t * t * (3 - 2 * t);

/**
 * The atom bomb, a sequence over its whole life:
 *   - a blinding flash: a white core and a light over the whole area that fades within a fraction of a second;
 *   - a fireball that forms at once, boils, rises and cools from white through yellow and orange to deep red, soot
 *     closing over it, lighting the ground under it while it is low;
 *   - a stem climbing under it, dust drawn up from the ground into smoke higher up, its billows rising along it;
 *   - the cap: a torus of billows rolling outward over the top and under at the rim (a slow, visible roll), lit on
 *     top (pale), in shade on the far side from the light and dark underneath, glowing orange underneath while the
 *     fire inside is hot, a domed crown over its middle;
 *   - a base surge of dust rolling out along the ground, uneven (thicker lobes, gaps, billows lagging), never a ring;
 *   - then the cloud rising a little more, spreading, drifting downwind (the top more than the stem), thinning and
 *     fading away.
 * Every frame is a picture of its own: the parts overlap from the first moment, so no frame is empty or a lone shape.
 */
function drawAtom(ctx: CanvasRenderingContext2D, b: BlastDraw, m: MotionParams): void {
  const g = gridOf(b.scale, b.dpr);
  const s = SPEC.atom;
  const u = b.scale;
  const R = radiusOf(b);
  const Rc = R * g.res;
  const fT = s.fire * m.blastTime;
  const dur = Math.max(1, b.durMs);
  let age = b.t * dur;
  if (b.reduced) age = b.t < 0.3 ? fT * 0.3 : fT * 1.1;
  const sd = b.seed * 31.7;
  const x = b.x;
  const y = b.y;
  const A = atomShape(age, fT, dur);
  const q = A.q;
  const late = A.late;
  const fade = A.fade;
  const glow = A.glow;
  const young = A.young;
  const prev = ctx.globalAlpha;
  const flash = !b.reduced;
  const wind = R * A.wind;
  // how far the cap has rolled (turns)
  const roll = age / (4400 * m.blastTime);
  const capH = R * A.capH;
  const Rm = R * A.Rm;
  const rm = R * A.rm;
  const cx = x + wind * u;
  const cy = y - capH * u;

  // ---- the light: the whole area lit for a moment, then the fireball's light on the ground while it is low
  if (flash) {
    const k0 = age / (280 * m.flashTime);
    if (k0 < 1) drawBlob(ctx, 'glow', Rc * 6.5 * flashScale(m), 1, x, y, g, 0.55 * (1 - k0) * (1 - k0));
    flashGlow(ctx, 'atom', x, y, Rc, age, g, m, sd, false);
  }
  if (q < 0.6) drawBlob(ctx, 'glow', Rc * 2.4, 2, x, y, g, 0.5 * (1 - q / 0.6) ** 2);

  // ---- the base surge: a low sheet of dust spreading in uneven lobes, billows rolling along its edge, some lagging
  if (q > 0.015) {
    const k = easeOut3(clamp01(age / (fT * 1.3)));
    const reach = R * (0.7 + 2.5 * k) * m.shockwave + R * 0.5 * late;
    const fin = clamp01((q - 0.015) / 0.05);
    const a0 = fin * (1 - late) * (1 - late * 0.4);
    drawBlob(ctx, 'haze', reach * 0.92 * g.res, Math.floor(sd) & 3, x, y, g, 0.85 * a0);
    const n = 34;
    for (let i = 0; i < n; i++) {
      if (rnd(sd, i + 200) < 0.14) continue;
      const th = ((i + 0.7 * rnd(sd, i + 201)) / n) * Math.PI * 2;
      const lobe = 0.78 + 0.2 * Math.sin(3 * th + sd) + 0.13 * Math.sin(5 * th + 2.1 * sd) + 0.07 * Math.sin(9 * th + 3 * sd);
      const d = reach * lobe * (0.58 + 0.44 * rnd(sd, i + 203));
      const r = Rc * (0.14 + 0.12 * rnd(sd, i + 204)) * (0.6 + 0.7 * k) * (1 + 0.45 * late);
      const a = (0.25 + 0.3 * rnd(sd, i + 205)) * a0;
      const px = x + Math.cos(th) * d * u;
      const py = y + Math.sin(th) * d * u * 0.5 - r * g.k * 0.25;
      drawBlob(ctx, rnd(sd, i + 206) < 0.2 ? 'smoke' : 'dust', r, i, px, py, g, a);
    }
  }

  // ---- the skirt: dust thrown up round the foot of the stem
  if (q > 0.1) {
    const k = easeOut(clamp01((q - 0.1) / 0.5));
    const a = 0.62 * clamp01((q - 0.1) / 0.15) * fade * (1 - 0.5 * late);
    for (let i = 0; i < 9; i++) {
      const th = ((i + 0.5 * rnd(sd, i + 330)) / 9) * Math.PI * 2;
      const d = R * (0.22 + 0.2 * k + 0.4 * late) * (0.8 + 0.4 * rnd(sd, i + 331));
      const r = Rc * (0.18 + 0.08 * rnd(sd, i + 332)) * (0.7 + 0.5 * k + 0.4 * late);
      const h = R * 0.18 * k * rnd(sd, i + 333);
      drawBlob(ctx, 'dust', r, i + 3, x + (Math.cos(th) * d + wind * 0.05) * u, y + (Math.sin(th) * d * 0.5 - h) * u, g, a);
    }
  }

  // ---- the stem: billows rising along it from the ground into the cap, dust low and smoke higher
  if (q > 0.06) {
    const top = Math.max(R * 0.3, capH - rm * 0.7);
    const sin = clamp01((q - 0.06) / 0.15) * fade * (1 - 0.55 * late);
    const NS = 12;
    const F = age / (650 * m.blastTime);
    const fr = F - Math.floor(F);
    for (let k = 0; k < NS; k++) {
      const f = (k + fr) / NS;
      const id = (k - Math.floor(F)) & 63;
      const h = top * f;
      const w = R * (0.19 + 0.12 * (1 - f) ** 2 + 0.14 * f ** 3) * (1 + 0.5 * late);
      const jit = (rnd(sd, id + 60) - 0.5) * w * 0.7;
      const px = x + (jit + wind * f * 0.85) * u;
      const py = y - h * u;
      const r = w * g.res * 1.3;
      // the ends fade in and out, so the billows never pop as they enter at the foot or reach the cap
      const end = Math.min(1, f * 5, (1 - f) * 4 + 0.2);
      drawBlob(ctx, f < 0.45 || rnd(sd, id + 61) < 0.4 ? 'dust' : 'smoke', r, id, px, py, g, sin * end);
      if (glow > 0.05 && f > 0.3) drawBlob(ctx, 'fire', r * 0.42, id + 1, px + w * 0.1 * u, py, g, glow * 0.65 * sin * end, 2 + (1 - glow) * 2);
    }
  }

  // ---- the cap's billows: placed on the torus, rolling, shaded by how they face the sun, sorted far to near
  const capIn = A.capIn;
  let nb = 0;
  if (capIn > 0.01) {
    const grow = 1 + 0.35 * late;
    for (let i = 0; i < NA; i++) {
      const th = ((i + 0.5 * (i & 1) * 0.5) / NA) * Math.PI * 2 + sd * 0.3;
      const ct = Math.cos(th);
      const st = Math.sin(th);
      for (let j = 0; j < NM; j++) {
        // the roll: every billow travels outward over the top, down the rim and back in underneath
        const ph = (j / NM + 0.15 * rnd(sd, i * 7 + j) - roll) * Math.PI * 2 + 0.6;
        const cf = Math.cos(ph);
        const sf = Math.sin(ph);
        const rho = Rm + rm * cf;
        const z = rm * sf;
        capX[nb] = cx + rho * ct * u;
        capY[nb] = cy - z * u + rho * st * u * CAP_FLAT;
        capR[nb] = rm * g.res * (0.5 + 0.42 * rnd(sd, i * 5 + j + 90)) * grow;
        capLum[nb] = cf * ct * SUN_X + cf * st * SUN_Y + sf * SUN_Z;
        capSin[nb] = sf;
        capKey[nb] = rho * st + z * 0.6;
        capIdx[nb] = nb;
        nb++;
      }
    }
    // far to near (insertion sort: 48 billows)
    for (let i = 1; i < nb; i++) {
      const v = capIdx[i];
      let j = i - 1;
      while (j >= 0 && capKey[capIdx[j]] > capKey[v]) {
        capIdx[j + 1] = capIdx[j];
        j--;
      }
      capIdx[j + 1] = v;
    }
  }
  const billow = (n: number): void => {
    const lum = capLum[n];
    // each billow thins away on its own time, so the cloud breaks up into ragged gaps as it dissipates
    const a = capIn * (1 - smooth(clamp01((late - 0.22 - 0.33 * rnd(sd, n + 140)) / 0.5)));
    if (a <= 0.01) return;
    // pale where the sun strikes the top, grey on the sides, dusty brown low on the cap (earth drawn up the stem), in
    // shade underneath and away from the light
    const kind = lum > 0.56 && young < 0.3 ? 'vapour' : lum > -0.15 ? (capSin[n] < 0.1 && rnd(sd, n + 170) < 0.6 ? 'dust' : 'smoke') : 'shade';
    drawBlob(ctx, kind, capR[n], n, capX[n], capY[n], g, a);
    // the young cap is still burning; later the fire inside glows through the rim and underneath while it is hot
    if (young > 0.02) drawBlob(ctx, 'fire', capR[n] * 0.85, n + 2, capX[n], capY[n], g, Math.min(1, young * 1.2) * a, 2.6 + (1 - young) * 1.4);
    else if (glow > 0.04 && capSin[n] < 0.25) {
      const under = capSin[n] < -0.3 ? 1 : 0.45;
      drawBlob(ctx, 'fire', capR[n] * 0.55, n + 1, capX[n], capY[n] + capR[n] * g.k * 0.3, g, Math.min(1, glow * 1.3) * under * a, 1.5 + (1 - glow) * 2.5);
    }
  };
  // the far half of the cap
  const crownKey = rm * 0.5;
  let bi = 0;
  for (; bi < nb && capKey[capIdx[bi]] < crownKey; bi++) billow(capIdx[bi]);

  // ---- the fireball: forms at once, boils, rises with the cap and cools, soot closing over it
  if (q < 0.75) {
    const fr = R * (0.36 + 0.4 * easeOut3(clamp01(q / 0.06))) * (1 - 0.45 * clamp01((q - 0.15) / 0.45));
    const fa = 1 - clamp01((q - 0.45) / 0.3);
    const fl = Math.floor(age / 110);
    const fy = y - capH * u + rm * 0.1 * u;
    for (let i = 8; i >= 0; i--) {
      const ang = (i / 8) * Math.PI * 2 + sd + Math.sin(age / 160 + i) * 0.25;
      const d = i === 0 ? 0 : fr * (0.5 + 0.08 * Math.sin(age / 120 + i * 2));
      const r = fr * (i === 0 ? 0.72 : 0.5 + 0.08 * rnd(sd, i + 70)) * g.res;
      const heat = Math.max(0, Math.min(4, q * 8 - (i === 0 ? 0.3 : -0.6)));
      drawBlob(ctx, 'fire', Math.max(1, r), (fl + i) & 3, cx + Math.cos(ang) * d * u, fy + Math.sin(ang) * d * u * 0.8, g, fa, heat);
    }
    // soot forming over the top of the fireball as it cools
    const so = clamp01((q - 0.18) / 0.3) * fa;
    if (so > 0.02) for (let i = 0; i < 3; i++) drawBlob(ctx, 'soot', fr * (0.45 + 0.1 * i) * g.res, i + 5, cx + (i - 1) * fr * 0.5 * u, fy - fr * (0.5 - Math.abs(i - 1) * 0.15) * u, g, so * 0.85);
  }

  // ---- the crown: a domed top over the middle of the cap, filling the ring
  if (capIn > 0.01) {
    const crownIn = clamp01((q - 0.18) / 0.2) * capIn;
    if (crownIn > 0.01) {
      const grow = 1 + 0.35 * late;
      // a low dome: wide, flat billows over the middle, the one toward the sun lit
      const offs = [
        [0, 0, 0.55, 0.3],
        [-0.42, -0.18, 0.4, 0.42],
        [0.42, -0.08, 0.4, 0.36],
        [-0.08, 0.3, 0.42, 0.3],
        [0.02, -0.36, 0.34, 0.5],
      ] as const;
      for (let i = 0; i < offs.length; i++) {
        const [ox, oy, rr, zz] = offs[i];
        const lum = ox * 0.6 * SUN_X + oy * 0.6 * SUN_Y + 0.8 * SUN_Z;
        const kind = young < 0.3 && lum + (i === 4 ? 0.15 : 0) > 0.7 ? 'vapour' : 'smoke';
        const a = crownIn * (1 - smooth(clamp01((late - 0.3 - 0.3 * rnd(sd, i + 150)) / 0.5)));
        const px = cx + ox * Rm * u;
        const py = cy - rm * zz * u + oy * Rm * CAP_FLAT * u;
        drawBlob(ctx, kind, Rm * rr * g.res * grow, i + 11, px, py, g, a);
        if (young > 0.02) drawBlob(ctx, 'fire', Rm * rr * g.res * 0.8, i + 12, px, py, g, Math.min(1, young * 1.2) * a, 2.8 + (1 - young) * 1.2);
      }
    }
  }
  // the near half of the cap
  for (; bi < nb; bi++) billow(capIdx[bi]);

  // ---- debris thrown far out early on
  const nd = Math.round(s.debris * m.debris);
  const kd = clamp01(age / (fT * 0.6));
  if (!b.reduced && kd < 1) {
    for (let i = 0; i < nd; i++) {
      const ang = -Math.PI / 2 + (rnd(sd, i + 100) - 0.5) * 3;
      const v = R * (2.2 + 2 * rnd(sd, i + 110));
      ctx.globalAlpha = prev * (1 - kd);
      speck(ctx, x + Math.cos(ang) * v * kd * u, y - R * 0.45 * u + (Math.sin(ang) * v * kd + 3 * R * kd * kd) * u, g, 2, kd < 0.3 ? TRACER[1] : DEBRIS[i % 3]);
    }
    ctx.globalAlpha = prev;
  }

  // ---- the white-hot core of the first moments, a halo of light round it
  if (flash) {
    const ms = CORE_MS * 3 * m.flashTime;
    if (age < ms) {
      const k = age / ms;
      const fy = y - capH * u;
      drawBlob(ctx, 'halo', Rc * 1.9 * flashScale(m), 3, x, fy, g, 0.9 * (1 - k));
      drawBlob(ctx, 'flash', Rc * 0.62 * flashScale(m) * (1 - 0.35 * k), 2, x, fy, g, k < 0.7 ? 1 : (1 - k) / 0.3);
    }
  }
  ctx.globalAlpha = prev;
}

// ------------------------------------------------------------------------------------------------- aftermath

/** The map's pixel size at a zoom (the renderer's sprite scale). */
const scaleAt = (z: number): number => (z < 11 ? 1 : z < 22 ? 2 : z < 32 ? 3 : 4);

function drawMapFx(ctx: CanvasRenderingContext2D, f: MapFxDraw, m: MotionParams): void {
  const z = f.zoom;
  const sc = scaleAt(z);
  const g = gridOf(sc, f.dpr);
  const k = Math.min(1.6, Math.max(0.7, z / 8));
  const t = f.t;
  const sd = f.seed * 71.3 + 1;
  const prev = ctx.globalAlpha;
  const linger = Math.max(0.5, Math.min(1.6, m.smokeLinger));
  switch (f.kind) {
    case 'splash': {
      // a ship going under: an oil slick spreading, foam and bubbles, wreckage bobbing and sinking
      const end = 1 - t;
      drawBlob(ctx, 'soot', (2.5 + 5 * easeOut(t)) * k * g.res, 1, f.x, f.y, g, 0.35 * end);
      for (let i = 0; i < 6; i++) {
        const ang = (i / 6) * Math.PI * 2 + rnd(sd, i);
        const d = (2 + 7 * easeOut(t)) * k;
        if (i % 2) continue;
        drawBlob(ctx, 'spray', (0.7 + 0.6 * rnd(sd, i + 5)) * k * g.res, i, f.x + Math.cos(ang) * d * sc, f.y + Math.sin(ang) * d * sc * 0.6, g, 0.4 * end);
      }
      // the burning wreck's smoke: oily soot rising and turning grey as it drifts off
      for (let j = 0; j < 4; j++) {
        const tj = clamp01((t - j * 0.08) / 0.7);
        if (tj <= 0 || tj >= 1) continue;
        const r = (1.3 + 2.6 * easeOut(tj)) * k * g.res;
        drawBlob(ctx, tj < 0.45 ? 'soot' : 'smoke', r, j, f.x + (rnd(sd, j + 60) - 0.5) * 4 * k * sc + tj * 6 * k * sc, f.y - tj * 11 * k * sc, g, 0.8 * (1 - tj));
      }
      ctx.fillStyle = SPRAY[3];
      for (let i = 0; i < 8; i++) {
        const bt = (t * 3 + rnd(sd, i + 20)) % 1;
        ctx.globalAlpha = prev * end * (1 - bt);
        speck(ctx, f.x + (rnd(sd, i + 30) - 0.5) * 8 * k * sc, f.y + (rnd(sd, i + 40) - 0.5) * 4 * k * sc - bt * 2 * sc, g, 1, SPRAY[3]);
      }
      const sink = 1 - easeOut(t);
      for (let i = 0; i < 4; i++) {
        ctx.globalAlpha = prev * sink;
        const ang = rnd(sd, i + 50) * Math.PI * 2;
        const d = (2 + 5 * easeOut(t)) * k;
        speck(ctx, f.x + Math.cos(ang) * d * sc, f.y + Math.sin(ang) * d * sc * 0.6, g, Math.max(1, Math.round((3 - i * 0.5) * sink * g.res * 0.6)), DEBRIS[1 + (i % 2)]);
      }
      if (t < 0.35) drawBlob(ctx, 'spray', 3 * k * g.res, 2, f.x, f.y - (2 + t * 10) * sc, g, 0.35 * (1 - t / 0.35));
      break;
    }
    case 'smoke': {
      // a plane going down: puffs of black smoke rising and drifting off, the first ones still burning
      for (let j = 0; j < 5; j++) {
        const tj = clamp01((t - j * 0.07) / (0.93 / linger + 0.07 * j));
        if (tj <= 0 || tj >= 1) continue;
        const ang = j * 1.7 + sd;
        const r = (1.4 + 2.4 * easeOut(tj)) * k * g.res;
        const px = f.x + (Math.cos(ang) * 3 + tj * 9) * k * sc;
        const py = f.y + (Math.sin(ang) * 2 - tj * 13) * k * sc;
        drawBlob(ctx, tj < 0.4 ? 'soot' : 'smoke', r, j, px, py, g, 0.85 * (1 - tj));
        if (j < 2 && tj < 0.25) drawBlob(ctx, 'fire', r * 0.5, j, px, py + r * 0.2 * g.k, g, 1 - tj * 4, 2);
      }
      break;
    }
    case 'dust':
    case 'fortDust': {
      // earth thrown up after shells, or a fort coming down: dust puffs billowing and settling
      const fort = f.kind === 'fortDust';
      const n = fort ? 9 : 5;
      const spread = fort ? Math.max(10, z * 1.2) : Math.max(10, f.rt * z * 0.55);
      for (let j = 0; j < n; j++) {
        const tj = clamp01((t - (fort ? 0 : 0.2 + j * 0.06)) / (fort ? 1 : 0.75));
        if (tj <= 0 || tj >= 1) continue;
        const ang = f.seed * Math.PI * 2 + (j * Math.PI * 2) / n;
        const d = fort ? spread * (0.35 + 0.9 * easeOut(tj)) : spread * (0.3 + 0.6 * ((f.seed * 7 + j * 0.37) % 1));
        const r = (fort ? 2 + 3.4 * easeOut(tj) : 1.5 + 2.4 * easeOut(tj)) * k * g.res;
        drawBlob(ctx, 'dust', r, j, f.x + Math.cos(ang) * d, f.y + Math.sin(ang) * d * 0.7 - tj * 3 * k * sc, g, (fort ? 0.75 : 0.55) * (1 - tj) * (1 - tj));
      }
      if (fort && t < 0.45) {
        // stones and beams thrown out
        const td = t / 0.45;
        for (let j = 0; j < 8; j++) {
          const ang = f.seed * 3 + j * 0.8;
          const d = (4 + 14 * td) * k;
          ctx.globalAlpha = prev * (1 - td);
          speck(ctx, f.x + Math.cos(ang) * d * sc, f.y + Math.sin(ang) * d * sc * 0.7 - 8 * k * td * (1 - td) * sc, g, j % 3 === 0 ? 2 : 1, DEBRIS[j % 3]);
        }
      }
      break;
    }
  }
  ctx.globalAlpha = prev;
}

export const detailedExplosions: ExplosionArt = {
  durationMs: (kind, m) => durationOf(kind, m),
  draw(ctx, b, m) {
    drawBlast(ctx, b, m);
  },
  drawMapFx(ctx, f, m) {
    drawMapFx(ctx, f, m);
  },
};
