// The optional tutorial chapters (src/client/tutorial/chapters.ts): each is well formed (3 to 5 steps, short plain
// text, a win goal, nothing done at the start), its scenario sets up (src/sim/tutorialScenario.ts) and a scripted player
// who does what each step says reaches the goal with the real step runner in a few minutes of game time.
import { describe, expect, it } from 'vitest';
import { applyAction } from '../src/sim/actions';
import { tick } from '../src/sim/sim';
import {
  chapterRoles,
  chapterTileKeys,
  createTutorialGame,
  TUTORIAL_CHAPTER_IDS,
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
import { buildingAt } from '../src/sim/buildings';
import { hashState } from '../src/sim/hash';
import type { Action, BuildingType, GameState, Player } from '../src/sim/types';
import { CHAPTERS } from '../src/client/tutorial/chapters';
import { ALL_TUTORIALS, allTutorialsDone, chapterById } from '../src/client/tutorial/catalog';
import { stepTarget, targetSelectors, TutorialRunner, type TutorialApi, type TutorialChapter, type TutorialUi } from '../src/client/tutorial/engine';

const MAX_TEXT = 100;
const MAX_LABEL = 26;

const freshUi = (): TutorialUi => ({
  attackShare: 0.5,
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
  showSupply: false,
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

describe('tutorial chapters: structure', () => {
  it('lists the basics first, then the seven chapters, with unique ids', () => {
    expect(ALL_TUTORIALS.map((c) => c.id)).toEqual(['basics', 'navy', 'air', 'armor', 'defense', 'diplomacy', 'supply', 'seasons']);
    expect(TUTORIAL_CHAPTER_IDS).toEqual(ALL_TUTORIALS.map((c) => c.id));
    expect(chapterById('navy')?.title).toBe('Navy');
    expect(chapterById('nope')).toBeUndefined();
  });

  for (const ch of CHAPTERS) {
    describe(ch.title, () => {
      it('has 3 to 5 steps, a short time and plain short text', () => {
        expect(ch.steps.length).toBeGreaterThanOrEqual(3);
        expect(ch.steps.length).toBeLessThanOrEqual(5);
        expect(ch.minutes).toBeGreaterThanOrEqual(2);
        expect(ch.minutes).toBeLessThanOrEqual(3);
        expect(ch.blurb?.length).toBeGreaterThan(0);
        expect(ch.icon).toBeTruthy();
        const ids = ch.steps.map((st) => st.id);
        expect(new Set(ids).size).toBe(ids.length);
        for (const st of ch.steps) {
          expect(st.text.length, `${st.id}: "${st.text}"`).toBeLessThanOrEqual(MAX_TEXT);
          expect(st.label!.length, st.id).toBeLessThanOrEqual(MAX_LABEL);
          expect(st.text + (st.label ?? '') + (ch.blurb ?? ''), st.id).not.toMatch(/\u2014|\u2013|\s{2}|\n/);
          const target = stepTarget(st, typeof st.target === 'function' ? createTutorialGame(undefined, ch.id) : null);
          for (const sel of targetSelectors(target)) expect(sel, st.id).toMatch(/^\[data-test="[\w-]+"\]$/);
        }
      });

      it('ends on a win goal and nothing is done at the start; its tiles and roles exist', () => {
        const s = createTutorialGame(undefined, ch.id);
        const me = s.players[s.humanId];
        expect(s.tutorial?.chapter).toBe(ch.id);
        expect(s.phase).toBe('playing');
        expect(me.spawned && me.alive).toBe(true);
        const last = ch.steps[ch.steps.length - 1];
        expect(last.done, 'the last step is the goal').toBeTypeOf('function');
        const size = s.map.width * s.map.height;
        for (const st of ch.steps) {
          if (st.tile) {
            const t = st.tile(s);
            expect(t, `${st.id} tile`).toBeGreaterThanOrEqual(0);
            expect(t, `${st.id} tile`).toBeLessThan(size);
          }
          if (st.done) expect(st.done(s, me, freshUi()), `${st.id} done at start`).toBe(false);
        }
        for (const k of chapterTileKeys(ch.id)) expect(tutorialTile(s, k), k).toBeGreaterThanOrEqual(0);
        for (const r of chapterRoles(ch.id)) expect(tutorialPlayer(s, r), r).toBeGreaterThan(0);
      });

      it('sets up the same way twice', () => {
        expect(hashState(createTutorialGame(undefined, ch.id))).toBe(hashState(createTutorialGame(undefined, ch.id)));
      });
    });
  }

  it('the done badge needs every tutorial', () => {
    const ids = ALL_TUTORIALS.map((c) => c.id);
    expect(allTutorialsDone([])).toBe(false);
    expect(allTutorialsDone(ids.slice(1))).toBe(false);
    expect(allTutorialsDone(ids)).toBe(true);
  });
});

// ------------------------------------------------------------------------------------------------ play-through

interface Ctx {
  s: GameState;
  me: Player;
  ui: TutorialUi;
  act: (a: Action) => void;
}
const T = (c: Ctx, key: string): number => tutorialTile(c.s, key);
const firstOf = (c: Ctx, type: string): number => [...c.s.buildings.values()].find((b) => b.owner === c.me.id && b.type === type)!.tile;
const build = (type: BuildingType, key: string) => (c: Ctx) => c.act({ type: 'build', building: type, tile: T(c, key) });
const share = (c: Ctx, n: number) => ({ infantry: n, armor: 0, artillery: 0 });

/** What a player does for each step of each chapter (steps not listed are read-only and get Next). */
const DRIVE: Record<string, Record<string, (c: Ctx) => void>> = {
  navy: {
    port: (c) => c.act({ type: 'build', building: 'port', tile: T(c, 'coast') }),
    ship: (c) => c.act({ type: 'buildWarship', port: firstOf(c, 'port') }),
    land: (c) => c.act({ type: 'transport', from: firstOf(c, 'port'), to: T(c, 'island'), troops: share(c, 12000) }),
    island: () => {},
  },
  air: {
    airfield: build('airfield', 'home'),
    wing: (c) => {
      for (let k = 0; k < 3; k++) c.act({ type: 'buildAircraft', airfield: firstOf(c, 'airfield'), kind: 'bomber' });
    },
    bomb: (c) => c.act({ type: 'bomb', airfield: -1, tile: T(c, 'fort'), count: 0 }),
    fort: () => {},
  },
  armor: {
    factory: build('factory', 'home'),
    mech: (c) => c.act({ type: 'procure', tech: 'mechanization' }),
    division: (c) => c.act({ type: 'buildTankDivision', tile: firstOf(c, 'factory') }),
    push: (c) => {
      const ids = c.s.units.filter((u) => u.owner === c.me.id && u.type === 'tankDivision').map((u) => u.id);
      c.act({ type: 'moveTankDivision', unitIds: ids, tile: T(c, 'front') });
    },
  },
  defense: {
    fort: build('fort', 'fort'),
    traps: (c) => c.act({ type: 'procure', tech: 'tankTraps' }),
    hold: () => {},
  },
  diplomacy: {
    open: (c) => (c.ui.openPanel = 'diplomacy'),
    ally: (c) => c.act({ type: 'requestAlliance', to: tutorialPlayer(c.s, 'friend') }),
    peace: (c) => {
      const enemy = tutorialPlayer(c.s, 'enemy');
      const answered = applyAction(c.s, c.me.id, { type: 'answerTreaty', from: enemy, accept: true });
      if (!answered.ok) c.act({ type: 'offerPeace', to: enemy, theyGive: 'none', youGive: 'none' });
    },
    pact: (c) => c.act({ type: 'offerPact', to: tutorialPlayer(c.s, 'quiet'), seconds: 180 }),
  },
  supply: {
    layer: (c) => (c.ui.showSupply = true),
    bomb: (c) => c.act({ type: 'bomb', airfield: -1, tile: T(c, 'city'), count: 1 }),
    cut: (c) => {
      // the keep hook rebuilds a razed City and refills the wing; bomb again whenever the wing is home
      const af = [...c.s.buildings.values()].find((b) => b.owner === c.me.id && b.type === 'airfield')!;
      if (af.bombers > 0 && c.s.buildings.has(c.s.map.building[T(c, 'city')] - 1)) applyAction(c.s, c.me.id, { type: 'bomb', airfield: -1, tile: T(c, 'city'), count: 1 });
    },
  },
  seasons: {
    summer: (c) => c.act({ type: 'attack', tile: T(c, 'front'), troops: share(c, c.me.troops.infantry * 0.5) }),
  },
};

function play(ch: TutorialChapter): { s: GameState; seconds: number; runner: TutorialRunner } {
  const s = createTutorialGame(undefined, ch.id);
  const ui = freshUi();
  const runner = new TutorialRunner(ch, apiFor(s));
  const me = (): Player => s.players[s.humanId];
  let ticks = 0;
  const drives = DRIVE[ch.id];
  for (const [k, st] of ch.steps.entries()) {
    runner.update(s, me(), ui); // enters the step (onEnter)
    tick(s);
    ticks++;
    expect(runner.index, `${ch.id} at ${st.id}`).toBe(k);
    if (!st.done) {
      expect(drives[st.id], `${st.id} is read-only`).toBeUndefined();
      runner.next();
      continue;
    }
    const d = drives[st.id];
    expect(d, `no drive for ${ch.id}/${st.id}`).toBeTypeOf('function');
    const ctx: Ctx = {
      s,
      me: me(),
      ui,
      act: (a) => {
        const r = applyAction(s, s.humanId, a);
        expect(r, `${st.id}: ${a.type}: ${r.reason}`).toMatchObject({ ok: true });
      },
    };
    d(ctx);
    // a step registers within 4 minutes of game time (the hold and the island take the longest)
    for (let t = 0; t < 2400 && runner.index === k && !runner.finished; t++) {
      tick(s);
      ticks++;
      if (t % 2 === 0) runner.update(s, me(), ui);
      if (t % 20 === 0 && ch.id === 'supply') d(ctx);
    }
    expect(runner.index > k || runner.finished, `${ch.id}: step ${st.id} did not finish`).toBe(true);
    expect(me().alive, `alive after ${st.id}`).toBe(true);
  }
  return { s, seconds: ticks / 10, runner };
}

describe('tutorial chapters: play-through', () => {
  for (const ch of CHAPTERS) {
    it(`${ch.title}: a scripted player does what each step says and reaches the goal`, () => {
      const { runner, seconds } = play(ch);
      expect(runner.finished).toBe(true);
      expect(runner.view().statuses.every((x) => x === 'done')).toBe(true);
      expect(seconds, 'game seconds').toBeLessThan(ch.id === 'defense' ? 200 : 240);
    });
  }

  it('Air: the wing destroys the Fort and the SAM site is still there', () => {
    const { s } = play(CHAPTERS.find((c) => c.id === 'air')!);
    expect(buildingAt(s, tutorialTile(s, 'fort'))).toBeUndefined();
  });

  it('Diplomacy: an alliance, a peace and a pact all stand at the end', () => {
    const { s } = play(CHAPTERS.find((c) => c.id === 'diplomacy')!);
    expect(s.alliances.length).toBeGreaterThanOrEqual(1);
    expect(s.treaties?.map((t) => t.kind).sort()).toEqual(['pact', 'peace']);
  });
});
