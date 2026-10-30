// Tech tree branches with exclusive choices (src/sim/techtree.ts).
import { describe, expect, it } from 'vitest';
import { applyAction } from '../src/sim/actions';
import { aiBranchPick, aiTechOrder } from '../src/sim/aispending';
import { TECH_EFFECTS, TECH_ORDER, TECHS } from '../src/sim/config';
import { goldIncome, troopCap } from '../src/sim/economy';
import { hashState } from '../src/sim/hash';
import { tick } from '../src/sim/sim';
import { canResearch, updateResearch } from '../src/sim/tech';
import {
  choiceWarning,
  exclusiveGroups,
  groupMembers,
  prereqsMet,
  stockInterest,
  techBuildingCostMul,
  techFrontSpeedMul,
  techLossMul,
  techStatus,
  unitVisibleTo,
} from '../src/sim/techtree';
import { buildingCost } from '../src/sim/buildings';
import { claimRect, makeFlatGame, makeTestGame } from './helpers';
import type { TechId, Unit } from '../src/sim/types';

function richGame() {
  const s = makeFlatGame(60, 40, 2, { human: true });
  claimRect(s, 1, 0, 0, 29, 39);
  claimRect(s, 2, 30, 0, 59, 39);
  for (const p of s.players.slice(1)) {
    p.gold = 1e6;
    p.science = 1e6;
  }
  return s;
}
function give(s: ReturnType<typeof richGame>, pid: number, ...techs: TechId[]): void {
  for (const t of techs) if (!s.players[pid].techs.includes(t)) s.players[pid].techs.push(t);
}

describe('tech tree data', () => {
  it('every tech is in TECH_ORDER, requirements exist, tiers 1-5', () => {
    expect(new Set(TECH_ORDER).size).toBe(Object.keys(TECHS).length);
    for (const t of TECH_ORDER) {
      const info = TECHS[t];
      for (const r of [...info.requires, ...(info.requiresAny ?? [])]) expect(TECHS[r], `${t} needs ${r}`).toBeDefined();
      expect(info.tier).toBeGreaterThanOrEqual(1);
      expect(info.tier).toBeLessThanOrEqual(5);
    }
  });
  it('has 12-15 branch techs in 6 exclusive groups of 2', () => {
    const groups = exclusiveGroups();
    expect(groups.length).toBe(6);
    for (const g of groups) expect(groupMembers(g).length).toBe(2);
    expect(TECH_ORDER.length - 15).toBeGreaterThanOrEqual(12);
    expect(TECH_ORDER.length - 15).toBeLessThanOrEqual(15);
  });
  it('warns which tech a choice locks', () => {
    expect(choiceWarning('freeTrade')).toBe('Choosing this locks Stock Exchange');
    expect(choiceWarning('banking')).toBeNull();
  });
});

describe('exclusive choices', () => {
  it('researching one member locks the other for good', () => {
    const s = richGame();
    give(s, 1, 'agriculture', 'banking');
    expect(techStatus(s, 1, 'stockExchange')).toBe('available');
    expect(techStatus(s, 1, 'freeTrade')).toBe('available');
    expect(applyAction(s, 1, { type: 'research', tech: 'freeTrade' }).ok).toBe(true);
    expect(techStatus(s, 1, 'freeTrade')).toBe('researching');
    expect(techStatus(s, 1, 'stockExchange')).toBe('locked-choice');
    const r = canResearch(s, 1, 'stockExchange');
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('You chose Free Trade; Stock Exchange is locked');
    updateResearch(s); // the science stock finished it already (startResearch spends it), keep ticking anyway
    s.players[1].researchProgress = 1e9;
    updateResearch(s);
    expect(techStatus(s, 1, 'freeTrade')).toBe('done');
    expect(techStatus(s, 1, 'stockExchange')).toBe('locked-choice');
    expect(applyAction(s, 1, { type: 'research', tech: 'stockExchange' }).ok).toBe(false);
  });
  it('switching away from an unfinished choice frees the group', () => {
    const s = richGame();
    give(s, 1, 'metallurgy', 'mechanization', 'agriculture');
    s.players[1].science = 0;
    expect(applyAction(s, 1, { type: 'research', tech: 'blitzTactics' }).ok).toBe(true);
    expect(techStatus(s, 1, 'trenchWarfare')).toBe('locked-choice');
    expect(applyAction(s, 1, { type: 'research', tech: 'propaganda' }).ok).toBe(true);
    expect(techStatus(s, 1, 'trenchWarfare')).toBe('available');
  });
  it('a tech after a fork needs either branch (requiresAny)', () => {
    const s = richGame();
    give(s, 1, 'agriculture', 'banking');
    expect(techStatus(s, 1, 'industrialBoom')).toBe('locked-prereq');
    expect(canResearch(s, 1, 'industrialBoom').reason).toBe('Needs Stock Exchange or Free Trade');
    give(s, 1, 'stockExchange');
    expect(prereqsMet(s.players[1], 'industrialBoom')).toBe(true);
    expect(techStatus(s, 1, 'industrialBoom')).toBe('available');
  });
  it('navy and air branches are disabled when those weapons are off', () => {
    const s = makeTestGame({ mods: { noNavy: true, noAir: true } });
    s.players[1].techs.push('navigation', 'logistics', 'flight');
    s.players[1].gold = 1e6;
    expect(techStatus(s, 1, 'carriers')).toBe('disabled');
    expect(techStatus(s, 1, 'jetEngines')).toBe('disabled');
    expect(applyAction(s, 1, { type: 'research', tech: 'submarines' }).ok).toBe(false);
  }, 60000);
});

