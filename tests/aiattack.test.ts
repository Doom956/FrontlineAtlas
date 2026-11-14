// AI use of warships, tank divisions and bombers (src/sim/aiattack.ts and the AI parts of naval2.ts, armor2.ts,
// airwings.ts, ai.ts): aim at the AI's own main attack, mend instead of sinking, no landings into enemy waters.
import { describe, expect, it } from 'vitest';
import { applyAction } from '../src/sim/actions';
import { markBuildingsChanged } from '../src/sim/buildings';
import { aiAttackLevel, aiMainAttack, clearAIAttackCache } from '../src/sim/aiattack';
import { seaContested } from '../src/sim/ai';
import { computeCoastAndLand } from '../src/sim/mapgen';
import { aiNavy, aiNeedsRepair, aiShipAim, warshipMaxHp } from '../src/sim/naval2';
import { aiDivisionModes, divisionStrength, pressedBy } from '../src/sim/armor2';
import { spawnTankDivision } from '../src/sim/tanks';
import { TANK_DIVISION_TROOPS } from '../src/sim/config';
import { hashState } from '../src/sim/hash';
import { tick } from '../src/sim/sim';
import { newId } from '../src/sim/state';
import { spawnWarshipAt } from '../src/sim/units';
import { Terrain } from '../src/sim/types';
import type { Action, Building, BuildingType, Difficulty, GameState, Unit } from '../src/sim/types';
import { claimRect, makeFlatGame } from './helpers';

const at = (s: GameState, x: number, y: number): number => y * s.map.width + x;

