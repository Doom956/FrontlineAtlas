// Troop icons on the map (client only): infantry, armor and artillery markers, drawn by the current art style for
// troop icons (art/registry.ts; the refined pixel markers are art/refined/troopIcons.ts). Each marker shows a soldier, a
// tank, a field gun, or a mark for a mix the viewer does not know, in the owner's colour: a symbol on an owner-colour
// plate, or (the detailed style, TroopIconArt.bare) a tiny unit painted in the owner's colour with no plate round it.
//
// Used by the troop pills (front pills in fronts.ts, transports in units.ts: a count with the icons of the armor and
// artillery in it, so the mix of an army reads at a glance; infantry has no icon in the game, the owner's call). The
// pills themselves (layout, count plate, arrow) are shared by every style and stay here.
import type { Troops, TroopType } from '../../sim/types';
import { artFor } from '../art/registry';
import type { TroopIconKind } from '../art/types';
import { formatCount, MAP_NUM_FAMILY, type RGB } from './common';

export type { TroopIconKind };

/** Plate size (px) of the troop markers: 16 normally, 12 on the small pills. A marker covers size + 2 px. */
export const PLATE = 16;

/** Draws one troop marker with its top-left corner at (x, y) (whole px). Returns its width (0 without a canvas). */
export function drawTroopIcon(ctx: CanvasRenderingContext2D, kind: TroopIconKind, x: number, y: number, owner: RGB, size = PLATE): number {
  return artFor('troopIcons').draw(ctx, kind, x, y, owner, size);
}

/**
 * A marker's visible extent across its size + 2 px footprint (x px from its left edge, w px wide): a bare unit's own
 * width (TroopIconArt.span), else the whole footprint (a plate fills it).
 */
export function troopMarkerSpan(kind: TroopIconKind, size = PLATE): { x: number; w: number } {
  return artFor('troopIcons').span?.(kind, size) ?? { x: 0, w: size + 2 };
}

/**
 * The troop types to show for an army: armor and artillery when they are the biggest share or at least 12% of it,
 * the biggest first. Infantry has no marker (the owner's call: every army is mostly infantry, so the count alone says
 * it), so a plain infantry army shows no marker at all. A mix the viewer may not see (another nation's, without
 * intel) is one 'troops' marker.
 */
export function troopKinds(t: Troops | null): TroopIconKind[] {
  if (!t) return ['troops'];
  const total = t.infantry + t.armor + t.artillery;
  if (total <= 0) return [];
  const parts: [TroopType, number][] = [
    ['infantry', t.infantry],
    ['armor', t.armor],
    ['artillery', t.artillery],
  ];
  parts.sort((a, b) => b[1] - a[1]);
  return parts.filter(([k, n], i) => k !== 'infantry' && (i === 0 || n / total >= 0.12)).map(([k]) => k);
}

/** Overlap of stacked markers in a pill (px). */
const STACK = 2;
/** Air between bare units in a pill, and between the pill's edge and the first one (px). */
const GAP = 3;

export interface TroopPillStyle {
  /** coloured accent: the arrow and, for an attack on you, the outline */
  edge: string;
  arrow: 'up' | 'down' | 'none';
  /** red outline (an attack on you) */
  alarm?: boolean;
  /** smaller pill (transports): 12 px plates, 10 px text */
  small?: boolean;
}

interface PillLayout {
  w: number;
  h: number;
  tw: number;
  ax: number;
  bare: boolean;
  /** each marker's left edge from the pill's left (px) and the markers' total width */
  at: number[];
  iconsW: number;
}

