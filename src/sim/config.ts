// All balance numbers. Rates are per second of game time unless the name says otherwise.
import type { BuildingType, Difficulty, DoctrineId, MapSize, Personality, TechId, TerrainId, TroopType, UnitType } from './types';

export const TICK_SECONDS = 0.1;
export const TICKS_PER_SECOND = 10;
export const SPAWN_SECONDS = 12;
/** Starting territory radius of a nation per map size (tribes: TRIBE_SPAWN_RADIUS). */
export const SPAWN_RADIUS_BY_SIZE: Record<MapSize, number> = { small: 5, medium: 6, large: 7, huge: 8 };
/** Starting territory radius on a medium map (see SPAWN_RADIUS_BY_SIZE). */
export const SPAWN_RADIUS = 6;
/** Starting troops of a nation (tribes x TRIBE_START_FACTOR). */
export const START_TROOPS = 25000;
/** @deprecated one troop pool: same as START_TROOPS */
export const START_INFANTRY = START_TROOPS;
export const START_GOLD = 600;
export const START_IRON = 0;
export const START_OIL = 0;
export const MAX_EVENTS = 200;
export const VICTORY_LAND_SHARE = 0.75;

/** Compact-map modifier: width and height x this (a quarter of the tiles). */
export const COMPACT_SCALE = 0.5;

