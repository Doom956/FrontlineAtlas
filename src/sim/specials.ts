// Special upgrades: techs that change how a pillar BEHAVES rather than its numbers (DESIGN: round 2 "Arsenal").
// Each is an ordinary tech (TechId + config TECHS, bought with Action 'research'); every number is in config SPECIALS.
//
// - Amphibious Tanks (Armor): tank divisions wade across narrow water (a strait or river at most amphibMaxWater
//   tiles wide in a straight line), both when driving over own land (tanks.ownLandPath with narrowWater) and in a
//   spearhead (the head crosses instead of stopping at the coast; launch reach + amphibLaunchReach). Every landing
//   costs amphibLandingLoss of the division (supply penalty). Counters: hostile warships within WARSHIP_RANGE and
//   naval mines bleed a division while it is in the water; a holding division stranded on water falls back home.
// - Early Warning (Air / radar; requires Radar): the holder's SAMs and airfield fighters engage ewRadiusMul farther
//   out (units.interceptThreats); enemy submarines are revealed ewSubRangeMul farther from its coast and ships and
//   within ewSubSiteRange of its SAMs / airfields / watchtowers (techtree.unitVisibleTo); watchtower warnings reach
//   farther; enemy night bombers dodge it far less (nightDodgeVsRadar). Counter: Night Bombing still dodges some,
//   Drop Tanks fly around the rings, destroying the sites.
// - Naval Mines (Navy): water within mineRadius (+ per level) of each finished own port is a minefield. Hostile
//   warships / submarines in it take mineDamagePerS hp per second; invasions (transports) landing on the holder lose
//   a share of the troops per mined tile they sailed through (capped); wading tank divisions bleed. Own and allied
//   ships are safe; trade ships are left alone. Counters: an own warship near the landing sweeps a lane
//   (mineEscortMul), mine sweepers (isMineSweeper: destroyers) are immune, capturing / bombing the port clears it,
//   landing away from ports.
// - Drop Tanks (Air): air-wing reach x dropTanksRange, paradrop reach x dropTanksParadrop, superiority patrols x
//   dropTanksPatrol. Counter: longer routes cross more SAM / fighter cover.
// - Night Bombing (Air): each SAM shot / fighter pass (airfields, carriers, superiority patrols) at a holder's bomber
//   misses with nightDodge (nightDodgeVsRadar against Early Warning); bombs scatter up to nightScatter tiles and do
//   nightEffect of the damage on a nightRadius x area. Counter: Early Warning.
//
// Deterministic: state.rng only (night dodges and scatter), fixed iteration orders, no transcendental math.
import { buildingsOf } from './buildings';
import { SPECIALS as S, TANK_SPEARHEAD_SPEED, TECH_EFFECTS, TICK_SECONDS, WARSHIP_RANGE } from './config';
import { areAllied } from './diplomacy';
import { atPeace } from './rules';
import { addEvent } from './state';
import { techOf } from './techtree';
import { isWater, TROOP_TYPES } from './types';
import type { Building, GameState, TechId, Unit } from './types';

/** The five special upgrades (Arsenal kind 'special'). */
export const SPECIAL_TECHS: readonly TechId[] = ['amphibiousTanks', 'earlyWarning', 'navalMines', 'dropTanks', 'nightBombing'];
export function isSpecialTech(t: TechId): boolean {
  return SPECIAL_TECHS.includes(t);
}

function hostile(state: GameState, a: number, b: number): boolean {
  return a !== b && a > 0 && b > 0 && !areAllied(state, a, b) && !atPeace(state, a, b);
}
const troopsOf = (u: Unit): number => u.troops.infantry + u.troops.armor + u.troops.artillery;

/** Takes a share of a unit's troops (stats to both sides); returns the amount taken. */
function bleed(state: GameState, u: Unit, share: number, killer: number): number {
  const tot = troopsOf(u);
  const take = Math.min(tot, tot * Math.max(0, share));
  if (take <= 0) return 0;
  for (const k of TROOP_TYPES) u.troops[k] = Math.max(0, u.troops[k] - (take * u.troops[k]) / tot);
  const p = state.players[u.owner];
  if (p) p.stats.troopsLost += take;
  if (killer > 0 && killer !== u.owner && state.players[killer]) state.players[killer].stats.troopsKilled += take;
  return take;
}

