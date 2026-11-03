// Groups strip at the top of the Forces drawer (client/unitGroups.ts holds the data and the rules):
//   + New group           saves the selected warships / tank divisions as "Fleet 1 · 8 ships"
//   [Fleet 1 · 8 ships ◎] click: selects the group (lit while it is the selection); click it again to rename it in place
//                         (Save and Cancel buttons while the name is edited); the target icon centres the map on it
//   +  / x                add the selected units to that group / delete it (Undo for a few seconds)
// Everything is a visible button, no hotkeys. Rows are rebuilt only when the list of groups changes; counts and the lit
// state update in place, so buttons keep hover and focus. Nothing here changes the game.
import type { GameState, Player } from '../../sim/types';
import { isCommandable, pruneSelection } from '../selection';
import {
  addBlock,
  addToGroup,
  countText,
  createGroup,
  deleteGroup,
  GROUP_NAME_MAX,
  groupCounts,
  groupFocusTile,
  groupSelection,
  groupTap,
  isGroupSelected,
  newGroupBlock,
  pruneUnitGroups,
  renameGroup,
  undoDelete,
  type UnitGroup,
} from '../unitGroups';
import { el, sectionTitle, setClass, setText, setTip, setVisible, type HudCtx } from './dom';
import { iconSpan, lineIcon } from './glyph';

/** How long Undo stays after a delete (ms). */
const UNDO_MS = 10000;

interface RowEls {
  row: HTMLElement;
  pick: HTMLButtonElement;
  name: HTMLElement;
  count: HTMLElement;
  find: HTMLButtonElement;
  add: HTMLButtonElement;
  del: HTMLButtonElement;
}

/** A button that stays focusable when unavailable and says why when pressed (like the rest of the drawer). */
function setOff(b: HTMLButtonElement, why: string, tip: string): void {
  if ((b.dataset.off ?? '') !== why) b.dataset.off = why;
  const on = !!why;
  if (b.getAttribute('aria-disabled') !== String(on)) b.setAttribute('aria-disabled', String(on));
  setClass(b, 'off', on);
  setTip(b, why || tip);
}

function label(b: HTMLElement, text: string): void {
  if (b.getAttribute('aria-label') !== text) b.setAttribute('aria-label', text);
}

export class GroupsStrip {
  readonly el: HTMLElement;
  private make: HTMLButtonElement;
  private list = el('div', 'ug-list');
  private hint = el('p', 'note ug-hint');
  private undo = el('div', 'ug-undo hidden');
  private undoText = el('span', 'ug-undo-t');
  private rows = new Map<number, RowEls>();
  private key = '';
  /** the group whose name is being edited (-1 = none) */
  private editing = -1;
  /** the group a click picked while it stays the selection: the next click on it renames it (-1 = none) */
  private armed = -1;
  private undoUntil = 0;

  constructor(private ctx: HudCtx) {
    this.el = el('section', 'fgroup ugroups hidden');
    this.el.dataset.test = 'forces-groups';
    const head = el('div', 'fg-head');
    const acts = el('div', 'fg-acts');
    this.make = el('button', 'wr-btn mini ug-make');
    this.make.type = 'button';
    this.make.dataset.test = 'group-new';
    this.make.append(iconSpan(lineIcon('plus', 14, 2)), el('span', 'wr-btn-l', 'New group'));
    this.make.addEventListener('click', () => this.create());
    acts.append(this.make);
    head.append(sectionTitle('Groups'), acts);
    const undoBtn = el('button', 'wr-btn mini ghost ug-undo-b');
    undoBtn.type = 'button';
    undoBtn.dataset.test = 'group-undo';
    undoBtn.append(el('span', 'wr-btn-l', 'Undo'));
    undoBtn.addEventListener('click', () => this.restore());
    this.undo.setAttribute('role', 'status');
    this.undo.append(this.undoText, undoBtn);
    this.list.setAttribute('role', 'list');
    this.el.append(head, this.list, this.undo, this.hint);
  }

  private say(text: string): void {
    this.ctx.toast(text, 'info');
    this.ctx.sound('uiError');
  }
  private groups(): UnitGroup[] {
    return this.ctx.ui.groups.groups;
  }
  private find(id: number): UnitGroup | undefined {
    return this.groups().find((g) => g.id === id);
  }
  /** Rows are rebuilt when this changes: which groups there are and their names. */
  private keyOf(): string {
    return this.groups()
      .map((g) => `${g.id}:${g.name}`)
      .join('|');
  }
  private refresh(): void {
    const s = this.ctx.state();
    const me = this.ctx.me();
    if (s && me) this.update(s, me);
  }

