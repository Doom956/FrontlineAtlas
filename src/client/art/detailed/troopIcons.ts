// The detailed style's troop icons (client only): tiny pixel units with no plate or tile round them, drawn like the
// detailed units on the map (muted military colours, lit from the top left, seen from a high three-quarter view, facing
// right): a rifleman in a helmet with his pack, a tank (turret, barrel, hull, tracks and road wheels), a towed field
// gun (long barrel, shield, spoked wheel, split trail), and for a mix the viewer does not know, a plain grey figure
// with a small question mark. The owner's colour is on the unit itself (the uniform, the hull, the gun's shield and
// trail), a little quieter and evened toward a mid lightness so it sits with the muted unit art. A dark 1 px outline
// round the silhouette keeps it readable on any land, water or pill colour; a dark nation's parts also get a lighter
// rim on their top and left edges so they still part from a dark pill. Baked once per (kind, owner, size) and drawn on
// whole pixels.
import { makeCanvas } from '../../render/common';
import { hex, lerpRGB, luma, ownerRamp, type RGB } from '../shared/colour';
import type { TroopIconArt, TroopIconKind } from '../types';
import { rampOf } from './palette';

// Sprite letters: owner colour 1 deep, 2 dark, 3 base, 4 light; helmet H light, h base, j dark; gun metal G light,
// g base, q dark; rubber and tracks r light, t dark, k deep; skin s, S shade; pack and webbing P light, p base, b dark;
// the unknown figure m light, n base, o dark; the question mark Q; '.' empty. The outline is added round the sprite.

/** Normal size (a 16 px icon, an 18 px footprint): every sprite fits 16 x 16 inside its outline. */
const SPRITES: Record<TroopIconKind, readonly string[]> = {
  // a rifleman walking right, his rifle held forward, helmet, pack and webbing on his back
  infantry: [
    '....HHh.....',
    '...HHhhj....',
    '...jhhhhj...',
    '....23sS....',
    '..Pp4433....',
    '..pb43333...',
    '..bb3332sggG',
    '...b3322....',
    '...12112....',
    '....3232....',
    '...32..32...',
    '...2....2...',
    '..kk....kk..',
  ],
  // a medium tank: the turret set a little back with its gun past the nose, the hull, tracks with road wheels
  armor: [
    '.....4443.......',
    '....4333321GGGGG',
    '.444122221144...',
    '.433333333333...',
    '.33333333333322.',
    '.22222222222221.',
    '.ktrrtrrtrrtrk..',
    '..kkkkkkkkkkk...',
  ],
  // a field gun: the barrel raised to the right, the shield, a spoked wheel, the split trail back to the ground
  artillery: [
    '..............GG',
    '............GGq.',
    '........44GGq...',
    '......4433Gq....',
    '.....43333q.....',
    '.....33332......',
    '.....3kkk2......',
    '....kqgqk.......',
    '11.kqtgtqk......',
    '.11kggGggk......',
    '.33kqtgtqk......',
    '33..kqgqk.......',
    '.....kkk........',
  ],
  // an unknown mix: the rifleman as a plain grey figure, no detail, and a small question mark
  troops: [
    '....mmm.....QQ..',
    '...mmmmm...Q..Q.',
    '...ommmmo.....Q.',
    '....onn......Q..',
    '..oonnnn....Q...',
    '..oonnnnn.......',
    '..oonnnnn...Q...',
    '...onnno........',
    '...onnno........',
    '....nnno........',
    '...nn..nn.......',
    '...n....n.......',
    '..oo....oo......',
  ],
};

/** Small size (a 12 px icon, a 14 px footprint, on transports and next to nation army counts): fits 12 x 12. */
const SMALL: Record<TroopIconKind, readonly string[]> = {
  infantry: [
    '...HHh...',
    '..jhhhj..',
    '...j3s...',
    '..p4433..',
    '..pb33sgG',
    '..b232...',
    '...2.32..',
    '..2...2..',
    '..k...k..',
  ],
  armor: [
    '....443.....',
    '...43332GGGG',
    '.4412221....',
    '.33333333...',
    '.222222221..',
    '.ktrtrtrk...',
    '..kkkkkk....',
  ],
  artillery: [
    '..........GG',
    '........GGq.',
    '......44Gq..',
    '.....433q...',
    '....4332....',
    '....3kkk....',
    '11.kqgqk....',
    '.11kgGgk....',
    '.33kqgqk....',
    '33..kkk.....',
  ],
  troops: [
    '...mm...QQ.',
    '..mmmm....Q',
    '..ommo...Q.',
    '...on....Q.',
    '.oonnn.....',
    '.oonnn...Q.',
    '..onno.....',
    '..nn.n.....',
    '.oo..oo....',
  ],
};

export interface IconBitmap {
  w: number;
  h: number;
  data: Uint8ClampedArray;
}

const INK: RGB = [12, 14, 17];
const WHITE: RGB = [255, 255, 255];
/** How far the owner's colour is pulled toward its own grey on the icons. */
const QUIET = 0.28;
/** The darkest a nation's base tone gets on the icons (luma): darker ones are lifted toward a charcoal. */
const DARK_BASE = 74;

