# Borderfall: game design and code contract

Borderfall is a single-player (vs AI nations) territory-control strategy game in the browser, in the spirit of
OpenFront: a pixel map, nations that grow by pushing their borders, troops that regrow from population. It adds
more decisions that matter: three land troop types with counters, terrain that favours some troops over others,
supply lines, 17 buildings, a research tree, navy, air power, missiles and diplomacy.

All balance numbers live in `src/sim/config.ts`. This document explains them; if the two disagree, config wins.

## 1. Architecture

```
src/sim/      deterministic simulation, no DOM, no Math.random (use state.rng), no Date
  types.ts      all shared types (GameState, Player, Attack, Unit, Action ...)
  config.ts     all balance data (terrain, troops, buildings, techs, units)
  rng.ts        seeded RNG (mulberry32)
  grid.ts       tile index helpers, neighbours, distance fields
  mapgen.ts     procedural maps (terrain + resources)
  state.ts      createGame(settings), spawning
  economy.ts    population, gold, iron, oil, science, troop production, army mix conversion
  buildings.ts  build rules, building lookups (defence at a tile, supply sources ...)
  tech.ts       research
  combat.ts     attacks: land expansion, player vs player fronts, supply, losses, retreat
  units.ts      mobile units: transports, warships, trade ships, bombers, fighters, missiles
  diplomacy.ts  alliances, requests, betrayal, AI opinion
  ai.ts         AI nations (produce Actions, never touch state directly except via applyAction)
  actions.ts    validate + apply player/AI actions
  victory.ts    win / lose detection, scores
  sim.ts        tick(state): runs every system in a fixed order
src/client/   browser only
  main.ts       boot, main menu, game loop (fixed 10 ticks/s sim, render every animation frame)
  renderer.ts   canvas: terrain, territory, borders, buildings, units, attack fronts, effects
  camera.ts     pan / zoom / screen<->tile
  input.ts      mouse + keyboard -> Actions / UI state
  hud.ts        DOM panels (top bar, build bar, attack panel, research, diplomacy, leaderboard, log, tooltips)
  styles.css
tests/        vitest unit tests for the sim
scripts/headless.ts   run an AI-only game without a browser and print stats (balance checks)
```

Rules for the sim:
- Pure TypeScript, no DOM. Deterministic given `settings.seed` and the action list. Use `state.rng()` only.
- No TypeScript `enum`s or namespaces (keep syntax erasable). Use `as const` objects and string unions.
- Tick = 100 ms of game time (`TICK_SECONDS = 0.1`). All rates in config are per second; multiply by `TICK_SECONDS`.
- Map: `width * height` tiles, index `i = y * width + x`. Typed arrays in `GameState.map`.
- Owner 0 = nobody. Players have ids 1..N. `state.players[id]` (index 0 is a placeholder neutral entry).
- Systems communicate only through `GameState`. The client reads `GameState` and sends `Action`s through
  `applyAction(state, playerId, action)`. Same path for AI.
- Events for the UI (captures, buildings destroyed, alliance requests, research done, eliminated ...) are pushed to
  `state.events` (the client drains it every frame; the sim caps it at 200).

## 2. Map and terrain

Tile terrain: deep water, shallow water (coast), plains, forest, hills, mountains, desert, swamp, tundra.
Water is impassable for land attacks; only transports cross it.

| Terrain   | pop/tile | defence x | attack speed x | infantry atk | armor atk | artillery atk | build |
|-----------|---------:|----------:|---------------:|-------------:|----------:|--------------:|-------|
| Plains    | 30 | 1.0 | 1.0 | 1.0 | 1.3 | 1.0 | all |
| Forest    | 20 | 1.4 | 0.7 | 1.15 | 0.6 | 0.8 | all |
| Hills     | 15 | 1.6 | 0.6 | 1.1 | 0.8 | 1.2 | all |
| Mountains | 5  | 2.5 | 0.35 | 1.2 | 0.35 | 0.6 | not Farm/Airfield |
| Desert    | 6  | 0.9 | 0.9 | 0.85 | 1.2 | 1.0 | not Farm |
| Swamp     | 8  | 1.3 | 0.5 | 1.0 | 0.4 | 0.6 | not Farm/Airfield/Silo |
| Tundra    | 8  | 1.1 | 0.8 | 0.9 | 0.9 | 1.0 | not Farm |

