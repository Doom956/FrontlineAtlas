// Fighters that matter: they shoot down enemy recon planes on their way out (units.interceptThreats, carriers,
// superiority patrols), and where they guard the sky (airwings.airSuperiorityAt) enemy bombs do less.
import { describe, expect, it } from 'vitest';
import { applyAction } from '../src/sim/actions';
import { aiFighterWant, airState, airSuperiorityAt, fighterCoverOnRoute, fightersOver, raid, supportStrike, updateAir } from '../src/sim/airwings';
import { wingLastResult, strikePreview } from '../src/sim/airstrike';
import { hasIntel, markBuildingsChanged } from '../src/sim/buildings';
import { AIR, FIGHTER_COOLDOWN, TICKS_PER_SECOND } from '../src/sim/config';
import { formAlliance } from '../src/sim/diplomacy';
import { hashState } from '../src/sim/hash';
import { newId } from '../src/sim/state';
import { tick } from '../src/sim/sim';
import { buildAircraft, launchBomber, updateUnits } from '../src/sim/units';
import { updateArsenal } from '../src/sim/variants';
import { aiRecon } from '../src/sim/variantsAI';
import { autoReconAim } from '../src/sim/warTarget';
import type { Building, BuildingType, GameState, TechId, Unit } from '../src/sim/types';
import { strikeToastText } from '../src/client/strikes';
import { airCoverLine } from '../src/client/pillars';
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
function give(s: GameState, id: number, ...techs: TechId[]): void {
  s.players[id].techs.push(...techs);
}
/** Two nations on a 300 x 40 plain: 1 owns x 0..149, 2 owns x 150..299. Rich, with Flight and Recon Planes. */
function skyGame(seed = 5): GameState {
  const s = makeFlatGame(300, 40, 2, { seed });
  claimRect(s, 1, 0, 0, 149, 39);
  claimRect(s, 2, 150, 0, 299, 39);
  for (const p of s.players) {
    if (p.id === 0) continue;
    p.gold = 100000;
    p.iron = 10000;
    p.oil = 10000;
    p.troops = { infantry: 300000, armor: 0, artillery: 0 };
  }
  give(s, 1, 'flight', 'reconPlanes');
  give(s, 2, 'flight', 'reconPlanes');
  return s;
}
function airfield(s: GameState, owner: number, tile: number, bombers: number, fighters: number): Building {
  const b = addBuilding(s, 'airfield', owner, tile);
  for (let k = 0; k < bombers; k++) expect(buildAircraft(s, owner, tile, 'bomber').ok).toBe(true);
  for (let k = 0; k < fighters; k++) expect(buildAircraft(s, owner, tile, 'fighter').ok).toBe(true);
  return b;
}
/** Units, air and recon planes only (no economy or combat), until pred() or maxTicks. */
function run(s: GameState, pred: () => boolean, maxTicks = 2000): void {
  for (let k = 0; k < maxTicks && !pred(); k++) {
    updateUnits(s);
    updateAir(s);
    updateArsenal(s);
    s.tick++;
  }
}
const recon = (s: GameState): Unit | undefined => s.units.find((u) => u.type === 'reconPlane' && u.hp > 0);

