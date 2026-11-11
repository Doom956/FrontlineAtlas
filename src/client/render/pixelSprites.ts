// Pixel Clean: original pixel-art sprites for the mobile units on the map, used only zoomed in (render/units.ts picks
// the level of detail: far = small calm markers and fleet counts, near = these sprites). Each sprite is a list of
// filled rectangles on a small grid, baked once per (sprite, owner colour) into an offscreen canvas with a 1px dark
// outline, then blitted with nearest-neighbour scaling and the heading snapped to 16 directions so the pixels stay
// crisp. Sprites face east (nose at +x).
//
// Look: light painted hulls (warm pale grey, not gunmetal) with the owner's colour as a band or body, a soft top
// highlight, few colours. Bright and friendly against the brighter map, calm enough to sit over any nation colour.
// All art is original and lives in this file as code.
import type { UnitType, UnitVariant } from '../../sim/types';
import { clamp, makeCanvas, mix, type RGB } from './common';

/** Palette keys: h hull, H hull highlight, d deck, s superstructure, g gun / dark metal, t tread, w white,
 * c canopy glass, f flame, F flame core, k team band (bright owner), b owner body, B owner highlight, D owner shade. */
type Key = 'h' | 'H' | 'd' | 's' | 'g' | 't' | 'w' | 'c' | 'f' | 'F' | 'k' | 'b' | 'B' | 'D';

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
  c: Key;
}
interface SpriteDef {
  w: number;
  h: number;
  rects: Rect[];
}

const R = (x: number, y: number, w: number, h: number, c: Key): Rect => ({ x, y, w, h, c });

