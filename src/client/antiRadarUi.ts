// Anti-radar Missiles on the client (the rules are the sim's: sim/antiRadar.ts):
//   - antiRadarButton(): the airfield card's "Anti-radar strike" button: ready, or exactly why not ("SAM radar is off:
//     wait until it fires", "Reloading 8 s", "Needs Anti-radar Missiles"), with the price
//   - aimAntiRadar(): enters the target mode (TargetMode 'antiRadar'); the next click on an enemy SAM site fires
//   - antiRadarSams(): the seen enemy SAM sites in reach with their radar state (drawn while aiming: green = on)
// A human's missiles fly only from this button, or by escort mode once the player turns it on (off by default).
import { ANTI_RADAR } from '../sim/config';
import { antiRadarPlayerReason, antiRadarReach, antiRadarReason, radarOnLeft, seadReloadLeft } from '../sim/antiRadar';
import { buildingAt } from '../sim/buildings';
import { areAllied } from '../sim/diplomacy';
import { knownTile } from '../sim/fog';
import { hasTech } from '../sim/tech';
import { unitCost } from '../sim/units';
import type { Action, Building, GameState, Player } from '../sim/types';
import { formatCount } from './render/common';
import type { UiState } from './uiState';

export const ANTI_RADAR_LABEL = 'Anti-radar strike';

/** Shown on airfield cards once the player owns Anti-radar Missiles or has them on order. */
export function antiRadarOffered(me: Player): boolean {
  return hasTech(me, 'antiRadar') || !!me.procuring?.some((o) => o.tech === 'antiRadar');
}

/** "500 gold, 50 oil". */
export function antiRadarPriceText(state: GameState, pid: number): string {
  const c = unitCost(state, pid, 'antiRadarMissile');
  return `${formatCount(c.gold)} gold, ${formatCount(c.oil)} oil`;
}

/** A seen enemy SAM site in reach of the airfield, and the seconds its radar stays on (0 = off). */
export interface SeadSam {
  b: Building;
  on: number;
}

/** Seen enemy SAM sites within the airfield's reach (by id), with their radar state. Pure read. */
export function antiRadarSams(state: GameState, me: Player, airfield: number): SeadSam[] {
  const af = buildingAt(state, airfield);
  if (!af || af.type !== 'airfield') return [];
  const r = antiRadarReach(state, af);
  const w = state.map.width;
  const out: SeadSam[] = [];
  for (const b of state.buildings.values()) {
    if (b.type !== 'sam' || b.buildLeft > 0 || b.owner <= 0 || b.owner === me.id || areAllied(state, me.id, b.owner)) continue;
    const dx = (b.tile % w) - (af.tile % w);
    const dy = ((b.tile / w) | 0) - ((af.tile / w) | 0);
    if (dx * dx + dy * dy > r * r || !knownTile(state, me.id, b.tile)) continue;
    out.push({ b, on: radarOnLeft(state, b) });
  }
  return out.sort((a, b) => a.b.id - b.b.id);
}

export interface AntiRadarButton {
  ok: boolean;
  /** why the button is off ('' = it can aim) */
  why: string;
  /** the line under it: what a click does, or what to wait for */
  line: string;
}

/** Where the airfield's Anti-radar strike button stands now. */
export function antiRadarButton(state: GameState, me: Player, tile: number): AntiRadarButton {
  const out: AntiRadarButton = { ok: false, why: '', line: '' };
  const af = buildingAt(state, tile);
  if (!af || af.type !== 'airfield' || af.owner !== me.id) return { ...out, why: 'Not your airfield' };
  const price = antiRadarPriceText(state, me.id);
  const on = `Enemy SAM sites can be locked only while their radar is on: for ${ANTI_RADAR.radarOnSeconds} s after they fire. A hit knocks one out for ${ANTI_RADAR.knockSeconds} s; SAMs can shoot the missile down. ${price} each.`;
  if (!hasTech(me, 'antiRadar')) return { ...out, why: 'Needs Anti-radar Missiles', line: 'Needs Anti-radar Missiles (Arsenal, Air row): it is on order' };
  if (af.buildLeft > 0) return { ...out, why: 'Still being built', line: '' };
  const pw = antiRadarPlayerReason(state, me.id);
  if (pw) return { ...out, why: pw.replace(/ \([\d,]+\)$/, ''), line: `${pw}. ${on}` };
  const left = seadReloadLeft(state, af);
  if (left > 0) return { ...out, why: `Reloading ${Math.ceil(left)} s`, line: on };
  const sams = antiRadarSams(state, me, tile);
  if (!sams.length) return { ...out, why: 'No enemy SAM site you have seen in reach', line: `Reach ${Math.round(antiRadarReach(state, af))} tiles. ${on}` };
  const lit = sams.filter((x) => x.on > 0).length;
  if (!lit) return { ...out, why: 'SAM radar is off: wait until it fires', line: `${sams.length} enemy SAM site${sams.length === 1 ? '' : 's'} in reach, radar off. ${on}` };
  return { ok: true, why: '', line: `${lit} of ${sams.length} enemy SAM site${sams.length === 1 ? '' : 's'} in reach ha${lit === 1 ? 's' : 've'} the radar on (green): click the button, then one of them. ${on}` };
}

/** Enters the anti-radar target mode from the airfield at `tile` (or leaves it); returns why not ('' = entered). */
export function aimAntiRadar(state: GameState, me: Player, ui: UiState, tile: number): string {
  if (ui.mode.kind === 'antiRadar') {
    ui.mode = { kind: 'none' };
    return '';
  }
  const s = antiRadarButton(state, me, tile);
  if (!s.ok) return s.why || 'Not possible now';
  ui.contextMenu = null;
  ui.mode = { kind: 'antiRadar', airfield: tile };
  return '';
}

/** The enemy SAM site a click on `tile` means: the seen one in reach nearest to it within 3 tiles, or null. */
export function antiRadarPick(state: GameState, me: Player, airfield: number, tile: number): SeadSam | null {
  const w = state.map.width;
  let best: SeadSam | null = null;
  let bestD = 9.5;
  for (const x of antiRadarSams(state, me, airfield)) {
    const dx = (x.b.tile % w) - (tile % w);
    const dy = ((x.b.tile / w) | 0) - ((tile / w) | 0);
    const d = dx * dx + dy * dy;
    if (d < bestD) {
      best = x;
      bestD = d;
    }
  }
  return best;
}

/** The action a click sends, or the reason it can't ("SAM radar is off: wait until it fires"). */
export function antiRadarClick(state: GameState, me: Player, airfield: number, tile: number): Action | string {
  const pick = antiRadarPick(state, me, airfield, tile);
  if (!pick) return 'Click an enemy SAM site you have seen, inside the ring';
  const why = antiRadarReason(state, me.id, airfield, pick.b.tile);
  if (why) return why;
  return { type: 'antiRadar', airfield, sam: pick.b.tile };
}

/** The line at the top of the screen while aiming. */
export function antiRadarInstruction(state: GameState): string {
  return `Anti-radar strike: click an enemy SAM site with its radar on (green ring). Grey ones are off: wait until they fire. ${antiRadarPriceText(state, state.humanId)}.`;
}

/** The escort toggle's tooltip. */
export function escortTip(on: boolean): string {
  return `Escort mode ${on ? 'on' : 'off'}: ${on ? 'every' : 'when on, every'} enemy SAM site that just shot at your planes gets one anti-radar missile from your nearest ready airfield in reach (paid each time). Off by default.`;
}
