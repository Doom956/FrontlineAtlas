// Mobile units on the map (ships, planes, missiles) as minimal line glyphs (unitGlyphs.ts): a thin stroke in the
// owner's colour over a dark under-stroke, rotated to the heading and interpolated between ticks. Small and uniform
// (about 9-14 px) so many units in one area stay readable; short fading wakes and contrails, a small troop pill on
// transports, a thin ring around your own warships (they can be clicked to give orders, the hit area is larger than
// the drawing). At far zoom units on the same pixel are drawn once and trails are dropped.
import { TICKS_PER_SECOND } from '../../sim/config';
import { armyTotal } from '../../sim/economy';
import type { GameState, Unit } from '../../sim/types';
import type { Camera } from '../camera';
import { clamp, css, formatCount, MAP_NUM_FAMILY, type RGB } from './common';
import { addGlyph, GLYPHS } from './unitGlyphs';

const HIST = 8;
/** Trail segments drawn (of the HIST recorded positions). */
const TRAIL_STEPS = 4;
/** Paratroopers drifting down where a cargo plane arrived (client-only effect). */
const DROP_MS = 1800;
const CHUTES = 6;
const UNDER = 'rgba(6,9,15,0.6)';

/** Base glyph length on screen (CSS px) at a zoom level; each glyph scales it a little (unitGlyphs.ts). */
const glyphPx = (z: number): number => clamp(8 + z * 2.2, 9, 14);
const strokePx = (z: number): number => clamp(1.3 + z * 0.3, 1.5, 2.5);

type Vis = { u: Unit; t: Track | undefined; x: number; y: number; S: number; angle: number };

interface Track {
  px: number;
  py: number;
  cx: number;
  cy: number;
  angle: number;
  shown: number;
  seen: number;
  hx: Float32Array;
  hy: Float32Array;
  hn: number;
}

export class UnitLayer {
  private tracks = new Map<number, Track>();
  private lastTick = -1;
  private lastTickMs = 0;
  private w = 0;
  /** own warships drawn last frame: id, screen x, y, radius */
  private hits: number[] = [];
  /** cargo planes that reached their drop tile: where and when, for the parachutes */
  private drops: { x: number; y: number; owner: number; born: number }[] = [];
  private planes = new Map<number, { tx: number; ty: number; owner: number }>();
  drawn = 0;

  reset(w: number): void {
    this.tracks.clear();
    this.lastTick = -1;
    this.w = w;
    this.hits = [];
    this.drops = [];
    this.planes.clear();
  }

  /** Interpolated position of a unit (tile coords, unit origin at the tile corner like Unit.x/y). */
  pos(u: Unit, frac: number): { x: number; y: number } {
    const t = this.tracks.get(u.id);
    if (!t) return { x: u.x, y: u.y };
    return { x: t.px + (t.cx - t.px) * frac, y: t.py + (t.cy - t.py) * frac };
  }

  /** Fraction (0..1) of the current tick that has passed. */
  subTick(nowMs: number, paused: boolean, speed: number): number {
    if (paused) return 1;
    const tickMs = 1000 / TICKS_PER_SECOND / speed;
    return clamp((nowMs - this.lastTickMs) / tickMs, 0, 1);
  }

