// Big nations favoured but not unstoppable (force limit, heartland, last stand), coalitions, allies that act.
import { describe, expect, it } from 'vitest';
import { allyStatus, inCoalition, pledgesOf, runawayLeader } from '../src/sim/allies';
import { aiWantsAlliance } from '../src/sim/ai';
import { applyAction } from '../src/sim/actions';
import { coreDefenseAt, estimateAttack, forceLimitedOdds, heartlandRadius, lastStandFactor, oddsSpeedFactor, updateAttacks, updateHeartlands, updateSupply } from '../src/sim/combat';
import {
  ALLY_REQUEST_COOLDOWN,
  DEFENSE_BONUS_CAP,
  FORCE_LIMIT_ODDS,
  FORCE_LIMIT_TAIL,
  HEARTLAND_DEFENSE,
  HEARTLAND_MOVE_SECONDS,
  HEARTLAND_RADIUS_MAX,
  LAST_STAND_MAX,
  TICKS_PER_SECOND,
} from '../src/sim/config';
import { formAlliance } from '../src/sim/diplomacy';
import { hashState } from '../src/sim/hash';
import { tick } from '../src/sim/sim';
import { setOwner } from '../src/sim/state';
import type { GameState, Troops } from '../src/sim/types';
import { claimRect, makeFlatGame, troopSum } from './helpers';

const inf = (n: number): Troops => ({ infantry: n, armor: 0, artillery: 0 });
const at = (s: GameState, x: number, y: number): number => y * s.map.width + x;
/** Puts the game past peace time and the early human grace (10 game minutes). */
function lateGame(s: GameState): void {
  s.tick = 10 * 60 * TICKS_PER_SECOND;
  s.playStartTick = 0;
}
function giveHeart(s: GameState, id: number): void {
  s.players[id].heartTile = s.players[id].capital;
}

describe('force limit', () => {
  it('counts odds in full up to the limit, then with strongly diminishing returns', () => {
    for (const o of [0.2, 1, 2, FORCE_LIMIT_ODDS]) expect(forceLimitedOdds(o)).toBe(o);
    const ceiling = FORCE_LIMIT_ODDS * (1 + FORCE_LIMIT_TAIL);
    expect(forceLimitedOdds(6)).toBeLessThan(ceiling);
    expect(forceLimitedOdds(100)).toBeLessThan(ceiling);
    expect(forceLimitedOdds(100)).toBeGreaterThan(forceLimitedOdds(6));
    // Speed: x1 at even odds, a little more up to 3:1, almost nothing past it.
    expect(oddsSpeedFactor(1)).toBeCloseTo(1, 9);
    expect(oddsSpeedFactor(0.5)).toBeCloseTo(0.5, 9);
    expect(oddsSpeedFactor(2)).toBeGreaterThan(1.15);
    expect(oddsSpeedFactor(10) - oddsSpeedFactor(3)).toBeLessThan(0.03);
  });

  it('send more, lose less still holds in normal ranges; 10x is barely better than 3x', () => {
    const s = makeFlatGame(60, 20, 2);
    claimRect(s, 1, 0, 0, 29, 19);
    claimRect(s, 2, 30, 0, 59, 19);
    s.players[1].troops = inf(1e7);
    s.players[2].troops = inf(10000);
    const t = at(s, 30, 10);
    const loss = (n: number): number => estimateAttack(s, 1, t, inf(n))!.lossPerTile;
    expect(loss(15000)).toBeLessThan(loss(10000));
    expect(loss(20000)).toBeLessThan(loss(15000));
    expect(loss(30000)).toBeLessThan(loss(20000));
    // Per unit, a 10:1 attack loses about what a 3:1 attack loses (within 5%).
    expect(loss(100000) / loss(30000)).toBeGreaterThan(0.95);
  });
});

