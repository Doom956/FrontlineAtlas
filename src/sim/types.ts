// Shared types for the whole game. The simulation (src/sim) and the client (src/client) both depend on this file.
// Keep syntax erasable: no enums or namespaces.

export const Terrain = {
  DeepWater: 0,
  ShallowWater: 1,
  Plains: 2,
  Forest: 3,
  Hills: 4,
  Mountains: 5,
  Desert: 6,
  Swamp: 7,
  Tundra: 8,
} as const;
export type TerrainId = (typeof Terrain)[keyof typeof Terrain];
export const LAND_TERRAINS: readonly TerrainId[] = [2, 3, 4, 5, 6, 7, 8];
export function isWater(t: number): boolean {
  return t <= 1;
}

export const Resource = { None: 0, Iron: 1, Oil: 2, Fertile: 3 } as const;
export type ResourceId = (typeof Resource)[keyof typeof Resource];

export type TroopType = 'infantry' | 'armor' | 'artillery';
export const TROOP_TYPES: readonly TroopType[] = ['infantry', 'armor', 'artillery'];
export interface Troops {
  infantry: number;
  armor: number;
  artillery: number;
}

/** True for the small filler AI tribes (Personality 'tribe'): they never count for 'last nation standing'. */
export function isTribe(p: { personality: Personality | null } | null | undefined): boolean {
  return !!p && p.personality === 'tribe';
}

export type BuildingType =
  | 'city'
  | 'farm'
  | 'market'
  | 'mine'
  | 'oilWell'
  | 'barracks'
  | 'factory'
  | 'arsenal'
  | 'fort'
  | 'supplyDepot'
  | 'watchtower'
  | 'port'
  | 'lab'
  | 'hospital'
  | 'airfield'
  | 'sam'
  | 'silo';

export type TechId =
  | 'agriculture'
  | 'metallurgy'
  | 'logistics'
  | 'fortification'
  | 'navigation'
  | 'banking'
  | 'medicine'
  | 'mechanization'
  | 'ballistics'
  | 'flight'
  | 'industrialization'
  | 'combinedArms'
  | 'radar'
  | 'rocketry'
  | 'nuclearFission';

export type UnitType =
  | 'transport'
  | 'warship'
  | 'tradeShip'
  | 'bomber'
  | 'fighter'
  | 'rocket'
  | 'atomBomb'
  /** cargo plane carrying paratroopers from an airfield to a drop tile (Action 'paradrop') */
  | 'transportPlane';

export type MapType = 'continents' | 'pangaea' | 'archipelago' | 'highlands';
export type MapSize = 'small' | 'medium' | 'large' | 'huge';
export type Difficulty = 'easy' | 'normal' | 'hard' | 'brutal';
export type Personality = 'warlord' | 'turtle' | 'merchant' | 'admiral' | 'balanced' | 'tribe';

export type GameMode = 'ffa' | 'teams';
/** Which map a game is played on: a procedural one, or a real-world map from src/sim/worldmaps.ts (by id). */
export type MapChoice = { kind: 'generated'; type: MapType; size: MapSize } | { kind: 'world'; id: string };
export type StartingGold = 'normal' | 'high' | 'veryHigh';
export type BuildSpeed = 'normal' | 'fast' | 'instant';
/** 'allUnlocked' = every tech from the start, 'off' = no research at all. */
export type ResearchRule = 'normal' | 'allUnlocked' | 'off';
/** Setup presets (setup.ts PRESETS); 'custom' = anything else. Only a label: the setup's fields are what counts. */
export type PresetId = 'classic' | 'quickConquest' | 'grandWar' | 'islandHopping' | 'chaos' | 'custom';

/**
 * Game modifiers, chosen before the start (setup.ts: defaults, presets, validation, labels). The sim enforces every
 * one of them (rules.ts) and the AI respects them. All deterministic.
 */
export interface Modifiers {
  /** every start (the human's too) is picked at random; world-map nations ignore their real capitals */
  randomSpawn: boolean;
  /** a half-size map (a quarter of the land) and, by default, fewer tribes */
  compactMap: boolean;
  /** minutes after the start in which nations / players can't attack each other (tribes can be attacked): 0, 2, 4, 6 */
  peaceMinutes: number;
  startingGold: StartingGold;
  /** gold income x this (0.5 .. 3) */
  goldMultiplier: number;
  /** troop growth x this (0.5 .. 2) */
  troopGrowth: number;
  buildSpeed: BuildSpeed;
  noAlliances: boolean;
  /** no atom bombs (rockets stay) */
  noNukes: boolean;
  /** no airfields, bombers, fighters or paratroopers */
  noAir: boolean;
  /** no warships (transports and trade ships stay) */
  noNavy: boolean;
  noSams: boolean;
  research: ResearchRule;
  /** income, troop growth, construction, research and front speed x2 */
  fastGame: boolean;
}

