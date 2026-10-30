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

**Desync check.** Every 10 turns each client sends `hashState(state)`. The server takes a majority vote among the
players and tells the clients that differ (`desync`); the client shows a warning and offers a reload (a reload rejoins
and replays). Without a strict majority of players (two players who disagree), spectators in sync break the tie; when
there is still no majority nobody is marked out of sync: each client gets one soft notice (`desync` with
`majorityHash: null`) and later turns keep being checked.

**Reconnects and spectators.** The server keeps the game's non-empty turns in memory while it runs, each serialized
once (empty turns are only counted). A player who reconnects with the same `clientId` (kept in localStorage) gets
`gameStart` and the turns it misses: `hello.resume {code, haveTurns}` says which game the client still holds and the
next turn it needs, so after a short drop only the gap is sent (a fresh page or a Reload asks from turn 0). A long
history is sent as several `catchUp` messages of about 512 KB, each only once the socket has drained, and the live
turns follow the last one. Spectators join a running game by its code the same way, with player id 0 (`joinLobby
{haveTurns}` when they rejoin). Nothing is stored on disk; no database.

### Files

| Path | What |
|------|------|
| `src/net/protocol.ts` | the wire protocol: every message type, constants, small helpers (shared by client and server) |
| `src/net/client.ts` | browser connection: `hello`, persistent clientId, reconnects with backoff, ping / latency, server clock |
| `src/client/mpgame.ts` | the lockstep runner: turn queue, catch-up, intents out, hashes out, desync / reload |
| `src/client/lobby.ts` | the Multiplayer pages: public list, join by code, private lobby (the setup screen in lobby mode) |
| `src/client/hud/mpStatus.ts` | in-game status line (connection, ping, players) and banners (reconnecting, catching up, out of sync) |
| `server/server.ts` | `startServer(options)`: HTTP (static client, `/health`) + WebSocket upgrade on `/ws` |
| `server/hub.ts` | connections, `hello`, rate limits, timeouts, lobby list, public lobby scheduler |
| `server/room.ts` | one lobby/game: members, host controls, start, turn loop, hash votes, game-over votes |
| `server/validate.ts` | hand-written validators for every client message and every `Action` |
| `server/options.ts` | server settings and their environment variables |
| `server/index.ts` | production entry (bundled to `server-dist/index.js`) |
| `scripts/dev.mjs` | `npm run dev`: Vite + server together |
| `tests/server.test.ts` | real WebSocket clients against an in-process server |
| `tests/multiplayer.test.ts` | several humans in the sim: seats, teams, victory, lockstep hashes whichever player a client controls |
| `tests/mpclient.test.ts` | the lockstep runner with a fake connection: order, catch-up, gaps, hashes, intents |
| `tests/e2e/mp.e2e.mjs` | browser end-to-end test (Playwright, run by hand after `npm run build`) |

## 2. Protocol (summary; `src/net/protocol.ts` is the reference)

JSON text frames, each an object with a `type`. Max 16 KB per client message.

**Client -> server**

| type | fields | notes |
|------|--------|-------|
| `hello` | `protocol, name, color [r,g,b], clientId, build?, resume?` | first message. `clientId`: random 16-64 chars (`makeClientId()`), kept in localStorage; it *is* your seat. `build`: client build id; a lobby only accepts one build. `resume {code, haveTurns}`: the game this client still holds; the catch-up starts at `haveTurns` |
| `createLobby` | `settings?` (`LobbySettingsPatch`: any `LobbySettings` fields, `modifiers` partial) | private lobby, you are the host |
| `joinLobby` | `code, spectate?, haveTurns?` | 6-character code; a running game makes you a spectator unless you have a seat there. For the room you are already in it only resends the lobby state |
| `leaveLobby` | | before the start you lose the place; in a game your nation stays (rejoin by code; a reconnect no longer puts you back). A game every player has left ends at once |
| `updateLobbySettings` | `settings` | host, private, before start |
| `setTeam` | `team` (0 = auto) | teams mode, before start |
| `kick` | `memberId` | host, private, before start |
| `startGame` | | host, private |
| `intent` | `action` | any `Action`; max 10 per player per turn and a steady budget (4 per second, bursts of 40) |
| `hash` | `turn, hash` | after processing turn n with (n+1) % 10 === 0 |
| `gameOver` | `turn, winner` | once, when the sim's phase becomes `over`. The game ends when a strict majority of the seated players in sync (connected, or dropped less than 3 minutes ago, not left on purpose) report the same winner, and at least 2 of them when there are 2 or more |
| `ping` | `t?` | every 5 s |

**Server -> client**

