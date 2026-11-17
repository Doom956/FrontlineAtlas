// The detailed style's silo rocket and atom bomb in flight (client only): the arc of art/shared/ballistic.ts drawn
// with the models of missiles.ts. The sim's flight is untouched; everything here is drawn from the BallisticDraw clock
// and the missile's id, so every frame (and every client) shows the same flight.
//   arc        the missile is lifted off its ground point by the arc's height and grows a little toward the apex (a
//              finer bake, never a stretched image); its nose points along the drawn path and the body shortens as it
//              points at the viewer (baked foreshortened along its length, five steps); its shadow lies on the true
//              ground path, short when the missile stands up, fainter the higher it is, and meets it again at impact
//   launch     smoke and dust boil out round the silo and spread low over the ground, a white flash at ignition and
//              the motor's light on the ground while the missile is still low
//   staging    the atom bomb: each stage burns out and parts with a small puff and a faint condensation ring, the
//              spent stage tumbles away and falls back with a short smoke trail and its own shadow, kicking up a small
//              dust puff where it lands (no damage: nothing here touches the game); the next motor lights with a flash.
//              The third stage burns out near the apex and coasts over it; on the way down the reentry vehicle parts
//              from it and dives on the target with a hot glow at its nose and a thin bright streak behind it
//   rocket     one stage: it burns out near the apex, then coasts down nose first with a faint trail (the trail layer)
//              and a small reentry glow before impact
// Reduce motion: the arc and the staging stay (they are the flight), with no flashes, no tumbling and no rings.
// Zoom: drawn from the sprite zoom in (render/units.ts); the small extras (cloud, rings, stage smoke, the streak) for
// the first EXTRAS_CAP missiles of a frame only.
import type { MotionParams } from '../motion';
import { canBake, SpriteAtlas, type AtlasEntry } from '../shared/atlas';
import { arcPose, ballisticPhase, flashAlpha, ICBM, separations, stageFall, type ArcPose, type BallisticKind, type BallisticPhase } from '../shared/ballistic';
import type { BallisticDraw, BallisticExhaust } from '../types';
import { partBox, rasterize, shadowOf, type Model, type Part } from './bake';
import { drawBlob, type BlobKind } from './blobs';
import { facingIndex, facingsFor, gridOf, type Grid } from './grid';
import { atomBombModel, rocketModel } from './missiles';
import { grown } from './shapes';
import { outlineOf, ringWidth } from './outline';
import { FIRE } from './palette';

// ------------------------------------------------------------------------------------------------- the models

/** How much of its length a body shows, baked in these steps (1 = seen side on). */
export const FORE_STEPS = [0.4, 0.55, 0.7, 0.85, 1] as const;
/** Fewer steps for a tumbling spent stage (it turns too fast to need more). */
const TUMBLE_STEPS = [0, 2, 4] as const;
/** Where the atom bomb's stages part (model u): stage 1 below CUT[1], stage 2 up to CUT[2], stage 3 up to CUT[3], the
 * reentry vehicle above. */
export const CUT = [-Infinity, 2.2, 8.2, 9.8] as const;

const minU = (p: Part): number => partBox(p)[0];

/** Parts with every u multiplied by `r` (shortened along the length) and moved by `du`. */
function alongU(parts: readonly Part[], r: number, du = 0): Part[] {
  const U = (u: number): number => (u + du) * r;
  return parts.map((p) => {
    const q = p.p.slice();
    if (p.k === 'poly') for (let i = 0; i < q.length; i += 2) q[i] = U(q[i]);
    else if (p.k === 'ell') {
      q[0] = U(q[0]);
      q[2] = Math.max(0.3, q[2] * r);
    } else {
      q[0] = U(q[0]);
      q[2] = U(q[2]);
    }
    const sc = p.sc && ([U(p.sc[0]), p.sc[1], Math.max(0.3, p.sc[2] * r), p.sc[3]] as const);
    return { ...p, p: q, sc };
  });
}

