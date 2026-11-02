// Arsenal (src/sim/arsenal.ts, variants.ts, variantsAI.ts): forks, mastery cap, variants, recon, AI, determinism.
import { describe, expect, it } from 'vitest';
import { applyAction } from '../src/sim/actions';
import { aiBranchPick } from '../src/sim/aispending';
import { airWingRange, airWingSize } from '../src/sim/airwings';
import { ARSENAL_ROWS, MASTERY_CAP, isArsenalTech, masteryLocked, masteryPillars, pathOf } from '../src/sim/arsenal';
import { hasIntel, markBuildingsChanged } from '../src/sim/buildings';
import { ARSENAL, NAVY_SUPPORT_RANGE, TECHS, UNITS } from '../src/sim/config';
import { hashState } from '../src/sim/hash';
import { computeCoastAndLand } from '../src/sim/mapgen';
import { supportingShips } from '../src/sim/naval2';
import { tick } from '../src/sim/sim';
import { newId } from '../src/sim/state';
import { spawnTankDivision, tankDivisionCost } from '../src/sim/tanks';
import { canProcure } from '../src/sim/procurement';
import { techStatus, techStatusReason, unitVisibleTo } from '../src/sim/techtree';
import { spawnWarshipAt } from '../src/sim/units';
import { applyWarshipVariant, carrierFor, holdDefenseAt, navalCanTarget, navalDamageMul } from '../src/sim/variants';
import { aiForkPick, aiWarshipVariant } from '../src/sim/variantsAI';
import { Terrain } from '../src/sim/types';
import type { Building, BuildingType, GameState, TechId, Unit } from '../src/sim/types';
import { validateAction } from '../server/validate';
import { claimRect, makeFlatGame, makeTestGame } from './helpers';

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
function run(s: GameState, n: number): void {
  for (let k = 0; k < n; k++) tick(s);
}
function runUntil(s: GameState, pred: () => boolean, max = 3000): void {
  for (let k = 0; k < max && !pred(); k++) tick(s);
}
function rich(s: GameState): void {
  for (const p of s.players) {
    if (p.id === 0) continue;
    p.gold = 1e6;
    p.iron = 1e5;
    p.oil = 1e5;
    p.science = 0;
  }
}
/** 80x40: land y 0..19 (player 1 x 0..39, player 2 x 40..79), sea y 20..39; AIs frozen. */
function coastGame(seed = 4): GameState {
  const s = makeFlatGame(80, 40, 3, { human: true, seed });
  for (let y = 20; y < 40; y++) for (let x = 0; x < 80; x++) s.map.terrain[at(s, x, y)] = Terrain.DeepWater;
  computeCoastAndLand(s.map);
  claimRect(s, 1, 0, 0, 39, 19);
  claimRect(s, 2, 40, 0, 79, 19);
  s.admin = { aiPassive: [], godMode: [], aiFrozen: true, revealIntel: [] };
  s.settings.victoryLandShare = 0.99;
  rich(s);
  for (const p of s.players.slice(1)) p.techs.push('navigation');
  return s;
}
/** 60x30 plains: player 1 x 0..29, player 2 x 30..59; AIs frozen. */
function landGame(seed = 3): GameState {
  const s = makeFlatGame(60, 30, 2, { human: true, seed });
  claimRect(s, 1, 0, 0, 29, 29);
  claimRect(s, 2, 30, 0, 59, 29);
  s.admin = { aiPassive: [], godMode: [], aiFrozen: true, revealIntel: [] };
  s.settings.victoryLandShare = 0.99;
  rich(s);
  s.players[1].techs.push('mechanization');
  s.players[1].troops = { infantry: 50000, armor: 20000, artillery: 0 };
  s.players[2].troops = { infantry: 20000, armor: 0, artillery: 0 };
  return s;
}
function ship(s: GameState, owner: number, x: number, y: number, v?: 'destroyer' | 'battleship' | 'submarine' | 'carrier'): Unit {
  const u = spawnWarshipAt(s, owner, at(s, owner === 1 ? 20 : 60, 19), at(s, x, y));
  applyWarshipVariant(u, v);
  return u;
}

