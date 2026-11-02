// Arsenal procurement (src/sim/procurement.ts): Arsenal items are bought with gold + iron / oil and delivered after a
// timer; Research-tab techs stay science-based.
import { describe, expect, it } from 'vitest';
import { applyAction } from '../src/sim/actions';
import { ARSENAL_ROWS, isArsenalTech, masteryPillars } from '../src/sim/arsenal';
import { markBuildingsChanged } from '../src/sim/buildings';
import { ARSENAL_PRICES, BUILDINGS, TECHS, TICKS_PER_SECOND } from '../src/sim/config';
import { hashState } from '../src/sim/hash';
import { computeCoastAndLand } from '../src/sim/mapgen';
import { arsenalPrice, buildingNeedOf, canProcure, procure, procurementOf } from '../src/sim/procurement';
import { tick } from '../src/sim/sim';
import { createGame, newId } from '../src/sim/state';
import { canResearch } from '../src/sim/tech';
import { techStatus, techStatusReason } from '../src/sim/techtree';
import { navalVariantsOf } from '../src/sim/variants';
import { Terrain } from '../src/sim/types';
import type { Building, BuildingType, GameState, TechId } from '../src/sim/types';
import { validateAction } from '../server/validate';
import { claimRect, makeFlatGame, testSettings } from './helpers';

const at = (s: GameState, x: number, y: number): number => y * s.map.width + x;
function give(s: GameState, pid: number, ...techs: TechId[]): void {
  for (const t of techs) if (!s.players[pid].techs.includes(t)) s.players[pid].techs.push(t);
}
function addBuilding(s: GameState, type: BuildingType, owner: number, tile: number, level = 1): Building {
  const id = newId(s);
  const b: Building = { id, type, owner, tile, level, buildLeft: 0, upgradeLeft: 0, fighters: 0, bombers: 0, cooldown: 0, dropCooldown: 0, disabledUntil: 0, hp: 1, queuedLevels: 0 };
  s.buildings.set(id, b);
  s.map.building[tile] = id + 1;
  markBuildingsChanged(s);
  return b;
}
function run(s: GameState, n: number): void {
  for (let k = 0; k < n; k++) tick(s);
}
/** 80x40: land y 0..19 (player 1 x 0..39, player 2 x 40..79), sea y 20..39; AIs frozen; rich; Port, Factory, Airfield. */
function game(seed = 4): GameState {
  const s = makeFlatGame(80, 40, 3, { human: true, seed });
  for (let y = 20; y < 40; y++) for (let x = 0; x < 80; x++) s.map.terrain[at(s, x, y)] = Terrain.DeepWater;
  computeCoastAndLand(s.map);
  claimRect(s, 1, 0, 0, 39, 19);
  claimRect(s, 2, 40, 0, 79, 19);
  s.admin = { aiPassive: [], godMode: [], aiFrozen: true, revealIntel: [] };
  s.settings.victoryLandShare = 0.99;
  for (const p of s.players) {
    if (p.id === 0) continue;
    p.gold = 1e6;
    p.iron = 1e5;
    p.oil = 1e5;
    p.science = 0;
  }
  addBuilding(s, 'port', 1, at(s, 20, 19));
  addBuilding(s, 'factory', 1, at(s, 5, 5));
  addBuilding(s, 'airfield', 1, at(s, 12, 8));
  return s;
}
/** Ticks from ordering until the delivery has happened (delivered in the tick processed at readyTick). */
const ticksOf = (t: TechId): number => Math.round(arsenalPrice(game(), 1, t).seconds * TICKS_PER_SECOND) + 1;

