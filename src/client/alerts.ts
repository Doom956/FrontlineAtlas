// Alerts: the few big events a player must not miss (an attack on you, your capital in danger, a lost warship, a
// bomb on its way...). Each one names a spot on the map; the HUD shows it as a card (hud/alerts.ts) that jumps the
// camera there, and keeps the last ALERT_LOG of them in the Alerts drawer behind the bell button.
//
// No DOM here: what becomes an alert (alertFromEvent: sim events; AlertWatch: things the sim has no event for, read
// from the state), and the feed that merges repeats into one entry with a count and keeps a kind from flooding the
// screen (AlertFeed). Client only: reads plain state fields and blockadedPorts / portBlockadedBy (tests/hudReads.ts).
import { TICKS_PER_SECOND } from '../sim/config';
import { blockadedPorts, portBlockadedBy } from '../sim/naval2';
import type { GameEvent, GameState, Player } from '../sim/types';

export type AlertKind = 'capital' | 'war' | 'land' | 'incoming' | 'blockade' | 'ship' | 'tanks' | 'ally';
export type AlertTone = 'bad' | 'warn' | 'info';

export interface AlertSpec {
  kind: AlertKind;
  /** same key = the same story: a repeat adds to the count instead of a new card */
  key: string;
  text: string;
  /** where the camera goes (-1 = nowhere) */
  tile: number;
  /** icon override (default: the kind's) */
  icon?: string;
}

export interface AlertEntry extends AlertSpec {
  id: number;
  icon: string;
  tone: AlertTone;
  /** how many times it happened (shown as "x3" from 2 on) */
  count: number;
  /** real-time ms of the first and the latest occurrence */
  first: number;
  last: number;
  /** game tick of the latest occurrence (the log's clock) */
  tick: number;
}

interface KindRule {
  icon: string;
  tone: AlertTone;
  /** real-time ms: another story of this kind within the gap joins the last card instead of adding one */
  gapMs: number;
  /** the joined card's text (several stories of one kind) */
  group: string;
}

export const ALERT_RULES: Record<AlertKind, KindRule> = {
  capital: { icon: 'star', tone: 'bad', gapMs: 0, group: 'Your capital is in danger' },
  war: { icon: 'attack', tone: 'bad', gapMs: 6000, group: 'Several nations attack you' },
  land: { icon: 'down', tone: 'bad', gapMs: 0, group: 'You are losing land fast' },
  incoming: { icon: 'target', tone: 'bad', gapMs: 4000, group: 'Strikes on their way to your land' },
  blockade: { icon: 'anchor', tone: 'warn', gapMs: 6000, group: 'Your ports are blockaded' },
  ship: { icon: 'warship', tone: 'bad', gapMs: 4000, group: 'Ships sunk' },
  tanks: { icon: 'tank', tone: 'bad', gapMs: 4000, group: 'Tank divisions lost' },
  ally: { icon: 'diplomacy', tone: 'info', gapMs: 6000, group: 'Allies ask for your help' },
};

/** Entries the log keeps. */
export const ALERT_LOG = 20;
/** A repeat of the same story within this many ms (after its latest one) adds to its count. */
export const ALERT_MERGE_MS = 30_000;

// ------------------------------------------------------------------------------------------------ sim events

/**
 * The alert for a sim event that concerns `me`, or null (most events are not alerts: they stay in the Events drawer
 * and the usual toasts). Reads the sim's messages, which name players by their names.
 */
