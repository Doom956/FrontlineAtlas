// The detailed style's troop icons (client only): tiny pixel units with no plate or tile round them, in the detailed
// units' muted military colours, lit from the top left and seen from the side, facing right (a side view reads best at
// 12 to 16 px; the tank's deck and turret roof and the gun's shield show a little of their top, like the map units
// seen from above): a rifleman walking with his rifle, helmet and pack; a tank (turret with its hatch, barrel, deck,
// hull, tracks and road wheels); a towed field gun (long barrel, shield, spoked wheel, split trail to the ground); and
// for a mix the viewer does not know, the rifleman's own silhouette in two flat greys with a question mark beside it.
// The owner's colour is on the unit the way the map units carry it: the soldier's uniform, the tank's turret and a band
// on its olive hull, the gun's shield; a little quieter, and held between a dark charcoal and a light grey so it sits
// with the muted art. A dark 1 px outline round the silhouette keeps it readable on any land, water or pill colour;
// a dark nation's parts also get a lighter rim on their top and left edges so they still part from a dark pill. Every
// kind stands on the same ground row, so a pill's units line up.
//
// Baked once per (kind, owner, size, resolution). On a 2x screen a second set at twice the pixels is drawn at the same
// size: the sprite's edges redrawn smooth (Scale2x) and its small parts drawn again finer (helmet and brim, rifle and
// sling, belt, hatch, muzzle brake, road wheels with hubs, the gun's spoked wheel), with a 1 device px outline. Whole
// pixels, no smoothing. The pills (render/troopIcons.ts) set the units on their own dark plate (TroopIconArt.bare),
// side by side by each unit's real width (troopIconSpan).
import { makeCanvas } from '../../render/common';
import { hex, lerpRGB, luma, type RGB } from '../shared/colour';
import type { TroopIconArt, TroopIconKind } from '../types';
import { rampOf } from './palette';

// Sprite letters: owner colour 1 deep, 2 dark, 3 base, 4 light; olive hull V light, v base, u dark, y deep; helmet H
// light, h base, j dark; gun metal G light, g base, q dark; wheels w tyre, t gap, r rim, c spoke and hub; track k;
// skin s, S shade; pack and webbing P light, p base, b dark; '.' empty. The outline is added round the sprite, and a
// dark nation's rim tone (5) by the baker. The unknown mix is the rifleman in greys (m light, n base) with the question
// mark (Q); x is an empty pixel in the question mark's hook that takes no outline.

type UnitKind = Exclude<TroopIconKind, 'troops'>;

/** Normal size (a 16 px icon, an 18 px footprint): every sprite fits 16 x 16 inside its outline. */
const SPRITES: Record<UnitKind, readonly string[]> = {
  // a rifleman walking right: a helmet with its brim, the face, his pack, the rifle held forward at the chest, the
  // webbing belt, a stride with both boots pointing the way he walks
  infantry: [
    '..HHh....',
    '.jhhhj...',
    '..Sss....',
    'Pp443....',
    'pb4332...',
    'bb32sgggG',
    '.b322....',
    '.1211....',
    '.3322....',
    '.32.32...',
    '32...32..',
    '2.....2..',
    'kk....kk.',
  ],
  // a medium tank: the turret (the owner's colour, its roof and hatch lit) set a little back with the gun past the
  // nose; the olive hull with its deck and an owner band along the side; tracks with road wheels
  armor: [
    '.....44c4......',
    '....4333332GGGG',
    '..VV22222VVV...',
    '.VVVVVVVVVVVV..',
    'vv3333333333vv.',
    'uuuuuuuuuuuuuuy',
    'trrtrrtrrtrrtt.',
    '.kkkkkkkkkkkk..',
  ],
  // a field gun: the shield (the owner's colour, its top lit), the long barrel raised to the right, the spoked wheel
  // with its hub, and the split trail from the axle back to the ground in gun metal
  artillery: [
    '...............G',
    '.............GGq',
    '...........GGq..',
    '......44.GGq....',
    '......433Gq.....',
    '......4333q.....',
    '......3www......',
    '.....wtctw......',
    '....wtrcrtw.....',
    '...gwccGccw.....',
    '.ggqwtrcrtw.....',
    'gqq..wtctw......',
    'q.....www.......',
  ],
};

