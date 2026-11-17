// The three mastery strikes as buttons of the bottom bar (hud/strikeBar.ts, next to Rocket and Atom bomb), so none of
// them hides on a card: Stealth strike (Air Mastery), Cruise missile (Naval Mastery) and Breakthrough (Armor
// Mastery). Each picks its own launcher: the nearest airfield in reach, the nearest loaded ship in reach, the first
// ready tank division. The rules are the sim's (units.ts, blitz.ts); the single-launcher helpers of stealth.ts,
// cruise.ts and blitzUi.ts do the wording, so a card and the bar always say the same. Nothing here fires by itself.
import { buildingsOf } from '../sim/buildings';
import { BLITZ, BLITZ_NAME, BOMBER_RADIUS, COUNTER, CRUISE, STEALTH } from '../sim/config';
import { COUNTER_NAME, counterInfo } from './counterUi';
import { blitzSecondsLeft } from '../sim/blitz';
import { hasTech } from '../sim/tech';
import { cruiseReloadLeft, stealthInAir, stealthPlayerReason, stealthRadius, stealthReach, stealthRechargeLeft } from '../sim/units';
import type { GameState, Player } from '../sim/types';
import { blitzButton, enterBlitz } from './blitzUi';
import { aimCruise, cruiseButton, cruisePriceText, cruiseShips } from './cruise';
import type { IconId } from './icons';
import { fmtR } from './strikes';
import { stealthPriceText } from './stealth';
import type { UiState } from './uiState';

export type MasteryId = 'stealth' | 'cruise' | 'blitz' | 'counter';
export const MASTERY_ORDER: readonly MasteryId[] = ['stealth', 'cruise', 'blitz', 'counter'];

export interface MasteryInfo {
  id: MasteryId;
  name: string;
  /** the plain word under the button */
  label: string;
  icon: IconId;
  /** the strike button's picture (hud/pixelIcons.ts STRIKE_ART); `icon` is the painted fallback without a canvas */
  art: string;
  what: string;
  counter: string;
}

export const MASTERY: Record<MasteryId, MasteryInfo> = {
  stealth: {
    id: 'stealth',
    name: 'Stealth strike',
    label: 'Stealth',
    icon: 'bomber',
    art: 'stealth',
    what: `A stealth bomber SAM sites cannot see flies from the nearest airfield in reach and bombs one target: it wrecks every building within ${fmtR(BOMBER_RADIUS * STEALTH.radiusMul)} tiles, destroys every SAM site in the blast and silences SAM sites within ${STEALTH.silenceRadius} tiles for ${STEALTH.silenceSeconds} s.`,
    counter: 'Only enemy fighters that can see it, and air superiority over the target.',
  },
  cruise: {
    id: 'cruise',
    name: 'Cruise missile',
    label: 'Cruise',
    icon: 'rocket',
    art: 'cruise',
    what: `Every loaded warship, destroyer and battleship can fire one at enemy land within ${CRUISE.reach} tiles of the ship: wrecks buildings within ${CRUISE.radius} tiles and kills troops.`,
    counter: 'SAM sites shoot cruise missiles down like rockets.',
  },
  blitz: {
    id: 'blitz',
    name: BLITZ_NAME,
    label: BLITZ_NAME,
    icon: 'armor',
    art: 'breakthrough',
    what: `A tank division pops smoke and surges into enemy land near your border: fast, deep and wide, and the land it takes holds for ${BLITZ.holdSeconds} s.`,
    counter: 'Cut the wedge off before it holds, or keep reserves behind the border.',
  },
  counter: {
    id: 'counter',
    name: COUNTER_NAME,
    label: 'Counter',
    icon: 'fort',
    art: 'counter',
    what: `Defense Mastery: enemy attacks that lose troops on land your Forts cover fill a meter. Full, one click sends ${Math.round(COUNTER.troopShare * 100)}% of your troops at home and your idle tank divisions near a Fort at the attacker: faster and cheaper for ${COUNTER.seconds} s. No aiming: it pushes from the Fort nearest to them.`,
    counter: 'Hold reserves behind the front that bled, or make peace before the meter fills.',
  },
};

export type MasteryState = 'ready' | 'cooldown' | 'blocked';

export interface MasteryStatus {
  id: MasteryId;
  /** shown at all: the player owns the mastery */
  show: boolean;
  state: MasteryState;
  /** cooldown: seconds left and the whole reload */
  left: number;
  total: number;
  /** ready: what a click does; otherwise exactly why not, in plain words */
  line: string;
  /** launchers ready now (ships loaded, divisions ready), -1 = not counted */
  count: number;
}

const OFF: MasteryStatus = { id: 'stealth', show: false, state: 'blocked', left: 0, total: 0, line: '', count: -1 };

function ownShipIds(state: GameState, me: number): number[] {
  return state.units.filter((u) => u.owner === me && u.hp > 0 && u.type === 'warship').map((u) => u.id);
}
function ownDivisionIds(state: GameState, me: number): number[] {
  return state.units.filter((u) => u.owner === me && u.hp > 0 && u.type === 'tankDivision').map((u) => u.id);
}