let atomParts: readonly Part[] | null = null;
let rocketParts: readonly Part[] | null = null;
const atom = (): readonly Part[] => (atomParts ??= atomBombModel().model.parts);
const rocket = (): readonly Part[] => (rocketParts ??= rocketModel().model.parts);

/** The atom bomb's third stage and reentry vehicle are drawn this much bigger once alone (round UPPER_MID), so the
 * small upper stack still reads high on its arc. */
export const UPPER_GROW = 1.3;
const UPPER_MID = 10.8;
const upper = (parts: readonly Part[]): Part[] => alongU(grown(alongU(parts, 1, -UPPER_MID), UPPER_GROW), 1, UPPER_MID);
/** Model u of a point of the upper stack as drawn (UPPER_GROW). */
const upperU = (u: number): number => UPPER_MID + (u - UPPER_MID) * UPPER_GROW;

const bodies: (readonly Part[] | undefined)[] = [];
/** The flying body's parts: the rocket whole; the atom bomb whole (0), then without each stage it dropped (1..3). */
export function bodyParts(kind: BallisticKind, body: number): readonly Part[] {
  if (kind === 'rocket') return rocket();
  const k = Math.max(0, Math.min(3, body));
  let b = bodies[k];
  if (!b) {
    const own = atom().filter((p) => minU(p) >= CUT[k] - 1e-6);
    bodies[k] = b = k >= 2 ? upper(own) : own;
  }
  return b;
}

/** A spent stage of the atom bomb (1..3) as it parted: its parts, centred on its own middle, and where that was (u). */
export function stageParts(stage: number): { parts: Part[]; mid: number } {
  let c = stageCache[stage];
  if (!c) stageCache[stage] = c = makeStage(stage);
  return c;
}
const stageCache: ({ parts: Part[]; mid: number } | undefined)[] = [];
function makeStage(stage: number): { parts: Part[]; mid: number } {
  const lo = CUT[stage - 1];
  const hi = CUT[stage];
  const raw = atom().filter((p) => minU(p) >= lo - 1e-6 && minU(p) < hi - 1e-6);
  const own = stage === 3 ? upper(raw) : raw;
  let a = Infinity;
  let b = -Infinity;
  for (const p of own) {
    const [u0, , u1] = partBox(p);
    a = Math.min(a, u0);
    b = Math.max(b, u1);
  }
  const mid = (a + b) / 2;
  return { parts: alongU(own, 1, -mid), mid };
}

/** The tail (motor) and the nose of a flying body (model u). */
function ends(kind: BallisticKind, body: number): readonly [number, number] {
  const k = kind === 'rocket' ? 0 : body + 1;
  let e = endsCache[k];
  if (!e) {
    let a = Infinity;
    let b = -Infinity;
    for (const p of bodyParts(kind, body)) {
      const [u0, , u1] = partBox(p);
      a = Math.min(a, u0);
      b = Math.max(b, u1);
    }
    endsCache[k] = e = [a, b];
  }
  return e;
}
const endsCache: (readonly [number, number])[] = [];

/** How long the stack left after a separation takes to settle with its own middle on the arc (ms). */
const SETTLE_MS = 500;
/**
 * Where the drawn body's origin sits along it (model u) at flight fraction f: the whole missile is drawn round its own
 * origin; once a stage has dropped, the rest slides back over a moment until its own middle rides the arc, so the
 * small reentry vehicle lands on the target, not ahead of it.
 */
export function bodyShift(kind: BallisticKind, body: number, f: number, totalMs: number): number {
  if (kind === 'rocket' || body <= 0) return 0;
  const from = separations(kind)[body - 1];
  const [a, b] = ends(kind, body);
  const t = Math.max(0, Math.min(1, ((f - from) * totalMs) / SETTLE_MS));
  return -((a + b) / 2) * t * t * (3 - 2 * t);
}

