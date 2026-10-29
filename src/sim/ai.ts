// AI nations (DESIGN section 10). They act only through applyAction (same rules as the human); everything else here
// only reads the GameState.
//
// Cost model: a shared, incremental map scan (a few rows per tick, one full pass every SCAN_TICKS ticks) keeps per
// player samples of owned tiles, border tiles per neighbour, coastal tiles and resource deposits, plus border
// lengths between every pair of players. Each AI decision (every AI_DECISION_SECONDS, staggered by id) works from
// those samples and a handful of estimateAttack / canBuild calls, never from a full-map scan.
//
// The caches live in a WeakMap keyed by the GameState (not in the state): they are derived data, rebuilt on demand,
// and sampling uses deterministic hashing, so the simulation stays deterministic.
import { applyAction } from './actions';
import { buildingAt, buildingCost, buildingsOf, buildCostAt, canBuild, countBuildings, isFortified } from './buildings';
import { estimateAttack } from './combat';
import {
  AI_DECISION_SECONDS,
  ARMOR_OIL_UPKEEP,
  ATOM_RADIUS,
  BUILDINGS,
  CITY_MAX_LEVEL,
  FORT_RADIUS_TECH,
  MATCHUP,
  MIN_ATTACK_TROOPS,
  NEUTRAL_TILE_DEF,
  OIL_PER_WELL,
  SPAWN_SECONDS,
  SUPPLY_RANGE,
  TECHS,
  TERRAIN,
  TICKS_PER_SECOND,
  TROOP_ATTACK,
  UNITS,
} from './config';
import { areAllied, isTraitor } from './diplomacy';
import { population } from './economy';
import { forEachInRadius } from './grid';
import { canSpawnAt } from './state';
import { hasTech } from './tech';
import { TROOP_TYPES, Resource, isWater } from './types';
import type { Attack, BuildingType, Difficulty, GameState, Personality, Player, TechId, TerrainId, TroopType, Troops } from './types';

// ---------------------------------------------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------------------------------------------

/** One full pass of the shared map scan takes this many ticks. */
const SCAN_TICKS = 15;
/** Sample caps of the scan (per player or per pair of players). */
const CAP_OWNED = 160;
const CAP_PAIR = 24;
const CAP_COAST = 48;
const CAP_RES = 24;
/** Coarse spawn-quality grid block size (tiles). */
const QBLOCK = 8;
/** An AI founds one city per this many owned tiles (and upgrades them once it has them all). */
const CITY_TILES = 300;
/** At most one atom bomb per AI per this many seconds. */
const NUKE_PAUSE_SECONDS = 150;
/** Seconds of capturing an expansion front is given troops for. */
const EXPAND_HORIZON = 15;

interface Profile {
  /** willingness to start wars, 0..1 */
  aggression: number;
  /** share of home troops sent per neutral expansion wave */
  expandShare: number;
  /** share of the army sent into a war */
  warShare: number;
  /** our army / their army needed before attacking a neighbour (lower = bolder) */
  strengthNeeded: number;
  maxWars: number;
  /** army ratio in peace while neutral land is left */
  baseRatio: number;
  mix: { armor: number; artillery: number };
  techs: TechId[];
  /** priority multipliers for buildings */
  build: Partial<Record<BuildingType, number>>;
  /** opinion needed to accept an alliance */
  allyOpinion: number;
  /** 0..1, appetite for ports, warships and landings */
  naval: number;
}

const PROFILES: Record<Personality, Profile> = {
  warlord: {
    aggression: 0.9,
    expandShare: 0.4,
    warShare: 0.6,
    strengthNeeded: 0.9,
    maxWars: 3,
    baseRatio: 0.45,
    mix: { armor: 0.35, artillery: 0.1 },
    techs: ['metallurgy', 'mechanization', 'logistics', 'industrialization', 'agriculture', 'ballistics', 'combinedArms', 'medicine', 'flight', 'rocketry', 'banking', 'fortification', 'radar', 'navigation', 'nuclearFission'],
    build: { barracks: 1.6, factory: 1.5, mine: 1.3, oilWell: 1.3, fort: 0.6, market: 0.8, port: 0.6, hospital: 1.3, supplyDepot: 1.3 },
    allyOpinion: 35,
    naval: 0.2,
  },
  turtle: {
    aggression: 0.3,
    expandShare: 0.3,
    warShare: 0.4,
    strengthNeeded: 1.5,
    maxWars: 1,
    baseRatio: 0.42,
    mix: { armor: 0.1, artillery: 0.3 },
    techs: ['fortification', 'metallurgy', 'ballistics', 'agriculture', 'rocketry', 'logistics', 'flight', 'radar', 'medicine', 'mechanization', 'banking', 'industrialization', 'combinedArms', 'nuclearFission', 'navigation'],
    build: { fort: 2.0, arsenal: 1.5, watchtower: 1.6, farm: 1.2, sam: 1.5, factory: 0.6, port: 0.6 },
    allyOpinion: 15,
    naval: 0.2,
  },
  merchant: {
    aggression: 0.35,
    expandShare: 0.35,
    warShare: 0.4,
    strengthNeeded: 1.6,
    maxWars: 1,
    baseRatio: 0.36,
    mix: { armor: 0.15, artillery: 0.15 },
    techs: ['agriculture', 'banking', 'navigation', 'medicine', 'metallurgy', 'logistics', 'fortification', 'mechanization', 'flight', 'ballistics', 'industrialization', 'radar', 'rocketry', 'combinedArms', 'nuclearFission'],
    build: { city: 1.3, market: 1.6, port: 1.6, farm: 1.2, lab: 1.2, barracks: 0.6, factory: 0.7, fort: 0.9 },
    allyOpinion: 5,
    naval: 0.6,
  },
  admiral: {
    aggression: 0.55,
    expandShare: 0.35,
    warShare: 0.5,
    strengthNeeded: 1.1,
    maxWars: 2,
    baseRatio: 0.42,
    mix: { armor: 0.2, artillery: 0.15 },
    techs: ['navigation', 'metallurgy', 'logistics', 'flight', 'agriculture', 'mechanization', 'ballistics', 'banking', 'radar', 'industrialization', 'rocketry', 'medicine', 'fortification', 'combinedArms', 'nuclearFission'],
    build: { port: 2.2, market: 1.1, fort: 0.8 },
    allyOpinion: 20,
    naval: 1.0,
  },
  balanced: {
    aggression: 0.6,
    expandShare: 0.35,
    warShare: 0.5,
    strengthNeeded: 1.1,
    maxWars: 2,
    baseRatio: 0.4,
    mix: { armor: 0.25, artillery: 0.2 },
    techs: ['agriculture', 'metallurgy', 'logistics', 'mechanization', 'banking', 'ballistics', 'fortification', 'medicine', 'flight', 'industrialization', 'combinedArms', 'rocketry', 'radar', 'navigation', 'nuclearFission'],
    build: {},
    allyOpinion: 20,
    naval: 0.4,
  },
};

interface DifficultyProfile {
  /** relative error of the enemy army estimate and of target scoring */
  noise: number;
  /** scales every troop share the AI sends */
  shareScale: number;
  /** front tiles evaluated per neighbour */
  samples: number;
  /** reads matchups / terrain / forts for army mix and force composition; avoids SAM cover */
  careful: boolean;
  /** may use atom bombs */
  nukes: boolean;
  /** joins attacks on targets its allies fight */
  coordinate: boolean;
  /** valid spawn candidates compared */
  spawnTries: number;
}
const DIFFICULTY: Record<Difficulty, DifficultyProfile> = {
  easy: { noise: 0.35, shareScale: 0.7, samples: 3, careful: false, nukes: false, coordinate: false, spawnTries: 20 },
  normal: { noise: 0.15, shareScale: 1, samples: 6, careful: true, nukes: true, coordinate: false, spawnTries: 60 },
  hard: { noise: 0.04, shareScale: 1.1, samples: 10, careful: true, nukes: true, coordinate: true, spawnTries: 120 },
};

// ---------------------------------------------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------------------------------------------

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));
function total(t: Troops): number {
  return t.infantry + t.armor + t.artillery;
}
/** Deterministic 32-bit integer hash (consumes no RNG state). */
function hash32(a: number): number {
  a = Math.imul(a ^ (a >>> 16), 0x7feb352d);
  a = Math.imul(a ^ (a >>> 15), 0x846ca68b);
  return (a ^ (a >>> 16)) >>> 0;
}
function hashUnit(a: number): number {
  return hash32(a) / 4294967296;
}
/** Deterministic noise in [-1, 1] for (a, b, c). */
function hashSigned(a: number, b: number, c: number): number {
  return hashUnit(Math.imul(a, 73856093) ^ Math.imul(b, 19349663) ^ Math.imul(c, 83492791)) * 2 - 1;
}
function dist2(w: number, a: number, b: number): number {
  const dx = (a % w) - (b % w);
  const dy = ((a / w) | 0) - ((b / w) | 0);
  return dx * dx + dy * dy;
}
function pick<T>(state: GameState, arr: readonly T[]): T {
  return arr[Math.floor(state.rng() * arr.length)];
}
/** Up to k distinct random elements (partial Fisher-Yates on a copy). */
function sample<T>(state: GameState, arr: readonly T[], k: number): T[] {
  if (arr.length <= k) return arr.slice();
  const a = arr.slice();
  for (let i = 0; i < k; i++) {
    const j = i + Math.floor(state.rng() * (a.length - i));
    const t = a[i];
    a[i] = a[j];
    a[j] = t;
  }
  a.length = k;
  return a;
}
function isAI(p: Player): boolean {
  return p.id !== 0 && !p.isHuman;
}
/** Random factor 1 +- noise. */
function jitter(state: GameState, noise: number): number {
  return 1 + (state.rng() * 2 - 1) * noise;
}

// ---------------------------------------------------------------------------------------------------------------
// Shared map scan
// ---------------------------------------------------------------------------------------------------------------

interface Scan {
  /** players.length */
  n: number;
  /** owned land tiles per player */
  tiles: Int32Array;
  /** border[p * n + q]: tile edges where a tile of p touches a tile of q (q = 0: neutral land) */
  border: Int32Array;
  /** front[p * n + q]: sample of q's tiles (or neutral land) touching p */
  front: number[][];
  /** edge[p * n + q]: sample of p's tiles touching q (same events as front) */
  edge: number[][];
  owned: number[][];
  /** coastal land tiles per owner (index 0 = neutral land) */
  coast: number[][];
  coastCount: Int32Array;
  iron: number[][];
  oil: number[][];
  /** deposits owned: [owner * 2 + (0 iron | 1 oil)] */
  resCount: Int32Array;
}

