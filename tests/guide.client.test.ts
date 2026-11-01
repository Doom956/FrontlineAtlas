// In-game guide (src/client/guide/engine.ts, steps.ts): the opening runs in order and moves on by itself, tips show
// once each (ever) and one at a time, a fight-critical tip cuts in, Skip / Hide / Restart are remembered, and a
// broken or blocked localStorage never breaks the game. No DOM.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GUIDE_KEY, GuideEngine, LEGACY_TUTORIAL_KEY, loadGuidePrefs, TIP_GAP_MS, TIP_MS, type GuideCtx, type GuideStep, type GuideTip } from '../src/client/guide/engine';
import { guideTips, openingSteps } from '../src/client/guide/steps';
import type { TutorialUi } from '../src/client/tutorial/engine';
import type { GameState, Player } from '../src/sim/types';
import { applyAction } from '../src/sim/actions';
import { claimRect, makeFlatGame, makeTestGame } from './helpers';

class MemStorage {
  data = new Map<string, string>();
  getItem(k: string): string | null {
    return this.data.get(k) ?? null;
  }
  setItem(k: string, v: string): void {
    this.data.set(k, String(v));
  }
  removeItem(k: string): void {
    this.data.delete(k);
  }
}

const UI: TutorialUi = {
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
};

/** A tiny fake world: the steps and tips below only read `flags`. */
interface World {
  flags: Record<string, boolean>;
  phase: 'spawn' | 'playing' | 'over';
  sec: number;
  now: number;
  paused: boolean;
}
function ctxOf(w: World): GuideCtx {
  const s = { phase: w.phase } as unknown as GameState;
  const me = { alive: true } as unknown as Player;
  return { s, me, ui: { ...UI, paused: w.paused }, sec: w.sec, now: w.now, strike: () => null };
}
const flag = (k: string) => (c: GuideCtx & { w?: World }) => !!world.flags[k];
let world: World;

const STEPS: GuideStep[] = [
  { id: 'a', text: 'do a', done: flag('a') },
  { id: 'read', text: 'read me' },
  { id: 'b', text: 'do b', done: flag('b'), timeout: 30 },
  { id: 'gone', text: 'never needed', skipIf: () => true, done: () => false },
];
const TIPS: GuideTip[] = [
  { id: 'fight', text: 'you are attacked', critical: true, when: flag('fight') },
  { id: 't1', text: 'tip one', when: flag('t1'), done: flag('t1done') },
  { id: 't2', text: 'tip two', when: flag('t2') },
];

let store: MemStorage;
beforeEach(() => {
  store = new MemStorage();
  vi.stubGlobal('localStorage', store);
  world = { flags: {}, phase: 'playing', sec: 10, now: 1000, paused: false };
});
afterEach(() => vi.unstubAllGlobals());

/** Advances real and game time and updates the engine. */
function run(g: GuideEngine, ms = 200): ReturnType<GuideEngine['update']> {
  world.now += ms;
  world.sec += ms / 1000;
  return g.update(ctxOf(world));
}
/** Runs until the view changes or `ms` pass. */
function runFor(g: GuideEngine, ms: number): ReturnType<GuideEngine['update']> {
  let v = run(g, 0);
  for (let t = 0; t < ms; t += 200) v = run(g);
  return v;
}

describe('guide: opening', () => {
  it('runs its steps in order; goals move on by themselves, read-only steps on Next', () => {
    const g = new GuideEngine(STEPS, TIPS);
    expect(run(g)?.id).toBe('a');
    expect(run(g)?.index).toBe(0);
    world.flags.a = true;
    const v = run(g);
    expect(v?.id).toBe('read');
    expect(v?.readOnly).toBe(true);
    expect(run(g)?.id).toBe('read'); // waits for Next
    g.next();
    expect(run(g)?.id).toBe('b');
    expect(run(g)?.readOnly).toBe(false);
  });

  it('a step with a timeout moves on by itself; skipIf steps are passed over; the end is remembered', () => {
    const g = new GuideEngine(STEPS, TIPS);
    world.flags.a = true;
    run(g);
    g.next();
    expect(run(g)?.id).toBe('b');
    world.sec += 31;
    expect(run(g)).toBeNull(); // 'gone' skipped, opening over
    expect(g.openingActive).toBe(false);
    expect(JSON.parse(store.getItem(GUIDE_KEY)!).openingDone).toBe(true);
    // a new game: no opening again
    expect(run(new GuideEngine(STEPS, TIPS))).toBeNull();
  });

  it('Skip skips just the current step', () => {
    const g = new GuideEngine(STEPS, TIPS);
    expect(run(g)?.id).toBe('a');
    g.skip();
    expect(run(g)?.id).toBe('read');
  });

  it('in the spawn phase timeouts do not run and no tips start', () => {
    const g = new GuideEngine([{ id: 'x', text: 'x', done: () => false, timeout: 1 }], TIPS);
    world.phase = 'spawn';
    world.flags.t1 = true;
    world.flags.fight = true;
    for (let k = 0; k < 50; k++) expect(run(g)?.id).toBe('x');
  });
});

