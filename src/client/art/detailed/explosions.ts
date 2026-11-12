// The detailed style's explosions (client only). No clean circles and no drawn rings: a blast is built from the shared
// puffs (blobs.ts), each one lumpy and shaded, moving by simple physics from the clock:
//   - a short white-hot flash, then a fireball of several fire puffs that swell, rise a little and cool from white
//     through orange to deep red as they burn out;
//   - smoke that starts as oily soot over the fire and thins to grey as it rises and drifts, staying longer with
//     smokeLinger;
//   - debris and earth thrown out on ballistic arcs that fall back, and for blasts on the ground a crown of dirt and a
//     skirt of dust rolling out along the ground (as far as the shockwave number says);
//   - small fires left burning on the ground after the bigger blasts (fireLinger).
// Kinds: a shell, one bomb of a stick, a ship or fort hit (sparks and black smoke), a plane bursting in the air with
// burning pieces falling, a missile (a big fireball, a dust skirt and a rising smoke column), the atom bomb (a blinding
// flash, a fireball rising into a mushroom cap on its stem over a rolling base surge), a splash (a white column of
// spray collapsing, foam spreading irregularly) and flak (a black puff with a quick orange core).
// Aftermath (fx/layer.ts): a ship going under (foam, an oil slick, bubbles, wreckage), a plane's smoke, dust after
// shells and a fort coming down. Reduced motion: a still frame of the burst, then a still frame of its smoke.
import type { MotionParams } from '../motion';
import { rnd } from '../shared/noise';
import type { BlastDraw, BlastKind, ExplosionArt, MapFxDraw } from '../types';
import { drawBlob } from './blobs';
import { gridOf, type Grid } from './grid';
import { DEBRIS, SPRAY, TRACER } from './palette';

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
  atom: { r: 26, fire: 1700, smoke: 2600, puffs: 0, debris: 12, dirt: 0, skirt: true, burn: 0 },
  splash: { r: 3.8, fire: 520, smoke: 450, puffs: 0, debris: 0, dirt: 0, skirt: false, burn: 0 },
  flak: { r: 4.2, fire: 160, smoke: 700, puffs: 3, debris: 5, dirt: 0, skirt: false, burn: 0 },
};

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
const easeOut = (t: number): number => 1 - (1 - t) * (1 - t);
const easeOut3 = (t: number): number => 1 - (1 - t) ** 3;

function durationOf(kind: BlastKind, m: MotionParams): number {
  const s = SPEC[kind];
  return s.fire * m.blastTime + s.smoke * m.smokeLinger;
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
  // the flash: a white-hot lump for the first moment
  const flashMs = 70 * m.blastTime;
  if (age < flashMs && !b.reduced) {
    const k = age / flashMs;
    drawBlob(ctx, 'fire', Math.max(1, Rc * (0.9 + 0.3 * k)), 0, x, y, g, 1 - k * 0.6, 0);
  }
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
}

