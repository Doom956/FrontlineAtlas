// The tutorial's content (src/client/tutorial/steps.ts): one quick tutorial, well formed (ids, text lengths, a goal or
// Next on every step, targets that parse, tiles that exist), no step done at the start, and a scripted player who
// does what each step says gets through it with the real step runner in a few minutes of game time.
import { describe, expect, it } from 'vitest';
import { applyAction } from '../src/sim/actions';
import { borders } from '../src/sim/combat';
import { tick } from '../src/sim/sim';
import {
  createTutorialGame,
  TUTORIAL_ID,
  tutorialEnemyAttack,
  tutorialFinish,
  tutorialFreeze,
  tutorialGrant,
  tutorialPlayer,
  tutorialStart,
  tutorialTile,
  tutorialWake,
  tutorialWeaken,
} from '../src/sim/tutorialScenario';
import type { Action, GameState, Player } from '../src/sim/types';
import { QUICK_TUTORIAL } from '../src/client/tutorial/steps';
import { stepTarget, targetSelectors, TutorialRunner, type TutorialApi, type TutorialUi } from '../src/client/tutorial/engine';

const MAX_TEXT = 90;
const MAX_LABEL = 24;
const T = QUICK_TUTORIAL;

const freshUi = (): TutorialUi => ({
  attackShare: 0.3,
  openPanel: null,
  researchTab: 'research',
  selectedUnits: 0,
  buildMode: null,
  mode: 'none',
  aiming: null,
  selectedBuildings: 0,
  selectedTile: -1,
  nationCard: 0,
  buildCount: 1,
  paused: false,
  speed: 1,
});

function apiFor(s: GameState): TutorialApi {
  return {
    state: () => s,
    me: () => s.players[s.humanId],
    grant: (g) => tutorialGrant(s, s.humanId, g),
    wake: (ids, opts) => tutorialWake(s, ids, opts),
    freeze: (ids) => tutorialFreeze(s, ids),
    tile: (key) => tutorialTile(s, key),
    player: (r) => tutorialPlayer(s, r),
    weaken: (id, troops) => tutorialWeaken(s, id, troops),
    enemyAttack: (id) => tutorialEnemyAttack(s, id),
    finish: () => tutorialFinish(s, s.humanId),
    startNow: () => tutorialStart(s),
    openPanel: () => {},
    centre: () => {},
  };
}

