# Changelog

The big rounds of work, newest first. Each one was merged to `main` and deployed to the live game.

## 2026-11-18 · Supply lines (rules and AI)

- Supply now runs over a network. Rails link your capital, cities, factories, ports and forts over your own land (each
  to its 3 nearest within 120 tiles); ports link other landmasses by convoy. A fort or landing that no route reaches
  from your capital stops supplying your troops. Cities still supply on their own and the capital always does.
- Bombs, barrages and support strikes on a hub damage it: no route passes it for 45 s (30 s with Logistics, 10 s less
  under a SAM or flak). Another route around it keeps everything supplied. A repaired hub is safe for 30 s. Rockets
  still destroy what they hit.
- Convoys leave every 30 s; an enemy warship or submarine near the lane sinks one and cuts the lane until the next
  convoy. A blockade of either port closes the lane.
- Strategic wings hit the hub that cuts the most enemy supply near a front while their side pushes there. AI nations
  do the same with bombs and rockets, build a second route (a fort) and a SAM when one hub carries their supply, and
  the advisor warns you when your front hangs on one hub.
- Multiplayer version 24.

## 2026-11-17 · Diplomacy: peace deals and pacts (simulation and AI)

- Peace deals: two nations that fought in the last minute can make peace. Each side can pay something at signing:
  10% or 30% of its gold, or a strip of border land (up to 5% or 15% of its land, never the capital; buildings on it
  change hands). Attacks between them end at once and nothing hostile passes between them for 3 minutes. A peace
  deal can't be broken.
- Non-aggression pacts: nations that are not fighting can sign a 3 or 6 minute pact, renewable in its last minute.
  Breaking one gives the other side 15 s of warning, costs a lot of goodwill with every nation and marks you a pact
  breaker for 2 minutes.
- An offer waits 30 s for an answer; after a refusal you wait a minute before asking that nation again. No treaties
  in team games, in games without diplomacy, with only 2 nations left or with the overtime leader.
- AI nations offer peace when they are losing (paying gold first, then land), take peace when it pays them, and
  offer pacts to strong neighbours. The panel to use all this in game comes next.

## 2026-11-16 · Defense

A fourth Arsenal row, Defense, for the nation that holds and hits back. It needs Fortification, and every item needs a
finished Fort of yours. Pick one of two lanes, each with an upgrade after it:
- Flak Guns: your finished Forts (14 tiles) and Cities (10 tiles) fire flak at enemy bombers, ground-attack planes,
  cargo planes and the stealth bomber flying through. Their bombs do up to 65% less, and badly hit planes turn home
  with their bombs. Rockets, missiles and recon planes are too fast or too high. Forts and Cities get AA gun pits
  (small AA guns on the far-zoom markers), the planes fly through black flak puffs and trail smoke, and when you aim a
  bomb you see the enemy's flak rings ("Enemy flak: bombs -35%"). A Fort or City card says what its flak does.
  - Tracking Radar (after Flak Guns, needs Radar): every SAM site of yours gets a radar dish with a slow green sweep.
    An enemy stealth bomber that spends 3 s inside half a SAM site's reach (30 tiles at level 1; the time adds up over
    the flight, out and back) is spotted: a green lock box marks it and your SAMs and fighters can shoot at it. A
    stealth bomber now takes 2 hits, and one shot down takes 3 minutes to replace (instead of the 45 s recharge).
    Strikes still land most of the time: the radar mostly catches the bomber on its way home. When you aim a stealth
    strike you see the enemy radar circles you know of, and the card says how long the trip spends inside them.
- Tank Traps: your land around your Forts, out to 20 tiles past their reach (48 tiles from a level-1 Fort), is laid
  with mines and steel hedgehogs. Enemy tank spearheads there slow to 58% (40% on dug-in land, trench level 1 or more)
  and lose troops (at most a quarter of a division). Siege Tanks drive through, artillery halves it, barrages flatten
  the dug-in part. A knocked-out Fort lays none. The spearhead preview warns "Tank traps ahead".
  - Coastal Batteries (after Tank Traps): your finished Ports, and Forts within 4 tiles of the coast, get big guns and
    fire every 2 s at one warship of a nation at war with you, up to 30 tiles out (33 from level 2): ships that fired a
    cruise missile first, then ships shelling your coast, then other warships. A warship loses 0.4 of its 3 hp per
    hit. Enemy transports sailing through that range, at war with you or coming to land on you, lose about 1% of
    their troops per tile (more under 2 or 3 batteries), at most 40% per landing (it is never sunk): crossing one
    battery's full reach costs about 30%. Battleships shell from 35 tiles, out of reach,
    and warships shell batteries first (AI fleets, and your own on Auto or Bombard), knocking them silent until they
    mend. A steel-blue arc over the water shows a battery's reach when you select it or your warships are near one.
