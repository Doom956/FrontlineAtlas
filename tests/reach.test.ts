// Fleet reach and tank mobility: warships placed anywhere in a port's sea, longer ranges, roaming 'auto' / 'hunt'
// ships that mend at a Port, rail moves for divisions, faster / deeper spearheads with a longer launch reach, support
// divisions that jump to the main front, and the AI's use of them.
import { describe, expect, it } from 'vitest';
import { applyAction } from '../src/sim/actions';
import { aiDivisionModes } from '../src/sim/armor2';
import { markBuildingsChanged } from '../src/sim/buildings';
import { frontTiles } from '../src/sim/combat';
import {
  NAVY_HUNT_DETECT,
  NAVY_REACH,
  NAVY_SUPPORT_RANGE,
  TANK_LAUNCH_REACH,
  TANK_MOBILITY,
  TANK_SPEARHEAD_MAX_DEPTH,
  TANK_SPEARHEAD_SPEED,
  TICKS_PER_SECOND,
  UNITS,
  WARSHIP_DETECT_RANGE,
  WARSHIP_RANGE,
} from '../src/sim/config';
import { hashState } from '../src/sim/hash';
import { computeCoastAndLand } from '../src/sim/mapgen';
import { navalSupportAt, supportingShips, warshipMaxHp } from '../src/sim/naval2';
import { tick } from '../src/sim/sim';
import { newId } from '../src/sim/state';
import { divisionDriveSpeed, divisionMoveTime, spawnTankDivision, tankDivisionCost } from '../src/sim/tanks';
import { spawnWarshipAt } from '../src/sim/units';
import { navalShellRangeMul } from '../src/sim/variants';
import { Terrain } from '../src/sim/types';
import type { Building, BuildingType, GameState, Unit } from '../src/sim/types';
import { validateAction } from '../server/validate';
import { claimRect, makeFlatGame } from './helpers';

const at = (s: GameState, x: number, y: number): number => y * s.map.width + x;

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
function runUntil(s: GameState, pred: () => boolean, max: number, each?: () => void): boolean {
  for (let k = 0; k < max; k++) {
    if (pred()) return true;
    each?.();
    tick(s);
  }
  return pred();
}
function rich(s: GameState): void {
  for (const p of s.players) {
    if (p.id === 0) continue;
    p.gold = 1e6;
    p.iron = 1e5;
    p.oil = 1e5;
  }
}
const frozen = (s: GameState): void => {
  s.admin = { aiPassive: [], godMode: [], aiFrozen: true, revealIntel: [] };
  s.settings.victoryLandShare = 0.99;
};

/**
 * 260 x 40: land y 0..19 (the human 1 x 0..129, AI 2 x 130..259), one sea y 20..39 and a lake at 5..7 x 5..7 in
 * player 1's land. Player 1 has a Port at (10, 19). AIs frozen: only our orders act.
 */
function longCoast(seed = 4): { s: GameState; port: Building } {
  const s = makeFlatGame(260, 40, 2, { human: true, seed });
  for (let y = 20; y < 40; y++) for (let x = 0; x < 260; x++) s.map.terrain[at(s, x, y)] = Terrain.DeepWater;
  for (let y = 5; y <= 7; y++) for (let x = 5; x <= 7; x++) s.map.terrain[at(s, x, y)] = Terrain.ShallowWater;
  computeCoastAndLand(s.map);
  claimRect(s, 1, 0, 0, 129, 19);
  claimRect(s, 2, 130, 0, 259, 19);
  frozen(s);
  rich(s);
  for (const p of s.players) if (p.id > 0) p.techs.push('navigation');
  s.players[1].troops = { infantry: 400000, armor: 0, artillery: 0 };
  s.players[2].troops = { infantry: 400000, armor: 0, artillery: 0 };
  const port = addBuilding(s, 'port', 1, at(s, 10, 19), 1);
  return { s, port };
}
/** Keeps player 1's attack on player 2 running (a war), re-sending it when it ends. */
function keepWar(s: GameState): void {
  if (s.attacks.some((a) => a.attacker === 1 && a.target === 2)) return;
  const border = frontTiles(s, 1, 2);
  applyAction(s, 1, { type: 'attack', tile: border[Math.floor(border.length / 2)], troops: { infantry: 20000, armor: 0, artillery: 0 } });
}
const d2t = (s: GameState, a: number, b: number): number => {
  const w = s.map.width;
  return Math.hypot((a % w) - (b % w), ((a / w) | 0) - ((b / w) | 0));
};

