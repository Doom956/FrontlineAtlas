// Supply lines (supplylines.ts): the hub network, cuts and reroutes, the capital, repair and guard timers, convoys and
// blockades, supply efficiency near a cut fort, strike scoring, the hash and determinism.
import { describe, expect, it } from 'vitest';
import { markBuildingsChanged } from '../src/sim/buildings';
import { addBeachhead, supplyEfficiency, supplySourceTiles } from '../src/sim/combat';
import { BEACHHEAD_SUPPLY_SECONDS, SUPPLY_LINES, TICKS_PER_SECOND } from '../src/sim/config';
import { hashState } from '../src/sim/hash';
import { computeCoastAndLand } from '../src/sim/mapgen';
import { PROTOCOL_VERSION } from '../src/net/protocol';
import { tick } from '../src/sim/sim';
import { newId } from '../src/sim/state';
import {
  bestSupplyHub,
  compassWord,
  convoyPhase,
  damageHub,
  damageSupplyHubs,
  hubCutSources,
  hubCutValue,
  hubDamaged,
  hubRepairSeconds,
  onLine,
  pruneRails,
  refreshSupplyLines,
  supplyNetworkOf,
  supplyRiskOf,
  secondRouteSpots,
  updateSupplyLines,
} from '../src/sim/supplylines';
import { spawnWarshipAt } from '../src/sim/units';
import { Terrain } from '../src/sim/types';
import type { Building, BuildingType, GameState, TechId } from '../src/sim/types';
import { claimRect, makeFlatGame, makeTestGame } from './helpers';

const at = (s: GameState, x: number, y: number): number => y * s.map.width + x;
function addBuilding(s: GameState, type: BuildingType, owner: number, tile: number, level = 1): Building {
  const id = newId(s);
  const b: Building = { id, type, owner, tile, level, buildLeft: 0, upgradeLeft: 0, fighters: 0, bombers: 0, cooldown: 0, dropCooldown: 0, disabledUntil: 0, hp: 1, queuedLevels: 0 };
  s.buildings.set(id, b);
  s.map.building[tile] = id + 1;
  markBuildingsChanged(s);
  return b;
}
function give(s: GameState, pid: number, ...techs: TechId[]): void {
  for (const t of techs) if (!s.players[pid].techs.includes(t)) s.players[pid].techs.push(t);
}
/** Runs only the supply lines for n ticks (no combat, no AI). */
function runLines(s: GameState, n: number): void {
  for (let k = 0; k < n; k++) {
    updateSupplyLines(s);
    s.tick++;
  }
}

/**
 * 300 x 60 plain: 1 owns x 0..199 (capital at 10,30), 2 owns x 200..299. A factory at 90,30 (a hub, no source) and a
 * fort at 190,30: the fort's only way home is through the factory (the capital is 180 tiles away, past railMaxDist).
 */
function chain(): { s: GameState; cap: number; factory: Building; fort: Building; front: number } {
  const s = makeFlatGame(300, 60, 2, { human: true, seed: 3 });
  claimRect(s, 1, 0, 0, 199, 59);
  claimRect(s, 2, 200, 0, 299, 59);
  s.admin = { aiPassive: [], godMode: [], aiFrozen: true, revealIntel: [] };
  s.settings.victoryLandShare = 0.99;
  s.players[1].capital = at(s, 10, 30);
  const factory = addBuilding(s, 'factory', 1, at(s, 90, 30));
  const fort = addBuilding(s, 'fort', 1, at(s, 190, 30));
  refreshSupplyLines(s, 1);
  return { s, cap: s.players[1].capital, factory, fort, front: at(s, 205, 30) };
}

