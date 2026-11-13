# Unit looks: types told apart, upgrades that show, the recon plane shot down (detailed style)

Scope: client visuals only, in `src/client/art/detailed/` (models.ts, carrierDeck.ts, deaths.ts, wrecks.ts if needed).
Nothing in `src/sim`, `server/`, the protocol, refined or realistic. Art drawn in code. No em dashes anywhere.

Units below are model units: 1 unit = 1 screen px at the game's normal zoom (camera zoom 3 to 11, spriteScale 1),
and 1 art pixel on a 1x screen (2 on a 2x screen; 2 at zoom 11 to 22). Anything under 1 unit across vanishes at the
normal zoom, so every change in this spec is at least 1 unit wide and changes at least ~25 art pixels.

## 0. What the before pictures show

Pictures: `looks/before/` (sheets `ships_*`, `tanks_*`, `planes_*`, each `_game` = normal zoom heading east, `_game_diag`
= normal zoom heading up-right, `_close_diag` = zoom 14; `_1x` raw, `_4x` (or `_2x` for close) nearest neighbour.
Columns: plain, each upgrade bit alone, all bits; a dark cell = the unit cannot show that bit). Deaths:
`death_<plane>_<land|sea>_{1x,2x,4x}.png`, ten moments each (flying, 60, 300, 700, 1100, 1450 ms falling, then 60, 300,
900, 2000 ms after the crash), `_close` at zoom 14. Contact sheets of the deaths in `looks/crops/d_*.png`.

Measured (art pixels that change at res 1, heading 4 of 32, vs the plain model; harness/diffs.ts):

| unit | solid px | mastery | path3 | jet | special | night |
|---|---|---|---|---|---|---|
| warship | 184 | 16 | | | 17 | |
| destroyer | 103 | 15 | | | 15 | |
| battleship | 413 | 22 | | | 17 | |
| submarine | 64 | 8 | | | 7 | |
| carrier | 563 | 27 | | | 10 | |
| tank division | 148 | 44 (same colour, reads as nothing) | | | 13 | |
| light tank | 91 | 29 (same colour) | 3 | | 11 | |
| heavy tank | 233 | 87 (same colour) | 83 (dozer, reads) | | 5 | |
| bomber | 163 | 3 | | 181 | 3 | 14 |
| ground attack | 126 | 5 | | 102 | 0 | 19 |
| heavy bomber | 250 | 7 | 22 | | 10 | 224 |
| fighter | 64 | 3 | | 93 | 6 | |
| cargo plane | 229 | | | 176 | 11 | |
| recon plane | 148 | | | | 4 | |

Only jets, night paint on the aluminium heavy bomber, and the siege dozer read today. Why the rest do not:
- Drop tanks (`dropTanks`) sit at `Z - 0.6`, under the wing (`Z + 0.3`): the wing hides them from above.
- Chequered cowlings (`checks`) are 0.45 long: one pixel ring, mostly hidden by the propeller disc.
- Naval Mastery AA tubs are 2.1 across in deck grey on a deck grey ship; the radar is 1 x 2.2 on a mast.
- Mine rails: 0.75 radius black mines on a dark deck aft; only the yellow horn dot shows.
- Armour skirts are in the hull's own material over a track of the same value: the outline grows by 0.5, no contrast.
- Snorkel: a pipe seen from above is a 1 px dot.
- Deep Raids: 1 x 0.9 jerrycans in olive on tan, tucked inside the hull outline.
- Strategic Bombing: glass domes 0.9 to 1.1 across inside the fuselage outline.
- Night on the olive bomber and camouflaged ground attack: `night` and `odplane` / `camo` have about the same value.

Types: at the normal zoom the battleship reads as a fat warship (44 vs 33 long, both grey, three vs two turret groups
of the same grey), the destroyer as a short warship, the submarine as a 22 px dark dash on the dark sea (nearly
invisible), the ground attack plane as a small bomber (olive-ish, wing rockets are 0.5 wide specks), the heavy bomber
reads (aluminium, four engines). Tanks read by size and colour; their upgrades do not.

