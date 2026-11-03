// The client's reads of the strike rules (sim airstrike.ts) for bombers and missiles: the strike preview (role, aim,
// radius, how many fly and the expected result), an airfield's last result and rocket auto-fire. All pure reads.
//   - strikePreview(state, pid, kind, tile, count, from): what a click would do (count 0 = All, from -1 = every site)
//   - Action bomb / launchMissile { airfield | silo: a tile (only that site) or -1 (every site in reach, nearest
//     first), count?: absent = 1, 0 = every ready one }
//   - wingLastResult(state, airfieldTile): the latest raid of an airfield
//   - autoFireOn / autoFireAll and Action setAutoFire { silo: tile or -1, on }
import { airWingRange } from '../sim/airwings';
import { autoFireAll as simAutoFireAll, autoFireOn, raidRadius, strikePreview, wingLastResult, type StrikePreview } from '../sim/airstrike';
import { buildingsOf } from '../sim/buildings';
import type { Action, Building, GameState } from '../sim/types';
import type { SalvoKind, SalvoSize } from './salvoPrefs';

export { loadSalvo, nextSalvo, SALVO_SIZES, salvoLabel, saveSalvo, type SalvoKind, type SalvoPrefs, type SalvoSize } from './salvoPrefs';
export type { StrikePreview };

/** Manual bombing reach of an airfield: the same reach as its wing's sorties (Heavy Bombers x1.5, Drop Tanks). */
export function bombReach(state: GameState, b: Building): number {
  return airWingRange(b, state);
}

/** Raid bomb radius of this player's bombers (Strategic Bombing, Night Bombing, Heavy Bombers). */
export function bomberRadiusOf(state: GameState, pid: number): number {
  return raidRadius(state, pid);
}

/**
 * What a click would do: the sim's own preview for `size` launchers (All = 0) from `from` (a site picked in Forces or
 * the radial menu, or -1 = every site in reach, nearest first), plus how many are ready when fewer fly than picked.
 */
export function previewStrike(state: GameState, pid: number, kind: SalvoKind, tile: number, size: SalvoSize, from: number): { pv: StrikePreview; ready: number } {
  const pv = strikePreview(state, pid, kind, tile, size, from);
  let ready = pv.launchers;
  if (size !== 0 && pv.launchers < size) ready = strikePreview(state, pid, kind, tile, 0, from).launchers;
  return { pv, ready };
}

/**
 * The action for a click. x1: the classic action from the preview's first site. A salvo: from the site picked
 * (`fixed`) or every own site in reach (-1); count = the size (All = 0).
 */
export function salvoAction(kind: SalvoKind, from: number, tile: number, size: SalvoSize, fixed = -1): Action {
  if (size === 1) return kind === 'bomb' ? { type: 'bomb', airfield: from, tile } : { type: 'launchMissile', silo: from, kind, tile };
  const site = fixed >= 0 ? fixed : -1;
  return kind === 'bomb' ? { type: 'bomb', airfield: site, tile, count: size } : { type: 'launchMissile', silo: site, kind, tile, count: size };
}

// ------------------------------------------------------------------------------------------------ air wing results

/** The latest raid of an airfield as one line ("Last raid: 3 buildings hit in Vesperia, 2.1k troops · 12 s ago"). */
export function wingResult(state: GameState, b: Building): { ago: number; line: string } {
  const r = wingLastResult(state, b.tile);
  if (!r) return { ago: -1, line: '' };
  const ago = Math.floor(r.secondsAgo);
  const agoText = ago < 60 ? `${ago} s ago` : `${Math.floor(ago / 60)} min ago`;
  return { ago, line: `${r.text} · ${agoText}` };
}

// ------------------------------------------------------------------------------------------------ rocket auto-fire

/** Every own silo fires rockets by itself (the "all silos" switch, later silos too). */
export function autoFireAll(state: GameState, pid: number): boolean {
  return simAutoFireAll(state, pid);
}

/** Does this silo fire rockets by itself at your war target? */
export function siloAutoFire(state: GameState, b: Building): boolean {
  return autoFireOn(state, b.tile);
}

/** Turns rocket auto-fire on or off for one silo (tile) or every own silo (-1). Atom bombs never fire by themselves. */
export function autoFireAction(silo: number, on: boolean): Action {
  return { type: 'setAutoFire', silo, on };
}

/** Own finished silos and how many fire by themselves. */
export function autoFireCount(state: GameState, pid: number): { silos: number; on: number } {
  let silos = 0;
  let on = 0;
  for (const b of buildingsOf(state, pid, 'silo')) {
    if (b.buildLeft > 0) continue;
    silos++;
    if (siloAutoFire(state, b)) on++;
  }
  return { silos, on };
}