describe('arsenal data', () => {
  it('rows hold real techs; each pillar fork has two roots in one exclusive group; Research-tab techs stay out', () => {
    expect(ARSENAL_ROWS.map((r) => r.pillar)).toEqual(['navy', 'armor', 'air', 'shared']);
    for (const row of ARSENAL_ROWS) {
      for (const it of row.items) {
        expect(TECHS[it.tech], it.tech).toBeDefined();
        expect(isArsenalTech(it.tech)).toBe(true);
      }
      const roots = row.items.filter((it) => it.branch === it.tech);
      if (row.pillar !== 'shared') {
        expect(roots.length).toBe(2);
        expect(TECHS[roots[0].tech].exclusiveGroup).toBe(TECHS[roots[1].tech].exclusiveGroup);
        expect(row.items.filter((it) => it.kind === 'mastery').length).toBe(1);
      }
    }
    for (const t of ['banking', 'radar', 'blitzTactics', 'stockExchange'] as TechId[]) expect(isArsenalTech(t)).toBe(false);
    for (const t of ['carriers', 'submarines', 'jetEngines', 'strategicBombing'] as TechId[]) expect(isArsenalTech(t)).toBe(true);
  });
});

describe('fork locks', () => {
  it('choosing Destroyers locks Submarines and everything after it; Battleships opens after Destroyers', () => {
    const s = coastGame();
    const p = s.players[1];
    expect(techStatus(s, 1, 'destroyers')).toBe('available');
    expect(techStatus(s, 1, 'battleships')).toBe('locked-prereq');
    addBuilding(s, 'port', 1, at(s, 20, 19));
    expect(applyAction(s, 1, { type: 'procure', tech: 'destroyers' }).ok).toBe(true); // on order (procurement.ts)
    expect(techStatus(s, 1, 'submarines')).toBe('locked-choice');
    expect(techStatus(s, 1, 'carriers')).toBe('locked-choice');
    expect(techStatusReason(s, 1, 'carriers')).toBe('You chose Destroyers; Carriers is locked');
    expect(canProcure(s, 1, 'submarines').ok).toBe(false);
    expect(pathOf(p, 'navy')).toBe('destroyers');
    give(s, 1, 'destroyers');
    p.procuring = [];
    expect(techStatus(s, 1, 'battleships')).toBe('available');
    // Armor and air forks work the same way.
    give(s, 1, 'mechanization', 'flight', 'heavyTanks', 'groundAttack');
    expect(techStatus(s, 1, 'lightTanks')).toBe('locked-choice');
    expect(techStatus(s, 1, 'deepRaids')).toBe('locked-choice');
    expect(techStatus(s, 1, 'siegeTanks')).toBe('available');
    expect(techStatus(s, 1, 'strategicBombing')).toBe('locked-choice');
    expect(techStatus(s, 1, 'jetEngines')).toBe('available');
  });
});

describe('mastery cap', () => {
  it(`masteries in at most ${MASTERY_CAP} pillars; a running one counts; techStatus shows the reason`, () => {
    const s = coastGame();
    const p = s.players[1];
    give(s, 1, 'mechanization', 'flight', 'destroyers', 'battleships', 'lightTanks', 'deepRaids', 'groundAttack', 'jetEngines');
    expect(techStatus(s, 1, 'navalMastery')).toBe('available');
    give(s, 1, 'navalMastery');
    addBuilding(s, 'factory', 1, at(s, 5, 5));
    expect(applyAction(s, 1, { type: 'procure', tech: 'armorMastery' }).ok).toBe(true);
    expect(masteryPillars(p)).toEqual(['navy', 'armor']);
    expect(techStatus(s, 1, 'airMastery')).toBe('locked-choice');
    expect(masteryLocked(p, 'airMastery')).toMatch(/^Mastery 2 of 2 used \(Navy, Armor\)/);
    expect(techStatusReason(s, 1, 'airMastery')).toMatch(/Mastery 2 of 2/);
    expect(canProcure(s, 1, 'airMastery').reason).toMatch(/Mastery 2 of 2/);
    // The ordered one is not locked by itself; without the order the slot is free.
    expect(masteryLocked(p, 'armorMastery')).toBeNull();
    p.procuring = [];
    expect(techStatus(s, 1, 'airMastery')).toBe('available');
  });
});