/** Map sizes in tiles (grand scale: medium about half a million land tiles, huge about 1.8 million). */
export const MAP_SIZES: Record<MapSize, { width: number; height: number }> = {
  small: { width: 900, height: 560 },
  medium: { width: 1400, height: 880 },
  large: { width: 2000, height: 1250 },
  huge: { width: 2600, height: 1600 },
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

// ---------- economy: one troop pool ----------
// Troops live in ONE pool (Player.troops: infantry, armor, artillery at home). The pool has a cap and regrows toward it
// (economy.ts). There are no workers: gold comes from a flat base income, land, cities, markets and trade.
/**
 * Troop cap = TROOP_CAP_BASE + TROOP_CAP_LAND x (land weight)^TROOP_CAP_LAND_EXP + CITY_TROOP_CAP per city level
 * + CAPITAL_TROOP_CAP + FARM_TROOP_CAP per farm (x2 on Fertile). Land weight = sum over owned land of the terrain's
 * pop/tile / 30 (plains 1, mountains 0.17; fallout tiles 0). Sublinear in land: about 130k at the start (110 tiles),
 * 430k at 5 000 plains tiles, 860k at 20 000, 1.25M at 40 000. Early land is worth a lot, a huge empire's last tiles
 * little; cities are the scaling lever. Tribes x TRIBE_CAP_FACTOR.
 */
export const TROOP_CAP_BASE = 60000;
export const TROOP_CAP_LAND = 2000;
export const TROOP_CAP_LAND_EXP = 0.6;
export const CITY_TROOP_CAP = 60000; // per city level
export const CAPITAL_TROOP_CAP = 40000;
export const FARM_TROOP_CAP = 12000; // per finished farm (x2 on Fertile)
/**
 * Growth per second = (TROOP_GROWTH_BASE + TROOP_GROWTH_K x troops^TROOP_GROWTH_EXP) x (1 - troops / cap). It peaks
 * at about 42% of the cap (0.73 / 1.73): a full bar barely grows, so spending troops is always right. Above the cap
 * (land lost) the same formula is negative and the pool shrinks back to it.
 */
export const TROOP_GROWTH_BASE = 60;
export const TROOP_GROWTH_K = 1.5;
export const TROOP_GROWTH_EXP = 0.73;
export const FARM_GROWTH_BONUS = 0.04; // +4% troop growth per finished farm (x2 on Fertile), counted up to FARM_MAX
export const FARM_MAX = 12;
/** Gold/s = GOLD_BASE + GOLD_LAND x (land weight)^TROOP_CAP_LAND_EXP + CITY_GOLD per city level, x markets, Banking. */
export const GOLD_BASE = 8;
export const GOLD_LAND = 0.45;
export const CITY_GOLD = 5; // per city level
export const MARKET_GOLD_BONUS = 0.12; // +12% gold per market
export const MARKET_MAX_BONUS = 0.8;
export const IRON_PER_MINE = 5.0;
export const OIL_PER_WELL = 2.5;
export const BASE_SCIENCE = 0.5;
export const SCIENCE_PER_LAB = 1.0;
export const ARMOR_OIL_UPKEEP = 0.000004; // oil per armor unit per second (one well feeds about 600k armor)
export const AIRCRAFT_OIL_UPKEEP = 0.02; // oil per stored aircraft per second
export const NO_OIL_ARMOR_FACTOR = 0.5;
export const BARRACKS_GROWTH_BONUS = 0.1; // +10% troop growth per barracks
export const BARRACKS_LOSS_REDUCTION = 0.05;
export const BARRACKS_MAX = 3;
export const HOSPITAL_RECOVERY = 0.15; // share of attack losses that come back as troops, per hospital
export const HOSPITAL_MAX = 2;
export const CONVERT_RATE: Record<'armor' | 'artillery', number> = { armor: 400, artillery: 350 }; // units/s per building
/** Big armies convert faster: per building at least this share of the whole army per second. */
export const CONVERT_ARMY_SHARE = 0.0015;
export const CONVERT_COST: Record<'armor' | 'artillery', { gold: number; iron: number }> = {
  armor: { gold: 0.025, iron: 0.0008 },
  artillery: { gold: 0.02, iron: 0.0009 },
};

// ---------- troops ----------
export const TROOP_ATTACK: Record<TroopType, number> = { infantry: 1.0, armor: 2.2, artillery: 1.8 };
/** Artillery at home shells attackers: it defends like infantry (it used to be 0.6, a liability on defence). */
export const TROOP_DEFENSE: Record<TroopType, number> = { infantry: 1.0, armor: 1.5, artillery: 1.0 };
/** MATCHUP[attacker][defender] */
export const MATCHUP: Record<TroopType, Record<TroopType, number>> = {
  infantry: { infantry: 1.0, armor: 0.8, artillery: 1.3 },
  armor: { infantry: 1.4, armor: 1.0, artillery: 1.6 },
  artillery: { infantry: 1.3, armor: 0.7, artillery: 1.0 },
};
export const VULNERABILITY: Record<TroopType, number> = { infantry: 1.0, armor: 0.6, artillery: 1.0 };
export const ARTILLERY_UNESCORTED_SHARE = 0.4;
export const ARTILLERY_UNESCORTED_VULN = 1.8;
/**
 * Siege bonus: artillery attack x this against a tile a fort covers (fort multiplier >= FORT_DEFENSE). Lighter cover
 * (a watchtower, x1.2) gives part of it: x 1 + (this - 1) x (multiplier - 1) / (FORT_DEFENSE - 1). See
 * combat.artillerySiegeBonus.
 */
export const ARTILLERY_FORT_BONUS = 3;

// ---------- attacks ----------
// A click picks the TARGET OWNER (a nation, a tribe or wilderness), never a point: the whole shared border advances.
// Each tick an attack takes about (front tiles) x (rate per front tile) x 0.1 s tiles, in priority order (tiles it
// already half surrounds first, easy ground first, roughly first in first out). Troop types, terrain, forts, supply
// and techs only modify the costs and the speed (combat.ts).
/** Wilderness: troops lost per tile = this x terrain defence (plains 16, mountains 40), / attack power per unit. */
export const NEUTRAL_LOSS_PER_TILE = 16;
/**
 * Wilderness speed: tiles/s per front tile = NEUTRAL_FRONT_RATE / clamp(NEUTRAL_SPEED_TROOPS / troops, 5, 100).
 * About 3/s per front tile with 5 000 troops, at most 4/s (a flood fill) and 0.2/s for a handful.
 */
export const NEUTRAL_FRONT_RATE = 20;
export const NEUTRAL_SPEED_TROOPS = 33000;
export const NEUTRAL_SPEED_CLAMP: [number, number] = [5, 100];
/**
 * Nations: tiles/s per front tile on plains at even odds; divided by clamp(1 / odds, ODDS_SPEED) when outnumbered
 * (hopeless odds crawl, down to x0.13); outnumbering speeds it up modestly along the force-limit curve below
 * (ODDS_SPEED_GAIN; [0] is the ceiling, x1.25).
 */
export const NATION_FRONT_RATE = 5.2;
export const ODDS_SPEED: [number, number] = [0.8, 7.5];
/**
 * Attacker losses per tile vs a nation: ATTACK_LOSS_BASE x terrain defence x forts x loss factor x (LOSS_FLAT +
 * LOSS_DENSITY x defender density) / attack power per unit, x heartland and last-stand bonuses. Odds = attack strength
 * / the defender's home army strength: send more, lose less (loss factor x0.61 at 2:1, x0.54 at 3:1, never under
 * OUTNUMBER_LOSS[0] (force limit); clamp(1 / odds) up to x2 at 1:2 or worse).
 */
export const ATTACK_LOSS_BASE = 200;
export const OUTNUMBER_LOSS: [number, number] = [0.52, 2];
export const LOSS_FLAT = 0.8;
export const LOSS_DENSITY = 0.04;
/** The defender loses this x its density (home troops per tile) for every tile taken. */
export const DEFENDER_LOSS_PER_TILE = 1;
/** Attacking a tribe costs x this (they are food). */
export const TRIBE_TARGET_LOSS = 0.7;
/** Tribes expanding into wilderness pay x this. */
export const TRIBE_NEUTRAL_LOSS = 0.5;
/** A front counts as at least this many tiles (a beachhead or a gap still moves). */
export const FRONT_MIN_TILES = 4;
/** Performance guard: at most this many tiles per attack per tick (never reached by normal fronts). */
export const MAX_TILES_PER_TICK = 1500;
export const ARMOR_SPEED_BONUS = 0.6; // speed x (1 + armorShare * this)
export const ARTILLERY_SLOW = 0.15; // speed x (1 - artilleryShare * this)
/** Fronts move x this slower through a fort's cover. */
export const FORT_SLOW = 2;
/** Guns breach forts: the extra fort slowdown x (1 - artillery share x this), gone at 50% artillery. */
export const ARTILLERY_FORT_BREACH = 2;
/** Front priority (lower first): tick + (FRONT_JITTER_MIN .. +SPAN) x (1 - NEIGHBOUR x owned 4-neighbours + TERRAIN x (1/speed - 1)). */
export const FRONT_JITTER_MIN = 8;
export const FRONT_JITTER_SPAN = 10;
export const FRONT_NEIGHBOUR_WEIGHT = 0.25;
export const FRONT_TERRAIN_WEIGHT = 0.5;
// ---------- force limit, heartland, last stand (DESIGN 4.6) ----------
/**
 * Force limit: odds (attack strength / the defender's home army defence) past this add strongly diminishing benefit.
 * Effective odds e = odds up to it, then K + K x FORCE_LIMIT_TAIL x x / (x + K) with x = odds - K, so e never passes
 * K x (1 + FORCE_LIMIT_TAIL): a 10x army fights like a 3.5x one.
 */
export const FORCE_LIMIT_ODDS = 3;
export const FORCE_LIMIT_TAIL = 0.25;
/**
 * Outnumbering (e > 1) speeds the front up by x (1 + ODDS_SPEED_GAIN x (e - 1) / (e - 1 + ODDS_SPEED_HALF)) (x1.2
 * at 2:1, x1.24 at 3:1, never more than x1.25) and cuts attacker losses by x (1 - OUTNUMBER_LOSS_GAIN x (e - 1) /
 * (e - 1 + OUTNUMBER_LOSS_HALF)) (x0.69 at 3:2, x0.61 at 2:1, x0.54 at 3:1, x0.52 at most). Being outnumbered
 * (e < 1) still uses ODDS_SPEED / OUTNUMBER_LOSS[1] (x 1 / clamp(1 / e, ...)).
 */
export const ODDS_SPEED_GAIN = 0.3;
export const ODDS_SPEED_HALF = 0.5;
export const OUTNUMBER_LOSS_GAIN = 0.55;
export const OUTNUMBER_LOSS_HALF = 0.4;
/**
 * Heartland: tiles of a nation within this radius of its CAPITAL (not other cities) defend better: attacker losses
 * x (1 + HEARTLAND_DEFENSE x f) and the front x 1 / (1 + HEARTLAND_SLOW x f) slower, f = 1 at the capital fading
 * linearly to 0 at the edge. Radius = BASE + PER_SQRT_TILE x sqrt(tiles) + PER_CITY_LEVEL x the capital's city level,
 * at most MAX. When the capital is lost, the heartland moves to the new one after HEARTLAND_MOVE_SECONDS. Tribes have
 * none.
 */
export const HEARTLAND_RADIUS_BASE = 9;
export const HEARTLAND_RADIUS_PER_SQRT_TILE = 0.12;
export const HEARTLAND_RADIUS_PER_CITY_LEVEL = 1.5;
export const HEARTLAND_RADIUS_MAX = 30;
export const HEARTLAND_DEFENSE = 0.8;
export const HEARTLAND_SLOW = 0.6;
export const HEARTLAND_MOVE_SECONDS = 30;
/**
 * Last stand: a nation much smaller than its attacker (gap = the larger of army ratio and land ratio, whole armies
 * incl. troops out in attacks) defends better everywhere: bonus b = LAST_STAND_MAX x clamp((gap - START) / (FULL -
 * START), 0, 1); attacker losses x (1 + b), the front x 1 / (1 + LAST_STAND_SLOW x b) slower. Tribes neither get nor
 * trigger it.
 */
export const LAST_STAND_START = 2;
export const LAST_STAND_FULL = 8;
export const LAST_STAND_MAX = 1;
export const LAST_STAND_SLOW = 1;
/** Heartland x last stand never multiplies a tile's defence (losses) or slowdown by more than this. */
export const DEFENSE_BONUS_CAP = 3.5;

/** Retreat: share of the troops lost (vs a nation; wilderness: nothing). */
export const RETREAT_LOSS = 0.25;
export const MIN_ATTACK_TROOPS = 100;
export const MAX_ATTACKS_PER_PLAYER = 8;
/** A landed invasion's beachhead tile is a supply source for this long (seconds). */
export const BEACHHEAD_SUPPLY_SECONDS = 60;
/** Clicking land you can't reach by land sends a transport to the nearest coast of that owner within this radius. */
export const BOAT_LANDING_RADIUS = 120;

// ---------- endgame ----------
/** A nation with fewer tiles than this collapses when hit: the attacker takes all of its land at once. */
export const ENDGAME_SMALL_TILES = 150;
/**
 * A human nation's first this many seconds of game time: it neither collapses when hit nor is absorbed when
 * surrounded (its 81-tile start is under ENDGAME_SMALL_TILES), so a new or slow player gets time to grow.
 */
export const HUMAN_GRACE_SECONDS = 180;
/** Same for tribes (they are food). */
export const TRIBE_ANNEX_TILES = 250;
/** Every this many seconds (per player, staggered): enclaves fully surrounded by one hostile nation are annexed by it. */
export const ENCLAVE_CHECK_SECONDS = 2;
/** Overtime: after this many minutes the land share needed to win drops by OVERTIME_DROP_PER_MINUTE ... */
export const OVERTIME_MINUTES = 25;
export const OVERTIME_DROP_PER_MINUTE = 0.01;
/** ... down to this share. */
export const OVERTIME_MIN_SHARE = 0.5;

// ---------- supply ----------
// Cheap model: a front tile's supply distance is the straight-line distance to the nearest own supply source
// (capital, finished cities and depots, live beachheads), no path search.
export const SUPPLY_RANGE = 110;
export const MIN_SUPPLY_EFF = 0.45;
export const DEFENDER_NO_SUPPLY = 0.85;
export const DEPOT_ATTACK_BONUS = 0.1;
export const DEPOT_RADIUS = 60;

// ---------- buildings ----------
// Buildings are few and levelled (DESIGN section 5): a build order near an own building of the same type upgrades it
// (BUILDING_UPGRADE_RADIUS), otherwise the sim snaps the order to the nearest valid own tile (BUILDING_SNAP_RADIUS)
// at least the map size's spacing away from every other building. Every effect scales with the level.
export interface BuildingInfo {
  name: string;
  hotkey: string;
  cost: number; // gold
  iron: number;
  /** price x (1 + costGrowth x levels of this type you already own, incl. unfinished and upgrading) */
  costGrowth: number;
  buildTime: number; // seconds (an upgrade takes the same time)
  tech: TechId | null;
  coastal: boolean;
  radius: number; // effect radius in tiles at level 1, 0 if none
  /** highest level (upgrades stop there) */
  maxLevel: number;
  description: string;
  /** captured with the tile (else destroyed when the tile is taken) */
  capturable: boolean;
}

/** Minimum distance (tiles, straight line) between any two buildings on a medium map; see BUILDING_MIN_SPACING_BY_SIZE. */
export const BUILDING_MIN_SPACING = 12;
/** Minimum distance between any two buildings per map size (grand-scale maps: fewer, bigger buildings). */
export const BUILDING_MIN_SPACING_BY_SIZE: Record<MapSize, number> = { small: 10, medium: 12, large: 14, huge: 15 };
/** A build order within this many tiles of an own building of the same type upgrades that building. */
export const BUILDING_UPGRADE_RADIUS = 12;
/** Otherwise the order snaps to the nearest valid own tile within this many tiles of the clicked one. */
export const BUILDING_SNAP_RADIUS = 10;
export const COST_GROWTH = 0.35;

export const BUILDINGS: Record<BuildingType, BuildingInfo> = {
  city: { name: 'City', hotkey: '1', cost: 800, iron: 0, costGrowth: 0.5, buildTime: 8, tech: null, coastal: false, radius: 0, maxLevel: 6, capturable: true, description: 'More troops (+60k cap) and gold per level; a supply source. Build near it again to upgrade.' },
  farm: { name: 'Farm', hotkey: '2', cost: 300, iron: 0, costGrowth: 0.3, buildTime: 4, tech: null, coastal: false, radius: 0, maxLevel: 5, capturable: true, description: 'More troops (+12k cap) and +4% troop growth per level, double on Fertile land.' },
  market: { name: 'Market', hotkey: '3', cost: 500, iron: 0, costGrowth: 0.4, buildTime: 5, tech: null, coastal: false, radius: 0, maxLevel: 5, capturable: true, description: '+12% gold per level (all markets together at most +80%).' },
  mine: { name: 'Mine', hotkey: '4', cost: 400, iron: 0, costGrowth: 0.3, buildTime: 5, tech: null, coastal: false, radius: 2, maxLevel: 5, capturable: true, description: 'Iron per level (armor, artillery and forts need it). Must be next to an Iron deposit you own.' },
  oilWell: { name: 'Oil Well', hotkey: '5', cost: 450, iron: 20, costGrowth: 0.3, buildTime: 6, tech: null, coastal: false, radius: 2, maxLevel: 5, capturable: true, description: 'Oil per level (armor and aircraft burn it). Must be next to an Oil deposit you own.' },
  barracks: { name: 'Barracks', hotkey: '6', cost: 600, iron: 0, costGrowth: 0.6, buildTime: 6, tech: null, coastal: false, radius: 0, maxLevel: 3, capturable: true, description: '+10% troop growth and -5% infantry losses per level (3 levels count).' },
  factory: { name: 'Factory', hotkey: '7', cost: 900, iron: 60, costGrowth: 0.5, buildTime: 10, tech: null, coastal: false, radius: 0, maxLevel: 5, capturable: true, description: 'Turns troops into Armor (fast, strong on open ground; burns oil). Faster per level.' },
  arsenal: { name: 'Arsenal', hotkey: '8', cost: 800, iron: 60, costGrowth: 0.5, buildTime: 10, tech: null, coastal: false, radius: 0, maxLevel: 5, capturable: true, description: 'Turns troops into Artillery (beats forts; fires barrages). Faster per level.' },
  fort: { name: 'Fort', hotkey: '9', cost: 700, iron: 30, costGrowth: 0.35, buildTime: 8, tech: null, coastal: false, radius: 20, maxLevel: 5, capturable: true, description: 'Attackers lose x2 and move half as fast nearby; stronger and wider per level. Artillery beats forts.' },
  supplyDepot: { name: 'Supply Depot', hotkey: '0', cost: 500, iron: 10, costGrowth: 0.35, buildTime: 6, tech: null, coastal: false, radius: 60, maxLevel: 3, capturable: true, description: 'Supplies your fronts nearby and gives them +10% attack; wider per level.' },
  watchtower: { name: 'Watchtower', hotkey: 'Q', cost: 350, iron: 0, costGrowth: 0.3, buildTime: 4, tech: null, coastal: false, radius: 80, maxLevel: 3, capturable: true, description: 'Shows the troop mix of nearby enemies, +20% defence close by, warns of planes and landings. Wider per level.' },
  port: { name: 'Port', hotkey: 'E', cost: 700, iron: 0, costGrowth: 0.4, buildTime: 8, tech: null, coastal: true, radius: 0, maxLevel: 5, capturable: true, description: 'Coastal. Trade ships (gold), free fast transports, warships. More of all per level.' },
  lab: { name: 'Research Lab', hotkey: 'R', cost: 750, iron: 0, costGrowth: 0.7, buildTime: 8, tech: null, coastal: false, radius: 0, maxLevel: 5, capturable: true, description: '+1 science/s per level.' },
  hospital: { name: 'Hospital', hotkey: 'H', cost: 600, iron: 0, costGrowth: 0.6, buildTime: 6, tech: 'medicine', coastal: false, radius: 0, maxLevel: 2, capturable: true, description: '15% of your attack losses come back as troops, per level (2 levels count).' },
  airfield: { name: 'Airfield', hotkey: 'F', cost: 1200, iron: 80, costGrowth: 0.5, buildTime: 12, tech: 'flight', coastal: false, radius: 80, maxLevel: 3, capturable: false, description: 'Bombers, fighters (cover nearby) and paratroopers. More planes, range and drop size per level.' },
  sam: { name: 'SAM Site', hotkey: 'G', cost: 900, iron: 60, costGrowth: 0.4, buildTime: 8, tech: 'radar', coastal: false, radius: 60, maxLevel: 3, capturable: false, description: 'Shoots down planes and missiles nearby; one more shot per salvo and a wider reach per level.' },
  silo: { name: 'Missile Silo', hotkey: 'N', cost: 2000, iron: 150, costGrowth: 0.6, buildTime: 15, tech: 'rocketry', coastal: false, radius: 0, maxLevel: 3, capturable: false, description: 'Launches rockets (Rocketry) and atom bombs (Nuclear Fission); one launch slot per level.' },
};
export const BUILDING_ORDER: BuildingType[] = [
  'city', 'farm', 'market', 'mine', 'oilWell', 'barracks', 'factory', 'arsenal', 'fort', 'supplyDepot',
  'watchtower', 'port', 'lab', 'hospital', 'airfield', 'sam', 'silo',
];
/** @deprecated use BUILDINGS.city.maxLevel (buildings.buildingMaxLevel) */
export const CITY_MAX_LEVEL = BUILDINGS.city.maxLevel;
export const FORT_DEFENSE = 2.0;
export const FORT_DEFENSE_TECH = 2.5;
export const FORT_RADIUS_TECH = 28;
/** Per fort level above 1: defence multiplier + this, radius + FORT_LEVEL_RADIUS tiles. */
export const FORT_LEVEL_DEFENSE = 0.25;
export const FORT_LEVEL_RADIUS = 3;
export const WATCHTOWER_DEF = 1.2;
export const WATCHTOWER_DEF_RADIUS = 12;
/** Watchtower intel radius + this per level above 1 (Radar doubles the total). */
export const WATCHTOWER_LEVEL_RADIUS = 20;
/** SAM radius + this per level above 1 (a level-L SAM fires L shots before it must reload). */
export const SAM_LEVEL_RADIUS = 10;
/** Airfield fighter cover radius + this per level above 1. */
export const AIRFIELD_LEVEL_RADIUS = 15;
/** Supply depot attack-bonus radius + this per level above 1. */
export const DEPOT_LEVEL_RADIUS = 15;
/** Trade ship gold x (1 + this x (port level - 1)). */
export const PORT_LEVEL_TRADE = 0.5;
export const BUILDING_DEMOLISH_REFUND = 0.25;
/** Damaged buildings (barrages) repair this much hp per second (hp 1 = intact). */
export const BUILDING_REPAIR_PER_S = 0.01;

// ---------- special land abilities ----------
/**
 * Paratroopers (Action 'paradrop', units.ts): needs Flight and a finished own Airfield. Infantry board a cargo plane
 * (UNITS.transportPlane, flies like a bomber and can be shot down by SAMs and fighters on the way; troops aboard die)
 * to an enemy or neutral land tile within PARADROP_RANGE (+ PARADROP_RANGE_PER_LEVEL per airfield level above 1).
 * On arrival an attack starts from that tile against its owner (a beachhead: the tile is taken first), or the troops
 * come home if it is own / allied land by then. Per drop at most airfield level x max(PARADROP_TROOPS_PER_LEVEL,
 * PARADROP_ARMY_SHARE_PER_LEVEL x your whole army). One drop per airfield every PARADROP_COOLDOWN seconds.
 */
export const PARADROP_RANGE = 120;
export const PARADROP_RANGE_PER_LEVEL = 30;
export const PARADROP_COOLDOWN = 30;
export const PARADROP_TROOPS_PER_LEVEL = 15000;
export const PARADROP_ARMY_SHARE_PER_LEVEL = 0.05;
export const PARADROP_MIN_TROOPS = 500;
/**
 * Artillery barrage (Action 'barrage', barrage.ts): needs at least BARRAGE_MIN_ARTILLERY artillery (at home and in
 * attacks). Target: enemy land within BARRAGE_RANGE (Ballistics x BARRAGE_BALLISTICS_RANGE) of your own land. The
 * shells land BARRAGE_DELAY seconds later on a disc of BARRAGE_RADIUS: they kill defender troops
 * (BARRAGE_KILL_MAX x artillery / (artillery + BARRAGE_KILL_HALF), at most BARRAGE_KILL_ARMY_SHARE of each victim's
 * home army), knock out forts and SAM sites (-BARRAGE_BUILDING_DAMAGE hp, no effect for BARRAGE_DISABLE_SECONDS;
 * shells are not aircraft, SAMs never stop them) and destroy other buildings with BARRAGE_DESTROY_CHANCE. The front
 * does not move. One barrage per player every BARRAGE_COOLDOWN seconds (Ballistics: BARRAGE_COOLDOWN_BALLISTICS).
 */
export const BARRAGE_MIN_ARTILLERY = 2000;
export const BARRAGE_RANGE = 20;
export const BARRAGE_BALLISTICS_RANGE = 1.5;
export const BARRAGE_RADIUS = 6;
export const BARRAGE_DELAY = 2;
export const BARRAGE_COOLDOWN = 15;
export const BARRAGE_COOLDOWN_BALLISTICS = 10;
export const BARRAGE_GOLD = 100;
/** Kills scale with the guns: about 15% of your artillery count for small batteries, 10% at 1M, at most 300k. */
export const BARRAGE_KILL_MAX = 300000;
export const BARRAGE_KILL_HALF = 2000000;
export const BARRAGE_KILL_ARMY_SHARE = 0.08;
export const BARRAGE_BUILDING_DAMAGE = 0.25;
export const BARRAGE_DISABLE_SECONDS = 20;
export const BARRAGE_DESTROY_CHANCE = 0.1;

// ---------- research ----------
export interface TechInfo {
  name: string;
  tier: number;
  science: number; // points needed
  gold: number; // paid when starting
  requires: TechId[];
  description: string;
  /**
   * Exclusive choice group (techtree.ts): researching one tech of a group locks the others of that group for the
   * rest of the game. Absent = an ordinary tech.
   */
  exclusiveGroup?: string;
  /** at least one of these must be researched too (a tech after a choice: either branch leads on) */
  requiresAny?: TechId[];
}
export const TECHS: Record<TechId, TechInfo> = {
  agriculture: { name: 'Agriculture', tier: 1, science: 150, gold: 300, requires: [], description: 'Farms +50% growth.' },
  metallurgy: { name: 'Metallurgy', tier: 1, science: 150, gold: 300, requires: [], description: 'Iron +50%; armor and artillery cost 25% less iron.' },
  logistics: { name: 'Logistics', tier: 1, science: 150, gold: 300, requires: [], description: 'Supply range +50%, attack speed +15%.' },
  fortification: { name: 'Fortification', tier: 1, science: 150, gold: 300, requires: [], description: 'Forts x2.5 and radius 28.' },
  navigation: { name: 'Navigation', tier: 1, science: 150, gold: 300, requires: [], description: 'Warships; transports +50% speed and +1 at sea.' },
  banking: { name: 'Banking', tier: 2, science: 600, gold: 600, requires: ['agriculture'], description: 'Gold +30%, markets x1.25.' },
  medicine: { name: 'Medicine', tier: 2, science: 600, gold: 600, requires: ['agriculture'], description: 'Hospitals; troop growth +20%.' },
  mechanization: { name: 'Mechanization', tier: 2, science: 600, gold: 600, requires: ['metallurgy'], description: 'Armor +25% attack and defence.' },
  ballistics: { name: 'Ballistics', tier: 2, science: 600, gold: 600, requires: ['metallurgy'], description: 'Artillery +30% attack; unescorted penalty starts at 55%; barrages reach x1.5 farther and reload faster.' },
  flight: { name: 'Flight', tier: 2, science: 600, gold: 600, requires: ['logistics'], description: 'Airfields, bombers and fighters.' },
  industrialization: { name: 'Industrialization', tier: 3, science: 2200, gold: 1000, requires: ['mechanization'], description: 'Factories and arsenals convert twice as fast; mines and wells +25%.' },
  combinedArms: { name: 'Combined Arms', tier: 3, science: 2200, gold: 1000, requires: ['mechanization', 'ballistics'], description: '+20% attack when every troop type is at least 15% of the force.' },
  radar: { name: 'Radar', tier: 3, science: 2200, gold: 1000, requires: ['flight'], description: 'SAM sites; watchtower radius x2.' },
  rocketry: { name: 'Rocketry', tier: 3, science: 2200, gold: 1000, requires: ['ballistics'], description: 'Missile silos and rockets.' },
  nuclearFission: { name: 'Nuclear Fission', tier: 4, science: 3500, gold: 1500, requires: ['rocketry', 'industrialization'], description: 'Atom bombs.' },
  // ---- branches with exclusive choices (techtree.ts; numbers in the TECH_EFFECTS block below) ----
  propaganda: { name: 'Propaganda', tier: 2, science: 600, gold: 600, requires: ['agriculture'], description: 'Attacks on your land cost the attacker 12% more troops.' },
  railways: { name: 'Railways', tier: 3, science: 2200, gold: 1000, requires: ['logistics'], description: 'Supply range +25%, fronts +10% faster, tank divisions 20% cheaper, +1 division per 2 Factory levels.' },
  stockExchange: { name: 'Stock Exchange', tier: 3, science: 2200, gold: 1000, requires: ['banking'], exclusiveGroup: 'finance', description: 'Saved gold earns interest (up to +20% gold income while you hold a reserve).' },
  freeTrade: { name: 'Free Trade', tier: 3, science: 2200, gold: 1000, requires: ['banking'], exclusiveGroup: 'finance', description: 'Your trade ships pay 60% more; markets cost 30% less.' },
  blitzTactics: { name: 'Blitz Tactics', tier: 3, science: 2200, gold: 1000, requires: ['mechanization'], exclusiveGroup: 'landDoctrine', description: 'Armor-heavy attacks advance up to 30% faster; tank divisions faster and deeper.' },
  trenchWarfare: { name: 'Trench Warfare', tier: 3, science: 2200, gold: 1000, requires: ['mechanization'], exclusiveGroup: 'landDoctrine', description: 'Your land defends 15% better, enemy fronts against you 15% slower, forts 25% cheaper.' },
  // Navy path (Arsenal, variants.ts): Surface fleet (Destroyers -> Battleships) OR Silent service (Submarines -> Carriers)
  carriers: { name: 'Carriers', tier: 4, science: 3500, gold: 1500, requires: ['submarines'], description: 'Build carriers: a moving airfield. Your air wings strike from them far out at sea; their fighters shoot down enemy bombers and cargo planes nearby.' },
  submarines: { name: 'Submarines', tier: 3, science: 2200, gold: 1000, requires: ['navigation'], exclusiveGroup: 'navalDoctrine', description: 'Silent service: build submarines. Hidden from enemies until close; they hit trade ships and transports much harder, blockade further and capture richer cargo. No shore bombardment.' },
  // Air path (Arsenal): Ground-attack planes (-> Jet Engines) OR Heavy bombers (-> Strategic Bombing)
  jetEngines: { name: 'Jet Engines', tier: 4, science: 3500, gold: 1500, requires: ['groundAttack'], description: 'Bombers and cargo planes fly 40% faster; bombers survive one more hit; escorts win their duels.' },
  strategicBombing: { name: 'Strategic Bombing', tier: 4, science: 3500, gold: 1500, requires: ['heavyBombers'], description: 'Bombs hit a 40% wider area, wreck more buildings and burn 6% of the victim\'s gold and iron.' },
  diplomaticCorps: { name: 'Diplomatic Corps', tier: 3, science: 2200, gold: 1000, requires: ['propaganda'], exclusiveGroup: 'statecraft', description: 'Allies trust you sooner, help more (aid +40%) and can be asked twice as often.' },
  conscription: { name: 'Conscription', tier: 3, science: 2200, gold: 1000, requires: ['propaganda'], exclusiveGroup: 'statecraft', description: 'Troop cap +5%, troop growth +6%, mercenaries 25% cheaper.' },
  industrialBoom: { name: 'Industrial Boom', tier: 4, science: 5000, gold: 2000, requires: ['banking'], requiresAny: ['stockExchange', 'freeTrade'], description: 'Gold, iron and oil +12%.' },
  massMobilization: { name: 'Mass Mobilization', tier: 5, science: 8000, gold: 3000, requires: ['industrialBoom'], exclusiveGroup: 'capstone', description: 'Troop cap +12% and every attack +6% stronger.' },
  automation: { name: 'Automation', tier: 5, science: 8000, gold: 3000, requires: ['industrialBoom'], exclusiveGroup: 'capstone', description: 'Buildings and upgrades build 35% faster and cost 10% less.' },  // ---- special upgrades: behaviour, not stats (specials.ts; numbers in the SPECIALS block) ----
  amphibiousTanks: { name: 'Amphibious Tanks', tier: 3, science: 2200, gold: 1000, requires: ['mechanization', 'navigation'], description: 'Tank divisions wade across straits and rivers up to 5 tiles wide (moves and spearheads); each landing costs 8% of the division, and warships and mines hit divisions in the water.' },
  earlyWarning: { name: 'Early Warning', tier: 4, science: 3500, gold: 1500, requires: ['radar'], description: 'SAMs and fighters engage 40% farther out; your coast and air sites spot enemy submarines from twice as far; night bombers dodge you much less.' },
  navalMines: { name: 'Naval Mines', tier: 3, science: 2200, gold: 1000, requires: ['navigation', 'fortification'], description: 'The sea around your ports is mined: enemy warships and submarines there take damage, invasions sailing through lose troops. Your ships and your allies\' are safe; escorts sweep a lane.' },
  dropTanks: { name: 'Drop Tanks', tier: 3, science: 2200, gold: 1000, requires: ['flight'], description: 'Air wings reach 60% farther, paratroopers 50% farther, fighter patrols cover 30% more.' },
  nightBombing: { name: 'Night Bombing', tier: 3, science: 2200, gold: 1000, requires: ['flight'], description: 'Bombers dodge 75% of SAM and fighter fire (35% against Early Warning) but bomb less accurately: scattered, 25% weaker.' },
  // ---- arsenal: vehicle variant paths, shared unlocks, masteries (arsenal.ts, variants.ts; numbers in ARSENAL) ----
  destroyers: { name: 'Destroyers', tier: 3, science: 2200, gold: 1000, requires: ['navigation'], exclusiveGroup: 'navalDoctrine', description: 'Surface fleet: build destroyers. Fast; they spot submarines nearby and hit them very hard.' },
  battleships: { name: 'Battleships', tier: 4, science: 3500, gold: 1500, requires: ['destroyers'], description: 'Build battleships: slow and expensive, very tough; they shell enemy coast from twice as far and much harder.' },
  lightTanks: { name: 'Light Tanks', tier: 3, science: 2200, gold: 1000, requires: ['mechanization'], exclusiveGroup: 'armorPath', description: 'Your tank divisions become light tanks: cheaper and much faster, deeper thin spearheads that reveal the enemy ahead. Forts, hills and mountains hurt them more.' },
  heavyTanks: { name: 'Heavy Tanks', tier: 3, science: 2200, gold: 1000, requires: ['mechanization'], exclusiveGroup: 'armorPath', description: 'Your tank divisions become heavy tanks: slower and dearer, but they break through forts and mountains and hold ground better.' },
  deepRaids: { name: 'Deep Raids', tier: 4, science: 3500, gold: 1500, requires: ['lightTanks'], description: 'Light tank spearheads run 30% deeper and 15% faster; divisions refit 50% faster.' },
  siegeTanks: { name: 'Siege Tanks', tier: 4, science: 3500, gold: 1500, requires: ['heavyTanks'], description: 'Heavy spearheads knock out the forts they pass and lose half as much in forts and mountains.' },
  groundAttack: { name: 'Ground-attack Planes', tier: 3, science: 2200, gold: 1000, requires: ['flight'], exclusiveGroup: 'airDoctrine', description: 'Your bombers become ground-attack planes: front support strikes hit 60% harder; strategic raids are weaker.' },
  heavyBombers: { name: 'Heavy Bombers', tier: 3, science: 2200, gold: 1000, requires: ['flight'], exclusiveGroup: 'airDoctrine', description: 'Your bombers become heavy bombers: strategic raids hit 70% harder, 50% longer range, one more hit; front support is weaker.' },
  mechInfantry: { name: 'Mechanized Infantry', tier: 3, science: 2200, gold: 1000, requires: ['mechanization'], description: 'Infantry rides with your tanks: spearheads lose 15% less, and the land they take holds (attacks on it cost 40% more for a minute).' },
  reconPlanes: { name: 'Recon Planes', tier: 3, science: 1500, gold: 800, requires: ['flight'], description: 'Airfields fly recon: reveal enemy armies, doctrines, buildings and submarines in a wide circle for 40 seconds.' },
  navalMastery: { name: 'Naval Mastery', tier: 5, science: 8000, gold: 3000, requires: ['navigation'], requiresAny: ['battleships', 'carriers'], description: 'Mastery: warships earn veterancy twice as fast; bombardment and naval support reach 30% further; +2 warships.' },
  armorMastery: { name: 'Armor Mastery', tier: 5, science: 8000, gold: 3000, requires: ['mechanization'], requiresAny: ['deepRaids', 'siegeTanks'], description: 'Mastery: encirclements collapse pockets three times as big and destroy more of the troops caught in them.' },
  airMastery: { name: 'Air Mastery', tier: 5, science: 8000, gold: 3000, requires: ['flight'], requiresAny: ['jetEngines', 'strategicBombing'], description: 'Mastery: every air wing flies 50% more bombers.' },
};
export const TECH_ORDER: TechId[] = [
  'agriculture', 'metallurgy', 'logistics', 'fortification', 'navigation',
  'banking', 'medicine', 'mechanization', 'ballistics', 'flight',
  'industrialization', 'combinedArms', 'radar', 'rocketry', 'nuclearFission',
  'propaganda', 'railways', 'stockExchange', 'freeTrade', 'blitzTactics', 'trenchWarfare', 'carriers', 'submarines',
  'jetEngines', 'strategicBombing', 'diplomaticCorps', 'conscription', 'industrialBoom', 'massMobilization', 'automation',  'amphibiousTanks', 'earlyWarning', 'navalMines', 'dropTanks', 'nightBombing',
  'destroyers', 'battleships', 'lightTanks', 'heavyTanks', 'deepRaids', 'siegeTanks', 'groundAttack', 'heavyBombers',
  'mechInfantry', 'reconPlanes', 'navalMastery', 'armorMastery', 'airMastery',
];
/** Display names of the exclusive choice groups (TechInfo.exclusiveGroup). */
export const TECH_GROUP_NAMES: Record<string, string> = {
  finance: 'Finance',
  landDoctrine: 'Land doctrine',
  navalDoctrine: 'Navy path',
  airDoctrine: 'Air path',
  armorPath: 'Armor path',
  statecraft: 'Statecraft',
  capstone: 'National effort',
};
/**
 * Effects of the branch techs (techtree.ts reads them; sim systems call its helpers). Multipliers unless noted.
 */
export const TECH_EFFECTS = {
  /** attacker loss multiplier against a Propaganda holder */
  propagandaAttackerLoss: 1.12,
  railwaysSupplyRange: 1.25,
  railwaysFrontSpeed: 1.1,
  /** tank division cost multiplier (for the tank-division code: techtree.tankDivisionCostMul) */
  railwaysTankCost: 0.8,
  /** Stock Exchange: interest per second on the gold reserve, the reserve counting at most this many seconds of gold income */
  stockInterestPerS: 0.002,
  stockInterestCapSeconds: 100,
  freeTradeGold: 1.6,
  freeTradeMarketCost: 0.7,
  /** Blitz Tactics: front speed x (1 + this x armor share of the attack) */
  blitzArmorSpeed: 0.3,
  /** tank divisions (techtree.tankDivisionMods): speed and depth */
  blitzDivisionSpeed: 1.3,
  blitzDivisionDepth: 1.3,
  trenchDefense: 1.15,
  trenchEnemySpeed: 0.85,
  trenchFortCost: 0.75,
  /** tank divisions of a Trench Warfare holder defend this much better around them */
  trenchDivisionDefense: 1.2,
  /** Carriers: a player's warships shoot down one enemy bomber / cargo plane within this radius, then reload */
  carrierRadius: 14,
  carrierCooldown: 12,
  submarineShipDamage: 1.6,
  /** Submarines: own warships are hidden from enemies further away than this (tiles) from their ships / coast */
  submarineRevealRange: 12,
  jetSpeed: 1.4,
  jetExtraHp: 1,
  strategicRadius: 1.4,
  strategicBuildingHit: 0.8,
  /** share of the victim's gold and iron stock burnt per raid */
  strategicResourceBurn: 0.06,
  /** opinion an ally needs of a Diplomatic Corps holder: this much less */
  diploOpinionDiscount: 15,
  diploAidMult: 1.4,
  diploAskCooldown: 0.5,
  conscriptionCap: 1.05,
  conscriptionGrowth: 1.06,
  conscriptionMercCost: 0.75,
  industrialBoomIncome: 1.12,
  mobilizationCap: 1.12,
  mobilizationAttack: 1.06,
  automationBuildTime: 0.65,
  automationCost: 0.9,
} as const;
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
  transport: { name: 'Transport', speed: 10, gold: 150, iron: 0, oil: 0, hp: 1, tech: null },
  warship: { name: 'Warship', speed: 8, gold: 900, iron: 80, oil: 20, hp: 3, tech: 'navigation' },
  tradeShip: { name: 'Trade ship', speed: 7, gold: 0, iron: 0, oil: 0, hp: 1, tech: null },
  bomber: { name: 'Bomber', speed: 30, gold: 500, iron: 30, oil: 40, hp: 1, tech: 'flight' },
  fighter: { name: 'Fighter', speed: 40, gold: 400, iron: 20, oil: 20, hp: 1, tech: 'flight' },
  rocket: { name: 'Rocket', speed: 55, gold: 900, iron: 60, oil: 30, hp: 1, tech: 'rocketry' },
  atomBomb: { name: 'Atom bomb', speed: 35, gold: 6000, iron: 300, oil: 150, hp: 2, tech: 'nuclearFission' },
  /** paratrooper drop: the price is paid per drop */
  transportPlane: { name: 'Cargo plane', speed: 30, gold: 400, iron: 0, oil: 30, hp: 1, tech: 'flight' },
  /** tank division (tanks.ts): speed = tiles/s moving over own land; the troops it carries are its strength */
  tankDivision: { name: 'Tank division', speed: 5, gold: 1200, iron: 100, oil: 50, hp: 1, tech: 'mechanization' },
  /** recon flight (variants.ts): the price is paid per flight */
  reconPlane: { name: 'Recon plane', speed: 45, gold: 200, iron: 0, oil: 15, hp: 1, tech: 'reconPlanes' },
};
export const TRANSPORT_MAX_AT_SEA = 3;
export const TRANSPORT_PER_PORT = 2;
export const PORT_TRANSPORT_SPEED = 1.6;
export const NAVIGATION_TRANSPORT_SPEED = 1.5;
export const WARSHIP_RANGE = 20;
export const WARSHIP_DAMAGE_PER_S = 0.5; // hp/s to one target in range
export const WARSHIP_BOMBARD_KILL = 150; // defender troops/s killed when an enemy coast tile is in range
// ---------- warships: build where you click, auto-intercept, groups (navy.ts) ----------
/** seconds from ordering a warship to it appearing (x build speed modifiers; 'instant' = at once) */
export const WARSHIP_BUILD_SECONDS = 6;
/** a warship may be ordered on a water tile at most this many tiles from the port that builds it */
export const WARSHIP_SPAWN_RANGE = 40;
/** patrolling warships notice enemy ships within this many tiles (2.5 x weapon range) and chase them */
export const WARSHIP_DETECT_RANGE = WARSHIP_RANGE * 2.5;
/** ...but never further than this many tiles from their post (they turn back) */
export const WARSHIP_LEASH = 60;
/** a chase ends after the target has been out of detection range for this many seconds */
export const WARSHIP_CHASE_GIVE_UP = 6;
/** patrolling warships look for ships to intercept every this many ticks (staggered by id) */
export const WARSHIP_SCAN_TICKS = 10;
/** most units one group order (moveWarships / moveTankDivision) may carry */
export const MAX_GROUP_UNITS = 64;

