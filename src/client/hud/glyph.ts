// HUD pictograms as inline SVG (crisp at any size, coloured by CSS `currentColor`).
//
// Two families, one rule: things in the world are flat filled silhouettes, controls are thin line icons.
//   - worldGlyph(): buildings and deposits use the same simplified silhouettes as the map markers (icons.ts
//     MARKER_DATA), so the build bar, tooltips and the legend show exactly the shape seen on the map; terrain and
//     abilities have their own silhouettes below in the same 64 x 64 style.
//   - lineIcon(): 24 x 24 stroke icons for buttons (pause, research, diplomacy ...).
import { MARKER_DATA, MARKER_DETAIL_PX, type MarkerId } from '../icons';

const n = (v: number): string => String(Math.round(v * 100) / 100);
function poly(...p: number[]): string {
  let s = `M${n(p[0])} ${n(p[1])}`;
  for (let i = 2; i < p.length; i += 2) s += `L${n(p[i])} ${n(p[i + 1])}`;
  return s + 'Z';
}
function circ(cx: number, cy: number, r: number): string {
  return `M${n(cx - r)} ${n(cy)}A${n(r)} ${n(r)} 0 1 0 ${n(cx + r)} ${n(cy)}A${n(r)} ${n(r)} 0 1 0 ${n(cx - r)} ${n(cy)}Z`;
}

export type TerrainGlyphId = 'plains' | 'forest' | 'hills' | 'mountains' | 'desert' | 'swamp' | 'tundra' | 'water';
export type ExtraGlyphId = TerrainGlyphId | 'paradrop' | 'barrage' | 'transportPlane' | 'capital' | 'troops';
export type WorldGlyphId = MarkerId | ExtraGlyphId;

interface GLayer {
  d: string;
  mode?: 'fill' | 'stroke' | 'cut' | 'cutStroke';
  width?: number;
  detail?: boolean;
}
const FL = (d: string, o: Partial<GLayer> = {}): GLayer => ({ d, mode: 'fill', ...o });
const ST = (d: string, width: number, o: Partial<GLayer> = {}): GLayer => ({ d, mode: 'stroke', width, ...o });
const CT = (d: string, o: Partial<GLayer> = {}): GLayer => ({ d, mode: 'cut', ...o });

