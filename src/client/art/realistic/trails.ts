// The realistic style's wakes and contrails (client only). Trails stay where they were laid (map tiles) and fade there.
//
// Wakes (ships): the churned white water right behind the stern spreading into a pale strip with a ragged edge that
// breaks into turbulent patches, the two arms of the Kelvin V opening at its fixed angle (about 19 degrees, wakeSpread)
// and the bow wave curling off both sides of a moving bow. The arms are as long as a few hull lengths (by distance, not
// time: longer with speed and wakeLength), narrow and bright at the stern, widening and breaking into foam (broken
// dashes and spray over a faint wide band) as they age; on a turn they fade and break up, never leaving clean arcs.
// A submarine leaves a thin, faint wake and no bow wave.
// Contrails (planes): vapour from the engines (the wing tips for single-engine planes), a few px behind them: a narrow
// core over a wide faint band, growing from 1 to about 4 times its width as it ages, thinning out, drifting with the
// wind, spreading and wavering a little (contrailLife). The same code at every zoom.
// Missile trails: a continuous soft smoke ribbon widening with age, with billowing puffs packed along it (each at
// under half its radius from the next, uneven in size, turn and lateral place), from a hot exhaust (missileTrailLife);
// far out (TrailView.full false) a cheap soft line instead.
//
// Cheap: each trail is a short ring of points; a frame fills or strokes a handful of soft bands per trail (a few draw
// calls per ship or plane, never one per point) plus a capped number of puffs close up, and skips trails off screen.
import { unitCategoryOf, type SpriteKey } from '../shared/keys';
import type { MotionParams } from '../motion';
import type { TrailArt, TrailLayer, TrailUnit, TrailView } from '../types';
import { rnd } from '../shared/noise';
import { Puff, puff, puffTurned, WIND_X, WIND_Y } from './puffs';
import { modelOf } from './units';

const CAP = 96;
const WAKE = 0;
const CONTRAIL = 1;
const MISSILE = 2;

class Emitter {
  readonly x = new Float32Array(CAP);
  readonly y = new Float32Array(CAP);
  readonly a = new Float32Array(CAP);
  readonly t = new Float64Array(CAP);
  readonly s = new Float32Array(CAP);
  /** each point's number in the order laid (a stable identity: thinning keeps the same points every frame) */
  readonly seq = new Int32Array(CAP);
  laid = 0;
  /** points held (newest at head - 1) */
  n = 0;
  head = 0;
  seen = 0;
  /** the motion of the unit the trail follows (last seen) */
  motion: MotionParams | null = null;
  /** where the trail starts this frame (the stern or the engines now, tiles), its heading and speed; hv: valid */
  hx = 0;
  hy = 0;
  ha = 0;
  hs = 0;
  hv = false;
  constructor(
    readonly kind: number,
    public key: SpriteKey,
  ) {}
  /** index of the k-th newest point (0 = newest) */
  at(k: number): number {
    return (this.head - 1 - k + CAP * 2) % CAP;
  }
  push(x: number, y: number, a: number, t: number, s: number): void {
    const i = this.head;
    this.x[i] = x;
    this.y[i] = y;
    this.a[i] = a;
    this.t[i] = t;
    this.s[i] = s;
    this.seq[i] = this.laid++;
    this.head = (i + 1) % CAP;
    this.n = Math.min(CAP, this.n + 1);
  }
  /** drops points older than `life` ms */
  trim(now: number, life: number): void {
    while (this.n > 0 && now - this.t[this.at(this.n - 1)] > life) this.n--;
  }
}

/** Where the trail starts behind a unit and how wide apart its lines are (art units), per unit key. */
function trailGeom(key: SpriteKey): { back: number; side: number; beam: number } {
  const m = modelOf(key, 0);
  if (unitCategoryOf(key) === 'ships') return { back: -(m.stern ?? -m.len / 2) * 0.96, side: 0, beam: m.beam ?? 2 };
  if (unitCategoryOf(key) === 'missiles') return { back: m.len / 2 + 0.6, side: 0, beam: 1 };
  let side = 0;
  for (const p of m.props ?? []) side = Math.max(side, Math.abs(p.y));
  if (side < 1) side = m.fit * 0.36;
  // the engines' exhaust (just behind the wing), a little out from them
  return { back: m.len * 0.22, side, beam: 1 };
}

const geomCache = new Map<SpriteKey, { back: number; side: number; beam: number }>();
const geomOf = (k: SpriteKey): { back: number; side: number; beam: number } => {
  let g = geomCache.get(k);
  if (!g) geomCache.set(k, (g = trailGeom(k)));
  return g;
};

