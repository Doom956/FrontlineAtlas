// Allies that do things, and coalitions against a runaway leader (DESIGN 9.2).
//
// - Requests: a player asks an ally to attack a nation (Action requestAllyAttack) or to send troops
//   (requestAllyAid). An AI ally answers on its next decision (ai.ts answerAllyRequests): yes (allyJoined / allyAid
//   event, and it really attacks or sends troops) or no with a reason (allyRefused). A human ally only gets a note.
//   One request per player every ALLY_REQUEST_COOLDOWN seconds; one pending request per ally.
// - Pledges: an ally fighting a nation for a friend (asked, or joined on its own) keeps that war going for
//   ALLY_PLEDGE_SECONDS (ai.ts ranks pledged wars first).
// - Coalitions: once one nation holds COALITION_LAND_SHARE of the land and COALITION_LEAD x the next one, the nations
//   it threatens band together against it (ai.ts: alliances, war targets; the leader's requests are refused).
// Everything here is sim state (hash.ts) changed only through applyAction and the tick, so multiplayer stays in sync.
import {
  ALLY_AID_DANGER,
  ALLY_AID_GOLD_SECONDS,
  ALLY_AID_MAX_SHARE,
  ALLY_AID_SHARE,
  ALLY_HELP_MIN_OPINION,
  ALLY_JOIN_MIN_STRENGTH,
  ALLY_PLEDGE_SECONDS,
  ALLY_REQUEST_COOLDOWN,
  ALLY_REQUEST_TIMEOUT,
  ALLY_WILLINGNESS,
  COALITION_ALL_SHARE,
  COALITION_LAND_SHARE,
  COALITION_LEAD,
  MIN_ATTACK_TROOPS,
  TICKS_PER_SECOND,
} from './config';
import { borders, wholeArmy } from './combat';
import { areAllied, changeOpinion } from './diplomacy';
import { atPeace, sameTeam } from './rules';
import { addEvent } from './state';
import { isTribe } from './types';
import type { ActionResult, AllyPledge, GameState, Player } from './types';

const FAIL = (reason: string): ActionResult => ({ ok: false, reason });

