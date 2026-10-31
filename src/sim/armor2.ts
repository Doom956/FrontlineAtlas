// Tank divisions, part two: reusable divisions (refit), veterancy, encirclement and the 'support front' mode.
// (tanks.ts keeps building, driving, spearheads, previews, defence and the first AI.)
//
// - Refit: a holding division below full strength takes troops back from the home pool every second:
//   ARMOR_REFIT_FACTORY of a full division per second near an own finished Factory, ARMOR_REFIT_FIELD elsewhere.
// - Veterancy: a spearhead taking at least ARMOR_VET_MIN_TILES tiles adds them (and encircled pockets / 10) as xp;
//   levels at ARMOR_VET_XP give a faster, deeper head and lower losses (vetSpeedMul, vetLossMul).
// - Encirclement (collapsePockets): pieces of the target's land next to a spearhead's line that are cut off (closed by
//   the attacker's / its allies' land, water and the map edge; no capital) collapse to the attacker at once.
// - Modes (Unit.mode, Action setDivisionMode): hold (default), support (Unit.station = the front tile: holds behind
//   it, launches spearheads into the weakest spot within ARMOR_SUPPORT_RADIUS when ready, lines that cut the enemy's
//   land first; drives back to refit at a Factory when worn down), refit (to the nearest Factory, refit, then hold).
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
  ARMOR_SUPPORT_HOLD_DEPTH,
  ARMOR_SUPPORT_MIN_DEPTH,
  ARMOR_SUPPORT_RADIUS,
  ARMOR_SUPPORT_READY,
  ARMOR_SUPPORT_REFIT,
  ARMOR_SUPPORT_SCAN_SECONDS,
  ARMOR_SUPPORT_SETTLE_INTERIOR,
  ARMOR_VET_LOSS,
  ARMOR_VET_MIN_TILES,
  ARMOR_VET_SPEED,
  ARMOR_VET_XP,
  TANK_DIVISION_TROOPS,
  TANK_PER_FACTORY_LEVEL,
  TANK_SPEARHEAD_WIDTH,
  TICKS_PER_SECOND,
} from './config';
import { areAllied } from './diplomacy';
import { atWar } from './naval2';
import { ownGroup } from './navy';
import { atPeace } from './rules';
import { addEvent } from './state';
import { hasTech } from './tech';
import { moveTankDivisions, ownLandPath, spearheadPreview } from './tanks';
import { hasAmphibious, narrowWater } from './specials';
import { armorPocketKillMul, armorPocketMul, armorRefitMul } from './variants';
import { DIVISION_MODES, TROOP_TYPES, isTribe, isWater } from './types';
import type { Action, ActionResult, DivisionMode, GameState, Troops, Unit } from './types';

const FAIL = (reason: string): ActionResult => ({ ok: false, reason });
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

