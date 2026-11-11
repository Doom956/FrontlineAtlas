# UI direction: Pixel Ops

A field console for a continent-sized war. The map is the star: quiet olive-slate water, real terrain on free land,
calm nation colours with crisp borders, and nation names set in a pixel face. The HUD is flat gunmetal with hard
1 px edges and square corners. One signal-orange fill marks the one primary action on a screen. Crisp pixel sprites
for ships, tanks, planes and missiles appear only when you zoom in; far out every unit is a small flat marker.

## Palette

The interface is olive-neutral so the world keeps the colour. Tokens live on `:root` in `src/client/styles.css`.
Contrast was measured (WCAG 2 relative luminance) on the two surfaces text actually sits on.

| Token | Hex | Role | On `--metal` #171b14 | On `--metal-2` #20261c |
|---|---|---|---|---|
| `--ink` | `#0e110c` | page, behind the map | | |
| `--metal` | `#171b14` | panel surface | | |
| `--metal-2` | `#20261c` | buttons, insets | | |
| `--metal-3` | `#2a3123` | hover, your own row | | |
| `--rule` | `#39412f` | 1 px panel edge, dividers | 1.64 (decorative) | |
| `--rule-hi` | `#636d4d` | control edges | 3.18 (passes 1.4.11) | 2.82 |
| `--text` | `#e9e6d6` | body, labels | 13.92 | 12.36 |
| `--dim` | `#a9ab96` | secondary lines | 7.44 | 6.60 |
| `--faint` | `#9a9d89` | captions, ranks | 6.28 | 5.58 |
| `--accent` | `#e8803a` | the primary action, the current tab | 6.30 | 5.59 |
| `--accent-ink` | `#1a0c03` | text on an orange fill | 6.90 on `--accent` | |
| `--brass` (khaki) | `#b9ab6a` | chosen segment, quiet numbers | 7.56 | 6.71 |
| `--brass-ink` | `#171205` | text on a khaki fill | 8.08 on `--brass` | |
| `--olive` | `#8ba84e` | good news only | 6.49 | 5.76 |
| `--signal` | `#ee7a62` | danger only | 6.31 | 5.60 |
| `--steel` | `#7d9fbf` | information only | 6.30 | 5.59 |

All text pairs pass AA 4.5:1. `--faint` (was `#8a8d7a`, 3.95 on `--metal-3`) and `--signal` (was `#e0604a`, 4.38 on
`--metal-2`) were lightened to pass; `--rule-hi` (was `#525c40`, 2.46) now gives control edges 3:1 on panels.

Map: water `#16242a` deep to `#1f3138` shallow, with no bright coast halo. Free and tribal land shows the real
terrain, lightly calmed. Nations are a calm OKLCH version of their colour (lightness pulled toward 0.68, chroma x0.88,
58 % over a greyed copy of the terrain) with a darker border of the same hue. Tribes are a thin 42 % wash over real
terrain, so nations are the only flat colour on the map. Close in, the tint thins and the terrain comes back.

## Type

Two faces, both bundled offline (`@fontsource`, loaded in `src/client/fonts.ts`).

- **Pixelify Sans** 500/600 (`--f-pixel`): the logo, nation names on the map, and the big changing numbers (troops,
  gold, attack %, the clock). Never for sentences or small labels.
- **IBM Plex Sans** 400/500/600 (`--f-ui`): everything else, including building names on the map. Tabular numbers on.

Scale (px): 11 caption, 12 small and dense bars, 13 body, 14 list titles and section names, 18 panel titles, 22 big
HUD numbers, 38 logo. Sentence case everywhere. No letter-spaced uppercase labels; nation names on the map are the one
place caps are tracked, because they are place names.

## Space, radius, edges, elevation

- Spacing steps 4 / 8 / 12 / 16 / 24 (`--s1` to `--s5`); the gap between groups is twice the gap inside one.
- Radius 0 everywhere: panels, buttons, map markers and sprites have hard pixel corners.
- Edges: one flat 1 px `--rule` per panel; controls add a 1 px `--rule-hi`. No side stripes, no double rings.
- Elevation: one hard offset drop `2px 2px 0 rgba(0,0,0,.45)` (`--drop`) for floating cards. No blur, no glow.
- Selection: a 2 px khaki or orange edge, never a glow.

## Icons and map art

- Controls: 24 px line icons, always with a word under or beside them (top bar, command bar, strikes).
- World things (buildings, deposits): flat filled silhouettes, the same shape in the build bar and on the map.
- Building markers: square plates in the category colour with a white silhouette and a thin owner frame; close in,
  the name sits under it in Plex 600 12 px.
- Units (`render/pixelSprites.ts`): original sprites drawn as rectangle lists in code, 1 px dark outline, gunmetal
  hulls with an owner-colour band (ships) or owner-colour bodies (tanks, planes, missiles), nearest-neighbour scaled,
  heading snapped to 16 steps. Below 15 px long a unit is a flat marker instead: ships a short bar, divisions a
  square, aircraft a dart, missiles a hot point. Far out a fleet stays one marker with a count (`render/fleets.ts`).
- The same sprite is the unit's portrait on the unit card and in the Forces list.

## Motion

Only in answer to something: a drawer opens, a toast drops in once (120 ms), an order confirms. No idle pulsing, no
shimmer, no animated bars. Everything is cut to 1 ms under `prefers-reduced-motion: reduce`.

## The rules that keep it clean

1. **Colour belongs to the world.** The HUD is olive-neutral; orange is spent on one primary action per screen, red
   only means danger, olive only good news.
2. **Every control says what it is.** Icon plus a plain word, numbers carry units (troops/s, gold/s, s), disabled
   things say why. No hotkey chips; keys live in tooltips.
3. **One edge, one corner, one drop.** 1 px rule, radius 0, one hard shadow. No brackets, grain, scanlines, stripes
   or cards inside cards.
4. **Far is calm, near is rich.** Far zoom shows names, borders and simple markers. Pixel detail only close in.
