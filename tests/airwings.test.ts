// Air wings (airwings.ts): standing missions, support zones, strategic raids, superiority patrols, escorts, AI use.
import { describe, expect, it } from 'vitest';
import { applyAction } from '../src/sim/actions';
import {
  aiAirWings,
  airMissionOf,
  airParadropMul,
  airRaidIncomeMul,
  airSupportCut,
  airWingSize,
  airZones,
  updateAir,
  wingOf,
} from '../src/sim/airwings';
import { markBuildingsChanged } from '../src/sim/buildings';
import { launchAttack, tileFightCost } from '../src/sim/combat';
import { AIR, TICKS_PER_SECOND } from '../src/sim/config';
import { formAlliance } from '../src/sim/diplomacy';
import { goldIncome } from '../src/sim/economy';
import { hashState } from '../src/sim/hash';
import { newId } from '../src/sim/state';
import { buildAircraft, launchBomber, paradropMaxTroops, updateUnits } from '../src/sim/units';
import type { Building, BuildingType, GameState, TechId, Troops } from '../src/sim/types';
import { claimRect, makeFlatGame, troopSum } from './helpers';

const inf = (n: number): Troops => ({ infantry: n, armor: 0, artillery: 0 });
const at = (s: GameState, x: number, y: number): number => y * s.map.width + x;

function addBuilding(s: GameState, type: BuildingType, owner: number, tile: number, level = 1): Building {
  const id = newId(s);
  const b: Building = { id, type, owner, tile, level, buildLeft: 0, upgradeLeft: 0, fighters: 0, bombers: 0, cooldown: 0, dropCooldown: 0, disabledUntil: 0, hp: 1, queuedLevels: 0 };
  s.buildings.set(id, b);
  s.map.building[tile] = id + 1;
  markBuildingsChanged(s);
  return b;
}
function giveTech(s: GameState, id: number, ...techs: TechId[]): void {
  s.players[id].techs.push(...techs);
}

/** Two nations side by side on a 100 x 30 plain: 1 owns x 0..49, 2 owns x 50..99. Rich, with Flight. */
function frontGame(): GameState {
  const s = makeFlatGame(100, 30, 2, { seed: 11 });
  claimRect(s, 1, 0, 0, 49, 29);
  claimRect(s, 2, 50, 0, 99, 29);
  for (const p of s.players) {
    if (p.id === 0) continue;
    p.gold = 100000;
    p.iron = 10000;
    p.oil = 10000;
    p.troops = inf(200000);
  }
  giveTech(s, 1, 'flight');
  giveTech(s, 2, 'flight');
  return s;
}
function airfieldWith(s: GameState, owner: number, tile: number, bombers: number, fighters = 0): Building {
  const b = addBuilding(s, 'airfield', owner, tile);
  for (let k = 0; k < bombers; k++) expect(buildAircraft(s, owner, tile, 'bomber').ok).toBe(true);
  for (let k = 0; k < fighters; k++) expect(buildAircraft(s, owner, tile, 'fighter').ok).toBe(true);
  return b;
}
/** Ticks units and air (no combat or economy) until pred() holds or maxTicks. */
function run(s: GameState, pred: () => boolean, maxTicks = 3000): number {
  let k = 0;
  for (; k < maxTicks && !pred(); k++) {
    updateUnits(s);
    updateAir(s);
    s.tick++;
  }
  return k;
}

