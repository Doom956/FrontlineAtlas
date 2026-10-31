// Tutorial scenarios (src/sim/tutorialScenario.ts): every chapter sets up, its named tiles work for the steps,
// the player can't be eliminated, frozen AIs stay still, and the setup is deterministic.
import { describe, expect, it } from 'vitest';
import { applyAction } from '../src/sim/actions';
import { inCoalition, runawayLeader } from '../src/sim/allies';
import { buildingAt } from '../src/sim/buildings';
import { borders } from '../src/sim/combat';
import { DOCTRINE_UNLOCK_SECONDS, TICKS_PER_SECOND } from '../src/sim/config';
import { areAllied } from '../src/sim/diplomacy';
import { doctrineUnlocked, doctrineUnlockSeconds } from '../src/sim/doctrines';
import { hashState } from '../src/sim/hash';
import { tick } from '../src/sim/sim';
import { setOwner } from '../src/sim/state';
import { isWater } from '../src/sim/types';
import type { Action, GameState, TechId } from '../src/sim/types';
import {
  createTutorialGame,
  TUTORIAL_CHAPTER_IDS,
  TUTORIAL_MIN_TILES,
  TUTORIAL_ROLES,
  TUTORIAL_TILE_KEYS,
  tutorialEnemyAttack,
  tutorialFinish,
  tutorialGrant,
  tutorialPlayer,
  tutorialStart,
  tutorialTile,
  tutorialWake,
} from '../src/sim/tutorialScenario';
import type { TutorialChapterId } from '../src/sim/tutorialScenario';
import { makeTestGame } from './helpers';

const run = (s: GameState, seconds: number): void => {
  for (let k = 0; k < seconds * TICKS_PER_SECOND; k++) tick(s);
};
const act = (s: GameState, a: Action): void => {
  const r = applyAction(s, s.tutorial!.human, a);
  expect(r, `${a.type}: ${r.reason}`).toMatchObject({ ok: true });
};
const T = (s: GameState, key: string): number => tutorialTile(s, s.tutorial!.chapter, key);
const role = (s: GameState, r: string): number => tutorialPlayer(s, s.tutorial!.chapter, r);
const research = (s: GameState, tech: TechId): void => {
  act(s, { type: 'research', tech });
  tutorialFinish(s, s.tutorial!.human);
};