/** Small size (a 12 px icon, a 14 px footprint, on transports and next to nation army counts): fits 12 x 12. */
const SMALL: Record<UnitKind, readonly string[]> = {
  infantry: [
    '..HHh..',
    '.jhhj..',
    '..Ss...',
    'Pp43...',
    'pb3sggG',
    '.b32...',
    '.3.2...',
    '32..2..',
    '2...2..',
    'kk..kk.',
  ],
  armor: [
    '...4c4.....',
    '..433332GGG',
    '.VV2222VV..',
    'vv333333vv.',
    'uuuuuuuuuuy',
    'trtrtrtrtt.',
    '.kkkkkkkk..',
  ],
  artillery: [
    '..........GG',
    '........GGq.',
    '....4.GGq...',
    '....43Gq....',
    '....433.....',
    '....3www....',
    '...gwrcrw...',
    '.ggqwcGcw...',
    'gqq.wrcrw...',
    'q....www....',
  ],
};

/** The question mark beside the grey figure: a hook, a gap row and the dot (normal and small, then at 2x). */
const QMARK = ['QQQ', 'QxQ', 'xxQ', '.QQ', '.Q.', '...', '.Q.'];
const QMARK_SMALL = ['QQQ', 'QxQ', 'xQQ', '.Q.', '...', '.Q.'];
const QMARK_2X = ['.QQQQ.', 'QQQQQQ', 'QQxxQQ', 'QQxxQQ', 'xxxxQQ', 'xxxQQQ', '..QQQ.', '..QQ..', '..QQ..', '..QQ..', '......', '......', '..QQ..', '..QQ..'];
const QMARK_SMALL_2X = ['.QQQQ.', 'QQQQQQ', 'QQxxQQ', 'QQxxQQ', 'xxQQQQ', 'xxQQQ.', '..QQ..', '..QQ..', '......', '......', '..QQ..', '..QQ..'];

/** The infantry letters that become the light grey on the unknown figure (the lit parts); the rest are the base grey. */
const LIT = new Set(['H', 'h', '4', 'P', 's', 'G']);

// ------------------------------------------------------------------------------------------------ the 2x set

/** Scale2x: each pixel becomes 2 x 2, its corners taking a neighbour's letter where two neighbours agree (smooth edges). */
function scale2x(rows: readonly string[]): string[][] {
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const at = (x: number, y: number): string => rows[y]?.[x] ?? '.';
  const out: string[][] = [];
  for (let y = 0; y < 2 * h; y++) out.push(new Array<string>(2 * w).fill('.'));
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const P = at(x, y);
      const A = at(x, y - 1);
      const B = at(x + 1, y);
      const C = at(x - 1, y);
      const D = at(x, y + 1);
      out[2 * y][2 * x] = C === A && C !== D && A !== B ? A : P;
      out[2 * y][2 * x + 1] = A === B && A !== C && B !== D ? B : P;
      out[2 * y + 1][2 * x] = D === C && D !== B && C !== A ? C : P;
      out[2 * y + 1][2 * x + 1] = B === D && B !== A && D !== C ? D : P;
    }
  return out;
}

/** Lays rows of letters over a grid at (x, y): '.' keeps what is there, '_' clears it. */
function patch(g: string[][], x: number, y: number, rows: readonly string[]): void {
  rows.forEach((r, j) => {
    for (let i = 0; i < r.length; i++) {
      const ch = r[i];
      if (ch === '.' || !g[y + j] || x + i >= g[y + j].length) continue;
      g[y + j][x + i] = ch === '_' ? '.' : ch;
    }
  });
}

/** A spoked wheel `d` px across at (x, y): tyre, rim, spokes every 45 degrees, the gaps between them and the hub. */
function wheel(g: string[][], x: number, y: number, d: number): void {
  const c = (d - 1) / 2;
  const R = d / 2;
  // a small wheel keeps its tyre and rim thin, so its spokes still show
  const [tyre, rim, hub] = d < 12 ? [1.1, 2, 1.4] : [1.5, 2.5, 1.9];
  for (let j = 0; j < d; j++)
    for (let i = 0; i < d; i++) {
      const dx = i - c;
      const dy = j - c;
      const r = Math.hypot(dx, dy);
      if (r > R) continue;
      let ch: string;
      if (r > R - tyre) ch = 'w';
      else if (r > R - rim) ch = 'r';
      else if (r < 1) ch = 'G';
      else if (r < hub) ch = 'c';
      else {
        // the distance from the nearest spoke (every 45 degrees)
        const a = Math.atan2(dy, dx);
        const k = Math.round(a / (Math.PI / 4)) * (Math.PI / 4);
        ch = Math.abs(r * Math.sin(a - k)) < 0.62 ? 'c' : 't';
      }
      if (g[y + j] && x + i < g[y + j].length) g[y + j][x + i] = ch;
    }
}

