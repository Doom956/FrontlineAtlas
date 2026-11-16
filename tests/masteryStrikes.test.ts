// The mastery strikes as bottom-bar buttons (client/masteryStrikes.ts): Stealth strike, Cruise missile and
// Breakthrough. Each is hidden without its mastery, says plainly why it is off, picks its own launcher (nearest
// airfield, loaded ships, a ready division) and enters the same target mode as the card buttons.
import { describe, expect, it } from 'vitest';
import { applyAction } from '../src/sim/actions';
import { markBuildingsChanged } from '../src/sim/buildings';
import { BLITZ, CRUISE, STEALTH } from '../src/sim/config';
import { computeCoastAndLand } from '../src/sim/mapgen';
import { newId } from '../src/sim/state';
import { spawnTankDivision } from '../src/sim/tanks';
import { spawnWarshipAt } from '../src/sim/units';
import { Terrain } from '../src/sim/types';
import type { Building, GameState } from '../src/sim/types';
import { aimMastery, MASTERY_ORDER, masteryAiming, masteryStatus } from '../src/client/masteryStrikes';
import { stealthClick, stealthTarget } from '../src/client/stealth';
import { defaultUiState } from '../src/client/uiState';
import { claimRect, makeFlatGame } from './helpers';

const at = (s: GameState, x: number, y: number): number => y * s.map.width + x;

function addAirfield(s: GameState, owner: number, tile: number): Building {
  const id = newId(s);
  const b: Building = { id, type: 'airfield', owner, tile, level: 1, buildLeft: 0, upgradeLeft: 0, fighters: 0, bombers: 0, cooldown: 0, dropCooldown: 0, disabledUntil: 0, hp: 1, queuedLevels: 0 };
  s.buildings.set(id, b);
  s.map.building[tile] = id + 1;
  markBuildingsChanged(s);
  return b;
}

/** Land x 0..59 (player 1) and 60..119 (player 2), y 0..29; water below. Rich; the human is player 1. */
function game(): GameState {
  const s = makeFlatGame(120, 60, 2, { human: true, seed: 3 });
  for (let y = 30; y < 60; y++) for (let x = 0; x < 120; x++) s.map.terrain[at(s, x, y)] = Terrain.DeepWater;
  computeCoastAndLand(s.map);
  claimRect(s, 1, 0, 0, 59, 29);
  claimRect(s, 2, 60, 0, 119, 29);
  s.humanId = 1;
  for (const p of s.players) {
    if (p.id === 0) continue;
    p.gold = 1e6;
    p.iron = 1e5;
    p.oil = 1e5;
    p.techs.push('flight', 'navigation');
    p.troops = { infantry: 50000, armor: 20000, artillery: 5000 };
  }
  return s;
}

