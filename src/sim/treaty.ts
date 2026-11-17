// Peace deals and non-aggression pacts (DESIGN 8): offers, answers, terms paid at signing, breaking a pact, expiry.
// While a treaty runs nothing hostile passes between the two: rules.atPeace / peaceReason ask treatyBetween, and every
// attack, strike, shelling, landing and weapon checks those. Deterministic: reads and writes only the state.
import {
  PACT_BREAK_DELAY,
  PACT_BREAK_OPINION_OTHERS,
  PACT_BREAK_OPINION_VICTIM,
  PACT_BREAKER_DURATION,
  PACT_LENGTHS,
  PACT_RENEW_WINDOW,
  PEACE_DURATION,
  BUILDINGS,
  TICKS_PER_SECOND,
  TREATY_FIGHT_WINDOW,
  TREATY_OFFER_TIMEOUT,
  TREATY_REFUSAL_COOLDOWN,
  TREATY_TERMS_SPEC,
} from './config';
import { areAllied, changeOpinion, endAttacksBetween } from './diplomacy';
import { alliancesAllowed, formatSeconds, isTeamGame, noteFight, sameTeam, treatyBetween, treatySecondsLeft } from './rules';
import { addEvent, setOwner } from './state';
import { borderTiles } from './territory';
import { inOvertime } from './victory';
import { isTribe, TREATY_TERMS } from './types';
import type { ActionResult, GameState, Treaty, TreatyKind, TreatyOffer, TreatyTerm } from './types';

/** Answer of canOfferPeace / canOfferPact: ok, or a plain reason for the panel. */
export type TreatyCheck = { ok: true } | { ok: false; reason: string };
/** What a term would pay right now (previewTerms); absent fields = nothing of that. */
export interface TermPreview {
  gold?: number;
  tiles?: number;
  buildings?: number;
}
/** One active treaty of a player (activeTreaties). */
export interface TreatyInfo {
  kind: TreatyKind;
  other: number;
  secondsLeft: number;
  /** a broken pact in its last PACT_BREAK_DELAY seconds */
  breaking: boolean;
  /** who broke it (0 = nobody) */
  breaker: number;
}
/** One waiting offer (treatyOffersOf). */
export interface OfferInfo {
  kind: TreatyKind;
  from: number;
  to: number;
  /** from the offerer's side: theyGive = what `to` pays, youGive = what `from` pays */
  theyGive: TreatyTerm;
  youGive: TreatyTerm;
  /** pact length in seconds (0 for peace) */
  seconds: number;
  secondsLeft: number;
}

const T = TICKS_PER_SECOND;
const pairOf = (a: number, b: number): [number, number] => (a < b ? [a, b] : [b, a]);
const between = (o: { from: number; to: number }, a: number, b: number): boolean => (o.from === a && o.to === b) || (o.from === b && o.to === a);

// ------------------------------------------------------------------------------------------------ rules

function pairBad(state: GameState, a: number, b: number): string | null {
  const pa = state.players[a];
  const pb = state.players[b];
  if (!pa || !pb || a <= 0 || b <= 0) return 'No such nation';
  if (a === b) return 'Not with yourself';
  if (!pa.alive || !pb.alive) return 'That nation is gone';
  if (isTribe(pa) || isTribe(pb)) return 'Tribes make no treaties';
  return null;
}

/**
 * The rules both kinds share (null = a treaty between a and b is possible): no diplomacy modifier, team games (the
 * teams are fixed sides), the last two nations, the overtime leader (the same rules that stop alliances freezing the
 * end of a game), allies.
 */
