// The art lab's icon sheet: every strike, weapon and Defense icon, the picture it replaced next to the new one, at
// 16, 24 and 48 px on a light and a dark ground. Line icons show twice at the small sizes: traced to one-pixel lines
// (the cards and the top bar, hud/pixelIcons.ts) and as the vector line (the card buttons, toasts and alerts).
// The old pictures live only here, so the sheet can keep showing what changed.
import { iconDataUrl, type IconId } from '../icons';
import { lineIcon, type WorldGlyphId } from '../hud/glyph';
import { pixelGlyph, pixelIcon, pixelLayers, pixelLineBody, strikeLayers } from '../hud/pixelIcons';

type Layers = { d: string; mode?: string; width?: number }[];
type Pic =
  | { kind: 'line'; name: string } // a line icon of glyph.ts
  | { kind: 'body'; body: string } // an old line icon body (kept here)
  | { kind: 'glyph'; id: WorldGlyphId } // a building or deposit silhouette
  | { kind: 'strike'; layers: Layers } // a strike button's 64 x 64 picture
  | { kind: 'painted'; id: IconId }; // a painted picture of icons.ts

/** The old line icons the new ones replaced in place (glyph.ts). */
const OLD_BODY = {
  stealth: '<path d="M12 5l10 10-3 2-2.5-2-2.5 2-2-1.5-2 1.5-2.5-2-2.5 2-3-2z"/><path d="M12 9v4"/>',
  rocket: '<path d="M12 3c3 2 4 6 4 10l-2 3h-4l-2-3c0-4 1-8 4-10zM8 15l-3 3v2l3-1M16 15l3 3v2l-3-1M11 20h2"/>',
  counter: '<path d="M3 20h8v-6H3zM3 14v-2h2v2M7 14v-2h2v2"/><path d="M11 13l9-6M20 7h-5M20 7v5"/>',
};

/** The old strike button pictures (hud/pixelIcons.ts STRIKE_ART). */
const OLD_STRIKE: Record<string, Layers> = {
  rocket: [{ d: 'M25 16Q32 -2 39 16V47H25Z' }, { d: 'M25 30L13 46V54L25 47ZM39 30L51 46V54L39 47Z' }, { d: 'M27 50H37L32 63Z' }],
  atomBomb: [{ d: 'M14 32Q14 13 36 13Q61 13 61 32Q61 51 36 51Q14 51 14 32Z' }, { d: 'M2 18H12V46H2ZM10 28H17V36H10Z' }, { d: 'M43 13H47V51H43Z', mode: 'cut' }],
};

interface Row {
  name: string;
  where: string;
  old: Pic;
  now: Pic;
}

const line = (name: string): Pic => ({ kind: 'line', name });
const strike = (icon: string): Pic => ({ kind: 'strike', layers: strikeLayers(icon) });

const LINE_ROWS: Row[] = [
  { name: 'Stealth strike', where: 'airfield card, alerts, toasts', old: { kind: 'body', body: OLD_BODY.stealth }, now: line('stealth') },
  { name: 'Cruise missile', where: 'warship card, orders bar, alerts', old: { kind: 'body', body: OLD_BODY.rocket }, now: line('cruise') },
  { name: 'Anti-radar strike', where: 'airfield card, Arsenal card', old: line('radar'), now: line('antiradar') },
  { name: 'Silo rocket', where: 'silo card, alerts, toasts', old: { kind: 'body', body: OLD_BODY.rocket }, now: line('rocket') },
  { name: 'Atom bomb', where: 'silo card, alerts, toasts', old: line('atom'), now: line('icbm') },
  { name: 'Counteroffensive', where: 'Fort card', old: { kind: 'body', body: OLD_BODY.counter }, now: line('counter') },
  { name: 'Breakthrough', where: 'tank orders bar', old: line('blitz'), now: line('breakthrough') },
  { name: 'Flak Guns', where: 'Arsenal card', old: { kind: 'glyph', id: 'sam' }, now: line('flak') },
  { name: 'Tank Traps', where: 'Arsenal card', old: { kind: 'glyph', id: 'fort' }, now: line('hedgehog') },
  { name: 'Tracking Radar', where: 'Arsenal card', old: line('signal'), now: line('tracking') },
  { name: 'Coastal Batteries', where: 'Arsenal card', old: { kind: 'glyph', id: 'port' }, now: line('coastal') },
  { name: 'Defense Mastery', where: 'Arsenal card', old: line('star'), now: line('mastery-defense') },
];

const STRIKE_ROWS: Row[] = [
  { name: 'Stealth', where: 'strike bar', old: strike('bomber'), now: strike('stealth') },
  { name: 'Cruise', where: 'strike bar', old: { kind: 'strike', layers: OLD_STRIKE.rocket }, now: strike('cruise') },
  { name: 'Rocket', where: 'strike bar', old: { kind: 'strike', layers: OLD_STRIKE.rocket }, now: strike('rocket') },
  { name: 'Atom', where: 'strike bar', old: { kind: 'strike', layers: OLD_STRIKE.atomBomb }, now: strike('atomBomb') },
  { name: 'Breakthrough', where: 'strike bar', old: { kind: 'painted', id: 'armor' }, now: strike('breakthrough') },
  { name: 'Counter', where: 'strike bar', old: { kind: 'painted', id: 'fort' }, now: strike('counter') },
];

