// Game modifiers and teams during a game: what the sim refuses (with a plain reason) and the rate multipliers.
// setup.ts holds the options themselves; every system asks here, the AI and the client too, so a modifier is
// enforced in one place. Deterministic: reads only the settings, the tick and the team list.
import { BUILDINGS, TICKS_PER_SECOND } from './config';
import { BUILD_TIME_FACTOR, DEFAULT_MODIFIERS, FAST_GAME_FACTOR } from './setup';
import { isTribe } from './types';
import type { BuildingType, GameState, Modifiers } from './types';

/** The game's modifiers (defaults when a hand-made test state has none). */
export function mods(state: GameState): Modifiers {
  return state.settings.modifiers ?? DEFAULT_MODIFIERS;
}

// ------------------------------------------------------------------------------------------------ teams

/** Team of a player (0 = none). */
export function teamOf(state: GameState, id: number): number {
  return state.teams?.[id] ?? 0;
}
/** True for two different players on the same team (teammates are permanently allied). */
export function sameTeam(state: GameState, a: number, b: number): boolean {
  if (a === b || a <= 0 || b <= 0) return false;
  const t = state.teams;
  if (!t || !t.length) return false;
  const ta = t[a] ?? 0;
  return ta > 0 && ta === (t[b] ?? 0);
}
export function isTeamGame(state: GameState): boolean {
  return state.settings.mode === 'teams' && !!state.teams?.some((t) => t > 0);
}

// ------------------------------------------------------------------------------------------------ peace time

/** Seconds of peace time left (0 = none or over). Counts game time, so it is 0 during the spawn phase's end only. */
export function peaceSecondsLeft(state: GameState): number {
  const minutes = mods(state).peaceMinutes;
  if (!(minutes > 0) || state.phase === 'over') return 0;
  const elapsed = state.phase === 'spawn' ? 0 : Math.max(0, state.tick - state.playStartTick) / TICKS_PER_SECOND;
  return Math.max(0, minutes * 60 - elapsed);
}
export function peaceActive(state: GameState): boolean {
  return peaceSecondsLeft(state) > 0;
}
/** True while peace time keeps a and b apart: two different nations or players (tribes can always be attacked). */
export function atPeace(state: GameState, a: number, b: number): boolean {
  if (a === b || a <= 0 || b <= 0 || !peaceActive(state)) return false;
  const pa = state.players[a];
  const pb = state.players[b];
  return !!pa && !!pb && !isTribe(pa) && !isTribe(pb);
}
/** "Peace time: nations can't attack each other for 1:23 more", or null when a may attack b. */
export function peaceReason(state: GameState, a: number, b: number): string | null {
  if (!atPeace(state, a, b)) return null;
  const s = Math.ceil(peaceSecondsLeft(state));
  return `Peace time: nations can't attack each other for ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')} more`;
}

// ------------------------------------------------------------------------------------------------ what is allowed

/** Why a building type can't be built in this game, or null. */
export function buildingRule(state: GameState, type: BuildingType): string | null {
  const m = mods(state);
  if (type === 'airfield' && m.noAir) return 'No air force in this game: airfields are off';
  if (type === 'sam' && m.noSams) return 'SAM sites are off in this game';
  if (type === 'lab' && m.research !== 'normal') return m.research === 'off' ? 'Research is off in this game, so labs have no use' : 'Every technology is already unlocked, so labs have no use';
  const tech = BUILDINGS[type]?.tech;
  if (tech && m.research === 'off') return `Research is off in this game, so ${BUILDINGS[type].name} stays locked`;
  return null;
}
export function buildingAllowed(state: GameState, type: BuildingType): boolean {
  return buildingRule(state, type) === null;
}

export type RuledUnit = 'atomBomb' | 'bomber' | 'fighter' | 'paradrop' | 'warship';
/** Why a unit or strike is off in this game, or null. */
export function unitRule(state: GameState, kind: RuledUnit): string | null {
  const m = mods(state);
  if (kind === 'atomBomb' && m.noNukes) return 'Atom bombs are off in this game';
  if ((kind === 'bomber' || kind === 'fighter' || kind === 'paradrop') && m.noAir) return 'No air force in this game';
  if (kind === 'warship' && m.noNavy) return 'Warships are off in this game';
  return null;
}
export function unitAllowed(state: GameState, kind: RuledUnit): boolean {
  return unitRule(state, kind) === null;
}

/** Why research is impossible in this game, or null. */
export function researchRule(state: GameState): string | null {
  const r = mods(state).research;
  if (r === 'off') return 'Research is off in this game';
  if (r === 'allUnlocked') return 'Every technology is already unlocked in this game';
  return null;
}

export function alliancesAllowed(state: GameState): boolean {
  return !mods(state).noAlliances;
}

// ------------------------------------------------------------------------------------------------ rates

const fast = (state: GameState): number => (mods(state).fastGame ? FAST_GAME_FACTOR : 1);
/** Gold income multiplier (gold modifier x fast game). */
export function goldRate(state: GameState): number {
  return (mods(state).goldMultiplier || 1) * fast(state);
}
/** Troop growth multiplier (growth modifier x fast game). */
export function growthRate(state: GameState): number {
  return (mods(state).troopGrowth || 1) * fast(state);
}
/** Iron, oil and science income multiplier (fast game). */
export function resourceRate(state: GameState): number {
  return fast(state);
}
/** Attack front speed multiplier (fast game). */
export function frontRate(state: GameState): number {
  return fast(state);
}
/**
 * Seconds a construction or upgrade of `baseSeconds` takes: build speed x fast game; instant = one tick, so the
 * "finished" event still fires.
 */
export function buildSeconds(state: GameState, baseSeconds: number): number {
  const f = BUILD_TIME_FACTOR[mods(state).buildSpeed] ?? 1;
  if (f <= 0) return 1 / TICKS_PER_SECOND;
  return Math.max(1 / TICKS_PER_SECOND, (baseSeconds * f) / fast(state));
}

// ------------------------------------------------------------------------------------------------ events

/** Announces the end of peace time (and a one-minute warning). Called once per tick by sim.ts. */
export function updateRules(state: GameState, addInfo: (message: string) => void): void {
  const minutes = mods(state).peaceMinutes;
  if (!(minutes > 0) || state.phase !== 'playing') return;
  const at = state.tick - state.playStartTick;
  const end = minutes * 60 * TICKS_PER_SECOND;
  if (at === end) addInfo('Peace time is over: nations can attack each other');
  else if (minutes > 1 && at === end - 60 * TICKS_PER_SECOND) addInfo('Peace time ends in 1 minute');
}
