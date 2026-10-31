// Command bar BUILD section: a clear "Build" button (Tab) that opens the build menu (hud/buildMenu.ts), a QUICK BAR
// of six building buttons (pinned ones first, then your most-used; right-click unpins / pins) and the x1 / x3 / x5
// count selector (holding Shift = x5). Replaces the old category icon tabs. While the Shift+drag box holds buildings of
// yours, the building selection bar (hud/buildingSelection.ts: filter chips, Upgrade x1 / x3 / x5) sits above it.
import { BUILDINGS } from '../../sim/config';
import { buildingAllowed } from '../../sim/rules';
import type { BuildingType, GameState, Player } from '../../sim/types';
import { formatCount } from '../render/common';
import { buildingCost } from '../../sim/buildings';
import {
  browserStore,
  BUILD_MENU_KEY,
  BuildMenu,
  buildingTip,
  countSelector,
  lockReason,
  QUICK_SLOTS,
  QuickPicks,
  stableSlots,
} from './buildMenu';
import { BuildingSelectionBar } from './buildingSelection';
import { el, keycap, setClass, setTip, setVisible, type HudCtx } from './dom';
import { iconSpan, lineIcon, worldGlyph } from './glyph';
import { TECHS } from '../../sim/config';
import { hasTech } from '../../sim/tech';

let shiftDown = false;
/** True while Shift is held (x5 placement; the ghost preview reads it). */
export function shiftHeld(): boolean {
  return shiftDown;
}

function isTextInput(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  if (t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement || t.isContentEditable) return true;
  return t instanceof HTMLInputElement && t.type !== 'range' && t.type !== 'checkbox' && t.type !== 'button';
}

/** A tech is "close" when researched, being researched, or all its prerequisites are done. */
function near(p: Player, t: keyof typeof TECHS | null): boolean {
  if (!t) return true;
  return hasTech(p, t) || p.researching === t || TECHS[t].requires.every((r) => hasTech(p, r));
}

export class QuickBar {
  readonly el: HTMLElement;
  readonly menu: BuildMenu;
  readonly sel: BuildingSelectionBar;
  readonly picks: QuickPicks;
  private slots: { b: HTMLButtonElement; ic: HTMLElement; key: HTMLElement; type: BuildingType | null }[] = [];
  private buildBtn: HTMLButtonElement;
  private count: { el: HTMLElement; sync: () => void };
  private lastMode = '';
  private ac = new AbortController();

