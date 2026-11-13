// The art lab's scenes (art lab builds only): one small live scene per category, drawn with the REAL style modules
// (art/<style>/index.ts) through the same interface the game uses (art/types.ts), so what the lab shows is what the
// map will show. Every scene is a pure function of the lab clock, the zoom, the style and the motion numbers, plus
// the cell's own trail layers (wakes and contrails stay where they were laid, like on the map).
// No module-level side effects (a normal build drops all of this).
import type { ArtCategory, ArtStyle, MotionCategory } from '../art/artStyle';
import type { MotionParams } from '../art/motion';
import { ALL_MODS, unitCategoryOf, type SpriteKey } from '../art/shared/keys';
import { CRATER_ATOM_REACH, type BlastKind, type MapFxKind, type ParachuteMarkDraw, type ParadropDraw, type StyleModule, type TrailLayer, type TrailUnit, type TrailView, type UnitDraw } from '../art/types';
import { FX_INFO } from '../fx/map';
import { css, type RGB } from '../render/common';
import { troopKinds, troopPill } from '../render/troopIcons';
import { spriteScale } from '../render/units';
import { backdrop, type Ground } from './backdrop';

export type RowId = 'ships' | 'land' | 'air' | 'missiles' | 'troopIcons' | 'explosions' | 'craters' | 'cannonFire' | 'paradrop';

/** What a scene draws with, this frame. */
export interface SceneEnv {
  ctx: CanvasRenderingContext2D;
  /** the cell's size (CSS px) */
  w: number;
  h: number;
  style: StyleModule;
  styleId: ArtStyle;
  /** the row's motion preset as numbers */
  motion: MotionParams;
  /** the lab clock (ms; stands still while paused) */
  time: number;
  /** camera zoom (screen px per tile) and the map's pixel size at it */
  zoom: number;
  scale: number;
  dpr: number;
  /** the cell's trail layers, kept between frames */
  trails: Map<string, TrailLayer>;
  /** draws a troop pill with this cell's troop icon style (the pills themselves are shared) */
  pill: (draw: () => void) => void;
}

export interface RowSpec {
  id: RowId;
  title: string;
  /** one plain sentence under the title */
  note: string;
  /** the category a cell's "Pick" button sets */
  pick: ArtCategory;
  /** other categories drawn in this row, in the cell's style (named next to the button) */
  also: ArtCategory[];
  /** the motion category the row's motion picker stands for (null: troop icons do not move) */
  motion: MotionCategory | null;
  /** the cell height (CSS px) at a zoom */
  height(zoom: number): number;
  draw(env: SceneEnv): void;
}

/** The lab's zooms: close (3 screen px per art pixel in the pixel styles), near (2) and the middle zoom (1). */
export const CLOSE_ZOOM = 26;
export const NEAR_ZOOM = 14;
export const MID_ZOOM = 6;
/** Effects keep the near zoom when the units are seen close (a blast or a crater would not fit its cell). */
const fxZoom = (z: number): number => Math.min(z, NEAR_ZOOM);
const px = (z: number): number => spriteScale(z);

const OWNER: RGB = [64, 160, 255];
const OWNERS: RGB[] = [
  [64, 160, 255],
  [226, 74, 60],
  [92, 178, 84],
  [236, 196, 64],
  [152, 104, 220],
  [232, 232, 228],
  [44, 46, 56],
];

// ------------------------------------------------------------------------------------------------- helpers

function ground(env: SceneEnv, kind: Ground, x = 0, y = 0, w = env.w, h = env.h, zoom = env.zoom): void {
  env.ctx.drawImage(backdrop(kind, w, h, zoom), Math.round(x), Math.round(y));
}

/** A plain-words label on a small dark plate, its left edge (or centre, or right edge) at x, its middle at y. */
export function label(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, align: 'left' | 'center' | 'right' = 'left', small = false): void {
  ctx.font = `${small ? 500 : 600} ${small ? 10 : 11}px "DM Sans", system-ui, sans-serif`;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  const tw = Math.ceil(ctx.measureText(text).width);
  const w = tw + 10;
  const h = small ? 15 : 17;
  const x0 = Math.round(align === 'center' ? x - w / 2 : align === 'right' ? x - w : x);
  const y0 = Math.round(y - h / 2);
  const prev = ctx.globalAlpha;
  ctx.globalAlpha = 1;
  ctx.fillStyle = 'rgba(10,14,20,0.78)';
  ctx.beginPath();
  ctx.roundRect(x0, y0, w, h, 4);
  ctx.fill();
  ctx.fillStyle = '#edeff3';
  ctx.fillText(text, x0 + 5, y0 + h / 2 + 0.5);
  ctx.globalAlpha = prev;
}

const unitArgs: UnitDraw = { key: 'warship', mods: 0, owner: OWNER, x: 0, y: 0, angle: 0, zoom: 1, scale: 1, lod: 'mid', dpr: 1, timeMs: 0, turnRate: 0, speed: 0, moving: false, seed: 0, alpha: 1, shadow: true, damage: 0 };

/** One unit through the cell's style, as the map draws it; `damage` 0 = full health .. 1 = about to sink (UnitDraw.damage). */
function drawUnit(env: SceneEnv, key: SpriteKey, mods: number, x: number, y: number, angle: number, turnRate: number, speed: number, seed: number, zoom = env.zoom, owner: RGB = OWNER, damage = 0): void {
  const u = unitArgs;
  const scale = spriteScale(zoom);
  u.key = key;
  u.mods = mods;
  u.owner = owner;
  u.x = x;
  u.y = y;
  u.angle = angle;
  u.zoom = zoom;
  u.scale = scale;
  u.lod = scale >= 2 ? 'near' : 'mid';
  u.dpr = env.dpr;
  u.timeMs = env.time;
  u.turnRate = turnRate;
  u.speed = speed;
  u.moving = speed > 0;
  u.seed = seed;
  u.alpha = 1;
  u.shadow = true;
  u.damage = damage;
  env.style[unitCategoryOf(key)].drawUnit(env.ctx, u, env.motion);
}

