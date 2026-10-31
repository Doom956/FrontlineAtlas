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
  | 'nuclearFission'
  // Branches with exclusive choices (techtree.ts; TechInfo.exclusiveGroup / requiresAny in config)
  | 'stockExchange'
  | 'freeTrade'
  | 'industrialBoom'
  | 'blitzTactics'
  | 'trenchWarfare'
  | 'railways'
  | 'carriers'
  | 'submarines'
  | 'jetEngines'
  | 'strategicBombing'
  | 'propaganda'
  | 'diplomaticCorps'
  | 'conscription'
  | 'massMobilization'
  | 'automation';

export type UnitType =
  | 'transport'
  | 'warship'
  | 'tradeShip'
  | 'bomber'
  | 'fighter'
  | 'rocket'
  | 'atomBomb'
  /** cargo plane carrying paratroopers from an airfield to a drop tile (Action 'paradrop') */
  | 'transportPlane'
  /** commandable armored division (tanks.ts): built at a Factory, moves over own land, launches spearheads */
  | 'tankDivision';

/**
 * Warship stances (naval2.ts; Unit.stance, Action setUnitStance). auto = hunt enemy ships near its post, bombard enemy
 * coast near your fronts, return to post; hunt = chase ships over a wide zone; escort = stick to own transports and
 * trade ships (they become much harder to sink); bombard = park off an enemy coast; blockade = park off an enemy port.
 */
export type WarshipStance = 'auto' | 'hunt' | 'escort' | 'bombard' | 'blockade';
export const WARSHIP_STANCES: readonly WarshipStance[] = ['auto', 'hunt', 'escort', 'bombard', 'blockade'];
/**
 * Tank division modes (armor2.ts; Unit.mode, Action setDivisionMode). hold = stays where it is (refits slowly in
 * place); support = holds behind a chosen front and launches spearheads into weak spots there when ready (refits at a
 * Factory when worn down); refit = drives to the nearest own Factory, refits there, then holds.
 */
export type DivisionMode = 'hold' | 'support' | 'refit';
export const DIVISION_MODES: readonly DivisionMode[] = ['hold', 'support', 'refit'];

export type MapType = 'continents' | 'pangaea' | 'archipelago' | 'highlands';
export type MapSize = 'small' | 'medium' | 'large' | 'huge';
export type Difficulty = 'easy' | 'normal' | 'hard' | 'brutal';
export type Personality = 'warlord' | 'turtle' | 'merchant' | 'admiral' | 'balanced' | 'tribe';

/**
 * Doctrines (src/sim/doctrines.ts, config DOCTRINES): a mid-game, switchable, bonus-only specialisation. Every unit,
 * building and strike stays open to everyone; a doctrine makes one style moderately better and grows over time.
 */
export type DoctrineId = 'blitz' | 'fortress' | 'siege' | 'merchant' | 'naval' | 'air' | 'expansion';
export const DOCTRINE_IDS: readonly DoctrineId[] = ['blitz', 'fortress', 'siege', 'merchant', 'naval', 'air', 'expansion'];
/** A player's doctrine (Player.doctrine). Ticks are sim ticks; -1 = never. */
export interface PlayerDoctrine {
  /** null until the first choice */
  id: DoctrineId | null;
  /** 0 = none; 1..3 grow with the time the same doctrine is held (config DOCTRINE_LEVEL_SECONDS) */
  level: 0 | 1 | 2 | 3;
  /** tick of the last choice (first choice or switch): the level clock starts here */
  chosenTick: number;
  /** no doctrine bonus before this tick (a switch takes DOCTRINE_ADAPT_SECONDS; the first choice none) */
  adaptUntilTick: number;
  /** tick of the last choice, for the switch cooldown (DOCTRINE_SWITCH_COOLDOWN) */
  lastSwitchTick: number;
}

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
  /**
   * Further levels queued by Action buildMany / upgradeArea (bulkbuild.ts), already paid: they start one after
   * another, each with its normal upgrade time. Cancelling (Action cancelQueuedLevels) refunds them; a capture drops them.
   */
  queuedLevels: number;
  /** what the queued levels cost (refunded on cancel); absent = nothing queued */
  queuedPaid?: { gold: number; iron: number };
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
  /** disc radius in tiles, fixed when fired (doctrines.barrageRadius; absent = config BARRAGE_RADIUS) */
  radius?: number;
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
  /** warship (navy.ts): id of the enemy ship it is chasing (state 2); absent / 0 = none */
  chase?: number;
  /** warship: ticks the chased ship has been out of detection range (gives up after WARSHIP_CHASE_GIVE_UP) */
  chaseLost?: number;
  /** tank division (tanks.ts): spearhead start tile (state 3) and its strength (troops) when it started */
  launch?: number;
  strength0?: number;
  /** warship stance (naval2.ts); absent = 'auto' */
  stance?: WarshipStance;
  /**
   * warship on station (state 3, naval2.ts): the coast / port tile it bombards or blockades; escorting (state 4): the
   * id of the ship it escorts. Tank division in support mode (armor2.ts): the front tile it supports.
   */
  station?: number;
  /** warships, tank divisions: veterancy points and level 0..3 (naval2.ts, armor2.ts); absent = 0 */
  xp?: number;
  vet?: number;
  /** tank division mode (armor2.ts); absent = 'hold' */
  mode?: DivisionMode;
  /** bomber / cargo plane flying an air-wing mission (airwings.ts): 1 = support, 2 = strategic; absent = manual */
  mission?: number;
  /** air-wing escort (airwings.ts): fighter interceptions this plane's escort can still fight off; absent = 0 */
  escort?: number;
}

