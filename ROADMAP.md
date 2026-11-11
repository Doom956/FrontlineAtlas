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

## Round 4: "Follow my war" (2026-11-01, branch `round4`, not merged yet)
Owner: strategic bombing (and similar orders) should follow whichever nation I attack, without resetting it.
- The player's war target (src/sim/warTarget.ts): the nation attacked with the most troops now (tribes count less, a 1.25x margin before switching), else the last one attacked within 60 s.
- Default for the player's units: air wings (Strategic raids it, Support bombs its main front, Superiority patrols over that front), warships (Bombard / Blockade / Auto go for its coast and ports first) and tank divisions on Support front. AI units are unchanged.
- Picking a target by hand makes that unit Fixed; a "Follow my war" button in the airfield panel and the orders bar switches it back. Optional Auto recon per airfield (off by default: each flight costs gold and oil).
- Protocol 10: `follow` on setAirMission / setDivisionMode, `target` + `follow` on setUnitStance, new setAutoRecon.
Open: a Fixed wing or fleet still needs a running attack or the 30 s war memory before it flies; Auto recon keeps no gold back.
Group controls (owner: "same for the warships, it's hard to control them, and airfields, and probably tanks if you have a lot"):
- Forces drawer: one row per type with its count ("Warships 14", "Airfields 5", "Tank divisions 6") and one order bar for all of them (src/client/groupOrders.ts, hud/groupBar.ts): warships Follow my war (Auto) / Hold / Hunt / Escort / Bombard / Blockade, airfields Support / Strategic / Superiority / Idle + Auto-refill all + Auto recon all, divisions Support front / Hold / Refit. The group's order is the most common one; "N set by hand" (other order or a fixed target) with Reset to all. Orders go out as setUnitStance / setDivisionMode with up to 64 ids each and one setAirMission / setAutoRecon with airfield -1; units that already have the order are skipped. Lists of more than 6 rows fold behind "Show each".
- New warship stance Hold (sim, protocol 10 still): sinks enemy ships near its post like Auto but never sails off to shell a coast. Appended to WARSHIP_STANCES so hashes of older stances are unchanged.
- Quick selection: double-click your warship or tank division = all of that type on screen; Shift+W / Shift+A (all) as before; listed in Controls.
- Fleet markers (render/fleets.ts): below zoom 4, warships of one owner within 4 tiles or 16 px on screen (chained) draw as one marker with a count badge; a click on your own marker selects the fleet (Shift adds). Grid-bucketed single linkage: ~0.07 ms per frame for 200 ships.
- Fix: a Fixed Strategic wing with no war against its nation said "Raiding X · next 2 s"; it now says "Waiting: no war with X".

## Economy rule + doctrine + mercenary tune (2026-11-02, on `dev`, not merged yet)
Kept, economy (config `GOLD_RULES`, economy.ts): the gold bonuses (markets, Banking, doctrine gold) add up instead of
multiplying, and Banking / Merchant make each market level pay more but no longer lift the +80% market limit. Economy
specialist 1.64 -> 1.30 on 384 pairs; the other pillars within noise. Log: /tmp/fa-bal/log4.md.
Kept: AI mercenaries also during any war against another AI nation while the bar is under 65% (wars on a human keep the
old triggers), budget 45 / 60% -> 60 / 75% of gold, 20 -> 12 s between hires (aispending.ts); Blitz armor conversion
-15% -> -10%; Air doctrine aircraft -25% -> -35%, airfield reload -25% -> -40%.
Results (medium, 192-384 games per figure): winners' gold on mercenaries 1.9% -> 9.5-9.9% (World 1.7 -> 6.4%); random
doctrines Blitz 1.32 -> 1.21, Air 0.76 -> 0.88 (both seed sets agree); length, leader at 15 min, Fission unchanged;
research at 20 min -0.2 to -0.45 techs; Hard humanbench unchanged on 72 seeds; Easy / Normal 100% alive at 20 min.
Found: the AI Air-doctrine win ratio (~2x) is the AIs that pick it, not the doctrine: with no doctrine bonus at all
its pickers still win 2.6x (they already own Flight and airfields). Tried and dropped: Banking +20% (economy specialist
into range but every other pillar down), Fortress 0.4 / 0.4 / 0.3 (no measurable effect), cheaper mercenaries (AIs
are short of gold, not of price).
Still open: economy specialist 1.3-1.5 vs a normal AI; AI Air pickers win ~1.7-2x by selection; research at 20 min
~49-50% (edge of target).
Final check on fresh seeds 13001+ (base4 = 9bdda7e vs now = e7bf301; medium 192 pairs / games, World 24-48, [95%]):
| Target | base4 | Now | Result |
|---|---|---|---|
| Specialist economy | 1.63 [1.22-2.19] | 1.28 [0.97-1.72] | fail, much closer |
| Specialist navy / armor / air / land | 0.66 / 0.96 / 0.83 / 0.78 | 0.69 / 0.88 / 0.73 / 0.68 | armor pass; navy, air, land fail |
| Random doctrines Blitz / Air | 1.11 / 0.88 | 1.43 / 0.69 | fail (the doctrine change itself: +0.11 / -0.18, within noise) |
| Random doctrines, the others | 0.62-1.18 | 0.74-1.40 | pass |
| AI picks Air / Merchant / Fortress | 1.80 / 1.30 / 0.60 | 1.63 / 1.35 / 0.49 | fail |
| Winners' gold on mercenaries | 1.7% | 9.7% (World 8.6%) | pass |
| Length medium / World (min) | 30.3 / 35.9 | 31.7 / 36.6 | pass |
| Leader at 15 min wins / first Fission (min) | 38% / 27.5 | 31% / 28.5 | pass |
| Research at 20 min, medium / World | 51.5% / 50.9% | 49.9% / 49.3% | fail (edge; spread over all three changes) |
| Easy, Normal / Hard alive at 20 min | 100% / 60% | 100% / 81% | pass |
| Tick time p50 / p99 (ms) | 0.9 / ~8 | 1.2 / ~8 | p50 +30% (comes with the economy rule) |
Tuners' claims refuted on fresh seeds: specialists navy 0.98 / armor 1.08 / air 0.93 / land 1.18 (came out 0.69 / 0.88
/ 0.73 / 0.68); AI Merchant picks 1.6 -> 1.0 (1.30 -> 1.35); Blitz / Air moving toward 1. Softer mercenaries (old
budget, or only below 50% with 20 s between hires) didn't bring research back. Nothing reverted.
Still open: economy specialist ~1.3; navy, air and land specialists ~0.7; Blitz random pick ~1.4; AI Air and Fortress
picks; research at 20 min just under 50%; tick p50 up ~30%; Brutal not checked.

