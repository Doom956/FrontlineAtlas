// Warships, part three: stances, shore bombardment, blockades, escorts, veterancy and the AI's use of them.
// (units.ts keeps movement and gunnery, navy.ts building, auto-intercept and group moves.)
//
// Stances (Unit.stance, Action setUnitStance; absent = 'auto'):
//   auto      intercepts enemy ships near its post (navy.interceptStep); when none are around and its owner is at war,
//             sails to enemy coast within NAVY_AUTO_BOMBARD_REACH of its post (near its fronts first) and shells it;
//             goes back to its post when that war is over
//   hunt      intercepts over a wide zone (NAVY_HUNT_DETECT / NAVY_HUNT_LEASH)
//   escort    sticks to own transports (first) and trade ships: an escorted ship takes x NAVY_ESCORT_DAMAGE damage
//   bombard   parks off an enemy coast (at war) and shells it harder (NAVY_BOMBARD_STANCE_KILL); never chases
//   blockade  parks off an enemy port (at war); never chases
//   hold      stays at its post: sinks enemy ships near it like auto, but never sails off to shell a coast
// Follow my war (warTarget.ts): a player's ships aim bombard / blockade / auto at the owner's war target first (other
// wars when it has no coast or port in reach); a stance set with a target tile pins them to that nation (Unit.fixed:
// only it) until the player picks Follow again. Ships on station move to the target's coast when it changes. AI-owned
// ships keep their own logic (any war).
// Warship states used here (units.ts / navy.ts have 0 patrol, 1 ordered, 2 chasing): 3 = on station (Unit.station
// = the coast / port tile it covers; sailing there or parked), 4 = escorting (Unit.station = the escorted ship's id).
//
// Effects on the fronts (combat.ts asks): enemy land within NAVY_SUPPORT_RANGE of an own warship is cheaper and faster
// to take and counts as supplied (navalSupportAt); landings next to warships get a beachhead bonus
// (navalBeachheadMul); a blockaded port (an enemy warship at war within NAVY_BLOCKADE_RANGE) earns less trade,
// its region is badly supplied (blockadeSupplyMul / blockadedAt) and its trade ships are captured (captureTrade).
// Veterancy: xp for sinking ships and shelling; levels give +1 max hp and more damage (shipDamageMul).
// Deterministic: no RNG here; scans staggered by unit id; per-tick caches are rebuilt from the state on first use.
import { buildingAt, buildingsOf } from './buildings';
import {
  MAX_GROUP_UNITS,
  NAVY_WAR_MEMORY,
  NAVY_AUTO_BOMBARD_REACH,
  NAVY_BEACHHEAD_LOSS,
  NAVY_BLOCKADE_RANGE,
  NAVY_BLOCKADE_SUPPLY,
  NAVY_BLOCKADE_SUPPLY_RADIUS,
  NAVY_BLOCKADE_TRADE_CUT,
  NAVY_BOMBARD_STANCE_KILL,
  NAVY_CAP_BASE,
  NAVY_CAP_PER_PORT_LEVEL,
  NAVY_CAPTURE_GOLD,
  NAVY_CARRIER_SUPPORT_RANGE,
  NAVY_ESCORT_DAMAGE,
  NAVY_ESCORT_MAX,
  NAVY_ESCORT_PICK,
  NAVY_ESCORT_RADIUS,
  NAVY_ESCORT_SPEED,
  NAVY_HUNT_DETECT,
  NAVY_HUNT_LEASH,
  NAVY_PORT_BUILD_SPEED,
  NAVY_PORT_REPAIR,
  NAVY_STATION_DIST,
  NAVY_STATION_SEEK,
  NAVY_SUB_BLOCKADE_RANGE,
  NAVY_SUB_CAPTURE,
  NAVY_SUPPORT_BONUS,
  NAVY_SUPPORT_DIMINISH,
  NAVY_SUPPORT_MAX,
  NAVY_SUPPORT_RANGE,
  NAVY_THINK_TICKS,
  NAVY_VET_DAMAGE,
  NAVY_VET_XP,
  NAVY_XP_SHELL_PER_S,
  NAVY_XP_SINK,
  TICK_SECONDS,
  TICKS_PER_SECOND,
  UNITS,
  WARSHIP_DETECT_RANGE,
  WARSHIP_LEASH,
} from './config';
import { areAllied } from './diplomacy';
import { sameWater, waterPath } from './grid';
import { interceptStep, ownGroup } from './navy';
import { shipWarTarget } from './warTarget';
import { atPeace } from './rules';
import { addEvent } from './state';
import { hasTech } from './tech';
import {
  navalBlockadeMul,
  navalCaptureMul,
  navalDamageMul,
  navalDetectMul,
  navalExtraHp,
  navalExtraShips,
  navalReachMul,
  navalShellMul,
  navalSpeedMul,
  navalSupportMul,
  navalXpMul,
} from './variants';
import { WARSHIP_STANCES, isTribe, isWater } from './types';
import type { Action, ActionResult, GameState, Unit, WarshipStance } from './types';

const FAIL = (reason: string): ActionResult => ({ ok: false, reason });

function d2(ax: number, ay: number, bx: number, by: number): number {
  const dx = ax - bx;
  const dy = ay - by;
  return dx * dx + dy * dy;
}
function shipTile(state: GameState, u: Unit): number {
  if (u.path.length) return u.path[Math.min(u.pathPos, u.path.length - 1)];
  return Math.round(u.y) * state.map.width + Math.round(u.x);
}
function hostile(state: GameState, a: number, b: number): boolean {
  return a !== b && a > 0 && b > 0 && !areAllied(state, a, b) && !atPeace(state, a, b);
}

