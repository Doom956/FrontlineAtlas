// Dug-in borders (trenches): "Borders between nations dig in over time. Artillery, barrages, planes and warships
// flatten trenches, and landings go around them."
//
// - WHERE: a nation's own land tiles within TRENCH.band (Fortress: fortressBand) steps of a land border with a
//   non-allied NATION. Tribes never dig and never make anyone dig; the wilderness and water never cause digging;
//   coastal tiles (a water 4-neighbour) never dig, so landings meet undug ground.
// - STATE: state.trench.dig (Uint8Array, one byte per tile, hashed): dig points 0..200. Level = floor(dig /
//   TRENCH.pointsPerLevel). A player's max level: TRENCH.baseMaxLevel, +1 Fortress (trenchLevels lever), +1 Trench
//   Warfare. Points never exceed max level x pointsPerLevel for the owner.
// - DIGGING: one pass per player every TRENCH.passSeconds of game time (x rules.progressRate), staggered by id:
//   player p runs when (p + tick) % passTicks === 0. Each band tile gains digPoints x digMul (rounded down, >= 1);
//   digMul = Fortress digSpeed (doctrineMore) x Trench Warfare techDigMul x leaderDigMul for the runaway coalition
//   leader. Tiles of the player's dug list that left the band lose decayPoints per pass.
// - FLATTENING: in the owner's pass, live air-support zones of nations at war with it (x Air airFlatten) and
//   bombarding warships of nations at war with it (x Naval level-3 shelling) remove points; barrages
//   (flattenDisc from barrage.ts) and atom bombs (units.ts) at their impact. setOwner (state.ts) resets a tile to 0.
// - COMBAT (combat.ts): see tileCost / frontPriority there.
// - SWITCH: setTrenchesOff (script-only WeakMap, for baseline batch runs): no digging and every level reads 0.
//
// Pure reads for the client: trenchLevel, trenchMaxLevel, trenchInfoAt, frontTrench, meanTrenchLevel. Change feed:
// drainTrenchChanges (tiles whose LEVEL changed inside a tick; never written by a read).
import { DOCTRINE_PERKS, NAVY_SUPPORT_RANGE, TECH_EFFECTS, TICKS_PER_SECOND, TRENCH } from './config';
import { runawayLeader } from './allies';
import { frontTiles } from './combat';
import { areAllied } from './diplomacy';
import { doctrineActive, doctrineLever, doctrineMore, doctrinePerk } from './doctrines';
import { forEachInRadius } from './grid';
import { atWar as atWarNaval, warshipStance } from './naval2';
import { progressRate } from './rules';
import { hasTech } from './tech';
import { borderTiles } from './territory';
import { isTribe, isWater } from './types';
import type { GameState, TrenchState } from './types';
import { navalReachMul, navalShellMul, navalSupportMul } from './variants';

/** Capacity of the trench change feed (tiles); when full, the consumer refreshes everything. */
export const TRENCH_CHANGES_CAPACITY = 1 << 16;
/** Most dig points a tile can hold (4 levels). */
const MAX_POINTS = 200;

export function createTrenchState(tiles: number): TrenchState {
  return {
    dig: new Uint8Array(tiles),
    dug: [],
    mark: new Int32Array(tiles),
    gen: 0,
    changes: new Int32Array(TRENCH_CHANGES_CAPACITY),
    changeCount: 0,
    changeOverflow: false,
    off: offByDefault,
  };
}

// ------------------------------------------------------------------------------------------------ off switch

let offByDefault = false;
/** Script-only switch (batch baselines): no digging, every level reads 0. Not reachable from any action. */
export function setTrenchesOff(state: GameState, off: boolean): void {
  if (state.trench) state.trench.off = off;
}
/** Script-only (scripts/rules.ts --rule trenches=0): every game created after this in the process has trenches off. */
export function setTrenchesOffByDefault(off: boolean): void {
  offByDefault = off;
}
export function trenchesOff(state: GameState): boolean {
  return !state.trench || state.trench.off;
}

// ------------------------------------------------------------------------------------------------ change feed