## 1. Recon plane shot down: diagnosis

1. In the real game a recon plane is never shot down. `src/sim/units.ts` puts only bombers, rockets, atom bombs and
   cargo planes in `threats` (SAM sites and airfields); `airwings.ts interceptBySuperiority` and the carrier fighters
   (`techtree.ts`) shoot only bombers and cargo planes; the recon plane is moved by `variants.ts updateArsenal` and
   leaves with hp 0 and no kill blast when it lands, so `fx/deaths.ts` (rightly) plays nothing. The only recon death
   anyone can see is the art lab cell "Recon plane down, sea" (`artlab/scenes.ts DEATH_CELLS`). Making recon planes
   shootable is a sim and balance change, outside this client-only job: flag it to the owner, do not do it here.
2. The animation itself (deaths.ts drawPlane with the recon model) is the weakest of the plane deaths:
   - It spins like a fighter: `SPIN.reconPlane = [1.25, 0.34]` (1.25 turns and a 0.34-length corkscrew in 1.5 s).
     A 24-span twin-engine plane whirls through every heading, its smoke trail curls into a tight hook ("?" shape,
     `d_reconPlane_*.png` frames 5 to 7) and it seems to tumble on the spot instead of going down.
   - The twin-boom shape breaks when rolled: at roll levels 2 and 3 (0.4 and 0.7 rad, from 300 ms) the two booms, their
     fins and the box tailplane between them (`box(-10.2, -3.4, -8.6, 3.4)` + two fins 1.6 tall) read as a ladder or a
     chair frame, not a plane (frames 3 and 5 at zoom 14 most clearly).
   - It shrinks and darkens into the sea: `f.s` falls to 0.55 by the crash and the wreck turns char step 1 at q 0.55.
     The pod is only 10.4 long and 2.3 wide, `prublue` (#4b6475 to #678598) is close in value to the sea (#1f3242 to
     #2a4254), so from about 1000 ms the plane is a 5 to 8 px dark smudge inside its own smoke (frames 5 and 6).
   - The fire starts at `props[0]`, the nose of one boom 3.4 to the side: the flame sits off the body and is small.
   - After the crash: the splash, slick and floating pieces are the generic ones sized by `R = L * 0.42 = 7.6`; the slick
     and pieces are near black on the dark sea and hardly show (last frame), so the end reads as "it vanished".
   - It is not too short and not on a wrong layer: it falls for 1500 ms and lasts about 4.8 s like the others.

### Recon death: target

- Fall like a twin-engine plane that lost an engine: `SPIN.reconPlane = [0.45, 0.16]` (between the bomber and the
  ground attack plane): one slow quarter turn into the dead engine, a steady dive, the trail a long gently curving streak.
- Never show the ladder: cap the recon plane's roll at level 2 (0.4 rad) while falling, and when it rolls draw the
  tailplane thinner (box 1.0 long instead of 1.6) so the booms read as two lines joined at the tail, not a frame. Or
  (better) lose a piece: at 250 to 400 ms the hit boom's tail breaks off (a small separate piece, 4 x 1.2, tumbling and
  falling behind with its own thin smoke wisp), so the plane falls with one boom short; that alone says "shot down".
- Keep it readable: shrink less for planes under 20 long (`f.s` floor 0.72 instead of 0.55 for `L < 20`), and do not
  char it before q 0.8. A bright burning engine: fire at the hit boom's engine nacelle (u 4.4, v -3.4), flame size as
  the bomber's (size floor 1.0), a short trail of sparks (2 to 3 flame-palette specks per frame) behind it.
