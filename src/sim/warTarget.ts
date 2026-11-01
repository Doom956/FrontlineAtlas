// Follow my war: a player's units and air wings aim at the player's current war target by themselves, so a new
// attack doesn't need every wing, fleet and division to be re-aimed by hand.
//
// War target of a human player (updateFollow): the nation it attacks with the most troops right now (nations before
// tribes: tribe attacks count x FOLLOW_TRIBE_WEIGHT; ties: lower id; the current one stays unless another is attacked
// with FOLLOW_SWITCH times its troops); units re-aim at it every few seconds. With no attack
// running, the nation it attacked last, for FOLLOW_MEMORY_SECONDS after that attack ended. Its main front = that
// nation's border tile nearest the focus of the biggest attack on it (or of the last one). Both are kept in hashed
// state (state.follow), so every client aims at the same tiles at the same ticks.
//
// Who follows (the default for a player's new units and missions; a manual target makes them Fixed until the player
// picks Follow again; AI-owned units keep their own logic):
//  - air wings (airwings.ts, AirWing.follow): strategic raids that nation's cities / factories in reach, support bombs
//    the main front, superiority patrols over it (else over the airfield);
//  - warships (naval2.ts, Unit.fixed absent): bombard / blockade / auto shell that nation's coast and ports first;
//  - tank divisions in support mode (armor2.ts, Unit.fixed absent): their front is the main front, moved as it moves;
//  - auto recon (Action setAutoRecon, off by default since each flight costs gold and oil): ready airfields scout the
//    war target while no reveal of ours covers it.
// Deterministic: no RNG; fixed orders (player id, building id).

import { buildingAt, buildingsOf } from './buildings';
import { frontTiles } from './combat';
import { TICKS_PER_SECOND } from './config';
import { areAllied } from './diplomacy';
import { atPeace } from './rules';
import { hasTech } from './tech';
import { canReconFlight, reconFlight, reconRange } from './variants';
import { wingOf } from './airwings';
import { isTribe } from './types';
import type { ActionResult, Building, FollowState, GameState, Unit } from './types';

/** How often war targets (and auto recon) are re-evaluated. */
export const FOLLOW_EVERY_SECONDS = 2;
/** A nation stays the war target this long after the last attack on it ended. */
export const FOLLOW_MEMORY_SECONDS = 60;
/** Attacks on tribes count this much when picking the war target (nations first). */
export const FOLLOW_TRIBE_WEIGHT = 0.3;
/** Another nation becomes the war target while the current one is attacked too only with this many times the troops. */
export const FOLLOW_SWITCH = 1.25;
/** Auto recon flies this many tiles past the main front, toward the target's capital (when that is still its land). */
const RECON_DEPTH = 12;

const EVERY_TICKS = FOLLOW_EVERY_SECONDS * TICKS_PER_SECOND;
const MEMORY_TICKS = FOLLOW_MEMORY_SECONDS * TICKS_PER_SECOND;
/** numbers per player in FollowState.targets */
const REC = 5;

const FAIL = (reason: string): ActionResult => ({ ok: false, reason });

function hostile(state: GameState, a: number, b: number): boolean {
  return a !== b && a > 0 && b > 0 && !areAllied(state, a, b) && !atPeace(state, a, b);
}
function d2(w: number, a: number, b: number): number {
  const dx = (a % w) - (b % w);
  const dy = ((a / w) | 0) - ((b / w) | 0);
  return dx * dx + dy * dy;
}

function followState(state: GameState): FollowState {
  if (!state.follow) state.follow = { targets: [], recon: [] };
  return state.follow;
}

/** Index of pid's record in state.follow.targets, or -1. */
function recIndex(state: GameState, pid: number): number {
  const t = state.follow?.targets;
  if (!t) return -1;
  for (let k = 0; k < t.length; k += REC) if (t[k] === pid) return k;
  return -1;
}

/** True when `nation` can be pid's war target now (alive, hostile). */
function validTarget(state: GameState, pid: number, nation: number): boolean {
  return nation > 0 && !!state.players[nation]?.alive && hostile(state, pid, nation);
}

/** The attack pid fights `nation` with the most troops (ties: lower id), or null. */
function biggestAttack(state: GameState, pid: number, nation: number): { focus: number; troops: number } | null {
  let best: { focus: number; troops: number; id: number } | null = null;
  for (const a of state.attacks) {
    if (a.attacker !== pid || a.target !== nation) continue;
    const tr = a.troops.infantry + a.troops.armor + a.troops.artillery;
    if (tr <= 0) continue;
    if (!best || tr > best.troops || (tr === best.troops && a.id < best.id)) best = { focus: a.focusTile, troops: tr, id: a.id };
  }
  return best;
}