| type | when |
|------|------|
| `welcome {protocol, serverTime, resumed}` | answer to hello; `resumed` = code when you were put back into your lobby/game |
| `lobbyList {lobbies}` | public lobbies, while you are not in one (on change); each `{code, kind, mode, map, rules, chips, teamCount, players, maxPlayers, startsAt}` |
| `lobbyState {code, isPublic, kind, mode, hostMemberId, you, players, spectators, settings, startsAt, serverTime}` | every change in your lobby before the start; countdown = `startsAt - serverTime` |
| `gameStart {code, mode, settings, playerSlots, teams, yourPlayerId, startTurn, turnsPlayed, turnMs, hashInterval}` | the start (and on rejoin). `yourPlayerId` 0 = spectator |
| `turn {n, intents}` | every 100 ms |
| `catchUp {fromTurn, toTurn, turns}` | after `gameStart` when the game is already running; lists only non-empty turns; a long history comes in several in a row (each starts where the previous ended) |
| `presence {players, spectators}` | who is connected (in game) |
| `desync {turn, yourHash, majorityHash, agreeing, total, details}` | your hash differs from the majority's (once until you rejoin; spectators are checked too). `majorityHash: null`: the players disagree with no majority (a soft notice, sent once; checks go on) |
| `error {code, message}` | a message was refused |
| `pong {t, serverTime}` | answer to ping |
| `kicked {reason}` | the host removed you or the lobby closed |
| `gameOver {reason, winner, turn}` | the end: `finished` (majority of players reported), `abandoned`, `maxDuration` |

**Lobby settings.** `LobbySettings` is the shared game setup (`GameSetup`, src/sim/setup.ts and DESIGN section 12:
map generated or real-world, AI nations, tribes, difficulty, mode and teams, time limit, victory share, modifiers,
preset) plus `maxPlayers`, the same model the single-player setup screen edits. The server checks patches with
`setup.validateSetup` and merges them with `mergeSetup`; public lobbies rotate generated and real-world maps and fill
up to about 10 nations (`PUBLIC_NATIONS` by the map's size class). The lobby list (`LobbySummary`) carries `kind` (`ffa`,
`teams`, `special`), `map`, `rules` (`modifierSummary`, e.g. "Fast game, Peace 4 min") and `chips` (the active
modifiers: id, label, one-line detail). Protocol version 4.

**Building the game from `gameStart`.** `settings` is a full `GameSettings` (seed included) whose `humans` lists the
seats (name, colour, team) in player id order. On a real-world map load it first (`await
loadWorldMap(settings.map.id)`) and pass it: `createGame(settings, map, { teams: teams.byPlayer })`. Players: every
human with id 1..H in order (the same as `playerSlots`), then `settings.aiCount` AI nations, then the tribes, exactly
like `createGame` orders them. The client then sets `state.humanId = yourPlayerId` (0 for spectators): it only says
which nation this client shows and controls; the sim never reads it, so every client stays in lockstep. `teams` (teams mode) gives `byPlayer[playerId]` = team for humans and AI nations;
teammates are permanently allied, can't break the alliance or attack each other, and win together. Tribes have no
team.

**Client loop rules.** Process turns strictly in order; never apply your own actions locally (send `intent` and wait
for the turn: about 100-200 ms of delay, no prediction). After a `catchUp`, the next live turn is `toTurn`.

**Lobbies.**
- Private: 6-character code from `ABCDEFGHJKLMNPQRSTUVWXYZ23456789`. The host changes settings, kicks, starts. If the
  host leaves before the start, the next player becomes host; an empty lobby closes. Up to 16 humans (setting
  `maxPlayers`), plus spectators.
- Public: the server always keeps one **FFA**, one **Teams** and one **Special** lobby open (Special: free for all
  with 1-3 random modifiers from the Chaos pool, `setup.rollModifiers`; the rolled values are part of the settings). The countdown (60 s by default) starts
  when the first player joins; a full lobby starts at once. AI nations fill the game (8 / 12 / 16 nations on small /
  medium / large maps; in teams mode a multiple of the team count). Maps rotate through `PUBLIC_ROTATION` in
  `server/hub.ts` (each kind starts at a different place); team counts through 2, 3, 2, 4. Colours that clash
  (sum of channel differences up to 100) are replaced by a free palette colour at the start. Players who dropped out before the start lose their place.
- A disconnected player keeps a lobby place for 30 s and a game seat for the whole game (the nation idles meanwhile).
  A game with no connected player ends after 60 s, a game every player has left (`leaveLobby`, another lobby) at
  once; every game ends after 4 hours. A reconnect resumes the room you were in most recently, never a game you left.

**Limits.** 16 KB per message, 30 messages/s per connection (bursts of 60; a long flood closes the socket), 10 intents
per player per turn and 4 per second on average (bursts of 40; the client sends army-mix slider drags at most every
300 ms), 48 MB of stored turns per game (then intents are refused), 8 connections per IP, 3 open private lobbies or
games per IP and one `createLobby` per second, `hello` within 10 s, connections silent for 45 s are closed, WebSocket
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
| `MAX_ROOMS_PER_IP` | 3 | private lobbies + games one address may have open |
| `TRUST_PROXY` | auto (on with `RENDER` / `FLY_APP_NAME`) | take the client IP from the proxy's headers |
| `PROXY_HOPS` | 1 | proxies that append to `X-Forwarded-For`: the client IP is the entry this many places from the end (the first entries are what the client sent and are never used). If every player shows the same address (all hit the per-IP limit), set 2 |
| `CLIENT_IP_HEADER` | `fly-client-ip` on Fly, else none | a header the platform's proxy sets to the client IP; used before `X-Forwarded-For` |
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

