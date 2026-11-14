// Far zoom unit icons (client only): below the sprite zooms (render/units.ts) every unit is a small crisp silhouette
// of its own kind, seen from above with its nose along the heading, so a first-time player can tell a ship from a
// submarine, a carrier, a tank, a fighter, a bomber, a cargo plane or a missile, and whose it is, without hovering:
//   - filled in the owner's full colour (never quieted), with a 1 CSS px dark outline round the silhouette (a light
//     one for very dark nations) so it separates from any land or sea, a 1 px light rim on its upper and left edges
//     (the same light as the sprites) and a few dark or light details (turrets, a flight deck stripe, tracks, engines);
//   - at least 10 CSS px along its longest side, so even a missile is never a dot;
//   - a fleet (render/fleets.ts) is its lead ship's icon a quarter bigger with a second, darker hull behind it.
// Each icon is painted once per kind, owner colour, heading (32), screen density and size step into this module's
// own atlas page (art/shared/atlas.ts getPainted, under the map's per-frame bake budget) and drawn with one drawImage
// on whole device px. Until it is baked it is painted straight onto the map (the same picture), so there is never a
// gap or a placeholder block. Pure shape data plus canvas painting; no game state.
import type { UnitType, UnitVariant } from '../../sim/types';
import { SpriteAtlas, type AtlasEntry } from '../art/shared/atlas';
import { SPRITE_KEYS, spriteKey, type SpriteKey } from '../art/shared/keys';
import { css, type RGB } from './common';

/** A closed outline, [x0, y0, x1, y1, ...] in CSS px at size 1, nose toward +x. */
type Poly = number[];
/** Detail painted inside the silhouette: a polygon, a round dot or an outlined ring, dark or light. */
interface Detail {
  k: 'poly' | 'dot' | 'ring';
  /** poly: points; dot and ring: x, y, radius (ring: x, y, radius, line width) */
  p: number[];
  tone: 'dark' | 'light';
}
export interface IconShape {
  /** the silhouette: polygons and ellipses (x, y, rx, ry) unioned */
  polys: Poly[];
  ellipses: number[][];
  details: Detail[];
  /** half length along the heading and half beam (CSS px at size 1) */
  half: number;
  beam: number;
  /** drawn a little see-through (a submarine under the surface) */
  alpha: number;
}

/** Upper half outline from the nose back (y >= 0), mirrored into a closed polygon. */
function sym(upper: number[]): Poly {
  const out = upper.slice();
  for (let i = upper.length - 2; i >= 0; i -= 2) {
    if (upper[i + 1] === 0) continue;
    out.push(upper[i], -upper[i + 1]);
  }
  return out;
}
/** A box from (x0, y0) to (x1, y1) as a polygon. */
const box = (x0: number, y0: number, x1: number, y1: number): Poly => [x0, y0, x1, y0, x1, y1, x0, y1];
/** A pointed hull: length L, beam B, the bow taper `bow` long, stern corners cut. */
const hull = (L: number, B: number, bow: number): Poly => {
  const a = L / 2;
  const b = B / 2;
  return sym([a, 0, a - bow, b, -a + 0.8, b, -a, b - 0.8]);
};
/** A tank hull with cut corners, a barrel past the bow. */
const tank = (a: number, b: number, barrel: number, bw: number): Poly[] => [sym([a, b - 1, a - 1, b, -a + 1, b, -a, b - 1]), box(1, -bw / 2, barrel, bw / 2)];
const dark = (k: Detail['k'], ...p: number[]): Detail => ({ k, p, tone: 'dark' });
const light = (k: Detail['k'], ...p: number[]): Detail => ({ k, p, tone: 'light' });

function shape(polys: Poly[], details: Detail[], ellipses: number[][] = [], alpha = 1): IconShape {
  let half = 0;
  let beam = 0;
  for (const p of polys)
    for (let i = 0; i < p.length; i += 2) {
      half = Math.max(half, Math.abs(p[i]));
      beam = Math.max(beam, Math.abs(p[i + 1]));
    }
  for (const e of ellipses) {
    half = Math.max(half, Math.abs(e[0]) + e[2]);
    beam = Math.max(beam, Math.abs(e[1]) + e[3]);
  }
  return { polys, ellipses, details, half, beam, alpha };
}

