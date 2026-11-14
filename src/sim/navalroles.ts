// What each warship type does by itself (config NAVAL_ROLES). The hooks below are called by navy.interceptStep (which
// ships to chase, and where to sail to catch them), units.updateWarship (which ship in range to shoot) and
// naval2.warshipThink (submarines dive away and blockade from hiding; destroyers sweep for submarines and escort;
// ships cover own landings). They apply to a player's ships (gunnery and chases on any stance, the jobs on 'auto';
// nothing here changes a ship under a move order) and to AI nations' ships from Normal up (aiattack.ts; Easy keeps the
// old habits, gunnery aside).
//
//   submarine  hunts transports first, then trade ships of nations at war (anywhere in its sea, on 'auto' and 'hunt'),
//              and only soft warships (damaged, or alone); never a destroyer, nor prey a destroyer guards or that
//              sits in a minefield; shoots warships from standoff range (others only fire back within
//              ARSENAL.subTargetRange); dives away from destroyers and from guns that outmatch it; blockades from a
//              hidden spot inside its longer blockade range, outside minefields and away from the enemy's coast
//   destroyer  chases submarines its sonar finds first; on 'auto' at war: escorts own transports, sweeps own
//              blockaded ports, escorts trade ships when a foe at war has submarines
//   any ship   chases of transports and trade ships aim ahead on their route (intercept, not a tail chase); on
//              'auto' (AI also 'bombard') the nearest ship that can support goes to cover an own landing on a nation
//   carrier    no head-on chase of a whole warship (its guns are weak; its wings do the work)
//   hit by a submarine it cannot see: a destroyer heads for it (sonar), other ships run to an own warship nearby (with
//              company they are no soft prey), else sail away (unseenAttacker, friendTile)
// Deterministic: reads the state, no RNG, no transcendental Math.
import { ARSENAL, NAVAL_ROLES as R, NAVY_BLOCKADE_RANGE, NAVY_ESCORT_PICK, NAVY_STATION_DIST, NAVY_SUPPORT_RANGE, TICKS_PER_SECOND, UNITS, WARSHIP_RANGE } from './config';
import { buildingAt } from './buildings';
import { areAllied } from './diplomacy';
import { fogOn, visibleTile } from './fog';
import { sameWater, waterPath } from './grid';
import { atPeace } from './rules';
import { aiAttackLevel } from './aiattack';
import { blockadedPorts, warshipMaxHp, warshipStance } from './naval2';
import { minefieldAt, minefields, subRevealRange } from './specials';
import { hasTech } from './tech';
import { navalBlockadeMul, navalCanTarget, navalReachMul, navalSpeedMul, navalSupportMul } from './variants';
import { isTribe, isWater } from './types';
import type { GameState, Unit } from './types';

function hostile(state: GameState, a: number, b: number): boolean {
  return a !== b && a > 0 && b > 0 && !areAllied(state, a, b) && !atPeace(state, a, b);
}
function d2(ax: number, ay: number, bx: number, by: number): number {
  return (ax - bx) * (ax - bx) + (ay - by) * (ay - by);
}
function tileOf(state: GameState, u: Unit): number {
  if (u.path.length) return u.path[Math.min(u.pathPos, u.path.length - 1)];
  return Math.round(u.y) * state.map.width + Math.round(u.x);
}
function seen(state: GameState, me: number, s: Unit): boolean {
  return !fogOn(state) || visibleTile(state, me, Math.round(s.y) * state.map.width + Math.round(s.x));
}

/** Whose ships play their type's role: every player's, AI nations' from Normal up (Easy keeps the old habits). */
export function rolesOn(state: GameState, owner: number): boolean {
  const p = state.players[owner];
  return !!p && !isTribe(p) && (p.isHuman || aiAttackLevel(state) >= 1);
}

const isSub = (u: Unit): boolean => u.type === 'warship' && u.variant === 'submarine';
const isDestroyer = (u: Unit): boolean => u.type === 'warship' && u.variant === 'destroyer';