  private create(): void {
    const s = this.ctx.state();
    if (!s) return;
    const why = this.make.dataset.off ?? '';
    if (why) return this.say(why);
    const g = createGroup(this.ctx.ui.groups, s, s.humanId, this.ctx.ui.selection);
    if (typeof g === 'string') return this.say(g);
    // the new group is the selection already: the first click on it must not open the name field
    this.armed = -1;
    this.ctx.sound('uiClick');
    this.ctx.toast(`${g.name}: ${countText(groupCounts(s, s.humanId, g))}. Click it to select them again.`, 'good');
    this.refresh();
  }

  /** Click on a group: selects it; on the group that is already selected, edits its name. */
  private pick(id: number): void {
    const s = this.ctx.state();
    const g = this.find(id);
    if (!s || !g) return;
    const ui = this.ctx.ui;
    const ids = groupSelection(s, s.humanId, g);
    if (!ids.length) return this.say(`No units left in ${g.name}. Delete it, or select units and click + to fill it.`);
    const tap = groupTap(isGroupSelected(s, s.humanId, g, ui.selection), this.armed === id);
    if (tap === 'rename') return this.edit(id);
    this.armed = id;
    if (tap === 'arm') {
      this.ctx.sound('uiClick');
      return this.refresh();
    }
    ui.mode = { kind: 'none' };
    ui.selection = ids;
    ui.pendingSpearhead = null;
    ui.contextMenu = null;
    this.ctx.sound('uiClick');
    this.refresh();
  }

  private focus(id: number): void {
    const s = this.ctx.state();
    const g = this.find(id);
    if (!s || !g) return;
    const t = groupFocusTile(s, s.humanId, g);
    if (t < 0) return this.say(`No units left in ${g.name}`);
    this.ctx.focusTile(t, false);
  }

  private add(id: number, b: HTMLButtonElement): void {
    const s = this.ctx.state();
    const g = this.find(id);
    if (!s || !g) return;
    const why = b.dataset.off ?? '';
    if (why) return this.say(why);
    const n = addToGroup(this.ctx.ui.groups, s, s.humanId, id, this.ctx.ui.selection);
    if (typeof n === 'string') return this.say(n);
    this.ctx.sound('uiClick');
    this.ctx.toast(`${n} added to ${g.name}`, 'good');
    this.refresh();
  }

  private remove(id: number): void {
    const g = deleteGroup(this.ctx.ui.groups, id);
    if (!g) return;
    if (this.editing === id) this.editing = -1;
    this.ctx.sound('uiClick');
    setText(this.undoText, `${g.name} deleted.`);
    this.undoUntil = performance.now() + UNDO_MS;
    this.refresh();
  }

  private restore(): void {
    const g = undoDelete(this.ctx.ui.groups);
    this.undoUntil = 0;
    if (!g) return this.say('Nothing to undo');
    this.ctx.sound('uiClick');
    this.refresh();
  }

