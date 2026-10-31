// Air wings (Action setAirMission): every airfield flies its stored aircraft as one wing on a standing mission, so
// air power keeps driving the fronts without micro and scales with airfield level, techs and the Air doctrine.
//
//  - support:     every sortie cooldown a wing of bombers bombs ahead of your attack on the chosen front. The strike
//                 makes an air-support zone: enemy tiles inside cost your attacks less and fall faster, defenders die
//                 (on the strike and slowly while it lasts) and forts there are knocked out. The aim follows the front.
//  - strategic:   bombers raid the target nation's cities / factories / markets / ports: normal bomb damage plus a cut
//                 to its gold and iron income for a while (stronger with Strategic Bombing).
//  - superiority: the airfield's fighters patrol a circle (default: around the airfield) and shoot down enemy bombers
//                 and cargo planes in it (faster with Jet Engines), on top of the airfield's normal fighter cover.
//  - idle:        nothing automatic (manual 'bomb' and 'paradrop' orders still work).
// Fighters at a support / strategic airfield escort its bombers and cargo planes: an escort fights off a fighter
// interception (a duel that can cost either side a fighter; Jet Engines wins it). Paratroopers drop bigger groups from
// airfields with more aircraft.
//
// Numbers: config AIR. Deterministic: state.rng only, no transcendental Math functions.

import { AIR, TICKS_PER_SECOND } from './config';
import { aircraftCap, airfieldRadius, buildingAt, buildingsOf, chargesReady, isDisabled, samRadius } from './buildings';
import { atWar } from './allies';
import { frontTiles } from './combat';
import { areAllied } from './diplomacy';
import { doctrineActive, doctrineLess } from './doctrines';
import { atPeace, peaceReason, unitRule } from './rules';
import { addEvent } from './state';
import { hasTech } from './tech';
import { techOf } from './techtree';
import { buildAircraft, launchBomber, shotDown, unitCost } from './units';
import { AIR_MISSIONS, isTribe } from './types';
import type { ActionResult, AirMission, AirRaid, AirState, AirWing, AirZone, Building, BuildingType, GameState, TechId, Unit } from './types';

const FAIL = (reason: string): ActionResult => ({ ok: false, reason });

/** Unit.mission values. */
export const MISSION_SUPPORT = 1;
export const MISSION_STRATEGIC = 2;

// ---------------------------------------------------------------------------------------------------------------
// State and small helpers
// ---------------------------------------------------------------------------------------------------------------

/** The air state (created on first use). */
export function airState(state: GameState): AirState {
  if (!state.air) state.air = { wings: [], zones: [], raids: [] };
  return state.air;
}

function hostile(state: GameState, a: number, b: number): boolean {
  return a !== b && a > 0 && b > 0 && !areAllied(state, a, b) && !atPeace(state, a, b);
}

function d2(w: number, a: number, b: number): number {
  const dx = (a % w) - (b % w);
  const dy = ((a / w) | 0) - ((b / w) | 0);
  return dx * dx + dy * dy;
}

function finishedAirfield(state: GameState, tile: number, owner: number): Building | null {
  const b = buildingAt(state, tile);
  return b && b.type === 'airfield' && b.owner === owner && b.buildLeft <= 0 ? b : null;
}

/** The wing of an airfield (by building), if a mission was ever set. */
export function wingOf(state: GameState, b: Building): AirWing | undefined {
  const air = state.air;
  if (!air) return undefined;
  for (const w of air.wings) if (w.airfield === b.id) return w;
  return undefined;
}

/** The mission an airfield flies ('idle' when none was set). */
export function airMissionOf(state: GameState, b: Building): AirMission {
  return wingOf(state, b)?.mission ?? 'idle';
}

/** True when the airfield's bombers are committed to a support / strategic mission (the AI stops manual raids). */
export function airWingBusy(state: GameState, b: Building): boolean {
  const m = airMissionOf(state, b);
  return m === 'support' || m === 'strategic';
}

/** Bombers per sortie: base + per level, + Jet Engines, + Air doctrine held. */
export function airWingSize(state: GameState, b: Building): number {
  let n = AIR.wingBase + AIR.wingPerLevel * (Math.max(1, b.level) - 1);
  if (techOf(state, b.owner, 'jetEngines')) n += AIR.wingJets;
  if (doctrineActive(state, b.owner) === 'air') n += AIR.wingDoctrine;
  return n;
}

/** Mission reach of an airfield (tiles, straight line). */
export function airWingRange(b: Building): number {
  return AIR.range + AIR.rangePerLevel * (Math.max(1, b.level) - 1);
}

/** Radius of the support zone this airfield's strikes make. */
export function airSupportRadius(b: Building | undefined): number {
  return AIR.supportRadius + AIR.supportRadiusPerLevel * (Math.max(1, b?.level ?? 1) - 1);
}

/** Superiority patrol radius of an airfield. */
export function airPatrolRadius(b: Building): number {
  return airfieldRadius(b) * AIR.superiorityRadiusMul;
}