function total(t: { infantry: number; armor: number; artillery: number }): number {
  return t.infantry + t.armor + t.artillery;
}
function isNation(p: Player | undefined): p is Player {
  return !!p && p.id > 0 && p.alive && p.spawned && !isTribe(p);
}
/** "120k", "1.2M": troop counts for event texts. */
export function fmtTroops(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}k`;
  return String(Math.round(n));
}

// ---------------------------------------------------------------------------------------------------------------
// Coalitions
// ---------------------------------------------------------------------------------------------------------------

const leaderCache = new WeakMap<GameState, { tick: number; leader: number; share: number }>();

function leaderInfo(state: GameState): { leader: number; share: number } {
  const c = leaderCache.get(state);
  if (c && c.tick === state.tick) return c;
  let best = 0;
  let bestTiles = 0;
  let second = 0;
  for (const p of state.players) {
    if (!isNation(p)) continue;
    if (p.tiles > bestTiles) {
      second = bestTiles;
      bestTiles = p.tiles;
      best = p.id;
    } else if (p.tiles > second) second = p.tiles;
  }
  const share = bestTiles / Math.max(1, state.map.landTileCount);
  const leader = best > 0 && share >= COALITION_LAND_SHARE && bestTiles >= second * COALITION_LEAD ? best : 0;
  const out = { tick: state.tick, leader, share };
  leaderCache.set(state, out);
  return out;
}

/** The runaway leader (config COALITION_*), or 0 when no nation is far enough ahead. Humans count too. */
export function runawayLeader(state: GameState): number {
  return leaderInfo(state).leader;
}

/** True when nation `id` feels threatened by the runaway leader: it borders it, or the leader is huge. */
export function inCoalition(state: GameState, id: number): boolean {
  const { leader, share } = leaderInfo(state);
  if (!leader || id === leader || !isNation(state.players[id]) || sameTeam(state, id, leader)) return false;
  return share >= COALITION_ALL_SHARE || borders(state, id, leader);
}

/** True when a and b are at war (either attacks the other). */
export function atWar(state: GameState, a: number, b: number): boolean {
  for (const at of state.attacks) {
    if ((at.attacker === a && at.target === b) || (at.attacker === b && at.target === a)) {
      if (total(at.troops) > 0) return true;
    }
  }
  return false;
}

/** Nations (not tribes) `id` is attacking or being attacked by, sorted by id. */
export function warsOf(state: GameState, id: number): number[] {
  const out = new Set<number>();
  for (const a of state.attacks) {
    if (total(a.troops) <= 0) continue;
    const other = a.attacker === id ? a.target : a.target === id ? a.attacker : 0;
    if (other > 0 && !isTribe(state.players[other])) out.add(other);
  }
  return [...out].sort((x, y) => x - y);
}

// ---------------------------------------------------------------------------------------------------------------
// Requests (Actions)
// ---------------------------------------------------------------------------------------------------------------

function checkAsk(state: GameState, from: number, ally: number): string | null {
  const p = state.players[from];
  const a = state.players[ally];
  if (!a || ally === 0 || ally === from) return 'No such ally';
  if (!a.alive || !a.spawned) return 'That nation is gone';
  if (!areAllied(state, from, ally)) return `${a.name} is not your ally`;
  if (p.allyAskTick > state.tick) return `Wait ${Math.ceil((p.allyAskTick - state.tick) / TICKS_PER_SECOND)} s before asking your allies again`;
  if (state.allyRequests.some((r) => r.from === from && r.ally === ally)) return `${a.name} has not answered your last request yet`;
  return null;
}

/** Action requestAllyAttack: ask `ally` to attack `target` (an AI answers on its next decision). */
export function requestAllyAttack(state: GameState, from: number, ally: number, target: number): ActionResult {
  const bad = checkAsk(state, from, ally);
  if (bad) return FAIL(bad);
  const t = state.players[target];
  if (!t || target === 0 || !t.alive || !t.spawned) return FAIL('No such nation to attack');
  if (target === from) return FAIL('You cannot ask for an attack on yourself');
  if (target === ally) return FAIL('You cannot ask an ally to attack itself');
  if (areAllied(state, from, target)) return FAIL(`${t.name} is your ally`);
  const p = state.players[from];
  const a = state.players[ally];
  p.allyAskTick = state.tick + ALLY_REQUEST_COOLDOWN * TICKS_PER_SECOND;
  if (a.isHuman) {
    addEvent(state, 'info', `${p.name} asks you to attack ${t.name}`, [ally], t.capital);
    return { ok: true };
  }
  state.allyRequests.push({ from, ally, kind: 'attack', target, expiresTick: state.tick + ALLY_REQUEST_TIMEOUT * TICKS_PER_SECOND });
  return { ok: true };
}

/** Action requestAllyAid: ask `ally` for troops (or gold). */
export function requestAllyAid(state: GameState, from: number, ally: number): ActionResult {
  const bad = checkAsk(state, from, ally);
  if (bad) return FAIL(bad);
  const p = state.players[from];
  const a = state.players[ally];
  p.allyAskTick = state.tick + ALLY_REQUEST_COOLDOWN * TICKS_PER_SECOND;
  if (a.isHuman) {
    addEvent(state, 'info', `${p.name} asks you for troops`, [ally], p.capital);
    return { ok: true };
  }
  state.allyRequests.push({ from, ally, kind: 'aid', target: 0, expiresTick: state.tick + ALLY_REQUEST_TIMEOUT * TICKS_PER_SECOND });
  return { ok: true };
}

/** "Valoria says no: <reason>" to the asker (and the ally). */
export function refuse(state: GameState, ally: number, from: number, reason: string): void {
  const a = state.players[ally];
  addEvent(state, 'allyRefused', `${a.name} refused: ${reason}`, [from, ally], -1);
}

// ---------------------------------------------------------------------------------------------------------------
// Pledges, joins and aid (the AI decides when; these do the bookkeeping and the events)
// ---------------------------------------------------------------------------------------------------------------

/** Records (or extends) `helper` fighting `target` for `friend`. */
export function pledge(state: GameState, helper: number, friend: number, target: number): void {
  const until = state.tick + ALLY_PLEDGE_SECONDS * TICKS_PER_SECOND;
  const ex = state.allyPledges.find((p) => p.helper === helper && p.friend === friend && p.target === target);
  if (ex) ex.untilTick = Math.max(ex.untilTick, until);
  else state.allyPledges.push({ helper, friend, target, untilTick: until });
}

/** Live pledges of `helper` (targets it promised to fight). */
export function pledgesOf(state: GameState, helper: number): AllyPledge[] {
  return state.allyPledges.filter((p) => p.helper === helper && p.untilTick > state.tick);
}

/** True when helper already pledged to fight target (for anyone). */
export function pledgedAgainst(state: GameState, helper: number, target: number): boolean {
  return state.allyPledges.some((p) => p.helper === helper && p.target === target && p.untilTick > state.tick);
}

/** allyJoined event: "Valoria joins your war against Tarsis". */
export function announceJoin(state: GameState, helper: number, friend: number, target: number): void {
  const h = state.players[helper];
  const f = state.players[friend];
  const t = state.players[target];
  const whose = f.isHuman ? 'your' : `${f.name}'s`;
  addEvent(state, 'allyJoined', `${h.name} joins ${whose} war against ${t.name}`, [friend, helper], t.capital);
}