const models = new Map<string, Model>();
function modelOf(id: string, make: () => Part[]): Model {
  let m = models.get(id);
  if (!m) models.set(id, (m = { parts: make(), flat: true }));
  return m;
}
const bodyModel = (kind: BallisticKind, body: number, step: number): Model => modelOf(`${kind}|${body}|${step}`, () => alongU(bodyParts(kind, body), FORE_STEPS[step]));
const stageModel = (stage: number, step: number): Model => modelOf(`s${stage}|${step}`, () => alongU(stageParts(stage).parts, FORE_STEPS[step]));

/** The step of FORE_STEPS nearest `fore`. */
export function foreStep(fore: number): number {
  let best = 0;
  for (let i = 1; i < FORE_STEPS.length; i++) if (Math.abs(FORE_STEPS[i] - fore) < Math.abs(FORE_STEPS[best] - fore)) best = i;
  return best;
}

// ------------------------------------------------------------------------------------------------- baking

const atlas = new SpriteAtlas(1024, 4);
const ownerKey = (o: readonly number[]): number => ((o[0] & 255) << 16) | ((o[1] & 255) << 8) | (o[2] & 255);
const BODY = 0;
const SHADOW = 1;
const PLAIN = 2;

function baked(id: string, model: () => Model, facing: number, n: number, res: number, owner: readonly number[], layer: number, ring: number): AtlasEntry | null {
  const key = `${id}|${facing}|${n}|${Math.round(res * 4)}|${layer === SHADOW ? 0 : ownerKey(owner)}|${layer}|${ring}`;
  const hit = atlas.peek(key);
  if (hit !== undefined) return hit;
  if (!canBake()) return null;
  return atlas.get(key, () => {
    const b = rasterize(model(), res, facing, { facings: n, owner: layer === SHADOW ? [0, 0, 0] : owner });
    return layer === SHADOW ? shadowOf(b, 0.3) : layer === BODY ? outlineOf(b, owner, ring) : b;
  });
}

function blit(ctx: CanvasRenderingContext2D, e: AtlasEntry, x: number, y: number, g: Grid): void {
  ctx.drawImage(e.page, e.sx, e.sy, e.w, e.h, Math.round(x * g.dpr) / g.dpr - e.ox * g.k, Math.round(y * g.dpr) / g.dpr - e.oy * g.k, e.w * g.k, e.h * g.k);
}

/** One square cell of colour on the grid (CSS px centre, `size` cells wide). */
function cell(ctx: CanvasRenderingContext2D, x: number, y: number, g: Grid, size = 1): void {
  const s = g.p * size;
  const h = size > 1 ? Math.floor(s / 2) : 0;
  ctx.fillRect((Math.round((x * g.dpr) / g.p) * g.p - h) / g.dpr, (Math.round((y * g.dpr) / g.p) * g.p - h) / g.dpr, s / g.dpr, s / g.dpr);
}

/** A puff `r` CSS px in radius. */
function puff(ctx: CanvasRenderingContext2D, kind: BlobKind, r: number, v: number, x: number, y: number, g: Grid, a: number, heat = 0): void {
  drawBlob(ctx, kind, r / g.k, v & 3, x, y, g, a, heat);
}

// ------------------------------------------------------------------------------------------------- per frame

/** Missiles per frame that get the small extras (launch cloud, rings, stage smoke, the reentry streak). */
export const EXTRAS_CAP = 10;
let frameAt = -1;
let extras = 0;
/** The last body drawn for each missile (shown again for a frame when this frame's bakes are spent). */
const lastBody = new Map<number, AtlasEntry>();

const rnd = (a: number, b: number): number => {
  const s = Math.sin(a * 127.1 + b * 311.7) * 43758.5453;
  return s - Math.floor(s);
};
const easeOut = (t: number): number => 1 - (1 - t) * (1 - t);
const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

interface Frame {
  f: number;
  total: number;
  g: Grid;
  /** the bake resolution (a little finer near the apex) and screen px per model unit */
  res: number;
  unit: number;
  n: number;
  pose: ArcPose;
  ph: BallisticPhase;
  /** the sprite's heading as baked (radians) and its foreshortening step */
  th: number;
  step: number;
  /** the body's origin on screen (CSS px): the arc point, moved along the body by bodyShift */
  bx: number;
  by: number;
}

