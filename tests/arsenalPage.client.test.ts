// Research panel layout (src/client/hud/techRows.ts): the two tabs, rows, forks, the next affordable card, the
// mastery counter and the time estimate. No DOM.
import { describe, expect, it } from 'vitest';
import { ARSENAL_ROWS, MASTERY_CAP, isArsenalTech } from '../src/sim/arsenal';
import { TECHS, TECH_ORDER } from '../src/sim/config';
import type { TechId } from '../src/sim/types';
import { formatEta, masteryCapLine, masteryCounter, nextAffordable, panelLayout, researchEta, tabOf } from '../src/client/hud/techRows';
import { makeFlatGame } from './helpers';

describe('research panel tabs', () => {
  it('Research shows only non-arsenal techs in Economy, Land, Logistics, Influence', () => {
    const lay = panelLayout('research');
    expect(lay.rows.map((r) => r.name)).toEqual(['Economy', 'Land', 'Logistics', 'Influence']);
    const techs = lay.rows.flatMap((r) => r.cards.map((c) => c.tech));
    for (const t of techs) expect(isArsenalTech(t)).toBe(false);
    for (const t of TECH_ORDER) if (!isArsenalTech(t)) expect(techs).toContain(t);
    for (const t of TECH_ORDER) expect(tabOf(t)).toBe(isArsenalTech(t) ? 'arsenal' : 'research');
  });

  it('Arsenal follows ARSENAL_ROWS: Navy, Armor, Air, Shared, with Unlock .. Mastery columns', () => {
    const lay = panelLayout('arsenal');
    expect(lay.rows.map((r) => r.id)).toEqual(ARSENAL_ROWS.map((r) => r.pillar));
    expect(lay.cols[0].label).toBe('Unlock');
    expect(lay.cols[lay.cols.length - 1].label).toBe('Mastery');
    for (const row of ARSENAL_ROWS) {
      const r = lay.rows.find((x) => x.id === row.pillar)!;
      expect(r.cards.map((c) => c.tech).sort()).toEqual(row.items.map((i) => i.tech).filter((t) => TECHS[t]).sort());
      // left to right by tier
      for (const a of r.cards) for (const b of r.cards) {
        const ia = row.items.find((i) => i.tech === a.tech)!;
        const ib = row.items.find((i) => i.tech === b.tech)!;
        if (ia.tier < ib.tier) expect(a.col).toBeLessThan(b.col);
      }
    }
  });

  it('draws each fork as a split: branches in their own lanes, one OR between them, the branch upgrade in its lane', () => {
    const navy = panelLayout('arsenal').rows.find((r) => r.id === 'navy')!;
    const lane = (t: TechId) => navy.cards.find((c) => c.tech === t)!.lane;
    expect(navy.forks).toHaveLength(1);
    expect(navy.forks[0].roots).toEqual(['destroyers', 'submarines']);
    expect(lane('destroyers')).toBe(lane('battleships'));
    expect(lane('submarines')).toBe(lane('carriers'));
    expect(lane('destroyers')).not.toBe(lane('submarines'));
    // the mastery line runs from both path ends, not from Navigation (transitive reduction)
    const into = navy.edges.filter((e) => e.to === 'navalMastery');
    expect(into.map((e) => e.from).sort()).toEqual(['battleships', 'carriers']);
    expect(into.every((e) => e.any)).toBe(true);
    // a prerequisite in another tab shows on the card instead of a line
    expect(navy.outside.navalMines).toEqual(['fortification']);
    const shared = panelLayout('arsenal').rows.find((r) => r.id === 'shared')!;
    expect(shared.outside.earlyWarning).toEqual(['radar']);
    // research forks too
    const econ = panelLayout('research').rows.find((r) => r.id === 'economy')!;
    expect(econ.forks.map((f) => f.group)).toEqual(['finance', 'capstone']);
  });
});

describe('research panel state', () => {
  it('flags the lowest-tier affordable tech of the tab, skips locked and unaffordable ones, honours filters', () => {
    const s = makeFlatGame(40, 20, 2, { human: true, seed: 3 });
    const me = s.players[1];
    me.gold = 100_000;
    const ars = panelLayout('arsenal');
    const res = panelLayout('research');
    const n1 = nextAffordable(s, me, res)!;
    expect(TECHS[n1].tier).toBe(1);
    // Arsenal items are bought with iron / oil too and need their building (procure.ts): none yet, nothing to flag
    me.iron = 100_000;
    me.oil = 100_000;
    expect(nextAffordable(s, me, ars)).toBeNull();
    // only the Air row (Flight needs no building: it unlocks the Airfield)
    me.techs.push('logistics');
    expect(nextAffordable(s, me, ars, new Set(['air']))).toBe('flight');
    // a fork root once the rival is chosen is never next
    me.techs.push('flight', 'heavyBombers');
    const air = nextAffordable(s, me, ars, new Set(['air']))!;
    expect(air).not.toBe('groundAttack');
    expect(air).not.toBe('jetEngines');
    // no gold: nothing to flag
    me.gold = 0;
    expect(nextAffordable(s, me, ars)).toBeNull();
  });

  it('counts masteries and locks the third pillar', () => {
    const s = makeFlatGame(40, 20, 2, { human: true, seed: 3 });
    const me = s.players[1];
    expect(masteryCounter(me).text).toBe(`Mastery 0 of ${MASTERY_CAP}`);
    me.techs.push('navalMastery');
    expect(masteryCounter(me)).toMatchObject({ text: `Mastery 1 of ${MASTERY_CAP} · Navy`, full: false });
    me.researching = 'airMastery';
    expect(masteryCounter(me).full).toBe(true);
    expect(masteryCapLine(me, 'armorMastery')).toBe('Cap used: Navy, Air');
    expect(masteryCapLine(me, 'navalMastery')).toBeNull();
  });

  it('estimates research time from the science rate and the saved science', () => {
    const s = makeFlatGame(40, 20, 2, { human: true, seed: 3 });
    const me = s.players[1];
    me.researching = null;
    me.science = 50;
    me.income.science = 5;
    expect(researchEta(me, 'agriculture')).toBeCloseTo((TECHS.agriculture.science - 50) / 5);
    me.income.science = 0;
    expect(researchEta(me, 'agriculture')).toBeNull();
    expect(formatEta(null)).toBe('—');
    expect(formatEta(45)).toBe('45 s');
    expect(formatEta(220)).toBe('3:40');
    expect(formatEta(3900)).toBe('1 h 05');
  });
});
