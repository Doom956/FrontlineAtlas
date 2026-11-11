// Pixel Ops: original pixel-art sprites for the mobile units on the map. Each sprite is drawn once into a small
// offscreen canvas as hard-edged rectangles in a limited palette (gunmetal + the owner's colour as a readable team
// band), then blitted with nearest-neighbour scaling and the heading snapped to 16 directions so the pixels stay
// crisp and do not shimmer. Baked canvases are cached per (sprite, owner colour), so hundreds of units cost a
// drawImage each. Sprites face east (nose at +x); the renderer rotates them to the heading.
//
// The art here is original, defined entirely as code (rect lists), no external images. The old line glyphs in
// unitGlyphs.ts stay for the far-zoom/trail passes and the unit-glyph tests; the detailed near-zoom unit is this.
import type { UnitType } from '../../sim/types';
import { clamp, makeCanvas, type RGB, shade } from './common';

/** A filled rectangle in sprite-pixel coordinates (x right, y down), colour by palette key. */
interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
  c: Key;
}
type Key = 'o' | 'h' | 'H' | 's' | 't' | 'g' | 'k' | 'b' | 'B' | 'w' | 'c' | 'f' | 'F' | 'd';

interface SpriteDef {
  /** Grid size (sprite pixels). */
  w: number;
  h: number;
  rects: Rect[];
}

const R = (x: number, y: number, w: number, h: number, c: Key): Rect => ({ x, y, w, h, c });