const POSE: ArcPose = { x: 0, y: 0, gx: 0, gy: 0, lift: 0, angle: 0, fore: 1, pitch: 0, high: 0 };
const SEP: ArcPose = { x: 0, y: 0, gx: 0, gy: 0, lift: 0, angle: 0, fore: 1, pitch: 0, high: 0 };
const OLD: ArcPose = { x: 0, y: 0, gx: 0, gy: 0, lift: 0, angle: 0, fore: 1, pitch: 0, high: 0 };
const PH: BallisticPhase = { body: 0, burn: 0, smoke: 0, heat: 0, name: 'boost' };
const FR: Frame = { f: 0, total: 1, g: { p: 1, res: 1, k: 1, dpr: 1 }, res: 1, unit: 1, n: 16, pose: POSE, ph: PH, th: 0, step: 4, bx: 0, by: 0 };

/** A little bigger toward the apex: a finer bake on the same pixel grid (never a stretched image). */
export function grownRes(g: Grid, high: number): number {
  return Math.max(g.res, Math.round(g.res * (1 + 0.3 * high) * 4) / 4);
}

function frameOf(b: BallisticDraw): Frame {
  const g = gridOf(b.scale, b.dpr);
  const total = Math.max(1, b.elapsedMs + b.leftMs);
  const f = clamp01(b.elapsedMs / total);
  const pose = arcPose(b.sx, b.sy, b.tx, b.ty, b.dist, b.zoom, f, POSE);
  ballisticPhase(b.kind, f, PH);
  const res = grownRes(g, pose.high);
  const n = facingsFor(res);
  const facing = facingIndex(pose.angle, n);
  FR.f = f;
  FR.total = total;
  FR.g = g;
  FR.res = res;
  FR.unit = res * g.k;
  FR.n = n;
  FR.pose = pose;
  FR.ph = PH;
  FR.th = facing * ((Math.PI * 2) / n);
  FR.step = foreStep(pose.fore);
  const sh = bodyShift(b.kind, PH.body, f, total) * FR.unit * FORE_STEPS[FR.step];
  FR.bx = pose.x + Math.cos(FR.th) * sh;
  FR.by = pose.y + Math.sin(FR.th) * sh;
  return FR;
}

/** The motor's mouth on screen (CSS px) for frame `F`. */
function nozzleOf(kind: BallisticKind, F: Frame): [number, number] {
  const back = ends(kind, F.ph.body)[0] * F.unit * FORE_STEPS[F.step];
  return [F.bx + Math.cos(F.th) * back, F.by + Math.sin(F.th) * back];
}

/** Where the trail layer lays this missile's smoke now (see the file comment): the motor's mouth while it burns. */
export function ballisticExhaust(b: BallisticDraw, _m: MotionParams, out: BallisticExhaust): BallisticExhaust {
  const F = frameOf(b);
  const [x, y] = nozzleOf(b.kind, F);
  out.x = x;
  out.y = y;
  out.angle = F.th;
  out.smoke = F.ph.smoke;
  return out;
}

/**
 * ENTRY: draws one silo rocket or atom bomb in flight (see the file comment). False when its body could not be drawn
 * this frame and none was drawn before (no canvas, or this frame's bakes are spent).
 */
