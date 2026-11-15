// Attack probe for scripts/batch.ts: how AI nations use warships, tank divisions and bombers (read-only; never
// changes a value of the game). One probe per game: beforeTick / afterTick around every tick, sample every 10 s,
// finish at the end. Counts only units of AI nations (no humans, no tribes).
//
// What "on the front" means here: attacks advance along the whole shared border with their target (combat.ts), so a
// tile of a nation we attack that touches our land is where that attack is fought. A warship within
// NAVY_SUPPORT_RANGE of such a tile supports it (naval2.navalSupportAt), a support strike centred within
// AIR.supportRadius of one bombs it.
import { AIR, ARMOR_SUPPORT_READY, ARSENAL, TANK_FALLBACK_PAUSE, TICKS_PER_SECOND, NAVY_BLOCKADE_RANGE, NAVY_REACH, NAVY_SUPPORT_RANGE, NAVY_XP_SINK, TANK_DIVISION_TROOPS, WARSHIP_RANGE } from '../src/sim/config';
import { buildingAt, buildingsOf, isDisabled, samRadius } from '../src/sim/buildings';
import { areAllied } from '../src/sim/diplomacy';
import { atPeace } from '../src/sim/rules';
import { atWar, supportingShips, warshipMaxHp } from '../src/sim/naval2';
import { airPatrolRadius, airState } from '../src/sim/airwings';
import { unitVisibleTo } from '../src/sim/techtree';
import { minefieldAt, minefields } from '../src/sim/specials';
import { navalBlockadeMul, navalCanTarget, navalSupportMul } from '../src/sim/variants';
import { coastCount } from '../src/sim/territory';
import { frontTiles } from '../src/sim/combat';
import { isTribe } from '../src/sim/types';
import type { GameEvent, GameState, Unit } from '../src/sim/types';

/** "On the front": the nation was attacked by the unit's owner within this many ticks (30 s). */
const RECENT_TICKS = 300;
const FULL_DIVISION = TANK_DIVISION_TROOPS.armor + TANK_DIVISION_TROOPS.infantry + TANK_DIVISION_TROOPS.artillery;
const MISSIONS = ['manual', 'support', 'strategic', 'cover'] as const;
type MissionKey = (typeof MISSIONS)[number];

export interface BomberStats {
  sorties: number;
  arrivals: number;
  /** arrivals whose aim was within AIR.supportRadius of a front tile of an own attack (support / cover / manual) */
  onFront: number;
  /** launched at an aim inside a working hostile SAM's radius; of them arrived */
  intoSam: number;
  intoSamArrived: number;
}

/** Kinds of ship a warship sank. */
export const KILL_KINDS = ['trade', 'transport', 'warship', 'softWarship', 'sub'] as const;
type KillKind = (typeof KILL_KINDS)[number];
/** Warship types: the variants and the standard ship. */
export const SHIP_KINDS = ['standard', 'destroyer', 'battleship', 'submarine', 'carrier'] as const;
type ShipKind = (typeof SHIP_KINDS)[number];

/** Per warship type (counted owners' ships). */
export interface ShipKindStats {
  built: number;
  /** sunk by an enemy destroyer / by another enemy warship / by anything else (mines, unmatched) */
  sunkByDestroyer: number;
  sunkByShip: number;
  sunkOther: number;
  /** sunk by an enemy warship, by the killer's type */
  sunkByKind?: Record<string, number>;
  /** ships this type sank, by kind (softWarship = a warship below half its hp at the last 10 s sample or with no own
   *  warship within NAVY_REACH.oddsRadius of it when it sank; warship = the others; sub = submarines) */
  kills: Record<KillKind, number>;
  /** invasion transports sunk while their owner was at war with ours (landings in progress) */
  killsLanding: number;
  /** 10 s samples: alive; owner at war; of those: within its support reach of an own attack front, on station,
   *  chasing, escorting, mending at a port; seen by a nation at war with its owner (subs), a hostile warship in gun
   *  range could fire at it, a hostile destroyer within sonar range, inside a hostile minefield, an enemy port at war
   *  within its blockade range; destroyers: a hostile submarine within sonar range, own trade ship or transport within
   *  sonar range; carriers: an own attack front within carrierAirRange */
  alive: number;
  war: number;
  onFront: number;
  station: number;
  chasing: number;
  escorting: number;
  mending: number;
  revealed: number;
  targetable: number;
  nearDestroyer: number;
  inMinefield: number;
  blockading: number;
  sonarContact: number;
  nearShipping: number;
  airReach: number;
}