// Sprites face east. Ships carry a gunmetal hull with a bright team band so the owner reads without tinting the whole
// hull; tanks, planes and missiles are built from the owner's colour with a darker outline. Heights are kept small.
const SPRITES: Record<string, SpriteDef> = {
  // destroyer: long low hull, pointed bow, bridge block, two gun turrets with barrels, a team band along the waterline
  warship: {
    w: 22,
    h: 9,
    rects: [
      R(2, 3, 16, 3, 'h'),
      R(18, 4, 3, 1, 'h'),
      R(2, 4, 18, 1, 'H'),
      R(9, 1, 4, 2, 's'),
      R(5, 2, 2, 1, 't'),
      R(7, 2, 3, 1, 'g'),
      R(13, 2, 2, 1, 't'),
      R(15, 2, 3, 1, 'g'),
      R(2, 6, 17, 1, 'k'),
    ],
  },
  // battleship: a longer, heavier hull, a tall bridge, three turrets (two forward, one aft)
  battleship: {
    w: 26,
    h: 11,
    rects: [
      R(2, 4, 20, 4, 'h'),
      R(22, 5, 3, 2, 'h'),
      R(2, 5, 22, 1, 'H'),
      R(10, 1, 5, 3, 's'),
      R(12, 0, 1, 1, 'g'),
      R(4, 3, 3, 1, 't'),
      R(1, 3, 3, 1, 'g'),
      R(16, 3, 2, 1, 't'),
      R(18, 3, 3, 1, 'g'),
      R(19, 2, 2, 1, 't'),
      R(21, 2, 3, 1, 'g'),
      R(2, 8, 21, 1, 'k'),
    ],
  },
  // carrier: a long flat deck with a small island on one side and a painted deck line
  carrier: {
    w: 26,
    h: 10,
    rects: [
      R(1, 2, 23, 6, 'h'),
      R(24, 3, 1, 4, 'h'),
      R(3, 4, 19, 1, 'w'),
      R(14, 0, 3, 2, 's'),
      R(1, 8, 23, 1, 'k'),
    ],
  },
  // submarine: long rounded hull sitting low, a conning tower and a periscope, a thin team band
  submarine: {
    w: 22,
    h: 7,
    rects: [
      R(2, 3, 17, 2, 'h'),
      R(19, 3, 2, 1, 'h'),
      R(2, 2, 15, 1, 'H'),
      R(9, 1, 3, 1, 's'),
      R(10, 0, 1, 1, 'g'),
      R(3, 4, 15, 1, 'k'),
    ],
  },
  // landing craft: short boxy hull, a square bow ramp, one cargo block, team band
  transport: {
    w: 16,
    h: 9,
    rects: [
      R(2, 3, 12, 3, 'h'),
      R(2, 2, 12, 1, 'H'),
      R(6, 1, 4, 2, 'b'),
      R(12, 2, 2, 4, 's'),
      R(2, 6, 12, 1, 'k'),
    ],
  },
  // trade ship: pointed hull with three container blocks on deck
  tradeShip: {
    w: 20,
    h: 9,
    rects: [
      R(2, 4, 15, 3, 'h'),
      R(17, 5, 2, 1, 'h'),
      R(2, 3, 16, 1, 'H'),
      R(4, 1, 3, 2, 'b'),
      R(8, 1, 3, 2, 'k'),
      R(12, 1, 3, 2, 'b'),
      R(2, 7, 15, 1, 'k'),
    ],
  },
  // tank division: hull, tracks top and bottom, round-ish turret, long barrel forward, team band on the hull side
  tankDivision: {
    w: 21,
    h: 12,
    rects: [
      R(1, 0, 15, 2, 'd'),
      R(1, 10, 15, 2, 'd'),
      R(2, 1, 1, 1, 'h'),
      R(5, 1, 1, 1, 'h'),
      R(8, 1, 1, 1, 'h'),
      R(11, 1, 1, 1, 'h'),
      R(14, 1, 1, 1, 'h'),
      R(2, 10, 1, 1, 'h'),
      R(5, 10, 1, 1, 'h'),
      R(8, 10, 1, 1, 'h'),
      R(11, 10, 1, 1, 'h'),
      R(14, 10, 1, 1, 'h'),
      R(1, 2, 16, 8, 'b'),
      R(1, 2, 16, 1, 'B'),
      R(16, 3, 1, 6, 'B'),
      R(2, 4, 1, 4, 'd'),
      R(4, 4, 1, 4, 'd'),
      R(7, 3, 6, 6, 'B'),
      R(7, 8, 6, 1, 'b'),
      R(8, 4, 2, 2, 't'),
      R(13, 5, 6, 2, 'g'),
      R(19, 4, 1, 4, 'g'),
    ],
  },
  // heavy bomber: long body, straight wings across the span, four engine nacelles, a tail plane
  bomber: {
    w: 18,
    h: 16,
    rects: [
      R(7, 2, 4, 12, 'b'),
      R(7, 2, 2, 12, 'B'),
      R(14, 6, 3, 4, 'b'),
      R(2, 7, 14, 2, 'b'),
      R(2, 7, 14, 1, 'B'),
      R(4, 6, 1, 4, 'd'),
      R(8, 6, 1, 4, 'd'),
      R(10, 6, 1, 4, 'd'),
      R(13, 6, 1, 4, 'd'),
      R(3, 1, 2, 2, 'k'),
      R(3, 13, 2, 2, 'k'),
      R(9, 7, 1, 2, 'c'),
    ],
  },
  // fighter: small swept delta with a bright team flash on the tail
  fighter: {
    w: 14,
    h: 12,
    rects: [
      R(4, 5, 8, 2, 'b'),
      R(11, 5, 2, 2, 'b'),
      R(4, 3, 4, 6, 'b'),
      R(4, 3, 2, 6, 'B'),
      R(2, 4, 2, 4, 'k'),
      R(8, 5, 1, 2, 'c'),
    ],
  },
  // transport plane: fat fuselage, high boxy wings, a T-tail
  transportPlane: {
    w: 18,
    h: 14,
    rects: [
      R(5, 4, 9, 5, 'b'),
      R(14, 5, 3, 3, 'b'),
      R(5, 4, 9, 2, 'B'),
      R(3, 6, 12, 2, 's'),
      R(3, 1, 2, 3, 'b'),
      R(2, 1, 4, 1, 'b'),
      R(5, 3, 2, 2, 'k'),
      R(10, 5, 1, 2, 'c'),
    ],
  },
  // recon plane: a slim body, long straight high wings, a camera pod and a twin tail
  reconPlane: {
    w: 16,
    h: 16,
    rects: [
      R(4, 7, 10, 2, 'b'),
      R(4, 7, 10, 1, 'B'),
      R(14, 7, 1, 2, 'w'),
      R(8, 1, 2, 14, 'b'),
      R(8, 1, 1, 14, 'B'),
      R(2, 5, 1, 6, 'k'),
      R(3, 6, 2, 1, 'b'),
      R(3, 9, 2, 1, 'b'),
      R(11, 8, 1, 1, 'c'),
    ],
  },
  // rocket: slim missile body, nose cone, swept fins, a hot exhaust flame behind
  rocket: {
    w: 20,
    h: 9,
    rects: [
      R(5, 4, 11, 2, 'b'),
      R(5, 4, 11, 1, 'B'),
      R(16, 3, 2, 3, 'w'),
      R(5, 2, 2, 2, 'k'),
      R(5, 6, 2, 2, 'k'),
      R(3, 4, 2, 2, 'f'),
      R(1, 4, 2, 1, 'F'),
    ],
  },
  // atom bomb: fatter body, a warning band ring, nose cone, fins, a bigger flame
  atomBomb: {
    w: 22,
    h: 11,
    rects: [
      R(5, 4, 13, 3, 'b'),
      R(5, 4, 13, 1, 'B'),
      R(18, 3, 2, 4, 'w'),
      R(11, 4, 1, 3, 'k'),
      R(13, 4, 1, 3, 'k'),
      R(5, 2, 2, 2, 'k'),
      R(5, 7, 2, 2, 'k'),
      R(2, 4, 3, 3, 'f'),
      R(0, 5, 2, 1, 'F'),
    ],
  },
};

