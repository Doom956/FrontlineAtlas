// Cruise missiles from sea (units.ts launchCruise, cruise.ts): validation, flight, blast, SAM interception, reload,
// determinism, the AI's use and the server's validation.
import { describe, expect, it } from 'vitest';
import { applyAction } from '../src/sim/actions';
import { markBuildingsChanged } from '../src/sim/buildings';
import { CRUISE, ROCKET_RADIUS, TICKS_PER_SECOND, UNITS } from '../src/sim/config';
import { aiCruise, cruisePreview } from '../src/sim/cruise';
import { formAlliance } from '../src/sim/diplomacy';
import { hashState } from '../src/sim/hash';
import { computeCoastAndLand } from '../src/sim/mapgen';
import { newId } from '../src/sim/state';
import { buildAircraft, cruiseReason, cruiseReloadLeft, spawnWarshipAt, updateUnits } from '../src/sim/units';
import { updateArsenal } from '../src/sim/variants';
import { Terrain } from '../src/sim/types';
import type { Building, BuildingType, GameState, Unit } from '../src/sim/types';
import { validateAction } from '../server/validate';
import { claimRect, makeFlatGame, troopSum } from './helpers';

const at = (s: GameState, x: number, y: number): number => y * s.map.width + x;

/** 120 x 60: land y 0..29 (player 1 x 0..59, player 2 x 60..119), sea y 30..59. Rich, Naval Mastery for 1; AIs frozen. */
function game(seed = 5): GameState {
  const s = makeFlatGame(120, 60, 3, { human: true, seed });
  for (let y = 30; y < 60; y++) for (let x = 0; x < 120; x++) s.map.terrain[at(s, x, y)] = Terrain.DeepWater;
  computeCoastAndLand(s.map);
  claimRect(s, 1, 0, 0, 59, 29);
  claimRect(s, 2, 60, 0, 119, 29);
  s.admin = { aiPassive: [], godMode: [], aiFrozen: true, revealIntel: [] };
  s.settings.victoryLandShare = 0.99;
  for (const p of s.players) {
    if (p.id === 0) continue;
    p.gold = 1e6;
    p.iron = 1e5;
    p.oil = 1e5;
    p.techs.push('navigation');
    p.troops = { infantry: 300000, armor: 0, artillery: 0 };
  }
  s.players[1].techs.push('navalMastery');
  return s;
}
function addBuilding(s: GameState, type: BuildingType, owner: number, tile: number, level = 1): Building {
  const id = newId(s);
  const b: Building = { id, type, owner, tile, level, buildLeft: 0, upgradeLeft: 0, fighters: 0, bombers: 0, cooldown: 0, dropCooldown: 0, disabledUntil: 0, hp: 1, queuedLevels: 0 };
  s.buildings.set(id, b);
  s.map.building[tile] = id + 1;
  markBuildingsChanged(s);
  return b;
}
/** A warship of `owner` holding at sea tile (x, y) (stance hold: it stays put while units move). */
function ship(s: GameState, owner: number, x: number, y: number, variant?: Unit['variant']): Unit {
  const u = spawnWarshipAt(s, owner, at(s, owner === 1 ? 30 : 90, 29), at(s, x, y));
  u.stance = 'hold';
  if (variant) u.variant = variant;
  return u;
}
/** Units only (no combat, economy or AI) until pred() or max ticks. */
function fly(s: GameState, pred: () => boolean, max = 600): void {
  for (let k = 0; k < max && !pred(); k++) {
    updateUnits(s);
    s.tick++;
  }
}
const missiles = (s: GameState): Unit[] => s.units.filter((u) => u.type === 'cruiseMissile' && u.hp > 0);
const fire = (s: GameState, u: Unit, tile: number) => applyAction(s, u.owner, { type: 'cruiseMissile', ship: u.id, tile });

