# Changelog

The big rounds of work, newest first. Each one was merged to `main` and deployed to the live game.

## 2026-11-01 · Learning the game, reading the war

**Tutorial and guide**
- Quick tutorial: one short practice game, step by step, from the title screen.
- In-game guide: a small bar above the command bar walks new players through the start and explains each new thing once. Turn it off or restart it from the menu.

**Reading the war**
- Front lines: borders at war get a bright line with arrows into the land being taken, brass on your own fronts. Hover one for its speed.
- End-of-game summary: land over time, the key moments and every nation's numbers.
- Map effects and sounds when a city changes hands, a ship sinks or a bomb lands. They can be turned off.

**Balance**
- Doctrines, air wings, shore support and the tank fallback retuned.
- A grace period for new players, and a gentler Easy AI.
- The new-player benchmark also runs on GitHub's runners.

## 2026-10-31 · Balance check

Every pillar measured against a normal AI on the same seeds, then on fresh ones. Kept:
- Counters, tank divisions that fall back instead of being overrun, and earlier atom bombs.
- AI nations hire mercenaries and place SAM sites behind the front.
- Hard difficulty no longer a cliff. The Merchant doctrine got stronger.
- Balance batches end decided games early, merge reports and run on GitHub's runners.

What still fails is listed in [ROADMAP.md](ROADMAP.md).

## 2026-10-31 · Arsenal

- Vehicle paths in research: Destroyers and Battleships or Submarines and Carriers; Light or Heavy tanks; Ground-attack planes or Heavy bombers. One path per pillar per game.
- Mastery: the last card of a row, in at most two pillars per game.
- Special upgrades that change behaviour: Naval Mines, Amphibious Tanks, Drop Tanks, Night Bombing, Early Warning.
- Shared upgrades: Mechanized Infantry and Recon Planes.
- The Research panel gets a second tab, Arsenal, with one row each for Navy, Armor, Air and Shared.
- Shift-drag a box to select buildings, then upgrade them all at once (x1, x3 or x5).
- The AI uses paths and upgrades too.

## 2026-10-31 · Many ways to win

Navy, armor, air, land and economy can each carry a game.
- Warship stances: auto, hunt, escort, bombard and blockade. Bombardment makes landings cheaper; blockades cut trade and supply.
- Tank divisions survive their spearheads, refit at a Factory and gain veterancy. Encircled pockets collapse.
- Air wings fly standing missions: support a front, bomb an enemy's income, or hold the sky.
- AI personalities commit to a pillar.

## 2026-10-31 · Deeper play

- Continue playing after a victory.
- Smarter warships, a branching tech tree with OR choices, and more ways to spend gold.
- Tank divisions.
- A build menu with a quick bar, and building up to five levels in one click.

## 2026-10-30 · Frontline Atlas

- The game gets its name.
- Doctrines: from 5:00 pick a play style, with levels and a cost to switch.
- Heartland and last stand: deep land and much smaller nations defend better. Force limits: past a set ratio, extra troops add little.
- Coalitions against a runaway leader, and allies that answer when asked for help.
- Only the host of a private game can pause.

## 2026-10-30 · Online and polish

- Game setup with presets and modifiers, real-world maps, and online multiplayer with public and private lobbies.
- The game page is published to GitHub Pages.
- A calmer HUD, a research tree with connections, and a Forces drawer for special units.
- Difficulty retuned (Easy, Normal, Hard, Brutal) with a new-player benchmark. A strikes bar.
- Softer nation colours, minimal unit glyphs, missile contrails and cleaner typography.
- Artillery became a real siege arm.
- Grand scale and a war-room HUD.

## 2026-10-29 · First playable game

- Single player: the deterministic simulation, the WebGL2 renderer, the HUD and AI nations, with tests.
- The design document, shared types and the balance config.