describe('heartland', () => {
  function twoNations(): GameState {
    const s = makeFlatGame(100, 40, 2);
    claimRect(s, 1, 0, 0, 49, 39);
    claimRect(s, 2, 50, 0, 99, 39);
    s.players[1].capital = at(s, 25, 20);
    giveHeart(s, 1);
    s.players[1].troops = inf(20000);
    s.players[2].troops = inf(20000);
    return s;
  }

  it('defends best at the capital, fading to nothing at the edge of its radius', () => {
    const s = twoNations();
    const r = heartlandRadius(s, 1);
    expect(r).toBeGreaterThan(5);
    expect(r).toBeLessThanOrEqual(HEARTLAND_RADIUS_MAX);
    expect(coreDefenseAt(s, 1, at(s, 25, 20))).toBeCloseTo(1 + HEARTLAND_DEFENSE, 9);
    const mid = coreDefenseAt(s, 1, at(s, 25 + Math.floor(r / 2), 20));
    expect(mid).toBeGreaterThan(1);
    expect(mid).toBeLessThan(1 + HEARTLAND_DEFENSE);
    expect(coreDefenseAt(s, 1, at(s, 25 + Math.ceil(r) + 1, 20))).toBe(1);
    // Not 1's tile, or no heartland at all.
    expect(coreDefenseAt(s, 1, at(s, 60, 20))).toBe(1);
    expect(coreDefenseAt(s, 2, at(s, 75, 20))).toBe(1);
    expect(coreDefenseAt(s, 1, -3)).toBe(1);
    // Attacks pay more and move slower there.
    s.players[2].troops = inf(20000);
    const near = estimateAttack(s, 2, at(s, 26, 20), inf(10000), 10)!;
    const far = estimateAttack(s, 2, at(s, 49, 20), inf(10000), 10)!;
    expect(near.lossPerTile / far.lossPerTile).toBeGreaterThan(1.5);
    expect(near.tilesPerSecond).toBeLessThan(far.tilesPerSecond);
  });

  it('grows modestly with land and the capital city level, capped', () => {
    const s = twoNations();
    const r0 = heartlandRadius(s, 1);
    claimRect(s, 1, 50, 0, 79, 39); // more land
    const r1 = heartlandRadius(s, 1);
    expect(r1).toBeGreaterThan(r0);
    expect(r1).toBeLessThan(r0 * 1.5);
    expect(heartlandRadius(s, 1)).toBeLessThanOrEqual(HEARTLAND_RADIUS_MAX);
  });

  it('moves to the new capital only after a delay when the capital falls', () => {
    const s = twoNations();
    const old = s.players[1].capital;
    setOwner(s, old, 2); // capital captured: moveCapital picks a new one
    const cap = s.players[1].capital;
    expect(cap).not.toBe(old);
    expect(s.players[1].heartTile).toBe(old);
    s.tick += HEARTLAND_MOVE_SECONDS * TICKS_PER_SECOND - 1;
    updateHeartlands(s);
    expect(s.players[1].heartTile).toBe(old);
    s.tick += 1;
    updateHeartlands(s);
    expect(s.players[1].heartTile).toBe(cap);
    expect(coreDefenseAt(s, 1, cap)).toBeCloseTo(1 + HEARTLAND_DEFENSE, 9);
  });

  it('a capital that keeps falling back does not push the heartland move back', () => {
    const s = twoNations();
    const old = s.players[1].capital;
    setOwner(s, old, 2);
    const first = s.players[1].heartMoveTick;
    expect(first).toBeGreaterThan(0);
    const cap = s.players[1].capital;
    s.tick += 10 * TICKS_PER_SECOND;
    setOwner(s, cap, 2); // the new capital falls too, 10 s later
    expect(s.players[1].heartMoveTick).toBe(first);
    s.tick = first;
    updateHeartlands(s);
    expect(s.players[1].heartTile).toBe(s.players[1].capital);
  });
});