function recordTrenchChange(t: TrenchState, tile: number): void {
  if (t.changeOverflow) return;
  if (t.changeCount >= t.changes.length) {
    t.changeOverflow = true;
    return;
  }
  t.changes[t.changeCount++] = tile;
}
/**
 * Tiles whose trench level changed since the last drain, and clears the list (the client's trench texture). The
 * returned `tiles` array is reused: read the first `count` entries before the next tick. `overflow` = refresh all.
 */
export function drainTrenchChanges(state: GameState): { tiles: Int32Array; count: number; overflow: boolean } {
  const t = state.trench;
  if (!t) return { tiles: new Int32Array(0), count: 0, overflow: false };
  const out = { tiles: t.changes, count: t.changeCount, overflow: t.changeOverflow };
  t.changeCount = 0;
  t.changeOverflow = false;
  return out;
}

/** Sets a tile's dig points, recording a level change. */
function setDig(t: TrenchState, tile: number, v: number): void {
  const old = t.dig[tile];
  if (old === v) return;
  t.dig[tile] = v;
  if (((old / TRENCH.pointsPerLevel) | 0) !== ((v / TRENCH.pointsPerLevel) | 0)) recordTrenchChange(t, tile);
}

/** setOwner hook (state.ts): a tile that changes hands starts undug. */
export function resetTrench(state: GameState, tile: number): void {
  const t = state.trench;
  if (t && t.dig[tile] > 0) setDig(t, tile, 0);
}

// ------------------------------------------------------------------------------------------------ reads

/** Trench level of a tile (0 = undug; 0 everywhere when trenches are off). */
export function trenchLevel(state: GameState, tile: number): number {
  const t = state.trench;
  if (!t || t.off || tile < 0 || tile >= t.dig.length) return 0;
  return (t.dig[tile] / TRENCH.pointsPerLevel) | 0;
}

/** Deepest trench level pid's borders can reach: base, +1 Fortress, +1 Trench Warfare. */
export function trenchMaxLevel(state: GameState, pid: number): number {
  const p = state.players[pid];
  if (!p || pid <= 0 || isTribe(p)) return 0;
  let n = TRENCH.baseMaxLevel;
  if (doctrineLever(state, pid, 'trenchLevels') > 0) n++;
  if (hasTech(p, 'trenchWarfare')) n += TECH_EFFECTS.trenchLevels;
  return Math.min(MAX_POINTS / TRENCH.pointsPerLevel, n);
}

/** Band depth (tiles) of pid's dug-in borders. */
export function trenchBand(state: GameState, pid: number): number {
  return doctrineActive(state, pid) === 'fortress' ? TRENCH.fortressBand : TRENCH.band;
}

/** Dig multiplier of pid: Fortress digSpeed, Trench Warfare, runaway leader. */
export function trenchDigMul(state: GameState, pid: number): number {
  let m = doctrineMore(state, pid, 'digSpeed');
  if (hasTech(state.players[pid], 'trenchWarfare')) m *= TECH_EFFECTS.trenchDigMul;
  if (runawayLeader(state) === pid) m *= TRENCH.leaderDigMul;
  return m;
}

/** Mean trench level over the given tiles (0 for none). */
export function meanTrenchLevel(state: GameState, tiles: readonly number[]): number {
  if (!tiles.length || !state.trench || trenchesOff(state)) return 0;
  let s = 0;
  for (const t of tiles) s += trenchLevel(state, t);
  return s / tiles.length;
}

/**
 * Mean trench level of `target`'s land along its shared border with `attacker` (at most TRENCH.sampleTiles evenly
 * strided samples; 0 when there is no border). Pure read, no cache.
 */
export function frontTrench(state: GameState, attacker: number, target: number): number {
  if (!state.trench || trenchesOff(state) || target <= 0 || attacker === target) return 0;
  const tp = state.players[target];
  if (!tp || !tp.alive || isTribe(tp)) return 0;
  const tiles = frontTiles(state, attacker, target);
  if (!tiles.length) return 0;
  const n = Math.min(TRENCH.sampleTiles, tiles.length);
  const stride = tiles.length / n;
  let s = 0;
  for (let k = 0; k < n; k++) s += trenchLevel(state, tiles[Math.floor(k * stride)]);
  return s / n;
}

