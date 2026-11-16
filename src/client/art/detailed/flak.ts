// Defense row art in the detailed pixel style (client only, drawn in code, no asset files): the small AA guns on the
// Fort and City markers of a Flak Guns holder, a flak puff, the steel hedgehogs of tank traps and their dirt burst.
// Every piece is a tiny pixel pattern drawn with fillRect at a whole pixel scale `k` (CSS px per pattern pixel), so it
// stays crisp at every dpr. Colours: the detailed palette's gun steel (MATERIALS.gun) and earth.
import { MATERIALS } from './palette';

type Ctx = CanvasRenderingContext2D;

const GUN = MATERIALS.gun;
/** pattern letters -> colour */
const INK: Record<string, string> = {
  o: '#07090c', // outline
  b: '#2c3137', // gun pit base
  m: '#5d646b', // mount
  g: '#8a9198', // barrels, light steel (they read on the dark plate and the ground)
  l: '#dde2e7', // lit muzzles and top pixels
  d: GUN[1],
  s: GUN[3],
};

/** A twin-barrel AA gun on its mount, barrels up and to the right (8 x 7). */
const AA_GUN = ['......ll', '.....gg.', '....gg..', '...gg...', '..mmmm..', '.mmmmmm.', 'bbbbbbbb'];
/** A Czech hedgehog: two crossed beams and a cross bar, a light pixel on top (5 x 5). */
const HEDGEHOG = ['l...l', '.d.d.', 'dslsd', '.d.d.', 'd...d'];

function pattern(ctx: Ctx, rows: readonly string[], x: number, y: number, k: number, mirror: boolean, outline: boolean): void {
  const w = rows[0].length;
  if (outline) {
    ctx.fillStyle = INK.o;
    for (let r = 0; r < rows.length; r++) {
      for (let c = 0; c < w; c++) {
        if (rows[r][c] === '.') continue;
        const cx = mirror ? w - 1 - c : c;
        ctx.fillRect(x + (cx - 1) * k, y + (r - 1) * k, k * 3, k * 3);
      }
    }
  }
  for (let r = 0; r < rows.length; r++) {
    for (let c = 0; c < w; c++) {
      const ch = rows[r][c];
      if (ch === '.') continue;
      const cx = mirror ? w - 1 - c : c;
      ctx.fillStyle = INK[ch] ?? INK.g;
      ctx.fillRect(x + cx * k, y + r * k, k, k);
    }
  }
}

/** Snaps a CSS px coordinate to the device pixel grid. */
function snap(v: number, dpr: number): number {
  return Math.round(v * dpr) / dpr;
}

/**
 * Two small AA guns flanking a building marker of `size` CSS px centred at (x, y), one on each side, barrels up and out
 * (Fort and City markers of a Flak Guns holder, render/buildings.ts).
 */
export function drawFlakGuns(ctx: Ctx, x: number, y: number, size: number, dpr: number, alpha = 1): void {
  const k = size >= 30 ? 2 : size >= 20 ? 1.5 : 1;
  const r = size / 2;
  const prev = ctx.globalAlpha;
  ctx.globalAlpha = prev * alpha;
  const gy = snap(y + r - 7 * k, dpr);
  pattern(ctx, AA_GUN, snap(x - r - 6 * k, dpr), gy, k, true, true);
  pattern(ctx, AA_GUN, snap(x + r - 2 * k, dpr), gy, k, false, true);
  ctx.globalAlpha = prev;
}

/** A steel hedgehog of tank traps centred at (x, y), pattern pixel k CSS px. */
export function drawHedgehog(ctx: Ctx, x: number, y: number, k: number, dpr: number): void {
  pattern(ctx, HEDGEHOG, snap(x - 2.5 * k, dpr), snap(y - 2.5 * k, dpr), k, false, false);
}

/**
 * A flak puff: a black 3 x 3 px blot (corners lighter, so it reads round), fading with `fade` (1 = new), with an
 * orange core on its first frame.
 */
export function drawFlakPuff(ctx: Ctx, x: number, y: number, k: number, fade: number, core: boolean, dpr: number): void {
  const px = snap(x - 1.5 * k, dpr);
  const py = snap(y - 1.5 * k, dpr);
  const prev = ctx.globalAlpha;
  ctx.globalAlpha = prev * fade * 0.9;
  ctx.fillStyle = '#121416';
  ctx.fillRect(px + k, py, k, k * 3);
  ctx.fillRect(px, py + k, k * 3, k);
  ctx.globalAlpha = prev * fade * 0.55;
  ctx.fillRect(px, py, k, k);
  ctx.fillRect(px + 2 * k, py, k, k);
  ctx.fillRect(px, py + 2 * k, k, k);
  ctx.fillRect(px + 2 * k, py + 2 * k, k, k);
  if (core) {
    ctx.globalAlpha = prev;
    ctx.fillStyle = '#ff9a2e';
    ctx.fillRect(px + k, py + k, k, k);
  }
  ctx.globalAlpha = prev;
}

/** Earth colours of the dirt burst where a spearhead hits tank traps. */
export const DIRT = ['#3b2c1e', '#5a4430', '#7a5f43', '#9a7f5e'] as const;
