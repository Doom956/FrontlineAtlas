// Strikes (airstrike.ts): one strike rule for manual bombs and wing sorties, smart aim ahead of the front and re-aim
// on arrival, smarter strategic raids, last results, salvos, rocket auto-fire, determinism and validation.
import { describe, expect, it } from 'vitest';
import { applyAction } from '../src/sim/actions';
import { autoFireAll, autoFireOn, bombSalvo, leadAim, missileSalvo, strikePreview, strikeRole, wingLastResult } from '../src/sim/airstrike';
import { airRaidIncomeMul, airZones, updateAir, wingOf } from '../src/sim/airwings';
import { markBuildingsChanged } from '../src/sim/buildings';
import { frontTiles } from '../src/sim/combat';
import { AIR, BOMBER_RADIUS, STRIKE, TECH_EFFECTS, TICKS_PER_SECOND } from '../src/sim/config';
import { formAlliance } from '../src/sim/diplomacy';
import { hashState } from '../src/sim/hash';
import { tick } from '../src/sim/sim';
import { newId, setOwner } from '../src/sim/state';
import { buildAircraft, updateUnits } from '../src/sim/units';
import { followedNation } from '../src/sim/warTarget';
import type { Building, BuildingType, GameState, TechId } from '../src/sim/types';
import { validateAction } from '../server/validate';
import { claimRect, makeFlatGame, troopSum } from './helpers';

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

/** 160 x 40 plain: 1 (human) owns x 0..79, 2 owns x 80..159. Rich, with Flight; AIs frozen. */
function game(seed = 7): GameState {
  const s = makeFlatGame(160, 40, 2, { human: true, seed });
  claimRect(s, 1, 0, 0, 79, 39);
  claimRect(s, 2, 80, 0, 159, 39);
  s.admin = { aiPassive: [], godMode: [], aiFrozen: true, revealIntel: [] };
  s.settings.victoryLandShare = 0.99;
  for (const p of s.players) {
    if (p.id === 0) continue;
    p.gold = 1e6;
    p.iron = 1e5;
    p.oil = 1e5;
    p.troops = { infantry: p.id === 1 ? 600000 : 300000, armor: 0, artillery: 0 };
  }
  give(s, 1, 'flight');
  give(s, 2, 'flight');
  return s;
}
function airfield(s: GameState, x: number, y: number, bombers: number, owner = 1): Building {
  const b = addBuilding(s, 'airfield', owner, at(s, x, y), 2);
  for (let k = 0; k < bombers; k++) expect(buildAircraft(s, owner, b.tile, 'bomber').ok).toBe(true);
  return b;
}
/** Units and air only (no combat, economy or AI) until pred() or max ticks. */
function fly(s: GameState, pred: () => boolean, max = 2000): void {
  for (let k = 0; k < max && !pred(); k++) {
    updateUnits(s);
    updateAir(s);
    s.tick++;
  }
}
/** Nation 2 attacks 1 with a token force (a war for support sorties; our own push rate stays 0). */
function warOn(s: GameState): void {
  s.attacks.push({ id: 900, attacker: 2, target: 1, troops: { infantry: 1000, armor: 0, artillery: 0 }, focusTile: at(s, 79, 20), progress: 0, startTick: s.tick, amphibious: false, losses: 0, tilesTaken: 0 });
}
const bombersOut = (s: GameState, owner = 1): number => s.units.filter((u) => u.type === 'bomber' && u.owner === owner && u.hp > 0).length;
const army = (s: GameState, id: number): number => troopSum(s.players[id].troops);

/** Air techs per variant / special case. */
const CASES: Record<string, TechId[]> = {
  plain: [],
  groundAttack: ['groundAttack'],
  heavy: ['heavyBombers'],
  heavyStrategic: ['heavyBombers', 'strategicBombing'],
  night: ['nightBombing'],
};