/**
 * The options chosen before a game: the setup screen (single player) and the multiplayer lobby share this one model
 * (setup.ts: DEFAULT_SETUP, presets, validateSetup / sanitizeSetup).
 */
export interface GameSetup {
  map: MapChoice;
  /** AI nations, 0..MAX_AI_COUNT (config). In multiplayer the humans come on top. */
  aiCount: number;
  /** small weak AI tribes (the main early targets); < 0 = the default for the map's land (setup.defaultTribeCount) */
  tribeCount: number;
  difficulty: Difficulty;
  mode: GameMode;
  /** teams mode: number of teams, 2..6 (ignored in ffa). Single player: you are on team 1. */
  teamCount: number;
  /** 0 = no limit; otherwise seconds of game time, highest score wins. */
  timeLimit: number;
  victoryLandShare: number; // 0..1, default config VICTORY_LAND_SHARE
  modifiers: Modifiers;
  /** which preset the setup came from (display only) */
  preset: PresetId;
}

/** One human player's seat (multiplayer: one per lobby player, in player id order 1..H). */
export interface HumanSeat {
  name: string;
  color: [number, number, number];
  /** teams mode: 1..teamCount; 0 = assigned by createGame (smallest team). Ignored in ffa. */
  team: number;
}

/**
 * Everything a game is built from. Humans: `humans` when it is given and not empty (multiplayer: ids 1..H in that
 * order); otherwise single player: one human from playerName / playerColor when humanPlayer is true, none when false
 * (setup.humanSeats reads both forms). Teams are the setup's mode / teamCount (no separate field).
 */
export interface GameSettings extends GameSetup {
  seed: number;
  /** single player: the human's name and colour (multiplayer: equal to humans[0]) */
  playerName: string;
  playerColor: [number, number, number];
  /** false = AI-only game (headless balance runs, menu background). Ignored when `humans` is given. */
  humanPlayer: boolean;
  /** multiplayer: every human seat, ids 1..H in this order */
  humans?: HumanSeat[];
}

export interface MapData {
  width: number;
  height: number;
  terrain: Uint8Array; // TerrainId per tile
  resource: Uint8Array; // ResourceId per tile
  owner: Uint16Array; // player id, 0 = nobody
  /** building id + 1 on that tile, 0 = none */
  building: Int32Array;
  /** 1 when the tile is land and touches water (4-neighbourhood) */
  coastal: Uint8Array;
  /** fallout from atom bombs: seconds left; tiles with fallout have pop 0 and can't be built on */
  fallout: Float32Array;
  landTileCount: number;
}

export interface Building {
  id: number;
  type: BuildingType;
  owner: number;
  tile: number;
  /** 1 .. BUILDINGS[type].maxLevel; every effect scales with it (buildings.ts). Building again near it upgrades it. */
  level: number;
  /** seconds of construction left; 0 = finished */
  buildLeft: number;
  /**
   * seconds of a running upgrade left (0 = none). The building keeps working at its current level meanwhile; the
   * level goes up by one when this reaches 0.
   */
  upgradeLeft: number;
  /** airfield: stored aircraft */
  fighters: number;
  bombers: number;
  /**
   * airfield: seconds until its fighters can intercept again; port: trade ship timer (seconds);
   * SAM / silo: reload debt in seconds (buildings.chargesReady / nextChargeIn read it; level = shots in a salvo)
   */
  cooldown: number;
  /** airfield: seconds until it can fly the next paradrop (0 = ready) */
  dropCooldown: number;
  /**
   * tick until which the building is knocked out by an artillery barrage (forts give no bonus, SAMs can't fire);
   * 0 or a past tick = working
   */
  disabledUntil: number;
  /** 1 = intact; barrages take hp off forts and SAMs (0 = destroyed); it repairs slowly (BUILDING_REPAIR_PER_S) */
  hp: number;
}

/**
 * A telegraphed artillery barrage (Action 'barrage'): it lands at hitTick on a disc of BARRAGE_RADIUS around tile.
 * The client draws it as a warning circle until then.
 */