export interface AttackStats {
  /** per warship type */
  navy: Record<ShipKind, ShipKindStats>;
  /** invasion landings (transport reached its tile) and of them with an own warship in support range of the tile */
  landings: number;
  landingsSupported: number;
  /** bomber sorties of counted owners that took off from a carrier */
  carrierSorties: number;
  /** hostile bomber sorties aimed at a counted nation's land; of them, aimed inside one of its superiority patrol
   *  circles; while it had a superiority patrol at all; patrol engagements (a patrol fired at a plane) */
  incomingBombers: number;
  incomingCovered: number;
  incomingWithPatrol: number;
  patrolEngagements: number;
  ships: {
    built: number;
    sunk: number;
    /** gone with their owner (eliminated); not counted as sunk */
    ownerGone: number;
    /** sunk by an enemy warship / by a mine (events) */
    sunkByShip: number;
    sunkByMine: number;
    /** sunk with no veterancy at all (never shelled nor sank anything) */
    sunkNoXp: number;
    /** sunk after a sample that saw it below half its hp (had the time to mend) */
    sunkCrippled: number;
    /** 10 s samples: alive; owner at war (an attack either way with a nation); of those, within support range of a
     *  front tile of an own attack; on station (state 3); on station and on the front; locally outnumbered (more
     *  hostile warships than own within NAVY_REACH.oddsRadius); mending in port; escorting */
    alive: number;
    atWar: number;
    onFront: number;
    /** samples while the owner attacks a nation (where support can help at all); of them on the front, on station */
    attacking: number;
    attackingOnFront: number;
    attackingStation: number;
    station: number;
    stationOnFront: number;
    outnumbered: number;
    escorting: number;
    /** ship-samples of nations attacking a coastal nation (the main attack) whose fleet supported that attack */
    mainCoastal: number;
    mainSupported: number;
  };
  transports: {
    invasions: number;
    sunk: number;
    troopsSunk: number;
    repelled: number;
    /** 10 s samples of invasion transports at sea; with an own warship escorting them */
    atSea: number;
    escorted: number;
  };
  tanks: {
    formed: number;
    /** overrun with < 10%, 10-40%, >= 40% of a full division at the last sample */
    overrun: [number, number, number];
    spent: number;
    /** gone with their owner; overrun within 60 s after a spearhead of theirs ended */
    ownerGone: number;
    overrunAfterSpearhead: number;
    /** holding samples at war (holdFront + holdFar): in support mode; within 24 tiles of their support front */
    holdSupport: number;
    holdAtStation: number;
    /** 10 s samples of divisions of nations at war: spearheading, holding within 12 tiles of an own attack front,
     *  holding elsewhere, driving; worn (< 40%) among them */
    atWar: number;
    spearhead: number;
    holdFront: number;
    holdFar: number;
    driving: number;
    worn: number;
    /** divisions overrun while their owner's land around them was under an enemy attack */
    overrunDefending: number;
  };
  /** Tank divisions, second cut (at war = naval2.atWar with a nation: an attack either way now or in the last 30 s). */
  armor: {
    /** 10 s samples of divisions at war: spearheading, driving to a launch tile, driving (not to refit), driving to
     *  refit, holding within FRONT_TILES of a foe's land touching ours, holding elsewhere worn (< ready) / ready */
    war: number;
    attack: number;
    launch: number;
    toFront: number;
    retreat: number;
    holdFront: number;
    holdRefit: number;
    holdAway: number;
    /** spearheads started; with another own division spearheading, launching or started in the last 20 s within
     *  COMPANY_TILES of it */
    spearheads: number;
    withCompany: number;
    /** spearheads ended: tiles taken by them; ended with fewer than 5 tiles */
    ended: number;
    spearTiles: number;
    shallow: number;
    /** encirclements (events) by the counted owners: events, pockets, tiles */
    pocketEvents: number;
    pockets: number;
    pocketTiles: number;
    /** fell back under attack (events) */
    fellBack: number;
    /** spearheads by anyone into a counted owner's land: ended, tiles taken */
    enemySpears: number;
    enemySpearTiles: number;
    /** why own spearheads ended */
    ends: Record<string, number>;
    /** holding away samples by why: hold mode, refit mode, support waiting on a failed route, no land border with a
     *  nation at war, support with its front tile over 36 tiles away, support near its front tile (that tile is
     *  no longer at a live front) */
    away: Record<string, number>;
    /** overrun divisions by where they were the tick before */
    overrunWhere: Record<string, number>;
  };
  bombers: Record<MissionKey, BomberStats>;
  /** strategic / manual strike aims by building type at the aim tile */
  strikeTypes: Record<string, number>;
  /** main-attack samples (an AI nation's biggest attack on a nation) with an air support zone on that front, and
   *  where the nation had bombers at an airfield */
  mainAirOwn: number;
  mainAirZone: number;
}

function newShipKind(): ShipKindStats {
  return {
    built: 0, sunkByDestroyer: 0, sunkByShip: 0, sunkOther: 0, kills: { trade: 0, transport: 0, warship: 0, softWarship: 0, sub: 0 }, killsLanding: 0,
    alive: 0, war: 0, onFront: 0, station: 0, chasing: 0, escorting: 0, mending: 0, revealed: 0, targetable: 0, nearDestroyer: 0, inMinefield: 0,
    blockading: 0, sonarContact: 0, nearShipping: 0, airReach: 0,
  };
}

export function newAttackStats(): AttackStats {
  const b = (): BomberStats => ({ sorties: 0, arrivals: 0, onFront: 0, intoSam: 0, intoSamArrived: 0 });
  return {
    navy: { standard: newShipKind(), destroyer: newShipKind(), battleship: newShipKind(), submarine: newShipKind(), carrier: newShipKind() },
    landings: 0,
    landingsSupported: 0,
    carrierSorties: 0,
    incomingBombers: 0,
    incomingCovered: 0,
    incomingWithPatrol: 0,
    patrolEngagements: 0,
    ships: { built: 0, sunk: 0, ownerGone: 0, sunkByShip: 0, sunkByMine: 0, sunkNoXp: 0, sunkCrippled: 0, alive: 0, atWar: 0, onFront: 0, attacking: 0, attackingOnFront: 0, attackingStation: 0, station: 0, stationOnFront: 0, outnumbered: 0, escorting: 0, mainCoastal: 0, mainSupported: 0 },
    transports: { invasions: 0, sunk: 0, troopsSunk: 0, repelled: 0, atSea: 0, escorted: 0 },
    tanks: { formed: 0, overrun: [0, 0, 0], spent: 0, ownerGone: 0, overrunAfterSpearhead: 0, holdSupport: 0, holdAtStation: 0, atWar: 0, spearhead: 0, holdFront: 0, holdFar: 0, driving: 0, worn: 0, overrunDefending: 0 },
    armor: { war: 0, attack: 0, launch: 0, toFront: 0, retreat: 0, holdFront: 0, holdRefit: 0, holdAway: 0, spearheads: 0, withCompany: 0, ended: 0, spearTiles: 0, shallow: 0, pocketEvents: 0, pockets: 0, pocketTiles: 0, fellBack: 0, enemySpears: 0, enemySpearTiles: 0, ends: {}, away: {}, overrunWhere: {} },
    bombers: { manual: b(), support: b(), strategic: b(), cover: b() },
    strikeTypes: {},
    mainAirOwn: 0,
    mainAirZone: 0,
  };
}

/** Adds b into a (for reports over many games). */
export function addAttackStats(a: AttackStats, b: AttackStats): void {
  const add = (x: Record<string, unknown>, y: Record<string, unknown>): void => {
    for (const k of Object.keys(y)) {
      const v = y[k];
      if (typeof v === 'number') x[k] = ((x[k] as number) ?? 0) + v;
      else if (Array.isArray(v)) {
        const xa = (x[k] ??= v.map(() => 0)) as number[];
        v.forEach((n, i) => (xa[i] = (xa[i] ?? 0) + (n as number)));
      } else if (v && typeof v === 'object') add((x[k] ??= {}) as Record<string, unknown>, v as Record<string, unknown>);
    }
  };
  add(a as unknown as Record<string, unknown>, b as unknown as Record<string, unknown>);
}

function isAINation(state: GameState, id: number): boolean {
  const p = state.players[id];
  return !!p && id > 0 && !p.isHuman && !isTribe(p);
}

function hostile(state: GameState, a: number, b: number): boolean {
  return a !== b && a > 0 && b > 0 && !areAllied(state, a, b) && !atPeace(state, a, b);
}

interface DivSeen {
  owner: number;
  share: number;
  /** last tick seen spearheading */
  spear: number;
  /** state at the last tick */
  st: number;
  /** own land under 3 tiles deep in one of the 4 directions at the last tick */
  thin: boolean;
  /** last tick it fell back under attack (its retry pause set to TANK_FALLBACK_PAUSE) */
  fell: number;
  /** on thin ground and its own land around it is a piece of under 60 tiles (cut off) */
  cut: boolean;
}
/** Division samples: "at the front" = within this many tiles of a foe's land touching ours. */
const FRONT_TILES = 12;
/** A spearhead has company when another own division is spearheading / launching / started within this many tiles. */
const COMPANY_TILES = 30;
interface ShipSeen {
  owner: number;
  xp: number;
  crippled: boolean;
}
/** Every ship afloat (any owner) at the end of the last tick: for kill matching (a warship's xp jumps by
 *  NAVY_XP_SINK on a kill, units.updateWarship / naval2.onShipKilled). */
