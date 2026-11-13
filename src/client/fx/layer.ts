// Pooled map effects drawn on the overlay canvas (CSS px). A fixed set of records is reused: no allocation per
// effect, no per-particle objects (the few particles of an effect are placed from its seed). The rings and labels of
// captured cities are drawn here (plain arcs, no gradients or shadows); a sinking ship, a falling plane's smoke and
// dust are drawn by the current explosions art style (art/registry.ts).

import { MAP_LABEL_FAMILY } from '../render/common';
import { artFor, motionFor } from '../art/registry';
import type { MapFxDraw } from '../art/types';
import { FX_INFO, fxLabel, type FxKind } from './map';

const mapFxDraw: MapFxDraw = { kind: 'splash', x: 0, y: 0, t: 0, zoom: 1, seed: 0, rt: 0, dpr: 1 };

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
    case 'splash':
    case 'smoke':
    case 'dust':
    case 'fortDust': {
      // a ship sinking, a plane going down, dust after shells or a fort coming down: drawn by the explosions art style
      const d = mapFxDraw;
      d.kind = f.kind;
      d.x = x;
      d.y = y;
      d.t = t;
      d.zoom = z;
      d.seed = f.seed;
      d.rt = f.r;
      artFor('explosions').drawMapFx(ctx, d, motionFor('explosions'));
      ctx.globalAlpha = 1;
      break;
    }
    case 'shockwave':
      // the rocket / bomb blasts draw their own pixel ring (fx/pixelFx.ts)
      break;
    case 'nukeWave':
      // the atom bomb draws its own single pixel shockwave ring (fx/pixelFx.ts); this kind keeps the camera shake
      break;
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