export function drawBallistic(ctx: CanvasRenderingContext2D, b: BallisticDraw, m: MotionParams): boolean {
  if (b.timeMs !== frameAt) {
    frameAt = b.timeMs;
    extras = 0;
    if (lastBody.size > 256) lastBody.clear();
  }
  const rich = extras++ < EXTRAS_CAP;
  const F = frameOf(b);
  const { g, pose, ph, total, f } = F;
  const S = b.scale;
  const still = m.reduced;
  const e = b.elapsedMs;
  const seen = b.seen ?? ((): boolean => true);
  const prevA = ctx.globalAlpha;
  const prevS = ctx.imageSmoothingEnabled;
  ctx.imageSmoothingEnabled = false;
  const A = prevA * b.alpha;
  ctx.globalAlpha = A;
  const ring = ringWidth(g.k);
  const atomic = b.kind === 'atomBomb';

  // ---- the launch: smoke and dust boiling out round the silo, spreading low; a flash at ignition
  const siloSeen = seen(b.sx, b.sy);
  if (siloSeen) {
    const cloudMs = (atomic ? 2800 : 1900) * (still ? 0.7 : 1);
    if (e < cloudMs && rich) {
      const t = e / cloudMs;
      const N = atomic ? 12 : 8;
      const reach = (atomic ? 22 : 14) * S;
      for (let i = 0; i < N; i++) {
        const r1 = rnd(b.seed, i);
        const r2 = rnd(b.seed + 3.1, i);
        const ang = b.seed * 1.7 + (i / N) * Math.PI * 2 + (r1 - 0.5) * 0.6;
        const d = (1.2 * S + reach * easeOut(t)) * (0.6 + 0.55 * r2);
        const x = b.sx + Math.cos(ang) * d;
        const y = b.sy + Math.sin(ang) * d * 0.5 - t * (1 + 2 * r1) * S;
        const r = ((atomic ? 3 : 2.2) + (atomic ? 6.5 : 4.4) * easeOut(t)) * S * (0.75 + 0.5 * r1);
        const a = (1 - t) ** 1.3 * (0.6 + 0.3 * r2) * Math.min(1, e / 120 + 0.35);
        puff(ctx, i % 3 === 0 ? 'smoke' : i % 3 === 1 ? 'dust' : 'roll', r, i, x, y, g, a);
      }
      // the column boiling up off the pad under the climbing missile
      for (let i = 0; i < 3; i++) {
        const q = (t * 2 + i / 3) % 1;
        const x = b.sx + (rnd(b.seed, 20 + i) - 0.5) * 3 * S;
        const y = b.sy - q * (atomic ? 14 : 9) * S;
        puff(ctx, 'vapour', (2.2 + 3.6 * q) * S, i + 2, x, y, g, (1 - q) * (1 - t) * 0.65);
      }
    }
    const fl = flashAlpha(e, 260, still);
    if (fl > 0) puff(ctx, 'flash', (atomic ? 6 : 4.5) * S * (0.6 + 0.4 * fl), 0, b.sx, b.sy - S, g, fl * 0.9);
  }

  // ---- what the atom bomb dropped: spent stages tumbling down, separation puffs and rings
  if (atomic) {
    const seps = separations('atomBomb');
    for (let j = 0; j < seps.length; j++) {
      const fs = seps[j];
      if (f < fs) break;
      const age = (f - fs) * total;
      spentStage(ctx, b, F, j, fs, age, rich, still, seen, A);
    }
  }

  // ---- the missile's shadow on the ground path: short when it stands up, fainter the higher it is
  const gh = Math.atan2(b.ty - b.sy, b.tx - b.sx);
  const sn = F.n;
  const sStep = foreStep(Math.max(0.4, Math.cos(pose.pitch)));
  const shadow = baked(`${b.kind}|${ph.body}|${sStep}`, () => bodyModel(b.kind, ph.body, sStep), facingIndex(gh, sn), sn, g.res, b.owner, SHADOW, 0);
  if (shadow) {
    const off = Math.min(1, pose.lift / (6 * S)) * 1.4 * S;
    ctx.globalAlpha = A * (1 - 0.6 * pose.high);
    blit(ctx, shadow, pose.gx + off, pose.gy + off * 0.7, g);
    ctx.globalAlpha = A;
  }
  // the motor lights the ground while the missile is still low
  if (ph.burn && pose.lift < 12 * S && siloSeen) puff(ctx, 'glow', (atomic ? 7 : 5) * S, 1, pose.gx, pose.gy, g, 0.55 * (1 - pose.lift / (12 * S)));

  // ---- the reentry streak: a thin bright line along the drawn path behind the diving nose
  if (ph.heat > 0.02 && rich) streak(ctx, b, F, A);

  // ---- the motor's flame, then the body
  const [nx, ny] = nozzleOf(b.kind, F);
  if (ph.burn) flame(ctx, b, F, nx, ny, still, A);
  const step = F.step;
  const facing = facingIndex(F.th, F.n);
  const body = baked(`${b.kind}|${ph.body}|${step}`, () => bodyModel(b.kind, ph.body, step), facing, F.n, F.res, b.owner, BODY, ring) ?? lastBody.get(b.seed) ?? null;
  if (!body) {
    ctx.globalAlpha = prevA;
    ctx.imageSmoothingEnabled = prevS;
    return false;
  }
  lastBody.set(b.seed, body);
  blit(ctx, body, F.bx, F.by, g);

  // ---- the next stage's motor lighting: a short flash at its mouth
  if (atomic && !still && (ph.burn === 2 || ph.burn === 3)) {
    const fs = ph.burn === 2 ? ICBM.stage1 : ICBM.stage2;
    const fl = flashAlpha((f - fs) * total, 170, still);
    if (fl > 0) puff(ctx, 'flash', 3.2 * S * (0.6 + 0.4 * fl), 1, nx, ny, g, fl);
  }

  // ---- reentry heat: the nose glowing orange to white
  if (ph.heat > 0.02) {
    const nose = ends(b.kind, ph.body)[1] * F.unit * FORE_STEPS[step] * 0.92;
    const hx = F.bx + Math.cos(F.th) * nose;
    const hy = F.by + Math.sin(F.th) * nose;
    const h = ph.heat;
    const flick = still ? 0 : (Math.floor(b.timeMs / Math.max(30, m.flameMs) + b.seed) & 1) * 0.12;
    puff(ctx, 'halo', (3 + (atomic ? 7 : 5) * h) * S, 2, hx, hy, g, Math.min(1, 0.5 + 0.6 * h) * (1 - flick));
    // the hot shock layer wrapping the nose and streaming back a little along the body
    puff(ctx, 'fire', (1.2 + (atomic ? 2.2 : 1.5) * h) * S, 3, hx - Math.cos(F.th) * 1.2 * S, hy - Math.sin(F.th) * 1.2 * S, g, 0.5 + 0.4 * h, h > 0.6 ? 1 : 2);
    puff(ctx, 'fire', (1 + (atomic ? 1.8 : 1.2) * h) * S, 1, hx, hy, g, 0.7 + 0.3 * h, h > 0.6 ? 0 : 1);
    if (!still) puff(ctx, 'flash', (1.4 + 2 * h) * S, 0, hx, hy, g, 0.35 * h * (1 - flick));
    ctx.fillStyle = h > 0.5 ? '#fff6e0' : FIRE[1];
    ctx.globalAlpha = A * Math.min(1, 0.5 + h);
    cell(ctx, hx, hy, g, Math.max(1, Math.round(g.res * 0.9)));
    ctx.globalAlpha = A;
  }
  ctx.globalAlpha = prevA;
  ctx.imageSmoothingEnabled = prevS;
  return true;
}

