// "Follow my war" on the client: air wings, warships (Bombard / Blockade) and tank divisions in Support mode retarget
// by themselves to the nation the owner is attacking (the sim decides: followTargetOf). This file only reads that and
// phrases it for the airfield panel (hud/airPanel.ts) and the orders bar (hud/ordersBar.ts):
//   following   "Following: your attack on Azuria" / "Following: Azuria (last attack)" / "Following: no war yet"
//   fixed       "Fixed: Azuria's coast" with a "Follow my war" button back
// The actions carry follow: true to switch back; a map click on a target makes the unit or mission fixed.
import { buildingAt, buildingsOf } from '../sim/buildings';
import type { Building, GameState, Unit } from '../sim/types';
import { ARMOR_SUPPORT_READY, UNITS } from '../sim/config';
import { followedNation, followTargetOf, liveFoes, warTargetOf } from '../sim/warTarget';
import { mendingInPort, warshipMaxHp, warshipStance } from '../sim/naval2';
import { divisionStrength } from '../sim/armor2';
import { airCoverActive, airMissionOf, wingOf } from '../sim/airwings';
import { autoFireOn, autoFireSaving, autoFireTargetsFor } from '../sim/airstrike';
import { hasTech } from '../sim/tech';

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
  // a front picked on our own side names no nation ("Fixed: your front")
  return f && x ? { nation: f.nation === x.owner ? 0 : f.nation, tile: f.tile, fixed: !f.follow } : null;
}

/** Does this choice follow the owner's war at all? (stances / modes / missions without a target do not) */
export function followsWar(kind: FollowKind, choice: string): boolean {
  if (kind === 'air') return choice === 'support' || choice === 'strategic' || choice === 'superiority';
  if (kind === 'warship') return choice === 'bombard' || choice === 'blockade' || choice === 'auto';
  return choice === 'support';
}

const nameOf = (state: GameState, id: number): string => state.players[id]?.name ?? 'the enemy';