/**
 * The owner's 4 tones on the icon (deep, dark, base, light): a little quieter than the nation colour, evened toward a
 * mid lightness (a near-black nation becomes a charcoal that still parts from the dark outline).
 */
export function iconTones(owner: readonly number[]): RGB[] {
  const l = luma(owner);
  let base = ownerRamp(lerpRGB(owner, [l, l, l], QUIET))[2];
  const lb = luma(base);
  if (lb < DARK_BASE) base = lerpRGB(base, [150, 150, 150], (DARK_BASE - lb) / (150 - lb));
  return [lerpRGB(base, INK, 0.62), lerpRGB(base, INK, 0.36), base, lerpRGB(base, WHITE, 0.28)];
}

/** True when the owner's colour is dark: its parts get a lighter rim on their top and left edges. */
export function lightRimFor(owner: readonly number[]): boolean {
  return luma(owner) < 80;
}

/** The outline colour round every icon. */
export const OUTLINE = INK;

function paletteOf(kind: TroopIconKind, owner: readonly number[]): Map<string, RGB> {
  const p = new Map<string, RGB>();
  const o = iconTones(owner);
  ['1', '2', '3', '4'].forEach((ch, i) => p.set(ch, o[i]));
  p.set('5', lerpRGB(o[2], WHITE, 0.45));
  const helmet = rampOf('helmet');
  p.set('H', helmet[3]).set('h', helmet[2]).set('j', helmet[1]);
  const gun = rampOf('gun');
  p.set('G', lerpRGB(gun[3], WHITE, 0.12)).set('g', gun[3]).set('q', gun[2]);
  const track = rampOf('track');
  p.set('r', lerpRGB(track[3], WHITE, 0.1)).set('t', track[2]).set('k', track[1]);
  const skin = rampOf('skin');
  p.set('s', skin[2]).set('S', skin[1]);
  const canvas = rampOf('canvas');
  p.set('P', canvas[3]).set('p', canvas[2]).set('b', canvas[1]);
  if (kind === 'troops') {
    // the unknown figure: a grey with a hint of the owner's colour, flat
    const l = luma(o[2]);
    const g = lerpRGB(o[2], [l, l, l], 0.7);
    const mid = lerpRGB(g, [128, 128, 128], 0.5);
    p.set('m', lerpRGB(mid, WHITE, 0.18)).set('n', mid).set('o', lerpRGB(mid, INK, 0.3));
    p.set('Q', hex('#e4e1d8'));
  }
  return p;
}

const OWNER_PART = new Set(['1', '2', '3', '4']);

/**
 * One troop icon as RGBA, size + 2 px square and transparent round the unit: the sprite centred, every pixel next to
 * it (left, right, above, below) the outline. A dark nation's parts get a lighter rim where their top or left edge
 * meets the outline, so they still part from a dark pill.
 */
export function bakeTroopIcon(kind: TroopIconKind, owner: readonly number[], size = 16): IconBitmap {
  const W = size + 2;
  const data = new Uint8ClampedArray(W * W * 4);
  const rows = (size >= 16 ? SPRITES : SMALL)[kind];
  const pal = paletteOf(kind, owner);
  const sw = Math.max(...rows.map((r) => r.length));
  const sh = rows.length;
  const ox = Math.floor((W - sw) / 2);
  const oy = Math.floor((W - sh) / 2);
  const at = (x: number, y: number): string => {
    const ch = rows[y - oy]?.[x - ox];
    return ch !== undefined && pal.has(ch) ? ch : '.';
  };
  const solid = (x: number, y: number): boolean => at(x, y) !== '.';
  const rim = lightRimFor(owner);
  const put = (o: number, c: readonly number[], a: number): void => {
    data[o] = c[0];
    data[o + 1] = c[1];
    data[o + 2] = c[2];
    data[o + 3] = a;
  };
  for (let y = 0; y < W; y++)
    for (let x = 0; x < W; x++) {
      const o = (y * W + x) * 4;
      let ch = at(x, y);
      if (ch !== '.') {
        if (rim && OWNER_PART.has(ch) && (!solid(x, y - 1) || !solid(x - 1, y))) ch = '5';
        put(o, pal.get(ch)!, 255);
      } else if (solid(x - 1, y) || solid(x + 1, y) || solid(x, y - 1) || solid(x, y + 1)) put(o, OUTLINE, 235);
    }
  return { w: W, h: W, data };
}

const cache = new Map<string, HTMLCanvasElement | null>();
function iconCanvas(kind: TroopIconKind, owner: readonly number[], size: number): HTMLCanvasElement | null {
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

export const detailedTroopIcons: TroopIconArt = {
  draw(ctx, kind, x, y, owner, size) {
    const cv = iconCanvas(kind, owner, size);
    if (!cv) return 0;
    const prev = ctx.imageSmoothingEnabled;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(cv, Math.round(x), Math.round(y));
    ctx.imageSmoothingEnabled = prev;
    return cv.width;
  },
};