interface ShipPrev {
  owner: number;
  type: Unit['type'];
  kind: ShipKind;
  x: number;
  y: number;
  xp: number;
  hpShare: number;
  target: number;
  targetOwner: number;
  /** at (or one step from) the end of its route: a vanished transport / trade ship there landed or delivered */
  atEnd: boolean;
}
const shipKind = (u: Unit): ShipKind => (u.variant === 'destroyer' || u.variant === 'battleship' || u.variant === 'submarine' || u.variant === 'carrier' ? u.variant : 'standard');
interface BomberSeen {
  owner: number;
  mission: MissionKey;
  aim: number;
  intoSam: boolean;
  arrived: boolean;
}

export class AttackProbe {
  readonly stats = newAttackStats();
  private readonly ships = new Map<number, ShipSeen>();
  private readonly divs = new Map<number, DivSeen>();
  /** spearhead starts of the last 20 s: owner, tick, x, y */
  private starts: { owner: number; tick: number; x: number; y: number }[] = [];
  private readonly bombers = new Map<number, BomberSeen>();
  /** attack targets per attacker (nations only), rebuilt per use */
  private targets = new Map<number, Set<number>>();
  private targetsTick = -1;
  /** owners whose units are counted (default: AI nations) */
  private readonly counted: (id: number) => boolean;
  private prevShips = new Map<number, ShipPrev>();
  private readonly coverTicks = new Map<number, number>();
  constructor(
    private readonly state: GameState,
    counted?: (state: GameState, id: number) => boolean,
  ) {
    this.counted = counted ? (id) => counted(state, id) : (id) => isAINation(state, id);
  }

  /** last tick attacker*4096+target had an attack running (nations only) */
  private readonly lastAttack = new Map<number, number>();
  private noteAttacks(): void {
    const state = this.state;
    for (const a of state.attacks) {
      if (a.target <= 0 || a.attacker <= 0 || isTribe(state.players[a.target])) continue;
      this.lastAttack.set(a.attacker * 4096 + a.target, state.tick);
    }
  }
  /** Nations each attacker attacked within the last RECENT_TICKS (AI attacks come in waves of about a second, some
   *  20 s apart: a ship or bomb zone on that border serves the next wave). */
  private attackTargets(): Map<number, Set<number>> {
    const state = this.state;
    if (this.targetsTick === state.tick) return this.targets;
    this.targetsTick = state.tick;
    const m = new Map<number, Set<number>>();
    for (const [k, t] of this.lastAttack) {
      if (state.tick - t > RECENT_TICKS) continue;
      const attacker = Math.floor(k / 4096);
      const target = k % 4096;
      if (!state.players[target]?.alive) continue;
      let s = m.get(attacker);
      if (!s) m.set(attacker, (s = new Set()));
      s.add(target);
    }
    this.targets = m;
    return m;
  }

  /** A tile of one of `targets` touching `me`'s land within r of (x, y): its owner, else 0. */
  private frontNear(me: number, targets: Set<number> | undefined, x: number, y: number, r: number): number {
    if (!targets || !targets.size) return 0;
    const map = this.state.map;
    const { width: w, height: h, owner } = map;
    const cx = Math.round(x);
    const cy = Math.round(y);
    const r2 = r * r;
    for (let yy = Math.max(1, cy - r); yy <= Math.min(h - 2, cy + r); yy++) {
      for (let xx = Math.max(1, cx - r); xx <= Math.min(w - 2, cx + r); xx++) {
        const dx = xx - cx;
        const dy = yy - cy;
        if (dx * dx + dy * dy > r2) continue;
        const t = yy * w + xx;
        const o = owner[t];
        if (!targets.has(o)) continue;
        if (owner[t - 1] === me || owner[t + 1] === me || owner[t - w] === me || owner[t + w] === me) return o;
      }
    }
    return 0;
  }

  private inHostileSam(me: number, tile: number): boolean {
    const state = this.state;
    const w = state.map.width;
    const x = tile % w;
    const y = (tile / w) | 0;
    for (const b of state.buildings.values()) {
      if (b.type !== 'sam' || b.buildLeft > 0 || !hostile(state, me, b.owner) || isDisabled(state, b)) continue;
      const r = samRadius(b);
      const dx = (b.tile % w) - x;
      const dy = ((b.tile / w) | 0) - y;
      if (dx * dx + dy * dy <= r * r) return true;
    }
    return false;
  }

  /** Before tick(): nothing to record (the unit maps hold the last state). */
  beforeTick(): void {}

