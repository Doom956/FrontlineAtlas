// In-game guide, the part without DOM: the opening sequence and the contextual tips, what shows now, and the saved
// preferences. The bar (bar.ts) draws the view; the controller (guide.ts) feeds the engine from the HUD.
// - Opening: steps in order when a game starts. A step with `done` moves on when it turns true (or after `timeout`
//   game seconds); a read-only step waits for Next (or READ_SECONDS of game time). Finished once = never again.
// - Tips: each shows once, ever. A tip joins the queue when its `when` turns true (the queue keeps the list order);
//   one tip at a time, TIP_GAP_MS apart, each on screen until the player does it (`done`), presses Next / Skip,
//   or TIP_MS of unpaused time passes.
//   A critical tip (you are attacked) goes first and may cut in on the opening or another tip; while one applies,
//   no other tip starts.
// - Prefs in localStorage (GUIDE_KEY): on/off, opening done, tips seen. Every storage access may fail (private mode,
//   blocked storage): the guide then works for this page only.
import type { GameState, Player } from '../../sim/types';
import type { TutorialUi } from '../tutorial/engine';

export const GUIDE_KEY = 'frontline.guide.v1';
/** the old first-game tutorial of the advisor line: 'done' there means the basics were seen */
export const LEGACY_TUTORIAL_KEY = 'borderfall.tutorial.v1';
/** a tip stays this long on screen (ms of unpaused time) */
export const TIP_MS = 22000;
/** pause between two tips (ms of unpaused time) */
export const TIP_GAP_MS = 8000;
/** a read-only opening step moves on by itself after this much game time (s) */
export const READ_SECONDS = 30;

/** What the steps and tips read. */
export interface GuideCtx {
  s: GameState;
  me: Player;
  ui: TutorialUi;
  /** game seconds (0 in the spawn phase) */
  sec: number;
  /** real time (ms) */
  now: number;
  /** a strike's button state ('ready', 'charging', ...), null when it has none */
  strike(id: string): string | null;
}

/** Numbers a step keeps from when it started (tiles, cities, ...). */
export type GuideMem = Record<string, number>;

export interface GuideStep {
  id: string;
  text: string | ((c: GuideCtx) => string);
  /** the UI element: a data-test value or a CSS selector, ' || ' = fallbacks (tutorial/engine.ts targetSelectors) */
  target?: string | ((c: GuideCtx) => string | undefined);
  /** the map tile the arrow shows when no target element is on screen (-1 = none) */
  tile?: (c: GuideCtx) => number;
  /** absent = read-only (Next) */
  done?: (c: GuideCtx, mem: GuideMem) => boolean;
  /** what done() compares against, taken when the step starts */
  begin?: (c: GuideCtx) => GuideMem;
  /** game seconds after which the step moves on by itself */
  timeout?: number;
  /** not needed in this game (e.g. no tribes left): passed over */
  skipIf?: (c: GuideCtx) => boolean;
  /** waits (bar hidden) until the war starts: e.g. troops are 0/0 during the spawn phase */
  playingOnly?: boolean;
}

export interface GuideTip {
  id: string;
  text: string | ((c: GuideCtx) => string);
  target?: string | ((c: GuideCtx) => string | undefined);
  tile?: (c: GuideCtx) => number;
  /** the moment it becomes useful: it joins the queue */
  when: (c: GuideCtx) => boolean;
  /** still worth showing when its turn comes (default: when) */
  still?: (c: GuideCtx) => boolean;
  /** the player did it: the tip closes */
  done?: (c: GuideCtx) => boolean;
  /** a fight-critical tip: shown first, nothing else meanwhile */
  critical?: boolean;
}

export interface GuidePrefs {
  on: boolean;
  openingDone: boolean;
  /** ids of the tips shown (ever) */
  tips: string[];
}

export interface GuideView {
  kind: 'step' | 'tip';
  id: string;
  text: string;
  /** opening: step number (0-based) and count; tips: 0 and 0 */
  index: number;
  total: number;
  target?: string;
  /** map tile for the arrow, -1 = none */
  tile: number;
  /** a step without a goal: Next moves on */
  readOnly: boolean;
}

// ------------------------------------------------------------------------------------------------ storage

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

export function loadGuidePrefs(): GuidePrefs {
  const out: GuidePrefs = { on: true, openingDone: false, tips: [] };
  try {
    const st = storage();
    const raw = st?.getItem(GUIDE_KEY);
    if (raw) {
      const v = JSON.parse(raw) as Partial<GuidePrefs>;
      out.on = v.on !== false;
      out.openingDone = v.openingDone === true;
      if (Array.isArray(v.tips)) out.tips = v.tips.filter((x): x is string => typeof x === 'string');
    } else if (st?.getItem(LEGACY_TUTORIAL_KEY) === 'done') out.openingDone = true;
  } catch {
    /* blocked or broken: defaults */
  }
  return out;
}

