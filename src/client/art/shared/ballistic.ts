// Ballistic flights as drawn (client only, pure): the silo rocket and the atom bomb climb in an arc. The sim flies both
// straight over the ground at one speed (src/sim/units.ts moveStraight) and nothing here changes that: where they hit,
// when, and what can be clicked or shot stay the sim's. A style that draws the arc (UnitArt.drawBallistic) lifts the
// missile off its ground point by the height below and lets its shadow run along the true ground path:
//   height    climbs steeply from the silo, peaks over the middle of the flight and comes down steeply on the target
//             (arcShape); the peak grows with the flight's length (arcPeak), in tiles, so it scales with the zoom like
//             the map does and a smoke trail laid in tiles stays on the arc
//   ground    the drawn ground point starts slowly (the missile rises nearly straight up off the pad), falls a few per
//             cent of the flight behind the sim's, then runs a little ahead near the end, so the last plunge is steep
//             (arcGround); it is on the target exactly at impact
//   staging   the atom bomb drops its first and second stages on the climb, burns the third to near the apex, and over
//             the target its reentry vehicle parts from the last stage and dives in, glowing (ICBM); the rocket is one
//             stage that burns out near the apex and coasts down nose first (ROCKET)
// Everything is a function of the flight fraction f (0 at launch, 1 at impact), so every frame of every client agrees
// and nothing is stored. render/units.ts also keeps where each missile was drawn (ballisticBoard) so the anti-air
// darts aimed at it and its burst when it is shot down show where the missile is drawn, not on its shadow.

export type BallisticKind = 'rocket' | 'atomBomb';

export const ARC = {
  /** the apex height per tile of flight (tiles), and its bounds */
  peak: 0.3,
  peakMin: 1.5,
  peakMax: 120,
  /** when the apex comes (flight fraction) and how hard the way down bends (exponent: steeper with more) */
  apex: 0.5,
  fall: 2.4,
  /** how slowly the drawn ground point leaves the silo (1 = it starts at rest) and how far it runs ahead at the end */
  lag: 1,
  lead: 0.7,
  /** screen px a tile of height lifts the drawn missile, per screen px per tile of zoom */
  lift: 0.7,
} as const;

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/** The apex height (tiles) of a flight `dist` tiles long. */
export function arcPeak(dist: number): number {
  const d = Math.max(0, dist);
  return Math.min(ARC.peakMax, Math.max(Math.min(ARC.peakMin, d), d * ARC.peak));
}

/** The drawn ground point's share of the way (0..1) at flight fraction f: slow off the pad, a little ahead at the end. */
export function arcGround(f: number): number {
  const t = clamp01(f);
  const u = 1 - t;
  return t - ARC.lag * t * u ** 6 + ARC.lead * u * t ** 6;
}

/** d arcGround / df. */
export function arcGroundRate(f: number): number {
  const t = clamp01(f);
  const u = 1 - t;
  return 1 - ARC.lag * u ** 5 * (1 - 7 * t) + ARC.lead * t ** 5 * (6 - 7 * t);
}

/** The height as a share of the apex (0..1) at flight fraction f: 0 at launch and impact, 1 at the apex. */
export function arcShape(f: number): number {
  const t = clamp01(f);
  const a = ARC.apex;
  if (t <= a) {
    const x = 1 - t / a;
    return 1 - x * x;
  }
  return 1 - ((t - a) / (1 - a)) ** ARC.fall;
}

/** d arcShape / df. */
export function arcShapeRate(f: number): number {
  const t = clamp01(f);
  const a = ARC.apex;
  if (t <= a) return (2 * (1 - t / a)) / a;
  const y = (t - a) / (1 - a);
  return (-ARC.fall * y ** (ARC.fall - 1)) / (1 - a);
}

/** One moment of the arc in the world (tiles): the ground share, the height, their rates and the pitch. */
export interface ArcPoint {
  /** share of the ground path (0..1) under the drawn missile */
  s: number;
  /** height (tiles) */
  h: number;
  /** rates per unit of flight fraction: along the ground (tiles) and up (tiles) */
  vs: number;
  vh: number;
  /** the nose's pitch over the ground (radians, + up) */
  pitch: number;
}

/** The arc of a flight `dist` tiles long at flight fraction f (into `out`, reused). */
export function arcAt(f: number, dist: number, out: ArcPoint = { s: 0, h: 0, vs: 0, vh: 0, pitch: 0 }): ArcPoint {
  const H = arcPeak(dist);
  out.s = arcGround(f);
  out.h = H * arcShape(f);
  out.vs = dist * arcGroundRate(f);
  out.vh = H * arcShapeRate(f);
  out.pitch = out.vs <= 1e-9 && out.vh >= 0 ? Math.PI / 2 : Math.atan2(out.vh, out.vs);
  return out;
}

