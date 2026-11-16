// Defense part 2 (sim/defense.ts): Tracking Radar (anti-air lane upgrade) and Coastal Batteries (barriers lane
// upgrade): the row, the prices, the radar lock, the reveal, the 2 hp stealth bomber and its long replacement, the
// batteries' range, war rule, target order and damage, silencing them by shelling, the AI landing count, the hash.
import { describe, expect, it } from 'vitest';
import { applyAction } from '../src/sim/actions';
import { ARSENAL_ROWS } from '../src/sim/arsenal';
import { markBuildingsChanged } from '../src/sim/buildings';
import { ARSENAL_PRICES, CRUISE, DEFENSE, STEALTH, TICKS_PER_SECOND, WARSHIP_SHELL_RANGE } from '../src/sim/config';
import {
  batteriesCovering,
  batteryRange,
  batterySites,
  coastalFort,
  radarRadius,
  RADAR_LOCK_TICKS,
  shellBattery,
  shellBatteryTarget,
  updateBatteries,
  updateRadar,
} from '../src/sim/defense';
import { hashState } from '../src/sim/hash';
import { computeCoastAndLand } from '../src/sim/mapgen';
import { arsenalPrice } from '../src/sim/procurement';
import { newId } from '../src/sim/state';
import { stealthRevealedTo } from '../src/sim/stealthSight';
import { techStatus, techStatusReason } from '../src/sim/techtree';
import { shotDown, updateUnits } from '../src/sim/units';
import { Terrain, type Building, type BuildingType, type GameState, type TechId, type Unit } from '../src/sim/types';
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
function unit(s: GameState, type: Unit['type'], owner: number, x: number, y: number, extra: Partial<Unit> = {}): Unit {
  const u = { id: newId(s), type, owner, x, y, target: at(s, x, y), home: at(s, x, y), path: [], pathPos: 0, troops: { infantry: 0, armor: 0, artillery: 0 }, hp: 3, cargo: 0, state: 0, targetOwner: 0, ...extra } as Unit;
  s.units.push(u);
  return u;
}
/** 160x40: player 1 x 0..69, sea x 70..89, player 2 x 90..159; AIs frozen, rich. */
function game(seed = 7): GameState {
  const s = makeFlatGame(160, 40, 2, { human: true, seed });
  for (let y = 0; y < 40; y++) for (let x = 70; x < 90; x++) s.map.terrain[at(s, x, y)] = Terrain.Ocean;
  computeCoastAndLand(s.map);
  claimRect(s, 1, 0, 0, 69, 39);
  claimRect(s, 2, 90, 0, 159, 39);
  s.admin = { aiPassive: [], godMode: [], aiFrozen: true, revealIntel: [] };
  s.settings.victoryLandShare = 0.99;
  for (const p of s.players) {
    if (p.id === 0) continue;
    p.gold = 1e6;
    p.iron = 1e5;
    p.oil = 1e5;
  }
  return s;
}
/** a and b stay at war (state.warMemory) without an attack running. */
function war(s: GameState, a: number, b: number): void {
  (s.warMemory ??= []).push(Math.min(a, b), Math.max(a, b), 1e9);
}
/** Runs the batteries for n ticks. */
function fire(s: GameState, n: number): void {
  const ships = s.units.filter((u) => u.type === 'warship' || u.type === 'transport');
  for (let k = 0; k < n; k++) {
    updateBatteries(s, ships);
    s.tick++;
  }
}

describe('Defense part 2: the lane upgrades', () => {
  it('Tracking Radar follows Flak Guns (and needs Radar), Coastal Batteries follows Tank Traps; tier 3 prices', () => {
    const row = ARSENAL_ROWS.find((r) => r.pillar === 'defense')!;
    expect(row.items.map((i) => `${i.tech}:${i.tier}:${i.branch}`)).toEqual(['flakGuns:2:flakGuns', 'tankTraps:2:tankTraps', 'trackingRadar:3:flakGuns', 'coastalBatteries:3:tankTraps']);
    const s = game();
    give(s, 1, 'fortification', 'flakGuns');
    addBuilding(s, 'fort', 1, at(s, 40, 20));
    expect(techStatusReason(s, 1, 'trackingRadar')).toContain('Radar');
    give(s, 1, 'radar');
    expect(techStatus(s, 1, 'trackingRadar')).toBe('available');
    expect(techStatus(s, 1, 'coastalBatteries')).toBe('locked-choice');
    const t3 = ARSENAL_PRICES.tiers[3];
    expect(t3).toMatchObject({ gold: 9000, resource: 3500, seconds: 35 });
    expect(arsenalPrice(s, 1, 'trackingRadar')).toMatchObject({ gold: 9000, iron: 2800, oil: 700, needs: 'fort' });
  });
});

