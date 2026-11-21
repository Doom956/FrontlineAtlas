// Tutorial overlay: the step card (bottom left), the spotlight on the UI element a step needs (a pulsing brass ring,
// plus an arrow pointing at it from the screen's middle side) and the closing card.
// - Step card: step count, the instruction, Show me (centres the step's tile) or Next (read-only steps), a row of
//   pips with a toggle for the list of steps, and Exit tutorial.
// - Closing card: Play a game (a normal Easy game) or More tutorials (back to the list).
// - The spotlight follows its element every frame (frame()); nothing is drawn while the element is hidden.
// Pointer events pass through everything but the cards, so the game stays playable under the overlay.
import { el, setText } from '../dom';
import { iconSpan, lineIcon } from '../hud/glyph';
import { setClass, setVisible } from '../hud/dom';
import { targetSelectors, type RunnerView, type StepStatus } from './engine';
import { Spotlight } from './spotlight';
import './tutorial.css';

/** How long a map point stays ringed (ms). */
const RING_MS = 6000;
/** Up to this width (px) the screen is narrow: the card sits at the top, under the top bar. */
const NARROW = 720;
/** Widest the docked bar gets (px). */
const DOCK_MAX = 760;

export interface OverlayHandlers {
  showMe: () => void;
  next: () => void;
  /** to the title screen */
  exit: () => void;
  /** a normal Easy game */
  playNow: () => void;
  /** to the Tutorials list */
  more: () => void;
}

function btn(label: string, cls: string, onClick: () => void, test: string, icon?: string): HTMLButtonElement {
  const b = el('button', `wr-btn ${cls}`);
  b.type = 'button';
  if (icon) b.append(iconSpan(lineIcon(icon, 14, 2)));
  b.append(el('span', 'wr-btn-l', label));
  b.dataset.test = test;
  b.addEventListener('click', onClick);
  return b;
}

/** The first element of a step's target that is on screen. */
export function findTarget(target: string | undefined, doc: Document = document): HTMLElement | null {
  for (const sel of targetSelectors(target)) {
    let list: NodeListOf<HTMLElement>;
    try {
      list = doc.querySelectorAll<HTMLElement>(sel);
    } catch {
      continue; // a bad selector: try the next one
    }
    for (const e of list) {
      const r = e.getBoundingClientRect();
      if (r.width > 0 && r.height > 0 && e.getClientRects().length > 0 && !e.closest('.hidden')) return e;
    }
  }
  return null;
}

export class TutorialOverlay {
  readonly el: HTMLElement;
  private card = el('section', 'tut-card');
  private kicker = el('span', 'tut-kicker');
  private count = el('span', 'tut-count');
  private text = el('p', 'tut-text');
  private showBtn: HTMLButtonElement;
  private nextBtn: HTMLButtonElement;
  private pips = el('div', 'tut-pips');
  private stepsBtn: HTMLButtonElement;
  private list = el('ol', 'tut-list');
  private light = new Spotlight();
  private done = el('div', 'tut-done');
  private donePlay: HTMLButtonElement;
  private doneKicker = el('span', 'tut-kicker', 'Tutorial done');
  private doneTitle = el('h2', 'tut-done-t', "That's the basics.");
  private doneLine = el('p', 'tut-done-l');
  private target: string | undefined;
  private listOpen = false;
  private shownKey = '';
  /** the map point ringed after Show me (or when a step that points at the map starts), until ringUntil */
  private ringAt: (() => { x: number; y: number; zoom: number } | null) | null = null;
  private ringUntil = 0;

  constructor(private h: OverlayHandlers) {
    this.el = el('div', 'tut');
    this.el.dataset.test = 'tutorial';

    // step card
    this.card.dataset.test = 'tut-card';
    this.card.setAttribute('aria-label', 'Tutorial');
    const head = el('div', 'tut-head');
    head.append(this.kicker, this.count);
    this.text.setAttribute('aria-live', 'polite');
    this.text.dataset.test = 'tut-text';
    this.showBtn = btn('Show me', 'mini', () => h.showMe(), 'tut-show', 'target');
    this.nextBtn = btn('Next', 'mini primary', () => h.next(), 'tut-next');
    const acts = el('div', 'tut-acts');
    acts.append(this.showBtn, this.nextBtn);
    this.stepsBtn = el('button', 'tut-steps');
    this.stepsBtn.type = 'button';
    this.stepsBtn.dataset.test = 'tut-steps';
    this.stepsBtn.setAttribute('aria-expanded', 'false');
    this.stepsBtn.addEventListener('click', () => this.toggleList());
    const track = el('div', 'tut-track');
    track.append(this.pips, this.stepsBtn);
    this.list.dataset.test = 'tut-list';
    setVisible(this.list, false);
    const foot = el('div', 'tut-foot');
    foot.append(btn('Exit tutorial', 'mini ghost', () => h.exit(), 'tut-exit', 'exit'));
    this.card.append(head, this.text, acts, track, this.list, foot);

    // closing card
    this.done.dataset.test = 'tut-done';
    this.done.setAttribute('role', 'dialog');
    this.done.setAttribute('aria-label', 'Tutorial done');
    const dc = el('div', 'tut-done-card');
    const badge = iconSpan(lineIcon('accept', 22, 2.2), 'tut-done-ic');
    this.donePlay = btn('Play a game', 'primary', () => h.playNow(), 'tut-play', 'play');
    this.donePlay.title = 'A normal game against Easy AI nations';
    const dActs = el('div', 'tut-done-acts');
    const more = btn('More tutorials', '', () => h.more(), 'tut-more', 'chevronRight');
    more.title = 'Back to the list of tutorials';
    dActs.append(this.donePlay, more);
    dc.append(badge, this.doneKicker, this.doneTitle, this.doneLine, dActs);
    this.done.append(dc);
    setVisible(this.done, false);

    this.el.append(this.light.spot, this.light.arrow, this.card, this.done);
  }

