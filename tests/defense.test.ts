// Arsenal Defense row (src/sim/defense.ts): the row and its fork, prices, Flak Guns (wear, zone cap, abort, floor,
// what it ignores) and Tank Traps (trap tiles, slow-down, loss cap, Siege Tanks), hash and determinism.
import { describe, expect, it } from 'vitest';
import { applyAction } from '../src/sim/actions';
import { ARSENAL_ROWS, MASTERY_CAP, MASTERY_PILLARS, pathOf } from '../src/sim/arsenal';
import { markBuildingsChanged } from '../src/sim/buildings';
import { ARSENAL_PRICES, DEFENSE, TRENCH } from '../src/sim/config';
import { flakCut, flakFactor, flakPathWear, isTrapTile, trapFactor, trapSpeedMul, trapTileLoss } from '../src/sim/defense';
import { hashState } from '../src/sim/hash';
import { arsenalPrice, canProcure } from '../src/sim/procurement';
import { tick } from '../src/sim/sim';
import { newId } from '../src/sim/state';
import { spawnTankDivision, spearheadPreview } from '../src/sim/tanks';
import { techStatus, techStatusReason } from '../src/sim/techtree';
import { buildAircraft, launchBomber, updateUnits } from '../src/sim/units';
import type { Building, BuildingType, GameState, TechId, Unit } from '../src/sim/types';
import { claimRect, makeFlatGame } from './helpers';

const at = (s: GameState, x: number, y: number): number => y * s.map.width + x;
function give(s: GameState, pid: number, ...techs: TechId[]): void {
  for (const t of techs) if (!s.players[pid].techs.includes(t)) s.players[pid].techs.push(t);
}
function addBuilding(s: GameState, type: BuildingType, owner: number, tile: number, level = 1): Building {
  const id = newId(s);
  const b: Building = { id, type, owner, tile, level, buildLeft: 0, upgradeLeft: 0, fighters: 0, bombers: 0, cooldown: 0, dropCooldown: 0, disabledUntil: 0, hp: 1, queuedLevels: 0 };
  s.buildings.set(id, b);
  s.map.building[tile] = id + 1;
  markBuildingsChanged(s);
  return b;
}
/** 160x40: player 1 x 0..79, player 2 x 80..159; AIs frozen, rich. */
function game(seed = 7): GameState {
  const s = makeFlatGame(160, 40, 2, { human: true, seed });
  claimRect(s, 1, 0, 0, 79, 39);
  claimRect(s, 2, 80, 0, 159, 39);
  s.admin = { aiPassive: [], godMode: [], aiFrozen: true, revealIntel: [] };
  s.settings.victoryLandShare = 0.99;
  for (const p of s.players) {
    if (p.id === 0) continue;
    p.gold = 1e6;
    p.iron = 1e5;
    p.oil = 1e5;
  }
  give(s, 1, 'flight');
  return s;
}
/** Units only until pred() or max ticks. */
function fly(s: GameState, pred: () => boolean, max = 2000): void {
  for (let k = 0; k < max && !pred(); k++) {
    updateUnits(s);
    s.tick++;
  }
}
/** A bomber from (60, 20) to `aim`; returns it and its airfield. Watches its wear until it heads home. */
function sortie(s: GameState, aim: number): { u: Unit; af: Building; wearAtEnd: number; arrived: boolean } {
  const af = addBuilding(s, 'airfield', 1, at(s, 60, 20), 2);
  expect(buildAircraft(s, 1, af.tile, 'bomber').ok).toBe(true);
  expect(launchBomber(s, 1, af.tile, aim).ok).toBe(true);
  const u = s.units.find((q) => q.type === 'bomber')!;
  let arrived = false;
  fly(s, () => u.state !== 0, 600);
  const w = s.map.width;
  arrived = Math.abs(u.x - (aim % w)) < 1 && Math.abs(u.y - ((aim / w) | 0)) < 1;
  return { u, af, wearAtEnd: u.flakWear ?? 0, arrived };
}