/** A unit being built (navy.ts warships, tanks.ts divisions): it appears at `tile` at readyTick. */
export interface QueuedUnit {
  id: number;
  type: 'warship' | 'tankDivision';
  owner: number;
  /** the port / factory tile it is built at */
  site: number;
  /** where it appears (a water tile for warships, the factory tile for divisions) */
  tile: number;
  readyTick: number;
  /** tank divisions: the troops taken from the pool for it (returned if the build is lost) */
  troops: Troops;
}

/** Owner console state (admin.ts, Action 'admin'): all deterministic, part of the hash. */
export interface AdminState {
  /** players no AI may attack */
  aiPassive: number[];
  /** players whose tiles can't be captured */
  godMode: number[];
  /** every AI stops deciding */
  aiFrozen: boolean;
  /** players who see every nation's intel (buildings.hasIntel) */
  revealIntel: number[];
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
  /** mid-game doctrine (doctrines.ts); tribes never get one */
  doctrine: PlayerDoctrine;
  stats: PlayerStats;
  eliminatedTick: number; // -1 while alive
  /**
   * Centre of the heartland (combat.coreDefenseAt): the capital at spawn; after a capital loss it moves to the new
   * capital at heartMoveTick (HEARTLAND_MOVE_SECONDS later). -1 = no heartland.
   */
  heartTile: number;
  /** tick at which heartTile moves to the current capital (0 = no move pending) */
  heartMoveTick: number;
  /** tick from which this player may ask its allies again (requestAllyAttack / requestAllyAid; ALLY_REQUEST_COOLDOWN) */
  allyAskTick: number;
  /** gold uses (spending.ts): mercenaries, war bonds; absent until the first use */
  spend?: SpendState;
}

/** Per-player state of the gold uses (spending.ts). Ticks are sim ticks. */
export interface SpendState {
  /** mercenaries hired in the current window (raises the price) and the tick the window started */
  mercRecent: number;
  mercWindowTick: number;
  /** war bonds: attack bonus active until this tick; next purchase allowed from bondsReadyTick */
  bondsUntil: number;
  bondsReadyTick: number;
  /** Carriers: tick from which this player's warships can shoot down the next plane (techtree.ts) */
  carrierReadyTick: number;
}

