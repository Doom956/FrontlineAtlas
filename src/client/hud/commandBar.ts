// Bottom command bar: the only control surface on the default screen.
//   TROOPS  one big readout (home troops / cap, growth with a trend arrow) over a bar with the growth-peak marker
//   ATTACK  the share of troops each attack sends: -/+ steppers, a big value and a slider ([ and ])
//   GOLD    gold and its rate; iron, oil and science appear as small chips once they matter
//   BUILD   category tabs and the buildings of that tab (pictogram, cost, hotkey); locked ones stay hidden
import { buildingCost, countBuildings } from '../../sim/buildings';
import { BUILDINGS, BUILDING_ORDER, TECHS } from '../../sim/config';
import { armyTotal, growthPeak } from '../../sim/economy';
import { hasTech } from '../../sim/tech';
import { depositCount } from '../../sim/territory';
import type { BuildingType, GameState, Player, TechId } from '../../sim/types';
import { formatCount } from '../render/common';
import { troopsToSend, troopSum } from '../input';
import { BUILD_TAB_OF, BUILD_TABS, BUILDING_SHORT, type BuildTab } from './text';
import { el, flash, fmtRate, keycap, sectionTitle, setClass, setText, setTip, setVisible, slider, syncSlider, type HudCtx } from './dom';
import { iconSpan, lineIcon, worldGlyph } from './glyph';
import { maxLevel } from '../simx';

/** A tech is "close" when it is researched, being researched, or all its prerequisites are done. */
export function techNear(p: Player, t: TechId | null): boolean {
  if (!t) return true;
  return hasTech(p, t) || p.researching === t || TECHS[t].requires.every((r) => hasTech(p, r));
}

export function buildReason(state: GameState, me: Player, type: BuildingType): string {
  const info = BUILDINGS[type];
  if (info.tech && !hasTech(me, info.tech)) return `Research ${TECHS[info.tech].name} first`;
  const c = buildingCost(state, me.id, type);
  if (me.gold < c.gold) return `Needs ${formatCount(c.gold)} gold (you have ${formatCount(me.gold)})`;
  if (me.iron < c.iron) return `Needs ${formatCount(c.iron)} iron: build a Mine on iron`;
  if (type === 'mine' && depositCount(state, me.id, 1) === 0) return 'Take land with iron first (grey rocks on the map)';
  if (type === 'oilWell' && depositCount(state, me.id, 2) === 0) return 'Take land with oil first (black drops on the map)';
  return '';
}

export class CommandBar {
  readonly el: HTMLElement;
  private tab: BuildTab = 'economy';
  private tabBtns = new Map<BuildTab, HTMLButtonElement>();
  private buildBtns = new Map<BuildingType, HTMLButtonElement>();
  private upd: ((s: GameState, me: Player) => void)[] = [];
  private lastTroops = -1;
  private lastGold = -1;
  private revealed = { iron: false, oil: false, science: false };

  constructor(private ctx: HudCtx) {
    this.el = el('div', 'cmdbar');
    this.el.dataset.test = 'command-bar';
    this.el.append(this.troops(), this.attack(), this.gold(), this.build());
  }

  /** ~5 Hz refresh. */
  update(s: GameState, me: Player): void {
    for (const f of this.upd) f(s, me);
  }

  /** Every frame: selection highlight follows the build mode. */
  fast(): void {
    const m = this.ctx.ui.mode;
    const sel = m.kind === 'build' ? m.building : null;
    for (const [b, button] of this.buildBtns) setClass(button, 'on', b === sel);
    if (sel && BUILD_TAB_OF[sel] !== this.tab) this.setTab(BUILD_TAB_OF[sel]);
  }

  private setTab(t: BuildTab): void {
    this.tab = t;
    for (const [id, b] of this.tabBtns) {
      setClass(b, 'on', id === t);
      b.setAttribute('aria-selected', String(id === t));
    }
    for (const [b, button] of this.buildBtns) button.dataset.tab = BUILD_TAB_OF[b] === t ? 'cur' : 'other';
    this.ctx.refreshSoon();
  }

  // ------------------------------------------------------------------------------------------ troops