export function treatyRule(state: GameState, a: number, b: number): string | null {
  const bad = pairBad(state, a, b);
  if (bad) return bad;
  if (!alliancesAllowed(state)) return 'No diplomacy in this game';
  if (sameTeam(state, a, b)) return 'Teammates are allied for the whole game';
  if (isTeamGame(state)) return 'Team game: the teams are fixed sides';
  if (state.phase !== 'playing') return 'The game has not started';
  let nations = 0;
  let leader = 0;
  for (const p of state.players) {
    if (p.id === 0 || !p.alive || isTribe(p)) continue;
    nations++;
    if (!leader || p.tiles > state.players[leader].tiles) leader = p.id;
  }
  if (nations <= 2) return 'Only 2 nations left';
  if (inOvertime(state) && (a === leader || b === leader)) return a === leader ? 'You lead in overtime: no treaties' : 'No treaties with the overtime leader';
  if (areAllied(state, a, b)) return 'Already allied';
  return null;
}

/** Tick of the last land attack between a and b (either way), or -1. */
export function lastFightTick(state: GameState, a: number, b: number): number {
  const f = state.fights;
  if (!f) return -1;
  const [lo, hi] = pairOf(a, b);
  for (let k = 0; k < f.length; k += 3) if (f[k] === lo && f[k + 1] === hi) return f[k + 2];
  return -1;
}
/** True when a land attack runs between a and b now or ran in the last TREATY_FIGHT_WINDOW seconds. */
export function fightingRecently(state: GameState, a: number, b: number): boolean {
  for (const at of state.attacks) if ((at.attacker === a && at.target === b) || (at.attacker === b && at.target === a)) return true;
  const t = lastFightTick(state, a, b);
  return t >= 0 && state.tick - t < TREATY_FIGHT_WINDOW * T;
}
/** Whole seconds before `from` may offer `to` a treaty again after a refusal (0 = may now). */
export function refusalSecondsLeft(state: GameState, from: number, to: number): number {
  const c = state.treatyCooldowns;
  if (!c) return 0;
  for (let k = 0; k < c.length; k += 3) {
    if (c[k] === from && c[k + 1] === to && c[k + 2] > state.tick) return Math.ceil((c[k + 2] - state.tick) / T);
  }
  return 0;
}

function offerBlock(state: GameState, a: number, b: number, kind: TreatyKind): string | null {
  const rule = treatyRule(state, a, b);
  if (rule) return rule;
  const t = treatyBetween(state, a, b);
  if (t) {
    if (t.breakTick > 0) return 'The pact is ending';
    if (kind === 'peace') return t.kind === 'peace' ? 'Already at peace with them' : 'Pact in place: no fighting';
    if (treatySecondsLeft(state, t) > PACT_RENEW_WINDOW) {
      return t.kind === 'peace' ? `Peace deal in place: offer a pact in its last ${PACT_RENEW_WINDOW} s` : `Pact in place: renew it in its last ${PACT_RENEW_WINDOW} s`;
    }
  }
  const offers = state.treatyOffers ?? [];
  if (offers.some((o) => o.from === a && o.to === b)) return 'Offer already sent';
  if (offers.some((o) => o.from === b && o.to === a)) return 'They sent you an offer: answer it first';
  const wait = refusalSecondsLeft(state, a, b);
  if (wait > 0) return `Wait ${wait} s after a refusal`;
  const fighting = fightingRecently(state, a, b);
  if (kind === 'peace' && !fighting) return 'Not fighting: offer a pact instead';
  if (kind === 'pact' && fighting) return 'Fighting: offer peace instead';
  return null;
}

/** UI hook: may `a` offer `b` a peace deal now? Pure (no state change). */
export function canOfferPeace(state: GameState, a: number, b: number): TreatyCheck {
  const why = offerBlock(state, a, b, 'peace');
  return why ? { ok: false, reason: why } : { ok: true };
}
/** UI hook: may `a` offer `b` a non-aggression pact (or renew one) now? Pure. */
export function canOfferPact(state: GameState, a: number, b: number): TreatyCheck {
  const why = offerBlock(state, a, b, 'pact');
  return why ? { ok: false, reason: why } : { ok: true };
}

// ------------------------------------------------------------------------------------------------ terms

const touches = (state: GameState, i: number, who: number): boolean => {
  const { width: w, owner } = state.map;
  const x = i % w;
  return (x > 0 && owner[i - 1] === who) || (x < w - 1 && owner[i + 1] === who) || (i >= w && owner[i - w] === who) || (i + w < owner.length && owner[i + w] === who);
};

