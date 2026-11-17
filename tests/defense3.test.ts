// Defense part 3: Defense Mastery (Counteroffensive meter, launch and push, Hardened shelters), Anti-radar Missiles
// (the radar-on lock, the knock-out, SAMs shooting them, escort mode), the stealth bomber's new niche (silo hunter
// with loaded atom bombs, clean strikes, multi-target), cruise missiles (sea-skimming, anti-ship), hash and determinism.
import { describe, expect, it } from 'vitest';
import { applyAction } from '../src/sim/actions';
import { ARSENAL_ROWS, MASTERY_TECHS } from '../src/sim/arsenal';
import { markBuildingsChanged } from '../src/sim/buildings';
import { ANTI_RADAR, ATOM_SILO_SLOTS, COUNTER, CRUISE, STEALTH, TICKS_PER_SECOND } from '../src/sim/config';
import { tileFightCost, updateAttacks } from '../src/sim/combat';
import { counterBlock, counterMeter, shelterPreview } from '../src/sim/counter';
import { antiRadarReason, updateAntiRadar } from '../src/sim/antiRadar';
import { hashState } from '../src/sim/hash';
import { computeCoastAndLand } from '../src/sim/mapgen';
import { arsenalPrice } from '../src/sim/procurement';
import { newId } from '../src/sim/state';
import { launchMissile, stealthAimsReason, updateUnits } from '../src/sim/units';
import { cruisePreview } from '../src/sim/cruise';
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
/** 160x40: player 1 x 0..69, sea x 70..89, player 2 x 90..159; AIs frozen, rich. `sea` = false: one land mass, the border at x 79 / 80. */
function game(sea = true, seed = 7): GameState {
  const s = makeFlatGame(160, 40, 2, { human: true, seed });
  if (sea) for (let y = 0; y < 40; y++) for (let x = 70; x < 90; x++) s.map.terrain[at(s, x, y)] = Terrain.DeepWater;
  computeCoastAndLand(s.map);
  if (sea) {
    claimRect(s, 1, 0, 0, 69, 39);
    claimRect(s, 2, 90, 0, 159, 39);
  } else {
    claimRect(s, 1, 0, 0, 79, 39);
    claimRect(s, 2, 80, 0, 159, 39);
  }
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
function run(s: GameState, n: number, f: (s: GameState) => void): void {
  for (let k = 0; k < n; k++) {
    f(s);
    s.tick++;
  }
}
/** updateUnits until no unit of these types flies (at most n ticks). */
function fly(s: GameState, types: Unit['type'][], n = 1200): void {
  for (let k = 0; k < n && s.units.some((u) => types.includes(u.type) && u.hp > 0); k++) {
    updateUnits(s);
    s.tick++;
  }
}

describe('Defense Mastery: the row and the price', () => {
  it('is the Defense row mastery (tier 4) at 25000 gold + 8000 iron + 2000 oil, 45 s; Anti-radar is an Air special', () => {
    const def = ARSENAL_ROWS.find((r) => r.pillar === 'defense')!;
    const m = def.items.find((i) => i.tech === 'defenseMastery')!;
    expect(m.tier).toBe(4);
    expect(m.kind).toBe('mastery');
    expect(MASTERY_TECHS.defense).toBe('defenseMastery');
    const s = game();
    const p = arsenalPrice(s, 1, 'defenseMastery');
    expect([p.gold, p.iron, p.oil, p.seconds]).toEqual([25000, 8000, 2000, 45]);
    const air = ARSENAL_ROWS.find((r) => r.pillar === 'air')!;
    expect(air.items.find((i) => i.tech === 'antiRadar')).toMatchObject({ tier: 3, kind: 'special' });
  });
});

describe('Counteroffensive', () => {
  /** p2 holds a fort at the border (x 85); p1 attacks. */
  function fortGame(mastery = true): { s: GameState; fort: Building } {
    const s = game(false);
    give(s, 2, 'fortification');
    if (mastery) give(s, 2, 'defenseMastery');
    const fort = addBuilding(s, 'fort', 2, at(s, 86, 20), 2);
    s.players[1].troops = { infantry: 200000, armor: 0, artillery: 0 };
    s.players[2].troops = { infantry: 60000, armor: 0, artillery: 0 };
    return { s, fort };
  }

  it('enemy losses on fortified land fill the meter and name the attacker; no mastery, no meter', () => {
    const { s } = fortGame();
    expect(applyAction(s, 1, { type: 'attack', tile: at(s, 80, 20), troops: { infantry: 120000, armor: 0, artillery: 0 } }).ok).toBe(true);
    run(s, 60, updateAttacks);
    expect(counterMeter(s, 2)).toBeGreaterThan(0);
    expect(s.players[2].counterFoe).toBe(1);
    const b = fortGame(false).s;
    applyAction(b, 1, { type: 'attack', tile: at(b, 80, 20), troops: { infantry: 120000, armor: 0, artillery: 0 } });
    run(b, 60, updateAttacks);
    expect(counterMeter(b, 2)).toBe(0);
  });

  it('an attack that runs dry on fortified land adds the fail bonus', () => {
    const { s } = fortGame();
    applyAction(s, 1, { type: 'attack', tile: at(s, 80, 20), troops: { infantry: 600, armor: 0, artillery: 0 } });
    run(s, 200, updateAttacks);
    expect(s.attacks.length).toBe(0);
    expect(counterMeter(s, 2)).toBeGreaterThanOrEqual(COUNTER.failBonus);
  });

  it('the button says why it is off; full, it launches a push that is faster and cheaper, then the meter is empty', () => {
    const { s } = fortGame();
    const p2 = s.players[2];
    p2.counterMeter = 0.6;
    p2.counterFoe = 1;
    expect(counterBlock(s, 2)).toMatch(/^Meter 60%/);
    p2.counterMeter = 1;
    expect(counterBlock(s, 2)).toBe('');
    const tile = at(s, 78, 20);
    const troops = { infantry: 10000, armor: 0, artillery: 0 };
    const before = tileFightCost(s, 2, troops, 1, tile).loss;
    s.admin!.aiFrozen = false;
    expect(applyAction(s, 2, { type: 'counteroffensive' }).ok).toBe(true);
    expect(s.attacks.some((a) => a.attacker === 2 && a.target === 1)).toBe(true);
    expect(p2.counterMeter).toBe(0);
    expect(p2.counterUntil).toBe(s.tick + COUNTER.seconds * TICKS_PER_SECOND);
    expect(s.effects.some((e) => e.kind === 'counterPush')).toBe(true);
    expect(tileFightCost(s, 2, troops, 1, tile).loss).toBeCloseTo(before * COUNTER.lossMul, 6);
    expect(counterBlock(s, 2)).toMatch(/under way/);
    s.tick += COUNTER.seconds * TICKS_PER_SECOND;
    expect(tileFightCost(s, 2, troops, 1, tile).loss).toBeCloseTo(before, 6);
  });

  it('meter, foe and window are hashed', () => {
    const { s } = fortGame();
    const h0 = hashState(s);
    s.players[2].counterMeter = 0.5;
    const h1 = hashState(s);
    expect(h1).not.toBe(h0);
    s.players[2].counterFoe = 1;
    const h2 = hashState(s);
    expect(h2).not.toBe(h1);
    s.players[2].counterUntil = 99;
    expect(hashState(s)).not.toBe(h2);
  });
});

describe('Hardened shelters', () => {
  function nuke(mastery: boolean): { s: GameState; city: Building; fort: Building } {
    const s = game(true, 11);
    give(s, 2, 'fortification');
    if (mastery) give(s, 2, 'defenseMastery');
    const fort = addBuilding(s, 'fort', 2, at(s, 120, 20));
    const city = addBuilding(s, 'city', 2, at(s, 124, 20));
    s.players[2].troops = { infantry: 100000, armor: 0, artillery: 0 };
    unit(s, 'atomBomb', 1, 120, 20, { hp: 2, target: at(s, 122, 20), targetOwner: 2 });
    return { s, city, fort };
  }
  it('atom bombs do half damage to troops and buildings a fort of the owner covers', () => {
    const a = nuke(false);
    const b = nuke(true);
    expect(shelterPreview(a.s, at(a.s, 122, 20), 12).tiles).toBe(0);
    expect(shelterPreview(b.s, at(b.s, 122, 20), 12).buildings).toBe(2);
    fly(a.s, ['atomBomb']);
    fly(b.s, ['atomBomb']);
    expect(a.s.buildings.has(a.city.id)).toBe(false);
    expect(b.s.buildings.get(b.city.id)?.hp).toBeCloseTo(1 - COUNTER.shelterMul, 6);
    expect(b.s.buildings.get(b.fort.id)!.disabledUntil).toBeGreaterThan(b.s.tick);
    const lostA = 100000 - a.s.players[2].troops.infantry;
    const lostB = 100000 - b.s.players[2].troops.infantry;
    expect(lostB).toBeLessThan(lostA * 0.75);
    expect(lostB).toBeGreaterThan(lostA * 0.3);
    expect(b.s.events.some((e) => /hardened shelters/.test(e.message))).toBe(true);
  });
});

describe('Anti-radar missiles', () => {
  function seadGame(): { s: GameState; sam: Building; af: Building } {
    const s = game();
    give(s, 1, 'flight', 'antiRadar');
    give(s, 2, 'radar');
    const af = addBuilding(s, 'airfield', 1, at(s, 40, 20));
    const sam = addBuilding(s, 'sam', 2, at(s, 120, 20));
    return { s, sam, af };
  }
  it('locks only on a SAM whose radar is on (it fired in the last N seconds)', () => {
    const { s, sam } = seadGame();
    expect(antiRadarReason(s, 1, -1, sam.tile)).toBe('SAM radar is off: wait until it fires');
    sam.firedAt = s.tick;
    expect(antiRadarReason(s, 1, -1, sam.tile)).toBe('');
    s.tick += ANTI_RADAR.radarOnSeconds * TICKS_PER_SECOND;
    expect(antiRadarReason(s, 1, -1, sam.tile)).toBe('SAM radar is off: wait until it fires');
    s.players[1].techs = s.players[1].techs.filter((t) => t !== 'antiRadar');
    expect(antiRadarReason(s, 1, -1, sam.tile)).toBe('Needs Anti-radar Missiles');
  });
  it('a hit knocks the SAM out (the barrage knock-out); the airfield reloads', () => {
    const { s, sam, af } = seadGame();
    sam.firedAt = s.tick;
    sam.cooldown = 1e6; // empty: it just fired
    expect(applyAction(s, 1, { type: 'antiRadar', airfield: -1, sam: sam.tile }).ok).toBe(true);
    expect(af.seadReady).toBe(s.tick + ANTI_RADAR.cooldownSeconds * TICKS_PER_SECOND);
    expect(antiRadarReason(s, 1, af.tile, sam.tile)).toMatch(/reloading/);
    fly(s, ['antiRadarMissile']);
    expect(sam.disabledUntil).toBeGreaterThan(s.tick);
    expect(sam.hp).toBeCloseTo(1 - ANTI_RADAR.damage, 6);
  });
  it('SAM sites shoot it down like any missile', () => {
    const { s, sam } = seadGame();
    sam.firedAt = s.tick;
    sam.cooldown = 1e6;
    addBuilding(s, 'sam', 2, at(s, 121, 25)); // loaded neighbour
    applyAction(s, 1, { type: 'antiRadar', airfield: -1, sam: sam.tile });
    fly(s, ['antiRadarMissile']);
    expect(sam.disabledUntil).toBe(0);
    expect(s.events.some((e) => /shot down a anti-radar missile|shot down an? anti-radar missile/.test(e.message))).toBe(true);
  });
  it('the SAM it homes on cannot shoot it, whatever its level or load; neighbouring SAMs still do', () => {
    for (const level of [1, 2, 3]) {
      const { s, sam } = seadGame();
      sam.level = level;
      sam.firedAt = s.tick; // radar on, every shot still loaded
      applyAction(s, 1, { type: 'antiRadar', airfield: -1, sam: sam.tile });
      fly(s, ['antiRadarMissile']);
      expect(sam.disabledUntil).toBeGreaterThan(s.tick);
      expect(s.events.some((e) => /shot down an? anti-radar missile/.test(e.message))).toBe(false);
    }
  });
  it('escort mode (off by default) answers a SAM that just shot at your planes', () => {
    const { s, sam } = seadGame();
    expect(s.players[1].antiRadarEscort).toBeUndefined();
    expect(applyAction(s, 1, { type: 'setAntiRadarEscort', on: true }).ok).toBe(true);
    s.tick = 10 * TICKS_PER_SECOND;
    sam.firedAt = s.tick - 2;
    sam.firedOn = 3; // not at us: nothing
    updateAntiRadar(s);
    expect(s.units.some((u) => u.type === 'antiRadarMissile')).toBe(false);
    sam.firedOn = 1;
    updateAntiRadar(s);
    expect(s.units.filter((u) => u.type === 'antiRadarMissile').length).toBe(1);
  });
  it('SAM fire, airfield reloads and escort are hashed', () => {
    const { s, sam, af } = seadGame();
    const h0 = hashState(s);
    sam.firedAt = 5;
    const h1 = hashState(s);
    expect(h1).not.toBe(h0);
    af.seadReady = 50;
    const h2 = hashState(s);
    expect(h2).not.toBe(h1);
    s.players[1].antiRadarEscort = true;
    expect(hashState(s)).not.toBe(h2);
  });
});

describe('Stealth bomber: silo hunter, clean, multi-target', () => {
  function stealthGame(): GameState {
    const s = game();
    give(s, 1, 'flight', 'airMastery');
    give(s, 2, 'rocketry', 'nuclearFission');
    addBuilding(s, 'airfield', 1, at(s, 40, 20));
    return s;
  }
  it('destroys silos in the blast with their loaded atom bombs and silences other silos within reach', () => {
    const s = stealthGame();
    const silo = addBuilding(s, 'silo', 2, at(s, 120, 20), 2); // 2 slots = one atom bomb loaded
    const near = addBuilding(s, 'silo', 2, at(s, 135, 20));
    const far = addBuilding(s, 'silo', 2, at(s, 150, 20));
    expect(applyAction(s, 1, { type: 'stealthStrike', airfield: -1, tile: silo.tile }).ok).toBe(true);
    fly(s, ['stealthBomber']);
    expect(s.buildings.has(silo.id)).toBe(false);
    expect(s.events.some((e) => e.message.includes(`1 destroyed with 1 loaded atom bomb`))).toBe(true);
    expect(near.disabledUntil).toBeGreaterThan(s.tick);
    expect(far.disabledUntil).toBe(0);
    expect(launchMissile(s, 2, near.tile, 'rocket', at(s, 50, 20)).reason).toMatch(/knocked out/);
    expect(ATOM_SILO_SLOTS).toBe(2);
  });
  it('is clean: the land stays its owner\'s, no fallout', () => {
    const s = stealthGame();
    const t = at(s, 120, 20);
    applyAction(s, 1, { type: 'stealthStrike', airfield: -1, tile: t });
    fly(s, ['stealthBomber']);
    expect(s.map.owner[t]).toBe(2);
    expect(s.map.fallout[t]).toBe(0);
  });
  it('multi-target: up to 3 aim points within the spread, smaller blasts, one after another', () => {
    const s = stealthGame();
    const a = at(s, 110, 10);
    const b = at(s, 120, 20);
    const c = at(s, 110, 30);
    expect(stealthAimsReason(s, 1, -1, [a, at(s, 140, 10)])).toMatch(/within 25 tiles/);
    expect(stealthAimsReason(s, 1, -1, [a, b, c, at(s, 115, 20)])).toMatch(/At most 3/);
    expect(stealthAimsReason(s, 1, -1, [a, at(s, 50, 20)])).toMatch(/own land/);
    expect(applyAction(s, 1, { type: 'stealthStrike', airfield: -1, tile: a, tile2: b, tile3: c }).ok).toBe(true);
    const u = s.units.find((q) => q.type === 'stealthBomber')!;
    expect(u.aims).toEqual([b, c]);
    const h = hashState(s);
    u.aims = [b];
    expect(hashState(s)).not.toBe(h);
    u.aims = [b, c];
    fly(s, ['stealthBomber']);
    const blasts = s.effects.filter((e) => e.kind === 'explosion' && Math.abs(e.radius - STEALTH.multiRadius) < 1e-6);
    expect(blasts.length).toBe(3);
    expect(s.events.filter((e) => e.message.startsWith('Stealth strike by ')).length).toBe(3);
  });
});

describe('Cruise missiles: sea-skimming and anti-ship', () => {
  function navyGame(): { s: GameState; ship: Unit } {
    const s = game();
    give(s, 1, 'navigation', 'navalMastery');
    give(s, 2, 'radar');
    const ship = unit(s, 'warship', 1, 75, 20, { hp: 3 });
    return { s, ship };
  }
  it('only SAM sites within the skim radius of the target can shoot it on the way', () => {
    const { s, ship } = navyGame();
    addBuilding(s, 'sam', 2, at(s, 95, 20)); // on the route, 25 tiles from the target
    expect(applyAction(s, 1, { type: 'cruiseMissile', ship: ship.id, tile: at(s, 120, 20) }).ok).toBe(true);
    fly(s, ['cruiseMissile']);
    expect(s.events.some((e) => e.message.startsWith('Cruise missile strike by'))).toBe(true);
    const b = navyGame();
    addBuilding(b.s, 'sam', 2, at(b.s, 120 - CRUISE.skimRadius + 3, 20)); // near the target
    applyAction(b.s, 1, { type: 'cruiseMissile', ship: b.ship.id, tile: at(b.s, 120, 20) });
    fly(b.s, ['cruiseMissile']);
    expect(b.s.events.some((e) => e.message.startsWith('Cruise missile strike by'))).toBe(false);
  });
  it('anti-ship: a click near an enemy ship homes on it; a warship loses hp, a transport sinks', () => {
    const { s, ship } = navyGame();
    const foe = unit(s, 'warship', 2, 85, 30, { hp: 3 });
    const water = at(s, 86, 31);
    const pv = cruisePreview(s, 1, ship.id, water);
    expect(pv.ok).toBe(true);
    expect(pv.ship?.id).toBe(foe.id);
    expect(applyAction(s, 1, { type: 'cruiseMissile', ship: ship.id, tile: water }).ok).toBe(true);
    fly(s, ['cruiseMissile']);
    expect(foe.hp).toBeLessThanOrEqual(3 - CRUISE.shipDamage + 1e-9); // the missile (and maybe a gun duel meanwhile)
    expect(s.events.some((e) => /cruise missile of .* hit a warship/.test(e.message))).toBe(true);
    const t = unit(s, 'transport', 2, 80, 5, { hp: 1, troops: { infantry: 5000, armor: 0, artillery: 0 } });
    ship.cruiseReady = 0;
    expect(applyAction(s, 1, { type: 'cruiseMissile', ship: ship.id, tile: at(s, 80, 5) }).ok).toBe(true);
    fly(s, ['cruiseMissile']);
    expect(t.hp).toBe(0);
    ship.cruiseReady = 0;
    expect(applyAction(s, 1, { type: 'cruiseMissile', ship: ship.id, tile: at(s, 72, 38) }).reason).toMatch(/No enemy ship/);
  });
});

describe('Defense part 3: determinism', () => {
  it('two identical games with the new actions keep the same hash', () => {
    const play = (): number => {
      const s = game(false, 3);
      give(s, 1, 'flight', 'antiRadar', 'airMastery');
      give(s, 2, 'fortification', 'defenseMastery', 'radar', 'rocketry');
      addBuilding(s, 'fort', 2, at(s, 86, 20), 2);
      addBuilding(s, 'airfield', 1, at(s, 20, 20));
      const sam = addBuilding(s, 'sam', 2, at(s, 120, 20));
      addBuilding(s, 'silo', 2, at(s, 125, 25));
      s.players[1].troops = { infantry: 150000, armor: 0, artillery: 0 };
      applyAction(s, 1, { type: 'attack', tile: at(s, 80, 20), troops: { infantry: 90000, armor: 0, artillery: 0 } });
      applyAction(s, 1, { type: 'setAntiRadarEscort', on: true });
      sam.firedAt = 0;
      applyAction(s, 1, { type: 'antiRadar', airfield: -1, sam: sam.tile });
      applyAction(s, 1, { type: 'stealthStrike', airfield: -1, tile: at(s, 120, 20), tile2: at(s, 125, 25) });
      s.admin!.aiFrozen = false;
      s.players[2].isHuman = true; // no AI turns: only the actions below
      for (let k = 0; k < 200; k++) {
        updateAttacks(s);
        updateUnits(s);
        updateAntiRadar(s);
        if (k === 100 && counterMeter(s, 2) >= 1) applyAction(s, 2, { type: 'counteroffensive' });
        s.tick++;
      }
      return hashState(s);
    };
    expect(play()).toBe(play());
  });
});