/** Defence cut of a zone strength (diminishing returns per extra bomber). */
export function supportCutOf(strength: number): number {
  if (strength <= 0) return 0;
  let k = 1;
  // decay^strength for a small integer-ish strength: repeated multiplication (no Math.pow in the sim).
  const whole = Math.floor(strength);
  for (let i = 0; i < whole; i++) k *= AIR.supportDecay;
  const frac = strength - whole;
  if (frac > 0) k *= 1 - frac * (1 - AIR.supportDecay);
  return AIR.supportMaxCut * (1 - k);
}

// ---------------------------------------------------------------------------------------------------------------
// Hooks read by combat, economy and units
// ---------------------------------------------------------------------------------------------------------------

/**
 * Air-support defence cut on `tile` for attacks by `attacker` (0 = none, at most AIR.supportMaxCut): the strengths of
 * the attacker's live zones covering the tile add up (diminishing). combat.tileCost: defence x (1 - cut), budget x
 * (1 - AIR.supportSpeed x cut).
 */
export function airSupportCut(state: GameState, attacker: number, tile: number): number {
  const air = state.air;
  if (!air || !air.zones.length) return 0;
  const w = state.map.width;
  const x = tile % w;
  const y = (tile / w) | 0;
  let s = 0;
  for (const z of air.zones) {
    if (z.owner !== attacker || z.untilTick <= state.tick) continue;
    const dx = (z.tile % w) - x;
    const dy = ((z.tile / w) | 0) - y;
    if (dx * dx + dy * dy <= z.radius * z.radius) s += z.strength;
  }
  return s > 0 ? supportCutOf(s) : 0;
}

/** Income share a nation keeps under strategic bombing (1 = untouched); economy.goldIncome and iron multiply by it. */
export function airRaidIncomeMul(state: GameState, pid: number): number {
  const air = state.air;
  if (!air || !air.raids.length) return 1;
  for (const r of air.raids) if (r.victim === pid && r.untilTick > state.tick) return 1 - r.cut;
  return 1;
}

/** Live raid damage on a nation (for the UI), or null. */
export function airRaidOn(state: GameState, pid: number): AirRaid | null {
  const air = state.air;
  if (!air) return null;
  for (const r of air.raids) if (r.victim === pid && r.untilTick > state.tick) return r;
  return null;
}

/** Live air-support zones (for the client to draw). */
export function airZones(state: GameState): readonly AirZone[] {
  const air = state.air;
  if (!air) return [];
  return air.zones.filter((z) => z.untilTick > state.tick);
}

/** Paradrop size multiplier of an airfield: more aircraft stationed = bigger drops (units.paradropMaxTroops). */
export function airParadropMul(b: Building): number {
  return Math.min(AIR.paraMaxMul, 1 + AIR.paraPerAircraft * (b.bombers + b.fighters));
}

/** Escort hits a new plane from this airfield gets (0 at superiority airfields: their fighters patrol). */
function escortHitsFor(state: GameState, b: Building): number {
  if (b.fighters <= 0 || airMissionOf(state, b) === 'superiority') return 0;
  return AIR.escortHits + (techOf(state, b.owner, 'jetEngines') ? AIR.escortJets : 0);
}

/** Gives a cargo plane flown from airfield b an escort when b has fighters (units.launchParadrop). */
export function escortCargo(state: GameState, u: Unit, b: Building): void {
  const e = escortHitsFor(state, b);
  if (e > 0) u.escort = e;
}

/**
 * A fighter interception against plane u (by the fighters of airfield `by`, owned by `byOwner`): its escort may fight
 * it off. Returns true when the hit was fought off (the plane flies on). The duel can cost a fighter: the
 * interceptor's (AIR.escortDuelKill, doubled when only the escort has Jet Engines) or the escort's own back at its
 * airfield (AIR.escortDuelKill, doubled when only the interceptor has Jet Engines). Jet fighters against an escort
 * without jets always get through.
 */
export function escortAbsorbs(state: GameState, u: Unit, byOwner: number, by: Building | null): boolean {
  if (!u.escort || u.escort <= 0) return false;
  const jetsA = techOf(state, u.owner, 'jetEngines');
  const jetsD = techOf(state, byOwner, 'jetEngines');
  u.escort--;
  if (jetsD && !jetsA) {
    // Jets tear through the escort: it is lost and the hit goes through.
    loseEscortFighter(state, u, 1);
    return false;
  }
  const killD = AIR.escortDuelKill * (jetsA && !jetsD ? 2 : 1);
  if (by && by.fighters > 0 && state.rng() < killD) by.fighters--;
  loseEscortFighter(state, u, AIR.escortDuelKill);
  return true;
}

function loseEscortFighter(state: GameState, u: Unit, chance: number): void {
  if (state.rng() >= chance) return;
  const home = buildingAt(state, u.home);
  if (home && home.type === 'airfield' && home.owner === u.owner && home.fighters > 0) home.fighters--;
}

// ---------------------------------------------------------------------------------------------------------------
// Action setAirMission
// ---------------------------------------------------------------------------------------------------------------