// ------------------------------------------------------------------------------------------------- drawing helpers

/** Screen position of the k-th newest point, moved `side` tiles sideways (opening by `spread` per tile travelled) and drifted with the wind. */
function screenAt(e: Emitter, k: number, v: TrailView, side: number, spread: number, drift: number, out: number[]): void {
  const i = e.at(k);
  const age = (v.now - e.t[i]) / 1000;
  const off = side + Math.sign(side) * spread * age * e.s[i];
  out[0] = v.ox + (e.x[i] - Math.sin(e.a[i]) * off + WIND_X * drift * age) * v.zoom;
  out[1] = v.oy + (e.y[i] + Math.cos(e.a[i]) * off + WIND_Y * drift * age) * v.zoom;
}

const P0 = [0, 0];
const P1 = [0, 0];
const PB = [0, 0];

/** Where point kb lies along the line from point k0 to point k1 (0..1, never before `min`): a gradient stop's offset. */
function along(e: Emitter, kb: number, k0: number, k1: number, v: TrailView, drift: number, min: number): number {
  screenAt(e, k0, v, 0, 0, drift, P0);
  screenAt(e, k1, v, 0, 0, drift, P1);
  screenAt(e, kb, v, 0, 0, drift, PB);
  const dx = P1[0] - P0[0];
  const dy = P1[1] - P0[1];
  const d2 = dx * dx + dy * dy;
  const t = d2 > 1e-6 ? ((PB[0] - P0[0]) * dx + (PB[1] - P0[1]) * dy) / d2 : 0;
  return Math.max(min, Math.min(1, t));
}

/**
 * A gradient along the trail from point ks[0] to the last of ks, its colour `rgb[i]` at alpha `as[i]` at point ks[i]
 * (so one stroke or fill fades through several age bands).
 */
function fadeAlong(ctx: CanvasRenderingContext2D, e: Emitter, v: TrailView, drift: number, ks: readonly number[], rgb: readonly string[], as: readonly number[]): CanvasGradient {
  const k0 = ks[0];
  const k1 = ks[ks.length - 1];
  screenAt(e, k0, v, 0, 0, drift, P0);
  screenAt(e, k1, v, 0, 0, drift, P1);
  const g = ctx.createLinearGradient(P0[0], P0[1], P1[0], P1[1]);
  let at = 0;
  for (let i = 0; i < ks.length; i++) {
    at = i === 0 ? 0 : i === ks.length - 1 ? 1 : along(e, ks[i], k0, k1, v, drift, at);
    g.addColorStop(at, `rgba(${rgb[Math.min(i, rgb.length - 1)]},${Math.max(0, as[i]).toFixed(3)})`);
  }
  return g;
}

/** Strokes points k0..k1 along the track (drifting with the wind), with the stroke style already set. */
function strokeLine(ctx: CanvasRenderingContext2D, e: Emitter, k0: number, k1: number, v: TrailView, drift: number, w: number): void {
  ctx.lineWidth = w;
  ctx.beginPath();
  screenAt(e, k0, v, 0, 0, drift, P0);
  ctx.moveTo(P0[0], P0[1]);
  for (let k = k0 + 1; k <= k1; k++) {
    screenAt(e, k, v, 0, 0, drift, P1);
    ctx.lineTo(P1[0], P1[1]);
  }
  ctx.stroke();
}

// ------------------------------------------------------------------------------------------------- screen polylines

const TAU = Math.PI * 2;
const N = CAP + 2;
// A trail gathered into screen space this frame, newest first: its centre line (SX, SY), the offset of its side lines
// (OF px, along the normal NX, NY of each point's own heading), age 0..1 of the life asked for (SQ), distance along it
// from the head (SD, tiles), how far each point's heading has turned from the head's (ST, radians: a turning ship's
// old foam fades and breaks) and a stable 0..1 value per point (SR, so dashes and puffs stay where they were laid).
const SX = new Float32Array(N);
const SY = new Float32Array(N);
const OF = new Float32Array(N);
const NX = new Float32Array(N);
const NY = new Float32Array(N);
const SQ = new Float32Array(N);
const SD = new Float32Array(N);
const ST = new Float32Array(N);
const SR = new Float32Array(N);
/** each point's own laying time (ms, kept small), for slow noise along a trail */
const AT = new Float32Array(N);

const wrapPi = (a: number): number => {
  let d = a % TAU;
  if (d > Math.PI) d -= TAU;
  if (d < -Math.PI) d += TAU;
  return d;
};