export function alertFromEvent(state: GameState, me: Player, e: GameEvent): AlertSpec | null {
  if (e.players.length && !e.players.includes(me.id)) return null;
  const n = me.name;
  const m = e.message;
  const after = (prefix: string): string | null => (m.startsWith(prefix) ? m.slice(prefix.length) : null);
  const ownFirst = e.players[0] === me.id;
  let r: string | null;
  switch (e.kind) {
    case 'underAttack': {
      if ((r = after(`${n} is under attack by `)) !== null) return { kind: 'war', key: `war:${r}`, text: `${r} attacks you`, tile: e.tile };
      const w = /^Watchtower: an enemy (bomber|transport|cargo plane)(?: \((\d+) (?:troops|paratroopers)\))? of (.+) is approaching your land$/.exec(m);
      if (w) {
        const [, what, count, by] = w;
        if (what === 'bomber') return { kind: 'incoming', key: `incoming:bomber:${by}`, text: `${by}'s bomber is heading for your land`, tile: e.tile, icon: 'bomb' };
        if (what === 'transport') return { kind: 'incoming', key: `incoming:landing:${by}`, text: `${by}'s landing is on its way: ${count ?? 'some'} troops`, tile: e.tile, icon: 'transport' };
        return { kind: 'incoming', key: `incoming:para:${by}`, text: `${by}'s paratroopers are on their way: ${count ?? 'some'}`, tile: e.tile, icon: 'paradrop' };
      }
      return null;
    }
    case 'missile': {
      // "<X> launched an atom bomb at <me>" (the impact report stays a toast)
      const l = / launched (an atom bomb|a rocket) at /.exec(m);
      if (!l || m.startsWith(`${n} launched`) || !m.endsWith(` at ${n}`)) return null;
      const by = m.slice(0, l.index);
      const atom = l[1] === 'an atom bomb';
      return { kind: 'incoming', key: `incoming:${atom ? 'atom' : 'rocket'}:${by}`, text: `${atom ? 'Atom bomb' : 'Rocket'} incoming from ${by}`, tile: e.tile, icon: atom ? 'atom' : 'rocket' };
    }
    case 'capitalLost': {
      if (!ownFirst || (r = after(`${n} lost their capital`)) === null) return null;
      return { kind: 'capital', key: 'capital:lost', text: `You lost your capital${r}`, tile: e.tile };
    }
    case 'unitLost': {
      if (!ownFirst) return null;
      if ((r = after(`${n} lost a `)) !== null) {
        if (/^tank division being built/.test(r)) return { kind: 'tanks', key: 'tanks:factory', text: 'A tank division was lost with its factory', tile: e.tile };
        const s = /^(.+) to (.+)'s warship$/.exec(r);
        if (!s) return null;
        const [, what, by] = s;
        const t = /^transport with (\d+) troops$/.exec(what);
        if (t) return { kind: 'ship', key: `ship:transport:${by}`, text: `${by} sank your transport: ${t[1]} troops lost`, tile: e.tile, icon: 'transport' };
        if (/trade ship/.test(what)) return null;
        return { kind: 'ship', key: `ship:${by}`, text: `${by} sank your ${what}`, tile: e.tile };
      }
      if ((r = after(`${n}'s warship hit a mine off `)) !== null) {
        return { kind: 'ship', key: 'ship:mine', text: `Your warship hit a mine off ${r.replace(/ and sank$/, '')} and sank`, tile: e.tile };
      }
      if ((r = after(`${n}'s tank division was `)) !== null) {
        if (r.startsWith('overrun')) return { kind: 'tanks', key: 'tanks:overrun', text: 'Your tank division was overrun', tile: e.tile };
        if (r.startsWith('stranded')) return { kind: 'tanks', key: 'tanks:stranded', text: 'Your tank division was stranded in the water', tile: e.tile };
      }
      return null;
    }
    case 'info': {
      if (!ownFirst) return null;
      const ask = /^(.+) asks you (to attack .+|for troops)$/.exec(m);
      if (!ask) return null;
      return { kind: 'ally', key: `ally:${ask[1]}`, text: m, tile: e.tile };
    }
    default:
      return null;
  }
}

/** True for an event alertFromEvent turns into a lost-ship alert (AlertWatch counts them against its own losses). */
export function isShipLossAlert(a: AlertSpec | null): boolean {
  return !!a && a.kind === 'ship' && a.icon !== 'transport';
}

// ------------------------------------------------------------------------------------------------ state watch

/** Capital alert: a nation attacking you holds land within this many tiles (square) of your capital. */
export const CAPITAL_RADIUS = 5;
/** ...said again at most every this many game seconds while it lasts. */
export const CAPITAL_REPEAT_S = 60;
/** Land alert: this many game seconds of history... */
export const LAND_WINDOW_S = 10;
/** ...and a loss of at least this many tiles and this share of your land within it. */
export const LAND_MIN_TILES = 30;
export const LAND_MIN_SHARE = 0.08;
/** ...then quiet for this many game seconds. */
export const LAND_QUIET_S = 20;