// ---------- tank divisions (tanks.ts) ----------
/** seconds to build a division at a Factory (x build speed modifiers) */
export const TANK_BUILD_SECONDS = 12;
/** troops a division takes from the pool: armor first; infantry and artillery escort it */
export const TANK_DIVISION_TROOPS = { armor: 6000, infantry: 2000, artillery: 1000 };
/** at least this much armor must be at home to form a division (it may then take less escort) */
export const TANK_MIN_ARMOR = 3000;
/** divisions (alive + being built) per Factory level of a player */
export const TANK_PER_FACTORY_LEVEL = 1;
/** spearhead: head speed in tiles/s on plains (x TANK_TERRAIN_SPEED) */
export const TANK_SPEARHEAD_SPEED = 3;
/** spearhead width in tiles (odd; the head tile and (width-1)/2 on each side) */
export const TANK_SPEARHEAD_WIDTH = 3;
/** spearheads never run deeper than this many tiles */
export const TANK_SPEARHEAD_MAX_DEPTH = 40;
/** the clicked tile must be within this many tiles of own land to launch a spearhead */
export const TANK_LAUNCH_REACH = 4;
/** spearhead losses = a normal attack's losses for the same tile x this x terrain factor (concentrated armor) */
export const TANK_SPEARHEAD_LOSS = 0.5;
/** per terrain id: head speed factor and loss factor (0 speed = stops it; mountains need artillery support) */
export const TANK_TERRAIN_SPEED: readonly number[] = [0, 0, 1, 0.45, 0.5, 0.15, 1.1, 0.3, 0.8];
export const TANK_TERRAIN_LOSS: readonly number[] = [1, 1, 0.8, 1.6, 1.4, 3, 0.8, 2, 1.1];
/** artillery share of a division that lets it push through mountains and forts (slowly, at a high loss) */
export const TANK_ARTILLERY_SUPPORT = 0.08;
/** losses x (1 + this x the defender's armor share): an armor-heavy defence blunts spearheads */
export const TANK_ARMOR_DEFENSE = 1.5;
/** a spearhead ends when the division has less than this share of the troops it started with */
export const TANK_SPEARHEAD_MIN_SHARE = 0.2;
/** a division with fewer troops than this share of a full division disbands (troops go home) */
export const TANK_DISBAND_SHARE = 0.08;
/** tiles of own land around a holding division get this defence bonus (losses of attackers x 1 + bonus) */
export const TANK_DEFENSE_RADIUS = 4;
export const TANK_DEFENSE_BONUS = 0.35;
/** a division not attacking whose ground is taken falls back to own land within this many tiles (losing this share
 * of its troops) while it has at least TANK_FALLBACK_MIN_SHARE of a full division; otherwise it is overrun */