const SPRITES: Record<string, SpriteDef> = {
  // destroyer: slim hull with a pointed bow, a bridge, two small turrets, owner band along the side
  destroyer: {
    w: 24,
    h: 9,
    rects: [
      R(2, 3, 17, 3, 'h'),
      R(19, 4, 3, 1, 'h'),
      R(2, 3, 17, 1, 'H'),
      R(3, 5, 16, 1, 'k'),
      R(10, 1, 4, 2, 's'),
      R(11, 1, 2, 1, 'c'),
      R(5, 2, 2, 1, 'g'),
      R(7, 2, 3, 1, 'd'),
      R(15, 2, 2, 1, 'g'),
      R(17, 2, 3, 1, 'd'),
    ],
  },
  // battleship: longer, wider hull, a tall stepped tower, three heavy turrets with barrels
  battleship: {
    w: 30,
    h: 11,
    rects: [
      R(2, 3, 23, 5, 'h'),
      R(25, 4, 3, 3, 'h'),
      R(2, 3, 23, 1, 'H'),
      R(3, 7, 22, 1, 'k'),
      R(12, 1, 6, 3, 's'),
      R(13, 0, 3, 1, 's'),
      R(14, 2, 2, 1, 'c'),
      R(4, 4, 3, 2, 'g'),
      R(7, 5, 3, 1, 'g'),
      R(19, 4, 3, 2, 'g'),
      R(22, 5, 3, 1, 'g'),
      R(9, 4, 2, 1, 'd'),
    ],
  },
  // submarine: low rounded hull, a small sail with a periscope, a thin owner band at the waterline
  submarine: {
    w: 24,
    h: 7,
    rects: [
      R(2, 3, 18, 2, 'g'),
      R(20, 3, 2, 1, 'g'),
      R(3, 2, 15, 1, 'd'),
      R(10, 1, 3, 1, 's'),
      R(11, 0, 1, 1, 'g'),
      R(3, 5, 16, 1, 'k'),
    ],
  },
  // carrier: long flat flight deck, an island on the right, a deck stripe, owner band
  carrier: {
    w: 30,
    h: 12,
    rects: [
      R(2, 3, 25, 6, 'h'),
      R(27, 4, 2, 4, 'h'),
      R(3, 4, 23, 4, 'd'),
      R(4, 6, 20, 1, 'w'),
      R(18, 1, 4, 3, 's'),
      R(19, 1, 2, 1, 'c'),
      R(3, 9, 23, 1, 'k'),
    ],
  },
  // landing craft: short boxy hull, a ramp bow, a cargo hold in the owner colour
  transport: {
    w: 18,
    h: 9,
    rects: [
      R(2, 3, 13, 3, 'h'),
      R(15, 3, 1, 3, 'd'),
      R(2, 3, 13, 1, 'H'),
      R(5, 2, 7, 2, 'b'),
      R(5, 2, 7, 1, 'B'),
      R(2, 1, 2, 2, 's'),
      R(2, 6, 13, 1, 'k'),
    ],
  },
  // trade ship: round bow, three stacked containers, a stern house
  tradeShip: {
    w: 22,
    h: 9,
    rects: [
      R(2, 4, 16, 3, 'h'),
      R(18, 5, 2, 1, 'h'),
      R(2, 4, 16, 1, 'H'),
      R(2, 1, 3, 3, 's'),
      R(6, 2, 3, 2, 'b'),
      R(10, 2, 3, 2, 'w'),
      R(14, 2, 3, 2, 'B'),
      R(2, 7, 16, 1, 'k'),
    ],
  },
  // tank division: tracks top and bottom, a light hull, the turret in the owner colour, a forward barrel
  tankDivision: {
    w: 20,
    h: 12,
    rects: [
      R(2, 2, 13, 2, 't'),
      R(2, 8, 13, 2, 't'),
      R(2, 4, 13, 4, 'h'),
      R(2, 4, 13, 1, 'H'),
      R(3, 7, 11, 1, 'd'),
      R(6, 4, 5, 4, 'b'),
      R(7, 5, 3, 1, 'B'),
      R(11, 6, 7, 1, 'g'),
    ],
  },
  // light tank: shorter, a small turret and a short barrel
  lightTank: {
    w: 17,
    h: 10,
    rects: [
      R(2, 2, 10, 1, 't'),
      R(2, 7, 10, 1, 't'),
      R(2, 3, 10, 4, 'h'),
      R(2, 3, 10, 1, 'H'),
      R(5, 4, 4, 2, 'b'),
      R(9, 5, 6, 1, 'g'),
    ],
  },
  // heavy tank: wide tracks, a big square turret, a thick long barrel
  heavyTank: {
    w: 24,
    h: 14,
    rects: [
      R(2, 2, 15, 2, 't'),
      R(2, 10, 15, 2, 't'),
      R(2, 4, 15, 6, 'h'),
      R(2, 4, 15, 1, 'H'),
      R(3, 9, 13, 1, 'd'),
      R(6, 5, 7, 4, 'b'),
      R(7, 6, 5, 1, 'B'),
      R(13, 6, 9, 2, 'g'),
    ],
  },
  // bomber: long body, a wide straight wing with engines, a tail plane, glass nose
  bomber: {
    w: 20,
    h: 18,
    rects: [
      R(9, 1, 4, 16, 'b'),
      R(9, 1, 1, 16, 'B'),
      R(3, 7, 15, 4, 'h'),
      R(3, 7, 15, 1, 'H'),
      R(17, 8, 2, 2, 'c'),
      R(12, 4, 2, 2, 'g'),
      R(12, 12, 2, 2, 'g'),
      R(2, 4, 3, 10, 'D'),
      R(3, 8, 6, 2, 'k'),
    ],
  },
  // fighter: small swept delta, a bubble canopy
  fighter: {
    w: 15,
    h: 13,
    rects: [
      R(5, 1, 4, 11, 'b'),
      R(5, 1, 1, 11, 'B'),
      R(9, 3, 2, 7, 'b'),
      R(3, 5, 10, 3, 'h'),
      R(3, 5, 10, 1, 'H'),
      R(13, 6, 1, 1, 'd'),
      R(10, 6, 2, 1, 'c'),
      R(2, 4, 2, 5, 'D'),
    ],
  },
  // cargo plane: fat body, high wing, a T tail
  transportPlane: {
    w: 20,
    h: 16,
    rects: [
      R(9, 1, 3, 14, 'b'),
      R(9, 1, 1, 14, 'B'),
      R(3, 6, 14, 4, 'h'),
      R(3, 6, 14, 1, 'H'),
      R(17, 7, 2, 2, 'c'),
      R(2, 4, 2, 8, 'b'),
      R(4, 8, 4, 1, 'k'),
    ],
  },
  // recon plane: slim body, long thin wings, a camera pod
  reconPlane: {
    w: 17,
    h: 17,
    rects: [
      R(8, 1, 2, 15, 'b'),
      R(8, 1, 1, 15, 'B'),
      R(3, 7, 11, 2, 'h'),
      R(3, 7, 11, 1, 'H'),
      R(14, 7, 1, 2, 'c'),
      R(2, 5, 2, 6, 'D'),
      R(11, 8, 2, 1, 'g'),
    ],
  },
  // rocket: slim body, white nose, fins, a short flame
  rocket: {
    w: 20,
    h: 9,
    rects: [
      R(5, 3, 11, 3, 'w'),
      R(5, 4, 11, 1, 'k'),
      R(16, 3, 2, 3, 'b'),
      R(18, 4, 1, 1, 'b'),
      R(5, 1, 2, 2, 'D'),
      R(5, 6, 2, 2, 'D'),
      R(3, 3, 2, 3, 'f'),
      R(1, 4, 2, 1, 'F'),
    ],
  },
  // atom bomb: fat body, two warning rings, fins, a bigger flame
  atomBomb: {
    w: 22,
    h: 11,
    rects: [
      R(5, 3, 13, 5, 'w'),
      R(18, 4, 2, 3, 'b'),
      R(10, 3, 1, 5, 'f'),
      R(13, 3, 1, 5, 'f'),
      R(5, 4, 13, 1, 'H'),
      R(5, 1, 2, 2, 'D'),
      R(5, 8, 2, 2, 'D'),
      R(2, 4, 3, 3, 'f'),
      R(0, 5, 2, 1, 'F'),
    ],
  },
};

