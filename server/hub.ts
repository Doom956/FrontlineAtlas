// Connections, lobbies and public lobby scheduling. One Hub per server process.

import { randomInt } from 'node:crypto';
import WebSocket from 'ws';
import type { RawData } from 'ws';
import { activeModifiers, landEstimate, mapLabel, mergeSetup, modifierSummary, MULTIPLAYER_NATIONS, rollModifiers, sizeClassForLand } from '../src/sim/setup';
import type { MapChoice, MapSize } from '../src/sim/types';
import { CloseCode, DEFAULT_LOBBY_SETTINGS, LOBBY_CODE_ALPHABET, LOBBY_CODE_LENGTH, PROTOCOL_VERSION } from '../src/net/protocol';
import { ADMIN_ROOMS_MAX, ADMIN_SP_MAX, NOTICE_SECONDS, SP_MESSAGE_MAX_BYTES, SP_STATUS_MIN_MS, SP_STREAM_MAX_BYTES } from '../src/net/protocol';
import type { AdminClientMessage, AdminSpInfo, ClientMessage, ErrorCode, LobbyKind, LobbySettings, LobbySummary, RGB, ServerMessage } from '../src/net/protocol';
import type { ServerOptions } from './options';
import { Room } from './room';
import type { Member, RoomError, RoomHost, RoomSession } from './room';
import { parseClientMessage } from './validate';
import { AdminGate, AdminLimiter, SHOW_ALL_COST } from './admin';
import type { AdminPowerKind } from './admin';

/** Invalid messages tolerated per connection before it is closed. */
const MAX_INVALID = 200;
/** A single-player link that sends this many messages it may not send is closed. */
const SP_MAX_INVALID = 20;
/** Messages dropped in a row by the rate limit before the connection is closed. */
const MAX_FLOOD = 150;
const HASH_RATE = 20;
/**
 * A client that can't keep up (send buffer) is disconnected; it can reconnect and catch up. Catch-ups never get
 * near it: they are sent in chunks only while the buffer holds less than about 1 MB (Room.pumpCatchUp).
 */
const MAX_BUFFERED = 16 * 1024 * 1024;

// ------------------------------------------------------------------------------------------------ public lobbies

/** Map rotation for public games (never the same map twice in a row): generated maps and real-world maps. */
export const PUBLIC_ROTATION: readonly MapChoice[] = [
  { kind: 'generated', type: 'continents', size: 'medium' },
  { kind: 'world', id: 'europe' },
  { kind: 'generated', type: 'pangaea', size: 'small' },
  { kind: 'world', id: 'world' },
  { kind: 'generated', type: 'archipelago', size: 'large' },
  { kind: 'world', id: 'mediterranean' },
  { kind: 'generated', type: 'highlands', size: 'medium' },
  { kind: 'world', id: 'north-america' },
  { kind: 'generated', type: 'continents', size: 'small' },
  { kind: 'world', id: 'british-isles' },
];
export const PUBLIC_TEAM_COUNTS: readonly number[] = [2, 3, 2, 4];
/** Public lobby kinds the server keeps open (one of each). */
export const PUBLIC_KINDS: readonly LobbyKind[] = ['ffa', 'teams', 'special'];
/** Humans per public lobby and nations (humans + AI) per public game, by the map's size class (about ten nations). */
export const PUBLIC_MAX_PLAYERS: Record<MapSize, number> = { small: 8, medium: 10, large: 12, huge: 12 };
export const PUBLIC_NATIONS: Record<MapSize, number> = { small: 8, medium: MULTIPLAYER_NATIONS, large: 12, huge: 12 };

/** Size class of a lobby's map (by its land; compact maps count their quarter). */
export function lobbyMapClass(settings: Pick<LobbySettings, 'map' | 'modifiers'>): MapSize {
  if (settings.map.kind === 'generated' && !settings.modifiers.compactMap) return settings.map.size;
  return sizeClassForLand(landEstimate(settings.map, settings.modifiers.compactMap));
}

/** Nations (humans + AI) a public game on this map gets. */
export function publicNations(settings: Pick<LobbySettings, 'map' | 'modifiers'>): number {
  return PUBLIC_NATIONS[lobbyMapClass(settings)];
}

/** AI nations filling a public game: up to the map's nation count, a multiple of the team count in teams mode. */
export function publicFill(settings: LobbySettings, humans: number): LobbySettings {
  let ai = Math.max(1, publicNations(settings) - humans);
  if (settings.mode === 'teams') {
    const rest = (humans + ai) % settings.teamCount;
    if (rest) ai += settings.teamCount - rest;
  }
  return { ...settings, aiCount: Math.min(15, ai) };
}

