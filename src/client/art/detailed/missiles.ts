// The detailed style's missile looks (client only, pure data plus one draw entry), each modelled on a real world shape
// and drawn as parts like every unit of the style (bake.ts), outlined in the owner's colour:
//   rocket      a short-range ballistic missile: white body, red ogive nose, red fins at the base, big fiery exhaust
//   atom bomb   a long staged intercontinental missile: dark olive stages with a yellow band, rings between the
//               stages, fins at the base and a tapering reentry cone, heavy smoke behind it (trails.ts)
//   anti-radar  a stealth stand-off missile: an angular faceted body in dark grey, small swept wings and a V tail,
//               a faint exhaust. Not used by the game yet: see drawAntiRadar.
//   cruise      the slim matte black cruise missile is in cruise.ts; its old model is kept here for the art lab
// The "legacy" models below are the looks these replaced, kept only so the art lab can show old next to new.
import type { MotionParams } from '../motion';
import { canBake, SpriteAtlas, type AtlasEntry } from '../shared/atlas';
import { rasterize, shadowOf, type Model, type Part } from './bake';
import { facingIndex, facingsFor, gridOf, type Grid } from './grid';
import { FIRE } from './palette';
import { box, ell, grown, poly, sym } from './shapes';
import type { UnitModel } from './models';

/** Shading frame for a band laid over an ellipse or cylinder. */
const over = (u: number, v: number, ru: number, rv: number): readonly [number, number, number, number] => [u, v, ru, rv];

// ------------------------------------------------------------------------------------------------- rocket

/** The silo rocket: seen from above, white body, red nose cone and red swept fins, a big motor flame at the tail. */
export function rocketModel(): UnitModel {
  const body = over(-2, 0, 5.5, 1.3);
  const parts: Part[] = [
    // the four fins seen from above: a swept pair either side (the other pair is edge on, under the body)
    poly(sym([-3.2, -1.2, -6.6, -3.5, -8.1, -3.5, -8, -1.2]), 0.6, 0.5, 'redpaint', { tone: -1 }),
    // motor skirt
    box(-8.4, -0.95, -7, 0.95, 0.6, 1.2, 'gun', { sh: 'cyl', sc: over(-7.7, 0, 0.7, 0.95) }),
    // the white body, a dark roll band and the owner's colour on a narrow ring at the shoulder
    box(-7.2, -1.3, 3.6, 1.3, 0.6, 1.4, 'white', { sh: 'cyl', sc: body }),
    box(-4.6, -1.33, -3.6, 1.33, 0.6, 1.43, 'gun', { sh: 'cyl', sc: body }),
    box(2.4, -1.33, 3.4, 1.33, 0.6, 1.43, 'own', { sh: 'cyl', sc: body }),
    // the red ogive nose
    poly([10.6, 0, 9.6, -0.45, 8.2, -0.85, 6.2, -1.2, 3.6, -1.3, 3.6, 1.3, 6.2, 1.2, 8.2, 0.85, 9.6, 0.45], 0.6, 1.4, 'redpaint', { sh: 'cyl', sc: over(7, 0, 3.6, 1.3) }),
  ];
  return { model: { parts, flat: true }, guns: [], props: [], nozzles: [{ u: -8.4, v: 0, z: 1, r: 2.1 }], alt: 4, dust: [] };
}

// ------------------------------------------------------------------------------------------------- atom bomb

/** The atom bomb: a long staged missile, dark olive with a yellow band, stage rings, base fins and a reentry cone. */
export function atomBombModel(): UnitModel {
  const s1 = over(-6.4, 0, 3.8, 2.2);
  const s2 = over(2.2, 0, 3.8, 1.75);
  const parts: Part[] = [
    // base fins: swept, dark
    poly(sym([-5.6, -2.1, -9.6, -4.6, -11.2, -4.6, -10.6, -2.1]), 0.6, 0.5, 'olive', { tone: -1 }),
    // motor skirt
    box(-11.4, -1.5, -9.8, 1.5, 0.6, 1.4, 'gun', { sh: 'cyl', sc: over(-10.6, 0, 0.8, 1.5) }),
    // first stage, wide, with the yellow band
    box(-10, -2.2, -2.4, 2.2, 0.6, 2.2, 'olive', { sh: 'cyl', sc: s1 }),
    box(-6.6, -2.23, -4.4, 2.23, 0.6, 2.23, 'hazard', { sh: 'cyl', sc: s1 }),
    // the ring where the first stage lets go
    box(-2.4, -1.95, -1.5, 1.95, 0.6, 1.8, 'gun', { sh: 'cyl', sc: over(-1.95, 0, 0.9, 1.95) }),
    // second stage, slimmer, with the owner's colour on a narrow ring
    box(-1.5, -1.75, 5.4, 1.75, 0.6, 1.8, 'olive', { sh: 'cyl', sc: s2 }),
    box(2.6, -1.78, 3.4, 1.78, 0.6, 1.83, 'own', { sh: 'cyl', sc: s2 }),
    // third stage ring and its bus
    box(5.4, -1.5, 6.4, 1.5, 0.6, 1.5, 'gun', { sh: 'cyl', sc: over(5.9, 0, 0.5, 1.5) }),
    box(6.4, -1.3, 7.6, 1.3, 0.6, 1.4, 'olive', { sh: 'cyl', sc: over(7, 0, 0.6, 1.3) }),
    // the reentry cone: a long taper, a shade darker
    poly([13.4, 0, 12.2, -0.4, 10.4, -0.85, 8.6, -1.2, 7.6, -1.35, 7.6, 1.35, 8.6, 1.2, 10.4, 0.85, 12.2, 0.4], 0.6, 1.4, 'olive', { sh: 'cyl', sc: over(10.4, 0, 3, 1.35), tone: -1 }),
    ell(13, 0, 0.45, 0.4, 0.8, 1, 'gun'),
  ];
  return { model: { parts, flat: true }, guns: [], props: [], nozzles: [{ u: -11.4, v: 0, z: 1, r: 1.7 }], alt: 5, dust: [] };
}

