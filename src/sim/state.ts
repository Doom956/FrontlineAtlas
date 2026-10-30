// Game creation, spawning, ownership changes, events, ids.
import { destroyBuilding, markBuildingsChanged, onBuildingCaptured } from './buildings';
import { createTileChanges, recordTileChange } from './changes';
import {
  AI_COLORS,
  AI_NAMES,
  BUILDINGS,
  DEFAULT_TRIBE_COUNT,
  MAX_AI_COUNT,
  MAX_EVENTS,
  MAX_TRIBE_COUNT,
  PERSONALITIES,
  SPAWN_RADIUS_BY_SIZE,
  SPAWN_SECONDS,
  START_GOLD,
  START_IRON,
  START_OIL,
  START_TROOPS,
  TICKS_PER_SECOND,
  TRIBE_COLORS,
  TRIBE_NAMES,
  TRIBE_SPAWN_RADIUS,
  TRIBE_START_FACTOR,
} from './config';
import { forEachInRadius, nearestTile, prepareWater } from './grid';
import { generateMap } from './mapgen';
import { makeRng, randInt, shuffle } from './rng';
import { borderTiles, initTerritory, landComponents, onOwnerChange } from './territory';
import { isTribe, isWater } from './types';
import type { GameEventKind, GameSettings, GameState, MapData, MapSize, Personality, Player } from './types';

export { isTribe };

/** Starting territory radius of a nation on this game's map size. */
export function spawnRadius(state: GameState): number {
  return SPAWN_RADIUS_BY_SIZE[state.settings.mapSize as MapSize] ?? SPAWN_RADIUS_BY_SIZE.medium;
}
/** Minimum distance between spawned capitals (scales with the start radius, so starts never overlap). */
export function spawnMinDistance(state: GameState): number {
  return spawnRadius(state) * 3 + 2;
}
/** Minimum distance between spawned capitals on a medium map (see spawnMinDistance). */
export const SPAWN_MIN_DISTANCE = SPAWN_RADIUS_BY_SIZE.medium * 3 + 2;

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
    troops: { infantry: 0, armor: 0, artillery: 0 },
    gold: START_GOLD,
    iron: START_IRON,
    oil: START_OIL,
    science: 0,
    maxPop: 0,
    income: { gold: 0, iron: 0, oil: 0, science: 0, pop: 0 },
    armyMix: { armor: 0, artillery: 0 },
    // Humans get the advisor by default (army mix and research run themselves); AIs have their own logic.
    auto: { mix: isHuman, research: isHuman },
    techs: [],
    researching: null,
    researchProgress: 0,
    traitorUntil: 0,
    barrageReadyTick: 0,
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
  const state: GameState = {
    settings,
    tick: 0,
    phase: 'spawn',
    spawnLeft: SPAWN_SECONDS,
    playStartTick: 0,
    map,
    players,
    humanId: human ? human.id : 0,
    buildings: new Map(),
    attacks: [],
    units: [],
    barrages: [],
    alliances: [],
    allianceRequests: [],
    opinion: players.map(() => players.map(() => 0)),
    events: [],
    nextId: 1,
    rng: rngPair.rng,
    rngState: rngPair.state,
    winner: 0,
    effects: [],
    changes: createTileChanges(),
    buildingsVersion: 0,
  };
  initTerritory(state);
  return state;
}

function colorDist(a: [number, number, number], b: [number, number, number]): number {
  return Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);
}

/** Tribes for a game: settings.tribeCount when it is a number >= 0 (at most MAX_TRIBE_COUNT), else DEFAULT_TRIBE_COUNT. */
export function tribeCountFor(settings: Pick<GameSettings, 'tribeCount' | 'mapSize'>): number {
  const n = settings.tribeCount;
  if (typeof n === 'number' && Number.isFinite(n) && n >= 0) return Math.min(MAX_TRIBE_COUNT, Math.floor(n));
  return DEFAULT_TRIBE_COUNT[settings.mapSize as MapSize] ?? DEFAULT_TRIBE_COUNT.medium;
}