/** A warship's stance ('auto' when none was set). */
export function warshipStance(u: Unit): WarshipStance {
  return u.stance ?? 'auto';
}

// ---------------------------------------------------------------------------------------------------------------
// Per-tick cache: warship positions per owner, nations at war, blockaded ports
// ---------------------------------------------------------------------------------------------------------------

interface NavyCache {
  tick: number;
  n: number;
  /** owner -> [x, y, support range x, blockade range x, ...] of its alive warships (variants.ts: per-ship reach) */
  ships: Map<number, number[]>;
  /** a * 1024 + b for every pair with an attack running (both orders) */
  wars: Set<number>;
  /** blockades, built on first use: port owner -> [x, y, blockader, ...] of its blockaded ports */
  blockaded: Map<number, number[]> | null;
}
const caches = new WeakMap<GameState, NavyCache>();
/**
 * Drops the navy cache (ships, wars, blockades). The client reads it between ticks with the next tick's number (atWar,
 * blockadedPorts, portBlockadedBy: forces, spend and ally panels), before that tick's actions start attacks and its
 * mines sink ships: called with combat.clearArmyCache when the sim starts work (sim.tick, actions.applyAction), so
 * rendering and non-rendering clients stay in lockstep. Free: the cache is keyed by tick, so it is rebuilt every tick.
 */
export function clearNavyCache(state: GameState): void {
  caches.delete(state);
}

function cache(state: GameState): NavyCache {
  let c = caches.get(state);
  if (c && c.tick === state.tick && c.n === state.units.length) return c;
  const ships = new Map<number, number[]>();
  for (const u of state.units) {
    if (u.type !== 'warship' || u.hp <= 0) continue;
    let l = ships.get(u.owner);
    if (!l) ships.set(u.owner, (l = []));
    l.push(u.x, u.y, navalSupportMul(u), navalBlockadeMul(u));
  }
  const wars = new Set<number>();
  for (const a of state.attacks) {
    if (a.target <= 0) continue;
    const t = a.troops;
    if (t.infantry + t.armor + t.artillery <= 0) continue;
    wars.add(a.attacker * 1024 + a.target);
    wars.add(a.target * 1024 + a.attacker);
  }
  const wm = state.warMemory;
  if (wm) {
    for (let k = 0; k < wm.length; k += 3) {
      if (wm[k + 2] <= state.tick) continue;
      wars.add(wm[k] * 1024 + wm[k + 1]);
      wars.add(wm[k + 1] * 1024 + wm[k]);
    }
  }
  c = { tick: state.tick, n: state.units.length, ships, wars, blockaded: null };
  caches.set(state, c);
  return c;
}

/**
 * Keeps state.warMemory: every second, pairs with an attack running get NAVY_WAR_MEMORY more seconds; expired pairs
 * and pairs that became allies are dropped. Called every tick from sim.ts (after the attacks).
 */
export function updateWarMemory(state: GameState): void {
  if (state.tick % TICKS_PER_SECOND !== 0) return;
  const until = state.tick + NAVY_WAR_MEMORY * TICKS_PER_SECOND;
  let wm = state.warMemory;
  for (const a of state.attacks) {
    if (a.target <= 0 || a.attacker <= 0) continue;
    const t = a.troops;
    if (t.infantry + t.armor + t.artillery <= 0) continue;
    const lo = Math.min(a.attacker, a.target);
    const hi = Math.max(a.attacker, a.target);
    wm ??= state.warMemory = [];
    let found = false;
    for (let k = 0; k < wm.length; k += 3) {
      if (wm[k] === lo && wm[k + 1] === hi) {
        wm[k + 2] = until;
        found = true;
        break;
      }
    }
    if (!found) wm.push(lo, hi, until);
  }
  if (!wm || !wm.length) return;
  const keep: number[] = [];
  for (let k = 0; k < wm.length; k += 3) {
    const pa = state.players[wm[k]];
    const pb = state.players[wm[k + 1]];
    if (wm[k + 2] <= state.tick || !pa?.alive || !pb?.alive || areAllied(state, wm[k], wm[k + 1])) continue;
    keep.push(wm[k], wm[k + 1], wm[k + 2]);
  }
  if (keep.length) state.warMemory = keep;
  else delete state.warMemory;
}

/** Pairs at war now (a * 1024 + b, both orders): attacks running plus the recent-war memory. Do not modify. */
export function warSet(state: GameState): Set<number> {
  return cache(state).wars;
}

/** True while a and b are at war (an attack running between them, or recently) and not allied / at peace. */
export function atWar(state: GameState, a: number, b: number): boolean {
  return cache(state).wars.has(a * 1024 + b) && hostile(state, a, b);
}

/** Blockade range of `owner`'s ships (x each ship's variant: submarines reach further, variants.ts). */
function blockadeRange(state: GameState, owner: number): number {
  void state;
  void owner;
  void NAVY_SUB_BLOCKADE_RANGE; // the submarine variant's ARSENAL.naval.submarine.blockade replaces it
  return NAVY_BLOCKADE_RANGE;
}

function blockades(state: GameState): Map<number, number[]> {
  const c = cache(state);
  if (c.blockaded) return c.blockaded;
  const out = new Map<number, number[]>();
  c.blockaded = out;
  if (!c.ships.size || !c.wars.size) return out;
  const w = state.map.width;
  for (const b of state.buildings.values()) {
    if (b.type !== 'port' || b.owner <= 0) continue;
    const bx = b.tile % w;
    const by = (b.tile / w) | 0;
    let by0 = 0;
    // The lowest blockader id at war with the port's owner that has a ship in range.
    for (const [owner, l] of c.ships) {
      if (owner === b.owner || (by0 && owner > by0) || !c.wars.has(owner * 1024 + b.owner) || !hostile(state, owner, b.owner)) continue;
      const r = blockadeRange(state, owner);
      for (let k = 0; k < l.length; k += 4) {
        const rr = r * l[k + 3];
        if (d2(l[k], l[k + 1], bx, by) <= rr * rr) {
          by0 = owner;
          break;
        }
      }
    }
    if (!by0) continue;
    let l = out.get(b.owner);
    if (!l) out.set(b.owner, (l = []));
    l.push(bx, by, by0);
  }
  return out;
}

