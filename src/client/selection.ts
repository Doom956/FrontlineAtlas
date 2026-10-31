// Selecting and ordering your own warships and tank divisions (client only; the rules stay in the sim).
//   - click one of your units: select it; Shift+click adds / removes it; Shift+drag a box: select all inside
//     (input.ts); Shift+W selects every warship, Shift+A every tank division; Esc clears
//   - with a selection, a click on water sends the warships (moveWarships, one action for the group); a click on
//     your own land drives the divisions there (moveTankDivision); a click on enemy or neutral land next to your
//     border shows the spearhead preview (spearheadPreview) and a second click on it launches the spearhead
//   - warship orders: "Warship" enters the click-to-place mode (spawnWarship): click water near one of your ports
//     (WARSHIP_SPAWN_RANGE, same sea); the valid area is shaded (render/selectionOverlay.ts)
//   - tank divisions are built at a Factory: enterTankDivisionBuildMode(), then click one of your factories
//   - the same Shift+drag box also picks your buildings in it (ui.buildingSel): filter chips by type, and the bar
//     (hud/buildingSelection.ts) orders Upgrade x1 / x3 / x5 for them all (Action upgradeBuildings; U, Shift+U cycles)
// Everything here reads the state and builds actions; nothing changes the game except through dispatch.
import { buildingAt } from '../sim/buildings';
import { BUILDING_ORDER, MAX_GROUP_UNITS, UPGRADE_SELECTION_MAX, WARSHIP_SPAWN_RANGE } from '../sim/config';
import { sameWater } from '../sim/grid';
import { canOrderWarship } from '../sim/navy';
import { bestFactory, canBuildTankDivision, spearheadPreview, type SpearheadPreview } from '../sim/tanks';
import { isWater } from '../sim/types';
import { upgradeBuildingsPreview, type UpgradeBuildingsPreview, type UpgradeLevels } from '../sim/bulkbuild';
import type { Action, Building, BuildingType, GameState, NavalVariant, Player, Unit } from '../sim/types';
import { unitBuildStatus } from './forces';
import { pocketLine, pocketPreview } from './pillars';
import type { Dispatch, UiState } from './uiState';

/** A spearhead preview older than this waits for a fresh click (ms). */
export const SPEARHEAD_CONFIRM_MS = 8000;

export type CommandableType = 'warship' | 'tankDivision';

/** An own unit the selection can hold (alive warship or tank division of `me`). */
export function isCommandable(u: Unit | undefined, me: number): u is Unit {
  return !!u && u.owner === me && u.hp > 0 && (u.type === 'warship' || u.type === 'tankDivision');
}

function unitById(state: GameState): Map<number, Unit> {
  const m = new Map<number, Unit>();
  for (const u of state.units) m.set(u.id, u);
  return m;
}

/** The selection without units that are gone, captured or not ours (same order, no duplicates, capped). */
export function pruneSelection(state: GameState, me: number, sel: readonly number[]): number[] {
  if (!sel.length) return sel as number[];
  const byId = unitById(state);
  const out: number[] = [];
  const seen = new Set<number>();
  for (const id of sel) {
    if (seen.has(id) || !isCommandable(byId.get(id), me)) continue;
    seen.add(id);
    out.push(id);
    if (out.length >= MAX_GROUP_UNITS) break;
  }
  return out.length === sel.length ? (sel as number[]) : out;
}

/** Shift+click: adds the unit, or removes it when it was selected already. */
export function toggleInSelection(sel: readonly number[], id: number): number[] {
  return sel.includes(id) ? sel.filter((x) => x !== id) : [...sel, id].slice(-MAX_GROUP_UNITS);
}

/** Box selection: the own units found in the box; with `add` they join the current selection. */
export function boxSelection(state: GameState, me: number, current: readonly number[], inBox: readonly number[], add: boolean): number[] {
  const base = add ? [...current] : [];
  for (const id of inBox) if (!base.includes(id)) base.push(id);
  return pruneSelection(state, me, base);
}

/** Every own unit of a type (Shift+W warships, Shift+A tank divisions), oldest first, capped. */
export function selectAllOf(state: GameState, me: number, type: CommandableType): number[] {
  const out: number[] = [];
  for (const u of state.units) if (u.type === type && isCommandable(u, me)) out.push(u.id);
  out.sort((a, b) => a - b);
  return out.slice(0, MAX_GROUP_UNITS);
}

