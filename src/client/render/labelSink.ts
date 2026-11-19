// Labels over the night (client only): while the renderer draws the world art into its own layer to shade it for the
// time of day (renderer.ts), the labels that art draws on the way (building names, level chips, troop pills, fleet
// counts, supply labels) are held here and drawn afterwards on the overlay, unshaded, exactly where they were asked
// for: the transform, alpha, font and text alignment of the moment are kept with each one. Off (the usual case by day)
// every label draws at once as before.
interface Held {
  t: DOMMatrix;
  a: number;
  font: string;
  align: CanvasTextAlign;
  base: CanvasTextBaseline;
  spacing: string;
  fn: (ctx: CanvasRenderingContext2D) => void;
}

let world: CanvasRenderingContext2D | null = null;
const held: Held[] = [];

/** Labels asked for on `ctx` are held from now on (renderer.ts, the world layer). */
export function holdLabels(ctx: CanvasRenderingContext2D): void {
  world = ctx;
  held.length = 0;
}

/** True when a label for `ctx` would be held. */
export function holdingLabels(ctx: CanvasRenderingContext2D): boolean {
  return world !== null && ctx === world;
}

/**
 * Holds a label drawn on `ctx` when that is the world layer: true = held (the caller draws nothing now), false = draw
 * it now as usual.
 */
export function holdLabel(ctx: CanvasRenderingContext2D, fn: (ctx: CanvasRenderingContext2D) => void): boolean {
  if (world === null || ctx !== world) return false;
  held.push({ t: ctx.getTransform(), a: ctx.globalAlpha, font: ctx.font, align: ctx.textAlign, base: ctx.textBaseline, spacing: (ctx as { letterSpacing?: string }).letterSpacing ?? '0px', fn });
  return true;
}

/** Stops holding and draws every held label on `ctx` (the overlay), in the order asked. Returns how many. */
export function drawHeldLabels(ctx: CanvasRenderingContext2D): number {
  world = null;
  const n = held.length;
  for (const h of held) {
    ctx.save();
    ctx.setTransform(h.t);
    ctx.globalAlpha = h.a;
    ctx.font = h.font;
    ctx.textAlign = h.align;
    ctx.textBaseline = h.base;
    if ('letterSpacing' in ctx) (ctx as { letterSpacing: string }).letterSpacing = h.spacing;
    h.fn(ctx);
    ctx.restore();
  }
  held.length = 0;
  return n;
}