// ------------------------------------------------------------------------------------------------ session

/**
 * A single-player game's link (protocol 19: spHello): never in a room, sends only spStatus and ping, receives only
 * the owner's screen-only messages. What the owner's list shows comes from its last spStatus.
 */
export interface SpLink {
  nation: string;
  map: string;
  minutes: number;
  landPct: number;
  /** when the last spStatus was kept (-Infinity = none yet) */
  statusAt: number;
  /** the owner session watching this game live (protocol 20, watch-on-demand), null = nobody */
  watcher: Session | null;
}

export class Session implements RoomSession {
  clientId = '';
  name = '';
  color: RGB = [0, 0, 0];
  build = '';
  room: Room | null = null;
  member: Member | null = null;
  lastSeen: number;
  lastPing: number;
  tokens: number;
  hashTokens = HASH_RATE * 2;
  lastRefill: number;
  invalid = 0;
  flood = 0;
  lastRateError = 0;
  /** fingerprint of the last lobby list sent ('' = send again) */
  listKey = '';
  /** owner powers budget (made on the first use by an admin session) */
  adminLimiter: AdminLimiter | null = null;
  /** a single-player link (spHello) instead of a player session (hello) */
  sp: SpLink | null = null;
  /** owner session: the single-player game (spId) it is watching live, null = none (protocol 20) */
  watchingSp: number | null = null;
  closed = false;

  constructor(
    readonly id: number,
    readonly ws: WebSocket,
    readonly ip: string,
    readonly connectedAt: number,
    burst: number,
  ) {
    this.lastSeen = connectedAt;
    this.lastPing = connectedAt;
    this.lastRefill = connectedAt;
    this.tokens = burst;
  }

  send(msg: ServerMessage): void {
    this.sendRaw(JSON.stringify(msg));
  }

  sendRaw(text: string): void {
    if (this.closed || this.ws.readyState !== WebSocket.OPEN) return;
    if (this.ws.bufferedAmount > MAX_BUFFERED) {
      this.ws.terminate();
      return;
    }
    this.ws.send(text);
  }

  buffered(): number {
    return this.ws.bufferedAmount;
  }

  close(code: number, reason: string): void {
    if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) this.ws.close(code, reason);
  }
}

// ------------------------------------------------------------------------------------------------ hub

export class Hub implements RoomHost {
  readonly opts: ServerOptions;
  readonly sessions = new Set<Session>();
  readonly rooms = new Map<string, Room>();
  private byClientId = new Map<string, Session>();
  private ipCounts = new Map<string, number>();
  /** single-player links (spHello), in connection order */
  readonly spLinks = new Set<Session>();
  /** last createLobby per address (cooldown) */
  private lastCreate = new Map<string, number>();
  private nextSessionId = 1;
  private rotation: Record<LobbyKind, number> = { ffa: 0, teams: 0, special: 0 };
  private sweepTimer: ReturnType<typeof setInterval>;
  /** owner console logins (ADMIN_CODE) */
  readonly admin: AdminGate;
  private stopped = false;

  constructor(opts: ServerOptions) {
    this.opts = opts;
    this.admin = new AdminGate(opts.adminCode, () => this.now());
    this.sweepTimer = setInterval(() => this.sweep(), opts.sweepMs);
    if (opts.publicLobbies) this.ensurePublicLobbies();
  }

  now(): number {
    return Date.now();
  }
  makeSeed(): number {
    return this.opts.fixedSeed ?? randomInt(1, 0x7fffffff);
  }
  isOwner(clientId: string): boolean {
    return this.admin.isAdmin(clientId);
  }

  // ---------------------------------------------------------------------------------------------- connections

  /** Whether one more connection from this address is allowed. */
  canAccept(ip: string): boolean {
    return !this.stopped && (this.ipCounts.get(ip) ?? 0) < this.opts.maxConnectionsPerIp;
  }

  addConnection(ws: WebSocket, ip: string): Session {
    const now = this.now();
    const s = new Session(this.nextSessionId++, ws, ip, now, this.opts.messagesPerSecond * 2);
    this.sessions.add(s);
    this.ipCounts.set(ip, (this.ipCounts.get(ip) ?? 0) + 1);
    ws.on('message', (data: RawData, isBinary: boolean) => this.onMessage(s, data, isBinary));
    ws.on('pong', () => {
      s.lastSeen = this.now();
    });
    ws.on('close', () => this.dropSession(s));
    ws.on('error', () => this.dropSession(s));
    return s;
  }

