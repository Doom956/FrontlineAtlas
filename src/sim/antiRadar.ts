// Anti-radar Missiles (an Air special in the Arsenal, tier 3; config ANTI_RADAR and UNITS.antiRadarMissile; DESIGN
// section 7). Why a special and not a ground-attack upgrade: the owner wanted every air player to have an answer to
// deep SAM walls, so it sits next to Drop Tanks and Night Bombing, open to both Air paths (the fork's tier 3 slots hold
// Jet Engines and Strategic Bombing already).
//
// Rules. A SAM site's radar is on for ANTI_RADAR.radarOnSeconds after it fires (Building.firedAt, set by units.ts
// interceptThreats through noteSamFire, with the owner of what it shot at in Building.firedOn). Action antiRadar
// {airfield | -1, sam}: one missile from an own finished airfield (the chosen one, or the nearest ready one in reach)
// at a hostile SAM site pid has seen whose radar is on, within the airfield's air-wing reach x ANTI_RADAR.reachMul; the
// airfield reloads for ANTI_RADAR.cooldownSeconds (Building.seadReady). It flies straight like a rocket and SAMs shoot
// it down like one. On arrival the SAM site (if still standing) loses ANTI_RADAR.damage hp and is knocked out for
// ANTI_RADAR.knockSeconds (the barrage knock-out; destroyed at 0 hp). Unit.chase = the SAM's building id.
// Escort mode (Action setAntiRadarEscort; Player.antiRadarEscort, off by default): once a second, each hostile SAM site
// that fired at this player's planes or missiles in the last second draws one missile from its nearest ready airfield
// in reach, if the player can pay. AI (aiAntiRadar, from ai.ts airAndMissiles): before its raids, from Normal up, an AI
// with stored bombers fires at the radar-on SAM sites that cover its raid targets (never at a human at Easy).
// Deterministic: fixed id orders, no randomness.
import { airWingRange } from './airwings';
import { buildingAt, buildingsOf, destroyBuilding, isDisabled, samRadius } from './buildings';
import { ANTI_RADAR, TICKS_PER_SECOND } from './config';
import { aiAttackLevel } from './aiattack';
import { areAllied } from './diplomacy';
import { knownTile } from './fog';
import { atPeace, peaceReason, unitRule } from './rules';
import { addEvent } from './state';
import { hasTech } from './tech';
import { buyUnit, unitCost, unitPriceReason } from './units';
import type { ActionResult, Building, GameState, Unit } from './types';

const FAIL = (reason: string): ActionResult => ({ ok: false, reason });
const ON_TICKS = Math.round(ANTI_RADAR.radarOnSeconds * TICKS_PER_SECOND);

function hostile(state: GameState, a: number, b: number): boolean {
  return a !== b && a > 0 && b > 0 && !areAllied(state, a, b) && !atPeace(state, a, b);
}

/** True if pid owns Anti-radar Missiles. */
export function hasAntiRadar(state: GameState, pid: number): boolean {
  const p = pid > 0 ? state.players[pid] : undefined;
  return !!p && hasTech(p, 'antiRadar');
}

/** A SAM site fired at something of `on` (units.ts): its radar is on from now. */
export function noteSamFire(state: GameState, s: Building, on: number): void {
  s.firedAt = state.tick;
  s.firedOn = on;
}

/** Seconds the SAM site's radar stays on (0 = off: it has not fired in the last ANTI_RADAR.radarOnSeconds). */
export function radarOnLeft(state: GameState, b: Building): number {
  if (b.firedAt === undefined) return 0;
  const left = b.firedAt + ON_TICKS - state.tick;
  return left > 0 ? left / TICKS_PER_SECOND : 0;
}

/** How far an anti-radar missile reaches from airfield b. */
export function antiRadarReach(state: GameState, b: Building): number {
  return airWingRange(b, state) * ANTI_RADAR.reachMul;
}

/** Seconds until airfield b may fire its next anti-radar missile (0 = ready). */
export function seadReloadLeft(state: GameState, b: Building): number {
  const r = b.seadReady ?? 0;
  return r > state.tick ? (r - state.tick) / TICKS_PER_SECOND : 0;
}

/** Why pid cannot fire an anti-radar missile now, whatever the airfield and the SAM ('' = it can). Pure read. */
export function antiRadarPlayerReason(state: GameState, pid: number): string {
  const p = state.players[pid];
  if (!p || pid <= 0 || !p.alive) return 'No such player';
  const ruled = unitRule(state, 'bomber');
  if (ruled) return ruled;
  if (!hasTech(p, 'antiRadar')) return 'Needs Anti-radar Missiles';
  return unitPriceReason(state, pid, 'antiRadarMissile') ?? '';
}

function d2(state: GameState, a: number, b: number): number {
  const w = state.map.width;
  const dx = (a % w) - (b % w);
  const dy = ((a / w) | 0) - ((b / w) | 0);
  return dx * dx + dy * dy;
}

