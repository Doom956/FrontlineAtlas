// Client unit selection and orders (src/client/selection.ts): selecting own warships and tank divisions, the group
// orders a click gives them, the warship placement mode and the tank division factory click. No DOM.
import { describe, expect, it } from 'vitest';
import { applyAction } from '../src/sim/actions';
import { markBuildingsChanged } from '../src/sim/buildings';
import { MAX_GROUP_UNITS, WARSHIP_SPAWN_RANGE } from '../src/sim/config';
import { hashState } from '../src/sim/hash';
import { computeCoastAndLand } from '../src/sim/mapgen';
import { newId } from '../src/sim/state';
import { spawnTankDivision } from '../src/sim/tanks';
import { Terrain } from '../src/sim/types';
import type { Action, Building, BuildingType, GameState } from '../src/sim/types';
import { spawnWarshipAt } from '../src/sim/units';
import {
  boxSelection,
  orderForClick,
  pruneSelection,
  selectAllOf,
  selectionChipText,
  selectionClick,
  selectionText,
  spawnWarshipAction,
  splitSelection,
  tankDivisionClickAction,
  toggleInSelection,
  warshipSpawnArea,
  warshipSpawnCheck,
} from '../src/client/selection';
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

/**
 * 100 x 40: player 1 (human) land x 0..19, player 2 land x 20..29 (a shared border), sea x 30..99 with a lake at
 * 5..7 x 5..7 inside player 1's land. Player 1 has a port on the sea, two warships and two tank divisions.
 */
function game(seed = 3): GameState {
  const s = makeFlatGame(100, 40, 2, { human: true, seed });
  for (let y = 0; y < 40; y++) for (let x = 30; x < 100; x++) s.map.terrain[at(s, x, y)] = Terrain.DeepWater;
  for (let y = 5; y <= 7; y++) for (let x = 5; x <= 7; x++) s.map.terrain[at(s, x, y)] = Terrain.ShallowWater;
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
    p.techs.push('navigation', 'mechanization');
  }
  // player 1 needs a coast on the sea for its port: give it the strip x 20..29 at y 30..39 (player 2 keeps the rest)
  claimRect(s, 1, 20, 30, 29, 39);
  addBuilding(s, 'port', 1, at(s, 29, 35));
  addBuilding(s, 'factory', 1, at(s, 10, 20)).level = 3;
  spawnWarshipAt(s, 1, at(s, 29, 35), at(s, 31, 35));
  spawnWarshipAt(s, 1, at(s, 29, 35), at(s, 32, 36));
  spawnWarshipAt(s, 2, at(s, 29, 35), at(s, 40, 10)); // an enemy ship
  spawnTankDivision(s, 1, at(s, 10, 10));
  spawnTankDivision(s, 1, at(s, 12, 12));
  spawnTankDivision(s, 2, at(s, 25, 10)); // an enemy division
  return s;
}
const idsOf = (s: GameState, owner: number, type: 'warship' | 'tankDivision'): number[] => s.units.filter((u) => u.owner === owner && u.type === type).map((u) => u.id);