describe('warships: placed anywhere in the sea, longer ranges', () => {
  it('a port opens its whole sea (not a lake it does not touch); price and build time stay', () => {
    const { s, port } = longCoast();
    const far = at(s, 250, 39); // 240 tiles from the port
    const gold = s.players[1].gold;
    expect(applyAction(s, 1, { type: 'buildWarship', port: -1, tile: far }).ok).toBe(true);
    expect(s.players[1].gold).toBe(gold - UNITS.warship.gold);
    expect(s.unitQueue?.[0].site).toBe(port.tile);
    expect(applyAction(s, 1, { type: 'buildWarship', port: -1, tile: at(s, 6, 6) }).reason).toMatch(/reached by sea/);
    expect(validateAction({ type: 'buildWarship', port: -1, tile: far }).ok).toBe(true);
  });

  it('fights, sees and supports from further out; battleships shell twice as far', () => {
    expect(WARSHIP_RANGE).toBeGreaterThanOrEqual(30);
    expect(WARSHIP_DETECT_RANGE).toBe(WARSHIP_RANGE * 3);
    expect(NAVY_SUPPORT_RANGE).toBeGreaterThanOrEqual(28);
    const { s } = longCoast();
    const coast = at(s, 180, 19);
    s.tick++;
    expect(navalSupportAt(s, 1, coast)).toBe(0);
    const u = spawnWarshipAt(s, 1, at(s, 10, 19), at(s, 180, 19 + NAVY_SUPPORT_RANGE - 2)); // 28 tiles out (was 18)
    s.tick++;
    expect(supportingShips(s, 1, coast)).toBe(1);
    expect(navalSupportAt(s, 1, coast)).toBeGreaterThan(0);
    expect(navalShellRangeMul(s, u)).toBe(1);
    u.variant = 'battleship';
    expect(navalShellRangeMul(s, u)).toBe(2);
  });
});

describe("roaming 'auto' ships", () => {
  it('at war they leave their post for the war target\'s coast far away, go home to mend when damaged, then go back', () => {
    const { s, port } = longCoast();
    const post = at(s, 10, 22);
    const u = spawnWarshipAt(s, 1, port.tile, post);
    run(s, 60);
    expect(u.state).not.toBe(3); // at peace: stays around its post
    expect(d2t(s, Math.round(u.y) * s.map.width + Math.round(u.x), post)).toBeLessThan(20);
    keepWar(s);
    const onStation = (): boolean => u.state === 3 && u.station !== undefined && s.map.owner[u.station] === 2 && u.pathPos >= u.path.length;
    expect(runUntil(s, onStation, 600, () => keepWar(s))).toBe(true);
    // The war target's coast near the main front (x ~130), more than 100 tiles from the old post; the post moved too.
    expect(d2t(s, u.station!, post)).toBeGreaterThan(100);
    expect(d2t(s, u.cargo, post)).toBeGreaterThan(100);
    // Badly damaged: back to the Port, mended there, then out again.
    u.hp = warshipMaxHp(u) * NAVY_REACH.repairBelow * 0.6;
    const atPort = (): boolean => Math.hypot(u.x - 10, u.y - 19) <= 8;
    expect(runUntil(s, atPort, 900, () => keepWar(s))).toBe(true);
    expect(runUntil(s, () => u.hp >= warshipMaxHp(u) - 1e-9, 900, () => keepWar(s))).toBe(true);
    expect(atPort()).toBe(true); // it stayed until whole
    expect(runUntil(s, onStation, 900, () => keepWar(s))).toBe(true);
    expect(d2t(s, u.station!, post)).toBeGreaterThan(100);
  });

  it("'hold' ships never roam", () => {
    const { s, port } = longCoast();
    const post = at(s, 10, 22);
    const u = spawnWarshipAt(s, 1, port.tile, post);
    expect(applyAction(s, 1, { type: 'setUnitStance', unitIds: [u.id], stance: 'hold' }).ok).toBe(true);
    for (let k = 0; k < 300; k++) {
      keepWar(s);
      tick(s);
    }
    expect(u.state).not.toBe(3);
    expect(Math.hypot(u.x - 10, u.y - 22)).toBeLessThan(25);
  });
});

