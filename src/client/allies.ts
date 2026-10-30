// Client view of heartland defence, last stand, the force limit, coalitions and asking allies for help.
// Everything the HUD needs from those sim rules goes through this file, so the rest of the client has one place to
// read them from (and to send the two ally requests).
import { allyRefusal, allyStatus } from '../sim/allies';
import { coreDefenseAt, lastStandFactor } from '../sim/combat';
import { FORCE_LIMIT_ODDS, TICKS_PER_SECOND } from '../sim/config';
import { areAllied } from '../sim/diplomacy';
import { isTribe } from '../sim/types';
import type { Action, GameEvent, GameState } from '../sim/types';


/** A multiplier (1.35) or a fraction (0.35) as a bonus fraction (0.35); 0 when there is none. */
function asBonus(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return 0;
  const b = v >= 1 ? v - 1 : v;
  return b > 0.005 ? b : 0;
}

/** Heartland defence bonus of a land tile for its owner, as a fraction (0.35 = +35%). combat.coreDefenseAt */
export function heartlandBonus(state: GameState, tile: number): number {
  const owner = state.map.owner[tile];
  if (!owner) return 0;
  return asBonus(coreDefenseAt(state, owner, tile));
}

/**
 * Last-stand defence bonus of `defender` against `attacker` (combat.lastStandFactor), as a fraction; without an
 * attacker, the largest against any nation attacking it now (0 when nobody does: it only matters in a fight).
 */
export function lastStandBonus(state: GameState, defender: number, attacker?: number): number {
  if (defender <= 0) return 0;
  if (attacker !== undefined) return attacker > 0 ? asBonus(lastStandFactor(state, defender, attacker)) : 0;
  let best = 0;
  for (const a of state.attacks) if (a.target === defender && a.attacker > 0) best = Math.max(best, asBonus(lastStandFactor(state, defender, a.attacker)));
  return best;
}

/** Outnumbering beyond this ratio adds little (the force limit, config FORCE_LIMIT_ODDS). */
export function forceLimit(): number {
  return FORCE_LIMIT_ODDS;
}

export interface AllyStatusView {
  /** one short line: "Will help: at war with Tarsis too", "Busy: fighting Ostheim", "Won't help: …" */
  text: string;
  /** true = would say yes now, false = would say no, null = a human ally (decides for themselves) */
  willing: boolean | null;
  /** seconds until you may ask your allies again (0 = now) */
  askIn: number;
}

/** What an ally is up to and whether it would help now (sim allies.allyStatus in one line). */
export function allyStatusOf(state: GameState, me: number, ally: number): AllyStatusView {
  const st = allyStatus(state, me, ally);
  const a = state.players[ally];
  const name = (id: number) => state.players[id]?.name ?? 'someone';
  const askIn = st.askReadyIn;
  if (a?.isHuman) return { text: 'A player: decides for themselves', willing: null, askIn };
  if (state.allyRequests.some((r) => r.from === me && r.ally === ally)) return { text: 'Asked: waiting for the answer', willing: null, askIn };
  const mine = warsOf(state, me);
  const shared = st.atWarWith.find((id) => mine.has(id));
  if (st.willHelp) return { text: shared ? `Will help: at war with ${name(shared)} too` : 'Will help: ready when you ask', willing: true, askIn };
  // the sim's reason reads "<ally>: why"; drop the name
  const why = a && st.reason.startsWith(`${a.name}: `) ? st.reason.slice(a.name.length + 2) : st.reason;
  const busy = st.atWarWith.find((id) => id !== shared) ?? shared;
  if (busy && /surviv|no troops|spare/.test(why)) return { text: `Busy: fighting ${name(busy)}`, willing: false, askIn };
  return { text: `Won't help: ${why}`, willing: false, askIn };
}

/** Nations a player is fighting (either side of an attack; the wilderness and tribes count only as targets). */
export function warsOf(state: GameState, id: number): Set<number> {
  const out = new Set<number>();
  for (const a of state.attacks) {
    if (a.attacker === id && a.target > 0) out.add(a.target);
    else if (a.target === id && a.attacker > 0) out.add(a.attacker);
  }
  return out;
}

/** Your allies (alliances and teammates), alive. */
export function alliesOf(state: GameState, me: number): number[] {
  const out: number[] = [];
  for (const p of state.players) if (p && p.id > 0 && p.alive && p.id !== me && areAllied(state, me, p.id)) out.push(p.id);
  return out;
}

/** Nations an ally could be asked to attack: enemies first (at war with you), then your neighbours by army size. */
export function attackTargets(state: GameState, me: number, ally: number, bordersMe: (id: number) => boolean): number[] {
  const wars = warsOf(state, me);
  const list = state.players.filter(
    (p) => p && p.alive && p.id > 0 && p.id !== me && p.id !== ally && !isTribe(p) && !areAllied(state, me, p.id) && !areAllied(state, ally, p.id),
  );
  const rank = (id: number) => (wars.has(id) ? 0 : bordersMe(id) ? 1 : 2);
  list.sort((a, b) => rank(a.id) - rank(b.id) || b.tiles - a.tiles);
  return list.filter((p) => rank(p.id) < 2).slice(0, 6).map((p) => p.id);
}

/**
 * "Ask allies to attack here": one request per cooldown, so the ally most likely to say yes (no refusal reason, then
 * already at war with the target, then the strongest). null with the reason when nobody can be asked now.
 */
export function bestAllyFor(state: GameState, me: number, target: number): { ally: number; why: string } {
  const p = state.players[me];
  const wait = p ? Math.ceil((p.allyAskTick - state.tick) / TICKS_PER_SECOND) : 0;
  const all = alliesOf(state, me);
  if (!all.length) return { ally: 0, why: 'No allies to ask: ally with a nation first' };
  const allies = all.filter((a) => !areAllied(state, a, target));
  if (!allies.length) return { ally: 0, why: `Your ${all.length > 1 ? 'allies are' : 'ally is'} allied with ${state.players[target]?.name ?? 'them'} too` };
  if (wait > 0) return { ally: 0, why: `You can ask your allies again in ${wait} s` };
  const free = allies.filter((a) => !state.allyRequests.some((r) => r.from === me && r.ally === a));
  if (!free.length) return { ally: 0, why: 'Your allies have not answered yet' };
  const score = (a: number) => (allyRefusal(state, a, me, 'attack', target) === null ? 2 : 0) + (warsOf(state, a).has(target) ? 1 : 0);
  free.sort((x, y) => score(y) - score(x) || state.players[y].tiles - state.players[x].tiles);
  return { ally: free[0], why: '' };
}

/** The two ally requests (sim actions requestAllyAttack / requestAllyAid). */
export function allyAttackAction(ally: number, target: number): Action {
  return { type: 'requestAllyAttack', ally, target };
}
export function allyAidAction(ally: number): Action {
  return { type: 'requestAllyAid', ally };
}

export type AllyEventKind = 'allyJoined' | 'allyAid' | 'allyRefused';
/** The ally news this client toasts. */
export function allyEventKind(e: GameEvent): AllyEventKind | null {
  const k = e.kind;
  return k === 'allyJoined' || k === 'allyAid' || k === 'allyRefused' ? k : null;
}
/** A coalition forming (or growing) against the leading nation: a coalition* event, or news that says so. */
export function isCoalitionEvent(e: GameEvent): boolean {
  const k: string = e.kind;
  return /^coalition/i.test(k) || (k === 'info' && /^coalition\b/i.test(e.message));
}