  /** Records positions once per tick (interpolation, headings, trails). */
  track(state: GameState, nowMs: number): void {
    if (state.tick === this.lastTick) return;
    this.lastTick = state.tick;
    this.lastTickMs = nowMs;
    const w = this.w;
    for (const u of state.units) {
      let t = this.tracks.get(u.id);
      if (!t) {
        const tx = (u.target % w) + 0.5;
        const ty = ((u.target / w) | 0) + 0.5;
        const a = Math.atan2(ty - u.y - 0.5, tx - u.x - 0.5);
        t = { px: u.x, py: u.y, cx: u.x, cy: u.y, angle: a, shown: a, seen: state.tick, hx: new Float32Array(HIST), hy: new Float32Array(HIST), hn: 0 };
        this.tracks.set(u.id, t);
      } else {
        const dx = u.x - t.cx;
        const dy = u.y - t.cy;
        t.px = t.cx;
        t.py = t.cy;
        t.cx = u.x;
        t.cy = u.y;
        if (dx * dx + dy * dy > 1e-6) t.angle = Math.atan2(dy, dx);
        t.seen = state.tick;
      }
      // history (newest first); a jump (several ticks at once, a teleport) starts a fresh trail
      if (t.hn > 0 && Math.abs(u.x - t.hx[0]) + Math.abs(u.y - t.hy[0]) > 4) t.hn = 0;
      for (let k = HIST - 1; k > 0; k--) {
        t.hx[k] = t.hx[k - 1];
        t.hy[k] = t.hy[k - 1];
      }
      t.hx[0] = u.x;
      t.hy[0] = u.y;
      t.hn = Math.min(HIST, t.hn + 1);
    }
    for (const [id, t] of this.tracks) {
      if (t.seen === state.tick) continue;
      // a cargo plane that vanished close to its target dropped its troops: parachutes there
      const pl = this.planes.get(id);
      if (pl && Math.abs(t.cx + 0.5 - pl.tx) + Math.abs(t.cy + 0.5 - pl.ty) < 6) this.drops.push({ x: pl.tx, y: pl.ty, owner: pl.owner, born: nowMs });
      this.planes.delete(id);
      this.tracks.delete(id);
    }
    for (const u of state.units) {
      if (u.type === 'transportPlane' && u.state === 0) this.planes.set(u.id, { tx: (u.target % w) + 0.5, ty: ((u.target / w) | 0) + 0.5, owner: u.owner });
    }
    if (this.drops.length > 24) this.drops.splice(0, this.drops.length - 24);
  }

  /** Id of your own warship drawn under the screen point, or -1. */
  ownWarshipAt(sx: number, sy: number): number {
    let best = -1;
    let bd = Infinity;
    const h = this.hits;
    for (let k = 0; k < h.length; k += 4) {
      const dx = h[k + 1] - sx;
      const dy = h[k + 2] - sy;
      const d = dx * dx + dy * dy;
      if (d <= h[k + 3] * h[k + 3] && d < bd) {
        bd = d;
        best = h[k];
      }
    }
    return best;
  }

