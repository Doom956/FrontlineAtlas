// Tutorial mode, the part without DOM: chapter and step types, the step runner and the saved progress.
// - A chapter is a short practice game (src/sim/tutorialScenario.ts sets it up); its steps run one at a time.
// - A step is done when its `done` predicate turns true (checked ~5 times a second); a step without one waits for Next.
// - Progress (chapters done, the one-time "try the tutorial" hint) is kept in localStorage under PROGRESS_KEY.
// The overlay (overlay.ts) draws the runner's view; the controller (controller.ts) ties both to the HUD.
import type { TutorialChapterId, TutorialGrant } from '../../sim/tutorialScenario';
import type { GameState, Player } from '../../sim/types';

export type { TutorialChapterId };

/** Panels a step can open or check. 'arsenal' is the Research drawer on its Arsenal tab, 'build' the build menu. */
export type TutorialPanel = 'build' | 'research' | 'arsenal' | 'forces' | 'doctrine' | 'diplomacy' | 'army' | 'events' | 'legend' | 'building' | 'settings';

/** Read-only UI facts a step's `done` can check. */
export interface TutorialUi {
  /** share of the army each attack click sends (0.01..1) */
  attackShare: number;
  /** the open panel: a drawer id, 'arsenal' for the Research drawer on its Arsenal tab, 'build' for the build menu */
  openPanel: TutorialPanel | null;
  /** the Research drawer's tab (also while the drawer is closed: the tab it opens on) */
  researchTab: 'research' | 'arsenal';
  /** selected own warships and tank divisions */
  selectedUnits: number;
  /** the building being placed (build mode), else null */
  buildMode: string | null;
  /** the click mode: 'none', 'build', 'barrage', 'bomb', 'missile', 'paradrop', 'pillarPick', 'spawnWarship', ... */
  mode: string;
  /** the strike being aimed ('barrage', 'bomb', 'paradrop', 'rocket', 'atomBomb'), else null */
  aiming: string | null;
  /** own buildings picked with Shift+drag */
  selectedBuildings: number;
  /** the selected map tile (building drawer), -1 = none */
  selectedTile: number;
  /** the nation card open on the left (player id), 0 = none */
  nationCard: number;
  /** levels per build click (1, 3 or 5) */
  buildCount: number;
  paused: boolean;
  speed: number;
}

/** What a step's onEnter (and the controller) can do. */
export interface TutorialApi {
  state(): GameState;
  me(): Player;
  /** adds resources, troops and techs (with their prerequisites) to the player */
  grant(g: TutorialGrant): void;
  /** lets frozen AIs act ('all' = every one); hostile: they may attack the player too (who still can't fall) */
  wake(ids: number[] | 'all', opts?: { hostile?: boolean }): void;
  /** freezes AIs again */
  freeze(ids: number[]): void;
  /** a named tile of this chapter (tutorialScenario.ts TUTORIAL_TILE_KEYS), -1 if none */
  tile(key: string): number;
  /** player id of a chapter role ('rival', 'tribe', ... tutorialScenario.ts TUTORIAL_ROLES), 0 if none */
  player(role: string): number;
  /** makes an AI attack the player now (a "defend" step); false if it can't */
  enemyAttack(aiId: number): boolean;
  /** finishes the player's constructions, upgrades, research and queued units now */
  finish(): void;
  /** Basics: ends the spawn phase once the player has placed the start */
  startNow(): boolean;
  openPanel(name: 'build' | 'research' | 'arsenal' | 'forces' | 'doctrine' | 'diplomacy'): void;
  /** brings a tile into view (zooms in a little when far out) */
  centre(tile: number): void;
}

export interface TutorialStep {
  id: string;
  /** one short instruction */
  text: string;
  /** checklist label (2-4 words); default: the text */
  label?: string;
  /**
   * The UI element to spotlight: a data-test value ('attack-share') or a CSS selector ('[data-test=orders-ships]
   * [data-v=bombard]'). Fallbacks are separated by ' || ': the first one that is on screen gets the spotlight.
   * A function picks it from the game (e.g. one nation's row in the standings).
   */
  target?: string | ((s: GameState) => string);
  /** the tile "Show me" centres (-1 = no button) */
  tile?: (s: GameState) => number;
  /** absent = a read-only step with a Next button */
  done?: (s: GameState, me: Player, ui: TutorialUi) => boolean;
  onEnter?: (api: TutorialApi) => void;
}

export interface TutorialChapter {
  id: TutorialChapterId;
  title: string;
  /** one line for the chapter list */
  blurb: string;
  /** about how long it takes */
  minutes: number;
  steps: TutorialStep[];
}

// ------------------------------------------------------------------------------------------------ progress

export const PROGRESS_KEY = 'frontline.tutorial.v2';

export interface TutorialProgress {
  /** chapters finished at least once */
  done: TutorialChapterId[];
  /** the "New here? Try the tutorial" hint was shown (it shows once) */
  suggested: boolean;
}

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

export function loadProgress(): TutorialProgress {
  const out: TutorialProgress = { done: [], suggested: false };
  try {
    const raw = storage()?.getItem(PROGRESS_KEY);
    if (!raw) return out;
    const v = JSON.parse(raw) as Partial<TutorialProgress>;
    if (Array.isArray(v.done)) out.done = v.done.filter((x): x is TutorialChapterId => typeof x === 'string');
    out.suggested = v.suggested === true;
  } catch {
    /* blocked or broken: start fresh */
  }
  return out;
}

