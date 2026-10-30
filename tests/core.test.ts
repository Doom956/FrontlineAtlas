// Core simulation tests: rng, grid, mapgen, spawning, ownership, diplomacy, actions, victory, tick.
import { describe, expect, it } from 'vitest';
import { applyAction } from '../src/sim/actions';
import { ALLIANCE_DURATION, ALLIANCE_REQUEST_TIMEOUT, MAX_EVENTS, SPAWN_SECONDS, START_GOLD, START_TROOPS, TICKS_PER_SECOND } from '../src/sim/config';
import { areAllied, breakAlliance, canTrade, changeOpinion, gift, isTraitor, requestAlliance, answerAlliance, toggleEmbargo, updateDiplomacy } from '../src/sim/diplomacy';
import { distanceField, forEachInRadius, nearestTile, neighbors4, waterPath } from '../src/sim/grid';
import { computeCoastAndLand, createMapData, generateMap } from '../src/sim/mapgen';
import { makeRng } from '../src/sim/rng';
import { tick } from '../src/sim/sim';
import { addEvent, canSpawnAt, createGame, setOwner, spawnMinDistance, spawnPlayer, spawnRadius } from '../src/sim/state';
import { score, updateVictory } from '../src/sim/victory';
import { Resource, Terrain, isWater } from '../src/sim/types';
import type { Action, Attack, Building, BuildingType, GameState, MapType } from '../src/sim/types';
import { claimRect, makeFlatGame, makeTestGame, testSettings, troopSum } from './helpers';

function addBuilding(state: GameState, owner: number, tile: number, type: BuildingType, level = 1): Building {
  const id = state.nextId++;
  const b: Building = { id, type, owner, tile, level, buildLeft: 0, upgradeLeft: 0, fighters: 0, bombers: 0, cooldown: 0, dropCooldown: 0, disabledUntil: 0, hp: 1 };
  state.buildings.set(id, b);
  state.map.building[tile] = id + 1;
  return b;
}
function addAttack(state: GameState, attacker: number, target: number, infantry: number): Attack {
  const a: Attack = {
    id: state.nextId++,
    attacker,
    target,
    troops: { infantry, armor: 0, artillery: 0 },
    focusTile: 0,
    progress: 0,
    startTick: state.tick,
    amphibious: false,
    losses: 0,
    tilesTaken: 0,
  };
  state.attacks.push(a);
  return a;
}