/**
 * Alerts the sim has no event for, found by comparing the state between looks (~5 times a second): your capital in
 * danger, land falling fast, a port newly blockaded, a warship gone without an event saying why. The first look only
 * takes stock. reset() starts over (a catch-up replay, a different player).
 */
export class AlertWatch {
  private seen = false;
  private capitalUntil = -1;
  private wasThreat = false;
  private land: number[] = []; // tick, tiles pairs
  private landQuietUntil = -1;
  private ports = new Set<number>();
  private ships = new Map<number, number>(); // unit id -> tile
  private shipEvents = 0;

  reset(): void {
    this.seen = false;
    this.capitalUntil = -1;
    this.wasThreat = false;
    this.land = [];
    this.landQuietUntil = -1;
    this.ports.clear();
    this.ships.clear();
    this.shipEvents = 0;
  }

  /** A lost-ship event was shown as an alert: the next look does not count that ship again. */
  noteShipEvent(): void {
    this.shipEvents++;
  }

  look(state: GameState, me: Player): AlertSpec[] {
    const out: AlertSpec[] = [];
    const first = !this.seen;
    this.seen = true;
    const tick = state.tick;
    if (state.phase !== 'playing' || !me.alive) {
      this.land = [];
      return out;
    }
    // capital: an attacker's land close to it (said once when it starts, again every minute while it lasts)
    const threat = capitalThreat(state, me);
    if (threat && (!this.wasThreat || tick >= this.capitalUntil) && !first) {
      out.push({ kind: 'capital', key: 'capital', text: 'Your capital is under attack', tile: me.capital });
      this.capitalUntil = tick + CAPITAL_REPEAT_S * TICKS_PER_SECOND;
    } else if (threat && first) this.capitalUntil = tick + CAPITAL_REPEAT_S * TICKS_PER_SECOND;
    this.wasThreat = threat;

    // land falling fast
    const l = this.land;
    l.push(tick, me.tiles);
    const from = tick - LAND_WINDOW_S * TICKS_PER_SECOND;
    let cut = 0;
    while (cut < l.length - 2 && l[cut] < from) cut += 2;
    if (cut) l.splice(0, cut);
    let peak = 0;
    for (let k = 1; k < l.length; k += 2) peak = Math.max(peak, l[k]);
    const lost = peak - me.tiles;
    if (tick >= this.landQuietUntil && lost >= LAND_MIN_TILES && lost >= peak * LAND_MIN_SHARE) {
      out.push({ kind: 'land', key: 'land', text: `You lost ${lost} tiles in ${LAND_WINDOW_S} s`, tile: landFocus(state, me) });
      this.landQuietUntil = tick + LAND_QUIET_S * TICKS_PER_SECOND;
      this.land = [tick, me.tiles];
    }

    // ports newly blockaded
    const now = new Set(blockadedPorts(state, me.id));
    for (const t of now) {
      if (this.ports.has(t) || first) continue;
      const by = state.players[portBlockadedBy(state, t)];
      out.push({ kind: 'blockade', key: `blockade:${by?.id ?? 0}`, text: by ? `${by.name} is blockading your port` : 'Your port is blockaded', tile: t });
    }
    this.ports = now;

    // warships gone with no event saying so (the events name who sank them; this catches the rest)
    const ships = new Map<number, number>();
    const w = state.map.width;
    for (const u of state.units) if (u.type === 'warship' && u.owner === me.id && u.hp > 0) ships.set(u.id, Math.round(u.y) * w + Math.round(u.x));
    if (!first) {
      for (const [id, t] of this.ships) {
        if (ships.has(id)) continue;
        if (this.shipEvents > 0) this.shipEvents--;
        else out.push({ kind: 'ship', key: 'ship:lost', text: 'You lost a warship', tile: t });
      }
    }
    this.shipEvents = 0;
    this.ships = ships;
    return out;
  }
}

