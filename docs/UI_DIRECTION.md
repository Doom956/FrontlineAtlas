# UI direction: Pixel Clean

A bright, friendly pixel world with the quietest possible interface over it. The land carries the colour; the HUD
is near-black glass with no borders, one amber accent and small clean type. The pixel feeling lives in the map, the
unit art and one display face for the logo, the clock and the big numbers. Nothing else in the chrome is "pixel".

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

Map (render/terrain.ts, render/palette.ts): calm mid blue water with deep and shallow close together (no glow round
the coast), fresh greens and warm tans for land, light stone mountains. Nation fills are the nation hue at even
lightness and 58% opacity; tribes are paler still (44%) so they read as background. Borders are a darker shade of
the same hue, never black.

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
  these tokens.
- Palettes (comparison switch, VITE_UI_PALETTE): amber (base), violet, teal, coral in src/client/palettes.css; caution
  stays amber (--caution) in all of them.
- Units (render/pixelSprites.ts): original pixel sprites drawn from rectangles in code, one density, a 1px dark
  outline and a two-tone owner ramp. Far: a small solid marker per unit and fleet markers with a count. Near (zoom 3
  and up): the full sprite for warships, transports, tank divisions, planes and missiles.
- Buildings: a calm category plate with a white glyph and a thin owner band under it; the name appears close up.

## Motion

Motion answers an action and nothing else: a drawer opens, a toast slides in, a pressed button scales to 0.96.
No idle pulses or bounces. `prefers-reduced-motion` turns movement off.

## The rules that keep it clean

1. **One amber thing per view.** Amber is the primary action (Play, Start game, Build) and the current value.
   Selection is a light neutral fill, headings are plain text, state colours are semantic only.
2. **No chrome, only space.** No borders, corner brackets, stripes, grain or gradient washes on panels. Cards in the
   research tree differ by fill, not by outline style.
3. **Icon plus word, numbers with units.** Every primary control names itself; every number says what it counts
   (k troops, gold/s, 30 s). No hotkey chips and no hint that only names a key.
4. **The map is the picture.** Calm water, pale tribes, mixed-case names on a soft halo, and units that collapse to
   markers when zoomed out.
