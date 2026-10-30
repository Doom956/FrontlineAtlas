# Borderfall online multiplayer

Single player needs no server: the browser runs the whole game. Online games add one small Node server that
**relays player actions**; it never runs the simulation.

## 1. Architecture

```
 browser A ──┐                         ┌── browser A: sim runs here
 browser B ──┼── WebSocket /ws ── server (relay) ──┼── browser B: sim runs here
 browser C ──┘   JSON messages         └── browser C: sim runs here
```

**Deterministic lockstep with a relay.** Every client runs the same simulation (`src/sim`) from the same seed. The
server cuts time into **turns of 100 ms**. During a turn it collects the players' *intents* (our `Action` union),
stamps each with the sender's player id (taken from the connection, never from the message) and then broadcasts
`turn {n, intents}`. Every client, for turn n = 0, 1, 2 ...:

```ts
for (const { playerId, action } of turn.intents) applyAction(state, playerId, action);
tick(state); // exactly one tick per turn
```

Because the sim is deterministic (seeded RNG, no `Math.random`/`Date`, no `Math.sin/exp/log/pow...`, see DESIGN.md)
every client ends up in the same state. Game rules are checked by the sim on every client (an illegal action fails
the same way everywhere); the server only checks message shapes, sizes and rates.

**Desync check.** Every 10 turns each client sends `hashState(state)`. The server takes a majority vote and tells the
clients that differ (`desync`); the client shows a warning and offers a reload (a reload rejoins and replays).

**Reconnects and spectators.** The server keeps the game's turn list in memory while it runs. A player who reconnects
with the same `clientId` (kept in localStorage) gets `gameStart` and a `catchUp` with every turn since turn 0 and
replays them (fast-forward), then continues live. Spectators join a running game by its code the same way, with
player id 0. Nothing is stored on disk; no database.

### Files

| Path | What |
|------|------|
| `src/net/protocol.ts` | the wire protocol: every message type, constants, small helpers (shared by client and server) |
| `server/server.ts` | `startServer(options)`: HTTP (static client, `/health`) + WebSocket upgrade on `/ws` |
| `server/hub.ts` | connections, `hello`, rate limits, timeouts, lobby list, public lobby scheduler |
| `server/room.ts` | one lobby/game: members, host controls, start, turn loop, hash votes, game-over votes |
| `server/validate.ts` | hand-written validators for every client message and every `Action` |
| `server/options.ts` | server settings and their environment variables |
| `server/index.ts` | production entry (bundled to `server-dist/index.js`) |
| `scripts/dev.mjs` | `npm run dev`: Vite + server together |
| `tests/server.test.ts` | real WebSocket clients against an in-process server |

## 2. Protocol (summary; `src/net/protocol.ts` is the reference)

JSON text frames, each an object with a `type`. Max 16 KB per client message.

**Client -> server**

| type | fields | notes |
|------|--------|-------|
| `hello` | `protocol, name, color [r,g,b], clientId, build?` | first message. `clientId`: random 16-64 chars (`makeClientId()`), kept in localStorage; it *is* your seat. `build`: client build id; a lobby only accepts one build |
| `createLobby` | `settings?` (partial `LobbySettings`) | private lobby, you are the host |
| `joinLobby` | `code, spectate?` | 6-character code; a running game makes you a spectator unless you have a seat there |
| `leaveLobby` | | before the start you lose the place; in a game your nation stays (rejoin by code) |
| `updateLobbySettings` | `settings` | host, private, before start |
| `setTeam` | `team` (0 = auto) | teams mode, before start |
| `kick` | `memberId` | host, private, before start |
| `startGame` | | host, private |
| `intent` | `action` | any `Action`; max 10 per player per turn |
| `hash` | `turn, hash` | after processing turn n with (n+1) % 10 === 0 |
| `gameOver` | `turn, winner` | once, when the sim's phase becomes `over` |
| `ping` | `t?` | every 5 s |

**Server -> client**

