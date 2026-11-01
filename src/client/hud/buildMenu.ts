// Build menu (Tab): a tidy grid of big cards grouped Economy / Military / Defence / Special, each with the building's
// literal icon, NAME, cost, hotkey and one-line effect; locked ones dimmed with a one-line reason. Click a card to
// enter build mode (one click), right-click to pin / unpin it on the quick bar (hud/quickBar.ts). A count selector
// x1 / x3 / x5 (holding Shift = x5) makes one click place the building and queue it up to that many levels
// (Action buildMany: each level still takes its build time; what can't be paid is not queued). The Military group
// also sells warships, bombers, fighters and tank divisions; the Tools row points to the building selection
// (Shift+drag a box over your buildings, then Upgrade x1 / x3 / x5: client/selection.ts, hud/buildingSelection.ts).
//
// The pure helpers at the top (counts, bulk preview texts, the click's action, quick-bar picks) have no DOM and are
// what tests/buildMenu.test.ts checks.
import './buildMenu.css';
import { buildManyPreview, type BuildManyPreview, type BulkCost } from '../../sim/bulkbuild';
import { buildingCost, countBuildings } from '../../sim/buildings';
import { BUILDINGS, BUILDING_ORDER, BULK_MAX_COUNT, TECHS, UNITS } from '../../sim/config';
import { buildingAllowed, buildSeconds, mods } from '../../sim/rules';
import { hasTech } from '../../sim/tech';
import { howToGet, onOrder, techComing, techFirst } from './procure';
import { bestFactory, canBuildTankDivision, tankBuildSeconds, tankDivisionCost, tankDivisionCount, tankDivisionLimit } from '../../sim/tanks';
import type { Action, BuildingType, GameState, Player } from '../../sim/types';
import { formatCount } from '../render/common';
import { BUYABLE_UNITS, buildUnit, priceText, UNIT_TEXT, unitBuildStatus, type BuyableUnit } from '../forces';
import { iconDataUrl } from '../icons';
import { enterTankDivisionBuildMode, enterWarshipSpawnMode } from '../selection';
import { maxLevel, resolveBuild } from '../simx';
import type { UiState } from '../uiState';
import { BUILD_TAB_OF, BUILD_TABS, buildingTexts, type BuildTab } from './text';
import { el, fmtSeconds, keycap, setClass, setText, setTip, setVisible, type HudCtx } from './dom';
import { iconSpan, lineIcon, worldGlyph } from './glyph';

// ================================================================================================ pure helpers

export type BuildCount = 1 | 3 | 5;
export const BUILD_COUNTS: readonly BuildCount[] = [1, 3, 5];
/** Hotkey that opens the build menu (free in input.ts; Space is pause). */
export const BUILD_MENU_KEY = 'Tab';
/** Buttons on the quick bar. */
export const QUICK_SLOTS = 6;

/** Count a click uses: Shift held = x5, else the selector (never above the sim's BULK_MAX_COUNT). */
export function effectiveCount(ui: Pick<UiState, 'buildCount'>, shift: boolean): number {
  const n = shift ? 5 : ui.buildCount || 1;
  return Math.max(1, Math.min(BULK_MAX_COUNT, n));
}

/**
 * The action a build-mode click sends: count 1 = the classic build (snapped to the nearest valid own tile or a
 * nearby building of that type to upgrade, as before); more = Action buildMany (it snaps the same way itself).
 */
export function buildClickAction(state: GameState, pid: number, building: BuildingType, tile: number, count: number): Action {
  if (count > 1) return { type: 'buildMany', building, tile, count };
  const t = resolveBuild(state, pid, building, tile);
  return { type: 'build', building, tile: t.tile >= 0 ? t.tile : tile };
}

/** "12.4k gold + 300 iron" ('' when free). */
export function costText(c: BulkCost): string {
  const parts: string[] = [];
  if (c.gold > 0) parts.push(`${formatCount(c.gold)} gold`);
  if (c.iron > 0) parts.push(`${formatCount(c.iron)} iron`);
  return parts.join(' + ');
}

