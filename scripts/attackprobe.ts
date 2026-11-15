// Attack probe for scripts/batch.ts: how AI nations use warships, tank divisions and bombers (read-only; never
// changes a value of the game). One probe per game: beforeTick / afterTick around every tick, sample every 10 s,
// finish at the end. Counts only units of AI nations (no humans, no tribes).
//
// What "on the front" means here: attacks advance along the whole shared border with their target (combat.ts), so a
// tile of a nation we attack that touches our land is where that attack is fought. A warship within
// NAVY_SUPPORT_RANGE of such a tile supports it (naval2.navalSupportAt), a support strike centred within
// AIR.supportRadius of one bombs it.
import { AIR, ARSENAL, NAVY_BLOCKADE_RANGE, NAVY_REACH, NAVY_SUPPORT_RANGE, NAVY_XP_SINK, TANK_DIVISION_TROOPS, WARSHIP_RANGE } from '../src/sim/config';
import { buildingAt, buildingsOf, isDisabled, samRadius } from '../src/sim/buildings';
import { areAllied } from '../src/sim/diplomacy';
import { atPeace } from '../src/sim/rules';
import { atWar, supportingShips, warshipMaxHp } from '../src/sim/naval2';
import { airPatrolRadius, airState, airSuperiorityAt, fightersOver } from '../src/sim/airwings';
import { unitVisibleTo } from '../src/sim/techtree';
import { minefieldAt, minefields } from '../src/sim/specials';
import { navalBlockadeMul, navalCanTarget, navalSupportMul } from '../src/sim/variants';
import { coastCount } from '../src/sim/territory';
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
  bombers: Record<MissionKey, BomberStats>;
  /** strategic / manual strike aims by building type at the aim tile */
  strikeTypes: Record<string, number>;
  /** main-attack samples (an AI nation's biggest attack on a nation) with an air support zone on that front, and
   *  where the nation had bombers at an airfield */
  mainAirOwn: number;
  mainAirZone: number;
  /** fighters and air superiority (counted owners) */
  air?: AirFightStats;
}

/** Fighters, recon and bombing under air superiority (airwings.airSuperiorityAt). */
export interface AirFightStats {
  /** fighters bought (an airfield's stored fighters going up) */
  fightersBought: number;
  /** recon flights flown, reached their target, shot down */
  reconFlights: number;
  reconArrived: number;
  reconLost: number;
  /** planes of any owner shot down by counted owners: by airfield / patrol fighters, carrier fighters, SAM sites;
   *  of the fighter and carrier kills, recon planes */
  fighterKills: number;
  carrierKills: number;
  samKills: number;
  reconKills: number;
  /** bomber arrivals of counted owners, of them over a tile the victim's fighters guard; troops killed and buildings
   *  hit by those arrivals (airfield strike results), split the same way */
  arrivals: number;
  guardedArrivals: number;
  kills: number;
  guardedKills: number;
  buildings: number;
  guardedBuildings: number;
  /** arrivals by the victim's fighters over the aim: none, fewer than the minimum, enough but matched by ours */
  arrNoFighters?: number;
  arrFewFighters?: number;
  arrContested?: number;
  /** of arrNoFighters: the victim had no finished airfield at all / airfields but no fighter stored anywhere */
  arrNoAirfield?: number;
  arrNoneStored?: number;
  /** 10 s samples of finished airfields of counted owners: count, fighters stored, with the minimum or more */
  afSamples?: number;
  afFighters?: number;
  afEnough?: number;
}

