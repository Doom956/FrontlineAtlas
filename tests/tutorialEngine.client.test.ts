// Tutorial engine (src/client/tutorial/engine.ts): the step runner, saved progress and target selectors. No DOM.
// The tutorial's own content is checked in tutorialSteps.test.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  isChapterDone,
  loadProgress,
  markChapterDone,
  markSuggested,
  PROGRESS_KEY,
  suggestionDue,
  targetSelectors,
  TutorialRunner,
  type TutorialApi,
  type TutorialChapter,
  type TutorialUi,
} from '../src/client/tutorial/engine';
import type { GameState, Player } from '../src/sim/types';

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

function fakeApi(): TutorialApi & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    state: () => ({}) as GameState,
    me: () => ({}) as Player,
    grant: (g) => calls.push(`grant:${JSON.stringify(g)}`),
    wake: (ids) => calls.push(`wake:${String(ids)}`),
    freeze: (ids) => calls.push(`freeze:${String(ids)}`),
    tile: () => -1,
    player: () => 0,
    weaken: (id, n) => calls.push(`weaken:${id}:${n}`),
    enemyAttack: () => false,
    finish: () => calls.push('finish'),
    startNow: () => false,
    openPanel: (n) => calls.push(`open:${n}`),
    centre: (t) => calls.push(`centre:${t}`),
  };
}

const S = {} as GameState;
const ME = {} as Player;

function chapter(): TutorialChapter {
  return {
    id: 'basics',
    title: 'Tutorial',
    minutes: 3,
    steps: [
      { id: 'read', text: 'Read this.' },
      { id: 'share', text: 'Set the attack to 50%.', done: (_s, _m, ui) => ui.attackShare >= 0.5, onEnter: (api) => api.openPanel('research') },
      { id: 'panel', text: 'Open Forces.', done: (_s, _m, ui) => ui.openPanel === 'forces' },
    ],
  };
}

describe('tutorial runner', () => {
  it('waits for Next on a read-only step, then for each goal; onEnter runs once per step', () => {
    const api = fakeApi();
    const r = new TutorialRunner(chapter(), api);
    let changes = 0;
    r.onChange = () => changes++;
    r.update(S, ME, UI);
    r.update(S, ME, UI);
    expect(r.index).toBe(0);
    expect(r.step?.id).toBe('read');
    r.next();
    expect(r.index).toBe(1);
    r.update(S, ME, UI);
    r.update(S, ME, UI);
    expect(api.calls.filter((c) => c === 'open:research')).toHaveLength(1);
    expect(r.index).toBe(1);
    r.update(S, ME, { ...UI, attackShare: 0.6 });
    expect(r.index).toBe(2);
    expect(r.finished).toBe(false);
    r.update(S, ME, { ...UI, openPanel: 'forces' });
    expect(r.finished).toBe(true);
    expect(r.step).toBeNull();
    expect(r.view().statuses).toEqual(['done', 'done', 'done']);
    expect(changes).toBeGreaterThanOrEqual(4);
  });

  it('runs through several steps in one update when they are already done', () => {
    const r = new TutorialRunner(chapter(), fakeApi());
    r.next();
    r.update(S, ME, { ...UI, attackShare: 1, openPanel: 'forces' });
    expect(r.finished).toBe(true);
  });

  it('Next on a step with a goal skips it; skipAll ends the chapter', () => {
    const r = new TutorialRunner(chapter(), fakeApi());
    r.next();
    r.next();
    expect(r.view().statuses).toEqual(['done', 'skipped', 'current']);
    r.skipAll();
    expect(r.finished).toBe(true);
    expect(r.view().statuses).toEqual(['done', 'skipped', 'skipped']);
  });

  it('a step whose check throws stays open (logged once)', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const ch = chapter();
    ch.steps[0] = {
      id: 'boom',
      text: 'x',
      done: () => {
        throw new Error('boom');
      },
    };
    const r = new TutorialRunner(ch, fakeApi());
    r.update(S, ME, UI);
    r.update(S, ME, UI);
    expect(r.index).toBe(0);
    expect(err).toHaveBeenCalledTimes(1);
    err.mockRestore();
  });
});

describe('tutorial progress', () => {
  let mem: MemStorage;
  beforeEach(() => {
    mem = new MemStorage();
    vi.stubGlobal('localStorage', mem);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('remembers a finished tutorial under its own key (old chapter ids stay readable)', () => {
    expect(loadProgress()).toEqual({ done: [], suggested: false });
    markChapterDone('basics');
    markChapterDone('basics');
    markChapterDone('war');
    expect(isChapterDone('basics')).toBe(true);
    expect(isChapterDone('navy')).toBe(false);
    expect(JSON.parse(mem.getItem(PROGRESS_KEY)!).done).toEqual(['basics', 'war']);
    expect(PROGRESS_KEY).toBe('frontline.tutorial.v2');
  });

  it('suggests the tutorial once, and never after it was finished', () => {
    expect(suggestionDue()).toBe(true);
    markSuggested();
    expect(suggestionDue()).toBe(false);
    mem.data.clear();
    markChapterDone('basics');
    expect(suggestionDue()).toBe(false);
  });

  it('survives broken or blocked storage', () => {
    mem.setItem(PROGRESS_KEY, '{nope');
    expect(loadProgress()).toEqual({ done: [], suggested: false });
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    });
    expect(() => markChapterDone('basics')).not.toThrow();
    expect(loadProgress().done).toEqual([]);
  });
});

describe('tutorial targets', () => {
  it('turns a bare word into a data-test selector and keeps fallbacks in order', () => {
    expect(targetSelectors(undefined)).toEqual([]);
    expect(targetSelectors('attack-share')).toEqual(['[data-test="attack-share"]']);
    expect(targetSelectors('[data-test=orders-ships] [data-v=bombard] || open-forces')).toEqual(['[data-test=orders-ships] [data-v=bombard]', '[data-test="open-forces"]']);
  });
});
