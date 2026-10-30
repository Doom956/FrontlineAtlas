// Toasts: short messages at the top centre that fade after a few seconds; important ones (an alliance request)
// stay with their buttons until answered or expired. At most four at once; a repeated text refreshes its toast.
import { el } from './dom';
import { iconSpan, lineIcon } from './glyph';

export interface ToastAction {
  label: string;
  primary?: boolean;
  run: () => void;
}
export interface ToastSpec {
  text: string;
  kind?: 'info' | 'good' | 'bad' | 'warn';
  icon?: string;
  /** a nation's colour (CSS): a small swatch before the text (ally news) */
  swatch?: string;
  /** ms on screen (default 4000); ignored while `sticky` returns true */
  ms?: number;
  /** keep while this is true (checked ~5 Hz) */
  sticky?: () => boolean;
  actions?: ToastAction[];
  /** click on the text: e.g. centre the map on the event */
  onClick?: () => void;
  key?: string;
}

interface Live {
  spec: ToastSpec;
  el: HTMLElement;
  until: number;
}

const MAX = 4;
const DEFAULT_MS = 4000;

export class Toasts {
  readonly el: HTMLElement;
  private live: Live[] = [];

  constructor() {
    this.el = el('div', 'toasts');
    this.el.dataset.test = 'toasts';
    this.el.setAttribute('role', 'status');
    this.el.setAttribute('aria-live', 'polite');
  }

  show(spec: ToastSpec): void {
    const key = spec.key ?? spec.text;
    const now = performance.now();
    const old = this.live.find((t) => (t.spec.key ?? t.spec.text) === key);
    if (old) {
      old.until = now + (spec.ms ?? DEFAULT_MS);
      // same key, new words (e.g. a strike warning followed by its report): show the latest
      if (spec.text !== old.spec.text) {
        const t = old.el.querySelector('.toast-t');
        if (t) t.textContent = spec.text;
        old.spec = { ...old.spec, text: spec.text };
      }
      return;
    }
    const t = el('div', `toast k-${spec.kind ?? 'info'}`);
    t.dataset.test = 'toast';
    if (spec.icon) t.append(iconSpan(lineIcon(spec.icon, 16), 'ico'));
    if (spec.swatch) {
      const sw = el('i', 'sw toast-sw');
      sw.style.background = spec.swatch;
      t.append(sw);
    }
    const txt = el(spec.onClick ? 'button' : 'span', 'toast-t', spec.text);
    if (txt instanceof HTMLButtonElement) {
      txt.type = 'button';
      txt.addEventListener('click', () => spec.onClick?.());
    }
    t.append(txt);
    const live: Live = { spec, el: t, until: now + (spec.ms ?? DEFAULT_MS) };
    for (const a of spec.actions ?? []) {
      const b = el('button', 'wr-btn mini' + (a.primary ? ' primary' : ''), a.label);
      b.type = 'button';
      b.addEventListener('click', () => {
        a.run();
        this.drop(live);
      });
      t.append(b);
    }
    const x = el('button', 'toast-x');
    x.type = 'button';
    x.setAttribute('aria-label', 'Dismiss');
    x.append(iconSpan(lineIcon('close', 12, 2)));
    x.addEventListener('click', () => this.drop(live));
    t.append(x);
    this.el.prepend(t);
    this.live.unshift(live);
    while (this.live.length > MAX) {
      // drop the oldest non-sticky first
      const idx = [...this.live].reverse().findIndex((l) => !l.spec.sticky?.());
      this.drop(this.live[idx >= 0 ? this.live.length - 1 - idx : this.live.length - 1]);
    }
  }

  private drop(l: Live): void {
    const i = this.live.indexOf(l);
    if (i >= 0) this.live.splice(i, 1);
    l.el.classList.add('out');
    setTimeout(() => l.el.remove(), 160);
  }

  /** Toasts on screen now. */
  get count(): number {
    return this.live.length;
  }

  /** ~5 Hz: expire old toasts. */
  update(): void {
    const now = performance.now();
    for (const l of [...this.live]) {
      if (l.spec.sticky?.()) {
        l.until = Math.max(l.until, now + 600);
        continue;
      }
      if (now > l.until) this.drop(l);
    }
  }

  /** Removes the toast with this key (or text), if it is on screen. */
  dismiss(key: string): void {
    for (const l of [...this.live]) if ((l.spec.key ?? l.spec.text) === key) this.drop(l);
  }

  clear(): void {
    for (const l of [...this.live]) this.drop(l);
  }
}
