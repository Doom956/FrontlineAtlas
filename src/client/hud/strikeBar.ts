// STRIKES: a compact icon row at the end of the command bar's build area (barrage, bombing run, paratroopers,
// rocket, atom bomb). Only strikes you can use show up; each is a picture with its state at a glance (name, hotkey
// and what it does are in the tooltip):
//   ready     full colour, brass edge (a stored count where it has one: bombers, loaded silo slots)
//   cooling   dimmed picture, a ring filling up and the seconds left
//   blocked   ready but missing gold, infantry ...: hover or click says what is missing
// Bombing run, rocket and atom bomb carry their salvo size (x3 / x5 / All, bottom left; right-click cycles it,
// hud/salvoPicker.ts).
// Locked strikes stay out of the bar (the Forces drawer, Y, lists them with how to unlock each); the hotkeys still
// say why not. Strikes the game's modifiers switch off are hidden for good.
import type { GameState, Player } from '../../sim/types';
import { iconDataUrl } from '../icons';
import { catSpan, pixelStrike } from './pixelIcons';
import { aimMastery, MASTERY, MASTERY_ORDER, masteryAiming, masteryStatus, type MasteryId, type MasteryStatus } from '../masteryStrikes';
import type { IconId } from '../icons';
import { aimStrike, allStrikes, salvoKindOf, salvoOf, STRIKE_ORDER, STRIKES, strikeOfMode, strikesRevealed, type StrikeId, type StrikeStatus } from '../strikes';
import { salvoLabel } from '../salvoPrefs';
import { cycleSalvo, salvoTip } from './salvoPicker';
import { addKeyLabel, el, flash, setClass, setText, setTip, setVisible, type HudCtx } from './dom';

interface Btn {
  root: HTMLButtonElement;
  ring: HTMLElement;
  label: HTMLElement;
  count: HTMLElement;
  /** salvo size badge (bomb, rocket, atom bomb) */
  size: HTMLElement;
  last: StrikeStatus | null;
  /** biggest cooldown seen since it last was ready (for a ring when the full reload time is not known) */
  peak: number;
}

