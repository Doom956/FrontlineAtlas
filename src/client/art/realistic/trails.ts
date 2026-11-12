// The realistic style's wakes and contrails (client only). Trails stay where they were laid (map tiles) and fade there.
//
// Wakes (ships): the churned white water right behind the stern turning into a pale strip as it spreads, the two arms
// of the Kelvin V running out from the stern at about 19 degrees and fading, and the bow wave curling off both sides
// of a moving bow; all sized by speed and the MotionParams (wakeLength: how long the arms last, foamLife: the white
// wash, wakeSpread: how wide the V opens). A submarine leaves a thin, faint wake and no bow wave.
// Contrails (planes): thin white vapour lines behind the engines (the wing tips for single-engine planes), starting a
// little behind the plane, widening, drifting with the wind and thinning out (contrailLife).
// Missile trails: billowing white smoke puffs from a hot exhaust, growing and drifting as they age (missileTrailLife);
// far out (TrailView.full false) a cheap soft line instead.
//
// Cheap: each trail is a short ring of points; a frame strokes or fills a handful of soft bands per trail (a few
// draw calls per ship or plane), never one call per point, and skips trails off screen.
import { unitCategoryOf, type SpriteKey } from '../shared/keys';
import type { MotionParams } from '../motion';
import type { TrailArt, TrailLayer, TrailUnit, TrailView } from '../types';
import { Puff, puff, WIND_X, WIND_Y } from './puffs';
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
  /** points held (newest at head - 1) */
  n = 0;
  head = 0;
  seen = 0;
  /** the motion of the unit the trail follows (last seen) */
  motion: MotionParams | null = null;
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
  return { back: m.len * 0.38, side, beam: 1 };
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

/**
 * Strokes points k0..k1 twice, `side` tiles to each side of the track (both lines in one path, one draw call), opening
 * by `spread` per tile travelled and drifting with the wind, with the stroke style already set.
 */