export interface Barrage {
  id: number;
  /** who fired it */
  owner: number;
  tile: number;
  /** owner of the tile when it was fired */
  target: number;
  /** artillery the shooter had when it fired (sets the troops killed) */
  artillery: number;
  /** tick at which the shells land */
  hitTick: number;
}

export interface Attack {
  id: number;
  attacker: number;
  target: number; // player id or 0 for neutral land
  troops: Troops;
  /** tile the player last clicked: only an anchor for UI labels (the whole shared border advances, see combat.ts) */
  focusTile: number;
  /** captured tiles accumulator (fractional progress) */
  progress: number;
  startTick: number;
  /** true when launched from a transport landing */
  amphibious: boolean;
  /** total units lost so far (for stats / UI) */
  losses: number;
  tilesTaken: number;
}

export interface Unit {
  id: number;
  type: UnitType;
  owner: number;
  x: number; // tile coordinates, float
  y: number;
  /** destination tile */
  target: number;
  /** tile it came from (airfield/port/silo/coast) */
  home: number;
  /** water path for ships (tile indexes), followed in order; empty for aircraft/missiles (straight line) */
  path: number[];
  pathPos: number;
  troops: Troops; // transports only
  hp: number;
  /** trade ships: gold carried; bombers: 0 = outbound, 1 = returning */
  cargo: number;
  state: number;
  /** destination player for trade ships */
  targetOwner: number;
}

export interface PlayerStats {
  tilesMax: number;
  troopsLost: number;
  troopsKilled: number;
  tilesCaptured: number;
  buildingsBuilt: number;
  goldEarned: number;
}

export interface Player {
  id: number;
  name: string;
  color: [number, number, number];
  isHuman: boolean;
  personality: Personality | null; // null for the human
  alive: boolean;
  spawned: boolean;
  capital: number; // tile index, -1 if none
  tiles: number; // owned tile count (kept in sync by setOwner)
  /** the troop pool at home (one pool: armor and artillery are converted from it); attacks hold their own troops */
  troops: Troops;
  gold: number;
  iron: number;
  oil: number;
  science: number;
  /** troop cap (derived each tick by economy.ts): home troops grow toward it; growth peaks around 40% of it */
  maxPop: number;
  /** per second, derived each tick by economy.ts; pop = troop growth */
  income: { gold: number; iron: number; oil: number; science: number; pop: number };
  /** target shares of armor and artillery in the army; infantry = rest */
  armyMix: { armor: number; artillery: number };
  /** when true the sim manages these for the player (default true for humans, so a new player only has to click) */
  auto: { mix: boolean; research: boolean };
  techs: TechId[];
  researching: TechId | null;
  researchProgress: number; // science points put into the current tech
  /** tick until which this player is a traitor (0 = not) */
  traitorUntil: number;
  /** tick from which the next artillery barrage may be fired (Action 'barrage'; global per player) */
  barrageReadyTick: number;
  embargoes: number[]; // player ids this player refuses to trade with
  stats: PlayerStats;
  eliminatedTick: number; // -1 while alive
}

export interface Alliance {
  a: number; // smaller id
  b: number;
  expiresTick: number;
}

export interface AllianceRequest {
  from: number;
  to: number;
  expiresTick: number;
}

export type GameEventKind =
  | 'info'
  | 'attackStarted'
  | 'underAttack'
  /** a small human nation is walled in by one nation (warning during its grace time) */
  | 'surrounded'
  | 'buildingDone'
  | 'buildingLost'
  | 'buildingCaptured'
  | 'researchDone'
  | 'allianceRequest'
  | 'allianceFormed'
  | 'allianceBroken'
  | 'allianceExpired'
  | 'eliminated'
  | 'capitalLost'
  | 'nuke'
  | 'missile'
  | 'bombing'
  | 'unitLost'
  | 'tradeDelivered'
  /** paratroopers are on their way (to the target) or landed */
  | 'paradrop'
  /** an artillery barrage is coming / hit */
  | 'barrage'
  | 'victory'
  | 'defeat';

export interface GameEvent {
  tick: number;
  kind: GameEventKind;
  message: string;
  /** players this event concerns (the client shows events concerning the human, plus global ones with []) */
  players: number[];
  tile: number; // -1 if none
}

export type GamePhase = 'spawn' | 'playing' | 'over';