  /** After tick(): new units, units gone (sunk, overrun), arrivals, events. Call before the caller clears events. */
  afterTick(events: readonly GameEvent[]): void {
    const state = this.state;
    const s = this.stats;
    this.noteAttacks();
    const alive = new Set<number>();
    for (const u of state.units) {
      if (u.hp <= 0 || !this.counted(u.owner)) continue;
      alive.add(u.id);
      if (u.type === 'warship') {
        let seen = this.ships.get(u.id);
        if (!seen) {
          this.ships.set(u.id, (seen = { owner: u.owner, xp: 0, crippled: false }));
          s.ships.built++;
          s.navy[shipKind(u)].built++;
        }
        seen.xp = u.xp ?? 0;
      } else if (u.type === 'tankDivision') {
        let seen = this.divs.get(u.id);
        if (!seen) {
          this.divs.set(u.id, (seen = { owner: u.owner, share: 1, spear: -1e9, st: u.state, thin: false, fell: -1e9, cut: false }));
          s.tanks.formed++;
        }
        seen.share = (u.troops.infantry + u.troops.armor + u.troops.artillery) / FULL_DIVISION;
        if (u.state === 3) seen.spear = state.tick;
        if (u.state === 3 && seen.st !== 3) this.spearStart(u);
        seen.st = u.state;
        seen.thin = this.thinAt(u);
        seen.cut = seen.thin && this.cutOff(u);
        if (u.retryTick === state.tick + TANK_FALLBACK_PAUSE * TICKS_PER_SECOND) seen.fell = state.tick;
      } else if (u.type === 'bomber') {
        let seen = this.bombers.get(u.id);
        if (!seen) {
          const mission: MissionKey = MISSIONS[u.mission ?? 0] ?? 'manual';
          seen = { owner: u.owner, mission, aim: u.target, intoSam: this.inHostileSam(u.owner, u.target), arrived: false };
          // Carriers: a bomber that takes off away from its airfield left from a carrier (airwings.launchFrom).
          const w = state.map.width;
          if (Math.round(u.x) !== u.home % w || Math.round(u.y) !== ((u.home / w) | 0)) s.carrierSorties++;
          this.bombers.set(u.id, seen);
          const bs = s.bombers[mission];
          bs.sorties++;
          if (seen.intoSam) bs.intoSam++;
          if (mission === 'strategic' || mission === 'manual') {
            const b = buildingAt(state, u.target);
            const k = b ? b.type : 'ground';
            s.strikeTypes[k] = (s.strikeTypes[k] ?? 0) + 1;
          }
        }
        if (u.state === 0) seen.aim = u.target; // outbound (re-aimed on the way); returning: target = home
        if (!seen.arrived && u.state === 1) {
          seen.arrived = true;
          const bs = s.bombers[seen.mission];
          bs.arrivals++;
          if (seen.intoSam) bs.intoSamArrived++;
          if (seen.mission !== 'strategic') {
            const w = state.map.width;
            const t = seen.aim;
            if (this.frontNear(u.owner, this.attackTargets().get(u.owner), t % w, (t / w) | 0, AIR.supportRadius)) bs.onFront++;
          }
        }
      } else if (u.type === 'transport' && u.targetOwner > 0 && !this.ships.has(-u.id)) {
        this.ships.set(-u.id, { owner: u.owner, xp: 0, crippled: false });
        s.transports.invasions++;
      }
    }
    // Overrun / spent events of this tick, per owner.
    const overrun = new Map<number, number>();
    for (const e of events) {
      const o = e.players[0];
      if (!this.counted(o)) continue;
      if (e.kind === 'unitLost' && /tank division was overrun/.test(e.message)) overrun.set(o, (overrun.get(o) ?? 0) + 1);
      else if (e.kind === 'unitLost' && /lost a transport with (\d+) troops/.test(e.message)) {
        s.transports.sunk++;
        s.transports.troopsSunk += Number(/with (\d+) troops/.exec(e.message)![1]);
      } else if (e.kind === 'unitLost' && /landing was repelled/.test(e.message)) s.transports.repelled++;
      else if (e.kind === 'unitLost' && /lost a warship to/.test(e.message)) s.ships.sunkByShip++;
      else if (e.kind === 'unitLost' && /warship hit a mine/.test(e.message)) s.ships.sunkByMine++;
      else if ((e.kind as string) === 'spearheadEnded' && /the division is spent/.test(e.message)) s.tanks.spent++;
    }
    this.armorEvents(events);
    for (const [id, seen] of this.ships) {
      if (id < 0 || alive.has(id)) continue;
      this.ships.delete(id);
      if (!state.players[seen.owner].alive) {
        s.ships.ownerGone++;
        continue;
      }
      s.ships.sunk++;
      if (seen.xp <= 0) s.ships.sunkNoXp++;
      if (seen.crippled) s.ships.sunkCrippled++;
    }
    for (const id of [...this.ships.keys()]) if (id < 0 && !alive.has(-id)) this.ships.delete(id);
    for (const [id, seen] of this.divs) {
      if (alive.has(id)) continue;
      this.divs.delete(id);
      if (!state.players[seen.owner].alive) {
        s.tanks.ownerGone++;
        continue;
      }
      const n = overrun.get(seen.owner) ?? 0;
      if (n <= 0) continue;
      overrun.set(seen.owner, n - 1);
      s.tanks.overrun[seen.share < 0.1 ? 0 : seen.share < 0.4 ? 1 : 2]++;
      const where = `${state.tick - seen.spear <= 600 ? 'after a spearhead, ' : ''}${seen.st === 1 || seen.st === 2 ? 'driving' : seen.cut ? 'cut off' : seen.thin ? 'on thin ground' : 'on solid ground'}${state.tick - seen.fell <= 300 ? ', fell back lately' : ''}`;
      s.armor.overrunWhere[where] = (s.armor.overrunWhere[where] ?? 0) + 1;
      if (state.tick - seen.spear <= 600) s.tanks.overrunAfterSpearhead++;
      if (state.attacks.some((a) => a.target === seen.owner && a.attacker > 0 && !isTribe(state.players[a.attacker]))) s.tanks.overrunDefending++;
    }
    for (const id of this.bombers.keys()) if (!alive.has(id)) this.bombers.delete(id);
    this.naval();
    this.incoming();
  }

  /** A counted division started a spearhead this tick: company within COMPANY_TILES (spearheading, launching, or
   *  started in the last 20 s). */
  private spearStart(u: Unit): void {
    const state = this.state;
    const a = this.stats.armor;
    a.spearheads++;
    const r2 = COMPANY_TILES * COMPANY_TILES;
    this.starts = this.starts.filter((q) => state.tick - q.tick <= 200);
    let company = this.starts.some((q) => q.owner === u.owner && (q.x - u.x) ** 2 + (q.y - u.y) ** 2 <= r2);
    if (!company) {
      for (const o of state.units) {
        if (o === u || o.hp <= 0 || o.type !== 'tankDivision' || o.owner !== u.owner || (o.state !== 3 && o.state !== 2)) continue;
        if ((o.x - u.x) ** 2 + (o.y - u.y) ** 2 <= r2) {
          company = true;
          break;
        }
      }
    }
    if (company) a.withCompany++;
    this.starts.push({ owner: u.owner, tick: state.tick, x: u.x, y: u.y });
  }

  /** Spearhead ends (tiles, why), encirclements and fall-backs from this tick's events. */
  private armorEvents(events: readonly GameEvent[]): void {
    const a = this.stats.armor;
    for (const e of events) {
      const o = e.players[0];
      if ((e.kind as string) === 'spearheadEnded') {
        const m = /'s spearhead (.*?): (\d+) tiles taken/.exec(e.message);
        if (!m) continue;
        const tiles = Number(m[2]);
        if (this.counted(o)) {
          a.ended++;
          a.spearTiles += tiles;
          if (tiles < 5) a.shallow++;
          const why = m[1].replace(/^stalled in .*/, 'stalled').replace(/^stopped by .*/, 'stopped by a fort');
          a.ends[why] = (a.ends[why] ?? 0) + 1;
        }
        const v = e.players[1];
        if (v !== undefined && v !== o && this.counted(v)) {
          a.enemySpears++;
          a.enemySpearTiles += tiles;
        }
      } else if (e.kind === 'info' && this.counted(o)) {
        const m = /tanks encircled (a pocket|(\d+) pockets) of .*: (\d+) tiles collapse/.exec(e.message);
        if (m) {
          a.pocketEvents++;
          a.pockets += m[2] ? Number(m[2]) : 1;
          a.pocketTiles += Number(m[3]);
        } else if (/tank division fell back under attack/.test(e.message)) a.fellBack++;
      }
    }
  }

