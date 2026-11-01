// End-of-game history (client only, read-only): every ~10 s of game time it samples each nation's land and troops,
// counts a few things the sim keeps no stat for (battles won, units built, most cities held) and keeps the key
// moments of the game (first contact, wars, cities and capitals, eliminations, alliances, the coalition, atom bombs).
// The HUD feeds it once per frame (single player, online and spectators alike); the test hook's fast-forward feeds it
// too. It never writes to the game state, so hashes and lockstep are untouched.
import { BUILDINGS } from '../../sim/config';
import { runawayLeader } from '../../sim/allies';
import { gameSeconds, gameSecondsAt } from '../../sim/state';
import { isTribe, type GameEvent, type GameState, type Player, type UnitType } from '../../sim/types';

/** game seconds between two samples (doubles each time the history is thinned) */
export const SAMPLE_SECONDS = 10;
/** at most this many samples: then every other one is dropped and the interval doubles */
export const MAX_SAMPLES = 360;
/** an attack on a nation counts as a battle won when it took at least this many tiles */
export const BATTLE_MIN_TILES = 3;
/** moments kept at most (the least important go first) */
export const MAX_MOMENTS = 300;
/** units that count as "built" (trade ships, rockets and bombs don't) */
const BUILT_UNITS: ReadonlySet<UnitType> = new Set<UnitType>(['transport', 'warship', 'bomber', 'fighter', 'transportPlane', 'tankDivision', 'reconPlane']);

export interface Sample {
  /** game seconds */
  t: number;
  /** land tiles per player id */
  tiles: Int32Array;
  /** home troops per player id */
  troops: Float32Array;
}

export type MomentKind = 'contact' | 'war' | 'cityLost' | 'cityTaken' | 'capital' | 'eliminated' | 'alliance' | 'coalition' | 'nuke' | 'half';

export interface Moment {
  /** game seconds */
  t: number;
  kind: MomentKind;
  text: string;
  /** nations involved (for picking: yours, the winner's and the top nations' count more) */
  players: number[];
}

/** How much each kind matters before the "who is involved" bonus (summary/moments.ts). */
export const KIND_WEIGHT: Record<MomentKind, number> = {
  half: 60,
  eliminated: 50,
  contact: 50,
  capital: 45,
  coalition: 40,
  nuke: 40,
  cityLost: 30,
  alliance: 30,
  cityTaken: 28,
  war: 25,
};

interface AttackRec {
  attacker: number;
  target: number;
  tiles: number;
  gen: number;
}

const isNation = (p: Player | undefined): p is Player => !!p && p.id > 0 && !isTribe(p);
function troopSum(p: Player): number {
  const t = p.troops;
  return t.infantry + t.armor + t.artillery;
}

export class GameHistory {
  samples: Sample[] = [];
  moments: Moment[] = [];
  /** attacks on nations that took land, per player id */
  battlesWon: number[] = [];
  /** units built per player id */
  unitsBuilt: number[] = [];
  /** most cities held at once, per player id */
  citiesMax: number[] = [];
  /** game seconds when each player first held half the land (-1 = never) */
  halfAt: number[] = [];
  interval = SAMPLE_SECONDS;

  private state: GameState | null = null;
  private nextSample = 0;
  private seen = new WeakSet<GameEvent>();
  private attacks = new Map<number, AttackRec>();
  private gen = 0;
  private wars = new Set<number>();
  private contact = false;
  private maxUnitId = -1;
  private leader = 0;
  private coalitions = new Set<number>();
  private overSampled = -1;

  /** Called once per frame (and by fast-forwards). A new game state starts a new history. */
  update(state: GameState): void {
    if (state !== this.state) this.reset(state);
    if (state.phase === 'spawn') {
      this.markEventsSeen(state);
      return;
    }
    const me = state.humanId;
    this.drainEvents(state, me);
    this.scanAttacks(state, me);
    this.scanUnits(state);
    const t = gameSeconds(state);
    const over = state.phase === 'over';
    // one sample every `interval` game seconds, and one at the end (the game is over at this tick)
    const final = over && this.overSampled !== state.tick;
    if (this.samples.length === 0 || t >= this.nextSample || final) {
      if (over) this.overSampled = state.tick;
      const last = this.samples[this.samples.length - 1];
      if (!last || t > last.t) this.sample(state, t);
      this.nextSample = (Math.floor(t / this.interval) + 1) * this.interval;
    }
  }

  /** game seconds covered so far */
  get duration(): number {
    const last = this.samples[this.samples.length - 1];
    return last ? last.t : 0;
  }

