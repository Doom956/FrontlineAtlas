// Supply lines and the decisions around them: strategic wings and AI strikes go for the hub that cuts the most supply
// during a push, the AI builds a second route (and a SAM) for a front that hangs on one hub, the advisor says so.
import { describe, expect, it } from 'vitest';
import { applyAction } from '../src/sim/actions';
import { aiBuildSecondRoute, aiManualStrike, aiSupplyRoute } from '../src/sim/ai';
import { suggestions } from '../src/sim/advisor';
import { updateAir } from '../src/sim/airwings';
import { buildingAt, buildingsOf, markBuildingsChanged } from '../src/sim/buildings';
import { launchAttack } from '../src/sim/combat';
import { newId } from '../src/sim/state';
import { hubCutValue, hubDamaged, refreshSupplyLines, supplyRiskOf } from '../src/sim/supplylines';
import { buildAircraft, updateUnits } from '../src/sim/units';
import type { Building, BuildingType, GameState, TechId } from '../src/sim/types';
import { claimRect, makeFlatGame } from './helpers';

const at = (s: GameState, x: number, y: number): number => y * s.map.width + x;
function addBuilding(s: GameState, type: BuildingType, owner: number, tile: number, level = 1): Building {
  const id = newId(s);
  const b: Building = { id, type, owner, tile, level, buildLeft: 0, upgradeLeft: 0, fighters: 0, bombers: 0, cooldown: 0, dropCooldown: 0, disabledUntil: 0, hp: 1, queuedLevels: 0 };
  s.buildings.set(id, b);
  s.map.building[tile] = id + 1;
  markBuildingsChanged(s);
  return b;
}
function give(s: GameState, pid: number, ...techs: TechId[]): void {
  for (const t of techs) if (!s.players[pid].techs.includes(t)) s.players[pid].techs.push(t);
}

/**
 * 300 x 60 plain: 1 owns x 0..199 (capital 10,30; a factory at 90,30 carries two forts at 190,30 and 185,50 and a big
 * city at 70,10 that is a richer raid target), 2 owns x 200..299 with an airfield at 210,30. Rich.
 */
function game(human1 = true): { s: GameState; factory: Building; city: Building; af: Building } {
  const s = makeFlatGame(300, 60, 2, { human: human1, seed: 9 });
  claimRect(s, 1, 0, 0, 199, 59);
  claimRect(s, 2, 200, 0, 299, 59);
  s.settings.victoryLandShare = 0.99; // no tick() runs here: the AIs only act through the calls of the tests
  s.players[1].capital = at(s, 10, 30);
  for (const p of s.players) {
    if (p.id === 0) continue;
    p.gold = 1e6;
    p.iron = 1e5;
    p.oil = 1e5;
    p.troops = { infantry: 300000, armor: 0, artillery: 0 };
  }
  give(s, 2, 'flight');
  const factory = addBuilding(s, 'factory', 1, at(s, 90, 30));
  addBuilding(s, 'fort', 1, at(s, 190, 30));
  addBuilding(s, 'fort', 1, at(s, 185, 50));
  const city = addBuilding(s, 'city', 1, at(s, 70, 10), 4);
  const af = addBuilding(s, 'airfield', 2, at(s, 210, 30));
  for (let k = 0; k < 3; k++) expect(buildAircraft(s, 2, af.tile, 'bomber').ok).toBe(true);
  refreshSupplyLines(s, 1);
  return { s, factory, city, af };
}
/** Bomber aims after the first strategic sortie. */
function firstSortie(s: GameState, af: Building, target: number): number[] {
  const r = applyAction(s, 2, { type: 'setAirMission', airfield: af.tile, mission: 'strategic', target });
  expect(r.reason ?? 'ok').toBe('ok');
  for (let k = 0; k < 200 && !s.units.some((u) => u.type === 'bomber'); k++) {
    updateUnits(s);
    updateAir(s);
    s.tick++;
  }
  return s.units.filter((u) => u.type === 'bomber').map((u) => u.target);
}

describe('strategic wings and supply hubs', () => {
  it('during a push, the first bomber goes for the hub that cuts the most supply near the front', () => {
    const { s, factory, city, af } = game();
    expect(launchAttack(s, 2, at(s, 199, 30), { infantry: 20000, armor: 0, artillery: 0 }).ok).toBe(true);
    const aims = firstSortie(s, af, city.tile);
    expect(aims[0]).toBe(factory.tile);
  });

  it('without a push, the old raid targets come first', () => {
    const { s, city, af } = game();
    s.warMemory = [1, 2, 1e9]; // at war, no attack running
    const aims = firstSortie(s, af, city.tile);
    expect(aims.length).toBeGreaterThan(0);
    expect(aims[0]).toBe(city.tile);
  });

  it('a manual bomb on a hub damages it (or wrecks it), and the forts behind it are cut', () => {
    const { s, factory, af } = game();
    s.warMemory = [1, 2, 1e9];
    expect(hubCutValue(s, 2, factory.tile)).toBe(2);
    expect(applyAction(s, 2, { type: 'bomb', airfield: af.tile, tile: factory.tile }).ok).toBe(true);
    for (let k = 0; k < 400 && !s.events.some((e) => e.kind === 'bombing'); k++) {
      updateUnits(s);
      updateAir(s);
      s.tick++;
    }
    const wrecked = buildingAt(s, factory.tile) !== factory;
    expect(wrecked || hubDamaged(s, 1, factory.tile)).toBe(true);
    if (!wrecked) expect(s.supplyNet!.cut[1]!.length).toBe(2);
  });

  it('the AI aims its manual bombs at that hub during a push', () => {
    const { s, factory, af } = game();
    expect(launchAttack(s, 2, at(s, 199, 30), { infantry: 20000, armor: 0, artillery: 0 }).ok).toBe(true);
    expect(aiManualStrike(s, 2, af.tile).tile).toBe(factory.tile);
  });
});

describe('a front that hangs on one hub', () => {
  it('the AI builds a fort that adds a second route, and plans a SAM by the hub with Radar', () => {
    const { s, factory } = game(false);
    expect(supplyRiskOf(s, 1)?.hub).toBe(factory.tile);
    give(s, 1, 'radar');
    const plan = aiSupplyRoute(s, 1)!;
    expect(plan.hub).toBe(factory.tile);
    expect(plan.fort.length).toBeGreaterThan(0);
    expect(plan.sam.length).toBeGreaterThan(0);
    const before = buildingsOf(s, 1, 'fort').length;
    expect(aiBuildSecondRoute(s, 1)).toBe(true);
    const forts = buildingsOf(s, 1, 'fort');
    expect(forts.length).toBe(before + 1);
    const fresh = forts.find((b) => b.buildLeft > 0)!;
    // While it is going up, no second order.
    expect(aiSupplyRoute(s, 1)!.fort).toEqual([]);
    fresh.buildLeft = 0;
    markBuildingsChanged(s);
    refreshSupplyLines(s, 1);
    const risk = supplyRiskOf(s, 1);
    expect(risk?.hub === factory.tile).toBe(false);
  });

  it('the advisor names the front and the fix', () => {
    const { s } = game(true);
    const tip = suggestions(s, 1).find((g) => g.id === 'supply-second-route');
    expect(tip?.text).toBe('Your eastern front hangs on one hub: build a fort to add a second route');
    expect(tip?.building).toBe('fort');
  });
});
