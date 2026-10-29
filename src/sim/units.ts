// Mobile units: transports, warships, trade ships, bombers, fighters, rockets, atom bombs.
import type { ActionResult, GameState, Troops } from './types';

/** from: an own coastal tile (a Port tile gives the port bonus), to: a coastal land tile of anyone but you/allies (or neutral). */
export function launchTransport(state: GameState, playerId: number, from: number, to: number, troops: Troops): ActionResult {
  // TODO(WP-D)
  return { ok: false, reason: 'not implemented' };
}
export function buildWarship(state: GameState, playerId: number, portTile: number): ActionResult {
  // TODO(WP-D)
  return { ok: false, reason: 'not implemented' };
}
export function moveWarship(state: GameState, playerId: number, unitId: number, tile: number): ActionResult {
  // TODO(WP-D)
  return { ok: false, reason: 'not implemented' };
}
/** Adds a stored bomber/fighter to an airfield (pay gold/iron/oil, max AIRCRAFT_MAX_PER_AIRFIELD). */
export function buildAircraft(state: GameState, playerId: number, airfieldTile: number, kind: 'bomber' | 'fighter'): ActionResult {
  // TODO(WP-D)
  return { ok: false, reason: 'not implemented' };
}
/** Sends one stored bomber from the airfield to tile (enemy, not allied). */
export function launchBomber(state: GameState, playerId: number, airfieldTile: number, tile: number): ActionResult {
  // TODO(WP-D)
  return { ok: false, reason: 'not implemented' };
}
export function launchMissile(state: GameState, playerId: number, siloTile: number, kind: 'rocket' | 'atomBomb', tile: number): ActionResult {
  // TODO(WP-D)
  return { ok: false, reason: 'not implemented' };
}
/** Moves every unit, resolves arrivals, interceptions, warship fights, trade ship spawning and delivery. */
export function updateUnits(state: GameState): void {
  // TODO(WP-D)
}