/** The arc on screen: where the drawn missile is and which way its nose points. */
export interface ArcPose {
  /** the drawn missile (CSS px) and its ground point under it */
  x: number;
  y: number;
  gx: number;
  gy: number;
  /** how far it is lifted off the ground point (CSS px) */
  lift: number;
  /** the screen heading of the drawn path (radians, 0 = east, clockwise on screen) */
  angle: number;
  /** how much of its length shows (0.4..1): a missile pointing at the viewer is seen end on */
  fore: number;
  /** the nose's pitch over the ground (radians) and the height as a share of the apex */
  pitch: number;
  high: number;
}

const scratch: ArcPoint = { s: 0, h: 0, vs: 0, vh: 0, pitch: 0 };

/**
 * The drawn missile on screen at flight fraction f, for a flight from the silo (sx, sy) to the target (tx, ty) in CSS
 * px, `dist` tiles long, at `zoom` screen px per tile.
 */
export function arcPose(sx: number, sy: number, tx: number, ty: number, dist: number, zoom: number, f: number, out: ArcPose = { x: 0, y: 0, gx: 0, gy: 0, lift: 0, angle: 0, fore: 1, pitch: 0, high: 0 }): ArcPose {
  const a = arcAt(f, dist, scratch);
  const dx = tx - sx;
  const dy = ty - sy;
  out.gx = sx + dx * a.s;
  out.gy = sy + dy * a.s;
  out.lift = a.h * ARC.lift * zoom;
  out.x = out.gx;
  out.y = out.gy - out.lift;
  // the drawn path's direction on screen, and how foreshortened the body is along it
  const L = Math.hypot(dx, dy);
  const ux = L > 1e-9 ? dx / L : 1;
  const uy = L > 1e-9 ? dy / L : 0;
  const vx = ux * a.vs;
  const vy = uy * a.vs - a.vh * ARC.lift;
  out.angle = Math.abs(vx) + Math.abs(vy) < 1e-9 ? -Math.PI / 2 : Math.atan2(vy, vx);
  const v3 = Math.hypot(a.vs, a.vh);
  out.fore = v3 > 1e-9 ? Math.max(0.4, Math.min(1, Math.hypot(vx, vy) / v3)) : 1;
  out.pitch = a.pitch;
  const H = arcPeak(dist);
  out.high = H > 0 ? a.h / H : 0;
  return out;
}

// ------------------------------------------------------------------------------------------------- staging

/**
 * The atom bomb's staging (flight fractions, in order): the first stage burns out and drops, then the second, the
 * third burns on toward the apex and coasts over it, and the reentry vehicle parts from it on the way down.
 */
export const ICBM = { stage1: 0.13, stage2: 0.27, burnout: 0.43, rv: 0.66 } as const;
/** The rocket: one stage that burns out near the apex; its nose heats up on the way down from `heat`. */
export const ROCKET = { burnout: 0.4, heat: 0.72 } as const;

/** The flight fractions at which something parts from the missile, in order (separations; the rocket has none). */
export function separations(kind: BallisticKind): readonly number[] {
  return kind === 'atomBomb' ? [ICBM.stage1, ICBM.stage2, ICBM.rv] : [];
}

export interface BallisticPhase {
  /** which of the body's looks: 0 whole; the atom bomb 1 without its first stage, 2 the third stage and the reentry
   * vehicle, 3 the reentry vehicle alone */
  body: number;
  /** the stage whose motor burns now (1..3), 0 coasting */
  burn: number;
  /** how strong the smoke trail is now (0 none .. 1 the first stage's heavy column) */
  smoke: number;
  /** reentry heat at the nose (0..1) */
  heat: number;
  name: 'stage 1' | 'stage 2' | 'stage 3' | 'coast' | 'reentry' | 'boost';
}

/** Where a flight of `kind` stands at flight fraction f. */
export function ballisticPhase(kind: BallisticKind, f: number, out: BallisticPhase = { body: 0, burn: 0, smoke: 0, heat: 0, name: 'boost' }): BallisticPhase {
  const t = clamp01(f);
  if (kind === 'rocket') {
    const burning = t < ROCKET.burnout;
    out.body = 0;
    out.burn = burning ? 1 : 0;
    out.smoke = burning ? 0.85 : 0.3;
    out.heat = t > ROCKET.heat ? clamp01((t - ROCKET.heat) / (1 - ROCKET.heat)) ** 0.8 : 0;
    out.name = burning ? 'boost' : out.heat > 0 ? 'reentry' : 'coast';
    return out;
  }
  out.heat = 0;
  if (t < ICBM.stage1) {
    out.body = 0;
    out.burn = 1;
    out.smoke = 1;
    out.name = 'stage 1';
  } else if (t < ICBM.stage2) {
    out.body = 1;
    out.burn = 2;
    out.smoke = 0.7;
    out.name = 'stage 2';
  } else if (t < ICBM.burnout) {
    out.body = 2;
    out.burn = 3;
    out.smoke = 0.45;
    out.name = 'stage 3';
  } else if (t < ICBM.rv) {
    out.body = 2;
    out.burn = 0;
    out.smoke = 0;
    out.name = 'coast';
  } else {
    out.body = 3;
    out.burn = 0;
    out.smoke = 0;
    out.heat = clamp01((t - ICBM.rv - 0.03) / (1 - ICBM.rv - 0.03)) ** 0.7;
    out.name = 'reentry';
  }
  return out;
}