function unitLength(env: SceneEnv, key: SpriteKey, zoom = env.zoom): number {
  return env.style[unitCategoryOf(key)].lengthPx(key, 0, spriteScale(zoom));
}

function trailLayer(env: SceneEnv, cat: 'wakes' | 'contrails'): TrailLayer {
  let l = env.trails.get(cat);
  if (!l) env.trails.set(cat, (l = env.style[cat].createLayer()));
  return l;
}

function trailView(env: SceneEnv): TrailView {
  return { ox: 0, oy: 0, zoom: env.zoom, scale: env.scale, now: env.time, viewW: env.w, viewH: env.h, dpr: env.dpr, full: true };
}

interface Pose {
  x: number;
  y: number;
  angle: number;
  /** rad/s at the lab clock's speed of travel */
  turn: number;
}

/**
 * A point `s` px along a stadium track (a lap: east along the top, a right-hand U-turn, west along the bottom, a
 * right-hand U-turn back), the straights from x0 to x1, the turns of radius r round (x1, yc) and (x0, yc).
 */
function stadium(s: number, x0: number, x1: number, yc: number, r: number, speedPx: number): Pose {
  const L = Math.max(1, x1 - x0);
  const arc = Math.PI * r;
  const P = 2 * L + 2 * arc;
  let d = ((s % P) + P) % P;
  if (d < L) return { x: x0 + d, y: yc - r, angle: 0, turn: 0 };
  d -= L;
  if (d < arc) {
    const a = d / r;
    return { x: x1 + Math.sin(a) * r, y: yc - Math.cos(a) * r, angle: a, turn: speedPx / r };
  }
  d -= arc;
  if (d < L) return { x: x1 - d, y: yc + r, angle: Math.PI, turn: 0 };
  d -= L;
  const a = d / r;
  return { x: x0 - Math.sin(a) * r, y: yc + Math.cos(a) * r, angle: Math.PI + a, turn: speedPx / r };
}

function stadiumLength(x0: number, x1: number, r: number): number {
  return 2 * Math.max(1, x1 - x0) + 2 * Math.PI * r;
}

/** A figure eight across a lane (planes turn both ways, so they bank both ways): phase `p` in radians. */
function eight(p: number, cx: number, cy: number, A: number, B: number, omega: number): Pose {
  const pose = (q: number): [number, number, number] => {
    const x = cx + A * Math.sin(q);
    const y = cy + B * Math.sin(2 * q);
    return [x, y, Math.atan2(2 * B * Math.cos(2 * q), A * Math.cos(q))];
  };
  const [x, y, a] = pose(p);
  const [, , a2] = pose(p + 0.01);
  let da = a2 - a;
  while (da > Math.PI) da -= 2 * Math.PI;
  while (da < -Math.PI) da += 2 * Math.PI;
  return { x, y, angle: a, turn: (da / 0.01) * omega };
}

function rnd(seed: number, i: number): number {
  const v = Math.sin(seed * 91.17 + i * 12.9898) * 43758.5453;
  return v - Math.floor(v);
}

// ------------------------------------------------------------------------------------------------- units

const SHIPS: { key: SpriteKey; name: string }[] = [
  { key: 'warship', name: 'Warship (before an arsenal pick)' },
  { key: 'destroyer', name: 'Destroyer' },
  { key: 'battleship', name: 'Battleship' },
  { key: 'submarine', name: 'Submarine' },
  { key: 'carrier', name: 'Carrier' },
  { key: 'transport', name: 'Transport (landing craft)' },
  { key: 'tradeShip', name: 'Trade ship' },
];
const TANKS: { key: SpriteKey; name: string }[] = [
  { key: 'tankDivision', name: 'Tank division' },
  { key: 'lightTank', name: 'Light tank' },
  { key: 'heavyTank', name: 'Heavy tank' },
];
const PLANES: { key: SpriteKey; name: string }[] = [
  { key: 'bomber', name: 'Bomber' },
  { key: 'groundAttack', name: 'Ground attack' },
  { key: 'heavyBomber', name: 'Heavy bomber' },
  { key: 'fighter', name: 'Fighter' },
  { key: 'transportPlane', name: 'Transport plane' },
  { key: 'reconPlane', name: 'Recon plane' },
];

/** Lanes of units going round stadium tracks, the plain unit and the upgraded one half a lap apart. */
function laneScene(env: SceneEnv, list: { key: SpriteKey; name: string }[], laneH: number, top: number, tilesPerSec: number, wakes: boolean): void {
  const { ctx } = env;
  const speedPx = tilesPerSec * env.zoom;
  // keep the longest unit inside the cell in the U-turns
  const margin = Math.max(34, Math.max(...list.map((it) => unitLength(env, it.key))) / 2 + 8);
  const trailUnits: TrailUnit[] = [];
  const poses: { key: SpriteKey; mods: number; p: Pose; seed: number }[] = [];
  list.forEach((it, i) => {
    const yc = top + laneH * i + laneH / 2 + 4;
    const r = laneH * 0.32;
    const x0 = margin + r;
    const x1 = env.w - margin - r;
    const P = stadiumLength(x0, x1, r);
    for (const [k, mods] of [
      [0, 0],
      [1, ALL_MODS],
    ] as const) {
      const s = (env.time / 1000) * speedPx + k * (P / 2) + i * 37;
      const p = stadium(s, x0, x1, yc, r, speedPx);
      const seed = i * 2 + k + 1;
      poses.push({ key: it.key, mods, p, seed });
      trailUnits.push({ id: seed, key: it.key, x: p.x, y: p.y, tx: p.x / env.zoom, ty: p.y / env.zoom, angle: p.angle, half: unitLength(env, it.key) / 2, moving: true, speed: tilesPerSec, turnRate: p.turn, motion: env.motion });
    }
  });
  // the names inside each track, under the units (nothing drives through the middle of a lap)
  list.forEach((it, i) => label(ctx, it.name, env.w / 2, top + laneH * i + laneH / 2 + 4, 'center', true));
  if (wakes) trailLayer(env, 'wakes').frame(ctx, trailUnits, trailView(env));
  for (const q of poses) drawUnit(env, q.key, q.mods, q.p.x, q.p.y, q.p.angle, q.p.turn, tilesPerSec, q.seed);
}

