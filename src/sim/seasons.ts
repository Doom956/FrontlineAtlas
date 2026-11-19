// Seasons (DESIGN "Seasons"): Spring, Summer, Autumn, Winter, SEASON.seconds of game time each, on the play clock
// (ticks since the spawn phase ended; the spawn phase is early spring). Seasons always run and the map shows them;
// the gameplay effects apply only with the game rule Season effects on (Modifiers.seasonEffects):
// - Spring mud: tanks x SEASON.mudArmor on plains and fertile land (tank divisions; an attack's armor share).
// - Summer: nothing.
// - Autumn harvest: gold income + SEASON.harvestPerFarm per farm unit, at most SEASON.harvestMax.
// - Winter snow: attacks through snow x SEASON.snowInfantry (armor x SEASON.snowArmor). Snow covers tundra in winter
//   and a band from each pole that moves toward the equator over the winter (snowRows) and recedes in spring; spring
//   snow still slows. Sea ice: water within iceRows of the top and bottom edge freezes for the whole winter.
//   Ships cannot sail onto ice: a ship that reaches the ice edge waits there until spring (units.followPath); a ship
//   caught in the ice when it forms may still sail on and out.
//
// Nothing here is stored: the season, the snow line and the ice are pure functions of the tick, playStartTick, the
// map height and the game rule, so they need no hash entry of their own (hash.ts mixes the rule). Integer math for
// every row and tick; the progress and seconds for the client are plain divisions.
import { SEASON, TICKS_PER_SECOND } from './config';
import { Resource, Terrain, isWater } from './types';
import type { GameState } from './types';

export type Season = 'spring' | 'summer' | 'autumn' | 'winter';
export const SEASONS: readonly Season[] = ['spring', 'summer', 'autumn', 'winter'];
export const SEASON_NAMES: Record<Season, string> = { spring: 'Spring', summer: 'Summer', autumn: 'Autumn', winter: 'Winter' };

/** Ticks per season. */
export const SEASON_TICKS = SEASON.seconds * TICKS_PER_SECOND;

export interface SeasonInfo {
  season: Season;
  /** 0 spring .. 3 winter */
  index: number;
  /** how far through the season, 0..1 */
  progress: number;
  /** game seconds until the next season */
  secondsLeft: number;
  /** whole ticks into the season */
  ticksInto: number;
  /** seasons begun since the start (0 = the first one) */
  count: number;
}

/** Play ticks (ticks since the spawn phase ended; 0 during it). */
export function playTicks(state: Pick<GameState, 'phase' | 'tick' | 'playStartTick'>): number {
  return state.phase === 'spawn' ? 0 : Math.max(0, state.tick - state.playStartTick);
}

/** The season `ticks` play ticks into a game that starts in season `startIndex` (SEASON.startIndex by default). */
export function seasonAtTick(ticks: number, startIndex: number = SEASON.startIndex): SeasonInfo {
  const t = Math.max(0, Math.floor(ticks));
  const count = Math.floor(t / SEASON_TICKS);
  const into = t - count * SEASON_TICKS;
  const index = (((startIndex + count) % 4) + 4) % 4;
  return { season: SEASONS[index], index, progress: into / SEASON_TICKS, secondsLeft: (SEASON_TICKS - into) / TICKS_PER_SECOND, ticksInto: into, count };
}

/** The current season of a game. */
export function seasonAt(state: Pick<GameState, 'phase' | 'tick' | 'playStartTick'>): SeasonInfo {
  return seasonAtTick(playTicks(state));
}

/** True when the game rule Season effects is on (absent, as in an older save, counts as on). */
export function seasonEffectsOn(state: Pick<GameState, 'settings'>): boolean {
  return state.settings.modifiers?.seasonEffects !== false;
}

/** The season whose effects apply now, or null with Season effects off. */
export function activeSeason(state: GameState): Season | null {
  return seasonEffectsOn(state) ? seasonAt(state).season : null;
}

/** Rows of snow at most, from each pole, for a map `height` tiles tall. */
export function snowMaxRows(height: number): number {
  return Math.floor((height * SEASON.snowMaxPercent) / 100);
}