export interface SelectionCounts {
  warships: number[];
  tanks: number[];
}
export function splitSelection(state: GameState, me: number, sel: readonly number[]): SelectionCounts {
  const byId = unitById(state);
  const out: SelectionCounts = { warships: [], tanks: [] };
  for (const id of sel) {
    const u = byId.get(id);
    if (!isCommandable(u, me)) continue;
    if (u.type === 'warship') out.warships.push(id);
    else out.tanks.push(id);
  }
  return out;
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** "3 warships selected", "1 tank division selected", "2 warships, 1 tank division selected" ('' = none). */
export function selectionText(c: SelectionCounts): string {
  const parts: string[] = [];
  if (c.warships.length) parts.push(plural(c.warships.length, 'warship', 'warships'));
  if (c.tanks.length) parts.push(plural(c.tanks.length, 'tank division', 'tank divisions'));
  return parts.length ? `${parts.join(', ')} selected` : '';
}

/** Owner of a land tile as the spearhead sees it: true when the tile is land of someone else (or neutral). */
function foreignLand(state: GameState, me: number, tile: number): boolean {
  return tile >= 0 && tile < state.map.owner.length && !isWater(state.map.terrain[tile]) && state.map.owner[tile] !== me;
}

/** The division a spearhead preview is computed for: the first selected one that can take orders. */
export function leadDivision(state: GameState, me: number, sel: readonly number[]): Unit | null {
  const byId = unitById(state);
  for (const id of sel) {
    const u = byId.get(id);
    if (isCommandable(u, me) && u.type === 'tankDivision' && u.state !== 3) return u;
  }
  return null;
}

const previewCache = new WeakMap<GameState, { key: string; p: SpearheadPreview }>();
/** spearheadPreview for the lead division toward tile, cached per tick (the overlay asks every frame). */
export function previewFor(state: GameState, me: number, sel: readonly number[], tile: number): SpearheadPreview | null {
  if (!foreignLand(state, me, tile)) return null;
  const lead = leadDivision(state, me, sel);
  if (!lead) return null;
  const key = `${lead.id}:${tile}:${state.tick}`;
  const c = previewCache.get(state);
  if (c && c.key === key) return c.p;
  const p = spearheadPreview(state, me, lead.id, tile);
  previewCache.set(state, { key, p });
  return p;
}

/** One line about a spearhead preview: "Spearhead: about 12 tiles deep. Mountains ahead: spearhead will stall". */
export function spearheadLine(p: SpearheadPreview): string {
  if (p.reason) return p.reason;
  const depth = `Spearhead: about ${plural(p.expectedDepth, 'tile', 'tiles')} deep`;
  return p.warnings.length ? `${depth}. ${p.warnings.slice(0, 2).join('. ')}` : depth;
}

/** What a click on `tile` does with the current selection. */
export type SelectionOrder =
  | { kind: 'act'; actions: Action[]; spearhead: boolean }
  | { kind: 'preview'; tile: number; line: string }
  | { kind: 'refuse'; reason: string }
  /** the click isn't for the selection (it clears it and the click works as usual) */
  | { kind: 'pass' };

/**
 * The order a left click on `tile` gives the selection. Water: the warships sail there (one moveWarships).
 * Own land: the divisions drive there. Enemy / neutral land: a spearhead, confirmed by a second click on (or next to)
 * the same tile while the preview shows (`pending`).
 */
export function orderForClick(state: GameState, me: number, sel: readonly number[], tile: number, pending: UiState['pendingSpearhead'], now: number): SelectionOrder {
  if (tile < 0 || tile >= state.map.owner.length) return { kind: 'refuse', reason: 'Click on the map' };
  const c = splitSelection(state, me, sel);
  if (!c.warships.length && !c.tanks.length) return { kind: 'pass' };
  if (isWater(state.map.terrain[tile])) {
    if (!c.warships.length) return { kind: 'refuse', reason: 'Tank divisions move on land. Esc clears the selection' };
    return { kind: 'act', actions: [{ type: 'moveWarships', unitIds: c.warships.slice(0, MAX_GROUP_UNITS), tile }], spearhead: false };
  }
  if (!c.tanks.length) {
    // ships only: a click on your own land just drops the selection; on foreign land it says why nothing happens
    if (state.map.owner[tile] === me) return { kind: 'pass' };
    return { kind: 'refuse', reason: 'Warships move on water. Esc clears the selection' };
  }
  const ids = c.tanks.slice(0, MAX_GROUP_UNITS);
  if (state.map.owner[tile] === me) return { kind: 'act', actions: [{ type: 'moveTankDivision', unitIds: ids, tile }], spearhead: false };
  const p = previewFor(state, me, sel, tile);
  if (!p || p.reason) return { kind: 'refuse', reason: p?.reason || 'No division can take orders now' };
  const w = state.map.width;
  const near = pending && now - pending.at < SPEARHEAD_CONFIRM_MS && Math.abs((pending.tile % w) - (tile % w)) <= 2 && Math.abs(((pending.tile / w) | 0) - ((tile / w) | 0)) <= 2;
  if (near) return { kind: 'act', actions: [{ type: 'moveTankDivision', unitIds: ids, tile: pending!.tile }], spearhead: true };
  return { kind: 'preview', tile, line: spearheadLine(p) };
}

/**
 * Handles a left click while units are selected (input.ts, no target mode). True when the click was used (an order,
 * a preview or a refusal); false when it should work as a normal click (the selection is dropped then).
 */
export function selectionClick(state: GameState, ui: UiState, dispatch: Dispatch, tile: number, toast: (text: string) => void, now = performance.now()): boolean {
  const me = state.humanId;
  ui.selection = pruneSelection(state, me, ui.selection);
  if (!ui.selection.length) return false;
  const o = orderForClick(state, me, ui.selection, tile, ui.pendingSpearhead, now);
  switch (o.kind) {
    case 'pass':
      ui.selection = [];
      ui.pendingSpearhead = null;
      return false;
    case 'refuse':
      toast(o.reason);
      return true;
    case 'preview':
      ui.pendingSpearhead = { tile: o.tile, at: now };
      return true;
    case 'act':
      ui.pendingSpearhead = null;
      for (const a of o.actions) dispatch(a);
      return true;
  }
}

/** Chip text for the selection (or the waiting spearhead); '' when nothing is selected. */
export function selectionChipText(state: GameState, ui: UiState, now = performance.now()): string {
  const me = state.humanId;
  const c = splitSelection(state, me, ui.selection);
  const head = selectionText(c);
  if (!head) return '';
  const pend = ui.pendingSpearhead;
  if (pend && now - pend.at < SPEARHEAD_CONFIRM_MS && c.tanks.length) {
    const p = previewFor(state, me, ui.selection, pend.tile);
    if (p && !p.reason) {
      const pocket = pocketLine(state, pocketPreview(state, me, p));
      return `${spearheadLine(p)}${pocket ? `. ${pocket}` : ''}. Click again to launch, Esc to cancel.`;
    }
  }
  const what = c.warships.length && c.tanks.length ? 'click water or land to move them, or give orders below' : c.warships.length ? 'click water to move, or pick a stance below' : 'click your land to move, enemy land to spearhead, or pick a mode below';
  return `${head}: ${what}. Esc clears.`;
}

// ------------------------------------------------------------------------------------------------ warship orders

/** Can a warship be placed on this water tile now? ok with the port that builds it, or the reason. */
export function warshipSpawnCheck(state: GameState, me: number, tile: number): { ok: boolean; reason: string; port: number } {
  const r = canOrderWarship(state, me, -1, tile);
  return { ok: r.ok, reason: r.ok ? '' : r.reason ?? 'Not possible here', port: r.port ?? -1 };
}

/** The buildWarship action for a click on `tile` in the spawn mode, or the reason it can't go there. */
export function spawnWarshipAction(state: GameState, me: number, tile: number, variant?: NavalVariant): Action | string {
  const c = warshipSpawnCheck(state, me, tile);
  if (c.ok && variant) {
    const r = canOrderWarship(state, me, c.port, tile, variant);
    if (!r.ok) return r.reason ?? 'Not possible here';
  }
  return c.ok ? { type: 'buildWarship', port: c.port, tile, ...(variant ? { variant } : {}) } : c.reason;
}

/** "Warship" buttons: enter the click-to-place mode; returns '' or why a warship can't be ordered at all now. */
export function enterWarshipSpawnMode(ui: UiState, state: GameState, me: Player, variant?: NavalVariant): string {
  const st = unitBuildStatus(state, me, 'warship');
  if (!st.ok) return st.line;
  ui.contextMenu = null;
  ui.mode = variant ? { kind: 'spawnWarship', variant } : { kind: 'spawnWarship' };
  return '';
}

/**
 * Water tiles where a warship can be placed now (shaded in the spawn mode): within WARSHIP_SPAWN_RANGE of one of your
 * finished ports, on a sea that port reaches. A mask over the bounding box (x0, y0, w, h); null when there is none.
 */
export function warshipSpawnArea(state: GameState, me: number): { x0: number; y0: number; w: number; h: number; mask: Uint8Array } | null {
  const map = state.map;
  const W = map.width;
  const R = WARSHIP_SPAWN_RANGE;
  const ports: number[] = [];
  for (const b of state.buildings.values()) if (b.type === 'port' && b.owner === me && b.buildLeft <= 0) ports.push(b.tile);
  if (!ports.length) return null;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const t of ports) {
    const x = t % W;
    const y = (t / W) | 0;
    x0 = Math.min(x0, Math.max(0, x - R));
    y0 = Math.min(y0, Math.max(0, y - R));
    x1 = Math.max(x1, Math.min(W - 1, x + R));
    y1 = Math.max(y1, Math.min(map.height - 1, y + R));
  }
  const w = x1 - x0 + 1;
  const h = y1 - y0 + 1;
  const mask = new Uint8Array(w * h);
  let any = false;
  for (const p of ports) {
    const px = p % W;
    const py = (p / W) | 0;
    for (let y = Math.max(0, py - R); y <= Math.min(map.height - 1, py + R); y++) {
      for (let x = Math.max(0, px - R); x <= Math.min(W - 1, px + R); x++) {
        const k = (y - y0) * w + (x - x0);
        if (mask[k]) continue;
        if ((x - px) ** 2 + (y - py) ** 2 > R * R) continue;
        const t = y * W + x;
        if (!isWater(map.terrain[t]) || !sameWater(map, p, t)) continue;
        mask[k] = 1;
        any = true;
      }
    }
  }
  return any ? { x0, y0, w, h, mask } : null;
}

