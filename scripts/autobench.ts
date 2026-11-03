// Auto bench: how well a HUMAN player's vehicles do on their own (the defaults a new player leaves them on).
//
// Player 1 is a human slot played by a scripted bot. It plays a reasonable economy (cities, farms, markets, labs, a
// port, mines and oil wells where it owns deposits, factories, an airfield, a missile silo, a few forts near nations)
// and attacks like a decent player: it hits back at whoever attacks it, expands into wilderness and tribes, then
// attacks its weakest neighbouring nation (or, with no land neighbour left, the nearest nation by sea) whenever its
// troop bar is fairly full. Army mix stays on auto. It researches the techs its vehicles need (Navigation,
// Mechanization, Flight, Rocketry and what they require; research is off auto until then), then hands research back
// to auto. It buys vehicles the way
// a new player would when it has the money: warships at its port (up to MAX_SHIPS), tank divisions up to the Factory
// limit, bombers and fighters (2:1) to fill its airfield, and builds one missile silo. It never gives a vehicle an
// order (no moves, targets, manual strikes or rockets). --clicks picks what it sets:
//   none  pure defaults: warships auto (Follow my war), divisions hold, airfields idle, silo auto-fire off
//   once  one plausible click per vehicle when it appears: each new division Support front (following), each new
//         airfield Support (following, no target), silos auto-fire on (all silos); warships keep their default
// A list (none,once) plays the same seeds with each setting.
//
// Measured, sampled every SAMPLE_SECONDS while player 1 is at war with a nation (an attack either way in the last
// NAVY_WAR_MEMORY seconds, naval2.warSet; tribes don't count), per vehicle type, as shares of unit-time:
//   warship   useful = fighting (chasing, or a hostile ship at war in gun range), shelling (enemy coast at war in shell
//             range) or blockading (an enemy port at war in blockade range); moving = sailing; mending = damaged at
//             a port; idle = the rest
//   division  useful = spearheading (or driving to its launch tile), or at a front (enemy land at war within
//             FRONT_TILES, or a support division holding behind its front); moving = driving; refit = worn down and
//             not moving; idle = the rest
//   airfield  (finished, one per airfield) useful = a bomber of it in the air or a sortie in the last sortie cooldown,
//             or a superiority patrol at the front; empty = no aircraft; idle = the rest
//   silo      (finished) useful = a rocket of it in the air or a launch slot reloading; idle = the rest
// Idle samples carry a reason (the setting or the missing war target / front that keeps the unit idle). Also: time
// from a unit appearing to its first useful sample, payloads wasted (bombs brought home / dropped off hostile land,
// matched like batch.ts), rockets fired, units lost, how often player 1 has no war target (warTarget.followedNation
// 0) or no land front to it (mainFront -1) while at war, and player 1's outcome (land share at 15 / 25 min, alive).
// The bot only reads the state and acts through applyAction (like a client); the measuring is read-only.
//
// Usage: npx vite-node scripts/autobench.ts -- [options]
//   --maps medium                generated sizes and/or world:<id>                          (default: medium)
//   --types continents,...       generated map types, game k uses type k mod the list      (default: all four)
//   --difficulty normal          AI difficulty list                                         (default: normal)
//   --clicks none,once           bot settings, see above                                    (default: none,once)
//   --seeds 8 --start 1          seeds per map x difficulty x clicks                        (default: 8 from 1)
//   --minutes 25                 game-minute cap                                            (default: 25)
//   --jobs 4                     worker processes                                           (default: 4)
//   --trace                      (with --jobs 1) a line per minute about the bot's vehicles
//   --json                       one JSON line per game
//   --shard s/n                  play every n-th game from s, print JSON lines (GitHub runners)
//   --from a.jsonl,b.jsonl       report from JSON lines written by --shard runs instead of playing
import { buildingCost, buildingsOf, canBuild, chargesReady } from '../src/sim/buildings';
import {
  AIR,
  ARMOR_SUPPORT_HOLD,
  ARMOR_SUPPORT_RADIUS,
  ARMOR_SUPPORT_READY,
  MIN_ATTACK_TROOPS,
  NAVY_BLOCKADE_RANGE,
  STRIKE,
  TECHS,
  TICKS_PER_SECOND,
  VICTORY_LAND_SHARE,
  WARSHIP_RANGE,
  WARSHIP_SHELL_RANGE,
} from '../src/sim/config';
import { applyRules } from './rules';
import { tick } from '../src/sim/sim';
import { canSpawnAt, createGame, gameSeconds, ownerBox } from '../src/sim/state';
import { borderTiles, ownedTilesOf } from '../src/sim/territory';
import { applyAction } from '../src/sim/actions';
import { forEachInRadius } from '../src/sim/grid';
import { areAllied } from '../src/sim/diplomacy';
import { atPeace } from '../src/sim/rules';
import { hasTech } from '../src/sim/tech';
import { isArsenalTech } from '../src/sim/arsenal';
import { warSet, warshipCount, warshipLimit } from '../src/sim/naval2';
import { bestFactory, tankDivisionCount, tankDivisionLimit } from '../src/sim/tanks';
import { divisionMode, divisionStrength } from '../src/sim/armor2';
import { airWingRange, wingOf } from '../src/sim/airwings';
import { autoFireOn } from '../src/sim/airstrike';
import { unitCost } from '../src/sim/units';
import { followedNation, mainFront } from '../src/sim/warTarget';
import { navalShellMul, navalShellRangeMul } from '../src/sim/variants';
import { cloneSetup, DEFAULT_MODIFIERS, DEFAULT_SETUP, SINGLE_PLAYER_NATIONS } from '../src/sim/setup';
import { isTribe, isWater } from '../src/sim/types';
import { loadWorldMap } from '../src/sim/worldmaps';
import type { Building, BuildingType, Difficulty, GameSettings, GameState, MapSize, MapType, TechId, Troops, Unit } from '../src/sim/types';

declare const process: { argv: string[]; exit(code?: number): never; stdout: { write(s: string): boolean } };

const ME = 1;
const SAMPLE_SECONDS = 2;
/** a holding division with enemy land at war this close counts as at the front (TANK_DEFENSE_RADIUS 4 + 2) */
const FRONT_TILES = 6;
/** warships the bot buys at most */
const MAX_SHIPS = 6;
/** gold the bot keeps after a vehicle purchase */
const VEHICLE_RESERVE = 400;

type Clicks = 'none' | 'once';
type VKind = 'ship' | 'tank' | 'air' | 'silo';
const VKINDS: VKind[] = ['ship', 'tank', 'air', 'silo'];
const VNAME: Record<VKind, string> = { ship: 'warships', tank: 'tank divisions', air: 'airfields', silo: 'silos' };

// ---------------------------------------------------------------------------------------------------------------
// The bot (only reads the state and acts through applyAction, like a human client)
// ---------------------------------------------------------------------------------------------------------------

