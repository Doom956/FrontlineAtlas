// Pixel HUD icons: small original pictures on an integer pixel grid, one grid cell per CSS pixel, so they stay crisp
// and match the pixel face of the map and the units. Output is an inline SVG of square runs in currentColor
// (shape-rendering crispEdges), so CSS still colours them: each icon takes the muted hue of its category
// (navy, armor, air, buildings and economy, research, strikes; see .pi-* in styles.css).
//
// Two sources, both drawn in code:
//   - hand-made icons below, built from pixels, lines and boxes on a 16 x 16 (or 12 x 12) grid;
//   - building and strike pictures traced from the existing vector art (icons.ts) at the exact size they show at,
//     one cell per pixel, hard edged (no anti-aliasing). Without a canvas (tests) they fall back to the vector art.
// Two tones: '#' full colour, '+' the same colour at half strength for the shaded side.
import { MARKER_DETAIL_PX } from '../icons';
import { glyphLayers, lineIcon, worldGlyph, type WorldGlyphId } from './glyph';

/** The icon colour families (one muted hue each; never the accent). */
export type IconCat = 'navy' | 'armor' | 'air' | 'econ' | 'science' | 'strike';

class Grid {
  readonly c: Uint8Array;
  constructor(readonly n: number) {
    this.c = new Uint8Array(n * n);
  }
  /** Sets a cell; a full cell is never downgraded to a shaded one. */
  px(x: number, y: number, t = 1): void {
    if (x < 0 || y < 0 || x >= this.n || y >= this.n) return;
    const i = y * this.n + x;
    if (this.c[i] === 1 && t === 2) return;
    this.c[i] = t;
  }
  rect(x: number, y: number, w: number, h: number, t = 1): void {
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) this.px(x + i, y + j, t);
  }
  /** A one-pixel Bresenham line. */
  line(x0: number, y0: number, x1: number, y1: number, t = 1): void {
    const dx = Math.abs(x1 - x0);
    const dy = -Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1;
    const sy = y0 < y1 ? 1 : -1;
    let err = dx + dy;
    for (;;) {
      this.px(x0, y0, t);
      if (x0 === x1 && y0 === y1) break;
      const e2 = 2 * err;
      if (e2 >= dy) {
        err += dy;
        x0 += sx;
      }
      if (e2 <= dx) {
        err += dx;
        y0 += sy;
      }
    }
  }
  /** Fills the empty cells between the first and last set cell of row y. */
  fillRow(y: number, t = 2): void {
    let a = -1;
    let b = -1;
    for (let x = 0; x < this.n; x++) {
      if (this.c[y * this.n + x]) {
        if (a < 0) a = x;
        b = x;
      }
    }
    for (let x = a + 1; x < b; x++) if (!this.c[y * this.n + x]) this.px(x, y, t);
  }
  /** Rows of '.', '#' and '+' starting at (x, y). */
  art(x: number, y: number, rows: string[]): void {
    rows.forEach((r, j) => {
      for (let i = 0; i < r.length; i++) {
        if (r[i] === '#') this.px(x + i, y + j, 1);
        else if (r[i] === '+') this.px(x + i, y + j, 2);
      }
    });
  }
  /** A ring of radius r round the grid centre (n / 2, n / 2). */
  ring(r: number, t = 1): void {
    const m = this.n / 2;
    for (let y = 0; y < this.n; y++)
      for (let x = 0; x < this.n; x++) {
        const d = Math.hypot(x + 0.5 - m, y + 0.5 - m);
        if (d <= r && d > r - 1.15) this.px(x, y, t);
      }
  }
}

interface Hand {
  n: number;
  draw: (g: Grid) => void;
}

const QUESTION = ['.####.', '##..##', '....##', '...##.', '..##..', '..##..', '......', '..##..'];

