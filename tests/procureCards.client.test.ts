// Arsenal cards on the client (src/client/hud/procure.ts, techRows.ts): what each card shows while it is bought with
// gold plus iron / oil and delivered after a timer (sim/procurement.ts). No DOM.
import { describe, expect, it } from 'vitest';
import { markBuildingsChanged } from '../src/sim/buildings';
import { TICKS_PER_SECOND } from '../src/sim/config';
import { procure } from '../src/sim/procurement';
import { tick } from '../src/sim/sim';
import { newId } from '../src/sim/state';
import type { Building, BuildingType, GameState, TechId } from '../src/sim/types';
import { priceHtml } from '../src/client/hud/arsenalPage';
import { arsenalCard, howToGet, masteryCapped, onOrder, ordersOf, techFirst } from '../src/client/hud/procure';
import { masteryCounter, nextAffordable, panelLayout } from '../src/client/hud/techRows';
import { makeFlatGame } from './helpers';

function addBuilding(s: GameState, type: BuildingType, owner: number, tile: number): Building {
  const id = newId(s);
  const b: Building = { id, type, owner, tile, level: 1, buildLeft: 0, upgradeLeft: 0, fighters: 0, bombers: 0, cooldown: 0, dropCooldown: 0, disabledUntil: 0, hp: 1, queuedLevels: 0 };
  s.buildings.set(id, b);
  s.map.building[tile] = id + 1;
  markBuildingsChanged(s);
  return b;
}
function rich(seed = 3): GameState {
  const s = makeFlatGame(40, 20, 2, { human: true, seed });
  const me = s.players[1];
  me.gold = 1e6;
  me.iron = 1e5;
  me.oil = 1e5;
  return s;
}
const give = (s: GameState, ...t: TechId[]): void => void s.players[1].techs.push(...t);