/** Terrain and ability silhouettes in 64 x 64 units (same conventions as icons.ts MARKER_DATA). */
const EXTRA: Record<ExtraGlyphId, GLayer[]> = {
  // three grass tufts on a flat ground line
  plains: [
    FL('M4 50H60V55H4Z'),
    FL('M10 50L13 33L16 50ZM15 50L20 38L22 50ZM8 50L8 40L12 50Z'),
    FL('M28 50L32 28L36 50ZM34 50L40 35L41 50ZM25 50L24 37L30 50Z'),
    FL('M46 50L49 36L52 50ZM51 50L56 40L57 50ZM44 50L43 41L48 50Z'),
  ],
  // two pines
  forest: [
    FL(poly(20, 6, 34, 28, 28, 28, 37, 42, 30, 42, 38, 54, 2, 54, 10, 42, 3, 42, 12, 28, 6, 28)),
    FL('M17 54H23V60H17Z'),
    FL(poly(44, 14, 56, 32, 51, 32, 58, 44, 53, 44, 60, 54, 28, 54, 35, 44, 30, 44, 37, 32, 32, 32)),
    FL('M41 54H47V60H41Z'),
  ],
  // two rounded domes
  hills: [FL('M2 54Q14 18 34 54Z'), FL('M24 54Q42 22 62 54Z'), CT('M24 54Q29 45 33 44Q30 49 31 54Z', { detail: true })],
  // two peaks with snow caps cut out as a jagged line
  mountains: [
    FL(poly(2, 56, 24, 12, 46, 56)),
    FL(poly(26, 56, 44, 22, 62, 56)),
    CT(poly(18, 24, 24, 12, 30, 24, 27, 22, 24, 26, 21, 22)),
    CT(poly(39.5, 31, 44, 22, 48.5, 31, 46, 29.5, 44, 32, 42, 29.5)),
  ],
  // dunes and a low sun
  desert: [FL(circ(46, 18, 7)), FL('M2 54Q18 30 36 46Q46 38 62 46V54Z'), CT('M14 46Q22 40 30 44Q22 43 14 46Z', { detail: true })],
  // reeds over water lines
  swamp: [
    FL('M14 44L16 10L18 44ZM24 44L27 18L29 44ZM36 44L37 14L39 44ZM46 44L49 22L50 44Z'),
    FL('M12 14Q16 6 19 14Q16 19 12 14Z'),
    FL('M33.5 18Q37 9 41 18Q37 23 33.5 18Z'),
    ST('M4 50Q10 46 16 50T28 50T40 50T52 50T62 50', 4),
    ST('M10 58Q16 54 22 58T34 58T46 58T58 58', 4),
  ],
  // snowflake
  tundra: [
    ST('M32 6V58M9.5 19L54.5 45M9.5 45L54.5 19', 5),
    ST('M24 10L32 17L40 10M24 54L32 47L40 54', 4),
    ST('M7 29L17 26.5L13 17M57 35L47 37.5L51 47M7 35L17 37.5L13 47M57 29L47 26.5L51 17', 4, { detail: true }),
  ],
  water: [ST('M4 22Q12 15 20 22T36 22T52 22T62 20', 5), ST('M4 36Q12 29 20 36T36 36T52 36T62 34', 5), ST('M4 50Q12 43 20 50T36 50T52 50T62 48', 5)],
  // parachute canopy with a trooper
  paradrop: [
    FL('M6 28Q6 6 32 6Q58 6 58 28Q52 24 45 28Q39 24 32 28Q25 24 19 28Q12 24 6 28Z'),
    ST('M7 28L28 46M57 28L36 46M32 28V44', 2.6),
    FL(circ(32, 46, 4.5)),
    FL('M27 51H37L36 60H28Z'),
  ],
  // two shells arcing onto a burst
  barrage: [
    ST('M6 52Q16 10 40 30', 3.2),
    ST('M14 56Q26 20 46 38', 3.2),
    FL(poly(47, 30, 50, 38, 58, 36, 53, 43, 60, 48, 51, 49, 52, 58, 46, 51, 39, 56, 41, 47, 33, 45, 41, 41)),
  ],
  // cargo plane (top view, nose up) for buttons
  transportPlane: [
    FL('M28 8Q32 1 36 8V56H28Z'),
    FL(poly(4, 30, 28, 24, 36, 24, 60, 30, 60, 35, 36, 33, 28, 33, 4, 35)),
    FL(poly(20, 56, 28, 50, 36, 50, 44, 56, 44, 60, 20, 60)),
    FL('M12 26H18V36H12ZM46 26H52V36H46Z', { detail: true }),
  ],
  capital: [FL(poly(32, 4, 39.5, 23, 60, 24, 44, 37, 50, 58, 32, 46.5, 14, 58, 20, 37, 4, 24, 24.5, 23))],
  // helmet over a chevron: "troops"
  troops: [FL('M8 34Q8 10 32 10Q56 10 56 34H62V40H2V34Z'), FL(poly(14, 46, 32, 56, 50, 46, 50, 52, 32, 62, 14, 52))],
};

let maskSeq = 0;

/** A filled pictogram as an inline SVG string, `px` CSS pixels square, in currentColor. */
export function worldGlyph(id: WorldGlyphId, px = 24): string {
  const markerLayers = (MARKER_DATA as Record<string, { d: string; mode?: string; width?: number; ring?: boolean; detail?: boolean }[]>)[id];
  const layers: GLayer[] = markerLayers
    ? markerLayers.map((l) => ({ d: l.d, mode: (l.mode ?? 'fill') as GLayer['mode'], width: l.width, detail: l.detail }))
    : EXTRA[id as ExtraGlyphId] ?? [];
  const small = px * (typeof devicePixelRatio === 'number' ? devicePixelRatio : 1) < MARKER_DETAIL_PX;
  const vis = layers.filter((l) => !(small && l.detail));
  const cuts = vis.filter((l) => l.mode === 'cut' || l.mode === 'cutStroke');
  const mid = cuts.length ? `bfm${++maskSeq}` : '';
  let defs = '';
  if (mid) {
    defs =
      `<defs><mask id="${mid}" maskUnits="userSpaceOnUse" x="-8" y="-8" width="80" height="80"><rect x="-8" y="-8" width="80" height="80" fill="#fff"/>` +
      cuts
        .map((l) =>
          l.mode === 'cut'
            ? `<path d="${l.d}" fill="#000"/>`
            : `<path d="${l.d}" fill="none" stroke="#000" stroke-width="${l.width ?? 2}" stroke-linecap="round" stroke-linejoin="round"/>`,
        )
        .join('') +
      '</mask></defs>';
  }
  const body = vis
    .filter((l) => l.mode !== 'cut' && l.mode !== 'cutStroke')
    .map((l) =>
      l.mode === 'stroke'
        ? `<path d="${l.d}" fill="none" stroke="currentColor" stroke-width="${l.width ?? 2}" stroke-linecap="round" stroke-linejoin="round"/>`
        : `<path d="${l.d}" fill="currentColor"/>`,
    )
    .join('');
  const g = mid ? `<g mask="url(#${mid})">${body}</g>` : body;
  return `<svg class="gl" viewBox="0 0 64 64" width="${px}" height="${px}" aria-hidden="true" focusable="false">${defs}${g}</svg>`;
}

