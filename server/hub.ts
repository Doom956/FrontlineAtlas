// Connections, lobbies and public lobby scheduling. One Hub per server process.

import { randomInt } from 'node:crypto';
import WebSocket from 'ws';
import type { RawData } from 'ws';
import type { MapSize, MapType } from '../src/sim/types';
import { CloseCode, DEFAULT_LOBBY_SETTINGS, LOBBY_CODE_ALPHABET, LOBBY_CODE_LENGTH, PROTOCOL_VERSION } from '../src/net/protocol';
import type { ClientMessage, ErrorCode, GameMode, LobbySettings, LobbySummary, RGB, ServerMessage } from '../src/net/protocol';
import type { ServerOptions } from './options';
import { Room } from './room';
import type { Member, RoomError, RoomHost, RoomSession } from './room';
import { parseClientMessage } from './validate';

/** Invalid messages tolerated per connection before it is closed. */
const MAX_INVALID = 200;
/** Messages dropped in a row by the rate limit before the connection is closed. */
const MAX_FLOOD = 150;
const HASH_RATE = 20;
/** A client that can't keep up (send buffer) is disconnected; it can reconnect and catch up. */
const MAX_BUFFERED = 16 * 1024 * 1024;

// ------------------------------------------------------------------------------------------------ public lobbies

/** Map rotation for public games (never the same map twice in a row). */
export const PUBLIC_ROTATION: readonly [MapType, MapSize][] = [
  ['continents', 'medium'],
  ['pangaea', 'small'],
  ['archipelago', 'large'],
  ['highlands', 'medium'],
  ['pangaea', 'large'],
  ['continents', 'small'],
  ['archipelago', 'medium'],
  ['highlands', 'large'],
  ['continents', 'large'],
  ['highlands', 'small'],
];
export const PUBLIC_TEAM_COUNTS: readonly number[] = [2, 3, 2, 4];
/** Humans per public lobby and nations (humans + AI) per public game, by map size. */
export const PUBLIC_MAX_PLAYERS: Record<MapSize, number> = { small: 8, medium: 12, large: 16, huge: 16 };
export const PUBLIC_NATIONS: Record<MapSize, number> = { small: 8, medium: 12, large: 16, huge: 16 };

/** AI nations filling a public game: up to the map's nation count, a multiple of the team count in teams mode. */
export function publicFill(settings: LobbySettings, humans: number): LobbySettings {
  let ai = Math.max(1, PUBLIC_NATIONS[settings.mapSize] - humans);
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
  private nextSessionId = 1;
  private rotation: Record<GameMode, number> = { ffa: 0, teams: 0 };
  private sweepTimer: ReturnType<typeof setInterval>;
  private stopped = false;

  constructor(opts: ServerOptions) {
    this.opts = opts;
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
    switch (msg.type) {
      case 'createLobby': {
        if (this.rooms.size >= this.opts.maxRooms) {
          this.error(s, 'serverFull', 'The server is full, try again later');
          return;
        }
        const settings: LobbySettings = { ...DEFAULT_LOBBY_SETTINGS, ...msg.settings };
        if (settings.maxPlayers > this.opts.maxPlayersPerLobby) {
          this.error(s, 'badMessage', `At most ${this.opts.maxPlayersPerLobby} players`);
          return;
        }
        if (room) room.leave(s);
        const r = this.createRoom(false, settings);
        report(r.join(s, false));
        return;
      }
      case 'joinLobby': {
        const target = this.rooms.get(msg.code);
        if (!target || target.closed) {
          this.error(s, 'notFound', 'No lobby with that code');
          return;
        }
        if (room === target) {
          report(target.join(s, msg.spectate === true));
          return;
        }
        if (room) room.leave(s);
        report(target.join(s, msg.spectate === true));
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
        report(room.intent(member, msg.action));
        return;
      case 'hash':
        report(room.hash(member, msg.turn, msg.hash));
        return;
      case 'gameOver':
        report(room.reportGameOver(member, msg.turn, msg.winner));
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
    let seat: Room | null = null;
    for (const r of this.rooms.values()) {
      if (!r.closed && r.phase !== 'over' && r.memberByClientId(s.clientId)) {
        seat = r;
        break;
      }
    }
    s.send({ type: 'welcome', protocol: PROTOCOL_VERSION, serverTime: this.now(), resumed: seat ? seat.code : null });
    if (seat) {
      const e = seat.join(s, false);
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

  /** Keeps one public lobby of each mode open. */
  ensurePublicLobbies(): void {
    if (this.stopped) return;
    for (const mode of ['ffa', 'teams'] as GameMode[]) {
      let open = false;
      for (const r of this.rooms.values()) {
        if (r.isPublic && r.phase === 'lobby' && !r.closed && r.settings.mode === mode) open = true;
      }
      if (open) continue;
      const k = this.rotation[mode]++;
      const [mapType, mapSize] = PUBLIC_ROTATION[(k + (mode === 'teams' ? 3 : 0)) % PUBLIC_ROTATION.length];
      const base: LobbySettings = {
        ...DEFAULT_LOBBY_SETTINGS,
        mode,
        teamCount: PUBLIC_TEAM_COUNTS[k % PUBLIC_TEAM_COUNTS.length],
        mapType,
        mapSize,
        maxPlayers: Math.min(this.opts.maxPlayersPerLobby, PUBLIC_MAX_PLAYERS[mapSize]),
      };
      const room = this.createRoom(true, publicFill(base, 1));
      room.publicFill = publicFill;
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
        mode: r.settings.mode,
        mapType: r.settings.mapType,
        mapSize: r.settings.mapSize,
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
