// The stealth strike (Air Mastery; units.ts launchStealth, stealth.ts, stealthSight.ts): validation, one at a time and
// the recharge, SAMs that never see it, fighters only when it is revealed (the hook), the warning, the bombs, air
// superiority, the AI's use, the server's validation and determinism.
import { describe, expect, it, vi } from 'vitest';

const flags = vi.hoisted(() => ({ reveal: false }));
vi.mock('../src/sim/stealthSight', async (orig) => {
  const m = await orig<typeof import('../src/sim/stealthSight')>();
  // the future Defense radar's hook: tests switch it on to check that fighters then engage it by the bomber rule
  return { ...m, stealthRevealedTo: () => flags.reveal };
});

import { applyAction } from '../src/sim/actions';
import { airState } from '../src/sim/airwings';
import { markBuildingsChanged } from '../src/sim/buildings';
import { STEALTH, TICKS_PER_SECOND, UNITS } from '../src/sim/config';
import { formAlliance } from '../src/sim/diplomacy';
import { hashState } from '../src/sim/hash';
import { newId } from '../src/sim/state';
import { aiStealth, aiStealthPick, stealthPreview } from '../src/sim/stealth';
import { unitVisibleTo } from '../src/sim/techtree';
import { buildAircraft, stealthRadius, stealthReach, stealthReason, updateUnits } from '../src/sim/units';
import type { Building, BuildingType, GameState, Unit } from '../src/sim/types';
import { validateAction } from '../server/validate';
import { claimRect, makeFlatGame, troopSum } from './helpers';

const at = (s: GameState, x: number, y: number): number => y * s.map.width + x;