/** The ghost / tooltip line for a bulk click: what it queues, what it costs and what it can't afford. */
export function bulkPreviewText(pv: BuildManyPreview, building: BuildingType): { text: string; sub: string; tone: 'ok' | 'up' | 'short' | 'no' } {
  const name = BUILDINGS[building].name;
  if (pv.error) return { text: pv.error, sub: '', tone: 'no' };
  const ups = pv.upgrade ? pv.levelsQueued : pv.levelsQueued - 1;
  const what = pv.upgrade
    ? `${name} -> level ${pv.toLevel}: ${pv.levelsQueued} upgrade${pv.levelsQueued === 1 ? '' : 's'} queued`
    : `${name} -> level ${pv.toLevel}: ${ups > 0 ? `${ups} upgrade${ups === 1 ? '' : 's'} queued` : 'build only'}`;
  const text = `${what}, ${costText(pv.cost) || 'free'}`;
  if (pv.levelsQueued < pv.requested) {
    const miss = costText(pv.shortBy);
    return { text, sub: `Can afford ${pv.levelsQueued} of ${pv.requested}${miss ? ` (short ${miss})` : ''}`, tone: 'short' };
  }
  return { text, sub: 'Each level still takes its build time', tone: pv.upgrade ? 'up' : 'ok' };
}

// ------------------------------------------------------------------------------------------------ quick-bar picks

/** Minimal storage (sessionStorage / localStorage or a stub in tests). */
export interface PickStore {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
}
const PICKS_KEY = 'fa.quickbar.v1';
const DEFAULT_PICKS: BuildingType[] = ['city', 'farm', 'market', 'barracks', 'fort', 'port', 'mine', 'factory', 'lab'];

/**
 * Which buildings sit on the quick bar: pinned ones first (in pin order), then the most used (a use counts more the
 * more recent it is), then sensible defaults. Saved per browser (localStorage, failures ignored).
 */
export class QuickPicks {
  pinned: BuildingType[] = [];
  /** use score per building (decays a little with every use of anything) */
  score: Partial<Record<BuildingType, number>> = {};
  constructor(private store: PickStore | null = null) {
    this.load();
  }
  isPinned(b: BuildingType): boolean {
    return this.pinned.includes(b);
  }
  /** Pins or unpins; returns true when it is pinned now. */
  togglePin(b: BuildingType): boolean {
    if (this.isPinned(b)) this.pinned = this.pinned.filter((x) => x !== b);
    else {
      this.pinned.push(b);
      if (this.pinned.length > QUICK_SLOTS) this.pinned.shift();
    }
    this.save();
    return this.isPinned(b);
  }
  /** A building was picked (any way: menu, quick bar, hotkey). */
  use(b: BuildingType): void {
    for (const k of Object.keys(this.score) as BuildingType[]) this.score[k] = (this.score[k] ?? 0) * 0.92;
    this.score[b] = (this.score[b] ?? 0) + 1;
    this.save();
  }
  /** Up to n buildings for the bar; `ok` filters out what this game or this player can't use. */
  list(n: number, ok: (b: BuildingType) => boolean = () => true): BuildingType[] {
    const out: BuildingType[] = [];
    const add = (b: BuildingType) => {
      if (out.length < n && !out.includes(b) && BUILDINGS[b] && ok(b)) out.push(b);
    };
    for (const b of this.pinned) add(b);
    const used = (Object.keys(this.score) as BuildingType[])
      .filter((b) => (this.score[b] ?? 0) > 0.05)
      .sort((a, b) => (this.score[b] ?? 0) - (this.score[a] ?? 0) || BUILDING_ORDER.indexOf(a) - BUILDING_ORDER.indexOf(b));
    for (const b of used) add(b);
    for (const b of DEFAULT_PICKS) add(b);
    for (const b of BUILDING_ORDER) add(b);
    return out;
  }
  private load(): void {
    try {
      const raw = this.store?.getItem(PICKS_KEY);
      if (!raw) return;
      const v = JSON.parse(raw) as { pinned?: unknown; score?: unknown };
      if (Array.isArray(v.pinned)) this.pinned = v.pinned.filter((b): b is BuildingType => typeof b === 'string' && !!BUILDINGS[b as BuildingType]).slice(0, QUICK_SLOTS);
      if (v.score && typeof v.score === 'object') {
        for (const [k, s] of Object.entries(v.score as Record<string, unknown>)) {
          if (BUILDINGS[k as BuildingType] && typeof s === 'number' && Number.isFinite(s)) this.score[k as BuildingType] = s;
        }
      }
    } catch {
      /* no storage or bad data: defaults */
    }
  }
  private save(): void {
    try {
      this.store?.setItem(PICKS_KEY, JSON.stringify({ pinned: this.pinned, score: this.score }));
    } catch {
      /* storage blocked */
    }
  }
}