/** Every sprite key's icon. Sizes are CSS px at size 1 (length x beam). */
export const ICON_SHAPES: Record<SpriteKey, IconShape> = {
  // a plain warship: 13 x 5, pointed bow, a gun turret fore and aft
  warship: shape([hull(13, 5, 4)], [dark('dot', 2.4, 0, 1.05), dark('dot', -3, 0, 1.05)]),
  // destroyer: slimmer and sharper, one turret forward and a funnel
  destroyer: shape([hull(13, 4.2, 5.6)], [dark('dot', 2.2, 0, 0.9), light('dot', -1.8, 0, 0.75)]),
  // battleship: 15 x 6, two big turrets and a light superstructure between them
  battleship: shape([hull(15, 6, 4.5)], [dark('dot', 3.4, 0, 1.35), dark('dot', -4.2, 0, 1.35), light('poly', ...box(-2, -1, 1.2, 1))]),
  // carrier: a flat top with a square stern, a light deck stripe and the island on the starboard edge
  carrier: shape([[7.5, -1.6, 7.5, 1.6, 6, 3, -7.5, 3, -7.5, -3, 6, -3]], [light('poly', ...box(-6.2, -0.45, 6.2, 0.45)), dark('poly', ...box(-1.2, 1.5, 2.2, 2.8))]),
  // submarine: a slim cigar with a dark sail, a little see-through (under the surface)
  submarine: shape([], [dark('dot', 1.2, 0, 1.05)], [[0, 0, 6.2, 1.85]], 0.85),
  // landing craft: short and boxy, a ramp across the bow, a light cargo well
  transport: shape([[5.5, -2.2, 5.5, 2.2, 4.3, 3, -5.5, 3, -5.5, -3, 4.3, -3]], [dark('poly', ...box(3.3, -2.3, 4.2, 2.3)), light('poly', ...box(-3.8, -1.6, 1.8, 1.6))]),
  // trade ship: a beamy merchant hull with a round bow and two light container blocks
  tradeShip: shape([sym([6, 0, 5.5, 1.5, 4.2, 2.8, -5.4, 2.8, -6, 2.2])], [light('poly', ...box(-4.2, -1.3, -1.6, 1.3)), light('poly', ...box(-1, -1.3, 1.6, 1.3))]),
  // tanks from above: tracks along the sides, a round turret, the barrel past the bow
  tankDivision: shape(tank(4.5, 3.5, 7.5, 1.5), [dark('poly', ...box(-4, 2.2, 4, 3)), dark('poly', ...box(-4, -3, 4, -2.2)), dark('ring', -0.5, 0, 1.75, 0.8), light('dot', -0.5, 0, 1.3)]),
  lightTank: shape(tank(3.7, 3, 6.2, 1.2), [dark('poly', ...box(-3.2, 1.8, 3.2, 2.5)), dark('poly', ...box(-3.2, -2.5, 3.2, -1.8)), dark('ring', -0.3, 0, 1.4, 0.7), light('dot', -0.3, 0, 1)]),
  heavyTank: shape(tank(5.5, 4.3, 9, 2), [dark('poly', ...box(-5, 2.8, 5, 3.8)), dark('poly', ...box(-5, -3.8, 5, -2.8)), dark('ring', -0.8, 0, 2.3, 0.9), light('dot', -0.8, 0, 1.75)]),
  // bomber: long body, big near-straight wings with four engines, a tailplane
  bomber: shape([sym([6, 0, 5, 1.1, 1.6, 1.2, 0.8, 6.5, -0.8, 6.5, -0.8, 1.2, -4.6, 1, -4.9, 3, -6, 3, -6, 0])], [dark('dot', 0.9, 2.7, 0.65), dark('dot', 0.9, -2.7, 0.65), dark('dot', 0.5, 4.8, 0.6), dark('dot', 0.5, -4.8, 0.6)]),
  // ground attack: a fighter-sized body with a short straight wing and a gun at the nose
  groundAttack: shape([sym([5, 0, 3.6, 1, 1.8, 1, 1.4, 4.6, -0.6, 4.6, -0.9, 1, -3.6, 0.8, -3.9, 2.4, -4.8, 2.4, -4.8, 0])], [light('dot', 3.4, 0, 0.6)]),
  // heavy bomber: bigger still, a wider wing with four engines
  heavyBomber: shape([sym([6.6, 0, 5.4, 1.3, 1.8, 1.4, 0.9, 7.5, -1, 7.5, -1, 1.4, -5, 1.2, -5.3, 3.4, -6.6, 3.4, -6.6, 0])], [dark('dot', 1, 3, 0.75), dark('dot', 1, -3, 0.75), dark('dot', 0.6, 5.4, 0.7), dark('dot', 0.6, -5.4, 0.7), light('poly', ...box(-4.5, -0.4, 4.5, 0.4))]),
  // fighter: a small swept delta with a notched tail
  fighter: shape([sym([5.5, 0, 2, 0.9, -1.5, 4.8, -2.8, 4.8, -2.4, 1.3, -3.8, 2.4, -4.6, 2.4, -4.2, 0])], [light('dot', 2.4, 0, 0.6)]),
  // cargo plane: a fat body, a straight high wing and a T-tail
  transportPlane: shape([sym([6, 0, 5.2, 1.5, 2.2, 1.6, 2.2, 6.5, 0.2, 6.5, 0.2, 1.6, -3.8, 1.3, -4.6, 0.7, -4.8, 3.2, -6, 3.2, -6, 0])], [light('poly', ...box(-3, -0.55, 4.4, 0.55))]),
  // recon plane: a slim body, a long thin wing, a small tail and a lens at the nose
  reconPlane: shape([sym([5.5, 0, 4.6, 0.7, 1.6, 0.7, 1.5, 6, 0.4, 6, 0.3, 0.7, -4, 0.5, -4.2, 2.2, -5.3, 2.2, -5.3, 0])], [light('dot', 3.9, 0, 0.7)]),
  // rocket: a dart with swept fins
  rocket: shape([sym([5, 0, 3.2, 1.05, -2.8, 1.05, -4.8, 2.4, -5.4, 2.4, -4.6, 0.7, -5, 0])], [light('poly', 3.2, -1, 5, 0, 3.2, 1)]),
  // atom bomb: fatter, with fins and a light ring (the atom mark)
  atomBomb: shape([sym([5.4, 0, 4, 2, 1.5, 2.5, -1.8, 2.5, -3, 1.5, -4.4, 3.8, -5.6, 3.8, -5, 1, -5.2, 0])], [light('ring', 0, 0, 1.4, 0.8)]),
};