describe('the supply network', () => {
  it('links hubs by rail over own land and reaches the fort from the capital', () => {
    const { s, cap, factory, fort } = chain();
    const net = supplyNetworkOf(s, 1);
    expect(net.hubs.map((h) => h.kind).sort()).toEqual(['capital', 'factory', 'fort']);
    expect(net.hubs.every((h) => h.connected)).toBe(true);
    const pairs = net.links.map((l) => [l.a, l.b].sort((a, b) => a - b).join('-')).sort();
    expect(pairs).toEqual([[cap, factory.tile].sort((a, b) => a - b).join('-'), [factory.tile, fort.tile].sort((a, b) => a - b).join('-')].sort());
    for (const l of net.links) {
      expect(l.kind).toBe('rail');
      expect(l.path).not.toBeNull();
      expect([l.path![0], l.path![l.path!.length - 1]].sort()).toEqual([l.a, l.b].sort());
    }
    expect(net.cut).toEqual([]);
    expect(supplySourceTiles(s, 1)).toContain(fort.tile);
  });

  it('cuts a fort whose only hub is damaged, and its troops lose supply until the repair', () => {
    const { s, factory, fort, front } = chain();
    expect(supplyEfficiency(s, 1, front)).toBe(1);
    expect(hubCutValue(s, 2, factory.tile)).toBe(1);
    expect(hubCutSources(s, 2, factory.tile)).toEqual([fort.tile]);
    expect(damageHub(s, 1, factory.tile, 2)).toBe(true);
    expect(hubDamaged(s, 1, factory.tile)).toBe(true);
    expect(supplyNetworkOf(s, 1).cut).toEqual([fort.tile]);
    expect(supplySourceTiles(s, 1)).not.toContain(fort.tile);
    expect(supplyEfficiency(s, 1, front)).toBeLessThan(0.85);
    // Both sides hear of it, with the data the client words its line from.
    const evs = s.events.filter((e) => e.kind === 'supplyHubDamaged');
    expect(evs.map((e) => e.players[0]).sort()).toEqual([1, 2]);
    const info = evs[0].supply!;
    expect(info).toMatchObject({ owner: 1, by: 2, hub: factory.tile, hubKind: 'factory', seconds: SUPPLY_LINES.repairSeconds, sources: [fort.tile], direction: 'eastern' });
    expect(evs.find((e) => e.players[0] === 2)!.message).toBe(`Supply cut: ${s.players[1].name}'s eastern front is slower for 45 s`);
    expect(evs.find((e) => e.players[0] === 1)!.message).toContain('repair in 45 s');
    // A second hit while damaged does nothing.
    expect(damageHub(s, 1, factory.tile, 2)).toBe(false);
    // Repaired after 45 s: supply is back.
    runLines(s, SUPPLY_LINES.repairSeconds * TICKS_PER_SECOND + 1);
    expect(hubDamaged(s, 1, factory.tile)).toBe(false);
    expect(supplyNetworkOf(s, 1).cut).toEqual([]);
    expect(supplyEfficiency(s, 1, front)).toBe(1);
    expect(s.events.some((e) => e.kind === 'supplyHubRepaired' && e.players[0] === 1 && e.supply?.sources[0] === fort.tile)).toBe(true);
    // Guarded for 30 s after the repair, then it can be hit again.
    expect(damageHub(s, 1, factory.tile, 2)).toBe(false);
    expect(hubCutValue(s, 2, factory.tile)).toBe(0);
    runLines(s, SUPPLY_LINES.guardSeconds * TICKS_PER_SECOND);
    expect(damageHub(s, 1, factory.tile, 2)).toBe(true);
  });

  it('a damaged fort keeps its own supply (routes just do not pass it)', () => {
    const { s, fort, front } = chain();
    expect(damageHub(s, 1, fort.tile, 2)).toBe(true);
    expect(supplyNetworkOf(s, 1).cut).toEqual([]);
    expect(supplyEfficiency(s, 1, front)).toBe(1);
  });

  it('reroutes round a damaged hub when another route exists', () => {
    const { s, factory, fort, front } = chain();
    addBuilding(s, 'factory', 1, at(s, 90, 10));
    refreshSupplyLines(s, 1);
    expect(hubCutValue(s, 2, factory.tile)).toBe(0);
    expect(damageHub(s, 1, factory.tile, 2)).toBe(true);
    expect(supplyNetworkOf(s, 1).cut).toEqual([]);
    expect(supplySourceTiles(s, 1)).toContain(fort.tile);
    expect(supplyEfficiency(s, 1, front)).toBe(1);
    expect(s.events.find((e) => e.kind === 'supplyHubDamaged' && e.players[0] === 2)!.message).toContain('rerouted');
  });

  it('never damages or cuts the capital', () => {
    const { s, cap } = chain();
    const city = addBuilding(s, 'city', 1, cap);
    refreshSupplyLines(s, 1);
    expect(damageHub(s, 1, city.tile, 2)).toBe(false);
    expect(damageSupplyHubs(s, 2, cap, 6)).toBe(0);
    expect(hubCutValue(s, 2, cap)).toBe(0);
    expect(hubDamaged(s, 1, cap)).toBe(false);
    expect(supplySourceTiles(s, 1)).toContain(cap);
  });

  it('cuts by territory: a rail over lost land is searched again, and a fort with no route is cut', () => {
    const { s, fort } = chain();
    // Player 2 takes a band from top to bottom across the rail between the factory and the fort.
    claimRect(s, 2, 140, 0, 142, 59);
    refreshSupplyLines(s, 1);
    expect(supplyNetworkOf(s, 1).cut).toEqual([fort.tile]);
    expect(s.events.some((e) => e.kind === 'supplyCut' && e.supply?.sources[0] === fort.tile)).toBe(true);
    // A gap in the band: the rail goes round through it.
    claimRect(s, 1, 140, 40, 142, 42);
    s.tick += SUPPLY_LINES.retrySeconds * TICKS_PER_SECOND;
    refreshSupplyLines(s, 1);
    expect(supplyNetworkOf(s, 1).cut).toEqual([]);
    expect(s.events.some((e) => e.kind === 'supplyRestored')).toBe(true);
  });

  it('joins a cluster the nearest-hub rails left apart (forts linked only to each other)', () => {
    const s = makeFlatGame(300, 60, 2, { human: true, seed: 3 });
    claimRect(s, 1, 0, 0, 199, 59);
    claimRect(s, 2, 200, 0, 299, 59);
    s.players[1].capital = at(s, 10, 30);
    for (const [x, y] of [[20, 12], [20, 48], [30, 30]]) addBuilding(s, 'factory', 1, at(s, x, y));
    const forts = [[130, 20], [130, 40], [145, 20], [145, 40]].map(([x, y]) => addBuilding(s, 'fort', 1, at(s, x, y)));
    // a first build may take a few checks (railSearchesPerCheck)
    for (let k = 0; k < 3; k++) {
      refreshSupplyLines(s, 1);
      s.tick++;
    }
    const net = supplyNetworkOf(s, 1);
    expect(net.cut).toEqual([]);
    for (const f of forts) expect(net.hubs.find((h) => h.tile === f.tile)!.connected).toBe(true);
    // exactly one rail crosses the gap
    const core = new Set([s.players[1].capital, at(s, 20, 12), at(s, 20, 48), at(s, 30, 30)]);
    expect(net.links.filter((l) => core.has(l.a) !== core.has(l.b)).length).toBe(1);
  });

  it('never cuts a fort on own contiguous land for distance or the search budget', () => {
    const s = makeFlatGame(300, 60, 2, { human: true, seed: 3 });
    claimRect(s, 1, 0, 0, 199, 59);
    claimRect(s, 2, 200, 0, 299, 59);
    s.players[1].capital = at(s, 10, 30);
    // far past railMaxDist, no hub between
    const far = addBuilding(s, 'fort', 1, at(s, 195, 55));
    refreshSupplyLines(s, 1);
    expect(supplyNetworkOf(s, 1).cut).toEqual([]);
    expect(supplyNetworkOf(s, 1).hubs.find((h) => h.tile === far.tile)!.connected).toBe(true);
    // many hubs at once: more searches than one check allows, still nothing cut
    for (let x = 40; x <= 190; x += 30) for (let y = 5; y <= 55; y += 12) if (!s.map.building[at(s, x, y)]) addBuilding(s, 'fort', 1, at(s, x, y));
    refreshSupplyLines(s, 1);
    const net = supplyNetworkOf(s, 1);
    expect(net.hubs.length).toBeGreaterThan(SUPPLY_LINES.railSearchesPerCheck);
    expect(net.cut).toEqual([]);
    expect(supplySourceTiles(s, 1)).toContain(far.tile);
  });

  it('marks junctions where three rails meet', () => {
    const { s, factory } = chain();
    addBuilding(s, 'fort', 1, at(s, 90, 55));
    addBuilding(s, 'fort', 1, at(s, 90, 5));
    refreshSupplyLines(s, 1);
    const hub = supplyNetworkOf(s, 1).hubs.find((h) => h.tile === factory.tile)!;
    expect(hub.junction).toBe(true);
  });
});