  private troops(): HTMLElement {
    const box = el('section', 'cb-sec cb-troops');
    box.dataset.test = 'troops';
    const head = el('div', 'cb-head');
    head.append(sectionTitle('Troops'));
    const trend = el('span', 'cb-trend');
    head.append(trend);
    const read = el('div', 'cb-read');
    const big = el('span', 'cb-big');
    const cap = el('span', 'cb-cap');
    read.append(big, cap);
    const bar = el('div', 'tbar');
    const home = el('span', 'tbar-home');
    const away = el('span', 'tbar-away');
    const peak = el('span', 'tbar-peak');
    bar.append(home, away, peak);
    box.append(head, read, bar);
    box.addEventListener('click', () => this.ctx.openDrawer('army', true));
    box.classList.add('clickable');
    this.upd.push((s, me) => {
      const t = armyTotal(me.troops);
      let out = 0;
      for (const a of s.attacks) if (a.attacker === me.id) out += armyTotal(a.troops);
      const capv = Math.max(1, me.maxPop);
      setText(big, formatCount(t));
      setText(cap, `/ ${formatCount(me.maxPop)}`);
      const g = me.income.pop;
      trend.replaceChildren(iconSpan(lineIcon(g >= 0 ? 'up' : 'down', 12, 2.2), 'ico'), el('span', '', `${fmtRate(g)}/s`));
      trend.className = 'cb-trend ' + (g > 0.5 ? 'good' : g < -0.5 ? 'bad' : 'flat');
      const f = Math.min(1, t / capv);
      home.style.width = `${(f * 100).toFixed(1)}%`;
      away.style.left = `${(f * 100).toFixed(1)}%`;
      away.style.width = `${(Math.min(1 - f, out / capv) * 100).toFixed(1)}%`;
      const pk = growthPeak(capv) / capv;
      peak.style.left = `${(pk * 100).toFixed(1)}%`;
      // the bar says when to spend: near the peak = good, a full bar = wasted growth
      bar.className = 'tbar ' + (f > 0.85 ? 'full' : f > pk + 0.15 ? 'high' : f < 0.12 ? 'low' : 'ok');
      setTip(
        box,
        `Troops at home ${formatCount(t)} of ${formatCount(me.maxPop)}` +
          (out > 0 ? `, ${formatCount(out)} attacking` : '') +
          `.\nThey regrow fastest at the marker (about ${Math.round(pk * 100)}% of the cap); a full bar barely grows, so keep spending.` +
          `\nMore land, Cities and Farms raise the cap. Click for your army.`,
      );
      if (this.lastTroops >= 0 && Math.abs(t - this.lastTroops) > Math.max(400, this.lastTroops * 0.1)) flash(big, t > this.lastTroops ? 'flash-up' : 'flash-down');
      this.lastTroops = t;
    });
    return box;
  }

  // ------------------------------------------------------------------------------------------ attack share

  private attack(): HTMLElement {
    const ui = this.ctx.ui;
    const box = el('section', 'cb-sec cb-attack');
    const head = el('div', 'cb-head');
    const keys = el('span', 'cb-keys');
    keys.append(keycap('['), keycap(']'));
    head.append(sectionTitle('Attack'), keys);
    const row = el('div', 'cb-step');
    const set = (v: number) => {
      ui.attackShare = Math.max(0.05, Math.min(1, Math.round(v * 20) / 20));
      this.ctx.refreshSoon();
    };
    const minus = el('button', 'stepper');
    minus.type = 'button';
    minus.append(iconSpan(lineIcon('minus', 16, 2.2)));
    minus.setAttribute('aria-label', 'Send less ([)');
    minus.addEventListener('click', () => set(ui.attackShare - 0.05));
    const plus = el('button', 'stepper');
    plus.type = 'button';
    plus.append(iconSpan(lineIcon('plus', 16, 2.2)));
    plus.setAttribute('aria-label', 'Send more (])');
    plus.addEventListener('click', () => set(ui.attackShare + 0.05));
    const val = el('span', 'cb-big cb-share');
    val.dataset.test = 'attack-value';
    row.append(minus, val, plus);
    const range = slider(5, 100, 5, 'wr-range cb-slider');
    range.dataset.test = 'attack-share';
    range.setAttribute('aria-label', 'Share of troops sent per attack');
    range.addEventListener('input', () => {
      ui.attackShare = Number(range.value) / 100;
      setText(val, `${range.value}%`);
    });
    const sub = el('div', 'cb-sub');
    box.append(head, row, range, sub);
    setTip(box, 'Share of your troops each attack sends ( [ and ] ). Sending more than the defender has at home loses fewer troops per tile.');
    let last = -1;
    this.upd.push((_s, me) => {
      const v = Math.round(ui.attackShare * 100);
      syncSlider(range, v);
      setText(val, `${v}%`);
      if (last >= 0 && v !== last) flash(val, 'flash-key');
      last = v;
      setText(sub, `${formatCount(troopSum(troopsToSend(me, ui)))} troops`);
    });
    return box;
  }

  // ------------------------------------------------------------------------------------------ gold + chips

