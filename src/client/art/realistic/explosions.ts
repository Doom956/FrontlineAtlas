// The realistic style's explosions (client only): physical fire and smoke built from the baked puffs (puffs.ts), never
// clean discs or ring outlines. A blast is a short story told in layers:
//   flash      a white-hot light that blooms and is gone in a tenth of a second (added light, so it glows)
//   fireball   bright billowing fire puffs swelling out, cooling from yellow-white to deep orange and red
//   smoke      dark smoke rolling up out of the fire, rising (up the screen) and leaning with the wind as it thins
//   dust       on land a low skirt of earth thrown out round the base; bigger blasts push a ragged ring of dust out
//   debris     dark chunks flung out on arcs with hot streaks while fresh; sparks on metal (a ship or fort hit)
//   fire       (fireLinger) small flames still licking at the base after the blast
// Kinds: a shell (a small burst and a brown-black plume), a bomb (bigger, a dust ring), a hit on a ship or a fort
// (oily black smoke and sparks), a plane shot down (a burst in the air, burning pieces falling to the ground), a
// missile (a big fireball sized by its blast radius, a dust ring, a smoke column), the atom bomb (a blinding flash,
// a swelling fireball, a pale condensation ring racing out, the base surge of dust, and the mushroom cap seen from
// above rolling up over it), a splash (a white column of spray falling back, a ring of foam, droplets) and flak (a
// sharp flash and a black puff that hangs and drifts).
// Map aftermath: a ship sinking (boiling foam, an oil slick, wreckage going under), a plane going down (a trail of
// black smoke rising and drifting), dust after shells and a fort coming down.
// Motion: blastTime stretches the whole story, smokeLinger the smoke, fireLinger the flames left burning, debris the
// number of chunks, shockwave the dust ring. Reduced motion: one still frame of the blast that fades out.
import type { MotionParams } from '../motion';
import { rnd } from '../shared/noise';
import type { BlastDraw, BlastKind, ExplosionArt, MapFxDraw } from '../types';
import { clamp01, debris, easeOut, easeOut3, flashOver, glow, Puff, puff, ramp, sparks, WIND_X, WIND_Y } from './puffs';

/** The size unit of an effect at a zoom (CSS px): small blasts stay readable far out and do not swamp close up. */
export const unitPx = (zoom: number): number => Math.max(3.5, Math.min(16, zoom * 0.55));

interface Spec {
  /** fireball radius in size units */
  r: number;
  /** how long the fire and the smoke last at blastTime 1 (ms) */
  fire: number;
  smoke: number;
  /** puffs of fire and smoke, debris chunks, sparks */
  nFire: number;
  nSmoke: number;
  nDebris: number;
  nSparks: number;
  /** a low dust skirt (on land) and a dust ring (bigger blasts) */
  dust: boolean;
  ring: boolean;
  /** smoke colour: dark (oily), grey */
  smokeKind: Puff;
}

const SPEC: Record<BlastKind, Spec> = {
  shell: { r: 1.25, fire: 340, smoke: 900, nFire: 4, nSmoke: 4, nDebris: 7, nSparks: 0, dust: true, ring: false, smokeKind: Puff.GREY },
  bomb: { r: 1.75, fire: 440, smoke: 1150, nFire: 6, nSmoke: 5, nDebris: 11, nSparks: 0, dust: true, ring: true, smokeKind: Puff.GREY },
  hit: { r: 1.5, fire: 520, smoke: 1300, nFire: 5, nSmoke: 5, nDebris: 6, nSparks: 9, dust: false, ring: false, smokeKind: Puff.DARK },
  air: { r: 1.2, fire: 380, smoke: 950, nFire: 4, nSmoke: 4, nDebris: 6, nSparks: 4, dust: false, ring: false, smokeKind: Puff.DARK },
  missile: { r: 2.4, fire: 900, smoke: 2100, nFire: 7, nSmoke: 8, nDebris: 16, nSparks: 0, dust: true, ring: true, smokeKind: Puff.DARK },
  atom: { r: 4, fire: 1900, smoke: 3200, nFire: 14, nSmoke: 14, nDebris: 0, nSparks: 0, dust: true, ring: true, smokeKind: Puff.GREY },
  splash: { r: 1.1, fire: 0, smoke: 800, nFire: 0, nSmoke: 6, nDebris: 0, nSparks: 0, dust: false, ring: false, smokeKind: Puff.SPRAY },
  flak: { r: 0.9, fire: 160, smoke: 1000, nFire: 2, nSmoke: 3, nDebris: 0, nSparks: 3, dust: false, ring: false, smokeKind: Puff.SOOT },
};