/**
 * Land a payer hands over: its tiles within `depth` tiles of its border with the receiver (ring 1 = touching the
 * receiver's land), nearest ring first and by tile index inside a ring, at most `share` of its land, never its
 * capital. Pure.
 */
function landFor(state: GameState, payer: number, receiver: number, depth: number, share: number): number[] {
  const p = state.players[payer];
  const cap = Math.floor(p.tiles * share);
  const out: number[] = [];
  if (cap <= 0) return out;
  const { width: w, owner } = state.map;
  const size = owner.length;
  const { list, len } = borderTiles(state, payer);
  const seen = new Set<number>();
  let ring: number[] = [];
  for (let k = 0; k < len; k++) {
    const i = list[k];
    if (owner[i] !== payer || seen.has(i) || !touches(state, i, receiver)) continue;
    seen.add(i);
    ring.push(i);
  }
  for (let d = 1; d <= depth && ring.length; d++) {
    ring.sort((x, y) => x - y);
    for (const i of ring) {
      if (i === p.capital) continue;
      out.push(i);
      if (out.length >= cap) return out;
    }
    if (d === depth) break;
    const next: number[] = [];
    for (const i of ring) {
      const x = i % w;
      const around = [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, i - w, i + w];
      for (const j of around) {
        if (j < 0 || j >= size || owner[j] !== payer || seen.has(j)) continue;
        seen.add(j);
        next.push(j);
      }
    }
    ring = next;
  }
  return out;
}

function goldFor(state: GameState, payer: number, share: number): number {
  return Math.max(0, Math.floor(state.players[payer].gold * share));
}

function capturableOn(state: GameState, tiles: number[]): number {
  let n = 0;
  for (const t of tiles) {
    const b = state.buildings.get(state.map.building[t] - 1);
    if (b && BUILDINGS[b.type].capturable) n++;
  }
  return n;
}

/** UI hook: what `term` would make `payer` hand `receiver` if signed now (amounts are worked out at signing). Pure. */
export function previewTerms(state: GameState, payer: number, receiver: number, term: TreatyTerm): TermPreview {
  if (!state.players[payer] || !state.players[receiver] || term === 'none') return {};
  if (term === 'goldSmall' || term === 'goldLarge') return { gold: goldFor(state, payer, TREATY_TERMS_SPEC[term].gold) };
  if (term === 'landSmall' || term === 'landLarge') {
    const spec = TREATY_TERMS_SPEC[term];
    const tiles = landFor(state, payer, receiver, spec.depth, spec.share);
    return { tiles: tiles.length, buildings: capturableOn(state, tiles) };
  }
  return {};
}

/** Plain words for a term, as paid by `who` ("10% of their gold"). */
export function termWords(term: TreatyTerm, who = 'their'): string {
  switch (term) {
    case 'goldSmall':
      return `${Math.round(TREATY_TERMS_SPEC.goldSmall.gold * 100)}% of ${who} gold`;
    case 'goldLarge':
      return `${Math.round(TREATY_TERMS_SPEC.goldLarge.gold * 100)}% of ${who} gold`;
    case 'landSmall':
      return `border land (up to ${Math.round(TREATY_TERMS_SPEC.landSmall.share * 100)}% of ${who} land)`;
    case 'landLarge':
      return `a wide strip of border land (up to ${Math.round(TREATY_TERMS_SPEC.landLarge.share * 100)}% of ${who} land)`;
    default:
      return 'nothing';
  }
}

