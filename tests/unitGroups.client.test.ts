// Unit groups (src/client/unitGroups.ts, the Forces drawer's Groups strip): making a group of the selection, the
// "Fleet 1 · 8 ships" label (mixed and empty too), selecting it again, adding the selection, dead units dropping
// out, rename, delete with undo, the map focus tile, and the plain JSON a saved game stores. No DOM, no sim change.
import { describe, expect, it } from 'vitest';
import { markBuildingsChanged } from '../src/sim/buildings';
import { MAX_GROUP_UNITS } from '../src/sim/config';
import { computeCoastAndLand } from '../src/sim/mapgen';
import { newId } from '../src/sim/state';
import { spawnTankDivision } from '../src/sim/tanks';
import { Terrain } from '../src/sim/types';
import type { Building, GameState } from '../src/sim/types';
import { spawnWarshipAt } from '../src/sim/units';
import { defaultUiState } from '../src/client/uiState';
import {
  addBlock,
  addToGroup,
  createGroup,
  deleteGroup,
  exportUnitGroups,
  getUnitGroups,
  groupFocusTile,
  groupLabel,
  groupSelection,
  groupTap,
  importUnitGroups,
  isGroupSelected,
  MAX_UNIT_GROUPS,
  newGroupBlock,
  newUnitGroups,
  pruneUnitGroups,
  renameGroup,
  setUnitGroups,
  undoDelete,
  type UnitGroup,
} from '../src/client/unitGroups';
import { claimRect, makeFlatGame } from './helpers';

const at = (s: GameState, x: number, y: number): number => y * s.map.width + x;

/** 100 x 40: player 1 land x 0..19, player 2 x 20..29, sea x 30..99; 8 warships and 3 divisions for player 1. */
function game(ships = 8): GameState {
  const s = makeFlatGame(100, 40, 2, { human: true, seed: 7 });
  for (let y = 0; y < 40; y++) for (let x = 30; x < 100; x++) s.map.terrain[at(s, x, y)] = Terrain.DeepWater;
  computeCoastAndLand(s.map);
  claimRect(s, 1, 0, 0, 19, 39);
  claimRect(s, 2, 20, 0, 29, 39);
  s.humanId = 1;
  const p = s.players[1];
  p.troops = { infantry: 200_000, armor: 50_000, artillery: 10_000 };
  const port = at(s, 29, 35);
  const id = newId(s);
  const b: Building = { id, type: 'port', owner: 2, tile: port, level: 1, buildLeft: 0, upgradeLeft: 0, fighters: 0, bombers: 0, cooldown: 0, dropCooldown: 0, disabledUntil: 0, hp: 1, queuedLevels: 0 };
  s.buildings.set(id, b);
  s.map.building[port] = id + 1;
  markBuildingsChanged(s);
  for (let k = 0; k < ships; k++) spawnWarshipAt(s, 1, port, at(s, 32 + (k % 60), 2 + ((k / 60) | 0) * 3));
  for (let k = 0; k < 3; k++) spawnTankDivision(s, 1, at(s, 5 + k * 3, 12));
  return s;
}
const ids = (s: GameState, type: 'warship' | 'tankDivision'): number[] => s.units.filter((u) => u.owner === 1 && u.type === type).map((u) => u.id);
const made = (g: UnitGroup | string): UnitGroup => {
  if (typeof g === 'string') throw new Error(g);
  return g;
};

describe('unit groups: making and labels', () => {
  it('names a ship group Fleet 1 and labels it with the count', () => {
    const s = game();
    const g = newUnitGroups();
    const fleet = made(createGroup(g, s, 1, ids(s, 'warship')));
    expect(fleet.name).toBe('Fleet 1');
    expect(groupLabel(s, 1, fleet)).toBe('Fleet 1 · 8 ships');
    const tanks = made(createGroup(g, s, 1, ids(s, 'tankDivision').slice(0, 1)));
    expect(groupLabel(s, 1, tanks)).toBe('Tanks 1 · 1 division');
    const mixed = made(createGroup(g, s, 1, [...ids(s, 'warship').slice(0, 3), ...ids(s, 'tankDivision').slice(0, 2)]));
    expect(groupLabel(s, 1, mixed)).toBe('Group 1 · 3 ships, 2 divisions');
    const fleet2 = made(createGroup(g, s, 1, ids(s, 'warship').slice(0, 2)));
    expect(fleet2.name).toBe('Fleet 2');
    expect(new Set(g.groups.map((x) => x.id)).size).toBe(4);
  });

  it('refuses an empty selection, one equal to a group, and more than the cap', () => {
    const s = game(20);
    const g = newUnitGroups();
    expect(newGroupBlock(s, 1, g, [])).toMatch(/^Select warships or tank divisions/);
    expect(createGroup(g, s, 1, [999999])).toMatch(/^Select/); // not a unit of ours
    const enemy = s.units.find((u) => u.owner !== 1);
    if (enemy) expect(newGroupBlock(s, 1, g, [enemy.id])).toMatch(/^Select/);
    const ships = ids(s, 'warship');
    made(createGroup(g, s, 1, ships.slice(0, 4)));
    expect(createGroup(g, s, 1, [...ships.slice(0, 4)].reverse())).toBe('Fleet 1 has exactly these units already');
    for (let k = 1; k < MAX_UNIT_GROUPS; k++) made(createGroup(g, s, 1, ships.slice(k, k + 1)));
    expect(g.groups.length).toBe(MAX_UNIT_GROUPS);
    expect(newGroupBlock(s, 1, g, ships.slice(15, 17))).toMatch(/delete one first/);
  });
});

