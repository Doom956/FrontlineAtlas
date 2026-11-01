// Pooled map effects drawn on the overlay canvas (CSS px). A fixed set of records is reused: no allocation per
// effect, no per-particle objects (the few particles of an effect are placed from its seed). Plain arcs and
// rectangles only, no gradients or shadows, so a full pool costs a fraction of a millisecond.

import { MAP_LABEL_FAMILY } from '../render/common';
import { FX_INFO, fxLabel, type FxKind } from './map';

export const FX_CAP = 40;

export interface FxRec {
  kind: FxKind;
  x: number;
  y: number;
  r: number;
  t0: number;
  seed: number;
}

export interface ScreenCam {
  zoom: number;
  viewW: number;
  viewH: number;
  tileToScreen(tx: number, ty: number): { x: number; y: number };
}

const TAU = Math.PI * 2;
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const easeOut = (t: number) => 1 - (1 - t) * (1 - t);

// War-room palette: warm paper white for your gains, signal red for losses, sea foam, smoke grey, earth dust.
const GAIN = '242,210,138';
const LOSS = '235,104,86';
const FOAM = '214,236,255';
const SMOKE = '150,150,146';
const DUST = '176,156,124';
const WAVE = '255,236,204';

export class FxPool {
  readonly recs: FxRec[] = [];
  live = 0;
  private counts = new Map<FxKind, number>();

  constructor(readonly cap = FX_CAP) {
    for (let i = 0; i < cap; i++) this.recs.push({ kind: 'ripple', x: 0, y: 0, r: 0, t0: 0, seed: 0 });
  }

  countOf(kind: FxKind): number {
    return this.counts.get(kind) ?? 0;
  }

  /** Adds an effect; with a full pool the oldest cosmetic one is replaced (false when none can be). */
  add(kind: FxKind, x: number, y: number, r: number, now: number): boolean {
    let rec: FxRec | undefined;
    if (this.live < this.cap) rec = this.recs[this.live++];
    else {
      let oldest = -1;
      for (let i = 0; i < this.live; i++) {
        const k = this.recs[i];
        if (FX_INFO[k.kind].priority === 0 && (oldest < 0 || k.t0 < this.recs[oldest].t0)) oldest = i;
      }
      if (oldest < 0) return false;
      rec = this.recs[oldest];
      this.counts.set(rec.kind, this.countOf(rec.kind) - 1);
    }
    rec.kind = kind;
    rec.x = x;
    rec.y = y;
    rec.r = r;
    rec.t0 = now;
    rec.seed = fract(Math.sin(x * 12.9898 + y * 78.233 + now * 0.001) * 43758.5453);
    this.counts.set(kind, this.countOf(kind) + 1);
    return true;
  }

  /** Drops finished effects (swap-remove, order does not matter). */
  prune(now: number): void {
    for (let i = this.live - 1; i >= 0; i--) {
      const rec = this.recs[i];
      if (now - rec.t0 < FX_INFO[rec.kind].dur && now >= rec.t0) continue;
      this.counts.set(rec.kind, this.countOf(rec.kind) - 1);
      const last = this.recs[this.live - 1];
      this.recs[this.live - 1] = rec;
      this.recs[i] = last;
      this.live--;
    }
  }

  clear(): void {
    this.live = 0;
    this.counts.clear();
  }

  draw(ctx: CanvasRenderingContext2D, cam: ScreenCam, now: number): void {
    if (this.live === 0) return;
    const z = cam.zoom;
    ctx.save();
    for (let i = 0; i < this.live; i++) {
      const f = this.recs[i];
      const t = clamp01((now - f.t0) / FX_INFO[f.kind].dur);
      const s = cam.tileToScreen(f.x, f.y);
      const reach = Math.max(60, f.r * z * 2.6);
      if (s.x < -reach || s.y < -reach || s.x > cam.viewW + reach || s.y > cam.viewH + reach) continue;
      drawOne(ctx, f, s.x, s.y, t, z);
    }
    ctx.restore();
  }
}

function fract(v: number): number {
  return v - Math.floor(v);
}

function ring(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, width: number, rgb: string, a: number): void {
  if (a <= 0.005 || r <= 0) return;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, TAU);
  ctx.lineWidth = width;
  ctx.strokeStyle = `rgba(${rgb},${a.toFixed(3)})`;
  ctx.stroke();
}

