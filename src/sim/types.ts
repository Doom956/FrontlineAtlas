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

export type UnitType = 'transport' | 'warship' | 'tradeShip' | 'bomber' | 'fighter' | 'rocket' | 'atomBomb';

export type MapType = 'continents' | 'pangaea' | 'archipelago' | 'highlands';
export type MapSize = 'small' | 'medium' | 'large';
export type Difficulty = 'easy' | 'normal' | 'hard';
export type Personality = 'warlord' | 'turtle' | 'merchant' | 'admiral' | 'balanced';

export interface GameSettings {
  seed: number;
  mapType: MapType;
  mapSize: MapSize;
  aiCount: number; // 2..15
  difficulty: Difficulty;
  playerName: string;
  playerColor: [number, number, number];
  /** false = AI-only game (headless balance runs, menu background). */
  humanPlayer: boolean;
  /** 0 = no limit; otherwise seconds of game time, highest score wins. */
  timeLimit: number;
  victoryLandShare: number; // 0..1, default config VICTORY_LAND_SHARE
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
  level: number; // cities 1..5, others 1
  /** seconds of construction left; 0 = finished */
  buildLeft: number;
  /** airfield: stored aircraft; silo: cooldown seconds; port: trade ship timer (seconds) */
  fighters: number;
  bombers: number;
  cooldown: number;
  hp: number; // 1 = intact; damage from bombs/rockets reduces it, 0 = destroyed
}

export interface Attack {
  id: number;
  attacker: number;
  target: number; // player id or 0 for neutral land
  troops: Troops;
  /** tile the player clicked; the front grows from tiles nearest to it first */
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
  workers: number;
  troops: Troops;
  gold: number;
  iron: number;
  oil: number;
  science: number;
  /** derived each tick by economy.ts, for UI */
  maxPop: number;
  income: { gold: number; iron: number; oil: number; science: number; pop: number };
  /** target army / population share, 0.1..0.9 */
  armyRatio: number;
  /** target shares of armor and artillery in the army; infantry = rest */
  armyMix: { armor: number; artillery: number };
  techs: TechId[];
  researching: TechId | null;
  researchProgress: number; // science points put into the current tech
  /** tick until which this player is a traitor (0 = not) */
  traitorUntil: number;
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
  map: MapData;
  players: Player[]; // index = id; players[0] = neutral placeholder (alive=false)
  humanId: number; // 0 if no human
  buildings: Map<number, Building>;
  attacks: Attack[];
  units: Unit[];
  alliances: Alliance[];
  allianceRequests: AllianceRequest[];
  /** opinion[a][b] = how AI a feels about b, -100..100 */
  opinion: number[][];
  events: GameEvent[];
  nextId: number;
  /** seeded RNG, returns [0,1) */
  rng: () => number;
  rngState: { s: number };
  /** per-player distance (tiles) to nearest own supply source; recomputed periodically. Uint16 65535 = unreachable */
  supplyDist: Map<number, Uint16Array>;
  winner: number; // 0 until over
  /** short-lived visual effects for the client (explosions, shots); the sim adds, the client removes when done */
  effects: Effect[];
}

export interface Effect {
  kind: 'explosion' | 'nuke' | 'shot' | 'capture';
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
  | { type: 'setArmyRatio'; value: number }
  | { type: 'setArmyMix'; armor: number; artillery: number }
  | { type: 'research'; tech: TechId }
  | { type: 'transport'; from: number; to: number; troops: Troops }
  | { type: 'buildWarship'; port: number }
  | { type: 'moveWarship'; unitId: number; tile: number }
  | { type: 'buildAircraft'; airfield: number; kind: 'bomber' | 'fighter' }
  | { type: 'bomb'; airfield: number; tile: number }
  | { type: 'launchMissile'; silo: number; kind: 'rocket' | 'atomBomb'; tile: number }
  | { type: 'requestAlliance'; to: number }
  | { type: 'answerAlliance'; from: number; accept: boolean }
  | { type: 'breakAlliance'; with: number }
  | { type: 'gift'; to: number; gold: number; troops: number }
  | { type: 'toggleEmbargo'; with: number };

export interface ActionResult {
  ok: boolean;
  /** human-readable reason when !ok (shown in the UI) */
  reason?: string;
}
