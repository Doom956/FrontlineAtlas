// Group controls (src/client/groupOrders.ts, the selection helpers in src/client/selection.ts, render/fleets.ts):
// one order for every warship / airfield / tank division (fan-out in as few actions as the sim allows), the
// "set by hand" count and Reset to all, select all of a type (and all of it on screen), fleet clustering, the Hold
// stance, and the Fixed strategic wing that waits for its war. No DOM.
import { describe, expect, it } from 'vitest';
import { applyAction } from '../src/sim/actions';
import { markBuildingsChanged } from '../src/sim/buildings';
import { MAX_GROUP_UNITS } from '../src/sim/config';
import { computeCoastAndLand } from '../src/sim/mapgen';
import { warshipStance } from '../src/sim/naval2';
import { newId } from '../src/sim/state';
import { spawnTankDivision } from '../src/sim/tanks';
import { Terrain, WARSHIP_STANCES } from '../src/sim/types';
import type { Action, ActionResult, Building, BuildingType, GameState } from '../src/sim/types';
import { spawnWarshipAt } from '../src/sim/units';
import { tick } from '../src/sim/sim';
import { autoReconOn } from '../src/sim/warTarget';
import { groupOrderActions, groupState, reconAllAction, reconAllOn, refillAllActions, refillAllOn, resetActions, sendAll } from '../src/client/groupOrders';
import { STANCE_INFO, STANCE_ORDER, wingStatus } from '../src/client/pillars';
import { fleetClickSelection, sameTypeInView, selectAllOf } from '../src/client/selection';
import { clusterFleets, FLEET_RADIUS } from '../src/client/render/fleets';
import { claimRect, makeFlatGame } from './helpers';

const at = (s: GameState, x: number, y: number): number => y * s.map.width + x;

function addBuilding(s: GameState, type: BuildingType, owner: number, tile: number): Building {
  const id = newId(s);
  const b: Building = { id, type, owner, tile, level: 1, buildLeft: 0, upgradeLeft: 0, fighters: 0, bombers: 0, cooldown: 0, dropCooldown: 0, disabledUntil: 0, hp: 1, queuedLevels: 0 };
  s.buildings.set(id, b);
  s.map.building[tile] = id + 1;
  markBuildingsChanged(s);
  return b;
}

/** 100 x 40: player 1 land x 0..19, player 2 x 20..29, sea x 30..99; `ships` warships and 3 divisions for player 1. */
function game(ships = 5): GameState {
  const s = makeFlatGame(100, 40, 2, { human: true, seed: 7 });
  for (let y = 0; y < 40; y++) for (let x = 30; x < 100; x++) s.map.terrain[at(s, x, y)] = Terrain.DeepWater;
  computeCoastAndLand(s.map);
  claimRect(s, 1, 0, 0, 19, 39);
  claimRect(s, 2, 20, 0, 29, 39);
  s.humanId = 1;
  for (const p of s.players) {
    if (p.id === 0) continue;
    p.gold = 1e6;
    p.iron = 1e5;
    p.oil = 1e5;
    p.troops = { infantry: 200_000, armor: 50_000, artillery: 10_000 };
    p.techs.push('navigation', 'mechanization', 'flight', 'reconPlanes');
  }
  const port = at(s, 29, 35);
  addBuilding(s, 'port', 2, port);
  addBuilding(s, 'factory', 1, at(s, 10, 20)).level = 3;
  addBuilding(s, 'airfield', 1, at(s, 8, 8)).bombers = 3;
  addBuilding(s, 'airfield', 1, at(s, 8, 30)).bombers = 2;
  for (let k = 0; k < ships; k++) spawnWarshipAt(s, 1, port, at(s, 32 + (k % 60), 2 + ((k / 60) | 0) * 3));
  for (let k = 0; k < 3; k++) spawnTankDivision(s, 1, at(s, 5 + k * 3, 12));
  return s;
}
const ids = (s: GameState, type: 'warship' | 'tankDivision'): number[] => s.units.filter((u) => u.owner === 1 && u.type === type).map((u) => u.id);
function recorder(s: GameState): { dispatch: (a: Action) => ActionResult; sent: Action[] } {
  const sent: Action[] = [];
  return { sent, dispatch: (a) => (sent.push(a), applyAction(s, 1, a)) };
}

