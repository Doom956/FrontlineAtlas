// Research panel (hotkey T): two tabs. RESEARCH holds the stat / effect techs (Economy, Land, Logistics, Influence
// rows), ARSENAL the vehicle side (Navy, Armor, Air, Shared rows from sim/arsenal.ts: the variant forks, special
// upgrades and masteries, with a "Mastery 1 of 2" counter). Tab (or 1 / 2) switches tabs while the panel is open.
// Each tab is one TechRowsView (hud/arsenalPage.ts; layout in hud/techRows.ts): a row per group, left to right by
// tier, plain lines from prerequisites, each fork in a "Choose one" bracket, the next affordable card flagged.
// A click on a card buys it (one click), except a choice between two paths: the first click selects it and the detail
// pane says what it rules out; a second click (or the pane's button) confirms. The detail pane (right on wide
// screens, a strip below on smaller ones, a bottom sheet on a phone) shows the hovered, focused or clicked card in
// full: description, price and what you have, what it needs, what it rules out, and the Research / Buy button.
// Research-tab techs cost gold to start and science to finish, one at a time. Arsenal items are bought with gold plus
// iron or oil and delivered after a short timer (sim/procurement.ts, hud/procure.ts); several can be on order at once:
// on the Arsenal tab the header lists the orders with a countdown bar each.
// On a phone the panel shows one row at a time (a row switcher) as a vertical list, and every purchase goes through
// the sheet's button.
import { researchRule } from '../../sim/rules';
import { BUILDINGS, TECHS } from '../../sim/config';
import { MASTERY_CAP, arsenalItem } from '../../sim/arsenal';
import { canResearch, hasTech } from '../../sim/tech';
import { choiceLockedBy, rivalsOf, techStatus, techStatusReason } from '../../sim/techtree';
import type { BuildingType, GameState, Player, TechId } from '../../sim/types';
import { formatCount } from '../render/common';
import { el, pct, setClass, setText, type DrawerId, type HudCtx } from './dom';
import { seg2, type DrawerPage } from './drawers';
import { iconSpan, lineIcon } from './glyph';
import { pixelGlyph, pixelIcon } from './pixelIcons';
import { arsenalCard, missingBuilding, ordersOf, priceOf, type Order } from './procure';
import { BRANCH_TECH_ICON, BRANCH_TECH_LINE } from './techFork';
import { TechRowsView } from './arsenalPage';
import { formatEta, masteryCapLine, masteryCounter, nextAffordable, panelLayout, researchEta, tabOf, type PanelTab, type RowId } from './techRows';

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
  banking: '+30% gold; markets reach +80% sooner',
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

/** Card pictures: pixel icons (hud/pixelIcons.ts) at `px`, like the top bar and the build bar; buildings as their map silhouette. */
const ARSENAL_ICON: Partial<Record<TechId, (px: number) => string>> = {
  destroyers: (px) => pixelIcon('warship', px),
  battleships: (px) => pixelIcon('barrage', px),
  submarines: (px) => pixelIcon('eye', px),
  carriers: (px) => pixelIcon('plane', px),
  lightTanks: (px) => pixelIcon('expand', px),
  heavyTanks: (px) => pixelIcon('shield', px),
  deepRaids: (px) => pixelIcon('chevronRight', px),
  siegeTanks: (px) => pixelGlyph('fort', px),
  groundAttack: (px) => pixelIcon('target', px),
  heavyBombers: (px) => pixelIcon('bomb', px),
  mechInfantry: (px) => pixelIcon('troops', px),
  reconPlanes: (px) => pixelIcon('eye', px),
  navalMastery: (px) => pixelIcon('star', px),
  armorMastery: (px) => pixelIcon('star', px),
  airMastery: (px) => pixelIcon('star', px),
  amphibiousTanks: (px) => pixelIcon('transport', px),
  earlyWarning: (px) => pixelIcon('signal', px),
  navalMines: (px) => pixelIcon('target', px),
  dropTanks: (px) => pixelIcon('expand', px),
  nightBombing: (px) => pixelIcon('eye', px),
};

