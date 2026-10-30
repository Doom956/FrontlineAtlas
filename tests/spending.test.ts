// Gold uses: mercenaries, funding allies, war bonds (src/sim/spending.ts).
import { describe, expect, it } from 'vitest';
import { applyAction } from '../src/sim/actions';
import { allyRefusal } from '../src/sim/allies';
import { aiSpendStats } from '../src/sim/aispending';
import { FUND_MAX_BONUS, FUND_SECONDS, MERC_CAP_SHARE, MERC_OVER_CAP, TICKS_PER_SECOND, WAR_BONDS_BONUS, WAR_BONDS_COOLDOWN, WAR_BONDS_SECONDS } from '../src/sim/config';
import { formAlliance } from '../src/sim/diplomacy';
import { troopCap } from '../src/sim/economy';
import { hashState } from '../src/sim/hash';
import { tick } from '../src/sim/sim';
import { attackBonusMul, fundAllyEffect, fundingBonus, mercenaryPrice, updateSpending, warBondsInfo } from '../src/sim/spending';
import { validateAction } from '../server/validate';
import { claimRect, makeFlatGame, makeTestGame } from './helpers';
import type { GameState } from '../src/sim/types';

function game(): GameState {
  const s = makeFlatGame(90, 40, 3, { human: true });
  claimRect(s, 1, 0, 0, 29, 39);
  claimRect(s, 2, 30, 0, 59, 39);
  claimRect(s, 3, 60, 0, 89, 39);
  for (const p of s.players.slice(1)) {
    p.maxPop = troopCap(s, p.id);
    p.troops = { infantry: p.maxPop * 0.3, armor: 0, artillery: 0 };
    p.gold = 1e6;
    p.income.gold = 100;
  }
  return s;
}
const home = (s: GameState, id: number): number => {
  const t = s.players[id].troops;
  return t.infantry + t.armor + t.artillery;
};

describe('mercenaries', () => {
  it('adds infantry at once and charges the quoted price', () => {
    const s = game();
    const p = s.players[1];
    const q = mercenaryPrice(s, 1, 10000);
    expect(q.reason).toBeNull();
    const g0 = p.gold;
    const h0 = home(s, 1);
    expect(applyAction(s, 1, { type: 'hireMercenaries', amount: 10000 }).ok).toBe(true);
    expect(home(s, 1) - h0).toBeCloseTo(10000);
    expect(g0 - p.gold).toBeCloseTo(q.gold);
  });
  it('the price rises with each hire in the window and with game time; one big hire costs the same as two halves', () => {
    const s = game();
    const a = mercenaryPrice(s, 1, 10000).perTroop;
    applyAction(s, 1, { type: 'hireMercenaries', amount: 10000 });
    expect(mercenaryPrice(s, 1, 10000).perTroop).toBeGreaterThan(a);
    const s2 = game();
    const whole = mercenaryPrice(s2, 1, 20000).gold;
    const s3 = game();
    const g0 = s3.players[1].gold;
    applyAction(s3, 1, { type: 'hireMercenaries', amount: 10000 });
    applyAction(s3, 1, { type: 'hireMercenaries', amount: 10000 });
    expect(g0 - s3.players[1].gold).toBeCloseTo(whole, 3);
    const late = game();
    late.tick = late.playStartTick + 30 * 60 * TICKS_PER_SECOND;
    expect(mercenaryPrice(late, 1, 10000).perTroop).toBeGreaterThan(a * 1.5);
  });
  it('caps per window and above the troop cap, refuses with clear reasons', () => {
    const s = game();
    const p = s.players[1];
    const q = mercenaryPrice(s, 1, 1000);
    expect(q.max).toBeLessThanOrEqual(Math.ceil(p.maxPop * MERC_CAP_SHARE));
    expect(applyAction(s, 1, { type: 'hireMercenaries', amount: q.max + 5000 }).reason).toMatch(/At most/);
    expect(applyAction(s, 1, { type: 'hireMercenaries', amount: 10 }).reason).toMatch(/at least/);
    p.troops.infantry = p.maxPop * (1 + MERC_OVER_CAP);
    expect(applyAction(s, 1, { type: 'hireMercenaries', amount: 5000 }).reason).toMatch(/full/);
    p.troops.infantry = 0;
    p.gold = 1;
    expect(applyAction(s, 1, { type: 'hireMercenaries', amount: 5000 }).reason).toMatch(/Not enough gold/);
    expect(applyAction(s, 1, { type: 'hireMercenaries', amount: NaN }).ok).toBe(false);
  });
  it('the window refills after a minute', () => {
    const s = game();
    const max = mercenaryPrice(s, 1, 1000).max;
    applyAction(s, 1, { type: 'hireMercenaries', amount: max });
    expect(mercenaryPrice(s, 1, 1000).reason).toMatch(/this minute/);
    s.tick += 61 * TICKS_PER_SECOND;
    s.players[1].troops.infantry = 0;
    expect(mercenaryPrice(s, 1, 1000).reason).toBeNull();
  });
});

