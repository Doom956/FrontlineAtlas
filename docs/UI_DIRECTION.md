# UI direction: Pixel Clean

A modern, calm interface wrapped around a crisp pixel-art world. The map is the star:
bright, friendly land on calm water, with original pixel sprites for every unit. The HUD is
the quietest layer in the game: near-black glass panels with no borders, one warm accent,
small clean type, and generous breathing room. The pixel feeling lives in the world and in a
single display face, not in the chrome.

Think "a pixel strategy game with a clean, confident app interface laid over it."

## What this direction is NOT

It is not the war-room look it replaces. We removed the devices that made the old HUD read as
generated (see "Tells removed" below): the brushed-metal grain, the brass corner brackets, the
one-border-fits-all card chrome, gold on every label, and the hotkey chips baked into the UI.

## Palette

### Chrome (HUD, menus, panels)

Neutral and near-monochrome so the map carries all the colour. One accent only.

| Token | Hex / value | Use |
|---|---|---|
| `--ink` | `#0b0d11` | app base, behind everything |
| `--panel` | `rgba(18,20,26,0.80)` | every panel (glass, backdrop-blurred) |
| `--panel-2` | `rgba(255,255,255,0.055)` | raised control inside a panel |
| `--panel-3` | `rgba(255,255,255,0.09)` | hover / pressed control |
| `--line` | `rgba(255,255,255,0.09)` | the one hairline (dividers, insets) |
| `--text` | `#edeff3` | primary text (contrast on panel ~13:1) |
| `--dim` | `#9aa0ac` | labels, secondary (contrast ~6.5:1) |
| `--faint` | `#656b77` | de-emphasised, disabled hints (~3.4:1) |
| `--accent` | `#f5b13d` | primary action, current selection, current value |
| `--accent-hi` | `#ffc658` | accent hover / highlight |
| `--accent-ink` | `#1a1304` | text on an accent fill (contrast ~10:1) |
| `--danger` | `#f2543d` | losses, under attack, destructive actions |
| `--good` | `#74c365` | positive events, affordable, allied |
| `--info` | `#7fa6d6` | neutral status (steel) |

Rules: `--accent` is the only saturated UI colour and appears at most once per view as the
primary thing. `--danger` / `--good` / `--info` are semantic only (never decoration). Everything
else is a step on the neutral ramp.

### Map (brighter, friendlier)

Tuned in `render/palette.ts`. Water moves from near-navy to a lighter, calmer blue so land reads
as the figure and sea as the ground. Terrain is lifted out of the muddy khaki range into fresher
greens and warmer tans; mountains are a warm neutral grey. Nation colours keep their hues but are
evened in lightness/saturation so no single nation shouts. A thin dark outline on every sprite and
a soft halo on every label keep things readable on any territory colour. The decorative coast glow
is reduced to a quiet shoreline, not a bloom.

## Type

Two families, clearly distinct.

- **Pixelify Sans** — the display + "pixel game" identity. Logo, the clock, and the big changing
  numbers (troops, gold, attack) only. Legible pixel letterforms, kept at whole pixel sizes.
- **DM Sans** — everything else: labels, body, controls, values. Clean, friendly, excellent at
  small sizes. `font-variant-numeric: tabular-nums` on all changing values.

Map canvas labels use DM Sans (names) and DM Sans tabular (numbers).

Type scale (whole numbers only, ~6 sizes):

| px | role |
|---|---|
| 11 | micro label (one tracked-caps kind only: section eyebrows) |
| 12 | small / secondary |
| 13 | body, control text (14px on phone inputs) |
| 16 | section heading |
| 20 | panel title |
| 26–28 | big number / logo (Pixelify Sans) |

One kind of uppercase: short section eyebrows at 11px, `letter-spacing: 0.08em`. Headings and
body are sentence case. No `WORD — fragment`, no middle-dot meta strings, no gold on labels.

## Spacing, radius, elevation

- Spacing scale: `4 / 8 / 12 / 16 / 24 / 32`. Panels pad `16`; tight controls `8`.
- Radius: `--r` 10px (panels), `--r-sm` 6px (controls), `--r-xs` 4px (chips/swatches). One set.
- Elevation: no borders. A panel is glass (`--panel` + `backdrop-filter: blur(14px)`) with one
  soft shadow `0 10px 30px rgba(0,0,0,0.38)` and a 1px top inset highlight. Separation between
  elements is space and, where needed, a single `--line` hairline. The sharp pixel world and the
  soft rounded chrome are a deliberate contrast.

## Icons

Cluster and bar controls use the existing single-weight line icons, kept monochrome (they tint to
`--accent` only when active). Map unit art is original pixel sprites (see `render/pixelSprites.ts`)
sharing one density, a 1px dark outline, and a 2-tone owner ramp. Building markers are flattened:
a calm category plate, a white glyph, a thin owner band instead of a heavy ring, a small level pip.
Primary controls are never icon-only: an icon plus a plain word.

## Motion

Motion only answers an action: a panel fades/rises as it opens, a toast slides in, a value ticks.
No idle pulsing or bouncing (the guide arrow bounce, the ring pulses, the per-card hover lift are
gone). One attention cue at a time. `prefers-reduced-motion` disables all of it.

## The rules that keep it clean (and the tells they remove)

1. **One panel chrome, borderless.** The shared `--grain` texture and the `border + corner
   brackets` are deleted. Panels are glass separated by space. Removes tells: "every element its
   own box with the same chrome", "decorative corner brackets", "scanline grain on every panel".
2. **One accent.** Amber is the only saturated UI colour, used for the single primary action, the
   current selection, and the current value. Section headings and chrome go neutral. Removes "brass
   for everything, so nothing is primary" and "three border languages in one panel" (state is now
   fill/opacity, not border style).
3. **No hotkeys in the UI.** Every key chip (`kbd`, `.qb-k`, `.bm-c-k`, `.rp-tab-k`, the "Tab" on
   Build, "(T)" in tooltips) is hidden; every action keeps its visible labelled button. Removes
   "hotkeys baked into the visible UI" and fits the owner's "no reliance on hotkeys" rule.
4. **Less furniture.** Eyebrow labels above headings, tag/badge clutter ("NEXT", "SUITS YOU",
   "UNIT", "TIP"), and card-in-card framing are cut to the one case that carries real meaning.
   Fractional type sizes and the scattered radius/spacing values collapse to the scales above.
   Removes "eyebrow labels", "tag and badge clutter", "card inside card", "fractional type scale",
   "radius and spacing are not a system".
5. **Plain words, obvious state.** Primary controls read icon + word. Enabled / disabled / selected
   / can't-afford look different and say why in plain language. Nothing a new player needs is behind
   a hover or a key.
</content>
</invoke>