// ---------------------------------------------------------------------------------------------------------------
// Unit kinds (other agents' variants plug in here)
// ---------------------------------------------------------------------------------------------------------------

/** A submarine: a warship of the submarine variant (variants.ts). */
export function isSubmarine(u: Unit): boolean {
  return u.type === 'warship' && u.variant === 'submarine';
}
/** Ships that mines can hit: every warship variant (trade ships are left alone; transports pay at the landing). */
export function isMineTarget(u: Unit): boolean {
  return u.type === 'warship';
}
/** Immune to mines and sweeps a lane for transports: destroyers (variants.ts). */
export function isMineSweeper(u: Unit): boolean {
  return u.type === 'warship' && u.variant === 'destroyer';
}
function isWarshipLike(u: Unit): boolean {
  return u.type === 'warship';
}

// ---------------------------------------------------------------------------------------------------------------
// Amphibious Tanks
// ---------------------------------------------------------------------------------------------------------------

const DIRS = [
  [1, 0],
  [0, 1],
  [1, 1],
  [1, -1],
];
/** Per-map memo: 0 = unknown, 1 = narrow water, 2 = not (land or wide water). Terrain never changes in a game. */
const narrowMemo = new WeakMap<Uint8Array, Uint8Array>();

/**
 * Narrow water: a water tile on a straight line (one of 4 axes) between two shores with at most amphibMaxWater
 * water tiles between them. Pure function of the terrain (memoised per map).
 */
export function narrowWater(state: GameState, t: number): boolean {
  const map = state.map;
  let memo = narrowMemo.get(map.terrain);
  if (!memo) narrowMemo.set(map.terrain, (memo = new Uint8Array(map.terrain.length)));
  const m = memo[t];
  if (m) return m === 1;
  let ok = false;
  if (isWater(map.terrain[t])) {
    const w = map.width;
    const h = map.height;
    const x0 = t % w;
    const y0 = (t / w) | 0;
    const N = S.amphibMaxWater;
    const reach = (dx: number, dy: number): number => {
      // Steps to the first land tile (1 = next tile), or 0 when none within N.
      for (let k = 1; k <= N; k++) {
        const x = x0 + dx * k;
        const y = y0 + dy * k;
        if (x < 0 || y < 0 || x >= w || y >= h) return 0;
        if (!isWater(map.terrain[y * w + x])) return k;
      }
      return 0;
    };
    for (const [dx, dy] of DIRS) {
      const a = reach(dx, dy);
      if (!a) continue;
      const b = reach(-dx, -dy);
      if (b && a + b - 1 <= N) {
        ok = true;
        break;
      }
    }
  }
  memo[t] = ok ? 1 : 2;
  return ok;
}

export function hasAmphibious(state: GameState, owner: number): boolean {
  return techOf(state, owner, 'amphibiousTanks');
}
/** May a division of `owner` drive onto tile t over water? */
export function canWade(state: GameState, owner: number, t: number): boolean {
  return hasAmphibious(state, owner) && narrowWater(state, t);
}
/** Extra spearhead launch reach (tiles) across water. */
export function amphibLaunchBonus(state: GameState, owner: number): number {
  return hasAmphibious(state, owner) ? S.amphibLaunchReach : 0;
}
/** Head speed (tiles/s) of a spearhead over water (0 = cannot). */
export function amphibWaterSpeed(state: GameState, owner: number): number {
  return hasAmphibious(state, owner) ? TANK_SPEARHEAD_SPEED * S.amphibWaterSpeed : 0;
}

/** Is the division standing in water right now (wading)? */
export function isWading(state: GameState, u: Unit): boolean {
  if (!u.wading) return false;
  const t = Math.round(u.y) * state.map.width + Math.round(u.x);
  return isWater(state.map.terrain[t]);
}

/**
 * A spearhead's head is about to enter the water tile at depth `nd` of its line: may it wade on? True when the
 * division is already wading, or land lies within amphibMaxWater water tiles straight ahead (it then starts wading).
 */