  draw(ctx: CanvasRenderingContext2D, state: GameState, cam: Camera, frac: number, colors: readonly RGB[], humanId: number, dpr: number, nowMs: number): void {
    this.drawn = 0;
    this.hits.length = 0;
    if (this.drops.length) this.drawDrops(ctx, cam, colors, nowMs);
    if (state.units.length === 0) return;
    const z = cam.zoom;
    const ox = cam.viewW / 2 - cam.x * z;
    const oy = cam.viewH / 2 - cam.y * z;
    const me = humanId;
    const base = glyphPx(z);
    const visible: Vis[] = [];
    const taken = new Set<number>();
    for (const u of state.units) {
      const t = this.tracks.get(u.id);
      const ux = t ? t.px + (t.cx - t.px) * frac : u.x;
      const uy = t ? t.py + (t.cy - t.py) * frac : u.y;
      const x = ox + (ux + 0.5) * z;
      const y = oy + (uy + 0.5) * z;
      const S = (base * GLYPHS[u.type].len) / 2;
      if (x < -40 || y < -40 || x > cam.viewW + 40 || y > cam.viewH + 40) continue;
      const own = me > 0 && u.owner === me;
      // far out, units less than a pixel apart are drawn once (your own and the cargo carriers always)
      if (z < 1 && !own && u.type !== 'transport' && u.type !== 'transportPlane') {
        const key = (Math.floor(x) + 64) * 16384 + Math.floor(y) + 64;
        if (taken.has(key)) continue;
        taken.add(key);
      }
      let angle = 0;
      if (t) {
        // ease the drawn heading toward the real one (no snapping on path corners)
        let d = t.angle - t.shown;
        while (d > Math.PI) d -= 2 * Math.PI;
        while (d < -Math.PI) d += 2 * Math.PI;
        t.shown += d * 0.25;
        angle = t.shown;
      }
      visible.push({ u, t, x, y, S, angle });
    }
    if (z >= 0.45) this.drawTrails(ctx, visible, ox, oy, z, frac);
    // glyphs: one dark under-stroke, one faint fill and one colour stroke per owner
    const lw = strokePx(z);
    const byOwner = new Map<number, Vis[]>();
    for (const e of visible) {
      const l = byOwner.get(e.u.owner);
      if (l) l.push(e);
      else byOwner.set(e.u.owner, [e]);
    }
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
    for (const [owner, list] of byOwner) {
      const c = colors[owner] ?? [200, 200, 200];
      for (let pass = 0; pass < 3; pass++) {
        ctx.beginPath();
        for (const e of list) addGlyph(ctx, GLYPHS[e.u.type], e.x, e.y, Math.cos(e.angle), Math.sin(e.angle), e.S, pass === 1);
        if (pass === 0) {
          ctx.lineWidth = lw + 1.6;
          ctx.strokeStyle = UNDER;
          ctx.stroke();
        } else if (pass === 1) {
          ctx.fillStyle = css(c, 0.22);
          ctx.fill();
        } else {
          ctx.lineWidth = lw;
          ctx.strokeStyle = css(c);
          ctx.stroke();
        }
      }
      this.drawn += list.length;
    }
    // own warships: a thin ring, and they are clickable (hit area larger than the drawing)
    if (me > 0) {
      ctx.beginPath();
      for (const e of visible) {
        if (e.u.owner !== me || e.u.type !== 'warship') continue;
        ctx.moveTo(e.x + e.S + 3, e.y);
        ctx.arc(e.x, e.y, e.S + 3, 0, Math.PI * 2);
        this.hits.push(e.u.id, e.x, e.y, Math.max(14, e.S + 6));
      }
      ctx.lineWidth = 1;
      ctx.strokeStyle = 'rgba(255,255,255,0.45)';
      ctx.stroke();
    }
    // small troop pills on transports
    if (z >= 0.9) {
      for (const e of visible) {
        const u = e.u;
        if (u.type !== 'transport' && u.type !== 'transportPlane') continue;
        // army sizes are public (only the troop mix needs intel)
        const n = formatCount(armyTotal(u.troops));
        const toMe = me > 0 && u.owner !== me && state.map.owner[u.target] === me;
        const edge = u.owner === me ? '#ffe98a' : toMe ? '#ff6b5e' : css(colors[u.owner] ?? [200, 200, 200]);
        miniPill(ctx, e.x, e.y - e.S - 8, n, edge, u.owner === me ? 'up' : toMe ? 'down' : 'none');
      }
    }
    void dpr;
  }