/** Troops pid attacks each valid nation with right now (summed; tribes x FOLLOW_TRIBE_WEIGHT). */
function attackScores(state: GameState, pid: number): Map<number, number> {
  const sums = new Map<number, number>();
  for (const a of state.attacks) {
    if (a.attacker !== pid || a.target <= 0) continue;
    const tr = a.troops.infantry + a.troops.armor + a.troops.artillery;
    if (tr <= 0 || !validTarget(state, pid, a.target)) continue;
    sums.set(a.target, (sums.get(a.target) ?? 0) + tr * (isTribe(state.players[a.target]) ? FOLLOW_TRIBE_WEIGHT : 1));
  }
  return sums;
}

/**
 * The nation pid attacks with the most troops right now (ties: lower id), or 0. `current` (the war target so far)
 * keeps the place unless another nation is attacked with FOLLOW_SWITCH times its troops (no flapping between fronts).
 */
function attackedNow(state: GameState, pid: number, current = 0): number {
  const sums = attackScores(state, pid);
  let best = 0;
  let bestScore = 0;
  for (const [n, score] of sums) {
    if (score > bestScore || (score === bestScore && n < best)) {
      best = n;
      bestScore = score;
    }
  }
  const cur = current > 0 ? sums.get(current) : undefined;
  if (cur !== undefined && cur * FOLLOW_SWITCH >= bestScore) return current;
  return best;
}

/** `nation`'s border tile with pid nearest `anchor` (ties: lower tile); -1 = no shared border. */
function frontNear(state: GameState, pid: number, nation: number, anchor: number): number {
  const w = state.map.width;
  const n = state.map.owner.length;
  let best = -1;
  let bestD = Infinity;
  for (const t of frontTiles(state, pid, nation)) {
    const d = anchor >= 0 && anchor < n ? d2(w, t, anchor) : 0;
    if (d < bestD || (d === bestD && t < best)) {
      bestD = d;
      best = t;
    }
  }
  return best;
}

/**
 * Keeps every human player's war target (sim.ts, after the war memory). Every tick with attacks running: a player
 * attacking takes the nation it attacks hardest as its target at once (attacks are short, a check every few seconds
 * would miss them); every FOLLOW_EVERY_SECONDS: main fronts are worked out again, expired targets dropped and due
 * auto-recon flights flown. Cheap: one pass over the attacks per human player per tick.
 */
export function updateFollow(state: GameState): void {
  const due = state.tick % EVERY_TICKS === 0;
  if (!due && !state.attacks.length) return;
  const old = state.follow?.targets ?? [];
  const out: number[] = [];
  for (const p of state.players) {
    if (!p || p.id <= 0 || !p.isHuman || !p.alive) continue;
    const k = recIndex(state, p.id);
    const had = k >= 0 ? old[k + 1] : 0;
    const now = attackedNow(state, p.id, had);
    if (now > 0) {
      const focus = biggestAttack(state, p.id, now)?.focus ?? p.capital;
      // The front tile: worked out on the check ticks (mainFront works it out meanwhile for a new target).
      const front = due ? frontNear(state, p.id, now, focus) : now === had ? old[k + 4] : -1;
      out.push(p.id, now, focus, state.tick, front);
      continue;
    }
    if (k < 0) continue;
    if (!due) {
      out.push(old[k], old[k + 1], old[k + 2], old[k + 3], old[k + 4]);
      continue;
    }
    const nation = old[k + 1];
    if (state.tick - old[k + 3] > MEMORY_TICKS || !validTarget(state, p.id, nation)) continue;
    out.push(p.id, nation, old[k + 2], old[k + 3], frontNear(state, p.id, nation, old[k + 2]));
  }
  if (out.length || state.follow) followState(state).targets = out;
  if (due) autoRecon(state);
}

/**
 * pid's war target: the nation it attacks with the most troops, else the one it attacked within the last
 * FOLLOW_MEMORY_SECONDS; 0 = none (also for AI players: their units keep their own logic).
 */
export function followedNation(state: GameState, pid: number): number {
  const k = recIndex(state, pid);
  if (k < 0) return 0;
  const t = state.follow!.targets;
  const nation = t[k + 1];
  if (state.tick - t[k + 3] > MEMORY_TICKS + EVERY_TICKS || !validTarget(state, pid, nation)) return 0;
  return nation;
}