export const TANK_FALLBACK_RADIUS = 5;
export const TANK_FALLBACK_LOSS = 0.08;
export const TANK_FALLBACK_MIN_SHARE = 0.2;
/** seconds a division that fell back waits before an automatic drive back up to the front */
export const TANK_FALLBACK_PAUSE = 20;
/** a bomber hit kills this share of a division's troops within BOMBER_RADIUS of the impact */
export const TANK_BOMBER_KILL = 0.15;
/** search effort for a division's land route over own territory (tiles expanded) */
export const TANK_PATH_BUDGET = 60000;
export const TRADE_INTERVAL = 25; // seconds between trade ships per port
export const TRADE_GOLD_PER_TILE = 0.5; // gold per tile of path length, to each owner
export const BOMBER_RADIUS = 5;
export const BOMBER_BUILDING_HIT = 0.6; // chance per building in radius
export const BOMBER_TROOP_KILL = 0.04; // share of the defender's army killed x tiles hit / their tiles, min below
export const BOMBER_MIN_KILL = 8000;
export const ROCKET_RADIUS = 7;
export const ROCKET_KILL_MIN = 15000;
export const ATOM_RADIUS = 35;
export const ATOM_CORE_RADIUS = 14; // tiles turned neutral
export const ATOM_KILL_SHARE: [number, number] = [0.6, 0.9]; // of the army share in the area
export const FALLOUT_SECONDS = 120;
export const SILO_COOLDOWN = 20; // seconds to reload one launch slot (a level-L silo has L slots)
export const SAM_COOLDOWN = 4; // seconds to reload one shot (each shot is a sure hit; a level-L SAM holds L shots)
/** Seconds an airfield's fighters need between interceptions, divided by the fighters stationed there. */
export const FIGHTER_COOLDOWN = 12;
/** Aircraft an airfield holds per level. */
export const AIRCRAFT_MAX_PER_AIRFIELD = 6;