type PLink = { a: number; b: number; sea: boolean; path: Int32Array | null };
const W = 400;
/** A straight 8-way route from tile a to tile b on a W-wide grid. */
function straight(a: number, b: number): Int32Array {
  const out = [a];
  let x = a % W;
  let y = (a / W) | 0;
  const bx = b % W;
  const by = (b / W) | 0;
  while (x !== bx || y !== by) {
    x += Math.sign(bx - x);
    y += Math.sign(by - y);
    out.push(y * W + x);
  }
  return Int32Array.from(out);
}
/** Hubs at the given points (sorted by tile, like the sim) with rails to their 3 nearest within 120 tiles. */
function mesh(pts: [number, number][]): { hubs: { tile: number; x: number; y: number }[]; links: PLink[] } {
  const hubs = pts.map(([x, y]) => ({ tile: y * W + x, x, y })).sort((p, q) => p.tile - q.tile);
  const links: PLink[] = [];
  const seen = new Set<number>();
  hubs.forEach((h, i) => {
    const near = hubs
      .map((o, j) => ({ j, d: (o.x - h.x) ** 2 + (o.y - h.y) ** 2 }))
      .filter((e) => e.j !== i && e.d <= 120 * 120)
      .sort((p, q) => p.d - q.d || p.j - q.j)
      .slice(0, 3);
    for (const { j } of near) {
      const a = Math.min(i, j);
      const b = Math.max(i, j);
      if (seen.has(a * 1000 + b)) continue;
      seen.add(a * 1000 + b);
      links.push({ a, b, sea: false, path: straight(hubs[a].tile, hubs[b].tile) });
    }
  });
  return { hubs, links };
}
/** Hubs reached from hub 0 over the links, never on past `skip`. */
function reachFrom0(n: number, links: readonly PLink[], skip = -1): number {
  const seen = new Uint8Array(n);
  seen[0] = 1;
  const q = [0];
  let c = 1;
  while (q.length) {
    const u = q.pop()!;
    if (u === skip) continue;
    for (const l of links) {
      const v = l.a === u ? l.b : l.b === u ? l.a : -1;
      if (v >= 0 && !seen[v]) {
        seen[v] = 1;
        c++;
        q.push(v);
      }
    }
  }
  return c;
}
/** A fixed scatter of hubs (an integer LCG, so the test is the same every run). */
function scatter(seed: number, count: number): [number, number][] {
  let r = seed;
  const next = (m: number): number => {
    r = (r * 1103515245 + 12345) % 2147483648;
    return r % m;
  };
  const out: [number, number][] = [];
  const used = new Set<number>();
  while (out.length < count) {
    const x = next(300);
    const y = next(300);
    if (used.has(y * W + x)) continue;
    used.add(y * W + x);
    out.push([x, y]);
  }
  return out;
}

