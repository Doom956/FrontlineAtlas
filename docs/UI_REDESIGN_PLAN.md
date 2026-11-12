# UI redesign plan (handoff)

Goal: make the interface clean, streamlined and obviously not AI-generated, like a real
shipped strategy game. Build FOUR distinct directions on the real app, screenshot each on the
same screens, let the owner pick one, then roll the winner out fully.

## Owner's rules (hard requirements, these win over any direction brief)
- Design for THIS game, not the reference: grand scale, whole continents, hundreds of units,
  played zoomed out most of the time, in a browser and on phones. LAND is the star, not
  sprites. Priority: (1) the zoomed-out map looks great and calm (clean borders, quiet
  terrain, nation colours that do not fight each other, readable nation names at every zoom);
  (2) the HUD shows what a player needs every second (troops, gold, attack strength, build)
  and tucks the rest behind clear labelled buttons; (3) research and arsenal trees read at a
  glance; (4) unit art is a bonus for zoomed-in play and must never clutter the far view (use
  levels of detail: far = simple markers and fleet counts; near = detailed art).
- EVERYTHING must be obvious to a first-time player who skipped the tutorial, WITHOUT hovering:
  icon plus a plain word on main controls (never icon-only for primary actions), numbers carry
  units (k troops, gold/s), one obvious primary action per screen, disabled things say why in
  plain words, familiar layouts only (resources along an edge, a build button that looks like a
  button, minimap in a corner, trees read left-to-right or top-to-bottom, costs next to what
  they buy). No clever interactions. Anything hidden sits behind a clearly labelled button,
  never only a hotkey / hover / right-click / long-press. Tooltips add detail but are never the
  only way to learn what something is. Keep the guide and How to play working.
- Learn from good games freely (muted map so important things pop; team colour as a small
  plate/band/flag, not a full tint; place names on small quiet plates; few colours; one
  consistent style; one panel for the selected thing). Other games are fine as references for
  looks, effects and patterns (for example Warfront's troop icons, missiles and explosions, or a
  CS case-hardened finish). The one thing not to do: a 1:1 copy of the competitor game (see
  CLAUDE.md). Art is drawn in code so the build stays one offline file; do not paste asset files
  taken from other games.
- No game rule / sim / protocol changes: look, layout and art only; every control keeps working.
- Keep all test selectors (data-test, aria-label, role) and visible labels tests rely on; grep
  tests/ and tests/e2e before renaming; update tests in the same commit if you must change one.
- No em dashes anywhere. Never the competitor's name (the word "open" joined to "front"). No new hotkeys. Commits authored by Doom956,
  never any Co-Authored-By / Claude line. Keep the hidden owner console ("|" key) working.

## The four directions
1. Pixel Ops (branch `ui-pixel-ops`, PARTIAL work pushed): original crisp pixel sprites for
   every unit (warship + variants, submarine, transport, trade ship, tank division, bomber,
   fighter, transport plane, recon plane, rocket, atom bomb) and building markers, plus pixel
   effects (muzzle flash, explosion, missile smoke trail, ship wake), team colour as a
   band/flag. Dark olive/gunmetal flat HUD, hard 1px edges, no glow/gradient, compact command
   strip, unit cards with a pixel portrait, a pixel display face for titles/numbers only (body
   stays a clean sans), khaki/signal-orange accent. Named places in small crisp caps.
2. Pixel Clean (branch `ui-pixel-clean`, PARTIAL work pushed): same original pixel sprites, but
   a brighter friendlier map and the LEAST HUD chrome: near-black translucent panels, no
   borders (separation by spacing + one hairline), one accent, generous padding, small quiet
   sans (no pixel font in the HUD except the clock/big numbers). Hide anything not needed now.
3. Modern Flat (branch `ui-modern-flat`, NOT STARTED): no pixel art, crisp vector. Neutral
   charcoal surfaces, one confident accent, sentence case (no letter-spaced caps), one
   grotesque sans type scale, consistent 8px radii, a bottom dock for core actions with large
   clear icons, a slim top resource/time bar, drawers as clean sheets, research tree as a tidy
   node graph. Units as clean bold vector silhouettes (top-down ships/tanks/planes/missiles),
   owner-colour fills.
4. Paper Atlas (branch `ui-paper-atlas`, NOT STARTED): light cartographic theme leaning into
   the name. Map like a printed atlas (paper land tones by terrain, inked coasts/borders,
   mountain hatching, muted nation tints with ink outlines, serif-italic place labels). HUD as
   light paper cards, ink type, a refined serif for titles/numbers + clean sans body, thin ink
   rules not boxes, one stamp-red accent. Units as small engraved/stamped map symbols, owner
   tinted. Must stay high-contrast and readable (WCAG AA), not look like a document.

Each direction writes docs/UI_DIRECTION.md (palette hex + contrast, type scale/faces, spacing,
radii, borders/elevation, icon style, motion, the 3-4 rules that keep it clean) and restyles:
main menu, setup/game-format screen (and lobby), in-game HUD (top cluster, command/resource
bar, standings, toasts, alerts, tooltips), drawers and cards (building, unit, forces), build
menu, research tree + arsenal page, end summary, phone 390px, plus original map unit/building
art. Remove the "tells" below.

## What the current UI does wrong (the "generated" tells, from the scout)
Every panel is its own bordered box with the same chrome; decorative brass corner brackets;
scanline/grain sheen on every panel; 257 letter-spacing + 109 uppercase micro-labels; eyebrow
labels above headings; left accent stripes on cards; brass/gold used for everything so nothing
is primary; card-inside-card-inside-card research tree; .note helper text on everything; hotkey
chips baked into the visible UI (against the no-hotkey rule). Full list and 21 baseline
screenshots: run the screenshot tool below.

## Tooling (in the repo, so it survives a fresh machine)
- `scripts/ui/shots.mjs`: the shared screenshot script. Build first, then:
  `node scripts/ui/shots.mjs <path to dist/index.html> <output dir>`
  Fixed seed, controlled clock, selects by data-test/aria-label/role (restyle-proof). ~100s a
  pass, 21 screens at 1440x900 plus 3 phone screens. It lists the exact selectors it needs
  (keep them). Run one pass at a time (shared 4-core machine).
- `tools/ui-baseline/`: the 21 baseline screenshots of the CURRENT look, for before/after.

## How to finish (recommended: a Workflow round)
Resume the two partial branches and build the two unstarted ones from the briefs above, each
following the owner's rules. Then an art-director critique per direction from its screenshots
(explicit first-time-player test: list every control/number not obvious without hovering; each
is a must-fix) and a fix pass. Finally build a single comparison page (an Artifact gallery)
showing all four side by side with each direction's screenshots and a playable build
(copy each dist/index.html), for the owner to pick. After the pick: roll that one out across
every remaining surface, review, run the checks (tsc x2, vitest, build) and both multiplayer
e2e on GitHub (scripts/remote-e2e.sh), then merge dev -> main.