// ---------- doctrines ----------
// A doctrine (src/sim/doctrines.ts) is chosen mid-game, can be switched and only ever adds bonuses: every unit,
// building and strike stays open to everyone. Each doctrine has a few levers (DOCTRINE_LEVERS: the full bonus as a
// fraction, reached at level 2; level 1 gives DOCTRINE_LEVEL_STRENGTH[1] of it) and one small signature perk at
// level 3 (DOCTRINE_PERKS). All timers count game time and run twice as fast in a fast game (rules.progressRate).

/** Seconds after the start of play (0:00) before anyone can pick a doctrine. */
export const DOCTRINE_UNLOCK_SECONDS = 300;
/** Seconds of holding the same doctrine at which levels 1, 2 and 3 are reached (a switch starts again at level 1). */
export const DOCTRINE_LEVEL_SECONDS: readonly number[] = [0, 360, 840];
/** Share of each lever's full bonus by level (index = level; 0 = no doctrine). */
export const DOCTRINE_LEVEL_STRENGTH: readonly [number, number, number, number] = [0, 0.6, 1, 1];
/** Seconds without any doctrine bonus after a switch (the first choice works at once). */
export const DOCTRINE_ADAPT_SECONDS = 45;
/** Seconds between two doctrine choices. */
export const DOCTRINE_SWITCH_COOLDOWN = 120;
/**
 * Least gold a switch costs (the first choice is free) ... or DOCTRINE_SWITCH_INCOME_SECONDS of the player's gold
 * income when that is more (doctrines.doctrineSwitchCost): about a quarter of a typical gold stock at 10 minutes.
 */
export const DOCTRINE_SWITCH_GOLD = 1000;
export const DOCTRINE_SWITCH_INCOME_SECONDS = 5;

/** Every bonus a doctrine can give, as a fraction (0.25 = +25% or -25%, see each lever's note). */
export interface DoctrineLevers {
  /** blitz: attack fronts cross plains and desert tiles this much faster */
  openGroundSpeed?: number;
  /** blitz: converting troops to armor costs this much less gold and iron */
  armorConvertCost?: number;
  /** fortress: the defence a fort adds (its multiplier above 1) is this much stronger */
  fortDefense?: number;
  /** fortress: forts cost this much less gold and iron */
  fortCost?: number;
  /** fortress: troops lost by this player's home army when a tile of it falls are this much fewer */
  defenderLoss?: number;
  /** siege: artillery attack this much higher */
  artilleryAttack?: number;
  /** siege: artillery's extra bonus against forts and towers this much higher */
  siegeBonus?: number;
  /** siege: barrage reload this much shorter */
  barrageCooldown?: number;
  /** merchant: gold income this much higher */
  gold?: number;
  /** merchant: gold carried by own trade ships this much higher */
  tradeGold?: number;
  /** merchant: market bonus (and its cap) this much higher */
  marketBonus?: number;
  /** naval: warships cost this much less (gold, iron, oil) */
  warshipCost?: number;
  /** naval: warships sail this much faster */
  warshipSpeed?: number;
  /** naval: transports sail this much faster */
  transportSpeed?: number;
  /** naval: transports get this much more hp (harder to sink) */
  transportHp?: number;
  /** air: bombers, fighters and cargo-plane drops cost this much less */
  aircraftCost?: number;
  /** air: fighter interception and paradrop cooldowns this much shorter */
  airfieldReload?: number;
  /** air: paradrop range this much longer */
  paradropRange?: number;
  /** expansion: losses attacking tribes and the wilderness this much lower */
  expansionLoss?: number;
  /** expansion: troop growth this much higher while small (DOCTRINE_PERKS.expansion.smallShare) */
  smallGrowth?: number;
}
export type DoctrineLever = keyof DoctrineLevers;

export const DOCTRINE_LEVERS: Record<DoctrineId, DoctrineLevers> = {
  blitz: { openGroundSpeed: 0.3, armorConvertCost: 0.25 },
  fortress: { fortDefense: 0.25, fortCost: 0.25, defenderLoss: 0.2 },
  siege: { artilleryAttack: 0.2, siegeBonus: 0.25, barrageCooldown: 0.25 },
  merchant: { gold: 0.08, tradeGold: 0.25, marketBonus: 0.15 },
  naval: { warshipCost: 0.35, warshipSpeed: 0.2, transportSpeed: 0.35, transportHp: 1 },
  air: { aircraftCost: 0.25, airfieldReload: 0.25, paradropRange: 0.25 },
  expansion: { expansionLoss: 0.3, smallGrowth: 0.3 },
};

/** Level-3 signature perks (and the expansion doctrine's 'small' range, used from level 1). */
export const DOCTRINE_PERKS = {
  /** armor ignores this share of the terrain's attack penalty (forest, hills, mountains, swamp ...) */
  blitz: { armorTerrainIgnore: 0.5 },
  /** forts build and upgrade in this share of the time and repair barrage damage this many times faster */
  fortress: { fortBuildTime: 0.25, fortRepair: 3 },
  /** barrage disc + this many tiles; forts and SAM sites stay silenced this many times longer */
  siege: { barrageRadius: 1, disableMult: 1.5 },
  /** gold income + routeBonus per own trade ship at sea, counting up to maxRoutes */
  merchant: { routeBonus: 0.015, maxRoutes: 10 },
  /** warships repair this many hp per second at sea; coastal shelling kills this many times more */
  naval: { warshipRepair: 0.05, shelling: 1.5 },
  /** bombers take this many extra hits before they go down (SAM shots and fighters each take one) */
  air: { bomberExtraHp: 1 },
  /** smallGrowth is full below smallShare[0] of the map's land and fades out at smallShare[1]; a tribe you
   *  eliminate pays tribeIncomeSeconds of your gold income + tribeGoldPerTile x its tiles at its peak (level 3) */
  expansion: { smallShare: [0.06, 0.15] as const, tribeIncomeSeconds: 15, tribeGoldPerTile: 0.2 },
} as const;

export interface DoctrineInfo {
  name: string;
  /** one line: what the doctrine is for */
  short: string;
  /** one plain line per level (what level 1, 2 and 3 give) */
  levels: [string, string, string];
  /** muted accent colour (CSS) */
  color: string;
  /** client icon id */
  icon: `doctrine-${DoctrineId}`;
}

const pct = (v: number | undefined, level: 1 | 2): string => `${Math.round((v ?? 0) * DOCTRINE_LEVEL_STRENGTH[level] * 100)}%`;
const L = DOCTRINE_LEVERS;
const P = DOCTRINE_PERKS;
export const DOCTRINES: Record<DoctrineId, DoctrineInfo> = {
  blitz: {
    name: 'Blitz',
    short: 'Fast armored pushes across open ground.',
    levels: [
      `Fronts cross plains and desert ${pct(L.blitz.openGroundSpeed, 1)} faster; armor costs ${pct(L.blitz.armorConvertCost, 1)} less to convert.`,
      `Open-ground fronts ${pct(L.blitz.openGroundSpeed, 2)} faster; armor ${pct(L.blitz.armorConvertCost, 2)} cheaper.`,
      `Armor ignores ${Math.round(P.blitz.armorTerrainIgnore * 100)}% of the terrain penalty in forests, hills and swamps.`,
    ],
    color: '#b8794a',
    icon: 'doctrine-blitz',
  },
  fortress: {
    name: 'Fortress',
    short: 'Hold the line: stronger, cheaper forts and fewer losses at home.',
    levels: [
      `Forts ${pct(L.fortress.fortDefense, 1)} stronger and ${pct(L.fortress.fortCost, 1)} cheaper; ${pct(L.fortress.defenderLoss, 1)} fewer losses when land falls.`,
      `Forts ${pct(L.fortress.fortDefense, 2)} stronger and ${pct(L.fortress.fortCost, 2)} cheaper; ${pct(L.fortress.defenderLoss, 2)} fewer losses when land falls.`,
      `Forts build ${Math.round(1 / P.fortress.fortBuildTime)}x faster and repair shell damage ${P.fortress.fortRepair}x faster.`,
    ],
    color: '#5f7fa8',
    icon: 'doctrine-fortress',
  },
  siege: {
    name: 'Siege',
    short: 'Guns first: artillery breaks forts and barrages come more often.',
    levels: [
      `Artillery attack +${pct(L.siege.artilleryAttack, 1)}, siege bonus +${pct(L.siege.siegeBonus, 1)}, barrages reload ${pct(L.siege.barrageCooldown, 1)} faster.`,
      `Artillery attack +${pct(L.siege.artilleryAttack, 2)}, siege bonus +${pct(L.siege.siegeBonus, 2)}, barrages reload ${pct(L.siege.barrageCooldown, 2)} faster.`,
      `Barrages hit ${P.siege.barrageRadius} tile wider and silence forts and SAM sites ${P.siege.disableMult}x longer.`,
    ],
    color: '#9a6a5c',
    icon: 'doctrine-siege',
  },
  merchant: {
    name: 'Merchant',
    short: 'Gold wins wars: more income, richer trade and markets.',
    levels: [
      `Gold +${pct(L.merchant.gold, 1)}, trade ships carry +${pct(L.merchant.tradeGold, 1)}, markets +${pct(L.merchant.marketBonus, 1)}.`,
      `Gold +${pct(L.merchant.gold, 2)}, trade ships carry +${pct(L.merchant.tradeGold, 2)}, markets +${pct(L.merchant.marketBonus, 2)}.`,
      `+${Math.round(P.merchant.routeBonus * 1000) / 10}% gold for every trade ship of yours at sea (up to ${P.merchant.maxRoutes}).`,
    ],
    color: '#b39a4e',
    icon: 'doctrine-merchant',
  },
  naval: {
    name: 'Naval',
    short: 'Rule the sea: cheaper, faster warships and tougher transports.',
    levels: [
      `Warships ${pct(L.naval.warshipCost, 1)} cheaper and ${pct(L.naval.warshipSpeed, 1)} faster; transports ${pct(L.naval.transportSpeed, 1)} faster and tougher.`,
      `Warships ${pct(L.naval.warshipCost, 2)} cheaper and ${pct(L.naval.warshipSpeed, 2)} faster; transports ${pct(L.naval.transportSpeed, 2)} faster, twice as hard to sink.`,
      `Warships repair at sea and shell coasts ${P.naval.shelling}x harder.`,
    ],
    color: '#4f8a94',
    icon: 'doctrine-naval',
  },
  air: {
    name: 'Air',
    short: 'Own the sky: cheaper aircraft, quicker airfields, longer drops.',
    levels: [
      `Aircraft and drops ${pct(L.air.aircraftCost, 1)} cheaper; airfields ready ${pct(L.air.airfieldReload, 1)} sooner; drop range +${pct(L.air.paradropRange, 1)}.`,
      `Aircraft and drops ${pct(L.air.aircraftCost, 2)} cheaper; airfields ready ${pct(L.air.airfieldReload, 2)} sooner; drop range +${pct(L.air.paradropRange, 2)}.`,
      `Bombers survive one extra hit from SAM sites or fighters.`,
    ],
    color: '#7a83a8',
    icon: 'doctrine-air',
  },
  expansion: {
    name: 'Expansion',
    short: 'Grow wide: cheap land grabs and fast growth while small.',
    levels: [
      `${pct(L.expansion.expansionLoss, 1)} fewer losses against tribes and wilderness; troops grow ${pct(L.expansion.smallGrowth, 1)} faster while small.`,
      `${pct(L.expansion.expansionLoss, 2)} fewer losses against tribes and wilderness; troops grow ${pct(L.expansion.smallGrowth, 2)} faster while small.`,
      `Every tribe you finish off pays gold: ${P.expansion.tribeIncomeSeconds} s of your income, more for big tribes.`,
    ],
    color: '#6f9a5a',
    icon: 'doctrine-expansion',
  },
};

// ---------- diplomacy ----------
export const ALLIANCE_DURATION = 300; // seconds
export const ALLIANCE_REQUEST_TIMEOUT = 30;
export const TRAITOR_DURATION = 45;
export const TRAITOR_DEFENSE = 0.6;
/** Being attacked by a nation stops trade with it (both ways) for this long, unless toggled by hand. */
export const AUTO_EMBARGO_SECONDS = 300;
export const NUKE_OPINION_PENALTY = 60;
export const BETRAYAL_OPINION_PENALTY = 50;

// ---------- coalitions and allies (DESIGN 9.2) ----------
/**
 * Runaway leader: the nation with the most land once it holds at least COALITION_LAND_SHARE of the land and
 * COALITION_LEAD x the land of the next nation. AIs it threatens (those bordering it, or everyone once it holds
 * COALITION_ALL_SHARE) ally with each other and with whoever fights it, focus their wars on it, and refuse its
 * alliance requests. The same rules apply when the leader is a human.
 */