// ------------------------------------------------------------------------------------------------- anti-radar missile

/** The facet sketch below is drawn at this size (the missile is about 14 units long: a little bigger than the cruise missile). */
const AR_SCALE = 1.3;

/**
 * The anti-radar missile at level flight: an angular, faceted body (a raised ridge between two lower chine facets of
 * different tones, so the planes catch the light apart), a sharp nose, small swept wings, a V tail and a dark nozzle.
 * Dark stealth grey with a small owner ring.
 */
export function antiRadarModel(): Model {
  const z = 0.6;
  const parts: Part[] = [
    // small swept wings, mid-rear
    poly(sym([-0.4, -1.1, -2.6, -2.7, -3.7, -2.7, -3.5, -1.1]), z + 0.2, 0.2, 'stealth', { tone: -1 }),
    // V tail
    poly(sym([-3.6, -0.5, -5.1, -1.9, -5.9, -1.9, -5.5, -0.5]), z + 0.2, 0.2, 'stealth', { tone: -1 }),
    // nozzle
    box(-6.4, -0.45, -5.4, 0.45, z + 0.1, 0.6, 'gun'),
    // the chine facets either side (left lit, right in shade)
    poly([5.4, 0, 2.8, -1, -1, -1.35, -5.4, -0.85, -5.4, 0, 2.8, 0], z, 0.8, 'stealth', { tone: 1 }),
    poly([5.4, 0, 2.8, 1, -1, 1.35, -5.4, 0.85, -5.4, 0, 2.8, 0], z, 0.8, 'stealth', { tone: -1 }),
    // the raised ridge: a long narrow diamond down the middle
    poly([4.2, 0, 2.2, -0.55, -2, -0.6, -5.4, -0.4, -5.4, 0.4, -2, 0.6, 2.2, 0.55], z + 0.6, 0.5, 'stealth', { tone: 0 }),
    // the owner's colour on a small ring
    box(-2.1, -0.62, -1.4, 0.62, z + 0.6, 0.52, 'own'),
    // the seeker window, a dark chip at the nose
    poly([5.4, 0, 4.4, -0.3, 4.4, 0.3], z + 0.6, 0.55, 'gun'),
  ];
  return { parts: grown(parts, AR_SCALE), ground: 0 };
}

/** Everything drawAntiRadar needs: where the missile is over the ground now (CSS px), its heading and the view. */
export interface AntiRadarDraw {
  /** the ground point under the missile (CSS px) */
  x: number;
  y: number;
  /** heading in radians (screen angle, 0 = right) */
  angle: number;
  /** the owner's colour (rgb 0..255) */
  owner: readonly number[];
  /** sprite scale of the zoom (the same `scale` as UnitDraw) and the device pixel ratio */
  scale: number;
  dpr: number;
  /** the clock (ms) and a per-missile seed, for the faint exhaust flicker */
  timeMs: number;
  seed: number;
  /** 0..1, fades the whole missile (fog, arrival) */
  alpha: number;
  /** height over the ground in model units (default 3.6); the shadow falls off to the lower right by it */
  alt?: number;
}

const arAtlas = new SpriteAtlas(512, 4);
const ownerKey = (o: readonly number[]): number => ((o[0] & 255) << 16) | ((o[1] & 255) << 8) | (o[2] & 255);
let arModel: Model | undefined;

