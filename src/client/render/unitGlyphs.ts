// Minimal line glyphs for the mobile units on the map (client only). Each glyph is a handful of strokes in a unit
// square: nose at +x, half-length 1, lateral axis y. They are stroked in the owner's colour over a thin dark
// under-stroke, so dozens of ships and planes in one area stay readable, and each type has its own silhouette:
//   fighter = small swept delta with twin tail prongs      bomber = long straight wings, 4 engine ticks, long body
//   cargo plane = fat body, boxy high wings, T-tail        warship = long narrow hull, two turrets with barrels
//   landing craft = short square-fronted hull + ramp       trade ship = pointed hull with container blocks
//   rocket / atom bomb = one missile shape (the bomb bigger, with a ring), both with a long fading contrail
//   tank division = squat hull with two track lines, a round turret and a long barrel forward (no trail)
// The detailed pictures live in icons.ts (HUD). Trails (contrails, wakes) are drawn here too so the glyph sheet can use them.
import type { UnitType } from '../../sim/types';

/**
 * poly: closed outline (also gets a faint fill), line: open polyline, dot: a point (round cap), ring: x, y, radius,
 * block: small box filled solid in the owner colour (cargo), pit: small box filled dark (a turret on a hull too narrow
 * to show a gap); neither is outlined, so neighbours keep a gap. Coordinates are [x0, y0, x1, y1, ...] in half-lengths.
 */
export interface Shape {
  k: 'poly' | 'line' | 'dot' | 'ring' | 'block' | 'pit';
  p: number[];
}
/** 'none': land units (tank divisions) leave nothing behind */
export type TrailKind = 'wake' | 'air' | 'missile' | 'none';
export interface Glyph {
  /** Length on screen relative to the base size of the zoom level. */
  len: number;
  shapes: Shape[];
  /** What follows it: a V wake (ships), a faint short contrail (planes) or a long tapering one (missiles). */
  trail: TrailKind;
  /** Trail length in glyph lengths (longer for fast units). */
  trailLen: number;
  /** Has blocks / pits (extra fill passes). Set below. */
  solid?: boolean;
  pits?: boolean;
}

/** x, y, w, h (half sizes) of an axis-aligned block. */
const box = (cx: number, cy: number, hw: number, hh: number, k: 'block' | 'pit' = 'block'): Shape => ({ k, p: [cx - hw, cy - hh, cx - hw, cy + hh, cx + hw, cy + hh, cx + hw, cy - hh] });
/** The same shape on both sides of the centre line. */
const mirror = (p: number[]): number[][] => [p, p.map((v, i) => (i % 2 ? -v : v))];

/** Body, nose cone and swept tail fins; shared by the rocket and the atom bomb. */
const MISSILE: Shape[] = [
  { k: 'line', p: [-0.95, 0, 0.35, 0] },
  { k: 'poly', p: [1, 0, 0.3, 0.2, 0.3, -0.2] },
  { k: 'line', p: [-0.3, 0.02, -0.95, 0.42] },
  { k: 'line', p: [-0.3, -0.02, -0.95, -0.42] },
];

