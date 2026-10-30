// Doctrines (src/sim/doctrines.ts): unlock, choosing / switching rules, levels, each doctrine's main lever, the AI's
// choice, determinism and the server's shape check.
import { describe, expect, it } from 'vitest';
import { applyAction } from '../src/sim/actions';
import { barrageCooldown, barrageRadius } from '../src/sim/barrage';
import { buildingCost, fortDefense } from '../src/sim/buildings';
import { estimateAttack, updateAttacks, updateSupply } from '../src/sim/combat';
import {
  BARRAGE_RADIUS,
  DOCTRINE_ADAPT_SECONDS,
  DOCTRINE_LEVEL_SECONDS,
  DOCTRINE_LEVERS,
  DOCTRINE_SWITCH_COOLDOWN,
  DOCTRINE_SWITCH_GOLD,
  DOCTRINE_SWITCH_INCOME_SECONDS,
  DOCTRINE_UNLOCK_SECONDS,
  DOCTRINES,
  TICKS_PER_SECOND,
} from '../src/sim/config';
import {
  doctrineActive,
  doctrineLevel,
  doctrineSwitchCost,
  doctrineUnlocked,
  recommendDoctrines,
  updateDoctrines,
} from '../src/sim/doctrines';
import { convertCost, goldIncome, growthBonus } from '../src/sim/economy';
import { hashState } from '../src/sim/hash';
import { tick } from '../src/sim/sim';
import { paradropRange, unitCost } from '../src/sim/units';
import { DOCTRINE_IDS, Terrain, isTribe } from '../src/sim/types';
import type { Building, DoctrineId, GameState, Troops } from '../src/sim/types';
import { validateAction } from '../server/validate';
import { claimRect, makeFlatGame, makeTestGame } from './helpers';

const TPS = TICKS_PER_SECOND;
const UNLOCK = DOCTRINE_UNLOCK_SECONDS * TPS;

/** Flat 2-player game (1 human) where 1 owns the left half, 2 the right; game time set past the unlock. */
function game(opts: { terrain?: number; fast?: boolean } = {}): GameState {
  const s = makeFlatGame(60, 30, 2, { human: true, terrain: opts.terrain });
  if (opts.fast) s.settings.modifiers = { ...s.settings.modifiers, fastGame: true };
  claimRect(s, 1, 0, 0, 29, 29);
  claimRect(s, 2, 30, 0, 59, 29);
  s.tick = s.playStartTick + UNLOCK * (opts.fast ? 0.5 : 1);
  return s;
}
/** Puts pid on doctrine `id` at `level` (bonus active now), as if it had held it that long. */
function give(s: GameState, pid: number, id: DoctrineId, level: 1 | 2 | 3 = 2): void {
  s.players[pid].doctrine = { id, level, chosenTick: s.tick, adaptUntilTick: 0, lastSwitchTick: s.tick };
}
const choose = (s: GameState, pid: number, doctrine: DoctrineId) => applyAction(s, pid, { type: 'chooseDoctrine', doctrine });
const inf = (n: number): Troops => ({ infantry: n, armor: 0, artillery: 0 });
const fakeBuilding = (owner: number, type: Building['type'], level = 1): Building => ({
  id: 999, type, owner, tile: 0, level, buildLeft: 0, upgradeLeft: 0, fighters: 0, bombers: 0, cooldown: 0, dropCooldown: 0, disabledUntil: 0, hp: 1,
});