- Defense Mastery (after either upgrade; 25,000 gold, 8,000 iron, 2,000 oil; one of your 2 masteries):
  - Counteroffensive: every troop an enemy attack or tank spearhead loses on land your Forts cover fills a meter (the
    Counter chip at the top, and a line on each Fort card). Full, press Counter in the bottom bar (or Counteroffensive
    on a Fort card): 40% of your troops at home and your idle tank divisions near a Fort push at that attacker from
    your nearest Fort, 60% faster and losing 40% fewer troops for 30 s. A wide brass arrow sweeps out with dust. The
    button says why it is off ("Meter 60%"). AI nations strike back once their forts held (Easy ones never at you).
  - Hardened shelters: an atom bomb does half its troop losses on land your working Forts cover, and buildings there
    lose half their health instead of being wiped out (the land stays yours). The atom aiming preview shades sheltered
    land blue and says how much is covered.
- Picking one lane locks the other. Mastery is still 2 per game, now of 4 pillars.
- Anti-radar missiles (new Air special in the Arsenal): Anti-radar strike on an airfield card, then click an enemy SAM
  site whose radar is on (it fired in the last 10 s: green ring; otherwise "SAM radar is off: wait until it fires"). A
  hit knocks it out for 30 s; other SAM sites can shoot the missile down, the one it aims at cannot. Escort mode (off by default) answers every SAM that
  shoots at your planes. 500 gold and 50 oil each. AI nations (from Normal up) use them to open SAM walls before
  their raids and answer the SAMs that shoot at their planes.
- Stealth bomber, a new job: the atom bomb counter. Missile Silos in its blast are destroyed with any atom bombs
  loaded in them, and other silos within 25 tiles cannot launch for 30 s. Its strikes are clean (no fallout, no
  neutral land), so you can take the land right after. Multi-target: Add target while aiming, click up to 3 targets
  within 25 tiles of each other (6-tile blasts each), then Launch; one click is still one big strike. AI nations split
  it over clusters of SAM sites and silos, and fly it about every 2 minutes at war at SAM sites, silos and airfields
  under SAM cover (Easy ones never at you).
- Cruise missiles: anti-ship (click near an enemy warship or transport you can see: it homes on it, a warship loses
  1.5 hp, a transport sinks) and sea-skimming (on the way only SAM sites within 15 tiles of the target can shoot it).
  AI fleets fire them at enemy fleets and carriers.
- Fixes in the last balance round: Siege Tanks now really knock out the forts they pass (the rule never ran before); a
  knocked-out fort is switched off for 30 s, with its Flak Guns, Tank Traps and Coastal Batteries. AI nations choose
  Defense a little less often (a neighbour 1.8x stronger or foes with 10+ bombers).
- Fixes in the second balance round: Coastal Batteries now really wear down landings (before, transports lost 0%:
  they sailed past in one shot and a first landing was not yet a war). Tank Traps cover the land around your Forts,
  not only dug-in land inside them (before, 1% of enemy spearheads met them; now about 1 in 6 of those driving into a
  Traps nation). Only neighbours that really threaten (fighting you, or sharing a long border) make an AI choose
  Defense, and on the World map the bar is higher (before, 60% of World nations took it). AI nations with Air Mastery
  fly the stealth bomber more often, and AI nations with Anti-radar missiles really fire them.
- AI nations from Normal up take Defense when they are cautious, face a much stronger neighbour or get bombed a lot,
  and buy their lane's upgrade. AI landings steer clear of coasts covered by batteries unless their fleet is there.
- Online games need the new version (protocol 22).

## 2026-11-15 · Settings

