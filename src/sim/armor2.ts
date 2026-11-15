// Tank divisions, part two: reusable divisions (refit), veterancy, encirclement and the 'support front' mode.
// (tanks.ts keeps building, driving, spearheads, previews, defence and the first AI.)
//
// - Refit: a holding division below full strength takes troops back from the home pool every second:
//   ARMOR_REFIT_FACTORY of a full division per second near an own finished Factory, ARMOR_REFIT_FIELD elsewhere.
// - Veterancy: a spearhead taking at least ARMOR_VET_MIN_TILES tiles adds them (and encircled pockets / 10) as xp;
//   levels at ARMOR_VET_XP give a faster, deeper head and lower losses (vetSpeedMul, vetLossMul).
// - Encirclement (collapsePockets): pieces of the target's land next to a spearhead's line that are cut off (closed by
//   the attacker's / its allies' land, water and the map edge; no capital) collapse to the attacker at once.
// - Modes (Unit.mode, Action setDivisionMode): hold (default for AI), support (Unit.station = the front tile: holds behind
//   it, launches spearheads into the weakest spot within ARMOR_SUPPORT_RADIUS when ready, lines that cut the enemy's
//   land first; drives back to refit at a Factory when worn down), refit (to the nearest Factory, refit, then hold).
// - Follow my war (warTarget.ts): a player's division put on support without a front picked follows the main front
//   against the owner's war target (Unit.station moves with it; it jumps there by rail, a route search of
//   TANK_MOBILITY.jumpBudget for a far front, then a flood of our land when that gives up); a front it can't reach
//   over our land makes it support one it can reach for DETOUR_SECONDS; with no war target it holds where it is. A
//   player's new divisions start on support, following. A picked front makes it Fixed
//   (Unit.fixed = 1) until the player picks Follow again. AI divisions always get a front: the foe's border tile
//   nearest the focus of the biggest attack between them (their main front).
// Deterministic: no RNG; per-division work staggered by id; fixed tie-breaks.
import { buildingsOf } from './buildings';
import { annexTiles, frontTiles } from './combat';
import {
  ARMOR_AUTO_PATH_BUDGET,
  ARMOR_CUT_BONUS,
  ARMOR_RETRY_SECONDS,
  ARMOR_POCKET_KILL,
  ARMOR_POCKET_MAX_TILES,
  ARMOR_RAILWAY_LEVELS,
  ARMOR_REFIT_FACTORY,
  ARMOR_REFIT_FIELD,
  ARMOR_REFIT_RADIUS,
  ARMOR_SUPPORT_HOLD,
  ARMOR_SUPPORT_MIN_DEPTH,
  ARMOR_SUPPORT_RADIUS,
  ARMOR_SUPPORT_READY,
  ARMOR_SUPPORT_REFIT,
  ARMOR_SUPPORT_SCAN_SECONDS,
  ARMOR_VET_LOSS,
  ARMOR_VET_MIN_TILES,
  ARMOR_VET_SPEED,
  ARMOR_VET_XP,
  TANK_DISBAND_SHARE,
  TANK_DIVISION_TROOPS,
  TANK_FALLBACK_RADIUS,
  TANK_MOBILITY,
  TANK_PER_FACTORY_LEVEL,
  TANK_SPEARHEAD_WIDTH,
  TICKS_PER_SECOND,
} from './config';
import { areAllied } from './diplomacy';
import { atWar } from './naval2';
import { aiAttackLevel } from './aiattack';
import { ownGroup } from './navy';
import { atPeace } from './rules';
import { addEvent } from './state';
import { hasTech } from './tech';
import { moveTankDivisions, ownLandPath, spearheadPreview } from './tanks';
import type { SpearheadPreview } from './tanks';
import { hasAmphibious, narrowWater } from './specials';
import { armorPocketKillMul, armorPocketMul, armorRefitMul } from './variants';
import { followedNation, liveFoes, mainFront, unitFollows } from './warTarget';
import { DIVISION_MODES, TROOP_TYPES, isTribe, isWater } from './types';
import type { Action, ActionResult, DivisionMode, GameState, Troops, Unit } from './types';

const FAIL = (reason: string): ActionResult => ({ ok: false, reason });
/** A following division keeps its front while it is within this many tiles of the main front (warTarget.ts). */
const FOLLOW_KEEP = 24;
/** A following division that can't reach the main front over its land supports a front it can reach this long. */
const DETOUR_SECONDS = 60;
const total = (t: Troops): number => t.infantry + t.armor + t.artillery;
const FULL = TANK_DIVISION_TROOPS.armor + TANK_DIVISION_TROOPS.infantry + TANK_DIVISION_TROOPS.artillery;

function unitTile(state: GameState, u: Unit): number {
  return Math.round(u.y) * state.map.width + Math.round(u.x);
}
function d2(ax: number, ay: number, bx: number, by: number): number {
  const dx = ax - bx;
  const dy = ay - by;
  return dx * dx + dy * dy;
}

/** A division's mode ('hold' when none was set). */
export function divisionMode(u: Unit): DivisionMode {
  return u.mode ?? 'hold';
}
/** Strength of a division as a share of a full one. */
export function divisionStrength(u: Unit): number {
  return total(u.troops) / FULL;
}
/**
 * How sharply a division fights on its automatic modes: AI divisions by difficulty (aiattack.ts: 0 Easy keeps the old
 * habits, 1 Normal, 2 Hard, 3 Brutal); a player's divisions count as Normal at every difficulty.
 */
export function armorLevel(state: GameState, owner: number): number {
  return state.players[owner]?.isHuman ? 1 : aiAttackLevel(state);
}

// ---------------------------------------------------------------------------------------------------------------
// Limits and veterancy (tanks.ts asks)
// ---------------------------------------------------------------------------------------------------------------

/** Divisions per finished Factory level, plus one per ARMOR_RAILWAY_LEVELS levels with Railways. */
export function divisionLimitFor(state: GameState, playerId: number, factoryLevels: number): number {
  const base = factoryLevels * TANK_PER_FACTORY_LEVEL;
  const p = state.players[playerId];
  if (!p || !hasTech(p, 'railways') || factoryLevels <= 0) return base;
  return base + Math.max(1, Math.floor(factoryLevels / ARMOR_RAILWAY_LEVELS));
}
/** Head speed and max depth x this for division u (veterancy). */
export function vetSpeedMul(u: Unit): number {
  return 1 + ARMOR_VET_SPEED * (u.vet ?? 0);
}
/** Spearhead losses x this for division u (veterancy). */
export function vetLossMul(u: Unit): number {
  return 1 - ARMOR_VET_LOSS * (u.vet ?? 0);
}

function gainXp(state: GameState, u: Unit, xp: number): void {
  if (xp <= 0) return;
  u.xp = (u.xp ?? 0) + xp;
  let lvl = u.vet ?? 0;
  const before = lvl;
  while (lvl < ARMOR_VET_XP.length && u.xp >= ARMOR_VET_XP[lvl]) lvl++;
  if (lvl === before) return;
  u.vet = lvl;
  addEvent(state, 'info', `${state.players[u.owner].name}'s tank division reached veteran level ${lvl}`, [u.owner], unitTile(state, u));
}

/** A spearhead ended having taken `taken` tiles (tanks.endSpearhead): veterancy xp. */
export function onSpearheadEnded(state: GameState, u: Unit, taken: number): void {
  if (taken >= ARMOR_VET_MIN_TILES) gainXp(state, u, taken);
}

// ---------------------------------------------------------------------------------------------------------------
// Encirclement
// ---------------------------------------------------------------------------------------------------------------

const DX4 = [1, -1, 0, 0];
const DY4 = [0, 0, 1, -1];

/**
 * Pockets cut off by spearhead u (running or just ended; u.launch .. its head along the line to u.target): every
 * piece of the target's land touching the band around the line is flooded; one closed by the attacker's / its
 * allies' land, water and the map edge, without the target's capital, of at most ARMOR_POCKET_MAX_TILES and less
 * than half of the target's land, goes to the attacker, and the target loses that share of its home army x
 * ARMOR_POCKET_KILL. Returns the tiles taken.
 */