/**
 * Keeps buttons from jumping under the cursor: items still wanted stay in their slots, new ones fill the free slots
 * in `next` order (pinned and most-used first).
 */
export function stableSlots<T>(prev: readonly (T | null)[], next: readonly T[], n: number): (T | null)[] {
  const out: (T | null)[] = [];
  for (let k = 0; k < n; k++) out.push(prev[k] !== undefined && prev[k] !== null && next.includes(prev[k] as T) ? (prev[k] as T) : null);
  const rest = next.filter((x) => !out.includes(x));
  for (let k = 0; k < n && rest.length; k++) if (out[k] === null) out[k] = rest.shift()!;
  return out;
}

/** The browser's localStorage when it works, else null. */
export function browserStore(): PickStore | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------------------------------------ building texts

/** A tech is "close" when it is researched, being researched or on order, or all its prerequisites are done. */
function techClose(p: Player, t: keyof typeof TECHS | null): boolean {
  if (!t) return true;
  return techComing(p, t) || TECHS[t].requires.every((r) => hasTech(p, r));
}

/** Why a building can't be built now ('' = it can). */
export function lockReason(state: GameState, me: Player, type: BuildingType): string {
  const info = BUILDINGS[type];
  if (!buildingAllowed(state, type)) return 'Off in this game';
  if (info.tech && !hasTech(me, info.tech)) return onOrder(me, info.tech) ? `${TECHS[info.tech].name} is on order (Arsenal)` : techFirst(info.tech);
  const c = buildingCost(state, me.id, type);
  if (me.gold < c.gold) return `Needs ${formatCount(c.gold)} gold`;
  if (me.iron < c.iron) return `Needs ${formatCount(c.iron)} iron: build a Mine`;
  return '';
}

/** Tooltip of a building button (menu card and quick bar). */
export function buildingTip(state: GameState, me: Player, type: BuildingType): string {
  const info = BUILDINGS[type];
  const c = buildingCost(state, me.id, type);
  const tx = buildingTexts(mods(state).noNukes, type, info.description);
  const owned = countBuildings(state, me.id, type, true);
  const lv = maxLevel(type);
  const why = lockReason(state, me, type);
  return (
    `${info.name}  [${info.hotkey}]  ${formatCount(c.gold)} gold${c.iron ? ` + ${formatCount(c.iron)} iron` : ''}\n${tx.description}` +
    `\nBuilds in ${fmtSeconds(buildSeconds(state, info.buildTime))}` +
    (owned ? `. You have ${owned}` : '') +
    (lv > 1 ? `. Up to level ${lv}: x3 / x5 (or Shift) queues levels in one click` : '') +
    (why ? `\n${why}` : '')
  );
}

/** Military entries that are units, not buildings. */
export type MenuUnit = BuyableUnit | 'tankDivision';

// ------------------------------------------------------------------------------------------------ military entries

/** Can the player order a tank division now (at its best factory)? */
export function tankDivisionStatus(state: GameState, me: Player): { allowed: boolean; ok: boolean; locked: boolean; line: string; factory: number } {
  const allowed = buildingAllowed(state, 'factory');
  if (!allowed) return { allowed, ok: false, locked: true, line: 'Tank divisions are off in this game', factory: -1 };
  if (!hasTech(me, 'mechanization')) return { allowed, ok: false, locked: true, line: onOrder(me, 'mechanization') ? `${TECHS.mechanization.name} is on order (Arsenal)` : howToGet(state, me, 'mechanization'), factory: -1 };
  const f = bestFactory(state, me.id);
  if (f < 0) return { allowed, ok: false, locked: true, line: 'Build a Factory first (7)', factory: -1 };
  const r = canBuildTankDivision(state, me.id, f);
  const lim = tankDivisionLimit(state, me.id);
  const have = tankDivisionCount(state, me.id);
  if (!r.ok) return { allowed, ok: false, locked: false, line: r.reason ?? 'Not possible now', factory: f };
  return { allowed, ok: true, locked: false, line: `${have} of ${lim} divisions. Click a Factory of yours (builds in ${fmtSeconds(tankBuildSeconds(state))})`, factory: f };
}

