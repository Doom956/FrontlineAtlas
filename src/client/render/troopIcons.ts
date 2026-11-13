// Troop icons on the map (client only): infantry, armor and artillery markers, drawn by the current art style for
// troop icons (art/registry.ts; the refined pixel markers are art/refined/troopIcons.ts). Each marker shows a soldier, a
// tank, a field gun, or a mark for a mix the viewer does not know, in the owner's colour: a symbol on an owner-colour
// plate, or (the detailed style, TroopIconArt.bare) a tiny unit painted in the owner's colour with no plate round it.
//
// Used by the troop pills (front pills in fronts.ts, transports in units.ts: a count with the icons of the troop
// types in it, so the mix of an army reads at a glance) and next to each nation's army count (names.ts). The pills
// themselves (layout, count plate, arrow) are shared by every style and stay here.
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
 * The troop types to show for an army: every type with at least 12% of it, the biggest first (at least one); a mix
 * the viewer may not see (another nation's, without intel) is one 'troops' marker.
 */
export function troopKinds(t: Troops | null): TroopIconKind[] {
  if (!t) return ['troops'];
  const total = t.infantry + t.armor + t.artillery;
  if (total <= 0) return ['infantry'];
  const parts: [TroopType, number][] = [
    ['infantry', t.infantry],
    ['armor', t.armor],
    ['artillery', t.artillery],
  ];
  parts.sort((a, b) => b[1] - a[1]);
  const out = parts.filter(([, n], i) => i === 0 || n / total >= 0.12).map(([k]) => k);
  return out;
}

/** Overlap of stacked markers in a pill (px). */
const STACK = 2;

export interface TroopPillStyle {
  /** coloured accent: the arrow and, for an attack on you, the outline */
  edge: string;
  arrow: 'up' | 'down' | 'none';
  /** red outline (an attack on you) */
  alarm?: boolean;
  /** smaller pill (transports): 12 px plates, 10 px text */
  small?: boolean;
}

/** Sizes of a troop pill (sets the pill's font on ctx). */
function pillLayout(ctx: CanvasRenderingContext2D, text: string, kinds: number, st: Pick<TroopPillStyle, 'arrow' | 'small'>): { w: number; h: number; tw: number; iconsW: number; ax: number; step: number; bare: boolean } {
  const plate = st.small ? 12 : PLATE;
  const bare = artFor('troopIcons').bare === true;
  ctx.font = `600 ${st.small ? 10 : 11}px ${MAP_NUM_FAMILY}`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  const tw = Math.ceil(ctx.measureText(text).width);
  const n = Math.max(1, kinds);
  // plated markers overlap a little; bare units sit side by side with a little air between them
  const step = bare ? plate + 3 : plate + 2 - STACK;
  const iconsW = plate + 2 + (n - 1) * step;
  const ax = st.arrow === 'none' ? 0 : st.small ? 7 : 9;
  // bare units sit on the pill's own plate: its 1 px edge and 1 px of air on their left, 2 px before the count
  const w = bare ? 2 + iconsW + 2 + tw + 6 + ax : iconsW + 4 + tw + 6 + ax;
  return { w, h: plate + 4, tw, iconsW, ax, step, bare };
}

/** Width and height (px) a troop pill will take, without drawing it (to keep it clear of other marks). */
export function troopPillSize(ctx: CanvasRenderingContext2D, troops: number, kinds: number, st: Pick<TroopPillStyle, 'arrow' | 'small'>): { w: number; h: number } {
  const { w, h } = pillLayout(ctx, `${formatCount(troops)} troops`, kinds, st);
  return { w, h };
}

/**
 * A troop pill centred at (x, y): the troop markers on the left (stacked plates, or bare units side by side on the
 * pill's plate), then the count with its unit ("12.3k troops") on a near-black plate with a 1 px dark outline, and the
 * push arrow (yours up, an incoming attack down). Returns the pill's width.
 */
export function troopPill(ctx: CanvasRenderingContext2D, x: number, y: number, troops: number, kinds: readonly TroopIconKind[], owner: RGB, st: TroopPillStyle): number {
  const plate = st.small ? 12 : PLATE;
  const text = `${formatCount(troops)} troops`;
  const { w, h, tw, iconsW, ax, step, bare } = pillLayout(ctx, text, kinds.length, st);
  const n = Math.max(1, kinds.length);
  const x0 = Math.round(x - w / 2);
  const y0 = Math.round(y - h / 2);
  // the plate behind the number (and, for bare units, behind the markers too): a 1 px outline (red when the attack is
  // on you), a near-black fill and a faint light top row; plated markers tuck it under their right edge
  const ix = bare ? x0 + 2 : x0;
  const bx = bare ? x0 : x0 + iconsW - 4;
  const bw = bare ? w : w - iconsW + 4;
  ctx.fillStyle = st.alarm ? '#ff6b5e' : 'rgb(8,10,13)';
  ctx.fillRect(bx, y0, bw, h);
  ctx.fillStyle = 'rgba(20,23,29,0.96)';
  ctx.fillRect(bx + 1, y0 + 1, bw - 2, h - 2);
  ctx.fillStyle = 'rgba(255,255,255,0.08)';
  ctx.fillRect(bx + 1, y0 + 1, bw - 2, 1);
  // troop markers, the biggest share in front (drawn last)
  for (let i = n - 1; i >= 0; i--) drawTroopIcon(ctx, kinds[i] ?? 'troops', ix + i * step, y0 + 1, owner, plate);
  const tx = ix + iconsW + (bare ? 2 : 3);
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