  private gold(): HTMLElement {
    const box = el('section', 'cb-sec cb-gold');
    const head = el('div', 'cb-head');
    head.append(sectionTitle('Gold'));
    const read = el('div', 'cb-read');
    const big = el('span', 'cb-big gold');
    const rate = el('span', 'cb-rate');
    read.append(big, rate);
    const chips = el('div', 'chips');
    const chip = (name: 'iron' | 'oil' | 'science', label: string, tip: string, onClick?: () => void) => {
      const c = el(onClick ? 'button' : 'span', 'chip hidden');
      if (c instanceof HTMLButtonElement) {
        c.type = 'button';
        c.addEventListener('click', (e) => {
          e.stopPropagation();
          onClick?.();
        });
      }
      c.dataset.test = `chip-${name}`;
      const v = el('span', 'chip-v');
      c.append(iconSpan(lineIcon(name, 13, 1.8)), v);
      c.setAttribute('aria-label', label);
      c.dataset.tip = tip;
      chips.append(c);
      return { c, v };
    };
    const iron = chip('iron', 'Iron', 'Iron: from Mines next to iron deposits. Armor, artillery and military buildings need it.');
    const oil = chip('oil', 'Oil', 'Oil: from Oil Wells next to oil deposits. Armor and aircraft burn it; without oil armor fights at half strength.');
    const sci = chip('science', 'Science', 'Science: pays for research (T). Research Labs add more.', () => this.ctx.openDrawer('research', true));
    box.append(head, read, chips);
    setTip(read, 'Gold: a base income plus land and cities; Markets add more. Buildings and research cost gold.');
    this.upd.push((s, me) => {
      const g = Math.floor(me.gold);
      setText(big, formatCount(g));
      setText(rate, `${fmtRate(me.income.gold)}/s`);
      if (this.lastGold >= 0 && g - this.lastGold > Math.max(150, this.lastGold * 0.2)) flash(big, 'flash-up');
      this.lastGold = g;
      // iron / oil appear once you can get some; science once research matters (a minute in, or a lab)
      if (!this.revealed.iron && (me.iron > 0 || me.income.iron > 0 || depositCount(s, me.id, 1) > 0)) this.revealed.iron = true;
      if (!this.revealed.oil && (me.oil > 0 || me.income.oil > 0 || depositCount(s, me.id, 2) > 0)) this.revealed.oil = true;
      if (!this.revealed.science && (me.researching || me.techs.length > 0 || countBuildings(s, me.id, 'lab', true) > 0 || me.science >= 60)) this.revealed.science = true;
      setVisible(iron.c, this.revealed.iron);
      setVisible(oil.c, this.revealed.oil);
      setVisible(sci.c, this.revealed.science);
      setText(iron.v, formatCount(me.iron));
      setText(oil.v, formatCount(me.oil));
      setText(sci.v, me.researching ? `${Math.round((me.researchProgress / TECHS[me.researching].science) * 100)}%` : formatCount(me.science));
      setTip(sci.c, me.researching ? `Researching ${TECHS[me.researching].name}. Click to open Research (T).` : 'Science: pays for research. Click to open Research (T).');
    });
    return box;
  }

  // ------------------------------------------------------------------------------------------ build bar

  private build(): HTMLElement {
    const box = el('section', 'cb-sec cb-build');
    const tabs = el('div', 'tabs');
    tabs.setAttribute('role', 'tablist');
    for (const t of BUILD_TABS) {
      const b = el('button', 'tab', t.label);
      b.type = 'button';
      b.setAttribute('role', 'tab');
      b.dataset.test = `tab-${t.id}`;
      b.addEventListener('click', () => this.setTab(t.id));
      this.tabBtns.set(t.id, b);
      tabs.append(b);
    }
    const row = el('div', 'bbar');
    for (const type of BUILDING_ORDER) {
      const info = BUILDINGS[type];
      const b = el('button', 'bb');
      b.type = 'button';
      b.dataset.test = `build-${type}`;
      b.dataset.building = type;
      b.setAttribute('aria-label', `${info.name} (${info.hotkey})`);
      const ic = iconSpan(worldGlyph(type, 24), 'bb-ic');
      const cost = el('span', 'bb-cost');
      const kc = keycap(info.hotkey);
      kc.classList.add('bb-key');
      b.append(ic, cost, kc);
      b.addEventListener('click', () => {
        const m = this.ctx.ui.mode;
        this.ctx.ui.mode = m.kind === 'build' && m.building === type ? { kind: 'none' } : { kind: 'build', building: type };
        this.ctx.ui.contextMenu = null;
      });
      this.buildBtns.set(type, b);
      row.append(b);
      this.upd.push((s, me) => {
        const c = buildingCost(s, me.id, type);
        // gold only on the button (the tooltip and the build preview also give the iron)
        setText(cost, formatCount(c.gold));
        const reason = buildReason(s, me, type);
        setClass(b, 'disabled', reason !== '');
        setVisible(b, techNear(me, info.tech) && b.dataset.tab === 'cur');
        const owned = countBuildings(s, me.id, type, true);
        const lv = maxLevel(type);
        setTip(
          b,
          `${info.name}  [${info.hotkey}]\n${BUILDING_SHORT[type]}.\n${info.description}` +
            `\nCost ${formatCount(c.gold)} gold${c.iron ? ` + ${formatCount(c.iron)} iron` : ''}, ${info.buildTime} s` +
            (owned ? `. You have ${owned}` : '') +
            (lv > 1 ? `. Build on one of yours to upgrade it (up to level ${lv})` : '') +
            (reason ? `\n${reason}` : ''),
        );
      });
    }
    box.append(tabs, row);
    this.setTab('economy');
    return box;
  }
}