describe('warship variants', () => {
  it('orders need the variant tech, cost its price, and appear with its hit points; the default is the path ship', () => {
    const s = coastGame();
    s.settings.modifiers = { ...s.settings.modifiers };
    const port = addBuilding(s, 'port', 1, at(s, 20, 19));
    const order = (variant?: 'battleship' | 'submarine') =>
      applyAction(s, 1, variant ? { type: 'buildWarship', port: port.tile, variant } : { type: 'buildWarship', port: port.tile });
    expect(order('battleship').reason).toMatch(/Battleships/);
    give(s, 1, 'destroyers', 'battleships');
    const g0 = s.players[1].gold;
    expect(order('battleship').ok).toBe(true);
    expect(g0 - s.players[1].gold).toBe(Math.round(UNITS.warship.gold * ARSENAL.naval.battleship.cost));
    expect(order().ok).toBe(true); // default: destroyer
    expect(order('submarine').ok).toBe(false);
    runUntil(s, () => s.units.filter((u) => u.type === 'warship' && u.owner === 1).length === 2, 600);
    const mine = s.units.filter((u) => u.type === 'warship' && u.owner === 1);
    const bs = mine.find((u) => u.variant === 'battleship')!;
    expect(bs.hp).toBe(UNITS.warship.hp + ARSENAL.naval.battleship.hp);
    expect(mine.some((u) => u.variant === 'destroyer')).toBe(true);
  });

  it('submarines hide: only destroyers, recon or close ships see and target them; they hit trade hard', () => {
    const s = coastGame();
    const sub = ship(s, 2, 50, 35, 'submarine');
    const std = ship(s, 1, 50, 20 + 1); // 14 tiles away: in gun range, beyond subTargetRange
    expect(unitVisibleTo(s, 1, sub)).toBe(false);
    expect(navalCanTarget(s, std, sub)).toBe(false);
    expect(navalCanTarget(s, sub, std)).toBe(true);
    const close = ship(s, 1, 50, 30);
    expect(navalCanTarget(s, close, sub)).toBe(true);
    close.hp = 0;
    s.units = s.units.filter((u) => u.hp > 0);
    const dd = ship(s, 1, 40, 25, 'destroyer');
    expect(navalCanTarget(s, dd, sub)).toBe(true);
    expect(unitVisibleTo(s, 1, sub)).toBe(true); // sonar
    expect(navalCanTarget(s, std, sub)).toBe(true); // the destroyer spots it for the fleet
    expect(navalDamageMul(dd, sub)).toBe(ARSENAL.naval.destroyer.vsSub);
    expect(navalDamageMul(std, sub)).toBeCloseTo(ARSENAL.subHitByOthers);
    const trade = { ...std, id: 9999, type: 'tradeShip' } as Unit;
    expect(navalDamageMul(sub, trade)).toBe(ARSENAL.naval.submarine.vsTrade);
  });

  it('carriers are moving airfields: wings strike targets within their reach; plain warships are not', () => {
    const s = coastGame();
    const aim = at(s, 70, 10);
    expect(carrierFor(s, 1, aim)).toBeNull();
    ship(s, 1, 70, 25);
    expect(carrierFor(s, 1, aim)).toBeNull();
    const c = ship(s, 1, 60, 30, 'carrier');
    expect(carrierFor(s, 1, aim)).toBe(c);
    expect(carrierFor(s, 2, aim)).toBeNull();
    expect(c.hp).toBe(UNITS.warship.hp + ARSENAL.naval.carrier.hp);
  });

  it('battleships give naval support from further out; submarines give none', () => {
    const s = coastGame();
    const coast = at(s, 50, 19);
    const far = ship(s, 1, 50, 19 + NAVY_SUPPORT_RANGE + 2); // just beyond a standard ship's support range
    s.tick++;
    expect(supportingShips(s, 1, coast)).toBe(0);
    far.variant = 'battleship';
    s.tick++;
    expect(supportingShips(s, 1, coast)).toBe(1);
    far.variant = 'submarine';
    far.y = 21;
    s.tick++;
    expect(supportingShips(s, 1, coast)).toBe(0);
  });
});

