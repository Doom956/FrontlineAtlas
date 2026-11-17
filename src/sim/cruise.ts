// Cruise missiles from sea (DESIGN section 7, config CRUISE and UNITS.cruiseMissile): what a strike would do, and
// how AI nations use them. The rules (Action cruiseMissile, the flight, the blast, the reload) live in units.ts next
// to the rockets: launchCruise, cruiseReason, cruiseImpact.
//
// The AI (aiCruise, from ai.ts airAndMissiles every 8 s): an AI nation with Naval Mastery and loaded warships,
// destroyers or battleships at war picks the best building of a nation it fights within reach of its ships, known to
// it (fog of war): SAMs, silos and airfields first (more so near a landing of its own on the way: they would shoot
// the landing's cover down), then factories, forts, ports, arsenals, cities and the rest. It fires a salvo one
// larger than the ready SAM shots covering the route and the target (so one gets through), never into more than
// CRUISE.aiMaxCover of them, and keeps CRUISE.aiReserve missile prices in gold. Easy AIs fire one missile at a time,
// only where no SAM covers, and never at a human. A human's ships fire only when told to (the ship card's button).
// Anti-ship (protocol 22): a click on water near a seen hostile warship or transport aims at it (units.ts
// cruiseShipTarget); the missile homes on it and a hit takes CRUISE.shipDamage hp (a transport sinks). The AI scores
// the fleets and carriers of the nations it fights next to the buildings (SHIP_VALUE; two missiles at a warship a hit
// would not sink). Sea-skimming: on its way only SAM sites within CRUISE.skimRadius tiles of the target can shoot it
// (units.ts interceptThreats; samCoverOnRoute with skim counts only those).
import { buildingsOf, chargesReady, isDisabled, samRadius } from './buildings';
import { CRUISE } from './config';
import { aiAttackLevel } from './aiattack';
import { areAllied } from './diplomacy';
import { forEachInRadius } from './grid';
import { knownTile } from './fog';
import { atPeace } from './rules';
import { earlyWarningMul } from './specials';
import { hasTech } from './tech';
import { applyAction } from './actions';
import { cruiseDistance, cruiseHull, cruiseReason, cruiseReloadLeft, cruiseShipReason, cruiseShipTarget, unitCost } from './units';
import { unitSeen } from './fog';
import { isWater } from './types';
import type { Building, BuildingType, GameState, Unit } from './types';

function unitTileOf(state: GameState, u: Unit): number {
  return Math.round(u.y) * state.map.width + Math.round(u.x);
}

/** What a cruise missile from one ship at a tile would do (pure read, for the client's aiming preview). */
export interface CruisePreview {
  ok: boolean;
  /** why not ('' = it can fly) */
  reason: string;
  radius: number;
  /** hostile land tiles and buildings in the blast; the main nation hit (0 = none) */
  enemyTiles: number;
  enemyBuildings: number;
  victim: number;
  /** ready shots of hostile SAM sites near the target that cover it (sea-skimming: the others on the way can't; each one downs a missile) */
  samShots: number;
  /** anti-ship: the ship it would home on (undefined = a land strike) */
  ship?: Unit;
}

function hostileTo(state: GameState, a: number, b: number): boolean {
  return a !== b && a > 0 && b > 0 && !areAllied(state, a, b) && !atPeace(state, a, b);
}

/**
 * Hostile working SAM sites (of nations hostile to pid) whose cover reaches the straight route from (x, y) to `tile`,
 * sampled every few tiles, and the shots they hold now. `known`: only SAMs pid has seen (fog of war: the AI).
 */
export function samCoverOnRoute(state: GameState, pid: number, x: number, y: number, tile: number, known: boolean, skim = false): { sams: Building[]; shots: number } {
  const w = state.map.width;
  const tx = tile % w;
  const ty = (tile / w) | 0;
  const len = Math.sqrt((tx - x) * (tx - x) + (ty - y) * (ty - y));
  const steps = Math.max(1, Math.ceil(len / 4));
  const sams: Building[] = [];
  let shots = 0;
  for (const b of state.buildings.values()) {
    if (b.type !== 'sam' || b.buildLeft > 0 || isDisabled(state, b) || !hostileTo(state, pid, b.owner)) continue;
    if (known && !knownTile(state, pid, b.tile)) continue;
    const r = samRadius(b) * earlyWarningMul(state, b.owner);
    const bx = b.tile % w;
    const by = (b.tile / w) | 0;
    // sea-skimming (cruise missiles): only SAM sites within CRUISE.skimRadius of the target can see it
    if (skim && (bx - tx) * (bx - tx) + (by - ty) * (by - ty) > CRUISE.skimRadius * CRUISE.skimRadius) continue;
    let near = false;
    for (let k = 0; k <= steps && !near; k++) {
      const px = x + ((tx - x) * k) / steps;
      const py = y + ((ty - y) * k) / steps;
      near = (px - bx) * (px - bx) + (py - by) * (py - by) <= r * r;
    }
    if (!near) continue;
    sams.push(b);
    shots += Math.floor(chargesReady(b));
  }
  return { sams, shots };
}