/** The small parts drawn again at twice the pixels, on the Scale2x grid of each sprite (normal size, then small). */
const DETAIL_2X: Record<UnitKind, [(g: string[][]) => void, (g: string[][]) => void]> = {
  infantry: [
    (g) => {
      // the helmet's dome and a thin brim, the rifle's barrel thinner than its stock, a sling, the belt and buckle
      patch(g, 2, 0, ['...HHHh...', '..HHhhhhj.', '_Hhhhhhhhj', 'jjjjjjjjjj']);
      patch(g, 12, 11, ['______']);
      patch(g, 8, 12, ['.b', 'b.']);
      patch(g, 2, 14, ['11111P11', '33332222']);
    },
    (g) => {
      patch(g, 2, 0, ['...HHHh.', '..HHhhhj', '_Hhhhhhj', 'jjjjjjjj']);
      patch(g, 10, 9, ['____']);
    },
  ],
  armor: [
    (g) => {
      // the hatch, the barrel's shaded underside and muzzle brake, the engine deck grille, the band's lower half in
      // shade, road wheels with their hubs
      patch(g, 14, 1, ['cq']);
      patch(g, 22, 3, ['gggggg']);
      patch(g, 27, 1, ['gg', 'GGG', 'qqq', 'qq']);
      patch(g, 4, 7, ['u.u.u']);
      patch(g, 4, 9, ['22222222222222222222']);
      for (const x of [2, 8, 14, 20]) patch(g, x, 13, ['rccr', '.rr.']);
    },
    (g) => {
      patch(g, 8, 1, ['cq']);
      patch(g, 16, 3, ['gggggg']);
      patch(g, 4, 7, ['222222222222']);
      for (const x of [2, 6, 10, 14]) patch(g, x, 11, ['cr']);
    },
  ],
  artillery: [(g) => wheel(g, 8, 12, 14), (g) => wheel(g, 8, 10, 10)],
};

// ------------------------------------------------------------------------------------------------ sprites by kind

/** The unknown mix: the rifleman's silhouette in two flat greys, and the question mark to his right. */
function unknownSprite(inf: readonly string[], q: readonly string[], qx: number): string[] {
  const w = Math.max(qx + q[0].length, ...inf.map((r) => r.length));
  return inf.map((row, y) => {
    let r = '';
    for (let x = 0; x < w; x++) {
      const qc = q[y]?.[x - qx];
      const ch = row[x] ?? '.';
      r += qc !== undefined && qc !== '.' ? qc : ch === '.' ? '.' : LIT.has(ch) ? 'm' : 'n';
    }
    return r;
  });
}

const sprites = new Map<string, readonly string[]>();

/** A kind's sprite rows at a size (16 or the small 12) and resolution (1, or 2 for the 2x set). */
function spriteOf(kind: TroopIconKind, size: number, res: 1 | 2 = 1): readonly string[] {
  const small = size < 16;
  const key = `${kind}|${small ? 1 : 0}|${res}`;
  let rows = sprites.get(key);
  if (!rows) {
    if (kind === 'troops') {
      const inf = spriteOf('infantry', size, res);
      const w = (small ? SMALL : SPRITES).infantry[0].length;
      const qx = (w + 2) * res;
      rows = unknownSprite(inf, res === 2 ? (small ? QMARK_SMALL_2X : QMARK_2X) : small ? QMARK_SMALL : QMARK, qx);
    } else if (res === 1) rows = (small ? SMALL : SPRITES)[kind];
    else {
      const g = scale2x((small ? SMALL : SPRITES)[kind]);
      DETAIL_2X[kind][small ? 1 : 0](g);
      rows = g.map((r) => r.join(''));
    }
    sprites.set(key, rows);
  }
  return rows;
}

// ------------------------------------------------------------------------------------------------ colours

export interface IconBitmap {
  w: number;
  h: number;
  data: Uint8ClampedArray;
}

