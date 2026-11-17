// Peace deals and non-aggression pacts (treaty.ts): offers, answers, terms, breaking, the rules, the AI, the hash.
import { describe, expect, it } from 'vitest';
import { applyAction } from '../src/sim/actions';
import { aiWantsTreaty } from '../src/sim/ai';
import { canBarrage } from '../src/sim/barrage';
import { markBuildingsChanged } from '../src/sim/buildings';
import {
  BARRAGE_MIN_ARTILLERY,
  PACT_BREAK_DELAY,
  PACT_BREAKER_DURATION,
  PEACE_DURATION,
  TICKS_PER_SECOND,
  TREATY_FIGHT_WINDOW,
  TREATY_OFFER_TIMEOUT,
} from '../src/sim/config';
import { formAlliance } from '../src/sim/diplomacy';
import { hashState } from '../src/sim/hash';
import { computeCoastAndLand } from '../src/sim/mapgen';
import { atWar, clearNavyCache, updateWarMemory } from '../src/sim/naval2';
import { atPeace, noteFight, peaceReason } from '../src/sim/rules';
import { tick } from '../src/sim/sim';
import { newId } from '../src/sim/state';
import { activeTreaties, canOfferPact, canOfferPeace, isPactBreaker, previewTerms, treatyOffersOf, updateTreaties } from '../src/sim/treaty';
import { launchMissile, launchTransport, updateUnits } from '../src/sim/units';
import { Terrain } from '../src/sim/types';
import type { Action, Building, BuildingType, GameState, TreatyOffer, Troops } from '../src/sim/types';
import { validateAction } from '../server/validate';
import { claimRect, makeFlatGame, makeTestGame } from './helpers';

const T = TICKS_PER_SECOND;
const inf = (n: number): Troops => ({ infantry: n, armor: 0, artillery: 0 });
const at = (s: GameState, x: number, y: number): number => y * s.map.width + x;
const act = (s: GameState, id: number, a: Action) => applyAction(s, id, a);

/**
 * 60 x 20 plains, four nations, late in the game (no peace time): 1 = x 0..19 (borders 2 and 3), 2 = x 20..39 rows
 * 0..9, 3 = x 20..39 rows 10..19, 4 = x 40..59 (borders 2 and 3).
 */
function world(human = false): GameState {
  const s = makeFlatGame(60, 20, 4, { human });
  claimRect(s, 1, 0, 0, 19, 19);
  claimRect(s, 2, 20, 0, 39, 9);
  claimRect(s, 3, 20, 10, 39, 19);
  claimRect(s, 4, 40, 0, 59, 19);
  s.tick = 10 * 60 * T;
  s.playStartTick = 0;
  for (const p of s.players) if (p.id > 0) p.gold = 10000;
  return s;
}
function addBuilding(s: GameState, type: BuildingType, owner: number, tile: number): Building {
  const id = newId(s);
  const b: Building = { id, type, owner, tile, level: 1, buildLeft: 0, upgradeLeft: 0, fighters: 0, bombers: 0, cooldown: 0, dropCooldown: 0, disabledUntil: 0, hp: 1, queuedLevels: 0 };
  s.buildings.set(id, b);
  s.map.building[tile] = id + 1;
  markBuildingsChanged(s);
  return b;
}
/** 1 attacks 2 for real (a land attack across their border). */
function fight12(s: GameState): void {
  s.players[1].troops = inf(50000);
  expect(act(s, 1, { type: 'attack', tile: at(s, 20, 5), troops: inf(5000) }).ok).toBe(true);
}
function signPeace(s: GameState, from: number, to: number, theyGive: TreatyOffer['theyGive'] = 'none', youGive: TreatyOffer['youGive'] = 'none'): void {
  expect(act(s, from, { type: 'offerPeace', to, theyGive, youGive })).toEqual({ ok: true });
  expect(act(s, to, { type: 'answerTreaty', from, accept: true })).toEqual({ ok: true });
}
function advance(s: GameState, seconds: number): void {
  s.tick += seconds * T;
  updateTreaties(s);
}

