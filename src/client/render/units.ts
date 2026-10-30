// Mobile units on the map (ships, planes, missiles): literal pictures from icons.ts, tinted in the owner's colour
// with a white halo and a dark drop shadow, rotated to their heading and interpolated between ticks. At least
// MIN_PX on screen at any zoom (bigger when zoomed in), a wake behind ships and a contrail behind planes and missiles,
// a troop pill on transports, a ring around your own warships (they can be clicked to give orders).
import { TICKS_PER_SECOND } from '../../sim/config';
import { armyTotal } from '../../sim/economy';
import type { GameState, Unit, UnitType } from '../../sim/types';
import type { Camera } from '../camera';
import { iconCanvas, iconSilhouette } from '../icons';
import { clamp, css, formatCount, pill, type RGB } from './common';

const HIST = 8;
/** Length on the map in tiles, and the smallest size on screen (CSS px). */
const LEN: Record<UnitType, { tiles: number; min: number }> = {
  transport: { tiles: 3.4, min: 32 },
  warship: { tiles: 4.2, min: 36 },
  tradeShip: { tiles: 3.6, min: 30 },
  bomber: { tiles: 4, min: 36 },
  fighter: { tiles: 2.8, min: 28 },
  rocket: { tiles: 2.6, min: 26 },
  atomBomb: { tiles: 3.2, min: 32 },
  transportPlane: { tiles: 4, min: 36 },
};
/** Paratroopers drifting down where a cargo plane arrived (client-only effect). */
const DROP_MS = 1800;
const CHUTES = 6;
const MAX_PX = 96;
/** Sprite resolutions (CSS px); a unit uses the smallest one at least as big as it is drawn. */
const BUCKETS = [24, 40, 64, 96];

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
    // Pass 1: trails (batched per age step), pass 2: shadows + sprites, pass 3: pills.
    const visible: { u: Unit; t: Track | undefined; x: number; y: number; size: number; angle: number }[] = [];
    for (const u of state.units) {
      const t = this.tracks.get(u.id);
      const ux = t ? t.px + (t.cx - t.px) * frac : u.x;
      const uy = t ? t.py + (t.cy - t.py) * frac : u.y;
      const x = ox + (ux + 0.5) * z;
      const y = oy + (uy + 0.5) * z;
      const L = LEN[u.type];
      // at least ~16 px on the whole-map view, the full minimum from mid zoom on
      const size = clamp(L.tiles * z, z < 1.5 ? Math.max(18, L.min * 0.66) : L.min, MAX_PX);
      if (x < -size * 3 || y < -size * 3 || x > cam.viewW + size * 3 || y > cam.viewH + size * 3) continue;
      let angle = 0;
      if (t) {
        // ease the drawn heading toward the real one (no snapping on path corners)
        let d = t.angle - t.shown;
        while (d > Math.PI) d -= 2 * Math.PI;
        while (d < -Math.PI) d += 2 * Math.PI;
        t.shown += d * 0.25;
        angle = t.shown;
      }
      visible.push({ u, t, x, y, size, angle });
    }
    this.drawTrails(ctx, visible, ox, oy, z, frac);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'medium';
    for (const e of visible) {
      const { u, x, y, size, angle } = e;
      const c = colors[u.owner] ?? [200, 200, 200];
      const bucket = BUCKETS.find((b) => b >= size) ?? BUCKETS[BUCKETS.length - 1];
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      const half = size / 2;
      const off = Math.max(1.5, size * 0.07);
      // own warships: a subtle ring, and they are clickable
      if (me > 0 && u.owner === me && u.type === 'warship') {
        ctx.beginPath();
        ctx.arc(x, y, half * 0.82, 0, Math.PI * 2);
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = 'rgba(255,255,255,0.55)';
        ctx.setLineDash([4, 3]);
        ctx.stroke();
        ctx.setLineDash([]);
        this.hits.push(u.id, x, y, Math.max(14, half));
      }
      ctx.setTransform(dpr * cos, dpr * sin, -dpr * sin, dpr * cos, dpr * (x + off * 0.6), dpr * (y + off));
      ctx.globalAlpha = 0.42;
      ctx.drawImage(iconSilhouette(u.type, bucket, '#05070b', { dpr }), -half, -half, size, size);
      ctx.globalAlpha = 1;
      ctx.setTransform(dpr * cos, dpr * sin, -dpr * sin, dpr * cos, dpr * x, dpr * y);
      ctx.drawImage(iconCanvas(u.type, bucket, { tint: c, outline: true, dpr }), -half, -half, size, size);
      this.drawn++;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // troop pills on transports
    if (z >= 0.9) {
      for (const e of visible) {
        const u = e.u;
        if (u.type !== 'transport' && u.type !== 'transportPlane') continue;
        // army sizes are public (only the troop mix needs intel)
        const n = formatCount(armyTotal(u.troops));
        const toMe = me > 0 && u.owner !== me && state.map.owner[u.target] === me;
        const edge = u.owner === me ? '#ffe98a' : toMe ? '#ff6b5e' : css(colors[u.owner] ?? [200, 200, 200]);
        pill(ctx, e.x, e.y - e.size * 0.62 - 9, n, edge, u.owner === me ? 'up' : toMe ? 'down' : 'none');
      }
    }
    void nowMs;
  }

  /** Parachutes drifting down around a drop point, in the owner's colour. */
  private drawDrops(ctx: CanvasRenderingContext2D, cam: Camera, colors: readonly RGB[], nowMs: number): void {
    const z = cam.zoom;
    let keep = 0;
    for (const d of this.drops) {
      const t = (nowMs - d.born) / DROP_MS;
      if (t >= 1) continue;
      this.drops[keep++] = d;
      const c = cam.tileToScreen(d.x, d.y);
      const spread = Math.max(10, z * 2.4);
      if (c.x < -spread * 3 || c.y < -spread * 3 || c.x > cam.viewW + spread * 3 || c.y > cam.viewH + spread * 3) continue;
      const col = colors[d.owner] ?? [220, 220, 220];
      const size = clamp(z * 1.1, 7, 15);
      ctx.globalAlpha = t < 0.75 ? 1 : 1 - (t - 0.75) / 0.25;
      for (let k = 0; k < CHUTES; k++) {
        const a = (k / CHUTES) * Math.PI * 2 + d.born * 0.001;
        const r = spread * (0.35 + 0.65 * ((k * 37) % 10) / 10);
        // fall from above onto the ground, swaying a little
        const x = c.x + Math.cos(a) * r + Math.sin(t * 6 + k) * size * 0.25;
        const y = c.y + Math.sin(a) * r * 0.6 - (1 - t) * spread * 1.6;
        const s = size * (1 - 0.35 * t);
        ctx.beginPath();
        ctx.arc(x, y - s * 0.55, s * 0.6, Math.PI, 0);
        ctx.closePath();
        ctx.fillStyle = '#f1ede2';
        ctx.fill();
        ctx.lineWidth = 1.2;
        ctx.strokeStyle = css(col);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(x - s * 0.58, y - s * 0.55);
        ctx.lineTo(x, y + s * 0.25);
        ctx.lineTo(x + s * 0.58, y - s * 0.55);
        ctx.lineWidth = 0.8;
        ctx.strokeStyle = 'rgba(20,22,26,0.8)';
        ctx.stroke();
        ctx.fillStyle = css(col);
        ctx.fillRect(x - s * 0.13, y + s * 0.15, s * 0.26, s * 0.34);
      }
    }
    this.drops.length = keep;
    ctx.globalAlpha = 1;
  }

  /** Wakes behind ships and contrails behind aircraft and missiles: one stroke per age step for all units. */
  private drawTrails(
    ctx: CanvasRenderingContext2D,
    visible: { u: Unit; t: Track | undefined; x: number; y: number; size: number; angle: number }[],
    ox: number,
    oy: number,
    z: number,
    frac: number,
  ): void {
    const steps = HIST - 1;
    for (const ship of [true, false]) {
      for (let k = 0; k < steps; k++) {
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
        const fade = 1 - (k + frac * 0.5) / steps;
        ctx.lineCap = 'round';
        if (ship) {
          ctx.lineWidth = clamp(z * 0.9, 3, 9) * (0.6 + 0.4 * fade);
          ctx.strokeStyle = `rgba(225,240,255,${0.32 * fade})`;
        } else {
          ctx.lineWidth = clamp(z * 0.35, 1.5, 3.5);
          ctx.strokeStyle = `rgba(255,255,255,${0.5 * fade})`;
        }
        ctx.stroke();
      }
    }
    // ship bow waves: a V opening behind each moving ship
    ctx.beginPath();
    for (const e of visible) {
      const u = e.u;
      if (u.type !== 'transport' && u.type !== 'warship' && u.type !== 'tradeShip') continue;
      const t = e.t;
      if (!t || (t.cx === t.px && t.cy === t.py)) continue;
      const c = Math.cos(e.angle);
      const s = Math.sin(e.angle);
      const L = e.size * 0.5;
      const bx = e.x + c * L * 0.7;
      const by = e.y + s * L * 0.7;
      for (const side of [-1, 1]) {
        ctx.moveTo(bx, by);
        ctx.lineTo(e.x - c * L * 1.5 - s * side * L * 0.55, e.y - s * L * 1.5 + c * side * L * 0.55);
      }
    }
    ctx.lineWidth = 1.3;
    ctx.strokeStyle = 'rgba(235,245,255,0.38)';
    ctx.stroke();
  }
}
