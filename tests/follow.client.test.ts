// Follow my war on the client (src/client/follow.ts, the follow parts of src/client/pillars.ts): new missions,
// stances and modes follow the player's war; a map pick makes them Fixed; Follow my war switches back; the status
// lines and the auto-recon label. No DOM.
import { describe, expect, it } from 'vitest';
import { applyAction } from '../src/sim/actions';
import { markBuildingsChanged } from '../src/sim/buildings';
import { TICKS_PER_SECOND } from '../src/sim/config';
import { computeCoastAndLand } from '../src/sim/mapgen';
import { newId } from '../src/sim/state';
import { spawnTankDivision } from '../src/sim/tanks';
import { Terrain } from '../src/sim/types';
import type { Action, ActionResult, Building, BuildingType, GameState } from '../src/sim/types';
import { spawnWarshipAt } from '../src/sim/units';
import { FOLLOW_EVERY_SECONDS, updateFollow } from '../src/sim/warTarget';
import { autoReconText, followingLine, followOf, followsWar, followText, groupFollow } from '../src/client/follow';
import { followUnitsAgain, followWingAgain, pillarPickClick, setMission, setMode, setStance, toggleRefill } from '../src/client/pillars';
import { defaultUiState } from '../src/client/uiState';
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

/** 100 x 40: player 1 land x 0..19 (+ x 20..29 at y 30..39), player 2 x 20..29 (capital at the top), sea x 30..99. */
function game(): GameState {
  const s = makeFlatGame(100, 40, 2, { human: true, seed: 5 });
  for (let y = 0; y < 40; y++) for (let x = 30; x < 100; x++) s.map.terrain[at(s, x, y)] = Terrain.DeepWater;
  computeCoastAndLand(s.map);
  claimRect(s, 1, 0, 0, 19, 39);
  claimRect(s, 2, 20, 0, 29, 29);
  claimRect(s, 1, 20, 30, 29, 39);
  s.players[2].capital = at(s, 25, 3);
  s.humanId = 1;
  for (const p of s.players) {
    if (p.id === 0) continue;
    p.gold = 1e6;
    p.iron = 1e5;
    p.oil = 1e5;
    p.troops = { infantry: 200_000, armor: 50_000, artillery: 10_000 };
    p.techs.push('navigation', 'mechanization', 'flight', 'reconPlanes');
  }
  addBuilding(s, 'port', 1, at(s, 29, 35));
  addBuilding(s, 'port', 2, at(s, 29, 10));
  addBuilding(s, 'factory', 1, at(s, 10, 20)).level = 3;
  addBuilding(s, 'airfield', 1, at(s, 8, 8)).bombers = 3;
  spawnWarshipAt(s, 1, at(s, 29, 35), at(s, 31, 35));
  spawnWarshipAt(s, 1, at(s, 29, 35), at(s, 32, 36));
  spawnTankDivision(s, 1, at(s, 10, 10));
  spawnTankDivision(s, 1, at(s, 12, 12));
  return s;
}
const ids = (s: GameState, type: 'warship' | 'tankDivision'): number[] => s.units.filter((u) => u.owner === 1 && u.type === type).map((u) => u.id);
function recorder(s: GameState): { dispatch: (a: Action) => ActionResult; sent: Action[] } {
  const sent: Action[] = [];
  return { sent, dispatch: (a) => (sent.push(a), applyAction(s, 1, a)) };
}
/** Player 1 attacks player 2, and the war targets are re-evaluated (as the sim does every few seconds). */
function attack(s: GameState): void {
  expect(applyAction(s, 1, { type: 'attack', tile: at(s, 20, 15), troops: { infantry: 20_000, armor: 0, artillery: 0 } }).ok).toBe(true);
  s.tick = Math.ceil((s.tick + 1) / (FOLLOW_EVERY_SECONDS * TICKS_PER_SECOND)) * FOLLOW_EVERY_SECONDS * TICKS_PER_SECOND;
  updateFollow(s);
}
const FIELD = (s: GameState): number => at(s, 8, 8);
const fieldB = (s: GameState): Building => [...s.buildings.values()].find((b) => b.tile === FIELD(s))!;