export const GLYPHS: Record<UnitType, Glyph> = {
  // medium hull, pointed bow, three container blocks on deck
  tradeShip: {
    len: 1.0,
    trail: 'wake',
    trailLen: 0.6,
    shapes: [{ k: 'poly', p: [-1, -0.4, -1, 0.4, 0.5, 0.4, 1, 0, 0.5, -0.4] }, box(-0.58, 0, 0.16, 0.22), box(-0.14, 0, 0.16, 0.22), box(0.3, 0, 0.16, 0.22)],
  },
  // landing craft: short, boxy, square bow with a ramp line, one cargo block
  transport: {
    len: 0.95,
    trail: 'wake',
    trailLen: 0.6,
    shapes: [
      { k: 'poly', p: [-1, -0.52, -1, 0.52, 0.7, 0.52, 1, 0.4, 1, -0.4, 0.7, -0.52] },
      { k: 'line', p: [0.64, -0.52, 0.64, 0.52] },
      box(-0.3, 0, 0.22, 0.22),
    ],
  },
  // long narrow hull, a dark gun turret at the bow (barrel forward past the bow line) and one aft (barrel back)
  warship: {
    len: 1.2,
    trail: 'wake',
    trailLen: 0.6,
    shapes: [
      { k: 'poly', p: [-1, -0.3, -1, 0.3, 0.3, 0.3, 1, 0, 0.3, -0.3] },
      box(0.12, 0, 0.2, 0.2, 'pit'),
      { k: 'line', p: [0.12, 0, 0.8, 0] },
      box(-0.5, 0, 0.2, 0.2, 'pit'),
      { k: 'line', p: [-0.5, 0, -1, 0] },
    ],
  },
  // small swept delta, notched stern with two tail prongs
  fighter: {
    len: 1.0,
    trail: 'air',
    trailLen: 1.1,
    shapes: [
      { k: 'poly', p: [1, 0, -0.55, 0.85, -0.45, 0.12, -0.45, -0.12, -0.55, -0.85] },
      { k: 'line', p: [0.6, 0, -0.45, 0] },
      { k: 'line', p: [-0.4, 0.22, -1, 0.22] },
      { k: 'line', p: [-0.4, -0.22, -1, -0.22] },
    ],
  },
  // long body, big near-straight wings with four engine ticks on the leading edge, tailplane
  bomber: {
    len: 1.2,
    trail: 'air',
    trailLen: 0.8,
    shapes: [
      { k: 'line', p: [1, 0, -1, 0] },
      ...mirror([0.3, 0.08, -0.02, 1.08, -0.42, 1.08, -0.3, 0.08]).map((p): Shape => ({ k: 'poly', p })),
      ...mirror([0.22, 0.38, 0.5, 0.38]).map((p): Shape => ({ k: 'line', p })),
      ...mirror([0.1, 0.74, 0.38, 0.74]).map((p): Shape => ({ k: 'line', p })),
      { k: 'line', p: [-0.88, -0.36, -0.88, 0.36] },
    ],
  },
  // cargo plane: fat body, boxy high wings, wide T-tail
  transportPlane: {
    len: 1.1,
    trail: 'air',
    trailLen: 0.8,
    shapes: [
      { k: 'poly', p: [1, 0, 0.8, 0.27, -0.55, 0.27, -1, 0.14, -1, -0.14, -0.55, -0.27, 0.8, -0.27] },
      ...mirror([0.45, 0.27, 0.45, 1, -0.05, 1, -0.05, 0.27]).map((p): Shape => ({ k: 'poly', p })),
      { k: 'line', p: [-0.9, -0.58, -0.9, 0.58] },
    ],
  },
  // one simple missile: body, nose cone, swept fins; long contrail
  rocket: { len: 0.9, trail: 'missile', trailLen: 3.4, shapes: MISSILE },
  // the same, a bit bigger, with a ring (the atom mark) on the body
  atomBomb: { len: 1.05, trail: 'missile', trailLen: 2.6, shapes: [...MISSILE, { k: 'ring', p: [-0.08, 0, 0.32] }] },
  // tank division: a squat hull, the two tracks as lines along its sides, a round turret and a barrel past the bow
  tankDivision: {
    len: 1.1,
    trail: 'none',
    trailLen: 0.3,
    shapes: [
      { k: 'poly', p: [-0.85, -0.55, -0.85, 0.55, 0.55, 0.55, 0.55, -0.55] },
      { k: 'line', p: [-0.95, 0.72, 0.65, 0.72] },
      { k: 'line', p: [-0.95, -0.72, 0.65, -0.72] },
      { k: 'ring', p: [-0.2, 0, 0.28] },
      { k: 'line', p: [0.08, 0, 1, 0] },
    ],
  },
};
for (const g of Object.values(GLYPHS)) {
  g.solid = g.shapes.some((s) => s.k === 'block');
  g.pits = g.shapes.some((s) => s.k === 'pit');
}

/**
 * Appends a glyph to the current path of ctx, centred at (x, y), rotated by (cos, sin), scaled by s px per half-length.
 * pass 'stroke': outlines, lines and rings, 'fill': closed outlines only (faint fill), 'solid': blocks only, 'pit': pits only.
 */
