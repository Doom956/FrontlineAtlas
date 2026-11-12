# UI direction: Pixel Clean

A bright, friendly pixel world with the quietest possible interface over it. The land carries the colour; the HUD
is near-black glass with no borders, one amber accent and small clean type. The pixel feeling lives in the map, the
unit art and one display face for the logo, the clock and the big numbers. Nothing else in the chrome is "pixel".
These are the final picks: smooth gradient water, amber for the game and the setup screen, a heated-titanium logo
and Play button on the main menu, and a research blue in the research and arsenal panel.

## Palette

Measured with the WCAG formula on the opaque panel `#14161b` (the glass `rgba(18,20,26,0.8)` sits over a dark map
and renders at or below that lightness). AA needs 4.5:1 for text and 3:1 for control edges and state.

| Token | Hex | Role | Contrast |
|---|---|---|---|
| `--ink` | `#0b0d11` | app base | |
| `--metal` | `#14161b` | panel (opaque fallback of the glass) | |
| `--metal-2` | `#1b1e25` | control inside a panel | |
| `--metal-3` | `#262a33` | hover; available research card | |
| `--rule` | `rgba(255,255,255,0.09)` | the one hairline | |
| `--text` | `#edeff3` | primary text | 15.7:1 (12.5:1 on `--metal-3`) |
| `--dim` | `#9aa0ac` | labels, secondary | 6.9:1 (5.5:1 on `--metal-3`) |
| `--faint` | `#7f8590` | quiet labels, locked items | 4.9:1 |
| `--accent` | `#f5b13d` | the primary action, the current value | 9.7:1 as text |
| `--accent-ink` | `#1a1304` | text on amber | 9.9:1 on `--accent` |
| `--sel-bg` / `--sel-ink` | `#e6e9ef` / `#15171c` | selected segment, tab, map | 14.7:1; fill vs `--metal-2` 13.7:1 |
| `--good` | `#74c365` | owned, gains | 8.4:1 |
| `--danger` | `#f2543d` | losses, under attack | 5.3:1 |
| `--info` | `#7fa6d6` | in progress | 7.2:1 |

Map (render/terrain.ts, render/palette.ts): water is one smooth slate gradient by distance to land, no steps or
contour lines: the shelf `#264a5b` near the coast, `#203b4c` in the middle and `#172634` in the open sea (OKLCH
lightness 0.39, 0.34, 0.26, hue 230 to 246), reached 14 tiles out (wider when zoomed far out). The shader, the
minimap and the Canvas2D fallback use the same ramp (`waterRGB` in terrain.ts). Fresh greens and warm tans for land,
light stone mountains. Nation fills are the nation hue at even lightness and 58% opacity; tribes are paler still
(44%) so they read as background. Borders are a darker shade of the same hue, never black.

### Where the accent changes

The in-game HUD, the setup screen and the unit card are amber. Two places repoint `--accent` (and its `--brass`
aliases, which resolve where they are declared) on their own root element, so nothing else changes:

**Main menu: titanium** (`.menu-card.title` in menu.css). The colours titanium takes when it is heated: straw, bronze,
purple, deep blue, light blue. Only the logo and the one main action (Play, or Continue / Rejoin when they lead)
wear the gradient; the setup screen and the game never do.

| Part | Stops | Contrast |
|---|---|---|
| Logo (Jersey 15 clipped to the gradient, 100deg, mixed in OKLab) | `#f0d592` 0%, `#dc9064` 24%, `#b473d1` 46%, `#5e8fed` 70%, `#7ac8f5` 100% | on the column `#0e1015`: 13.3, 7.5, 5.7, 6.0, 10.3:1; lowest measured on the rendered logo 5.7:1 |
| Main action fill (an equal-lightness ramp, OKLCH L 0.50 to 0.515) | `#905326` 0%, `#894b93` 16%, `#5457bc` 42%, `#375fb9` 68%, `#1666aa` 100% | white text 6.1, 6.0, 6.1, 6.0, 6.0:1 (measured on the button 6.0 to 6.1:1); every stop against the column 3.1:1 or more |
| Small accents on the start page (Play again, row arrows) | `--accent` `#7ac8f5`, `--accent-ink` `#06192a` | 10.3:1 as text; ink on it 9.7:1 |

The fill is 130% wide; hovering slides it to the blue end and one soft light band (white at 10%) sweeps across once,
on hover-capable pointers only and never under `prefers-reduced-motion`. Under the band the white text keeps at least
4.8:1. Matte, no specular highlight. In forced colours the logo is plain CanvasText and the button gets a border.

**Research and Arsenal: research blue** (`aside.drawer[data-page='research']` in researchPanel.css). One colour, one
meaning inside the panel: blue is the suggestion and the main action, cyan is what is running now.

| Token | Hex | Role | Contrast on `#14161b` |
|---|---|---|---|
| `--accent` | `#3d66df` | the "Next" flag, the panel's primary button | white text 5.0:1; edge 3.6:1 |
| `--accent-hover` | `#375fd3` | the primary button under the pointer | white text 5.6:1; edge 3.2:1 |
| `--accent-hi` | `#93aef8` | the Next card's edge, "Available", the tab dot | 8.3:1 (6.6:1 on `#262a33`) |
| Next card fill | `--accent` at 26% (`#243155`) | the suggested card | `--text` 11.1:1, edge `#93aef8` 5.9:1 |
| `--info` | `#4fccd9` | researching / on order: the card edge, its bar, "97% and 14 s left", the header's "Researching" | 9.5:1; 7.2:1 on its own tint `#202f37` |

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
- Accent: amber everywhere except the main menu (titanium) and the research panel (research blue), see "Where the
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
   in the game and on the setup screen, titanium on the main menu (Play), research blue in the research panel.
   Selection is a light neutral fill, headings are plain text, state colours are semantic only.
2. **No chrome, only space.** No borders, corner brackets, stripes, grain or gradient washes on panels. Cards in the
   research tree differ by fill, not by outline style.
3. **Icon plus word, numbers with units.** Every primary control names itself; every number says what it counts
   (k troops, gold/s, 30 s). No hotkey chips and no hint that only names a key.
4. **The map is the picture.** Calm water, pale tribes, mixed-case names on a soft halo, and units that collapse to
   markers when zoomed out.