describe('fighters shoot down recon planes', () => {
  it('a recon plane flying into enemy fighter cover is shot down on its way and reveals nothing', () => {
    const s = skyGame();
    const af = airfield(s, 1, at(s, 100, 20), 0, 0);
    const guard = airfield(s, 2, at(s, 230, 20), 0, 2);
    const aim = at(s, 185, 20);
    expect(applyAction(s, 1, { type: 'reconFlight', airfield: af.tile, tile: aim }).ok).toBe(true);
    run(s, () => !recon(s));
    expect(s.arsenal?.reveals.length ?? 0).toBe(0);
    expect(hasIntel(s, 1, 2)).toBe(false);
    expect(s.events.some((e) => e.message === `${s.players[2].name}'s fighters shot down a recon plane of ${s.players[1].name}`)).toBe(true);
    // the same cooldown rule as for bombers
    expect(guard.cooldown).toBeGreaterThan(FIGHTER_COOLDOWN / 2 - 1);
  });

  it('flies untouched where no enemy fighters are, and SAM sites leave it alone', () => {
    const s = skyGame();
    const af = airfield(s, 1, at(s, 100, 20), 0, 0);
    airfield(s, 2, at(s, 290, 20), 0, 0); // an airfield with no fighters
    const sam = addBuilding(s, 'sam', 2, at(s, 190, 20));
    const aim = at(s, 185, 20);
    expect(applyAction(s, 1, { type: 'reconFlight', airfield: af.tile, tile: aim }).ok).toBe(true);
    run(s, () => (s.arsenal?.reveals.length ?? 0) > 0);
    expect(s.arsenal!.reveals.length).toBe(1);
    expect(hasIntel(s, 1, 2)).toBe(true);
    expect(sam.cooldown).toBe(0);
    expect(s.events.some((e) => /shot down a recon plane/.test(e.message))).toBe(false);
  });

  it('a superiority patrol catches it too; a plane already on its way home is let go', () => {
    const s = skyGame();
    const af = airfield(s, 1, at(s, 100, 20), 0, 0);
    const far = airfield(s, 2, at(s, 299, 39), 0, 3);
    // far away: its own cover misses the route, its patrol over the front does not
    expect(applyAction(s, 2, { type: 'setAirMission', airfield: far.tile, mission: 'superiority', target: at(s, 170, 20) }).ok).toBe(true);
    s.tick += 2 * TICKS_PER_SECOND; // past the briefing second
    expect(applyAction(s, 1, { type: 'reconFlight', airfield: af.tile, tile: at(s, 160, 20) }).ok).toBe(true);
    run(s, () => !recon(s));
    expect(s.arsenal?.reveals.length ?? 0).toBe(0);
    expect(s.events.some((e) => /fighters shot down a recon plane/.test(e.message))).toBe(true);

    // on the way home: no shot
    const t = skyGame();
    const af2 = airfield(t, 1, at(t, 100, 20), 0, 0);
    expect(applyAction(t, 1, { type: 'reconFlight', airfield: af2.tile, tile: at(t, 160, 20) }).ok).toBe(true);
    run(t, () => recon(t)?.state === 1);
    const g = airfield(t, 2, at(t, 200, 20), 0, 2);
    run(t, () => !recon(t));
    expect(g.cooldown).toBe(0);
    expect(t.arsenal!.reveals.length).toBe(1);
  });

  it('the toast names it in plain words', () => {
    const s = skyGame();
    const me = s.players[1];
    const ev = (message: string) => ({ kind: 'unitLost' as const, message, players: [1, 2], tile: -1, tick: 0 });
    expect(strikeToastText(ev(`${s.players[2].name}'s fighters shot down a recon plane of ${me.name}`), me)?.text).toBe(`${s.players[2].name}'s fighters shot down your recon plane before it got there: nothing revealed`);
    expect(strikeToastText(ev(`${me.name}'s carrier fighters shot down a recon plane of ${s.players[2].name}`), me)?.text).toBe(`Your carrier fighters shot down ${s.players[2].name}'s recon plane: they saw nothing`);
  });
});

