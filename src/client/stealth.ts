// The stealth strike on the client (the rules are the sim's: units.ts launchStealth / stealthReason, stealth.ts
// preview):
//   - stealthButton(): the airfield card's "Stealth strike" button: shown, ready or exactly why not ("Recharging
//     45 s", "Needs Air Mastery", "Stealth bomber in the air", "Not enough gold (2,000)"), with the price
//   - aimStealth(): enters the target mode (TargetMode 'stealth'); the next click on enemy land sends the bomber
//   - stealthTarget(): what a click on a tile would do (the airfield it flies from, the blast, the SAM sites it slips
//     past), judged by what this player knows under fog of war
//   - stealthInstruction(): the line at the top of the screen while aiming
// A human's stealth bomber never flies by itself: only this button does.
import { STEALTH, UNITS } from '../sim/config';
import { areAllied } from '../sim/diplomacy';
import { forEachInRadius } from '../sim/grid';
import { stealthPreview } from '../sim/stealth';
import { hasTech } from '../sim/tech';
import { buildingAt } from '../sim/buildings';
import { stealthInAir, stealthPlayerReason, stealthRadius, stealthReach, stealthRechargeLeft, unitCost } from '../sim/units';
import type { Action, GameState, Player } from '../sim/types';
import { isWater } from '../sim/types';
import { activeFog, nationName } from './fog/fogView';
import { formatCount } from './render/common';
import { fmtR } from './strikes';
import type { UiState } from './uiState';

/** The plain name of the strike (the button's word). */
export const STEALTH_LABEL = 'Stealth strike';

/** The price of one stealth strike, with units: "2,000 gold, 150 oil". */
export function stealthPriceText(state: GameState, pid: number): string {
  const c = unitCost(state, pid, 'stealthBomber');
  return `${formatCount(c.gold)} gold, ${formatCount(c.oil)} oil`;
}

export interface StealthButton {
  /** shown at all: the player has Air Mastery, has it on order, or owns a path step toward it */
  show: boolean;
  ok: boolean;
  /** ready: what a click does and the price; otherwise exactly why not, in plain words */
  line: string;
  /** the short reason for the button itself ('' when ready): "Recharging 45 s", "Needs Air Mastery" */
  why: string;
}

/** Where the Stealth strike button of the airfield at `tile` stands now. */
export function stealthButton(state: GameState, me: Player, tile: number): StealthButton {
  const out: StealthButton = { show: false, ok: false, line: '', why: '' };
  const b = buildingAt(state, tile);
  if (!b || b.type !== 'airfield' || b.owner !== me.id || state.phase !== 'playing') return out;
  const mastery = hasTech(me, 'airMastery');
  const ordered = !!me.procuring?.some((o) => o.tech === 'airMastery');
  out.show = mastery || ordered || hasTech(me, 'jetEngines') || hasTech(me, 'strategicBombing');
  if (!out.show) return out;
  const price = stealthPriceText(state, me.id);
  if (!mastery) {
    out.why = 'Needs Air Mastery';
    out.line = ordered ? 'Needs Air Mastery: it is on order in the Arsenal' : `Needs Air Mastery (Arsenal, Air row). Then a stealth bomber SAM sites cannot see strikes up to ${Math.round(stealthReach(state, b))} tiles away, ${price} each.`;
    return out;
  }
  if (b.buildLeft > 0) {
    out.why = 'Still being built';
    out.line = 'This airfield is still being built';
    return out;
  }
  const why = stealthPlayerReason(state, me.id);
  if (why) {
    out.why = why.replace(/ \([\d,]+\)$/, '');
    out.line = why.startsWith('Not enough') ? `${why}: each stealth strike costs ${price}` : stealthInAir(state, me.id) ? 'Your stealth bomber is in the air. One flies at a time.' : `${why}. The stealth bomber needs ${STEALTH.cooldownSeconds} s after each strike.`;
    return out;
  }
  out.ok = true;
  out.line = `A stealth bomber SAM sites cannot see: bombs one target up to ${Math.round(stealthReach(state, b))} tiles away and wrecks the buildings within ${fmtR(stealthRadius(state, me.id))} tiles. Recharges in ${STEALTH.cooldownSeconds} s.`;
  return out;
}

/** The disabled reason of the card button ('' = ready). */
export function stealthBlock(state: GameState, me: Player, tile: number): string {
  const s = stealthButton(state, me, tile);
  return s.ok ? '' : s.why || 'Not possible now';
}

/** Enters the stealth strike target mode from the airfield at `tile` (or leaves it); returns why not ('' = entered). */
export function aimStealth(state: GameState, me: Player, ui: UiState, tile: number): string {
  const s = stealthButton(state, me, tile);
  if (!s.ok) return s.line || 'Not possible now';
  ui.contextMenu = null;
  ui.mode = ui.mode.kind === 'stealth' ? { kind: 'none' } : { kind: 'stealth', airfield: tile };
  return '';
}

/** The line at the top of the screen while aiming. */
export function stealthInstruction(state: GameState): string {
  return `Stealth strike: click an enemy target inside the blue ring. SAM sites cannot see the bomber. ${stealthPriceText(state, state.humanId)}.`;
}