const TECH_ICON: Partial<Record<TechId, (px: number) => string>> = {
  agriculture: (px) => pixelGlyph('farm', px),
  metallurgy: (px) => pixelGlyph('mine', px),
  logistics: (px) => pixelIcon('transport', px),
  fortification: (px) => pixelGlyph('fort', px),
  navigation: (px) => pixelIcon('warship', px),
  banking: (px) => pixelGlyph('market', px),
  medicine: (px) => pixelGlyph('hospital', px),
  mechanization: (px) => pixelGlyph('factory', px),
  ballistics: (px) => pixelGlyph('arsenal', px),
  flight: (px) => pixelGlyph('airfield', px),
  industrialization: (px) => pixelIcon('build', px),
  combinedArms: (px) => pixelIcon('army', px),
  radar: (px) => pixelGlyph('sam', px),
  rocketry: (px) => pixelGlyph('silo', px),
  nuclearFission: (px) => pixelIcon('atom', px),
  ...BRANCH_TECH_ICON,
  ...ARSENAL_ICON,
};
/** A tech's card picture at `px` (20 on the cards and in the detail pane, 16 on the order chips). */
const iconOf = (t: TechId, px = 20): string => (TECH_ICON[t] ?? ((n: number) => pixelIcon('science', n)))(px);
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
/** How long a first click on a "choose one" card waits for the second (like switching research). */
const CONFIRM_MS = 4000;
const PHONE = '(max-width: 640px)';
const OK = pixelIcon('accept', 12);
const NO = pixelIcon('close', 12);

type Fact = [label: string, html: string];

export class ResearchPage implements DrawerPage {
  id: DrawerId = 'research';
  title = 'Research';
  root = el('div', 'page rp-page');
  private upd: ((s: GameState, me: Player) => void)[] = [];
  private views: Record<PanelTab, TechRowsView>;
  private tab: PanelTab = 'research';
  /** the phone's row switcher: one row of the tab at a time */
  private body: HTMLElement | null = null;
  private phoneRow: Record<PanelTab, RowId | null> = { research: null, arsenal: null };
  private tabBtns = new Map<PanelTab, { b: HTMLButtonElement; dot: HTMLElement }>();
  private chipBox: HTMLElement;
  /** the Arsenal tab's orders strip (in place of the research progress) */
  private ordersBox: HTMLElement;
  private orderEls = new Map<TechId, { root: HTMLElement; fill: HTMLElement; left: HTMLElement }>();
  private ordersMore: HTMLElement;
  private mastery: HTMLElement;
  /** hovered / keyboard-focused card, and the card the detail pane is pinned to (clicked) */
  private focus: TechId | null = null;
  private sel: TechId | null = null;
  private det: { root: HTMLElement; empty: HTMLElement; card: HTMLElement; ic: HTMLElement; name: HTMLElement; state: HTMLElement; desc: HTMLElement; facts: HTMLElement; note: HTMLElement; go: HTMLButtonElement; why: HTMLElement; icKey?: TechId; factsKey?: string };
  private last: { s: GameState; me: Player } | null = null;
  private ro: ResizeObserver | null = null;
  private mq: MediaQueryList | null = typeof matchMedia === 'function' ? matchMedia(PHONE) : null;
  /** a click on another tech while one is in progress: the second click within a few seconds switches */
  private switchAsk: { t: TechId; until: number } | null = null;
  /** a first click on a "choose one" card: the second click (or the detail pane's button) confirms */
  private forkAsk: { t: TechId; until: number } | null = null;

