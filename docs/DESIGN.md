# Borderfall: game design and code contract

Borderfall is a grand-scale territory-control strategy game in the browser: huge pixel maps (up to 2600x1600 tiles,
nearly 2 million land tiles), dozens of nations and hundreds of tribes, armies of millions, nations that grow by
pushing their whole borders, and one troop pool that regrows toward a cap. Strategy comes from many decisions that
matter: three land troop types with counters, terrain that favours some troops over others, supply lines, 17
levelled buildings, a research tree, navy, air power, missiles, paratroopers, artillery barrages and diplomacy.

Design direction: **simple surface, deep options.** The default screen reads like a classic territory game (solid
nation colours, names with army sizes, a troop bar and an attack slider); everything else is one click away,
explained in plain words, and the advisor (`suggestions`, section 3) points at the next useful thing to do.

All balance numbers live in `src/sim/config.ts`. This document explains them; if the two disagree, config wins.

## 1. Architecture

```
src/sim/      deterministic simulation, no DOM, no Math.random (use state.rng), no Date
  types.ts      all shared types (GameState, Player, Attack, Unit, Action ...)
  config.ts     all balance data (terrain, troops, buildings, techs, units)
  rng.ts        seeded RNG (mulberry32)
  fmath.ts      deterministic exp / log / pow (no Math.exp etc. in the sim)
  hash.ts       hashState(state): FNV-1a hash of the state for desync detection
  grid.ts       tile index helpers, neighbours, distance fields, water bodies and ship routes (A*)
  setup.ts      the options chosen before a game (GameSetup): defaults, presets, validation, modifier labels
  rules.ts      modifiers and teams in play: refusals with reasons, rate multipliers, peace time (section 12)
  mapgen.ts     procedural maps (terrain + resources)
  worldmaps.ts  real-world maps (docs/MAPS.md): list, load (async), compact version
  state.ts      createGame(settings, map?, opts?), spawning, setOwner (the single way to change a tile's owner)
  territory.ts  per-player data kept by setOwner: border sets, land weights, coast/deposit lists, block counts
  changes.ts    tile change feed for the renderer (recordTileChange / drainTileChanges)
  economy.ts    the troop pool (cap, growth), gold, iron, oil, science, upkeep, army mix conversion
  buildings.ts  build orders (resolveBuildTarget: upgrade or snap), levels and level-scaled effects, lookups
                (defence at a tile, supply sources, intel, armyTotalOf ...)
  tech.ts       research
  combat.ts     attacks on an owner: whole-border fronts, odds, supply (incl. beachheads), losses, retreat,
                counter-attacks, boats across water, collapse
  endgame.ts    enclave annexation (pockets surrounded by one nation), staggered per player
  advisor.ts    army mix and research advice (AI and players on auto), plain-language hints (suggestions)
  units.ts      mobile units: transports, warships, trade ships, bombers, fighters, missiles, cargo planes
                (paratroopers)
  barrage.ts    artillery barrages (telegraphed shelling near your border)
  diplomacy.ts  alliances, requests, betrayal, AI opinion
  ai.ts         AI nations (produce Actions, never touch state directly except via applyAction)
  actions.ts    validate + apply player/AI actions
  victory.ts    win / lose detection, scores
  sim.ts        tick(state): runs every system in a fixed order
src/client/   browser only
  main.ts       boot, main menu, game loop (fixed 10 ticks/s sim, render every animation frame); loads a world map
                before createGame; online sessions (lockstep runner instead of the fixed-step loop)
  mpgame.ts     online lockstep runner: turns from the server, intents out, hashes, catch-up (docs/MULTIPLAYER.md)
  lobby.ts      Multiplayer pages: public lobby list, join by code, private lobby (the setup screen in lobby mode)
  menu.ts       title screen, how to play; setupScreen.ts the New game screen; mapThumbs.ts map previews
  renderer.ts   map renderer (WebGL2 map layer + Canvas2D overlay), see "Map rendering" in section 11
  render/       renderer parts: tiles.ts (change feed mirror), glmap.ts + shaders.ts (WebGL2 map), map2d.ts
                (Canvas2D fallback), terrain.ts, buildings.ts, deposits.ts, units.ts, fronts.ts, names.ts,
                overlays.ts, minimap.ts
  icons.ts      pictogram library: detailed icons and simplified map markers (incl. the cargo plane)
  hud/          HUD parts: command bar, standings, cluster, drawers, nation card, map tooltip, toasts, advisor and
                tutorial, radial menu contents, glyphs (inline SVG pictograms), plain-word texts
  simx.ts       client helpers over sim features: build targets, levels, public armies, advice, paradrop, barrage
  fonts.ts      bundled fonts (FontFace API)
  camera.ts     pan / zoom / screen<->tile
  input.ts      mouse + keyboard -> Actions / UI state
  hud.ts        DOM HUD: wires the parts in hud/ (command bar, standings, cluster, drawers, toasts, advisor)
  styles.css
src/net/      protocol.ts (wire protocol, shared with server/), client.ts (WebSocket connection, reconnects, ping)
tests/        vitest unit tests for the sim
scripts/headless.ts   run an AI-only game without a browser and print stats (balance checks)
scripts/batch.ts      many AI-only games in parallel: winners, game length, mixes, buildings, snowball, ms/tick
scripts/profile.ts    per-system tick timing and percentiles (--size huge --ai 50 --tribes 300)
```

Rules for the sim:
- Pure TypeScript, no DOM. Deterministic given `settings.seed` and the action list. Use `state.rng()` only.
- Bit-identical in every browser (lockstep multiplayer): no `Math.sin/cos/tan/exp/log/log10/log2/pow/atan2/cbrt/
  hypot` and no `**` with a non-integer exponent in `src/sim` (their last bit differs between engines). Use
  `fmath.ts` (`expDet`, `logDet`, `powDet`, `powInt`). `+ - * /`, `Math.sqrt`, `floor/round/ceil/abs/min/max/imul`
  are exactly specified and fine.
- No module-level caches that outlive a game or are shared between two `GameState`s (the menu runs a background
  game next to the real one): derived data lives in a `WeakMap` keyed by the `GameState` (or by an object that
  belongs to one game, like an `Attack`). Pure scratch buffers that carry nothing between calls are allowed.
- `hashState(state)` (hash.ts) covers tick, RNG state, phase and spawn time, tile owners, players' stocks, troops and
  barrage reload, research (current tech, progress, techs), auto flags, traitor time and embargoes, alliances and
  alliance requests, attacks, units (incl. troops aboard), pending barrages and buildings (level, timers, hp); tests check that two games fed the same actions hash the same, also with another game ticking in
  between.