describe('last stand', () => {
  it('helps a much smaller nation (army or land), scaled by the gap and capped', () => {
    const s = makeFlatGame(100, 20, 3);
    claimRect(s, 1, 0, 0, 9, 19); // 200 tiles
    claimRect(s, 2, 10, 0, 59, 19); // 1000 tiles
    claimRect(s, 3, 60, 0, 99, 19); // 800 tiles
    s.players[1].troops = inf(10000);
    s.players[2].troops = inf(10000);
    s.players[3].troops = inf(10000);
    expect(lastStandFactor(s, 3, 2)).toBe(1); // similar size
    expect(lastStandFactor(s, 2, 1)).toBe(1); // the attacker is the small one
    const byLand = lastStandFactor(s, 1, 2); // 5x the land
    expect(byLand).toBeGreaterThan(1);
    s.tick++;
    s.players[2].troops = inf(80000); // 8x the army
    const byArmy = lastStandFactor(s, 1, 2);
    expect(byArmy).toBeGreaterThan(byLand);
    expect(byArmy).toBeLessThanOrEqual(1 + LAST_STAND_MAX);
    // It shows in the attack estimate: same attack and defender, only the attacker's size differs.
    const big = estimateAttack(s, 2, at(s, 9, 10), inf(30000))!;
    s.tick++;
    s.players[2].troops = inf(10000);
    const small = estimateAttack(s, 2, at(s, 9, 10), inf(30000))!;
    expect(big.lossPerTile / small.lossPerTile).toBeCloseTo(byArmy / byLand, 6);
    expect(big.lossPerTile / small.lossPerTile).toBeLessThan(DEFENSE_BONUS_CAP);
  });

  it('a small nation against one 5x bigger holds its capital for a while, but loses land without help', () => {
    const s = makeFlatGame(150, 40, 2);
    claimRect(s, 1, 0, 0, 29, 39); // 1200 tiles
    claimRect(s, 2, 30, 0, 149, 39); // 4800 tiles
    s.players[1].capital = at(s, 15, 20);
    giveHeart(s, 1);
    s.players[1].troops = inf(60000);
    s.players[2].troops = inf(300000);
    const start = s.players[1].tiles;
    let capitalFell = -1;
    // The big one sends 35% of its army whenever its attack runs low (no economy: no regrowth either side).
    for (let k = 0; k < 120 * TICKS_PER_SECOND && s.players[1].alive; k++) {
      const a = s.attacks.find((x) => x.attacker === 2);
      if (!a || troopSum(a.troops) < 5000) applyAction(s, 2, { type: 'attack', tile: s.map.owner.indexOf(1), troops: inf(troopSum(s.players[2].troops) * 0.35) });
      updateSupply(s);
      updateAttacks(s);
      s.tick++;
      if (capitalFell < 0 && s.map.owner[at(s, 15, 20)] !== 1) capitalFell = k / TICKS_PER_SECOND;
    }
    expect(s.players[1].tiles).toBeLessThan(start * 0.8); // it does lose land
    expect(capitalFell === -1 || capitalFell > 60).toBe(true); // but the core holds for over a minute
  });
});

describe('coalitions against a runaway leader', () => {
  function world(): GameState {
    // 1: huge leader (human), 2..4: AIs.
    const s = makeFlatGame(100, 40, 4, { human: true });
    lateGame(s);
    claimRect(s, 1, 0, 0, 49, 39); // 50% of the land
    claimRect(s, 2, 50, 0, 66, 39);
    claimRect(s, 3, 67, 0, 83, 39);
    claimRect(s, 4, 84, 0, 99, 39);
    for (const p of s.players) if (p.id > 0) p.troops = inf(50000);
    return s;
  }

  it('finds the leader only when it is big and clearly ahead', () => {
    const s = world();
    expect(runawayLeader(s)).toBe(1);
    expect(inCoalition(s, 2)).toBe(true); // borders it (and the leader holds 50%)
    expect(inCoalition(s, 1)).toBe(false);
    const even = makeFlatGame(100, 40, 2);
    claimRect(even, 1, 0, 0, 49, 39);
    claimRect(even, 2, 50, 0, 99, 39);
    expect(runawayLeader(even)).toBe(0);
  });

  it('AIs refuse the leader (a human too) and welcome fellow members', () => {
    const s = world();
    for (let a = 2; a <= 4; a++) for (let b = 2; b <= 4; b++) if (a !== b) s.opinion[a][b] = 0;
    s.opinion[2][1] = 90;
    expect(aiWantsAlliance(s, 2, 1)).toBe(false);
    expect(aiWantsAlliance(s, 3, 4)).toBe(true);
    expect(aiWantsAlliance(s, 2, 3)).toBe(true);
  });

  it('coalition AIs go to war on the leader', () => {
    const s = world();
    s.settings.difficulty = 'hard'; // no human protections in the way
    for (const p of s.players) if (p.id > 1) p.troops = inf(150000);
    s.players[1].troops = inf(60000);
    let hit = false;
    for (let k = 0; k < 40 * TICKS_PER_SECOND && !hit; k++) {
      tick(s);
      hit = s.attacks.some((a) => a.target === 1 && a.attacker > 1);
    }
    expect(hit).toBe(true);
  });
});