/** True when a nation attacking `me` holds land within CAPITAL_RADIUS of its capital. */
export function capitalThreat(state: GameState, me: Player): boolean {
  if (me.capital < 0) return false;
  let foes: number[] | null = null;
  for (const a of state.attacks) {
    if (a.target !== me.id || a.attacker <= 0) continue;
    const t = a.troops;
    if (t.infantry + t.armor + t.artillery <= 0) continue;
    (foes ??= []).push(a.attacker);
  }
  if (!foes) return false;
  const { width: w, height: h, owner } = state.map;
  const cx = me.capital % w;
  const cy = (me.capital / w) | 0;
  for (let y = Math.max(0, cy - CAPITAL_RADIUS); y <= Math.min(h - 1, cy + CAPITAL_RADIUS); y++) {
    for (let x = Math.max(0, cx - CAPITAL_RADIUS); x <= Math.min(w - 1, cx + CAPITAL_RADIUS); x++) {
      const o = owner[y * w + x];
      if (o !== me.id && o > 0 && foes.includes(o)) return true;
    }
  }
  return false;
}

/** Where land is falling: the strongest attack on `me` (its anchor tile), else the capital. */
function landFocus(state: GameState, me: Player): number {
  let best = -1;
  let most = 0;
  for (const a of state.attacks) {
    if (a.target !== me.id) continue;
    const t = a.troops.infantry + a.troops.armor + a.troops.artillery;
    if (t > most && a.focusTile >= 0) {
      most = t;
      best = a.focusTile;
    }
  }
  return best >= 0 ? best : me.capital;
}

// ------------------------------------------------------------------------------------------------ feed

/**
 * The alerts so far: newest first, at most ALERT_LOG. A repeat of a story (same key, within ALERT_MERGE_MS of its last
 * time) and another story of a kind that just had one (within its gapMs) join that entry and raise its count; the
 * joined entry jumps to the newest spot. `unread` counts the entries with news since the log was last opened.
 */
export class AlertFeed {
  readonly log: AlertEntry[] = [];
  /** ids of entries with news not seen in the log yet */
  private fresh = new Set<number>();
  /** bumped on every change (the log page redraws when it moves) */
  version = 0;
  private nextId = 1;

  /** Adds an alert; returns its entry and whether it is new (false = it joined one). */
  push(spec: AlertSpec, now: number, tick: number): { entry: AlertEntry; fresh: boolean } {
    const rule = ALERT_RULES[spec.kind];
    let e = this.log.find((x) => x.key === spec.key && now - x.last < ALERT_MERGE_MS);
    let group = false;
    if (!e && rule.gapMs > 0) {
      const last = this.log.find((x) => x.kind === spec.kind);
      if (last && now - last.last < rule.gapMs) {
        e = last;
        group = true;
      }
    }
    this.version++;
    if (e) {
      this.fresh.add(e.id);
      e.count++;
      e.text = group ? rule.group : spec.text;
      if (group) e.key = `${spec.kind}:*`;
      if (spec.tile >= 0) e.tile = spec.tile;
      e.last = now;
      e.tick = tick;
      this.log.splice(this.log.indexOf(e), 1);
      this.log.unshift(e);
      return { entry: e, fresh: false };
    }
    const entry: AlertEntry = { ...spec, id: this.nextId++, icon: spec.icon ?? rule.icon, tone: rule.tone, count: 1, first: now, last: now, tick };
    this.log.unshift(entry);
    this.fresh.add(entry.id);
    while (this.log.length > ALERT_LOG) this.fresh.delete(this.log.pop()!.id);
    return { entry, fresh: true };
  }

  /** Entries with news not seen in the log yet (the bell's badge). */
  get unread(): number {
    return this.fresh.size;
  }

  /** True when this entry has news not seen in the log yet. */
  isUnread(id: number): boolean {
    return this.fresh.has(id);
  }

  markRead(): void {
    if (this.fresh.size) this.version++;
    this.fresh.clear();
  }

  clear(): void {
    this.log.length = 0;
    this.fresh.clear();
    this.version++;
  }
}

/** The bell's badge: "" (none), the count, or "9+". */
export function unreadBadge(n: number): string {
  return n <= 0 ? '' : n > 9 ? '9+' : String(n);
}
