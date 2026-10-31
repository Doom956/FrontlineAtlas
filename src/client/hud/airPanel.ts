// An airfield's standing mission (airwings.ts) as a compact selector: Support front · Strategic · Superiority · Idle,
// the wing (bombers per sortie, aircraft stored / room), what it is doing now and a "re-buy losses" toggle.
// Used by the selected-building drawer (drawers.ts) and the Forces drawer's Air group (one per airfield).
// Support / Strategic ask for a map click (an attack or front / the nation to raid); Superiority patrols over the
// airfield at once and a click can move the patrol.
import { formatCount } from '../render/common';
import { airSortieCost } from '../../sim/airwings';
import { buildingAt } from '../../sim/buildings';
import { unitAllowed } from '../../sim/rules';
import type { AirMission, Building, GameState, Player } from '../../sim/types';
import { AIR_ORDER, airInfo, airReady, setMission, toggleRefill, wingStatus } from '../pillars';
import { el, setClass, setText, setTip, setVisible, type HudCtx } from './dom';
import { iconSpan, lineIcon } from './glyph';
import './pillars.css';

export class AirPanel {
  readonly el: HTMLElement;
  private seg = el('div', 'ap-seg');
  private line = el('div', 'ap-line');
  private wing = el('div', 'ap-wing');
  private refill: HTMLButtonElement;
  private btns = new Map<AirMission, HTMLButtonElement>();
  private refillOn: boolean | null = null;

  constructor(private ctx: HudCtx, readonly tile: number, compact = false) {
    this.el = el('div', compact ? 'airpanel compact' : 'airpanel');
    this.el.dataset.test = 'air-panel';
    this.seg.setAttribute('role', 'toolbar');
    this.seg.setAttribute('aria-label', 'Air mission');
    for (const m of AIR_ORDER) {
      const i = airInfo(m);
      const b = el('button', 'wr-btn mini ap-b');
      b.type = 'button';
      b.dataset.v = m;
      b.append(iconSpan(lineIcon(i.icon, 14, 2)), el('span', 'wr-btn-l', m === 'support' ? 'Support' : m === 'strategic' ? 'Strategic' : m === 'superiority' ? 'Superiority' : 'Idle'));
      setTip(b, `${i.name}: ${i.help}${i.pick && m !== 'superiority' ? ' Then click the target.' : ''}`);
      b.setAttribute('aria-pressed', 'false');
      b.addEventListener('click', () => this.pick(m));
      this.btns.set(m, b);
      this.seg.append(b);
    }
    this.refill = el('button', 'wr-btn mini ghost ap-refill');
    this.refill.type = 'button';
    this.refill.addEventListener('click', () => {
      const s = ctx.state();
      const b = s ? buildingAt(s, this.tile) : undefined;
      if (!s || !b) return;
      const why = toggleRefill(s, ctx.dispatch, b);
      if (why) ctx.toast(why, 'info');
      ctx.refreshSoon();
    });
    const foot = el('div', 'ap-foot');
    foot.append(this.wing, this.refill);
    this.el.append(this.seg, this.line, foot);
  }

  private pick(m: AirMission): void {
    const s = this.ctx.state();
    if (!s) return;
    this.ctx.sound('uiClick');
    const why = setMission(s, this.ctx.ui, this.ctx.dispatch, this.tile, m);
    if (why) {
      this.ctx.toast(why, 'info');
      this.ctx.sound('uiError');
      return;
    }
    // a pick waits for the map: get the drawer out of the way
    if (this.ctx.ui.mode.kind === 'pillarPick') this.ctx.closeDrawer();
    this.ctx.refreshSoon();
  }

  update(s: GameState, me: Player, b: Building): void {
    const built = b.buildLeft <= 0;
    const ok = built && airReady(me) && unitAllowed(s, 'bomber');
    setVisible(this.el, ok);
    if (!ok) return;
    const st = wingStatus(s, b);
    for (const [m, x] of this.btns) {
      setClass(x, 'on', m === st.mission);
      if (x.getAttribute('aria-pressed') !== String(m === st.mission)) x.setAttribute('aria-pressed', String(m === st.mission));
    }
    setText(this.line, st.line);
    setClass(this.line, 'warn', (st.mission === 'support' || st.mission === 'strategic') && st.bombers <= 0 || (st.mission === 'superiority' && st.fighters <= 0));
    setText(this.wing, `Wing ${st.size} bombers per sortie · ${st.bombers + st.fighters}/${st.cap} aircraft · reach ${st.range}`);
    const c = airSortieCost(s, me.id);
    if (this.refillOn !== st.refill) {
      this.refillOn = st.refill;
      this.refill.replaceChildren(iconSpan(lineIcon(st.refill ? 'accept' : 'plus', 13, 2)), el('span', 'wr-btn-l', st.refill ? 'Re-buys losses' : 'Re-buy losses'));
      this.refill.setAttribute('aria-pressed', String(st.refill));
    }
    setClass(this.refill, 'on', st.refill);
    setTip(this.refill, `${st.refill ? 'On' : 'Off'}: replace bombers lost on missions automatically (${formatCount(c.gold)} gold each, gold permitting)`);
    setVisible(this.refill, st.mission === 'support' || st.mission === 'strategic');
  }
}
