// Game setup: the one options model shared by single player, the setup screen, the multiplayer lobby and the server.
// Defaults, presets, validation (strict for the server, lenient for saved settings), and plain-word labels for the
// modifiers. Pure data and functions: no DOM, no state; rules.ts enforces the modifiers during a game.
import { COMPACT_SCALE, DEFAULT_TRIBE_COUNT, MAX_AI_COUNT, MAX_TRIBE_COUNT, START_GOLD, VICTORY_LAND_SHARE } from './config';
import { generatedDims } from './mapgen';
import { getWorldMap, listWorldMaps } from './worldmaps';

export { COMPACT_SCALE, generatedDims };
import type {
  BuildSpeed,
  Difficulty,
  GameMode,
  GameSettings,
  GameSetup,
  HumanSeat,
  MapChoice,
  MapSize,
  MapType,
  Modifiers,
  PresetId,
  ResearchRule,
  StartingGold,
} from './types';

// ------------------------------------------------------------------------------------------------ option values

export const MAP_TYPE_LIST: readonly MapType[] = ['continents', 'pangaea', 'archipelago', 'highlands'];
export const MAP_SIZE_LIST: readonly MapSize[] = ['small', 'medium', 'large', 'huge'];
export const DIFFICULTY_LIST: readonly Difficulty[] = ['easy', 'normal', 'hard'];
export const MODE_LIST: readonly GameMode[] = ['ffa', 'teams'];
export const MIN_TEAMS = 2;
export const MAX_TEAMS = 6;
export const PEACE_MINUTES: readonly number[] = [0, 2, 4, 6];
export const GOLD_MULTIPLIERS: readonly number[] = [0.5, 1, 1.5, 2, 3];
export const GROWTH_MULTIPLIERS: readonly number[] = [0.5, 1, 1.5, 2];
export const TIME_LIMIT_MINUTES: readonly number[] = [0, 15, 30, 60];
export const VICTORY_SHARES: readonly number[] = [0.6, 0.7, 0.75, 0.8, 0.9];
export const STARTING_GOLD_LIST: readonly StartingGold[] = ['normal', 'high', 'veryHigh'];
export const BUILD_SPEED_LIST: readonly BuildSpeed[] = ['normal', 'fast', 'instant'];
export const RESEARCH_LIST: readonly ResearchRule[] = ['normal', 'allUnlocked', 'off'];
export const PRESET_LIST: readonly PresetId[] = ['classic', 'quickConquest', 'grandWar', 'islandHopping', 'chaos', 'custom'];

/** Gold every nation starts with. */
export const STARTING_GOLD: Record<StartingGold, number> = { normal: START_GOLD, high: 5000, veryHigh: 20000 };
/** Construction and upgrade time x this ('instant' = done on the next tick). */
export const BUILD_TIME_FACTOR: Record<BuildSpeed, number> = { normal: 1, fast: 1 / 3, instant: 0 };
/** Fast game: income, troop growth, construction, research and front speed x this. */
export const FAST_GAME_FACTOR = 2;
/** Default single-player nations (AI) and multiplayer nations (humans + AI). */
export const SINGLE_PLAYER_NATIONS = 8;
export const MULTIPLAYER_NATIONS = 10;
/** Typical land tiles of a generated map per size (all four types averaged), for defaults before the map exists. */
export const GENERATED_LAND: Record<MapSize, number> = { small: 235_000, medium: 580_000, large: 1_150_000, huge: 1_910_000 };

export const DEFAULT_MODIFIERS: Modifiers = {
  randomSpawn: false,
  compactMap: false,
  peaceMinutes: 0,
  startingGold: 'normal',
  goldMultiplier: 1,
  troopGrowth: 1,
  buildSpeed: 'normal',
  noAlliances: false,
  noNukes: false,
  noAir: false,
  noNavy: false,
  noSams: false,
  research: 'normal',
  fastGame: false,
};