describe('cruise missile: validation', () => {
  it('needs your own warship, destroyer or battleship, Naval Mastery, a loaded cell, reach and the price', () => {
    const s = game();
    const mine = ship(s, 1, 70, 32);
    const theirs = ship(s, 2, 100, 50);
    const target = at(s, 70, 20); // 12 tiles inland from the ship
    // (player 2 is an AI, frozen in these tests: its side is read with cruiseReason)
    expect(cruiseReason(s, 2, theirs, at(s, 30, 20))).toBe('Needs Naval Mastery');
    expect(cruiseReason(s, 2, mine, target)).toBe('That ship is not yours');
    expect(applyAction(s, 1, { type: 'cruiseMissile', ship: 99999, tile: target }).ok).toBe(false);
    // reach: CRUISE.reach tiles from the ship
    expect(fire(s, mine, at(s, 70, 0)).ok).toBe(true);
    const far = at(s, 115, 2);
    expect(fire(s, ship(s, 1, 50, 58), far).reason).toMatch(new RegExp(`^Too far: cruise missiles reach ${CRUISE.reach} tiles`));
    // water, own land, allies
    const s2 = game();
    const a = ship(s2, 1, 70, 32);
    expect(fire(s2, a, at(s2, 70, 40)).reason).toBe('Cruise missiles hit land');
    expect(fire(s2, a, at(s2, 55, 20)).reason).toBe('That is your own land');
    formAlliance(s2, 1, 2);
    expect(fire(s2, a, target).reason).toBe('You cannot fire at an ally');
    // hulls: no submarines or carriers
    const s3 = game();
    expect(fire(s3, ship(s3, 1, 70, 32, 'submarine'), target).reason).toBe('Submarines carry no cruise missiles');
    expect(fire(s3, ship(s3, 1, 72, 32, 'carrier'), target).reason).toBe('Carriers carry no cruise missiles');
    expect(fire(s3, ship(s3, 1, 74, 32, 'destroyer'), target).ok).toBe(true);
    expect(fire(s3, ship(s3, 1, 76, 32, 'battleship'), target).ok).toBe(true);
    // the price: gold and oil per missile
    const s4 = game();
    const b = ship(s4, 1, 70, 32);
    s4.players[1].gold = UNITS.cruiseMissile.gold - 1;
    expect(fire(s4, b, target).reason).toBe(`Not enough gold (${UNITS.cruiseMissile.gold})`);
    s4.players[1].gold = 1e6;
    s4.players[1].oil = 0;
    expect(fire(s4, b, target).reason).toBe(`Not enough oil (${UNITS.cruiseMissile.oil})`);
    s4.players[1].oil = 1e5;
    const g0 = s4.players[1].gold;
    const o0 = s4.players[1].oil;
    expect(fire(s4, b, target).ok).toBe(true);
    expect(g0 - s4.players[1].gold).toBe(UNITS.cruiseMissile.gold);
    expect(o0 - s4.players[1].oil).toBe(UNITS.cruiseMissile.oil);
  });

  it('peace time stops it; noNukes does not', () => {
    const s = game();
    s.settings.modifiers.noNukes = true;
    const u = ship(s, 1, 70, 32);
    expect(fire(s, u, at(s, 70, 20)).ok).toBe(true);
    const p = game();
    p.settings.modifiers.peaceMinutes = 4;
    const v = ship(p, 1, 70, 32);
    expect(fire(p, v, at(p, 70, 20)).reason).toMatch(/^Peace time/);
  });

  it('the server accepts {ship, tile} and refuses other shapes', () => {
    expect(validateAction({ type: 'cruiseMissile', ship: 4, tile: 100 }).ok).toBe(true);
    expect(validateAction({ type: 'cruiseMissile', ship: 4 }).ok).toBe(false);
    expect(validateAction({ type: 'cruiseMissile', ship: 'x', tile: 100 }).ok).toBe(false);
  });
});

