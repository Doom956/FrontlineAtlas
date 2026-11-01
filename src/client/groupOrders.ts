// Orders for a whole type at once (the Forces drawer's group bars, hud/groupBar.ts): every warship, every airfield or
// every tank division of the player gets the same order in as few actions as the sim allows.
//   warships   Follow my war (Auto, following) · Hold · Hunt · Escort · Bombard · Blockade  -> setUnitStance, 64 ids each
//   airfields  Support · Strategic · Superiority · Idle (following)                        -> one setAirMission, airfield -1
//              + Auto-refill all (one setAirMission -1 when they share a mission, else one per airfield)
//              + Auto recon all                                                           -> one setAutoRecon, airfield -1
//   divisions  Support front (following) · Hold · Refit                                    -> setDivisionMode, 64 ids each
// The group's order is the choice most of them have now (ties: the order of the buttons); a unit with another choice,
// or one fixed on a target by hand, counts as "set by hand" and Reset to all gives it the group's order again.
// Nothing here changes the game except through dispatch.
import { airMissionOf, wingOf } from '../sim/airwings';
import { divisionMode } from '../sim/armor2';
import { buildingsOf } from '../sim/buildings';
import { MAX_GROUP_UNITS } from '../sim/config';
import { warshipStance } from '../sim/naval2';
import { autoReconOn, followTargetOf } from '../sim/warTarget';
import type { Action, ActionResult, AirMission, Building, DivisionMode, GameState, Unit, WarshipStance } from '../sim/types';

export type GroupKind = 'warship' | 'air' | 'division';
export type ShipChoice = 'follow' | 'hold' | 'hunt' | 'escort' | 'bombard' | 'blockade';
export type GroupChoice = ShipChoice | AirMission | DivisionMode;

export interface GroupChoiceInfo {
  v: GroupChoice;
  name: string;
  icon: string;
  help: string;
}

export const GROUP_CHOICES: Record<GroupKind, readonly GroupChoiceInfo[]> = {
  warship: [
    { v: 'follow', name: 'Follow my war', icon: 'signal', help: 'Auto for all: they guard their posts and shell the coast of the nation you are attacking.' },
    { v: 'hold', name: 'Hold', icon: 'stop', help: 'All stay at their posts and sink enemy ships that come near; none sails off to shell a coast.' },
    { v: 'hunt', name: 'Hunt', icon: 'target', help: 'All chase enemy ships over a wide area.' },
    { v: 'escort', name: 'Escort', icon: 'transport', help: 'All stick to your transports and trade ships.' },
    { v: 'bombard', name: 'Bombard', icon: 'barrage', help: 'All park off the coast of the nation you are attacking and shell it.' },
    { v: 'blockade', name: 'Blockade', icon: 'embargo', help: 'All park off the ports of the nation you are attacking.' },
  ],
  air: [
    { v: 'support', name: 'Support', icon: 'attack', help: 'Every airfield bombs ahead of your attack on the nation you are attacking.' },
    { v: 'strategic', name: 'Strategic', icon: 'bomb', help: 'Every airfield raids the cities and factories of the nation you are attacking.' },
    { v: 'superiority', name: 'Superiority', icon: 'plane', help: 'Every airfield patrols with its fighters over your main front.' },
    { v: 'idle', name: 'Idle', icon: 'pause', help: 'No airfield flies by itself.' },
  ],
  division: [
    { v: 'support', name: 'Support front', icon: 'attack', help: 'All hold behind your main front (it follows your war) and spearhead into weak spots by themselves.' },
    { v: 'hold', name: 'Hold', icon: 'stop', help: 'All stay where they are and defend the land around them.' },
    { v: 'refit', name: 'Refit', icon: 'upgrade', help: 'All drive to your nearest Factory and refill there.' },
  ],
};