  constructor(private ctx: HudCtx) {
    this.picks = new QuickPicks(browserStore());
    this.menu = new BuildMenu(ctx, { picks: this.picks, picked: () => this.refresh() });
    this.sel = new BuildingSelectionBar(ctx);
    this.el = el('section', 'cb-sec cb-build qb');
    this.el.dataset.test = 'quick-bar';

    // the Build button
    this.buildBtn = el('button', 'qb-build');
    this.buildBtn.type = 'button';
    this.buildBtn.dataset.test = 'build-menu-btn';
    this.buildBtn.setAttribute('aria-haspopup', 'dialog');
    this.buildBtn.append(iconSpan(lineIcon('build', 16, 2), 'qb-build-ic'), el('span', 'qb-build-l', 'Build'), keycap(BUILD_MENU_KEY));
    this.buildBtn.dataset.tip = `Build menu (${BUILD_MENU_KEY}): every building with its cost and what it does, warships and tank divisions`;
    this.buildBtn.addEventListener('click', () => this.menu.toggle());

    // six quick slots
    const row = el('div', 'qb-row');
    for (let k = 0; k < QUICK_SLOTS; k++) {
      const b = el('button', 'bb qb-slot');
      b.type = 'button';
      const ic = el('span', 'bb-ic');
      const key = el('span', 'qb-k');
      b.append(ic, key);
      const slot = { b, ic, key, type: null as BuildingType | null };
      b.addEventListener('click', () => {
        const t = slot.type;
        if (!t) return;
        const m = this.ctx.ui.mode;
        this.ctx.ui.contextMenu = null;
        this.ctx.ui.mode = m.kind === 'build' && m.building === t ? { kind: 'none' } : { kind: 'build', building: t };
        b.blur();
      });
      b.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        const t = slot.type;
        if (!t) return;
        const on = this.picks.togglePin(t);
        this.ctx.toast(on ? `${BUILDINGS[t].name} pinned to the quick bar` : `${BUILDINGS[t].name} unpinned`, 'info');
        this.refresh();
      });
      this.slots.push(slot);
      row.append(b);
    }
    this.count = countSelector(ctx, 'qb-count');
    this.el.append(this.buildBtn, row, this.count.el);

    // Tab opens / closes the menu; Shift is tracked for x5 (the map's own key handler ignores Tab)
    const o = { signal: this.ac.signal };
    window.addEventListener(
      'keydown',
      (e) => {
        if (!this.alive()) return;
        if (e.key === 'Shift') shiftDown = true;
        if (e.key !== 'Tab' || e.ctrlKey || e.metaKey || e.altKey) return;
        if (isTextInput(e.target)) return;
        const s = this.ctx.state();
        if (!s || !this.ctx.me() || s.phase !== 'playing') return;
        e.preventDefault();
        if (!e.repeat) this.menu.toggle();
      },
      o,
    );
    window.addEventListener(
      'keyup',
      (e) => {
        if (e.key === 'Shift') shiftDown = false;
      },
      o,
    );
    window.addEventListener('blur', () => (shiftDown = false), o);
    // a press outside the menu (and not on the Build button) closes it
    window.addEventListener(
      'pointerdown',
      (e) => {
        if (!this.alive() || !this.menu.open) return;
        const t = e.target as Node | null;
        if (t && (this.menu.el.contains(t) || this.buildBtn.contains(t))) return;
        this.menu.close();
      },
      { signal: this.ac.signal, capture: true },
    );
  }

  /** False once the HUD is gone (the listeners then remove themselves). */
  private alive(): boolean {
    if (this.el.isConnected) return true;
    this.ac.abort();
    this.menu.destroy();
    return false;
  }

  private refresh(): void {
    const s = this.ctx.state();
    const me = this.ctx.me();
    if (s && me) this.update(s, me);
  }

  /** ~5 Hz. */
  update(s: GameState, me: Player): void {
    const want = this.picks.list(QUICK_SLOTS, (b) => buildingAllowed(s, b) && near(me, BUILDINGS[b].tech));
    const list = stableSlots(
      this.slots.map((x) => x.type),
      want,
      QUICK_SLOTS,
    );
    this.slots.forEach((slot, k) => {
      const t = list[k] ?? null;
      setVisible(slot.b, !!t);
      if (!t) return;
      if (slot.type !== t) {
        slot.type = t;
        slot.ic.innerHTML = worldGlyph(t, 22);
        slot.key.textContent = BUILDINGS[t].hotkey;
        slot.b.dataset.test = `build-${t}`;
        slot.b.dataset.building = t;
      }
      const why = lockReason(s, me, t);
      setClass(slot.b, 'disabled', why !== '');
      setClass(slot.b, 'pinned', this.picks.isPinned(t));
      const c = buildingCost(s, me.id, t);
      slot.b.setAttribute('aria-label', `${BUILDINGS[t].name}, ${formatCount(c.gold)} gold (${BUILDINGS[t].hotkey})`);
      setTip(slot.b, buildingTip(s, me, t) + `\nRight-click: ${this.picks.isPinned(t) ? 'unpin' : 'pin'}`);
    });
    this.menu.update(s, me);
  }

  /** Every frame: selection highlight, counting picks, the menu closing when a mode starts. */
  fast(): void {
    const m = this.ctx.ui.mode;
    const sel = m.kind === 'build' ? m.building : null;
    for (const s of this.slots) setClass(s.b, 'on', !!s.type && s.type === sel);
    const key = m.kind === 'build' ? `b:${m.building}` : m.kind;
    if (key !== this.lastMode) {
      this.lastMode = key;
      if (sel) this.picks.use(sel);
      if (m.kind !== 'none' && this.menu.open) this.menu.close();
    }
    setClass(this.buildBtn, 'on', this.menu.open);
    this.buildBtn.setAttribute('aria-expanded', String(this.menu.open));
    this.count.sync();
    this.sel.fast(this.ctx.state(), this.ctx.me());
  }
}