describe('doctrines: unlock', () => {
  it('unlocks DOCTRINE_UNLOCK_SECONDS after the start of play, with a clear refusal before', () => {
    const s = game();
    s.tick = s.playStartTick + UNLOCK - 1;
    expect(doctrineUnlocked(s, 1)).toBe(false);
    expect(choose(s, 1, 'blitz')).toEqual({ ok: false, reason: 'Doctrines unlock at 5:00' });
    s.tick++;
    expect(doctrineUnlocked(s, 1)).toBe(true);
    expect(choose(s, 1, 'blitz').ok).toBe(true);
  });

  it('counts from the end of the spawn phase, and a fast game halves it like other progress timers', () => {
    const s = game({ fast: true });
    s.playStartTick = 500;
    s.tick = 500 + UNLOCK / 2 - 1;
    expect(choose(s, 1, 'siege')).toEqual({ ok: false, reason: 'Doctrines unlock at 2:30' });
    s.tick++;
    expect(choose(s, 1, 'siege').ok).toBe(true);
  });

  it('announces the unlock to human players once', () => {
    const s = game();
    s.tick = s.playStartTick + UNLOCK;
    s.events.length = 0;
    updateDoctrines(s);
    s.tick++;
    updateDoctrines(s);
    const ev = s.events.filter((e) => e.kind === 'doctrineUnlocked');
    expect(ev).toHaveLength(1);
    expect(ev[0].players).toEqual([1]);
  });
});

describe('doctrines: choosing and switching', () => {
  it('refuses unknown doctrines, tribes and the doctrine already held', () => {
    const s = game();
    expect(applyAction(s, 1, { type: 'chooseDoctrine', doctrine: 'pacifism' as DoctrineId }).reason).toBe('Unknown doctrine');
    s.players[2].personality = 'tribe';
    expect(choose(s, 2, 'blitz').reason).toBe('Tribes have no doctrines');
    expect(choose(s, 1, 'naval').ok).toBe(true);
    expect(choose(s, 1, 'naval').reason).toBe('Naval is already your doctrine');
  });

  it('the first choice is free and works at once; a switch costs gold, adapts, resets the level and has a cooldown', () => {
    const s = game();
    const p = s.players[1];
    p.gold = 5000;
    expect(doctrineSwitchCost(s, 1)).toBe(0);
    expect(choose(s, 1, 'fortress').ok).toBe(true);
    expect(p.gold).toBe(5000);
    expect(doctrineActive(s, 1)).toBe('fortress');
    expect(doctrineLevel(s, 1)).toBe(1);
    expect(s.events.some((e) => e.kind === 'doctrineChosen' && e.players.includes(1))).toBe(true);

    // Cooldown from the last choice.
    s.tick += DOCTRINE_SWITCH_COOLDOWN * TPS - 1;
    expect(choose(s, 1, 'siege').reason).toBe('You can change doctrine again in 0:01');
    s.tick++;
    // Cost: the minimum, or seconds of income when that is more.
    p.income.gold = 10;
    expect(doctrineSwitchCost(s, 1)).toBe(DOCTRINE_SWITCH_GOLD);
    p.income.gold = 1000;
    expect(doctrineSwitchCost(s, 1)).toBe(DOCTRINE_SWITCH_INCOME_SECONDS * 1000);
    p.gold = 100;
    expect(choose(s, 1, 'siege').reason).toBe(`Not enough gold (${DOCTRINE_SWITCH_INCOME_SECONDS * 1000})`);
    p.gold = 9000;
    s.players[1].doctrine.level = 2;
    expect(choose(s, 1, 'siege').ok).toBe(true);
    expect(p.gold).toBe(9000 - DOCTRINE_SWITCH_INCOME_SECONDS * 1000);
    expect(p.doctrine.id).toBe('siege');
    expect(doctrineLevel(s, 1)).toBe(1);
    // No bonus while adapting.
    expect(doctrineActive(s, 1)).toBeNull();
    s.tick += DOCTRINE_ADAPT_SECONDS * TPS - 1;
    expect(doctrineActive(s, 1)).toBeNull();
    s.tick++;
    expect(doctrineActive(s, 1)).toBe('siege');
  });

  it('tells human neighbours what a nation chose', () => {
    const s = game();
    s.players[2].isHuman = true;
    s.players[2].personality = null;
    s.events.length = 0;
    expect(choose(s, 2, 'blitz').ok).toBe(true);
    const news = s.events.find((e) => e.kind === 'doctrineChosen' && e.players.includes(1));
    expect(news?.message).toContain('adopted the Blitz doctrine');
  });
});

