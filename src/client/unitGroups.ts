// Unit groups (the Forces drawer's Groups strip, hud/groupsStrip.ts): the player saves a selection of warships and
// tank divisions as a named group ("Fleet 1 · 8 ships"), selects it again with one click, centres the map on it,
// renames it, adds the current selection to it, and deletes it (with undo). Client only: nothing here reaches the sim.
// A unit may sit in more than one group. Dead, sunk or captured units drop out of a group the next time it is read;
// a group with none left stays (greyed, "0") until the player deletes it.
// The data is one plain object per game (UiState.groups) so a saved game can store it as JSON:
// getUnitGroups(ui) / setUnitGroups(ui, data).
import { MAX_GROUP_UNITS } from '../sim/config';
import type { GameState, Unit } from '../sim/types';
import { isCommandable, pruneSelection } from './selection';

/** At most this many groups (the strip stays short). */
export const MAX_UNIT_GROUPS = 12;
/** Names are cut to this many characters. */
export const GROUP_NAME_MAX = 24;

export interface UnitGroup {
  /** stable id within the game (buttons and undo use it) */
  id: number;
  name: string;
  /** unit ids, in the order they joined */
  ids: number[];
}

export interface UnitGroups {
  /** the next group id */
  next: number;
  groups: UnitGroup[];
  /** the last deleted group and where it sat, for Undo (null = nothing to undo) */
  removed: { group: UnitGroup; at: number } | null;
}

export function newUnitGroups(): UnitGroups {
  return { next: 1, groups: [], removed: null };
}

/** A copy for a saved game (plain JSON, the undo slot left out). */
export function exportUnitGroups(g: UnitGroups): UnitGroups {
  return { next: g.next, groups: g.groups.map((x) => ({ id: x.id, name: x.name, ids: [...x.ids] })), removed: null };
}

/** Reads groups back from a saved game; anything malformed is skipped (an empty set at worst). */
export function importUnitGroups(data: unknown): UnitGroups {
  const out = newUnitGroups();
  if (!data || typeof data !== 'object') return out;
  const d = data as { next?: unknown; groups?: unknown };
  if (!Array.isArray(d.groups)) return out;
  for (const raw of d.groups) {
    if (!raw || typeof raw !== 'object' || out.groups.length >= MAX_UNIT_GROUPS) continue;
    const r = raw as { id?: unknown; name?: unknown; ids?: unknown };
    if (typeof r.id !== 'number' || !Number.isInteger(r.id) || out.groups.some((x) => x.id === r.id)) continue;
    const ids = Array.isArray(r.ids) ? r.ids.filter((v): v is number => typeof v === 'number' && Number.isInteger(v)) : [];
    const name = typeof r.name === 'string' ? cleanName(r.name) : '';
    out.groups.push({ id: r.id, name: name || `Group ${r.id}`, ids: [...new Set(ids)].slice(0, MAX_GROUP_UNITS) });
  }
  const top = out.groups.reduce((a, x) => Math.max(a, x.id), 0);
  out.next = Math.max(top + 1, typeof d.next === 'number' && Number.isInteger(d.next) ? d.next : 1);
  return out;
}

/** For a saved game: this game's groups as plain JSON (the getter a save reads). */
export function getUnitGroups(ui: { groups: UnitGroups }): UnitGroups {
  return exportUnitGroups(ui.groups);
}
/** On resume: puts saved groups back (the setter a load calls); bad data gives no groups. */
export function setUnitGroups(ui: { groups: UnitGroups }, data: unknown): void {
  ui.groups = importUnitGroups(data);
}

function cleanName(s: string): string {
  return s.replace(/\s+/g, ' ').trim().slice(0, GROUP_NAME_MAX).trim();
}

function unitsById(state: GameState): Map<number, Unit> {
  const m = new Map<number, Unit>();
  for (const u of state.units) m.set(u.id, u);
  return m;
}