- No TypeScript `enum`s or namespaces (keep syntax erasable). Use `as const` objects and string unions.
- Tick = 100 ms of game time (`TICK_SECONDS = 0.1`). All rates in config are per second; multiply by `TICK_SECONDS`.
- Map: `width * height` tiles, index `i = y * width + x`. Typed arrays in `GameState.map`.
- Owner 0 = nobody. Players have ids 1..N. `state.players[id]` (index 0 is a placeholder neutral entry).
- Several humans (online): ids 1..H, then the AI nations, then the tribes. Every human is treated alike;
  `state.humanId` is a client-side notion (which nation this client shows and controls, 0 = spectator) that the sim
  never reads, so clients controlling different players stay in lockstep.
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

pop/tile / 30 is the tile's **land weight** (plains 1, mountains 0.17): it feeds the troop cap and gold (section 3).

Resources (a tile may hold one): Iron (hills/mountains), Oil (desert/swamp/tundra), Fertile (plains near water).
Mines / Oil Wells must be built within 2 tiles of a matching deposit they own; Farms on Fertile tiles count double.

**Grand scale.** Map sizes (`MAP_SIZES`): small 900x560, medium 1400x880, large 2000x1250, huge 2600x1600 (about
0.2M / 0.55M / 1.1M / 1.85M land tiles). Map types: continents, pangaea, archipelago, highlands. Generation
(mapgen.ts, deterministic arithmetic only) takes under 2 s for a huge map in Node:
1. Landmass layout per type (groups of soft blobs; island chains on archipelago), domain-warped continental noise on
   a coarse grid (a node every 2..5 tiles) upsampled bilinearly, so every field is smooth at the scale of the map.
2. Sea level from the type's land share, inland lakes carved, a few long mountain ranges walked across the land
   (with passes: chokepoints and natural borders) plus ridged hill belts.
3. **Fractal coasts**: the shore is moved by a displacement whose octaves have an amplitude proportional to their
   wavelength (S/5 down to a few tiles; rough or smooth stretches along the coast) for bays, peninsulas, capes and
   offshore islets, plus narrow ridged-noise channels (fjord-like inlets) on mountain and high-latitude coasts. New
   land that would join two landmasses is turned back into water, so straits stay open.
4. Climate (latitude, moisture, distance to the coast, lowland) gives big forests, deserts in the hot dry belts,
   tundra at high latitudes, swamps in low wet land. Cleanup filters (majority, small regions merged, speckle)
   keep terrain regions large and coherent (under 0.1% speckled tiles).
5. Resources as deposits of 3-12 tiles in fields of a few deposits, seeded on a stratified grid so every region with
   suitable terrain gets some.

Static derived data per map, computed once in `createGame`: landmass ids (`territory.landComponents`), water bodies
and a coarse 8x8 routing grid for ship paths (`grid.prepareWater`).

## 3. Economy: one troop pool

Each player has ONE troop pool (`Player.troops`: infantry, armor and artillery at home; troops in attacks and on
transports are out of it), gold, iron, oil, science. There are no workers and no army ratio.

- **Troop cap** (`Player.maxPop`) = `TROOP_CAP_BASE` (60k) + `TROOP_CAP_LAND` (2000) x (land weight)^0.6 +
  `CITY_TROOP_CAP` (60k) per city level + `CAPITAL_TROOP_CAP` (40k) + `FARM_TROOP_CAP` (12k) per farm (x2 on
  Fertile). Land weight = sum of pop/tile / 30 over owned land, fallout tiles 0 (kept up to date by setOwner,
  territory.ts; pow via `powDet`). About 130k at the start, 430k at 5 000 plains tiles, 0.86M at 20 000, 1.25M at
  40 000: early land is worth a lot and a huge empire's last tiles little, so cities are the scaling lever. Tribes
  x`TRIBE_CAP_FACTOR` (1/3).
- **Growth**/s = (`TROOP_GROWTH_BASE` 60 + `TROOP_GROWTH_K` 1.5 x troops^0.73) x (1 - troops / cap), new troops
  joining as infantry. It peaks at about 42% of the cap (`growthPeak`): a full bar barely grows, so troops are meant
  to be spent (the AI keeps itself near the peak). Above the cap (land lost) the same formula is negative and the
  pool shrinks back to the cap, every type alike. Bonuses on positive growth: farms +4% each (x2 Fertile,
  Agriculture x1.5, at most 12 counted), barracks +10% each (3 counted), Medicine x1.2; tribes x0.5.
  `Player.income.pop` is the growth per second.
- Gold/s = (`GOLD_BASE` 8 + `GOLD_LAND` 0.45 x (land weight)^0.6 + `CITY_GOLD` 5 per city level) x (1 + markets,
  +12% each up to +120%, x1.5 with Banking) x1.3 with Banking; tribes x0.5; plus trade ship deliveries and loot.
- Iron/s = mines * `IRON_PER_MINE` (Metallurgy x1.5). Oil/s = wells * `OIL_PER_WELL`. Industrialization x1.25.
- Science/s = `BASE_SCIENCE` + labs * `SCIENCE_PER_LAB`.
- Upkeep: armor burns oil (`ARMOR_OIL_UPKEEP` per unit/s: one well feeds about 600k armor). With no oil, armor
  fights at 50%. Aircraft burn oil too. Negative stocks are clamped to 0.
- **Army mix** (target shares for armor and artillery, rest infantry). Factories convert infantry to armor and
  Arsenals to artillery automatically, per building at `max(CONVERT_RATE, army x CONVERT_ARMY_SHARE)` per s, paying
  gold + iron per unit (`CONVERT_COST`, small next to army sizes), until the target shares are met.
  Industrialization doubles the rate.
- **Hospitals** return `HOSPITAL_RECOVERY` (15%) of attack losses each (2 counted) to the pool at home.
- **Auto-manage** (`Player.auto`, advisor.ts): with `auto.mix` the sim sets the army mix every
  `AUTO_MANAGE_SECONDS` to counter the main foe (the target of your biggest attack, else whoever attacks you
  hardest, else the neighbour with the biggest army, read from your border set): armor for open fronts and against
  artillery, artillery against infantry and forts, limited by your oil and needing a factory / arsenal. With
  `auto.research` it starts the next tech of `DEFAULT_TECH_ORDER` when idle and gold >= 1.5x its price. Humans
  start with both on, AIs have their own logic. `setAuto` toggles; a manual `setArmyMix` or `research` turns the
  matching flag off.
- **Hints** (`suggestions(state, playerId)`, advisor.ts): up to `MAX_SUGGESTIONS` (5) plain-language next steps
  `{ id, text, tile?, building?, priority }`, most urgent first (ties by id). Pure and deterministic (reads the
  state only, no RNG), cheap enough for ~1 call per second. They cover: an attacker to hit back, an alliance request
  to answer, troops nearly full (expand / attack the weakest neighbour), a weak tribe next door, cities (none yet,
  another one, an upgrade), farms (on Fertile land when we own some), a Mine / Oil Well on owned deposits, Market and
  Lab, the main foe (lots of armor -> forts on hills or infantry in forests; forts -> an Arsenal; bombers / silos ->
  a SAM Site), a front beyond supply (a Supply Depot near it), a fort or SAM to shell with a barrage, ready
  paratroopers (or "silence the SAM first"), research when auto research is off, and friendly neighbours to ally
  with (especially ones fighting our enemy). `tile` is where to look or click (for buildings: the spot
  resolveBuildTarget would pick), `building` lets the client preselect the building.

