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
export type Difficulty = 'easy' | 'normal' | 'hard';
export type Personality = 'warlord' | 'turtle' | 'merchant' | 'admiral' | 'balanced' | 'tribe';

export interface GameSettings {
  seed: number;
  mapType: MapType;
  mapSize: MapSize;
  aiCount: number; // AI nations, 0..MAX_AI_COUNT (config)
  difficulty: Difficulty;
  playerName: string;
  playerColor: [number, number, number];
  /** false = AI-only game (headless balance runs, menu background). */
  humanPlayer: boolean;
  /** 0 = no limit; otherwise seconds of game time, highest score wins. */
  timeLimit: number;
  victoryLandShare: number; // 0..1, default config VICTORY_LAND_SHARE
  /** small weak AI tribes (early targets, accept any alliance); < 0 = config DEFAULT_TRIBE_COUNT for the map size */
  tribeCount: number;
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
  humanId: number; // 0 if no human
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
  /** single player: end the spawn phase now (only when every human has spawned) */
  | { type: 'startNow' };

export interface ActionResult {
  ok: boolean;
  /** human-readable reason when !ok (shown in the UI) */
  reason?: string;
}
