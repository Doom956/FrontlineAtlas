# Art styles and the art lab

The map art (units, troop icons, wakes, contrails, explosions, craters, cannon fire, paratroopers) is drawn by an art
style chosen per category, with a motion preset chosen per animated category. Code: `src/client/art/`.

Categories: `ships`, `land`, `air`, `missiles`, `troopIcons`, `explosions`, `craters`, `wakes`, `contrails`,
`cannonFire`, `paradrop`. Motion categories: `ships` (also the wakes), `land`, `air` (also the contrails and the
paratroopers), `missiles`, `explosions`, `craters`, `cannonFire`; troop icons do not move.

`paradrop` (`ParadropArt` in `art/types.ts`) is the paratroopers: the parachutes coming down round the point a cargo
plane dropped its troops on (owner colour, age, parachute count, zoom, seed; drawn at every zoom, far out too) and the
small parachute mark next to a cargo plane in flight (mid and close zoom). The refined art is `art/refined/paradrop.ts`.

| Piece | File |
|---|---|
| Categories, styles, motion presets, the picks and their build-time overrides | `art/artStyle.ts` |
| Motion presets as numbers (subtle, lively, cinematic) | `art/motion.ts` |
| The interface a style implements (one object per category) | `art/types.ts` (`StyleModule`) |
| Lookup used by the game (`artFor`, `motionFor`) | `art/registry.ts` |
| Shared helpers: sprite atlas with a per-frame bake budget, colour maths, noise, pixel discs, unit keys | `art/shared/` |
| Refined pixel style (the game's art) | `art/refined/` |
| Detailed pixel style (twice the pixels, muted military colours), realistic painted top-down style | `art/detailed/`, `art/realistic/` |

Rules for a style: draw only (never read or write the game state); deterministic for the same arguments (no
`Math.random`); motion only from the clock and the `MotionParams` numbers, so all three presets work; the three style
folders never import each other (`tests/artStyle.test.ts` checks it). The far level of detail (unit markers, fleet
markers with counts, the troop pills' plates and counts) is shared and not part of a style.

## Picking the art for a build

- `VITE_ART_STYLE=realistic` draws every category in one style.
- `VITE_ART_STYLE="ships: realistic (subtle motion), land: detailed (lively motion), ..."` takes the art lab's copied
  picks line as it is (styles and motion presets). A wakes, contrails or paradrop entry carries the motion of the ships
  or planes it follows.
- `VITE_ART_MOTION=cinematic` (or `"ships: subtle, explosions: cinematic"`) sets the motion presets.
- Without them: every category refined, every motion lively (the look before the switch).

## The art lab

`VITE_ART_LAB=1 npx vite build --outDir <dir>` builds the game with the lab inside; open `<dir>/index.html#artlab`.
A normal build drops the lab completely (`__ART_LAB__` is false in `vite.config.ts`).

Three columns (refined pixel, detailed pixel, realistic), one row per category, each cell a live scene drawn by the
real style module: ships with wakes, land units, planes with contrails flying a figure eight (they bank both ways),
missiles with smoke trails, troop icons and pills, explosions, craters from fresh to faded, a battleship and a
destroyer shelling a coast, and paratroopers (two cargo planes flying a loop over land, each dropping its troops once a
lap: the parachutes open, drift down swaying, land and fade, in the owner's colour). Controls: the picks for the game (a style and a motion per category, also a Pick button
under every cell), the motion of every cell at once and per row, close, near and mid zoom, pause, "Copy my picks" and
"Try my picks in the game" (the lab build's game then starts with those picks).
