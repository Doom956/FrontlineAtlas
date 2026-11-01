// Orders bar: a slim strip above the advisor line, only while own warships or tank divisions are selected.
//   Warships        Auto · Hold · Hunt · Escort · Bombard · Blockade (the stance they share is lit); Bombard / Blockade then
//                   ask for a coast / port click (optional: Esc lets the ships pick the nearest one)
//   Tank divisions  Hold · Support front (then click a front) · Refit, veterancy pips, strength bar (refit progress)
// One line under the buttons explains the stance under the pointer (or the lit one) and, for divisions, the
// encirclement hint of the spearhead preview. Bombard / Blockade / Auto ships and Support divisions follow your war
// by default: a follow row says whom (or "Fixed: ..." after a map pick, with Follow my war to switch back).
// Everything is one or two clicks; the rules stay in the sim.
import { divisionStrength } from '../../sim/armor2';
import { warshipMaxHp } from '../../sim/naval2';
import type { GameState, Player, Unit } from '../../sim/types';
import { followsWar, followText, groupFollow } from '../follow';
import { followUnitsAgain, MODE_INFO, MODE_ORDER, pocketLine, pocketPreview, setMode, setStance, sharedMode, sharedStance, STANCE_INFO, STANCE_ORDER, vetOf, VET_MAX, type ChoiceInfo } from '../pillars';
import { FollowRow } from './followRow';
import { previewFor, SPEARHEAD_CONFIRM_MS, splitSelection } from '../selection';
import { el, setClass, setText, setTip, setVisible, type HudCtx } from './dom';
import { iconSpan, lineIcon } from './glyph';
import './pillars.css';

const SLOW_MS = 200;

/** Veterancy pips: filled up to the level, the next one partly (a thin progress line under it). */
export function vetPips(level: number, next: number): HTMLElement {
  const box = el('span', 'ob-pips');
  box.setAttribute('aria-label', `Veterancy ${level} of ${VET_MAX}`);
  for (let k = 0; k < VET_MAX; k++) {
    const p = el('i', k < level ? 'on' : k === level ? 'next' : '');
    if (k === level) p.style.setProperty('--p', `${Math.round(next * 100)}%`);
    box.append(p);
  }
  return box;
}

class ChoiceRow<T extends string> {
  readonly el: HTMLElement;
  readonly head = el('div', 'ob-head');
  private title = el('span', 'ob-t');
  private pips = el('span', 'ob-pipbox');
  private meter = el('span', 'ob-meter hidden');
  private meterFill = el('i');
  private buttons = new Map<T, HTMLButtonElement>();
  private hover: T | null = null;
  readonly line = el('div', 'ob-line');
  readonly follow: FollowRow;
  private pipKey = '';

  constructor(test: string, order: readonly T[], private info: Record<T, ChoiceInfo>, run: (v: T) => void, private onHover: () => void, onFollow: () => void) {
    this.el = el('div', 'ob-row');
    this.el.dataset.test = test;
    const btns = el('div', 'ob-btns');
    btns.setAttribute('role', 'toolbar');
    btns.setAttribute('aria-label', test === 'orders-ships' ? 'Warship stance' : 'Division mode');
    for (const v of order) {
      const i = info[v];
      const b = el('button', 'wr-btn mini ob-b');
      b.type = 'button';
      b.dataset.v = v;
      b.dataset.test = `${test === 'orders-ships' ? 'stance' : 'mode'}-${v}`;
      b.append(iconSpan(lineIcon(i.icon, 14, 2)), el('span', 'wr-btn-l', i.name));
      b.setAttribute('aria-pressed', 'false');
      setTip(b, i.help + (i.pick ? ' Follows your war; click where to fix it.' : ''));
      b.addEventListener('click', () => run(v));
      const enter = (): void => {
        this.hover = v;
        this.onHover();
      };
      const leave = (): void => {
        if (this.hover === v) this.hover = null;
        this.onHover();
      };
      b.addEventListener('pointerenter', enter);
      b.addEventListener('focus', enter);
      b.addEventListener('pointerleave', leave);
      b.addEventListener('blur', leave);
      this.buttons.set(v, b);
      btns.append(b);
    }
    this.meter.append(this.meterFill);
    this.head.append(this.title, this.pips, this.meter);
    this.follow = new FollowRow(`${test === 'orders-ships' ? 'stance' : 'mode'}-follow`, onFollow);
    this.el.append(this.head, btns, this.line, this.follow.el);
  }

  set(title: string, active: T | null, vet: { level: number; next: number } | null, meter: number | null, meterTip: string, status: string): void {
    setText(this.title, title);
    for (const [v, b] of this.buttons) {
      const on = v === active;
      setClass(b, 'on', on);
      if (b.getAttribute('aria-pressed') !== String(on)) b.setAttribute('aria-pressed', String(on));
    }
    const pk = vet ? `${vet.level}:${Math.round(vet.next * 10)}` : '';
    if (pk !== this.pipKey) {
      this.pipKey = pk;
      this.pips.replaceChildren(...(vet ? [vetPips(vet.level, vet.next)] : []));
      setTip(this.pips, vet ? (vet.level >= VET_MAX ? 'Elite: top veterancy' : `Veterancy ${vet.level} of ${VET_MAX}: ${Math.round(vet.next * 100)}% to the next level`) : '');
    }
    setVisible(this.meter, meter !== null);
    if (meter !== null) {
      this.meterFill.style.width = `${Math.round(Math.max(0, Math.min(1, meter)) * 100)}%`;
      setClass(this.meter, 'low', meter < 0.5);
      setTip(this.meter, meterTip);
    }
    const shown = this.hover ?? active;
    setText(this.line, this.hover ? this.info[this.hover].help : status || (shown ? this.info[shown].help : 'Mixed orders: pick one for all of them'));
  }
}