/** Nearest tile hostile to pid within r of `around` (prefers `prefer`'s land); -1 = none. */
function nearestHostile(state: GameState, pid: number, around: number, r: number, prefer: number): number {
  const map = state.map;
  let best = -1;
  let bestD = Infinity;
  const w = map.width;
  const cx = around % w;
  const cy = (around / w) | 0;
  const ri = Math.floor(r);
  for (let y = Math.max(0, cy - ri); y <= Math.min(map.height - 1, cy + ri); y++) {
    for (let x = Math.max(0, cx - ri); x <= Math.min(w - 1, cx + ri); x++) {
      const dd = (x - cx) * (x - cx) + (y - cy) * (y - cy);
      if (dd > r * r) continue;
      const i = y * w + x;
      const o = map.owner[i];
      if (o <= 0 || o === pid || !hostile(state, pid, o)) continue;
      const score = dd + (prefer > 0 && o !== prefer ? 64 : 0);
      if (score < bestD) {
        bestD = score;
        best = i;
      }
    }
  }
  return best;
}

/**
 * Sets the standing mission of one own airfield (airfield = its tile) or, with airfield -1, of every own finished
 * airfield that reaches the target (superiority without a target: every airfield). Checks: Flight, air allowed,
 * a hostile target (support: an enemy tile at or near your front; strategic: a tile of the target nation),
 * peace / alliances, range. Setting the same mission again keeps the sortie timer.
 */
export function setAirMission(state: GameState, pid: number, airfield: number, mission: AirMission, target?: number, refill?: boolean): ActionResult {
  const p = state.players[pid];
  if (!p || pid === 0 || !p.alive) return FAIL('No such player');
  if (!AIR_MISSIONS.includes(mission)) return FAIL('Unknown mission');
  const ruled = unitRule(state, 'bomber');
  if (ruled) return FAIL(ruled);
  if (!hasTech(p, 'flight')) return FAIL('Needs research: Flight');
  const map = state.map;
  const n = map.owner.length;
  if (target !== undefined && (!Number.isInteger(target) || target < 0 || target >= n)) return FAIL('Invalid tile');
  let sites: Building[];
  if (airfield === -1) {
    sites = buildingsOf(state, pid, 'airfield').filter((b) => b.buildLeft <= 0);
    if (!sites.length) return FAIL('You have no finished airfield');
  } else {
    if (!Number.isInteger(airfield) || airfield < 0 || airfield >= n) return FAIL('Invalid tile');
    const b = finishedAirfield(state, airfield, pid);
    if (!b) return FAIL('Missions are flown from a finished Airfield of yours');
    sites = [b];
  }

  let aim = -1;
  let foe = 0;
  if (mission === 'support' || mission === 'strategic') {
    if (target === undefined) return FAIL(mission === 'support' ? 'Pick the front to support' : 'Pick the nation to bomb');
    const o = map.owner[target];
    if (o === pid || o === 0) {
      // A click on our own side of the front (or on neutral land): the nearest enemy tile.
      aim = mission === 'support' ? nearestHostile(state, pid, target, AIR.retargetRadius, 0) : -1;
      if (aim < 0) return FAIL(mission === 'support' ? 'No enemy front near there' : 'Pick a tile of the nation to bomb');
    } else aim = target;
    foe = map.owner[aim];
    if (!state.players[foe]?.alive) return FAIL('That nation is gone');
    if (areAllied(state, pid, foe)) return FAIL('You cannot bomb an ally');
    const peace = peaceReason(state, pid, foe);
    if (peace) return FAIL(peace);
  } else if (mission === 'superiority' && target !== undefined) {
    const o = map.owner[target];
    if (o !== pid && o !== 0 && !areAllied(state, pid, o)) {
      // Patrols over the enemy are allowed only right at the front: the circle must touch our side.
      if (nearestOwn(state, pid, target, 12) < 0) return FAIL('Fighters patrol over your own or allied land (or right at the front)');
    }
    aim = target;
  }

  // Range: support / strategic aims (and a patrol centre) must be within reach of the airfield(s).
  const w = map.width;
  if (aim >= 0) {
    sites = sites.filter((b) => {
      const r = mission === 'superiority' ? airfieldRadius(b) * AIR.superiorityCentreReach : airWingRange(b);
      return d2(w, b.tile, aim) <= r * r;
    });
    if (!sites.length) return FAIL(airfield === -1 ? 'None of your airfields reaches that far' : 'Too far from this airfield');
  }

  const air = airState(state);
  for (const b of sites) {
    let wing = wingOf(state, b);
    if (!wing) {
      wing = { airfield: b.id, tile: b.tile, owner: pid, mission: 'idle', target: -1, targetOwner: 0, nextTick: state.tick, refill: false, coverTick: 0, sorties: 0 };
      air.wings.push(wing);
    }
    if (wing.mission !== mission) {
      wing.nextTick = Math.max(wing.nextTick, state.tick + TICKS_PER_SECOND); // a second to brief the crews
      wing.coverTick = 0;
    }
    wing.mission = mission;
    wing.target = aim;
    wing.targetOwner = mission === 'support' || mission === 'strategic' ? foe : 0;
    if (refill !== undefined) wing.refill = !!refill && mission !== 'idle';
    if (mission === 'idle') wing.refill = false;
  }
  return { ok: true };
}

