// One lobby and, after the start, its game: members, settings, the turn loop, hash votes and game-over votes.
// The server never runs the sim: it only orders intents into turns and compares the clients' hashes.

import type { Action, GameSettings } from '../src/sim/types';
import {
  HASH_INTERVAL_TURNS,
  MAX_INTENTS_PER_TURN,
  NAME_MAX_LENGTH,
  PLAYER_COLORS,
  TEAM_NAMES,
  isHashTurn,
} from '../src/net/protocol';
import type {
  ErrorCode,
  GameOverReason,
  GameStartMsg,
  LobbyPlayer,
  LobbySettings,
  LobbyStateMsg,
  PlayerSlot,
  RGB,
  ServerMessage,
  StampedIntent,
  TeamsInfo,
  Turn,
} from '../src/net/protocol';
import type { ServerOptions } from './options';

/** What a room needs from a connection (implemented by the hub's Session). */
export interface RoomSession {
  readonly clientId: string;
  readonly name: string;
  readonly color: RGB;
  readonly build: string;
  room: Room | null;
  member: Member | null;
  send(msg: ServerMessage): void;
  sendRaw(text: string): void;
}

/** What a room needs from the hub. */
export interface RoomHost {
  readonly opts: ServerOptions;
  /** the room is gone (all sessions were detached first) */
  roomClosed(room: Room): void;
  /** a session left the room (leave, kick, room closed): show it the lobby list again */
  sessionLeftRoom(session: RoomSession): void;
  /** public lobby list may have changed (player count, start) */
  roomChanged(room: Room): void;
  /** game seed (crypto random in production) */
  makeSeed(): number;
  now(): number;
}

export interface Member {
  memberId: number;
  clientId: string;
  name: string;
  color: RGB;
  /** chosen team (lobby), final team after the start; 0 = auto / none */
  team: number;
  spectator: boolean;
  session: RoomSession | null;
  /** 0 until the game starts, and for spectators */
  playerId: number;
  disconnectedAt: number | null;
  intentsThisTurn: number;
  rateWarned: boolean;
  desynced: boolean;
}

export type RoomPhase = 'lobby' | 'running' | 'over';

export type RoomError = { code: ErrorCode; message: string } | null;
const err = (code: ErrorCode, message: string): RoomError => ({ code, message });

interface HashDecision {
  hash: number | null;
  agreeing: number;
  total: number;
}

/** Keep at most this many decided hash turns (late reports for older turns are ignored). */
const MAX_DECIDED = 2000;

// ------------------------------------------------------------------------------------------------ pure helpers

/**
 * Final teams: humans keep a valid chosen team, 'auto' humans go to the smallest team, then every AI nation goes
 * to the team with the fewest members (ties: lowest team). Returns byPlayer[playerId] for ids 0..H+aiCount.
 */
export function assignTeams(chosen: number[], aiCount: number, teamCount: number): number[] {
  const size = new Array<number>(teamCount + 1).fill(0);
  const byPlayer = [0];
  const smallest = (): number => {
    let best = 1;
    for (let t = 2; t <= teamCount; t++) if (size[t] < size[best]) best = t;
    return best;
  };
  const humans = chosen.map((t) => (Number.isInteger(t) && t >= 1 && t <= teamCount ? t : 0));
  for (const t of humans) if (t > 0) size[t]++;
  for (const t of humans) {
    if (t > 0) byPlayer.push(t);
    else {
      const s = smallest();
      size[s]++;
      byPlayer.push(s);
    }
  }
  for (let k = 0; k < aiCount; k++) {
    const s = smallest();
    size[s]++;
    byPlayer.push(s);
  }
  return byPlayer;
}

function colorDist(a: RGB, b: RGB): number {
  return Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);
}

/** Humans in seat order; a colour too close to an earlier player's is replaced by a free palette colour. */
export function resolveColors(colors: RGB[]): RGB[] {
  const out: RGB[] = [];
  for (const c of colors) {
    if (out.every((o) => colorDist(o, c) > 60)) {
      out.push(c);
      continue;
    }
    const free = PLAYER_COLORS.find((p) => out.every((o) => colorDist(o, p) > 60));
    out.push(free ? ([...free] as RGB) : c);
  }
  return out;
}

