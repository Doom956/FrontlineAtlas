// Difficulty knobs (DESIGN section 10): AI economy by difficulty, how the AI nations treat a human, setup validation
// and determinism per difficulty. scripts/humanbench.ts measures the result against a scripted new player.
import { describe, expect, it } from 'vitest';
import { DIFFICULTY, updateAI } from '../src/sim/ai';
import { AI_DECISION_SECONDS, AI_ECONOMY, TICKS_PER_SECOND } from '../src/sim/config';
import { aiEconomy, goldIncome, growthBonus, troopCap, updateEconomy } from '../src/sim/economy';
import { hashState } from '../src/sim/hash';
import { DIFFICULTY_LIST, sanitizeSetup, validateSetup } from '../src/sim/setup';
import { tick } from '../src/sim/sim';
import { createGame } from '../src/sim/state';
import type { Difficulty, GameState } from '../src/sim/types';
import { claimRect, makeFlatGame, testSettings } from './helpers';

const W = 60;
const H = 20;

/** Human 1 on the left third, AI 2 (and AI 3 when three players) on the rest: all land owned, nobody can expand. */
function boxedIn(difficulty: Difficulty, players = 2): GameState {
  const s = makeFlatGame(W, H, players, { human: true });
  s.settings.difficulty = difficulty;
  if (players === 2) {
    claimRect(s, 1, 0, 0, 19, H - 1);
    claimRect(s, 2, 20, 0, W - 1, H - 1);
  } else {
    // AI 2 | human | AI 3
    claimRect(s, 2, 0, 0, 19, H - 1);
    claimRect(s, 1, 20, 0, 39, H - 1);
    claimRect(s, 3, 40, 0, W - 1, H - 1);
  }
  updateEconomy(s);
  for (const p of s.players) {
    if (p.id === 0) continue;
    // AIs sit on a full troop bar (they want a war); the human is weak.
    p.troops = { infantry: p.isHuman ? 20000 : p.maxPop, armor: 0, artillery: 0 };
    p.gold = 0;
  }
  return s;
}

/** Runs only the AI for `seconds` from game second `from`; returns the AI ids that launched an attack on the human. */
function aiAttacksOnHuman(s: GameState, from: number, seconds: number): Set<number> {
  s.playStartTick = 0;
  s.tick = from * TICKS_PER_SECOND;
  const seen = new Set<number>();
  for (let k = 0; k < seconds * TICKS_PER_SECOND; k++) {
    updateAI(s);
    for (const a of s.attacks) if (a.target === 1) seen.add(a.attacker);
    s.tick++;
  }
  return seen;
}

describe('difficulty: AI economy', () => {
  /** Human 1 and AI 2 with the same land. */
  function pair(difficulty: Difficulty, tribe = false): GameState {
    const s = makeFlatGame(W, H, 2, { human: true });
    s.settings.difficulty = difficulty;
    if (tribe) s.players[2].personality = 'tribe';
    claimRect(s, 1, 0, 0, 19, H - 1);
    claimRect(s, 2, 40, 0, W - 1, H - 1);
    return s;
  }

  it('scales AI nations\' income, troop growth and troop cap by difficulty; the human never changes', () => {
    const human = pair('normal');
    const g0 = goldIncome(human, human.players[1]);
    const grow0 = growthBonus(human, human.players[1]);
    const cap0 = troopCap(human, 1);
    for (const d of DIFFICULTY_LIST) {
      const s = pair(d);
      const e = AI_ECONOMY[d];
      expect(goldIncome(s, s.players[1])).toBeCloseTo(g0, 6);
      expect(troopCap(s, 1)).toBeCloseTo(cap0, 6);
      expect(goldIncome(s, s.players[2]) / g0).toBeCloseTo(e.income, 6);
      expect(growthBonus(s, s.players[2]) / grow0).toBeCloseTo(e.growth, 6);
      expect(troopCap(s, 2) / cap0).toBeCloseTo(e.cap, 6);
      updateEconomy(s);
      expect(s.players[2].income.gold / s.players[1].income.gold).toBeCloseTo(e.income, 4);
    }
  });

  it('gets stronger from easy to brutal, and easy / normal leave tribes alone', () => {
    const order: Difficulty[] = ['easy', 'normal', 'hard', 'brutal'];
    expect(DIFFICULTY_LIST).toEqual(order);
    for (let k = 1; k < order.length; k++) {
      const a = AI_ECONOMY[order[k - 1]];
      const b = AI_ECONOMY[order[k]];
      expect(b.growth).toBeGreaterThanOrEqual(a.growth);
      expect(b.income).toBeGreaterThanOrEqual(a.income);
      expect(b.cap).toBeGreaterThanOrEqual(a.cap);
      expect(AI_DECISION_SECONDS[order[k]]).toBeLessThanOrEqual(AI_DECISION_SECONDS[order[k - 1]]);
    }
    expect(AI_ECONOMY.easy.growth).toBeLessThanOrEqual(0.75);
    expect(AI_ECONOMY.normal.growth).toBeGreaterThanOrEqual(0.85);
    expect(AI_ECONOMY.normal.growth).toBeLessThanOrEqual(0.9);
    // Tribes are food: Easy / Normal don't weaken them; Hard / Brutal boost every AI player.
    for (const d of DIFFICULTY_LIST) {
      const s = pair(d, true);
      const e = aiEconomy(s, s.players[2]);
      if (d === 'easy' || d === 'normal') expect(e).toEqual({ growth: 1, income: 1, cap: 1 });
      else expect(e).toEqual(AI_ECONOMY[d]);
    }
  });
});