export interface TrenchInfo {
  /** owner of the tile */
  owner: number;
  level: number;
  /** the owner's deepest possible level */
  max: number;
  /** attackers lose this much more here (0.30 = +30%) and advance this much slower, before artillery */
  lossPct: number;
  slowPct: number;
}
/** Tooltip data of a tile's trench, or null when it is undug (or not a nation's land). */
export function trenchInfoAt(state: GameState, tile: number): TrenchInfo | null {
  const level = trenchLevel(state, tile);
  if (level <= 0) return null;
  const owner = state.map.owner[tile];
  return { owner, level, max: trenchMaxLevel(state, owner), lossPct: TRENCH.step * level, slowPct: TRENCH.slow * level };
}

// ------------------------------------------------------------------------------------------------ flattening

/**
 * Removes `points` dig points on the tiles within r of `tile` whose owner `byOwner` is hostile to (any owner but
 * byOwner and its allies; byOwner 0 = every tile). Barrages (100) and atom bombs (255) call it at their impact.
 */
export function flattenDisc(state: GameState, tile: number, r: number, points: number, byOwner: number): void {
  const t = state.trench;
  if (!t) return;
  const owner = state.map.owner;
  forEachInRadius(state.map, tile, r, (i) => {
    const d = t.dig[i];
    if (d === 0) return;
    const o = owner[i];
    if (byOwner > 0 && (o === byOwner || areAllied(state, byOwner, o))) return;
    setDig(t, i, Math.max(0, d - points));
  });
}

/** Owner-side flattening by air-support zones and bombarding warships of nations at war with pid. */
function flattenFor(state: GameState, t: TrenchState, pid: number): void {
  const owner = state.map.owner;
  const air = state.air;
  if (air && air.zones.length) {
    for (const z of air.zones) {
      if (z.untilTick <= state.tick || z.owner === pid || !atWarNaval(state, z.owner, pid) || areAllied(state, z.owner, pid)) continue;
      const pts = Math.round(TRENCH.zoneFlattenPerPass * doctrineMore(state, z.owner, 'airFlatten'));
      forEachInRadius(state.map, z.tile, z.radius, (i) => {
        const d = t.dig[i];
        if (d > 0 && owner[i] === pid) setDig(t, i, Math.max(0, d - pts));
      });
    }
  }
  const w = state.map.width;
  for (const u of state.units) {
    if (u.type !== 'warship' || u.hp <= 0 || u.owner === pid || warshipStance(u) !== 'bombard' || navalShellMul(u) <= 0) continue;
    if (!atWarNaval(state, u.owner, pid) || areAllied(state, u.owner, pid)) continue;
    const r = NAVY_SUPPORT_RANGE * navalReachMul(state, u.owner) * navalSupportMul(u);
    if (r <= 0) continue;
    const pts = Math.round(TRENCH.shipFlattenPerPass * (doctrinePerk(state, u.owner, 'naval') ? DOCTRINE_PERKS.naval.shelling : 1));
    const c = Math.min(state.map.height - 1, Math.max(0, Math.round(u.y))) * w + Math.min(w - 1, Math.max(0, Math.round(u.x)));
    forEachInRadius(state.map, c, r, (i) => {
      const d = t.dig[i];
      if (d > 0 && owner[i] === pid) setDig(t, i, Math.max(0, d - pts));
    });
  }
}

// ------------------------------------------------------------------------------------------------ the pass

/** Ticks between two passes of one player. */
export function trenchPassTicks(state: GameState): number {
  return Math.max(1, Math.round((TRENCH.passSeconds * TICKS_PER_SECOND) / progressRate(state)));
}

/** True when q is a live nation pid digs in against (not pid, not a tribe, not allied / same team). */
function hostileNation(state: GameState, pid: number, q: number): boolean {
  if (q <= 0 || q === pid) return false;
  const qp = state.players[q];
  return !!qp && qp.alive && !isTribe(qp) && !areAllied(state, pid, q);
}