export class StrikeBar {
  readonly el: HTMLElement;
  private btns = new Map<StrikeId, Btn>();
  private mbtns = new Map<MasteryId, Btn>();
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
      const btn = makeBtn(`strike-${id}`, info.name, info.label, info.icon, info.key);
      btn.root.addEventListener('click', () => {
        // keep the keyboard on the map (Space pauses, letters aim) instead of on this button
        btn.root.blur();
        this.aim(id);
      });
      const kind = salvoKindOf(id);
      if (kind) {
        // right-click: the next salvo size (x1 -> x3 -> x5 -> All)
        btn.root.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          const n = cycleSalvo(this.ctx.ui, kind);
          this.ctx.toast(`${info.name}: ${salvoTip(kind, n)}`, 'info');
          this.ctx.refreshSoon();
        });
      }
      row.append(btn.root);
      this.btns.set(id, btn);
    }
    // the mastery strikes (Air, Naval, Armor Mastery): buttons too, never only a card
    for (const id of MASTERY_ORDER) {
      const info = MASTERY[id];
      const btn = makeBtn(`strike-${id}`, info.name, info.label, info.icon, '', info.art);
      btn.root.addEventListener('click', () => {
        btn.root.blur();
        this.aimMastery(id);
      });
      row.append(btn.root);
      this.mbtns.set(id, btn);
    }
  }

  /** A click on a mastery button: aim when ready, else say why not (one line). */
  private aimMastery(id: MasteryId): void {
    const s = this.ctx.state();
    const me = this.ctx.me();
    if (!s || !me || s.phase !== 'playing') return;
    const why = aimMastery(s, me, this.ctx.ui, id);
    if (!why && id === 'counter') this.ctx.act({ type: 'counteroffensive' }); // no aiming (sim/counter.ts)
    if (why) {
      this.ctx.toast(`${MASTERY[id].name}: ${why}`, 'info');
      this.ctx.sound('uiError');
    }
    this.ctx.refreshSoon();
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
    for (const [id, b] of this.mbtns) setClass(b.root, 'on', masteryAiming(this.ctx.ui, id));
  }

  /** ~5 Hz. */
  update(s: GameState, me: Player): void {
    const list = allStrikes(s, me);
    if (!this.revealed && strikesRevealed(s, list)) this.revealed = true;
    const cur = strikeOfMode(this.ctx.ui.mode);
    const shown = (st: StrikeStatus) => st.allowed && (st.state !== 'locked' || st.id === cur);
    const masteries = MASTERY_ORDER.map((id) => masteryStatus(s, me, id));
    setVisible(this.el, (this.revealed && list.some(shown)) || masteries.some((m) => m.show));
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
        setText(b.label, `${Math.max(1, Math.ceil(st.left))} s`);
      } else {
        b.peak = 0;
        setText(b.label, '');
      }
      setText(b.count, st.count > 0 && st.state !== 'locked' ? String(st.count) : '');
      const kind = salvoKindOf(st.id);
      const size = kind ? salvoOf(this.ctx.ui, kind) : 1;
      setText(b.size, kind && size !== 1 ? salvoLabel(size) : '');
      const head = st.state === 'ready' ? 'Ready' : st.state === 'cooldown' ? 'Reloading' : st.state === 'locked' ? 'Locked' : 'Not now';
      const salvo = kind ? `\nSalvo ${salvoTip(kind, size)}. Change it at the top while you aim.` : '';
      setTip(b.root, `${info.name}\n${head}: ${st.line}${salvo}\n${info.what}\n${info.counter}`);
    }
    for (const m of masteries) this.paintMastery(m);
  }

  private paintMastery(m: MasteryStatus): void {
    const b = this.mbtns.get(m.id)!;
    const info = MASTERY[m.id];
    setVisible(b.root, m.show);
    if (!m.show) return;
    for (const k of ['ready', 'cooldown', 'blocked'] as const) setClass(b.root, k, m.state === k);
    setClass(b.root, 'locked', false);
    if (m.state === 'cooldown') {
      b.peak = Math.max(b.peak, m.left);
      const total = m.total > 0 ? m.total : b.peak;
      b.ring.style.setProperty('--p', (total > 0 ? Math.max(0, Math.min(1, 1 - m.left / total)) : 0).toFixed(3));
      setText(b.label, `${Math.max(1, Math.ceil(m.left))} s`);
    } else {
      b.peak = 0;
      setText(b.label, '');
    }
    setText(b.count, m.count > 0 && m.state === 'ready' ? String(m.count) : '');
    setText(b.size, '');
    const head = m.state === 'ready' ? 'Ready' : m.state === 'cooldown' ? 'Recharging' : 'Not now';
    setTip(b.root, `${info.name}\n${head}: ${m.line}\n${info.what}\n${info.counter}`);
  }
}

/** One bottom-bar strike button: ring, picture, plain word, cooldown seconds, stored count and salvo size. */
function makeBtn(test: string, name: string, word: string, icon: IconId, key = '', pic: string = icon): Btn {
  const root = el('button', 'sk locked');
  root.type = 'button';
  root.dataset.test = test;
  root.setAttribute('aria-label', name);
  const ring = el('span', 'sk-ring');
  // a pixel picture in the strikes colour; the painted icon only where there is no canvas to trace it
  const art = pixelStrike(pic, 26);
  let img: HTMLElement;
  if (art) img = catSpan(art, 'strike', 'sk-ic');
  else {
    const im = el('img', 'sk-ic');
    im.alt = '';
    im.width = 26;
    im.height = 26;
    im.draggable = false;
    try {
      im.src = iconDataUrl(icon, 26);
    } catch {
      /* no canvas (tests): the label still names it */
    }
    img = im;
  }
  const label = el('span', 'sk-l');
  const count = el('span', 'sk-n');
  const size = el('span', 'sk-x');
  // Pixel Clean: a plain word under the icon (the cooldown seconds show in its place while reloading)
  root.append(ring, img, el('span', 'sk-w', word), label, count, size);
  if (key) addKeyLabel(root, key);
  return { root, ring, label, count, size, last: null, peak: 0 };
}
