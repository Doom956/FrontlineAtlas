# UI direction: Pixel Clean

A bright, friendly pixel world with the quietest possible interface over it. The land carries the colour; the HUD
is cool steel glass with no borders, one amber accent and small clean type. The pixel feeling lives in the map, the
unit art and one display face for the logo, the clock and the big numbers. Nothing else in the chrome is "pixel".
These are the final picks: smooth gradient water, amber for the game and the setup screen, a case-hardened logo
and Play button on the main menu, and a research blue in the research and arsenal panel.

## Palette

Measured with the WCAG formula on the opaque panel `#121821` (the glass `rgba(18,24,33,0.8)` sits over a dark map
and renders at or below that lightness). AA needs 4.5:1 for text and 3:1 for control edges and state. The panels are
cool steel: a dark blue-grey at hue 213 to 216, every step on the same hue.

| Token | Hex | Role | Contrast |
|---|---|---|---|
| `--ink` | `#0a0e14` | app base | `--text` 16.8:1 |
| `--metal` | `#121821` | panel (opaque fallback of the glass) | |
| `--metal-2` | `#1c2531` | control, inset inside a panel | `--text` 13.4:1, `--dim` 6.5:1, `--faint` 5.3:1 |
| `--metal-3` | `#27313f` | hover; available research card | `--text` 11.4:1, `--dim` 5.5:1, `--faint` 4.5:1 |
| `--metal-4` | `#313d4c` | pressed, strong | `--text` 9.6:1 (no faint text on it) |
| `--rule` | `rgba(255,255,255,0.09)` | the one hairline | |
| `--text` | `#edeff3` | primary text | 15.5:1 (11.4:1 on `--metal-3`) |
| `--dim` | `#a0a8b5` | labels, secondary | 7.4:1 (5.5:1 on `--metal-3`) |
| `--faint` | `#8f98a7` | quiet labels, locked items (lifted from `#7f8590` for the bluer panels) | 6.1:1 (4.5:1 on `--metal-3`) |
| `--accent` | `#f5b13d` | the primary action, the current value | 9.5:1 as text |
| `--accent-ink` | `#1a1304` | text on amber | 9.9:1 on `--accent` |
| `--sel-bg` / `--sel-ink` | `#e6e9ef` / `#15171c` | selected segment, tab, map | 14.7:1; fill vs `--metal-2` 12.7:1 |
| `--good` | `#74c365` | owned, gains | 8.3:1 |
| `--danger` | `#f2543d` | losses, under attack | 5.2:1 |
| `--info` | `#7fa6d6` | in progress | 7.1:1 |

Map (render/terrain.ts, render/palette.ts): water is one smooth slate gradient by distance to land, no steps or
contour lines: the shelf `#264a5b` near the coast, `#203b4c` in the middle and `#172634` in the open sea (OKLCH
lightness 0.39, 0.34, 0.26, hue 230 to 246), reached 14 tiles out (wider when zoomed far out). The shader, the
minimap and the Canvas2D fallback use the same ramp (`waterRGB` in terrain.ts). Fresh greens and warm tans for land,
light stone mountains. Nation fills are the nation hue at even lightness and 58% opacity; tribes are paler still
(44%) so they read as background. Borders are a darker shade of the same hue, never black.

### Where the accent changes

The in-game HUD, the setup screen and the unit card are amber. Two places repoint `--accent` (and its `--brass`
aliases, which resolve where they are declared) on their own root element, so nothing else changes:

**Main menu: case-hardened swirl** (`.menu-card.title` in menu.css, drawn by `src/client/caseHardened.ts`). Only the
logo and the one main action (Play, or Continue / Rejoin when they lead) wear a heat-treated metal finish instead of
a smooth gradient; the setup screen and the game never do. It is drawn once at startup in code (seeded per balance,
no image files) and handed to the CSS as `--case-logo` and `--case-fill`.

The finish is fluid mottled swirls: three-level domain-warped fbm cut by quantile into straw, bronze, purple, deep and
light blue patches with soft cloudy edges, bare grey steel showing through, a hue jitter field and brushed grain. The
logo and the button are cut from different parts of the same field; the logo cut is shown at 0.6 so its thin pixel
strokes cross several patches.

The owner liked all four colour balances, so they take turns: each visit to the game shows the next one (A, B, C, D,
then A again), remembered in the browser (`frontline.caseVariant.v1`); where storage is blocked, a random one. A
menu shown again in the same visit keeps its balance.

| Balance | Look |
|---|---|
| A balanced | blue, purple and gold in even swirls |
| B mostly blue | blue and purple, little gold |
| C gold-heavy | straw and bronze lead |
| D purple-heavy | purple leads |

| Part | Rule | Contrast |
|---|---|---|
| Logo (Jersey 15, 60px, clipped to the light key) | every texture pixel lifted to luminance 0.15 or more; a 1px dark drop edge | 3.3:1 or more per pixel on the column `#0e131b` (large-text floor 3:1); flat fallback `#a9bfe6` 10.0:1 |
| Main action (deep key, white text) | every texture pixel softly capped at luminance 0.168 | white text 4.8:1 or more on the brightest pixel; measured from the rendered page (worst pixel under "Play" and "Against AI") below; flat fallback `#34508f` 7.8:1 |
| Button edge | 1px `#6a7d9c`; under the pointer `#a9bfe6` (the hover is that edge alone, no motion) | 4.5:1 and 10.0:1 on the column |
| Small accents on the start page (Play again, row arrows) | `--accent` `#7ac8f5`, `--accent-ink` `#06192a` | 10.1:1 as text; ink on it 9.7:1 |