describe('the Defense row', () => {
  it('is a fourth pillar with a fork of two roots; masteries stay 2, now of 4', () => {
    const row = ARSENAL_ROWS.find((r) => r.pillar === 'defense')!;
    expect(row.name).toBe('Defense');
    expect(row.items.map((i) => i.tech)).toEqual(['flakGuns', 'tankTraps', 'trackingRadar', 'coastalBatteries', 'defenseMastery']);
    expect(MASTERY_CAP).toBe(2);
    expect(MASTERY_PILLARS).toBe(4);
  });

  it('needs Fortification and a finished Fort; picking one root locks the other; roots cost iron only', () => {
    const s = game();
    expect(canProcure(s, 1, 'flakGuns').ok).toBe(false);
    give(s, 1, 'fortification');
    expect(canProcure(s, 1, 'flakGuns').reason).toBe('Needs a finished Fort');
    const fort = addBuilding(s, 'fort', 1, at(s, 40, 20));
    fort.buildLeft = 3;
    markBuildingsChanged(s);
    expect(canProcure(s, 1, 'flakGuns').reason).toBe('Needs a finished Fort');
    fort.buildLeft = 0;
    markBuildingsChanged(s);
    const price = arsenalPrice(s, 1, 'flakGuns');
    expect(price).toMatchObject({ gold: ARSENAL_PRICES.tiers[2].gold, iron: ARSENAL_PRICES.tiers[2].resource, oil: 0, needs: 'fort' });
    expect(applyAction(s, 1, { type: 'procure', tech: 'flakGuns' }).ok).toBe(true);
    expect(techStatus(s, 1, 'tankTraps')).toBe('locked-choice');
    expect(techStatusReason(s, 1, 'tankTraps')).toBe('You chose Flak Guns; Tank Traps is locked');
    expect(pathOf(s.players[1], 'defense')).toBe('flakGuns');
  });
});

describe('Flak Guns', () => {
  it('a bomber flying to the centre of a level-1 fort zone wears about radius x rate, and bombs less', () => {
    const s = game();
    give(s, 2, 'flakGuns');
    addBuilding(s, 'fort', 2, at(s, 110, 20));
    // the strike preview's estimate (before the bombs fall on the fort)
    expect(flakPathWear(s, 1, at(s, 60, 20), at(s, 110, 20))).toBeCloseTo(DEFENSE.flakFortRadius * DEFENSE.flakWearPerTile, 1);
    const r = sortie(s, at(s, 110, 20));
    expect(r.arrived).toBe(true);
    expect(r.wearAtEnd).toBeGreaterThan(DEFENSE.flakFortRadius * DEFENSE.flakWearPerTile - 0.03);
    expect(r.wearAtEnd).toBeLessThan(DEFENSE.flakFortRadius * DEFENSE.flakWearPerTile + 0.03);
    // no flak without the tech
    const n = game();
    addBuilding(n, 'fort', 2, at(n, 110, 20));
    expect(sortie(n, at(n, 110, 20)).wearAtEnd).toBe(0);
  });

  it('counts at most two zones; enough wear turns the bomber home with its bombs', () => {
    const three = game();
    give(three, 2, 'flakGuns');
    for (const y of [19, 20, 21]) addBuilding(three, 'fort', 2, at(three, 110, y));
    const r = sortie(three, at(three, 110, 20));
    expect(r.arrived).toBe(true); // three zones would be ~1.05 (turned back); two are ~0.7
    expect(r.wearAtEnd).toBeLessThan(DEFENSE.flakAbortAt);
    expect(r.wearAtEnd).toBeGreaterThan(0.6);

    const s = game();
    give(s, 2, 'flakGuns');
    addBuilding(s, 'fort', 2, at(s, 110, 20), 5);
    addBuilding(s, 'city', 2, at(s, 110, 21), 6);
    const a = sortie(s, at(s, 110, 20));
    expect(a.arrived).toBe(false);
    expect(a.u.state).toBe(1);
    expect(a.u.target).toBe(a.af.tile);
    expect(a.wearAtEnd).toBeGreaterThanOrEqual(DEFENSE.flakAbortAt);
    expect(s.events.some((e) => /flak turned back a bomber/.test(e.message))).toBe(true);
    fly(s, () => a.u.hp <= 0, 600);
    expect(a.af.bombers).toBe(1); // home with its bombs
  });

  it('cuts x (1 - wear), then x superiority, never below the floor; ignores missiles and recon', () => {
    const u = { flakWear: 0.3 } as Unit;
    expect(flakCut(u, 1)).toBeCloseTo(0.7, 9);
    expect(flakCut(u, 0.6)).toBeCloseTo(0.42, 9);
    expect(flakCut({ flakWear: 0.75 } as Unit, 0.6)).toBe(DEFENSE.flakEffectFloor);
    expect(flakCut({} as Unit, 0.6)).toBe(0.6);
    expect(flakFactor({ type: 'bomber', variant: 'groundAttack' } as Unit)).toBe(DEFENSE.flakVsGroundAttack);
    expect(flakFactor({ type: 'bomber', variant: 'heavyBomber' } as Unit)).toBe(DEFENSE.flakVsHeavy);
    expect(flakFactor({ type: 'stealthBomber' } as Unit)).toBe(DEFENSE.flakVsStealth);
    for (const t of ['rocket', 'cruiseMissile', 'atomBomb', 'reconPlane'] as const) expect(flakFactor({ type: t } as Unit)).toBe(0);
  });

  it('a knocked-out fort fires no flak; allies are safe', () => {
    const s = game();
    give(s, 2, 'flakGuns');
    const f = addBuilding(s, 'fort', 2, at(s, 110, 20));
    f.disabledUntil = 1e9;
    expect(sortie(s, at(s, 110, 20)).wearAtEnd).toBe(0);
  });
});