function disc(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, rgb: string, a: number): void {
  if (a <= 0.005 || r <= 0) return;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, TAU);
  ctx.fillStyle = `rgba(${rgb},${a.toFixed(3)})`;
  ctx.fill();
}

function drawOne(ctx: CanvasRenderingContext2D, f: FxRec, x: number, y: number, t: number, z: number): void {
  // size scale for the small effects: readable zoomed out, not huge zoomed in
  const k = Math.min(1.6, Math.max(0.7, z / 8));
  switch (f.kind) {
    case 'ripple': {
      const r = Math.max(5, z * 0.7) + Math.max(10, z * 1.8) * easeOut(t);
      ring(ctx, x, y, r, 1.5, GAIN, 0.5 * (1 - t) * (1 - t));
      if (t < 0.3) disc(ctx, x, y, Math.max(3, z * 0.55), GAIN, 0.18 * (1 - t / 0.3));
      break;
    }
    case 'cityTaken':
    case 'cityLost':
    case 'capitalTaken':
    case 'capitalLost': {
      const capital = f.kind === 'capitalTaken' || f.kind === 'capitalLost';
      const rgb = f.kind === 'cityTaken' || f.kind === 'capitalTaken' ? GAIN : LOSS;
      const maxR = capital ? 54 : 36;
      const n = capital ? 3 : 2;
      for (let j = 0; j < n; j++) {
        const tj = t * 1.6 - j * 0.22;
        if (tj <= 0 || tj >= 1) continue;
        ring(ctx, x, y, 6 + (maxR - 6) * easeOut(tj), capital ? 2.25 : 1.75, rgb, 0.8 * (1 - tj) * (1 - tj));
      }
      if (t < 0.12) disc(ctx, x, y, 7, rgb, 0.35 * (1 - t / 0.12));
      label(ctx, fxLabel(f.kind) ?? '', x, y - (capital ? 36 : 30), t, rgb, capital);
      break;
    }
    case 'splash': {
      const R = 16 * k;
      ring(ctx, x, y, 3 + R * easeOut(t), 1.5, FOAM, 0.6 * (1 - t) * (1 - t));
      const t2 = clamp01((t - 0.15) / 0.85);
      if (t2 > 0) ring(ctx, x, y, 2 + R * 0.6 * easeOut(t2), 1, FOAM, 0.45 * (1 - t2) * (1 - t2));
      // droplets: thrown up and out, then fall back
      const td = clamp01(t / 0.45);
      if (td < 1) {
        ctx.fillStyle = `rgba(${FOAM},${(0.8 * (1 - td)).toFixed(3)})`;
        for (let j = 0; j < 5; j++) {
          const a = f.seed * TAU + (j * TAU) / 5;
          const d = R * 0.7 * td;
          ctx.fillRect(x + Math.cos(a) * d - 1, y + Math.sin(a) * d * 0.6 - 10 * k * td * (1 - td) * 2 - 1, 2, 2);
        }
      }
      // hull fragments: drift apart, tilt, shrink as they go under
      const sink = 1 - easeOut(t);
      if (sink > 0.05) {
        ctx.fillStyle = `rgba(52,58,66,${(0.85 * sink).toFixed(3)})`;
        for (let j = 0; j < 3; j++) {
          const a = f.seed * 5 + j * 2.1;
          const d = 3 * k + 7 * k * easeOut(t);
          const w = (4 - j) * k * sink + 1;
          const fx = x + Math.cos(a) * d;
          const fy = y + Math.sin(a) * d * 0.7;
          ctx.save();
          ctx.translate(fx, fy);
          ctx.rotate(a + t * 1.5);
          ctx.fillRect(-w, -1, w * 2, 2);
          ctx.restore();
        }
      }
      break;
    }
    case 'smoke': {
      // a falling ember first, then puffs that grow and drift with the wind
      if (t < 0.3) {
        const te = t / 0.3;
        ctx.beginPath();
        ctx.moveTo(x - 6 * k, y - 10 * k + te * 4 * k);
        ctx.lineTo(x, y);
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = `rgba(255,190,120,${(0.8 * (1 - te)).toFixed(3)})`;
        ctx.stroke();
      }
      for (let j = 0; j < 4; j++) {
        const tj = clamp01((t - j * 0.08) / 0.92);
        if (tj <= 0) continue;
        const a = f.seed * TAU + j * 1.7;
        const r = (3 + 7 * easeOut(tj)) * k;
        const px = x + Math.cos(a) * 4 * k + tj * 8 * k;
        const py = y + Math.sin(a) * 3 * k - tj * 10 * k;
        disc(ctx, px, py, r, SMOKE, 0.38 * (1 - tj) * (1 - tj * 0.3));
      }
      break;
    }
    case 'dust':
    case 'fortDust': {
      const fort = f.kind === 'fortDust';
      const n = fort ? 7 : 4;
      const spread = fort ? Math.max(10, z * 1.2) : Math.max(10, f.r * z * 0.55);
      for (let j = 0; j < n; j++) {
        const tj = clamp01((t - (fort ? 0 : 0.18 + j * 0.06)) / (fort ? 1 : 0.76));
        if (tj <= 0) continue;
        const a = f.seed * TAU + (j * TAU) / n;
        const d = fort ? spread * (0.4 + 0.9 * easeOut(tj)) : spread * (0.3 + 0.6 * fract(f.seed * 7 + j * 0.37));
        const r = (fort ? 4 + 6 * easeOut(tj) : 3 + 5 * easeOut(tj)) * k;
        disc(ctx, x + Math.cos(a) * d, y + Math.sin(a) * d * 0.75 - tj * 3 * k, r, DUST, (fort ? 0.42 : 0.3) * (1 - tj) * (1 - tj));
      }
      if (fort && t < 0.4) {
        const td = t / 0.4;
        ctx.fillStyle = `rgba(90,80,66,${(0.9 * (1 - td)).toFixed(3)})`;
        for (let j = 0; j < 6; j++) {
          const a = f.seed * 3 + j * 1.05;
          const d = 4 * k + 14 * k * td;
          ctx.fillRect(x + Math.cos(a) * d - 1, y + Math.sin(a) * d - 8 * k * td * (1 - td) - 1, 2, 2);
        }
      }
      break;
    }
    case 'shockwave': {
      const R = Math.max(18, f.r * z);
      ring(ctx, x, y, R * (0.3 + 1.3 * easeOut(t)), 0.75 + 2 * (1 - t), WAVE, 0.65 * (1 - t) * (1 - t));
      break;
    }
    case 'nukeWave': {
      const R = Math.max(40, f.r * z);
      ring(ctx, x, y, R * (0.2 + 2.2 * easeOut(t)), 1 + 3.5 * (1 - t), WAVE, 0.75 * Math.pow(1 - t, 1.5));
      const t2 = clamp01((t - 0.12) / 0.88);
      if (t2 > 0) ring(ctx, x, y, R * (0.15 + 1.5 * easeOut(t2)), 1 + 2 * (1 - t2), '255,170,110', 0.5 * (1 - t2) * (1 - t2));
      break;
    }
  }
}

/** Short caps label on a dark chip: fades in, rises a few px, fades out. */
function label(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, t: number, rgb: string, big: boolean): void {
  if (!text) return;
  const a = t < 0.1 ? t / 0.1 : t > 0.75 ? (1 - t) / 0.25 : 1;
  if (a <= 0.01) return;
  const yy = y - 8 * easeOut(Math.min(1, t * 2));
  ctx.font = `600 ${big ? 14 : 12}px ${MAP_LABEL_FAMILY}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const up = text.toUpperCase();
  const w = ctx.measureText(up).width + 12;
  const h = big ? 20 : 17;
  ctx.globalAlpha = a;
  ctx.fillStyle = 'rgba(10,15,22,0.78)';
  ctx.beginPath();
  if (typeof ctx.roundRect === 'function') ctx.roundRect(x - w / 2, yy - h / 2, w, h, 3);
  else ctx.rect(x - w / 2, yy - h / 2, w, h);
  ctx.fill();
  ctx.fillStyle = `rgb(${rgb})`;
  ctx.fillRect(x - w / 2, yy - h / 2, 2, h);
  ctx.fillText(up, x + 1, yy + 0.5);
  ctx.globalAlpha = 1;
}
