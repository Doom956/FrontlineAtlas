// The refined style's troop icons (client only): infantry, armor and artillery as small pixel markers, in the same
// style as the unit sprites. Each marker is a rounded-square PLATE: its face in the owner's colour toned down (darker
// and greyer, palette.ts ownerDim) with a slight top-lit bevel, the owner's full colour only on its 1 px rim; it carries
// a SYMBOL: a helmeted soldier with his rifle, a tank or a field gun in side view, a stencilled light grey, shaded in 4
// tones with the light from the top left and a soft drop shadow (on the small plates only the helmet and the rifle). A
// 1 px dark slate edge (not black) goes round the whole marker. The team colour is only ever the plate, never the symbol. Baked once per (kind, owner colour, size) into a small
// canvas and drawn at whole pixels. Pure data + a pure baker (testable in node). The pills that carry these markers
// are shared (render/troopIcons.ts).
import { makeCanvas } from '../../render/common';
import { ownerRamp, type RGB } from '../shared/colour';
import { oklch, ownerDim } from './palette';
import type { TroopIconArt, TroopIconKind } from '../types';
import { OUTLINE } from './spriteBake';

/** Plate size (px) of the troop markers (render/troopIcons.ts PLATE). */
const PLATE = 16;

/**
 * Symbols, 12 px tall at most, side view facing right. a..d = light to dark tones of the symbol ramp, '.' = plate.
 * Infantry is a touch taller than wide, the vehicles wider than tall.
 */
const SYMBOLS: Record<TroopIconKind, readonly string[]> = {
  // a soldier in side view facing right: a steel helmet with its brim, the face under it, the rifle held up across
  // the body (its muzzle up by the helmet, its stock at the hip), a belt, two legs
  infantry: [
    '..abbc....',
    '.abbbbc..b',
    '.cccccc.b.',
    '...bc..c..',
    '..abbcdc..',
    '.abbbdbc..',
    '.abbdbbc..',
    '..bdccc...',
    '..bbbbc...',
    '..bb.bc...',
    '..bc..bc..',
    '.bbc..bbc.',
  ],
  armor: [
    '....abbb......',
    '...abbbbbaaaab',
    '...bbbbbccccd.',
    '.aabbbbbbbbb..',
    'abbbbbbbbbbbc.',
    'bcccccccccccd.',
    '.dcdcdcdcdcd..',
    '..dddddddddd..',
  ],
  // a short field gun: the barrel up and right (ending inside the plate), a shield, a wheel with its hub, and the split
  // trail down and left to the ground
  artillery: [
    '.........aa.',
    '.......abbc.',
    '.....abbcc..',
    '..aabbbcc...',
    '..abbbbc....',
    '.ab.bbbbc...',
    'ab.bcccbc...',
    'b..bcacbc...',
    '...bcccbc...',
    '....bbbc....',
  ],
  // an unknown mix: a bold question mark, never the soldier
  troops: [
    '..abbbbc..',
    '.abbbbbbc.',
    'abbc..abbc',
    'bcd...abbc',
    '.....abbc.',
    '....abbc..',
    '....bbcd..',
    '....bbc...',
    '..........',
    '....abc...',
    '....bbc...',
  ],
};

/** The same symbols at about 8 px, for the small plates (transports, nation army counts). */
const SMALL: Record<TroopIconKind, readonly string[]> = {
  // only the helmet and the rifle: what still reads at this size (the rifle slung behind the helmet)
  infantry: [
    '.......b',
    '..abbcb.',
    '.abbbbc.',
    'ccccccc.',
    '..cb....',
    '.b......',
    'b.......',
  ],
  armor: [
    '...abb....',
    '..abbbaaab',
    '.abbbbbbc.',
    'abbbbbbbbc',
    'bccccccccd',
    '.dcdcdcdd.',
  ],
  artillery: [
    '......ab',
    '....abbc',
    '..abbcc.',
    '.abbbc..',
    'ab.bbbc.',
    'b.bcacb.',
    '..bcccb.',
    '...bbb..',
  ],
  troops: [
    '.abbbc.',
    'abc.abc',
    '....abc',
    '...abc.',
    '..abc..',
    '..bc...',
    '.......',
    '..bc...',
  ],
};

/** The symbol's tones (light to dark): stencil paint, never pure white or pure black. */
const LIGHT_SYMBOL: RGB[] = [oklch(0.94, 0.008, 95), oklch(0.87, 0.008, 95), oklch(0.74, 0.008, 240), oklch(0.56, 0.01, 240)];
const DARK_SYMBOL: RGB[] = [oklch(0.42, 0.01, 245), oklch(0.33, 0.01, 245), oklch(0.27, 0.01, 245), oklch(0.21, 0.01, 245)];

/**
 * The plate's tones: its face in toned-down owner colours (palette.ts ownerDim: the same hue, darker and greyer, so a
 * row of markers is not a row of candy-coloured tiles), a lit top row and a shaded bottom row for a slight bevel, and
 * the owner's full colour kept for the 1 px rim round it, where it says whose troops these are.
 */
function plateTones(owner: RGB): { rim: RGB; face: RGB; top: RGB; low: RGB } {
  const base = ownerRamp(owner)[2];
  const dim = ownerDim(base);
  return { rim: base, face: dim[1], top: dim[2], low: dim[0] };
}