interface GatherOpts {
  /** offset of the side lines across the track (tiles) at the start, growing per tile travelled and per second of age */
  side: number;
  grow: number;
  spread: number;
  /** wind drift (tiles per second of age) and rising smoke (screen px per second of age) */
  drift: number;
  rise: number;
  /** a slow sideways waver growing with age (tiles at the oldest point) and its phase */
  wave: number;
  phase?: number;
  /** stop at this age (ms) or this distance along the trail (tiles) */
  life: number;
  maxDist: number;
  /** keep every n-th laid point (mid zoom: half of them; a few px apart is plenty there) */
  stride?: number;
}

/**
 * Gathers a trail into the S* buffers, newest first, starting at the live head (the stern or the engines this frame),
 * up to its life or a distance along it. Returns how many points there are.
 */
function gather(e: Emitter, v: TrailView, o: GatherOpts): number {
  let n = 0;
  let dist = 0;
  let px = e.hx;
  let py = e.hy;
  const z = v.zoom;
  const add = (x: number, y: number, a: number, age: number, d: number, r: number): void => {
    const q = Math.min(1, age / o.life);
    const ag = age / 1000;
    const w = o.wave * q * Math.sin((v.now - age) * 0.0023 + (o.phase ?? 0));
    const sn = Math.sin(a);
    const cs = Math.cos(a);
    SX[n] = v.ox + (x - sn * w + WIND_X * o.drift * ag) * z;
    SY[n] = v.oy + (y + cs * w + WIND_Y * o.drift * ag) * z - o.rise * ag;
    OF[n] = (o.side + o.grow * d + o.spread * ag) * z;
    NX[n] = -sn;
    NY[n] = cs;
    SQ[n] = q;
    SD[n] = d;
    ST[n] = Math.abs(wrapPi(a - e.ha));
    SR[n] = r;
    AT[n] = (v.now - age) % 1e6;
    n++;
  };
  if (e.hv) add(e.hx, e.hy, e.ha, 0, 0, 0.5);
  else if (e.n > 0) {
    const i = e.at(0);
    px = e.x[i];
    py = e.y[i];
  }
  const stride = o.stride ?? 1;
  for (let k = 0; k < e.n; k++) {
    const i = e.at(k);
    const age = v.now - e.t[i];
    if (age > o.life || age < 0) break;
    dist += Math.hypot(e.x[i] - px, e.y[i] - py);
    if (dist > o.maxDist) break;
    if (stride > 1 && e.seq[i] % stride !== 0 && k !== e.n - 1) {
      px = e.x[i];
      py = e.y[i];
      continue;
    }
    // (a point sitting right on the head adds nothing: the first segment needs a direction)
    if (n > 0 && Math.abs(e.x[i] - px) + Math.abs(e.y[i] - py) < 1e-4) continue;
    px = e.x[i];
    py = e.y[i];
    add(e.x[i], e.y[i], e.a[i], age, dist, rnd(e.t[i] % 100003, 7));
  }
  return n;
}

/** Screen x, y of gathered point i on side sd (-1 port, 0 the centre, 1 starboard). */
const sx = (i: number, sd: number): number => SX[i] + sd * NX[i] * OF[i];
const sy = (i: number, sd: number): number => SY[i] + sd * NY[i] * OF[i];

/**
 * A gradient along the gathered points i0..i1 (projected on the line between them): alpha as[j] where `key` (SQ or SD
 * scaled by `total`) first reaches qs[j].
 */
function gradAlong(ctx: CanvasRenderingContext2D, i0: number, i1: number, rgb: string, qs: readonly number[], as: readonly number[], key: Float32Array = SQ, total = 1): CanvasGradient {
  const x0 = SX[i0];
  const y0 = SY[i0];
  const dx = SX[i1] - x0;
  const dy = SY[i1] - y0;
  const d2 = dx * dx + dy * dy;
  const g = ctx.createLinearGradient(x0, y0, SX[i1], SY[i1]);
  let at = 0;
  let j = i0;
  for (let s = 0; s < qs.length; s++) {
    while (j < i1 && key[j] / total < qs[s]) j++;
    const t = d2 > 1e-6 ? ((SX[j] - x0) * dx + (SY[j] - y0) * dy) / d2 : s / Math.max(1, qs.length - 1);
    at = s === 0 ? 0 : s === qs.length - 1 ? 1 : Math.max(at, Math.min(1, t));
    g.addColorStop(at, `rgba(${rgb},${Math.max(0, as[s]).toFixed(3)})`);
  }
  return g;
}