/** Hand-made icons. 16 x 16 for the top bar, 12 x 12 for the small resource chips. */
const HAND: Record<string, Hand> = {
  // crossed swords: each blade a lit edge and a shaded edge, a guard and a grip
  army: {
    n: 16,
    draw: (g) =>
      g.art(0, 0, [
        '##............##',
        '#+#..........#+#',
        '.#+#........#+#.',
        '..#+#......#+#..',
        '...#+#....#+#...',
        '....#+#..#+#....',
        '.....#+##+#.....',
        '......####......',
        '......#++#......',
        '.....#+#.##.....',
        '..#.#+#..#+#.#..',
        '..###+....#+##..',
        '...##......###..',
        '..####....####..',
        '.##..........##.',
        '.#............#.',
      ]),
  },
  // a warship side on: mast, bridge, deck house, guns fore and aft, a tapering hull and a waterline
  warship: {
    n: 16,
    draw: (g) => {
      g.line(8, 1, 8, 4);
      g.px(9, 1);
      g.rect(6, 4, 4, 2);
      g.rect(4, 6, 8, 2);
      g.line(12, 6, 15, 6);
      g.line(0, 7, 3, 7, 2);
      g.rect(1, 8, 14, 1);
      g.rect(2, 9, 12, 1);
      g.rect(3, 10, 10, 1, 2);
      g.rect(1, 12, 3, 1, 2);
      g.rect(6, 12, 4, 1, 2);
      g.rect(12, 12, 3, 1, 2);
    },
  },
  // a flask with liquid in the bottom
  science: {
    n: 16,
    draw: (g) => {
      g.rect(5, 1, 6, 1);
      g.line(6, 2, 6, 5);
      g.line(9, 2, 9, 5);
      g.line(6, 6, 2, 12);
      g.line(9, 6, 13, 12);
      g.rect(2, 13, 12, 1);
      for (let y = 9; y <= 12; y++) g.fillRow(y);
      g.px(7, 8, 2);
    },
  },
  // a field manual: cover, spine, two lines of text
  doctrine: {
    n: 16,
    draw: (g) => {
      g.rect(3, 1, 10, 1);
      g.rect(3, 14, 10, 1);
      g.line(3, 1, 3, 14);
      g.line(12, 1, 12, 14);
      g.line(5, 1, 5, 14);
      g.line(4, 2, 4, 13, 2);
      g.line(7, 4, 10, 4, 2);
      g.line(7, 6, 10, 6, 2);
      g.rect(9, 9, 2, 5);
    },
  },
  // two hands clasped between two cuffs
  diplomacy: {
    n: 16,
    draw: (g) =>
      g.art(0, 3, [
        '++#..........#++',
        '++#..####....#++',
        '++#.#....##..#++',
        '++##..##...#.#++',
        '++#..#..#...##++',
        '++#.#..#..#..#++',
        '++##..#..#..##++',
        '.....#..#.###...',
        '......####......',
      ]),
  },
  // a list of events: a dot and a line each
  events: {
    n: 16,
    draw: (g) => {
      for (const y of [2, 7, 12]) {
        g.rect(1, y, 2, 2);
        g.line(5, y, 14, y);
        g.line(5, y + 1, 11, y + 1, 2);
      }
    },
  },
  bell: {
    n: 16,
    draw: (g) => {
      g.rect(7, 0, 2, 1);
      g.rect(6, 1, 4, 1);
      g.art(0, 2, [
        '.....#....#.....',
        '....#......#....',
        '....#......#....',
        '...#........#...',
        '...#........#...',
        '...#........#...',
        '..#..........#..',
        '..#..........#..',
        '.##############.',
      ]);
      for (let y = 2; y <= 9; y++) g.fillRow(y);
      g.rect(6, 12, 4, 1);
      g.rect(7, 13, 2, 1);
    },
  },
  // a folded map, its middle panel shaded
  legend: {
    n: 16,
    draw: (g) => {
      g.line(1, 3, 5, 1);
      g.line(5, 1, 10, 3);
      g.line(10, 3, 14, 1);
      g.line(1, 13, 5, 11);
      g.line(5, 11, 10, 13);
      g.line(10, 13, 14, 11);
      g.line(1, 3, 1, 13);
      g.line(5, 1, 5, 11);
      g.line(10, 3, 10, 13);
      g.line(14, 1, 14, 11);
      for (let y = 2; y <= 12; y++) for (let x = 6; x <= 9; x++) g.px(x, y, 2);
    },
  },
  pause: {
    n: 16,
    draw: (g) => {
      g.rect(4, 3, 3, 10);
      g.rect(9, 3, 3, 10);
    },
  },
  play: {
    n: 16,
    draw: (g) => {
      for (let i = 0; i <= 10; i++) g.rect(5, 3 + i, 1 + Math.min(i, 10 - i), 1);
    },
  },
  sound: {
    n: 16,
    draw: (g) => {
      g.rect(1, 6, 3, 4);
      for (let i = 0; i < 4; i++) g.line(4 + i, 5 - i, 4 + i, 10 + i);
      g.line(10, 6, 10, 9);
      g.px(9, 5);
      g.px(9, 10);
      g.line(13, 4, 13, 11);
      g.px(12, 3);
      g.px(12, 12);
      g.px(11, 2);
      g.px(11, 13);
    },
  },
  mute: {
    n: 16,
    draw: (g) => {
      g.rect(1, 6, 3, 4);
      for (let i = 0; i < 4; i++) g.line(4 + i, 5 - i, 4 + i, 10 + i);
      g.line(10, 5, 14, 9);
      g.line(14, 5, 10, 9);
    },
  },
  help: {
    n: 16,
    draw: (g) => {
      g.ring(7.6);
      g.art(5, 4, QUESTION);
    },
  },
  menu: {
    n: 16,
    draw: (g) => {
      for (const y of [3, 7, 11]) {
        g.rect(2, y, 12, 1);
        g.rect(2, y + 1, 12, 1, 2);
      }
    },
  },
  // a hammer: head with its underside shaded, a shaft lit on one side
  build: {
    n: 16,
    draw: (g) => {
      g.rect(3, 2, 10, 2);
      g.rect(3, 4, 10, 1, 2);
      g.px(13, 3);
      g.px(14, 4);
      g.rect(7, 5, 1, 9);
      g.rect(8, 5, 1, 9, 2);
      g.rect(6, 12, 4, 2);
    },
  },
  // 12 x 12 resource chips: an ingot, a drop, a flask
  iron: {
    n: 12,
    draw: (g) => {
      g.rect(3, 3, 6, 1, 2);
      g.rect(2, 4, 8, 1, 2);
      g.rect(1, 5, 10, 4);
      g.line(1, 9, 10, 9, 2);
    },
  },
  oil: {
    n: 12,
    draw: (g) =>
      g.art(0, 1, [
        '.....##.....',
        '.....##.....',
        '....###+....',
        '....###+....',
        '...####++...',
        '..#####+++..',
        '..#####+++..',
        '..#####+++..',
        '...####++...',
        '....###+....',
      ]),
  },
  'science-s': {
    n: 12,
    draw: (g) => {
      g.rect(3, 1, 6, 1);
      g.line(4, 2, 4, 4);
      g.line(7, 2, 7, 4);
      g.line(4, 5, 1, 9);
      g.line(7, 5, 10, 9);
      g.rect(1, 10, 10, 1);
      for (let y = 7; y <= 9; y++) g.fillRow(y);
    },
  },
};