- The splash: at least the cargo plane's size (R floor 7.5 at the impact, the white column and the foot ring in
  SPRAY[2] / SPRAY[3]), the slick with a lighter sheen ring (one foam-coloured ragged rim at alpha 0.35) so it shows on
  the dark sea, 3 to 5 floating pieces in `prublue` tone 3 (the plane's own colour, light) for 2 s, so the end reads as
  "it went in here".
- Same layers and times as the other plane deaths (ground layer: slick, pieces; air layer: plane, smoke, fire, splash).
  Also apply the shrink floor and the char delay to the fighter (L 13.6), which has the same smudge problem.

## 2. Ships

Colour identity (muted, all lit from the top left, owner colour only as it is today: a funnel band, a turret roof
stripe or a bridge or conning tower panel):
- carrier: dark weathered flight deck (as now)
- battleship: dark steel deck (`bbdeck`), turret roofs a step lighter (`sup` tone 2) so the big guns pop
- warship (cruiser): grey hull, teak deck (`teak`, planks pattern): the warm deck is its signature
- destroyer: light haze grey hull and deck (`sup` / `deck` tone +1): the lightest warship
- submarine: near black (`sub`), with a light foam rim (see below)
- transport, trade ship: as now

| ship | length now -> target | beam (2b) now -> target | main guns | silhouette |
|---|---|---|---|---|
| carrier | 54 -> 60 (CL 27 -> 30) | flight deck 12.9 -> 14.2 wide | none | flat slab, angled deck, island to starboard |
| battleship | 44 -> 52 (hull 2L = 50) | 10.8 -> 13 (B 6.5) | 4 triple turrets 9 x 7.6, barrels 9 x 1.2 | broad, turret-heavy, tall tower |
| warship | 33 -> 34 | 6 -> 7 | 3 twin turrets 5 x 3, barrels 3.8 x 0.6 | balanced cruiser, 2 funnels |
| trade ship | 32 (keep) | 6.8 | none | black hull, containers, cream house aft |
| destroyer | 24 -> 27 | 4.4 -> 3.6 | 3 single mounts, barrels 2.4 x 0.5 | needle, 7.5 : 1, raked funnels, torpedo tubes |
| transport | 26 (keep) | 8 | none | boxy, well deck of troops |
| submarine | 22 -> 24 | 3.9 -> 3.4 | 1 deck gun | cigar awash, one sail |

Order rules the tests hold: carrier > battleship x 1.15 (60 > 59.8: keep the battleship at 52 or less, or grow the
carrier further), battleship > warship x 1.25 (52 > 42.5), warship > destroyer (34 > 27), submarine <= destroyer,
battleship span > warship span x 1.5 and > destroyer span x 1.6, submarine span < warship span, carrier length / deck
width < 4.6 (today 54 / 12.9 = 4.19; at 60 the deck must widen too: 60 / 12.9 = 4.65 fails, so scale the deck's
v by 1.1 to 14.2 wide: 60 / 14.2 = 4.2).

### Carrier (60 long)
Grow CL from 27 to 30 so the bigger battleship stays clearly smaller. Everything placed from CL follows; carrierDeck.ts
has a few fixed numbers (the deck lines at u 13.2, the landing area) to scale by 30 / 27. Widen the deck outline,
island and sponsons by 1.1 across (deck 14.2 wide) so the length to width test (< 4.6) holds. Otherwise as now.

### Battleship (52 long, the heavy hitter)
- Hull `shipBase(25, 6.5, 11, 3, 'bbdeck')`: long and broad, a fine bow, a heavy transom-ish cruiser stern.
- Four triple turrets: A (u 17) and B superfiring (u 10.5, on a 1.6 barbette), X superfiring (u -10.5) and Y (u -17).
  Turret house 9 long x 7.6 wide x 2.2 tall (`tl 4.5, tw 3.8, th 2.2`), roofs `sup` tone so they are the lightest
  things on the deck, the owner stripe on A and B roofs as now. Barrels 9 long, 1.2 wide, with the gap rule
  (`gunGap` n 3: 2.3 apart) so three barrels read as three lines; A and Y barrels reach past the turret 9 units.
- A tall stepped tower amidships (base 8 x 9, three steps, height to 7.5 above deck), one big trunked funnel aft of it
  (ru 2.4, rv 2), secondaries: 4 twin mounts each side (`smallGun` r 1.1, barrel 2.6) on the deck edge.
- `guns` stays three entries with distinct u (A, B, Y) for the salvo (`SALVO.battleship = 3`, test needs 3 distinct x).
- Reads at the normal zoom as: a broad dark hull with four pale turret blocks, two each end, long gun lines.

### Warship, the plain cruiser before an arsenal pick (34 long)
- Hull `shipBase(17, 3.5, 6.5, 2.2, 'teak')`: the teak deck is what tells it apart from every other grey ship.
- Three medium twin turrets (A u 10, B superfiring u 6.4, X u -12.6): 5 x 3 x 1.1, roofs hull grey (not `sup`), barrels
  3.8 x 0.6. Bridge tower, two upright funnels with the owner band (its other signature), boats, a catapult aft.
- Reads as: a mid-size grey ship with a warm brown deck, two funnels, guns both ends.

### Destroyer (27 long, the fast one)
- Hull `shipBase(13.5, 1.8, 6.5, 1.5, 'deck', true)` in light haze grey (hull and deck one tone lighter than the
  warship): 7.5 times as long as wide, a long sharp flared bow, a low square stern.
- A raised forecastle step at u 6 (a 0.4 high break), two single gun mounts forward (u 10, and u 7.2 raised), one aft
  (u -10): round shields 1.8 across, barrels 2.4 x 0.5. The `guns` list stays two entries from the forward mount
  (test: both muzzles within 1 px of each other).
- Small bridge at u 4, two thin raked funnels close together (u 1 and u -1.4, ru 0.8, rake 1.1) with the owner band.
- Two quintuple torpedo tube banks on the centreline (u -3.6 and u -7): each a mount 1.6 across with five tubes
  4.2 long x 0.38, pale `sup` tone 3 with dark ends, turned 12 degrees off the centreline (one to port, one to
  starboard): long pale bars across the deck, the one detail no other ship has.
- Depth charge racks at the stern (two dark boxes), a small white bow wave curl at the stem (foam, a 0.8).
- Reads as: a thin light-grey needle with pale tube bars amidships and a sharp bow.

### Submarine (24 long)
- Cigar hull `ell(0, 0, 12, 1.7)` in `sub`, the deck casing a tone lighter, bow and stern awash as now.
- Make its outline read on the dark sea: a continuous foam rim round the hull (`foam` a 0.75, 0.5 wide) and a white bow
  wave (two foam seg 3 long fanning back from the stem) and a short stern swirl.
- The sail (conning tower): bigger and lighter: 6 long x 2.4 wide x 2.8 tall in `sub` tone +2, the owner panel on top
  as now, periscope and mast. A deck gun forward (r 0.9, barrel 2.4).
- Reads as: a dark cigar outlined in white water with one raised fin in the middle and nothing else.

### Transport and trade ship
Keep. They already read (well deck of troops; black hull, containers, cream house). Their MOD_MASK stays 0.

### Ship upgrades (warship, destroyer, battleship, carrier, submarine)
- M_MASTERY (Naval Mastery): "the ship got more guns and radar":
  - warship, destroyer, battleship, carrier: a radar array on the top of the mast, 3.2 across x 0.6, pale `sup` tone 3
    with a dark grid (it stands highest, so it shows above the ship in the 3/4 view); plus a beaded rim of AA tubs along
    both deck edges: tubs 1.4 across in pale `sup` with a dark centre, 3 per side on the destroyer, 4 on the warship,
    6 on the battleship, 8 on the carrier's catwalks; plus the warship and the battleship get a two-tone hull: the lower
    two thirds of the hull side in `hullDark` tone +1 (a darker band running the whole length, measure-style
    camouflage, one step darker, still muted).
  - submarine: a bigger sail with an AA platform aft of it (a 2.4 x 2.6 pale bandstand with a twin gun) and a radar
    mast; the sail grows from 6 to 8 long.
- M_SPECIAL (Naval Mines): "it lays mines": mine rails along the aft third of both sides, 4 mines per rail on the
  destroyer and the warship, 6 on the battleship and the carrier: mines 1.0 radius, black with a `hazard` yellow band
  round the middle (not a dot), the rails `gun` 0.45 wide, and a small stern mine chute (a dark notch, 1.2 x 1.6) at
  the transom. Two yellow-banded rows of beads aft.
  - submarine: two rows of 3 yellow-banded mines on the aft casing (mine-laying sub), rails visible on the casing.
- All together: both, no clashes (AA tubs and mine rails keep apart: tubs forward and amidships, mines aft).

## 3. Tanks

| tank | length (with gun) | hull | turret | gun | colour |
|---|---|---|---|---|---|
| light | 15 | 11.4 x 6.4 (tracks to 7.2) | small, set forward, 4.6 x 4 | 4.8 x 0.55, short | `tan` |
| medium (tank division) | 21 | 16 x 9.4 | rounded cast dome 8.2 x 6.6 | 7.6 x 0.95 | `olive` |
| heavy | 32 | 21 x 12.6 | slab, set aft, 11.4 x 7.8 | 15 x 1.3 with a 2 x 2 muzzle brake | `fieldgrey` |

The three types already read by size and colour; make the silhouettes differ too:
- light: wedge nose (hull narrows to 4 wide at the front), turret ahead of centre, tall whip aerial, open engine
  grille at the back. Fast and small.
- medium: as now (dome turret, glacis, owner panel on the engine deck).
- heavy: square slab hull with spare track sections hung on the front plate (two dark tread boxes 1.4 x 3 each side of
  the driver), a turret set behind centre, the long gun reaching 8 past the nose.

### Tank upgrades
- M_MASTERY (Armor Mastery), all three: "it got thicker armour":
  - skirt plates over the tracks in a contrasting tone: `gun` tone 2 (dark steel) instead of the hull colour,
    1.0 wide, in 3 to 4 separate plates with 0.3 gaps (they read as hung plates, the tread pattern no longer shows);
  - appliqué armour on the turret: the turret outline grows 0.6 each side and the front face gets a bolted plate
    (rivets pattern) in hull tone -1;
  - a roof machine gun on the cupola (seg 2.2 x 0.35 dark).
  The tank gets about 1.2 wider and its side colour changes: visible at the normal zoom.
- M_SPECIAL (Amphibious Tanks), all three: "it can swim": a flotation screen: a pale `canvas` rim 0.8 wide round the
  whole top of the hull (the folded wading screen), two exhaust snorkel stacks at the rear standing 4.5 tall with dark
  caps (in the 3/4 view they show as short upright posts), and two small propeller shrouds at the stern (dark circles
  1.2 across). The pale rim outlines the tank: the clearest change.
- M_PATH3 light tank (Deep Raids): "it goes far": two big fuel drums racked across the back of the hull (`rust` and
  `ochre`, 2.2 across, sticking out 2.4 behind the hull, so the tank is 2.4 longer), jerrycans along both fenders (6
  cans in `olive` tone +1, 1 x 0.9 each, on the fender outside the hull line), bedrolls (canvas) on the turret back.
- M_PATH3 heavy tank (Siege Tanks): keep the dozer blade (it reads), and add "a bigger gun": the barrel thickens to
  1.7 with a double baffle brake 2.6 x 2.4, the mantlet grows (box 2.4 x 4.2), and the hull front gets a thick
  sloped add-on plate (tone -1, 1.2 deep across the whole nose).
- All together: all of them, no overlaps (fuel drums at the back, snorkels at the rear corners: move the snorkels
  forward of the drums when both are on).

## 4. Planes

| plane | length now -> target | span now -> target | engines | wing | tail | colour |
|---|---|---|---|---|---|---|
| heavy bomber | 26.3 -> 30 | 37.6 -> 42 | 4 props | long straight, tapered | twin end-plate fins | `alu` |
| cargo plane | 26.2 (keep) | 31.2 (keep) | 2 props | high straight wing | one big fin | `cargo` + invasion stripes |
| bomber | 21.4 (keep) | 26 (keep) | 2 props | straight, mid | single fin | `odplane` |
| recon plane | 18 (keep) | 24.4 (keep) | 2 props on booms | straight | twin booms | `prublue` |
| ground attack | 16.4 -> 18 | 18.8 -> 20 | 1 big radial | inverted gull, broad | single fin | `camo` blotch |
| fighter | 13.6 (keep) | 14.8 (keep) | 1 prop | elliptic | single fin | `seagrey` |

Test order kept: span heavy bomber > cargo > bomber > ground attack > fighter (42 > 31.2 > 26 > 20 > 14.8); props
4 / 2 / 1; cargo fuselage > 1.8 x the bomber's and 1.15 x longer.

- Heavy bomber: lengthen to 30 (ru 15) and span 42 (wing half 21), four engines with dark cowls as now, a long framed
  glass nose, and twin end-plate fins at the tips of a wide tailplane (two fins 4 long x 0.8 at v +-6.6) in place of the
  single fin: the bomber has one fin, the heavy two. The biggest thing in the sky by far.
- Bomber: as now (twin engine, glazed nose, single fin, olive drab). Make the glazed nose a tone brighter so the nose
  reads, and add a bomb bay outline (a dark 5 x 1.2 panel under the centre: shows as a dark line on the fuselage).
- Ground attack: a different kind of plane, a sturdy single-engine dive and attack plane:
  - fuselage 18 long, 2.8 wide (rv 1.4), a big radial cowling 3 across at the nose with a dark ring, a long canopy with
    a rear gunner's position and a gun pointing back (seg 1.6 dark);
  - inverted gull wing: from the root the wing goes out 3.5 at a kink, then straight to the tip at 10 (span 20), broad
    chord (4.8 at the root, 3 at the tip), the kink drawn as a tone change;
  - two fixed spatted undercarriage legs at the kinks: dark teardrops 2.6 x 1.2 that stick out ahead of the leading
    edge (visible from above);
  - under the wings: three rockets per side, 4.6 long x 0.7 wide, pale `white` bodies with `brick` heads poking 1.8
    ahead of the leading edge, and one big bomb under the fuselage whose fins and nose show ahead of and behind the
    wing (dark `gun` 6 x 1.6);
  - camouflage blotch as now. Reads as: a short, chunky, single-engine plane with gear legs and a fan of rocket tips.
- Fighter: as now, the smallest.
- Cargo plane: as now.
- Recon plane: as now when flying (twin booms read); see section 1 for its death.

### Plane upgrades
- M_JET (jet fighter, bomber, ground attack, cargo plane): already reads (swept wings, pods, no propellers). Keep, and
  make the jet nozzles glow as now. Jet ground attack: keep its rockets and gear-less belly (no spats on the jet).
- M_NIGHT (Night Bombing: bomber, ground attack, heavy bomber): "night camouflage", made to read on every type:
  - upper surfaces `night` (cool dark grey) and the fuselage sides and wing edges `black` (the 3/4 view shows the near
    side): a dark plane with a black outline band, cooler and darker than olive drab and camo;
  - roundels dulled: drawn at 0.7 size with a dark ring only (owner colour kept, a smaller mark);
  - flame-damper shrouds: a black streak 3 long x 0.7 over each engine, running back over the wing;
  - the glazed nose a darker tint (`glass` tone 0).
  On the olive bomber the change must be at least as strong as on the aluminium heavy bomber (target: 100+ px changed).
- M_MASTERY (Air Mastery: bomber, ground attack, heavy bomber, fighter): "heavier armament":
  - fighter: two underwing cannon gondolas (dark pods 3.2 x 0.9 at v +-3.6 hanging below the wing but sticking out
    1.4 ahead of the leading edge) and four gun barrels poking 1.4 ahead of the wing; the chequered nose band grows to
    1.6 long (white and black, reads as a bright nose);
  - bomber: a solid gun nose replaces the glazed nose: dark `gun` nose with 6 muzzles poking 1.2 ahead, a dorsal turret
    (dark dome 1.8 across with twin barrels 2 long) and a tail turret (twin barrels 1.6 out behind the fin);
  - ground attack: two long 37 mm cannon pods under the wings (dark, 5 long x 1, barrels reaching 3.6 ahead of the
    leading edge, the longest thing on the plane) in place of the inner rockets (two rockets per side remain);
  - heavy bomber: turbo-supercharged engines: the four nacelles extend 2.6 behind the trailing edge with a bright
    `alu` tone 3 exhaust plate, and bigger four-blade propellers (r 2.2); plus the chequered cowl rings, bigger.
- M_PATH3 (Strategic Bombing, heavy bomber): "a flying fortress": five gun turrets that read: chin (dark dome 1.6 with
  twin barrels 1.6 ahead of the nose), two dorsal (fore and aft, dark domes 2 across with twin barrels 2.2 long, one
  pointing forward, one aft), a ventral ball (1.8, shows as a dark ring at the wing root in the 3/4 view), and a tail
  turret that lengthens the plane by 2 (glazed with twin barrels 2 behind); plus waist gun blisters (pale glass
  bumps 1 x 0.6 each side).
- M_SPECIAL (Drop Tanks: bomber, ground attack, heavy bomber, fighter, cargo plane, recon plane): "longer range":
  move the tanks where they show: under the wing but starting 1 behind the leading edge and reaching 2.6 ahead of it,
  5 long x 1.5 wide on the fighter and recon, 6 x 1.8 on the bombers and the cargo plane, pale `alu` tone 3 with a dark
  nose cap and a thin dark band: two pale torpedo shapes sticking out in front of the wing. On the jet fighter:
  wingtip tanks (4.4 x 1.2 at the very tips), which also change the wing outline.
- All together: no clashes (drop tanks outboard of the cannon pods on the fighter; on the ground attack the cannon
  pods inboard, the remaining rockets outboard, drop tanks under the fuselage instead, 5 x 1.6, poking ahead).

Optional (client only, owner's call): let the recon plane show Jet Engines too (`pixelSprites.ts computeOwner` recon:
`dropTanks | jet`, MOD_MASK reconPlane `M_JET | M_SPECIAL`): jet pods in place of the boom engines, booms kept. And the
heavy bomber could show Jet Engines the same way. Not needed for this round.

## 5. Size changes and render code

No render code change is needed. A unit's size on the map is `modelLength * spriteScale` (render/units.ts reads
`spriteLength` -> `detailedUnits.lengthPx` -> `unitLength`, cached per key and mods), and the click area
(`Math.max(14, S + 6)`), the screen culling margin, wakes, contrails, damage fires (damage.ts by length and span),
deaths (deaths.ts R by length, ship sinking by span), wrecks and portraits (fitted to length and span) all follow the
model. Things to watch:
- Battleship 52 and carrier 60 at zoom 32+ on a 2x screen bake at res 2 (gridOf caps the res near 2): about 130 x 60
  art px, well inside the 1024 atlas pages.
