// Benchmark override: one AI nation specialises in a pillar (scripts/batch.ts --specialist). Nothing in a real game
// sets it; the AI asks aiFocus() at its existing pillar decisions (variantsAI.aiCommittedPillar / aiPriorityArsenalTech,
// aispending.aiBranchPick, ai.ts profile, doctrine, airfields, warships). Like aispending's counters it lives in a
// per-game WeakMap outside GameState, so it is never hashed or sent: only a script that sets it for every run of a
// seed gets the same game twice.
import type { BuildingType, DoctrineId, GameState, TechId } from './types';

export type FocusPillar = 'navy' | 'armor' | 'air' | 'land' | 'economy';
export const FOCUS_PILLARS: readonly FocusPillar[] = ['navy', 'armor', 'air', 'land', 'economy'];

export interface AIFocus {
  pillar: FocusPillar;
  /** a forced member of the pillar's fork group (FOCUS_SPEC.group); absent = the AI's own pick (map and personality) */
  fork?: TechId;
}

export interface FocusSpec {
  /** arsenal pillar its mastery goes to (null = the AI's own commitment) */
  arms: 'navy' | 'armor' | 'air' | null;
  /** exclusive tech group that is this pillar's fork */
  group: string;
  /** doctrines it may hold (the AI's best-scoring one of these; never switches away) */
  doctrines: DoctrineId[];
  /** techs moved to the front of its research order (fork root and upgrades follow via the group / arms pillar) */
  techs: TechId[];
  /** build priority multipliers on top of the personality's */
  build: Partial<Record<BuildingType, number>>;
  /** extra armor / artillery share of the army */
  mix: { armor: number; artillery: number };
  /** naval appetite (ports, warships, landings), replaces the personality's when higher */
  naval: number;
  /** extra warships kept and extra airfields built */
  warships: number;
  airfields: number;
}

export const FOCUS_SPEC: Readonly<Record<FocusPillar, FocusSpec>> = {
  navy: {
    arms: 'navy', group: 'navalDoctrine', doctrines: ['naval'], techs: ['navigation'],
    build: { port: 2.2 }, mix: { armor: 0, artillery: 0 }, naval: 1, warships: 2, airfields: 0,
  },
  armor: {
    arms: 'armor', group: 'armorPath', doctrines: ['blitz'], techs: ['metallurgy', 'mechanization', 'industrialization'],
    build: { factory: 1.8, oilWell: 1.5, mine: 1.3, supplyDepot: 1.2 }, mix: { armor: 0.2, artillery: 0 }, naval: 0, warships: 0, airfields: 0,
  },
  air: {
    arms: 'air', group: 'airDoctrine', doctrines: ['air'], techs: ['logistics', 'flight', 'radar'],
    build: { airfield: 2, oilWell: 1.3, sam: 1.2 }, mix: { armor: 0, artillery: 0 }, naval: 0, warships: 0, airfields: 2,
  },
  land: {
    arms: null, group: 'landDoctrine', doctrines: ['siege', 'fortress', 'expansion'], techs: ['fortification', 'metallurgy', 'ballistics', 'mechanization'],
    build: { fort: 1.6, arsenal: 1.8, barracks: 1.4, watchtower: 1.2 }, mix: { armor: 0, artillery: 0.15 }, naval: 0, warships: 0, airfields: 0,
  },
  economy: {
    arms: null, group: 'finance', doctrines: ['blitz', 'fortress', 'siege', 'merchant', 'naval', 'air', 'expansion'], techs: ['agriculture', 'banking'],
    build: { market: 1.8, lab: 1.4, city: 1.15, port: 1.3, farm: 1.2 }, mix: { armor: 0, artillery: 0 }, naval: 0, warships: 0, airfields: 0,
  },
};

const focusByGame = new WeakMap<GameState, Map<number, AIFocus>>();

/** Forces AI nation `id` to specialise (null clears it). Script use only. */
export function setAIFocus(state: GameState, id: number, focus: AIFocus | null): void {
  let m = focusByGame.get(state);
  if (!m) focusByGame.set(state, (m = new Map()));
  if (focus) m.set(id, focus);
  else m.delete(id);
}

/** The forced specialisation of AI `id`, if a script set one. */
export function aiFocus(state: GameState, id: number): AIFocus | undefined {
  return focusByGame.get(state)?.get(id);
}

/** Spec of AI `id`'s forced specialisation, if any. */
export function aiFocusSpec(state: GameState, id: number): FocusSpec | undefined {
  const f = focusByGame.get(state)?.get(id);
  return f ? FOCUS_SPEC[f.pillar] : undefined;
}

/** The forced fork member of `group` for AI `id` (only its own pillar's group and only with --fork), else null. */
export function aiFocusFork(state: GameState, id: number, group: string): TechId | null {
  const f = focusByGame.get(state)?.get(id);
  return f?.fork && FOCUS_SPEC[f.pillar].group === group ? f.fork : null;
}
