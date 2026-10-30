// AI nations and tribes (DESIGN section 10). They act only through applyAction (same rules as the human); everything
// else here only reads the GameState.
//
// Cost model (grand scale: hundreds of players, millions of tiles): nothing scans the map at play time. Each player's
// neighbourhood (border lengths per neighbour, samples of the tiles on both sides of each border) is built from its
// border set (territory.ts, kept up to date by setOwner) when it decides, and cached for a few ticks. Owned tiles are
// sampled in the player's bounding box, coasts and deposits come from territory's lists. Nations decide every
// AI_DECISION_SECONDS, tribes every TRIBE_DECISION_SECONDS, both staggered by id, so only a handful act per tick.
//
// Pacing follows the troop curve (economy.ts: growth peaks at about 42% of the cap): a nation expands into the
// wilderness whenever it has troops above a small reserve, and starts wars once its troops reach a trigger share of
// the cap, keeping a reserve at home (both per-nation random within a range), so it hovers near the growth peak.
//
// The caches live in a WeakMap keyed by the GameState (not in the state): they are derived data, rebuilt on demand,
// and sampling uses deterministic hashing or state.rng, so the simulation stays deterministic.
import { applyAction } from './actions';
import { armorFedShare, recommendMix, troopShares } from './advisor';
import { artilleryOf, barrageRange, canBarrage } from './barrage';
import {
  aircraftCap,
  buildingCost,
  buildingMaxLevel,
  buildingsOf,
  chargesReady,
  countBuildings,
  countSites,
  fortRadius,
  isDisabled,
  fortMultiplierAt,
  resolveBuildTarget,
  samRadius,
  watchtowerRadiusOf,
} from './buildings';
import { artillerySiegeBonus, estimateAttack, supplyDistance } from './combat';
import {
  AI_DECISION_SECONDS,
  ATOM_RADIUS,
  BARRAGE_GOLD,
  BARRAGE_MIN_ARTILLERY,
  MATCHUP,
  MIN_ATTACK_TROOPS,
  PARADROP_MIN_TROOPS,
  SPAWN_SECONDS,
  SUPPLY_RANGE,
  TECHS,
  TERRAIN,
  TICKS_PER_SECOND,
  TRIBE_DECISION_SECONDS,
  TRIBE_MAX_TILES,
  TROOP_ATTACK,
  UNITS,
} from './config';
import { areAllied, isTraitor } from './diplomacy';
import { troopCap } from './economy';
import { forEachInRadius } from './grid';
import { alliancesAllowed as rulesAllowAlliances, atPeace, buildingAllowed, researchRule, unitAllowed } from './rules';
import { canSpawnAt, gameSeconds, ownerBox, spawnAtFixedPoint } from './state';
import { borderTiles, coastCount, depositCount, landComponents, sampleOwnedTiles } from './territory';
import { canParadrop, paradropMaxTroops, paradropRange } from './units';
import { inOvertime, victoryShareNow } from './victory';
import { hasTech } from './tech';
import { TROOP_TYPES, Resource, isTribe, isWater } from './types';
import type { Attack, BuildingType, Difficulty, GameState, Personality, Player, TechId, TerrainId, TroopType, Troops } from './types';

// ---------------------------------------------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------------------------------------------

/** A neighbourhood is rebuilt from the border set when older than this many ticks. */
const HOOD_MAX_AGE = 10;
/** At most this many border tiles are read per neighbourhood (a stride over bigger borders). */
const HOOD_MAX_BORDER = 3000;
/** Samples kept per neighbour (both sides of the border). */
const CAP_PAIR = 32;
/** Coarse spawn-quality grid block size (tiles). */
const QBLOCK = 8;
/** Land of a nation is judged in units of this many tiles for building counts (maps are grand scale). */
const TILE_UNIT = 8;
/** An AI founds one city per this many owned tiles (and upgrades them once it has them all). */
const CITY_TILES = 2400;
/** At most one atom bomb per AI per this many seconds. */
const NUKE_PAUSE_SECONDS = 300;

interface Profile {
  /** willingness to start wars, 0..1 */
  aggression: number;
  /** war trigger: troops at home as a share of the cap before a new war ([min, max], per nation random) */
  trigger: [number, number];
  /** troops kept at home in a war, share of the cap */
  reserve: [number, number];
  /** troops kept at home while expanding into the wilderness, share of the cap */
  expandReserve: [number, number];
  /** our army / their army needed before attacking a neighbour (lower = bolder) */
  strengthNeeded: number;
  maxWars: number;
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
    trigger: [0.45, 0.55],
    reserve: [0.25, 0.32],
    expandReserve: [0.08, 0.14],
    strengthNeeded: 0.8,
    maxWars: 3,
    mix: { armor: 0.35, artillery: 0.1 },
    techs: ['metallurgy', 'mechanization', 'logistics', 'industrialization', 'agriculture', 'ballistics', 'combinedArms', 'medicine', 'flight', 'rocketry', 'banking', 'fortification', 'radar', 'navigation', 'nuclearFission'],
    build: { barracks: 1.6, factory: 1.5, mine: 1.3, oilWell: 1.3, fort: 0.6, market: 0.8, port: 0.6, hospital: 1.3, supplyDepot: 1.3 },
    allyOpinion: 35,
    naval: 0.25,
  },
  turtle: {
    aggression: 0.35,
    trigger: [0.55, 0.65],
    reserve: [0.35, 0.42],
    expandReserve: [0.12, 0.18],
    strengthNeeded: 1.3,
    maxWars: 1,
    mix: { armor: 0.1, artillery: 0.3 },
    techs: ['fortification', 'metallurgy', 'ballistics', 'agriculture', 'rocketry', 'logistics', 'flight', 'radar', 'medicine', 'mechanization', 'banking', 'industrialization', 'combinedArms', 'nuclearFission', 'navigation'],
    build: { fort: 2.0, arsenal: 1.5, watchtower: 1.6, farm: 1.2, sam: 1.5, factory: 0.6, port: 0.6 },
    allyOpinion: 15,
    naval: 0.25,
  },
  merchant: {
    aggression: 0.4,
    trigger: [0.55, 0.62],
    reserve: [0.33, 0.4],
    expandReserve: [0.1, 0.16],
    strengthNeeded: 1.3,
    maxWars: 1,
    mix: { armor: 0.15, artillery: 0.15 },
    techs: ['agriculture', 'banking', 'navigation', 'medicine', 'metallurgy', 'logistics', 'fortification', 'mechanization', 'flight', 'ballistics', 'industrialization', 'radar', 'rocketry', 'combinedArms', 'nuclearFission'],
    build: { city: 1.3, market: 1.6, port: 1.6, farm: 1.2, lab: 1.2, barracks: 0.6, factory: 0.7, fort: 0.9 },
    allyOpinion: 5,
    naval: 0.65,
  },
  admiral: {
    aggression: 0.6,
    trigger: [0.5, 0.6],
    reserve: [0.3, 0.38],
    expandReserve: [0.1, 0.15],
    strengthNeeded: 1.0,
    maxWars: 2,
    mix: { armor: 0.2, artillery: 0.15 },
    techs: ['navigation', 'metallurgy', 'logistics', 'flight', 'agriculture', 'mechanization', 'ballistics', 'banking', 'radar', 'industrialization', 'rocketry', 'medicine', 'fortification', 'combinedArms', 'nuclearFission'],
    build: { port: 2.2, market: 1.1, fort: 0.8 },
    allyOpinion: 20,
    naval: 1.0,
  },
  // Tribes don't use most of this (see decideTribe): they never go to war and only grow a little.
  tribe: {
    aggression: 0,
    trigger: [1, 1],
    reserve: [0.4, 0.4],
    expandReserve: [0.15, 0.25],
    strengthNeeded: 99,
    maxWars: 0,
    mix: { armor: 0, artillery: 0 },
    techs: [],
    build: {},
    allyOpinion: -100,
    naval: 0,
  },
  balanced: {
    aggression: 0.65,
    trigger: [0.5, 0.6],
    reserve: [0.3, 0.38],
    expandReserve: [0.1, 0.15],
    strengthNeeded: 1.0,
    maxWars: 2,
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
  /**
   * Game seconds during which a human nation is a much less tempting war target (x HUMAN_RESTRAINT strength
   * needed, unless it attacked us): a new player gets time to learn before the AI armies come. 0 = none.
   */
  humanGrace: number;
}
/** Extra strength an AI wants before attacking a human during its difficulty's humanGrace. */
const HUMAN_RESTRAINT = 1.8;
/** Game seconds during which AIs accept a human's alliance only out of opinion (no fear or timid alliances). */
const EARLY_ALLY_SECONDS = 180;
const DIFFICULTY: Record<Difficulty, DifficultyProfile> = {
  easy: { noise: 0.35, shareScale: 0.75, samples: 3, careful: false, nukes: false, coordinate: false, spawnTries: 20, humanGrace: 480 },
  normal: { noise: 0.15, shareScale: 1, samples: 5, careful: true, nukes: true, coordinate: false, spawnTries: 50, humanGrace: 360 },
  hard: { noise: 0.04, shareScale: 1.1, samples: 8, careful: true, nukes: true, coordinate: true, spawnTries: 100, humanGrace: 0 },
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
/** A fixed per-player value in [lo, hi] (personal thresholds; the same for the whole game). */
function personal(id: number, salt: number, range: [number, number]): number {
  return range[0] + (range[1] - range[0]) * hashUnit(Math.imul(id + 1, 0x9e3779b1) ^ salt);
}
function dist2(w: number, a: number, b: number): number {
  const dx = (a % w) - (b % w);
  const dy = ((a / w) | 0) - ((b / w) | 0);
  return dx * dx + dy * dy;
}
function pick<T>(state: GameState, arr: readonly T[]): T {
  return arr[Math.floor(state.rng() * arr.length)];
}
/** Up to k distinct random elements (partial Fisher-Yates on a copy; random picks for long arrays). */
function sample<T>(state: GameState, arr: readonly T[], k: number): T[] {
  if (arr.length <= k) return arr.slice();
  if (arr.length > k * 8) {
    const out: T[] = [];
    for (let tries = 0; tries < k * 3 && out.length < k; tries++) {
      const v = arr[Math.floor(state.rng() * arr.length)];
      if (!out.includes(v)) out.push(v);
    }
    return out;
  }
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
// Neighbourhoods (from the border sets)
// ---------------------------------------------------------------------------------------------------------------

interface Hood {
  tick: number;
  /** border edges per neighbour id (0 = neutral land); estimated with a stride on very long borders */
  counts: Map<number, number>;
  /** sample of the neighbour's tiles touching us (front) and of ours touching them (edge), per neighbour */
  front: Map<number, number[]>;
  edge: Map<number, number[]>;
}
const EMPTY: number[] = [];

/** Builds a player's neighbourhood from its border set. Reservoir samples use a hash, not the RNG. */
function buildHood(state: GameState, id: number): Hood {
  const hood: Hood = { tick: state.tick, counts: new Map(), front: new Map(), edge: new Map() };
  const { list, len } = borderTiles(state, id);
  if (len === 0) return hood;
  const map = state.map;
  const { owner, terrain } = map;
  const w = map.width;
  const n = owner.length;
  const stride = Math.max(1, Math.ceil(len / HOOD_MAX_BORDER));
  const offset = stride > 1 ? state.tick % stride : 0;
  let salt = Math.imul(state.tick + 1, 0x9e3779b1) ^ id;
  const record = (i: number, j: number): void => {
    const o = owner[j];
    if (o === id || terrain[j] <= 1) return;
    const c = (hood.counts.get(o) ?? 0) + 1;
    hood.counts.set(o, c);
    let fl = hood.front.get(o);
    let el = hood.edge.get(o);
    if (!fl || !el) {
      hood.front.set(o, (fl = []));
      hood.edge.set(o, (el = []));
    }
    if (fl.length < CAP_PAIR) {
      fl.push(j);
      el.push(i);
    } else {
      salt = hash32(salt + c);
      const r = salt % c;
      if (r < CAP_PAIR) {
        fl[r] = j;
        el[r] = i;
      }
    }
  };
  for (let k = offset; k < len; k += stride) {
    const i = list[k];
    const x = i % w;
    if (x > 0) record(i, i - 1);
    if (x < w - 1) record(i, i + 1);
    if (i >= w) record(i, i - w);
    if (i < n - w) record(i, i + w);
  }
  if (stride > 1) for (const [o, c] of hood.counts) hood.counts.set(o, c * stride);
  return hood;
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
  /** all coastal land tiles of the map (static), for neutral landing targets */
  coast: Int32Array | null;
  hoods: Map<number, Hood>;
  ais: Map<number, AIState>;
  /** per tick cache: total army (home + attacks + transports) per player */
  armyTick: number;
  army: Float64Array;
  /** per tick cache: some hostile nation has bombers or a silo, per player id (-1 unknown) */
  airTick: number;
  air: Int8Array;
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
      coast: null,
      hoods: new Map(),
      ais: new Map(),
      armyTick: -1,
      army: new Float64Array(state.players.length),
      airTick: -1,
      air: new Int8Array(state.players.length),
    };
    memories.set(state, m);
  }
  return m;
}

