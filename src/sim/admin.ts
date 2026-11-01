// Owner console (Action 'admin'): exact changes to any player, building, tile or AI, applied through applyAction on
// every client so lockstep games stay in sync. Online the relay server forwards these actions only from a session
// that proved the owner's code (server/admin.ts); single player the client unlocks the console with a hashed code
// (src/client/admin.ts). The sim only checks the shape of each op (ADMIN_OPS) and that a human sent it.
// No op sends an event that names the console: other players only see the effects.
import { BUILDINGS, DOCTRINE_LEVEL_SECONDS, START_TROOPS, TECHS, TICKS_PER_SECOND } from './config';
import { buildingAt, buildingMaxLevel, destroyBuilding, markBuildingsChanged } from './buildings';
import { annexTiles, launchAttack } from './combat';
import { formAlliance } from './diplomacy';
import { doctrineTicks } from './doctrines';
import { forEachInRadius, neighbors4 } from './grid';
import { spawnTankDivision } from './tanks';
import { gameSeconds, newId, setOwner } from './state';
import { spawnWarshipAt } from './units';
import { DOCTRINE_IDS, TROOP_TYPES, isWater } from './types';
import type { Action, ActionResult, AdminAction, AdminOp, AdminState, Building, BuildingType, Difficulty, DoctrineId, GameState, TechId, Troops } from './types';
import { deliverAllOrders } from './procurement';

const FAIL = (reason: string): ActionResult => ({ ok: false, reason });
const OK: ActionResult = { ok: true };

type Field = 'player' | 'other' | 'tile' | 'amount' | 'key' | 'flag' | 'troops';
/**
 * Every op with the fields it needs (`?` = optional). player defaults to the sender. Kept in one table so the server
 * (server/validate.ts) and the client console can list them.
 */
export const ADMIN_OPS: Record<AdminOp, readonly string[]> = {
  setResource: ['player?', 'key', 'amount'],
  addResource: ['player?', 'key', 'amount'],
  setTroops: ['player?', 'troops?', 'amount?'],
  addTroops: ['player?', 'troops?', 'amount?'],
  fillTroops: ['player?'],
  unlockAllTechs: ['player?'],
  unlockTech: ['player?', 'key'],
  removeTech: ['player?', 'key'],
  finishResearch: ['player?'],
  finishConstructions: ['player?'],
  placeBuilding: ['player?', 'key', 'tile', 'amount?'],
  deleteBuilding: ['tile'],
  setBuildingLevel: ['tile', 'amount'],
  giveWarships: ['tile', 'amount?'],
  giveAircraft: ['tile', 'key', 'amount?'],
  giveCharges: ['tile'],
  spawnWarship: ['player?', 'tile'],
  spawnTankDivision: ['player?', 'tile'],
  paintTiles: ['player?', 'tile', 'amount?'],
  neutralizeTiles: ['tile', 'amount?'],
  moveCapital: ['player?', 'tile'],
  forceAlliance: ['player?', 'other'],
  breakAlliance: ['player?', 'other'],
  declareWar: ['player', 'other'],
  setOpinion: ['player', 'other', 'amount'],
  aiPassive: ['player?', 'flag'],
  freezeAI: ['flag'],
  setDifficulty: ['key'],
  godMode: ['player?', 'flag'],
  setDoctrine: ['player?', 'key', 'amount?'],
  eliminate: ['player'],
  revive: ['player', 'tile', 'amount?'],
  setPeace: ['amount'],
  revealIntel: ['player?', 'flag'],
};
export const ADMIN_OP_LIST = Object.keys(ADMIN_OPS) as AdminOp[];
/** Largest brush radius (paintTiles / neutralizeTiles) and most units one give* op adds. */
export const ADMIN_MAX_RADIUS = 30;
export const ADMIN_MAX_UNITS = 20;
const RESOURCES = ['gold', 'iron', 'oil', 'science'] as const;
const DIFFICULTIES: readonly Difficulty[] = ['easy', 'normal', 'hard', 'brutal'];
const MAX_VALUE = 1e12;

/** The console state (created on first use). */
export function adminState(state: GameState): AdminState {
  if (!state.admin) state.admin = { aiPassive: [], godMode: [], aiFrozen: false, revealIntel: [] };
  return state.admin;
}
/** God mode: this player's land can't be captured (combat, spearheads). */
export function isProtected(state: GameState, playerId: number): boolean {
  return !!state.admin && state.admin.godMode.includes(playerId);
}
/** No AI may attack this player. */
export function isAiPassiveTarget(state: GameState, playerId: number): boolean {
  return !!state.admin && state.admin.aiPassive.includes(playerId);
}
export function aiFrozen(state: GameState): boolean {
  return !!state.admin && state.admin.aiFrozen;
}
/**
 * Tutorial (tutorialScenario.ts): the taught player is down to its last TutorialState.minTiles tiles, so attacks
 * and spearheads on it stop there.
 */
