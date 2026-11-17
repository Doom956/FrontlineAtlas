// Treaty borders: at close zoom a dashed white line runs along every border you share with a treaty partner (a peace
// deal or a non-aggression pact); while the partner's pact is being broken the line turns red. Only your own treaties,
// only the pieces of line in view, rebuilt from the sim's border lists when a tile changes hands at that border.
import { borderTiles } from '../../sim/territory';
import type { GameState } from '../../sim/types';
import type { Camera } from '../camera';
import { chainSegments, chunkLines, mergeSegments, seedEdges } from './fronts';
import { OWNER_MASK, type TileFeed } from './tiles';

/** The lines show from this zoom on (a tile is at least this many px wide). */
export const TREATY_LINE_ZOOM = 3;
/** A changed border is rebuilt at most every this many frames. */
const REBUILD_FRAMES = 12;
const CHUNK_POINTS = 48;
export const TREATY_LINE_COLOR = 'rgb(255,255,255)';
export const TREATY_BREAK_COLOR = 'rgb(240,72,60)';

interface Item {
  other: number;
  breaking: boolean;
  dirty: boolean;
  builtFrame: number;
  chunks: { box: [number, number, number, number]; pts: number[] }[];
}

/** Which partners get a line: the other side and break state of each of `me`'s treaties (exported for tests). */
export function treatyPartners(state: GameState, me: number): { other: number; breaking: boolean }[] {
  const out: { other: number; breaking: boolean }[] = [];
  if (me <= 0) return out;
  for (const t of state.treaties ?? []) {
    if (t.endTick <= state.tick || (t.a !== me && t.b !== me)) continue;
    out.push({ other: t.a === me ? t.b : t.a, breaking: t.breakTick > 0 });
  }
  return out;
}

export class TreatyLines {
  private w = 0;
  private feed: TileFeed | null = null;
  private items = new Map<number, Item>();
  private frame = 0;
  private me = 0;
  /** pieces of line drawn last frame (tests) */
  pieces = 0;

  reset(w: number, feed?: TileFeed): void {
    this.w = w;
    this.feed = feed ?? null;
    this.items.clear();
  }

  private ownerAt = (i: number): number => (this.feed ? this.feed.mirror[i] & OWNER_MASK : 0);

  readonly onChange = (_tile: number, oldOwner: number, newOwner: number): void => {
    if (this.items.size === 0) return;
    for (const it of this.items.values()) {
      if (oldOwner === it.other || newOwner === it.other || oldOwner === this.me || newOwner === this.me) it.dirty = true;
    }
  };

  private build(state: GameState, it: Item): void {
    it.dirty = false;
    it.builtFrame = this.frame;
    const feed = this.feed;
    if (!feed) {
      it.chunks = [];
      return;
    }
    const A = borderTiles(state, this.me);
    const B = borderTiles(state, it.other);
    const out = new Set<number>();
    if (A.len <= B.len) seedEdges(this.ownerAt, A.list, A.len, this.me, it.other, this.w, feed.n, out);
    else seedEdges(this.ownerAt, B.list, B.len, it.other, this.me, this.w, feed.n, out);
    it.chunks = chunkLines(chainSegments(mergeSegments(out, this.w)), CHUNK_POINTS);
  }

  draw(ctx: CanvasRenderingContext2D, state: GameState, cam: Camera, dpr: number): void {
    this.pieces = 0;
    this.frame++;
    const z = cam.zoom;
    this.me = state.humanId;
    const partners = z >= TREATY_LINE_ZOOM ? treatyPartners(state, this.me) : [];
    for (const k of [...this.items.keys()]) if (!partners.some((p) => p.other === k)) this.items.delete(k);
    if (partners.length === 0) return;
    for (const p of partners) {
      let it = this.items.get(p.other);
      if (!it) this.items.set(p.other, (it = { other: p.other, breaking: p.breaking, dirty: true, builtFrame: -1e9, chunks: [] }));
      it.breaking = p.breaking;
      if (it.dirty && this.frame - it.builtFrame >= REBUILD_FRAMES) this.build(state, it);
    }
    const vx0 = cam.x - cam.viewW / 2 / z - 1;
    const vy0 = cam.y - cam.viewH / 2 / z - 1;
    const vx1 = cam.x + cam.viewW / 2 / z + 1;
    const vy1 = cam.y + cam.viewH / 2 / z + 1;
    ctx.save();
    ctx.setTransform(dpr * z, 0, 0, dpr * z, dpr * (cam.viewW / 2 - cam.x * z), dpr * (cam.viewH / 2 - cam.y * z));
    ctx.lineCap = 'butt';
    ctx.lineJoin = 'miter';
    for (const it of this.items.values()) {
      const path = new Path2D();
      let any = false;
      for (const c of it.chunks) {
        const b = c.box;
        if (b[2] < vx0 || b[3] < vy0 || b[0] > vx1 || b[1] > vy1) continue;
        const l = c.pts;
        path.moveTo(l[0], l[1]);
        for (let k = 2; k < l.length; k += 2) path.lineTo(l[k], l[k + 1]);
        any = true;
        this.pieces++;
      }
      if (!any) continue;
      ctx.setLineDash([]);
      ctx.globalAlpha = 0.45;
      ctx.strokeStyle = 'rgb(8,10,14)';
      ctx.lineWidth = 4 / z;
      ctx.stroke(path);
      ctx.globalAlpha = 0.95;
      ctx.strokeStyle = it.breaking ? TREATY_BREAK_COLOR : TREATY_LINE_COLOR;
      ctx.lineWidth = 2 / z;
      ctx.setLineDash([7 / z, 5 / z]);
      ctx.stroke(path);
    }
    ctx.restore();
  }
}