describe('rng', () => {
  it('is deterministic and in [0,1)', () => {
    const a = makeRng(42);
    const b = makeRng(42);
    for (let k = 0; k < 1000; k++) {
      const v = a.rng();
      expect(v).toBe(b.rng());
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
    expect(makeRng(43).rng()).not.toBe(makeRng(42).rng());
  });
  it('can be resumed from its state', () => {
    const a = makeRng(7);
    for (let k = 0; k < 10; k++) a.rng();
    const b = makeRng(a.state.s);
    for (let k = 0; k < 10; k++) expect(b.rng()).toBe(a.rng());
  });
  it('is roughly uniform', () => {
    const { rng } = makeRng(1);
    let sum = 0;
    for (let k = 0; k < 10000; k++) sum += rng();
    expect(sum / 10000).toBeGreaterThan(0.48);
    expect(sum / 10000).toBeLessThan(0.52);
  });
});

describe('grid', () => {
  const map = createMapData(10, 8);
  it('neighbors4 respects edges', () => {
    const out: number[] = [];
    expect(neighbors4(map, 0, out)).toBe(2);
    expect(neighbors4(map, 9, out)).toBe(2);
    expect(neighbors4(map, 15, out)).toBe(4);
    expect(out.slice(0, 4).sort((x, y) => x - y)).toEqual([5, 14, 16, 25]);
  });
  it('forEachInRadius visits the disc', () => {
    let count = 0;
    forEachInRadius(map, 4 * 10 + 5, 1, () => count++);
    expect(count).toBe(5);
    count = 0;
    forEachInRadius(map, 0, 2, (_, d) => {
      expect(d).toBeLessThanOrEqual(2);
      count++;
    });
    expect(count).toBe(6); // (0,0) (1,0) (2,0) (0,1) (1,1) (0,2)
  });
  it('distanceField is a 4-neighbour BFS with a cap', () => {
    const d = distanceField(map, [0], () => true, 5);
    expect(d[0]).toBe(0);
    expect(d[1]).toBe(1);
    expect(d[11]).toBe(2);
    expect(d[3 * 10 + 2]).toBe(5);
    expect(d[3 * 10 + 3]).toBe(65535); // distance 6 > cap
    const blocked = distanceField(map, [0], (i) => i % 10 !== 2, 100);
    expect(blocked[3]).toBe(65535);
  });
  it('nearestTile finds the closest match', () => {
    const target = 7 * 10 + 9;
    expect(nearestTile(map, 0, 20, (i) => i === target)).toBe(target);
    expect(nearestTile(map, 0, 3, (i) => i === target)).toBe(-1);
    // two candidates: (3,0) at distance 3 and (2,2) at distance 2.83
    expect(nearestTile(map, 0, 10, (i) => i === 3 || i === 22)).toBe(22);
  });
  it('waterPath follows water and returns null when cut off', () => {
    // Land column at x=0 and x=9, water in between; a land wall at y=4 with a gap at x=8.
    const m = createMapData(10, 8);
    for (let y = 0; y < 8; y++) {
      m.terrain[y * 10] = Terrain.Plains;
      m.terrain[y * 10 + 9] = Terrain.Plains;
    }
    for (let x = 1; x < 8; x++) m.terrain[4 * 10 + x] = Terrain.Plains;
    computeCoastAndLand(m);
    const from = 1 * 10 + 0; // land (0,1)
    const to = 6 * 10 + 0; // land (0,6)
    const path = waterPath(m, from, to)!;
    expect(path).not.toBeNull();
    for (const i of path) expect(isWater(m.terrain[i])).toBe(true);
    expect(path).toContain(4 * 10 + 8); // through the gap
    expect(path[0] % 10).toBe(1);
    expect(path[path.length - 1]).toBe(6 * 10 + 1);
    // close the gap
    m.terrain[4 * 10 + 8] = Terrain.Plains;
    expect(waterPath(m, from, to)).toBeNull();
    // land tile with no water around
    expect(waterPath(m, from, 4 * 10 + 4)).not.toBeNull(); // wall tile touches water above
  });
});

describe('mapgen', () => {
  const targets: Record<MapType, [number, number]> = {
    continents: [0.4, 0.5],
    pangaea: [0.55, 0.65],
    archipelago: [0.25, 0.35],
    highlands: [0.5, 0.6],
  };
  for (const mapType of Object.keys(targets) as MapType[]) {
    it(`${mapType}: land share, counts, coast, resources`, () => {
      const settings = testSettings({ mapType, seed: 99 });
      const map = generateMap(settings, makeRng(99).rng);
      const n = map.width * map.height;
      expect(map.width).toBe(900);
      expect(map.height).toBe(560);
      let land = 0;
      let hillsMountains = 0;
      let errors = 0; // counted instead of expect() per tile, which is slow on 60k tiles
      for (let i = 0; i < n; i++) {
        const t = map.terrain[i];
        if (t > 8) errors++;
        if (!isWater(t)) land++;
        if (t === Terrain.Hills || t === Terrain.Mountains) hillsMountains++;
        // coastal flag: land touching water (4-neighbour)
        const x = i % map.width;
        const y = (i / map.width) | 0;
        const nb = [x > 0 ? i - 1 : -1, x < map.width - 1 ? i + 1 : -1, y > 0 ? i - map.width : -1, y < map.height - 1 ? i + map.width : -1];
        const touches = nb.some((j) => j >= 0 && isWater(map.terrain[j]));
        if (map.coastal[i] !== (!isWater(t) && touches ? 1 : 0)) errors++;
        // resources on matching terrain
        const r = map.resource[i];
        if (r === Resource.Iron && t !== Terrain.Hills && t !== Terrain.Mountains) errors++;
        if (r === Resource.Oil && t !== Terrain.Desert && t !== Terrain.Swamp && t !== Terrain.Tundra) errors++;
        if (r === Resource.Fertile && t !== Terrain.Plains) errors++;
        if (map.owner[i] !== 0) errors++;
      }
      expect(errors).toBe(0);
      expect(map.landTileCount).toBe(land);
      const share = land / n;
      expect(share).toBeGreaterThanOrEqual(targets[mapType][0]);
      expect(share).toBeLessThanOrEqual(targets[mapType][1]);
      // map border is water
      for (let x = 0; x < map.width; x++) {
        expect(isWater(map.terrain[x])).toBe(true);
        expect(isWater(map.terrain[n - 1 - x])).toBe(true);
      }
      // highlands are rugged
      if (mapType === 'highlands') expect(hillsMountains / land).toBeGreaterThan(0.35);
      // some of each resource
      const counts = [0, 0, 0, 0];
      for (let i = 0; i < n; i++) counts[map.resource[i]]++;
      expect(counts[Resource.Iron]).toBeGreaterThan(land * 0.01);
      expect(counts[Resource.Oil]).toBeGreaterThan(land * 0.005);
      expect(counts[Resource.Fertile]).toBeGreaterThan(0);
    });
  }
  it('shallow water borders the coast', () => {
    const map = generateMap(testSettings({ seed: 3 }), makeRng(3).rng);
    for (let i = 0; i < map.width * map.height; i++) {
      if (!map.coastal[i]) continue;
      const out: number[] = [];
      const k = neighbors4(map, i, out);
      for (let q = 0; q < k; q++) if (isWater(map.terrain[out[q]])) expect(map.terrain[out[q]]).toBe(Terrain.ShallowWater);
    }
  });
  it('is deterministic by seed', () => {
    const a = generateMap(testSettings({ seed: 5 }), makeRng(5).rng);
    const b = generateMap(testSettings({ seed: 5 }), makeRng(5).rng);
    const c = generateMap(testSettings({ seed: 6 }), makeRng(6).rng);
    expect(a.terrain).toEqual(b.terrain);
    expect(a.resource).toEqual(b.resource);
    expect(a.terrain).not.toEqual(c.terrain);
  });
});

describe('createGame and spawning', () => {
  it('creates players, opinion matrix and spawn phase', () => {
    const s = createGame(testSettings({ aiCount: 5 }));
    expect(s.players.length).toBe(7);
    expect(s.players[0].alive).toBe(false);
    expect(s.humanId).toBe(1);
    expect(s.players[1].isHuman).toBe(true);
    expect(s.players[1].name).toBe('Tester');
    expect(s.players[1].personality).toBeNull();
    for (let id = 2; id < 7; id++) {
      expect(s.players[id].isHuman).toBe(false);
      expect(s.players[id].personality).not.toBeNull();
      expect(s.players[id].gold).toBe(START_GOLD);
      expect(s.players[id].troops).toEqual({ infantry: 0, armor: 0, artillery: 0 }); // troops come with the spawn
    }
    expect(s.opinion.length).toBe(7);
    expect(s.opinion[3].length).toBe(7);
    expect(s.phase).toBe('spawn');
    expect(s.spawnLeft).toBe(SPAWN_SECONDS);
    expect(new Set(s.players.slice(1).map((p) => p.name)).size).toBe(6);
  });
  it('AI-only game has no human', () => {
    const s = createGame(testSettings({ humanPlayer: false, aiCount: 4 }));
    expect(s.humanId).toBe(0);
    expect(s.players.length).toBe(5);
    expect(s.players.every((p) => !p.isHuman)).toBe(true);
  });
  it('same seed gives the same game', () => {
    const a = makeTestGame();
    const b = makeTestGame();
    expect(a.map.owner).toEqual(b.map.owner);
    expect(a.players.map((p) => p.personality)).toEqual(b.players.map((p) => p.personality));
    expect(a.rngState.s).toBe(b.rngState.s);
  });
  it('spawn rules and re-spawn', () => {
    const s = makeFlatGame(60, 40, 2);
    s.phase = 'spawn';
    for (const p of s.players) p.spawned = false;
    const t1 = 20 * 60 + 20;
    expect(spawnPlayer(s, 1, t1)).toBe(true);
    const p1 = s.players[1];
    expect(p1.capital).toBe(t1);
    expect(p1.spawned).toBe(true);
    expect(spawnRadius(s)).toBe(5); // small map
    expect(p1.tiles).toBe(81); // radius-5 disc on open land
    expect(p1.troops.infantry).toBe(START_TROOPS);
    // too close to player 1's capital, or on its land
    expect(spawnMinDistance(s)).toBe(17);
    expect(canSpawnAt(s, 2, t1 + 5)).toBe(false);
    expect(canSpawnAt(s, 2, t1 + 16)).toBe(false);
    expect(canSpawnAt(s, 2, t1 + 17)).toBe(true);
    // re-spawn moves the start
    const t2 = 20 * 60 + 45;
    expect(applyAction(s, 1, { type: 'spawn', tile: t2 }).ok).toBe(true);
    expect(s.map.owner[t1]).toBe(0);
    expect(s.map.owner[t2]).toBe(1);
    expect(p1.tiles).toBe(81);
    let owned = 0;
    for (let i = 0; i < s.map.owner.length; i++) if (s.map.owner[i] === 1) owned++;
    expect(owned).toBe(81);
    // water and fallout are invalid
    s.map.terrain[5] = Terrain.DeepWater;
    expect(canSpawnAt(s, 2, 5)).toBe(false);
    s.map.fallout[6] = 10;
    expect(canSpawnAt(s, 2, 6)).toBe(false);
    // not after the spawn phase
    s.phase = 'playing';
    expect(applyAction(s, 2, { type: 'spawn', tile: 10 * 60 + 5 }).ok).toBe(false);
  });
  it('spawn does not cross water', () => {
    const s = makeFlatGame(30, 30, 1);
    s.phase = 'spawn';
    s.players[1].spawned = false;
    for (let y = 0; y < 30; y++) s.map.terrain[y * 30 + 16] = Terrain.DeepWater;
    expect(spawnPlayer(s, 1, 15 * 30 + 14)).toBe(true);
    for (let y = 0; y < 30; y++) for (let x = 17; x < 30; x++) expect(s.map.owner[y * 30 + x]).toBe(0);
  });
  it('makeTestGame spawns everyone far enough apart', () => {
    const s = makeTestGame({ aiCount: 7 });
    expect(s.phase).toBe('playing');
    const w = s.map.width;
    for (const p of s.players.slice(1)) {
      expect(p.spawned).toBe(true);
      expect(p.tiles).toBeGreaterThan(0);
      expect(s.map.owner[p.capital]).toBe(p.id);
      for (const q of s.players.slice(1)) {
        if (q.id <= p.id) continue;
        const dx = (p.capital % w) - (q.capital % w);
        const dy = ((p.capital / w) | 0) - ((q.capital / w) | 0);
        expect(Math.hypot(dx, dy)).toBeGreaterThanOrEqual(12);
      }
    }
  });
});

describe('setOwner', () => {
  it('keeps tile counts in sync', () => {
    const s = makeFlatGame(20, 20, 2);
    claimRect(s, 1, 0, 0, 4, 4);
    claimRect(s, 2, 10, 10, 14, 14);
    expect(s.players[1].tiles).toBe(25);
    setOwner(s, 0, 2);
    expect(s.players[1].tiles).toBe(24);
    expect(s.players[2].tiles).toBe(26);
    expect(s.players[2].stats.tilesCaptured).toBe(26);
    setOwner(s, 0, 2); // no-op
    expect(s.players[2].tiles).toBe(26);
    setOwner(s, 0, 0);
    expect(s.players[2].tiles).toBe(25);
  });
  it('captures capturable buildings, destroys the rest', () => {
    const s = makeFlatGame(20, 20, 2);
    claimRect(s, 1, 0, 0, 9, 9);
    claimRect(s, 2, 10, 0, 19, 9);
    const market = addBuilding(s, 1, 2 * 20 + 2, 'market');
    const silo = addBuilding(s, 1, 5 * 20 + 5, 'silo');
    setOwner(s, market.tile, 2);
    expect(market.owner).toBe(2);
    expect(s.buildings.has(market.id)).toBe(true);
    setOwner(s, silo.tile, 2);
    expect(s.buildings.has(silo.id)).toBe(false);
    expect(s.map.building[silo.tile]).toBe(0);
    // neutral takeover destroys even capturable buildings
    setOwner(s, market.tile, 0);
    expect(s.buildings.has(market.id)).toBe(false);
    expect(s.events.some((e) => e.kind === 'buildingCaptured')).toBe(true);
    expect(s.events.some((e) => e.kind === 'buildingLost')).toBe(true);
  });
  it('moves a lost capital to the biggest city and costs 30% gold', () => {
    const s = makeFlatGame(20, 20, 2);
    claimRect(s, 1, 0, 0, 9, 9);
    claimRect(s, 2, 10, 0, 19, 9);
    const p1 = s.players[1];
    p1.capital = 0;
    p1.gold = 1000;
    const small = addBuilding(s, 1, 3 * 20 + 3, 'city', 1);
    const big = addBuilding(s, 1, 7 * 20 + 7, 'city', 3);
    setOwner(s, 0, 2);
    expect(p1.capital).toBe(big.tile);
    expect(p1.gold).toBeCloseTo(700);
    expect(s.events.some((e) => e.kind === 'capitalLost')).toBe(true);
    // big city captured: next biggest city
    setOwner(s, big.tile, 2);
    expect(p1.capital).toBe(small.tile);
    // no city left: nearest owned tile
    setOwner(s, small.tile, 2);
    expect(s.map.owner[p1.capital]).toBe(1);
    const d = Math.hypot((p1.capital % 20) - 3, ((p1.capital / 20) | 0) - 3);
    expect(d).toBeLessThanOrEqual(1);
  });
  it('eliminates a player whose last tile is taken', () => {
    const s = makeFlatGame(20, 20, 3);
    claimRect(s, 1, 0, 0, 1, 0); // 2 tiles
    claimRect(s, 2, 5, 5, 9, 9);
    claimRect(s, 3, 12, 12, 15, 15);
    addBuilding(s, 1, 0, 'farm');
    const own = addAttack(s, 1, 2, 500);
    const against = addAttack(s, 3, 1, 400);
    s.units.push({ id: s.nextId++, type: 'transport', owner: 1, x: 0, y: 0, target: 0, home: 0, path: [], pathPos: 0, troops: { infantry: 100, armor: 0, artillery: 0 }, hp: 1, cargo: 0, state: 0, targetOwner: 0 });
    requestAlliance(s, 1, 2);
    const inf3 = s.players[3].troops.infantry;
    setOwner(s, 0, 3);
    expect(s.players[1].alive).toBe(true);
    setOwner(s, 1, 3);
    const p1 = s.players[1];
    expect(p1.alive).toBe(false);
    expect(p1.tiles).toBe(0);
    expect(p1.eliminatedTick).toBe(s.tick);
    expect(troopSum(own.troops)).toBe(0);
    expect(troopSum(against.troops)).toBe(0);
    expect(s.players[3].troops.infantry).toBe(inf3 + 400);
    expect(s.allianceRequests.length).toBe(0);
    expect(s.events.some((e) => e.kind === 'eliminated')).toBe(true);
    // the farm tile was captured by 3 (capturable), nothing of player 1 is left
    for (const b of s.buildings.values()) expect(b.owner).not.toBe(1);
    // tick prunes the neutralised attacks and units
    tick(s);
    expect(s.attacks.some((a) => a.attacker === 1 || a.target === 1)).toBe(false);
    expect(s.units.some((u) => u.owner === 1)).toBe(false);
  });
});

describe('diplomacy', () => {
  it('alliance lifecycle: request, accept, expire', () => {
    const s = makeFlatGame(20, 20, 3);
    expect(requestAlliance(s, 1, 2).ok).toBe(true);
    expect(requestAlliance(s, 1, 2).ok).toBe(false); // duplicate
    expect(requestAlliance(s, 1, 1).ok).toBe(false);
    expect(s.events.some((e) => e.kind === 'allianceRequest' && e.players.includes(2))).toBe(true);
    const atk = addAttack(s, 2, 1, 300);
    const inf2 = s.players[2].troops.infantry;
    expect(answerAlliance(s, 2, 1, true).ok).toBe(true);
    expect(areAllied(s, 1, 2)).toBe(true);
    expect(areAllied(s, 2, 1)).toBe(true);
    expect(areAllied(s, 1, 3)).toBe(false);
    expect(s.attacks.includes(atk)).toBe(false);
    expect(s.players[2].troops.infantry).toBe(inf2 + 300);
    expect(requestAlliance(s, 1, 2).ok).toBe(false); // already allied
    // expiry
    s.tick += ALLIANCE_DURATION * TICKS_PER_SECOND;
    updateDiplomacy(s);
    expect(areAllied(s, 1, 2)).toBe(false);
    expect(s.events.some((e) => e.kind === 'allianceExpired')).toBe(true);
  });
  it('rejects requests during a war, expires unanswered ones, mutual requests form an alliance', () => {
    const s = makeFlatGame(20, 20, 3);
    addAttack(s, 1, 3, 100);
    expect(requestAlliance(s, 3, 1).ok).toBe(false);
    expect(requestAlliance(s, 1, 2).ok).toBe(true);
    s.tick += ALLIANCE_REQUEST_TIMEOUT * TICKS_PER_SECOND;
    updateDiplomacy(s);
    expect(s.allianceRequests.length).toBe(0);
    expect(answerAlliance(s, 2, 1, true).ok).toBe(false);
    expect(requestAlliance(s, 1, 2).ok).toBe(true);
    expect(requestAlliance(s, 2, 1).ok).toBe(true);
    expect(areAllied(s, 1, 2)).toBe(true);
  });
  it('breaking makes a traitor and drops opinions', () => {
    const s = makeFlatGame(20, 20, 3);
    requestAlliance(s, 1, 2);
    answerAlliance(s, 2, 1, true);
    const before2 = s.opinion[2][1];
    const before3 = s.opinion[3][1];
    expect(breakAlliance(s, 1, 2).ok).toBe(true);
    expect(areAllied(s, 1, 2)).toBe(false);
    expect(isTraitor(s, 1)).toBe(true);
    expect(s.opinion[2][1]).toBeLessThan(before2 - 40);
    expect(s.opinion[3][1]).toBeLessThan(before3);
    expect(breakAlliance(s, 1, 2).ok).toBe(false);
  });
  it('opinion is clamped and drifts toward 0', () => {
    const s = makeFlatGame(20, 20, 2);
    changeOpinion(s, 1, 2, 500);
    expect(s.opinion[1][2]).toBe(100);
    changeOpinion(s, 1, 2, -500);
    expect(s.opinion[1][2]).toBe(-100);
    s.tick = 10;
    updateDiplomacy(s);
    expect(s.opinion[1][2]).toBeGreaterThan(-100);
  });
  it('gift and embargo', () => {
    const s = makeFlatGame(20, 20, 2);
    const g1 = s.players[1].gold;
    expect(gift(s, 1, 2, 200, 100).ok).toBe(true);
    expect(s.players[1].gold).toBe(g1 - 200);
    expect(s.players[2].troops.infantry).toBe(START_TROOPS + 100);
    expect(s.opinion[2][1]).toBeGreaterThan(0);
    expect(gift(s, 1, 2, 1e9, 0).ok).toBe(false);
    expect(canTrade(s, 1, 2)).toBe(true);
    expect(toggleEmbargo(s, 1, 2).ok).toBe(true);
    expect(canTrade(s, 1, 2)).toBe(false);
    expect(canTrade(s, 2, 1)).toBe(false);
    toggleEmbargo(s, 1, 2);
    expect(canTrade(s, 1, 2)).toBe(true);
    addAttack(s, 2, 1, 100);
    expect(canTrade(s, 1, 2)).toBe(false);
  });
});

describe('applyAction validation', () => {
  it('checks player, phase and troops', () => {
    const s = makeFlatGame(20, 20, 2);
    claimRect(s, 1, 0, 0, 4, 4);
    expect(applyAction(s, 0, { type: 'setArmyMix', armor: 0.2, artillery: 0.1 }).ok).toBe(false);
    expect(applyAction(s, 9, { type: 'setArmyMix', armor: 0.2, artillery: 0.1 }).ok).toBe(false);
    const bad = [
      { infantry: -1, armor: 0, artillery: 0 },
      { infantry: NaN, armor: 0, artillery: 0 },
      { infantry: Infinity, armor: 0, artillery: 0 },
      { infantry: START_TROOPS + 1, armor: 0, artillery: 0 },
      { infantry: 10, armor: 1, artillery: 0 },
    ];
    for (const troops of bad) {
      expect(applyAction(s, 1, { type: 'attack', tile: 10 * 20 + 10, troops }).ok).toBe(false);
      expect(applyAction(s, 1, { type: 'transport', from: 0, to: 399, troops }).ok).toBe(false);
    }
    expect(applyAction(s, 1, { type: 'attack', tile: -5, troops: { infantry: 100, armor: 0, artillery: 0 } }).ok).toBe(false);
    expect(applyAction(s, 1, { type: 'gift', to: 2, gold: -5, troops: 0 }).ok).toBe(false);
    expect(applyAction(s, 1, { type: 'requestAlliance', to: 0 }).ok).toBe(false);
    s.phase = 'spawn';
    expect(applyAction(s, 1, { type: 'setArmyMix', armor: 0.2, artillery: 0.1 }).ok).toBe(false);
    s.phase = 'over';
    expect(applyAction(s, 1, { type: 'setArmyMix', armor: 0.2, artillery: 0.1 }).ok).toBe(false);
    s.phase = 'playing';
    s.players[2].alive = false;
    expect(applyAction(s, 2, { type: 'setArmyMix', armor: 0.2, artillery: 0.1 }).ok).toBe(false);
    // There is one troop pool: no army ratio to set.
    expect(applyAction(s, 1, { type: 'setArmyRatio', value: 0.5 } as unknown as Action).ok).toBe(false);
  });
  it('clamps the army mix', () => {
    const s = makeFlatGame(20, 20, 1);
    const p = s.players[1];
    expect(applyAction(s, 1, { type: 'setArmyMix', armor: NaN, artillery: 0 }).ok).toBe(false);
    applyAction(s, 1, { type: 'setArmyMix', armor: 1, artillery: -0.2 });
    expect(p.armyMix).toEqual({ armor: 0.8, artillery: 0 });
    applyAction(s, 1, { type: 'setArmyMix', armor: 0.8, artillery: 0.8 });
    expect(p.armyMix.armor + p.armyMix.artillery).toBeCloseTo(0.9);
    expect(p.armyMix.armor).toBeCloseTo(0.45);
  });
  it('dispatches diplomacy actions', () => {
    const s = makeFlatGame(20, 20, 2);
    expect(applyAction(s, 1, { type: 'requestAlliance', to: 2 }).ok).toBe(true);
    expect(applyAction(s, 2, { type: 'answerAlliance', from: 1, accept: true }).ok).toBe(true);
    expect(areAllied(s, 1, 2)).toBe(true);
    expect(applyAction(s, 2, { type: 'breakAlliance', with: 1 }).ok).toBe(true);
    expect(applyAction(s, 1, { type: 'toggleEmbargo', with: 2 }).ok).toBe(true);
    expect(s.players[1].embargoes).toEqual([2]);
    expect(applyAction(s, 1, { type: 'gift', to: 2, gold: 10, troops: 0 }).ok).toBe(true);
  });
});

describe('victory and scores', () => {
  it('score counts tiles, population and finished buildings', () => {
    const s = makeFlatGame(20, 20, 1);
    claimRect(s, 1, 0, 0, 9, 9);
    const p = s.players[1];
    p.troops = { infantry: 2000, armor: 0, artillery: 0 };
    expect(score(s, 1)).toBe(100 + 20);
    const b = addBuilding(s, 1, 5, 'farm');
    expect(score(s, 1)).toBe(170);
    b.buildLeft = 3;
    expect(score(s, 1)).toBe(120);
  });
  it('land share wins', () => {
    const s = makeFlatGame(10, 10, 2);
    claimRect(s, 1, 0, 0, 9, 7); // 80%
    claimRect(s, 2, 0, 8, 9, 9);
    updateVictory(s);
    expect(s.phase).toBe('over');
    expect(s.winner).toBe(1);
    expect(s.players[1].stats.tilesMax).toBe(80);
    expect(s.events.some((e) => e.kind === 'victory')).toBe(true);
  });
  it('last nation standing wins; human elimination is a defeat', () => {
    const s = makeFlatGame(10, 10, 3, { human: true });
    claimRect(s, 1, 0, 0, 1, 1);
    claimRect(s, 2, 4, 4, 5, 5);
    claimRect(s, 3, 8, 8, 9, 9);
    updateVictory(s);
    expect(s.phase).toBe('playing');
    for (const t of [0, 1, 10, 11]) setOwner(s, t, 2);
    expect(s.players[1].alive).toBe(false);
    updateVictory(s);
    expect(s.phase).toBe('over');
    expect(s.winner).toBe(2); // top score among the living
    const defeat = s.events.find((e) => e.kind === 'defeat' && e.players.includes(1));
    // nobody won: the texts name the leader, not a "winner"
    expect(defeat?.message).toMatch(/^Defeat: Tester was eliminated \(.* leads the map\)$/);
    expect(s.events.some((e) => e.kind === 'victory' && / wins/.test(e.message))).toBe(false);

    const t = makeFlatGame(10, 10, 3);
    claimRect(t, 1, 0, 0, 1, 1);
    claimRect(t, 2, 4, 4, 5, 5);
    claimRect(t, 3, 8, 8, 9, 9);
    for (const k of [0, 1, 10, 11]) setOwner(t, k, 2);
    for (const k of [88, 89, 98, 99]) setOwner(t, k, 2);
    updateVictory(t);
    expect(t.winner).toBe(2);
  });
  it('time limit: highest score wins', () => {
    const s = makeFlatGame(10, 10, 2);
    s.settings.timeLimit = 60;
    claimRect(s, 1, 0, 0, 2, 2);
    claimRect(s, 2, 5, 5, 9, 9);
    s.tick = 590;
    updateVictory(s);
    expect(s.phase).toBe('playing');
    s.tick = 600;
    updateVictory(s);
    expect(s.phase).toBe('over');
    expect(s.winner).toBe(2);
  });
});

describe('tick', () => {
  it('runs the spawn phase and starts the game', () => {
    const s = createGame(testSettings({ humanPlayer: false, aiCount: 4 }));
    for (let k = 0; k < SPAWN_SECONDS * TICKS_PER_SECOND; k++) tick(s);
    expect(s.phase).toBe('playing');
    expect(s.players.slice(1).every((p) => p.spawned && p.tiles > 0)).toBe(true);
    for (let k = 0; k < 50; k++) tick(s);
    expect(s.tick).toBe(SPAWN_SECONDS * TICKS_PER_SECOND + 50);
  });
  it('caps events and drops old effects', () => {
    const s = makeTestGame();
    for (let k = 0; k < MAX_EVENTS + 50; k++) addEvent(s, 'info', `e${k}`, []);
    expect(s.events.length).toBe(MAX_EVENTS);
    expect(s.events[s.events.length - 1].message).toBe(`e${MAX_EVENTS + 49}`);
    const mine = { kind: 'explosion' as const, x: 1, y: 1, radius: 2, tick: s.tick };
    s.effects.push(mine);
    for (let k = 0; k < 40; k++) tick(s);
    // AIs add their own capture effects meanwhile; only ours must be gone, and nothing older than the TTL may remain.
    expect(s.effects.includes(mine)).toBe(false);
    expect(s.effects.every((e) => s.tick - e.tick <= 30)).toBe(true);
  });
  it('is deterministic', () => {
    const a = makeTestGame({ seed: 77 });
    const b = makeTestGame({ seed: 77 });
    for (let k = 0; k < 100; k++) {
      tick(a);
      tick(b);
    }
    expect(a.map.owner).toEqual(b.map.owner);
    expect(a.rngState.s).toBe(b.rngState.s);
  });
});