/** "1.8k gold + 150 iron + 80 oil" for a division. */
export function tankPriceText(state: GameState, pid: number): string {
  const c = tankDivisionCost(state, pid);
  return `${formatCount(c.gold)} gold + ${formatCount(c.iron)} iron + ${formatCount(c.oil)} oil, ${formatCount(c.armor + c.infantry + c.artillery)} troops`;
}

/** Small top-down tank line glyph (no icon id for it yet). */
export function tankGlyph(px = 24): string {
  return `<svg viewBox="0 0 24 24" width="${px}" height="${px}" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="12" width="18" height="6" rx="3"/><path d="M7 12V9h8v3M15 10.5h6"/><circle cx="7" cy="15" r="1"/><circle cx="12" cy="15" r="1"/><circle cx="17" cy="15" r="1"/></svg>`;
}

// ================================================================================================ the menu

const GROUP_LABEL: Record<BuildTab, string> = { economy: 'Economy', military: 'Military', defence: 'Defence', special: 'Special' };

interface Card {
  btn: HTMLButtonElement;
  update: (s: GameState, me: Player) => void;
}

export interface BuildMenuHooks {
  picks: QuickPicks;
  /** a building was picked (quick bar refreshes, the pick counts as a use) */
  picked: (b: BuildingType) => void;
}

/** The count selector x1 / x3 / x5 (one per place it shows; all read and write ui.buildCount). */
export function countSelector(ctx: HudCtx, cls = ''): { el: HTMLElement; sync: () => void } {
  const box = el('div', `bm-count ${cls}`);
  box.setAttribute('role', 'radiogroup');
  box.setAttribute('aria-label', 'Levels per click');
  const bs = BUILD_COUNTS.map((n) => {
    const b = el('button', 'bm-cnt', `x${n}`);
    b.type = 'button';
    b.dataset.test = `count-${n}`;
    b.setAttribute('role', 'radio');
    b.dataset.tip =
      n === 1 ? 'x1: one click builds one level' : `x${n}: one click places the building and queues it up to ${n} levels (or adds ${n} levels to one of yours). Each level still takes its build time; only what you can pay is queued. Shift = x5.`;
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      ctx.ui.buildCount = n;
      sync();
      ctx.refreshSoon();
    });
    box.append(b);
    return { n, b };
  });
  const sync = () => {
    for (const { n, b } of bs) {
      setClass(b, 'on', ctx.ui.buildCount === n);
      b.setAttribute('aria-checked', String(ctx.ui.buildCount === n));
    }
  };
  sync();
  return { el: box, sync };
}

export class BuildMenu {
  readonly el: HTMLElement;
  private cards: Card[] = [];
  private count: { el: HTMLElement; sync: () => void };
  private isOpen = false;
  private ac = new AbortController();