/** Warship s is soft prey: under NAVAL_ROLES.softHp of its hp, or no other warship of its side within loneRadius. */
export function softPrey(state: GameState, s: Unit, ships: readonly Unit[]): boolean {
  if (s.type !== 'warship') return true;
  if (s.hp < R.softHp * warshipMaxHp(s)) return true;
  const r2 = R.loneRadius * R.loneRadius;
  for (const e of ships) {
    if (e === s || e.type !== 'warship' || e.hp <= 0) continue;
    if (e.owner !== s.owner && !areAllied(state, e.owner, s.owner)) continue;
    if (d2(e.x, e.y, s.x, s.y) <= r2) return false;
  }
  return true;
}

/** A destroyer hostile to `me` (in view) within its sonar range + pad of (x, y). */
export function destroyerNear(state: GameState, me: number, x: number, y: number, ships: readonly Unit[], pad: number = R.destroyerPad): boolean {
  const r = ARSENAL.destroyerSonar + pad;
  const r2 = r * r;
  for (const e of ships) {
    if (!isDestroyer(e) || e.hp <= 0 || !hostile(state, me, e.owner)) continue;
    if (d2(e.x, e.y, x, y) <= r2 && seen(state, me, e)) return true;
  }
  return false;
}

/**
 * Chase rank of ship s for warship u (navy.interceptStep; lower first, -1 = leave it), from the plain rank `base`
 * (transports 0, warships 1, trade ships at war 2). Only for owners whose ships play their role (rolesOn).
 */
export function roleRank(state: GameState, u: Unit, s: Unit, base: number, ships: readonly Unit[]): number {
  if (base < 0 || !rolesOn(state, u.owner)) return base;
  if (isSub(u)) {
    let rank: number;
    if (s.type === 'transport') rank = 0;
    else if (s.type === 'tradeShip') rank = 1;
    else if (s.type === 'warship' && !isDestroyer(s) && softPrey(state, s, ships)) rank = 2;
    else return -1; // no head-on fights, never a destroyer
    if (destroyerNear(state, u.owner, s.x, s.y, ships)) return -1; // its prey is guarded by a destroyer
    const fields = minefields(state);
    if (fields.length && minefieldAt(state, fields, s.x, s.y, u.owner) > 0) return -1;
    return rank;
  }
  if (isDestroyer(u) && isSub(s)) return 0; // sonar contact: the submarine first
  if (u.variant === 'carrier' && s.type === 'warship' && !softPrey(state, s, ships)) return -1;
  return base;
}

/** A submarine on 'auto' / 'hunt' sees transports and trade ships of nations at war anywhere in its sea (no leash). */
export function preyAnywhere(state: GameState, u: Unit, s: Unit, wars: Set<number>): boolean {
  if (!isSub(u) || (s.type !== 'transport' && s.type !== 'tradeShip')) return false;
  const st = warshipStance(u);
  return (st === 'auto' || st === 'hunt') && wars.has(u.owner * 1024 + s.owner) && rolesOn(state, u.owner);
}

/**
 * Where warship u sails to catch ship t (navy.chaseTo): -1 = hold where it is (a submarine within standoff range of its
 * prey: it shoots from there, unseen, instead of sailing into the ships that would reveal it), else a tile: a transport
 * or trade ship is met ahead on its route (the first route tile u reaches, within gun range, no later than t does),
 * anything else where it is.
 */
export function chaseAim(state: GameState, u: Unit, t: Unit): number {
  const here = tileOf(state, t);
  if (!rolesOn(state, u.owner)) return here;
  if (isSub(u)) {
    const r = R.standoff * WARSHIP_RANGE;
    if (d2(u.x, u.y, t.x, t.y) <= r * r) return -1;
  }
  if (t.type === 'warship') return here;
  if (!t.path.length || t.pathPos >= t.path.length) return here;
  const w = state.map.width;
  const theirSpeed = t.type === 'transport' ? (t.cargo > 0 ? t.cargo : UNITS.transport.speed) : UNITS.tradeShip.speed;
  const ourSpeed = UNITS.warship.speed * navalSpeedMul(u);
  const reach = 0.8 * WARSHIP_RANGE;
  const last = Math.min(t.path.length - 1, t.pathPos + Math.ceil(R.leadMax * 2));
  for (let i = t.pathPos; i <= last; i += 2) {
    const p = t.path[i];
    const dist = Math.sqrt(d2(p % w, (p / w) | 0, u.x, u.y));
    if (Math.max(0, dist - reach) / ourSpeed <= (i - t.pathPos) / theirSpeed) return p;
  }
  return t.path[last];
}