  constructor(private ctx: HudCtx) {
    // header: the two tabs, one status slot (what is being researched, or the orders), Auto / Manual
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
      b.append(el('span', 'rp-tab-l', t.label), dot);
      b.dataset.tip = t.label;
      b.addEventListener('click', () => this.setTab(t.id));
      tabs.append(b);
      this.tabBtns.set(t.id, { b, dot });
    }
    const cur = el('div', 'rp-cur');
    const ck = el('span', 'rp-cur-k', 'Researching');
    const cv = el('span', 'rp-cur-v');
    const cl = el('span', 'rp-cur-l');
    const bar = el('span', 'rp-cur-bar');
    const fill = el('span');
    bar.append(fill);
    cur.append(ck, cv, bar, cl);
    const autoSeg = seg2(
      'Auto',
      'Manual',
      () => ctx.act({ type: 'setAuto', research: true }),
      () => ctx.act({ type: 'setAuto', research: false }),
    );
    autoSeg.el.dataset.test = 'auto-research';
    autoSeg.el.classList.add('rp-auto');
    autoSeg.el.dataset.tip = 'Auto: the next tech is picked for you when one finishes';
    this.ordersBox = el('div', 'rp-orders');
    this.ordersBox.dataset.test = 'arsenal-orders';
    this.ordersBox.setAttribute('aria-label', 'On order');
    this.ordersMore = el('span', 'rp-orders-more');
    head.append(tabs, cur, this.ordersBox, autoSeg.el);
    // the phone's row switcher (one row at a time; every row fits on a wider screen)
    this.chipBox = el('div', 'rp-chips');
    this.chipBox.setAttribute('role', 'group');
    this.chipBox.setAttribute('aria-label', 'Row');
    this.root.append(head, this.chipBox);
    this.upd.push((s, me) => {
      const rule = researchRule(s);
      const ars = this.tab === 'arsenal';
      setClass(cur, 'hidden', ars);
      setClass(this.ordersBox, 'hidden', !ars);
      if (ars) this.updateOrders(s, me);
      setClass(autoSeg.el, 'hidden', !!rule || ars);
      const c = me.researching ? TECHS[me.researching] : null;
      setClass(cur, 'on', !rule && !!c);
      if (rule) {
        setText(cv, rule);
        setText(cl, '');
      } else if (c) {
        setText(cv, c.name);
        const left = me.income.science > 0 ? (c.science - me.researchProgress) / me.income.science : null;
        setText(cl, `${pct(me.researchProgress / c.science)} · ${formatEta(left)} left`);
        fill.style.width = pct(Math.min(1, me.researchProgress / c.science));
      } else {
        setText(cv, `${formatCount(me.science)} science`);
        setText(cl, `+${me.income.science.toFixed(1)} a second · ${me.auto.research ? 'Auto picks the next tech' : 'pick a tech'}`);
      }
      autoSeg.set(!!me.auto.research);
    });

    // the two tabs' rows
    const hooks = (tab: PanelTab) => ({
      icon: iconOf,
      line: lineOf,
      focus: (t: TechId | null) => {
        if (this.tab !== tab || this.isPhone()) return;
        this.focus = t;
        if (this.last) this.updateDetail(this.last.s, this.last.me);
      },
      pick: (t: TechId) => this.pick(t),
    });
    this.views = { research: new TechRowsView(panelLayout('research'), hooks('research')), arsenal: new TechRowsView(panelLayout('arsenal'), hooks('arsenal')) };
    // the Arsenal's Mastery column header is the "Mastery 1 of 2" counter
    this.mastery = this.views.arsenal.heads.get('4') ?? el('span');
    this.mastery.classList.add('rp-mastery');
    this.mastery.dataset.test = 'mastery-count';
    const main = el('div', 'rp-main');
    const body = el('div', 'rp-body');
    this.body = body;
    body.append(this.views.research.root, this.views.arsenal.root);
    this.det = this.buildDetail();
    main.append(body, this.det.root);
    this.root.append(main);
    this.upd.push((s, me) => this.updateViews(s, me));
    this.mq?.addEventListener('change', () => {
      this.select(null);
      this.applyRows();
    });

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

  /** The detail pane: the hovered, focused or clicked card in full, with its Research / Buy button. */
  private buildDetail(): ResearchPage['det'] {
    const root = el('section', 'rp-detail');
    root.setAttribute('aria-label', 'Details');
    const empty = el('p', 'rp-d-empty', 'Pick a card to see what it does. Lines show what unlocks what.');
    const card = el('div', 'rp-d-card');
    const top = el('div', 'rp-d-top');
    const ic = el('span', 'rp-d-ic');
    const name = el('h3', 'rp-d-name');
    const state = el('span', 'rp-d-state');
    const close = el('button', 'rp-d-close');
    close.type = 'button';
    close.setAttribute('aria-label', 'Close');
    close.innerHTML = lineIcon('close', 16);
    close.addEventListener('click', () => this.select(null));
    top.append(ic, name, state, close);
    const desc = el('p', 'rp-d-desc');
    const facts = el('div', 'rp-d-facts');
    const note = el('p', 'rp-d-note');
    const act = el('div', 'rp-d-act');
    const go = el('button', 'wr-btn primary rp-d-go');
    go.type = 'button';
    go.dataset.test = 'detail-buy';
    go.addEventListener('click', () => {
      const t = this.shown();
      if (t) this.act(t, true);
    });
    const why = el('span', 'rp-d-why');
    act.append(go, why, note);
    card.append(top, desc, facts, act);
    root.append(empty, card);
    root.setAttribute('aria-live', 'polite');
    return { root, empty, card, ic, name, state, desc, facts, note, go, why };
  }

