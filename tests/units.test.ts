// Mobile units (WP-D): transports, warships, trade ships, bombers, fighters, missiles.
import { describe, expect, it } from 'vitest';
import { markBuildingsChanged } from '../src/sim/buildings';
import {
  AIRCRAFT_MAX_PER_AIRFIELD,
  BOMBER_MIN_KILL,
  FALLOUT_SECONDS,
  NUKE_OPINION_PENALTY,
  PORT_TRANSPORT_SPEED,
  ROCKET_KILL_MIN,
  SILO_COOLDOWN,
  TRADE_GOLD_PER_TILE,
  TRANSPORT_MAX_AT_SEA,
  TRANSPORT_PER_PORT,
  UNITS,
  WARSHIP_BOMBARD_KILL,
} from '../src/sim/config';
import { formAlliance, toggleEmbargo } from '../src/sim/diplomacy';
import { computeCoastAndLand } from '../src/sim/mapgen';
import { newId } from '../src/sim/state';
import {
  buildAircraft,
  buildWarship,
  launchBomber,
  launchMissile,
  launchTransport,
  moveWarship,
  transportLimit,
  updateUnits,
} from '../src/sim/units';
import { Terrain, isWater } from '../src/sim/types';
import type { Building, BuildingType, GameState, TechId, Troops, Unit } from '../src/sim/types';
import { claimRect, makeFlatGame, troopSum } from './helpers';

const inf = (n: number): Troops => ({ infantry: n, armor: 0, artillery: 0 });
const at = (s: GameState, x: number, y: number): number => y * s.map.width + x;

/**
 * 60x30 map: land x 0..19 (player 1), sea x 20..49, land x 50..59 (player 2). Player 3 (if any) owns nothing.
 * Everyone is rich in gold, iron and oil.
 */
function seaGame(players = 2, opts: { human?: boolean; seed?: number } = {}): GameState {
  const s = makeFlatGame(60, 30, players, { human: opts.human, seed: opts.seed ?? 7 });
  for (let y = 0; y < 30; y++) for (let x = 20; x < 50; x++) s.map.terrain[at(s, x, y)] = Terrain.DeepWater;
  computeCoastAndLand(s.map);
  claimRect(s, 1, 0, 0, 19, 29);
  claimRect(s, 2, 50, 0, 59, 29);
  if (players >= 3) claimRect(s, 3, 0, 0, 0, 0); // one tile so player 3 stays a living nation
  for (const p of s.players) {
    if (p.id === 0) continue;
    p.gold = 100000;
    p.iron = 10000;
    p.oil = 10000;
  }
  return s;
}

/** Places a finished building directly (no cost, spacing or tech checks). */
function addBuilding(s: GameState, type: BuildingType, owner: number, tile: number): Building {
  const id = newId(s);
  const b: Building = { id, type, owner, tile, level: 1, buildLeft: 0, fighters: 0, bombers: 0, cooldown: 0, hp: 1 };
  s.buildings.set(id, b);
  s.map.building[tile] = id + 1;
  markBuildingsChanged(s);
  return b;
}

function giveTech(s: GameState, id: number, ...techs: TechId[]): void {
  s.players[id].techs.push(...techs);
}

/** Ticks units until pred() holds (or maxTicks). Returns ticks run. */
function runUntil(s: GameState, pred: () => boolean, maxTicks = 2000): number {
  let k = 0;
  for (; k < maxTicks && !pred(); k++) {
    updateUnits(s);
    s.tick++;
  }
  return k;
}
const unitsOf = (s: GameState, type: Unit['type']): Unit[] => s.units.filter((u) => u.type === type);