/** Flames left burning after a blast at fireLinger 1 (ms; the small blasts less). */
const LINGER: Record<BlastKind, number> = { shell: 500, bomb: 900, hit: 1400, air: 0, missile: 1600, atom: 2400, splash: 0, flak: 0 };

function durationMs(kind: BlastKind, m: MotionParams): number {
  const s = SPEC[kind];
  return (s.fire + s.smoke * m.smokeLinger + LINGER[kind] * m.fireLinger) * m.blastTime;
}

/** The fireball radius (px) of a blast: missiles and atom bombs grow with their blast radius. */
function fireR(b: BlastDraw): number {
  const u = unitPx(b.zoom);
  const s = SPEC[b.kind];
  if (b.kind === 'missile') return Math.max(s.r * u, Math.min(120, b.rt * b.zoom * 0.3));
  if (b.kind === 'atom') return Math.max(s.r * u, b.rt * b.zoom * 0.34);
  if (b.kind === 'bomb') return Math.max(s.r * u, Math.min(26, b.zoom * 1.05));
  return s.r * u;
}

// ------------------------------------------------------------------------------------------------- one blast

function blast(ctx: CanvasRenderingContext2D, b: BlastDraw, m: MotionParams): void {
  const s = SPEC[b.kind];
  const dur = Math.max(1, b.durMs);
  // the story's own clock (ms at blastTime 1); reduced motion: one frame from the fire, fading out
  const tt = b.reduced ? s.fire * 0.55 + 60 : (b.ageMs / Math.max(0.2, m.blastTime));
  const fade = b.reduced ? 1 - clamp01(b.t) : 1;
  const R = fireR(b);
  const seed = b.seed * 977 + 13;
  const x = b.x;
  const y = b.kind === 'air' || b.kind === 'flak' ? b.y - unitPx(b.zoom) * 1.5 : b.y;
  const prev = ctx.globalAlpha;
  ctx.globalAlpha = prev * fade;
  const smokeEnd = s.fire + s.smoke * m.smokeLinger;
  const lingerEnd = smokeEnd + LINGER[b.kind] * m.fireLinger;
  void dur;

  // dust skirt: earth thrown out low round the base, settling
  if (s.dust && tt < smokeEnd) {
    const q = clamp01(tt / (s.fire + s.smoke * 0.6 * m.smokeLinger));
    const n = b.kind === 'shell' ? 4 : 6;
    for (let i = 0; i < n; i++) {
      const a = rnd(seed, i + 40) * Math.PI * 2;
      const d = R * (0.5 + 0.9 * easeOut3(q)) * (0.7 + rnd(seed, i + 50) * 0.5);
      const r = R * (0.55 + 0.7 * easeOut(q)) * (0.7 + rnd(seed, i + 60) * 0.4);
      puff(ctx, Puff.DUST, i, x + Math.cos(a) * d, y + Math.sin(a) * d * 0.75, r, 0.7 * (1 - q) * ramp(tt, 0, 60));
    }
  }
  // a ragged ring of dust pushed out by the blast (shockwave)
  if (s.ring && m.shockwave > 0) {
    const ringT = b.kind === 'atom' ? 1600 : b.kind === 'missile' ? 900 : 600;
    const q = tt / ringT;
    if (q > 0 && q < 1) {
      const maxR = (b.kind === 'atom' ? b.rt * b.zoom * 1.05 : b.kind === 'missile' ? Math.max(R * 2.6, b.rt * b.zoom * 0.8) : R * 2.6) * m.shockwave;
      const rr = maxR * easeOut3(q);
      // overlapping puffs at uneven distances: a ragged wall of dust, never a clean ring
      const n = b.kind === 'atom' ? 34 : b.kind === 'missile' ? 24 : 16;
      const pr = Math.max(2, maxR * (b.kind === 'atom' ? 0.12 : 0.17)) * (0.6 + q * 0.8);
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2 + rnd(seed, i + 70) * 0.5;
        const jr = rr * (0.8 + rnd(seed, i + 80) * 0.35);
        puff(ctx, Puff.DUST, i + 2, x + Math.cos(a) * jr, y + Math.sin(a) * jr * 0.8, pr * (0.6 + rnd(seed, i + 90) * 0.8), 0.36 * (1 - q) * (1 - q));
      }
    }
  }
  if (b.kind === 'atom') atomCloud(ctx, b, m, tt, R, seed, x, y);
  else if (b.kind === 'splash') splash(ctx, b, tt, R, seed, x, y, m);
  else {
    // smoke rolling up out of the fire: the old puffs under the young ones
    if (tt > s.fire * 0.25 && tt < smokeEnd) {
      const sd = s.smoke * m.smokeLinger;
      for (let i = s.nSmoke - 1; i >= 0; i--) {
        const born = s.fire * (0.2 + 0.5 * (i / Math.max(1, s.nSmoke)));
        const q = (tt - born) / (sd + s.fire - born);
        if (q <= 0 || q >= 1) continue;
        const a = rnd(seed, i + 100) * Math.PI * 2;
        const d = R * 0.45 * rnd(seed, i + 110);
        const rise = R * (1.4 + rnd(seed, i + 120)) * easeOut(q);
        const drift = R * 1.3 * q * q;
        const r = R * (0.55 + 1.05 * easeOut(q)) * (0.8 + rnd(seed, i + 130) * 0.4);
        const al = 0.85 * ramp(q, 0, 0.12) * (1 - q) * (1 - q * 0.3);
        puff(ctx, i % 3 === 2 && s.smokeKind === Puff.GREY ? Puff.DARK : s.smokeKind, i, x + Math.cos(a) * d + WIND_X * drift, y + Math.sin(a) * d * 0.7 - rise + WIND_Y * drift, r, al);
      }
    }
    // the fireball: swelling, then cooling into embers and sinking into the smoke
    if (tt < s.fire) {
      const q = tt / s.fire;
      for (let i = 0; i < s.nFire; i++) {
        const a = rnd(seed, i) * Math.PI * 2;
        const d = R * (0.15 + 0.5 * rnd(seed, i + 10)) * easeOut(Math.min(1, q * 2.2));
        const r = R * (0.45 + 0.55 * easeOut(Math.min(1, q * 1.8))) * (0.75 + rnd(seed, i + 20) * 0.5);
        const hot = 1 - q;
        const px = x + Math.cos(a) * d;
        const py = y + Math.sin(a) * d * 0.8 - R * 0.3 * q;
        puff(ctx, Puff.EMBER, i + 1, px, py, r * 1.05, 0.9 * ramp(q, 0, 0.05) * (1 - ramp(q, 0.55, 1)));
        puff(ctx, Puff.FIRE, i, px, py, r * (0.6 + 0.4 * hot), hot * hot * 1.1);
      }
      glow(ctx, x, y, R * 2.6, 0.55 * (1 - q) * (1 - q));
    }
    // flames still licking at the base, flickering
    if (LINGER[b.kind] > 0 && m.fireLinger > 0 && tt > s.fire * 0.6 && tt < lingerEnd) {
      const q = (tt - s.fire * 0.6) / (lingerEnd - s.fire * 0.6);
      const n = b.kind === 'missile' || b.kind === 'hit' ? 4 : 2;
      for (let i = 0; i < n; i++) {
        const fl = 0.7 + 0.3 * Math.sin(tt / 70 + i * 2.1 + seed);
        const a = rnd(seed, i + 300) * Math.PI * 2;
        const d = R * 0.5 * rnd(seed, i + 310);
        puff(ctx, Puff.FIRE, i + 3, x + Math.cos(a) * d, y + Math.sin(a) * d * 0.7 - R * 0.15, R * 0.32 * fl, 0.8 * (1 - q) * ramp(q, 0, 0.1));
      }
      glow(ctx, x, y, R * 1.4, 0.25 * (1 - q));
    }
    // debris and sparks
    const nd = Math.round(s.nDebris * m.debris);
    if (nd > 0) debris(ctx, x, y, nd, R * (b.kind === 'missile' ? 3.4 : 2.8), tt / (s.fire * 1.8), seed, Math.max(0.8, R * 0.09), true);
    if (s.nSparks) sparks(ctx, x, y, Math.round(s.nSparks * Math.max(0.5, m.debris)), R * 2.2, tt / (s.fire * 1.2), seed, Math.max(0.6, R * 0.05));
    if (b.kind === 'air' && tt < s.fire * 3) fallingPieces(ctx, x, y, b.y, tt / (s.fire * 3), seed, R);
    // the flash: a blink of white-hot light, gone in a few frames
    if (tt < 80) {
      const q = tt / 80;
      glow(ctx, x, y, R * (1.6 + q * 0.6), 0.75 * (1 - q));
      flashOver(ctx, x, y, R * (0.7 + q * 0.4), (1 - q) * 0.8);
    }
  }
  ctx.globalAlpha = prev;
}