/**
 * The airfield a missile of pid at the SAM on `samTile` flies from: `airfield` (a finished own one, loaded, with the SAM
 * in reach), or with -1 the nearest loaded one in reach (then by id). A string says why none. Pure read.
 */
export function antiRadarSite(state: GameState, pid: number, airfield: number, samTile: number): Building | string {
  if (airfield !== -1) {
    const b = buildingAt(state, airfield);
    if (!b || b.type !== 'airfield' || b.owner !== pid || b.buildLeft > 0) return 'Anti-radar missiles fly from a finished Airfield of yours';
    const left = seadReloadLeft(state, b);
    if (left > 0) return `This airfield is reloading: ${Math.ceil(left)} s`;
    const r = antiRadarReach(state, b);
    if (d2(state, b.tile, samTile) > r * r) return `Too far: anti-radar missiles reach ${Math.round(r)} tiles from this airfield`;
    return b;
  }
  let best: Building | null = null;
  let bestD = Infinity;
  let why = 'You need a finished Airfield';
  for (const b of buildingsOf(state, pid, 'airfield')) {
    if (b.buildLeft > 0 || b.owner !== pid) continue;
    const r = antiRadarReach(state, b);
    const d = d2(state, b.tile, samTile);
    if (d > r * r) {
      if (!best) why = 'Too far from your airfields';
      continue;
    }
    if (seadReloadLeft(state, b) > 0) {
      why = 'Your airfields in reach are reloading';
      continue;
    }
    if (d < bestD || (d === bestD && best !== null && b.id < best.id)) {
      best = b;
      bestD = d;
    }
  }
  return best ?? why;
}

/** The hostile SAM site on `tile` pid may aim at (finished, seen), or a reason. Pure read. */
export function antiRadarTarget(state: GameState, pid: number, tile: number): Building | string {
  const b = buildingAt(state, tile);
  if (!b || b.type !== 'sam' || b.buildLeft > 0) return 'Pick an enemy SAM site';
  if (b.owner === pid) return 'That SAM site is yours';
  if (!hostile(state, pid, b.owner)) return areAllied(state, pid, b.owner) ? 'That SAM site is an ally\'s' : peaceReason(state, pid, b.owner) ?? 'Not at war with them';
  if (!knownTile(state, pid, b.tile)) return 'You have not seen that SAM site';
  return b;
}

/**
 * Why an anti-radar missile of pid from `airfield` (-1 = the nearest ready in reach) at the SAM on `samTile` cannot fly
 * ('' = it can). The lock: the SAM's radar must be on ("SAM radar is off: wait until it fires"). Pure read.
 */
export function antiRadarReason(state: GameState, pid: number, airfield: number, samTile: number): string {
  const why = antiRadarPlayerReason(state, pid);
  if (why) return why;
  const t = antiRadarTarget(state, pid, samTile);
  if (typeof t === 'string') return t;
  if (radarOnLeft(state, t) <= 0) return 'SAM radar is off: wait until it fires';
  const site = antiRadarSite(state, pid, airfield, t.tile);
  return typeof site === 'string' ? site : '';
}

/** Action antiRadar: pays, reloads the airfield, sends the missile (Unit.chase = the SAM's id); the target is warned. */
export function launchAntiRadar(state: GameState, pid: number, airfield: number, samTile: number): ActionResult {
  if (typeof airfield !== 'number' || !Number.isInteger(airfield) || !Number.isInteger(samTile)) return FAIL('Invalid tile');
  const why = antiRadarReason(state, pid, airfield, samTile);
  if (why) return FAIL(why);
  const sam = antiRadarTarget(state, pid, samTile) as Building;
  const site = antiRadarSite(state, pid, airfield, sam.tile) as Building;
  site.seadReady = state.tick + Math.round(ANTI_RADAR.cooldownSeconds * TICKS_PER_SECOND);
  const u = buyUnit(state, 'antiRadarMissile', pid, site.tile, sam.tile);
  u.chase = sam.id;
  u.targetOwner = sam.owner;
  state.units.push(u);
  addEvent(state, 'missile', `${state.players[pid].name} fired an anti-radar missile at a SAM site of ${state.players[sam.owner].name}`, [pid, sam.owner], sam.tile);
  return { ok: true };
}

/** The missile reached its SAM site (units.ts updateUnits): the barrage knock-out. */
export function antiRadarArrived(state: GameState, u: Unit): void {
  const w = state.map.width;
  state.effects.push({ kind: 'explosion', x: (u.target % w) + 0.5, y: ((u.target / w) | 0) + 0.5, radius: 1.2, tick: state.tick });
  const b = state.buildings.get(u.chase ?? -1);
  if (!b || b.type !== 'sam' || b.tile !== u.target || !hostile(state, u.owner, b.owner)) return;
  b.hp -= ANTI_RADAR.damage;
  const until = state.tick + Math.round(ANTI_RADAR.knockSeconds * TICKS_PER_SECOND);
  b.disabledUntil = Math.max(b.disabledUntil, until);
  const who = state.players[b.owner].name;
  if (b.hp <= 1e-9) {
    destroyBuilding(state, b);
    addEvent(state, 'buildingLost', `An anti-radar missile of ${state.players[u.owner].name} destroyed a SAM site of ${who}`, [u.owner, b.owner], u.target);
  } else addEvent(state, 'bombing', `An anti-radar missile of ${state.players[u.owner].name} knocked out a SAM site of ${who} for ${ANTI_RADAR.knockSeconds} s`, [u.owner, b.owner], u.target);
}