const shipLane = (z: number): number => 18 + 33 * px(z);
const tankLane = (z: number): number => 24 + 30 * px(z);
const planeLane = (z: number): number => 24 + 34 * px(z);

/** The damaged warships under the lanes: the same hull at three levels of damage, so the smoke and fire can be compared. */
const DAMAGED: { key: SpriteKey; damage: number }[] = [
  { key: 'battleship', damage: 0.3 },
  { key: 'battleship', damage: 0.6 },
  { key: 'battleship', damage: 0.9 },
];
/** Height of the damaged line: the hull, room for its smoke drifting off, and the labels under it. */
const damagedBand = (z: number): number => 40 + 30 * px(z);

function shipsScene(env: SceneEnv): void {
  ground(env, 'sea');
  const laneH = shipLane(env.zoom);
  laneScene(env, SHIPS, laneH, 2, 2.4, true);
  // a short line of damaged warships lying still, under the lanes
  const top = 2 + SHIPS.length * laneH;
  const band = damagedBand(env.zoom);
  const cy = top + band * 0.5;
  const cw = env.w / DAMAGED.length;
  env.ctx.fillStyle = 'rgba(10,14,20,0.35)';
  env.ctx.fillRect(0, Math.round(top), env.w, 1);
  label(env.ctx, 'Damaged warships', 6, top + 10, 'left', true);
  DAMAGED.forEach((d, i) => {
    const x = cw * i + cw / 2;
    drawUnit(env, d.key, 0, x, cy, 0, 0, 0, 40 + i, env.zoom, OWNER, d.damage);
    label(env.ctx, `Damaged (${Math.round(d.damage * 100)}%)`, x, top + band - 9, 'center', true);
  });
}

function landScene(env: SceneEnv): void {
  ground(env, 'land');
  laneScene(env, TANKS, tankLane(env.zoom), 2, 1.2, false);
}

function airScene(env: SceneEnv): void {
  ground(env, 'split');
  const { ctx } = env;
  const laneH = planeLane(env.zoom);
  const tilesPerSec = 4.5;
  const units: TrailUnit[] = [];
  const poses: { key: SpriteKey; mods: number; p: Pose; seed: number }[] = [];
  PLANES.forEach((it, i) => {
    const cy = 2 + laneH * i + laneH / 2 + 6;
    const A = env.w / 2 - Math.max(44, unitLength(env, it.key) / 2 + 10);
    const B = laneH * 0.26;
    // about tilesPerSec along the path on average (the eight is about 4 A long)
    const omega = (tilesPerSec * env.zoom) / (4 * A * 1.05);
    for (const [k, mods] of [
      [0, 0],
      [1, ALL_MODS],
    ] as const) {
      const p = eight((env.time / 1000) * omega + k * (Math.PI / 2) + i * 0.7, env.w / 2, cy, A, B, omega);
      const seed = 100 + i * 2 + k;
      poses.push({ key: it.key, mods, p, seed });
      units.push({ id: seed, key: it.key, x: p.x, y: p.y, tx: p.x / env.zoom, ty: p.y / env.zoom, angle: p.angle, half: unitLength(env, it.key) / 2, moving: true, speed: tilesPerSec, turnRate: p.turn, motion: env.motion });
    }
  });
  PLANES.forEach((it, i) => label(ctx, it.name, 8, 2 + laneH * i + 10, 'left', true));
  trailLayer(env, 'contrails').frame(ctx, units, trailView(env));
  for (const q of poses) drawUnit(env, q.key, q.mods, q.p.x, q.p.y, q.p.angle, q.p.turn, tilesPerSec, q.seed);
}

function missilesScene(env: SceneEnv): void {
  ground(env, 'split');
  const { ctx } = env;
  const laneH = env.h / 2;
  const flight = 2600;
  const period = 3800;
  const units: TrailUnit[] = [];
  const poses: { key: SpriteKey; x: number; y: number; angle: number; seed: number; speed: number }[] = [];
  (['rocket', 'atomBomb'] as const).forEach((key, i) => {
    const t = env.time + i * 1300;
    const n = Math.floor(t / period);
    const q = (t - n * period) / flight;
    if (q > 1) return;
    const x0 = 30;
    const x1 = env.w - 30;
    const base = laneH * i + laneH * 0.8;
    const H = laneH * 0.55;
    const x = x0 + (x1 - x0) * q;
    const y = base - H * Math.sin(Math.PI * q);
    const angle = Math.atan2(-H * Math.PI * Math.cos(Math.PI * q), x1 - x0);
    const speed = (x1 - x0) / (flight / 1000) / env.zoom;
    const seed = 1000 + i * 100000 + n;
    poses.push({ key, x, y, angle, seed, speed });
    units.push({ id: seed, key, x, y, tx: x / env.zoom, ty: y / env.zoom, angle, half: unitLength(env, key) / 2, moving: true, speed, turnRate: 0, motion: env.motion });
  });
  label(ctx, 'Rocket', 8, 12, 'left', true);
  label(ctx, 'Atom bomb', 8, laneH + 12, 'left', true);
  trailLayer(env, 'contrails').frame(ctx, units, trailView(env));
  for (const p of poses) drawUnit(env, p.key, 0, p.x, p.y, p.angle, 0, p.speed, p.seed);
}

// ------------------------------------------------------------------------------------------------- troop icons