describe('peace deals', () => {
  it('needs a fight in the last minute; offer, accept: attacks end, gold paid, 3 min of peace', () => {
    const s = world();
    expect(canOfferPeace(s, 2, 1)).toEqual({ ok: false, reason: 'Not fighting: offer a pact instead' });
    fight12(s);
    expect(canOfferPeace(s, 2, 1)).toEqual({ ok: true });
    expect(canOfferPact(s, 2, 1)).toEqual({ ok: false, reason: 'Fighting: offer peace instead' });
    expect(act(s, 2, { type: 'offerPeace', to: 1, theyGive: 'none', youGive: 'goldSmall' }).ok).toBe(true);
    const ev = s.events.at(-1)!;
    expect(ev.kind).toBe('treatyOffer');
    expect(ev.players).toEqual([1]);
    expect(treatyOffersOf(s, 1)).toHaveLength(1);
    expect(canOfferPeace(s, 2, 1).ok).toBe(false); // one offer at a time
    expect(canOfferPeace(s, 1, 2)).toEqual({ ok: false, reason: 'They sent you an offer: answer it first' });
    s.players[2].gold = 20000; // amounts are worked out at signing, not when offered
    const home = s.players[1].troops.infantry;
    expect(act(s, 1, { type: 'answerTreaty', from: 2, accept: true })).toEqual({ ok: true });
    expect(s.attacks.some((a) => a.attacker === 1 && a.target === 2)).toBe(false);
    expect(s.players[1].troops.infantry).toBeGreaterThan(home); // the attackers came home
    expect(s.players[2].gold).toBe(18000);
    expect(s.players[1].gold).toBe(12000);
    expect(s.events.at(-1)!.kind).toBe('treatyAccepted');
    expect(activeTreaties(s, 1)).toEqual([{ kind: 'peace', other: 2, secondsLeft: PEACE_DURATION, breaking: false, breaker: 0 }]);
    expect(atPeace(s, 1, 2)).toBe(true);
    expect(peaceReason(s, 1, 2)).toBe('Peace with AI 2: 3 min left');
    advance(s, 20);
    expect(peaceReason(s, 2, 1)).toBe('Peace with AI 1: 2 min 40 s left');
    expect(act(s, 1, { type: 'breakPact', with: 2 })).toEqual({ ok: false, reason: "A peace deal can't be broken: 2 min 40 s left" });
    advance(s, PEACE_DURATION - 20);
    expect(s.events.at(-1)!.kind).toBe('treatyEnded');
    expect(atPeace(s, 1, 2)).toBe(false);
  });

  it('refuse: the offerer waits a minute; an unanswered offer runs out', () => {
    const s = world();
    fight12(s);
    expect(act(s, 2, { type: 'offerPeace', to: 1, theyGive: 'none', youGive: 'none' }).ok).toBe(true);
    expect(act(s, 1, { type: 'answerTreaty', from: 2, accept: false })).toEqual({ ok: true });
    expect(s.events.at(-1)!.kind).toBe('treatyRefused');
    expect(canOfferPeace(s, 2, 1)).toEqual({ ok: false, reason: 'Wait 60 s after a refusal' });
    s.tick += 18 * T;
    expect(canOfferPeace(s, 2, 1)).toEqual({ ok: false, reason: 'Wait 42 s after a refusal' });
    expect(canOfferPeace(s, 1, 2).ok).toBe(true); // the other way is free
    s.tick += 42 * T;
    expect(canOfferPeace(s, 2, 1).ok).toBe(true);
    expect(act(s, 2, { type: 'offerPeace', to: 1, theyGive: 'none', youGive: 'none' }).ok).toBe(true);
    advance(s, TREATY_OFFER_TIMEOUT);
    expect(s.treatyOffers).toHaveLength(0);
    expect(s.events.some((e) => e.kind === 'treatyOfferExpired')).toBe(true);
    expect(act(s, 1, { type: 'answerTreaty', from: 2, accept: true })).toEqual({ ok: false, reason: 'No such offer' });
  });

  it('a fight is remembered for a minute', () => {
    const s = world();
    noteFight(s, 2, 1);
    expect(canOfferPeace(s, 1, 2).ok).toBe(true);
    advance(s, TREATY_FIGHT_WINDOW);
    expect(canOfferPeace(s, 1, 2)).toEqual({ ok: false, reason: 'Not fighting: offer a pact instead' });
    expect(canOfferPact(s, 1, 2).ok).toBe(true);
  });

  it('blocks every hostile path: land attack, missile, shelling, war at sea', () => {
    const s = world();
    fight12(s);
    updateWarMemory(s);
    clearNavyCache(s);
    expect(atWar(s, 1, 2)).toBe(true);
    signPeace(s, 2, 1);
    const why = 'Peace with AI 2: 3 min left';
    expect(act(s, 1, { type: 'attack', tile: at(s, 20, 5), troops: inf(5000) })).toEqual({ ok: false, reason: why });
    expect(act(s, 2, { type: 'attack', tile: at(s, 19, 5), troops: inf(500) })).toEqual({ ok: false, reason: 'Peace with AI 1: 3 min left' });
    s.players[1].techs.push('rocketry');
    const silo = addBuilding(s, 'silo', 1, at(s, 5, 5));
    expect(launchMissile(s, 1, silo.tile, 'rocket', at(s, 25, 5))).toEqual({ ok: false, reason: why });
    s.players[1].troops.artillery = BARRAGE_MIN_ARTILLERY * 2;
    expect(canBarrage(s, 1, at(s, 21, 5))).toEqual({ ok: false, reason: why });
    clearNavyCache(s);
    expect(atWar(s, 1, 2)).toBe(false);
    // Nation 3 is not part of the deal.
    expect(act(s, 1, { type: 'attack', tile: at(s, 20, 15), troops: inf(5000) }).ok).toBe(true);
  });

  it('a landing under way when peace is signed turns back home', () => {
    const s = makeFlatGame(60, 30, 4, { seed: 7 });
    for (let y = 0; y < 30; y++) for (let x = 20; x < 50; x++) s.map.terrain[at(s, x, y)] = Terrain.DeepWater;
    computeCoastAndLand(s.map);
    claimRect(s, 1, 0, 2, 19, 29);
    claimRect(s, 2, 50, 0, 59, 29);
    claimRect(s, 3, 0, 0, 0, 0);
    claimRect(s, 4, 1, 0, 1, 0);
    s.tick = 10 * 60 * T;
    s.playStartTick = 0;
    for (const p of s.players) if (p.id > 0) p.gold = 100000;
    noteFight(s, 1, 2);
    const landing = at(s, 50, 15);
    expect(launchTransport(s, 1, -1, landing, inf(1000)).ok).toBe(true);
    const before = s.players[1].troops.infantry;
    signPeace(s, 2, 1);
    for (let k = 0; k < 3000 && s.units.length; k++) {
      updateUnits(s);
      s.tick++;
    }
    expect(s.units.length).toBe(0);
    expect(s.map.owner[landing]).toBe(2);
    expect(s.attacks.some((a) => a.attacker === 1)).toBe(false);
    expect(s.players[1].troops.infantry).toBe(before + 1000);
    expect(launchTransport(s, 1, -1, landing, inf(1000)).reason).toMatch(/^Peace with AI 2: /);
  });
});