/** Action setAntiRadarEscort {on}. */
export function setAntiRadarEscort(state: GameState, pid: number, on: unknown): ActionResult {
  const p = state.players[pid];
  if (!p || pid <= 0 || !p.alive) return FAIL('No such player');
  if (typeof on !== 'boolean') return FAIL('Invalid setting');
  if (on && !hasTech(p, 'antiRadar')) return FAIL('Needs Anti-radar Missiles');
  if (on) p.antiRadarEscort = true;
  else delete p.antiRadarEscort;
  return { ok: true };
}

/** True if a missile of pid already flies at SAM building `samId`. */
function inFlight(state: GameState, pid: number, samId: number): boolean {
  for (const u of state.units) if (u.type === 'antiRadarMissile' && u.owner === pid && u.hp > 0 && u.chase === samId) return true;
  return false;
}

/** Once a second (sim.ts, after the units): escort mode answers the SAM sites that just shot at the player's planes. */
export function updateAntiRadar(state: GameState): void {
  if (state.tick % TICKS_PER_SECOND !== 0) return;
  let any = false;
  for (const p of state.players) if (p.antiRadarEscort && p.alive) any = true;
  if (!any) return;
  const since = state.tick - TICKS_PER_SECOND;
  const sams = [...state.buildings.values()].filter((b) => b.type === 'sam' && b.firedAt !== undefined && b.firedAt > since).sort((a, b) => a.id - b.id);
  if (!sams.length) return;
  for (const p of state.players) {
    if (!p.antiRadarEscort || !p.alive || antiRadarPlayerReason(state, p.id)) continue;
    for (const s of sams) {
      if (s.firedOn !== p.id || inFlight(state, p.id, s.id) || isDisabled(state, s)) continue;
      if (antiRadarReason(state, p.id, -1, s.tile)) continue;
      launchAntiRadar(state, p.id, -1, s.tile);
    }
  }
}

/**
 * AI: from Normal up, before a raid (stored bombers), each radar-on SAM site it knows of within reach of its loaded
 * airfields that covers one of its strike targets (`targets`: tiles) draws one missile, strongest SAM first, while it
 * keeps ANTI_RADAR.aiReserve missile prices in gold. Easy AIs and humans never. Returns how many it fired.
 */
export function aiAntiRadar(state: GameState, id: number, targets: readonly number[]): number {
  const p = state.players[id];
  if (!p || p.isHuman || !p.alive || !hasTech(p, 'antiRadar') || aiAttackLevel(state) < 1 || !targets.length) return 0;
  let bombers = 0;
  for (const b of buildingsOf(state, id, 'airfield')) if (b.buildLeft <= 0) bombers += b.bombers;
  if (bombers < ANTI_RADAR.aiMinBombers) return 0;
  const w = state.map.width;
  const cands: Building[] = [];
  for (const b of state.buildings.values()) {
    if (b.type !== 'sam' || b.buildLeft > 0 || isDisabled(state, b) || radarOnLeft(state, b) <= 0 || !hostile(state, id, b.owner)) continue;
    if (!knownTile(state, id, b.tile) || inFlight(state, id, b.id)) continue;
    const r = samRadius(b) + 4;
    let covers = false;
    for (const t of targets) {
      const dx = (b.tile % w) - (t % w);
      const dy = ((b.tile / w) | 0) - ((t / w) | 0);
      if (dx * dx + dy * dy <= r * r) {
        covers = true;
        break;
      }
    }
    if (covers) cands.push(b);
  }
  cands.sort((a, b) => b.level - a.level || a.id - b.id);
  let fired = 0;
  const c = unitCost(state, id, 'antiRadarMissile');
  for (const s of cands) {
    if (p.gold < c.gold * (ANTI_RADAR.aiReserve + 1) || p.oil < c.oil) break;
    if (antiRadarReason(state, id, -1, s.tile)) continue;
    if (launchAntiRadar(state, id, -1, s.tile).ok) fired++;
  }
  return fired;
}

/** Hash of the anti-radar state (hash.ts): SAM fire marks, airfield reloads, escort flags. */
export function hashAntiRadar(state: GameState, h: number, mixInt: (h: number, v: number) => number): number {
  for (const b of state.buildings.values()) {
    if (b.firedAt !== undefined) h = mixInt(mixInt(mixInt(h, 0x534144), b.id), b.firedAt ^ ((b.firedOn ?? 0) << 20));
    if (b.seadReady !== undefined) h = mixInt(mixInt(mixInt(h, 0x534552), b.id), b.seadReady);
  }
  for (const p of state.players) if (p.antiRadarEscort) h = mixInt(mixInt(h, 0x455343), p.id);
  return h;
}