/** Drops units that are gone, sunk or no longer ours from every group; true when something changed. */
export function pruneUnitGroups(g: UnitGroups, state: GameState, me: number): boolean {
  if (!g.groups.length) return false;
  const byId = unitsById(state);
  let changed = false;
  for (const grp of g.groups) {
    const keep = grp.ids.filter((id) => isCommandable(byId.get(id), me));
    if (keep.length !== grp.ids.length) {
      grp.ids = keep;
      changed = true;
    }
  }
  return changed;
}

export interface GroupCounts {
  ships: number;
  divisions: number;
}

/** Live warships and divisions in the group. */
export function groupCounts(state: GameState, me: number, grp: UnitGroup): GroupCounts {
  const byId = unitsById(state);
  const c: GroupCounts = { ships: 0, divisions: 0 };
  for (const id of grp.ids) {
    const u = byId.get(id);
    if (!isCommandable(u, me)) continue;
    if (u.type === 'warship') c.ships++;
    else c.divisions++;
  }
  return c;
}

/** "8 ships", "3 ships, 2 divisions", "1 division"; "0" when none is left. */
export function countText(c: GroupCounts): string {
  const parts: string[] = [];
  if (c.ships) parts.push(`${c.ships} ${c.ships === 1 ? 'ship' : 'ships'}`);
  if (c.divisions) parts.push(`${c.divisions} ${c.divisions === 1 ? 'division' : 'divisions'}`);
  return parts.length ? parts.join(', ') : '0';
}

/** The button text: "Fleet 1 · 8 ships", "Group 2 · 3 ships, 2 divisions", "Tanks 1 · 0". */
export function groupLabel(state: GameState, me: number, grp: UnitGroup): string {
  return `${grp.name} · ${countText(groupCounts(state, me, grp))}`;
}

/** The default name for a new group: Fleet (ships only), Tanks (divisions only) or Group, with the lowest free number. */
export function defaultGroupName(g: UnitGroups, c: GroupCounts): string {
  const base = c.ships && !c.divisions ? 'Fleet' : c.divisions && !c.ships ? 'Tanks' : 'Group';
  const used = new Set(g.groups.map((x) => x.name.toLowerCase()));
  let n = 1;
  while (used.has(`${base} ${n}`.toLowerCase())) n++;
  return `${base} ${n}`;
}

/** The group's live members, ready to become the selection (capped like any selection). */
export function groupSelection(state: GameState, me: number, grp: UnitGroup): number[] {
  return pruneSelection(state, me, grp.ids);
}

/** True when the selection is exactly the group's live members (its button is lit). */
export function isGroupSelected(state: GameState, me: number, grp: UnitGroup, sel: readonly number[]): boolean {
  const live = groupSelection(state, me, grp);
  if (!live.length || live.length !== sel.length) return false;
  const s = new Set(sel);
  return live.every((id) => s.has(id));
}

/** Why "+ New group" can't make a group of this selection now ('' = it can). */
export function newGroupBlock(state: GameState, me: number, g: UnitGroups, sel: readonly number[]): string {
  const ids = pruneSelection(state, me, sel);
  if (!ids.length) return 'Select warships or tank divisions on the map first';
  if (g.groups.length >= MAX_UNIT_GROUPS) return `You have ${MAX_UNIT_GROUPS} groups: delete one first`;
  const same = g.groups.find((x) => isGroupSelected(state, me, x, ids));
  if (same) return `${same.name} has exactly these units already`;
  return '';
}

/** Makes a group of the selected units; returns it, or the reason it can't. */
export function createGroup(g: UnitGroups, state: GameState, me: number, sel: readonly number[]): UnitGroup | string {
  const why = newGroupBlock(state, me, g, sel);
  if (why) return why;
  const ids = pruneSelection(state, me, sel);
  const grp: UnitGroup = { id: g.next++, name: defaultGroupName(g, countsOf(state, me, ids)), ids };
  g.groups.push(grp);
  return grp;
}