function troopScene(env: SceneEnv): void {
  ground(env, 'land');
  const { ctx } = env;
  const icons = env.style.troopIcons;
  const kinds = ['infantry', 'armor', 'artillery', 'troops'] as const;
  const names = ['Infantry', 'Armor', 'Artillery', 'Unknown mix'];
  const colW = Math.min(64, (env.w - 24) / 8);
  const x0 = 12;
  const y0 = 34;
  const rowH = 24;
  kinds.forEach((k, i) => label(ctx, names[i], x0 + i * colW + 9, 14, 'center', true));
  label(ctx, 'Small (transports)', x0 + 4 * colW + colW * 1.6, 14, 'center', true);
  OWNERS.forEach((c, r) => {
    kinds.forEach((k, i) => {
      icons.draw(ctx, k, x0 + i * colW, y0 + r * rowH, c, 16);
      icons.draw(ctx, k, x0 + (4 + i) * colW, y0 + r * rowH + 2, c, 12);
    });
  });
  // the pills that carry them (shared layout, this cell's icons): your push, an attack on you, a transport
  const py = y0 + OWNERS.length * rowH + 16;
  const cw = (env.w - 2 * x0) / 3;
  const cx = (i: number): number => x0 + cw * i + cw / 2;
  env.pill(() => {
    troopPill(ctx, cx(0), py, 12400, ['infantry', 'armor', 'artillery'], OWNERS[0], { edge: '#ffe98a', arrow: 'up' });
    troopPill(ctx, cx(1), py, 8100, troopKinds(null), OWNERS[1], { edge: '#ff6b5e', arrow: 'down', alarm: true });
    troopPill(ctx, cx(2), py, 2300, ['armor', 'infantry'], OWNERS[2], { edge: '#ffe98a', arrow: 'none', small: true });
  });
  label(ctx, 'Your push', cx(0), py + 24, 'center', true);
  label(ctx, 'Attack on you', cx(1), py + 24, 'center', true);
  label(ctx, 'On a transport', cx(2), py + 24, 'center', true);
}

// ------------------------------------------------------------------------------------------------- explosions

interface Burst {
  kind: BlastKind;
  dx: number;
  dy: number;
  delay: number;
}
interface BlastCell {
  name: string;
  ground: Ground;
  bursts: Burst[];
  rt?: number;
  fx?: MapFxKind;
  /** zoom of this cell when it is not the lab's (the atom bomb is seen from further out) */
  zoom?: number;
}

const BLAST_CELLS: BlastCell[] = [
  { name: 'Shell', ground: 'land', bursts: [{ kind: 'shell', dx: 0, dy: 0, delay: 0 }], fx: 'dust', rt: 1.5 },
  {
    name: 'Bombs',
    ground: 'land',
    bursts: [
      { kind: 'bomb', dx: -0.9, dy: -0.4, delay: 0 },
      { kind: 'bomb', dx: 0.6, dy: 0.2, delay: 110 },
      { kind: 'bomb', dx: -0.1, dy: 0.9, delay: 220 },
    ],
  },
  { name: 'Missile', ground: 'land', bursts: [{ kind: 'missile', dx: 0, dy: 0, delay: 0 }], rt: 7 },
  { name: 'Plane shot down', ground: 'land', bursts: [{ kind: 'air', dx: 0, dy: 0, delay: 0 }], fx: 'smoke' },
  { name: 'Ship hit', ground: 'sea', bursts: [{ kind: 'hit', dx: 0, dy: 0, delay: 0 }], fx: 'splash' },
  { name: 'Water splash', ground: 'sea', bursts: [{ kind: 'splash', dx: 0, dy: 0, delay: 0 }] },
  {
    name: 'Flak',
    ground: 'land',
    bursts: [
      { kind: 'flak', dx: -0.8, dy: -0.5, delay: 0 },
      { kind: 'flak', dx: 0.7, dy: -0.1, delay: 140 },
      { kind: 'flak', dx: 0, dy: 0.7, delay: 280 },
    ],
  },
  { name: 'Fort hit', ground: 'land', bursts: [{ kind: 'hit', dx: 0, dy: 0, delay: 0 }], fx: 'fortDust' },
];
const ATOM_CELL: BlastCell = { name: 'Atom bomb (seen from further out)', ground: 'land', bursts: [{ kind: 'atom', dx: 0, dy: 0, delay: 0 }], rt: 35, zoom: 3 };

function blastCell(env: SceneEnv, c: BlastCell, x: number, y: number, w: number, h: number, cy: number, n: number): void {
  const { ctx } = env;
  const zoom = c.zoom ?? fxZoom(env.zoom);
  const scale = spriteScale(zoom);
  ground(env, c.ground, x, y, w, h, zoom);
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
  const art = env.style.explosions;
  const m = env.motion;
  const last = Math.max(...c.bursts.map((b) => art.durationMs(b.kind, m) + b.delay), c.fx ? FX_INFO[c.fx].dur : 0);
  const period = last + (c.zoom ? 500 : 350);
  const t = (env.time + n * 377) % period;
  const loop = Math.floor((env.time + n * 377) / period);
  const X = x + w / 2;
  const Y = y + cy;
  if (c.fx && t < FX_INFO[c.fx].dur) art.drawMapFx(ctx, { kind: c.fx, x: X, y: Y, t: t / FX_INFO[c.fx].dur, zoom, seed: rnd(loop, n), rt: c.rt ?? 0, dpr: env.dpr }, m);
  for (const b of c.bursts) {
    const dur = art.durationMs(b.kind, m);
    const age = t - b.delay;
    if (age < 0 || age > dur) continue;
    art.draw(ctx, { kind: b.kind, x: X + b.dx * zoom, y: Y + b.dy * zoom, t: age / dur, ageMs: age, durMs: dur, zoom, scale, rt: c.rt ?? 0, seed: rnd(loop * 7 + n, b.delay), reduced: false, dpr: env.dpr }, m);
  }
  ctx.globalAlpha = 1;
  ctx.restore();
  label(ctx, c.name, x + 4, y + 10, 'left', true);
}

const blastRow = (z: number): number => 62 + 34 * px(fxZoom(z));

