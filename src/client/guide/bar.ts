// The guide's small bar and its spotlight: one line of text with a step counter, Show me (map steps), Next or Skip,
// and Hide guide. The bar sits just above the HUD's bottom stack (command bar, orders bar), so it never covers them;
// when it would cover what it points at or an open panel (build menu, drawer, nation card), it moves to the free
// strip at the top between the standings and the cluster. The spotlight (tutorial/spotlight.ts) rings the element
// or the map tile and points an arrow at it.
import { el, setText } from '../dom';
import { iconSpan, lineIcon } from '../hud/glyph';
import { setClass, setVisible } from '../hud/dom';
import { findTarget } from '../tutorial/overlay';
import { Spotlight } from '../tutorial/spotlight';
import type { GuideView } from './engine';
import './guide.css';

export interface GuideBarHandlers {
  next: () => void;
  skip: () => void;
  hide: () => void;
  showMe: () => void;
}

/** Where a map tile is on screen (host px) and its ring radius; null = no map view. */
export type TilePoint = (tile: number) => { x: number; y: number; r: number } | null;

/** Panels the bar must not cover (it moves to the top instead). */
const PANELS = '.bm, .drawer, .ncard, .bsel';
/** Gap (px) between the bar and the HUD's bottom stack; more when an arrow points into the stack. */
const GAP = 8;
const ARROW_ROOM = 44;

function btn(label: string, cls: string, onClick: () => void, test: string, icon?: string): HTMLButtonElement {
  const b = el('button', `wr-btn mini ${cls}`);
  b.type = 'button';
  if (icon) b.append(iconSpan(lineIcon(icon, 13, 2)));
  b.append(el('span', 'wr-btn-l', label));
  b.dataset.test = test;
  b.addEventListener('click', onClick);
  return b;
}

const overlaps = (a: DOMRect | { left: number; right: number; top: number; bottom: number }, b: { left: number; right: number; top: number; bottom: number }): boolean =>
  a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;

export class GuideBar {
  readonly el: HTMLElement;
  readonly bar = el('section', 'guide-bar');
  private tag = el('span', 'guide-tag');
  private count = el('span', 'guide-count');
  private text = el('p', 'guide-text');
  private showBtn: HTMLButtonElement;
  private nextBtn: HTMLButtonElement;
  private skipBtn: HTMLButtonElement;
  private light = new Spotlight('guide-spot');
  private view: GuideView | null = null;
  private covered = false;

  constructor(
    h: GuideBarHandlers,
    private tilePoint: TilePoint,
  ) {
    this.el = el('div', 'guide');
    this.el.dataset.test = 'guide';
    this.bar.dataset.test = 'guide-bar';
    this.bar.setAttribute('aria-label', 'Guide');
    this.tag.append(iconSpan(lineIcon('info', 13, 2)), el('span', '', 'Guide'));
    this.count.dataset.test = 'guide-count';
    this.text.dataset.test = 'guide-text';
    this.text.setAttribute('aria-live', 'polite');
    this.showBtn = btn('Show me', 'ghost', () => h.showMe(), 'guide-show', 'target');
    this.nextBtn = btn('Next', 'primary', () => h.next(), 'guide-next');
    this.skipBtn = btn('Skip', '', () => h.skip(), 'guide-skip');
    const hide = btn('Hide guide', 'ghost guide-hide', () => h.hide(), 'guide-hide');
    hide.dataset.tip = 'Turn the guide off (Menu: Guide on brings it back)';
    const head = el('div', 'guide-head');
    head.append(this.tag, this.count);
    const acts = el('div', 'guide-acts');
    acts.append(this.showBtn, this.skipBtn, this.nextBtn, hide);
    this.bar.append(head, this.text, acts);
    this.el.append(this.light.spot, this.light.arrow, this.bar);
    setVisible(this.el, false);
  }

  /** Draws a step or tip (null hides the guide). */
  render(v: GuideView | null): void {
    const was = this.view;
    this.view = v;
    if (!v) {
      setVisible(this.el, false);
      this.light.hide();
      return;
    }
    setVisible(this.el, true);
    setClass(this.bar, 'is-tip', v.kind === 'tip');
    this.bar.dataset.step = v.id;
    this.bar.dataset.kind = v.kind;
    setText(this.count, v.kind === 'step' ? `${v.index + 1}/${v.total}` : 'Tip');
    this.count.setAttribute('aria-label', v.kind === 'step' ? `Step ${v.index + 1} of ${v.total}` : 'Tip');
    setText(this.text, v.text);
    setVisible(this.showBtn, v.tile >= 0);
    // read-only steps and tips: Next; a step with a goal: Skip
    setVisible(this.nextBtn, v.readOnly);
    setVisible(this.skipBtn, !v.readOnly);
    if (!was || was.kind !== v.kind || was.id !== v.id) {
      // a new step: the bar nods once so the change is noticed
      this.bar.classList.remove('nod');
      void this.bar.offsetWidth;
      this.bar.classList.add('nod');
    }
  }