describe('tank variants', () => {
  function mountainWall(s: GameState): void {
    for (let y = 0; y < 30; y++) for (const x of [33, 34]) s.map.terrain[at(s, x, y)] = Terrain.Mountains;
  }
  it('heavy tanks break through mountains that stop a standard division; light tanks are cheaper', () => {
    const base = landGame();
    mountainWall(base);
    const d0 = spawnTankDivision(base, 1, at(base, 26, 15));
    expect(applyAction(base, 1, { type: 'moveTankDivision', unitIds: [d0.id], tile: at(base, 31, 15) }).ok).toBe(true);
    run(base, 400);
    expect(base.map.owner[at(base, 36, 15)]).toBe(2);

    const s = landGame();
    mountainWall(s);
    give(s, 1, 'heavyTanks');
    const d = spawnTankDivision(s, 1, at(s, 26, 15));
    expect(applyAction(s, 1, { type: 'moveTankDivision', unitIds: [d.id], tile: at(s, 31, 15) }).ok).toBe(true);
    run(s, 400);
    expect(s.map.owner[at(s, 36, 15)]).toBe(1);
    expect(d.variant).toBe('heavyTank');

    const l = landGame();
    const g = tankDivisionCost(l, 1).gold;
    give(l, 1, 'lightTanks');
    expect(tankDivisionCost(l, 1).gold).toBe(Math.round(g * ARSENAL.light.cost));
  });

  it('light tank spearheads reveal the enemy ahead; Mechanized infantry leaves a hold zone', () => {
    const s = landGame();
    give(s, 1, 'lightTanks', 'mechInfantry');
    expect(hasIntel(s, 1, 2)).toBe(false);
    const d = spawnTankDivision(s, 1, at(s, 26, 15));
    expect(applyAction(s, 1, { type: 'moveTankDivision', unitIds: [d.id], tile: at(s, 31, 15) }).ok).toBe(true);
    runUntil(s, () => (s.arsenal?.reveals.length ?? 0) > 0, 400);
    expect(s.arsenal!.reveals[0].kind).toBe(2);
    expect(hasIntel(s, 1, 2)).toBe(true);
    runUntil(s, () => d.hp <= 0 || d.state === 0, 1500);
    expect(s.arsenal!.holds.length).toBe(1);
    const z = s.arsenal!.holds[0];
    expect(holdDefenseAt(s, 1, z.tile)).toBe(ARSENAL.mechHoldDefense);
    expect(holdDefenseAt(s, 2, z.tile)).toBe(1);
  });
});

describe('air variants and mastery', () => {
  it('heavy bombers reach further and take an extra hit; Air Mastery flies bigger wings', () => {
    const s = landGame();
    give(s, 1, 'flight');
    const af = addBuilding(s, 'airfield', 1, at(s, 10, 10));
    af.bombers = 2;
    const r0 = airWingRange(af, s);
    const w0 = airWingSize(s, af);
    give(s, 1, 'heavyBombers');
    expect(airWingRange(af, s)).toBeCloseTo(r0 * ARSENAL.heavyBomber.range);
    expect(applyAction(s, 1, { type: 'bomb', airfield: af.tile, tile: at(s, 40, 10) }).ok).toBe(true);
    const b = s.units.find((u) => u.type === 'bomber')!;
    expect(b.variant).toBe('heavyBomber');
    expect(b.hp).toBe(UNITS.bomber.hp + ARSENAL.heavyBomber.hp);
    give(s, 1, 'strategicBombing', 'airMastery');
    expect(airWingSize(s, af)).toBe(Math.round(w0 * ARSENAL.airMasteryWing));
  });
});

describe('recon planes', () => {
  it('fly from an airfield, reveal the target for a while, wait out a cooldown and land again', () => {
    const s = landGame();
    give(s, 1, 'flight');
    const af = addBuilding(s, 'airfield', 1, at(s, 10, 10));
    const target = s.players[2].capital;
    expect(applyAction(s, 1, { type: 'reconFlight', airfield: -1, tile: target }).reason).toMatch(/Recon Planes/);
    give(s, 1, 'reconPlanes');
    const g0 = s.players[1].gold;
    expect(applyAction(s, 1, { type: 'reconFlight', airfield: af.tile, tile: target }).ok).toBe(true);
    expect(s.players[1].gold).toBe(g0 - UNITS.reconPlane.gold);
    expect(applyAction(s, 1, { type: 'reconFlight', airfield: -1, tile: target }).reason).toMatch(/ready in/);
    expect(hasIntel(s, 1, 2)).toBe(false);
    runUntil(s, () => (s.arsenal?.reveals.length ?? 0) > 0, 100);
    expect(hasIntel(s, 1, 2)).toBe(true);
    runUntil(s, () => !s.units.some((u) => u.type === 'reconPlane'), 200);
    expect(s.units.some((u) => u.type === 'reconPlane')).toBe(false);
    run(s, Math.round(ARSENAL.reconSeconds * 10) + 20);
    expect(hasIntel(s, 1, 2)).toBe(false);
    run(s, Math.round((ARSENAL.reconCooldown - ARSENAL.reconSeconds) * 10) + 10); // the cooldown runs out
    expect(applyAction(s, 1, { type: 'reconFlight', airfield: -1, tile: target }).ok).toBe(true);
  });
});