function explosionsScene(env: SceneEnv): void {
  const cols = 4;
  const cw = env.w / cols;
  const ch = blastRow(env.zoom);
  BLAST_CELLS.forEach((c, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    blastCell(env, c, Math.round(col * cw), row * ch, Math.round((col + 1) * cw) - Math.round(col * cw), ch, ch * 0.62, i);
  });
  blastCell(env, ATOM_CELL, 0, 2 * ch, env.w, env.h - 2 * ch, (env.h - 2 * ch) * 0.7, 9);
  // thin seams between the sub-cells
  env.ctx.fillStyle = 'rgba(10,14,20,0.6)';
  for (let col = 1; col < cols; col++) env.ctx.fillRect(Math.round(col * cw), 0, 1, 2 * ch);
  env.ctx.fillRect(0, ch, env.w, 1);
  env.ctx.fillRect(0, 2 * ch, env.w, 1);
}

// ------------------------------------------------------------------------------------------------- craters

const CRATER_ROWS: { name: string; r: number; zoom?: number; atom?: boolean }[] = [
  { name: 'Shell', r: 0.5 },
  { name: 'Bomb', r: 0.9 },
  { name: 'Missile', r: 2.1 },
  { name: 'Atom bomb (seen from further out)', r: 11.2, zoom: 3, atom: true },
];
/** The atom bomb's row (its mark is the map's: crater radius 11.2 tiles of a 35 tile blast, fx/pixelFx.ts). */
const ATOM_ROW = CRATER_ROWS[CRATER_ROWS.length - 1];
/** The band under the rows where the atom bomb's whole mark plays out, its blast zone included (CRATER_ATOM_REACH). */
const atomBand = (): number => Math.round(ATOM_ROW.r * (ATOM_ROW.zoom ?? 3) * CRATER_ATOM_REACH * 2 + 26);
const CRATER_AGES: { name: string; q: number | null }[] = [
  { name: 'Fresh', q: 0.04 },
  { name: 'Older', q: 0.45 },
  { name: 'Fading', q: 0.72 },
  { name: 'Almost gone', q: 0.9 },
  { name: 'Whole life', q: null },
];

/** Height of a crater row: room for the crater and its scorched ring. */
const craterRow = (r: number, zoom: number): number => Math.max(40, Math.round(r * zoom * 2.6 + 14));
const craterZoom = (row: { zoom?: number }, z: number): number => row.zoom ?? fxZoom(z);

function cratersScene(env: SceneEnv): void {
  ground(env, 'land');
  const { ctx } = env;
  const cw = env.w / CRATER_AGES.length;
  let y = 22;
  CRATER_AGES.forEach((a, i) => label(ctx, a.name, cw * i + cw / 2, 11, 'center', true));
  const life = 9000 * env.motion.craterLife;
  CRATER_ROWS.forEach((row, ri) => {
    const zoom = craterZoom(row, env.zoom);
    const h = craterRow(row.r, zoom);
    CRATER_AGES.forEach((a, i) => {
      const q = a.q ?? ((env.time + ri * 900) % (life + 1200)) / life;
      if (q > 1) return;
      // the atom bomb's blast zone is wider than a column: each age keeps to its own column here (the band below shows it whole)
      if (row.atom) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(Math.round(cw * i), y, Math.round(cw * (i + 1)) - Math.round(cw * i), h);
        ctx.clip();
      }
      env.style.craters.draw(ctx, { x: cw * i + cw / 2, y: y + h / 2, radiusPx: row.r * zoom, q, zoom, scale: spriteScale(zoom), seed: (ri * 5 + i) / 23, dpr: env.dpr, atom: !!row.atom }, env.motion);
      if (row.atom) {
        ctx.restore();
        ctx.globalAlpha = 1;
      }
    });
    label(ctx, row.name, 4, y + 8, 'left', true);
    y += h;
  });
  // the atom bomb's whole ground mark, blast zone and all, across the cell: fresh on the left of a wide cell, its whole life
  const zoom = craterZoom(ATOM_ROW, env.zoom);
  const band = atomBand();
  const R = ATOM_ROW.r * zoom;
  ctx.fillStyle = 'rgba(10,14,20,0.35)';
  ctx.fillRect(0, Math.round(y), env.w, 1);
  const two = env.w >= 4 * R * CRATER_ATOM_REACH;
  const spots = two ? [{ x: env.w * 0.27, q: 0.04, name: 'Fresh' }, { x: env.w * 0.73, q: null, name: 'Whole life' }] : [{ x: env.w / 2, q: null, name: 'Whole life' }];
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, y, env.w, band);
  ctx.clip();
  spots.forEach((s, i) => {
    const q = s.q ?? ((env.time + 4 * 900) % (life + 1200)) / life;
    if (q > 1) return;
    env.style.craters.draw(ctx, { x: s.x, y: y + band / 2 + 6, radiusPx: R, q, zoom, scale: spriteScale(zoom), seed: (21 + i) / 23, dpr: env.dpr, atom: true }, env.motion);
  });
  ctx.restore();
  ctx.globalAlpha = 1;
  label(ctx, 'Atom bomb blast zone (seen from further out)', 4, y + 10, 'left', true);
  for (const s of spots) label(ctx, s.name, s.x, y + band - 9, 'center', true);
}

// ------------------------------------------------------------------------------------------------- cannon fire

interface Gunner {
  key: SpriteKey;
  x: number;
  y: number;
  angle: number;
  guns: number;
  period: number;
  offset: number;
}

/** One lap of the enemy warship up the channel (ms): it starts unhurt at the bottom and is badly hurt at the top. */
const ENEMY_LAP_MS = 20000;
/** How hurt the enemy warship is at the end of its lap (UnitDraw.damage). */
const ENEMY_MAX_DAMAGE = 0.85;

/**
 * A battleship (three guns) and a destroyer (one turret, two shots) firing salvo by salvo, in turn at the coast (shells,
 * blasts, craters) and at an enemy warship sailing slowly up the channel between them and the coast: shells that hit
 * burst on its hull ('hit'), the others fall short into the water ('splash'), and it gets more hurt over its lap (0 to
 * ENEMY_MAX_DAMAGE), so its smoke and fire can be judged at every level.
 */