export class OrdersBar {
  readonly el: HTMLElement;
  private ships: ChoiceRow<keyof typeof STANCE_INFO>;
  private tanks: ChoiceRow<keyof typeof MODE_INFO>;
  private last = 0;
  private dirty = true;

  constructor(private ctx: HudCtx) {
    this.el = el('div', 'orders-bar hidden');
    this.el.dataset.test = 'orders-bar';
    const say = (why: string): void => {
      if (!why) return;
      ctx.toast(why, 'info');
      ctx.sound('uiError');
    };
    const poke = (): void => {
      this.dirty = true;
    };
    this.ships = new ChoiceRow('orders-ships', STANCE_ORDER, STANCE_INFO, (v) => {
      const s = ctx.state();
      if (!s) return;
      ctx.sound('uiClick');
      say(setStance(s, ctx.ui, ctx.dispatch, splitSelection(s, s.humanId, ctx.ui.selection).warships, v));
      poke();
    }, poke, () => {
      const s = ctx.state();
      if (!s) return;
      ctx.sound('uiClick');
      say(followUnitsAgain(s, ctx.dispatch, 'warship', splitSelection(s, s.humanId, ctx.ui.selection).warships));
      poke();
    });
    this.tanks = new ChoiceRow('orders-tanks', MODE_ORDER, MODE_INFO, (v) => {
      const s = ctx.state();
      if (!s) return;
      ctx.sound('uiClick');
      say(setMode(s, ctx.ui, ctx.dispatch, splitSelection(s, s.humanId, ctx.ui.selection).tanks, v));
      poke();
    }, poke, () => {
      const s = ctx.state();
      if (!s) return;
      ctx.sound('uiClick');
      say(followUnitsAgain(s, ctx.dispatch, 'division', splitSelection(s, s.humanId, ctx.ui.selection).tanks));
      poke();
    });
    this.el.append(this.ships.el, this.tanks.el);
  }

  /** The follow row of a group: shown when the shared stance / mode follows a war (Bombard, Blockade, Auto, Support). */
  private followLine<T extends string>(row: ChoiceRow<T>, state: GameState, me: number, kind: 'warship' | 'division', choice: string | null, ids: readonly number[]): void {
    const fw = choice !== null && followsWar(kind, choice);
    const t = fw ? groupFollow(state, kind, ids) : null;
    row.follow.set(fw && t !== null, !t?.fixed, t && choice ? followText(state, me, kind, choice, t) : '');
  }

  update(state: GameState, me: Player): void {
    const ui = this.ctx.ui;
    const picking = ui.mode.kind === 'pillarPick';
    const show = state.phase === 'playing' && ui.selection.length > 0 && (ui.mode.kind === 'none' || picking);
    if (!show) {
      setVisible(this.el, false);
      return;
    }
    const now = performance.now();
    if (!this.dirty && now - this.last < SLOW_MS && !this.el.classList.contains('hidden')) return;
    this.last = now;
    this.dirty = false;
    const c = splitSelection(state, me.id, ui.selection);
    if (!c.warships.length && !c.tanks.length) {
      setVisible(this.el, false);
      return;
    }
    setVisible(this.el, true);
    const byId = new Map<number, Unit>();
    for (const u of state.units) byId.set(u.id, u);

    setVisible(this.ships.el, c.warships.length > 0);
    if (c.warships.length) {
      const ships = c.warships.map((id) => byId.get(id)!).filter(Boolean);
      const top = ships.reduce((a, u) => Math.max(a, u.vet ?? 0), 0);
      const lead = ships.find((u) => (u.vet ?? 0) === top) ?? ships[0];
      const hull = ships.reduce((a, u) => a + Math.max(0, u.hp) / Math.max(1, warshipMaxHp(u)), 0) / ships.length;
      const stance = sharedStance(state, me.id, c.warships);
      this.followLine(this.ships, state, me.id, 'warship', stance, c.warships);
      this.ships.set(
        c.warships.length === 1 ? 'Warship' : `${c.warships.length} warships`,
        stance,
        vetOf(lead),
        hull,
        `Hull ${Math.round(hull * 100)}%${ships.length > 1 ? ' on average' : ''}. Ships mend near your ports.`,
        '',
      );
    }

    setVisible(this.tanks.el, c.tanks.length > 0);
    if (c.tanks.length) {
      const tanks = c.tanks.map((id) => byId.get(id)!).filter(Boolean);
      const top = tanks.reduce((a, u) => Math.max(a, u.vet ?? 0), 0);
      const lead = tanks.find((u) => (u.vet ?? 0) === top) ?? tanks[0];
      const str = tanks.reduce((a, u) => a + divisionStrength(u), 0) / tanks.length;
      let status = '';
      if (!picking) {
        // the spearhead preview (clicked once, or hovered): would it encircle a pocket?
        const pend = ui.pendingSpearhead && now - ui.pendingSpearhead.at < SPEARHEAD_CONFIRM_MS ? ui.pendingSpearhead.tile : ui.hoverTile;
        const p = pend >= 0 ? previewFor(state, me.id, ui.selection, pend) : null;
        status = pocketLine(state, pocketPreview(state, me.id, p));
      }
      const mode = sharedMode(state, me.id, c.tanks);
      this.followLine(this.tanks, state, me.id, 'division', mode, c.tanks);
      this.tanks.set(
        c.tanks.length === 1 ? 'Tank division' : `${c.tanks.length} tank divisions`,
        mode,
        vetOf(lead),
        str,
        `Strength ${Math.round(str * 100)}%${str < 0.99 ? ': refits from your army while it holds (fast near a Factory)' : ''}`,
        status,
      );
      setClass(this.tanks.line, 'pocket', status.startsWith('Encircles'));
    }
  }
}