## 8. The browser client

**Menu.** The title screen has Single player (no server involved), Multiplayer and How to play. Multiplayer opens a
connection (`NetClient`, `src/net/client.ts`) and shows the public games with their kind, map, modifier chips,
players and countdown, a Create private lobby button, and Join / Watch by code. Your name and colour are the same as
in single player (remembered). A lobby is the single-player setup screen in lobby mode (`SetupScreen` with a
`LobbySetupMode`): the host edits the same `GameSetup` (map, nations, tribes, mode and teams, presets, modifiers;
edits go out as `updateLobbySettings`, sliders at most every 180 ms), everyone else sees it read-only. The third
column holds the code (Copy, Copy link = `?lobby=CODE`), the seat count (host), the players with kick (host), team
choice (teams mode), the countdown, Start (host) and Leave. A page opened with `?lobby=CODE` joins that lobby.

**Connection.** `hello` carries a clientId kept in localStorage (`borderfall.clientId`; a fresh one per tab when
storage is blocked) and a build id (`VITE_BUILD_ID` at build time, else a fingerprint of the protocol version and the
balance data in `src/sim/config.ts`: clients with other rules never share a lobby; deploy all clients from one build,
since code changes that keep the balance data are not caught). A lost connection is retried after 0.3, 1, 2, 4, 8,
then every 12 s (with jitter); the server resumes the lobby or game (`welcome.resumed`). Close codes 4001 (another
tab took the seat) and 4003 (other protocol version) stop the retries. A ping every 5 s gives the latency and the
server clock offset (countdowns). The code of the current lobby or game is kept in localStorage
(`borderfall.mp.active`), so reloading the page goes straight back into it.

**Lockstep runner** (`MpGame`, `src/client/mpgame.ts`). On `gameStart` it builds the game (world maps load first;
turns that arrive meanwhile wait in the queue) and sets `humanId`. Every frame it runs the queued turns in order
(intents in array order, then one `tick`): normally the one or two that arrived; after a `catchUp` (joining late,
reconnecting, reloading) up to 200 per frame within a 24 ms budget (70 ms when more than 30 behind), so the page keeps
drawing and shows "Catching up… n%". Turns already run are skipped (a reconnect's catchUp only fills the gap); a
missing turn number triggers a reconnect, which brings a fresh catchUp. After turn n with (n + 1) % 10 === 0 it sends
`hash` (during a catch-up only for the last 10 turns), and `gameOver` once when the sim ends. Local actions from the
HUD and the map go through the same `dispatch` as offline, but online they are sent as `intent` and only applied
when their turn comes back (100-200 ms later, no prediction); the answer is optimistic, and if the sim refuses one of
your intents its reason shows as a toast. Pause and speed are hidden and ignored online; Start now shows only for the
private lobby's host (the server refuses it from others).

**Spectators and eliminated players.** Spectators (`yourPlayerId` 0, Watch, or anyone joining a running game without
a seat) see the whole map with the standings, events, map key and clock, without the command bar, radial menu or the
army / research / diplomacy drawers. Online, a player whose nation falls switches to the same view while the others
play on (the sim ends the game only when every human is out: in single player that is the one human). Teammates are
allied from the start and win together; AI nations fill the teams evenly (`setup.assignTeams`, used by the server
and by `createGame` when no teams are given).

**Desync.** When the server reports `desync`, a banner offers **Reload**: the client rejoins, the server sends
`gameStart` and every turn again, and the game is rebuilt and replayed from turn 0. The server forgets the desync
mark when the client rejoins, so its hashes count again. A simulation error on one client shows the same banner.

**Status in game** (`hud/mpStatus.ts`): a small line at the top centre with the connection, ping, players connected
and spectators; banners for reconnecting, loading, catching up, out of sync, and a game the server ended
(abandoned or its time limit).

**Test hooks** (`window.__borderfall`): `hash()` and `turn()` of the game shown, `hashes()` (turn -> hash sent, the
last 120), `mp()` (code, player id, turns run and queued, desync, connection status, latency, spectator) and
`dropConnection()` (closes the socket like a network failure). `tests/e2e/mp.e2e.mjs` uses them: A creates a private
teams lobby (small map), B joins by code, both pick a team, A starts, both spawn by clicking and play about a minute
(attacks by clicking, builds), C watches; A, B and C must report the same hashes for the same turns. Then B closes
its page and comes back, A's socket drops, C's state is broken on purpose and its Reload must fix it, and a public
FFA lobby (`PUBLIC_START_SECONDS=4`) must start by itself. Run it with `npm run build && node tests/e2e/mp.e2e.mjs`
(`PLAY_SECONDS` to change the play time).