export function collapsePockets(state: GameState, u: Unit, launch: number, headX: number, headY: number): number {
  const victim = u.targetOwner;
  const me = u.owner;
  const vp = state.players[victim];
  if (victim <= 0 || !vp || !vp.alive || vp.tiles <= 0) return 0;
  if (areAllied(state, me, victim) || atPeace(state, me, victim)) return 0;
  if (state.admin?.godMode.includes(victim)) return 0;
  const map = state.map;
  const { width: w, height: h, owner, terrain } = map;
  const lx = launch % w;
  const ly = (launch / w) | 0;
  const dx = headX - lx;
  const dy = headY - ly;
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len < 1) return 0;
  const ux = dx / len;
  const uy = dy / len;
  const half = ((TANK_SPEARHEAD_WIDTH - 1) >> 1) + 2;
  // Seeds: victim tiles on and around the band along the line.
  const seeds: number[] = [];
  const seen = new Set<number>();
  for (let d = 0; d <= Math.ceil(len) + 1; d++) {
    for (let k = -half; k <= half; k++) {
      const x = Math.round(lx + ux * d - uy * k);
      const y = Math.round(ly + uy * d + ux * k);
      if (x < 0 || y < 0 || x >= w || y >= h) continue;
      const t = y * w + x;
      if (owner[t] === victim && !seen.has(t)) {
        seen.add(t);
        seeds.push(t);
      }
    }
  }
  if (!seeds.length) return 0;
  const maxTiles = Math.round(ARMOR_POCKET_MAX_TILES * armorPocketMul(state, me)); // Armor Mastery (variants.ts)
  const cap = Math.min(maxTiles, Math.floor((vp.tiles - 1) / 2));
  if (cap < 1) return 0;
  const visited = new Set<number>();
  // Tiles of searches that turned out open: reaching one means this piece is open too (they are not walls).
  const openTiles = new Set<number>();
  const closes = (o: number, t: number): boolean => o === me || isWater(terrain[t]) || (o > 0 && o !== victim && areAllied(state, me, o));
  const tilesBefore = vp.tiles;
  let taken = 0;
  let pockets = 0;
  let budget = 4 * maxTiles;
  for (const s0 of seeds) {
    if (visited.has(s0) || owner[s0] !== victim) continue;
    const piece: number[] = [s0];
    visited.add(s0);
    let open = false;
    for (let head = 0; head < piece.length && !open; head++) {
      if (piece.length > cap || --budget <= 0) {
        open = true;
        break;
      }
      const t = piece[head];
      if (t === vp.capital) {
        open = true;
        break;
      }
      const x = t % w;
      const y = (t / w) | 0;
      for (let k = 0; k < 4; k++) {
        const nx = x + DX4[k];
        const ny = y + DY4[k];
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue; // the map edge closes
        const j = ny * w + nx;
        const o = owner[j];
        if (o === victim) {
          if (!visited.has(j)) {
            visited.add(j);
            piece.push(j);
          } else if (openTiles.has(j)) {
            open = true;
            break;
          }
          continue;
        }
        if (!closes(o, j)) {
          open = true;
          break;
        }
      }
    }
    if (open) {
      for (const t of piece) openTiles.add(t);
      continue;
    }
    const moved = annexTiles(state, victim, me, piece);
    if (moved <= 0) continue;
    taken += moved;
    pockets++;
  }
  if (!taken) return 0;
  // The troops in the pocket are lost (a share of the home army).
  if (vp.alive) {
    const tot = total(vp.troops);
    const kill = Math.min(tot, (tot * ARMOR_POCKET_KILL * armorPocketKillMul(state, me) * taken) / Math.max(1, tilesBefore));
    if (kill > 0) {
      for (const k of TROOP_TYPES) vp.troops[k] = Math.max(0, vp.troops[k] - (kill * vp.troops[k]) / tot);
      vp.stats.troopsLost += kill;
      state.players[me].stats.troopsKilled += kill;
    }
  }
  gainXp(state, u, taken / 10);
  const who = isTribe(vp) ? [me] : [me, victim];
  const what = pockets > 1 ? `${pockets} pockets` : 'a pocket';
  addEvent(state, 'info', `${state.players[me].name}'s tanks encircled ${what} of ${vp.name}: ${taken} tiles collapse`, who, seeds[0]);
  return taken;
}

// ---------------------------------------------------------------------------------------------------------------
// Refit
// ---------------------------------------------------------------------------------------------------------------

/** The own finished Factory nearest to tile (ties: lower id), or -1. */
function nearestFactory(state: GameState, owner: number, tile: number): number {
  const w = state.map.width;
  const x = tile % w;
  const y = (tile / w) | 0;
  let best = -1;
  let bestD = Infinity;
  let bestId = Infinity;
  for (const b of buildingsOf(state, owner, 'factory')) {
    if (b.owner !== owner || b.buildLeft > 0) continue;
    const d = d2(b.tile % w, (b.tile / w) | 0, x, y);
    if (d < bestD || (d === bestD && b.id < bestId)) {
      best = b.tile;
      bestD = d;
      bestId = b.id;
    }
  }
  return best;
}
function nearFactory(state: GameState, u: Unit): boolean {
  const f = nearestFactory(state, u.owner, unitTile(state, u));
  if (f < 0) return false;
  const w = state.map.width;
  return d2(f % w, (f / w) | 0, u.x, u.y) <= ARMOR_REFIT_RADIUS * ARMOR_REFIT_RADIUS;
}