/** The player blockading the port on `portTile` (0 = not blockaded). */
export function portBlockadedBy(state: GameState, portTile: number): number {
  const b = buildingAt(state, portTile);
  if (!b || b.type !== 'port') return 0;
  const l = blockades(state).get(b.owner);
  if (!l) return 0;
  const w = state.map.width;
  const x = portTile % w;
  const y = (portTile / w) | 0;
  for (let k = 0; k < l.length; k += 3) if (l[k] === x && l[k + 1] === y) return l[k + 2];
  return 0;
}

/** Ports of playerId that are blockaded now (tiles). */
export function blockadedPorts(state: GameState, playerId: number): number[] {
  const l = blockades(state).get(playerId);
  if (!l) return [];
  const w = state.map.width;
  const out: number[] = [];
  for (let k = 0; k < l.length; k += 3) out.push(l[k + 1] * w + l[k]);
  return out;
}

/** True when tile lies within NAVY_BLOCKADE_SUPPLY_RADIUS of a blockaded port of playerId. */
export function blockadedAt(state: GameState, playerId: number, tile: number): boolean {
  if (playerId <= 0) return false;
  const c = cache(state);
  if (!c.ships.size || !c.wars.size) return false;
  const l = blockades(state).get(playerId);
  if (!l) return false;
  const w = state.map.width;
  const x = tile % w;
  const y = (tile / w) | 0;
  const r2 = NAVY_BLOCKADE_SUPPLY_RADIUS * NAVY_BLOCKADE_SUPPLY_RADIUS;
  for (let k = 0; k < l.length; k += 3) if (d2(l[k], l[k + 1], x, y) <= r2) return true;
  return false;
}

/** Supply x this for playerId's attacks at tile (NAVY_BLOCKADE_SUPPLY near its blockaded ports, else 1). */
export function blockadeSupplyMul(state: GameState, playerId: number, tile: number): number {
  return blockadedAt(state, playerId, tile) ? NAVY_BLOCKADE_SUPPLY : 1;
}

/** Trade gold x this for `owner` whose port is `portTile` (a blockaded port earns less). */
export function blockadeTradeMul(state: GameState, owner: number, portTile: number): number {
  if (owner <= 0) return 1;
  const c = cache(state);
  if (!c.ships.size || !c.wars.size) return 1;
  return portBlockadedBy(state, portTile) ? 1 - NAVY_BLOCKADE_TRADE_CUT : 1;
}

// ---------------------------------------------------------------------------------------------------------------
// Shore bombardment and landings
// ---------------------------------------------------------------------------------------------------------------

/** Base support range of `owner`'s ships (Naval Mastery reaches further; each ship's variant scales it: variants.ts). */
function supportRange(state: GameState, owner: number): number {
  void NAVY_CARRIER_SUPPORT_RANGE; // the carrier variant's ARSENAL.naval.carrier.support replaces it
  return NAVY_SUPPORT_RANGE * navalReachMul(state, owner);
}

/** Own warships of `owner` within its support range of tile. */
export function supportingShips(state: GameState, owner: number, tile: number): number {
  if (owner <= 0) return 0;
  const l = cache(state).ships.get(owner);
  if (!l) return 0;
  const w = state.map.width;
  const x = tile % w;
  const y = (tile / w) | 0;
  const r = supportRange(state, owner);
  let n = 0;
  for (let k = 0; k < l.length; k += 4) {
    const rr = r * l[k + 2];
    if (rr > 0 && d2(l[k], l[k + 1], x, y) <= rr * rr) n++;
  }
  return n;
}

/** Bonus for n supporting ships: NAVY_SUPPORT_BONUS, each further ship x NAVY_SUPPORT_DIMINISH, capped. */
export function supportBonusFor(n: number): number {
  let b = 0;
  let step = NAVY_SUPPORT_BONUS;
  for (let k = 0; k < n && k < 12; k++) {
    b += step;
    step *= NAVY_SUPPORT_DIMINISH;
  }
  return Math.min(NAVY_SUPPORT_MAX, b);
}

/**
 * Shore bombardment bonus for attacker's fight at tile (0 = no own warship in range): combat.tileCost divides the
 * defence by 1 + bonus, speeds the front up and counts the tile as supplied.
 */
export function navalSupportAt(state: GameState, attacker: number, tile: number): number {
  if (attacker <= 0 || isWater(state.map.terrain[tile])) return 0;
  const l = cache(state).ships.get(attacker);
  if (!l) return 0;
  return supportBonusFor(supportingShips(state, attacker, tile));
}

/** A landing at tile: its beachhead loss x this (NAVY_BEACHHEAD_LOSS next to an own warship, else 1). */
export function navalBeachheadMul(state: GameState, attacker: number, tile: number): number {
  return supportingShips(state, attacker, tile) > 0 ? NAVY_BEACHHEAD_LOSS : 1;
}

// ---------------------------------------------------------------------------------------------------------------
// Gunnery hooks (units.ts)
// ---------------------------------------------------------------------------------------------------------------

/** Escorts of ship s: own (or allied) warships escorting it within NAVY_ESCORT_RADIUS. */
function escorted(state: GameState, s: Unit): boolean {
  if (s.type === 'warship') return false;
  const r2 = NAVY_ESCORT_RADIUS * NAVY_ESCORT_RADIUS;
  for (const e of state.units) {
    if (e.type !== 'warship' || e.hp <= 0 || e.state !== 4 || e.station !== s.id) continue;
    if (d2(e.x, e.y, s.x, s.y) <= r2) return true;
  }
  return false;
}

