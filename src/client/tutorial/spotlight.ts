// The spotlight shared by Tutorial mode (overlay.ts) and the in-game guide (../guide/): a pulsing brass ring around
// a UI element or a map tile, plus an arrow pointing at it.
// - An element: the arrow sits on the side facing the screen's middle (none when the element is near the middle),
//   outside the panel that holds the element when that stays close.
// - A map point: a round ring on the tile and an arrow above it (below it near the top edge); a point off screen gets
//   only the arrow, on the screen edge, pointing the way.
// Positions are relative to the host (the overlay layer that holds both parts); call it every frame (cheap).
import { el } from '../dom';
import { setClass, setVisible } from '../hud/dom';

/** Ring padding around an element (px). */
const PAD = 6;
/** HUD panels the arrow stays outside of. */
const PANELS = '.cmdbar, .drawer, .bm, .cluster, .lb, .ncard, .orders-bar, .bsel';
/** How far (px) the arrow may move to get outside the element's panel. */
const ARROW_MAX_SHIFT = 90;
/** Arrow size and its gap to the ring (px). */
const A = 28;
const GAP = 8;
/** Margin (px) that keeps the arrow on screen. */
const EDGE = 4;

export type ArrowDir = 'left' | 'right' | 'up' | 'down';

export class Spotlight {
  readonly spot = el('div', 'tut-spot');
  readonly arrow = el('div', 'tut-arrow');

  constructor(test = 'tut-spot') {
    this.spot.dataset.test = test;
    this.arrow.innerHTML = '<svg viewBox="0 0 24 24" width="28" height="28" aria-hidden="true"><path d="M4 9h9V4l8 8-8 8v-5H4z" fill="currentColor"/></svg>';
    this.arrow.dataset.test = `${test}-arrow`;
    this.hide();
  }

  hide(): void {
    setVisible(this.spot, false);
    setVisible(this.arrow, false);
  }

  /** Ring and arrow on an element (null hides both). host: the layer's rect. */
  onElement(t: HTMLElement | null, host: DOMRect): void {
    if (!t) {
      this.hide();
      return;
    }
    const r = t.getBoundingClientRect();
    const x = r.left - host.left - PAD;
    const y = r.top - host.top - PAD;
    const w = r.width + PAD * 2;
    const hgt = r.height + PAD * 2;
    this.ring(x, y, w, hgt, false);
    const vw = host.width || window.innerWidth;
    const vh = host.height || window.innerHeight;
    const cx = x + w / 2;
    const cy = y + hgt / 2;
    const dx = (cx - vw / 2) / vw;
    const dy = (cy - vh / 2) / vh;
    const far = Math.abs(dx) > 0.22 || Math.abs(dy) > 0.22;
    setVisible(this.arrow, far);
    if (!far) return;
    let dir: ArrowDir;
    if (Math.abs(dx) >= Math.abs(dy)) dir = dx > 0 ? 'right' : 'left';
    else dir = dy > 0 ? 'down' : 'up';
    // a wide element at the top or bottom edge reads better with a vertical arrow
    if (w > vw * 0.4) dir = dy > 0 ? 'down' : 'up';
    let { ax, ay } = beside(x, y, w, hgt, dir);
    // outside the panel that holds the element (the command bar, a drawer, the build menu), so it hides nothing there
    // (only when that stays close: in a big drawer the arrow would end up far from the element, pointing at another one)
    const panel = t.closest<HTMLElement>(PANELS);
    if (panel && panel !== t) {
      const pr = panel.getBoundingClientRect();
      const bx = ax;
      const by = ay;
      if (dir === 'right') ax = Math.min(ax, pr.left - host.left - A - GAP);
      else if (dir === 'left') ax = Math.max(ax, pr.right - host.left + GAP);
      else if (dir === 'down') ay = Math.min(ay, pr.top - host.top - A - GAP);
      else ay = Math.max(ay, pr.bottom - host.top + GAP);
      if (Math.abs(ax - bx) + Math.abs(ay - by) > ARROW_MAX_SHIFT) {
        ax = bx;
        ay = by;
      }
    }
    this.placeArrow(ax, ay, dir, vw, vh);
  }

  /**
   * Ring and arrow on a map point (host px; r = ring radius). A point off screen (or under `avoid`, e.g. the HUD's
   * bottom bar) gets the arrow on the edge pointing toward it and no ring.
   */
  onPoint(px: number, py: number, r: number, host: DOMRect, avoid: { top: number; bottom: number } = { top: 0, bottom: 0 }): void {
    const vw = host.width || window.innerWidth;
    const vh = host.height || window.innerHeight;
    const top = avoid.top;
    const bottom = vh - avoid.bottom;
    const inside = px >= 0 && px <= vw && py >= top && py <= bottom;
    if (!inside) {
      setVisible(this.spot, false);
      // the arrow on the edge, pointing toward the point
      const cx = vw / 2;
      const cy = (top + bottom) / 2;
      const dx = px - cx;
      const dy = py - cy;
      const dir: ArrowDir = Math.abs(dx) / vw >= Math.abs(dy) / Math.max(1, bottom - top) ? (dx > 0 ? 'right' : 'left') : dy > 0 ? 'down' : 'up';
      const ax = dir === 'left' ? EDGE + 8 : dir === 'right' ? vw - A - EDGE - 8 : Math.max(EDGE, Math.min(vw - A - EDGE, px - A / 2));
      const ay = dir === 'up' ? top + EDGE + 8 : dir === 'down' ? bottom - A - EDGE - 8 : Math.max(top + EDGE, Math.min(bottom - A - EDGE, py - A / 2));
      this.placeArrow(ax, ay, dir, vw, vh);
      setVisible(this.arrow, true);
      return;
    }
    const d = r * 2;
    this.ring(px - r, py - r, d, d, true);
    // above the ring, pointing down; below it near the top edge
    const dir: ArrowDir = py - r - A - GAP < top + EDGE ? 'up' : 'down';
    const { ax, ay } = beside(px - r, py - r, d, d, dir);
    this.placeArrow(ax, ay, dir, vw, vh);
    setVisible(this.arrow, true);
  }

  private ring(x: number, y: number, w: number, h: number, round: boolean): void {
    const s = this.spot.style;
    s.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
    s.width = `${w.toFixed(1)}px`;
    s.height = `${h.toFixed(1)}px`;
    setClass(this.spot, 'round', round);
    setVisible(this.spot, true);
  }

  private placeArrow(ax: number, ay: number, dir: ArrowDir, vw: number, vh: number): void {
    ax = Math.max(EDGE, Math.min(vw - A - EDGE, ax));
    ay = Math.max(EDGE, Math.min(vh - A - EDGE, ay));
    this.arrow.style.transform = `translate(${ax.toFixed(1)}px, ${ay.toFixed(1)}px)`;
    if (this.arrow.dataset.dir !== dir) this.arrow.dataset.dir = dir;
  }
}

/** The arrow's corner when it sits on side `dir` of a box and points at it. */
function beside(x: number, y: number, w: number, h: number, dir: ArrowDir): { ax: number; ay: number } {
  let ax = x + w / 2 - A / 2;
  let ay = y + h / 2 - A / 2;
  if (dir === 'right') ax = x - A - GAP;
  else if (dir === 'left') ax = x + w + GAP;
  else if (dir === 'down') ay = y - A - GAP;
  else ay = y + h + GAP;
  return { ax, ay };
}