/** Pays a term at signing; returns the words for the news ('' = nothing paid). Buildings change hands as in a capture. */
function payTerm(state: GameState, payer: number, receiver: number, term: TreatyTerm): string {
  const pn = state.players[payer].name;
  if (term === 'goldSmall' || term === 'goldLarge') {
    const gold = goldFor(state, payer, TREATY_TERMS_SPEC[term].gold);
    if (gold <= 0) return '';
    state.players[payer].gold -= gold;
    state.players[receiver].gold += gold;
    return `${pn} paid ${gold} gold`;
  }
  if (term === 'landSmall' || term === 'landLarge') {
    const spec = TREATY_TERMS_SPEC[term];
    const tiles = landFor(state, payer, receiver, spec.depth, spec.share);
    if (!tiles.length) return '';
    const buildings = capturableOn(state, tiles);
    for (const t of tiles) setOwner(state, t, receiver);
    return `${pn} handed over ${tiles.length} tiles${buildings ? ` with ${buildings} building${buildings === 1 ? '' : 's'}` : ''}`;
  }
  return '';
}

// ------------------------------------------------------------------------------------------------ actions

function pushOffer(state: GameState, o: Omit<TreatyOffer, 'expiresTick'>): void {
  (state.treatyOffers ??= []).push({ ...o, expiresTick: state.tick + TREATY_OFFER_TIMEOUT * T });
}

/** Action offerPeace: terms from the offerer's side (theyGive = what `to` pays, youGive = what `from` pays). */
export function offerPeace(state: GameState, from: number, to: number, theyGive: TreatyTerm, youGive: TreatyTerm): ActionResult {
  if (!TREATY_TERMS.includes(theyGive) || !TREATY_TERMS.includes(youGive)) return { ok: false, reason: 'Unknown terms' };
  const why = offerBlock(state, from, to, 'peace');
  if (why) return { ok: false, reason: why };
  pushOffer(state, { from, to, kind: 'peace', theyGive, youGive, seconds: 0 });
  const fn = state.players[from].name;
  addEvent(state, 'treatyOffer', `${fn} offers peace for ${formatSeconds(PEACE_DURATION)}: they give ${termWords(youGive)}, you give ${termWords(theyGive, 'your')}`, [to], -1);
  return { ok: true };
}

/** Action offerPact: a non-aggression pact of `seconds` (one of PACT_LENGTHS), or its renewal in the last minute. */
export function offerPact(state: GameState, from: number, to: number, seconds: number): ActionResult {
  if (!PACT_LENGTHS.includes(seconds)) return { ok: false, reason: 'Unknown pact length' };
  const why = offerBlock(state, from, to, 'pact');
  if (why) return { ok: false, reason: why };
  pushOffer(state, { from, to, kind: 'pact', theyGive: 'none', youGive: 'none', seconds });
  const renew = treatyBetween(state, from, to)?.kind === 'pact';
  const fn = state.players[from].name;
  addEvent(state, 'treatyOffer', renew ? `${fn} asks to renew your pact for ${formatSeconds(seconds)}` : `${fn} offers a ${formatSeconds(seconds)} non-aggression pact`, [to], -1);
  return { ok: true };
}

/** Action answerTreaty: accept (sign now, terms paid) or refuse (the offerer must wait TREATY_REFUSAL_COOLDOWN s). */
export function answerTreaty(state: GameState, playerId: number, from: number, accept: boolean): ActionResult {
  const offers = state.treatyOffers ?? [];
  const k = offers.findIndex((o) => o.from === from && o.to === playerId);
  if (k < 0) return { ok: false, reason: 'No such offer' };
  const o = offers[k];
  offers.splice(k, 1);
  const what = o.kind === 'peace' ? 'peace offer' : 'pact offer';
  const bad = pairBad(state, from, playerId);
  if (bad) return { ok: false, reason: bad };
  if (!accept) {
    const c = (state.treatyCooldowns ??= []);
    for (let j = 0; j < c.length; j += 3) {
      if (c[j] === from && c[j + 1] === playerId) {
        c.splice(j, 3);
        break;
      }
    }
    c.push(from, playerId, state.tick + TREATY_REFUSAL_COOLDOWN * T);
    changeOpinion(state, from, playerId, -5);
    addEvent(state, 'treatyRefused', `${state.players[playerId].name} refused the ${what} of ${state.players[from].name}`, [from, playerId], -1);
    return { ok: true };
  }
  const rule = treatyRule(state, from, playerId);
  if (rule) return { ok: false, reason: rule };
  const t = treatyBetween(state, from, playerId);
  if (t && (t.breakTick > 0 || (o.kind === 'peace' && t.kind === 'peace'))) return { ok: false, reason: t.breakTick > 0 ? 'The pact is ending' : 'Already at peace with them' };
  sign(state, o);
  return { ok: true };
}