  /** Kills by ship type (xp jumps matched to ships gone this tick), landings with naval support. */
  private naval(): void {
    const state = this.state;
    const s = this.stats;
    const now = new Map<number, ShipPrev>();
    for (const u of state.units) {
      if (u.hp <= 0 || (u.type !== 'warship' && u.type !== 'transport' && u.type !== 'tradeShip')) continue;
      now.set(u.id, {
        owner: u.owner,
        type: u.type,
        kind: shipKind(u),
        x: u.x,
        y: u.y,
        xp: u.xp ?? 0,
        hpShare: u.type === 'warship' ? u.hp / warshipMaxHp(u) : 1,
        target: u.target,
        targetOwner: u.targetOwner,
        atEnd: u.path.length > 0 && u.pathPos >= u.path.length - 2,
      });
    }
    const prev = this.prevShips;
    const gone: [number, ShipPrev][] = [];
    for (const [id, p] of prev) if (!now.has(id)) gone.push([id, p]);
    if (gone.length) {
      const killers: ShipPrev[] = [];
      for (const [id, n] of now) {
        const p = prev.get(id);
        if (p && n.type === 'warship' && n.xp - p.xp >= NAVY_XP_SINK - 1e-6) killers.push(p);
      }
      const used = new Set<ShipPrev>();
      const r2 = (WARSHIP_RANGE + 2) * (WARSHIP_RANGE + 2);
      for (const [id, v] of gone) {
        let best: ShipPrev | null = null;
        let bestD = r2;
        for (const k of killers) {
          if (used.has(k) || !hostile(state, k.owner, v.owner)) continue;
          const d = (k.x - v.x) * (k.x - v.x) + (k.y - v.y) * (k.y - v.y);
          if (d <= bestD) {
            bestD = d;
            best = k;
          }
        }
        if (best) used.add(best);
        if (best && this.counted(best.owner)) {
          const ks = s.navy[best.kind];
          let kind: KillKind = v.type === 'tradeShip' ? 'trade' : v.type === 'transport' ? 'transport' : v.kind === 'submarine' ? 'sub' : 'warship';
          if (kind === 'warship') {
            let lone = true;
            const or2 = NAVY_REACH.oddsRadius * NAVY_REACH.oddsRadius;
            for (const o of now.values()) if (o.type === 'warship' && o.owner === v.owner && (o.x - v.x) * (o.x - v.x) + (o.y - v.y) * (o.y - v.y) <= or2) lone = false;
            if (lone || (this.sampleHp.get(id) ?? 1) < 0.5) kind = 'softWarship';
          }
          ks.kills[kind]++;
          if (v.type === 'transport' && v.targetOwner > 0 && atWar(state, best.owner, v.owner)) ks.killsLanding++;
        }
        if (!this.counted(v.owner) || !state.players[v.owner]?.alive) continue;
        if (v.type === 'warship') {
          const ks = s.navy[v.kind];
          if (best) {
            if (best.kind === 'destroyer') ks.sunkByDestroyer++;
            else ks.sunkByShip++;
            const by = (ks.sunkByKind ??= {});
            by[best.kind] = (by[best.kind] ?? 0) + 1;
          } else ks.sunkOther++;
        } else if (v.type === 'transport' && !best && v.atEnd && v.targetOwner > 0) {
          s.landings++;
          if (supportingShips(state, v.owner, v.target) > 0) s.landingsSupported++;
        }
      }
    }
    this.prevShips = now;
  }

  /** Hostile bombers launched at counted nations' land: inside a superiority patrol of the victim? Patrol engagements. */
  private incoming(): void {
    const state = this.state;
    const s = this.stats;
    const air = state.air;
    for (const wg of air?.wings ?? []) {
      if (wg.mission !== 'superiority' || !this.counted(wg.owner)) continue;
      const last = this.coverTicks.get(wg.airfield);
      if (last !== undefined && wg.coverTick !== last && wg.coverTick > state.tick) s.patrolEngagements++;
      this.coverTicks.set(wg.airfield, wg.coverTick);
    }
    const w = state.map.width;
    for (const u of state.units) {
      if (u.type !== 'bomber' || u.hp <= 0 || u.state !== 0 || this.launched.has(u.id)) continue;
      this.launched.add(u.id);
      const victim = state.map.owner[u.target];
      if (victim <= 0 || !this.counted(victim) || !hostile(state, u.owner, victim)) continue;
      s.incomingBombers++;
      let patrol = false;
      let covered = false;
      for (const wg of air?.wings ?? []) {
        if (wg.owner !== victim || wg.mission !== 'superiority') continue;
        const b = state.buildings.get(wg.airfield);
        if (!b || b.owner !== victim || b.buildLeft > 0 || b.fighters <= 0) continue;
        patrol = true;
        const c = wg.target >= 0 ? wg.target : b.tile;
        const r = airPatrolRadius(b, state);
        const dx = (c % w) - (u.target % w);
        const dy = ((c / w) | 0) - ((u.target / w) | 0);
        if (dx * dx + dy * dy <= r * r) covered = true;
      }
      if (patrol) s.incomingWithPatrol++;
      if (covered) s.incomingCovered++;
    }
    if (this.launched.size > 4096) for (const id of [...this.launched]) if (!state.units.some((u) => u.id === id && u.hp > 0)) this.launched.delete(id);
  }
  private readonly launched = new Set<number>();
  /** hp share of every warship at the last 10 s sample (a warship sunk "soft" was below half then) */
  private sampleHp = new Map<number, number>();