function driveTo(state: GameState, u: Unit, dest: number, auto = false): boolean {
  if (auto && (u.retryTick ?? 0) > state.tick) return false;
  // Automatic drives search less and wait ARMOR_RETRY_SECONDS after a failed route (an unreachable front / Factory).
  const path = ownLandPath(state, u.owner, unitTile(state, u), dest, auto ? ARMOR_AUTO_PATH_BUDGET : undefined);
  if (!path) {
    if (auto) u.retryTick = state.tick + ARMOR_RETRY_SECONDS * TICKS_PER_SECOND;
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
 * Action setDivisionMode: hold / support (needs `front`, a land tile at or near a front of yours) / refit (drives
 * to the nearest own Factory). Divisions in a spearhead take the mode when it ends.
 */
export function setDivisionMode(state: GameState, playerId: number, unitIds: unknown, mode: unknown, front?: number): ActionResult {
  if (typeof mode !== 'string' || !(DIVISION_MODES as readonly string[]).includes(mode)) return FAIL('Unknown mode');
  const group = ownGroup(state, playerId, unitIds, 'tankDivision', 'tank divisions');
  if (typeof group === 'string') return FAIL(group);
  const map = state.map;
  if (mode === 'support') {
    if (front === undefined || !Number.isInteger(front) || front < 0 || front >= map.owner.length) return FAIL('Pick the front to support');
    if (isWater(map.terrain[front])) return FAIL('Pick a land tile at the front');
  }
  if (mode === 'refit' && nearestFactory(state, playerId, unitTile(state, group[0])) < 0) return FAIL('You need a finished Factory to refit at');
  for (const u of group) {
    u.mode = mode as DivisionMode;
    u.station = mode === 'support' ? front : undefined;
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

/** Own land ARMOR_SUPPORT_HOLD_DEPTH tiles out from (x, y) in all 4 directions: not the tip of a salient. */
function interiorAt(state: GameState, owner: number, x: number, y: number): boolean {
  const map = state.map;
  const { width: w, height: h } = map;
  const own = (x: number, y: number): boolean => x >= 0 && y >= 0 && x < w && y < h && map.owner[y * w + x] === owner && !isWater(map.terrain[y * w + x]);
  const k = ARMOR_SUPPORT_HOLD_DEPTH;
  return own(x, y) && own(x + k, y) && own(x - k, y) && own(x, y + k) && own(x, y - k);
}

/** Own land tile to hold behind `front`: interior (own land ARMOR_SUPPORT_HOLD_DEPTH tiles out in all 4 directions), nearest the front. */
function holdTileNear(state: GameState, owner: number, front: number): number {
  const map = state.map;
  const { width: w, height: h } = map;
  const fx = front % w;
  const fy = (front / w) | 0;
  const r = ARMOR_SUPPORT_HOLD + 12;
  const own = (x: number, y: number): boolean => x >= 0 && y >= 0 && x < w && y < h && map.owner[y * w + x] === owner && !isWater(map.terrain[y * w + x]);
  let best = -1;
  let bestD = Infinity;
  let fallback = -1;
  let fallbackD = Infinity;
  for (let y = Math.max(0, fy - r); y <= Math.min(h - 1, fy + r); y++) {
    for (let x = Math.max(0, fx - r); x <= Math.min(w - 1, fx + r); x++) {
      if (!own(x, y)) continue;
      const d = d2(x, y, fx, fy);
      if (d > r * r) continue;
      const t = y * w + x;
      if (d < fallbackD) {
        fallbackD = d;
        fallback = t;
      }
      if (d >= bestD) continue;
      if (!interiorAt(state, owner, x, y)) continue;
      best = t;
      bestD = d;
    }
  }
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
  const picks: number[] = [];
  const n = Math.min(8, cands.length);
  for (let k = 0; k < n; k++) picks.push(cands[Math.floor((k * cands.length) / n)].t);
  let best: Strike | null = null;
  for (const t of picks) {
    const pv = spearheadPreview(state, me, u.id, t);
    if (pv.reason) continue;
    const victim = owner[t];
    let enemy = 0;
    let cut = false;
    for (const q of pv.path) {
      const o = owner[q];
      if (o === victim && !isWater(map.terrain[q])) {
        enemy++;
        continue;
      }
      if (enemy === 0) continue;
      if (o === me || isWater(map.terrain[q]) || (o > 0 && areAllied(state, me, o))) cut = pv.expectedDepth >= enemy;
      break;
    }
    const score = pv.expectedDepth + (cut ? ARMOR_CUT_BONUS : 0);
    if (pv.expectedDepth < ARMOR_SUPPORT_MIN_DEPTH && !cut) continue;
    if (!best || score > best.score || (score === best.score && t < best.tile)) best = { tile: t, launch: pv.launch, score };
  }
  return best;
}

/**
 * One tick for a division that isn't spearheading (state 0 holding or 1 driving): refit once a second while holding;
 * support / refit modes think every ARMOR_SUPPORT_SCAN_SECONDS (staggered by id).
 */
export function divisionStep(state: GameState, u: Unit): void {
  const slot = (state.tick + u.id) % TICKS_PER_SECOND === 0;
  if (slot && u.state === 0) refit(state, u);
  const mode = divisionMode(u);
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
      if (f < 0 || !driveTo(state, u, f, true)) u.mode = 'hold';
    }
    return;
  }
  // support
  const front = u.station;
  if (front === undefined) {
    u.mode = 'hold';
    return;
  }
  if (u.state === 1) return; // on its way (to the front or to a Factory)
  // Worn down: refit at a Factory first (or in place without one).
  if (s < ARMOR_SUPPORT_REFIT && !nearFactory(state, u)) {
    const f = nearestFactory(state, u.owner, unitTile(state, u));
    if (f >= 0 && driveTo(state, u, f, true)) return;
  }
  if (s < ARMOR_SUPPORT_READY) {
    if (nearFactory(state, u)) return; // refitting
    if (s < ARMOR_SUPPORT_REFIT) return; // no Factory to reach: refits slowly where it is
  }
  const w = state.map.width;
  const near = d2(u.x, u.y, front % w, (front / w) | 0) <= (ARMOR_SUPPORT_RADIUS + 12) * (ARMOR_SUPPORT_RADIUS + 12);
  if (s >= ARMOR_SUPPORT_READY && near && (u.retryTick ?? 0) <= state.tick) {
    const strike = bestStrike(state, u, front);
    if (strike) {
      // A cheap route check first (moveTankDivisions searches with the full budget).
      if (ownLandPath(state, u.owner, unitTile(state, u), strike.launch, ARMOR_AUTO_PATH_BUDGET, hasAmphibious(state, u.owner) ? (t) => narrowWater(state, t) : undefined) && moveTankDivisions(state, u.owner, [u.id], strike.tile).ok) return;
      u.retryTick = state.tick + ARMOR_RETRY_SECONDS * TICKS_PER_SECOND; // no route to the launch tile
      return;
    }
  }
  // Nothing to strike yet: hold just behind the front, on interior land (not left at the tip of the last spearhead,
  // where the first counter-push overruns it).
  const settled = u.state === 0 && (!ARMOR_SUPPORT_SETTLE_INTERIOR || interiorAt(state, u.owner, Math.round(u.x), Math.round(u.y)));
  if (d2(u.x, u.y, front % w, (front / w) | 0) <= (ARMOR_SUPPORT_HOLD + 6) * (ARMOR_SUPPORT_HOLD + 6) && settled) return;
  if ((u.retryTick ?? 0) > state.tick) return;
  const hold = holdTileNear(state, u.owner, front);
  if (hold >= 0 && hold !== unitTile(state, u)) driveTo(state, u, hold, true);
}

// ---------------------------------------------------------------------------------------------------------------
// AI
// ---------------------------------------------------------------------------------------------------------------

/**
 * AI nations (tanks.aiTankDivisions, on decision ticks, through applyAction): put the divisions on 'support' at the
 * front of the war it fights hardest (they then strike weak spots and cut pockets by themselves and refit between
 * strikes). Turtles keep theirs holding at home.
 */
export function aiDivisionModes(state: GameState, id: number, act: (a: Action) => ActionResult): void {
  const p = state.players[id];
  if (!p || !p.alive || p.isHuman || isTribe(p)) return;
  const mine = state.units.filter((u) => u.type === 'tankDivision' && u.owner === id && u.hp > 0 && u.state !== 3).sort((a, b) => a.id - b.id);
  if (!mine.length || p.personality === 'turtle') return;
  // The war we fight with the most troops (nations before tribes), either way.
  let foe = 0;
  let foeScore = 0;
  for (const a of state.attacks) {
    const other = a.attacker === id ? a.target : a.target === id ? a.attacker : 0;
    if (other <= 0 || !isFoe(state, id, other)) continue;
    const score = total(a.troops) * (isTribe(state.players[other]) ? 0.3 : 1);
    if (score > foeScore || (score === foeScore && other < foe)) {
      foe = other;
      foeScore = score;
    }
  }
  const w = state.map.width;
  const owner = state.map.owner;
  if (!foe) {
    // No war: keep holding (and refitting) where they are.
    const ids = mine.filter((u) => divisionMode(u) === 'support').map((u) => u.id);
    if (ids.length) act({ type: 'setDivisionMode', unitIds: ids, mode: 'hold' });
    return;
  }
  // Front tile: the foe's border tile nearest the first division (a sample of the shared border).
  const lead = mine[0];
  let front = -1;
  let bestD = Infinity;
  for (const t of frontTiles(state, id, foe, 64)) {
    const d = d2(t % w, (t / w) | 0, lead.x, lead.y);
    if (d < bestD || (d === bestD && t < front)) {
      bestD = d;
      front = t;
    }
  }
  if (front < 0) return;
  const stale = mine.filter((u) => {
    if (divisionMode(u) !== 'support' || u.station === undefined) return true;
    const st = u.station;
    const o = owner[st];
    // Still a foe's tile, or our own near the front (the front moved on): keep it.
    if (o === foe) return false;
    return d2(st % w, (st / w) | 0, front % w, (front / w) | 0) > 40 * 40;
  });
  if (stale.length) act({ type: 'setDivisionMode', unitIds: stale.map((u) => u.id), mode: 'support', front });
}