describe('peace terms', () => {
  it('previews the real amounts; gold small 10%, large 30%', () => {
    const s = world();
    expect(previewTerms(s, 2, 1, 'none')).toEqual({});
    expect(previewTerms(s, 2, 1, 'goldSmall')).toEqual({ gold: 1000 });
    expect(previewTerms(s, 2, 1, 'goldLarge')).toEqual({ gold: 3000 });
    noteFight(s, 1, 2);
    signPeace(s, 1, 2, 'goldLarge', 'none'); // 1 asks 2 to pay 30%
    expect(s.players[2].gold).toBe(7000);
    expect(s.players[1].gold).toBe(13000);
  });

  it('land: border tiles nearest first, capped, never the capital; buildings change owner', () => {
    const s = world();
    const p2 = s.players[2];
    p2.capital = at(s, 20, 5); // on the border with 1
    const farm = addBuilding(s, 'farm', 2, at(s, 20, 3));
    // 2 holds 200 tiles: small = 5% = 10 tiles within 2 tiles of the border with 1 (column 20 first, by index).
    expect(previewTerms(s, 2, 1, 'landSmall')).toEqual({ tiles: 10, buildings: 1 });
    // large = 15% = 30 tiles: column 20 (but the capital), columns 21 and 22, then the first of column 23.
    expect(previewTerms(s, 2, 1, 'landLarge')).toEqual({ tiles: 30, buildings: 1 });
    noteFight(s, 1, 2);
    signPeace(s, 2, 1, 'none', 'landLarge');
    const owner = (x: number, y: number): number => s.map.owner[at(s, x, y)];
    for (let y = 0; y < 10; y++) {
      expect(owner(20, y)).toBe(y === 5 ? 2 : 1);
      expect(owner(21, y)).toBe(1);
      expect(owner(22, y)).toBe(1);
    }
    expect(owner(23, 0)).toBe(1);
    expect(owner(23, 1)).toBe(2);
    expect(p2.capital).toBe(at(s, 20, 5));
    expect(farm.owner).toBe(1);
    expect(p2.tiles).toBe(170);
    expect(s.events.some((e) => e.kind === 'treatyAccepted' && e.message.includes('handed over 30 tiles with 1 building'))).toBe(true);
  });

  it('no shared border: land terms hand over nothing', () => {
    const s = world();
    expect(previewTerms(s, 4, 1, 'landLarge')).toEqual({ tiles: 0, buildings: 0 });
  });
});

