// Research panel (hotkey T): two tabs. RESEARCH holds the stat / effect techs (Economy, Land, Logistics, Influence
// rows), ARSENAL the vehicle side (Navy, Armor, Air, Shared rows from sim/arsenal.ts: the variant forks, special
// upgrades and masteries, with a "Mastery 1 of 2" counter). Tab (or 1 / 2) switches tabs while the panel is open.
// Each tab is one TechRowsView (hud/arsenalPage.ts; layout in hud/techRows.ts): a row per group, left to right by
// tier, thin lines from prerequisites, forks as a split with OR, the next affordable card flagged, filter chips per
// row, and the card itself buys the tech. The footer explains the hovered / focused card in full.
// Research-tab techs cost gold to start and science to finish, one at a time. Arsenal items are bought with gold plus
// iron or oil and delivered after a short timer (sim/procurement.ts, hud/procure.ts); several can be on order at once:
// on the Arsenal tab the header lists the orders with a countdown bar each.
import { researchRule } from '../../sim/rules';
import { BUILDINGS, TECHS } from '../../sim/config';
import { MASTERY_CAP, PILLAR_NAMES, arsenalItem } from '../../sim/arsenal';
import { canResearch, hasTech } from '../../sim/tech';
import { choiceWarning, groupName, techStatus, techStatusReason } from '../../sim/techtree';
import type { BuildingType, GameState, Player, TechId } from '../../sim/types';
import { formatCount } from '../render/common';
import { el, pct, setClass, setText, type DrawerId, type HudCtx } from './dom';
import { seg2, type DrawerPage } from './drawers';
import { iconSpan, lineIcon, worldGlyph } from './glyph';
import { aBuilding, arsenalCard, ordersOf, type Order } from './procure';
import { BRANCH_TECH_ICON, BRANCH_TECH_LINE } from './techFork';
import { TechRowsView } from './arsenalPage';
import { formatEta, masteryCounter, nextAffordable, panelLayout, researchEta, tabOf, type PanelTab, type RowId } from './techRows';

/** One line per arsenal tech (variants, specials, masteries). */
export const ARSENAL_TECH_LINE: Partial<Record<TechId, string>> = {
  destroyers: 'Fast warships that hunt submarines',
  battleships: 'Tough ships, long-range coastal shelling',
  submarines: 'Hidden raiders of trade and transports',
  carriers: 'A moving airfield; shoots down planes',
  lightTanks: 'Fast divisions, deep thin spearheads',
  heavyTanks: 'Slow divisions that break forts',
  deepRaids: 'Light spearheads deeper and faster',
  siegeTanks: 'Heavy spearheads knock out forts',
  groundAttack: 'Front support strikes hit 60% harder',
  heavyBombers: 'Raids 70% harder and farther',
  jetEngines: 'Faster planes, tougher bombers',
  strategicBombing: 'Wider bombs that burn their economy',
  mechInfantry: 'Land your spearheads take holds',
  reconPlanes: 'Reveal armies, doctrines, buildings',
  navalMastery: 'Veteran fleets, longer reach, +2 ships',
  armorMastery: 'Encirclements trap bigger pockets',
  airMastery: 'Every air wing flies 50% more bombers',
  amphibiousTanks: 'Divisions cross straits and rivers',
  earlyWarning: 'Spot submarines and planes sooner',
  navalMines: 'Mined waters around your ports',
  dropTanks: 'Air wings reach 60% farther',
  nightBombing: 'Bombers dodge SAMs but hit less',
};

/** One line per tech on what it gives (the config description has the numbers; it shows in the footer). */
export const TECH_LINE: Record<TechId, string> = {
  agriculture: 'Farms grow troops 50% faster',
  metallurgy: 'More iron; cheaper armor and artillery',
  logistics: 'Wider supply, faster attacks',
  fortification: 'Forts 2.5x stronger and wider',
  navigation: 'Unlocks warships; faster transports',
  banking: '+30% gold; better markets',
  medicine: 'Unlocks Hospitals; faster troop growth',
  mechanization: 'Armor +25% attack and defence',
  ballistics: 'Artillery +30%; longer barrages',
  flight: 'Unlocks Airfield, bombers and paratroopers',
  industrialization: 'Factories and arsenals twice as fast',
  combinedArms: '+20% attack with a mixed army',
  radar: 'Unlocks SAM sites; wider watchtowers',
  rocketry: 'Unlocks Missile Silo and rockets',
  nuclearFission: 'Unlocks the atom bomb',
  ...BRANCH_TECH_LINE,
  ...ARSENAL_TECH_LINE,
} as Record<TechId, string>;