describe('guide: tips', () => {
  const done = (): GuideEngine => {
    store.setItem(GUIDE_KEY, JSON.stringify({ on: true, openingDone: true, tips: [] }));
    return new GuideEngine(STEPS, TIPS);
  };

  it('shows each tip once, one at a time, with a gap between them', () => {
    const g = done();
    world.flags.t1 = true;
    world.flags.t2 = true;
    expect(run(g)?.id).toBe('t1');
    expect(g.queued).toEqual(['t2']);
    g.next();
    expect(run(g)).toBeNull(); // the gap
    expect(runFor(g, TIP_GAP_MS - 1000)).toBeNull();
    expect(runFor(g, 1400)?.id).toBe('t2');
    g.next();
    runFor(g, TIP_GAP_MS * 3);
    expect(run(g)).toBeNull();
    expect(JSON.parse(store.getItem(GUIDE_KEY)!).tips).toEqual(['t1', 't2']);
    // never again, also not in a new game
    const g2 = new GuideEngine(STEPS, TIPS);
    expect(runFor(g2, TIP_GAP_MS * 2)).toBeNull();
  });

  it('a tip closes when the player does it or after TIP_MS of unpaused time', () => {
    const g = done();
    world.flags.t1 = true;
    expect(run(g)?.id).toBe('t1');
    world.paused = true;
    expect(runFor(g, TIP_MS + 2000)?.id).toBe('t1'); // paused: stays
    world.paused = false;
    expect(runFor(g, TIP_MS + 400)).toBeNull();
    expect(g.seen('t1')).toBe(true);
    const g2 = new GuideEngine(STEPS, [TIPS[2], { ...TIPS[1], id: 't3' }]);
    world.flags.t2 = false;
    expect(run(g2)?.id).toBe('t3');
    world.flags.t1done = true;
    expect(run(g2)).toBeNull();
  });

  it('a critical tip cuts in on the opening and a normal tip; nothing else starts during the fight', () => {
    store.setItem(GUIDE_KEY, JSON.stringify({ on: true, openingDone: false, tips: [] }));
    const g = new GuideEngine(STEPS, TIPS);
    expect(run(g)?.id).toBe('a');
    world.flags.fight = true;
    expect(run(g)?.id).toBe('fight');
    g.next();
    expect(run(g)?.id).toBe('a'); // the opening resumes
    world.flags.a = true;
    expect(run(g)?.id).toBe('read');
    g.next(); // past 'read'
    g.skip(); // past 'b'
    world.flags.t1 = true;
    // the fight is still on: no tip starts
    expect(runFor(g, TIP_GAP_MS * 2)).toBeNull();
    world.flags.fight = false;
    expect(runFor(g, 400)?.id).toBe('t1');
    expect(g.seen('fight')).toBe(true);
  });

  it('a critical tip pushes a normal one back into the queue (not marked seen)', () => {
    const g = done();
    world.flags.t1 = true;
    expect(run(g)?.id).toBe('t1');
    world.flags.fight = true;
    expect(run(g)?.id).toBe('fight');
    expect(g.seen('t1')).toBe(false);
    expect(g.queued[0]).toBe('t1');
  });

  it('a tip that throws counts as not relevant', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    store.setItem(GUIDE_KEY, JSON.stringify({ on: true, openingDone: true, tips: [] }));
    const g = new GuideEngine([], [{ id: 'bad', text: 'x', when: () => { throw new Error('boom'); } }, TIPS[2]]);
    world.flags.t2 = true;
    expect(run(g)?.id).toBe('t2');
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe('guide: Hide, on/off and Restart', () => {
  it('Hide turns it off and is remembered; on again brings it back where it was', () => {
    const g = new GuideEngine(STEPS, TIPS);
    expect(run(g)?.id).toBe('a');
    g.hide();
    expect(run(g)).toBeNull();
    expect(loadGuidePrefs().on).toBe(false);
    const g2 = new GuideEngine(STEPS, TIPS);
    expect(run(g2)).toBeNull();
    g2.setOn(true);
    expect(run(g2)?.id).toBe('a');
  });

  it('Restart: the opening from its first step and every tip again', () => {
    store.setItem(GUIDE_KEY, JSON.stringify({ on: false, openingDone: true, tips: ['t1'] }));
    const g = new GuideEngine(STEPS, TIPS);
    expect(run(g)).toBeNull();
    g.restart();
    expect(run(g)?.id).toBe('a');
    expect(loadGuidePrefs()).toEqual({ on: true, openingDone: false, tips: [] });
  });

  it('the old first-game tutorial finished counts as the opening done; skipOpening gives tips only', () => {
    store.setItem(LEGACY_TUTORIAL_KEY, 'done');
    expect(loadGuidePrefs().openingDone).toBe(true);
    store.data.clear();
    const g = new GuideEngine(STEPS, TIPS, { skipOpening: true });
    world.flags.t2 = true;
    expect(run(g)?.id).toBe('t2');
  });
});

describe('guide: storage failures', () => {
  it('works with localStorage throwing on every call', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    });
    const g = new GuideEngine(STEPS, TIPS);
    expect(run(g)?.id).toBe('a');
    g.skip();
    g.hide();
    expect(run(g)).toBeNull();
    g.restart();
    expect(run(g)?.id).toBe('a');
  });

  it('works with the localStorage getter itself throwing, and with broken JSON', () => {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() {
        throw new Error('SecurityError');
      },
    });
    expect(loadGuidePrefs()).toEqual({ on: true, openingDone: false, tips: [] });
    expect(run(new GuideEngine(STEPS, TIPS))?.id).toBe('a');
    vi.stubGlobal('localStorage', store);
    store.setItem(GUIDE_KEY, '{not json');
    expect(loadGuidePrefs()).toEqual({ on: true, openingDone: false, tips: [] });
  });
});