- `art-detailed-round2` damage hit spots stay inside L x 0.4 and B x 0.3: they are computed from the model, so fine.
- Owner colour share stays under 0.16 of the pixels at res 2 and under 0.025 on the carrier (tests).
- Tests to update only where this spec deliberately changes a number: none of the existing size order tests need to
  change with the targets above. New tests worth adding: every upgrade bit a unit can show changes at least
  max(25, 12% of its solid pixels) art pixels at res 1 (the harness in `looks/harness/diffs.ts` measures exactly
  this); the destroyer is at least 6.5 times as long as its beam; the ground attack plane has 1 prop and spats; the
  heavy bomber has two fins; the recon plane's death keeps its fall turns under 0.6.

## 6. Acceptance (pictures)

Re-run the same harness (`looks/harness`, `node build.mjs`, `node shoot.mjs <dir> '<jobs>'`) into `looks/after/` and
compare with `looks/before/` side by side:
- at the normal zoom (the `_game` sheets, 4x): each of the seven ships named at a glance by shape alone; the three
  tanks and six planes likewise; every non-dark cell in an upgrade column visibly different from the plain cell;
- the recon death at sea: the plane recognisable as the recon plane until it hits the water, falling in a steady
  dive with one engine burning, no ladder shapes, a splash at least as big as the cargo plane's, the slick and pieces
  visible on the dark sea for 2 s.