export interface GameState {
  settings: GameSettings;
  tick: number;
  phase: GamePhase;
  /** seconds of spawn phase left */
  spawnLeft: number;
  /** tick at which the spawn phase ended (game time 0:00; "Start now" ends it early). 0 until then. */
  playStartTick: number;
  map: MapData;
  players: Player[]; // index = id; players[0] = neutral placeholder (alive=false)
  /**
   * CLIENT-SIDE: the player this client controls and views (0 = none / spectator). createGame sets it to the first
   * human; a multiplayer client sets it to its own seat. The sim never reads it (every human is treated alike), so
   * clients with different humanIds stay in lockstep.
   */
  humanId: number;
  buildings: Map<number, Building>;
  attacks: Attack[];
  units: Unit[];
  /** artillery barrages fired and not yet landed (barrage.ts) */
  barrages: Barrage[];
  alliances: Alliance[];
  allianceRequests: AllianceRequest[];
  /** opinion[a][b] = how AI a feels about b, -100..100 */
  opinion: number[][];
  events: GameEvent[];
  nextId: number;
  /** seeded RNG, returns [0,1) */
  rng: () => number;
  rngState: { s: number };
  winner: number; // 0 until over
  /** short-lived visual effects for the client (explosions, shots); the sim adds, the client removes when done */
  effects: Effect[];
  /**
   * Tiles whose owner or fallout changed since the client last drained the list (changes.ts: recordTileChange /
   * drainTileChanges). Capacity 1 << 18; when full, overflow = true and nothing more is recorded until drained.
   */
  changes: { tiles: Int32Array; count: number; overflow: boolean };
  /** Incremented whenever a building is added, removed, upgraded, finished or changes owner (cache key). */
  buildingsVersion: number;
  /**
   * Team of every player (index = player id): 1..teamCount in a teams game, 0 = no team (FFA, tribes, neutral).
   * Teammates are permanently allied, can't attack each other and win together (rules.ts sameTeam).
   */
  teams: number[];
  /** the winning team in a teams game (0 = none / FFA); `winner` is then its best-scoring member */
  winnerTeam: number;
  /**
   * Fixed start tile per player id (-1 = none): world-map nations start at their real capitals (unless random spawn).
   */
  spawnPoints: number[];
  /**
   * Size class of the map actually played (generated: its size, one class smaller per compact step; world maps: by
   * land): sets the start radius, building spacing and default tribe counts (setup.sizeClassForLand).
   */
  mapClass: MapSize;
}

export interface Effect {
  /** 'barrage': artillery shells landing on a disc (radius = BARRAGE_RADIUS) */
  kind: 'explosion' | 'nuke' | 'shot' | 'capture' | 'barrage';
  x: number;
  y: number;
  radius: number;
  tick: number;
  /** for 'shot': end point */
  x2?: number;
  y2?: number;
}

/** Everything a player (human or AI) can do. Validated in actions.ts. */
export type Action =
  | { type: 'spawn'; tile: number }
  | { type: 'attack'; tile: number; troops: Troops }
  | { type: 'retreat'; attackId: number }
  | { type: 'build'; building: BuildingType; tile: number }
  | { type: 'demolish'; tile: number }
  | { type: 'setArmyMix'; armor: number; artillery: number }
  | { type: 'research'; tech: TechId }
  | { type: 'transport'; from: number; to: number; troops: Troops }
  | { type: 'buildWarship'; port: number }
  | { type: 'moveWarship'; unitId: number; tile: number }
  | { type: 'buildAircraft'; airfield: number; kind: 'bomber' | 'fighter' }
  | { type: 'bomb'; airfield: number; tile: number }
  | { type: 'launchMissile'; silo: number; kind: 'rocket' | 'atomBomb'; tile: number }
  /** paratroopers: `troops` infantry fly from an own airfield (tile) to an enemy / neutral land tile (units.ts) */
  | { type: 'paradrop'; airfield: number; tile: number; troops: number }
  /** artillery barrage on an enemy tile near your border (barrage.ts) */
  | { type: 'barrage'; tile: number }
  | { type: 'requestAlliance'; to: number }
  | { type: 'answerAlliance'; from: number; accept: boolean }
  | { type: 'breakAlliance'; with: number }
  | { type: 'gift'; to: number; gold: number; troops: number }
  | { type: 'toggleEmbargo'; with: number }
  | { type: 'setAuto'; mix?: boolean; research?: boolean }
  /** end the spawn phase now (only when every human has spawned; online only the private lobby's host may) */
  | { type: 'startNow' };

export interface ActionResult {
  ok: boolean;
  /** human-readable reason when !ok (shown in the UI) */
  reason?: string;
}