  constructor(
    private ctx: HudCtx,
    private hooks: BuildMenuHooks,
  ) {
    this.el = el('div', 'bm hidden');
    this.el.dataset.test = 'build-menu';
    this.el.setAttribute('role', 'dialog');
    this.el.setAttribute('aria-label', 'Build menu');
    const head = el('div', 'bm-head');
    const title = el('div', 'bm-title');
    title.append(el('span', 'bm-t', 'Build'), keycap(BUILD_MENU_KEY));
    this.count = countSelector(ctx);
    const countWrap = el('div', 'bm-count-wrap');
    countWrap.append(el('span', 'bm-count-l', 'Levels per click'), this.count.el);
    const close = el('button', 'sq bm-x');
    close.type = 'button';
    close.setAttribute('aria-label', 'Close (Esc)');
    close.append(iconSpan(lineIcon('close', 16)));
    close.addEventListener('click', () => this.close());
    head.append(title, countWrap, close);
    const body = el('div', 'bm-body');
    // three columns: Economy | Military (two cards wide) + Tools | Defence + Special
    const colA = el('div', 'bm-col');
    const colB = el('div', 'bm-col wide');
    const colC = el('div', 'bm-col');
    body.append(colA, colB, colC);
    const colOf: Record<BuildTab, HTMLElement> = { economy: colA, military: colB, defence: colC, special: colC };
    for (const g of BUILD_TABS) {
      const sec = el('section', `bm-group bm-${g.id}`);
      sec.append(el('div', 'bm-gh', GROUP_LABEL[g.id]));
      const grid = el('div', 'bm-grid');
      for (const type of BUILDING_ORDER) if (BUILD_TAB_OF[type] === g.id) grid.append(this.buildingCard(type));
      if (g.id === 'military') {
        for (const u of BUYABLE_UNITS) grid.append(this.unitCard(u));
        grid.append(this.unitCard('tankDivision'));
      }
      sec.append(grid);
      colOf[g.id].append(sec);
    }
    // tools: how to upgrade many buildings at once
    const tools = el('section', 'bm-group bm-tools');
    tools.append(el('div', 'bm-gh', 'Tools'));
    const tg = el('div', 'bm-grid');
    tg.append(this.areaCard());
    tools.append(tg);
    colB.append(tools);
    const foot = el('div', 'bm-foot', 'Click a card to build it. Right-click pins it to the quick bar. x3 / x5 (or hold Shift) queues levels. Esc closes.');
    this.el.append(head, body, foot);

    // keyboard: Esc closes, arrows move between cards; capture phase so the map's keys don't also fire
    window.addEventListener(
      'keydown',
      (e) => {
        if (!this.isOpen) return;
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopImmediatePropagation();
          this.close();
          return;
        }
        if (!this.el.contains(document.activeElement)) return;
        if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'ArrowUp' || e.key === 'ArrowDown') {
          e.preventDefault();
          e.stopImmediatePropagation();
          this.moveFocus(e.key);
        }
      },
      { capture: true, signal: this.ac.signal },
    );
    this.el.addEventListener('pointerdown', (e) => e.stopPropagation());
  }

  get open(): boolean {
    return this.isOpen;
  }

  toggle(): void {
    if (this.isOpen) this.close();
    else this.show();
  }

  show(): void {
    if (this.isOpen) return;
    this.isOpen = true;
    setVisible(this.el, true);
    this.el.classList.remove('slide');
    void this.el.offsetWidth;
    this.el.classList.add('slide');
    this.count.sync();
    const s = this.ctx.state();
    const me = this.ctx.me();
    if (s && me) this.update(s, me);
    // focus the first card you can use, so the keyboard works at once
    const first = this.cards.find((c) => !c.btn.classList.contains('locked') && !c.btn.classList.contains('hidden')) ?? this.cards[0];
    first?.btn.focus({ preventScroll: true });
  }

  close(): void {
    if (!this.isOpen) return;
    this.isOpen = false;
    setVisible(this.el, false);
    (document.activeElement as HTMLElement | null)?.blur?.();
  }

  destroy(): void {
    this.ac.abort();
  }

  update(s: GameState, me: Player): void {
    if (!this.isOpen) return;
    for (const c of this.cards) c.update(s, me);
    this.count.sync();
  }

  private moveFocus(key: string): void {
    const vis = this.cards.map((c) => c.btn).filter((b) => !b.classList.contains('hidden'));
    const cur = vis.indexOf(document.activeElement as HTMLButtonElement);
    if (cur < 0) return;
    const a = vis[cur].getBoundingClientRect();
    let best: HTMLButtonElement | null = null;
    let bestD = Infinity;
    for (const b of vis) {
      if (b === vis[cur]) continue;
      const r = b.getBoundingClientRect();
      const dx = r.left + r.width / 2 - (a.left + a.width / 2);
      const dy = r.top + r.height / 2 - (a.top + a.height / 2);
      const fwd = key === 'ArrowRight' ? dx : key === 'ArrowLeft' ? -dx : key === 'ArrowDown' ? dy : -dy;
      const side = key === 'ArrowRight' || key === 'ArrowLeft' ? Math.abs(dy) : Math.abs(dx);
      if (fwd <= 4) continue;
      const d = fwd + side * 2.5;
      if (d < bestD) {
        bestD = d;
        best = b;
      }
    }
    best?.focus();
  }

  private shell(test: string, icon: HTMLElement, name: string): { b: HTMLButtonElement; cost: HTMLElement; line: HTMLElement; key: HTMLElement; pin: HTMLElement } {
    const b = el('button', 'bm-card');
    b.type = 'button';
    b.dataset.test = test;
    const top = el('span', 'bm-c-top');
    const nm = el('span', 'bm-c-n', name);
    const key = el('span', 'bm-c-k');
    top.append(nm, key);
    const cost = el('span', 'bm-c-cost');
    const line = el('span', 'bm-c-l');
    const pin = el('span', 'bm-c-pin');
    pin.setAttribute('aria-hidden', 'true');
    const txt = el('span', 'bm-c-txt');
    txt.append(top, cost, line);
    b.append(icon, txt, pin);
    return { b, cost, line, key, pin };
  }

  private buildingCard(type: BuildingType): HTMLElement {
    const info = BUILDINGS[type];
    const { b, cost, line, key, pin } = this.shell(`bm-${type}`, iconSpan(worldGlyph(type, 34), 'bm-c-ic'), info.name);
    key.append(keycap(info.hotkey));
    b.addEventListener('click', () => {
      this.ctx.ui.contextMenu = null;
      this.ctx.ui.mode = { kind: 'build', building: type };
      this.hooks.picked(type);
      this.close();
    });
    b.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const on = this.hooks.picks.togglePin(type);
      this.ctx.toast(on ? `${info.name} pinned to the quick bar` : `${info.name} unpinned`, 'info');
      this.hooks.picked(type);
      setClass(b, 'pinned', on);
    });
    this.cards.push({
      btn: b,
      update: (s, me) => {
        const allowed = buildingAllowed(s, type);
        setVisible(b, allowed);
        if (!allowed) return;
        const c = buildingCost(s, me.id, type);
        setText(cost, `${formatCount(c.gold)} gold${c.iron ? ` + ${formatCount(c.iron)} iron` : ''}`);
        const why = lockReason(s, me, type);
        const tx = buildingTexts(mods(s).noNukes, type, info.description);
        // a building whose tech is far away is "locked"; one that is only unaffordable is still pickable (to aim)
        const locked = !!info.tech && !hasTech(me, info.tech);
        setClass(b, 'locked', locked);
        setClass(b, 'short', !locked && why !== '');
        setText(line, locked ? why : tx.short);
        setClass(line, 'why', locked);
        setClass(cost, 'bad', !locked && why !== '');
        setClass(b, 'pinned', this.hooks.picks.isPinned(type));
        setClass(pin, 'on', this.hooks.picks.isPinned(type));
        setClass(b, 'far', locked && !techClose(me, info.tech));
        setTip(b, buildingTip(s, me, type) + '\nRight-click: pin to the quick bar');
        b.setAttribute('aria-label', `${info.name}, ${formatCount(c.gold)} gold, hotkey ${info.hotkey}. ${locked ? why : tx.short}`);
      },
    });
    return b;
  }

  private unitCard(kind: MenuUnit): HTMLElement {
    const name = kind === 'tankDivision' ? 'Tank division' : UNITS[kind].name;
    let icon: HTMLElement;
    if (kind === 'tankDivision') icon = iconSpan(tankGlyph(32), 'bm-c-ic unit');
    else {
      const img = el('img', 'bm-c-img');
      img.alt = '';
      img.width = 32;
      img.height = 32;
      img.draggable = false;
      try {
        img.src = iconDataUrl(kind, 32);
      } catch {
        /* no canvas (tests) */
      }
      icon = el('span', 'bm-c-ic unit');
      icon.append(img);
    }
    const { b, cost, line, key } = this.shell(`bm-${kind}`, icon, name);
    key.append(el('span', 'bm-unit-tag', 'unit'));
    b.addEventListener('click', () => {
      const s = this.ctx.state();
      const me = this.ctx.me();
      if (!s || !me) return;
      if (kind === 'warship') {
        // UI-1's click mode (selection.ts): the next click picks the water tile, the valid area is shaded
        const why = enterWarshipSpawnMode(this.ctx.ui, s, me);
        if (why) return this.refuse(name, why);
        this.close();
        return;
      }
      if (kind === 'tankDivision') {
        const why = enterTankDivisionBuildMode(this.ctx.ui, s, me);
        if (why) return this.refuse(name, why);
        this.close();
        return;
      }
      const why = buildUnit(s, me, (a) => this.ctx.dispatch(a), kind, { x: this.ctx.camera.x, y: this.ctx.camera.y });
      if (why) return this.refuse(name, why);
      this.ctx.toast(`${name} ready at your Airfield. ${kind === 'bomber' ? 'Press X to send it on a bombing run.' : 'It guards the sky around the Airfield.'}`, 'good');
      this.ctx.refreshSoon();
    });
    this.cards.push({
      btn: b,
      update: (s, me) => {
        if (kind === 'tankDivision') {
          const st = tankDivisionStatus(s, me);
          setVisible(b, st.allowed);
          setText(cost, tankPriceText(s, me.id));
          setClass(b, 'locked', st.locked);
          setClass(b, 'short', !st.locked && !st.ok);
          setText(line, st.ok ? 'Breakthroughs on land; click a Factory' : st.line);
          setClass(line, 'why', !st.ok);
          setTip(b, `Tank division  ${tankPriceText(s, me.id)}\nA commandable armored division: move it over your land, or click enemy land at your border to launch a fast spearhead.\n${st.line}`);
          return;
        }
        const st = unitBuildStatus(s, me, kind, { x: this.ctx.camera.x, y: this.ctx.camera.y });
        setVisible(b, st.allowed);
        setText(cost, priceText(kind, s, me.id));
        setClass(b, 'locked', st.locked);
        setClass(b, 'short', !st.locked && !st.ok);
        const t = UNIT_TEXT[kind];
        setText(line, st.ok ? (kind === 'warship' ? 'Click the water where it appears' : t.what.split('.')[0]) : st.line);
        setClass(line, 'why', !st.ok);
        setTip(b, `${t.name}  ${priceText(kind, s, me.id)}\n${t.what}\nCounter: ${t.counter}\n${st.line}`);
      },
    });
    return b;
  }

  private areaCard(): HTMLElement {
    const { b, cost, line, key } = this.shell('bm-upgrade-sel', iconSpan(lineIcon('upgrade', 30, 1.8), 'bm-c-ic tool'), 'Upgrade many');
    key.append(el('span', 'bm-unit-tag', 'tip'));
    setText(cost, 'Shift+drag a box on the map');
    setText(line, 'Selects your buildings in it; then U upgrades them all');
    b.addEventListener('click', () => {
      this.close();
      this.ctx.toast('Hold Shift and drag a box over your buildings, then press U (or click Upgrade x1 / x3 / x5)', 'info');
    });
    setTip(b, 'Upgrade many buildings: hold Shift and drag a box on the map. Your buildings inside are selected (filter them by type); the bar then orders Upgrade x1 / x3 / x5 for all of them, cheapest first, as far as your gold and iron go. Each level still takes its build time.');
    this.cards.push({ btn: b, update: () => {} });
    return b;
  }

  private refuse(name: string, why: string): void {
    this.ctx.toast(`${name}: ${why}`, 'info');
    this.ctx.sound('uiError');
  }
}

// ------------------------------------------------------------------------------------------------ previews (cached)

/** Per-viewer caches so the previews don't recompute every frame. */
export class BulkPreviewCache {
  private bk = '';
  private bv: BuildManyPreview | null = null;
  build(s: GameState, pid: number, b: BuildingType, tile: number, n: number): BuildManyPreview {
    const k = `${b}|${tile}|${n}|${Math.floor(s.tick / 3)}|${s.buildingsVersion}`;
    if (k !== this.bk || !this.bv) {
      this.bk = k;
      this.bv = buildManyPreview(s, pid, b, tile, n);
    }
    return this.bv;
  }
}
/** Shared by the tooltip and the overlay. */
export const bulkPreviews = new BulkPreviewCache();
