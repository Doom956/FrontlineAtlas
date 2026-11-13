// The guide's small bar and its spotlight: one line of text with a step counter, Show me (map steps), Next or Skip,
// and Hide guide. The bar sits just above the HUD's bottom stack (command bar, orders bar), so it never covers them;
// beside an open side drawer or the Spend panel it keeps to the free room next to it; when it would still cover
// what it points at or an open panel (build menu, nation card), it moves to the free strip at the top between the
// standings and the cluster. On phones it folds to one line while a drawer or nation card is open and steps aside
// while a panel on the command bar is open (frame()). The spotlight (tutorial/spotlight.ts) rings the element or
// the map tile and points an arrow at it, never over another panel.
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

/** Panels the bar must not cover (it moves aside or to the top instead). */
const PANELS = '.bm, .sp, .drawer, .ncard, .bsel';
/** Panels that rise from the command bar itself: on a phone the bar steps aside while one is open. */
const BAR_PANELS = '.bm, .sp, .bsel';
/** HUD parts the arrow must not be drawn over (unless they hold its target). */
const ARROW_KEEP_OUT = '.bm, .sp, .drawer, .ncard, .bsel, .orders-bar, .advisor';
/** Gap (px) between the bar and the HUD's bottom stack; more when an arrow points into the stack. */
const GAP = 8;
const ARROW_ROOM = 44;

type Box = { left: number; right: number; top: number; bottom: number };

function btn(label: string, cls: string, onClick: () => void, test: string, icon?: string): HTMLButtonElement {
  const b = el('button', `wr-btn mini ${cls}`);
  b.type = 'button';
  if (icon) b.append(iconSpan(lineIcon(icon, 13, 2)));
  b.append(el('span', 'wr-btn-l', label));
  b.dataset.test = test;
  b.addEventListener('click', onClick);
  return b;
}