describe('unit groups: selecting, adding, dead units', () => {
  it('selects the live members and lights only for the exact selection', () => {
    const s = game();
    const g = newUnitGroups();
    const ships = ids(s, 'warship');
    const fleet = made(createGroup(g, s, 1, ships.slice(0, 5)));
    expect(groupSelection(s, 1, fleet)).toEqual(ships.slice(0, 5));
    expect(isGroupSelected(s, 1, fleet, [...ships.slice(0, 5)].reverse())).toBe(true);
    expect(isGroupSelected(s, 1, fleet, ships.slice(0, 4))).toBe(false);
    expect(isGroupSelected(s, 1, fleet, ships.slice(0, 6))).toBe(false);
  });

  it('adds only the selected units not in the group yet', () => {
    const s = game();
    const g = newUnitGroups();
    const ships = ids(s, 'warship');
    const divs = ids(s, 'tankDivision');
    const fleet = made(createGroup(g, s, 1, ships.slice(0, 3)));
    expect(addBlock(s, 1, fleet, [])).toMatch(/^Select units on the map/);
    expect(addBlock(s, 1, fleet, ships.slice(0, 2))).toBe('The selected units are in Fleet 1 already');
    expect(addToGroup(g, s, 1, fleet.id, [...ships.slice(1, 5), divs[0]])).toBe(3);
    expect(fleet.ids).toEqual([...ships.slice(0, 5), divs[0]]);
    expect(groupLabel(s, 1, fleet)).toBe('Fleet 1 · 5 ships, 1 division');
    expect(addToGroup(g, s, 1, 12345, ships)).toBe('That group is gone');
  });

  it('caps a group at the selection limit', () => {
    const s = game(MAX_GROUP_UNITS + 4);
    const g = newUnitGroups();
    const ships = ids(s, 'warship');
    const fleet = made(createGroup(g, s, 1, ships.slice(0, MAX_GROUP_UNITS - 2)));
    expect(addToGroup(g, s, 1, fleet.id, ships.slice(MAX_GROUP_UNITS - 2))).toBe(2);
    expect(fleet.ids.length).toBe(MAX_GROUP_UNITS);
    expect(addBlock(s, 1, fleet, ships.slice(MAX_GROUP_UNITS))).toMatch(/is full/);
  });

  it('drops sunk and captured units; an empty group stays with "0"', () => {
    const s = game(3);
    const g = newUnitGroups();
    const ships = ids(s, 'warship');
    const fleet = made(createGroup(g, s, 1, ships));
    s.units.find((u) => u.id === ships[0])!.hp = 0;
    s.units.find((u) => u.id === ships[1])!.owner = 2;
    expect(groupLabel(s, 1, fleet)).toBe('Fleet 1 · 1 ship');
    expect(pruneUnitGroups(g, s, 1)).toBe(true);
    expect(fleet.ids).toEqual([ships[2]]);
    expect(pruneUnitGroups(g, s, 1)).toBe(false);
    s.units = s.units.filter((u) => u.id !== ships[2]);
    pruneUnitGroups(g, s, 1);
    expect(g.groups.length).toBe(1);
    expect(groupLabel(s, 1, fleet)).toBe('Fleet 1 · 0');
    expect(groupSelection(s, 1, fleet)).toEqual([]);
    expect(isGroupSelected(s, 1, fleet, [])).toBe(false);
    expect(groupFocusTile(s, 1, fleet)).toBe(-1);
  });
});