describe('non-aggression pacts', () => {
  it('offer, accept, nothing hostile; renew only in the last minute', () => {
    const s = world();
    expect(act(s, 2, { type: 'offerPact', to: 4, seconds: 200 })).toEqual({ ok: false, reason: 'Unknown pact length' });
    expect(act(s, 2, { type: 'offerPact', to: 4, seconds: 360 }).ok).toBe(true);
    expect(s.events.at(-1)!.message).toBe('AI 2 offers a 6 min non-aggression pact');
    expect(act(s, 4, { type: 'answerTreaty', from: 2, accept: true }).ok).toBe(true);
    expect(peaceReason(s, 2, 4)).toBe('Pact with AI 4: 6 min left');
    s.players[2].troops = inf(50000);
    expect(act(s, 2, { type: 'attack', tile: at(s, 40, 5), troops: inf(5000) }).reason).toBe('Pact with AI 4: 6 min left');
    expect(canOfferPact(s, 2, 4)).toEqual({ ok: false, reason: 'Pact in place: renew it in its last 60 s' });
    expect(canOfferPeace(s, 2, 4)).toEqual({ ok: false, reason: 'Pact in place: no fighting' });
    advance(s, 310);
    expect(canOfferPact(s, 4, 2).ok).toBe(true);
    expect(act(s, 4, { type: 'offerPact', to: 2, seconds: 180 }).ok).toBe(true);
    expect(act(s, 2, { type: 'answerTreaty', from: 4, accept: true }).ok).toBe(true);
    expect(s.events.at(-1)!.message).toBe('AI 4 and AI 2 renewed their pact for 3 min');
    expect(activeTreaties(s, 4)[0].secondsLeft).toBe(180);
  });

  it('an attack between them cancels a pending pact offer', () => {
    const s = world();
    expect(act(s, 1, { type: 'offerPact', to: 2, seconds: 180 }).ok).toBe(true);
    fight12(s);
    expect(s.treatyOffers).toHaveLength(0);
  });

  it('breaking: holds 15 s more (the victim is warned), then ends; opinions drop, the breaker is marked', () => {
    const s = world();
    expect(act(s, 2, { type: 'offerPact', to: 4, seconds: 360 }).ok).toBe(true);
    expect(act(s, 4, { type: 'answerTreaty', from: 2, accept: true }).ok).toBe(true);
    const op4 = s.opinion[4][2];
    const op1 = s.opinion[1][2];
    expect(act(s, 2, { type: 'breakPact', with: 4 })).toEqual({ ok: true });
    const ev = s.events.at(-1)!;
    expect(ev.kind).toBe('pactBreakWarning');
    expect(ev.players).toContain(4);
    expect(ev.message).toBe('AI 2 broke the pact with AI 4: attacks are possible in 15 s');
    expect(s.opinion[4][2]).toBe(op4 - 30);
    expect(s.opinion[1][2]).toBe(op1 - 15);
    expect(isPactBreaker(s, 2)).toBe(true);
    expect(s.players[2].pactBreakerUntil).toBe(s.tick + PACT_BREAKER_DURATION * T);
    expect(activeTreaties(s, 4)[0]).toMatchObject({ kind: 'pact', other: 2, secondsLeft: PACT_BREAK_DELAY, breaking: true, breaker: 2 });
    expect(act(s, 2, { type: 'breakPact', with: 4 }).ok).toBe(false);
    advance(s, PACT_BREAK_DELAY - 1);
    expect(atPeace(s, 2, 4)).toBe(true); // still no attacks
    expect(peaceReason(s, 2, 4)).toBe('Pact with AI 4: 1 s left');
    advance(s, 1);
    expect(s.events.at(-1)!.kind).toBe('pactBroken');
    expect(atPeace(s, 2, 4)).toBe(false);
    s.players[2].troops = inf(50000);
    expect(act(s, 2, { type: 'attack', tile: at(s, 40, 5), troops: inf(5000) }).ok).toBe(true);
  });

  it('allies need none', () => {
    const s = world();
    formAlliance(s, 2, 4);
    expect(canOfferPact(s, 2, 4)).toEqual({ ok: false, reason: 'Already allied' });
    expect(canOfferPeace(s, 2, 4)).toEqual({ ok: false, reason: 'Already allied' });
  });
});