describe('one strike rule', () => {
  it('a manual bomb on the front is a support strike, on a building or deep land a raid', () => {
    const s = game();
    addBuilding(s, 'factory', 2, at(s, 85, 20));
    expect(strikeRole(s, 1, at(s, 82, 10))).toBe('support');
    expect(strikeRole(s, 1, at(s, 86, 21))).toBe('raid'); // next to a factory
    expect(strikeRole(s, 1, at(s, 120, 10))).toBe('raid'); // deep
    addBuilding(s, 'fort', 2, at(s, 82, 30));
    expect(strikeRole(s, 1, at(s, 82, 30))).toBe('support'); // forts on the front are knocked out by the zone
  });

  for (const [name, techs] of Object.entries(CASES)) {
    it(`manual front strikes do what a support sortie does (${name})`, () => {
      const run = (manual: boolean): { lost: number; zones: { tile: number; strength: number }[] } => {
        const s = game();
        give(s, 1, ...techs);
        s.rng = () => 0.5; // no night scatter
        warOn(s);
        const af = airfield(s, 60, 20, 1);
        const front = at(s, 80, 20);
        const before = army(s, 2);
        if (manual) expect(applyAction(s, 1, { type: 'bomb', airfield: af.tile, tile: front }).ok).toBe(true);
        else expect(applyAction(s, 1, { type: 'setAirMission', airfield: af.tile, mission: 'support', target: front }).ok).toBe(true);
        fly(s, () => bombersOut(s) === 0 && (s.air?.results?.length ?? 0) > 0);
        return { lost: before - army(s, 2), zones: airZones(s).map((z) => ({ tile: z.tile, strength: z.strength })) };
      };
      const m = run(true);
      const w = run(false);
      expect(m.lost).toBeGreaterThan(0);
      expect(m.lost).toBeCloseTo(w.lost, 6);
      expect(m.zones).toEqual(w.zones);
    });

    it(`manual raids do what a strategic sortie does (${name})`, () => {
      const run = (manual: boolean): { lost: number; income: number; city: boolean; gold: number } => {
        const s = game();
        give(s, 1, ...techs);
        s.rng = () => 0.5;
        warOn(s);
        const af = airfield(s, 60, 20, 1);
        const city = addBuilding(s, 'city', 2, at(s, 120, 20));
        const before = army(s, 2);
        if (manual) expect(applyAction(s, 1, { type: 'bomb', airfield: af.tile, tile: city.tile }).ok).toBe(true);
        else expect(applyAction(s, 1, { type: 'setAirMission', airfield: af.tile, mission: 'strategic', target: city.tile, follow: false }).ok).toBe(true);
        fly(s, () => bombersOut(s) === 0 && (s.air?.results?.length ?? 0) > 0);
        return { lost: before - army(s, 2), income: airRaidIncomeMul(s, 2), city: s.buildings.has(city.id), gold: s.players[2].gold };
      };
      const m = run(true);
      const w = run(false);
      expect(m.lost).toBeGreaterThan(0);
      expect(m.income).toBeLessThan(1); // the income raid now comes with manual raids too
      expect(m).toEqual(w);
    });
  }

  it('heavy bombers raid harder and wider; ground-attack planes support harder', () => {
    const cut = (techs: TechId[]): number => {
      const s = game();
      give(s, 1, ...techs);
      airfield(s, 60, 20, 1);
      return strikePreview(s, 1, 'bomb', at(s, 120, 20)).raidCut;
    };
    expect(cut([])).toBeGreaterThan(0);
    expect(cut(['heavyBombers'])).toBeCloseTo(cut([]) * 1.7, 9);
    const s = game();
    give(s, 1, 'heavyBombers');
    airfield(s, 60, 20, 1);
    expect(strikePreview(s, 1, 'bomb', at(s, 120, 20)).radius).toBeCloseTo(BOMBER_RADIUS * STRIKE.heavyRadius, 9);
    const g = game();
    give(g, 1, 'groundAttack');
    airfield(g, 60, 20, 1);
    const p = game();
    airfield(p, 60, 20, 1);
    expect(strikePreview(g, 1, 'bomb', at(g, 80, 20)).kills).toBeCloseTo(strikePreview(p, 1, 'bomb', at(p, 80, 20)).kills * 1.6, 6);
  });

  it('a scattered night drop still hits the enemy land in the radius', () => {
    const s = game();
    give(s, 1, 'nightBombing');
    s.rng = () => 0; // scatter -4, -4: the centre lands on own land at the border
    const af = airfield(s, 60, 20, 1);
    const before = army(s, 2);
    expect(applyAction(s, 1, { type: 'bomb', airfield: af.tile, tile: at(s, 81, 24) }).ok).toBe(true);
    fly(s, () => bombersOut(s) === 0 && af.bombers === 1);
    expect(army(s, 2)).toBeLessThan(before);
  });

  it('manual bombs have the airfield reach (heavy bombers x1.5)', () => {
    const s = game();
    const af = airfield(s, 2, 20, 1);
    af.level = 1;
    const far = at(s, 2 + AIR.range + 5, 20);
    expect(applyAction(s, 1, { type: 'bomb', airfield: af.tile, tile: far }).reason).toMatch(/Too far/);
    give(s, 1, 'heavyBombers');
    expect(applyAction(s, 1, { type: 'bomb', airfield: af.tile, tile: far }).ok).toBe(true);
  });
});