  private dropSession(s: Session): void {
    if (s.closed) return;
    s.closed = true;
    this.sessions.delete(s);
    const n = (this.ipCounts.get(s.ip) ?? 1) - 1;
    if (n > 0) this.ipCounts.set(s.ip, n);
    else this.ipCounts.delete(s.ip);
    // watch-on-demand (protocol 20): tell the other side when the watched game or the owner drops
    if (s.sp?.watcher) this.stopWatching(s, 'The game disconnected', false);
    if (s.watchingSp !== null) {
      const link = this.spLink(s.watchingSp);
      if (link) this.stopWatching(link, 'stopped');
      s.watchingSp = null;
    }
    this.spLinks.delete(s);
    if (s.clientId && this.byClientId.get(s.clientId) === s) this.byClientId.delete(s.clientId);
    if (s.room) s.room.disconnected(s);
  }

  private error(s: Session, code: ErrorCode, message: string): void {
    s.send({ type: 'error', code, message });
  }

  private invalidMessage(s: Session, why: string): void {
    s.invalid++;
    this.error(s, 'badMessage', why);
    if (s.invalid > (s.sp ? SP_MAX_INVALID : MAX_INVALID)) s.close(CloseCode.BadClient, 'too many invalid messages');
  }

  private refill(s: Session, now: number): void {
    const dt = Math.max(0, now - s.lastRefill) / 1000;
    s.lastRefill = now;
    s.tokens = Math.min(this.opts.messagesPerSecond * 2, s.tokens + dt * this.opts.messagesPerSecond);
    s.hashTokens = Math.min(HASH_RATE * 2, s.hashTokens + dt * HASH_RATE);
  }

  private onMessage(s: Session, data: RawData, isBinary: boolean): void {
    if (s.closed) return;
    const now = this.now();
    s.lastSeen = now;
    this.refill(s, now);
    if (isBinary) {
      this.invalidMessage(s, 'binary frames are not supported');
      return;
    }
    const text = Buffer.isBuffer(data)
      ? data.toString('utf8')
      : Array.isArray(data)
        ? Buffer.concat(data).toString('utf8')
        : Buffer.from(data).toString('utf8');
    if (s.sp && text.length > (s.sp.watcher ? SP_STREAM_MAX_BYTES : SP_MESSAGE_MAX_BYTES)) {
      this.invalidMessage(s, 'message too long');
      return;
    }
    const r = parseClientMessage(text);
    if (!r.ok) {
      this.invalidMessage(s, r.error);
      return;
    }
    const msg = r.value;
    if (msg.type === 'hash') {
      // Hashes have their own budget and are dropped silently (catching-up clients may send many).
      if (s.hashTokens < 1) return;
      s.hashTokens--;
    } else {
      if (s.tokens < 1) {
        s.flood++;
        if (s.flood > MAX_FLOOD) s.close(CloseCode.RateLimit, 'message flood');
        else if (now - s.lastRateError > 1000) {
          s.lastRateError = now;
          this.error(s, 'rateLimit', 'Too many messages: some were dropped');
        }
        return;
      }
      s.tokens--;
      s.flood = 0;
    }
    try {
      this.handle(s, msg);
    } catch (e) {
      this.opts.log(`error handling ${msg.type}: ${(e as Error).stack ?? e}`);
      this.error(s, 'badMessage', 'Server error');
    }
  }