/** Nearest tile of pid (or an ally) within r of `around`; -1 = none. */
function nearestOwn(state: GameState, pid: number, around: number, r: number): number {
  const map = state.map;
  const w = map.width;
  const cx = around % w;
  const cy = (around / w) | 0;
  let best = -1;
  let bestD = Infinity;
  for (let y = Math.max(0, cy - r); y <= Math.min(map.height - 1, cy + r); y++) {
    for (let x = Math.max(0, cx - r); x <= Math.min(w - 1, cx + r); x++) {
      const dd = (x - cx) * (x - cx) + (y - cy) * (y - cy);
      if (dd > r * r || dd >= bestD) continue;
      const o = map.owner[y * w + x];
      if (o === pid || (o > 0 && areAllied(state, pid, o))) {
        bestD = dd;
        best = y * w + x;
      }
    }
  }
  return best;
}

// ---------------------------------------------------------------------------------------------------------------
// Sorties
// ---------------------------------------------------------------------------------------------------------------

/** Support aim for this sortie: the wing's target if still hostile, else the nearest hostile tile (a bit deeper). */
function supportAim(state: GameState, wing: AirWing): number {
  const map = state.map;
  const t = wing.target;
  if (t < 0) return -1;
  const o = map.owner[t];
  if (o > 0 && hostile(state, wing.owner, o) && (o === wing.targetOwner || wing.targetOwner === 0)) return t;
  const h = nearestHostile(state, wing.owner, t, AIR.retargetRadius, wing.targetOwner);
  if (h < 0) return -1;
  // The front moved: aim a few tiles past the nearest enemy tile, in the direction it moved.
  const w = map.width;
  const dx = (h % w) - (t % w);
  const dy = ((h / w) | 0) - ((t / w) | 0);
  const len = Math.sqrt(dx * dx + dy * dy);
  let aim = h;
  if (len >= 1) {
    const step = 3 / len;
    const x = Math.round((h % w) + dx * step);
    const y = Math.round(((h / w) | 0) + dy * step);
    if (x >= 0 && x < w && y >= 0 && y < map.height) {
      const deeper = y * w + x;
      if (map.owner[deeper] === map.owner[h]) aim = deeper;
    }
  }
  wing.target = aim;
  wing.targetOwner = map.owner[aim];
  return aim;
}

const RAID_WEIGHT: Partial<Record<BuildingType, number>> = { city: 3, factory: 2.5, market: 2, port: 1.5, lab: 1.5, mine: 1, oilWell: 1 };

/** Strategic targets for this sortie: the best economic buildings of the target nation within reach (best first). */
function strategicAims(state: GameState, wing: AirWing, b: Building, n: number): number[] {
  const foe = wing.targetOwner;
  const fp = state.players[foe];
  if (!fp?.alive) return [];
  const w = state.map.width;
  const range = airWingRange(b);
  const sams = buildingsOf(state, foe, 'sam').filter((s) => s.buildLeft <= 0 && !isDisabled(state, s));
  const scored: { tile: number; score: number }[] = [];
  for (const [type, weight] of Object.entries(RAID_WEIGHT) as [BuildingType, number][]) {
    for (const t of buildingsOf(state, foe, type)) {
      if (t.buildLeft > 0 || state.map.owner[t.tile] !== foe) continue;
      const dd = d2(w, b.tile, t.tile);
      if (dd > range * range) continue;
      let cover = 0;
      for (const s of sams) {
        const r = samRadius(s);
        if (d2(w, s.tile, t.tile) <= r * r) cover += chargesReady(s);
      }
      const near = wing.target >= 0 ? Math.sqrt(d2(w, wing.target, t.tile)) / range : 0;
      scored.push({ tile: t.tile, score: weight * (1 + 0.3 * (t.level - 1)) - cover * 1.5 - near });
    }
  }
  scored.sort((a, c) => c.score - a.score || a.tile - c.tile);
  return scored.slice(0, n).map((s) => s.tile);
}

/** Re-buys aircraft for a refill wing (at most two per check; keeps twice the price in gold). */
function refillWing(state: GameState, wing: AirWing, b: Building): void {
  const p = state.players[wing.owner];
  const size = airWingSize(state, b);
  for (let k = 0; k < 2; k++) {
    let kind: 'bomber' | 'fighter' | null = null;
    if (wing.mission === 'superiority') kind = b.fighters < size ? 'fighter' : null;
    else if (b.bombers < size) kind = 'bomber';
    else if (b.fighters < Math.ceil(size / 2)) kind = 'fighter'; // escorts
    if (!kind) return;
    const c = unitCost(state, wing.owner, kind);
    if (p.gold < c.gold * 2 || p.iron < c.iron || p.oil < c.oil * 2) return;
    if (!buildAircraft(state, wing.owner, b.tile, kind).ok) return;
  }
}

/** Launches up to the wing size of stored bombers at the aims (round robin), with escorts while fighters last. */
function launchWing(state: GameState, wing: AirWing, b: Building, aims: number[], mission: number): number {
  const size = Math.min(b.bombers, airWingSize(state, b));
  let escorts = escortHitsFor(state, b) > 0 ? b.fighters : 0;
  const hits = escortHitsFor(state, b);
  let sent = 0;
  for (let k = 0; k < size; k++) {
    const aim = aims[k % aims.length];
    if (!launchBomber(state, wing.owner, b.tile, aim).ok) break;
    const u = state.units[state.units.length - 1];
    u.mission = mission;
    if (escorts > 0) {
      u.escort = hits;
      escorts--;
    }
    sent++;
  }
  return sent;
}