  /** Parachutes drifting down around a drop point: line canopies in the owner's colour. */
  private drawDrops(ctx: CanvasRenderingContext2D, cam: Camera, colors: readonly RGB[], nowMs: number): void {
    const z = cam.zoom;
    let keep = 0;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const d of this.drops) {
      const t = (nowMs - d.born) / DROP_MS;
      if (t >= 1) continue;
      this.drops[keep++] = d;
      const c = cam.tileToScreen(d.x, d.y);
      const spread = Math.max(10, z * 2.4);
      if (c.x < -spread * 3 || c.y < -spread * 3 || c.x > cam.viewW + spread * 3 || c.y > cam.viewH + spread * 3) continue;
      const col = colors[d.owner] ?? [220, 220, 220];
      const size = clamp(z * 0.6, 5, 9);
      ctx.globalAlpha = t < 0.75 ? 1 : 1 - (t - 0.75) / 0.25;
      for (const pass of [0, 1]) {
        ctx.beginPath();
        for (let k = 0; k < CHUTES; k++) {
          const a = (k / CHUTES) * Math.PI * 2 + d.born * 0.001;
          const r = spread * (0.35 + 0.65 * ((k * 37) % 10) / 10);
          // fall from above onto the ground, swaying a little
          const x = c.x + Math.cos(a) * r + Math.sin(t * 6 + k) * size * 0.25;
          const y = c.y + Math.sin(a) * r * 0.6 - (1 - t) * spread * 1.6;
          const s = size * (1 - 0.3 * t);
          ctx.moveTo(x + s * 0.6, y - s * 0.5);
          ctx.arc(x, y - s * 0.5, s * 0.6, 0, Math.PI, true);
          ctx.moveTo(x - s * 0.6, y - s * 0.5);
          ctx.lineTo(x, y + s * 0.4);
          ctx.lineTo(x + s * 0.6, y - s * 0.5);
        }
        ctx.lineWidth = pass === 0 ? 3 : 1.4;
        ctx.strokeStyle = pass === 0 ? UNDER : css(col);
        ctx.stroke();
      }
    }
    this.drops.length = keep;
    ctx.globalAlpha = 1;
  }

  /** Short thin fading wakes behind ships and contrails behind aircraft and missiles: one stroke per age step. */
  private drawTrails(ctx: CanvasRenderingContext2D, visible: Vis[], ox: number, oy: number, z: number, frac: number): void {
    ctx.lineCap = 'round';
    ctx.lineWidth = 1;
    for (const ship of [true, false]) {
      for (let k = 0; k < TRAIL_STEPS; k++) {
        ctx.beginPath();
        let any = false;
        for (const e of visible) {
          const t = e.t;
          if (!t || t.hn < 2 + k) continue;
          const isShip = e.u.type === 'transport' || e.u.type === 'warship' || e.u.type === 'tradeShip';
          if (isShip !== ship) continue;
          // segment k: from history point k (k = 0: the drawn position) to k + 1
          const ax = k === 0 ? e.x : ox + (t.hx[k] + 0.5) * z;
          const ay = k === 0 ? e.y : oy + (t.hy[k] + 0.5) * z;
          const bx = ox + (t.hx[k + 1] + 0.5) * z;
          const by = oy + (t.hy[k + 1] + 0.5) * z;
          if ((ax - bx) * (ax - bx) + (ay - by) * (ay - by) < 0.25) continue;
          ctx.moveTo(ax, ay);
          ctx.lineTo(bx, by);
          any = true;
        }
        if (!any) continue;
        const fade = 1 - (k + frac * 0.5) / TRAIL_STEPS;
        ctx.strokeStyle = ship ? `rgba(235,245,255,${0.4 * fade})` : `rgba(255,255,255,${0.5 * fade})`;
        ctx.stroke();
      }
    }
  }
}

/** Small rounded label with a coloured edge for troop counts; `arrow` marks your own push (up) / an incoming one (down). */
function miniPill(ctx: CanvasRenderingContext2D, x: number, y: number, text: string, edge: string, arrow: 'up' | 'down' | 'none'): void {
  ctx.font = `500 9px ${MAP_NUM_FAMILY}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const ax = arrow === 'none' ? 0 : 7;
  const bw = ctx.measureText(text).width + 8 + ax;
  const bh = 12;
  const x0 = x - bw / 2;
  ctx.beginPath();
  ctx.roundRect(x0, y - bh / 2, bw, bh, 6);
  ctx.fillStyle = 'rgba(10,13,21,0.8)';
  ctx.fill();
  ctx.lineWidth = 1;
  ctx.strokeStyle = edge;
  ctx.stroke();
  if (arrow !== 'none') {
    const cx = x0 + 7;
    const d = arrow === 'up' ? -1 : 1;
    ctx.beginPath();
    ctx.moveTo(cx - 2.5, y - d * 1.5);
    ctx.lineTo(cx, y + d * 1.5);
    ctx.lineTo(cx + 2.5, y - d * 1.5);
    ctx.lineWidth = 1.4;
    ctx.stroke();
  }
  ctx.fillStyle = '#fff';
  ctx.fillText(text, x + ax / 2, y + 0.5);
}