// ------------------------------------------------------------------------------------------------ tank divisions

/**
 * "Tank division" (Military build menu, Forces drawer): enters the factory click mode. Returns '' or why no division
 * can be built now (checked at the best factory, so the reason is the real one: tech, limit, money, armor).
 */
export function enterTankDivisionBuildMode(ui: UiState, state: GameState, me: Player): string {
  const f = bestFactory(state, me.id);
  if (f < 0) return 'Build a Factory first: tank divisions are built at one';
  const r = canBuildTankDivision(state, me.id, f);
  if (!r.ok) return r.reason ?? 'Not possible now';
  ui.contextMenu = null;
  ui.mode = { kind: 'buildTankDivision' };
  return '';
}

/** Builds a division at your best factory at once (no click); returns '' or the reason. */
export function buildTankDivisionAuto(state: GameState, me: Player, dispatch: Dispatch): string {
  const f = bestFactory(state, me.id);
  if (f < 0) return 'Build a Factory first: tank divisions are built at one';
  const r = dispatch({ type: 'buildTankDivision', tile: f });
  return r.ok ? '' : r.reason ?? 'Not possible now';
}

/** The buildTankDivision action for a click near one of your factories (within 2 tiles), or the reason. */
export function tankDivisionClickAction(state: GameState, me: number, tile: number): Action | string {
  const map = state.map;
  const w = map.width;
  const x = tile % w;
  const y = (tile / w) | 0;
  let best = -1;
  let bd = Infinity;
  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      const xx = x + dx;
      const yy = y + dy;
      if (xx < 0 || yy < 0 || xx >= w || yy >= map.height) continue;
      const t = yy * w + xx;
      const b = buildingAt(state, t);
      if (!b || b.type !== 'factory' || b.owner !== me) continue;
      const d = dx * dx + dy * dy;
      if (d < bd) {
        bd = d;
        best = t;
      }
    }
  }
  if (best < 0) return 'Click one of your Factories';
  const r = canBuildTankDivision(state, me, best);
  return r.ok ? { type: 'buildTankDivision', tile: best } : r.reason ?? 'Not possible here';
}

