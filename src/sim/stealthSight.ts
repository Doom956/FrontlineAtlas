// Who can see a stealth bomber (Air Mastery; config STEALTH, rules in units.ts launchStealth, AI in stealth.ts).
//
// A stealth bomber is invisible to SAM sites and fighters (airfield cover, carriers, superiority patrols) unless it is
// revealed to their side (stealthRevealedTo): Tracking Radar (defense.ts updateRadar) keeps Unit.radarSeen, the
// players whose locked radar circle holds it now; they and their allies may then engage it by the bomber rule
// (units.ts interceptThreats, techtree.ts, airwings.ts).
//
// Seeing it on the map (stealthShownTo, read by techtree.unitVisibleTo, so the fog of war, the client's renderer
// and the AI all follow it): its owner and allies always; the nation it flies at only in the last
// STEALTH.revealSeconds of its way out, when the warning event goes out (units.ts stealthWarn sets Unit.cargo to 1);
// anyone it is revealed to. Spectators see everything. Pure reads, deterministic, a leaf module.
import { areAllied } from './diplomacy';
import type { GameState, Unit } from './types';

/**
 * Revealed stealth: true when `viewer`'s side (it or an ally) has the stealth bomber `u` locked on a Tracking Radar now
 * (Unit.radarSeen, defense.ts), so its SAMs and fighters may engage it. Pure read.
 */
export function stealthRevealedTo(state: GameState, viewer: number, u: Unit): boolean {
  const seen = u.radarSeen;
  if (!seen || viewer <= 0) return false;
  for (const pid of seen) if (pid === viewer || areAllied(state, viewer, pid)) return true;
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