  /** The bar yields while a modal (help page, game over) is up. */
  setCovered(on: boolean): void {
    this.covered = on;
    setClass(this.el, 'covered', on);
  }

  /** Places the bar and the spotlight (every frame; cheap). */
  frame(): void {
    const v = this.view;
    if (!v || this.covered) return;
    const host = this.el.getBoundingClientRect();
    const vw = host.width || window.innerWidth;
    const vh = host.height || window.innerHeight;
    const target = v.target ? findTarget(v.target) : null;
    const pt = !target && v.tile >= 0 ? this.tilePoint(v.tile) : null;

    // bottom: just above the HUD's bottom stack (its visible parts)
    let stackTop = vh;
    for (const e of document.querySelectorAll<HTMLElement>('.hud-bottom > *')) {
      if (e.classList.contains('hidden')) continue;
      const r = e.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) stackTop = Math.min(stackTop, r.top - host.top);
    }
    if (stackTop >= vh) stackTop = vh - 12;
    const br = this.bar.getBoundingClientRect();
    const bw = br.width;
    const bh = br.height;
    // a target in the bottom stack gets its arrow above that stack: the bar leaves room for it
    const gap = target?.closest('.hud-bottom') ? ARROW_ROOM : GAP;
    const bottomBox = { left: (vw - bw) / 2, right: (vw + bw) / 2, top: stackTop - gap - bh, bottom: stackTop - gap };
    // what the bar must leave free: the target, the tile ring, open panels
    const keep: { left: number; right: number; top: number; bottom: number }[] = [];
    if (target) {
      const r = target.getBoundingClientRect();
      keep.push({ left: r.left - host.left - 8, right: r.right - host.left + 8, top: r.top - host.top - 8, bottom: r.bottom - host.top + 8 });
    }
    if (pt) keep.push({ left: pt.x - pt.r - 40, right: pt.x + pt.r + 40, top: pt.y - pt.r - 44, bottom: pt.y + pt.r + 8 });
    for (const p of document.querySelectorAll<HTMLElement>(PANELS)) {
      if (p.classList.contains('hidden')) continue;
      const r = p.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) keep.push({ left: r.left - host.left, right: r.right - host.left, top: r.top - host.top, bottom: r.bottom - host.top });
    }
    const narrow = vw <= 640;
    const top = !narrow && keep.some((k) => overlaps(bottomBox, k));
    setClass(this.bar, 'top', top);
    if (top) {
      // the free strip at the top between the standings and the cluster
      const lb = document.querySelector<HTMLElement>('.hud .lb')?.getBoundingClientRect();
      const cl = document.querySelector<HTMLElement>('.hud .cluster')?.getBoundingClientRect();
      const left = (lb && lb.width ? lb.right - host.left : 0) + 12;
      const right = (cl && cl.width ? cl.left - host.left : vw) - 12;
      const w = Math.max(260, Math.min(720, right - left));
      this.bar.style.left = `${Math.round(left + Math.max(0, (right - left - w) / 2))}px`;
      this.bar.style.top = '12px';
      this.bar.style.bottom = '';
      this.bar.style.maxWidth = `${Math.round(w)}px`;
    } else {
      this.bar.style.left = '50%';
      this.bar.style.top = '';
      this.bar.style.bottom = `${Math.round(vh - stackTop + gap)}px`;
      this.bar.style.maxWidth = '';
    }

    if (target) this.light.onElement(target, host);
    else if (pt) {
      // the ring and arrow stay out of the bar and the bottom stack
      const b2 = this.bar.getBoundingClientRect();
      const avoidBottom = top ? vh - stackTop : vh - Math.min(stackTop, b2.top - host.top);
      const avoidTop = top ? b2.bottom - host.top : 0;
      this.light.onPoint(pt.x, pt.y, pt.r, host, { top: avoidTop, bottom: avoidBottom });
    } else this.light.hide();
  }

  destroy(): void {
    this.el.remove();
  }
}
