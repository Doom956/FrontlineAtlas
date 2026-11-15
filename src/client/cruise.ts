// Cruise missiles on the client (the rules are the sim's: units.ts launchCruise / cruiseReason, cruise.ts preview):
//   - cruiseButton(): the "Cruise missile" button of the selected ships (unit card, orders bar on phones): shown,
//     ready or exactly why not ("Reloading 12 s", "Needs Naval Mastery", "Not enough gold (700)"), with the price
//   - aimCruise(): enters the target mode (TargetMode 'cruise'); the next click on land fires from the nearest loaded
//     ship in reach (cruiseClick)
//   - cruiseTarget(): what a click on a tile would do (the ship that fires, the blast, SAM cover), judged by what this
//     player knows under fog of war
//   - cruiseInstruction(): the line at the top of the screen while aiming
// A human's ships never fire by themselves: only this button does.
import { CRUISE, UNITS } from '../sim/config';
import { cruisePreview } from '../sim/cruise';
import { areAllied } from '../sim/diplomacy';
import { forEachInRadius } from '../sim/grid';
import { hasTech } from '../sim/tech';
import { cruiseDistance, cruiseHull, cruiseReason, cruiseReloadLeft, cruiseShipReason, unitCost } from '../sim/units';
import type { Action, GameState, Player, Unit } from '../sim/types';
import { isWater } from '../sim/types';
import { activeFog, nationName } from './fog/fogView';
import { formatCount } from './render/common';
import type { UiState } from './uiState';

/** The price of one cruise missile, with units: "700 gold, 60 oil". */
export function cruisePriceText(state: GameState, pid: number): string {
  const c = unitCost(state, pid, 'cruiseMissile');
  return `${formatCount(c.gold)} gold, ${formatCount(c.oil)} oil`;
}

/** The ships of `ids` (own, alive) that carry cruise missiles: warships, destroyers and battleships. */
export function cruiseShips(state: GameState, me: number, ids: readonly number[]): Unit[] {
  const set = new Set(ids);
  return state.units.filter((u) => set.has(u.id) && u.owner === me && u.hp > 0 && cruiseHull(u));
}

export interface CruiseButton {
  /** shown at all: a ship that carries them, and the player has Naval Mastery or is one step from it */
  show: boolean;
  ok: boolean;
  /** ready: what a click does and the price; otherwise exactly why not, in plain words */
  line: string;
  /** the short reason for the button itself ('' when ready): "Reloading 12 s", "Needs Naval Mastery" */
  why: string;
}

/** Where the Cruise missile button of these ships stands now. */
export function cruiseButton(state: GameState, me: Player, ids: readonly number[]): CruiseButton {
  const ships = cruiseShips(state, me.id, ids);
  const out: CruiseButton = { show: false, ok: false, line: '', why: '' };
  if (!ships.length || state.phase !== 'playing') return out;
  const mastery = hasTech(me, 'navalMastery');
  const ordered = !!me.procuring?.some((o) => o.tech === 'navalMastery');
  out.show = mastery || ordered || hasTech(me, 'battleships') || hasTech(me, 'carriers');
  if (!out.show) return out;
  const price = cruisePriceText(state, me.id);
  if (!mastery) {
    out.why = 'Needs Naval Mastery';
    out.line = ordered ? 'Needs Naval Mastery: it is on order in the Arsenal' : `Needs Naval Mastery (Arsenal, Navy row). Then each ship fires cruise missiles at land within ${CRUISE.reach} tiles, ${price} each.`;
    return out;
  }
  const loaded = ships.filter((u) => cruiseReloadLeft(state, u) <= 0);
  if (!loaded.length) {
    const left = Math.ceil(Math.min(...ships.map((u) => cruiseReloadLeft(state, u))));
    out.why = `Reloading ${left} s`;
    out.line = `Reloading: ready in ${left} s. Each ship reloads ${CRUISE.reloadSeconds} s after it fires.`;
    return out;
  }
  const why = cruiseShipReason(state, me.id, loaded[0]);
  if (why) {
    out.why = why.replace(/ \(\d+\)$/, '');
    out.line = `${why}: each missile costs ${price}`;
    return out;
  }
  out.ok = true;
  out.line = `Click enemy land within ${CRUISE.reach} tiles of the ship: it wrecks buildings within ${CRUISE.radius} tiles and kills troops. ${price}.`;
  return out;
}

/** Enters the cruise missile target mode for these ships (or leaves it); returns why not ('' = entered). */
export function aimCruise(state: GameState, me: Player, ui: UiState, ids: readonly number[]): string {
  const b = cruiseButton(state, me, ids);
  if (!b.ok) return b.line || 'No ship of yours carries cruise missiles';
  ui.contextMenu = null;
  ui.mode = ui.mode.kind === 'cruise' ? { kind: 'none' } : { kind: 'cruise', ships: cruiseShips(state, me.id, ids).map((u) => u.id) };
  return '';
}

