// Small client helpers around sim features (tribes, rules text, attack odds).
import { RULES_TEXT, TRIBE_COUNT } from '../sim/config';
import type { AttackEstimate } from '../sim/combat';
import { isTribe as simIsTribe } from '../sim/types';
import type { MapSize, Player } from '../sim/types';

/** Default number of tribes for a map size (config TRIBE_COUNT). */
export function defaultTribeCount(size: MapSize): number {
  return TRIBE_COUNT[size] ?? TRIBE_COUNT.medium;
}

/** True for the small filler AIs ("tribes"). */
export function isTribe(p: Player | undefined | null): boolean {
  return simIsTribe(p);
}

/** Short rules from config RULES_TEXT as [title, text] pairs ("alliances" -> "Alliances"). */
export function rulesTextEntries(): [string, string][] {
  return Object.entries(RULES_TEXT).map(([k, t]): [string, string] => [
    k.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, (c) => c.toUpperCase()),
    t,
  ]);
}

/**
 * Outnumbering ratio (attack strength per defending strength, > 1 = you outnumber them) from an estimateAttack
 * result. Its `odds` is 0 against neutral land; then (or with no estimate) it falls back to sent troops /
 * defender army. null = unknown.
 */
export function outnumberRatio(est: Pick<AttackEstimate, 'odds'> | null, sent: number, defenderArmy: number | null): number | null {
  if (est && Number.isFinite(est.odds) && est.odds > 0) return est.odds;
  if (defenderArmy === null || !(sent > 0)) return null;
  return sent / Math.max(1, defenderArmy);
}