describe('group orders: fan-out', () => {
  it('one stance for 70 warships goes out as two actions of at most 64 ids, following the war', () => {
    const s = game(70);
    const { dispatch, sent } = recorder(s);
    const acts = groupOrderActions(s, 1, 'warship', 'bombard');
    expect(acts.length).toBe(2);
    for (const a of acts) expect(a.type === 'setUnitStance' && a.stance === 'bombard' && a.follow === true && a.unitIds.length <= MAX_GROUP_UNITS).toBe(true);
    expect(sendAll(dispatch, acts)).toBe('');
    expect(sent.length).toBe(2);
    expect(s.units.filter((u) => u.type === 'warship').every((u) => warshipStance(u) === 'bombard')).toBe(true);
    expect(groupState(s, 1, 'warship').choice).toBe('bombard');
    // already all bombard: nothing to send (no ship leaves its station)
    expect(groupOrderActions(s, 1, 'warship', 'bombard')).toEqual([]);
    // Follow my war = Auto
    expect(sendAll(dispatch, groupOrderActions(s, 1, 'warship', 'follow'))).toBe('');
    expect(s.units.filter((u) => u.type === 'warship').every((u) => warshipStance(u) === 'auto')).toBe(true);
    expect(groupState(s, 1, 'warship').choice).toBe('follow');
  });

  it('divisions: one setDivisionMode for all; Support front follows', () => {
    const s = game();
    const { dispatch, sent } = recorder(s);
    expect(sendAll(dispatch, groupOrderActions(s, 1, 'division', 'support'))).toBe('');
    expect(sent.length).toBe(1);
    const a = sent[0];
    expect(a.type === 'setDivisionMode' && a.mode === 'support' && a.follow === true && a.unitIds.length === 3).toBe(true);
    expect(groupState(s, 1, 'division')).toMatchObject({ choice: 'support', byHand: [] });
    expect(sendAll(dispatch, groupOrderActions(s, 1, 'division', 'hold'))).toBe('');
    expect(groupState(s, 1, 'division').choice).toBe('hold');
  });

  it('airfields: one setAirMission for every airfield (airfield -1), following', () => {
    const s = game();
    const { dispatch, sent } = recorder(s);
    const acts = groupOrderActions(s, 1, 'air', 'strategic');
    expect(acts).toEqual([{ type: 'setAirMission', airfield: -1, mission: 'strategic', follow: true }]);
    expect(sendAll(dispatch, acts)).toBe('');
    expect(sent.length).toBe(1);
    const g = groupState(s, 1, 'air');
    expect(g.members.length).toBe(2);
    expect(g.choice).toBe('strategic');
    expect(g.byHand).toEqual([]);
  });

  it('Auto-refill all and Auto recon all', () => {
    const s = game();
    const { dispatch, sent } = recorder(s);
    expect(sendAll(dispatch, groupOrderActions(s, 1, 'air', 'support'))).toBe('');
    sent.length = 0;
    expect(refillAllOn(s, 1)).toBe(false);
    // same mission everywhere, following: one action
    expect(sendAll(dispatch, refillAllActions(s, 1, true))).toBe('');
    expect(sent.length).toBe(1);
    expect(refillAllOn(s, 1)).toBe(true);
    // a fixed one keeps its target: one action per airfield
    expect(applyAction(s, 1, { type: 'setAirMission', airfield: at(s, 8, 8), mission: 'strategic', target: at(s, 25, 10) }).ok).toBe(true);
    sent.length = 0;
    expect(sendAll(dispatch, refillAllActions(s, 1, false))).toBe('');
    expect(sent.length).toBe(2);
    expect(refillAllOn(s, 1)).toBe(false);
    expect(groupState(s, 1, 'air').members.find((m) => m.id === at(s, 8, 8))).toMatchObject({ choice: 'strategic', fixed: true });

    expect(reconAllOn(s, 1)).toBe(false);
    expect(sendAll(dispatch, [reconAllAction(true)])).toBe('');
    expect(reconAllOn(s, 1)).toBe(true);
    expect([...s.buildings.values()].filter((b) => b.type === 'airfield').every((b) => autoReconOn(s, b))).toBe(true);
  });
});

