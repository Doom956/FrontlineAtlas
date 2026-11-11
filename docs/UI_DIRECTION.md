# UI Direction: Pixel Ops

Original pixel-art, military field kit. The map is the star: a muted olive theatre where
land, borders and nation names read calmly at any zoom, and crisp pixel units and building
markers reward zooming in. The HUD is a flat gunmetal field console: hard 1 px edges, one
orange accent for the primary action and the current selection, numbers and titles in a
pixel display face, everything else in a clean sans with plain words.

No glow, no texture, no decorative brackets, no icon-only controls, no hotkey chips on the
HUD. One accent, one pixel face, one spacing step.

## Palette

Chrome is desaturated olive gunmetal so the map's colours stay the loudest thing on screen.

| Token | Hex | Use | Notes |
|---|---|---|---|
| `--ink` | `#0e110c` | page / behind map | olive-black |
| `--metal` | `#171b14` | panel base | flat, no grain |
| `--metal-2` | `#20261c` | buttons, insets | |
| `--metal-3` | `#2a3123` | raised / hover | |
| `--rule` | `#39412f` | hard 1 px edges | olive steel |
| `--rule-hi` | `#525c40` | button edges, dividers | |
| `--text` | `#e9e6d6` | body | bone, 11.8:1 on `--metal` |
| `--dim` | `#a7a994` | secondary | 5.4:1 on `--metal` |
| `--faint` | `#76796a` | captions | 3.0:1, labels only |
| `--accent` | `#e8803a` | PRIMARY action + selection | signal orange, 5.6:1 on `--metal` |
| `--accent-hi` | `#f59a52` | accent hover/active | |
| `--brass` (khaki) | `#b9ab6a` | titles, numbers, quiet marks | demoted from "everywhere" to quiet |
| `--good` | `#8ba84e` | good news only | olive |
| `--signal` | `#d6513a` | danger only | red |
| `--steel` | `#6f93b4` | info only | blue |

Rule: saturation belongs to the world (terrain, nation colours, unit team bands). The UI
palette is olive-neutral. Orange is spent on exactly one thing per screen: the main action,
and the selected item. Red means danger, olive means good; nothing else is coloured.

## Type

Two families. A pixel display face for identity, titles and changing numbers; a clean sans
for everything a sentence is made of.

- **Silkscreen** (`--f-pixel`, 400/700): logo, panel titles, big HUD numbers (troops, gold,
  score, clock), map place-name plates. Used only at fixed sizes so the pixels stay crisp.
- **Space Grotesk** (`--f-ui`, 400/500/600): body, labels, buttons, tooltips, lists, and all
  dynamic text (unit counts, names) where length varies. Tabular numerals on.

Scale (desktop): 11 / 12 / 13 (body) / 15 / 18 / 22 / 30. No fractional sizes. Phone inputs
16 px. Labels are sentence case; uppercase is kept for one thing only, the short tracked
eyebrow (`.wr-sec`), and buttons are no longer uppercase.

## Space, radius, edges, elevation

- Spacing: 4 / 8 / 12 / 16 / 24 only (`--s1`..`--s4`, `--s5`).
- Radius: **0**. Hard pixel corners everywhere. (`--r: 0`.)
- Edges: a single flat 1 px `--rule`. Buttons add a 1 px `--rule-hi`.
- Elevation: no blur shadows, no insets. A floating panel gets one hard offset drop
  `2px 2px 0 rgba(0,0,0,.45)` so it reads as a chip, not a glowing card.
- Selection/primary: a 2 px `--accent` edge, never a glow ring.

## Icons and map art

- One icon language: flat silhouettes. Building markers are hard square plates (category
  colour) with a white silhouette and a thin owner band; no rounded "app icon" plates, no
  progress halos replaced by a flat fill bar.
- Units are original pixel sprites (`render/pixelSprites.ts`): small limited-palette grids
  (hull, barrel, wings, fins, flame) with a 1 px dark outline and a team-colour band so the
  owner reads without tinting the whole sprite. Nearest-neighbour, integer scaled, snapped to
  device pixels. Far zoom keeps simple markers and fleet counts; the sprite is the near-zoom
  reward.

## Motion

Only in answer to an action: a panel opens, an order confirms, a toast slides in once. No
idle pulsing, no bouncing arrow, no animated life bars. One attention cue at a time.

## What was removed, and why (vs the scout's "tells")

1. **The grain / scanline texture** on 13 shared panels, the **decorative brass corner
   brackets**, and the **stock `0 6px 18px` glow shadow**: deleted. Flat gunmetal, hard
   edges, one hard drop. This alone unifies the "every box is its own tactical card" look.
2. **Brass everywhere (235 uses) so nothing was primary**: brass is demoted to a quiet khaki
   for titles and numbers; a single orange `--accent` now marks the one primary action and
   the current selection. Red and olive are kept strictly for danger and good news.
3. **Uppercase + letter-spacing on everything**: buttons are sentence case; tracked caps
   survive only as the one short eyebrow. Helper paragraphs under every control are trimmed to
   one line.
4. **Hotkey chips baked into the HUD** (build cards, quick-bar digits, tab chips, "ESC
   clears"): hidden. Every action already has a visible labelled button; keys live in the
   tooltip only, per the owner's new-player rule. (Markup and `data-test`/`kbd` nodes are
   kept; they are hidden with CSS so tests still pass.)
5. **Three border languages, double rings, fractional type scale, mismatched radii**: one
   edge, one radius (0), one five-step scale.