/** One picture at `px`: `pixel` the traced one-pixel look, else the vector line. */
function pic(p: Pic, px: number, pixel: boolean): string {
  switch (p.kind) {
    case 'line':
      return pixel ? pixelIcon(p.name, px) : lineIcon(p.name, px);
    case 'body':
      return pixel ? pixelLineBody(p.body, px) : lineIcon('info', px).replace(/(<svg[^>]*>).*(<\/svg>)/, `$1${p.body}$2`);
    case 'glyph':
      return pixelGlyph(p.id, px);
    case 'strike':
      return pixelLayers(p.layers, px);
    case 'painted':
      try {
        return `<img src="${iconDataUrl(p.id, px)}" width="${px}" height="${px}" alt="">`;
      } catch {
        return '';
      }
  }
}

const LINE_COLS: { px: number; pixel: boolean; head: string }[] = [
  { px: 16, pixel: true, head: '16 pixel' },
  { px: 16, pixel: false, head: '16 line' },
  { px: 24, pixel: true, head: '24 pixel' },
  { px: 24, pixel: false, head: '24 line' },
  { px: 48, pixel: false, head: '48 line' },
];
const STRIKE_COLS: { px: number; pixel: boolean; head: string }[] = [
  { px: 16, pixel: true, head: '16' },
  { px: 26, pixel: true, head: '26 bar' },
  { px: 48, pixel: true, head: '48' },
];

const CSS = `
.is-wrap{margin:24px 0;padding:16px;background:#2a2c30;border-radius:8px;color:#e8e4d8;font:13px/1.3 system-ui,sans-serif}
.is-wrap h2{margin:0 0 4px;font-size:18px}.is-wrap>p{margin:0 0 12px;opacity:.8}
.is-panels{display:flex;flex-wrap:wrap;gap:16px}
.is-panel{padding:12px;border-radius:6px}
.is-panel.light{background:#ebe7dc;color:#23262b}.is-panel.dark{background:#16181c;color:#e8e4d8}
.is-panel table{border-collapse:collapse}
.is-panel th{font-weight:600;font-size:11px;text-align:center;padding:2px 6px;opacity:.75}
.is-panel td{padding:4px 6px;text-align:center;vertical-align:middle}
.is-panel td.n{text-align:left;white-space:nowrap}.is-panel td.n small{display:block;opacity:.6;font-size:10px}
.is-panel td.sep{border-left:1px solid currentColor;opacity:1}
.is-panel tr.grp th{text-align:left;font-size:12px;padding-top:10px;opacity:1}
.is-panel svg,.is-panel img{display:block;margin:auto}
`;

function table(rows: Row[], cols: typeof LINE_COLS, title: string): string {
  const head = `<tr class="grp"><th colspan="${1 + cols.length * 2}">${title}</th></tr><tr><th></th>${cols.map((c) => `<th class="old">old ${c.head}</th>`).join('')}${cols.map((c) => `<th>new ${c.head}</th>`).join('')}</tr>`;
  const body = rows
    .map(
      (r) =>
        `<tr data-icon="${r.name}"><td class="n">${r.name}<small>${r.where}</small></td>` +
        cols.map((c) => `<td class="old">${pic(r.old, c.px, c.pixel)}</td>`).join('') +
        cols.map((c, i) => `<td${i === 0 ? ' class="sep"' : ''}>${pic(r.now, c.px, c.pixel)}</td>`).join('') +
        '</tr>',
    )
    .join('');
  return head + body;
}

/** Mounts the icon sheet (old next to new) into the art lab page. */
export function mountIconSheet(root: HTMLElement): void {
  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.append(style);
  const wrap = document.createElement('section');
  wrap.className = 'is-wrap';
  wrap.dataset.sheet = 'icons';
  wrap.setAttribute('aria-label', 'Icon sheet');
  const panels = (['light', 'dark'] as const)
    .map((bg) => `<div class="is-panel ${bg}"><table>${table(LINE_ROWS, LINE_COLS, `Line icons, ${bg} ground`)}${table(STRIKE_ROWS, STRIKE_COLS, `Strike bar pictures, ${bg} ground`)}</table></div>`)
    .join('');
  wrap.innerHTML = `<h2>Icon sheet: strikes, weapons and Defense</h2><p>Old (left) and new (right, after the line) at 16, 24 and 48 px. Pixel: traced to one-pixel lines as on the cards and the top bar. Line: the vector icon on buttons, toasts and alerts.</p><div class="is-panels">${panels}</div>`;
  root.append(wrap);
}

