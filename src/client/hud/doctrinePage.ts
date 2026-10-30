// Doctrine picker (a wide drawer, Shift+D or the doctrine button in the top-right row): seven cards in a grid, each
// with its picture, name, one line on what it does and its three levels (reached levels bright, the next ones dim).
// The three that suit your situation say so, with the reason. Click a card to read it in the footer, where the
// Choose / Switch button and its price live (a switch costs gold, a short time without any doctrine and a cooldown).
// Before the unlock the page explains when doctrines open; every card can still be read.
import { DOCTRINES, DOCTRINE_ADAPT_SECONDS, DOCTRINE_LEVEL_SECONDS, DOCTRINE_SWITCH_COOLDOWN } from '../../sim/config';
import type { DoctrineId, GameState, Player } from '../../sim/types';
import { choiceInfo, DOCTRINE_ORDER, doctrineIcon, doctrineStatus, fmtClock, fmtDuration, recommendations, scaledSeconds } from '../doctrineView';
import { el, setClass, setDisabled, setText, type DrawerId, type HudCtx } from './dom';
import type { DrawerPage } from './drawers';
import { iconSpan, lineIcon } from './glyph';

interface Card {
  id: DoctrineId;
  btn: HTMLButtonElement;
  tag: HTMLElement;
  state: HTMLElement;
  reason: HTMLElement;
  levels: HTMLElement[];
}

export class DoctrinePage implements DrawerPage {
  id: DrawerId = 'doctrine';
  title = 'Doctrine';
  root = el('div', 'page doc-page');
  private head: HTMLElement;
  private headT: HTMLElement;
  private headL: HTMLElement;
  private cards = new Map<DoctrineId, Card>();
  private sel: DoctrineId | null = null;
  private footT: HTMLElement;
  private footD: HTMLElement;
  private footN: HTMLElement;
  private go: HTMLButtonElement;
  private last: { s: GameState; me: Player } | null = null;
  private howL: HTMLElement[] = [];

  constructor(private ctx: HudCtx) {
    this.head = el('div', 'doc-head');
    this.headT = el('div', 'doc-head-t');
    this.headL = el('div', 'doc-head-l');
    this.head.append(this.headT, this.headL);
    this.root.append(this.head);

    const grid = el('div', 'doc-grid');
    grid.setAttribute('role', 'radiogroup');
    grid.setAttribute('aria-label', 'Doctrines');
    for (const id of DOCTRINE_ORDER) grid.append(this.card(id));
    // the eighth cell: how doctrines work, in three lines
    const how = el('div', 'doc-how');
    how.append(el('div', 'wr-sec', 'How it works'));
    this.howL = [0, 1, 2].map(() => {
      const l = el('p', 'doc-how-l');
      how.append(l);
      return l;
    });
    grid.append(how);
    grid.addEventListener('keydown', (e) => this.onKey(e));
    this.root.append(grid);

    const foot = el('div', 'doc-foot');
    const txt = el('div', 'doc-foot-txt');
    this.footT = el('div', 'doc-foot-t');
    this.footD = el('div', 'doc-foot-d');
    this.footN = el('div', 'doc-foot-n');
    txt.append(this.footT, this.footD, this.footN);
    this.go = el('button', 'wr-btn primary doc-go');
    this.go.type = 'button';
    this.go.dataset.test = 'doctrine-go';
    this.go.addEventListener('click', () => this.choose());
    foot.append(txt, this.go);
    this.root.append(foot);
  }

  /** Opens on your doctrine, else the best suited one. */
  onOpen(): void {
    const s = this.ctx.state();
    const me = this.ctx.me();
    if (!s || !me) return;
    const cur = me.doctrine?.id ?? null;
    this.select(cur ?? recommendations(s, me).keys().next().value ?? DOCTRINE_ORDER[0], false);
    this.update(s, me);
    requestAnimationFrame(() => this.cards.get(this.sel ?? DOCTRINE_ORDER[0])?.btn.focus({ preventScroll: true }));
  }