  private reset(state: GameState): void {
    this.state = state;
    const n = state.players.length;
    this.samples = [];
    this.moments = [];
    this.battlesWon = new Array<number>(n).fill(0);
    this.unitsBuilt = new Array<number>(n).fill(0);
    this.citiesMax = new Array<number>(n).fill(0);
    this.halfAt = new Array<number>(n).fill(-1);
    this.interval = SAMPLE_SECONDS;
    this.nextSample = 0;
    this.seen = new WeakSet();
    this.attacks.clear();
    this.wars.clear();
    this.contact = false;
    this.leader = 0;
    this.coalitions.clear();
    this.overSampled = -1;
    // units and events from before this history started (a rejoin, a page opened mid-game) are not news
    this.maxUnitId = -1;
    for (const u of state.units) this.maxUnitId = Math.max(this.maxUnitId, u.id);
    this.markEventsSeen(state);
    for (const a of state.attacks) this.attacks.set(a.id, { attacker: a.attacker, target: a.target, tiles: a.tilesTaken, gen: 0 });
  }

  private markEventsSeen(state: GameState): void {
    for (const e of state.events) this.seen.add(e);
  }

  private add(m: Moment): void {
    this.moments.push(m);
    if (this.moments.length > MAX_MOMENTS) {
      // drop the least important (the oldest of those first)
      let k = 0;
      for (let i = 1; i < this.moments.length; i++) if (KIND_WEIGHT[this.moments[i].kind] < KIND_WEIGHT[this.moments[k].kind]) k = i;
      this.moments.splice(k, 1);
    }
  }

  private sample(state: GameState, t: number): void {
    const n = state.players.length;
    const tiles = new Int32Array(n);
    const troops = new Float32Array(n);
    const land = Math.max(1, state.map.landTileCount);
    for (const p of state.players) {
      if (!isNation(p)) continue;
      tiles[p.id] = p.tiles;
      troops[p.id] = troopSum(p);
      if (this.halfAt[p.id] < 0 && p.tiles / land >= 0.5) this.halfAt[p.id] = t;
    }
    const cities = new Array<number>(n).fill(0);
    for (const b of state.buildings.values()) if (b.type === 'city' && b.owner > 0 && b.owner < n) cities[b.owner]++;
    for (let i = 0; i < n; i++) if (cities[i] > this.citiesMax[i]) this.citiesMax[i] = cities[i];
    this.samples.push({ t, tiles, troops });
    if (this.samples.length > MAX_SAMPLES) {
      // thin out: keep every other sample (and the newest), sample half as often from now on
      const last = this.samples[this.samples.length - 1];
      this.samples = this.samples.filter((_, i) => i % 2 === 0);
      if (this.samples[this.samples.length - 1] !== last) this.samples.push(last);
      this.interval *= 2;
    }
    // the coalition against a runaway leader (allies.ts): once per leader
    const leader = runawayLeader(state);
    if (leader && leader !== this.leader && !this.coalitions.has(leader)) {
      this.coalitions.add(leader);
      const me = state.humanId;
      const name = state.players[leader]?.name ?? '?';
      this.add({ t, kind: 'coalition', text: leader === me ? 'A coalition forms against you' : `A coalition forms against ${name}`, players: [leader] });
    }
    this.leader = leader;
  }

  private drainEvents(state: GameState, me: number): void {
    const evs = state.events;
    let k = evs.length - 1;
    while (k >= 0 && !this.seen.has(evs[k])) k--;
    for (let i = k + 1; i < evs.length; i++) {
      const e = evs[i];
      this.seen.add(e);
      this.onEvent(state, e, me);
    }
  }

  private name(state: GameState, id: number): string {
    return state.players[id]?.name ?? 'nobody';
  }

