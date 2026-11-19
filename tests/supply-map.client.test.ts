// Supply lines on the real map (render/supplyLayer.ts, supplyText.ts): the toasts as each side reads them, the target line
// "Cuts supply to 2 forts", which zoom shows what, the cached network (read again only when its key changes, trains run away
// from the capital, a broken piece out of a damaged hub), the dirt track giving way to a rail, the map key entries and
// the selectors the tests and the e2e rely on.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { smoothRoute } from '../src/client/art/detailed/supplyLines';
import { railPairKey } from '../src/client/render/linkLayer';
import { SUPPLY_SPRITE_ZOOM, SupplyLayer, shimmerShown, supplyLook, type SupplyFrame } from '../src/client/render/supplyLayer';
import { SUPPLY_KEY, cutsSupplySub, cutsSupplyText, supplyCutAt, supplyToast } from '../src/client/supplyText';
import { markBuildingsChanged } from '../src/sim/buildings';
import { SUPPLY_LINES } from '../src/sim/config';
import { suggestions } from '../src/sim/advisor';
import { newId } from '../src/sim/state';
import { damageHub, refreshSupplyLines, supplyNetworkOf } from '../src/sim/supplylines';
import type { Building, BuildingType, GameEvent, GameState } from '../src/sim/types';
import { claimRect, makeFlatGame } from './helpers';

const at = (s: GameState, x: number, y: number): number => y * s.map.width + x;
function addBuilding(s: GameState, type: BuildingType, owner: number, tile: number): Building {
  const id = newId(s);
  const b: Building = { id, type, owner, tile, level: 1, buildLeft: 0, upgradeLeft: 0, fighters: 0, bombers: 0, cooldown: 0, dropCooldown: 0, disabledUntil: 0, hp: 1, queuedLevels: 0 };
  s.buildings.set(id, b);
  s.map.building[tile] = id + 1;
  markBuildingsChanged(s);
  return b;
}
/** 1 owns x 0..199 (capital 10,30, a factory at 90,30, a fort at 190,30: the fort's only way home is the factory), 2 the rest. */
function chain(): { s: GameState; factory: Building; fort: Building; cap: number } {
  const s = makeFlatGame(300, 60, 2, { human: true, seed: 3 });
  claimRect(s, 1, 0, 0, 199, 59);
  claimRect(s, 2, 200, 0, 299, 59);
  s.admin = { aiPassive: [], godMode: [], aiFrozen: true, revealIntel: [] };
  s.settings.victoryLandShare = 0.99;
  s.players[1].capital = at(s, 10, 30);
  const factory = addBuilding(s, 'factory', 1, at(s, 90, 30));
  const fort = addBuilding(s, 'fort', 1, at(s, 190, 30));
  refreshSupplyLines(s, 1);
  return { s, factory, fort, cap: s.players[1].capital };
}
const frame = (s: GameState, over: Partial<SupplyFrame> = {}): SupplyFrame => ({
  state: s,
  terr: null,
  camX: 100,
  camY: 30,
  zoom: 12,
  viewW: 1000,
  viewH: 600,
  view: { x0: 0, y0: 0, x1: 300, y1: 60 },
  colors: [[0, 0, 0], [64, 160, 255], [226, 74, 60]],
  dpr: 1,
  me: 1,
  visible: null,
  fogGen: -1,
  tickF: s.tick,
  nowMs: 0,
  ...over,
});
const supplyEvents = (s: GameState, kind: GameEvent['kind']): GameEvent[] => s.events.filter((e) => e.kind === kind);