/** Square runs of each tone as SVG paths. */
function toSvg(g: Grid, k: number): string {
  const n = g.n;
  const d: [string, string] = ['', ''];
  for (let y = 0; y < n; y++) {
    let x = 0;
    while (x < n) {
      const t = g.c[y * n + x];
      if (!t) {
        x++;
        continue;
      }
      let e = x + 1;
      while (e < n && g.c[y * n + e] === t) e++;
      d[t - 1] += `M${x} ${y}h${e - x}v1h${x - e}z`;
      x = e;
    }
  }
  const body = (d[0] ? `<path d="${d[0]}" fill="currentColor"/>` : '') + (d[1] ? `<path d="${d[1]}" fill="currentColor" opacity=".5"/>` : '');
  return `<svg class="pi" viewBox="0 0 ${n} ${n}" width="${n * k}" height="${n * k}" shape-rendering="crispEdges" aria-hidden="true" focusable="false">${body}</svg>`;
}

const cache = new Map<string, string>();

/** True when `name` has a hand-made pixel icon. */
export function hasPixelIcon(name: string): boolean {
  return name in HAND;
}

/**
 * A hand-made pixel icon at a whole multiple of its grid (16 for the top bar, 12 for chips), or the line icon when
 * there is no pixel one yet. `px` is the size it replaces; the grid is drawn at the nearest whole scale.
 */
export function pixelIcon(name: string, px = 16): string {
  const small = px <= 13 && `${name}-s` in HAND ? `${name}-s` : name;
  const h = HAND[small];
  if (!h) return lineIcon(name, px);
  const k = Math.max(1, Math.round(px / h.n));
  const key = `${small}|${k}`;
  let s = cache.get(key);
  if (!s) {
    const g = new Grid(h.n);
    h.draw(g);
    s = toSvg(g, k);
    cache.set(key, s);
  }
  return s;
}

/** A canvas of n x n, or null (no DOM canvas, as in tests). */
function scratch(n: number): CanvasRenderingContext2D | null {
  if (typeof document === 'undefined') return null;
  try {
    const c = document.createElement('canvas');
    c.width = n;
    c.height = n;
    return c.getContext('2d', { willReadFrequently: true });
  } catch {
    return null;
  }
}

