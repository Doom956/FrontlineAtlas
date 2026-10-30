// Connections, lobbies and public lobby scheduling. One Hub per server process.

import { randomInt } from 'node:crypto';
import WebSocket from 'ws';
import type { RawData } from 'ws';
import { activeModifiers, landEstimate, mergeSetup, modifierSummary, MULTIPLAYER_NATIONS, rollModifiers, sizeClassForLand } from '../src/sim/setup';
import type { MapChoice, MapSize } from '../src/sim/types';
import { CloseCode, DEFAULT_LOBBY_SETTINGS, LOBBY_CODE_ALPHABET, LOBBY_CODE_LENGTH, PROTOCOL_VERSION } from '../src/net/protocol';
import type { ClientMessage, ErrorCode, LobbyKind, LobbySettings, LobbySummary, RGB, ServerMessage } from '../src/net/protocol';
import type { ServerOptions } from './options';
import { Room } from './room';
import type { Member, RoomError, RoomHost, RoomSession } from './room';
import { parseClientMessage } from './validate';
import { AdminGate } from './admin';

/** Invalid messages tolerated per connection before it is closed. */
const MAX_INVALID = 200;
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
    return randomInt(1, 0x7fffffff);
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
    if (s.clientId && this.byClientId.get(s.clientId) === s) this.byClientId.delete(s.clientId);
    if (s.room) s.room.disconnected(s);
  }

  private error(s: Session, code: ErrorCode, message: string): void {
    s.send({ type: 'error', code, message });
  }

  private invalidMessage(s: Session, why: string): void {
    s.invalid++;
    this.error(s, 'badMessage', why);
    if (s.invalid > MAX_INVALID) s.close(CloseCode.BadClient, 'too many invalid messages');
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
    }
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
      if (!s.clientId && now - s.connectedAt > o.helloTimeoutMs) {
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
