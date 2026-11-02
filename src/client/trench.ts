// Dug-in borders (trenches) and Air cover as the client sees them: the sim reads (src/sim/trenches.ts, airwings.ts)
// plus a few view helpers built on them. Everything here only reads the state; nothing fills a sim cache.
import { airCoverActive, airCoverSorties } from '../sim/airwings';
import type { AttackEstimate } from '../sim/combat';
import { TRENCH } from '../sim/config';
import { doctrineActive } from '../sim/doctrines';
import { borderTiles } from '../sim/territory';
import { drainTrenchChanges, frontTrench, trenchInfoAt, trenchLevel, trenchMaxLevel, type TrenchInfo } from '../sim/trenches';
import type { Building, GameState } from '../sim/types';

export { airCoverActive, airCoverSorties, drainTrenchChanges, frontTrench, trenchInfoAt, trenchLevel, trenchMaxLevel, type TrenchInfo };

/** True when this state carries trenches at all (hand-built test states don't: the renderer then skips them). */
export function hasTrenches(state: GameState): boolean {
  return !!state.trench && state.trench.dig.length === state.map.owner.length;
}

/** A per-tile level reader for whole-map passes (the renderer's rebuild). */
export function trenchLevelReader(state: GameState): (tile: number) => number {
  return (i) => trenchLevel(state, i);
}

/** Mean trench level over the given tiles. */
export function meanFrontTrench(state: GameState, tiles: readonly number[]): number {
  if (!tiles.length) return 0;
  let n = 0;
  for (const t of tiles) n += trenchLevel(state, t);
  return n / tiles.length;
}

/**
 * "+30%": what trenches add to the losses of `attacker`'s click on `tile` (a click advances the whole shared border):
 * the defender's mean front level, breached by the attacker's artillery / heavy tanks as the estimate at that tile
 * says (AttackEstimate.trench). 0 without a shared land border (a landing goes around trenches).
 */
export function dugInPct(state: GameState, attacker: number, defender: number, est?: AttackEstimate | null, tile = -1): number {
  return Math.round(TRENCH.step * 100 * dugInLevel(state, attacker, defender, est, tile));
}

/** Mean effective trench level of `defender`'s front with `attacker` (see dugInPct). */
export function dugInLevel(state: GameState, attacker: number, defender: number, est?: AttackEstimate | null, tile = -1): number {
  const front = frontTrench(state, attacker, defender);
  if (front <= 0) return 0;
  const raw = tile >= 0 ? trenchLevel(state, tile) : 0;
  const breach = est && raw > 0 ? Math.min(1, est.trench / raw) : 1;
  return front * breach;
}

/** The Air doctrine's idle airfields cover their owner's attacks by themselves ("Auto cover" instead of "Idle"). */
export function autoCoverHolder(state: GameState, pid: number): boolean {
  return doctrineActive(state, pid) === 'air';
}

/** The airfield is flying an Air cover sortie now (its auto-cover record is cooling down). Pure read. */
export function coverFlying(state: GameState, airfield: Building): boolean {
  for (const c of state.air?.cover ?? []) if (c.airfield === airfield.id) return c.owner === airfield.owner && c.nextTick > state.tick;
  return false;
}

/** Airfields of the attacker flying Air cover over this attack now: live zones on its target from auto-cover wings. */
export function coveringAirfields(state: GameState, attacker: number, target: number): Building[] {
  const zones = state.air?.zones;
  if (!zones || zones.length === 0 || !autoCoverHolder(state, attacker)) return [];
  const out: Building[] = [];
  for (const z of zones) {
    if (z.owner !== attacker || z.victim !== target || z.untilTick <= state.tick) continue;
    const b = state.buildings.get(z.wing);
    if (!b || out.includes(b) || !coverFlying(state, b) || !airCoverActive(state, b.tile)) continue;
    out.push(b);
  }
  return out;
}

/** The deepest dug tile of `defender` along its border with `attacker` (the guide's arrow); -1 = none dug. */
export function deepestFrontTile(state: GameState, attacker: number, defender: number): number {
  if (!hasTrenches(state) || defender <= 0) return -1;
  const { list, len } = borderTiles(state, defender);
  const { width: w, owner } = state.map;
  let best = -1;
  let bestV = 0;
  for (let k = 0; k < len; k++) {
    const i = list[k];
    const v = trenchLevel(state, i);
    if (v <= bestV) continue;
    const x = i % w;
    if ((x > 0 && owner[i - 1] === attacker) || (x < w - 1 && owner[i + 1] === attacker) || (i >= w && owner[i - w] === attacker) || (i + w < owner.length && owner[i + w] === attacker)) {
      best = i;
      bestV = v;
    }
  }
  return best;
}

/** The tooltip line of a dug tile: "Trench 2 of 3" and what it does. */
export function trenchTileText(info: TrenchInfo): { main: string; sub: string } {
  const loss = Math.round(info.lossPct * 100);
  const slow = Math.round(info.slowPct * 100);
  return {
    main: `Trench ${info.level} of ${Math.max(info.level, info.max)}`,
    sub: `Attackers lose ${loss}% more and advance ${slow}% slower here. Artillery, barrages, planes and warships flatten it.`,
  };
}
