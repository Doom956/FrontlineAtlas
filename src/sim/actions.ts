// Single entry point for player and AI actions.
import { build, demolish } from './buildings';
import { launchAttack, retreat } from './combat';
import { answerAlliance, breakAlliance, gift, requestAlliance, toggleEmbargo } from './diplomacy';
import { canSpawnAt, spawnPlayer } from './state';
import { startResearch } from './tech';
import { TECHS } from './config';
import { buildAircraft, buildWarship, launchBomber, launchMissile, launchTransport, moveWarship } from './units';
import { TROOP_TYPES } from './types';
import type { Action, ActionResult, GameState, Player, Troops } from './types';

const FAIL = (reason: string): ActionResult => ({ ok: false, reason });

function isTile(state: GameState, t: unknown): t is number {
  return typeof t === 'number' && Number.isInteger(t) && t >= 0 && t < state.map.width * state.map.height;
}
function isPlayerId(state: GameState, id: unknown): id is number {
  return typeof id === 'number' && Number.isInteger(id) && id > 0 && id < state.players.length;
}
/** Troop counts must be finite, non-negative and available in the player's pool. */
function checkTroops(p: Player, t: Troops | undefined): string | null {
  if (!t) return 'No troops given';
  for (const k of TROOP_TYPES) {
    const v = t[k];
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return 'Invalid troop count';
    if (v > p.troops[k] + 1e-6) return `Not enough ${k}`;
  }
  return null;
}
/** Copy with values clamped to what the player has (removes float dust from the UI). */
function clampTroops(p: Player, t: Troops): Troops {
  return {
    infantry: Math.min(t.infantry, p.troops.infantry),
    armor: Math.min(t.armor, p.troops.armor),
    artillery: Math.min(t.artillery, p.troops.artillery),
  };
}
const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

export function applyAction(state: GameState, playerId: number, action: Action): ActionResult {
  const p = state.players[playerId];
  if (!p || playerId === 0) return FAIL('No such player');
  if (!p.alive) return FAIL('You have been eliminated');
  if (!action || typeof action !== 'object') return FAIL('Invalid action');

  if (action.type === 'spawn') {
    if (state.phase !== 'spawn') return FAIL('The spawn phase is over');
    if (!isTile(state, action.tile)) return FAIL('Invalid tile');
    if (!canSpawnAt(state, playerId, action.tile)) return FAIL('Cannot start there (water, taken, or too close to another nation)');
    return spawnPlayer(state, playerId, action.tile) ? { ok: true } : FAIL('Cannot start there');
  }
  if (state.phase !== 'playing') return FAIL(state.phase === 'spawn' ? 'Wait for the spawn phase to end' : 'The game is over');
  if (!p.spawned) return FAIL('You have not spawned');

  switch (action.type) {
    case 'attack': {
      if (!isTile(state, action.tile)) return FAIL('Invalid tile');
      const bad = checkTroops(p, action.troops);
      if (bad) return FAIL(bad);
      return launchAttack(state, playerId, action.tile, clampTroops(p, action.troops));
    }
    case 'retreat':
      return retreat(state, playerId, action.attackId);
    case 'build':
      if (!isTile(state, action.tile)) return FAIL('Invalid tile');
      return build(state, playerId, action.building, action.tile);
    case 'demolish':
      if (!isTile(state, action.tile)) return FAIL('Invalid tile');
      return demolish(state, playerId, action.tile);
    case 'setArmyRatio': {
      if (typeof action.value !== 'number' || !Number.isFinite(action.value)) return FAIL('Invalid value');
      p.armyRatio = clamp(action.value, 0.1, 0.9);
      return { ok: true };
    }
    case 'setArmyMix': {
      if (!Number.isFinite(action.armor) || !Number.isFinite(action.artillery)) return FAIL('Invalid value');
      let armor = clamp(action.armor, 0, 0.8);
      let artillery = clamp(action.artillery, 0, 0.8);
      const sum = armor + artillery;
      if (sum > 0.9) {
        armor *= 0.9 / sum;
        artillery *= 0.9 / sum;
      }
      p.armyMix = { armor, artillery };
      return { ok: true };
    }
    case 'research':
      if (!(action.tech in TECHS)) return FAIL('Unknown tech');
      return startResearch(state, playerId, action.tech);
    case 'transport': {
      if (!isTile(state, action.from) || !isTile(state, action.to)) return FAIL('Invalid tile');
      const bad = checkTroops(p, action.troops);
      if (bad) return FAIL(bad);
      return launchTransport(state, playerId, action.from, action.to, clampTroops(p, action.troops));
    }
    case 'buildWarship':
      if (!isTile(state, action.port)) return FAIL('Invalid tile');
      return buildWarship(state, playerId, action.port);
    case 'moveWarship':
      if (!isTile(state, action.tile)) return FAIL('Invalid tile');
      return moveWarship(state, playerId, action.unitId, action.tile);
    case 'buildAircraft':
      if (!isTile(state, action.airfield)) return FAIL('Invalid tile');
      if (action.kind !== 'bomber' && action.kind !== 'fighter') return FAIL('Invalid aircraft');
      return buildAircraft(state, playerId, action.airfield, action.kind);
    case 'bomb':
      if (!isTile(state, action.airfield) || !isTile(state, action.tile)) return FAIL('Invalid tile');
      return launchBomber(state, playerId, action.airfield, action.tile);
    case 'launchMissile':
      if (!isTile(state, action.silo) || !isTile(state, action.tile)) return FAIL('Invalid tile');
      if (action.kind !== 'rocket' && action.kind !== 'atomBomb') return FAIL('Invalid missile');
      return launchMissile(state, playerId, action.silo, action.kind, action.tile);
    case 'requestAlliance':
      if (!isPlayerId(state, action.to)) return FAIL('No such nation');
      return requestAlliance(state, playerId, action.to);
    case 'answerAlliance':
      if (!isPlayerId(state, action.from)) return FAIL('No such nation');
      return answerAlliance(state, playerId, action.from, !!action.accept);
    case 'breakAlliance':
      if (!isPlayerId(state, action.with)) return FAIL('No such nation');
      return breakAlliance(state, playerId, action.with);
    case 'gift': {
      if (!isPlayerId(state, action.to)) return FAIL('No such nation');
      const gold = action.gold ?? 0;
      const troops = action.troops ?? 0;
      if (!Number.isFinite(gold) || !Number.isFinite(troops) || gold < 0 || troops < 0) return FAIL('Invalid amount');
      if (gold > p.gold) return FAIL('Not enough gold');
      if (troops > p.troops.infantry) return FAIL('Not enough infantry');
      return gift(state, playerId, action.to, gold, troops);
    }
    case 'toggleEmbargo':
      if (!isPlayerId(state, action.with)) return FAIL('No such nation');
      return toggleEmbargo(state, playerId, action.with);
    default:
      return FAIL('Unknown action');
  }
}