function cannonScene(env: SceneEnv): void {
  ground(env, 'coastRight');
  const { ctx } = env;
  const z = env.zoom;
  const g = env.scale;
  const coast = env.w * 0.72;
  const ships: Gunner[] = [
    { key: 'battleship', x: env.w * 0.3, y: env.h * 0.32, angle: -Math.PI / 2 + 0.25, guns: 3, period: 3200, offset: 0 },
    { key: 'destroyer', x: env.w * 0.42, y: env.h * 0.74, angle: -Math.PI / 2 - 0.2, guns: 2, period: 3200, offset: 1600 },
  ];
  const cannon = env.style.cannonFire;
  const blasts = env.style.explosions;
  const craters = env.style.craters;
  const m = env.motion;
  const flashMs = cannon.flashMs(m);
  const blastMs = blasts.durationMs('shell', m);
  const hitMs = blasts.durationMs('hit', m);
  const splashMs = blasts.durationMs('splash', m);
  const craterMs = 7000 * m.craterLife;
  // the enemy warship: up the channel from the bottom of the cell to the top, once a lap, heading north
  const enemyKey: SpriteKey = 'warship';
  const enemyLen = unitLength(env, enemyKey);
  const ex = env.w * 0.58;
  const ey0 = env.h - Math.max(14, enemyLen * 0.6);
  const ey1 = Math.max(14, enemyLen * 0.6);
  const lapOf = (time: number): number => Math.floor(time / ENEMY_LAP_MS);
  const enemyAt = (time: number): { x: number; y: number; f: number } => {
    const f = (((time % ENEMY_LAP_MS) + ENEMY_LAP_MS) % ENEMY_LAP_MS) / ENEMY_LAP_MS;
    return { x: ex, y: ey0 + (ey1 - ey0) * f, f };
  };
  const enemySpeed = Math.abs(ey0 - ey1) / (ENEMY_LAP_MS / 1000) / z;
  const enemyNow = enemyAt(env.time);
  const damage = ENEMY_MAX_DAMAGE * enemyNow.f;
  interface Shot {
    sx: number;
    sy: number;
    tx: number;
    ty: number;
    fire: number;
    land: number;
    gun: number;
    ship: Gunner;
    seed: number;
    /** coast: a shell blast and a crater; hit: a burst on the enemy's hull at (hx, hy) from its centre; miss: a splash */
    on: 'coast' | 'hit' | 'miss';
    hx: number;
    hy: number;
  }
  const shots: Shot[] = [];
  for (const s of ships) {
    const k = Math.floor((env.time - s.offset) / s.period);
    for (let back = 0; back <= Math.ceil(craterMs / s.period) + 1; back++) {
      const n = k - back;
      if (n < 0) continue;
      const start = n * s.period + s.offset;
      // every other salvo goes at the enemy warship
      const atShip = n % 2 === 1;
      const baseX = coast + 30 + rnd(n, s.guns) * (env.w - coast - 60);
      const baseY = s.y + (rnd(n, s.guns + 1) - 0.5) * env.h * 0.3;
      for (let i = 0; i < s.guns; i++) {
        const fire = start + i * 80;
        const seed = rnd(n, i + 9);
        const flight = (tx: number, ty: number): number => fire + 30 + 260 + Math.min(700, (Math.hypot(tx - s.x, ty - s.y) / z) * 18);
        if (!atShip) {
          const tx = baseX + (rnd(n * 3 + i, 1) - 0.5) * 1.6 * z;
          const ty = baseY + (rnd(n * 3 + i, 2) - 0.5) * 1.6 * z;
          shots.push({ sx: s.x, sy: s.y, tx, ty, fire, land: flight(tx, ty), gun: i, ship: s, seed, on: 'coast', hx: 0, hy: 0 });
          continue;
        }
        // aimed where the enemy will be when the shell lands; none while it is coming round to the start of its lap
        const e0 = enemyAt(fire);
        const land = flight(e0.x, e0.y);
        if (lapOf(fire) !== lapOf(land + Math.max(hitMs, splashMs))) continue;
        const e1 = enemyAt(land);
        const hit = i === 0 || rnd(n * 3 + i, 5) < 0.55;
        if (hit) {
          // somewhere along the hull, a little to either side of the keel
          const hx = (rnd(n * 3 + i, 6) - 0.5) * enemyLen * 0.12;
          const hy = (rnd(n * 3 + i, 7) - 0.5) * enemyLen * 0.6;
          shots.push({ sx: s.x, sy: s.y, tx: e1.x + hx, ty: e1.y + hy, fire, land, gun: i, ship: s, seed, on: 'hit', hx, hy });
        } else {
          // short of the hull, in the water on the firing ship's side
          const dx = s.x - e1.x;
          const dy = s.y - e1.y;
          const d = Math.max(1, Math.hypot(dx, dy));
          const short = (0.9 + rnd(n * 3 + i, 8) * 1.1) * z + enemyLen * 0.12;
          const side = (rnd(n * 3 + i, 9) - 0.5) * 1.4 * z;
          const tx = e1.x + (dx / d) * short - (dy / d) * side;
          const ty = e1.y + (dy / d) * short + (dx / d) * side;
          shots.push({ sx: s.x, sy: s.y, tx, ty, fire, land, gun: i, ship: s, seed, on: 'miss', hx: 0, hy: 0 });
        }
      }
    }
  }
  // craters on the ground, the enemy's wake, the ships, then shells, muzzle flashes and blasts over them
  for (const sh of shots) {
    if (sh.on !== 'coast') continue;
    const age = env.time - sh.land - 150;
    if (age < 0 || age > craterMs) continue;
    craters.draw(ctx, { x: sh.tx, y: sh.ty, radiusPx: 0.5 * z, q: age / craterMs, zoom: z, scale: g, seed: sh.seed, dpr: env.dpr }, m);
  }
  const enemyAngle = -Math.PI / 2;
  const wake: TrailUnit = { id: 900, key: enemyKey, x: enemyNow.x, y: enemyNow.y, tx: enemyNow.x / z, ty: enemyNow.y / z, angle: enemyAngle, half: enemyLen / 2, moving: true, speed: enemySpeed, turnRate: 0, motion: m };
  trailLayer(env, 'wakes').frame(ctx, [wake], trailView(env));
  label(ctx, 'Battleship', ships[0].x - 70 - 10 * env.scale, ships[0].y, 'left', true);
  label(ctx, 'Destroyer', ships[1].x - 66 - 10 * env.scale, ships[1].y, 'left', true);
  for (const s of ships) drawUnit(env, s.key, 0, s.x, s.y, s.angle, 0, 0, s.key === 'battleship' ? 1 : 2);
  drawUnit(env, enemyKey, 0, enemyNow.x, enemyNow.y, enemyAngle, 0, enemySpeed, 3, z, OWNERS[1], damage);
  // its name and how hurt it is now, beside it on the side away from the coast
  const ly = Math.min(env.h - 19, Math.max(19, enemyNow.y));
  const lx = enemyNow.x - Math.max(10, enemyLen * 0.18) - 6;
  label(ctx, 'Enemy warship', lx, ly - 9, 'right', true);
  label(ctx, `Damaged (${Math.round((damage * 100) / 5) * 5}%)`, lx, ly + 9, 'right', true);
  for (const sh of shots) {
    const t = (env.time - sh.fire - 30) / (sh.land - sh.fire - 30);
    if (t >= 0 && t <= 1) cannon.drawShell(ctx, { kind: 'cannon', x0: sh.sx, y0: sh.sy, x1: sh.tx, y1: sh.ty, t, zoom: z, scale: g, seed: sh.seed, dpr: env.dpr }, m);
  }
  for (const sh of shots) {
    const t = (env.time - sh.fire) / flashMs;
    if (t < 0 || t > 1) continue;
    const p = env.style.ships.turretPoint(sh.ship.key, 0, sh.gun, sh.ship.x, sh.ship.y, sh.ship.angle, g);
    cannon.drawMuzzle(ctx, { x: p.x, y: p.y, aim: Math.atan2(sh.ty - p.y, sh.tx - p.x), t, zoom: z, scale: g, seed: sh.seed, dpr: env.dpr }, m);
  }
  for (const sh of shots) {
    const kind: BlastKind = sh.on === 'coast' ? 'shell' : sh.on === 'hit' ? 'hit' : 'splash';
    const dur = sh.on === 'coast' ? blastMs : sh.on === 'hit' ? hitMs : splashMs;
    const age = env.time - sh.land;
    if (age < 0 || age > dur) continue;
    // a hit rides with the ship it burst on
    const x = sh.on === 'hit' ? enemyNow.x + sh.hx : sh.tx;
    const y = sh.on === 'hit' ? enemyNow.y + sh.hy : sh.ty;
    blasts.draw(ctx, { kind, x, y, t: age / dur, ageMs: age, durMs: dur, zoom: z, scale: g, rt: 0, seed: sh.seed, reduced: false, dpr: env.dpr }, m);
  }
  ctx.globalAlpha = 1;
}

