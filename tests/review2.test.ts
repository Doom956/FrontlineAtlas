// Regression tests from the round-2 review: client reads between ticks must not change the sim (lockstep), and
// carriers let air-wing missions reach targets beyond every airfield.
import { describe, expect, it } from 'vitest';
import { applyAction } from '../src/sim/actions';
import { setAirMission, airWingRange } from '../src/sim/airwings';
import { markBuildingsChanged } from '../src/sim/buildings';
import { estimateAttack, lastStandFactor, wholeArmy } from '../src/sim/combat';
import { hashState } from '../src/sim/hash';
import { computeCoastAndLand } from '../src/sim/mapgen';
import { tick } from '../src/sim/sim';
import { newId } from '../src/sim/state';
import { spawnWarshipAt } from '../src/sim/units';
import { applyWarshipVariant } from '../src/sim/variants';
import { Terrain } from '../src/sim/types';
import type { Building, GameState } from '../src/sim/types';
import { claimRect, makeFlatGame, makeTestGame } from './helpers';

function rich(s: GameState): void {
  for (const p of s.players) {
    if (p.id === 0) continue;
    p.gold = 1e6;
    p.iron = 1e5;
    p.oil = 1e5;
  }
}

/** What the HUD reads between ticks (attack tooltip, ally panel's last-stand line). */
function clientReads(s: GameState): void {
  const n = s.players.length;
  for (let a = 1; a < n; a++) {
    for (let b = 1; b < n; b++) lastStandFactor(s, a, b);
    const foe = s.players[(a % (n - 1)) + 1];
    if (foe.capital >= 0) estimateAttack(s, a, foe.capital, { infantry: 1000, armor: 100, artillery: 100 });
  }
}

describe('lockstep: client reads between ticks', () => {
  it('a client that renders (reads combat numbers between ticks) stays in sync with one that does not', () => {
    const make = (): GameState => {
      const s = makeTestGame({ seed: 31, aiCount: 5, mapType: 'continents', mapSize: 'small' });
      rich(s);
      return s;
    };
    const quiet = make();
    const rendering = make();
    let diverged = -1;
    for (let k = 0; k < 1600 && diverged < 0; k++) {
      clientReads(rendering);
      tick(quiet);
      tick(rendering);
      if (hashState(quiet) !== hashState(rendering)) diverged = quiet.tick;
    }
    expect(diverged).toBe(-1);
  }, 120_000);

  it('the army cache a client read filled is dropped when an action is applied', () => {
    const s = makeTestGame({ seed: 5, aiCount: 2 });
    tick(s);
    const before = wholeArmy(s, 1); // a HUD read fills the per-tick cache
    s.players[1].troops.infantry += 5000; // troops change before the sim asks again (same tick number)
    applyAction(s, 1, { type: 'setArmyMix', armor: 0, artillery: 0 });
    expect(wholeArmy(s, 1)).toBeCloseTo(before + 5000);
  });
});

describe('carriers: moving airfields', () => {
  /** 260x60: player 1 west (x 0..19, plus a land strip along y 0 to x 199), player 2 east (x 200..259), sea between. */
  function overseas(): { s: GameState; at: (x: number, y: number) => number; af: Building } {
    const s = makeFlatGame(260, 60, 2, { human: true, seed: 5 });
    const at = (x: number, y: number): number => y * 260 + x;
    for (let y = 1; y < 60; y++) for (let x = 20; x < 200; x++) s.map.terrain[at(x, y)] = Terrain.DeepWater;
    computeCoastAndLand(s.map);
    claimRect(s, 1, 0, 0, 19, 59);
    claimRect(s, 1, 20, 0, 199, 0);
    claimRect(s, 2, 200, 0, 259, 59);
    s.admin = { aiPassive: [], godMode: [], aiFrozen: true, revealIntel: [] };
    s.settings.victoryLandShare = 0.99;
    rich(s);
    s.players[1].techs.push('flight', 'navigation', 'submarines', 'carriers');
    s.players[1].troops = { infantry: 1e6, armor: 0, artillery: 0 };
    s.players[2].troops = { infantry: 1e7, armor: 0, artillery: 0 };
    const add = (type: Building['type'], owner: number, tile: number, bombers: number): Building => {
      const id = newId(s);
      const b: Building = { id, type, owner, tile, level: 1, buildLeft: 0, upgradeLeft: 0, fighters: 0, bombers, cooldown: 0, dropCooldown: 0, disabledUntil: 0, hp: 1, queuedLevels: 0 };
      s.buildings.set(id, b);
      s.map.building[tile] = id + 1;
      markBuildingsChanged(s);
      return b;
    };
    const af = add('airfield', 1, at(5, 30), 6);
    add('factory', 2, at(230, 30), 0);
    return { s, at, af };
  }

  it('a strategic mission beyond every airfield is accepted with an own carrier in reach, and the bombers take off from it', () => {
    const { s, at, af } = overseas();
    const aim = at(230, 30);
    expect(Math.hypot(225, 0)).toBeGreaterThan(airWingRange(af, s));
    expect(setAirMission(s, 1, -1, 'strategic', aim).ok).toBe(false); // no carrier: out of reach
    const c = spawnWarshipAt(s, 1, at(19, 30), at(190, 30));
    applyWarshipVariant(c, 'carrier');
    expect(setAirMission(s, 1, -1, 'strategic', aim)).toEqual({ ok: true });
    expect(setAirMission(s, 1, -1, 'superiority', aim).ok).toBe(false); // patrols still need an airfield in reach
    expect(setAirMission(s, 1, -1, 'strategic', aim).ok).toBe(true);
    let fromCarrier = 0;
    for (let k = 0; k < 200; k++) {
      if (!s.attacks.length) applyAction(s, 1, { type: 'attack', tile: at(200, 0), troops: { infantry: 1000, armor: 0, artillery: 0 } }); // at war
      tick(s);
      for (const u of s.units) if (u.type === 'bomber' && u.owner === 1 && Math.abs(u.x - c.x) < 40) fromCarrier++;
    }
    expect(fromCarrier).toBeGreaterThan(0);
  });
});