describe('prices', () => {
  it('every Arsenal item has a price by tier; mastery is the biggest; Research-tab techs have none', () => {
    const s = game();
    for (const row of ARSENAL_ROWS) {
      for (const it of row.items) {
        const pr = arsenalPrice(s, 1, it.tech);
        const tier = ARSENAL_PRICES.tiers[it.tier];
        expect(pr.gold).toBe(tier.gold);
        expect(pr.iron + pr.oil).toBeCloseTo(tier.resource, -1);
        expect(pr.seconds).toBeGreaterThanOrEqual(20);
        expect(pr.seconds).toBeLessThanOrEqual(45);
      }
    }
    // Armor pays iron only; navy and air oil plus some iron.
    expect(arsenalPrice(s, 1, 'lightTanks')).toMatchObject({ oil: 0 });
    expect(arsenalPrice(s, 1, 'lightTanks').iron).toBeGreaterThan(0);
    for (const t of ['destroyers', 'heavyBombers'] as TechId[]) {
      const pr = arsenalPrice(s, 1, t);
      expect(pr.oil).toBeGreaterThan(pr.iron);
      expect(pr.iron).toBeGreaterThan(0);
    }
    // The row's first item (Navigation, Mechanization, Flight) is paid in iron only (no oil wells needed).
    for (const t of ['navigation', 'mechanization', 'flight'] as TechId[]) expect(arsenalPrice(s, 1, t)).toMatchObject({ oil: 0, iron: ARSENAL_PRICES.tiers[1].resource });
    // Prices rise by tier; mastery is the big purchase.
    const g = (t: TechId): number => arsenalPrice(s, 1, t).gold;
    expect(g('navigation')).toBeLessThan(g('destroyers'));
    expect(g('destroyers')).toBeLessThan(g('battleships'));
    expect(g('battleships') * 2).toBeLessThan(g('navalMastery'));
    expect(arsenalPrice(s, 1, 'navalMastery').seconds).toBe(45);
    expect(arsenalPrice(s, 1, 'banking')).toEqual({ gold: 0, iron: 0, oil: 0, seconds: 0 });
  });
});

describe('building needs', () => {
  it('navy needs a Port, armor a Factory, air an Airfield; Flight (which unlocks the Airfield) needs none', () => {
    expect(buildingNeedOf('navigation')).toBe('port');
    expect(buildingNeedOf('submarines')).toBe('port');
    expect(buildingNeedOf('navalMines')).toBe('port');
    expect(buildingNeedOf('mechanization')).toBe('factory');
    expect(buildingNeedOf('heavyTanks')).toBe('factory');
    expect(buildingNeedOf('amphibiousTanks')).toBe('factory');
    expect(buildingNeedOf('mechInfantry')).toBe('factory');
    expect(buildingNeedOf('flight')).toBeUndefined();
    expect(buildingNeedOf('groundAttack')).toBe('airfield');
    expect(buildingNeedOf('airMastery')).toBe('airfield');
    expect(buildingNeedOf('reconPlanes')).toBe('airfield');
    expect(arsenalPrice(game(), 1, 'navigation').needs).toBe('port');
  });

  it('no item needs a building that only it (or something after it) unlocks', () => {
    for (const row of ARSENAL_ROWS) {
      for (const it of row.items) {
        const b = buildingNeedOf(it.tech);
        if (!b) continue;
        const bt = BUILDINGS[b].tech;
        if (!bt) continue;
        // The building's tech must be obtainable without the item: not the item, and the item is not among its prerequisites.
        const chain = new Set<TechId>();
        const walk = (x: TechId): void => {
          if (chain.has(x)) return;
          chain.add(x);
          for (const r of TECHS[x].requires) walk(r);
          for (const r of TECHS[x].requiresAny ?? []) walk(r);
        };
        walk(bt);
        expect(chain.has(it.tech), `${it.tech} needs ${b}, which needs ${bt}`).toBe(false);
      }
    }
  });

  it('refuses without the building, and accepts once it is built', () => {
    const s = game();
    for (const b of [...s.buildings.values()]) if (b.type === 'factory') s.buildings.delete(b.id);
    markBuildingsChanged(s);
    give(s, 1, 'metallurgy');
    expect(canProcure(s, 1, 'mechanization')).toEqual({ ok: false, reason: 'Needs a Factory' });
    expect(canProcure(s, 1, 'flight').reason).toMatch(/Logistics/); // prerequisites first
    give(s, 1, 'logistics');
    expect(canProcure(s, 1, 'flight').ok).toBe(true);
    addBuilding(s, 'factory', 1, at(s, 5, 5));
    expect(canProcure(s, 1, 'mechanization').ok).toBe(true);
    // An unfinished building doesn't count.
    for (const b of s.buildings.values()) if (b.type === 'port') b.buildLeft = 50;
    markBuildingsChanged(s);
    expect(canProcure(s, 1, 'navigation').reason).toBe('Needs a Port');
  });
});