## 4. Land troops and combat

Three troop types, all drawn from the one pool.

| Type | attack | defence | speed bonus | notes |
|------|-------:|--------:|------------:|-------|
| Infantry | 1.0 | 1.0 | 0 | the pool grows as infantry; best in forest/hills/mountains |
| Armor | 2.2 | 1.5 | +60% x share | converted by factories, burns oil; strong on plains/desert, poor in rough terrain |
| Artillery | 1.9 | 0.9 | -15% x share | converted by arsenals; siege: x3 vs fort-covered tiles (part of it under a watchtower) and breaches the fort slowdown; fragile if unescorted |

Matchups (attacker type vs defender type multiplier):

|            | vs Infantry | vs Armor | vs Artillery |
|------------|-----:|-----:|-----:|
| Infantry   | 1.0 | 0.8 | 1.3 |
| Armor      | 1.4 | 1.0 | 1.6 |
| Artillery  | 1.3 | 0.7 | 1.0 |

**Attacks pick an owner, not a point.** A click on a tile picks the TARGET OWNER (a nation, a tribe, or 0 =
wilderness) and sends a share of the army (attack panel composition). The clicked tile is only kept as a UI anchor
(`Attack.focusTile`, for labels): the **whole shared border** with that owner advances. Clicking the same target
again merges the new troops into the running attack. Troops sent against a nation that is attacking us first
cancel its attack troop for troop (by power, fought where the fronts meet: each side's terrain attack, matchups,
forts, supply); what is left attacks. Land you can't reach by land (another landmass, `needsBoat`) gets a
transport instead: `applyAction 'attack'` launches one from your nearest suitable coast with the same troops to the
nearest coastal tile of that owner (`boatLandingTile`); the explicit `transport` action stays. `retreat` returns the
troops minus `RETREAT_LOSS` (25%) against a nation, all of them from the wilderness.

*Fronts* (combat.ts). An attack's frontier is a flat binary heap (typed arrays) of target tiles touching the
attacker, built at launch from the attacker's **border set** (territory.ts) and updated on every capture (no map
scans). Each tick the attack gets a budget of `(front tiles) x rate x 0.1 s` tiles (at least `FRONT_MIN_TILES`;
`MAX_TILES_PER_TICK` is only a performance guard), so speed is linear in the front length:
- wilderness: rate = `NEUTRAL_FRONT_RATE` (20) / clamp(`NEUTRAL_SPEED_TROOPS` (33000) / troops, 5, 100): about
  0.3 x the front per tick with 5 000 troops, at most 0.4 (a flood fill), more troops faster;
- nations: rate = `NATION_FRONT_RATE` (5.2) / clamp(1 / odds, 0.82, 7.5): an even fight on plains takes about
  half the front per tick, outnumbering the defender speeds it up modestly (x1.2 at most), hopeless odds crawl;
- x (1 + armor share x `ARMOR_SPEED_BONUS`) x (1 - artillery share x `ARTILLERY_SLOW` (0.15)) x Logistics x1.15,
  traitor targets x1.25.
A tile uses `(1 / terrain speed) x fort slow / (0.5 + 0.5 x supply)` of the budget; fort slow = 1 + (`FORT_SLOW` x
fort multiplier / `FORT_DEFENSE` - 1) x max(0, 1 - artillery share x `ARTILLERY_FORT_BREACH` (2)): guns breach the
fort's slowdown, all of it at 50% artillery. Tiles are taken in
priority order: `tick queued + jitter(8..18) x (1 - 0.25 x attacker 4-neighbours + 0.5 x (1 / terrain speed - 1))`,
so tiles the attacker already half surrounds go first (smooth, blobby fronts, notches fill), easy ground goes
first, and otherwise it is roughly first in, first out (rings). The neighbour weight is kept low on purpose: at 0.5 a
tile with two owned neighbours went at once, so diagonal growth matched straight growth and every early nation was a
perfect square; at 0.25 with the wider jitter a free expansion grows a round, slightly ragged blob.

*Costs* per tile taken:
- Wilderness: the attacker loses `NEUTRAL_LOSS_PER_TILE` (16) x terrain defence / attack power per unit (tribes
  expanding pay x0.5).
