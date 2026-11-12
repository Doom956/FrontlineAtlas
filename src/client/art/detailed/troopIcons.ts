// The detailed style's troop icons (client only): the same meaning as before (infantry, armor, artillery, or an
// unknown mix on the owner's plate; the pills that carry them and their counts are shared), drawn less like cartoons:
// a plate in the owner's colour, a little desaturated, with a 3-tone bevel (lit top and left edges, dark bottom and
// right edges, cut corners) and a translucent dark rim instead of a black outline, carrying a stencilled figure in
// side view: a slim soldier in a helmet walking with his rifle up, a low long tank with its road wheels and its gun
// past the nose, a field gun with a long raised barrel, its shield, a round wheel and the trail, or a question mark for
// a mix the viewer does not know. The figure is off-white on a dark or mid plate and dark ink on a pale one, in 3
// tones lit from the top left with a soft shadow. Baked once per (kind, owner, size) and drawn on whole pixels.
import { makeCanvas } from '../../render/common';
import { hex, luma, type RGB } from '../shared/colour';
import type { TroopIconArt, TroopIconKind } from '../types';
import { ownerTones } from './palette';

/** a..d: light to dark tones of the figure, '.' = plate. Side view, facing right. */
const SYMBOLS: Record<TroopIconKind, readonly string[]> = {
  // a slim rifleman in a helmet, walking, his rifle held up and forward
  infantry: [
    '.....abc.....',
    '....abbbc....',
    '...cbbbbbc...',
    '.....bbc.....',
    '....abbbc..cc',
    '....bbbbbcc..',
    '...abbbbc....',
    '....bbbc.....',
    '....bbbc.....',
    '....bc.bc....',
    '...bc...bc...',
    '..cc.....cc..',
  ],
  // a low, long tank: a small turret set back, its gun reaching past the nose, road wheels in the track
  armor: [
    '....abbbc.....',
    '...abbbbbcaaaa',
    '.abbbbbbbbbc..',
    'abbbbbbbbbbbc.',
    '.dcdcdcdcdcd..',
  ],
  // a field gun: a long barrel raised at about 30 degrees, the shield, a round spoked wheel, the trail on the ground
  artillery: [
    '..........ab',
    '........abbc',
    '......abbc..',
    '....abbbc...',
    '..aabbbbc...',
    '..bbbbbbbc..',
    '.bc.dcccd...',
    'bc.dc...cd..',
    'c..c..b..c..',
    '...dc...cd..',
    '....dcccd...',
  ],
  troops: [
    '..abbbc..',
    '.abbcbbc.',
    '.bc...bbc',
    '......bbc',
    '....abbc.',
    '...abbc..',
    '...bbc...',
    '...cc....',
    '.........',
    '...abc...',
    '...bcc...',
  ],
};

/** The same figures at about 8 to 10 px, for the small plates (transports, nation army counts). */
const SMALL: Record<TroopIconKind, readonly string[]> = {
  infantry: [
    '...abc...',
    '..cbbbc..',
    '...bc....',
    '..abbc.cc',
    '..bbbcc..',
    '..bbc....',
    '..b.bc...',
    '.cc..cc..',
  ],
  armor: [
    '...abbc...',
    '..abbbbcaa',
    '.abbbbbbc.',
    'abbbbbbbc.',
    '.dcdcdcd..',
  ],
  // a gun, not a head: the barrel at about 30 degrees, the shield, a round wheel with its hub, the trail
  artillery: [
    '........ab',
    '......abbc',
    '....abbc..',
    '..abbbbc..',
    '.abbbbbbc.',
    'bc.dcccd..',
    'c..c.b.c..',
    '...dcccd..',
  ],
  troops: [
    '.abbc.',
    'abc.bc',
    '....bc',
    '..abc.',
    '..bc..',
    '......',
    '..bc..',
  ],
};

const LIGHT: RGB[] = ['#f1eee6', '#d6d2c7', '#a8a397', '#6d6960'].map(hex);
const DARK: RGB[] = ['#4c4b45', '#33322e', '#22211e', '#121210'].map(hex);

export interface IconBitmap {
  w: number;
  h: number;
  data: Uint8ClampedArray;
}

