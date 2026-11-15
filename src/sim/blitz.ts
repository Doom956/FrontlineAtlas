// Blitz: a tank division's special order with Armor Mastery (Action 'blitz', config BLITZ; the player reads
// BLITZ_NAME). The division pops a smoke screen and surges into a spearhead at BLITZ.speedMul x the head speed and
// BLITZ.depthMul x the depth, a band BLITZ.width tiles wide, with losses x BLITZ.lossMul; every tile it takes holds
// for BLITZ.holdSeconds (state.blitzHolds): no attack, landing or other spearhead takes it back meanwhile, so the
// wedge is hard to cut off. It costs BLITZ.oil, needs BLITZ.minShare of a full division and recharges for
// BLITZ.cooldownSeconds (Unit.blitzReady). The spearhead itself is tanks.ts's, with Unit.blitz = 1.
//
// AI (armor2.ts): from Normal up a ready division blitzes a line that cuts the enemy's land, or breaks a stalemate
// (no normal strike worth it near its front) when the blitz gets deep; never into a player's land at Easy or Normal.
// A player's divisions never blitz by themselves.
// Deterministic: no RNG; the held-tile lookup is derived from state.blitzHolds (rebuilt when it changes).
import { BLITZ, BLITZ_NAME, TANK_DIVISION_TROOPS, TICKS_PER_SECOND } from './config';
import { addEvent } from './state';
import { hasTech } from './tech';
import { moveTankDivisions, spearheadPreview } from './tanks';
import type { SpearheadPreview } from './tanks';
import { isTribe } from './types';
import type { ActionResult, GameState, Unit } from './types';

const FULL = TANK_DIVISION_TROOPS.armor + TANK_DIVISION_TROOPS.infantry + TANK_DIVISION_TROOPS.artillery;
const strength = (u: Unit): number => (u.troops.infantry + u.troops.armor + u.troops.artillery) / FULL;

/** Seconds until division u may blitz again (0 = ready). */
export function blitzSecondsLeft(state: GameState, u: Unit): number {
  const r = u.blitzReady ?? 0;
  return r > state.tick ? Math.ceil((r - state.tick) / TICKS_PER_SECOND) : 0;
}

/**
 * Why playerId's division u can't blitz now, whatever the target ('' = it can): plain words for the button.
 */
export function blitzBlock(state: GameState, playerId: number, u: Unit | undefined): string {
  const p = state.players[playerId];
  if (!p || !u || u.type !== 'tankDivision' || u.owner !== playerId || u.hp <= 0) return 'No such division';
  if (!hasTech(p, 'armorMastery')) return 'Needs Armor Mastery';
  if (u.state === 3) return 'In a spearhead now';
  const left = blitzSecondsLeft(state, u);
  if (left > 0) return `Recharging ${left} s`;
  if (strength(u) < BLITZ.minShare) return `Too weak: needs ${Math.round(BLITZ.minShare * 100)}% strength`;
  if (p.oil < BLITZ.oil) return `Needs ${BLITZ.oil} oil`;
  return '';
}

/** What a blitz of division unitId toward `tile` would do (spearheadPreview with the blitz's speed, depth and losses). */
export function blitzPreview(state: GameState, playerId: number, unitId: number, tile: number): SpearheadPreview {
  return spearheadPreview(state, playerId, unitId, tile, true);
}

/** Action blitz: the checks, the price, the cooldown, then the drive to the launch tile and the surge. */
export function launchBlitz(state: GameState, playerId: number, unitId: unknown, tile: number): ActionResult {
  if (typeof unitId !== 'number' || !Number.isInteger(unitId)) return { ok: false, reason: 'No such division' };
  const u = state.units.find((q) => q.id === unitId);
  const block = blitzBlock(state, playerId, u);
  if (block) return { ok: false, reason: block };
  const pv = blitzPreview(state, playerId, unitId, tile);
  if (pv.reason) return { ok: false, reason: pv.reason };
  const r = moveTankDivisions(state, playerId, [unitId], tile);
  if (!r.ok) return r;
  const d = u!;
  d.blitz = 1;
  d.blitzReady = state.tick + BLITZ.cooldownSeconds * TICKS_PER_SECOND;
  state.players[playerId].oil -= BLITZ.oil;
  return { ok: true };
}

/** A blitz's spearhead started at its launch tile (tanks.startSpearhead): the smoke screen and the news. */
export function onBlitzStarted(state: GameState, u: Unit, launch: number): void {
  const w = state.map.width;
  state.effects.push({ kind: 'smokeScreen', x: (launch % w) + 0.5, y: ((launch / w) | 0) + 0.5, radius: BLITZ.width, tick: state.tick });
  const o = u.targetOwner;
  const vs = o > 0 ? ` against ${state.players[o].name}` : '';
  addEvent(state, 'info', `${state.players[u.owner].name}'s tanks launched a ${BLITZ_NAME}${vs}`, o > 0 && !isTribe(state.players[o]) ? [u.owner, o] : [u.owner], launch);
}

/** A blitzing division took `tile`: it holds for BLITZ.holdSeconds. */
export function holdTile(state: GameState, owner: number, tile: number): void {
  (state.blitzHolds ??= []).push(tile, owner, state.tick + BLITZ.holdSeconds * TICKS_PER_SECOND);
}

const lookups = new WeakMap<GameState, { arr: number[]; len: number; at: Map<number, number> }>();
/**
 * The player holding `tile` with a blitz now (it still owns it and the hold hasn't run out), 0 = none. Pure read; the
 * index is derived from state.blitzHolds (rebuilt when that list changes).
 */
export function heldBy(state: GameState, tile: number): number {
  const arr = state.blitzHolds;
  if (!arr || !arr.length) return 0;
  let l = lookups.get(state);
  if (!l || l.arr !== arr || l.len !== arr.length) {
    const at = new Map<number, number>();
    for (let k = 0; k < arr.length; k += 3) at.set(arr[k], k); // the latest hold of a tile wins
    lookups.set(state, (l = { arr, len: arr.length, at }));
  }
  const k = l.at.get(tile);
  if (k === undefined || arr[k + 2] <= state.tick) return 0;
  const o = arr[k + 1];
  return state.map.owner[tile] === o ? o : 0;
}

/** Every second (sim.ts): holds that ran out, or whose land changed hands, are dropped. */
export function updateBlitz(state: GameState): void {
  const arr = state.blitzHolds;
  if (!arr || state.tick % TICKS_PER_SECOND !== 0) return;
  const keep: number[] = [];
  for (let k = 0; k < arr.length; k += 3) if (arr[k + 2] > state.tick && state.map.owner[arr[k]] === arr[k + 1]) keep.push(arr[k], arr[k + 1], arr[k + 2]);
  if (keep.length) state.blitzHolds = keep;
  else delete state.blitzHolds;
}

/** Hash of the blitz holds (hash.ts). */
export function hashBlitz(state: GameState, h: number, mixInt: (h: number, v: number) => number): number {
  const arr = state.blitzHolds ?? [];
  h = mixInt(h, arr.length);
  for (const v of arr) h = mixInt(h, v);
  return h;
}