  private isOpen(): boolean {
    return this.root.isConnected && !this.root.closest('.hidden');
  }
  private isPhone(): boolean {
    return !!this.mq?.matches;
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
    this.focus = null;
    this.select(null);
    this.applyRows();
    this.views[tab].invalidate();
    if (this.last) this.update(this.last.s, this.last.me);
    else requestAnimationFrame(() => this.views[tab].draw());
    this.scrollToOpen();
  }
  get currentTab(): PanelTab {
    return this.tab;
  }
  /** Opens the tab that holds t (the advisor's "research Navigation" lands on the Arsenal). */
  showTech(t: TechId): void {
    this.setTab(tabOf(t));
  }

  /** The phone shows one row at a time (the switcher); wider screens show them all. */
  private applyRows(): void {
    const lay = this.views[this.tab].layout;
    const phone = this.isPhone();
    const row = this.phoneRow[this.tab] ?? lay.rows[0].id;
    const chips = lay.rows.map((r) => {
      const on = r.id === row;
      const c = el('button', `rp-chip${on ? ' on' : ''}`, r.name);
      c.type = 'button';
      c.dataset.test = `chip-${r.id}`;
      c.setAttribute('aria-pressed', String(on));
      c.addEventListener('click', () => {
        this.phoneRow[this.tab] = r.id;
        this.select(null);
        this.applyRows();
        if (this.last) this.update(this.last.s, this.last.me);
        this.scrollToOpen();
      });
      return c;
    });
    this.chipBox.replaceChildren(...chips);
    this.views[this.tab].filter(phone ? new Set([row]) : new Set());
  }
  private rowFilter(): ReadonlySet<RowId> {
    if (!this.isPhone()) return new Set();
    return new Set([this.phoneRow[this.tab] ?? this.views[this.tab].layout.rows[0].id]);
  }

  onOpen(): void {
    this.views.research.invalidate();
    this.views.arsenal.invalidate();
    this.select(null);
    this.markHud();
    if (!this.ro && typeof ResizeObserver !== 'undefined') {
      // also fires when the drawer closes (the page's size drops to 0)
      this.ro = new ResizeObserver(() => {
        this.markHud();
        this.views[this.tab].draw();
      });
      this.ro.observe(this.root);
    }
    requestAnimationFrame(() => {
      this.views[this.tab].draw();
      this.scrollToOpen();
    });
  }

  /**
   * Phone list: starts at the first card still open in the row (late in a game the owned ones fill the top), with its
   * tier label in view. Wider screens show every row and never scroll here.
   */
  private scrollToOpen(): void {
    const body = this.body;
    if (!body || !this.isPhone()) return;
    const grid = this.views[this.tab].root;
    const first = [...grid.querySelectorAll<HTMLElement>('.rp-card')].find((c) => c.offsetParent !== null && !c.classList.contains('done') && !c.classList.contains('off'));
    body.scrollTop = first ? Math.max(0, first.getBoundingClientRect().top - body.getBoundingClientRect().top + body.scrollTop - 34) : 0;
  }

  /** `rp-open` on the HUD while the panel is open: on a phone the guide bar folds to one line under it. */
  private markHud(): void {
    const hud = this.root.closest('.hud');
    if (hud) setClass(hud as HTMLElement, 'rp-open', this.isOpen());
  }