export function tutorialShielded(state: GameState, playerId: number): boolean {
  const t = state.tutorial;
  return !!t && t.noElimination && playerId === t.human && (state.players[playerId]?.tiles ?? 0) <= t.minTiles;
}
/** Tutorial: the taught player, which never collapses or gets absorbed (combat.collapseThreshold). */
export function tutorialKeeps(state: GameState, playerId: number): boolean {
  const t = state.tutorial;
  return !!t && t.noElimination && playerId === t.human;
}
/** Tutorial: this AI makes no decisions until tutorialWake. */
export function tutorialFrozen(state: GameState, playerId: number): boolean {
  return !!state.tutorial && state.tutorial.frozen.includes(playerId);
}
/** viewer sees every nation's intel (buildings.hasIntel). */
export function seesAllIntel(state: GameState, viewer: number): boolean {
  return !!state.admin && state.admin.revealIntel.includes(viewer);
}

/** Tile an AI action aims at (for the passive rule), or -1. */
function aimedTile(a: Action): number {
  switch (a.type) {
    case 'attack':
    case 'bomb':
    case 'launchMissile':
    case 'paradrop':
    case 'barrage':
    case 'moveTankDivision':
      return a.tile;
    case 'transport':
      return a.to;
    default:
      return -1;
  }
}
/**
 * Why an AI may not take this action now (console: AI frozen, or it aims at a protected player), or null.
 * applyAction calls it for every non-human actor.
 */
export function aiActionBlocked(state: GameState, action: Action): string | null {
  if (!state.admin) return null;
  if (state.admin.aiFrozen) return 'AI is frozen';
  if (!state.admin.aiPassive.length) return null;
  const t = aimedTile(action);
  if (t < 0 || !Number.isInteger(t) || t >= state.map.owner.length) return null;
  const o = state.map.owner[t];
  return o > 0 && state.admin.aiPassive.includes(o) ? 'That nation is off limits' : null;
}

// ------------------------------------------------------------------------------------------------ validation

function isInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v);
}
function isNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= MAX_VALUE;
}
function checkTroops(t: unknown): Troops | null {
  if (!t || typeof t !== 'object') return null;
  const o = t as Record<string, unknown>;
  const out = { infantry: 0, armor: 0, artillery: 0 };
  for (const k of TROOP_TYPES) {
    const v = o[k];
    if (!isNum(v) || v < 0) return null;
    out[k] = v;
  }
  return out;
}

/** Checks an admin action's fields against ADMIN_OPS and the state (ids, tiles); null = fine, else the reason. */
export function validateAdmin(state: GameState, a: AdminAction): string | null {
  if (!a || typeof a !== 'object' || typeof a.op !== 'string' || !Object.prototype.hasOwnProperty.call(ADMIN_OPS, a.op)) return 'Unknown console command';
  const spec = ADMIN_OPS[a.op];
  const need = (f: Field): 'no' | 'opt' | 'yes' => (spec.includes(f) ? 'yes' : spec.includes(`${f}?`) ? 'opt' : 'no');
  const nTiles = state.map.width * state.map.height;
  const checks: Record<Field, (v: unknown) => boolean> = {
    player: (v) => isInt(v) && v >= 0 && v < state.players.length,
    other: (v) => isInt(v) && v > 0 && v < state.players.length,
    tile: (v) => isInt(v) && v >= 0 && v < nTiles,
    amount: (v) => isNum(v),
    key: (v) => typeof v === 'string' && v.length > 0 && v.length <= 32,
    flag: (v) => typeof v === 'boolean',
    troops: (v) => checkTroops(v) !== null,
  };
  for (const f of ['player', 'other', 'tile', 'amount', 'key', 'flag', 'troops'] as Field[]) {
    const v = (a as unknown as Record<string, unknown>)[f];
    const n = need(f);
    if (v === undefined) {
      if (n === 'yes') return `Missing ${f}`;
      continue;
    }
    if (n === 'no') continue; // ignored
    if (!checks[f](v)) return `Invalid ${f}`;
  }
  return null;
}

// ------------------------------------------------------------------------------------------------ apply

/** The game's own copy of its settings before the console changes one (the caller's object stays untouched). */
function ownSettings(state: GameState): void {
  state.settings = { ...state.settings, modifiers: { ...state.settings.modifiers } };
}

