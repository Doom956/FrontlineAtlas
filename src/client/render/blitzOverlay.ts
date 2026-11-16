// What a blitz draws on the map (rules: sim/blitz.ts; the player's side: client/blitzUi.ts), in the map's pixel
// manner (tile-snapped fills, chunky strokes over a dark casing):
//   - aiming (ui.mode 'blitz'): the wedge it would drive, BLITZ.width tiles wide along the blitz preview, solid as
//     deep as it is expected to get and outlined beyond, with "Blitz ~N tiles, holds 20 s" at its launch end
//   - a blitz under way: a thick arrow from its launch tile to the head and on toward its aim (yours amber, others red)
//   - land a blitz holds: hatched tiles that fade as the hold runs out, with the seconds left on a chip (yours amber,
//     others red); with fog of war only what you can see
// Read-only: it never changes the game state.
import { BLITZ, BLITZ_NAME, TICKS_PER_SECOND } from '../../sim/config';
import type { GameState } from '../../sim/types';
import type { Camera } from '../camera';
import type { UiState } from '../uiState';
import { blitzPreviewAt } from '../blitzUi';
import { activeFog } from '../fog/fogView';
import { css, MAP_NUM_FAMILY, type RGB } from './common';

/** warm amber: your blitz */
const OWN: RGB = [255, 184, 77];
/** signal red: someone else's */
const FOE: RGB = [255, 107, 94];
const CASING = 'rgba(20,12,4,0.7)';

export class BlitzOverlay {
  draw(ctx: CanvasRenderingContext2D, state: GameState, cam: Camera, ui: UiState, nowMs: number): void {
    if (state.phase !== 'playing') return;
    const me = state.humanId;
    ctx.save();
    this.pushes(ctx, state, cam, me);
    this.holds(ctx, state, cam, me, nowMs);
    if (ui.mode.kind === 'blitz' && ui.hoverTile >= 0) this.wedge(ctx, state, cam, ui);
    ctx.restore();
  }