/** The motor's flame from its mouth back along the body: white-hot root, yellow, orange and a ragged red tip. */
function flame(ctx: CanvasRenderingContext2D, b: BallisticDraw, F: Frame, nx: number, ny: number, still: boolean, A: number): void {
  const g = F.g;
  const flick = still ? 0 : Math.floor(b.timeMs / 70 + b.seed) & 3;
  const r = b.kind === 'rocket' ? 1.5 : F.ph.burn === 1 ? 1.8 : F.ph.burn === 2 ? 1.45 : 1.1;
  const fore = Math.max(0.55, FORE_STEPS[F.step]);
  const len = (r * 3.4 + (flick & 1 ? 1.2 : 0) + (flick === 3 ? 0.8 : 0)) * F.res * fore;
  const steps = Math.max(2, Math.round(len));
  const c = Math.cos(F.th);
  const s = Math.sin(F.th);
  for (let i = steps; i >= 0; i--) {
    const q = i / steps;
    const d = (i / F.res) * F.unit;
    const wob = (flick & 2 ? 0.3 : -0.3) * q * F.unit;
    ctx.globalAlpha = A * (1 - q * 0.35);
    ctx.fillStyle = q < 0.2 ? '#fff6e0' : FIRE[Math.min(6, 1 + Math.floor(q * 4.5))];
    cell(ctx, nx - c * d - s * wob, ny - s * d + c * wob, g, Math.max(1, Math.round((1 - q * 0.7) * r * 2 * F.res * 0.8)));
  }
  ctx.globalAlpha = A;
}