/** The line at the top of the screen while aiming. */
export function cruiseInstruction(state: GameState, ships: readonly number[]): string {
  const n = ships.length;
  return `Cruise missile: click enemy land inside the blue ring${n > 1 ? 's' : ''} (${CRUISE.reach} tiles from the ship). ${cruisePriceText(state, state.humanId)}.`;
}

/** What a click with the cruise mode on `tile` would do. */
export interface CruiseTarget {
  ok: boolean;
  reason: string;
  /** the ship that fires (null: none) */
  ship: Unit | null;
  radius: number;
  /** what the blast would hit (0 when part of it is out of view: blind) */
  enemyBuildings: number;
  enemyTiles: number;
  victim: number;
  blind: boolean;
  /** a hostile SAM site covers the route or the target ('' = none known) */
  covered: string;
}

/**
 * The ship of `ids` that a click on `tile` fires from (the nearest loaded one in reach), and what it would hit.
 * Fog of war: land out of view counts by its last seen owner, and the blast's contents are not shown (blind).
 */
export function cruiseTarget(state: GameState, me: Player, ids: readonly number[], tile: number): CruiseTarget {
  const out: CruiseTarget = { ok: false, reason: '', ship: null, radius: CRUISE.radius, enemyBuildings: 0, enemyTiles: 0, victim: 0, blind: false, covered: '' };
  if (tile < 0 || tile >= state.map.owner.length) return { ...out, reason: 'Pick a tile on the map' };
  const ships = cruiseShips(state, me.id, ids);
  if (!ships.length) return { ...out, reason: 'No ship of yours carries cruise missiles' };
  const loaded = ships.filter((u) => cruiseReloadLeft(state, u) <= 0);
  const pool = loaded.length ? loaded : ships;
  const ship = [...pool].sort((a, b) => cruiseDistance(state, a, tile) - cruiseDistance(state, b, tile) || a.id - b.id)[0];
  out.ship = ship;
  const fog = activeFog(state);
  const hidden = !!fog && !fog.visible(tile);
  let why = cruiseReason(state, me.id, ship, tile);
  const pv = cruisePreview(state, me.id, ship.id, tile);
  if (!why) why = pv.reason;
  if (fog) {
    let blind = hidden;
    let known = false;
    const hostile = (k: number): boolean => k > 0 && k !== me.id && !!state.players[k]?.alive && !areAllied(state, me.id, k);
    forEachInRadius(state.map, tile, CRUISE.radius, (i) => {
      if (!fog.visible(i)) blind = true;
      if (!known && hostile(fog.knownOwner(state, i))) known = true;
    });
    if (blind) {
      out.blind = true;
      // the sim's answers about who holds hidden land must not show: judge by what was last seen
      const ownerAnswer = why === 'That is your own land' || why === 'You cannot fire at an ally' || why === 'Nothing of the enemy to hit there' || why.startsWith('Peace time:');
      if (ownerAnswer || !why) {
        const shipWhy = cruiseShipReason(state, me.id, ship);
        const d = cruiseDistance(state, ship, tile);
        if (shipWhy) why = shipWhy;
        else if (isWater(state.map.terrain[tile])) why = 'Cruise missiles hit land';
        else if (d > CRUISE.reach) why = `Too far: cruise missiles reach ${CRUISE.reach} tiles from the ship, this is ${Math.round(d)} away`;
        else if (!known) why = fog.explored(tile) ? 'Last seen: nothing of the enemy there' : 'Unexplored: you have not seen enemy land there';
        else if (hidden && why.startsWith('Peace time:')) why = 'Peace time: strike only where you can see who holds the land';
        else why = '';
      }
      return { ...out, ok: why === '', reason: why };
    }
  }
  out.enemyBuildings = pv.enemyBuildings;
  out.enemyTiles = pv.enemyTiles;
  out.victim = pv.victim;
  if (pv.samShots > 0) out.covered = `A SAM site covers the route (${pv.samShots} shot${pv.samShots === 1 ? '' : 's'} ready): it may be shot down`;
  return { ...out, ok: why === '', reason: why };
}

/** The action a click sends, or the reason it can't (shown at the cursor). */
export function cruiseClick(state: GameState, me: Player, ids: readonly number[], tile: number): Action | string {
  const t = cruiseTarget(state, me, ids, tile);
  if (!t.ok || !t.ship) return t.reason || 'Not possible here';
  return { type: 'cruiseMissile', ship: t.ship.id, tile };
}

/** The cursor card's body for an ok target: what it hits ("Wrecks 2 buildings of Azuria within 4 tiles"). */
export function cruiseBody(state: GameState, t: CruiseTarget): string {
  if (t.blind) return `Radius ${t.radius} tiles. Out of sight: you will see what it hit when it lands`;
  const who = t.victim > 0 ? ` of ${nationName(state, t.victim)}` : '';
  const b = t.enemyBuildings;
  return `${b ? `Wrecks ${b} building${b === 1 ? '' : 's'}${who}` : `No buildings${who}`} within ${t.radius} tiles, kills troops there. ${cruisePriceText(state, state.humanId)}.`;
}

/** Plain name of a cruise missile in flight (Forces list). */
export const CRUISE_NAME = UNITS.cruiseMissile.name;