describe('ordering and delivery', () => {
  it('pays gold, iron and oil; delivers after the timer with the same effects as research', () => {
    const s = game();
    const p = s.players[1];
    const before = { gold: p.gold, iron: p.iron, oil: p.oil };
    const pr = arsenalPrice(s, 1, 'navigation');
    expect(applyAction(s, 1, { type: 'procure', tech: 'navigation' })).toEqual({ ok: true });
    expect(p.gold).toBe(before.gold - pr.gold);
    expect(p.iron).toBe(before.iron - pr.iron);
    expect(p.oil).toBe(before.oil - pr.oil);
    expect(procurementOf(s, 1)).toEqual([{ tech: 'navigation', readyTick: s.tick + ticksOf('navigation') - 1 }]);
    expect(techStatus(s, 1, 'navigation')).toBe('researching');
    expect(techStatusReason(s, 1, 'navigation')).toBe('Navigation is on order');
    expect(canProcure(s, 1, 'navigation').reason).toBe('Navigation is already on order');
    expect(p.researching).toBeNull(); // research is untouched
    run(s, ticksOf('navigation') - 1);
    expect(p.techs.includes('navigation')).toBe(false);
    run(s, 1);
    expect(p.techs.includes('navigation')).toBe(true);
    expect(procurementOf(s, 1)).toEqual([]);
    expect(s.events.some((e) => e.kind === 'researchDone' && e.message === 'Delivered: Navigation')).toBe(true);
    // Effects: what Navigation unlocks (warships) works now, the next item opens.
    expect(applyAction(s, 1, { type: 'buildWarship', port: at(s, 20, 19) })).toEqual({ ok: true });
    expect(techStatus(s, 1, 'destroyers')).toBe('available');
    expect(applyAction(s, 1, { type: 'procure', tech: 'destroyers' }).ok).toBe(true);
    run(s, ticksOf('destroyers'));
    expect(navalVariantsOf(s, 1)).toContain('destroyer');
  });

  it('several items can be on order at once, each with its own timer; research runs alongside', () => {
    const s = game();
    const p = s.players[1];
    give(s, 1, 'metallurgy', 'logistics');
    expect(applyAction(s, 1, { type: 'procure', tech: 'navigation' }).ok).toBe(true);
    expect(applyAction(s, 1, { type: 'procure', tech: 'mechanization' }).ok).toBe(true);
    expect(applyAction(s, 1, { type: 'procure', tech: 'flight' }).ok).toBe(true);
    expect(applyAction(s, 1, { type: 'research', tech: 'agriculture' }).ok).toBe(true);
    expect(procurementOf(s, 1).map((o) => o.tech)).toEqual(['navigation', 'mechanization', 'flight']);
    // Prerequisites must be delivered, not just ordered.
    expect(canProcure(s, 1, 'destroyers').reason).toBe('Needs Navigation');
    run(s, Math.max(ticksOf('navigation'), ticksOf('mechanization'), ticksOf('flight')));
    for (const t of ['navigation', 'mechanization', 'flight'] as TechId[]) expect(p.techs).toContain(t);
    expect(p.researching === 'agriculture' || p.techs.includes('agriculture')).toBe(true);
  });

  it('refuses without gold, iron or oil, and charges nothing then', () => {
    const s = game();
    const p = s.players[1];
    give(s, 1, 'navigation');
    const pr = arsenalPrice(s, 1, 'destroyers');
    p.oil = pr.oil - 1;
    expect(canProcure(s, 1, 'destroyers').reason).toBe(`Not enough oil (${pr.oil})`);
    p.oil = 1e5;
    p.iron = 0;
    expect(canProcure(s, 1, 'destroyers').reason).toBe(`Not enough iron (${pr.iron})`);
    p.iron = 1e5;
    p.gold = 10;
    expect(applyAction(s, 1, { type: 'procure', tech: 'destroyers' })).toEqual({ ok: false, reason: `Not enough gold (${pr.gold})` });
    expect(p.gold).toBe(10);
    expect(p.oil).toBe(1e5);
    expect(procurementOf(s, 1)).toEqual([]);
  });

  it("'research' on an Arsenal item is refused with a pointer to buying it; 'procure' on a Research tech too", () => {
    const s = game();
    const r = applyAction(s, 1, { type: 'research', tech: 'navigation' });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/not researched: buy it in the Arsenal tab/);
    expect(canResearch(s, 1, 'destroyers').reason).toMatch(/Arsenal tab/);
    expect(applyAction(s, 1, { type: 'procure', tech: 'agriculture' }).reason).toMatch(/Research tab/);
    expect(applyAction(s, 1, { type: 'procure', tech: 'toString' as TechId }).ok).toBe(false);
    for (const row of ARSENAL_ROWS) for (const it of row.items) expect(isArsenalTech(it.tech)).toBe(true);
  });

  it('research off: nothing can be ordered', () => {
    const s = game();
    s.settings.modifiers = { ...s.settings.modifiers, research: 'off' } as never;
    expect(canProcure(s, 1, 'navigation').ok).toBe(false);
  });
});

