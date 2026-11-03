// Reach and timing the client shows for warships and tank divisions (range rings, the rail-move preview, help text).
// Read-only over the sim's rules: the numbers come from sim/config and the per-ship multipliers in sim/variants, so a
// change there shows up here without edits.
//   - shipReach: guns (ships), shelling (enemy coast) and shore support (fronts) of one warship
//   - railMovePreview: the route a division would drive over your own land to a tile, and how long it takes
import { NAVY_SUPPORT_RANGE, TANK_LAUNCH_REACH, WARSHIP_RANGE, WARSHIP_SHELL_RANGE } from '../sim/config';
import { waterComponents } from '../sim/grid';
import { warshipSpawnSeas } from '../sim/navy';
import { divisionDriveSpeed, divisionMoveTime, ownLandPath } from '../sim/tanks';
import { isWater } from '../sim/types';
import type { GameState, Unit } from '../sim/types';
import { navalReachMul, navalShellMul, navalShellRangeMul, navalSupportMul } from '../sim/variants';

/** Shore shelling reach of a standard warship (sim WARSHIP_SHELL_RANGE, x the ship's variant). */
export const SHELL_RANGE_BASE = WARSHIP_SHELL_RANGE;
/** The same, as a whole number of tiles for text. */
export const SHELL_RANGE_TILES = Math.floor(SHELL_RANGE_BASE);

export interface ShipReach {
  /** fights enemy ships within this many tiles */
  weapon: number;
  /** shells enemy coast within this many tiles while at war (0 = this ship never shells) */
  shell: number;
  /** enemy land within this many tiles is cheaper and faster to take (0 = no support) */
  support: number;
}

/** Reach of one warship (its variant and its owner's Naval Mastery included). */
export function shipReach(state: GameState, u: Unit): ShipReach {
  return {
    weapon: WARSHIP_RANGE,
    shell: navalShellMul(u) > 0 ? SHELL_RANGE_BASE * navalShellRangeMul(state, u) : 0,
    support: NAVY_SUPPORT_RANGE * navalReachMul(state, u.owner) * navalSupportMul(u),
  };
}

// ------------------------------------------------------------------------------------------------ warship placement

/** Water body ids touched by your finished ports (the seas a warship can be placed on; navy.warshipSpawnSeas). */
export function portSeas(state: GameState, me: number): Set<number> {
  return warshipSpawnSeas(state, me);
}

/**
 * Short reason a tile can't take a warship, by the map alone ('' = water on a sea one of your ports touches; the
 * sim's canOrderWarship still decides money, fleet size and the rest).
 */
export function spawnTileReason(state: GameState, seas: ReadonlySet<number>, tile: number): string {
  const map = state.map;
  if (tile < 0 || tile >= map.terrain.length) return 'Off the map';
  if (!isWater(map.terrain[tile])) return 'Land: pick water';
  if (!seas.size) return 'Build a Port first';
  return seas.has(waterComponents(map)[tile]) ? '' : 'No port of yours on this sea';
}

// ------------------------------------------------------------------------------------------------ rail moves

/** Driving speed of `owner`'s divisions over own land, tiles per second (tanks.divisionDriveSpeed). */
export function divisionSpeed(state: GameState, owner: number): number {
  return divisionDriveSpeed(state, owner);
}

export interface RailMove {
  /** the division's tile, then the route (own land) */
  path: number[];
  /** tiles driven (diagonal steps count 1.41) */
  length: number;
  /** seconds until it arrives */
  seconds: number;
}

/**
 * The route a division would drive to own tile `to` and how long it takes (tanks.divisionMoveTime, wading included),
 * or null when it can't get there. A route through shallow water (Amphibious Tanks) is drawn as a straight line.
 */
export function railMove(state: GameState, u: Unit, to: number): RailMove | null {
  const seconds = divisionMoveTime(state, u, to);
  if (seconds < 0) return null;
  const w = state.map.width;
  const from = Math.round(u.y) * w + Math.round(u.x);
  const route = ownLandPath(state, u.owner, from, to) ?? [to];
  let length = 0;
  let px = u.x;
  let py = u.y;
  for (const t of route) {
    const dx = (t % w) - px;
    const dy = ((t / w) | 0) - py;
    length += Math.sqrt(dx * dx + dy * dy);
    px = t % w;
    py = (t / w) | 0;
  }
  return { path: [from, ...route], length, seconds };
}

/** "under a second", "about 4 s", "about 1 min 10 s". */
export function arrivalText(seconds: number): string {
  if (!Number.isFinite(seconds)) return 'cannot get there';
  if (seconds < 1) return 'under a second';
  const s = Math.round(seconds);
  if (s < 60) return `about ${s} s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return r ? `about ${m} min ${r} s` : `about ${m} min`;
}

// ------------------------------------------------------------------------------------------------ one-line texts

/** "Guns 35 tiles · shelling 17 · shore support 30" for a ship's card (its variant counted). */
export function shipReachLine(state: GameState, u: Unit): string {
  const r = shipReach(state, u);
  const parts = [`Guns ${Math.round(r.weapon)} tiles`];
  if (r.shell > 0) parts.push(`shelling ${Math.floor(r.shell)}`);
  if (r.support > 0) parts.push(`shore support ${Math.round(r.support)}`);
  return parts.join(' · ');
}

/** "Rail moves 30 tiles/s · aims up to 12 tiles past your border" for a division's card. */
export function divisionReachLine(state: GameState, u: Unit): string {
  return `Rail moves ${Math.round(divisionSpeed(state, u.owner))} tiles/s · aims up to ${TANK_LAUNCH_REACH} tiles past your border`;
}
