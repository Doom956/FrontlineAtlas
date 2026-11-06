// The screen pranks' hooks into the map (broadcast.ts sets them, for a few seconds at most): a warp of the map canvases
// (flip, earthquake), a hue shift of the nation colours (disco: renderer.ts), units drawn as rubber ducks (ducks:
// render/unitGlyphs.ts). The map input reads the warp back (input.ts), so a click lands on the tile the player sees.
// Display only: nothing here reaches the game state, the lockstep or the hash.

/** A CSS transform about the centre of the map canvas: scale, then rotate, then move (CSS px). */
export interface MapWarp {
  rot: number;
  sx: number;
  sy: number;
  dx: number;
  dy: number;
  /** the warp is mid-turn (a flip going in or out): map input waits until it settles */
  moving: boolean;
}

export const prankView = {
  /** nation colours turned by this many degrees of hue, 0 = off */
  hue: 0,
  /** units drawn as rubber ducks */
  ducks: false,
  /** the map canvases' warp, null = none */
  warp: null as MapWarp | null,
  /** counts the frames a flip spent turning: a press held across a turn is let go (input.ts) */
  turns: 0,
};

/** Smallest scale the inverse uses (a mirror flip passes through 0 for a moment; input waits then anyway). */
const MIN_SCALE = 0.15;

/** The CSS transform for a warp ('' = none). */
export function warpCss(w: MapWarp | null): string {
  if (!w) return '';
  return `translate(${w.dx.toFixed(2)}px, ${w.dy.toFixed(2)}px) rotate(${w.rot.toFixed(4)}rad) scale(${w.sx.toFixed(4)}, ${w.sy.toFixed(4)})`;
}

const safe = (s: number): number => (Math.abs(s) < MIN_SCALE ? (s < 0 ? -MIN_SCALE : MIN_SCALE) : s);

/** A point where the map is drawn (CSS px in the canvas, w x h) to where it shows on screen (same frame). */
export function warpPoint(w: MapWarp | null, x: number, y: number, cw: number, ch: number): { x: number; y: number } {
  if (!w) return { x, y };
  const px = (x - cw / 2) * w.sx;
  const py = (y - ch / 2) * w.sy;
  const c = Math.cos(w.rot);
  const s = Math.sin(w.rot);
  return { x: cw / 2 + w.dx + px * c - py * s, y: ch / 2 + w.dy + px * s + py * c };
}

/** The inverse: a point on screen (relative to the canvas's unwarped box) to where the map is drawn. */
export function unwarpPoint(w: MapWarp | null, x: number, y: number, cw: number, ch: number): { x: number; y: number } {
  if (!w) return { x, y };
  const qx = x - cw / 2 - w.dx;
  const qy = y - ch / 2 - w.dy;
  const c = Math.cos(-w.rot);
  const s = Math.sin(-w.rot);
  const rx = qx * c - qy * s;
  const ry = qx * s + qy * c;
  return { x: cw / 2 + rx / safe(w.sx), y: ch / 2 + ry / safe(w.sy) };
}

/**
 * Pointer position in map-canvas CSS px as the map is drawn. The bounding box of a warped canvas is the box of the
 * turned shape, but its centre is the unwarped centre moved by (dx, dy): the box and the client size give the frame.
 */
export function mapPointer(canvas: HTMLElement, clientX: number, clientY: number): { x: number; y: number } {
  const r = canvas.getBoundingClientRect();
  const w = prankView.warp;
  if (!w) return { x: clientX - r.left, y: clientY - r.top };
  const cw = canvas.clientWidth || r.width;
  const ch = canvas.clientHeight || r.height;
  const left = r.left + r.width / 2 - w.dx - cw / 2;
  const top = r.top + r.height / 2 - w.dy - ch / 2;
  return unwarpPoint(w, clientX - left, clientY - top, cw, ch);
}

/** Map input waits while a flip turns (half a second going in, half going out). */
export function mapInputPaused(): boolean {
  return !!prankView.warp?.moving;
}

/** Sets the warp (broadcast.ts, every frame a prank warps the map). */
export function setMapWarp(w: MapWarp | null): void {
  prankView.warp = w;
  if (w?.moving) prankView.turns++;
}

/**
 * Which way round the map shows ('' = as usual, 'm' mirrored, 'u' upside down): a press held while this changes is let
 * go (input.ts), also when the whole half-second turn fell between two frames on a slow machine.
 */
export function mapSide(): string {
  const w = prankView.warp;
  if (!w) return '';
  return `${w.sx < 0 ? 'm' : ''}${Math.abs(Math.round(w.rot / Math.PI)) % 2 ? 'u' : ''}`;
}

/** Everything off (a new game, the menu). */
export function resetPrankView(): void {
  prankView.hue = 0;
  prankView.ducks = false;
  prankView.warp = null;
}

/**
 * A point of the drawn map in map-canvas CSS px to where it shows now, in the same frame (the canvas's unwarped box):
 * HUD markers placed over the map in DOM (the unit card, the alert ping) follow a flip or a wobble with it.
 */
export function mapShown(x: number, y: number): { x: number; y: number } {
  const w = prankView.warp;
  if (!w || typeof document === 'undefined') return { x, y };
  const c = document.querySelector<HTMLElement>('canvas.map');
  const cw = c?.clientWidth || window.innerWidth;
  const ch = c?.clientHeight || window.innerHeight;
  return warpPoint(w, x, y, cw, ch);
}

/** A colour turned by `deg` degrees of hue (lightness and saturation kept): the disco palette. */
export function hueShift(c: readonly number[], deg: number): [number, number, number] {
  const r = c[0] / 255;
  const g = c[1] / 255;
  const b = c[2] / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  // a grey has no hue: give it one, so every nation joins the dance
  const s = d === 0 ? 0.55 : d / (1 - Math.abs(2 * l - 1));
  let h = d === 0 ? 0 : max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h = (((h * 60 + deg) % 360) + 360) % 360;
  const C = (1 - Math.abs(2 * l - 1)) * Math.min(1, s);
  const X = C * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - C / 2;
  const [r1, g1, b1] = h < 60 ? [C, X, 0] : h < 120 ? [X, C, 0] : h < 180 ? [0, C, X] : h < 240 ? [0, X, C] : h < 300 ? [X, 0, C] : [C, 0, X];
  return [Math.round((r1 + m) * 255), Math.round((g1 + m) * 255), Math.round((b1 + m) * 255)];
}

/** Where a point of the drawn map (CSS px in the canvas) shows on the page (client px), through the warp. */
export function mapPointOnPage(canvas: HTMLElement, x: number, y: number): { x: number; y: number } {
  const r = canvas.getBoundingClientRect();
  const w = prankView.warp;
  if (!w) return { x: x + r.left, y: y + r.top };
  const cw = canvas.clientWidth || r.width;
  const ch = canvas.clientHeight || r.height;
  const p = warpPoint(w, x, y, cw, ch);
  return { x: p.x + r.left + r.width / 2 - w.dx - cw / 2, y: p.y + r.top + r.height / 2 - w.dy - ch / 2 };
}