describe('setAirMission', () => {
  it('validates tech, airfield, target, alliances and range', () => {
    const s = frontGame();
    const af = airfieldWith(s, 1, at(s, 30, 15), 3);
    const enemy = at(s, 55, 15);
    s.players[1].techs = [];
    expect(applyAction(s, 1, { type: 'setAirMission', airfield: af.tile, mission: 'support', target: enemy }).ok).toBe(false);
    giveTech(s, 1, 'flight');
    expect(applyAction(s, 1, { type: 'setAirMission', airfield: at(s, 31, 15), mission: 'support', target: enemy }).ok).toBe(false); // no airfield
    expect(applyAction(s, 1, { type: 'setAirMission', airfield: af.tile, mission: 'support' }).ok).toBe(false); // no target
    expect(applyAction(s, 1, { type: 'setAirMission', airfield: af.tile, mission: 'support', target: at(s, 5, 5) }).ok).toBe(false); // own land, no front near
    // A click on our side right at the front picks the nearest enemy tile.
    expect(applyAction(s, 1, { type: 'setAirMission', airfield: af.tile, mission: 'support', target: at(s, 48, 15) }).ok).toBe(true);
    const wing = wingOf(s, af)!;
    expect(s.map.owner[wing.target]).toBe(2);
    expect(wing.targetOwner).toBe(2);
    expect(airMissionOf(s, af)).toBe('support');
    formAlliance(s, 1, 2);
    expect(applyAction(s, 1, { type: 'setAirMission', airfield: af.tile, mission: 'strategic', target: enemy }).ok).toBe(false);
    expect(applyAction(s, 1, { type: 'setAirMission', airfield: af.tile, mission: 'idle' }).ok).toBe(true);
    expect(airMissionOf(s, af)).toBe('idle');
  });

  it('airfield -1 sets every own airfield that reaches the target', () => {
    const s = frontGame();
    const near = airfieldWith(s, 1, at(s, 40, 10), 1);
    const near2 = airfieldWith(s, 1, at(s, 40, 20), 1);
    expect(applyAction(s, 1, { type: 'setAirMission', airfield: -1, mission: 'support', target: at(s, 52, 15), refill: true }).ok).toBe(true);
    expect(airMissionOf(s, near)).toBe('support');
    expect(airMissionOf(s, near2)).toBe('support');
    expect(wingOf(s, near)!.refill).toBe(true);
  });

  it('wing size grows with airfield level and Jet Engines', () => {
    const s = frontGame();
    const af = airfieldWith(s, 1, at(s, 30, 15), 0);
    const base = airWingSize(s, af);
    expect(base).toBe(AIR.wingBase);
    af.level = 3;
    expect(airWingSize(s, af)).toBe(AIR.wingBase + 2 * AIR.wingPerLevel);
    giveTech(s, 1, 'jetEngines');
    expect(airWingSize(s, af)).toBe(AIR.wingBase + 2 * AIR.wingPerLevel + AIR.wingJets);
  });
});