const ARSENAL_ICON: Partial<Record<TechId, () => string>> = {
  destroyers: () => lineIcon('warship', 20),
  battleships: () => lineIcon('barrage', 20),
  submarines: () => lineIcon('eye', 20),
  carriers: () => lineIcon('plane', 20),
  lightTanks: () => lineIcon('expand', 20),
  heavyTanks: () => lineIcon('shield', 20),
  deepRaids: () => lineIcon('chevronRight', 20),
  siegeTanks: () => worldGlyph('fort', 20),
  groundAttack: () => lineIcon('target', 20),
  heavyBombers: () => lineIcon('bomb', 20),
  mechInfantry: () => lineIcon('troops', 20),
  reconPlanes: () => lineIcon('eye', 20),
  navalMastery: () => lineIcon('star', 20),
  armorMastery: () => lineIcon('star', 20),
  airMastery: () => lineIcon('star', 20),
  amphibiousTanks: () => lineIcon('transport', 20),
  earlyWarning: () => lineIcon('signal', 20),
  navalMines: () => lineIcon('target', 20),
  dropTanks: () => lineIcon('expand', 20),
  nightBombing: () => lineIcon('eye', 20),
};

const TECH_ICON = {
  agriculture: () => worldGlyph('farm', 20),
  metallurgy: () => worldGlyph('mine', 20),
  logistics: () => worldGlyph('supplyDepot', 20),
  fortification: () => worldGlyph('fort', 20),
  navigation: () => lineIcon('warship', 20),
  banking: () => worldGlyph('market', 20),
  medicine: () => worldGlyph('hospital', 20),
  mechanization: () => worldGlyph('factory', 20),
  ballistics: () => worldGlyph('arsenal', 20),
  flight: () => worldGlyph('airfield', 20),
  industrialization: () => lineIcon('build', 20),
  combinedArms: () => lineIcon('army', 20),
  radar: () => worldGlyph('sam', 20),
  rocketry: () => worldGlyph('silo', 20),
  nuclearFission: () => lineIcon('atom', 20),
  ...BRANCH_TECH_ICON,
  ...ARSENAL_ICON,
} as Record<TechId, () => string>;
const iconOf = (t: TechId): string => (TECH_ICON[t] ?? (() => lineIcon('science', 20)))();
const lineOf = (t: TechId): string => TECH_LINE[t] ?? TECHS[t].description;

/** Buildings each tech unlocks. */
const UNLOCKS: Partial<Record<TechId, BuildingType[]>> = {};
for (const b of Object.keys(BUILDINGS) as BuildingType[]) {
  const t = BUILDINGS[b].tech;
  if (t) (UNLOCKS[t] ??= []).push(b);
}

const TABS: { id: PanelTab; label: string; key: string }[] = [
  { id: 'research', label: 'Research', key: '1' },
  { id: 'arsenal', label: 'Arsenal', key: '2' },
];

export class ResearchPage implements DrawerPage {
  id: DrawerId = 'research';
  title = 'Research';
  root = el('div', 'page rp-page');
  private upd: ((s: GameState, me: Player) => void)[] = [];
  private views: Record<PanelTab, TechRowsView>;
  private tab: PanelTab = 'research';
  private filters: Record<PanelTab, Set<RowId>> = { research: new Set(), arsenal: new Set() };
  private tabBtns = new Map<PanelTab, { b: HTMLButtonElement; dot: HTMLElement }>();
  private chipBox: HTMLElement;
  /** the Arsenal tab's orders strip (in place of the research progress) */
  private ordersBox: HTMLElement;
  private orderEls = new Map<TechId, { root: HTMLElement; fill: HTMLElement; left: HTMLElement }>();
  private mastery: HTMLElement;
  private focus: TechId | null = null;
  private footT: HTMLElement;
  private footD: HTMLElement;
  private footN: HTMLElement;
  private last: { s: GameState; me: Player } | null = null;
  private ro: ResizeObserver | null = null;
  /** a click on another tech while one is in progress: the second click within a few seconds switches */
  private switchAsk: { t: TechId; until: number } | null = null;