export function spearheadMayWade(state: GameState, u: Unit, lx: number, ly: number, ux: number, uy: number, nd: number): boolean {
  if (!hasAmphibious(state, u.owner)) return false;
  if (u.wading) return true;
  const map = state.map;
  const w = map.width;
  let water = 0;
  let last = -1;
  const d0 = Math.floor(nd);
  for (let d = d0; water <= S.amphibMaxWater && d <= d0 + 2 * S.amphibMaxWater + 4; d++) {
    const x = Math.round(lx + ux * d);
    const y = Math.round(ly + uy * d);
    if (x < 0 || y < 0 || x >= w || y >= map.height) return false;
    const t = y * w + x;
    if (t === last) continue;
    last = t;
    if (!isWater(map.terrain[t])) {
      if (water === 0) continue; // still on the near shore
      u.wading = 1;
      return true;
    }
    water++;
  }
  return false;
}

/**
 * After a division moved this tick (tanks.updateTanks): entering water starts wading; reaching land after water is a
 * landing (amphibLandingLoss). A holding division (state 0) left standing in the water is stranded: it falls back
 * home with amphibStrandedLoss lost. Returns true when the division should be disbanded (stranded).
 */
export function afterDivisionMove(state: GameState, u: Unit): boolean {
  if (u.hp <= 0) return false;
  const t = Math.round(u.y) * state.map.width + Math.round(u.x);
  if (isWater(state.map.terrain[t])) {
    u.wading = 1;
    if (u.state === 0) {
      bleed(state, u, S.amphibStrandedLoss, 0);
      const p = state.players[u.owner];
      addEvent(state, 'unitLost', `${p.name}'s tank division was stranded in the water and fell back`, [u.owner], t);
      u.wading = undefined;
      return true;
    }
    return false;
  }
  if (u.wading) {
    u.wading = undefined;
    bleed(state, u, S.amphibLandingLoss, 0);
  }
  return false;
}

// ---------------------------------------------------------------------------------------------------------------
// Naval Mines
// ---------------------------------------------------------------------------------------------------------------

export interface Minefield {
  owner: number;
  /** port tile (centre) */
  tile: number;
  x: number;
  y: number;
  radius: number;
}

/** Mined radius around a port. */
export function mineRadiusOf(b: Building): number {
  return S.mineRadius + S.mineRadiusPerLevel * (Math.max(1, b.level) - 1);
}

/** Every minefield: finished ports of living Naval Mines holders, in player then building order (UI overlay too). */
export function minefields(state: GameState): Minefield[] {
  const out: Minefield[] = [];
  const w = state.map.width;
  for (const p of state.players) {
    if (p.id === 0 || !p.alive || !p.techs.includes('navalMines')) continue;
    for (const b of buildingsOf(state, p.id, 'port')) {
      if (b.buildLeft > 0 || b.owner !== p.id) continue;
      out.push({ owner: p.id, tile: b.tile, x: b.tile % w, y: (b.tile / w) | 0, radius: mineRadiusOf(b) });
    }
  }
  return out;
}

/** Owner of the first hostile (to `owner`) minefield covering (x, y), or 0. */
export function minefieldAt(state: GameState, fields: readonly Minefield[], x: number, y: number, owner: number): number {
  for (const f of fields) {
    const dx = x - f.x;
    const dy = y - f.y;
    if (dx * dx + dy * dy <= f.radius * f.radius && hostile(state, owner, f.owner)) return f.owner;
  }
  return 0;
}

/** Is water tile t mined against `owner`? (UI: the client can shade it; owner = viewer for "dangerous for me".) */
export function isMinedFor(state: GameState, t: number, owner: number): boolean {
  if (!isWater(state.map.terrain[t])) return false;
  const w = state.map.width;
  return minefieldAt(state, minefields(state), t % w, (t / w) | 0, owner) > 0;
}

/**
 * Invasion through a minefield (units.landTransport, before the troops land): the transport loses
 * mineTransportLossPerTile of its troops per tile of its route inside a minefield of a nation hostile to it (capped
 * at mineTransportMaxLoss), x mineEscortMul when an own warship is within mineSweepRadius of the landing. Returns the
 * troops lost.
 */
