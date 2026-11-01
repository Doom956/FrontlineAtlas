// The tutorial scenario (src/sim/tutorialScenario.ts): it sets up, its named tiles work for the steps, the tribe and
// the weak neighbour are one expansion away, the player can't be eliminated, frozen AIs stay still, and the setup is
// deterministic.
import { describe, expect, it } from 'vitest';
import { applyAction } from '../src/sim/actions';
import { borders } from '../src/sim/combat';
import { DOCTRINE_UNLOCK_SECONDS, TICKS_PER_SECOND } from '../src/sim/config';
import { doctrineUnlockSeconds } from '../src/sim/doctrines';
import { hashState } from '../src/sim/hash';
import { tick } from '../src/sim/sim';
import { setOwner } from '../src/sim/state';
import { isTribe, isWater } from '../src/sim/types';
import type { Action, GameState } from '../src/sim/types';
import {
  createTutorialGame,
  TUTORIAL_ID,
  TUTORIAL_MIN_TILES,
  TUTORIAL_ROLES,
  TUTORIAL_TILE_KEYS,
  tutorialEnemyAttack,
  tutorialGrant,
  tutorialPlayer,
  tutorialStart,
  tutorialTile,
  tutorialWake,
  tutorialWeaken,
} from '../src/sim/tutorialScenario';
import { makeTestGame } from './helpers';

const run = (s: GameState, seconds: number): void => {
  for (let k = 0; k < seconds * TICKS_PER_SECOND; k++) tick(s);
};
const act = (s: GameState, a: Action): void => {
  const r = applyAction(s, s.tutorial!.human, a);
  expect(r, `${a.type}: ${r.reason}`).toMatchObject({ ok: true });
};
const T = (s: GameState, key: string): number => tutorialTile(s, key);
const role = (s: GameState, r: string): number => tutorialPlayer(s, r);
/** A tutorial game with the capital placed on the suggested start and the game started. */
function started(): GameState {
  const s = createTutorialGame();
  act(s, { type: 'spawn', tile: T(s, 'spawn') });
  expect(tutorialStart(s)).toBe(true);
  tick(s);
  return s;
}

describe('the tutorial scenario', () => {
  it('sets up a spawn phase that waits, with a frozen tribe and neighbour', () => {
    const s = createTutorialGame();
    expect(s.tutorial!.chapter).toBe(TUTORIAL_ID);
    expect(s.phase).toBe('spawn');
    expect(TUTORIAL_ROLES).toEqual(['rival', 'tribe']);
    for (const r of TUTORIAL_ROLES) {
      const p = s.players[role(s, r)];
      expect(p && p.alive && p.spawned, r).toBe(true);
      expect(s.map.owner[p.capital]).toBe(p.id);
      expect(s.tutorial!.frozen).toContain(p.id);
    }
    expect(isTribe(s.players[role(s, 'tribe')])).toBe(true);
    expect(isTribe(s.players[role(s, 'rival')])).toBe(false);
    for (const key of TUTORIAL_TILE_KEYS) {
      const t = T(s, key);
      expect(t, key).toBeGreaterThanOrEqual(0);
      expect(t, key).toBeLessThan(s.map.width * s.map.height);
      expect(isWater(s.map.terrain[t]), key).toBe(false);
    }
    expect(T(s, 'nope')).toBe(-1);
    // the player picks the research by hand; doctrines keep the normal unlock time
    expect(s.players[s.humanId].auto.research).toBe(false);
    expect(doctrineUnlockSeconds(s)).toBe(DOCTRINE_UNLOCK_SECONDS);
  });

  it('the first expansion reaches the tribe and the weak neighbour', () => {
    const s = started();
    const me = s.players[s.tutorial!.human];
    expect(s.phase).toBe('playing');
    act(s, { type: 'attack', tile: T(s, 'wild'), troops: { infantry: Math.floor(me.troops.infantry / 2), armor: 0, artillery: 0 } });
    run(s, 8);
    expect(borders(s, me.id, role(s, 'tribe'))).toBe(true);
    expect(borders(s, me.id, role(s, 'rival'))).toBe(true);
    expect(s.map.owner[T(s, 'front')]).toBe(role(s, 'rival'));
    // frozen AIs still grow troops; an attack step can cut one down (never the player, never an awake AI)
    tutorialWeaken(s, role(s, 'rival'), 2000);
    expect(s.players[role(s, 'rival')].troops.infantry).toBe(2000);
    tutorialWeaken(s, me.id, 0);
    expect(me.troops.infantry).toBeGreaterThan(0);
    tutorialWake(s, [role(s, 'tribe')]);
    const tribeTroops = s.players[role(s, 'tribe')].troops.infantry;
    tutorialWeaken(s, role(s, 'tribe'), 0);
    expect(s.players[role(s, 'tribe')].troops.infantry).toBe(tribeTroops);
    act(s, { type: 'attack', tile: T(s, 'tribe'), troops: { infantry: 6000, armor: 0, artillery: 0 } });
    act(s, { type: 'attack', tile: T(s, 'front'), troops: { infantry: 6000, armor: 0, artillery: 0 } });
    act(s, { type: 'build', building: 'city', tile: T(s, 'citySite') });
    run(s, 60);
    expect(s.phase).toBe('playing');
    expect(me.alive).toBe(true);
    // frozen AIs did nothing to the player
    expect(s.attacks.filter((a) => a.target === me.id)).toHaveLength(0);
  });
});

describe('tutorial rules', () => {
  it('the player cannot be eliminated', () => {
    const s = started();
    const me = s.players[s.tutorial!.human];
    const rival = role(s, 'rival');
    act(s, { type: 'attack', tile: T(s, 'wild'), troops: { infantry: 12000, armor: 0, artillery: 0 } });
    run(s, 8);
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
    const s = started();
    for (const r of TUTORIAL_ROLES) {
      const id = role(s, r);
      for (let i = 0; i < s.map.owner.length; i++) if (s.map.owner[i] === id) setOwner(s, i, s.tutorial!.human);
    }
    run(s, 2);
    expect(s.phase).toBe('playing');
  });

  it('woken AIs decide again; non-hostile ones still leave the player alone', () => {
    const s = createTutorialGame();
    const rival = role(s, 'rival');
    tutorialWake(s, [rival]);
    expect(s.tutorial!.frozen).not.toContain(rival);
    expect(s.admin!.aiPassive).toContain(s.tutorial!.human);
    tutorialWake(s, 'all', { hostile: true });
    expect(s.tutorial!.frozen).toHaveLength(0);
    expect(s.admin!.aiPassive).not.toContain(s.tutorial!.human);
  });

  it('is deterministic, and the tutorial state is in the hash', () => {
    const play = (): GameState => {
      const s = started();
      run(s, 20);
      return s;
    };
    const a = play();
    const b = play();
    expect(hashState(a)).toBe(hashState(b));
    const h = hashState(a);
    tutorialWake(a, [role(a, 'rival')]);
    expect(hashState(a)).not.toBe(h);
  });

  it('normal games are untouched', () => {
    const s = makeTestGame();
    expect(s.tutorial).toBeUndefined();
    expect(doctrineUnlockSeconds(s)).toBe(DOCTRINE_UNLOCK_SECONDS);
  });
});
