// Painting helpers of the realistic style (client only): colour maths, the one light, and the brushes every painter
// uses to draw a model miniature from above with the canvas API (soft lit gradients, cylinders and domes, raised
// blocks with a soft cast shadow, ambient occlusion along inner edges, a soft ground shadow, fine weathering).
//
// Painters draw in ART UNITS in the model's own frame: the nose or bow at +x, starboard at +y, the origin at the
// unit's centre. A bake (units.ts) sets the canvas transform so one art unit is `R` device px and the model is turned
// to its heading bucket; `lx, ly` is the direction TOWARD the light in that same frame, so a highlight or a cast
// shadow lands where the screen's top-left light puts it at every heading.
//
// Nothing here runs per frame on the map: these brushes are only used while baking a picture into an atlas.
import { rnd } from '../shared/noise';

export const TAU = Math.PI * 2;

/** Toward the light on screen: from the top left (a little more from the top). */
export const LIGHT_X = -0.6;
export const LIGHT_Y = -0.8;

export type Col = readonly [number, number, number];

export function hexCol(h: string): Col {
  const n = parseInt(h.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function mix(a: Col, b: Col, t: number): Col {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

const WHITE: Col = [255, 255, 255];
/** A cool near black for shade (never pure black: painted shade keeps a little colour). */
const SHADE: Col = [10, 12, 16];

export const lighten = (c: Col, t: number): Col => mix(c, WHITE, t);
export const darken = (c: Col, t: number): Col => mix(c, SHADE, t);

export function css(c: Col, a = 1): string {
  const r = Math.round(c[0]);
  const g = Math.round(c[1]);
  const b = Math.round(c[2]);
  return a >= 1 ? `rgb(${r},${g},${b})` : `rgba(${r},${g},${b},${Math.max(0, a).toFixed(3)})`;
}

export const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
export const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

/** What a painter draws with: the context (already in art units and turned), the light in the model frame, the scale. */
export interface Paint {
  ctx: CanvasRenderingContext2D;
  /** toward the light, in the model frame */
  lx: number;
  ly: number;
  /** device px per art unit */
  R: number;
}

export function painter(ctx: CanvasRenderingContext2D, angle: number, R: number): Paint {
  // the light is fixed on screen; the model is turned by `angle`, so in the model frame it is turned back
  const c = Math.cos(-angle);
  const s = Math.sin(-angle);
  return { ctx, lx: LIGHT_X * c - LIGHT_Y * s, ly: LIGHT_X * s + LIGHT_Y * c, R };
}

/** Paints `fn` in a frame moved to (x, y) and turned by `rot` (the light turned with it, so it stays on screen). */
export function turn(p: Paint, x: number, y: number, rot: number, fn: (q: Paint) => void): void {
  const c = p.ctx;
  c.save();
  c.translate(x, y);
  if (rot) c.rotate(rot);
  const cs = Math.cos(-rot);
  const sn = Math.sin(-rot);
  fn({ ctx: c, lx: p.lx * cs - p.ly * sn, ly: p.lx * sn + p.ly * cs, R: p.R });
  c.restore();
}

/** True when there is room for fine detail (planks, rivets, windows): at least this many device px per art unit. */
export const fine = (p: Paint, k = 1.6): boolean => p.R >= k;

/** A hairline about `px` device px wide, in art units. */
export const hair = (p: Paint, px = 0.8): number => px / p.R;

// ------------------------------------------------------------------------------------------------- shapes

export type Shape = (c: CanvasRenderingContext2D) => void;

export function rrect(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  c.moveTo(x + rr, y);
  c.lineTo(x + w - rr, y);
  c.arcTo(x + w, y, x + w, y + rr, rr);
  c.lineTo(x + w, y + h - rr);
  c.arcTo(x + w, y + h, x + w - rr, y + h, rr);
  c.lineTo(x + rr, y + h);
  c.arcTo(x, y + h, x, y + h - rr, rr);
  c.lineTo(x, y + rr);
  c.arcTo(x, y, x + rr, y, rr);
  c.closePath();
}

/** A rounded rectangle given by its centre and half sizes. */
export const box = (cx: number, cy: number, hw: number, hh: number, r: number): Shape => (c) => rrect(c, cx - hw, cy - hh, hw * 2, hh * 2, r);

export const oval = (cx: number, cy: number, rx: number, ry: number, rot = 0): Shape => (c) => {
  c.moveTo(cx + rx * Math.cos(rot), cy + rx * Math.sin(rot));
  c.ellipse(cx, cy, Math.max(0.01, rx), Math.max(0.01, ry), rot, 0, TAU);
};

export const polyShape = (pts: readonly number[]): Shape => (c) => {
  c.moveTo(pts[0], pts[1]);
  for (let i = 2; i < pts.length; i += 2) c.lineTo(pts[i], pts[i + 1]);
  c.closePath();
};

/** A polygon given by its port half (y <= 0, bow to stern), closed through its mirror. */
export function mirrored(half: readonly number[]): number[] {
  const out = [...half];
  for (let i = half.length - 2; i >= 0; i -= 2) if (half[i + 1] !== 0) out.push(half[i], -half[i + 1]);
  return out;
}

export function fillShape(c: CanvasRenderingContext2D, s: Shape, style: string | CanvasGradient): void {
  c.beginPath();
  s(c);
  c.fillStyle = style;
  c.fill();
}

export function strokeShape(c: CanvasRenderingContext2D, s: Shape, style: string, w: number): void {
  c.beginPath();
  s(c);
  c.lineWidth = w;
  c.strokeStyle = style;
  c.stroke();
}

// ------------------------------------------------------------------------------------------------- light

/** A flat top lit from the light: lighter toward it, darker away, across `s` art units round (cx, cy). */
export function litGrad(p: Paint, base: Col, cx: number, cy: number, s: number, k = 0.2): CanvasGradient {
  const g = p.ctx.createLinearGradient(cx + p.lx * s, cy + p.ly * s, cx - p.lx * s, cy - p.ly * s);
  g.addColorStop(0, css(lighten(base, k)));
  g.addColorStop(0.45, css(base));
  g.addColorStop(1, css(darken(base, k * 1.2)));
  return g;
}

/**
 * A cylinder lying along (ax, ay) through (cx, cy) with radius r: dark at both edges, a highlight shifted toward the
 * light (fuselages, barrels, booms, the hull of a submarine).
 */
export function cylGrad(p: Paint, base: Col, cx: number, cy: number, ax: number, ay: number, r: number, k = 0.32): CanvasGradient {
  const nx = -ay;
  const ny = ax;
  const d = p.lx * nx + p.ly * ny;
  const g = p.ctx.createLinearGradient(cx - nx * r, cy - ny * r, cx + nx * r, cy + ny * r);
  const hl = clamp(0.5 + 0.28 * d, 0.2, 0.8);
  g.addColorStop(0, css(darken(base, 0.42)));
  g.addColorStop(clamp(hl - 0.28, 0.05, 0.9), css(base));
  g.addColorStop(hl, css(lighten(base, k)));
  g.addColorStop(clamp(hl + 0.3, hl + 0.05, 0.95), css(base));
  g.addColorStop(1, css(darken(base, 0.5)));
  return g;
}

/** A dome or a sphere of radius r at (cx, cy): a soft highlight toward the light, a dark rim away from it. */
export function domeGrad(p: Paint, base: Col, cx: number, cy: number, r: number, k = 0.38): CanvasGradient {
  const g = p.ctx.createRadialGradient(cx + p.lx * r * 0.42, cy + p.ly * r * 0.42, r * 0.05, cx, cy, r * 1.02);
  g.addColorStop(0, css(lighten(base, k)));
  g.addColorStop(0.45, css(base));
  g.addColorStop(1, css(darken(base, 0.45)));
  return g;
}

/** Shadow offset (art units) of something `h` art units tall standing on what is under it. */
export const shadowAt = (p: Paint, h: number): [number, number] => [-p.lx * h, -p.ly * h];

/** A soft shadow cast by `s` (a raised part `h` units tall) onto what is under it: two offset fills. */
export function castShadow(p: Paint, s: Shape, h: number, a = 0.3): void {
  if (h <= 0) return;
  const c = p.ctx;
  for (const [k, al] of [
    [1, a * 0.55],
    [0.55, a * 0.6],
  ] as const) {
    c.save();
    c.translate(-p.lx * h * k, -p.ly * h * k);
    fillShape(c, s, `rgba(8,10,12,${al.toFixed(3)})`);
    c.restore();
  }
}

/**
 * A raised block: its soft cast shadow, a lit top, a darker edge all round and a thin highlight on its lit rim.
 * (cx, cy, s): its centre and about half its size, for the light gradient.
 */
export function block(p: Paint, s: Shape, base: Col, h: number, cx: number, cy: number, sz: number, o: { k?: number; edge?: number; shadow?: number } = {}): void {
  castShadow(p, s, h, o.shadow ?? 0.32);
  const c = p.ctx;
  fillShape(c, s, litGrad(p, base, cx, cy, sz, o.k ?? 0.2));
  edge(p, s, base, o.edge ?? 1);
}

/** A dark edge round a shape (ambient occlusion where a part meets what is under it), about one device px. */
export function edge(p: Paint, s: Shape, base: Col, k = 1): void {
  strokeShape(p.ctx, s, css(darken(base, 0.55), 0.75 * k), hair(p, 0.9));
}

/** A thin light rim on the lit side of a shape (a raised plate catching the light). */
export function rim(p: Paint, s: Shape, base: Col, a = 0.55): void {
  // the outline moved away from the light: on the lit side it lands just inside the shape, elsewhere it is clipped off
  const c = p.ctx;
  const d = hair(p, 1);
  c.save();
  c.beginPath();
  s(c);
  c.clip();
  c.translate(-p.lx * d, -p.ly * d);
  c.beginPath();
  s(c);
  c.lineWidth = hair(p, 1.3);
  c.strokeStyle = css(lighten(base, 0.45), a);
  c.stroke();
  c.restore();
}

/** Ambient occlusion inside a shape's edge: a soft dark band `w` art units wide along the inside of its outline. */
export function innerShade(p: Paint, s: Shape, w: number, a = 0.35): void {
  const c = p.ctx;
  c.save();
  c.beginPath();
  s(c);
  c.clip();
  for (const [k, al] of [
    [2, a * 0.45],
    [1, a * 0.55],
  ] as const) {
    c.beginPath();
    s(c);
    c.lineWidth = w * k;
    c.strokeStyle = `rgba(8,10,12,${al.toFixed(3)})`;
    c.stroke();
  }
  c.restore();
}

/** A soft ground shadow of `s`, offset by (dx, dy) art units, spreading `spread` units past its edge. */
export function softShadow(p: Paint, s: Shape, dx: number, dy: number, a: number, spread: number): void {
  const c = p.ctx;
  c.save();
  c.translate(dx, dy);
  c.lineJoin = 'round';
  fillShape(c, s, `rgba(6,8,10,${(a * 0.7).toFixed(3)})`);
  for (const k of [0.35, 0.7, 1.1]) strokeShape(c, s, `rgba(6,8,10,${(a * 0.16).toFixed(3)})`, spread * k * 2);
  c.restore();
}

/** Fine weathering inside a shape: `n` soft specks of `col` (grime, chipped paint), from `seed`. */
export function grime(p: Paint, s: Shape, x0: number, y0: number, x1: number, y1: number, seed: number, n: number, col: Col, a: number, size = 0.5): void {
  if (!fine(p, 1.3)) return;
  const c = p.ctx;
  c.save();
  c.beginPath();
  s(c);
  c.clip();
  for (let i = 0; i < n; i++) {
    const x = x0 + (x1 - x0) * rnd(seed, i * 3);
    const y = y0 + (y1 - y0) * rnd(seed, i * 3 + 1);
    const r = size * (0.4 + rnd(seed, i * 3 + 2));
    c.beginPath();
    c.ellipse(x, y, r * 1.6, r, rnd(seed, i + 77) * 3, 0, TAU);
    c.fillStyle = css(col, a * (0.5 + rnd(seed, i + 31) * 0.5));
    c.fill();
  }
  c.restore();
}

/** Thin lines along x (deck planking, panel lines), clipped to `s`, every `gap` units across y. */
export function linesX(p: Paint, s: Shape, x0: number, x1: number, y0: number, y1: number, gap: number, col: string, w = 0.12): void {
  if (!fine(p)) return;
  const c = p.ctx;
  c.save();
  c.beginPath();
  s(c);
  c.clip();
  c.beginPath();
  for (let y = y0; y <= y1 + 1e-6; y += gap) {
    c.moveTo(x0, y);
    c.lineTo(x1, y);
  }
  c.lineWidth = Math.max(w, hair(p, 0.6));
  c.strokeStyle = col;
  c.stroke();
  c.restore();
}

/** Thin lines across (along y) every `gap` units of x, clipped to `s` (track links, ribs, hatch boards). */
export function linesY(p: Paint, s: Shape, x0: number, x1: number, y0: number, y1: number, gap: number, col: string, w = 0.12): void {
  if (!fine(p, 1.2)) return;
  const c = p.ctx;
  c.save();
  c.beginPath();
  s(c);
  c.clip();
  c.beginPath();
  for (let x = x0; x <= x1 + 1e-6; x += gap) {
    c.moveTo(x, y0);
    c.lineTo(x, y1);
  }
  c.lineWidth = Math.max(w, hair(p, 0.6));
  c.strokeStyle = col;
  c.stroke();
  c.restore();
}

/** A thin pole or barrel from (x0, y0) to (x1, y1), `w` wide, shaded as a cylinder, with an optional cast shadow. */
export function rod(p: Paint, x0: number, y0: number, x1: number, y1: number, w: number, base: Col, h = 0): void {
  const c = p.ctx;
  const dx = x1 - x0;
  const dy = y1 - y0;
  const L = Math.hypot(dx, dy) || 1;
  const ax = dx / L;
  const ay = dy / L;
  c.lineCap = 'round';
  if (h > 0) {
    const [sx, sy] = shadowAt(p, h);
    c.beginPath();
    c.moveTo(x0 + sx * 0.6, y0 + sy * 0.6);
    c.lineTo(x1 + sx, y1 + sy);
    c.lineWidth = w;
    c.strokeStyle = 'rgba(8,10,12,0.28)';
    c.stroke();
  }
  c.beginPath();
  c.moveTo(x0, y0);
  c.lineTo(x1, y1);
  c.lineWidth = Math.max(w, hair(p, 0.7));
  c.strokeStyle = w * p.R >= 2 ? cylGrad(p, base, (x0 + x1) / 2, (y0 + y1) / 2, ax, ay, w / 2) : css(base);
  c.stroke();
  c.lineCap = 'butt';
}