describe('group orders: set by hand and reset', () => {
  it('counts the ships with another stance or a fixed target, and Reset to all brings only them back', () => {
    const s = game(6);
    const { dispatch, sent } = recorder(s);
    const w = ids(s, 'warship');
    expect(sendAll(dispatch, groupOrderActions(s, 1, 'warship', 'blockade'))).toBe('');
    expect(groupState(s, 1, 'warship').byHand).toEqual([]);
    // one on Hunt by hand, one Fixed on player 2 (a target picked on the map)
    expect(applyAction(s, 1, { type: 'setUnitStance', unitIds: [w[1]], stance: 'hunt' }).ok).toBe(true);
    expect(applyAction(s, 1, { type: 'setUnitStance', unitIds: [w[4]], stance: 'blockade', target: at(s, 25, 10) }).ok).toBe(true);
    const g = groupState(s, 1, 'warship');
    expect(g.choice).toBe('blockade');
    expect(g.byHand).toEqual([w[1], w[4]]);
    expect(g.byHandText).toBe('1 Hunt, 1 fixed on a target');

    sent.length = 0;
    expect(sendAll(dispatch, resetActions(s, 1, 'warship'))).toBe('');
    expect(sent).toEqual([{ type: 'setUnitStance', unitIds: [w[1], w[4]], stance: 'blockade', follow: true }]);
    expect(groupState(s, 1, 'warship').byHand).toEqual([]);
    expect(s.units.find((u) => u.id === w[4])!.fixed).toBeUndefined();
    expect(resetActions(s, 1, 'warship')).toEqual([]);
  });

  it('divisions fixed on a front count as set by hand; airfields reset with one action', () => {
    const s = game();
    const { dispatch } = recorder(s);
    const d = ids(s, 'tankDivision');
    expect(sendAll(dispatch, groupOrderActions(s, 1, 'division', 'support'))).toBe('');
    expect(applyAction(s, 1, { type: 'setDivisionMode', unitIds: [d[2]], mode: 'support', front: at(s, 19, 10), follow: false }).ok).toBe(true);
    expect(groupState(s, 1, 'division').byHand).toEqual([d[2]]);
    expect(sendAll(dispatch, resetActions(s, 1, 'division'))).toBe('');
    expect(groupState(s, 1, 'division').byHand).toEqual([]);

    expect(sendAll(dispatch, groupOrderActions(s, 1, 'air', 'support'))).toBe('');
    expect(applyAction(s, 1, { type: 'setAirMission', airfield: at(s, 8, 30), mission: 'idle' }).ok).toBe(true);
    const g = groupState(s, 1, 'air');
    // a tie (1 Support, 1 Idle): the first button wins
    expect(g.choice).toBe('support');
    expect(g.byHand).toEqual([at(s, 8, 30)]);
    expect(resetActions(s, 1, 'air')).toEqual([{ type: 'setAirMission', airfield: -1, mission: 'support', follow: true }]);
    expect(sendAll(dispatch, resetActions(s, 1, 'air'))).toBe('');
    expect(groupState(s, 1, 'air').byHand).toEqual([]);
  });
});

describe('Hold stance', () => {
  it('is a valid stance on the orders bar and in the sim; a held ship stays off station at war', () => {
    expect(WARSHIP_STANCES.indexOf('hold')).toBe(WARSHIP_STANCES.length - 1); // appended: the hash keeps the old indices
    expect(STANCE_ORDER).toContain('hold');
    expect(STANCE_INFO.hold.name).toBe('Hold');
    const s = game(2);
    const { dispatch } = recorder(s);
    expect(sendAll(dispatch, groupOrderActions(s, 1, 'warship', 'hold'))).toBe('');
    expect(s.units.filter((u) => u.type === 'warship').every((u) => warshipStance(u) === 'hold')).toBe(true);
    expect(applyAction(s, 1, { type: 'setUnitStance', unitIds: ids(s, 'warship'), stance: 'nope' as never }).ok).toBe(false);
  });

  it('at war, Auto ships sail off to shell the enemy coast and Hold ships stay at their posts', () => {
    // 80 x 40: land y 0..19 (player 1 x 0..39, player 2 x 40..79), sea y 20..39; AIs frozen
    const s = makeFlatGame(80, 40, 3, { human: true, seed: 4 });
    for (let y = 20; y < 40; y++) for (let x = 0; x < 80; x++) s.map.terrain[at(s, x, y)] = Terrain.DeepWater;
    computeCoastAndLand(s.map);
    claimRect(s, 1, 0, 0, 39, 19);
    claimRect(s, 2, 40, 0, 79, 19);
    s.admin = { aiPassive: [], godMode: [], aiFrozen: true, revealIntel: [] };
    s.settings.victoryLandShare = 0.99;
    for (const p of s.players) {
      if (p.id === 0) continue;
      p.techs.push('navigation');
      p.troops = { infantry: 60000, armor: 0, artillery: 0 };
    }
    const a = spawnWarshipAt(s, 1, at(s, 20, 19), at(s, 55, 30));
    const h = spawnWarshipAt(s, 1, at(s, 20, 19), at(s, 60, 30));
    expect(applyAction(s, 1, { type: 'setUnitStance', unitIds: [h.id], stance: 'hold' }).ok).toBe(true);
    expect(applyAction(s, 1, { type: 'attack', tile: at(s, 40, 5), troops: { infantry: 20000, armor: 0, artillery: 0 } }).ok).toBe(true);
    for (let k = 0; k < 600 && a.state !== 3; k++) tick(s);
    expect(a.state).toBe(3);
    expect(h.state).toBe(0);
    // it keeps patrolling around its own post (no station off the enemy coast)
    expect(h.station).toBeUndefined();
    expect(h.cargo).toBe(at(s, 60, 30));
  });
});