/**
 * pid's main front against `target`: target's border tile nearest the focus of pid's biggest attack on it (the
 * last one when none runs); -1 = no shared border. For the war target this is the tile kept in state.follow while it
 * is still target's land; otherwise it is worked out now.
 */
export function mainFront(state: GameState, pid: number, target: number): number {
  if (target <= 0 || target === pid) return -1;
  const k = recIndex(state, pid);
  const t = state.follow?.targets;
  if (k >= 0 && t && t[k + 1] === target) {
    const f = t[k + 4];
    if (f >= 0 && state.map.owner[f] === target) return f;
    return frontNear(state, pid, target, t[k + 2]);
  }
  const big = biggestAttack(state, pid, target);
  return frontNear(state, pid, target, big ? big.focus : (state.players[pid]?.capital ?? -1));
}

/** True when unit u (warship, tank division) follows its owner's war target: a player's unit not pinned. */
export function unitFollows(state: GameState, u: Unit): boolean {
  return !u.fixed && !!state.players[u.owner]?.isHuman;
}

/** The nation warship u aims at: the pinned one (Fixed) or its owner's war target (Follow); 0 = any war. */
export function shipWarTarget(state: GameState, u: Unit): number {
  if (u.fixed && u.fixed > 0) return u.fixed;
  return unitFollows(state, u) ? followedNation(state, u.owner) : 0;
}

// ---------------------------------------------------------------------------------------------------------------
// Auto recon
// ---------------------------------------------------------------------------------------------------------------

/** True when airfield b scouts its owner's war target by itself (Action setAutoRecon). */
export function autoReconOn(state: GameState, b: Building): boolean {
  return !!state.follow?.recon.includes(b.id);
}

/** Action setAutoRecon: auto recon on / off for an own finished airfield (or -1: every one). Needs Recon Planes. */
export function setAutoRecon(state: GameState, pid: number, airfield: number, on: boolean): ActionResult {
  const p = state.players[pid];
  if (!p || !p.alive) return FAIL('No such player');
  if (typeof on !== 'boolean') return FAIL('Invalid value');
  if (!hasTech(p, 'reconPlanes')) return FAIL('Needs research: Recon Planes');
  let sites: Building[];
  if (airfield === -1) {
    sites = buildingsOf(state, pid, 'airfield').filter((b) => b.buildLeft <= 0);
    if (!sites.length) return FAIL('You have no finished airfield');
  } else {
    const b = buildingAt(state, airfield);
    if (!b || b.type !== 'airfield' || b.owner !== pid || b.buildLeft > 0) return FAIL('Recon planes fly from a finished Airfield of yours');
    sites = [b];
  }
  const f = followState(state);
  const ids = new Set(f.recon);
  for (const b of sites) {
    if (on) ids.add(b.id);
    else ids.delete(b.id);
  }
  f.recon = [...ids].sort((a, b) => a - b);
  return { ok: true };
}

/** True while `owner` has a reveal over `nation`'s land, or a recon plane on its way there. */
function scouted(state: GameState, owner: number, nation: number): boolean {
  const owners = state.map.owner;
  for (const z of state.arsenal?.reveals ?? []) if (z.owner === owner && z.untilTick > state.tick && owners[z.tile] === nation) return true;
  for (const u of state.units) if (u.type === 'reconPlane' && u.hp > 0 && u.owner === owner && u.state === 0 && u.targetOwner === nation) return true;
  return false;
}

/** Where auto recon from airfield b flies over `nation`: past the main front toward its capital, else the front. */
function reconAim(state: GameState, owner: number, nation: number, b: Building): number {
  const front = mainFront(state, owner, nation);
  if (front < 0) return -1;
  const map = state.map;
  const w = map.width;
  const cap = state.players[nation]?.capital ?? -1;
  const r = reconRange(b);
  if (cap >= 0 && cap < map.owner.length) {
    const dx = (cap % w) - (front % w);
    const dy = ((cap / w) | 0) - ((front / w) | 0);
    const len = Math.sqrt(dx * dx + dy * dy);
    const step = len > RECON_DEPTH ? RECON_DEPTH / len : 1;
    const t = Math.round(((front / w) | 0) + dy * step) * w + Math.round((front % w) + dx * step);
    if (t >= 0 && t < map.owner.length && map.owner[t] === nation && d2(w, b.tile, t) <= r * r) return t;
  }
  return front;
}