  private handle(s: Session, msg: ClientMessage): void {
    if (msg.type === 'ping') {
      s.send({ type: 'pong', t: msg.t ?? null, serverTime: this.now() });
      return;
    }
    if (s.sp) {
      // a single-player link says how its game goes and (while watched) streams its log; nothing else (no chat,
      // intents, lobbies or owner powers)
      if (msg.type === 'spStatus') this.spStatus(s, msg);
      else if (msg.type === 'spSetup' || msg.type === 'spLog') this.spStream(s, msg);
      else {
        s.invalid++;
        this.error(s, 'notAllowed', 'Not allowed');
        if (s.invalid > SP_MAX_INVALID) s.close(CloseCode.BadClient, 'not allowed');
      }
      return;
    }
    if (msg.type === 'spHello') {
      this.spHello(s, msg);
      return;
    }
    if (msg.type === 'spStatus') {
      this.error(s, 'notAllowed', 'Not allowed');
      return;
    }
    if (msg.type === 'hello') {
      this.hello(s, msg);
      return;
    }
    if (!s.clientId) {
      this.error(s, 'notReady', 'Send hello first');
      return;
    }
    const room = s.room;
    const member = s.member;
    const report = (e: RoomError): void => {
      if (e) this.error(s, e.code, e.message);
    };
    if (msg.type === 'adminAuth') {
      // Owner console: answer only this client; rate-limited tries get no answer at all.
      const r = this.admin.attempt(s.ip, s.clientId, msg.code);
      if (r !== 'ignored') s.send({ type: 'adminAuth', ok: r === 'ok' });
      if (r === 'ok') this.opts.log(`owner console unlocked by a session from ${s.ip}`);
      return;
    }
    switch (msg.type) {
      case 'adminRooms':
      case 'adminAnnounce':
      case 'adminNotice':
      case 'adminSpectacle':
      case 'adminMute':
      case 'adminKick':
      case 'adminWatch':
        this.adminPower(s, msg);
        return;
      case 'createLobby': {
        if (this.rooms.size >= this.opts.maxRooms) {
          this.error(s, 'serverFull', 'The server is full, try again later');
          return;
        }
        const now = this.now();
        if (now - (this.lastCreate.get(s.ip) ?? -Infinity) < this.opts.createLobbyCooldownMs) {
          this.error(s, 'rateLimit', 'Wait a moment before creating another lobby');
          return;
        }
        // Rooms this address created that still live, not counting the one it is about to leave.
        const own = [...this.rooms.values()].filter((r) => r !== room && !r.closed && r.phase !== 'over' && r.creatorIp === s.ip).length;
        if (own >= this.opts.maxRoomsPerIp) {
          this.error(s, 'rateLimit', `At most ${this.opts.maxRoomsPerIp} open lobbies or games per address: leave one first`);
          return;
        }
        const settings: LobbySettings = mergeSetup(DEFAULT_LOBBY_SETTINGS, msg.settings ?? {});
        if (settings.maxPlayers > this.opts.maxPlayersPerLobby) {
          this.error(s, 'badMessage', `At most ${this.opts.maxPlayersPerLobby} players`);
          return;
        }
        if (room) room.leave(s);
        this.lastCreate.set(s.ip, now);
        const r = this.createRoom(false, settings);
        r.creatorIp = s.ip;
        report(r.join(s, false));
        return;
      }
      case 'joinLobby': {
        const target = this.rooms.get(msg.code);
        if (!target || target.closed) {
          this.error(s, 'notFound', 'No lobby with that code');
          return;
        }
        if (room === target && member) {
          // Already in it: no second gameStart + catch-up (that cost the whole history each time), only the lobby state.
          target.refresh(member);
          return;
        }
        if (room) room.leave(s);
        report(target.join(s, msg.spectate === true, msg.haveTurns ?? 0));
        return;
      }
      case 'leaveLobby':
        if (!room) this.error(s, 'notInLobby', 'You are not in a lobby');
        else room.leave(s);
        return;
      default:
        break;
    }
    if (!room || !member) {
      // hashes and game-over reports still in flight after leaving or being removed: nothing to say about them
      if (msg.type === 'hash' || msg.type === 'gameOver') return;
      this.error(s, 'notInLobby', 'You are not in a lobby');
      return;
    }
    switch (msg.type) {
      case 'updateLobbySettings':
        report(room.updateSettings(member, msg.settings));
        return;
      case 'setTeam':
        report(room.setTeam(member, msg.team));
        return;
      case 'kick':
        report(room.kick(member, msg.memberId));
        return;
      case 'startGame':
        report(room.requestStart(member));
        return;
      case 'intent':
        report(room.intent(member, msg.action, this.admin.isAdmin(s.clientId)));
        return;
      case 'hash':
        report(room.hash(member, msg.turn, msg.hash));
        return;
      case 'gameOver':
        report(room.reportGameOver(member, msg.turn, msg.winner));
        return;
      case 'setPause':
        report(room.setPause(member, msg.paused));
        return;
      case 'chat':
        room.chat(member, msg);
        return;
    }
  }

  // ---------------------------------------------------------------------------------------------- owner powers