describe('transports', () => {
  it('sails a water path and lands as an amphibious attack', () => {
    const s = seaGame();
    const p1 = s.players[1];
    const landing = at(s, 50, 15);
    const res = launchTransport(s, 1, -1, landing, inf(1000));
    expect(res.ok).toBe(true);
    expect(p1.troops.infantry).toBe(3000 - 1000);
    expect(p1.gold).toBe(100000 - UNITS.transport.gold);
    const [u] = unitsOf(s, 'transport');
    // Picked the own coast tile closest by water: straight across on row 15.
    expect(u.home).toBe(at(s, 19, 15));
    expect(u.path.length).toBeGreaterThan(25);
    expect(u.path.every((t) => isWater(s.map.terrain[t]))).toBe(true);

    runUntil(s, () => s.units.length === 0);
    expect(s.units.length).toBe(0);
    expect(s.map.owner[landing]).toBe(1);
    const a = s.attacks.find((q) => q.attacker === 1 && q.target === 2);
    expect(a?.amphibious).toBe(true);
    expect(troopSum(a!.troops)).toBeGreaterThan(0);
  });

  it('uses the given coastal tile; a port launch is free and faster', () => {
    const s = seaGame();
    const res = launchTransport(s, 1, at(s, 19, 3), at(s, 50, 20), inf(200));
    expect(res.ok).toBe(true);
    expect(unitsOf(s, 'transport')[0].home).toBe(at(s, 19, 3));

    addBuilding(s, 'port', 1, at(s, 19, 25));
    const gold = s.players[1].gold;
    expect(launchTransport(s, 1, at(s, 19, 25), at(s, 50, 25), inf(200)).ok).toBe(true);
    expect(s.players[1].gold).toBe(gold);
    const t = unitsOf(s, 'transport')[1];
    expect(t.cargo).toBeCloseTo(UNITS.transport.speed * PORT_TRANSPORT_SPEED);
  });

  it('rejects own, allied and inland targets and too few troops', () => {
    const s = seaGame();
    expect(launchTransport(s, 1, -1, at(s, 5, 5), inf(500)).ok).toBe(false); // own
    expect(launchTransport(s, 1, -1, at(s, 55, 15), inf(500)).ok).toBe(false); // inland
    expect(launchTransport(s, 1, -1, at(s, 50, 15), inf(10)).ok).toBe(false); // too few
    expect(launchTransport(s, 1, -1, at(s, 50, 15), inf(99999)).ok).toBe(false); // not enough
    formAlliance(s, 1, 2);
    expect(launchTransport(s, 1, -1, at(s, 50, 15), inf(500)).ok).toBe(false);
  });

  it('limits transports at sea (ports and Navigation raise the limit)', () => {
    const s = seaGame();
    for (let k = 0; k < TRANSPORT_MAX_AT_SEA; k++) expect(launchTransport(s, 1, -1, at(s, 50, 10 + k), inf(100)).ok).toBe(true);
    expect(launchTransport(s, 1, -1, at(s, 50, 20), inf(100)).ok).toBe(false);
    addBuilding(s, 'port', 1, at(s, 19, 2));
    expect(transportLimit(s, 1)).toBe(TRANSPORT_MAX_AT_SEA + TRANSPORT_PER_PORT);
    giveTech(s, 1, 'navigation');
    expect(transportLimit(s, 1)).toBe(TRANSPORT_MAX_AT_SEA + TRANSPORT_PER_PORT + 1);
    for (let k = 0; k < TRANSPORT_PER_PORT + 1; k++) expect(launchTransport(s, 1, -1, at(s, 50, 20 + k), inf(100)).ok).toBe(true);
    expect(launchTransport(s, 1, -1, at(s, 50, 27), inf(100)).ok).toBe(false);
  });

  it('returns the troops when the landing tile became own land', () => {
    const s = seaGame();
    const landing = at(s, 50, 15);
    launchTransport(s, 1, -1, landing, inf(1000));
    s.map.owner[landing] = 1; // pretend another attack took it (direct write keeps the test small)
    runUntil(s, () => s.units.length === 0);
    expect(s.players[1].troops.infantry).toBe(3000);
    expect(s.attacks.length).toBe(0);
  });
});

