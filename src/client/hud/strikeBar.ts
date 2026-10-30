// STRIKES: a compact icon row at the end of the command bar's build area (barrage, bombing run, paratroopers,
// rocket, atom bomb). Only strikes you can use show up; each is a picture with its state at a glance (name, hotkey
// and what it does are in the tooltip):
//   ready     full colour, brass edge (a stored count where it has one: bombers, loaded silo slots)
//   cooling   dimmed picture, a ring filling up and the seconds left
//   blocked   ready but missing gold, infantry ...: hover or click says what is missing
// Locked strikes stay out of the bar (the Forces drawer, Y, lists them with how to unlock each); the hotkeys still
// say why not. Strikes the game's modifiers switch off are hidden for good.
import type { GameState, Player } from '../../sim/types';
import { iconDataUrl } from '../icons';
import { aimStrike, allStrikes, STRIKE_ORDER, STRIKES, strikeOfMode, strikesRevealed, type StrikeId, type StrikeStatus } from '../strikes';
import { el, flash, setClass, setText, setTip, setVisible, type HudCtx } from './dom';

interface Btn {
  root: HTMLButtonElement;
  ring: HTMLElement;
  label: HTMLElement;
  count: HTMLElement;
  last: StrikeStatus | null;
  /** biggest cooldown seen since it last was ready (for a ring when the full reload time is not known) */
  peak: number;
}

export class StrikeBar {
  readonly el: HTMLElement;
  private btns = new Map<StrikeId, Btn>();
  private revealed = false;
  private status = new Map<StrikeId, StrikeStatus>();
  /** strikes that turned ready since the last call to takeNewlyReady() */
  private fresh: StrikeId[] = [];

  constructor(private ctx: HudCtx) {
    this.el = el('div', 'skbar hidden');
    this.el.dataset.test = 'strikes';
    this.el.setAttribute('role', 'group');
    this.el.setAttribute('aria-label', 'Strikes');
    const row = this.el;
    for (const id of STRIKE_ORDER) {
      const info = STRIKES[id];
      const root = el('button', 'sk locked');
      root.type = 'button';
      root.dataset.test = `strike-${id}`;
      root.setAttribute('aria-label', `${info.name} (${info.key})`);
      const ring = el('span', 'sk-ring');
      const img = el('img', 'sk-ic');
      img.alt = '';
      img.width = 26;
      img.height = 26;
      img.draggable = false;
      try {
        img.src = iconDataUrl(info.icon, 26);
      } catch {
        /* no canvas (tests): the label still names it */
      }
      const label = el('span', 'sk-l');
      const count = el('span', 'sk-n');
      root.append(ring, img, label, count);
      root.addEventListener('click', () => {
        // keep the keyboard on the map (Space pauses, letters aim) instead of on this button
        root.blur();
        this.aim(id);
      });
      row.append(root);
      this.btns.set(id, { root, ring, label, count, last: null, peak: 0 });
    }
  }

  /** Status of a strike as last computed (null before the first update). */
  statusOf(id: StrikeId): StrikeStatus | null {
    return this.status.get(id) ?? null;
  }

  /** Strikes that became ready since the last call (for the advisor's first-use hints). */
  takeNewlyReady(): StrikeId[] {
    const f = this.fresh;
    this.fresh = [];
    return f;
  }

  /** A click or hotkey: aim when ready, else say why not (one line) and play the error sound. */
  aim(id: StrikeId): void {
    const s = this.ctx.state();
    const me = this.ctx.me();
    if (!s || !me || s.phase !== 'playing') return;
    const why = aimStrike(s, me, this.ctx.ui, id);
    if (why) {
      this.ctx.toast(`${STRIKES[id].name}: ${why}`, 'info');
      this.ctx.sound('uiError');
    }
    this.ctx.refreshSoon();
  }

  /** Every frame: the button of the strike being aimed is lit. */
  fast(): void {
    const cur = strikeOfMode(this.ctx.ui.mode);
    for (const [id, b] of this.btns) setClass(b.root, 'on', id === cur);
  }

  /** ~5 Hz. */
  update(s: GameState, me: Player): void {
    const list = allStrikes(s, me);
    if (!this.revealed && strikesRevealed(s, list)) this.revealed = true;
    const cur = strikeOfMode(this.ctx.ui.mode);
    const shown = (st: StrikeStatus) => st.allowed && (st.state !== 'locked' || st.id === cur);
    setVisible(this.el, this.revealed && list.some(shown));
    for (const st of list) {
      this.status.set(st.id, st);
      const b = this.btns.get(st.id)!;
      const info = STRIKES[st.id];
      setVisible(b.root, shown(st));
      if (!st.allowed) continue;
      const was = b.last?.state;
      if (st.state === 'ready' && was && was !== 'ready') {
        flash(b.root, 'sk-flash');
        this.fresh.push(st.id);
      } else if (st.state === 'ready' && !was && this.revealed) this.fresh.push(st.id);
      b.last = st;
      for (const k of ['ready', 'cooldown', 'locked', 'blocked'] as const) setClass(b.root, k, st.state === k);
      if (st.state === 'cooldown') {
        b.peak = Math.max(b.peak, st.left);
        const total = st.total > 0 ? st.total : b.peak;
        const p = total > 0 ? Math.max(0, Math.min(1, 1 - st.left / total)) : 0;
        b.ring.style.setProperty('--p', p.toFixed(3));
        setText(b.label, `${Math.max(1, Math.ceil(st.left))}`);
      } else {
        b.peak = 0;
        setText(b.label, '');
      }
      setText(b.count, st.count > 0 && st.state !== 'locked' ? String(st.count) : '');
      const head = st.state === 'ready' ? 'Ready' : st.state === 'cooldown' ? 'Reloading' : st.state === 'locked' ? 'Locked' : 'Not now';
      setTip(b.root, `${info.name}  [${info.key}]\n${head}: ${st.line}\n${info.what}\n${info.counter}`);
    }
  }
}