- One Settings screen, on the title screen (Settings, with a gear) and in the game's Menu, in four tabs:
  - Sound: Master, Effects and Music in %, Sound on or Muted, a Test sound button that says why it is off when it is.
  - Display: Reduce motion (Auto follows your device, On or Off) and graphics quality (Auto, High, Low; Low is the
    light map for slow computers). In a game, the minimap, supply and resource overlays are here too. Everyone plays
    on the standard look: Real ground, detailed pixel units, lively motion and map effects on.
  - Gameplay: the advisor and the guide on or off, and Restart guide. Chat on or off in online games.
  - About: the version and build, and the credits (they moved here from the title screen's own Credits row).
- Every setting is kept in this browser and works at once, no reload. Each tab has its own Reset to defaults.
- Your sound volumes from before are kept.

## 2026-11-15 · Breakthrough

With Armor Mastery your tank divisions get a new order, Breakthrough:
- Select a division and click Breakthrough on its orders bar, then click enemy land near your border. The map shows the
  wedge it will drive before you click.
- The division pops a smoke screen and surges at twice the speed, five tiles wide and half again as deep, with
  fewer losses. The land it takes holds for 20 seconds: the enemy can't take it back meanwhile, so the wedge is hard
  to cut off. Its tanks fire faster than a plain spearhead's as they surge.
- It costs 100 oil and needs half strength; then the division recharges for 2 minutes. The button says when it is
  ready and why it can't go ("Recharging 40 s", "Needs Armor Mastery").
- Armor Mastery still makes encirclements collapse bigger pockets.
- AI nations from Normal up use it to close encirclements and break stalemates, never into your land at Easy or
  Normal. Your own divisions never use it by themselves.
- Online games need the new version (protocol 21).

## 2026-11-15 · Tank divisions that fight like an army

For your tank divisions on Support, and for AI nations from Normal up (Easy plays as before):
- Divisions stay at the front for the whole war instead of standing down between two attack waves.
- They look for the line that cuts the enemy off: across a thin strip of their land, the base of an enemy tank push
  into yours, or a bulge they can pinch off. More enemy land now falls in pockets.
- Ready divisions near the same strike go in together, side by side, instead of one at a time. On Hard and Brutal a
  lone division waits for one driving up.
- A straight push needs a strong division, and lines that would leave it worn out deep in enemy land are avoided.
- After a push, a division leaves the thin tip at once and drives back to solid ground. When the way back is cut, it
  breaks out to your line. Near the enemy it holds a little deeper, so it is not pushed back by every attack.
- A worn division goes back to a Factory nearby and refits until nearly full.
- A division whose front cannot be reached over your land supports a front it can reach.
- Your own orders come first: divisions you set to Hold or Refit do just that, as before, and only divisions on
  Support use the new habits. A division you drive to the tip of a push by hand stays there.

## 2026-11-15 · Tanks shoot

- Tank divisions in a fight now visibly fight: the turret turns toward the enemy, then the gun fires with a muzzle
  flash, a jolt of recoil and a puff of gun smoke, and a tracer shell flies to the enemy side of the front and lands
  in a small burst of dirt, a spark of steel struck, or a splash on water.
- Attacking divisions (spearheads) fire often; divisions holding a front next to a nation at war fire less often.
- Light tanks fire small and quick, heavy tanks big and slow, the siege tank's howitzer lobs its shell in a high
  arc, and Armor Mastery's modern long gun gives a sharp, bright flash.
- You hear each shot with its flash. You never see or hear enemy fire you cannot see under fog of war.
- Far out the shots are a faint blink or nothing. Reduced motion fires fewer flashes with no recoil. Big battles stay
  smooth: only a few new shots start each frame.
- The art lab shows the tank fire next to the ship cannon fire.

## 2026-11-15 · Stealth strike

- Air Mastery keeps its bigger air wings and adds a stealth bomber: a dark grey flying wing that SAM sites cannot see.
  It is the answer to a wall of SAM sites. Click an airfield, then Stealth strike, then an enemy target up to 188
  tiles away (more from a bigger airfield).
- It drops a heavy raid where you send it: every enemy building within about 6 tiles is wrecked, troops there are
  killed and the nation's income is cut for a while. Enemy fighters guarding that sky still cut its bombs by 40%.
- One stealth bomber at a time: 2,000 gold and 150 oil a strike, then it recharges for 90 s. The button says plainly
  why it is off: "Recharging 45 s", "Stealth bomber in the air", "Needs Air Mastery", not enough gold.
- While aiming you see its reach, the route, the blast, the SAM sites in grey (they cannot see it) and what it should
  wreck.
- The nation it flies at sees it only 2 s before the bombs fall: "Stealth bomber of Azuria over your land: bombs in
  2 s", with the air-raid siren.
- AI nations with Air Mastery send it at silos, airfields, factories and SAM sites behind strong SAM cover, first of
  all near their own landings, and keep a gold reserve. Easy AIs never send it at you.
- Online games need the new version (protocol 21).

## 2026-11-15 · Fighters that matter

- Fighters shoot down enemy recon planes. A recon plane that flies into enemy fighter cover on its way out (an
  airfield's fighters, a carrier, a Superiority patrol) is shot down by the same rule as bombers, and reveals
  nothing. The alert says so: "Azuria's fighters shot down your recon plane before it got there: nothing revealed".
  SAM sites let recon planes pass: fighters are the answer to recon.
- Air superiority: where you have at least 2 fighters guarding the sky, and more than the enemy has there, enemy
  bombs do 40% less. Fewer troops killed, fewer buildings hit, a smaller cut to your defence and your income.
  Bombers still fly and still hit; send fighters of your own over your front to take the sky back.
- You can see it: the airfield card says "Air superiority: enemy bombing within 80 tiles does 40% less, while their
  fighters there are fewer", a selected airfield shows its fighter cover ring, and the strike preview, the bombing
  alerts and the airfield's last result say when enemy fighters cut your bombs.
- AI nations from Normal up buy more fighters against nations that lean on bombers and recon, patrol where enemy
  bombers aim, build an airfield where they are bombed with no fighters near, contest the sky over their own attacks,
  and never send recon through fighter cover they know of. Your Auto recon flies around enemy fighters too ("Auto
  recon: waiting, enemy fighters guard Azuria"); orders you give are never changed.
- Online games need the new version (protocol 21).

## 2026-11-15 · Cruise missiles from sea

- Naval Mastery now arms your warships, destroyers and battleships with cruise missiles. Click a ship, then Cruise
  missile on its card, then enemy land up to 35 tiles from the ship. With several ships selected the button sits in
  the orders bar and the nearest loaded ship fires.
- A cruise missile is a small rocket: it wrecks enemy buildings within 4 tiles (a rocket hits 7) and kills troops.
  700 gold and 60 oil each, and each ship needs 30 s to reload. The button says plainly why it is off: reloading,
  needs Naval Mastery, not enough gold.
- While aiming you see each ship's reach, the blast and the SAM sites in the way. SAM sites shoot cruise missiles down
  like rockets, so send more than they can load or silence them first.
- You see it launch: it rises out of the ship's deck on a booster with a flash and a puff of smoke, pitches over,
  unfolds its wings, drops the booster and skims low to the target before it dives.
- The nation it flies at is warned: "Cruise missile incoming".
- AI nations with Naval Mastery use them at war: on SAM sites, airfields and silos near the coast before they land,
  and on buildings in reach. They keep a gold reserve and never fire into heavy SAM cover. Your own ships fire only
  when you tell them to.

## 2026-11-15 · Real sound and music

- Real recordings in place of the made-up sounds: artillery, explosions, the atom bomb, missile launches, tank
  shots, plane crashes, sonar pings, ship horns, the air-raid siren and more. Each sound has several takes and a
  slightly different pitch every time, so repeats never sound the same.
- You hear the fighting where you look: battle sounds play for what is on screen and grow louder as you zoom in.
  Zoomed far out, only the big blasts come through. News about your own nation always plays.
- A soft bed of distant gunfire plays when you zoom in on an active front.
- Music made by people, on by default: calm in peace, tense at war, full battle music when the fighting is heavy.
  Tracks rotate and crossfade, and the victory and defeat music plays at the end of the game.
- A Credits page on the title screen and in the Menu lists the composers and recordists.

## 2026-11-14 · Every ship does its own job

For your ships on Auto, and for AI nations from Normal up (Easy plays as before):
- Submarines hunt: they go for landings and trade ships first, meet them ahead on their route, shoot from out of
  sight, pick off damaged or lone warships and leave fleets and destroyers alone. They blockade ports from a hidden
  spot outside the minefields, and dive away when a destroyer comes near. Your Auto submarines no longer park off a
  coast they cannot shell.
- Destroyers hunt submarines: they shoot them first, escort your landings, sweep a blockaded port of yours, and
  guard your trade ships against a nation with submarines.
- The nearest free ship covers each landing, and AI landings go in where their warships are shelling.
- A ship hit by a submarine it cannot see runs to a friendly ship nearby; a destroyer goes after the submarine.
- Fighter patrols fly where enemy bombers actually aim.
- Cards say what each ship is doing: hunting a trade ship, blockading from hiding, diving away, escorting, covering a
  landing.

## 2026-11-14 · A sharper AI at sea, on land and in the air

From Normal up (Easy only gets the repairs):
- Damaged warships go home to a Port to repair instead of fighting on until they sink, and a damaged ship no longer
  takes on a healthy one.
- Landings wait until the escort is not outnumbered by enemy warships near the start or the beach.
- Tank divisions about to be overrun strike back when they are strong enough, or pull back to refit at a Factory, and
  divisions far from the fighting support the nearest stretch of the front.
- Bomber wings keep air support over the front between attack waves, strikes go out together, and bombers no longer
  fly into air defence.
- New players keep their fair chance: Easy and Normal play as before for beginners.

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
- Natural terrain: forest edges thin out into lone trees, grass runs from dry to lush, woods have clearings, rock
  gathers at the foot of mountains, flat coasts have beaches and far mountains read as rugged rock with some snow.
- Without a graphics card the game draws a lighter map and no longer freezes, and every game starts faster: the
  ground is built in small steps between frames.

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