describe('mastery strike buttons', () => {
  it('stay hidden without their mastery', () => {
    const s = game();
    for (const id of MASTERY_ORDER) expect(masteryStatus(s, s.players[1], id).show).toBe(false);
    expect(aimMastery(s, s.players[1], defaultUiState(), 'stealth')).not.toBe('');
  });

  it('Stealth strike: needs an airfield, then is ready, aims from any airfield (-1) and recharges', () => {
    const s = game();
    const me = s.players[1];
    me.techs.push('airMastery');
    expect(masteryStatus(s, me, 'stealth')).toMatchObject({ show: true, state: 'blocked' });
    expect(masteryStatus(s, me, 'stealth').line).toContain('Airfield');
    addAirfield(s, 1, at(s, 40, 10));
    addAirfield(s, 1, at(s, 10, 10));
    const st = masteryStatus(s, me, 'stealth');
    expect(st).toMatchObject({ state: 'ready', count: 2 });
    expect(st.line).toContain('gold');
    const ui = defaultUiState();
    expect(aimMastery(s, me, ui, 'stealth')).toBe('');
    expect(ui.mode).toEqual({ kind: 'stealth', airfield: -1 });
    expect(masteryAiming(ui, 'stealth')).toBe(true);
    // the click: the nearest airfield in reach flies
    const target = at(s, 100, 10);
    expect(stealthTarget(s, me, -1, target)).toMatchObject({ ok: true, airfield: at(s, 40, 10) });
    expect(stealthClick(s, me, -1, target)).toEqual({ type: 'stealthStrike', airfield: -1, tile: target });
    // a second click on the button leaves the mode
    expect(aimMastery(s, me, ui, 'stealth')).toBe('');
    expect(ui.mode.kind).toBe('none');
    // fire: the button recharges
    expect(applyAction(s, 1, { type: 'stealthStrike', airfield: -1, tile: target }).ok).toBe(true);
    const cd = masteryStatus(s, me, 'stealth');
    expect(cd.state).toBe('blocked'); // in the air
    expect(cd.line).toContain('in the air');
    s.units = s.units.filter((u) => u.type !== 'stealthBomber');
    const rc = masteryStatus(s, me, 'stealth');
    expect(rc).toMatchObject({ state: 'cooldown', total: STEALTH.cooldownSeconds });
    expect(rc.left).toBeGreaterThan(0);
    expect(aimMastery(s, me, defaultUiState(), 'stealth')).toContain('Recharging');
  });

  it('Cruise missile: loaded ships together, the reload as a cooldown', () => {
    const s = game();
    const me = s.players[1];
    me.techs.push('navalMastery');
    expect(masteryStatus(s, me, 'cruise')).toMatchObject({ show: true, state: 'blocked' });
    const a = spawnWarshipAt(s, 1, at(s, 30, 29), at(s, 70, 32));
    const b = spawnWarshipAt(s, 1, at(s, 40, 29), at(s, 70, 32));
    const st = masteryStatus(s, me, 'cruise');
    expect(st).toMatchObject({ state: 'ready', count: 2 });
    const ui = defaultUiState();
    expect(aimMastery(s, me, ui, 'cruise')).toBe('');
    expect(ui.mode.kind).toBe('cruise');
    if (ui.mode.kind === 'cruise') expect(ui.mode.ships.sort()).toEqual([a.id, b.id].sort());
    ui.mode = { kind: 'none' };
    a.cruiseReady = s.tick + 12 * 10;
    expect(masteryStatus(s, me, 'cruise')).toMatchObject({ state: 'ready', count: 1 });
    b.cruiseReady = s.tick + 5 * 10;
    const cd = masteryStatus(s, me, 'cruise');
    expect(cd).toMatchObject({ state: 'cooldown', left: 5, total: CRUISE.reloadSeconds });
  });

  it('Breakthrough: needs a division, picks the first ready one', () => {
    const s = game();
    const me = s.players[1];
    me.techs.push('mechanization', 'armorMastery');
    expect(masteryStatus(s, me, 'blitz')).toMatchObject({ show: true, state: 'blocked' });
    const d1 = spawnTankDivision(s, 1, at(s, 50, 20));
    const d2 = spawnTankDivision(s, 1, at(s, 52, 20));
    expect(masteryStatus(s, me, 'blitz')).toMatchObject({ state: 'ready', count: 2 });
    d1.blitzReady = s.tick + 30 * 10;
    const ui = defaultUiState();
    expect(aimMastery(s, me, ui, 'blitz')).toBe('');
    expect(ui.mode).toEqual({ kind: 'blitz', unitId: d2.id });
    ui.mode = { kind: 'none' };
    d2.blitzReady = s.tick + 20 * 10;
    const cd = masteryStatus(s, me, 'blitz');
    expect(cd).toMatchObject({ state: 'cooldown', total: BLITZ.cooldownSeconds });
    expect(cd.left).toBeLessThanOrEqual(20);
    expect(aimMastery(s, me, ui, 'blitz')).toContain('Recharging');
  });
});
