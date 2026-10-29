# Borderfall

Borderfall is a territory-control strategy game that runs in the browser. You start as a small patch of land on a
pixel map and grow by pushing your borders into neutral land and into your neighbours. Your population grows by
itself, your army is part of it, and every tile you take costs troops.

Strategy comes from many decisions that matter:

- **Three troop types that counter each other.** Infantry, armor and artillery each beat one type and lose to
  another. Factories and arsenals turn infantry into armor and artillery, so you choose the army mix.
- **Terrain.** Forests, hills, mountains, swamps, deserts and tundra change defence, attack speed and which troop
  type fights well there. Armor runs over plains and gets stuck in mountains.
- **Supply.** Fronts far from your capital, cities and supply depots fight weaker, so deep pushes need cities or
  depots behind them.
- **17 buildings.** Cities (5 levels), farms, markets, mines, oil wells, barracks, factories, arsenals, forts,
  supply depots, watchtowers, ports, research labs, hospitals, airfields, SAM sites and missile silos.
- **Resources.** Gold from workers and trade, iron from mines (armor and artillery cost iron), oil from wells
  (armor and aircraft burn it), and science for research.
- **A research tree** of 15 techs in 4 tiers, from Agriculture and Logistics to Rocketry and Nuclear Fission.
- **Navy, air and missiles.** Transports land troops on other coasts, warships sink them, trade ships earn gold
  between ports, bombers and fighters fight over airfields, and silos launch rockets and atom bombs.
- **Intel.** Without a watchtower nearby (or an alliance) you see an enemy's army only as "?".
- **Diplomacy.** Alliances, gifts, embargoes, and a traitor penalty for breaking an alliance.
- **AI nations** with personalities (Warlord, Turtle, Merchant, Admiral, Balanced) on three difficulty levels.

You win by holding 75% of the land or by being the last nation standing.

## How to play

1. Press **Play**, choose a map, the number of AI nations and the difficulty, and start.
2. During the spawn phase, click a land tile to place your capital. If you don't, a spot is picked for you.
3. Click neutral or enemy land to attack it. The attack panel sets how much of your army you send and its mix.
4. Build with the build bar or the hotkeys, then click your own land. Cities raise your population cap, farms
   speed up growth, markets add gold, and labs add science.
5. Press **T** to open the research tree and pick a tech.
6. Watch your supply (press **B**), keep fronts close to cities or depots, and use the nations panel for alliances.

The in-game **How to play** page lists the troop matchups, terrain effects and every building.

## Controls

| Input | Action |
|-------|--------|
| Left click | Attack neutral or enemy land; select your own tile; place a building in build mode |
| Right click | Context menu: build, attack, transport, bomb, missile, diplomacy |
| Drag, WASD or arrow keys | Pan the map |
| Mouse wheel | Zoom |
| 1-9, 0, Q, E, R, H, F, G, N | Building hotkeys (hold Shift to place several) |
| [ and ] | Attack share -/+ 10% |
| T | Research tree |
| B / V | Supply overlay / resource overlay |
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
# AI-only game, prints a table every 2 game minutes: seed, minutes, map size, AI count, map type
npm run headless -- 1 30 medium 8 continents

# Time spent per simulation system and tick-time percentiles: seed, minutes, map size, AI count
npm run profile -- 4 10 large 15
```

## Project structure

```
index.html            page shell
src/sim/              deterministic simulation: no DOM, no Math.random (seeded RNG in the game state)
  types.ts            shared types (GameState, Player, Attack, Unit, Action, ...)
  config.ts           all balance numbers: terrain, troops, buildings, techs, units, AI
  rng.ts              seeded random numbers (mulberry32)
  grid.ts             tile indexes, neighbours, distance fields, water paths
  mapgen.ts           procedural maps (continents, pangaea, archipelago, highlands)
  state.ts            game creation, spawning, tile ownership, capitals, elimination
  economy.ts          population, gold, iron, oil, science, upkeep, army mix conversion
  buildings.ts        build rules, costs, building lookups (forts, supply sources, intel)
  tech.ts             research
  combat.ts           attacks, fronts, losses, supply, counter-attacks, retreat
  units.ts            transports, warships, trade ships, bombers, fighters, rockets, atom bombs
  diplomacy.ts        alliances, requests, betrayal, opinion, gifts, embargoes
  ai.ts               AI nations (act only through actions, like the player)
  actions.ts          validates and applies player and AI actions
  victory.ts          win and loss detection, scores
  sim.ts              one tick (100 ms of game time): runs every system in a fixed order
src/client/           browser only
  main.ts             boot, game loop (10 ticks/s times the game speed), menu background game
  menu.ts             title screen, new game settings, how to play
  renderer.ts         canvas: terrain, territory, borders, buildings, units, fronts, effects, minimap
  camera.ts           pan, zoom, screen and tile coordinates
  input.ts            mouse and keyboard to actions and UI state
  hud.ts              panels: top bar, build bar, attack panel, research, nations, events, tooltips
  uiState.ts          client-side UI state
  styles.css
tests/                Vitest unit tests for the simulation and client helpers
scripts/headless.ts   AI-only game in the terminal
scripts/profile.ts    per-system timing of an AI-only game
docs/DESIGN.md        game design and code contract
```

The simulation only changes through `tick(state)` and `applyAction(state, playerId, action)`, and the same seed with
the same actions always gives the same game. The client reads the game state every frame and sends actions; the AI
uses the same action path as the player.