describe('when treaties are not allowed', () => {
  it('only 2 nations, no diplomacy games, team games, the overtime leader', () => {
    let s = world();
    s.players[3].alive = false;
    s.players[4].alive = false;
    expect(canOfferPact(s, 1, 2)).toEqual({ ok: false, reason: 'Only 2 nations left' });
    s = world();
    s.settings.modifiers = { ...s.settings.modifiers, noAlliances: true };
    expect(canOfferPact(s, 1, 2)).toEqual({ ok: false, reason: 'No diplomacy in this game' });
    expect(act(s, 1, { type: 'offerPact', to: 2, seconds: 180 }).reason).toBe('No diplomacy in this game');
    s = world();
    s.settings.mode = 'teams';
    s.teams = [0, 1, 1, 2, 2];
    expect(canOfferPact(s, 1, 2)).toEqual({ ok: false, reason: 'Teammates are allied for the whole game' });
    expect(canOfferPact(s, 1, 3)).toEqual({ ok: false, reason: 'Team game: the teams are fixed sides' });
    s = world();
    s.tick = 40 * 60 * T; // overtime; 1 holds the most land
    expect(canOfferPact(s, 2, 1)).toEqual({ ok: false, reason: 'No treaties with the overtime leader' });
    expect(canOfferPact(s, 1, 2)).toEqual({ ok: false, reason: 'You lead in overtime: no treaties' });
    expect(canOfferPact(s, 2, 4).ok).toBe(true);
  });

  it('the server rejects bad terms and lengths', () => {
    expect(validateAction({ type: 'offerPeace', to: 2, theyGive: 'none', youGive: 'goldSmall' }).ok).toBe(true);
    expect(validateAction({ type: 'offerPeace', to: 2, theyGive: 'everything', youGive: 'none' }).ok).toBe(false);
    expect(validateAction({ type: 'offerPeace', to: 2, theyGive: 'none' }).ok).toBe(false);
    expect(validateAction({ type: 'offerPact', to: 2, seconds: 360 }).ok).toBe(true);
    expect(validateAction({ type: 'offerPact', to: 2, seconds: 361 }).ok).toBe(false);
    expect(validateAction({ type: 'offerPact', to: 2, seconds: '180' }).ok).toBe(false);
    expect(validateAction({ type: 'answerTreaty', from: 2, accept: true }).ok).toBe(true);
    expect(validateAction({ type: 'answerTreaty', from: 2, accept: 'yes' }).ok).toBe(false);
    expect(validateAction({ type: 'breakPact', with: 3 }).ok).toBe(true);
    expect(validateAction({ type: 'breakPact', with: -1 }).ok).toBe(false);
  });
});

