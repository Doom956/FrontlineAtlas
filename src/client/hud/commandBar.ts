// Bottom command bar: the only control surface on the default screen, kept slim.
//   TROOPS  one big readout (home troops / cap, growth trend) over a thin bar with the growth-peak marker
//   ATTACK  the share of troops each attack sends: -/+ steppers around a big value, a thin slider ([ and ])
//   GOLD    gold and its rate; iron, oil and science sit behind one small resources chip that opens on hover
//   BUILD   four small category icons and icon-only buttons (name, cost, hotkey in the tooltip); the Military tab
//           also sells warships, bombers and fighters (built at your port / airfield nearest the view)
//   STRIKES a compact icon row next to the build buttons, only while a strike is ready, reloading or aimed
//           (hud/strikeBar.ts; locked ones live in the Forces drawer with how to unlock them)
import { buildingAllowed, buildSeconds, mods, researchRule } from '../../sim/rules';
import { buildingCost, countBuildings } from '../../sim/buildings';
import { BUILDINGS, BUILDING_ORDER, TECHS, UNITS } from '../../sim/config';
import { armyTotal, growthPeak } from '../../sim/economy';
import { hasTech } from '../../sim/tech';
import { depositCount } from '../../sim/territory';
import type { BuildingType, GameState, Player, TechId } from '../../sim/types';
import { formatCount } from '../render/common';
import { troopsToSend, troopSum } from '../input';
import { BUYABLE_UNITS, buildUnit, priceText, UNIT_TEXT, unitBuildStatus, type BuyableUnit } from '../forces';
import { iconDataUrl } from '../icons';
import { BUILD_TAB_OF, BUILD_TABS, buildingTexts, type BuildTab } from './text';
import { el, flash, fmtRate, fmtSeconds, setClass, setText, setTip, setVisible, slider, syncSlider, type HudCtx } from './dom';
import { iconSpan, lineIcon, worldGlyph } from './glyph';
import { maxLevel } from '../simx';
import { StrikeBar } from './strikeBar';

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

/** Category tab icons (line icons, so they read as tabs rather than buildings). */
const TAB_ICON: Record<BuildTab, string> = { economy: 'gold', military: 'army', defence: 'shield', special: 'star' };
const TAB_TIP: Record<BuildTab, string> = {
  economy: 'Economy: cities, farms, markets, mines, wells, labs',
  military: 'Military: barracks, factories, arsenals, depots, hospitals, and warships, bombers, fighters',
  defence: 'Defence: forts, watchtowers, SAM sites',
  special: 'Special: ports, airfields, missile silos',
};

export class CommandBar {
  readonly el: HTMLElement;
  private tab: BuildTab = 'economy';
  private tabBtns = new Map<BuildTab, HTMLButtonElement>();
  private buildBtns = new Map<BuildingType, HTMLButtonElement>();
  private unitBtns = new Map<BuyableUnit, HTMLButtonElement>();
  private upd: ((s: GameState, me: Player) => void)[] = [];
  private lastTroops = -1;
  private lastGold = -1;
  private revealed = { iron: false, oil: false, science: false };
  /** STRIKES: barrage, bombing run, paratroopers, rocket, atom bomb (only the ones ready, reloading or aimed) */
  readonly strikes: StrikeBar;

  constructor(private ctx: HudCtx) {
    this.el = el('div', 'cmdbar');
    this.el.dataset.test = 'command-bar';
    this.strikes = new StrikeBar(ctx);
    this.el.append(this.troops(), this.attack(), this.gold(), this.build());
  }

  /** ~5 Hz refresh. */
  update(s: GameState, me: Player): void {
    for (const f of this.upd) f(s, me);
    this.strikes.update(s, me);
  }

