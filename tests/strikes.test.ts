// Client strike helpers (src/client/strikes.ts): status lines, target checks and the barrage reach zone.
import { describe, expect, it } from 'vitest';
import { applyAction } from '../src/sim/actions';
import { markBuildingsChanged } from '../src/sim/buildings';
import { BARRAGE_MIN_ARTILLERY, BARRAGE_RANGE } from '../src/sim/config';
import { newId } from '../src/sim/state';
import type { Building, BuildingType, GameState, TechId } from '../src/sim/types';
import { defaultUiState } from '../src/client/uiState';
import {
  aimStrike,
  allStrikes,
  barrageReach,
  instruction,
  modeFor,
  STRIKE_ORDER,
  STRIKES,
  strikeAction,
  strikeForKey,
  strikeStatus,
  strikesRevealed,
  strikeTarget,
  strikeToastText,
} from '../src/client/strikes';
import { claimRect, makeFlatGame } from './helpers';

const at = (s: GameState, x: number, y: number): number => y * s.map.width + x;

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
  }
  return s;
}
function addBuilding(s: GameState, type: BuildingType, owner: number, tile: number): Building {
  const id = newId(s);
  const b: Building = { id, type, owner, tile, level: 1, buildLeft: 0, upgradeLeft: 0, fighters: 0, bombers: 0, cooldown: 0, dropCooldown: 0, disabledUntil: 0, hp: 1 };
  s.buildings.set(id, b);
  s.map.building[tile] = id + 1;
  markBuildingsChanged(s);
  return b;
}
const tech = (s: GameState, ...t: TechId[]) => s.players[1].techs.push(...t);

describe('strike status', () => {
  it('locked strikes say in one line how to unlock them', () => {
    const s = landGame();
    const me = s.players[1];
    const lines = Object.fromEntries(allStrikes(s, me).map((x) => [x.id, x]));
    for (const id of STRIKE_ORDER) expect(lines[id].state).toBe('locked');
    expect(lines.barrage.line).toBe('Build an Arsenal, then raise Artillery in the Army drawer (U)');
    expect(lines.bomb.line).toBe('Research Flight and build an Airfield, then build a bomber there');
    expect(lines.paradrop.line).toBe('Research Flight and build an Airfield');
    expect(lines.rocket.line).toBe('Research Rocketry and build a Missile Silo');
    expect(lines.atomBomb.line).toBe('Research Nuclear Fission and build a Missile Silo');
    // nothing started and early in the game: the group stays hidden
    expect(strikesRevealed(s, allStrikes(s, me))).toBe(false);
    addBuilding(s, 'arsenal', 1, at(s, 10, 10));
    const st = strikeStatus(s, me, 'barrage');
    expect(st.line).toMatch(/artillery, you have 0: raise Artillery in the Army drawer \(U\)$/);
    expect(strikesRevealed(s, allStrikes(s, me))).toBe(true);
  });

  it('ready, reloading and the hotkeys', () => {
    const s = landGame();
    const me = s.players[1];
    me.troops.artillery = BARRAGE_MIN_ARTILLERY + 10;
    expect(strikeStatus(s, me, 'barrage').state).toBe('ready');
    const ui = defaultUiState();
    expect(aimStrike(s, me, ui, 'barrage')).toBe('');
    expect(ui.mode).toEqual({ kind: 'barrage' });
    expect(instruction(s, me, ui.mode)).toBe(`Barrage: click enemy land within ${BARRAGE_RANGE} tiles of your border. Esc to cancel.`);
    expect(aimStrike(s, me, ui, 'barrage')).toBe(''); // same key again: stop aiming
    expect(ui.mode.kind).toBe('none');
    expect(applyAction(s, 1, { type: 'barrage', tile: at(s, 65, 20) }).ok).toBe(true);
    const cool = strikeStatus(s, me, 'barrage');
    expect(cool.state).toBe('cooldown');
    expect(cool.left).toBeGreaterThan(0);
    expect(cool.total).toBeGreaterThanOrEqual(cool.left);
    expect(aimStrike(s, me, ui, 'barrage')).toMatch(/^Guns reloading/);
    for (const id of STRIKE_ORDER) expect(strikeForKey(STRIKES[id].key)).toBe(id);
    expect(new Set(STRIKE_ORDER.map((id) => STRIKES[id].key)).size).toBe(STRIKE_ORDER.length);
  });

  it('modifiers hide what is off', () => {
    const s = landGame();
    s.settings.modifiers = { ...(s.settings.modifiers as object), noNukes: true, noAir: true } as never;
    const allowed = allStrikes(s, s.players[1]).filter((x) => x.allowed).map((x) => x.id);
    expect(allowed).toEqual(['barrage', 'rocket']);
  });
});

