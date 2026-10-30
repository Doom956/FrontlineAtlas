// All balance numbers. Rates are per second of game time unless the name says otherwise.
import type { BuildingType, MapSize, Personality, TechId, TerrainId, TroopType, UnitType } from './types';

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
export const MARKET_MAX_BONUS = 1.2;
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
export const TROOP_ATTACK: Record<TroopType, number> = { infantry: 1.0, armor: 2.2, artillery: 1.9 };
/** Artillery at home shells attackers: 0.9 (it used to be 0.6, a liability on defence). */
export const TROOP_DEFENSE: Record<TroopType, number> = { infantry: 1.0, armor: 1.5, artillery: 0.9 };
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
 * Nations: tiles/s per front tile on plains at even odds; divided by clamp(1 / odds, ODDS_SPEED): outnumbering the
 * defender speeds it up modestly (x1.2 at most), hopeless odds crawl (down to x0.13).
 */
export const NATION_FRONT_RATE = 5.2;
export const ODDS_SPEED: [number, number] = [0.82, 7.5];
/**
 * Attacker losses per tile vs a nation: ATTACK_LOSS_BASE x terrain defence x forts x clamp(1 / odds, OUTNUMBER_LOSS)
 * x (LOSS_FLAT + LOSS_DENSITY x defender density) / attack power per unit. Odds = attack strength / the defender's
 * home army strength: send more, lose less (x0.6 at 2:1 or better, x2 at 1:2 or worse).
 */
export const ATTACK_LOSS_BASE = 200;
export const OUTNUMBER_LOSS: [number, number] = [0.6, 2];
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
  market: { name: 'Market', hotkey: '3', cost: 500, iron: 0, costGrowth: 0.4, buildTime: 5, tech: null, coastal: false, radius: 0, maxLevel: 5, capturable: true, description: '+12% gold per level (all markets together at most +120%).' },
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
}
export const TECHS: Record<TechId, TechInfo> = {
  agriculture: { name: 'Agriculture', tier: 1, science: 150, gold: 300, requires: [], description: 'Farms +50% growth.' },
  metallurgy: { name: 'Metallurgy', tier: 1, science: 150, gold: 300, requires: [], description: 'Iron +50%; armor and artillery cost 25% less iron.' },
  logistics: { name: 'Logistics', tier: 1, science: 150, gold: 300, requires: [], description: 'Supply range +50%, attack speed +15%.' },
  fortification: { name: 'Fortification', tier: 1, science: 150, gold: 300, requires: [], description: 'Forts x2.5 and radius 28.' },
  navigation: { name: 'Navigation', tier: 1, science: 150, gold: 300, requires: [], description: 'Warships; transports +50% speed and +1 at sea.' },
  banking: { name: 'Banking', tier: 2, science: 600, gold: 600, requires: ['agriculture'], description: 'Gold +30%, markets x1.5.' },
  medicine: { name: 'Medicine', tier: 2, science: 600, gold: 600, requires: ['agriculture'], description: 'Hospitals; troop growth +20%.' },
  mechanization: { name: 'Mechanization', tier: 2, science: 600, gold: 600, requires: ['metallurgy'], description: 'Armor +25% attack and defence.' },
  ballistics: { name: 'Ballistics', tier: 2, science: 600, gold: 600, requires: ['metallurgy'], description: 'Artillery +30% attack; unescorted penalty starts at 55%; barrages reach x1.5 farther and reload faster.' },
  flight: { name: 'Flight', tier: 2, science: 600, gold: 600, requires: ['logistics'], description: 'Airfields, bombers and fighters.' },
  industrialization: { name: 'Industrialization', tier: 3, science: 2200, gold: 1000, requires: ['mechanization'], description: 'Factories and arsenals convert twice as fast; mines and wells +25%.' },
  combinedArms: { name: 'Combined Arms', tier: 3, science: 2200, gold: 1000, requires: ['mechanization', 'ballistics'], description: '+20% attack when every troop type is at least 15% of the force.' },
  radar: { name: 'Radar', tier: 3, science: 2200, gold: 1000, requires: ['flight'], description: 'SAM sites; watchtower radius x2.' },
  rocketry: { name: 'Rocketry', tier: 3, science: 2200, gold: 1000, requires: ['ballistics'], description: 'Missile silos and rockets.' },
  nuclearFission: { name: 'Nuclear Fission', tier: 4, science: 5000, gold: 2000, requires: ['rocketry', 'industrialization'], description: 'Atom bombs.' },
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
  transport: { name: 'Transport', speed: 10, gold: 150, iron: 0, oil: 0, hp: 1, tech: null },
  warship: { name: 'Warship', speed: 8, gold: 900, iron: 80, oil: 20, hp: 3, tech: 'navigation' },
  tradeShip: { name: 'Trade ship', speed: 7, gold: 0, iron: 0, oil: 0, hp: 1, tech: null },
  bomber: { name: 'Bomber', speed: 30, gold: 500, iron: 30, oil: 40, hp: 1, tech: 'flight' },
  fighter: { name: 'Fighter', speed: 40, gold: 400, iron: 20, oil: 20, hp: 1, tech: 'flight' },
  rocket: { name: 'Rocket', speed: 55, gold: 900, iron: 60, oil: 30, hp: 1, tech: 'rocketry' },
  atomBomb: { name: 'Atom bomb', speed: 35, gold: 6000, iron: 300, oil: 150, hp: 2, tech: 'nuclearFission' },
  /** paratrooper drop: the price is paid per drop */
  transportPlane: { name: 'Cargo plane', speed: 30, gold: 400, iron: 0, oil: 30, hp: 1, tech: 'flight' },
};
export const TRANSPORT_MAX_AT_SEA = 3;
export const TRANSPORT_PER_PORT = 2;
export const PORT_TRANSPORT_SPEED = 1.6;
export const NAVIGATION_TRANSPORT_SPEED = 1.5;
export const WARSHIP_RANGE = 20;
export const WARSHIP_DAMAGE_PER_S = 0.5; // hp/s to one target in range
export const WARSHIP_BOMBARD_KILL = 150; // defender troops/s killed when an enemy coast tile is in range
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

// ---------- diplomacy ----------
export const ALLIANCE_DURATION = 300; // seconds
export const ALLIANCE_REQUEST_TIMEOUT = 30;
export const TRAITOR_DURATION = 45;
export const TRAITOR_DEFENSE = 0.6;
/** Being attacked by a nation stops trade with it (both ways) for this long, unless toggled by hand. */
export const AUTO_EMBARGO_SECONDS = 300;
export const NUKE_OPINION_PENALTY = 60;
export const BETRAYAL_OPINION_PENALTY = 50;

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
    `lose fewer troops per tile (down to x${OUTNUMBER_LOSS[0]} when you are twice as strong, up to ` +
    `x${OUTNUMBER_LOSS[1]} at half) and to move a little faster. Land you can't reach on foot gets a transport from ` +
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
    `trade with the attacker for ${AUTO_EMBARGO_SECONDS / 60} minutes and cancels pending alliance requests between you.`,
} as const;

export const AI_DECISION_SECONDS: Record<'easy' | 'normal' | 'hard', number> = { easy: 4, normal: 3, hard: 2 };
export const AI_HARD_INCOME_BONUS = 0.15;
