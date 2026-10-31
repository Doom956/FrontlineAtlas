# Frontline Atlas roadmap

Working rules (owner's wishes, keep following them):
- Work on branch `dev`; only finished, tested work goes to `main` (Render and GitHub Pages deploy `main` automatically).
- Before merging: `npx tsc -p .`, `npx tsc -p server`, `npx vitest run`, `npm run build` all green (a few long tests can time out only while the machine is busy; re-run them alone).
- Commits are authored by the owner (Doom956); never mention any AI tool or the reference game's name in the repo; never write the admin code anywhere.
- Keep the HUD minimal and clean; literal, simple icons; plain short wording.
- Live: https://frontline-atlas.onrender.com (server + game, env `ADMIN_CODE` set in Render) and https://doom956.github.io/FrontlineAtlas/ (Pages; repo variable `SERVER_URL`).

## Overnight plan (owner, 2026-10-31)
Round 1 finishes -> all checks -> merge to `main`. Then round 2 -> all checks + multiplayer sync test -> merge to `main` if green. Then the full balance check -> checks -> merge to `main` if green. Morning summary per pillar.
Status: round 1 merged to main 2026-10-31 05:40 UTC (fbe8710; specialist benchmark not built yet: it moves to the balance check). Round 2 merged to main 2026-10-31 08:45 UTC (3e0dcf3; checks green, both multiplayer sync e2e passed). Balance check running as workflow wf_6e66d7bd-743 (script ~/.claude/projects/.../workflows/scripts/frontline-atlas-balance-check-*.js).

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

## After round 2: full balance check
Benchmarks: run batches on GitHub's runners with `scripts/remote-batch.sh <label> -- <batch.ts options>` (about 10x faster than local; details at the top of /tmp/fa-bal/commands.md and in the script header). `--decided 0.6` ends decided games early (win rates only).
Measure everything on the finished game (doctrines, tech forks, pillars, variants, economy vs military, game length 20-35 min medium / 25-40 World, early leader at 15 min < ~55%, difficulty: Easy/Normal survivable, Hard not a cliff before minute 10), tune only clear outliers, verify on fresh seeds. Findings from the last audit: economy-first ("merchant") nations won ~2.6x their share (markets/banking already toned down: re-check); tank divisions were overrun 70% of the time; SAMs stopped only ~1.4% of bombers; atom bombs came after games were decided; mercenaries don't decide games; Hard kills a new player before minute 10.

## Parked ideas (owner said later / maybe)
Building limits (city slots, upkeep), rivers and bridges, wonders, game modes (King of the Hill, capital capture, scenarios), quick chat/emotes/rematch, phone layout, making Easy winnable, calmer tribes.