  /**
   * Owner powers: only from a session that proved the code (else the same plain 'notAllowed' as an admin intent),
   * within their own rate limit; every answer is an `adminAck` to the sender alone. Nothing here touches a game's
   * state: announcements, notices and effects are plain messages, mute and kick are room bookkeeping.
   */
  private adminPower(s: Session, msg: AdminClientMessage): void {
    if (!this.admin.isAdmin(s.clientId)) {
      this.error(s, 'notAllowed', 'Not allowed');
      return;
    }
    const kind: AdminPowerKind = msg.type === 'adminRooms' || msg.type === 'adminWatch' ? 'list' : msg.type === 'adminMute' || msg.type === 'adminKick' ? 'moderate' : 'show';
    const wide = (msg.type === 'adminAnnounce' || msg.type === 'adminSpectacle') && (msg.scope === 'all' || (msg.scope === 'sp' && msg.spId === undefined));
    s.adminLimiter ??= new AdminLimiter(() => this.now());
    if (!s.adminLimiter.take(kind, wide ? SHOW_ALL_COST : 1)) {
      this.error(s, 'rateLimit', 'Wait a moment before sending that again');
      return;
    }
    const ack = (ok: boolean, message: string, reached?: number): void => {
      const a: ServerMessage = { type: 'adminAck', what: msg.type, ok, message };
      if (reached !== undefined) a.reached = reached;
      s.send(a);
    };
    if (msg.type === 'adminWatch') {
      this.adminWatch(s, msg.spId, msg.on);
      return;
    }
    if (msg.type === 'adminRooms') {
      const now = this.now();
      const all = [...this.rooms.values()].filter((r) => !r.closed);
      const order = { running: 0, lobby: 1, over: 2 } as const;
      all.sort((a, b) => order[a.phase] - order[b.phase] || b.connectedPlayers() - a.connectedPlayers() || a.code.localeCompare(b.code));
      const sp = [...this.spLinks].filter((x) => !x.closed && x.sp);
      sp.sort((a, b) => b.sp!.minutes - a.sp!.minutes || a.id - b.id);
      s.send({
        type: 'adminRooms',
        serverTime: now,
        rooms: all.slice(0, ADMIN_ROOMS_MAX).map((r) => r.adminInfo(now)),
        total: all.length,
        sp: sp.slice(0, ADMIN_SP_MAX).map((x) => this.spInfo(x, now)),
        spTotal: sp.length,
      });
      return;
    }
    if ((msg.type === 'adminAnnounce' || msg.type === 'adminSpectacle') && msg.scope === 'sp') {
      // single-player games: the one spId, or all of them (screen only, like everything here)
      const out: ServerMessage =
        msg.type === 'adminAnnounce'
          ? { type: 'announcement', title: msg.title, text: msg.text, style: msg.style, seconds: msg.seconds }
          : this.spectacleMsg(msg, '');
      if (msg.spId !== undefined) {
        const x = this.spLink(msg.spId);
        if (x) x.send(out);
        ack(!!x, x ? 'Sent' : 'That single-player game is not connected', x ? 1 : 0);
        return;
      }
      const text = JSON.stringify(out);
      let n = 0;
      for (const x of this.spLinks) {
        if (x.closed) continue;
        x.sendRaw(text);
        n++;
      }
      this.opts.log(`owner ${msg.type === 'adminAnnounce' ? 'announcement' : `effect ${msg.kind}`} to every single-player game (${n})`);
      ack(true, `Sent to ${n} single-player ${n === 1 ? 'game' : 'games'}`, n);
      return;
    }
    if (msg.type === 'adminNotice' && 'spId' in msg) {
      const x = this.spLink(msg.spId);
      if (x) x.send({ type: 'notice', text: msg.text, style: msg.style, seconds: NOTICE_SECONDS });
      ack(!!x, x ? 'Sent' : 'That single-player game is not connected', x ? 1 : 0);
      return;
    }
    if (wide) {
      // every session that said hello (in a game, in a lobby or on the lobby list) and every single-player link
      const out: ServerMessage =
        msg.type === 'adminAnnounce'
          ? { type: 'announcement', title: msg.title, text: msg.text, style: msg.style, seconds: msg.seconds }
          : this.spectacleMsg(msg as Extract<AdminClientMessage, { type: 'adminSpectacle' }>, '');
      const text = JSON.stringify(out);
      let n = 0;
      for (const x of this.sessions) {
        if ((!x.clientId && !x.sp) || x.closed) continue;
        x.sendRaw(text);
        n++;
      }
      this.opts.log(`owner ${msg.type === 'adminAnnounce' ? 'announcement' : `effect ${(msg as { kind: string }).kind}`} to every session (${n})`);
      ack(true, `Sent to ${n} ${n === 1 ? 'screen' : 'screens'}`, n);
      return;
    }
    const room = msg.code ? this.rooms.get(msg.code) : s.room;
    if (!room || room.closed) {
      ack(false, msg.code ? 'No game with that code' : 'You are not in a game: pick one in Games');
      return;
    }
    switch (msg.type) {
      case 'adminAnnounce': {
        const n = room.broadcastAll({ type: 'announcement', title: msg.title, text: msg.text, style: msg.style, seconds: msg.seconds });
        ack(true, `Sent to ${n} in ${room.code}`, n);
        return;
      }
      case 'adminSpectacle': {
        if (msg.memberId !== undefined) {
          // one player of the room (a prank for one, a ring only they see)
          const ok = room.sendTo(msg.memberId, this.spectacleMsg(msg, room.code));
          ack(ok, ok ? 'Sent' : 'That player is not connected', ok ? 1 : 0);
          return;
        }
        const n = room.broadcastAll(this.spectacleMsg(msg, room.code));
        ack(true, `Sent to ${n} in ${room.code}`, n);
        return;
      }
      case 'adminNotice': {
        if ('spId' in msg) return; // handled above
        const ok = room.sendTo(msg.memberId, { type: 'notice', text: msg.text, style: msg.style, seconds: NOTICE_SECONDS });
        ack(ok, ok ? 'Sent' : 'That player is not connected');
        return;
      }
      case 'adminMute': {
        const e = room.muteMember(msg.memberId, msg.minutes);
        ack(!e, e ? e.message : msg.minutes > 0 ? `Muted for ${msg.minutes} min` : 'Mute lifted');
        return;
      }
      case 'adminKick': {
        const e = room.removeByOwner(msg.memberId, s.clientId);
        if (!e) this.opts.log(`game ${room.code}: member ${msg.memberId} removed by the owner`);
        ack(!e, e ? e.message : 'Removed');
        return;
      }
    }
  }

