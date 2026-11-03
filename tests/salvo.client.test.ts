// Salvos and the strike preview on the client (src/client/salvoPrefs.ts, airSim.ts, strikes.ts): the remembered
// x1 / x3 / x5 / All size, the action a click sends, what the preview says flies and hits, rocket auto-fire switches
// and an airfield's last result line.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyAction } from '../src/sim/actions';
import { markBuildingsChanged } from '../src/sim/buildings';
import { newId } from '../src/sim/state';
import type { Building, BuildingType, GameState, TechId } from '../src/sim/types';
import { defaultUiState } from '../src/client/uiState';
import { autoFireAction, autoFireAll, autoFireCount, salvoAction, siloAutoFire, wingResult } from '../src/client/airSim';
import { loadSalvo, nextSalvo, saveSalvo } from '../src/client/salvoPrefs';
import { blastSummary, instruction, modeFor, strikeAction, strikeTarget } from '../src/client/strikes';
import { claimRect, makeFlatGame } from './helpers';

const at = (s: GameState, x: number, y: number): number => y * s.map.width + x;

/** 220 x 40: the human (1) owns x 0..59, nation 2 the rest; rich; at war by default (no peace in a flat game). */
function landGame(): GameState {
  const s = makeFlatGame(220, 40, 2, { human: true, seed: 3 });
  claimRect(s, 1, 0, 0, 59, 39);
  claimRect(s, 2, 60, 0, 219, 39);
  s.players[1].capital = at(s, 10, 20);
  s.players[2].capital = at(s, 120, 20);
  for (const p of s.players) {
    if (p.id === 0) continue;
    p.gold = 1e6;
    p.iron = 1e5;
    p.oil = 1e5;
    p.troops = { infantry: 300000, armor: 0, artillery: 0 };
  }
  return s;
}
function addBuilding(s: GameState, type: BuildingType, owner: number, tile: number, level = 1): Building {
  const id = newId(s);
  const b: Building = { id, type, owner, tile, level, buildLeft: 0, upgradeLeft: 0, fighters: 0, bombers: 0, cooldown: 0, dropCooldown: 0, disabledUntil: 0, hp: 1, queuedLevels: 0 };
  s.buildings.set(id, b);
  s.map.building[tile] = id + 1;
  markBuildingsChanged(s);
  return b;
}
const tech = (s: GameState, ...t: TechId[]) => s.players[1].techs.push(...t);
const bombersOut = (s: GameState): number => s.units.filter((u) => u.type === 'bomber' && u.owner === 1).length;

function fakeStorage(): Storage {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
    clear: () => m.clear(),
    key: () => null,
    get length() {
      return m.size;
    },
  } as Storage;
}

afterEach(() => vi.unstubAllGlobals());

describe('salvo size', () => {
  it('cycles x1 -> x3 -> x5 -> All and is remembered for bombs and rockets, atom bombs start at x1', () => {
    expect([1, 3, 5, 0].map((n) => nextSalvo(n as 1 | 3 | 5 | 0))).toEqual([3, 5, 0, 1]);
    vi.stubGlobal('localStorage', fakeStorage());
    expect(loadSalvo()).toEqual({ bomb: 1, rocket: 1, atomBomb: 1 });
    saveSalvo({ bomb: 5, rocket: 0, atomBomb: 3 });
    expect(loadSalvo()).toEqual({ bomb: 5, rocket: 0, atomBomb: 1 });
    expect(defaultUiState().salvo.bomb).toBe(5);
  });

  it('works without storage (blocked or throwing)', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    });
    expect(loadSalvo()).toEqual({ bomb: 1, rocket: 1, atomBomb: 1 });
    expect(() => saveSalvo({ bomb: 3, rocket: 3, atomBomb: 1 })).not.toThrow();
  });

  it('x1 sends the classic action; a salvo sends a count from every site (-1) or the picked one', () => {
    expect(salvoAction('bomb', 77, 500, 1)).toEqual({ type: 'bomb', airfield: 77, tile: 500 });
    expect(salvoAction('bomb', 77, 500, 3)).toEqual({ type: 'bomb', airfield: -1, tile: 500, count: 3 });
    expect(salvoAction('bomb', 77, 500, 0, 77)).toEqual({ type: 'bomb', airfield: 77, tile: 500, count: 0 });
    expect(salvoAction('rocket', 9, 500, 5)).toEqual({ type: 'launchMissile', silo: -1, kind: 'rocket', tile: 500, count: 5 });
    expect(salvoAction('atomBomb', 9, 500, 1)).toEqual({ type: 'launchMissile', silo: 9, kind: 'atomBomb', tile: 500 });
  });
});