describe('Tracking Radar', () => {
  /** Player 2 holds Tracking Radar with a level-1 SAM at (120, 20); player 1's stealth bomber flies. */
  function radarGame(): { s: GameState; sam: Building } {
    const s = game();
    give(s, 2, 'fortification', 'flakGuns', 'radar', 'trackingRadar');
    const sam = addBuilding(s, 'sam', 2, at(s, 120, 20));
    return { s, sam };
  }

  it('spots a stealth bomber after 3 s inside half its SAM reach, counted over the whole flight', () => {
    const { s, sam } = radarGame();
    const r = radarRadius(s, sam);
    expect(r).toBeCloseTo(30, 6); // half of 60
    const u = unit(s, 'stealthBomber', 1, 120 - (r - 2), 20, { hp: 2, targetOwner: 2 });
    for (let k = 0; k < RADAR_LOCK_TICKS - 11; k++) updateRadar(s, [u]);
    expect(stealthRevealedTo(s, 2, u)).toBe(false);
    u.x = 120 - (r + 5); // out of the circle: the count is kept, but nothing is spotted outside
    for (let k = 0; k < 20; k++) updateRadar(s, [u]);
    expect(stealthRevealedTo(s, 2, u)).toBe(false);
    u.x = 120 - (r - 2); // back in (on its way home): the lock completes 10 ticks later
    for (let k = 0; k < 10; k++) updateRadar(s, [u]);
    expect(stealthRevealedTo(s, 2, u)).toBe(false);
    updateRadar(s, [u]);
    expect(stealthRevealedTo(s, 2, u)).toBe(true);
    expect(stealthRevealedTo(s, 1, u)).toBe(false);
    expect(s.effects.some((e) => e.kind === 'radarLock')).toBe(true);
    expect(s.events.some((e) => e.message.includes('Tracking Radar spotted a stealth bomber'))).toBe(true);
    u.x = 120 - (r + 5);
    updateRadar(s, [u]);
    expect(stealthRevealedTo(s, 2, u)).toBe(false); // outside every locked circle: hidden again
  });

  it('a real strike lands, then the radar it passed twice catches the bomber on its way home', () => {
    const { s } = radarGame();
    addBuilding(s, 'sam', 2, at(s, 125, 20));
    addBuilding(s, 'sam', 2, at(s, 125, 21));
    give(s, 1, 'flight', 'airMastery');
    give(s, 2, 'flight');
    addBuilding(s, 'airfield', 1, at(s, 40, 20));
    addBuilding(s, 'factory', 2, at(s, 150, 20));
    expect(applyAction(s, 1, { type: 'stealthStrike', airfield: -1, tile: at(s, 150, 20) }).ok).toBe(true);
    for (let k = 0; k < 800 && s.units.some((u) => u.type === 'stealthBomber' && u.hp > 0); k++) {
      updateUnits(s);
      s.tick++;
    }
    expect(s.events.some((e) => e.message.startsWith('Stealth strike by '))).toBe(true);
    expect(s.events.some((e) => /shot down a stealth bomber/.test(e.message))).toBe(true);
    expect(s.players[1].stealthReady! - s.tick).toBeGreaterThan(STEALTH.cooldownSeconds * TICKS_PER_SECOND);
  });

  it('a knocked-out SAM tracks nothing; without the tech nothing is spotted', () => {
    const { s, sam } = radarGame();
    sam.disabledUntil = s.tick + 1000;
    const u = unit(s, 'stealthBomber', 1, 120, 20, { hp: 2, targetOwner: 2 });
    for (let k = 0; k < RADAR_LOCK_TICKS + 5; k++) updateRadar(s, [u]);
    expect(stealthRevealedTo(s, 2, u)).toBe(false);
    sam.disabledUntil = 0;
    s.players[2].techs = s.players[2].techs.filter((t) => t !== 'trackingRadar');
    for (let k = 0; k < RADAR_LOCK_TICKS + 5; k++) updateRadar(s, [u]);
    expect(stealthRevealedTo(s, 2, u)).toBe(false);
  });

  it('the stealth bomber has 2 hp; shot down, the next one waits about 3 minutes', () => {
    const { s } = radarGame();
    const u = unit(s, 'stealthBomber', 1, 120, 20, { hp: 2, targetOwner: 2 });
    s.players[1].stealthReady = s.tick + 10;
    shotDown(s, u, 2, 'SAM site');
    expect(s.players[1].stealthReady).toBe(s.tick + STEALTH.lostCooldownSeconds * TICKS_PER_SECOND);
    expect(STEALTH.lostCooldownSeconds).toBeGreaterThanOrEqual(150);
  });

  it('radarLock and radarSeen are hashed', () => {
    const { s } = radarGame();
    const u = unit(s, 'stealthBomber', 1, 120, 20, { hp: 2, targetOwner: 2 });
    const h0 = hashState(s);
    u.radarLock = [5, 3];
    const h1 = hashState(s);
    expect(h1).not.toBe(h0);
    u.radarSeen = [2];
    expect(hashState(s)).not.toBe(h1);
  });
});