Resources (a tile may hold one): Iron (hills/mountains), Oil (desert/swamp/tundra), Fertile (plains near water).
Mines / Oil Wells must be built within 2 tiles of a matching deposit they own; Farms on Fertile tiles produce double.

Map types: continents, pangaea, archipelago, highlands. Sizes: small 300x200, medium 420x280, large 560x360.
Generated with seeded fractal value noise (elevation + moisture + latitude).

## 3. Economy

Each player has: population split into **workers** and **army** (infantry + armor + artillery; every unit is one
person), gold, iron, oil, science.

- Max population = sum over owned land tiles of pop/tile + `CITY_POP` per city level + capital bonus.
- Growth/s = `POP_GROWTH * pop * (1 - pop/maxPop)` + farm bonus, minimum `MIN_GROWTH` while below max.
- **Army ratio** slider (10%..90%, default 40%): new population goes to infantry until army/pop reaches the ratio,
  otherwise to workers. Lowering it below the current share slowly demobilises infantry into workers.
- Gold/s = workers * `GOLD_PER_WORKER` * (1 + markets bonus + Banking) + trade ship deliveries.
- Iron/s = mines * `IRON_PER_MINE` (Metallurgy x1.5). Oil/s = wells * `OIL_PER_WELL`.
- Science/s = `BASE_SCIENCE` + labs * `SCIENCE_PER_LAB`.
- Upkeep: armor burns oil (`ARMOR_OIL_UPKEEP` per unit/s). With no oil, armor fights at 50%.
  Aircraft burn oil too. Negative stocks are clamped to 0.
- **Army mix** (player sets target shares for armor and artillery, rest infantry). Factories convert infantry to
  armor and Arsenals convert infantry to artillery automatically, at a rate per building, paying gold + iron per unit,
  until the target shares are met. Industrialization doubles the rate.

## 4. Land troops and combat

Three troop types. Each unit counts as one person.

| Type | attack | defence | speed bonus | cost to convert | notes |
|------|-------:|--------:|------------:|-----------------|-------|
| Infantry | 1.0 | 1.0 | 0 | free (grows from population) | best in forest/hills/mountains |
| Armor | 2.2 | 1.5 | +fast on open ground | 4 gold + 0.5 iron, burns oil | strong on plains/desert, poor in rough terrain |
| Artillery | 1.6 | 0.6 | slows fronts | 3 gold + 0.6 iron | x2.5 vs fortified tiles, fragile if unescorted |

Matchups (attacker type vs defender type multiplier):

|            | vs Infantry | vs Armor | vs Artillery |
|------------|-----:|-----:|-----:|
| Infantry   | 1.0 | 0.8 | 1.3 |
| Armor      | 1.4 | 1.0 | 1.6 |
| Artillery  | 1.3 | 0.7 | 1.0 |

**Attacks.** The player picks a target (a neutral tile or an enemy tile) and sends a share (1-100%) of their army
using the attack panel's composition (all types proportionally by default, or custom shares). That force becomes an
`Attack` on the front between attacker and target. Each tick an attack captures up to `speed` tiles from its frontier
(tiles of the target bordering the attacker), nearest to the clicked point first, and pays for each:

- Tile defence = (neutral: `NEUTRAL_TILE_DEF`; enemy: defender density = defender's defence power / defender tiles)
  x terrain defence x fort multiplier at that tile x defender tech/traitor/supply modifiers.
- Attacker power per unit = composition-weighted (type attack x terrain attack multiplier x matchup vs the defender's
  composition x artillery fort bonus if the tile is fortified) x supply efficiency x tech bonuses
  x combined-arms bonus.
- Attacker loses `tileDefence / powerPerUnit` units (split across types weighted by count and vulnerability:
  infantry 1.0, armor 0.6, artillery 1.0, or 1.8 when artillery is more than 40% of the force).
- The defender loses `DEFENDER_LOSS_PER_TILE` x their density per enemy tile taken (split by their composition).
- Speed (tiles/s) = `BASE_ATTACK_SPEED` x terrain speed x (1 + armor share x `ARMOR_SPEED_BONUS`)
  x (1 - artillery share x 0.3) x Logistics, scaled up a little for bigger forces.
- An attack ends when its troops run out or it has no frontier left; leftover troops go home.
  `retreat` returns them early (10% lost).
- Two attacks of the same pair facing each other cancel troops first (counter-attack).
- Capturing a tile with a building captures the building (missile silos, SAMs, airfields are destroyed instead).
- Taking a player's capital: -30% of their gold, their capital moves to their biggest city (or a random tile).

**Supply.** Supply sources: capital, cities, supply depots (radius from config). A distance field is recomputed each
`SUPPLY_RECALC_TICKS`. Fronts beyond `SUPPLY_RANGE` tiles (Logistics +50%) from a source fight at reduced efficiency,
falling linearly to `MIN_SUPPLY_EFF` at 3x range. Defenders far from supply also defend at x0.85.

**Elimination.** A player with no tiles is eliminated; their units and attacks vanish.

## 5. Buildings

Built on an owned land tile (one per tile, `BUILDING_MIN_SPACING` apart except cities may cluster). Cost grows by
`COST_GROWTH` per copy the player already owns. Construction takes `buildTime` seconds; an unfinished building
does nothing. Some need a tech.

| Building | Effect | Needs |
|----------|--------|-------|
| City | +max pop, supply source, gold; levels 1-5 (upgrade by building on it again) | |
| Farm | +pop growth (x2 on Fertile) | plains/forest/hills/desert? see config |
| Market | +gold % | |
| Mine | +iron, within 2 tiles of Iron | |
| Oil Well | +oil, within 2 tiles of Oil | |
| Barracks | +infantry growth share, -5% infantry losses (max 3 count) | |
| Factory | converts infantry -> armor | |
| Arsenal | converts infantry -> artillery | |
| Fort | defence x2 in radius 10 (Fortification x2.5, radius 14) | |
| Supply Depot | supply source, +10% attack for fronts in radius | |
| Watchtower | intel: reveals enemy army sizes & composition in radius 40 (else shown as "?"), +20% def radius 6, early warning of incoming bombers/transports | |
| Port | coastal; trade ships, faster transports, warships | coast |
| Research Lab | +science | |
| Hospital | 25% of your attack losses return as workers | Medicine |
| Airfield | builds bombers / fighters | Flight |
| SAM Site | shoots down missiles / aircraft in radius 30 | Radar |
| Missile Silo | launches rockets and atom bombs | Rocketry |

## 6. Research

Science accumulates; the player picks one tech at a time (also pays gold to start). Tree:

- Tier 1: Agriculture, Metallurgy, Logistics, Fortification, Navigation
- Tier 2: Banking (Agriculture), Medicine (Agriculture), Mechanization (Metallurgy), Ballistics (Metallurgy),
  Flight (Logistics)
- Tier 3: Industrialization (Mechanization), Combined Arms (Mechanization + Ballistics), Radar (Flight),
  Rocketry (Ballistics)
- Tier 4: Nuclear Fission (Rocketry + Industrialization)

Effects in config (`TECHS`).

## 7. Navy, air, missiles (mobile units)

`Unit` objects with float positions, moving each tick.
- **Transport**: launched from your coast (any coastal tile; from a Port it is +60% faster and costs no gold) to a
  target coastal land tile. Carries troops (composition as sent). Path over water (BFS). On arrival it becomes an
  `Attack` from a 1-tile beachhead (the landing tile is captured first, paid like any tile). Can be sunk.
  Max 3 at sea per player (+2 per Port).
- **Warship** (Port, Navigation): patrols near its port or a set point; attacks enemy ships within 12 tiles;
  bombards enemy coastal troops slightly.
- **Trade ship**: each Port periodically sends one to a random Port of a player not at war with it (allied preferred).
  Delivered gold goes to both owners (scaled by distance). Enemy warships sink them.
- **Bomber** (Airfield, Flight): flies to a target tile; on arrival destroys buildings in radius 3 (chance each) and
  kills defender troops in radius; then flies home. SAMs and enemy fighters in range can shoot it down.
- **Fighter** (Airfield): stationed; intercepts enemy bombers within its airfield's radius (40).
- **Rocket** (Silo, Rocketry): fast missile, radius 4: destroys buildings, kills troops.
- **Atom bomb** (Silo, Nuclear Fission): radius 22: destroys buildings, kills 60-90% of the army share in the area,
  turns tiles neutral at the centre. Every AI that sees a nuke drops opinion of the launcher sharply.
- SAM: each SAM in range gets one intercept roll per incoming missile/aircraft (rocket 70%, atom 50%, bomber 35%).

## 8. Diplomacy

- Alliances: request -> other side accepts/rejects (AI decides from opinion and threat). Allies cannot attack each
  other, share intel, may trade. Alliances last `ALLIANCE_DURATION` s, then can be renewed.
- Breaking an alliance (`breakAlliance`, or attacking an ally after breaking) marks you **traitor** for
  `TRAITOR_DURATION` s: your defence x0.7 and every AI's opinion of you drops.
- AI opinion -100..100 per pair: shared borders, attacks, gifts, betrayal, relative size.
- `gift` gold or troops to a player raises their opinion.
- `embargo` stops trade ships between you and them.

## 9. Victory

Win by owning `VICTORY_LAND_SHARE` (default 75%) of all land tiles, or by being the last nation. Lose when your
territory is gone. Optional time limit: highest score wins. Score = tiles + pop/100 + buildings*50.

## 10. AI nations

Personalities change weights: Warlord (attack early, armor heavy), Turtle (forts, artillery, counter-attacks),
Merchant (cities, markets, ports, trade, alliances), Admiral (ports, warships, invasions), Balanced.
Difficulty Easy/Normal/Hard sets decision interval, how well they read the matchups and a small Hard income bonus.
AI acts every 1-2 s via `applyAction` only:
expand into neutral while there is any; build economy, then military buildings by personality; keep an army mix that
counters the strongest neighbour's composition and terrain; research; ally with strong neighbours it fears;
attack the neighbour with the best (their strength vs ours, terrain, supply) score; launch transports when boxed in;
use bombers / missiles once available; retreat failing attacks.

## 11. Client

- Main menu: map type, size, number of AI nations (2-15), difficulty, seed, your name & colour; How to play.
- Spawn phase (`SPAWN_SECONDS`): click a land tile to place your capital (else random).
- Canvas map: terrain colours, owned tiles tinted with the owner's colour, borders darker, attack fronts pulsing,
  buildings as icons when zoomed in, units as small sprites, explosion effects. Minimap in a corner.
- Controls: left click enemy/neutral = attack with the attack panel settings; left click own tile with a building
  selected = build; right click = context menu (build here / attack / alliance / launch transport / bomb / missile);
  drag or WASD/arrows = pan; wheel = zoom; Space = pause; 1-9/0/letters = building hotkeys; T = research;
  [ and ] = attack share; Esc = cancel.
- HUD: top bar (gold, iron, oil, science, population/max, army with type split, army ratio slider, game time, speed
  x1/x2/x4, pause); build bar with costs and disabled reasons; attack panel (share + composition); research tree
  modal; diplomacy / leaderboard panel (nations sorted by tiles, with ally/request/break/gift/embargo buttons);
  event log; hover tooltip (terrain, resource, owner, troops (or ? without intel), defence multiplier, supply);
  game over screen with stats.