describe('cruise missile: flight, blast and reload', () => {
  it('flies from the ship, destroys hostile buildings within its small blast and kills troops', () => {
    const s = game();
    const u = ship(s, 1, 70, 32);
    const t = at(s, 70, 20);
    const near = addBuilding(s, 'city', 2, at(s, 72, 21));
    const out = addBuilding(s, 'city', 2, at(s, 70, 20 - (CRUISE.radius + 2))); // a rocket would hit it, this does not
    expect(CRUISE.radius).toBeLessThan(ROCKET_RADIUS);
    const army0 = troopSum(s.players[2].troops);
    expect(fire(s, u, t).ok).toBe(true);
    const m = missiles(s)[0];
    expect(m.x).toBe(u.x);
    expect(m.y).toBe(u.y);
    expect(m.cargo).toBe(u.id);
    expect(s.events.some((e) => e.kind === 'missile' && e.message === 'Tester launched a cruise missile at AI 2')).toBe(true);
    // the flight takes distance / speed
    let ticks = 0;
    fly(s, () => {
      ticks++;
      return missiles(s).length === 0;
    });
    expect(ticks).toBeGreaterThanOrEqual(Math.floor((12 / UNITS.cruiseMissile.speed) * TICKS_PER_SECOND));
    expect(s.buildings.has(near.id)).toBe(false);
    expect(s.buildings.has(out.id)).toBe(true);
    expect(troopSum(s.players[2].troops)).toBeLessThanOrEqual(army0 - CRUISE.killMin + 1);
    expect(s.events.some((e) => e.kind === 'missile' && /^Cruise missile strike by Tester: 1 building destroyed/.test(e.message))).toBe(true);
  });

  it('each ship reloads its own cell for CRUISE.reloadSeconds', () => {
    const s = game();
    const a = ship(s, 1, 70, 32);
    const b = ship(s, 1, 74, 32);
    const t = at(s, 72, 20);
    expect(fire(s, a, t).ok).toBe(true);
    expect(cruiseReloadLeft(s, a)).toBeCloseTo(CRUISE.reloadSeconds, 5);
    expect(fire(s, a, t).reason).toBe(`Reloading ${CRUISE.reloadSeconds} s`);
    expect(fire(s, b, t).ok).toBe(true); // the other ship is loaded
    s.tick += CRUISE.reloadSeconds * TICKS_PER_SECOND - 1;
    expect(cruiseReason(s, 1, a, t)).toBe('Reloading 1 s');
    s.tick += 1;
    expect(cruiseReason(s, 1, a, t)).toBe('');
  });
});

describe('cruise missile: SAMs', () => {
  it('a loaded SAM shoots it down exactly like a rocket (1 hp, one shot)', () => {
    const s = game();
    const u = ship(s, 1, 70, 32);
    const sam = addBuilding(s, 'sam', 2, at(s, 75, 25));
    const city = addBuilding(s, 'city', 2, at(s, 70, 20));
    expect(fire(s, u, at(s, 70, 20)).ok).toBe(true);
    fly(s, () => missiles(s).length === 0);
    expect(s.buildings.has(city.id)).toBe(true);
    expect(sam.cooldown).toBeGreaterThan(0); // its shot is spent
    expect(s.events.some((e) => e.kind === 'unitLost' && /SAM site shot down a cruise missile of Tester/.test(e.message))).toBe(true);
  });

  it('two missiles at once saturate a level-1 SAM: the second gets through', () => {
    const s = game();
    const a = ship(s, 1, 70, 32);
    const b = ship(s, 1, 71, 32);
    addBuilding(s, 'sam', 2, at(s, 75, 25));
    const city = addBuilding(s, 'city', 2, at(s, 70, 20));
    expect(fire(s, a, at(s, 70, 20)).ok).toBe(true);
    expect(fire(s, b, at(s, 70, 20)).ok).toBe(true);
    fly(s, () => missiles(s).length === 0);
    expect(s.buildings.has(city.id)).toBe(false);
  });

  it('rockets and cruise missiles share their place in the interception order (then by id)', () => {
    const s = game();
    s.players[1].techs.push('rocketry');
    const silo = addBuilding(s, 'silo', 1, at(s, 50, 20));
    const sam = addBuilding(s, 'sam', 2, at(s, 70, 22));
    const u = ship(s, 1, 70, 31);
    // the cruise missile is launched first (lower id), the rocket next: both enter the SAM's cover on the same tick
    expect(fire(s, u, at(s, 70, 24)).ok).toBe(true);
    expect(applyAction(s, 1, { type: 'launchMissile', silo: silo.tile, kind: 'rocket', tile: at(s, 70, 24) }).ok).toBe(true);
    updateUnits(s);
    const shot = s.events.filter((e) => e.kind === 'unitLost' && /shot down a/.test(e.message));
    expect(shot.length).toBe(1);
    expect(shot[0].message).toMatch(/shot down a cruise missile/);
    expect(sam.cooldown).toBeGreaterThan(0);
  });
});

