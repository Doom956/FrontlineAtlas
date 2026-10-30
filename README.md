# Frontline Atlas

Frontline Atlas is a grand-scale territory-control strategy game that runs in the browser. You start as a small patch of
land on a huge pixel map (up to 2600x1600 tiles, generated or a real-world map) among a few AI nations and hundreds
of tribes, and grow by
pushing your borders into the wilderness and into your neighbours. Your troops regrow by themselves toward a cap
that your land and cities set, armies reach millions, and every tile you take costs troops.

A click picks who you attack, not a point: the whole shared border advances at once, faster the longer it is, so
early expansion floods outward and wars move as wide lines. The more troops you send compared with what the defender
has at home, the fewer you lose per tile. Troops regrow fastest at about 40% of the cap, so a full bar is wasted:
keep spending.

Strategy comes from many decisions that matter:

- **One troop pool, three troop types that counter each other.** Infantry, armor and artillery each beat one type
  and lose to another. Factories and arsenals turn part of the pool into armor and artillery, so you choose the
  army mix.
- **Terrain.** Forests, hills, mountains, swamps, deserts and tundra change defence, attack speed and which troop
  type fights well there. Armor runs over plains and gets stuck in mountains.
- **Supply.** Fronts far from your capital, cities and supply depots fight weaker, so deep pushes need cities or
  depots behind them.
- **17 buildings, few and levelled.** Cities, farms, markets, mines, oil wells, barracks, factories, arsenals, forts,
  supply depots, watchtowers, ports, research labs, hospitals, airfields, SAM sites and missile silos. Buildings
  stand well apart (10 to 15 tiles by map size); building again near one of the same type upgrades it (up to level
  6 for cities, 5 for most, 3 for SAMs, silos and airfields), and every effect grows with the level.
- **Resources.** Gold from your land, cities, markets and trade, iron from mines (armor and artillery cost iron),
  oil from wells (armor and aircraft burn it), and science for research. Deposits sit in small clusters.
- **A research tree** of 15 techs in 4 tiers, from Agriculture and Logistics to Rocketry and Nuclear Fission.
- **Navy, air and missiles.** Transports land troops on other coasts, warships sink them, trade ships earn gold
  between ports, bombers and fighters fight over airfields, and silos launch rockets and atom bombs. SAM sites never
  miss but only hold one shot per level: send more than they can load, or silence them first.
- **Paratroopers.** An airfield flies infantry behind the enemy lines: they take the landing tile and attack from
  inside (capitals, pockets, a second front). SAMs and fighters can shoot the cargo plane down.
- **Artillery barrages.** With enough artillery you shell enemy land near your border: troops die, forts and SAM
  sites there are silenced for 20 seconds, and the front stays where it is.
- **Doctrines.** From 5:00 you pick one of seven doctrines (Blitz, Fortress, Siege, Merchant, Naval, Air,
  Expansion) that makes one style moderately better and grows over 14 minutes; nothing is ever forbidden, and you
  can switch later for gold and a short adaptation. The game suggests three that fit your borders and economy.
- **Army sizes are public**; a watchtower nearby (or an alliance) also shows an enemy's troop mix.
- **Diplomacy.** Alliances, gifts, embargoes, and a traitor penalty for breaking an alliance.
- **AI nations** with personalities (Warlord, Turtle, Merchant, Admiral, Balanced) on three difficulty levels (8 by
  default, up to 40), and hundreds of small **tribes**, the main thing to conquer (120 on a small map, 200 on a
  medium one, 300 on large, huge and real-world maps; up to 600): weak filler peoples that never attack and accept
  any alliance. A tribe walled in by one nation joins it.
- **Maps that read well at scale**: continents with ragged fractal coasts, bays, fjords and islets, inland lakes,
  long mountain ranges that form chokepoints, big forests, deserts, tundra and swamps, island chains. Or one of 12
  **real-world maps** (World, Europe, Asia, Africa, the Americas, Oceania, the Middle East, the Mediterranean, the
  British Isles, East Asia, Scandinavia), where the AI nations are real countries that start at their capitals
  (docs/MAPS.md).
- **Modes, presets and modifiers** chosen before the game: free for all or teams, and rules such as peace time,
  random starts, a compact map, starting gold, faster income or growth, instant building, no alliances, no atom
  bombs, no air force (see below).
- **An advisor** that keeps your army mix countering your main enemy and picks research for you (on by default; you
  can switch either off, and choosing by hand switches it off), and suggests the next useful step in plain words.