export const COALITION_LAND_SHARE = 0.2;
export const COALITION_LEAD = 1.4;
export const COALITION_ALL_SHARE = 0.3;
/** Coalition AIs need x this strength to attack the leader and rank wars on it x COALITION_FOCUS. */
export const COALITION_NEED = 0.5;
export const COALITION_FOCUS = 2;
/** Coalition AIs rank wars on other non-leader nations (fellow members) x this. */
export const COALITION_OTHER_WARS = 0.5;
/** Seconds a player must wait between two requests to allies (requestAllyAttack / requestAllyAid). */
export const ALLY_REQUEST_COOLDOWN = 15;
/** An unanswered request to an AI ally expires after this many seconds. */
export const ALLY_REQUEST_TIMEOUT = 20;
/** An ally that agreed to (or chose to) fight a nation keeps that war going for this many seconds (a pledge). */
export const ALLY_PLEDGE_SECONDS = 90;
/** AIs refuse to help a nation they like less than this (personality adds PROFILES allyOpinion / 2). */
export const ALLY_HELP_MIN_OPINION = -10;
/** An AI joins a war only with at least this x the target's whole army (or when the target is busy elsewhere: x 0.6). */
export const ALLY_JOIN_MIN_STRENGTH = 0.45;
/** Share of the troops above its reserve an AI sends when it joins an ally's war (x personality aggression 0.7..1.3). */
export const ALLY_JOIN_SHARE = 0.5;
/** An AI sends aid when an ally is losing badly: incoming troops > ALLY_AID_DANGER x the ally's home army. */
export const ALLY_AID_DANGER = 1.2;
/** Aid: this share of the helper's home infantry (at most ALLY_AID_MAX_SHARE of what it has, keeps half its cap). */
export const ALLY_AID_SHARE = 0.2;
export const ALLY_AID_MAX_SHARE = 0.35;
/** Aid as gold (merchants, or allies short of troops): this many seconds of the helper's gold income. */
export const ALLY_AID_GOLD_SECONDS = 40;
/** An AI helps the same ally on its own (joins a war or sends aid) at most once per this many seconds. */
export const ALLY_HELP_COOLDOWN = 45;
/** Asking costs a little goodwill (opinion of the asker) each time an AI says yes. */
export const ALLY_ASK_OPINION_COST = 4;
/**
 * How readily each personality helps its allies: scales the troops it sends and lowers (above 1) or raises the opinion
 * it needs of the asker (ALLY_HELP_MIN_OPINION + 20 x (1 - this)). Merchants prefer to send gold.
 */
export const ALLY_WILLINGNESS: Record<Personality, number> = { warlord: 1.25, balanced: 1, admiral: 0.9, turtle: 0.8, merchant: 0.7, tribe: 0 };
/** Trade between allies pays x (1 + this) gold to both. */
export const ALLY_TRADE_BONUS = 0.25;

// ---------- AI ----------
export const AI_NAMES = [
  'Valoria', 'Kestrel Union', 'Drakmar', 'Sundara', 'Ostheim', 'Morrowind Pact', 'Tarsis', 'Ilyria', 'Caldera',
  'Norvik', 'Azuria', 'Brenmoor', 'Qadesh', 'Lysander League', 'Ferrovia', 'Halcyon', 'Zephyria', 'Gorthan',
  'Aldmere', 'Vesperia', 'Corvane', 'Thalassa', 'Krovia', 'Umbria Reach', 'Solvane', 'Hesperon', 'Marrowgate',
  'Ostrava March', 'Celadon', 'Varnhold', 'Eskarth', 'Pellucid Isles', 'Runegard', 'Talmora', 'Quorvia',
  'Belisar', 'Dunmoor', 'Iskander Throne', 'Calyx', 'Westerholt', 'Orinthia', 'Sabran', 'Myrrhdal',
  'Corrigan Union', 'Telvara', 'Ashkara', 'Lunaris', 'Vorthane', 'Gildmark', 'Serapine', 'Northmarch',
  'Kaldoria', 'Emberlyn', 'Paxium', 'Rhoswen', 'Tyrell Coast', 'Ardent League', 'Zarakh', 'Velloran',
  'Hollowmere', 'Brightwater', 'Sarnath', 'Ironvale Compact', 'Ulmara', 'Coravel', 'Destrier', 'Mirethal',
  'Obsidia', 'Pyrrhos', 'Glenhaven', 'Stormreach', 'Avalis', 'Kharum', 'Lowmarch', 'Ceruleo', 'Thornwick',
  'Valdessa', 'Nymeria Pact', 'Oakhurst', 'Sablecrest', 'Erydon',
];

/** HSV (h in turns, s, v in 0..1) to RGB bytes, arithmetic only. */
function hsv(h: number, s: number, v: number): [number, number, number] {
  const hh = (h - Math.floor(h)) * 6;
  const i = Math.floor(hh);
  const f = hh - i;
  const p = v * (1 - s);
  const q = v * (1 - s * f);
  const t = v * (1 - s * (1 - f));
  const rgb = [[v, t, p], [q, v, p], [p, v, t], [p, q, v], [t, p, v], [v, p, q]][i % 6];
  return [Math.round(rgb[0] * 255), Math.round(rgb[1] * 255), Math.round(rgb[2] * 255)];
}
/**
 * Nation colours: solid, saturated and well apart. The first 16 are hand-picked; the rest walk the hue circle by the
 * golden ratio with alternating saturation and brightness, so neighbours in the list never look alike.
 */
export const AI_COLORS: [number, number, number][] = [
  [220, 60, 60], [60, 110, 230], [240, 190, 40], [150, 70, 200], [40, 190, 170], [240, 120, 40],
  [230, 90, 170], [120, 200, 60], [140, 90, 50], [70, 80, 110], [0, 150, 220], [200, 200, 80],
  [170, 40, 90], [60, 160, 90], [210, 140, 220], [140, 170, 230],
  ...Array.from({ length: 72 }, (_, k): [number, number, number] =>
    hsv(0.07 + k * 0.6180339887, k % 3 === 0 ? 0.85 : k % 3 === 1 ? 0.6 : 0.75, k % 2 === 0 ? 0.88 : 0.68),
  ),
];
export const PERSONALITIES: Personality[] = ['warlord', 'turtle', 'merchant', 'admiral', 'balanced'];

// ---------- player counts ----------
/**
 * AI nations per map size (setup default) and the most allowed. Games are mostly about tribes now: a few nations
 * (single player 8, multiplayer about 10 including the humans, setup.ts) and many tribes to conquer.
 */
export const DEFAULT_AI_COUNT: Record<MapSize, number> = { small: 8, medium: 8, large: 8, huge: 8 };
export const MAX_AI_COUNT = 40;
/**
 * Tribes per map size class (GameSettings.tribeCount < 0 means this, by the land actually played: setup.ts
 * defaultTribeCount; world maps 300) and the most allowed.
 */
export const DEFAULT_TRIBE_COUNT: Record<MapSize, number> = { small: 120, medium: 200, large: 300, huge: 300 };
export const MAX_TRIBE_COUNT = 600;
/** @deprecated same as DEFAULT_TRIBE_COUNT */
export const TRIBE_COUNT = DEFAULT_TRIBE_COUNT;

// ---------- tribes ----------
export const TRIBE_CAP_FACTOR = 1 / 3; // troop cap x this
export const TRIBE_GROWTH_FACTOR = 0.5; // troop growth x this
export const TRIBE_GOLD_FACTOR = 0.5; // gold income x this
export const TRIBE_START_FACTOR = 0.4; // starting troops x this
/** @deprecated same as TRIBE_CAP_FACTOR */
export const TRIBE_POP_FACTOR = TRIBE_CAP_FACTOR;
export const TRIBE_SPAWN_RADIUS = 4;
/** Tribes stop expanding into neutral land at this many tiles. */
export const TRIBE_MAX_TILES = 900;
/** Tribes decide every TRIBE_DECISION_SECONDS[0] .. [1] seconds (staggered by id). */
export const TRIBE_DECISION_SECONDS: [number, number] = [4, 8];
const TRIBE_ADJ = [
  'Ashen', 'Red', 'Long', 'Grey', 'Salt', 'Iron', 'Hollow', 'Cold', 'Seven', 'Silver', 'High', 'Bitter', 'Mossy',
  'Tall', 'White', 'Black', 'Dusty', 'Crooked', 'Quiet', 'Thorny', 'Green', 'Old', 'Windy', 'Copper', 'Amber',
  'Broken', 'Fallow', 'Golden', 'Misty', 'Sunken',
];
const TRIBE_NOUN = [
  'Hills', 'Fern', 'Shore', 'Wolf', 'Marsh', 'Root', 'Oak', 'Spring', 'Stones', 'Bend', 'Owl', 'Field', 'Bow', 'Reed',
  'Pass', 'Well', 'Gate', 'Grass', 'Ford', 'Stag', 'Pine', 'Road', 'Lake', 'Wood', 'Hollow', 'Cairn', 'Rock', 'Vale',
  'Ember', 'Moor',
];
/** "the Ashen Hills" ... (900 names; a game shuffles them). */
export const TRIBE_NAMES: string[] = TRIBE_ADJ.flatMap((a) => TRIBE_NOUN.map((b) => `the ${a} ${b}`));
/** Muted, greyish colours so tribes read as filler next to the nations (40, varied so neighbours differ). */
export const TRIBE_COLORS: [number, number, number][] = Array.from({ length: 40 }, (_, k): [number, number, number] =>
  hsv(0.11 + k * 0.6180339887, k % 2 === 0 ? 0.16 : 0.24, k % 3 === 0 ? 0.6 : k % 3 === 1 ? 0.52 : 0.46),
);

// ---------- auto-manage (advisor) ----------
/** Seconds between advisor updates for players with Player.auto on. */
export const AUTO_MANAGE_SECONDS = 3;
/** Research order the advisor follows (skipping techs that are done or not yet available). */
export const DEFAULT_TECH_ORDER: TechId[] = [
  'agriculture', 'metallurgy', 'logistics', 'mechanization', 'ballistics', 'fortification', 'banking', 'medicine',
  'industrialization', 'combinedArms', 'navigation', 'flight', 'radar', 'rocketry', 'nuclearFission',
  // branch techs: the advisor only picks a choice after everything else (techtree.ts techStatus skips locked ones)
  'railways', 'propaganda', 'stockExchange', 'trenchWarfare', 'conscription', 'industrialBoom', 'carriers', 'jetEngines',
  'automation',
];

