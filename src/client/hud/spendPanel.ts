// SPEND panel: a compact "Spend" button in the command bar's gold area opens three ways to turn gold into power:
//   Mercenaries  amount slider, live price (it rises with each hire this minute and with game time), "+X troops now"
//   Fund ally    pick an ally, an amount, and the expected effect (fundAllyEffect: stronger against your enemies)
//   War bonds    gold now for +x% attack for a while, then a cooldown
// Every refusal reason comes from the sim's own previews, so the button says exactly why before you click.
import { buildingCost, countBuildings } from '../../sim/buildings';
import { FUND_MIN_GOLD, MERC_MIN_AMOUNT, TECHS } from '../../sim/config';
import { armyTotal } from '../../sim/economy';
import { hasTech } from '../../sim/tech';
import { bestFactory, canBuildTankDivision, tankDivisionCount } from '../../sim/tanks';
import { exclusiveGroups, groupMembers, techStatus } from '../../sim/techtree';
import type { Suggestion } from '../simx';
import { areAllied } from '../../sim/diplomacy';
import { fundAllyEffect, mercenaryPrice, warBondsInfo, type FundAllyEffect, type MercenaryQuote, type WarBondsInfo } from '../../sim/spending';
import { isTribe } from '../../sim/types';
import type { GameState, Player } from '../../sim/types';
import { formatCount } from '../render/common';
import { el, setClass, setDisabled, setText, setTip, setVisible, slider, syncSlider, type HudCtx } from './dom';
import { iconSpan, lineIcon } from './glyph';

// ================================================================================================ pure helpers

/** Slider steps for mercenaries: up to the hire limit, in round steps. */
export function mercSteps(max: number): { min: number; max: number; step: number } {
  const top = Math.max(MERC_MIN_AMOUNT, Math.floor(max));
  const step = top >= 20000 ? 1000 : top >= 5000 ? 500 : top >= 1000 ? 100 : 10;
  return { min: MERC_MIN_AMOUNT, max: Math.max(MERC_MIN_AMOUNT, Math.floor(top / step) * step || top), step };
}

/** "+2.4k troops now for 1.1k gold (0.46 each)" or the reason. */
export function mercText(q: MercenaryQuote, amount: number): { main: string; sub: string; ok: boolean } {
  if (q.reason) {
    const can = q.affordable >= MERC_MIN_AMOUNT ? `You can afford ${formatCount(q.affordable)} now` : '';
    return { main: q.reason, sub: can, ok: false };
  }
  return {
    main: `+${formatCount(amount)} troops now for ${formatCount(Math.ceil(q.gold))} gold`,
    sub: `${q.perTroop.toFixed(2)} gold each; price rises with each hire this minute. Up to ${formatCount(q.max)} now`,
    ok: true,
  };
}

/** Allies a player can fund (alive, not tribes), in id order. */
export function fundableAllies(state: GameState, pid: number): Player[] {
  const out: Player[] = [];
  for (const p of state.players) {
    if (!p || p.id <= 0 || p.id === pid || !p.alive || !p.spawned || isTribe(p)) continue;
    if (areAllied(state, pid, p.id)) out.push(p);
  }
  return out;
}

/** "+12% attack against your enemies for 60 s, opinion +4" or the reason. */
export function fundText(e: FundAllyEffect, allyName: string): { main: string; sub: string; ok: boolean } {
  const what = `${allyName}: +${Math.round(e.bonus * 100)}% attack against your enemies for ${Math.round(e.seconds)} s`;
  const sub = `Opinion +${e.opinion}; joins your wars more readily`;
  if (e.reason) return { main: e.reason, sub: e.bonus > 0 ? what : '', ok: false };
  return { main: what, sub, ok: true };
}

/** "+15% attack for 45 s: 900 gold" / running / cooldown. */
export function bondsText(i: WarBondsInfo): { main: string; sub: string; ok: boolean } {
  const what = `+${Math.round(i.bonus * 100)}% attack for ${Math.round(i.seconds)} s`;
  if (i.activeLeft > 0) return { main: `Running: ${what.split(' for ')[0]}, ${Math.ceil(i.activeLeft)} s left`, sub: i.readyIn > 0 ? `Again in ${Math.ceil(i.readyIn)} s` : '', ok: false };
  if (i.reason) return { main: i.reason, sub: Number.isFinite(i.price) ? `${what} for ${formatCount(i.price)} gold` : '', ok: false };
  return { main: `${what} for ${formatCount(i.price)} gold`, sub: 'Then a cooldown before the next sale', ok: true };
}