/** 24 x 24 line icons (stroke currentColor). */
const LINE: Record<string, string> = {
  gold: '<circle cx="12" cy="12" r="8"/><path d="M12 7.5v9M9.5 9.5h3.75a1.75 1.75 0 0 1 0 3.5h-2.5a1.75 1.75 0 0 0 0 3.5H14.5"/>',
  iron: '<path d="M3 17h18l-3-8H6zM6 9l1.5-3h9L18 9"/>',
  oil: '<path d="M12 3.5s-6 7-6 10.5a6 6 0 0 0 12 0C18 10.5 12 3.5 12 3.5z"/>',
  science: '<path d="M9 3v6l-5 9a2 2 0 0 0 1.7 3h12.6a2 2 0 0 0 1.7-3l-5-9V3M8 3h8M6.5 15h11"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7v5l3 2"/>',
  pause: '<path d="M9 5v14M15 5v14"/>',
  play: '<path d="M7 5l12 7-12 7z"/>',
  sound: '<path d="M4 9.5h3.5L12 5v14l-4.5-4.5H4zM15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11"/>',
  mute: '<path d="M4 9.5h3.5L12 5v14l-4.5-4.5H4zM16 9.5l5 5M21 9.5l-5 5"/>',
  help: '<circle cx="12" cy="12" r="8.5"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.7.3-1 .9-1 1.6v.6M12 16.8v.4"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  exit: '<path d="M10 4H5v16h5M14 8l4 4-4 4M18 12H9"/>',
  army: '<path d="M4 4l10 10M20 4L10 14M13.5 16.5l4 4M10.5 16.5l-4 4M16.5 13.5l4 4M7.5 13.5l-4 4"/>',
  diplomacy: '<path d="M3 11l4-4 3 1.5L13 6l4 3 4-1v6l-5 4-2.5-1.5L11 18l-3-2.5L6 16l-3-3z"/><path d="M10 8.5l3.5 3.5M13 10.5l3 3"/>',
  events: '<path d="M5 5h14M5 10h14M5 15h9M5 20h6"/>',
  legend: '<path d="M4 6l5-2 6 2 5-2v14l-5 2-6-2-5 2zM9 4v14M15 6v14"/>',
  map: '<rect x="3.5" y="5" width="17" height="14"/><path d="M8 9h3v3H8zM13 13h4v2.5h-4z"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  chevronDown: '<path d="M6 9l6 6 6-6"/>',
  chevronUp: '<path d="M6 15l6-6 6 6"/>',
  chevronRight: '<path d="M9 6l6 6-6 6"/>',
  target: '<circle cx="12" cy="12" r="7"/><path d="M12 2v5M12 17v5M2 12h5M17 12h5"/>',
  gift: '<path d="M4 10h16v4H4zM6 14h12v6H6zM12 10v10M12 10c-1-3-5-4-5-1.5S12 10 12 10zM12 10c1-3 5-4 5-1.5S12 10 12 10z"/>',
  embargo: '<circle cx="12" cy="12" r="8"/><path d="M6.5 17.5l11-11"/>',
  ally: '<path d="M9.5 8.5l-2-2a3 3 0 0 0-4.2 4.2l2 2M14.5 15.5l2 2a3 3 0 0 0 4.2-4.2l-2-2M8.5 15.5l7-7"/>',
  breakAlly: '<path d="M9.5 8.5l-2-2a3 3 0 0 0-4.2 4.2l2 2M14.5 15.5l2 2a3 3 0 0 0 4.2-4.2l-2-2M10 14l-2 2M14 10l2-2M5 19l2-2M19 5l-2 2"/>',
  attack: '<path d="M4 4l11 11M20 4L9 15M14 17l3 3M10 17l-3 3M17 14l3 3M7 14l-3 3"/>',
  expand: '<path d="M12 3v6M12 15v6M3 12h6M15 12h6M12 3l-2.5 2.5M12 3l2.5 2.5M12 21l-2.5-2.5M12 21l2.5-2.5M3 12l2.5-2.5M3 12l2.5 2.5M21 12l-2.5-2.5M21 12l-2.5 2.5"/>',
  build: '<path d="M14 6l4 4M5 19l8.5-8.5M12 4.5l2-1.5 6.5 6.5-1.5 2z"/>',
  upgrade: '<path d="M12 20V5M6 11l6-6 6 6M6 20h12"/>',
  transport: '<path d="M3 15h18l-2.5 4h-13zM6 15V9h9l3 6M10 9V5"/>',
  bomb: '<circle cx="11" cy="14" r="6"/><path d="M15 9.5l2.5-2.5M17 5l1-1M19.5 7l1-.5"/>',
  rocket: '<path d="M12 3c3 2 4 6 4 10l-2 3h-4l-2-3c0-4 1-8 4-10zM8 15l-3 3v2l3-1M16 15l3 3v2l-3-1M11 20h2"/>',
  atom: '<circle cx="12" cy="12" r="2"/><path d="M12 10l-3-6a8 8 0 0 1 6 0zM13.7 13l6.3 1.5a8 8 0 0 1-3 5.2zM10.3 13L4 14.5a8 8 0 0 0 3 5.2z"/>',
  accept: '<path d="M5 12.5l4.5 4.5L19 7"/>',
  decline: '<path d="M6 6l12 12M18 6L6 18"/>',
  troops: '<circle cx="12" cy="7" r="3"/><path d="M6 20c0-4 2.7-6.5 6-6.5s6 2.5 6 6.5"/>',
  retreat: '<path d="M10 6L4 12l6 6M4 12h11a5 5 0 0 1 0 10h-2"/>',
  demolish: '<path d="M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13M10.5 11v6M13.5 11v6"/>',
  info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v6M12 7.5v.5"/>',
  back: '<path d="M14.5 5.5L8 12l6.5 6.5"/>',
  warship: '<path d="M12 4v13M8 8h8M12 21c-4 0-7-3-7-6M12 21c4 0 7-3 7-6M3.5 15.5L5 14l1.5 1.5M17.5 15.5L19 14l1.5 1.5"/><circle cx="12" cy="4" r="1.2"/>',
  stop: '<rect x="6.5" y="6.5" width="11" height="11"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  up: '<path d="M12 19V5M6 11l6-6 6 6"/>',
  down: '<path d="M12 5v14M6 13l6 6 6-6"/>',
  paradrop: '<path d="M3 11a9 7 0 0 1 18 0c-1.5-1-3-1-4.5 0-1.5-1-3-1-4.5 0-1.5-1-3-1-4.5 0C6 10 4.5 10 3 11zM3.5 11l7 7M20.5 11l-7 7M12 11v7"/><rect x="10.5" y="18" width="3" height="3.5"/>',
  barrage: '<path d="M3 20c2-9 7-13 13-11M6 21c2-7 6-10 11-9"/><path d="M18 6l1.5 2.5L22 8l-1.5 2.5L22 13l-2.5-.5L18 15l-1-2.5-2.5.5 1-2.5L14 8l2.5.5z"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1"/>',
  shuffle: '<path d="M3 7h4l10 10h4M3 17h4L17 7h4M18 4l3 3-3 3M18 14l3 3-3 3"/>',
  dot: '<circle cx="12" cy="12" r="3" fill="currentColor"/>',
  copy: '<path d="M9 9h11v11H9z"/><path d="M15 9V4H4v11h5"/>',
  signal: '<path d="M4 20v-3M9 20v-7M14 20V9M19 20V5"/>',
  eye: '<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
};
export type LineIconId = keyof typeof LINE;

export function hasLineIcon(name: string): boolean {
  return name in LINE;
}

/** A line icon as an inline SVG string. */
export function lineIcon(name: string, px = 18, width = 1.75): string {
  const body = LINE[name] ?? LINE.info;
  return `<svg class="li" viewBox="0 0 24 24" width="${px}" height="${px}" fill="none" stroke="currentColor" stroke-width="${width}" stroke-linecap="square" stroke-linejoin="miter" aria-hidden="true" focusable="false">${body}</svg>`;
}

/** A span holding an icon (for DOM building). */
export function iconSpan(html: string, cls = 'ico'): HTMLSpanElement {
  const s = document.createElement('span');
  s.className = cls;
  s.innerHTML = html;
  return s;
}