export function mineLandingLoss(state: GameState, u: Unit): number {
  if (u.type !== 'transport' || !u.path.length) return 0;
  const fields = minefields(state);
  if (!fields.length) return 0;
  const w = state.map.width;
  let mined = 0;
  let by = 0;
  for (const t of u.path) {
    const o = minefieldAt(state, fields, t % w, (t / w) | 0, u.owner);
    if (o) {
      mined++;
      by ||= o;
    }
  }
  if (!mined) return 0;
  let share = Math.min(S.mineTransportMaxLoss, S.mineTransportLossPerTile * mined);
  const r2 = S.mineSweepRadius * S.mineSweepRadius;
  for (const s of state.units) {
    if (s.owner !== u.owner || s.hp <= 0 || !isWarshipLike(s)) continue;
    if ((s.x - u.x) * (s.x - u.x) + (s.y - u.y) * (s.y - u.y) <= r2) {
      share *= isMineSweeper(s) ? 0 : S.mineEscortMul;
      break;
    }
  }
  const lost = bleed(state, u, share, by);
  if (lost >= 1) {
    const p = state.players[u.owner];
    addEvent(state, 'unitLost', `${p.name}'s landing sailed into ${state.players[by].name}'s minefield: ${Math.round(lost)} troops lost`, [u.owner, by], u.target);
  }
  return lost;
}

/** A ship is sunk by a mine (hp 0; the unit lists drop it). */
function mineSink(state: GameState, u: Unit, by: number): void {
  u.hp = 0;
  const aboard = troopsOf(u);
  if (aboard > 0) bleed(state, u, 1, by);
  state.effects.push({ kind: 'explosion', x: u.x + 0.5, y: u.y + 0.5, radius: 1.5, tick: state.tick });
  const p = state.players[u.owner];
  addEvent(state, 'unitLost', `${p.name}'s warship hit a mine off ${state.players[by].name}'s coast and sank`, [u.owner, by], Math.round(u.y) * state.map.width + Math.round(u.x));
}

// ---------------------------------------------------------------------------------------------------------------
// Tick (sim.ts, before units.updateUnits so sunk ships are dropped the same tick)
// ---------------------------------------------------------------------------------------------------------------

