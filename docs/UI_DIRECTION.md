# UI direction 4: Paper Atlas

A printed atlas on the table: the map is the page, the HUD is a few paper slips laid on it. Ink type, thin ink
rules, one stamp red for the single action that matters on each screen. Light theme, high contrast (WCAG AA).
Tokens live in `src/client/paper.css` (loaded last; it keeps the old token names, so `--metal` is paper and
`--brass` is the stamp red). Map colours live in `src/client/render/terrain.ts` and `render/palette.ts`.

## Palette

| Token | Hex | Role |
| --- | --- | --- |
| `--metal` paper | `#f7f2e7` | every HUD slip, drawer, menu sheet |
| `--metal-2` paper 2 | `#efe8d9` | hover, quiet wells |
| `--metal-3` paper well | `#e5ddcb` | owned techs, pressed |
| `--rule` | `#d5cab3` | separators only (decorative) |
| `--rule-hi` | `#8a7f6a` | control borders (3.5:1 on paper, passes 1.4.11) |
| `--text` ink | `#1d1b18` | text, chosen options (ink fill), your border on the map |
| `--dim` | `#4f4a42` | secondary text |
| `--faint` | `#625b4f` | captions, tier labels |
| `--brass` stamp red | `#b2382a` | the one primary action: Play, Start game, Build, Next tech |
| `--brass-hi` red ink | `#a3301f` | red text: threats, "Next", short of gold |
| `--olive` | `#3f6326` | done, owned, gains |
| `--steel` | `#2f5d80` | in progress, focus ring |

Measured contrast (WCAG 2 ratio, text needs 4.5:1):

| Pair | Ratio |
| --- | --- |
| ink on paper | 15.39 |
| ink on paper well | 12.71 |
| dim on paper | 7.87 |
| dim on paper well | 6.50 |
| faint on paper | 6.01 |
| faint on paper well | 4.97 |
| paper on stamp red (button label) | 5.78 |
| red ink on paper | 6.27 |
| olive on paper | 6.22 |
| steel on paper | 6.27 |
| paper on ink (chosen option) | 15.39 |
| ink on sea `#92b0bc` (map labels) | 7.49 |

Map: paper land by terrain (plains `#eae3cb`, forest sage `#c8d2ac`, hills ochre `#dfcfa8`, mountains warm grey
`#ccc0ae` with ink hachures, desert sand `#f2e5bd`, swamp `#ccd2ba`, tundra `#f0f1ec`), sea `#92b0bc` (a little grey, so a pastel blue nation never reads as sea) to
`#a2bec7` near the coast with up to three thin coast lines, one ink coastline at every zoom. Nations: their own
hue, chroma cut to 66% (yours 78%), lightness pulled to 0.8, laid at 55% over a warm paper copy of the terrain,
bordered in a darker shade of the same hue; your border is ink. Tribes: near paper (30% wash), a light pencil
border, so a coast full of tribes stays quiet.

## Type

- Titles, numbers and place names: Source Serif 4 (400, 400 italic, 600; `@fontsource/source-serif-4`).
- Body and controls: IBM Plex Sans (400, 500, 600; `@fontsource/ibm-plex-sans`).
- Scale (px): 54 logo, 24 sheet title, 23 HUD readout numbers, 19 section heading (serif italic), 18 tagline and
  tree pillar names (serif italic), 15 card names and Build, 13 body and buttons, 12 captions and button words.
  Nothing under 12px in the HUD.
- Sentence case everywhere. No letter-spaced caps in the HUD. Nation names on the map are the one exception: small
  serif caps with wide tracking, the classic atlas country label.
- Changing numbers use `tabular-nums` (standings, timers, prices, speed).

## Spacing, radii, borders, elevation

- 4px grid: 4, 8, 12, 16, 24. Groups are made by space first, then a paper wash, a rule last.
- Radii: 4px controls, 6px slips and cards, 8px a choice wash in the tree. No pills except count badges.
- Borders: 1px ink-brown `--rule-hi` on controls; separators are `--rule` hairlines; no boxed panels inside panels.
- Elevation: two shadows only. `--lift` (slips on the map) and `--lift-hi` (drawers, menus, dialogs), both warm
  brown at 10 to 20% alpha. No glow, no grain, no scanlines, no corner brackets.
- The main menu sheet ends in a 4px double ink rule: the neatline of a printed map.

## Icons and map symbols

- HUD: one line icon set (`hud/glyph.ts`), 17px, stroke follows the text, always beside a plain word.
- Buildings: a round stamped seal (ink disc, paper picture) inside a ring of the owner's colour, name in serif
  italic under it from zoom 8. Far out only towns (paper dot in an ink ring) and forts (small ink squares).
- Units: engraved symbols. Far (zoom under 6): small line glyphs, ships merge into fleet markers with a count
  (`render/fleets.ts`), never clutter. Near (zoom 6 and in): `GLYPHS_NEAR` in `render/unitGlyphs.ts`, warships with
  turrets and barrels, tank divisions with tracks and turret, bombers with four engines, fighters, rockets and atom
  bombs, transports, trade ships; tinted body, ink outline, paper halo.

## Motion

- Feedback only: 150ms ease-out on hover and press colours, drawer slide, toast drop. Tech fold arrow rotates in
  150ms. Nothing loops in the HUD; map effects (capture flash, strike rings) stay as they were.
- Everything moving honours `prefers-reduced-motion` (existing guards in styles.css and menu.css).

## The rules that keep it clean

1. Red means "do this". One red filled control per screen; a chosen option is ink, not red; red text only for
   threats and shortfalls.
2. Every primary control is an icon plus a plain word (top bar, command bar, strikes); numbers carry their unit;
   hotkeys live in How to play, never on a button.
3. Paper slips, not boxes: one surface level on the map, no card inside a card, no stripes, no eyebrows. Group with
   space and a paper wash.
4. The map is quiet: paper land, muted tints, ink lines. Detail appears only when you zoom in.