/** Which ship in gun range u shoots first (units.updateWarship; lower first, then the nearest). */
export function gunRank(u: Unit, s: Unit): number {
  if (isSub(u)) return s.type === 'transport' ? 0 : s.type === 'tradeShip' ? 1 : isDestroyer(s) ? 3 : 2;
  if (isDestroyer(u)) return isSub(s) ? 0 : 1;
  return 0;
}

// ---------------------------------------------------------------------------------------------------------------
// Submarines: diving away, hidden blockade spots
// ---------------------------------------------------------------------------------------------------------------

/**
 * Submarine u is in danger (naval2.warshipThink, every scan): a hostile destroyer near its sonar range, or hostile
 * guns that can fire at it (it is seen up close) and outmatch it by hp, or any such gun while it is badly damaged.
 * Returns the centre of the threats, or null.
 */
export function subThreat(state: GameState, u: Unit, ships: readonly Unit[]): { x: number; y: number } | null {
  const me = u.owner;
  const sonar = ARSENAL.destroyerSonar + R.destroyerPad;
  const mine = u.hp / warshipMaxHp(u);
  let guns = 0;
  let dd = false;
  let sx = 0;
  let sy = 0;
  let n = 0;
  for (const e of ships) {
    if (e.type !== 'warship' || e.hp <= 0 || !hostile(state, me, e.owner)) continue;
    const d = d2(e.x, e.y, u.x, u.y);
    if (d > (sonar + WARSHIP_RANGE) * (sonar + WARSHIP_RANGE) || !seen(state, me, e)) continue;
    let threat = false;
    if (isDestroyer(e) && d <= sonar * sonar) {
      dd = true;
      threat = true;
    } else if (d <= WARSHIP_RANGE * WARSHIP_RANGE && navalCanTarget(state, e, u)) {
      guns += (e.hp / warshipMaxHp(e)) * ARSENAL.subHitByOthers;
      threat = true;
    }
    if (threat) {
      sx += e.x;
      sy += e.y;
      n++;
    }
  }
  if (!n || (!dd && guns <= mine && (guns <= 0 || mine >= R.softHp))) return null;
  return { x: sx / n, y: sy / n };
}

/** 45-degree steps of a unit vector (no trigonometry: rotations by +-45 / 90 / 135 degrees). */
const C45 = 0.7071067811865476;
const TURNS: readonly [number, number][] = [[1, 0], [C45, C45], [C45, -C45], [0, 1], [0, -1], [-C45, C45], [-C45, -C45]];

/**
 * Sends warship u (a submarine diving away, a ship hit by a submarine it cannot see) away from (cx, cy): to water
 * about NAVAL_ROLES.evadeDist away in its sea (straight away first,
 * then turning), outside hostile minefields; a move (state 1) after which it patrols there. It keeps off stations for
 * evadeSeconds (Unit.retryTick). False when no water could be reached.
 */
export function evade(state: GameState, u: Unit, cx: number, cy: number): boolean {
  const map = state.map;
  const w = map.width;
  let vx = u.x - cx;
  let vy = u.y - cy;
  const len = Math.sqrt(vx * vx + vy * vy);
  if (len < 1e-6) {
    vx = 0;
    vy = 1;
  } else {
    vx /= len;
    vy /= len;
  }
  const from = tileOf(state, u);
  const fields = minefields(state);
  for (const dist of [R.evadeDist, R.evadeDist / 2]) {
    for (const [c, s] of TURNS) {
      const dx = vx * c - vy * s;
      const dy = vx * s + vy * c;
      const x = Math.round(u.x + dx * dist);
      const y = Math.round(u.y + dy * dist);
      if (x < 0 || y < 0 || x >= w || y >= map.height) continue;
      const t = y * w + x;
      if (!isWater(map.terrain[t]) || !sameWater(map, from, t)) continue;
      if (fields.length && minefieldAt(state, fields, x, y, u.owner) > 0) continue;
      const path = waterPath(map, from, t, 3 * R.evadeDist, 3000);
      if (!path || !path.length) continue;
      u.path = path;
      u.pathPos = 0;
      u.target = path[path.length - 1];
      u.state = 1;
      u.station = undefined;
      u.chase = 0;
      u.chaseLost = 0;
      u.retryTick = state.tick + R.evadeSeconds * TICKS_PER_SECOND;
      return true;
    }
  }
  return false;
}