/** A plane's burning pieces falling from the burst to the ground, each trailing smoke. */
function fallingPieces(ctx: CanvasRenderingContext2D, x: number, y: number, ground: number, q: number, seed: number, R: number): void {
  if (q <= 0 || q >= 1) return;
  for (let i = 0; i < 3; i++) {
    const a = rnd(seed, i + 500) * Math.PI * 2;
    const out = R * (0.8 + rnd(seed, i + 510)) * q;
    const fall = (ground - y) * q * q;
    const px = x + Math.cos(a) * out;
    const py = y + Math.sin(a) * out * 0.6 + fall;
    for (let j = 1; j <= 3; j++) {
      const qj = Math.max(0, q - j * 0.07);
      puff(ctx, Puff.DARK, i + j, x + Math.cos(a) * R * (0.8 + rnd(seed, i + 510)) * qj, y + Math.sin(a) * R * 0.6 * qj + (ground - y) * qj * qj - j * R * 0.1, R * (0.25 + j * 0.1), 0.5 * (1 - q) * (1 - j * 0.25));
    }
    puff(ctx, Puff.FIRE, i, px, py, R * 0.22, 0.9 * (1 - q));
  }
}

/** A shell or bomb landing in water: a white column of spray falling back, foam spreading, droplets. */
function splash(ctx: CanvasRenderingContext2D, b: BlastDraw, tt: number, R: number, seed: number, x: number, y: number, m: MotionParams): void {
  const total = SPEC.splash.smoke * m.smokeLinger;
  const q = clamp01(tt / total);
  // foam spreading on the water: a ragged patch of white water, thinning out as it grows
  const n = 7;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + rnd(seed, i) * 0.9;
    const d = R * (0.3 + 1.2 * easeOut3(q)) * (0.6 + rnd(seed, i + 7) * 0.7);
    puff(ctx, Puff.SPRAY, i, x + Math.cos(a) * d, y + Math.sin(a) * d * 0.8, R * (0.6 + 0.6 * q) * (0.7 + rnd(seed, i + 9) * 0.6), 0.42 * (1 - q) * (1 - q));
  }
  // the column: rising fast, then falling back and spreading
  const up = Math.sin(Math.PI * Math.min(1, q * 1.6));
  for (let i = 0; i < 5; i++) {
    const a = rnd(seed, i + 20) * Math.PI * 2;
    const d = R * 0.35 * rnd(seed, i + 30) * (1 + q * 2);
    puff(ctx, Puff.SPRAY, i + 3, x + Math.cos(a) * d, y + Math.sin(a) * d * 0.7 - R * 1.6 * up * (0.6 + rnd(seed, i + 40) * 0.6), R * (0.45 + 0.5 * q), 0.9 * (1 - q * q));
  }
  // droplets
  if (q < 0.7) {
    ctx.fillStyle = '#eef6f9';
    const prev = ctx.globalAlpha;
    ctx.globalAlpha = prev * (1 - q / 0.7);
    for (let i = 0; i < 10; i++) {
      const a = rnd(seed, i + 60) * Math.PI * 2;
      const d = R * (0.8 + 1.8 * rnd(seed, i + 70)) * easeOut(q / 0.7);
      const h = R * 1.4 * Math.sin(Math.PI * Math.min(1, q / 0.7));
      const s = Math.max(0.7, R * 0.07);
      ctx.fillRect(x + Math.cos(a) * d - s / 2, y + Math.sin(a) * d * 0.7 - h * rnd(seed, i + 80) - s / 2, s, s);
    }
    ctx.globalAlpha = prev;
  }
  void b;
}