  constructor(private ctx: HudCtx) {
    // header: the two tabs, what is being researched (or science stored), Auto / Manual
    const head = el('div', 'rp-head');
    const tabs = el('div', 'rp-tabs');
    tabs.setAttribute('role', 'tablist');
    tabs.setAttribute('aria-label', 'Research panel');
    for (const t of TABS) {
      const b = el('button', 'rp-tab');
      b.type = 'button';
      b.dataset.test = `tab-${t.id}`;
      b.setAttribute('role', 'tab');
      const dot = el('span', 'rp-tab-dot');
      b.append(el('span', 'rp-tab-l', t.label), dot, el('kbd', 'rp-tab-k', t.key));
      b.dataset.tip = `${t.label}  (${t.key} or Tab)`;
      b.addEventListener('click', () => this.setTab(t.id));
      tabs.append(b);
      this.tabBtns.set(t.id, { b, dot });
    }
    const cur = el('div', 'rt-cur rp-cur');
    const cv = el('span', 'rt-cur-v');
    const cl = el('span', 'rt-cur-l');
    const bar = el('div', 'pbar thin');
    const fill = el('span');
    bar.append(fill);
    cur.append(cv, cl, bar);
    const autoSeg = seg2(
      'Auto',
      'Manual',
      () => ctx.act({ type: 'setAuto', research: true }),
      () => ctx.act({ type: 'setAuto', research: false }),
    );
    autoSeg.el.dataset.test = 'auto-research';
    autoSeg.el.classList.add('rt-auto', 'rp-auto');
    // filter chips (per row of the tab)
    this.chipBox = el('div', 'rp-chips');
    this.chipBox.setAttribute('role', 'group');
    this.chipBox.setAttribute('aria-label', 'Show rows');
    this.ordersBox = el('div', 'rp-orders');
    this.ordersBox.dataset.test = 'arsenal-orders';
    this.ordersBox.setAttribute('aria-label', 'On order');
    head.append(tabs, this.chipBox, cur, this.ordersBox, autoSeg.el);
    this.root.append(head);
    this.upd.push((s, me) => {
      const rule = researchRule(s);
      const ars = this.tab === 'arsenal';
      setClass(cur, 'hidden', ars);
      setClass(this.ordersBox, 'hidden', !ars);
      if (ars) this.updateOrders(s, me);
      setClass(autoSeg.el, 'hidden', !!rule || ars);
      setClass(bar, 'hidden', !!rule || !me.researching);
      const c = me.researching ? TECHS[me.researching] : null;
      if (rule) {
        setText(cv, rule);
        setText(cl, '');
      } else if (c) {
        setText(cv, c.name);
        const left = me.income.science > 0 ? (c.science - me.researchProgress) / me.income.science : null;
        setText(cl, `${pct(me.researchProgress / c.science)} · ${formatEta(left)} left · +${me.income.science.toFixed(1)} science/s`);
        fill.style.width = pct(Math.min(1, me.researchProgress / c.science));
      } else {
        setText(cv, `${formatCount(me.science)} science`);
        setText(cl, `+${me.income.science.toFixed(1)}/s · ${me.auto.research ? 'auto picks the next tech' : 'pick a tech'}`);
      }
      autoSeg.set(!!me.auto.research);
    });

    // the two tabs' rows
    const hooks = (tab: PanelTab) => ({
      icon: iconOf,
      line: lineOf,
      focus: (t: TechId | null) => {
        if (this.tab !== tab) return;
        this.focus = t;
        if (this.last) this.updateFoot(this.last.s, this.last.me);
      },
      pick: (t: TechId) => this.pick(t),
    });
    this.views = { research: new TechRowsView(panelLayout('research'), hooks('research')), arsenal: new TechRowsView(panelLayout('arsenal'), hooks('arsenal')) };
    // the Arsenal's Mastery column header is the "Mastery 1 of 2" counter
    this.mastery = this.views.arsenal.heads.get('4') ?? el('span');
    this.mastery.classList.add('rp-mastery');
    this.mastery.dataset.test = 'mastery-count';
    const body = el('div', 'rp-body');
    body.append(this.views.research.root, this.views.arsenal.root);
    this.root.append(body);

    // footer: the hovered / focused card in full, else a hint
    const foot = el('div', 'rt-foot rp-foot');
    this.footT = el('div', 'rt-foot-t');
    this.footD = el('div', 'rt-foot-d');
    this.footN = el('div', 'rt-foot-n');
    foot.append(this.footT, this.footD, this.footN);
    this.root.append(foot);
    this.upd.push((s, me) => this.updateViews(s, me));

    // Tab, Shift+Tab, 1 and 2 switch tabs while the panel is open (before the map's hotkeys see them)
    window.addEventListener(
      'keydown',
      (e) => {
        if (!this.isOpen() || e.ctrlKey || e.metaKey || e.altKey) return;
        const tgt = e.target as HTMLElement | null;
        if (tgt && (tgt.tagName === 'INPUT' || tgt.tagName === 'TEXTAREA' || tgt.isContentEditable)) return;
        let to: PanelTab | null = null;
        if (e.key === 'Tab') to = this.tab === 'research' ? 'arsenal' : 'research';
        else if (!e.shiftKey && (e.code === 'Digit1' || e.code === 'Numpad1')) to = 'research';
        else if (!e.shiftKey && (e.code === 'Digit2' || e.code === 'Numpad2')) to = 'arsenal';
        if (!to) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        if (e.repeat) return;
        const inside = this.root.contains(document.activeElement);
        this.setTab(to);
        if (inside || e.key === 'Tab') this.views[to].focusFirst();
      },
      true,
    );
    this.setTab('research');
  }