const INK: RGB = [12, 14, 17];
const WHITE: RGB = [255, 255, 255];
/** How far the owner's colour is pulled toward its own grey on the icons (more for a very saturated colour). */
const QUIET = 0.28;
/** The darkest a nation's base tone gets on the icons (luma): a near-black nation stays this dark charcoal. */
const DARK_BASE = 50;
/** The lightest a nation's base tone gets on the icons (luma): white and pale yellow are held to a light grey. */
const LIGHT_BASE = 186;

/**
 * The owner's 4 tones on the icon (deep, dark, base, light): quieter than the nation colour (a strong one more so),
 * held between a dark charcoal and a light grey. A near-black nation stays dark, its shading kept close to its base
 * (its lighter rim parts it from a dark pill), so it still reads as black next to a grey nation.
 */
export function iconTones(owner: readonly number[]): RGB[] {
  const l = luma(owner);
  const sat = (Math.max(owner[0], owner[1], owner[2]) - Math.min(owner[0], owner[1], owner[2])) / 255;
  let base = lerpRGB(owner, [l, l, l], QUIET + 0.32 * Math.max(0, sat - 0.5));
  const lb = luma(base);
  if (lb < DARK_BASE) base = lerpRGB(base, [150, 150, 150], (DARK_BASE - lb) / (150 - lb));
  else if (lb > LIGHT_BASE) base = lerpRGB(base, [96, 96, 96], (lb - LIGHT_BASE) / (lb - 96));
  const [d0, d1] = luma(base) < 80 ? [0.4, 0.22] : [0.6, 0.34];
  return [lerpRGB(base, INK, d0), lerpRGB(base, INK, d1), base, lerpRGB(base, WHITE, 0.24)];
}

/** True when the owner's colour is dark: its parts get a lighter rim on their top and left edges. */
export function lightRimFor(owner: readonly number[]): boolean {
  return luma(owner) < 80;
}

/** The outline colour round every icon. */
export const OUTLINE = INK;

/** The unknown figure's light and base greys and its question mark: neutral, no owner tint. */
export const UNKNOWN_GREYS: readonly RGB[] = [hex('#a4a39c'), hex('#72736d'), hex('#e4e1d8')];

function paletteOf(owner: readonly number[]): Map<string, RGB> {
  const p = new Map<string, RGB>();
  const o = iconTones(owner);
  ['1', '2', '3', '4'].forEach((ch, i) => p.set(ch, o[i]));
  p.set('5', lerpRGB(o[2], WHITE, 0.45));
  // the tank's hull in olive drab like the map tanks, or field grey for a nation whose own colour is close to olive
  // (its turret and band would vanish on it)
  const olive = rampOf('olive');
  const grey = rampOf('fieldgrey');
  const far = (c: readonly number[]): number => Math.hypot(c[0] - o[2][0], c[1] - o[2][1], c[2] - o[2][2]);
  const hull = far(olive[2]) >= 70 || far(olive[2]) >= far(grey[2]) ? olive : grey;
  p.set('V', hull[3]).set('v', hull[2]).set('u', hull[1]).set('y', hull[0]);
  const helmet = rampOf('helmet');
  p.set('H', helmet[3]).set('h', helmet[2]).set('j', helmet[1]);
  const gun = rampOf('gun');
  p.set('G', lerpRGB(gun[3], WHITE, 0.16)).set('g', lerpRGB(gun[3], WHITE, 0.04)).set('q', gun[2]);
  // the wheels a step lighter than the track rubber, so they still read on the near-black pill
  const track = rampOf('track');
  p.set('w', lerpRGB(track[3], WHITE, 0.02)).set('t', track[2]).set('r', lerpRGB(track[3], WHITE, 0.2)).set('c', lerpRGB(track[3], WHITE, 0.34));
  p.set('k', track[1]);
  const skin = rampOf('skin');
  p.set('s', skin[2]).set('S', skin[1]);
  const canvas = rampOf('canvas');
  p.set('P', canvas[3]).set('p', canvas[2]).set('b', canvas[1]);
  p.set('m', UNKNOWN_GREYS[0]).set('n', UNKNOWN_GREYS[1]).set('Q', UNKNOWN_GREYS[2]);
  return p;
}

const OWNER_PART = new Set(['1', '2', '3', '4']);

// ------------------------------------------------------------------------------------------------ placement and bake

interface Placement {
  ox: number;
  oy: number;
  sw: number;
  sh: number;
}
const placements = new Map<string, Placement>();