describe("'hunt' ships search the whole sea", () => {
  /** 420 x 20: player 1 land x 0..9, sea x 10..409, player 2 land x 410..419; a lake at 3..5 x 3..5. */
  function wideSea(): GameState {
    const s = makeFlatGame(420, 20, 2, { human: true, seed: 3 });
    for (let y = 0; y < 20; y++) for (let x = 10; x < 410; x++) s.map.terrain[at(s, x, y)] = Terrain.DeepWater;
    for (let y = 3; y <= 5; y++) for (let x = 3; x <= 5; x++) s.map.terrain[at(s, x, y)] = Terrain.ShallowWater;
    computeCoastAndLand(s.map);
    claimRect(s, 1, 0, 0, 9, 19);
    claimRect(s, 2, 410, 0, 419, 19);
    frozen(s);
    rich(s);
    return s;
  }
  const war = (s: GameState): void => {
    s.warMemory = [1, 2, s.tick + 100000];
  };

  it('chases a ship of a nation at war far beyond its detection range; not at peace, not in another water body', () => {
    const peace = wideSea();
    const h0 = spawnWarshipAt(peace, 1, at(peace, 9, 10), at(peace, 20, 10));
    applyAction(peace, 1, { type: 'setUnitStance', unitIds: [h0.id], stance: 'hunt' });
    const p0 = spawnWarshipAt(peace, 2, at(peace, 410, 10), at(peace, 300, 10));
    p0.path = [];
    expect(300 - 20).toBeGreaterThan(NAVY_HUNT_DETECT);
    run(peace, 60);
    expect(h0.state).not.toBe(2);

    const s = wideSea();
    war(s);
    const h = spawnWarshipAt(s, 1, at(s, 9, 10), at(s, 20, 10));
    applyAction(s, 1, { type: 'setUnitStance', unitIds: [h.id], stance: 'hunt' });
    const lakeShip = spawnWarshipAt(s, 2, at(s, 6, 4), at(s, 4, 4)); // nearer, but on a lake
    lakeShip.path = [];
    const prey = spawnWarshipAt(s, 2, at(s, 410, 10), at(s, 300, 10));
    prey.path = [];
    prey.stance = 'hold'; // stays put (AI 2 is frozen: no orders)
    prey.hp = 0.5;
    expect(runUntil(s, () => h.state === 2, 60)).toBe(true);
    expect(h.chase).toBe(prey.id);
    // It closes in, far past its old leash.
    expect(runUntil(s, () => Math.abs(h.x - prey.x) <= WARSHIP_RANGE, 600)).toBe(true);
    expect(h.x).toBeGreaterThan(200);
  });
});