  /** Per warship type, every sample (see ShipKindStats). */
  private sampleKinds(warships: readonly Unit[], atWarSet: Set<number>, targets: Map<number, Set<number>>): void {
    const state = this.state;
    const s = this.stats;
    const w = state.map.width;
    const fields = minefields(state);
    const sonar2 = ARSENAL.destroyerSonar * ARSENAL.destroyerSonar;
    const range2 = WARSHIP_RANGE * WARSHIP_RANGE;
    const shipping = state.units.filter((u) => u.hp > 0 && (u.type === 'transport' || u.type === 'tradeShip'));
    const nations = state.players.filter((p) => p.id > 0 && p.alive && !isTribe(p));
    for (const u of warships) {
      if (!this.counted(u.owner)) continue;
      const ks = s.navy[shipKind(u)];
      ks.alive++;
      if (!atWarSet.has(u.owner)) continue;
      ks.war++;
      const reach = NAVY_SUPPORT_RANGE * Math.max(0.5, navalSupportMul(u));
      if (this.frontNear(u.owner, targets.get(u.owner), u.x, u.y, Math.round(reach))) ks.onFront++;
      if (u.state === 3) ks.station++;
      else if (u.state === 2) ks.chasing++;
      else if (u.state === 4) ks.escorting++;
      if (u.hp < warshipMaxHp(u) - 1e-9 && buildingsOf(state, u.owner, 'port').some((b) => b.owner === u.owner && (b.tile % w - u.x) ** 2 + (((b.tile / w) | 0) - u.y) ** 2 <= 64)) ks.mending++;
      if (u.variant === 'submarine' && nations.some((p) => p.id !== u.owner && atWar(state, p.id, u.owner) && unitVisibleTo(state, p.id, u))) ks.revealed++;
      let targetable = false;
      let nearDestroyer = false;
      let sonarContact = false;
      for (const e of warships) {
        if (e.owner === u.owner || !hostile(state, u.owner, e.owner)) continue;
        const d = (e.x - u.x) * (e.x - u.x) + (e.y - u.y) * (e.y - u.y);
        if (d <= range2 && navalCanTarget(state, e, u)) targetable = true;
        if (e.variant === 'destroyer' && d <= sonar2) nearDestroyer = true;
        if (e.variant === 'submarine' && d <= sonar2) sonarContact = true;
      }
      if (targetable) ks.targetable++;
      if (nearDestroyer) ks.nearDestroyer++;
      if (u.variant === 'destroyer' && sonarContact) ks.sonarContact++;
      if (minefieldAt(state, fields, u.x, u.y, u.owner) > 0) ks.inMinefield++;
      const br = NAVY_BLOCKADE_RANGE * navalBlockadeMul(u);
      for (const b of state.buildings.values()) {
        if (b.type !== 'port' || b.owner === u.owner || !atWar(state, u.owner, b.owner)) continue;
        if ((b.tile % w - u.x) ** 2 + (((b.tile / w) | 0) - u.y) ** 2 <= br * br) {
          ks.blockading++;
          break;
        }
      }
      if (u.variant === 'destroyer' && shipping.some((t) => t.owner === u.owner && (t.x - u.x) ** 2 + (t.y - u.y) ** 2 <= sonar2)) ks.nearShipping++;
      if (u.variant === 'carrier' && this.frontNear(u.owner, targets.get(u.owner), u.x, u.y, ARSENAL.carrierAirRange)) ks.airReach++;
    }
  }

  private foesTick = -1;
  private foes = new Map<number, Set<number>>();
  /** Nations `me` is at war with (naval2.atWar: an attack either way now or lately), cached per tick. */
  private foesOf(me: number): Set<number> {
    const state = this.state;
    if (this.foesTick !== state.tick) {
      this.foesTick = state.tick;
      this.foes = new Map();
    }
    let f = this.foes.get(me);
    if (f) return f;
    f = new Set();
    for (const p of state.players) if (p.id > 0 && p.id !== me && p.alive && !isTribe(p) && atWar(state, me, p.id)) f.add(p.id);
    this.foes.set(me, f);
    return f;
  }
  /** One 10 s sample of a counted division (second cut). */
  private sampleArmor(u: Unit): void {
    const foes = this.foesOf(u.owner);
    if (!foes.size) return;
    const a = this.stats.armor;
    a.war++;
    if (u.state === 3) a.attack++;
    else if (u.state === 2) a.launch++;
    else if (u.state === 1) {
      if (u.mode === 'refit') a.retreat++;
      else a.toFront++;
    } else if (this.frontNear(u.owner, foes, u.x, u.y, FRONT_TILES)) a.holdFront++;
    else if ((u.troops.infantry + u.troops.armor + u.troops.artillery) / FULL_DIVISION < ARMOR_SUPPORT_READY) a.holdRefit++;
    else {
      a.holdAway++;
      const why = this.awayWhy(u, foes);
      a.away[why] = (a.away[why] ?? 0) + 1;
    }
  }
  /** Own land under 3 tiles deep from u in one of the 4 directions (armor2's interior test). */
  private thinAt(u: Unit): boolean {
    const map = this.state.map;
    const { width: w, height: h, owner } = map;
    const x = Math.round(u.x);
    const y = Math.round(u.y);
    const own = (xx: number, yy: number): boolean => xx >= 0 && yy >= 0 && xx < w && yy < h && owner[yy * w + xx] === u.owner;
    return !(own(x + 3, y) && own(x - 3, y) && own(x, y + 3) && own(x, y - 3));
  }
  /** Own land 4-connected to u's tile is a piece of under 60 tiles. */
  private cutOff(u: Unit): boolean {
    const map = this.state.map;
    const { width: w, height: h, owner } = map;
    const t0 = Math.round(u.y) * w + Math.round(u.x);
    if (owner[t0] !== u.owner) return false;
    const seen = new Set<number>([t0]);
    const q = [t0];
    for (let i = 0; i < q.length; i++) {
      if (q.length >= 60) return false;
      const t = q[i];
      const x = t % w;
      const y = (t / w) | 0;
      for (const n of [x > 0 ? t - 1 : -1, x < w - 1 ? t + 1 : -1, y > 0 ? t - w : -1, y < h - 1 ? t + w : -1]) {
        if (n < 0 || seen.has(n) || owner[n] !== u.owner) continue;
        seen.add(n);
        q.push(n);
      }
    }
    return true;
  }
  private awayWhy(u: Unit, foes: Set<number>): string {
    const state = this.state;
    const mode = u.mode ?? 'hold';
    if (mode === 'hold') return 'hold mode';
    if (mode === 'refit') return 'refit mode';
    if ((u.retryTick ?? 0) > state.tick) return state.tick - (this.divs.get(u.id)?.fell ?? -1e9) <= TANK_FALLBACK_PAUSE * TICKS_PER_SECOND ? 'paused after falling back' : 'waiting on a route';
    let border = false;
    for (const f of foes) if (frontTiles(state, u.owner, f, 1).length) border = true;
    if (!border) return 'no land front';
    const st = u.station;
    if (st === undefined) return 'no front tile';
    const w = state.map.width;
    const dx = (st % w) - u.x;
    const dy = ((st / w) | 0) - u.y;
    return dx * dx + dy * dy > 36 * 36 ? 'front tile far' : 'front tile near, quiet';
  }