export function createGame(settings: GameSettings): GameState {
  const rngPair = makeRng(settings.seed);
  const rng = rngPair.rng;
  const map = generateMap(settings, rng);
  // Static landmass and water-body labels, computed now so play never pays for them.
  landComponents(map);
  prepareWater(map);

  const players: Player[] = [makePlayer(0, 'Neutral', [128, 128, 128], false, null)];
  players[0].gold = 0;
  if (settings.humanPlayer) {
    players.push(makePlayer(1, settings.playerName || 'You', settings.playerColor, true, null));
  }
  const names = shuffle(rng, AI_NAMES.slice());
  // AI colours in order, skipping ones too close to the human's colour.
  const colors = settings.humanPlayer ? AI_COLORS.filter((c) => colorDist(c, settings.playerColor) > 90) : AI_COLORS.slice();
  if (colors.length === 0) colors.push(...AI_COLORS);
  const aiCount = Math.max(0, Math.min(MAX_AI_COUNT, Math.floor(settings.aiCount)));
  for (let k = 0; k < aiCount; k++) {
    const id = players.length;
    const personality = PERSONALITIES[randInt(rng, PERSONALITIES.length)];
    const name = names[k % names.length] + (k >= names.length ? ` ${Math.floor(k / names.length) + 1}` : '');
    players.push(makePlayer(id, name, colors[k % colors.length], false, personality));
  }
  // Tribes come last (ids after the nations); they spawn in the leftover space when the spawn phase ends.
  const tribes = tribeCountFor(settings);
  const tribeNames = shuffle(rng, TRIBE_NAMES.slice());
  for (let k = 0; k < tribes; k++) {
    const id = players.length;
    const base = tribeNames[k % tribeNames.length];
    const name = `Tribe of ${base}` + (k >= tribeNames.length ? ` ${Math.floor(k / tribeNames.length) + 1}` : '');
    players.push(makePlayer(id, name, TRIBE_COLORS[k % TRIBE_COLORS.length], false, 'tribe'));
  }
  return makeGameState(settings, map, players, rngPair);
}