/** Adds a ribbon round side sd of gathered points i0..i1 to the current path, half width hw(i) px. */
function ribbonPath(ctx: CanvasRenderingContext2D, i0: number, i1: number, sd: number, hw: (i: number) => number): void {
  if (i1 - i0 < 1) return;
  for (let pass = 0; pass < 2; pass++) {
    for (let k = 0; k <= i1 - i0; k++) {
      const i = pass === 0 ? i0 + k : i1 - k;
      const a = Math.max(i0, i - 1);
      const b = Math.min(i1, i + 1);
      let nx = -(sy(b, sd) - sy(a, sd));
      let ny = sx(b, sd) - sx(a, sd);
      const l = Math.hypot(nx, ny) || 1;
      const h = (pass === 0 ? 1 : -1) * hw(i);
      nx = (nx / l) * h;
      ny = (ny / l) * h;
      if (k === 0 && pass === 0) ctx.moveTo(sx(i, sd) + nx, sy(i, sd) + ny);
      else ctx.lineTo(sx(i, sd) + nx, sy(i, sd) + ny);
    }
  }
  ctx.closePath();
}

// trail colours (r,g,b) along their age bands
const WASH = ['234,244,247'];
const WASH_EDGE = ['214,232,238'];
const FOAM = ['236,244,247'];
const VAPOUR = ['252,253,253'];
const SMOKE_YOUNG = ['246,242,230'];
const SMOKE_OLD = ['214,212,206'];

/** The newest point index with an age of at most `ms` (the band edges), at least k0. */
function ageIndex(e: Emitter, now: number, ms: number, k0: number): number {
  let k = k0;
  while (k < e.n - 1 && now - e.t[e.at(k + 1)] <= ms) k++;
  return k;
}

/** How long a trail's points last (ms), from the motion of the unit it follows. */
function lifeOf(e: Emitter): number {
  const m = e.motion;
  if (e.kind === WAKE) return Math.max(1500 * (m?.wakeLength ?? 1), 1900 * (m?.foamLife ?? 1));
  if (e.kind === CONTRAIL) return 2800 * (m?.contrailLife ?? 1);
  return 1500 * (m?.missileTrailLife ?? 1);
}

// ------------------------------------------------------------------------------------------------- the layer

class RealisticTrails implements TrailLayer {
  private ems = new Map<number, Emitter>();
  private frameNo = 0;

  constructor(private readonly wakes: boolean) {}

  clear(): void {
    this.ems.clear();
  }

  frame(ctx: CanvasRenderingContext2D, units: readonly TrailUnit[], view: TrailView): void {
    this.frameNo++;
    const now = view.now;
    for (const u of units) {
      const cat = unitCategoryOf(u.key);
      const kind = cat === 'ships' ? WAKE : cat === 'missiles' ? MISSILE : CONTRAIL;
      if (this.wakes !== (kind === WAKE)) continue;
      if (!view.full && kind !== MISSILE) continue;
      let e = this.ems.get(u.id);
      if (!e || e.kind !== kind) this.ems.set(u.id, (e = new Emitter(kind, u.key)));
      e.key = u.key;
      e.seen = this.frameNo;
      e.motion = u.motion;
      e.hv = false;
      if (kind === WAKE && (!u.moving || u.speed <= 0.01)) continue;
      const g = geomOf(u.key);
      const back = (g.back * view.scale) / view.zoom;
      const c = Math.cos(u.angle);
      const s = Math.sin(u.angle);
      const x = u.tx - c * back;
      const y = u.ty - s * back;
      e.hx = x;
      e.hy = y;
      e.ha = u.angle;
      e.hs = Math.max(0.2, u.speed);
      e.hv = true;
      const spacing = Math.max(0.04, (kind === MISSILE ? 2.5 : kind === WAKE ? 3 : 4) / view.zoom);
      if (e.n > 0) {
        const i = e.at(0);
        const d = Math.hypot(x - e.x[i], y - e.y[i]);
        if (d > 8 || now < e.t[i]) e.n = 0;
        else if (d < spacing && now - e.t[i] < 160) continue;
      }
      e.push(x, y, u.angle, now, Math.max(0.2, u.speed));
    }
    for (const [id, e] of this.ems) {
      const life = lifeOf(e);
      e.trim(now, life);
      if (e.n === 0 && this.frameNo - e.seen > 30) {
        this.ems.delete(id);
        continue;
      }
      if (e.n < 2) continue;
      // off screen: the newest and oldest points both well outside the view
      const i0 = e.at(0);
      const i1 = e.at(e.n - 1);
      const m = 120;
      const ax = view.ox + e.x[i0] * view.zoom;
      const ay = view.oy + e.y[i0] * view.zoom;
      const bx = view.ox + e.x[i1] * view.zoom;
      const by = view.oy + e.y[i1] * view.zoom;
      if ((ax < -m && bx < -m) || (ay < -m && by < -m) || (ax > view.viewW + m && bx > view.viewW + m) || (ay > view.viewH + m && by > view.viewH + m)) continue;
      if (e.kind === WAKE) this.drawWake(ctx, e, view, life);
      else if (e.kind === CONTRAIL) this.drawContrail(ctx, e, view, life);
      else this.drawMissile(ctx, e, view, life);
    }
    if (this.wakes && view.full) for (const u of units) if (unitCategoryOf(u.key) === 'ships' && u.moving && u.speed > 0.05) bowWave(ctx, u, view);
    ctx.globalAlpha = 1;
  }