  /** Turns the group's button into a text field with Save and Cancel next to it (Enter and Esc work too; leaving the
   *  field keeps the name, as Save does). */
  private edit(id: number): void {
    const r = this.rows.get(id);
    const g = this.find(id);
    if (!r || !g) return;
    this.editing = id;
    const input = el('input', 'ug-edit');
    input.type = 'text';
    input.value = g.name;
    input.maxLength = GROUP_NAME_MAX;
    input.dataset.test = 'group-name';
    input.setAttribute('aria-label', `New name for ${g.name}`);
    input.spellcheck = false;
    // visible buttons for touch screens (no Esc key there): they replace + and x while the name is edited
    const save = el('button', 'wr-btn mini primary ug-save');
    save.type = 'button';
    save.dataset.test = 'group-name-save';
    save.append(el('span', 'wr-btn-l', 'Save'));
    const cancel = el('button', 'wr-btn mini ghost ug-cancel');
    cancel.type = 'button';
    cancel.dataset.test = 'group-name-cancel';
    cancel.append(el('span', 'wr-btn-l', 'Cancel'));
    // the field loses focus before the button's click lands: the press says which one it was
    let pressed: 'save' | 'cancel' | null = null;
    save.addEventListener('pointerdown', () => (pressed = 'save'));
    cancel.addEventListener('pointerdown', () => (pressed = 'cancel'));
    save.addEventListener('click', () => finish(true, true));
    cancel.addEventListener('click', () => finish(false, true));
    let done = false;
    // swaps the button back in place (no rebuild: a click on another group that ended the edit still lands)
    const finish = (keep: boolean, refocus: boolean): void => {
      if (done) return;
      done = true;
      const name = keep ? renameGroup(this.ctx.ui.groups, id, input.value) : '';
      if (name) setText(r.name, name);
      if (input.isConnected) input.replaceWith(r.pick);
      save.remove();
      cancel.remove();
      r.row.classList.remove('editing');
      this.editing = -1;
      this.key = this.keyOf(); // the rows show the new name already
      this.refresh();
      if (refocus) r.pick.focus();
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        finish(true, true);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        finish(false, true);
      }
    });
    input.addEventListener('blur', () => finish(pressed !== 'cancel', pressed !== null));
    r.pick.replaceWith(input);
    r.row.classList.add('editing');
    r.row.append(save, cancel);
    input.focus();
    input.select();
  }

  private build(): void {
    this.rows.clear();
    const rows = this.groups().map((g) => {
      const row = el('div', 'ug-row');
      row.setAttribute('role', 'listitem');
      row.dataset.test = 'group-row';
      row.dataset.gid = String(g.id);
      const chip = el('div', 'ug-chip');
      const pick = el('button', 'ug-pick');
      pick.type = 'button';
      pick.dataset.test = 'group-pick';
      const name = el('span', 'ug-name', g.name);
      const count = el('span', 'ug-n');
      pick.append(name, el('span', 'ug-dot', '·'), count);
      pick.addEventListener('click', () => this.pick(g.id));
      const find = el('button', 'ug-find');
      find.type = 'button';
      find.dataset.test = 'group-find';
      setTip(find, 'Show on the map');
      find.append(iconSpan(lineIcon('target', 15, 2)));
      find.addEventListener('click', () => this.focus(g.id));
      chip.append(pick, find);
      const add = el('button', 'wr-btn mini ghost icon ug-add');
      add.type = 'button';
      add.dataset.test = 'group-add';
      add.append(iconSpan(lineIcon('plus', 14, 2)));
      add.addEventListener('click', () => this.add(g.id, add));
      const del = el('button', 'wr-btn mini ghost icon ug-del');
      del.type = 'button';
      del.dataset.test = 'group-delete';
      del.append(iconSpan(lineIcon('close', 14, 2)));
      del.addEventListener('click', () => this.remove(g.id));
      row.append(chip, add, del);
      this.rows.set(g.id, { row, pick, name, count, find, add, del });
      return row;
    });
    this.list.replaceChildren(...rows);
  }

  update(s: GameState, me: Player): void {
    const ui = this.ctx.ui;
    const data = ui.groups;
    pruneUnitGroups(data, s, me.id);
    const groups = data.groups;
    const hasUnits = groups.length > 0 || s.units.some((u) => isCommandable(u, me.id));
    setVisible(this.el, hasUnits);
    if (!hasUnits) return;

    const key = this.keyOf();
    if (key !== this.key && this.editing < 0) {
      this.key = key;
      this.build();
    }

    const sel = ui.selection;
    const n = pruneSelection(s, me.id, sel).length;
    setOff(this.make, newGroupBlock(s, me.id, data, sel), `Make a group of the ${n === 1 ? 'selected unit' : `${n} selected units`}`);

    let lit: UnitGroup | null = null;
    for (const g of groups) {
      const r = this.rows.get(g.id);
      if (!r) continue;
      const c = groupCounts(s, me.id, g);
      const empty = !c.ships && !c.divisions;
      const on = !empty && isGroupSelected(s, me.id, g, sel);
      if (on) lit = g;
      else if (this.armed === g.id) this.armed = -1;
      setText(r.count, countText(c));
      setClass(r.row, 'on', on);
      setClass(r.row, 'empty', empty);
      if (r.pick.getAttribute('aria-pressed') !== String(on)) r.pick.setAttribute('aria-pressed', String(on));
      const armed = on && this.armed === g.id;
      setTip(r.pick, empty ? `No units left in ${g.name}` : armed ? 'Selected. Click again to rename' : on ? `${g.name} is selected` : `Select ${g.name}`);
      setClass(r.find, 'off', empty);
      // names change in place on a rename, so the labels follow here
      label(r.find, `Show ${g.name} on the map`);
      label(r.add, `Add the selected units to ${g.name}`);
      label(r.del, `Delete ${g.name}`);
      setTip(r.del, `Delete ${g.name} (the units stay)`);
      setOff(r.add, addBlock(s, me.id, g, sel), `Add the selected units to ${g.name}`);
    }

    const undoOn = !!data.removed && performance.now() < this.undoUntil;
    setVisible(this.undo, undoOn);
    setText(
      this.hint,
      this.editing >= 0
        ? 'Type a new name, then Save. Cancel keeps the old one.'
        : !groups.length
        ? 'Select ships or tank divisions on the map, then New group. One click on a group selects them again.'
        : lit
          ? this.armed === lit.id
            ? `${lit.name} selected: click it again to rename it.`
            : `${lit.name} selected. To rename it, click it twice.`
          : 'Click a group to select it. The target shows it on the map.',
    );
  }
}
