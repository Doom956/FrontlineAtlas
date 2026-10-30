// Small helpers shared by the map renderer modules (client only).
import { buildingVersion } from '../../sim/buildings';
import type { GameState } from '../../sim/types';

export type RGB = [number, number, number];

/** Visible tile window, [x0, x1) x [y0, y1). */
export interface View {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
export function css(c: RGB | readonly number[], a = 1): string {
  return a >= 1 ? `rgb(${c[0]},${c[1]},${c[2]})` : `rgba(${c[0]},${c[1]},${c[2]},${a})`;
}
/** Multiplies a colour (f < 1 darker). */
export function shade(c: RGB | readonly number[], f: number): RGB {
  return [clamp(Math.round(c[0] * f), 0, 255), clamp(Math.round(c[1] * f), 0, 255), clamp(Math.round(c[2] * f), 0, 255)];
}
export function mix(a: RGB | readonly number[], b: RGB | readonly number[], t: number): RGB {
  return [Math.round(a[0] + (b[0] - a[0]) * t), Math.round(a[1] + (b[1] - a[1]) * t), Math.round(a[2] + (b[2] - a[2]) * t)];
}
export function makeCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = Math.max(1, w);
  c.height = Math.max(1, h);
  return c;
}
export function ctx2d(c: HTMLCanvasElement, opts?: CanvasRenderingContext2DSettings): CanvasRenderingContext2D {
  const ctx = c.getContext('2d', opts);
  if (!ctx) throw new Error('2D canvas not supported');
  return ctx;
}

/** 1234 -> "1.2k", 2.5e6 -> "2.50M". */
export function formatCount(n: number): string {
  const v = Math.max(0, n);
  if (v < 1000) return String(Math.round(v));
  if (v < 1e6) return (v / 1000).toFixed(v < 1e4 ? 1 : 0) + 'k';
  return (v / 1e6).toFixed(v < 1e7 ? 2 : 1) + 'M';
}

/** Cache key that changes whenever a building is added, removed, upgraded, finished or changes owner. */
export function buildingsKey(state: GameState): number {
  const v = (state as { buildingsVersion?: number }).buildingsVersion;
  if (typeof v === 'number') return v;
  // Older states without the counter: a signature that catches additions, removals and finishing.
  return buildingVersion(state) * 7919 + state.buildings.size * 31 + state.nextId;
}

/** Small rounded label with a coloured edge; `arrow` adds a chevron (own push up / incoming down). */
export function pill(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  text: string,
  edge: string,
  arrow: 'up' | 'down' | 'none',
  fill = 'rgba(10,13,21,0.84)',
): void {
  ctx.font = "600 11px 'IBM Plex Sans', system-ui, sans-serif";
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const tw = ctx.measureText(text).width;
  const ax = arrow === 'none' ? 0 : 9;
  const bw = tw + 12 + ax;
  const bh = 17;
  const x0 = x - bw / 2;
  const y0 = y - bh / 2;
  ctx.beginPath();
  ctx.roundRect(x0, y0, bw, bh, 8);
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = edge;
  ctx.stroke();
  if (arrow !== 'none') {
    const cx = x0 + 9;
    const d = arrow === 'up' ? -1 : 1;
    ctx.beginPath();
    ctx.moveTo(cx - 3.5, y - d * 2);
    ctx.lineTo(cx, y + d * 2);
    ctx.lineTo(cx + 3.5, y - d * 2);
    ctx.strokeStyle = edge;
    ctx.lineWidth = 1.8;
    ctx.stroke();
  }
  ctx.fillStyle = '#fff';
  ctx.fillText(text, x + ax / 2, y + 0.5);
}

export function dashedLine(ctx: CanvasRenderingContext2D, x1: number, y1: number, x2: number, y2: number, color: string): void {
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.setLineDash([8, 6]);
  ctx.lineWidth = 2;
  ctx.strokeStyle = color;
  ctx.stroke();
  ctx.setLineDash([]);
}
