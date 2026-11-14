# Changelog

The big rounds of work, newest first. Each one was merged to `main` and deployed to the live game.

## 2026-11-14 · Units you can tell apart, fighters in the sky, and real ground

**Units**
- Every ship type has its own shape: a big battleship with four gun turrets, a long narrow destroyer with torpedo
  tubes, a submarine with its tower, a cruiser, and a carrier with a full flight deck.
- Planes and tanks too: a heavy armoured ground attack plane, a four-engine heavy bomber, light, medium and heavy
  tanks each with their own build.
- Upgrades change the model: jet planes get swept wings or the A-10 style attack jet, the eight-jet strategic
  bomber, modern battle tanks, missile launchers and radar on ships, mine rails, fuel drums, flotation skirts.
- Units are drawn 1.5 times bigger at normal zoom, so guns, engines and turrets show.
- Fighters are in the sky: they circle their airfields and carriers, fly the air superiority patrol, and streak in
  to shoot bombers down.
- Zoomed out, units are crisp shapes in the owner's colour, and a fleet is a small formation of ships instead of a
  marker with a number.
- The recon plane crash reads clearly: a burning dive, a splash and wreckage.

**Map**
- Real ground: fields, forests, hills, mountains, desert and snow drawn in the same pixel style as the units, with
  each nation shown by a band of its colour inside its border and a tint that keeps its colour true on any ground.
- The minimap matches. The old look stays in Menu, Map, as Classic.

## 2026-11-13 · Battles you can see: detailed pixel art and effects

**Units**
- Every ship, tank, plane and missile redrawn in a detailed pixel style: shaded, lit from the top left, drawn for
  every heading, each arsenal pick with its own look and upgrades shown on the unit.
- Planes bank into their turns and their propellers spin; ships leave a V-shaped wake and planes leave contrails.
- Troop icons: tiny pixel tanks and field guns in your nation's colour on the front and transport pills. Army counts
  read like "50k troops".

**Effects**
- Every blast opens with a bright flash. Bombs and shells leave craters that burn, smoke and fade.
- The atom bomb rises into a mushroom cloud and leaves a blast zone: a pale ash pan, a charred band and scorch marks.
- Warships fire from their turrets with muzzle flashes and shells you can follow.
- Ships under fire flash where they are hit, then trail smoke, burn on deck and list when badly hurt.

**When units are destroyed**
- Planes shot down fall burning and crash, or splash into the sea and leave an oil slick and wreckage.
- Missiles shot down break apart in the air, their pieces trailing smoke.
- Tanks blow up and leave a burnt hull. Ships sink, leaving foam and floating wreckage.

## 2026-11-13 · A new look for the whole game

- Cool steel panels with an amber accent everywhere, and a new main menu with a swirled metal logo and Play button.
- The lobby and the end-of-game summary in the same look.
- The build menu, research, arsenal, doctrine, diplomacy and the Spend panel as cards with pixel pictures, prices
  with build time, and a plain reason when something cannot be built yet.
- Pixel icons in the top bar and on every card; unit pictures on the unit card and in Forces.
- A calmer map: smooth deep-water shading, tribes as a light veil, resources shown with their amounts.
- Your fronts, troop pills, fleet badges, selections and routes drawn in cool steel and blue.
- Tips name the button to press, never a key. Phones get the same design, with the top bar in two rows.

## 2026-11-11 · Quality of life

- The clock in single player counts real time played: steady at any game speed, stopped while paused.
- Bigger click areas for your buildings, so they are easy to pick on a phone too.
- Announcements and messages now reach single-player games as well.
- The online server stays awake, so nobody waits for it to start up.
- Better search results and link previews: a full title and description, a share picture, and the site shows up
  as Frontline Atlas.

## 2026-11-05 · Fog of war

- New game rule (setup screen, also in private lobbies): you see only near your land, ships, tanks, planes and
  Watchtowers, and what your allies see. Dark land is unexplored; grey land shows what you saw last.
- AI nations play by the same fog: no landings, strikes or nukes on places they have never seen.
- Standings, nation cards, tooltips and news keep nations you have not met unknown, and armies out of sight show "?".
- Strikes go by what you know: bombs, rockets, atom bombs and barrages need enemy land you have seen there, and
  aiming over dark land tells nothing about who holds it.
- Off by default, never in the tutorial. Online games need the new version (protocol 17).

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