/**
 * The atom bomb seen from above: a blinding flash, the fireball swelling, a pale condensation ring racing out, the
 * base surge of dust rolling out low, and the mushroom cap rolling up over the centre, glowing from below at first.
 */
function atomCloud(ctx: CanvasRenderingContext2D, b: BlastDraw, m: MotionParams, tt: number, R: number, seed: number, x: number, y: number): void {
  const s = SPEC.atom;
  const smokeEnd = s.fire + s.smoke * m.smokeLinger;
  const W = b.rt * b.zoom;
  // the condensation ring: pale vapour racing out and vanishing
  if (tt < 1100 && m.shockwave > 0) {
    const q = tt / 1100;
    const rr = W * 1.25 * easeOut3(q) * m.shockwave;
    const n = 40;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + rnd(seed, i + 900) * 0.4;
      const jr = rr * (0.88 + rnd(seed, i + 905) * 0.24);
      puff(ctx, Puff.WHITE, i, x + Math.cos(a) * jr, y + Math.sin(a) * jr * 0.85, Math.max(3, W * 0.15) * (0.5 + q) * (0.7 + rnd(seed, i + 910) * 0.6), 0.32 * (1 - q) * (1 - q));
    }
  }
  // the base surge: a low, wide skirt of dust rolling out
  if (tt > 250 && tt < smokeEnd) {
    const q = (tt - 250) / (smokeEnd - 250);
    const n = 26;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + rnd(seed, i + 950) * 0.6;
      const d = W * (0.3 + 0.6 * easeOut(q)) * (0.6 + rnd(seed, i + 960) * 0.55);
      puff(ctx, Puff.DUST, i, x + Math.cos(a) * d, y + Math.sin(a) * d * 0.8, W * (0.18 + 0.14 * q) * (0.7 + rnd(seed, i + 970) * 0.6), 0.6 * ramp(q, 0, 0.08) * (1 - q));
    }
  }
  // the cap: grey rolling cloud over the centre, rising (up the screen) and drifting, lit orange from below early on
  if (tt > 300 && tt < smokeEnd) {
    const q = (tt - 300) / (smokeEnd - 300);
    const rise = W * 0.18 * easeOut(q);
    const drift = W * 0.12 * q * q;
    const capR = R * (0.8 + 0.9 * easeOut(q));
    for (let i = 0; i < s.nSmoke; i++) {
      const a = (i / s.nSmoke) * Math.PI * 2 + rnd(seed, i + 700) * 0.5;
      const d = capR * (i % 3 === 0 ? 0.15 : 0.62) * (0.8 + rnd(seed, i + 710) * 0.4);
      const px = x + Math.cos(a) * d + WIND_X * drift;
      const py = y + Math.sin(a) * d * 0.85 - rise + WIND_Y * drift;
      const r = capR * (0.42 + rnd(seed, i + 720) * 0.2);
      const al = ramp(q, 0, 0.1) * (1 - ramp(q, 0.55, 1));
      puff(ctx, Puff.GREY, i, px, py, r, 0.9 * al);
      if (q < 0.45) puff(ctx, Puff.EMBER, i + 2, px, py + r * 0.2, r * 0.8, 0.55 * (1 - q / 0.45) * al);
    }
    // the top of the cap catches the sun
    puff(ctx, Puff.WHITE, 4, x + WIND_X * drift - capR * 0.15, y - rise + WIND_Y * drift - capR * 0.2, capR * 0.6, 0.4 * ramp(q, 0.05, 0.2) * (1 - ramp(q, 0.5, 1)));
  }
  // the fireball: swelling, white-hot, then orange and red as it cools and is swallowed by the cap
  if (tt < s.fire) {
    const q = tt / s.fire;
    for (let i = 0; i < s.nFire; i++) {
      const a = rnd(seed, i + 800) * Math.PI * 2;
      const d = R * 0.55 * rnd(seed, i + 810) * easeOut(Math.min(1, q * 2));
      const r = R * (0.45 + 0.6 * easeOut(Math.min(1, q * 1.6))) * (0.8 + rnd(seed, i + 820) * 0.4);
      const hot = 1 - q;
      puff(ctx, Puff.EMBER, i, x + Math.cos(a) * d, y + Math.sin(a) * d * 0.85 - W * 0.05 * q, r * 1.05, 0.95 * (1 - ramp(q, 0.6, 1)));
      puff(ctx, Puff.FIRE, i + 1, x + Math.cos(a) * d, y + Math.sin(a) * d * 0.85 - W * 0.05 * q, r * (0.55 + 0.45 * hot), Math.min(1, hot * 1.3));
    }
    glow(ctx, x, y, R * 3.2, 0.8 * (1 - q) * (1 - q));
  }
  // the flash: blinding, far wider than the fireball
  if (tt < 320) {
    const q = tt / 320;
    glow(ctx, x, y, W * (1.1 + q * 0.5), 1 - q);
    flashOver(ctx, x, y, R * (1.2 + q), 1 - q);
  }
}