describe('Tank Traps', () => {
  /** 60x30 plains: player 1 x 0..29, player 2 x 30..59 with a fort at (42, 15) and dug land x 30..37. */
  function trapGame(traps: boolean, variant?: 'heavyTanks' | 'siegeTanks'): { s: GameState; d: Unit } {
    const s = makeFlatGame(60, 30, 2, { human: true, seed: 3 });
    claimRect(s, 1, 0, 0, 29, 29);
    claimRect(s, 2, 30, 0, 59, 29);
    s.admin = { aiPassive: [], godMode: [], aiFrozen: true, revealIntel: [] };
    s.settings.victoryLandShare = 0.99;
    give(s, 1, 'mechanization');
    if (variant) give(s, 1, 'heavyTanks');
    if (variant === 'siegeTanks') give(s, 1, 'siegeTanks');
    give(s, 2, 'fortification');
    if (traps) give(s, 2, 'tankTraps');
    s.players[1].troops = { infantry: 50000, armor: 20000, artillery: 5000 };
    s.players[2].troops = { infantry: 20000, armor: 0, artillery: 0 };
    addBuilding(s, 'fort', 2, at(s, 42, 15));
    for (let y = 5; y < 26; y++) for (let x = 30; x < 38; x++) s.trench!.dig[at(s, x, y)] = TRENCH.pointsPerLevel;
    const d = spawnTankDivision(s, 1, at(s, 25, 15));
    d.troops.artillery = 2000; // artillery support: forts don't stop it
    return { s, d };
  }

  it('a trap tile is own dug land inside a working own fort', () => {
    const { s } = trapGame(true);
    expect(isTrapTile(s, at(s, 32, 15), 2)).toBe(true);
    expect(isTrapTile(s, at(s, 40, 15), 2)).toBe(false); // not dug
    expect(isTrapTile(trapGame(false).s, at(s, 32, 15), 2)).toBe(false); // no tech
  });

  it('slows the head, costs troops (capped per spearhead), warns in the preview', () => {
    const run = (traps: boolean): { depth: number; loss: number; hits: number; s: GameState; d: Unit } => {
      const { s, d } = trapGame(traps);
      expect(applyAction(s, 1, { type: 'moveTankDivision', unitIds: [d.id], tile: at(s, 31, 15) }).ok).toBe(true);
      let started = -1;
      let loss = 0;
      let hits = 0;
      let depth = 0;
      for (let k = 0; k < 3000; k++) {
        tick(s);
        hits += s.effects.filter((e) => e.kind === 'trapHit' && e.tick === s.tick - 1).length;
        if (d.state === 3 && started < 0) started = s.tick;
        if (d.state === 3) loss = Math.max(loss, d.trapLoss ?? 0);
        if (started >= 0 && s.tick - started === 12) depth = d.x - 29;
        if (started >= 0 && d.state !== 3) break;
      }
      return { depth, loss, hits, s, d };
    };
    const off = run(false);
    const on = run(true);
    expect(on.depth).toBeLessThan(off.depth);
    expect(on.loss).toBeGreaterThan(0);
    expect(off.loss).toBe(0);
    expect(on.loss).toBeLessThanOrEqual(DEFENSE.trapMaxLoss * (on.d.strength0 ?? 1e9) + 1e-6);
    expect(on.hits).toBeGreaterThan(0);
    const { s, d } = trapGame(true);
    expect(spearheadPreview(s, 1, d.id, at(s, 31, 15)).warnings.join(' ')).toMatch(/Tank traps ahead: tanks slow to 70% here/); // artillery support halves the slow-down
  });

  it('light x1.3, heavy x0.7, Siege Tanks x0, artillery halves it; the loss budget caps', () => {
    const { s, d } = trapGame(true);
    expect(trapFactor(s, { ...d, variant: 'lightTank' }, false)).toBe(DEFENSE.trapLight);
    expect(trapFactor(s, { ...d, variant: 'heavyTank' }, true)).toBeCloseTo(DEFENSE.trapHeavy * DEFENSE.trapArtillery, 9);
    const siege = trapGame(true, 'siegeTanks');
    expect(trapFactor(siege.s, { ...siege.d, variant: 'heavyTank' }, false)).toBe(0);
    expect(trapSpeedMul(1)).toBeCloseTo(DEFENSE.trapHeadSpeed, 9);
    expect(trapSpeedMul(0)).toBe(1);
    const u = { trapLoss: 0.24 * 1000 } as Unit;
    expect(trapTileLoss(u, 1, 1000)).toBeCloseTo(10, 9); // 25% budget: 250 - 240 left
    expect(trapTileLoss(u, 0, 1000)).toBe(0);
  });

  it('Siege Tanks knock out the forts they pass (switching off its Defense effects); heavy tanks do not', () => {
    const run = (variant: 'heavyTanks' | 'siegeTanks'): Building => {
      const { s, d } = trapGame(false, variant);
      const fort = [...s.buildings.values()].find((b) => b.type === 'fort')!;
      expect(applyAction(s, 1, { type: 'moveTankDivision', unitIds: [d.id], tile: at(s, 31, 15) }).ok).toBe(true);
      let started = false;
      for (let k = 0; k < 3000; k++) {
        tick(s);
        if (d.state === 3) started = true;
        if (started && d.state !== 3) break;
      }
      expect(started).toBe(true);
      return fort;
    };
    const siege = run('siegeTanks');
    expect(siege.disabledUntil).toBeGreaterThan(0);
    expect(run('heavyTanks').disabledUntil).toBe(0);
  });
});