/** "Following: your attack on Azuria" / "Following: Azuria, attacking you" / "Following: Azuria (last attack)" / "Following: no war yet". */
export function followingLine(state: GameState, owner: number, t: FollowTarget): string {
  if (t.nation <= 0) return 'Following: no war yet';
  const running = state.attacks.some((a) => a.attacker === owner && a.target === t.nation);
  if (running) return `Following: your attack on ${nameOf(state, t.nation)}`;
  if (state.attacks.some((a) => a.attacker === t.nation && a.target === owner)) return `Following: ${nameOf(state, t.nation)}, attacking you`;
  return `Following: ${nameOf(state, t.nation)} (last attack)`;
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

// ---------------------------------------------------------------------------------------------------------------
// "Auto: ..." lines: what a vehicle does by itself right now, in a few plain words (unit card, airfield panel, silo)
// ---------------------------------------------------------------------------------------------------------------

/** "Auto: ..." line of an own warship or tank division (unit card); '' for other units. */
export function unitAutoLine(state: GameState, me: number, u: Unit): string {
  if (u.owner !== me) return '';
  const nation = followedNation(state, me);
  if (u.type === 'warship') {
    const st = warshipStance(u);
    if (st === 'hold') return 'Auto: off, holds its post (pick Auto to let it fight)';
    if (st === 'escort') return 'Auto: escorting your transports and trade ships';
    if (st === 'hunt') return 'Auto: hunting enemy ships in its sea';
    if (mendingInPort(state, u)) return 'Auto: repairing at port, then back out';
    if (u.state === 1 && st === 'auto' && u.path.length && nearOwnPort(state, u.owner, u.path[u.path.length - 1])) {
      return u.hp < warshipMaxHp(u) - 1e-9 ? 'Auto: going to port for repairs' : 'Auto: outnumbered, falling back to port';
    }
    const fixed = u.fixed && u.fixed > 0 ? u.fixed : 0;
    const aim = fixed || nation;
    const coast = u.state === 3 && u.station !== undefined ? state.map.owner[u.station] : 0;
    if (coast > 0 && coast !== me) return `Auto: ${st === 'blockade' ? 'blockading' : 'shelling'} ${nameOf(state, coast)}'s coast${fixed ? ' (fixed)' : ''}`;
    if (aim <= 0) return liveFoes(state, me).length ? 'Auto: looking for an enemy coast in its sea' : 'Auto: no war, patrolling';
    if ((u.retryTick ?? 0) > state.tick) return `Auto: no coast of ${nameOf(state, aim)} in its sea, waiting`;
    return `Auto: sailing to ${nameOf(state, aim)}'s coast`;
  }
  if (u.type !== 'tankDivision') return '';
  const mode = u.mode ?? 'hold';
  if (mode === 'hold') return 'Auto: off, defends where it is (pick Support)';
  if (mode === 'refit') return 'Auto: refitting at a Factory';
  if (u.state === 2 || u.state === 3) return `Auto: spearhead into ${nameOf(state, u.targetOwner)}`;
  const st = u.station;
  const o = st !== undefined ? state.map.owner[st] : 0;
  const vs = o > 0 && o !== me ? o : nation;
  if (u.fixed) return vs > 0 ? `Auto: supporting the front with ${nameOf(state, vs)} (fixed)` : 'Auto: supporting your front (fixed)';
  if (nation <= 0) return 'Auto: no war, waiting';
  if (st === undefined) return `Auto: no land front with ${nameOf(state, nation)}, waiting here`;
  if (divisionStrength(u) < ARMOR_SUPPORT_READY) return 'Auto: refitting before the next push';
  if (u.detour !== undefined && vs !== nation) return `Auto: no road to ${nameOf(state, nation)}, supporting the front with ${nameOf(state, vs)}`;
  if (u.state === 1) return `Auto: driving to the front with ${nameOf(state, vs)}`;
  if ((u.retryTick ?? 0) > state.tick) return `Auto: no road to the front with ${nameOf(state, vs)} yet, retrying`;
  return `Auto: supporting the front with ${nameOf(state, vs)}`;
}

/** True when an own finished Port is within 8 tiles of `tile` (where ships mend and fall back to). */
function nearOwnPort(state: GameState, owner: number, tile: number): boolean {
  const w = state.map.width;
  for (const b of buildingsOf(state, owner, 'port')) {
    if (b.buildLeft > 0) continue;
    const dx = (b.tile % w) - (tile % w);
    const dy = ((b.tile / w) | 0) - ((tile / w) | 0);
    if (dx * dx + dy * dy <= 64) return true;
  }
  return false;
}

/** "Auto: ..." line of an own finished airfield (airfield panel). */
export function airAutoLine(state: GameState, b: Building): string {
  const wing = wingOf(state, b);
  const mission = airMissionOf(state, b);
  if (mission === 'idle') return airCoverActive(state, b.tile) ? 'Auto: Air cover bombs dug-in fronts by itself' : 'Auto: off (Idle)';
  if (mission === 'superiority') return b.fighters > 0 ? 'Auto: fighters guard the sky' : 'Auto: no fighters here';
  if (b.bombers <= 0) return 'Auto: no bombers here';
  const nation = wing?.follow ? followedNation(state, b.owner) : (wing?.targetOwner ?? 0);
  if (nation <= 0) return 'Auto: no war, waiting';
  const aimOwner = wing && wing.target >= 0 ? state.map.owner[wing.target] : 0;
  const fixed = wing?.follow ? '' : ' (fixed)';
  if (mission === 'strategic') return `Auto: raiding ${nameOf(state, nation)}${fixed}`;
  if (!wing || wing.target < 0) return `Auto: ${nameOf(state, nation)} is out of reach`;
  if (aimOwner > 0 && aimOwner !== nation && aimOwner !== b.owner) return `Auto: ${nameOf(state, nation)} out of reach, bombing ${nameOf(state, aimOwner)}`;
  return `Auto: bombing the front with ${nameOf(state, nation)}${fixed}`;
}

/** "Auto: ..." line of an own finished silo. */
export function siloAutoLine(state: GameState, b: Building): string {
  const p = state.players[b.owner];
  if (!p || !hasTech(p, 'rocketry')) return '';
  if (!autoFireOn(state, b.tile)) return 'Auto: off (rockets fire only when you aim them)';
  const nation = followedNation(state, b.owner);
  if (nation <= 0) return 'Auto: no war, waiting';
  if (!autoFireTargetsFor(state, b.owner, nation).length) return `Auto: no target near the front with ${nameOf(state, nation)}`;
  if (autoFireSaving(state, b.owner)) return 'Auto: saving up (keeps the price of 2 rockets)';
  return `Auto: fires rockets at ${nameOf(state, nation)} when loaded`;
}