describe('a sparse network (pruneRails)', () => {
  it('drops the long side of a line that runs on through a hub, and keeps it when the hub is off the line', () => {
    const line = mesh([[10, 50], [60, 52], [110, 50]]);
    expect(pruneRails(line.hubs, line.links, W * W, W).length).toBe(1);
    expect(line.links.map((l) => `${l.a}-${l.b}`)).toEqual(['0-2', '1-2']); // hubs by tile: 10,50 then 110,50 then 60,52
    const bent = mesh([[10, 50], [60, 50 + SUPPLY_LINES.railPruneLane + 6], [110, 50]]);
    expect(pruneRails(bent.hubs, bent.links, W * W, W)).toEqual([]);
    expect(onLine({ x: 60, y: 52 }, { x: 10, y: 50 }, { x: 110, y: 50 })).toBe(true);
    expect(onLine({ x: 120, y: 50 }, { x: 10, y: 50 }, { x: 110, y: 50 })).toBe(false);
  });

  it('keeps a loop: the diagonals of a square go, its four sides stay, and a hit on any corner cuts nothing', () => {
    const sq = mesh([[100, 100], [160, 100], [100, 160], [160, 160]]);
    expect(sq.links.length).toBe(6);
    pruneRails(sq.hubs, sq.links, W * W, W);
    expect(sq.links.length).toBe(4);
    for (let v = 1; v < 4; v++) expect(reachFrom0(4, sq.links, v)).toBe(4);
  });

  it('stays connected, thins out, and (lines through hubs aside) never lets one hit cut off more than before', () => {
    const through = SUPPLY_LINES.railPruneThrough;
    let before = 0;
    let after = 0;
    try {
      for (const keepThrough of [true, false]) {
        if (!keepThrough) (SUPPLY_LINES as { railPruneThrough: readonly [number, number] }).railPruneThrough = [0, 1];
        for (let seed = 1; seed <= 6; seed++) {
          const m = mesh(scatter(seed, 40));
          const orig = m.links.slice();
          pruneRails(m.hubs, m.links, W * W, W);
          if (keepThrough) {
            before += orig.length;
            after += m.links.length;
          }
          expect(reachFrom0(40, m.links)).toBe(reachFrom0(40, orig));
          if (!keepThrough) for (let v = 1; v < 40; v++) expect(reachFrom0(40, m.links, v)).toBe(reachFrom0(40, orig, v));
        }
      }
    } finally {
      (SUPPLY_LINES as { railPruneThrough: readonly [number, number] }).railPruneThrough = through;
    }
    expect(after).toBeLessThan(before * 0.85);
  });

  it('gives the same network whatever order the rails come in (lockstep)', () => {
    const m = mesh(scatter(9, 40));
    const rev = { hubs: m.hubs, links: m.links.slice().reverse() };
    const g1 = pruneRails(m.hubs, m.links, W * W, W).sort((p, q) => p - q);
    const g2 = pruneRails(rev.hubs, rev.links, W * W, W).sort((p, q) => p - q);
    expect(g1).toEqual(g2);
    const key = (l: PLink): string => `${l.a}-${l.b}`;
    expect(rev.links.map(key).sort()).toEqual(m.links.map(key).sort());
  });

  it('in a game: a line through a factory carries the far fort, so a hit on the factory cuts it', () => {
    const s = makeFlatGame(300, 60, 2, { human: true, seed: 3 });
    claimRect(s, 1, 0, 0, 199, 59);
    claimRect(s, 2, 200, 0, 299, 59);
    s.admin = { aiPassive: [], godMode: [], aiFrozen: true, revealIntel: [] };
    s.settings.victoryLandShare = 0.99;
    s.players[1].capital = at(s, 10, 30);
    const factory = addBuilding(s, 'factory', 1, at(s, 60, 31));
    const fort = addBuilding(s, 'fort', 1, at(s, 110, 30));
    refreshSupplyLines(s, 1);
    const links = supplyNetworkOf(s, 1).links.map((l) => [l.a, l.b].sort((p, q) => p - q).join('-'));
    expect(links).not.toContain([s.players[1].capital, fort.tile].sort((p, q) => p - q).join('-'));
    expect(links.length).toBe(2);
    expect(hubCutSources(s, 2, factory.tile)).toEqual([fort.tile]);
  });
});