function arBaked(facing: number, n: number, res: number, owner: readonly number[], shadow: boolean): AtlasEntry | null {
  const key = `ar|${facing}|${n}|${Math.round(res * 4)}|${shadow ? 0 : ownerKey(owner)}|${shadow ? 1 : 0}`;
  const hit = arAtlas.peek(key);
  if (hit !== undefined) return hit;
  if (!canBake()) return null;
  return arAtlas.get(key, () => {
    const b = rasterize((arModel ??= antiRadarModel()), res, facing, { facings: n, owner: shadow ? [0, 0, 0] : owner });
    return shadow ? shadowOf(b) : b;
  });
}

function blit(ctx: CanvasRenderingContext2D, e: AtlasEntry, x: number, y: number, g: Grid): void {
  ctx.drawImage(e.page, e.sx, e.sy, e.w, e.h, Math.round(x * g.dpr) / g.dpr - e.ox * g.k, Math.round(y * g.dpr) / g.dpr - e.oy * g.k, e.w * g.k, e.h * g.k);
}

/**
 * ENTRY FOR THE ANTI-RADAR MISSILE (nothing in the game calls it yet):
 *   drawAntiRadar(ctx, a: AntiRadarDraw, m: MotionParams): boolean
 * Draws one anti-radar missile in flight at `a.x, a.y` (the ground point; the body is lifted by `a.alt`) heading
 * `a.angle`: its ground shadow, the faceted body baked per heading in the owner's colour, and a faint exhaust (still
 * under Reduce motion). Returns false when nothing could be drawn this frame (no canvas, or the bake budget is spent:
 * call it again next frame). The caller owns paths, timing, zoom gating and fog.
 */
export function drawAntiRadar(ctx: CanvasRenderingContext2D, a: AntiRadarDraw, m: MotionParams): boolean {
  const g = gridOf(a.scale, a.dpr);
  const n = facingsFor(g.res);
  const facing = facingIndex(a.angle, n);
  const body = arBaked(facing, n, g.res, a.owner, false);
  if (!body) return false;
  const shadow = arBaked(facing, n, g.res, a.owner, true);
  const S = a.scale;
  const alt = a.alt ?? 3.6;
  const prevA = ctx.globalAlpha;
  const prevS = ctx.imageSmoothingEnabled;
  ctx.imageSmoothingEnabled = false;
  ctx.globalAlpha = prevA * a.alpha;
  if (shadow) blit(ctx, shadow, a.x + alt * 0.62 * S * 0.5, a.y + alt * 0.86 * S * 0.5, g);
  const bx = a.x;
  const by = a.y - alt * S * 0.8;
  blit(ctx, body, bx, by, g);
  // a faint exhaust: a short, dim orange flicker behind the nozzle
  const cos = Math.cos(a.angle);
  const sin = Math.sin(a.angle);
  const flick = m.reduced ? 0 : Math.floor(a.timeMs / Math.max(20, m.flameMs) + a.seed) & 3;
  const len = Math.max(2, Math.round((1.6 + (flick & 1 ? 0.7 : 0)) * g.res));
  const p = g.p / g.dpr;
  for (let i = 0; i <= len; i++) {
    const q = i / len;
    const d = 6.4 * AR_SCALE * S + (i / g.res) * S;
    const fx = bx - cos * d;
    const fy = by - sin * d * 0.84;
    ctx.globalAlpha = prevA * a.alpha * (0.55 - q * 0.4);
    ctx.fillStyle = q < 0.3 ? FIRE[1] : FIRE[Math.min(5, 2 + Math.floor(q * 3))];
    ctx.fillRect(Math.round((fx * g.dpr) / g.p) * p, Math.round((fy * g.dpr) / g.p) * p, p, p);
  }
  ctx.globalAlpha = prevA;
  ctx.imageSmoothingEnabled = prevS;
  return true;
}

// ------------------------------------------------------------------------------------------------- legacy looks (art lab only)

/** The old rocket: a pale grey body, ogive nose with a hazard tip, swept grey fins. */
export function legacyRocketModel(): Model {
  const body = over(-1.4, 0, 6.4, 1.2);
  return {
    parts: [
      poly(sym([-3.8, -1, -6.6, -2.8, -7.8, -2.8, -7.4, -1]), 0.6, 0.4, 'hull'),
      box(-7.6, -0.7, -6.6, 0.7, 0.7, 0.8, 'gun'),
      box(-6.8, -1.2, 3.4, 1.2, 0.6, 1.3, 'sup', { sh: 'cyl', sc: body }),
      box(-2.6, -1.22, -1.4, 1.22, 0.6, 1.32, 'gun', { sh: 'cyl', sc: body }),
      poly([9, 0, 6.6, -0.8, 3.4, -1.2, 3.4, 1.2, 6.6, 0.8], 0.6, 1.3, 'sup', { sh: 'cyl', sc: over(5.4, 0, 3.4, 1.2) }),
      ell(8.2, 0, 0.9, 0.45, 0.8, 0.9, 'hazard'),
    ],
    flat: true,
  };
}