export function addGlyph(ctx: CanvasRenderingContext2D, g: Glyph, x: number, y: number, cos: number, sin: number, s: number, pass: 'stroke' | 'fill' | 'solid' | 'pit'): void {
  for (const sh of g.shapes) {
    const p = sh.p;
    if (pass === 'fill' && sh.k !== 'poly') continue;
    if (pass === 'solid' && sh.k !== 'block') continue;
    if (pass === 'pit' && sh.k !== 'pit') continue;
    if (sh.k === 'block' && pass !== 'solid') continue;
    if (sh.k === 'pit' && pass !== 'pit') continue;
    switch (sh.k) {
      case 'poly':
      case 'block':
      case 'pit':
      case 'line': {
        for (let i = 0; i < p.length; i += 2) {
          const px = x + (p[i] * cos - p[i + 1] * sin) * s;
          const py = y + (p[i] * sin + p[i + 1] * cos) * s;
          if (i === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        }
        if (sh.k !== 'line') ctx.closePath();
        break;
      }
      case 'dot': {
        const px = x + (p[0] * cos - p[1] * sin) * s;
        const py = y + (p[0] * sin + p[1] * cos) * s;
        ctx.moveTo(px, py);
        ctx.lineTo(px + 0.01, py);
        break;
      }
      case 'ring': {
        const px = x + (p[0] * cos - p[1] * sin) * s;
        const py = y + (p[0] * sin + p[1] * cos) * s;
        ctx.moveTo(px + p[2] * s, py);
        ctx.arc(px, py, p[2] * s, 0, Math.PI * 2);
        break;
      }
    }
  }
}

/** One glyph on screen. */
export interface Inst {
  type: UnitType;
  x: number;
  y: number;
  /** heading, radians */
  angle: number;
  /** px per half-length */
  S: number;
  /** ships only: drawn a wake while true */
  moving?: boolean;
}

/** All of one owner's glyphs: dark under-stroke, faint fill, solid blocks, dark pits, colour stroke (5 draw calls at most). */
export function strokeGlyphs(ctx: CanvasRenderingContext2D, list: readonly Inst[], color: string, fill: string, under: string, lw: number): void {
  let solid = false;
  let pits = false;
  for (const e of list) {
    const g = GLYPHS[e.type];
    if (g.solid) solid = true;
    if (g.pits) pits = true;
  }
  const path = (pass: 'stroke' | 'fill' | 'solid' | 'pit'): void => {
    ctx.beginPath();
    for (const e of list) {
      const g = GLYPHS[e.type];
      if ((pass === 'solid' && !g.solid) || (pass === 'pit' && !g.pits)) continue;
      addGlyph(ctx, g, e.x, e.y, Math.cos(e.angle), Math.sin(e.angle), e.S, pass);
    }
  };
  path('stroke');
  ctx.lineWidth = lw + 1.2;
  ctx.strokeStyle = under;
  ctx.stroke();
  path('fill');
  ctx.fillStyle = fill;
  ctx.fill();
  if (solid) {
    path('solid');
    ctx.fillStyle = color;
    ctx.fill();
  }
  if (pits) {
    path('pit');
    ctx.fillStyle = 'rgba(6,9,15,0.9)';
    ctx.fill();
  }
  path('stroke');
  ctx.lineWidth = lw;
  ctx.strokeStyle = color;
  ctx.stroke();
}

const TIERS = 3;
const AIR_ALPHA = [0.34, 0.2, 0.09];
const MISSILE_ALPHA = [0.75, 0.45, 0.2];

/** Tier i of a tapering contrail behind (x, y): a trapezoid from distance d0 to d1 behind, half-width w0 * (1 - t) at t. */
function addTier(ctx: CanvasRenderingContext2D, x: number, y: number, cos: number, sin: number, from: number, len: number, w0: number, i: number): void {
  const t0 = i / TIERS;
  const t1 = (i + 1) / TIERS;
  const d0 = from + len * t0;
  const d1 = from + len * t1;
  const h0 = (w0 * (1 - t0)) / 2;
  const h1 = (w0 * (1 - t1)) / 2;
  ctx.moveTo(x - cos * d0 - sin * h0, y - sin * d0 + cos * h0);
  ctx.lineTo(x - cos * d1 - sin * h1, y - sin * d1 + cos * h1);
  ctx.lineTo(x - cos * d1 + sin * h1, y - sin * d1 - cos * h1);
  ctx.lineTo(x - cos * d0 + sin * h0, y - sin * d0 - cos * h0);
  ctx.closePath();
}

/**
 * Contrails (missiles: long, tapering, fading; planes: short and faint) and ship wakes (a faint V) behind the glyphs.
 * `wakes`: also the ships' wakes and the planes' contrails (off at far zoom, where only missiles keep theirs).
 * Per frame 3 fills per trail class and one stroke for all wakes.
 */
export function drawTrails(ctx: CanvasRenderingContext2D, list: readonly Inst[], wakes: boolean): void {
  for (const kind of ['air', 'missile'] as const) {
    if (kind === 'air' && !wakes) continue;
    for (let i = 0; i < TIERS; i++) {
      ctx.beginPath();
      let any = false;
      for (const e of list) {
        const g = GLYPHS[e.type];
        if (g.trail !== kind) continue;
        const L = e.S * 2 * g.trailLen;
        const w0 = kind === 'missile' ? (e.type === 'atomBomb' ? 3.4 : 2.4) : 1.5;
        addTier(ctx, e.x, e.y, Math.cos(e.angle), Math.sin(e.angle), e.S * 0.85, L, w0, i);
        any = true;
      }
      if (!any) continue;
      ctx.fillStyle = `rgba(255,255,255,${(kind === 'missile' ? MISSILE_ALPHA : AIR_ALPHA)[i]})`;
      ctx.fill();
    }
  }
  if (!wakes) return;
  ctx.beginPath();
  let any = false;
  for (const e of list) {
    const g = GLYPHS[e.type];
    if (g.trail !== 'wake' || !e.moving) continue;
    const cos = Math.cos(e.angle);
    const sin = Math.sin(e.angle);
    const sx = -e.S * 0.9;
    const L = e.S * 2 * g.trailLen;
    for (const side of [1, -1]) {
      const y0 = side * e.S * 0.18;
      const bx = sx - L;
      const by = side * (e.S * 0.18 + L * 0.3);
      ctx.moveTo(e.x + sx * cos - y0 * sin, e.y + sx * sin + y0 * cos);
      ctx.lineTo(e.x + bx * cos - by * sin, e.y + bx * sin + by * cos);
    }
    any = true;
  }
  if (!any) return;
  ctx.lineWidth = 1;
  ctx.lineCap = 'round';
  ctx.strokeStyle = 'rgba(235,245,255,0.32)';
  ctx.stroke();
}