/** The choices that follow the owner's war (the order goes out with follow: true and clears a fixed target). */
const FOLLOWS: Record<GroupKind, ReadonlySet<string>> = {
  warship: new Set(['follow', 'bombard', 'blockade']),
  air: new Set(['support', 'strategic', 'superiority']),
  division: new Set(['support']),
};

export interface Member {
  /** unit id (warships, divisions) or airfield tile (air) */
  id: number;
  choice: GroupChoice;
  /** pinned on a target picked by hand (only counts for choices that follow the war) */
  fixed: boolean;
}

export interface GroupState {
  kind: GroupKind;
  members: Member[];
  /** the group's order: the most common choice (null = none of that type) */
  choice: GroupChoice | null;
  /** ids with another choice or a fixed target */
  byHand: number[];
  /** "2 Hunt, 1 fixed" ('' = none set by hand) */
  byHandText: string;
}

const own = (state: GameState, me: number, type: Unit['type']): Unit[] =>
  state.units.filter((u) => u.owner === me && u.type === type && u.hp > 0).sort((a, b) => a.id - b.id);

/** Finished airfields of the player, by building id. */
export function readyAirfields(state: GameState, me: number): Building[] {
  return buildingsOf(state, me, 'airfield')
    .filter((b) => b.buildLeft <= 0)
    .sort((a, b) => a.id - b.id);
}

export function shipChoice(stance: WarshipStance): ShipChoice {
  return stance === 'auto' ? 'follow' : stance;
}

/** Each unit / airfield of the type with its current choice. */
export function groupMembers(state: GameState, me: number, kind: GroupKind): Member[] {
  if (kind === 'air') {
    return readyAirfields(state, me).map((b) => {
      const choice = airMissionOf(state, b);
      const f = choice === 'idle' ? null : followTargetOf(state, b);
      return { id: b.tile, choice, fixed: !!f && !f.follow };
    });
  }
  if (kind === 'warship') return own(state, me, 'warship').map((u) => ({ id: u.id, choice: shipChoice(warshipStance(u)), fixed: !!u.fixed && u.fixed > 0 }));
  return own(state, me, 'tankDivision').map((u) => ({ id: u.id, choice: divisionMode(u), fixed: divisionMode(u) === 'support' && !!u.fixed }));
}

const choiceName = (kind: GroupKind, c: GroupChoice): string => GROUP_CHOICES[kind].find((i) => i.v === c)?.name ?? c;

export function groupState(state: GameState, me: number, kind: GroupKind): GroupState {
  const members = groupMembers(state, me, kind);
  const counts = new Map<GroupChoice, number>();
  for (const m of members) counts.set(m.choice, (counts.get(m.choice) ?? 0) + 1);
  let choice: GroupChoice | null = null;
  let best = 0;
  for (const i of GROUP_CHOICES[kind]) {
    const n = counts.get(i.v) ?? 0;
    if (n > best) {
      best = n;
      choice = i.v;
    }
  }
  const byHand: number[] = [];
  const other = new Map<string, number>();
  let fixed = 0;
  for (const m of members) {
    if (m.choice !== choice) {
      byHand.push(m.id);
      const k = choiceName(kind, m.choice);
      other.set(k, (other.get(k) ?? 0) + 1);
    } else if (m.fixed && FOLLOWS[kind].has(m.choice)) {
      byHand.push(m.id);
      fixed++;
    }
  }
  const parts = [...other].map(([k, n]) => `${n} ${k}`);
  if (fixed) parts.push(`${fixed} fixed on a target`);
  return { kind, members, choice, byHand, byHandText: parts.join(', ') };
}

function chunks(ids: readonly number[]): number[][] {
  const out: number[][] = [];
  for (let i = 0; i < ids.length; i += MAX_GROUP_UNITS) out.push(ids.slice(i, i + MAX_GROUP_UNITS));
  return out;
}

/**
 * The actions that give `choice` to the whole type (`only`: just these ids), skipping the ones that have it already;
 * airfields go as one action for all (the sim's airfield -1). Orders that follow the war go out with follow: true,
 * so fixed targets are cleared. [] = nothing to change.
 */