describe('support missions', () => {
  it('fly while at war, make a support zone that cuts defence and kills defenders, then come home', () => {
    const s = frontGame();
    const af = airfieldWith(s, 1, at(s, 30, 15), 3);
    const front = at(s, 51, 15);
    const fort = addBuilding(s, 'fort', 2, at(s, 53, 15));
    expect(applyAction(s, 1, { type: 'setAirMission', airfield: af.tile, mission: 'support', target: front }).ok).toBe(true);
    // Not at war yet: nothing flies.
    run(s, () => false, 3 * TICKS_PER_SECOND);
    expect(s.units.length).toBe(0);
    expect(af.bombers).toBe(3);

    const lossBefore = tileFightCost(s, 1, inf(10000), 2, front).loss;
    expect(launchAttack(s, 1, at(s, 50, 15), inf(5000)).ok).toBe(true);
    const army = troopSum(s.players[2].troops);
    run(s, () => s.units.length > 0, 5 * TICKS_PER_SECOND);
    expect(s.units.filter((u) => u.type === 'bomber' && u.mission === 1).length).toBe(3);
    run(s, () => airZones(s).length > 0);
    const z = airZones(s)[0];
    expect(z.owner).toBe(1);
    expect(z.victim).toBe(2);
    run(s, () => s.units.length === 0);
    expect(airZones(s)[0].strength).toBe(3);
    expect(af.bombers).toBe(3);
    expect(troopSum(s.players[2].troops)).toBeLessThan(army);
    expect(fort.disabledUntil).toBeGreaterThan(s.tick);
    const cut = airSupportCut(s, 1, front);
    expect(cut).toBeGreaterThan(0.2);
    expect(cut).toBeLessThanOrEqual(AIR.supportMaxCut);
    expect(airSupportCut(s, 2, front)).toBe(0); // only the owner's attacks
    expect(airSupportCut(s, 1, at(s, 95, 15))).toBe(0); // only inside the zone
    expect(tileFightCost(s, 1, inf(10000), 2, front).loss).toBeLessThan(lossBefore);
    expect(wingOf(s, af)!.sorties).toBe(1);
  });

  it('the zone expires once the wing stops', () => {
    const s = frontGame();
    const af = airfieldWith(s, 1, at(s, 30, 15), 2);
    expect(applyAction(s, 1, { type: 'setAirMission', airfield: af.tile, mission: 'support', target: at(s, 51, 15) }).ok).toBe(true);
    expect(launchAttack(s, 1, at(s, 50, 15), inf(5000)).ok).toBe(true);
    run(s, () => airZones(s).length > 0);
    expect(applyAction(s, 1, { type: 'setAirMission', airfield: af.tile, mission: 'idle' }).ok).toBe(true);
    run(s, () => airZones(s).length === 0, (AIR.supportSeconds + 2) * TICKS_PER_SECOND);
    expect(airZones(s).length).toBe(0);
    expect(airSupportCut(s, 1, at(s, 51, 15))).toBe(0);
  });

  it('the aim follows the front when the target tile is taken', () => {
    const s = frontGame();
    const af = airfieldWith(s, 1, at(s, 30, 15), 2);
    expect(applyAction(s, 1, { type: 'setAirMission', airfield: af.tile, mission: 'support', target: at(s, 51, 15) }).ok).toBe(true);
    expect(launchAttack(s, 1, at(s, 50, 15), inf(5000)).ok).toBe(true);
    claimRect(s, 1, 50, 0, 60, 29); // the front moved east: the old aim is ours now
    const wing = wingOf(s, af)!;
    run(s, () => s.units.some((u) => u.mission === 1), 5 * TICKS_PER_SECOND);
    expect(s.units.some((u) => u.mission === 1)).toBe(true);
    expect(s.map.owner[wing.target]).toBe(2);
    expect(wing.target % s.map.width).toBeGreaterThan(60);
  });
});

describe('strategic missions', () => {
  it('raid cities and cut the target income for a while', () => {
    const s = frontGame();
    const af = airfieldWith(s, 1, at(s, 30, 15), 3);
    addBuilding(s, 'city', 2, at(s, 80, 10), 2);
    addBuilding(s, 'factory', 2, at(s, 85, 20));
    const before = goldIncome(s, s.players[2]);
    expect(applyAction(s, 1, { type: 'setAirMission', airfield: af.tile, mission: 'strategic', target: at(s, 80, 10) }).ok).toBe(true);
    expect(launchAttack(s, 1, at(s, 50, 15), inf(5000)).ok).toBe(true);
    run(s, () => (s.air?.raids.length ?? 0) > 0);
    expect(airRaidIncomeMul(s, 2)).toBeLessThan(1);
    expect(airRaidIncomeMul(s, 1)).toBe(1);
    run(s, () => s.units.length === 0);
    expect(airRaidIncomeMul(s, 2)).toBeCloseTo(1 - Math.min(AIR.raidMaxCut, 3 * AIR.raidCut));
    expect(goldIncome(s, s.players[2])).toBeLessThan(before);
    // Wears off.
    for (const r of s.air!.raids) r.untilTick = s.tick;
    updateAir(s);
    expect(airRaidIncomeMul(s, 2)).toBe(1);
  });
});