describe('smart aim', () => {
  it('leads a running push: the aim is past the front, on enemy land', () => {
    const s = game();
    const front = at(s, 80, 20);
    expect(leadAim(s, 1, 2, front, at(s, 20, 20)) % s.map.width).toBeGreaterThanOrEqual(80 + STRIKE.leadMargin - STRIKE.leadPick);
    // A fast push (tiles per second along a 40-tile border) leads further.
    s.attacks.push({ id: 999, attacker: 1, target: 2, troops: { infantry: 1000, armor: 0, artillery: 0 }, focusTile: front, progress: 0, startTick: s.tick - 10 * TICKS_PER_SECOND, amphibious: false, losses: 0, tilesTaken: 400 });
    const slow = leadAim(s, 1, 2, front, at(s, 75, 20)) % s.map.width;
    const fast = leadAim(s, 1, 2, front, at(s, 5, 20)) % s.map.width;
    expect(fast).toBeGreaterThan(slow);
    expect(s.map.owner[at(s, fast, 20)]).toBe(2);
  });

  it('re-aims on arrival when the aim was taken meanwhile, and never drops on own or allied land', () => {
    const s = game();
    const af = airfield(s, 40, 20, 2);
    expect(applyAction(s, 1, { type: 'bomb', airfield: af.tile, tile: at(s, 82, 20), count: 1 }).ok).toBe(true);
    // The push takes x 80..87 before the bomber gets there.
    for (let y = 0; y < 40; y++) for (let x = 80; x <= 87; x++) setOwner(s, at(s, x, y), 1);
    const before = army(s, 2);
    fly(s, () => bombersOut(s) === 0);
    const z = airZones(s);
    expect(z.length).toBe(1);
    expect(s.map.owner[z[0].tile]).toBe(2);
    expect(army(s, 2)).toBeLessThan(before);
    expect(af.bombers).toBe(2);
  });

  it('flies home with its bombs when no enemy land is near the aim any more', () => {
    const s = game();
    const af = airfield(s, 40, 20, 1);
    expect(applyAction(s, 1, { type: 'bomb', airfield: af.tile, tile: at(s, 82, 20) }).ok).toBe(true);
    for (let y = 0; y < 40; y++) for (let x = 80; x <= 110; x++) setOwner(s, at(s, x, y), 1);
    const before = army(s, 2);
    fly(s, () => bombersOut(s) === 0);
    expect(airZones(s).length).toBe(0);
    expect(army(s, 2)).toBe(before);
    expect(af.bombers).toBe(1);
    const r = wingLastResult(s, af.tile);
    expect(r?.result.saved).toBe(1);
    expect(r?.text).toMatch(/came back/);
  });

  it('an aim that became allied land is re-aimed too', () => {
    const s = makeFlatGame(160, 40, 3, { human: true, seed: 3 });
    claimRect(s, 1, 0, 0, 79, 39);
    claimRect(s, 2, 80, 0, 159, 19);
    claimRect(s, 3, 80, 20, 159, 39);
    give(s, 1, 'flight');
    Object.assign(s.players[1], { gold: 1e6, iron: 1e5, oil: 1e5 });
    const af = airfield(s, 40, 20, 1);
    expect(applyAction(s, 1, { type: 'bomb', airfield: af.tile, tile: at(s, 100, 18) }).ok).toBe(true);
    formAlliance(s, 1, 2);
    fly(s, () => bombersOut(s) === 0);
    for (const e of s.effects.filter((x) => x.kind === 'explosion')) {
      const o = s.map.owner[Math.floor(e.y) * s.map.width + Math.floor(e.x)];
      expect(o).toBe(3);
    }
  });

  it('a support wing following a moving push wastes no payload on taken land', () => {
    const s = game();
    give(s, 1, 'groundAttack');
    s.players[1].troops.infantry = 3e6;
    const af = airfield(s, 50, 20, 6);
    expect(applyAction(s, 1, { type: 'setAirMission', airfield: af.tile, mission: 'support' }).ok).toBe(true);
    let drops = 0;
    let bad = 0;
    let followed = 0;
    for (let k = 0; k < 80 * TICKS_PER_SECOND; k++) {
      // Keep pushing: a fresh attack whenever the last one ran out.
      if (!s.attacks.some((a) => a.attacker === 1 && a.target === 2)) {
        const border = frontTiles(s, 1, 2);
        if (border.length) applyAction(s, 1, { type: 'attack', tile: border[(k * 7) % border.length], troops: { infantry: 120000, armor: 0, artillery: 0 } });
      }
      const t0 = s.tick;
      tick(s);
      if (followedNation(s, 1) === 2) followed++;
      for (const e of s.effects) {
        if (e.tick !== t0 || e.kind !== 'explosion') continue;
        drops++;
        const o = s.map.owner[Math.floor(e.y) * s.map.width + Math.floor(e.x)];
        if (o !== 2) bad++;
      }
    }
    expect(followed).toBeGreaterThan(60 * TICKS_PER_SECOND);
    expect(drops).toBeGreaterThan(5);
    expect(bad).toBe(0);
  });
});

