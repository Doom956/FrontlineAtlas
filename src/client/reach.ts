// Reach and timing the client shows for warships and tank divisions (range rings, the rail-move preview, help text).
// Read-only over the sim's rules: the numbers come from sim/config and the per-ship multipliers in sim/variants, so a
// change there shows up here without edits.
//   - shipReach: guns (ships), shelling (enemy coast) and shore support (fronts) of one warship
//   - railMovePreview: the route a division would drive over your own land to a tile, and how long it takes
import { NAVY_SUPPORT_RANGE, TANK_LAUNCH_REACH, UNITS, WARSHIP_RANGE } from '../sim/config';
import { waterComponents } from '../sim/grid';
import { frontRate } from '../sim/rules';
import { ownLandPath } from '../sim/tanks';
import { hasTech } from '../sim/tech';
import { isWater } from '../sim/types';
import type { GameState, Unit } from '../sim/types';
import { navalReachMul, navalShellMul, navalShellRangeMul, navalSupportMul } from '../sim/variants';

/** Shore shelling reach of a standard warship (the sim shells within half its gun range, x the ship's variant). */
// TODO(sim): if the sim gets its own shelling-range constant, read it here instead of WARSHIP_RANGE / 2.
export const SHELL_RANGE_BASE = WARSHIP_RANGE / 2;

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

/** Water body ids touched by your finished ports (the seas a warship can be placed on). */
export function portSeas(state: GameState, me: number): Set<number> {
  const map = state.map;
  const c = waterComponents(map);
  const w = map.width;
  const out = new Set<number>();
  for (const b of state.buildings.values()) {
    if (b.type !== 'port' || b.owner !== me || b.buildLeft > 0) continue;
    const t = b.tile;
    const x = t % w;
    if (c[t]) out.add(c[t]);
    if (x > 0 && c[t - 1]) out.add(c[t - 1]);
    if (x < w - 1 && c[t + 1]) out.add(c[t + 1]);
    if (t >= w && c[t - w]) out.add(c[t - w]);
    if (t < c.length - w && c[t + w]) out.add(c[t + w]);
  }
  return out;
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

/** Driving speed of `owner`'s divisions over own land, tiles per second (Railways and the game speed included). */
// TODO(sim): use the sim's divisionMoveTime once it exists, so terrain or other speed rules are counted too.
export function divisionSpeed(state: GameState, owner: number): number {
  const p = state.players[owner];
  return UNITS.tankDivision.speed * (p && hasTech(p, 'railways') ? 1.5 : 1) * frontRate(state);
}

export interface RailMove {
  /** the division's tile, then the route (own land) */
  path: number[];
  /** tiles driven (diagonal steps count 1.41) */
  length: number;
  /** seconds until it arrives */
  seconds: number;
}

/** The route a division would drive to own tile `to` and how long it takes, or null when it can't get there. */
export function railMove(state: GameState, u: Unit, to: number): RailMove | null {
  const w = state.map.width;
  const from = Math.round(u.y) * w + Math.round(u.x);
  const route = ownLandPath(state, u.owner, from, to);
  if (!route) return null;
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
  const v = divisionSpeed(state, u.owner);
  return { path: [from, ...route], length, seconds: v > 0 ? length / v : Infinity };
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

/** "Guns 35 tiles · shells coast 17 · shore support 30" for a ship's card (its variant counted). */
export function shipReachLine(state: GameState, u: Unit): string {
  const r = shipReach(state, u);
  const parts = [`Fights ships within ${Math.round(r.weapon)} tiles`];
  if (r.shell > 0) parts.push(`shells enemy coast within ${Math.round(r.shell)}`);
  if (r.support > 0) parts.push(`backs your attacks within ${Math.round(r.support)}`);
  return `${parts.join(', ')} (at war)`;
}

/** "Drives over your land at 20 tiles/s; spearheads start up to 12 tiles past your border" for a division's card. */
export function divisionReachLine(state: GameState, u: Unit): string {
  const v = divisionSpeed(state, u.owner);
  return `Drives over your land at ${Math.round(v)} tiles/s; spearheads start up to ${TANK_LAUNCH_REACH} tiles past your border`;
}