function uniqueName(name: string, taken: string[]): string {
  if (!taken.includes(name)) return name;
  for (let k = 2; k < 100; k++) {
    const suffix = ` ${k}`;
    const n = name.slice(0, NAME_MAX_LENGTH - suffix.length) + suffix;
    if (!taken.includes(n)) return n;
  }
  return name;
}

// ------------------------------------------------------------------------------------------------ room

export class Room {
  readonly code: string;
  readonly isPublic: boolean;
  settings: LobbySettings;
  phase: RoomPhase = 'lobby';
  members: Member[] = [];
  hostMemberId = -1;
  startsAt: number | null = null;
  /** client build of this room (first member that sent one); '' = unknown */
  build = '';
  readonly createdAt: number;
  /** for public lobbies: called before the start to fill in the AI count etc. */
  publicFill: ((settings: LobbySettings, humans: number) => LobbySettings) | null = null;

  private readonly host: RoomHost;
  private nextMemberId = 1;
  private kicked = new Set<string>();

  // game
  private startInfo: Omit<GameStartMsg, 'yourPlayerId' | 'turnsPlayed'> | null = null;
  readonly turns: Turn[] = [];
  private pending: StampedIntent[] = [];
  private loopStart = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private hashes = new Map<number, Map<number, number>>();
  private decided = new Map<number, HashDecision>();
  private overVotes = new Map<number, number>();
  startedAt = 0;
  private emptySince: number | null = null;
  private overAt = 0;
  winner = 0;
  closed = false;

  constructor(host: RoomHost, code: string, isPublic: boolean, settings: LobbySettings) {
    this.host = host;
    this.code = code;
    this.isPublic = isPublic;
    this.settings = { ...settings };
    this.createdAt = host.now();
  }

  // ---------------------------------------------------------------------------------------------- queries

  get players(): Member[] {
    return this.members.filter((m) => !m.spectator);
  }
  get spectators(): Member[] {
    return this.members.filter((m) => m.spectator);
  }
  memberByClientId(clientId: string): Member | undefined {
    return this.members.find((m) => m.clientId === clientId);
  }
  /** Seconds since start, players connected etc. for /health and logs. */
  connectedPlayers(): number {
    return this.players.filter((m) => m.session).length;
  }

  // ---------------------------------------------------------------------------------------------- membership

  /** A session joins (or rejoins with its clientId). */
  join(session: RoomSession, spectate: boolean): RoomError {
    if (this.closed) return err('notFound', 'No lobby with that code');
    if (this.phase === 'over') return err('started', 'That game is over');
    const existing = this.memberByClientId(session.clientId);
    if (existing) {
      this.attach(existing, session);
      return null;
    }
    if (this.kicked.has(session.clientId)) return err('kicked', 'You were removed from this lobby');
    if (this.build && session.build && this.build !== session.build) {
      return err('version', 'This lobby runs a different version of the game: reload the page');
    }
    const asSpectator = spectate || this.phase === 'running';
    if (!asSpectator && this.players.length >= this.settings.maxPlayers) return err('full', 'The lobby is full');
    if (this.members.length >= this.settings.maxPlayers + 64) return err('full', 'Too many spectators');

    const m: Member = {
      memberId: this.nextMemberId++,
      clientId: session.clientId,
      name: uniqueName(session.name, this.members.map((x) => x.name)),
      color: session.color,
      team: 0,
      spectator: asSpectator,
      session: null,
      playerId: 0,
      disconnectedAt: null,
      intentsThisTurn: 0,
      rateWarned: false,
      desynced: false,
    };
    this.members.push(m);
    if (!this.build && session.build) this.build = session.build;
    if (!this.isPublic && this.hostMemberId < 0 && !m.spectator) this.hostMemberId = m.memberId;
    const publicPlayer = this.phase === 'lobby' && this.isPublic && !m.spectator;
    if (publicPlayer) {
      if (this.startsAt === null) this.startsAt = this.host.now() + this.host.opts.publicStartMs;
      this.refreshPublicSettings();
    }
    this.attach(m, session);
    if (publicPlayer && this.players.length >= this.settings.maxPlayers) this.startGame();
    this.host.roomChanged(this);
    return null;
  }