describe('repair times', () => {
  it('45 s, 30 s with Logistics, 10 s less under a SAM or Flak site (once)', () => {
    const { s, factory } = chain();
    expect(hubRepairSeconds(s, 1, factory.tile)).toBe(45);
    give(s, 1, 'logistics');
    expect(hubRepairSeconds(s, 1, factory.tile)).toBe(30);
    s.players[1].techs = s.players[1].techs.filter((t) => t !== 'logistics');
    const sam = addBuilding(s, 'sam', 1, at(s, 95, 30));
    expect(hubRepairSeconds(s, 1, factory.tile)).toBe(35);
    // Flak Guns on top of the SAM: still only 10 s.
    give(s, 1, 'flakGuns');
    addBuilding(s, 'fort', 1, at(s, 85, 34));
    expect(hubRepairSeconds(s, 1, factory.tile)).toBe(35);
    s.buildings.delete(sam.id);
    s.map.building[sam.tile] = 0;
    markBuildingsChanged(s);
    expect(hubRepairSeconds(s, 1, factory.tile)).toBe(35); // the flak fort alone
    give(s, 1, 'logistics');
    expect(hubRepairSeconds(s, 1, factory.tile)).toBe(20);
    // The timer follows: damaged for 20 s.
    refreshSupplyLines(s, 1);
    expect(damageHub(s, 1, factory.tile, 2)).toBe(true);
    runLines(s, 20 * TICKS_PER_SECOND - 1);
    expect(hubDamaged(s, 1, factory.tile)).toBe(true);
    runLines(s, 1);
    expect(hubDamaged(s, 1, factory.tile)).toBe(false);
  });
});

