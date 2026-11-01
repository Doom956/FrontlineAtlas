// "Follow my war" on the client: air wings, warships (Bombard / Blockade) and tank divisions in Support mode retarget
// by themselves to the nation the owner is attacking (the sim decides: followTargetOf). This file only reads that and
// phrases it for the airfield panel (hud/airPanel.ts) and the orders bar (hud/ordersBar.ts):
//   following   "Following: your attack on Azuria" / "Following: Azuria (last attack)" / "Following: no war yet"
//   fixed       "Fixed: Azuria's coast" with a "Follow my war" button back
// The actions carry follow: true to switch back; a map click on a target makes the unit or mission fixed.
import { buildingAt } from '../sim/buildings';
import type { GameState } from '../sim/types';
import { UNITS } from '../sim/config';
import { followTargetOf, warTargetOf } from '../sim/warTarget';

export type FollowKind = 'air' | 'warship' | 'division';

export interface FollowTarget {
  /** the followed (or fixed) nation, 0 = none */
  nation: number;
  /** the tile it aims at, -1 = none */
  tile: number;
  /** a manual target: no longer follows the owner's war */
  fixed: boolean;
}


/**
 * What a unit (kind 'warship' / 'division', id = unit id) or an air wing (kind 'air', id = airfield tile) follows
 * (sim warTarget.followTargetOf); null = nothing to follow (idle wing, other stance / mode, not the player's).
 */
export function followOf(state: GameState, kind: FollowKind, id: number): FollowTarget | null {
  const x = kind === 'air' ? buildingAt(state, id) : state.units.find((u) => u.id === id && u.type === (kind === 'warship' ? 'warship' : 'tankDivision'));
  const f = x ? followTargetOf(state, x) : null;
  return f ? { nation: f.nation, tile: f.tile, fixed: !f.follow } : null;
}

/** Does this choice follow the owner's war at all? (stances / modes / missions without a target do not) */
export function followsWar(kind: FollowKind, choice: string): boolean {
  if (kind === 'air') return choice === 'support' || choice === 'strategic' || choice === 'superiority';
  if (kind === 'warship') return choice === 'bombard' || choice === 'blockade' || choice === 'auto';
  return choice === 'support';
}

const nameOf = (state: GameState, id: number): string => state.players[id]?.name ?? 'the enemy';

/** "Following: your attack on Azuria" / "Following: Azuria (last attack)" / "Following: no war yet". */
export function followingLine(state: GameState, owner: number, t: FollowTarget): string {
  if (t.nation <= 0) return 'Following: no war yet';
  const running = state.attacks.some((a) => a.attacker === owner && a.target === t.nation);
  return running ? `Following: your attack on ${nameOf(state, t.nation)}` : `Following: ${nameOf(state, t.nation)} (last attack)`;
}

/** The manual target in a few words ("Azuria's coast", "a patrol point"). */
export function fixedTargetName(state: GameState, kind: FollowKind, choice: string, t: FollowTarget): string {
  const who = t.nation > 0 ? `${nameOf(state, t.nation)}'s` : '';
  if (kind === 'air') {
    if (choice === 'superiority') return 'your patrol point';
    return who ? `${nameOf(state, t.nation)}${choice === 'strategic' ? ' (raid)' : ' (front)'}` : 'your pick';
  }
  if (kind === 'warship') {
    if (choice === 'blockade') return who ? `${who} port` : 'a port';
    return who ? `${who} coast` : 'your pick';
  }
  return who ? `the front with ${nameOf(state, t.nation)}` : 'your front';
}

/** The follow state of a group: fixed when any of them is fixed (one click puts them all back on Follow). */
export function groupFollow(state: GameState, kind: 'warship' | 'division', ids: readonly number[]): FollowTarget | null {
  let first: FollowTarget | null = null;
  for (const id of ids) {
    const t = followOf(state, kind, id);
    if (!t) continue;
    if (t.fixed) return t;
    if (!first) first = t;
  }
  return first;
}

/** The status line of a follow row: "Following: ..." or "Fixed: Azuria's coast". */
export function followText(state: GameState, owner: number, kind: FollowKind, choice: string, t: FollowTarget): string {
  return t.fixed ? `Fixed: ${fixedTargetName(state, kind, choice, t)}` : followingLine(state, owner, t);
}

/** The airfield's auto-recon toggle: label and tooltip (off by default: every flight costs gold and oil). */
export function autoReconText(state: GameState, owner: number, on: boolean): { label: string; tip: string } {
  const c = UNITS.reconPlane;
  const cost = `${c.gold} gold${c.oil ? ` and ${c.oil} oil` : ''}`;
  if (!on) return { label: 'Auto recon: off', tip: `Off: recon flies only when you order it. On: scouts the nation you attack whenever the plane is ready (${cost} a flight).` };
  const n = warTargetOf(state, owner).nation;
  return { label: n > 0 ? `Auto recon: scouts ${nameOf(state, n)}` : 'Auto recon: on (no war yet)', tip: `On: scouts the nation you attack whenever the plane is ready (${cost} a flight). Click to turn off.` };
}