/**
 * Submarine u may dive away now: an AI one (Normal up) on any stance, also while sailing; a player's only on 'auto' and
 * not under a move order (sailing on its own: only while it is diving away already).
 */
export function evades(state: GameState, u: Unit): boolean {
  if (!isSub(u) || u.state === 4 || !rolesOn(state, u.owner)) return false;
  if (!state.players[u.owner].isHuman) return true;
  return warshipStance(u) === 'auto' && (u.state !== 1 || (u.retryTick ?? 0) > state.tick);
}

/**
 * A hidden submarine shooting at warship u: a damaged u with a hostile submarine within gun range that u cannot target
 * (the nearest). Ships of owners whose ships play their role react (naval2.warshipThink): a destroyer heads for it (its
 * sonar then finds it), others sail away. AI ships on any stance, a player's on 'auto'; never under a move order or
 * on escort duty. Null = none.
 */
export function unseenAttacker(state: GameState, u: Unit, ships: readonly Unit[]): Unit | null {
  if (u.type !== 'warship' || isSub(u) || u.state === 1 || u.state === 4 || !rolesOn(state, u.owner)) return null;
  if (state.players[u.owner].isHuman && warshipStance(u) !== 'auto') return null;
  if (u.hp >= warshipMaxHp(u) - 1e-9) return null;
  const r2 = WARSHIP_RANGE * WARSHIP_RANGE;
  let best: Unit | null = null;
  let bestD = Infinity;
  for (const s of ships) {
    if (!isSub(s) || s.hp <= 0 || !hostile(state, u.owner, s.owner)) continue;
    const d = d2(s.x, s.y, u.x, u.y);
    if (d > r2 || d >= bestD || navalCanTarget(state, u, s)) continue;
    best = s;
    bestD = d;
  }
  return best;
}

/**
 * Where a ship hit by an unseen submarine runs to: the nearest other own warship within 2 x NAVAL_ROLES.loneRadius (a
 * ship with company is no soft prey: a raider leaves it), as a tile; -1 = none (it just sails away).
 */
export function friendTile(state: GameState, u: Unit, ships: readonly Unit[]): number {
  const r = 2 * R.loneRadius;
  let best: Unit | null = null;
  let bestD = r * r;
  for (const e of ships) {
    if (e === u || e.type !== 'warship' || e.owner !== u.owner || e.hp <= 0) continue;
    const d = d2(e.x, e.y, u.x, u.y);
    if (d > bestD || (d === bestD && best !== null && e.id > best.id)) continue;
    best = e;
    bestD = d;
  }
  return best ? Math.round(best.y) * state.map.width + Math.round(best.x) : -1;
}

/** A submarine blockading `port` takes a hidden spot (subStationWater) instead of parking next to it. */
export function subBlockades(state: GameState, u: Unit, port: number): boolean {
  if (!isSub(u) || !rolesOn(state, u.owner)) return false;
  const b = buildingAt(state, port);
  return !!b && b.type === 'port';
}

/**
 * Water for submarine u blockading the port on `port`: within its blockade range (less NAVAL_ROLES.blockadeInset),
 * at least NAVY_STATION_DIST out, in its sea, outside hostile minefields; farther than the port owner's reveal range
 * from that owner's land if it can (hidden), else as far from it as it gets; then near the sub. -1 = none.
 */
