# Borderfall

Borderfall is a grand-scale territory-control strategy game that runs in the browser. You start as a small patch of
land on a huge pixel map (up to 2600x1600 tiles) among dozens of AI nations and hundreds of tribes, and grow by
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
- **Army sizes are public**; a watchtower nearby (or an alliance) also shows an enemy's troop mix.
- **Diplomacy.** Alliances, gifts, embargoes, and a traitor penalty for breaking an alliance.
- **AI nations** with personalities (Warlord, Turtle, Merchant, Admiral, Balanced) on three difficulty levels (10 to
  50 by default, up to 80), plus hundreds of small **tribes** (40 to 300, up to 500): weak filler nations that never
  attack, accept any alliance and are easy early targets.
- **Maps that read well at scale**: continents with ragged fractal coasts, bays, fjords and islets, inland lakes,
  long mountain ranges that form chokepoints, big forests, deserts, tundra and swamps, island chains.
- **An advisor** that keeps your army mix countering your main enemy and picks research for you (on by default; you
  can switch either off, and choosing by hand switches it off), and suggests the next useful step in plain words.

You win by holding 75% of the land or by being the last nation standing (tribes don't count). After 25 minutes the
land you need drops by 1% a minute, down to 50%; AI-only games end in about 20 to 35 minutes. A nation under 150
tiles (a tribe under 250) collapses when it is hit, and pockets surrounded by one nation are annexed by it.

## How to play

1. Press **Play**, choose a map and its size (small, medium, large or huge), the number of AI nations (the size sets
   a default) and the difficulty, and start.
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
| Space | Pause |
| + and - | Game speed (x1, x2, x4) |
| ? or F1 | Help |
| Esc | Cancel or close |

## Development

You need Node.js 20 or newer.

```sh
npm install        # install dependencies
npm run dev        # start the dev server (Vite) and open the printed URL
npm test           # run the unit tests (Vitest)
npm run typecheck  # TypeScript check without building
npm run build      # type-check and build dist/index.html, a single self-contained file
```

`dist/index.html` has all scripts and styles inlined, so you can open it straight from disk or put it on any static
host.

Balance and performance tools that run without a browser:

```sh
# AI-only game, prints a table every 2 game minutes and the final army mix:
# seed, minutes, map size, AI count, map type, tribes (AIs and tribes default to the map size's)
npm run headless -- 1 30 medium 20 continents

# Time spent per simulation system and tick-time percentiles (p50 / p95 / p99), biggest army, memory
npm run profile -- --size huge --ai 50 --tribes 300 --minutes 20

# Many AI-only games in parallel: winners and game length, army mixes, buildings, snowball, navy and air, ms/tick
npx vite-node scripts/batch.ts -- --sizes medium,large --seeds 8 --jobs 4
```

## Project structure

```
index.html            page shell
src/sim/              deterministic simulation: no DOM, no Math.random (seeded RNG in the game state)
  types.ts            shared types (GameState, Player, Attack, Unit, Action, ...)
  config.ts           all balance numbers: terrain, troops, buildings, techs, units, AI
  rng.ts              seeded random numbers (mulberry32)
  grid.ts             tile indexes, neighbours, distance fields, water bodies and ship routes
  mapgen.ts           procedural maps (continents, pangaea, archipelago, highlands)
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
  fmath.ts            deterministic exp / log / pow (bit-identical in every browser)
  hash.ts             state hash for desync detection
  units.ts            transports, warships, trade ships, bombers, fighters, rockets, atom bombs, paratroopers
  diplomacy.ts        alliances, requests, betrayal, opinion, gifts, embargoes
  ai.ts               AI nations (act only through actions, like the player)
  actions.ts          validates and applies player and AI actions
  victory.ts          win and loss detection, scores
  sim.ts              one tick (100 ms of game time): runs every system in a fixed order
src/client/           browser only
  main.ts             boot, game loop (10 ticks/s times the game speed), menu background game
  menu.ts             title screen, new game settings, how to play
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
tests/                Vitest unit tests for the simulation and client helpers
scripts/headless.ts   AI-only game in the terminal
scripts/profile.ts    per-system timing of an AI-only game
scripts/batch.ts      balance batch runner (many games in parallel)
docs/DESIGN.md        game design and code contract
```

The simulation only changes through `tick(state)` and `applyAction(state, playerId, action)`, and the same seed with
the same actions always gives the same game. The client reads the game state every frame and sends actions; the AI
uses the same action path as the player.
