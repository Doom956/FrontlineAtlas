// Arsenal: the vehicle side of research (the Research panel's second tab). Every item is an ordinary tech (TechId +
// TECHS entry) bought with Action 'research', so the rules (prerequisites, exclusive forks, gold, science) are the
// tech tree's (techtree.ts). This file only groups them into rows and adds the mastery cap.
//
// Rows (one per pillar, left to right by tier):
//   Navy    Navigation -> Destroyers -> Battleships   OR   Submarines -> Carriers;  Naval Mines;  Naval Mastery
//   Armor   Mechanization -> Light Tanks -> Deep Raids   OR   Heavy Tanks -> Siege Tanks;  Amphibious Tanks;  Armor Mastery
//   Air     Flight -> Ground-attack Planes -> Jet Engines   OR   Heavy Bombers -> Strategic Bombing;  Drop Tanks,
//           Night Bombing;  Air Mastery
//   Shared  Mechanized Infantry, Recon Planes;  Early Warning
// A fork is an exclusive group (TechInfo.exclusiveGroup on the two roots): choosing one root locks the other root and
// everything after it (techtree.choiceLockedBy follows `requires`). Mastery techs (top tier) may be researched in at
// most MASTERY_CAP pillars per game (masteryLocked; techStatus shows it as a 'locked-choice' with the reason).
// What the variants do: variants.ts. Pure data and pure functions: deterministic.
import { ARSENAL, TECHS } from './config';
import type { Player, TechId } from './types';

export type Pillar = 'navy' | 'armor' | 'air' | 'shared';
export const PILLARS: readonly Pillar[] = ['navy', 'armor', 'air', 'shared'];

export interface ArsenalItem {
  tech: TechId;
  pillar: Pillar;
  /** column in the row: 1 unlock, 2 fork variant, 3 variant upgrade / special, 4 mastery */
  tier: number;
  /** exclusive group id of the fork this item belongs to (both roots and everything after them) */
  fork?: string;
  kind: 'variant' | 'special' | 'mastery' | 'unlock';
  /** fork items: the root tech of their branch (Destroyers for Battleships); the UI draws one lane per branch */
  branch?: TechId;
}

export const ARSENAL_ROWS: { pillar: Pillar; name: string; items: ArsenalItem[] }[] = [
  {
    pillar: 'navy',
    name: 'Navy',
    items: [
      { tech: 'navigation', pillar: 'navy', tier: 1, kind: 'unlock' },
      { tech: 'destroyers', pillar: 'navy', tier: 2, kind: 'variant', fork: 'navalDoctrine', branch: 'destroyers' },
      { tech: 'battleships', pillar: 'navy', tier: 3, kind: 'variant', fork: 'navalDoctrine', branch: 'destroyers' },
      { tech: 'submarines', pillar: 'navy', tier: 2, kind: 'variant', fork: 'navalDoctrine', branch: 'submarines' },
      { tech: 'carriers', pillar: 'navy', tier: 3, kind: 'variant', fork: 'navalDoctrine', branch: 'submarines' },
      { tech: 'navalMines', pillar: 'navy', tier: 3, kind: 'special' },
      { tech: 'navalMastery', pillar: 'navy', tier: 4, kind: 'mastery' },
    ],
  },
  {
    pillar: 'armor',
    name: 'Armor',
    items: [
      { tech: 'mechanization', pillar: 'armor', tier: 1, kind: 'unlock' },
      { tech: 'lightTanks', pillar: 'armor', tier: 2, kind: 'variant', fork: 'armorPath', branch: 'lightTanks' },
      { tech: 'deepRaids', pillar: 'armor', tier: 3, kind: 'variant', fork: 'armorPath', branch: 'lightTanks' },
      { tech: 'heavyTanks', pillar: 'armor', tier: 2, kind: 'variant', fork: 'armorPath', branch: 'heavyTanks' },
      { tech: 'siegeTanks', pillar: 'armor', tier: 3, kind: 'variant', fork: 'armorPath', branch: 'heavyTanks' },
      { tech: 'amphibiousTanks', pillar: 'armor', tier: 3, kind: 'special' },
      { tech: 'armorMastery', pillar: 'armor', tier: 4, kind: 'mastery' },
    ],
  },
  {
    pillar: 'air',
    name: 'Air',
    items: [
      { tech: 'flight', pillar: 'air', tier: 1, kind: 'unlock' },
      { tech: 'groundAttack', pillar: 'air', tier: 2, kind: 'variant', fork: 'airDoctrine', branch: 'groundAttack' },
      { tech: 'jetEngines', pillar: 'air', tier: 3, kind: 'variant', fork: 'airDoctrine', branch: 'groundAttack' },
      { tech: 'heavyBombers', pillar: 'air', tier: 2, kind: 'variant', fork: 'airDoctrine', branch: 'heavyBombers' },
      { tech: 'strategicBombing', pillar: 'air', tier: 3, kind: 'variant', fork: 'airDoctrine', branch: 'heavyBombers' },
      { tech: 'dropTanks', pillar: 'air', tier: 3, kind: 'special' },
      { tech: 'nightBombing', pillar: 'air', tier: 3, kind: 'special' },
      { tech: 'airMastery', pillar: 'air', tier: 4, kind: 'mastery' },
    ],
  },
  {
    pillar: 'shared',
    name: 'Shared',
    items: [
      { tech: 'mechInfantry', pillar: 'shared', tier: 2, kind: 'unlock' },
      { tech: 'reconPlanes', pillar: 'shared', tier: 2, kind: 'unlock' },
      { tech: 'earlyWarning', pillar: 'shared', tier: 3, kind: 'special' },
    ],
  },
];