/** Where a sprite sits in its size + 2 px footprint (1x pixels): centred across, standing on the shared ground row. */
function placement(kind: TroopIconKind, size: number): Placement {
  const key = `${kind}|${size}`;
  let p = placements.get(key);
  if (!p) {
    const rows = spriteOf(kind, size);
    const W = size + 2;
    const sw = Math.max(...rows.map((r) => r.length));
    const sh = rows.length;
    // the tallest sprite at this size sets the ground row every kind stands on
    let H = 0;
    for (const k of ['infantry', 'armor', 'artillery', 'troops'] as const) H = Math.max(H, spriteOf(k, size).length);
    p = { ox: Math.floor((W - sw) / 2), oy: Math.floor((W - H) / 2) + H - sh, sw, sh };
    placements.set(key, p);
  }
  return p;
}

/** A marker's visible extent across its footprint, its outline included: x px from the footprint's left, w px wide. */
export function troopIconSpan(kind: TroopIconKind, size = 16): { x: number; w: number } {
  const { ox, sw } = placement(kind, size);
  return { x: ox - 1, w: sw + 2 };
}

/**
 * One troop icon as RGBA, (size + 2) * res px square and transparent round the unit: the sprite on the shared ground
 * row, every pixel next to it (left, right, above, below) the outline. A dark nation's parts get a lighter rim where
 * their top or left edge meets the outline, so they still part from a dark pill. `res` 2 is the 2x set (the same icon
 * at twice the pixels, its detail drawn again).
 */
export function bakeTroopIcon(kind: TroopIconKind, owner: readonly number[], size = 16, res: 1 | 2 = 1): IconBitmap {
  const W = (size + 2) * res;
  const data = new Uint8ClampedArray(W * W * 4);
  const rows = spriteOf(kind, size, res);
  const pal = paletteOf(owner);
  const p = placement(kind, size);
  const ox = p.ox * res;
  const oy = p.oy * res;
  const at = (x: number, y: number): string => {
    const ch = rows[y - oy]?.[x - ox];
    return ch !== undefined && (ch === 'x' || pal.has(ch)) ? ch : '.';
  };
  const solid = (x: number, y: number): boolean => {
    const ch = at(x, y);
    return ch !== '.' && ch !== 'x';
  };
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
      if (ch === 'x') continue;
      if (ch !== '.') {
        if (rim && OWNER_PART.has(ch) && (!solid(x, y - 1) || !solid(x - 1, y))) ch = '5';
        put(o, pal.get(ch)!, 255);
      } else if (solid(x - 1, y) || solid(x + 1, y) || solid(x, y - 1) || solid(x, y + 1)) put(o, OUTLINE, 235);
    }
  return { w: W, h: W, data };
}

const cache = new Map<string, HTMLCanvasElement | null>();
function iconCanvas(kind: TroopIconKind, owner: readonly number[], size: number, res: 1 | 2): HTMLCanvasElement | null {
  const key = `${kind}|${owner[0]},${owner[1]},${owner[2]}|${size}|${res}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  let cv: HTMLCanvasElement | null = null;
  if (typeof document !== 'undefined' && typeof ImageData !== 'undefined') {
    const b = bakeTroopIcon(kind, owner, size, res);
    cv = makeCanvas(b.w, b.h);
    const ctx = cv.getContext('2d');
    if (ctx) ctx.putImageData(new ImageData(b.data, b.w, b.h), 0, 0);
    else cv = null;
  }
  if (cache.size > 400) cache.clear();
  cache.set(key, cv);
  return cv;
}

/**
 * The set to draw with for a canvas: the 2x set when the canvas is scaled by an even whole number of device px per
 * CSS px (a 2x or 4x screen), else the 1x set (each of its pixels then a whole number of device px too on a 3x screen).
 */
function resFor(ctx: CanvasRenderingContext2D): 1 | 2 {
  const m = typeof ctx.getTransform === 'function' ? ctx.getTransform() : null;
  const k = m ? Math.hypot(m.a, m.b) : 1;
  return k >= 1.75 && Math.round(k) % 2 === 0 ? 2 : 1;
}

export const detailedTroopIcons: TroopIconArt = {
  bare: true,
  span: troopIconSpan,
  draw(ctx, kind, x, y, owner, size) {
    const cv = iconCanvas(kind, owner, size, resFor(ctx));
    if (!cv) return 0;
    const W = size + 2;
    const prev = ctx.imageSmoothingEnabled;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(cv, Math.round(x), Math.round(y), W, W);
    ctx.imageSmoothingEnabled = prev;
    return W;
  },
};