/** Sprite key for a unit (variants have their own art where it differs). */
function spriteKey(type: UnitType, variant: UnitVariant | undefined): string {
  if (type === 'warship') {
    if (variant === 'battleship' || variant === 'submarine' || variant === 'carrier') return variant;
    return 'destroyer';
  }
  if (type === 'tankDivision') {
    if (variant === 'lightTank' || variant === 'heavyTank') return variant;
    return 'tankDivision';
  }
  return type;
}

const OUTLINE = '#1a1f27';

/** Colours for one owner: light painted hulls, the owner as band and body (body evened toward a calm mid tone). */
function palette(owner: RGB): Record<Key, string> {
  const c = (v: RGB): string => `rgb(${v[0] | 0},${v[1] | 0},${v[2] | 0})`;
  const body = mix(owner, [150, 156, 160], 0.12);
  return {
    h: '#c9cdc7',
    H: '#eceee8',
    d: '#a3a89f',
    s: '#dfe2dc',
    g: '#3b424c',
    t: '#2c323a',
    w: '#f4f5f1',
    c: '#9fd6f5',
    f: '#ff9f43',
    F: '#ffe7a1',
    k: c([clamp(owner[0] * 1.08 + 18, 0, 255), clamp(owner[1] * 1.08 + 18, 0, 255), clamp(owner[2] * 1.08 + 18, 0, 255)]),
    b: c(body),
    B: c(mix(body, [255, 255, 255], 0.35)),
    D: c(mix(body, [20, 24, 30], 0.35)),
  };
}

const cache = new Map<string, HTMLCanvasElement>();

function bake(key: string, owner: RGB): HTMLCanvasElement {
  const ck = `${key}|${owner[0]},${owner[1]},${owner[2]}`;
  const hit = cache.get(ck);
  if (hit) return hit;
  const def = SPRITES[key];
  const pal = palette(owner);
  const cv = makeCanvas(def.w, def.h);
  const ctx = cv.getContext('2d');
  if (ctx) {
    ctx.fillStyle = OUTLINE;
    for (const r of def.rects) ctx.fillRect(r.x - 1, r.y - 1, r.w + 2, r.h + 2);
    for (const r of def.rects) {
      ctx.fillStyle = pal[r.c];
      ctx.fillRect(r.x, r.y, r.w, r.h);
    }
  }
  if (cache.size > 500) cache.clear();
  cache.set(ck, cv);
  return cv;
}