/** Valid spawn: land, unowned, no fallout, at least spawnMinDistance tiles from other spawned capitals. */
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
  const minD = spawnMinDistance(state);
  const minD2 = minD * minD;
  for (const p of state.players) {
    if (p.id === 0 || p.id === playerId || !p.spawned || p.capital < 0) continue;
    const dx = (p.capital % w) - x;
    const dy = ((p.capital / w) | 0) - y;
    if (dx * dx + dy * dy < minD2) return false;
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
  const tribe = isTribe(p);
  if (p.spawned) {
    // Re-spawn during the spawn phase: drop the old start (its tiles are all near the old capital, so only that box
    // is scanned). p.spawned is cleared first, so losing the last tile doesn't eliminate them.
    p.spawned = false;
    const oldCapital = p.capital;
    p.capital = -1; // no capital-loss logic for the old start
    const r = (tribe ? TRIBE_SPAWN_RADIUS : spawnRadius(state)) + 1;
    const w0 = map.width;
    const ox = oldCapital % w0;
    const oy = (oldCapital / w0) | 0;
    for (let y = Math.max(0, oy - r); y <= Math.min(map.height - 1, oy + r); y++) {
      for (let x = Math.max(0, ox - r); x <= Math.min(w0 - 1, ox + r); x++) {
        if (map.owner[y * w0 + x] === playerId) setOwner(state, y * w0 + x, 0);
      }
    }
    // Anything else (should not happen): a full scan.
    if (p.tiles > 0) for (let i = 0; i < n; i++) if (map.owner[i] === playerId) setOwner(state, i, 0);
    p.tiles = 0;
    p.alive = true;
    p.eliminatedTick = -1;
  } else {
    const f = tribe ? TRIBE_START_FACTOR : 1;
    p.troops = { infantry: START_TROOPS * f, armor: 0, artillery: 0 };
  }
  // Flood fill over free land so the start does not jump across water.
  const w = map.width;
  const cx = tile % w;
  const cy = (tile / w) | 0;
  const radius = tribe ? TRIBE_SPAWN_RADIUS : spawnRadius(state);
  const r2 = radius * radius;
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

/**
 * Spawns every player who has not spawned yet at a random valid spot (end of spawn phase): nations first, then
 * tribes in the leftover space (the valid spot farthest from every capital, among some samples). A tribe that
 * finds no room is dropped (alive = false, never spawned).
 */
export function autoSpawnRemaining(state: GameState): void {
  for (const p of state.players) {
    if (p.id === 0 || !p.alive || p.spawned || isTribe(p)) continue;
    autoSpawnNation(state, p);
  }
  for (const p of state.players) {
    if (p.id === 0 || !p.alive || p.spawned || !isTribe(p)) continue;
    autoSpawnTribe(state, p);
  }
}

function autoSpawnTribe(state: GameState, p: Player): void {
  const map = state.map;
  const n = map.width * map.height;
  const w = map.width;
  const rng = state.rng;
  let best = -1;
  let bestScore = -1;
  let valid = 0;
  for (let tries = 0; tries < 2000 && valid < 40; tries++) {
    const t = randInt(rng, n);
    if (!canSpawnAt(state, p.id, t)) continue;
    valid++;
    let dmin = 1e9;
    const x = t % w;
    const y = (t / w) | 0;
    for (const q of state.players) {
      if (q.id === 0 || q.id === p.id || !q.spawned || q.capital < 0 || !q.alive) continue;
      const dx = (q.capital % w) - x;
      const dy = ((q.capital / w) | 0) - y;
      dmin = Math.min(dmin, dx * dx + dy * dy);
    }
    // Leftover space: far from everyone, on land that is not all mountains / water.
    const s = Math.sqrt(dmin) * (0.5 + startScore(map, t, 3) / 29);
    if (s > bestScore) {
      bestScore = s;
      best = t;
    }
  }
  if (best >= 0) placeStart(state, p.id, best);
  else {
    p.alive = false;
    p.eliminatedTick = state.tick;
  }
}

function autoSpawnNation(state: GameState, p: Player): void {
  const map = state.map;
  const n = map.width * map.height;
  const rng = state.rng;
  {
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

// Per-player bounding boxes of everything they ever owned in this game (only grow): attack fronts scan inside
// them instead of the whole map. [x0, y0, x1, y1] per player id.
const boxes = new WeakMap<GameState, Int32Array>();
function boxesOf(state: GameState): Int32Array {
  let b = boxes.get(state);
  if (!b || b.length !== state.players.length * 4) {
    const old = b;
    b = new Int32Array(state.players.length * 4);
    for (let k = 0; k < state.players.length; k++) {
      b[k * 4] = 1 << 30;
      b[k * 4 + 1] = 1 << 30;
      b[k * 4 + 2] = -1;
      b[k * 4 + 3] = -1;
    }
    if (old) b.set(old.subarray(0, Math.min(old.length, b.length)));
    // First use on this state (or after a copy): take the current map into account once.
    if (!old) {
      const { owner, width: w } = state.map;
      for (let i = 0; i < owner.length; i++) if (owner[i] !== 0 && owner[i] < state.players.length) growBox(b, owner[i], i % w, (i / w) | 0);
    }
    boxes.set(state, b);
  }
  return b;
}
function growBox(b: Int32Array, id: number, x: number, y: number): void {
  const k = id * 4;
  if (x < b[k]) b[k] = x;
  if (y < b[k + 1]) b[k + 1] = y;
  if (x > b[k + 2]) b[k + 2] = x;
  if (y > b[k + 3]) b[k + 3] = y;
}
/**
 * Bounding box [x0, y0, x1, y1] (inclusive) that contains every tile playerId owns (it may be larger: it only
 * grows), or null if they never owned land.
 */
export function ownerBox(state: GameState, playerId: number): [number, number, number, number] | null {
  if (playerId <= 0 || playerId >= state.players.length) return null;
  const b = boxesOf(state);
  const k = playerId * 4;
  if (b[k + 2] < 0) return null;
  return [b[k], b[k + 1], b[k + 2], b[k + 3]];
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
  if (newOwner !== 0 && newOwner < state.players.length) {
    const b = boxes.get(state);
    if (b && b.length === state.players.length * 4) growBox(b, newOwner, tile % map.width, (tile / map.width) | 0);
  }
  map.owner[tile] = newOwner;
  onOwnerChange(state, tile, old, newOwner);
  recordTileChange(state, tile);
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
      onBuildingCaptured(state, b, prevOwner);
      addEvent(state, 'buildingCaptured', `${players[newOwner].name} captured a ${BUILDINGS[b.type].name} of ${players[prevOwner]?.name ?? 'nobody'}`, [newOwner, prevOwner], tile);
    } else {
      destroyBuilding(state, b);
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
  if (best < 0) {
    // The nearest own border tile (the border set is small next to the map), else a ring search.
    const { list, len } = borderTiles(state, playerId);
    const w = map.width;
    const lx = lostTile % w;
    const ly = (lostTile / w) | 0;
    let bestD = Infinity;
    for (let k = 0; k < len; k++) {
      const t = list[k];
      const dx = (t % w) - lx;
      const dy = ((t / w) | 0) - ly;
      const d = dx * dx + dy * dy;
      if (d < bestD || (d === bestD && t < best)) {
        bestD = d;
        best = t;
      }
    }
    if (best < 0) best = nearestTile(map, lostTile, Math.max(map.width, map.height) * 1.5, (i) => map.owner[i] === playerId);
  }
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
 * Removes a player from the game; the conqueror (if any) takes their gold (half of a human's). Attacks and units can be mid-iteration in combat/units when this runs (it is
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
  let removed = false;
  for (const b of state.buildings.values()) {
    if (b.owner !== playerId) continue;
    state.buildings.delete(b.id);
    if (state.map.building[b.tile] === b.id + 1) state.map.building[b.tile] = 0;
    removed = true;
  }
  if (removed) markBuildingsChanged(state);
  state.alliances = state.alliances.filter((al) => al.a !== playerId && al.b !== playerId);
  state.allianceRequests = state.allianceRequests.filter((r) => r.from !== playerId && r.to !== playerId);
  p.troops = { infantry: 0, armor: 0, artillery: 0 };
  // The conqueror takes the treasury (half of a human's).
  if (by > 0 && state.players[by]?.alive) {
    const loot = p.gold * (p.isHuman ? 0.5 : 1);
    state.players[by].gold += loot;
    p.gold -= loot;
  }
  const byText = by !== 0 ? ` by ${state.players[by].name}` : '';
  // Tribes falling is routine: only the nations involved hear about it.
  const who = isTribe(p) ? [playerId, by].filter((x) => x > 0) : [];
  addEvent(state, 'eliminated', `${p.name} has been eliminated${byText}`, who, -1);
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

/** Seconds of game time since the spawn phase ended (0 during the spawn phase). The clock the player sees. */
export function gameSeconds(state: GameState): number {
  if (state.phase === 'spawn') return 0;
  return Math.max(0, state.tick - state.playStartTick) / TICKS_PER_SECOND;
}

/** Game time (seconds since the spawn phase ended) at a given tick, e.g. an event's. */
export function gameSecondsAt(state: GameState, tick: number): number {
  if (state.phase === 'spawn') return 0;
  return Math.max(0, tick - state.playStartTick) / TICKS_PER_SECOND;
}

export function addEvent(state: GameState, kind: GameEventKind, message: string, players: number[], tile = -1): void {
  state.events.push({ tick: state.tick, kind, message, players, tile });
  if (state.events.length > MAX_EVENTS) state.events.splice(0, state.events.length - MAX_EVENTS);
}
export function newId(state: GameState): number {
  return state.nextId++;
}