describe('selecting units', () => {
  it('keeps only own, alive warships and tank divisions', () => {
    const s = game();
    const mine = [...idsOf(s, 1, 'warship'), ...idsOf(s, 1, 'tankDivision')];
    const theirs = [...idsOf(s, 2, 'warship'), ...idsOf(s, 2, 'tankDivision')];
    expect(pruneSelection(s, 1, [...mine, ...theirs, 99999, mine[0]])).toEqual(mine);
    s.units.find((u) => u.id === mine[0])!.hp = 0;
    expect(pruneSelection(s, 1, mine)).toEqual(mine.slice(1));
  });

  it('Shift+click toggles, the box replaces or adds, select-all takes every unit of a type', () => {
    const s = game();
    const [w1, w2] = idsOf(s, 1, 'warship');
    const [t1, t2] = idsOf(s, 1, 'tankDivision');
    let sel = toggleInSelection([], w1);
    sel = toggleInSelection(sel, t1);
    expect(sel).toEqual([w1, t1]);
    expect(toggleInSelection(sel, w1)).toEqual([t1]);
    expect(boxSelection(s, 1, [w1], [t1, t2, idsOf(s, 2, 'tankDivision')[0]], false)).toEqual([t1, t2]);
    expect(boxSelection(s, 1, [w1], [t1], true)).toEqual([w1, t1]);
    expect(selectAllOf(s, 1, 'warship')).toEqual([w1, w2]);
    expect(selectAllOf(s, 1, 'tankDivision')).toEqual([t1, t2]);
    expect(selectAllOf(s, 2, 'warship')).toEqual(idsOf(s, 2, 'warship'));
  });

  it('caps the selection at MAX_GROUP_UNITS', () => {
    const s = game();
    for (let k = 0; k < MAX_GROUP_UNITS + 5; k++) spawnWarshipAt(s, 1, at(s, 29, 35), at(s, 40 + (k % 40), 20 + ((k / 40) | 0)));
    expect(selectAllOf(s, 1, 'warship').length).toBe(MAX_GROUP_UNITS);
    expect(pruneSelection(s, 1, idsOf(s, 1, 'warship')).length).toBe(MAX_GROUP_UNITS);
  });

  it('says what is selected', () => {
    const s = game();
    const w = idsOf(s, 1, 'warship');
    const t = idsOf(s, 1, 'tankDivision');
    expect(selectionText(splitSelection(s, 1, w))).toBe('2 warships selected');
    expect(selectionText(splitSelection(s, 1, [t[0]]))).toBe('1 tank division selected');
    expect(selectionText(splitSelection(s, 1, [...w, t[0]]))).toBe('2 warships, 1 tank division selected');
    expect(selectionText(splitSelection(s, 1, []))).toBe('');
    const ui = defaultUiState();
    ui.selection = w;
    expect(selectionChipText(s, ui)).toMatch(/^2 warships selected: click water/);
  });
});

describe('group orders', () => {
  it('water sends the warships (one moveWarships), own land drives the divisions', () => {
    const s = game();
    const w = idsOf(s, 1, 'warship');
    const t = idsOf(s, 1, 'tankDivision');
    const sea = orderForClick(s, 1, [...w, ...t], at(s, 50, 20), null, 0);
    expect(sea).toEqual({ kind: 'act', actions: [{ type: 'moveWarships', unitIds: w, tile: at(s, 50, 20) }], spearhead: false });
    const land = orderForClick(s, 1, [...w, ...t], at(s, 5, 30), null, 0);
    expect(land).toEqual({ kind: 'act', actions: [{ type: 'moveTankDivision', unitIds: t, tile: at(s, 5, 30) }], spearhead: false });
    // the sim accepts both
    for (const o of [sea, land]) if (o.kind === 'act') for (const a of o.actions) expect(applyAction(s, 1, a)).toEqual({ ok: true });
  });

  it('refuses what the selection cannot do, and lets own-land clicks through for ships', () => {
    const s = game();
    const w = idsOf(s, 1, 'warship');
    const t = idsOf(s, 1, 'tankDivision');
    expect(orderForClick(s, 1, t, at(s, 50, 20), null, 0).kind).toBe('refuse');
    expect(orderForClick(s, 1, w, at(s, 25, 10), null, 0).kind).toBe('refuse');
    expect(orderForClick(s, 1, w, at(s, 5, 30), null, 0).kind).toBe('pass');
    expect(orderForClick(s, 1, idsOf(s, 2, 'warship'), at(s, 50, 20), null, 0).kind).toBe('pass');
  });

  it('enemy land: the first click previews the spearhead, a second click near it launches', () => {
    const s = game();
    const t = idsOf(s, 1, 'tankDivision');
    const ui = defaultUiState();
    ui.selection = t;
    const sent: Action[] = [];
    const dispatch = (a: Action) => {
      sent.push(a);
      return applyAction(s, 1, a);
    };
    const toasts: string[] = [];
    expect(selectionClick(s, ui, dispatch, at(s, 22, 15), (m) => toasts.push(m), 1000)).toBe(true);
    expect(sent).toEqual([]);
    expect(ui.pendingSpearhead).toEqual({ tile: at(s, 22, 15), at: 1000 });
    expect(selectionChipText(s, ui, 1500)).toMatch(/^Spearhead: about \d+ tiles? deep.*Click again to launch/);
    // a second click one tile away confirms (toward the first clicked tile)
    expect(selectionClick(s, ui, dispatch, at(s, 23, 15), (m) => toasts.push(m), 2000)).toBe(true);
    expect(sent).toEqual([{ type: 'moveTankDivision', unitIds: t, tile: at(s, 22, 15) }]);
    expect(ui.pendingSpearhead).toBeNull();
    expect(toasts).toEqual([]);
  });

  it('a stale preview needs a fresh click', () => {
    const s = game();
    const t = idsOf(s, 1, 'tankDivision');
    const pending = { tile: at(s, 22, 15), at: 0 };
    expect(orderForClick(s, 1, t, at(s, 22, 15), pending, 60_000).kind).toBe('preview');
    expect(orderForClick(s, 1, t, at(s, 22, 15), pending, 100).kind).toBe('act');
  });

  it('the same group order gives the same state on two clients', () => {
    const a = game(5);
    const b = game(5);
    for (const s of [a, b]) {
      const o = orderForClick(s, 1, selectAllOf(s, 1, 'warship'), at(s, 60, 20), null, 0);
      if (o.kind !== 'act') throw new Error('expected an order');
      expect(applyAction(s, 1, o.actions[0]).ok).toBe(true);
    }
    expect(hashState(a)).toBe(hashState(b));
  });
});