describe('better auto', () => {
  it('a strategic wing spreads over different targets and a bomber whose target is gone takes another', () => {
    const s = game();
    warOn(s);
    s.rng = () => 0.99; // bombs miss: the buildings stay to check the aims
    const af = airfield(s, 60, 20, 4);
    const cities = [at(s, 110, 10), at(s, 110, 20), at(s, 110, 30)].map((t) => addBuilding(s, 'city', 2, t));
    addBuilding(s, 'factory', 2, at(s, 130, 20));
    expect(applyAction(s, 1, { type: 'setAirMission', airfield: af.tile, mission: 'strategic', target: cities[1].tile, follow: false }).ok).toBe(true);
    fly(s, () => bombersOut(s) > 0);
    const aims = s.units.filter((u) => u.type === 'bomber').map((u) => u.target);
    expect(aims.length).toBe(4);
    expect(new Set(aims).size).toBe(4); // one target each
    // A city destroyed while the bombers fly: its bomber takes another raid target near it.
    const gone = cities.find((c) => aims.includes(c.tile))!;
    s.buildings.delete(gone.id);
    s.map.building[gone.tile] = 0;
    markBuildingsChanged(s);
    const u = s.units.find((x) => x.target === gone.tile)!;
    s.units = [u]; // only this bomber's drop below
    let centre = -1;
    for (let k = 0; k < 400 && u.state === 0; k++) {
      const t0 = s.tick;
      updateUnits(s);
      updateAir(s);
      s.tick++;
      if ((u.state as number) === 1) {
        const e = s.effects.filter((x) => x.tick === t0 && x.kind === 'explosion');
        centre = e.length ? Math.floor(e[e.length - 1].y) * s.map.width + Math.floor(e[e.length - 1].x) : -1;
      }
    }
    expect(centre).not.toBe(gone.tile);
    expect(cities.filter((c) => c !== gone).map((c) => c.tile)).toContain(centre);
    fly(s, () => bombersOut(s) === 0);
    expect(wingLastResult(s, af.tile)?.text).toMatch(/^Last raid: 0 buildings hit in /);
  });

  it('re-buy losses works on an idle airfield (manual strikes, Air cover)', () => {
    const s = game();
    const af = airfield(s, 60, 20, 0);
    expect(applyAction(s, 1, { type: 'setAirMission', airfield: af.tile, mission: 'idle', refill: true }).ok).toBe(true);
    expect(wingOf(s, af)?.refill).toBe(true);
    fly(s, () => af.bombers >= 3, 200);
    expect(af.bombers).toBeGreaterThanOrEqual(3);
  });
});