/** Where the Stealth strike button stands now. */
function stealthStatus(state: GameState, me: Player): MasteryStatus {
  const out: MasteryStatus = { ...OFF, id: 'stealth' };
  if (!hasTech(me, 'airMastery')) return out;
  out.show = true;
  const fields = buildingsOf(state, me.id, 'airfield').filter((b) => b.buildLeft <= 0);
  if (!fields.length) return { ...out, line: 'Build an Airfield: the stealth bomber flies from one' };
  const why = stealthPlayerReason(state, me.id);
  if (why.startsWith('Recharging')) {
    const left = Math.ceil(stealthRechargeLeft(state, me.id));
    return { ...out, state: 'cooldown', left, total: STEALTH.cooldownSeconds, line: `Recharging: ready in ${left} s. It needs ${STEALTH.cooldownSeconds} s after each strike.` };
  }
  if (why) return { ...out, line: stealthInAir(state, me.id) ? 'Your stealth bomber is in the air. One flies at a time.' : `${why}: each stealth strike costs ${stealthPriceText(state, me.id)}` };
  const reach = Math.round(Math.max(...fields.map((b) => stealthReach(state, b))));
  return {
    ...out,
    state: 'ready',
    count: fields.length,
    line: `Click an enemy target up to ${reach} tiles from an airfield: it wrecks buildings within ${fmtR(stealthRadius(state, me.id))} tiles and every SAM site in the blast. ${stealthPriceText(state, me.id)}.`,
  };
}

/** Where the Cruise missile button stands now (all own ships together). */
function cruiseStatus(state: GameState, me: Player): MasteryStatus {
  const out: MasteryStatus = { ...OFF, id: 'cruise' };
  if (!hasTech(me, 'navalMastery')) return out;
  out.show = true;
  const ids = ownShipIds(state, me.id);
  const ships = cruiseShips(state, me.id, ids);
  if (!ships.length) return { ...out, line: 'Build a warship: cruise missiles fly from warships, destroyers and battleships' };
  const b = cruiseButton(state, me, ids);
  const loaded = ships.filter((u) => cruiseReloadLeft(state, u) <= 0).length;
  if (b.ok) return { ...out, state: 'ready', count: loaded, line: `${b.line} ${loaded} of ${ships.length} ship${ships.length === 1 ? '' : 's'} loaded, ${cruisePriceText(state, me.id)} each.` };
  if (b.why.startsWith('Reloading')) {
    const left = Math.ceil(Math.min(...ships.map((u) => cruiseReloadLeft(state, u))));
    return { ...out, state: 'cooldown', left, total: CRUISE.reloadSeconds, line: b.line };
  }
  return { ...out, line: b.line || b.why };
}

/** Where the Breakthrough button stands now (all own tank divisions together). */
function blitzStatus(state: GameState, me: Player): MasteryStatus {
  const out: MasteryStatus = { ...OFF, id: 'blitz' };
  if (!hasTech(me, 'armorMastery')) return out;
  out.show = true;
  const ids = ownDivisionIds(state, me.id);
  if (!ids.length) return { ...out, line: 'Build a tank division: the breakthrough is its special order' };
  const b = blitzButton(state, me.id, ids);
  if (!b.off) return { ...out, state: 'ready', count: ids.length, line: `${b.tip} Click enemy land near your border.` };
  if (b.off.startsWith('Recharging')) {
    const lead = state.units.find((u) => u.id === b.unitId);
    const left = lead ? blitzSecondsLeft(state, lead) : 0;
    return { ...out, state: 'cooldown', left, total: BLITZ.cooldownSeconds, line: `${b.off}. ${b.tip}` };
  }
  return { ...out, line: `${b.off}. ${b.tip}` };
}

/** Where the Counteroffensive button stands now (Defense Mastery; client/counterUi.ts says it in words). */
function counterStatus(state: GameState, me: Player): MasteryStatus {
  const out: MasteryStatus = { ...OFF, id: 'counter' };
  const c = counterInfo(state, me);
  if (!c.show) return out;
  out.show = true;
  if (c.running > 0) return { ...out, state: 'cooldown', left: c.running, total: COUNTER.seconds, line: c.line };
  if (!c.why) return { ...out, state: 'ready', line: `${c.line} Click to launch.` };
  return { ...out, line: c.why.startsWith('Meter') ? c.line : `${c.why}. ${c.line}` };
}

/** The status of one mastery strike button. Pure read. */
export function masteryStatus(state: GameState, me: Player, id: MasteryId): MasteryStatus {
  if (state.phase !== 'playing') return { ...OFF, id };
  return id === 'stealth' ? stealthStatus(state, me) : id === 'cruise' ? cruiseStatus(state, me) : id === 'counter' ? counterStatus(state, me) : blitzStatus(state, me);
}

/** True while the mode of `ui` is this strike's aiming mode. */
export function masteryAiming(ui: UiState, id: MasteryId): boolean {
  return (id === 'stealth' && ui.mode.kind === 'stealth') || (id === 'cruise' && ui.mode.kind === 'cruise') || (id === 'blitz' && ui.mode.kind === 'blitz'); // the Counteroffensive has no aiming
}

/** A click on the button: enters (or leaves) the target mode; returns why not ('' = ok). */
export function aimMastery(state: GameState, me: Player, ui: UiState, id: MasteryId): string {
  if (masteryAiming(ui, id)) {
    ui.mode = { kind: 'none' };
    return '';
  }
  const st = masteryStatus(state, me, id);
  if (st.state !== 'ready') return st.line || 'Not possible now';
  if (id === 'counter') return ''; // no aiming: the bar sends the order (hud/strikeBar.ts)
  ui.contextMenu = null;
  if (id === 'stealth') {
    ui.mode = { kind: 'stealth', airfield: -1 };
    return '';
  }
  if (id === 'cruise') return aimCruise(state, me, ui, ownShipIds(state, me.id));
  const b = blitzButton(state, me.id, ownDivisionIds(state, me.id));
  return enterBlitz(state, ui, me.id, b.unitId);
}