function autoRecon(state: GameState): void {
  const f = state.follow;
  if (!f || !f.recon.length) return;
  f.recon = f.recon.filter((id) => {
    const b = state.buildings.get(id);
    return !!b && b.type === 'airfield' && !!state.players[b.owner]?.alive;
  });
  for (const id of f.recon) {
    const b = state.buildings.get(id)!;
    if (b.buildLeft > 0) continue;
    const nation = followedNation(state, b.owner);
    if (nation <= 0 || scouted(state, b.owner, nation)) continue;
    const aim = reconAim(state, b.owner, nation, b);
    if (aim < 0 || !canReconFlight(state, b.owner, b.tile, aim).ok) continue;
    reconFlight(state, b.owner, b.tile, aim);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------------------------------------------

/** What a unit or airfield aims at (client): follow = Follow my war, else Fixed; nation 0 / tile -1 = nothing now. */
export interface FollowInfo {
  follow: boolean;
  nation: number;
  tile: number;
}

/**
 * Follow / Fixed state and current aim of an airfield's wing (missions support / strategic / superiority), a warship
 * or a tank division in support mode (client panels). null = it has nothing to follow (idle wing, AI unit, other mode).
 */
export function followTargetOf(state: GameState, x: Unit | Building): FollowInfo | null {
  if ('buildLeft' in x) {
    if (x.type !== 'airfield') return null;
    const wing = wingOf(state, x);
    if (!wing || wing.mission === 'idle') return null;
    if (wing.follow) {
      const nation = followedNation(state, wing.owner);
      return { follow: true, nation, tile: wing.target >= 0 ? wing.target : nation > 0 ? mainFront(state, wing.owner, nation) : -1 };
    }
    return { follow: false, nation: wing.targetOwner, tile: wing.target };
  }
  if (x.type === 'warship') {
    if (x.fixed && x.fixed > 0) return { follow: false, nation: x.fixed, tile: x.state === 3 ? (x.station ?? -1) : -1 };
    if (!unitFollows(state, x)) return null;
    const nation = followedNation(state, x.owner);
    return { follow: true, nation, tile: x.state === 3 ? (x.station ?? -1) : nation > 0 ? mainFront(state, x.owner, nation) : -1 };
  }
  if (x.type === 'tankDivision') {
    if (x.mode !== 'support') return null;
    const tile = x.station ?? -1;
    if (x.fixed) return { follow: false, nation: tile >= 0 ? acrossFront(state, tile, x.owner) : 0, tile };
    if (!unitFollows(state, x)) return null;
    return { follow: true, nation: followedNation(state, x.owner), tile };
  }
  return null;
}

/** The nation a front tile faces: its owner, or for a tile on pid's side the nearest other nation within 4 tiles (0 = none). */
function acrossFront(state: GameState, tile: number, pid: number): number {
  const m = state.map;
  const own = m.owner[tile];
  if (own !== pid) return own;
  const w = m.width;
  const h = m.height;
  const x0 = tile % w;
  const y0 = (tile - x0) / w;
  for (let r = 1; r <= 4; r++) {
    let best = 0;
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const x = x0 + dx;
        const y = y0 + dy;
        if (x < 0 || y < 0 || x >= w || y >= h) continue;
        const o = m.owner[y * w + x];
        if (o !== 0 && o !== pid && (best === 0 || o < best)) best = o;
      }
    }
    if (best) return best;
  }
  return 0;
}

/** pid's war target for the HUD: nation (0 = none), main front tile, attacking now or remembered (seconds left). */
export function warTargetOf(state: GameState, pid: number): { nation: number; tile: number; attacking: boolean; secondsLeft: number } {
  const nation = followedNation(state, pid);
  if (nation <= 0) return { nation: 0, tile: -1, attacking: false, secondsLeft: 0 };
  const last = state.follow!.targets[recIndex(state, pid) + 3];
  const attacking = attackScores(state, pid).has(nation);
  return { nation, tile: mainFront(state, pid, nation), attacking, secondsLeft: attacking ? FOLLOW_MEMORY_SECONDS : Math.max(0, (last + MEMORY_TICKS - state.tick) / TICKS_PER_SECOND) };
}

/** Mixes the follow state into the state hash (hash.ts). */
export function hashFollow(state: GameState, h: number, mixInt: (h: number, v: number) => number): number {
  const f = state.follow;
  if (!f) return h;
  h = mixInt(h, f.targets.length | 0x10000);
  for (const v of f.targets) h = mixInt(h, v);
  h = mixInt(h, f.recon.length);
  for (const v of f.recon) h = mixInt(h, v);
  return h;
}