describe('Defense state', () => {
  it('flakWear and trapLoss are hashed; a game with flak runs the same twice', () => {
    const s = game();
    const u = { id: 1, type: 'bomber', owner: 1, x: 1, y: 1, target: 0, home: 0, path: [], pathPos: 0, troops: { infantry: 0, armor: 0, artillery: 0 }, hp: 1, cargo: 0, state: 0, targetOwner: 2 } as Unit;
    s.units.push(u);
    const h0 = hashState(s);
    u.flakWear = 0.2;
    const h1 = hashState(s);
    expect(h1).not.toBe(h0);
    u.trapLoss = 5;
    expect(hashState(s)).not.toBe(h1);

    const play = (): number => {
      const g = game(11);
      give(g, 2, 'flakGuns');
      addBuilding(g, 'fort', 2, at(g, 110, 20), 2);
      addBuilding(g, 'city', 2, at(g, 112, 22), 2);
      const af = addBuilding(g, 'airfield', 1, at(g, 60, 20), 2);
      for (let k = 0; k < 3; k++) buildAircraft(g, 1, af.tile, 'bomber');
      for (let k = 0; k < 3; k++) launchBomber(g, 1, af.tile, at(g, 108 + k * 2, 20));
      for (let k = 0; k < 300; k++) tick(g);
      return hashState(g);
    };
    expect(play()).toBe(play());
  });
});