/** Single-player defaults ('Classic'). */
export const DEFAULT_SETUP: GameSetup = {
  map: { kind: 'generated', type: 'continents', size: 'medium' },
  aiCount: SINGLE_PLAYER_NATIONS,
  tribeCount: -1,
  difficulty: 'normal',
  mode: 'ffa',
  teamCount: 2,
  timeLimit: 0,
  victoryLandShare: VICTORY_LAND_SHARE,
  modifiers: { ...DEFAULT_MODIFIERS },
  preset: 'classic',
};

export function cloneSetup<T extends GameSetup>(s: T): T {
  return { ...s, map: { ...s.map }, modifiers: { ...s.modifiers } };
}

// ------------------------------------------------------------------------------------------------ map helpers

/**
 * Size class for an amount of land (world maps, compact maps): small < 400k, medium < 850k, large < 1.6M land tiles,
 * else huge (the generated sizes give about 235k / 580k / 1.15M / 1.9M).
 */
export function sizeClassForLand(land: number): MapSize {
  if (land < 400_000) return 'small';
  if (land < 850_000) return 'medium';
  if (land < 1_600_000) return 'large';
  return 'huge';
}

/** Land tiles a map choice will have (generated: typical for the size; compact: a quarter). */
export function landEstimate(map: MapChoice, compact: boolean): number {
  let land: number;
  if (map.kind === 'world') land = getWorldMap(map.id)?.landTiles ?? GENERATED_LAND.medium;
  else land = GENERATED_LAND[map.size] ?? GENERATED_LAND.medium;
  return compact ? Math.round(land * COMPACT_SCALE * COMPACT_SCALE) : land;
}

/**
 * Default tribes for a map: by the size class of its land (small 120, medium 200, large and huge 300); real-world
 * maps 300; compact maps by their quarter of the land.
 */
export function defaultTribeCount(map: MapChoice, compact: boolean, land?: number): number {
  if (map.kind === 'world' && !compact) return DEFAULT_TRIBE_COUNT.huge;
  return DEFAULT_TRIBE_COUNT[sizeClassForLand(land ?? landEstimate(map, compact))];
}

/** Tribes in a game: setup.tribeCount when >= 0 (at most MAX_TRIBE_COUNT), else the map's default. */
export function tribesFor(setup: Pick<GameSetup, 'tribeCount' | 'map' | 'modifiers'>, land?: number): number {
  const n = setup.tribeCount;
  if (typeof n === 'number' && Number.isFinite(n) && n >= 0) return Math.min(MAX_TRIBE_COUNT, Math.floor(n));
  return defaultTribeCount(setup.map, !!setup.modifiers?.compactMap, land);
}

/**
 * Default AI nations: single player SINGLE_PLAYER_NATIONS; multiplayer MULTIPLAYER_NATIONS nations in all, humans
 * included.
 */
export function defaultAiCount(multiplayer = false, humans = 1): number {
  return multiplayer ? Math.max(0, MULTIPLAYER_NATIONS - humans) : SINGLE_PLAYER_NATIONS;
}

const TYPE_NAME: Record<MapType, string> = { continents: 'Continents', pangaea: 'Pangaea', archipelago: 'Archipelago', highlands: 'Highlands' };
const SIZE_NAME: Record<MapSize, string> = { small: 'Small', medium: 'Medium', large: 'Large', huge: 'Huge' };
export function mapTypeName(t: MapType): string {
  return TYPE_NAME[t] ?? t;
}
export function mapSizeName(s: MapSize): string {
  return SIZE_NAME[s] ?? s;
}
/** "Continents, medium" or "Europe". */
export function mapLabel(map: MapChoice): string {
  if (map.kind === 'world') return getWorldMap(map.id)?.name ?? map.id;
  return `${mapTypeName(map.type)}, ${mapSizeName(map.size).toLowerCase()}`;
}