describe('warships', () => {
  it('needs a finished port and Navigation, and costs gold/iron/oil', () => {
    const s = seaGame();
    const port = addBuilding(s, 'port', 2, at(s, 50, 10));
    expect(buildWarship(s, 2, port.tile).ok).toBe(false);
    giveTech(s, 2, 'navigation');
    port.buildLeft = 3;
    expect(buildWarship(s, 2, port.tile).ok).toBe(false);
    port.buildLeft = 0;
    expect(buildWarship(s, 2, port.tile).ok).toBe(true);
    const p2 = s.players[2];
    expect(p2.gold).toBe(100000 - UNITS.warship.gold);
    expect(p2.iron).toBe(10000 - UNITS.warship.iron);
    expect(p2.oil).toBe(10000 - UNITS.warship.oil);
    const w = unitsOf(s, 'warship')[0];
    expect(isWater(s.map.terrain[w.cargo])).toBe(true);
  });

  it('sails to a commanded point, then patrols near it', () => {
    const s = seaGame();
    giveTech(s, 2, 'navigation');
    const port = addBuilding(s, 'port', 2, at(s, 50, 10));
    buildWarship(s, 2, port.tile);
    const w = unitsOf(s, 'warship')[0];
    expect(moveWarship(s, 2, w.id, at(s, 30, 15)).ok).toBe(true);
    expect(moveWarship(s, 1, w.id, at(s, 30, 15)).ok).toBe(false); // not yours
    expect(moveWarship(s, 2, w.id, at(s, 10, 15)).ok).toBe(false); // inland
    runUntil(s, () => w.state === 0, 400);
    expect(w.cargo).toBe(at(s, 30, 15));
    runUntil(s, () => false, 300);
    const dx = w.x - 30;
    const dy = w.y - 15;
    expect(Math.sqrt(dx * dx + dy * dy)).toBeLessThanOrEqual(16);
  });

  it('sinks an enemy transport; the troops aboard die', () => {
    const s = seaGame();
    giveTech(s, 2, 'navigation');
    const port = addBuilding(s, 'port', 2, at(s, 50, 10));
    buildWarship(s, 2, port.tile);
    const w = unitsOf(s, 'warship')[0];
    moveWarship(s, 2, w.id, at(s, 35, 18));
    runUntil(s, () => w.state === 0, 400);

    expect(launchTransport(s, 1, -1, at(s, 50, 18), inf(1000)).ok).toBe(true);
    runUntil(s, () => unitsOf(s, 'transport').length === 0, 600);
    expect(unitsOf(s, 'transport').length).toBe(0);
    expect(s.attacks.some((a) => a.attacker === 1)).toBe(false);
    expect(s.map.owner[at(s, 50, 18)]).toBe(2);
    expect(s.players[1].stats.troopsLost).toBeCloseTo(1000);
    expect(s.players[2].stats.troopsKilled).toBeCloseTo(1000);
    expect(s.events.some((e) => e.kind === 'unitLost' && e.players.includes(1))).toBe(true);
  });

  it('leaves allied ships alone', () => {
    const s = seaGame();
    giveTech(s, 2, 'navigation');
    const port = addBuilding(s, 'port', 2, at(s, 50, 10));
    buildWarship(s, 2, port.tile);
    const w = unitsOf(s, 'warship')[0];
    moveWarship(s, 2, w.id, at(s, 35, 18));
    runUntil(s, () => w.state === 0, 400);
    // Player 1 lands on neutral coast at the far end while allied with the warship owner.
    s.map.owner[at(s, 50, 18)] = 0;
    s.players[2].tiles--;
    formAlliance(s, 1, 2);
    const t = launchTransport(s, 1, -1, at(s, 50, 18), inf(500));
    expect(t.ok).toBe(true);
    const tr = unitsOf(s, 'transport')[0];
    runUntil(s, () => tr.hp <= 0 || !s.units.includes(tr), 600);
    expect(s.players[1].stats.troopsLost).toBeLessThan(500); // landed (paid a neutral tile), not sunk
    expect(s.map.owner[at(s, 50, 18)]).toBe(1);
  });

  it('bombards enemy coast troops only while at war', () => {
    const s = seaGame();
    giveTech(s, 1, 'navigation');
    const port = addBuilding(s, 'port', 1, at(s, 19, 15));
    buildWarship(s, 1, port.tile);
    const w = unitsOf(s, 'warship')[0];
    moveWarship(s, 1, w.id, at(s, 47, 15));
    runUntil(s, () => w.state === 0, 400);
    // Keep it on station: patrol centre right at the coast.
    w.path = [at(s, 49, 15)];
    w.pathPos = 1;
    w.x = 49;
    w.y = 15;
    w.cargo = at(s, 49, 15);
    const before = troopSum(s.players[2].troops);
    runUntil(s, () => false, 10);
    expect(troopSum(s.players[2].troops)).toBe(before);

    s.attacks.push({ id: newId(s), attacker: 1, target: 2, troops: inf(100), focusTile: at(s, 50, 15), progress: 0, startTick: s.tick, amphibious: false, losses: 0, tilesTaken: 0 });
    w.path = [at(s, 49, 15)];
    w.pathPos = 1;
    w.x = 49;
    w.y = 15;
    s.rng = () => 0.99; // no wandering off this time
    runUntil(s, () => false, 10);
    expect(before - troopSum(s.players[2].troops)).toBeCloseTo(WARSHIP_BOMBARD_KILL, 5);
  });
});