/**
 * Two landmasses: water at x 100..139. Player 1 holds x 0..99 (capital at 10,30, port at 99,30) and x 140..199 (port
 * at 140,30, fort at 190,30); player 2 holds x 200..299. The fort's only way home is the convoy lane.
 */
function seaGame(): { s: GameState; west: Building; east: Building; fort: Building } {
  const s = makeFlatGame(300, 60, 2, { human: true, seed: 5 });
  for (let y = 0; y < 60; y++) for (let x = 100; x < 140; x++) s.map.terrain[at(s, x, y)] = Terrain.DeepWater;
  computeCoastAndLand(s.map);
  claimRect(s, 1, 0, 0, 99, 59);
  claimRect(s, 1, 140, 0, 199, 59);
  claimRect(s, 2, 200, 0, 299, 59);
  s.admin = { aiPassive: [], godMode: [], aiFrozen: true, revealIntel: [] };
  s.settings.victoryLandShare = 0.99;
  s.players[1].capital = at(s, 10, 30);
  const west = addBuilding(s, 'port', 1, at(s, 99, 30));
  const east = addBuilding(s, 'port', 1, at(s, 140, 30));
  const fort = addBuilding(s, 'fort', 1, at(s, 190, 30));
  s.warMemory = [1, 2, 1e9]; // at war
  return { s, west, east, fort };
}