describe('the tutorial: structure', () => {
  it('is one short tutorial of 10-12 steps, mostly hands-on', () => {
    expect(T.id).toBe(TUTORIAL_ID);
    expect(T.title.length).toBeGreaterThan(0);
    expect(T.minutes).toBeLessThanOrEqual(6);
    expect(T.steps.length).toBeGreaterThanOrEqual(10);
    expect(T.steps.length).toBeLessThanOrEqual(12);
    const ids = T.steps.map((st) => st.id);
    expect(new Set(ids).size, 'step ids unique').toBe(ids.length);
    for (const st of T.steps) {
      expect(st.text.length, st.id).toBeGreaterThan(0);
      expect(st.text.length, `${st.id}: "${st.text}"`).toBeLessThanOrEqual(MAX_TEXT);
      expect(st.text, st.id).not.toMatch(/\s{2}|\n/);
      expect(st.label, st.id).toBeTruthy();
      expect(st.label!.length, st.id).toBeLessThanOrEqual(MAX_LABEL);
      expect(st.done === undefined || typeof st.done === 'function', st.id).toBe(true);
      const target = stepTarget(st, typeof st.target === 'function' ? createTutorialGame() : null);
      for (const sel of targetSelectors(target)) expect(sel, st.id).toMatch(/^\[data-test="[\w-]+"\]$|^\[|^\./);
    }
    // at most a third of the steps are read-only, and the first one asks for something
    expect(T.steps.filter((st) => !st.done).length).toBeLessThanOrEqual(Math.ceil(T.steps.length / 3));
    expect(T.steps[0].done).toBeTypeOf('function');
    // the basics in order: capital, attack size, expand, troops and gold, a City, a tribe, a neighbour, research
    expect(ids).toEqual(['spawn', 'share', 'expand', 'troops', 'gold', 'city', 'tribe', 'neighbour', 'research', 'tech']);
  });

  it('tiles exist and nothing is done at the start', () => {
    const s = createTutorialGame();
    const me = s.players[s.humanId];
    const ui = freshUi();
    const size = s.map.width * s.map.height;
    for (const st of T.steps) {
      if (st.tile) {
        const t = st.tile(s);
        expect(t, `${st.id} tile`).toBeGreaterThanOrEqual(0);
        expect(t, `${st.id} tile`).toBeLessThan(size);
      }
      if (st.done) expect(st.done(s, me, ui), `${st.id} done at start`).toBe(false);
    }
  });
});

// ------------------------------------------------------------------------------------------------ play-through

interface Ctx {
  s: GameState;
  me: Player;
  ui: TutorialUi;
  act: (a: Action) => void;
}
const share = (c: Ctx, f: number) => ({ infantry: Math.floor(c.me.troops.infantry * f), armor: 0, artillery: 0 });
const attackAt = (key: string) => (c: Ctx) => c.act({ type: 'attack', tile: tutorialTile(c.s, key), troops: share(c, c.ui.attackShare) });
/** Waits (up to 10 s) for the expansion to reach a role's border, then attacks it there (a real click on land you
 * don't touch would send a boat). */
const attackRole = (r: string, key: string) => (c: Ctx) => {
  for (let k = 0; k < 100 && !borders(c.s, c.me.id, tutorialPlayer(c.s, r)); k++) tick(c.s);
  attackAt(key)(c);
};

/** What a player does for each step (steps not listed are read-only and get Next). */
const DRIVE: Record<string, (c: Ctx) => void> = {
  spawn: (c) => c.act({ type: 'spawn', tile: tutorialTile(c.s, 'spawn') }),
  share: (c) => (c.ui.attackShare = 0.5),
  expand: attackAt('wild'),
  city: (c) => c.act({ type: 'build', building: 'city', tile: tutorialTile(c.s, 'citySite') }),
  tribe: attackRole('tribe', 'tribe'),
  neighbour: attackRole('rival', 'front'),
  research: (c) => (c.ui.openPanel = 'research'),
  tech: (c) => c.act({ type: 'research', tech: 'agriculture' }),
};

describe('the tutorial: play-through', () => {
  it('can be finished by doing what each step says, in a few minutes of game time, without help from a clock', () => {
    const s = createTutorialGame();
    const ui = freshUi();
    const runner = new TutorialRunner(T, apiFor(s));
    const me = (): Player => s.players[s.humanId];
    let ticks = 0;
    for (const [k, st] of T.steps.entries()) {
      runner.update(s, me(), ui); // enters the step (onEnter)
      tick(s);
      ticks++;
      expect(runner.index, `at ${st.id}`).toBe(k);
      if (!st.done) {
        expect(DRIVE[st.id], `${st.id} is read-only`).toBeUndefined();
        runner.next();
        continue;
      }
      const d = DRIVE[st.id];
      expect(d, `no drive for ${st.id}`).toBeTypeOf('function');
      d({
        s,
        me: me(),
        ui,
        act: (a) => {
          const r = applyAction(s, s.humanId, a);
          expect(r, `${st.id}: ${a.type}: ${r.reason}`).toMatchObject({ ok: true });
        },
      });
      // a step registers within 10 s of game time
      for (let t = 0; t < 100 && runner.index === k && !runner.finished; t++) {
        tick(s);
        ticks++;
        if (t % 2 === 0) runner.update(s, me(), ui);
      }
      expect(runner.index > k || runner.finished, `step ${st.id} did not finish`).toBe(true);
      expect(me().alive, `alive after ${st.id}`).toBe(true);
    }
    expect(runner.finished).toBe(true);
    expect(runner.view().statuses.every((x) => x === 'done')).toBe(true);
    expect(ticks / 10, 'game seconds').toBeLessThan(60);
    // nothing attacked the player on the way
    expect(s.attacks.filter((a) => a.target === s.humanId)).toHaveLength(0);
  });

  it('a slow player is topped up: the City, the attacks and the tech never wait for income', () => {
    const s = createTutorialGame();
    const api = apiFor(s);
    const me = s.players[s.humanId];
    applyAction(s, me.id, { type: 'spawn', tile: tutorialTile(s, 'spawn') });
    tutorialStart(s);
    tick(s);
    me.gold = 0;
    me.science = 0;
    me.troops.infantry = 100;
    const enter = (id: string): void => T.steps.find((st) => st.id === id)!.onEnter!(api);
    enter('city');
    expect(applyAction(s, me.id, { type: 'build', building: 'city', tile: tutorialTile(s, 'citySite') })).toMatchObject({ ok: true });
    enter('tribe');
    expect(me.troops.infantry).toBeGreaterThanOrEqual(9000);
    enter('research');
    expect(applyAction(s, me.id, { type: 'research', tech: 'agriculture' })).toMatchObject({ ok: true });
  });
});