  // ---------------------------------------------------------------------------------------------- single player

  /** A single-player link by its id, null when it is gone. */
  private spLink(spId: number): Session | null {
    for (const x of this.spLinks) if (x.id === spId && !x.closed) return x;
    return null;
  }

  private spInfo(x: Session, now: number): AdminSpInfo {
    const sp = x.sp!;
    return { spId: x.id, nation: sp.nation, map: sp.map, minutes: sp.minutes, landPct: sp.landPct, linkedMinutes: Math.max(0, Math.floor((now - x.connectedAt) / 60_000)) };
  }

  /** spHello: the socket becomes a single-player link (once, before any hello), within the link limits. */
  private spHello(s: Session, msg: Extract<ClientMessage, { type: 'spHello' }>): void {
    if (s.clientId) {
      this.error(s, 'notAllowed', 'Not allowed');
      return;
    }
    if (msg.protocol !== PROTOCOL_VERSION) {
      this.error(s, 'version', 'The server runs another version of the game');
      s.close(CloseCode.Version, 'protocol version');
      return;
    }
    let fromIp = 0;
    for (const x of this.spLinks) if (x.ip === s.ip) fromIp++;
    if (this.spLinks.size >= this.opts.maxSpSessions || fromIp >= this.opts.maxSpSessionsPerIp) {
      s.close(CloseCode.TooManyConnections, 'too many single-player links');
      return;
    }
    s.sp = { nation: '', map: '', minutes: 0, landPct: 0, statusAt: -Infinity, watcher: null };
    this.spLinks.add(s);
    s.send({ type: 'spWelcome', protocol: PROTOCOL_VERSION, spId: s.id });
  }

  /** spStatus: what the owner's list shows; one per SP_STATUS_MIN_MS is kept, the rest are dropped silently. */
  private spStatus(s: Session, msg: Extract<ClientMessage, { type: 'spStatus' }>): void {
    const sp = s.sp!;
    const now = this.now();
    if (now - sp.statusAt < SP_STATUS_MIN_MS) return;
    sp.statusAt = now;
    sp.nation = msg.nation;
    sp.map = mapLabel(msg.map);
    sp.minutes = msg.minutes;
    sp.landPct = msg.landPct;
  }

  /**
   * A watched single-player link streams its setup and log (protocol 20). One-way: the server only relays it to the
   * attached watcher, tagged with the link's spId; the watcher (the owner) rebuilds the game in its own sim. With no
   * watcher the frames are dropped silently (a slow unsubscribe), not an error.
   */
  private spStream(s: Session, msg: Extract<ClientMessage, { type: 'spSetup' | 'spLog' }>): void {
    const w = s.sp!.watcher;
    if (!w || w.closed || w.watchingSp !== s.id) return;
    if (msg.type === 'spSetup') w.send({ type: 'watchSetup', spId: s.id, settings: msg.settings });
    else w.send({ type: 'watchLog', spId: s.id, entries: msg.entries, tick: msg.tick, ...(msg.base ? { base: true } : {}), ...(msg.final ? { final: true } : {}) });
  }

  /**
   * Detaches the watcher from a single-player link. `tellLink` sends the link `spWatch {on:false}` so it stops
   * streaming; `tellWatcher` sends the watcher `watchEnd` (skipped when the owner itself asked to stop or switch).
   */
  private stopWatching(link: Session, reason: string, tellLink = true, tellWatcher = true): void {
    const w = link.sp?.watcher ?? null;
    if (link.sp) link.sp.watcher = null;
    if (tellLink && !link.closed) link.send({ type: 'spWatch', on: false });
    if (w && w.watchingSp === link.id) {
      w.watchingSp = null;
      if (tellWatcher && !w.closed) w.send({ type: 'watchEnd', spId: link.id, reason });
    }
  }