// ------------------------------------------------------------------------------------------------ building selection

export type BuildingSel = UiState['buildingSel'];
export const NO_BUILDING_SEL: BuildingSel = { ids: [], off: [], levels: 1 };

/** Own buildings whose tile lies in the tile rectangle (corners in tile coords, any order, inclusive), ids ascending. */
export function buildingsInRect(state: GameState, me: number, ax: number, ay: number, bx: number, by: number): number[] {
  const w = state.map.width;
  const x0 = Math.floor(Math.min(ax, bx));
  const x1 = Math.floor(Math.max(ax, bx));
  const y0 = Math.floor(Math.min(ay, by));
  const y1 = Math.floor(Math.max(ay, by));
  const out: number[] = [];
  for (const b of state.buildings.values()) {
    if (b.owner !== me || me <= 0) continue;
    const x = b.tile % w;
    const y = (b.tile / w) | 0;
    if (x >= x0 && x <= x1 && y >= y0 && y <= y1) out.push(b.id);
  }
  return out.sort((a, b) => a - b);
}

/** The new building selection after a box (replaces the old one; the levels choice stays). */
export function boxBuildingSelection(state: GameState, me: number, prev: BuildingSel, ax: number, ay: number, bx: number, by: number): BuildingSel {
  return { ids: buildingsInRect(state, me, ax, ay, bx, by), off: [], levels: prev.levels };
}