function sortie(state: GameState, wing: AirWing, b: Building): void {
  const idle = state.tick + AIR.idleRecheck * TICKS_PER_SECOND;
  if (wing.refill) refillWing(state, wing, b);
  if (wing.mission !== 'support' && wing.mission !== 'strategic') {
    wing.nextTick = idle;
    return;
  }
  if (b.bombers <= 0) {
    wing.nextTick = idle;
    return;
  }
  const w = state.map.width;
  let aims: number[] = [];
  let mission = MISSION_SUPPORT;
  if (wing.mission === 'support') {
    const aim = supportAim(state, wing);
    const foe = aim >= 0 ? state.map.owner[aim] : 0;
    const range = airWingRange(b);
    // Support flies while we are at war with them (either side attacking), within reach.
    if (aim >= 0 && atWar(state, wing.owner, foe) && d2(w, b.tile, aim) <= range * range) aims = [aim];
  } else {
    mission = MISSION_STRATEGIC;
    const foe = wing.targetOwner;
    if (foe > 0 && hostile(state, wing.owner, foe) && atWar(state, wing.owner, foe)) aims = strategicAims(state, wing, b, 3);
  }
  if (!aims.length) {
    wing.nextTick = idle;
    return;
  }
  const sent = launchWing(state, wing, b, aims, mission);
  if (sent <= 0) {
    wing.nextTick = idle;
    return;
  }
  wing.sorties++;
  wing.nextTick = state.tick + Math.max(1, Math.round(AIR.sortieCooldown * doctrineLess(state, wing.owner, 'airfieldReload') * TICKS_PER_SECOND));
}

// ---------------------------------------------------------------------------------------------------------------
// Arrivals
// ---------------------------------------------------------------------------------------------------------------

/**
 * A mission bomber is over its target (units.updateUnits, before dropBombs). Support: the strike (zone, kills, forts
 * knocked out) replaces the normal bomb drop; returns true. Strategic: adds the income raid and returns false (the
 * normal bomb drop follows). Manual bombers: false.
 */
export function airStrikeArrived(state: GameState, u: Unit): boolean {
  if (u.mission === MISSION_SUPPORT) {
    supportStrike(state, u);
    return true;
  }
  if (u.mission === MISSION_STRATEGIC) raid(state, u);
  return false;
}

function supportStrike(state: GameState, u: Unit): void {
  const map = state.map;
  const tile = u.target;
  const victim = map.owner[tile];
  const home = buildingAt(state, u.home);
  const af = home && home.type === 'airfield' && home.owner === u.owner ? home : undefined;
  const radius = airSupportRadius(af);
  const w = map.width;
  state.effects.push({ kind: 'explosion', x: (tile % w) + 0.5, y: ((tile / w) | 0) + 0.5, radius, tick: state.tick });
  if (!hostile(state, u.owner, victim) || !state.players[victim]?.alive) return;
  const untilTick = state.tick + AIR.supportSeconds * TICKS_PER_SECOND;
  // Count the victim's tiles in the zone and knock out its forts there.
  let tiles = 0;
  let hostileTiles = 0;
  const r = Math.floor(radius);
  const cx = tile % w;
  const cy = (tile / w) | 0;
  for (let y = Math.max(0, cy - r); y <= Math.min(map.height - 1, cy + r); y++) {
    for (let x = Math.max(0, cx - r); x <= Math.min(w - 1, cx + r); x++) {
      if ((x - cx) * (x - cx) + (y - cy) * (y - cy) > radius * radius) continue;
      const i = y * w + x;
      const o = map.owner[i];
      if (!hostile(state, u.owner, o)) continue;
      hostileTiles++;
      if (o !== victim) continue;
      tiles++;
      const bd = buildingAt(state, i);
      if (bd && bd.type === 'fort' && bd.owner === victim) bd.disabledUntil = Math.max(bd.disabledUntil, untilTick);
    }
  }
  const vp = state.players[victim];
  const share = tiles / Math.max(1, vp.tiles);
  const army = vp.troops.infantry + vp.troops.armor + vp.troops.artillery;
  const kill = Math.max((AIR.supportMinKill * tiles) / Math.max(1, hostileTiles), AIR.supportKillShare * army * share);
  const killed = killArmy(state, victim, kill, u.owner);

  // Strengthen this wing's zone if it is near, else start a new one.
  const air = airState(state);
  let zone: AirZone | undefined;
  for (const z of air.zones) {
    if (z.owner === u.owner && z.wing === (af?.id ?? -1) && z.untilTick > state.tick && d2(w, z.tile, tile) <= (radius * radius) / 4) zone = z;
  }
  if (zone) {
    zone.strength += 1;
    zone.untilTick = untilTick;
    zone.tiles = tiles;
    zone.victim = victim;
  } else {
    air.zones.push({ wing: af?.id ?? -1, owner: u.owner, tile, radius, strength: 1, untilTick, victim, tiles });
    const me = state.players[u.owner];
    addEvent(state, 'bombing', `${me.name}'s bombers are supporting the attack on ${vp.name}: ${Math.round(killed)} troops killed`, [u.owner, victim], tile);
  }
}