/** Sizes of a troop pill and where its markers go (sets the pill's font on ctx). */
function pillLayout(ctx: CanvasRenderingContext2D, text: string, kinds: readonly TroopIconKind[], st: Pick<TroopPillStyle, 'arrow' | 'small'>): PillLayout {
  const plate = st.small ? 12 : PLATE;
  const art = artFor('troopIcons');
  const bare = art.bare === true;
  ctx.font = `600 ${st.small ? 10 : 11}px ${MAP_NUM_FAMILY}`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  const tw = Math.ceil(ctx.measureText(text).width);
  const at: number[] = [];
  let iconsW: number;
  if (!kinds.length) {
    // no markers (a plain infantry army): the count alone, with even padding on both sides
    const ax0 = st.arrow === 'none' ? 0 : st.small ? 7 : 9;
    return { w: 6 + tw + 6 + ax0, h: plate + 4, tw, ax: ax0, bare: true, at, iconsW: 3 };
  }
  if (bare) {
    // bare units sit on the pill's own plate side by side, each by its real width (its outline included), with the
    // same air between them and before the first; the footprint's empty margin is left out
    let x = GAP;
    for (const k of kinds) {
      const sp = troopMarkerSpan(k, plate);
      at.push(x - sp.x);
      x += sp.w + GAP;
    }
    iconsW = x - GAP;
  } else {
    // plated markers overlap a little
    const step = plate + 2 - STACK;
    kinds.forEach((_, i) => at.push(i * step));
    iconsW = plate + 2 + (kinds.length - 1) * step;
  }
  const ax = st.arrow === 'none' ? 0 : st.small ? 7 : 9;
  const w = bare ? iconsW + GAP + tw + 6 + ax : iconsW + 4 + tw + 6 + ax;
  return { w, h: plate + 4, tw, ax, bare, at, iconsW };
}

/** Width and height (px) a troop pill will take, without drawing it (to keep it clear of other marks). */
export function troopPillSize(ctx: CanvasRenderingContext2D, troops: number, kinds: readonly TroopIconKind[], st: Pick<TroopPillStyle, 'arrow' | 'small'>): { w: number; h: number } {
  const { w, h } = pillLayout(ctx, `${formatCount(troops)} troops`, kinds, st);
  return { w, h };
}

/**
 * A troop pill centred at (x, y): the troop markers on the left (stacked plates, or bare units side by side on the
 * pill's plate, standing on one ground row), then the count with its unit ("12.3k troops") on a near-black plate with
 * a 1 px dark outline, and the push arrow (yours up, an incoming attack down). Returns the pill's width.
 */
export function troopPill(ctx: CanvasRenderingContext2D, x: number, y: number, troops: number, kinds: readonly TroopIconKind[], owner: RGB, st: TroopPillStyle): number {
  const plate = st.small ? 12 : PLATE;
  const text = `${formatCount(troops)} troops`;
  const { w, h, tw, iconsW, ax, bare, at } = pillLayout(ctx, text, kinds, st);
  const x0 = Math.round(x - w / 2);
  const y0 = Math.round(y - h / 2);
  // the plate behind the number (and, for bare units, behind the markers too): a 1 px outline (red when the attack is
  // on you), a near-black fill and a faint light top row; plated markers tuck it under their right edge
  const bx = bare ? x0 : x0 + iconsW - 4;
  const bw = bare ? w : w - iconsW + 4;
  ctx.fillStyle = st.alarm ? '#ff6b5e' : 'rgb(8,10,13)';
  ctx.fillRect(bx, y0, bw, h);
  ctx.fillStyle = 'rgba(20,23,29,0.96)';
  ctx.fillRect(bx + 1, y0 + 1, bw - 2, h - 2);
  ctx.fillStyle = 'rgba(255,255,255,0.08)';
  ctx.fillRect(bx + 1, y0 + 1, bw - 2, 1);
  // troop markers, the biggest share in front (drawn last)
  for (let i = kinds.length - 1; i >= 0; i--) drawTroopIcon(ctx, kinds[i], x0 + at[i], y0 + 1, owner, plate);
  const tx = x0 + iconsW + 3;
  ctx.fillStyle = '#ffffff';
  ctx.fillText(text, tx, y0 + h / 2 + 0.5);
  if (st.arrow !== 'none') {
    // a solid pixel triangle: up for your push, down for an attack on you
    const cx = tx + tw + 3 + Math.floor(ax / 2);
    const cy = Math.round(y0 + h / 2);
    const rows = st.small ? 3 : 4;
    ctx.fillStyle = st.edge;
    for (let i = 0; i < rows; i++) {
      const yy = st.arrow === 'up' ? cy - Math.floor(rows / 2) + i : cy + Math.floor(rows / 2) - i - 1;
      ctx.fillRect(cx - i, yy, 1 + i * 2, 1);
    }
  }
  return w;
}