describe('difficulty: how AI nations treat a human', () => {
  it('profiles: easy spares the human longest and sends the least; hard has early limits; brutal has none', () => {
    const { easy, normal, hard, brutal } = DIFFICULTY;
    expect(easy.humanGrace).toBeGreaterThan(normal.humanGrace);
    expect(normal.humanGrace).toBeGreaterThan(hard.humanGrace);
    expect(hard.humanGrace).toBeGreaterThan(brutal.humanGrace);
    expect(easy.nukes).toBe(false);
    expect(easy.humanForceCap).toBeLessThan(normal.humanForceCap);
    expect(normal.humanForceCap).toBeLessThan(hard.humanForceCap);
    expect(normal.humanWarsEarly).toBe(1);
    expect(hard.humanWarsEarly).toBe(1);
    expect(hard.humanWarsLate).toBe(Infinity);
    expect(easy.humanWarsLate).toBe(1);
    expect(brutal.humanGrace).toBe(0);
    expect(brutal.humanForceCap).toBe(Infinity);
    expect(brutal.humanWarsEarly).toBe(Infinity);
    for (const p of [hard, brutal]) expect(p.careful && p.coordinate && p.nukes).toBe(true);
  });

  it('easy, normal and hard: no war on the human during its grace; brutal attacks at once', () => {
    expect(aiAttacksOnHuman(boxedIn('easy'), 300, 60).size).toBe(0);
    expect(aiAttacksOnHuman(boxedIn('normal'), 300, 60).size).toBe(0);
    expect(aiAttacksOnHuman(boxedIn('hard'), 300, 60).size).toBe(0);
    expect(aiAttacksOnHuman(boxedIn('brutal'), 300, 60).has(2)).toBe(true);
  });

  it('after the grace, an attack on a human is capped at humanForceCap x its army', () => {
    const s = boxedIn('normal');
    const seen = aiAttacksOnHuman(s, DIFFICULTY.normal.humanGrace + 30, 60);
    expect(seen.has(2)).toBe(true);
    const a = s.attacks.find((x) => x.attacker === 2 && x.target === 1)!;
    const sent = a.troops.infantry + a.troops.armor + a.troops.artillery;
    expect(sent).toBeLessThanOrEqual(DIFFICULTY.normal.humanForceCap * 20000 + 1);
    // Brutal: no cap (it sends far more than the human's army).
    const h = boxedIn('brutal');
    aiAttacksOnHuman(h, 30, 60);
    const b = h.attacks.find((x) => x.attacker === 2 && x.target === 1)!;
    expect(b.troops.infantry + b.troops.armor + b.troops.artillery).toBeGreaterThan(5 * 20000);
  });

  it('normal and hard: one AI war on the human at a time in the first 10 minutes; brutal lets both attack', () => {
    const n = aiAttacksOnHuman(boxedIn('normal', 3), DIFFICULTY.normal.humanGrace + 10, 40);
    expect(n.size).toBe(1);
    const hd = aiAttacksOnHuman(boxedIn('hard', 3), DIFFICULTY.hard.humanGrace + 10, 40);
    expect(hd.size).toBe(1);
    const h = aiAttacksOnHuman(boxedIn('brutal', 3), 30, 40);
    expect(h.size).toBe(2);
  });
});

describe('difficulty: setup and determinism', () => {
  it('every difficulty is a valid setup value; unknown ones fall back to normal', () => {
    for (const d of DIFFICULTY_LIST) {
      expect(validateSetup({ difficulty: d })).toBeNull();
      expect(sanitizeSetup({ difficulty: d }).difficulty).toBe(d);
    }
    expect(validateSetup({ difficulty: 'insane' })).not.toBeNull();
    expect(sanitizeSetup({ difficulty: 'insane' }).difficulty).toBe('normal');
  });

  it('each difficulty is deterministic, and difficulties differ', () => {
    const hashes: number[] = [];
    for (const d of ['easy', 'brutal'] as const) {
      const run = (): number => {
        const s = createGame(testSettings({ difficulty: d, humanPlayer: false, aiCount: 4, tribeCount: 6, seed: 7 }));
        for (let k = 0; k < 60 * TICKS_PER_SECOND; k++) tick(s);
        return hashState(s);
      };
      const h = run();
      expect(run()).toBe(h);
      hashes.push(h);
    }
    expect(hashes[0]).not.toBe(hashes[1]);
  });
});
