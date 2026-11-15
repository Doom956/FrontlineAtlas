// Who can see a stealth bomber (Air Mastery; config STEALTH, rules in units.ts launchStealth, AI in stealth.ts).
//
// A stealth bomber is invisible to SAM sites, always: they never fire at it. Fighters (airfield cover, carriers,
// superiority patrols) can shoot it down only while it is revealed to their side (stealthRevealedTo). Nothing reveals
// one yet; this is the hook a Defense radar will fill (a radar site covering the bomber returns true here, and the
// interception code in units.ts, techtree.ts and airwings.ts then lets fighters engage it by the bomber rule).
//
// Seeing it on the map (stealthShownTo, read by techtree.unitVisibleTo, so the fog of war, the client's renderer
// and the AI all follow it): its owner and allies always; the nation it flies at only in the last
// STEALTH.revealSeconds of its way out, when the warning event goes out (units.ts stealthWarn sets Unit.cargo to 1);
// anyone it is revealed to. Spectators see everything. Pure reads, deterministic, a leaf module.
import { areAllied } from './diplomacy';
import type { GameState, Unit } from './types';

/**
 * Revealed stealth: true when `viewer`'s side has the stealth bomber `u` on its radar and its fighters may engage it.
 * Nothing reveals a stealth bomber yet (a future Defense radar will). Pure read.
 */
export function stealthRevealedTo(_state: GameState, _viewer: number, _u: Unit): boolean {
  return false;
}

/** May `viewer` see the stealth bomber `u` on the map now (see the file comment)? Pure read. */
export function stealthShownTo(state: GameState, viewer: number, u: Unit): boolean {
  if (viewer <= 0 || u.owner === viewer || areAllied(state, viewer, u.owner)) return true;
  if (stealthRevealedTo(state, viewer, u)) return true;
  if (u.state !== 0 || u.cargo <= 0) return false;
  const t = u.targetOwner;
  return t === viewer || (t > 0 && areAllied(state, viewer, t));
}