describe('trade ships', () => {
  it('sail between ports and pay both owners by path length', () => {
    const s = seaGame();
    const port1 = addBuilding(s, 'port', 1, at(s, 19, 15));
    const port2 = addBuilding(s, 'port', 2, at(s, 50, 15));
    port1.cooldown = 0.05;
    port2.cooldown = 1000;
    runUntil(s, () => unitsOf(s, 'tradeShip').length > 0, 5);
    const [ship] = unitsOf(s, 'tradeShip');
    expect(ship.owner).toBe(1);
    expect(ship.targetOwner).toBe(2);
    const pay = ship.path.length * TRADE_GOLD_PER_TILE;
    expect(ship.cargo).toBeCloseTo(pay);

    // Only one at sea per port.
    port1.cooldown = 0.05;
    runUntil(s, () => false, 3);
    expect(unitsOf(s, 'tradeShip').length).toBe(1);

    const g1 = s.players[1].gold;
    const g2 = s.players[2].gold;
    runUntil(s, () => unitsOf(s, 'tradeShip').length === 0, 400);
    expect(unitsOf(s, 'tradeShip').length).toBe(0);
    expect(s.players[1].gold - g1).toBeCloseTo(pay);
    expect(s.players[2].gold - g2).toBeCloseTo(pay);
    expect(s.players[1].stats.goldEarned).toBeCloseTo(pay);
    expect(s.players[2].stats.goldEarned).toBeCloseTo(pay);
  });

  it('do not sail under an embargo', () => {
    const s = seaGame();
    const port1 = addBuilding(s, 'port', 1, at(s, 19, 15));
    addBuilding(s, 'port', 2, at(s, 50, 15)).cooldown = 1000;
    toggleEmbargo(s, 2, 1);
    port1.cooldown = 0.05;
    runUntil(s, () => false, 5);
    expect(unitsOf(s, 'tradeShip').length).toBe(0);
  });
});

