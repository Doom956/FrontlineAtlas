// Tutorial content (src/client/tutorial/chapters.ts): every chapter is well formed (ids, text lengths, a goal or Next
// on every step, targets that parse, tiles that exist), no step is done at the start of its practice game, and a
// scripted player who does what each step says gets through the whole chapter with the real step runner.
import { describe, expect, it } from 'vitest';
import { applyAction } from '../src/sim/actions';
import { borders } from '../src/sim/combat';
import { tick } from '../src/sim/sim';
import {
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
} from '../src/sim/tutorialScenario';
import type { Action, BuildingType, GameState, Player, TechId } from '../src/sim/types';
import { CHAPTERS } from '../src/client/tutorial/chapters';
import { stepTarget, targetSelectors, TutorialRunner, type TutorialApi, type TutorialChapterId, type TutorialUi } from '../src/client/tutorial/engine';

const MAX_TEXT = 90;
const MAX_LABEL = 24;

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

function apiFor(s: GameState, ch: TutorialChapterId): TutorialApi {
  return {
    state: () => s,
    me: () => s.players[s.humanId],
    grant: (g) => tutorialGrant(s, s.humanId, g),
    wake: (ids, opts) => tutorialWake(s, ids, opts),
    freeze: (ids) => tutorialFreeze(s, ids),
    tile: (key) => tutorialTile(s, ch, key),
    player: (r) => tutorialPlayer(s, ch, r),
    enemyAttack: (id) => tutorialEnemyAttack(s, id),
    finish: () => tutorialFinish(s, s.humanId),
    startNow: () => tutorialStart(s),
    openPanel: () => {},
    centre: () => {},
  };
}