const ITEMS = new Map<TechId, ArsenalItem>();
for (const row of ARSENAL_ROWS) for (const it of row.items) if (TECHS[it.tech]) ITEMS.set(it.tech, it);

/** True for techs shown in the Arsenal tab (the Research tab shows the others). */
export function isArsenalTech(t: TechId): boolean {
  return ITEMS.has(t);
}
/** The arsenal item of a tech, or undefined for a Research-tab tech. */
export function arsenalItem(t: TechId): ArsenalItem | undefined {
  return ITEMS.get(t);
}
/** Pillar of an arsenal tech, or null. */
export function pillarOf(t: TechId): Pillar | null {
  return ITEMS.get(t)?.pillar ?? null;
}

/** Mastery techs in at most this many pillars per game. */
export const MASTERY_CAP = ARSENAL.masteryCap;
/** The mastery tech of each combat pillar. */
export const MASTERY_TECHS: Record<Exclude<Pillar, 'shared'>, TechId> = { navy: 'navalMastery', armor: 'armorMastery', air: 'airMastery' };
export const PILLAR_NAMES: Record<Pillar, string> = { navy: 'Navy', armor: 'Armor', air: 'Air', shared: 'Shared' };

export function isMasteryTech(t: TechId): boolean {
  return ITEMS.get(t)?.kind === 'mastery';
}
/** Pillars in which p has (or is researching) the mastery. */
export function masteryPillars(p: Player): Pillar[] {
  const out: Pillar[] = [];
  for (const pl of ['navy', 'armor', 'air'] as const) {
    const t = MASTERY_TECHS[pl];
    if (p.techs.includes(t) || p.researching === t) out.push(pl);
  }
  return out;
}
/**
 * Why p may not research mastery tech t ("Mastery 2 of 2 used (Navy, Air)"), or null (not a mastery, already owned /
 * being researched, or a slot is free).
 */
export function masteryLocked(p: Player, t: TechId): string | null {
  const it = ITEMS.get(t);
  if (!it || it.kind !== 'mastery') return null;
  if (p.techs.includes(t) || p.researching === t) return null;
  const used = masteryPillars(p).filter((x) => x !== it.pillar);
  if (used.length < MASTERY_CAP) return null;
  return `Mastery ${used.length} of ${MASTERY_CAP} used (${used.map((x) => PILLAR_NAMES[x]).join(', ')}); ${TECHS[t].name} is locked`;
}

/** The branch root p chose in a pillar's fork (owned or being researched), or null. */
export function pathOf(p: Player, pillar: Pillar): TechId | null {
  for (const row of ARSENAL_ROWS) {
    if (row.pillar !== pillar) continue;
    for (const it of row.items) {
      if (it.branch !== it.tech) continue;
      if (p.techs.includes(it.tech) || p.researching === it.tech) return it.tech;
    }
  }
  return null;
}