/** Action 'admin' (actions.ts routes it here before the alive / phase checks). */
export function applyAdmin(state: GameState, senderId: number, a: AdminAction): ActionResult {
  const sender = state.players[senderId];
  if (!sender || senderId === 0 || !sender.isHuman) return FAIL('Not allowed');
  if (state.phase !== 'playing') return FAIL(state.phase === 'spawn' ? 'Wait for the spawn phase to end' : 'The game is over');
  const bad = validateAdmin(state, a);
  if (bad) return FAIL(bad);
  const pid = a.player && a.player > 0 ? a.player : senderId;
  const p = state.players[pid];
  const amount = a.amount ?? 0;
  const tile = a.tile ?? -1;
  const ad = (): AdminState => adminState(state);
  const toggle = (list: number[], id: number, on: boolean): void => {
    const k = list.indexOf(id);
    if (on && k < 0) {
      list.push(id);
      list.sort((x, y) => x - y);
    } else if (!on && k >= 0) list.splice(k, 1);
  };
  switch (a.op) {
    case 'setResource':
    case 'addResource': {
      const key = a.key as (typeof RESOURCES)[number];
      if (!RESOURCES.includes(key)) return FAIL('Resource must be gold, iron, oil or science');
      const v = a.op === 'setResource' ? amount : p[key] + amount;
      p[key] = Math.max(0, Math.min(MAX_VALUE, v));
      return OK;
    }
    case 'setTroops':
    case 'addTroops': {
      const t = a.troops ? checkTroops(a.troops)! : { infantry: Math.max(0, amount), armor: 0, artillery: 0 };
      if (!a.troops && a.amount === undefined) return FAIL('Give an amount or a troop split');
      for (const k of TROOP_TYPES) {
        if (a.op === 'setTroops') p.troops[k] = a.troops ? t[k] : k === 'infantry' ? t.infantry : p.troops[k];
        else p.troops[k] = Math.max(0, p.troops[k] + (a.troops ? t[k] : k === 'infantry' ? amount : 0));
      }
      return OK;
    }
    case 'fillTroops': {
      const have = p.troops.infantry + p.troops.armor + p.troops.artillery;
      p.troops.infantry += Math.max(0, p.maxPop - have);
      return OK;
    }
    case 'unlockAllTechs':
      for (const t of Object.keys(TECHS) as TechId[]) if (!p.techs.includes(t)) p.techs.push(t);
      p.researching = null;
      p.researchProgress = 0;
      p.procuring = []; // Arsenal orders (procurement.ts): granted now
      return OK;
    case 'unlockTech':
    case 'removeTech': {
      const t = a.key as TechId;
      if (!Object.prototype.hasOwnProperty.call(TECHS, t)) return FAIL('Unknown tech');
      if (a.op === 'unlockTech') {
        if (!p.techs.includes(t)) p.techs.push(t);
        if (p.researching === t) {
          p.researching = null;
          p.researchProgress = 0;
        }
        if (p.procuring) p.procuring = p.procuring.filter((o) => o.tech !== t); // an order of it is granted now
      } else p.techs = p.techs.filter((x) => x !== t);
      return OK;
    }
    case 'finishResearch': {
      // The running research and every Arsenal order (procurement.ts) finish at once.
      const orders = deliverAllOrders(state, p.id);
      if (!p.researching) return orders > 0 ? OK : FAIL('Nothing is being researched or on order');
      if (!p.techs.includes(p.researching)) p.techs.push(p.researching);
      p.researching = null;
      p.researchProgress = 0;
      return OK;
    }
    case 'finishConstructions': {
      let n = 0;
      for (const b of state.buildings.values()) {
        if (b.owner !== pid) continue;
        if (b.buildLeft > 0) {
          b.buildLeft = 0;
          p.stats.buildingsBuilt++;
          n++;
        } else if (b.upgradeLeft > 0) {
          b.upgradeLeft = 0;
          b.level = Math.min(buildingMaxLevel(b.type), b.level + 1);
          n++;
        }
      }
      if (n) markBuildingsChanged(state);
      return OK;
    }
    case 'placeBuilding': {
      const type = a.key as BuildingType;
      if (!Object.prototype.hasOwnProperty.call(BUILDINGS, type)) return FAIL('Unknown building');
      if (isWater(state.map.terrain[tile])) return FAIL('Buildings go on land');
      if (type === 'port' && !state.map.coastal[tile]) return FAIL('Ports go on the coast');
      if (state.map.owner[tile] !== pid) setOwner(state, tile, pid);
      const old = buildingAt(state, tile);
      if (old) destroyBuilding(state, old);
      const level = Math.max(1, Math.min(buildingMaxLevel(type), Math.round(a.amount ?? 1)));
      const id = newId(state);
      const b: Building = {
        id,
        type,
        owner: pid,
        tile,
        level,
        buildLeft: 0,
        upgradeLeft: 0,
        fighters: 0,
        bombers: 0,
        cooldown: 0,
        dropCooldown: 0,
        disabledUntil: 0,
        hp: 1,
        queuedLevels: 0,
      };
      state.buildings.set(id, b);
      state.map.building[tile] = id + 1;
      markBuildingsChanged(state);
      return OK;
    }
    case 'deleteBuilding': {
      const b = buildingAt(state, tile);
      if (!b) return FAIL('No building there');
      destroyBuilding(state, b);
      return OK;
    }
    case 'setBuildingLevel': {
      const b = buildingAt(state, tile);
      if (!b) return FAIL('No building there');
      b.level = Math.max(1, Math.min(buildingMaxLevel(b.type), Math.round(amount)));
      b.upgradeLeft = 0;
      markBuildingsChanged(state);
      return OK;
    }
    case 'giveWarships': {
      const b = buildingAt(state, tile);
      if (!b || b.type !== 'port') return FAIL('Click a port');
      const nb: number[] = [];
      const k = neighbors4(state.map, b.tile, nb);
      let water = -1;
      for (let q = 0; q < k && water < 0; q++) if (isWater(state.map.terrain[nb[q]])) water = nb[q];
      if (water < 0) return FAIL('This port has no open water');
      const n = Math.max(1, Math.min(ADMIN_MAX_UNITS, Math.round(a.amount ?? 1)));
      for (let q = 0; q < n; q++) spawnWarshipAt(state, b.owner, b.tile, water);
      return OK;
    }
    case 'giveAircraft': {
      const b = buildingAt(state, tile);
      if (!b || b.type !== 'airfield') return FAIL('Click an airfield');
      const n = Math.max(1, Math.min(ADMIN_MAX_UNITS, Math.round(a.amount ?? 1)));
      if (a.key === 'bomber') b.bombers += n;
      else if (a.key === 'fighter') b.fighters += n;
      else return FAIL('Aircraft must be bomber or fighter');
      return OK;
    }
    case 'giveCharges': {
      const b = buildingAt(state, tile);
      if (!b || (b.type !== 'silo' && b.type !== 'sam')) return FAIL('Click a silo or a SAM site');
      b.cooldown = 0;
      return OK;
    }
    case 'spawnWarship': {
      if (!isWater(state.map.terrain[tile])) return FAIL('Click a water tile');
      spawnWarshipAt(state, pid, tile, tile);
      return OK;
    }
    case 'spawnTankDivision': {
      if (isWater(state.map.terrain[tile]) || state.map.owner[tile] !== pid) return FAIL("Click that player's land");
      spawnTankDivision(state, pid, tile);
      return OK;
    }
    case 'paintTiles':
    case 'neutralizeTiles': {
      const to = a.op === 'paintTiles' ? pid : 0;
      const r = Math.max(0, Math.min(ADMIN_MAX_RADIUS, a.amount ?? 0));
      const tiles: number[] = [];
      forEachInRadius(state.map, tile, r, (i) => {
        if (!isWater(state.map.terrain[i])) tiles.push(i);
      });
      tiles.sort((x, y) => x - y);
      if (to > 0 && !state.players[to].alive) return FAIL('That player is eliminated: revive them first');
      for (const t of tiles) if (state.map.owner[t] !== to) setOwner(state, t, to);
      if (to > 0 && state.players[to].capital < 0 && state.map.owner[tile] === to) state.players[to].capital = tile;
      return OK;
    }
    case 'moveCapital':
      if (state.map.owner[tile] !== pid) return FAIL('The capital must be on their own land');
      p.capital = tile;
      p.heartTile = tile;
      p.heartMoveTick = 0;
      return OK;
    case 'forceAlliance':
    case 'breakAlliance': {
      const o = a.other!;
      if (o === pid) return FAIL('Pick two different players');
      if (!p.alive || !state.players[o].alive) return FAIL('Both must be alive');
      if (a.op === 'forceAlliance') formAlliance(state, pid, o);
      else state.alliances = state.alliances.filter((al) => !((al.a === pid && al.b === o) || (al.a === o && al.b === pid)));
      return OK;
    }
    case 'declareWar': {
      const o = a.other!;
      if (p.isHuman) return FAIL('Pick an AI nation');
      if (o === pid || !state.players[o].alive) return FAIL('Pick another living nation');
      state.alliances = state.alliances.filter((al) => !((al.a === pid && al.b === o) || (al.a === o && al.b === pid)));
      state.opinion[pid][o] = -100;
      // Attack across the shared border with 40% of the pool (the nearest border tile of the target to its capital).
      const map = state.map;
      let best = -1;
      let bestD = Infinity;
      const w = map.width;
      const cap = p.capital >= 0 ? p.capital : 0;
      const nb: number[] = [];
      for (let t = 0; t < map.owner.length; t++) {
        if (map.owner[t] !== o) continue;
        const k = neighbors4(map, t, nb);
        let touches = false;
        for (let q = 0; q < k; q++) if (map.owner[nb[q]] === pid) touches = true;
        if (!touches) continue;
        const dx = (t % w) - (cap % w);
        const dy = ((t / w) | 0) - ((cap / w) | 0);
        const d = dx * dx + dy * dy;
        if (d < bestD) {
          bestD = d;
          best = t;
        }
      }
      if (best < 0) return OK; // no shared border: the AI is hostile and acts on it by itself
      const troops: Troops = { infantry: p.troops.infantry * 0.4, armor: p.troops.armor * 0.4, artillery: p.troops.artillery * 0.4 };
      launchAttack(state, pid, best, troops);
      return OK;
    }
    case 'setOpinion': {
      const o = a.other!;
      state.opinion[pid][o] = Math.max(-100, Math.min(100, amount));
      return OK;
    }
    case 'aiPassive':
      toggle(ad().aiPassive, pid, !!a.flag);
      return OK;
    case 'freezeAI':
      ad().aiFrozen = !!a.flag;
      return OK;
    case 'setDifficulty': {
      if (!DIFFICULTIES.includes(a.key as Difficulty)) return FAIL('Difficulty must be easy, normal, hard or brutal');
      ownSettings(state);
      state.settings.difficulty = a.key as Difficulty;
      return OK;
    }
    case 'godMode':
      toggle(ad().godMode, pid, !!a.flag);
      return OK;
    case 'setDoctrine': {
      if (a.key === 'none') {
        p.doctrine = { id: null, level: 0, chosenTick: -1, adaptUntilTick: 0, lastSwitchTick: -1 };
        return OK;
      }
      if (!DOCTRINE_IDS.includes(a.key as DoctrineId)) return FAIL('Unknown doctrine');
      const level = Math.max(1, Math.min(3, Math.round(a.amount ?? 1))) as 1 | 2 | 3;
      // Back-date the choice so the level clock agrees with the level.
      const held = doctrineTicks(state, DOCTRINE_LEVEL_SECONDS[level - 1]);
      p.doctrine = { id: a.key as DoctrineId, level, chosenTick: state.tick - held, adaptUntilTick: 0, lastSwitchTick: state.tick };
      return OK;
    }
    case 'eliminate':
      if (!p.alive) return FAIL('Already eliminated');
      if (pid === senderId) return FAIL('Pick another player');
      annexTiles(state, pid, 0);
      return OK;
    case 'revive': {
      if (p.alive) return FAIL('That player is alive');
      if (isWater(state.map.terrain[tile])) return FAIL('Click a land tile');
      p.alive = true;
      p.spawned = true;
      p.eliminatedTick = -1;
      p.troops = { infantry: Math.max(1000, a.amount ?? START_TROOPS), armor: 0, artillery: 0 };
      const tiles: number[] = [];
      forEachInRadius(state.map, tile, 3, (i) => {
        if (!isWater(state.map.terrain[i])) tiles.push(i);
      });
      tiles.sort((x, y) => x - y);
      for (const t of tiles) if (state.map.owner[t] !== pid) setOwner(state, t, pid);
      p.capital = tile;
      p.heartTile = tile;
      p.heartMoveTick = 0;
      return OK;
    }
    case 'setPeace': {
      // amount = seconds of peace from now (0 = end peace time now).
      const secs = Math.max(0, Math.min(3600, amount));
      ownSettings(state);
      state.settings.modifiers.peaceMinutes = secs > 0 ? (gameSeconds(state) + secs) / 60 : 0;
      return OK;
    }
    case 'revealIntel':
      toggle(ad().revealIntel, pid, !!a.flag);
      return OK;
  }
  return FAIL('Unknown console command');
}

/** Ticks per second, re-exported for the console's countdowns. */
export const ADMIN_TICKS_PER_SECOND = TICKS_PER_SECOND;