/**
 * Rows covered by snow from each pole at `ticks` play ticks on a map `height` tall: grows from 0 over the first
 * SEASON.snowGrowPercent of winter, holds, then recedes over the first SEASON.snowMeltPercent of spring. 0 otherwise.
 */
export function snowRowsAt(ticks: number, height: number, startIndex: number = SEASON.startIndex): number {
  const s = seasonAtTick(ticks, startIndex);
  const max = snowMaxRows(height);
  if (s.season === 'winter') {
    const grow = Math.floor((SEASON_TICKS * SEASON.snowGrowPercent) / 100);
    return s.ticksInto >= grow ? max : Math.floor((max * s.ticksInto) / grow);
  }
  // the first spring of a game has no winter before it
  if (s.season === 'spring' && s.count > 0) {
    const melt = Math.floor((SEASON_TICKS * SEASON.snowMeltPercent) / 100);
    return s.ticksInto >= melt ? 0 : max - Math.floor((max * s.ticksInto) / melt);
  }
  return 0;
}

/** Rows covered by snow from each pole now (see snowRowsAt). */
export function snowRows(state: GameState): number {
  return snowRowsAt(playTicks(state), state.map.height);
}

/**
 * The snow line for the art: rows y < north and rows y >= south are snow covered (land only), and in winter tundra
 * is snow too (isSnowTile).
 */
export function snowLineRows(state: GameState): { north: number; south: number } {
  const r = snowRows(state);
  return { north: r, south: state.map.height - r };
}

/** True when `tile` is snow covered now (land in the snow band, or tundra in winter). Visual and, with effects on, gameplay. */
export function isSnowTile(state: GameState, tile: number): boolean {
  const ter = state.map.terrain[tile];
  if (isWater(ter)) return false;
  const s = seasonAt(state);
  if (ter === Terrain.Tundra && s.season === 'winter') return true;
  const r = snowRowsAt(playTicks(state), state.map.height);
  if (r <= 0) return false;
  const y = (tile / state.map.width) | 0;
  return y < r || y >= state.map.height - r;
}

/** Rows of sea ice from the top and from the bottom edge on a map `height` tall, in winter. */
export function iceRowsFor(height: number): number {
  return Math.max(SEASON.iceMinRows, Math.floor((height * SEASON.icePercent) / 100));
}

/** The sea ice band now: water rows y < north and y >= south are frozen (north 0 and south = height outside winter). */
export function iceBand(state: GameState): { north: number; south: number } {
  const h = state.map.height;
  if (seasonAt(state).season !== 'winter') return { north: 0, south: h };
  const r = iceRowsFor(h);
  return { north: r, south: h - r };
}

/** True when `tile` is frozen sea now (visual; ships are blocked only with effects on, see iceBlocks). */
export function isIcedTile(state: GameState, tile: number): boolean {
  if (!isWater(state.map.terrain[tile])) return false;
  const b = iceBand(state);
  if (b.north <= 0) return false;
  const y = (tile / state.map.width) | 0;
  return y < b.north || y >= b.south;
}

/**
 * Ice that blocks ships this tick, as rows (north, south), or null when nothing is frozen or Season effects is off.
 * Callers test a tile's row against it (cheap enough for every ship step).
 */
export function iceBlocks(state: GameState): { north: number; south: number; w: number } | null {
  if (!seasonEffectsOn(state)) return null;
  const b = iceBand(state);
  return b.north > 0 ? { north: b.north, south: b.south, w: state.map.width } : null;
}

/** True when `tile` (a water tile) lies in the blocking ice `ice` (from iceBlocks). */
export function inIce(ice: { north: number; south: number; w: number }, tile: number): boolean {
  const y = (tile / ice.w) | 0;
  return y < ice.north || y >= ice.south;
}

/** Plains and fertile land: where spring mud slows tanks. */
export function isMudGround(state: GameState, tile: number): boolean {
  return state.map.terrain[tile] === Terrain.Plains || (state.map.resource[tile] === Resource.Fertile && !isWater(state.map.terrain[tile]));
}

/**
 * Season ground of an attack this tick, looked up once per attack (combat.fightCtx): mud on (spring), snow rows from
 * each pole and whether tundra is snow (winter). null with effects off or nothing in season.
 */