/** True when the figure on this owner's plate should be dark ink (a pale plate). */
export function darkFigureOn(owner: readonly number[]): boolean {
  return luma(ownerTones(owner, PLATE_QUIET)[2]) > 165;
}

/** The plate's owner colour, a little desaturated (toward its own grey) so it sits with the muted unit art. */
const PLATE_QUIET = 0.2;
const mix = (a: readonly number[], b: readonly number[], t: number): RGB => [Math.round(a[0] + (b[0] - a[0]) * t), Math.round(a[1] + (b[1] - a[1]) * t), Math.round(a[2] + (b[2] - a[2]) * t)];

/**
 * One troop marker as RGBA, size + 2 px square: the owner's plate (`size` px, cut corners, a bevel), the figure
 * centred on it with a soft shadow, and a translucent dark rim round the plate.
 */
export function bakeTroopIcon(kind: TroopIconKind, owner: readonly number[], size = 16): IconBitmap {
  const W = size + 2;
  const data = new Uint8ClampedArray(W * W * 4);
  const tones = ownerTones(owner, PLATE_QUIET);
  const set = (x: number, y: number, c: readonly number[], a = 255): void => {
    if (x < 0 || y < 0 || x >= W || y >= W) return;
    const o = (y * W + x) * 4;
    data[o] = c[0];
    data[o + 1] = c[1];
    data[o + 2] = c[2];
    data[o + 3] = a;
  };
  const inPlate = (x: number, y: number): boolean => {
    if (x < 0 || y < 0 || x >= size || y >= size) return false;
    const cx = x < 1 ? 1 - x : x > size - 2 ? x - (size - 2) : 0;
    const cy = y < 1 ? 1 - y : y > size - 2 ? y - (size - 2) : 0;
    return cx + cy <= 1;
  };
  // the plate: a 3-tone bevel (a lit outer edge and a softer inner one on the top and left, a dark outer edge and a
  // softer inner one on the bottom and right) round a fill that lightens a touch toward the top
  for (let y = -1; y <= size; y++) {
    for (let x = -1; x <= size; x++) {
      if (inPlate(x, y)) {
        const top1 = !inPlate(x, y - 1) || !inPlate(x - 1, y);
        const low1 = !inPlate(x, y + 1) || !inPlate(x + 1, y);
        const top2 = !inPlate(x, y - 2) || !inPlate(x - 2, y);
        const low2 = !inPlate(x, y + 2) || !inPlate(x + 2, y);
        const fill = mix(tones[2], tones[3], 0.12 * (1 - y / size));
        const c = low1 ? tones[1] : top1 ? tones[3] : low2 ? mix(tones[2], tones[1], 0.45) : top2 ? mix(tones[2], tones[3], 0.4) : fill;
        set(x + 1, y + 1, c);
      } else if (inPlate(x - 1, y) || inPlate(x + 1, y) || inPlate(x, y - 1) || inPlate(x, y + 1)) {
        set(x + 1, y + 1, [10, 12, 16], inPlate(x - 1, y) || inPlate(x, y - 1) ? 170 : 110);
      }
    }
  }
  const rows = (size < 14 ? SMALL : SYMBOLS)[kind];
  const sw = Math.max(...rows.map((r) => r.length));
  const sh = rows.length;
  const ink = darkFigureOn(owner) ? DARK : LIGHT;
  const ox = 1 + Math.floor((size - sw) / 2);
  const oy = 1 + Math.floor((size - sh) / 2);
  const at = (x: number, y: number): number => {
    const ch = rows[y]?.[x];
    return ch === 'a' ? 0 : ch === 'b' ? 1 : ch === 'c' ? 2 : ch === 'd' ? 3 : -1;
  };
  // a soft shadow one px down and right, then the figure
  for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) if (at(x, y) >= 0 && at(x + 1, y + 1) < 0) set(ox + x + 1, oy + y + 1, tones[0], 150);
  for (let y = 0; y < sh; y++)
    for (let x = 0; x < sw; x++) {
      const t = at(x, y);
      if (t >= 0) set(ox + x, oy + y, ink[t]);
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