  private isOpen(): boolean {
    return this.root.isConnected && !this.root.closest('.hidden');
  }

  /** Shows a tab ('research' or 'arsenal'). */
  setTab(tab: PanelTab): void {
    this.tab = tab;
    for (const [id, { b }] of this.tabBtns) {
      setClass(b, 'on', id === tab);
      b.setAttribute('aria-selected', String(id === tab));
    }
    setClass(this.views.research.root, 'hidden', tab !== 'research');
    setClass(this.views.arsenal.root, 'hidden', tab !== 'arsenal');
    this.root.dataset.tab = tab;
    this.buildChips();
    this.focus = null;
    this.views[tab].invalidate();
    if (this.last) this.update(this.last.s, this.last.me);
    else requestAnimationFrame(() => this.views[tab].draw());
  }
  get currentTab(): PanelTab {
    return this.tab;
  }
  /** Opens the tab that holds t (the advisor's "research Navigation" lands on the Arsenal). */
  showTech(t: TechId): void {
    this.setTab(tabOf(t));
  }

  private buildChips(): void {
    const lay = this.views[this.tab].layout;
    const f = this.filters[this.tab];
    const chips: HTMLElement[] = [];
    const mk = (label: string, on: boolean, run: () => void, test: string): void => {
      const c = el('button', `rp-chip${on ? ' on' : ''}`, label);
      c.type = 'button';
      c.dataset.test = test;
      c.setAttribute('aria-pressed', String(on));
      c.addEventListener('click', run);
      chips.push(c);
    };
    mk('All', f.size === 0, () => this.setFilter(null), 'chip-all');
    for (const r of lay.rows) mk(r.name, f.has(r.id), () => this.setFilter(r.id), `chip-${r.id}`);
    this.chipBox.replaceChildren(...chips);
    this.views[this.tab].filter(f);
  }
  private setFilter(id: RowId | null): void {
    const f = this.filters[this.tab];
    const only = id !== null && !(f.size === 1 && f.has(id));
    f.clear();
    if (only && id) f.add(id);
    this.buildChips();
    if (this.last) this.update(this.last.s, this.last.me);
  }

  onOpen(): void {
    this.views.research.invalidate();
    this.views.arsenal.invalidate();
    if (!this.ro && typeof ResizeObserver !== 'undefined') {
      this.ro = new ResizeObserver(() => {
        this.views[this.tab].draw();
      });
      this.ro.observe(this.root);
    }
    requestAnimationFrame(() => this.views[this.tab].draw());
  }

  /** The Arsenal header: each order with its name, a countdown bar and the seconds left (soonest first). */
  private updateOrders(s: GameState, me: Player): void {
    const orders = ordersOf(s, me);
    const seen = new Set<TechId>();
    const kids: HTMLElement[] = [];
    if (!orders.length) {
      kids.push(el('span', 'rp-orders-none', 'Nothing on order · items arrive 20-45 s after you buy'));
    } else {
      kids.push(el('span', 'rp-orders-l', `On order (${orders.length})`));
      for (const o of orders) {
        seen.add(o.tech);
        let e = this.orderEls.get(o.tech);
        if (!e) {
          const root = el('span', 'rp-order');
          root.dataset.test = `order-${o.tech}`;
          const bar = el('span', 'rp-order-bar');
          const fill = el('span');
          bar.append(fill);
          const left = el('span', 'rp-order-t');
          root.append(iconSpan(iconOf(o.tech), 'rp-order-ic'), el('span', 'rp-order-n', TECHS[o.tech].name), bar, left);
          e = { root, fill, left };
          this.orderEls.set(o.tech, e);
        }
        this.setOrder(e, o);
        kids.push(e.root);
      }
    }
    for (const t of [...this.orderEls.keys()]) if (!seen.has(t)) this.orderEls.delete(t);
    const same = kids.length === this.ordersBox.children.length && kids.every((k, i) => this.ordersBox.children[i] === k);
    if (!same) this.ordersBox.replaceChildren(...kids);
  }
  private setOrder(e: { root: HTMLElement; fill: HTMLElement; left: HTMLElement }, o: Order): void {
    e.fill.style.width = pct(o.frac);
    setText(e.left, formatEta(o.left));
    e.root.setAttribute('aria-label', `${TECHS[o.tech].name}: arrives in ${formatEta(o.left)}`);
  }