  private drawWake(ctx: CanvasRenderingContext2D, e: Emitter, v: TrailView, life: number): void {
    void life;
    const m = e.motion;
    const sub = e.key === 'submarine';
    const g = geomOf(e.key);
    const k = v.scale;
    const beam = (g.beam * k) / v.zoom;
    const hullT = (modelOf(e.key, 0).len * k) / v.zoom;
    const sp = e.hv ? e.hs : e.s[e.at(0)];
    const strength = Math.min(1, 0.45 + sp / 4) * (sub ? 0.5 : 1);
    const near = k >= 2;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    // ---- the churned water: a ribbon from the stern, its edge ragged (each point its own width), soft where it starts,
    // spreading and settling; close up broken by spray along its first third and turbulent patches further back
    const washLife = 1900 * (m?.foamLife ?? 1);
    const stride = near ? 1 : 2;
    let n = gather(e, v, { side: 0, grow: 0, spread: 0, drift: 0, rise: 0, wave: 0, life: washLife, maxDist: hullT * 6, stride });
    if (n >= 2) {
      const z = v.zoom;
      const w0 = beam * (sub ? 0.28 : 0.42) * z;
      const w1 = beam * (sub ? 0.5 : 0.75) * z;
      const hw = (i: number): number => (w0 + (w1 - w0) * SQ[i]) * (0.78 + 0.44 * SR[i]);
      const core = strength * (sub ? 0.26 : 0.4);
      if (near) {
        ctx.beginPath();
        ribbonPath(ctx, 0, n - 1, 0, (i) => hw(i) * 1.5);
        ctx.fillStyle = gradAlong(ctx, 0, n - 1, WASH_EDGE[0], [0, 0.06, 0.4, 1], [0, strength * 0.1, strength * 0.05, 0]);
        ctx.fill();
      }
      ctx.beginPath();
      ribbonPath(ctx, 0, n - 1, 0, hw);
      ctx.fillStyle = gradAlong(ctx, 0, n - 1, WASH[0], [0, 0.05, 0.18, 0.5, 1], [core * 0.25, core * 0.8, core * 0.45, core * 0.14, 0]);
      ctx.fill();
      if (!sub) {
        // the foam itself: spray lumps along the first third, off both edges and across (uneven: a broken, foaming
        // strip), then fewer, fainter turbulent patches settling further back
        let c = 0;
        const cap = near ? 12 : 0;
        for (let i = 1; i < n && c < cap; i++) {
          const q = SQ[i];
          if (q > 0.85) break;
          if (SR[i] < (q < 0.33 ? 0.25 : 0.6)) continue;
          const off = (SR[i] * 2 - 1) * hw(i) * (q < 0.33 ? 0.85 : 0.6);
          const fade = q < 0.33 ? 0.2 * (1 - q * 1.2) : 0.1 * (1 - q);
          puff(ctx, Puff.SPRAY, i, SX[i] + NX[i] * off, SY[i] + NY[i] * off, hw(i) * (0.6 + 0.9 * SR[i] * SR[i]), fade * strength);
          c++;
        }
      }
    }
    // ---- the Kelvin arms: a few hull lengths long (by distance), opening at their fixed angle; a narrow bright core
    // breaking into dashes and foam as it ages over a faint wide band; on a turn they fade and break up
    const wl = m?.wakeLength ?? 1;
    // (a little shorter and fainter at mid zoom, where a whole fleet's wakes share the screen)
    // (never longer than about 70 art units, so a carrier's arms do not run across a whole fleet)
    const maxDist = Math.min(hullT * (2.2 + 1.0 * Math.min(1, sp / 3)) * (0.8 + 0.2 * wl), (70 * k) / v.zoom) * (near ? 1 : 0.8);
    const kel = 0.35 * (m?.wakeSpread ?? 1);
    n = gather(e, v, { side: beam * 0.9, grow: kel, spread: 0, drift: 0, rise: 0, wave: 0, life: 4000 * wl, maxDist, stride });
    // (cut where the ship had turned well away: older foam from round a bend is left to the wash)
    let turn = 0;
    for (let i = 0; i < n; i++) {
      if (ST[i] > 0.9) {
        n = i;
        break;
      }
      turn = Math.max(turn, ST[i]);
    }
    if (n >= 2) {
      const qd = (i: number): number => Math.min(1, SD[i] / maxDist);
      const a0 = strength * (sub ? 0.25 : 0.5) * (near ? 1 : 0.65);
      // the foam wanders a little off the ideal line, more as it ages (a slow noise along the arm)
      for (let i = 1; i < n; i++) OF[i] += Math.sin(AT[i] * 0.017 + 0.7) * k * 0.9 * qd(i);
      const calm = Math.max(0, 1 - turn / 0.5);
      // the faint wide band under it (straight runs only: on a turn it would draw an arc; close up only)
      if (calm > 0.05 && near) {
        ctx.beginPath();
        for (const sd of [-1, 1]) {
          ctx.moveTo(sx(0, sd), sy(0, sd));
          for (let i = 1; i < n; i++) ctx.lineTo(sx(i, sd), sy(i, sd));
        }
        ctx.lineWidth = Math.max(2, k * 2.4);
        ctx.strokeStyle = gradAlong(ctx, 0, n - 1, FOAM[0], [0, 0.4, 1], [a0 * 0.16 * calm, a0 * 0.09 * calm, 0], SD, maxDist);
        ctx.stroke();
      }
      // the arm itself: whole for a moment at the stern, then broken into dashes of uneven length (a slow noise along
      // the arm, so the gaps grow as the foam ages and more open on a turn), wider and fainter when older; on a turn it
      // fades out (the curve of an arm is the arc the brief bans)
      const lit = (i: number): boolean => {
        const t = AT[i] * 0.011;
        const nz = 0.5 + 0.3 * Math.sin(t) + 0.2 * Math.sin(t * 2.7 + 1.3);
        return qd(i) < 0.1 || nz > 0.3 + 0.45 * qd(i) + 0.5 * Math.min(1, ST[i] / 0.4);
      };
      // (mid zoom: one stroke for the whole arm, fading to nothing at its end)
      let iy = near ? 0 : n - 1;
      if (near) while (iy < n - 1 && qd(iy) < 0.4) iy++;
      for (const [i0, i1, w, al0, al1] of [
        [0, iy, Math.max(0.8, k * 0.42), a0 * (0.15 + 0.75 * calm), near ? a0 * 0.4 * calm : 0],
        [iy, n - 1, Math.max(1.1, k * 0.8), a0 * 0.3 * calm, 0],
      ] as const) {
        if (i1 <= i0 || al0 < 0.01) continue;
        ctx.beginPath();
        for (const sd of [-1, 1]) {
          let on = false;
          for (let i = i0; i <= i1; i++) {
            if (lit(i) && i < i1) {
              if (!on) ctx.moveTo(sx(i, sd), sy(i, sd));
              ctx.lineTo(sx(i + 1, sd), sy(i + 1, sd));
              on = true;
            } else on = false;
          }
        }
        ctx.lineWidth = w;
        ctx.strokeStyle = gradAlong(ctx, i0, i1, FOAM[0], [0, 1], [al0, al1]);
        ctx.stroke();
      }
      // close up the arms break into foam: spray puffs jittered along them, growing and fading
      if (near && !sub) {
        for (const sd of [-1, 1]) {
          let c = 0;
          for (let i = 1; i < n && c < 6; i++) {
            if (SR[i] < 0.55) continue;
            const q = qd(i);
            const j = (SR[i] * 2 - 1) * k * (0.6 + 1.6 * q);
            const tw = Math.max(0, 1 - ST[i] / 0.7);
            puff(ctx, Puff.SPRAY, i + (sd > 0 ? 2 : 0), sx(i, sd) + NX[i] * j * sd, sy(i, sd) + NY[i] * j * sd, k * (0.7 + 2.2 * q) * (0.7 + 0.6 * SR[i]), a0 * 0.26 * Math.pow(1 - q, 1.4) * tw);
            c++;
          }
        }
      }
    }
    // churning foam boiling up at the stern while under way
    if (near && e.hv && !sub) {
      const x = v.ox + e.hx * v.zoom;
      const y = v.oy + e.hy * v.zoom;
      const r = beam * v.zoom * 0.9;
      for (let j = 0; j < 2; j++) {
        const ph = (v.now / 420 + j * 0.5) % 1;
        puff(ctx, Puff.SPRAY, j + 2, x - Math.cos(e.ha) * r * ph * 1.6, y - Math.sin(e.ha) * r * ph * 1.6, r * (0.7 + ph * 0.5), 0.3 * (1 - ph) * strength);
      }
    }
    ctx.lineCap = 'butt';
    ctx.globalAlpha = 1;
  }