## Balance pass 4: dug-in borders + Air cover (2026-11-02, on `dev`, not merged yet)
Number tuning had stalled, so two automatic, visible mechanics (design: /tmp/fa-bal/design5.md, log: /tmp/fa-bal/log5.md):
- Trenches (src/sim/trenches.ts, config `TRENCH`): borders between nations dig in over time (level 1 after ~40 s, max
  2, Fortress +1 and twice as fast, Trench Warfare +1); attacks on dug tiles cost +15% and go 15% slower per level;
  artillery and heavy tanks breach part of it; barrages, atom bombs, air-support zones and bombarding warships flatten
  it; coasts never dig (landings go around); captured tiles start undug. Drawn on the map, tooltip, guide tip `trench`.
- Air cover (airwings.ts, config `AIR_COVER`): an Air-doctrine nation's idle airfields bomb dug-in or stalled fronts of
  its own attacks by themselves (free; "Auto cover" in the airfield panel, plane on the troop pill, guide tip).
- Rule changes with them: Blitz's open-ground speed only on undug tiles; Siege's artillery bonus (0.25) only on dug or
  fortified tiles; Fortress digs 2x / one level deeper / 5 tiles deep; Air zones flatten 2x.
- AI: dug fronts lower war scores, raise artillery and barrages, send warships to bombard and landings behind the line;
  doctrine advice: a dug enemy line raises Siege and Air; habit tastes damped (1 + 0.55 x (v - 1), 0.8-1.25).
Tuning (4 rounds, seeds 14001+ then fresh 15001+): the design's AI doctrine edits killed AI Air picks (2 of 1536) and
pushed Fortress to 38% of picks at 0.5: Merchant advice went back to base, Air's Flight / airfield terms halfway back
(0.35 / 0.25 each, cap 0.5), air-minded taste 1.3, Air's dug-line term 0.3 x level (cap 0.5), Fortress trench terms
dropped. Mechanics: zone flattening 25 -> 40 per pass, warships 25 -> 50, Air cover up to 6 airfields with 2x zones,
AI reacts at a mean front level 1.5 (was 2), landing bias x1.5, air-support aims weigh distance by 1 / (1 + level),
raids held back only for airfields that reach the covered front. Tried and dropped: Air airFlatten 2 (no effect).
Results (base = live main 769e4ed, same seeds; medium 192 games / pairs per set, [95%]):
| Target | Base | Now | Result |
|---|---|---|---|
| Random doctrines, fresh seeds | Blitz 1.69 [1.31-2.07], Expansion 0.65, others 0.76-1.09 | all 0.87-1.27 (Blitz 1.27, Fortress 0.87, Air 0.92) | pass (base fails) |
| Random doctrines, 14001+ | Blitz 1.53, Expansion 0.71 | 0.80-1.39 (r2d) | pass |
| AI picks, 384 games | Air 1.66, Merchant 1.15, Fortress 0.70, Naval 0.66 | Air 1.57 [1.26-1.90], Merchant 1.35, Fortress 0.63, Naval 0.45 [0.13-0.80] | Air at ~1.5 (was 2.0 before the last fix); Fortress / Naval low as in base |
| Specialists, 384 pairs | navy 0.81 / armor 0.94 / air 0.86 / land 1.01 / economy 1.55 | 0.85 / 0.99 / 0.75 / 1.02 / 1.23 | economy into range; air below 0.8 (now/base 0.87 [0.64-1.23]) |
| Length medium / World (median min) | 30.2 / 36.9 | 30.4 (29.9 final) / 36.1 | pass |
| Leader at 15 min wins | 32-37% | 30-37% | pass |
| Fission (median min) | 27.8-28.3 | 27.3-27.9 | pass |
| Research at 20 min (of 23) | 11.40 | 11.33-11.38 | pass (within noise) |
| Winners' gold on mercenaries | 9.0% (World 6.6%) | 8.7% (6.4%) | pass |
| Easy / Normal alive at 20 | 100% | 100% | pass |
| Hard alive at 20 (48 seeds) | medium 65%, World 88% | medium 73%, World 79% | mixed, within noise |
| Trench pass cost | - | 7-10% of tick time, p99 1.6-2.4 ms | local p99 ~7 -> ~8-10 ms on 4 games |
Not re-measured on the final tree: specialists and random doctrines with the last AI-choice fix (it only changes which
doctrine normal AIs pick). Still open: AI Air pickers ~1.5x (selection: rich nations pick it), AI Fortress ~0.6, air
specialist ~0.75, World specialists (intervals 0.2-6). Breakthrough (design5 section 5) stays in reserve.