function sign(state: GameState, o: TreatyOffer): void {
  const [a, b] = pairOf(o.from, o.to);
  const renewed = state.treaties?.some((t) => t.a === a && t.b === b && t.kind === 'pact' && t.endTick > state.tick) ?? false;
  const kept = (state.treaties ?? []).filter((t) => !(t.a === a && t.b === b));
  const seconds = o.kind === 'peace' ? PEACE_DURATION : o.seconds;
  kept.push({ a, b, kind: o.kind, endTick: state.tick + seconds * T, breakTick: 0, breaker: 0 });
  state.treaties = kept;
  if (state.treatyOffers) state.treatyOffers = state.treatyOffers.filter((x) => !between(x, a, b));
  const fn = state.players[o.from].name;
  const tn = state.players[o.to].name;
  changeOpinion(state, o.from, o.to, 5);
  changeOpinion(state, o.to, o.from, 5);
  if (o.kind === 'pact') {
    const msg = renewed ? `${fn} and ${tn} renewed their pact for ${formatSeconds(seconds)}` : `${fn} and ${tn} signed a ${formatSeconds(seconds)} non-aggression pact`;
    addEvent(state, 'treatyAccepted', msg, [o.from, o.to], -1);
    return;
  }
  // Peace: every attack between them ends now (troops home); landings in progress turn back when they arrive
  // (units.ts), missiles already flying still fall.
  endAttacksBetween(state, o.from, o.to);
  const paid = [payTerm(state, o.from, o.to, o.youGive), payTerm(state, o.to, o.from, o.theyGive)].filter(Boolean);
  const tail = paid.length ? `. ${paid.join('; ')}` : '';
  addEvent(state, 'treatyAccepted', `${fn} and ${tn} made peace for ${formatSeconds(seconds)}${tail}`, [o.from, o.to], -1);
}

/** Action breakPact: the pact still holds PACT_BREAK_DELAY s (the victim is warned), then ends; the breaker is marked. */
export function breakPact(state: GameState, playerId: number, other: number): ActionResult {
  const t = treatyBetween(state, playerId, other);
  if (!t) return { ok: false, reason: 'No pact with them' };
  if (t.kind === 'peace') return { ok: false, reason: `A peace deal can't be broken: ${formatSeconds(treatySecondsLeft(state, t))} left` };
  if (t.breakTick > 0) return { ok: false, reason: 'The pact is already ending' };
  t.breakTick = state.tick;
  t.breaker = playerId;
  t.endTick = Math.min(t.endTick, state.tick + PACT_BREAK_DELAY * T);
  if (state.treatyOffers) state.treatyOffers = state.treatyOffers.filter((x) => !between(x, playerId, other));
  const p = state.players[playerId];
  p.pactBreakerUntil = state.tick + PACT_BREAKER_DURATION * T;
  changeOpinion(state, other, playerId, -PACT_BREAK_OPINION_VICTIM);
  for (const q of state.players) {
    if (q.id === 0 || q.id === playerId || q.id === other || !q.alive) continue;
    changeOpinion(state, q.id, playerId, -PACT_BREAK_OPINION_OTHERS);
  }
  const left = formatSeconds(treatySecondsLeft(state, t));
  addEvent(state, 'pactBreakWarning', `${p.name} broke the pact with ${state.players[other].name}: attacks are possible in ${left}`, [other, playerId], -1);
  return { ok: true };
}

/** True while a player is marked as a pact breaker. */
export function isPactBreaker(state: GameState, playerId: number): boolean {
  return (state.players[playerId]?.pactBreakerUntil ?? 0) > state.tick;
}

// ------------------------------------------------------------------------------------------------ reads for the UI

