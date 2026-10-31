// The building selection bar: shows above the command bar while the Shift+drag box holds buildings of yours
// (ui.buildingSel, client/selection.ts).
//   "12 buildings selected"  [City 5] [Factory 4] [Port 3]  (filter chips: click to leave a type out)
//   Upgrade [x1 (U)] [x3] [x5]   each button orders that many levels on every active building (Action upgradeBuildings)
//   cost line: gold, iron and build time of the U choice, or why it can't be paid (the buttons grey out then)
// U orders the highlighted choice, Shift+U cycles it x1 -> x3 -> x5, Esc clears (input.ts).
import { BUILDINGS, UPGRADE_SELECTION_MAX } from '../../sim/config';
import { UPGRADE_LEVEL_CHOICES, type UpgradeBuildingsPreview, type UpgradeLevels } from '../../sim/bulkbuild';
import type { BuildingType, GameState, Player } from '../../sim/types';
import { formatCount } from '../render/common';
import {
  activeCount,
  buildingTypeCounts,
  NO_BUILDING_SEL,
  pruneBuildingSelection,
  selectionPreview,
  toggleBuildingType,
  upgradeSelectionAction,
} from '../selection';
import { el, fmtSeconds, keycap, setClass, setText, setTip, setVisible, type HudCtx } from './dom';
import { iconSpan, lineIcon, worldGlyph } from './glyph';
import './buildingSelection.css';

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** "4,200 gold, 300 iron" (iron left out when 0). */
export function costText(c: { gold: number; iron: number }): string {
  const g = `${formatCount(Math.ceil(c.gold - 1e-6))} gold`;
  return c.iron > 1e-6 ? `${g}, ${formatCount(Math.ceil(c.iron - 1e-6))} iron` : g;
}

/** The bar's cost line for one choice: { text, tone } (tone ok / short = only part affordable / no). */
export function upgradeLine(pv: UpgradeBuildingsPreview | null, levels: UpgradeLevels): { text: string; tone: 'ok' | 'short' | 'no' } {
  if (!pv) return { text: 'Nothing selected', tone: 'no' };
  if (pv.error) {
    if (!/^Not enough/.test(pv.error)) return { text: pv.error, tone: 'no' };
    const what = /iron/.test(pv.error) ? 'iron' : 'gold';
    return { text: `x${levels}: not enough ${what}. The cheapest level costs ${costText(pv.cheapest)}; all ${plural(pv.requested, 'level')} need ${costText(pv.shortBy)} more`, tone: 'no' };
  }
  const what = `x${levels}: ${plural(pv.levelsQueued, 'level')} on ${plural(pv.buildings, 'building')}`;
  const time = pv.seconds <= 0.1 + 1e-9 ? 'done at once' : `done in ${fmtSeconds(pv.seconds)}`;
  if (pv.levelsQueued < pv.requested) {
    return { text: `${what} for ${costText(pv.cost)} (can afford ${pv.levelsQueued} of ${pv.requested}; ${costText(pv.shortBy)} short) · ${time}`, tone: 'short' };
  }
  return { text: `${what} · ${costText(pv.cost)} · ${time}`, tone: 'ok' };
}

export class BuildingSelectionBar {
  readonly el: HTMLElement;
  private head: HTMLElement;
  private chips: HTMLElement;
  private chipKey = '';
  private lv = new Map<UpgradeLevels, { b: HTMLButtonElement; cost: HTMLElement; coin: HTMLElement; key: HTMLElement }>();
  private line: HTMLElement;
  private hint: HTMLElement;

  constructor(private ctx: HudCtx) {
    this.el = el('div', 'bsel hidden');
    this.el.dataset.test = 'building-selection';
    this.el.setAttribute('role', 'region');
    this.el.setAttribute('aria-label', 'Selected buildings');
    this.el.addEventListener('pointerdown', (e) => e.stopPropagation());
    const top = el('div', 'bsel-top');
    this.head = el('span', 'bsel-h');
    this.head.setAttribute('aria-live', 'polite');
    const x = el('button', 'sq bsel-x');
    x.type = 'button';
    x.setAttribute('aria-label', 'Clear the selection (Esc)');
    x.dataset.tip = 'Clear the selection (Esc)';
    x.append(iconSpan(lineIcon('close', 14)));
    x.addEventListener('click', () => (this.ctx.ui.buildingSel = { ...NO_BUILDING_SEL, levels: this.ctx.ui.buildingSel.levels }));
    top.append(iconSpan(lineIcon('upgrade', 16), 'bsel-ic'), this.head, x);
    this.chips = el('div', 'bsel-chips');
    this.chips.setAttribute('aria-label', 'Filter by type');
    const row = el('div', 'bsel-row');
    const label = el('span', 'bsel-l', 'Upgrade');
    const lvs = el('div', 'bsel-lv');
    for (const n of UPGRADE_LEVEL_CHOICES) {
      const b = el('button', 'bsel-up');
      b.type = 'button';
      b.dataset.test = `upgrade-x${n}`;
      const name = el('span', 'bsel-up-n', `x${n}`);
      const key = keycap('U');
      key.classList.add('bsel-k');
      const coin = iconSpan(lineIcon('gold', 12), 'bsel-up-g');
      const cost = el('span', 'bsel-up-c');
      b.append(name, key, coin, cost);
      b.addEventListener('click', () => {
        this.ctx.ui.buildingSel = { ...this.ctx.ui.buildingSel, levels: n };
        this.order(n);
        b.blur();
      });
      this.lv.set(n, { b, cost, coin, key });
      lvs.append(b);
    }
    row.append(label, lvs);
    this.line = el('div', 'bsel-line');
    this.hint = el('div', 'bsel-hint', 'U upgrade · Shift+U x1 / x3 / x5 · Esc clear · Shift+drag a new box to change');
    this.el.append(top, this.chips, row, this.line, this.hint);
  }