/** The thin bright streak behind a diving nose: the drawn path a moment back, white at the head fading to red. */
function streak(ctx: CanvasRenderingContext2D, b: BallisticDraw, F: Frame, A: number): void {
  const g = F.g;
  const h = F.ph.heat;
  const back = Math.min(80, F.total * 0.014);
  const SAMPLES = 8;
  const cellPx = g.p / g.dpr;
  // from the body's tail back along the drawn path (each point moved by the same offset)
  const tail = ends(b.kind, F.ph.body)[0] * F.unit * FORE_STEPS[F.step];
  const ox = F.bx + Math.cos(F.th) * tail - F.pose.x;
  const oy = F.by + Math.sin(F.th) * tail - F.pose.y;
  let px = F.pose.x + ox;
  let py = F.pose.y + oy;
  let drawn = 0;
  for (let i = 1; i <= SAMPLES && drawn < 120; i++) {
    const fo = F.f - (i * back) / F.total;
    if (fo <= 0) break;
    arcPose(b.sx, b.sy, b.tx, b.ty, b.dist, b.zoom, fo, OLD);
    const dx = OLD.x + ox - px;
    const dy = OLD.y + oy - py;
    const L = Math.hypot(dx, dy);
    const k = Math.max(1, Math.ceil(L / cellPx));
    for (let j = 0; j < k && drawn < 120; j++, drawn++) {
      const q = (i - 1 + j / k) / SAMPLES;
      ctx.globalAlpha = A * (1 - q) * (0.35 + 0.6 * h);
      ctx.fillStyle = q < 0.18 ? '#fff6e0' : q < 0.45 ? FIRE[1] : q < 0.75 ? FIRE[2] : FIRE[4];
      cell(ctx, px + (dx * j) / k, py + (dy * j) / k, g, 1);
    }
    px = OLD.x + ox;
    py = OLD.y + oy;
  }
  ctx.globalAlpha = A;
}

/**
 * The j-th thing the atom bomb dropped (0 the first stage, 1 the second, 2 the third stage as the reentry vehicle
 * parts from it), `age` ms after it parted at flight fraction fs.
 */
