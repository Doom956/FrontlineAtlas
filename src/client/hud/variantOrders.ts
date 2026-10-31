// Arsenal variants in the building panels (drawers.ts BuildingPage): what a Port, Factory or Airfield offers once a
// path is chosen in the Research panel's Arsenal tab. No DOM here; the panel builds the buttons.
//   Port      one "Warship" button per researched ship of the Navy path (Destroyer, Battleship / Submarine, Carrier),
//             each with its own price (navy.warshipOrderCost); none researched = the standard warship.
//   Factory   a line naming the division type of the Armor path (Light / Heavy tanks; every division is that type).
//   Airfield  a line naming the bomber type of the Air path, and a "Recon flight" order once Recon Planes is
//             researched (TargetMode 'recon': the next click is where the plane flies; Action reconFlight).
import { ARSENAL, UNITS } from '../../sim/config';
import { warshipOrderCost } from '../../sim/navy';
import { hasTech } from '../../sim/tech';
import type { Building, GameState, NavalVariant, Player } from '../../sim/types';
import { VARIANT_NAMES, airVariantOf, armorVariantOf, canReconFlight, navalVariantsOf, reconCooldownLeft, reconRange } from '../../sim/variants';

export interface WarshipOption {
  /** undefined = the standard warship (no Navy path yet) */
  variant?: NavalVariant;
  label: string;
  gold: number;
  /** one line on what it is for (button tooltip) */
  tip: string;
}

const SHIP_TIP: Record<NavalVariant, string> = {
  destroyer: 'Fast and cheap; finds submarines and hits them hard',
  battleship: 'Slow and tough; shells the coast from twice as far',
  submarine: 'Hidden until close; raids trade ships and transports',
  carrier: 'A moving airfield: your air wings strike from it',
};

/** Warship buttons of a Port: one per researched ship of the Navy path, else the standard warship. */
export function warshipOptions(s: GameState, me: Player): WarshipOption[] {
  const vs = navalVariantsOf(s, me.id);
  if (!vs.length) return [{ label: 'Warship', gold: warshipOrderCost(s, me.id).gold, tip: 'Sinks enemy ships and shells coasts near its port' }];
  return vs.map((v) => ({ variant: v, label: VARIANT_NAMES[v], gold: warshipOrderCost(s, me.id, v).gold, tip: SHIP_TIP[v] }));
}

/** "Your divisions are Light tanks (Armor path)." or '' before the pick. */
export function factoryVariantLine(s: GameState, me: Player): string {
  const v = armorVariantOf(s, me.id);
  return v ? `Your divisions are ${VARIANT_NAMES[v]} (Armor path).` : '';
}

/** "Bombers fly as Heavy bombers (Air path)." or '' before the pick. */
export function airfieldVariantLine(s: GameState, me: Player): string {
  const v = airVariantOf(s, me.id);
  return v ? `Bombers fly as ${VARIANT_NAMES[v]} (Air path).` : '';
}

/** Whether a Recon flight button belongs on this airfield's panel. */
export function reconOffered(me: Player): boolean {
  return hasTech(me, 'reconPlanes');
}
/** Why the Recon button is off right now ('' = ready), checked without a target (cooldown, money, building). */
export function reconBlock(s: GameState, me: Player, b: Building): string {
  if (b.buildLeft > 0) return 'Still being built';
  const left = reconCooldownLeft(s, b);
  if (left > 0) return `Ready in ${Math.ceil(left)} s`;
  const c = UNITS.reconPlane;
  if (me.gold < c.gold) return 'Not enough gold';
  if (me.oil < c.oil) return 'Not enough oil';
  return '';
}
/** Recon button label with its price and reach. */
export function reconLabel(b: Building): string {
  return `Recon flight (${UNITS.reconPlane.gold} gold, ${reconRange(b)} tiles)`;
}
/** The reconFlight action for a click, or why not. */
export function reconClickAction(s: GameState, me: number, airfield: number, tile: number): { type: 'reconFlight'; airfield: number; tile: number } | string {
  const r = canReconFlight(s, me, airfield, tile);
  return r.ok ? { type: 'reconFlight', airfield, tile } : r.reason ?? 'Not possible here';
}
/** The mode chip while picking a recon target. */
export function reconHint(): string {
  return `Recon: click where the plane should look (reveals ${ARSENAL.reconRadius} tiles around for ${ARSENAL.reconSeconds} s). Esc to cancel.`;
}