describe('aircraft', () => {
  function airGame(): { s: GameState; airfield: Building } {
    const s = seaGame();
    giveTech(s, 1, 'flight');
    const airfield = addBuilding(s, 'airfield', 1, at(s, 5, 15));
    expect(buildAircraft(s, 1, airfield.tile, 'bomber').ok).toBe(true);
    return { s, airfield };
  }

  it('building aircraft needs Flight, pays, and respects the airfield limit', () => {
    const s = seaGame();
    const af = addBuilding(s, 'airfield', 1, at(s, 5, 15));
    expect(buildAircraft(s, 1, af.tile, 'fighter').ok).toBe(false);
    giveTech(s, 1, 'flight');
    expect(buildAircraft(s, 1, af.tile, 'fighter').ok).toBe(true);
    expect(s.players[1].gold).toBe(100000 - UNITS.fighter.gold);
    expect(s.players[1].oil).toBe(10000 - UNITS.fighter.oil);
    for (let k = 1; k < AIRCRAFT_MAX_PER_AIRFIELD; k++) expect(buildAircraft(s, 1, af.tile, 'bomber').ok).toBe(true);
    expect(buildAircraft(s, 1, af.tile, 'bomber').ok).toBe(false);
    expect(af.fighters + af.bombers).toBe(AIRCRAFT_MAX_PER_AIRFIELD);
  });

  it('a bomber destroys buildings, kills troops and flies home', () => {
    const { s, airfield } = airGame();
    s.rng = () => 0; // every bomb hits
    const targets = [at(s, 55, 15), at(s, 55, 17), at(s, 57, 15)].map((t) => addBuilding(s, 'farm', 2, t));
    const far = addBuilding(s, 'farm', 2, at(s, 55, 25));
    expect(launchBomber(s, 1, airfield.tile, at(s, 5, 5)).ok).toBe(false); // own land
    expect(launchBomber(s, 1, airfield.tile, at(s, 55, 15)).ok).toBe(true);
    expect(airfield.bombers).toBe(0);
    expect(launchBomber(s, 1, airfield.tile, at(s, 55, 15)).ok).toBe(false); // none left
    const army = troopSum(s.players[2].troops);

    runUntil(s, () => s.units.length === 0);
    for (const b of targets) expect(s.buildings.has(b.id)).toBe(false);
    expect(s.buildings.has(far.id)).toBe(true);
    expect(army - troopSum(s.players[2].troops)).toBeGreaterThanOrEqual(BOMBER_MIN_KILL - 1e-6);
    expect(airfield.bombers).toBe(1);
    expect(s.events.some((e) => e.kind === 'bombing' && e.players.includes(2))).toBe(true);
  });

  it('a SAM can shoot a bomber down (and reloads)', () => {
    const { s, airfield } = airGame();
    giveTech(s, 2, 'flight', 'radar');
    const sam = addBuilding(s, 'sam', 2, at(s, 52, 15));
    const farm = addBuilding(s, 'farm', 2, at(s, 55, 15));
    s.rng = () => 0; // the SAM hits
    launchBomber(s, 1, airfield.tile, farm.tile);
    runUntil(s, () => s.units.length === 0);
    expect(s.buildings.has(farm.id)).toBe(true);
    expect(airfield.bombers).toBe(0);
    expect(sam.cooldown).toBeGreaterThan(0);
    expect(s.events.some((e) => e.kind === 'unitLost' && e.players.includes(1) && e.players.includes(2))).toBe(true);
  });

  it('a bomber that is not hit survives a SAM and comes home', () => {
    const { s, airfield } = airGame();
    addBuilding(s, 'sam', 2, at(s, 52, 15));
    const farm = addBuilding(s, 'farm', 2, at(s, 55, 15));
    s.rng = () => 0.99; // SAM misses, bombs miss
    launchBomber(s, 1, airfield.tile, farm.tile);
    runUntil(s, () => s.units.length === 0);
    expect(s.buildings.has(farm.id)).toBe(true);
    expect(airfield.bombers).toBe(1);
  });

  it('fighters intercept: more fighters, better odds', () => {
    for (const [fighters, shot] of [[1, false], [2, true]] as const) {
      const { s, airfield } = airGame();
      const enemyField = addBuilding(s, 'airfield', 2, at(s, 55, 5));
      enemyField.fighters = fighters;
      const farm = addBuilding(s, 'farm', 2, at(s, 55, 15));
      s.rng = () => 0.7; // 1 fighter: 50% (miss); 2 fighters: 75% (hit); bombs miss either way
      launchBomber(s, 1, airfield.tile, farm.tile);
      runUntil(s, () => s.units.length === 0);
      expect(airfield.bombers).toBe(shot ? 0 : 1);
      expect(enemyField.fighters).toBe(fighters); // fighters are not used up
    }
  });

  it('a bomber whose airfield is gone is lost', () => {
    const { s, airfield } = airGame();
    const farm = addBuilding(s, 'farm', 2, at(s, 55, 15));
    launchBomber(s, 1, airfield.tile, farm.tile);
    s.buildings.delete(airfield.id);
    s.map.building[airfield.tile] = 0;
    markBuildingsChanged(s);
    runUntil(s, () => s.units.length === 0);
    expect(s.units.length).toBe(0);
    expect(s.events.some((e) => e.kind === 'unitLost' && e.message.includes('airfield'))).toBe(true);
  });
});