/** Palette for a sprite given the owner colour. Hull stays gunmetal; the owner colour shows as body + team band. */
function palette(owner: RGB): Record<Key, string> {
  const css = (c: RGB): string => `rgb(${c[0]},${c[1]},${c[2]})`;
  const band: RGB = [clamp(owner[0] + 40, 0, 255), clamp(owner[1] + 40, 0, 255), clamp(owner[2] + 40, 0, 255)];
  return {
    o: '#111309',
    h: '#565d4b',
    H: '#767e64',
    s: '#888f73',
    t: '#2b2f25',
    g: '#191c13',
    d: '#23261d',
    w: '#d9d6c6',
    c: '#8fb0cf',
    f: '#f6a24a',
    F: '#ffe08a',
    k: css(band),
    b: css(shade(owner, 0.82)),
    B: css(owner),
  };
}

const cache = new Map<string, HTMLCanvasElement>();

/** Baked sprite canvas (sprite-pixel resolution) for a type and owner colour. */
function bake(key: string, owner: RGB): HTMLCanvasElement {
  const ck = `${key}|${owner[0]},${owner[1]},${owner[2]}`;
  const hit = cache.get(ck);
  if (hit) return hit;
  const def = SPRITES[key];
  const pal = palette(owner);
  const cv = makeCanvas(def.w, def.h);
  const ctx = cv.getContext('2d');
  if (ctx) {
    // 1px dark outline: draw each body rect one pixel larger in the outline colour first, then the fill on top.
    ctx.fillStyle = pal.o;
    for (const r of def.rects) ctx.fillRect(r.x - 1, r.y - 1, r.w + 2, r.h + 2);
    for (const r of def.rects) {
      ctx.fillStyle = pal[r.c];
      ctx.fillRect(r.x, r.y, r.w, r.h);
    }
  }
  if (cache.size > 400) cache.clear();
  cache.set(ck, cv);
  return cv;
}

/** True when this unit type / variant has a pixel sprite. */
export function hasSprite(type: UnitType, variant?: string): boolean {
  return spriteKey(type, variant) in SPRITES;
}

/** The sprite for a unit: naval variants (submarine, battleship, carrier) have their own art, others the type's. */
function spriteKey(type: UnitType, variant: string | undefined): string {
  return type === 'warship' && variant && variant in SPRITES ? variant : type;
}

/** Below this length (CSS px) a unit is a simple marker, not a sprite: the zoomed-out map stays calm. */
export const SPRITE_MIN_PX = 15;

/** What kind of far marker a unit gets: ships a short bar, land a square, aircraft a dart, missiles a hot point. */
function markerKind(type: UnitType): 'sea' | 'land' | 'air' | 'missile' {
  if (type === 'tankDivision') return 'land';
  if (type === 'rocket' || type === 'atomBomb') return 'missile';
  if (type === 'bomber' || type === 'fighter' || type === 'transportPlane' || type === 'reconPlane') return 'air';
  return 'sea';
}

/**
 * Far zoom: one flat owner-coloured marker per unit with a 1px dark edge, pixel-snapped. Ships are a short bar along
 * the heading, divisions a square, aircraft a small dart, missiles a bright point; no detail to clutter the map.
 */