  private pick(t: TechId): void {
    const s = this.ctx.state();
    const me = this.ctx.me();
    if (!s || !me) return;
    if (tabOf(t) === 'arsenal') {
      // Arsenal: bought at once (gold + iron / oil), delivered after a timer; several can be on order
      const a = arsenalCard(s, me, t);
      if (a.state === 'done' || a.state === 'ordered') return;
      if (a.state !== 'buy') {
        this.ctx.toast(`${TECHS[t].name}: ${a.reason || 'not possible now'}`, 'info');
        this.ctx.sound('uiError');
        return;
      }
      this.ctx.act({ type: 'procure', tech: t });
      return;
    }
    if (hasTech(me, t) || me.researching === t) return;
    const r = canResearch(s, me.id, t);
    if (!r.ok) {
      this.ctx.toast(`${TECHS[t].name}: ${r.reason ?? 'not possible now'}`, 'info');
      this.ctx.sound('uiError');
      return;
    }
    // switching drops the current tech's progress (and frees its fork): ask for a second click first
    if (me.researching && me.researching !== t && me.researchProgress > 0) {
      const now = performance.now();
      if (!this.switchAsk || this.switchAsk.t !== t || now > this.switchAsk.until) {
        this.switchAsk = { t, until: now + 4000 };
        const pctDone = Math.floor((me.researchProgress / TECHS[me.researching].science) * 100);
        this.ctx.toast(`Click ${TECHS[t].name} again to switch: ${TECHS[me.researching].name} (${pctDone}%) loses its progress and gold`, 'info');
        return;
      }
    }
    this.switchAsk = null;
    this.ctx.act({ type: 'research', tech: t });
  }

  private updateViews(s: GameState, me: Player): void {
    this.last = { s, me };
    for (const tab of ['research', 'arsenal'] as const) {
      const v = this.views[tab];
      const next = nextAffordable(s, me, v.layout, this.filters[tab]);
      if (tab === this.tab) v.update(s, me, next);
      // a dot on the other tab when something there can be bought now
      const any = tab === this.tab ? null : nextAffordable(s, me, v.layout);
      const { dot } = this.tabBtns.get(tab)!;
      setClass(dot, 'on', !!any);
      dot.dataset.tip = any ? `${TECHS[any].name} can be ${tab === 'arsenal' ? 'bought' : 'researched'} now` : '';
    }
    const m = masteryCounter(me);
    setText(this.mastery, m.text.replace(' · ', ': '));
    setClass(this.mastery, 'full', m.full);
    this.mastery.dataset.tip = m.full
      ? `Mastery upgrades in at most ${MASTERY_CAP} pillars per game: the others are locked`
      : `Mastery upgrades (the last card of Navy, Armor and Air) in at most ${MASTERY_CAP} pillars per game`;
    this.updateFoot(s, me);
  }