// ------------------------------------------------------------------------------------------------ validation

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const oneOf = <T>(list: readonly T[], v: unknown): v is T => list.includes(v as T);

/** Checks a map choice; returns an error or null. */
export function mapError(v: unknown): string | null {
  if (!isObj(v)) return 'map must be an object';
  if (v.kind === 'generated') {
    for (const k of Object.keys(v)) if (k !== 'kind' && k !== 'type' && k !== 'size') return `map: unknown field '${k}'`;
    if (!oneOf(MAP_TYPE_LIST, v.type)) return 'map: bad type';
    if (!oneOf(MAP_SIZE_LIST, v.size)) return 'map: bad size';
    return null;
  }
  if (v.kind === 'world') {
    for (const k of Object.keys(v)) if (k !== 'kind' && k !== 'id') return `map: unknown field '${k}'`;
    if (typeof v.id !== 'string' || !getWorldMap(v.id)) return 'map: unknown world map';
    return null;
  }
  return 'map: kind must be generated or world';
}

type ModKey = keyof Modifiers;
const BOOL_MODS: readonly ModKey[] = ['randomSpawn', 'compactMap', 'noAlliances', 'noNukes', 'noAir', 'noNavy', 'noSams', 'fastGame'];

/** Checks one modifier value; returns an error or null. */
function modError(k: string, x: unknown): string | null {
  switch (k as ModKey) {
    case 'peaceMinutes':
      return oneOf(PEACE_MINUTES, x) ? null : 'peaceMinutes must be 0, 2, 4 or 6';
    case 'startingGold':
      return oneOf(STARTING_GOLD_LIST, x) ? null : 'bad startingGold';
    case 'goldMultiplier':
      return oneOf(GOLD_MULTIPLIERS, x) ? null : 'bad goldMultiplier';
    case 'troopGrowth':
      return oneOf(GROWTH_MULTIPLIERS, x) ? null : 'bad troopGrowth';
    case 'buildSpeed':
      return oneOf(BUILD_SPEED_LIST, x) ? null : 'bad buildSpeed';
    case 'research':
      return oneOf(RESEARCH_LIST, x) ? null : 'bad research';
    default:
      if (BOOL_MODS.includes(k as ModKey)) return typeof x === 'boolean' ? null : `${k} must be true or false`;
      return `unknown modifier '${k}'`;
  }
}

/** Limits for the plain number fields (inclusive). */
export const SETUP_LIMITS = {
  aiCount: [0, MAX_AI_COUNT] as const,
  tribeCount: [-1, MAX_TRIBE_COUNT] as const,
  teamCount: [MIN_TEAMS, MAX_TEAMS] as const,
};

/**
 * Strict check of a (partial) setup, as the server does it: every given field must be valid, unknown fields are an
 * error; `modifiers` may be partial. Returns the first error, or null.
 */
export function validateSetup(v: unknown, partial = true): string | null {
  if (!isObj(v)) return 'settings must be an object';
  const required: (keyof GameSetup)[] = ['map', 'aiCount', 'tribeCount', 'difficulty', 'mode', 'teamCount', 'timeLimit', 'victoryLandShare', 'modifiers', 'preset'];
  if (!partial) for (const k of required) if (!(k in v)) return `missing ${k}`;
  for (const [k, x] of Object.entries(v)) {
    switch (k) {
      case 'map': {
        const e = mapError(x);
        if (e) return e;
        break;
      }
      case 'aiCount':
      case 'tribeCount':
      case 'teamCount': {
        const [lo, hi] = SETUP_LIMITS[k];
        if (typeof x !== 'number' || !Number.isInteger(x) || x < lo || x > hi) return `${k} must be a whole number ${lo}..${hi}`;
        break;
      }
      case 'difficulty':
        if (!oneOf(DIFFICULTY_LIST, x)) return 'bad difficulty';
        break;
      case 'mode':
        if (!oneOf(MODE_LIST, x)) return 'bad mode';
        break;
      case 'timeLimit':
        if (typeof x !== 'number' || !TIME_LIMIT_MINUTES.includes(x / 60)) return 'timeLimit must be 0, 15, 30 or 60 minutes (in seconds)';
        break;
      case 'victoryLandShare':
        if (!oneOf(VICTORY_SHARES, x)) return 'victoryLandShare must be 0.6, 0.7, 0.75, 0.8 or 0.9';
        break;
      case 'preset':
        if (!oneOf(PRESET_LIST, x)) return 'bad preset';
        break;
      case 'modifiers': {
        if (!isObj(x)) return 'modifiers must be an object';
        for (const [mk, mx] of Object.entries(x)) {
          const e = modError(mk, mx);
          if (e) return e;
        }
        if (!partial) for (const mk of Object.keys(DEFAULT_MODIFIERS)) if (!(mk in x)) return `missing modifier ${mk}`;
        break;
      }
      default:
        return `unknown setting '${k}'`;
    }
  }
  return null;
}