  /** The Arsenal header: up to three orders with a countdown bar each (soonest first), "+n" for the rest. */
  private updateOrders(s: GameState, me: Player): void {
    const orders = ordersOf(s, me);
    const seen = new Set<TechId>();
    const kids: HTMLElement[] = [];
    if (!orders.length) {
      kids.push(el('span', 'rp-orders-none', 'Nothing on order. Items arrive 20 to 45 s after you buy them.'));
    } else {
      kids.push(el('span', 'rp-orders-l', 'On order'));
      for (const o of orders.slice(0, 3)) {
        seen.add(o.tech);
        let e = this.orderEls.get(o.tech);
        if (!e) {
          const root = el('span', 'rp-order');
          root.dataset.test = `order-${o.tech}`;
          const bar = el('span', 'rp-order-bar');
          const fill = el('span');
          bar.append(fill);
          const left = el('span', 'rp-order-t');
          root.append(iconSpan(iconOf(o.tech, 16), 'rp-order-ic'), el('span', 'rp-order-n', TECHS[o.tech].name), bar, left);
          e = { root, fill, left };
          this.orderEls.set(o.tech, e);
        }
        this.setOrder(e, o);
        kids.push(e.root);
      }
      if (orders.length > 3) {
        setText(this.ordersMore, `+${orders.length - 3}`);
        this.ordersMore.dataset.tip = orders.slice(3).map((o) => `${TECHS[o.tech].name}: ${formatEta(o.left)}`).join('\n');
        kids.push(this.ordersMore);
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

  /** Pins the detail pane to t (null: back to the hovered card or the hint). */
  private select(t: TechId | null): void {
    this.sel = t;
    if (!t) this.forkAsk = null;
    this.views[this.tab].select(t);
    setClass(this.root, 'sheet-open', !!t && this.isPhone());
    if (this.last) this.updateDetail(this.last.s, this.last.me);
  }
  /** The card the detail pane shows: on a phone only the tapped one. */
  private shown(): TechId | null {
    return this.isPhone() ? this.sel : this.focus ?? this.sel;
  }

  /** Whether t is one side of a choice not made yet and could be had now (a first click only selects it). */
  private isOpenChoice(s: GameState, me: Player, t: TechId): boolean {
    if (!rivalsOf(t).length) return false;
    return tabOf(t) === 'arsenal' ? arsenalCard(s, me, t).state === 'buy' : canResearch(s, me.id, t).ok && !hasTech(me, t) && me.researching !== t;
  }

  /** A click on a card: selects it; buys / researches it at once, except a choice (a second click confirms) and on a phone (the sheet's button). */
  private pick(t: TechId): void {
    const s = this.ctx.state();
    const me = this.ctx.me();
    if (!s || !me) return;
    const now = performance.now();
    const asked = this.forkAsk && this.forkAsk.t === t && now <= this.forkAsk.until;
    this.select(t);
    if (this.isPhone()) return;
    if (this.isOpenChoice(s, me, t) && !asked) {
      this.forkAsk = { t, until: now + CONFIRM_MS };
      this.updateDetail(s, me);
      return;
    }
    this.act(t, false);
  }

  /** Buys (Arsenal) or researches t. `confirmed`: from the detail pane's button, no second click needed. */
  private act(t: TechId, confirmed: boolean): void {
    const s = this.ctx.state();
    const me = this.ctx.me();
    if (!s || !me) return;
    this.forkAsk = null;
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
      this.afterAct();
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
    if (!confirmed && me.researching && me.researching !== t && me.researchProgress > 0) {
      const now = performance.now();
      if (!this.switchAsk || this.switchAsk.t !== t || now > this.switchAsk.until) {
        this.switchAsk = { t, until: now + CONFIRM_MS };
        const pctDone = Math.floor((me.researchProgress / TECHS[me.researching].science) * 100);
        this.ctx.toast(`Click ${TECHS[t].name} again to switch: ${TECHS[me.researching].name} (${pctDone}%) loses its progress and gold`, 'info');
        return;
      }
    }
    this.switchAsk = null;
    this.ctx.act({ type: 'research', tech: t });
    this.afterAct();
  }
  /** After a purchase the phone's sheet closes (the card shows the new state). */
  private afterAct(): void {
    if (this.isPhone()) this.select(null);
    else if (this.last) this.updateDetail(this.last.s, this.last.me);
  }

  private updateViews(s: GameState, me: Player): void {
    this.last = { s, me };
    for (const tab of ['research', 'arsenal'] as const) {
      const v = this.views[tab];
      const next = nextAffordable(s, me, v.layout, tab === this.tab ? this.rowFilter() : undefined);
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
    this.updateDetail(s, me);
  }

  /** The detail pane: name and state, the full description, a grid of facts, and the Research / Buy button. */
  private updateDetail(s: GameState, me: Player): void {
    const d = this.det;
    const t = this.shown();
    setClass(d.root, 'empty', !t);
    if (!t) {
      setText(
        d.empty,
        researchRule(s) && this.tab === 'research'
          ? researchRule(s)!
          : this.tab === 'research'
            ? 'Pick a card to see what it does. Lines show what unlocks what. A tech costs gold to start and science to finish.'
            : `Pick a card to see what it does. Items are bought with gold plus iron or oil and arrive 20 to 45 s later. One path per pillar; Mastery in ${MASTERY_CAP} pillars at most.`,
      );
      return;
    }
    const info = TECHS[t];
    if (d.icKey !== t) {
      d.icKey = t;
      d.ic.innerHTML = iconOf(t);
      setText(d.name, info.name);
    }
    const unl = UNLOCKS[t]?.map((b) => BUILDINGS[b].name) ?? [];
    setText(d.desc, info.description + (unl.length ? ` Unlocks the ${unl.join(' and ')}.` : ''));
    const facts: Fact[] = [];
    const v = (x: number, short = false): string => `<b class="${short ? 'short' : ''}">${formatCount(x)}</b>`;
    const needs = this.needsHtml(s, me, t);
    const rivals = rivalsOf(t);
    let state = '';
    let look = '';
    let go: string | null = null;
    let why = '';
    let note = '';
    const choosing = this.isOpenChoice(s, me, t);
    if (tabOf(t) === 'arsenal') {
      const a = arsenalCard(s, me, t);
      const p = a.price;
      const parts = [`${v(p.gold, a.short.gold)} gold`];
      // "you have" only for what is short (the red figure): the rest is affordable, and the line stays short
      const have = a.short.gold ? [`${formatCount(me.gold)} gold`] : [];
      if (p.iron) {
        parts.push(`${v(p.iron, a.short.iron)} iron`);
        if (a.short.iron) have.push(`${formatCount(me.iron)} iron`);
      }
      if (p.oil) {
        parts.push(`${v(p.oil, a.short.oil)} oil`);
        if (a.short.oil) have.push(`${formatCount(me.oil)} oil`);
      }
      if (a.state !== 'done' && a.state !== 'ordered') {
        const hv = have.length ? `<span class="rp-d-have">you have ${have.join(', ')}</span>` : '';
        facts.push(['Price', `${parts.join(' &nbsp;')} <span class="rp-d-nw">· ${Math.round(p.seconds)} s to arrive</span>${hv}`]);
      }
      if (needs) facts.push(['Needs', needs]);
      ({ state, look } = {
        done: { state: 'In service', look: 'done' },
        ordered: { state: `Arrives in ${formatEta(a.order?.left ?? 0)}`, look: 'active' },
        buy: { state: 'Available', look: 'avail' },
        poor: { state: 'Available', look: 'avail' },
        building: { state: 'Locked', look: 'locked' },
        prereq: { state: 'Locked', look: 'locked' },
        'chose-other': { state: 'Not chosen', look: 'off' },
        capped: { state: 'Not available', look: 'off' },
        disabled: { state: 'Not available', look: 'off' },
      }[a.state]);
      if (a.state === 'buy') go = `${choosing ? 'Choose' : 'Buy'} ${info.name}`;
      else if (a.state === 'poor' || a.state === 'building' || a.state === 'prereq') {
        go = `Buy ${info.name}`;
        why = a.reason;
      } else if (a.state === 'chose-other') why = `You chose ${TECHS[a.chose!].name}.`;
      else if (a.state === 'capped' || a.state === 'disabled') why = a.reason;
      const it = arsenalItem(t);
      if (it?.kind === 'mastery') {
        const [cnt, names] = masteryCounter(me).text.replace('Mastery ', '').split(' · ');
        facts.push(['Mastery', `${cnt} pillars used${names ? `: ${names}` : ''}`]);
      }
    } else {
      const st = techStatus(s, me.id, t);
      const r = canResearch(s, me.id, t);
      const left = me.income.science > 0 ? (info.science - me.researchProgress) / me.income.science : null;
      if (st !== 'done' && st !== 'researching') {
        facts.push(['Cost', `${v(info.gold, me.gold < info.gold)} gold &nbsp;${v(info.science)} science <span class="rp-d-nw">· ${formatEta(researchEta(me, t))}</span>${me.gold < info.gold ? `<span class="rp-d-have">you have ${formatCount(me.gold)} gold</span>` : ''}`]);
      }
      if (needs) facts.push(['Needs', needs]);
      if (st === 'done') ({ state, look } = { state: 'Owned', look: 'done' });
      else if (st === 'researching') ({ state, look } = { state: `Researching: ${pct(me.researchProgress / info.science)}, ${formatEta(left)} left`, look: 'active' });
      else if (st === 'locked-choice') {
        const cap = masteryCapLine(me, t);
        const by = choiceLockedBy(me, t);
        ({ state, look } = { state: cap ? 'Not available' : 'Not chosen', look: 'off' });
        why = cap ?? (by ? `You chose ${TECHS[by].name}.` : techStatusReason(s, me.id, t) ?? '');
      } else if (st === 'disabled') {
        ({ state, look } = { state: 'Not available', look: 'off' });
        why = techStatusReason(s, me.id, t) ?? '';
      } else {
        ({ state, look } = st === 'locked-prereq' ? { state: 'Locked', look: 'locked' } : { state: 'Available', look: 'avail' });
        const switching = !!me.researching && me.researching !== t;
        go = `${choosing ? 'Choose' : switching && r.ok ? 'Switch to' : 'Research'} ${info.name}`;
        if (!r.ok) why = r.reason ?? 'Not possible now';
        else if (switching && me.researchProgress > 0) note = `${TECHS[me.researching!].name} (${pct(me.researchProgress / TECHS[me.researching!].science)}) loses its progress and gold.`;
      }
    }
    if (rivals.length && (look === 'avail' || look === 'locked')) {
      facts.push(['Rules out', `${rivals.map((o) => TECHS[o].name).join(' and ')} <span class="rp-d-have">for the rest of the game</span>`]);
      if (choosing) {
        const asked = this.forkAsk?.t === t && performance.now() <= this.forkAsk.until;
        if (asked) note = 'Click the card again to confirm.';
      }
    }
    setText(d.state, state);
    d.state.className = `rp-d-state ${look}`;
    const key = facts.map((f) => f.join('\u0001')).join('\u0002');
    if (d.factsKey !== key) {
      d.factsKey = key;
      d.facts.innerHTML = facts.map(([k, h]) => `<span class="rp-d-k">${k}</span><span class="rp-d-v">${h}</span>`).join('');
    }
    setText(d.note, note);
    setClass(d.note, 'warn', !!note && choosing);
    setClass(d.go, 'hidden', go === null);
    if (go !== null) setText(d.go, go);
    d.go.disabled = go === null || !!why;
    setText(d.why, why);
  }

  /** Each prerequisite with a tick or a cross, plus the building an Arsenal item needs ("Port"); '' when none. */
  private needsHtml(s: GameState, me: Player, t: TechId): string {
    const info = TECHS[t];
    const item = (ok: boolean, name: string, where = ''): string => `<span class="rp-d-need ${ok ? 'ok' : 'no'}">${ok ? OK : NO}${name}${where ? `<i> (${where})</i>` : ''}</span>`;
    const other = (r: TechId): string => (tabOf(r) !== this.tab ? (tabOf(r) === 'arsenal' ? 'Arsenal' : 'Research') : '');
    const out = info.requires.map((r) => item(hasTech(me, r), TECHS[r].name, other(r)));
    if (info.requiresAny?.length) {
      const ok = info.requiresAny.some((r) => hasTech(me, r));
      out.push(item(ok, info.requiresAny.map((r) => TECHS[r].name).join(' or ')));
    }
    if (tabOf(t) === 'arsenal' && !hasTech(me, t)) {
      const b = priceOf(s, me, t).needs;
      if (b) out.push(item(!missingBuilding(s, me, t), BUILDINGS[b].name));
    }
    return out.join('');
  }

  update(s: GameState, me: Player): void {
    for (const f of this.upd) f(s, me);
  }
}