  /** Sends the order for the active buildings; toasts why not (the dispatcher toasts sim refusals). */
  order(levels: UpgradeLevels = this.ctx.ui.buildingSel.levels): void {
    const s = this.ctx.state();
    if (!s || !s.humanId) return;
    const a = upgradeSelectionAction(s, s.humanId, this.ctx.ui.buildingSel, levels);
    if (!a) return;
    if (!this.ctx.act(a)) this.ctx.sound('uiError');
  }

  /** Every frame (cheap: the previews are cached). */
  fast(s: GameState | null, me: Player | null): void {
    const ui = this.ctx.ui;
    const live = !!s && !!me && s.phase === 'playing' && me.alive;
    if (live) ui.buildingSel = pruneBuildingSelection(s, me.id, ui.buildingSel);
    const on = live && ui.buildingSel.ids.length > 0;
    setVisible(this.el, on);
    if (!on || !s || !me) return;
    const sel = ui.buildingSel;
    const n = activeCount(s, me.id, sel);
    const total = sel.ids.length;
    const capped = n > UPGRADE_SELECTION_MAX ? ` (the first ${UPGRADE_SELECTION_MAX} get the order)` : '';
    setText(this.head, `${plural(n, 'building')} selected${n < total ? ` of ${total}` : ''}${capped}`);
    this.syncChips(s, me.id);
    let tone: 'ok' | 'short' | 'no' = 'no';
    for (const [lv, x] of this.lv) {
      const pv = selectionPreview(s, me.id, sel, lv);
      const t = upgradeLine(pv, lv);
      const cur = lv === sel.levels;
      setClass(x.b, 'on', cur);
      setClass(x.b, 'no', t.tone === 'no');
      setClass(x.b, 'short', t.tone === 'short');
      x.b.setAttribute('aria-disabled', String(t.tone === 'no'));
      x.b.setAttribute('aria-label', `Upgrade x${lv}${cur ? ' (U)' : ''}: ${t.text}`);
      setVisible(x.key, cur);
      const priced = !!pv && !pv.error;
      setVisible(x.coin, priced);
      setText(x.cost, priced ? formatCount(Math.ceil(pv.cost.gold - 1e-6)) : '–');
      setTip(x.b, `Upgrade x${lv}: up to ${plural(lv, 'more level')} on each selected building, cheapest first, as far as your gold and iron go. Each level still takes its build time.\n${t.text}`);
      if (cur) {
        tone = t.tone;
        setText(this.line, t.text);
      }
    }
    this.el.dataset.tone = tone;
  }

  /** Filter chips, rebuilt only when the counts change. */
  private syncChips(s: GameState, me: number): void {
    const counts = buildingTypeCounts(s, me, this.ctx.ui.buildingSel);
    const key = counts.map((c) => `${c.type}:${c.count}:${c.on ? 1 : 0}`).join('|');
    if (key === this.chipKey) return;
    this.chipKey = key;
    this.chips.textContent = '';
    setVisible(this.chips, counts.length > 1);
    for (const c of counts) {
      const b = el('button', 'bsel-chip');
      b.type = 'button';
      b.dataset.test = `bsel-chip-${c.type}`;
      setClass(b, 'on', c.on);
      b.setAttribute('aria-pressed', String(c.on));
      b.append(iconSpan(worldGlyph(c.type as BuildingType, 16), 'bsel-chip-ic'), el('span', 'bsel-chip-n', BUILDINGS[c.type].name), el('span', 'bsel-chip-c', String(c.count)));
      b.dataset.tip = c.on ? `Leave the ${BUILDINGS[c.type].name}s out` : `Include the ${BUILDINGS[c.type].name}s again`;
      b.addEventListener('click', () => {
        const st = this.ctx.state();
        if (!st) return;
        this.ctx.ui.buildingSel = toggleBuildingType(st, st.humanId, this.ctx.ui.buildingSel, c.type);
        b.blur();
      });
      this.chips.append(b);
    }
  }
}
