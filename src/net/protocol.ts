// Online multiplayer wire protocol: JSON messages over one WebSocket, each with a `type` discriminant.
//
// Model: deterministic lockstep with a relay server. The simulation runs only in the browsers. The server collects
// player intents (our `Action` union) during each turn (TURN_MS), stamps each with the sender's server-assigned
// player id and broadcasts `turn {n, intents}`. Every client, for every turn n = 0, 1, 2 ... strictly in order:
//
//   for (const { playerId, action } of turn.intents) applyAction(state, playerId, action);  // array order
//   tick(state);                                                                              // exactly one tick
//
// so after turn n the game is at state.tick === n + 1 on every client. Intents that the sim rejects (not your tile,
// not enough gold ...) are rejected identically everywhere and cost nothing: the server only checks their shape.
//
// Client rules (the server relies on them):
// - Never call applyAction() directly in an online game: send `intent` and wait for it to come back in a turn.
// - Process turns strictly in order. A `catchUp` lists only the non-empty turns of [fromTurn, toTurn); every
//   missing number in that range is an empty turn. The next live `turn` after a catchUp has n === toTurn.
// - After processing turn n, when (n + 1) % HASH_INTERVAL_TURNS === 0, send `hash {turn: n, hash: hashState(state)}`
//   (src/sim/hash.ts). While replaying a catchUp only send it for turns >= catchUp.toTurn - HASH_INTERVAL_TURNS
//   (older ones are dropped by the server's hash rate limit anyway).
// - When the sim's phase becomes 'over', send `gameOver {turn: n, winner: state.winner}` once.
// - No game speed in online games: the server's clock drives the game (one turn per TURN_MS). Pause (protocol 6):
//   in a PRIVATE game only the host may send `setPause {paused}`; the server then stops (or restarts) sending turns,
//   so every client freezes in sync, and tells everyone (spectators too) with `pauseState {paused, by, host}`.
//   Others get error 'notHost'; public games have no host (error 'notAllowed'); toggling faster than once a second
//   gets 'rateLimit'. Intents sent while paused are refused (error 'notAllowed'). A (re)joining client gets
//   `pauseState` right after `gameStart` (and its catch-up) when the game is paused, and everyone gets one when the
//   host role passes on during a game. If the host stays disconnected for 60 s, the host role passes to the next
//   connected player and a paused game resumes on its own (by = 0); a single pause lasts at most 15 minutes.
// - Ally requests (protocol 6): `requestAllyAttack {ally, target}` and `requestAllyAid {ally}` intents (player ids).
// - `startNow` (end the spawn phase early) is relayed only from the host of a private lobby; others get an error.
// - `chooseDoctrine {doctrine}` (protocol 5): the server checks only that `doctrine` is a DoctrineId; unlock time,
//   cooldown and gold are the sim's rules (src/sim/doctrines.ts), applied identically on every client.
// - Send `ping` every PING_INTERVAL_MS; the server closes connections silent for longer than IDLE_TIMEOUT_MS.
// - Keep `clientId` (random, from makeClientId()) in localStorage: it is your seat. Reconnecting with the same
//   clientId (a new socket + `hello`) puts you back in your lobby or game: the server answers `welcome {resumed}`
//   and then `lobbyState`, or `gameStart` + `catchUp` for a running game. Put the game you still hold in
//   `hello.resume {code, haveTurns}` (haveTurns = the next turn number you need): the catch-up then starts there
//   instead of at turn 0. A catch-up may come as several `catchUp` messages in a row (each starts where the previous
//   ended); live `turn`s follow the last one. A game you left with `leaveLobby` is not resumed (rejoin by code).
// - Game construction from `gameStart`: createGame-like, with every `playerSlots` entry a human, ids 1..H in that
//   order (playerSlots[i].playerId === i + 1), then `settings.aiCount` AI nations (ids H+1 .. H+aiCount), then the
//   tribes. `settings` is the full GameSettings (seed included): `settings.humans` lists the seats (name, colour,
//   team) in player id order, so createGame(settings, map, { teams: teams.byPlayer }) builds the game; its
//   playerName/playerColor equal playerSlots[0].
//   `teams` (teams mode only) gives the team of every human and AI nation: teammates are permanently allied, cannot
//   break the alliance or attack each other, and win together. Tribes have no team.
//
// Single player never touches any of this: the client runs the sim locally (no server needed).
//
// This file is shared by the server (server/) and the browser client: keep it free of DOM and Node APIs.