function drawMarker(ctx: CanvasRenderingContext2D, type: UnitType, x: number, y: number, lenPx: number, angle: number, owner: RGB): void {
  const fill = `rgb(${owner[0]},${owner[1]},${owner[2]})`;
  const k = markerKind(type);
  const px = Math.round(x);
  const py = Math.round(y);
  ctx.fillStyle = '#0b0d08';
  if (k === 'land') {
    const s = Math.max(4, Math.round(lenPx * 0.42));
    ctx.fillRect(px - s / 2 - 1, py - s / 2 - 1, s + 2, s + 2);
    ctx.fillStyle = fill;
    ctx.fillRect(px - s / 2, py - s / 2, s, s);
    return;
  }
  if (k === 'missile') {
    ctx.fillRect(px - 2, py - 2, 4, 4);
    ctx.fillStyle = '#ffe08a';
    ctx.fillRect(px - 1, py - 1, 2, 2);
    return;
  }
  ctx.save();
  ctx.translate(px, py);
  ctx.rotate(Math.round(angle / (Math.PI / 4)) * (Math.PI / 4));
  if (k === 'sea') {
    const l = Math.max(7, Math.round(lenPx * 0.75));
    ctx.fillRect(-l / 2 - 1, -2.5, l + 2, 5);
    ctx.fillStyle = fill;
    ctx.fillRect(-l / 2, -1.5, l, 3);
  } else {
    const l = Math.max(6, Math.round(lenPx * 0.6));
    ctx.beginPath();
    ctx.moveTo(l / 2 + 1, 0);
    ctx.lineTo(-l / 2 - 1, -l / 2 - 1);
    ctx.lineTo(-l / 4, 0);
    ctx.lineTo(-l / 2 - 1, l / 2 + 1);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = fill;
    ctx.beginPath();
    ctx.moveTo(l / 2 - 0.5, 0);
    ctx.lineTo(-l / 2, -l / 2 + 0.5);
    ctx.lineTo(-l / 4 + 0.5, 0);
    ctx.lineTo(-l / 2, l / 2 - 0.5);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
}

/**
 * Blits a unit's pixel sprite centred at (x, y), its longer axis `lenPx` CSS px long, rotated to `angle` (snapped to
 * 16 directions). Nearest-neighbour, so it stays crisp when scaled up.
 */
export function drawUnitSprite(ctx: CanvasRenderingContext2D, type: UnitType, variant: string | undefined, x: number, y: number, lenPx: number, angle: number, owner: RGB, alpha = 1): void {
  if (lenPx < SPRITE_MIN_PX) {
    const prev = ctx.globalAlpha;
    if (alpha !== 1) ctx.globalAlpha = prev * alpha;
    drawMarker(ctx, type, x, y, lenPx, angle, owner);
    ctx.globalAlpha = prev;
    return;
  }
  const key = spriteKey(type, variant);
  const def = SPRITES[key];
  if (!def) return;
  const cv = bake(key, owner);
  const scale = lenPx / def.w;
  const snapped = Math.round(angle / (Math.PI / 8)) * (Math.PI / 8);
  const prevSmooth = ctx.imageSmoothingEnabled;
  const prevAlpha = ctx.globalAlpha;
  ctx.imageSmoothingEnabled = false;
  if (alpha !== 1) ctx.globalAlpha = prevAlpha * alpha;
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(snapped);
  ctx.drawImage(cv, (-def.w * scale) / 2, (-def.h * scale) / 2, def.w * scale, def.h * scale);
  ctx.restore();
  ctx.imageSmoothingEnabled = prevSmooth;
  ctx.globalAlpha = prevAlpha;
}

/**
 * A unit's pixel portrait for the HUD (the unit card): the sprite facing east, scaled by a whole number to fit a
 * `w` x `h` box (CSS px, drawn at 2x for sharp screens), centred, nearest-neighbour. Returns a data URL, or '' when
 * there is no canvas or no sprite.
 */
const portraits = new Map<string, string>();
export function spritePortraitUrl(type: UnitType, variant: string | undefined, owner: RGB, w: number, h: number): string {
  const key = spriteKey(type, variant);
  const def = SPRITES[key];
  if (!def || typeof document === 'undefined') return '';
  const pk = `${key}|${owner.join(',')}|${w}x${h}`;
  const hit = portraits.get(pk);
  if (hit !== undefined) return hit;
  const dpr = 2;
  const cv = makeCanvas(w * dpr, h * dpr);
  const ctx = cv.getContext('2d');
  if (!ctx) return '';
  const src = bake(key, owner);
  const k = Math.max(1, Math.floor(Math.min((w * dpr) / (def.w + 2), (h * dpr) / (def.h + 2))));
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(src, Math.round((w * dpr - def.w * k) / 2), Math.round((h * dpr - def.h * k) / 2), def.w * k, def.h * k);
  let url = '';
  try {
    url = cv.toDataURL();
  } catch {
    /* tainted or no canvas */
  }
  if (portraits.size > 200) portraits.clear();
  portraits.set(pk, url);
  return url;
}