describe('AI and treaties', () => {
  const offer = (from: number, to: number, kind: TreatyOffer['kind'], theyGive: TreatyOffer['theyGive'] = 'none', youGive: TreatyOffer['youGive'] = 'none'): TreatyOffer => ({
    from, to, kind, theyGive, youGive, seconds: kind === 'pact' ? 360 : 0, expiresTick: 0,
  });

  it('a winning AI never takes peace; a losing one takes it', () => {
    const s = world();
    s.map.landTileCount = 100000; // nobody is a land winner
    s.players[1].troops = inf(200000);
    s.players[2].troops = inf(5000);
    s.players[3].troops = inf(5000);
    expect(act(s, 1, { type: 'attack', tile: at(s, 20, 5), troops: inf(10000) }).ok).toBe(true);
    // 2 asks winning 1:
    expect(aiWantsTreaty(s, 1, offer(2, 1, 'peace'))).toBe(false);
    expect(aiWantsTreaty(s, 1, offer(2, 1, 'peace', 'none', 'goldSmall'))).toBe(false); // a winner no longer sells peace for gold
    expect(aiWantsTreaty(s, 1, offer(2, 1, 'peace', 'goldSmall', 'goldSmall'))).toBe(false);
    // losing 2 asked by 1:
    expect(aiWantsTreaty(s, 2, offer(1, 2, 'peace'))).toBe(true);
    // not even on a second front: a winner keeps going
    expect(act(s, 1, { type: 'attack', tile: at(s, 20, 15), troops: inf(10000) }).ok).toBe(true);
    expect(aiWantsTreaty(s, 1, offer(2, 1, 'peace'))).toBe(false);
    // a pact breaker or traitor gets nothing
    s.players[2].pactBreakerUntil = s.tick + 100;
    expect(aiWantsTreaty(s, 1, offer(2, 1, 'peace', 'none', 'goldLarge'))).toBe(false);
    s.players[2].pactBreakerUntil = 0;
    s.players[2].traitorUntil = s.tick + 100;
    expect(aiWantsTreaty(s, 1, offer(2, 1, 'peace', 'none', 'goldLarge'))).toBe(false);
  });

  it('land winners and nations holding a pact turn down new treaties', () => {
    const s = world();
    s.map.landTileCount = 100000;
    s.players[2].troops = inf(500000);
    s.players[4].troops = inf(100);
    s.players[1].troops = inf(400000);
    s.players[3].troops = inf(400000);
    expect(aiWantsTreaty(s, 4, offer(2, 4, 'pact'))).toBe(true);
    s.players[2].tiles = 30000; // 30% of the land: a leader gets no pact
    expect(aiWantsTreaty(s, 4, offer(2, 4, 'pact'))).toBe(false);
    s.players[2].tiles = 10;
    s.treaties = [{ a: 3, b: 4, kind: 'pact', endTick: s.tick + 100 * T, breakTick: 0, breaker: 0 }];
    expect(aiWantsTreaty(s, 4, offer(2, 4, 'pact'))).toBe(false); // one pact at a time
  });

  it('refuses a pact from its next target', () => {
    const s = world();
    s.map.landTileCount = 100000;
    s.players[2].troops = inf(500000);
    s.players[4].troops = inf(100);
    s.players[1].troops = inf(400000);
    s.players[3].troops = inf(400000);
    expect(aiWantsTreaty(s, 2, offer(4, 2, 'pact'))).toBe(false);
    expect(aiWantsTreaty(s, 4, offer(2, 4, 'pact'))).toBe(true);
  });

  it('a losing AI offers peace, paying gold first and land on a later try', () => {
    const s = world(true); // 1 is human and leaves the offer waiting
    s.players[1].troops = inf(400000);
    s.players[2].troops = inf(20000);
    expect(act(s, 1, { type: 'attack', tile: at(s, 20, 5), troops: inf(30000) }).ok).toBe(true);
    const fromTwo = (): TreatyOffer | undefined => s.treatyOffers?.find((o) => o.from === 2 && o.to === 1);
    for (let k = 0; k < 60 * T && !fromTwo(); k++) tick(s);
    expect(fromTwo()).toMatchObject({ kind: 'peace', theyGive: 'none', youGive: 'goldSmall' });
    expect(act(s, 1, { type: 'answerTreaty', from: 2, accept: false }).ok).toBe(true);
    // Much later, still under attack: the next offer gives land.
    s.tick += 320 * T;
    if (!s.attacks.some((a) => a.attacker === 1 && a.target === 2)) {
      s.players[1].troops = inf(400000);
      const t = s.map.owner[at(s, 20, 5)] === 2 ? at(s, 20, 5) : at(s, 25, 5);
      expect(act(s, 1, { type: 'attack', tile: t, troops: inf(30000) }).ok).toBe(true);
    }
    for (let k = 0; k < 60 * T && !fromTwo(); k++) tick(s);
    expect(fromTwo()).toMatchObject({ kind: 'peace', youGive: 'landSmall' });
  });
});