describe('strike targets', () => {
  it('bombs: picks an airfield with bombers, refuses own land and empty targets', () => {
    const s = landGame();
    const me = s.players[1];
    tech(s, 'flight');
    const af = addBuilding(s, 'airfield', 1, at(s, 20, 20));
    expect(strikeStatus(s, me, 'bomb').line).toMatch(/^Build a bomber/);
    af.bombers = 2;
    const st = strikeStatus(s, me, 'bomb');
    expect(st.state).toBe('ready');
    expect(st.count).toBe(2);
    const ui = defaultUiState();
    const m = modeFor('bomb');
    const own = strikeTarget(s, me, ui, m, at(s, 30, 20));
    expect(own.ok).toBe(false);
    expect(own.reason).toBe('That is your own land');
    const t = strikeTarget(s, me, ui, m, at(s, 100, 20));
    expect(t.ok).toBe(true);
    expect(t.from).toBe(af.tile);
    expect(t.enemyTiles).toBeGreaterThan(0);
    const a = strikeAction(m, at(s, 100, 20), t)!;
    expect(applyAction(s, 1, a).ok).toBe(true);
    expect(af.bombers).toBe(1);
  });

  it('SAM cover on the route is named; rockets need a loaded silo', () => {
    const s = landGame();
    const me = s.players[1];
    tech(s, 'rocketry');
    addBuilding(s, 'silo', 1, at(s, 20, 20));
    addBuilding(s, 'sam', 2, at(s, 110, 20));
    const ui = defaultUiState();
    const t = strikeTarget(s, me, ui, modeFor('rocket'), at(s, 120, 20));
    expect(t.ok).toBe(true);
    expect(t.covered).toMatch(/SAM site covers the route/);
    expect(applyAction(s, 1, strikeAction(modeFor('rocket'), at(s, 120, 20), t)!).ok).toBe(true);
    expect(strikeStatus(s, me, 'rocket').state).toBe('cooldown');
    expect(strikeTarget(s, me, ui, modeFor('rocket'), at(s, 120, 20)).ok).toBe(false);
  });

  it('barrage reach covers the band next to your land only', () => {
    const s = landGame();
    const mask = barrageReach(s, 1, BARRAGE_RANGE);
    const cellAt = (x: number, y: number) => mask.inside[((y / mask.cell) | 0) * mask.cw + ((x / mask.cell) | 0)];
    expect(cellAt(59 + BARRAGE_RANGE - 2, 20)).toBe(1);
    expect(cellAt(59 + BARRAGE_RANGE + 4, 20)).toBe(0);
    expect(cellAt(10, 10)).toBe(1);
  });
});

describe('strike toasts', () => {
  it('own strikes read as a report, strikes on you as a warning, shot-down planes name who did it', () => {
    const s = landGame();
    const me = s.players[1];
    const ev = (kind: string, message: string) => ({ kind, message, players: [1, 2], tile: 0, tick: 0 }) as never;
    expect(strikeToastText(ev('barrage', `${me.name} shelled AI 2: 120 troops lost`), me)).toEqual({ text: 'Barrage on AI 2: 120 troops killed', kind: 'good', icon: 'barrage' });
    expect(strikeToastText(ev('bombing', `AI 2 bombed ${me.name}: 1 building destroyed, 30 troops killed`), me)?.kind).toBe('bad');
    expect(strikeToastText(ev('unitLost', `AI 2's SAM site shot down a bomber of ${me.name}`), me)?.text).toBe("AI 2's SAM site shot down your bomber");
    expect(strikeToastText(ev('underAttack', 'x'), me)).toBeNull();
  });
});

describe('artillery advice', () => {
  it('a fortified front without an Arsenal: build one; with one and no artillery in a hand-set mix: raise it', async () => {
    const { artilleryAdvice } = await import('../src/client/hud/advisor');
    const s = landGame();
    const me = s.players[1];
    expect(artilleryAdvice(s, me)).toBeNull();
    addBuilding(s, 'fort', 2, at(s, 62, 20));
    addBuilding(s, 'fort', 2, at(s, 62, 5));
    addBuilding(s, 'fort', 2, at(s, 62, 35));
    expect(artilleryAdvice(s, me)?.text).toBe("AI 2's forts ahead: build an Arsenal and use artillery");
    addBuilding(s, 'arsenal', 1, at(s, 10, 10));
    me.auto.mix = false;
    me.armyMix.artillery = 0;
    expect(artilleryAdvice(s, me)?.drawer).toBe('army');
  });
});