export function saveGuidePrefs(p: GuidePrefs): void {
  try {
    storage()?.setItem(GUIDE_KEY, JSON.stringify(p));
  } catch {
    /* storage blocked: lasts for this page only */
  }
}

// ------------------------------------------------------------------------------------------------ engine

function safe<T>(f: () => T, fallback: T, onError: (e: unknown) => void): T {
  try {
    return f();
  } catch (e) {
    onError(e);
    return fallback;
  }
}

export interface GuideOptions {
  /** start without the opening (the Basics chapter of Tutorial mode is done): tips only */
  skipOpening?: boolean;
}

export class GuideEngine {
  prefs: GuidePrefs;
  private i = 0;
  private mem: GuideMem | null = null;
  private stepAt = 0;
  private queue: string[] = [];
  private tip: { t: GuideTip; shown: number } | null = null;
  /** unpaused ms since the last tip closed */
  private sinceTip = Infinity;
  private lastNow: number | null = null;
  private warned = new Set<string>();
  private tipById: Map<string, GuideTip>;
  /** called when the shown step or tip changes */
  onChange: (v: GuideView | null) => void = () => {};
  private shownKey = '';

  constructor(
    readonly opening: readonly GuideStep[],
    readonly tips: readonly GuideTip[],
    opts: GuideOptions = {},
  ) {
    this.prefs = loadGuidePrefs();
    if (opts.skipOpening) this.prefs.openingDone = true;
    this.tipById = new Map(tips.map((t) => [t.id, t]));
  }

  get on(): boolean {
    return this.prefs.on;
  }
  /** the opening still runs in this game */
  get openingActive(): boolean {
    return this.prefs.on && !this.prefs.openingDone && this.i < this.opening.length;
  }
  get stepIndex(): number {
    return this.i;
  }
  get currentTip(): string | null {
    return this.tip?.t.id ?? null;
  }
  get queued(): readonly string[] {
    return this.queue;
  }
  seen(id: string): boolean {
    return this.prefs.tips.includes(id);
  }

  /** Checks steps and tips (~5 times a second); returns what to show, null = nothing. */
  update(c: GuideCtx): GuideView | null {
    const dt = this.lastNow === null ? 0 : Math.max(0, Math.min(1000, c.now - this.lastNow));
    this.lastNow = c.now;
    if (!this.prefs.on || !c.me.alive || c.s.phase === 'over') return this.emit(null);
    const run = c.ui.paused ? 0 : dt;
    if (this.tip) this.tip.shown += run;
    else this.sinceTip += run;
    const playing = c.s.phase === 'playing';
    if (playing) this.collect(c);
    const critical = playing ? this.pendingCritical(c) : null;
    // a fight-critical moment (a critical tip applies, shown or not): no other tip starts
    const fight = playing && this.tips.some((t) => t.critical && this.check(t.id, () => (t.still ?? t.when)(c)));
    // a tip on screen: closes when done or its time is up; a critical one pushes a normal one back into the queue
    if (this.tip) {
      const t = this.tip.t;
      if (this.check(t.id, () => !!t.done?.(c)) || this.tip.shown > TIP_MS) this.closeTip(true);
      else if (critical && !t.critical) {
        this.queue.unshift(t.id);
        this.tip = null;
      } else return this.emit(this.tipView(t, c));
    }
    if (critical) return this.emit(this.showTip(critical, c));
    if (this.openingActive) {
      const v = this.openingStep(c);
      if (v) return this.emit(v);
    }
    if (!playing || fight || this.sinceTip < TIP_GAP_MS || this.openingActive) return this.emit(null);
    // the next queued tip that still applies (the others wait)
    for (const id of this.queue) {
      const t = this.tipById.get(id);
      if (!t) continue;
      if (this.check(id, () => (t.still ?? t.when)(c))) {
        this.queue = this.queue.filter((x) => x !== id);
        return this.emit(this.showTip(t, c));
      }
    }
    return this.emit(null);
  }

  /** Next: a read-only step moves on; a step with a goal or a tip is skipped. */
  next(): void {
    this.skip();
  }

  /** Skip this step or tip. */
  skip(): void {
    if (this.tip) {
      this.closeTip(true);
      this.shownKey = '';
      return;
    }
    if (this.openingActive) this.advance();
  }

  /** Hide guide: off until switched on again (remembered). */
  hide(): void {
    this.setOn(false);
  }

  setOn(on: boolean): void {
    this.prefs.on = on;
    if (!on && this.tip) {
      // a tip cut short by hiding comes back when the guide is on again
      this.queue.unshift(this.tip.t.id);
      this.tip = null;
    }
    saveGuidePrefs(this.prefs);
    this.shownKey = '';
  }

  /** Restart guide: on, the opening from its first step, every tip again. */
  restart(): void {
    this.prefs = { on: true, openingDone: false, tips: [] };
    saveGuidePrefs(this.prefs);
    this.i = 0;
    this.mem = null;
    this.queue = [];
    this.tip = null;
    this.sinceTip = Infinity;
    this.shownKey = '';
  }