describe('salvos', () => {
  it('bombers: at most `count` from the airfields that reach the target, nearest first; 0 = all', () => {
    const s = game();
    const a = airfield(s, 70, 20, 2);
    const b = airfield(s, 50, 20, 2);
    const far = airfield(s, 2, 2, 2);
    far.level = 1;
    const target = at(s, 155, 20);
    expect(strikePreview(s, 1, 'bomb', target, 3).launchers).toBe(3);
    expect(bombSalvo(s, 1, -1, target, 3).ok).toBe(true);
    expect(bombersOut(s)).toBe(3);
    expect(a.bombers).toBe(0);
    expect(b.bombers).toBe(1);
    expect(far.bombers).toBe(2);
    expect(strikePreview(s, 1, 'bomb', target, 0).launchers).toBe(1);
    expect(bombSalvo(s, 1, -1, target, 0).ok).toBe(true);
    expect(bombersOut(s)).toBe(4);
    expect(far.bombers).toBe(2);
    expect(bombSalvo(s, 1, -1, target, 0).reason).toMatch(/reaches that far/);
  });

  it('rockets: `count` launches over the ready silos; stops when it cannot pay; atom bombs too', () => {
    const s = game();
    give(s, 1, 'rocketry', 'nuclearFission');
    addBuilding(s, 'silo', 1, at(s, 70, 10), 2);
    addBuilding(s, 'silo', 1, at(s, 70, 30), 1);
    const t = at(s, 120, 20);
    expect(strikePreview(s, 1, 'rocket', t, 2).launchers).toBe(2);
    expect(missileSalvo(s, 1, -1, 'rocket', t, 2).ok).toBe(true);
    expect(s.units.filter((u) => u.type === 'rocket').length).toBe(2);
    expect(strikePreview(s, 1, 'rocket', t, 0).launchers).toBe(1);
    s.players[1].gold = 0;
    expect(missileSalvo(s, 1, -1, 'rocket', t, 0).ok).toBe(false);
    s.players[1].gold = 1e6;
    expect(missileSalvo(s, 1, -1, 'atomBomb', t, 0).ok).toBe(true);
    expect(s.units.filter((u) => u.type === 'atomBomb').length).toBe(1);
  });

  it('the preview is a pure read and matches the real numbers', () => {
    const s = game();
    give(s, 1, 'heavyBombers', 'strategicBombing');
    airfield(s, 60, 20, 3);
    const city = addBuilding(s, 'city', 2, at(s, 120, 20));
    const h = hashState(s);
    const p = strikePreview(s, 1, 'bomb', city.tile, 3);
    expect(hashState(s)).toBe(h);
    expect(p.ok).toBe(true);
    expect(p.role).toBe('raid');
    expect(p.radius).toBeCloseTo(BOMBER_RADIUS * TECH_EFFECTS.strategicRadius * STRIKE.heavyRadius, 9);
    expect(p.launchers).toBe(3);
    expect(p.enemyBuildings).toBe(1);
    expect(p.goldBurn).toBeGreaterThan(0);
    expect(p.raidCut).toBeGreaterThan(0);
    expect(strikePreview(s, 1, 'bomb', at(s, 10, 10)).reason).toBe('That is your own land');
  });
});

describe('rocket auto-fire', () => {
  function war(): GameState {
    const s = game();
    give(s, 1, 'rocketry', 'nuclearFission');
    const border = frontTiles(s, 1, 2);
    expect(applyAction(s, 1, { type: 'attack', tile: border[Math.floor(border.length / 2)], troops: { infantry: 50000, armor: 0, artillery: 0 } }).ok).toBe(true);
    for (let k = 0; k < 3 * TICKS_PER_SECOND; k++) tick(s);
    expect(followedNation(s, 1)).toBe(2);
    return s;
  }
  it('is off by default; on, ready silos fire rockets at forts near the front first, never atom bombs', () => {
    const s = war();
    const silo = addBuilding(s, 'silo', 1, at(s, 40, 20), 2);
    const fort = addBuilding(s, 'fort', 2, at(s, 95, 20));
    addBuilding(s, 'city', 2, at(s, 100, 5));
    for (let k = 0; k < 2 * TICKS_PER_SECOND; k++) tick(s);
    expect(s.units.some((u) => u.type === 'rocket')).toBe(false);
    expect(applyAction(s, 1, { type: 'setAutoFire', silo: -1, on: true }).ok).toBe(true);
    expect(autoFireOn(s, silo.tile)).toBe(true);
    expect(autoFireAll(s, 1)).toBe(true);
    for (let k = 0; k < 2 * TICKS_PER_SECOND && !s.units.some((u) => u.type === 'rocket'); k++) tick(s);
    const rockets = s.units.filter((u) => u.type === 'rocket');
    expect(rockets.length).toBe(2); // one per target: the fort, then the city
    expect(rockets[0].target).toBe(fort.tile);
    expect(s.units.some((u) => u.type === 'atomBomb')).toBe(false);
    // One silo off while all are on: the others stay on.
    const other = addBuilding(s, 'silo', 1, at(s, 40, 30), 1);
    expect(applyAction(s, 1, { type: 'setAutoFire', silo: silo.tile, on: false }).ok).toBe(true);
    expect(autoFireOn(s, silo.tile)).toBe(false);
    expect(autoFireOn(s, other.tile)).toBe(true);
    expect(autoFireAll(s, 1)).toBe(false);
  });

  it('needs Rocketry and an own silo', () => {
    const s = game();
    expect(applyAction(s, 1, { type: 'setAutoFire', silo: -1, on: true }).reason).toMatch(/Rocketry/);
    give(s, 1, 'rocketry');
    const enemy = addBuilding(s, 'silo', 2, at(s, 120, 20));
    expect(applyAction(s, 1, { type: 'setAutoFire', silo: enemy.tile, on: true }).ok).toBe(false);
  });
});