describe('missiles', () => {
  function siloGame(players = 2): { s: GameState; silo: Building } {
    const s = seaGame(players);
    const silo = addBuilding(s, 'silo', 1, at(s, 5, 5));
    return { s, silo };
  }

  it('tech gates, silo checks and no firing at allies', () => {
    const { s, silo } = siloGame();
    expect(launchMissile(s, 1, silo.tile, 'rocket', at(s, 55, 15)).ok).toBe(false);
    giveTech(s, 1, 'rocketry');
    expect(launchMissile(s, 1, silo.tile, 'atomBomb', at(s, 55, 15)).ok).toBe(false);
    expect(launchMissile(s, 1, at(s, 6, 6), 'rocket', at(s, 55, 15)).ok).toBe(false); // no silo there
    expect(launchMissile(s, 1, silo.tile, 'rocket', at(s, 10, 10)).ok).toBe(false); // own land
    formAlliance(s, 1, 2);
    expect(launchMissile(s, 1, silo.tile, 'rocket', at(s, 55, 15)).ok).toBe(false);
  });

  it('rocket: destroys buildings, kills troops, silo reloads', () => {
    const { s, silo } = siloGame();
    giveTech(s, 1, 'rocketry');
    const near = [at(s, 55, 15), at(s, 57, 16)].map((t) => addBuilding(s, 'farm', 2, t));
    const far = addBuilding(s, 'farm', 2, at(s, 55, 25));
    const army = troopSum(s.players[2].troops);
    expect(launchMissile(s, 1, silo.tile, 'rocket', at(s, 55, 15)).ok).toBe(true);
    expect(s.players[1].gold).toBe(100000 - UNITS.rocket.gold);
    expect(silo.cooldown).toBe(SILO_COOLDOWN);
    expect(launchMissile(s, 1, silo.tile, 'rocket', at(s, 55, 15)).ok).toBe(false); // reloading

    runUntil(s, () => s.units.length === 0);
    for (const b of near) expect(s.buildings.has(b.id)).toBe(false);
    expect(s.buildings.has(far.id)).toBe(true);
    expect(army - troopSum(s.players[2].troops)).toBeGreaterThanOrEqual(ROCKET_KILL_MIN - 1e-6);
    expect(s.effects.some((e) => e.kind === 'explosion')).toBe(true);

    runUntil(s, () => silo.cooldown <= 0, SILO_COOLDOWN * 10 + 5);
    expect(launchMissile(s, 1, silo.tile, 'rocket', at(s, 55, 15)).ok).toBe(true);
  });

  it('a SAM can intercept a rocket', () => {
    const { s, silo } = siloGame();
    giveTech(s, 1, 'rocketry');
    addBuilding(s, 'sam', 2, at(s, 52, 15));
    const farm = addBuilding(s, 'farm', 2, at(s, 55, 15));
    s.rng = () => 0;
    launchMissile(s, 1, silo.tile, 'rocket', farm.tile);
    runUntil(s, () => s.units.length === 0);
    expect(s.buildings.has(farm.id)).toBe(true);
  });

  it('atom bomb: wipes buildings, kills most of the army there, neutral core with fallout, opinions drop', () => {
    const { s, silo } = siloGame(3);
    giveTech(s, 1, 'rocketry', 'nuclearFission');
    const centre = at(s, 55, 15);
    const farm = addBuilding(s, 'farm', 2, at(s, 52, 20));
    const own = addBuilding(s, 'farm', 1, at(s, 10, 15)); // far away: untouched
    const army = troopSum(s.players[2].troops);
    expect(launchMissile(s, 1, silo.tile, 'atomBomb', centre).ok).toBe(true);
    runUntil(s, () => s.units.length === 0);

    expect(s.buildings.has(farm.id)).toBe(false);
    expect(s.buildings.has(own.id)).toBe(true);
    expect(s.map.owner[centre]).toBe(0);
    expect(s.map.fallout[centre]).toBeGreaterThan(FALLOUT_SECONDS - 1);
    expect(s.map.owner[at(s, 59, 0)]).toBe(2); // outside the core
    const left = troopSum(s.players[2].troops) / army;
    expect(left).toBeGreaterThanOrEqual(0.1 - 1e-9);
    expect(left).toBeLessThanOrEqual(0.4 + 1e-9);
    expect(s.opinion[2][1]).toBe(-NUKE_OPINION_PENALTY);
    expect(s.opinion[3][1]).toBe(-NUKE_OPINION_PENALTY);
    expect(s.events.some((e) => e.kind === 'nuke' && e.players.length === 0)).toBe(true);
    expect(s.effects.some((e) => e.kind === 'nuke')).toBe(true);

    const f = s.map.fallout[centre];
    runUntil(s, () => false, 10);
    expect(s.map.fallout[centre]).toBeCloseTo(f - 1, 4);
  });
});

describe('watchtowers and cleanup', () => {
  it('warn a human once about an incoming enemy bomber', () => {
    const s = seaGame(2, { human: true });
    addBuilding(s, 'watchtower', 1, at(s, 15, 15));
    giveTech(s, 2, 'flight');
    const af = addBuilding(s, 'airfield', 2, at(s, 55, 15));
    af.bombers = 1;
    s.rng = () => 0.99;
    expect(launchBomber(s, 2, af.tile, at(s, 10, 15)).ok).toBe(true);
    runUntil(s, () => s.units.length === 0);
    const warnings = s.events.filter((e) => e.message.startsWith('Watchtower') && e.players.includes(1));
    expect(warnings.length).toBe(1);
    expect(warnings[0].kind).toBe('underAttack');
  });

  it('drops units of eliminated players', () => {
    const s = seaGame();
    launchTransport(s, 1, -1, at(s, 50, 15), inf(500));
    expect(s.units.length).toBe(1);
    s.players[1].alive = false;
    updateUnits(s);
    expect(s.units.length).toBe(0);
  });
});