describe('unit groups: rename, delete, undo, focus', () => {
  it('a click on a group that is already the selection without a click on it (just made) only arms the rename', () => {
    expect(groupTap(false, false)).toBe('select');
    expect(groupTap(false, true)).toBe('select');
    // New group leaves it selected: the first click keeps the selection, the second renames
    expect(groupTap(true, false)).toBe('arm');
    expect(groupTap(true, true)).toBe('rename');
  });

  it('renames (trimmed, cut to length, empty keeps the old name)', () => {
    const s = game();
    const g = newUnitGroups();
    const fleet = made(createGroup(g, s, 1, ids(s, 'warship')));
    expect(renameGroup(g, fleet.id, '  North   Sea  ')).toBe('North Sea');
    expect(renameGroup(g, fleet.id, '   ')).toBe('North Sea');
    expect(renameGroup(g, fleet.id, 'x'.repeat(60)).length).toBe(24);
    expect(groupLabel(s, 1, fleet)).toMatch(/^x+ · 8 ships$/);
  });

  it('deletes and undoes in place; the next delete replaces the undo', () => {
    const s = game();
    const g = newUnitGroups();
    const ships = ids(s, 'warship');
    const a = made(createGroup(g, s, 1, ships.slice(0, 2)));
    const b = made(createGroup(g, s, 1, ships.slice(2, 4)));
    const c = made(createGroup(g, s, 1, ships.slice(4, 6)));
    deleteGroup(g, b.id);
    expect(g.groups.map((x) => x.id)).toEqual([a.id, c.id]);
    expect(undoDelete(g)).toBe(b);
    expect(g.groups.map((x) => x.id)).toEqual([a.id, b.id, c.id]);
    expect(undoDelete(g)).toBeNull();
    deleteGroup(g, a.id);
    deleteGroup(g, c.id);
    expect(undoDelete(g)?.id).toBe(c.id);
    expect(g.groups.map((x) => x.id)).toEqual([b.id, c.id]);
    expect(deleteGroup(g, 999)).toBeNull();
  });

  it('focuses on the member nearest the middle of the group', () => {
    const s = game(3);
    const g = newUnitGroups();
    const ships = ids(s, 'warship');
    const pos = [
      [40, 5],
      [50, 5],
      [80, 30],
    ];
    ships.forEach((id, k) => {
      const u = s.units.find((q) => q.id === id)!;
      u.x = pos[k][0];
      u.y = pos[k][1];
    });
    const fleet = made(createGroup(g, s, 1, ships));
    // middle is (56.7, 13.3): the ship at (50, 5) is nearest
    expect(groupFocusTile(s, 1, fleet)).toBe(at(s, 50, 5));
  });
});

describe('unit groups: kept per game as plain JSON', () => {
  it('starts empty in every new UI state and round-trips through JSON', () => {
    const s = game();
    const ui = defaultUiState();
    expect(ui.groups.groups).toEqual([]);
    made(createGroup(ui.groups, s, 1, ids(s, 'warship')));
    made(createGroup(ui.groups, s, 1, ids(s, 'tankDivision')));
    renameGroup(ui.groups, ui.groups.groups[1].id, 'Armour');
    deleteGroup(ui.groups, ui.groups.groups[0].id);
    undoDelete(ui.groups);
    const json = JSON.stringify(getUnitGroups(ui));
    const ui2 = defaultUiState();
    expect(ui2.groups.groups).toEqual([]);
    setUnitGroups(ui2, JSON.parse(json));
    expect(ui2.groups.groups.map((x) => groupLabel(s, 1, x))).toEqual(['Fleet 1 · 8 ships', 'Armour · 3 divisions']);
    // a new group after a load gets a fresh id
    const next = made(createGroup(ui2.groups, s, 1, ids(s, 'warship').slice(0, 1)));
    expect(ui2.groups.groups.filter((x) => x.id === next.id).length).toBe(1);
    expect(exportUnitGroups(ui2.groups).removed).toBeNull();
  });

  it('ignores malformed saved data', () => {
    expect(importUnitGroups(null).groups).toEqual([]);
    expect(importUnitGroups({ groups: 'no' }).groups).toEqual([]);
    const g = importUnitGroups({ next: 2, groups: [{ id: 5, name: 7, ids: [1, 'x', 2, 2] }, { id: 5, name: 'dup', ids: [] }, { name: 'no id' }, null] });
    expect(g.groups).toEqual([{ id: 5, name: 'Group 5', ids: [1, 2] }]);
    expect(g.next).toBe(6);
  });
});
