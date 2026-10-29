// All balance numbers. Rates are per second of game time unless the name says otherwise.
import type { BuildingType, MapSize, Personality, TechId, TerrainId, TroopType, UnitType } from './types';

export const TICK_SECONDS = 0.1;
export const TICKS_PER_SECOND = 10;
export const SPAWN_SECONDS = 12;
export const SPAWN_RADIUS = 4; // starting territory radius
export const START_WORKERS = 6000;
export const START_INFANTRY = 3000;
export const START_GOLD = 600;
export const START_IRON = 0;
export const START_OIL = 0;
export const MAX_EVENTS = 200;
export const VICTORY_LAND_SHARE = 0.75;

export const MAP_SIZES: Record<MapSize, { width: number; height: number }> = {
  small: { width: 300, height: 200 },
  medium: { width: 420, height: 280 },
  large: { width: 560, height: 360 },
};

export interface TerrainInfo {
  name: string;
  color: [number, number, number];
  popPerTile: number;
  defense: number;
  speed: number;
  attack: Record<TroopType, number>;
  noBuild: BuildingType[];
}

export const TERRAIN: Record<TerrainId, TerrainInfo> = {
  0: { name: 'Deep water', color: [28, 58, 102], popPerTile: 0, defense: 1, speed: 0, attack: { infantry: 0, armor: 0, artillery: 0 }, noBuild: [] },
  1: { name: 'Shallow water', color: [46, 92, 145], popPerTile: 0, defense: 1, speed: 0, attack: { infantry: 0, armor: 0, artillery: 0 }, noBuild: [] },
  2: { name: 'Plains', color: [126, 168, 86], popPerTile: 30, defense: 1.0, speed: 1.0, attack: { infantry: 1.0, armor: 1.3, artillery: 1.0 }, noBuild: [] },
  3: { name: 'Forest', color: [62, 112, 58], popPerTile: 20, defense: 1.4, speed: 0.7, attack: { infantry: 1.15, armor: 0.6, artillery: 0.8 }, noBuild: [] },
  4: { name: 'Hills', color: [150, 140, 92], popPerTile: 15, defense: 1.6, speed: 0.6, attack: { infantry: 1.1, armor: 0.8, artillery: 1.2 }, noBuild: [] },
  5: { name: 'Mountains', color: [128, 118, 110], popPerTile: 5, defense: 2.5, speed: 0.35, attack: { infantry: 1.2, armor: 0.35, artillery: 0.6 }, noBuild: ['farm', 'airfield'] },
  6: { name: 'Desert', color: [214, 196, 132], popPerTile: 6, defense: 0.9, speed: 0.9, attack: { infantry: 0.85, armor: 1.2, artillery: 1.0 }, noBuild: ['farm'] },
  7: { name: 'Swamp', color: [92, 116, 84], popPerTile: 8, defense: 1.3, speed: 0.5, attack: { infantry: 1.0, armor: 0.4, artillery: 0.6 }, noBuild: ['farm', 'airfield', 'silo'] },
  8: { name: 'Tundra', color: [196, 206, 204], popPerTile: 8, defense: 1.1, speed: 0.8, attack: { infantry: 0.9, armor: 0.9, artillery: 1.0 }, noBuild: ['farm'] },
};

export const RESOURCE_COLORS: Record<number, [number, number, number]> = {
  1: [70, 70, 78], // iron
  2: [24, 20, 18], // oil
  3: [168, 196, 70], // fertile
};
export const RESOURCE_NAMES = ['None', 'Iron', 'Oil', 'Fertile'] as const;