describe('supply toasts, as each side reads them', () => {
  it('a hub hit that cuts supply: the victim and the attacker', () => {
    const { s, factory } = chain();
    expect(damageHub(s, 1, factory.tile, 2)).toBe(true);
    const evs = supplyEvents(s, 'supplyHubDamaged');
    const victim = supplyToast(s, s.players[1], evs.find((e) => e.players.includes(1))!);
    const attacker = supplyToast(s, s.players[2], evs.find((e) => e.players.includes(2))!);
    expect(victim?.text).toBe(`Your supply is cut at your factory: repair in ${SUPPLY_LINES.repairSeconds} s`);
    expect(victim?.kind).toBe('bad');
    expect(attacker?.text).toMatch(new RegExp(`^Supply cut: ${s.players[1].name}'s (\\w|-)+ front is slower for ${SUPPLY_LINES.repairSeconds} s$`));
    expect(attacker?.kind).toBe('good');
    // each side only reads its own copy
    expect(supplyToast(s, s.players[2], evs.find((e) => e.players.includes(1))!)).toBeNull();
  });
  it('restored, a sunk convoy and a hit that cuts nothing', () => {
    const { s } = chain();
    const info = { owner: 1, by: 2, hub: 5, hubKind: 'port' as const, seconds: 30, sources: [], direction: '' };
    const ev = (kind: GameEvent['kind'], players: number[], supply = info): GameEvent => ({ tick: 0, kind, message: '', players, tile: 5, supply });
    expect(supplyToast(s, s.players[1], ev('supplyRestored', [1]))?.text).toBe('Supply restored');
    expect(supplyToast(s, s.players[1], ev('convoySunk', [1]))?.text).toBe('Your convoy was sunk: next one in 30 s');
    expect(supplyToast(s, s.players[2], ev('convoySunk', [2]))?.text).toBe(`You sank ${s.players[1].name}'s convoy: their sea lane is cut for 30 s`);
    expect(supplyToast(s, s.players[1], ev('supplyHubDamaged', [1], { ...info, seconds: 45 }))?.text).toBe('Your port was hit: repair in 45 s, supply rerouted');
    expect(supplyToast(s, s.players[1], { ...ev('info', [1]), supply: undefined })).toBeNull();
  });
  it('names the front by its compass word', () => {
    const { s } = chain();
    const info = { owner: 1, by: 2, hub: 5, hubKind: 'fort' as const, seconds: 45, sources: [7], direction: 'eastern' };
    const e: GameEvent = { tick: 0, kind: 'supplyHubDamaged', message: '', players: [2], tile: 5, supply: info };
    expect(supplyToast(s, s.players[2], e)?.text).toBe(`Supply cut: ${s.players[1].name}'s eastern front is slower for 45 s`);
  });
});

describe('the target line', () => {
  it('says what a hit on an enemy hub cuts', () => {
    const { s, factory } = chain();
    const c = supplyCutAt(s, 2, factory.tile, 0);
    expect(c).not.toBeNull();
    expect(cutsSupplyText(c)).toBe('Cuts supply to 1 fort');
    expect(cutsSupplySub(c!)).toContain(`${SUPPLY_LINES.repairSeconds} s`);
    // a blast that reaches it from a few tiles away counts, one that does not reach it does not
    expect(supplyCutAt(s, 2, factory.tile + 3, 4)).not.toBeNull();
    expect(supplyCutAt(s, 2, factory.tile + 30, 4)).toBeNull();
    // your own hubs and hubs you cannot see say nothing
    expect(supplyCutAt(s, 1, factory.tile, 0)).toBeNull();
    expect(supplyCutAt(s, 2, factory.tile, 0, () => false)).toBeNull();
    expect(cutsSupplyText(null)).toBeNull();
  });
});

describe('what each zoom shows', () => {
  it('rails: close at zoom 10 and up, a thin line to zoom 5, nothing far out', () => {
    expect(supplyLook(2)).toBe('none');
    expect(supplyLook(4.9)).toBe('none');
    expect(supplyLook(5)).toBe('line');
    expect(supplyLook(9.9)).toBe('line');
    expect(supplyLook(10)).toBe('close');
    expect(supplyLook(24)).toBe('close');
    expect(SUPPLY_SPRITE_ZOOM).toBe(11);
    expect(shimmerShown(2.4)).toBe(false);
    expect(shimmerShown(3)).toBe(true);
  });
});

