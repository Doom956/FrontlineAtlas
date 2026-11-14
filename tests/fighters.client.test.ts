// Fighters in the picture (fx/fighters.ts): the fighters drawn over an airfield follow how many it holds, a superiority
// patrol flies its patrol circle, fog of war hides other nations' fighters (never your own), carriers carry their wing,
// and a real interception by the sim starts a sortie that flies in past the kill and home again.
import { describe, expect, it } from 'vitest';
import { applyAction } from '../src/sim/actions';
import { airPatrolRadius } from '../src/sim/airwings';
import { markBuildingsChanged } from '../src/sim/buildings';
import { tick } from '../src/sim/sim';
import { newId } from '../src/sim/state';
import type { Building, BuildingType, GameState } from '../src/sim/types';
import { launchBomber } from '../src/sim/units';
import { CARRIER_FIGHTERS, FighterFx, MAX_PER_BASE, type FighterSight } from '../src/client/fx/fighters';
import { claimRect, makeFlatGame } from './helpers';

const at = (s: GameState, x: number, y: number): number => y * s.map.width + x;

/** W x 30 of land: player 1 the west half, player 2 the east half. */
function landGame(W = 80): GameState {
  const s = makeFlatGame(W, 30, 2, { human: true, seed: 5 });
  claimRect(s, 1, 0, 0, W / 2 - 1, 29);
  claimRect(s, 2, W / 2, 0, W - 1, 29);
  s.admin = { aiPassive: [], godMode: [], aiFrozen: true, revealIntel: [] };
  s.settings.victoryLandShare = 0.99;
  for (const p of s.players) {
    if (p.id === 0) continue;
    p.gold = 1e6;
    p.iron = 1e5;
    p.oil = 1e5;
    p.techs.push('flight');
  }
  return s;
}

function addBuilding(s: GameState, type: BuildingType, owner: number, tile: number): Building {
  const id = newId(s);
  const b: Building = { id, type, owner, tile, level: 1, buildLeft: 0, upgradeLeft: 0, fighters: 0, bombers: 0, cooldown: 0, dropCooldown: 0, disabledUntil: 0, hp: 1, queuedLevels: 0 };
  s.buildings.set(id, b);
  s.map.building[tile] = id + 1;
  markBuildingsChanged(s);
  return b;
}

const flightsOf = (f: FighterFx, owner: number) => f.flights.slice(0, f.count).filter((q) => q.owner === owner);
const sight = (visible: (tile: number) => boolean): FighterSight => ({ active: true, visible });