describe('doctrines: levels', () => {
  it('reaches levels 2 and 3 at DOCTRINE_LEVEL_SECONDS of holding the doctrine, with events', () => {
    const s = game();
    expect(choose(s, 1, 'merchant').ok).toBe(true);
    const t0 = s.tick;
    const runTo = (t: number): void => {
      while (s.tick < t) {
        updateDoctrines(s);
        s.tick++;
      }
      updateDoctrines(s);
    };
    runTo(t0 + DOCTRINE_LEVEL_SECONDS[1] * TPS - 1);
    expect(doctrineLevel(s, 1)).toBe(1);
    runTo(t0 + DOCTRINE_LEVEL_SECONDS[1] * TPS);
    expect(doctrineLevel(s, 1)).toBe(2);
    runTo(t0 + DOCTRINE_LEVEL_SECONDS[2] * TPS - 1);
    expect(doctrineLevel(s, 1)).toBe(2);
    runTo(t0 + DOCTRINE_LEVEL_SECONDS[2] * TPS);
    expect(doctrineLevel(s, 1)).toBe(3);
    const ups = s.events.filter((e) => e.kind === 'doctrineLevelUp');
    expect(ups.map((e) => e.message.match(/level (\d)/)?.[1])).toEqual(['2', '3']);
  });

  it('level 1 gives part of a lever, level 2 all of it', () => {
    const s = game();
    const base = goldIncome(s, s.players[1]);
    give(s, 1, 'merchant', 1);
    const l1 = goldIncome(s, s.players[1]) / base - 1;
    give(s, 1, 'merchant', 2);
    const l2 = goldIncome(s, s.players[1]) / base - 1;
    expect(l1).toBeGreaterThan(0.05);
    expect(l1).toBeLessThan(l2);
    expect(l2).toBeCloseTo(DOCTRINE_LEVERS.merchant.gold!, 6);
  });
});