describe('the supply layer', () => {
  it('reads the network once per key, smooths each route, and runs trains away from the capital', () => {
    const { s, cap, factory, fort } = chain();
    const L = new SupplyLayer();
    L.update(frame(s));
    expect(L.computed).toBe(1);
    L.update(frame(s));
    expect(L.computed).toBe(1);
    expect(L.rails).toHaveLength(2);
    for (const r of L.rails) {
      expect(r.live).toBe(true);
      expect(r.path.length).toBeGreaterThan(1);
      // the smoothed route runs from one hub's centre to the other's
      expect([r.path[0][0], r.path[0][1]]).toEqual([(r.a % 300) + 0.5, Math.floor(r.a / 300) + 0.5]);
    }
    const toFort = L.rails.find((r) => r.a === fort.tile || r.b === fort.tile)!;
    // the flow ends at the fort, away from the capital
    const end = toFort.flow[toFort.flow.length - 1];
    expect([end[0] - 0.5, end[1] - 0.5]).toEqual([fort.tile % 300, Math.floor(fort.tile / 300)]);
    expect(cap).toBeLessThan(factory.tile);
    // a coarse tick step later the key changes
    s.tick += 25;
    L.update(frame(s));
    expect(L.computed).toBe(2);
  });
  it('a damaged hub: a broken rail piece, no trains, a repair timer, and the fort is cut', () => {
    const { s, factory, fort } = chain();
    damageHub(s, 1, factory.tile, 2);
    const L = new SupplyLayer();
    L.update(frame(s));
    expect(L.damaged.map((d) => d.tile)).toEqual([factory.tile]);
    expect(L.rails.filter((r) => r.brk)).toHaveLength(2);
    expect(L.rails.every((r) => !r.live)).toBe(true);
    expect(L.cuts[0]?.tiles).toEqual([fort.tile]);
  });
  it('an enemy network shows only where the fog lets you see it', () => {
    const { s } = chain();
    const L = new SupplyLayer();
    L.update(frame(s, { me: 2, visible: () => false, fogGen: 1 }));
    expect(L.rails).toHaveLength(0);
    expect(L.cuts).toHaveLength(0);
    L.update(frame(s, { me: 2, visible: () => true, fogGen: 2 }));
    expect(L.rails).toHaveLength(2);
    L.update(frame(s, { me: 1, visible: () => false, fogGen: 3 }));
    expect(L.rails).toHaveLength(2);
  });
  it('the dirt track between two buildings gives way to a rail: the pair key has no order', () => {
    expect(railPairKey(5, 9)).toBe(railPairKey(9, 5));
    expect(railPairKey(5, 9)).not.toBe(railPairKey(5, 10));
  });
  it('smooths a sim route over own land', () => {
    const W = 40;
    const tiles = [5 * W + 3, 5 * W + 4, 6 * W + 5, 7 * W + 6, 7 * W + 7, 7 * W + 8];
    const r = smoothRoute(tiles, W, { terrain: () => 2, owner: () => 1 }, 1);
    expect(r).not.toBeNull();
    expect(r!.path[0]).toEqual([3.5, 5.5]);
    expect(r!.path[r!.path.length - 1]).toEqual([8.5, 7.5]);
    expect(smoothRoute([4], W, { terrain: () => 2, owner: () => 1 }, 1)).toBeNull();
  });
});

describe('the advisor, the map key and the selectors', () => {
  it('the advisor tip on a one-hub front comes from the sim', () => {
    const { s } = chain();
    s.players[1].gold = 1e6;
    s.players[1].iron = 1e5;
    s.players[1].oil = 1e5;
    expect(supplyNetworkOf(s, 1).hubs.length).toBeGreaterThan(0);
    const tip = suggestions(s, 1).find((t) => t.id === 'supply-second-route');
    expect(tip?.text).toBe('Your eastern front hangs on one hub: build a fort to add a second route');
    expect(tip?.building).toBe('fort');
  });
  it('lists rail, train, convoy, damaged hub and cut front in plain words with units', () => {
    expect(SUPPLY_KEY.map((k) => k.id)).toEqual(['rail', 'train', 'convoy', 'damaged', 'cutfront']);
    const convoy = SUPPLY_KEY.find((k) => k.id === 'convoy')!;
    expect(convoy.text).toContain(`${SUPPLY_LINES.convoySailSeconds} s`);
    expect(SUPPLY_KEY.find((k) => k.id === 'damaged')!.text).toContain('Repair');
    for (const k of SUPPLY_KEY) expect(k.text).not.toMatch(/\u2014/);
  });
  it('keeps the selectors the tests rely on', () => {
    const drawers = readFileSync('src/client/hud/drawers.ts', 'utf8');
    for (const sel of ['overlay-supply', 'overlay-resources', 'supply-toggle']) expect(drawers).toContain(`'${sel}'`);
    const toasts = readFileSync('src/client/hud/toasts.ts', 'utf8');
    expect(toasts).toContain("dataset.test = 'toast'");
    expect(drawers).toContain('SUPPLY_KEY');
  });
});