describe('allies that do things', () => {
  /** 1 human (west), 2 AI (middle), 3 AI (east), 1 and 3 allied; equal armies. */
  function trio(): GameState {
    const s = makeFlatGame(90, 30, 3, { human: true });
    lateGame(s);
    claimRect(s, 1, 0, 0, 29, 29);
    claimRect(s, 2, 30, 0, 59, 29);
    claimRect(s, 3, 60, 0, 89, 29);
    for (const p of s.players) if (p.id > 0) p.troops = inf(80000);
    formAlliance(s, 1, 3);
    return s;
  }
  const kinds = (s: GameState, kind: string): string[] => s.events.filter((e) => e.kind === kind).map((e) => e.message);

  it('validates requests: allies only, a real target, a cooldown, one pending request per ally', () => {
    const s = trio();
    expect(applyAction(s, 1, { type: 'requestAllyAttack', ally: 2, target: 3 }).reason).toMatch(/not your ally/);
    expect(applyAction(s, 1, { type: 'requestAllyAttack', ally: 3, target: 3 }).ok).toBe(false);
    expect(applyAction(s, 1, { type: 'requestAllyAttack', ally: 3, target: 1 }).ok).toBe(false);
    expect(applyAction(s, 1, { type: 'requestAllyAttack', ally: 3, target: 77 }).ok).toBe(false);
    expect(applyAction(s, 1, { type: 'requestAllyAttack', ally: 3, target: 2 }).ok).toBe(true);
    expect(s.allyRequests).toHaveLength(1);
    expect(applyAction(s, 1, { type: 'requestAllyAid', ally: 3 }).reason).toMatch(/Wait \d+ s/);
    s.tick += ALLY_REQUEST_COOLDOWN * TICKS_PER_SECOND;
    expect(applyAction(s, 1, { type: 'requestAllyAid', ally: 3 }).reason).toMatch(/not answered/);
  });

  it('an AI ally asked to attack really attacks (allyJoined) and keeps that war pledged', () => {
    const s = trio();
    expect(applyAction(s, 1, { type: 'requestAllyAttack', ally: 3, target: 2 }).ok).toBe(true);
    for (let k = 0; k < 6 * TICKS_PER_SECOND && s.allyRequests.length; k++) tick(s);
    expect(s.allyRequests).toHaveLength(0);
    expect(kinds(s, 'allyJoined').some((m) => /joins your war against AI 2/.test(m))).toBe(true);
    expect(s.attacks.some((a) => a.attacker === 3 && a.target === 2)).toBe(true);
    expect(pledgesOf(s, 3).map((p) => p.target)).toContain(2);
  });

  it('refuses with a reason when it cannot (no border with the target)', () => {
    // The human asks 3 to attack a nation 3 does not border (a 4th nation west of the human).
    const s2 = makeFlatGame(120, 30, 4, { human: true });
    lateGame(s2);
    claimRect(s2, 4, 0, 0, 29, 29);
    claimRect(s2, 1, 30, 0, 59, 29);
    claimRect(s2, 2, 60, 0, 89, 29);
    claimRect(s2, 3, 90, 0, 119, 29);
    for (const p of s2.players) if (p.id > 0) p.troops = inf(80000);
    formAlliance(s2, 1, 3);
    expect(applyAction(s2, 1, { type: 'requestAllyAttack', ally: 3, target: 4 }).ok).toBe(true);
    for (let k = 0; k < 6 * TICKS_PER_SECOND && s2.allyRequests.length; k++) tick(s2);
    const no = kinds(s2, 'allyRefused');
    expect(no.some((m) => /AI 3 refused: it has no border with AI 4/.test(m))).toBe(true);
    expect(s2.attacks.some((a) => a.attacker === 3 && a.target === 4)).toBe(false);
  });

  it('sends troops when asked by an ally under attack (allyAid), refuses when it is not needed', () => {
    const s = trio();
    s.players[1].troops = inf(250000); // a full bar, nobody attacking
    expect(applyAction(s, 1, { type: 'requestAllyAid', ally: 3 }).ok).toBe(true);
    for (let k = 0; k < 6 * TICKS_PER_SECOND && s.allyRequests.length; k++) tick(s);
    expect(kinds(s, 'allyRefused').some((m) => /you have enough troops/.test(m))).toBe(true);
    // Now 2 attacks the human with a big force and the human asks again.
    s.tick += ALLY_REQUEST_COOLDOWN * TICKS_PER_SECOND;
    s.players[2].troops = inf(400000);
    s.players[3].troops = inf(250000); // more than half its cap: troops to spare
    s.players[1].troops = inf(20000); // and the human is losing badly
    expect(applyAction(s, 2, { type: 'attack', tile: at(s, 29, 10), troops: inf(300000) }).ok).toBe(true);
    expect(applyAction(s, 1, { type: 'requestAllyAid', ally: 3 }).ok).toBe(true);
    for (let k = 0; k < 6 * TICKS_PER_SECOND && s.allyRequests.length; k++) tick(s);
    expect(kinds(s, 'allyAid').some((m) => /AI 3 sent you \d+k troops/.test(m))).toBe(true);
  });

  it('joins on its own when its ally is attacked by a nation it borders', () => {
    const s = trio();
    // 2 attacks the human; 3 (the human's ally) borders 2.
    s.players[2].troops = inf(200000);
    expect(applyAction(s, 2, { type: 'attack', tile: at(s, 29, 10), troops: inf(150000) }).ok).toBe(true);
    for (let k = 0; k < 8 * TICKS_PER_SECOND; k++) tick(s);
    expect(s.attacks.some((a) => a.attacker === 3 && a.target === 2) || kinds(s, 'allyJoined').length > 0 || kinds(s, 'allyAid').length > 0).toBe(true);
    expect(kinds(s, 'allyJoined').concat(kinds(s, 'allyAid')).some((m) => /AI 3/.test(m))).toBe(true);
  });

  it('allyStatus reports opinion, wars, and whether it would help', () => {
    const s = trio();
    const st = allyStatus(s, 1, 3);
    expect(st.opinion).toBeGreaterThan(0);
    expect(st.atWarWith).toEqual([]);
    expect(st.willHelp).toBe(true);
    expect(typeof st.reason).toBe('string');
    const notAlly = allyStatus(s, 1, 2);
    expect(notAlly.willHelp).toBe(false);
    expect(notAlly.reason).toMatch(/not allies/);
    applyAction(s, 2, { type: 'attack', tile: at(s, 60, 5), troops: inf(10000) });
    expect(allyStatus(s, 1, 3).atWarWith).toEqual([2]);
  });

  it('is deterministic: identical games with ally requests hash the same; the new state is hashed', () => {
    const run = (): number => {
      const s = trio();
      applyAction(s, 1, { type: 'requestAllyAttack', ally: 3, target: 2 });
      for (let k = 0; k < 15 * TICKS_PER_SECOND; k++) tick(s);
      return hashState(s);
    };
    expect(run()).toBe(run());
    const s = trio();
    const h0 = hashState(s);
    s.players[1].heartTile = 5;
    const h1 = hashState(s);
    expect(h1).not.toBe(h0);
    s.allyPledges.push({ helper: 3, friend: 1, target: 2, untilTick: 99 });
    expect(hashState(s)).not.toBe(h1);
  });
});