/** True when the unit has pixel art. */
export function hasSprite(type: UnitType, variant?: UnitVariant): boolean {
  return spriteKey(type, variant) in SPRITES;
}

/**
 * Draws a unit's pixel sprite centred at (x, y), its length `lenPx` CSS px, rotated to `angle` (snapped to 16
 * directions so the pixels stay crisp). A faint ground shadow sits under planes and missiles so they read as airborne.
 */
export function drawUnitSprite(ctx: CanvasRenderingContext2D, type: UnitType, variant: UnitVariant | undefined, x: number, y: number, lenPx: number, angle: number, owner: RGB, alpha = 1): void {
  const key = spriteKey(type, variant);
  const def = SPRITES[key];
  if (!def) return;
  const cv = bake(key, owner);
  const px = Math.max(1, Math.round((lenPx / def.w) * 2) / 2);
  const w = def.w * px;
  const h = def.h * px;
  const snapped = Math.round(angle / (Math.PI / 8)) * (Math.PI / 8);
  const air = type === 'bomber' || type === 'fighter' || type === 'transportPlane' || type === 'reconPlane' || type === 'rocket' || type === 'atomBomb';
  const prevSmooth = ctx.imageSmoothingEnabled;
  const prevAlpha = ctx.globalAlpha;
  ctx.imageSmoothingEnabled = false;
  ctx.globalAlpha = prevAlpha * alpha;
  ctx.save();
  ctx.translate(Math.round(x), Math.round(y));
  if (air) {
    // the shadow: the same silhouette, dark and offset down-right
    ctx.save();
    ctx.translate(px * 3, px * 4);
    ctx.rotate(snapped);
    ctx.globalAlpha = prevAlpha * alpha * 0.22;
    ctx.filter = 'brightness(0)';
    ctx.drawImage(cv, -w / 2, -h / 2, w, h);
    ctx.filter = 'none';
    ctx.restore();
    ctx.globalAlpha = prevAlpha * alpha;
  }
  ctx.rotate(snapped);
  ctx.drawImage(cv, -w / 2, -h / 2, w, h);
  ctx.restore();
  ctx.imageSmoothingEnabled = prevSmooth;
  ctx.globalAlpha = prevAlpha;
}

/**
 * Far zoom marker: a tiny solid shape in the owner's colour with a dark edge, one per unit class (ship = lozenge,
 * tank = square, plane = small arrow, missile = dot). No detail, so hundreds of them stay calm.
 */
export function drawUnitMarker(ctx: CanvasRenderingContext2D, type: UnitType, x: number, y: number, size: number, angle: number, fill: string): void {
  const s = size;
  ctx.save();
  ctx.translate(x, y);
  ctx.beginPath();
  if (type === 'tankDivision') {
    ctx.rect(-s * 0.42, -s * 0.42, s * 0.84, s * 0.84);
  } else if (type === 'rocket' || type === 'atomBomb') {
    ctx.arc(0, 0, s * (type === 'atomBomb' ? 0.42 : 0.32), 0, Math.PI * 2);
  } else if (type === 'bomber' || type === 'fighter' || type === 'transportPlane' || type === 'reconPlane') {
    ctx.rotate(angle);
    ctx.moveTo(s * 0.55, 0);
    ctx.lineTo(-s * 0.45, s * 0.45);
    ctx.lineTo(-s * 0.2, 0);
    ctx.lineTo(-s * 0.45, -s * 0.45);
    ctx.closePath();
  } else {
    ctx.rotate(angle);
    ctx.moveTo(s * 0.62, 0);
    ctx.lineTo(s * 0.2, s * 0.3);
    ctx.lineTo(-s * 0.55, s * 0.3);
    ctx.lineTo(-s * 0.55, -s * 0.3);
    ctx.lineTo(s * 0.2, -s * 0.3);
    ctx.closePath();
  }
  ctx.lineWidth = 2.5;
  ctx.lineJoin = 'round';
  ctx.strokeStyle = 'rgba(14,18,24,0.8)';
  ctx.stroke();
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.restore();
}