describe('air superiority', () => {
  it('needs enough fighters, more than the enemy has there; allies count', () => {
    const s = makeFlatGame(300, 40, 3, { seed: 3 });
    claimRect(s, 1, 0, 0, 149, 39);
    claimRect(s, 2, 150, 0, 249, 39);
    claimRect(s, 3, 250, 0, 299, 39);
    const tile = at(s, 170, 20);
    const one = addBuilding(s, 'airfield', 2, at(s, 200, 20));
    one.fighters = 1;
    expect(airSuperiorityAt(s, 2, 1, tile)).toBe(false); // one fighter is not enough
    one.fighters = AIR.superiorityMinFighters;
    expect(airSuperiorityAt(s, 2, 1, tile)).toBe(true);
    const mine = addBuilding(s, 'airfield', 1, at(s, 120, 20));
    mine.fighters = AIR.superiorityMinFighters;
    expect(fightersOver(s, 1, tile)).toBe(AIR.superiorityMinFighters);
    expect(airSuperiorityAt(s, 2, 1, tile)).toBe(false); // as many enemy fighters: contested
    const ally = addBuilding(s, 'airfield', 3, at(s, 240, 20));
    ally.fighters = 1;
    formAlliance(s, 2, 3);
    expect(fightersOver(s, 2, tile)).toBe(AIR.superiorityMinFighters + 1);
    expect(airSuperiorityAt(s, 2, 1, tile)).toBe(true);
    // a knocked-out airfield guards nothing
    one.disabledUntil = s.tick + 100;
    expect(fightersOver(s, 2, tile)).toBe(1);
  });

  it('cuts support strike kills and the zone, raid income cuts, and says so in the result', () => {
    const strike = (guarded: boolean): { kills: number; strength: number; cut: number; text: string } => {
      const s = skyGame(9);
      const af = airfield(s, 1, at(s, 100, 20), 4, 0);
      // fighters that guard the sky but are busy reloading (no interception in this test)
      if (guarded) airfield(s, 2, at(s, 220, 20), 0, 3).cooldown = 1e6;
      expect(launchBomber(s, 1, af.tile, at(s, 155, 20)).ok).toBe(true);
      const u = s.units[s.units.length - 1];
      u.mission = 1;
      u.x = 155;
      u.y = 20;
      const r = supportStrike(s, u)!;
      expect(r.guarded).toBe(guarded);
      const strength = airState(s).zones[0].strength;
      u.hp = 0;
      // a raid from a second bomber
      expect(launchBomber(s, 1, af.tile, at(s, 200, 20)).ok).toBe(true);
      const v = s.units[s.units.length - 1];
      const cut = raid(s, v, 2).cut;
      v.hp = 0;
      // the full arrival path writes the last result
      expect(launchBomber(s, 1, af.tile, at(s, 160, 20)).ok).toBe(true);
      const w = s.units[s.units.length - 1];
      w.x = 160;
      w.y = 20;
      w.state = 0;
      w.mission = 2;
      updateUnits(s);
      return { kills: r.kills, strength, cut, text: wingLastResult(s, af.tile)?.text ?? '' };
    };
    const free = strike(false);
    const held = strike(true);
    const k = 1 - AIR.superiorityBombCut;
    expect(held.kills).toBeCloseTo(free.kills * k, 3);
    expect(held.strength).toBeCloseTo(free.strength * k, 6);
    expect(held.cut).toBeCloseTo(free.cut * k, 6);
    expect(held.text).toMatch(/enemy fighters guarded the target: 40% less$/);
    expect(free.text).not.toMatch(/fighters/);
  });

  it('the strike preview shows the cut numbers', () => {
    const s = skyGame();
    airfield(s, 1, at(s, 100, 20), 3, 0);
    const before = strikePreview(s, 1, 'bomb', at(s, 152, 20), 1);
    expect(before.guarded).toBe(false);
    addBuilding(s, 'airfield', 2, at(s, 220, 20)).fighters = 3;
    const after = strikePreview(s, 1, 'bomb', at(s, 152, 20), 1);
    expect(after.guarded).toBe(true);
    expect(after.kills).toBeCloseTo(before.kills * (1 - AIR.superiorityBombCut), 3);
  });

  it('the airfield card says what its fighters do, in numbers', () => {
    const s = skyGame();
    const b = addBuilding(s, 'airfield', 1, at(s, 100, 20));
    expect(airCoverLine(s, b)).toMatch(/^No fighters: with 2 here, enemy bombing within 80 tiles does 40% less/);
    b.fighters = 1;
    expect(airCoverLine(s, b)).toBe('Air superiority needs 2 fighters (1 here): then enemy bombing within 80 tiles does 40% less');
    b.fighters = 2;
    expect(airCoverLine(s, b)).toBe('Air superiority: enemy bombing within 80 tiles does 40% less, while their fighters there are fewer');
  });
});