/**
 * The atom bomb: a blinding flash; a fireball rising on a stem of smoke into a broad, flattened, rolling cap (a torus
 * of billows, wider than tall) whose underside glows with fire and cools to soot; a dusty skirt widening down the
 * stem into the ground; an uneven base surge of dust rolling out along the ground (shockwave); then the cloud drifting
 * and thinning.
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
  if (b.reduced) age = b.t < 0.3 ? fT * 0.25 : fT * 1.1;
  const sd = b.seed * 31.7;
  const x = b.x;
  const y = b.y;
  const q = clamp01(age / fT);
  const late = clamp01((age - fT) / Math.max(1, dur - fT));
  const fade = 1 - late * late;
  const prev = ctx.globalAlpha;
  // the base surge: an uneven cloud of dust rolling outward, thicker in places, with gaps, some billows lagging
  if (q > 0.04) {
    const reach = R * (0.9 + 2.5 * easeOut3(clamp01(age / (fT * 1.4)))) * m.shockwave;
    const n = 26;
    for (let i = 0; i < n; i++) {
      if (rnd(sd, i + 200) < 0.14) continue;
      const ang = (i / n) * Math.PI * 2 + (rnd(sd, i) - 0.5) * 0.5;
      const lag = rnd(sd, i + 30);
      const d = reach * (0.62 + 0.45 * lag);
      const r = Rc * (0.16 + 0.24 * rnd(sd, i + 210)) * (0.7 + 0.5 * q);
      const a = (0.25 + 0.35 * rnd(sd, i + 220)) * fade * (1 - late * 0.6);
      drawBlob(ctx, rnd(sd, i + 230) < 0.25 ? 'smoke' : 'dust', r, i, x + Math.cos(ang) * d * u, y + Math.sin(ang) * d * u * 0.55, g, a);
    }
  }
  // the cap's height over the ground and its size (wider than tall)
  const rise = easeOut(clamp01((age - fT * 0.1) / (fT * 1.3)));
  const capH = R * (0.3 + 1.5 * rise);
  const capY = y - capH * u;
  const grow = easeOut(clamp01((age - fT * 0.12) / (fT * 1.2)));
  const cw = R * (0.4 + 0.8 * grow);
  const ch = cw * 0.3;
  const dx = late * R * 0.45;
  // heat: the underside glows orange, then cools through red to soot
  const glow = clamp01(1 - (age - fT * 0.25) / (fT * 1.5));
  // the stem: a column of smoke from the ground to the cap, glowing inside while it is hot
  if (q > 0.16) {
    const n = 9;
    const top = capH - ch * 0.4;
    for (let i = 0; i < n; i++) {
      const f = (i + 0.5) / n;
      const h = top * f;
      const wob = Math.sin(i * 1.7 + sd) * R * 0.06 + late * R * 0.35 * f;
      const r = Rc * (0.2 + 0.08 * rnd(sd, i + 60) + 0.06 * (1 - f));
      const a = fade * clamp01((q - 0.16) * 4);
      drawBlob(ctx, 'smoke', r, i, x + wob * u, y - h * u, g, a * (f < 0.25 ? 0.6 : 1));
      if (glow > 0.05 && f > 0.25) drawBlob(ctx, 'fire', r * 0.45, i + 2, x + wob * u, y - h * u, g, glow * 0.75, 2 + (1 - glow) * 2);
    }
  }
  // the skirt: dust thrown up round the foot of the stem, widening down into the ground and the surge
  if (q > 0.08) {
    const k = easeOut(clamp01((age - fT * 0.08) / (fT * 1.2)));
    for (let j = 0; j < 4; j++) {
      const f = j / 3;
      const h = R * 0.4 * f * k;
      const half = R * (0.2 + 1.1 * (1 - f) * (1 - f)) * (0.5 + 0.5 * k);
      const cnt = 5 - j;
      for (let i = 0; i < cnt; i++) {
        const side = cnt === 1 ? 0 : (i / (cnt - 1)) * 2 - 1;
        const r = Rc * (0.16 + 0.12 * (1 - f) + 0.06 * rnd(sd, j * 7 + i + 300));
        const yy = y - h * u + Math.abs(side) * R * 0.12 * u;
        drawBlob(ctx, rnd(sd, j * 3 + i + 320) < 0.3 ? 'smoke' : 'dust', r, j + i, x + (side * half + (rnd(sd, j * 5 + i + 310) - 0.5) * R * 0.2) * u, yy, g, (0.42 - f * 0.18) * fade);
      }
    }
  }
  // the cap: a torus of billows, the far half first, a low crown over the middle, then the near half with the glow
  // under it
  if (q > 0.12) {
    const n = 12;
    const ring = (front: boolean): void => {
      for (let i = 0; i < n; i++) {
        const ang = (i / n) * Math.PI * 2 + sd;
        const sn = Math.sin(ang);
        if (sn > 0 !== front) continue;
        const px = x + (Math.cos(ang) * cw + dx) * u;
        const py = capY + sn * ch * u;
        const r = Rc * (0.3 + 0.1 * rnd(sd, i + 50)) * (0.55 + 0.45 * grow);
        // lit from the top left, oily soot low on the cap while it is young
        drawBlob(ctx, front && glow > 0.3 ? 'soot' : 'smoke', r, i, px, py, g, fade);
        if (front) {
          const ux = px + (rnd(sd, i + 80) - 0.5) * r * g.k * 0.6;
          const uy = py + r * g.k * 0.45;
          if (glow > 0.02) drawBlob(ctx, 'fire', r * (0.55 + 0.25 * glow), i + 1, ux, uy, g, Math.min(1, glow * 1.4) * fade, 1 + (1 - glow) * 3);
          else drawBlob(ctx, 'soot', r * 0.6, i + 1, ux, uy, g, 0.7 * fade);
        }
      }
    };
    ring(false);
    // the crown: a low dome over the middle, a little flattened
    for (let i = 0; i < 3; i++) {
      const off = (i - 1) * cw * 0.45;
      drawBlob(ctx, 'smoke', Rc * (0.36 - Math.abs(i - 1) * 0.06) * (0.55 + 0.45 * grow), i + 5, x + (off + dx) * u, capY - ch * (0.9 - Math.abs(i - 1) * 0.3) * u, g, fade);
    }
    ring(true);
    // the underside of the cap round the top of the stem, glowing
    if (glow > 0.02) drawBlob(ctx, 'fire', Rc * 0.3 * (0.6 + 0.4 * grow), 3, x + dx * u, capY + ch * 0.8 * u, g, glow * fade, 1 + (1 - glow) * 3);
  }
  // the fireball rising into the cap and cooling
  if (q < 0.7) {
    const fy = y + (capY - y) * clamp01(q * 1.3);
    const n = 7;
    for (let i = n - 1; i >= 0; i--) {
      const ang = (i / n) * Math.PI * 2 + sd;
      const d = i === 0 ? 0 : R * 0.36;
      const r = Rc * (i === 0 ? 0.6 : 0.34 + 0.1 * rnd(sd, i + 70)) * (0.7 + 0.5 * easeOut(clamp01(q * 4))) * (1 - 0.5 * clamp01((q - 0.35) / 0.35));
      drawBlob(ctx, 'fire', Math.max(1, r), i, x + Math.cos(ang) * d * 1.2 * u, fy + Math.sin(ang) * d * 0.6 * u, g, 1 - clamp01((q - 0.5) / 0.2), Math.min(4, q * 6));
    }
  }
  // the flash
  if (q < 0.12 && !b.reduced) {
    const k = q / 0.12;
    drawBlob(ctx, 'fire', Rc * 1.6, 2, x, y, g, 0.35 * (1 - k), 0);
    drawBlob(ctx, 'fire', Rc * (1 + 0.5 * k), 0, x, y, g, 1 - k * 0.5, 0);
  }
  // debris thrown far out
  const nd = Math.round(s.debris * m.debris);
  const kd = clamp01(age / (fT * 1.1));
  if (!b.reduced && kd < 1) {
    for (let i = 0; i < nd; i++) {
      const ang = -Math.PI / 2 + (rnd(sd, i + 100) - 0.5) * 3;
      const v = R * (2.5 + 2 * rnd(sd, i + 110));
      ctx.globalAlpha = prev * (1 - kd);
      speck(ctx, x + Math.cos(ang) * v * kd * u, y + (Math.sin(ang) * v * kd + 3 * R * kd * kd) * u, g, 2, kd < 0.3 ? TRACER[1] : DEBRIS[i % 3]);
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