Final check on fresh seeds (base = 769e4ed, now = the dev tree at ca7813c; 17001+ and 18001+, medium 192 games /
pairs per set, World 24, [95%] paired by seed; log and files: /tmp/fa-bal/gh/v17*, v18*). The tuning rounds' claims
mostly did not reproduce: on 17001+ the base already passed the random-doctrine target, and "Blitz fixed" and
"economy specialist into range" were refuted. Nothing reverted: nothing got clearly worse because of the two
mechanics, and switching either off did not fix the one real drop.
| Target | Base | Now | Result |
|---|---|---|---|
| Random doctrines, 17001+ | 0.77-1.30 | Naval 1.51 [1.14-1.91], Fortress 0.60, Blitz 1.30 | fail (Naval +0.54, the only significant change) |
| Random doctrines, 18001+ | Fortress 0.68, Siege 1.39 | 0.75-1.31 | pass (base fails) |
| Random doctrines, 768 games | Blitz 1.38, Expansion 0.72, Siege 1.22 | Blitz 1.32, Expansion 0.96, Siege 0.97 | pass on average; Blitz -0.06 [-0.30 to +0.16] (not fixed) |
| AI picks, 384 games | Air 2.00, Fortress 0.74, Naval 0.88 | Air 1.60 [1.28-1.93], Fortress 0.69, Naval 0.85 (4% of picks), Merchant 1.18 | fail, as in base |
| Specialists, 17001+ | navy 0.59 / armor 0.77 / air 0.86 / land 0.98 / economy 1.36 | 0.87 / 0.92 / 0.61 / 1.04 / 1.43 | navy and armor pass; air and economy fail |
| Air specialist, 384 pairs | 0.83 | 0.69 (now/base 0.84 [0.60-1.15]) | fail, not significant |
| Length medium / World (median min) | 30.4 / 39.1 | 30.0 / 37.0 | pass |
| Leader at 15 min wins (768 games) | 31.9% | 37.0% (+5.1 [+0.8 to +9.4]) | drifted up |
| Fission / research at 20 min | 28.0 / 11.40 | 27.5 / 11.42 | pass |
| Winners' gold on mercenaries | 8.6% | 9.6% | pass |
| Easy / Normal / Hard alive at 20 | 100 / 96-100 / 75-88% | 100 / 100 / 75-88% | pass, Hard unchanged |
| Tick time (huge map, 40 AIs p50 / p95 / p99 ms) | 2.77 / 6.14 / 8.89 | 2.80 / 6.57 / 9.68 | within budget; ~+15-20% at p99 |
Switched off (17001+): trenches off -> land / armor specialists 0.68 / 0.62 (trenches are what lift them), random
Naval 1.13, Fortress 0.94, AI Air picks 1%; Air cover off -> air specialist 0.64, random Air 0.94 (no measured gain);
warship flattening 25 instead of 50 -> Naval 1.21 but Blitz 1.52 (noise moving between doctrines, not adopted).
Checks on this tree: tsc (client and server), 806 tests, build; e2e mp-pillars PASS (hashes agree on 119 turns);
mp-arsenal failed twice in its scripted setup before any hash check (no port on 2 coast tiles; no room for player
B's lab), the same flakes seen on earlier trees, so its hashes are unchecked on this tree; an Easy
game played as a new player (screenshots /tmp/borderfall-shots/b5-check-*.png): the trench tip came at 4:50 on the
player's first dug border, Show me pointed at it, the tooltip and the "Dug in: +N%" attack line explain it, the
doctrine cards read clearly. Not seen in play: Air cover (covered by tests and a staged screenshot only).
Still open: random Naval high and Fortress low on one seed set; AI Air pickers ~1.6x and AI Fortress / Naval picks
low; air specialist ~0.7 and economy specialist ~1.4; leader at 15 min +5 points; Air cover costs CPU and AI
airfield use with no measured gain (simplify or drop: owner's call); Brutal and World specialists not checked.

## Site icon (2026-11-02, on `dev`, not merged yet)
`public/favicon.svg` (navy square, orange territory pushing a gold front line into teal) plus favicon.ico (16/32/48),
favicon-32.png, apple-touch-icon.png (180), icon-192/512, icon-512-maskable.png and site.webmanifest ("Frontline
Atlas", short name "Atlas"); relative links in index.html, so it works at `/` and under `/FrontlineAtlas/`. Remake the
PNG / ICO files with `node scripts/site-icons.mjs` after changing the SVG. Not checked: the live sites, a phone home screen.

## Air strikes QoL (2026-11-03, live)
Owner: manual bombs ignored Heavy Bombers, bombers hit land the push had already taken, auto missions were limited,
and firing many rockets was tedious. Done (src/sim/airstrike.ts, config `STRIKE`, protocol 15 after the merge with ships and tanks; DESIGN.md section 7,
"Strikes"): (1) one strike rule: a manual bomb runs the wing-sortie code (Heavy Bombers wider / bigger raids, Ground-
attack, Strategic Bombing burn, Night Bombing, Drop Tanks, doctrines, trench flattening) and needs the airfield's
reach; the preview shows role, radius and expected kills / wrecks / cuts. (2) Smart aim: front strikes lead the push
by its speed x flight time; on arrival a lost aim re-aims within 14 tiles or the bombers fly home with their bombs.
(3) Support missions keep pace with the front, Strategic picks the best live target of the Follow-my-war nation,
each airfield shows its last result, re-buy losses on every mission. (4) Salvos x1 / x3 / x5 / All (remembered;
atom bombs x1, salvo asks first). (5) Rocket auto-fire per silo / all silos (forts and SAMs near the front, then
cities; never atom bombs). AI: manual bombs only in reach; with no raid target in reach it bombs the main front of a
nation it fights (owner's call: AI code, not just a number). Costs unchanged.
Measured (192 specialist pairs + 96 normal games per seed set; base = main a0adddc, fresh seeds 26001+): wasted
payloads 30% -> 11%, bombers shot down 16% -> 6%, bomber sorties 43.4k -> 33.5k, rockets per game 40.4 -> 42.7; air
specialist 0.79 -> 0.75 (goal 0.8-1.25 not reached; intervals about +-0.3); other specialists, game length, first
atom bomb about unchanged; Humanbench Easy / Normal unchanged. Log: /tmp/fa-bal/log7.md.
Checks after merging ships and tanks: tsc (client, server), vitest 863 tests, build; e2e on GitHub runners: mp-arsenal
passed on map seed 12, mp-pillars on seed 13 had matching hashes on all three clients (120 turns and after 20 s more,
no desync) and then failed only because its bombard warship had been sunk (test now skips the stance check when no
ship is left); the other seed runs failed in the scripted setup. Defaults now: pillars seed 13, arsenal seed 12; a played check (Heavy Bombers raid preview 5.8 vs 5 tiles and a 5.75-tile drop, front strikes during a
fast push landing 1-11 tiles ahead of the front on enemy land, a x5 salvo, an All rocket salvo from 2 silos, auto-fire
hitting 2 forts and a city, no atom bomb fired); screenshots /tmp/borderfall-shots/air-check-*.png. Not checked:
World-map batches, forced Heavy Bombers / Ground-attack fork benchmarks, tick timings.

## Ships and tanks (2026-11-03, live)
Owner: "the tanks are kind of useless right now, they move way way too slow to attack so they rarely get used; the
warships are also kind of useless because they just stay in one area and the auto function doesn't really change that.
Make it so you can spawn the ships anywhere, they attack in a much bigger range; for the tanks idk."
- Warships: placed on any water of a sea one of your finished Ports touches (no 40-tile limit; same price and build
  time); gun range 20 -> 35, detection 3x range, shelling half the gun range (battleships x2), shore support range
  18 -> 30 (each extra ship 0.75 of the one before, cap 1.4). At war, Auto / Follow ships roam their whole sea to the
  war target's coast and go home only to repair (under half hull); Hunt searches the whole sea; Hold stays put.
- Tank divisions: moves over own connected land by rail at 20 tiles/s (Railways x1.5); spearheads 3 -> 8 tiles/s,
  60 deep, launched up to 12 tiles past the border (no water on the line, except narrow water with Amphibious
  Tanks); Support front divisions jump to the war's main front and strike weak spots at half strength; AIs build up
  to half their factory capacity in divisions (max 6).
- Measured (24001+, 192 pairs, base a0adddc): navy specialist 0.76 -> 1.01, armor 1.09 -> 1.13 (inside the target,
  "better than base" not shown for armor), divisions per game 20.4 -> 43.0, warships in action 11 -> 16% of ship
  time; game length, leader at 15 min and difficulty unchanged. Huge-map p99 tick ~3 ms higher (neither version
  under 15 ms at 40 AIs). Log: /tmp/fa-bal/log6.md.
- Final check: tsc both, vitest 827/827, build OK. E2E: no hash check reached in 6 runs (3 each, the allowed reruns): mp-pillars failed in the
  scripted player's start (no spawn site with iron, oil and a coast x2; "A has no iron/oil"), mp-arsenal in its
  economy ("labs not built" x2: no oil within 26 tiles, so the start never grew; "Mechanization delivered" timed
  out); all before any ship or division exists, no desync or hash mismatch logged. Fixed by giving the tests a known map: the server
  takes FIXED_SEED (tests only) and the tests default to map seed 12; on GitHub runners (scripts/remote-e2e.sh,
  .github/workflows/e2e.yml) seeds 12 and 13 passed both tests with matching hashes, 4 other seeds failed in the same
  scripted setup. Easy game as a new player (screenshots
  /tmp/borderfall-shots/st-check-*.png): a warship ordered from the Port card and placed 96 tiles out by a click
  appeared there and, at war, took station off the enemy coast and shelled it (veteran in ~1 min); a division
  rail-moved 160 tiles (227-tile route) in 6-8.5 s and a two-click spearhead took 28 tiles (4 into mountains, as
  its preview warned). Small fixes: the unit card no longer
  catches map clicks (a spearhead target 12 tiles out could sit under it; only its X takes clicks); warship hull
  text uses the real maximum ("4 of 3" for veterans and variants before); How to play says a second click launches
  a spearhead.
Open: AI tank/ship use on World maps (24 games, too few); tick p99 at 40 AIs; scripts/profile.ts skips warships and divisions.

## Auto for every vehicle (2026-11-03, live)
Owner: "auto is for every vehicle needs to be improved"; earlier: strategic should hit whoever I attack, warships,
airfields and many tanks are hard to control. Easy for new players, no hotkeys. Protocol 16.
- War target: the nation the player attacks; with no attack of its own, the last target while that war is live (a
  short poke by someone else doesn't swing the units), else the nation attacking it hardest; kept a minute after.
- New defaults for a player's units (AI unchanged): divisions Support (following), airfields Support (following; an
  "every airfield" choice also reaches later airfields), silos auto-fire on. Warships stay Auto.
- Reach: wings out of reach of the main front bomb the nearest front (or, overseas, coast) they can reach; strategic
  wings raid another nation at war when the target is out of reach; divisions flood their own land when the quick
  route search gives up, and support a front they can reach for 60 s when the main front is on land they can't reach
  (also near it); Auto ships skip chases and coasts where enemy warships outnumber them, fall back to a Port and wait
  20 s before looking again.
- Cards: one plain "Auto: ..." line on the unit card, the airfield panel and the silo card.
- Auto bench (scripts/autobench.ts, GitHub runners, medium maps, normal, 25 min, 240 games per setting; "none" = no
  orders at all; before auto-base2 on b0b44c1, after auto-final; mean +- 95%):
  - Divisions: useful 10% +-2 -> 40% +-2, idle 89% +-2 -> 15% +-3, first use 420 s -> 12 s, never used 44% -> 2%.
  - Airfields: useful 0% -> 73% +-3, idle 95% +-3 -> 22% +-3, 0 -> 27 sorties a game, never used 100% -> 4%.
  - Silos: useful 0% -> 23% +-2, idle 100% -> 77% +-2, 0 -> 7.3 rockets a game.
  - Warships: useful 50% +-3 -> 48% +-3 (no change), lost 12.6 of 17.2 -> 12.7 of 17.6 bought.
  - Wasted strikes: bombs brought home 2%, dropped off hostile land 0%. No war target while at war: 0% -> 0%.
  - Player land at 25 min: 7% -> 9% (paired +1.7 +-0.9 points); fresh seeds 5001+: +1.4 +-0.9, divisions 11% ->
    41%, airfields 0% -> 71%, silos 0% -> 23% useful. With one click per vehicle ("once") land is unchanged
    (-0.4 +-0.9).
- AI unchanged: AI-only batches (96 normal + 192 specialist games, seeds 27001+) give identical results before and
  after, apart from tick times; the casual-human bench (Easy / Normal, 48 games) is identical too.
- Checks: tsc (client, server), full vitest (6 tests hit the 5 s timeout under load, all pass with a longer timeout),
  npm run build.
- Multiplayer e2e on GitHub runners: both tests passed on their default maps and a random map (with groups, alerts
  and save/resume merged too).
- Not checked: a passive-player bench (the defence war target is covered by unit tests only); hard
  difficulty and other map sizes.
- Left open: warships are still sunk at ~72% of those bought (mostly by enemy warships); divisions spend 16% of war
  time refitting; silos idle 77% (no target near the front: the list was kept narrow, rockets cost 900 gold);
  airfields have nothing in reach about 17% of their war time.

## Groups, alerts, save/resume (2026-11-03, live)
Owner wanted these three after ships/tanks and bombers, all clickable with visible buttons (no new hotkeys). Client
only: no src/sim file changed (released together with the auto round, protocol 16), save format 1. DESIGN.md (client section) and How to play updated.
- Groups (unitGroups.ts, hud/groupsStrip.ts): in Forces, select warships or tank divisions, click New group: a
  button "Fleet 1 · 8 ships" (Tanks 1, Group 1 when mixed). Click it to select them again (lit while selected), the
  target icon centres the map on them, + adds the selection, x deletes (Undo). Click a selected group again to rename
  it, with Save and Cancel buttons (a group that is already the selection, such as one just made, needs one click
  first, so a first tap never opens the phone keyboard). Lost units drop out. Saved with the game.
- Alerts (alerts.ts, hud/alerts.ts): big events about you (attacks, capital under attack or lost, land falling fast,
  port blockaded, ship sunk, division overrun or stranded, atom bomb / rocket / bomber / landing / paratroopers on
  the way, an ally asking for help) as cards under the standings; repeats count up ("x3"). Click a card: the camera
  jumps there with a ping. The bell in the top bar (red count) opens the last 20. On phones the cards sit in the
  top-centre column with the mode chip and toasts (they covered each other before), and an open drawer and the
  nation card stay above that column.
- Save and continue, single player (save/): every 30 s and when the page closes or goes to the menu; "Continue" on
  the start page replays the game's orders to the same state (hash checked; a save from changed code can be loaded
  anyway or deleted). A game that ended earlier in this version goes on from what was replayed (before: the next
  save was unreadable); a sim error while playing is noted, so the load fails and goes on at the same point (before:
  "Could not load this game"); a finished game removes its save even after saving stopped (too long or storage
  full), and that toast now says Continue starts from the last save.
- Top bar on phones: buttons narrow to fit (the bell had pushed Forces off the left edge).
- Checks: tsc (client, server), build, full vitest 899 of 901 (the 2 others, a doctrines and a trenches hash test,
  hit the 5 s timeout under load and pass alone: 39/39). Tests: save.test.ts (replay, tick errors before
  and after a save, an older save without the note, a tick that never works, a save loaded anyway that ends early,
  format checks), unitGroups.client.test.ts, alerts.client.test.ts. Playwright on the built app: the merge check
  (21/21: groups, reload, Continue with the same hash, groups back, a paused rename saved, alerts and camera jump,
  bell log, phone pass) and the review-fix check (47/47 at 390x844 and 360x780 with touch, and 1440x900: every group
  row tappable with a selection and while paused, alert cards, chip and toast fully visible, nation card unmoved and
  its buttons on top, Save/Cancel rename, alerts move between columns on resize). Screenshots
  /tmp/borderfall-shots/d-merged-*.png, d-fix-*.png.
- Multiplayer e2e on GitHub runners (with the auto round): both tests passed on their default maps and a random map.
- Not checked: real phones (only a desktop browser at phone size); a real
  sim error during play (tests inject one); a game over 3 M characters. Alerts in the play checks were injected
  events. Open: on phones the new-player guide bar (its own layer) sits over an open drawer, including group rows,
  until Next or Hide guide; hovering a group shows its tooltip over the name.

## Fog of war (2026-11-05, branch `fog`, not merged yet)
Owner asked for a fog of war game mode. A game rule (Modifiers.fogOfWar), off by default, never in the tutorial.
Protocol 17 (the owner-chat round also bumps it: whichever merges second takes the next number).
- Rule: each player sees in 16 x 16 tile blocks. Sources: own land (24 tiles past the border), units (warship 30,
  tank division 20, transport 12, planes 12 to 20), finished Watchtowers (half their intel radius, 40 at level 1) and
  Ports (30), recon reveals. Allies and teammates share vision; planes and missiles also show on SAM and airfield
  radar. Vision is lockstep state (src/sim/fog.ts, hashed) because AI and auto units obey it. Lifted in the spawn
  phase, at the end, in a continued game, for spectators and with the owner console's revealIntel.
- What players see: dark terrain where never seen; explored land greyed, showing what was last seen (owners,
  buildings); live land in view. Standings say "Unknown" for nations not met and "?" for armies out of sight; nation
  cards and diplomacy open only for met nations; news about unmet nations (falls, atom bombs) does not name them.
  Strikes need enemy land seen there; strike previews, warship picks, air mission picks and unit status lines never
  tell who holds hidden land. The setup row and a first guide tip (shown even during the opening steps) explain it;
  the tip and the dark-land tooltip point to Watchtowers, which need no research.
- AI in fog: landings, strikes, drops, barrages, nukes, recon, air-wing raids and rocket auto-fire aim only at places
  their side has seen; hunting warships chase only ships in view.
- Review fixes (second pass): strike preview, Blockade/Bombard and air picks, Forces/unit lines and atom bomb news no
  longer leak hidden owners or names; nations in sight are exact (any land in a block in view, re-checked every 5
  ticks); ally vision costs one stamp per player (teams huge map: 4.6 -> 0.4 ms a tick, full pass 72 -> 4.5 ms);
  the map shader keeps fades inside seen/live blocks and draws no borders across fog seams; guide tip early; peace
  time on the out-of-sight attack line; Reset rules text says five.
- Checks: tsc (client, server), build, full vitest 952 of 955 (3 hash tests in difficulty, doctrines, trenches hit the
  5 s timeout under load; alone with a 60 s timeout 47/47). Tests: fog.test.ts, fog.client.test.ts (strike previews
  over dark land, Blockade and air picks, unit lines, atom bomb news, land poking into view, a nation moving into
  view, bloc vision and its hash), guide.client.test.ts (early tip). AI batch on GitHub runners, medium, 48 seeds,
  25 min, fog off: every game result identical on main and fog (only tick timings differ). Multiplayer e2e on GitHub
  runners: mp-arsenal and mp-pillars on their default maps and a random map, all 4 passed. Playwright on the built
  app: single player desktop (no console errors; fog edges soft, no straight seams or fake borders) and online with
  2 players (118 hash turns equal, no desync, no console errors). Screenshots /tmp/borderfall-shots/fog-fx-*.png.
- Not checked: real GPUs and phones; AI strength with fog on vs off in headless runs; the Canvas2D fallback's fog
  edges (still a smoothed block grid). Open: last-seen memory is lost on reload or rejoin; the AI knows the current
  buildings in explored areas while a human sees the last-seen ones; a click on remembered land that changed while
  out of sight can still fail with the sim's reason (like an attack); online fog is honour based (every client holds
  the full state).

## Owner powers online and chat (2026-11-05, branch owner-chat, not merged yet)
Protocol 18 after the merge with fog of war (the server and every client must be updated together). Nothing here changes a game: chat, banners,
messages and effects are server messages, never lockstep actions, so they can't desync and aren't hashed. The
console's own actions still go through the sim as before.
For players:
- Chat in online lobbies and games: a Chat button (unread count; the newest message shows over it for a moment), All
  and Team tabs (Team in running teams games, with an "Attack here" map mark for teammates), spectators in their own
  channel that players don't see, quick-chat buttons, Send or Enter. Click a name to hide that player for this visit;
  "Chat off" in the Menu drawer or the lobby hides everything. Last 50 messages arrive on join and reconnect.
- Safety: text cleaned on the server (control and invisible characters out, piles of accent marks cut, 160
  characters), rude words and slurs masked with ***, shown as plain text only (no HTML, no links). 5 messages per
  10 s per player and 20 per address in each lobby or game, kept for its whole life (leaving and joining again resets
  nothing). Names are cleaned the same way, so nobody can copy a name with an invisible character.
- After a send by mouse or touch the caret stays in the message box; typing there never fires game keys, and a pan
  key held when the chat opened stops panning when let go.
- What players may see from the owner: banners titled "Announcement" (or the owner's title), a "Message", rings with
  a label on a tile, countdowns, confetti, fireworks, a short shake, "You can't send messages in this game for N more
  minutes" and "You were removed from this game". Nothing says admin, console or owner.
For the owner (how to use it): on the start page or in a game, press "|", type the code and press Enter. The console
then has three more tabs online:
- Games: every lobby and game on the server. Watch joins a running game as an anonymous spectator (console ops then
  work on that game; pick the nation for each). Make target aims Announce and Effects at that game. People lists who
  is in it, with Message (a short note to one player), Mute (minutes; 0 lifts it) and Remove (out of the game for
  good; a player's nation stays, nobody controls it).
- Announce: a banner for this game, the target game or every screen on the server (title, text up to 200
  characters, Info / Warning / Celebration, time on screen; Preview shows it to you alone).
- Effects: click a tile for a ring with a label, or a countdown, confetti, fireworks or a screen shake.
- Mute and Remove also hold for the address the player joined from: a new browser identity from it (a private window)
  starts muted or is refused. People already in that game from the same address are not touched, and you never are.
  On a shared address (a school, one home network) someone joining later from it is caught too.
Checks: tsc (client, server), build, full vitest 959 of 961 (the doctrines and trenches hash tests hit the 5 s
timeout under load and pass alone, 39/39). Tests: chat.server, chat.client, ownerPowers, ownerPowers.client,
admin.client, server (protocol 18 after the merge with fog). Playwright on the built app: the merge run (17/17: chat both ways in lobby and
game, team chat and map mark, spectator channel, owner Games / Watch / switch, announcements for a game and every
screen, ring and confetti, mute and unmute, remove, no owner words on player screens, no chat text as HTML) and the
review-fix run (11/11: duplicate name with an invisible character gets " 2", focus after Send and quick chat, no
minimap / resources key after a send, a held pan key stops). Multiplayer e2e on GitHub runners: mp-pillars and mp-arsenal
passed on their default maps and a random map (4 of 4).
Review fixes: chat rate limit kept per room (leave and rejoin gave a fresh budget), mute and remove by address too,
names cleaned like chat, focus after send, key release reaches the page, "chink", "dyke" and "retard" no longer
masked (a gap, an embankment, to slow down).
Not checked: real phones (desktop browser at phone size only); a watching owner's seat shows as "Player" in People
(no name set) and spectators would see that name if the owner chats while watching; a teammate's name can show in
another lobby colour in chat; look-alike letters from other alphabets in names (a Cyrillic "a") still pass.

## Screen pranks and announcement sizing (2026-11-06, branch pranks)
Protocol stays 18: the pranks are new values of the existing `spectacle` kind, and every client since the owner
powers drops a kind it doesn't know (broadcast.ts checks it against its own list first), so an older client simply
shows nothing. Nothing here changes a game: all of it is drawing on the player's own screen, never a lockstep action,
never hashed, can't desync.
Owner's time and size rules (for everything the owner sends):
- Banner text about twice the HUD text: 30 px on desktop, 21 px on phones (upright or sideways), title 22 / 16 px; the slip at most 60% of
  the screen wide (90% on phones) and 40% tall, under the top bar. Only the slip takes clicks; the map around it stays live.
- Everything goes by itself: banners 6 s by default and 15 s at most (a new one replaces the old, no pile), a message
  for one player 5 s, countdowns 3 to 15 s, rings 6 s, pranks 2 to 10 s. The server refuses longer times and the
  client clamps them again. The console's banner times are 3 to 15 s.
Pranks (owner console, Effects tab, "Pranks"; for this game, the target game, every screen, or one player under Who;
Length: each prank's own or 2 to 10 s):
- Upside down / Mirrored: the map turns over in half a second, stays, turns back. Clicks keep landing on the tile the
  player sees (the pointer is mapped back through the turn); only during the two half-second turns is map input
  ignored. HUD, minimap and chat are not turned.
- Earthquake: a gentle wobble of the map (a few px, under a degree), eased in and out; clicks mapped the same way.
- Disco: nation colours run through the rainbow (once round in 3 s).
- Rubber ducks: ships, planes and divisions drawn as yellow ducks outlined in the owner's colour; missiles stay missiles.
- Pretend bomb: "Incoming!" counts down in red over a ring on the player's capital, then confetti and "Gotcha!" with
  "Just confetti". Nothing else happens.
- Fog puff: a cloud comes over the screen and clears; clicks go through it.
- Camera chase: the camera glides to one of the player's units, follows it, glides back to where it was. A pan or zoom
  by the player ends it at once and leaves the camera where they put it.
- Reduced motion (player's system setting): no flip, earthquake or chase (nothing shows), disco holds one still colour
  change, the cloud only fades, ducks and the pretend bomb as usual with a tenth of the confetti.
- Not added on purpose: anything that looks like another player's message, account or security warnings, fake win or
  lose screens, anything that changes the game.
Checks: tsc (client, server), build, full vitest 1024 of 1025 (the trenches hash test hit the 5 s timeout under load
and passes alone with --testTimeout 60000, 18/18). New tests: ownerPranks (server: refused from a player, a spectator
and a lobby-list session; time caps; allowlist; one player only; notice 5 s) and ownerPranks.client (each prank ends by
itself on fake timers, clamps, a new game ends every prank, the bomb and the chase step by step, reduced motion,
clicks through a flip, text only as text). Playwright on the built app (owner watching, 2 players, a reduced-motion
spectator, a phone): flip for one player only (the other not turned), hover through the flip on the right tile, flip,
earthquake, bomb, fog and chase gone by themselves, chase back to the same camera, banner 30 px / 60% on desktop and
21 px / 90% on a phone with the page under it still clickable, gone after 6 s, no console words on a player's
screen, no desync. Screenshots /tmp/borderfall-shots/prank-*.png.
Not checked: real phones (a desktop browser at phone size only); frame time on a real GPU (only software GL here);
the ducks are small at normal zoom (they take the glyph's size).
Review fixes: a phone held sideways (844 x 390) got the desktop banner (30 px, text cut off): the phone sizes now also
apply under 500 px tall. A drag held while a flip turns is let go (it jumped the camera thousands of px mid-turn), also
when a slow machine misses the whole turn between two frames. The unit card, the alert ping and the guide's ring and
arrow follow a flip or a wobble with the map.

## Owner effects in single-player games (2026-11-11, branch sp-live)
Protocol 19 (spHello, spWelcome, spStatus; adminRooms carries `sp` and `spTotal`; scope 'sp' with an optional spId on
adminAnnounce / adminSpectacle; adminNotice with spId). Owner's scope: single-player games only receive what is drawn
on the screen; nothing changes their game, no view of their map, nothing else read from their browser.
- Link (src/client/spLink.ts): while online, a single-player game (never the tutorial) opens one socket to the same
  server multiplayer uses (`?server=`, then VITE_SERVER_URL, then the page's own origin), sends spHello and then every
  30 s spStatus {nation, map, minutes, landPct} read from plain fields (no sim reads per frame). It passes on only
  announcement, notice and spectacle, through the existing broadcast view. No server, no sockets, another protocol or
  an origin the server refuses: no link, nothing shown, the game plays as before. Retries 5 s doubling to 5 min, wait
  for the browser to be online, none after the tab has been hidden 10 min (until it is shown again).
- Server: a link counts against the per-address connection limit, at most 4 per address and MAX_SP_SESSIONS in all
  (default 1000, 0 = off), no hello timeout, frames up to 512 bytes, one status kept per 5 s. Anything but spStatus
  and ping is refused (chat, intents, lobbies, hello, owner messages), 20 refusals close it. Forgotten on disconnect.
- Owner console: Games tab, "Single player" section (nation, map, minutes, land %, Make target, Message). Where:
  "Single player: <nation>" or "All single-player games"; "Every screen" now includes them. Announce, Message,
  countdown, confetti, fireworks, shake and every prank work there; tile effects and Who are off for them.
- How to play (Multiplayer): "While online, single-player games connect to the game server so they can receive
  announcements."
Checks: tsc (client, server), build, vitest (spLink.server 15, spLink.client 15; full run 1066 of 1067, the trenches
timeout passes alone with --testTimeout 60000). Playwright on the built app: an SP game listed and reached by an
announcement, a message, a flip and the pretend bomb; a tutorial not listed; every screen reaches it; with the server
stopped single player plays on with no page errors (Chromium still logs its own failed-socket line per retry).
Not checked: the live Render site, a GitHub Pages build and the claude.ai artifact (it relies on the silent-failure
path). A card shows the last status, so a game that just started shows 0 min and 0% until its next status. Open
single-player pages count as visitors on the free Render server and may keep it awake longer.

## Queued next (owner, 2026-11-03)
Later: anonymous real-match stats on the server for balance, rematch + quick chat, replays, in-game phone/touch HUD, real-GPU performance check, flaky scripted-player e2e fix.

## Parked ideas (owner said later / maybe)
Building limits (city slots, upkeep), rivers and bridges, wonders, game modes (King of the Hill, capital capture, scenarios), quick chat/emotes/rematch, phone layout, making Easy winnable, calmer tribes.