describe('funding allies', () => {
  it('sends gold, needs an alliance, and gives a bonus against nations at war with the funder', () => {
    const s = game();
    expect(applyAction(s, 1, { type: 'fundAlly', ally: 2, gold: 5000 }).reason).toMatch(/not your ally/);
    formAlliance(s, 1, 2);
    expect(applyAction(s, 1, { type: 'fundAlly', ally: 2, gold: 10 }).reason).toMatch(/at least/);
    const e = fundAllyEffect(s, 1, 2, 6000);
    expect(e.bonus).toBeCloseTo(FUND_MAX_BONUS); // 6000 >= 60 s of the ally's 100 gold/s
    const g2 = s.players[2].gold;
    expect(applyAction(s, 1, { type: 'fundAlly', ally: 2, gold: 6000 }).ok).toBe(true);
    expect(s.players[2].gold - g2).toBe(6000);
    // No war between 1 and 3 yet: no bonus for 2 against 3.
    expect(fundingBonus(s, 2, 3)).toBe(0);
    s.attacks.push({ id: 500, attacker: 3, target: 1, troops: { infantry: 1000, armor: 0, artillery: 0 }, focusTile: 0, progress: 0, startTick: 0, amphibious: false, losses: 0, tilesTaken: 0 });
    expect(fundingBonus(s, 2, 3)).toBeCloseTo(FUND_MAX_BONUS);
    expect(attackBonusMul(s, 2, 3)).toBeCloseTo(1 + FUND_MAX_BONUS);
    expect(attackBonusMul(s, 2, 1)).toBe(1);
    s.tick += (FUND_SECONDS + 1) * TICKS_PER_SECOND;
    expect(fundingBonus(s, 2, 3)).toBe(0);
    s.tick = Math.ceil(s.tick / TICKS_PER_SECOND) * TICKS_PER_SECOND;
    updateSpending(s);
    expect(s.allyFunds?.length).toBe(0);
  });
  it('a funded ally needs less trust to help', () => {
    const s = game();
    formAlliance(s, 1, 2);
    s.opinion[2][1] = -20;
    expect(allyRefusal(s, 2, 1, 'any')).toMatch(/trust/);
    applyAction(s, 1, { type: 'fundAlly', ally: 2, gold: 6000 });
    s.opinion[2][1] = -20;
    expect(allyRefusal(s, 2, 1, 'any') ?? '').not.toMatch(/trust/);
  });
});

describe('war bonds', () => {
  it('boosts attacks for a while, then has a cooldown', () => {
    const s = game();
    const i = warBondsInfo(s, 1);
    expect(i.reason).toBeNull();
    expect(applyAction(s, 1, { type: 'warBonds' }).ok).toBe(true);
    expect(attackBonusMul(s, 1, 2)).toBeCloseTo(1 + WAR_BONDS_BONUS);
    expect(applyAction(s, 1, { type: 'warBonds' }).reason).toMatch(/again in/);
    s.tick += WAR_BONDS_SECONDS * TICKS_PER_SECOND;
    expect(attackBonusMul(s, 1, 2)).toBe(1);
    s.tick += (WAR_BONDS_COOLDOWN - WAR_BONDS_SECONDS) * TICKS_PER_SECOND;
    expect(warBondsInfo(s, 1).reason).toBeNull();
  });
});

describe('server validation and determinism', () => {
  it('accepts the new action shapes and rejects junk', () => {
    expect(validateAction({ type: 'hireMercenaries', amount: 5000 }).ok).toBe(true);
    expect(validateAction({ type: 'hireMercenaries', amount: -1 }).ok).toBe(false);
    expect(validateAction({ type: 'fundAlly', ally: 2, gold: 100 }).ok).toBe(true);
    expect(validateAction({ type: 'fundAlly', ally: 'x', gold: 100 }).ok).toBe(false);
    expect(validateAction({ type: 'warBonds' }).ok).toBe(true);
  });
  it('AI games with gold uses stay deterministic and the AIs use them', () => {
    const run = () => {
      const s = makeTestGame({ seed: 4242, humanPlayer: false });
      for (let k = 0; k < 6000; k++) tick(s);
      return { h: hashState(s), stats: { ...aiSpendStats(s) } };
    };
    const a = run();
    const b = run();
    expect(a.h).toBe(b.h);
    expect(a.stats).toEqual(b.stats);
  }, 60000);
});