import { MAX_AI_COUNT, MAX_TRIBE_COUNT } from '../sim/config';
import {
  cloneSetup,
  DEFAULT_SETUP,
  DIFFICULTY_LIST,
  MAP_SIZE_LIST,
  MAP_TYPE_LIST,
  MAX_TEAMS as SETUP_MAX_TEAMS,
  MIN_TEAMS as SETUP_MIN_TEAMS,
  MODE_LIST,
  MULTIPLAYER_NATIONS,
} from '../sim/setup';
import type { Action, Difficulty, GameMode, GameSettings, GameSetup, MapChoice, MapSize, MapType, Modifiers } from '../sim/types';

export type { GameMode };

// ------------------------------------------------------------------------------------------------ constants

/** Bumped on any incompatible change to the messages below. `hello.protocol` must equal it. */
export const PROTOCOL_VERSION = 6;
/** WebSocket path on the server (same host that serves the client, or the one given by ?server=). */
export const WS_PATH = '/ws';
/** One turn = one sim tick = 100 ms (config TICK_SECONDS). */
export const TURN_MS = 100;
/** Clients hash their state every this many turns (see the rules above). */
export const HASH_INTERVAL_TURNS = 10;
/** Intents per player per turn; the server drops extras (and answers error 'rateLimit'). */
export const MAX_INTENTS_PER_TURN = 10;
/** Largest message the server accepts (bytes of JSON). Bigger frames close the connection. */
export const MAX_MESSAGE_BYTES = 16 * 1024;
/** Most humans in one lobby (spectators don't count). */
export const MAX_LOBBY_PLAYERS = 16;
export const MIN_TEAMS = SETUP_MIN_TEAMS;
export const MAX_TEAMS = SETUP_MAX_TEAMS;
export const NAME_MAX_LENGTH = 24;
export const BUILD_MAX_LENGTH = 64;
/** Private lobby codes: 6 characters without look-alikes (no I, O, 0, 1). */
export const LOBBY_CODE_LENGTH = 6;
export const LOBBY_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
/** clientId: 16..64 characters of [A-Za-z0-9_-]. */
export const CLIENT_ID_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;
/** Client keepalive: send `ping` this often. */
export const PING_INTERVAL_MS = 5000;
/** The server closes a connection that sent nothing (no message, no WebSocket pong) for this long. */
export const IDLE_TIMEOUT_MS = 45000;

/** WebSocket close codes the server uses (4000-4999: don't reconnect automatically, except IDLE). */
export const CloseCode = {
  /** Protocol violation (too many invalid messages, binary frames, no hello in time). */
  BadClient: 4000,
  /** The same clientId connected again on another socket (e.g. a second tab). */
  Replaced: 4001,
  /** hello.protocol differs from PROTOCOL_VERSION: reload the page. */
  Version: 4003,
  /** Too many connections from one address. */
  TooManyConnections: 4004,
  /** Idle timeout: reconnecting is fine. */
  Idle: 4005,
  /** Message flood. */
  RateLimit: 4006,
  /** Server shutting down. */
  Shutdown: 4007,
} as const;

/** Player colour palette offered for online games (the server also uses it to replace colours that clash). */
export const PLAYER_COLORS: readonly RGB[] = [
  [52, 120, 246], [230, 57, 70], [46, 196, 102], [255, 183, 3], [155, 89, 182], [26, 188, 196],
  [243, 114, 32], [236, 72, 153], [132, 204, 22], [99, 102, 241], [161, 98, 7], [20, 184, 166],
  [244, 63, 94], [250, 204, 21], [124, 58, 237], [14, 165, 233],
];
/** Team display names, in the order of the sim's team colours (state.ts TEAM_COLORS: online, team 1 is blue ...). */
export const TEAM_NAMES: readonly string[] = ['Blue', 'Red', 'Green', 'Gold', 'Purple', 'Teal', 'Orange', 'Pink'];

// ------------------------------------------------------------------------------------------------ shared shapes

export type RGB = [number, number, number];

/**
 * What a lobby decides before the start: the shared game setup (src/sim/setup.ts: map, nations, tribes, difficulty,
 * mode and teams, time limit, victory share, modifiers, preset; the same model as single player) plus the lobby's
 * human seat count. The server checks it with setup.validateSetup; `gameStart.settings` is it plus seed and identity.
 * In multiplayer `aiCount` is the AI nations on top of the humans (MULTIPLAYER_NATIONS in all by default).
 */
export interface LobbySettings extends GameSetup {
  /** humans allowed, 1..MAX_LOBBY_PLAYERS */
  maxPlayers: number;
}