You win by holding 75% of the land (60 to 90% with the Victory setting) or by being the last nation standing
(tribes don't count); in a teams game your team wins together. After 25 minutes the land you need drops by 1% a
minute, down to 50%; with the default setup AI-only games end in about 20 to 30 minutes (real-world World map about
35). A nation under 150 tiles (a tribe under 250) collapses when it is hit (a player gets the first 3 minutes to
grow first, with a warning when it is walled in), pockets surrounded by one nation are
annexed by it, and so is a tribe of any size walled in by one nation.

## Play online

Single player needs nothing but the page. For online games the page talks to a small Frontline Atlas server (it only
relays the players' actions; every browser runs the same deterministic simulation in lockstep):

- **Multiplayer** on the title screen lists the **public games** (Free for all, Teams, and Special with one to three
  random modifiers, shown as chips). Join one: it starts by itself when its countdown ends, and AI nations fill the
  free places (about 10 nations in all, plus lots of tribes).
- **Create private lobby**: the same setup screen as single player (map, nations, tribes, mode and teams, presets,
  modifiers) plus a seat count. Send the 6-character code (or the invite link) to your friends; they **Join** with
  it. The host changes the settings, kicks and presses Start; in a teams game everyone picks a team.
- **Watch** joins a game as a spectator: the whole map, no actions. A player whose nation falls keeps watching while
  the others play on; teammates are allied for the whole game and win together.
- Online there is no game speed (the server's clock); only the host of a private game can pause. If your connection drops the game reconnects by
  itself and catches up; reloading the page brings you back into your game.

To host your own server: `npm run build && npm start` serves the game and the multiplayer server on
http://localhost:8080 (`PORT` to change); friends on your network open `http://<your-ip>:8080`. Free hosting on
Render or Fly.io, how a static copy (e.g. GitHub Pages) finds a server (`?server=` or `VITE_SERVER_URL`) and every
server setting: [docs/MULTIPLAYER.md](docs/MULTIPLAYER.md).

The published page lives at https://doom956.github.io/FrontlineAtlas/ (the GitHub repository will be renamed to
`FrontlineAtlas`).

## How to play

1. Press **New game**. Pick a preset or set things up yourself: the map (a generated type and size, or a real-world
   map), AI nations and tribes, difficulty, free for all or teams, and the modifiers. Press **Start game**. Your last
   settings are remembered.
2. During the spawn phase, click a land tile to place your capital (click again to move it), then start at once
   or wait for the timer. If you don't pick, a spot is picked for you.
3. Click neutral or enemy land to attack its owner: the whole border with them moves. ATTACK in the bottom bar (keys
   [ and ]) sets how much of your army you send; the Army drawer (U) sets its mix. Clicking the same target again adds troops to the running attack; hitting back
   at a nation that attacks you cancels its attack first. Land across water gets a transport from your nearest
   coast. Retreating costs a quarter of the troops (nothing in the wilderness).
4. Build with the build bar or the hotkeys, then click your own land. Clicking near one of your buildings of the
   same type (within 12 tiles) upgrades it; otherwise the building snaps to the nearest valid tile of yours within 10
   tiles. Cities raise your troop cap, farms raise the cap and speed up growth, markets add gold, and labs add
   science.
   The preview at the cursor says what a click does: green builds, blue upgrades, red explains why not.
   The Army (U) and Research (T) drawers each have an **Auto** toggle; setting a mix or picking a tech by hand turns
   it off.
5. Press **T** to open research and pick a tech.
6. Watch your supply (press **B**), keep fronts close to cities or depots, and click a nation in the standings (or
   right-click its land) for alliances, gifts and embargoes.

Hover any tile for what its terrain and resource do; press **L** for the map key. The advisor line above the bottom
bar suggests a next step (switch it off in the menu), and the first game starts with a short tutorial.

The in-game **How to play** page lists the troop matchups, terrain effects and every building.

## Game setup: modes, presets and modifiers

The setup screen (single player) and the multiplayer lobby share one options model (`src/sim/setup.ts`); the sim
enforces every rule (`src/sim/rules.ts`), refuses what is off with a plain reason, and the AI plays by it too.

- **Map**: Continents, Pangaea, Archipelago or Highlands in four sizes, or a real-world map (previews on the setup
  screen are drawn from the map data).
- **Players**: AI nations (default 8; multiplayer about 10 nations including the humans) and tribes (Auto = by the
  map's land).
- **Mode**: free for all, or 2 to 6 teams. Teammates are allied for the whole game, cannot attack each other and win
  together with their land added up. In single player you lead team 1.
- **Presets**: Classic (the defaults), Quick Conquest (small map, 4 nations, 220 tribes, fast game: about 15 to 25
  minutes), Grand War (the World map with 20 nations), Island Hopping (archipelago, no air force), Chaos (2 to 4
  random modifiers, pick it again to re-roll). Changing anything makes it Custom.

| Group | Modifier | What it does |
|---|---|---|
| Economy | Starting gold | Normal (600), High (5,000) or Very high (20,000) gold for every nation |
| Economy | Gold income | x0.5 to x3 |
| Economy | Troop growth | x0.5 to x2 |
| Economy | Build speed | Normal, Fast (a third of the time) or Instant |
| Economy | Research | Normal, All unlocked (every tech from the start) or Off (what needs a tech stays locked). Labs are off in both |
| Combat | Peace time | 2, 4 or 6 minutes in which nations can't attack each other (tribes can be attacked) |
| Combat | No atom bombs | silos launch rockets only |
| Combat | No air force | no airfields, bombers, fighters or paratroopers |
| Combat | No warships | transports and trade ships still sail |
| Combat | No SAM sites | |
| Rules | Random starts | every start is picked at random, yours too |
| Rules | Compact map | half the width and height (a quarter of the land) and fewer tribes by default |
| Rules | No alliances | teammates stay allied |
| Rules | Fast game | income, troop growth, building, research and fronts at double speed |
| Rules | Time limit | 15, 30 or 60 minutes, then the highest score wins |
| Rules | Victory | the land share that wins: 60, 70, 75, 80 or 90% |

In the game the active modifiers show as small chips under the top-right buttons (hover for what they do); peace
time counts down there.

## Controls

| Input | Action |
|-------|--------|
| Left click | Attack neutral or enemy land; select your own tile; place a building in build mode |
| Right click (or long-press on touch) | Radial menu: the likely action in the centre, the rest on a ring (build submenu, attack, transport, bomb, missile, diplomacy) |
| Drag, WASD or arrow keys | Pan the map |
| Mouse wheel | Zoom |
| 1-9, 0, Q, E, R, H, F, G, N | Building hotkeys (hold Shift to place several) |
| [ and ] | Attack share -/+ 10% |
| T / U / P / J / L | Research / Army / Diplomacy / Events / Map key drawers |
| B / V / M | Supply overlay / resource overlay / minimap |
| C | Centre on your capital |
| Space | Pause (single player) |
| + and - | Game speed (x1, x2, x4; single player) |
| ? or F1 | Help |
| Esc | Cancel or close |

## Development

You need Node.js 22 or newer.

```sh
npm install        # install dependencies
npm run dev        # start the dev server (Vite) and open the printed URL
npm test           # run the unit tests (Vitest), including the multiplayer server and the lockstep runner
npm run typecheck  # TypeScript check without building
npm run build      # type-check and build dist/index.html, a single self-contained file
```

`dist/index.html` has all scripts and styles inlined, so you can open it straight from disk or put it on any static
host. `npm run dev` also starts the multiplayer server (open two browser windows, one private, to play yourself);
`npm run build && node tests/e2e/mp.e2e.mjs` runs the browser end-to-end test of online play (Playwright: three
players in a private teams game, a spectator, reconnects, a forced desync and a public lobby; screenshots in
/tmp/borderfall-shots/).

Balance and performance tools that run without a browser:

```sh
# AI-only game, prints a table every 2 game minutes and the final army mix:
# seed, minutes, map size, AI count, map type, tribes (AIs and tribes default to the map size's)
npm run headless -- 1 30 medium 8 continents

# Time spent per simulation system and tick-time percentiles (p50 / p95 / p99), biggest army, memory
npm run profile -- --size huge --ai 50 --tribes 300 --minutes 20

# Many AI-only games in parallel: winners and game length, army mixes, buildings, snowball, navy and air, ms/tick.
# --sizes also takes real-world maps (world:europe), --mods sets modifiers (fastGame,peaceMinutes=4,noNukes)
npx vite-node scripts/batch.ts -- --sizes medium,large,world:world --seeds 8 --jobs 4
# Doctrine balance: picks, switches and win share per doctrine (--doctrines random = a random doctrine per nation)
npx vite-node scripts/batch.ts -- --sizes medium,world:world --seeds 16 --minutes 45 --doctrines random
```

## Project structure

```
index.html            page shell
src/sim/              deterministic simulation: no DOM, no Math.random (seeded RNG in the game state)
  types.ts            shared types (GameState, Player, Attack, Unit, Action, ...)
  config.ts           all balance numbers: terrain, troops, buildings, techs, units, AI
  rng.ts              seeded random numbers (mulberry32)
  grid.ts             tile indexes, neighbours, distance fields, water bodies and ship routes
  setup.ts            the options chosen before a game: defaults, presets, validation, modifier labels
  rules.ts            modifiers and teams in play: what is refused (with a reason), rate multipliers, peace time
  mapgen.ts           procedural maps (continents, pangaea, archipelago, highlands)
  worldmaps.ts        real-world maps (baked data in src/maps/, docs/MAPS.md), compact versions
  state.ts            game creation, spawning, tile ownership, capitals, elimination
  territory.ts        border sets, land weights and deposit lists kept up to date on every capture
  changes.ts          tile change feed for the renderer
  economy.ts          troop pool (cap and growth), gold, iron, oil, science, upkeep, army mix conversion
  buildings.ts        build orders (upgrade or snap), levels, costs, building lookups (forts, supply, intel)
  tech.ts             research
  combat.ts           attacks, whole-border fronts, odds, losses, supply, counter-attacks, retreat, collapse
  endgame.ts          enclave annexation
  advisor.ts          army mix and research advice (AI and players on auto), plain-language hints (suggestions)
  barrage.ts          artillery barrages (telegraphed shelling, silences forts and SAMs)
  doctrines.ts        mid-game doctrines: unlock, choose / switch, levels, bonus lookups, advice
  fmath.ts            deterministic exp / log / pow (bit-identical in every browser)
  hash.ts             state hash for desync detection
  units.ts            transports, warships, trade ships, bombers, fighters, rockets, atom bombs, paratroopers
  diplomacy.ts        alliances, requests, betrayal, opinion, gifts, embargoes
  ai.ts               AI nations (act only through actions, like the player)
  actions.ts          validates and applies player and AI actions
  victory.ts          win and loss detection, scores
  sim.ts              one tick (100 ms of game time): runs every system in a fixed order
src/client/           browser only
  main.ts             boot, game loop (10 ticks/s times the game speed), menu background game, online sessions
  menu.ts             title screen and how to play
  lobby.ts            multiplayer pages: public lobby list, join by code, private lobby (reuses the setup screen)
  mpgame.ts           online lockstep runner: turns from the server, intents out, hashes, catch-up
  setupScreen.ts      the New game screen: map with previews, players, presets, modifiers (remembered)
  mapThumbs.ts        map previews drawn from map data
  dom.ts              small DOM helpers
  labels.ts           nation name placement (largest fitting rectangle)
  placement.ts        build snapping and upgrades as the sim resolves them (resolveBuildTarget)
  radial.ts           right-click radial menu
  compat.ts           client helpers for tribes, rules text and attack odds
  renderer.ts         map renderer: WebGL2 map layer (render/glmap.ts, shaders.ts) + Canvas2D overlay
  render/             renderer parts: tile feed, map layers, buildings, deposits, units, labels, minimap
  icons.ts            detailed icons and simplified map markers (buildings, deposits, units incl. the cargo plane)
  hud/                HUD parts: command bar, standings, top-right cluster, drawers, nation card, map tooltip,
                      toasts, advisor and tutorial, radial menu contents, pictograms, plain-word texts
  simx.ts             client helpers over sim features (build targets, public armies, advice, paradrop, barrage)
  fonts.ts            bundled fonts
  audio.ts            procedural sound effects and music (docs/AUDIO.md)
  camera.ts           pan, zoom, screen and tile coordinates
  input.ts            mouse and keyboard to actions and UI state
  hud.ts              the HUD: command bar, standings, cluster, drawers, toasts, advisor (parts in hud/)
  uiState.ts          client-side UI state
  styles.css
src/net/              online play: protocol.ts (the wire protocol, shared with the server), client.ts (WebSocket
                      connection, reconnects, ping)
server/               the multiplayer relay server (Node, ws): lobbies, turns, hash votes (docs/MULTIPLAYER.md)
tests/                Vitest unit tests for the simulation, the server and client helpers; e2e/ browser test
scripts/headless.ts   AI-only game in the terminal
scripts/profile.ts    per-system timing of an AI-only game
scripts/batch.ts      balance batch runner (many games in parallel)
docs/DESIGN.md        game design and code contract
docs/MAPS.md          the real-world maps: sources, how they are baked, the API
docs/MULTIPLAYER.md   online play: the server (server/), the protocol (src/net/protocol.ts), deploying
```

The simulation only changes through `tick(state)` and `applyAction(state, playerId, action)`, and the same seed with
the same actions always gives the same game. The client reads the game state every frame and sends actions; the AI
uses the same action path as the player.