describe('guide: real content', () => {
  it('the opening covers start, troops, gold, expand, attack size, City, tribe and standings in that order', () => {
    expect(openingSteps({ centreTile: () => 0 }).map((s) => s.id)).toEqual(['spawn', 'start', 'troops', 'gold', 'expand', 'share', 'city', 'tribe', 'standings']);
    const ids = guideTips().map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const want of ['attacked', 'research', 'doctrine', 'idle', 'strike', 'navy', 'armor', 'air', 'alliance', 'coalition', 'arsenal', 'upgrade']) expect(ids).toContain(want);
    expect(guideTips().filter((t) => t.critical).map((t) => t.id)).toEqual(['attacked']);
  });

  it('in a real game: short texts, targets and tiles that work, and the opening ends once played', () => {
    const s = makeTestGame({ tribeCount: 2 });
    const me = s.players[s.humanId];
    const centre = me.capital;
    const steps = openingSteps({ centreTile: () => centre });
    const g = new GuideEngine(steps, guideTips());
    const c = (): GuideCtx => ({ s, me, ui: UI, sec: 1, now: (world.now += 200), strike: () => null });
    const seen: string[] = [];
    for (let k = 0; k < 40 && g.openingActive; k++) {
      const v = g.update(c());
      if (!v) break;
      if (seen[seen.length - 1] !== v.id) seen.push(v.id);
      expect(v.text.length).toBeGreaterThan(10);
      expect(v.text.length).toBeLessThanOrEqual(120);
      if (['expand', 'tribe'].includes(v.id)) expect(v.tile, v.id).toBeGreaterThanOrEqual(0);
      if (['troops', 'gold', 'share', 'standings'].includes(v.id)) expect(v.target).toBeTruthy();
      g.next();
    }
    // spawn and start are done in a playing game: the opening starts at troops
    expect(seen[0]).toBe('troops');
    expect(seen).toEqual(['troops', 'gold', 'expand', 'share', 'city', 'tribe', 'standings']);
    expect(g.openingActive).toBe(false);
  });

  it('the tips fire once each in a real game (research after 40 s, doctrine at 5:00)', () => {
    store.setItem(GUIDE_KEY, JSON.stringify({ on: true, openingDone: true, tips: [] }));
    const s = makeTestGame();
    const me = s.players[s.humanId];
    me.gold = 100000;
    const g = new GuideEngine([], guideTips());
    let sec = 0;
    const shown: string[] = [];
    for (let k = 0; k < 600; k++) {
      sec += 1;
      s.tick = s.playStartTick + sec * 10;
      const v = g.update({ s, me, ui: UI, sec, now: (world.now += 1000), strike: () => null });
      if (v && shown[shown.length - 1] !== v.id) {
        shown.push(v.id);
        g.next();
      }
    }
    expect(shown).toContain('research');
    expect(shown).toContain('doctrine');
    expect(shown.indexOf('research')).toBeLessThan(shown.indexOf('doctrine'));
    expect(new Set(shown).size).toBe(shown.length);
  });

  it('a neighbour attacking the player brings the critical tip at once, pointing at the attacked tile', () => {
    store.setItem(GUIDE_KEY, JSON.stringify({ on: true, openingDone: true, tips: [] }));
    const s = makeFlatGame(40, 20, 2, { human: true });
    claimRect(s, 1, 0, 0, 19, 19);
    claimRect(s, 2, 20, 0, 39, 19);
    const me = s.players[1];
    const g = new GuideEngine([], guideTips());
    const at = (): GuideCtx => ({ s, me, ui: UI, sec: 30, now: (world.now += 200), strike: () => null });
    expect(g.update(at())).toBeNull();
    const target = 10 * 40 + 19;
    const r = applyAction(s, 2, { type: 'attack', tile: target, troops: { infantry: 1000, armor: 0, artillery: 0 } });
    expect(r.ok).toBe(true);
    const v = g.update(at());
    expect(v?.id).toBe('attacked');
    expect(v?.text).toContain(s.players[2].name);
    expect(v?.tile).toBe(target);
    // the attack is over before the player has read it: the tip still names the attacker and points there
    s.attacks.length = 0;
    const after = g.update(at());
    expect(after?.id).toBe('attacked');
    expect(after?.text).toContain(`${s.players[2].name} attacked you`);
    expect(after?.tile).toBe(target);
  });

  it('a skipped first step: the start step does not say "Good spot" before a start is placed', () => {
    const s = makeTestGame();
    const me = s.players[s.humanId];
    const start = openingSteps({ centreTile: () => me.capital })[1];
    const wasSpawned = me.spawned;
    me.spawned = false;
    const c: GuideCtx = { s, me, ui: UI, sec: 0, now: 0, strike: () => null };
    const text = typeof start.text === 'function' ? start.text(c) : start.text;
    expect(text).not.toMatch(/Good spot/);
    expect(typeof start.target === 'function' ? start.target(c) : start.target).toBeUndefined();
    me.spawned = wasSpawned;
  });

  it('the City step is done by a City built before it showed', () => {
    const s = makeTestGame();
    const me = s.players[s.humanId];
    const city = openingSteps({ centreTile: () => me.capital }).find((st) => st.id === 'city')!;
    const c: GuideCtx = { s, me, ui: UI, sec: 30, now: 0, strike: () => null };
    expect(city.done!(c, {})).toBe(false);
    me.gold = 100000;
    let placed = false;
    for (let t = 0; t < s.map.owner.length && !placed; t++) if (s.map.owner[t] === me.id) placed = applyAction(s, me.id, { type: 'build', building: 'city', tile: t }).ok;
    expect(placed).toBe(true);
    expect(city.done!(c, {})).toBe(true);
  });

  it('a step marked playingOnly waits for the war to start (Skip in the spawn phase does not show 0/0 troops)', () => {
    const g = new GuideEngine([{ id: 'first', text: 'pick a start', done: flag('x') }, { id: 'later', text: 'troops', playingOnly: true }], []);
    world.phase = 'spawn';
    expect(run(g)?.id).toBe('first');
    g.skip();
    expect(run(g)).toBeNull();
    world.phase = 'playing';
    expect(run(g)?.id).toBe('later');
  });

  it('waiting tips come in the list order, not the order they became useful', () => {
    store.setItem(GUIDE_KEY, JSON.stringify({ on: true, openingDone: true, tips: [] }));
    const g = new GuideEngine([], TIPS);
    world.flags.t2 = true;
    expect(run(g)?.id).toBe('t2');
    world.flags.t1 = true;
    run(g);
    world.flags.t2 = false;
    expect(g.queued).toEqual(['t1']);
    // a third tip that came in before t1 is useful waits behind it
    const g2 = new GuideEngine([], [...TIPS, { id: 't0', text: 'late in the list', when: flag('t0') }]);
    world.flags = { t0: true };
    world.now += TIP_GAP_MS;
    store.setItem(GUIDE_KEY, JSON.stringify({ on: true, openingDone: true, tips: [] }));
    expect(run(g2)?.id).toBe('t0');
    world.flags.t2 = true;
    world.flags.t1 = true;
    run(g2);
    expect(g2.queued).toEqual(['t1', 't2']);
  });
});