function emptyScan(n: number): Scan {
  const lists = (k: number): number[][] => Array.from({ length: k }, () => []);
  return {
    n,
    tiles: new Int32Array(n),
    border: new Int32Array(n * n),
    front: lists(n * n),
    edge: lists(n * n),
    owned: lists(n),
    coast: lists(n),
    coastCount: new Int32Array(n),
    iron: lists(n),
    oil: lists(n),
    resCount: new Int32Array(n * 2),
  };
}

interface ScanBuilder {
  scan: Scan;
  row: number;
  salt: number;
  /** sampling probabilities from the previous pass's counts (so samples stay near their caps) */
  pOwned: Float64Array;
  pPair: Float64Array;
  pCoast: Float64Array;
  pRes: Float64Array;
}

function startBuilder(prev: Scan | null, n: number, pass: number): ScanBuilder {
  const prob = (count: number, cap: number): number => (count <= cap ? 1 : cap / count);
  const pOwned = new Float64Array(n).fill(1);
  const pPair = new Float64Array(n * n).fill(1);
  const pCoast = new Float64Array(n).fill(1);
  const pRes = new Float64Array(n * 2).fill(1);
  if (prev && prev.n === n) {
    for (let i = 0; i < n; i++) {
      pOwned[i] = prob(prev.tiles[i], CAP_OWNED);
      pCoast[i] = prob(prev.coastCount[i], CAP_COAST);
      pRes[i * 2] = prob(prev.resCount[i * 2], CAP_RES);
      pRes[i * 2 + 1] = prob(prev.resCount[i * 2 + 1], CAP_RES);
    }
    for (let k = 0; k < n * n; k++) pPair[k] = prob(prev.border[k], CAP_PAIR);
  }
  return { scan: emptyScan(n), row: 0, salt: Math.imul(pass + 1, 0x9e3779b9), pOwned, pPair, pCoast, pRes };
}

/** Cheap per-tile hash in [0, 1) for sampling (Weyl sequence: evenly spread, different every pass). */
function tileHash(i: number, salt: number): number {
  return (Math.imul(i + salt, 0x9e3779b1) >>> 0) / 4294967296;
}

/** Scans `rows` more map rows into the builder. */
function scanRows(state: GameState, b: ScanBuilder, rows: number): void {
  const { width: w, height: h, owner, terrain, coastal, resource } = state.map;
  const s = b.scan;
  const n = s.n;
  const salt = b.salt;
  const { pOwned, pCoast, pRes, pPair } = b;
  const y1 = Math.min(h, b.row + rows);
  // One border event: a tile ia of player a touching tile jq of q (q = 0: neutral land).
  const record = (a: number, q: number, ia: number, jq: number): void => {
    if (a === 0 || a >= n || q >= n) return;
    const k = a * n + q;
    s.border[k]++;
    const pr = pPair[k];
    if ((pr >= 1 || tileHash(ia * 4 + (jq - ia + w + 1), salt) < pr) && s.edge[k].length < CAP_PAIR * 2) {
      s.edge[k].push(ia);
      s.front[k].push(jq);
    }
  };
  for (let y = b.row; y < y1; y++) {
    const rowStart = y * w;
    const lastRow = y === h - 1;
    for (let x = 0; x < w; x++) {
      const i = rowStart + x;
      if (terrain[i] <= 1) continue; // water
      const o = owner[i];
      if (o >= n) continue;
      if (o > 0) {
        s.tiles[o]++;
        if ((pOwned[o] >= 1 || tileHash(i, salt) < pOwned[o]) && s.owned[o].length < CAP_OWNED * 2) s.owned[o].push(i);
        const r = resource[i];
        if (r === Resource.Iron || r === Resource.Oil) {
          const slot = o * 2 + (r === Resource.Iron ? 0 : 1);
          s.resCount[slot]++;
          const list = r === Resource.Iron ? s.iron[o] : s.oil[o];
          if ((pRes[slot] >= 1 || tileHash(i, salt) < pRes[slot]) && list.length < CAP_RES * 2) list.push(i);
        }
      }
      if (coastal[i]) {
        s.coastCount[o]++;
        if ((pCoast[o] >= 1 || tileHash(i, salt) < pCoast[o]) && s.coast[o].length < CAP_COAST * 2) s.coast[o].push(i);
      }
      // Each land-land edge once (right and down neighbours), recorded for both sides.
      if (x < w - 1) {
        const j = i + 1;
        const o2 = owner[j];
        if (o2 !== o && terrain[j] > 1) {
          record(o, o2, i, j);
          record(o2, o, j, i);
        }
      }
      if (!lastRow) {
        const j = i + w;
        const o2 = owner[j];
        if (o2 !== o && terrain[j] > 1) {
          record(o, o2, i, j);
          record(o2, o, j, i);
        }
      }
    }
  }
  b.row = y1;
}

// ---------------------------------------------------------------------------------------------------------------
// Memory
// ---------------------------------------------------------------------------------------------------------------

interface AttackRecord {
  checkTroops: number;
  checkTiles: number;
  checkTick: number;
}

interface AIState {
  decisions: number;
  nextWarTick: number;
  nextNavalTick: number;
  nextDiploTick: number;
  nextAirTick: number;
  peakTiles: number;
  /** last tick we were expanding or at war (for impatience when boxed in) */
  busyTick: number;
  /** no atom bomb before this tick */
  nextNukeTick: number;
  /** attack id -> progress record (for retreat decisions) */
  attacks: Map<number, AttackRecord>;
  /** landing tiles that had no sea route -> tick from which they may be tried again */
  badLandings: Map<number, number>;
  /** player id -> tick of our last new alliance proposal to them (no nagging) */
  proposedTick: Map<number, number>;
}

interface Memory {
  spawnAt: Map<number, number>;
  quality: Float32Array | null;
  qw: number;
  qh: number;
  scan: Scan | null;
  builder: ScanBuilder | null;
  pass: number;
  ais: Map<number, AIState>;
  /** per tick cache: total army (home + attacks + transports) per player */
  armyTick: number;
  army: Float64Array;
}

const memories = new WeakMap<GameState, Memory>();

function memory(state: GameState): Memory {
  let m = memories.get(state);
  if (!m) {
    m = {
      spawnAt: new Map(),
      quality: null,
      qw: 0,
      qh: 0,
      scan: null,
      builder: null,
      pass: 0,
      ais: new Map(),
      armyTick: -1,
      army: new Float64Array(state.players.length),
    };
    memories.set(state, m);
  }
  return m;
}

function aiState(m: Memory, id: number): AIState {
  let s = m.ais.get(id);
  if (!s) {
    s = { decisions: 0, nextWarTick: 0, nextNavalTick: 0, nextDiploTick: 0, nextAirTick: 0, peakTiles: 0, busyTick: 0, nextNukeTick: 0, attacks: new Map(), badLandings: new Map(), proposedTick: new Map() };
    m.ais.set(id, s);
  }
  return s;
}

/** Advances the shared scan by one tick's worth of rows; the first call does full passes at once. */
function advanceScan(state: GameState, m: Memory): Scan {
  const n = state.players.length;
  const h = state.map.height;
  if (!m.scan || m.scan.n !== n) {
    // First pass at once, sampling owned tiles by the players' known tile counts.
    const b = startBuilder(null, n, m.pass++);
    for (const p of state.players) if (p.id > 0 && p.id < n && p.tiles > CAP_OWNED) b.pOwned[p.id] = CAP_OWNED / p.tiles;
    scanRows(state, b, h);
    m.scan = b.scan;
    m.builder = null;
  }
  if (!m.builder) m.builder = startBuilder(m.scan, n, m.pass++);
  scanRows(state, m.builder, Math.ceil(h / SCAN_TICKS));
  if (m.builder.row >= h) {
    m.scan = m.builder.scan;
    m.builder = null;
  }
  return m.scan;
}

/** Army per player incl. troops in attacks and on transports (cached per tick). */
function refreshArmies(state: GameState, m: Memory): void {
  if (m.armyTick === state.tick) return;
  m.armyTick = state.tick;
  const n = state.players.length;
  if (m.army.length !== n) m.army = new Float64Array(n);
  const army = m.army;
  army.fill(0);
  for (const a of state.attacks) if (a.attacker < n) army[a.attacker] += total(a.troops);
  for (const u of state.units) if (u.type === 'transport' && u.owner < n) army[u.owner] += total(u.troops);
  for (const p of state.players) army[p.id] = p.alive ? army[p.id] + total(p.troops) : 0;
}

// ---------------------------------------------------------------------------------------------------------------
// Spawning
// ---------------------------------------------------------------------------------------------------------------

/** Coarse land quality per QBLOCK x QBLOCK block (static terrain and resources), computed once per game. */
function qualityGrid(state: GameState, m: Memory): Float32Array {
  if (m.quality) return m.quality;
  const map = state.map;
  const qw = Math.ceil(map.width / QBLOCK);
  const qh = Math.ceil(map.height / QBLOCK);
  const q = new Float32Array(qw * qh);
  for (let y = 0; y < map.height; y++) {
    for (let x = 0; x < map.width; x++) {
      const i = y * map.width + x;
      const t = map.terrain[i] as TerrainId;
      if (isWater(t)) continue;
      let v = TERRAIN[t].popPerTile / 30;
      const r = map.resource[i];
      if (r === Resource.Iron) v += 3;
      else if (r === Resource.Oil) v += 2.5;
      else if (r === Resource.Fertile) v += 1.5;
      q[((y / QBLOCK) | 0) * qw + ((x / QBLOCK) | 0)] += v;
    }
  }
  m.quality = q;
  m.qw = qw;
  m.qh = qh;
  return q;
}

/** Spawn score: land quality around the tile (blocks weighted by ring), coast for sea powers, distance from others. */
function spawnScore(state: GameState, m: Memory, p: Player, tile: number, spacing: number): number {
  const map = state.map;
  const w = map.width;
  const q = qualityGrid(state, m);
  const bx = ((tile % w) / QBLOCK) | 0;
  const by = ((tile / w) / QBLOCK) | 0;
  let land = 0;
  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      const x = bx + dx;
      const y = by + dy;
      if (x < 0 || y < 0 || x >= m.qw || y >= m.qh) continue;
      const ring = Math.max(Math.abs(dx), Math.abs(dy));
      land += q[y * m.qw + x] * (ring === 0 ? 1 : ring === 1 ? 0.75 : 0.4);
    }
  }
  const t = map.terrain[tile] as TerrainId;
  land *= 0.7 + 0.3 * (TERRAIN[t].popPerTile / 30);
  const prof = PROFILES[p.personality ?? 'balanced'];
  if (prof.naval > 0.5 && map.coastal[tile]) land *= 1.15;
  let dmin = Infinity;
  for (const o of state.players) {
    if (o.id === 0 || o.id === p.id || !o.spawned || o.capital < 0) continue;
    dmin = Math.min(dmin, Math.sqrt(dist2(w, tile, o.capital)));
  }
  const far = dmin === Infinity ? 1 : clamp(dmin / spacing, 0.15, 1.1);
  return land * (0.35 + 0.65 * far);
}