/** UI hook: the player's active treaties, soonest end first. Pure. */
export function activeTreaties(state: GameState, player: number): TreatyInfo[] {
  const out: TreatyInfo[] = [];
  for (const t of state.treaties ?? []) {
    if (t.endTick <= state.tick || (t.a !== player && t.b !== player)) continue;
    out.push({ kind: t.kind, other: t.a === player ? t.b : t.a, secondsLeft: treatySecondsLeft(state, t), breaking: t.breakTick > 0, breaker: t.breaker });
  }
  return out.sort((x, y) => x.secondsLeft - y.secondsLeft || x.other - y.other);
}
/** UI hook: offers waiting for an answer that the player sent or received. Pure. */
export function treatyOffersOf(state: GameState, player: number): OfferInfo[] {
  const out: OfferInfo[] = [];
  for (const o of state.treatyOffers ?? []) {
    if (o.expiresTick <= state.tick || (o.from !== player && o.to !== player)) continue;
    out.push({ kind: o.kind, from: o.from, to: o.to, theyGive: o.theyGive, youGive: o.youGive, seconds: o.seconds, secondsLeft: Math.ceil((o.expiresTick - state.tick) / T) });
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ every tick

function treatyEndMessage(state: GameState, t: Treaty): string {
  const an = state.players[t.a].name;
  const bn = state.players[t.b].name;
  if (t.breakTick > 0) return `The pact of ${an} and ${bn} is over: ${state.players[t.breaker]?.name ?? 'one side'} broke it`;
  return t.kind === 'peace' ? `The peace between ${an} and ${bn} is over` : `The pact of ${an} and ${bn} has ended`;
}

/** Offers run out, treaties end, fights are remembered. Called every tick from sim.ts (after the attacks). */
export function updateTreaties(state: GameState): void {
  const t = state.tick;
  const alive = (id: number): boolean => !!state.players[id]?.alive;
  if (state.treatyOffers?.length) {
    const kept: TreatyOffer[] = [];
    for (const o of state.treatyOffers) {
      if (!alive(o.from) || !alive(o.to)) continue;
      if (o.expiresTick > t) {
        kept.push(o);
        continue;
      }
      const what = o.kind === 'peace' ? 'peace offer' : 'pact offer';
      addEvent(state, 'treatyOfferExpired', `${state.players[o.to].name} did not answer the ${what} of ${state.players[o.from].name}`, [o.from, o.to], -1);
    }
    if (kept.length !== state.treatyOffers.length) state.treatyOffers = kept;
  }
  if (state.treaties?.length) {
    const kept: Treaty[] = [];
    for (const tr of state.treaties) {
      if (!alive(tr.a) || !alive(tr.b)) continue;
      if (tr.endTick > t) {
        kept.push(tr);
        continue;
      }
      addEvent(state, tr.breakTick > 0 ? 'pactBroken' : 'treatyEnded', treatyEndMessage(state, tr), [tr.a, tr.b], -1);
    }
    if (kept.length !== state.treaties.length) state.treaties = kept;
  }
  if (t % T !== 0) return;
  // Once per second: remember who fights whom (peace deals need a fight in the last minute), forget old fights and
  // cooldowns.
  for (const at of state.attacks) {
    if (at.target <= 0 || at.attacker <= 0) continue;
    const tr = at.troops;
    if (tr.infantry + tr.armor + tr.artillery > 0) noteFight(state, at.attacker, at.target);
  }
  const f = state.fights;
  if (f?.length) {
    const keep: number[] = [];
    for (let k = 0; k < f.length; k += 3) {
      if (t - f[k + 2] < TREATY_FIGHT_WINDOW * T && alive(f[k]) && alive(f[k + 1])) keep.push(f[k], f[k + 1], f[k + 2]);
    }
    if (keep.length !== f.length) state.fights = keep;
  }
  const c = state.treatyCooldowns;
  if (c?.length) {
    const keep: number[] = [];
    for (let k = 0; k < c.length; k += 3) if (c[k + 2] > t) keep.push(c[k], c[k + 1], c[k + 2]);
    if (keep.length !== c.length) state.treatyCooldowns = keep;
  }
}