/** A player's neighbourhood, rebuilt when older than maxAge ticks. */
function hoodOf(state: GameState, id: number, maxAge = HOOD_MAX_AGE): Hood {
  const m = memory(state);
  const h = m.hoods.get(id);
  if (h && state.tick - h.tick <= maxAge && state.tick >= h.tick) return h;
  const fresh = buildHood(state, id);
  m.hoods.set(id, fresh);
  return fresh;
}
/** Border edges between a and b (0 = neutral land), from a's neighbourhood. */
function borderLen(state: GameState, a: number, b: number): number {
  return hoodOf(state, a, 30).counts.get(b) ?? 0;
}

function aiState(m: Memory, id: number): AIState {
  let s = m.ais.get(id);
  if (!s) {
    s = { decisions: 0, nextWarTick: 0, nextNavalTick: 0, nextDiploTick: 0, nextAirTick: 0, peakTiles: 0, busyTick: 0, nextNukeTick: 0, attacks: new Map(), badLandings: new Map(), proposedTick: new Map() };
    m.ais.set(id, s);
  }
  return s;
}

/** Army per player incl. troops in attacks and on transports (cached per tick). */
function refreshArmies(state: GameState, m: Memory): void {
  if (m.armyTick === state.tick && m.army.length === state.players.length) return;
  m.armyTick = state.tick;
  const n = state.players.length;
  if (m.army.length !== n) m.army = new Float64Array(n);
  const army = m.army;
  army.fill(0);
  for (const a of state.attacks) if (a.attacker < n) army[a.attacker] += total(a.troops);
  for (const u of state.units) if ((u.type === 'transport' || u.type === 'transportPlane') && u.owner < n) army[u.owner] += total(u.troops);
  for (const p of state.players) army[p.id] = p.alive ? army[p.id] + total(p.troops) : 0;
}