/** The icon of a unit. */
export function iconShapeOf(type: UnitType, variant: UnitVariant | undefined): IconShape {
  return ICON_SHAPES[spriteKey(type, variant)];
}

/** Headings an icon is baked at. */
export const ICON_FACINGS = 32;
/** Size steps of the far zoom band (z < 1.6, 1.6 to 2.6, 2.6 and closer) and of a fleet (a quarter bigger). */
const SIZE_STEPS = [0.85, 1, 1.15];
export const FLEET_ICON_SCALE = 1.25;

/** The size step of the icons at zoom z (0, 1 or 2). */
export function iconStep(z: number): number {
  return z < 1.6 ? 0 : z < 2.6 ? 1 : 2;
}
/** Icon size factor at zoom z (and for a fleet marker). */
export function iconScale(z: number, fleet = false): number {
  return SIZE_STEPS[iconStep(z)] * (fleet ? FLEET_ICON_SCALE : 1);
}
/** Half the icon's length on screen (CSS px) at zoom z: what the map uses for hit areas, ticks and pills. */
export function iconHalf(type: UnitType, variant: UnitVariant | undefined, z: number, fleet = false): number {
  return iconShapeOf(type, variant).half * iconScale(z, fleet);
}

// ------------------------------------------------------------------------------------------------- colours

function luma(c: readonly number[]): number {
  return (0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]) / 255;
}
const mix = (c: readonly number[], to: readonly number[], t: number): RGB => [Math.round(c[0] + (to[0] - c[0]) * t), Math.round(c[1] + (to[1] - c[1]) * t), Math.round(c[2] + (to[2] - c[2]) * t)];
const WHITE = [255, 255, 255];
const INK = [10, 13, 20];
/** Outline round the silhouette: dark, or light for nations whose colour is itself very dark. */
export function iconEdge(owner: readonly number[]): string {
  return luma(owner) < 0.3 ? 'rgba(232,238,246,0.9)' : 'rgba(8,11,17,0.92)';
}

interface Tones {
  fill: string;
  rim: string;
  dark: string;
  light: string;
  ghost: string;
  edge: string;
}
const toneCache = new Map<number, Tones>();
function tonesOf(owner: readonly number[]): Tones {
  const k = ((owner[0] & 255) << 16) | ((owner[1] & 255) << 8) | (owner[2] & 255);
  let t = toneCache.get(k);
  if (!t) {
    t = { fill: css(owner), rim: css(mix(owner, WHITE, 0.4)), dark: css(mix(owner, INK, 0.62)), light: css(mix(owner, WHITE, 0.6)), ghost: css(mix(owner, INK, 0.4)), edge: iconEdge(owner) };
    if (toneCache.size > 512) toneCache.clear();
    toneCache.set(k, t);
  }
  return t;
}

