// Server settings. Defaults are for production; tests pass short timers.
import { IDLE_TIMEOUT_MS, MAX_LOBBY_PLAYERS, MAX_MESSAGE_BYTES, TURN_MS } from '../src/net/protocol';

export interface ServerOptions {
  /** 0 = pick a free port (tests) */
  port: number;
  host: string;
  /** folder with the built client (index.html), null = don't serve files */
  staticDir: string | null;
  /** turn length in ms (the client's sim runs one tick per turn) */
  turnMs: number;
  /** pause between gameStart and turn 0, so clients can build the map */
  firstTurnDelayMs: number;
  /** keep one FFA and one Teams public lobby open */
  publicLobbies: boolean;
  /** public lobby countdown, started when the first player joins */
  publicStartMs: number;
  maxPlayersPerLobby: number;
  /** a player who dropped from an unstarted lobby keeps the place this long */
  lobbyReconnectGraceMs: number;
  /** a running game with no connected player ends after this long */
  emptyGameGraceMs: number;
  /** a finished game stays in memory this long (late reconnects see gameOver) */
  gameOverLingerMs: number;
  maxGameMs: number;
  /** hashes for turn t are compared once turn t + this has been sent (or once every player reported) */
  hashGraceTurns: number;
  maxConnectionsPerIp: number;
  maxMessageBytes: number;
  /** messages per second per connection (token bucket, burst x2); a long flood closes the socket */
  messagesPerSecond: number;
  helloTimeoutMs: number;
  idleTimeoutMs: number;
  /** WebSocket ping interval (keeps proxies from closing quiet sockets) */
  keepaliveMs: number;
  /** housekeeping timer (lobby countdowns, timeouts, lobby list) */
  sweepMs: number;
  maxRooms: number;
  /** private lobbies and games one address may have open at once (a solo game counts until it ends) */
  maxRoomsPerIp: number;
  /** pause between two createLobby from one address */
  createLobbyCooldownMs: number;
  /** steady intent budget per player (token bucket: intentsPerSecond refill, intentBurst capacity) */
  intentsPerSecond: number;
  intentBurst: number;
  /** stored turn history per game (serialized bytes); past it intents are refused (rateLimit) */
  maxGameLogBytes: number;
  /** a disconnected player still counts in the game-over vote for this long */
  voteAbsentMs: number;
  /** take the client IP from the proxy headers (behind Render/Fly/nginx) */
  trustProxy: boolean;
  /**
   * Proxies in front of the server that append to X-Forwarded-For: the client address is the entry this many places
   * from the end (1 = the last one). Earlier entries are whatever the client sent and are never trusted.
   */
  proxyHops: number;
  /** a header set by the platform's own proxy that holds the client address (e.g. fly-client-ip); '' = none */
  clientIpHeader: string;
  /** allowed Origin headers for WebSockets; empty = any */
  allowedOrigins: string[];
  log: (msg: string) => void;
}

export const DEFAULT_OPTIONS: ServerOptions = {
  port: 8080,
  host: '0.0.0.0',
  staticDir: null,
  turnMs: TURN_MS,
  firstTurnDelayMs: 1000,
  publicLobbies: true,
  publicStartMs: 60_000,
  maxPlayersPerLobby: MAX_LOBBY_PLAYERS,
  lobbyReconnectGraceMs: 30_000,
  emptyGameGraceMs: 60_000,
  gameOverLingerMs: 60_000,
  maxGameMs: 4 * 3600_000,
  hashGraceTurns: 30,
  maxConnectionsPerIp: 8,
  maxMessageBytes: MAX_MESSAGE_BYTES,
  messagesPerSecond: 30,
  helloTimeoutMs: 10_000,
  idleTimeoutMs: IDLE_TIMEOUT_MS,
  keepaliveMs: 15_000,
  sweepMs: 250,
  maxRooms: 500,
  maxRoomsPerIp: 3,
  createLobbyCooldownMs: 1000,
  intentsPerSecond: 4,
  intentBurst: 40,
  maxGameLogBytes: 48 * 1024 * 1024,
  voteAbsentMs: 180_000,
  trustProxy: false,
  proxyHops: 1,
  clientIpHeader: '',
  allowedOrigins: [],
  log: (msg) => console.log(`[${new Date().toISOString()}] ${msg}`),
};

/** Options from environment variables (see docs/MULTIPLAYER.md). */
export function optionsFromEnv(env: Record<string, string | undefined>): Partial<ServerOptions> {
  const o: Partial<ServerOptions> = {};
  const int = (name: string): number | undefined => {
    const v = env[name];
    if (v === undefined || v === '') return undefined;
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : undefined;
  };
  const port = int('PORT');
  if (port !== undefined) o.port = port;
  if (env.HOST) o.host = env.HOST;
  const pub = int('PUBLIC_START_SECONDS');
  if (pub !== undefined) o.publicStartMs = pub * 1000;
  if (env.PUBLIC_LOBBIES === '0') o.publicLobbies = false;
  const perIp = int('MAX_CONNECTIONS_PER_IP');
  if (perIp !== undefined && perIp > 0) o.maxConnectionsPerIp = perIp;
  const maxRooms = int('MAX_ROOMS');
  if (maxRooms !== undefined && maxRooms > 0) o.maxRooms = maxRooms;
  const perIpRooms = int('MAX_ROOMS_PER_IP');
  if (perIpRooms !== undefined && perIpRooms > 0) o.maxRoomsPerIp = perIpRooms;
  const hops = int('PROXY_HOPS');
  if (hops !== undefined && hops > 0) o.proxyHops = hops;
  if (env.CLIENT_IP_HEADER) o.clientIpHeader = env.CLIENT_IP_HEADER.trim().toLowerCase();
  else if (env.FLY_APP_NAME) o.clientIpHeader = 'fly-client-ip';
  // Render and Fly put a proxy in front of the app: the socket address is the proxy's.
  if (env.TRUST_PROXY === '1' || (env.TRUST_PROXY !== '0' && (env.RENDER || env.FLY_APP_NAME))) o.trustProxy = true;
  if (env.ALLOWED_ORIGINS) o.allowedOrigins = env.ALLOWED_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean);
  return o;
}