export function subStationWater(state: GameState, u: Unit, port: number): number {
  const map = state.map;
  const { width: w, height: h, owner } = map;
  const b = buildingAt(state, port);
  const foe = b ? b.owner : owner[port];
  const px = port % w;
  const py = (port / w) | 0;
  const rOut = NAVY_BLOCKADE_RANGE * navalBlockadeMul(u) - R.blockadeInset;
  const rIn = Math.max(NAVY_STATION_DIST, rOut - 4);
  const reveal = subRevealRange(state, foe);
  const rv = Math.ceil(reveal);
  const fields = minefields(state);
  const from = tileOf(state, u);
  let best = -1;
  let bestScore = Infinity;
  const r = Math.ceil(rOut);
  for (let dy = -r; dy <= r; dy++) {
    const y = py + dy;
    if (y < 0 || y >= h) continue;
    for (let dx = -r; dx <= r; dx++) {
      const x = px + dx;
      if (x < 0 || x >= w || ((x + y) & 1) !== 0) continue;
      const dd = dx * dx + dy * dy;
      if (dd > rOut * rOut || dd < rIn * rIn) continue;
      const t = y * w + x;
      if (!isWater(map.terrain[t]) || !sameWater(map, from, t)) continue;
      if (fields.length && minefieldAt(state, fields, x, y, u.owner) > 0) continue;
      // Nearest land of the port's owner within its reveal range (every second tile, like techtree.unitVisibleTo).
      let near = Infinity;
      for (let yy = Math.max(0, y - rv); yy <= Math.min(h - 1, y + rv); yy += 2) {
        for (let xx = Math.max(0, x - rv); xx <= Math.min(w - 1, x + rv); xx += 2) {
          if (owner[yy * w + xx] !== foe) continue;
          const q = d2(xx, yy, x, y);
          if (q < near) near = q;
        }
      }
      const hidden = near > reveal * reveal;
      const score = (hidden ? 0 : 1000 - Math.sqrt(near) * 10) + Math.sqrt(d2(x, y, u.x, u.y)) / 10;
      if (score < bestScore || (score === bestScore && t < best)) {
        best = t;
        bestScore = score;
      }
    }
  }
  return best;
}

/** A submarine keeps off a port with a hostile destroyer (in view) within its sonar range of the blockade spots. */
export function portGuarded(state: GameState, u: Unit, port: number, ships: readonly Unit[]): boolean {
  if (!isSub(u) || !rolesOn(state, u.owner)) return false;
  const w = state.map.width;
  return destroyerNear(state, u.owner, port % w, (port / w) | 0, ships, NAVY_BLOCKADE_RANGE * navalBlockadeMul(u));
}

// ---------------------------------------------------------------------------------------------------------------
// Destroyers and landings ('auto')
// ---------------------------------------------------------------------------------------------------------------

/** Warships escorting ship s (state 4 on it). */
function escortCount(state: GameState, s: Unit): number {
  let n = 0;
  for (const e of state.units) if (e.type === 'warship' && e.hp > 0 && e.state === 4 && e.station === s.id) n++;
  return n;
}

/** Warship u on 'auto' may escort (naval2 keeps its escort duty): destroyers of owners whose ships play their role. */
export function autoEscorts(state: GameState, u: Unit): boolean {
  return isDestroyer(u) && warshipStance(u) === 'auto' && rolesOn(state, u.owner);
}

/** A nation at war with `me` that has Submarines (its trade raiders are about). */
function subFoe(state: GameState, me: number, wars: Set<number>): boolean {
  for (const p of state.players) {
    if (p.id <= 0 || p.id === me || !p.alive || !wars.has(me * 1024 + p.id)) continue;
    if (hasTech(p, 'submarines')) return true;
  }
  return false;
}

/**
 * An 'auto' destroyer's job at war (naval2.warshipThink; true = it has one): escort an own transport at sea with no
 * escort (within NAVY_ESCORT_PICK); else sweep an own blockaded Port of its sea (sail there; its sonar finds the
 * raider and the chase follows); else, when a foe at war has Submarines, escort an own trade ship with no escort
 * (at most NAVAL_ROLES.tradeEscortShare of the owner's auto destroyers on trade). `escort` starts an escort (state 4),
 * `sailTo` a trip to water near a tile (state 1).
 */
