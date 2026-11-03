// Strikes (bombers, rockets, atom bombs) beyond a single launch: one effect rule for manual and automatic bombers,
// smart aim ahead of a moving front, salvos, the last result of every airfield, and rocket auto-fire.
//
//  - One strike rule: a manual bomb flies exactly like a wing bomber. Aimed at the front (within STRIKE.frontReach of
//    own or allied land, and not at a building) it is a support strike (airwings.supportStrike: zone, defence cut,
//    trench flattening, kills x ground-attack / heavy); otherwise a raid (income cut x heavy / ground-attack plus the
//    bomb drop: buildings, troops, Strategic Bombing burn; heavy bombers drop a bigger, wider load). Night Bombing,
//    doctrine levers and reach (heavy x1.5, Drop Tanks, carriers) apply to both.
//  - Smart aim: support strikes aim where the front will be when the bombers arrive (attack speed x flight time,
//    leadAim). On arrival every bomber whose aim is no longer hostile re-aims at the nearest hostile tile within
//    STRIKE.reaimRadius (support: a little deeper), else it flies home with its bombs.
//  - Salvos (Actions bomb / launchMissile with count, site -1 = every site): several launchers at one target.
//  - Rocket auto-fire (Action setAutoFire): ready silos fire rockets at the Follow-my-war target (forts near the main
//    front, SAMs covering it, then cities near it). Never atom bombs.
//
// Deterministic: state.rng only (night scatter), fixed iteration orders, no transcendental Math functions.

import { AIR, ATOM_KILL_SHARE, ATOM_RADIUS, BOMBER_BUILDING_HIT, BOMBER_MIN_KILL, BOMBER_RADIUS, BOMBER_TROOP_KILL, ROCKET_KILL_MIN, ROCKET_RADIUS, STRIKE, TECH_EFFECTS, TICKS_PER_SECOND, UNITS } from './config';
import {
  MISSION_COVER,
  MISSION_STRATEGIC,
  MISSION_SUPPORT,
  RAID_WEIGHT,
  airState,
  airSupportCutAfter,
  airWingRange,
  deeperAlong,
  launchFrom,
  nearestHostileTile,
  raid,
  raidCutPer,
  raidMaxCutOf,
  raidSecondsOf,
  supportStrike,
  supportStrikeRadius,
} from './airwings';
import { buildingAt, buildingsOf, chargesReady, nextChargeIn, samRadius } from './buildings';
import { frontTiles } from './combat';
import { areAllied } from './diplomacy';
import { atPeace, peaceReason, unitRule } from './rules';
import { hasTech } from './tech';
import { techAirSpeedMul, techBombBuildingHit, techBombRadiusMul, techOf } from './techtree';
import { nightEffectMul, nightRadiusMul, nightScatter } from './specials';
import { trenchLevel } from './trenches';
import { ROCKET_TROOP_KILL, dropBombs, launchMissile, unitCost } from './units';
import { airSupportMul, airVariantOf, carrierFor } from './variants';
import { followedNation, warAim } from './warTarget';
import type { ActionResult, AirResult, AirState, Building, BuildingType, GameState, Unit } from './types';

const FAIL = (reason: string): ActionResult => ({ ok: false, reason });

/** Unit.mission of a manual raid (same effects as MISSION_STRATEGIC; it keeps its aim while that is still hostile). */
export const MISSION_MANUAL_RAID = 4;

function hostile(state: GameState, a: number, b: number): boolean {
  return a !== b && a > 0 && b > 0 && !areAllied(state, a, b) && !atPeace(state, a, b);
}

function d2(w: number, a: number, b: number): number {
  const dx = (a % w) - (b % w);
  const dy = ((a / w) | 0) - ((b / w) | 0);
  return dx * dx + dy * dy;
}

/** x^n for a whole n >= 0 by repeated multiplication (no Math.pow in the sim). */
function powInt(x: number, n: number): number {
  let r = 1;
  for (let k = 0; k < n; k++) r *= x;
  return r;
}