describe('convoys', () => {
  it('a port links to its port on the other landmass by a sea lane', () => {
    const { s, west, east, fort } = seaGame();
    refreshSupplyLines(s, 1);
    const net = supplyNetworkOf(s, 1);
    const sea = net.links.filter((l) => l.kind === 'sea');
    expect(sea.map((l) => [l.a, l.b])).toEqual([[west.tile, east.tile]]);
    expect(net.cut).toEqual([]);
    expect(supplySourceTiles(s, 1)).toContain(fort.tile);
  });

  it('an enemy warship near the lane sinks a sailing convoy: the lane is cut until the next one leaves', () => {
    const { s, west, east, fort } = seaGame();
    while (convoyPhase(s.tick, west.tile, east.tile) !== 0) s.tick++;
    refreshSupplyLines(s, 1);
    expect(supplyNetworkOf(s, 1).cut).toEqual([]);
    const ship = spawnWarshipAt(s, 2, at(s, 120, 59), at(s, 120, 35));
    s.tick++;
    refreshSupplyLines(s, 1);
    expect(supplyNetworkOf(s, 1).cut).toEqual([fort.tile]);
    expect(supplyNetworkOf(s, 1).links.find((l) => l.kind === 'sea')!.cut).toBe(true);
    const sunk = s.events.filter((e) => e.kind === 'convoySunk');
    expect(sunk.map((e) => e.players[0]).sort()).toEqual([1, 2]);
    expect(sunk[0].supply).toMatchObject({ owner: 1, by: 2, hub: west.tile, sources: [fort.tile] });
    expect(sunk[0].supply!.seconds).toBe(SUPPLY_LINES.convoyEverySeconds);
    // The ship sails away; the next convoy leaves 30 s after the last one and the lane opens.
    ship.hp = 0;
    s.units = s.units.filter((u) => u.hp > 0);
    runLines(s, SUPPLY_LINES.convoyEverySeconds * TICKS_PER_SECOND - 2);
    expect(supplyNetworkOf(s, 1).cut).toEqual([fort.tile]);
    runLines(s, 2);
    expect(supplyNetworkOf(s, 1).cut).toEqual([]);
  });

  it('a blockade of either port cuts the lane while it holds', () => {
    const { s, west, east, fort } = seaGame();
    while (convoyPhase(s.tick, west.tile, east.tile) < SUPPLY_LINES.convoySailSeconds * TICKS_PER_SECOND + 5) s.tick++;
    refreshSupplyLines(s, 1);
    expect(supplyNetworkOf(s, 1).cut).toEqual([]);
    const ship = spawnWarshipAt(s, 2, at(s, 139, 59), at(s, 136, 25)); // next to the east port, no convoy at sea
    s.tick++;
    refreshSupplyLines(s, 1);
    expect(supplyNetworkOf(s, 1).cut).toEqual([fort.tile]);
    expect(s.events.some((e) => e.kind === 'convoySunk')).toBe(false);
    expect(s.events.some((e) => e.kind === 'supplyCut' && e.supply?.by === 2)).toBe(true);
    ship.hp = 0;
    s.units = s.units.filter((u) => u.hp > 0);
    s.tick++;
    refreshSupplyLines(s, 1);
    expect(supplyNetworkOf(s, 1).cut).toEqual([]);
  });
});

describe('beachheads', () => {
  it('a landing with no convoy lane keeps its supply window, port or not', () => {
    const { s, west, east } = seaGame();
    for (const b of [west, east]) {
      s.buildings.delete(b.id);
      s.map.building[b.tile] = 0;
    }
    markBuildingsChanged(s);
    const head = at(s, 145, 30);
    addBeachhead(s, 1, head, BEACHHEAD_SUPPLY_SECONDS);
    refreshSupplyLines(s, 1);
    const net = supplyNetworkOf(s, 1);
    expect(net.links.some((l) => l.kind === 'sea')).toBe(false);
    expect(net.cut).not.toContain(head);
    expect(supplySourceTiles(s, 1)).toContain(head);
    expect(hubCutValue(s, 2, head)).toBe(0);
    // the fort on that landmass has no lane home either: no network there, so it is not cut
    expect(net.cut).toEqual([]);
    expect(supplySourceTiles(s, 1)).toContain(at(s, 190, 30));
  });

  it('a landing with a convoy lane is cut only while that lane is cut', () => {
    const { s, west, east } = seaGame();
    s.buildings.delete(east.id);
    s.map.building[east.tile] = 0;
    markBuildingsChanged(s);
    const head = at(s, 141, 30);
    addBeachhead(s, 1, head, BEACHHEAD_SUPPLY_SECONDS);
    while (convoyPhase(s.tick, west.tile, head) !== 0) s.tick++;
    refreshSupplyLines(s, 1);
    expect(supplyNetworkOf(s, 1).links.filter((l) => l.kind === 'sea').map((l) => [l.a, l.b])).toEqual([[west.tile, head]]);
    expect(supplySourceTiles(s, 1)).toContain(head);
    const ship = spawnWarshipAt(s, 2, at(s, 120, 59), at(s, 120, 33));
    s.tick++;
    refreshSupplyLines(s, 1);
    expect(supplyNetworkOf(s, 1).cut).toContain(head);
    expect(supplySourceTiles(s, 1)).not.toContain(head);
    ship.hp = 0;
    s.units = s.units.filter((u) => u.hp > 0);
    runLines(s, SUPPLY_LINES.convoyEverySeconds * TICKS_PER_SECOND);
    expect(supplyNetworkOf(s, 1).cut).not.toContain(head);
    expect(supplySourceTiles(s, 1)).toContain(head);
  });
});