| type | when |
|------|------|
| `welcome {protocol, serverTime, resumed}` | answer to hello; `resumed` = code when you were put back into your lobby/game |
| `lobbyList {lobbies}` | public lobbies, while you are not in one (on change) |
| `lobbyState {code, isPublic, mode, hostMemberId, you, players, spectators, settings, startsAt, serverTime}` | every change in your lobby before the start; countdown = `startsAt - serverTime` |
| `gameStart {code, mode, settings, playerSlots, teams, yourPlayerId, startTurn, turnsPlayed, turnMs, hashInterval}` | the start (and on rejoin). `yourPlayerId` 0 = spectator |
| `turn {n, intents}` | every 100 ms |
| `catchUp {fromTurn, toTurn, turns}` | after `gameStart` when the game is already running; lists only non-empty turns |
| `presence {players, spectators}` | who is connected (in game) |
| `desync {turn, yourHash, majorityHash, agreeing, total, details}` | your hash differs from the majority's (once) |
| `error {code, message}` | a message was refused |
| `pong {t, serverTime}` | answer to ping |
| `kicked {reason}` | the host removed you or the lobby closed |
| `gameOver {reason, winner, turn}` | the end: `finished` (majority of players reported), `abandoned`, `maxDuration` |

**Building the game from `gameStart`.** `settings` is a full `GameSettings` (seed included). Players: every
`playerSlots` entry is a human with id 1..H in order, then `settings.aiCount` AI nations, then the tribes, exactly
like `createGame` orders them. `teams` (teams mode) gives `byPlayer[playerId]` = team for humans and AI nations;
teammates are permanently allied, can't break the alliance or attack each other, and win together. Tribes have no
team.

**Client loop rules.** Process turns strictly in order; never apply your own actions locally (send `intent` and wait
for the turn: about 100-200 ms of delay, no prediction). After a `catchUp`, the next live turn is `toTurn`.

**Lobbies.**
- Private: 6-character code from `ABCDEFGHJKLMNPQRSTUVWXYZ23456789`. The host changes settings, kicks, starts. If the
  host leaves before the start, the next player becomes host; an empty lobby closes. Up to 16 humans (setting
  `maxPlayers`), plus spectators.
- Public: the server always keeps one **FFA** and one **Teams** lobby open. The countdown (60 s by default) starts
  when the first player joins; a full lobby starts at once. AI nations fill the game (8 / 12 / 16 nations on small /
  medium / large maps; in teams mode a multiple of the team count). Maps rotate through `PUBLIC_ROTATION` in
  `server/hub.ts`; team counts through 2, 3, 2, 4. Players who dropped out before the start lose their place.
- A disconnected player keeps a lobby place for 30 s and a game seat for the whole game (the nation idles meanwhile).
  A game with no connected player ends after 60 s; every game ends after 4 hours.

**Limits.** 16 KB per message, 30 messages/s per connection (bursts of 60; a long flood closes the socket), 10 intents
per player per turn, 8 connections per IP, `hello` within 10 s, connections silent for 45 s are closed, WebSocket
pings every 15 s keep proxies from cutting idle sockets. Invalid messages get `error` (200 of them close the socket).

## 3. Running it locally

Needs Node 22.

```bash
npm install
npm run dev        # Vite on http://localhost:5173 + game server on 8787 (/ws is proxied, so same-origin works)
npm test           # all tests, including tests/server.test.ts
npm run build      # dist/ (client) + server-dist/index.js (server)
npm start          # production server: serves dist/ and /ws on http://localhost:8080 (PORT to change)
```

To play against yourself, open two browser windows (a private window gets its own clientId) and join the same code.
Other people on your network can join with your machine's address (`npm start`, then `http://<your-ip>:8080`).

Server environment variables:

| Variable | Default | Meaning |
|----------|---------|---------|
| `PORT` | 8080 | HTTP + WebSocket port |
| `HOST` | 0.0.0.0 | listen address |
| `STATIC_DIR` | `dist` next to the server | folder with the built client; empty = don't serve files |
| `PUBLIC_START_SECONDS` | 60 (15 in `npm run dev`) | public lobby countdown |
| `PUBLIC_LOBBIES` | 1 | `0` = no public lobbies |
| `MAX_CONNECTIONS_PER_IP` | 8 | |
| `MAX_ROOMS` | 500 | lobbies + games at once |
| `TRUST_PROXY` | auto (on with `RENDER` / `FLY_APP_NAME`) | take the client IP from `Fly-Client-IP` / `X-Forwarded-For` |
| `ALLOWED_ORIGINS` | any | comma list of page origins allowed to open the WebSocket |
| `DEV_SERVER_PORT` | 8787 | game server port inside `npm run dev` |