  private onEvent(state: GameState, e: GameEvent, me: number): void {
    const t = gameSecondsAt(state, e.tick);
    const P = state.players;
    switch (e.kind) {
      case 'capitalLost': {
        const [victim, taker = 0] = e.players;
        if (!isNation(P[victim])) return;
        if (isNation(P[taker])) this.onWar(state, taker, victim, me, t); // a capital taken without an attack seen (tanks, landings)
        let text: string;
        if (victim === me) text = taker ? `Your capital falls to ${this.name(state, taker)}` : 'You lose your capital';
        else if (taker && taker === me) text = `You take the capital of ${this.name(state, victim)}`;
        else text = taker ? `${this.name(state, victim)} loses its capital to ${this.name(state, taker)}` : `${this.name(state, victim)} loses its capital`;
        this.add({ t, kind: 'capital', text, players: [victim, taker].filter((x) => x > 0) });
        return;
      }
      case 'eliminated': {
        const victim = P.find((p) => isNation(p) && e.message.startsWith(`${p.name} has been eliminated`));
        if (!victim) return;
        const by = / by (.+?)(?: \(|$)/.exec(e.message.slice(victim.name.length))?.[1] ?? '';
        const killer = by ? P.find((p) => isNation(p) && p.name === by) : undefined;
        let text: string;
        if (victim.id === me) text = by ? `You are eliminated by ${by}` : 'You are eliminated';
        else if (killer && killer.id === me) text = `You eliminate ${victim.name}`;
        else text = by ? `${victim.name} is eliminated by ${by}` : `${victim.name} is eliminated`;
        this.add({ t, kind: 'eliminated', text, players: [victim.id, killer?.id ?? 0].filter((x) => x > 0) });
        return;
      }
      case 'buildingCaptured': {
        const [taker, loser = 0] = e.players;
        if (me <= 0 || (taker !== me && loser !== me)) return;
        if (isNation(P[taker]) && isNation(P[loser])) this.onWar(state, taker, loser, me, t);
        if (!e.message.includes(`captured a ${BUILDINGS.city.name} of`)) return;
        if (taker === me) this.add({ t, kind: 'cityTaken', text: `You capture a city from ${this.name(state, loser)}`, players: [me, loser] });
        else this.add({ t, kind: 'cityLost', text: `${this.name(state, taker)} captures one of your cities`, players: [me, taker] });
        return;
      }
      case 'buildingLost': {
        const lost = `lost a ${BUILDINGS.city.name}`;
        if (me <= 0 || e.players[0] !== me || !(e.message.endsWith(lost) || e.message.includes(`${lost} `))) return;
        this.add({ t, kind: 'cityLost', text: 'You lose a city', players: [me] });
        return;
      }
      case 'allianceFormed': {
        if (e.message.includes('renewed')) return;
        const [a, b] = e.players;
        if (!isNation(P[a]) || !isNation(P[b])) return;
        const other = a === me ? b : b === me ? a : 0;
        const text = other ? `You ally with ${this.name(state, other)}` : `${this.name(state, a)} and ${this.name(state, b)} become allies`;
        this.add({ t, kind: 'alliance', text, players: [a, b] });
        return;
      }
      case 'nuke': {
        const victim = e.tile >= 0 ? state.map.owner[e.tile] : 0;
        const head = e.message.split(':')[0];
        const text = victim > 0 && victim === me ? `${head.replace(` on ${this.name(state, me)}`, '')} on you` : head;
        this.add({ t, kind: 'nuke', text, players: victim > 0 ? [victim] : [] });
        return;
      }
      default:
        return;
    }
  }

  /** New attacks between nations: wars (and the first contact); attacks that end after taking land: battles won. */
  private scanAttacks(state: GameState, me: number): void {
    const gen = ++this.gen;
    const P = state.players;
    const t = gameSeconds(state);
    for (const a of state.attacks) {
      let r = this.attacks.get(a.id);
      if (!r) {
        r = { attacker: a.attacker, target: a.target, tiles: a.tilesTaken, gen };
        this.attacks.set(a.id, r);
        if (isNation(P[a.attacker]) && isNation(P[a.target])) this.onWar(state, a.attacker, a.target, me, t);
      }
      r.tiles = a.tilesTaken;
      r.gen = gen;
    }
    for (const [id, r] of this.attacks) {
      if (r.gen === gen) continue;
      this.attacks.delete(id);
      if (r.target > 0 && r.tiles >= BATTLE_MIN_TILES && r.attacker < this.battlesWon.length && isNation(P[r.target])) this.battlesWon[r.attacker]++;
    }
  }

  private onWar(state: GameState, a: number, b: number, me: number, t: number): void {
    const key = Math.min(a, b) * 65536 + Math.max(a, b);
    if (this.wars.has(key)) return;
    this.wars.add(key);
    const mine = me > 0 && (a === me || b === me);
    if (!mine && (me > 0 || this.contact)) return;
    const text = a === me ? `You attack ${this.name(state, b)}` : b === me ? `${this.name(state, a)} attacks you` : `${this.name(state, a)} attacks ${this.name(state, b)}`;
    if (!this.contact) {
      this.contact = true;
      this.add({ t, kind: 'contact', text: me > 0 ? `First contact: ${text}` : `First war: ${text}`, players: [a, b] });
    } else this.add({ t, kind: 'war', text: `War: ${text}`, players: [a, b] });
  }

  private scanUnits(state: GameState): void {
    let max = this.maxUnitId;
    for (const u of state.units) {
      if (u.id <= this.maxUnitId) continue;
      if (u.id > max) max = u.id;
      if (BUILT_UNITS.has(u.type) && u.owner > 0 && u.owner < this.unitsBuilt.length) this.unitsBuilt[u.owner]++;
    }
    this.maxUnitId = max;
  }
}