describe('doctrines: each main lever', () => {
  it('blitz: fronts cross plains faster and armor is cheaper to convert', () => {
    const s = game();
    const tile = 31; // a tile of player 2
    const before = estimateAttack(s, 1, tile, inf(20000))!.tilesPerSecond;
    const armor = convertCost(s.players[1], 'armor', s).gold;
    give(s, 1, 'blitz');
    expect(estimateAttack(s, 1, tile, inf(20000))!.tilesPerSecond / before).toBeCloseTo(1 + DOCTRINE_LEVERS.blitz.openGroundSpeed!, 6);
    expect(convertCost(s.players[1], 'armor', s).gold / armor).toBeCloseTo(1 - DOCTRINE_LEVERS.blitz.armorConvertCost!, 6);
    // Forest is not open ground.
    const f = game({ terrain: Terrain.Forest });
    const fb = estimateAttack(f, 1, 31, inf(20000))!.tilesPerSecond;
    give(f, 1, 'blitz');
    expect(estimateAttack(f, 1, 31, inf(20000))!.tilesPerSecond).toBeCloseTo(fb, 9);
  });

  it('blitz level 3: armor ignores part of the terrain penalty', () => {
    const s = game({ terrain: Terrain.Forest });
    const armor: Troops = { infantry: 0, armor: 20000, artillery: 0 };
    s.players[1].troops.armor = 20000;
    give(s, 1, 'blitz', 2);
    const l2 = estimateAttack(s, 1, 31, armor)!.lossPerTile;
    give(s, 1, 'blitz', 3);
    expect(estimateAttack(s, 1, 31, armor)!.lossPerTile).toBeLessThan(l2);
  });

  it('fortress: stronger, cheaper forts and fewer home losses when land falls', () => {
    const s = game();
    const fort = fakeBuilding(2, 'fort');
    const d0 = fortDefense(s, fort);
    const c0 = buildingCost(s, 2, 'fort').gold;
    give(s, 2, 'fortress');
    expect((fortDefense(s, fort) - 1) / (d0 - 1)).toBeCloseTo(1 + DOCTRINE_LEVERS.fortress.fortDefense!, 6);
    expect(buildingCost(s, 2, 'fort').gold).toBe(Math.round(c0 * (1 - DOCTRINE_LEVERS.fortress.fortCost!)));
    expect(buildingCost(s, 2, 'city').gold).toBe(buildingCost(s, 1, 'city').gold);

    // Same attack on 2 with and without the doctrine: 2 loses fewer home troops.
    const lost = (withDoctrine: boolean): number => {
      const g = game();
      if (withDoctrine) give(g, 2, 'fortress');
      expect(applyAction(g, 1, { type: 'attack', tile: 31, troops: inf(20000) }).ok).toBe(true);
      for (let k = 0; k < 30; k++) {
        updateSupply(g);
        updateAttacks(g);
        g.tick++;
      }
      return g.players[2].stats.troopsLost;
    };
    const plain = lost(false);
    expect(plain).toBeGreaterThan(0);
    expect(lost(true)).toBeLessThan(plain);
  });

  it('siege: artillery hits harder and barrages reload faster; level 3 widens the barrage', () => {
    const s = game();
    const guns: Troops = { infantry: 10000, armor: 0, artillery: 10000 };
    s.players[1].troops = { infantry: 10000, armor: 0, artillery: 10000 };
    const loss = estimateAttack(s, 1, 31, guns)!.lossPerTile;
    const cd = barrageCooldown(s.players[1], s);
    give(s, 1, 'siege');
    expect(estimateAttack(s, 1, 31, guns)!.lossPerTile).toBeLessThan(loss);
    expect(barrageCooldown(s.players[1], s) / cd).toBeCloseTo(1 - DOCTRINE_LEVERS.siege.barrageCooldown!, 6);
    expect(barrageRadius(s, 1)).toBe(BARRAGE_RADIUS);
    give(s, 1, 'siege', 3);
    expect(barrageRadius(s, 1)).toBe(BARRAGE_RADIUS + 1);
  });

  it('merchant: more gold income', () => {
    const s = game();
    const g0 = goldIncome(s, s.players[1]);
    give(s, 1, 'merchant');
    expect(goldIncome(s, s.players[1]) / g0).toBeCloseTo(1 + DOCTRINE_LEVERS.merchant.gold!, 6);
  });

  it('naval: cheaper warships; air: cheaper aircraft and longer paradrops', () => {
    const s = game();
    const ship = unitCost(s, 1, 'warship');
    const bomber = unitCost(s, 1, 'bomber');
    const af = fakeBuilding(1, 'airfield');
    const range = paradropRange(af, s);
    give(s, 1, 'naval');
    expect(unitCost(s, 1, 'warship').gold).toBe(Math.round(ship.gold * (1 - DOCTRINE_LEVERS.naval.warshipCost!)));
    expect(unitCost(s, 1, 'bomber')).toEqual(bomber);
    give(s, 1, 'air');
    expect(unitCost(s, 1, 'bomber').gold).toBe(Math.round(bomber.gold * (1 - DOCTRINE_LEVERS.air.aircraftCost!)));
    expect(unitCost(s, 1, 'warship')).toEqual(ship);
    expect(paradropRange(af, s)).toBe(Math.round(range * (1 + DOCTRINE_LEVERS.air.paradropRange!)));
  });

  it('expansion: cheaper wilderness attacks and faster growth while small', () => {
    const s = makeFlatGame(60, 30, 1, { human: true });
    claimRect(s, 1, 0, 0, 9, 29);
    s.tick = UNLOCK;
    const loss = estimateAttack(s, 1, 15, inf(20000))!.lossPerTile;
    const growth = growthBonus(s, s.players[1]);
    give(s, 1, 'expansion');
    expect(estimateAttack(s, 1, 15, inf(20000))!.lossPerTile / loss).toBeCloseTo(1 - DOCTRINE_LEVERS.expansion.expansionLoss!, 6);
    // 300 of 1800 tiles = 17% of the land: no longer small.
    expect(growthBonus(s, s.players[1])).toBeCloseTo(growth, 9);
    const big = makeFlatGame(200, 100, 1, { human: true });
    claimRect(big, 1, 0, 0, 9, 29); // 1.5% of the land
    big.tick = UNLOCK;
    const g0 = growthBonus(big, big.players[1]);
    give(big, 1, 'expansion');
    expect(growthBonus(big, big.players[1]) / g0).toBeCloseTo(1 + DOCTRINE_LEVERS.expansion.smallGrowth!, 6);
  });

  it('no doctrine bonus while adapting', () => {
    const s = game();
    const g0 = goldIncome(s, s.players[1]);
    give(s, 1, 'merchant');
    s.players[1].doctrine.adaptUntilTick = s.tick + 10;
    expect(goldIncome(s, s.players[1])).toBeCloseTo(g0, 9);
  });
});