export interface IconBitmap {
  w: number;
  h: number;
  data: Uint8ClampedArray;
}

/** True when a symbol on this owner's plate should be dark (a pale plate face). */
export function darkSymbolOn(owner: RGB): boolean {
  const face = plateTones(owner).face;
  return 0.299 * face[0] + 0.587 * face[1] + 0.114 * face[2] > 150;
}

/**
 * One troop marker as RGBA: the owner plate (`size` px, rounded corners, a darker lower and right edge), the symbol
 * centred on it with a 1 px drop shadow, and a 1 px dark outline round the plate (the bitmap is size + 2 px wide).
 */
export function bakeTroopIcon(kind: TroopIconKind, owner: RGB, size = PLATE): IconBitmap {
  const W = size + 2;
  const H = size + 2;
  const data = new Uint8ClampedArray(W * H * 4);
  const tones = plateTones(owner);
  const set = (x: number, y: number, c: RGB): void => {
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    const o = (y * W + x) * 4;
    data[o] = c[0];
    data[o + 1] = c[1];
    data[o + 2] = c[2];
    data[o + 3] = 255;
  };
  const inPlate = (x: number, y: number): boolean => {
    if (x < 0 || y < 0 || x >= size || y >= size) return false;
    // 2 px cut corners (rounded at pixel scale)
    const cx = x < 2 ? 2 - x : x > size - 3 ? x - (size - 3) : 0;
    const cy = y < 2 ? 2 - y : y > size - 3 ? y - (size - 3) : 0;
    return cx + cy <= 2;
  };
  const edgeOf = (x: number, y: number): boolean => !inPlate(x + 1, y) || !inPlate(x - 1, y) || !inPlate(x, y + 1) || !inPlate(x, y - 1);
  for (let y = -1; y <= size; y++) {
    for (let x = -1; x <= size; x++) {
      if (inPlate(x, y)) {
        // the owner's colour on the 1 px rim; inside it the dim face, a lighter row under the top rim, a darker one
        // over the bottom rim
        let c = tones.face;
        if (edgeOf(x, y)) c = tones.rim;
        else if (edgeOf(x, y - 1) && !edgeOf(x, y + 1)) c = tones.top;
        else if (edgeOf(x, y + 1) || edgeOf(x + 1, y)) c = tones.low;
        set(x + 1, y + 1, c);
      } else if (inPlate(x - 1, y) || inPlate(x + 1, y) || inPlate(x, y - 1) || inPlate(x, y + 1)) set(x + 1, y + 1, OUTLINE);
    }
  }
  const rows = (size < 14 ? SMALL : SYMBOLS)[kind];
  const sw = Math.max(...rows.map((r) => r.length));
  const sh = rows.length;
  const sym = darkSymbolOn(owner) ? DARK_SYMBOL : LIGHT_SYMBOL;
  const shadow = ownerDim(tones.rim)[0];
  const ox = 1 + Math.floor((size - sw) / 2);
  const oy = 1 + Math.floor((size - sh) / 2);
  const at = (r: readonly string[], x: number, y: number): number => {
    const ch = r[y]?.[x];
    return ch === 'a' ? 0 : ch === 'b' ? 1 : ch === 'c' ? 2 : ch === 'd' ? 3 : -1;
  };
  // drop shadow one px down and right, then the symbol
  for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) if (at(rows, x, y) >= 0 && at(rows, x + 1, y + 1) < 0) set(ox + x + 1, oy + y + 1, shadow);
  for (let y = 0; y < sh; y++)
    for (let x = 0; x < sw; x++) {
      const t = at(rows, x, y);
      if (t >= 0) set(ox + x, oy + y, sym[t]);
    }
  return { w: W, h: H, data };
}

// ------------------------------------------------------------------------------------------------- drawing

const cache = new Map<string, HTMLCanvasElement | null>();
function iconCanvas(kind: TroopIconKind, owner: RGB, size: number): HTMLCanvasElement | null {
  const key = `${kind}|${owner[0]},${owner[1]},${owner[2]}|${size}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  let cv: HTMLCanvasElement | null = null;
  if (typeof document !== 'undefined' && typeof ImageData !== 'undefined') {
    const b = bakeTroopIcon(kind, owner, size);
    cv = makeCanvas(b.w, b.h);
    const ctx = cv.getContext('2d');
    if (ctx) ctx.putImageData(new ImageData(b.data, b.w, b.h), 0, 0);
    else cv = null;
  }
  if (cache.size > 400) cache.clear();
  cache.set(key, cv);
  return cv;
}

/** Draws one troop marker with its top-left corner at (x, y) (whole px). Returns its width (0 without a canvas). */
function drawTroopIcon(ctx: CanvasRenderingContext2D, kind: TroopIconKind, x: number, y: number, owner: RGB, size = PLATE): number {
  const cv = iconCanvas(kind, owner, size);
  if (!cv) return 0;
  const prev = ctx.imageSmoothingEnabled;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(cv, Math.round(x), Math.round(y));
  ctx.imageSmoothingEnabled = prev;
  return cv.width;
}

export const refinedTroopIcons: TroopIconArt = { draw: drawTroopIcon };