  /** Owner starts or stops watching one single-player game live (adminWatch). */
  private adminWatch(s: Session, spId: number, on: boolean): void {
    if (!on) {
      if (s.watchingSp === spId) {
        const link = this.spLink(spId);
        if (link) this.stopWatching(link, 'stopped', true, false);
        else s.watchingSp = null;
      }
      return;
    }
    // stop watching whatever this owner watched before (one at a time): the owner asked, so no watchEnd back to them
    if (s.watchingSp !== null && s.watchingSp !== spId) {
      const prev = this.spLink(s.watchingSp);
      if (prev) this.stopWatching(prev, 'stopped', true, false);
      else s.watchingSp = null;
    }
    const link = this.spLink(spId);
    if (!link || !link.sp) {
      s.send({ type: 'watchEnd', spId, reason: 'That single-player game is not connected' });
      return;
    }
    // one watcher per link: boot any previous watcher of this game (they are told plainly)
    if (link.sp.watcher && link.sp.watcher !== s) this.stopWatching(link, 'Someone else is watching this game', false);
    link.sp.watcher = s;
    s.watchingSp = spId;
    link.send({ type: 'spWatch', on: true });
    this.opts.log(`owner from ${s.ip} is watching single-player game ${spId}`);
  }

  private spectacleMsg(msg: Extract<AdminClientMessage, { type: 'adminSpectacle' }>, code: string): ServerMessage {
    const out: ServerMessage = { type: 'spectacle', kind: msg.kind };
    if (msg.tile !== undefined && code) {
      out.tile = msg.tile;
      out.code = code;
    }
    if (msg.label) out.label = msg.label;
    if (msg.seconds !== undefined) out.seconds = msg.seconds;
    if (msg.mode !== undefined) out.mode = msg.mode;
    return out;
  }

  private hello(s: Session, msg: Extract<ClientMessage, { type: 'hello' }>): void {
    if (s.clientId) {
      this.error(s, 'notAllowed', 'hello was already sent');
      return;
    }
    if (msg.protocol !== PROTOCOL_VERSION) {
      this.error(s, 'version', 'The server runs another version of the game: reload the page');
      s.close(CloseCode.Version, 'protocol version');
      return;
    }
    const old = this.byClientId.get(msg.clientId);
    if (old && old !== s) {
      // Same player on a new socket (refresh, second tab): the newest wins.
      if (old.room) old.room.disconnected(old);
      this.byClientId.delete(msg.clientId);
      old.send({ type: 'error', code: 'notAllowed', message: 'You connected from somewhere else' });
      old.close(CloseCode.Replaced, 'replaced');
    }
    s.clientId = msg.clientId;
    s.name = msg.name;
    s.color = msg.color;
    s.build = msg.build ?? '';
    this.byClientId.set(s.clientId, s);
    // The seat to resume: the room this client was attached to most recently, never one it left on purpose.
    let seat: Room | null = null;
    let seatAt = -Infinity;
    for (const r of this.rooms.values()) {
      const m = r.resumable(s.clientId);
      if (m && m.attachedAt > seatAt) {
        seat = r;
        seatAt = m.attachedAt;
      }
    }
    s.send({ type: 'welcome', protocol: PROTOCOL_VERSION, serverTime: this.now(), resumed: seat ? seat.code : null });
    if (seat) {
      const have = msg.resume && msg.resume.code === seat.code ? msg.resume.haveTurns : 0;
      const e = seat.join(s, false, have);
      if (e) this.error(s, e.code, e.message);
    }
    if (!s.room) this.sendLobbyList(s);
  }

  // ---------------------------------------------------------------------------------------------- rooms

  private newCode(): string {
    for (;;) {
      let c = '';
      for (let i = 0; i < LOBBY_CODE_LENGTH; i++) c += LOBBY_CODE_ALPHABET[randomInt(LOBBY_CODE_ALPHABET.length)];
      if (!this.rooms.has(c)) return c;
    }
  }

  createRoom(isPublic: boolean, settings: LobbySettings): Room {
    const room = new Room(this, this.newCode(), isPublic, settings);
    this.rooms.set(room.code, room);
    return room;
  }