/** 80x40: land y 0..19 (player 1 human x 0..39, player 2 AI x 40..79), sea y 20..39; a third nation far away. */
function coastGame(difficulty: Difficulty = 'normal'): GameState {
  const s = makeFlatGame(80, 40, 3, { human: true, seed: 7 });
  for (let y = 20; y < 40; y++) for (let x = 0; x < 80; x++) s.map.terrain[at(s, x, y)] = Terrain.DeepWater;
  computeCoastAndLand(s.map);
  claimRect(s, 1, 0, 0, 39, 19);
  claimRect(s, 2, 40, 0, 79, 19);
  s.settings.difficulty = difficulty;
  s.settings.victoryLandShare = 0.99;
  s.admin = { aiPassive: [], godMode: [], aiFrozen: true, revealIntel: [] };
  for (const p of s.players) {
    if (p.id === 0) continue;
    p.gold = 1e6;
    p.iron = 1e5;
    p.oil = 1e5;
    p.techs.push('navigation');
    p.troops = { infantry: 60000, armor: 0, artillery: 0 };
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
function ship(s: GameState, owner: number, x: number, y: number): Unit {
  return spawnWarshipAt(s, owner, at(s, owner === 1 ? 20 : 60, 19), at(s, x, y));
}
/** Runs fn with the AIs awake (their orders go through), then freezes them again (only our calls decide). */
function asAI<T>(s: GameState, fn: () => T): T {
  s.admin!.aiFrozen = false;
  try {
    return fn();
  } finally {
    s.admin!.aiFrozen = true;
  }
}
/** The AI (player 2) attacks the human (player 1). */
function aiAttacks(s: GameState, troops = 20000): void {
  const r = asAI(s, () => applyAction(s, 2, { type: 'attack', tile: at(s, 39, 5), troops: { infantry: troops, armor: 0, artillery: 0 } }));
  expect(r.reason ?? 'ok').toBe('ok');
  clearAIAttackCache(s);
}

describe('AI attack helpers', () => {
  it('levels by difficulty; the main attack is the biggest own attack on a nation', () => {
    const s = coastGame();
    expect(aiAttackLevel(s)).toBe(1);
    s.settings.difficulty = 'easy';
    expect(aiAttackLevel(s)).toBe(0);
    s.settings.difficulty = 'brutal';
    expect(aiAttackLevel(s)).toBe(3);
    expect(aiMainAttack(s, 2)).toBeNull();
    aiAttacks(s);
    const m = aiMainAttack(s, 2);
    expect(m?.target).toBe(1);
    expect(m?.troops).toBeGreaterThan(0);
  });
});

describe('AI warships', () => {
  it('from Normal up, AI ships aim at the nation the AI attacks; on Easy and for a player they keep their old aim', () => {
    const s = coastGame();
    const u = ship(s, 2, 60, 25);
    expect(aiShipAim(s, u)).toBe(0); // no attack yet
    aiAttacks(s);
    expect(aiShipAim(s, u)).toBe(1);
    const mine = ship(s, 1, 20, 25);
    expect(aiShipAim(s, mine)).toBe(0); // a player's ship follows its owner's war target instead
    const e = coastGame('easy');
    const v = ship(e, 2, 60, 25);
    aiAttacks(e);
    expect(aiShipAim(e, v)).toBe(0);
  });

  it('an AI ship on station shells the coast nearest its own attack', () => {
    const s = coastGame();
    const u = ship(s, 2, 75, 30);
    asAI(s, () => applyAction(s, 2, { type: 'setUnitStance', unitIds: [u.id], stance: 'bombard' }));
    aiAttacks(s, 40000);
    for (let k = 0; k < 600 && !(u.state === 3 && u.pathPos >= u.path.length); k++) tick(s);
    expect(u.state).toBe(3);
    expect(s.map.owner[u.station!]).toBe(1);
    // The fight is at x = 39/40: the station is next to it, not at the far end of the enemy coast.
    expect(Math.abs((u.station! % s.map.width) - 39)).toBeLessThan(12);
  });

  it('a badly damaged AI ship stops bombarding and goes to mend at a Port, at every difficulty', () => {
    for (const d of ['easy', 'normal'] as Difficulty[]) {
      const s = coastGame(d);
      addBuilding(s, 'port', 2, at(s, 70, 19));
      const fleet = [ship(s, 2, 45, 25), ship(s, 2, 47, 25), ship(s, 2, 49, 25)];
      aiAttacks(s);
      asAI(s, () => aiNavy(s, 2, (a) => applyAction(s, 2, a)));
      const hurt = fleet.find((u) => u.stance === 'bombard' || u.stance === 'blockade') ?? fleet[0];
      hurt.hp = warshipMaxHp(hurt) * 0.3;
      expect(aiNeedsRepair(s, hurt)).toBe(true);
      asAI(s, () => aiNavy(s, 2, (a) => applyAction(s, 2, a)));
      expect(hurt.stance ?? 'auto').toBe('auto');
      for (let k = 0; k < 900 && hurt.hp < warshipMaxHp(hurt) - 1e-9; k++) tick(s);
      expect(hurt.hp).toBeGreaterThan(warshipMaxHp(hurt) * 0.3); // it reached the Port and mended
      expect(Math.abs(hurt.x - 70)).toBeLessThan(10);
      // Whole again: it gets its job back.
      hurt.hp = warshipMaxHp(hurt);
      expect(aiNeedsRepair(s, hurt)).toBe(false);
    }
  });

  it('no landing through waters where enemy warships outnumber ours', () => {
    const s = coastGame();
    const from = at(s, 60, 19);
    const to = at(s, 20, 19);
    expect(seaContested(s, 2, from, to, 1)).toBe(false);
    ship(s, 1, 22, 24);
    ship(s, 1, 24, 24);
    expect(seaContested(s, 2, from, to, 1)).toBe(true); // the victim's fleet guards its coast
    ship(s, 2, 58, 24);
    ship(s, 2, 56, 24);
    expect(seaContested(s, 2, from, to, 1)).toBe(false); // our own fleet can take it on
    // A third nation's ships only count when we are at war with it.
    expect(seaContested(s, 2, from, to, 0)).toBe(false);
  });

  it('stays deterministic', () => {
    const go = (): number => {
      const s = coastGame();
      s.admin!.aiFrozen = false;
      addBuilding(s, 'port', 2, at(s, 70, 19));
      ship(s, 2, 60, 25);
      ship(s, 2, 62, 25);
      ship(s, 1, 20, 25);
      aiAttacks(s);
      for (let k = 0; k < 400; k++) tick(s);
      return hashState(s);
    };
    expect(go()).toBe(go());
  });
});

/** 60x30 plains: AI player 1 owns x 0..29 (a Factory far back), AI player 2 x 30..59; both AI, frozen (only our calls act). */
function landGame(difficulty: Difficulty = 'normal'): GameState {
  const s = makeFlatGame(60, 30, 2, { seed: 5 });
  claimRect(s, 1, 0, 0, 29, 29);
  claimRect(s, 2, 30, 0, 59, 29);
  s.players[2].capital = at(s, 55, 15);
  s.settings.difficulty = difficulty;
  s.settings.victoryLandShare = 0.99;
  s.admin = { aiPassive: [], godMode: [], aiFrozen: true, revealIntel: [] };
  for (const p of s.players) {
    if (p.id === 0) continue;
    p.gold = 1e6;
    p.iron = 1e5;
    p.oil = 1e5;
    p.personality = 'warlord';
  }
  s.players[1].techs.push('mechanization');
  s.players[1].troops = { infantry: 50000, armor: 20000, artillery: 5000 };
  s.players[2].troops = { infantry: 20000, armor: 0, artillery: 0 };
  addBuilding(s, 'factory', 1, at(s, 3, 15));
  return s;
}
const weaken = (d: Unit, share: number): void => {
  for (const k of ['armor', 'infantry', 'artillery'] as const) d.troops[k] = TANK_DIVISION_TROOPS[k] * share;
};
/** Player 2 attacks player 1 (a push into the AI's land). */
function pushed(s: GameState): void {
  const r = asAI(s, () => applyAction(s, 2, { type: 'attack', tile: at(s, 29, 15), troops: { infantry: 15000, armor: 0, artillery: 0 } }));
  expect(r.reason ?? 'ok').toBe('ok');
}

describe('AI tank divisions', () => {
  it('from Normal up, a division far from the main front supports the stretch of that border nearest it', () => {
    for (const d of ['normal', 'easy'] as Difficulty[]) {
      // A long border at x = 29/30 (y 0..119); the attack is at the north end, the division at the south end.
      const s = makeFlatGame(60, 120, 2, { seed: 5 });
      claimRect(s, 1, 0, 0, 29, 119);
      claimRect(s, 2, 30, 0, 59, 119);
      s.settings.difficulty = d;
      s.settings.victoryLandShare = 0.99;
      s.admin = { aiPassive: [], godMode: [], aiFrozen: true, revealIntel: [] };
      for (const p of s.players) if (p.id) p.troops = { infantry: 60000, armor: 0, artillery: 0 };
      const div = spawnTankDivision(s, 1, at(s, 20, 115));
      asAI(s, () => applyAction(s, 1, { type: 'attack', tile: at(s, 30, 3), troops: { infantry: 10000, armor: 0, artillery: 0 } }));
      asAI(s, () => aiDivisionModes(s, 1, (x) => applyAction(s, 1, x)));
      expect(div.mode).toBe('support');
      const y = (div.station! / s.map.width) | 0;
      if (d === 'normal') expect(y).toBeGreaterThan(90);
      else expect(y).toBeLessThan(30);
    }
  });

  it('a holding division about to be rolled over strikes back when strong (Normal up), on Easy it stays', () => {
    for (const d of ['normal', 'easy'] as Difficulty[]) {
      const s = landGame(d);
      const div = spawnTankDivision(s, 1, at(s, 26, 15));
      expect(pressedBy(s, div)).toBe(0); // no attack on us yet
      pushed(s);
      expect(pressedBy(s, div)).toBe(2);
      const acts: Action[] = [];
      asAI(s, () => aiDivisionModes(s, 1, (a) => (acts.push(a), applyAction(s, 1, a))));
      if (d === 'normal') {
        expect(acts.some((a) => a.type === 'moveTankDivision')).toBe(true);
        expect(div.state === 2 || div.state === 3).toBe(true);
      } else expect(acts.some((a) => a.type === 'moveTankDivision')).toBe(false);
    }
  });

  it('a worn division under a push, or worn out after a spearhead, drives back to refit at a Factory', () => {
    for (const d of ['normal', 'easy'] as Difficulty[]) {
      const s = landGame(d);
      const a = spawnTankDivision(s, 1, at(s, 26, 15));
      weaken(a, 0.45);
      pushed(s);
      asAI(s, () => aiDivisionModes(s, 1, (x) => applyAction(s, 1, x)));
      expect(a.mode).toBe('refit');
      expect(a.state).toBe(1); // on its way to the Factory
      const t = landGame(d);
      const b = spawnTankDivision(t, 1, at(t, 20, 5));
      weaken(b, 0.2);
      expect(divisionStrength(b)).toBeLessThan(0.4);
      asAI(t, () => aiDivisionModes(t, 1, (x) => applyAction(t, 1, x)));
      expect(b.mode).toBe('refit');
    }
  });

  it('from Normal up, divisions back our own push before a front we only hold', () => {
    for (const d of ['normal', 'easy'] as Difficulty[]) {
      // Player 1 (x 0..29, y 0..29), player 2 east of it, player 3 south of both.
      const s = makeFlatGame(60, 40, 3, { seed: 5 });
      claimRect(s, 1, 0, 0, 29, 29);
      claimRect(s, 2, 30, 0, 59, 29);
      claimRect(s, 3, 0, 30, 59, 39);
      s.settings.difficulty = d;
      s.settings.victoryLandShare = 0.99;
      s.admin = { aiPassive: [], godMode: [], aiFrozen: true, revealIntel: [] };
      for (const p of s.players) if (p.id) p.troops = { infantry: 60000, armor: 0, artillery: 0 };
      const div = spawnTankDivision(s, 1, at(s, 10, 10));
      asAI(s, () => applyAction(s, 1, { type: 'attack', tile: at(s, 30, 5), troops: { infantry: 10000, armor: 0, artillery: 0 } }));
      asAI(s, () => applyAction(s, 3, { type: 'attack', tile: at(s, 10, 29), troops: { infantry: 15000, armor: 0, artillery: 0 } }));
      asAI(s, () => aiDivisionModes(s, 1, (x) => applyAction(s, 1, x)));
      expect(div.mode).toBe('support');
      expect(s.map.owner[div.station!]).toBe(d === 'normal' ? 2 : 3);
    }
  });
});