describe('salvo preview and click', () => {
  it('x3 bombers from two airfields: the preview counts them, names the sites and the click sends them all', () => {
    const s = landGame();
    const me = s.players[1];
    tech(s, 'flight');
    const a = addBuilding(s, 'airfield', 1, at(s, 50, 20), 2);
    const b = addBuilding(s, 'airfield', 1, at(s, 40, 10), 2);
    a.bombers = 2;
    b.bombers = 2;
    const ui = defaultUiState();
    ui.salvo = { bomb: 3, rocket: 1, atomBomb: 1 };
    const m = modeFor('bomb');
    const tile = at(s, 100, 20);
    const t = strikeTarget(s, me, ui, m, tile);
    expect(t.ok).toBe(true);
    expect(t.count).toBe(3);
    expect(t.sites).toBe(2);
    expect(t.siteTiles[0]).toBe(a.tile);
    expect(t.radius).toBeGreaterThan(0);
    expect(t.kills).toBeGreaterThan(0);
    expect(blastSummary(s, m, t)).toMatch(/^3 bombers from 2 airfields: ~[\d.]+k? troops/);
    expect(instruction(s, me, m, ui)).toMatch(/^Bombing run x3: click enemy land/);
    const act = strikeAction(m, tile, t)!;
    expect(act).toEqual({ type: 'bomb', airfield: -1, tile, count: 3 });
    expect(applyAction(s, 1, act).ok).toBe(true);
    expect(bombersOut(s)).toBe(3);
    expect(a.bombers + b.bombers).toBe(1);
  });

  it('All sends every ready bomber in reach; out of reach says how far', () => {
    const s = landGame();
    const me = s.players[1];
    tech(s, 'flight');
    const a = addBuilding(s, 'airfield', 1, at(s, 10, 20), 1);
    a.bombers = 4;
    const ui = defaultUiState();
    ui.salvo = { bomb: 0, rocket: 1, atomBomb: 1 };
    const m = modeFor('bomb');
    const t = strikeTarget(s, me, ui, m, at(s, 100, 20));
    expect(t.count).toBe(4);
    expect(strikeAction(m, at(s, 100, 20), t)).toMatchObject({ count: 0, airfield: -1 });
    const far = strikeTarget(s, me, ui, m, at(s, 200, 20));
    expect(far.ok).toBe(false);
    expect(far.reason).toMatch(/^Too far: your nearest bombers reach 150 tiles, this is 190 away/);
  });

  it('x5 rockets with 2 loaded: says how many fly and how many are missing', () => {
    const s = landGame();
    const me = s.players[1];
    tech(s, 'rocketry');
    addBuilding(s, 'silo', 1, at(s, 20, 20));
    addBuilding(s, 'silo', 1, at(s, 30, 30));
    const ui = defaultUiState();
    ui.salvo = { bomb: 1, rocket: 5, atomBomb: 1 };
    const m = modeFor('rocket');
    const tile = at(s, 120, 20);
    const t = strikeTarget(s, me, ui, m, tile);
    expect(t.ok).toBe(true);
    expect(t.count).toBe(2);
    expect(blastSummary(s, m, t)).toMatch(/^2 rockets from 2 silos \(3 more not ready/);
    expect(applyAction(s, 1, strikeAction(m, tile, t)!).ok).toBe(true);
    expect(s.units.filter((u) => u.type === 'rocket').length).toBe(2);
  });
});

describe('rocket auto-fire switches and wing results', () => {
  it('one silo, then every silo; the counts follow the sim', () => {
    const s = landGame();
    tech(s, 'rocketry');
    const a = addBuilding(s, 'silo', 1, at(s, 20, 20));
    addBuilding(s, 'silo', 1, at(s, 30, 30));
    // on for every silo by default; all off, then one silo, then every silo
    expect(autoFireCount(s, 1)).toEqual({ silos: 2, on: 2 });
    expect(applyAction(s, 1, autoFireAction(-1, false)).ok).toBe(true);
    expect(autoFireCount(s, 1)).toEqual({ silos: 2, on: 0 });
    expect(applyAction(s, 1, autoFireAction(a.tile, true)).ok).toBe(true);
    expect(siloAutoFire(s, a)).toBe(true);
    expect(autoFireCount(s, 1).on).toBe(1);
    expect(applyAction(s, 1, autoFireAction(-1, true)).ok).toBe(true);
    expect(autoFireAll(s, 1)).toBe(true);
    expect(autoFireCount(s, 1).on).toBe(2);
    expect(applyAction(s, 1, autoFireAction(-1, false)).ok).toBe(true);
    expect(autoFireCount(s, 1).on).toBe(0);
  });

  it('an airfield with no result yet has no line', () => {
    const s = landGame();
    tech(s, 'flight');
    const a = addBuilding(s, 'airfield', 1, at(s, 50, 20), 2);
    expect(wingResult(s, a)).toEqual({ ago: -1, line: '' });
  });
});