Health check: `GET /health` returns `{"ok":true, "sessions":..., "rooms":..., "games":..., "players":...}`.

## 4. Where the client finds the server

The client's multiplayer server URL is, in this order:

1. the page's `?server=` parameter, e.g. `https://you.github.io/borderfall/?server=wss://borderfall.onrender.com`;
2. the build-time variable `VITE_SERVER_URL` (e.g. `VITE_SERVER_URL=wss://borderfall.onrender.com npm run build`);
3. the page's own origin (`wss://<same host>/ws`): right when the page is served by the game server itself.

`resolveServerUrl()` in `src/net/protocol.ts` implements this (`http(s)://` becomes `ws(s)://`, `/ws` is added when
the URL has no path).

**GitHub Pages and the server.** GitHub Pages can only host static files: it serves the single-file client, and
single player works there fully offline. For online games the page needs a server elsewhere (Render, Fly.io, your
PC). Either build the Pages copy with `VITE_SERVER_URL` set to the server, or share links with `?server=`. Easiest of
all: the Render/Fly server serves the client too, so its own URL (e.g. `https://borderfall.onrender.com`) is a
complete game with multiplayer and nothing else to configure. Pages is served over HTTPS, so the server URL must be
`wss://` (Render and Fly give you HTTPS automatically).

All players must run the same client build (the sim must be identical). The server refuses to put clients with
different `build` ids in one lobby, and a protocol change (`PROTOCOL_VERSION`) makes old pages reload.

## 5. Deploying for free on Render (step by step)

Render's free web service runs this server at no cost. Limits: it **sleeps after 15 minutes without visitors** and
the first visit after that takes about a minute to wake it up; a restart (deploy, sleep) ends running games.

1. Put the project on GitHub (your own repository; it can be private).
2. Create an account at <https://render.com> (sign in with GitHub is easiest).
3. In the Render dashboard click **New** -> **Blueprint**, choose your repository and confirm. Render reads
   `render.yaml` from the repository: one free web service named `borderfall`, built with
   `npm ci --include=dev && npm run build`, started with `npm run start`, health check `/health`.
   (Without the blueprint: **New** -> **Web Service**, pick the repository, Language **Node**, Build Command
   `npm ci --include=dev && npm run build`, Start Command `npm run start`, Instance Type **Free**, then under
   Advanced set Health Check Path `/health` and an environment variable `NODE_VERSION` = `22`.)
4. Wait for the first build (a few minutes). The log ends with `Borderfall server on port 10000`.
5. Open the URL Render shows (like `https://borderfall-xxxx.onrender.com`). That page is the full game; multiplayer
   connects to the same address. Send the link to friends.
6. Every push to the repository's main branch redeploys automatically (`autoDeploy`).

Keep **one instance**: lobbies and games live in the memory of one process, so more instances would split players.

## 6. Alternative: Fly.io

Fly.io runs the Docker image from `Dockerfile` (it needs a credit card; a single small machine that stops when unused
costs very little or nothing within their allowances, check their current pricing).

1. Install `flyctl` (<https://fly.io/docs/flyctl/install/>) and run `fly auth signup` (or `fly auth login`).
2. In the project folder: edit `fly.toml` and change `app = "borderfall-change-me"` to a free name, and
   `primary_region` to one near your players (`fly platform regions`).
3. `fly launch --no-deploy --copy-config` (answer *no* to databases), then `fly deploy --ha=false`.
   `--ha=false` keeps **one** machine, which is required (games live in memory).
4. Open `https://<your-app>.fly.dev`. Logs: `fly logs`. The machine stops when nobody is connected and starts again
   on the next visit (a few seconds).

## 7. Other hosting

Anything that runs a Docker image or Node 22 and supports WebSockets works:
`docker build -t borderfall . && docker run -p 8080:8080 borderfall`, or `npm ci && npm run build && npm start`.
Behind your own nginx/Caddy, forward `/ws` with the WebSocket upgrade headers and set `TRUST_PROXY=1`.
