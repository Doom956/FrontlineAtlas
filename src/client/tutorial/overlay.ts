// Tutorial overlay: the step card (bottom left), the spotlight on the UI element a step needs (a pulsing brass ring,
// plus an arrow pointing at it from the screen's middle side) and the "Chapter done" card.
// - Step card: chapter and step count, the instruction, Show me (centres the step's tile) or Next (read-only steps),
//   a row of pips with a Steps toggle for the checklist, Skip chapter and Exit tutorial.
// - The spotlight follows its element every frame (frame()); nothing is drawn while the element is hidden.
// Pointer events pass through everything but the cards, so the game stays playable under the overlay.
import { el, setText } from '../dom';
import { iconSpan, lineIcon } from '../hud/glyph';
import { setClass, setVisible } from '../hud/dom';
import { targetSelectors, type RunnerView, type StepStatus } from './engine';
import './tutorial.css';

export interface OverlayHandlers {
  showMe: () => void;
  next: () => void;
  skipChapter: () => void;
  exit: () => void;
  nextChapter: () => void;
  chapterList: () => void;
  /** close the done card and play on in this game */
  keepPlaying: () => void;
}

/** Ring padding around the spotlit element (px). */
const PAD = 6;
/** HUD panels the arrow stays outside of. */
const PANELS = '.cmdbar, .drawer, .bm, .cluster, .lb, .ncard, .orders-bar, .bsel';
/** How far (px) the arrow may move to get outside the element's panel. */
const ARROW_MAX_SHIFT = 90;

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
  private spot = el('div', 'tut-spot');
  private arrow = el('div', 'tut-arrow');
  private done = el('div', 'tut-done');
  private doneTitle = el('h2', 'tut-done-t');
  private doneLine = el('p', 'tut-done-l');
  private doneNext: HTMLButtonElement;
  private target: string | undefined;
  private listOpen = false;
  private shownKey = '';

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
    foot.append(btn('Skip chapter', 'mini ghost', () => h.skipChapter(), 'tut-skip'), btn('Exit tutorial', 'mini ghost', () => h.exit(), 'tut-exit', 'exit'));
    this.card.append(head, this.text, acts, track, this.list, foot);

    // spotlight
    this.spot.dataset.test = 'tut-spot';
    this.arrow.innerHTML = '<svg viewBox="0 0 24 24" width="28" height="28" aria-hidden="true"><path d="M4 9h9V4l8 8-8 8v-5H4z" fill="currentColor"/></svg>';
    setVisible(this.spot, false);
    setVisible(this.arrow, false);

    // chapter done
    this.done.dataset.test = 'tut-done';
    this.done.setAttribute('role', 'dialog');
    this.done.setAttribute('aria-label', 'Chapter done');
    const dc = el('div', 'tut-done-card');
    const badge = iconSpan(lineIcon('accept', 22, 2.2), 'tut-done-ic');
    this.doneNext = btn('Next chapter', 'primary', () => h.nextChapter(), 'tut-next-chapter');
    const dActs = el('div', 'tut-done-acts');
    dActs.append(this.doneNext, btn('Chapter list', '', () => h.chapterList(), 'tut-chapters'), btn('Keep playing', 'ghost', () => h.keepPlaying(), 'tut-keep'));
    dc.append(badge, el('span', 'tut-kicker', 'Chapter done'), this.doneTitle, this.doneLine, dActs);
    this.done.append(dc);
    setVisible(this.done, false);

    this.el.append(this.spot, this.arrow, this.card, this.done);
  }

  /** Draws the runner's view. nextTitle: the next chapter's title (null = this was the last one). */
  render(v: RunnerView, opts: { showMe: boolean; nextTitle: string | null; target?: string }): void {
    const total = v.chapter.steps.length;
    setText(this.kicker, `Tutorial · ${v.chapter.title}`);
    if (v.finished) {
      setVisible(this.card, false);
      this.target = undefined;
      this.hideSpot();
      setText(this.doneTitle, v.chapter.title);
      setText(this.doneLine, opts.nextTitle ? `Next up: ${opts.nextTitle}.` : 'That was the last chapter. You know every part of the game now.');
      setVisible(this.doneNext, !!opts.nextTitle);
      const wasHidden = this.done.classList.contains('hidden');
      setVisible(this.done, true);
      if (wasHidden) (opts.nextTitle ? this.doneNext : this.done.querySelector<HTMLButtonElement>('[data-test=tut-chapters]'))?.focus({ preventScroll: true });
      return;
    }
    setVisible(this.done, false);
    setVisible(this.card, true);
    const st = v.step;
    setText(this.count, `${v.index + 1}/${total}`);
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
    const doneN = statuses.filter((s) => s === 'done' || s === 'skipped').length;
    setText(this.stepsBtn, this.listOpen ? 'Hide steps' : `Steps ${doneN}/${statuses.length}`);
    this.stepsBtn.setAttribute('aria-label', `${this.listOpen ? 'Hide' : 'Show'} the chapter's steps (${cur + 1} of ${statuses.length})`);
  }

  private toggleList(): void {
    this.listOpen = !this.listOpen;
    setVisible(this.list, this.listOpen);
    this.stepsBtn.setAttribute('aria-expanded', String(this.listOpen));
    const n = this.pips.childElementCount;
    const doneN = [...this.pips.children].filter((p) => (p as HTMLElement).dataset.s === 'done' || (p as HTMLElement).dataset.s === 'skipped').length;
    setText(this.stepsBtn, this.listOpen ? 'Hide steps' : `Steps ${doneN}/${n}`);
  }

  /** Moves the spotlight onto the step's element and keeps the card clear of open panels (every frame; cheap). */
  frame(): void {
    this.dock();
    const t = this.target ? findTarget(this.target) : null;
    if (!t) {
      this.hideSpot();
      return;
    }
    const r = t.getBoundingClientRect();
    const host = this.el.getBoundingClientRect();
    const x = r.left - host.left - PAD;
    const y = r.top - host.top - PAD;
    const w = r.width + PAD * 2;
    const hgt = r.height + PAD * 2;
    const s = this.spot.style;
    s.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
    s.width = `${w.toFixed(1)}px`;
    s.height = `${hgt.toFixed(1)}px`;
    setVisible(this.spot, true);
    // the arrow sits on the side facing the screen's middle and points at the element
    const vw = host.width || window.innerWidth;
    const vh = host.height || window.innerHeight;
    const cx = x + w / 2;
    const cy = y + hgt / 2;
    const dx = (cx - vw / 2) / vw;
    const dy = (cy - vh / 2) / vh;
    const far = Math.abs(dx) > 0.22 || Math.abs(dy) > 0.22;
    setVisible(this.arrow, far);
    if (!far) return;
    let dir: 'left' | 'right' | 'up' | 'down';
    if (Math.abs(dx) >= Math.abs(dy)) dir = dx > 0 ? 'right' : 'left';
    else dir = dy > 0 ? 'down' : 'up';
    // a wide element at the top or bottom edge reads better with a vertical arrow
    if (w > vw * 0.4) dir = dy > 0 ? 'down' : 'up';
    const A = 28;
    const gap = 8;
    let ax = cx - A / 2;
    let ay = cy - A / 2;
    if (dir === 'right') ax = x - A - gap;
    else if (dir === 'left') ax = x + w + gap;
    else if (dir === 'down') ay = y - A - gap;
    else ay = y + hgt + gap;
    // outside the panel that holds the element (the command bar, a drawer, the build menu), so it hides nothing there
    // (only when that stays close: in a big drawer the arrow would end up far from the element, pointing at another one)
    const panel = t.closest<HTMLElement>(PANELS);
    if (panel && panel !== t) {
      const pr = panel.getBoundingClientRect();
      const bx = ax;
      const by = ay;
      if (dir === 'right') ax = Math.min(ax, pr.left - host.left - A - gap);
      else if (dir === 'left') ax = Math.max(ax, pr.right - host.left + gap);
      else if (dir === 'down') ay = Math.min(ay, pr.top - host.top - A - gap);
      else ay = Math.max(ay, pr.bottom - host.top + gap);
      if (Math.abs(ax - bx) + Math.abs(ay - by) > ARROW_MAX_SHIFT) {
        ax = bx;
        ay = by;
      }
    }
    ax = Math.max(4, Math.min(vw - A - 4, ax));
    ay = Math.max(4, Math.min(vh - A - 4, ay));
    this.arrow.style.transform = `translate(${ax.toFixed(1)}px, ${ay.toFixed(1)}px)`;
    if (this.arrow.dataset.dir !== dir) this.arrow.dataset.dir = dir;
  }

  /**
   * The card sits bottom left; when a panel (build menu, Research drawer, a long nation card) covers that corner, it moves to the free
   * strip at the top between the standings and the cluster as one compact line.
   */
  private dock(): void {
    if (this.card.classList.contains('hidden')) return;
    const host = this.el.getBoundingClientRect();
    const zone = { l: host.left, r: host.left + 360, t: host.bottom - 340, b: host.bottom - 70 };
    let covered = false;
    for (const p of document.querySelectorAll<HTMLElement>('.bm, .drawer, .ncard')) {
      if (p.classList.contains('hidden')) continue;
      const r = p.getBoundingClientRect();
      if (r.width > 0 && r.left < zone.r && r.right > zone.l && r.top < zone.b && r.bottom > zone.t) {
        covered = true;
        break;
      }
    }
    setClass(this.card, 'top', covered);
    if (!covered) {
      if (this.card.style.left) this.card.style.left = this.card.style.width = '';
      return;
    }
    const lb = document.querySelector<HTMLElement>('.hud .lb')?.getBoundingClientRect();
    const cl = document.querySelector<HTMLElement>('.hud .cluster')?.getBoundingClientRect();
    const left = (lb && lb.width ? lb.right : host.left) + 12 - host.left;
    const right = (cl && cl.width ? cl.left : host.right) - 12 - host.left;
    const w = Math.max(280, Math.min(640, right - left));
    this.card.style.left = `${Math.round(left + Math.max(0, (right - left - w) / 2))}px`;
    this.card.style.width = `${Math.round(w)}px`;
  }

  private hideSpot(): void {
    setVisible(this.spot, false);
    setVisible(this.arrow, false);
  }

  /** The card yields while a modal (help page, game over) is up. */
  setCovered(on: boolean): void {
    setClass(this.el, 'covered', on);
  }

  destroy(): void {
    this.el.remove();
  }
}