describe('forks and mastery', () => {
  it('ordering one side of a fork locks the other at once', () => {
    const s = game();
    give(s, 1, 'navigation');
    expect(applyAction(s, 1, { type: 'procure', tech: 'submarines' }).ok).toBe(true);
    expect(techStatus(s, 1, 'destroyers')).toBe('locked-choice');
    expect(techStatus(s, 1, 'battleships')).toBe('locked-choice');
    expect(canProcure(s, 1, 'destroyers').reason).toBe('You chose Submarines; Destroyers is locked');
    run(s, ticksOf('submarines'));
    expect(techStatus(s, 1, 'destroyers')).toBe('locked-choice');
    expect(techStatus(s, 1, 'carriers')).toBe('available');
  });

  it('the 2-mastery cap counts orders', () => {
    const s = game();
    const p = s.players[1];
    give(s, 1, 'navigation', 'mechanization', 'flight', 'destroyers', 'battleships', 'lightTanks', 'deepRaids', 'groundAttack', 'jetEngines');
    expect(applyAction(s, 1, { type: 'procure', tech: 'navalMastery' }).ok).toBe(true);
    expect(applyAction(s, 1, { type: 'procure', tech: 'armorMastery' }).ok).toBe(true);
    expect(masteryPillars(p)).toEqual(['navy', 'armor']);
    expect(techStatus(s, 1, 'airMastery')).toBe('locked-choice');
    expect(canProcure(s, 1, 'airMastery').reason).toMatch(/^Mastery 2 of 2 used \(Navy, Armor\)/);
    run(s, ticksOf('navalMastery'));
    expect(p.techs).toEqual(expect.arrayContaining(['navalMastery', 'armorMastery']));
    expect(canProcure(s, 1, 'airMastery').ok).toBe(false);
  });
});

describe('grants', () => {
  it('admin unlock and finishResearch deliver orders; an eliminated player loses its orders', () => {
    const s = game();
    const p = s.players[1];
    give(s, 1, 'metallurgy');
    procure(s, 1, 'navigation');
    procure(s, 1, 'mechanization');
    s.admin = { ...s.admin!, aiFrozen: true };
    // finishResearch (owner console) delivers everything on order.
    expect(applyAction(s, 1, { type: 'admin', op: 'finishResearch', player: 1 } as never).ok).toBe(true);
    expect(p.techs).toEqual(expect.arrayContaining(['navigation', 'mechanization']));
    expect(procurementOf(s, 1)).toEqual([]);
    // An order of a tech granted meanwhile is dropped (no double entry).
    procure(s, 1, 'destroyers');
    give(s, 1, 'destroyers');
    run(s, 1);
    expect(procurementOf(s, 1)).toEqual([]);
    expect(p.techs.filter((t) => t === 'destroyers').length).toBe(1);
  });
});

describe('validation and determinism', () => {
  it('the server accepts procure with a known tech only', () => {
    expect(validateAction({ type: 'procure', tech: 'destroyers' })).toEqual({ ok: true, value: { type: 'procure', tech: 'destroyers' } });
    expect(validateAction({ type: 'procure', tech: 'nope' }).ok).toBe(false);
    expect(validateAction({ type: 'procure' }).ok).toBe(false);
  });

  it('orders are hashed, and the same orders give the same hashes', () => {
    const play = (): string[] => {
      const s = game(9);
      const out: string[] = [];
      give(s, 1, 'metallurgy');
      out.push(String(hashState(s)));
      procure(s, 1, 'navigation');
      out.push(String(hashState(s)));
      run(s, 30);
      procure(s, 1, 'mechanization');
      run(s, 400);
      out.push(String(hashState(s)));
      return out;
    };
    const a = play();
    expect(a[1]).not.toBe(a[0]);
    expect(play()).toEqual(a);
  });

  it('AI games stay deterministic with AI purchases (same seed, same hash at 6 min) and AIs buy Arsenal items', () => {
    const playAI = (): { hash: string; bought: number } => {
      const s = createGame(testSettings({ seed: 21 }));
      let bought = 0;
      for (let k = 0; k < 6 * 60 * TICKS_PER_SECOND; k++) {
        tick(s);
        for (const p of s.players) bought = Math.max(bought, p.techs.filter(isArsenalTech).length + (p.procuring?.length ?? 0));
      }
      return { hash: String(hashState(s)), bought };
    };
    const a = playAI();
    expect(playAI()).toEqual(a);
    expect(a.bought).toBeGreaterThan(0);
  }, 120000);
});