/** 300 x 40 plain: player 1 (the human) x 0..149, player 2 (a frozen AI) x 150..299. Rich; Air Mastery for 1. */
function game(seed = 5): GameState {
  const s = makeFlatGame(300, 40, 2, { human: true, seed });
  claimRect(s, 1, 0, 0, 149, 39);
  claimRect(s, 2, 150, 0, 299, 39);
  s.admin = { aiPassive: [], godMode: [], aiFrozen: true, revealIntel: [] };
  s.settings.victoryLandShare = 0.99;
  for (const p of s.players) {
    if (p.id === 0) continue;
    p.gold = 1e6;
    p.iron = 1e5;
    p.oil = 1e5;
    p.techs.push('flight');
    p.troops = { infantry: 300000, armor: 0, artillery: 0 };
  }
  s.players[1].techs.push('airMastery');
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
/** Units only (no combat, economy or AI) until pred() or max ticks. */
function fly(s: GameState, pred: () => boolean, max = 600): void {
  for (let k = 0; k < max && !pred(); k++) {
    updateUnits(s);
    s.tick++;
  }
}
const bomber = (s: GameState): Unit | undefined => s.units.find((u) => u.type === 'stealthBomber' && u.hp > 0);
const strike = (s: GameState, pid: number, airfield: number, tile: number) => applyAction(s, pid, { type: 'stealthStrike', airfield, tile });

describe('stealth strike: validation', () => {
  it('needs Air Mastery, an own finished airfield in reach, enemy land and the price', () => {
    const s = game();
    const af = addBuilding(s, 'airfield', 1, at(s, 100, 20));
    const target = at(s, 250, 20);
    expect(stealthReason(s, 2, -1, at(s, 50, 20))).toBe('Needs Air Mastery'); // (player 2 is a frozen AI here)
    expect(strike(s, 1, af.tile, at(s, 120, 20)).reason).toBe('That is your own land');
    const r = Math.round(stealthReach(s, af));
    expect(r).toBe(Math.round(150 * STEALTH.reachMul));
    // reach: 187 tiles from the airfield
    const far = addBuilding(s, 'airfield', 1, at(s, 0, 0));
    expect(strike(s, 1, far.tile, at(s, 299, 39)).reason).toBe(`Too far: the stealth bomber reaches ${r} tiles from this airfield`);
    expect(strike(s, 1, at(s, 5, 5), target).reason).toBe('Stealth bombers fly from a finished Airfield of yours');
    const s2 = game();
    const af2 = addBuilding(s2, 'airfield', 1, at(s2, 100, 20));
    formAlliance(s2, 1, 2);
    expect(strike(s2, 1, af2.tile, target).reason).toBe('You cannot bomb an ally');
    const s3 = game();
    addBuilding(s3, 'airfield', 1, at(s3, 100, 20));
    s3.players[1].gold = 10;
    expect(strike(s3, 1, -1, target).reason).toBe(`Not enough gold (${UNITS.stealthBomber.gold})`);
    s3.players[1].gold = 1e6;
    s3.players[1].oil = 1;
    expect(strike(s3, 1, -1, target).reason).toBe(`Not enough oil (${UNITS.stealthBomber.oil})`);
    s3.players[1].oil = 1e5;
    const g0 = s3.players[1].gold;
    expect(strike(s3, 1, -1, target).ok).toBe(true);
    expect(g0 - s3.players[1].gold).toBe(UNITS.stealthBomber.gold);
    const p = game();
    p.settings.modifiers.peaceMinutes = 4;
    addBuilding(p, 'airfield', 1, at(p, 100, 20));
    expect(strike(p, 1, -1, target).reason).toMatch(/^Peace time/);
  });

  it('one flies at a time, and it recharges for STEALTH.cooldownSeconds from launch', () => {
    const s = game();
    addBuilding(s, 'airfield', 1, at(s, 100, 20));
    const target = at(s, 200, 20);
    expect(strike(s, 1, -1, target).ok).toBe(true);
    expect(strike(s, 1, -1, target).reason).toBe('Stealth bomber in the air');
    fly(s, () => !bomber(s));
    expect(strike(s, 1, -1, target).reason).toMatch(/^Recharging \d+ s$/);
    s.tick = s.players[1].stealthReady! - 1;
    expect(strike(s, 1, -1, target).reason).toBe('Recharging 1 s');
    s.tick += 1;
    expect(strike(s, 1, -1, target).ok).toBe(true);
    expect(s.players[1].stealthReady).toBe(s.tick + STEALTH.cooldownSeconds * TICKS_PER_SECOND);
  });

  it('the server accepts {airfield, tile} with airfield -1 and refuses other shapes', () => {
    expect(validateAction({ type: 'stealthStrike', airfield: -1, tile: 100 }).ok).toBe(true);
    expect(validateAction({ type: 'stealthStrike', airfield: 40, tile: 100 }).ok).toBe(true);
    expect(validateAction({ type: 'stealthStrike', tile: 100 }).ok).toBe(false);
    expect(validateAction({ type: 'stealthStrike', airfield: 'x', tile: 100 }).ok).toBe(false);
  });
});

describe('stealth strike: the flight and the bombs', () => {
  it('flies through SAM cover untouched, wrecks every building in its blast, kills troops, cuts income, flies home', () => {
    const s = game();
    addBuilding(s, 'airfield', 1, at(s, 100, 20));
    const sams = [addBuilding(s, 'sam', 2, at(s, 180, 20), 3), addBuilding(s, 'sam', 2, at(s, 230, 20), 3), addBuilding(s, 'sam', 2, at(s, 255, 30), 3)];
    const target = at(s, 250, 20);
    const inBlast = [addBuilding(s, 'factory', 2, target), addBuilding(s, 'silo', 2, at(s, 253, 21)), addBuilding(s, 'city', 2, at(s, 247, 18))];
    const outside = addBuilding(s, 'city', 2, at(s, 250, 33));
    const pv = stealthPreview(s, 1, -1, target);
    expect(pv.ok).toBe(true);
    expect(pv.enemyBuildings).toBe(3);
    expect(pv.buildingsHit).toBeCloseTo(3, 5);
    expect(pv.samSites).toBe(3);
    const t0 = troopSum(s.players[2].troops);
    expect(strike(s, 1, -1, target).ok).toBe(true);
    fly(s, () => (bomber(s)?.state ?? 1) === 1);
    for (const b of sams) expect(b.cooldown).toBe(0); // no SAM ever fired
    for (const b of inBlast) expect(s.buildings.has(b.id)).toBe(false);
    expect(s.buildings.has(outside.id)).toBe(true);
    expect(troopSum(s.players[2].troops)).toBeLessThan(t0);
    expect(airState(s).raids.find((r) => r.victim === 2)?.cut ?? 0).toBeGreaterThan(0);
    const hit = s.events.find((e) => e.kind === 'bombing' && e.message.startsWith('Stealth strike by '));
    expect(hit?.message).toMatch(/^Stealth strike by Tester on AI 2: 2 buildings destroyed, \d+ troops killed$/); // the silo went first, to the silo hunter
    expect(s.events.some((e) => /hunted silos: 1 destroyed/.test(e.message))).toBe(true);
    expect(s.events.some((e) => e.kind === 'unitLost')).toBe(false);
    fly(s, () => !bomber(s));
    expect(bomber(s)).toBeUndefined();
    expect(stealthRadius(s, 1)).toBeCloseTo(5 * STEALTH.radiusMul, 5);
  });

  it('the SAM hunter: every SAM site in the blast is destroyed, others within the silence radius go quiet for a while', () => {
    const s = game();
    addBuilding(s, 'airfield', 1, at(s, 100, 20));
    const target = at(s, 250, 20);
    addBuilding(s, 'factory', 2, target);
    const inBlast = addBuilding(s, 'sam', 2, at(s, 254, 20), 3);
    const near = addBuilding(s, 'sam', 2, at(s, 250, 32), 3); // outside the blast, inside the silence radius
    const far = addBuilding(s, 'sam', 2, at(s, 278, 20), 3); // past the silence radius
    const mine = addBuilding(s, 'sam', 1, at(s, 140, 20), 3);
    expect(Math.hypot(0, 32 - 20)).toBeLessThan(STEALTH.silenceRadius);
    expect(stealthRadius(s, 1)).toBeLessThan(12);
    const h0 = hashState(s);
    expect(strike(s, 1, -1, target).ok).toBe(true);
    fly(s, () => (bomber(s)?.state ?? 1) === 1);
    expect(s.buildings.has(inBlast.id)).toBe(false);
    expect(s.buildings.has(near.id)).toBe(true);
    expect(near.disabledUntil).toBeGreaterThan(s.tick);
    expect(near.disabledUntil - s.tick).toBeLessThanOrEqual(STEALTH.silenceSeconds * TICKS_PER_SECOND);
    expect(far.disabledUntil).toBe(0);
    expect(mine.disabledUntil).toBe(0);
    expect(s.events.some((e) => e.message.includes('opened the sky: 1 SAM site destroyed, 1 silenced'))).toBe(true);
    expect(hashState(s)).not.toBe(h0);
    // the silenced SAM site is back after the silence
    s.tick = near.disabledUntil;
    expect(near.disabledUntil > s.tick).toBe(false);
  });

  it('fighters leave it alone unless something reveals it (Tracking Radar); then two hits shoot it down', () => {
    const run = (reveal: boolean): GameState => {
      flags.reveal = reveal;
      const s = game();
      addBuilding(s, 'airfield', 1, at(s, 100, 20));
      const guard = addBuilding(s, 'airfield', 2, at(s, 240, 20));
      for (let k = 0; k < 3; k++) expect(buildAircraft(s, 2, guard.tile, 'fighter').ok).toBe(true);
      // it has 2 hp (Tracking Radar, defense.ts): a second airfield on the way lands the second hit
      const guard2 = addBuilding(s, 'airfield', 2, at(s, 230, 22));
      for (let k = 0; k < 3; k++) expect(buildAircraft(s, 2, guard2.tile, 'fighter').ok).toBe(true);
      addBuilding(s, 'factory', 2, at(s, 250, 20));
      expect(strike(s, 1, -1, at(s, 250, 20)).ok).toBe(true);
      fly(s, () => !bomber(s));
      flags.reveal = false;
      return s;
    };
    const hidden = run(false);
    expect(hidden.events.some((e) => /shot down a stealth bomber/.test(e.message))).toBe(false);
    expect(hidden.events.some((e) => e.message.startsWith('Stealth strike by '))).toBe(true);
    const seen = run(true);
    expect(seen.events.some((e) => e.message === "AI 2's fighters shot down a stealth bomber of Tester")).toBe(true);
    expect(seen.events.some((e) => e.message.startsWith('Stealth strike by '))).toBe(false);
  });

  it('the target sees it and is warned only in the last seconds; its owner and allies always', () => {
    const s = game();
    addBuilding(s, 'airfield', 1, at(s, 100, 20));
    expect(strike(s, 1, -1, at(s, 260, 20)).ok).toBe(true);
    const u = bomber(s)!;
    expect(unitVisibleTo(s, 1, u)).toBe(true);
    expect(unitVisibleTo(s, 2, u)).toBe(false);
    expect(unitVisibleTo(s, 0, u)).toBe(true); // spectators
    const warn = (): boolean => s.events.some((e) => e.message.startsWith('A stealth bomber of Tester is over AI 2'));
    fly(s, warn);
    expect(warn()).toBe(true);
    expect(unitVisibleTo(s, 2, u)).toBe(true);
    const left = Math.sqrt((u.x - 260) ** 2 + (u.y - 20) ** 2) / UNITS.stealthBomber.speed;
    expect(left).toBeLessThanOrEqual(STEALTH.revealSeconds + 0.05);
    expect(left).toBeGreaterThan(STEALTH.revealSeconds - 0.5);
    const e = s.events.find((q) => q.message.startsWith('A stealth bomber of'))!;
    expect(e.message).toBe(`A stealth bomber of Tester is over AI 2: its bombs fall in ${STEALTH.revealSeconds} s`);
    expect(e.players[0]).toBe(2);
    fly(s, () => u.state === 1);
    expect(unitVisibleTo(s, 2, u)).toBe(false); // on its way home it is hidden again
  });

  it('air superiority over the target cuts its bombs like any bombing', () => {
    const s = game(9);
    addBuilding(s, 'airfield', 1, at(s, 100, 20));
    const guard = addBuilding(s, 'airfield', 2, at(s, 270, 20));
    for (let k = 0; k < 3; k++) expect(buildAircraft(s, 2, guard.tile, 'fighter').ok).toBe(true);
    const target = at(s, 250, 20);
    addBuilding(s, 'factory', 2, target);
    const pv = stealthPreview(s, 1, -1, target);
    expect(pv.guarded).toBe(true);
    expect(pv.buildingsHit).toBeCloseTo(0.6, 5);
    expect(strike(s, 1, -1, target).ok).toBe(true);
    fly(s, () => !bomber(s));
    const hit = s.events.find((e) => e.message.startsWith('Stealth strike by '));
    expect(hit?.message).toMatch(/\(air superiority: 40% less\)$/);
  });
});

describe('stealth strike: the AI', () => {
  /** p2 is the AI with Air Mastery at war with p1 (the human); p1's buildings stand behind SAM cover. */
  function aiGame(cover: number, difficulty: 'easy' | 'normal' = 'normal'): { s: GameState; silo: Building; farm: Building } {
    const s = game();
    s.settings.difficulty = difficulty;
    s.admin!.aiFrozen = false;
    s.players[2].techs.push('airMastery');
    addBuilding(s, 'airfield', 2, at(s, 200, 20));
    for (let k = 0; k < cover; k++) addBuilding(s, 'sam', 1, at(s, 60 + k * 3, 30));
    const silo = addBuilding(s, 'silo', 1, at(s, 60, 20));
    const farm = addBuilding(s, 'farm', 1, at(s, 140, 5));
    s.attacks.push({ id: 900, attacker: 2, target: 1, troops: { infantry: 1000, armor: 0, artillery: 0 }, focusTile: at(s, 150, 10), progress: 0, startTick: s.tick, amphibious: false, losses: 0, tilesTaken: 0 });
    return { s, silo, farm };
  }

  it('sends it at a high-value target under strong SAM cover, keeping its reserve', () => {
    const { s, silo } = aiGame(2);
    const pick = aiStealthPick(s, 2);
    // the SAM hunter: a SAM site of the wall outranks even a silo
    expect(s.buildings.get(s.map.building[pick!.tile] - 1)?.type).toBe('sam');
    expect(pick?.tile).not.toBe(silo.tile);
    s.players[2].gold = UNITS.stealthBomber.gold * (1 + STEALTH.aiReserve) - 1;
    expect(aiStealth(s, 2)).toBe(false);
    s.players[2].gold = 1e6;
    expect(aiStealth(s, 2)).toBe(true);
    expect(bomber(s)?.owner).toBe(2);
    expect(aiStealth(s, 2)).toBe(false); // one at a time
  });

  it('skips targets without strong SAM cover (bombers and rockets do that job)', () => {
    const { s } = aiGame(1);
    expect(aiStealthPick(s, 2)).toBeNull();
  });

  it('Easy AIs never send it at a human', () => {
    const { s } = aiGame(3, 'easy');
    expect(aiStealthPick(s, 2)).toBeNull();
  });

  it("a human's stealth bomber never flies by itself", () => {
    const { s } = aiGame(3);
    addBuilding(s, 'airfield', 1, at(s, 100, 20));
    addBuilding(s, 'sam', 2, at(s, 210, 30), 3);
    expect(aiStealth(s, 1)).toBe(false);
  });
});

describe('stealth strike: determinism', () => {
  it('two games fed the same orders hash the same, and the recharge is in the hash', () => {
    const run = (): GameState => {
      const s = game(11);
      addBuilding(s, 'airfield', 1, at(s, 100, 20));
      addBuilding(s, 'factory', 2, at(s, 250, 20));
      addBuilding(s, 'sam', 2, at(s, 240, 22));
      expect(strike(s, 1, -1, at(s, 250, 20)).ok).toBe(true);
      fly(s, () => false, 60);
      return s;
    };
    const a = run();
    const b = run();
    expect(hashState(a)).toBe(hashState(b));
    const h = hashState(a);
    a.players[1].stealthReady = (a.players[1].stealthReady ?? 0) + 1;
    expect(hashState(a)).not.toBe(h);
  });
});