describe('cruise missile: preview and AI', () => {
  it('cruisePreview counts what the blast would hit and the SAM shots covering it', () => {
    const s = game();
    const u = ship(s, 1, 70, 32);
    addBuilding(s, 'city', 2, at(s, 70, 20));
    addBuilding(s, 'sam', 2, at(s, 80, 20));
    const pv = cruisePreview(s, 1, u.id, at(s, 70, 20));
    expect(pv.ok).toBe(true);
    expect(pv.radius).toBe(CRUISE.radius);
    expect(pv.enemyBuildings).toBe(1);
    expect(pv.samShots).toBe(1);
    expect(cruisePreview(s, 1, u.id, at(s, 70, 40)).reason).toBe('Cruise missiles hit land');
  });

  it('an AI at war fires at a SAM near the coast it can saturate, keeps its gold reserve, and skips heavy cover', () => {
    const s = game();
    s.admin!.aiFrozen = false;
    s.players[1].isHuman = false;
    s.players[1].personality = 'admiral';
    s.attacks.push({ id: 900, attacker: 1, target: 2, troops: { infantry: 1000, armor: 0, artillery: 0 }, focusTile: at(s, 60, 10), progress: 0, startTick: s.tick, amphibious: false, losses: 0, tilesTaken: 0 });
    const a = ship(s, 1, 70, 32);
    const b = ship(s, 1, 72, 32);
    const sam = addBuilding(s, 'sam', 2, at(s, 71, 24));
    const fired = aiCruise(s, 1);
    expect(fired).toBe(2); // two missiles at one level-1 SAM: one is shot down, one hits
    expect(missiles(s).every((m) => m.target === sam.tile)).toBe(true);
    // reserve: no missile below CRUISE.aiReserve prices of gold
    const r = game();
    r.admin!.aiFrozen = false;
    r.players[1].isHuman = false;
    r.attacks.push({ id: 900, attacker: 1, target: 2, troops: { infantry: 1000, armor: 0, artillery: 0 }, focusTile: at(r, 60, 10), progress: 0, startTick: r.tick, amphibious: false, losses: 0, tilesTaken: 0 });
    ship(r, 1, 70, 32);
    addBuilding(r, 'city', 2, at(r, 70, 22));
    r.players[1].gold = UNITS.cruiseMissile.gold * CRUISE.aiReserve - 1;
    expect(aiCruise(r, 1)).toBe(0);
    r.players[1].gold = 1e6;
    // heavy cover: three loaded SAMs over the only target, one ship: it holds its fire
    for (const x of [64, 66, 68]) addBuilding(r, 'sam', 2, at(r, x, 10), 1);
    expect(aiCruise(r, 1)).toBe(0);
    void a;
    void b;
  });

  it('a human\'s ships never fire by themselves', () => {
    const s = game();
    s.attacks.push({ id: 900, attacker: 1, target: 2, troops: { infantry: 1000, armor: 0, artillery: 0 }, focusTile: at(s, 60, 10), progress: 0, startTick: s.tick, amphibious: false, losses: 0, tilesTaken: 0 });
    ship(s, 1, 70, 32);
    addBuilding(s, 'city', 2, at(s, 70, 22));
    expect(aiCruise(s, 1)).toBe(0);
  });
});

