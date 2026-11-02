import { describe, expect, it } from 'vitest';
import { makeFlatGame, claimRect } from './helpers';
import { newId } from '../src/sim/state';
import { markBuildingsChanged } from '../src/sim/buildings';
import { tick } from '../src/sim/sim';
import { hashState } from '../src/sim/hash';
import type { GameState } from '../src/sim/types';

/** A human with a big army, many factories and arsenals and a mix that wants far more armor and artillery. */
function bigArmy(): GameState {
  const s = makeFlatGame(80, 40, 3, { human: true, seed: 4 });
  const at = (x: number, y: number) => y * s.map.width + x;
  claimRect(s, 1, 0, 0, 39, 39);
  s.admin = { aiPassive: [], godMode: [], aiFrozen: true, revealIntel: [] };
  const p = s.players[1];
  p.troops = { infantry: 400_000, armor: 10_000, artillery: 4_000 };
  p.gold = 5_000;
  p.iron = 1e6;
  p.oil = 1e6;
  p.auto.mix = false;
  p.armyMix = { armor: 0.3, artillery: 0.15 };
  const sites: ['factory' | 'arsenal', number][] = [['factory', 2], ['factory', 6], ['factory', 10], ['factory', 14], ['factory', 18], ['factory', 22], ['arsenal', 26], ['arsenal', 30], ['arsenal', 34]];
  for (const [type, x] of sites) {
    const id = newId(s);
    s.buildings.set(id, { id, type, owner: 1, tile: at(x, 10), level: 3, buildLeft: 0, upgradeLeft: 0, fighters: 0, bombers: 0, cooldown: 0, dropCooldown: 0, disabledUntil: 0, hp: 1, queuedLevels: 0 });
    s.map.building[at(x, 10)] = id + 1;
  }
  markBuildingsChanged(s);
  return s;
}

describe('army conversion and gold', () => {
  it('factories and arsenals never take more than half the gold income, so gold still builds up', () => {
    const s = bigArmy();
    const p = s.players[1];
    p.auto.research = false;
    const start = p.gold;
    const armor0 = p.troops.armor;
    for (let k = 0; k < 100; k++) tick(s);
    expect(p.troops.armor).toBeGreaterThan(armor0); // conversion still runs
    expect(p.gold).toBeGreaterThan(start); // and gold is not drained
    // at least half of what was earned stayed in the stock
    expect(p.gold - start).toBeGreaterThanOrEqual(p.income.gold * 10 * 0.5 * 0.95);
  });
  it('stays deterministic', () => {
    const a = bigArmy();
    const b = bigArmy();
    for (let k = 0; k < 60; k++) {
      tick(a);
      tick(b);
    }
    expect(hashState(a)).toBe(hashState(b));
  });
});
