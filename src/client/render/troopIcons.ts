// Troop icons on the map (client only): infantry, armor and artillery as small chunky pixel markers, in the same
// style as the unit sprites. Each marker is a rounded-square PLATE in the owner's colour (two tones: the colour and a
// darker shade on its lower and right edge) carrying a SYMBOL: a soldier, a tank or a field gun in side view, near
// white on a dark or mid plate and near black on a pale one, shaded in 4 tones with the light from the top left. A
// 1 px dark outline goes round the whole marker. The team colour is only ever the plate, never the symbol.
//
// Used by the troop pills (front pills in fronts.ts, transports in units.ts: a count with the icons of the troop
// types in it, so the mix of an army reads at a glance) and next to each nation's army count (names.ts). Baked once per
// (kind, owner colour, size) into a small canvas and drawn at whole pixels. Pure data + a pure baker (testable in node).
import type { Troops, TroopType } from '../../sim/types';
import { formatCount, MAP_NUM_FAMILY, makeCanvas, type RGB } from './common';
import { ownerRamp, OUTLINE } from './spriteBake';

/** The troop symbol, or 'troops' for a mix the viewer does not know (a soldier with a small question mark). */
export type TroopIconKind = TroopType | 'troops';

/**
 * Symbols, 12 px tall at most, side view facing right. a..d = light to dark tones of the symbol ramp, '.' = plate.
 * Infantry is a touch taller than wide, the vehicles wider than tall.
 */