  /**
   * Keeps one public lobby of each kind open: FFA, Teams and Special (FFA with 1-3 random modifiers). Maps rotate
   * through PUBLIC_ROTATION (each kind starts at a different place), team counts through PUBLIC_TEAM_COUNTS.
   */
  ensurePublicLobbies(): void {
    if (this.stopped) return;
    for (const kind of PUBLIC_KINDS) {
      let open = false;
      for (const r of this.rooms.values()) {
        if (r.isPublic && r.phase === 'lobby' && !r.closed && r.publicKind === kind) open = true;
      }
      if (open) continue;
      const k = this.rotation[kind]++;
      const offset = kind === 'teams' ? 3 : kind === 'special' ? 6 : 0;
      const map = PUBLIC_ROTATION[(k + offset) % PUBLIC_ROTATION.length];
      const base: LobbySettings = {
        ...DEFAULT_LOBBY_SETTINGS,
        modifiers: { ...DEFAULT_LOBBY_SETTINGS.modifiers },
        mode: kind === 'teams' ? 'teams' : 'ffa',
        teamCount: PUBLIC_TEAM_COUNTS[k % PUBLIC_TEAM_COUNTS.length],
        map: { ...map },
        maxPlayers: 0,
      };
      if (kind === 'special') {
        // the server may use Math.random: the rolled values (not the roll) go to every client in the settings
        base.modifiers = { ...base.modifiers, ...rollModifiers(1 + Math.floor(Math.random() * 3), Math.random) };
        base.preset = 'custom';
      }
      base.maxPlayers = Math.min(this.opts.maxPlayersPerLobby, PUBLIC_MAX_PLAYERS[lobbyMapClass(base)]);
      const room = this.createRoom(true, publicFill(base, 1));
      room.publicFill = publicFill;
      room.publicKind = kind;
    }
  }

  roomClosed(room: Room): void {
    if (this.rooms.get(room.code) === room) this.rooms.delete(room.code);
    if (room.isPublic) this.ensurePublicLobbies();
  }

  sessionLeftRoom(session: RoomSession): void {
    // The next sweep sends the lobby list (skipped if the session joins another lobby first).
    (session as Session).listKey = '';
  }

  roomChanged(room: Room): void {
    if (room.isPublic && room.phase !== 'lobby') this.ensurePublicLobbies();
  }

  publicLobbies(): LobbySummary[] {
    const out: LobbySummary[] = [];
    for (const r of this.rooms.values()) {
      if (!r.isPublic || r.phase !== 'lobby' || r.closed) continue;
      out.push({
        code: r.code,
        kind: r.publicKind ?? (r.settings.mode === 'teams' ? 'teams' : 'ffa'),
        mode: r.settings.mode,
        map: { ...r.settings.map },
        rules: modifierSummary(r.settings),
        chips: activeModifiers(r.settings)
          .filter((c) => c.id !== 'teams')
          .map((c) => ({ id: c.id, label: c.label, detail: c.detail })),
        teamCount: r.settings.teamCount,
        players: r.players.length,
        maxPlayers: r.settings.maxPlayers,
        startsAt: r.startsAt,
      });
    }
    return out;
  }

  private sendLobbyList(s: Session, lobbies = this.publicLobbies(), key = JSON.stringify(lobbies)): void {
    s.listKey = key;
    s.send({ type: 'lobbyList', serverTime: this.now(), lobbies });
  }

  // ---------------------------------------------------------------------------------------------- housekeeping

  sweep(): void {
    if (this.stopped) return;
    const now = this.now();
    const o = this.opts;
    for (const s of this.sessions) {
      if (!s.clientId && !s.sp && now - s.connectedAt > o.helloTimeoutMs) {
        s.close(CloseCode.BadClient, 'hello expected');
      } else if (now - s.lastSeen > o.idleTimeoutMs) {
        s.ws.terminate();
      } else if (now - s.lastPing > o.keepaliveMs) {
        s.lastPing = now;
        if (s.ws.readyState === WebSocket.OPEN) s.ws.ping();
      }
    }
    for (const room of [...this.rooms.values()]) room.sweep(now);
    for (const [ip, t] of this.lastCreate) if (now - t > o.createLobbyCooldownMs) this.lastCreate.delete(ip);
    this.admin.sweep();
    if (o.publicLobbies) this.ensurePublicLobbies();
    const lobbies = this.publicLobbies();
    const key = JSON.stringify(lobbies);
    for (const s of this.sessions) {
      if (s.clientId && !s.room && s.listKey !== key) this.sendLobbyList(s, lobbies, key);
    }
  }

  stats(): { sessions: number; rooms: number; games: number; players: number } {
    let games = 0;
    let players = 0;
    for (const r of this.rooms.values()) {
      if (r.phase === 'running') games++;
      players += r.connectedPlayers();
    }
    return { sessions: this.sessions.size, rooms: this.rooms.size, games, players };
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    clearInterval(this.sweepTimer);
    for (const r of [...this.rooms.values()]) {
      r.finish('abandoned', 0);
      r.close('');
    }
    for (const s of [...this.sessions]) s.close(CloseCode.Shutdown, 'server shutting down');
  }
}