/** What a click with the stealth mode on `tile` would do. */
export interface StealthTarget {
  ok: boolean;
  reason: string;
  /** the airfield it flies from (-1: none) */
  airfield: number;
  radius: number;
  /** what the blast would hit (not shown when part of it is out of view: blind) */
  enemyBuildings: number;
  buildingsHit: number;
  victim: number;
  blind: boolean;
  /** hostile SAM sites the route crosses that cannot see it (only those this player can see) */
  samSites: number;
  guarded: boolean;
}

/**
 * The strike a click on `tile` would fly from `airfield`, and what it would hit. Fog of war: land out of view counts
 * by its last seen owner, and the blast's contents are not shown (blind).
 */
export function stealthTarget(state: GameState, me: Player, airfield: number, tile: number): StealthTarget {
  const out: StealthTarget = { ok: false, reason: '', airfield, radius: stealthRadius(state, me.id), enemyBuildings: 0, buildingsHit: 0, victim: 0, blind: false, samSites: 0, guarded: false };
  if (tile < 0 || tile >= state.map.owner.length) return { ...out, reason: 'Pick a tile on the map' };
  const pv = stealthPreview(state, me.id, airfield, tile);
  let why = pv.reason;
  const fog = activeFog(state);
  if (fog) {
    let blind = !fog.visible(tile);
    let known = false;
    const hostile = (k: number): boolean => k > 0 && k !== me.id && !!state.players[k]?.alive && !areAllied(state, me.id, k);
    forEachInRadius(state.map, tile, out.radius, (i) => {
      if (!fog.visible(i)) blind = true;
      if (!known && hostile(fog.knownOwner(state, i))) known = true;
    });
    if (blind) {
      out.blind = true;
      // the sim's answers about who holds hidden land must not show: judge by what was last seen
      const ownerAnswer = why === 'That is your own land' || why === 'You cannot bomb an ally' || why === 'Nothing of the enemy to hit there' || why.startsWith('Peace time:');
      if (ownerAnswer || !why) {
        const pWhy = stealthPlayerReason(state, me.id);
        if (pWhy) why = pWhy;
        else if (isWater(state.map.terrain[tile])) why = 'Stealth bombers bomb land';
        else if (!known) why = fog.explored(tile) ? 'Last seen: nothing of the enemy there' : 'Unexplored: you have not seen enemy land there';
        else if (!fog.visible(tile) && why.startsWith('Peace time:')) why = 'Peace time: strike only where you can see who holds the land';
        else if (!why.startsWith('Too far')) why = '';
      }
      return { ...out, ok: why === '', reason: why };
    }
  }
  out.airfield = pv.airfield >= 0 ? pv.airfield : airfield;
  out.enemyBuildings = pv.enemyBuildings;
  out.buildingsHit = pv.buildingsHit;
  out.victim = pv.victim;
  out.guarded = pv.guarded;
  out.samSites = pv.samSites;
  return { ...out, ok: why === '', reason: why };
}

/** The action a click sends, or the reason it can't (shown at the cursor). */
export function stealthClick(state: GameState, me: Player, airfield: number, tile: number): Action | string {
  const t = stealthTarget(state, me, airfield, tile);
  if (!t.ok) return t.reason || 'Not possible here';
  return { type: 'stealthStrike', airfield, tile };
}

/** The cursor card's body for an ok target ("Wrecks about 3 of 3 buildings of Azuria within 6 tiles"). */
export function stealthBody(state: GameState, t: StealthTarget): string {
  const r = fmtR(t.radius);
  if (t.blind) return `Radius ${r} tiles. Out of sight: you will see what it hit when the bombs fall. ${stealthPriceText(state, state.humanId)}.`;
  const who = t.victim > 0 ? ` of ${nationName(state, t.victim)}` : '';
  const b = t.enemyBuildings;
  const hit = Math.round(t.buildingsHit);
  const wreck = b ? `Wrecks about ${hit} of ${b} building${b === 1 ? '' : 's'}${who}` : `No buildings${who}`;
  return `${wreck} within ${r} tiles, kills troops and cuts their income. ${stealthPriceText(state, state.humanId)}.`;
}

/** The SAM line of the cursor card ('' = none on the way). */
export function stealthSamLine(t: StealthTarget): string {
  if (t.blind || t.samSites <= 0) return '';
  return `${t.samSites} SAM site${t.samSites === 1 ? '' : 's'} on the way: ${t.samSites === 1 ? 'it cannot' : 'they cannot'} see the stealth bomber`;
}

/** The air superiority line of the cursor card ('' = none). */
export function stealthGuardLine(t: StealthTarget): string {
  return t.guarded && !t.blind ? 'Enemy fighters guard the target: the bombs do less (air superiority)' : '';
}

/** Seconds until the stealth bomber is ready again (0 = ready or never flown). */
export function stealthReadyIn(state: GameState, pid: number): number {
  return Math.ceil(stealthRechargeLeft(state, pid));
}

/** Plain name of the plane (Forces list). */
export const STEALTH_NAME = UNITS.stealthBomber.name;