// ---------- economy ----------
export const CITY_POP = 25000; // per city level
export const CAPITAL_POP = 20000;
export const POP_GROWTH = 0.05; // logistic rate
export const MIN_GROWTH = 15; // people/s while below max
export const FARM_GROWTH = 60; // people/s per farm (x2 on Fertile)
export const DEMOBILISE_RATE = 0.01; // share of excess infantry turned into workers per second
export const GOLD_PER_WORKER = 0.004;
export const CITY_GOLD = 4; // per city level
export const MARKET_GOLD_BONUS = 0.12; // +12% gold per market
export const MARKET_MAX_BONUS = 1.2;
export const IRON_PER_MINE = 2.0;
export const OIL_PER_WELL = 1.6;
export const BASE_SCIENCE = 0.5;
export const SCIENCE_PER_LAB = 1.5;
export const ARMOR_OIL_UPKEEP = 0.0015; // oil per armor unit per second
export const AIRCRAFT_OIL_UPKEEP = 0.02; // oil per stored aircraft per second
export const NO_OIL_ARMOR_FACTOR = 0.5;
export const BARRACKS_GROWTH_BONUS = 0.15; // +15% growth to infantry per barracks
export const BARRACKS_LOSS_REDUCTION = 0.05;
export const BARRACKS_MAX = 3;
export const HOSPITAL_RECOVERY = 0.25; // per hospital, max 1 counted... see MAX
export const HOSPITAL_MAX = 2;
export const CONVERT_RATE: Record<'armor' | 'artillery', number> = { armor: 40, artillery: 35 }; // units/s per building
export const CONVERT_COST: Record<'armor' | 'artillery', { gold: number; iron: number }> = {
  armor: { gold: 4, iron: 0.5 },
  artillery: { gold: 3, iron: 0.6 },
};

// ---------- troops ----------
export const TROOP_ATTACK: Record<TroopType, number> = { infantry: 1.0, armor: 2.2, artillery: 1.6 };
export const TROOP_DEFENSE: Record<TroopType, number> = { infantry: 1.0, armor: 1.5, artillery: 0.6 };
/** MATCHUP[attacker][defender] */
export const MATCHUP: Record<TroopType, Record<TroopType, number>> = {
  infantry: { infantry: 1.0, armor: 0.8, artillery: 1.3 },
  armor: { infantry: 1.4, armor: 1.0, artillery: 1.6 },
  artillery: { infantry: 1.3, armor: 0.7, artillery: 1.0 },
};
export const VULNERABILITY: Record<TroopType, number> = { infantry: 1.0, armor: 0.6, artillery: 1.0 };
export const ARTILLERY_UNESCORTED_SHARE = 0.4;
export const ARTILLERY_UNESCORTED_VULN = 1.8;
export const ARTILLERY_FORT_BONUS = 2.5;

// ---------- attacks ----------
export const NEUTRAL_TILE_DEF = 9; // units per neutral plains tile
export const DEFENDER_LOSS_PER_TILE = 0.6; // x defender density per tile lost
export const BASE_ATTACK_SPEED = 14; // tiles/s on plains
export const ARMOR_SPEED_BONUS = 1.5; // speed x (1 + armorShare * this)
export const ARTILLERY_SLOW = 0.3;
export const FORCE_SPEED_SCALE = 0.15; // speed x (1 + log10(1 + troops/1000) * this)
export const RETREAT_LOSS = 0.1;
export const MIN_ATTACK_TROOPS = 50;
export const MAX_ATTACKS_PER_PLAYER = 8;
export const ATTACK_SPEED_DEFENDER_FACTOR = true; // denser defenders slow fronts (see combat.ts)

// ---------- supply ----------
export const SUPPLY_RANGE = 45;
export const MIN_SUPPLY_EFF = 0.45;
export const DEFENDER_NO_SUPPLY = 0.85;
export const SUPPLY_RECALC_TICKS = 20;
export const DEPOT_ATTACK_BONUS = 0.1;
export const DEPOT_RADIUS = 30;

// ---------- buildings ----------
export interface BuildingInfo {
  name: string;
  hotkey: string;
  cost: number; // gold
  iron: number;
  costGrowth: number; // cost x (1 + costGrowth * owned)
  buildTime: number; // seconds
  tech: TechId | null;
  coastal: boolean;
  radius: number; // effect radius in tiles, 0 if none
  description: string;
  /** captured with the tile (else destroyed when the tile is taken) */
  capturable: boolean;
}

export const BUILDING_MIN_SPACING = 3;
export const COST_GROWTH = 0.35;