  private attach(m: Member, session: RoomSession): void {
    if (m.session && m.session !== session) {
      const old = m.session;
      old.room = null;
      old.member = null;
    }
    m.session = session;
    m.disconnectedAt = null;
    session.room = this;
    session.member = m;
    if (this.phase === 'lobby') {
      this.broadcastLobby();
    } else if (this.phase === 'running') {
      this.sendGameStart(m);
      this.broadcastPresence();
    }
  }

  /** The socket closed (the seat stays: reconnect with the same clientId). */
  disconnected(session: RoomSession): void {
    const m = session.member;
    session.room = null;
    session.member = null;
    if (!m || m.session !== session) return;
    m.session = null;
    m.disconnectedAt = this.host.now();
    if (this.phase === 'lobby') {
      if (m.spectator) this.removeMember(m);
      else this.broadcastLobby();
    } else if (this.phase === 'running') {
      if (m.spectator) this.removeMember(m);
      else this.broadcastPresence();
    }
  }

  /** leaveLobby: before the start the place is given up; in a game the seat stays (rejoin by code). */
  leave(session: RoomSession): void {
    const m = session.member;
    session.room = null;
    session.member = null;
    if (!m || m.session !== session) return;
    m.session = null;
    m.disconnectedAt = this.host.now();
    if (this.phase === 'lobby' || m.spectator) this.removeMember(m);
    else if (this.phase === 'running') this.broadcastPresence();
    this.host.sessionLeftRoom(session);
  }

  private removeMember(m: Member): void {
    const i = this.members.indexOf(m);
    if (i < 0) return;
    this.members.splice(i, 1);
    if (m.session) {
      const s = m.session;
      m.session = null;
      s.room = null;
      s.member = null;
      this.host.sessionLeftRoom(s);
    }
    if (this.phase !== 'lobby') {
      if (this.phase === 'running') this.broadcastPresence();
      return;
    }
    if (!this.isPublic && m.memberId === this.hostMemberId) {
      const next = this.players[0];
      this.hostMemberId = next ? next.memberId : -1;
    }
    if (this.isPublic) {
      if (this.players.length === 0) this.startsAt = null;
      this.refreshPublicSettings();
    } else if (this.players.length === 0) {
      this.close('The lobby was closed');
      return;
    }
    this.broadcastLobby();
    this.host.roomChanged(this);
  }

  // ---------------------------------------------------------------------------------------------- host controls

  updateSettings(m: Member, patch: Partial<LobbySettings>): RoomError {
    if (this.isPublic) return err('notAllowed', 'Public lobby settings are fixed');
    if (m.memberId !== this.hostMemberId) return err('notHost', 'Only the host can change the settings');
    if (this.phase !== 'lobby') return err('started', 'The game has already started');
    const next = { ...this.settings, ...patch };
    if (next.maxPlayers > this.host.opts.maxPlayersPerLobby) {
      return err('badMessage', `At most ${this.host.opts.maxPlayersPerLobby} players`);
    }
    if (next.maxPlayers < this.players.length) return err('badMessage', 'More players are already in the lobby');
    this.settings = next;
    for (const x of this.members) {
      if (next.mode !== 'teams' || x.team > next.teamCount) x.team = 0;
    }
    this.broadcastLobby();
    return null;
  }

  setTeam(m: Member, team: number): RoomError {
    if (this.phase !== 'lobby') return err('started', 'The game has already started');
    if (this.settings.mode !== 'teams') return err('notAllowed', 'This is not a teams game');
    if (m.spectator) return err('notAllowed', 'Spectators have no team');
    if (team > this.settings.teamCount) return err('badMessage', 'No such team');
    m.team = team;
    this.broadcastLobby();
    return null;
  }

  kick(m: Member, memberId: number): RoomError {
    if (this.isPublic) return err('notAllowed', 'Public lobbies have no host');
    if (m.memberId !== this.hostMemberId) return err('notHost', 'Only the host can kick');
    if (this.phase !== 'lobby') return err('started', 'The game has already started');
    if (memberId === m.memberId) return err('notAllowed', 'You cannot kick yourself');
    const target = this.members.find((x) => x.memberId === memberId);
    if (!target) return err('notFound', 'No such player');
    this.kicked.add(target.clientId);
    target.session?.send({ type: 'kicked', reason: 'The host removed you from the lobby' });
    this.removeMember(target);
    return null;
  }