describe('cruise missile: determinism', () => {
  it('two games fed the same orders hash the same, and the reload is in the hash', () => {
    const run = (): GameState => {
      const s = game(11);
      const u = ship(s, 1, 70, 32);
      addBuilding(s, 'city', 2, at(s, 70, 20));
      addBuilding(s, 'sam', 2, at(s, 90, 22));
      expect(fire(s, u, at(s, 70, 20)).ok).toBe(true);
      fly(s, () => false, 60);
      return s;
    };
    const a = run();
    const b = run();
    expect(hashState(a)).toBe(hashState(b));
    const ua = a.units.find((u) => u.type === 'warship')!;
    const h = hashState(a);
    ua.cruiseReady = (ua.cruiseReady ?? 0) + 1;
    expect(hashState(a)).not.toBe(h);
  });
});

describe('cruise missiles with fighters and recon planes (protocol 21)', () => {
  /** p1 has a ship, an airfield with Recon Planes; p2 has a city, fighters on an airfield and maybe one SAM shot. */
  function mixed(withSam: boolean): { s: GameState; city: Building; guard: Building; sam?: Building } {
    const s = game(7);
    s.players[1].techs.push('flight', 'reconPlanes');
    s.players[2].techs.push('flight');
    const u = ship(s, 1, 70, 32);
    const af = addBuilding(s, 'airfield', 1, at(s, 50, 20));
    const guard = addBuilding(s, 'airfield', 2, at(s, 100, 20));
    for (let k = 0; k < 2; k++) expect(buildAircraft(s, 2, guard.tile, 'fighter').ok).toBe(true);
    const sam = withSam ? addBuilding(s, 'sam', 2, at(s, 75, 25)) : undefined;
    const city = addBuilding(s, 'city', 2, at(s, 70, 20));
    expect(applyAction(s, 1, { type: 'reconFlight', airfield: af.tile, tile: at(s, 80, 12) }).ok).toBe(true);
    expect(fire(s, u, city.tile).ok).toBe(true);
    for (let k = 0; k < 400 && (missiles(s).length || s.units.some((q) => q.type === 'reconPlane' && q.hp > 0 && q.state === 0)); k++) {
      updateUnits(s);
      updateArsenal(s);
      s.tick++;
    }
    return { s, city, guard, sam };
  }
  const shot = (s: GameState, re: RegExp): boolean => s.events.some((e) => e.kind === 'unitLost' && re.test(e.message));

  it('one SAM shot goes to the cruise missile, the recon plane passes the SAM and falls to the fighters', () => {
    const { s, city, guard, sam } = mixed(true);
    expect(shot(s, /SAM site shot down a cruise missile/)).toBe(true);
    expect(shot(s, /SAM site shot down a recon plane/)).toBe(false);
    expect(shot(s, /fighters shot down a recon plane/)).toBe(true);
    expect(s.buildings.has(city.id)).toBe(true);
    expect(sam!.cooldown).toBeGreaterThan(0);
    expect(guard.cooldown).toBeGreaterThan(0);
    expect(s.arsenal?.reveals.length ?? 0).toBe(0);
  });

  it('fighters never shoot at cruise missiles: with no SAM the missile lands, the recon plane still falls', () => {
    const { s, city } = mixed(false);
    expect(s.buildings.has(city.id)).toBe(false);
    expect(shot(s, /cruise missile/)).toBe(false);
    expect(shot(s, /fighters shot down a recon plane/)).toBe(true);
  });
});