/** Hard-edged cells from a canvas: a cell is set where at least half of it is covered. */
function threshold(ctx: CanvasRenderingContext2D, n: number): Grid {
  const g = new Grid(n);
  const a = ctx.getImageData(0, 0, n, n).data;
  for (let i = 0; i < n * n; i++) if (a[i * 4 + 3] >= 128) g.c[i] = 1;
  return g;
}

/** Extra silhouettes for the strike buttons, in the same 64 x 64 units as glyph.ts (nose up). */
const STRIKE_ART: Record<string, { d: string; mode?: string; width?: number }[]> = {
  // swept-wing bomber, top view
  bomber: [
    { d: 'M28.5 6Q32 -1 35.5 6V56H28.5Z' },
    { d: 'M2 36L28.5 18H35.5L62 36V42L35.5 31H28.5L2 42Z' },
    { d: 'M19 58L28.5 50H35.5L45 58V63H19Z' },
  ],
  // missile, nose up, with fins and a flame
  rocket: [
    { d: 'M25 16Q32 -2 39 16V47H25Z' },
    { d: 'M25 30L13 46V54L25 47ZM39 30L51 46V54L39 47Z' },
    { d: 'M27 50H37L32 63Z' },
  ],
  // fat bomb with a boxed tail
  atomBomb: [
    { d: 'M14 32Q14 13 36 13Q61 13 61 32Q61 51 36 51Q14 51 14 32Z' },
    { d: 'M2 18H12V46H2ZM10 28H17V36H10Z' },
    { d: 'M43 13H47V51H43Z', mode: 'cut' },
  ],
};

/** Which picture each strike button traces. */
const STRIKE_SRC: Record<string, string> = { artillery: 'barrage', transportPlane: 'paradrop' };

/** Traces 64 x 64 vector layers onto an n x n pixel grid (fills, strokes, then cuts), or null without a canvas. */
function trace(layers: { d: string; mode?: string; width?: number; detail?: boolean }[], n: number): Grid | null {
  const ctx = scratch(n);
  if (!ctx || !layers.length || typeof Path2D === 'undefined') return null;
  ctx.scale(n / 64, n / 64);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  const vis = layers.filter((l) => !(n < MARKER_DETAIL_PX && l.detail));
  for (const pass of [false, true]) {
    ctx.globalCompositeOperation = pass ? 'destination-out' : 'source-over';
    for (const l of vis) {
      const cut = l.mode === 'cut' || l.mode === 'cutStroke';
      if (cut !== pass) continue;
      const p = new Path2D(l.d);
      if (l.mode === 'stroke' || l.mode === 'cutStroke') {
        // at least about one pixel wide, so a thin line comes out solid instead of broken
        ctx.lineWidth = Math.max(l.width ?? 2, (1.3 * 64) / n);
        ctx.stroke(p);
      } else ctx.fill(p);
    }
  }
  return threshold(ctx, n);
}

/** A building's map silhouette (or another glyph.ts pictogram) as a pixel picture, one cell per CSS pixel. */
export function pixelGlyph(id: WorldGlyphId, px = 22): string {
  const key = `g:${id}|${px}`;
  let s = cache.get(key);
  if (!s) {
    const g = trace(glyphLayers(id), px);
    if (!g) return worldGlyph(id, px);
    s = toSvg(g, 1);
    cache.set(key, s);
  }
  return s;
}

/** A strike button's picture (barrage, bomber, paratroopers, rocket, atom bomb) as a pixel silhouette. */
export function pixelStrike(icon: string, px = 26): string {
  const key = `s:${icon}|${px}`;
  let s = cache.get(key);
  if (!s) {
    const src = STRIKE_SRC[icon];
    const g = trace(src ? glyphLayers(src as WorldGlyphId) : STRIKE_ART[icon] ?? [], px);
    if (!g) return '';
    s = toSvg(g, 1);
    cache.set(key, s);
  }
  return s;
}

/** The colour family of a building picture: every building is "buildings and economy". */
export function buildingCat(): IconCat {
  return 'econ';
}

/** An icon span coloured by its family. */
export function catSpan(html: string, cat: IconCat | null, cls = 'ico'): HTMLSpanElement {
  const s = document.createElement('span');
  s.className = cat ? `${cls} pi-c pi-${cat}` : cls;
  s.innerHTML = html;
  return s;
}