/** A change to the lobby settings: any fields; `modifiers` may name only the modifiers that change. */
export type LobbySettingsPatch = Partial<Omit<LobbySettings, 'modifiers'>> & { modifiers?: Partial<Modifiers> };

export const DEFAULT_LOBBY_SETTINGS: LobbySettings = {
  ...cloneSetup(DEFAULT_SETUP),
  aiCount: MULTIPLAYER_NATIONS - 2,
  maxPlayers: 8,
};

export const MAP_TYPES: readonly MapType[] = MAP_TYPE_LIST;
export const MAP_SIZES_LIST: readonly MapSize[] = MAP_SIZE_LIST;
export const DIFFICULTIES: readonly Difficulty[] = DIFFICULTY_LIST;
export const GAME_MODES: readonly GameMode[] = MODE_LIST;

/** Bounds the server enforces on LobbySettings (inclusive). */
export const LOBBY_LIMITS = {
  aiCount: [0, MAX_AI_COUNT],
  teamCount: [MIN_TEAMS, MAX_TEAMS],
  tribeCount: [-1, MAX_TRIBE_COUNT],
  maxPlayers: [1, MAX_LOBBY_PLAYERS],
} as const;

/** An intent as relayed in a turn: the server stamps playerId from the sender's seat. */
export interface StampedIntent {
  playerId: number;
  action: Action;
}

export interface Turn {
  /** turn number, from 0 */
  n: number;
  /** in the order the server received them; apply in array order */
  intents: StampedIntent[];
}

export interface LobbyPlayer {
  /** id inside this lobby (for kick); not the game's player id */
  memberId: number;
  name: string;
  color: RGB;
  /** teams mode: chosen team 1..teamCount, 0 = auto. Always 0 in ffa. */
  team: number;
  connected: boolean;
  isHost: boolean;
  /** player id once the game has started (absent before) */
  playerId?: number;
}

/** One human seat in a started game. */
export interface PlayerSlot {
  playerId: number;
  name: string;
  color: RGB;
  /** team 1..count in teams mode, 0 in ffa */
  team: number;
}

export interface TeamsInfo {
  count: number;
  /** display names, length = count (team t is names[t - 1]) */
  names: string[];
  /** byPlayer[playerId] = team 1..count for humans and AI nations; index 0 and tribes (beyond the end) = 0 */
  byPlayer: number[];
}

/** Public lobby kinds: plain free-for-all, teams, and 'special' (FFA with 1-3 random modifiers). */
export type LobbyKind = 'ffa' | 'teams' | 'special';

/** A modifier as a chip: setup.activeModifiers' id, short label and one-line explanation. */
export interface LobbyChip {
  id: string;
  label: string;
  detail: string;
}

export interface LobbySummary {
  code: string;
  kind: LobbyKind;
  mode: GameMode;
  map: MapChoice;
  /** setup.modifierSummary: "Standard rules" or the active modifiers, e.g. "Fast game, Peace 4 min" */
  rules: string;
  /** the active modifiers (setup.activeModifiers without the teams entry), for chips */
  chips: LobbyChip[];
  teamCount: number;
  players: number;
  maxPlayers: number;
  /** server time (ms) of the automatic start, null while nobody has joined */
  startsAt: number | null;
}

export type ErrorCode =
  | 'badMessage' // malformed or invalid message
  | 'notReady' // hello first
  | 'version' // protocol or build mismatch
  | 'notFound' // no lobby with that code
  | 'full'
  | 'started' // the lobby already started (for actions only allowed before)
  | 'notInLobby'
  | 'notHost'
  | 'notAllowed'
  | 'kicked'
  | 'rateLimit'
  | 'serverFull';

// ------------------------------------------------------------------------------------------------ client -> server