  /** Every frame: selection highlight follows the build mode. */
  fast(): void {
    this.strikes.fast();
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
      b.tabIndex = id === t ? 0 : -1;
    }
    for (const [b, button] of this.buildBtns) button.dataset.tab = BUILD_TAB_OF[b] === t ? 'cur' : 'other';
    for (const [, button] of this.unitBtns) button.dataset.tab = t === 'military' ? 'cur' : 'other';
    this.ctx.refreshSoon();
  }

  // ------------------------------------------------------------------------------------------ troops

  private troops(): HTMLElement {
    const box = el('section', 'cb-sec cb-troops');
    box.dataset.test = 'troops';
    const head = el('div', 'cb-head');
    const trend = el('span', 'cb-trend');
    head.append(el('span', 'cb-lab', 'Troops'), trend);
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
      trend.replaceChildren(iconSpan(lineIcon(g >= 0 ? 'up' : 'down', 11, 2.2), 'ico'), el('span', '', `${fmtRate(g)}/s`));
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
          `\nMore land, Cities and Farms raise the cap. Click for your army (U).`,
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
    const sub = el('span', 'cb-sub');
    head.append(el('span', 'cb-lab', 'Attack'), sub);
    const row = el('div', 'cb-step');
    const set = (v: number) => {
      ui.attackShare = Math.max(0.05, Math.min(1, Math.round(v * 20) / 20));
      this.ctx.refreshSoon();
    };
    const minus = el('button', 'stepper');
    minus.type = 'button';
    minus.append(iconSpan(lineIcon('minus', 14, 2.2)));
    minus.setAttribute('aria-label', 'Send less ([)');
    minus.addEventListener('click', () => set(ui.attackShare - 0.05));
    const plus = el('button', 'stepper');
    plus.type = 'button';
    plus.append(iconSpan(lineIcon('plus', 14, 2.2)));
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
    box.append(head, row, range);
    setTip(box, 'Attack: the share of your troops each click sends ( [ and ] ).\nSending more than the defender has at home loses fewer troops per tile.');
    let last = -1;
    this.upd.push((_s, me) => {
      const v = Math.round(ui.attackShare * 100);
      syncSlider(range, v);
      setText(val, `${v}%`);
      if (last >= 0 && v !== last) flash(val, 'flash-key');
      last = v;
      setText(sub, formatCount(troopSum(troopsToSend(me, ui))));
    });
    return box;
  }

  // ------------------------------------------------------------------------------------------ gold + resources chip

  private gold(): HTMLElement {
    const box = el('section', 'cb-sec cb-gold');
    const head = el('div', 'cb-head');
    const rate = el('span', 'cb-rate');
    head.append(el('span', 'cb-lab', 'Gold'), rate);
    const read = el('div', 'cb-read');
    const big = el('span', 'cb-big gold');
    read.append(big);
    // iron / oil / science: one small chip (their icons) that opens a little list on hover or focus
    const res = el('button', 'res hidden');
    res.type = 'button';
    res.dataset.test = 'resources';
    res.setAttribute('aria-label', 'Iron, oil and science');
    const icons = el('span', 'res-ics');
    const pop = el('span', 'res-pop');
    pop.setAttribute('role', 'tooltip');
    res.append(icons, pop);
    res.addEventListener('click', (e) => {
      e.stopPropagation();
      this.ctx.openDrawer('research', true);
    });
    const chip = (name: 'iron' | 'oil' | 'science', tip: string) => {
      const ic = iconSpan(lineIcon(name, 12, 1.9), `ico res-i r-${name}`);
      icons.append(ic);
      const c = el('span', 'chip');
      c.dataset.test = `chip-${name}`;
      const v = el('span', 'chip-v');
      const t = el('span', 'chip-t', tip);
      c.append(iconSpan(lineIcon(name, 13, 1.8)), v, t);
      pop.append(c);
      return { ic, c, v };
    };
    const iron = chip('iron', 'iron: armor, artillery, military buildings');
    const oil = chip('oil', 'oil: armor and aircraft');
    const sci = chip('science', 'science: research (click)');
    read.append(res);
    box.append(head, read);
    setTip(big, 'Gold: a base income plus land and cities; Markets add more. Buildings and research cost gold.');
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
      const showSci = this.revealed.science && researchRule(s) === null;
      setVisible(iron.ic, this.revealed.iron);
      setVisible(iron.c, this.revealed.iron);
      setVisible(oil.ic, this.revealed.oil);
      setVisible(oil.c, this.revealed.oil);
      setVisible(sci.ic, showSci);
      setVisible(sci.c, showSci);
      setVisible(res, this.revealed.iron || this.revealed.oil || showSci);
      setText(iron.v, formatCount(me.iron));
      setText(oil.v, formatCount(me.oil));
      setText(sci.v, me.researching ? `${Math.round((me.researchProgress / TECHS[me.researching].science) * 100)}%` : formatCount(me.science));
      // a resource that runs dry gets a red icon even while the list is closed
      setClass(oil.ic, 'low', this.revealed.oil && me.oil < 1 && me.troops.armor > 0);
    });
    return box;
  }

  // ------------------------------------------------------------------------------------------ build bar

  private build(): HTMLElement {
    const box = el('section', 'cb-sec cb-build');
    const tabs = el('div', 'tabs');
    tabs.setAttribute('role', 'tablist');
    tabs.setAttribute('aria-label', 'Build categories');
    for (const t of BUILD_TABS) {
      const b = el('button', 'tab');
      b.type = 'button';
      b.setAttribute('role', 'tab');
      b.setAttribute('aria-label', t.label);
      b.dataset.test = `tab-${t.id}`;
      b.dataset.tip = TAB_TIP[t.id];
      b.append(iconSpan(lineIcon(TAB_ICON[t.id], 13, 1.9)));
      b.addEventListener('click', () => this.setTab(t.id));
      b.addEventListener('keydown', (e) => {
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight' && e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
        e.preventDefault();
        e.stopPropagation();
        const k = BUILD_TABS.findIndex((x) => x.id === this.tab);
        const n = BUILD_TABS[(k + (e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? BUILD_TABS.length - 1 : 1)) % BUILD_TABS.length].id;
        this.setTab(n);
        this.tabBtns.get(n)?.focus();
      });
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
      b.append(iconSpan(worldGlyph(type, 22), 'bb-ic'));
      b.addEventListener('click', () => {
        const m = this.ctx.ui.mode;
        this.ctx.ui.mode = m.kind === 'build' && m.building === type ? { kind: 'none' } : { kind: 'build', building: type };
        this.ctx.ui.contextMenu = null;
      });
      this.buildBtns.set(type, b);
      row.append(b);
      this.upd.push((s, me) => {
        const c = buildingCost(s, me.id, type);
        const reason = buildReason(s, me, type);
        setClass(b, 'disabled', reason !== '');
        setVisible(b, techNear(me, info.tech) && buildingAllowed(s, type) && b.dataset.tab === 'cur');
        const owned = countBuildings(s, me.id, type, true);
        const lv = maxLevel(type);
        const tx = buildingTexts(mods(s).noNukes, type, info.description);
        setTip(
          b,
          `${info.name}  [${info.hotkey}]  ${formatCount(c.gold)} gold${c.iron ? ` + ${formatCount(c.iron)} iron` : ''}\n${tx.short}.\n${tx.description}` +
            `\nBuilds in ${fmtSeconds(buildSeconds(s, info.buildTime))}` +
            (owned ? `. You have ${owned}` : '') +
            (lv > 1 ? `. Build on one of yours to upgrade it (up to level ${lv})` : '') +
            (reason ? `\n${reason}` : ''),
        );
      });
    }
    // units for sale (Military tab): a literal picture with a small "unit" corner, built at the best port / airfield
    for (const kind of BUYABLE_UNITS) {
      const b = el('button', 'bb unit');
      b.type = 'button';
      b.dataset.test = `buy-${kind}`;
      b.setAttribute('aria-label', `Build a ${UNITS[kind].name}`);
      const img = el('img', 'bb-img');
      img.alt = '';
      img.width = 24;
      img.height = 24;
      img.draggable = false;
      try {
        img.src = iconDataUrl(kind, 24);
      } catch {
        /* no canvas (tests) */
      }
      b.append(img, iconSpan(lineIcon('lock', 10, 2.2), 'bb-lock'));
      b.addEventListener('click', () => {
        b.blur();
        const s = this.ctx.state();
        const me = this.ctx.me();
        if (!s || !me) return;
        const why = buildUnit(s, me, (a) => this.ctx.dispatch(a), kind, { x: this.ctx.camera.x, y: this.ctx.camera.y });
        if (why) {
          this.ctx.toast(`${UNITS[kind].name}: ${why}`, 'info');
          this.ctx.sound('uiError');
        } else if (kind === 'warship') this.ctx.toast('Warship launched. Click it (or Forces, Y) to select it, then click water to move it.', 'good');
        else this.ctx.toast(`${UNITS[kind].name} ready at your Airfield. ${kind === 'bomber' ? 'Press X to send it on a bombing run.' : 'It guards the sky around the Airfield.'}`, 'good');
        this.ctx.refreshSoon();
      });
      this.unitBtns.set(kind, b);
      row.append(b);
      this.upd.push((s, me) => {
        const st = unitBuildStatus(s, me, kind, { x: this.ctx.camera.x, y: this.ctx.camera.y });
        setVisible(b, st.allowed && b.dataset.tab === 'cur');
        setClass(b, 'locked', st.locked);
        setClass(b, 'disabled', !st.ok);
        const t = UNIT_TEXT[kind];
        setTip(b, `${t.name}  ${priceText(kind)}\n${t.what}\nCounter: ${t.counter}\n${st.ok ? st.line : (st.locked ? 'Locked: ' : '') + st.line}`);
      });
    }
    box.append(tabs, row, this.strikes.el);
    this.setTab('economy');
    return box;
  }
}