- Nations: **odds** = attack strength (troops x type attack x matchup vs the defender's mix, no terrain) / the
  defender's home army defence power. The attacker loses `ATTACK_LOSS_BASE` (200) x terrain defence x forts
  x clamp(1 / odds, 0.6, 2) (`OUTNUMBER_LOSS`: **send more, lose less**) x (`LOSS_FLAT` + `LOSS_DENSITY` x
  defender density) / attack power per unit, where density = the defender's home troops per tile; x0.6 against a
  traitor, x0.7 against a tribe, x0.85 where the defender is out of supply. The defender loses its density per
  tile (`DEFENDER_LOSS_PER_TILE`), split by composition.
- Attack power per unit = composition-weighted (type attack x terrain attack x matchup x artillery siege bonus)
  x supply efficiency x depot bonus x combined arms (1 for plain infantry on supplied plains). Siege bonus
  (`artillerySiegeBonus`) = 1 + (`ARTILLERY_FORT_BONUS` (3) - 1) x min(1, (fort multiplier - 1) / (`FORT_DEFENSE` - 1)):
  x3 under a fort, x1.4 under a lone watchtower, x1 in the open. Losses are split by
  vulnerability (infantry 1.0, armor 0.6, artillery 1.0 or 1.8 when over 40% of the force), barracks cut infantry
  losses.
- `estimateAttack(state, id, tile, troops, frontTiles?)` returns `odds`, `lossFactor`, `lossPerTile`,
  `tilesPerSecond` (for the front length: given, the running attack's, or the whole current shared border) and
  `frontTiles` for the UI and the AI.
- An attack ends when its troops run out or it has no frontier left; leftover troops go home.
- Capturing a tile with a building captures the building (missile silos, SAMs, airfields are destroyed instead).
- Taking a player's capital: -30% of their gold, their capital moves to their biggest city (or the nearest own tile).
  The gold penalty applies at most once per 30 s.
- **Fast cleanup**: a nation hit while under `ENDGAME_SMALL_TILES` (150) tiles (a tribe: `TRIBE_ANNEX_TILES`, 250)
  collapses: the attacker takes all of its land at once. **Enclaves** (endgame.ts): each player is checked every
  `ENCLAVE_CHECK_SECONDS`, staggered by a hash of its id and only when land changed hands on or next to its land;
  the check floods its pieces next to those changes (an open piece or one over `POCKET_MAX_TILES` stops early). A
  piece fully surrounded by one hostile nation (no water, no neutral land; the map edge doesn't count) that is under
  half of the player's land is annexed by it; a small nation's main body too. Allies keep their pockets.
  **Human grace**: a human nation neither collapses nor has its main body absorbed in its first
  `HUMAN_GRACE_SECONDS` (180) of game time (its 81-tile start is under the threshold); while walled in it gets a
  `surrounded` event (a red toast, at most every 20 s) telling it to expand or attack out.

**Army sizes are public.** Everyone sees every nation's army total (`armyTotalOf(state, id)`, buildings.ts: home +
attacks + transports + cargo planes), like name labels show it. Intel (`hasIntel(viewer, target)`) only gates the
troop **composition** (infantry / armor / artillery split): self, allies, or a watchtower of the viewer in range of
the target's capital, buildings or land (`watchtowerRadiusOf`, + `WATCHTOWER_LEVEL_RADIUS` per level, Radar x2).

### Special land abilities

**Paratroopers** (`Action { type: 'paradrop'; airfield; tile; troops }`, units.ts). Needs Flight and a finished own
Airfield. The tile must be enemy or neutral land (not allied) within `paradropRange` = `PARADROP_RANGE` (80) +
`PARADROP_RANGE_PER_LEVEL` (20) per airfield level above 1. `troops` infantry leave the pool at once (at least
`PARADROP_MIN_TROOPS`, at most `paradropMaxTroops` = level x max(`PARADROP_TROOPS_PER_LEVEL` 15k,
`PARADROP_ARMY_SHARE_PER_LEVEL` 5% of the whole army)); a drop costs `UNITS.transportPlane` (gold, oil) and the
airfield waits `PARADROP_COOLDOWN` (30 s, `Building.dropCooldown`) for the next one. A `transportPlane` unit flies
straight there at bomber speed and is intercepted like a bomber (SAMs, then fighters; troops aboard die). On
arrival: own or allied land (taken meanwhile) -> the troops come home; otherwise `launchAttack(..., amphibious)`
from that tile: the tile is captured first (paid like any tile; if they can't pay, the drop is wiped out), then the
front grows from inside (merging into a running attack on that owner); the drop tile is a beachhead supply source
for `BEACHHEAD_SUPPLY_SECONDS`. Uses: capital strikes, cutting off pockets (enclaves get annexed), second fronts.
Events: `'paradrop'` to the target at launch ("X is dropping N paratroopers on Y") and on landing.
`canParadrop(state, id, airfield, tile, troops)` is the preview check.

**Artillery barrage** (`Action { type: 'barrage'; tile }`, barrage.ts). Needs at least `BARRAGE_MIN_ARTILLERY`
(2000) artillery (`artilleryOf`: home + attacks). The tile must be land of a living, non-allied nation or tribe
within `barrageRange` = `BARRAGE_RANGE` (20; Ballistics x1.5) of your own land, and it costs `BARRAGE_GOLD`. The
order is telegraphed: a `Barrage { id, owner, tile, target, artillery, hitTick }` waits in `state.barrages` for
`BARRAGE_DELAY` (2 s; the client draws the warning circle and countdown). Then, on a disc of `BARRAGE_RADIUS` (6):
- hostile owners lose home troops: `barrageKill(artillery)` = `BARRAGE_KILL_MAX` (300k) x a / (a +
  `BARRAGE_KILL_HALF` 2M) in all (about 15% of the guns for a small battery, 100k for 1M guns, diminishing),
  split by their share of the disc, each capped at `BARRAGE_KILL_ARMY_SHARE` (8%) of its home army;
- hostile **forts and SAM sites** lose `BARRAGE_BUILDING_DAMAGE` (0.25) hp (0 = destroyed; buildings repair
  `BUILDING_REPAIR_PER_S`) and are knocked out until `Building.disabledUntil` (`BARRAGE_DISABLE_SECONDS`, 20 s): a
  disabled fort gives no bonus (fortMultiplierAt / isFortified skip it), a disabled SAM can't fire. Shells are not
  aircraft: SAMs never intercept them. This is the counter to SAM cover near a front. Repair (0.01 hp/s) undoes
  about 0.15 hp between two barrages of one shooter, so one shooter wears a fort down slowly (about 10 barrages,
  2.5 min); focused fire (several shooters, Ballistics) destroys it much sooner;
- other hostile buildings are destroyed with `BARRAGE_DESTROY_CHANCE` (10%, state.rng in tile order).
The front does not move. One barrage per player every `BARRAGE_COOLDOWN` (15 s; Ballistics 10 s;
`Player.barrageReadyTick`). Effect `'barrage'` (radius `BARRAGE_RADIUS`) when the shells land; events `'barrage'` to
the target at launch and to everyone hit on impact. `canBarrage(state, id, tile)` is the preview check.

**Balance intent.** SAM cover is strong but counterable, and no single tool beats everything: SAMs hold only one shot
per level (saturation: send more threats than they can load), barrages silence SAMs and forts near the front but
only within 20-30 tiles of your border and only one spot every 14-20 s, capturing a SAM's land destroys it, and
paratroopers can land outside SAM range (and need SAM cover gone to survive inside it). Barrages kill a few percent
of an army at most, so defence (forts out of reach, depth, numbers) still matters.

**Supply** (cheap model, no path search). Supply sources: capital, finished cities and supply depots, and for
`BEACHHEAD_SUPPLY_SECONDS` the landing tile of an invasion. A tile's supply distance is the straight-line distance
to the player's nearest source (sources cached per player, rebuilt when its buildings, capital or beachheads
change). Within `SUPPLY_RANGE` (110 tiles, Logistics +50%) efficiency is 1, falling linearly to `MIN_SUPPLY_EFF` at
3x range. It scales attack power and front speed; defenders out of supply defend at x0.85.

**Elimination.** A player with no tiles is eliminated; their units and attacks vanish, and the nation that took the
last tile gets their gold (half of a human's). A tribe's elimination is only announced to the nations involved.

**Incremental territory data** (territory.ts, maintained by `setOwner` and the fallout code): per-player border
sets (dense list + per-tile index), land weights, coast / iron / oil counts and lazy lists, tile counts per 16x16
block (watchtower intel), recent change tiles (enclave checks). Fronts, neighbourhoods, intel and the economy read
these instead of scanning the map.

**Tile change feed** (changes.ts, for the renderer): `setOwner` and fallout start / end call
`recordTileChange(state, tile)`; `drainTileChanges(state)` returns `{ tiles, count, overflow }` and clears the list
(capacity `1 << 18`; when full `overflow` is set and nothing more is recorded until the next drain: refresh
everything). Headless games never drain (overflow just stays set). `GameState.buildingsVersion` is bumped whenever a
building is added, removed, upgraded, finished or changes owner.

## 5. Buildings

Buildings are **few and levelled**: fewer markers, each one easy to read, every one worth upgrading.

**Build orders** (`resolveBuildTarget(state, playerId, type, tile)`, buildings.ts; `build` and `canBuild` use it, the
client previews with it). For an order of `type` at tile T:
1. **Upgrade**: if an own building of the same type (finished or not) is within `BUILDING_UPGRADE_RADIUS` (12) of T,
   the nearest one (ties: lower id) is the target. Still under construction or already upgrading -> error; below its
   `maxLevel` -> upgrade (level + 1); at its top level -> a new building may still go elsewhere (step 2; if there is
   no room, the error says it is at its highest level).
2. **Snap**: otherwise the sim tries T, then every tile within `BUILDING_SNAP_RADIUS` (10) by distance, then row, then
   column, and builds on the first valid one: own land, not water, no fallout, terrain allows the type, coast for
   ports, an owned deposit within 2 tiles for mines / oil wells, an empty tile at least the map size's spacing from
   EVERY building (anyone's, cities included): `BUILDING_MIN_SPACING_BY_SIZE` small 10 / medium 12 / large 14 /
   huge 15 tiles, straight line (`buildingSpacing(state)`). With no valid tile the error is T's own problem.
3. The result is `{ tile, upgrade, cost, level, buildingId, affordable, reason? }` (the order is possible; `affordable`
   false with `reason` "Not enough gold / iron") or `{ error }`. Tech is checked first ("Needs research: Medicine").

**Levels.** `Building.level` 1..`BUILDINGS[type].maxLevel`: city 6, barracks 3, supply depot 3, watchtower 3,
hospital 2, airfield 3, SAM 3, silo 3, everything else 5. An upgrade costs the same as a new building and takes the
type's `buildTime`; meanwhile the building keeps working at its old level (`Building.upgradeLeft` counts down, then
the level goes up, `buildingDone` event "... upgraded to level N"). **Price** of the next level, new or upgrade:
base x (1 + `costGrowth` x levels of that type owned, incl. unfinished buildings and running upgrades).

**Every effect scales with the level.** `countBuildings(state, id, type, includeUnfinished?)` returns the **sum of
levels** (`countSites` counts separate buildings), so every "per building" rule below is per level: city cap and gold
per level, farm cap and growth per level (x2 on Fertile), +12% gold per market level, iron / oil / science per mine /
well / lab level, barracks and hospital levels up to their caps, conversion per factory / arsenal level, +2 transports
at sea per port level. Spatial effects grow modestly:
- Fort: radius `fortRadius` = 20 (Fortification 28) + `FORT_LEVEL_RADIUS` (3) per level above 1, defence
  `fortDefense` = x2 (Fortification x2.5) + `FORT_LEVEL_DEFENSE` (0.25) per level; the strongest working fort counts.
- Watchtower: intel radius 80 + `WATCHTOWER_LEVEL_RADIUS` (20) per level (Radar x2).
- Supply depot: attack-bonus radius 60 + `DEPOT_LEVEL_RADIUS` (15) per level.
- Airfield: fighter cover 80 + `AIRFIELD_LEVEL_RADIUS` (15) per level, `aircraftCap` = 6 per level, paradrop range
  and size per level (section 4).
- SAM site: radius 60 + `SAM_LEVEL_RADIUS` (10) per level and **L shots** per salvo; silo: **L launch slots**.
  `Building.cooldown` is a reload debt in seconds: a shot / launch adds `SAM_COOLDOWN` / `SILO_COOLDOWN`, the debt
  drains L s per second, and firing needs debt <= (L - 1) reloads. So a salvo of L, then one more every reload / L;
  `chargesReady(b)` and `nextChargeIn(b)` read it for the UI.
- Port: trade ship gold x (1 + `PORT_LEVEL_TRADE` 0.5 x (level - 1)).

Construction takes `buildTime` seconds; an unfinished building does nothing. Some need a tech. Buildings hit by a
barrage lose hp and repair at `BUILDING_REPAIR_PER_S`; forts and SAMs are knocked out until `disabledUntil`.

| Building | Effect per level | Max | Needs |
|----------|------------------|----:|-------|
| City | +60k troop cap, +5 gold/s; supply source | 6 | |
| Farm | +12k troop cap and +4% troop growth (x2 on Fertile) | 5 | not on mountains/desert/swamp/tundra |
| Market | +12% gold (all together max +120%) | 5 | |
| Mine | +iron; within 2 tiles of owned Iron | 5 | |
| Oil Well | +oil; within 2 tiles of owned Oil | 5 | |
| Barracks | +10% troop growth, -5% infantry losses (3 levels count) | 3 | |
| Factory | converts troops -> armor | 5 | |
| Arsenal | converts troops -> artillery | 5 | |
| Fort | attackers lose x2 and move half as fast within 20 tiles; wider and stronger per level | 5 | |
| Supply Depot | supply source, +10% attack for fronts within 60 tiles (+15 per level) | 3 | |
| Watchtower | shows enemy troop mix within 80 tiles (+20 per level), +20% def within 12, early warning of bombers, cargo planes and transports | 3 | |
| Port | coastal; trade ships, faster free transports, warships | 5 | coast |
| Research Lab | +1 science/s | 5 | |
| Hospital | 15% of attack losses come back as troops (2 levels count) | 2 | Medicine |
| Airfield | bombers / fighters (6 per level), fighter cover 80 (+15), paratroopers | 3 | Flight |
| SAM Site | shoots down missiles / aircraft within 60 (+10); one shot per level per salvo | 3 | Radar |
| Missile Silo | rockets and atom bombs; one launch slot per level | 3 | Rocketry |

The building index (buildings.ts) is kept up to date incrementally (add, remove, capture, finish, upgrade), with
per-player sums of levels cached until that player's buildings change.

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
- **Transport**: launched from your coast (a Port is +60% faster and costs no gold) to a target coastal land tile,
  also by an attack click on land across water. Carries troops (composition as sent). The launch site is the
  nearest own coast on the same sea (straight line, ports count as closer); the route is `grid.waterPath`: water
  bodies are labelled once, so a route to another sea fails at once; long routes are short A* legs between
  waypoints of a coarse 8x8-block route (weighted A*, Chebyshev heuristic), with a search budget per launch
  (AIs smaller than humans). On arrival it becomes an `Attack` from a 1-tile beachhead (the landing tile is captured
  first, paid like any tile). Can be sunk. Max 3 at sea per player (+2 per Port, +1 Navigation).
- **Warship** (Port, Navigation): patrols near its port or a set point; attacks enemy ships within 20 tiles;
  bombards enemy coastal troops (target search and shots every 5 ticks per ship, staggered).
- **Trade ship**: each Port periodically sends one to one of a stable handful of partner ports on its sea (a pair
  hash picks them) of players not at war with it (allies weighted x2), so routes stay cached. Delivered gold goes to
  both owners (scaled by path length). Enemy warships sink them.
- **Bomber** (Airfield, Flight): flies to a target tile; on arrival destroys buildings in radius 5 (chance each) and
  kills defender troops in radius; then flies home. SAMs and enemy fighters in range can shoot it down.
- **Cargo plane** (`transportPlane`, Airfield, Flight): carries paratroopers straight to their drop tile (section
  4, Special land abilities); intercepted like a bomber.
- **Fighter** (Airfield): stationed; intercepts enemy bombers and cargo planes within its airfield's radius (80, +15
  per level).
- **Rocket** (Silo, Rocketry): fast missile, radius 7: destroys buildings, kills troops. A level-L silo has L launch
  slots (one reload `SILO_COOLDOWN` each, reloading L times as fast).
- **Atom bomb** (Silo, Nuclear Fission): radius 35: destroys buildings, kills 60-90% of the army share in the area,
  turns tiles neutral with fallout within 14. Every AI that sees a nuke drops opinion of the launcher sharply.
- **Interception is deterministic** (`RULES_TEXT.interception` in config is the help text): threats are handled atom
  bombs first, then rockets, bombers, cargo planes (then by id). Every hostile SAM with a shot loaded
  (`chargesReady`), not knocked out by a barrage and with the threat inside its `samRadius` (60, +10 per level)
  fires once: a sure hit for 1 hp. A level-L SAM holds L shots and reloads one every `SAM_COOLDOWN` (4 s) / L.
  Planes and rockets have 1 hp, atom bombs 2, so an atom bomb needs two shots. A bomber or cargo plane still flying
  then meets the first ready hostile airfield with fighters in range: shot down, and that airfield needs
  `FIGHTER_COOLDOWN / fighters` seconds to be ready again. No dice anywhere, so players can plan their cover, and
  attackers can plan saturation (more threats than shots) or silence SAMs with a barrage first.

## 8. Diplomacy

- Alliances: request -> other side accepts/rejects (AI decides from opinion and threat; tribes accept everything but a
  traitor). In the first 3 game minutes an AI accepts a human only out of opinion (no fear or timid alliances), so
  allying with every nation at once is no free shield.
  Allies cannot attack each other, share intel, may trade. Alliances last `ALLIANCE_DURATION` s. **Renewal**: in
  the last `ALLIANCE_RENEW_WINDOW` (60) s either side may request again; the alliance is extended only when the
  other side accepts (both agree), else it expires.
- Starting an attack on a nation cancels pending alliance requests between the two (event) and makes the victim
  embargo the attacker for `AUTO_EMBARGO_SECONDS` (lifted automatically once the time is up and they no longer fight,
  unless the victim toggled the embargo by hand).
- Breaking an alliance (`breakAlliance`, or attacking an ally after breaking) marks you **traitor** for
  `TRAITOR_DURATION` (45) s: a short, sharp window in which attackers lose x`TRAITOR_DEFENSE` (0.6) against you and
  move faster, and every AI's opinion of you drops (the betrayed side by 50, everyone else by 25).
- AI opinion -100..100 per pair: long shared borders (from the border sets, one slice of the players per second),
  attacks, gifts, betrayal, relative size.
- `gift` gold or troops to a player raises their opinion.
- `embargo` stops trade ships between you and them.

## 9. Victory

Win by owning `settings.victoryLandShare` (default `VICTORY_LAND_SHARE` 75%; the setup offers 60-90%) of all land
tiles, or by being the last nation (tribes don't count and never win). In a teams game a team wins together: its
members' land added up, or as the last team standing (`state.winner` = its best-scoring member, `state.winnerTeam`
= the team; `victory.humanWon`). Lose when your territory is gone. The game ends when every human is out (single
player: the one human); online, an eliminated player watches while the others play on. **Overtime**: after `OVERTIME_MINUTES` (25) the needed land
share drops by `OVERTIME_DROP_PER_MINUTE` (1%) per full minute, down to `OVERTIME_MIN_SHARE` (50%), so games end
on the map (`victoryShareNow(state)` for the UI). Optional time limit: highest score wins. Score = tiles +
troops/100 + buildings*50. AI-only games end with a winner in about 20-35 game minutes on medium to huge maps (median 24.5 / 26.5 / 31 min, 4 seeds each, 2026-10)
(`scripts/batch.ts`).

## 10. AI nations and tribes

Personalities change weights: Warlord (attack early, armor heavy), Turtle (forts, artillery, counter-attacks),
Merchant (cities, markets, ports, trade, alliances), Admiral (ports, warships, invasions), Balanced.
Difficulty Easy/Normal/Hard sets the decision interval (`AI_DECISION_SECONDS` 4 / 3 / 2 s, staggered by id), how
well they read the matchups and a small Hard income bonus. AIs act via `applyAction` only. Nothing scans the map:
each AI reads its **neighbourhood** (border lengths per neighbour, samples of the tiles on both sides of each
border) built from its border set and cached for a few ticks; owned tiles are sampled in its bounding box, coasts
and deposits come from territory's lists.

Pacing follows the troop curve: every troop above a small personal reserve (`expandReserve`, 8-25% of the cap) goes
into the wilderness while there is any (the flood is cheap; troops are the limit). New wars start once the troops at
home reach a personal trigger share of the cap (`trigger`, 45-65%), sending everything above a reserve (`reserve`,
25-42%), so a nation hovers near the growth peak; careful AIs top a war up toward odds 1.2 (send more, lose less).
Targets: neighbours we outnumber enough (`strengthNeeded` by personality, much more while wilderness is left, less
against traitors, grudges, runaway leaders and when attacked); no pile-on (a nation already attacked by two others is
left alone unless it attacks us); tribes whenever we outnumber them 2:1 (they are food). A human nation that is not
attacking us gets a head start: for the difficulty's `humanGrace` (Easy 8 min, Normal 6, Hard none) an AI wants
x1.8 the strength before attacking it and never picks it as the "weakest neighbour" of a full bar. A boxed-in nation grows
impatient (need falls 10% per idle minute) and one with a nearly full bar attacks its weakest neighbour rather than
sit idle; boxed-in nations also land by sea. They build economy first, then military buildings by personality, keep
an army mix that counters the main foe, research, ally with strong neighbours they fear, use bombers and missiles,
and retreat attacks that bleed without taking land. Every build order goes through `resolveBuildTarget` (the same
rule as a click): economic types prefer upgrading the building they have (fewer, bigger buildings), cities are
upgraded to level 3 before another is founded (unless a front lacks supply), forts and towers upgrade the one that
already covers a spot. With artillery they **barrage** forts and SAM sites near the fronts of nations they fight or
are about to attack (SAMs first; with lots of artillery and nothing to silence, the main front itself), and
sometimes (40% of the air turns with a ready airfield) **drop paratroopers** on a capital or city of a nation they
clearly outnumber (careful AIs avoid SAM cover), else about 30 tiles behind the main front toward its capital.

**Tribes** (`Personality 'tribe'`, `isTribe(p)`): `settings.tribeCount` small AI players (negative = the default for
the land actually played, `setup.defaultTribeCount`: by size class small 120, medium 200, large and huge 300,
real-world maps 300, compact maps by their quarter of the land; at most `MAX_TRIBE_COUNT` 600). They are the main
thing to conquer: games have few nations and many tribes. Named
"Tribe of ...", with muted colours. They spawn in the leftover space when the spawn phase ends (radius 4, 40% of
the starting troops), have a third of the cap and half the growth and gold, take neutral land with their spare
troops up to `TRIBE_MAX_TILES` (900), never attack anyone, build and research nothing, and accept every alliance
(except from a traitor).
They decide every 4-8 s (`TRIBE_DECISION_SECONDS`, staggered). They are early food: nations eat them in the first
minutes, and one collapses when hit below `TRIBE_ANNEX_TILES`. A tribe of any size that one nation has walled in
completely (no water or free land around it) is absorbed by that nation (endgame.ts), so encircling tribes pays and
the nations don't fill up with tribe parcels.

**Player counts** (setup defaults, changeable): AI nations 8 in single player (`DEFAULT_SETUP.aiCount`,
`DEFAULT_AI_COUNT`), about 10 nations in all in multiplayer (`MULTIPLAYER_NATIONS`, humans included), at most
`MAX_AI_COUNT` 40. Default setup, AI only (`scripts/batch.ts`, 4 seeds each, 2026-10-30): small 25 min, medium 27,
large 25, the World map 35 (median winner minute); Quick Conquest 20. Nations spawn spread out (spawn score weighs distance to others as much as land
quality) with a start radius by map size (`SPAWN_RADIUS_BY_SIZE` 5 / 6 / 7 / 8) and at least `spawnMinDistance`
(3 x radius + 2) between capitals.

**Performance budget** (huge map, 50 AIs, 300 tribes, 20 game minutes, Node, `scripts/profile.ts`): tick p50 under
4 ms, p95 under 8 ms, p99 under 15 ms. Periodic per-player work is staggered by a hash of the id; there are no
full-map scans after `createGame`.

## 11. Client

- Main menu: New game (the setup screen, setupScreen.ts) and How to play. The setup screen edits one `GameSetup`:
  presets as chips in the header (Classic, Quick Conquest, Grand War, Island Hopping, Chaos; "Custom" appears when
  the settings match none); left column: the map (Generated / Real world tabs, preview thumbnails drawn from the map
  data by mapThumbs.ts in the background, size for generated maps), AI nations and tribes sliders (tribes Auto = by
  land), difficulty, free for all or teams (2-6); right column: the modifiers in groups Economy, Combat and Rules,
  each with a one-line plain explanation (two columns on wide screens, scrolling with a faded edge on small ones);
  a summary line (map, nations, tribes, active modifiers); name, colour, seed and Start. Remembered in localStorage
  (`borderfall.setup.v2`, read through setup.sanitizeSetup). In the game the active modifiers show as chips under
  the top-right cluster (hud/modChips.ts, tooltips; peace time counts down); disabled buildings, warships, atom
  bombs and the Ally button disappear or say why.
- Spawn phase (`SPAWN_SECONDS`): click a land tile to place your capital (else random); click again to move it.
  The `startNow` action ends the phase on the next tick once every human has picked (single player: you).
  `state.playStartTick` records the tick the phase ended; `gameSeconds(state)` (state.ts) counts from it and is the
  game time for the clock, the event log, overtime and the time limit.
- Map rendering (renderer.ts, render/*): two stacked canvases. The map itself is one WebGL2 fragment pass
  (shaders.ts) over textures uploaded once per game (terrain id + resource, water depth, mipmapped flat colours) and
  an R32UI owner texture (owner | fallout | capture flash kind and time) kept current from the sim's tile change
  feed (`drainTileChanges`, tiles.ts): changed tiles drip in over the frames of one tick, mark 64 x 64 blocks dirty,
  and only dirty row runs are re-uploaded (a full upload on `overflow` or a new game). Nations are one solid colour
  with the terrain only as soft luminance shading (tribes share one nearly grey wash, `tribeDisplayColor` in
  renderer.ts: a hint of their own hue and a small value step, so saturated colours mean nations; no capital stars;
  labels only from zoom 3.2 on (names.ts `TRIBE_LABEL_ZOOM`), just the army number below zoom 6
  (`TRIBE_NAME_ZOOM`), the full name when hovered), crisp borders where a neighbour has another owner (darker shade;
  yours white; allies light and dashed; traitors red; the hovered nation brighter, pulsing red when it looks easy),
  capture flashes along fronts (your gains yellow, your losses red), fort coverage hatch, fallout, supply / spawn /
  resource overlays. Terrain: one calm colour per type far out, a procedural pattern per type closer in (tree
  dots, hill domes, mountain peaks, sand stipple, swamp flecks, snow dots), soft shores. Without WebGL2 a Canvas2D
  path (map2d.ts) draws flat colours and borders. On top, a Canvas2D overlay: building markers (minimal at every zoom:
  a plate in the building's category colour (economy gold, production orange, defence blue, logistics green,
  advanced purple) with a white silhouette in a frame of the owner's colour, icons.ts marker mode, at least 16 px from
  FAR_ZOOM 1.7 on, the name underneath from zoom 8; farther out only cities and forts as small squares), deposit
  markers (fields, then clusters), units as tinted icon sprites with halo, shadow, wakes and contrails (at least
  16 px), name labels (largest inscribed rectangle on a coarse owner grid, a few players per frame; a label over
  building markers fades to half), your capital ringed in white and, while your land is under about 40 px on screen,
  a pulsing "YOU" locator around it, front troop
  pills (anchored on the latest captures from the change feed), reticles, effects. Minimap from the same feed.
  Spatial grids keyed by `buildingsVersion` cull buildings and deposits. Your own warships can be clicked to move
  them (`Renderer.ownWarshipAt`).
- Controls: left click enemy/neutral = attack with the attack share; left click own tile with a building
  selected = build (the ghost shows exactly what `resolveBuildTarget` will do: "Build here" in green on the snapped
  tile, "Upgrade to level N" in blue on the building it upgrades, or the reason in red; the price sits at the cursor;
  placement.ts / simx.ts); right click or long-press = radial menu (radial.ts: likely action in the centre, the rest on
  a ring, build list as a submenu, paratroopers / barrage / bomb / missiles on enemy land with their disabled reasons;
  Esc or a left click closes it without acting); drag or WASD/arrows = pan; wheel = zoom; Space = pause; 1-9/0/letters
  = building hotkeys; [ and ] = attack share; T research, U army, P diplomacy, J events, L map key, M minimap; Esc =
  cancel or close. In attack mode a badge by the cursor shows the odds in words (`estimateAttack().odds`: "You 2.3x
  stronger", "Even fight", "They are 3x stronger"; army sizes are public, so this needs no intel). Target modes: build, transport, bomb, missile, move warship, paradrop (dashed range ring of each airfield,
  drop disc), barrage (disc in green or red).
- HUD (hud.ts + hud/*, "war room" style: near-opaque gunmetal panels, thin steel rules, brass for actions and key
  numbers; Barlow Condensed labels, IBM Plex Sans values, Saira Stencil One logo, all bundled in fonts.ts). The
  default screen has only three things: the bottom command bar (troops / cap with growth, trend arrow, a bar with the
  growth-peak marker and the troops out attacking; attack share with -/+ and a slider; gold and its rate, iron / oil /
  science chips once they matter; the build bar with Economy / Military / Defence / Special tabs, pictograms, costs and
  hotkeys, buildings hidden until their tech is close), the top-left standings (top 5 + you, top 3 on screens under 800 px tall; land % and
  public army, collapsible; a click centres and opens the nation card) and the top-right cluster (drawer buttons,
  named on screens 1600 px and wider; clock, pause and speed, sound, help, menu). Together about 7% of a 1920x1080
  and 12% of a 1280x720 screen; above about 1500 px wide the anchored HUD parts grow with the window (CSS `--ui`, up to
  x1.35). The camera glides to your capital (zoom 4.5) when you place your start and when the game starts. The help
  page pauses single player while it is open. Only when needed: toasts (top centre, 4 s;
  alliance requests stay with Accept / Decline), the advisor line above the command bar (`advisor.suggestions()`,
  cycling every 8 s, a button that acts, dismissible, can be switched off) or the first-game tutorial (six steps,
  remembered in localStorage), the spawn bar, the target-mode chip, the map tooltip (terrain with its effect in plain
  words, the resource and what to build on it, owner, relation and army, the building with its level and effect).
  One click away: drawers on the right (Army: mix + auto, what attacks send, active attacks, air and strikes;
  Research with auto; Diplomacy; Events history; Map key: every terrain with swatch and effect, resources, borders
  and marks, buildings (marker, hotkey, effect, the category colours), units, strikes, troop counters; the selected building with upgrade and actions; Menu: sound, advisor,
  tutorial, minimap, leave), the nation card on the left (Ally / Accept / Break, Gift, Embargo, Attack), the help page.
  Destructive actions ask first (a warning toast with a confirm button: Demolish from the radial menu, Break an
  alliance); an alliance request, a gift and an AI's refusal get a toast.
  Pictograms: buildings and deposits use the map markers' silhouettes (icons.ts MARKER_DATA) as inline SVG in one
  colour (hud/glyph.ts), controls use thin line icons. Sound: audio.ts wired as docs/AUDIO.md describes (unlock on the
  first gesture, `update()` per frame, own build / launch / error sounds, UI clicks, volumes in the menu).
  Game over screen with stats.

## 12. Game setup, modifiers and teams

One options model for single player, the setup screen, the multiplayer lobby and the server (`types.ts` `GameSetup`,
`setup.ts`): `map` (`{ kind: 'generated', type, size }` or `{ kind: 'world', id }`), `aiCount`, `tribeCount` (-1 =
by land), `difficulty`, `mode` (`'ffa' | 'teams'`), `teamCount` (2-6), `timeLimit` (0 or 15/30/60 min in seconds),
`victoryLandShare` (0.6-0.9), `modifiers` and `preset` (a label). `GameSettings` = `GameSetup` + seed, player name and
colour, `humanPlayer`, and for online games `humans` (one `{name, color, team}` seat per player, ids 1..H;
`setup.humanSeats` reads either form, single player being one seat). The lobby's `LobbySettings` is `GameSetup` + `maxPlayers` (src/net/protocol.ts).
`validateSetup` is the strict check (server: unknown fields and bad values are errors), `sanitizeSetup` the lenient
one (saved settings), `mergeSetup` applies a partial patch (modifiers field by field), `applyPreset` /
`matchPreset` / `PRESETS`, `activeModifiers` / `modifierSummary` give plain-word labels. Chaos is rolled when the
preset is picked (the roll is not part of the settings, so every client gets the same values).

`createGame(settings, map?, { teams? })` stays synchronous: a world map is loaded first (`await loadWorldMap(id)`)
and passed in; with the compact modifier the game uses `compactWorldMap` (2 x 2 blocks, half the width and height).
On a world map AI nation k is the map's spawn k (`worldMapSpawns`, spread-out order) with its real name, and starts
at its capital (`state.spawnPoints`, or the nearest valid tile; ignored with random spawn). `state.mapClass` is the
map's size class (generated: its size; world or compact: by land) for the start radius, building spacing and default
tribes.

Modifiers (`types.Modifiers`), enforced in the sim (`rules.ts`; every refusal has a plain reason) and respected by
the AI (it never tries what is off) and the advisor (never suggests it):

| Modifier | Effect in the sim |
|---|---|
| `randomSpawn` | humans are placed on the first tick (`randomSpawnHumans`), `spawn` is refused; fixed world-map capitals are ignored |
| `compactMap` | generated: `MAP_SIZES` x `COMPACT_SCALE` (0.5) per side; world: `compactWorldMap`; tribes by the smaller land |
| `peaceMinutes` 0/2/4/6 | `atPeace(a, b)`: two nations or players (not tribes) can't attack, invade, bomb, shell, drop on, fire at or annex each other; warships hold fire; landings on their coast come home; `peaceReason` says how long is left; events at 1 minute left and at the end |
| `startingGold` | `STARTING_GOLD` normal 600 / high 5 000 / very high 20 000 for every player |
| `goldMultiplier` 0.5-3 | gold income x this (`goldRate`) |
| `troopGrowth` 0.5-2 | positive troop growth x this (`growthRate`) |
| `buildSpeed` | construction and upgrade time x 1 / 1/3 / one tick (`buildSeconds`) |
| `noAlliances` | `requestAlliance` / `answerAlliance` refused (teammates stay allied) |
| `noNukes` | `launchMissile` atom bomb refused (rockets stay) |
| `noAir` | airfields, aircraft and paratroopers refused |
| `noNavy` | `buildWarship` refused (transports and trade ships stay) |
| `noSams` | SAM sites refused |
| `research` | 'allUnlocked': every nation starts with every tech, research refused; 'off': research and every building that needs a tech refused. Labs (science only) are refused in both |
| `fastGame` | gold, iron, oil, science, troop growth and front speed x2, construction in half the time |

Teams (`state.teams[playerId]`, 0 = none): from `createGame`'s `opts.teams` (the lobby), else `setup.assignTeams`:
the seats' chosen teams, then everyone else (auto humans, AI nations) to the smallest team, which is round-robin by
id when nobody chose (single player: the human, id 1, on team 1). AI nations fill the teams; tribes have none.
Teammates share a colour family (single player: team 1 keeps the human's colour; online the humans take the first
shades of their team's colour). `sameTeam` makes
`areAllied` true, so every "not an ally" rule applies; `breakAlliance` and `requestAlliance` between teammates are
refused. Victory: section 9.