function strokePair(ctx: CanvasRenderingContext2D, e: Emitter, k0: number, k1: number, v: TrailView, side: number, spread: number, drift: number, w: number): void {
  ctx.lineWidth = w;
  ctx.beginPath();
  for (const sd of [-1, 1]) {
    screenAt(e, k0, v, sd * side, spread, drift, P0);
    ctx.moveTo(P0[0], P0[1]);
    for (let k = k0 + 1; k <= k1; k++) {
      screenAt(e, k, v, sd * side, spread, drift, P1);
      ctx.lineTo(P1[0], P1[1]);
    }
  }
  ctx.stroke();
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

// trail colours (r,g,b) along their age bands
const WASH = ['246,250,252', '234,244,247', '222,238,243', '222,238,243'];
const WASH_EDGE = ['214,232,238'];
const FOAM = ['236,244,247'];
const VAPOUR = ['252,253,253'];
const SMOKE_YOUNG = ['246,242,230'];
const SMOKE_OLD = ['214,212,206'];

/**
 * Fills a ribbon along points k0..k1 whose half width grows from h0 to h1 tiles (by age, over `life` ms), with `style`
 * (a fade along it): churned water that spreads out and settles.
 */
function ribbonFade(ctx: CanvasRenderingContext2D, e: Emitter, k0: number, k1: number, v: TrailView, h0: number, h1: number, life: number, style: CanvasGradient): void {
  const half = (k: number): number => {
    const q = Math.min(1, (v.now - e.t[e.at(k)]) / life);
    return h0 + (h1 - h0) * q;
  };
  ctx.beginPath();
  for (let k = k0; k <= k1; k++) {
    const i = e.at(k);
    const h = half(k);
    const x = v.ox + (e.x[i] - Math.sin(e.a[i]) * h) * v.zoom;
    const y = v.oy + (e.y[i] + Math.cos(e.a[i]) * h) * v.zoom;
    if (k === k0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  for (let k = k1; k >= k0; k--) {
    const i = e.at(k);
    const h = half(k);
    ctx.lineTo(v.ox + (e.x[i] + Math.sin(e.a[i]) * h) * v.zoom, v.oy + (e.y[i] - Math.cos(e.a[i]) * h) * v.zoom);
  }
  ctx.closePath();
  ctx.fillStyle = style;
  ctx.fill();
}

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
      if (kind === WAKE && (!u.moving || u.speed <= 0.01)) continue;
      const g = geomOf(u.key);
      const back = (g.back * view.scale) / view.zoom;
      const c = Math.cos(u.angle);
      const s = Math.sin(u.angle);
      const x = u.tx - c * back;
      const y = u.ty - s * back;
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
      else this.drawMissile(ctx, e, view, life, id);
    }
    if (this.wakes && view.full) for (const u of units) if (unitCategoryOf(u.key) === 'ships' && u.moving && u.speed > 0.05) bowWave(ctx, u, view);
    ctx.globalAlpha = 1;
  }

  private drawWake(ctx: CanvasRenderingContext2D, e: Emitter, v: TrailView, life: number): void {
    const m = e.motion;
    const sub = e.key === 'submarine';
    const g = geomOf(e.key);
    const beam = (g.beam * v.scale) / v.zoom;
    const spread = 0.34 * (m?.wakeSpread ?? 1);
    const armLife = 1500 * (m?.wakeLength ?? 1);
    const washLife = 1900 * (m?.foamLife ?? 1);
    const sp = e.s[e.at(0)];
    const strength = Math.min(1, 0.45 + sp / 4) * (sub ? 0.5 : 1);
    ctx.lineJoin = 'round';
    ctx.lineCap = 'butt';
    const near = v.scale >= 2;
    // the churned water: a white ribbon at the stern spreading into a pale strip and settling (one fill through its age
    // bands), with a soft wide edge close up
    const kw = [0, 0, 0, 0];
    const edges = [0, 0.18, 0.5, 1];
    for (let b = 1; b < 4; b++) kw[b] = ageIndex(e, v.now, washLife * edges[b], kw[b - 1]);
    if (kw[3] > 0) {
      const w0 = sub ? 0.28 : 0.42;
      const fade = [1, 0.67, 0.25, 0];
      const core = strength * (sub ? 0.26 : 0.42);
      if (near) ribbonFade(ctx, e, 0, kw[3], v, beam * w0 * 1.45, beam * (w0 + 0.35) * 1.3, washLife, fadeAlong(ctx, e, v, 0, kw, WASH_EDGE, fade.map((f) => strength * 0.1 * f)));
      ribbonFade(ctx, e, 0, kw[3], v, beam * w0, beam * (w0 + 0.3), washLife, fadeAlong(ctx, e, v, 0, kw, WASH, fade.map((f) => core * f)));
    }
    // the Kelvin arms: foam lines opening out from the stern and fading (both arms in one stroke; close up the older
    // half wider)
    // (bright for the first moments, then a faint line that is gone well before its end: a long wake reads as foam
    // settling, not as a drawn line)
    const k1 = ageIndex(e, v.now, armLife, 0);
    if (k1 > 0) {
      const kq = ageIndex(e, v.now, armLife * 0.15, 0);
      const kmid = ageIndex(e, v.now, armLife * 0.4, kq);
      const w = Math.max(0.7, v.scale * 0.6);
      const a0 = strength * (sub ? 0.25 : 0.6);
      const aq = a0 * 0.45;
      const am = strength * (sub ? 0.05 : 0.1);
      const off = beam * 0.9;
      if (!near || kmid <= 0 || kmid >= k1) {
        ctx.strokeStyle = kmid > 0 && kmid < k1 ? fadeAlong(ctx, e, v, 0, [0, kq, kmid, k1], FOAM, [a0, aq, am, 0]) : fadeAlong(ctx, e, v, 0, [0, k1], FOAM, [a0, 0]);
        strokePair(ctx, e, 0, k1, v, off, spread, 0, w * 1.15);
      } else {
        ctx.strokeStyle = fadeAlong(ctx, e, v, 0, [0, kq, kmid], FOAM, [a0, aq, am]);
        strokePair(ctx, e, 0, kmid, v, off, spread, 0, w);
        ctx.strokeStyle = fadeAlong(ctx, e, v, 0, [kmid, k1], FOAM, [am, 0]);
        strokePair(ctx, e, kmid, k1, v, off, spread, 0, w * 1.4);
      }
    }
    // churning foam boiling up at the stern while under way
    if (v.scale >= 2 && v.now - e.t[e.at(0)] < 300 && !sub) {
      const i = e.at(0);
      const x = v.ox + e.x[i] * v.zoom;
      const y = v.oy + e.y[i] * v.zoom;
      const r = beam * v.zoom * 0.9;
      for (let j = 0; j < 2; j++) {
        const ph = (v.now / 420 + j * 0.5) % 1;
        puff(ctx, Puff.SPRAY, j + 2, x - Math.cos(e.a[i]) * r * ph * 1.6, y - Math.sin(e.a[i]) * r * ph * 1.6, r * (0.7 + ph * 0.5), 0.3 * (1 - ph) * strength);
      }
    }
    ctx.globalAlpha = 1;
    void life;
  }

  private drawContrail(ctx: CanvasRenderingContext2D, e: Emitter, v: TrailView, life: number): void {
    const g = geomOf(e.key);
    const side = (g.side * v.scale) / v.zoom;
    const k = v.scale;
    ctx.lineCap = 'butt';
    ctx.lineJoin = 'round';
    // the vapour forms a little behind the plane, then widens, drifts with the wind, spreads apart and thins out
    const edges = [0.03, 0.14, 0.42, 1];
    const kb = [0, 0, 0, 0];
    kb[0] = ageIndex(e, v.now, life * edges[0], 0);
    for (let b = 1; b < 4; b++) kb[b] = ageIndex(e, v.now, life * edges[b], kb[b - 1]);
    // the young vapour, both lines in one stroke: fading in, then thinning
    if (kb[2] > kb[0]) {
      ctx.strokeStyle = kb[1] > kb[0] && kb[1] < kb[2] ? fadeAlong(ctx, e, v, 0.3, [kb[0], kb[1], kb[2]], VAPOUR, [0, 0.5, 0.3]) : fadeAlong(ctx, e, v, 0.3, [kb[0], kb[2]], VAPOUR, [0.25, 0.3]);
      strokePair(ctx, e, kb[0], kb[2], v, side, 0.03, 0.3, Math.max(0.7, k * 0.6));
    }
    if (kb[3] > kb[2]) {
      if (k >= 2) {
        // close up the old vapour breaks up into soft wisps drifting apart
        for (const sd of [-1, 1])
          for (let kk = kb[2]; kk <= kb[3]; kk += 3) {
            const i = e.at(kk);
            const q = Math.min(1, (v.now - e.t[i]) / life);
            screenAt(e, kk, v, sd * side, 0.05, 0.3, P0);
            puff(ctx, Puff.WHITE, (kk + sd) & 7, P0[0], P0[1], k * (1 + 2.2 * q), 0.28 * (1 - q) * (1 - q));
          }
      } else {
        // the old vapour spread into a wider, fainter haze
        ctx.strokeStyle = fadeAlong(ctx, e, v, 0.3, [kb[2], kb[3]], VAPOUR, [0.24, 0]);
        strokePair(ctx, e, kb[2], kb[3], v, side, 0.03, 0.3, Math.max(1.3, k * 1.8));
      }
    }
    ctx.globalAlpha = 1;
  }

  private drawMissile(ctx: CanvasRenderingContext2D, e: Emitter, v: TrailView, life: number, id: number): void {
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
    // billowing smoke: puffs from the oldest to the newest (the young ones over the old), at most ~32 per trail
    // (each puff at least as wide as the gap to the one before it, so a long or fast trail stays one column of smoke,
    // never a string of beads; the exhaust glows only for its first tenth of a second)
    const step = Math.max(1, Math.floor(e.n / 32));
    const size = (big ? 1.6 : 1.15) * k;
    let lx = NaN;
    let ly = NaN;
    for (let kk = e.n - 1; kk >= 0; kk -= step) {
      const i = e.at(kk);
      const age = v.now - e.t[i];
      const q = age / life;
      if (q >= 1 || q < 0) continue;
      const drift = (age / 1000) * 0.35;
      const x = v.ox + (e.x[i] + WIND_X * drift) * v.zoom;
      const y = v.oy + (e.y[i] + WIND_Y * drift) * v.zoom - age * 0.004 * k;
      const gap = lx === lx ? Math.hypot(x - lx, y - ly) : 0;
      lx = x;
      ly = y;
      const r = Math.max(size * (0.9 + 3.2 * Math.sqrt(q)), Math.min(gap * 0.75, size * 5));
      const a = 0.62 * (1 - q) * (1 - q) * Math.min(1, q * 30 + 0.3);
      const hot = age < 110;
      puff(ctx, hot ? Puff.FIRE : q < 0.5 ? Puff.WHITE : Puff.GREY, (i + id) % 6, x, y, r, hot ? a * 0.9 : a);
    }
    ctx.globalAlpha = 1;
  }
}

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
