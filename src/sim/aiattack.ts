// How sharply AI nations fight with their warships, tank divisions and bombers, by difficulty (shared by naval2.ts,
// navy.ts, armor2.ts, airwings.ts and ai.ts). The habits themselves live with each unit's AI code; see DESIGN
// section 10, "How AIs fight with warships, tank divisions and bombers".
import type { Difficulty, GameState } from './types';

/**
 * 0 Easy (the old habits: ships fight wherever they meet, no landing checks, wings fly only while an attack runs,
 * manual bombs one at a time), 1 Normal, 2 Hard, 3 Brutal. Repairs and not throwing damaged units away apply at
 * every level.
 */
export const AI_ATTACK_LEVEL: Readonly<Record<Difficulty, number>> = { easy: 0, normal: 1, hard: 2, brutal: 3 };

export function aiAttackLevel(state: GameState): number {
  return AI_ATTACK_LEVEL[state.settings.difficulty] ?? 1;
}