describe('hash and determinism', () => {
  it('the guarded count of a strike result is in hashState', () => {
    const a = skyGame();
    const b = skyGame();
    const af = airfield(a, 1, at(a, 100, 20), 0, 0);
    airfield(b, 1, at(b, 100, 20), 0, 0);
    const res = { airfield: af.id, owner: 1, start: 0, tick: 0, mission: 1, victim: 2, bombers: 2, saved: 0, buildings: 0, kills: 10, gold: 0 };
    airState(a).results = [{ ...res }];
    airState(b).results = [{ ...res }];
    expect(hashState(a)).toBe(hashState(b));
    a.air!.results![0].guarded = 1;
    expect(hashState(a)).not.toBe(hashState(b));
  });

  it('two games fed the same recon and bombing orders under fighter cover stay identical', () => {
    const play = (): number[] => {
      const s = skyGame(21);
      const af = airfield(s, 1, at(s, 100, 20), 5, 1);
      airfield(s, 2, at(s, 220, 10), 2, 3);
      airfield(s, 2, at(s, 210, 30), 0, 2);
      const out: number[] = [];
      for (let k = 0; k < 900; k++) {
        if (k === 5) applyAction(s, 1, { type: 'reconFlight', airfield: af.tile, tile: at(s, 180, 20) });
        if (k === 10) applyAction(s, 1, { type: 'bomb', airfield: af.tile, tile: at(s, 200, 12), count: 3 });
        if (k === 30) applyAction(s, 1, { type: 'setAirMission', airfield: af.tile, mission: 'support', target: at(s, 152, 20) });
        if (k === 60) applyAction(s, 1, { type: 'reconFlight', airfield: af.tile, tile: at(s, 170, 25) });
        tick(s);
        if (k % 100 === 0) out.push(hashState(s));
      }
      out.push(hashState(s));
      return out;
    };
    expect(play()).toEqual(play());
  });
});

describe('the AI and Auto use it', () => {
  it('AI airfields want more fighters where the nations they fight lean on bombers and recon', () => {
    const s = skyGame();
    const mine = airfield(s, 1, at(s, 100, 20), 0, 0);
    const theirs = addBuilding(s, 'airfield', 2, at(s, 200, 20));
    expect(aiFighterWant(s, 1, mine, [2], false)).toBe(0);
    const base = aiFighterWant(s, 1, mine, [2], true);
    expect(base).toBe(AIR.aiFightersBase);
    theirs.bombers = 2 * AIR.aiFightersPerBombers;
    expect(aiFighterWant(s, 1, mine, [2], true)).toBeGreaterThan(base);
    expect(aiFighterWant(s, 1, mine, [2], true)).toBeLessThanOrEqual(AIR.aiFightersMax);
  });

  it('AI recon flies around known enemy fighter cover, from the airfield whose route is clear', () => {
    // a tall map: two own airfields far apart, enemy fighters in the south only
    const s = makeFlatGame(300, 200, 2, { seed: 4 });
    claimRect(s, 1, 0, 0, 149, 199);
    claimRect(s, 2, 150, 0, 299, 199);
    for (const id of [1, 2]) {
      s.players[id].gold = 100000;
      s.players[id].oil = 10000;
      give(s, id, 'flight', 'reconPlanes');
    }
    const north = airfield(s, 1, at(s, 120, 10), 0, 0);
    const south = airfield(s, 1, at(s, 120, 190), 0, 0);
    const guard = addBuilding(s, 'airfield', 2, at(s, 200, 190));
    guard.fighters = 2;
    s.players[2].capital = at(s, 170, 190); // only the south airfield reaches it, through the fighters
    const city = addBuilding(s, 'city', 2, at(s, 170, 10));
    expect(fighterCoverOnRoute(s, 1, south.tile, s.players[2].capital)).toBe(2);
    expect(fighterCoverOnRoute(s, 1, north.tile, city.tile)).toBe(0);
    aiRecon(s, 1, [2]);
    const planes = s.units.filter((u) => u.type === 'reconPlane');
    expect(planes.length).toBe(1);
    expect(planes[0].home).toBe(north.tile);
    expect(planes[0].target).toBe(city.tile);
  });

  it('auto recon waits while every route is guarded, and never stops a flight the player orders', () => {
    const s = skyGame();
    const af = airfield(s, 1, at(s, 100, 20), 0, 0);
    const guard = addBuilding(s, 'airfield', 2, at(s, 220, 20));
    guard.fighters = 2;
    s.players[2].capital = at(s, 240, 20);
    expect(autoReconAim(s, af, 2).guarded).toBe(true);
    guard.fighters = 0;
    expect(autoReconAim(s, af, 2).guarded).toBe(false);
    guard.fighters = 2;
    expect(applyAction(s, 1, { type: 'reconFlight', airfield: af.tile, tile: at(s, 180, 20) }).ok).toBe(true);
  });
});
