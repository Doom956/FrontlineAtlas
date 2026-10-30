// Heartland hint: a faint brass glow along the edge of your heartland (the land deep inside your borders that
// defends harder). Drawn only while the Army drawer or the map key is open (ui.showHeartland), never during play
// otherwise. The outline is sampled in blocks (bigger when zoomed out, ~20k samples at most) over the view plus a
// margin, and rebuilt about once a second or when the view leaves the sampled area.
import type { GameState } from '../../sim/types';
import { heartlandBonus } from '../allies';
import type { Camera } from '../camera';

const MAX_SAMPLES = 20000;
const REBUILD_TICKS = 10;

export class HeartlandLayer {
  private path: Path2D | null = null;
  private fill: Path2D | null = null;
  private area = { x0: 0, y0: 0, x1: 0, y1: 0, step: 0, tick: -Infinity, me: 0, w: 0 };

  draw(ctx: CanvasRenderingContext2D, state: GameState, cam: Camera, me: number, on: boolean, dpr: number): void {
    if (!on || me <= 0 || !state.players[me]?.alive) return;
    const v = cam.visibleTiles(1);
    const tiles = Math.max(1, (v.x1 - v.x0) * (v.y1 - v.y0));
    const step = Math.max(1, Math.ceil(Math.sqrt((tiles * 1.6) / MAX_SAMPLES)));
    const a = this.area;
    const inside = v.x0 >= a.x0 && v.y0 >= a.y0 && v.x1 <= a.x1 && v.y1 <= a.y1;
    if (!inside || step !== a.step || me !== a.me || a.w !== state.map.width || Math.abs(state.tick - a.tick) >= REBUILD_TICKS) this.build(state, v, step, me);
    if (!this.path || !this.fill) return;
    const z = cam.zoom;
    ctx.save();
    ctx.setTransform(dpr * z, 0, 0, dpr * z, dpr * (cam.viewW / 2 - cam.x * z), dpr * (cam.viewH / 2 - cam.y * z));
    ctx.fillStyle = 'rgba(227, 192, 78, 0.07)';
    ctx.fill(this.fill);
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.strokeStyle = 'rgba(227, 192, 78, 0.16)';
    ctx.lineWidth = 7 / z;
    ctx.stroke(this.path);
    ctx.strokeStyle = 'rgba(240, 214, 120, 0.6)';
    ctx.lineWidth = 1.3 / z;
    ctx.stroke(this.path);
    ctx.restore();
  }

  private build(state: GameState, v: { x0: number; y0: number; x1: number; y1: number }, step: number, me: number): void {
    const map = state.map;
    const W = map.width;
    const H = map.height;
    // sample the view plus a quarter on each side, aligned to the block grid
    const mx = Math.ceil((v.x1 - v.x0) / 4);
    const my = Math.ceil((v.y1 - v.y0) / 4);
    const x0 = Math.max(0, Math.floor((v.x0 - mx) / step) * step);
    const y0 = Math.max(0, Math.floor((v.y0 - my) / step) * step);
    const x1 = Math.min(W, v.x1 + mx);
    const y1 = Math.min(H, v.y1 + my);
    const bw = Math.ceil((x1 - x0) / step);
    const bh = Math.ceil((y1 - y0) / step);
    const core = new Uint8Array(bw * bh);
    let any = false;
    for (let by = 0; by < bh; by++) {
      const ty = Math.min(H - 1, y0 + by * step + (step >> 1));
      for (let bx = 0; bx < bw; bx++) {
        const tx = Math.min(W - 1, x0 + bx * step + (step >> 1));
        const t = ty * W + tx;
        if (map.owner[t] !== me) continue;
        if (heartlandBonus(state, t) > 0) {
          core[by * bw + bx] = 1;
          any = true;
        }
      }
    }
    this.area = { x0: x0 > 0 ? x0 : -Infinity, y0: y0 > 0 ? y0 : -Infinity, x1: x1 < W ? x1 : Infinity, y1: y1 < H ? y1 : Infinity, step, tick: state.tick, me, w: W };
    if (!any) {
      this.path = this.fill = null;
      return;
    }
    const path = new Path2D();
    const fill = new Path2D();
    const at = (bx: number, by: number) => bx >= 0 && by >= 0 && bx < bw && by < bh && core[by * bw + bx] === 1;
    for (let by = 0; by < bh; by++) {
      for (let bx = 0; bx < bw; bx++) {
        if (!at(bx, by)) continue;
        const X = x0 + bx * step;
        const Y = y0 + by * step;
        const X2 = Math.min(W, X + step);
        const Y2 = Math.min(H, Y + step);
        fill.rect(X, Y, X2 - X, Y2 - Y);
        // edges toward non-core blocks (the sampled border of the area stays open: it continues off screen)
        if (!at(bx, by - 1) && (by > 0 || y0 === 0)) seg(path, X, Y, X2, Y);
        if (!at(bx, by + 1) && (by < bh - 1 || y1 === H)) seg(path, X, Y2, X2, Y2);
        if (!at(bx - 1, by) && (bx > 0 || x0 === 0)) seg(path, X, Y, X, Y2);
        if (!at(bx + 1, by) && (bx < bw - 1 || x1 === W)) seg(path, X2, Y, X2, Y2);
      }
    }
    this.path = path;
    this.fill = fill;
  }
}

function seg(p: Path2D, ax: number, ay: number, bx: number, by: number): void {
  p.moveTo(ax, ay);
  p.lineTo(bx, by);
}
