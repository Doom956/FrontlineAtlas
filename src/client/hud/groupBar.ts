// One compact row per unit type at the top of a Forces drawer group: "Warships 14", "Airfields 5", "Tank divisions 6"
// with ONE order bar for all of them (client/groupOrders.ts), the help of the choice under the pointer, and
// "3 set by hand: 2 Hunt, 1 fixed on a target" with Reset to all when some differ. Airfields add Auto-refill all and
// (with Recon Planes) Auto recon all. Buttons are built once; update() only changes classes and texts.
import { hasTech } from '../../sim/tech';
import type { GameState, Player } from '../../sim/types';
import { GROUP_CHOICES, groupOrderActions, groupState, reconAllAction, reconAllOn, refillAllActions, refillAllOn, resetActions, sendAll, type GroupChoice, type GroupKind } from '../groupOrders';
import { el, setClass, setText, setTip, setVisible, type HudCtx } from './dom';
import { iconSpan, lineIcon } from './glyph';
import './pillars.css';

const TITLE: Record<GroupKind, [string, string]> = {
  warship: ['Warship', 'Warships'],
  air: ['Airfield', 'Airfields'],
  division: ['Tank division', 'Tank divisions'],
};

function toggle(label: string, test: string, run: () => void): HTMLButtonElement {
  const b = el('button', 'wr-btn mini ghost gb-tg');
  b.type = 'button';
  b.dataset.test = test;
  b.append(iconSpan(lineIcon('accept', 13, 2)), el('span', 'wr-btn-l', label));
  b.setAttribute('aria-pressed', 'false');
  b.addEventListener('click', run);
  return b;
}

export class GroupBar {
  readonly el: HTMLElement;
  private title = el('span', 'gb-t');
  private count = el('span', 'gb-n');
  private line = el('div', 'gb-line');
  private hand = el('div', 'gb-hand hidden');
  private handText = el('span', 'gb-hand-l');
  private reset: HTMLButtonElement;
  private btns = new Map<GroupChoice, HTMLButtonElement>();
  private hover: GroupChoice | null = null;
  private lit: GroupChoice | null = null;
  private refill: HTMLButtonElement | null = null;
  private recon: HTMLButtonElement | null = null;
  private extra: HTMLElement | null = null;

  constructor(private ctx: HudCtx, private kind: GroupKind) {
    this.el = el('div', 'gbar hidden');
    this.el.dataset.test = `gbar-${kind}`;
    const head = el('div', 'gb-head');
    head.append(this.title, this.count);
    const seg = el('div', 'gb-btns ap-seg');
    seg.setAttribute('role', 'toolbar');
    seg.setAttribute('aria-label', `Order for all ${TITLE[kind][1].toLowerCase()}`);
    for (const c of GROUP_CHOICES[kind]) {
      const b = el('button', 'wr-btn mini ap-b gb-b');
      b.type = 'button';
      b.dataset.v = c.v;
      b.dataset.test = `gbar-${kind}-${c.v}`;
      b.append(iconSpan(lineIcon(c.icon, 13, 2)), el('span', 'wr-btn-l', c.name));
      b.setAttribute('aria-pressed', 'false');
      setTip(b, c.help);
      b.addEventListener('click', () => this.order(c.v));
      const enter = (): void => {
        this.hover = c.v;
        this.showLine();
      };
      const leave = (): void => {
        if (this.hover === c.v) this.hover = null;
        this.showLine();
      };
      b.addEventListener('pointerenter', enter);
      b.addEventListener('focus', enter);
      b.addEventListener('pointerleave', leave);
      b.addEventListener('blur', leave);
      this.btns.set(c.v, b);
      seg.append(b);
    }
    this.reset = el('button', 'wr-btn mini ghost gb-reset');
    this.reset.type = 'button';
    this.reset.dataset.test = `gbar-${kind}-reset`;
    this.reset.append(iconSpan(lineIcon('back', 13, 2)), el('span', 'wr-btn-l', 'Reset to all'));
    setTip(this.reset, 'Give the ones set by hand the order of the rest');
    this.reset.addEventListener('click', () => this.send(() => resetActions(this.state()!, this.me(), kind)));
    this.hand.append(this.handText, this.reset);
    this.el.append(head, seg, this.line, this.hand);
    if (kind === 'air') {
      this.extra = el('div', 'gb-extra');
      this.refill = toggle('Auto-refill all', 'gbar-air-refill', () => this.send(() => refillAllActions(this.state()!, this.me(), !refillAllOn(this.state()!, this.me()))));
      this.recon = toggle('Auto recon all', 'gbar-air-recon', () => this.send(() => [reconAllAction(!reconAllOn(this.state()!, this.me()))]));
      this.extra.append(this.refill, this.recon);
      this.el.append(this.extra);
    }
  }

  private state(): GameState | null {
    return this.ctx.state();
  }
  private me(): number {
    return this.ctx.me()?.id ?? 0;
  }

  private send(make: () => ReturnType<typeof resetActions>): void {
    const s = this.state();
    if (!s || this.me() <= 0) return;
    const why = sendAll(this.ctx.dispatch, make());
    if (why) {
      this.ctx.toast(why, 'info');
      this.ctx.sound('uiError');
    } else this.ctx.sound('uiClick');
    this.ctx.refreshSoon();
  }

  private order(c: GroupChoice): void {
    this.send(() => groupOrderActions(this.state()!, this.me(), this.kind, c));
  }

  private showLine(): void {
    const v = this.hover ?? this.lit;
    const info = GROUP_CHOICES[this.kind].find((i) => i.v === v);
    setText(this.line, info ? info.help : '');
  }

  /** Hidden while the player has fewer than `min` of the type. */
  update(s: GameState, me: Player, min = 1): void {
    const g = groupState(s, me.id, this.kind);
    const n = g.members.length;
    setVisible(this.el, n >= min);
    if (n < min) return;
    const [one, many] = TITLE[this.kind];
    setText(this.title, n === 1 ? one : many);
    setText(this.count, String(n));
    // lit: the group's order (all of them have it, or most of them: then "set by hand" says how many differ)
    this.lit = g.choice;
    for (const [v, b] of this.btns) {
      const on = v === g.choice;
      setClass(b, 'on', on);
      if (b.getAttribute('aria-pressed') !== String(on)) b.setAttribute('aria-pressed', String(on));
    }
    this.showLine();
    const k = g.byHand.length;
    setVisible(this.hand, k > 0);
    if (k > 0) setText(this.handText, `${k} set by hand: ${g.byHandText}`);
    if (this.refill && this.recon) {
      const on = refillAllOn(s, me.id);
      const flying = g.members.some((m) => m.choice !== 'idle');
      setVisible(this.refill, flying);
      setClass(this.refill, 'on', on);
      this.refill.setAttribute('aria-pressed', String(on));
      setTip(this.refill, `${on ? 'On' : 'Off'} for all: replace bombers lost on missions automatically (gold permitting)`);
      const rOk = hasTech(me, 'reconPlanes');
      setVisible(this.recon, rOk);
      if (rOk) {
        const r = reconAllOn(s, me.id);
        setClass(this.recon, 'on', r);
        this.recon.setAttribute('aria-pressed', String(r));
        setTip(this.recon, `${r ? 'On' : 'Off'} for all: each airfield scouts the nation you are attacking (each flight costs gold and oil)`);
      }
      if (this.extra) setVisible(this.extra, flying || rOk);
    }
  }
}