function newAirFight(): AirFightStats {
  return { fightersBought: 0, reconFlights: 0, reconArrived: 0, reconLost: 0, fighterKills: 0, carrierKills: 0, samKills: 0, reconKills: 0, arrivals: 0, guardedArrivals: 0, kills: 0, guardedKills: 0, buildings: 0, guardedBuildings: 0, arrNoFighters: 0, arrFewFighters: 0, arrContested: 0, afSamples: 0, afFighters: 0, afEnough: 0 };
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
    bombers: { manual: b(), support: b(), strategic: b(), cover: b() },
    strikeTypes: {},
    mainAirOwn: 0,
    mainAirZone: 0,
    air: newAirFight(),
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
}
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

  /** airfield building id -> fighters stored at the last tick (counted owners) */
  private afFighters = new Map<number, number>();
  /** recon planes of counted owners seen: id -> reached its target */
  private recon = new Map<number, boolean>();
  /** airfield strike results before the tick: airfield id -> first tick, kills, buildings */
  private resultSnap = new Map<number, { start: number; kills: number; buildings: number }>();

  /** Before tick(): the airfield strike results as they were (afterTick adds what this tick's arrivals did). */
  beforeTick(): void {
    this.resultSnap.clear();
    for (const r of this.state.air?.results ?? []) this.resultSnap.set(r.airfield, { start: r.start, kills: r.kills, buildings: r.buildings });
  }

  /** After tick(): new units, units gone (sunk, overrun), arrivals, events. Call before the caller clears events. */
  afterTick(events: readonly GameEvent[]): void {
    const state = this.state;
    const s = this.stats;
    this.noteAttacks();
    const alive = new Set<number>();
    /** airfield building id -> a bomber of it arrived this tick (true: one over a guarded tile) */
    const arrivedFrom = new Map<number, boolean>();
    for (const u of state.units) {
      if (u.hp <= 0 || !this.counted(u.owner)) continue;
      alive.add(u.id);
      if (u.type === 'reconPlane') {
        const air = (s.air ??= newAirFight());
        if (!this.recon.has(u.id)) {
          this.recon.set(u.id, false);
          air.reconFlights++;
        }
        if (u.state === 1 && !this.recon.get(u.id)) {
          this.recon.set(u.id, true);
          air.reconArrived++;
        }
      }
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
          this.divs.set(u.id, (seen = { owner: u.owner, share: 1, spear: -1e9 }));
          s.tanks.formed++;
        }
        seen.share = (u.troops.infantry + u.troops.armor + u.troops.artillery) / FULL_DIVISION;
        if (u.state === 3) seen.spear = state.tick;
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
          // Over a tile the victim's fighters guard (air superiority)?
          const af = buildingAt(state, u.home);
          const victim = state.map.owner[seen.aim];
          const guarded = victim > 0 && hostile(state, u.owner, victim) && airSuperiorityAt(state, victim, u.owner, seen.aim);
          const air = (s.air ??= newAirFight());
          air.arrivals++;
          if (guarded) air.guardedArrivals++;
          else if (victim > 0 && hostile(state, u.owner, victim)) {
            const def = fightersOver(state, victim, seen.aim);
            if (def <= 0) {
              air.arrNoFighters = (air.arrNoFighters ?? 0) + 1;
              const afs = buildingsOf(state, victim, 'airfield').filter((b) => b.buildLeft <= 0);
              if (!afs.length) air.arrNoAirfield = (air.arrNoAirfield ?? 0) + 1;
              else if (!afs.some((b) => b.fighters > 0)) air.arrNoneStored = (air.arrNoneStored ?? 0) + 1;
            }
            else if (def < AIR.superiorityMinFighters) air.arrFewFighters = (air.arrFewFighters ?? 0) + 1;
            else air.arrContested = (air.arrContested ?? 0) + 1;
          }
          if (af) arrivedFrom.set(af.id, (arrivedFrom.get(af.id) ?? false) || guarded);
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
      if (state.tick - seen.spear <= 600) s.tanks.overrunAfterSpearhead++;
      if (state.attacks.some((a) => a.target === seen.owner && a.attacker > 0 && !isTribe(state.players[a.attacker]))) s.tanks.overrunDefending++;
    }
    for (const id of this.bombers.keys()) if (!alive.has(id)) this.bombers.delete(id);
    this.airFight(events, arrivedFrom, alive);
    this.naval();
    this.incoming();
  }

  /** Fighters bought, planes shot down, recon lost, what this tick's bomber arrivals did (guarded or not). */
  private airFight(events: readonly GameEvent[], arrivedFrom: Map<number, boolean>, alive: Set<number>): void {
    const state = this.state;
    const air = (this.stats.air ??= newAirFight());
    for (const p of state.players) {
      if (!p.alive || !this.counted(p.id)) continue;
      for (const b of buildingsOf(state, p.id, 'airfield')) {
        const was = this.afFighters.get(b.id) ?? 0;
        if (b.fighters > was) air.fightersBought += b.fighters - was;
        this.afFighters.set(b.id, b.fighters);
      }
    }
    for (const e of events) {
      if (e.kind !== 'unitLost') continue;
      const m = /^(.*)'s (SAM site|fighters|carrier fighters) shot down an? (.+?) of (.+)$/.exec(e.message);
      if (!m) continue;
      const [owner, by] = e.players;
      if (m[3].startsWith('recon plane') && this.counted(owner)) air.reconLost++;
      if (!this.counted(by)) continue;
      if (m[2] === 'SAM site') air.samKills++;
      else {
        if (m[2] === 'fighters') air.fighterKills++;
        else air.carrierKills++;
        if (m[3].startsWith('recon plane')) air.reconKills++;
      }
    }
    for (const id of [...this.recon.keys()]) if (!alive.has(id)) this.recon.delete(id);
    if (!arrivedFrom.size) return;
    for (const r of state.air?.results ?? []) {
      if (r.tick !== state.tick - 1 || !arrivedFrom.has(r.airfield) || !this.counted(r.owner)) continue;
      const prev = this.resultSnap.get(r.airfield);
      const same = !!prev && prev.start === r.start;
      const dk = r.kills - (same ? prev!.kills : 0);
      const db = r.buildings - (same ? prev!.buildings : 0);
      air.kills += dk;
      air.buildings += db;
      if (arrivedFrom.get(r.airfield)) {
        air.guardedKills += dk;
        air.guardedBuildings += db;
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

  /** Every 10 s of game time. */
  sample(): void {
    {
      const air = (this.stats.air ??= newAirFight());
      for (const p of this.state.players) {
        if (!p.alive || !this.counted(p.id)) continue;
        for (const b of buildingsOf(this.state, p.id, 'airfield')) {
          if (b.buildLeft > 0) continue;
          air.afSamples = (air.afSamples ?? 0) + 1;
          air.afFighters = (air.afFighters ?? 0) + b.fighters;
          if (b.fighters >= AIR.superiorityMinFighters) air.afEnough = (air.afEnough ?? 0) + 1;
        }
      }
    }
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
      } else if (u.type === 'tankDivision' && atWar.has(u.owner)) {
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
const f2 = (a: number, b: number): string => (b > 0 ? (a / b).toFixed(2) : '-');
const shortK = (v: number): string => (v >= 1e4 ? `${Math.round(v / 1e3)}k` : v >= 1e3 ? `${(v / 1e3).toFixed(1)}k` : `${Math.round(v)}`);

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
    const af = a.air;
    if (af) {
      const per = (k: number, n: number): string => (n > 0 ? shortK(k / n) : '-');
      out.push(`  Fighters: ${f1(af.fightersBought / g)} bought per game; planes shot down per game by airfield and patrol fighters ${f1(af.fighterKills / g)}, carriers ${f1(af.carrierKills / g)}, SAM sites ${f1(af.samKills / g)}; recon planes among the fighter kills ${f1(af.reconKills / g)}.`);
      out.push(`  Recon: ${f1(af.reconFlights / g)} flights per game, reached the target ${pc(af.reconArrived, af.reconFlights)}, shot down ${pc(af.reconLost, af.reconFlights)}.`);
      if (af.afSamples) out.push(`  Airfields (10 s samples): ${f2(af.afFighters ?? 0, af.afSamples)} fighters each, ${pc(af.afEnough ?? 0, af.afSamples)} with ${AIR.superiorityMinFighters}+; arrivals not guarded: victim had no fighters there ${pc(af.arrNoFighters ?? 0, af.arrivals)} (no airfield at all ${pc(af.arrNoAirfield ?? 0, af.arrivals)}, airfields with no fighter ${pc(af.arrNoneStored ?? 0, af.arrivals)}), too few ${pc(af.arrFewFighters ?? 0, af.arrivals)}, matched by the bomber's side ${pc(af.arrContested ?? 0, af.arrivals)}.`);
      out.push(`  Bomber arrivals ${f1(af.arrivals / g)} per game, over a tile the victim's fighters guard ${pc(af.guardedArrivals, af.arrivals)}; per arrival: troops killed ${per(af.kills - af.guardedKills, af.arrivals - af.guardedArrivals)} unguarded / ${per(af.guardedKills, af.guardedArrivals)} guarded, buildings hit ${f2(af.buildings - af.guardedBuildings, af.arrivals - af.guardedArrivals)} / ${f2(af.guardedBuildings, af.guardedArrivals)}.`);
    }
    out.push(`  Enemy bombers at our land: ${f1(a.incomingBombers / g)} per game; while we had a superiority patrol ${pc(a.incomingWithPatrol, a.incomingBombers)}, aimed inside a patrol circle ${pc(a.incomingCovered, a.incomingBombers)} (${pc(a.incomingCovered, a.incomingWithPatrol)} of those with a patrol); patrol engagements ${f1(a.patrolEngagements / g)} per game.`);
  }
  return out;
}