describe('tutorial chapters: structure', () => {
  it('has one chapter per scenario, in order', () => {
    expect(CHAPTERS.map((c) => c.id)).toEqual([...TUTORIAL_CHAPTER_IDS]);
  });

  it.each(CHAPTERS.map((c) => [c.id, c] as const))('%s is well formed', (_id, ch) => {
    expect(ch.title.length).toBeGreaterThan(0);
    expect(ch.blurb.length).toBeLessThanOrEqual(MAX_TEXT);
    expect(ch.minutes).toBeGreaterThanOrEqual(2);
    expect(ch.minutes).toBeLessThanOrEqual(5);
    expect(ch.steps.length).toBeGreaterThanOrEqual(5);
    expect(ch.steps.length).toBeLessThanOrEqual(9);
    const ids = ch.steps.map((st) => st.id);
    expect(new Set(ids).size, 'step ids unique').toBe(ids.length);
    for (const st of ch.steps) {
      expect(st.text.length, st.id).toBeGreaterThan(0);
      expect(st.text.length, `${st.id}: "${st.text}"`).toBeLessThanOrEqual(MAX_TEXT);
      expect(st.text, st.id).not.toMatch(/\s{2}|\n/);
      expect(st.label, st.id).toBeTruthy();
      expect(st.label!.length, st.id).toBeLessThanOrEqual(MAX_LABEL);
      // a goal (done) or a read-only step with Next: done is either a function or absent
      expect(st.done === undefined || typeof st.done === 'function', st.id).toBe(true);
      const target = stepTarget(st, typeof st.target === 'function' ? createTutorialGame(ch.id) : null);
      if (typeof st.target === 'function') expect(target, st.id).toBeTruthy();
      for (const sel of targetSelectors(target)) expect(sel, st.id).toMatch(/^\[data-test="[\w-]+"\]$|^\[|^\./);
    }
    // mostly hands-on: at most a third of the steps are read-only
    expect(ch.steps.filter((st) => !st.done).length).toBeLessThanOrEqual(Math.ceil(ch.steps.length / 3));
    // the first step asks for something
    expect(ch.steps[0].done).toBeTypeOf('function');
  });

  it.each(CHAPTERS.map((c) => [c.id, c] as const))('%s: tiles exist and nothing is done at the start', (id, ch) => {
    const s = createTutorialGame(id);
    const me = s.players[s.humanId];
    const ui = freshUi();
    const size = s.map.width * s.map.height;
    for (const st of ch.steps) {
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
  T: (key: string) => number;
  role: (r: string) => number;
  act: (a: Action) => void;
}
type Drive = Record<string, (c: Ctx) => void>;

const build = (building: BuildingType, key: string) => (c: Ctx) => c.act({ type: 'build', building, tile: c.T(key) });
const research = (tech: TechId) => (c: Ctx) => c.act({ type: 'research', tech });
const troops = (c: Ctx, share: number) => ({ infantry: Math.floor(c.me.troops.infantry * share), armor: 0, artillery: 0 });
const attack = (key: string, share = 0.3) => (c: Ctx) => c.act({ type: 'attack', tile: c.T(key), troops: troops(c, share) });
const ownTile = (c: Ctx, type: BuildingType): number => [...c.s.buildings.values()].find((b) => b.owner === c.me.id && b.type === type)!.tile;
const ownUnits = (c: Ctx, type: string): number[] => c.s.units.filter((u) => u.owner === c.me.id && u.type === type).map((u) => u.id);
/** A tile of `owner` next to own land (where a click on its border lands). */
function enemyEdge(c: Ctx, owner: number): number {
  const { map } = c.s;
  const w = map.width;
  for (let i = 0; i < map.owner.length; i++) {
    if (map.owner[i] !== owner) continue;
    const x = i % w;
    const n = [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, i - w, i + w];
    if (n.some((j) => j >= 0 && j < map.owner.length && map.owner[j] === c.me.id)) return i;
  }
  return -1;
}
const runFor = (s: GameState, seconds: number): void => {
  for (let k = 0; k < seconds * 10; k++) tick(s);
};

/** What a player does for each step (steps not listed are read-only and get Next). */
const DRIVES: Record<TutorialChapterId, Drive> = {
  basics: {
    spawn: (c) => c.act({ type: 'spawn', tile: c.T('spawn') }),
    start: () => {},
    share: (c) => (c.ui.attackShare = 0.5),
    expand: attack('wild', 0.5),
    tribe: (c) => {
      // keep expanding until the border touches the tribe (a click on land you don't touch sends a boat)
      for (let k = 0; k < 20 && !borders(c.s, c.me.id, c.role('tribe')); k++) {
        if (!c.s.attacks.some((a) => a.attacker === c.me.id)) attack('wild', 0.5)(c);
        runFor(c.s, 3);
      }
      attack('tribe', 0.5)(c);
    },
    city: build('city', 'citySite'),
  },
  war: {
    tribe: attack('tribe', 0.3),
    fort: build('fort', 'fortSite'),
    defend: (c) => c.act({ type: 'attack', tile: enemyEdge(c, c.role('rival')), troops: troops(c, 0.5) }),
    barrage: (c) => c.act({ type: 'barrage', tile: c.T('fort') }),
    attack: (c) => {
      c.ui.attackShare = 0.4;
      c.act({ type: 'attack', tile: enemyEdge(c, c.role('rival')), troops: troops(c, 0.4) });
    },
  },
  economy: {
    mine: build('mine', 'mineSite'),
    well: build('oilWell', 'wellSite'),
    farm: build('farm', 'farmSite'),
    market: build('market', 'marketSite'),
    x3: (c) => (c.ui.buildCount = 3),
    city3: (c) => c.act({ type: 'buildMany', building: 'city', tile: c.T('citySite'), count: 3 }),
    research: (c) => (c.ui.openPanel = 'research'),
    tech: research('agriculture'),
    doctrine: (c) => c.act({ type: 'chooseDoctrine', doctrine: 'merchant' }),
  },
  navy: {
    port: build('port', 'portSite'),
    warship: (c) => c.act({ type: 'buildWarship', port: ownTile(c, 'port'), tile: c.T('sea') }),
    invade: (c) => c.act({ type: 'attack', tile: c.T('enemyCoast'), troops: troops(c, 0.4) }),
    select: (c) => (c.ui.selectedUnits = ownUnits(c, 'warship').length),
    bombard: (c) => c.act({ type: 'setUnitStance', unitIds: ownUnits(c, 'warship'), stance: 'bombard' }),
    blockade: (c) => c.act({ type: 'setUnitStance', unitIds: ownUnits(c, 'warship'), stance: 'blockade' }),
  },
  armor: {
    factory: build('factory', 'factorySite'),
    division: (c) => c.act({ type: 'buildTankDivision', tile: ownTile(c, 'factory') }),
    select: (c) => (c.ui.selectedUnits = ownUnits(c, 'tankDivision').length),
    move: (c) => c.act({ type: 'moveTankDivision', unitIds: ownUnits(c, 'tankDivision'), tile: c.T('rally') }),
    spearhead: (c) => c.act({ type: 'moveTankDivision', unitIds: ownUnits(c, 'tankDivision'), tile: c.T('front') }),
    support: (c) => c.act({ type: 'setDivisionMode', unitIds: ownUnits(c, 'tankDivision'), mode: 'support', front: c.T('front') }),
  },
  air: {
    airfield: build('airfield', 'airfieldSite'),
    bomber: (c) => c.act({ type: 'buildAircraft', airfield: ownTile(c, 'airfield'), kind: 'bomber' }),
    bomb: (c) => c.act({ type: 'bomb', airfield: ownTile(c, 'airfield'), tile: c.T('enemyCity') }),
    mission: (c) => c.act({ type: 'setAirMission', airfield: ownTile(c, 'airfield'), mission: 'strategic', target: c.T('enemy') }),
    sam: build('sam', 'samSite'),
    paradrop: (c) => c.act({ type: 'paradrop', airfield: ownTile(c, 'airfield'), tile: c.T('dropZone'), troops: 2000 }),
  },
  arsenal: {
    open: (c) => {
      c.ui.openPanel = 'arsenal';
      c.ui.researchTab = 'arsenal';
    },
    path: research('lightTanks'),
    next: research('deepRaids'),
    mastery: research('armorMastery'),
    special: research('dropTanks'),
    select: (c) => (c.ui.selectedBuildings = [...c.s.buildings.values()].filter((b) => b.owner === c.me.id).length),
    upgrade: (c) =>
      c.act({ type: 'upgradeBuildings', tiles: [...c.s.buildings.values()].filter((b) => b.owner === c.me.id).map((b) => b.tile), levels: 3 }),
  },
  diplomacy: {
    card: (c) => (c.ui.nationCard = c.role('friendA')),
    ally: (c) => c.act({ type: 'requestAlliance', to: c.role('friendA') }),
    ask: (c) => c.act({ type: 'requestAllyAttack', ally: c.role('friendA'), target: c.role('leader') }),
    rocket: (c) => c.act({ type: 'launchMissile', silo: ownTile(c, 'silo'), kind: 'rocket', tile: c.T('leaderMainland') }),
    atom: (c) => {
      runFor(c.s, 25); // the silo reloads
      c.act({ type: 'launchMissile', silo: ownTile(c, 'silo'), kind: 'atomBomb', tile: c.T('leader') });
    },
  },
};

describe('tutorial chapters: play-through', () => {
  it.each(CHAPTERS.map((c) => [c.id, c] as const))('%s can be finished by doing what each step says', (id, ch) => {
    const s = createTutorialGame(id);
    const ui = freshUi();
    const runner = new TutorialRunner(ch, apiFor(s, id));
    const me = (): Player => s.players[s.humanId];
    const drive = DRIVES[id];
    for (const [k, st] of ch.steps.entries()) {
      runner.update(s, me(), ui); // enters the step (onEnter)
      tick(s); // a moment passes before the player acts (finished orders appear)
      expect(runner.index, `at ${st.id}`).toBe(k);
      if (!st.done) {
        expect(drive[st.id], `${st.id} is read-only`).toBeUndefined();
        runner.next();
        continue;
      }
      const d = drive[st.id];
      expect(d, `no drive for ${st.id}`).toBeTypeOf('function');
      const c: Ctx = {
        s,
        me: me(),
        ui,
        T: (key) => tutorialTile(s, id, key),
        role: (r) => tutorialPlayer(s, id, r),
        act: (a) => {
          const r = applyAction(s, s.humanId, a);
          expect(r, `${st.id}: ${a.type}: ${r.reason}`).toMatchObject({ ok: true });
        },
      };
      d(c);
      if (id === 'basics' && st.id === 'start') tutorialStart(s);
      // up to 3 minutes of game time for the step to register (fights take a while)
      for (let t = 0; t < 1800 && runner.index === k && !runner.finished; t++) {
        tick(s);
        if (t % 2 === 0) runner.update(s, me(), ui);
      }
      expect(runner.index > k || runner.finished, `step ${st.id} did not finish`).toBe(true);
    }
    expect(runner.finished).toBe(true);
    expect(runner.view().statuses.every((x) => x === 'done')).toBe(true);
  });
});