  /** Draws the runner's view. */
  render(v: RunnerView, opts: { showMe: boolean; target?: string }): void {
    const total = v.chapter.steps.length;
    setText(this.kicker, v.chapter.title);
    if (v.finished) {
      setVisible(this.card, false);
      this.target = undefined;
      this.hideSpot();
      setText(this.doneKicker, `${v.chapter.title} done`);
      setText(this.doneTitle, v.chapter.endTitle ?? "That's the basics.");
      setText(this.doneLine, v.chapter.endText ?? 'Play a game now, or learn more in Tutorials.');
      const wasHidden = this.done.classList.contains('hidden');
      setVisible(this.done, true);
      if (wasHidden) this.donePlay.focus({ preventScroll: true });
      return;
    }
    setVisible(this.done, false);
    setVisible(this.card, true);
    const st = v.step;
    setText(this.count, `Step ${v.index + 1} of ${total}`);
    setText(this.text, st?.text ?? '');
    setVisible(this.showBtn, opts.showMe);
    setVisible(this.nextBtn, !!st && !st.done);
    this.target = opts.target;
    const key = `${v.chapter.id}:${v.index}`;
    if (key !== this.shownKey) {
      this.shownKey = key;
      // a new step: the card nods once so the change is noticed
      this.card.classList.remove('nod');
      void this.card.offsetWidth;
      this.card.classList.add('nod');
    }
    this.renderTrack(v.statuses, v.chapter.steps.map((s) => s.label ?? s.text), v.index);
  }

  private renderTrack(statuses: StepStatus[], labels: string[], cur: number): void {
    if (this.pips.childElementCount !== statuses.length) {
      this.pips.replaceChildren(...statuses.map(() => el('i')));
      this.list.replaceChildren(
        ...labels.map((l) => {
          const li = el('li');
          li.append(iconSpan(lineIcon('accept', 12, 2.4), 'tut-tick'), el('span', 'tut-li-t', l));
          return li;
        }),
      );
    }
    statuses.forEach((s, k) => {
      const pip = this.pips.children[k] as HTMLElement;
      const li = this.list.children[k] as HTMLElement;
      if (pip.dataset.s !== s) pip.dataset.s = s;
      if (li.dataset.s !== s) li.dataset.s = s;
      const t = li.querySelector('.tut-li-t') as HTMLElement;
      setText(t, labels[k]);
    });
    setText(this.stepsBtn, this.listOpen ? 'Hide steps' : 'All steps');
    this.stepsBtn.setAttribute('aria-label', `${this.listOpen ? 'Hide' : 'Show'} the tutorial's steps (${cur + 1} of ${statuses.length})`);
  }

  private toggleList(): void {
    this.listOpen = !this.listOpen;
    setVisible(this.list, this.listOpen);
    this.stepsBtn.setAttribute('aria-expanded', String(this.listOpen));
    setText(this.stepsBtn, this.listOpen ? 'Hide steps' : 'All steps');
  }

  /** Rings a map point for a few seconds (Show me, or a step that points at the map). */
  ringTile(at: () => { x: number; y: number; zoom: number } | null, ms = RING_MS): void {
    this.ringAt = at;
    this.ringUntil = performance.now() + ms;
  }

