# Frontline Atlas roadmap

Working rules (owner's wishes, keep following them):
- Work on branch `dev`; only finished, tested work goes to `main` (Render and GitHub Pages deploy `main` automatically).
- Before merging: `npx tsc -p .`, `npx tsc -p server`, `npx vitest run`, `npm run build` all green (the build no longer type-checks: Render's free build has ~512 MB and tsc pushed it over) (a few long tests can time out only while the machine is busy; re-run them alone).
- Commits are authored by the owner (Doom956); never mention any AI tool or the reference game's name in the repo; never write the admin code anywhere.
- Keep the HUD minimal and clean; literal, simple icons; plain short wording.
- Live: https://frontline-atlas.onrender.com (server + game, env `ADMIN_CODE` set in Render) and https://doom956.github.io/FrontlineAtlas/ (Pages; repo variable `SERVER_URL`).

## Overnight plan (owner, 2026-10-31)
Round 1 finishes -> all checks -> merge to `main`. Then round 2 -> all checks + multiplayer sync test -> merge to `main` if green. Then the full balance check -> checks -> merge to `main` if green. Morning summary per pillar.
Status: round 1 merged to main 2026-10-31 05:40 UTC (fbe8710). Round 2 merged to main 08:45 UTC (3e0dcf3; checks green, both multiplayer sync e2e passed). Balance check done 17:45 UTC (results below).

## Round 1 (in progress when this file was written): "many ways to win"
Goal: navy, armor (tank divisions), air, land and economy can each carry a win.
- Navy: warship stances (auto, hunt, escort, bombard, blockade); bombardment makes your attacks on that coast cheaper/faster; blockade cuts trade/supply; escorts protect transports; veterancy. AI ships act all game.
- Armor: reusable tank divisions (survive spearheads, refit, veterancy), cheaper, encirclement collapses pockets, "support front" mode.
- Air: air wings scaling with airfield level/techs, "support this front" mission, strategic bombing cuts income, air superiority/escorts, bigger paradrops.
- AI personalities commit to a pillar.
- Specialist benchmark in `scripts/batch.ts`: each pillar's specialist must win ~0.7x-1.4x of a normal nation on suitable maps.
If this round was interrupted: check `git log dev`, finish the missing parts (sim files `src/sim/naval2.ts`, `src/sim/airwings.ts`, tank changes; client stance/mission controls), run all checks, the specialist benchmark, a multiplayer sync test, then merge to `main`.

## Round 2 (done 2026-10-31, on `dev`): Arsenal
1. Vehicle variants with path limits (fork per pillar, chosen in research):
   - Navy: Destroyers + Battleships (surface fleet: destroyers find submarines; battleships long-range coastal bombardment) OR Submarines + Carriers (stealth trade raiders; carrier = moving airfield).
   - Armor: Light tanks (fast, deep thin spearheads, reveal ahead) OR Heavy tanks (break forts and mountains).
   - Air: Ground-attack planes (best at front support) OR Heavy bombers (strategic bombing).
   - Shared by all: Mechanized infantry (holds ground a spearhead takes), Recon planes (reveal armies, doctrines, buildings).
   - Mastery cap: top "mastery" upgrades in at most 2 pillars per game.
2. Special upgrades (behaviour, not stats): amphibious tanks (cross narrow water/rivers), radar (see submarines and planes earlier), naval mines (dangerous coast near your ports), drop tanks (much longer air range), night bombing (dodge most SAM fire, less accurate).
3. Research panel with two tabs (hotkey T): Research (stat/effect techs: Economy, Land, Logistics, Influence rows) and Arsenal (Navy, Armor, Air rows with variant forks, special upgrades, "Mastery 1 of 2" counter). One row per pillar, left to right by tier, forks shown as a split with OR, filters per pillar, "next available" highlight, buy from the card.
4. Upgrading without the circle tool: Shift-drag a box also selects your buildings; a bar shows "12 buildings selected: Upgrade x1 / x3 / x5 (U)" with cost; filter by type; remove the circle tool.
5. AI uses variants and upgrades; specialist benchmark again.
Done: all five parts. Arsenal rows in `src/sim/arsenal.ts`, variants `variants.ts`, specials `specials.ts`, AI `arsenalAI.ts`, panel `hud/researchTree.ts` + `hud/arsenalPage.ts`, selection upgrade `selection.ts` + `hud/buildingSelection.ts`. Multiplayer check: `tests/e2e/mp-arsenal.e2e.mjs` (fork bought from the card, the other branch and a mastery refused, a special, Shift-select upgrade x3, variant ships, recon, carrier mission, mines; hashes match) and `mp-pillars.e2e.mjs`.
Final-check fixes: a second click is needed to switch research while one is in progress (it loses progress and gold, and a fork pick); enemy submarines are now hidden on the map until close / sonar / recon / Early Warning (before, every client drew them); recon circles, minefields and the recon aim are drawn on the map; duplicate recon hint toast; "done at once" instead of "done in instant"; "an Airfield" in the terrain message; How to play has Arsenal, paths, specials, mastery and Shift-select upgrade.
Left open (for the balance step or later):
- Specialist benchmark per pillar not built yet (balance step).
- Up to ~700 heavy bombers per game in probes; AI wing logic (`aiAirWings`) doesn't use carriers for strikes; divisions rarely cross straits (AIs keep a land front).
- `canReconFlight` doesn't check a bombed-out airfield; recon intel cache (`revealedNations`) is tick-keyed (cosmetic only).
- The "All techs" rule gives every fork and all three masteries (sandbox), so forks and the mastery cap only apply with normal research.
- The light-tank screen and recon reveal only matter for submarines and intel (there is no fog of war); their circles are subtle.
- Research tab footer can sit at the panel's bottom edge on 1440x900 (fine at 1280x800).

## After round 2: full balance check - DONE 2026-10-31 (kept changes; what still fails is listed below)
Benchmarks: run batches on GitHub's runners with `scripts/remote-batch.sh <label> -- <batch.ts options>` (about 10x faster than local; `--decided 0.6` ends decided games early, win rates only). Baseline = the tree before the balance round; every comparison on the same seeds, then on fresh seeds (5001+, 5101+). Log: /tmp/fa-bal/log.md.
Kept (config.ts / AI): Nuclear Fission 5000/2000 -> 3500/1500; Naval doctrine warships and transports -35% price / +35% speed (was 25%); Merchant doctrine gold +8%, market bonus +15% (was 12% / 25%); light tanks defence 0.85 -> 0.95; tank divisions fall back to own land within 5 tiles (-8% troops) instead of being overrun; AI: heavy-bomber raids, Radar after enemy bombers, SAMs 24 tiles behind the front, coalition nukes, mercenary gold gate 20 s -> 8 s of income; Hard difficulty: 6 min grace, 1 war at a time for the first 10 min, attack cap 1.2x, pause x2 (no longer a cliff).
Final table on fresh seeds (baseline -> now; ratio = specialist land vs the normal AI in the same slot, 192 pairs):
| Target | Baseline | Now | Result |
|---|---|---|---|
| (a) navy / armor / air / land / economy | 0.40 / 0.93 / 0.65 / 0.72 / 1.44 | 0.67 / 1.30 / 0.75 / 0.75 / 1.62 | armor ok; navy, air, land borderline (0.67-0.75); economy too strong (World 4.0) |
| (b) length medium / World (min) | 34.0 / 37.5 | 34.6 / 38.8 | inside 20-35 / 25-40 (medium highlands 37.0) |
| (c) 15-min land leader wins | 26% | 23% | ok |
| (d) doctrines (random pick) | blitz 2.0 | blitz 2.27, air 0.47 | fail |
| (d) doctrines (AI pick) | air 2.0, naval 0.3 | air 2.7, siege 1.9, fortress 0.3, naval 0.2 | fail |
| (d) fork paths | subs 1.5, destroyers 0.5 | all 0.9-1.1 (World ground attack 0.3, 19 picks) | ok on medium |
| (e) Hard alive at 10 min | 0% | 100%, 8 of 12 die at ~25 min; Easy/Normal 100% at 20 min | ok |
| (f) bombers shot down | 7% | 10% medium, 13% World | fail (target: meaningful share) |
| (f) tank divisions overrun | 85% | 72% medium, 67% World | fail |
| (g) most heavy bombers in one game | 869 | 899 (World 567-1220) | fail |
| (h) atom bomb >= 5 min before the end | 25% (1 of 4) | 11% (1 of 9) | fail |
| (h) merchant personality vs its share | 1.9x | 2.0-2.25x | ok (< 2.6x), close |
| (h) mercenaries | 16 hires/game | 69 hires, winners spend 0.6% of gold | fail: they decide nothing |
| (i) tick time p99 | 7.2 ms | 7.3 ms | ok |
Still failing / next: economy specialist is the top pillar (tune the normal-AI economy or Banking/Markets, then re-measure on 192+ pairs: one slot on 48 seeds is noise, slots disagree up to 2x); blitz doctrine over-picked and air under-picked (AI doctrine scoring); SAM/fighter kill share and tank overrun rate still low; heavy-bomber spam (cap or cost curve); atom bombs rarely come early; mercenaries need a bigger role (price or cap). Not checked: humanbench "steady" style, World broken down by map type (6 seeds each), direct measures of destroyers finding subs and forts slowing light tanks. An idle human (no clicks at all) is still eliminated by neighbours/tribes at 3-5 min on Easy and Normal (same as before the round).

## Tutorial mode (done 2026-10-31, made quick 2026-11-01, on `dev`, not merged yet)
Title screen, **Tutorial**: one practice game of 10 steps (labelled 5 min; a scripted new player finished it in 38-64 s) on a hand-made map (src/sim/tutorialScenario.ts), steps in src/client/tutorial/steps.ts; ends with Play now (an Easy game) or Main menu, and the guide teaches the rest in normal games. Replaced the 8 chapters. `state.tutorial` is only set by setupTutorial (single player); no new actions, no protocol change.
Open: checked at 1280x720 only; the step text is not translated.

## In-game guide (done 2026-11-01, on `dev`, not merged yet)
Normal games (single player and online, client-side only): a small guide bar above the command bar (moves to the top strip when it would cover its target or an open panel) with a step counter, Show me (map steps), Next / Skip, Hide guide; the tutorial's brass ring + arrow on the button or map tile (spotlight shared in src/client/tutorial/spotlight.ts). Opening: start, Start now, troops, gold, expand, ATTACK %, City, tribe, standings. Then one-time tips: attacked (critical, cuts in), research, doctrine at 5:00, troops full and idle, first strike ready, port/navy, factory/tanks, airfield/air missions, alliance offer, coalition, Arsenal, Shift-select upgrade. Prefs in localStorage `frontline.guide.v1`; Menu: Guide on/off, Restart guide. Replaced the advisor's old first-game steps (the advisor hides while the guide shows). Code in src/client/guide/; tests tests/guide.client.test.ts.
Playtest 2026-11-01 (three new players in the browser: follows everything / ignores the guide / skips everything then Restart guide; Easy single player, one private online game, Tutorial chapter 1 to the end). Fixed: "Good spot" shown before a start was placed (after Skip); steps after Start showing during the spawn phase (0/0 troops); the City step asking for a second City when one was built before it showed; the expand step without an arrow when no empty land is left (after Restart guide): passed over; online guests told to press a Start now they don't have; the alliance tip pointed at the standings, where the nation often isn't listed (now Diplomacy, which shows the request count); the attacked tip said "A neighbour" with no Show me once a short attack had ended (it keeps the name and tile); waiting tips now come in list order (the doctrine pick no longer waits behind an idle-troops hint after a long opening); plainer troops and Arsenal texts.
Open: coalition and strike tips never seen in a browser (unit tests only; factory and airfield only in the first runs with extra resources); the attacked tip seen only with a test-made attack (no AI attacked in the runs, human grace is 3 min); a passive player sees the opening for ~5 min (each goal step waits its full time limit); a player who finished the Basics chapter gets the tips without the opening; texts not translated.

## Military tune (2026-11-01, on `dev`, not merged yet)
Kept (config.ts / ai.ts / airwings.ts): Blitz doctrine open ground 30% -> 10%, armor conversion 25% -> 15%, perk terrain ignore 50% -> 30%; Naval doctrine also +40% trade gold; air support zone radius 7 -> 11 (+2 per level, was +1); a nation with more than 2 airfields on missions flies each 50% slower per extra one (`AIR.massFree` / `massCooldown`), AI keeps at most 3 airfields (`AI_MAX_AIRFIELDS`); shore support range 12 -> 18, first-ship bonus 0.35 -> 0.45, cap 0.8 -> 1, beachhead loss next to own warships x0.4 -> x0.2; tank fallback radius 5 -> 8, overrun below 10% (was 20%) of a full division. Log: /tmp/fa-bal/log2.md.
Results (384 specialist pairs on four seed sets, 288 random-doctrine games, 96+96 medium + 24 World normal games): armor 1.57 -> 1.10, land 0.60 -> 0.77, navy 0.70 -> 0.69, air 0.76 -> 0.71, economy 1.46 -> 1.51; Blitz 1.92 -> 1.55, Naval 0.44 -> 0.73, Air 0.69 -> 0.64; sorties max / median 4.7x -> 2.9x, peak aircraft max 31 -> 18; overrun 72% -> 64-68%; length and leader-at-15 unchanged.
Still failing: navy and air specialists ~0.7 and economy ~1.5 (the specialists give up economy for their pillar); Air doctrine (cheaper or more bombers, stronger strikes: none helped); Blitz 1.55; atom bombs >= 5 min before the end 22-31% (Fission comes ~36 min, last in the research order); mercenaries 0.6% of winners' gold.

## Economy + new-player tune (2026-11-01, on `dev`, not merged yet)
Kept: human grace by difficulty (a walled-in human can't collapse or be absorbed for 10 min on Easy, 6 on Normal, 3 on Hard/Brutal: `HUMAN_GRACE_BY_DIFFICULTY`, `combat.humanGraceSeconds`); Easy AI starts keep 2x the usual spacing from a human's start (`DIFFICULTY.humanRoom`); Easy AI economy growth / income / cap 0.7 / 0.7 / 0.7 -> 0.5 / 0.6 / 0.5; AI mercenaries (aispending.ts): gold gate 8 -> 4 s of income, a push counts below 50% of the bar (was 35%), budget 30% / 50% -> 45% / 60% of gold, 20 s between hires (was 30); merchant personality researches Banking 4th (was 2nd), market lean 1.6 -> 1.3, port 1.6 -> 1.4. Log: /tmp/fa-bal/log2.md (pass 3).
Results: idle human on Easy / Normal alive at 12 min in 12/12 (was 4/12 and 3/8: absorbed at 3-5 min by the AI that walled it in, no attack); scripted new player Easy rank at 20 min median 6.5 / 6 -> 4 / 5 of 9 (medium / World; fresh seeds 7 / 7 -> 5 / 5), Easy and Normal alive at 20 min 100%, Hard and Brutal unchanged; winners' mercenary share 0.6 -> 1.8% of gold; merchant personality 2.0x -> 1.85x its share (1.6x with that change alone); specialists (288 pairs) navy 0.67 -> 0.82, armor 1.34 -> 1.13, air 0.90 -> 0.83, land 0.69 -> 0.73, economy 1.68 -> 1.66; length 34.8 / 36.6 -> 36.0 / 36.5 min.
Still failing: economy specialist ~1.65 (its edge is early Agriculture + Banking and a market/lab lean; every gold cut tried (markets, Banking) moved economy into range but pushed navy and air down, since airfields, bombers and warships need gold); mercenaries still a small share; atom bombs >= 5 min before the end 7-8%; AI-only Easy games rarely end within 50 min (13%, was 58%).

## Guide + balance round: final check (2026-11-01, on `dev`, not merged yet)
Checks green: `npx tsc -p .`, `npx tsc -p server`, `npx vitest run` (703 tests; no balance-number test needed updating), `npm run build`; multiplayer `mp-pillars` and `mp-arsenal` PASS (hashes agree; `mp-arsenal` once failed its fixed 5 s "research seen by A, B, C" wait while three browser runs shared the machine, then passed alone). New-player run on Easy at 1280x720: the 9 opening steps each pointed at the right button or tile and moved on; no console errors. How to play has a Guide row (Menu > Help: Guide on / off, Restart guide).
Balance verification on fresh seeds (7001+) vs base2 (c700ea3); "base" = the old tree on the same fresh seeds. Log: /tmp/fa-bal/log2.md.
| Target | base2 | Base, fresh seeds | Now [95%] | Result |
|---|---|---|---|---|
| Specialist navy / armor / air | 0.77 / 1.70 / 0.68 | 0.45 / 1.25 / 0.68 | 0.87 / 0.99 / 0.84 | pass (air: slot 1 1.25, slot 2 0.59) |
| Specialist land / economy | 0.61 / 1.43 | 0.83 / 1.63 | 0.71 [0.52-0.96] / 1.66 [1.28-2.29] | fail |
| Blitz / Air / Fortress (random pick) | 1.92 / 0.69 / 0.76 | 2.23 / 0.61 / 0.55 | 1.82 / 0.65 / 0.65 | fail |
| Naval / Siege / Merchant / Expansion | 0.44 / 0.99 / 1.21 / 0.95 | 0.97 / 0.88 / 1.04 / 0.61 | 0.74 / 1.10 / 1.04 / 0.93 | pass |
| AI doctrine picks, Air win ratio | 2.05 | 3.00 | 3.06 (34 picks) | fail |
| Bomber sorties / most aircraft, max / median | 4.7x / 1.7x | 3.9x / 1.7x | 3.1x / 1.2x | pass |
| Median length medium / World (min) | 34.3 / 38.3 | 34.7 / 37.8 | 36.2 / 40.4 | over target; the change itself +0.4 / +1.8, not clearly real |
| Leader at 15 min wins / Hard alive at 10 min | 20% / 100% | 27% / 100% | 21% / 100% | pass |
| Atom bombs 5+ min before the end | 9% | 3/16 | 3/10 (14% with the tuners' runs) | fail |
| Winners' gold on mercenaries | 0.6% | 0.6% | 1.8% | fail (small) |
| Slowest 1% of ticks (ms) | 7.2-7.6 | 6.2 | 6.3 | pass |
Claims that didn't hold on fresh seeds: Blitz 1.82 (not 1.55); AI Air-doctrine picks still 3.1; merchant personality 1.48x its share before and after; idle human on Normal alive at 12 min 10/12 (deaths at 10.5 and 11.2 min, after its 6-min grace; Easy 12/12); new player on Easy, World map rank 7.3 -> 6.8 (no clear change; medium 6.75 -> 5.25 is real).
Still open: economy and land specialists, Blitz and AI Air-doctrine picks, early atom bombs, mercenaries; AI-only Easy games rarely end (5 of 48 within 50 min, was 22); guide: attacked / coalition / strike tips not seen in a browser with a real AI attack, a passive player sees the opening for ~5 min, texts not translated; not checked: Brutal, World by map type.

## Round 3: battle readability (2026-11-01, on `dev`, not merged yet; client-side only)
- Front lines: borders at war get a line (brass on your fronts, faint for others) with push arrows and troop pills; hover for speed (src/client/render/fronts.ts).
- Map effects: short flashes for cities and capitals changing hands, ships sunk and bombs, a small shake near a nuke (none with reduced motion); Menu, Map effects off (src/client/fx/). Three new sounds: city taken, city lost, ship sunk.
- Summary on the game-over card: land over time, key moments, a nations table; the Victory chip reopens it after playing on (src/client/summary/).
Open: 60 fps not confirmed on a real GPU (far-zoom p95 frame time 20-26 ms vs 16-18 ms before in the software-rendering test browser, few frames, noisy); the player's blue is close to the AI nation Vesperia's; the guide and the advisor sometimes give the same alliance tip.

## Arsenal shop + faster research (2026-11-01, on `dev`, not merged yet)
Owner: the Arsenal and the Research tree shouldn't all be research points that take that long.
- Arsenal items (navy, armor, air rows, specials, masteries, Mechanized Infantry, Recon Planes) are BOUGHT, not
  researched (src/sim/procurement.ts, Action `procure`, `Player.procuring` hashed, config `ARSENAL_PRICES`): unlock
  1500 gold + 300 iron (20 s); path / shared 3000 + 1000 (25 s); upgrade / special 5000 + 2000 (35 s); mastery 15000 +
  6000 (45 s). Armor pays iron, navy and air 70% oil + 30% iron; the three unlocks iron only. Navy items need a Port,
  armor a Factory, air an Airfield (Flight unlocks the Airfield, so it needs none; Early Warning none). Several on
  order at once; forks lock at the order; mastery cap 2 counts orders. `research` on an Arsenal item is refused.
- Research tab: `BASE_SCIENCE` 0.5 -> 3; science tier 2 600 -> 300, tier 3 2200 -> 1300, Fission 3500 -> 2100,
  Industrial Boom 5000 -> 3000 (tier 1 and gold unchanged).
- Client: Arsenal cards show gold + iron / oil, delivery time and the building needed; the tab header lists orders
  with a countdown; guide tips and How to play say buy (Prices row added); doctrine advice "Buy Flight in the
  Arsenal first".
Results (48 medium seeds, before = 890fc20): Research tab owned at 20 min 10% -> 58% (31% at 10 min, 76% at 30 min);
Arsenal items owned 3.2 -> 6.6; first path 10.3 -> 4.6 min (per nation 12.5 -> 7.8); first special 20.1 -> 10.8; first
mastery 27.5 -> 19.3. Specialists navy 0.51 -> 0.66, armor 1.22 -> 0.97, air 0.69 -> 0.97, land 0.95 -> 0.89, economy
1.65 -> 1.53. None of the price-adjustment triggers fired, so the starting prices stay.
Tune later: Nuclear Fission now first at 18.3 min (was 37.3), atom bombs 11 in 9 games -> 65 in 37 (first at 24 min;
Fission's science is the lever); median game 35.8 -> 29.0 min, 81% of games end in 25-50 min (was 96%); fewer slot
nations alive at 20 min (armor specialist 79% -> 54%); navy still under 0.7, economy high; the scripted new player
was not measured in the batch.
Final check: `npx tsc -p .`, `npx tsc -p server`, `npm run build`, `npx vitest run` (737) green. mp-arsenal (now
grows land, builds a Port / Factory / mine / well, buys Navigation, Destroyers, Mechanization and Amphibious Tanks with
procure; fork and mastery refusals; the old research action refused) and mp-pillars PASS on the final build, hashes
agree. One earlier mp-arsenal run on a very busy machine had a hash mismatch (turn 3219, Bob's client only) that did
not come back in three later runs; not explained. Defensive fix: the division-defence and runaway-leader caches are
now dropped when the sim starts work, like the army cache (client reads between ticks; tests/lockstepReads.test.ts),
and the e2e now prints which state parts differ on a mismatch. E2e scripts take `E2E_PORT` and refuse a port another
run already uses. New-player browser run (Easy): Research card -> Logistics, Arsenal: Flight bought and delivered,
a path item without an Airfield shows "Build an Airfield first", Ground-attack Planes + Drop Tanks on order at once
with countdowns, both delivered, fork locks Heavy Bombers; quick tutorial finished in 62 s; no console errors.
Screenshots /tmp/borderfall-shots/proc-check-*.png.
Pacing pass (config.ts; 48 medium seeds + `--specialist all`; old main / shop round / now): `BASE_SCIENCE` 3 -> 2;
Nuclear Fission 2100 science + 1500 gold -> 14000 + 3000; Industrial Boom 3000 -> 4000 science; Mass Mobilization and
Automation 8000 -> 12000; tier 2/3 science stay 300 / 1300; Arsenal path 3000 + 1000 -> 3600 + 1200, upgrade / special
5000 + 2000 -> 9000 + 3500, mastery 15000 + 6000 -> 25000 + 10000 (unlock unchanged). Research tab owned at 20 min
10 / 58 / 52%; first path per nation 12.5 / 7.8 / 8.3 min; first Fission 37.3 / 18.3 / 27.5 min; atom bombs 11 / 65 /
26; median win 35.8 / 29.0 / 30.3 min; nations alive at 20 min 80 / 60 / 62%. Game length and survival don't come back
with these levers (every variant 29.4-30.7 min); the cause is elsewhere in the shop round (untested guesses: faster
tier 1-2 research, the AI's buying). New seeds (`--start 1001`) not checked; survival numbers are noisy (+-14 points).
Desync fix (HUD reads between ticks changed sim caches; there is no state snapshot: a late joiner or reload replays
every turn from 0): the supply-source cache filtered beachheads by owner when built and its key didn't change on a
capture (now filtered when used; dropping beachheads bumps the version); the navy cache is cleared at tick start and in
`applyAction` (`clearNavyCache`); owned coast / iron / oil lists are compacted only in `setOwner`, never on a read; a
captured building goes into its new owner's index in id order. Audit of every module-level cache in src/sim: the AI-only
caches are filled at the same ticks on every client and would only break with a real state snapshot. Test
`tests/snapshotSync.test.ts` (helper `tests/hudReads.ts`, ~5 min): a game reading the HUD every tick, a quiet one and
two rebuilt from the turn log must hash the same; all 3 cases failed on the old code (split at ticks 5550 / 7060 /
8310). No new state, protocol still 10; AI behaviour changes slightly (supply always current), no balance batch after it.
Join check (2026-11-01, dev 45e94f6): tsc both, `npm run build`, `npx vitest run` (740, snapshot test included) green;
mp-arsenal #1: game 1 hashes agree (120 turns, 2129..3319), then game 2 failed before its hash check ("A could not
place port/airfield/factory": A found no oil in 5 min and got no Airfield / Factory site; script, not a desync);
mp-arsenal #2 PASS (game 1: 119 turns 3299..4479, game 2: 119 turns 889..2069); mp-pillars PASS (120 turns 889..2079).
No hash mismatch or desync flag in any run.

## Parked ideas (owner said later / maybe)
Building limits (city slots, upkeep), rivers and bridges, wonders, game modes (King of the Hill, capital capture, scenarios), quick chat/emotes/rematch, phone layout, making Easy winnable, calmer tribes.