describe('determinism and validation', () => {
  it('two identical games with salvos, auto-fire and a support wing give the same hash; the hash covers the new state', () => {
    const play = (): GameState => {
      const s = game(21);
      give(s, 1, 'rocketry', 'heavyBombers');
      s.admin!.aiFrozen = false;
      const af = airfield(s, 60, 20, 4);
      addBuilding(s, 'silo', 1, at(s, 40, 20), 2);
      addBuilding(s, 'fort', 2, at(s, 95, 20));
      addBuilding(s, 'city', 2, at(s, 120, 10));
      const border = frontTiles(s, 1, 2);
      applyAction(s, 1, { type: 'attack', tile: border[5], troops: { infantry: 200000, armor: 0, artillery: 0 } });
      applyAction(s, 1, { type: 'setAutoFire', silo: -1, on: true });
      applyAction(s, 1, { type: 'bomb', airfield: -1, tile: at(s, 120, 10), count: 2 });
      applyAction(s, 1, { type: 'setAirMission', airfield: af.tile, mission: 'support' });
      for (let k = 0; k < 40 * TICKS_PER_SECOND; k++) tick(s);
      return s;
    };
    const a = play();
    const b = play();
    expect(hashState(a)).toBe(hashState(b));
    expect(a.air?.results?.length ?? 0).toBeGreaterThan(0);
    const h = hashState(a);
    a.air!.results![0].kills += 1;
    expect(hashState(a)).not.toBe(h);
    a.air!.results![0].kills -= 1;
    a.follow!.fireAll = [];
    expect(hashState(a)).not.toBe(h);
  });

  it('the server accepts salvos and auto-fire, and refuses bad counts', () => {
    expect(validateAction({ type: 'bomb', airfield: -1, tile: 5, count: 3, junk: 1 })).toEqual({ ok: true, value: { type: 'bomb', airfield: -1, tile: 5, count: 3 } });
    expect(validateAction({ type: 'bomb', airfield: 7, tile: 5 })).toEqual({ ok: true, value: { type: 'bomb', airfield: 7, tile: 5 } });
    expect(validateAction({ type: 'bomb', airfield: 7, tile: 5, count: 0 }).ok).toBe(true);
    expect(validateAction({ type: 'bomb', airfield: 7, tile: 5, count: STRIKE.maxSalvo + 1 }).ok).toBe(false);
    expect(validateAction({ type: 'bomb', airfield: 7, tile: 5, count: 1.5 }).ok).toBe(false);
    expect(validateAction({ type: 'bomb', airfield: -2, tile: 5 }).ok).toBe(false);
    expect(validateAction({ type: 'launchMissile', silo: -1, kind: 'rocket', tile: 5, count: 4 }).ok).toBe(true);
    expect(validateAction({ type: 'launchMissile', silo: -1, kind: 'rocket', tile: 5, count: -1 }).ok).toBe(false);
    expect(validateAction({ type: 'setAutoFire', silo: -1, on: true })).toEqual({ ok: true, value: { type: 'setAutoFire', silo: -1, on: true } });
    expect(validateAction({ type: 'setAutoFire', silo: 3 }).ok).toBe(false);
  });
});