describe('branch effects', () => {
  it('Free Trade makes markets cheaper, Trench Warfare forts, Automation everything', () => {
    const s = richGame();
    const market = buildingCost(s, 1, 'market').gold;
    give(s, 1, 'freeTrade');
    expect(buildingCost(s, 1, 'market').gold).toBe(Math.round(market * TECH_EFFECTS.freeTradeMarketCost));
    expect(techBuildingCostMul(s, 1, 'fort')).toBe(1);
    give(s, 1, 'trenchWarfare');
    expect(techBuildingCostMul(s, 1, 'fort')).toBe(TECH_EFFECTS.trenchFortCost);
    give(s, 1, 'automation');
    expect(techBuildingCostMul(s, 1, 'city')).toBe(TECH_EFFECTS.automationCost);
  });
  it('Trench Warfare and Propaganda raise attacker losses; Blitz speeds armor fronts; trenches slow enemies', () => {
    const s = richGame();
    expect(techLossMul(s, 2, 1)).toBe(1);
    give(s, 1, 'trenchWarfare', 'propaganda');
    expect(techLossMul(s, 2, 1)).toBeCloseTo(TECH_EFFECTS.trenchDefense * TECH_EFFECTS.propagandaAttackerLoss);
    expect(techFrontSpeedMul(s, 2, 1, 0)).toBeCloseTo(TECH_EFFECTS.trenchEnemySpeed);
    give(s, 2, 'blitzTactics');
    expect(techFrontSpeedMul(s, 2, 0, 1)).toBeCloseTo(1 + TECH_EFFECTS.blitzArmorSpeed);
    expect(techFrontSpeedMul(s, 2, 0, 0)).toBe(1);
  });
  it('Stock Exchange pays interest on a capped reserve; Industrial Boom and Conscription raise income and cap', () => {
    const s = richGame();
    const p = s.players[1];
    expect(stockInterest(p, 100)).toBe(0);
    give(s, 1, 'stockExchange');
    p.gold = 1e6;
    expect(stockInterest(p, 100)).toBeCloseTo(100 * TECH_EFFECTS.stockInterestCapSeconds * TECH_EFFECTS.stockInterestPerS);
    p.gold = 500;
    expect(stockInterest(p, 100)).toBeCloseTo(500 * TECH_EFFECTS.stockInterestPerS);
    const g0 = goldIncome(s, p);
    const c0 = troopCap(s, 1);
    give(s, 1, 'industrialBoom', 'conscription');
    expect(goldIncome(s, p)).toBeCloseTo(g0 * TECH_EFFECTS.industrialBoomIncome);
    expect(troopCap(s, 1)).toBeCloseTo(c0 * TECH_EFFECTS.conscriptionCap);
  });
  it('Submarines hide warships from enemies far from them', () => {
    const s = richGame();
    give(s, 2, 'submarines');
    const ship = { id: 999, type: 'warship', owner: 2, x: 200, y: 200, hp: 3 } as unknown as Unit;
    // far outside the 60x40 map: no own ship or coast of player 1 near it
    expect(unitVisibleTo(s, 1, ship)).toBe(false);
    expect(unitVisibleTo(s, 2, ship)).toBe(true);
    expect(unitVisibleTo(s, 0, ship)).toBe(true);
    const near = { ...ship, x: 31, y: 10 } as Unit; // next to player 1's land (x <= 29)
    expect(unitVisibleTo(s, 1, near)).toBe(true);
  });
});

describe('AI branch choices', () => {
  it('commits to one member per group and orders branches after their prerequisites', () => {
    const s = makeTestGame();
    const ai = s.players.find((p) => p.id > 1 && p.personality && p.personality !== 'tribe')!;
    const order = aiTechOrder(s, ai.id, ai.personality, TECH_ORDER.slice(0, 15));
    for (const g of exclusiveGroups()) {
      const inOrder = groupMembers(g).filter((t) => order.includes(t));
      expect(inOrder).toEqual([aiBranchPick(s, ai.id, ai.personality, g)]);
    }
    for (let k = 0; k < order.length; k++) {
      for (const r of TECHS[order[k]].requires) expect(order.indexOf(r)).toBeLessThan(k);
    }
  }, 60000);
  it('both members of every group get picked across nations and seeds', () => {
    const seen = new Map<string, Set<TechId>>();
    for (let seed = 1; seed <= 12; seed++) {
      const s = makeTestGame({ seed });
      for (const p of s.players) {
        if (p.id === 0 || p.isHuman) continue;
        for (const g of exclusiveGroups()) {
          if (!seen.has(g)) seen.set(g, new Set());
          seen.get(g)!.add(aiBranchPick(s, p.id, p.personality, g));
        }
      }
    }
    for (const [g, picks] of seen) expect(picks.size, g).toBe(2);
  }, 60000);
});

describe('determinism', () => {
  it('two games with the same branch research give the same hash', () => {
    const run = () => {
      const s = makeTestGame({ seed: 77 });
      const p = s.players[1];
      p.techs.push('agriculture', 'banking', 'logistics');
      p.gold = 1e5;
      applyAction(s, 1, { type: 'research', tech: 'stockExchange' });
      for (let k = 0; k < 300; k++) tick(s);
      return hashState(s);
    };
    expect(run()).toBe(run());
  }, 60000);
});
