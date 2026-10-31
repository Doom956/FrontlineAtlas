// Special units on the client: buy status and lines, what a unit is doing, incoming threats, the advisor's unit
// hints and the research tree layout.
import { describe, expect, it } from 'vitest';
import { markBuildingsChanged } from '../src/sim/buildings';
import { TECHS, TECH_ORDER, UNITS } from '../src/sim/config';
import { computeCoastAndLand } from '../src/sim/mapgen';
import { newId } from '../src/sim/state';
import { buildWarship, launchTransport } from '../src/sim/units';
import { Terrain } from '../src/sim/types';
import type { Building, BuildingType, GameState } from '../src/sim/types';
import { buildUnit, isIncoming, unitBuildStatus, unitDoing } from '../src/client/forces';
import { claimRect, makeFlatGame } from './helpers';

const at = (s: GameState, x: number, y: number): number => y * s.map.width + x;

/** 60x30: land x 0..19 (player 1, the human), sea x 20..49, land x 50..59 (player 2). Everyone is rich. */
function seaGame(): GameState {
  const s = makeFlatGame(60, 30, 2, { human: true, seed: 7 });
  for (let y = 0; y < 30; y++) for (let x = 20; x < 50; x++) s.map.terrain[at(s, x, y)] = Terrain.DeepWater;
  computeCoastAndLand(s.map);
  claimRect(s, 1, 0, 0, 19, 29);
  claimRect(s, 2, 50, 0, 59, 29);
  for (const p of s.players) {
    if (p.id === 0) continue;
    p.gold = 100000;
    p.iron = 10000;
    p.oil = 10000;
  }
  return s;
}
function addBuilding(s: GameState, type: BuildingType, owner: number, tile: number): Building {
  const id = newId(s);
  const b: Building = { id, type, owner, tile, level: 1, buildLeft: 0, upgradeLeft: 0, fighters: 0, bombers: 0, cooldown: 0, dropCooldown: 0, disabledUntil: 0, hp: 1, queuedLevels: 0 };
  s.buildings.set(id, b);
  s.map.building[tile] = id + 1;
  markBuildingsChanged(s);
  return b;
}

describe('buying special units', () => {
  it('says how to unlock a warship, step by step, then builds one at the port', () => {
    const s = seaGame();
    const me = s.players[1];
    let st = unitBuildStatus(s, me, 'warship');
    expect(st.ok).toBe(false);
    expect(st.locked).toBe(true);
    expect(st.line).toBe('Research Navigation (T) and build a Port');
    me.techs.push('navigation');
    expect(unitBuildStatus(s, me, 'warship').line).toMatch(/^Build a Port/);
    const port = addBuilding(s, 'port', 1, at(s, 19, 10));
    port.buildLeft = 4;
    expect(unitBuildStatus(s, me, 'warship').line).toBe('Your Port is being built');
    port.buildLeft = 0;
    st = unitBuildStatus(s, me, 'warship');
    expect(st.ok).toBe(true);
    expect(st.site).toBe(port.tile);
    expect(buildUnit(s, me, (a) => (a.type === 'buildWarship' ? buildWarship(s, 1, a.port) : { ok: false }), 'warship', null)).toBe('');
    expect(s.units.filter((u) => u.type === 'warship' && u.owner === 1).length).toBe(1);
    me.gold = 10;
    st = unitBuildStatus(s, me, 'warship');
    expect(st.ok).toBe(false);
    expect(st.locked).toBe(false);
    expect(st.line).toBe(`Needs ${UNITS.warship.gold} gold`);
  });

  it('names the missing prerequisite of Flight and picks the airfield with room', () => {
    const s = seaGame();
    const me = s.players[1];
    expect(unitBuildStatus(s, me, 'bomber').line).toBe('Research Logistics, then Flight (T) and build an Airfield');
    me.techs.push('logistics', 'flight');
    const full = addBuilding(s, 'airfield', 1, at(s, 2, 2));
    full.bombers = 6;
    const free = addBuilding(s, 'airfield', 1, at(s, 2, 25));
    const st = unitBuildStatus(s, me, 'fighter', { x: 2, y: 2 });
    expect(st.ok).toBe(true);
    expect(st.site).toBe(free.tile);
    free.fighters = 6;
    expect(unitBuildStatus(s, me, 'fighter').line).toMatch(/full/);
  });
});

describe('reading units on the map', () => {
  it('describes a transport heading for a coast and flags it as incoming', () => {
    const s = seaGame();
    s.players[2].troops.infantry = 50000;
    const r = launchTransport(s, 2, at(s, 50, 10), at(s, 19, 12), { infantry: 20000, armor: 0, artillery: 0 });
    expect(r.ok).toBe(true);
    const u = s.units.find((q) => q.type === 'transport')!;
    expect(unitDoing(s, s.players[1], u)).toBe("20k troops heading to your coast");
    expect(isIncoming(s, 1, u)).toBe(true);
    expect(isIncoming(s, 2, u)).toBe(false);
  });
});

describe('advisor unit hints', () => {
  it('suggests warships when enemy warships sail off your coast', async () => {
    const { unitAdvice } = await import('../src/client/hud/advisor');
    const s = seaGame();
    const me = s.players[1];
    s.players[2].techs.push('navigation');
    const port = addBuilding(s, 'port', 2, at(s, 50, 10));
    expect(buildWarship(s, 2, port.tile).ok).toBe(true);
    expect(unitAdvice(s, me)).toEqual([]); // 30 tiles away
    const ship = s.units.find((u) => u.type === 'warship')!;
    ship.x = 22;
    ship.y = 10;
    const tips = unitAdvice(s, me);
    expect(tips.map((t) => t.key)).toEqual(['unit-warship']);
    expect(tips[0].drawer).toBe('research');
  });
});

describe('research tree layout', () => {
  it('puts tiers in order left to right, prerequisites in earlier tracks, one slot per cell (a choice shares one)', async () => {
    const { treeLayout, TECH_LINE } = await import('../src/client/hud/researchTree');
    const { pos, rows, cols, layout } = treeLayout();
    expect(cols).toBe(layout.tracks.length);
    // fits the drawer at 1280x720: at most six rows
    expect(rows).toBeLessThanOrEqual(6);
    const cells = new Map<string, string>();
    for (const t of TECH_ORDER) {
      const p = pos.get(t)!;
      expect(layout.tracks[p.col].tier).toBe(TECHS[t].tier);
      expect(p.row).toBeGreaterThanOrEqual(0);
      expect(p.row).toBeLessThan(rows);
      // one cell per slot: a choice group's techs share theirs
      const key = TECHS[t].exclusiveGroup ? `group:${TECHS[t].exclusiveGroup}` : t;
      const cell = `${p.col},${p.row}`;
      expect(cells.get(cell) ?? key).toBe(key);
      cells.set(cell, key);
      for (const r of [...TECHS[t].requires, ...(TECHS[t].requiresAny ?? [])]) expect(pos.get(r)!.col).toBeLessThan(p.col);
      expect(TECH_LINE[t].length).toBeLessThanOrEqual(46);
    }
  });
});