describe('doctrines: advice, AI, determinism, server', () => {
  it('recommends 3 different doctrines with reasons, without touching the RNG', () => {
    const s = makeTestGame({ aiCount: 4 });
    s.tick = s.playStartTick + UNLOCK;
    const rng = s.rngState.s;
    for (const p of s.players) {
      if (!p.id || isTribe(p) || !p.alive) continue;
      const r = recommendDoctrines(s, p.id);
      expect(r).toHaveLength(3);
      expect(new Set(r.map((x) => x.id)).size).toBe(3);
      for (const x of r) {
        expect(DOCTRINE_IDS).toContain(x.id);
        expect(x.reason.length).toBeGreaterThan(5);
      }
    }
    expect(s.rngState.s).toBe(rng);
  });

  it('config describes every doctrine', () => {
    for (const id of DOCTRINE_IDS) {
      const d = DOCTRINES[id];
      expect(d.name && d.short && d.color).toBeTruthy();
      expect(d.levels).toHaveLength(3);
      expect(d.icon).toBe(`doctrine-${id}`);
      expect(Object.keys(DOCTRINE_LEVERS[id]).length).toBeGreaterThan(1);
    }
  });

  it('AI nations pick a doctrine after the unlock, the same way in two identical games (hash)', () => {
    const run = (): { hash: number; picks: (DoctrineId | null)[] } => {
      const s = makeTestGame({ humanPlayer: false, aiCount: 4, mods: { fastGame: true } });
      const end = s.playStartTick + UNLOCK / 2 + 60 * TPS;
      while (s.tick < end && s.phase === 'playing') tick(s);
      return { hash: hashState(s), picks: s.players.filter((p) => p.id && !isTribe(p) && p.alive).map((p) => p.doctrine.id) };
    };
    const a = run();
    const b = run();
    expect(a.hash).toBe(b.hash);
    expect(a.picks).toEqual(b.picks);
    expect(a.picks.length).toBeGreaterThan(0);
    for (const id of a.picks) expect(id).not.toBeNull();
  });

  it('the hash covers the doctrine', () => {
    const s = game();
    const h0 = hashState(s);
    expect(choose(s, 1, 'air').ok).toBe(true);
    const h1 = hashState(s);
    expect(h1).not.toBe(h0);
    s.players[1].doctrine.level = 2;
    expect(hashState(s)).not.toBe(h1);
  });

  it('the server accepts only a known doctrine and strips extra fields', () => {
    const ok = validateAction({ type: 'chooseDoctrine', doctrine: 'naval', extra: 1 });
    expect(ok).toEqual({ ok: true, value: { type: 'chooseDoctrine', doctrine: 'naval' } });
    expect(validateAction({ type: 'chooseDoctrine', doctrine: 'pacifism' }).ok).toBe(false);
    expect(validateAction({ type: 'chooseDoctrine' }).ok).toBe(false);
    expect(validateAction({ type: 'chooseDoctrine', doctrine: 3 }).ok).toBe(false);
  });
});
