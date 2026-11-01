# Frontline Atlas roadmap

Working rules (owner's wishes, keep following them):
- Work on branch `dev`; only finished, tested work goes to `main` (Render and GitHub Pages deploy `main` automatically).
- Before merging: `npx tsc -p .`, `npx tsc -p server`, `npx vitest run`, `npm run build` all green (a few long tests can time out only while the machine is busy; re-run them alone).
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

## Tutorial mode (done 2026-10-31, on `dev`, not merged yet)
Title screen, **Tutorial**: 8 chapters (Basics, War, Economy and research, Navy, Armor, Air, Arsenal, Diplomacy and strikes), each a short single-player practice game on a hand-made map (src/sim/tutorialScenario.ts). Steps in src/client/tutorial/ (chapters.ts, engine.ts, overlay.ts, controller.ts, menuPage.ts): one instruction, a spotlight on the button, Show me, a checklist, Skip chapter / Exit tutorial, a Chapter done card. Progress in localStorage `frontline.tutorial.v2`. Safe: AIs frozen until a step wakes them, the player can't be eliminated, the game never ends, doctrines open at 0:00 where needed. `state.tutorial` is only set by setupTutorial (single player); no new actions, no protocol change. The first-game advisor steps stay for normal games and are off after the Basics chapter.
Open: only checked at 1280x720 (smaller screens and phone layout not checked); Navy and Air steps played only in the expected order; no e2e test that plays all chapters (only unit tests in tests/tutorial*.test.ts); the step text is not translated (no i18n in the game yet).

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

## Parked ideas (owner said later / maybe)
Building limits (city slots, upkeep), rivers and bridges, wonders, game modes (King of the Hill, capital capture, scenarios), quick chat/emotes/rematch, phone layout, making Easy winnable, calmer tribes.