describe('fighters over their airfields', () => {
  it('draws as many as the airfield holds, up to a few', () => {
    const s = landGame();
    const b = addBuilding(s, 'airfield', 1, at(s, 10, 15));
    const f = new FighterFx();
    for (const [held, drawn] of [
      [0, 0],
      [1, 1],
      [2, 2],
      [3, 3],
      [9, MAX_PER_BASE],
    ]) {
      b.fighters = held;
      f.layout(s, 1, 100, 1000);
      expect(flightsOf(f, 1).length, `${held} fighters held`).toBe(drawn);
    }
    // an airfield still being built, or knocked out, shows none
    b.fighters = 3;
    b.buildLeft = 50;
    f.layout(s, 1, 100, 1000);
    expect(flightsOf(f, 1).length).toBe(0);
  });

  it('circles close over an idle airfield and moves round it as the game runs (and not while it is paused)', () => {
    const s = landGame();
    const b = addBuilding(s, 'airfield', 1, at(s, 10, 15));
    b.fighters = 2;
    const f = new FighterFx();
    f.layout(s, 1, 100, 1000);
    const a = flightsOf(f, 1).map((q) => ({ x: q.tx, y: q.ty }));
    for (const p of a) expect(Math.hypot(p.x - 10.5, p.y - 15.5)).toBeLessThan(5);
    // the same game clock: the same place; later: moved on
    f.layout(s, 1, 100, 9999);
    expect(flightsOf(f, 1).map((q) => ({ x: q.tx, y: q.ty }))).toEqual(a);
    f.layout(s, 1, 130, 1000);
    expect(Math.hypot(flightsOf(f, 1)[0].tx - a[0].x, flightsOf(f, 1)[0].ty - a[0].y)).toBeGreaterThan(0.5);
  });

  it('flies the superiority patrol circle round its centre instead', () => {
    const s = landGame();
    const b = addBuilding(s, 'airfield', 1, at(s, 10, 15));
    b.fighters = 3;
    const centre = at(s, 22, 12);
    const r = applyAction(s, 1, { type: 'setAirMission', airfield: b.tile, mission: 'superiority', target: centre });
    expect(r.ok).toBe(true);
    const wing = s.air!.wings.find((w) => w.airfield === b.id)!;
    const cx = (wing.target % s.map.width) + 0.5;
    const cy = Math.floor(wing.target / s.map.width) + 0.5;
    const R = airPatrolRadius(b, s);
    const f = new FighterFx();
    for (const t of [100, 160, 240]) {
      f.layout(s, 1, t, 1000);
      const fl = flightsOf(f, 1);
      expect(fl.length).toBe(3);
      for (const q of fl) {
        expect(q.kind).toBe('patrol');
        // on the circle, just inside the patrol ring
        const d = Math.hypot(q.tx - cx, q.ty - cy);
        expect(d).toBeGreaterThan(R * 0.7);
        expect(d).toBeLessThanOrEqual(R);
      }
    }
    // back to idle: over the field again
    applyAction(s, 1, { type: 'setAirMission', airfield: b.tile, mission: 'idle' });
    f.layout(s, 1, 300, 1000);
    for (const q of flightsOf(f, 1)) expect(Math.hypot(q.tx - 10.5, q.ty - 15.5)).toBeLessThan(5);
  });

  it('hides other nations fighters in the fog, never your own or an ally', () => {
    const s = landGame();
    const mine = addBuilding(s, 'airfield', 1, at(s, 10, 15));
    const theirs = addBuilding(s, 'airfield', 2, at(s, 60, 15));
    mine.fighters = 2;
    theirs.fighters = 3;
    const f = new FighterFx();
    // no fog: everyone's
    f.layout(s, 1, 100, 1000);
    expect(flightsOf(f, 2).length).toBe(3);
    // fog, nothing in view: only mine
    f.fog = sight(() => false);
    f.layout(s, 1, 100, 1000);
    expect(flightsOf(f, 1).length).toBe(2);
    expect(flightsOf(f, 2).length).toBe(0);
    // fog, their side in view: theirs too
    f.fog = sight((tile) => tile % s.map.width >= 40);
    f.layout(s, 1, 100, 1000);
    expect(flightsOf(f, 2).length).toBe(3);
    // fog off again (the rule is off): everyone's
    f.fog = { active: false, visible: () => false };
    f.layout(s, 1, 100, 1000);
    expect(flightsOf(f, 2).length).toBe(3);
  });

  it('flies a carrier wing round the ship', () => {
    const s = landGame();
    for (let y = 0; y < 30; y++) for (let x = 0; x < 80; x++) s.map.terrain[at(s, x, y)] = 0;
    s.units.push({ id: newId(s), type: 'warship', variant: 'carrier', owner: 1, x: 30, y: 10, hp: 10 } as unknown as GameState['units'][number]);
    const f = new FighterFx();
    f.layout(s, 1, 100, 1000);
    const fl = flightsOf(f, 1);
    expect(fl.length).toBe(CARRIER_FIGHTERS);
    for (const q of fl) {
      expect(q.kind).toBe('carrier');
      expect(Math.hypot(q.tx - 30.5, q.ty - 10.5)).toBeLessThan(5);
    }
  });
});

describe('interceptions', () => {
  it('sends a fighter in past a bomber the sim shot down, and home again', () => {
    // far apart: the bomber flies a while before it reaches the enemy field's fighters
    const s = landGame(200);
    const home = addBuilding(s, 'airfield', 1, at(s, 4, 15));
    home.bombers = 2;
    const field = addBuilding(s, 'airfield', 2, at(s, 140, 15));
    field.fighters = 3;
    const f = new FighterFx();
    let now = 0;
    const r = launchBomber(s, 1, home.tile, at(s, 140, 14));
    expect(r.ok).toBe(true);
    f.update(s, now);
    tick(s);
    now += 100;
    f.update(s, now);
    expect(s.units.some((u) => u.type === 'bomber')).toBe(true);
    let kill = -1;
    for (let k = 0; k < 600 && kill < 0; k++) {
      tick(s);
      now += 100;
      f.update(s, now);
      if (f.launched > 0) kill = now;
    }
    expect(kill).toBeGreaterThan(0);
    // the sortie is theirs and stays in sight all the way: in, round and home (fading only at the end)
    const seen: { x: number; y: number; alpha: number }[] = [];
    for (let t = 0; t < 2600; t += 100) {
      f.layout(s, 1, 100, kill + t);
      const sortie = f.flights.slice(0, f.count).find((q) => q.kind === 'sortie');
      expect(sortie, `sortie at ${t} ms`).toBeTruthy();
      expect(sortie!.owner).toBe(2);
      seen.push({ x: sortie!.tx, y: sortie!.ty, alpha: sortie!.alpha });
    }
    expect(seen.some((p) => p.alpha === 1)).toBe(true);
    // it fires on its way in
    let fired = false;
    for (let t = 0; t < 1000; t += 50) {
      f.layout(s, 1, 100, kill + t);
      if (f.flights.slice(0, f.count).some((q) => q.kind === 'sortie' && q.firing)) fired = true;
    }
    expect(fired).toBe(true);
    // and then it is gone
    f.layout(s, 1, 100, kill + 3000);
    expect(f.flights.slice(0, f.count).some((q) => q.kind === 'sortie')).toBe(false);
  });
});