describe('tank divisions: rail moves', () => {
  /** 200 x 30 plains: the human 1 owns x 0..169, AI 2 x 170..199. */
  function wideLand(): GameState {
    const s = makeFlatGame(200, 30, 2, { human: true, seed: 3 });
    claimRect(s, 1, 0, 0, 169, 29);
    claimRect(s, 2, 170, 0, 199, 29);
    frozen(s);
    rich(s);
    s.players[1].techs.push('mechanization');
    s.players[1].troops = { infantry: 50000, armor: 20000, artillery: 5000 };
    s.players[2].troops = { infantry: 20000, armor: 0, artillery: 0 };
    return s;
  }

  it('a division crosses its own land fast (Railways faster); divisionMoveTime says how long', () => {
    const s = wideLand();
    expect(divisionDriveSpeed(s, 1)).toBeCloseTo(UNITS.tankDivision.speed);
    expect(UNITS.tankDivision.speed).toBeGreaterThanOrEqual(15);
    const d = spawnTankDivision(s, 1, at(s, 5, 15));
    const dest = at(s, 150, 15);
    const secs = divisionMoveTime(s, d, dest);
    expect(secs).toBeCloseTo(145 / UNITS.tankDivision.speed, 1);
    expect(divisionMoveTime(s, d, at(s, 180, 15))).toBe(-1); // not own land
    expect(applyAction(s, 1, { type: 'moveTankDivision', unitIds: [d.id], tile: dest }).ok).toBe(true);
    run(s, Math.ceil(secs * TICKS_PER_SECOND) + 2);
    expect(d.state).toBe(0);
    expect(Math.round(d.x)).toBe(150);

    const r = wideLand();
    r.players[1].techs.push('railways');
    expect(divisionDriveSpeed(r, 1)).toBeCloseTo(UNITS.tankDivision.speed * TANK_MOBILITY.railways);
    const d2 = spawnTankDivision(r, 1, at(r, 5, 15));
    expect(divisionMoveTime(r, d2, dest)).toBeCloseTo(secs / TANK_MOBILITY.railways, 1);
  });

  it('spearheads run faster and deeper, and launch at land up to TANK_LAUNCH_REACH past the border', () => {
    expect(TANK_SPEARHEAD_SPEED).toBeGreaterThanOrEqual(5);
    expect(TANK_SPEARHEAD_MAX_DEPTH).toBeGreaterThanOrEqual(55);
    expect(TANK_LAUNCH_REACH).toBeGreaterThanOrEqual(10);
    // Neutral open land east of x 30: a long, cheap run.
    const s = makeFlatGame(140, 30, 2, { human: true, seed: 3 });
    claimRect(s, 1, 0, 0, 29, 29);
    claimRect(s, 2, 135, 0, 139, 29);
    frozen(s);
    rich(s);
    s.players[1].techs.push('mechanization');
    const d = spawnTankDivision(s, 1, at(s, 29, 15));
    // Too deep: refused; 10 tiles past the border: accepted.
    expect(applyAction(s, 1, { type: 'moveTankDivision', unitIds: [d.id], tile: at(s, 29 + TANK_LAUNCH_REACH + 3, 15) }).ok).toBe(false);
    expect(applyAction(s, 1, { type: 'moveTankDivision', unitIds: [d.id], tile: at(s, 40, 15) }).ok).toBe(true);
    expect(runUntil(s, () => d.state === 3, 50)).toBe(true);
    const x0 = d.x;
    run(s, TICKS_PER_SECOND);
    expect(d.x - x0).toBeGreaterThan(TANK_SPEARHEAD_SPEED * 0.7); // ~6 tiles in a second on plains (was 3)
    expect(runUntil(s, () => d.state !== 3, 600)).toBe(true);
    let taken = 0;
    for (let x = 30; x < 135; x++) if (s.map.owner[at(s, x, 15)] === 1) taken++;
    expect(taken).toBeGreaterThan(40); // deeper than the old 40-tile cap
    expect(taken).toBeLessThanOrEqual(TANK_SPEARHEAD_MAX_DEPTH + 1);
  });

  it('no launch across water without Amphibious Tanks, even within reach', () => {
    const s = makeFlatGame(70, 30, 2, { human: true, seed: 4 });
    for (let y = 0; y < 30; y++) for (let x = 25; x < 29; x++) s.map.terrain[at(s, x, y)] = Terrain.ShallowWater;
    computeCoastAndLand(s.map);
    claimRect(s, 1, 0, 0, 24, 29);
    claimRect(s, 2, 29, 0, 69, 29);
    frozen(s);
    rich(s);
    s.players[1].techs.push('mechanization');
    const d = spawnTankDivision(s, 1, at(s, 20, 15));
    expect(applyAction(s, 1, { type: 'moveTankDivision', unitIds: [d.id], tile: at(s, 31, 15) }).reason).toMatch(/border/);
  });
});