function countsOf(state: GameState, me: number, ids: readonly number[]): GroupCounts {
  return groupCounts(state, me, { id: 0, name: '', ids: [...ids] });
}

/** Selected units that are not in the group yet (what "Add selected" would add). */
export function notInGroup(state: GameState, me: number, grp: UnitGroup, sel: readonly number[]): number[] {
  const have = new Set(grp.ids);
  return pruneSelection(state, me, sel).filter((id) => !have.has(id));
}

/** Why the selection can't be added to the group now ('' = it can). */
export function addBlock(state: GameState, me: number, grp: UnitGroup, sel: readonly number[]): string {
  if (!pruneSelection(state, me, sel).length) return `Select units on the map, then click + to add them to ${grp.name}`;
  const add = notInGroup(state, me, grp, sel);
  if (!add.length) return `The selected units are in ${grp.name} already`;
  const live = groupSelection(state, me, grp).length;
  if (live >= MAX_GROUP_UNITS) return `${grp.name} is full (${MAX_GROUP_UNITS} units)`;
  return '';
}

/** Adds the selected units to the group (up to the cap); returns how many joined, or the reason. */
export function addToGroup(g: UnitGroups, state: GameState, me: number, groupId: number, sel: readonly number[]): number | string {
  const grp = g.groups.find((x) => x.id === groupId);
  if (!grp) return 'That group is gone';
  pruneUnitGroups(g, state, me);
  const why = addBlock(state, me, grp, sel);
  if (why) return why;
  const add = notInGroup(state, me, grp, sel).slice(0, MAX_GROUP_UNITS - grp.ids.length);
  grp.ids.push(...add);
  return add.length;
}

/** Renames a group; an empty name keeps the old one. Returns the name it has now. */
export function renameGroup(g: UnitGroups, groupId: number, name: string): string {
  const grp = g.groups.find((x) => x.id === groupId);
  if (!grp) return '';
  const n = cleanName(name);
  if (n) grp.name = n;
  return grp.name;
}

/** Deletes a group; it can come back with undoDelete() until the next delete. */
export function deleteGroup(g: UnitGroups, groupId: number): UnitGroup | null {
  const at = g.groups.findIndex((x) => x.id === groupId);
  if (at < 0) return null;
  const [grp] = g.groups.splice(at, 1);
  g.removed = { group: grp, at };
  return grp;
}

/** Brings the last deleted group back where it was; null when there is nothing to undo. */
export function undoDelete(g: UnitGroups): UnitGroup | null {
  const r = g.removed;
  if (!r) return null;
  g.removed = null;
  if (g.groups.length >= MAX_UNIT_GROUPS) return null;
  g.groups.splice(Math.min(r.at, g.groups.length), 0, r.group);
  return r.group;
}

/** The tile to centre the map on: the live member nearest the group's middle (a fleet over two seas lands on a ship,
 *  not on the land between them). -1 when none is left. */
export function groupFocusTile(state: GameState, me: number, grp: UnitGroup): number {
  const byId = unitsById(state);
  const live: Unit[] = [];
  for (const id of grp.ids) {
    const u = byId.get(id);
    if (isCommandable(u, me)) live.push(u);
  }
  if (!live.length) return -1;
  let mx = 0;
  let my = 0;
  for (const u of live) {
    mx += u.x;
    my += u.y;
  }
  mx /= live.length;
  my /= live.length;
  let best = live[0];
  let bd = Infinity;
  for (const u of live) {
    const d = (u.x - mx) ** 2 + (u.y - my) ** 2;
    if (d < bd) {
      bd = d;
      best = u;
    }
  }
  const w = state.map.width;
  const x = Math.max(0, Math.min(w - 1, Math.round(best.x)));
  const y = Math.max(0, Math.min(state.map.height - 1, Math.round(best.y)));
  return y * w + x;
}