/**
 * Sends aid from helper to friend: infantry (ALLY_AID_SHARE of the helper's infantry, keeping half its cap at home),
 * and gold when it has few troops to spare or is a merchant. Returns what was sent (nothing: null). allyAid event.
 */
export function sendAllyAid(state: GameState, helper: number, friend: number): { troops: number; gold: number } | null {
  const h = state.players[helper];
  const f = state.players[friend];
  if (!h || !f || !h.alive || !f.alive) return null;
  const will = ALLY_WILLINGNESS[h.personality ?? 'balanced'] ?? 1;
  const keep = Math.max(0, h.maxPop * 0.5);
  const spare = Math.max(0, h.troops.infantry - Math.max(0, keep - h.troops.armor - h.troops.artillery));
  let troops = Math.floor(Math.min(h.troops.infantry * ALLY_AID_SHARE * Math.min(1.25, will), h.troops.infantry * ALLY_AID_MAX_SHARE, spare));
  if (troops < MIN_ATTACK_TROOPS * 10) troops = 0;
  let gold = 0;
  if (troops === 0 || h.personality === 'merchant') gold = Math.floor(Math.min(h.gold * 0.4, Math.max(0, h.income.gold) * ALLY_AID_GOLD_SECONDS));
  if (gold < 100) gold = 0;
  if (troops === 0 && gold === 0) return null;
  h.troops.infantry -= troops;
  f.troops.infantry += troops;
  h.gold -= gold;
  f.gold += gold;
  changeOpinion(state, friend, helper, 10);
  const parts = [troops > 0 ? `${fmtTroops(troops)} troops` : '', gold > 0 ? `${fmtTroops(gold)} gold` : ''].filter(Boolean).join(' and ');
  addEvent(state, 'allyAid', `${h.name} sent ${f.isHuman ? 'you' : f.name} ${parts}`, [friend, helper], f.capital);
  return { troops, gold };
}

// ---------------------------------------------------------------------------------------------------------------
// Why an AI ally would say no (shared by the AI's answers and allyStatus)
// ---------------------------------------------------------------------------------------------------------------

/** Opinion an AI needs of a friend before it helps it (by personality). */
export function helpOpinionNeeded(p: Player): number {
  const will = ALLY_WILLINGNESS[p.personality ?? 'balanced'] ?? 1;
  return ALLY_HELP_MIN_OPINION + 20 * (1 - will);
}

/** Troops attacking `id` right now (all attackers). */
export function incomingTroops(state: GameState, id: number): number {
  let n = 0;
  for (const a of state.attacks) if (a.target === id) n += total(a.troops);
  return n;
}

/** True when `friend` is losing badly: incoming troops well above its army at home. */
export function losingBadly(state: GameState, friend: number): boolean {
  const f = state.players[friend];
  if (!f?.alive) return false;
  const inc = incomingTroops(state, friend);
  return inc > MIN_ATTACK_TROOPS * 10 && inc > ALLY_AID_DANGER * Math.max(1, total(f.troops));
}

/**
 * Why AI `ally` would refuse a request from `from` now ('attack' on `target`, 'aid', or 'any' = in general), or null
 * when it would help. Does not cover reaching the target (the AI checks its front when it answers).
 */