// ---------- rule texts for the in-game help ----------
export const RULES_TEXT = {
  interception:
    `SAM sites never miss: a loaded SAM shoots down the first hostile plane or missile inside its ${BUILDINGS.sam.radius}-tile ` +
    `radius (+${SAM_LEVEL_RADIUS} per level; atom bombs first, then rockets, bombers, cargo planes). A level-L SAM holds ` +
    `L shots and reloads one every ${SAM_COOLDOWN} s divided by L. Planes and rockets fall to one hit; an atom bomb needs ` +
    `${UNITS.atomBomb.hp}. Send more threats than the SAMs can load to get through, or knock SAMs out with an artillery ` +
    `barrage first. Fighters on an airfield shoot down one bomber or cargo plane within ${BUILDINGS.airfield.radius} tiles, ` +
    `then need ${FIGHTER_COOLDOWN} s divided by the number of fighters stationed there to be ready again.`,
  barrage:
    `Artillery barrage: with at least ${BARRAGE_MIN_ARTILLERY} artillery, shell enemy land up to ${BARRAGE_RANGE} tiles from ` +
    `your border (Ballistics x${BARRAGE_BALLISTICS_RANGE}). The shells land ${BARRAGE_DELAY} s later on a ${BARRAGE_RADIUS}-tile ` +
    `disc: they kill troops (more artillery, more kills), silence forts and SAM sites there for ${BARRAGE_DISABLE_SECONDS} s ` +
    `(SAMs can't stop shells) and may wreck other buildings. The front doesn't move. One barrage every ${BARRAGE_COOLDOWN} s ` +
    `(${BARRAGE_COOLDOWN_BALLISTICS} s with Ballistics).`,
  paradrop:
    `Paratroopers: an Airfield (Flight) flies infantry up to ${PARADROP_RANGE} tiles (+${PARADROP_RANGE_PER_LEVEL} per level) ` +
    `to enemy or neutral land. The cargo plane can be shot down by SAMs and fighters on the way. On landing they take the ` +
    `tile and attack its owner from inside: strike capitals, cut off pockets, open a second front. One drop per airfield ` +
    `every ${PARADROP_COOLDOWN} s, bigger drops per airfield level.`,
  attacks:
    `A click picks who you attack (a nation, a tribe or the wilderness), not a point: the whole shared border ` +
    `advances, faster the longer it is. Clicking the same target again adds troops to the running attack; attacking ` +
    `someone who attacks you first cancels their attack troop for troop. Send more than the defender has at home to ` +
    `lose fewer troops per tile (x0.61 when you are twice as strong, x0.54 at three times, up to ` +
    `x${OUTNUMBER_LOSS[1]} at half) and to move a little faster; past ${FORCE_LIMIT_ODDS}:1 more troops add little. ` +
    `Land near a nation's capital (its heartland) defends up to x${1 + HEARTLAND_DEFENSE} better, and a nation ` +
    `${LAST_STAND_START}x or more smaller than its attacker makes a last stand (up to x${1 + LAST_STAND_MAX} defence). ` +
    `Land you can't reach on foot gets a transport from ` +
    `your nearest coast. Retreating costs ${Math.round(RETREAT_LOSS * 100)}% of the troops (nothing in the wilderness). ` +
    `A landed invasion's beachhead supplies it for ${BEACHHEAD_SUPPLY_SECONDS} s.`,
  endgame:
    `A nation with fewer than ${ENDGAME_SMALL_TILES} tiles (a tribe: ${TRIBE_ANNEX_TILES}) collapses when it is hit ` +
    `(players get the first ${HUMAN_GRACE_SECONDS / 60} minutes to grow first). ` +
    `Pockets surrounded by one hostile nation are annexed by it. After ${OVERTIME_MINUTES} minutes the land share ` +
    `needed to win drops by ${Math.round(OVERTIME_DROP_PER_MINUTE * 100)}% a minute, down to ${Math.round(OVERTIME_MIN_SHARE * 100)}%. ` +
    `Tribes don't count for "last nation standing".`,
  alliances:
    `Alliances last ${ALLIANCE_DURATION / 60} minutes; both sides can renew in the last minute. Breaking one makes you a ` +
    `traitor for ${TRAITOR_DURATION} s (defence x${TRAITOR_DEFENSE}, everyone trusts you less). Being attacked stops ` +
    `trade with the attacker for ${AUTO_EMBARGO_SECONDS / 60} minutes and cancels pending alliance requests between you. ` +
    `Ask an ally to attack a nation or to send troops: AI allies say yes or no (and why), join wars on their own when ` +
    `you are attacked, and trade pays allies ${Math.round(ALLY_TRADE_BONUS * 100)}% more. Nations unite against a ` +
    `runaway leader (${Math.round(COALITION_LAND_SHARE * 100)}% of the land and well ahead).`,
} as const;

/** Seconds between two decisions of an AI nation, by difficulty. */
export const AI_DECISION_SECONDS: Record<Difficulty, number> = { easy: 5, normal: 3, hard: 2, brutal: 1.5 };
/** Hard AI players (nations and tribes) earn this much more gold, iron and oil, and grow troops half as much more. */
export const AI_HARD_INCOME_BONUS = 0.15;
/**
 * Economy of the AI by difficulty: troop growth, income (gold, iron, oil) and troop cap of AI nations x these. Easy
 * and Normal slow the AI nations only (tribes stay as they are: they are food); Hard and Brutal boost every AI player
 * (tribes too). The human's economy never changes.
 */
export const AI_ECONOMY: Record<Difficulty, { growth: number; income: number; cap: number }> = {
  easy: { growth: 0.7, income: 0.7, cap: 0.7 },
  normal: { growth: 0.88, income: 0.88, cap: 1 },
  hard: { growth: 1 + AI_HARD_INCOME_BONUS * 0.5, income: 1 + AI_HARD_INCOME_BONUS, cap: 1 },
  brutal: { growth: 1.15, income: 1.3, cap: 1.1 },
};

// ---------- gold uses (spending.ts) ----------
/**
 * Mercenaries (Action hireMercenaries): instant infantry for gold. Price per troop = MERC_BASE_PRICE x (1 +
 * MERC_TIME_GROWTH x game minutes) x (1 + MERC_RISE x troops hired in the current window / troop cap), integrated over
 * the amount (so a big hire pays the rising price). The window is MERC_WINDOW_SECONDS long; at most MERC_CAP_SHARE of
 * the troop cap per window (at least MERC_MIN_CAP); home troops may end at most MERC_OVER_CAP above the cap.
 */
export const MERC_BASE_PRICE = 0.05;
export const MERC_TIME_GROWTH = 0.03;
export const MERC_RISE = 4;
export const MERC_WINDOW_SECONDS = 60;
export const MERC_CAP_SHARE = 0.15;
export const MERC_MIN_CAP = 20000;
export const MERC_OVER_CAP = 0.1;
export const MERC_MIN_AMOUNT = 1000;
/** Mercenaries prefer underdogs: price x (1 + this x the buyer's share of all land). */
export const MERC_LAND_PRICE = 2;
/**
 * Funding an ally (Action fundAlly): the gold goes to the ally; for FUND_SECONDS it attacks nations at war with the
 * funder with +bonus attack (bonus = FUND_MAX_BONUS x min(1, gold / (FUND_FULL_SECONDS x the ally's gold income)),
 * strongest funding counts), needs FUND_OPINION_DISCOUNT x bonus/FUND_MAX_BONUS less opinion to help the funder and
 * joins wars against stronger nations (its strength requirement x (1 - bonus)). Opinion + up to FUND_OPINION.
 */
export const FUND_MIN_GOLD = 300;
export const FUND_MAX_BONUS = 0.2;
export const FUND_FULL_SECONDS = 60;
export const FUND_SECONDS = 90;
export const FUND_OPINION = 15;
export const FUND_OPINION_DISCOUNT = 25;
/** War bonds (Action warBonds): WAR_BONDS_BONUS attack for WAR_BONDS_SECONDS; price max(min, seconds of gold income). */
export const WAR_BONDS_BONUS = 0.15;
export const WAR_BONDS_SECONDS = 40;
export const WAR_BONDS_COOLDOWN = 150;
export const WAR_BONDS_MIN_GOLD = 1500;
export const WAR_BONDS_INCOME_SECONDS = 45;

// ---------- bulk build (bulkbuild.ts) ----------
/** Action buildMany: at most this many levels per order; upgradeArea: at most this many levels per building. */
export const BULK_MAX_COUNT = 5;
/** Action upgradeArea: radius cap (tiles) and at most this many buildings per order. */
export const UPGRADE_AREA_MAX_RADIUS = 60;
export const UPGRADE_AREA_MAX_BUILDINGS = 40;
/** Action upgradeBuildings (a box selection of own buildings): at most this many tiles per order. */
export const UPGRADE_SELECTION_MAX = 200;

// ---------- air wings (airwings.ts) ----------
/**
 * Air wings (Action setAirMission): each airfield flies its stored aircraft as one wing on a standing mission.
 * support: every sortie cooldown a wing of bombers bombs ahead of your attack on the target front (an air-support
 * zone: enemy defence there is cut, your push goes faster, defenders die and forts are knocked out); strategic: bombers
 * raid the target nation's cities / factories / markets / ports (normal bomb damage plus a cut to its gold and iron
 * income for a while); superiority: the fighters patrol a circle (default the airfield) and shoot down enemy
 * bombers and cargo planes there; idle: nothing automatic. Fighters at a support / strategic airfield escort its
 * bombers (and cargo planes): an escort fights off one fighter interception.
 */
export const AIR = {
  /** bombers per sortie: base + perLevel x (airfield level - 1), + jets (Jet Engines), + doctrine (Air doctrine held) */
  wingBase: 3,
  wingPerLevel: 2,
  wingJets: 1,
  wingDoctrine: 1,
  /** mission reach from the airfield (tiles): range + rangePerLevel x (level - 1) */
  range: 150,
  rangePerLevel: 40,
  /** seconds between sorties (x Air doctrine airfieldReload); when there is nothing to do, check again after idleRecheck */
  sortieCooldown: 20,
  idleRecheck: 3,
  /** support: zone radius (+ per airfield level above 1), how long it lasts after the last strike (s) */
  supportRadius: 7,
  supportRadiusPerLevel: 1,
  supportSeconds: 24,
  /** support: enemy tile defence cut = maxCut x (1 - decay^strength); strength = bombers that struck the zone */
  supportMaxCut: 0.45,
  supportDecay: 0.65,
  /** support: attacker tile budget x (1 - speed x cut): the push moves faster */
  supportSpeed: 0.7,
  /** support strike, per bomber: kills max(minKill x hostile share, killShare x army x tiles hit / their tiles) */
  supportMinKill: 4000,
  supportKillShare: 0.03,
  /** support zone bleeds the defender: per second cut x max(bleedMin, bleedShare x army x zone tiles / their tiles) */
  supportBleedMin: 60,
  supportBleedShare: 0.01,
  /** support: retarget to the nearest hostile tile within this radius when the aim tile was taken */
  retargetRadius: 26,
  /** strategic: income cut per bomber (Strategic Bombing x techMul), capped, lasting seconds (Strategic Bombing x techMul) */
  raidCut: 0.05,
  raidMaxCut: 0.3,
  raidSeconds: 45,
  raidTechMul: 1.6,
  raidTechMaxCut: 0.45,
  /** superiority: patrol radius = airfield cover radius x this; patrol centre at most centreReach x cover radius away */
  superiorityRadiusMul: 1.4,
  superiorityCentreReach: 2,
  /** superiority: seconds between interceptions / fighters stationed (x jetsCooldown with Jet Engines) */
  superiorityCooldown: 8,
  jetsCooldown: 0.5,
  /** escort: hits each escorted plane can fight off (Jet Engines: + escortJets); duel chances (see airwings.escortAbsorbs) */
  escortHits: 1,
  escortJets: 1,
  escortDuelKill: 0.3,
  /** paratroopers: drop size x (1 + paraPerAircraft x aircraft at the airfield), at most paraMaxMul */
  paraPerAircraft: 0.08,
  paraMaxMul: 2.2,
  /** a nation flying more than massFree airfields on support / strategic missions: every wing's sortie cooldown x (1 + massCooldown x the extra ones) */
  massFree: 2,
  massCooldown: 0.5,
} as const;

// ---------- navy, part three: stances, shore bombardment, blockades, veterancy (naval2.ts) ----------
/** stanced warships (re)think every this many ticks (staggered by id) */
export const NAVY_THINK_TICKS = 20;
/** 'auto': looks for enemy coast to bombard within this many tiles of its post (only nations it is at war with) */
export const NAVY_AUTO_BOMBARD_REACH = 60;
/** 'hunt': detection range and leash (tiles) */
export const NAVY_HUNT_DETECT = 90;
export const NAVY_HUNT_LEASH = 160;
/** 'bombard' / 'blockade': a ship looks this far (tiles) for a coast / port to take up station at */
export const NAVY_STATION_SEEK = 120;
/** a ship on station sits within this many tiles of the coast / port tile it covers */
export const NAVY_STATION_DIST = 4;
/**
 * Shore bombardment: enemy land within NAVY_SUPPORT_RANGE tiles of an own warship is cheaper to take for the ship's
 * owner: defence / (1 + bonus), the front advances x (1 + NAVY_SUPPORT_SPEED x bonus) faster there, and the attack
 * counts as supplied. bonus = NAVY_SUPPORT_BONUS for the first ship, each further ship x NAVY_SUPPORT_DIMINISH of the
 * one before, at most NAVY_SUPPORT_MAX.
 */
export const NAVY_SUPPORT_RANGE = 12;
export const NAVY_SUPPORT_BONUS = 0.35;
export const NAVY_SUPPORT_DIMINISH = 0.6;
export const NAVY_SUPPORT_MAX = 0.8;
export const NAVY_SUPPORT_SPEED = 0.6;
/** a ship in 'bombard' stance shells the coast x this (defenders killed per second, WARSHIP_BOMBARD_KILL) */
export const NAVY_BOMBARD_STANCE_KILL = 1.6;
/** landings within NAVY_SUPPORT_RANGE of an own warship: the beachhead costs x this and its supply lasts x NAVY_BEACHHEAD_SUPPLY */
export const NAVY_BEACHHEAD_LOSS = 0.4;
export const NAVY_BEACHHEAD_SUPPLY = 2;
/**
 * Blockade: a port within NAVY_BLOCKADE_RANGE tiles of a warship whose owner is at war with the port's owner is
 * blockaded: its trade earns x (1 - NAVY_BLOCKADE_TRADE_CUT), the owner's land within NAVY_BLOCKADE_SUPPLY_RADIUS of it
 * is supplied x NAVY_BLOCKADE_SUPPLY for its attacks and counts as unsupplied for its defence, and the blockader's
 * warships capture (instead of sink) its trade ships: the cargo x NAVY_CAPTURE_GOLD goes to the blockader.
 */