/** Calls f for every map tile within radius r of `tile` (row by row). */
function eachInRadius(state: GameState, tile: number, r: number, f: (i: number, dd: number) => void): void {
  const map = state.map;
  const w = map.width;
  const cx = tile % w;
  const cy = (tile / w) | 0;
  const ri = Math.floor(r);
  for (let y = Math.max(0, cy - ri); y <= Math.min(map.height - 1, cy + ri); y++) {
    for (let x = Math.max(0, cx - ri); x <= Math.min(w - 1, cx + ri); x++) {
      const dd = (x - cx) * (x - cx) + (y - cy) * (y - cy);
      if (dd <= r * r) f(y * w + x, dd);
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------
// One strike rule
// ---------------------------------------------------------------------------------------------------------------

export type StrikeRole = 'support' | 'raid';

/**
 * What a manual bomb by pid at `tile` does: 'raid' when a hostile building other than a fort stands within
 * STRIKE.buildingPick of it (wreck it) or the aim is deep in enemy land; 'support' when own or allied land is within
 * STRIKE.frontReach (the front: a support strike for the push). Pure read.
 */
export function strikeRole(state: GameState, pid: number, tile: number): StrikeRole {
  let building = false;
  eachInRadius(state, tile, STRIKE.buildingPick, (i) => {
    if (building) return;
    const b = buildingAt(state, i);
    if (b && b.type !== 'fort' && b.buildLeft <= 0 && hostile(state, pid, b.owner)) building = true;
  });
  if (building) return 'raid';
  let front = false;
  const owner = state.map.owner;
  eachInRadius(state, tile, STRIKE.frontReach, (i) => {
    if (front) return;
    const o = owner[i];
    if (o === pid || (o > 0 && areAllied(state, pid, o))) front = true;
  });
  return front ? 'support' : 'raid';
}

/** Heavy bombers on a raid: radius and payload multipliers of the drop. */
function heavyDrop(state: GameState, owner: number): { radius: number; payload: number } {
  return airVariantOf(state, owner) === 'heavyBomber' ? { radius: STRIKE.heavyRadius, payload: STRIKE.heavyPayload } : { radius: 1, payload: 1 };
}

/** Bomb radius of a raid drop by `owner` (Strategic Bombing, Night Bombing, heavy bombers). */
export function raidRadius(state: GameState, owner: number): number {
  return BOMBER_RADIUS * techBombRadiusMul(state, owner) * nightRadiusMul(state, owner) * heavyDrop(state, owner).radius;
}

/**
 * A bomber over its aim (units.updateUnits): re-aims when the aim is lost (else it flies home with its bombs), the
 * Night Bombing scatter, then the strike of its role: support (manual front strikes, support and cover sorties) or
 * raid (manual raids, strategic sorties: the income raid plus the bomb drop). Adds to its airfield's last result.
 */
export function bomberArrived(state: GameState, u: Unit): void {
  const support = u.mission === MISSION_SUPPORT || u.mission === MISSION_COVER;
  if (!reaim(state, u, support)) {
    addResult(state, u, support ? 1 : 2, 0, 0, 1, 0, 0, 0);
    return;
  }
  nightScatter(state, u); // Night Bombing (specials.ts): the bombs land off the aim
  if (support) {
    const r = supportStrike(state, u);
    addResult(state, u, 1, r?.victim ?? 0, 1, 0, 0, r?.kills ?? 0, 0);
    return;
  }
  const o = state.map.owner[u.target];
  const victim = hostile(state, u.owner, o) && state.players[o]?.alive ? o : u.targetOwner;
  raid(state, u, victim);
  const h = heavyDrop(state, u.owner);
  const d = dropBombs(state, u, h.radius, h.payload);
  addResult(state, u, 2, victim, 1, 0, d.buildings, d.kills, d.gold);
}

/**
 * Re-aim on arrival. Still hostile: keep the aim (a strategic sortie whose building is gone takes another raid target
 * nearby). Lost (own, allied, neutral or at peace now): the nearest hostile tile within STRIKE.reaimRadius (the old
 * nation first; support goes STRIKE.reaimDeeper past it, a strategic sortie a raid target if one is near); none:
 * false, the bomber flies home with its bombs.
 */
function reaim(state: GameState, u: Unit, support: boolean): boolean {
  const map = state.map;
  const t = u.target;
  const o = map.owner[t];
  if (hostile(state, u.owner, o) && state.players[o]?.alive) {
    if (u.mission === MISSION_STRATEGIC && !raidBuildingNear(state, u.owner, t, STRIKE.buildingPick)) {
      const alt = raidBuildingNearest(state, u, t);
      if (alt >= 0) {
        u.target = alt;
        u.targetOwner = map.owner[alt];
      }
    }
    return true;
  }
  let h = u.mission === MISSION_STRATEGIC ? raidBuildingNearest(state, u, t) : -1;
  if (h < 0) h = nearestHostileTile(state, u.owner, t, STRIKE.reaimRadius, u.targetOwner);
  if (h < 0) return false;
  if (support) h = deeperAlong(state, t, h, STRIKE.reaimDeeper);
  u.target = h;
  u.targetOwner = map.owner[h];
  return true;
}

function raidBuildingNear(state: GameState, owner: number, tile: number, r: number): boolean {
  let found = false;
  eachInRadius(state, tile, r, (i) => {
    if (found) return;
    const b = buildingAt(state, i);
    if (b && b.buildLeft <= 0 && hostile(state, owner, b.owner) && (RAID_WEIGHT[b.type] !== undefined || b.type === 'sam')) found = true;
  });
  return found;
}

/** The most valuable hostile raid target within STRIKE.raidReaim of `tile` (the bomber's nation first), -1 = none. */
function raidBuildingNearest(state: GameState, u: Unit, tile: number): number {
  let best = -1;
  let bestS = -Infinity;
  eachInRadius(state, tile, STRIKE.raidReaim, (i, dd) => {
    const b = buildingAt(state, i);
    if (!b || b.buildLeft > 0 || !hostile(state, u.owner, b.owner) || state.map.owner[i] !== b.owner) return;
    const wgt = RAID_WEIGHT[b.type] ?? (b.type === 'sam' ? 2 : 0);
    if (wgt <= 0) return;
    const s = wgt + (b.owner === u.targetOwner ? 1 : 0) - dd / 100;
    if (s > bestS) {
      bestS = s;
      best = i;
    }
  });
  return best;
}

// ---------------------------------------------------------------------------------------------------------------
// Smart aim
// ---------------------------------------------------------------------------------------------------------------

/** Tiles per second pid's attacks on foe take (each attack's average so far). */
function pushRate(state: GameState, pid: number, foe: number): number {
  let rate = 0;
  for (const a of state.attacks) {
    if (a.attacker !== pid || a.target !== foe) continue;
    const age = Math.max(1, (state.tick - a.startTick) / TICKS_PER_SECOND);
    rate += a.tilesTaken / age;
  }
  return rate;
}

/** Seconds a bomber of `owner` needs from `from` to `to`. */
function flightSeconds(state: GameState, owner: number, from: number, to: number): number {
  return Math.sqrt(d2(state.map.width, from, to)) / (UNITS.bomber.speed * techAirSpeedMul(state, owner));
}

/**
 * Where a support strike from `from` at foe's tile `front` should aim: past the front by the ground pid's push on foe
 * will take during the flight (tiles taken per second / the shared border's length = depth per second, x flight
 * time x STRIKE.leadMul, at most STRIKE.leadMax) plus STRIKE.leadMargin, straight away from our land, on foe's land;
 * then the best tile within STRIKE.leadPick of that point (dug-in tiles and forts first). Pure read; returns `front`
 * when there is nothing better.
 */
export function leadAim(state: GameState, pid: number, foe: number, front: number, from: number): number {
  const map = state.map;
  if (foe <= 0 || front < 0 || front >= map.owner.length || map.owner[front] !== foe) return front;
  const w = map.width;
  // Direction: away from own / allied land around the front.
  let sx = 0;
  let sy = 0;
  let n = 0;
  const fx = front % w;
  const fy = (front / w) | 0;
  eachInRadius(state, front, 4, (i) => {
    const o = map.owner[i];
    if (o !== pid && !(o > 0 && areAllied(state, pid, o))) return;
    sx += i % w;
    sy += (i / w) | 0;
    n++;
  });
  if (!n) return front;
  let dx = fx - sx / n;
  let dy = fy - sy / n;
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len < 0.01) return front;
  dx /= len;
  dy /= len;
  const rate = pushRate(state, pid, foe);
  let depth = STRIKE.leadMargin;
  if (rate > 0) {
    const border = Math.max(4, frontTiles(state, pid, foe, 4000).length);
    depth += Math.min(STRIKE.leadMax, (rate / border) * flightSeconds(state, pid, from, front) * STRIKE.leadMul);
  }
  // Walk away from our land while it is still foe's land.
  let point = front;
  const steps = Math.ceil(depth);
  for (let k = 1; k <= steps; k++) {
    const x = Math.round(fx + dx * k);
    const y = Math.round(fy + dy * k);
    if (x < 0 || x >= w || y < 0 || y >= map.height) break;
    const t = y * w + x;
    if (map.owner[t] !== foe) break;
    point = t;
  }
  // Dug-in tiles and forts near the point first.
  let best = point;
  let bestS = -Infinity;
  eachInRadius(state, point, STRIKE.leadPick, (i, dd) => {
    if (map.owner[i] !== foe) return;
    const b = buildingAt(state, i);
    const fort = b && b.type === 'fort' && b.owner === foe && b.buildLeft <= 0 ? 3 : 0;
    const s = 2 * trenchLevel(state, i) + fort - 0.5 * Math.sqrt(dd);
    if (s > bestS || (s === bestS && i < best)) {
      bestS = s;
      best = i;
    }
  });
  return best;
}

// ---------------------------------------------------------------------------------------------------------------
// Salvos
// ---------------------------------------------------------------------------------------------------------------

function salvoSize(count: number | undefined): number | string {
  if (count === undefined) return 1;
  if (typeof count !== 'number' || !Number.isInteger(count) || count < 0 || count > STRIKE.maxSalvo) return 'Invalid count';
  return count === 0 ? Infinity : count;
}

function inReach(state: GameState, pid: number, b: Building, tile: number): boolean {
  const r = airWingRange(b, state);
  return d2(state.map.width, b.tile, tile) <= r * r || !!carrierFor(state, pid, tile);
}

/** Airfields a bomb salvo by pid at tile flies from: the given one, or every finished own one with bombers that reaches it (nearest first). */
function salvoAirfields(state: GameState, pid: number, airfield: number, tile: number): Building[] {
  if (airfield >= 0) {
    const b = buildingAt(state, airfield);
    return b ? [b] : [];
  }
  const w = state.map.width;
  return buildingsOf(state, pid, 'airfield')
    .filter((b) => b.buildLeft <= 0 && b.bombers > 0 && inReach(state, pid, b, tile))
    .sort((a, b) => d2(w, a.tile, tile) - d2(w, b.tile, tile) || a.id - b.id);
}

/** Where airfield b's bombers aim for a manual strike at tile (support: led ahead of the push, in reach). */
function manualAim(state: GameState, pid: number, b: Building, tile: number, role: StrikeRole): number {
  if (role !== 'support') return tile;
  const led = leadAim(state, pid, state.map.owner[tile], tile, b.tile);
  return led >= 0 && inReach(state, pid, b, led) ? led : tile;
}

/**
 * Action bomb: `count` bombers (absent = 1, 0 = every ready one) at `tile`, from `airfield` or (-1) from every own
 * airfield that reaches it, nearest first. They strike by the one strike rule (strikeRole). ok when at least one flew.
 */
export function bombSalvo(state: GameState, pid: number, airfield: number, tile: number, count?: number): ActionResult {
  const want = salvoSize(count);
  if (typeof want === 'string') return FAIL(want);
  const p = state.players[pid];
  if (!p || pid === 0 || !p.alive) return FAIL('No such player');
  const ruledB = unitRule(state, 'bomber');
  if (ruledB) return FAIL(ruledB);
  const n = state.map.owner.length;
  if (!Number.isInteger(tile) || tile < 0 || tile >= n) return FAIL('Invalid tile');
  if (airfield !== -1 && (!Number.isInteger(airfield) || airfield < 0 || airfield >= n)) return FAIL('Invalid tile');
  const sites = salvoAirfields(state, pid, airfield, tile);
  if (!sites.length) {
    if (airfield >= 0) return FAIL('Bombers fly from a finished Airfield of yours');
    const any = buildingsOf(state, pid, 'airfield').filter((b) => b.buildLeft <= 0);
    if (!any.length) return FAIL('Bombers fly from a finished Airfield of yours');
    if (!any.some((b) => b.bombers > 0)) return FAIL('No bombers at your airfields');
    return FAIL('None of your airfields reaches that far');
  }
  const role = strikeRole(state, pid, tile);
  const mission = role === 'support' ? MISSION_SUPPORT : MISSION_MANUAL_RAID;
  let sent = 0;
  let why = '';
  for (const b of sites) {
    if (sent >= want) break;
    const aim = manualAim(state, pid, b, tile, role);
    while (sent < want) {
      const u = launchFrom(state, pid, b, aim, mission);
      if (typeof u === 'string') {
        if (!why) why = u;
        break;
      }
      sent++;
    }
  }
  return sent > 0 ? { ok: true } : FAIL(why || 'No bombers at this airfield');
}

/** Silos a missile salvo fires from: the given one, or every finished own silo with a launch ready (nearest first). */
function salvoSilos(state: GameState, pid: number, silo: number, tile: number): Building[] {
  if (silo >= 0) {
    const b = buildingAt(state, silo);
    return b ? [b] : [];
  }
  const w = state.map.width;
  return buildingsOf(state, pid, 'silo')
    .filter((b) => b.buildLeft <= 0 && chargesReady(b) >= 1)
    .sort((a, b) => d2(w, a.tile, tile) - d2(w, b.tile, tile) || a.id - b.id);
}

/**
 * Action launchMissile: `count` missiles (absent = 1, 0 = every ready launch) of `kind` at `tile`, from `silo` or
 * (-1) from every own silo with a launch ready, nearest first. Stops at the first launch it cannot pay for. ok when
 * at least one flew. (No missile range: every silo reaches.)
 */
export function missileSalvo(state: GameState, pid: number, silo: number, kind: 'rocket' | 'atomBomb', tile: number, count?: number): ActionResult {
  const want = salvoSize(count);
  if (typeof want === 'string') return FAIL(want);
  const p = state.players[pid];
  if (!p || pid === 0 || !p.alive) return FAIL('No such player');
  if (kind !== 'rocket' && kind !== 'atomBomb') return FAIL('Invalid missile');
  const ruled = kind === 'atomBomb' ? unitRule(state, 'atomBomb') : null;
  if (ruled) return FAIL(ruled);
  if (silo !== -1 && (!Number.isInteger(silo) || silo < 0 || silo >= state.map.owner.length)) return FAIL('Invalid tile');
  const sites = salvoSilos(state, pid, silo, tile);
  if (!sites.length) {
    if (silo >= 0) return FAIL('Missiles fly from a finished Missile Silo of yours');
    return FAIL(buildingsOf(state, pid, 'silo').some((b) => b.buildLeft <= 0) ? 'All your silos are reloading' : 'Missiles fly from a finished Missile Silo of yours');
  }
  let sent = 0;
  let why = '';
  for (const b of sites) {
    while (sent < want) {
      const ready = b.type === 'silo' && b.owner === pid && b.buildLeft <= 0 && chargesReady(b) >= 1;
      const r = launchMissile(state, pid, b.tile, kind, tile);
      if (!r.ok) {
        if (!why) why = r.reason ?? 'Not possible';
        if (ready) return sent > 0 ? { ok: true } : FAIL(why); // not a reload: price, rules, target
        break;
      }
      sent++;
    }
    if (sent >= want) break;
  }
  return sent > 0 ? { ok: true } : FAIL(why || 'All your silos are reloading');
}

// ---------------------------------------------------------------------------------------------------------------
// Strike preview (client)
// ---------------------------------------------------------------------------------------------------------------

export type StrikeKind = 'bomb' | 'rocket' | 'atomBomb';

/** What a strike would do (strikePreview): every number is the expected effect of all launchers together. */
export interface StrikePreview {
  ok: boolean;
  /** why it can't fly ('' = it can) */
  reason: string;
  /** bombs: 'support' (front strike) or 'raid'; missiles: their kind */
  role: StrikeRole | 'rocket' | 'atomBomb';
  /** where it would aim (bombs on the front: led ahead of the push) and the blast radius there */
  aim: number;
  radius: number;
  /** how many would fly, and from which site tiles */
  launchers: number;
  sites: number[];
  /** the main nation hit (0 = none), its tiles in the radius and the hostile buildings there */
  victim: number;
  enemyTiles: number;
  enemyBuildings: number;
  /** own tiles / buildings in the radius (atom bombs hit them too) */
  ownTiles: number;
  ownBuildings: number;
  /** expected troops killed and buildings wrecked */
  kills: number;
  buildingsHit: number;
  /** support: defence cut in the zone after this strike (0..1) and how long the zone lasts (s) */
  zoneCut: number;
  zoneSeconds: number;
  /** raid: income cut of the victim after this strike (0..1) and how long it lasts (s); Strategic Bombing gold burnt */
  raidCut: number;
  raidSeconds: number;
  goldBurn: number;
}

function emptyPreview(role: StrikePreview['role'], tile: number, reason: string): StrikePreview {
  return { ok: false, reason, role, aim: tile, radius: 0, launchers: 0, sites: [], victim: 0, enemyTiles: 0, enemyBuildings: 0, ownTiles: 0, ownBuildings: 0, kills: 0, buildingsHit: 0, zoneCut: 0, zoneSeconds: 0, raidCut: 0, raidSeconds: 0, goldBurn: 0 };
}

function armyOf(state: GameState, pid: number): number {
  const t = state.players[pid]?.troops;
  return t ? t.infantry + t.armor + t.artillery : 0;
}

/**
 * What a strike of `kind` by pid at `tile` with `count` launchers (1 default, 0 = every ready one) from `from` (a
 * site tile, -1 = every site, as the salvo picks them) would do: the role, the aim and radius, how many fly, and
 * the expected kills, wrecked buildings, zone cut or income raid. Uses the sim's own numbers (one strike rule). Pure
 * read (no randomness, no cache writes): the Night Bombing scatter and interceptions are not in it.
 */
export function strikePreview(state: GameState, pid: number, kind: StrikeKind, tile: number, count = 1, from = -1): StrikePreview {
  const map = state.map;
  const isBomb = kind === 'bomb';
  const role0: StrikePreview['role'] = isBomb ? 'raid' : kind;
  if (!Number.isInteger(tile) || tile < 0 || tile >= map.owner.length) return emptyPreview(role0, -1, 'Pick a tile on the map');
  const want = salvoSize(count);
  if (typeof want === 'string') return emptyPreview(role0, tile, want);
  const p = state.players[pid];
  if (!p?.alive) return emptyPreview(role0, tile, 'No such player');
  const o = map.owner[tile];
  // Who owns the aim.
  let why = '';
  if (o === pid) why = 'That is your own land';
  else if (o === 0 && isBomb) why = 'Nobody to bomb there';
  else if (o > 0 && !state.players[o]?.alive) why = 'That nation is gone';
  else if (o > 0 && areAllied(state, pid, o)) why = isBomb ? 'You cannot bomb an ally' : 'You cannot fire at an ally';
  else why = peaceReason(state, pid, o) ?? '';
  if (!why && kind === 'atomBomb') why = unitRule(state, 'atomBomb') ?? '';
  if (!why && !isBomb && !hasTech(p, UNITS[kind].tech!)) why = `Needs research: ${kind === 'rocket' ? 'Rocketry' : 'Nuclear Fission'}`;
  if (!why && isBomb) why = unitRule(state, 'bomber') ?? '';
  if (!why && isBomb && !hasTech(p, 'flight')) why = 'Needs research: Flight';

  const out = emptyPreview(role0, tile, why);
  // Launchers.
  const sites: Building[] = [];
  let launchers = 0;
  if (isBomb) {
    const role = strikeRole(state, pid, tile);
    out.role = role;
    for (const b of salvoAirfields(state, pid, from, tile)) {
      if (launchers >= want) break;
      if (b.type !== 'airfield' || b.owner !== pid || b.buildLeft > 0 || b.bombers < 1 || !inReach(state, pid, b, tile)) continue;
      const k = Math.min(b.bombers, want - launchers);
      launchers += k;
      sites.push(b);
    }
    if (!out.reason && !launchers) out.reason = from >= 0 ? 'No bombers at this airfield (or out of its reach)' : 'No airfield with bombers reaches that far';
    out.aim = sites.length ? manualAim(state, pid, sites[0], tile, role) : tile;
  } else {
    const c = unitCost(state, pid, kind);
    let gold = p.gold;
    let iron = p.iron;
    let oil = p.oil;
    for (const b of salvoSilos(state, pid, from, tile)) {
      if (launchers >= want) break;
      if (b.type !== 'silo' || b.owner !== pid || b.buildLeft > 0) continue;
      let k = 0;
      for (let r = chargesReady(b); r > 0 && launchers < want && gold >= c.gold && iron >= c.iron && oil >= c.oil; r--) {
        gold -= c.gold;
        iron -= c.iron;
        oil -= c.oil;
        launchers++;
        k++;
      }
      if (k > 0) sites.push(b);
    }
    if (!out.reason && !launchers) {
      const own = from >= 0 ? [buildingAt(state, from)].filter((b): b is Building => !!b && b.type === 'silo' && b.owner === pid) : buildingsOf(state, pid, 'silo').filter((b) => b.buildLeft <= 0);
      if (!own.length) out.reason = 'Missiles fly from a finished Missile Silo of yours';
      else if (own.every((b) => chargesReady(b) < 1)) out.reason = own.length === 1 ? `The silo is reloading (${Math.ceil(nextChargeIn(own[0]))} s)` : 'All your silos are reloading';
      else out.reason = `Not enough resources (${c.gold} gold, ${c.iron} iron, ${c.oil} oil a launch)`;
    }
  }
  out.launchers = launchers;
  out.sites = sites.map((b) => b.tile);
  const n = Math.max(1, launchers);
  const aim = out.aim;

  // Blast.
  const radius = !isBomb ? (kind === 'rocket' ? ROCKET_RADIUS : ATOM_RADIUS) : out.role === 'support' ? supportStrikeRadius(state, pid, sites[0]?.tile ?? -1) : raidRadius(state, pid);
  out.radius = radius;
  const tilesBy = new Map<number, number>();
  let hostileTiles = 0;
  let hostileBuildings = 0;
  eachInRadius(state, aim, radius, (i) => {
    const q = map.owner[i];
    const b = buildingAt(state, i);
    if (q === pid) out.ownTiles++;
    if (b && b.owner === pid) out.ownBuildings++;
    if (q > 0 && hostile(state, pid, q) && state.players[q]?.alive) {
      tilesBy.set(q, (tilesBy.get(q) ?? 0) + 1);
      hostileTiles++;
    }
    if (b && hostile(state, pid, b.owner)) hostileBuildings++;
  });
  const ao = map.owner[aim];
  let victim = ao > 0 && tilesBy.has(ao) ? ao : 0;
  if (!victim) {
    let bestN = 0;
    for (const [q, k] of tilesBy) {
      if (k > bestN || (k === bestN && q < victim)) {
        victim = q;
        bestN = k;
      }
    }
  }
  out.victim = victim;
  out.enemyTiles = victim ? tilesBy.get(victim) ?? 0 : 0;
  out.enemyBuildings = hostileBuildings;
  if (!out.reason && hostileTiles === 0) out.reason = 'Nothing of the enemy to hit there';

  if (kind === 'rocket') {
    out.buildingsHit = hostileBuildings * Math.min(1, launchers);
    for (const [q, k] of tilesBy) out.kills += n * Math.max(ROCKET_KILL_MIN, ROCKET_TROOP_KILL * armyOf(state, q) * (k / Math.max(1, state.players[q].tiles)));
  } else if (kind === 'atomBomb') {
    // Every building in the radius, own ones too.
    out.buildingsHit = hostileBuildings + out.ownBuildings;
    const mid = (ATOM_KILL_SHARE[0] + ATOM_KILL_SHARE[1]) / 2;
    for (const [q, k] of tilesBy) out.kills += mid * armyOf(state, q) * Math.min(1, (n * k) / Math.max(1, state.players[q].tiles));
  } else if (out.role === 'support') {
    if (victim) {
      const vp = state.players[victim];
      const tiles = tilesBy.get(victim) ?? 0;
      const per = Math.max((AIR.supportMinKill * tiles) / Math.max(1, hostileTiles), AIR.supportKillShare * armyOf(state, victim) * (tiles / Math.max(1, vp.tiles))) * nightEffectMul(state, pid) * airSupportMul(state, pid);
      out.kills = Math.min(armyOf(state, victim), per * n);
      out.zoneCut = airSupportCutAfter(state, pid, aim, n);
      out.zoneSeconds = AIR.supportSeconds;
    }
  } else {
    const h = heavyDrop(state, pid);
    const night = nightEffectMul(state, pid) * h.payload;
    const hit = Math.min(1, techBombBuildingHit(state, pid, BOMBER_BUILDING_HIT) * night);
    out.buildingsHit = hostileBuildings * (1 - powInt(1 - hit, n));
    for (const [q, k] of tilesBy) out.kills += Math.min(armyOf(state, q), n * Math.max((BOMBER_MIN_KILL * k) / hostileTiles, BOMBER_TROOP_KILL * armyOf(state, q) * (k / Math.max(1, state.players[q].tiles))) * night);
    if (victim) {
      const live = state.air?.raids.find((r) => r.victim === victim && r.untilTick > state.tick);
      out.raidCut = Math.min(raidMaxCutOf(state, pid), (live?.cut ?? 0) + n * raidCutPer(state, pid));
      out.raidSeconds = raidSecondsOf(state, pid);
    }
    if (techOf(state, pid, 'strategicBombing')) {
      const keep = powInt(1 - TECH_EFFECTS.strategicResourceBurn, n);
      for (const q of tilesBy.keys()) out.goldBurn += state.players[q].gold * (1 - keep);
    }
  }
  out.ok = out.reason === '';
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Last strike result per airfield
// ---------------------------------------------------------------------------------------------------------------

/** Adds one bomber's arrival to its airfield's latest result (a new result after STRIKE.resultMergeSeconds). */
function addResult(state: GameState, u: Unit, mission: number, victim: number, hit: number, saved: number, buildings: number, kills: number, gold: number): void {
  const b = buildingAt(state, u.home);
  if (!b || b.type !== 'airfield' || b.owner !== u.owner) return;
  const air = airState(state);
  let list = (air.results ??= []);
  if (list.some((r) => { const x = state.buildings.get(r.airfield); return !x || x.type !== 'airfield' || x.owner !== r.owner; })) {
    list = air.results = list.filter((r) => { const x = state.buildings.get(r.airfield); return !!x && x.type === 'airfield' && x.owner === r.owner; });
  }
  let r = list.find((x) => x.airfield === b.id);
  const fresh = (): AirResult => ({ airfield: b.id, owner: u.owner, start: state.tick, tick: state.tick, mission, victim: 0, bombers: 0, saved: 0, buildings: 0, kills: 0, gold: 0 });
  if (!r) {
    r = fresh();
    list.push(r);
  } else if (r.owner !== u.owner || state.tick - r.tick > STRIKE.resultMergeSeconds * TICKS_PER_SECOND) {
    Object.assign(r, fresh());
  }
  r.tick = state.tick;
  if (hit) r.mission = mission;
  if (victim > 0) r.victim = victim;
  r.bombers += hit;
  r.saved += saved;
  r.buildings += buildings;
  r.kills += kills;
  r.gold += gold;
}

function shortCount(v: number): string {
  if (v >= 1e6) return `${Math.round(v / 1e5) / 10}M`;
  if (v >= 1e4) return `${Math.round(v / 1e3)}k`;
  if (v >= 1e3) return `${Math.round(v / 100) / 10}k`;
  return `${Math.round(v)}`;
}

/** The latest strike result of an airfield (tile) for its panel: a short line and its age in seconds; null = none yet. Pure read. */
export function wingLastResult(state: GameState, airfieldTile: number): { text: string; secondsAgo: number; result: AirResult } | null {
  const b = buildingAt(state, airfieldTile);
  if (!b || b.type !== 'airfield') return null;
  const r = state.air?.results?.find((x) => x.airfield === b.id && x.owner === b.owner);
  if (!r) return null;
  const name = r.victim > 0 ? state.players[r.victim]?.name ?? 'the enemy' : 'the enemy';
  const back = r.saved > 0 ? `${r.saved} bomber${r.saved === 1 ? '' : 's'} came back with ${r.saved === 1 ? 'its' : 'their'} bombs` : '';
  let text: string;
  if (r.bombers <= 0) text = `Last sortie: ${back} (no enemy land left near the aim)`;
  else if (r.mission === 1) text = `Support: hit ${shortCount(r.kills)} troops ahead of your push on ${name}`;
  else {
    const parts = [`${r.buildings} building${r.buildings === 1 ? '' : 's'} hit in ${name}`, `${shortCount(r.kills)} troops`];
    if (r.gold >= 1) parts.push(`${shortCount(r.gold)} gold burnt`);
    text = `Last raid: ${parts.join(', ')}`;
  }
  if (r.bombers > 0 && back) text += `; ${back}`;
  return { text, secondsAgo: Math.max(0, (state.tick - r.tick) / TICKS_PER_SECOND), result: r };
}

/** Mixes the strike results into the state hash (airwings.hashAir). */
export function hashResults(air: AirState, h: number, mixInt: (h: number, v: number) => number, mixFloat: (h: number, v: number) => number): number {
  const list = air.results;
  if (!list) return h;
  h = mixInt(h, list.length | 0x20000);
  for (const r of list) {
    h = mixInt(h, r.airfield);
    h = mixInt(h, r.owner);
    h = mixInt(h, r.start);
    h = mixInt(h, r.tick);
    h = mixInt(h, r.mission);
    h = mixInt(h, r.victim);
    h = mixInt(h, r.bombers);
    h = mixInt(h, r.saved);
    h = mixInt(h, r.buildings);
    h = mixFloat(h, r.kills);
    h = mixFloat(h, r.gold);
  }
  return h;
}

// ---------------------------------------------------------------------------------------------------------------
// Rocket auto-fire
// ---------------------------------------------------------------------------------------------------------------

/** True when the silo (tile) fires rockets at its owner's war target by itself (Action setAutoFire). Pure read. */
export function autoFireOn(state: GameState, siloTile: number): boolean {
  const f = state.follow;
  if (!f) return false;
  const b = buildingAt(state, siloTile);
  if (!b || b.type !== 'silo') return false;
  return !!f.fireAll?.includes(b.owner) || !!f.fire?.includes(b.id);
}

/** True when every silo of pid (also later ones) auto-fires. Pure read. */
export function autoFireAll(state: GameState, pid: number): boolean {
  return !!state.follow?.fireAll?.includes(pid);
}

/**
 * Action setAutoFire: rocket auto-fire on / off for an own silo, or (-1) for every own silo (also ones built later).
 * Turning one silo off while all are on keeps the others on. Needs Rocketry. Atom bombs never auto-fire.
 */
export function setAutoFire(state: GameState, pid: number, silo: number, on: boolean): ActionResult {
  const p = state.players[pid];
  if (!p || pid === 0 || !p.alive) return FAIL('No such player');
  if (typeof on !== 'boolean') return FAIL('Invalid value');
  if (!hasTech(p, 'rocketry')) return FAIL('Needs research: Rocketry');
  const own = buildingsOf(state, pid, 'silo');
  const f = (state.follow ??= { targets: [], recon: [] });
  const ids = new Set(f.fire ?? []);
  const all = new Set(f.fireAll ?? []);
  if (silo === -1) {
    if (on) all.add(pid);
    else all.delete(pid);
    for (const b of own) ids.delete(b.id);
  } else {
    if (!Number.isInteger(silo) || silo < 0 || silo >= state.map.owner.length) return FAIL('Invalid tile');
    const b = buildingAt(state, silo);
    if (!b || b.type !== 'silo' || b.owner !== pid) return FAIL('Auto-fire is set on a Missile Silo of yours');
    if (on) ids.add(b.id);
    else {
      ids.delete(b.id);
      if (all.has(pid)) {
        all.delete(pid);
        for (const o of own) if (o.id !== b.id) ids.add(o.id);
      }
    }
  }
  f.fire = [...ids].sort((a, b) => a - b);
  f.fireAll = [...all].sort((a, b) => a - b);
  return { ok: true };
}

/**
 * Rocket targets of pid against `nation`, best first: forts near the main front, SAMs covering it, cities near it
 * (a war overseas: around the nation's coast nearest the war, warTarget.warAim).
 */
function autoFireTargets(state: GameState, pid: number, nation: number): number[] {
  const front = warAim(state, pid, nation);
  if (front < 0) return [];
  const w = state.map.width;
  const owner = state.map.owner;
  const pick = (type: BuildingType, ok: (b: Building, dd: number) => boolean): number[] =>
    buildingsOf(state, nation, type)
      .filter((b) => b.buildLeft <= 0 && owner[b.tile] === nation && ok(b, d2(w, b.tile, front)))
      .sort((a, b) => d2(w, a.tile, front) - d2(w, b.tile, front) || a.id - b.id)
      .map((b) => b.tile);
  return [
    ...pick('fort', (_b, dd) => dd <= STRIKE.fireFortReach * STRIKE.fireFortReach),
    ...pick('sam', (b, dd) => dd <= (samRadius(b) + 10) * (samRadius(b) + 10)),
    ...pick('city', (_b, dd) => dd <= STRIKE.fireCityReach * STRIKE.fireCityReach),
  ];
}

/** Rocket auto-fire targets of pid against `nation` now, best first (client: the silo's Auto line). Pure read. */
export function autoFireTargetsFor(state: GameState, pid: number, nation: number): number[] {
  return nation > 0 && hostile(state, pid, nation) ? autoFireTargets(state, pid, nation) : [];
}

/** True when pid keeps its rocket reserve (STRIKE.fireReserve prices): auto-fire waits for more gold / iron / oil. Pure read. */
export function autoFireSaving(state: GameState, pid: number): boolean {
  const p = state.players[pid];
  if (!p) return false;
  const c = unitCost(state, pid, 'rocket');
  return p.gold < c.gold * STRIKE.fireReserve || p.iron < c.iron * STRIKE.fireReserve || p.oil < c.oil * STRIKE.fireReserve;
}

/**
 * Rocket auto-fire pass (airwings.updateAir): every STRIKE.fireSeconds per player (staggered by id), each ready
 * auto-fire silo of a player with a war target (Follow my war) fires one rocket at the best target not already under
 * an own rocket's blast (one per target), while the player keeps STRIKE.fireReserve rocket prices. Never atom bombs.
 */
export function updateAutoFire(state: GameState): void {
  const f = state.follow;
  if (!f || (!f.fire?.length && !f.fireAll?.length) || state.phase !== 'playing') return;
  const every = Math.max(1, Math.round(STRIKE.fireSeconds * TICKS_PER_SECOND));
  if (f.fire?.length && state.tick % every === 0) {
    f.fire = f.fire.filter((id) => {
      const b = state.buildings.get(id);
      return !!b && b.type === 'silo' && !!state.players[b.owner]?.alive;
    });
  }
  const players = new Set<number>(f.fireAll ?? []);
  for (const id of f.fire ?? []) {
    const b = state.buildings.get(id);
    if (b) players.add(b.owner);
  }
  const w = state.map.width;
  for (const pid of [...players].sort((a, b) => a - b)) {
    if ((state.tick + pid) % every !== 0) continue;
    const p = state.players[pid];
    if (!p?.alive || !hasTech(p, 'rocketry')) continue;
    const silos = buildingsOf(state, pid, 'silo').filter((b) => b.buildLeft <= 0 && chargesReady(b) >= 1 && autoFireOn(state, b.tile)).sort((a, b) => a.id - b.id);
    if (!silos.length) continue;
    const nation = followedNation(state, pid);
    if (nation <= 0 || !hostile(state, pid, nation)) continue;
    const targets = autoFireTargets(state, pid, nation);
    if (!targets.length) continue;
    const r2 = ROCKET_RADIUS * ROCKET_RADIUS;
    const struck: number[] = [];
    for (const u of state.units) if (u.type === 'rocket' && u.owner === pid && u.hp > 0) struck.push(u.target);
    const c = unitCost(state, pid, 'rocket');
    fire: for (const silo of silos) {
      while (chargesReady(silo) >= 1) {
        if (p.gold < c.gold * STRIKE.fireReserve || p.iron < c.iron * STRIKE.fireReserve || p.oil < c.oil * STRIKE.fireReserve) break fire;
        const t = targets.find((x) => !struck.some((s) => d2(w, s, x) <= r2));
        if (t === undefined) break;
        if (!launchMissile(state, pid, silo.tile, 'rocket', t).ok) break;
        struck.push(t);
      }
    }
  }
}

