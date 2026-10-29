// Game creation, spawning, ownership changes, events, ids.
import {
  AI_COLORS,
  AI_NAMES,
  BUILDINGS,
  MAX_EVENTS,
  PERSONALITIES,
  SPAWN_RADIUS,
  SPAWN_SECONDS,
  START_GOLD,
  START_INFANTRY,
  START_IRON,
  START_OIL,
  START_WORKERS,
  TICKS_PER_SECOND,
} from './config';
import { forEachInRadius, nearestTile } from './grid';
import { generateMap } from './mapgen';
import { makeRng, randInt, shuffle } from './rng';
import { isWater } from './types';
import type { GameEventKind, GameSettings, GameState, MapData, Personality, Player } from './types';

/** Minimum distance between spawned capitals. */
export const SPAWN_MIN_DISTANCE = 12;

export function makePlayer(
  id: number,
  name: string,
  color: [number, number, number],
  isHuman: boolean,
  personality: Personality | null,
): Player {
  return {
    id,
    name,
    color,
    isHuman,
    personality,
    alive: id !== 0,
    spawned: false,
    capital: -1,
    tiles: 0,
    workers: 0,
    troops: { infantry: 0, armor: 0, artillery: 0 },
    gold: START_GOLD,
    iron: START_IRON,
    oil: START_OIL,
    science: 0,
    maxPop: 0,
    income: { gold: 0, iron: 0, oil: 0, science: 0, pop: 0 },
    armyRatio: 0.4,
    armyMix: { armor: 0, artillery: 0 },
    techs: [],
    researching: null,
    researchProgress: 0,
    traitorUntil: 0,
    embargoes: [],
    stats: { tilesMax: 0, troopsLost: 0, troopsKilled: 0, tilesCaptured: 0, buildingsBuilt: 0, goldEarned: 0 },
    eliminatedTick: -1,
  };
}

/** Builds a fresh GameState around an existing map and player list (players[0] must be the neutral entry). */
export function makeGameState(
  settings: GameSettings,
  map: MapData,
  players: Player[],
  rngPair: { rng: () => number; state: { s: number } },
): GameState {
  const human = players.find((p) => p.isHuman);
  return {
    settings,
    tick: 0,
    phase: 'spawn',
    spawnLeft: SPAWN_SECONDS,
    map,
    players,
    humanId: human ? human.id : 0,
    buildings: new Map(),
    attacks: [],
    units: [],
    alliances: [],
    allianceRequests: [],
    opinion: players.map(() => players.map(() => 0)),
    events: [],
    nextId: 1,
    rng: rngPair.rng,
    rngState: rngPair.state,
    supplyDist: new Map(),
    winner: 0,
    effects: [],
  };
}

function colorDist(a: [number, number, number], b: [number, number, number]): number {
  return Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);
}

export function createGame(settings: GameSettings): GameState {
  const rngPair = makeRng(settings.seed);
  const rng = rngPair.rng;
  const map = generateMap(settings, rng);

  const players: Player[] = [makePlayer(0, 'Neutral', [128, 128, 128], false, null)];
  players[0].gold = 0;
  if (settings.humanPlayer) {
    players.push(makePlayer(1, settings.playerName || 'You', settings.playerColor, true, null));
  }
  const names = shuffle(rng, AI_NAMES.slice());
  // AI colours in order, skipping ones too close to the human's colour.
  const colors = settings.humanPlayer ? AI_COLORS.filter((c) => colorDist(c, settings.playerColor) > 90) : AI_COLORS.slice();
  if (colors.length === 0) colors.push(...AI_COLORS);
  const aiCount = Math.max(0, Math.floor(settings.aiCount));
  for (let k = 0; k < aiCount; k++) {
    const id = players.length;
    const personality = PERSONALITIES[randInt(rng, PERSONALITIES.length)];
    const name = names[k % names.length] + (k >= names.length ? ` ${Math.floor(k / names.length) + 1}` : '');
    players.push(makePlayer(id, name, colors[k % colors.length], false, personality));
  }
  return makeGameState(settings, map, players, rngPair);
}