  private drawContrail(ctx: CanvasRenderingContext2D, e: Emitter, v: TrailView, life: number): void {
    const g = geomOf(e.key);
    const k = v.scale;
    const a2t = k / v.zoom;
    // vapour from the engines (or the wing tips) a few px behind them: a narrow core over a wide faint band, growing
    // from 1 to 4 times its width with age, drifting with the wind, spreading apart and wavering a little
    const n = gather(e, v, { side: g.side * a2t, grow: 0, spread: 0.9 * a2t, drift: 0.3, rise: 0, wave: 0.7 * a2t, phase: e.key.length, life, maxDist: 1e9, stride: k >= 2 ? 1 : 2 });
    if (n < 2) return;
    const gap = (2.5 + k) / v.zoom;
    let i0 = 0;
    while (i0 < n - 2 && SD[i0] < gap) i0++;
    const w0 = Math.max(0.55, k * 0.4);
    const hw = (i: number): number => w0 * (1 + 3 * SQ[i]);
    // (the wide faint band close up; at mid zoom the vapour is a few px wide and its core alone reads as vapour)
    if (k >= 2) {
      ctx.beginPath();
      for (const sd of [-1, 1]) ribbonPath(ctx, i0, n - 1, sd, (i) => hw(i) * 2.6);
      ctx.fillStyle = gradAlong(ctx, i0, n - 1, VAPOUR[0], [0, 0.04, 0.3, 0.7, 1], [0.06, 0.16, 0.13, 0.06, 0]);
      ctx.fill();
    }
    ctx.beginPath();
    for (const sd of [-1, 1]) ribbonPath(ctx, i0, n - 1, sd, hw);
    ctx.fillStyle = gradAlong(ctx, i0, n - 1, VAPOUR[0], [0, 0.03, 0.2, 0.6, 1], [0.4, 0.62, 0.38, 0.12, 0]);
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  private drawMissile(ctx: CanvasRenderingContext2D, e: Emitter, v: TrailView, life: number): void {
    const big = e.key === 'atomBomb';
    const k = v.scale;
    if (!v.full) {
      // far out: a soft grey line that widens and fades
      ctx.lineCap = 'butt';
      ctx.lineJoin = 'round';
      const kMid = ageIndex(e, v.now, life * 0.3, 0);
      const kEnd = ageIndex(e, v.now, life, kMid);
      if (kMid > 0) {
        ctx.strokeStyle = fadeAlong(ctx, e, v, 0.2, [0, kMid], SMOKE_YOUNG, [0.75, 0.45]);
        strokeLine(ctx, e, 0, kMid, v, 0.2, big ? 2.2 : 1.6);
      }
      if (kEnd > kMid) {
        ctx.strokeStyle = fadeAlong(ctx, e, v, 0.2, [kMid, kEnd], SMOKE_OLD, [0.45, 0]);
        strokeLine(ctx, e, kMid, kEnd, v, 0.2, big ? 3.6 : 2.6);
      }
      ctx.globalAlpha = 1;
      return;
    }
    const n = gather(e, v, { side: 0, grow: 0, spread: 0, drift: 0.35, rise: 4 * k, wave: 0, life, maxDist: 1e9 });
    if (n < 2) return;
    const size = (big ? 1.6 : 1.15) * k;
    const rad = (i: number): number => size * (0.8 + 2.8 * Math.sqrt(SQ[i]));
    // the smoke column first: a soft ribbon widening with age, its edge uneven, a wider fainter one under it (so the
    // puffs on it never read as separate beads)
    ctx.beginPath();
    ribbonPath(ctx, 0, n - 1, 0, (i) => rad(i) * (1 + 0.2 * Math.sin(AT[i] * 0.009)));
    ctx.fillStyle = gradAlong(ctx, 0, n - 1, SMOKE_OLD[0], [0, 0.04, 0.3, 0.7, 1], [0.05, 0.12, 0.09, 0.04, 0]);
    ctx.fill();
    ctx.beginPath();
    ribbonPath(ctx, 0, n - 1, 0, (i) => rad(i) * (0.6 + 0.15 * Math.sin(AT[i] * 0.013 + 1)));
    ctx.fillStyle = gradAlong(ctx, 0, n - 1, SMOKE_OLD[0], [0, 0.04, 0.3, 0.7, 1], [0.2, 0.36, 0.24, 0.08, 0]);
    ctx.fill();
    // then billowing puffs packed along it, newest last (on top): one every 0.35 to 0.5 of its radius, each its own
    // size, turn, variant and place across the column; capped in number, so a long trail ends in the ribbon alone
    let cnt = 0;
    const cap = k >= 2 ? PUFF_CAP : PUFF_CAP / 2;
    for (let i = 0; i < n - 1 && cnt < cap; i++) {
      const L = Math.hypot(SX[i + 1] - SX[i], SY[i + 1] - SY[i]);
      // (evenly within each segment between two laid points, so a puff stays where it was laid as the trail grows)
      const rm = (rad(i) + rad(i + 1)) * 0.5;
      const m = Math.max(1, Math.ceil(L / (rm * 0.45)));
      const base = Math.floor(SR[i + 1] * 99991);
      for (let j = 0; j < m && cnt < cap; j++) {
        const f = (j + 0.5) / m;
        const q = SQ[i] + (SQ[i + 1] - SQ[i]) * f;
        const seed = (base + j * 17) % 100003;
        const r = size * (0.8 + 2.8 * Math.sqrt(q)) * (0.7 + 0.6 * rnd(seed, 1));
        const off = (rnd(seed, 2) - 0.5) * r * 0.5;
        PX[cnt] = SX[i] + (SX[i + 1] - SX[i]) * f + NX[i] * off;
        PY[cnt] = SY[i] + (SY[i + 1] - SY[i]) * f + NY[i] * off;
        PR[cnt] = r;
        PQ[cnt] = q;
        PS[cnt] = seed;
        cnt++;
      }
    }
    for (let c = cnt - 1; c >= 0; c--) {
      const q = PQ[c];
      if (q >= 1) continue;
      const age = q * life;
      const a = 0.5 * (1 - q) * (1 - q) * Math.min(1, q * 30 + 0.3);
      const hot = age < 110;
      const kind = hot ? Puff.FIRE : q < 0.45 ? Puff.WHITE : Puff.GREY;
      puffTurned(ctx, kind, Math.floor(rnd(PS[c], 4) * 6), PX[c], PY[c], PR[c], hot ? a * 0.9 : a, (rnd(PS[c], 5) - 0.5) * 1.2);
    }
    ctx.globalAlpha = 1;
  }
}

/** Most puffs on one missile trail, and their scratch positions. */
const PUFF_CAP = 90;
const PX = new Float32Array(PUFF_CAP);
const PY = new Float32Array(PUFF_CAP);
const PR = new Float32Array(PUFF_CAP);
const PQ = new Float32Array(PUFF_CAP);
const PS = new Float32Array(PUFF_CAP);

/** The bow wave: white water curling off both sides of a moving bow, longer and brighter with speed. */
function bowWave(ctx: CanvasRenderingContext2D, u: TrailUnit, v: TrailView): void {
  if (u.key === 'submarine') return;
  const g = geomOf(u.key);
  const k = v.scale;
  const L = u.half;
  const b = g.beam * k;
  const c = Math.cos(u.angle);
  const s = Math.sin(u.angle);
  const strength = Math.min(1, 0.3 + u.speed / 5);
  const out = 1.15 + 0.35 * strength * (u.motion.wakeSpread ?? 1);
  const at = (fx: number, fy: number): [number, number] => [u.x + c * fx - s * fy, u.y + s * fx + c * fy];
  ctx.lineCap = 'round';
  // both sides in one path, fading from the stem aft along the hull
  const [x0, y0] = at(L * 0.9, 0);
  const [xe, ye] = at(L * 0.3, 0);
  const gr = ctx.createLinearGradient(x0, y0, xe, ye);
  gr.addColorStop(0, `rgba(246,250,252,${(0.6 * strength).toFixed(3)})`);
  gr.addColorStop(1, 'rgba(246,250,252,0)');
  ctx.strokeStyle = gr;
  ctx.beginPath();
  for (const sd of [-1, 1]) {
    const [x1, y1] = at(L * 0.62, sd * b * 1.05);
    const [x2, y2] = at(L * 0.3, sd * b * out);
    ctx.moveTo(x0, y0);
    ctx.quadraticCurveTo(x1, y1, x2, y2);
  }
  ctx.lineWidth = Math.max(0.8, k * 0.6);
  ctx.stroke();
  // close up a soft wider spray under it
  if (k >= 2) {
    ctx.lineWidth = Math.max(1.6, k * 1.6);
    ctx.globalAlpha = 0.35;
    ctx.stroke();
    ctx.globalAlpha = 1;
  }
  ctx.lineCap = 'butt';
}

export const realisticWakes: TrailArt = { createLayer: () => new RealisticTrails(true) };
export const realisticContrails: TrailArt = { createLayer: () => new RealisticTrails(false) };