export interface HelloMsg {
  type: 'hello';
  protocol: number;
  name: string;
  color: RGB;
  /** random persistent token (localStorage); identifies your seat across reconnects. Keep it secret. */
  clientId: string;
  /** client build id (e.g. git commit). Everyone in a lobby must run the same build (determinism). '' = unknown */
  build?: string;
  /** the online game this client still holds after a dropped connection: the catch-up starts at haveTurns */
  resume?: ResumeInfo;
}
/** A game the client already has turns of: `haveTurns` = the next turn number it needs (turns 0..haveTurns-1 held). */
export interface ResumeInfo {
  code: string;
  haveTurns: number;
}
export interface CreateLobbyMsg {
  type: 'createLobby';
  settings?: LobbySettingsPatch;
}
export interface JoinLobbyMsg {
  type: 'joinLobby';
  code: string;
  /** join as a spectator (always the case for a running game you have no seat in) */
  spectate?: boolean;
  /** turns of this game the client already holds (rejoining spectators): the catch-up starts there */
  haveTurns?: number;
}
export interface LeaveLobbyMsg {
  type: 'leaveLobby';
}
/** Host only, private lobbies, before the start. */
export interface UpdateLobbySettingsMsg {
  type: 'updateLobbySettings';
  settings: LobbySettingsPatch;
}
/** Teams mode, before the start: 0 = auto, 1..teamCount. */
export interface SetTeamMsg {
  type: 'setTeam';
  team: number;
}
/** Host only, private lobbies, before the start. */
export interface KickMsg {
  type: 'kick';
  memberId: number;
}
/** Host only, private lobbies. */
export interface StartGameMsg {
  type: 'startGame';
}
export interface IntentMsg {
  type: 'intent';
  action: Action;
}
export interface HashMsg {
  type: 'hash';
  /** the turn just processed ((turn + 1) % HASH_INTERVAL_TURNS === 0) */
  turn: number;
  /** hashState(state), unsigned 32-bit */
  hash: number;
}
/** The sim reached phase 'over' after processing `turn`. */
export interface GameOverReportMsg {
  type: 'gameOver';
  turn: number;
  winner: number;
}
/** Host of a private game only: pause or resume (the server stops / restarts the turns). */
export interface SetPauseMsg {
  type: 'setPause';
  paused: boolean;
}
export interface PingMsg {
  type: 'ping';
  /** any number (e.g. performance.now()); echoed in pong */
  t?: number;
}

export type ClientMessage =
  | HelloMsg
  | CreateLobbyMsg
  | JoinLobbyMsg
  | LeaveLobbyMsg
  | UpdateLobbySettingsMsg
  | SetTeamMsg
  | KickMsg
  | StartGameMsg
  | IntentMsg
  | HashMsg
  | GameOverReportMsg
  | SetPauseMsg
  | PingMsg;

// ------------------------------------------------------------------------------------------------ server -> client

export interface WelcomeMsg {
  type: 'welcome';
  protocol: number;
  serverTime: number;
  /** lobby/game code you were put back into (reconnect), null otherwise */
  resumed: string | null;
}
/** Public lobbies; sent after welcome and on every change while you are not in a lobby. */
export interface LobbyListMsg {
  type: 'lobbyList';
  serverTime: number;
  lobbies: LobbySummary[];
}
/** Sent to everyone in the lobby on every change until the game starts. */
export interface LobbyStateMsg {
  type: 'lobbyState';
  code: string;
  isPublic: boolean;
  mode: GameMode;
  hostMemberId: number; // -1 for public lobbies (no host)
  /** public lobbies: which kind; null for private ones */
  kind: LobbyKind | null;
  /** your memberId */
  you: number;
  youAreSpectator: boolean;
  players: LobbyPlayer[];
  spectators: number;
  settings: LobbySettings;
  /** server time (ms) of the automatic start, or null. Countdown = startsAt - serverTime. */
  startsAt: number | null;
  serverTime: number;
}
export interface GameStartMsg {
  type: 'gameStart';
  code: string;
  mode: GameMode;
  /** full sim settings, seed included (see the construction rule at the top) */
  settings: GameSettings;
  /** human seats, ordered by playerId (1..H) */
  playerSlots: PlayerSlot[];
  /** teams mode only */
  teams: TeamsInfo | null;
  /** your player id, 0 = spectator */
  yourPlayerId: number;
  /** the game's first turn number (always 0) */
  startTurn: number;
  /** turns already played; a `catchUp` follows when this is more than the turns you said you have (haveTurns, else 0) */
  turnsPlayed: number;
  turnMs: number;
  hashInterval: number;
}
export interface TurnMsg {
  type: 'turn';
  n: number;
  intents: StampedIntent[];
}
/**
 * All turns in [fromTurn, toTurn); only non-empty turns are listed. A long history comes in several catchUp messages
 * in a row (each fromTurn = the previous toTurn); the live turns follow the last one.
 */
