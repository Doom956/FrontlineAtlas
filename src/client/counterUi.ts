// Defense Mastery on the client (the rules are the sim's: sim/counter.ts): the Counteroffensive meter in plain words
// for the top-bar chip, the Fort card and the bottom bar's Counteroffensive button, and the Hardened shelters line of
// the atom bomb preview. Nothing here launches by itself: only the button does.
import { COUNTER } from '../sim/config';
import { counterBlock, counterMeter, counterSecondsLeft, counterTroops, shelterPreview } from '../sim/counter';
import { hasTech } from '../sim/tech';
import type { GameState, Player } from '../sim/types';
import { formatCount } from './render/common';

/** The plain name of the order (the button's word is "Counter"). */
export const COUNTER_NAME = 'Counteroffensive';

/** The meter in words: shown at all (Defense Mastery), the percent, full, and a one-line state. */
export interface CounterInfo {
  show: boolean;
  pct: number;
  full: boolean;
  running: number;
  /** the chip text: "Counter 60%", "Counter ready", "Counter 12 s" */
  chip: string;
  /** what the meter means and what a launch does (tooltips, the Fort card) */
  line: string;
  /** why the button is off ('' = it can launch) */
  why: string;
}

export function counterInfo(state: GameState, me: Player): CounterInfo {
  const out: CounterInfo = { show: false, pct: 0, full: false, running: 0, chip: '', line: '', why: '' };
  if (!hasTech(me, 'defenseMastery')) return out;
  out.show = true;
  const m = counterMeter(state, me.id);
  out.pct = Math.floor(m * 100);
  out.full = m >= 1;
  out.running = Math.ceil(counterSecondsLeft(state, me.id));
  out.why = counterBlock(state, me.id);
  const foe = me.counterFoe ? state.players[me.counterFoe] : undefined;
  const t = counterTroops(state, me.id);
  const n = formatCount(t.infantry + t.armor + t.artillery);
  const push = `${Math.round(COUNTER.troopShare * 100)}% of your troops at home (${n}) and your idle tank divisions near a Fort push out, ${Math.round((COUNTER.speedMul - 1) * 100)}% faster and losing ${Math.round((1 - COUNTER.lossMul) * 100)}% fewer troops for ${COUNTER.seconds} s`;
  if (out.running > 0) {
    out.chip = `Counter ${out.running} s`;
    out.line = `Counteroffensive under way against ${foe?.name ?? 'the attacker'}: ${out.running} s left`;
  } else if (out.full) {
    out.chip = 'Counter ready';
    out.line = `Your forts held. ${COUNTER_NAME} ready against ${foe?.name ?? 'the attacker'}: ${push}.`;
  } else {
    out.chip = `Counter ${out.pct}%`;
    out.line = `${COUNTER_NAME} meter ${out.pct}%: it fills when enemy attacks lose troops on land your Forts cover. Full: ${push}.`;
  }
  return out;
}

/**
 * The Hardened shelters line of an atom bomb aimed at `tile` (radius r): '' when no land there is sheltered. Shown in
 * the aiming preview (render/overlays.ts) with the sheltered tiles shaded.
 */
export function shelterLine(state: GameState, tile: number, r: number): { line: string; mask: number[] } {
  const p = shelterPreview(state, tile, r);
  if (!p.tiles) return { line: '', mask: [] };
  const who = p.owners.map((o) => (o === state.humanId ? 'your' : `${state.players[o].name}'s`)).join(' and ');
  const half = Math.round(COUNTER.shelterMul * 100);
  return { line: `Hardened shelters: ${who} forts cover ${p.tiles} tiles here: ${half}% troop losses, ${p.buildings} building${p.buildings === 1 ? '' : 's'} take ${half}% damage`, mask: p.mask };
}