describe('Coastal Batteries', () => {
  /** Player 2 holds Coastal Batteries with a level-1 Port on its coast at (90, 20). */
  function batteryGame(): { s: GameState; port: Building } {
    const s = game();
    give(s, 2, 'fortification', 'tankTraps', 'coastalBatteries');
    const port = addBuilding(s, 'port', 2, at(s, 90, 20));
    return { s, port };
  }

  it('sites: Ports and Forts within 4 tiles of the coast; range below battleship shelling at every level', () => {
    const { s, port } = batteryGame();
    const near = addBuilding(s, 'fort', 2, at(s, 93, 10));
    const inland = addBuilding(s, 'fort', 2, at(s, 110, 10));
    expect(coastalFort(s, near)).toBe(true);
    expect(coastalFort(s, inland)).toBe(false);
    expect(batterySites(s).map((b) => b.id).sort()).toEqual([port.id, near.id].sort());
    expect(batteryRange(port)).toBe(DEFENSE.batteryRange);
    for (let lv = 1; lv <= 5; lv++) expect(batteryRange({ ...port, level: lv })).toBeLessThan(WARSHIP_SHELL_RANGE * 2);
  });

  it('fires every 2 s at a ship of a nation at war in range; never in peace or out of range', () => {
    const { s } = batteryGame();
    const ship = unit(s, 'warship', 1, 75, 20);
    fire(s, 40);
    expect(ship.hp).toBe(3); // not at war
    war(s, 1, 2);
    fire(s, 40);
    expect(ship.hp).toBeCloseTo(3 - 2 * DEFENSE.batteryDamage, 6);
    expect(s.effects.some((e) => e.kind === 'battery')).toBe(true);
    const far = unit(s, 'warship', 1, 90 - DEFENSE.batteryRange - 2, 25);
    fire(s, 40);
    expect(far.hp).toBe(3);
  });

  it('target order: cruise missile ship, then ships shelling the coast, then transports; transports lose troops, never sink', () => {
    const { s } = batteryGame();
    war(s, 1, 2);
    const transport = unit(s, 'transport', 1, 85, 20, { hp: 1, troops: { infantry: 1000, armor: 0, artillery: 0 } });
    const sheller = unit(s, 'warship', 1, 80, 22);
    const cruiser = unit(s, 'warship', 1, 66, 30, { cruiseReady: s.tick + CRUISE.reloadSeconds * TICKS_PER_SECOND });
    expect(Math.hypot(90 - 66, 20 - 30)).toBeLessThan(DEFENSE.batteryRange);
    fire(s, 20);
    expect(cruiser.hp).toBeLessThan(3);
    expect(sheller.hp).toBe(3);
    cruiser.cruiseReady = undefined;
    cruiser.x = 60; // out of range
    fire(s, 20);
    expect(sheller.hp).toBeLessThan(3);
    expect(transport.troops.infantry).toBe(1000);
    sheller.hp = 0;
    fire(s, 20);
    expect(transport.hp).toBe(1);
    expect(transport.troops.infantry).toBeCloseTo(1000 * (1 - DEFENSE.batteryTransportLoss), 6);
  });

  it('warships shell a battery silent; the AI counts working batteries over a landing', () => {
    const { s, port } = batteryGame();
    war(s, 1, 2);
    const wars = new Set([1 * 1024 + 2, 2 * 1024 + 1]);
    const ship = unit(s, 'warship', 1, 80, 20);
    expect(shellBatteryTarget(s, ship, 17.5, wars)).toBe(port);
    ship.stance = 'hold';
    expect(shellBatteryTarget(s, ship, 17.5, wars)).toBeNull(); // a player's hold ship keeps its own job
    expect(batteriesCovering(s, 1, at(s, 92, 25), 2)).toBe(1);
    for (let k = 0; k < 20 && port.hp >= DEFENSE.batteryFireHp; k++) shellBattery(s, ship, port, 1);
    expect(port.hp).toBeLessThan(DEFENSE.batteryFireHp);
    expect(port.hp).toBeGreaterThanOrEqual(DEFENSE.batteryHpFloor);
    expect(batteriesCovering(s, 1, at(s, 92, 25), 2)).toBe(0);
    const victim = unit(s, 'warship', 1, 80, 22);
    fire(s, 40);
    expect(victim.hp).toBe(3); // silent
  });
});