const overlaps = (a: Box, b: Box): boolean => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;

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
  /** the bar's width on one line for the text it shows (0 = not measured yet: assume the widest) */
  private natW = 0;
  private natKey = '';

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

  /**
   * Places the bar and the spotlight (every frame; cheap).
   *   Desktop: just above the HUD's bottom stack, centred in the room beside an open side drawer or the Spend panel;
   *   when it would still cover its target, the tile ring or an open panel (build menu, nation card), it moves to the
   *   free strip at the top between the standings and the cluster.
   *   Phones: while a drawer or a nation card is open, one line just above the command bar (the drawer ends above
   *   it); while the build menu, Spend or the building selection is open, the bar steps aside (`tucked`).
   *   The arrow is never drawn over another panel, and the ring and arrow hide while a panel covers their target.
   */
  frame(): void {
    const v = this.view;
    if (!v || this.covered) return;
    const host = this.el.getBoundingClientRect();
    const vw = host.width || window.innerWidth;
    const vh = host.height || window.innerHeight;
    const narrow = vw <= 640;
    const target = v.target ? findTarget(v.target) : null;
    const pt = !target && v.tile >= 0 ? this.tilePoint(v.tile) : null;
    const rel = (r: DOMRect): Box => ({ left: r.left - host.left, right: r.right - host.left, top: r.top - host.top, bottom: r.bottom - host.top });

    // the open panels
    const panels: { el: HTMLElement; box: Box }[] = [];
    for (const p of document.querySelectorAll<HTMLElement>(PANELS)) {
      if (p.classList.contains('hidden')) continue;
      const r = p.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) panels.push({ el: p, box: rel(r) });
    }
    const tucked = narrow && panels.some((p) => p.el.matches(BAR_PANELS));
    const fold = narrow && !tucked && panels.length > 0;
    setClass(this.el, 'tucked', tucked);
    setClass(this.el, 'fold', fold);

    // bottom: just above the HUD's bottom stack (its visible parts)
    let stackTop = vh;
    for (const e of document.querySelectorAll<HTMLElement>('.hud-bottom > *')) {
      if (e.classList.contains('hidden')) continue;
      const r = e.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) stackTop = Math.min(stackTop, r.top - host.top);
    }
    if (stackTop >= vh) stackTop = vh - 12;
    // a target in the bottom stack gets its arrow above that stack: the bar leaves room for it
    const gap = target?.closest('.hud-bottom') ? ARROW_ROOM : GAP;

    let top = false;
    if (!tucked) {
      const br = this.bar.getBoundingClientRect();
      const k = this.bar.offsetWidth > 0 && br.width > 0 ? br.width / this.bar.offsetWidth : 1;
      const bh = br.height || 36;
      // the room it may use along its band above the bottom stack: right of a panel on the left (Spend), left of one
      // on the right (a side drawer); a wide centred panel (build menu, Research) leaves none, so the bar goes up top
      let left = 0;
      let right = vw;
      const sides = new Set<HTMLElement>();
      if (!narrow) {
        const bandTop = stackTop - gap - bh;
        const bandBottom = stackTop - gap;
        for (const p of panels) {
          if (p.box.bottom <= bandTop || p.box.top >= bandBottom) continue;
          if ((p.box.left + p.box.right) / 2 < vw / 2) left = Math.max(left, p.box.right + 12);
          else right = Math.min(right, p.box.left - 12);
          sides.add(p.el);
        }
      }
      const squeezed = left > 0 || right < vw;
      const room = Math.max(0, right - left - 24);
      // its width on one line, measured while it sat at the bottom unsqueezed (unknown: as wide as the room)
      const key = `${v.id}|${v.kind}|${v.readOnly}|${v.tile >= 0}|${this.text.textContent}`;
      if (key !== this.natKey) {
        this.natKey = key;
        this.natW = 0;
      }
      const maxW = parseFloat(this.bar.style.maxWidth) * k;
      if (!this.bar.classList.contains('top') && br.width > 0 && !(maxW > 0 && br.width >= maxW - 1)) this.natW = br.width;
      const bw = Math.min(this.natW || room, room);
      const mid = (left + right) / 2;
      const bottomBox = { left: mid - bw / 2, right: mid + bw / 2, top: stackTop - gap - bh, bottom: stackTop - gap };
      // what the bar must leave free: the target, the tile ring, open panels (those beside its room are left out)
      const keep: Box[] = [];
      if (target) {
        const r = rel(target.getBoundingClientRect());
        keep.push({ left: r.left - 8, right: r.right + 8, top: r.top - 8, bottom: r.bottom + 8 });
      }
      if (pt) keep.push({ left: pt.x - pt.r - 40, right: pt.x + pt.r + 40, top: pt.y - pt.r - 44, bottom: pt.y + pt.r + 8 });
      for (const p of panels) if (!sides.has(p.el)) keep.push(p.box);
      top = !narrow && (room < 320 || keep.some((b) => overlaps(bottomBox, b)));
      setClass(this.bar, 'top', top);
      if (top) {
        // the free strip at the top between the standings and the cluster
        const lb = document.querySelector<HTMLElement>('.hud .lb')?.getBoundingClientRect();
        const cl = document.querySelector<HTMLElement>('.hud .cluster')?.getBoundingClientRect();
        const l = (lb && lb.width ? lb.right - host.left : 0) + 12;
        const r = (cl && cl.width ? cl.left - host.left : vw) - 12;
        const w = Math.max(260, Math.min(720, r - l));
        this.bar.style.left = `${Math.round(l + Math.max(0, (r - l - w) / 2))}px`;
        this.bar.style.top = '12px';
        this.bar.style.bottom = '';
        this.bar.style.maxWidth = `${Math.round(w)}px`;
      } else {
        this.bar.style.left = squeezed ? `${Math.round(mid)}px` : '50%';
        this.bar.style.top = '';
        this.bar.style.bottom = `${Math.round(vh - stackTop + gap)}px`;
        this.bar.style.maxWidth = squeezed ? `${Math.round(room / k)}px` : '';
      }
    }

    // the ring and arrow: hidden while a panel covers their target, the arrow never over another panel
    const holder = target ? panels.find((p) => p.el.contains(target)) : undefined;
    const under = (b: Box): boolean => panels.some((p) => p !== holder && !p.el.contains(target ?? null) && overlaps(p.box, b));
    if (target) {
      const tb = rel(target.getBoundingClientRect());
      // phones with a panel up: only a target inside that panel keeps its ring
      if ((tucked && !holder) || under(tb)) {
        this.light.hide();
        return;
      }
      this.light.onElement(target, host);
    } else if (pt) {
      if (tucked || under({ left: pt.x - 1, right: pt.x + 1, top: pt.y - 1, bottom: pt.y + 1 })) {
        this.light.hide();
        return;
      }
      // the ring and arrow stay out of the bar and the bottom stack
      const b2 = this.bar.getBoundingClientRect();
      const avoidBottom = top ? vh - stackTop : vh - Math.min(stackTop, b2.top - host.top);
      const avoidTop = top ? b2.bottom - host.top : 0;
      this.light.onPoint(pt.x, pt.y, pt.r, host, { top: avoidTop, bottom: avoidBottom });
    } else {
      this.light.hide();
      return;
    }
    // the arrow never sits on another panel's text (the orders bar, the build menu's foot, a drawer)
    const ab = this.light.arrowBox;
    for (const p of document.querySelectorAll<HTMLElement>(ARROW_KEEP_OUT)) {
      if (p.classList.contains('hidden') || (target && p.contains(target))) continue;
      const r = p.getBoundingClientRect();
      if (r.width > 0 && r.height > 0 && overlaps(rel(r), ab)) {
        this.light.hideArrow();
        break;
      }
    }
  }

  destroy(): void {
    this.el.remove();
  }
}