  /** Moves the spotlight onto the step's element (or the ringed map point) and keeps the card clear of open panels (every frame; cheap). */
  frame(): void {
    this.dock();
    const host = this.el.getBoundingClientRect();
    const t = this.target ? findTarget(this.target) : null;
    if (t || !this.ringAt || performance.now() > this.ringUntil || this.card.classList.contains('hidden')) {
      if (!t && this.ringAt && performance.now() > this.ringUntil) this.ringAt = null;
      this.light.onElement(t, host);
      return;
    }
    const p = this.ringAt();
    if (!p) {
      this.light.hide();
      return;
    }
    // the ring and arrow stay off the bottom bar and the card
    const bar = document.querySelector<HTMLElement>('.hud .cmdbar')?.getBoundingClientRect();
    const bottom = bar && bar.height ? Math.max(0, host.bottom - bar.top) : 0;
    const top = this.card.classList.contains('top') || host.width <= NARROW ? Math.max(0, this.card.getBoundingClientRect().bottom - host.top) : 0;
    this.light.onPoint(p.x, p.y, Math.max(16, Math.min(40, p.zoom * 3)), host, { top, bottom });
  }

  /**
   * The card sits bottom left (at the top on narrow screens). While a panel (build menu, a drawer, a nation card) is
   * open over that corner (on narrow screens: any panel), it becomes one compact bar right under the top bar, as wide
   * as the free room beside the standings and a nation card allow (up to DOCK_MAX px), and the open panels move down
   * below it (the HUD's --tut-room), so it covers neither the top bar's buttons nor the panel.
   */
  private dock(): void {
    const hud = this.el.parentElement;
    if (this.card.classList.contains('hidden')) {
      this.undock(hud);
      return;
    }
    const host = this.el.getBoundingClientRect();
    const narrow = host.width <= NARROW;
    const zone = { l: host.left, r: host.left + 360, t: host.bottom - 340, b: host.bottom - 70 };
    let covered = false;
    let ncard: DOMRect | null = null;
    for (const p of document.querySelectorAll<HTMLElement>('.bm, .drawer, .ncard')) {
      if (p.classList.contains('hidden')) continue;
      const r = p.getBoundingClientRect();
      if (!(r.width > 0 && r.height > 0)) continue;
      if (p.classList.contains('ncard')) ncard = r;
      if (narrow || (r.left < zone.r && r.right > zone.l && r.top < zone.b && r.bottom > zone.t)) covered = true;
    }
    setClass(this.card, 'top', covered);
    if (!covered) {
      this.undock(hud);
      return;
    }
    // right under the top bar (its buttons stay clear)
    const cl = document.querySelector<HTMLElement>('.hud .cluster')?.getBoundingClientRect();
    const top = Math.round((cl && cl.height ? cl.bottom : host.top + 58) - host.top + 6);
    const gap = narrow ? 8 : 12;
    let left = gap;
    // beside the standings when they reach down past the bar's top, and beside an open nation card
    const lb = document.querySelector<HTMLElement>('.hud .lb')?.getBoundingClientRect();
    if (!narrow && lb && lb.width && lb.bottom - host.top > top) left = Math.max(left, lb.right - host.left + gap);
    if (!narrow && ncard && ncard.top - host.top < top + 120) left = Math.max(left, ncard.right - host.left + gap);
    const room = host.width - gap - left;
    const w = Math.round(Math.max(Math.min(room, 300), Math.min(DOCK_MAX, room)));
    this.card.style.left = `${Math.round(left)}px`;
    this.card.style.top = `${top}px`;
    this.card.style.width = `${w}px`;
    const h = this.card.offsetHeight;
    if (hud) {
      // the open panels start below the bar
      hud.classList.add('tut-docked');
      const room = Math.round(top + h + 8);
      const v = `${room}px`;
      if (hud.style.getPropertyValue('--tut-room') !== v) hud.style.setProperty('--tut-room', v);
      // the build menu grows up from the bottom bar: it ends below the bar
      const bm = hud.querySelector<HTMLElement>('.bm');
      const base = bm?.parentElement;
      if (bm && base && !bm.classList.contains('hidden')) {
        const r = base.getBoundingClientRect();
        const k = base.offsetHeight > 0 && r.height > 0 ? r.height / base.offsetHeight : 1;
        const fit = `min(calc(100vh - 150px), var(--bm-room, 100vh), ${Math.max(160, Math.round((r.top - host.top - room) / k - 8))}px)`;
        if (bm.style.maxHeight !== fit) bm.style.maxHeight = fit;
      }
    }
  }

  private undock(hud: HTMLElement | null): void {
    if (this.card.style.left) this.card.style.left = this.card.style.width = this.card.style.top = '';
    if (hud?.classList.contains('tut-docked')) {
      hud.classList.remove('tut-docked');
      hud.style.removeProperty('--tut-room');
      const bm = hud.querySelector<HTMLElement>('.bm');
      if (bm) bm.style.maxHeight = '';
    }
  }

  private hideSpot(): void {
    this.light.hide();
  }

  /** The card yields while a modal (help page, game over) is up. */
  setCovered(on: boolean): void {
    setClass(this.el, 'covered', on);
  }

  destroy(): void {
    this.undock(this.el.parentElement);
    this.el.remove();
  }
}