  /** Every 10 s of game time. */
  sample(): void {
    const state = this.state;
    const s = this.stats;
    const w = state.map.width;
    const targets = this.attackTargets();
    // Nations at war: an attack either way with another nation.
    const atWar = new Set<number>();
    for (const a of state.attacks) {
      if (a.target <= 0 || a.attacker <= 0) continue;
      if (isTribe(state.players[a.target]) || isTribe(state.players[a.attacker])) continue;
      atWar.add(a.attacker);
      atWar.add(a.target);
    }
    const warships = state.units.filter((u) => u.type === 'warship' && u.hp > 0);
    this.sampleHp = new Map(warships.map((u) => [u.id, u.hp / warshipMaxHp(u)]));
    const or2 = NAVY_REACH.oddsRadius * NAVY_REACH.oddsRadius;
    const supported = new Set<number>(); // owner*1024+target: a ship of owner on the front with target
    for (const u of warships) {
      if (!this.counted(u.owner)) continue;
      s.ships.alive++;
      const seen = this.ships.get(u.id);
      if (seen && u.hp < 0.5 * warshipMaxHp(u)) seen.crippled = true;
      if (u.state === 3) s.ships.station++;
      if (u.state === 4) s.ships.escorting++;
      let foes = 0;
      let friends = 0;
      for (const o of warships) {
        const dx = o.x - u.x;
        const dy = o.y - u.y;
        if (dx * dx + dy * dy > or2) continue;
        if (o.owner === u.owner) friends++;
        else if (hostile(state, u.owner, o.owner)) foes++;
      }
      if (foes > friends) s.ships.outnumbered++;
      if (!atWar.has(u.owner)) continue;
      s.ships.atWar++;
      const v = this.frontNear(u.owner, targets.get(u.owner), u.x, u.y, NAVY_SUPPORT_RANGE);
      if (targets.get(u.owner)?.size) {
        s.ships.attacking++;
        if (u.state === 3) s.ships.attackingStation++;
        if (v > 0) s.ships.attackingOnFront++;
      }
      if (v > 0) {
        s.ships.onFront++;
        if (u.state === 3) s.ships.stationOnFront++;
        supported.add(u.owner * 1024 + v);
      }
    }
    this.sampleKinds(warships, atWar, targets);
    for (const u of state.units) {
      if (u.hp <= 0 || !this.counted(u.owner)) continue;
      if (u.type === 'transport' && u.targetOwner > 0) {
        s.transports.atSea++;
        if (warships.some((e) => e.owner === u.owner && e.state === 4 && e.station === u.id)) s.transports.escorted++;
      } else if (u.type === 'tankDivision') {
        this.sampleArmor(u);
        if (!atWar.has(u.owner)) continue;
        s.tanks.atWar++;
        const share = (u.troops.infantry + u.troops.armor + u.troops.artillery) / FULL_DIVISION;
        if (share < 0.4) s.tanks.worn++;
        if (u.state === 3) s.tanks.spearhead++;
        else if (u.state === 1 || u.state === 2) s.tanks.driving++;
        else {
          if (this.frontNear(u.owner, targets.get(u.owner), u.x, u.y, 12)) s.tanks.holdFront++;
          else s.tanks.holdFar++;
          if (u.mode === 'support') {
            s.tanks.holdSupport++;
            const st = u.station;
            const dx = (st ?? 0) % w - u.x;
            const dy = (((st ?? 0) / w) | 0) - u.y;
            if (st !== undefined && dx * dx + dy * dy <= 576) s.tanks.holdAtStation++;
          }
        }
      }
    }
    // Main attacks: naval and air support on the AI's biggest attack on a nation.
    const zones = airState(state).zones;
    for (const p of state.players) {
      if (!p.alive || !this.counted(p.id)) continue;
      // The nation it attacked last (within 30 s; ties: lower id).
      let main = null as null | { target: number; tick: number };
      for (const q of targets.get(p.id) ?? []) {
        const t = this.lastAttack.get(p.id * 4096 + q) ?? -1;
        if (!main || t > main.tick || (t === main.tick && q < main.target)) main = { target: q, tick: t };
      }
      if (!main) continue;
      const fleet = warships.some((u) => u.owner === p.id);
      if (fleet && coastCount(state, main.target) > 0) {
        // coastal target with a fleet of ours afloat
        s.ships.mainCoastal++;
        if (supported.has(p.id * 1024 + main.target)) s.ships.mainSupported++;
      }
      if (buildingsOf(state, p.id, 'airfield').some((b) => b.bombers > 0 || state.units.some((u) => u.type === 'bomber' && u.owner === p.id))) {
        s.mainAirOwn++;
        const one = new Set([main.target]);
        if (zones.some((z) => z.owner === p.id && z.victim === main!.target && z.untilTick > state.tick && this.frontNear(p.id, one, z.tile % w, (z.tile / w) | 0, z.radius))) s.mainAirZone++;
      }
    }
  }
}

const pc = (a: number, b: number): string => (b > 0 ? `${Math.round((100 * a) / b)}%` : '-');
const f1 = (v: number): string => (Number.isFinite(v) ? v.toFixed(1) : '-');