// ================================================================================================ the panel

export class SpendPanel {
  /** the small button for the gold area */
  readonly button: HTMLButtonElement;
  /** the popover (put it in the command bar, which is positioned) */
  readonly el: HTMLElement;
  private isOpen = false;
  private upd: ((s: GameState, me: Player) => void)[] = [];
  private ac = new AbortController();
  private ally = -1;

  constructor(private ctx: HudCtx) {
    this.button = el('button', 'sp-btn');
    this.button.type = 'button';
    this.button.dataset.test = 'spend';
    this.button.setAttribute('aria-haspopup', 'dialog');
    this.button.append(el('span', '', 'Spend'));
    this.button.dataset.tip = 'Spend gold: hire mercenaries, fund an ally, sell war bonds';
    this.button.addEventListener('click', (e) => {
      e.stopPropagation();
      this.toggle();
    });

    this.el = el('div', 'sp hidden');
    this.el.dataset.test = 'spend-panel';
    this.el.setAttribute('role', 'dialog');
    this.el.setAttribute('aria-label', 'Spend gold');
    this.el.addEventListener('pointerdown', (e) => e.stopPropagation());
    const head = el('div', 'sp-head');
    head.append(iconSpan(lineIcon('gold', 16, 1.9), 'sp-hic'), el('span', 'sp-t', 'Spend gold'));
    const x = el('button', 'sq sp-x');
    x.type = 'button';
    x.setAttribute('aria-label', 'Close (Esc)');
    x.append(iconSpan(lineIcon('close', 14)));
    x.addEventListener('click', () => this.close());
    head.append(x);
    this.el.append(head, this.mercs(), this.fund(), this.bonds());

    const o = { signal: this.ac.signal };
    window.addEventListener(
      'keydown',
      (e) => {
        if (!this.alive() || !this.isOpen || e.key !== 'Escape') return;
        e.preventDefault();
        e.stopImmediatePropagation();
        this.close();
      },
      { ...o, capture: true },
    );
    window.addEventListener(
      'pointerdown',
      (e) => {
        if (!this.alive() || !this.isOpen) return;
        const t = e.target as Node | null;
        if (t && (this.el.contains(t) || this.button.contains(t))) return;
        this.close();
      },
      { ...o, capture: true },
    );
  }

  get open(): boolean {
    return this.isOpen;
  }
  toggle(): void {
    if (this.isOpen) this.close();
    else this.show();
  }
  show(): void {
    this.isOpen = true;
    setVisible(this.el, true);
    setClass(this.button, 'on', true);
    const s = this.ctx.state();
    const me = this.ctx.me();
    if (s && me) this.update(s, me);
  }
  close(): void {
    this.isOpen = false;
    setVisible(this.el, false);
    setClass(this.button, 'on', false);
  }
  private alive(): boolean {
    if (this.button.isConnected) return true;
    this.ac.abort();
    return false;
  }

  /** ~5 Hz. */
  update(s: GameState, me: Player): void {
    // the button only once there is something to spend on (a little gold); always while the panel is open
    setVisible(this.button, s.phase === 'playing');
    if (!this.isOpen) return;
    if (s.phase !== 'playing') return this.close();
    for (const f of this.upd) f(s, me);
  }

  private block(title: string, icon: string, test: string): { box: HTMLElement; main: HTMLElement; sub: HTMLElement; go: HTMLButtonElement; ctl: HTMLElement } {
    const box = el('section', 'sp-sec');
    box.dataset.test = test;
    const h = el('div', 'sp-sh');
    h.append(iconSpan(lineIcon(icon, 15, 1.9), 'sp-ic'), el('span', 'sp-st', title));
    const ctl = el('div', 'sp-ctl');
    const main = el('div', 'sp-main');
    const sub = el('div', 'sp-sub');
    const go = el('button', 'wr-btn primary sp-go');
    go.type = 'button';
    box.append(h, ctl, main, sub, go);
    return { box, main, sub, go, ctl };
  }