export interface CatchUpMsg {
  type: 'catchUp';
  fromTurn: number;
  toTurn: number;
  turns: Turn[];
}
/** Who is connected during a game (sent on every change). */
export interface PresenceMsg {
  type: 'presence';
  players: { playerId: number; connected: boolean }[];
  spectators: number;
}
/** Your state hash differs from the majority's at `turn` (once until it rejoins). */
export interface DesyncMsg {
  type: 'desync';
  turn: number;
  yourHash: number;
  /** null when there was no majority */
  majorityHash: number | null;
  /** clients that agree with the majority / clients that reported */
  agreeing: number;
  total: number;
  details: string;
}
export interface ErrorMsg {
  type: 'error';
  code: ErrorCode;
  message: string;
}
export interface PongMsg {
  type: 'pong';
  t: number | null;
  serverTime: number;
}
/** The host removed you from the lobby (the socket stays open; you are back in the lobby list). */
export interface KickedMsg {
  type: 'kicked';
  reason: string;
}
/**
 * The game is paused (no turns until it resumes) or running again. Sent to everyone in the game on every change, after
 * gameStart (+ catch-up) to a client joining a paused game, and when the host role passes on.
 */
export interface PauseStateMsg {
  type: 'pauseState';
  paused: boolean;
  /** player id of who paused / resumed (the host); 0 = the server (auto-resume) */
  by: number;
  /** player id of the current host (who may pause); 0 = none (public game, or no player left) */
  host: number;
}
export type GameOverReason = 'finished' | 'abandoned' | 'maxDuration';
/** The game ended; no more turns follow. */
export interface GameOverMsg {
  type: 'gameOver';
  reason: GameOverReason;
  /** winner's player id from the clients' majority, 0 if none */
  winner: number;
  /** last turn sent */
  turn: number;
}

export type ServerMessage =
  | WelcomeMsg
  | LobbyListMsg
  | LobbyStateMsg
  | GameStartMsg
  | TurnMsg
  | CatchUpMsg
  | PresenceMsg
  | DesyncMsg
  | ErrorMsg
  | PongMsg
  | KickedMsg
  | PauseStateMsg
  | GameOverMsg;

// ------------------------------------------------------------------------------------------------ helpers

/** A fresh clientId (browser: crypto.getRandomValues). Store it in localStorage and reuse it. */
export function makeClientId(): string {
  const bytes = new Uint8Array(18);
  globalThis.crypto.getRandomValues(bytes);
  const abc = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  let s = '';
  for (const b of bytes) s += abc[b & 63];
  return s;
}

/** Normalises a typed lobby code (case, spaces, dashes); returns null when it can't be one. */
export function normalizeLobbyCode(input: string): string | null {
  const s = input.toUpperCase().replace(/[\s-]/g, '');
  if (s.length !== LOBBY_CODE_LENGTH) return null;
  for (const ch of s) if (!LOBBY_CODE_ALPHABET.includes(ch)) return null;
  return s;
}

/**
 * WebSocket URL of the multiplayer server. Priority: the page's `?server=` parameter, then the build-time
 * VITE_SERVER_URL (pass `import.meta.env.VITE_SERVER_URL`), then the page's own origin. http(s):// is turned into
 * ws(s)://, and WS_PATH is added when the URL has no path. Returns null when there is no usable origin (file://).
 */
export function resolveServerUrl(
  page: { protocol: string; host: string; search: string },
  buildTimeUrl?: string | null,
): string | null {
  let raw: string | null = null;
  try {
    raw = new URLSearchParams(page.search).get('server');
  } catch {
    raw = null;
  }
  if (!raw && buildTimeUrl) raw = buildTimeUrl;
  if (raw) {
    raw = raw.trim();
    if (!/^[a-z]+:\/\//i.test(raw)) raw = (page.protocol === 'http:' ? 'ws://' : 'wss://') + raw;
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      return null;
    }
    if (u.protocol === 'http:') u.protocol = 'ws:';
    else if (u.protocol === 'https:') u.protocol = 'wss:';
    if (u.protocol !== 'ws:' && u.protocol !== 'wss:') return null;
    if (u.pathname === '' || u.pathname === '/') u.pathname = WS_PATH;
    return u.toString();
  }
  if (page.protocol !== 'http:' && page.protocol !== 'https:') return null;
  if (!page.host) return null;
  return (page.protocol === 'https:' ? 'wss://' : 'ws://') + page.host + WS_PATH;
}

/** Expands a catchUp's sparse list into one Turn per number in [fromTurn, toTurn). */
export function expandCatchUp(msg: Pick<CatchUpMsg, 'fromTurn' | 'toTurn' | 'turns'>): Turn[] {
  const out: Turn[] = [];
  let k = 0;
  for (let n = msg.fromTurn; n < msg.toTurn; n++) {
    if (k < msg.turns.length && msg.turns[k].n === n) out.push(msg.turns[k++]);
    else out.push({ n, intents: [] });
  }
  return out;
}

/** Whether the client must send a hash after processing turn n. */
export function isHashTurn(n: number): boolean {
  return (n + 1) % HASH_INTERVAL_TURNS === 0;
}