// ------------------------------------------------------------------------------------------------- painting

function tracePoly(ctx: CanvasRenderingContext2D, p: readonly number[], s: number): void {
  ctx.moveTo(p[0] * s, p[1] * s);
  for (let i = 2; i < p.length; i += 2) ctx.lineTo(p[i] * s, p[i + 1] * s);
  ctx.closePath();
}
function traceSilhouette(ctx: CanvasRenderingContext2D, sh: IconShape, s: number): void {
  ctx.beginPath();
  for (const p of sh.polys) tracePoly(ctx, p, s);
  for (const e of sh.ellipses) {
    ctx.moveTo((e[0] + e[2]) * s, e[1] * s);
    ctx.ellipse(e[0] * s, e[1] * s, e[2] * s, e[3] * s, 0, 0, Math.PI * 2);
  }
}

/** The light comes from the top left of the screen: the rim is where the shape moved this far down and right leaves. */
const RIM = 1;

/**
 * Paints one icon centred at the current origin (CSS px units), nose along `angle`: outline, light rim, owner fill,
 * details. `fleet` adds a darker second hull behind it, up and to the left.
 */
export function paintIcon(ctx: CanvasRenderingContext2D, sh: IconShape, owner: readonly number[], angle: number, s: number, fleet = false): void {
  const t = tonesOf(owner);
  ctx.lineJoin = 'round';
  if (fleet) {
    // beside the lead (across its heading, on the upper side of the screen) and a little behind it, so it shows at
    // any heading
    const c = Math.cos(angle);
    const sn = Math.sin(angle);
    const side = c > 0 || (c === 0 && sn < 0) ? 1 : -1;
    ctx.save();
    ctx.translate(sn * side * 3.4 - c * 1.6, -c * side * 3.4 - sn * 1.6);
    ctx.rotate(angle);
    traceSilhouette(ctx, sh, s * 0.92);
    ctx.lineWidth = 2;
    ctx.strokeStyle = t.edge;
    ctx.stroke();
    ctx.fillStyle = t.ghost;
    ctx.fill();
    ctx.restore();
  }
  ctx.save();
  ctx.rotate(angle);
  traceSilhouette(ctx, sh, s);
  // the outline: 2 px wide, half of it under the fill, so 1 px shows outside the silhouette
  ctx.lineWidth = 2;
  ctx.strokeStyle = t.edge;
  ctx.stroke();
  ctx.fillStyle = t.rim;
  ctx.fill();
  ctx.clip();
  // the owner's colour, moved 1 px down and right on screen: a 1 px light rim stays on the upper and left edges
  ctx.rotate(-angle);
  ctx.translate(RIM, RIM);
  ctx.rotate(angle);
  traceSilhouette(ctx, sh, s);
  ctx.fillStyle = t.fill;
  ctx.fill();
  ctx.rotate(-angle);
  ctx.translate(-RIM, -RIM);
  ctx.rotate(angle);
  for (const d of sh.details) {
    ctx.beginPath();
    const p = d.p;
    const col = d.tone === 'dark' ? t.dark : t.light;
    if (d.k === 'poly') {
      tracePoly(ctx, p, s);
      ctx.fillStyle = col;
      ctx.fill();
    } else if (d.k === 'dot') {
      ctx.arc(p[0] * s, p[1] * s, p[2] * s, 0, Math.PI * 2);
      ctx.fillStyle = col;
      ctx.fill();
    } else {
      ctx.arc(p[0] * s, p[1] * s, p[2] * s, 0, Math.PI * 2);
      ctx.lineWidth = p[3] * s;
      ctx.strokeStyle = col;
      ctx.stroke();
    }
  }
  ctx.restore();
}

// ------------------------------------------------------------------------------------------------- baking

const atlas = new SpriteAtlas(1024, 4);
const KEY_INDEX = new Map<SpriteKey, number>(SPRITE_KEYS.map((k, i) => [k, i]));
/** Icons baked since the page loaded, and atlas lookups that found one already baked (stats, tests). */
export const iconStats = { baked: 0, hits: 0, painted: 0 };