export const NAVY_BLOCKADE_RANGE = 10;
export const NAVY_BLOCKADE_TRADE_CUT = 0.75;
export const NAVY_BLOCKADE_SUPPLY_RADIUS = 18;
export const NAVY_BLOCKADE_SUPPLY = 0.6;
export const NAVY_CAPTURE_GOLD = 1.5;
/** 'escort': an escorted ship (an own escort within NAVY_ESCORT_RADIUS tiles) takes x NAVY_ESCORT_DAMAGE from warships */
export const NAVY_ESCORT_RADIUS = 6;
export const NAVY_ESCORT_DAMAGE = 0.3;
/** escorts pick own transports (first) or trade ships within this many tiles; at most NAVY_ESCORT_MAX per ship */
export const NAVY_ESCORT_PICK = 90;
export const NAVY_ESCORT_MAX = 3;
/** veterancy: xp for sinking a ship / per second of shelling; levels at these xp; per level +1 max hp, damage x (1 + NAVY_VET_DAMAGE) */
export const NAVY_XP_SINK = 3;
export const NAVY_XP_SHELL_PER_S = 0.05;
export const NAVY_VET_XP: readonly number[] = [5, 14, 30];
export const NAVY_VET_DAMAGE = 0.2;
/** fleet cap: NAVY_CAP_BASE + NAVY_CAP_PER_PORT_LEVEL per finished port level; ports build x (1 + NAVY_PORT_BUILD_SPEED x (level - 1)) faster */
export const NAVY_CAP_BASE = 4;
export const NAVY_CAP_PER_PORT_LEVEL = 3;
export const NAVY_PORT_BUILD_SPEED = 0.35;
/** Carriers: support range x this; Submarines: blockade range x this and captured gold x NAVY_SUB_CAPTURE */
export const NAVY_CARRIER_SUPPORT_RANGE = 1.5;
export const NAVY_SUB_BLOCKADE_RANGE = 1.5;
export const NAVY_SUB_CAPTURE = 1.5;

// ---------- armor, part two: reusable divisions, refit, veterancy, encirclement, support mode (armor2.ts) ----------
/** refit per second (share of a full division, taken from the home pool): near an own Factory / anywhere else */
export const ARMOR_REFIT_FACTORY = 0.03;
export const ARMOR_REFIT_FIELD = 0.006;
/** 'near a Factory' = within this many tiles of an own finished Factory */
export const ARMOR_REFIT_RADIUS = 6;
/** veterancy: a spearhead taking at least ARMOR_VET_MIN_TILES gives its tiles as xp; levels at these xp */
export const ARMOR_VET_MIN_TILES = 8;
export const ARMOR_VET_XP: readonly number[] = [20, 60, 140];
/** per level: head speed and max depth x (1 + ARMOR_VET_SPEED), losses x (1 - ARMOR_VET_LOSS) */
export const ARMOR_VET_SPEED = 0.12;
export const ARMOR_VET_LOSS = 0.08;
/** Railways: +1 division per this many Factory levels (on top of TANK_PER_FACTORY_LEVEL per level) */
export const ARMOR_RAILWAY_LEVELS = 2;
/**
 * Encirclement: while a spearhead runs (every ARMOR_POCKET_EVERY tiles) and when it ends, pieces of the target's land
 * next to its line that are cut off (closed by the attacker's / its allies' land and water; no capital) and at most
 * ARMOR_POCKET_MAX_TILES (and less than half the target's land) collapse to the attacker; the target loses that share
 * of its home army x ARMOR_POCKET_KILL.
 */
export const ARMOR_POCKET_EVERY = 6;
export const ARMOR_POCKET_MAX_TILES = 3000;
export const ARMOR_POCKET_KILL = 0.6;
/** 'support': looks for a weak spot every this many seconds within ARMOR_SUPPORT_RADIUS tiles of its front */
export const ARMOR_SUPPORT_SCAN_SECONDS = 3;
export const ARMOR_SUPPORT_RADIUS = 24;
/** launches when at least this share of a full division; drives back to refit at a Factory below ARMOR_SUPPORT_REFIT */
export const ARMOR_SUPPORT_READY = 0.7;
export const ARMOR_SUPPORT_REFIT = 0.45;
/** holds this many tiles behind the front (within this distance of the front tile) */
export const ARMOR_SUPPORT_HOLD = 8;
/** a launch needs at least this expected depth (tiles); a line that cuts the enemy's land counts ARMOR_CUT_BONUS extra */
export const ARMOR_SUPPORT_MIN_DEPTH = 4;
export const ARMOR_CUT_BONUS = 10;
/** escorts sail x this fast to keep up with transports; warships near an own port mend this many hp/s */
export const NAVY_ESCORT_SPEED = 2;
export const NAVY_PORT_REPAIR = 0.1;
/** two nations count as at war while an attack runs between them and this many seconds after (fleets, support divisions) */
export const NAVY_WAR_MEMORY = 30;
/** automatic division drives (support / refit modes) search at most this many tiles, and wait this long after a failed route */
export const ARMOR_AUTO_PATH_BUDGET = 8000;
export const ARMOR_RETRY_SECONDS = 20;

// ---------- special upgrades (specials.ts): behaviour changes bought as techs ----------
export const SPECIALS = {
  /** systems in specials.ts run every this many ticks (damage scales with the elapsed time) */
  checkTicks: 5,
  // Amphibious Tanks
  /** widest water crossing (tiles of water in a straight line between two shores) */
  amphibMaxWater: 5,
  /** spearhead head speed on water, x TANK_SPEARHEAD_SPEED */
  amphibWaterSpeed: 0.35,
  /** extra launch reach (tiles) for spearheads across water, on top of TANK_LAUNCH_REACH */
  amphibLaunchReach: 5,
  /** share of the division's troops lost on each landing (supply penalty) */
  amphibLandingLoss: 0.08,
  /** per second, per hostile warship within WARSHIP_RANGE: share of a wading division's troops lost */
  amphibShipFirePerS: 0.06,
  /** share lost when a holding division is stranded on water (it falls back home like an overrun one) */
  amphibStrandedLoss: 0.25,
  // Early Warning
  /** SAM radius and airfield fighter cover radius x this for the holder */
  ewRadiusMul: 1.4,
  /** submarine reveal range from own coast and ships x this (techtree.unitVisibleTo, E.submarineRevealRange) */
  ewSubRangeMul: 2,
  /** own finished SAMs, airfields and watchtowers spot submarines within this many tiles */
  ewSubSiteRange: 30,
  /** watchtower plane / landing warnings radius x this */
  ewWarnMul: 1.5,
  // Naval Mines
  /** water within this radius of a finished own port is mined (+ per port level above 1) */
  mineRadius: 9,
  mineRadiusPerLevel: 2,
  /** hp per second taken by a hostile warship / submarine in a minefield (warships have 3 hp) */
  mineDamagePerS: 0.1,
  /** per second: share of a wading tank division's troops lost in a hostile minefield */
  mineDivisionLossPerS: 0.08,
  /** invasions: share of the troops aboard lost per mined tile on the transport's route, capped */
  mineTransportLossPerTile: 0.03,
  mineTransportMaxLoss: 0.4,
  /** an own warship within this many tiles of the landing sweeps a lane: the loss x mineEscortMul */
  mineSweepRadius: 6,
  mineEscortMul: 0.4,
  // Drop Tanks
  /** air-wing mission reach x this */
  dropTanksRange: 1.6,
  /** paradrop reach x this */
  dropTanksParadrop: 1.5,
  /** superiority patrol radius and patrol-centre reach x this */
  dropTanksPatrol: 1.3,
  // Night Bombing
  /** chance a bomber dodges one SAM shot / fighter pass; against a holder of Early Warning */
  nightDodge: 0.75,
  nightDodgeVsRadar: 0.35,
  /** bombs land up to this many tiles off the aim (uniform in a square, deterministic rng) */
  nightScatter: 4,
  /** bomb radius x this; buildings hit, troops killed, support kills and raid cut x nightEffect */
  nightRadius: 0.85,
  nightEffect: 0.75,
};

// ---------- arsenal: vehicle variants, shared unlocks, masteries (arsenal.ts, variants.ts) ----------
/** Warship variants: multipliers on the standard warship (UNITS.warship, WARSHIP_* numbers); hp = extra hit points. */
export interface NavalVariantInfo {
  name: string;
  /** price x */
  cost: number;
  /** speed x */
  speed: number;
  /** extra max hp (the standard warship has UNITS.warship.hp) */
  hp: number;
  /** auto-intercept detection range x */
  detect: number;
  /** damage x against warships */
  damage: number;
  /** damage x against trade ships and transports */
  vsTrade: number;
  /** damage x against submarines */
  vsSub: number;
  /** shore shelling kill x (0 = never shells) and its reach x */
  shell: number;
  shellRange: number;
  /** naval support range x (0 = gives no support to landings / attacks) */
  support: number;
  /** blockade range x */
  blockade: number;
}
export const ARSENAL = {
  /** mastery techs in at most this many pillars per game */
  masteryCap: 2,
  /** AI: a mastery is put first in the research order only once the nation has this many techs (arsenalAI / variantsAI) */
  aiMasteryMinTechs: 8,
  naval: {
    destroyer: { name: 'Destroyer', cost: 0.85, speed: 1.3, hp: 0, detect: 1.5, damage: 1, vsTrade: 1, vsSub: 3, shell: 0.5, shellRange: 1, support: 0.8, blockade: 1 },
    battleship: { name: 'Battleship', cost: 1.8, speed: 0.7, hp: 3, detect: 1, damage: 1.4, vsTrade: 1, vsSub: 0.5, shell: 2, shellRange: 2, support: 1.8, blockade: 1 },
    submarine: { name: 'Submarine', cost: 1, speed: 1.05, hp: 0, detect: 1.2, damage: 1, vsTrade: 2.5, vsSub: 1, shell: 0, shellRange: 1, support: 0, blockade: 1.5 },
    carrier: { name: 'Carrier', cost: 1.7, speed: 0.85, hp: 1, detect: 1.2, damage: 0.6, vsTrade: 0.6, vsSub: 0.6, shell: 0.3, shellRange: 1, support: 1.5, blockade: 1 },
  } as Record<'destroyer' | 'battleship' | 'submarine' | 'carrier', NavalVariantInfo>,
  /** submarines: enemy warships other than destroyers fire at a hidden submarine only within this many tiles */
  subTargetRange: 8,
  /** ...and their hits on submarines x this */
  subHitByOthers: 0.6,
  /** destroyers reveal (and may fire at) submarines within this many tiles */
  destroyerSonar: 22,
  /** submarines: captured trade ship gold x this */
  subCapture: 1.5,
  /** carriers: an air wing may strike any target within this many tiles of an own carrier (bombers launch from it) */
  carrierAirRange: 70,
  /** Naval Mastery: veterancy xp x, bombardment / support reach x, extra warships */
  navalMasteryXp: 2,
  navalMasteryRange: 1.3,
  navalMasteryShips: 2,
  // tank divisions (per-player path; existing divisions convert)
  light: { cost: 0.8, speed: 1.45, depth: 1.5, width: 1, roughLoss: 1.5, defense: 0.95, revealRadius: 22, revealSeconds: 20 },
  heavy: { cost: 1.35, speed: 0.75, depth: 0.9, roughLoss: 0.7, defense: 1.3, loss: 0.9 },
  /** Deep Raids: light spearhead depth x, speed x, refit x */
  deepRaidsDepth: 1.3,
  deepRaidsSpeed: 1.15,
  deepRaidsRefit: 1.5,
  /** Siege Tanks: forts passed are knocked out this long; loss in forts / mountains x */
  siegeFortSeconds: 30,
  /** ...within this many tiles of the breached tile */
  siegeFortReach: 12,
  siegeRoughLoss: 0.5,
  /** Armor Mastery: pocket size limit x, pocket troop kill x */
  armorMasteryPocket: 3,
  armorMasteryKill: 1.5,
  // bombers (per-player path)
  groundAttack: { support: 1.6, strategic: 0.6, range: 1, hp: 0 },
  heavyBomber: { support: 0.7, strategic: 1.7, range: 1.5, hp: 1 },
  /** Air Mastery: wing size x */
  airMasteryWing: 1.5,
  // Mechanized infantry
  mechSpearheadLoss: 0.85,
  mechHoldDefense: 1.4,
  mechHoldSeconds: 60,
  mechHoldMaxRadius: 14,
  // Recon planes
  reconCooldown: 45,
  /** reach from the airfield (tiles) + per airfield level above 1 */
  reconRange: 90,
  reconRangePerLevel: 15,
  reconRadius: 18,
  reconSeconds: 40,
};