export const BUILDINGS: Record<BuildingType, BuildingInfo> = {
  city: { name: 'City', hotkey: '1', cost: 800, iron: 0, costGrowth: 0.5, buildTime: 8, tech: null, coastal: false, radius: 0, capturable: true, description: '+25k max population per level, gold, supply source. Build again on a city to upgrade (max level 5).' },
  farm: { name: 'Farm', hotkey: '2', cost: 300, iron: 0, costGrowth: 0.3, buildTime: 4, tech: null, coastal: false, radius: 0, capturable: true, description: '+population growth, double on Fertile land.' },
  market: { name: 'Market', hotkey: '3', cost: 500, iron: 0, costGrowth: 0.4, buildTime: 5, tech: null, coastal: false, radius: 0, capturable: true, description: '+12% gold income each (max +120%).' },
  mine: { name: 'Mine', hotkey: '4', cost: 400, iron: 0, costGrowth: 0.3, buildTime: 5, tech: null, coastal: false, radius: 2, capturable: true, description: '+iron. Must be within 2 tiles of an Iron deposit you own.' },
  oilWell: { name: 'Oil Well', hotkey: '5', cost: 450, iron: 20, costGrowth: 0.3, buildTime: 6, tech: null, coastal: false, radius: 2, capturable: true, description: '+oil. Must be within 2 tiles of an Oil deposit you own.' },
  barracks: { name: 'Barracks', hotkey: '6', cost: 600, iron: 0, costGrowth: 0.6, buildTime: 6, tech: null, coastal: false, radius: 0, capturable: true, description: '+15% infantry growth, -5% infantry losses (counts up to 3).' },
  factory: { name: 'Factory', hotkey: '7', cost: 900, iron: 60, costGrowth: 0.5, buildTime: 10, tech: null, coastal: false, radius: 0, capturable: true, description: 'Converts infantry into Armor (set the army mix). Armor burns oil.' },
  arsenal: { name: 'Arsenal', hotkey: '8', cost: 800, iron: 60, costGrowth: 0.5, buildTime: 10, tech: null, coastal: false, radius: 0, capturable: true, description: 'Converts infantry into Artillery (set the army mix).' },
  fort: { name: 'Fort', hotkey: '9', cost: 700, iron: 30, costGrowth: 0.35, buildTime: 8, tech: null, coastal: false, radius: 10, capturable: true, description: 'Defence x2 within 10 tiles. Artillery is strong against forts.' },
  supplyDepot: { name: 'Supply Depot', hotkey: '0', cost: 500, iron: 10, costGrowth: 0.35, buildTime: 6, tech: null, coastal: false, radius: 30, capturable: true, description: 'Supply source; +10% attack for fronts within 30 tiles.' },
  watchtower: { name: 'Watchtower', hotkey: 'Q', cost: 350, iron: 0, costGrowth: 0.3, buildTime: 4, tech: null, coastal: false, radius: 40, capturable: true, description: 'Reveals enemy army size and mix within 40 tiles, +20% defence within 6 tiles, warns of bombers and landings.' },
  port: { name: 'Port', hotkey: 'E', cost: 700, iron: 0, costGrowth: 0.4, buildTime: 8, tech: null, coastal: true, radius: 0, capturable: true, description: 'Coastal. Trade ships (gold), faster free transports, warships (Navigation).' },
  lab: { name: 'Research Lab', hotkey: 'R', cost: 750, iron: 0, costGrowth: 0.5, buildTime: 8, tech: null, coastal: false, radius: 0, capturable: true, description: '+1.5 science/s.' },
  hospital: { name: 'Hospital', hotkey: 'H', cost: 600, iron: 0, costGrowth: 0.6, buildTime: 6, tech: 'medicine', coastal: false, radius: 0, capturable: true, description: '25% of your attack losses come back as workers (counts up to 2).' },
  airfield: { name: 'Airfield', hotkey: 'F', cost: 1200, iron: 80, costGrowth: 0.5, buildTime: 12, tech: 'flight', coastal: false, radius: 40, capturable: false, description: 'Builds bombers and fighters. Fighters intercept bombers within 40 tiles.' },
  sam: { name: 'SAM Site', hotkey: 'G', cost: 900, iron: 60, costGrowth: 0.4, buildTime: 8, tech: 'radar', coastal: false, radius: 30, capturable: false, description: 'Shoots at missiles and aircraft within 30 tiles.' },
  silo: { name: 'Missile Silo', hotkey: 'N', cost: 2000, iron: 150, costGrowth: 0.6, buildTime: 15, tech: 'rocketry', coastal: false, radius: 0, capturable: false, description: 'Launches rockets (Rocketry) and atom bombs (Nuclear Fission).' },
};
export const BUILDING_ORDER: BuildingType[] = [
  'city', 'farm', 'market', 'mine', 'oilWell', 'barracks', 'factory', 'arsenal', 'fort', 'supplyDepot',
  'watchtower', 'port', 'lab', 'hospital', 'airfield', 'sam', 'silo',
];
export const CITY_MAX_LEVEL = 5;
export const FORT_DEFENSE = 2.0;
export const FORT_DEFENSE_TECH = 2.5;
export const FORT_RADIUS_TECH = 14;
export const WATCHTOWER_DEF = 1.2;
export const WATCHTOWER_DEF_RADIUS = 6;
export const BUILDING_DEMOLISH_REFUND = 0.25;