/** Mines hit hostile warships; mines and warships bleed wading tank divisions. Every SPECIALS.checkTicks ticks. */
export function updateSpecials(state: GameState): void {
  if (state.tick % S.checkTicks !== 0) return;
  const units = state.units;
  if (!units.length) return;
  const dt = TICK_SECONDS * S.checkTicks;
  let fields: Minefield[] | null = null;
  let warships: Unit[] | null = null;
  for (const u of units) {
    if (u.hp <= 0 || !state.players[u.owner]?.alive) continue;
    if (u.type === 'tankDivision') {
      if (!u.wading || !isWading(state, u)) continue;
      fields ??= minefields(state);
      warships ??= units.filter((s) => s.hp > 0 && isWarshipLike(s));
      let share = 0;
      let by = 0;
      const r2 = WARSHIP_RANGE * WARSHIP_RANGE;
      for (const s of warships) {
        if (!hostile(state, u.owner, s.owner)) continue;
        if ((s.x - u.x) * (s.x - u.x) + (s.y - u.y) * (s.y - u.y) > r2) continue;
        share += S.amphibShipFirePerS * dt;
        by ||= s.owner;
      }
      const mineBy = minefieldAt(state, fields, u.x, u.y, u.owner);
      if (mineBy) {
        share += S.mineDivisionLossPerS * dt;
        by ||= mineBy;
      }
      if (share > 0) bleed(state, u, Math.min(1, share), by);
      continue;
    }
    if (!isMineTarget(u) || isMineSweeper(u)) continue;
    fields ??= minefields(state);
    if (!fields.length) continue;
    const by = minefieldAt(state, fields, u.x, u.y, u.owner);
    if (!by) continue;
    u.hp -= S.mineDamagePerS * dt;
    if (u.hp <= 1e-9) mineSink(state, u, by);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Early Warning
// ---------------------------------------------------------------------------------------------------------------

export function hasEarlyWarning(state: GameState, owner: number): boolean {
  return techOf(state, owner, 'earlyWarning');
}
/** SAM radius / airfield fighter cover radius multiplier of a defender (UI rings use it too). */
export function earlyWarningMul(state: GameState, owner: number): number {
  return hasEarlyWarning(state, owner) ? S.ewRadiusMul : 1;
}
/** Watchtower warning radius multiplier. */
export function earlyWarningWarnMul(state: GameState, owner: number): number {
  return hasEarlyWarning(state, owner) ? S.ewWarnMul : 1;
}
/** Submarine detection range from coast / own ships for a viewer (tiles). */
export function subRevealRange(state: GameState, viewer: number): number {
  return TECH_EFFECTS.submarineRevealRange * (hasEarlyWarning(state, viewer) ? S.ewSubRangeMul : 1);
}

/**
 * Early Warning sees a hidden submarine u (techtree.unitVisibleTo asks after its own checks): own ships or coast
 * within subRevealRange, or a finished own SAM / airfield / watchtower within ewSubSiteRange.
 */
export function earlyWarningSees(state: GameState, viewer: number, u: Unit): boolean {
  if (!hasEarlyWarning(state, viewer)) return false;
  const r = subRevealRange(state, viewer);
  const r2 = r * r;
  for (const s of state.units) {
    if (s.owner !== viewer || s.hp <= 0 || (s.type !== 'warship' && s.type !== 'transport' && s.type !== 'tradeShip')) continue;
    if ((s.x - u.x) * (s.x - u.x) + (s.y - u.y) * (s.y - u.y) <= r2) return true;
  }
  const map = state.map;
  const w = map.width;
  const cx = Math.round(u.x);
  const cy = Math.round(u.y);
  const ri = Math.ceil(r);
  for (let y = Math.max(0, cy - ri); y <= Math.min(map.height - 1, cy + ri); y += 2) {
    for (let x = Math.max(0, cx - ri); x <= Math.min(w - 1, cx + ri); x += 2) {
      const i = y * w + x;
      if (map.owner[i] === viewer && (x - cx) * (x - cx) + (y - cy) * (y - cy) <= r2) return true;
    }
  }
  const s2 = S.ewSubSiteRange * S.ewSubSiteRange;
  for (const type of ['sam', 'airfield', 'watchtower'] as const) {
    for (const b of buildingsOf(state, viewer, type)) {
      if (b.buildLeft > 0) continue;
      const dx = (b.tile % w) - u.x;
      const dy = ((b.tile / w) | 0) - u.y;
      if (dx * dx + dy * dy <= s2) return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------------------------------------------
// Drop Tanks
// ---------------------------------------------------------------------------------------------------------------

export function hasDropTanks(state: GameState, owner: number): boolean {
  return techOf(state, owner, 'dropTanks');
}
/** Air-wing mission reach multiplier. */
export function dropTanksRangeMul(state: GameState, owner: number): number {
  return hasDropTanks(state, owner) ? S.dropTanksRange : 1;
}
/** Paradrop reach multiplier. */
export function dropTanksParadropMul(state: GameState, owner: number): number {
  return hasDropTanks(state, owner) ? S.dropTanksParadrop : 1;
}
/** Superiority patrol radius / centre reach multiplier. */
export function dropTanksPatrolMul(state: GameState, owner: number): number {
  return hasDropTanks(state, owner) ? S.dropTanksPatrol : 1;
}

// ---------------------------------------------------------------------------------------------------------------
// Night Bombing
// ---------------------------------------------------------------------------------------------------------------

export function isNightBomber(state: GameState, u: Unit): boolean {
  return u.type === 'bomber' && techOf(state, u.owner, 'nightBombing');
}
/**
 * A SAM shot / fighter pass of `defender` at threat u: does a night bomber dodge it? One state.rng() draw, only for
 * night bombers (so nothing changes for anyone else).
 */
export function nightDodges(state: GameState, u: Unit, defender: number): boolean {
  if (!isNightBomber(state, u)) return false;
  const chance = hasEarlyWarning(state, defender) ? S.nightDodgeVsRadar : S.nightDodge;
  return state.rng() < chance;
}
/** Damage multiplier of a player's bombs (buildings hit, troops killed, support kills, raid cut). */
export function nightEffectMul(state: GameState, owner: number): number {
  return techOf(state, owner, 'nightBombing') ? S.nightEffect : 1;
}
/** Bomb radius multiplier. */
export function nightRadiusMul(state: GameState, owner: number): number {
  return techOf(state, owner, 'nightBombing') ? S.nightRadius : 1;
}
/** A night bomber over its aim (units.updateUnits, before the drop): the aim scatters up to nightScatter tiles. */
export function nightScatter(state: GameState, u: Unit): void {
  if (!isNightBomber(state, u)) return;
  const map = state.map;
  const w = map.width;
  const n = S.nightScatter;
  const x = Math.max(0, Math.min(w - 1, (u.target % w) + Math.floor(state.rng() * (2 * n + 1)) - n));
  const y = Math.max(0, Math.min(map.height - 1, ((u.target / w) | 0) + Math.floor(state.rng() * (2 * n + 1)) - n));
  u.target = y * w + x;
}

// ---------------------------------------------------------------------------------------------------------------
// AI (the reconcile step wires final choices; this says which specials fit a nation, best first)
// ---------------------------------------------------------------------------------------------------------------

/**
 * Special upgrades that fit nation `id` now, best first (available or not: the caller checks techStatus).
 * Amphibious Tanks: has tank divisions and narrow water at its borders is likely (coastal); Naval Mines: 2+ ports and
 * a hostile navy; Early Warning: SAMs / airfields and a hostile air force; Drop Tanks: 2+ bombers on air-wing
 * missions or 2+ airfields; Night Bombing: bombers and hostile SAMs / fighters (not when they hold Early Warning).
 */
export function aiSpecialTechs(state: GameState, id: number): TechId[] {
  const p = state.players[id];
  if (!p || !p.alive) return [];
  const score = new Map<TechId, number>();
  let divisions = 0;
  let foeShips = 0;
  for (const u of state.units) {
    if (u.hp <= 0) continue;
    if (u.owner === id && u.type === 'tankDivision') divisions++;
    else if (u.owner !== id && isWarshipLike(u) && hostile(state, id, u.owner)) foeShips++;
  }
  const ports = buildingsOf(state, id, 'port').length;
  const airfields = buildingsOf(state, id, 'airfield');
  const sams = buildingsOf(state, id, 'sam').length;
  let bombers = 0;
  for (const b of airfields) bombers += b.bombers;
  let foeAir = 0;
  let foeSams = 0;
  let foeRadar = 0;
  for (const q of state.players) {
    if (q.id === 0 || q.id === id || !q.alive || !hostile(state, id, q.id)) continue;
    const af = buildingsOf(state, q.id, 'airfield');
    for (const b of af) foeAir += 1 + b.bombers;
    const qs = buildingsOf(state, q.id, 'sam').length;
    foeSams += qs + af.reduce((n, b) => n + b.fighters, 0);
    if (q.techs.includes('earlyWarning')) foeRadar++;
  }
  if (divisions > 0 && ports > 0) score.set('amphibiousTanks', 1 + divisions);
  if (ports >= 2 && foeShips > 0) score.set('navalMines', ports + foeShips / 2);
  if ((sams > 0 || airfields.length > 0) && foeAir >= 3) score.set('earlyWarning', foeAir / 2 + sams);
  if (airfields.length >= 2 || bombers >= 2) score.set('dropTanks', airfields.length + bombers / 3);
  if (bombers >= 2 && foeSams >= 3 && foeRadar === 0) score.set('nightBombing', foeSams / 2 + bombers / 3);
  return SPECIAL_TECHS.filter((t) => score.has(t) && !p.techs.includes(t)).sort((a, b) => score.get(b)! - score.get(a)! || SPECIAL_TECHS.indexOf(a) - SPECIAL_TECHS.indexOf(b));
}