describe('quick selection', () => {
  it('select all of a type, all of a type on screen, and fleet clicks', () => {
    const s = game(4);
    const w = ids(s, 'warship');
    const d = ids(s, 'tankDivision');
    expect(selectAllOf(s, 1, 'warship')).toEqual(w);
    expect(selectAllOf(s, 1, 'tankDivision')).toEqual(d);
    // double-click a warship: only the warships drawn on screen (divisions and enemy units are left out)
    expect(sameTypeInView(s, 1, w[2], [d[0], w[3], w[2], d[1]])).toEqual([w[2], w[3]]);
    expect(sameTypeInView(s, 1, d[1], [d[0], w[3], d[1]])).toEqual([d[0], d[1]]);
    expect(sameTypeInView(s, 2, w[0], w)).toEqual([]);
    // a fleet marker: selects the fleet; Shift adds it, or takes it out when all of it is selected
    expect(fleetClickSelection(s, 1, [d[0]], [w[0], w[1]], false)).toEqual([w[0], w[1]]);
    expect(fleetClickSelection(s, 1, [d[0]], [w[0], w[1]], true)).toEqual([d[0], w[0], w[1]]);
    expect(fleetClickSelection(s, 1, [d[0], w[0], w[1]], [w[0], w[1]], true)).toEqual([d[0]]);
  });
});

describe('fleet markers', () => {
  it('clusters ships of one owner within the radius (chains too), keeps owners apart and singles out', () => {
    const pts = [
      { id: 5, owner: 1, x: 10, y: 10 },
      { id: 2, owner: 1, x: 13, y: 10 },
      { id: 9, owner: 1, x: 16, y: 10 }, // 3 from id 2: chained into the same fleet
      { id: 3, owner: 2, x: 11, y: 10 }, // another owner, alone
      { id: 7, owner: 1, x: 40, y: 40 }, // alone
      { id: 4, owner: 2, x: 41, y: 41 },
      { id: 6, owner: 2, x: 42, y: 40 },
    ];
    const f = clusterFleets(pts, FLEET_RADIUS);
    expect(f.map((x) => ({ owner: x.owner, ids: x.ids }))).toEqual([
      { owner: 1, ids: [2, 5, 9] },
      { owner: 2, ids: [4, 6] },
    ]);
    expect(f[0].x).toBeCloseTo(13);
    expect(f[0].y).toBeCloseTo(10);
    // a tight radius: no fleets
    expect(clusterFleets(pts, 1)).toEqual([]);
    expect(clusterFleets(pts.slice(0, 1), FLEET_RADIUS)).toEqual([]);
  });

  it('stays cheap for many ships', () => {
    const pts = Array.from({ length: 2000 }, (_, i) => ({ id: i, owner: 1 + (i % 4), x: (i * 7.3) % 400, y: (i * 3.1) % 300 }));
    const t0 = performance.now();
    for (let k = 0; k < 20; k++) clusterFleets(pts, 16);
    const ms = (performance.now() - t0) / 20;
    expect(ms).toBeLessThan(10);
  });
});

describe('Fixed strategic wing without a war', () => {
  it('says "Waiting: no war with X" instead of a raid countdown', () => {
    const s = game();
    const b = [...s.buildings.values()].find((x) => x.tile === at(s, 8, 8))!;
    expect(applyAction(s, 1, { type: 'setAirMission', airfield: b.tile, mission: 'strategic', target: at(s, 25, 10) }).ok).toBe(true);
    expect(wingStatus(s, b).line).toBe(`Waiting: no war with ${s.players[2].name}`);
    expect(applyAction(s, 1, { type: 'attack', tile: at(s, 20, 15), troops: { infantry: 20_000, armor: 0, artillery: 0 } }).ok).toBe(true);
    expect(wingStatus(s, b).line).toMatch(new RegExp(`^Raiding ${s.players[2].name}`));
  });
});