  private card(id: DoctrineId): HTMLButtonElement {
    const d = DOCTRINES[id];
    const b = el('button', 'doc-card');
    b.type = 'button';
    b.dataset.test = `doctrine-${id}`;
    b.setAttribute('role', 'radio');
    b.style.setProperty('--dc', d.color);
    const top = el('span', 'doc-top');
    const ic = el('span', 'doc-ic');
    ic.append(iconSpan(lineIcon(doctrineIcon(id), 20)));
    const name = el('span', 'doc-n', d.name);
    const state = el('span', 'doc-s');
    top.append(ic, name, state);
    const tag = el('span', 'doc-tag hidden', 'Suits you');
    const short = el('span', 'doc-short', d.short);
    const lv = el('span', 'doc-lv');
    const levels = d.levels.map((t, k) => {
      const row = el('span', 'doc-lvr');
      row.append(el('i', 'doc-lvn', String(k + 1)), el('span', 'doc-lvt', t));
      lv.append(row);
      return row;
    });
    const reason = el('span', 'doc-why');
    b.append(top, tag, short, lv, reason);
    b.addEventListener('click', () => this.select(id, true));
    b.addEventListener('dblclick', () => this.choose());
    this.cards.set(id, { id, btn: b, tag, state, reason, levels });
    return b;
  }

  private select(id: DoctrineId, refresh: boolean): void {
    this.sel = id;
    for (const c of this.cards.values()) {
      setClass(c.btn, 'sel', c.id === id);
      c.btn.setAttribute('aria-checked', String(c.id === id));
      c.btn.tabIndex = c.id === id ? 0 : -1;
    }
    if (refresh && this.last) this.update(this.last.s, this.last.me);
  }

  private choose(): void {
    const s = this.ctx.state();
    const me = this.ctx.me();
    const id = this.sel;
    if (!s || !me || !id) return;
    const c = choiceInfo(s, me, id);
    if (!c.ok) {
      this.ctx.sound('uiError');
      return;
    }
    this.ctx.act({ type: 'chooseDoctrine', doctrine: id });
  }

  /** Arrow keys move between cards (the grid is 4 wide on a wide screen; up / down jump a row). */
  private onKey(e: KeyboardEvent): void {
    const k = e.key;
    if (k === 'Enter' && this.sel) {
      // Enter on the selected card = the footer button
      if (document.activeElement === this.cards.get(this.sel)?.btn) {
        e.preventDefault();
        this.choose();
      }
      return;
    }
    if (k !== 'ArrowUp' && k !== 'ArrowDown' && k !== 'ArrowLeft' && k !== 'ArrowRight') return;
    e.preventDefault();
    e.stopPropagation();
    const ids = [...DOCTRINE_ORDER];
    const i = ids.indexOf(this.sel ?? ids[0]);
    const first = this.cards.get(ids[0])!.btn;
    const cols = Math.max(1, ids.filter((x) => this.cards.get(x)!.btn.offsetTop === first.offsetTop).length);
    const step = k === 'ArrowLeft' ? -1 : k === 'ArrowRight' ? 1 : k === 'ArrowUp' ? -cols : cols;
    const j = Math.max(0, Math.min(ids.length - 1, i + step));
    this.select(ids[j], true);
    this.cards.get(ids[j])!.btn.focus();
  }

