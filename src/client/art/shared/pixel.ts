// Pixel-grid drawing helpers shared by the pixel styles (client only): discs and rings of whole cells of `g` screen px,
// snapped to the grid, so effects keep the sprites' crisp pixel size.

/** A filled pixel disc of `r` cells of `g` px centred on (cx, cy) (snapped to the grid). */
export function pixelDisc(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, g: number): void {
  const x0 = Math.round(cx / g) * g;
  const y0 = Math.round(cy / g) * g;
  const ri = Math.max(0, Math.round(r));
  if (ri === 0) {
    ctx.fillRect(x0, y0, g, g);
    return;
  }
  for (let dy = -ri; dy <= ri; dy++) {
    const half = Math.floor(Math.sqrt(ri * ri - dy * dy) + 0.35);
    ctx.fillRect(x0 - half * g, y0 + dy * g, (half * 2 + 1) * g, g);
  }
}

/** A ring broken into dots: one cell in every `every` (a shockwave thinning out as it grows). */
export function sparseRing(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, g: number, every: number): void {
  const x0 = Math.round(cx / g) * g;
  const y0 = Math.round(cy / g) * g;
  const ri = Math.max(1, Math.round(r));
  const n = Math.max(8, Math.round(ri * 6.3));
  for (let i = 0; i < n; i += every) {
    const a = (i / n) * Math.PI * 2;
    ctx.fillRect(x0 + Math.round(Math.cos(a) * ri) * g, y0 + Math.round(Math.sin(a) * ri) * g, g, g);
  }
}

/** A 1-cell pixel ring of radius `r` cells (`dash`: every other cell, a ring breaking up as it fades). */
export function pixelRing(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, g: number, dash = false): void {
  const x0 = Math.round(cx / g) * g;
  const y0 = Math.round(cy / g) * g;
  const ri = Math.max(1, Math.round(r));
  const n = Math.max(8, Math.round(ri * 6.3));
  for (let i = 0; i < n; i++) {
    if (dash && i % 2) continue;
    const a = (i / n) * Math.PI * 2;
    ctx.fillRect(x0 + Math.round(Math.cos(a) * ri) * g, y0 + Math.round(Math.sin(a) * ri) * g, g, g);
  }
}