/** Valid spawn: land, unowned, no fallout, at least 12 tiles from other spawned capitals. */
export function canSpawnAt(state: GameState, playerId: number, tile: number): boolean {
  const map = state.map;
  if (!Number.isInteger(tile) || tile < 0 || tile >= map.width * map.height) return false;
  if (isWater(map.terrain[tile]) || map.fallout[tile] > 0) return false;
  // Moving your own start during the spawn phase may target your own tiles.
  const o = map.owner[tile];
  if (o !== 0 && o !== playerId) return false;
  const w = map.width;
  const x = tile % w;
  const y = (tile / w) | 0;
  for (const p of state.players) {
    if (p.id === 0 || p.id === playerId || !p.spawned || p.capital < 0) continue;
    const dx = (p.capital % w) - x;
    const dy = ((p.capital / w) | 0) - y;
    if (dx * dx + dy * dy < SPAWN_MIN_DISTANCE * SPAWN_MIN_DISTANCE) return false;
  }
  return true;
}

/** Places (or moves, during the spawn phase) a player's start territory (SPAWN_RADIUS) and capital. */
export function spawnPlayer(state: GameState, playerId: number, tile: number): boolean {
  const p = state.players[playerId];
  if (!p || playerId === 0 || !p.alive) return false;
  if (p.spawned && state.phase !== 'spawn') return false;
  if (!canSpawnAt(state, playerId, tile)) return false;
  placeStart(state, playerId, tile);
  return true;
}

/** Unchecked spawn: clears any previous start, claims connected free land within SPAWN_RADIUS. */
function placeStart(state: GameState, playerId: number, tile: number): void {
  const map = state.map;
  const p = state.players[playerId];
  const n = map.width * map.height;
  if (p.spawned) {
    // Re-spawn during the spawn phase: drop the old start directly (no elimination / capital logic).
    for (let i = 0; i < n; i++) if (map.owner[i] === playerId) map.owner[i] = 0;
    p.tiles = 0;
  } else {
    p.workers = START_WORKERS;
    p.troops = { infantry: START_INFANTRY, armor: 0, artillery: 0 };
  }
  // Flood fill over free land so the start does not jump across water.
  const w = map.width;
  const cx = tile % w;
  const cy = (tile / w) | 0;
  const r2 = SPAWN_RADIUS * SPAWN_RADIUS;
  const seen = new Set<number>([tile]);
  const stack = [tile];
  while (stack.length) {
    const i = stack.pop()!;
    setOwner(state, i, playerId);
    const x = i % w;
    const y = (i / w) | 0;
    const nbs = [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < map.height - 1 ? i + w : -1];
    for (const j of nbs) {
      if (j < 0 || seen.has(j)) continue;
      seen.add(j);
      const dx = (j % w) - cx;
      const dy = ((j / w) | 0) - cy;
      if (dx * dx + dy * dy > r2) continue;
      if (isWater(map.terrain[j]) || map.owner[j] !== 0 || map.fallout[j] > 0) continue;
      stack.push(j);
    }
  }
  p.capital = tile;
  p.spawned = true;
  p.alive = true;
  p.eliminatedTick = -1;
}

/** Number of non-water, non-mountain tiles within radius r: a cheap "is this a good start" score. */
function startScore(map: MapData, tile: number, r: number): number {
  let s = 0;
  forEachInRadius(map, tile, r, (i) => {
    const t = map.terrain[i];
    if (!isWater(t) && map.owner[i] === 0) s += t === 5 ? 0.2 : 1;
  });
  return s;
}