describe('tutorial chapters', () => {
  it.each(TUTORIAL_CHAPTER_IDS.map((c) => [c]))('%s sets up and plays safely', (ch: TutorialChapterId) => {
    const s = createTutorialGame(ch);
    const me = s.players[s.tutorial!.human];
    expect(s.tutorial!.chapter).toBe(ch);
    expect(s.phase).toBe(ch === 'basics' ? 'spawn' : 'playing');
    for (const r of TUTORIAL_ROLES[ch]) {
      const p = s.players[role(s, r)];
      expect(p && p.alive && p.spawned, r).toBe(true);
      expect(s.map.owner[p.capital]).toBe(p.id);
    }
    for (const key of TUTORIAL_TILE_KEYS[ch]) {
      const t = T(s, key);
      expect(t, key).toBeGreaterThanOrEqual(0);
      expect(t, key).toBeLessThan(s.map.width * s.map.height);
      expect(isWater(s.map.terrain[t]), key).toBe(key === 'sea');
    }
    expect(T(s, 'nope')).toBe(-1);
    if (ch === 'basics') {
      act(s, { type: 'spawn', tile: T(s, 'spawn') });
      expect(tutorialStart(s)).toBe(true);
      tick(s);
      expect(s.phase).toBe('playing');
    } else expect(me.tiles).toBeGreaterThan(300);
    run(s, 60);
    expect(s.phase).toBe('playing');
    expect(me.alive).toBe(true);
    // Frozen AIs and tribes did nothing to the player.
    expect(s.attacks.filter((a) => a.target === me.id)).toHaveLength(0);
  });

  it('basics: spawn, expand, a city', () => {
    const s = createTutorialGame('basics');
    act(s, { type: 'spawn', tile: T(s, 'spawn') });
    tutorialStart(s);
    tick(s);
    expect(doctrineUnlockSeconds(s)).toBe(DOCTRINE_UNLOCK_SECONDS); // Basics keeps the normal 5:00
    act(s, { type: 'attack', tile: T(s, 'wild'), troops: { infantry: 8000, armor: 0, artillery: 0 } });
    act(s, { type: 'build', building: 'city', tile: T(s, 'citySite') });
    run(s, 40);
    const me = s.tutorial!.human;
    expect(borders(s, me, role(s, 'tribe'))).toBe(true); // expanding reaches the nearest tribe
    act(s, { type: 'attack', tile: T(s, 'tribe'), troops: { infantry: 5000, armor: 0, artillery: 0 } });
  });

  it('war: tribe and rival share a border, fort, barrage in reach, doctrines at 0:00', () => {
    const s = createTutorialGame('war');
    const me = s.tutorial!.human;
    expect(borders(s, me, role(s, 'tribe'))).toBe(true);
    expect(borders(s, me, role(s, 'rival'))).toBe(true);
    expect(s.map.owner[T(s, 'front')]).toBe(role(s, 'rival'));
    expect(buildingAt(s, T(s, 'fort'))?.type).toBe('fort');
    expect(doctrineUnlocked(s, me)).toBe(true);
    act(s, { type: 'chooseDoctrine', doctrine: 'siege' });
    act(s, { type: 'build', building: 'fort', tile: T(s, 'fortSite') });
    act(s, { type: 'barrage', tile: T(s, 'barrageTarget') });
    act(s, { type: 'attack', tile: T(s, 'tribe'), troops: { infantry: 8000, armor: 0, artillery: 0 } });
    act(s, { type: 'attack', tile: T(s, 'front'), troops: { infantry: 15000, armor: 0, artillery: 0 } });
  });

  it('economy: every site builds, research and a doctrine', () => {
    const s = createTutorialGame('economy');
    for (const [b, k] of [['mine', 'mineSite'], ['oilWell', 'wellSite'], ['farm', 'farmSite'], ['market', 'marketSite'], ['lab', 'labSite'], ['city', 'citySite']] as const) {
      act(s, { type: 'build', building: b, tile: T(s, k) });
    }
    expect(s.players[s.tutorial!.human].auto.research).toBe(false);
    act(s, { type: 'research', tech: 'agriculture' });
    tick(s);
    expect(s.players[s.tutorial!.human].techs).toContain('agriculture'); // granted science finishes it at once
    act(s, { type: 'chooseDoctrine', doctrine: 'merchant' });
  });

  it('navy: port, warship, enemy port across the strait', () => {
    const s = createTutorialGame('navy');
    const me = s.tutorial!.human;
    const islander = role(s, 'islander');
    expect(buildingAt(s, T(s, 'enemyPort'))).toMatchObject({ type: 'port', owner: islander });
    expect(s.map.owner[T(s, 'enemyCoast')]).toBe(islander);
    expect(s.map.coastal[T(s, 'enemyCoast')]).toBe(1);
    act(s, { type: 'build', building: 'port', tile: T(s, 'portSite') });
    tutorialFinish(s, me);
    act(s, { type: 'buildWarship', port: T(s, 'portSite') });
    tutorialFinish(s, me);
    run(s, 1);
    const ships = s.units.filter((u) => u.owner === me && u.type === 'warship');
    expect(ships.length).toBe(1);
    act(s, { type: 'moveWarship', unitId: ships[0].id, tile: T(s, 'sea') });
    act(s, { type: 'transport', from: T(s, 'portSite'), to: T(s, 'enemyCoast'), troops: { infantry: 10000, armor: 0, artillery: 0 } });
  });

  it('armor: factory, tank division, spearhead into the weak neighbour', () => {
    const s = createTutorialGame('armor');
    const me = s.tutorial!.human;
    expect(borders(s, me, role(s, 'rival'))).toBe(true);
    act(s, { type: 'build', building: 'factory', tile: T(s, 'factorySite') });
    tutorialFinish(s, me);
    act(s, { type: 'buildTankDivision', tile: T(s, 'factorySite') });
    tutorialFinish(s, me);
    run(s, 1);
    const div = s.units.filter((u) => u.owner === me && u.type === 'tankDivision');
    expect(div.length).toBe(1);
    act(s, { type: 'moveTankDivision', unitIds: [div[0].id], tile: T(s, 'rally') });
  });

  it('air: airfield, SAM, enemy city and drop zone in reach', () => {
    const s = createTutorialGame('air');
    const me = s.tutorial!.human;
    const rival = role(s, 'rival');
    expect(buildingAt(s, T(s, 'enemyCity'))).toMatchObject({ type: 'city', owner: rival });
    expect(s.map.owner[T(s, 'dropZone')]).toBe(rival);
    act(s, { type: 'build', building: 'airfield', tile: T(s, 'airfieldSite') });
    act(s, { type: 'build', building: 'sam', tile: T(s, 'samSite') });
    tutorialFinish(s, me);
    act(s, { type: 'buildAircraft', airfield: T(s, 'airfieldSite'), kind: 'bomber' });
    act(s, { type: 'paradrop', airfield: T(s, 'airfieldSite'), tile: T(s, 'dropZone'), troops: 3000 });
  });

  it('arsenal: a fork, the mastery cap, a special, an area upgrade', () => {
    const s = createTutorialGame('arsenal');
    const me = s.tutorial!.human;
    const p = s.players[me];
    expect(p.techs).toContain('navalMastery');
    research(s, 'lightTanks');
    expect(applyAction(s, me, { type: 'research', tech: 'heavyTanks' }).ok).toBe(false); // the other side of the fork
    research(s, 'deepRaids');
    research(s, 'armorMastery');
    research(s, 'groundAttack');
    research(s, 'jetEngines');
    const capped = applyAction(s, me, { type: 'research', tech: 'airMastery' });
    expect(capped.ok).toBe(false); // two masteries already
    research(s, 'amphibiousTanks');
    act(s, { type: 'upgradeArea', tile: T(s, 'upgradeArea'), radius: 25, levels: 1 });
    expect(buildingAt(s, T(s, 'factory'))?.type).toBe('factory');
  });

  it('diplomacy: a runaway leader, a coalition, an alliance, a missile', () => {
    const s = createTutorialGame('diplomacy');
    const me = s.tutorial!.human;
    const leader = role(s, 'leader');
    const friend = role(s, 'friendA');
    expect(runawayLeader(s)).toBe(leader);
    expect(inCoalition(s, friend)).toBe(true);
    expect(inCoalition(s, me)).toBe(true);
    act(s, { type: 'requestAlliance', to: friend });
    run(s, 15);
    expect(areAllied(s, me, friend)).toBe(true);
    act(s, { type: 'launchMissile', silo: T(s, 'silo'), kind: 'atomBomb', tile: T(s, 'leaderMainland') });
  });
});

