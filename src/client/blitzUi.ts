// Blitz, the player's side (the rules are sim/blitz.ts; the name the player reads is BLITZ_NAME, one constant):
// the button on the orders bar (hud/ordersBar.ts) for the selected tank division, the target mode (input.ts: the next
// click is where it surges; Esc cancels), the line at the top while aiming (hud.ts) and the wedge preview
// (render/blitzOverlay.ts).
import { blitzBlock, blitzPreview, blitzSecondsLeft } from '../sim/blitz';
import { BLITZ, BLITZ_NAME } from '../sim/config';
import type { ActionResult, GameState, Unit } from '../sim/types';
import type { SpearheadPreview } from '../sim/tanks';
import type { UiState } from './uiState';

/** What the Blitz button shows for the selected divisions: the division it would use, its label and why it is off. */
export interface BlitzButton {
  /** the division the button aims (-1 = none) */
  unitId: number;
  /** plain button text: the name, or the name and why it can't go now */
  label: string;
  /** why it is off ('' = it can go) */
  off: string;
  /** one line of help */
  tip: string;
}

/** The Blitz button for `ids` (own divisions): the first ready one, else the one recharging soonest, with the reason. */
export function blitzButton(state: GameState, me: number, ids: readonly number[]): BlitzButton {
  const tip = `${BLITZ_NAME}: smoke, then a fast, deep, wide push; the land it takes holds ${BLITZ.holdSeconds} s. ${BLITZ.oil} oil, then ${BLITZ.cooldownSeconds} s to recharge.`;
  const mine = ids.map((id) => state.units.find((u) => u.id === id && u.owner === me && u.type === 'tankDivision' && u.hp > 0)).filter((u): u is Unit => !!u);
  if (!mine.length) return { unitId: -1, label: BLITZ_NAME, off: 'Select a tank division', tip };
  const ready = mine.find((u) => blitzBlock(state, me, u) === '');
  if (ready) return { unitId: ready.id, label: BLITZ_NAME, off: '', tip };
  const soonest = mine.slice().sort((a, b) => blitzSecondsLeft(state, a) - blitzSecondsLeft(state, b) || a.id - b.id)[0];
  const off = blitzBlock(state, me, soonest);
  return { unitId: soonest.id, label: `${BLITZ_NAME} · ${off}`, off, tip };
}

/** Enter the target mode for division unitId, or say why not ('' = entered). */
export function enterBlitz(state: GameState, ui: UiState, me: number, unitId: number): string {
  const u = state.units.find((q) => q.id === unitId);
  const off = blitzBlock(state, me, u);
  if (off) return off;
  ui.mode = { kind: 'blitz', unitId };
  ui.pendingSpearhead = null;
  return '';
}

/** The line at the top while aiming. */
export function blitzHint(): string {
  return `${BLITZ_NAME}: click enemy land near your border where the division surges.`;
}

/** The preview for the hovered tile in the blitz mode, or null. */
export function blitzPreviewAt(state: GameState, ui: UiState, tile: number): SpearheadPreview | null {
  if (ui.mode.kind !== 'blitz' || tile < 0) return null;
  return blitzPreview(state, state.humanId, ui.mode.unitId, tile);
}

/** A click in the blitz mode: the order, or the reason it can't go. */
export function blitzClick(state: GameState, ui: UiState, dispatch: (a: { type: 'blitz'; unitId: number; tile: number }) => ActionResult, tile: number): ActionResult {
  if (ui.mode.kind !== 'blitz') return { ok: false, reason: '' };
  const pv = blitzPreview(state, state.humanId, ui.mode.unitId, tile);
  if (pv.reason) return { ok: false, reason: pv.reason };
  return dispatch({ type: 'blitz', unitId: ui.mode.unitId, tile });
}