/** Own small RNG so the bot never draws from state.rng (the AIs' stream stays as in a real game). */
function mulberry(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Build order; items it can't do yet (tech, money) wait, items with no site after a few tries are dropped. */
const PLAN: BuildingType[] = [
  'city', 'farm', 'city', 'market', 'lab', 'port', 'farm', 'city', 'factory', 'mine', 'oilWell', 'city', 'fort',
  'airfield', 'lab', 'factory', 'city', 'silo', 'market', 'farm', 'city', 'factory', 'fort', 'mine', 'oilWell', 'city',
];
/** After the plan: keep growing with these (upgrades or new ones), round robin. */
const LATER: BuildingType[] = ['city', 'farm', 'market', 'city', 'lab'];
/** Techs the bot's vehicles need, in the order it goes for them. */
const VEHICLE_TECHS: TechId[] = ['navigation', 'mechanization', 'flight', 'rocketry'];
/** Seconds between two builds / two vehicle purchases. */
const BUILD_PAUSE = 15;
/** Troop bar fill above which the bot expands into wilderness / tribes. */
const EXPAND_FILL = 0.25;
/** Troop bar fill above which the bot attacks nations (growth peaks at about 42%). */
const ATTACK_FILL = 0.45;

const sum = (t: Troops): number => t.infantry + t.armor + t.artillery;

class AutoBot {
  private rnd: () => number;
  private nextTick = 0;
  private nextBuildTick = 0;
  private nextBuyTick = 0;
  private planned = 0;
  private later = 0;
  private skipped = new Map<number, number>();
  /** units / buildings already given their one click */
  private clicked = new Set<number>();
  private fireSet = false;
  /** purchases (for losses) */
  bought = { ships: 0, tanks: 0, bombers: 0, fighters: 0 };
  /** --trace: why the last purchases failed */
  notes: string[] = [];

  constructor(seed: number, private clicks: Clicks) {
    this.rnd = mulberry(seed * 7919 + 13);
  }

  spawn(state: GameState): void {
    const map = state.map;
    const w = map.width;
    const n = w * map.height;
    let best = -1;
    let bestScore = -1;
    for (let k = 0, valid = 0; k < 4000 && valid < 6; k++) {
      const t = Math.floor(this.rnd() * n);
      if (isWater(map.terrain[t]) || !canSpawnAt(state, ME, t)) continue;
      valid++;
      let land = 0;
      const x0 = t % w;
      const y0 = (t / w) | 0;
      for (let dy = -30; dy <= 30; dy += 6) {
        for (let dx = -30; dx <= 30; dx += 6) {
          const x = x0 + dx;
          const y = y0 + dy;
          if (x >= 0 && y >= 0 && x < w && y < map.height && !isWater(map.terrain[y * w + x])) land++;
        }
      }
      if (land > bestScore) {
        bestScore = land;
        best = t;
      }
    }
    if (best >= 0) applyAction(state, ME, { type: 'spawn', tile: best });
  }

  update(state: GameState): void {
    if (state.phase !== 'playing') return;
    const p = state.players[ME];
    if (!p.alive) return;
    this.click(state);
    if (state.tick < this.nextTick) return;
    this.nextTick = state.tick + Math.round((3 + 2 * this.rnd()) * TICKS_PER_SECOND);
    this.attack(state);
    this.research(state);
    if (state.tick >= this.nextBuyTick && this.buyVehicle(state)) this.nextBuyTick = state.tick + 5 * TICKS_PER_SECOND;
    if (state.tick >= this.nextBuildTick) this.build(state);
    // Items dropped for want of a site get another chance every 2 min (the land grows).
    if (state.tick % (120 * TICKS_PER_SECOND) < 60) for (const [k, v] of this.skipped) if (v === -2) this.skipped.delete(k);
  }

  /** --clicks once: one setting per new division / airfield / the first silo. */
  private click(state: GameState): void {
    if (this.clicks !== 'once' || state.tick % 5 !== 0) return;
    const ids: number[] = [];
    for (const u of state.units) if (u.type === 'tankDivision' && u.owner === ME && u.hp > 0 && !this.clicked.has(u.id)) ids.push(u.id);
    if (ids.length) {
      for (const id of ids) this.clicked.add(id);
      applyAction(state, ME, { type: 'setDivisionMode', unitIds: ids, mode: 'support', follow: true });
    }
    for (const b of buildingsOf(state, ME, 'airfield')) {
      if (b.owner !== ME || b.buildLeft > 0 || this.clicked.has(b.id)) continue;
      if (applyAction(state, ME, { type: 'setAirMission', airfield: b.tile, mission: 'support', follow: true }).ok) this.clicked.add(b.id);
    }
    if (!this.fireSet && buildingsOf(state, ME, 'silo').some((b) => b.owner === ME && b.buildLeft <= 0)) {
      this.fireSet = applyAction(state, ME, { type: 'setAutoFire', silo: -1, on: true }).ok;
    }
  }

  private attack(state: GameState): void {
    const p = state.players[ME];
    const map = state.map;
    const w = map.width;
    const tileOf = new Map<number, number>();
    const { list, len } = borderTiles(state, ME);
    const step = Math.max(1, Math.floor(len / 1500));
    for (let k = 0; k < len; k += step) {
      const t = list[k];
      const x = t % w;
      for (const j of [x > 0 ? t - 1 : -1, x < w - 1 ? t + 1 : -1, t - w, t + w]) {
        if (j < 0 || j >= map.owner.length || isWater(map.terrain[j])) continue;
        const o = map.owner[j];
        if (o !== ME && !tileOf.has(o)) tileOf.set(o, j);
      }
    }
    const home = sum(p.troops);
    const fill = p.maxPop > 0 ? home / p.maxPop : 0;
    const send = (tile: number, share: number): boolean => {
      const f = Math.min(1, share);
      if (home * f < MIN_ATTACK_TROOPS) return false;
      const troops: Troops = { infantry: p.troops.infantry * f, armor: p.troops.armor * f, artillery: p.troops.artillery * f };
      return applyAction(state, ME, { type: 'attack', tile, troops }).ok;
    };
    const share = 0.3 + 0.1 * this.rnd();
    // Hit back at the biggest attacker we border.
    let attacker = 0;
    let most = 0;
    for (const a of state.attacks) {
      if (a.target !== ME || !tileOf.has(a.attacker) || a.attacker === 0) continue;
      const t = sum(a.troops);
      if (t > most) {
        most = t;
        attacker = a.attacker;
      }
    }
    if (attacker && fill > 0.15) {
      send(tileOf.get(attacker)!, share);
      return;
    }
    const tribes = [...tileOf.keys()].filter((o) => o !== 0 && isTribe(state.players[o]));
    const nations = [...tileOf.keys()].filter((o) => o !== 0 && !isTribe(state.players[o]) && !areAllied(state, ME, o) && !atPeace(state, ME, o));
    if (fill < EXPAND_FILL) return;
    if (tileOf.has(0) && (!tribes.length || this.rnd() < 0.6)) {
      send(tileOf.get(0)!, share);
      return;
    }
    if (tribes.length) {
      send(tileOf.get(tribes[Math.floor(this.rnd() * tribes.length)])!, share);
      return;
    }
    if (fill < ATTACK_FILL) return;
    if (nations.length) {
      let weakest = nations[0];
      for (const q of nations) if (sum(state.players[q].troops) < sum(state.players[weakest].troops)) weakest = q;
      send(tileOf.get(weakest)!, share);
      return;
    }
    // No land neighbour left: the nearest nation by sea (one landing at a time).
    if (state.units.some((u) => u.type === 'transport' && u.owner === ME && u.hp > 0)) return;
    if (p.capital < 0) return;
    let best = 0;
    let bestD = Infinity;
    for (const q of state.players) {
      if (!q || q.id <= 0 || q.id === ME || !q.alive || isTribe(q) || q.capital < 0 || areAllied(state, ME, q.id) || atPeace(state, ME, q.id)) continue;
      const dx = (q.capital % w) - (p.capital % w);
      const dy = ((q.capital / w) | 0) - ((p.capital / w) | 0);
      const d = dx * dx + dy * dy;
      if (d < bestD) {
        bestD = d;
        best = q.id;
      }
    }
    if (best) send(state.players[best].capital, share);
  }

  /**
   * Gets the vehicle techs it lacks, prerequisites first: Research-tab techs researched (one at a time), Arsenal
   * items ordered (procure). Research is off auto until all four are in, then back on auto.
   */
  private research(state: GameState): void {
    const p = state.players[ME];
    const goals = VEHICLE_TECHS.filter((t) => !hasTech(p, t));
    if (!goals.length) {
      if (!p.auto.research) applyAction(state, ME, { type: 'setAuto', research: true });
      return;
    }
    if (p.auto.research) applyAction(state, ME, { type: 'setAuto', research: false }); // picks its own techs until then
    const first = (t: TechId): TechId | null => {
      if (hasTech(p, t) || p.researching === t || p.procuring?.some((o) => o.tech === t)) return null;
      for (const r of TECHS[t].requires) {
        const x = first(r);
        if (x) return x;
      }
      if (TECHS[t].requires.some((r) => !hasTech(p, r))) return null; // a prerequisite is still on its way
      return t;
    };
    for (const g of goals) {
      const t = first(g);
      if (!t) continue;
      if (isArsenalTech(t)) {
        const r = applyAction(state, ME, { type: 'procure', tech: t });
        if (!r.ok) this.note(`procure ${t}: ${r.reason}`);
      } else if (!p.researching && p.gold >= TECHS[t].gold * 1.2) {
        const r = applyAction(state, ME, { type: 'research', tech: t });
        if (!r.ok) this.note(`research ${t}: ${r.reason}`);
      }
    }
  }

  /** One vehicle purchase per call, cheapest need first; keeps VEHICLE_RESERVE gold. */
  private buyVehicle(state: GameState): boolean {
    const p = state.players[ME];
    const ok = (g: number): boolean => p.gold >= g + VEHICLE_RESERVE;
    // Tank divisions up to the Factory limit.
    const f = bestFactory(state, ME);
    if (f >= 0 && hasTech(p, 'mechanization') && tankDivisionCount(state, ME) < tankDivisionLimit(state, ME) && ok(1200)) {
      const r = applyAction(state, ME, { type: 'buildTankDivision', tile: f });
      if (r.ok) {
        this.bought.tanks++;
        return true;
      }
      this.note(`tank: ${r.reason}`);
    }
    // Aircraft: fill each finished airfield, two bombers per fighter.
    if (hasTech(p, 'flight')) {
      for (const b of buildingsOf(state, ME, 'airfield')) {
        if (b.owner !== ME || b.buildLeft > 0) continue;
        const kind = b.bombers >= 2 * Math.max(1, b.fighters) ? 'fighter' : 'bomber';
        if (!ok(kind === 'bomber' ? 500 : 400)) break;
        const r = applyAction(state, ME, { type: 'buildAircraft', airfield: b.tile, kind });
        if (r.ok) {
          if (kind === 'bomber') this.bought.bombers++;
          else this.bought.fighters++;
          return true;
        }
        this.note(`aircraft: ${r.reason}`);
      }
    }
    // Warships at the first finished port.
    if (hasTech(p, 'navigation') && warshipCount(state, ME) < Math.min(MAX_SHIPS, warshipLimit(state, ME)) && ok(900)) {
      const port = buildingsOf(state, ME, 'port').find((b) => b.owner === ME && b.buildLeft <= 0);
      if (port) {
        const r = applyAction(state, ME, { type: 'buildWarship', port: port.tile });
        if (r.ok) {
          this.bought.ships++;
          return true;
        }
        this.note(`warship: ${r.reason}`);
      }
    }
    return false;
  }

  private note(s: string): void {
    if (TRACE && this.notes[this.notes.length - 1] !== s) this.notes.push(s);
  }

  private build(state: GameState): void {
    const p = state.players[ME];
    // The first plan item it can do now (tech, iron; it saves up gold for it); the others wait.
    let pick = -1;
    let type: BuildingType = LATER[this.later % LATER.length];
    for (let k = this.planned; k < PLAN.length; k++) {
      if ((this.skipped.get(k) ?? 0) < 0) continue;
      const t = PLAN[k];
      if (t === 'airfield' && !hasTech(p, 'flight')) continue;
      if (t === 'silo' && !hasTech(p, 'rocketry')) continue;
      if (p.iron < buildingCost(state, ME, t).iron) continue;
      pick = k;
      type = t;
      break;
    }
    const cost = buildingCost(state, ME, type);
    if (p.gold < cost.gold || p.iron < cost.iron) {
      this.note(`build ${type}: money`);
      return;
    }
    const tile = this.siteFor(state, type);
    const res = tile >= 0 ? applyAction(state, ME, { type: 'build', building: type, tile }) : { ok: false, reason: 'no site found' };
    const done = res.ok;
    if (!done) this.note(`build ${type}: ${res.reason}`);
    if (done) {
      this.nextBuildTick = state.tick + BUILD_PAUSE * TICKS_PER_SECOND;
      if (pick >= 0) this.skipped.set(pick, -1);
      else this.later++;
    } else if (pick >= 0) {
      const n = (this.skipped.get(pick) ?? 0) + 1;
      this.skipped.set(pick, n >= 3 ? -2 : n); // no site after a few tries: set aside for now
    } else this.later++;
    while (this.planned < PLAN.length && this.skipped.get(this.planned) === -1) this.planned++;
  }

  /** A tile to build `type` on (or near, the build snaps): upgrades go to the existing one; -1 = none found. */
  private siteFor(state: GameState, type: BuildingType): number {
    const map = state.map;
    const w = map.width;
    const own = buildingsOf(state, ME, type).filter((b) => b.owner === ME && b.buildLeft <= 0 && b.upgradeLeft <= 0);
    // Factories and silos: upgrade the one we have (a new player clicks it and upgrades).
    if ((type === 'factory' || type === 'silo' || type === 'airfield') && own.length) return own[0].tile;
    const box = ownerBox(state, ME);
    if (!box) return -1;
    const [x0, y0, x1, y1] = box;
    const rnd = (): number => (y0 + Math.floor(this.rnd() * (y1 - y0 + 1))) * w + x0 + Math.floor(this.rnd() * (x1 - x0 + 1));
    if (type === 'fort') {
      // Near a nation we border.
      const { list, len } = borderTiles(state, ME);
      for (let k = 0; k < 80 && len; k++) {
        const t = list[Math.floor(this.rnd() * len)];
        const x = t % w;
        for (const j of [x > 0 ? t - 1 : -1, x < w - 1 ? t + 1 : -1, t - w, t + w]) {
          if (j < 0 || j >= map.owner.length) continue;
          const o = map.owner[j];
          if (o > 0 && o !== ME && !isTribe(state.players[o])) return t;
        }
      }
      return -1;
    }
    // Ports, mines, oil wells: on an own coast / deposit tile (the lists may hold tiles lost since: checked).
    const kind = type === 'port' ? 'coast' : type === 'mine' ? 'iron' : type === 'oilWell' ? 'oil' : null;
    const list = kind ? ownedTilesOf(state, ME, kind) : null;
    if (list && !list.length) return -1;
    for (let k = 0; k < 300; k++) {
      const t = list ? list[Math.floor(this.rnd() * list.length)] : rnd();
      if (map.owner[t] !== ME || isWater(map.terrain[t])) continue;
      if (canBuild(state, ME, type, t).ok) return t;
    }
    return -1;
  }
}


// ---------------------------------------------------------------------------------------------------------------
// Measuring (read-only)
// ---------------------------------------------------------------------------------------------------------------

/** Unit-samples at war of one vehicle type: by state, plus idle reasons. */
interface VStat {
  n: number;
  useful: number;
  moving: number;
  idle: number;
  /** mending / refit / empty airfield */
  other: number;
  why: Record<string, number>;
  use: Record<string, number>;
}
const vstat = (): VStat => ({ n: 0, useful: 0, moving: 0, idle: 0, other: 0, why: {}, use: {} });
const bump = (r: Record<string, number>, k: string): void => {
  r[k] = (r[k] ?? 0) + 1;
};

interface Job {
  index: number;
  map: string;
  type: MapType;
  difficulty: Difficulty;
  clicks: Clicks;
  seed: number;
}

interface Result {
  job: Job;
  alive15: boolean;
  alive25: boolean;
  share15: number;
  share25: number;
  deathMinute: number;
  minutes: number;
  /** samples while at war; of them: no war target, war target with no land front, only defending */
  warSamples: number;
  noTarget: number;
  noFront: number;
  defendOnly: number;
  /** samples while at war in which player 1 has each vehicle */
  v: Record<VKind, VStat>;
  /** units / buildings that appeared */
  built: Record<VKind, number>;
  /** seconds from appearing to the first useful sample (-1 = never), units that appeared before the last 3 min */
  first: Record<VKind, number[]>;
  bought: { ships: number; tanks: number; bombers: number; fighters: number };
  /** losses: warships sunk, divisions overrun / spent / gone otherwise, aircraft lost (bought - left) */
  lost: { ships: number; overrun: number; spent: number; divOther: number; aircraft: number };
  bombs: { arrivals: number; home: number; off: number };
  rockets: number;
  sorties: number;
  /** player 1's unitLost events by kind (names and numbers taken out) */
  lossWhy: Record<string, number>;
}

function hostile(state: GameState, a: number, b: number): boolean {
  return a !== b && a > 0 && b > 0 && !areAllied(state, a, b) && !atPeace(state, a, b);
}
function tileOfUnit(state: GameState, u: Unit): number {
  return Math.round(u.y) * state.map.width + Math.round(u.x);
}

class Meter {
  r: Result;
  private seen = new Map<number, { kind: VKind; tick: number; useful: boolean }>();
  private lastBomber = new Map<number, number>();
  private lastSorties = new Map<number, { n: number; tick: number }>();
  private ships = new Set<number>();
  private divs = new Set<number>();
  private rocketIds = new Set<number>();
  private spentNow = 0;
  private overrunNow = 0;

  constructor(job: Job) {
    const per = <T>(f: () => T): Record<VKind, T> => ({ ship: f(), tank: f(), air: f(), silo: f() });
    this.r = {
      job,
      alive15: false,
      alive25: false,
      share15: 0,
      share25: 0,
      deathMinute: -1,
      minutes: 0,
      warSamples: 0,
      noTarget: 0,
      noFront: 0,
      defendOnly: 0,
      v: per(vstat),
      built: per(() => 0),
      first: per(() => [] as number[]),
      bought: { ships: 0, tanks: 0, bombers: 0, fighters: 0 },
      lost: { ships: 0, overrun: 0, spent: 0, divOther: 0, aircraft: 0 },
      bombs: { arrivals: 0, home: 0, off: 0 },
      rockets: 0,
      sorties: 0,
      lossWhy: {},
    };
  }

  /** Events of the tick just played. */
  events(state: GameState): void {
    for (const e of state.events) {
      if (e.players[0] !== ME) continue;
      if (e.kind === 'unitLost') {
        // Names out, numbers out: one key per kind of loss.
        const key = e.message.replace(/\d[\d.,]*[kM]?/g, 'N').replace(new RegExp(`^${state.players[ME].name}('s)?`), 'P1').replace(/to [^']+'s/, "to an enemy's").replace(/(off|into) [^']+'s/, "$1 an enemy's");
        bump(this.r.lossWhy, key);
      }
      if (e.kind === 'unitLost' && /tank division was overrun/.test(e.message)) this.overrunNow++;
      else if ((e.kind as string) === 'spearheadEnded' && /the division is spent/.test(e.message)) this.spentNow++;
    }
    for (const u of state.units) {
      if (u.owner !== ME || u.hp <= 0) continue;
      if (u.type === 'rocket' && !this.rocketIds.has(u.id)) {
        this.rocketIds.add(u.id);
        this.r.rockets++;
      }
    }
  }

  /** Units / buildings that appeared or vanished; called every sample. */
  private census(state: GameState): void {
    const shipsNow = new Set<number>();
    const divsNow = new Set<number>();
    for (const u of state.units) {
      if (u.owner !== ME || u.hp <= 0) continue;
      if (u.type === 'warship') shipsNow.add(u.id);
      else if (u.type === 'tankDivision') divsNow.add(u.id);
    }
    for (const id of this.ships) if (!shipsNow.has(id)) this.r.lost.ships++;
    let gone = 0;
    for (const id of this.divs) if (!divsNow.has(id)) gone++;
    this.r.lost.overrun += this.overrunNow;
    this.r.lost.spent += this.spentNow;
    this.r.lost.divOther += Math.max(0, gone - this.overrunNow - this.spentNow);
    this.overrunNow = 0;
    this.spentNow = 0;
    this.ships = shipsNow;
    this.divs = divsNow;
  }

  private appear(id: number, kind: VKind, t: number): void {
    if (this.seen.has(id)) return;
    this.seen.set(id, { kind, tick: t, useful: false });
    this.r.built[kind]++;
  }
  private markUseful(state: GameState, id: number): void {
    const s = this.seen.get(id);
    if (!s || s.useful) return;
    s.useful = true;
    this.r.first[s.kind].push((state.tick - s.tick) / TICKS_PER_SECOND);
  }

  sample(state: GameState): void {
    this.census(state);
    const me = state.players[ME];
    if (!me.alive) return;
    const map = state.map;
    const w = map.width;
    const wars = warSet(state);
    let atWarNow = false;
    for (const q of state.players) if (q && q.id > 0 && q.id !== ME && q.alive && !isTribe(q) && wars.has(ME * 1024 + q.id) && hostile(state, ME, q.id)) atWarNow = true;
    const foe = (o: number): boolean => o > 0 && o !== ME && wars.has(ME * 1024 + o) && hostile(state, ME, o);
    const target = followedNation(state, ME);
    const front = target > 0 ? mainFront(state, ME, target) : -1;
    const r = this.r;
    if (atWarNow) {
      r.warSamples++;
      if (target <= 0) r.noTarget++;
      else if (front < 0) r.noFront++;
      if (!state.attacks.some((a) => a.attacker === ME && a.target > 0 && !isTribe(state.players[a.target]) && sum(a.troops) > 0)) r.defendOnly++;
    }
    const t = state.tick;
    const reasonTarget = (): string | null => (target <= 0 ? 'no war target' : front < 0 ? 'war target has no land front' : null);

    // Warships
    const ships = state.units.filter((x) => x.hp > 0 && (x.type === 'warship' || x.type === 'transport' || x.type === 'tradeShip'));
    for (const u of state.units) {
      if (u.owner !== ME || u.hp <= 0 || u.type !== 'warship') continue;
      this.appear(u.id, 'ship', t);
      let use = '';
      if ((u.chase ?? 0) > 0 || u.state === 2) use = 'fight';
      if (!use) {
        for (const s of ships) {
          if (s === u || !foe(s.owner)) continue;
          if ((s.x - u.x) * (s.x - u.x) + (s.y - u.y) * (s.y - u.y) <= WARSHIP_RANGE * WARSHIP_RANGE) {
            use = 'fight';
            break;
          }
        }
      }
      if (!use && navalShellMul(u) > 0) {
        forEachInRadius(map, tileOfUnit(state, u), WARSHIP_SHELL_RANGE * navalShellRangeMul(state, u), (i) => {
          if (!use && map.coastal[i] && foe(map.owner[i])) use = 'shell';
        });
      }
      if (!use) {
        for (const b of state.buildings.values()) {
          if (b.type !== 'port' || !foe(b.owner)) continue;
          const dx = (b.tile % w) - u.x;
          const dy = ((b.tile / w) | 0) - u.y;
          if (dx * dx + dy * dy <= NAVY_BLOCKADE_RANGE * NAVY_BLOCKADE_RANGE) {
            use = 'blockade';
            break;
          }
        }
      }
      if (use) this.markUseful(state, u.id);
      if (!atWarNow) continue;
      const v = r.v.ship;
      v.n++;
      if (use) {
        v.useful++;
        bump(v.use, use);
      } else if (u.path.length && u.pathPos < u.path.length) v.moving++;
      else if (u.hp < 3 - 1e-6 && buildingsOf(state, ME, 'port').some((b) => (b.tile % w - u.x) ** 2 + (((b.tile / w) | 0) - u.y) ** 2 <= 64)) {
        v.other++;
        bump(v.why, 'mending at port');
      } else {
        v.idle++;
        const stance = u.stance ?? 'auto';
        bump(v.why, stance !== 'auto' ? `stance ${stance}` : target <= 0 ? 'no war target' : (u.retryTick ?? 0) > t ? 'coast search found nothing (waiting)' : u.state === 3 ? 'on station, nothing in range' : 'patrolling, has a war target');
      }
    }

    // Tank divisions
    for (const u of state.units) {
      if (u.owner !== ME || u.hp <= 0 || u.type !== 'tankDivision') continue;
      this.appear(u.id, 'tank', t);
      const mode = divisionMode(u);
      let use = '';
      if (u.state === 3 || u.state === 2) use = 'spearhead';
      else if (u.state === 0) {
        let near = false;
        forEachInRadius(map, tileOfUnit(state, u), FRONT_TILES, (i) => {
          if (!near && foe(map.owner[i]) && !isWater(map.terrain[i])) near = true;
        });
        if (!near && mode === 'support' && u.station !== undefined) {
          const st = u.station;
          const dx = (st % w) - u.x;
          const dy = ((st / w) | 0) - u.y;
          near = dx * dx + dy * dy <= (ARMOR_SUPPORT_HOLD + 6) ** 2 && foe(map.owner[st]);
        }
        if (near) use = 'at the front';
      }
      if (use) this.markUseful(state, u.id);
      if (!atWarNow) continue;
      const v = r.v.tank;
      v.n++;
      if (use) {
        v.useful++;
        bump(v.use, use);
      } else if (u.state === 1) v.moving++;
      else if (divisionStrength(u) < ARMOR_SUPPORT_READY) {
        v.other++;
        bump(v.why, 'refit (worn down)');
      } else {
        v.idle++;
        if (mode === 'hold') bump(v.why, 'mode hold (default)');
        else if (mode === 'refit') bump(v.why, 'mode refit');
        else if (u.station === undefined) bump(v.why, `support: ${reasonTarget() ?? 'no front set'}`);
        else {
          const st = u.station;
          const far = ((st % w) - u.x) ** 2 + (((st / w) | 0) - u.y) ** 2 > (ARMOR_SUPPORT_RADIUS + 12) ** 2;
          if ((u.retryTick ?? 0) > t) bump(v.why, far ? 'support: no land route to its front (waiting)' : 'support: no route to a strike launch tile (waiting)');
          else bump(v.why, `support: ${reasonTarget() ?? (far ? 'front far, not moving' : 'near its front, no strike worth it')}`);
        }
      }
    }

    // Airfields
    const flying = new Map<number, number>();
    for (const u of state.units) if (u.owner === ME && u.hp > 0 && u.type === 'bomber') flying.set(u.home, (flying.get(u.home) ?? 0) + 1);
    for (const b of buildingsOf(state, ME, 'airfield')) {
      if (b.owner !== ME || b.buildLeft > 0) continue;
      this.appear(b.id, 'air', t);
      const wing = wingOf(state, b);
      const ls = this.lastSorties.get(b.id);
      const n = wing?.sorties ?? 0;
      if (!ls || n !== ls.n) {
        if (ls && n > ls.n) r.sorties += n - ls.n;
        this.lastSorties.set(b.id, { n, tick: ls && n !== ls.n ? t : (ls?.tick ?? -1e9) });
      }
      if (flying.get(b.tile)) this.lastBomber.set(b.id, t);
      const recent = (k: number | undefined): boolean => k !== undefined && t - k <= (AIR.sortieCooldown + SAMPLE_SECONDS) * TICKS_PER_SECOND;
      let use = '';
      if (flying.get(b.tile)) use = 'bombers out';
      else if (recent(this.lastSorties.get(b.id)?.tick) || recent(this.lastBomber.get(b.id))) use = 'between sorties';
      else if (wing?.mission === 'superiority' && b.fighters > 0 && wing.target >= 0) use = 'patrol at front';
      if (use) this.markUseful(state, b.id);
      if (!atWarNow) continue;
      const v = r.v.air;
      v.n++;
      if (use) {
        v.useful++;
        bump(v.use, use);
        continue;
      }
      if (b.bombers + b.fighters <= 0) {
        v.other++;
        bump(v.why, 'no aircraft');
        continue;
      }
      v.idle++;
      const mission = wing?.mission ?? 'idle';
      if (mission === 'idle') bump(v.why, 'mission idle (default)');
      else if (wing?.follow && reasonTarget()) bump(v.why, `${mission}: ${reasonTarget()}`);
      else if (mission !== 'superiority' && b.bombers <= 0) bump(v.why, `${mission}: fighters only`);
      else if (mission === 'superiority') bump(v.why, 'superiority over the airfield');
      else {
        const aim = wing?.follow ? front : (wing?.target ?? -1);
        const rr = airWingRange(b, state);
        const out = aim >= 0 && ((aim % w) - (b.tile % w)) ** 2 + (((aim / w) | 0) - ((b.tile / w) | 0)) ** 2 > rr * rr;
        bump(v.why, `${mission}: ${out ? 'main front out of the airfield reach' : 'aim in reach, no sortie'}`);
      }
    }

    // Silos
    const rockets = new Map<number, number>();
    for (const u of state.units) if (u.owner === ME && u.hp > 0 && u.type === 'rocket') rockets.set(u.home, (rockets.get(u.home) ?? 0) + 1);
    for (const b of buildingsOf(state, ME, 'silo')) {
      if (b.owner !== ME || b.buildLeft > 0) continue;
      this.appear(b.id, 'silo', t);
      const use = rockets.get(b.tile) || chargesReady(b) < b.level ? 'fired' : '';
      if (use) this.markUseful(state, b.id);
      if (!atWarNow) continue;
      const v = r.v.silo;
      v.n++;
      if (use) {
        v.useful++;
        bump(v.use, use);
        continue;
      }
      v.idle++;
      const c = unitCost(state, ME, 'rocket');
      if (!autoFireOn(state, b.tile)) bump(v.why, 'auto-fire off (default)');
      else if (reasonTarget()) bump(v.why, reasonTarget()!);
      else if (me.gold < c.gold * STRIKE.fireReserve || me.iron < c.iron * STRIKE.fireReserve || me.oil < c.oil * STRIKE.fireReserve) bump(v.why, 'keeps a reserve (gold / iron / oil)');
      else bump(v.why, 'no target near the front');
    }
  }

  /** End of the game: units never useful, aircraft lost. */
  finish(state: GameState, bought: Result['bought']): void {
    this.census(state);
    const end = state.tick;
    for (const s of this.seen.values()) if (!s.useful && end - s.tick >= 180 * TICKS_PER_SECOND) this.r.first[s.kind].push(-1);
    this.r.bought = { ...bought };
    let left = 0;
    for (const b of buildingsOf(state, ME, 'airfield')) if (b.owner === ME) left += b.bombers + b.fighters;
    for (const u of state.units) if (u.owner === ME && u.hp > 0 && (u.type === 'bomber' || u.type === 'fighter')) left++;
    this.r.lost.aircraft = Math.max(0, bought.bombers + bought.fighters - left);
  }

  /** Bombers of ours that reached their aim this tick: payload used / brought home / dropped off hostile land (batch.ts). */
  bombs(state: GameState, outB: Unit[], rockT: number[]): void {
    const arr = outB.filter((u) => u.hp > 0 && u.state === 1);
    if (!arr.length) return;
    const ex = state.effects.filter((e) => e.kind === 'explosion' && e.radius > 2 && !rockT.includes(Math.floor(e.y) * state.map.width + Math.floor(e.x)));
    const used = new Set<number>();
    for (const u of arr) {
      this.r.bombs.arrivals++;
      let best = -1;
      let bd = 30 * 30;
      for (let i = 0; i < ex.length; i++) {
        if (used.has(i)) continue;
        const dx = ex[i].x - (u.x + 0.5);
        const dy = ex[i].y - (u.y + 0.5);
        if (dx * dx + dy * dy < bd) {
          bd = dx * dx + dy * dy;
          best = i;
        }
      }
      if (best < 0) {
        this.r.bombs.home++;
        continue;
      }
      used.add(best);
      const o = state.map.owner[Math.floor(ex[best].y) * state.map.width + Math.floor(ex[best].x)];
      if (!hostile(state, u.owner, o)) this.r.bombs.off++;
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------
// One game
// ---------------------------------------------------------------------------------------------------------------

let TRACE = false;

async function runGame(job: Job, minutes: number): Promise<Result> {
  const world = job.map.startsWith('world:') ? job.map.slice(6) : null;
  const settings: GameSettings = {
    ...cloneSetup(DEFAULT_SETUP),
    seed: job.seed,
    map: world ? { kind: 'world', id: world } : { kind: 'generated', type: job.type, size: job.map as MapSize },
    aiCount: SINGLE_PLAYER_NATIONS,
    difficulty: job.difficulty,
    playerName: 'Bench',
    playerColor: [255, 255, 255],
    humanPlayer: true,
    timeLimit: 0,
    victoryLandShare: VICTORY_LAND_SHARE,
    tribeCount: -1,
    modifiers: { ...DEFAULT_MODIFIERS },
  };
  const state = createGame(settings, world ? await loadWorldMap(world) : null);
  const bot = new AutoBot(job.seed, job.clicks);
  const m = new Meter(job);
  const r = m.r;
  while (state.phase === 'spawn') {
    if (state.tick >= 30 && !state.players[ME].spawned) bot.spawn(state);
    tick(state);
    state.events.length = 0;
  }
  const land = state.map.landTileCount;
  const cap = minutes * 60 * TICKS_PER_SECOND + state.tick;
  const every = SAMPLE_SECONDS * TICKS_PER_SECOND;
  let next15 = true;
  let next25 = true;
  while (state.phase === 'playing' && state.tick < cap) {
    bot.update(state);
    const outB: Unit[] = [];
    const rockT: number[] = [];
    for (const u of state.units) {
      if (u.hp <= 0) continue;
      if (u.type === 'bomber' && u.owner === ME && u.state === 0) outB.push(u);
      else if (u.type === 'rocket') rockT.push(u.target);
    }
    tick(state);
    if (outB.length) m.bombs(state, outB, rockT);
    m.events(state);
    state.events.length = 0;
    if (state.tick % every === 0) m.sample(state);
    const s = gameSeconds(state);
    const me = state.players[ME];
    if (!me.alive && r.deathMinute < 0) r.deathMinute = s / 60;
    if (TRACE && state.tick % (60 * TICKS_PER_SECOND) === 0) traceLine(state, bot, m, s);
    if (next15 && s >= 900) {
      next15 = false;
      r.alive15 = me.alive;
      r.share15 = me.tiles / land;
    }
    if (next25 && s >= 1500) {
      next25 = false;
      r.alive25 = me.alive;
      r.share25 = me.tiles / land;
    }
  }
  const s = gameSeconds(state);
  r.minutes = s / 60;
  const won = state.phase === 'over' && state.winner === ME;
  if (next15) {
    r.alive15 = won || (state.phase !== 'over' && state.players[ME].alive);
    r.share15 = state.players[ME].tiles / land;
  }
  if (next25) {
    r.alive25 = won || (state.phase !== 'over' && state.players[ME].alive);
    r.share25 = state.players[ME].tiles / land;
  }
  m.finish(state, bot.bought);
  return r;
}

function traceLine(state: GameState, bot: AutoBot, m: Meter, s: number): void {
  const p = state.players[ME];
  const r = m.r;
  const units = (type: string): number => state.units.filter((u) => u.owner === ME && u.hp > 0 && u.type === type).length;
  const af = buildingsOf(state, ME, 'airfield').filter((b: Building) => b.owner === ME);
  const air = af.map((b) => `${b.bombers}b${b.fighters}f:${wingOf(state, b)?.mission ?? 'idle'}`).join(',');
  const tgt = followedNation(state, ME);
  console.log(
    `  ${(s / 60).toFixed(1)}m land ${pct(p.tiles / state.map.landTileCount)} troops ${Math.round(sum(p.troops))}/${Math.round(p.maxPop)} gold ${Math.round(p.gold)} iron ${Math.round(p.iron)} oil ${Math.round(p.oil)} techs ${p.techs.length} res ${p.researching ?? '-'} | ships ${units('warship')} divs ${units('tankDivision')} airfields ${air || '-'} silos ${buildingsOf(state, ME, 'silo').length} | target ${tgt} front ${tgt > 0 ? mainFront(state, ME, tgt) : -1} | war samples ${r.warSamples}`,
  );
  if (bot.notes.length) console.log(`    buy fails: ${bot.notes.slice(-4).join(' | ')}`);
  bot.notes.length = 0;
}

// ---------------------------------------------------------------------------------------------------------------
// Options, sharding, report
// ---------------------------------------------------------------------------------------------------------------

interface Options {
  maps: string[];
  types: MapType[];
  difficulties: Difficulty[];
  clicks: Clicks[];
  seeds: number;
  start: number;
  minutes: number;
  jobs: number;
  json: boolean;
  shard: number;
  of: number;
  from: string[];
}

function parseOptions(argv: string[]): Options {
  const args = argv.filter((a) => a !== '--');
  const o: Options = {
    maps: ['medium'],
    types: ['continents', 'archipelago', 'pangaea', 'highlands'],
    difficulties: ['normal'],
    clicks: ['none', 'once'],
    seeds: 8,
    start: 1,
    minutes: 25,
    jobs: 4,
    json: false,
    shard: -1,
    of: 1,
    from: [],
  };
  for (let k = 0; k < args.length; k++) {
    const a = args[k];
    const v = args[k + 1] ?? '';
    const list = (): string[] => v.split(',').filter(Boolean);
    switch (a) {
      case '--rule': applyRules(list()); k++; break;
      case '--maps': o.maps = list(); k++; break;
      case '--types': o.types = list() as MapType[]; k++; break;
      case '--difficulty': o.difficulties = list() as Difficulty[]; k++; break;
      case '--clicks': o.clicks = list().filter((c): c is Clicks => c === 'none' || c === 'once'); k++; break;
      case '--seeds': o.seeds = Number(v); k++; break;
      case '--start': o.start = Number(v); k++; break;
      case '--minutes': o.minutes = Number(v); k++; break;
      case '--jobs': o.jobs = Math.max(1, Number(v) || 1); k++; break;
      case '--json': o.json = true; break;
      case '--from': o.from = list(); k++; break;
      case '--trace': TRACE = true; break;
      case '--shard': {
        const [s, of] = v.split('/').map(Number);
        o.shard = s;
        o.of = of;
        k++;
        break;
      }
      default:
        console.error(`Unknown option ${a}`);
        process.exit(1);
    }
  }
  if (!o.clicks.length) o.clicks = ['none'];
  return o;
}

function jobList(o: Options): Job[] {
  const jobs: Job[] = [];
  for (const clicks of o.clicks) {
    for (const map of o.maps) {
      for (const difficulty of o.difficulties) {
        for (let k = 0; k < o.seeds; k++) jobs.push({ index: jobs.length, map, type: o.types[k % o.types.length], difficulty, clicks, seed: o.start + k });
      }
    }
  }
  return jobs;
}

const median = (v: number[]): number => {
  if (!v.length) return NaN;
  const s = v.slice().sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const pct = (x: number): string => (Number.isFinite(x) ? `${Math.round(x * 100)}%` : '-');
const f1 = (x: number): string => (Number.isFinite(x) ? x.toFixed(1) : '-');
/** Mean of per-game values and its 95% interval half-width. */
function meanCI(v: number[]): { m: number; ci: number; n: number } {
  const n = v.length;
  if (!n) return { m: NaN, ci: NaN, n };
  const m = v.reduce((a, b) => a + b, 0) / n;
  if (n < 2) return { m, ci: NaN, n };
  const sd = Math.sqrt(v.reduce((a, b) => a + (b - m) * (b - m), 0) / (n - 1));
  return { m, ci: (1.96 * sd) / Math.sqrt(n), n };
}
const pci = (v: number[]): string => {
  const { m, ci } = meanCI(v);
  return Number.isFinite(m) ? `${Math.round(m * 100)}%${Number.isFinite(ci) ? ` +-${Math.round(ci * 100)}` : ''}` : '-';
};

function table(rows: string[][]): void {
  const widths = rows[0].map((_, c) => Math.max(...rows.map((r) => (r[c] ?? '').length)));
  for (const r of rows) console.log(r.map((v, c) => (c < 1 ? v.padEnd(widths[c]) : v.padStart(widths[c]))).join('  '));
}

function report(rs: Result[], o: Options): void {
  for (const clicks of o.clicks) {
    const g = rs.filter((r) => r.job.clicks === clicks);
    if (!g.length) continue;
    const n = g.length;
    console.log(`\n=== --clicks ${clicks}: ${n} games (${o.maps.join(',')} x ${[...new Set(g.map((r) => r.job.type))].join(',')} x ${o.difficulties.join(',')}) ===`);
    const war = g.filter((r) => r.warSamples > 0);
    console.log(
      `Player 1: alive at 15 / 25 min ${pct(g.filter((r) => r.alive15).length / n)} / ${pct(g.filter((r) => r.alive25).length / n)}; land share at 15 / 25 min mean ${pci(g.map((r) => r.share15))} / ${pci(g.map((r) => r.share25))} (median ${pct(median(g.map((r) => r.share15)))} / ${pct(median(g.map((r) => r.share25)))}); at war ${pci(g.map((r) => (r.warSamples * SAMPLE_SECONDS) / 60 / Math.max(1, r.minutes)))} of the game.`,
    );
    console.log(
      `While at war: no war target ${pci(war.map((r) => r.noTarget / r.warSamples))}, war target but no land front (mainFront -1) ${pci(war.map((r) => r.noFront / r.warSamples))}, only defending ${pci(war.map((r) => r.defendOnly / r.warSamples))} (per-game shares, mean +- 95%).`,
    );
    const head = ['vehicle', 'games', 'built/g', 'unit-min/g', 'USEFUL', 'IDLE', 'moving', 'other', '1st use med s', 'never used', 'useful as'];
    const rows: string[][] = [head];
    for (const k of VKINDS) {
      const has = g.filter((r) => r.v[k].n > 0);
      const firsts = g.flatMap((r) => r.first[k]);
      const used = firsts.filter((x) => x >= 0);
      const useTot: Record<string, number> = {};
      for (const r of has) for (const [key, c] of Object.entries(r.v[k].use)) useTot[key] = (useTot[key] ?? 0) + c;
      const ut = Object.values(useTot).reduce((a, b) => a + b, 0);
      rows.push([
        VNAME[k],
        String(has.length),
        f1(g.reduce((a, r) => a + r.built[k], 0) / n),
        f1(has.reduce((a, r) => a + (r.v[k].n * SAMPLE_SECONDS) / 60, 0) / Math.max(1, has.length)),
        pci(has.map((r) => r.v[k].useful / r.v[k].n)),
        pci(has.map((r) => r.v[k].idle / r.v[k].n)),
        pci(has.map((r) => r.v[k].moving / r.v[k].n)),
        pci(has.map((r) => r.v[k].other / r.v[k].n)),
        f1(median(used)),
        firsts.length ? pct((firsts.length - used.length) / firsts.length) : '-',
        Object.entries(useTot).sort((a, b) => b[1] - a[1]).map(([key, c]) => `${key} ${pct(c / ut)}`).join(', '),
      ]);
    }
    table(rows);
    console.log('(shares of unit-time while player 1 is at war, per game then mean +- 95% over games that had the vehicle at war; 1st use = seconds from appearing to the first useful sample, any time; never used = of units that appeared 3+ min before the end)');
    for (const k of VKINDS) {
      const why: Record<string, number> = {};
      let idle = 0;
      for (const r of g) {
        for (const [key, c] of Object.entries(r.v[k].why)) why[key] = (why[key] ?? 0) + c;
        idle += r.v[k].idle + r.v[k].other;
      }
      if (!idle) continue;
      console.log(`  ${VNAME[k]} idle/other reasons (pooled unit-samples): ${Object.entries(why).sort((a, b) => b[1] - a[1]).map(([key, c]) => `${key} ${pct(c / idle)}`).join('; ')}`);
    }
    const sumOf = (f: (r: Result) => number): number => g.reduce((a, r) => a + f(r), 0);
    const arr = sumOf((r) => r.bombs.arrivals);
    console.log(
      `Payloads: bomber arrivals ${arr} (${f1(arr / n)}/game), brought home ${pct(sumOf((r) => r.bombs.home) / Math.max(1, arr))}, off hostile land ${pct(sumOf((r) => r.bombs.off) / Math.max(1, arr))}; wing sorties ${f1(sumOf((r) => r.sorties) / n)}/game; rockets fired ${f1(sumOf((r) => r.rockets) / n)}/game.`,
    );
    console.log(
      `Bought per game: warships ${f1(sumOf((r) => r.bought.ships) / n)}, divisions ${f1(sumOf((r) => r.bought.tanks) / n)}, bombers ${f1(sumOf((r) => r.bought.bombers) / n)}, fighters ${f1(sumOf((r) => r.bought.fighters) / n)}. Lost per game: warships ${f1(sumOf((r) => r.lost.ships) / n)}, divisions overrun ${f1(sumOf((r) => r.lost.overrun) / n)} / spent ${f1(sumOf((r) => r.lost.spent) / n)} / gone otherwise ${f1(sumOf((r) => r.lost.divOther) / n)}, aircraft ${f1(sumOf((r) => r.lost.aircraft) / n)}.`,
    );
    const lw: Record<string, number> = {};
    for (const r of g) for (const [key, c] of Object.entries(r.lossWhy ?? {})) lw[key] = (lw[key] ?? 0) + c;
    const lws = Object.entries(lw).sort((a, b) => b[1] - a[1]).slice(0, 6);
    if (lws.length) console.log(`Losses by kind (per game): ${lws.map(([key, c]) => `${key} ${f1(c / n)}`).join('; ')}.`);
    // Per map type: the main shares.
    const types = [...new Set(g.map((r) => r.job.type))];
    if (types.length > 1) {
      const rows2: string[][] = [['type', 'games', 'land25', 'noTarget', 'noFront', ...VKINDS.flatMap((k) => [`${k} use`, `${k} idle`])]];
      for (const ty of types) {
        const h = g.filter((r) => r.job.type === ty);
        const hw = h.filter((r) => r.warSamples > 0);
        rows2.push([
          ty,
          String(h.length),
          pct(median(h.map((r) => r.share25))),
          pci(hw.map((r) => r.noTarget / r.warSamples)),
          pci(hw.map((r) => r.noFront / r.warSamples)),
          ...VKINDS.flatMap((k) => {
            const has = h.filter((r) => r.v[k].n > 0);
            return [pci(has.map((r) => r.v[k].useful / r.v[k].n)), pci(has.map((r) => r.v[k].idle / r.v[k].n))];
          }),
        ]);
      }
      table(rows2);
    }
  }
}

async function runShards(o: Options, argv: string[]): Promise<Result[]> {
  const cp = (await import('node:child_process')) as unknown as {
    spawn(cmd: string, args: string[], opts: object): {
      stdout: { on(ev: 'data', f: (b: unknown) => void): void };
      stderr: { on(ev: 'data', f: (b: unknown) => void): void };
      on(ev: 'close', f: (code: number) => void): void;
    };
  };
  const rest = argv.filter((a) => a !== '--');
  const out: Result[] = [];
  await Promise.all(
    Array.from({ length: o.jobs }, (_, s) =>
      new Promise<void>((resolve, reject) => {
        const child = cp.spawn('node_modules/.bin/vite-node', ['scripts/autobench.ts', '--', ...rest, '--shard', `${s}/${o.jobs}`], { stdio: ['ignore', 'pipe', 'pipe'] });
        let buf = '';
        child.stdout.on('data', (b) => {
          buf += String(b);
          let nl: number;
          while ((nl = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, nl);
            buf = buf.slice(nl + 1);
            if (!line.startsWith('{')) continue;
            out.push(JSON.parse(line) as Result);
            if (o.json) console.log('JSON ' + line);
          }
        });
        child.stderr.on('data', (b) => process.stdout.write(String(b)));
        child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`shard ${s} exited with ${code}`))));
      }),
    ),
  );
  return out;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const o = parseOptions(argv);
  const jobs = jobList(o);
  if (o.from.length) {
    const { readFileSync } = await import('node:fs');
    const rs: Result[] = [];
    for (const f of o.from) for (const line of readFileSync(f, 'utf8').split('\n')) if (line.startsWith('{')) rs.push(JSON.parse(line) as Result);
    rs.sort((a, b) => a.job.index - b.job.index);
    console.log(`Frontline Atlas auto bench report from ${o.from.length} file(s): ${rs.length} of ${jobs.length} games, cap ${o.minutes} min.`);
    report(rs, o);
    return;
  }
  if (o.shard >= 0) {
    for (const j of jobs) if (j.index % o.of === o.shard) process.stdout.write(JSON.stringify(await runGame(j, o.minutes)) + '\n');
    return;
  }
  console.log(`Frontline Atlas auto bench: ${jobs.length} games (${o.clicks.join(',')} x ${o.maps.join(',')} x ${o.difficulties.join(',')} x ${o.seeds} seeds from ${o.start}, types ${o.types.join(',')}), cap ${o.minutes} min, ${o.jobs} job(s).`);
  const t0 = performance.now();
  let rs: Result[];
  if (o.jobs <= 1) {
    rs = [];
    for (const j of jobs) {
      const r = await runGame(j, o.minutes);
      rs.push(r);
      if (o.json) console.log('JSON ' + JSON.stringify(r));
    }
  } else rs = await runShards(o, argv);
  report(rs, o);
  console.log(`Done in ${Math.round((performance.now() - t0) / 1000)} s.`);
}

void main();