export function groupOrderActions(state: GameState, me: number, kind: GroupKind, choice: GroupChoice, only?: readonly number[]): Action[] {
  const pick = new Set(only ?? []);
  // the ones that already have it (and follow, where the choice follows) are left alone: no one leaves its station
  const todo = groupMembers(state, me, kind).filter((m) => (!only || pick.has(m.id)) && (m.choice !== choice || (m.fixed && FOLLOWS[kind].has(choice))));
  if (!todo.length) return [];
  if (kind === 'air') {
    const mission = choice as AirMission;
    return [mission === 'idle' ? { type: 'setAirMission', airfield: -1, mission } : { type: 'setAirMission', airfield: -1, mission, follow: true }];
  }
  const ids = todo.map((m) => m.id);
  if (kind === 'warship') {
    const stance: WarshipStance = choice === 'follow' ? 'auto' : (choice as WarshipStance);
    return chunks(ids).map((unitIds) => ({ type: 'setUnitStance', unitIds, stance, follow: true }));
  }
  const mode = choice as DivisionMode;
  return chunks(ids).map((unitIds) => (mode === 'support' ? { type: 'setDivisionMode', unitIds, mode, follow: true } : { type: 'setDivisionMode', unitIds, mode }));
}

/** Reset to all: the group's order for the ones set by hand (airfields: one action for all). */
export function resetActions(state: GameState, me: number, kind: GroupKind): Action[] {
  const g = groupState(state, me, kind);
  if (!g.choice || !g.byHand.length) return [];
  return groupOrderActions(state, me, kind, g.choice, g.byHand);
}

// ------------------------------------------------------------------------------------------------ air extras

/** Re-buy losses: on for every airfield with a mission that flies sorties (Idle never refills). */
export function refillAllOn(state: GameState, me: number): boolean {
  const fields = readyAirfields(state, me).filter((b) => airMissionOf(state, b) !== 'idle');
  return fields.length > 0 && fields.every((b) => wingOf(state, b)?.refill === true);
}

/** Auto-refill all on / off, each airfield keeping its mission and target (one action when they all share them). */
export function refillAllActions(state: GameState, me: number, on: boolean): Action[] {
  const fields = readyAirfields(state, me).filter((b) => airMissionOf(state, b) !== 'idle');
  if (!fields.length) return [];
  const ways = fields.map((b) => {
    const w = wingOf(state, b);
    const f = followTargetOf(state, b);
    return { b, mission: airMissionOf(state, b), follow: !f || f.follow, target: w?.target ?? -1 };
  });
  const all = readyAirfields(state, me).length === fields.length;
  if (all && ways.every((x) => x.follow && x.mission === ways[0].mission)) return [{ type: 'setAirMission', airfield: -1, mission: ways[0].mission, refill: on, follow: true }];
  return ways.map((x): Action =>
    x.follow
      ? { type: 'setAirMission', airfield: x.b.tile, mission: x.mission, refill: on, follow: true }
      : x.target >= 0
        ? { type: 'setAirMission', airfield: x.b.tile, mission: x.mission, target: x.target, refill: on }
        : { type: 'setAirMission', airfield: x.b.tile, mission: x.mission, refill: on },
  );
}

/** Auto recon on every finished airfield? */
export function reconAllOn(state: GameState, me: number): boolean {
  const fields = readyAirfields(state, me);
  return fields.length > 0 && fields.every((b) => autoReconOn(state, b));
}

export function reconAllAction(on: boolean): Action {
  return { type: 'setAutoRecon', airfield: -1, on };
}

/** Sends the actions in order; '' when all went through (or there was nothing to send), else the first reason. */
export function sendAll(dispatch: (a: Action) => ActionResult, actions: readonly Action[]): string {
  for (const a of actions) {
    const r = dispatch(a);
    if (!r.ok) return r.reason ?? 'Not possible now';
  }
  return '';
}