/** Kills `amount` of a nation's troops split by composition; returns the number killed. */
function killArmy(state: GameState, victim: number, amount: number, killer: number): number {
  const p = state.players[victim];
  if (!p || !p.alive || amount <= 0) return 0;
  const t = p.troops;
  const tot = t.infantry + t.armor + t.artillery;
  const k = Math.min(amount, tot);
  if (k <= 0) return 0;
  t.infantry = Math.max(0, t.infantry - (k * t.infantry) / tot);
  t.armor = Math.max(0, t.armor - (k * t.armor) / tot);
  t.artillery = Math.max(0, t.artillery - (k * t.artillery) / tot);
  p.stats.troopsLost += k;
  if (killer > 0 && killer !== victim) state.players[killer].stats.troopsKilled += k;
  return k;
}

function raid(state: GameState, u: Unit): void {
  const victim = state.map.owner[u.target];
  if (!hostile(state, u.owner, victim) || !state.players[victim]?.alive) return;
  const tech = techOf(state, u.owner, 'strategicBombing');
  const per = AIR.raidCut * (tech ? AIR.raidTechMul : 1);
  const max = tech ? AIR.raidTechMaxCut : AIR.raidMaxCut;
  const until = state.tick + Math.round(AIR.raidSeconds * (tech ? AIR.raidTechMul : 1) * TICKS_PER_SECOND);
  const air = airState(state);
  let r = air.raids.find((x) => x.victim === victim);
  if (!r) {
    r = { victim, cut: 0, untilTick: 0 };
    air.raids.push(r);
  }
  if (r.untilTick <= state.tick) r.cut = 0;
  r.cut = Math.min(max, r.cut + per);
  r.untilTick = Math.max(r.untilTick, until);
}

// ---------------------------------------------------------------------------------------------------------------
// Superiority patrols
// ---------------------------------------------------------------------------------------------------------------

/**
 * After the SAMs, airfield fighters and carriers (units.updateUnits): every superiority wing whose fighters are ready
 * shoots at the first hostile bomber / cargo plane inside its patrol circle (threat order), then waits
 * AIR.superiorityCooldown / fighters seconds (x AIR.jetsCooldown with Jet Engines, x Air doctrine airfieldReload).
 * Escorts can fight the hit off (escortAbsorbs).
 */