// ------------------------------------------------------------------------------------------------- paratroopers

/** How far the drop's parachutes scatter round the drop point at a zoom (the map's own spread, render/units.ts). */
const dropSpread = (z: number): number => Math.max(10, z * 2.4);
/**
 * The loop's layout at a zoom: the top straight (room above it for a loaded plane's troop pill) and the turn radius
 * (the parachutes come down inside the loop onto the bottom straight, so it is as tall as their fall).
 */
const dropTrack = (z: number): { top: number; r: number } => {
  const sp = dropSpread(z);
  return { top: Math.round(dropPlaneRoom(z) * 0.5 + 30), r: Math.max(30, sp * 1.15 + 6) };
};
/** About the size of a cargo plane, wings included, at a zoom (CSS px): room at the edges of the cell. */
const dropPlaneRoom = (z: number): number => 30 * px(z);
const dropHeight = (z: number): number => {
  const { top, r } = dropTrack(z);
  return Math.round(top + 2 * r + dropSpread(z) * 0.6 + 52);
};
/** One lap of the loop (ms), the same at every zoom so a drop comes round every few seconds. */
const DROP_LAP_MS = 7000;

const dropArgs: ParadropDraw = { x: 0, y: 0, owner: OWNER, ageMs: 0, durMs: 1, t: 0, count: 6, zoom: 1, scale: 1, seed: 0, dpr: 1 };
const markArgs: ParachuteMarkDraw = { x: 0, y: 0, half: 0, owner: OWNER, zoom: 1, dpr: 1 };

/**
 * Two cargo planes (yours and another nation's) flying a loop over land, half a lap apart; each drops its troops once a
 * lap at its own drop point on the bottom straight: the parachutes open, come down swaying inside the loop, land round
 * the point and fade. While loaded a plane carries its troop pill and parachute mark, as on the map.
 */