/**
 * A spent stage after it parted (ms since), for a flight of `totalMs`: how long it falls (it is on the ground at 1),
 * how far it has turned end over end (radians; still under Reduce motion) and how strongly it shows.
 */
export function stageFall(ageMs: number, totalMs: number, reduced: boolean, seed = 0): { t: number; spin: number; alpha: number; fallMs: number } {
  const fallMs = Math.max(650, Math.min(2400, totalMs * 0.3));
  const t = clamp01(ageMs / fallMs);
  const dir = (Math.floor(seed * 7.13) & 1) === 0 ? 1 : -1;
  const spin = reduced ? 0 : dir * (ageMs / 1000) * (2.6 + (seed % 1) * 1.6);
  const alpha = t < 0.8 ? 1 : 1 - (t - 0.8) / 0.2;
  return { t, spin, alpha: ageMs < 0 ? 0 : alpha, fallMs };
}

/** How bright a flash (stage ignition, the launch) shows `ageMs` after it, over `ms`: none under Reduce motion. */
export function flashAlpha(ageMs: number, ms: number, reduced: boolean): number {
  if (reduced || ageMs < 0 || ageMs >= ms) return 0;
  return 1 - ageMs / ms;
}

// ------------------------------------------------------------------------------------------------- where they were drawn

/**
 * Where each ballistic missile was drawn last (render/units.ts writes it every frame): its ground point on the map and
 * the drawn missile's offset from it, in tiles. The effects read it so an anti-air dart flies to the missile as drawn
 * and a missile shot down bursts where it was seen. A few dozen entries at most; old ones are dropped.
 */
export class BallisticBoard {
  private ids: number[] = [];
  private v: number[] = [];
  private stamp = 0;

  /** Starts a frame (entries not written again within about 2 s are dropped). */
  frame(nowMs: number): void {
    this.stamp = nowMs;
    if (this.ids.length > 64) this.prune(nowMs - 2000);
  }

  put(id: number, x: number, y: number, dx: number, dy: number): void {
    let i = this.ids.indexOf(id);
    if (i < 0) {
      i = this.ids.length;
      this.ids.push(id);
    }
    const o = i * 5;
    this.v[o] = x;
    this.v[o + 1] = y;
    this.v[o + 2] = dx;
    this.v[o + 3] = dy;
    this.v[o + 4] = this.stamp;
  }

  /** The drawn offset (tiles) of missile `id`, or null. */
  offsetOf(id: number, fromMs = -Infinity): readonly [number, number] | null {
    const i = this.ids.indexOf(id);
    if (i < 0 || this.v[i * 5 + 4] < fromMs) return null;
    return [this.v[i * 5 + 2], this.v[i * 5 + 3]];
  }

  /** The drawn offset (tiles) of the missile whose ground point is nearest (x, y) within `r` tiles, or null. */
  offsetNear(x: number, y: number, r: number, fromMs = -Infinity): readonly [number, number] | null {
    let best = -1;
    let bd = r * r;
    for (let i = 0; i < this.ids.length; i++) {
      const o = i * 5;
      if (this.v[o + 4] < fromMs) continue;
      const d = (this.v[o] - x) ** 2 + (this.v[o + 1] - y) ** 2;
      if (d <= bd) {
        bd = d;
        best = i;
      }
    }
    return best < 0 ? null : [this.v[best * 5 + 2], this.v[best * 5 + 3]];
  }

  clear(): void {
    this.ids.length = 0;
    this.v.length = 0;
  }

  private prune(before: number): void {
    const ids: number[] = [];
    const v: number[] = [];
    for (let i = 0; i < this.ids.length; i++) {
      if (this.v[i * 5 + 4] < before) continue;
      ids.push(this.ids[i]);
      for (let k = 0; k < 5; k++) v.push(this.v[i * 5 + k]);
    }
    this.ids = ids;
    this.v = v;
  }
}

export const ballisticBoard = new BallisticBoard();