export function allyRefusal(state: GameState, ally: number, from: number, kind: 'attack' | 'aid' | 'any', target = 0): string | null {
  const a = state.players[ally];
  const f = state.players[from];
  if (!a || !f || !a.alive || !f.alive) return 'it is gone';
  if (!areAllied(state, ally, from)) return 'you are not allies';
  if (isTribe(a)) return kind === 'aid' ? 'a tribe has nothing to spare' : 'a tribe does not go to war';
  if (a.isHuman) return 'players decide for themselves';
  const op = state.opinion[ally]?.[from] ?? 0;
  if (op < helpOpinionNeeded(a)) return `it does not trust ${f.isHuman ? 'you' : f.name} enough`;
  const home = total(a.troops);
  const inc = incomingTroops(state, ally);
  if (inc > home * 0.8 && inc > MIN_ATTACK_TROOPS * 10) return 'it is fighting for its own survival';
  if (home < Math.max(MIN_ATTACK_TROOPS * 20, a.maxPop * 0.15)) return 'it has no troops to spare';
  if (kind === 'aid') {
    if (!losingBadly(state, from) && inc <= 0 && total(f.troops) > f.maxPop * 0.5 && incomingTroops(state, from) <= 0) {
      return `${f.isHuman ? 'you have' : `${f.name} has`} enough troops`;
    }
    return null;
  }
  if (kind === 'attack') {
    const t = state.players[target];
    if (!t || !t.alive) return 'that nation is gone';
    if (areAllied(state, ally, target)) return `it is allied with ${t.name}`;
    if (atPeace(state, ally, target)) return 'it is peace time';
    if ((state.opinion[ally]?.[target] ?? 0) > 40 && runawayLeader(state) !== target) return `it is on good terms with ${t.name}`;
    if (!borders(state, ally, target)) return `it has no border with ${t.name}`;
    const busy = atWar(state, target, from) || warsOf(state, target).length > 1;
    const need = ALLY_JOIN_MIN_STRENGTH * (busy ? 0.6 : 1);
    if (!isTribe(t) && wholeArmy(state, ally) < wholeArmy(state, target) * need) return `it is too weak to take on ${t.name}`;
  }
  return null;
}

export interface AllyStatus {
  /** how the ally feels about pid, -100..100 */
  opinion: number;
  /** nations (not tribes) the ally is at war with, by id */
  atWarWith: number[];
  /** whether it would answer a request with yes right now (in general; a target may still be out of reach) */
  willHelp: boolean;
  /** why not, or what it is ready for */
  reason: string;
  /** seconds until pid may ask its allies again (0 = now) */
  askReadyIn: number;
}

/** For the UI: how ally feels about pid, its wars, and whether it would help now (with the reason). */
export function allyStatus(state: GameState, pid: number, ally: number): AllyStatus {
  const a = state.players[ally];
  const p = state.players[pid];
  const opinion = Math.round(state.opinion[ally]?.[pid] ?? 0);
  const atWarWith = a ? warsOf(state, ally) : [];
  const askReadyIn = p ? Math.max(0, Math.ceil((p.allyAskTick - state.tick) / TICKS_PER_SECOND)) : 0;
  if (!a || !p) return { opinion, atWarWith, willHelp: false, reason: 'No such nation', askReadyIn };
  const why = allyRefusal(state, ally, pid, 'any');
  if (why) return { opinion, atWarWith, willHelp: false, reason: `${a.name}: ${why}`, askReadyIn };
  return { opinion, atWarWith, willHelp: true, reason: `${a.name} is ready to help`, askReadyIn };
}

// ---------------------------------------------------------------------------------------------------------------
// Upkeep (once per second)
// ---------------------------------------------------------------------------------------------------------------

/** Drops finished pledges and expired requests (an expired request is refused: no answer). */
export function updateAllies(state: GameState): void {
  if (state.tick % TICKS_PER_SECOND !== 0) return;
  const t = state.tick;
  if (state.allyPledges.length) {
    state.allyPledges = state.allyPledges.filter((p) => {
      if (p.untilTick <= t) return false;
      const h = state.players[p.helper];
      const tg = state.players[p.target];
      return !!h?.alive && !!tg?.alive && state.players[p.friend]?.alive && areAllied(state, p.helper, p.friend) && !areAllied(state, p.helper, p.target);
    });
  }
  if (state.allyRequests.length) {
    const kept = [];
    for (const r of state.allyRequests) {
      if (r.expiresTick > t && state.players[r.ally]?.alive && state.players[r.from]?.alive) {
        kept.push(r);
        continue;
      }
      if (state.players[r.from]?.alive && state.players[r.ally]) refuse(state, r.ally, r.from, 'no answer');
    }
    state.allyRequests = kept;
  }
}