describe('warship placement', () => {
  it('accepts water near an own port on the same sea, says why otherwise', () => {
    const s = game();
    const ok = spawnWarshipAction(s, 1, at(s, 40, 35));
    expect(ok).toEqual({ type: 'buildWarship', port: at(s, 29, 35), tile: at(s, 40, 35) });
    expect(applyAction(s, 1, ok as Action)).toEqual({ ok: true });
    expect(typeof spawnWarshipAction(s, 1, at(s, 29 + WARSHIP_SPAWN_RANGE + 5, 35))).toBe('string');
    expect(spawnWarshipAction(s, 1, at(s, 10, 30))).toMatch(/water/i);
    expect(typeof spawnWarshipAction(s, 1, at(s, 6, 6))).toBe('string'); // the lake: not reachable from the port
    expect(warshipSpawnCheck(s, 2, at(s, 40, 35)).ok).toBe(false); // player 2 has no port
  });

  it('shades exactly the reachable water within range', () => {
    const s = game();
    const a = warshipSpawnArea(s, 1)!;
    const inMask = (x: number, y: number): boolean => x >= a.x0 && y >= a.y0 && x < a.x0 + a.w && y < a.y0 + a.h && a.mask[(y - a.y0) * a.w + (x - a.x0)] === 1;
    expect(inMask(40, 35)).toBe(true);
    expect(inMask(10, 30)).toBe(false); // land
    expect(inMask(6, 6)).toBe(false); // lake
    expect(inMask(29 + WARSHIP_SPAWN_RANGE + 1, 35)).toBe(false); // out of range
    for (let y = a.y0; y < a.y0 + a.h; y++) for (let x = a.x0; x < a.x0 + a.w; x++) if (inMask(x, y)) expect(warshipSpawnCheck(s, 1, at(s, x, y)).ok).toBe(true);
    expect(warshipSpawnArea(s, 2)).toBeNull();
  });
});

describe('tank division build click', () => {
  it('a click on or next to an own factory builds there; elsewhere it says why', () => {
    const s = game();
    const f = at(s, 10, 20);
    expect(tankDivisionClickAction(s, 1, at(s, 11, 21))).toEqual({ type: 'buildTankDivision', tile: f });
    expect(tankDivisionClickAction(s, 1, at(s, 2, 2))).toBe('Click one of your Factories');
    expect(tankDivisionClickAction(s, 2, f)).toBe('Click one of your Factories');
  });
});