/** Cache key of one baked icon: kind, owner RGB, facing, density (quarters), size step, fleet. */
export function iconKey(key: SpriteKey, owner: readonly number[], facing: number, dpr: number, step: number, fleet: boolean): number {
  const o = ((owner[0] & 255) << 16) | ((owner[1] & 255) << 8) | (owner[2] & 255);
  const d = Math.max(1, Math.min(31, Math.round(dpr * 4)));
  return ((((o * 32 + (KEY_INDEX.get(key) ?? 0)) * 64 + facing) * 32 + d) * 4 + step) * 2 + (fleet ? 1 : 0);
}

/** The heading of one of the baked facings nearest to `angle`. */
export function iconFacing(angle: number): number {
  const step = (Math.PI * 2) / ICON_FACINGS;
  return ((Math.round(angle / step) % ICON_FACINGS) + ICON_FACINGS) % ICON_FACINGS;
}

/** The baked icon, or null when it cannot be baked now (no canvas, or the frame's bake budget is spent). */
function iconEntry(key: SpriteKey, sh: IconShape, owner: readonly number[], facing: number, dpr: number, step: number, fleet: boolean): AtlasEntry | null {
  const k = iconKey(key, owner, facing, dpr, step, fleet);
  const hit = atlas.peek(k);
  if (hit !== undefined) {
    iconStats.hits++;
    return hit;
  }
  const s = SIZE_STEPS[step] * (fleet ? FLEET_ICON_SCALE : 1);
  // the box holds the icon at any heading, its outline and, for a fleet, the second hull
  const R = Math.hypot(sh.half, sh.beam) * s + 2 + (fleet ? 4.6 : 0);
  const half = Math.ceil(R * dpr);
  const angle = (facing * Math.PI * 2) / ICON_FACINGS;
  const e = atlas.getPainted(k, half * 2, half * 2, half, half, (c) => {
    c.translate(half, half);
    c.scale(dpr, dpr);
    paintIcon(c, sh, owner, angle, s, fleet);
  });
  if (e) iconStats.baked++;
  return e;
}

/**
 * Draws a unit's far zoom icon centred at (x, y) CSS px: the baked picture on whole device px, or the same picture
 * painted straight onto the map while it waits for its bake. `alpha` fades it (the switch to sprites).
 */
export function drawUnitIcon(ctx: CanvasRenderingContext2D, type: UnitType, variant: UnitVariant | undefined, x: number, y: number, angle: number, owner: readonly number[], z: number, dpr: number, fleet = false, alpha = 1): void {
  const key = spriteKey(type, variant);
  const sh = ICON_SHAPES[key];
  const step = iconStep(z);
  const facing = iconFacing(angle);
  const a = alpha * sh.alpha;
  if (a <= 0) return;
  const prev = ctx.globalAlpha;
  if (a !== 1) ctx.globalAlpha = prev * a;
  const d = dpr > 0 ? dpr : 1;
  const e = iconEntry(key, sh, owner, facing, d, step, fleet);
  if (e) {
    ctx.drawImage(e.page, e.sx, e.sy, e.w, e.h, (Math.round(x * d) - e.ox) / d, (Math.round(y * d) - e.oy) / d, e.w / d, e.h / d);
  } else {
    iconStats.painted++;
    ctx.save();
    ctx.translate(x, y);
    paintIcon(ctx, sh, owner, (facing * Math.PI * 2) / ICON_FACINGS, SIZE_STEPS[step] * (fleet ? FLEET_ICON_SCALE : 1), fleet);
    ctx.restore();
  }
  ctx.globalAlpha = prev;
}

/**
 * A fleet's ship count: a dark pill with a bold white number and an edge in the owner's colour (your accent for your
 * own), at the top right of the fleet icon.
 */
export function drawFleetCount(ctx: CanvasRenderingContext2D, x: number, y: number, text: string, edge: string, font: string): void {
  ctx.font = `700 10px ${font}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const bh = 14;
  const bw = Math.max(bh, ctx.measureText(text).width + 7);
  ctx.beginPath();
  ctx.roundRect(x - bw / 2, y - bh / 2, bw, bh, bh / 2);
  ctx.fillStyle = 'rgba(10,13,21,0.9)';
  ctx.fill();
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = edge;
  ctx.stroke();
  ctx.fillStyle = '#fff';
  ctx.fillText(text, x, y + 0.5);
}

/** Forgets every baked icon (tests). */
export function clearIcons(): void {
  atlas.clear();
}