describe('arsenal card states', () => {
  it('shows the building an item needs ("Build a Port first"), then Buy once it stands', () => {
    const s = rich();
    const me = s.players[1];
    const a = arsenalCard(s, me, 'navigation');
    expect(a.state).toBe('building');
    expect(a.building).toBe('port');
    expect(a.reason).toBe('Build a Port first');
    expect(a.price.gold).toBeGreaterThan(0);
    expect(a.price.oil).toBeGreaterThan(0);
    expect(howToGet(s, me, 'navigation')).toBe('Build a Port, then buy Navigation in the Arsenal (T)');
    addBuilding(s, 'port', 1, 5 * 40 + 5);
    expect(arsenalCard(s, me, 'navigation').state).toBe('buy');
    expect(howToGet(s, me, 'navigation')).toBe('Buy Navigation in the Arsenal (T)');
  });

  it('Flight needs no Airfield (it unlocks it), the air paths after it do', () => {
    const s = rich();
    const me = s.players[1];
    give(s, 'logistics');
    const f = arsenalCard(s, me, 'flight');
    expect(f.price.needs).toBeUndefined();
    expect(f.state).toBe('buy');
    give(s, 'flight');
    const g = arsenalCard(s, me, 'groundAttack');
    expect(g.state).toBe('building');
    expect(g.reason).toBe('Build an Airfield first');
    // a research prerequisite in the other tab comes first in the how-to line
    const s2 = rich();
    expect(howToGet(s2, s2.players[1], 'flight')).toBe('Research Logistics, then buy Flight in the Arsenal (T)');
    expect(techFirst('flight')).toBe('Buy Flight in the Arsenal first');
    expect(techFirst('rocketry')).toBe('Research Rocketry first');
  });

  it('marks the short resource and keeps the Buy pill (poor), with a prerequisite missing it is locked', () => {
    const s = rich();
    const me = s.players[1];
    addBuilding(s, 'port', 1, 5 * 40 + 5);
    me.oil = 0;
    const a = arsenalCard(s, me, 'navigation');
    expect(a.state).toBe('poor');
    expect(a.short).toEqual({ gold: false, iron: false, oil: true });
    expect(a.reason).toMatch(/oil/);
    const html = priceHtml(a);
    expect(html).toMatch(/p-oil short/);
    expect(html).toMatch(/p-gold"/);
    expect(html).toMatch(/<svg/);
    expect(html).toMatch(new RegExp(`${a.price.seconds} s`));
    expect(arsenalCard(s, me, 'destroyers').state).toBe('prereq');
  });

  it('an order shows a countdown, several run at once, then the item is in service', () => {
    const s = rich();
    const me = s.players[1];
    addBuilding(s, 'port', 1, 5 * 40 + 5);
    addBuilding(s, 'factory', 1, 10 * 40 + 10);
    give(s, 'metallurgy');
    expect(procure(s, 1, 'navigation').ok).toBe(true);
    expect(procure(s, 1, 'mechanization').ok).toBe(true);
    expect(onOrder(me, 'navigation')).toBe(true);
    const o = ordersOf(s, me);
    expect(o.map((x) => x.tech).sort()).toEqual(['mechanization', 'navigation']);
    const nav = arsenalCard(s, me, 'navigation');
    expect(nav.state).toBe('ordered');
    expect(nav.order!.frac).toBe(0);
    expect(nav.order!.left).toBeCloseTo(nav.price.seconds, 5);
    for (let k = 0; k < 5 * TICKS_PER_SECOND; k++) tick(s);
    const mid = arsenalCard(s, me, 'navigation');
    expect(mid.order!.frac).toBeGreaterThan(0);
    expect(mid.order!.frac).toBeLessThan(1);
    expect(mid.order!.left).toBeCloseTo(nav.price.seconds - 5, 0);
    for (let k = 0; k < (nav.price.seconds + 1) * TICKS_PER_SECOND; k++) tick(s);
    expect(arsenalCard(s, me, 'navigation').state).toBe('done');
    expect(ordersOf(s, me).some((x) => x.tech === 'navigation')).toBe(false);
  });

  it('ordering a fork root locks the other branch at once', () => {
    const s = rich();
    const me = s.players[1];
    addBuilding(s, 'port', 1, 5 * 40 + 5);
    give(s, 'navigation');
    expect(arsenalCard(s, me, 'submarines').state).toBe('buy');
    expect(procure(s, 1, 'destroyers').ok).toBe(true);
    const sub = arsenalCard(s, me, 'submarines');
    expect(sub.state).toBe('chose-other');
    expect(sub.chose).toBe('destroyers');
    expect(arsenalCard(s, me, 'carriers').state).toBe('chose-other');
    expect(arsenalCard(s, me, 'battleships').state).toBe('prereq');
  });

  it('the mastery counter counts orders and a third mastery is capped', () => {
    const s = rich();
    const me = s.players[1];
    addBuilding(s, 'port', 1, 5 * 40 + 5);
    addBuilding(s, 'factory', 1, 10 * 40 + 10);
    addBuilding(s, 'airfield', 1, 15 * 40 + 15);
    give(s, 'navigation', 'destroyers', 'battleships', 'metallurgy', 'mechanization', 'lightTanks', 'deepRaids', 'logistics', 'flight', 'groundAttack', 'jetEngines');
    expect(masteryCounter(me).text).toBe('Mastery 0 of 2');
    expect(procure(s, 1, 'navalMastery').ok).toBe(true);
    expect(procure(s, 1, 'armorMastery').ok).toBe(true);
    const m = masteryCounter(me);
    expect(m.text).toBe('Mastery 2 of 2 · Navy, Armor');
    expect(m.full).toBe(true);
    expect(masteryCapped(me, 'airMastery')).toBe('Cap used: Navy, Armor');
    expect(arsenalCard(s, me, 'airMastery').state).toBe('capped');
    expect(arsenalCard(s, me, 'navalMastery').state).toBe('ordered');
  });

  it('NEXT on the Arsenal tab is something buyable now, never an item on order', () => {
    const s = rich();
    const me = s.players[1];
    const ars = panelLayout('arsenal');
    // no Port or Factory, Logistics missing: nothing can be bought
    expect(nextAffordable(s, me, ars)).toBeNull();
    give(s, 'logistics');
    expect(nextAffordable(s, me, ars)).toBe('flight');
    expect(procure(s, 1, 'flight').ok).toBe(true);
    expect(nextAffordable(s, me, ars)).toBeNull();
    addBuilding(s, 'port', 1, 5 * 40 + 5);
    expect(nextAffordable(s, me, ars)).toBe('navigation');
  });
});
