// Attack probe for scripts/batch.ts: how AI nations use warships, tank divisions and bombers (read-only; never
// changes a value of the game). One probe per game: beforeTick / afterTick around every tick, sample every 10 s,
// finish at the end. Counts only units of AI nations (no humans, no tribes).
//
// What "on the front" means here: attacks advance along the whole shared border with their target (combat.ts), so a
// tile of a nation we attack that touches our land is where that attack is fought. A warship within
// NAVY_SUPPORT_RANGE of such a tile supports it (naval2.navalSupportAt), a support strike centred within
// AIR.supportRadius of one bombs it.
import { AIR, NAVY_REACH, NAVY_SUPPORT_RANGE, TANK_DIVISION_TROOPS } from '../src/sim/config';
import { buildingAt, buildingsOf, isDisabled, samRadius } from '../src/sim/buildings';
import { areAllied } from '../src/sim/diplomacy';
import { atPeace } from '../src/sim/rules';
import { warshipMaxHp } from '../src/sim/naval2';
import { airState } from '../src/sim/airwings';
import { coastCount } from '../src/sim/territory';
import { isTribe } from '../src/sim/types';
import type { GameEvent, GameState, Unit } from '../src/sim/types';

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

export interface AttackStats {
  ships: {
    built: number;
    sunk: number;
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
}

export function newAttackStats(): AttackStats {
  const b = (): BomberStats => ({ sorties: 0, arrivals: 0, onFront: 0, intoSam: 0, intoSamArrived: 0 });
  return {
    ships: { built: 0, sunk: 0, sunkNoXp: 0, sunkCrippled: 0, alive: 0, atWar: 0, onFront: 0, station: 0, stationOnFront: 0, outnumbered: 0, escorting: 0, mainCoastal: 0, mainSupported: 0 },
    transports: { invasions: 0, sunk: 0, troopsSunk: 0, repelled: 0, atSea: 0, escorted: 0 },
    tanks: { formed: 0, overrun: [0, 0, 0], spent: 0, atWar: 0, spearhead: 0, holdFront: 0, holdFar: 0, driving: 0, worn: 0, overrunDefending: 0 },
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
}
interface ShipSeen {
  owner: number;
  xp: number;
  crippled: boolean;
}
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
  constructor(private readonly state: GameState) {}

  private attackTargets(): Map<number, Set<number>> {
    const state = this.state;
    if (this.targetsTick === state.tick) return this.targets;
    this.targetsTick = state.tick;
    const m = new Map<number, Set<number>>();
    for (const a of state.attacks) {
      if (a.target <= 0 || isTribe(state.players[a.target])) continue;
      let s = m.get(a.attacker);
      if (!s) m.set(a.attacker, (s = new Set()));
      s.add(a.target);
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
    const alive = new Set<number>();
    for (const u of state.units) {
      if (u.hp <= 0 || !isAINation(state, u.owner)) continue;
      alive.add(u.id);
      if (u.type === 'warship') {
        let seen = this.ships.get(u.id);
        if (!seen) {
          this.ships.set(u.id, (seen = { owner: u.owner, xp: 0, crippled: false }));
          s.ships.built++;
        }
        seen.xp = u.xp ?? 0;
      } else if (u.type === 'tankDivision') {
        let seen = this.divs.get(u.id);
        if (!seen) {
          this.divs.set(u.id, (seen = { owner: u.owner, share: 1 }));
          s.tanks.formed++;
        }
        seen.share = (u.troops.infantry + u.troops.armor + u.troops.artillery) / FULL_DIVISION;
      } else if (u.type === 'bomber') {
        let seen = this.bombers.get(u.id);
        if (!seen) {
          const mission: MissionKey = MISSIONS[u.mission ?? 0] ?? 'manual';
          seen = { owner: u.owner, mission, aim: u.target, intoSam: this.inHostileSam(u.owner, u.target), arrived: false };
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
      if (!isAINation(state, o)) continue;
      if (e.kind === 'unitLost' && /tank division was overrun/.test(e.message)) overrun.set(o, (overrun.get(o) ?? 0) + 1);
      else if (e.kind === 'unitLost' && /lost a transport with (\d+) troops/.test(e.message)) {
        s.transports.sunk++;
        s.transports.troopsSunk += Number(/with (\d+) troops/.exec(e.message)![1]);
      } else if (e.kind === 'unitLost' && /landing was repelled/.test(e.message)) s.transports.repelled++;
      else if ((e.kind as string) === 'spearheadEnded' && /the division is spent/.test(e.message)) s.tanks.spent++;
    }
    for (const [id, seen] of this.ships) {
      if (id < 0 || alive.has(id)) continue;
      this.ships.delete(id);
      s.ships.sunk++;
      if (seen.xp <= 0) s.ships.sunkNoXp++;
      if (seen.crippled) s.ships.sunkCrippled++;
    }
    for (const id of [...this.ships.keys()]) if (id < 0 && !alive.has(-id)) this.ships.delete(id);
    for (const [id, seen] of this.divs) {
      if (alive.has(id)) continue;
      this.divs.delete(id);
      const n = overrun.get(seen.owner) ?? 0;
      if (n <= 0) continue;
      overrun.set(seen.owner, n - 1);
      s.tanks.overrun[seen.share < 0.1 ? 0 : seen.share < 0.4 ? 1 : 2]++;
      if (state.attacks.some((a) => a.target === seen.owner && a.attacker > 0 && !isTribe(state.players[a.attacker]))) s.tanks.overrunDefending++;
    }
    for (const id of this.bombers.keys()) if (!alive.has(id)) this.bombers.delete(id);
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
    const or2 = NAVY_REACH.oddsRadius * NAVY_REACH.oddsRadius;
    const supported = new Set<number>(); // owner*1024+target: a ship of owner on the front with target
    for (const u of warships) {
      if (!isAINation(state, u.owner)) continue;
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
      if (v > 0) {
        s.ships.onFront++;
        if (u.state === 3) s.ships.stationOnFront++;
        supported.add(u.owner * 1024 + v);
      }
    }
    for (const u of state.units) {
      if (u.hp <= 0 || !isAINation(state, u.owner)) continue;
      if (u.type === 'transport' && u.targetOwner > 0) {
        s.transports.atSea++;
        if (warships.some((e) => e.owner === u.owner && e.state === 4 && e.station === u.id)) s.transports.escorted++;
      } else if (u.type === 'tankDivision' && atWar.has(u.owner)) {
        s.tanks.atWar++;
        const share = (u.troops.infantry + u.troops.armor + u.troops.artillery) / FULL_DIVISION;
        if (share < 0.4) s.tanks.worn++;
        if (u.state === 3) s.tanks.spearhead++;
        else if (u.state === 1 || u.state === 2) s.tanks.driving++;
        else if (this.frontNear(u.owner, targets.get(u.owner), u.x, u.y, 12)) s.tanks.holdFront++;
        else s.tanks.holdFar++;
      }
    }
    // Main attacks: naval and air support on the AI's biggest attack on a nation.
    const zones = airState(state).zones;
    for (const p of state.players) {
      if (!p.alive || !isAINation(state, p.id)) continue;
      let main = null as null | { target: number; troops: number };
      for (const a of state.attacks) {
        if (a.attacker !== p.id || a.target <= 0 || isTribe(state.players[a.target])) continue;
        const tr = a.troops.infantry + a.troops.armor + a.troops.artillery;
        if (!main || tr > main.troops) main = { target: a.target, troops: tr };
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
  out.push(`  Warships: ${f1(sh.built / g)} built, ${f1(sh.sunk / g)} sunk per game (${pc(sh.sunk, sh.built)}); sunk without any effect ${pc(sh.sunkNoXp, sh.sunk)}, sunk after being crippled ${pc(sh.sunkCrippled, sh.sunk)}.`);
  out.push(`    ship time: at war ${pc(sh.atWar, sh.alive)}; of that on an own attack's front ${pc(sh.onFront, sh.atWar)}; on station ${pc(sh.station, sh.alive)} (on the front ${pc(sh.stationOnFront, sh.station)}); escorting ${pc(sh.escorting, sh.alive)}; locally outnumbered ${pc(sh.outnumbered, sh.alive)}.`);
  out.push(`    main attack on a nation, fleet afloat: naval support on that front ${pc(sh.mainSupported, sh.mainCoastal)} of ${sh.mainCoastal} samples.`);
  const tr = a.transports;
  out.push(`  Invasions: ${f1(tr.invasions / g)} per game; sunk ${pc(tr.sunk, tr.invasions)} (${f1(tr.troopsSunk / g / 1000)}k troops per game), repelled ${pc(tr.repelled, tr.invasions)}; escorted ${pc(tr.escorted, tr.atSea)} of transport time at sea.`);
  const tk = a.tanks;
  const ov = tk.overrun[0] + tk.overrun[1] + tk.overrun[2];
  out.push(`  Tank divisions: ${f1(tk.formed / g)} formed per game; overrun ${pc(ov, tk.formed)} (at <10% / 10-40% / >=40% strength: ${tk.overrun.join(' / ')}; while defending ${pc(tk.overrunDefending, ov)}), spent ${pc(tk.spent, tk.formed)}.`);
  out.push(`    division time at war: spearheading ${pc(tk.spearhead, tk.atWar)}, holding at an own attack front ${pc(tk.holdFront, tk.atWar)}, holding elsewhere ${pc(tk.holdFar, tk.atWar)}, driving ${pc(tk.driving, tk.atWar)}; worn (<40%) ${pc(tk.worn, tk.atWar)}.`);
  out.push('  Bombers by mission: sorties per game / arrived / on an own attack front (support, cover, manual) / into SAM cover (arrived)');
  for (const m of MISSIONS) {
    const b = a.bombers[m];
    out.push(`    ${m.padEnd(9)} ${f1(b.sorties / g).padStart(6)}  arrived ${pc(b.arrivals, b.sorties).padStart(4)}  on front ${m === 'strategic' ? '   -' : pc(b.onFront, b.arrivals).padStart(4)}  into SAM ${pc(b.intoSam, b.sorties).padStart(4)} (${pc(b.intoSamArrived, b.intoSam)} arrived)`);
  }
  const st = Object.entries(a.strikeTypes).sort((x, y) => y[1] - x[1]);
  const stTot = st.reduce((s, [, n]) => s + n, 0);
  out.push(`  Strategic / manual aims: ${st.map(([k, n]) => `${k} ${pc(n, stTot)}`).join(', ') || '-'}`);
  out.push(`  Main attack, nation with bombers: an air support zone on that front ${pc(a.mainAirZone, a.mainAirOwn)} of ${a.mainAirOwn} samples.`);
  return out;
}