  requestStart(m: Member): RoomError {
    if (this.isPublic) return err('notAllowed', 'Public lobbies start on their own');
    if (m.memberId !== this.hostMemberId) return err('notHost', 'Only the host can start the game');
    if (this.phase !== 'lobby') return err('started', 'The game has already started');
    this.startGame();
    return null;
  }

  // ---------------------------------------------------------------------------------------------- start

  private refreshPublicSettings(): void {
    if (this.publicFill) this.settings = this.publicFill(this.settings, Math.max(1, this.players.length));
  }

  /** Freezes the roster and starts the turn loop. Returns false when nobody connected could play. */
  startGame(): boolean {
    if (this.phase !== 'lobby') return false;
    const now = this.host.now();
    if (this.isPublic) {
      // Places of players who dropped are not kept in a public game.
      for (const m of this.players.filter((x) => !x.session)) this.removeMember(m);
    }
    const players = this.players;
    if (players.length === 0 || !players.some((m) => m.session)) {
      if (this.isPublic) this.startsAt = null;
      return false;
    }
    if (this.isPublic) this.refreshPublicSettings();
    const s = this.settings;
    const colors = resolveColors(players.map((m) => m.color));
    const teamsMode = s.mode === 'teams';
    const byPlayer = teamsMode ? assignTeams(players.map((m) => m.team), s.aiCount, s.teamCount) : null;
    const slots: PlayerSlot[] = players.map((m, i) => {
      m.playerId = i + 1;
      m.color = colors[i];
      m.team = byPlayer ? byPlayer[i + 1] : 0;
      return { playerId: i + 1, name: m.name, color: colors[i], team: m.team };
    });
    const teams: TeamsInfo | null = byPlayer
      ? { count: s.teamCount, names: TEAM_NAMES.slice(0, s.teamCount), byPlayer }
      : null;
    const settings: GameSettings = {
      seed: this.host.makeSeed(),
      mapType: s.mapType,
      mapSize: s.mapSize,
      aiCount: s.aiCount,
      difficulty: s.difficulty,
      playerName: slots[0].name,
      playerColor: slots[0].color,
      humanPlayer: true,
      timeLimit: s.timeLimit,
      victoryLandShare: s.victoryLandShare,
      tribeCount: s.tribeCount,
    };
    this.startInfo = {
      type: 'gameStart',
      code: this.code,
      mode: s.mode,
      settings,
      playerSlots: slots,
      teams,
      startTurn: 0,
      turnMs: this.host.opts.turnMs,
      hashInterval: HASH_INTERVAL_TURNS,
    };
    this.phase = 'running';
    this.startsAt = null;
    this.startedAt = now;
    for (const m of this.members) if (m.session) this.sendGameStart(m);
    this.broadcastPresence();
    this.loopStart = now + this.host.opts.firstTurnDelayMs;
    this.scheduleNext();
    this.host.opts.log(`game ${this.code} started: ${players.length} players, ${s.mode}, ${s.mapType}/${s.mapSize}`);
    this.host.roomChanged(this);
    return true;
  }

  private sendGameStart(m: Member): void {
    if (!this.startInfo || !m.session) return;
    const n = this.turns.length;
    m.session.send({ ...this.startInfo, yourPlayerId: m.spectator ? 0 : m.playerId, turnsPlayed: n });
    if (n > 0) {
      m.session.send({ type: 'catchUp', fromTurn: 0, toTurn: n, turns: this.turns.filter((t) => t.intents.length > 0) });
    }
  }

  // ---------------------------------------------------------------------------------------------- turn loop

  private scheduleNext(): void {
    const due = this.loopStart + this.turns.length * this.host.opts.turnMs;
    const delay = Math.max(0, due - this.host.now());
    this.timer = setTimeout(() => this.onTimer(), delay);
  }

  private onTimer(): void {
    this.timer = null;
    if (this.phase !== 'running') return;
    const turnMs = this.host.opts.turnMs;
    const now = this.host.now();
    let behind = Math.floor((now - this.loopStart) / turnMs) + 1 - this.turns.length;
    if (behind > 20) {
      // The process stalled (sleep, long GC): continue from now instead of sending a burst.
      this.loopStart = now - this.turns.length * turnMs;
      behind = 1;
    }
    for (let i = 0; i < Math.max(1, behind) && this.phase === 'running'; i++) this.endTurn();
    if (this.phase === 'running') this.scheduleNext();
  }