  private mercs(): HTMLElement {
    const b = this.block('Mercenaries', 'troops', 'spend-mercs');
    const range = slider(MERC_MIN_AMOUNT, MERC_MIN_AMOUNT * 10, 10, 'wr-range sp-range');
    range.setAttribute('aria-label', 'Mercenaries to hire');
    range.dataset.test = 'merc-amount';
    const v = el('span', 'sp-v');
    b.ctl.append(range, v);
    let amount = 0;
    const refresh = (s: GameState, me: Player) => {
      const q0 = mercenaryPrice(s, me.id, MERC_MIN_AMOUNT);
      const st = mercSteps(q0.max);
      range.min = String(st.min);
      range.max = String(st.max);
      range.step = String(st.step);
      if (amount <= 0) amount = Math.max(st.min, Math.min(st.max, Math.floor(Math.max(q0.affordable, st.min) / st.step) * st.step || st.min));
      amount = Math.max(st.min, Math.min(st.max, amount));
      syncSlider(range, amount);
      setText(v, formatCount(amount));
      const q = mercenaryPrice(s, me.id, amount);
      const t = mercText(q, amount);
      setText(b.main, t.main);
      setText(b.sub, t.sub);
      setClass(b.main, 'bad', !t.ok);
      setText(b.go, t.ok ? `Hire ${formatCount(amount)}` : 'Hire');
      setDisabled(b.go, !t.ok);
      setTip(b.go, t.ok ? '' : t.main);
    };
    range.addEventListener('input', () => {
      amount = Number(range.value);
      const s = this.ctx.state();
      const me = this.ctx.me();
      if (s && me) refresh(s, me);
    });
    b.go.addEventListener('click', () => {
      if (this.ctx.act({ type: 'hireMercenaries', amount })) {
        this.ctx.toast(`${formatCount(amount)} mercenaries joined your army`, 'good');
        amount = 0;
      }
    });
    this.upd.push(refresh);
    setTip(b.box, 'Mercenaries: troops for gold right away, as infantry at home. The price rises with each hire within a minute and as the game goes on; there is a cap per minute and just above your troop cap.');
    return b.box;
  }

  private fund(): HTMLElement {
    const b = this.block('Fund an ally', 'ally', 'spend-fund');
    const sel = el('select', 'sp-sel');
    sel.setAttribute('aria-label', 'Ally to fund');
    sel.dataset.test = 'fund-ally';
    const range = slider(FUND_MIN_GOLD, FUND_MIN_GOLD * 10, 50, 'wr-range sp-range');
    range.setAttribute('aria-label', 'Gold to send');
    range.dataset.test = 'fund-amount';
    const v = el('span', 'sp-v');
    const row = el('div', 'sp-row');
    row.append(range, v);
    b.ctl.classList.add('col');
    b.ctl.append(sel, row);
    let gold = 0;
    let allyKey = '';
    const refresh = (s: GameState, me: Player) => {
      const allies = fundableAllies(s, me.id);
      const key = allies.map((p) => `${p.id}:${p.name}`).join('|');
      if (key !== allyKey) {
        allyKey = key;
        sel.replaceChildren(
          ...allies.map((p) => {
            const o = el('option', '', p.name);
            o.value = String(p.id);
            return o;
          }),
        );
        if (!allies.some((p) => p.id === this.ally)) this.ally = allies[0]?.id ?? -1;
        sel.value = String(this.ally);
      }
      setVisible(sel, allies.length > 0);
      setVisible(row, allies.length > 0);
      if (!allies.length) {
        setText(b.main, 'You have no allies to fund');
        setText(b.sub, 'Ally with a nation first (Diplomacy, P)');
        setClass(b.main, 'bad', true);
        setDisabled(b.go, true);
        setText(b.go, 'Send');
        return;
      }
      const top = Math.max(FUND_MIN_GOLD, Math.floor(me.gold / 50) * 50);
      range.max = String(top);
      if (gold <= 0) gold = Math.max(FUND_MIN_GOLD, Math.min(top, Math.round(me.gold / 4 / 50) * 50));
      gold = Math.max(FUND_MIN_GOLD, Math.min(top, gold));
      syncSlider(range, gold);
      setText(v, formatCount(gold));
      const ally = s.players[this.ally];
      const e = fundAllyEffect(s, me.id, this.ally, gold);
      const t = fundText(e, ally?.name ?? 'Ally');
      setText(b.main, t.main);
      setText(b.sub, t.sub);
      setClass(b.main, 'bad', !t.ok);
      setText(b.go, `Send ${formatCount(gold)} gold`);
      setDisabled(b.go, !t.ok);
      setTip(b.go, t.ok ? '' : t.main);
    };
    sel.addEventListener('change', () => {
      this.ally = Number(sel.value);
      const s = this.ctx.state();
      const me = this.ctx.me();
      if (s && me) refresh(s, me);
    });
    range.addEventListener('input', () => {
      gold = Number(range.value);
      const s = this.ctx.state();
      const me = this.ctx.me();
      if (s && me) refresh(s, me);
    });
    b.go.addEventListener('click', () => {
      // the sim's 'allyAid' event already toasts "You funded <ally> with ..."; a second toast here said the same thing
      this.ctx.act({ type: 'fundAlly', ally: this.ally, gold });
    });
    this.upd.push(refresh);
    setTip(b.box, 'Fund an ally: send gold; the ally fights harder against your enemies for a while and joins your wars more readily.');
    return b.box;
  }