  private updateFoot(s: GameState, me: Player): void {
    const t = this.focus;
    if (!t) {
      setText(this.footT, researchRule(s) ? '' : this.tab === 'research' ? 'Research: economy, land, logistics and influence' : 'Arsenal: navy, armor and air paths');
      setText(
        this.footD,
        this.tab === 'research'
          ? 'Lines run from each tech to what it unlocks; "+ Name" is a prerequisite in another row or tab. OR marks a choice: picking one locks the other for the rest of the game. A tech costs gold to start and science to finish.'
          : `Bought with gold plus iron or oil, delivered 20-45 s later, several at once. Navy needs a Port, armor a Factory, air an Airfield. One path (OR) per pillar; Masteries in ${MASTERY_CAP} pillars at most.`,
      );
      setText(this.footN, '');
      return;
    }
    if (tabOf(t) === 'arsenal') {
      this.updateArsenalFoot(s, me, t);
      return;
    }
    const info = TECHS[t];
    const g = info.exclusiveGroup;
    const it = arsenalItem(t);
    const kind = it ? (it.kind === 'special' ? ' · special upgrade' : it.kind === 'mastery' ? ' · mastery' : it.kind === 'variant' ? ` · ${PILLAR_NAMES[it.pillar]} path` : '') : '';
    setText(this.footT, `${info.name}${g ? ` · ${groupName(g)}: choose one` : kind} · ${formatCount(info.gold)} gold, ${formatCount(info.science)} science (${formatEta(researchEta(me, t))})`);
    const unl = UNLOCKS[t]?.map((b) => BUILDINGS[b].name) ?? [];
    setText(this.footD, info.description + (unl.length ? ` Unlocks: ${unl.join(', ')}.` : ''));
    let note = '';
    const st = techStatus(s, me.id, t);
    if (st === 'done') note = 'Researched.';
    else if (st === 'researching') note = `Researching: ${pct(me.researchProgress / info.science)}.`;
    else if (st === 'locked-choice' || st === 'locked-prereq' || st === 'disabled') {
      const why = techStatusReason(s, me.id, t) ?? 'Not possible now';
      const other = st === 'locked-prereq' ? [...info.requires, ...(info.requiresAny ?? [])].filter((r) => !hasTech(me, r) && tabOf(r) !== this.tab) : [];
      note = `${why}.${other.length ? ` (${other.map((r) => TECHS[r].name).join(', ')}: ${this.tab === 'research' ? 'Arsenal' : 'Research'} tab.)` : ''}`;
    } else {
      const r = canResearch(s, me.id, t);
      if (!r.ok) note = `${r.reason ?? 'Not possible now'}.`;
      else note = me.researching ? `Click to start it instead of ${TECHS[me.researching].name} (its progress is lost).` : 'Click to research it.';
      const warn = choiceWarning(t);
      if (warn) note += ` ${warn} for the rest of the game.`;
    }
    setText(this.footN, note);
  }

  /** The footer for an Arsenal card: price, delivery time, what it unlocks, and what stands in the way. */
  private updateArsenalFoot(s: GameState, me: Player, t: TechId): void {
    const info = TECHS[t];
    const g = info.exclusiveGroup;
    const it = arsenalItem(t);
    const a = arsenalCard(s, me, t);
    const p = a.price;
    const kind = it ? (it.kind === 'special' ? ' · special upgrade' : it.kind === 'mastery' ? ' · mastery' : it.kind === 'variant' ? ` · ${PILLAR_NAMES[it.pillar]} path` : '') : '';
    const cost = [`${formatCount(p.gold)} gold`, p.iron ? `${formatCount(p.iron)} iron` : '', p.oil ? `${formatCount(p.oil)} oil` : ''].filter(Boolean).join(', ');
    setText(this.footT, `${info.name}${g ? ` · ${groupName(g)}: choose one` : kind} · ${cost} · arrives ${formatEta(p.seconds)} after you buy it`);
    const unl = UNLOCKS[t]?.map((b) => BUILDINGS[b].name) ?? [];
    const needs = p.needs ? ` Needs ${aBuilding(p.needs)}.` : '';
    setText(this.footD, info.description + (unl.length ? ` Unlocks: ${unl.join(', ')}.` : '') + needs);
    let note = '';
    switch (a.state) {
      case 'done':
        note = 'In service.';
        break;
      case 'ordered':
        note = `On order: arrives in ${formatEta(a.order!.left)}.`;
        break;
      case 'building':
        note = `${a.reason}${p.needs === 'port' ? ' on your coast' : ''}, then buy it here.`;
        break;
      case 'buy': {
        note = 'Click to buy it.';
        const warn = choiceWarning(t);
        if (warn) note += ` ${warn} for the rest of the game.`;
        break;
      }
      case 'prereq': {
        const other = [...info.requires, ...(info.requiresAny ?? [])].filter((r) => !hasTech(me, r) && tabOf(r) !== 'arsenal');
        note = `${a.reason}.${other.length ? ` (${other.map((r) => TECHS[r].name).join(', ')}: Research tab.)` : ''}`;
        break;
      }
      default:
        note = `${a.reason}.`;
    }
    setText(this.footN, note.replace(/\.\.$/, '.'));
  }

  update(s: GameState, me: Player): void {
    for (const f of this.upd) f(s, me);
  }
}