/** Report lines for the summed stats of `games` games. */
export function attackReport(a: AttackStats, games: number): string[] {
  const g = Math.max(1, games);
  const out: string[] = [];
  const sh = a.ships;
  out.push(`\nAI attack probe (${games} games; AI nations only):`);
  out.push(`  Warships: ${f1(sh.built / g)} built, ${f1(sh.sunk / g)} sunk per game (${pc(sh.sunk, sh.built)}; by warships ${f1(sh.sunkByShip / g)}, mines ${f1(sh.sunkByMine / g)}; ${f1(sh.ownerGone / g)} more gone with their owner); sunk without any effect ${pc(sh.sunkNoXp, sh.sunk)}, sunk after being crippled ${pc(sh.sunkCrippled, sh.sunk)}.`);
  out.push(`    ship time: at war ${pc(sh.atWar, sh.alive)}; of that on an own attack's front ${pc(sh.onFront, sh.atWar)}; on station ${pc(sh.station, sh.alive)} (on the front ${pc(sh.stationOnFront, sh.station)}); escorting ${pc(sh.escorting, sh.alive)}; locally outnumbered ${pc(sh.outnumbered, sh.alive)}.`);
  out.push(`    while their nation attacks a nation (${pc(sh.attacking, sh.alive)} of ship time): on that attack's front ${pc(sh.attackingOnFront, sh.attacking)}, on station ${pc(sh.attackingStation, sh.attacking)}.`);
  out.push(`    main attack (the nation attacked last), fleet afloat: naval support on that front ${pc(sh.mainSupported, sh.mainCoastal)} of ${sh.mainCoastal} samples.`);
  const tr = a.transports;
  out.push(`  Invasions: ${f1(tr.invasions / g)} per game; sunk ${pc(tr.sunk, tr.invasions)} (${f1(tr.troopsSunk / g / 1000)}k troops per game), repelled ${pc(tr.repelled, tr.invasions)}; escorted ${pc(tr.escorted, tr.atSea)} of transport time at sea.`);
  const tk = a.tanks;
  const ov = tk.overrun[0] + tk.overrun[1] + tk.overrun[2];
  out.push(`  Tank divisions: ${f1(tk.formed / g)} formed per game; overrun ${pc(ov, tk.formed)} (at <10% / 10-40% / >=40% strength: ${tk.overrun.join(' / ')}; while defending ${pc(tk.overrunDefending, ov)}), spent ${pc(tk.spent, tk.formed)}; within 60 s after a spearhead ${pc(tk.overrunAfterSpearhead, ov)}; ${f1(tk.ownerGone / g)} gone with their owner.`);
  out.push(`    division time at war: spearheading ${pc(tk.spearhead, tk.atWar)}, holding at an own attack front ${pc(tk.holdFront, tk.atWar)}, holding elsewhere ${pc(tk.holdFar, tk.atWar)}, driving ${pc(tk.driving, tk.atWar)}; worn (<40%) ${pc(tk.worn, tk.atWar)}; holding time on support ${pc(tk.holdSupport, tk.holdFront + tk.holdFar)} (near its front tile ${pc(tk.holdAtStation, tk.holdSupport)}).`);
  const ar = a.armor;
  if (ar && ar.war) {
    const ends = Object.entries(ar.ends).sort((x, y) => y[1] - x[1]).map(([k, v]) => `${k} ${pc(v, ar.ended)}`).join(', ');
    const land = ar.spearTiles + ar.pocketTiles;
    out.push(`    at war (an attack either way in the last 30 s): attacking ${pc(ar.attack, ar.war)}, to a launch tile ${pc(ar.launch, ar.war)}, driving ${pc(ar.toFront, ar.war)}, retreating to refit ${pc(ar.retreat, ar.war)}, holding at the front ${pc(ar.holdFront, ar.war)}, holding away worn ${pc(ar.holdRefit, ar.war)}, holding away ready ${pc(ar.holdAway, ar.war)}; at the front in all ${pc(ar.attack + ar.launch + ar.holdFront, ar.war)}.`);
    out.push(`    spearheads ${f1(ar.spearheads / g)} per game (${f1(ar.spearheads / Math.max(1, tk.formed))} per division), with company ${pc(ar.withCompany, ar.spearheads)}; ${f1(ar.spearTiles / Math.max(1, ar.ended))} tiles each, under 5 tiles ${pc(ar.shallow, ar.ended)}; land taken per division ${f1(land / Math.max(1, tk.formed))} tiles (pockets ${f1(ar.pocketTiles / Math.max(1, tk.formed))}); encirclements ${f1(ar.pocketEvents / g)} per game (${f1(ar.pockets / g)} pockets, ${f1(ar.pocketTiles / g)} tiles); fell back ${f1(ar.fellBack / g)} per game.`);
    const away = Object.entries(ar.away ?? {}).sort((x, y) => y[1] - x[1]).map(([k, v]) => `${k} ${pc(v, ar.holdAway)}`).join(', ');
    out.push(`    holding away ready, why: ${away || '-'}.`);
    const ov = Object.entries(ar.overrunWhere ?? {}).sort((x, y) => y[1] - x[1]).map(([k, v]) => `${k} ${v}`).join('; ');
    if (ov) out.push(`    overrun where (the tick before): ${ov}.`);
    out.push(`    ended: ${ends || '-'}; enemy spearheads into their land ${f1(ar.enemySpears / g)} per game, ${f1(ar.enemySpearTiles / Math.max(1, ar.enemySpears))} tiles each.`);
  }
  out.push('  ("front" = the border with a nation the unit\'s owner attacked within the last 30 s; AI attacks come in waves of about a second)');
  out.push('  Bombers by mission: sorties per game / arrived / on an own attack front (support, cover, manual) / into SAM cover (arrived)');
  for (const m of MISSIONS) {
    const b = a.bombers[m];
    out.push(`    ${m.padEnd(9)} ${f1(b.sorties / g).padStart(6)}  arrived ${pc(b.arrivals, b.sorties).padStart(4)}  on front ${m === 'strategic' ? '   -' : pc(b.onFront, b.arrivals).padStart(4)}  into SAM ${pc(b.intoSam, b.sorties).padStart(4)} (${pc(b.intoSamArrived, b.intoSam)} arrived)`);
  }
  const st = Object.entries(a.strikeTypes).sort((x, y) => y[1] - x[1]);
  const stTot = st.reduce((s, [, n]) => s + n, 0);
  out.push(`  Strategic / manual aims: ${st.map(([k, n]) => `${k} ${pc(n, stTot)}`).join(', ') || '-'}`);
  out.push(`  Main attack (the nation attacked last), nation with bombers: an air support zone on that front ${pc(a.mainAirZone, a.mainAirOwn)} of ${a.mainAirOwn} samples.`);
  if (a.navy) {
    out.push('  Warships by type, per game: built, sunk by destroyers / other ships / other; kills of trade ships, transports (landings at war), warships, soft warships (damaged or alone), submarines');
    for (const k of SHIP_KINDS) {
      const v = a.navy[k];
      if (!v || v.built <= 0) continue;
      const kl = v.kills;
      const byKind = v.sunkByKind ? Object.entries(v.sunkByKind).sort((x, y) => y[1] - x[1]).map(([kk, n]) => `${kk} ${f1(n / g)}`).join(', ') : '';
      out.push(`    ${k.padEnd(10)} built ${f1(v.built / g).padStart(5)}  sunk ${f1(v.sunkByDestroyer / g)} / ${f1(v.sunkByShip / g)} / ${f1(v.sunkOther / g)}  kills: trade ${f1(kl.trade / g)}, transports ${f1(kl.transport / g)} (${f1(v.killsLanding / g)}), warships ${f1(kl.warship / g)}, soft ${f1(kl.softWarship / g)}, subs ${f1(kl.sub / g)}  per loss ${f1((kl.trade + kl.transport + kl.warship + kl.softWarship + kl.sub) / Math.max(1, v.sunkByDestroyer + v.sunkByShip + v.sunkOther))}${byKind ? `  (sunk by ${byKind})` : ''}`);
      const extra: string[] = [];
      if (k === 'submarine') extra.push(`seen by the enemy ${pc(v.revealed, v.war)}`);
      if (k === 'destroyer') extra.push(`enemy sub in sonar ${pc(v.sonarContact, v.war)}`, `by own shipping ${pc(v.nearShipping, v.war)}`);
      if (k === 'carrier') extra.push(`front in air reach ${pc(v.airReach, v.war)}`);
      out.push(`      time at war ${pc(v.war, v.alive)}; of it: on an own attack front ${pc(v.onFront, v.war)}, station ${pc(v.station, v.war)}, chasing ${pc(v.chasing, v.war)}, escorting ${pc(v.escorting, v.war)}, mending ${pc(v.mending, v.war)}, enemy can fire at it ${pc(v.targetable, v.war)}, enemy destroyer in sonar ${pc(v.nearDestroyer, v.war)}, in a minefield ${pc(v.inMinefield, v.war)}, blockading ${pc(v.blockading, v.war)}${extra.length ? ', ' + extra.join(', ') : ''}`);
    }
    out.push(`  Landings with naval support ${pc(a.landingsSupported, a.landings)} of ${f1(a.landings / g)} per game; bomber sorties from carriers ${f1(a.carrierSorties / g)} per game.`);
    out.push(`  Enemy bombers at our land: ${f1(a.incomingBombers / g)} per game; while we had a superiority patrol ${pc(a.incomingWithPatrol, a.incomingBombers)}, aimed inside a patrol circle ${pc(a.incomingCovered, a.incomingBombers)} (${pc(a.incomingCovered, a.incomingWithPatrol)} of those with a patrol); patrol engagements ${f1(a.patrolEngagements / g)} per game.`);
  }
  return out;
}