describe('support divisions jump to the main front', () => {
  /** 240 x 30: AI 2 x 0..19, the human 1 x 20..219, AI 3 x 220..239. */
  function threeNations(): GameState {
    const s = makeFlatGame(240, 30, 3, { human: true, seed: 5 });
    claimRect(s, 2, 0, 0, 19, 29);
    claimRect(s, 1, 20, 0, 219, 29);
    claimRect(s, 3, 220, 0, 239, 29);
    frozen(s);
    rich(s);
    s.players[1].techs.push('mechanization');
    s.players[1].troops = { infantry: 400000, armor: 20000, artillery: 5000 };
    return s;
  }
  it('a following division far from the war drives to its main front within seconds', () => {
    const s = threeNations();
    const d = spawnTankDivision(s, 1, at(s, 210, 15));
    expect(applyAction(s, 1, { type: 'setDivisionMode', unitIds: [d.id], mode: 'support' }).ok).toBe(true);
    const border = frontTiles(s, 1, 2);
    expect(applyAction(s, 1, { type: 'attack', tile: border[Math.floor(border.length / 2)], troops: { infantry: 60000, armor: 0, artillery: 0 } }).ok).toBe(true);
    // ~190 tiles: about 10 s by rail, plus a think or two (old speed: 38 s of driving).
    expect(runUntil(s, () => d.station !== undefined && d.x < 45, 16 * TICKS_PER_SECOND)).toBe(true);
    expect(d.station! % s.map.width).toBeLessThan(25);
  });

  it('an AI puts its divisions at the main front (where the fighting is), not the nearest border tile', () => {
    const s = makeFlatGame(60, 60, 2, { seed: 3 });
    claimRect(s, 1, 0, 0, 29, 59);
    claimRect(s, 2, 30, 0, 59, 59);
    s.admin = { aiPassive: [], godMode: [], aiFrozen: false, revealIntel: [] };
    s.settings.victoryLandShare = 0.99;
    rich(s);
    s.players[1].techs.push('mechanization');
    const d = spawnTankDivision(s, 1, at(s, 20, 5)); // north
    expect(applyAction(s, 2, { type: 'attack', tile: at(s, 29, 55), troops: { infantry: 5000, armor: 0, artillery: 0 } }).ok).toBe(true); // south
    aiDivisionModes(s, 1, (a) => applyAction(s, 1, a));
    expect(d.mode).toBe('support');
    expect(s.map.owner[d.station!]).toBe(2);
    expect((d.station! / s.map.width) | 0).toBeGreaterThan(40);
  });

  it('a balanced AI with a Factory and armor builds divisions on a lower bar', () => {
    const s = makeFlatGame(60, 30, 2, { seed: 5 });
    claimRect(s, 1, 0, 0, 29, 29);
    claimRect(s, 2, 30, 0, 59, 29);
    s.settings.victoryLandShare = 0.99;
    const ai = s.players[1];
    ai.personality = 'balanced';
    ai.techs.push('mechanization');
    addBuilding(s, 'factory', 1, at(s, 10, 15), 2);
    const c = tankDivisionCost(s, 1);
    ai.gold = c.gold * 2; // under the old 2.5x bar
    ai.iron = c.iron * 1.3;
    ai.oil = c.oil * 1.3;
    ai.troops = { infantry: 40000, armor: 7000, artillery: 2000 }; // under the old 9000 armor bar
    const built = runUntil(s, () => s.events.some((e) => e.kind === 'tankDivisionReady' && e.players.includes(1)) || (s.unitQueue ?? []).some((q) => q.owner === 1), 30 * TICKS_PER_SECOND);
    expect(built).toBe(true);
  });
});

describe('determinism', () => {
  it('roaming fleets, hunts, rail moves and jumps hash the same in two identical games', () => {
    const go = (): number => {
      const { s, port } = longCoast(9);
      const a = spawnWarshipAt(s, 1, port.tile, at(s, 10, 22));
      const b = spawnWarshipAt(s, 1, port.tile, at(s, 14, 24));
      applyAction(s, 1, { type: 'setUnitStance', unitIds: [b.id], stance: 'hunt' });
      spawnWarshipAt(s, 2, at(s, 200, 19), at(s, 200, 30));
      s.players[1].techs.push('mechanization');
      const d = spawnTankDivision(s, 1, at(s, 10, 10));
      applyAction(s, 1, { type: 'setDivisionMode', unitIds: [d.id], mode: 'support' });
      for (let k = 0; k < 900; k++) {
        keepWar(s);
        if (k === 400) a.hp = 1;
        tick(s);
      }
      const ships = s.units.filter((u: Unit) => u.type === 'warship');
      expect(ships.length).toBeGreaterThan(0);
      return hashState(s);
    };
    expect(go()).toBe(go());
  });
});