function saveProgress(p: TutorialProgress): void {
  try {
    storage()?.setItem(PROGRESS_KEY, JSON.stringify(p));
  } catch {
    /* storage blocked: progress lasts for this page only */
  }
}

export function markChapterDone(id: TutorialChapterId): void {
  const p = loadProgress();
  if (!p.done.includes(id)) p.done.push(id);
  saveProgress(p);
}

export function isChapterDone(id: TutorialChapterId): boolean {
  return loadProgress().done.includes(id);
}

/** True while the one-time "try the tutorial" hint is still due: nothing done yet and never shown. */
export function suggestionDue(): boolean {
  const p = loadProgress();
  return !p.suggested && p.done.length === 0;
}

export function markSuggested(): void {
  const p = loadProgress();
  if (p.suggested) return;
  p.suggested = true;
  saveProgress(p);
}

/** The chapter after `id` in `list`, or null at the end. */
export function nextChapter(list: readonly TutorialChapter[], id: TutorialChapterId): TutorialChapter | null {
  const i = list.findIndex((c) => c.id === id);
  return i >= 0 && i + 1 < list.length ? list[i + 1] : null;
}

/** The first chapter not done yet (the list's "Continue"), else the first. */
export function firstOpenChapter(list: readonly TutorialChapter[], done: readonly TutorialChapterId[]): TutorialChapter | null {
  return list.find((c) => !done.includes(c.id)) ?? list[0] ?? null;
}

// ------------------------------------------------------------------------------------------------ runner

export type StepStatus = 'done' | 'current' | 'todo' | 'skipped';

/** What the overlay shows. */
export interface RunnerView {
  chapter: TutorialChapter;
  index: number;
  step: TutorialStep | null;
  statuses: StepStatus[];
  finished: boolean;
}

/**
 * Runs a chapter's steps: enters each (onEnter), checks its `done` on every update and moves on when it is true, or
 * on next() for a read-only step. A step that throws counts as not done (logged once). finished = all steps passed.
 */
export class TutorialRunner {
  private i = 0;
  private statuses: StepStatus[];
  private entered = -1;
  private warned = new Set<string>();
  finished = false;
  /** called whenever the step or the finished flag changes */
  onChange: () => void = () => {};

  constructor(
    readonly chapter: TutorialChapter,
    private api: TutorialApi,
  ) {
    this.statuses = chapter.steps.map((_, k) => (k === 0 ? 'current' : 'todo'));
    if (!chapter.steps.length) this.finished = true;
  }

  get index(): number {
    return this.i;
  }
  get step(): TutorialStep | null {
    return this.finished ? null : this.chapter.steps[this.i] ?? null;
  }
  view(): RunnerView {
    return { chapter: this.chapter, index: this.i, step: this.step, statuses: [...this.statuses], finished: this.finished };
  }

  /** Checks the current step; moves on (possibly several steps) while steps are done. Call ~5 times a second. */
  update(s: GameState, me: Player, ui: TutorialUi): void {
    let guard = this.chapter.steps.length + 1;
    while (!this.finished && guard-- > 0) {
      this.enter();
      const st = this.chapter.steps[this.i];
      if (!st.done || !this.check(st, s, me, ui)) return;
      this.advance('done');
    }
  }

  /** Next on a read-only step (on a step with a goal it skips that step). */
  next(): void {
    if (this.finished) return;
    this.enter();
    const st = this.chapter.steps[this.i];
    this.advance(st.done ? 'skipped' : 'done');
  }

  /** Ends the chapter at once, the steps left count as skipped. */
  skipAll(): void {
    if (this.finished) return;
    for (let k = this.i; k < this.statuses.length; k++) this.statuses[k] = 'skipped';
    this.finished = true;
    this.onChange();
  }

  private enter(): void {
    if (this.entered === this.i || this.finished) return;
    this.entered = this.i;
    const st = this.chapter.steps[this.i];
    try {
      st.onEnter?.(this.api);
    } catch (err) {
      console.error(`Tutorial step ${st.id}: onEnter failed`, err);
    }
    this.onChange();
  }

  private check(st: TutorialStep, s: GameState, me: Player, ui: TutorialUi): boolean {
    try {
      return !!st.done?.(s, me, ui);
    } catch (err) {
      if (!this.warned.has(st.id)) {
        this.warned.add(st.id);
        console.error(`Tutorial step ${st.id}: done() failed`, err);
      }
      return false;
    }
  }

  private advance(how: StepStatus): void {
    this.statuses[this.i] = how;
    this.i++;
    if (this.i >= this.chapter.steps.length) {
      this.i = this.chapter.steps.length - 1;
      this.finished = true;
    } else this.statuses[this.i] = 'current';
    this.onChange();
  }
}

// ------------------------------------------------------------------------------------------------ targets

/** A step's target as a string (a function target is read from the game; a crash means no spotlight). */
export function stepTarget(st: TutorialStep | null | undefined, s: GameState | null): string | undefined {
  const t = st?.target;
  if (typeof t !== 'function') return t;
  if (!s) return undefined;
  try {
    return t(s);
  } catch {
    return undefined;
  }
}

/** The selectors of a step's target, in priority order (a bare word is a data-test value). */
export function targetSelectors(target: string | undefined): string[] {
  if (!target) return [];
  return target
    .split(' || ')
    .map((t) => t.trim())
    .filter(Boolean)
    .map((t) => (/^[\w-]+$/.test(t) ? `[data-test="${t}"]` : t));
}
