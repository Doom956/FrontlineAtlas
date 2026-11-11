# UI direction: Modern Flat

Crisp vector, no pixel art. Neutral charcoal sheets over a quiet slate-and-sage map, one violet accent that
marks the one primary action on a screen, one grotesque sans in sentence case. Land carries the picture; the HUD
sits on its edges and stays out of the way.

Tokens live in `src/client/styles.css` (`:root`); the direction layer is `src/client/theme.css`, loaded last from
`main.ts`. Older token names (`--brass*`, `--metal*`, `--olive`) are kept so module stylesheets keep working; their
values are the Modern Flat ones below.

## Palette

Surfaces (dark only, `color-scheme: dark`):

| Token | Hex | Role |
| --- | --- | --- |
| `--ink` | `#111316` | page behind menus, deepest well |
| `--metal` / `--metal-a` | `#1a1d22` (94% over the map) | every HUD sheet: dock, top bar, standings, drawers, toasts |
| `--metal-2` | `#23272e` | inset tracks (segmented controls, tab rows, steppers), resting research node |
| `--metal-3` | `#2c3139` | resting button, hover on sheet, available research node |
| `--metal-4` | `#373d46` | button hover |
| `#4a515c` | (segment pick) | the picked option in a segmented control or tab row |
| `--rule` / `--rule-hi` | `#2c3138` / `#434a54` | the one hairline between groups; locked node outline |

Text and accent:

| Token | Hex | Role |
| --- | --- | --- |
| `--text` | `#eef0f3` | values, names, button words |
| `--dim` | `#aab1bb` | labels under icons and beside numbers |
| `--faint` | `#868e99` | meta and disabled words, only on `--metal`/`--metal-2` |
| `--brass` (accent) | `#6b57f0` | fill of the one primary action (Build, Start game, Research) |
| `--accent-hover` | `#5a46e0` | primary hover (darker, so white text keeps AA) |
| `--brass-hi` | `#a497ff` | focus ring, progress lines, "next" research outline |
| `--accent-soft` / `--accent-text` | violet 18% / `#c9c1ff` | selected (on) state of a non-primary control and its word |
| `--olive` | `#4fc28a` | good: done, ready, gains |
| `--gold` | `#f2c65a` | gold amounts and warnings |
| `--signal` | `#f0625a` | bad: losses, attacks, errors |
| `--steel` | `#6aa6e0` | in progress (researching, building) |

Measured contrast (WCAG 2.x relative luminance):

| Pair | Ratio | Needs |
| --- | --- | --- |
| text on metal | 14.80 | 4.5 |
| dim on metal / metal-2 / metal-3 | 7.82 / 6.93 / 6.05 | 4.5 |
| faint on metal / metal-2 | 5.10 / 4.53 | 4.5 (not used on metal-3: 3.95) |
| white on accent `#6b57f0` | 4.95 | 4.5 |
| white on accent hover `#5a46e0` | 6.20 | 4.5 |
| accent-text on accent-soft over metal | about 8 | 4.5 |
| gold / olive / signal / steel on metal | 10.46 / 7.58 / 5.31 / 6.55 | 4.5 |
| text on segment pick `#4a515c` | 7.01 | 4.5 |
| focus `#a497ff` against metal | 6.80 | 3 |
| accent fill against metal (non-text) | 3.42 | 3 |

Map: deep water `#16212e`, shallow `#203142` (a tight 6-tile shelf, no glow), plains `#92a278`, forest `#647c5c`, hills `#a0987c`, mountains
`#8a8a88`, desert `#ccc09c`, swamp `#6c7660`, tundra `#d0d6da` (`render/terrain.ts`). Water sits close to the UI
ink so land carries the picture; terrain is desaturated so nation fills (70% over a greyed land) read as flat
political colour. Tribes get a 42% tint and a light hairline edge, not a dark outline, so the far map does not
fill with grey patches. Nation colours keep the existing OKLCH spread (`render/palette.ts`).

## Type

One family: IBM Plex Sans 400/500/600/700 (`@fontsource/ibm-plex-sans`, bundled). Tabular figures on every
changing number. Sentence case everywhere, no letter spacing, no uppercase labels.

| Role | Size / line / weight |
| --- | --- |
| Menu title (logo) | 54 / 0.98 / 600 (64 on wide screens, 30-40 on phones) |
| Screen and drawer heading | 15 / 1.2 / 600 |
| Big resource number (troops, gold) | 22 / 1 / 600 tabular |
| Clock | 17 / 1 / 600 tabular |
| Body, rows, button words | 13 / 1.45 / 400-500 (buttons 500, primary 600) |
| Research node name | 14 / 1.2 / 600 |
| Labels beside numbers | 12 / 1 / 500 dim |
| Word under an icon | 11 / 1 / 500 dim (the floor; nothing smaller) |
| Map nation names | 600, capped at 22 px, sentence case, white with a dark halo |
| Map tribe names | 500, capped at 13 px |

## Spacing, radii, borders, elevation

- Spacing steps 4, 8, 12, 16, 24 (`--s1`..`--s5`). Inside a group 2-8 px, between groups 16 px or a hairline.
- Radii: 8 px on sheets and buttons (`--r`), 6 px on controls nested in a sheet (`--r-s`), 3 px swatches,
  round only for badges and dots.
- No borders for structure. A sheet is one fill plus one shadow `--e1`
  (`0 1px 2px rgba(0,0,0,.3), 0 4px 16px rgba(0,0,0,.28)`). Borders appear only as state: the white ring on a
  picked map, the violet outline on the next research, a hairline on a locked node.

## Icons

The existing line icon set (`hud/glyph.ts`), 18 px, stroke matching the 500 weight of the word under it, always
`currentColor`. Every primary control is icon plus a word: top bar (Alerts, Map key, Pause, Speed, Sound, Help,
Menu ...), dock build slots (building name under its glyph), strikes (weapon name under its glyph). No hotkey
chips anywhere visible; keys live in How to play.

## Map units and buildings

`render/unitArt.ts`: bold top-down silhouettes in the owner colour with a dark 1.6 px edge, nose forward.
Far (half-length under 6.5 px): the solid silhouette only, small enough that a front of tanks reads as a
row of chips. Near: light decks and canopies, dark turrets, tracks, engines and gun barrels. Covers warship,
trade ship, transport, tank division, fighter, bomber, transport plane, recon plane, rocket, atom bomb.
Fleets far out stay one marker with a count (`render/fleets.ts`). Buildings (`render/buildings.ts`): far out
only cities (light squares growing with level) and forts; from `FAR_ZOOM` every building is a rounded plate in
its category colour with a white glyph, framed in the owner colour.

## Motion

Only state answers: hover and press change background over 120 ms (`--fast`), no scale bounce, no glow pulses,
no sheen sweeps. Drawers and toasts appear with a short fade. Everything else is still.

## The rules that keep it clean

1. One fill per screen is violet: the primary action. Everything else is charcoal, selected states use the soft
   violet tint, and status colours mean only good, bad, gold and in progress.
2. Separate with space and one surface step, never a box in a box. No brackets, stripes, grain or eyebrow labels.
3. Every main control says what it does in a word under or beside its icon; every number says its unit.
4. Far map first: terrain quiet, nation names calm and capped, units as small solid shapes; detail only on zoom.