describe('Follow my war: air wings', () => {
  it('a new Support mission follows at once; the pick fixes it; Follow my war switches back', () => {
    const s = game();
    const ui = defaultUiState();
    const { dispatch, sent } = recorder(s);
    expect(setMission(s, ui, dispatch, FIELD(s), 'support')).toBe('');
    const first = sent[0];
    expect(first.type === 'setAirMission' && first.follow === true && first.target === undefined).toBe(true);
    expect(ui.mode.kind === 'pillarPick' && ui.mode.label.includes('following your war')).toBe(true);
    let f = followOf(s, 'air', FIELD(s))!;
    expect(f.fixed).toBe(false);
    expect(followText(s, 1, 'air', 'support', f)).toBe('Following: no war yet');

    attack(s);
    f = followOf(s, 'air', FIELD(s))!;
    expect(f.nation).toBe(2);
    expect(followText(s, 1, 'air', 'support', f)).toBe(`Following: your attack on ${s.players[2].name}`);

    // the map pick: Fixed
    expect(pillarPickClick(s, ui, dispatch, at(s, 22, 10)).reason).toBe('');
    const pick = sent[sent.length - 1];
    expect(pick.type === 'setAirMission' && pick.follow === false && pick.target === at(s, 22, 10)).toBe(true);
    f = followOf(s, 'air', FIELD(s))!;
    expect(f.fixed).toBe(true);
    expect(followText(s, 1, 'air', 'support', f)).toMatch(/^Fixed: /);
    // re-buy losses keeps it Fixed (same target)
    expect(toggleRefill(s, dispatch, fieldB(s))).toBe('');
    expect(followOf(s, 'air', FIELD(s))!.fixed).toBe(true);

    // back to Follow my war, same mission
    expect(followWingAgain(s, dispatch, fieldB(s))).toBe('');
    expect(followOf(s, 'air', FIELD(s))!.fixed).toBe(false);
    expect(s.air!.wings.find((w) => w.tile === FIELD(s))!.mission).toBe('support');
    // re-buy losses on a following wing stays on Follow
    expect(toggleRefill(s, dispatch, fieldB(s))).toBe('');
    expect(followOf(s, 'air', FIELD(s))!.fixed).toBe(false);
  });

  it('Idle follows nothing; Strategic and Superiority follow too', () => {
    const s = game();
    const ui = defaultUiState();
    const { dispatch } = recorder(s);
    expect(followsWar('air', 'idle')).toBe(false);
    expect(setMission(s, ui, dispatch, FIELD(s), 'idle')).toBe('');
    expect(followOf(s, 'air', FIELD(s))).toBeNull();
    for (const m of ['strategic', 'superiority'] as const) {
      ui.mode = { kind: 'none' };
      expect(setMission(s, ui, dispatch, FIELD(s), m)).toBe('');
      expect(followOf(s, 'air', FIELD(s))?.fixed).toBe(false);
    }
  });

  it('says "last attack" once the attack has ended', () => {
    const s = game();
    attack(s);
    s.attacks.length = 0;
    expect(followingLine(s, 1, { nation: 2, tile: -1, fixed: false })).toBe(`Following: ${s.players[2].name} (last attack)`);
    expect(followingLine(s, 1, { nation: 0, tile: -1, fixed: false })).toBe('Following: no war yet');
  });

  it('auto recon is off by default and names the war target when on', () => {
    const s = game();
    const b = fieldB(s);
    expect(autoReconText(s, 1, false).label).toBe('Auto recon: off');
    expect(autoReconText(s, 1, false).tip).toContain('gold');
    expect(applyAction(s, 1, { type: 'setAutoRecon', airfield: b.tile, on: true }).ok).toBe(true);
    expect(autoReconText(s, 1, true).label).toBe('Auto recon: on (no war yet)');
    attack(s);
    expect(autoReconText(s, 1, true).label).toBe(`Auto recon: scouts ${s.players[2].name}`);
  });
});

describe('Follow my war: warships', () => {
  it('Bombard follows; a coast click pins the nation; Follow my war unpins', () => {
    const s = game();
    const ui = defaultUiState();
    const { dispatch, sent } = recorder(s);
    const ships = ids(s, 'warship');
    expect(followOf(s, 'warship', ships[0])?.fixed).toBe(false); // new ships follow (auto)
    expect(setStance(s, ui, dispatch, ships, 'bombard')).toBe('');
    expect(sent[0].type === 'setUnitStance' && sent[0].follow === true).toBe(true);
    expect(groupFollow(s, 'warship', ships)!.fixed).toBe(false);
    expect(pillarPickClick(s, ui, dispatch, at(s, 29, 15)).ok).toBe(true);
    const pin = sent.find((a) => a.type === 'setUnitStance' && a.target !== undefined);
    expect(pin).toBeDefined();
    const g = groupFollow(s, 'warship', ships)!;
    expect(g.fixed).toBe(true);
    expect(g.nation).toBe(2);
    expect(followText(s, 1, 'warship', 'bombard', g)).toBe(`Fixed: ${s.players[2].name}'s coast`);
    expect(followUnitsAgain(s, dispatch, 'warship', ships)).toBe('');
    expect(groupFollow(s, 'warship', ships)!.fixed).toBe(false);
  });

  it('Hunt and Escort have nothing to follow', () => {
    const s = game();
    const ui = defaultUiState();
    const { dispatch } = recorder(s);
    const ships = ids(s, 'warship');
    expect(setStance(s, ui, dispatch, ships, 'hunt')).toBe('');
    expect(followsWar('warship', 'hunt')).toBe(false);
    expect(followUnitsAgain(s, dispatch, 'warship', ships)).toBe('Pick Bombard or Blockade first');
  });
});

describe('Follow my war: tank divisions', () => {
  it('Support front is set at once and follows; a front click fixes it; Follow my war switches back', () => {
    const s = game();
    const ui = defaultUiState();
    const { dispatch, sent } = recorder(s);
    const tanks = ids(s, 'tankDivision');
    expect(followUnitsAgain(s, dispatch, 'division', tanks)).toBe('Pick Support front first');
    expect(setMode(s, ui, dispatch, tanks, 'support')).toBe('');
    expect(sent[0].type === 'setDivisionMode' && sent[0].mode === 'support' && sent[0].follow === true && sent[0].front === undefined).toBe(true);
    expect(s.units.find((u) => u.id === tanks[0])!.mode).toBe('support');
    expect(groupFollow(s, 'division', tanks)!.fixed).toBe(false);
    expect(ui.mode.kind).toBe('pillarPick');
    expect(pillarPickClick(s, ui, dispatch, at(s, 20, 15)).reason).toBe('');
    const g = groupFollow(s, 'division', tanks)!;
    expect(g.fixed).toBe(true);
    expect(followText(s, 1, 'division', 'support', g)).toBe(`Fixed: the front with ${s.players[2].name}`);
    expect(followUnitsAgain(s, dispatch, 'division', tanks)).toBe('');
    expect(groupFollow(s, 'division', tanks)!.fixed).toBe(false);
  });
});