function spentStage(ctx: CanvasRenderingContext2D, b: BallisticDraw, F: Frame, j: number, fs: number, age: number, rich: boolean, still: boolean, seen: (x: number, y: number) => boolean, A: number): void {
  const g = F.g;
  const S = b.scale;
  const stage = j + 1;
  const sp = arcPose(b.sx, b.sy, b.tx, b.ty, b.dist, b.zoom, fs, SEP);
  const fall = stageFall(age, F.total, still, b.seed * 0.37 + j);
  const ux = Math.cos(sp.angle);
  const uy = Math.sin(sp.angle);
  const dirG = Math.atan2(b.ty - b.sy, b.tx - b.sx);
  const gux = Math.cos(dirG);
  const guy = Math.sin(dirG);
  // where it parted: the joint between the stages, and the spent stage's middle (screen px)
  const res = grownRes(g, sp.high);
  const unit = res * g.k;
  const shift = bodyShift('atomBomb', j, fs, F.total);
  const joint = ((stage === 3 ? upperU(CUT[3]) : CUT[stage]) + shift) * unit * sp.fore;
  const jx = sp.x + ux * joint;
  const jy = sp.y + uy * joint;
  const mid = (stageParts(stage).mid + shift) * unit * sp.fore;
  const cx0 = sp.x + ux * mid;
  const cy0 = sp.y + uy * mid;
  // it drifts on a little along the ground (the bus after the reentry vehicle more) and drops back to earth
  const dist = (j === 2 ? 0.06 : 0.025) * b.dist * b.zoom;
  const at = (t: number): [number, number, number, number] => {
    const dr = dist * (1 - Math.exp(-t * 2.2));
    const gx = sp.gx + gux * dr;
    const gy = sp.gy + guy * dr;
    return [gx + (cx0 - sp.gx) * (1 - t), gy + (cy0 - sp.gy) * (1 - t * t), gx, gy];
  };
  const [x, y, gx, gy] = at(fall.t);
  if (!seen(gx, gy)) return;
  // the separation: a puff where the stages part and a condensation ring round the joint (over the spent stage)
  const separation = (): void => {
    if (age < 1100 && rich) {
      const t = age / 1100;
      puff(ctx, 'vapour', (3 + 5 * easeOut(t)) * S, j, jx - ux * t * 2 * S, jy - uy * t * 2 * S + t * S, g, (1 - t) ** 0.7 * 0.95);
      if (!still && j < 2) {
        const R = (6 + 14 * easeOut(t)) * S;
        for (let i = 0; i < 9; i++) {
          const a = (i / 9) * Math.PI * 2 + b.seed;
          // a ring round the body's axis, seen at a slant: wide across the axis, narrow along it
          const rx = -uy * Math.cos(a) * R + ux * Math.sin(a) * R * 0.32;
          const ry = ux * Math.cos(a) * R * 0.8 + uy * Math.sin(a) * R * 0.32;
          puff(ctx, 'vapour', (2 + 1.6 * t) * S, i, jx + rx, jy + ry, g, (1 - t) ** 0.7 * 0.85);
        }
      }
    }
  };
  if (fall.t >= 1) {
    // on the ground: a small dust puff where it came down (nothing is hit)
    const da = age - fall.fallMs;
    if (da < 900 && rich) {
      const t = da / 900;
      for (let i = 0; i < 3; i++) puff(ctx, i === 1 ? 'smoke' : 'dust', (1.2 + 2.6 * easeOut(t)) * S * (0.8 + 0.3 * i), i + j, gx + (i - 1) * 2 * S * (0.4 + t), gy - t * 1.5 * S - i * 0.4 * S, g, (1 - t) * 0.7);
    }
    separation();
    return;
  }
  // its short smoke trail (the first and second stages still smoulder)
  if (j < 2 && rich) {
    for (let k = 1; k <= 3; k++) {
      const tk = fall.t - (k * 120) / fall.fallMs;
      if (tk < 0) break;
      const [px, py] = at(tk);
      puff(ctx, 'smoke', (1 + 0.6 * k) * S, k + j, px, py, g, (1 - fall.t) * (0.5 - k * 0.12));
    }
  }
  // its shadow on the ground, darker as it comes down
  const n = 16;
  const th = sp.angle + fall.spin;
  const step = still ? foreStep(sp.fore) : TUMBLE_STEPS[Math.min(2, Math.floor(Math.abs(Math.cos(fall.spin * 0.8)) * 2.999))];
  const facing = facingIndex(th, n);
  const sh = baked(`s${stage}|${step}`, () => stageModel(stage, step), facing, n, res, b.owner, SHADOW, 0);
  if (sh) {
    ctx.globalAlpha = A * fall.alpha * (0.3 + 0.6 * fall.t);
    blit(ctx, sh, gx, gy, g);
  }
  const body = baked(`s${stage}|${step}`, () => stageModel(stage, step), facing, n, res, b.owner, PLAIN, 0);
  if (body) {
    ctx.globalAlpha = A * fall.alpha;
    blit(ctx, body, x, y, g);
  }
  ctx.globalAlpha = A;
  separation();
}