/** The old atom bomb: a fat olive body with a hazard band, big box fins and a blunt nose. */
export function legacyAtomBombModel(): Model {
  const body = over(-1.8, 0, 7.4, 1.9);
  return {
    parts: [
      poly(sym([-4.4, -1.8, -8, -3.9, -9.8, -3.9, -9.4, -1.8]), 0.6, 0.5, 'fieldgrey'),
      box(-9.8, -3.9, -8.8, 3.9, 0.7, 0.6, 'fieldgrey', { tone: -1 }),
      box(-9.4, -1, -8.4, 1, 0.8, 1.2, 'gun'),
      box(-8.6, -1.9, 4, 1.9, 0.6, 2, 'olive', { sh: 'cyl', sc: body }),
      box(-3.6, -1.93, -2.6, 1.93, 0.6, 2.03, 'hazard', { sh: 'cyl', sc: body }),
      box(-2.6, -1.93, -1.6, 1.93, 0.6, 2.03, 'black', { sh: 'cyl', sc: body }),
      box(-1.6, -1.93, -0.6, 1.93, 0.6, 2.03, 'hazard', { sh: 'cyl', sc: body }),
      poly([10.4, 0, 9, -1.1, 4, -1.9, 4, 1.9, 9, 1.1], 0.6, 2, 'olive', { sh: 'cyl', sc: over(7, 0, 4, 1.9) }),
      ell(9.8, 0, 0.7, 0.6, 1, 1.2, 'tan'),
    ],
    flat: true,
  };
}

/** The old cruise missile in level flight with its wings out and no booster: a haze grey tube with swept wings. */
export function legacyCruiseModel(): Model {
  const parts: Part[] = [];
  const BODY = 7.6;
  const RAD = 0.62;
  const tail = -BODY / 2;
  const nose = BODY / 2;
  const z = 0.6;
  const h = RAD * 2;
  const sc = [0, 0, BODY / 2 + 0.5, RAD] as const;
  const span = 2.5;
  const sweep = 0.35;
  parts.push(poly(sym([0.8, -RAD, 0.8 - sweep, -span, -0.2 - sweep, -span, -0.6, -RAD]), z + 0.2, 0.25, 'sup', { tone: -1 }));
  const fs = 1.3;
  parts.push(poly(sym([tail + 1.3, -RAD, tail + 0.2, -RAD - fs, tail - 0.1, -RAD - fs, tail + 0.1, -RAD]), z + 0.1, 0.2, 'sup', { tone: -1 }));
  parts.push(box(tail - 0.1, -0.18, tail + 1.2, 0.18, z + h, 1.5, 'sup', { tone: -1 }));
  parts.push(box(tail - 0.45, -0.42, tail, 0.42, z + 0.15, h * 0.7, 'gun'));
  parts.push(box(tail, -RAD, nose - 1.6, RAD, z, h, 'sup', { sh: 'cyl', sc }));
  parts.push(box(-0.9, -RAD - 0.02, -0.3, RAD + 0.02, z, h + 0.02, 'own', { sh: 'cyl', sc }));
  parts.push(poly([nose + 0.3, 0, nose - 0.6, -RAD * 0.75, nose - 1.6, -RAD, nose - 1.6, RAD, nose - 0.6, RAD * 0.75], z, h, 'sup', { sh: 'cyl', sc: [nose - 0.8, 0, 1.1, RAD] }));
  parts.push(ell(nose - 0.2, 0, 0.4, 0.3, z + 0.1, h * 0.8, 'gun'));
  return { parts, ground: 0 };
}

// ------------------------------------------------------------------------------------------------- art lab helper

const labAtlas = new SpriteAtlas(1024, 4);
/** Draws a model as a still at (x, y) heading `angle` (art lab only: the old and new looks side by side). */
export function drawLabModel(ctx: CanvasRenderingContext2D, model: Model, id: string, x: number, y: number, angle: number, scale: number, dpr: number, owner: readonly number[]): void {
  const g = gridOf(scale, dpr);
  const n = facingsFor(g.res);
  const facing = facingIndex(angle, n);
  const key = `${id}|${facing}|${n}|${Math.round(g.res * 4)}|${ownerKey(owner)}`;
  let e = labAtlas.peek(key);
  if (e === undefined && canBake()) e = labAtlas.get(key, () => rasterize(model, g.res, facing, { facings: n, owner }));
  if (!e) return;
  const prev = ctx.imageSmoothingEnabled;
  ctx.imageSmoothingEnabled = false;
  blit(ctx, e, x, y, g);
  ctx.imageSmoothingEnabled = prev;
}