// ------------------------------------------------------------------------------------------------- map aftermath

function mapFx(ctx: CanvasRenderingContext2D, f: MapFxDraw, m: MotionParams): void {
  const t = f.t;
  if (t < 0 || t >= 1) return;
  const u = unitPx(f.zoom);
  const seed = f.seed * 811 + 7;
  const { x, y } = f;
  const prev = ctx.globalAlpha;
  switch (f.kind) {
    case 'splash': {
      // a ship going down: an oil slick spreading, boiling foam, wreckage going under
      const R = u * 2.2;
      ctx.globalAlpha = prev * 0.45 * (1 - t);
      ctx.fillStyle = 'rgba(14,16,20,0.6)';
      ctx.beginPath();
      ctx.ellipse(x + WIND_X * R * t, y + WIND_Y * R * t * 0.5, R * (0.8 + 1.2 * easeOut(t)), R * (0.5 + 0.8 * easeOut(t)), 0.4, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = prev;
      for (let i = 0; i < 9; i++) {
        const a = rnd(seed, i) * Math.PI * 2;
        const d = R * (0.3 + 1.2 * rnd(seed, i + 10)) * (0.5 + t);
        const ph = (t * 3 + rnd(seed, i + 20)) % 1;
        puff(ctx, Puff.SPRAY, i, x + Math.cos(a) * d, y + Math.sin(a) * d * 0.75, u * (0.4 + ph * 0.6), 0.55 * (1 - ph) * (1 - t));
      }
      const sink = 1 - easeOut(t);
      if (sink > 0.05) {
        ctx.fillStyle = '#2c3034';
        for (let i = 0; i < 4; i++) {
          const a = rnd(seed, i + 40) * Math.PI * 2;
          const d = R * (0.3 + 0.9 * t) * (0.6 + rnd(seed, i + 50));
          const w = u * (0.9 - i * 0.15) * sink;
          ctx.globalAlpha = prev * 0.9 * sink;
          ctx.save();
          ctx.translate(x + Math.cos(a) * d, y + Math.sin(a) * d * 0.7);
          ctx.rotate(a * 2);
          ctx.fillRect(-w, -w * 0.35, w * 2, w * 0.7);
          ctx.restore();
        }
      }
      break;
    }
    case 'smoke': {
      // a plane going down: black smoke rising off it and drifting with the wind
      const n = 6;
      for (let i = n - 1; i >= 0; i--) {
        const q = clamp01((t - i * 0.06) / 0.9);
        if (q <= 0 || q >= 1) continue;
        const rise = u * 3.2 * easeOut(q);
        const drift = u * 3.5 * q;
        const r = u * (0.6 + 1.4 * easeOut(q));
        puff(ctx, i % 2 ? Puff.DARK : Puff.GREY, i, x + WIND_X * drift + (rnd(seed, i) - 0.5) * u, y + WIND_Y * drift - rise, r, 0.7 * ramp(q, 0, 0.1) * (1 - q));
      }
      break;
    }
    case 'dust':
    case 'fortDust': {
      const fort = f.kind === 'fortDust';
      const spread = fort ? Math.max(u * 2.5, f.zoom * 1.2) : Math.max(u * 2.5, f.rt * f.zoom * 0.6);
      const n = fort ? 10 : 7;
      for (let i = 0; i < n; i++) {
        const q = clamp01((t - (fort ? 0 : 0.15 + i * 0.05)) / (fort ? 1 : 0.8));
        if (q <= 0 || q >= 1) continue;
        const a = rnd(seed, i) * Math.PI * 2;
        const d = fort ? spread * (0.3 + 0.9 * easeOut(q)) : spread * (0.2 + 0.7 * rnd(seed, i + 10));
        const r = u * (fort ? 1 + 1.6 * easeOut(q) : 0.8 + 1.4 * easeOut(q));
        puff(ctx, Puff.DUST, i, x + Math.cos(a) * d + WIND_X * u * q, y + Math.sin(a) * d * 0.75 - u * 0.8 * q, r, (fort ? 0.6 : 0.45) * ramp(q, 0, 0.15) * (1 - q));
      }
      if (fort) debris(ctx, x, y, Math.round(8 * m.debris), u * 4, t * 2.2, seed, Math.max(0.8, u * 0.18), false);
      break;
    }
  }
  ctx.globalAlpha = prev;
}

export const realisticExplosions: ExplosionArt = {
  durationMs,
  draw: blast,
  drawMapFx: mapFx,
};