// Scratch BFS queue and per-pass hostility table (reused; the pass is synchronous).
let queue: number[] = [];
let hostileTo = new Uint8Array(0);

/** One dig pass of player pid: band, digging, decay, then owner-side flattening. */
function passFor(state: GameState, t: TrenchState, pid: number): void {
  const p = state.players[pid];
  const dugList = (t.dug[pid] ??= []);
  if (!p || !p.alive || isTribe(p) || p.tiles <= 0) {
    dugList.length = 0;
    return;
  }
  const map = state.map;
  const { owner, terrain, coastal } = map;
  const w = map.width;
  const n = owner.length;
  const gen = ++t.gen;
  const mark = t.mark;
  const band = trenchBand(state, pid);
  const cap = trenchMaxLevel(state, pid) * TRENCH.pointsPerLevel;
  const add = Math.max(1, Math.floor(TRENCH.digPoints * trenchDigMul(state, pid)));

  // Band: seeds are own land tiles (not coastal) with a 4-neighbour of a hostile nation; rings over own inland land.
  queue.length = 0;
  const np = state.players.length;
  if (hostileTo.length < np) hostileTo = new Uint8Array(np);
  for (let q = 0; q < np; q++) hostileTo[q] = hostileNation(state, pid, q) ? 1 : 0;
  const hot = hostileTo;
  const { list, len } = borderTiles(state, pid);
  for (let k = 0; k < len; k++) {
    const i = list[k];
    if (coastal[i] || isWater(terrain[i]) || mark[i] === gen) continue;
    const x = i % w;
    if ((x > 0 && hot[owner[i - 1]]) || (x < w - 1 && hot[owner[i + 1]]) || (i >= w && hot[owner[i - w]]) || (i < n - w && hot[owner[i + w]])) {
      mark[i] = gen;
      queue.push(i);
    }
  }
  let head = 0;
  for (let depth = 1; depth < band && head < queue.length; depth++) {
    const end = queue.length;
    for (; head < end; head++) {
      const i = queue[head];
      const x = i % w;
      if (x > 0) visit(i - 1);
      if (x < w - 1) visit(i + 1);
      if (i >= w) visit(i - w);
      if (i < n - w) visit(i + w);
    }
  }
  function visit(j: number): void {
    if (mark[j] === gen || owner[j] !== pid || coastal[j] || isWater(terrain[j])) return;
    mark[j] = gen;
    queue.push(j);
  }

  // Decay and clean the dug list (tiles out of the band, lost tiles, duplicates). Band tiles are re-added below.
  const dgen = ++t.gen;
  let keep = 0;
  for (let k = 0; k < dugList.length; k++) {
    const i = dugList[k];
    if (owner[i] !== pid || t.dig[i] === 0 || mark[i] === gen || mark[i] === dgen) continue;
    mark[i] = dgen;
    const d = t.dig[i] - TRENCH.decayPoints;
    setDig(t, i, Math.max(0, Math.min(cap, d)));
    if (t.dig[i] > 0) dugList[keep++] = i;
  }
  dugList.length = keep;
  // Dig the band (in queue order: deterministic).
  for (let k = 0; k < queue.length; k++) {
    const i = queue[k];
    const d = t.dig[i];
    const v = Math.min(cap, d + add);
    if (v !== d) setDig(t, i, v);
    if (t.dig[i] > 0) dugList.push(i);
  }
  flattenFor(state, t, pid);
  if (queue.length > 1 << 16) queue = [];
}

/** Staggered dig passes (sim.ts, after updateAttacks). */
export function updateTrenches(state: GameState): void {
  const t = state.trench;
  if (!t || state.phase !== 'playing' || trenchesOff(state)) return;
  const every = trenchPassTicks(state);
  const players = state.players;
  for (let pid = 1; pid < players.length; pid++) {
    if ((pid + state.tick) % every !== 0) continue;
    passFor(state, t, pid);
  }
}
