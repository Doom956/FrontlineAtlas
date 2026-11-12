// Minimal line glyphs for the mobile units on the map (client only). Each glyph is a handful of strokes in a unit
// square: nose at +x, half-length 1, lateral axis y. They are stroked in the owner's colour over a thin dark
// under-stroke, so dozens of ships and planes in one area stay readable, and each type has its own silhouette:
//   fighter = small swept delta with twin tail prongs      bomber = long straight wings, 4 engine ticks, long body
//   cargo plane = fat body, boxy high wings, T-tail        warship = long narrow hull, two turrets with barrels
//   landing craft = short square-fronted hull + ramp       trade ship = pointed hull with container blocks
//   rocket / atom bomb = one missile shape (the bomb bigger, with a ring), both with a long fading contrail
//   tank division = squat hull with two track lines, a round turret and a long barrel forward (no trail)
// The detailed pictures live in icons.ts (HUD) and the map sprites in pixelSprites.ts. Trails (contrails of pixel
// smoke puffs, foam wakes) are drawn here too, see drawTrails.
import type { UnitType } from '../../sim/types';
import { prankView } from '../fx/prankView';

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
  // recon plane: a slim body, long straight wings, a small tail and a lens ring at the nose
  reconPlane: {
    len: 0.95,
    trail: 'air',
    trailLen: 0.7,
    shapes: [
      { k: 'line', p: [1, 0, -1, 0] },
      { k: 'line', p: [0.15, -1.05, 0.15, 1.05] },
      { k: 'line', p: [-0.85, -0.38, -0.85, 0.38] },
      { k: 'ring', p: [0.72, 0, 0.18] },
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
  /** world-anchored trails (TrailPuffs): the unit's id and position in tiles */
  id?: number;
  tx?: number;
  ty?: number;
}

/** All of one owner's glyphs: dark under-stroke, faint fill, solid blocks, dark pits, colour stroke (5 draw calls at most). */
export function strokeGlyphs(ctx: CanvasRenderingContext2D, list: readonly Inst[], color: string, fill: string, under: string, lw: number): void {
  if (prankView.ducks) {
    // the ducks prank (fx/prankView.ts): every ship, plane and division is a rubber duck for a few seconds; missiles
    // stay missiles (a strike must still read as one)
    const ducks = list.filter((e) => GLYPHS[e.type].trail !== 'missile');
    if (ducks.length) strokeDucks(ctx, ducks, color, under, lw);
    if (ducks.length === list.length) return;
    list = list.filter((e) => GLYPHS[e.type].trail === 'missile');
  }
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

// ------------------------------------------------------------------------------------------------- trails
// Contrails and wakes are short lines of small pixel PUFFS, not lines: smoke behind missiles (white-hot at the engine,
// then light grey, tapering from about one missile width to two or three, fading out within a second), faint smoke
// behind planes, and foam puffs at both sides of a moving ship's stern that drift apart into a V. Puffs stay where
// they were made (world coordinates) and fade there, so a trail lingers and breaks up behind the unit. One small ring
// buffer of puffs (TrailPuffs) per unit layer; drawn as whole-pixel discs on the sprites' pixel grid. Without a
// buffer (tests, previews) the same puffs are laid out along the heading instead.

/** Puff kinds. */
const SMOKE = 0;
const FAINT = 1;
const FOAM = 2;
const PUFF_CAP = 1800;

/** World-anchored puffs (tile coordinates), a fixed ring buffer: nothing is allocated per puff. */
export class TrailPuffs {
  readonly x = new Float32Array(PUFF_CAP);
  readonly y = new Float32Array(PUFF_CAP);
  readonly vx = new Float32Array(PUFF_CAP);
  readonly vy = new Float32Array(PUFF_CAP);
  readonly born = new Float64Array(PUFF_CAP);
  readonly life = new Float32Array(PUFF_CAP);
  readonly r0 = new Float32Array(PUFF_CAP);
  readonly r1 = new Float32Array(PUFF_CAP);
  readonly kind = new Uint8Array(PUFF_CAP);
  /** next slot (the oldest puff is overwritten when full) */
  private head = 0;
  /** where each emitter (unit id * 4 + side) dropped its last puff, and the frame it was seen */
  private last = new Map<number, { x: number; y: number; frame: number }>();
  private frame = 0;
  /** puffs made since the start (tests, stats) */
  made = 0;

  clear(): void {
    this.life.fill(0);
    this.last.clear();
    this.head = 0;
  }

  /** Starts a frame: forgets emitters not seen for a while. */
  begin(): void {
    this.frame++;
    if (this.frame % 60 === 0) for (const [k, v] of this.last) if (this.frame - v.frame > 30) this.last.delete(k);
  }

  private put(x: number, y: number, vx: number, vy: number, now: number, life: number, r0: number, r1: number, kind: number): void {
    const i = this.head;
    this.x[i] = x;
    this.y[i] = y;
    this.vx[i] = vx;
    this.vy[i] = vy;
    this.born[i] = now;
    this.life[i] = life;
    this.r0[i] = r0;
    this.r1[i] = r1;
    this.kind[i] = kind;
    this.head = (i + 1) % PUFF_CAP;
    this.made++;
  }

  /**
   * Drops puffs every `spacing` tiles along the way emitter `key` went since last frame, ending at (x, y) (tiles).
   * vx, vy: drift in tiles per second.
   */
  emit(key: number, x: number, y: number, spacing: number, now: number, life: number, r0: number, r1: number, kind: number, vx: number, vy: number, jit = 0): void {
    const l = this.last.get(key);
    if (!l || this.frame - l.frame > 3) {
      this.last.set(key, { x, y, frame: this.frame });
      this.put(x, y, vx, vy, now, life, r0, r1, kind);
      return;
    }
    l.frame = this.frame;
    const dx = x - l.x;
    const dy = y - l.y;
    const d = Math.hypot(dx, dy);
    if (d < spacing) return;
    // a jump (a teleport, a long pause) starts a fresh trail
    if (d > spacing * 60) {
      l.x = x;
      l.y = y;
      this.put(x, y, vx, vy, now, life, r0, r1, kind);
      return;
    }
    const n = Math.floor(d / spacing);
    for (let k = 1; k <= n; k++) {
      const q = (k * spacing) / d;
      // a little off the line, so the smoke looks irregular; the puff dropped earlier along the way is older
      const j = jit ? (Math.sin(this.made * 12.9898) * 43758.5453) % 1 : 0;
      this.put(l.x + dx * q - (dy / d) * j * jit, l.y + dy * q + (dx / d) * j * jit, vx, vy, now - (1 - q) * 16, life * (0.85 + 0.3 * Math.abs(j)), r0, r1 * (0.8 + 0.4 * Math.abs(j)), kind);
    }
    l.x += (dx * n * spacing) / d;
    l.y += (dy * n * spacing) / d;
  }

  /** Draws the live puffs: (ox, oy) = screen position of tile (0, 0), z px per tile, g px per art pixel. */
  draw(ctx: CanvasRenderingContext2D, ox: number, oy: number, z: number, g: number, now: number, viewW: number, viewH: number): number {
    const prev = ctx.globalAlpha;
    let drawn = 0;
    for (let i = 0; i < PUFF_CAP; i++) {
      const life = this.life[i];
      if (life <= 0) continue;
      const age = now - this.born[i];
      if (age >= life) {
        this.life[i] = 0;
        continue;
      }
      if (age < 0) continue;
      const q = age / life;
      const sx = ox + (this.x[i] + (this.vx[i] * age) / 1000) * z;
      const sy = oy + (this.y[i] + (this.vy[i] * age) / 1000) * z;
      if (sx < -20 || sy < -20 || sx > viewW + 20 || sy > viewH + 20) continue;
      const r = this.r0[i] + (this.r1[i] - this.r0[i]) * Math.sqrt(q);
      const k = this.kind[i];
      if (k === FOAM) {
        ctx.globalAlpha = prev * 0.7 * (1 - q);
        ctx.fillStyle = q < 0.3 ? '#ffffff' : '#dcebf3';
      } else {
        // white-hot at the engine, then a neutral light grey
        ctx.globalAlpha = prev * (k === FAINT ? 0.45 : 0.72) * (1 - q);
        ctx.fillStyle = q < 0.12 && k === SMOKE ? '#fffbe8' : q < 0.45 ? '#e6e6e1' : '#c6c6c0';
      }
      puffDisc(ctx, sx, sy, r, g);
      drawn++;
    }
    ctx.globalAlpha = prev;
    return drawn;
  }
}

/** A whole-pixel puff of radius r cells (g px each): one cell, a 2 cell square, a 3 cell blob or a round disc. */
function puffDisc(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, g: number): void {
  const X = Math.round(x / g) * g;
  const Y = Math.round(y / g) * g;
  if (r < 0.75) {
    ctx.fillRect(X, Y, g, g);
    return;
  }
  if (r < 1.15) {
    // a 2 px puff (a plus would read as a sparkle)
    ctx.fillRect(X - g, Y - g, g * 2, g * 2);
    return;
  }
  if (r < 1.5) {
    // two overlapping 2 px squares: a round 3 px blob without its top right and bottom left corners
    ctx.fillRect(X - g, Y - g, g * 2, g * 2);
    ctx.fillRect(X, Y, g * 2, g * 2);
    return;
  }
  const ri = Math.round(r);
  for (let dy = -ri; dy <= ri; dy++) {
    const half = Math.floor(Math.sqrt(ri * ri - dy * dy) + 0.3);
    ctx.fillRect(X - half * g, Y + dy * g, (half * 2 + 1) * g, g);
  }
}

/** Where the camera puts tile (0, 0), the zoom, the sprites' pixel size and the time, for world-anchored trails. */
export interface TrailView {
  ox: number;
  oy: number;
  z: number;
  g: number;
  now: number;
  viewW: number;
  viewH: number;
}

/**
 * Contrails (missiles at every zoom; planes and ship wakes only with `wakes`, i.e. not far out) behind the units.
 * With a puff buffer and a view, puffs are dropped along the way each unit went (Inst.id, tx, ty needed) and drawn
 * where they were dropped; without, the same puffs are laid out along each unit's heading.
 */
export function drawTrails(ctx: CanvasRenderingContext2D, list: readonly Inst[], wakes: boolean, puffs?: TrailPuffs, view?: TrailView): void {
  if (puffs && view) {
    const { z, g, now } = view;
    puffs.begin();
    for (const e of list) {
      const gl = GLYPHS[e.type];
      if (gl.trail === 'none' || e.id === undefined || e.tx === undefined || e.ty === undefined) continue;
      if (gl.trail !== 'missile' && !wakes) continue;
      const cos = Math.cos(e.angle);
      const sin = Math.sin(e.angle);
      const back = (e.S * 0.9) / z;
      if (gl.trail === 'missile') {
        // narrow and white-hot at the engine, wider and broken up toward the back; a few missile lengths long
        const big = e.type === 'atomBomb';
        const life = z < 3 ? 1100 : 300;
        puffs.emit(e.id * 4, e.tx - cos * back, e.ty - sin * back, (2.5 * g) / z, now, life, big ? 1 : 0.8, big ? 3.4 : 2.8, SMOKE, 1.2 / z, -2 / z, (1.2 * g) / z);
      } else if (gl.trail === 'air') {
        puffs.emit(e.id * 4, e.tx - cos * back, e.ty - sin * back, (3.5 * g) / z, now, 300, 0.5, 1.6, FAINT, 0, 0, (0.8 * g) / z);
      } else if (e.moving) {
        // foam at both sides of the stern, drifting outward: a V behind the ship
        const side = (e.S * 0.22) / z;
        const spread = 0.9 / Math.max(1, z * 0.15);
        for (const sd of [1, -1]) puffs.emit(e.id * 4 + (sd > 0 ? 1 : 2), e.tx - cos * back * 0.95 - sin * side * sd, e.ty - sin * back * 0.95 + cos * side * sd, (3 * g) / z, now, 1100, 0.4, 1.1, FOAM, -sin * sd * spread, cos * sd * spread);
      }
    }
    puffs.draw(ctx, view.ox, view.oy, z, g, now, view.viewW, view.viewH);
    return;
  }
  // no buffer: the puffs laid out along the heading (oldest and widest at the tail)
  const prev = ctx.globalAlpha;
  for (const e of list) {
    const gl = GLYPHS[e.type];
    if (gl.trail === 'none' || (gl.trail !== 'missile' && !wakes)) continue;
    if (gl.trail === 'wake' && !e.moving) continue;
    const cos = Math.cos(e.angle);
    const sin = Math.sin(e.angle);
    const L = e.S * 2 * gl.trailLen;
    const n = gl.trail === 'missile' ? 7 : 4;
    for (let i = 0; i < n; i++) {
      const q = i / (n - 1);
      const d = e.S * 0.85 + L * q;
      ctx.globalAlpha = prev * (gl.trail === 'missile' ? 0.72 : 0.45) * (1 - q * 0.85);
      ctx.fillStyle = gl.trail === 'wake' ? '#ffffff' : q < 0.15 ? '#fffbe8' : '#e0e0db';
      if (gl.trail === 'wake') for (const sd of [1, -1]) puffDisc(ctx, e.x - cos * d - sin * sd * (e.S * 0.2 + L * 0.3 * q), e.y - sin * d + cos * sd * (e.S * 0.2 + L * 0.3 * q), 0.5 + q, 1);
      else puffDisc(ctx, e.x - cos * d, e.y - sin * d, 0.5 + q * 1.7, 1);
    }
  }
  ctx.globalAlpha = prev;
}

const DUCK_BODY = '#f5d33b';
const DUCK_BEAK = '#ee7d24';

/**
 * Rubber ducks in place of the glyphs (yellow, outlined in the owner's colour so the side still reads; they face the
 * way the unit goes, left or right, and bob a little). Four fills and two strokes per owner.
 */
export function strokeDucks(ctx: CanvasRenderingContext2D, list: readonly Inst[], color: string, under: string, lw: number, nowMs = performance.now()): void {
  const at = (e: Inst): { f: number; R: number; y: number } => ({ f: Math.cos(e.angle) >= 0 ? 1 : -1, R: Math.max(4, e.S * 0.95), y: e.y + Math.sin(nowMs / 240 + e.x * 0.05) * 0.8 });
  ctx.beginPath();
  for (const e of list) {
    const { f, R, y } = at(e);
    // body with a perky tail, then the head
    ctx.moveTo(e.x - f * 0.95 * R, y - 0.2 * R);
    ctx.quadraticCurveTo(e.x - f * 1.05 * R, y + 0.75 * R, e.x, y + 0.72 * R);
    ctx.quadraticCurveTo(e.x + f * 0.95 * R, y + 0.7 * R, e.x + f * 0.75 * R, y + 0.05 * R);
    ctx.lineTo(e.x - f * 0.55 * R, y + 0.02 * R);
    ctx.closePath();
    ctx.moveTo(e.x + f * 0.82 * R, y - 0.42 * R);
    ctx.arc(e.x + f * 0.42 * R, y - 0.42 * R, 0.4 * R, 0, Math.PI * 2);
  }
  ctx.lineWidth = lw + 1.4;
  ctx.strokeStyle = under;
  ctx.stroke();
  ctx.fillStyle = DUCK_BODY;
  ctx.fill();
  ctx.lineWidth = Math.max(1, lw * 0.8);
  ctx.strokeStyle = color;
  ctx.stroke();
  ctx.beginPath();
  for (const e of list) {
    const { f, R, y } = at(e);
    ctx.moveTo(e.x + f * 0.76 * R, y - 0.5 * R);
    ctx.lineTo(e.x + f * 1.18 * R, y - 0.36 * R);
    ctx.lineTo(e.x + f * 0.76 * R, y - 0.24 * R);
    ctx.closePath();
  }
  ctx.fillStyle = DUCK_BEAK;
  ctx.fill();
  ctx.beginPath();
  for (const e of list) {
    const { f, R, y } = at(e);
    const r = Math.max(0.8, 0.08 * R);
    ctx.moveTo(e.x + f * 0.5 * R + r, y - 0.5 * R);
    ctx.arc(e.x + f * 0.5 * R, y - 0.5 * R, r, 0, Math.PI * 2);
  }
  ctx.fillStyle = 'rgba(6,9,15,0.95)';
  ctx.fill();
}