  private bonds(): HTMLElement {
    const b = this.block('War bonds', 'attack', 'spend-bonds');
    b.ctl.remove();
    const refresh = (s: GameState, me: Player) => {
      const i = warBondsInfo(s, me.id);
      const t = bondsText(i);
      setText(b.main, t.main);
      setText(b.sub, t.sub);
      setClass(b.main, 'bad', !t.ok && i.activeLeft <= 0);
      setClass(b.main, 'run', i.activeLeft > 0);
      setText(b.go, Number.isFinite(i.price) ? `Sell bonds (${formatCount(i.price)} gold)` : 'Sell bonds');
      setDisabled(b.go, !t.ok);
      setTip(b.go, t.ok ? '' : t.main);
    };
    b.go.addEventListener('click', () => this.ctx.act({ type: 'warBonds' }));
    this.upd.push(refresh);
    setTip(b.box, 'War bonds: pay gold now for stronger attacks for a while; then a cooldown.');
    return b.box;
  }
}

// ================================================================================================ advisor lines

/**
 * One advisor line about the newer ways to play (null = nothing to say), lowest priority in the strip:
 * a tech choice that is open now, tank divisions once you can build them, mercenaries when short of troops at war,
 * funding an ally at war, and Build x5 when gold piles up.
 */
export function waysToPlayAdvice(s: GameState, me: Player): Suggestion | null {
  // a choice of the tech tree that is open now (and none of it taken yet)
  for (const g of exclusiveGroups()) {
    const ts = groupMembers(g);
    if (ts.some((t) => techStatus(s, me.id, t) !== 'available')) continue;
    return { key: `choice-${g}`, text: `A choice: ${ts.map((t) => TECHS[t].name).join(' or ')}. Picking one locks the other`, drawer: 'research' };
  }
  const home = armyTotal(me.troops);
  const atWarNow = s.attacks.some((a) => a.target === me.id && a.attacker > 0 && !isTribe(s.players[a.attacker]));
  if (atWarNow && home < me.maxPop * 0.25) {
    const q = mercenaryPrice(s, me.id, MERC_MIN_AMOUNT);
    if (q.affordable >= MERC_MIN_AMOUNT * 2) return { key: 'mercs', text: 'Short of troops under attack: hire mercenaries with gold (Spend, next to your gold)' };
  }
  if (atWarNow && me.gold > 2500) {
    const ally = fundableAllies(s, me.id)[0];
    if (ally) return { key: 'fund-ally', text: `Fund ${ally.name} (Spend, next to your gold): they fight harder against your enemies` };
  }
  if (hasTech(me, 'mechanization') && bestFactory(s, me.id) >= 0 && tankDivisionCount(s, me.id) === 0 && canBuildTankDivision(s, me.id, bestFactory(s, me.id)).ok) {
    return { key: 'tank-division', text: 'Tank divisions: build one at a Factory (Build menu, Tab) and click enemy land to break through' };
  }
  const city = buildingCost(s, me.id, 'city');
  if (countBuildings(s, me.id, 'city', true) > 0 && me.gold > city.gold * 6) {
    return { key: 'bulk-city', text: 'Gold piling up: pick x5 in the Build menu (Tab) to take a City straight to level 5', building: 'city' };
  }
  return null;
}