/** What a cruise missile from ship `shipId` of pid at `tile` would hit, and why it can't fly. Pure read. */
export function cruisePreview(state: GameState, pid: number, shipId: number, tile: number): CruisePreview {
  const u = state.units.find((q) => q.id === shipId);
  const out: CruisePreview = { ok: false, reason: cruiseReason(state, pid, u, tile), radius: CRUISE.radius, enemyTiles: 0, enemyBuildings: 0, victim: 0, samShots: 0 };
  if (!u || !Number.isInteger(tile) || tile < 0 || tile >= state.map.owner.length) return out;
  if (isWater(state.map.terrain[tile])) {
    // anti-ship
    const s = cruiseShipTarget(state, pid, tile);
    if (s) {
      out.ship = s;
      out.victim = s.owner;
      out.samShots = samCoverOnRoute(state, pid, u.x, u.y, unitTileOf(state, s), false, true).shots;
    }
    out.ok = out.reason === '';
    return out;
  }
  const per = new Map<number, number>();
  forEachInRadius(state.map, tile, CRUISE.radius, (i) => {
    const o = state.map.owner[i];
    if (hostileTo(state, pid, o) && state.players[o]?.alive) {
      out.enemyTiles++;
      per.set(o, (per.get(o) ?? 0) + 1);
    }
    const id = state.map.building[i];
    const b = id ? state.buildings.get(id - 1) : undefined;
    if (b && hostileTo(state, pid, b.owner)) out.enemyBuildings++;
  });
  let best = 0;
  for (const [o, n] of per) {
    if (n > best || (n === best && o < out.victim)) {
      best = n;
      out.victim = o;
    }
  }
  out.samShots = samCoverOnRoute(state, pid, u.x, u.y, tile, false, true).shots;
  if (!out.reason && out.enemyTiles === 0 && out.enemyBuildings === 0) out.reason = 'Nothing of the enemy to hit there';
  out.ok = out.reason === '';
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// AI
// ---------------------------------------------------------------------------------------------------------------

/** How much an AI wants a building gone by a cruise missile (0 = not a target). */
const VALUE: Partial<Record<BuildingType, number>> = { sam: 50, silo: 46, airfield: 42, factory: 26, fort: 24, port: 22, arsenal: 20, city: 16, barracks: 12, lab: 10, watchtower: 8, oilWell: 8, mine: 7, market: 7, hospital: 6, farm: 4 };
/** How much an AI wants an enemy ship hit by an anti-ship cruise missile (by variant; transports with troops 40). */
const SHIP_VALUE: Record<string, number> = { carrier: 58, battleship: 48, warship: 34, destroyer: 30, submarine: 26 };
/** SAMs, silos and airfields: what would shoot down or bomb a landing's cover. */
const LANDING_KINDS: ReadonlySet<BuildingType> = new Set<BuildingType>(['sam', 'silo', 'airfield']);

/** The nations pid fights now (an attack either way), alive, not allied, not at peace. */
function foesOf(state: GameState, pid: number): number[] {
  const out = new Set<number>();
  for (const a of state.attacks) {
    if (a.attacker === pid && a.target > 0) out.add(a.target);
    else if (a.target === pid && a.attacker > 0) out.add(a.attacker);
  }
  return [...out].filter((q) => state.players[q]?.alive && hostileTo(state, pid, q)).sort((a, b) => a - b);
}

/**
 * AI cruise missiles for nation pid (see the file comment). Returns how many it fired. Deterministic: ships and
 * buildings in id order, no randomness.
 */
export function aiCruise(state: GameState, pid: number): number {
  const p = state.players[pid];
  if (!p || pid === 0 || !p.alive || p.isHuman || !hasTech(p, 'navalMastery')) return 0;
  const ships = state.units.filter((u) => u.owner === pid && u.hp > 0 && cruiseHull(u) && cruiseReloadLeft(state, u) <= 0).sort((a, b) => a.id - b.id);
  if (!ships.length) return 0;
  const foes = foesOf(state, pid);
  if (!foes.length) return 0;
  const easy = aiAttackLevel(state) < 1;
  const c = unitCost(state, pid, 'cruiseMissile');
  const w = state.map.width;
  const reach2 = CRUISE.reach * CRUISE.reach;
  // own landings on the way: their landing tiles, by the nation they land on
  const landings: { tile: number; owner: number }[] = [];
  for (const u of state.units) if (u.type === 'transport' && u.owner === pid && u.hp > 0 && u.targetOwner > 0) landings.push({ tile: u.target, owner: u.targetOwner });
  // tiles already under an own cruise missile's blast (one missile salvo per target)
  const struck: number[] = [];
  const chased = new Set<number>(); // ships an own anti-ship missile already homes on
  for (const u of state.units) {
    if (u.type !== 'cruiseMissile' || u.owner !== pid || u.hp <= 0) continue;
    if (u.chase) chased.add(u.chase);
    else struck.push(u.target);
  }
  const r2 = CRUISE.radius * CRUISE.radius;
  const d2 = (a: number, b: number): number => {
    const dx = (a % w) - (b % w);
    const dy = ((a / w) | 0) - ((b / w) | 0);
    return dx * dx + dy * dy;
  };
  let fired = 0;
  const free = new Set<Unit>(ships);
  for (let round = 0; round < 3 && free.size; round++) {
    let best: { tile: number; score: number; shooters: Unit[]; n: number; ship?: number } | null = null;
    for (const q of foes) {
      if (easy && state.players[q].isHuman) continue;
      for (const [type, value] of Object.entries(VALUE) as [BuildingType, number][]) {
        for (const b of buildingsOf(state, q, type)) {
          if (b.buildLeft > 0 || state.map.owner[b.tile] !== q || !knownTile(state, pid, b.tile)) continue; // fog: known only
          if (struck.some((s) => d2(s, b.tile) <= r2)) continue;
          const bx = b.tile % w;
          const by = (b.tile / w) | 0;
          const inReach = [...free].filter((u) => (u.x - bx) * (u.x - bx) + (u.y - by) * (u.y - by) <= reach2);
          if (!inReach.length) continue;
          inReach.sort((a, b2) => cruiseDistance(state, a, b.tile) - cruiseDistance(state, b2, b.tile) || a.id - b2.id);
          const cover = samCoverOnRoute(state, pid, inReach[0].x, inReach[0].y, b.tile, true, true).shots;
          if (cover > CRUISE.aiMaxCover || (easy && cover > 0)) continue; // heavy SAM cover: not worth it
          const n = easy ? 1 : cover + 1;
          if (n > inReach.length) continue;
          if (p.gold < c.gold * (CRUISE.aiReserve + n - 1) || p.oil < c.oil * n) continue; // the reserve stays (a salvo short of money would be shot down)
          let score = value + (type === 'city' ? b.level * 2 : 0) - cover * 8;
          const nearLanding = landings.some((l) => l.owner === q && d2(l.tile, b.tile) <= CRUISE.aiLandingNear * CRUISE.aiLandingNear);
          if (nearLanding) score += LANDING_KINDS.has(type) ? 30 : 12;
          if (!best || score > best.score || (score === best.score && b.tile < best.tile)) best = { tile: b.tile, score, shooters: inReach, n };
        }
      }
    }
    // anti-ship: fleets and carriers of the nations it fights, seen, in reach, not under an own missile already
    for (const s of state.units) {
      if (s.hp <= 0 || (s.type !== 'warship' && s.type !== 'transport') || !foes.includes(s.owner)) continue;
      if (easy && state.players[s.owner].isHuman) continue;
      const v = s.type === 'transport' ? (s.troops.infantry + s.troops.armor + s.troops.artillery > 0 ? 40 : 0) : (SHIP_VALUE[s.variant ?? 'warship'] ?? 30);
      if (!v || chased.has(s.id) || !unitSeen(state, pid, s)) continue;
      const inReach = [...free].filter((u) => (u.x - s.x) * (u.x - s.x) + (u.y - s.y) * (u.y - s.y) <= reach2);
      if (!inReach.length) continue;
      if (p.gold < c.gold * CRUISE.aiReserve || p.oil < c.oil) continue;
      inReach.sort((a, b2) => (a.x - s.x) * (a.x - s.x) + (a.y - s.y) * (a.y - s.y) - ((b2.x - s.x) * (b2.x - s.x) + (b2.y - s.y) * (b2.y - s.y)) || a.id - b2.id);
      const t = unitTileOf(state, s);
      // two missiles at a warship that a hit would not sink, one at a transport or a damaged ship
      const n = easy ? 1 : s.type === 'transport' || s.hp <= CRUISE.shipDamage ? 1 : 2;
      if (n > inReach.length) continue;
      const score = v;
      if (!best || score > best.score || (score === best.score && t < best.tile)) best = { tile: t, score, shooters: inReach, n, ship: s.id };
    }
    if (!best) break;
    let sent = 0;
    for (const u of best.shooters) {
      if (sent >= best.n) break;
      if (cruiseShipReason(state, pid, u) || !applyAction(state, pid, { type: 'cruiseMissile', ship: u.id, tile: best.tile }).ok) {
        free.delete(u);
        continue;
      }
      free.delete(u);
      sent++;
    }
    if (!sent) break;
    fired += sent;
    if (best.ship !== undefined) chased.add(best.ship);
    else struck.push(best.tile);
    if (easy) break;
  }
  return fired;
}