/** During the spawn phase: pick a good spawn for every AI that hasn't spawned (each at its own random moment). */
export function aiSpawn(state: GameState): void {
  if (state.phase !== 'spawn') return;
  const m = memory(state);
  const elapsed = SPAWN_SECONDS - state.spawnLeft;
  const diff = DIFFICULTY[state.settings.difficulty] ?? DIFFICULTY.normal;
  const map = state.map;
  const n = map.width * map.height;
  const nations = state.players.length - 1;
  // Expected distance between capitals if land were shared evenly.
  const spacing = Math.sqrt(map.landTileCount / Math.max(1, nations)) * 0.9;
  for (const p of state.players) {
    if (!isAI(p) || !p.alive || p.spawned) continue;
    let at = m.spawnAt.get(p.id);
    if (at === undefined) {
      at = SPAWN_SECONDS * (0.08 + 0.6 * state.rng());
      m.spawnAt.set(p.id, at);
    }
    if (elapsed < at) continue;
    let best = -1;
    let bestScore = -1;
    let valid = 0;
    for (let k = 0; k < diff.spawnTries * 8 && valid < diff.spawnTries; k++) {
      const t = Math.floor(state.rng() * n);
      if (isWater(map.terrain[t]) || !canSpawnAt(state, p.id, t)) continue;
      valid++;
      const s = spawnScore(state, m, p, t, spacing);
      if (s > bestScore) {
        bestScore = s;
        best = t;
      }
    }
    // Nothing found: try again next tick (autoSpawnRemaining is the last resort at the end of the phase).
    if (best >= 0) applyAction(state, p.id, { type: 'spawn', tile: best });
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Decisions
// ---------------------------------------------------------------------------------------------------------------

interface Ctx {
  state: GameState;
  m: Memory;
  scan: Scan;
  p: Player;
  id: number;
  ai: AIState;
  prof: Profile;
  diff: DifficultyProfile;
  n: number;
  /** alive, non-allied players we border */
  enemies: number[];
  /** alive players we border (allied or not) */
  neighbours: number[];
  allies: number[];
  /** border length with neutral land */
  neutralBorder: number;
  /** our army incl. deployed troops */
  army: number;
  /** troops at home (kept up to date after our own launches) */
  home: number;
  /** attackers hitting us: id -> troops */
  incoming: Map<number, number>;
  incomingTotal: number;
  myAttacks: Attack[];
  /** biggest danger (their army / ours, weighted by hostility) among non-allied neighbours */
  threat: number;
  /** most threatening neighbour (0 = none) */
  threatId: number;
  /** some of our tiles bordering other nations */
  foreignEdges: number[];
  /** share of all land per player id */
  landShare: number[];
}

/** Called every tick; each AI decides on its own interval (AI_DECISION_SECONDS, staggered by id). */
export function updateAI(state: GameState): void {
  if (state.phase !== 'playing') return;
  if (!state.players.some((p) => isAI(p) && p.alive && p.spawned)) return;
  const m = memory(state);
  const scan = advanceScan(state, m);
  const interval = Math.max(1, Math.round((AI_DECISION_SECONDS[state.settings.difficulty] ?? 1.5) * TICKS_PER_SECOND));
  for (const p of state.players) {
    if (!isAI(p) || !p.alive || !p.spawned) continue;
    if ((state.tick + p.id * 7) % interval !== 0) continue;
    refreshArmies(state, m);
    decide(makeCtx(state, m, scan, p));
  }
}

function makeCtx(state: GameState, m: Memory, scan: Scan, p: Player): Ctx {
  const n = scan.n;
  const id = p.id;
  const diff = DIFFICULTY[state.settings.difficulty] ?? DIFFICULTY.normal;
  const enemies: number[] = [];
  const neighbours: number[] = [];
  const allies: number[] = [];
  for (const q of state.players) {
    if (q.id === 0 || q.id === id || !q.alive) continue;
    const allied = areAllied(state, id, q.id);
    if (allied) allies.push(q.id);
    if (scan.border[id * n + q.id] <= 0) continue;
    neighbours.push(q.id);
    if (!allied) enemies.push(q.id);
  }
  const incoming = new Map<number, number>();
  let incomingTotal = 0;
  const myAttacks: Attack[] = [];
  for (const a of state.attacks) {
    if (a.attacker === id) myAttacks.push(a);
    else if (a.target === id) {
      const t = total(a.troops);
      incoming.set(a.attacker, (incoming.get(a.attacker) ?? 0) + t);
      incomingTotal += t;
    }
  }
  const army = Math.max(1, m.army[id]);
  let threat = 0;
  let threatId = 0;
  for (const q of enemies) {
    const theirs = estArmy(state, m, diff, id, q);
    let hostility = 0.6 - state.opinion[id][q] / 200; // 0.1 .. 1.1
    if (incoming.has(q)) hostility += 0.6;
    if (isTraitor(state, q)) hostility += 0.2;
    const t = (theirs / army) * hostility;
    if (t > threat) {
      threat = t;
      threatId = q;
    }
  }
  const foreignEdges: number[] = [];
  for (const q of neighbours) {
    const list = scan.edge[id * n + q];
    for (let k = 0; k < list.length && k < 12; k++) foreignEdges.push(list[k]);
  }
  const land = Math.max(1, state.map.landTileCount);
  return {
    state,
    m,
    scan,
    p,
    id,
    ai: aiState(m, id),
    prof: PROFILES[p.personality ?? 'balanced'],
    diff,
    n,
    enemies,
    neighbours,
    allies,
    neutralBorder: scan.border[id * n],
    army,
    home: total(p.troops),
    incoming,
    incomingTotal,
    myAttacks,
    threat,
    threatId,
    foreignEdges,
    landShare: state.players.map((q) => (q.alive && q.id !== 0 ? q.tiles / land : 0)),
  };
}

/** Noisy estimate of another player's whole army (AI cheat, accuracy by difficulty). Stable for ~20 s. */
function estArmy(state: GameState, m: Memory, diff: DifficultyProfile, me: number, q: number): number {
  return m.army[q] * (1 + hashSigned(me, q, Math.floor(state.tick / 200)) * diff.noise);
}

function decide(ctx: Ctx): void {
  const { state, ai, p } = ctx;
  ai.decisions++;
  ai.peakTiles = Math.max(ai.peakTiles, p.tiles);
  if (ctx.neutralBorder > 0 || ctx.myAttacks.length > 0 || ai.busyTick === 0) ai.busyTick = state.tick;
  answerRequests(ctx);
  manageAttacks(ctx);
  setRatio(ctx);
  defend(ctx);
  expand(ctx);
  war(ctx);
  economy(ctx);
  if (ai.decisions % 4 === p.id % 4) armyMix(ctx);
  if (state.tick >= ai.nextNavalTick) naval(ctx);
  if (state.tick >= ai.nextAirTick) airAndMissiles(ctx);
  if (state.tick >= ai.nextDiploTick) diplomacy(ctx);
}

// ---------------------------------------------------------------------------------------------------------------
// Army ratio and mix
// ---------------------------------------------------------------------------------------------------------------

function setRatio(ctx: Ctx): void {
  const { p, prof } = ctx;
  let r = prof.baseRatio;
  if (ctx.neutralBorder <= 0) r += 0.08; // land grabbing is over: the army is the way to grow
  if (ctx.myAttacks.some((a) => a.target !== 0)) r += 0.07;
  // Threatened: a stronger hostile neighbour, or an attack under way.
  const danger = Math.max(ctx.threat - 0.8, 0) + (ctx.incomingTotal > 0 ? 0.25 + ctx.incomingTotal / Math.max(1, ctx.home) : 0);
  r += clamp(danger * 0.25, 0, 0.3);
  // A very high ratio starves the economy: only when the attack coming in outnumbers what is at home.
  r = clamp(r, 0.25, ctx.incomingTotal > ctx.home ? 0.75 : 0.62);
  if (Math.abs(r - p.armyRatio) > 0.015) applyAction(ctx.state, ctx.id, { type: 'setArmyRatio', value: r });
}

/** Share of each troop type in a force (empty -> all infantry). */
function shares(t: Troops): Troops {
  const tot = total(t);
  if (tot <= 0) return { infantry: 1, armor: 0, artillery: 0 };
  return { infantry: t.infantry / tot, armor: t.armor / tot, artillery: t.artillery / tot };
}

/** Fraction of the sampled tiles that are open ground (plains/desert). */
function openness(state: GameState, tiles: number[]): number {
  if (!tiles.length) return 0.5;
  let open = 0;
  for (const t of tiles) {
    const ter = state.map.terrain[t];
    if (ter === 2 || ter === 6) open++;
  }
  return open / tiles.length;
}

/** Share of the sampled front tiles that enemy forts cover. */
function fortifiedShare(state: GameState, enemy: number, tiles: number[]): number {
  if (!tiles.length || countBuildings(state, enemy, 'fort') === 0) return 0;
  let f = 0;
  const k = Math.min(tiles.length, 8);
  for (let i = 0; i < k; i++) if (isFortified(state, tiles[i], enemy)) f++;
  return f / k;
}

/** Target armor / artillery shares: personality, then (careful AIs) the main foe's mix, the terrain and forts. */
function armyMix(ctx: Ctx): void {
  const { state, p, prof, diff, id, n, scan } = ctx;
  let armor = prof.mix.armor;
  let artillery = prof.mix.artillery;
  const foe = mainWarTarget(ctx) || ctx.threatId;
  if (diff.careful && foe > 0) {
    const theirs = shares(state.players[foe].troops);
    const front = scan.front[id * n + foe];
    // Armor shines on open ground and against artillery (1.6); rough ground favours infantry.
    armor += (openness(state, front) - 0.5) * 0.35 + theirs.artillery * 0.2;
    // Artillery is strong against infantry (1.3) but weak against armor (0.7).
    artillery += (theirs.infantry - 0.6) * 0.15 - Math.max(0, theirs.armor - 0.3) * 0.4;
    // Against an armor-heavy foe our own armor (1.0) beats infantry (0.8) and artillery (0.7).
    if (theirs.armor > 0.35) armor += 0.1;
    // Forts on their side of the front: artillery x2.5.
    artillery += fortifiedShare(state, foe, front) * 0.25;
  }
  // Armor burns oil: no more than the wells (plus a little stock) can feed. No factory / arsenal, no conversion.
  armor = Math.min(armor, armorFedShare(ctx));
  if (countBuildings(state, id, 'factory', true) === 0) armor = Math.min(armor, 0.05);
  if (countBuildings(state, id, 'arsenal', true) === 0) artillery = Math.min(artillery, 0.05);
  armor = clamp(armor, 0, 0.55);
  artillery = clamp(artillery, 0, 0.4);
  if (Math.abs(armor - p.armyMix.armor) > 0.03 || Math.abs(artillery - p.armyMix.artillery) > 0.03) {
    applyAction(state, id, { type: 'setArmyMix', armor, artillery });
  }
}

/** Share of our army that our oil wells (plus ten minutes of the oil stock) can keep supplied as armor. */
function armorFedShare(ctx: Ctx): number {
  const { state, p, id } = ctx;
  const wells = countBuildings(state, id, 'oilWell');
  const oilGross = wells * OIL_PER_WELL * (hasTech(p, 'industrialization') ? 1.25 : 1);
  const fed = (oilGross * 0.85) / ARMOR_OIL_UPKEEP + p.oil / (ARMOR_OIL_UPKEEP * 600);
  return fed / Math.max(1, ctx.army);
}

/** Target of our biggest attack against a nation (0 if none). */
function mainWarTarget(ctx: Ctx): number {
  let best = 0;
  let bestT = 0;
  for (const a of ctx.myAttacks) {
    if (a.target === 0) continue;
    const t = total(a.troops);
    if (t > bestT) {
      bestT = t;
      best = a.target;
    }
  }
  return best;
}

/**
 * Which troops to send: proportional to what is at home by default; careful AIs weight each type by its strength
 * on the target tile (terrain, matchup against the defender's mix, artillery vs forts). Artillery is kept under
 * 40% of the force (unescorted artillery dies fast). Never more of a type than is at home.
 */
function chooseForce(ctx: Ctx, amount: number, tile: number, target: number): Troops {
  const { state, p } = ctx;
  const home = p.troops;
  amount = Math.min(amount, total(home));
  const out: Troops = { infantry: 0, armor: 0, artillery: 0 };
  if (amount <= 0) return out;
  const w: Troops = { infantry: home.infantry, armor: home.armor, artillery: home.artillery };
  if (ctx.diff.careful) {
    const ter = TERRAIN[state.map.terrain[tile] as TerrainId];
    const against = target > 0 ? shares(state.players[target].troops) : null;
    const fort = target > 0 && isFortified(state, tile, target);
    for (const k of TROOP_TYPES) {
      let eff = TROOP_ATTACK[k] * ter.attack[k];
      if (against) eff *= against.infantry * MATCHUP[k].infantry + against.armor * MATCHUP[k].armor + against.artillery * MATCHUP[k].artillery;
      if (k === 'artillery' && fort) eff *= 2.5;
      w[k] *= eff * eff;
    }
  }
  const wt = total(w);
  if (wt <= 0) return out;
  for (const k of TROOP_TYPES) out[k] = Math.min(home[k], (amount * w[k]) / wt);
  out.artillery = Math.min(out.artillery, amount * 0.4);
  // Fill any shortfall with infantry, then armor.
  let missing = amount - total(out);
  for (const k of ['infantry', 'armor'] as TroopType[]) {
    if (missing <= 0) break;
    const add = Math.min(home[k] - out[k], missing);
    out[k] += add;
    missing -= add;
  }
  for (const k of TROOP_TYPES) out[k] = Math.max(0, Math.min(home[k], Math.floor(out[k])));
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Attacks: bookkeeping and retreat, defence, expansion, war
// ---------------------------------------------------------------------------------------------------------------

function launch(ctx: Ctx, tile: number, troops: Troops): boolean {
  if (total(troops) < MIN_ATTACK_TROOPS) return false;
  const r = applyAction(ctx.state, ctx.id, { type: 'attack', tile, troops });
  if (r.ok) {
    ctx.home = total(ctx.p.troops);
    const a = ctx.state.attacks.find((x) => x.attacker === ctx.id && x.target === ctx.state.map.owner[tile]);
    if (a && !ctx.myAttacks.includes(a)) ctx.myAttacks.push(a);
  }
  return r.ok;
}

/** Tracks our attacks on nations and retreats the ones that bleed troops without taking land. */
function manageAttacks(ctx: Ctx): void {
  const { state, ai } = ctx;
  const live = new Set<number>();
  for (const a of ctx.myAttacks) {
    live.add(a.id);
    if (a.target === 0) continue;
    const t = total(a.troops);
    const rec = ai.attacks.get(a.id);
    if (!rec || t > rec.checkTroops) {
      // New or reinforced: (re)start the measurement.
      ai.attacks.set(a.id, { checkTroops: t, checkTiles: a.tilesTaken, checkTick: state.tick });
      continue;
    }
    // Needed at home: a big attack is coming in and we have little to defend with.
    const neededHome = ctx.incomingTotal > ctx.home * 1.5 && !ctx.incoming.has(a.target);
    const secs = (state.tick - rec.checkTick) / TICKS_PER_SECOND;
    let failing = false;
    if (secs >= 6) {
      const lost = rec.checkTroops - t;
      const tiles = a.tilesTaken - rec.checkTiles;
      const lossShare = lost / Math.max(1, rec.checkTroops);
      const est = estimateAttack(state, ctx.id, frontGuess(ctx, a), a.troops);
      failing =
        (lossShare > 0.3 && tiles < 5) || // melting without progress
        (est !== null && est.lossPerTile * 20 > t && est.tilesPerSecond < 1.5) || // spent and crawling
        (tiles > 0 && lost / tiles > 80 && lossShare > 0.2); // far too expensive
      rec.checkTroops = t;
      rec.checkTiles = a.tilesTaken;
      rec.checkTick = state.tick;
    }
    if ((failing || neededHome) && applyAction(state, ctx.id, { type: 'retreat', attackId: a.id }).ok) {
      ai.attacks.delete(a.id);
      ctx.home = total(ctx.p.troops);
    }
  }
  for (const id of [...ai.attacks.keys()]) if (!live.has(id)) ai.attacks.delete(id);
  ctx.myAttacks = ctx.myAttacks.filter((a) => state.attacks.includes(a));
}

/** A tile on the attack's front for estimates: a sampled front tile of the target still owned by it. */
function frontGuess(ctx: Ctx, a: Attack): number {
  const list = ctx.scan.front[ctx.id * ctx.n + a.target];
  for (const t of list) if (ctx.state.map.owner[t] === a.target) return t;
  return a.focusTile;
}

/** Clash power of a force against another force's mix (counter-attacks cancel by this; no terrain). */
function clashPower(t: Troops, against: Troops): number {
  const s = shares(against);
  let sum = 0;
  for (const k of TROOP_TYPES) {
    const m = MATCHUP[k];
    sum += t[k] * TROOP_ATTACK[k] * (s.infantry * m.infantry + s.armor * m.armor + s.artillery * m.artillery);
  }
  return sum;
}

/**
 * Counter-attacks fronts pushing into us when they are worth stopping and we can beat them. Opposing attacks cancel
 * by power first, so we send a bit more than their power and let the small leftover push on. Small raids are left
 * to die on our defence (a counter costs troops too), and a losing clash only wastes troops: then we just hold
 * (higher army ratio, allies: see setRatio and diplomacy).
 */
function defend(ctx: Ctx): void {
  const { state, id, n } = ctx;
  if (ctx.incomingTotal <= 0) return;
  for (const a of state.attacks) {
    if (a.target !== id) continue;
    const t = total(a.troops);
    if (t < Math.max(MIN_ATTACK_TROOPS * 4, ctx.home * 0.08)) continue;
    // How much land would it take? Judge on one of our tiles facing them.
    const facing = ctx.scan.edge[id * n + a.attacker].find((e) => state.map.owner[e] === id);
    if (facing !== undefined) {
      const e = estimateAttack(state, a.attacker, facing, a.troops);
      if (e && t / Math.max(0.01, e.lossPerTile) < Math.max(20, ctx.p.tiles * 0.01)) continue;
    }
    const mine = ctx.myAttacks.find((b) => b.target === a.attacker);
    const theirPower = clashPower(a.troops, ctx.p.troops);
    const homePower = clashPower(ctx.p.troops, a.troops);
    const have = mine ? clashPower(mine.troops, a.troops) : 0;
    const need = theirPower * 1.15 - have;
    if (need <= 0 || homePower * 0.7 < need) continue;
    const unitPower = homePower / Math.max(1, ctx.home);
    const amount = Math.min(ctx.home * 0.7, need / Math.max(0.1, unitPower));
    const tile = pickFrontTile(ctx, a.attacker, Math.min(4, ctx.diff.samples), true);
    if (tile >= 0) launch(ctx, tile, chooseForce(ctx, amount, tile, a.attacker));
  }
}

/** Value of taking a tile: population capacity, resources, buildings. */
function tileValue(state: GameState, t: number): number {
  const ter = TERRAIN[state.map.terrain[t] as TerrainId];
  let v = 0.4 + ter.popPerTile / 30;
  const r = state.map.resource[t];
  if (r === Resource.Iron || r === Resource.Oil) v += 0.8;
  else if (r === Resource.Fertile) v += 0.4;
  if (state.map.building[t] !== 0) v += 1;
  return v;
}

/**
 * The best tile on our front with `target` (0 = neutral): most value per troop lost taking it. Weak spots (thin
 * defence, no fort, good terrain for our troops) score high. `quick` uses terrain defence instead of estimateAttack.
 */
function pickFrontTile(ctx: Ctx, target: number, samples: number, quick = false): number {
  const { state, id, n } = ctx;
  const list = ctx.scan.front[id * n + target];
  if (!list.length) return -1;
  const owner = state.map.owner;
  const probe: Troops = { ...ctx.p.troops };
  if (total(probe) <= 0) probe.infantry = 1;
  let best = -1;
  let bestScore = -Infinity;
  let left = samples;
  for (const t of sample(state, list, samples * 2)) {
    if (owner[t] !== target) continue;
    let cost: number;
    if (quick || target === 0) cost = TERRAIN[state.map.terrain[t] as TerrainId].defense;
    else {
      const e = estimateAttack(state, id, t, probe);
      if (!e) continue;
      cost = e.lossPerTile;
    }
    const s = (tileValue(state, t) / Math.max(0.01, cost)) * jitter(state, ctx.diff.noise);
    if (s > bestScore) {
      bestScore = s;
      best = t;
    }
    if (--left <= 0) break;
  }
  return best;
}

/**
 * Keeps an expansion front into neutral land going while there is any. A front can only take so many tiles per
 * second, so it gets the troops it can spend in about EXPAND_HORIZON seconds; the rest stay home (where they defend
 * and keep the density up).
 */
function expand(ctx: Ctx): void {
  const { state, prof, diff, id } = ctx;
  if (ctx.neutralBorder <= 0) return;
  const existing = ctx.myAttacks.find((a) => a.target === 0);
  const existingTroops = existing ? total(existing.troops) : 0;
  const tile = pickFrontTile(ctx, 0, Math.max(3, diff.samples));
  if (tile < 0) return;
  const est = estimateAttack(state, id, tile, ctx.p.troops);
  if (!est) return;
  const budget = est.lossPerTile * est.tilesPerSecond * EXPAND_HORIZON * diff.shareScale;
  if (existingTroops > budget * 0.5) return; // the current wave still has punch
  // Keep a reserve at home against hostile neighbours.
  const reserve = ctx.army * (ctx.enemies.length ? 0.25 + clamp(ctx.threat - 0.5, 0, 1) * 0.3 : 0.1);
  const amount = Math.min(budget - existingTroops, ctx.home * prof.expandShare * diff.shareScale, ctx.home - reserve);
  if (amount < Math.max(MIN_ATTACK_TROOPS, Math.min(ctx.home * 0.05, budget * 0.2))) return;
  launch(ctx, tile, chooseForce(ctx, amount, tile, 0));
}

interface WarOption {
  target: number;
  tile: number;
  score: number;
  amount: number;
}

/**
 * How much stronger than q (whole army vs whole army) we want to be before attacking: personality, free land left
 * (expanding is cheaper than war), traitors, grudges, being attacked, allies at war with them, runaway leaders.
 */
function warNeed(ctx: Ctx, q: number): number {
  const { state, prof, diff, id } = ctx;
  let need = prof.strengthNeeded;
  if (ctx.neutralBorder > 0) need *= 1.2 + 0.5 * (1 - prof.aggression);
  else {
    // Boxed in and idle: impatience grows (-10% per idle minute, down to 60%), so stalemates break.
    const idleMinutes = (state.tick - ctx.ai.busyTick) / (60 * TICKS_PER_SECOND);
    need *= clamp(1 - idleMinutes * 0.1, 0.6, 1);
  }
  // A full population barely grows: troops spent now regrow fast, so idle troops are cheap.
  if (ctx.p.maxPop > 0 && population(ctx.p) > ctx.p.maxPop * 0.9) need *= 0.75;
  if (isTraitor(state, q)) need *= 0.7;
  need *= 1 + clamp(state.opinion[id][q], -60, 60) / 150;
  if (ctx.incoming.has(q)) need *= 0.75;
  if (diff.coordinate && alliesFighting(ctx, q)) need *= 0.75;
  if (ctx.landShare[q] > 0.35 && ctx.landShare[q] > ctx.landShare[id] * 1.5) need *= 0.8;
  return need;
}

/**
 * Judges sending `force` at q's `tile`: expected tiles (troops / loss per tile) must be worth it and the front must
 * move. Returns a score (higher = better) or -1.
 */
function judgeAttack(ctx: Ctx, q: number, tile: number, force: Troops, strength: number): number {
  const { state, prof, id } = ctx;
  const qp = state.players[q];
  const est = estimateAttack(state, id, tile, force);
  if (!est) return -1;
  const expectedTiles = total(force) / Math.max(0.01, est.lossPerTile);
  if (expectedTiles < Math.max(15, Math.min(qp.tiles * 0.05, 80))) return -1;
  if (est.tilesPerSecond < 1.2) return -1;
  let score = (expectedTiles / Math.max(1, qp.tiles)) * (1 + prof.aggression) + strength * 0.1;
  if (isTraitor(state, q)) score *= 1.3;
  if (ctx.incoming.has(q)) score *= 1.4;
  return score;
}

/** Picks a neighbour to attack (weak spot on the shared border), or reinforces a war that ran low. */
function war(ctx: Ctx): void {
  const { state, prof, diff, id } = ctx;
  if (state.tick < ctx.ai.nextWarTick) return;
  const wars = new Set(ctx.myAttacks.filter((a) => a.target !== 0).map((a) => a.target));
  const options: WarOption[] = [];
  const reserveShare = 0.3 + clamp(ctx.threat - 0.6, 0, 1) * 0.25;
  for (const q of ctx.enemies) {
    if (!wars.has(q) && wars.size >= prof.maxWars) continue;
    const need = warNeed(ctx, q);
    const strength = ctx.army / Math.max(1, estArmy(state, ctx.m, diff, id, q));
    // Opportunity: while neutral land is left we normally just expand, but a neighbour whose land is about as
    // cheap as neutral land (thin defence: troops away expanding or fighting) is worth a smaller bite.
    const opportunity =
      strength < need && ctx.neutralBorder > 0 && wars.size === 0 && strength >= prof.strengthNeeded * 0.9 && state.rng() < prof.aggression;
    if (strength < need && !opportunity) continue;
    const tile = pickFrontTile(ctx, q, diff.samples);
    if (tile < 0) continue;
    if (opportunity) {
      const e = estimateAttack(state, id, tile, ctx.p.troops);
      const terrainDef = TERRAIN[state.map.terrain[tile] as TerrainId].defense;
      if (!e || e.defensePerTile > NEUTRAL_TILE_DEF * terrainDef * 1.25) continue;
    }
    const edge = opportunity ? 0.6 : 0.8 + 0.4 * clamp(strength / need - 1, 0, 1);
    const share = clamp(prof.warShare * diff.shareScale * edge, 0.2, 0.7);
    const amount = Math.min(ctx.army * share, ctx.home - ctx.army * reserveShare);
    if (amount < Math.max(MIN_ATTACK_TROOPS * 4, ctx.home * 0.1)) continue;
    const score = judgeAttack(ctx, q, tile, chooseForce(ctx, amount, tile, q), strength);
    if (score > 0) options.push({ target: q, tile, score: score * jitter(state, diff.noise), amount });
  }
  if (!options.length) {
    ctx.ai.nextWarTick = state.tick + 3 * TICKS_PER_SECOND;
    return;
  }
  options.sort((a, b) => b.score - a.score);
  const o = options[0];
  // An existing war on that target is only reinforced when it has run low.
  const existing = ctx.myAttacks.find((a) => a.target === o.target);
  if (existing && total(existing.troops) > o.amount * 0.4) return;
  if (launch(ctx, o.tile, chooseForce(ctx, o.amount, o.tile, o.target))) {
    const pause = (8 + 10 * (1 - prof.aggression)) / diff.shareScale;
    ctx.ai.nextWarTick = state.tick + Math.round(pause * TICKS_PER_SECOND);
  }
}

/** True if one of our allies is attacking q or being attacked by q. */
function alliesFighting(ctx: Ctx, q: number): boolean {
  for (const a of ctx.state.attacks) {
    if (a.attacker === q && ctx.allies.includes(a.target)) return true;
    if (a.target === q && ctx.allies.includes(a.attacker)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------------------------------------------
// Economy: buildings and research
// ---------------------------------------------------------------------------------------------------------------

/** Buildings that only pay off in war. */
const MILITARY = new Set<BuildingType>(['barracks', 'factory', 'arsenal', 'fort', 'supplyDepot', 'watchtower', 'airfield', 'sam', 'silo', 'hospital']);

interface BuildOption {
  type: BuildingType | 'research';
  prio: number;
}

/** Tiles of ours from the scan sample (re-checked for ownership), plus the capital. */
function ownedSample(ctx: Ctx, k: number): number[] {
  const owner = ctx.state.map.owner;
  const list = ctx.scan.owned[ctx.id].filter((t) => owner[t] === ctx.id);
  if (ctx.p.capital >= 0 && owner[ctx.p.capital] === ctx.id) list.push(ctx.p.capital);
  return sample(ctx.state, list, k);
}

/** Distance to the nearest (sampled) border with another nation, capped at 40. */
function inland(ctx: Ctx, t: number): number {
  if (t < 0) return 0;
  const w = ctx.state.map.width;
  let d2 = 1600;
  for (const e of ctx.foreignEdges) d2 = Math.min(d2, dist2(w, t, e));
  return Math.sqrt(d2);
}

function nextTech(ctx: Ctx): TechId | null {
  const { p, state } = ctx;
  const coastal = ctx.scan.coastCount[ctx.id] > 0;
  const avail: TechId[] = [];
  for (const t of ctx.prof.techs) {
    if (hasTech(p, t)) continue;
    if (!TECHS[t].requires.every((r) => hasTech(p, r))) continue;
    if (t === 'navigation' && !coastal) continue;
    if (t === 'nuclearFission' && !ctx.diff.nukes) continue;
    avail.push(t);
    if (avail.length >= 2) break;
  }
  if (!avail.length) return null;
  // Easy AIs sometimes take their second choice.
  return ctx.diff.careful || avail.length === 1 || state.rng() < 0.6 ? avail[0] : avail[1];
}

/** Picks what to spend gold on (one or two items per decision): buildings by need x personality, or research. */
function economy(ctx: Ctx): void {
  const { state, p, prof, id } = ctx;
  const T = p.tiles;
  const fill = p.maxPop > 0 ? population(p) / p.maxPop : 1;
  const count = (t: BuildingType): number => countBuildings(state, id, t, true);
  const minutes = state.tick / TICKS_PER_SECOND / 60;
  // Economy first: military buildings wait a few minutes unless a neighbour is threatening.
  const militaryScale = ctx.threat > 1 ? 1 : clamp(minutes / 5, 0.4, 1);
  const opts: BuildOption[] = [];
  const add = (type: BuildingType | 'research', prio: number): void => {
    if (prio <= 0) return;
    if (type === 'research') opts.push({ type, prio });
    else opts.push({ type, prio: prio * (prof.build[type] ?? 1) * (MILITARY.has(type) ? militaryScale : 1) });
  };

  // Cities are the backbone (max pop, gold, supply), more urgent as the population nears its cap. Their number
  // follows the land we hold (then they are upgraded), so land stays what the game is about.
  const cities = count('city');
  add('city', cityRoom(ctx) ? (5 + 7 * fill) * (cities < 1 + T / 350 ? 1.2 : 0.8) : 0);
  add('farm', count('farm') < 1 + T / 450 ? 3 + 4 * (1 - fill) : 0);
  add('market', count('market') < Math.min(10, T / 500 + (cities > 0 ? 1 : 0)) ? 4 + p.workers / 40000 : 0);
  const ironDeposits = ctx.scan.iron[id].length;
  const oilDeposits = ctx.scan.oil[id].length;
  add('mine', ironDeposits > 0 && count('mine') < Math.min(8, 1 + ironDeposits / 2 + T / 1500) ? 6 : 0);
  const wantOil = prof.mix.armor > 0.12 || hasTech(p, 'flight') || count('factory') > 0;
  add('oilWell', oilDeposits > 0 && wantOil && count('oilWell') < Math.min(6, 1 + oilDeposits / 2 + T / 2000) ? 5 : 0);
  add('lab', count('lab') < 1 + T / 1500 + minutes / 6 ? 5.5 + minutes * 0.25 : 0);
  add('barracks', count('barracks') < 3 && T > 150 ? 2.5 + (ctx.enemies.length ? 1.5 : 0) : 0);
  if (p.income.iron > 0 || p.iron > 150) {
    // Armor needs oil: factories only once the wells can feed a useful share of the army.
    const factoryCap = Math.round(1 + prof.mix.armor * 6 + T / 3000);
    add('factory', armorFedShare(ctx) >= 0.04 && count('factory') < factoryCap ? 4.5 : 0);
    const arsenalCap = Math.round(1 + prof.mix.artillery * 5 + T / 4000);
    add('arsenal', count('arsenal') < arsenalCap ? 3.5 : 0);
  }
  // Forts along the border with the most threatening neighbour; towers for warning and a little defence.
  if (ctx.threatId > 0) {
    const borderLen = ctx.scan.border[id * ctx.n + ctx.threatId];
    add('fort', count('fort') < Math.min(10, Math.ceil(borderLen / 70)) ? 2 + clamp(ctx.threat, 0, 2) * 1.8 : 0);
    add('watchtower', count('watchtower') < Math.min(3, ctx.enemies.length) ? 2 : 0);
  }
  if (frontNeedsSupply(ctx)) add('supplyDepot', count('supplyDepot') < 2 + T / 2500 ? 5 : 0);
  if (ctx.scan.coastCount[id] > 0) {
    const portCap = Math.round(prof.naval * 3 + (T > 400 ? 1 : 0));
    add('port', count('port') < portCap ? 2 + prof.naval * 4 : 0);
  }
  if (hasTech(p, 'medicine')) add('hospital', count('hospital') < 2 ? 2.5 : 0);
  if (hasTech(p, 'flight')) add('airfield', count('airfield') < (prof.aggression > 0.5 ? 2 : 1) ? 3.5 : 0);
  if (hasTech(p, 'radar') && enemyAirThreat(ctx)) add('sam', count('sam') < 3 ? 4.5 : 0);
  if (hasTech(p, 'rocketry')) add('silo', count('silo') < 1 ? 3 : 0);

  // Research competes for the same gold (science saved while idle is not lost, so no rush).
  const tech = p.researching ? null : nextTech(ctx);
  if (tech) add('research', 6 + (p.science >= TECHS[tech].science * 0.5 ? 3 : 0) + (prof.techs[0] === tech ? 1 : 0));

  // Best first; an option we can't afford yet keeps part of its price saved, so cheaper, less important
  // items don't eat the savings for it forever.
  opts.sort((a, b) => b.prio - a.prio);
  const top = opts.length ? opts[0].prio : 0;
  let done = 0;
  let saved = 0;
  for (const o of opts) {
    if (o.prio < top * 0.5 || done >= 2) break;
    const cost = o.type === 'research' ? (tech ? TECHS[tech].gold : Infinity) : goldCost(ctx, o.type);
    if (p.gold - saved < cost) {
      saved += Math.min(cost, p.gold) * 0.6;
      continue;
    }
    if (o.type === 'research') {
      if (tech && applyAction(state, id, { type: 'research', tech }).ok) done++;
    } else if (tryBuild(ctx, o.type)) done++;
  }
}

/** Gold price of the next building of a type (for a city: the cheaper of a new one and an upgrade). */
function goldCost(ctx: Ctx, type: BuildingType): number {
  const { state, id } = ctx;
  if (type !== 'city') return buildingCost(state, id, type).gold;
  let c = countBuildings(state, id, 'city', true) < maxCities(ctx) ? buildingCost(state, id, 'city').gold : Infinity;
  for (const b of buildingsOf(state, id, 'city')) {
    if (b.buildLeft <= 0 && b.cooldown <= 0 && b.level < CITY_MAX_LEVEL) c = Math.min(c, buildCostAt(state, id, 'city', b.tile).gold);
  }
  return c;
}

/** Finds a tile for a building type and builds it ("city" may mean upgrading one). */
function tryBuild(ctx: Ctx, type: BuildingType): boolean {
  const { state, p, id } = ctx;
  if (type === 'city') return buildCity(ctx);
  const cost = buildingCost(state, id, type);
  if (p.gold < cost.gold || p.iron < cost.iron) return false;
  let best = -1;
  let bestScore = -Infinity;
  for (const t of candidateTiles(ctx, type)) {
    if (!canBuild(state, id, type, t).ok) continue;
    const s = siteScore(ctx, type, t);
    if (s > bestScore) {
      bestScore = s;
      best = t;
    }
  }
  return best >= 0 && applyAction(state, id, { type: 'build', building: type, tile: best }).ok;
}

/** Most cities an AI founds for its land: one per CITY_TILES tiles (merchants a few more). */
function maxCities(ctx: Ctx): number {
  return 1 + Math.floor((ctx.p.tiles / CITY_TILES) * (ctx.p.personality === 'merchant' ? 1.3 : 1));
}

/** True if a new city may be founded or an existing one upgraded. */
function cityRoom(ctx: Ctx): boolean {
  if (countBuildings(ctx.state, ctx.id, 'city', true) < maxCities(ctx)) return true;
  for (const b of buildingsOf(ctx.state, ctx.id, 'city')) if (b.level < CITY_MAX_LEVEL) return true;
  return false;
}

/** A new city on a good inland tile, or an upgrade of the cheapest city when that costs no more. */
function buildCity(ctx: Ctx): boolean {
  const { state, p, id } = ctx;
  const newCost = countBuildings(state, id, 'city', true) < maxCities(ctx) ? buildingCost(state, id, 'city').gold : Infinity;
  let up = -1;
  let upCost = Infinity;
  for (const b of buildingsOf(state, id, 'city')) {
    if (b.buildLeft > 0 || b.cooldown > 0 || b.level >= CITY_MAX_LEVEL) continue;
    const c = buildCostAt(state, id, 'city', b.tile).gold;
    if (c < upCost || (c === upCost && inland(ctx, b.tile) > inland(ctx, up))) {
      upCost = c;
      up = b.tile;
    }
  }
  // Same price either way: a new city (more supply, spreads out) first, then upgrades.
  if (up >= 0 && upCost < newCost) {
    return p.gold >= upCost && applyAction(state, id, { type: 'build', building: 'city', tile: up }).ok;
  }
  if (p.gold < newCost) return false; // also when no new city is allowed (Infinity)
  let best = -1;
  let bestScore = -Infinity;
  for (const t of ownedSample(ctx, 24)) {
    if (buildingAt(state, t) || !canBuild(state, id, 'city', t).ok) continue;
    const s = siteScore(ctx, 'city', t);
    if (s > bestScore) {
      bestScore = s;
      best = t;
    }
  }
  return best >= 0 && applyAction(state, id, { type: 'build', building: 'city', tile: best }).ok;
}

/** Candidate tiles per building type: deposit-, coast- or border-derived, else a random owned sample. */
function candidateTiles(ctx: Ctx, type: BuildingType): number[] {
  const { state, id, n, scan } = ctx;
  const owner = state.map.owner;
  const w = state.map.width;
  const own = (t: number): boolean => t >= 0 && t < owner.length && owner[t] === id;
  switch (type) {
    case 'mine':
    case 'oilWell': {
      const deposits = (type === 'mine' ? scan.iron[id] : scan.oil[id]).filter(own);
      const out: number[] = [];
      for (const d of sample(state, deposits, 6)) {
        out.push(d);
        for (let k = 0; k < 4; k++) {
          const x = (d % w) + Math.floor(state.rng() * 5) - 2;
          const y = ((d / w) | 0) + Math.floor(state.rng() * 5) - 2;
          if (x >= 0 && y >= 0 && x < w && y < state.map.height) out.push(y * w + x);
        }
      }
      return out.filter(own);
    }
    case 'port':
      return sample(state, scan.coast[id].filter(own), 16);
    case 'fort':
    case 'watchtower':
    case 'supplyDepot': {
      const foe = type === 'supplyDepot' ? mainWarTarget(ctx) || ctx.threatId : ctx.threatId;
      const edges = foe > 0 ? scan.edge[id * n + foe] : ctx.foreignEdges;
      // Forts a few tiles behind the border (not lost at the first push), depots further back.
      const depth = type === 'fort' ? [4, 6, 3] : type === 'watchtower' ? [2, 3] : [8, 12, 6];
      const out: number[] = [];
      for (const e of sample(state, edges.filter(own), 8)) {
        for (const k of depth) {
          const t = inward(ctx, e, k);
          if (own(t)) out.push(t);
        }
      }
      return out;
    }
    default:
      return ownedSample(ctx, 20);
  }
}

/** The tile k steps from border tile e toward our capital (e itself without a capital). */
function inward(ctx: Ctx, e: number, k: number): number {
  const w = ctx.state.map.width;
  const c = ctx.p.capital;
  if (c < 0) return e;
  const dx = (c % w) - (e % w);
  const dy = ((c / w) | 0) - ((e / w) | 0);
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len < 1) return e;
  const x = Math.round((e % w) + (dx / len) * Math.min(k, len));
  const y = Math.round(((e / w) | 0) + (dy / len) * Math.min(k, len));
  return y * w + x;
}

function siteScore(ctx: Ctx, type: BuildingType, t: number): number {
  const { state, id } = ctx;
  const map = state.map;
  const w = map.width;
  const ter = map.terrain[t] as TerrainId;
  const res = map.resource[t];
  const safe = Math.min(inland(ctx, t), 30) / 30; // 0 at a foreign border, 1 deep inside
  const noise = state.rng() * 0.05;
  switch (type) {
    case 'city': {
      let near = 400;
      for (const b of buildingsOf(state, id, 'city')) near = Math.min(near, dist2(w, t, b.tile));
      const spread = Math.min(Math.sqrt(near), 16) / 16;
      return TERRAIN[ter].popPerTile / 30 + safe * 1.5 + spread * 1.2 - (res === Resource.Fertile ? 0.5 : 0) - (map.coastal[t] ? 0.2 : 0) + noise;
    }
    case 'farm':
      return (res === Resource.Fertile ? 2 : 0) + TERRAIN[ter].popPerTile / 30 + safe * 0.5 + noise;
    case 'fort': {
      // Hills and mountains multiply the fort; don't stack forts.
      const r = hasTech(ctx.p, 'fortification') ? FORT_RADIUS_TECH : BUILDINGS.fort.radius;
      let covered = 0;
      for (const b of buildingsOf(state, id, 'fort')) if (dist2(w, t, b.tile) < r * r * 1.2) covered = 1;
      return TERRAIN[ter].defense - covered * 3 + noise;
    }
    case 'watchtower': {
      let covered = 0;
      for (const b of buildingsOf(state, id, 'watchtower')) if (dist2(w, t, b.tile) < 30 * 30) covered = 1;
      return TERRAIN[ter].defense * 0.5 - covered * 2 + noise;
    }
    case 'supplyDepot': {
      const field = state.supplyDist.get(id);
      return (field ? Math.min(field[t], 300) : 0) / 50 + noise;
    }
    case 'port':
      return safe + noise;
    case 'mine':
    case 'oilWell':
      return safe * 0.5 + noise;
    default:
      // Production, science and air buildings: away from the front.
      return safe * 2 + noise;
  }
}

/** True if our main front is mostly beyond supply range (a depot would help). */
function frontNeedsSupply(ctx: Ctx): boolean {
  const field = ctx.state.supplyDist.get(ctx.id);
  const foe = mainWarTarget(ctx) || ctx.threatId;
  if (!field || foe <= 0) return false;
  const range = SUPPLY_RANGE * (hasTech(ctx.p, 'logistics') ? 1.5 : 1);
  let far = 0;
  let k = 0;
  for (const e of ctx.scan.edge[ctx.id * ctx.n + foe]) {
    if (ctx.state.map.owner[e] !== ctx.id) continue;
    k++;
    if (field[e] > range * 0.85) far++;
  }
  return k > 0 && far / k > 0.4;
}

/** Any hostile nation with bombers or a silo. */
function enemyAirThreat(ctx: Ctx): boolean {
  for (const q of ctx.state.players) {
    if (q.id === 0 || q.id === ctx.id || !q.alive || areAllied(ctx.state, ctx.id, q.id)) continue;
    if (countBuildings(ctx.state, q.id, 'silo') > 0) return true;
    for (const b of buildingsOf(ctx.state, q.id, 'airfield')) if (b.bombers > 0) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------------------------------------------
// Navy
// ---------------------------------------------------------------------------------------------------------------

function naval(ctx: Ctx): void {
  const { state, p, prof, id, diff } = ctx;
  ctx.ai.nextNavalTick = state.tick + Math.round((12 + 18 * (1 - prof.naval)) * TICKS_PER_SECOND);
  const coast = ctx.scan.coast[id].filter((t) => state.map.owner[t] === id);
  if (!coast.length) return;

  // Warships: admirals keep a fleet, others a guard when rich.
  if (hasTech(p, 'navigation')) {
    const ports = buildingsOf(state, id, 'port').filter((b) => b.buildLeft <= 0);
    let ships = 0;
    for (const u of state.units) if (u.owner === id && u.type === 'warship') ships++;
    const cap = Math.round(prof.naval * 4 + (ctx.enemies.length ? 1 : 0));
    const c = UNITS.warship;
    if (ports.length && ships < cap && p.gold > c.gold * 2 && p.iron >= c.iron && p.oil >= c.oil) {
      applyAction(state, id, { type: 'buildWarship', port: pick(state, ports).tile });
    }
  }

  // Landings: when boxed in (no neutral land, no war going), or as an admiral's habit.
  const boxedIn = ctx.neutralBorder <= 0 && !ctx.myAttacks.some((a) => a.target !== 0);
  if (!boxedIn && state.rng() > prof.naval * 0.5) return;
  let atSea = 0;
  for (const u of state.units) if (u.owner === id && u.type === 'transport') atSea++;
  if (atSea >= 1 + Math.round(prof.naval * 2)) return;

  const target = landingTarget(ctx, coast);
  if (!target) return;
  const share = (target.owner === 0 ? 0.2 : 0.35) * diff.shareScale * (0.7 + prof.naval * 0.6);
  const amount = Math.min(ctx.home * share, ctx.home - ctx.army * 0.3);
  if (amount < MIN_ATTACK_TROOPS * 4) return;
  const troops = chooseForce(ctx, amount, target.tile, target.owner);
  if (target.owner > 0) {
    const strength = ctx.army / Math.max(1, estArmy(state, ctx.m, diff, id, target.owner));
    if (judgeAttack(ctx, target.owner, target.tile, troops, strength) < 0) {
      ctx.ai.badLandings.set(target.tile, state.tick + 30 * TICKS_PER_SECOND);
      return;
    }
  }
  const r = applyAction(state, id, { type: 'transport', from: target.from, to: target.tile, troops });
  if (!r.ok) {
    ctx.ai.badLandings.set(target.tile, state.tick + 120 * TICKS_PER_SECOND);
    return;
  }
  ctx.home = total(p.troops);
  // An invasion gets an escort: a patrolling warship sails to the landing site (it fights ships and bombards).
  if (target.owner > 0) {
    const ship = state.units.find((u) => u.owner === id && u.type === 'warship' && u.hp > 0 && u.state === 0);
    if (ship) applyAction(state, id, { type: 'moveWarship', unitId: ship.id, tile: target.tile });
  }
}

/** A coastal tile worth landing on: neutral land first, then weak non-allied coasts; near our own coast. */
function landingTarget(ctx: Ctx, coast: number[]): { tile: number; from: number; owner: number } | null {
  const { state, id, n, diff } = ctx;
  const w = state.map.width;
  const owner = state.map.owner;
  const ourCoast = sample(state, coast, 12);
  const neutralFront = ctx.scan.front[id * n];
  let best: { tile: number; from: number; owner: number } | null = null;
  let bestScore = -Infinity;
  for (let q = 0; q < n; q++) {
    if (q === id) continue;
    if (q > 0) {
      if (!state.players[q].alive || areAllied(state, id, q)) continue;
      // Only coasts of nations we clearly outmatch (landings are riskier than land wars).
      if (ctx.army / Math.max(1, estArmy(state, ctx.m, diff, id, q)) < warNeed(ctx, q) * 1.25) continue;
    }
    for (const t of sample(state, ctx.scan.coast[q], 6)) {
      if (owner[t] !== q) continue;
      const bad = ctx.ai.badLandings.get(t);
      if (bad !== undefined && bad > state.tick) continue;
      // Neutral land near our land front is reached on foot.
      if (q === 0 && neutralFront.length && nearestDist(w, t, neutralFront) < 25) continue;
      let from = -1;
      let d2 = Infinity;
      for (const c of ourCoast) {
        const d = dist2(w, t, c);
        if (d < d2) {
          d2 = d;
          from = c;
        }
      }
      if (from < 0) continue;
      const d = Math.sqrt(d2);
      if (d < 4) continue;
      let s = tileValue(state, t) * 10 - d * 0.15 + (q === 0 ? 6 : 0);
      if (q > 0 && isTraitor(state, q)) s += 3;
      s *= jitter(state, diff.noise);
      if (s > bestScore) {
        bestScore = s;
        best = { tile: t, from, owner: q };
      }
    }
  }
  return best;
}

function nearestDist(w: number, t: number, list: number[]): number {
  let d2 = Infinity;
  for (let k = 0; k < list.length; k += 2) d2 = Math.min(d2, dist2(w, t, list[k]));
  return Math.sqrt(d2);
}

// ---------------------------------------------------------------------------------------------------------------
// Air and missiles
// ---------------------------------------------------------------------------------------------------------------

/** Nations we are fighting (either direction). */
function foes(ctx: Ctx): number[] {
  const out = new Set<number>();
  for (const a of ctx.myAttacks) if (a.target > 0) out.add(a.target);
  for (const q of ctx.incoming.keys()) out.add(q);
  return [...out].filter((q) => ctx.state.players[q].alive && !areAllied(ctx.state, ctx.id, q));
}

/** Most valuable enemy building to strike (kinds in priority order), avoiding SAM cover when careful. */
function strikeTarget(ctx: Ctx, kinds: BuildingType[], from: number): number {
  const { state } = ctx;
  const w = state.map.width;
  const samR2 = BUILDINGS.sam.radius * BUILDINGS.sam.radius;
  let best = -1;
  let bestScore = -Infinity;
  for (const q of foes(ctx)) {
    const sams = ctx.diff.careful ? buildingsOf(state, q, 'sam').filter((b) => b.buildLeft <= 0) : [];
    for (let k = 0; k < kinds.length; k++) {
      for (const b of buildingsOf(state, q, kinds[k])) {
        if (state.map.owner[b.tile] !== q) continue;
        let covered = 0;
        for (const s of sams) if (dist2(w, s.tile, b.tile) <= samR2) covered++;
        const far = from >= 0 ? Math.sqrt(dist2(w, from, b.tile)) : 0;
        const s = (kinds.length - k) * 10 - covered * 12 - far * 0.05 + (b.type === 'city' ? b.level : 0);
        if (s > bestScore) {
          bestScore = s;
          best = b.tile;
        }
      }
    }
  }
  return best;
}

function airAndMissiles(ctx: Ctx): void {
  const { state, p, id } = ctx;
  ctx.ai.nextAirTick = state.tick + 8 * TICKS_PER_SECOND;
  const fighting = foes(ctx);
  const airThreat = enemyAirThreat(ctx);

  for (const af of buildingsOf(state, id, 'airfield')) {
    if (af.buildLeft > 0) continue;
    // Fighters if the enemy has bombers, else bombers.
    const kind = airThreat && af.fighters < 2 ? 'fighter' : 'bomber';
    const c = UNITS[kind];
    if (af.bombers + af.fighters < 5 && p.gold > c.gold + 1000 && p.oil >= c.oil && p.iron >= c.iron) {
      applyAction(state, id, { type: 'buildAircraft', airfield: af.tile, kind });
    }
    if (fighting.length && af.bombers > 0) {
      const t = strikeTarget(ctx, ['fort', 'factory', 'arsenal', 'airfield', 'city', 'barracks'], af.tile);
      if (t >= 0) applyAction(state, id, { type: 'bomb', airfield: af.tile, tile: t });
    }
  }

  if (!hasTech(p, 'rocketry')) return;
  for (const silo of buildingsOf(state, id, 'silo')) {
    if (silo.buildLeft > 0 || silo.cooldown > 0) continue;
    if (maybeNuke(ctx, silo.tile)) continue;
    const c = UNITS.rocket;
    if (!fighting.length || p.gold < c.gold + 600 || p.iron < c.iron || p.oil < c.oil) continue;
    const t = strikeTarget(ctx, ['silo', 'sam', 'fort', 'airfield', 'factory'], -1);
    if (t >= 0) applyAction(state, id, { type: 'launchMissile', silo: silo.tile, kind: 'rocket', tile: t });
  }
}

/**
 * Atom bombs (normal/hard only): when losing badly to an attacker, or against a runaway leader holding over 40% of
 * the land. Everyone will hate us for it, so only then, and never close to our own land.
 */
function maybeNuke(ctx: Ctx, silo: number): boolean {
  const { state, p, id, diff } = ctx;
  if (!diff.nukes || !hasTech(p, 'nuclearFission') || state.tick < ctx.ai.nextNukeTick) return false;
  const c = UNITS.atomBomb;
  if (p.gold < c.gold || p.iron < c.iron || p.oil < c.oil) return false;
  let target = 0;
  if (p.tiles < ctx.ai.peakTiles * 0.6 && ctx.incomingTotal > ctx.home * 0.5) {
    let most = 0;
    for (const [q, t] of ctx.incoming) {
      if (t > most) {
        most = t;
        target = q;
      }
    }
  }
  if (!target) {
    // A runaway leader we border or fight.
    for (const q of state.players) {
      if (q.id === 0 || q.id === id || !q.alive || areAllied(state, id, q.id)) continue;
      if (ctx.landShare[q.id] > 0.4 && (ctx.neighbours.includes(q.id) || ctx.incoming.has(q.id))) target = q.id;
    }
  }
  if (!target) return false;
  // Their biggest cities, then the capital; skip spots whose blast would touch our land.
  const spots = buildingsOf(state, target, 'city').sort((a, b) => b.level - a.level).map((b) => b.tile);
  if (state.players[target].capital >= 0) spots.push(state.players[target].capital);
  for (const t of spots.slice(0, 4)) {
    if (state.map.owner[t] !== target) continue;
    let ours = 0;
    forEachInRadius(state.map, t, ATOM_RADIUS, (i) => {
      if (state.map.owner[i] === id) ours++;
    });
    if (ours > 0) continue;
    if (!applyAction(state, id, { type: 'launchMissile', silo, kind: 'atomBomb', tile: t }).ok) return false;
    ctx.ai.nextNukeTick = state.tick + NUKE_PAUSE_SECONDS * TICKS_PER_SECOND;
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------------------------------------------
// Diplomacy
// ---------------------------------------------------------------------------------------------------------------

function answerRequests(ctx: Ctx): void {
  const { state, id } = ctx;
  for (const r of state.allianceRequests.filter((x) => x.to === id)) {
    applyAction(state, id, { type: 'answerAlliance', from: r.from, accept: aiWantsAlliance(state, id, r.from) });
  }
}

/** Neighbour test from the shared scan (false before the first scan). */
function bordersFromScan(state: GameState, a: number, b: number): boolean {
  const s = memories.get(state)?.scan;
  if (!s || a >= s.n || b >= s.n) return false;
  return s.border[a * s.n + b] > 0;
}

function armyOf(state: GameState, id: number): number {
  let t = total(state.players[id].troops);
  for (const a of state.attacks) if (a.attacker === id) t += total(a.troops);
  return t;
}

/**
 * Once no neutral land is left to take: the neighbour this AI wants to fight next (the weakest one relative to us
 * that we could beat; non-allied ones preferred), or 0. Alliances with that neighbour are not made or renewed
 * (warlords may even break one), otherwise a map of happy allies would never end.
 */
function nextTarget(state: GameState, ai: number): number {
  const scan = memories.get(state)?.scan;
  const me = state.players[ai];
  if (!scan || ai >= scan.n || !me.alive || me.isHuman) return 0;
  const n = scan.n;
  if (scan.border[ai * n] > 0) return 0;
  const mine = armyOf(state, ai);
  const busy = memories.get(state)?.ais.get(ai)?.busyTick ?? state.tick;
  const idleMinutes = (state.tick - busy) / (60 * TICKS_PER_SECOND);
  const need = PROFILES[me.personality ?? 'balanced'].strengthNeeded * clamp(1 - idleMinutes * 0.1, 0.6, 1);
  let best = 0;
  let bestScore = 0;
  for (const q of state.players) {
    if (q.id === 0 || q.id === ai || !q.alive || scan.border[ai * n + q.id] <= 0) continue;
    const ratio = mine / Math.max(1, armyOf(state, q.id));
    if (ratio < need) continue;
    const s = ratio * (areAllied(state, ai, q.id) ? 1 : 1.5);
    if (s > bestScore) {
      bestScore = s;
      best = q.id;
    }
  }
  return best;
}

/** Whether AI `ai` accepts an alliance from `from` (opinion, threat, personality). */
export function aiWantsAlliance(state: GameState, ai: number, from: number): boolean {
  const me = state.players[ai];
  const them = state.players[from];
  if (!me || !them || ai === 0 || from === 0 || ai === from || !me.alive || !them.alive) return false;
  if (isTraitor(state, from)) return false;
  // Nowhere else to grow and they are the next target: no (renewed) alliance.
  if (nextTarget(state, ai) === from) return false;
  for (const a of state.attacks) if ((a.attacker === from && a.target === ai) || (a.attacker === ai && a.target === from)) return false;
  const prof = PROFILES[me.personality ?? 'balanced'];
  // Never prop up a runaway leader.
  const land = Math.max(1, state.map.landTileCount);
  let biggest = 0;
  for (const p of state.players) if (p.id !== 0 && p.alive) biggest = Math.max(biggest, p.tiles);
  if (them.tiles >= biggest && them.tiles / land > 0.3 && them.tiles > me.tiles * 1.5) return false;
  const opinion = state.opinion[ai]?.[from] ?? 0;
  if (opinion > prof.allyOpinion) return true;
  // A common, stronger neighbour we both fear (the classic reason for non-neighbours to ally).
  const myArmy = armyOf(state, ai);
  const theirArmy = armyOf(state, from);
  const neighbours = bordersFromScan(state, ai, from);
  for (const q of state.players) {
    if (q.id === 0 || q.id === ai || q.id === from || !q.alive || areAllied(state, ai, q.id)) continue;
    const qa = armyOf(state, q.id);
    const fearMe = bordersFromScan(state, ai, q.id) && qa > myArmy * 1.2;
    const fearThem = bordersFromScan(state, from, q.id) && qa > theirArmy * 1.2;
    if (fearMe && fearThem && (!neighbours || opinion > -10)) return true;
  }
  // Under heavy attack by someone else: any friend not disliked is welcome.
  for (const a of state.attacks) {
    if (a.target === ai && a.attacker !== from && opinion > -15 && total(a.troops) > total(me.troops) * 0.5) return true;
  }
  // Timid nations (low bar) welcome a stronger neighbour or a distant friend.
  return prof.allyOpinion <= 15 && opinion >= 0 && (!neighbours || theirArmy > myArmy);
}

/** Seconds before an AI proposes an alliance to the same nation again. */
const PROPOSAL_COOLDOWN_S = 180;

function diplomacy(ctx: Ctx): void {
  const { state, p, prof, id } = ctx;
  const merchant = p.personality === 'merchant';
  ctx.ai.nextDiploTick = state.tick + Math.round((merchant ? 15 : 30) * TICKS_PER_SECOND * (0.75 + state.rng() * 0.5));

  // Renew alliances that are about to expire while we still like them (and don't need them as a target).
  const drop = nextTarget(state, id);
  for (const al of state.alliances) {
    if (al.a !== id && al.b !== id) continue;
    const other = al.a === id ? al.b : al.a;
    if (other !== drop && al.expiresTick - state.tick < 50 * TICKS_PER_SECOND && state.opinion[id][other] > -20) {
      applyAction(state, id, { type: 'requestAlliance', to: other });
    }
  }

  // Propose to a feared strong neighbour, or to a distant nation facing the same threat (merchants: anyone friendly).
  const pending = new Set(state.allianceRequests.filter((r) => r.from === id).map((r) => r.to));
  let candidate = 0;
  let bestScore = 0;
  for (const q of state.players) {
    if (q.id === 0 || q.id === id || !q.alive || pending.has(q.id) || areAllied(state, id, q.id)) continue;
    if (isTraitor(state, q.id) || ctx.incoming.has(q.id) || ctx.myAttacks.some((a) => a.target === q.id) || q.id === drop) continue;
    // Don't ask the same nation again for a while (a human would see the same request every 30 s).
    const asked = ctx.ai.proposedTick.get(q.id);
    if (asked !== undefined && state.tick - asked < PROPOSAL_COOLDOWN_S * TICKS_PER_SECOND) continue;
    const op = state.opinion[id][q.id];
    if (op < -20) continue;
    const neighbour = ctx.neighbours.includes(q.id);
    const ratio = ctx.m.army[q.id] / ctx.army;
    let s = 0;
    if (neighbour && ratio > 1.3) s = ratio + (1 - prof.aggression);
    else if (!neighbour && ctx.threatId > 0 && bordersFromScan(state, q.id, ctx.threatId)) s = 1.5;
    else if (merchant && op >= 0) s = 0.8;
    if (s <= 0) continue;
    s += op / 100;
    if (s > bestScore) {
      bestScore = s;
      candidate = q.id;
    }
  }
  if (candidate && bestScore > 0.6 && ctx.allies.length < 3) {
    ctx.ai.proposedTick.set(candidate, state.tick);
    applyAction(state, id, { type: 'requestAlliance', to: candidate });
  }

  // Warlords may betray a much weaker neighbouring ally when it is the only way left to grow (rarely: everyone
  // will distrust them and they defend at x0.7 for a while).
  if (p.personality === 'warlord' && drop > 0 && ctx.allies.includes(drop) && ctx.m.army[drop] < ctx.army * 0.4 && state.rng() < 0.25) {
    applyAction(state, id, { type: 'breakAlliance', with: drop });
  }

  // A rare gift: rich merchants sweeten a feared neighbour.
  if (merchant && p.gold > 6000 && ctx.threatId > 0 && state.opinion[id][ctx.threatId] > -40 && state.rng() < 0.3) {
    applyAction(state, id, { type: 'gift', to: ctx.threatId, gold: 500, troops: 0 });
  }
}