  update(s: GameState, me: Player): void {
    this.last = { s, me };
    const st = doctrineStatus(s, me);
    const recs = recommendations(s, me);
    const lv2 = fmtDuration(scaledSeconds(s, DOCTRINE_LEVEL_SECONDS[1]));
    const lv3 = fmtDuration(scaledSeconds(s, DOCTRINE_LEVEL_SECONDS[2]));

    // header: where you stand
    if (st.phase === 'locked') {
      setText(this.headT, `Doctrines unlock at ${fmtClock(st.unlockAt)}`);
      setText(this.headL, 'Read them now; choose once the clock gets there.');
    } else if (st.phase === 'none') {
      setText(this.headT, 'Choose a doctrine');
      setText(this.headL, recs.size ? 'Marked: the three that suit your land and neighbours.' : 'Pick the style you play most.');
    } else if (st.phase === 'adapting' && st.id) {
      setText(this.headT, `Adapting to ${DOCTRINES[st.id].name}: ${fmtDuration(st.adaptLeft)} left`);
      setText(this.headL, 'No doctrine bonus until your nation has adapted.');
    } else if (st.id) {
      setText(this.headT, `${DOCTRINES[st.id].name}, level ${st.level}`);
      setText(this.headL, st.level < 3 ? `Level ${st.level + 1} in ${fmtDuration(st.nextLevelIn)}.` : 'Full strength.');
    }
    setClass(this.head, 'locked', st.phase === 'locked');
    const adapt = fmtDuration(scaledSeconds(s, DOCTRINE_ADAPT_SECONDS));
    const cool = fmtDuration(scaledSeconds(s, DOCTRINE_SWITCH_COOLDOWN));
    setText(this.howL[0], 'Bonus only: every unit, building and strike stays open to everyone.');
    setText(this.howL[1], `Keep it to grow: level 2 after ${lv2}, level 3 after ${lv3}.`);
    setText(this.howL[2], `Switching costs gold and ${adapt} without a bonus, starts again at level 1, then waits ${cool}.`);

    // cards
    for (const c of this.cards.values()) {
      const mine = st.id === c.id && st.phase !== 'locked';
      const reason = recs.get(c.id);
      setClass(c.btn, 'cur', mine);
      setClass(c.btn, 'rec', !!reason);
      setClass(c.tag, 'hidden', !reason);
      setText(c.reason, reason ?? '');
      setText(c.state, mine ? (st.phase === 'adapting' ? `Adapting ${fmtDuration(st.adaptLeft)}` : `Level ${st.level}`) : '');
      c.btn.style.setProperty('--p', mine && st.phase === 'adapting' ? st.adaptDone.toFixed(3) : '1');
      setClass(c.btn, 'adapting', mine && st.phase === 'adapting');
      const reached = mine && st.phase === 'active' ? st.level : 0;
      c.levels.forEach((row, k) => {
        setClass(row, 'got', k < reached);
        setClass(row, 'now', k === reached - 1);
      });
      c.btn.setAttribute(
        'aria-label',
        `${DOCTRINES[c.id].name}: ${DOCTRINES[c.id].short}${reason ? `. Suits you: ${reason}` : ''}${mine ? `. Your doctrine, ${st.phase === 'adapting' ? 'adapting' : `level ${st.level}`}` : ''}`,
      );
    }

    // footer: the selected card in full and its button
    const id = this.sel;
    if (!id) return;
    const d = DOCTRINES[id];
    const c = choiceInfo(s, me, id);
    const mine = st.id === id && st.phase !== 'locked';
    setText(this.footT, d.name);
    setText(this.footD, mine ? (st.phase === 'adapting' ? `Adapting: the bonus starts in ${fmtDuration(st.adaptLeft)}.` : st.level < 3 ? `Your doctrine. Level ${st.level + 1} in ${fmtDuration(st.nextLevelIn)}.` : 'Your doctrine, at full strength.') : c.line);
    // locked: the header already says when; the button says it again where the eye goes
    setText(this.footN, mine || st.phase === 'locked' ? '' : c.reason);
    setClass(this.footN, 'bad', !c.ok);
    const lbl = st.phase === 'locked' ? `Unlocks at ${fmtClock(st.unlockAt)}` : c.label;
    if (this.go.textContent !== lbl) this.go.textContent = lbl;
    setDisabled(this.go, !c.ok);
    setClass(this.go, 'hidden', mine);
  }
}