// ---------- research ----------
export interface TechInfo {
  name: string;
  tier: number;
  science: number; // points needed
  gold: number; // paid when starting
  requires: TechId[];
  description: string;
}
export const TECHS: Record<TechId, TechInfo> = {
  agriculture: { name: 'Agriculture', tier: 1, science: 60, gold: 300, requires: [], description: 'Farms +50% growth.' },
  metallurgy: { name: 'Metallurgy', tier: 1, science: 60, gold: 300, requires: [], description: 'Iron +50%; armor and artillery cost 25% less iron.' },
  logistics: { name: 'Logistics', tier: 1, science: 60, gold: 300, requires: [], description: 'Supply range +50%, attack speed +15%.' },
  fortification: { name: 'Fortification', tier: 1, science: 60, gold: 300, requires: [], description: 'Forts x2.5 defence and radius 14.' },
  navigation: { name: 'Navigation', tier: 1, science: 60, gold: 300, requires: [], description: 'Warships; transports +50% speed and +1 at sea.' },
  banking: { name: 'Banking', tier: 2, science: 140, gold: 600, requires: ['agriculture'], description: 'Gold +30%, markets x1.5.' },
  medicine: { name: 'Medicine', tier: 2, science: 140, gold: 600, requires: ['agriculture'], description: 'Hospitals; population growth +20%.' },
  mechanization: { name: 'Mechanization', tier: 2, science: 140, gold: 600, requires: ['metallurgy'], description: 'Armor +25% attack and defence.' },
  ballistics: { name: 'Ballistics', tier: 2, science: 140, gold: 600, requires: ['metallurgy'], description: 'Artillery +30% attack; unescorted penalty starts at 55%.' },
  flight: { name: 'Flight', tier: 2, science: 140, gold: 600, requires: ['logistics'], description: 'Airfields, bombers and fighters.' },
  industrialization: { name: 'Industrialization', tier: 3, science: 260, gold: 1000, requires: ['mechanization'], description: 'Factories and arsenals convert twice as fast; mines and wells +25%.' },
  combinedArms: { name: 'Combined Arms', tier: 3, science: 260, gold: 1000, requires: ['mechanization', 'ballistics'], description: '+20% attack when every troop type is at least 15% of the force.' },
  radar: { name: 'Radar', tier: 3, science: 260, gold: 1000, requires: ['flight'], description: 'SAM sites; watchtower radius x2.' },
  rocketry: { name: 'Rocketry', tier: 3, science: 260, gold: 1000, requires: ['ballistics'], description: 'Missile silos and rockets.' },
  nuclearFission: { name: 'Nuclear Fission', tier: 4, science: 450, gold: 2000, requires: ['rocketry', 'industrialization'], description: 'Atom bombs.' },
};
export const TECH_ORDER: TechId[] = [
  'agriculture', 'metallurgy', 'logistics', 'fortification', 'navigation',
  'banking', 'medicine', 'mechanization', 'ballistics', 'flight',
  'industrialization', 'combinedArms', 'radar', 'rocketry', 'nuclearFission',
];
export const COMBINED_ARMS_MIN_SHARE = 0.15;
export const COMBINED_ARMS_BONUS = 0.2;