/** Spawns every player who has not spawned yet at a random valid spot (end of spawn phase). */
export function autoSpawnRemaining(state: GameState): void {
  const map = state.map;
  const n = map.width * map.height;
  const rng = state.rng;
  for (const p of state.players) {
    if (p.id === 0 || !p.alive || p.spawned) continue;
    // Sample some valid spots and keep the one with the most usable land around it.
    let best = -1;
    let bestScore = -1;
    let valid = 0;
    for (let tries = 0; tries < 3000 && valid < 12; tries++) {
      const t = randInt(rng, n);
      if (!canSpawnAt(state, p.id, t)) continue;
      valid++;
      const s = startScore(map, t, 6);
      if (s > bestScore) {
        bestScore = s;
        best = t;
      }
    }
    if (best < 0) {
      // Crowded map: scan from a random offset for any valid tile, then for any free land at all.
      const off = randInt(rng, n);
      for (let k = 0; k < n && best < 0; k++) {
        const t = (off + k) % n;
        if (canSpawnAt(state, p.id, t)) best = t;
      }
      for (let k = 0; k < n && best < 0; k++) {
        const t = (off + k) % n;
        if (!isWater(map.terrain[t]) && map.owner[t] === 0) best = t;
      }
    }
    if (best >= 0) placeStart(state, p.id, best);
  }
}

/**
 * The single way to change a tile's owner. Keeps Player.tiles in sync, handles the building on the tile
 * (capture if BUILDINGS[type].capturable and newOwner != 0, else destroy), capital loss (move capital, -30% gold,
 * 'capitalLost' event), and elimination when a player's tiles reach 0 (alive=false, attacks/units removed,
 * 'eliminated' event, stats).
 */
export function setOwner(state: GameState, tile: number, newOwner: number): void {
  const map = state.map;
  const old = map.owner[tile];
  if (old === newOwner) return;
  map.owner[tile] = newOwner;
  const players = state.players;
  if (old !== 0) players[old].tiles--;
  if (newOwner !== 0) {
    const np = players[newOwner];
    np.tiles++;
    if (state.phase === 'playing') np.stats.tilesCaptured++;
  }

  // Building on the tile.
  const bIdx = map.building[tile] - 1;
  if (bIdx >= 0) {
    const b = state.buildings.get(bIdx);
    if (!b) {
      map.building[tile] = 0;
    } else if (newOwner !== 0 && BUILDINGS[b.type].capturable) {
      const prevOwner = b.owner;
      b.owner = newOwner;
      addEvent(state, 'buildingCaptured', `${players[newOwner].name} captured a ${BUILDINGS[b.type].name} of ${players[prevOwner]?.name ?? 'nobody'}`, [newOwner, prevOwner], tile);
    } else {
      state.buildings.delete(b.id);
      map.building[tile] = 0;
      if (b.owner !== 0) addEvent(state, 'buildingLost', `${players[b.owner].name} lost a ${BUILDINGS[b.type].name}`, [b.owner], tile);
    }
  }

  if (old === 0) return;
  const op = players[old];
  if (op.tiles <= 0) {
    op.tiles = 0;
    if (op.spawned && op.alive) eliminatePlayer(state, old, newOwner);
    return;
  }
  if (op.capital === tile) moveCapital(state, old, tile, newOwner);
}

/** Capital lost: move it to the biggest finished city, else the nearest owned tile; -30% gold. */
function moveCapital(state: GameState, playerId: number, lostTile: number, taker: number): void {
  const p = state.players[playerId];
  const map = state.map;
  let best = -1;
  let bestLevel = 0;
  for (const b of state.buildings.values()) {
    if (b.owner !== playerId || b.type !== 'city' || b.buildLeft > 0) continue;
    if (b.level > bestLevel) {
      bestLevel = b.level;
      best = b.tile;
    }
  }
  if (best < 0) best = nearestTile(map, lostTile, Math.max(map.width, map.height) * 1.5, (i) => map.owner[i] === playerId);
  p.capital = best;
  // A capital that falls back tile by tile under a running attack would otherwise lose 30% gold (and send an
  // event) every few ticks: the penalty and the event only apply once per CAPITAL_LOSS_COOLDOWN.
  const last = lastCapitalLoss.get(state)?.get(playerId);
  if (last !== undefined && state.tick - last < CAPITAL_LOSS_COOLDOWN * TICKS_PER_SECOND) return;
  let m = lastCapitalLoss.get(state);
  if (!m) lastCapitalLoss.set(state, (m = new Map()));
  m.set(playerId, state.tick);
  p.gold *= 0.7;
  const by = taker !== 0 ? ` to ${state.players[taker].name}` : '';
  addEvent(state, 'capitalLost', `${p.name} lost their capital${by}`, [playerId, taker].filter((x) => x !== 0), lostTile);
}