/** A partial setup: any fields; `modifiers` may hold only the ones that change. */
export type SetupPatch = Partial<Omit<GameSetup, 'modifiers'>> & { modifiers?: Partial<Modifiers> };

/** Merges a validated partial setup into a full one (modifiers merge field by field; extra fields such as a lobby's maxPlayers are copied too). */
export function mergeSetup<T extends GameSetup>(base: T, patch: SetupPatch & Record<string, unknown>): T {
  const out = cloneSetup(base);
  for (const [k, x] of Object.entries(patch) as [keyof GameSetup, unknown][]) {
    if (x === undefined) continue;
    if (k === 'modifiers') out.modifiers = { ...out.modifiers, ...(x as Partial<Modifiers>) };
    else if (k === 'map') out.map = { ...(x as MapChoice) };
    else (out as Record<string, unknown>)[k] = x;
  }
  return out;
}

/**
 * Lenient: turns anything (saved settings, an old format) into a valid full setup, keeping every valid field and
 * using the defaults for the rest.
 */
export function sanitizeSetup(v: unknown, base: GameSetup = DEFAULT_SETUP): GameSetup {
  const out = cloneSetup(base);
  if (!isObj(v)) return out;
  if (!mapError(v.map)) out.map = { ...(v.map as MapChoice) };
  for (const k of ['aiCount', 'tribeCount', 'teamCount'] as const) {
    const x = v[k];
    const [lo, hi] = SETUP_LIMITS[k];
    if (typeof x === 'number' && Number.isFinite(x)) out[k] = Math.max(lo, Math.min(hi, Math.round(x)));
  }
  if (oneOf(DIFFICULTY_LIST, v.difficulty)) out.difficulty = v.difficulty;
  if (oneOf(MODE_LIST, v.mode)) out.mode = v.mode;
  if (typeof v.timeLimit === 'number' && TIME_LIMIT_MINUTES.includes(v.timeLimit / 60)) out.timeLimit = v.timeLimit;
  if (oneOf(VICTORY_SHARES, v.victoryLandShare)) out.victoryLandShare = v.victoryLandShare;
  if (oneOf(PRESET_LIST, v.preset)) out.preset = v.preset;
  if (isObj(v.modifiers)) {
    for (const [mk, mx] of Object.entries(v.modifiers)) {
      if (!modError(mk, mx)) (out.modifiers as unknown as Record<string, unknown>)[mk] = mx;
    }
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ presets

export interface PresetInfo {
  id: PresetId;
  name: string;
  /** one plain line for the chip's tooltip */
  description: string;
}

export const PRESETS: readonly PresetInfo[] = [
  { id: 'classic', name: 'Classic', description: 'The standard rules: a medium map, 8 nations and lots of tribes.' },
  { id: 'quickConquest', name: 'Quick Conquest', description: 'A small map packed with tribes, everything twice as fast: about 15 to 25 minutes.' },
  { id: 'grandWar', name: 'Grand War', description: 'The whole world with 20 nations and a long war.' },
  { id: 'islandHopping', name: 'Island Hopping', description: 'An archipelago: wars by sea, no air force.' },
  { id: 'chaos', name: 'Chaos', description: 'Two to four random modifiers. Pick it again for another roll.' },
  { id: 'custom', name: 'Custom', description: 'Your own mix of settings.' },
];

/** A fixed roll (no Math.random in src/sim): the setup screen passes Math.random to re-roll Chaos. */
function fixedRoll(): () => number {
  let s = 0x2545f491;
  return () => {
    s = (Math.imul(s, 1103515245) + 12345) >>> 0;
    return s / 4294967296;
  };
}

/** Modifiers Chaos draws from (2-4 of them): each entry sets one or two fields. */
const CHAOS_POOL: readonly Partial<Modifiers>[] = [
  { randomSpawn: true },
  { compactMap: true },
  { peaceMinutes: 4 },
  { startingGold: 'veryHigh' },
  { goldMultiplier: 3 },
  { troopGrowth: 2 },
  { buildSpeed: 'instant' },
  { noAlliances: true },
  { noNukes: true },
  { noAir: true },
  { noNavy: true },
  { noSams: true },
  { research: 'allUnlocked' },
  { fastGame: true },
  { goldMultiplier: 0.5 },
];

/**
 * `n` different random modifiers from the Chaos pool (`rand` returns 0..1): Chaos rolls 2-4, the server's "Special"
 * public lobbies 1-3. Returns only the changed fields.
 */
export function rollModifiers(n: number, rand: () => number): Partial<Modifiers> {
  const pool = CHAOS_POOL.slice();
  const mods: Partial<Modifiers> = {};
  for (let k = 0; k < n && pool.length; k++) {
    const j = Math.min(pool.length - 1, Math.floor(rand() * pool.length));
    const pick = pool.splice(j, 1)[0];
    // Opposite picks on one field (x3 and x0.5 gold): the later one is skipped.
    if (Object.keys(pick).some((f) => f in mods)) {
      k--;
      continue;
    }
    Object.assign(mods, pick);
  }
  return mods;
}

/**
 * The setup of a preset. Keeps what isn't part of a preset (difficulty, mode, teams). `rand` (0..1) is only used by
 * Chaos; the result is a plain setup, so a multiplayer lobby sends the rolled values, never the roll itself.
 */
export function applyPreset(id: PresetId, base: GameSetup, rand: () => number = fixedRoll()): GameSetup {
  const keep = { difficulty: base.difficulty, mode: base.mode, teamCount: base.teamCount };
  const fresh = (over: Partial<GameSetup>, mods: Partial<Modifiers> = {}): GameSetup => ({
    ...cloneSetup(DEFAULT_SETUP),
    ...keep,
    ...over,
    modifiers: { ...DEFAULT_MODIFIERS, ...mods },
    preset: id,
  });
  switch (id) {
    case 'classic':
      return fresh({});
    case 'quickConquest':
      return fresh({ map: { kind: 'generated', type: 'continents', size: 'small' }, aiCount: 4, tribeCount: 220 }, { fastGame: true });
    case 'grandWar':
      return fresh({ map: { kind: 'world', id: listWorldMaps().some((m) => m.id === 'world') ? 'world' : listWorldMaps()[0].id }, aiCount: 20, tribeCount: 300 });
    case 'islandHopping':
      return fresh({ map: { kind: 'generated', type: 'archipelago', size: 'medium' } }, { noAir: true });
    case 'chaos': {
      const n = 2 + Math.min(2, Math.floor(rand() * 3));
      return fresh({ map: { ...base.map }, aiCount: base.aiCount, tribeCount: base.tribeCount }, rollModifiers(n, rand));
    }
    default:
      return { ...cloneSetup(base), preset: 'custom' };
  }
}

/** Which named preset a setup matches exactly (difficulty, mode and teams aside), else 'custom'. */
export function matchPreset(s: GameSetup): PresetId {
  for (const id of ['classic', 'quickConquest', 'grandWar', 'islandHopping'] as const) {
    const p = applyPreset(id, s);
    if (sameSetup(p, s)) return id;
  }
  return 'custom';
}

function sameSetup(a: GameSetup, b: GameSetup): boolean {
  if (JSON.stringify(a.map) !== JSON.stringify(b.map)) return false;
  if (a.aiCount !== b.aiCount || a.tribeCount !== b.tribeCount || a.timeLimit !== b.timeLimit || a.victoryLandShare !== b.victoryLandShare) return false;
  for (const k of Object.keys(DEFAULT_MODIFIERS) as ModKey[]) if (a.modifiers[k] !== b.modifiers[k]) return false;
  return true;
}

// ------------------------------------------------------------------------------------------------ labels

export interface ModifierLabel {
  /** stable id (the modifier key, or 'timeLimit' / 'victory' / 'teams') */
  id: string;
  /** short chip text, e.g. "Peace 4 min" */
  label: string;
  /** one plain sentence: what it does */
  detail: string;
  group: 'economy' | 'combat' | 'rules';
}

const MULT = (x: number): string => `×${x}`;

/** Plain-word description of every modifier and rule that differs from the defaults (chips, summary line). */
export function activeModifiers(s: Pick<GameSetup, 'modifiers' | 'timeLimit' | 'victoryLandShare' | 'mode' | 'teamCount'>): ModifierLabel[] {
  const m = s.modifiers;
  const out: ModifierLabel[] = [];
  if (s.mode === 'teams') out.push({ id: 'teams', label: `${s.teamCount} teams`, detail: 'Teammates are allied for the whole game, cannot attack each other and win together.', group: 'rules' });
  if (m.startingGold !== 'normal') out.push({ id: 'startingGold', label: m.startingGold === 'high' ? 'Rich start' : 'Very rich start', detail: `Every nation starts with ${STARTING_GOLD[m.startingGold].toLocaleString('en-US')} gold.`, group: 'economy' });
  if (m.goldMultiplier !== 1) out.push({ id: 'goldMultiplier', label: `Gold ${MULT(m.goldMultiplier)}`, detail: `Gold income ${MULT(m.goldMultiplier)}.`, group: 'economy' });
  if (m.troopGrowth !== 1) out.push({ id: 'troopGrowth', label: `Growth ${MULT(m.troopGrowth)}`, detail: `Troops regrow ${MULT(m.troopGrowth)} as fast.`, group: 'economy' });
  if (m.buildSpeed !== 'normal') out.push({ id: 'buildSpeed', label: m.buildSpeed === 'fast' ? 'Fast building' : 'Instant building', detail: m.buildSpeed === 'fast' ? 'Buildings and upgrades finish three times as fast.' : 'Buildings and upgrades finish at once.', group: 'economy' });
  if (m.research !== 'normal') out.push({ id: 'research', label: m.research === 'allUnlocked' ? 'All techs' : 'No research', detail: m.research === 'allUnlocked' ? 'Every nation starts with every technology.' : 'Nobody can research: buildings and weapons that need a technology stay locked.', group: 'economy' });
  if (m.peaceMinutes > 0) out.push({ id: 'peaceMinutes', label: `Peace ${m.peaceMinutes} min`, detail: `Nations cannot attack each other for the first ${m.peaceMinutes} minutes. Tribes can be attacked.`, group: 'combat' });
  if (m.noNukes) out.push({ id: 'noNukes', label: 'No atom bombs', detail: 'Silos launch rockets only.', group: 'combat' });
  if (m.noAir) out.push({ id: 'noAir', label: 'No air force', detail: 'No airfields, bombers, fighters or paratroopers.', group: 'combat' });
  if (m.noNavy) out.push({ id: 'noNavy', label: 'No warships', detail: 'No warships. Transports and trade ships still sail.', group: 'combat' });
  if (m.noSams) out.push({ id: 'noSams', label: 'No SAM sites', detail: 'Nothing shoots down bombers or missiles but fighters.', group: 'combat' });
  if (m.randomSpawn) out.push({ id: 'randomSpawn', label: 'Random starts', detail: 'Every start is picked at random, yours too.', group: 'rules' });
  if (m.compactMap) out.push({ id: 'compactMap', label: 'Compact map', detail: 'A half-size map: a quarter of the land and fewer tribes.', group: 'rules' });
  if (m.noAlliances) out.push({ id: 'noAlliances', label: 'No alliances', detail: 'Nobody can form alliances.', group: 'rules' });
  if (m.fastGame) out.push({ id: 'fastGame', label: 'Fast game', detail: 'Income, troop growth, building, research and fronts run twice as fast.', group: 'rules' });
  if (s.timeLimit > 0) out.push({ id: 'timeLimit', label: `${Math.round(s.timeLimit / 60)} min limit`, detail: `After ${Math.round(s.timeLimit / 60)} minutes the highest score wins.`, group: 'rules' });
  if (s.victoryLandShare !== VICTORY_LAND_SHARE) out.push({ id: 'victory', label: `Win at ${Math.round(s.victoryLandShare * 100)}%`, detail: `Holding ${Math.round(s.victoryLandShare * 100)}% of the land wins.`, group: 'rules' });
  return out;
}

/** One line: "Standard rules" or the active modifiers' labels joined with commas. */
export function modifierSummary(s: Parameters<typeof activeModifiers>[0]): string {
  const a = activeModifiers(s);
  return a.length ? a.map((x) => x.label).join(', ') : 'Standard rules';
}

// ------------------------------------------------------------------------------------------------ humans and teams

/**
 * The human seats of a game, ids 1..H in this order: `settings.humans` when given and not empty (multiplayer), else
 * one seat from playerName / playerColor when humanPlayer is true (single player), else none (AI-only games).
 */
export function humanSeats(settings: Pick<GameSettings, 'humans' | 'humanPlayer' | 'playerName' | 'playerColor'>): HumanSeat[] {
  if (Array.isArray(settings.humans) && settings.humans.length > 0) return settings.humans;
  if (!settings.humanPlayer) return [];
  return [{ name: settings.playerName || 'You', color: settings.playerColor, team: 0 }];
}

/**
 * Teams of a teams game: humans keep a valid chosen team (1..teamCount), 'auto' humans (0) go to the smallest team,
 * then every AI nation goes to the team with the fewest members (ties: the lowest team). Returns byPlayer[playerId]
 * for ids 0..H+aiCount (index 0 = 0). With every human on auto this is round-robin by id (id 1 on team 1).
 * Deterministic; the server uses it for the lobby and createGame for games built without explicit teams.
 */
export function assignTeams(chosen: readonly number[], aiCount: number, teamCount: number): number[] {
  const size = new Array<number>(teamCount + 1).fill(0);
  const byPlayer = [0];
  const smallest = (): number => {
    let best = 1;
    for (let t = 2; t <= teamCount; t++) if (size[t] < size[best]) best = t;
    return best;
  };
  const humans = chosen.map((t) => (Number.isInteger(t) && t >= 1 && t <= teamCount ? t : 0));
  for (const t of humans) if (t > 0) size[t]++;
  for (const t of humans) {
    if (t > 0) byPlayer.push(t);
    else {
      const s = smallest();
      size[s]++;
      byPlayer.push(s);
    }
  }
  for (let k = 0; k < aiCount; k++) {
    const s = smallest();
    size[s]++;
    byPlayer.push(s);
  }
  return byPlayer;
}
