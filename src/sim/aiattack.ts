// What AI nations' warships, tank divisions and bombers key off when they fight (shared by naval2.ts, armor2.ts,
// airwings.ts and ai.ts): how sharp the AI is by difficulty, and its main attack and main front right now.
//
// The main attack is the AI nation's own attack with the most troops on a live, hostile nation (not a tribe); its
// main front is that nation's border tile nearest the attack's focus (warTarget.mainFront). Both are derived from the
// state (no new game state), cached per tick in a WeakMap keyed by the GameState, so every unit of a nation asking in
// the same tick gets the same answer at the cost of one scan.
// Deterministic: no RNG; fixed tie-breaks (more troops, then lower attack id).
import { areAllied } from './diplomacy';
import { atPeace } from './rules';
import { mainFront } from './warTarget';
import { isTribe } from './types';
import type { Difficulty, GameState } from './types';

/**
 * How sharply AI units fight, by difficulty: 0 Easy (the old habits: ships shell any enemy coast, no odds, no
 * invasion checks), 1 Normal, 2 Hard, 3 Brutal. Repairs and not throwing damaged units away apply at every level.
 */
export const AI_ATTACK_LEVEL: Readonly<Record<Difficulty, number>> = { easy: 0, normal: 1, hard: 2, brutal: 3 };

export function aiAttackLevel(state: GameState): number {
  return AI_ATTACK_LEVEL[state.settings.difficulty] ?? 1;
}

/** True for a live AI nation (not a human, not a tribe). */
export function isAINation(state: GameState, id: number): boolean {
  const p = state.players[id];
  return !!p && id > 0 && p.alive && !p.isHuman && !isTribe(p);
}

export interface MainAttack {
  target: number;
  /** the attack's focus tile (where it was launched) */
  focus: number;
  troops: number;
  attackId: number;
}

interface Cache {
  tick: number;
  main: Map<number, MainAttack | null>;
  front: Map<number, number>;
}
const caches = new WeakMap<GameState, Cache>();

function cache(state: GameState): Cache {
  let c = caches.get(state);
  if (!c || c.tick !== state.tick) {
    c = { tick: state.tick, main: new Map(), front: new Map() };
    caches.set(state, c);
  }
  return c;
}

/** Drops the per-tick cache (tests that change attacks within one tick). */
export function clearAIAttackCache(state: GameState): void {
  caches.delete(state);
}

/** `id`'s own attack with the most troops on a live hostile nation (ties: lower attack id); null = none. */
export function aiMainAttack(state: GameState, id: number): MainAttack | null {
  const c = cache(state);
  const had = c.main.get(id);
  if (had !== undefined) return had;
  let best: MainAttack | null = null;
  for (const a of state.attacks) {
    if (a.attacker !== id || a.target <= 0 || a.target === id) continue;
    const tp = state.players[a.target];
    if (!tp?.alive || isTribe(tp) || areAllied(state, id, a.target) || atPeace(state, id, a.target)) continue;
    const tr = a.troops.infantry + a.troops.armor + a.troops.artillery;
    if (tr <= 0) continue;
    if (!best || tr > best.troops || (tr === best.troops && a.id < best.attackId)) best = { target: a.target, focus: a.focusTile, troops: tr, attackId: a.id };
  }
  c.main.set(id, best);
  return best;
}

/** The main front of `id` against `target` (warTarget.mainFront), cached per tick; -1 = no shared border. */
export function aiMainFront(state: GameState, id: number, target: number): number {
  const c = cache(state);
  const key = id * 4096 + target;
  const had = c.front.get(key);
  if (had !== undefined) return had;
  const f = mainFront(state, id, target);
  c.front.set(key, f);
  return f;
}