const SYMBOLS: Record<TroopType, readonly string[]> = {
  infantry: [
    '...abbb.....',
    '..abbbbc..d.',
    '..abbbbc..d.',
    '.abbbbbbc.d.',
    '...cbbbc..d.',
    '...cbbbc..d.',
    '....ccc...d.',
    '..abbbbbcbd.',
    '.abbbbbbbbc.',
    'abbbbbbbbbbc',
    'abbbbbbbbbbc',
    'bccccccccccd',
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
  artillery: [
    '............ab',
    '..........abc.',
    '........abbc..',
    '......abbc....',
    '....abbbc.....',
    '...abbbbc.....',
    '...bcdddc.....',
    '..bd.c.d......',
    '.bbdcacd......',
    'bb.d.c.d......',
    'b...ddd.......',
  ],
};

/** The same symbols at about 8 px, for the small plates (transports, nation army counts). */
const SMALL: Record<TroopType, readonly string[]> = {
  infantry: [
    '..abb..d',
    '.abbbc.d',
    'abbbbbcd',
    '..cbc..d',
    '.abbbcbd',
    'abbbbbbc',
    'abbbbbbc',
    'bccccccd',
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
    '.........a',
    '.......abc',
    '.....abbc.',
    '...abbbc..',
    '..abbbc...',
    '.bcdddc...',
    'bbd.a.d...',
    'b..ddd....',
  ],
};

/** A tiny question mark for an unknown mix (3 x 5, tone b). */
const QUESTION = ['bb.', '..b', '.b.', '...', '.b.'];

const LIGHT_SYMBOL: RGB[] = [
  [255, 255, 255],
  [226, 230, 229],
  [176, 184, 188],
  [118, 127, 134],
];
const DARK_SYMBOL: RGB[] = [
  [74, 82, 90],
  [46, 53, 60],
  [30, 35, 41],
  [14, 17, 21],
];

export interface IconBitmap {
  w: number;
  h: number;
  data: Uint8ClampedArray;
}

/** Plate size (px) of the troop markers. */
export const PLATE = 16;

/** True when a symbol on this plate colour should be dark (a pale plate). */
export function darkSymbolOn(owner: RGB): boolean {
  const base = ownerRamp(owner)[2];
  return 0.299 * base[0] + 0.587 * base[1] + 0.114 * base[2] > 168;
}

/**
 * One troop marker as RGBA: the owner plate (`size` px, rounded corners, a darker lower and right edge), the symbol
 * centred on it with a 1 px drop shadow, and a 1 px dark outline round the plate (the bitmap is size + 2 px wide).
 */
export function bakeTroopIcon(kind: TroopIconKind, owner: RGB, size = PLATE): IconBitmap {
  const W = size + 2;
  const H = size + 2;
  const data = new Uint8ClampedArray(W * H * 4);
  const ramp = ownerRamp(owner);
  const plate = ramp[2];
  const edge = ramp[1];
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
  for (let y = -1; y <= size; y++) {
    for (let x = -1; x <= size; x++) {
      if (inPlate(x, y)) {
        // two tones: the lower and right edge in the darker shade, a light pixel row along the top
        const lowRight = !inPlate(x + 1, y) || !inPlate(x, y + 1) || !inPlate(x + 1, y + 1) || !inPlate(x + 2, y) || !inPlate(x, y + 2);
        set(x + 1, y + 1, lowRight ? edge : !inPlate(x, y - 1) ? ramp[3] : plate);
      } else if (inPlate(x - 1, y) || inPlate(x + 1, y) || inPlate(x, y - 1) || inPlate(x, y + 1)) set(x + 1, y + 1, OUTLINE);
    }
  }
  const symKind: TroopType = kind === 'troops' ? 'infantry' : kind;
  const rows = (size < 14 ? SMALL : SYMBOLS)[symKind];
  const sw = Math.max(...rows.map((r) => r.length));
  const sh = rows.length;
  const tones = darkSymbolOn(owner) ? DARK_SYMBOL : LIGHT_SYMBOL;
  const shadow = ramp[0];
  const ox = 1 + Math.floor((size - sw) / 2) + (kind === 'troops' ? 1 : 0);
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
      if (t >= 0) set(ox + x, oy + y, tones[t]);
    }
  if (kind === 'troops' && size >= 14) {
    const qx = 2;
    const qy = 2;
    for (let y = 0; y < QUESTION.length; y++) for (let x = 0; x < 3; x++) if (QUESTION[y][x] === 'b') set(qx + x, qy + y, tones[0]);
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
export function drawTroopIcon(ctx: CanvasRenderingContext2D, kind: TroopIconKind, x: number, y: number, owner: RGB, size = PLATE): number {
  const cv = iconCanvas(kind, owner, size);
  if (!cv) return 0;
  const prev = ctx.imageSmoothingEnabled;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(cv, Math.round(x), Math.round(y));
  ctx.imageSmoothingEnabled = prev;
  return cv.width;
}

/**
 * The troop types to show for an army: every type with at least 12% of it, the biggest first (at least one); a mix
 * the viewer may not see (another nation's, without intel) is one 'troops' marker.
 */
export function troopKinds(t: Troops | null): TroopIconKind[] {
  if (!t) return ['troops'];
  const total = t.infantry + t.armor + t.artillery;
  if (total <= 0) return ['infantry'];
  const parts: [TroopType, number][] = [
    ['infantry', t.infantry],
    ['armor', t.armor],
    ['artillery', t.artillery],
  ];
  parts.sort((a, b) => b[1] - a[1]);
  const out = parts.filter(([, n], i) => i === 0 || n / total >= 0.12).map(([k]) => k);
  return out;
}

/** Overlap of stacked markers in a pill (px). */
const STACK = 6;

export interface TroopPillStyle {
  /** coloured accent: the arrow and, for an attack on you, the outline */
  edge: string;
  arrow: 'up' | 'down' | 'none';
  /** red outline (an attack on you) */
  alarm?: boolean;
  /** smaller pill (transports): 12 px plates, 10 px text */
  small?: boolean;
}

/**
 * A troop pill centred at (x, y): the stacked troop markers on the left, then the count with its unit ("12.3k
 * troops") on a near-black plate with a 1 px dark outline, and the push arrow (yours up, an incoming attack down).
 * Returns the pill's width.
 */
export function troopPill(ctx: CanvasRenderingContext2D, x: number, y: number, troops: number, kinds: readonly TroopIconKind[], owner: RGB, st: TroopPillStyle): number {
  const plate = st.small ? 12 : PLATE;
  const font = st.small ? 10 : 11;
  const text = `${formatCount(troops)} troops`;
  ctx.font = `600 ${font}px ${MAP_NUM_FAMILY}`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  const tw = Math.ceil(ctx.measureText(text).width);
  const n = Math.max(1, kinds.length);
  const iconsW = plate + 2 + (n - 1) * (plate + 2 - STACK);
  const ax = st.arrow === 'none' ? 0 : st.small ? 7 : 9;
  const h = plate + 4;
  const w = iconsW + 4 + tw + 6 + ax;
  const x0 = Math.round(x - w / 2);
  const y0 = Math.round(y - h / 2);
  // the plate behind the number, tucked under the markers: a 1 px outline (red when the attack is on you), a
  // near-black fill and a faint light top row
  const bx = x0 + iconsW - 4;
  const bw = w - iconsW + 4;
  ctx.fillStyle = st.alarm ? '#ff6b5e' : 'rgb(8,10,13)';
  ctx.fillRect(bx, y0, bw, h);
  ctx.fillStyle = 'rgba(20,23,29,0.96)';
  ctx.fillRect(bx + 1, y0 + 1, bw - 2, h - 2);
  ctx.fillStyle = 'rgba(255,255,255,0.08)';
  ctx.fillRect(bx + 1, y0 + 1, bw - 2, 1);
  // troop markers, the biggest share in front (drawn last)
  for (let i = n - 1; i >= 0; i--) drawTroopIcon(ctx, kinds[i] ?? 'troops', x0 + i * (plate + 2 - STACK), y0 + 1, owner, plate);
  const tx = x0 + iconsW + 3;
  ctx.fillStyle = '#ffffff';
  ctx.fillText(text, tx, y0 + h / 2 + 0.5);
  if (st.arrow !== 'none') {
    // a solid pixel triangle: up for your push, down for an attack on you
    const cx = tx + tw + 3 + Math.floor(ax / 2);
    const cy = Math.round(y0 + h / 2);
    const rows = st.small ? 3 : 4;
    ctx.fillStyle = st.edge;
    for (let i = 0; i < rows; i++) {
      const yy = st.arrow === 'up' ? cy - Math.floor(rows / 2) + i : cy + Math.floor(rows / 2) - i - 1;
      ctx.fillRect(cx - i, yy, 1 + i * 2, 1);
    }
  }
  return w;
}