describe('superiority and escorts', () => {
  it('patrolling fighters shoot down an enemy bomber in their circle', () => {
    const s = frontGame();
    const bomberBase = airfieldWith(s, 2, at(s, 90, 15), 1);
    // Our fighters sit far from the bomber's path, but the patrol circle is centred on it.
    const fighters = airfieldWith(s, 1, at(s, 5, 2), 0, 2);
    fighters.cooldown = 1e6; // its normal cover is busy: only the patrol can shoot
    expect(applyAction(s, 1, { type: 'setAirMission', airfield: fighters.tile, mission: 'superiority', target: at(s, 20, 15) }).ok).toBe(true);
    expect(launchBomber(s, 2, bomberBase.tile, at(s, 20, 15)).ok).toBe(true);
    run(s, () => s.units.length === 0);
    expect(bomberBase.bombers).toBe(0); // shot down, never came home
    expect(s.events.some((e) => e.kind === 'unitLost' && e.message.includes('fighters'))).toBe(true);
  });

  it('an escort fights off a fighter interception', () => {
    const s = frontGame();
    s.rng = () => 0.99; // no fighter lost in the duel
    const af = airfieldWith(s, 1, at(s, 30, 15), 1, 1);
    airfieldWith(s, 2, at(s, 70, 15), 0, 1); // enemy fighter cover over the target
    expect(applyAction(s, 1, { type: 'setAirMission', airfield: af.tile, mission: 'support', target: at(s, 70, 15) }).ok).toBe(true);
    expect(launchAttack(s, 1, at(s, 50, 15), inf(5000)).ok).toBe(true);
    run(s, () => s.units.length > 0, 3 * TICKS_PER_SECOND);
    const u = s.units.find((q) => q.type === 'bomber')!;
    expect(u.escort).toBe(AIR.escortHits);
    run(s, () => (u.escort ?? 0) === 0 || u.hp <= 0);
    expect(u.hp).toBeGreaterThan(0);
    expect(u.escort).toBe(0);
  });
});

describe('paratroopers scale with the wing', () => {
  it('more aircraft at the airfield = bigger drops (capped)', () => {
    const s = frontGame();
    const af = airfieldWith(s, 1, at(s, 30, 15), 0);
    const base = paradropMaxTroops(s, 1, af);
    af.bombers = 4;
    expect(paradropMaxTroops(s, 1, af)).toBe(Math.floor((base / airParadropMul({ ...af, bombers: 0 })) * (1 + 4 * AIR.paraPerAircraft)));
    af.bombers = 100;
    expect(airParadropMul(af)).toBe(AIR.paraMaxMul);
  });
});

describe('AI air wings', () => {
  it('puts an airfield on support over its main attack and the hash covers the wing', () => {
    const s = frontGame();
    const af = airfieldWith(s, 1, at(s, 30, 15), 3);
    expect(launchAttack(s, 1, at(s, 50, 15), inf(20000)).ok).toBe(true);
    const h0 = hashState(s);
    aiAirWings(s, 1, [2], false);
    expect(airMissionOf(s, af)).toBe('support');
    expect(s.map.owner[wingOf(s, af)!.target]).toBe(2);
    expect(hashState(s)).not.toBe(h0);
    run(s, () => s.units.some((u) => u.mission === 1), 5 * TICKS_PER_SECOND);
    expect(s.units.some((u) => u.mission === 1)).toBe(true);
  });

  it('patrols against enemy air with a second airfield, idles with nothing to do', () => {
    const s = frontGame();
    const a = airfieldWith(s, 1, at(s, 30, 10), 2, 0);
    const b = airfieldWith(s, 1, at(s, 5, 20), 0, 2);
    aiAirWings(s, 1, [], false);
    expect(airMissionOf(s, a)).toBe('idle');
    expect(launchAttack(s, 1, at(s, 50, 15), inf(20000)).ok).toBe(true);
    aiAirWings(s, 1, [2], true);
    expect(airMissionOf(s, a)).toBe('support');
    expect(airMissionOf(s, b)).toBe('superiority');
  });
});