  // ---------------------------------------------------------------------------------------------- internals

  private emit(v: GuideView | null): GuideView | null {
    const key = v ? `${v.kind}:${v.id}` : '';
    if (key !== this.shownKey) {
      this.shownKey = key;
      this.onChange(v);
    }
    return v;
  }

  private check(id: string, f: () => boolean): boolean {
    return safe(f, false, (e) => this.fail(id, e));
  }
  /** logs a failing step or tip once; it then counts as not done / not relevant */
  private fail(id: string, e: unknown): void {
    if (this.warned.has(id)) return;
    this.warned.add(id);
    console.error(`Guide ${id} failed`, e);
  }

  /** Queues the tips that just became useful. The queue keeps the tips' list order (critical first, then most
   *  useful first), not the order they came in: after a long opening several wait, and e.g. the doctrine pick
   *  should not wait behind an idle-troops hint. */
  private collect(c: GuideCtx): void {
    let added = false;
    for (const t of this.tips) {
      if (this.seen(t.id) || this.queue.includes(t.id) || this.tip?.t === t) continue;
      if (this.check(t.id, () => t.when(c))) {
        this.queue.push(t.id);
        added = true;
      }
    }
    if (added) this.queue.sort((a, b) => this.rank(a) - this.rank(b));
  }

  private rank(id: string): number {
    const i = this.tips.findIndex((t) => t.id === id);
    return (this.tipById.get(id)?.critical ? 0 : this.tips.length) + (i < 0 ? this.tips.length : i);
  }

  private pendingCritical(c: GuideCtx): GuideTip | null {
    for (const id of this.queue) {
      const t = this.tipById.get(id);
      if (t?.critical && this.check(id, () => (t.still ?? t.when)(c))) {
        this.queue = this.queue.filter((x) => x !== id);
        return t;
      }
    }
    return null;
  }

  private showTip(t: GuideTip, c: GuideCtx): GuideView {
    this.tip = { t, shown: 0 };
    return this.tipView(t, c);
  }

  private closeTip(markSeen: boolean): void {
    const t = this.tip?.t;
    this.tip = null;
    this.sinceTip = 0;
    if (t && markSeen && !this.seen(t.id)) {
      this.prefs.tips.push(t.id);
      saveGuidePrefs(this.prefs);
    }
  }

  private openingStep(c: GuideCtx): GuideView | null {
    let guard = this.opening.length + 1;
    while (this.openingActive && guard-- > 0) {
      const st = this.opening[this.i];
      if (this.check(st.id, () => !!st.skipIf?.(c))) {
        this.advance();
        continue;
      }
      if (st.playingOnly && c.s.phase !== 'playing') return null;
      if (!this.mem) {
        this.mem = safe(() => st.begin?.(c) ?? {}, {}, (e) => this.fail(st.id, e));
        this.stepAt = c.sec;
      }
      const limit = st.timeout ?? (st.done ? undefined : READ_SECONDS);
      const timedOut = limit !== undefined && c.s.phase === 'playing' && c.sec - this.stepAt > limit;
      if ((st.done && this.check(st.id, () => st.done!(c, this.mem!))) || timedOut) {
        this.advance();
        continue;
      }
      return this.stepView(st, c);
    }
    return null;
  }

  private advance(): void {
    this.i++;
    this.mem = null;
    this.shownKey = '';
    if (this.i >= this.opening.length && !this.prefs.openingDone) {
      this.prefs.openingDone = true;
      saveGuidePrefs(this.prefs);
      this.sinceTip = 0;
    }
  }

  private stepView(st: GuideStep, c: GuideCtx): GuideView {
    return {
      kind: 'step',
      id: st.id,
      text: this.text(st.id, st.text, c),
      index: this.i,
      total: this.opening.length,
      target: this.target(st.id, st.target, c),
      tile: this.tile(st.id, st.tile, c),
      readOnly: !st.done,
    };
  }

  private tipView(t: GuideTip, c: GuideCtx): GuideView {
    return { kind: 'tip', id: t.id, text: this.text(t.id, t.text, c), index: 0, total: 0, target: this.target(t.id, t.target, c), tile: this.tile(t.id, t.tile, c), readOnly: true };
  }

  private text(id: string, t: GuideStep['text'], c: GuideCtx): string {
    return typeof t === 'function' ? safe(() => t(c), '', (e) => this.fail(id, e)) : t;
  }
  private target(id: string, t: GuideStep['target'], c: GuideCtx): string | undefined {
    return typeof t === 'function' ? safe(() => t(c), undefined, (e) => this.fail(id, e)) : t;
  }
  private tile(id: string, f: GuideStep['tile'], c: GuideCtx): number {
    return f ? safe(() => f(c), -1, (e) => this.fail(id, e)) : -1;
  }
}