describe('tutorial rules', () => {
  it('the player cannot be eliminated', () => {
    const s = createTutorialGame('war');
    const me = s.players[s.tutorial!.human];
    const rival = role(s, 'rival');
    me.troops = { infantry: 100, armor: 0, artillery: 0 };
    tutorialGrant(s, rival, { troops: 400000 });
    tutorialWake(s, [rival], { hostile: true });
    expect(tutorialEnemyAttack(s, rival)).toBe(true);
    run(s, 180);
    expect(me.alive).toBe(true);
    expect(me.tiles).toBeGreaterThanOrEqual(TUTORIAL_MIN_TILES - 1);
    expect(s.phase).toBe('playing');
    // Even if every tile goes (a nuke, a bug), the player is back next tick.
    for (let i = 0; i < s.map.owner.length; i++) if (s.map.owner[i] === me.id) setOwner(s, i, rival);
    expect(me.alive).toBe(false);
    tick(s);
    expect(me.alive).toBe(true);
    expect(me.tiles).toBeGreaterThan(0);
    expect(s.map.owner[me.capital]).toBe(me.id);
  });

  it('beating every AI does not end the game', () => {
    const s = createTutorialGame('armor');
    const rival = role(s, 'rival');
    for (let i = 0; i < s.map.owner.length; i++) if (s.map.owner[i] === rival) setOwner(s, i, s.tutorial!.human);
    run(s, 2);
    expect(s.phase).toBe('playing');
  });

  it('woken AIs decide again; non-hostile ones still leave the player alone', () => {
    const s = createTutorialGame('war');
    const rival = role(s, 'rival');
    expect(s.tutorial!.frozen).toContain(rival);
    tutorialWake(s, [rival]);
    expect(s.tutorial!.frozen).not.toContain(rival);
    expect(s.admin!.aiPassive).toContain(s.tutorial!.human);
    tutorialWake(s, 'all', { hostile: true });
    expect(s.tutorial!.frozen).toHaveLength(0);
    expect(s.admin!.aiPassive).not.toContain(s.tutorial!.human);
  });

  it('is deterministic, and the tutorial state is in the hash', () => {
    const play = (): GameState => {
      const s = createTutorialGame('diplomacy');
      run(s, 20);
      return s;
    };
    const a = play();
    const b = play();
    expect(hashState(a)).toBe(hashState(b));
    const h = hashState(a);
    tutorialWake(a, [role(a, 'leader')]);
    expect(hashState(a)).not.toBe(h);
  });

  it('normal games are untouched', () => {
    const s = makeTestGame();
    expect(s.tutorial).toBeUndefined();
    expect(doctrineUnlockSeconds(s)).toBe(DOCTRINE_UNLOCK_SECONDS);
  });
});