export function interceptBySuperiority(state: GameState, threats: readonly Unit[]): void {
  const air = state.air;
  if (!air || !threats.length) return;
  const w = state.map.width;
  for (const wing of air.wings) {
    if (wing.mission !== 'superiority' || wing.coverTick > state.tick) continue;
    const b = state.buildings.get(wing.airfield);
    if (!b || b.owner !== wing.owner || b.buildLeft > 0 || b.fighters <= 0 || isDisabled(state, b)) continue;
    const centre = wing.target >= 0 ? wing.target : b.tile;
    const r = airPatrolRadius(b);
    const cx = (centre % w) + 0.5;
    const cy = ((centre / w) | 0) + 0.5;
    for (const t of threats) {
      if (t.hp <= 0 || (t.type !== 'bomber' && t.type !== 'transportPlane') || !hostile(state, t.owner, wing.owner)) continue;
      const dx = t.x + 0.5 - cx;
      const dy = t.y + 0.5 - cy;
      if (dx * dx + dy * dy > r * r) continue;
      const jets = techOf(state, wing.owner, 'jetEngines') ? AIR.jetsCooldown : 1;
      const secs = (AIR.superiorityCooldown / b.fighters) * jets * doctrineLess(state, wing.owner, 'airfieldReload');
      wing.coverTick = state.tick + Math.max(1, Math.round(secs * TICKS_PER_SECOND));
      state.effects.push({ kind: 'shot', x: (b.tile % w) + 0.5, y: ((b.tile / w) | 0) + 0.5, x2: t.x + 0.5, y2: t.y + 0.5, radius: 0.5, tick: state.tick });
      if (escortAbsorbs(state, t, wing.owner, b)) break;
      t.hp -= 1;
      if (t.hp <= 0) shotDown(state, t, wing.owner, 'fighters');
      break;
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Tick
// ---------------------------------------------------------------------------------------------------------------

/** Drops wings of lost airfields, flies due sorties, bleeds defenders in support zones, expires zones and raids. */
export function updateAir(state: GameState): void {
  const air = state.air;
  if (!air) return;
  if (air.wings.length) {
    air.wings = air.wings.filter((wing) => {
      const b = state.buildings.get(wing.airfield);
      return !!b && b.type === 'airfield' && b.owner === wing.owner && state.players[wing.owner]?.alive;
    });
    for (const wing of air.wings) {
      if (wing.mission === 'idle' || state.tick < wing.nextTick) continue;
      const b = state.buildings.get(wing.airfield)!;
      if (b.buildLeft > 0) continue;
      sortie(state, wing, b);
    }
  }
  if (air.zones.length) {
    if (state.tick % TICKS_PER_SECOND === 0) {
      for (const z of air.zones) {
        if (z.untilTick <= state.tick || !hostile(state, z.owner, z.victim)) continue;
        const vp = state.players[z.victim];
        if (!vp?.alive) continue;
        const army = vp.troops.infantry + vp.troops.armor + vp.troops.artillery;
        const bleed = supportCutOf(z.strength) * Math.max(AIR.supportBleedMin, (AIR.supportBleedShare * army * z.tiles) / Math.max(1, vp.tiles));
        killArmy(state, z.victim, bleed, z.owner);
      }
    }
    if (air.zones.some((z) => z.untilTick <= state.tick)) air.zones = air.zones.filter((z) => z.untilTick > state.tick);
  }
  if (air.raids.length && air.raids.some((r) => r.untilTick <= state.tick)) air.raids = air.raids.filter((r) => r.untilTick > state.tick);
}

/** Mixes the air state (wings, zones, raids, stored aircraft, mission planes) into the state hash (hash.ts). */
export function hashAir(state: GameState, h: number, mixInt: (h: number, v: number) => number, mixFloat: (h: number, v: number) => number): number {
  const air = state.air;
  if (air) {
    h = mixInt(h, air.wings.length);
    for (const wing of air.wings) {
      h = mixInt(h, wing.airfield);
      h = mixInt(h, AIR_MISSIONS.indexOf(wing.mission));
      h = mixInt(h, wing.target);
      h = mixInt(h, wing.targetOwner);
      h = mixInt(h, wing.nextTick);
      h = mixInt(h, wing.coverTick);
      h = mixInt(h, wing.refill ? 1 : 0);
    }
    h = mixInt(h, air.zones.length);
    for (const z of air.zones) {
      h = mixInt(h, z.owner);
      h = mixInt(h, z.tile);
      h = mixFloat(h, z.strength);
      h = mixInt(h, z.untilTick);
      h = mixInt(h, z.victim);
    }
    h = mixInt(h, air.raids.length);
    for (const r of air.raids) {
      h = mixInt(h, r.victim);
      h = mixFloat(h, r.cut);
      h = mixInt(h, r.untilTick);
    }
  }
  for (const b of state.buildings.values()) {
    if (b.type !== 'airfield') continue;
    h = mixInt(h, b.fighters);
    h = mixInt(h, b.bombers);
  }
  for (const u of state.units) {
    if (u.mission || u.escort) {
      h = mixInt(h, u.id);
      h = mixInt(h, u.mission ?? 0);
      h = mixInt(h, u.escort ?? 0);
    }
  }
  return h;
}

// ---------------------------------------------------------------------------------------------------------------
// AI
// ---------------------------------------------------------------------------------------------------------------

function hash32(n: number): number {
  let h = Math.imul(n ^ 0x9e3779b9, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

/**
 * Air-minded AI nations commit to air power: those holding the Air doctrine, and about half of the balanced and
 * turtle nations (fixed by id). They research Flight early, build more airfields and keep their wings full.
 */
export function airMinded(state: GameState, id: number): boolean {
  const p = state.players[id];
  if (!p || p.isHuman || isTribe(p)) return false;
  if (doctrineActive(state, id) === 'air') return true;
  const pers = p.personality ?? 'balanced';
  return (pers === 'balanced' || pers === 'turtle') && hash32(id * 131 + 17) % 2 === 0;
}

/** Extra airfields an AI wants (ai.ts build plan): air-minded nations want one more, two once they have Jet Engines / Strategic Bombing. */
export function aiExtraAirfields(state: GameState, id: number): number {
  if (!airMinded(state, id)) return 0;
  return techOf(state, id, 'jetEngines') || techOf(state, id, 'strategicBombing') ? 2 : 1;
}

/** Research order tweak (ai.ts): air-minded nations move Logistics and Flight to the front of their profile. */
export function aiAirTechs(state: GameState, id: number, techs: readonly TechId[]): readonly TechId[] {
  if (!airMinded(state, id)) return techs;
  const first: TechId[] = ['logistics', 'flight'];
  const head = techs.slice(0, 1).filter((t) => !first.includes(t));
  return [...head, ...first, ...techs.filter((t) => !first.includes(t) && !head.includes(t))];
}

/** Doctrine taste (ai.ts doctrine choice): air-minded nations lean hard into the Air doctrine. */
export function aiAirDoctrineTaste(state: GameState, id: number): number {
  const p = state.players[id];
  if (!p || p.isHuman || isTribe(p)) return 1;
  const pers = p.personality ?? 'balanced';
  return (pers === 'balanced' || pers === 'turtle') && hash32(id * 131 + 17) % 2 === 0 ? 1.6 : 1;
}

/**
 * AI air wings (called from ai.ts every air turn, before its own aircraft orders). Per finished airfield:
 *  - superiority when hostile air is a threat and this is the airfield nearest our main front with 2+ fighters
 *    (or the only airfield with no attack of ours to support);
 *  - else support over our main attack (the one with the most troops against a nation in reach), aimed at its front
 *    tile nearest the attack's focus;
 *  - else strategic against the nation we fight that has the most cities in reach (merchant-minded and air-minded
 *    nations, or once we have Strategic Bombing);
 *  - else idle.
 * Air-minded nations refill their wings automatically. Returns the airfields now on support / strategic missions.
 */
export function aiAirWings(state: GameState, id: number, fighting: readonly number[], airThreat: boolean): number {
  const p = state.players[id];
  if (!p?.alive || !hasTech(p, 'flight') || unitRule(state, 'bomber')) return 0;
  const afs = buildingsOf(state, id, 'airfield').filter((b) => b.buildLeft <= 0);
  if (!afs.length) return 0;
  const w = state.map.width;
  const minded = airMinded(state, id);

  // Main attack: the one with the most troops against a live non-tribe nation.
  let main: { target: number; focus: number; troops: number } | null = null;
  for (const a of state.attacks) {
    if (a.attacker !== id || a.target <= 0) continue;
    const tp = state.players[a.target];
    if (!tp?.alive || isTribe(tp)) continue;
    const tr = a.troops.infantry + a.troops.armor + a.troops.artillery;
    if (!main || tr > main.troops) main = { target: a.target, focus: a.focusTile, troops: tr };
  }
  let front: number[] = [];
  if (main) front = frontTiles(state, id, main.target, 400);

  let busy = 0;
  let patrolling = afs.some((b) => airMissionOf(state, b) === 'superiority') && airThreat;
  const sortedAfs = [...afs].sort((a, b) => (main ? d2(w, a.tile, main.focus) - d2(w, b.tile, main.focus) : 0) || a.id - b.id);
  for (const b of sortedAfs) {
    const cur = wingOf(state, b);
    let mission: AirMission = 'idle';
    let target: number | undefined;

    // Superiority: one airfield with fighters when the enemy flies (the farthest from the front if there are several).
    const wantPatrol = airThreat && b.fighters >= 2 && (afs.length >= 2 ? b === sortedAfs[sortedAfs.length - 1] : !main);
    if (wantPatrol && (!patrolling || cur?.mission === 'superiority')) {
      mission = 'superiority';
      patrolling = true;
    } else if (main && front.length) {
      const range = airWingRange(b);
      let best = -1;
      let bestD = Infinity;
      for (const t of front) {
        if (d2(w, b.tile, t) > range * range) continue;
        const dd = d2(w, t, main.focus);
        if (dd < bestD) {
          bestD = dd;
          best = t;
        }
      }
      if (best >= 0) {
        mission = 'support';
        // Keep the old aim while it is still on that front (it follows the push by itself).
        target = cur?.mission === 'support' && cur.targetOwner === main.target && cur.target >= 0 && d2(w, cur.target, best) < 30 * 30 ? cur.target : best;
      }
    }
    if (mission === 'idle' && fighting.length && (minded || p.personality === 'merchant' || techOf(state, id, 'strategicBombing'))) {
      let bestFoe = 0;
      let bestN = 0;
      const range = airWingRange(b);
      for (const q of fighting) {
        const qp = state.players[q];
        if (!qp?.alive || isTribe(qp) || !hostile(state, id, q)) continue;
        let n = 0;
        let tile = -1;
        for (const c of buildingsOf(state, q, 'city')) {
          if (c.buildLeft > 0 || d2(w, b.tile, c.tile) > range * range) continue;
          n += c.level;
          tile = c.tile;
        }
        if (n > bestN && tile >= 0) {
          bestN = n;
          bestFoe = q;
          target = tile;
        }
      }
      if (bestFoe > 0) mission = 'strategic';
      else target = undefined;
    }

    const refill = minded || doctrineActive(state, id) === 'air';
    const same = cur && cur.mission === mission && (target === undefined || cur.target === target) && cur.refill === refill;
    if (!same && (mission !== 'idle' || (cur && cur.mission !== 'idle'))) {
      setAirMission(state, id, b.tile, mission, target, refill);
    }
    if (mission === 'support' || mission === 'strategic') busy++;
  }
  return busy;
}

/** Bomber price (for the client's mission panel). */
export function airSortieCost(state: GameState, pid: number): { gold: number; iron: number; oil: number } {
  return unitCost(state, pid, 'bomber');
}

/** Short mission names and help (client). */
export const AIR_MISSION_INFO: Record<AirMission, { name: string; help: string }> = {
  idle: { name: 'Idle', help: 'No automatic sorties; manual bombing and paradrops still work.' },
  support: {
    name: 'Support front',
    help: `Every ${AIR.sortieCooldown} s the wing bombs ahead of your attack: enemy defence there drops up to ${Math.round(AIR.supportMaxCut * 100)}%, your push is faster, defenders die and forts are knocked out. Follows the front.`,
  },
  strategic: {
    name: 'Strategic bombing',
    help: `Raids the target nation's cities, factories, markets and ports: bomb damage plus up to ${Math.round(AIR.raidMaxCut * 100)}% less gold and iron income for ${AIR.raidSeconds} s (more with Strategic Bombing).`,
  },
  superiority: {
    name: 'Air superiority',
    help: `Fighters patrol ${AIR.superiorityRadiusMul}x the airfield's cover radius and shoot down enemy bombers and cargo planes; Jet Engines doubles their pace and beats escorts.`,
  },
};

/** How many aircraft the airfield can hold in total (client). */
export function airWingCap(b: Building): number {
  return aircraftCap(b);
}
