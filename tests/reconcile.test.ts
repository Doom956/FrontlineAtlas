// Round 2 joins: the Arsenal rows list every special with its real prerequisites, the two Research-panel tabs show
// each tech once, and the AI picks specials that fit it (arsenalAI.ts).
import { describe, expect, it } from 'vitest';
import { aiAmphibTarget, aiSpecialPick, narrowShore } from '../src/sim/arsenalAI';
import { ARSENAL_ROWS, arsenalItem, isArsenalTech } from '../src/sim/arsenal';
import { markBuildingsChanged } from '../src/sim/buildings';
import { TECHS, TECH_ORDER } from '../src/sim/config';
import { SPECIAL_TECHS } from '../src/sim/specials';
import { computeCoastAndLand } from '../src/sim/mapgen';
import { newId } from '../src/sim/state';
import { spawnTankDivision, spearheadPreview } from '../src/sim/tanks';
import { Terrain } from '../src/sim/types';
import { techStatus } from '../src/sim/techtree';
import type { Building, BuildingType, GameState, TechId } from '../src/sim/types';
import { panelLayout } from '../src/client/hud/techRows';
import { claimRect, makeFlatGame } from './helpers';

function addBuilding(s: GameState, type: BuildingType, owner: number, tile: number, bombers = 0): Building {
  const id = newId(s);
  const b: Building = { id, type, owner, tile, level: 1, buildLeft: 0, upgradeLeft: 0, fighters: 0, bombers, cooldown: 0, dropCooldown: 0, disabledUntil: 0, hp: 1, queuedLevels: 0 } as Building;
  s.buildings.set(id, b);
  s.map.building[tile] = id + 1;
  markBuildingsChanged(s);
  return b;
}
const give = (s: GameState, id: number, ...techs: TechId[]): void => {
  for (const t of techs) if (!s.players[id].techs.includes(t)) s.players[id].techs.push(t);
};

describe('Arsenal rows and tabs', () => {
  it('lists every special upgrade as a special whose prerequisites exist', () => {
    for (const t of SPECIAL_TECHS) {
      const it = arsenalItem(t);
      expect(it, t).toBeDefined();
      expect(it!.kind).toBe('special');
      for (const r of TECHS[t].requires) expect(TECHS[r], `${t} needs ${r}`).toBeDefined();
    }
  });

  it('shows every tech in exactly one tab, once', () => {
    const seen = new Map<TechId, number>();
    for (const tab of ['research', 'arsenal'] as const) {
      for (const c of panelLayout(tab).rows.flatMap((r) => r.cards)) seen.set(c.tech, (seen.get(c.tech) ?? 0) + 1);
    }
    for (const t of TECH_ORDER) expect(seen.get(t), t).toBe(1);
    for (const c of panelLayout('research').rows.flatMap((r) => r.cards)) expect(isArsenalTech(c.tech), c.tech).toBe(false);
    const rowTechs = ARSENAL_ROWS.flatMap((r) => r.items.map((i) => i.tech));
    expect(new Set(rowTechs).size).toBe(rowTechs.length);
  });
});

describe('AI special upgrades (arsenalAI.ts)', () => {
  function game(): GameState {
    const s = makeFlatGame(60, 30, 2);
    claimRect(s, 1, 0, 0, 29, 29);
    claimRect(s, 2, 30, 0, 59, 29);
    return s;
  }

  it('takes Radar, then Early Warning, against a big hostile air force', () => {
    const s = game();
    give(s, 1, 'agriculture', 'metallurgy', 'logistics', 'navigation', 'fortification', 'flight');
    const w = s.map.width;
    for (let k = 0; k < 4; k++) addBuilding(s, 'airfield', 2, 5 * w + 40 + 3 * k, 2);
    expect(techStatus(s, 1, 'radar')).toBe('available');
    expect(aiSpecialPick(s, 1, [2])).toBe('radar');
    give(s, 1, 'radar');
    expect(aiSpecialPick(s, 1, [2])).toBe('earlyWarning');
    // Not a neighbour and not at war: no reason to.
    expect(aiSpecialPick(s, 1, [])).toBeNull();
  });

  it('waits for a broad enough base, and never picks for humans', () => {
    const s = game();
    give(s, 1, 'flight', 'radar');
    const w = s.map.width;
    for (let k = 0; k < 4; k++) addBuilding(s, 'airfield', 2, 5 * w + 40 + 3 * k, 2);
    expect(aiSpecialPick(s, 1, [2])).toBeNull(); // 2 techs
    give(s, 1, 'agriculture', 'metallurgy', 'logistics', 'navigation');
    expect(aiSpecialPick(s, 1, [2])).toBe('earlyWarning');
    s.players[1].isHuman = true;
    expect(aiSpecialPick(s, 1, [2])).toBeNull();
  });
});

describe('AI Amphibious Tanks crossings (arsenalAI.ts)', () => {
  it('finds enemy land across a narrow strait that a spearhead can be launched at', () => {
    const s = makeFlatGame(70, 30, 2);
    const w = s.map.width;
    for (let y = 0; y < 30; y++) for (let x = 25; x < 28; x++) s.map.terrain[y * w + x] = Terrain.ShallowWater;
    computeCoastAndLand(s.map);
    claimRect(s, 1, 0, 0, 24, 29);
    claimRect(s, 2, 28, 0, 69, 29);
    give(s, 1, 'mechanization', 'navigation');
    s.players[1].troops = { infantry: 50000, armor: 20000, artillery: 5000 };
    expect(narrowShore(s, 1)).toBeGreaterThanOrEqual(4);
    const t = aiAmphibTarget(s, 1, 2, 20, 15);
    expect(t).toBeGreaterThanOrEqual(0);
    expect(s.map.owner[t]).toBe(2);
    expect(t % w).toBe(28);
    const d = spawnTankDivision(s, 1, 15 * w + 20);
    give(s, 1, 'amphibiousTanks');
    expect(spearheadPreview(s, 1, d.id, t).reason).toBe('');
  });
});