/** The selected buildings that are still there and still yours (selection order). */
export function selectedBuildings(state: GameState, me: number, sel: BuildingSel): Building[] {
  const out: Building[] = [];
  for (const id of sel.ids) {
    const b = state.buildings.get(id);
    if (b && b.owner === me) out.push(b);
  }
  return out;
}

/** The selection without buildings that are gone or lost (same object when nothing changed). */
export function pruneBuildingSelection(state: GameState, me: number, sel: BuildingSel): BuildingSel {
  if (!sel.ids.length) return sel;
  const ids = selectedBuildings(state, me, sel).map((b) => b.id);
  return ids.length === sel.ids.length ? sel : { ...sel, ids };
}

/** Selected buildings per type (BUILDING_ORDER), with whether the filter chip has the type on. */
export function buildingTypeCounts(state: GameState, me: number, sel: BuildingSel): { type: BuildingType; count: number; on: boolean }[] {
  const n = new Map<BuildingType, number>();
  for (const b of selectedBuildings(state, me, sel)) n.set(b.type, (n.get(b.type) ?? 0) + 1);
  return BUILDING_ORDER.filter((t) => n.has(t)).map((t) => ({ type: t, count: n.get(t)!, on: !sel.off.includes(t) }));
}

/** Filter chip: switches one type on / off (all on again when the last one would go off). */
export function toggleBuildingType(state: GameState, me: number, sel: BuildingSel, type: BuildingType): BuildingSel {
  const off = sel.off.includes(type) ? sel.off.filter((t) => t !== type) : [...sel.off, type];
  const types = buildingTypeCounts(state, me, sel).map((c) => c.type);
  return { ...sel, off: types.every((t) => off.includes(t)) ? [] : off };
}

/** The buildings the bar acts on: selected, still yours, type switched on; at most UPGRADE_SELECTION_MAX. */
export function activeBuildings(state: GameState, me: number, sel: BuildingSel): Building[] {
  return selectedBuildings(state, me, sel).filter((b) => !sel.off.includes(b.type)).slice(0, UPGRADE_SELECTION_MAX);
}
/** Selected and switched on, before the order cap (the bar says when the cap cuts some off). */
export function activeCount(state: GameState, me: number, sel: BuildingSel): number {
  let n = 0;
  for (const b of selectedBuildings(state, me, sel)) if (!sel.off.includes(b.type)) n++;
  return n;
}

/** Action upgradeBuildings for the active buildings, or null when none is active. */
export function upgradeSelectionAction(state: GameState, me: number, sel: BuildingSel, levels: UpgradeLevels = sel.levels): Action | null {
  const tiles = activeBuildings(state, me, sel).map((b) => b.tile);
  return tiles.length ? { type: 'upgradeBuildings', tiles, levels } : null;
}

/** Shift+U: x1 -> x3 -> x5 -> x1. */
export function nextUpgradeLevels(l: UpgradeLevels): UpgradeLevels {
  return l === 1 ? 3 : l === 3 ? 5 : 1;
}

const upCache = new WeakMap<GameState, Map<UpgradeLevels, { key: string; pv: UpgradeBuildingsPreview }>>();
/** upgradeBuildingsPreview for the active buildings, cached for a few ticks per levels choice (the bar shows x1 / x3 /
 *  x5 side by side and asks every frame). */
export function selectionPreview(state: GameState, me: number, sel: BuildingSel, levels: UpgradeLevels): UpgradeBuildingsPreview | null {
  const a = upgradeSelectionAction(state, me, sel, levels);
  if (!a || a.type !== 'upgradeBuildings') return null;
  const p = state.players[me];
  const key = `${me}|${a.tiles.join(',')}|${Math.floor(state.tick / 3)}|${state.buildingsVersion}|${Math.floor(p?.gold ?? 0)}|${Math.floor(p?.iron ?? 0)}`;
  let m = upCache.get(state);
  if (!m) upCache.set(state, (m = new Map()));
  const c = m.get(levels);
  if (c && c.key === key) return c.pv;
  const pv = upgradeBuildingsPreview(state, me, a.tiles, levels);
  m.set(levels, { key, pv });
  return pv;
}