/** Damage of warship u against ship target x this: u's veterancy, target's escort. */
export function shipDamageMul(state: GameState, u: Unit, target: Unit): number {
  let m = (1 + NAVY_VET_DAMAGE * (u.vet ?? 0)) * navalDamageMul(u, target); // variants (variants.ts)
  if (target.type !== 'warship' && escorted(state, target)) m *= NAVY_ESCORT_DAMAGE;
  return m;
}

/** Shelling by warship u for dt seconds: kill multiplier of its stance (and veterancy xp). */
export function shellingMul(state: GameState, u: Unit, dt: number): number {
  gainXp(state, u, NAVY_XP_SHELL_PER_S * dt);
  return (warshipStance(u) === 'bombard' ? NAVY_BOMBARD_STANCE_KILL : 1) * navalShellMul(u); // variants (variants.ts)
}

/** Warship speed x this (escorts keep up with transports). */
export function warshipSpeedMul(u: Unit): number {
  return (u.state === 4 ? NAVY_ESCORT_SPEED : 1) * navalSpeedMul(u); // variants (variants.ts)
}

/** Max hp of a warship (base + 1 per veterancy level). */
export function warshipMaxHp(u: Unit): number {
  return UNITS.warship.hp + (u.vet ?? 0) + navalExtraHp(u); // variants (variants.ts)
}

function gainXp(state: GameState, u: Unit, xp: number): void {
  u.xp = (u.xp ?? 0) + xp * navalXpMul(state, u.owner); // Naval Mastery (variants.ts)
  const lvl = u.vet ?? 0;
  if (lvl < NAVY_VET_XP.length && u.xp >= NAVY_VET_XP[lvl]) {
    u.vet = lvl + 1;
    u.hp += 1;
    const p = state.players[u.owner];
    if (p?.isHuman) addEvent(state, 'info', `A warship reached veteran level ${u.vet}`, [u.owner], shipTile(state, u));
  }
}

/**
 * Warship u is about to sink ship `target` (units.ts calls this on the killing blow): veterancy xp; a trade ship of
 * a nation u's owner blockades (or shot by a ship in blockade stance) is captured: its cargo goes to u's owner.
 * Returns the gold taken (0 = none).
 */
export function onShipKilled(state: GameState, u: Unit, target: Unit): number {
  gainXp(state, u, NAVY_XP_SINK);
  if (target.type !== 'tradeShip') return 0;
  const owner = u.owner;
  const victim = target.owner;
  let blockading = warshipStance(u) === 'blockade';
  if (!blockading) {
    const l = blockades(state).get(victim);
    if (l) for (let k = 2; k < l.length && !blockading; k += 3) blockading = l[k] === owner;
  }
  if (!blockading) return 0;
  const p = state.players[owner];
  if (!p || !p.alive) return 0;
  void NAVY_SUB_CAPTURE;
  const gold = target.cargo * NAVY_CAPTURE_GOLD * navalCaptureMul(u); // submarines capture richer cargo (variants.ts)
  p.gold += gold;
  p.stats.goldEarned += gold;
  target.cargo = 0;
  if (p.isHuman || state.players[victim]?.isHuman) {
    addEvent(state, 'info', `${p.name} captured a trade ship of ${state.players[victim].name} (${Math.round(gold)} gold)`, [owner, victim], shipTile(state, target));
  }
  return gold;
}

// ---------------------------------------------------------------------------------------------------------------
// Fleet size and build speed (navy.ts asks)
// ---------------------------------------------------------------------------------------------------------------

/** Warships playerId may have (alive + being built): NAVY_CAP_BASE + NAVY_CAP_PER_PORT_LEVEL per finished port level. */
export function warshipLimit(state: GameState, playerId: number): number {
  let levels = 0;
  for (const b of buildingsOf(state, playerId, 'port')) if (b.owner === playerId && b.buildLeft <= 0) levels += b.level;
  return NAVY_CAP_BASE + NAVY_CAP_PER_PORT_LEVEL * levels + navalExtraShips(state, playerId); // Naval Mastery
}
/** Warships playerId has (alive + being built). */
export function warshipCount(state: GameState, playerId: number): number {
  let n = 0;
  for (const u of state.units) if (u.type === 'warship' && u.owner === playerId && u.hp > 0) n++;
  for (const q of state.unitQueue ?? []) if (q.type === 'warship' && q.owner === playerId) n++;
  return n;
}
/** Build time x this at a port of `level` (higher ports build faster). */
export function portBuildMul(level: number): number {
  return 1 / (1 + NAVY_PORT_BUILD_SPEED * Math.max(0, level - 1));
}

// ---------------------------------------------------------------------------------------------------------------
// Action setUnitStance
// ---------------------------------------------------------------------------------------------------------------

/**
 * Action setUnitStance: sets the stance of own warships; they act on it at their next think. target = a tile of the
 * nation to pin them to (Fixed); follow = true: back to Follow my war; neither: they keep their current choice.
 */