// ---------- mobile units ----------
export interface UnitInfo {
  name: string;
  speed: number; // tiles/s
  gold: number;
  iron: number;
  oil: number;
  hp: number;
  tech: TechId | null;
}
export const UNITS: Record<UnitType, UnitInfo> = {
  transport: { name: 'Transport', speed: 6, gold: 150, iron: 0, oil: 0, hp: 1, tech: null },
  warship: { name: 'Warship', speed: 5, gold: 900, iron: 80, oil: 20, hp: 3, tech: 'navigation' },
  tradeShip: { name: 'Trade ship', speed: 4, gold: 0, iron: 0, oil: 0, hp: 1, tech: null },
  bomber: { name: 'Bomber', speed: 18, gold: 500, iron: 30, oil: 40, hp: 1, tech: 'flight' },
  fighter: { name: 'Fighter', speed: 25, gold: 400, iron: 20, oil: 20, hp: 1, tech: 'flight' },
  rocket: { name: 'Rocket', speed: 35, gold: 900, iron: 60, oil: 30, hp: 1, tech: 'rocketry' },
  atomBomb: { name: 'Atom bomb', speed: 22, gold: 6000, iron: 300, oil: 150, hp: 1, tech: 'nuclearFission' },
};
export const TRANSPORT_MAX_AT_SEA = 3;
export const TRANSPORT_PER_PORT = 2;
export const PORT_TRANSPORT_SPEED = 1.6;
export const NAVIGATION_TRANSPORT_SPEED = 1.5;
export const WARSHIP_RANGE = 12;
export const WARSHIP_DAMAGE_PER_S = 0.5; // hp/s to one target in range
export const WARSHIP_BOMBARD_KILL = 6; // defender troops/s killed when an enemy coast tile is in range
export const TRADE_INTERVAL = 25; // seconds between trade ships per port
export const TRADE_GOLD_PER_TILE = 0.9; // gold per tile of path length, to each owner
export const BOMBER_RADIUS = 3;
export const BOMBER_BUILDING_HIT = 0.6; // chance per building in radius
export const BOMBER_TROOP_KILL = 0.04; // share of the defender's army killed x tiles hit / their tiles, min below
export const BOMBER_MIN_KILL = 300;
export const FIGHTER_INTERCEPT = 0.5; // chance per fighter per bomber passing
export const ROCKET_RADIUS = 4;
export const ROCKET_KILL_MIN = 600;
export const ATOM_RADIUS = 22;
export const ATOM_CORE_RADIUS = 8; // tiles turned neutral
export const ATOM_KILL_SHARE: [number, number] = [0.6, 0.9]; // of the army share in the area
export const FALLOUT_SECONDS = 120;
export const SILO_COOLDOWN = 20;
export const SAM_HIT: Record<'rocket' | 'atomBomb' | 'bomber', number> = { rocket: 0.7, atomBomb: 0.5, bomber: 0.35 };
export const SAM_COOLDOWN = 3; // seconds between shots per SAM
export const AIRCRAFT_MAX_PER_AIRFIELD = 6;

// ---------- diplomacy ----------
export const ALLIANCE_DURATION = 300; // seconds
export const ALLIANCE_REQUEST_TIMEOUT = 30;
export const TRAITOR_DURATION = 120;
export const TRAITOR_DEFENSE = 0.7;
export const NUKE_OPINION_PENALTY = 60;
export const BETRAYAL_OPINION_PENALTY = 50;

// ---------- AI ----------
export const AI_NAMES = [
  'Valoria', 'Kestrel Union', 'Drakmar', 'Sundara', 'Ostheim', 'Morrowind Pact', 'Tarsis', 'Ilyria', 'Caldera',
  'Norvik', 'Azuria', 'Brenmoor', 'Qadesh', 'Lysander League', 'Ferrovia', 'Halcyon', 'Zephyria', 'Gorthan',
];
export const AI_COLORS: [number, number, number][] = [
  [220, 60, 60], [60, 110, 230], [240, 190, 40], [150, 70, 200], [40, 190, 170], [240, 120, 40],
  [230, 90, 170], [120, 200, 60], [100, 70, 40], [80, 80, 90], [0, 150, 220], [200, 200, 80],
  [170, 40, 90], [60, 160, 90], [210, 140, 220], [140, 170, 230],
];
export const PERSONALITIES: Personality[] = ['warlord', 'turtle', 'merchant', 'admiral', 'balanced'];
export const AI_DECISION_SECONDS: Record<'easy' | 'normal' | 'hard', number> = { easy: 2.5, normal: 1.5, hard: 1.0 };
export const AI_HARD_INCOME_BONUS = 0.15;