/** Gold sent to an ally (Action fundAlly): the ally fights harder against `from`'s enemies until untilTick. */
export interface AllyFunding {
  from: number;
  ally: number;
  /** attack multiplier bonus (0.1 = +10%) against nations at war with `from` */
  bonus: number;
  untilTick: number;
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

/** A request to an AI ally (Action requestAllyAttack / requestAllyAid), answered on the ally's next decision. */
export interface AllyRequest {
  from: number;
  ally: number;
  kind: 'attack' | 'aid';
  /** nation to attack (kind 'attack'), 0 for aid */
  target: number;
  expiresTick: number;
}

/**
 * An ally fighting `target` for `friend` (asked, or joined on its own): its AI keeps that war going (reinforces it,
 * ranks it first) until untilTick.
 */
export interface AllyPledge {
  helper: number;
  friend: number;
  target: number;
  untilTick: number;
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
  /** an ally joins a war on your side ("Valoria joins your war against Tarsis") */
  | 'allyJoined'
  /** an ally sent troops or gold */
  | 'allyAid'
  /** an ally said no to a request (the message gives the reason) */
  | 'allyRefused'
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
  /** doctrines can now be chosen (to the player) */
  | 'doctrineUnlocked'
  /** a doctrine was chosen or switched (to the player; as news to humans who border it or have intel on it) */
  | 'doctrineChosen'
  /** the held doctrine reached a new level (to the player) */
  | 'doctrineLevelUp'
  /** a warship ordered at a port is ready (navy.ts) */
  | 'warshipReady'
  /** a tank division finished at a Factory; a spearhead started / ended (tiles taken, losses) (tanks.ts) */
  | 'tankDivisionReady'
  | 'spearheadStarted'
  | 'spearheadEnded'
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
  /** requests to AI allies waiting for their answer (allies.ts) */
  allyRequests: AllyRequest[];
  /** allies committed to a war for a friend (allies.ts) */
  allyPledges: AllyPledge[];
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
  /** funded allies (Action fundAlly, spending.ts); absent = none yet */
  allyFunds?: AllyFunding[];
  /**
   * The game was continued after it ended (Action continueGame): phase is back to 'playing', winner / winnerTeam stay
   * as recorded and victory, overtime and time-limit checks no longer run. Absent = false.
   */
  continued?: boolean;
  /** owner console state (admin.ts); absent = nothing set */
  admin?: AdminState;
  /** warships and tank divisions under construction (navy.ts, tanks.ts); absent = none */
  unitQueue?: QueuedUnit[];
  /** air wings, air-support zones and strategic raid damage (airwings.ts); absent = none yet */
  air?: AirState;
}

/** Standing mission of an airfield's air wing (Action setAirMission, airwings.ts). */
export type AirMission = 'idle' | 'support' | 'strategic' | 'superiority';
export const AIR_MISSIONS: readonly AirMission[] = ['idle', 'support', 'strategic', 'superiority'];

/** One airfield's wing (airwings.ts). Keyed by the airfield building id; dropped when the airfield is gone or taken. */
export interface AirWing {
  /** airfield building id and tile */
  airfield: number;
  tile: number;
  owner: number;
  mission: AirMission;
  /** support: the front tile it bombs ahead of (follows the front); strategic: a tile of the target nation; superiority: patrol centre; -1 = none */
  target: number;
  /** support / strategic: the nation it was set against (0 = none) */
  targetOwner: number;
  /** tick of the next sortie / check */
  nextTick: number;
  /** re-buy aircraft for the mission automatically (gold permitting) */
  refill: boolean;
  /** superiority: tick its fighters can intercept again */
  coverTick: number;
  /** sorties flown (for the UI) */
  sorties: number;
}

/** A temporary air-support zone (airwings.ts): enemy defence inside is cut for the owner's attacks. */
export interface AirZone {
  /** wing (airfield building id) that made it */
  wing: number;
  owner: number;
  tile: number;
  radius: number;
  /** bombers that struck it (diminishing returns: AIR.supportDecay) */
  strength: number;
  untilTick: number;
  /** the nation struck (bleeds troops while the zone lasts) and its tiles inside when it was made */
  victim: number;
  tiles: number;
}

/** Strategic-bombing damage to one nation's economy (airwings.ts): gold and iron income x (1 - cut) until untilTick. */
export interface AirRaid {
  victim: number;
  cut: number;
  untilTick: number;
}

export interface AirState {
  wings: AirWing[];
  zones: AirZone[];
  raids: AirRaid[];
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
  /**
   * port = an own finished Port tile (or -1: the nearest suitable one); tile = the water tile where the ship appears
   * (reachable from that port, within WARSHIP_SPAWN_RANGE). Without tile it appears next to the port.
   */
  | { type: 'buildWarship'; port: number; tile?: number }
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
  /** ask an ally to attack `target` (an AI ally answers on its next decision: allyJoined or allyRefused event) */
  | { type: 'requestAllyAttack'; ally: number; target: number }
  /** ask an ally for troops (or gold): allyAid or allyRefused event */
  | { type: 'requestAllyAid'; ally: number }
  | { type: 'setAuto'; mix?: boolean; research?: boolean }
  /** pick a doctrine (first choice) or switch to another one (costs gold, adapt time, cooldown: doctrines.ts) */
  | { type: 'chooseDoctrine'; doctrine: DoctrineId }
  /** end the spawn phase now (only when every human has spawned; online only the private lobby's host may) */
  | { type: 'startNow' }
  /** gold uses (spending.ts): instant infantry for gold (price rises with each hire and with game time) */
  | { type: 'hireMercenaries'; amount: number }
  /** send gold to an ally: it joins your wars more readily and attacks your enemies harder for a while */
  | { type: 'fundAlly'; ally: number; gold: number }
  /** gold for a short attack-power boost (cooldown) */
  | { type: 'warBonds' }
  /** bulk build (bulkbuild.ts): place / upgrade a building and queue up to count levels in total (1..5) */
  | { type: 'buildMany'; building: BuildingType; tile: number; count: number }
  /** queue up to `levels` upgrades for every own building (of one type) within radius of tile, cheapest first */
  | { type: 'upgradeArea'; tile: number; radius: number; building?: BuildingType; levels: number }
  /** cancel the queued (not yet started) levels of the own building on tile; refunds them */
  | { type: 'cancelQueuedLevels'; tile: number }
  /** after the game ended: play on (single player: the human; online: only the private lobby's host) */
  | { type: 'continueGame' }
  /** move a group of own warships to a water tile in a loose formation (navy.ts; at most MAX_GROUP_UNITS ids) */
  | { type: 'moveWarships'; unitIds: number[]; tile: number }
  /** build a tank division at an own finished Factory (tile = the factory) (tanks.ts) */
  | { type: 'buildTankDivision'; tile: number }
  /** move divisions over own land; a tile of enemy / neutral land at the border launches a spearhead (tanks.ts) */
  | { type: 'moveTankDivision'; unitIds: number[]; tile: number }
  /** owner console (admin.ts): online the server relays it only from an authenticated admin session */
  /** set the stance of own warships (naval2.ts) */
  | { type: 'setUnitStance'; unitIds: number[]; stance: WarshipStance }
  /** set the mode of own tank divisions; support needs `front` (a land tile at or near the front) (armor2.ts) */
  | { type: 'setDivisionMode'; unitIds: number[]; mode: DivisionMode; front?: number }
  /**
   * standing mission of an airfield's air wing (airwings.ts); airfield = an own finished airfield tile, or -1 = every
   * own airfield that reaches the target. target: support / strategic = a tile of the enemy (or at your front),
   * superiority = patrol centre (absent = the airfield). refill = re-buy aircraft for the mission automatically.
   */
  | { type: 'setAirMission'; airfield: number; mission: AirMission; target?: number; refill?: boolean }
  | AdminAction;

/** Owner console operations (admin.ts ADMIN_OPS lists them with the fields each one reads). */
export type AdminOp =
  | 'setResource'
  | 'addResource'
  | 'setTroops'
  | 'addTroops'
  | 'fillTroops'
  | 'unlockAllTechs'
  | 'unlockTech'
  | 'removeTech'
  | 'finishResearch'
  | 'finishConstructions'
  | 'placeBuilding'
  | 'deleteBuilding'
  | 'setBuildingLevel'
  | 'giveWarships'
  | 'giveAircraft'
  | 'giveCharges'
  | 'spawnWarship'
  | 'spawnTankDivision'
  | 'paintTiles'
  | 'neutralizeTiles'
  | 'moveCapital'
  | 'forceAlliance'
  | 'breakAlliance'
  | 'declareWar'
  | 'setOpinion'
  | 'aiPassive'
  | 'freezeAI'
  | 'setDifficulty'
  | 'godMode'
  | 'setDoctrine'
  | 'eliminate'
  | 'revive'
  | 'setPeace'
  | 'revealIntel';

/**
 * One owner console operation. Which optional fields an op reads: admin.ts ADMIN_OPS. player = the player it acts on
 * (0 = the sender), other = a second player, tile = a map tile, amount = a number, key = a resource / tech / building
 * / doctrine / difficulty / aircraft name, flag = on/off, troops = an exact split.
 */
export interface AdminAction {
  type: 'admin';
  op: AdminOp;
  player?: number;
  other?: number;
  tile?: number;
  amount?: number;
  key?: string;
  flag?: boolean;
  troops?: Troops;
}

export interface ActionResult {
  ok: boolean;
  /** human-readable reason when !ok (shown in the UI) */
  reason?: string;
}