  /** Closes the current turn and sends it to everyone. */
  endTurn(): void {
    const n = this.turns.length;
    const turn: Turn = { n, intents: this.pending };
    this.pending = [];
    this.turns.push(turn);
    for (const m of this.members) {
      m.intentsThisTurn = 0;
      m.rateWarned = false;
    }
    const text = JSON.stringify({ type: 'turn', n, intents: turn.intents });
    for (const m of this.members) m.session?.sendRaw(text);
    if (n % HASH_INTERVAL_TURNS === 0) {
      for (const t of [...this.hashes.keys()]) if (t + this.host.opts.hashGraceTurns <= n) this.decideHash(t);
    }
  }

  intent(m: Member, action: Action): RoomError {
    if (this.phase !== 'running') return err('notAllowed', 'The game is not running');
    if (m.spectator || m.playerId <= 0) return err('notAllowed', 'Spectators cannot act');
    if (action.type === 'startNow' && (this.isPublic || m.memberId !== this.hostMemberId)) {
      return err('notAllowed', 'Only the host can end the spawn phase early');
    }
    if (m.intentsThisTurn >= MAX_INTENTS_PER_TURN) {
      if (m.rateWarned) return null;
      m.rateWarned = true;
      return err('rateLimit', `At most ${MAX_INTENTS_PER_TURN} actions per turn: extra ones were dropped`);
    }
    m.intentsThisTurn++;
    this.pending.push({ playerId: m.playerId, action });
    return null;
  }

  // ---------------------------------------------------------------------------------------------- hashes

  hash(m: Member, turn: number, hash: number): RoomError {
    if (this.phase === 'lobby') return err('notAllowed', 'The game has not started');
    if (turn >= this.turns.length) return err('badMessage', 'Hash for a turn that was not sent yet');
    if (!isHashTurn(turn)) return err('badMessage', `Hashes are for turns n with (n + 1) % ${HASH_INTERVAL_TURNS} === 0`);
    if (m.desynced) return null;
    const d = this.decided.get(turn);
    if (d) {
      this.compare(m, turn, hash, d);
      return null;
    }
    let map = this.hashes.get(turn);
    if (!map) {
      map = new Map();
      this.hashes.set(turn, map);
    }
    map.set(m.memberId, hash);
    const voters = this.players.filter((p) => p.session && !p.desynced);
    if (voters.length > 0 && voters.every((p) => map.has(p.memberId))) this.decideHash(turn);
    return null;
  }

  private decideHash(turn: number): void {
    const map = this.hashes.get(turn);
    this.hashes.delete(turn);
    if (!map) return;
    const playerHashes: number[] = [];
    for (const [memberId, h] of map) {
      const m = this.members.find((x) => x.memberId === memberId);
      if (m && !m.spectator && !m.desynced) playerHashes.push(h);
    }
    if (playerHashes.length === 0) return;
    const counts = new Map<number, number>();
    for (const h of playerHashes) counts.set(h, (counts.get(h) ?? 0) + 1);
    let best = playerHashes[0];
    let bestCount = 0;
    for (const [h, c] of counts) {
      if (c > bestCount) {
        best = h;
        bestCount = c;
      }
    }
    const majority = bestCount * 2 > playerHashes.length ? best : null;
    const d: HashDecision = { hash: majority, agreeing: majority === null ? 0 : bestCount, total: playerHashes.length };
    this.decided.set(turn, d);
    if (this.decided.size > MAX_DECIDED) {
      const oldest = this.decided.keys().next().value;
      if (oldest !== undefined) this.decided.delete(oldest);
    }
    for (const [memberId, h] of map) {
      const m = this.members.find((x) => x.memberId === memberId);
      if (m) this.compare(m, turn, h, d);
    }
  }

  private compare(m: Member, turn: number, hash: number, d: HashDecision): void {
    if (m.desynced || hash === d.hash) return;
    if (d.hash === null && d.total < 2) return;
    m.desynced = true;
    m.session?.send({
      type: 'desync',
      turn,
      yourHash: hash,
      majorityHash: d.hash,
      agreeing: d.agreeing,
      total: d.total,
      details:
        d.hash === null
          ? 'The players disagree about the game state and there is no majority: the game has diverged.'
          : 'Your game state differs from the other players: what you see may be wrong. Reload to rejoin.',
    });
    this.host.opts.log(`game ${this.code}: desync of member ${m.memberId} at turn ${turn}`);
  }