/** Seconds after a capital loss during which further losses cost no gold and send no event. */
export const CAPITAL_LOSS_COOLDOWN = 30;
const lastCapitalLoss = new WeakMap<GameState, Map<number, number>>();

/**
 * Removes a player from the game. Attacks and units can be mid-iteration in combat/units when this runs (it is
 * called from setOwner), so they are only neutralised here (troops zeroed / returned, hp 0); sim.tick prunes them.
 */
function eliminatePlayer(state: GameState, playerId: number, by: number): void {
  const p = state.players[playerId];
  p.alive = false;
  p.eliminatedTick = state.tick;
  p.capital = -1;
  p.researching = null;
  for (const a of state.attacks) {
    if (a.attacker === playerId) {
      a.troops.infantry = a.troops.armor = a.troops.artillery = 0;
    } else if (a.target === playerId) {
      // Nothing left to fight: troops go home.
      const home = state.players[a.attacker];
      home.troops.infantry += a.troops.infantry;
      home.troops.armor += a.troops.armor;
      home.troops.artillery += a.troops.artillery;
      a.troops.infantry = a.troops.armor = a.troops.artillery = 0;
    }
  }
  for (const u of state.units) {
    if (u.owner !== playerId) continue;
    u.hp = 0;
    u.troops.infantry = u.troops.armor = u.troops.artillery = 0;
  }
  for (const b of state.buildings.values()) {
    if (b.owner !== playerId) continue;
    state.buildings.delete(b.id);
    if (state.map.building[b.tile] === b.id + 1) state.map.building[b.tile] = 0;
  }
  state.alliances = state.alliances.filter((al) => al.a !== playerId && al.b !== playerId);
  state.allianceRequests = state.allianceRequests.filter((r) => r.from !== playerId && r.to !== playerId);
  p.troops = { infantry: 0, armor: 0, artillery: 0 };
  p.workers = 0;
  const byText = by !== 0 ? ` by ${state.players[by].name}` : '';
  addEvent(state, 'eliminated', `${p.name} has been eliminated${byText}`, [], -1);
}

/** Drops attacks and units that elimination neutralised (dead attacker/owner, or a dead target). */
export function pruneEliminated(state: GameState): void {
  const players = state.players;
  let dirty = false;
  for (const a of state.attacks) {
    if (!players[a.attacker].alive || (a.target !== 0 && !players[a.target].alive)) {
      dirty = true;
      break;
    }
  }
  if (dirty) {
    state.attacks = state.attacks.filter((a) => {
      if (!players[a.attacker].alive) return false;
      if (a.target !== 0 && !players[a.target].alive) {
        const home = players[a.attacker];
        home.troops.infantry += a.troops.infantry;
        home.troops.armor += a.troops.armor;
        home.troops.artillery += a.troops.artillery;
        return false;
      }
      return true;
    });
  }
  if (state.units.some((u) => !players[u.owner].alive)) {
    state.units = state.units.filter((u) => players[u.owner].alive);
  }
}

export function addEvent(state: GameState, kind: GameEventKind, message: string, players: number[], tile = -1): void {
  state.events.push({ tick: state.tick, kind, message, players, tile });
  if (state.events.length > MAX_EVENTS) state.events.splice(0, state.events.length - MAX_EVENTS);
}
export function newId(state: GameState): number {
  return state.nextId++;
}