Measured worst pixel under the button words (rendered at 2x in Chromium, white text against the darkest-to-lightest
pixel under "Play" and "Against AI"): A 4.79, B 6.80, C 4.79, D 4.85:1. Every glyph pixel of the logo is 3.1:1 or
more on the column in all four.

Without a 2D canvas (jsdom, locked-down browsers) the logo is the flat `#a9bfe6` and the button `#34508f`. In forced
colours the logo is plain CanvasText and the button gets a ButtonText border. Matte, no specular highlight, no
motion, so reduced motion needs nothing more.

**Research and Arsenal: research blue** (`aside.drawer[data-page='research']` in researchPanel.css). One colour, one
meaning inside the panel: blue is the suggestion and the main action, cyan is what is running now.

| Token | Hex | Role | Contrast on `#121821` |
|---|---|---|---|
| `--accent` | `#3b69fa` | the "Next" flag, the panel's primary button (the owner's cobalt `#3d6bff` gives white text only 4.43:1, so the same hue one step darker) | white text 4.6:1; edge 3.9:1 |
| `--accent-hover` | `#3560e6` | the primary button under the pointer | white text 5.3:1; edge 3.4:1 |
| `--accent-hi` | `#93aef8` | the Next card's edge, "Available", the tab dot | 8.2:1 (6.0:1 on `#27313f`) |
| Next card fill | `--accent` at 26% over the panel (renders `#1d2d59`) | the suggested card | `--text` 11.6:1, `--dim` 5.6:1, `--faint` 4.6:1, edge `#93aef8` 6.1:1 |
| `--info` | `#4fccd9` | researching / on order: the card edge, its bar, "97% and 14 s left", the header's "Researching" | 9.3:1; 7.7:1 on its own tint `#182a33` |

Cobalt sits at OKLCH hue 266 and cyan at 205, so the two never read as one colour; each also has its own words
("Next" on a flag, a percentage and time left with a bar). Hovering a card lights its path in neutral light (what it
needs) and grey (what it opens), never in blue or cyan. Cautions (a missing building) stay amber (`--caution`).

## Type

- **DM Sans** (400, 500, 600, 700) for every word: labels, body, buttons, values, map names. Tabular figures on
  every changing number.
- **Jersey 15** (400 only, the weight it ships; no synthetic bold) for the logo, the clock and the big HUD numbers
  (troops, gold, attack share).

| Size | Role |
|---|---|
| 11px | captions under icons, small counts |
| 12px | secondary lines |
| 13px | body and control text |
| 15px | section headings, research row names |
| 17 to 20px | panel titles |
| 22 to 28px | big numbers (Jersey 15) |
| 60px | logo (Jersey 15) |

Sentence case everywhere. No letter-spaced capitals, no eyebrow labels above headings. Map names are mixed case,
600, with almost no tracking, sized by the territory and capped.

## Space, radius, elevation

- Spacing: 4, 8, 12, 16, 24, 32. Inside a group 8, between groups 16 or more.
- Radius: 12px panels, 8px controls, 4px chips.
- Elevation: no borders on panels. Glass (`backdrop-filter: blur(14px)`), a 1px top inset highlight and one shadow
  `0 10px 30px rgba(0,0,0,0.38)`. Separation inside a panel is space, then a single `--rule` hairline.

## Icons and art

- Interface (hybrid): small pixel icons drawn in code (hud/pixelIcons.ts), one grid cell per CSS pixel, at the
  size the line icons had, always with a plain word under or beside them on primary controls (the top bar, the
  command bar, strikes). Hand-made art for the top bar, Build and the resource chips; building and strike pictures
  traced from the existing art. Each icon takes the muted hue of its family (--cat-navy, --cat-armor, --cat-air,
  --cat-econ, --cat-science, --cat-strike in styles.css), never the accent.
- Unit card and Forces list: the unit's own map sprite as a portrait (hud/portrait.ts calls drawUnitSprite).
- Research and Arsenal: the Modern Flat layout (tabs on a track, no fork frames, neutral lines, a Next flag) in
  these tokens, with the research blue accent.
- Accent: amber everywhere except the main menu (case-hardened steel) and the research panel (research blue), see "Where the
  accent changes".
- Units (render/pixelSprites.ts): original pixel sprites drawn from rectangles in code, one density, a 1px dark
  outline and a two-tone owner ramp. Far: a small solid marker per unit and fleet markers with a count. Near (zoom 3
  and up): the full sprite for warships, transports, tank divisions, planes and missiles.
- Buildings: a calm category plate with a white glyph and a thin owner band under it; the name appears close up.

## Motion

Motion answers an action and nothing else: a drawer opens, a toast slides in, a pressed button scales to 0.96.
No idle pulses or bounces. `prefers-reduced-motion` turns movement off.

## The rules that keep it clean

1. **One accent thing per view.** The accent is the primary action (Start game, Build) and the current value: amber
   in the game and on the setup screen, case-hardened steel on the main menu (Play), research blue in the research panel.
   Selection is a light neutral fill, headings are plain text, state colours are semantic only.
2. **No chrome, only space.** No borders, corner brackets, stripes, grain or gradient washes on panels. Cards in the
   research tree differ by fill, not by outline style.
3. **Icon plus word, numbers with units.** Every primary control names itself; every number says what it counts
   (k troops, gold/s, 30 s). No hotkey chips and no hint that only names a key.
4. **The map is the picture.** Calm water, pale tribes, mixed-case names on a soft halo, and units that collapse to
   markers when zoomed out.