  // ---------------------------------------------------------------------------------------------- end

  reportGameOver(m: Member, turn: number, winner: number): RoomError {
    if (this.phase !== 'running') return null;
    if (m.spectator || m.desynced) return null;
    if (turn >= this.turns.length) return err('badMessage', 'Game over for a turn that was not sent yet');
    this.overVotes.set(m.memberId, winner);
    const voters = this.players.filter((p) => (p.session || this.overVotes.has(p.memberId)) && !p.desynced);
    const tally = new Map<number, number>();
    for (const p of voters) {
      const w = this.overVotes.get(p.memberId);
      if (w !== undefined) tally.set(w, (tally.get(w) ?? 0) + 1);
    }
    for (const [w, c] of tally) {
      if (c * 2 > voters.length) {
        this.finish('finished', w);
        break;
      }
    }
    return null;
  }

  finish(reason: GameOverReason, winner: number): void {
    if (this.phase !== 'running') return;
    this.phase = 'over';
    this.winner = winner;
    this.overAt = this.host.now();
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const msg: ServerMessage = { type: 'gameOver', reason, winner, turn: this.turns.length - 1 };
    for (const m of this.members) m.session?.send(msg);
    this.host.opts.log(`game ${this.code} over (${reason}), winner ${winner}, ${this.turns.length} turns`);
  }

  /** Housekeeping, called by the hub every sweep. */
  sweep(now: number): void {
    const o = this.host.opts;
    if (this.phase === 'lobby') {
      for (const m of this.members.filter((x) => !x.session && x.disconnectedAt !== null)) {
        if (now - (m.disconnectedAt as number) > o.lobbyReconnectGraceMs) this.removeMember(m);
      }
      if (this.closed) return;
      if (this.isPublic && this.startsAt !== null && now >= this.startsAt) this.startGame();
    } else if (this.phase === 'running') {
      if (this.connectedPlayers() === 0) {
        if (this.emptySince === null) this.emptySince = now;
        if (now - this.emptySince > o.emptyGameGraceMs) {
          this.finish('abandoned', 0);
          this.close('');
          return;
        }
      } else this.emptySince = null;
      if (now - this.startedAt > o.maxGameMs) this.finish('maxDuration', 0);
    } else if (this.phase === 'over') {
      if (now - this.overAt > o.gameOverLingerMs) this.close('');
    }
  }

  /** Ends the room: stops the loop, detaches every session (with a 'kicked' note when a reason is given). */
  close(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    for (const m of this.members) {
      const s = m.session;
      m.session = null;
      if (!s) continue;
      s.room = null;
      s.member = null;
      if (reason) s.send({ type: 'kicked', reason });
      this.host.sessionLeftRoom(s);
    }
    this.host.roomClosed(this);
  }

  // ---------------------------------------------------------------------------------------------- messages

  private lobbyPlayers(): LobbyPlayer[] {
    return this.players.map((m) => {
      const p: LobbyPlayer = {
        memberId: m.memberId,
        name: m.name,
        color: m.color,
        team: m.team,
        connected: m.session !== null,
        isHost: m.memberId === this.hostMemberId,
      };
      if (m.playerId > 0) p.playerId = m.playerId;
      return p;
    });
  }

  broadcastLobby(): void {
    if (this.phase !== 'lobby' || this.closed) return;
    const players = this.lobbyPlayers();
    const spectators = this.spectators.length;
    const now = this.host.now();
    for (const m of this.members) {
      if (!m.session) continue;
      const msg: LobbyStateMsg = {
        type: 'lobbyState',
        code: this.code,
        isPublic: this.isPublic,
        mode: this.settings.mode,
        hostMemberId: this.hostMemberId,
        you: m.memberId,
        youAreSpectator: m.spectator,
        players,
        spectators,
        settings: { ...this.settings },
        startsAt: this.startsAt,
        serverTime: now,
      };
      m.session.send(msg);
    }
  }

  private broadcastPresence(): void {
    if (this.phase !== 'running') return;
    const msg: ServerMessage = {
      type: 'presence',
      players: this.players.map((m) => ({ playerId: m.playerId, connected: m.session !== null })),
      spectators: this.spectators.filter((m) => m.session).length,
    };
    for (const m of this.members) m.session?.send(msg);
  }
}