function paradropScene(env: SceneEnv): void {
  ground(env, 'land');
  const { ctx } = env;
  const z = env.zoom;
  const art = env.style.paradrop;
  const m = env.motion;
  const dur = art.durationMs(m);
  const key: SpriteKey = 'transportPlane';
  const len = unitLength(env, key);
  const half = Math.max(6, len / 2);
  const { top, r } = dropTrack(z);
  const yc = top + r;
  const margin = r + Math.max(len, dropPlaneRoom(z)) * 0.6 + 8;
  const x0 = margin;
  const x1 = env.w - margin;
  const L = Math.max(1, x1 - x0);
  const P = stadiumLength(x0, x1, r);
  const speedPx = P / (DROP_LAP_MS / 1000);
  const tilesPerSec = speedPx / z;
  const planes = [
    { owner: OWNERS[0], offset: 0, drop: L + Math.PI * r + L * 0.25, mine: true, id: 300 },
    { owner: OWNERS[1], offset: P / 2, drop: L + Math.PI * r + L * 0.75, mine: false, id: 301 },
  ];
  const units: TrailUnit[] = [];
  const poses: { p: Pose; owner: RGB; loaded: boolean; mine: boolean; seed: number }[] = [];
  for (const pl of planes) {
    const s = (env.time / 1000) * speedPx + pl.offset;
    const p = stadium(s, x0, x1, yc, r, speedPx);
    // distance flown since the plane last passed its drop point, and which lap that drop was
    const since = s - pl.drop;
    const lap = Math.floor(since / P);
    const d = since - lap * P;
    const pt = stadium(pl.drop, x0, x1, yc, r, speedPx);
    // the drop under the planes (the map draws drops before the units)
    const age = (d / speedPx) * 1000;
    if (lap >= 0 && age < dur) {
      dropArgs.x = pt.x;
      dropArgs.y = pt.y;
      dropArgs.owner = pl.owner;
      dropArgs.ageMs = age;
      dropArgs.durMs = dur;
      dropArgs.t = age / dur;
      dropArgs.count = 6;
      dropArgs.zoom = z;
      dropArgs.scale = env.scale;
      dropArgs.seed = rnd(lap + 1, pl.id);
      dropArgs.dpr = env.dpr;
      art.draw(ctx, dropArgs, m);
      ctx.globalAlpha = 1;
    }
    // the two names one above the other, so they never overlap when the loop is short (close zoom)
    label(ctx, pl.mine ? 'Your drop point' : 'Their drop point', pt.x, pt.y + dropSpread(z) * 0.6 + (pl.mine ? 16 : 34), 'center', true);
    poses.push({ p, owner: pl.owner, loaded: d > P * 0.45, mine: pl.mine, seed: pl.id });
    units.push({ id: pl.id, key, x: p.x, y: p.y, tx: p.x / z, ty: p.y / z, angle: p.angle, half, moving: true, speed: tilesPerSec, turnRate: p.turn, motion: m });
  }
  trailLayer(env, 'contrails').frame(ctx, units, trailView(env));
  for (const q of poses) drawUnit(env, key, 0, q.p.x, q.p.y, q.p.angle, q.p.turn, tilesPerSec, q.seed, z, q.owner);
  // loaded planes: the troop pill above and the parachute mark (mid and close zoom on the map)
  for (const q of poses) {
    if (!q.loaded) continue;
    env.pill(() => troopPill(ctx, q.p.x, q.p.y - Math.max(half * 0.55, 8) - 12, 1800, ['infantry'], q.owner, { edge: q.mine ? '#ffe98a' : css(q.owner), arrow: q.mine ? 'up' : 'none', small: true }));
    markArgs.x = q.p.x;
    markArgs.y = q.p.y;
    markArgs.half = half;
    markArgs.owner = q.owner;
    markArgs.zoom = z;
    markArgs.dpr = env.dpr;
    art.drawMark(ctx, markArgs, m);
  }
}

// ------------------------------------------------------------------------------------------------- rows

export function rowSpecs(): RowSpec[] {
  return [
    {
      id: 'ships',
      title: 'Ships and wakes',
      note: 'Every ship, plain and with every upgrade, half a lap apart, leaving its wake; under them a battleship at 30%, 60% and 90% damage.',
      pick: 'ships',
      also: ['wakes'],
      motion: 'ships',
      height: (z) => SHIPS.length * shipLane(z) + damagedBand(z) + 8,
      draw: shipsScene,
    },
    {
      id: 'land',
      title: 'Land units',
      note: 'Each tank, plain and with every upgrade, driving a lap.',
      pick: 'land',
      also: [],
      motion: 'land',
      height: (z) => TANKS.length * tankLane(z) + 8,
      draw: landScene,
    },
    {
      id: 'air',
      title: 'Planes and contrails',
      note: 'Each plane, plain and with jets and every upgrade, flying a figure eight over land and sea, so it banks both ways.',
      pick: 'air',
      also: ['contrails'],
      motion: 'air',
      height: (z) => PLANES.length * planeLane(z) + 10,
      draw: airScene,
    },
    {
      id: 'missiles',
      title: 'Missiles',
      note: 'A rocket and an atom bomb in flight with their smoke trails.',
      pick: 'missiles',
      also: ['contrails'],
      motion: 'missiles',
      height: (z) => 100 + 60 * px(z),
      draw: missilesScene,
    },
    {
      id: 'troopIcons',
      title: 'Troop icons',
      note: 'Infantry, armor, artillery and an unknown mix on seven nation colours, in both sizes, and the pills that carry them.',
      pick: 'troopIcons',
      also: [],
      motion: null,
      height: () => 34 + OWNERS.length * 24 + 56,
      draw: troopScene,
    },
    {
      id: 'explosions',
      title: 'Explosions',
      note: 'Each blast loops: shell, bombs, missile, plane shot down, ship hit, water splash, flak, fort hit and the atom bomb.',
      pick: 'explosions',
      also: [],
      motion: 'explosions',
      height: (z) => 2 * blastRow(z) + 230,
      draw: explosionsScene,
    },
    {
      id: 'craters',
      title: 'Craters',
      note: 'From fresh to almost gone, from a shell to an atom bomb; the last column plays a whole life, and the band at the bottom shows the atom bomb\'s whole blast zone.',
      pick: 'craters',
      also: [],
      motion: 'craters',
      height: (z) => 22 + CRATER_ROWS.reduce((a, r) => a + craterRow(r.r, craterZoom(r, z)), 0) + atomBand() + 6,
      draw: cratersScene,
    },
    {
      id: 'cannonFire',
      title: 'Cannon fire',
      note: 'A battleship (three guns) and a destroyer (one turret, two shots) shelling the coast and an enemy warship: hits burst on its hull, misses splash short, and it smokes and burns more as it gets hurt.',
      pick: 'cannonFire',
      also: [],
      motion: 'cannonFire',
      height: (z) => 140 + 80 * px(z),
      draw: cannonScene,
    },
    {
      id: 'paradrop',
      title: 'Paratroopers',
      note: 'Cargo planes fly a loop over land and drop their troops at a drop point: the parachutes open, drift down, land and fade.',
      pick: 'paradrop',
      also: [],
      motion: 'air',
      height: (z) => Math.max(140, dropHeight(z)),
      draw: paradropScene,
    },
  ];
}