  /** Land a blitz holds: hatched tiles, fading with the time left; one chip per holder with the seconds left. */
  private holds(ctx: CanvasRenderingContext2D, state: GameState, cam: Camera, me: number, nowMs: number): void {
    const arr = state.blitzHolds;
    if (!arr || !arr.length) return;
    const w = state.map.width;
    const z = cam.zoom;
    const fog = me > 0 ? activeFog(state) : null;
    const total = BLITZ.holdSeconds * TICKS_PER_SECOND;
    const chips = new Map<number, { x: number; y: number; until: number }>();
    const step = Math.max(2, Math.round(z / 3));
    for (let k = 0; k < arr.length; k += 3) {
      const t = arr[k];
      const owner = arr[k + 1];
      const until = arr[k + 2];
      if (until <= state.tick || state.map.owner[t] !== owner) continue;
      if (fog && owner !== me && !fog.visible(t)) continue;
      const q = cam.tileToScreen(t % w, (t / w) | 0);
      if (q.x < -z || q.y < -z || q.x > cam.viewW || q.y > cam.viewH) continue;
      const left = (until - state.tick) / total;
      const rgb = owner === me ? OWN : FOE;
      // the last seconds blink, so the end of the hold is plain to see
      const blink = left < 0.25 ? 0.55 + 0.45 * Math.abs(Math.sin(nowMs / 160)) : 1;
      const x0 = Math.round(q.x);
      const y0 = Math.round(q.y);
      const s = Math.max(1, Math.round(z));
      ctx.fillStyle = css(rgb, (0.12 + 0.16 * left) * blink);
      ctx.fillRect(x0, y0, s, s);
      if (z >= 4) {
        // pixel hatching: short diagonal runs, tile-snapped
        ctx.fillStyle = css(rgb, (0.35 + 0.35 * left) * blink);
        for (let d = 0; d < s; d += step) {
          const px = Math.max(1, Math.round(z / 8));
          for (let i = 0; i + d < s; i += px) ctx.fillRect(x0 + d + i, y0 + s - 1 - i, px, px);
        }
      }
      const c = chips.get(owner);
      if (!c || until > c.until) chips.set(owner, { x: q.x + z / 2, y: q.y, until });
    }
    ctx.font = `600 10px ${MAP_NUM_FAMILY}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const [owner, c] of chips) {
      const secs = Math.ceil((c.until - state.tick) / TICKS_PER_SECOND);
      const text = `Holds ${secs} s`;
      const tw = ctx.measureText(text).width + 10;
      const x = Math.round(c.x - tw / 2);
      const y = Math.round(c.y - 16);
      ctx.fillStyle = 'rgba(10,13,21,0.8)';
      ctx.fillRect(x, y, Math.round(tw), 14);
      ctx.fillStyle = css(owner === me ? OWN : FOE);
      ctx.fillRect(x, y, 2, 14);
      ctx.fillText(text, x + tw / 2 + 1, y + 7.5);
    }
  }

  /** A blitz under way: a thick arrow from its launch tile to the head, thin and dashed on to its aim. */
  private pushes(ctx: CanvasRenderingContext2D, state: GameState, cam: Camera, me: number): void {
    const w = state.map.width;
    const fog = me > 0 ? activeFog(state) : null;
    for (const u of state.units) {
      if (u.type !== 'tankDivision' || u.hp <= 0 || !u.blitz || u.state !== 3 || u.launch === undefined) continue;
      const head = Math.round(u.y) * w + Math.round(u.x);
      if (fog && u.owner !== me && !fog.visible(head)) continue;
      const a = cam.tileToScreen((u.launch % w) + 0.5, ((u.launch / w) | 0) + 0.5);
      const b = cam.tileToScreen(u.x + 0.5, u.y + 0.5);
      const aim = cam.tileToScreen((u.target % w) + 0.5, ((u.target / w) | 0) + 0.5);
      const rgb = u.owner === me ? OWN : FOE;
      const width = Math.max(4, Math.min(14, cam.zoom * 1.6));
      ctx.lineCap = 'butt';
      ctx.beginPath();
      ctx.moveTo(Math.round(a.x), Math.round(a.y));
      ctx.lineTo(Math.round(b.x), Math.round(b.y));
      ctx.lineWidth = width + 3;
      ctx.strokeStyle = CASING;
      ctx.stroke();
      ctx.lineWidth = width;
      ctx.strokeStyle = css(rgb, 0.85);
      ctx.stroke();
      // on toward the aim: a dashed guide
      ctx.beginPath();
      ctx.moveTo(Math.round(b.x), Math.round(b.y));
      ctx.lineTo(Math.round(aim.x), Math.round(aim.y));
      ctx.setLineDash([4, 6]);
      ctx.lineWidth = 2;
      ctx.strokeStyle = css(rgb, 0.55);
      ctx.stroke();
      ctx.setLineDash([]);
      arrowHead(ctx, a.x, a.y, b.x, b.y, width * 1.5, css(rgb, 0.95));
    }
  }

  /** Aiming: the wedge the blitz would drive (BLITZ.width tiles wide), solid as deep as it is expected to get. */
  private wedge(ctx: CanvasRenderingContext2D, state: GameState, cam: Camera, ui: UiState): void {
    const p = blitzPreviewAt(state, ui, ui.hoverTile);
    const w = state.map.width;
    const z = cam.zoom;
    const at = (t: number) => cam.tileToScreen((t % w) + 0.5, ((t / w) | 0) + 0.5);
    if (!p || p.reason || p.launch < 0 || !p.path.length) {
      // a cross where it can't go, with the reason
      const c = at(ui.hoverTile);
      chip(ctx, c.x, c.y - 18, p?.reason || 'Not here', FOE);
      return;
    }
    const pts = [at(p.launch), ...p.path.map(at)];
    const deep = Math.min(pts.length - 1, Math.max(1, p.expectedDepth));
    const band = Math.max(6, BLITZ.width * z);
    ctx.lineJoin = 'miter';
    ctx.lineCap = 'butt';
    // the wedge: solid band as deep as it gets, an outline of the same width beyond
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let k = 1; k <= deep; k++) ctx.lineTo(pts[k].x, pts[k].y);
    ctx.lineWidth = band + 3;
    ctx.strokeStyle = CASING;
    ctx.stroke();
    ctx.lineWidth = band;
    ctx.strokeStyle = css(OWN, 0.42);
    ctx.stroke();
    if (deep < pts.length - 1) {
      ctx.beginPath();
      ctx.moveTo(pts[deep].x, pts[deep].y);
      for (let k = deep + 1; k < pts.length; k++) ctx.lineTo(pts[k].x, pts[k].y);
      ctx.setLineDash([5, 5]);
      ctx.lineWidth = 2;
      ctx.strokeStyle = css(OWN, 0.6);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    arrowHead(ctx, pts[Math.max(0, deep - 1)].x, pts[Math.max(0, deep - 1)].y, pts[deep].x, pts[deep].y, band * 0.9, css(OWN, 0.9));
    // the label at the launch end (the hovered tile's card sits by the head)
    const start = pts[0];
    chip(ctx, start.x, start.y - band / 2 - 14, `${BLITZ_NAME} ~${p.expectedDepth} tiles, holds ${BLITZ.holdSeconds} s`, OWN);
  }
}

function arrowHead(ctx: CanvasRenderingContext2D, ax: number, ay: number, bx: number, by: number, size: number, fill: string): void {
  const ang = Math.atan2(by - ay, bx - ax);
  ctx.beginPath();
  ctx.moveTo(bx + Math.cos(ang) * size, by + Math.sin(ang) * size);
  ctx.lineTo(bx + Math.cos(ang + 2.3) * size, by + Math.sin(ang + 2.3) * size);
  ctx.lineTo(bx + Math.cos(ang - 2.3) * size, by + Math.sin(ang - 2.3) * size);
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = CASING;
  ctx.stroke();
}

/** A short label on a dark plate with a coloured edge. */
function chip(ctx: CanvasRenderingContext2D, x: number, y: number, text: string, rgb: RGB): void {
  ctx.font = `600 11px ${MAP_NUM_FAMILY}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const tw = ctx.measureText(text).width + 12;
  const x0 = Math.round(x - tw / 2);
  const y0 = Math.round(y - 8);
  ctx.fillStyle = 'rgba(10,13,21,0.82)';
  ctx.fillRect(x0, y0, Math.round(tw), 16);
  ctx.fillStyle = css(rgb);
  ctx.fillRect(x0, y0, 2, 16);
  ctx.fillText(text, x0 + tw / 2 + 1, y0 + 8.5);
}