/** Static list of every coastal land tile (neutral landing targets are sampled from it). */
function mapCoast(state: GameState, m: Memory): Int32Array {
  if (m.coast) return m.coast;
  const c = state.map.coastal;
  let k = 0;
  for (let i = 0; i < c.length; i++) if (c[i]) k++;
  const out = new Int32Array(k);
  k = 0;
  for (let i = 0; i < c.length; i++) if (c[i]) out[k++] = i;
  m.coast = out;
  return out;
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
  const popOf = new Float32Array(9);
  for (let t = 2; t < 9; t++) popOf[t] = TERRAIN[t as TerrainId].popPerTile / 30;
  for (let y = 0; y < map.height; y++) {
    const row = y * map.width;
    const qrow = ((y / QBLOCK) | 0) * qw;
    for (let x = 0; x < map.width; x++) {
      const i = row + x;
      const t = map.terrain[i];
      if (t <= 1) continue;
      let v = popOf[t];
      const r = map.resource[i];
      if (r === Resource.Iron) v += 3;
      else if (r === Resource.Oil) v += 2.5;
      else if (r === Resource.Fertile) v += 1.5;
      q[qrow + ((x / QBLOCK) | 0)] += v;
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
  const far = dmin === Infinity ? 1 : clamp(dmin / spacing, 0.1, 1.1);
  // Spread out: distance matters as much as land quality (nations start far apart on grand maps).
  return land * (0.2 + 0.8 * far);
}

/** During the spawn phase: pick a good spawn for every AI that hasn't spawned (each at its own random moment). */
export function aiSpawn(state: GameState): void {
  if (state.phase !== 'spawn') return;
  const m = memory(state);
  mapCoast(state, m); // static data, built while nothing else happens
  const elapsed = SPAWN_SECONDS - state.spawnLeft;
  const diff = DIFFICULTY[state.settings.difficulty] ?? DIFFICULTY.normal;
  const map = state.map;
  const n = map.width * map.height;
  let nations = 0;
  for (const p of state.players) if (p.id !== 0 && !isTribe(p)) nations++;
  // Expected distance between capitals if land were shared evenly between the nations.
  const spacing = Math.sqrt(map.landTileCount / Math.max(1, nations)) * 0.9;
  for (const p of state.players) {
    // Tribes spawn in the leftover space when the phase ends (state.autoSpawnRemaining).
    if (!isAI(p) || !p.alive || p.spawned || isTribe(p)) continue;
    let at = m.spawnAt.get(p.id);
    if (at === undefined) {
      at = SPAWN_SECONDS * (0.08 + 0.6 * state.rng());
      m.spawnAt.set(p.id, at);
    }
    if (elapsed < at) continue;
    // World maps: the nation starts at its real capital (or the nearest free spot).
    if ((state.spawnPoints?.[p.id] ?? -1) >= 0 && spawnAtFixedPoint(state, p.id)) continue;
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
  hood: Hood;
  p: Player;
  id: number;
  ai: AIState;
  prof: Profile;
  diff: DifficultyProfile;
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
  /** troop cap */
  cap: number;
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
}

/** Share of all land a player holds. */
function landShare(state: GameState, q: number): number {
  const p = state.players[q];
  return p && p.alive && q !== 0 ? p.tiles / Math.max(1, state.map.landTileCount) : 0;
}

/** Called every tick; nations decide every AI_DECISION_SECONDS, tribes every 4-8 s, all staggered by id. */
export function updateAI(state: GameState): void {
  if (state.phase !== 'playing') return;
  const interval = Math.max(1, Math.round((AI_DECISION_SECONDS[state.settings.difficulty] ?? 3) * TICKS_PER_SECOND));
  const tribeLo = Math.round(TRIBE_DECISION_SECONDS[0] * TICKS_PER_SECOND);
  const tribeSpan = Math.round((TRIBE_DECISION_SECONDS[1] - TRIBE_DECISION_SECONDS[0]) * TICKS_PER_SECOND);
  let m: Memory | null = null;
  for (const p of state.players) {
    if (!isAI(p) || !p.alive || !p.spawned) continue;
    const tribe = isTribe(p);
    const every = tribe ? tribeLo + (hash32(p.id) % (tribeSpan + 1)) : interval;
    if ((state.tick + p.id * 7) % every !== 0) continue;
    m ??= memory(state);
    refreshArmies(state, m);
    const ctx = makeCtx(state, m, p);
    if (tribe) decideTribe(ctx);
    else decide(ctx);
  }
}

function makeCtx(state: GameState, m: Memory, p: Player): Ctx {
  const id = p.id;
  const diff = DIFFICULTY[state.settings.difficulty] ?? DIFFICULTY.normal;
  const hood = hoodOf(state, id, isTribe(p) ? 30 : HOOD_MAX_AGE);
  const allies: number[] = [];
  for (const al of state.alliances) {
    if (al.a === id) allies.push(al.b);
    else if (al.b === id) allies.push(al.a);
  }
  const enemies: number[] = [];
  const neighbours: number[] = [];
  for (const q of hood.counts.keys()) {
    if (q === 0 || q === id || !state.players[q]?.alive) continue;
    neighbours.push(q);
    if (!allies.includes(q)) enemies.push(q);
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
    if (isTribe(state.players[q])) continue;
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
    const list = hood.edge.get(q) ?? EMPTY;
    for (let k = 0; k < list.length && k < 12; k++) foreignEdges.push(list[k]);
  }
  return {
    state,
    m,
    hood,
    p,
    id,
    ai: aiState(m, id),
    prof: PROFILES[p.personality ?? 'balanced'],
    diff,
    enemies,
    neighbours,
    allies,
    neutralBorder: hood.counts.get(0) ?? 0,
    army,
    home: total(p.troops),
    cap: Math.max(1, p.maxPop > 0 ? p.maxPop : troopCap(state, id)),
    incoming,
    incomingTotal,
    myAttacks,
    threat,
    threatId,
    foreignEdges,
  };
}

/** Noisy estimate of another player's whole army (AI cheat, accuracy by difficulty). Stable for ~20 s. */
function estArmy(state: GameState, m: Memory, diff: DifficultyProfile, me: number, q: number): number {
  return m.army[q] * (1 + hashSigned(me, q, Math.floor(state.tick / 200)) * diff.noise);
}

/** Front samples of our border with q (their tiles), still owned by them. */
function frontSamples(ctx: Ctx, q: number): number[] {
  const owner = ctx.state.map.owner;
  return (ctx.hood.front.get(q) ?? EMPTY).filter((t) => owner[t] === q);
}

/**
 * A tribe: accepts every alliance, and while it is small takes neutral land next to it with the troops above a
 * small reserve. It never attacks anyone and builds nothing.
 */
function decideTribe(ctx: Ctx): void {
  const { state, p, id } = ctx;
  ctx.ai.decisions++;
  answerRequests(ctx);
  if (ctx.neutralBorder <= 0 || p.tiles >= TRIBE_MAX_TILES) return;
  const running = ctx.myAttacks.find((a) => a.target === 0);
  const reserve = ctx.cap * personal(id, 11, ctx.prof.expandReserve);
  const amount = Math.floor(Math.min(p.troops.infantry, ctx.home - reserve));
  if (running && total(running.troops) > amount * 0.5) return;
  if (amount < MIN_ATTACK_TROOPS * 3) return;
  const fronts = frontSamples(ctx, 0);
  if (!fronts.length) return;
  launch(ctx, pick(state, fronts), { infantry: amount, armor: 0, artillery: 0 });
}

function decide(ctx: Ctx): void {
  const { state, ai, p } = ctx;
  ai.decisions++;
  ai.peakTiles = Math.max(ai.peakTiles, p.tiles);
  if (ctx.neutralBorder > 0 || ctx.myAttacks.length > 0 || ai.busyTick === 0) ai.busyTick = state.tick;
  answerRequests(ctx);
  manageAttacks(ctx);
  defend(ctx);
  expand(ctx);
  barrage(ctx);
  war(ctx);
  economy(ctx);
  if (ai.decisions % 3 === p.id % 3) armyMix(ctx);
  if (state.tick >= ai.nextNavalTick) naval(ctx);
  if (state.tick >= ai.nextAirTick) airAndMissiles(ctx);
  if (state.tick >= ai.nextDiploTick) diplomacy(ctx);
}

// ---------------------------------------------------------------------------------------------------------------
// Army mix and force composition
// ---------------------------------------------------------------------------------------------------------------

const shares = troopShares;

/** Target armor / artillery shares (advisor.recommendMix): personality, then (careful AIs) the main foe's mix, the terrain and forts. */
function armyMix(ctx: Ctx): void {
  const { state, p, prof, diff, id } = ctx;
  const foe = mainWarTarget(ctx) || ctx.threatId;
  const frontTiles = foe > 0 ? (ctx.hood.front.get(foe) ?? EMPTY) : (ctx.hood.front.get(0) ?? EMPTY);
  const { armor, artillery } = recommendMix(state, id, { base: prof.mix, foe, frontTiles, careful: diff.careful, army: ctx.army });
  if (Math.abs(armor - p.armyMix.armor) > 0.03 || Math.abs(artillery - p.armyMix.artillery) > 0.03) {
    applyAction(state, id, { type: 'setArmyMix', armor, artillery });
  }
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
 * on the target tile (terrain, matchup against the defender's mix, artillery's siege bonus). Artillery is kept under
 * 40% of the force (unescorted artillery dies fast). Never more of a type than is at home.
 */
function chooseForce(ctx: Ctx, amount: number, tile: number, target: number): Troops {
  const { state, p } = ctx;
  const home = p.troops;
  amount = Math.min(amount, total(home));
  const out: Troops = { infantry: 0, armor: 0, artillery: 0 };
  if (amount <= 0) return out;
  const w: Troops = { infantry: home.infantry, armor: home.armor, artillery: home.artillery };
  if (ctx.diff.careful && tile >= 0) {
    const ter = TERRAIN[state.map.terrain[tile] as TerrainId];
    const against = target > 0 ? shares(state.players[target].troops) : null;
    const siege = target > 0 ? artillerySiegeBonus(fortMultiplierAt(state, tile, target)) : 1;
    for (const k of TROOP_TYPES) {
      let eff = TROOP_ATTACK[k] * ter.attack[k];
      if (against) eff *= against.infantry * MATCHUP[k].infantry + against.armor * MATCHUP[k].armor + against.artillery * MATCHUP[k].artillery;
      if (k === 'artillery') eff *= siege;
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
    const neededHome = ctx.incomingTotal > ctx.home * 2 && !ctx.incoming.has(a.target);
    const secs = (state.tick - rec.checkTick) / TICKS_PER_SECOND;
    let failing = false;
    if (secs >= 6) {
      const lost = rec.checkTroops - t;
      const tiles = a.tilesTaken - rec.checkTiles;
      const lossShare = lost / Math.max(1, rec.checkTroops);
      const est = estimateAttack(state, ctx.id, frontGuess(ctx, a), a.troops);
      failing =
        (lossShare > 0.4 && tiles < 10) || // melting without progress
        (est !== null && est.lossPerTile * 40 > t && est.tilesPerSecond < 2); // spent and crawling
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
  const list = ctx.hood.front.get(a.target) ?? EMPTY;
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
 * Counter-attacks fronts pushing into us when they are worth stopping and we can beat them. Troops sent against an
 * attacker cancel its attack first (combat.ts), so we send a bit more than its power and let the leftover push on.
 * Small raids are left to die on our defence (a counter costs troops too); a losing clash only wastes troops.
 */
function defend(ctx: Ctx): void {
  const { state, id } = ctx;
  if (ctx.incomingTotal <= 0) return;
  for (const a of state.attacks) {
    if (a.target !== id) continue;
    const t = total(a.troops);
    if (t < Math.max(MIN_ATTACK_TROOPS * 10, ctx.home * 0.08)) continue;
    // How much land would it take? Judge on one of our tiles facing them.
    const facing = (ctx.hood.edge.get(a.attacker) ?? EMPTY).find((e) => state.map.owner[e] === id);
    if (facing !== undefined) {
      const e = estimateAttack(state, a.attacker, facing, a.troops, 1);
      if (e && t / Math.max(0.01, e.lossPerTile) < Math.max(40, ctx.p.tiles * 0.01)) continue;
    }
    const theirPower = clashPower(a.troops, ctx.p.troops);
    const homePower = clashPower(ctx.p.troops, a.troops);
    const need = theirPower * 1.15;
    if (need <= 0 || homePower * 0.7 < need) continue;
    const unitPower = homePower / Math.max(1, ctx.home);
    const amount = Math.min(ctx.home * 0.7, need / Math.max(0.1, unitPower));
    const fronts = frontSamples(ctx, a.attacker);
    if (fronts.length) launch(ctx, fronts[0], chooseForce(ctx, amount, fronts[0], a.attacker));
  }
}

/** Value of taking a tile: troop cap weight, resources, buildings. */
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
 * A tile on our front with `target` (0 = neutral) to judge an attack by: the click only picks the owner (the whole
 * border advances), but terrain and forts at the tile shape the estimate. Picks the best value per expected loss.
 */
function pickFrontTile(ctx: Ctx, target: number, samples: number): number {
  const { state, id } = ctx;
  const list = frontSamples(ctx, target);
  if (!list.length) return -1;
  if (target === 0 || samples <= 1) return pick(state, list);
  const probe: Troops = { ...ctx.p.troops };
  if (total(probe) <= 0) probe.infantry = 1;
  let best = -1;
  let bestScore = -Infinity;
  for (const t of sample(state, list, samples)) {
    const e = estimateAttack(state, id, t, probe, 1);
    if (!e) continue;
    const s = (tileValue(state, t) / Math.max(0.01, e.lossPerTile)) * jitter(state, ctx.diff.noise);
    if (s > bestScore) {
      bestScore = s;
      best = t;
    }
  }
  return best;
}

/**
 * Keeps an expansion front into the wilderness going while there is any: every troop above a small reserve (a
 * personal share of the cap, more with a threatening neighbour) is sent; a running expansion is topped up once it
 * ran low. Wilderness floods fast and cheaply, so troops are the limit, not speed.
 */
function expand(ctx: Ctx): void {
  const { state, prof, diff, id } = ctx;
  if (ctx.neutralBorder <= 0) return;
  const existing = ctx.myAttacks.find((a) => a.target === 0);
  const reserveShare = personal(id, 11, prof.expandReserve) + (ctx.enemies.length ? clamp(ctx.threat - 0.6, 0, 1) * 0.2 : 0);
  const spare = ctx.home - ctx.cap * reserveShare;
  if (existing && total(existing.troops) > spare * 0.6) return; // the current wave still has punch
  const amount = spare * diff.shareScale;
  if (amount < Math.max(MIN_ATTACK_TROOPS * 5, ctx.cap * 0.02)) return;
  const fronts = frontSamples(ctx, 0);
  if (!fronts.length) return;
  const tile = pick(state, fronts);
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
  // Wilderness is far cheaper than a war: while there is some, only a much weaker nation is worth attacking.
  if (ctx.neutralBorder > 0) need *= 2.2 + (1 - prof.aggression);
  else {
    // Boxed in and idle: impatience grows (-10% per idle minute, down to 50%), so stalemates break.
    const idleMinutes = (state.tick - ctx.ai.busyTick) / (60 * TICKS_PER_SECOND);
    need *= clamp(1 - idleMinutes * 0.1, 0.5, 1);
  }
  // A full troop bar barely grows: troops spent now regrow fast, so idle troops are cheap.
  if (ctx.home > ctx.cap * 0.8) need *= 0.75;
  if (isTraitor(state, q)) need *= 0.7;
  need *= 1 + clamp(state.opinion[id][q], -60, 60) / 150;
  if (ctx.incoming.has(q)) need *= 0.75;
  if (diff.coordinate && alliesFighting(ctx, q)) need *= 0.75;
  const lq = landShare(state, q);
  if (lq > 0.3 && lq > landShare(state, id) * 1.5) need *= 0.75;
  // A nation others are already eating is a crowded prize (a small share, and it fights for its life): no pile-on
  // unless we are much stronger. Gang-ups ended games in their first minutes.
  need *= 1 + 0.8 * otherAttackers(ctx, q);
  if (humanSpared(ctx, q)) need *= HUMAN_RESTRAINT;
  return need;
}

/** A human in its early-game grace (by difficulty) that is not attacking us: spared unless we are much stronger. */
function humanSpared(ctx: Ctx, q: number): boolean {
  const qp = ctx.state.players[q];
  return !!qp && qp.isHuman && !ctx.incoming.has(q) && gameSeconds(ctx.state) < ctx.diff.humanGrace;
}

/** Nations other than us (and not allied with us) attacking q right now. */
function otherAttackers(ctx: Ctx, q: number): number {
  let n = 0;
  let last = -1;
  for (const a of ctx.state.attacks) {
    if (a.target === q && a.attacker !== ctx.id && a.attacker !== last && !ctx.allies.includes(a.attacker)) {
      n++;
      last = a.attacker;
    }
  }
  return n;
}

/**
 * Judges sending `force` at q: expected tiles (troops / loss per tile) must be worth it and the front must move.
 * Returns a score (higher = better) or -1.
 */
function judgeAttack(ctx: Ctx, q: number, tile: number, force: Troops, strength: number): number {
  const { state, prof, id } = ctx;
  const qp = state.players[q];
  const est = estimateAttack(state, id, tile, force, Math.max(1, borderLen(state, id, q) / 2));
  if (!est) return -1;
  const expectedTiles = total(force) / Math.max(0.01, est.lossPerTile);
  if (expectedTiles < Math.max(40, Math.min(qp.tiles * 0.04, 400))) return -1;
  if (est.tilesPerSecond < 2) return -1;
  let score = (expectedTiles / Math.max(1, qp.tiles)) * (1 + prof.aggression) + strength * 0.1;
  if (isTribe(qp)) score *= 1.5; // easy food
  else score /= 1 + 0.5 * otherAttackers(ctx, q);
  if (isTraitor(state, q)) score *= 1.3;
  if (ctx.incoming.has(q)) score *= 1.4;
  return score;
}

/**
 * Wars: once the troops at home reach the nation's trigger share of the cap (or it is attacked, or a tribe is ripe),
 * picks a neighbour and sends everything above its reserve; or reinforces a war that ran low. Boxed-in nations get
 * impatient, and one with a full bar always finds someone (no idle AIs).
 */
function war(ctx: Ctx): void {
  const { state, prof, diff, id } = ctx;
  if (state.tick < ctx.ai.nextWarTick) return;
  const fill = ctx.home / ctx.cap;
  const trigger = personal(id, 23, prof.trigger);
  const reserveShare = personal(id, 37, prof.reserve) + clamp(ctx.threat - 0.6, 0, 1) * 0.15;
  const room = ctx.home - ctx.cap * reserveShare;
  const wars = new Set(ctx.myAttacks.filter((a) => a.target !== 0 && !isTribe(state.players[a.target])).map((a) => a.target));
  const options: WarOption[] = [];
  const ready = fill >= trigger || ctx.incomingTotal > 0;
  for (const q of ctx.enemies) {
    const qp = state.players[q];
    if (isTribe(qp)) {
      const o = tribeOption(ctx, q, room);
      if (o) options.push(o);
      continue;
    }
    if (!ready || atPeace(state, id, q)) continue;
    if (!wars.has(q) && wars.size >= prof.maxWars) continue;
    if (!wars.has(q) && !ctx.incoming.has(q) && otherAttackers(ctx, q) >= 2) continue;
    const need = warNeed(ctx, q);
    const strength = ctx.army / Math.max(1, estArmy(state, ctx.m, diff, id, q));
    if (strength < need) continue;
    const tile = pickFrontTile(ctx, q, diff.samples);
    if (tile < 0) continue;
    let amount = room * diff.shareScale;
    if (amount < Math.max(MIN_ATTACK_TROOPS * 10, ctx.home * 0.1)) continue;
    // Send more, lose less: careful AIs top the force up toward odds 1.2 when the reserve allows it.
    if (diff.careful) {
      const e = estimateAttack(state, id, tile, chooseForce(ctx, amount, tile, q), 1);
      if (e && e.odds > 0 && e.odds < 1.2) amount = Math.min((amount * 1.2) / e.odds, Math.max(amount, ctx.home - ctx.cap * reserveShare * 0.6));
    }
    const score = judgeAttack(ctx, q, tile, chooseForce(ctx, amount, tile, q), strength);
    if (score > 0) options.push({ target: q, tile, score: score * jitter(state, diff.noise), amount });
  }
  // A full bar wastes growth: a boxed-in nation picks its weakest neighbour rather than sit idle.
  if (!options.length && ctx.neutralBorder <= 0 && fill > 0.75 && ctx.enemies.length) {
    let best = 0;
    let bestRatio = 0;
    for (const q of ctx.enemies) {
      if (atPeace(state, id, q) || humanSpared(ctx, q)) continue;
      const r = ctx.army / Math.max(1, estArmy(state, ctx.m, diff, id, q));
      if (r > bestRatio) {
        bestRatio = r;
        best = q;
      }
    }
    if (best && bestRatio > 0.6) {
      const tile = pickFrontTile(ctx, best, 2);
      if (tile >= 0) options.push({ target: best, tile, score: 1, amount: room });
    }
  }
  if (!options.length) {
    ctx.ai.nextWarTick = state.tick + 3 * TICKS_PER_SECOND;
    return;
  }
  options.sort((a, b) => b.score - a.score || a.target - b.target);
  const o = options[0];
  // An existing war on that target is only reinforced when it has run low.
  const existing = ctx.myAttacks.find((a) => a.target === o.target);
  if (existing && total(existing.troops) > o.amount * 0.4) return;
  if (launch(ctx, o.tile, chooseForce(ctx, o.amount, o.tile, o.target))) {
    const pause = (10 + 20 * (1 - prof.aggression)) / diff.shareScale;
    ctx.ai.nextWarTick = state.tick + Math.round(pause * TICKS_PER_SECOND);
  }
}

/**
 * Eating a tribe: whenever we clearly outnumber it (even while wilderness is left), with enough troops to take all of
 * it (it collapses once it is small, see combat.collapseThreshold).
 */
function tribeOption(ctx: Ctx, q: number, room: number): WarOption | null {
  const { state, id, diff } = ctx;
  const qp = state.players[q];
  if (ctx.myAttacks.some((a) => a.target === q)) return null; // already eating it
  const strength = ctx.army / Math.max(1, estArmy(state, ctx.m, diff, id, q));
  if (strength < 2) return null;
  const fronts = frontSamples(ctx, q);
  if (!fronts.length) return null;
  const tile = fronts[0];
  const est = estimateAttack(state, id, tile, ctx.p.troops, 1);
  if (!est) return null;
  const want = qp.tiles * est.lossPerTile * 1.3 + total(qp.troops) * 1.5 + MIN_ATTACK_TROOPS;
  const amount = Math.min(Math.max(room, ctx.home * 0.25), want);
  if (amount < Math.max(MIN_ATTACK_TROOPS * 5, want * 0.5)) return null;
  const score = (1 + qp.tiles / 400) * jitter(state, diff.noise);
  return { target: q, tile, score, amount };
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

/** Random tiles of ours: sampled in our bounding box (re-checked for ownership), plus the capital. */
function ownedSample(ctx: Ctx, k: number): number[] {
  const { state, id } = ctx;
  const owner = state.map.owner;
  const out: number[] = [];
  if (ctx.p.capital >= 0 && owner[ctx.p.capital] === id) out.push(ctx.p.capital);
  const box = ownerBox(state, id);
  if (box) {
    const w = state.map.width;
    const bw = box[2] - box[0] + 1;
    const bh = box[3] - box[1] + 1;
    for (let tries = 0; tries < k * 12 && out.length < k; tries++) {
      const t = (box[1] + Math.floor(state.rng() * bh)) * w + box[0] + Math.floor(state.rng() * bw);
      if (owner[t] === id) out.push(t);
    }
  }
  if (out.length < k) {
    const { list, len } = borderTiles(state, id);
    for (let q = 0; q < k - out.length && len > 0; q++) out.push(list[Math.floor(state.rng() * len)]);
  }
  return out;
}

/** Distance to the nearest (sampled) border with another nation, capped at 80. */
function inland(ctx: Ctx, t: number): number {
  if (t < 0) return 0;
  const w = ctx.state.map.width;
  let d2 = 6400;
  for (const e of ctx.foreignEdges) d2 = Math.min(d2, dist2(w, t, e));
  return Math.sqrt(d2);
}

function nextTech(ctx: Ctx): TechId | null {
  const { p, state } = ctx;
  const coastal = coastCount(state, ctx.id) > 0;
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
  const T = p.tiles / TILE_UNIT;
  const fill = clamp(ctx.home / ctx.cap, 0, 1);
  const count = (t: BuildingType): number => countBuildings(state, id, t, true);
  const minutes = gameSeconds(state) / 60;
  // Economy first: military buildings wait a few minutes unless a neighbour is threatening.
  const militaryScale = ctx.threat > 1 ? 1 : clamp(minutes / 5, 0.4, 1);
  const opts: BuildOption[] = [];
  const noResearch = researchRule(state) !== null;
  const add = (type: BuildingType | 'research', prio: number): void => {
    if (prio <= 0) return;
    if (type === 'research' ? noResearch : !buildingAllowed(state, type)) return;
    if (type === 'research') opts.push({ type, prio });
    else opts.push({ type, prio: prio * (prof.build[type] ?? 1) * (MILITARY.has(type) ? militaryScale : 1) });
  };

  // Cities are the backbone (troop cap, gold, supply), more urgent as the troops near their cap. Their number
  // follows the land we hold (then they are upgraded), so land stays what the game is about.
  const cities = countSites(state, id, 'city', true);
  add('city', cityRoom(ctx) ? (5 + 7 * fill) * (cities < 1 + p.tiles / CITY_TILES ? 1.2 : 0.8) : 0);
  add('farm', count('farm') < 1 + T / 450 ? 3 + 4 * (1 - fill) : 0);
  add('market', count('market') < Math.min(10, T / 500 + (cities > 0 ? 1 : 0)) ? 4 + p.income.gold / 150 : 0);
  const ironDeposits = depositCount(state, id, 1);
  const oilDeposits = depositCount(state, id, 2);
  add('mine', ironDeposits > 0 && count('mine') < Math.min(8, 1 + ironDeposits / 8 + T / 1500) ? 6 : 0);
  const wantOil = prof.mix.armor > 0.12 || hasTech(p, 'flight') || count('factory') > 0;
  add('oilWell', oilDeposits > 0 && wantOil && count('oilWell') < Math.min(6, 1 + oilDeposits / 8 + T / 2000) ? 6 : 0);
  // Science: a few labs, more with land and time (research paces the late game: atom bombs come last).
  add('lab', count('lab') < 2 + T / 5000 + minutes / 8 ? 5.5 + minutes * 0.15 : 0);
  add('barracks', count('barracks') < 3 && T > 150 ? 2.5 + (ctx.enemies.length ? 1.5 : 0) : 0);
  if (p.income.iron > 0 || p.iron > 150) {
    // Armor needs oil: factories only once the wells can feed a useful share of the army.
    const factoryCap = Math.round(1 + prof.mix.armor * 6 + T / 3000);
    // The first factory / arsenal matters most (no conversion at all without one); a big all-infantry army makes
    // them urgent (they don't wait for the military build-up either).
    const armyWeight = Math.min(5, ctx.army / 600000);
    add('factory', armorFedShare(state, p, ctx.army) >= 0.04 && count('factory') < factoryCap ? (count('factory') === 0 ? 7 : 5) + armyWeight : 0);
    const arsenalCap = Math.round(1 + prof.mix.artillery * 5 + T / 4000);
    add('arsenal', count('arsenal') < arsenalCap ? (count('arsenal') === 0 ? 6.5 : 4.5) + armyWeight : 0);
  }
  // Forts along the border with the most threatening neighbour; towers for warning and a little defence.
  if (ctx.threatId > 0) {
    const len = borderLen(state, id, ctx.threatId);
    add('fort', count('fort') < Math.min(10, Math.ceil(len / 200)) ? 2 + clamp(ctx.threat, 0, 2) * 1.8 : 0);
    add('watchtower', count('watchtower') < Math.min(3, ctx.enemies.length) ? 2 : 0);
  }
  if (frontNeedsSupply(ctx)) add('supplyDepot', count('supplyDepot') < 2 + T / 2500 ? 5 : 0);
  if (coastCount(state, id) > 0) {
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
    if (done >= 2) break;
    const cost = o.type === 'research' ? (tech ? TECHS[tech].gold : Infinity) : goldCost(ctx, o.type);
    if (p.gold - saved < cost) {
      saved += Math.min(cost, p.gold) * 0.6;
      continue;
    }
    // Low-priority items (under half the top one) only with gold to spare, so the rarer buildings (towers,
    // hospitals, airfields, silos ...) still get built by rich nations instead of yet another city level.
    if (o.prio < top * 0.5 && p.gold - saved < cost * 3) continue;
    if (o.type === 'research') {
      if (tech && applyAction(state, id, { type: 'research', tech }).ok) done++;
    } else if (tryBuild(ctx, o.type)) done++;
  }
}

/** Gold price of the next level of a type (new building or upgrade: the same price); Infinity for a city without room. */
function goldCost(ctx: Ctx, type: BuildingType): number {
  if (type === 'city' && !cityRoom(ctx)) return Infinity;
  return buildingCost(ctx.state, ctx.id, type).gold;
}

/**
 * Types whose spot only matters for safety: upgrading the one we have is as good as a new site, so the AI prefers it
 * (fewer, bigger buildings; the spacing rule leaves room for the ones that need a place).
 */
const UPGRADE_FIRST = new Set<BuildingType>(['farm', 'market', 'barracks', 'factory', 'arsenal', 'lab', 'hospital', 'silo', 'mine', 'oilWell', 'port']);

/**
 * Finds a spot for a building type and orders it ("city" may mean upgrading one). Every candidate tile goes through
 * buildings.resolveBuildTarget (the same rule as a human click: upgrade a building of that type nearby, else snap to
 * the nearest valid tile), and the resulting spot is scored. The order is sent with the candidate tile, so the sim
 * resolves it the same way.
 */
function tryBuild(ctx: Ctx, type: BuildingType): boolean {
  const { state, p, id } = ctx;
  if (type === 'city') return buildCity(ctx);
  const cost = buildingCost(state, id, type);
  if (p.gold < cost.gold || p.iron < cost.iron) return false;
  let best = -1;
  let bestScore = -Infinity;
  const seen = new Set<number>();
  for (const t of candidateTiles(ctx, type)) {
    const r = resolveBuildTarget(state, id, type, t);
    if ('error' in r || !r.affordable || seen.has(r.tile)) continue;
    seen.add(r.tile);
    const s = siteScore(ctx, type, r.tile, r.upgrade) + (r.upgrade && UPGRADE_FIRST.has(type) ? 1.5 : 0);
    if (s > bestScore) {
      bestScore = s;
      best = t;
    }
  }
  return best >= 0 && applyAction(state, id, { type: 'build', building: type, tile: best }).ok;
}

/** Cities are upgraded to this level before the AI founds another (unless a front needs supply). */
const CITY_UPGRADE_FIRST = 3;

/** Most cities an AI founds for its land: one per CITY_TILES tiles (merchants a few more). */
function maxCities(ctx: Ctx): number {
  return 1 + Math.floor((ctx.p.tiles / CITY_TILES) * (ctx.p.personality === 'merchant' ? 1.3 : 1));
}

/** True if a new city may be founded or an existing one upgraded. */
function cityRoom(ctx: Ctx): boolean {
  if (countSites(ctx.state, ctx.id, 'city', true) < maxCities(ctx)) return true;
  const top = buildingMaxLevel('city');
  for (const b of buildingsOf(ctx.state, ctx.id, 'city')) if (b.level + (b.upgradeLeft > 0 ? 1 : 0) < top) return true;
  return false;
}

/**
 * A new city on a good inland tile while the land allows another (more supply, spreads out), else an upgrade of an
 * idle city below the top level (lowest level first, then the safest). Both cost the same.
 */
function buildCity(ctx: Ctx): boolean {
  const { state, p, id } = ctx;
  const cost = buildingCost(state, id, 'city');
  if (p.gold < cost.gold) return false;
  const top = buildingMaxLevel('city');
  // Fewer, bigger cities: a new one only once every idle city is level 3, or when a front lacks supply.
  let lowIdle = false;
  for (const b of buildingsOf(state, id, 'city')) if (b.buildLeft <= 0 && b.upgradeLeft <= 0 && b.level < CITY_UPGRADE_FIRST) lowIdle = true;
  if (countSites(state, id, 'city', true) < maxCities(ctx) && (!lowIdle || frontNeedsSupply(ctx))) {
    let best = -1;
    let bestScore = -Infinity;
    for (const t of ownedSample(ctx, 24)) {
      const r = resolveBuildTarget(state, id, 'city', t);
      if ('error' in r || r.upgrade || !r.affordable) continue;
      const s = siteScore(ctx, 'city', r.tile, false);
      if (s > bestScore) {
        bestScore = s;
        best = t;
      }
    }
    if (best >= 0 && applyAction(state, id, { type: 'build', building: 'city', tile: best }).ok) return true;
  }
  let up = -1;
  let upScore = -Infinity;
  for (const b of buildingsOf(state, id, 'city')) {
    if (b.buildLeft > 0 || b.upgradeLeft > 0 || b.level >= top) continue;
    const s = Math.min(inland(ctx, b.tile), 60) - b.level * 10;
    if (s > upScore) {
      upScore = s;
      up = b.tile;
    }
  }
  return up >= 0 && applyAction(state, id, { type: 'build', building: 'city', tile: up }).ok;
}

/** Candidate tiles per building type: deposit-, coast- or border-derived, else a random owned sample. */
function candidateTiles(ctx: Ctx, type: BuildingType): number[] {
  const { state, id } = ctx;
  const owner = state.map.owner;
  const w = state.map.width;
  const own = (t: number): boolean => t >= 0 && t < owner.length && owner[t] === id;
  switch (type) {
    case 'mine':
    case 'oilWell': {
      const deposits = sampleOwnedTiles(state, id, type === 'mine' ? 'iron' : 'oil', 6);
      const out: number[] = [];
      for (const d of deposits) {
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
      return sampleOwnedTiles(state, id, 'coast', 16);
    case 'fort':
    case 'watchtower':
    case 'supplyDepot':
    case 'airfield': {
      const foe = type === 'supplyDepot' || type === 'airfield' ? mainWarTarget(ctx) || ctx.threatId : ctx.threatId;
      const edges = foe > 0 ? (ctx.hood.edge.get(foe) ?? EMPTY) : ctx.foreignEdges;
      // Forts a few tiles behind the border (not lost at the first push), depots further back, airfields within
      // reach of the front (fighter cover, paratroopers) but out of the first push.
      const depth = type === 'fort' ? [8, 12, 5] : type === 'watchtower' ? [3, 5] : type === 'airfield' ? [30, 45, 20] : [16, 24, 10];
      const out: number[] = [];
      for (const e of sample(state, edges.filter(own), 8)) {
        for (const k of depth) {
          const t = inward(ctx, e, k);
          if (own(t)) out.push(t);
        }
      }
      return out;
    }
    default: {
      const out = ownedSample(ctx, 20);
      // Our own buildings of the type (an order on one upgrades it).
      if (UPGRADE_FIRST.has(type)) for (const b of buildingsOf(state, id, type)) if (out.length < 32) out.push(b.tile);
      return out;
    }
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

/** How good a spot is for a type (higher is better); `upgrade`: the order upgrades the building on t. */
function siteScore(ctx: Ctx, type: BuildingType, t: number, upgrade: boolean): number {
  const { state, id } = ctx;
  const map = state.map;
  const w = map.width;
  const ter = map.terrain[t] as TerrainId;
  const res = map.resource[t];
  const safe = Math.min(inland(ctx, t), 60) / 60; // 0 at a foreign border, 1 deep inside
  const noise = state.rng() * 0.05;
  switch (type) {
    case 'city': {
      let near = 1600;
      for (const b of buildingsOf(state, id, 'city')) near = Math.min(near, dist2(w, t, b.tile));
      const spread = Math.min(Math.sqrt(near), 40) / 40;
      return TERRAIN[ter].popPerTile / 30 + safe * 1.5 + spread * 1.2 - (res === Resource.Fertile ? 0.5 : 0) - (map.coastal[t] ? 0.2 : 0) + noise;
    }
    case 'farm':
      return (res === Resource.Fertile ? 2 : 0) + TERRAIN[ter].popPerTile / 30 + safe * 0.5 + noise;
    case 'fort': {
      // Hills and mountains multiply the fort; don't stack forts (upgrade the one that already covers the spot).
      if (upgrade) return TERRAIN[ter].defense + 0.5 + noise;
      let covered = 0;
      for (const b of buildingsOf(state, id, 'fort')) {
        const r = fortRadius(state, b);
        if (dist2(w, t, b.tile) < r * r * 1.2) covered = 1;
      }
      return TERRAIN[ter].defense - covered * 3 + noise;
    }
    case 'watchtower': {
      if (upgrade) return TERRAIN[ter].defense * 0.5 + noise;
      let covered = 0;
      for (const b of buildingsOf(state, id, 'watchtower')) {
        const r = watchtowerRadiusOf(state, b) * 0.75;
        if (dist2(w, t, b.tile) < r * r) covered = 1;
      }
      return TERRAIN[ter].defense * 0.5 - covered * 2 + noise;
    }
    case 'supplyDepot':
      return Math.min(supplyDistance(state, id, t), 300) / 50 + noise;
    case 'port':
      return safe + noise;
    case 'mine':
    case 'oilWell':
      return safe * 0.5 + noise;
    case 'airfield':
      // Close enough to the fronts for fighter cover and paratroopers, not on them.
      return 1.5 - Math.abs(safe - 0.35) * 3 + noise;
    default:
      // Production, science and air buildings: away from the front.
      return safe * 2 + noise;
  }
}

/** True if our main front is mostly beyond supply range (a depot would help). */
function frontNeedsSupply(ctx: Ctx): boolean {
  const foe = mainWarTarget(ctx) || ctx.threatId;
  if (foe <= 0) return false;
  const range = SUPPLY_RANGE * (hasTech(ctx.p, 'logistics') ? 1.5 : 1);
  let far = 0;
  let k = 0;
  for (const e of ctx.hood.edge.get(foe) ?? EMPTY) {
    if (ctx.state.map.owner[e] !== ctx.id) continue;
    k++;
    if (supplyDistance(ctx.state, ctx.id, e) > range * 0.85) far++;
    if (k >= 12) break;
  }
  return k > 0 && far / k > 0.4;
}

/** Any hostile nation with bombers or a silo (cached per tick per player). */
function enemyAirThreat(ctx: Ctx): boolean {
  const { state, m, id } = ctx;
  if (m.airTick !== state.tick || m.air.length !== state.players.length) {
    m.airTick = state.tick;
    if (m.air.length !== state.players.length) m.air = new Int8Array(state.players.length);
    m.air.fill(-1);
  }
  if (m.air[id] >= 0) return m.air[id] === 1;
  let found = false;
  for (const b of state.buildings.values()) {
    if (b.owner === id || b.owner <= 0 || b.buildLeft > 0) continue;
    if (b.type !== 'silo' && !(b.type === 'airfield' && b.bombers > 0)) continue;
    if (!state.players[b.owner]?.alive || areAllied(state, id, b.owner)) continue;
    found = true;
    break;
  }
  m.air[id] = found ? 1 : 0;
  return found;
}

// ---------------------------------------------------------------------------------------------------------------
// Navy
// ---------------------------------------------------------------------------------------------------------------

function naval(ctx: Ctx): void {
  const { state, p, prof, id, diff } = ctx;
  ctx.ai.nextNavalTick = state.tick + Math.round((12 + 18 * (1 - prof.naval)) * TICKS_PER_SECOND);
  const coast = sampleOwnedTiles(state, id, 'coast', 16);
  if (!coast.length) return;

  // Warships: admirals keep a fleet, others a guard when rich.
  if (hasTech(p, 'navigation') && unitAllowed(state, 'warship')) {
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
  const share = (target.owner === 0 ? 0.25 : 0.4) * diff.shareScale * (0.7 + prof.naval * 0.6);
  const amount = Math.min(ctx.home * share, ctx.home - ctx.cap * 0.2);
  if (amount < MIN_ATTACK_TROOPS * 20) return;
  const troops = chooseForce(ctx, amount, target.tile, target.owner);
  if (target.owner > 0 && !isTribe(state.players[target.owner])) {
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

/**
 * A coastal tile worth landing on, across water (not reachable on foot): neutral land first, then weak non-allied
 * coasts; near our own coast.
 */
function landingTarget(ctx: Ctx, coast: readonly number[]): { tile: number; from: number; owner: number } | null {
  const { state, id, diff, m } = ctx;
  const w = state.map.width;
  const owner = state.map.owner;
  const ourCoast = sample(state, coast, 12);
  const candidates: number[] = [];
  // Neutral coast: random coastal tiles of the map that nobody owns.
  const all = mapCoast(state, m);
  for (let k = 0; k < 40 && candidates.length < 10 && all.length; k++) {
    const t = all[Math.floor(state.rng() * all.length)];
    if (owner[t] === 0) candidates.push(t);
  }
  // Coasts of nations and tribes we clearly outmatch (landings are riskier than land wars).
  for (const q of state.players) {
    if (q.id === 0 || q.id === id || !q.alive || coastCount(state, q.id) === 0) continue;
    const ratio = ctx.army / Math.max(1, estArmy(state, m, diff, id, q.id));
    if (ratio < (isTribe(q) ? 2 : 0.4) || areAllied(state, id, q.id) || atPeace(state, id, q.id)) continue;
    if (!isTribe(q) && ratio < warNeed(ctx, q.id) * 1.1) continue;
    for (const t of sampleOwnedTiles(state, q.id, 'coast', 3)) candidates.push(t);
  }
  let best: { tile: number; from: number; owner: number } | null = null;
  let bestScore = -Infinity;
  for (const t of candidates) {
    const q = owner[t];
    const bad = ctx.ai.badLandings.get(t);
    if (bad !== undefined && bad > state.tick) continue;
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
    if (d < 6) continue;
    let s = tileValue(state, t) * 10 - d * 0.08 + (q === 0 ? 6 : 0);
    if (q > 0 && isTraitor(state, q)) s += 3;
    if (q > 0 && isTribe(state.players[q])) s += 2;
    s *= jitter(state, diff.noise);
    if (s <= bestScore) continue;
    // Land reachable on foot is not a landing.
    if (q === 0 ? (ctx.hood.front.get(0)?.length ?? 0) > 0 && !landingNeeded(ctx, t) : !landingNeeded(ctx, t)) continue;
    bestScore = s;
    best = { tile: t, from, owner: q };
  }
  return best;
}

/** True if tile t is on a landmass where we don't touch its owner (so it takes a ship). */
function landingNeeded(ctx: Ctx, t: number): boolean {
  const q = ctx.state.map.owner[t];
  const fronts = q === 0 ? ctx.hood.front.get(0) : ctx.hood.front.get(q);
  if (!fronts || !fronts.length) return true;
  // Cheap test from the samples: same landmass as one of our front tiles with that owner means we walk there.
  return !fronts.some((f) => sameLandmass(ctx.state, f, t));
}

/** Two land tiles on the same landmass (connected by land), from the static component labels. */
function sameLandmass(state: GameState, a: number, b: number): boolean {
  return landmassOf(state, a) === landmassOf(state, b);
}
function landmassOf(state: GameState, t: number): number {
  return landComponents(state.map)[t];
}

// ---------------------------------------------------------------------------------------------------------------
// Air and missiles
// ---------------------------------------------------------------------------------------------------------------

/** Nations we are fighting (either direction). */
function foes(ctx: Ctx): number[] {
  const out = new Set<number>();
  for (const a of ctx.myAttacks) if (a.target > 0) out.add(a.target);
  for (const q of ctx.incoming.keys()) out.add(q);
  return [...out].filter((q) => ctx.state.players[q].alive && !areAllied(ctx.state, ctx.id, q) && !atPeace(ctx.state, ctx.id, q));
}

/** Most valuable enemy building to strike (kinds in priority order), avoiding SAM cover when careful. */
function strikeTarget(ctx: Ctx, kinds: BuildingType[], from: number): number {
  const { state } = ctx;
  const w = state.map.width;
  let best = -1;
  let bestScore = -Infinity;
  for (const q of foes(ctx)) {
    // SAMs knocked out by a barrage don't count (that is what barrages are for).
    const sams = ctx.diff.careful ? buildingsOf(state, q, 'sam').filter((b) => b.buildLeft <= 0 && !isDisabled(state, b)) : [];
    for (let k = 0; k < kinds.length; k++) {
      for (const b of buildingsOf(state, q, kinds[k])) {
        if (state.map.owner[b.tile] !== q) continue;
        let covered = 0;
        for (const s of sams) {
          const r = samRadius(s);
          if (dist2(w, s.tile, b.tile) <= r * r) covered += s.level;
        }
        const far = from >= 0 ? Math.sqrt(dist2(w, from, b.tile)) : 0;
        const s = (kinds.length - k) * 10 - covered * 12 - far * 0.03 + (b.type === 'city' ? b.level : 0);
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
    if (af.bombers + af.fighters < aircraftCap(af) - 1 && p.gold > c.gold + 1000 && p.oil >= c.oil && p.iron >= c.iron) {
      applyAction(state, id, { type: 'buildAircraft', airfield: af.tile, kind });
    }
    if (fighting.length && af.bombers > 0) {
      const t = strikeTarget(ctx, ['fort', 'factory', 'arsenal', 'airfield', 'city', 'barracks'], af.tile);
      if (t >= 0) applyAction(state, id, { type: 'bomb', airfield: af.tile, tile: t });
    }
    if (fighting.length) paradrop(ctx, af.tile, fighting);
  }

  if (!hasTech(p, 'rocketry')) return;
  for (const silo of buildingsOf(state, id, 'silo')) {
    if (silo.buildLeft > 0 || chargesReady(silo) < 1) continue;
    if (maybeNuke(ctx, silo.tile)) continue;
    const c = UNITS.rocket;
    if (!fighting.length || p.gold < c.gold + 600 || p.iron < c.iron || p.oil < c.oil) continue;
    const t = strikeTarget(ctx, ['silo', 'sam', 'fort', 'airfield', 'factory'], -1);
    if (t >= 0) applyAction(state, id, { type: 'launchMissile', silo: silo.tile, kind: 'rocket', tile: t });
  }
}

/**
 * Paratroopers, sometimes (40% of the air turns with a ready airfield): against a nation we fight and outnumber,
 * the best drop spot within the airfield's range: its capital, then its cities, then pockets 12-25 tiles behind its
 * front toward its capital (to cut them off). Careful AIs skip spots under SAM cover. Sends up to half the infantry
 * at home (keeping a fifth of the cap), at most the airfield's drop size.
 */
function paradrop(ctx: Ctx, airfield: number, fighting: number[]): void {
  const { state, p, id, diff } = ctx;
  const af = state.buildings.get(state.map.building[airfield] - 1);
  if (!af || af.buildLeft > 0 || af.dropCooldown > 0 || !hasTech(p, 'flight')) return;
  if (state.rng() > 0.4) return;
  const c = UNITS.transportPlane;
  if (p.gold < c.gold + 800 || p.oil < c.oil) return;
  const w = state.map.width;
  const owner = state.map.owner;
  const range = paradropRange(af);
  let best = -1;
  let bestScore = -Infinity;
  for (const q of fighting) {
    const qp = state.players[q];
    if (!qp?.alive || isTribe(qp)) continue;
    const strength = ctx.army / Math.max(1, estArmy(state, ctx.m, diff, id, q));
    if (strength < 1.1) continue;
    const sams = buildingsOf(state, q, 'sam').filter((s) => s.buildLeft <= 0 && !isDisabled(state, s));
    const spots: [number, number][] = [];
    if (qp.capital >= 0) spots.push([qp.capital, 3]);
    for (const b of buildingsOf(state, q, 'city').slice(0, 6)) spots.push([b.tile, 1.5 + b.level * 0.2]);
    if (qp.capital >= 0) {
      const fr = frontSamples(ctx, q);
      for (let k = 0; k < Math.min(4, fr.length); k++) {
        const e = fr[(ctx.ai.decisions + k * 7) % fr.length];
        const dx = (qp.capital % w) - (e % w);
        const dy = ((qp.capital / w) | 0) - ((e / w) | 0);
        const len = Math.sqrt(dx * dx + dy * dy);
        if (len < 1) continue;
        for (const depth of [12, 25]) {
          const f = Math.min(len, depth) / len;
          spots.push([Math.round(((e / w) | 0) + dy * f) * w + Math.round((e % w) + dx * f), 1 + depth / 25]);
        }
      }
    }
    for (const [t, value] of spots) {
      if (t < 0 || t >= owner.length || owner[t] !== q || dist2(w, airfield, t) > range * range) continue;
      let cover = 0;
      for (const s of sams) {
        const r = samRadius(s);
        if (dist2(w, s.tile, t) <= r * r) cover += chargesReady(s);
      }
      if (diff.careful && cover > 0) continue;
      const score = value + Math.min(strength, 4) * 0.5 - cover * 2;
      if (score > bestScore) {
        bestScore = score;
        best = t;
      }
    }
  }
  if (best < 0) return;
  const troops = Math.floor(Math.min(paradropMaxTroops(state, id, af), p.troops.infantry * 0.5, ctx.home - ctx.cap * 0.2));
  if (troops < PARADROP_MIN_TROOPS * 4 || !canParadrop(state, id, airfield, best, troops).ok) return;
  if (applyAction(state, id, { type: 'paradrop', airfield, tile: best, troops }).ok) ctx.home -= troops;
}

/**
 * Artillery barrages: knock out forts and SAM sites near our fronts before and during attacks (the nations we fight,
 * our main war target, and, once our troops near the war trigger, every non-tribe neighbour), SAMs first; with
 * plenty of artillery and nothing to silence, shell the main war front to thin the defenders.
 */
function barrage(ctx: Ctx): void {
  const { state, p, id, prof } = ctx;
  if (p.barrageReadyTick > state.tick || p.gold < BARRAGE_GOLD * 3) return;
  const guns = artilleryOf(state, id);
  if (guns < BARRAGE_MIN_ARTILLERY) return;
  const targets = new Set<number>(foes(ctx));
  const main = mainWarTarget(ctx);
  if (main > 0) targets.add(main);
  if (ctx.home / ctx.cap >= personal(id, 23, prof.trigger) * 0.85) {
    for (const q of ctx.enemies) if (!isTribe(state.players[q])) targets.add(q);
  }
  const w = state.map.width;
  const reach = barrageRange(p) + 6;
  let best = -1;
  let bestScore = -Infinity;
  for (const q of targets) {
    const edges = ctx.hood.edge.get(q) ?? EMPTY;
    if (!edges.length) continue;
    for (const type of ['sam', 'fort'] as const) {
      for (const b of buildingsOf(state, q, type)) {
        if (b.buildLeft > 0 || state.map.owner[b.tile] !== q) continue;
        if (b.disabledUntil - state.tick > 3 * TICKS_PER_SECOND) continue; // still silenced
        const score = (type === 'sam' ? 2 : 1) + b.level * 0.5 + (1 - b.hp);
        if (score <= bestScore) continue;
        let close = false;
        for (const e of edges) if (dist2(w, e, b.tile) <= reach * reach) close = true;
        if (!close || !canBarrage(state, id, b.tile).ok) continue;
        best = b.tile;
        bestScore = score;
      }
    }
  }
  if (best < 0 && main > 0 && guns >= BARRAGE_MIN_ARTILLERY * 4) {
    const fr = frontSamples(ctx, main);
    if (fr.length) {
      const t = fr[ctx.ai.decisions % fr.length];
      if (canBarrage(state, id, t).ok) best = t;
    }
  }
  if (best >= 0) applyAction(state, id, { type: 'barrage', tile: best });
}

/**
 * Atom bombs (normal/hard only), a last resort: when we have lost over half our land and the attack coming in
 * outnumbers our army at home, or against a nation about to win (within 15 points of the land share it needs).
 * Everyone will hate us for it, so only then, and never close to our own land.
 */
function maybeNuke(ctx: Ctx, silo: number): boolean {
  const { state, p, id, diff } = ctx;
  if (!diff.nukes || !unitAllowed(state, 'atomBomb') || !hasTech(p, 'nuclearFission') || state.tick < ctx.ai.nextNukeTick) return false;
  const c = UNITS.atomBomb;
  if (p.gold < c.gold || p.iron < c.iron || p.oil < c.oil) return false;
  let target = 0;
  if (p.tiles < ctx.ai.peakTiles * 0.5 && ctx.incomingTotal > ctx.home) {
    let most = 0;
    for (const [q, t] of ctx.incoming) {
      if (t > most) {
        most = t;
        target = q;
      }
    }
  }
  if (!target) {
    // A nation about to win that we border or fight.
    const nearWin = Math.max(0.45, victoryShareNow(state) - 0.15);
    for (const q of state.players) {
      if (q.id === 0 || q.id === id || !q.alive || isTribe(q) || areAllied(state, id, q.id)) continue;
      if (landShare(state, q.id) > nearWin && (ctx.neighbours.includes(q.id) || ctx.incoming.has(q.id))) target = q.id;
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
  if (!rulesAllowAlliances(state)) return;
  for (const r of state.allianceRequests.filter((x) => x.to === id)) {
    applyAction(state, id, { type: 'answerAlliance', from: r.from, accept: aiWantsAlliance(state, id, r.from) });
  }
}

/** Whole army of a player (home + attacks + transports), from the per-tick cache. */
function armyOf(state: GameState, id: number): number {
  const m = memory(state);
  refreshArmies(state, m);
  return m.army[id] ?? 0;
}

/**
 * Once no neutral land is left to take: the neighbour this AI wants to fight next (the weakest one relative to us
 * that we could beat; non-allied ones preferred), or 0. Alliances with that neighbour are not made or renewed
 * (warlords may even break one), otherwise a map of happy allies would never end.
 */
function nextTarget(state: GameState, ai: number): number {
  const me = state.players[ai];
  if (!me || !me.alive || me.isHuman) return 0;
  const hood = hoodOf(state, ai, 30);
  if ((hood.counts.get(0) ?? 0) > 0) return 0;
  const mine = armyOf(state, ai);
  const busy = memories.get(state)?.ais.get(ai)?.busyTick ?? state.tick;
  const idleMinutes = (state.tick - busy) / (60 * TICKS_PER_SECOND);
  let need = PROFILES[me.personality ?? 'balanced'].strengthNeeded * clamp(1 - idleMinutes * 0.1, 0.5, 1);
  // A full troop bar barely grows: its troops are free to use (same rule as warNeed).
  const cap = me.maxPop > 0 ? me.maxPop : troopCap(state, ai);
  if (cap > 0 && total(me.troops) > cap * 0.8) need *= 0.75;
  let best = 0;
  let bestScore = 0;
  for (const q of hood.counts.keys()) {
    if (q === 0 || q === ai || !state.players[q]?.alive) continue;
    const ratio = mine / Math.max(1, armyOf(state, q));
    if (ratio < need) continue;
    const s = ratio * (areAllied(state, ai, q) ? 1 : 1.5);
    if (s > bestScore) {
      bestScore = s;
      best = q;
    }
  }
  return best;
}

/** Whether AI `ai` accepts an alliance from `from` (opinion, threat, personality). */
export function aiWantsAlliance(state: GameState, ai: number, from: number): boolean {
  const me = state.players[ai];
  const them = state.players[from];
  if (!me || !them || ai === 0 || from === 0 || ai === from || !me.alive || !them.alive) return false;
  // Nobody trusts a traitor (not even a tribe: no ally-break-ally again for free).
  if (isTraitor(state, from)) return false;
  // Tribes take any friend they can get.
  if (isTribe(me)) return true;
  if (!alliancesAllowed(state, ai, from)) return false;
  // Never ally (or renew) with the last neighbour we could still fight: a nation boxed in by allies sits idle.
  if (lastOutlet(state, ai, from)) return false;
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
  // A human asking in the first minutes is a stranger: only real friends (opinion above) say yes, so allying with
  // every nation at once is not a free shield.
  if (them.isHuman && gameSeconds(state) < EARLY_ALLY_SECONDS) return false;
  // A common, stronger neighbour we both fear (the classic reason for non-neighbours to ally).
  const myArmy = armyOf(state, ai);
  const theirArmy = armyOf(state, from);
  const myHood = hoodOf(state, ai, 30);
  const theirHood = hoodOf(state, from, 30);
  const neighbours = (myHood.counts.get(from) ?? 0) > 0;
  for (const q of myHood.counts.keys()) {
    if (q === 0 || q === from || !state.players[q]?.alive || isTribe(state.players[q]) || areAllied(state, ai, q)) continue;
    const qa = armyOf(state, q);
    const fearMe = qa > myArmy * 1.2;
    const fearThem = (theirHood.counts.get(q) ?? 0) > 0 && qa > theirArmy * 1.2;
    if (fearMe && fearThem && (!neighbours || opinion > -10)) return true;
  }
  // Under heavy attack by someone else: any friend not disliked is welcome.
  for (const a of state.attacks) {
    if (a.target === ai && a.attacker !== from && opinion > -15 && total(a.troops) > total(me.troops) * 0.5) return true;
  }
  // Timid nations (low bar) welcome a stronger neighbour or a distant friend.
  return prof.allyOpinion <= 15 && opinion >= 0 && (!neighbours || theirArmy > myArmy);
}

/**
 * Alliances must not freeze the end of a game: when only two nations are left they can't ally, and in overtime
 * nobody allies with (or renews with) the nation holding the most land.
 */
function alliancesAllowed(state: GameState, a: number, b: number): boolean {
  let nations = 0;
  let leader = 0;
  for (const p of state.players) {
    if (p.id === 0 || !p.alive || isTribe(p)) continue;
    nations++;
    if (!leader || p.tiles > state.players[leader].tiles) leader = p.id;
  }
  if (nations <= 2 && !isTribe(state.players[a]) && !isTribe(state.players[b])) return false;
  if (inOvertime(state) && (a === leader || b === leader)) return false;
  return true;
}

/**
 * True when `from` is a land neighbour of `ai` and, with no neutral land left to take, every other neighbour of
 * `ai` is already allied: allying with `from` would leave `ai` nobody to grow into but by sea.
 */
function lastOutlet(state: GameState, ai: number, from: number): boolean {
  const hood = hoodOf(state, ai, 30);
  if ((hood.counts.get(0) ?? 0) > 0 || (hood.counts.get(from) ?? 0) <= 0) return false;
  for (const q of hood.counts.keys()) {
    if (q === 0 || q === ai || q === from || !state.players[q]?.alive) continue;
    if (!areAllied(state, ai, q)) return false;
  }
  return true;
}

/** Seconds before an AI proposes an alliance to the same nation again. */
const PROPOSAL_COOLDOWN_S = 180;

function diplomacy(ctx: Ctx): void {
  const { state, p, prof, id } = ctx;
  if (!rulesAllowAlliances(state)) {
    ctx.ai.nextDiploTick = state.tick + 60 * TICKS_PER_SECOND;
    return;
  }
  const merchant = p.personality === 'merchant';
  ctx.ai.nextDiploTick = state.tick + Math.round((merchant ? 15 : 30) * TICKS_PER_SECOND * (0.75 + state.rng() * 0.5));

  // Renew alliances that are about to expire while we still like them (and don't need them as a target).
  const drop = nextTarget(state, id);
  for (const al of state.alliances) {
    if (al.a !== id && al.b !== id) continue;
    const other = al.a === id ? al.b : al.a;
    if (
      other !== drop &&
      al.expiresTick - state.tick < 50 * TICKS_PER_SECOND &&
      state.opinion[id][other] > -20 &&
      alliancesAllowed(state, id, other) &&
      !lastOutlet(state, id, other)
    ) {
      applyAction(state, id, { type: 'requestAlliance', to: other });
    }
  }

  // Propose to a feared strong neighbour, or to a distant nation facing the same threat (merchants: anyone friendly).
  const pending = new Set(state.allianceRequests.filter((r) => r.from === id).map((r) => r.to));
  let candidate = 0;
  let bestScore = 0;
  const threatHood = ctx.threatId > 0 ? hoodOf(state, ctx.threatId, 30) : null;
  for (const q of state.players) {
    if (q.id === 0 || q.id === id || !q.alive || isTribe(q) || pending.has(q.id) || ctx.allies.includes(q.id)) continue;
    const neighbour = ctx.neighbours.includes(q.id);
    const sharesThreat = !!threatHood && (threatHood.counts.get(q.id) ?? 0) > 0;
    // Only neighbours, nations facing the same threat, or (merchants) anyone are worth a look.
    if (!neighbour && !sharesThreat && !merchant) continue;
    if (isTraitor(state, q.id) || ctx.incoming.has(q.id) || ctx.myAttacks.some((a) => a.target === q.id) || q.id === drop) continue;
    if (!alliancesAllowed(state, id, q.id) || lastOutlet(state, id, q.id)) continue;
    // Don't ask the same nation again for a while (a human would see the same request every 30 s).
    const asked = ctx.ai.proposedTick.get(q.id);
    if (asked !== undefined && state.tick - asked < PROPOSAL_COOLDOWN_S * TICKS_PER_SECOND) continue;
    const op = state.opinion[id][q.id];
    if (op < -20) continue;
    const ratio = ctx.m.army[q.id] / ctx.army;
    let s = 0;
    if (neighbour && ratio > 1.3) s = ratio + (1 - prof.aggression);
    else if (!neighbour && sharesThreat) s = 1.5;
    else if (merchant && op >= 0) s = 0.8;
    if (s <= 0) continue;
    s += op / 100;
    if (s > bestScore) {
      bestScore = s;
      candidate = q.id;
    }
  }
  if (candidate && bestScore > 0.6 && ctx.allies.filter((a) => !isTribe(state.players[a])).length < 3) {
    ctx.ai.proposedTick.set(candidate, state.tick);
    applyAction(state, id, { type: 'requestAlliance', to: candidate });
  }

  // Warlords may betray a much weaker neighbouring ally when it is the only way left to grow (rarely: everyone
  // will distrust them and they defend worse for a while).
  if (p.personality === 'warlord' && drop > 0 && ctx.allies.includes(drop) && ctx.m.army[drop] < ctx.army * 0.4 && state.rng() < 0.25) {
    applyAction(state, id, { type: 'breakAlliance', with: drop });
  }

  // A rare gift: rich merchants sweeten a feared neighbour.
  if (merchant && p.gold > 6000 && ctx.threatId > 0 && state.opinion[id][ctx.threatId] > -40 && state.rng() < 0.3) {
    applyAction(state, id, { type: 'gift', to: ctx.threatId, gold: 500, troops: 0 });
  }
}