export function destroyerJob(
  state: GameState,
  u: Unit,
  wars: Set<number>,
  escort: (s: Unit) => void,
  sailTo: (tile: number) => boolean,
): boolean {
  if (!autoEscorts(state, u) || !wars.size) return false;
  const me = u.owner;
  const from = tileOf(state, u);
  const pick2 = NAVY_ESCORT_PICK * NAVY_ESCORT_PICK;
  let best: Unit | null = null;
  let bestD = pick2;
  for (const s of state.units) {
    if (s.type !== 'transport' || s.owner !== me || s.hp <= 0) continue;
    const d = d2(s.x, s.y, u.x, u.y);
    if (d >= bestD || escortCount(state, s) > 0 || !sameWater(state.map, from, tileOf(state, s))) continue;
    best = s;
    bestD = d;
  }
  if (best) {
    escort(best);
    return true;
  }
  const w = state.map.width;
  let port = -1;
  let portD = Infinity;
  for (const t of blockadedPorts(state, me)) {
    if (!sameWater(state.map, from, t)) continue;
    const d = d2(t % w, (t / w) | 0, u.x, u.y);
    if (d < portD || (d === portD && t < port)) {
      port = t;
      portD = d;
    }
  }
  if (port >= 0) {
    if (portD <= 12 * 12) return u.state !== 3; // on patrol by it (a station elsewhere is dropped)
    return sailTo(port);
  }
  if (!subFoe(state, me, wars)) return false;
  let autos = 0;
  let onTrade = 0;
  for (const e of state.units) {
    if (e.type !== 'warship' || e.owner !== me || e.hp <= 0 || !autoEscorts(state, e)) continue;
    autos++;
    if (e.state === 4 && e !== u) {
      const s = state.units.find((q) => q.id === e.station);
      if (s && s.type === 'tradeShip') onTrade++;
    }
  }
  if (onTrade + 1 > R.tradeEscortShare * autos) return false;
  best = null;
  bestD = pick2 / 4;
  for (const s of state.units) {
    if (s.type !== 'tradeShip' || s.owner !== me || s.hp <= 0) continue;
    const d = d2(s.x, s.y, u.x, u.y);
    if (d >= bestD || escortCount(state, s) > 0 || !sameWater(state.map, from, tileOf(state, s))) continue;
    best = s;
    bestD = d;
  }
  if (!best) return false;
  escort(best);
  return true;
}

/** Support reach of one ship (tiles): its variant x Naval Mastery. */
function reachOf(state: GameState, u: Unit): number {
  return NAVY_SUPPORT_RANGE * navalSupportMul(u) * navalReachMul(state, u.owner);
}

/** Warship u may go and cover an own landing: it supports, it is free (patrolling or on station), on 'auto' (AI: also 'bombard'). */
function covers(state: GameState, u: Unit): boolean {
  if (u.type !== 'warship' || u.hp <= 0 || navalSupportMul(u) <= 0 || (u.state !== 0 && u.state !== 3)) return false;
  if (u.hp < R.softHp * warshipMaxHp(u) || !rolesOn(state, u.owner)) return false;
  const st = warshipStance(u);
  return st === 'auto' || (st === 'bombard' && !state.players[u.owner].isHuman);
}

/**
 * Landings: an own transport at sea bound for a nation's coast (not a tribe's) with no own supporting warship near its
 * landing tile (in range, or sailing there) gets one: the nearest free ship that covers (covers) within
 * NAVAL_ROLES.landingReach sails to the water off the landing tile (sailTo). True when u was sent.
 */
export function coverLanding(state: GameState, u: Unit, sailTo: (tile: number) => boolean): boolean {
  if (!covers(state, u)) return false;
  const me = u.owner;
  const w = state.map.width;
  const from = tileOf(state, u);
  const lr2 = R.landingReach * R.landingReach;
  for (const t of state.units) {
    if (t.type !== 'transport' || t.owner !== me || t.hp <= 0 || t.targetOwner <= 0) continue;
    const tp = state.players[t.targetOwner];
    if (!tp?.alive || isTribe(tp) || !hostile(state, me, t.targetOwner)) continue;
    const lx = t.target % w;
    const ly = (t.target / w) | 0;
    if (d2(lx, ly, u.x, u.y) > lr2 || !sameWater(state.map, from, t.target)) continue;
    let covered = false;
    let nearest: Unit | null = null;
    let nearD = Infinity;
    for (const e of state.units) {
      if (e.type !== 'warship' || e.owner !== me || e.hp <= 0 || navalSupportMul(e) <= 0) continue;
      const r = reachOf(state, e);
      const end = e.path.length ? e.path[e.path.length - 1] : -1;
      if (d2(e.x, e.y, lx, ly) <= r * r || (end >= 0 && d2(end % w, (end / w) | 0, lx, ly) <= r * r)) {
        covered = true;
        break;
      }
      if (!covers(state, e)) continue;
      const d = d2(e.x, e.y, lx, ly);
      if (d < nearD || (d === nearD && nearest !== null && e.id < nearest.id)) {
        nearD = d;
        nearest = e;
      }
    }
    if (covered || nearest !== u) continue;
    if (sailTo(t.target)) return true;
  }
  return false;
}
