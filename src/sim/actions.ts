// Single entry point for player and AI actions.
import { requestAllyAid, requestAllyAttack } from './allies';
import { build, demolish } from './buildings';
import { boatLandingTile, launchAttack, needsBoat, retreat } from './combat';
import { answerAlliance, breakAlliance, gift, requestAlliance, toggleEmbargo } from './diplomacy';
import { mods } from './rules';
import { canSpawnAt, spawnPlayer } from './state';
import { startResearch } from './tech';
import { BUILDINGS, TECHS } from './config';
import { buyWarBonds, fundAlly, hireMercenaries } from './spending';
import { buildMany, cancelQueuedLevels, upgradeArea, upgradeBuildings } from './bulkbuild';
import { launchBarrage } from './barrage';
import { chooseDoctrine } from './doctrines';
import { buildAircraft, launchBomber, launchMissile, launchParadrop, launchTransport, moveWarship } from './units';
import { moveWarships, orderWarship } from './navy';
import { buildTankDivision, moveTankDivisions } from './tanks';
import { setUnitStance } from './naval2';
import { setDivisionMode } from './armor2';
import { setAirMission } from './airwings';
import { reconFlight } from './variants';
import { aiActionBlocked, applyAdmin } from './admin';
import { continueGame } from './victory';
import { NAVAL_VARIANTS, TROOP_TYPES } from './types';
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
  // Continuing a finished game and the owner console work for eliminated humans too (they keep watching).
  if (action && typeof action === 'object' && action.type === 'continueGame') return continueGame(state, playerId);
  if (action && typeof action === 'object' && action.type === 'admin') return applyAdmin(state, playerId, action);
  if (!p.alive) return FAIL('You have been eliminated');
  if (!action || typeof action !== 'object') return FAIL('Invalid action');

  if (action.type === 'setAuto') {
    // Allowed in any phase (the menu can set it before the first tick).
    if (action.mix !== undefined && typeof action.mix !== 'boolean') return FAIL('Invalid value');
    if (action.research !== undefined && typeof action.research !== 'boolean') return FAIL('Invalid value');
    p.auto = { mix: action.mix ?? p.auto.mix, research: action.research ?? p.auto.research };
    return { ok: true };
  }
  if (action.type === 'startNow') {
    if (state.phase !== 'spawn') return FAIL('The game has already started');
    if (!p.isHuman) return FAIL('Only a player can start the game');
    if (state.players.some((q) => q.isHuman && q.alive && !q.spawned)) return FAIL('Every player must pick a start first');
    // The next tick ends the spawn phase: AIs take their spots, tribes fill the leftover space.
    state.spawnLeft = Math.min(state.spawnLeft, 1e-6);
    return { ok: true };
  }
  if (action.type === 'spawn') {
    if (state.phase !== 'spawn') return FAIL('The spawn phase is over');
    if (mods(state).randomSpawn) return FAIL('Random starts are on: your start was picked for you');
    if (!isTile(state, action.tile)) return FAIL('Invalid tile');
    if (!canSpawnAt(state, playerId, action.tile)) return FAIL('Cannot start there (water, taken, or too close to another nation)');
    return spawnPlayer(state, playerId, action.tile) ? { ok: true } : FAIL('Cannot start there');
  }
  if (state.phase !== 'playing') return FAIL(state.phase === 'spawn' ? 'Wait for the spawn phase to end' : 'The game is over');
  if (!p.spawned) return FAIL('You have not spawned');
  // Owner console: frozen AIs do nothing; protected players can't be targeted by AIs.
  if (!p.isHuman && state.admin) {
    const blocked = aiActionBlocked(state, action);
    if (blocked) return FAIL(blocked);
  }

  switch (action.type) {
    case 'attack': {
      if (!isTile(state, action.tile)) return FAIL('Invalid tile');
      const bad = checkTroops(p, action.troops);
      if (bad) return FAIL(bad);
      const troops = clampTroops(p, action.troops);
      // Land you can't reach on foot (another landmass): the same click sends a transport from your nearest coast.
      if (needsBoat(state, playerId, action.tile)) {
        const landing = boatLandingTile(state, action.tile);
        if (landing < 0) return FAIL('No coast to land on near there');
        return launchTransport(state, playerId, -1, landing, troops);
      }
      return launchAttack(state, playerId, action.tile, troops);
    }
    case 'retreat':
      return retreat(state, playerId, action.attackId);
    case 'build':
      if (!isTile(state, action.tile)) return FAIL('Invalid tile');
      return build(state, playerId, action.building, action.tile);
    case 'demolish':
      if (!isTile(state, action.tile)) return FAIL('Invalid tile');
      return demolish(state, playerId, action.tile);
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
      p.auto.mix = false; // a hand-set mix turns the advisor off for it
      return { ok: true };
    }
    case 'research': {
      if (!(action.tech in TECHS)) return FAIL('Unknown tech');
      const r = startResearch(state, playerId, action.tech);
      if (r.ok) p.auto.research = false; // picked by hand: the advisor stops choosing
      return r;
    }
    case 'transport': {
      if (!isTile(state, action.from) || !isTile(state, action.to)) return FAIL('Invalid tile');
      const bad = checkTroops(p, action.troops);
      if (bad) return FAIL(bad);
      return launchTransport(state, playerId, action.from, action.to, clampTroops(p, action.troops));
    }
    case 'buildWarship':
      if (action.tile !== undefined && !isTile(state, action.tile)) return FAIL('Invalid tile');
      if (action.variant !== undefined && (typeof action.variant !== 'string' || !NAVAL_VARIANTS.includes(action.variant))) return FAIL('Unknown ship type');
      if (action.tile !== undefined && action.port === -1) return orderWarship(state, playerId, -1, action.tile, action.variant);
      if (!isTile(state, action.port)) return FAIL('Invalid tile');
      return orderWarship(state, playerId, action.port, action.tile, action.variant);
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
    case 'paradrop':
      if (!isTile(state, action.airfield) || !isTile(state, action.tile)) return FAIL('Invalid tile');
      if (typeof action.troops !== 'number' || !Number.isFinite(action.troops) || action.troops < 0) return FAIL('Invalid troop count');
      return launchParadrop(state, playerId, action.airfield, action.tile, action.troops);
    case 'barrage':
      if (!isTile(state, action.tile)) return FAIL('Invalid tile');
      return launchBarrage(state, playerId, action.tile);
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
    case 'chooseDoctrine':
      if (typeof action.doctrine !== 'string') return FAIL('Unknown doctrine');
      return chooseDoctrine(state, playerId, action.doctrine);
    case 'requestAllyAttack':
      if (!isPlayerId(state, action.ally) || !isPlayerId(state, action.target)) return FAIL('No such nation');
      return requestAllyAttack(state, playerId, action.ally, action.target);
    case 'requestAllyAid':
      if (!isPlayerId(state, action.ally)) return FAIL('No such nation');
      return requestAllyAid(state, playerId, action.ally);
    case 'toggleEmbargo':
      if (!isPlayerId(state, action.with)) return FAIL('No such nation');
      return toggleEmbargo(state, playerId, action.with);
    // ---- gold uses (spending.ts) ----
    case 'hireMercenaries':
      if (typeof action.amount !== 'number' || !Number.isFinite(action.amount) || action.amount < 0) return FAIL('Invalid amount');
      return hireMercenaries(state, playerId, action.amount);
    case 'fundAlly':
      if (!isPlayerId(state, action.ally)) return FAIL('No such nation');
      if (typeof action.gold !== 'number' || !Number.isFinite(action.gold) || action.gold < 0) return FAIL('Invalid amount');
      return fundAlly(state, playerId, action.ally, action.gold);
    case 'warBonds':
      return buyWarBonds(state, playerId);
    // ---- bulk build (bulkbuild.ts) ----
    case 'buildMany':
      if (!isTile(state, action.tile)) return FAIL('Invalid tile');
      if (typeof action.building !== 'string' || !(action.building in BUILDINGS)) return FAIL('Unknown building');
      return buildMany(state, playerId, action.building, action.tile, action.count);
    case 'upgradeArea':
      if (!isTile(state, action.tile)) return FAIL('Invalid tile');
      if (action.building !== undefined && (typeof action.building !== 'string' || !(action.building in BUILDINGS))) return FAIL('Unknown building');
      return upgradeArea(state, playerId, action.tile, action.radius, action.building, action.levels);
    case 'upgradeBuildings':
      return upgradeBuildings(state, playerId, action.tiles, action.levels);
    case 'cancelQueuedLevels':
      if (!isTile(state, action.tile)) return FAIL('Invalid tile');
      return cancelQueuedLevels(state, playerId, action.tile);
    // ---- warship groups (navy.ts) and tank divisions (tanks.ts) ----
    case 'moveWarships':
      if (!isTile(state, action.tile)) return FAIL('Invalid tile');
      return moveWarships(state, playerId, action.unitIds, action.tile);
    case 'buildTankDivision':
      if (!isTile(state, action.tile)) return FAIL('Invalid tile');
      return buildTankDivision(state, playerId, action.tile);
    case 'moveTankDivision':
      if (!isTile(state, action.tile)) return FAIL('Invalid tile');
      return moveTankDivisions(state, playerId, action.unitIds, action.tile);
    // ---- air wings (airwings.ts) ----
    case 'setAirMission':
      if (action.airfield !== -1 && !isTile(state, action.airfield)) return FAIL('Invalid tile');
      if (action.target !== undefined && !isTile(state, action.target)) return FAIL('Invalid tile');
      return setAirMission(state, playerId, action.airfield, action.mission, action.target, action.refill);
    // ---- recon planes (variants.ts) ----
    case 'reconFlight':
      if (action.airfield !== -1 && !isTile(state, action.airfield)) return FAIL('Invalid tile');
      if (!isTile(state, action.tile)) return FAIL('Invalid tile');
      return reconFlight(state, playerId, action.airfield, action.tile);
    // ---- warship stances (naval2.ts) and division modes (armor2.ts) ----
    case 'setUnitStance':
      return setUnitStance(state, playerId, action.unitIds, action.stance);
    case 'setDivisionMode':
      if (action.front !== undefined && !isTile(state, action.front)) return FAIL('Invalid tile');
      return setDivisionMode(state, playerId, action.unitIds, action.mode, action.front);
    default:
      return FAIL('Unknown action');
  }
}