export interface SeasonGround {
  mud: boolean;
  snowRows: number;
  tundraSnow: boolean;
  h: number;
  w: number;
}
export function seasonGround(state: GameState): SeasonGround | null {
  if (!seasonEffectsOn(state)) return null;
  const s = seasonAt(state);
  const rows = snowRowsAt(playTicks(state), state.map.height);
  const mud = s.season === 'spring';
  const tundraSnow = s.season === 'winter';
  if (!mud && rows <= 0 && !tundraSnow) return null;
  return { mud, snowRows: rows, tundraSnow, h: state.map.height, w: state.map.width };
}

/** 0 = nothing, 1 = mud, 2 = snow at `tile` for the ground `g` (snow wins over mud). */
export function groundKind(state: GameState, g: SeasonGround, tile: number): 0 | 1 | 2 {
  const ter = state.map.terrain[tile];
  if (g.tundraSnow && ter === Terrain.Tundra) return 2;
  if (g.snowRows > 0) {
    const y = (tile / g.w) | 0;
    if (y < g.snowRows || y >= g.h - g.snowRows) return 2;
  }
  if (g.mud && (ter === Terrain.Plains || state.map.resource[tile] === Resource.Fertile)) return 1;
  return 0;
}

/**
 * Attack speed factor (< 1 = slower) on ground kind `k` for an attack with `armorShare` armor: mud slows the armor
 * share; snow slows everyone, armor more.
 */
export function seasonAttackSpeed(k: 0 | 1 | 2, armorShare: number): number {
  if (k === 1) return 1 - armorShare * (1 - SEASON.mudArmor);
  if (k === 2) return 1 - (1 - armorShare) * (1 - SEASON.snowInfantry) - armorShare * (1 - SEASON.snowArmor);
  return 1;
}

/** Tank division head speed factor at `tile` (1 = no season effect). */
export function seasonTankSpeed(state: GameState, tile: number): number {
  const g = seasonGround(state);
  if (!g) return 1;
  const k = groundKind(state, g, tile);
  return k === 1 ? SEASON.mudArmor : k === 2 ? SEASON.snowArmor : 1;
}

/** Autumn harvest: gold income factor for a nation with `farmUnits` farm units (1 outside autumn or with effects off). */
export function harvestGoldMul(state: GameState, farmUnits: number): number {
  if (farmUnits <= 0 || activeSeason(state) !== 'autumn') return 1;
  return 1 + Math.min(SEASON.harvestMax, SEASON.harvestPerFarm * farmUnits);
}

/** One plain line: what the season does in this game (the top bar chip). */
export function seasonEffectLine(state: GameState): string {
  if (!seasonEffectsOn(state)) return 'Season effects are off in this game';
  switch (seasonAt(state).season) {
    case 'spring':
      return snowRows(state) > 0 ? 'Mud: tanks are slower on plains and farmland. Melting snow still slows attacks' : 'Mud: tanks are slower on plains and farmland';
    case 'summer':
      return 'Summer: no effect. A good time for big pushes';
    case 'autumn':
      return `Harvest: farms add up to ${Math.round(SEASON.harvestMax * 100)}% gold`;
    case 'winter':
      return 'Attacks through snow are slower, tanks even more. Sea ice near the poles stops ships';
  }
}

/**
 * AI season plan: true while new armor pushes should wait (spring mud and winter snow, with effects on). Bots then
 * hold their tank divisions and send fewer tanks in new attacks (ai.ts, armor2.ts, tanks.ts).
 */
export function aiArmorPause(state: GameState): boolean {
  const s = activeSeason(state);
  return s === 'spring' || s === 'winter';
}

/**
 * AI war trigger factor: < 1 = push sooner (summer and the first half of autumn), > 1 = hold and build (winter), 1
 * otherwise or with effects off.
 */
export function aiSeasonTrigger(state: GameState): number {
  if (!seasonEffectsOn(state)) return 1;
  const s = seasonAt(state);
  if (s.season === 'summer' || (s.season === 'autumn' && s.progress < 0.5)) return SEASON.aiPushTrigger;
  if (s.season === 'winter') return SEASON.aiWinterTrigger;
  return 1;
}