## Owner decisions (added after the plan, these win over anything above)

The owner wants the upgrades to carry the units from the propeller era into a modern look. Visual only: no rule changes.

Planes:
- Ground attack (plain): a heavy armoured single-engine propeller attack plane, thick and stubby, straight wings, rockets and bombs hung under the wings. It must read as a bruiser, not a fighter or a bomber.
- Ground attack + Jet Engines (M_JET): an A-10 style jet attack plane: straight wing, two big engine pods high on the rear fuselage, twin tail fins, a long nose cannon. No other plane uses this silhouette.
- Fighter + Jet Engines: a swept-wing single-jet fighter, no propeller.
- Bomber + Jet Engines: a jet bomber: swept wings, jet pods under the wings, no propellers.
- Heavy bomber (plain): a big four-engine propeller bomber.
- Heavy bomber + Strategic Bombing (M_PATH3): the modern step: a giant swept-wing eight-jet strategic bomber (B-52 style: four twin pods under long swept wings). Heavy bombers have no M_JET, so this upgrade is their jet age.
- Transport plane + Jet Engines: a four-jet transport (high wing, jets under it).
- Other jets: swept wings so the A-10 silhouette stays unique to ground attack.

Tanks (each type its own silhouette first, then the upgrades carry it forward):
- Tank division (plain, before an armor pick): a classic mid-century medium tank: rounded cast turret, medium gun, sloped hull.
- Light tank: small, low and quick looking: short hull, small turret, light gun, fewer road wheels.
- Heavy tank: big and boxy: wide long hull, big square turret, thick long gun, extra road wheels.
- Mastery (M_MASTERY) on any tank: the modern main battle tank look: low angular turret, long gun with a fume extractor, side skirts.
- Deep Raids (M_PATH3 on the light tank): a raider fit: fuel drums on the back deck, tall radio whip antennas, a stowage rack, a smoke-grenade launcher bank.
- Siege Tanks (M_PATH3 on the heavy tank): an assault gun: a huge short heavy gun (howitzer bore) in a boxy armoured casemate or a bigger turret, clearly bulkier than the heavy tank.
- Amphibious Tanks (M_SPECIAL): a flotation screen or rubber skirt round the hull and a raised snorkel tube; reads as "can swim".

Ships, through mastery (M_MASTERY), the modern refit you notice:
- Warship, destroyer, battleship: radar domes or a lattice radar mast, missile launcher boxes or vertical launch cells on deck in place of some of the older guns.
- Submarine with mastery: a modern nuclear boat: longer rounded teardrop hull, a tall sail with fin planes on it.
- Carrier with mastery: a supercarrier: bigger angled deck, island with radar; if the deck shows planes, jets.
- Naval Mines (M_SPECIAL) on ships: clear mine rails with mines on the stern, visible at normal zoom.
- Transport and trade ship have no upgrades: keep them distinct from the warships (blunt landing craft with a bow ramp; a merchant with cargo hatches or containers and a funnel at the stern).

Missiles and others: leave the rocket, the atom bomb and the paratroopers as they are unless the spec already improves them.