describe('treaties in the hash', () => {
  it('every new field changes the hash', () => {
    const s = world();
    const steps: ((g: GameState) => void)[] = [
      (g) => (g.treaties = [{ a: 1, b: 2, kind: 'peace', endTick: g.tick + 100, breakTick: 0, breaker: 0 }]),
      (g) => (g.treaties![0].kind = 'pact'),
      (g) => (g.treaties![0].endTick += 1),
      (g) => (g.treaties![0].breakTick = g.tick),
      (g) => (g.treaties![0].breaker = 2),
      (g) => (g.treatyOffers = [{ from: 3, to: 4, kind: 'pact', theyGive: 'none', youGive: 'none', seconds: 180, expiresTick: g.tick + 300 }]),
      (g) => (g.treatyOffers![0].kind = 'peace'),
      (g) => (g.treatyOffers![0].theyGive = 'landSmall'),
      (g) => (g.treatyOffers![0].youGive = 'goldLarge'),
      (g) => (g.treatyOffers![0].seconds = 360),
      (g) => (g.treatyOffers![0].expiresTick += 1),
      (g) => (g.treatyCooldowns = [1, 3, g.tick + 600]),
      (g) => (g.treatyCooldowns![2] += 1),
      (g) => (g.fights = [1, 2, g.tick]),
      (g) => (g.fights![2] -= 1),
      (g) => (g.players[3].pactBreakerUntil = g.tick + 1200),
    ];
    let h = hashState(s);
    for (const step of steps) {
      step(s);
      const next = hashState(s);
      expect(next).not.toBe(h);
      h = next;
    }
  });

  it('same seed and the same treaty actions: the same game', () => {
    const run = (): number[] => {
      const s = makeTestGame({ seed: 4242, aiCount: 5 });
      const out: number[] = [];
      for (let k = 0; k < 1500; k++) {
        if (k === 300) act(s, 1, { type: 'offerPact', to: 2, seconds: 180 });
        if (k === 700) act(s, 1, { type: 'offerPact', to: 3, seconds: 360 });
        tick(s);
        if (k % 100 === 0) out.push(hashState(s));
      }
      return out;
    };
    expect(run()).toEqual(run());
  });
});