describe('validation', () => {
  it('the server accepts the new fields and the recon action, and refuses bad ones', () => {
    expect(validateAction({ type: 'reconFlight', airfield: -1, tile: 5 })).toEqual({ ok: true, value: { type: 'reconFlight', airfield: -1, tile: 5 } });
    expect(validateAction({ type: 'reconFlight', airfield: -1 }).ok).toBe(false);
    expect(validateAction({ type: 'reconFlight', airfield: 'x', tile: 3 }).ok).toBe(false);
    expect(validateAction({ type: 'buildWarship', port: 12, variant: 'battleship' }).ok).toBe(true);
    expect(validateAction({ type: 'buildWarship', port: 12, variant: 'yacht' }).ok).toBe(false);
    expect(validateAction({ type: 'buildWarship', port: 12 }).ok).toBe(true);
    expect(validateAction({ type: 'procure', tech: 'navalMastery' }).ok).toBe(true);
    // The sim refuses an unknown variant too.
    const s = coastGame();
    const port = addBuilding(s, 'port', 1, at(s, 20, 19));
    expect(applyAction(s, 1, { type: 'buildWarship', port: port.tile, variant: 'yacht' } as never).ok).toBe(false);
  });
});

describe('AI', () => {
  it('picks both sides of every arsenal fork across nations and seeds, sticks to a researched one, mixes ships', () => {
    const seen = new Map<string, Set<TechId>>();
    for (let seed = 1; seed <= 10; seed++) {
      const s = makeTestGame({ seed });
      for (const p of s.players) {
        if (p.id === 0 || p.isHuman || p.personality === 'tribe') continue;
        for (const g of ['navalDoctrine', 'armorPath', 'airDoctrine']) {
          const pick = aiForkPick(s, p.id, g)!;
          expect(aiBranchPick(s, p.id, p.personality, g)).toBe(pick);
          if (!seen.has(g)) seen.set(g, new Set());
          seen.get(g)!.add(pick);
        }
      }
    }
    for (const [g, picks] of seen) expect(picks.size, g).toBe(2);
    const s = coastGame();
    const ai = s.players[2];
    ai.techs.push('submarines');
    expect(aiBranchPick(s, 2, ai.personality, 'navalDoctrine')).toBe('submarines');
    expect(aiWarshipVariant(s, 2)).toBe('submarine');
    ai.techs.push('carriers');
    for (let k = 0; k < 3; k++) ship(s, 2, 60 + 2 * k, 30, 'submarine');
    expect(aiWarshipVariant(s, 2)).toBe('submarine'); // no airfield: nothing would fly from a carrier
    addBuilding(s, 'airfield', 2, ai.capital >= 0 ? ai.capital : s.map.owner.indexOf(2));
    expect(aiWarshipVariant(s, 2)).toBe('carrier');
  }, 60000);
});

describe('determinism', () => {
  it('same seed and orders give the same hash; variants and reveals are hashed', () => {
    const play = (): number => {
      const s = coastGame(9);
      give(s, 1, 'destroyers', 'flight', 'reconPlanes', 'mechanization', 'lightTanks');
      give(s, 2, 'submarines');
      addBuilding(s, 'port', 1, at(s, 20, 19));
      addBuilding(s, 'port', 2, at(s, 60, 19));
      addBuilding(s, 'airfield', 1, at(s, 10, 5));
      applyAction(s, 1, { type: 'buildWarship', port: at(s, 20, 19) });
      applyAction(s, 2, { type: 'buildWarship', port: at(s, 60, 19) });
      applyAction(s, 1, { type: 'reconFlight', airfield: -1, tile: s.players[2].capital });
      const d = spawnTankDivision(s, 1, at(s, 36, 10));
      s.players[1].troops = { infantry: 50000, armor: 20000, artillery: 0 };
      applyAction(s, 1, { type: 'moveTankDivision', unitIds: [d.id], tile: at(s, 41, 10) });
      run(s, 300);
      return hashState(s);
    };
    expect(play()).toBe(play());
    const s = coastGame(9);
    const u = ship(s, 1, 30, 30);
    const h0 = hashState(s);
    u.variant = 'destroyer';
    expect(hashState(s)).not.toBe(h0);
    const h1 = hashState(s);
    s.arsenal = { reveals: [{ owner: 1, tile: 5, radius: 10, untilTick: 99, kind: 1 }], holds: [], reconReady: [] };
    expect(hashState(s)).not.toBe(h1);
  }, 60000);
});