/** One second of refit for a holding division: troops back from the home pool toward a full division. */
function refit(state: GameState, u: Unit): void {
  const p = state.players[u.owner];
  if (!p || !p.alive) return;
  const have = total(u.troops);
  if (have >= FULL - 1e-6) return;
  const rate = (nearFactory(state, u) ? ARMOR_REFIT_FACTORY : ARMOR_REFIT_FIELD) * armorRefitMul(state, u.owner); // Deep Raids (variants.ts)
  const amount = Math.min(FULL - have, rate * FULL);
  for (const k of TROOP_TYPES) {
    const want = Math.max(0, TANK_DIVISION_TROOPS[k] - u.troops[k]);
    const take = Math.min(want, (amount * TANK_DIVISION_TROOPS[k]) / FULL, Math.max(0, p.troops[k]));
    if (take <= 0) continue;
    u.troops[k] += take;
    p.troops[k] -= take;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Action setDivisionMode
// ---------------------------------------------------------------------------------------------------------------

function driveTo(state: GameState, u: Unit, dest: number, auto = false, now = false): boolean {
  // `now` (smarter armour): a drive away from the fighting (to refit, off a thin tip) doesn't wait out the pause after a
  // failed route or a fall-back (that pause is for drives back to the front).
  const waiting = (u.retryTick ?? 0) > state.tick;
  if (auto && !now && waiting) return false;
  // Automatic drives search less (a jump to a far front: TANK_MOBILITY.jumpBudget) and wait ARMOR_RETRY_SECONDS after
  // a failed route (an unreachable front / Factory).
  const w = state.map.width;
  const farR = ARMOR_SUPPORT_RADIUS + 12;
  const far = d2(u.x, u.y, dest % w, (dest / w) | 0) > farR * farR;
  let path = ownLandPath(state, u.owner, unitTile(state, u), dest, auto ? (far ? TANK_MOBILITY.jumpBudget : ARMOR_AUTO_PATH_BUDGET) : undefined);
  if (!path && auto && !waiting && armorLevel(state, u.owner) >= 1) {
    // A player's division and AI ones from Normal up (Easy keeps the quick search): the quick search gave up, so a
    // flood of our land finds any route there, or tells a division on support that its front can't be reached over
    // our land (it then supports a front it can reach for a while).
    const from = unitTile(state, u);
    const prev = landFlood(state, u.owner, from);
    if (prev[dest] >= 0) path = floodPath(prev, from, dest);
    else {
      const hold = startDetour(state, u, prev);
      if (hold >= 0) {
        dest = hold;
        path = floodPath(prev, from, dest);
      }
    }
  }
  if (!path) {
    // A failed far jump (the bigger search) waits TANK_MOBILITY.jumpRetry times as long.
    if (auto) u.retryTick = Math.max(u.retryTick ?? 0, state.tick + ARMOR_RETRY_SECONDS * (far ? TANK_MOBILITY.jumpRetry : 1) * TICKS_PER_SECOND);
    return false;
  }
  u.retryTick = undefined;
  u.path = path;
  u.pathPos = 0;
  u.target = dest;
  u.state = path.length ? 1 : 0;
  return true;
}

/**
 * Flood of `owner`'s land from `from` (8 directions; a diagonal step needs one of its two side tiles, as in
 * tanks.ownLandPath): prev[t] = the tile t was reached from (`from` itself for the start), -1 = not reached.
 */
function landFlood(state: GameState, owner: number, from: number): Int32Array {
  const map = state.map;
  const { width: w, height: h } = map;
  const prev = new Int32Array(map.owner.length).fill(-1);
  const own = (t: number): boolean => map.owner[t] === owner && !isWater(map.terrain[t]);
  if (!own(from)) return prev;
  prev[from] = from;
  const queue: number[] = [from];
  for (let head = 0; head < queue.length; head++) {
    const cur = queue[head];
    const cx = cur % w;
    const cy = (cur / w) | 0;
    for (let k = 0; k < 8; k++) {
      const x = cx + DX8[k];
      const y = cy + DY8[k];
      if (x < 0 || y < 0 || x >= w || y >= h) continue;
      const t = y * w + x;
      if (prev[t] >= 0 || !own(t)) continue;
      if (k >= 4 && !own(cy * w + x) && !own(y * w + cx)) continue;
      prev[t] = cur;
      queue.push(t);
    }
  }
  return prev;
}
const DX8 = [1, -1, 0, 0, 1, 1, -1, -1];
const DY8 = [0, 0, 1, -1, 1, -1, 1, -1];

/** The route from `from` to a flooded tile `to` (landFlood), without `from` (like ownLandPath). */
function floodPath(prev: Int32Array, from: number, to: number): number[] {
  const out: number[] = [];
  for (let t = to; t !== from; t = prev[t]) out.push(t);
  out.reverse();
  return out;
}

/**
 * A player's following support division, or an AI one from Normal up, whose front can't be reached over our land
 * (prev = landFlood from it): supports a front it can reach for DETOUR_SECONDS (u.station, u.detour; aiDivisionModes
 * leaves it there meanwhile). Returns the tile to hold, -1 = none.
 */
function startDetour(state: GameState, u: Unit, prev: Int32Array): number {
  if (divisionMode(u) !== 'support' || !(unitFollows(state, u) || !state.players[u.owner]?.isHuman)) return -1;
  const alt = reachableFront(state, u, prev, u.station ?? unitTile(state, u));
  if (!alt) return -1;
  u.station = alt.front;
  u.detour = state.tick + DETOUR_SECONDS * TICKS_PER_SECOND;
  return alt.hold;
}

/** True when tile t (a front) is next to flooded land (landFlood). */
function floodTouches(state: GameState, prev: Int32Array, t: number): boolean {
  const w = state.map.width;
  const x = t % w;
  const y = (t / w) | 0;
  return prev[t] >= 0 || (x > 0 && prev[t - 1] >= 0) || (x < w - 1 && prev[t + 1] >= 0) || (y > 0 && prev[t - w] >= 0) || (y < state.map.height - 1 && prev[t + w] >= 0);
}

/**
 * A front following division u can reach (prev = landFlood from it): the war target's border tile next to the
 * flooded land nearest `ref`, else that of another nation we fight (nations first, lower id; nearest the division),
 * with the tile to hold behind it. null = none.
 */
function reachableFront(state: GameState, u: Unit, prev: Int32Array, ref: number): { front: number; hold: number } | null {
  const w = state.map.width;
  const touches = (t: number): boolean => floodTouches(state, prev, t);
  const pick = (n: number, anchor: number): number => {
    let best = -1;
    let bestD = Infinity;
    for (const t of frontTiles(state, u.owner, n, 4000)) {
      if (!touches(t)) continue;
      const d = d2(t % w, (t / w) | 0, anchor % w, (anchor / w) | 0);
      if (d < bestD || (d === bestD && t < best)) {
        bestD = d;
        best = t;
      }
    }
    return best;
  };
  // The war target (a player's), else the nation whose land the front was on (an AI's).
  const was = u.station !== undefined ? state.map.owner[u.station] : 0;
  const foe = state.players[u.owner]?.isHuman ? followedNation(state, u.owner) : isFoe(state, u.owner, was) ? was : 0;
  let front = foe > 0 ? pick(foe, ref) : -1;
  if (front < 0) {
    for (const n of liveFoes(state, u.owner)) {
      if (n === foe) continue;
      front = pick(n, unitTile(state, u));
      if (front >= 0) break;
    }
  }
  if (front < 0) return null;
  const hold = holdTileNear(state, u.owner, front, (t) => prev[t] >= 0);
  return hold >= 0 ? { front, hold } : null;
}

/**
 * Action setDivisionMode: hold / support / refit (drives to the nearest own Factory). Support: `front` (a land tile
 * at or near a front of yours) fixes the front; a player's divisions without one (or with follow = true) follow the
 * main front against the war target (warTarget.ts). Divisions in a spearhead take the mode when it ends.
 */
export function setDivisionMode(state: GameState, playerId: number, unitIds: unknown, mode: unknown, front?: number, follow?: boolean): ActionResult {
  if (typeof mode !== 'string' || !(DIVISION_MODES as readonly string[]).includes(mode)) return FAIL('Unknown mode');
  if (follow !== undefined && typeof follow !== 'boolean') return FAIL('Invalid value');
  const group = ownGroup(state, playerId, unitIds, 'tankDivision', 'tank divisions');
  if (typeof group === 'string') return FAIL(group);
  const map = state.map;
  const following = mode === 'support' && (follow === true || (follow === undefined && front === undefined && !!state.players[playerId]?.isHuman));
  if (mode === 'support' && !following) {
    if (front === undefined || !Number.isInteger(front) || front < 0 || front >= map.owner.length) return FAIL('Pick the front to support');
    if (isWater(map.terrain[front])) return FAIL('Pick a land tile at the front');
  }
  if (mode === 'refit' && nearestFactory(state, playerId, unitTile(state, group[0])) < 0) return FAIL('You need a finished Factory to refit at');
  const foe = following ? followedNation(state, playerId) : 0;
  const followFront = foe > 0 ? mainFront(state, playerId, foe) : -1;
  for (const u of group) {
    u.mode = mode as DivisionMode;
    delete u.detour;
    if (following) {
      delete u.fixed;
      u.station = followFront >= 0 ? followFront : undefined;
    } else {
      u.station = mode === 'support' ? front : undefined;
      if (mode === 'support' && state.players[playerId]?.isHuman) u.fixed = 1; // AI divisions don't follow anyway
      else delete u.fixed;
    }
    if (u.state === 3) continue;
    if (mode === 'refit') {
      const f = nearestFactory(state, playerId, unitTile(state, u));
      if (f >= 0 && map.owner[f] === playerId) driveTo(state, u, f);
    }
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------------------------------------------
// Per-tick work (tanks.updateTanks calls divisionStep for every division not in a spearhead)
// ---------------------------------------------------------------------------------------------------------------

/** True when own land runs at least `depth` tiles out in all 4 directions from t (holdTileNear's interior test). */
function interiorAt(state: GameState, owner: number, t: number, depth = 3): boolean {
  const map = state.map;
  const { width: w, height: h } = map;
  const x = t % w;
  const y = (t / w) | 0;
  const own = (xx: number, yy: number): boolean => xx >= 0 && yy >= 0 && xx < w && yy < h && map.owner[yy * w + xx] === owner;
  return own(x + depth, y) && own(x - depth, y) && own(x, y + depth) && own(x, y - depth);
}

/**
 * Own land tile to hold behind `front` (and `ok`): interior (own land `depth` tiles out in all 4 directions), nearest
 * the front, within ARMOR_SUPPORT_HOLD + 12 tiles (with `far`, smarter armour: within `far` tiles when there is none
 * that close, e.g. a front tile deep in our own new spearhead's band); else the own tile nearest the front.
 */
function holdTileNear(state: GameState, owner: number, front: number, ok?: (t: number) => boolean, depth = 3, far = 0): number {
  const map = state.map;
  const { width: w, height: h } = map;
  const fx = front % w;
  const fy = (front / w) | 0;
  const own = (x: number, y: number): boolean => x >= 0 && y >= 0 && x < w && y < h && map.owner[y * w + x] === owner && !isWater(map.terrain[y * w + x]);
  let best = -1;
  let bestD = Infinity;
  let fallback = -1;
  let fallbackD = Infinity;
  const scan = (r: number): void => {
    for (let y = Math.max(0, fy - r); y <= Math.min(h - 1, fy + r); y++) {
      for (let x = Math.max(0, fx - r); x <= Math.min(w - 1, fx + r); x++) {
        if (!own(x, y)) continue;
        const d = d2(x, y, fx, fy);
        if (d > r * r) continue;
        const t = y * w + x;
        if (ok && !ok(t)) continue;
        if (d < fallbackD) {
          fallbackD = d;
          fallback = t;
        }
        if (d >= bestD) continue;
        if (!own(x + depth, y) || !own(x - depth, y) || !own(x, y + depth) || !own(x, y - depth)) continue;
        best = t;
        bestD = d;
      }
    }
  };
  const r = ARMOR_SUPPORT_HOLD + 12;
  scan(r);
  if (best < 0 && depth > 3) return holdTileNear(state, owner, front, ok, 3, far);
  if (best < 0 && far > r) scan(far);
  return best >= 0 ? best : fallback;
}

/** Nations a division of `me` may strike in support mode: those it is at war with. */
function isFoe(state: GameState, me: number, o: number): boolean {
  return o > 0 && o !== me && atWar(state, me, o);
}

interface Strike {
  tile: number;
  /** own tile the spearhead starts from */
  launch: number;
  score: number;
  /** the line gets right across the enemy's land (a cut that encircles) */
  cut?: boolean;
}

/** A cut line crosses at most this many tiles of the enemy's land (cutClicks). */
const CUT_CROSS = 24;
/** ... and at least this many (thinner slivers are not worth a strike). */
const CUT_MIN_CROSS = 3;
/** Divisions that strike together at most (side by side: a band this many times as wide). */
const GROUP_MAX = 3;
/** Smarter armour: a division under ARMOR_SMART_READY drives back to a Factory within this many tiles to refit there,
 *  and stays there until ARMOR_SMART_FULL. */
const ARMOR_REFIT_TRIP = 48;
const ARMOR_SMART_FULL = 0.85;
/** Smarter armour: a straight strike (no cut) needs this share of a full division (a cut: ARMOR_SUPPORT_READY). */
const ARMOR_SMART_READY = 0.7;
/** Smarter armour: a division that found no strike worth it looks again after this many seconds. */
const ARMOR_QUIET_SECONDS = 4;
/** A division whose own land around it (over land) is under this many tiles is cut off (it breaks out). */
const CUT_OFF_TILES = 60;
/** Smarter armour looks this far (tiles) from its front for solid ground to hold when there is none near it. */
const ARMOR_HOLD_FAR = 40;
/** Smarter armour under a push holds where own land runs this many tiles out all round. */
const ARMOR_PRESSED_DEPTH = 6;
/** A division that ended a spearhead this recently (s) may still stand on its ground (Unit.ended). */
const ENDED_SECONDS = 60;

/**
 * Lines that cut (smarter armour, armorLevel >= 1): from own tiles within r of (cx, cy), the straight lines (8
 * directions) that cross CUT_MIN_CROSS..CUT_CROSS tiles of one nation at war with `me` and come out on own or allied
 * land or water, so the land on one side may be closed off: a thin strip, an enemy spearhead's band in our land, a
 * bulge to pinch off, the way from a spearhead's tip back to our line, the way to their coast. Each comes with the
 * size of the piece it would close off (pocketBeside; 0 = none found). Returns the tiles to click (2 tiles into their
 * land along the line, so the line keeps that direction), biggest pockets first, then longest crossings, at least 4
 * tiles apart, at most `max`. Pure read.
 */
export function cutClicks(state: GameState, me: number, cx: number, cy: number, r: number, max: number, shortest = false): { click: number; pocket: number }[] {
  const map = state.map;
  const { width: w, height: h, owner, terrain } = map;
  const found: { click: number; cross: number; pocket: number; k: number }[] = [];
  const foes = new Map<number, boolean>();
  const x0 = Math.max(0, Math.round(cx) - r);
  const x1 = Math.min(w - 1, Math.round(cx) + r);
  const y0 = Math.max(0, Math.round(cy) - r);
  const y1 = Math.min(h - 1, Math.round(cy) + r);
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const t = y * w + x;
      if (owner[t] !== me || isWater(terrain[t]) || d2(x, y, cx, cy) > r * r) continue;
      for (let k = 0; k < 8; k++) {
        const dx = DX8[k];
        const dy = DY8[k];
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const v = owner[ny * w + nx];
        if (v === me || v === 0 || isWater(terrain[ny * w + nx])) continue;
        let foe = foes.get(v);
        if (foe === undefined) foes.set(v, (foe = isFoe(state, me, v)));
        if (!foe) continue;
        let cut = false;
        let j = 2;
        for (; j <= CUT_CROSS + 1; j++) {
          const xx = x + dx * j;
          const yy = y + dy * j;
          if (xx < 0 || yy < 0 || xx >= w || yy >= h) break;
          const q = yy * w + xx;
          const o = owner[q];
          if (isWater(terrain[q]) || o === me || (o > 0 && o !== v && areAllied(state, me, o))) {
            cut = true;
            break;
          }
          if (o !== v) break;
        }
        const cross = j - 1;
        if (!cut || cross < CUT_MIN_CROSS) continue;
        found.push({ click: (y + 2 * dy) * w + x + 2 * dx, cross, pocket: -1, k });
      }
    }
  }
  // Longest crossings first for the pocket estimates (bounded work), then biggest pockets first; `shortest`: the
  // shortest crossings first (a way out), no pocket estimates. Lines in the same direction 4+ tiles apart, any two 2+.
  found.sort((a, b) => (shortest ? a.cross - b.cross : b.cross - a.cross) || a.click - b.click);
  const spaced: typeof found = [];
  for (const f of found) {
    if (spaced.length >= (shortest ? max : max * 3)) break;
    const fx = f.click % w;
    const fy = (f.click / w) | 0;
    const near = (c: (typeof found)[number]): number => Math.max(Math.abs((c.click % w) - fx), Math.abs(((c.click / w) | 0) - fy));
    if (spaced.some((c) => near(c) < 2 || (c.k === f.k && near(c) < 4))) continue;
    spaced.push(f);
  }
  if (shortest) return spaced.map((f) => ({ click: f.click, pocket: 0 }));
  for (const f of spaced) f.pocket = pocketBeside(state, me, f.click, owner[f.click]);
  spaced.sort((a, b) => b.pocket - a.pocket || b.cross - a.cross || a.click - b.click);
  return spaced.slice(0, max).map((f) => ({ click: f.click, pocket: f.pocket }));
}

/** pocketBeside: flood budget per side (tiles); a bigger piece counts as open. */
const POCKET_PEEK = 400;

/**
 * Rough size of the piece of `victim`'s land a cut through `click` would close off: the line from the nearest own
 * tile through it (3 tiles wide, as far as the victim's land runs) is taken out, and the victim's land on each side
 * next to it is flooded (4 directions, at most POCKET_PEEK tiles); a side that runs out of land without reaching the
 * capital is closed. The bigger closed side, 0 = none. Pure read; an estimate for scoring only (armor2.collapsePockets
 * decides what really falls).
 */
function pocketBeside(state: GameState, me: number, click: number, victim: number): number {
  const map = state.map;
  const { width: w, height: h, owner } = map;
  const cap = state.players[victim]?.capital ?? -1;
  // The line: from the own tile 2 tiles back (cutClicks' launch side) through the click, across the victim's land.
  let launch = -1;
  const cx = click % w;
  const cy = (click / w) | 0;
  for (let k = 0; k < 8 && launch < 0; k++) {
    const lx = cx - 2 * DX8[k];
    const ly = cy - 2 * DY8[k];
    const mx = cx - DX8[k];
    const my = cy - DY8[k];
    if (lx < 0 || ly < 0 || lx >= w || ly >= h) continue;
    if (owner[ly * w + lx] === me && owner[my * w + mx] === victim) launch = k;
  }
  if (launch < 0) return 0;
  const dx = DX8[launch];
  const dy = DY8[launch];
  const sc = scratch(state);
  const band = ++sc.stamp;
  let n = 0;
  let mid = -1;
  for (let j = -1; j <= CUT_CROSS + 1; j++) {
    const x = cx + dx * j;
    const y = cy + dy * j;
    if (x < 0 || y < 0 || x >= w || y >= h) break;
    if (j >= 0 && owner[y * w + x] !== victim) break;
    n++;
    for (let s2 = -1; s2 <= 1; s2++) {
      const bx = x - dy * s2;
      const by = y + dx * s2;
      if (bx >= 0 && by >= 0 && bx < w && by < h) sc.mark[by * w + bx] = band;
    }
  }
  if (n < 2) return 0;
  // The middle of the line (j from -1).
  const half = ((n / 2) | 0) - 1;
  mid = (cy + dy * half) * w + cx + dx * half;
  const mx = mid % w;
  const my = (mid / w) | 0;
  let best = 0;
  for (const side of [1, -1]) {
    const sx = mx - dy * 2 * side;
    const sy = my + dx * 2 * side;
    if (sx < 0 || sy < 0 || sx >= w || sy >= h) continue;
    const s0 = sy * w + sx;
    if (owner[s0] !== victim || sc.mark[s0] === band) continue;
    const seen = ++sc.stamp;
    const queue = sc.queue;
    queue.length = 0;
    queue.push(s0);
    sc.mark[s0] = seen;
    let open = false;
    for (let head = 0; head < queue.length && !open; head++) {
      const t = queue[head];
      if (t === cap || queue.length > POCKET_PEEK) {
        open = true;
        break;
      }
      const x = t % w;
      const y = (t / w) | 0;
      for (let k = 0; k < 4; k++) {
        const nx = x + DX4[k];
        const ny = y + DY4[k];
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const q = ny * w + nx;
        const m = sc.mark[q];
        if (owner[q] !== victim || m === band || m === seen) continue;
        sc.mark[q] = seen;
        queue.push(q);
      }
    }
    if (!open) best = Math.max(best, queue.length);
  }
  return best;
}

/** Scratch marks for pocketBeside (per game; a stamp per flood, so nothing needs clearing). Not game state. */
const scratches = new WeakMap<GameState, { mark: Int32Array; stamp: number; queue: number[] }>();
function scratch(state: GameState): { mark: Int32Array; stamp: number; queue: number[] } {
  let sc = scratches.get(state);
  if (!sc || sc.mark.length !== state.map.owner.length || sc.stamp > 0x7ffffff0) {
    sc = { mark: new Int32Array(state.map.owner.length), stamp: 0, queue: [] };
    scratches.set(state, sc);
  }
  return sc;
}

/** Enemy spearheads running into `me`'s land within r of (cx, cy): points 3 tiles along their line from its start. */
function enemySpearBases(state: GameState, me: number, cx: number, cy: number, r: number): { x: number; y: number }[] {
  const w = state.map.width;
  const out: { x: number; y: number }[] = [];
  for (const e of state.units) {
    if (e.type !== 'tankDivision' || e.hp <= 0 || e.state !== 3 || e.targetOwner !== me || e.launch === undefined || !isFoe(state, me, e.owner)) continue;
    const lx = e.launch % w;
    const ly = (e.launch / w) | 0;
    const dx = (e.target % w) - lx;
    const dy = ((e.target / w) | 0) - ly;
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len < 1e-9) continue;
    const bx = lx + (3 * dx) / len;
    const by = ly + (3 * dy) / len;
    if (d2(bx, by, cx, cy) <= r * r) out.push({ x: bx, y: by });
  }
  return out;
}


/**
 * Best spearhead for division u into enemy land within ARMOR_SUPPORT_RADIUS of `front` (null = none worth it):
 * up to 8 border tiles of nations at war with u's owner, scored by the preview's expected depth, + ARMOR_CUT_BONUS
 * when the head would get right across their land (a cut that encircles).
 */
export function bestStrike(state: GameState, u: Unit, front: number): Strike | null {
  const map = state.map;
  const { width: w, height: h, owner } = map;
  const me = u.owner;
  const fx = front % w;
  const fy = (front / w) | 0;
  const r = ARMOR_SUPPORT_RADIUS;
  const cands: { t: number; d: number }[] = [];
  for (let y = Math.max(0, fy - r); y <= Math.min(h - 1, fy + r); y++) {
    for (let x = Math.max(0, fx - r); x <= Math.min(w - 1, fx + r); x++) {
      const t = y * w + x;
      const o = owner[t];
      if (o === me || o === 0 || isWater(map.terrain[t])) continue;
      const d = d2(x, y, fx, fy);
      if (d > r * r) continue;
      // A border tile: own land next to it.
      if (!((x > 0 && owner[t - 1] === me) || (x < w - 1 && owner[t + 1] === me) || (y > 0 && owner[t - w] === me) || (y < h - 1 && owner[t + w] === me))) continue;
      if (!isFoe(state, me, o)) continue;
      cands.push({ t, d });
    }
  }
  if (!cands.length) return null;
  cands.sort((a, b) => a.d - b.d || a.t - b.t);
  const level = armorLevel(state, me);
  const picks: number[] = [];
  const bonus = new Map<number, number>();
  const n = Math.min(level >= 2 ? 8 : level >= 1 ? 6 : 8, cands.length);
  for (let k = 0; k < n; k++) picks.push(cands[Math.floor((k * cands.length) / n)].t);
  if (level >= 1) {
    // Smarter armour: lines that cut their land (pockets), and the base of an enemy spearhead running into ours
    // (cut off, its head is spent and the division at its tip overrun).
    // A cut scores the pocket it should close (a tenth of its tiles, at most 30) on top of ARMOR_CUT_BONUS.
    for (const b of enemySpearBases(state, me, fx, fy, r + 16)) {
      for (const c of cutClicks(state, me, b.x, b.y, 8, 2)) {
        if (!bonus.has(c.click)) picks.push(c.click);
        bonus.set(c.click, ARMOR_CUT_BONUS + Math.min(30, c.pocket / 10));
      }
    }
    for (const c of cutClicks(state, me, fx, fy, r, level >= 2 ? 4 : 3)) {
      if (bonus.has(c.click)) continue;
      if (!picks.includes(c.click)) picks.push(c.click);
      bonus.set(c.click, Math.min(30, c.pocket / 10));
    }
  }
  let best: Strike | null = null;
  for (const t of picks) {
    const pv = spearheadPreview(state, me, u.id, t);
    if (pv.reason) continue;
    const cut = lineCuts(state, me, owner[t], pv);
    let score = pv.expectedDepth + (cut ? ARMOR_CUT_BONUS + (bonus.get(t) ?? 0) : 0);
    // Smarter armour: a line that bleeds the division white far from a cut leaves it worn on a thin tip, where it is
    // overrun; Hard up weighs the strength left at the end.
    if (level >= 1 && !cut && (pv.endShare ?? 1) < 0.3) score = score * 0.6 - 4;
    if (level >= 2) score += 6 * (pv.endShare ?? 0);
    if (pv.expectedDepth < ARMOR_SUPPORT_MIN_DEPTH && !cut) continue;
    if (!best || score > best.score || (score === best.score && t < best.tile)) best = { tile: t, launch: pv.launch, score, cut };
  }
  return best;
}

/**
 * True when the previewed line gets right across `victim`'s land (it comes out on own / allied land or water with the
 * expected depth to get there): a cut that encircles, or a way out. `toOwn`: only own land counts as the way out.
 */
function lineCuts(state: GameState, me: number, victim: number, pv: SpearheadPreview, toOwn = false): boolean {
  const map = state.map;
  let enemy = 0;
  for (const q of pv.path) {
    const o = map.owner[q];
    if (o === victim && !isWater(map.terrain[q])) {
      enemy++;
      continue;
    }
    if (enemy === 0) continue;
    if (o === me || (!toOwn && (isWater(map.terrain[q]) || (o > 0 && areAllied(state, me, o))))) return pv.expectedDepth >= enemy;
    return false;
  }
  return false;
}

/** True when own land 8-connected to `t` (over land) is a piece of under CUT_OFF_TILES tiles. Pure read. */
function smallPiece(state: GameState, owner: number, t: number): boolean {
  const map = state.map;
  const { width: w, height: h } = map;
  const own = (q: number): boolean => map.owner[q] === owner && !isWater(map.terrain[q]);
  if (!own(t)) return false;
  const seen = new Set<number>([t]);
  const queue = [t];
  for (let head = 0; head < queue.length; head++) {
    if (queue.length >= CUT_OFF_TILES) return false;
    const cur = queue[head];
    const cx = cur % w;
    const cy = (cur / w) | 0;
    for (let k = 0; k < 8; k++) {
      const x = cx + DX8[k];
      const y = cy + DY8[k];
      if (x < 0 || y < 0 || x >= w || y >= h) continue;
      const q = y * w + x;
      if (seen.has(q) || !own(q)) continue;
      if (k >= 4 && !own(cy * w + x) && !own(y * w + cx)) continue;
      seen.add(q);
      queue.push(q);
    }
  }
  return true;
}

/**
 * Smarter armour, a division cut off on a small piece of our land (no way back over it): it breaks out along the
 * shortest line across the enemy's land back onto ours that it has the strength for, at any strength (overrun there,
 * it would be lost). True when it went.
 */
function breakOut(state: GameState, u: Unit): boolean {
  if (divisionStrength(u) < TANK_DISBAND_SHARE * 1.5) return false;
  let best: { t: number; d: number } | null = null;
  for (const c of cutClicks(state, u.owner, u.x, u.y, 4, 6, true)) {
    const pv = spearheadPreview(state, u.owner, u.id, c.click);
    if (pv.reason || !lineCuts(state, u.owner, state.map.owner[c.click], pv, true)) continue;
    if (!best || pv.expectedDepth < best.d) best = { t: c.click, d: pv.expectedDepth };
  }
  return !!best && moveTankDivisions(state, u.owner, [u.id], best.t).ok;
}

/**
 * Divisions that strike with u toward `tile` (smarter armour): u first, then other divisions of its owner on support,
 * holding, ready (ARMOR_SUPPORT_READY) and not waiting on a failed route, within ARMOR_SUPPORT_RADIUS + 12 tiles of
 * the tile (state.units order), at most GROUP_MAX in all. One order sends them side by side (tanks.moveTankDivisions).
 */
function strikeGroup(state: GameState, u: Unit, tile: number, ready = ARMOR_SUPPORT_READY): number[] {
  const w = state.map.width;
  const tx = tile % w;
  const ty = (tile / w) | 0;
  const r = ARMOR_SUPPORT_RADIUS + 12;
  const ids = [u.id];
  for (const o of state.units) {
    if (ids.length >= GROUP_MAX) break;
    if (o === u || o.type !== 'tankDivision' || o.hp <= 0 || o.owner !== u.owner || o.state !== 0 || divisionMode(o) !== 'support') continue;
    if (divisionStrength(o) < ready || (o.retryTick ?? 0) > state.tick || d2(o.x, o.y, tx, ty) > r * r) continue;
    ids.push(o.id);
  }
  return ids;
}

/** Another division of u's owner on support driving up to within ARMOR_SUPPORT_RADIUS + 12 tiles of `tile` (Hard up waits for it). */
function companionComing(state: GameState, u: Unit, tile: number): boolean {
  const w = state.map.width;
  const r = ARMOR_SUPPORT_RADIUS + 12;
  for (const o of state.units) {
    if (o === u || o.type !== 'tankDivision' || o.hp <= 0 || o.owner !== u.owner || o.state !== 1 || divisionMode(o) !== 'support') continue;
    if (divisionStrength(o) < ARMOR_SUPPORT_READY) continue;
    if (d2(o.target % w, (o.target / w) | 0, tile % w, (tile / w) | 0) <= r * r) return true;
  }
  return false;
}

/**
 * Smarter armour on a spearhead's thin tip (own land under 3 tiles deep around it; an AI division any time, a player's
 * within ENDED_SECONDS of its spearhead's end, unless the player moved it since): a ready one strikes on from there
 * along a line that cuts their land, else it pulls back to a hold tile behind its front. True when it acted.
 */
function leaveTip(state: GameState, u: Unit): boolean {
  const here = unitTile(state, u);
  if (interiorAt(state, u.owner, here)) return false;
  const fresh = u.ended !== undefined && state.tick - u.ended <= ENDED_SECONDS * TICKS_PER_SECOND;
  // A player's division only right after its spearhead (else it stays where it is), unless it is cut off.
  if (state.players[u.owner]?.isHuman && !fresh) return smallPiece(state, u.owner, here) && breakOut(state, u);
  if (fresh && divisionStrength(u) >= ARMOR_SUPPORT_READY) {
    let best: { t: number; score: number } | null = null;
    for (const c of cutClicks(state, u.owner, u.x, u.y, 6, 4)) {
      const pv = spearheadPreview(state, u.owner, u.id, c.click);
      if (pv.reason || pv.expectedDepth < CUT_MIN_CROSS) continue;
      const score = pv.expectedDepth + c.pocket / 10;
      if (!best || score > best.score) best = { t: c.click, score };
    }
    if (best && moveTankDivisions(state, u.owner, [u.id], best.t).ok) return true;
  }
  // Cut off on a small piece of our land: it breaks out back to our line.
  if (smallPiece(state, u.owner, here)) return breakOut(state, u);
  delete u.ended;
  const hold = holdTileNear(state, u.owner, u.station ?? here, undefined, 3, ARMOR_HOLD_FAR);
  if (hold < 0 || hold === here) return false;
  // Back over our land (the quick search, then a flood of our land: driveTo).
  return driveTo(state, u, hold, true, true);
}

/**
 * One tick for a division that isn't spearheading (state 0 holding or 1 driving): refit once a second while holding;
 * support / refit modes think every ARMOR_SUPPORT_SCAN_SECONDS (staggered by id).
 */
export function divisionStep(state: GameState, u: Unit): void {
  const slot = (state.tick + u.id) % TICKS_PER_SECOND === 0;
  if (slot && u.state === 0) refit(state, u);
  const mode = divisionMode(u);
  if (slot && u.ended !== undefined && state.tick - u.ended > ENDED_SECONDS * TICKS_PER_SECOND) delete u.ended;
  // Smarter armour: off a spearhead's thin tip at once (checked every second, every tick for the first 3 s after the
  // spearhead), striking on along a cut when ready. AI divisions in any mode but refit, a player's on support.
  const human = !!state.players[u.owner]?.isHuman;
  const tipMode = mode === 'support' || (!human && mode === 'hold');
  const justEnded = u.ended !== undefined && state.tick - u.ended <= 3 * TICKS_PER_SECOND;
  const due = u.ended !== undefined ? slot : (state.tick + u.id) % (3 * TICKS_PER_SECOND) === 0; // else every 3 s
  if ((due || justEnded) && u.state === 0 && tipMode && armorLevel(state, u.owner) >= 1 && leaveTip(state, u)) return;
  if (mode === 'hold') return;
  const every = Math.max(1, Math.round(ARMOR_SUPPORT_SCAN_SECONDS * TICKS_PER_SECOND));
  if ((state.tick + u.id * 7) % every !== 0) return;
  const s = divisionStrength(u);
  if (mode === 'refit') {
    if (u.state !== 0) return;
    if (s >= 1 - 1e-6) {
      u.mode = 'hold';
      return;
    }
    if (!nearFactory(state, u)) {
      const f = nearestFactory(state, u.owner, unitTile(state, u));
      if (f < 0 || !driveTo(state, u, f, true, armorLevel(state, u.owner) >= 1)) u.mode = 'hold';
    }
    return;
  }
  // support
  if (unitFollows(state, u)) followFront(state, u);
  const front = u.station;
  if (front === undefined) {
    if (!unitFollows(state, u)) u.mode = 'hold'; // following with no war target: holds where it is
    return;
  }
  if (u.state === 1) return; // on its way (to the front or to a Factory)
  const level = armorLevel(state, u.owner);
  // Worn down: refit at a Factory first (or in place without one). Smarter armour also pulls a division under
  // ARMOR_SMART_READY back to a Factory nearby (it refits five times as fast there) and stays there until nearly full.
  const atFactory = nearFactory(state, u);
  const ready = level >= 1 ? ARMOR_SMART_READY : ARMOR_SUPPORT_READY;
  if ((s < ARMOR_SUPPORT_REFIT || (level >= 1 && s < ready)) && !atFactory) {
    const f = nearestFactory(state, u.owner, unitTile(state, u));
    const w0 = state.map.width;
    const close = f >= 0 && d2(u.x, u.y, f % w0, (f / w0) | 0) <= ARMOR_REFIT_TRIP * ARMOR_REFIT_TRIP;
    if (f >= 0 && (s < ARMOR_SUPPORT_REFIT || close) && driveTo(state, u, f, true, level >= 1)) return;
  }
  if (atFactory && s < (level >= 1 ? ARMOR_SMART_FULL : ARMOR_SUPPORT_READY)) return; // refitting
  if (s < ARMOR_SUPPORT_REFIT) return; // no Factory to reach: refits slowly where it is
  const w = state.map.width;
  const near = d2(u.x, u.y, front % w, (front / w) | 0) <= (ARMOR_SUPPORT_RADIUS + 12) * (ARMOR_SUPPORT_RADIUS + 12);
  if (s >= ARMOR_SUPPORT_READY && near && (u.retryTick ?? 0) <= state.tick) {
    let strike = bestStrike(state, u, front);
    // Smarter armour: nothing worth it here now and it holds in place; look again in ARMOR_QUIET_SECONDS (the scan is
    // the costly part).
    const inPlace = d2(u.x, u.y, front % w, (front / w) | 0) <= (ARMOR_SUPPORT_HOLD + 6) * (ARMOR_SUPPORT_HOLD + 6);
    if (!strike && level >= 1 && inPlace) u.retryTick = state.tick + ARMOR_QUIET_SECONDS * TICKS_PER_SECOND;
    // Smarter armour: under ARMOR_SMART_READY only a line that cuts their land is worth it (a straight one would leave
    // the division bled white on a thin tip).
    if (strike && !strike.cut && s < ready) strike = null;
    let wait = false;
    if (strike) {
      // A cheap route check first (moveTankDivisions searches with the full budget).
      if (ownLandPath(state, u.owner, unitTile(state, u), strike.launch, ARMOR_AUTO_PATH_BUDGET, hasAmphibious(state, u.owner) ? (t) => narrowWater(state, t) : undefined)) {
        // Smarter armour: the ready divisions near the strike go in together, side by side; from Hard up an AI
        // division alone waits for one driving up (unless the line cuts their land: that won't wait).
        const ids = level >= 1 ? strikeGroup(state, u, strike.tile, strike.cut ? ARMOR_SUPPORT_READY : ready) : [u.id];
        wait = ids.length === 1 && level >= 2 && !state.players[u.owner]?.isHuman && !strike.cut && companionComing(state, u, strike.tile);
        if (!wait && moveTankDivisions(state, u.owner, ids, strike.tile).ok) return;
      }
    }
    if (strike && !wait) {
      // A player's following division near a front on land it can't reach (another piece of ours): support a front it
      // can reach for a while instead of retrying the same strike all war.
      if (u.detour === undefined && state.players[u.owner]?.isHuman && unitFollows(state, u)) {
        const from = unitTile(state, u);
        const prev = landFlood(state, u.owner, from);
        if (!floodTouches(state, prev, front)) {
          const hold = startDetour(state, u, prev);
          if (hold >= 0) {
            if (hold !== from) driveTo(state, u, hold, true);
            return;
          }
        }
      }
      u.retryTick = state.tick + ARMOR_RETRY_SECONDS * TICKS_PER_SECOND; // no route to the launch tile
      return;
    }
  }
  // Nothing to strike yet: hold just behind the front. An AI division left out on a limb (a spearhead's tip, our land
  // under 3 tiles deep around it) pulls back to a hold tile at once, even right after falling back: 61% of overrun AI
  // divisions were caught there within a minute of a spearhead.
  const fresh = u.ended !== undefined && state.tick - u.ended <= ENDED_SECONDS * TICKS_PER_SECOND;
  const exposed = u.state === 0 && (!human || fresh) && !interiorAt(state, u.owner, unitTile(state, u));
  // Smarter armour with a nation at war with us that close (land within TANK_FALLBACK_RADIUS): it holds deeper (own
  // land ARMOR_PRESSED_DEPTH tiles out all round), even right after falling back, rather than wait at the edge to be
  // rolled over by every wave of theirs.
  const pressed = level >= 1 && u.state === 0 && foeNear(state, u);
  const deep = !pressed || interiorAt(state, u.owner, unitTile(state, u), ARMOR_PRESSED_DEPTH);
  if (d2(u.x, u.y, front % w, (front / w) | 0) <= (ARMOR_SUPPORT_HOLD + 6) * (ARMOR_SUPPORT_HOLD + 6) && u.state === 0 && !exposed && deep) return;
  if ((u.retryTick ?? 0) > state.tick && !exposed && deep) return;
  const hold = holdTileNear(state, u.owner, front, undefined, pressed ? ARMOR_PRESSED_DEPTH : 3, level >= 1 ? ARMOR_HOLD_FAR : 0);
  if (hold >= 0 && hold !== unitTile(state, u)) driveTo(state, u, hold, !exposed && deep);
}

/**
 * Follow my war: moves a following division's front to the main front against its owner's war target. With no
 * shared border (a war overseas) it supports the nearest front of another war of ours, else holds where it is. On a
 * detour (the main front can't be reached over our land, driveTo) it keeps the front it can reach until the detour
 * ends, then tries the main front again.
 */
function followFront(state: GameState, u: Unit): void {
  const foe = followedNation(state, u.owner);
  if (foe <= 0) return; // no war target: keep the front it has (or hold where it is)
  const st = u.station;
  const owners = state.map.owner;
  if (u.detour !== undefined) {
    if (u.detour > state.tick && st !== undefined && (owners[st] === u.owner || isFoe(state, u.owner, owners[st]))) return;
    delete u.detour;
  }
  let f = mainFront(state, u.owner, foe);
  if (f < 0) {
    f = otherFront(state, u, foe);
    if (f < 0) {
      u.station = undefined; // nothing to support over land: hold where it is
      return;
    }
  }
  if (f === st) return;
  const w = state.map.width;
  // Keep a front that is still that nation's land (or ours: the push went past it) near the front.
  if (st !== undefined) {
    const o = owners[st];
    if ((o === owners[f] || o === u.owner) && d2(st % w, (st / w) | 0, f % w, (f / w) | 0) <= FOLLOW_KEEP * FOLLOW_KEEP) return;
  }
  u.station = f; // a drive under way ends first; the next think holds behind the new front
}

/** The border tile nearest division u of another nation its owner fights (nations first, lower id); -1 = none. */
function otherFront(state: GameState, u: Unit, foe: number): number {
  const w = state.map.width;
  for (const n of liveFoes(state, u.owner)) {
    if (n === foe) continue;
    let best = -1;
    let bestD = Infinity;
    for (const t of frontTiles(state, u.owner, n, 4000)) {
      const d = d2(t % w, (t / w) | 0, u.x, u.y);
      if (d < bestD || (d === bestD && t < best)) {
        bestD = d;
        best = t;
      }
    }
    if (best >= 0) return best;
  }
  return -1;
}

// ---------------------------------------------------------------------------------------------------------------
// AI
// ---------------------------------------------------------------------------------------------------------------

/** AI divisions: a counter-strike needs this expected depth (tiles); below AI_STAY_STRENGTH a pressed one refits. */
const AI_COUNTER_MIN_DEPTH = 4;
const AI_STAY_STRENGTH = 0.6;
/** A division farther than this (tiles) from the main front supports the foe's border tile nearest it (Normal up). */
const AI_FRONT_NEAR = 60;
/** A holding division is pressed when land of a nation attacking its owner is this close (tiles). */
const AI_PRESSED_RADIUS = TANK_FALLBACK_RADIUS;

/**
 * The nation pushing into AI division u: one with an attack on u's owner running whose land is within
 * AI_PRESSED_RADIUS of it (nations only; the nearest such tile's owner, ties: lower tile). 0 = none. Pure read.
 */
export function pressedBy(state: GameState, u: Unit): number {
  const me = u.owner;
  const attackers = new Set<number>();
  for (const a of state.attacks) if (a.target === me && a.attacker > 0 && !isTribe(state.players[a.attacker]) && isFoe(state, me, a.attacker)) attackers.add(a.attacker);
  if (!attackers.size) return 0;
  return nearestOf(state, u, attackers, AI_PRESSED_RADIUS).owner;
}

/** Land of a nation at war with u's owner within TANK_FALLBACK_RADIUS of division u. Pure read. */
function foeNear(state: GameState, u: Unit): boolean {
  const foes = new Set<number>();
  for (const q of state.players) if (q && q.id > 0 && q.id !== u.owner && q.alive && isFoe(state, u.owner, q.id)) foes.add(q.id);
  return foes.size > 0 && nearestOf(state, u, foes, AI_PRESSED_RADIUS).tile >= 0;
}

/** Nearest tile owned by one of `owners` within r of division u: its tile and owner (-1 / 0 = none). */
function nearestOf(state: GameState, u: Unit, owners: Set<number>, r: number): { tile: number; owner: number } {
  const map = state.map;
  const { width: w, height: h, owner } = map;
  const cx = Math.round(u.x);
  const cy = Math.round(u.y);
  let best = -1;
  let bestD = r * r + 1;
  for (let y = Math.max(0, cy - r); y <= Math.min(h - 1, cy + r); y++) {
    for (let x = Math.max(0, cx - r); x <= Math.min(w - 1, cx + r); x++) {
      const t = y * w + x;
      if (!owners.has(owner[t]) || isWater(map.terrain[t])) continue;
      const d = d2(x, y, cx, cy);
      if (d < bestD || (d === bestD && t < best)) {
        bestD = d;
        best = t;
      }
    }
  }
  return best >= 0 ? { tile: best, owner: owner[best] } : { tile: -1, owner: 0 };
}

/**
 * The war AI `id` is in between attack waves (Normal up): the nation at war with it (naval2.atWar) whose land most of
 * its support divisions' fronts are on (ties: lower id), else the first nation at war with it it borders (ids
 * ascending, tribes last). 0 = none.
 */
function liveFoe(state: GameState, id: number, mine: readonly Unit[], skip = 0): number {
  const owner = state.map.owner;
  const votes = new Map<number, number>();
  for (const u of mine) {
    if (divisionMode(u) !== 'support' || u.station === undefined) continue;
    const o = owner[u.station];
    if (o !== id && o !== skip && isFoe(state, id, o)) votes.set(o, (votes.get(o) ?? 0) + 1);
  }
  let best = 0;
  let bestN = 0;
  for (const [o, n] of votes) {
    if (n > bestN || (n === bestN && o < best)) {
      best = o;
      bestN = n;
    }
  }
  if (best) return best;
  const tribes: number[] = [];
  for (const q of state.players) {
    if (!q || q.id <= 0 || q.id === id || q.id === skip || !q.alive || !isFoe(state, id, q.id)) continue;
    if (isTribe(q)) tribes.push(q.id);
    else if (frontTiles(state, id, q.id, 1).length) return q.id;
  }
  for (const t of tribes) if (frontTiles(state, id, t, 1).length) return t;
  return 0;
}

/** Where a pressed division strikes back into q: q's land nearest it. -1 = none. */
function counterTile(state: GameState, u: Unit, q: number): number {
  return nearestOf(state, u, new Set([q]), AI_PRESSED_RADIUS + 4).tile;
}

/**
 * AI nations (tanks.aiTankDivisions, on decision ticks, through applyAction): put the divisions on 'support' at the
 * front of the war it fights hardest (they then strike weak spots and cut pockets by themselves and refit between
 * strikes). Turtles keep theirs holding at home.
 */
export function aiDivisionModes(state: GameState, id: number, act: (a: Action) => ActionResult): void {
  const p = state.players[id];
  if (!p || !p.alive || p.isHuman || isTribe(p)) return;
  let mine = state.units.filter((u) => u.type === 'tankDivision' && u.owner === id && u.hp > 0 && u.state !== 3).sort((a, b) => a.id - b.id);
  if (!mine.length) return;
  const level = aiAttackLevel(state);
  // Under a push: a holding division about to be rolled over strikes back into the attacker when it is strong enough
  // and the line looks worth it (Normal and up), else drives back to refit at a Factory, deeper inside, rather than
  // fall back again and again until it is overrun (93% of overrun AI divisions were holding against an enemy attack).
  const handled = new Set<number>();
  const toRefit = (u: Unit): boolean => nearestFactory(state, id, unitTile(state, u)) >= 0 && !nearFactory(state, u) && act({ type: 'setDivisionMode', unitIds: [u.id], mode: 'refit' }).ok;
  for (const u of mine) {
    if (u.state !== 0 || divisionMode(u) === 'refit') continue;
    const s = divisionStrength(u);
    const q = pressedBy(state, u);
    if (q <= 0) {
      // Worn out and holding (a spearhead's leftovers): back to a Factory to refit.
      if (divisionMode(u) === 'hold' && s < ARMOR_SUPPORT_REFIT && toRefit(u)) handled.add(u.id);
      continue;
    }
    const turtle = p.personality === 'turtle';
    if (level >= 1 && s >= ARMOR_SUPPORT_READY) {
      // The best line near it first (a cut through the push's flank or across an enemy spearhead's base beats a
      // straight hit), else straight into the attacker's land nearest it; the ready divisions nearby go with it.
      // Turtles only cut (they win back the ground an enemy spearhead took).
      const st = bestStrike(state, u, unitTile(state, u));
      let t = st && (st.cut || (!turtle && st.score >= AI_COUNTER_MIN_DEPTH)) ? st.tile : -1;
      if (t < 0 && !turtle) {
        t = counterTile(state, u, q);
        if (t >= 0 && spearheadPreview(state, id, u.id, t).expectedDepth < AI_COUNTER_MIN_DEPTH) t = -1;
      }
      const ids = t >= 0 ? strikeGroup(state, u, t).filter((k) => !handled.has(k)) : [];
      if (t >= 0 && act({ type: 'moveTankDivision', unitIds: ids, tile: t }).ok) {
        for (const k of ids) handled.add(k);
        continue;
      }
    }
    if ((s < AI_STAY_STRENGTH || p.personality === 'turtle') && toRefit(u)) handled.add(u.id);
  }
  mine = mine.filter((u) => !handled.has(u.id) && divisionMode(u) !== 'refit');
  if (!mine.length || p.personality === 'turtle') return;
  // The war we fight with the most troops (nations before tribes), either way; from Normal up our own attacks count
  // double a defence (the divisions join our push rather than wait to be overrun behind a front we only hold).
  let foe = 0;
  let foeScore = 0;
  for (const a of state.attacks) {
    const other = a.attacker === id ? a.target : a.target === id ? a.attacker : 0;
    if (other <= 0 || !isFoe(state, id, other)) continue;
    const score = total(a.troops) * (isTribe(state.players[other]) ? 0.3 : 1) * (a.attacker !== id && level >= 1 ? 0.5 : 1);
    if (score > foeScore || (score === foeScore && other < foe)) {
      foe = other;
      foeScore = score;
    }
  }
  const w = state.map.width;
  const owner = state.map.owner;
  // From Normal up, between two waves of attacks (they last about a second) the war is still on (naval2.atWar): the
  // divisions keep the front they support instead of standing down to hold wherever they are until the next wave.
  if (!foe && level >= 1) foe = liveFoe(state, id, mine);
  if (!foe) {
    // No war: keep holding (and refitting) where they are.
    const ids = mine.filter((u) => divisionMode(u) === 'support').map((u) => u.id);
    if (ids.length) act({ type: 'setDivisionMode', unitIds: ids, mode: 'hold' });
    return;
  }
  let tiles = frontTiles(state, id, foe);
  if (!tiles.length && level >= 1) {
    // The war we fight hardest is overseas (landings): the divisions support a war we fight over land instead.
    const alt = liveFoe(state, id, mine, foe);
    if (alt) {
      foe = alt;
      tiles = frontTiles(state, id, foe);
    }
  }
  // Front tile: the main front, the foe's border tile nearest the focus of the biggest attack between us (either way;
  // ties: lower id); without one, nearest the first division.
  let focus = -1;
  let focusTroops = 0;
  let focusId = Infinity;
  for (const a of state.attacks) {
    if (!((a.attacker === id && a.target === foe) || (a.attacker === foe && a.target === id))) continue;
    const tr = total(a.troops);
    if (tr > focusTroops || (tr === focusTroops && a.id < focusId)) {
      focus = a.focusTile;
      focusTroops = tr;
      focusId = a.id;
    }
  }
  const lead = mine[0];
  const ax = focus >= 0 ? focus % w : lead.x;
  const ay = focus >= 0 ? (focus / w) | 0 : lead.y;
  const nearest = (x: number, y: number): number => {
    let best = -1;
    let bestD = Infinity;
    for (const t of tiles) {
      const d = d2(t % w, (t / w) | 0, x, y);
      if (d < bestD || (d === bestD && t < best)) {
        bestD = d;
        best = t;
      }
    }
    return best;
  };
  const front = nearest(ax, ay);
  if (front < 0) return;
  // Which front tile each division supports: the main front; from Normal up the foe's border tile nearest the division
  // when the main front is far from it (attacks advance along the whole border, so a strike anywhere on it joins the
  // push, and the main front is often out of reach over our land: AI divisions sat idle far from it).
  const frontFor = (u: Unit): number => {
    if (level < 1 || d2(u.x, u.y, front % w, (front / w) | 0) <= AI_FRONT_NEAR * AI_FRONT_NEAR) return front;
    return nearest(u.x, u.y);
  };
  const jobs = new Map<number, number[]>();
  for (const u of mine) {
    if (level >= 1 && u.detour !== undefined && u.detour > state.tick && divisionMode(u) === 'support') continue; // on a detour (driveTo)
    const f = frontFor(u);
    if (f < 0) continue;
    if (divisionMode(u) === 'support' && u.station !== undefined) {
      const st = u.station;
      const o = owner[st];
      // A foe's tile or our own (the front moved on) near its front: keep it; elsewhere they jump to it.
      if ((o === foe || o === id) && d2(st % w, (st / w) | 0, f % w, (f / w) | 0) <= 40 * 40) continue;
    }
    let l = jobs.get(f);
    if (!l) jobs.set(f, (l = []));
    l.push(u.id);
  }
  for (const [f, ids] of jobs) act({ type: 'setDivisionMode', unitIds: ids, mode: 'support', front: f });
}
