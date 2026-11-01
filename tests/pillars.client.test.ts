// Client pillar controls (src/client/pillars.ts): warship stances with their coast / port pick, division modes with
// the front pick, airfield missions, the encirclement hint and the Forces summary. No DOM.
import { describe, expect, it } from 'vitest';
import { applyAction } from '../src/sim/actions';
import { markBuildingsChanged } from '../src/sim/buildings';
import { computeCoastAndLand } from '../src/sim/mapgen';
import { newId } from '../src/sim/state';
import { spawnTankDivision } from '../src/sim/tanks';
import { Terrain } from '../src/sim/types';
import type { Action, ActionResult, Building, BuildingType, GameState } from '../src/sim/types';
import { spawnWarshipAt } from '../src/sim/units';
import { pillarPickClick, pillarSummary, pocketLine, pocketPreview, setMission, setMode, setStance, sharedMode, sharedStance, vetOf, warshipOrderLine, wingStatus } from '../src/client/pillars';
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
    p.techs.push('navigation', 'mechanization', 'flight');
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

describe('warship stances', () => {
  it('sets the stance at once; Bombard then waits for an optional coast click that sails them there', () => {
    const s = game();
    const ui = defaultUiState();
    const { dispatch, sent } = recorder(s);
    const ships = ids(s, 'warship');
    expect(sharedStance(s, 1, ships)).toBe('auto');
    expect(setStance(s, ui, dispatch, ships, 'hunt')).toBe('');
    expect(sharedStance(s, 1, ships)).toBe('hunt');
    expect(ui.mode.kind).toBe('none');
    expect(setStance(s, ui, dispatch, ships, 'bombard')).toBe('');
    expect(sharedStance(s, 1, ships)).toBe('bombard');
    expect(ui.mode.kind).toBe('pillarPick');
    // own land is refused, the enemy coast sends them to the water off it
    expect(pillarPickClick(s, ui, dispatch, at(s, 5, 5)).ok).toBe(false);
    const r = pillarPickClick(s, ui, dispatch, at(s, 29, 15));
    expect(r.ok).toBe(true);
    const move = sent[sent.length - 1];
    expect(move.type).toBe('moveWarships');
    if (move.type === 'moveWarships') expect(s.map.terrain[move.tile]).toBe(Terrain.DeepWater);
  });

  it('Blockade picks the enemy port nearest the click', () => {
    const s = game();
    const ui = defaultUiState();
    const { dispatch, sent } = recorder(s);
    setStance(s, ui, dispatch, ids(s, 'warship'), 'blockade');
    expect(pillarPickClick(s, ui, dispatch, at(s, 15, 30)).ok).toBe(false); // nowhere near an enemy port
    expect(pillarPickClick(s, ui, dispatch, at(s, 31, 11)).ok).toBe(true);
    const move = sent[sent.length - 1];
    expect(move.type === 'moveWarships' && Math.abs((move.tile % 100) - 29) <= 6 && Math.abs(((move.tile / 100) | 0) - 10) <= 6).toBe(true);
  });

  it('phrases escorting and stationed ships', () => {
    const s = game();
    const [a] = s.units.filter((u) => u.type === 'warship' && u.owner === 1);
    a.stance = 'bombard';
    a.state = 3;
    a.station = at(s, 29, 15);
    a.path = [];
    expect(warshipOrderLine(s, 1, a)).toContain('Shelling');
    expect(warshipOrderLine(s, 1, a)).toContain(s.players[2].name);
    a.vet = 2;
    expect(vetOf(a).level).toBe(2);
  });
});

describe('division modes', () => {
  it('Hold and Refit go at once; Support front follows your war at once and the front click fixes it', () => {
    const s = game();
    const ui = defaultUiState();
    const { dispatch, sent } = recorder(s);
    const tanks = ids(s, 'tankDivision');
    expect(sharedMode(s, 1, tanks)).toBe('hold');
    expect(setMode(s, ui, dispatch, tanks, 'refit')).toBe('');
    expect(sharedMode(s, 1, tanks)).toBe('refit');
    expect(setMode(s, ui, dispatch, tanks, 'support')).toBe('');
    expect(ui.mode.kind).toBe('pillarPick');
    expect(sent.some((a) => a.type === 'setDivisionMode' && a.mode === 'support' && a.follow === true)).toBe(true);
    expect(pillarPickClick(s, ui, dispatch, at(s, 35, 10)).ok).toBe(false); // water
    const r = pillarPickClick(s, ui, dispatch, at(s, 20, 15));
    expect(r.reason).toBe('');
    expect(r.ok).toBe(true);
    expect(sharedMode(s, 1, tanks)).toBe('support');
  });

  it('the encirclement hint finds the pocket a line across the enemy strip cuts off', () => {
    const s = game();
    // a line from our land straight across player 2's strip to the sea at y 20: rows 21..29 are cut off
    const path: number[] = [];
    for (let x = 20; x <= 29; x++) path.push(at(s, x, 20));
    const p = pocketPreview(s, 1, { path, expectedDepth: path.length, warnings: [], launch: at(s, 19, 20), reason: '' });
    expect(p).not.toBeNull();
    expect(p!.victim).toBe(2);
    expect(p!.tiles.length).toBeGreaterThanOrEqual(70);
    expect(p!.tiles.every((t) => s.map.owner[t] === 2 && ((t / 100) | 0) > 20)).toBe(true);
    expect(pocketLine(s, p)).toMatch(/^Encircles ~\d+ tiles/);
    // a short line that doesn't reach the sea cuts nothing off
    expect(pocketPreview(s, 1, { path: path.slice(0, 4), expectedDepth: 4, warnings: [], launch: at(s, 19, 20), reason: '' })).toBeNull();
  });
});

describe('air missions', () => {
  it('Support waits for the front click; Superiority is set over the airfield at once', () => {
    const s = game();
    const ui = defaultUiState();
    const { dispatch } = recorder(s);
    const field = at(s, 8, 8);
    expect(setMission(s, ui, dispatch, field, 'support')).toBe('');
    expect(ui.mode.kind).toBe('pillarPick');
    const r = pillarPickClick(s, ui, dispatch, at(s, 22, 10));
    expect(r.reason).toBe('');
    const b = [...s.buildings.values()].find((q) => q.tile === field)!;
    expect(wingStatus(s, b).mission).toBe('support');
    expect(wingStatus(s, b).line).toContain(s.players[2].name);
    expect(wingStatus(s, b).line).toContain('attack');
    ui.mode = { kind: 'none' };
    expect(setMission(s, ui, dispatch, field, 'superiority')).toBe('');
    expect(wingStatus(s, b).mission).toBe('superiority');
    expect(pillarSummary(s, 1).wingsOnMission).toBe(1);
  });
});