describe('targets', () => {
  it('bestSupplyHub picks the hub that cuts the most sources near the front', () => {
    const { s, factory, fort } = chain();
    addBuilding(s, 'fort', 1, at(s, 185, 50));
    addBuilding(s, 'city', 1, at(s, 50, 50));
    refreshSupplyLines(s, 1);
    const best = bestSupplyHub(s, 2, 1, at(s, 200, 30));
    expect(best?.tile).toBe(factory.tile);
    expect(best!.near).toBe(2);
    expect(hubCutValue(s, 2, fort.tile)).toBe(0); // a hit fort keeps its own supply: nothing behind it
    expect(bestSupplyHub(s, 1, 1, -1)).toBeNull(); // not hostile to itself
  });

  it('supplyRiskOf finds the one hub the front hangs on, and secondRouteSpots fix it', () => {
    const { s, factory } = chain();
    addBuilding(s, 'fort', 1, at(s, 185, 50));
    refreshSupplyLines(s, 1);
    const risk = supplyRiskOf(s, 1)!;
    expect(risk.hub).toBe(factory.tile);
    expect(risk.sources.length).toBe(2);
    expect(risk.direction).toBe('eastern');
    const spots = secondRouteSpots(s, 1, risk);
    expect(spots.length).toBeGreaterThan(0);
    addBuilding(s, 'fort', 1, spots[0]);
    refreshSupplyLines(s, 1);
    expect(supplyRiskOf(s, 1)?.hub === factory.tile && supplyRiskOf(s, 1)!.sources.length >= 2).toBe(false);
  });

  it('compass words', () => {
    expect(compassWord(10, 0)).toBe('eastern');
    expect(compassWord(-10, 1)).toBe('western');
    expect(compassWord(0, -5)).toBe('northern');
    expect(compassWord(5, 5)).toBe('south-eastern');
    expect(compassWord(0, 0)).toBe('');
  });
});

describe('hash and determinism', () => {
  it('the hash covers damage timers, sunk convoys and cut lists', () => {
    const { s, factory } = chain();
    const h0 = hashState(s);
    damageHub(s, 1, factory.tile, 2);
    const h1 = hashState(s);
    expect(h1).not.toBe(h0);
    s.supplyNet!.hubs[3]++;
    expect(hashState(s)).not.toBe(h1);
    s.supplyNet!.hubs[3]--;
    s.supplyNet!.sunk.push(1, 2, 1, 99, 2);
    expect(hashState(s)).not.toBe(h1);
    s.supplyNet!.sunk.length = 0;
    expect(hashState(s)).toBe(h1);
    s.supplyNet!.cut[1] = null;
    expect(hashState(s)).not.toBe(h1);
  });

  it('two games from the same seed run to the same hash and the same networks', () => {
    const a = makeTestGame({ seed: 77 });
    const b = makeTestGame({ seed: 77 });
    for (let k = 0; k < 900; k++) {
      tick(a);
      tick(b);
      if (k % 150 === 0) {
        // client reads between ticks change nothing
        for (let p = 1; p < a.players.length; p++) {
          supplyNetworkOf(a, p);
          supplyRiskOf(a, p);
          for (const h of supplyNetworkOf(a, p).hubs) hubCutValue(a, 2, h.tile);
        }
      }
    }
    expect(hashState(a)).toBe(hashState(b));
    for (let p = 1; p < a.players.length; p++) {
      expect(supplyNetworkOf(a, p).links.map((l) => `${l.a}-${l.b}-${l.kind}`)).toEqual(supplyNetworkOf(b, p).links.map((l) => `${l.a}-${l.b}-${l.kind}`));
    }
    expect(supplyNetworkOf(a, 1).hubs.length).toBeGreaterThan(0);
  });

  it('the protocol version moved on for the new rules', () => {
    expect(PROTOCOL_VERSION).toBe(25);
  });
});