export function setUnitStance(state: GameState, playerId: number, unitIds: unknown, stance: unknown, target?: number, follow?: boolean): ActionResult {
  if (typeof stance !== 'string' || !(WARSHIP_STANCES as readonly string[]).includes(stance)) return FAIL('Unknown stance');
  if (follow !== undefined && typeof follow !== 'boolean') return FAIL('Invalid value');
  const group = ownGroup(state, playerId, unitIds, 'warship', 'warships');
  if (typeof group === 'string') return FAIL(group);
  let pin = 0;
  if (target !== undefined && follow !== true) {
    if (!Number.isInteger(target) || target < 0 || target >= state.map.owner.length) return FAIL('Invalid tile');
    pin = state.map.owner[target];
    if (pin <= 0 || pin === playerId || !state.players[pin]?.alive) return FAIL('Pick a tile of the nation to aim at');
    if (areAllied(state, playerId, pin)) return FAIL('That nation is your ally');
  }
  for (const u of group) {
    u.stance = stance as WarshipStance;
    if (pin > 0) u.fixed = pin;
    else if (follow === true) delete u.fixed;
    if (u.state === 3 || u.state === 4) {
      // Off station / escort duty: back to patrolling; the next think picks a new task.
      u.state = 0;
      u.station = undefined;
      u.path = [];
      u.pathPos = 0;
    }
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------------------------------------------
// Stance behaviour (units.updateWarship calls warshipThink before it moves)
// ---------------------------------------------------------------------------------------------------------------

function sail(state: GameState, u: Unit, to: number, maxLen: number): boolean {
  const from = shipTile(state, u);
  if (from === to) {
    u.path = [];
    u.pathPos = 0;
    u.target = to;
    return true;
  }
  const path = waterPath(state.map, from, to, maxLen, 6000);
  if (!path || !path.length) return false;
  u.path = path;
  u.pathPos = 0;
  u.target = path[path.length - 1];
  return true;
}

/** Back to the post (Unit.cargo): state 1 (on arrival it patrols there again). */
function backToPost(state: GameState, u: Unit): void {
  u.station = undefined;
  if (sail(state, u, u.cargo, 4 * WARSHIP_LEASH)) {
    u.state = 1;
    return;
  }
  u.state = 0;
  u.path = [];
  u.pathPos = 0;
  u.cargo = shipTile(state, u);
}

/** Water tile within NAVY_STATION_DIST of `coast` in u's sea, nearest to the coast (then to u), or -1. */
function stationWater(state: GameState, u: Unit, coast: number): number {
  const map = state.map;
  const w = map.width;
  const from = shipTile(state, u);
  const cx = coast % w;
  const cy = (coast / w) | 0;
  let best = -1;
  let bestD = Infinity;
  let bestU = Infinity;
  const r = NAVY_STATION_DIST;
  for (let dy = -r; dy <= r; dy++) {
    const y = cy + dy;
    if (y < 0 || y >= map.height) continue;
    for (let dx = -r; dx <= r; dx++) {
      const x = cx + dx;
      if (x < 0 || x >= w) continue;
      const d = dx * dx + dy * dy;
      if (d > r * r || d > bestD) continue;
      const t = y * w + x;
      if (!isWater(map.terrain[t]) || !sameWater(map, from, t)) continue;
      const du = d2(x, y, u.x, u.y);
      if (d < bestD || du < bestU || (du === bestU && t < best)) {
        best = t;
        bestD = d;
        bestU = du;
      }
    }
  }
  return best;
}

/** True when `coast` is still a coast tile of a nation u's owner is at war with. */
function validBombard(state: GameState, u: Unit, coast: number): boolean {
  const map = state.map;
  if (coast < 0 || coast >= map.owner.length || !map.coastal[coast]) return false;
  const o = map.owner[coast];
  return o > 0 && atWar(state, u.owner, o);
}
function validBlockade(state: GameState, u: Unit, port: number): boolean {
  const b = buildingAt(state, port);
  return !!b && b.type === 'port' && atWar(state, u.owner, b.owner);
}

/** Score added to coast / ports of other nations than the one a ship aims at (warTarget.ts): any of its own wins. */
const OFF_TARGET = 1e6;

/**
 * Best enemy coast tile to shell for u within `reach` of (cx, cy): coast of nations at war with u's owner, in u's sea,
 * the nation it aims at first (`aim`, warTarget.shipWarTarget; with `only` nothing else), near the owner's own land
 * (the front) first, then near the ship. -1 = none.
 */
function pickCoast(state: GameState, u: Unit, cx: number, cy: number, reach: number, aim = 0, only = false): number {
  const c = cache(state);
  if (!c.wars.size) return -1;
  const map = state.map;
  const w = map.width;
  const h = map.height;
  const owner = map.owner;
  const me = u.owner;
  const from = shipTile(state, u);
  let best = -1;
  let bestScore = Infinity;
  const r = Math.ceil(reach);
  const x0 = Math.max(0, Math.round(cx) - r);
  const x1 = Math.min(w - 1, Math.round(cx) + r);
  const y0 = Math.max(0, Math.round(cy) - r);
  const y1 = Math.min(h - 1, Math.round(cy) + r);
  // A checkerboard (half the tiles): it still meets every coastline at least every second tile.
  for (let y = y0; y <= y1; y++) {
    for (let x = x0 + ((x0 + y + u.id) & 1); x <= x1; x += 2) {
      const t = y * w + x;
      if (!map.coastal[t]) continue;
      const o = owner[t];
      if (o <= 0 || o === me || !c.wars.has(me * 1024 + o)) continue;
      if (only && o !== aim) continue;
      if (d2(x, y, cx, cy) > reach * reach) continue;
      let score = Math.sqrt(d2(x, y, u.x, u.y)) + (aim > 0 && o !== aim ? OFF_TARGET : 0);
      // Next to our land (3 tiles out in the 4 directions): that is where our fronts are.
      if ((x > 2 && owner[t - 3] === me) || (x < w - 3 && owner[t + 3] === me) || (y > 2 && owner[t - 3 * w] === me) || (y < h - 3 && owner[t + 3 * w] === me)) score -= 40;
      if (score >= bestScore || !hostile(state, me, o)) continue;
      // Reachable by sea from here: some water next to it shares our sea.
      if (!((x > 0 && isWater(map.terrain[t - 1]) && sameWater(map, from, t - 1)) || (x < w - 1 && isWater(map.terrain[t + 1]) && sameWater(map, from, t + 1)) ||
        (y > 0 && isWater(map.terrain[t - w]) && sameWater(map, from, t - w)) || (y < h - 1 && isWater(map.terrain[t + w]) && sameWater(map, from, t + w)))) continue;
      best = t;
      bestScore = score;
    }
  }
  return best;
}

/** Nearest enemy port (at war) within `reach` of the ship, in its sea (`aim`'s first; with `only` nothing else); -1 = none. */
function pickPort(state: GameState, u: Unit, reach: number, aim = 0, only = false): number {
  const c = cache(state);
  if (!c.wars.size) return -1;
  const w = state.map.width;
  const from = shipTile(state, u);
  let best = -1;
  let bestD = Infinity;
  const r2 = reach * reach;
  for (const b of state.buildings.values()) {
    if (b.type !== 'port' || b.owner <= 0 || b.owner === u.owner || !c.wars.has(u.owner * 1024 + b.owner)) continue;
    if (only && b.owner !== aim) continue;
    const raw = d2(b.tile % w, (b.tile / w) | 0, u.x, u.y);
    if (raw > r2) continue;
    const d = raw + (aim > 0 && b.owner !== aim ? OFF_TARGET : 0);
    if (d > bestD || (d === bestD && best >= 0 && b.tile > best)) continue;
    if (!hostile(state, u.owner, b.owner) || stationWaterFor(state, from, b.tile) < 0) continue;
    best = b.tile;
    bestD = d;
  }
  return best;
}
function stationWaterFor(state: GameState, from: number, coast: number): number {
  const map = state.map;
  const w = map.width;
  const cx = coast % w;
  const cy = (coast / w) | 0;
  for (let r = 1; r <= NAVY_STATION_DIST; r++) {
    for (const [dx, dy] of [[r, 0], [-r, 0], [0, r], [0, -r]] as const) {
      const x = cx + dx;
      const y = cy + dy;
      if (x < 0 || y < 0 || x >= w || y >= map.height) continue;
      const t = y * w + x;
      if (isWater(map.terrain[t]) && sameWater(map, from, t)) return t;
    }
  }
  return -1;
}

/** Takes up station off `tile` (a coast or port tile): state 3. False when no water there can be reached. */
function goStation(state: GameState, u: Unit, tile: number, maxLen: number): boolean {
  const water = stationWater(state, u, tile);
  if (water < 0 || !sail(state, u, water, maxLen)) return false;
  u.state = 3;
  u.station = tile;
  u.chase = 0;
  u.chaseLost = 0;
  return true;
}

function escortsOf(state: GameState, id: number): number {
  let n = 0;
  for (const e of state.units) if (e.type === 'warship' && e.hp > 0 && e.state === 4 && e.station === id) n++;
  return n;
}

/** Escort: the own transport (first) or trade ship to stick to, nearest within NAVY_ESCORT_PICK; null = none. */
function pickEscorted(state: GameState, u: Unit): Unit | null {
  const r2 = NAVY_ESCORT_PICK * NAVY_ESCORT_PICK;
  let best: Unit | null = null;
  let bestRank = 9;
  let bestD = Infinity;
  for (const s of state.units) {
    if (s.owner !== u.owner || s.hp <= 0 || (s.type !== 'transport' && s.type !== 'tradeShip')) continue;
    const rank = s.type === 'transport' ? 0 : 1;
    if (rank > bestRank) continue;
    const d = d2(s.x, s.y, u.x, u.y);
    if (d > r2 || (rank === bestRank && d >= bestD)) continue;
    if (!sameWater(state.map, shipTile(state, u), shipTile(state, s))) continue;
    if (escortsOf(state, s.id) >= NAVY_ESCORT_MAX) continue;
    best = s;
    bestRank = rank;
    bestD = d;
  }
  return best;
}

/** Where an escort heads: a few tiles ahead on the escorted ship's route. */
function escortAim(s: Unit, state: GameState): number {
  if (s.path.length) return s.path[Math.min(s.path.length - 1, s.pathPos + 4)];
  return Math.round(s.y) * state.map.width + Math.round(s.x);
}

const ESCORT_FOLLOW_TICKS = 5;
/** Ships on station off another nation than their aim look for the aim's coast every this many thinks. */
const FOLLOW_RECHECK_THINKS = 3;

/**
 * One warship's stance logic, called by units.updateWarship every tick before it moves (most work only every
 * NAVY_THINK_TICKS, staggered by id). Replaces navy.interceptStep there (auto and hunt call it).
 */
export function warshipThink(state: GameState, u: Unit, ships: readonly Unit[], wars: Set<number>): void {
  const st = warshipStance(u);
  // Only auto / hunt / hold chase ships: a chase left over from before a stance change ends here.
  if (u.state === 2 && st !== 'auto' && st !== 'hunt' && st !== 'hold') {
    u.state = 0;
    u.chase = 0;
    u.chaseLost = 0;
    u.path = [];
    u.pathPos = 0;
  }
  // Escorts re-aim often (their charge moves fast).
  if (u.state === 4) {
    if ((state.tick + u.id) % ESCORT_FOLLOW_TICKS !== 0) return;
    const s = u.station !== undefined ? state.units.find((q) => q.id === u.station) : undefined;
    if (st !== 'escort' || !s || s.hp <= 0 || s.owner !== u.owner) {
      // Its charge landed, sank or got home: the escort stays on post right here (it supports the landing).
      u.state = 0;
      u.station = undefined;
      u.path = [];
      u.pathPos = 0;
      u.cargo = shipTile(state, u);
      return;
    }
    if (d2(s.x, s.y, u.x, u.y) > 4) sail(state, u, escortAim(s, state), 4 * NAVY_ESCORT_PICK);
    else {
      u.path = [];
      u.pathPos = 0;
    }
    return;
  }
  if (st === 'auto' || st === 'hunt' || st === 'hold') {
    const hunt = st === 'hunt';
    interceptStep(state, u, ships, wars, (hunt ? NAVY_HUNT_DETECT : WARSHIP_DETECT_RANGE) * navalDetectMul(u), hunt ? NAVY_HUNT_LEASH : WARSHIP_LEASH);
    if (u.state === 1 || u.state === 2) return;
  }
  if ((state.tick + u.id * 3) % NAVY_THINK_TICKS !== 0) return;
  repairAtPort(state, u);
  if (u.state === 1 || u.state === 2) return; // under orders / chasing
  const w = state.map.width;
  // Follow my war / Fixed (warTarget.ts): the nation it aims at (0 = any war), and whether only that one counts.
  if (u.fixed && !state.players[u.fixed]?.alive) delete u.fixed; // the pinned nation is gone: back to Follow
  const aim = shipWarTarget(state, u);
  const only = !!u.fixed && u.fixed > 0;
  const owners = state.map.owner;
  // On station off another nation than the aim: look for the aim's coast every FOLLOW_RECHECK_THINKS thinks.
  const recheck = aim > 0 && u.state === 3 && u.station !== undefined && owners[u.station] !== aim && (((state.tick + u.id * 3) / NAVY_THINK_TICKS) | 0) % FOLLOW_RECHECK_THINKS === 0;
  const keep = (valid: boolean): boolean => valid && (!only || owners[u.station!] === aim);
  switch (st) {
    case 'hunt':
      return;
    case 'hold':
      if (u.state === 3) backToPost(state, u); // left over from another stance
      return;
    case 'auto': {
      if (u.state === 3) {
        if (u.station !== undefined && keep(validBombard(state, u, u.station))) {
          if (!recheck) return;
          const t = pickCoast(state, u, u.cargo % w, (u.cargo / w) | 0, NAVY_AUTO_BOMBARD_REACH, aim, true);
          if (t >= 0) goStation(state, u, t, 4 * NAVY_AUTO_BOMBARD_REACH);
          return;
        }
        // The coast fell or the war ended: another spot near the post, else home.
        const next = pickCoast(state, u, u.cargo % w, (u.cargo / w) | 0, NAVY_AUTO_BOMBARD_REACH, aim, only);
        if (next < 0 || !goStation(state, u, next, 4 * NAVY_AUTO_BOMBARD_REACH)) backToPost(state, u);
        return;
      }
      // Patrolling with nothing to chase: shell enemy coast near the post (fronts first) while at war.
      if (!wars.size) return;
      const t = pickCoast(state, u, u.cargo % w, (u.cargo / w) | 0, NAVY_AUTO_BOMBARD_REACH, aim, only);
      if (t >= 0) goStation(state, u, t, 4 * NAVY_AUTO_BOMBARD_REACH);
      return;
    }
    case 'bombard': {
      if (u.state === 3 && u.station !== undefined && keep(validBombard(state, u, u.station))) {
        if (!recheck) return;
        const t = pickCoast(state, u, u.x, u.y, NAVY_STATION_SEEK, aim, true);
        if (t >= 0) goStation(state, u, t, 4 * NAVY_STATION_SEEK);
        return;
      }
      const t = pickCoast(state, u, u.x, u.y, NAVY_STATION_SEEK, aim, only);
      if (t >= 0 && goStation(state, u, t, 4 * NAVY_STATION_SEEK)) return;
      if (u.state === 3) backToPost(state, u);
      return;
    }
    case 'blockade': {
      if (u.state === 3 && u.station !== undefined && keep(validBlockade(state, u, u.station))) {
        if (!recheck) return;
        const t = pickPort(state, u, NAVY_STATION_SEEK, aim, true);
        if (t >= 0) goStation(state, u, t, 4 * NAVY_STATION_SEEK);
        return;
      }
      // The aim's ports first, then its coast; other wars only when it has neither in reach.
      const t = pickPort(state, u, NAVY_STATION_SEEK, aim, only);
      const tOn = t >= 0 && (aim <= 0 || owners[t] === aim);
      if (tOn && goStation(state, u, t, 4 * NAVY_STATION_SEEK)) return;
      // No enemy port in reach: shell its coast meanwhile.
      const onCoast = u.state === 3 && u.station !== undefined && keep(validBombard(state, u, u.station));
      if (onCoast && (aim <= 0 || owners[u.station!] === aim || !recheck)) return;
      const c = pickCoast(state, u, u.x, u.y, NAVY_STATION_SEEK, aim, only);
      const cOn = c >= 0 && (aim <= 0 || owners[c] === aim);
      if (cOn && goStation(state, u, c, 4 * NAVY_STATION_SEEK)) return;
      if (onCoast) return;
      if (!tOn && t >= 0 && goStation(state, u, t, 4 * NAVY_STATION_SEEK)) return;
      if (!cOn && c >= 0 && goStation(state, u, c, 4 * NAVY_STATION_SEEK)) return;
      if (u.state === 3) backToPost(state, u);
      return;
    }
    case 'escort': {
      const s = pickEscorted(state, u);
      if (s) {
        u.state = 4;
        u.station = s.id;
        u.chase = 0;
        sail(state, u, escortAim(s, state), 4 * NAVY_ESCORT_PICK);
      }
      return;
    }
  }
}

/** Warships near an own finished port mend (NAVY_PORT_REPAIR hp/s, up to their max). */
function repairAtPort(state: GameState, u: Unit): void {
  const max = warshipMaxHp(u);
  if (u.hp >= max) return;
  const w = state.map.width;
  for (const b of buildingsOf(state, u.owner, 'port')) {
    if (b.owner !== u.owner || b.buildLeft > 0) continue;
    if (d2(b.tile % w, (b.tile / w) | 0, u.x, u.y) > 64) continue;
    u.hp = Math.min(max, u.hp + NAVY_PORT_REPAIR * NAVY_THINK_TICKS * TICK_SECONDS);
    return;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// AI
// ---------------------------------------------------------------------------------------------------------------

/**
 * AI nations (ai.updateAI on their decision ticks, through applyAction): give the fleet jobs. At war with a coastal
 * enemy: roles by ship id order: blockade the enemy's ports, bombard its coast near our fronts, the rest 'auto'
 * (they hunt and shell near their posts); admirals also hunt. Transports at sea get escorts. At peace: all 'auto'.
 * Idle 'auto' ships far from any war move their post toward the main enemy's coast.
 */
export function aiNavy(state: GameState, id: number, act: (a: Action) => ActionResult): void {
  const p = state.players[id];
  if (!p || !p.alive || p.isHuman || isTribe(p)) return;
  const fleet = state.units.filter((u) => u.type === 'warship' && u.owner === id && u.hp > 0).sort((a, b) => a.id - b.id);
  if (!fleet.length) return;
  const personality = p.personality ?? 'balanced';
  // The main enemy: the nation we fight with the most troops (either way), with a port or a coast.
  let foe = 0;
  let foeScore = 0;
  for (const a of state.attacks) {
    const other = a.attacker === id ? a.target : a.target === id ? a.attacker : 0;
    if (other <= 0 || !hostile(state, id, other)) continue;
    const t = a.troops;
    const score = (t.infantry + t.armor + t.artillery) * (isTribe(state.players[other]) ? 0.2 : 1) * (a.attacker === id ? 1 : 0.8);
    if (score > foeScore || (score === foeScore && other < foe)) {
      foe = other;
      foeScore = score;
    }
  }
  const want = new Map<WarshipStance, number[]>();
  const assign = (u: Unit, s: WarshipStance): void => {
    if (warshipStance(u) === s) return;
    let l = want.get(s);
    if (!l) want.set(s, (l = []));
    l.push(u.id);
  };
  // Escorts for transports at sea (one each, nearest free ships first).
  const transports = state.units.filter((u) => u.type === 'transport' && u.owner === id && u.hp > 0);
  const free = new Set(fleet.map((u) => u.id));
  for (const t of transports) {
    if (escortsOf(state, t.id) > 0) {
      for (const e of fleet) if (e.state === 4 && e.station === t.id) free.delete(e.id);
      continue;
    }
    let best: Unit | null = null;
    let bestD = NAVY_ESCORT_PICK * NAVY_ESCORT_PICK;
    for (const e of fleet) {
      if (!free.has(e.id) || e.state === 2) continue;
      const d = d2(e.x, e.y, t.x, t.y);
      if (d < bestD) {
        bestD = d;
        best = e;
      }
    }
    if (best) {
      free.delete(best.id);
      assign(best, 'escort');
    }
  }
  const rest = fleet.filter((u) => free.has(u.id));
  const foePorts = foe ? buildingsOf(state, foe, 'port').filter((b) => b.owner === foe).length : 0;
  for (const u of rest) {
    if (!foe) assign(u, 'auto');
    else {
      // Variants have their job (variants.ts): submarines raid trade (blockade / hunt), battleships bombard, carriers
      // stay on post (their wings strike from there).
      if (u.variant === 'submarine') {
        assign(u, foePorts > 0 && u.id % 2 === 0 ? 'blockade' : 'hunt');
        continue;
      }
      if (u.variant === 'battleship') {
        assign(u, 'bombard');
        continue;
      }
      if (u.variant === 'carrier') {
        assign(u, 'auto');
        continue;
      }
      // A fixed role per ship (by id), so stances don't shuffle as escorts come and go.
      const role = u.id % (personality === 'admiral' ? 4 : 3);
      if (role === 0 && foePorts > 0) assign(u, 'blockade');
      else if (role === 1) assign(u, 'bombard');
      else if (role === 3) assign(u, 'hunt');
      else assign(u, 'auto');
    }
  }
  for (const [s, ids] of want) {
    for (let i = 0; i < ids.length; i += MAX_GROUP_UNITS) act({ type: 'setUnitStance', unitIds: ids.slice(i, i + MAX_GROUP_UNITS), stance: s });
  }
  // Auto ships patrolling far from the enemy: move the post toward its nearest coast (they then shell / hunt there).
  if (!foe) return;
  const w = state.map.width;
  for (const u of rest) {
    if (warshipStance(u) !== 'auto' || u.state !== 0) continue;
    const t = pickCoast(state, u, u.x, u.y, NAVY_STATION_SEEK);
    if (t < 0) continue;
    if (d2(t % w, (t / w) | 0, u.cargo % w, (u.cargo / w) | 0) <= NAVY_AUTO_BOMBARD_REACH * NAVY_AUTO_BOMBARD_REACH * 0.5) continue;
    const water = stationWater(state, u, t);
    if (water >= 0 && act({ type: 'moveWarship', unitId: u.id, tile: water }).ok) return; // one per decision
  }
}

/** Ticks a warship order takes at the port on `site` (navy.orderWarship): faster at higher port levels. */
export function warshipBuildTicks(state: GameState, site: number, baseSeconds: number): number {
  const b = buildingAt(state, site);
  return Math.round(baseSeconds * portBuildMul(b && b.type === 'port' ? b.level : 1) * TICKS_PER_SECOND);
}
