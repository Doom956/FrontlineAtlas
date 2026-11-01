// Mobile units on the map (ships, planes, missiles) as minimal line glyphs (unitGlyphs.ts): a thin stroke in the
// owner's colour over a dark under-stroke, rotated to the heading and interpolated between ticks. Small (7-11 px) so
// many units in one area stay readable; missiles trail a long fading contrail, planes a faint short one and ships a
// short V wake. A small troop pill on transports at mid/close zoom; your own warships carry a tiny tick (a ring only
// while one is hovered or picked, UnitLayer.focusId); they can be clicked to give orders, the hit area is larger than
// the drawing. At far zoom units on the same pixel are drawn once and only missiles keep their trails. Zoomed out
// (FLEET_ZOOM), warships of one owner within FLEET_RADIUS tiles (or 16 px on screen) draw as one fleet marker with a count badge
// (render/fleets.ts); a click on your own marker selects that fleet (ownFleetAt).
import { TICKS_PER_SECOND } from '../../sim/config';
import { armyTotal } from '../../sim/economy';
import type { GameState, Unit } from '../../sim/types';
import type { Camera } from '../camera';
import { clamp, css, formatCount, MAP_NUM_FAMILY, type RGB } from './common';
import { drawTrails, GLYPHS, type Inst, strokeGlyphs } from './unitGlyphs';
import { isIncoming } from '../forces';
import { unitVisibleTo } from '../../sim/techtree';
import { clusterFleets, FLEET_ZOOM, fleetRadiusPx, type FleetPoint } from './fleets';

const HIST = 3;
/** Paratroopers drifting down where a cargo plane arrived (client-only effect). */
const DROP_MS = 1800;
const CHUTES = 6;
const UNDER = 'rgba(6,9,15,0.6)';

/** Base glyph length on screen (CSS px) at a zoom level; each glyph scales it a little (unitGlyphs.ts). */
const glyphPx = (z: number): number => clamp(7 + z * 1.2, 8, 10);
const strokePx = (z: number): number => clamp(1.2 + z * 0.15, 1.25, 1.7);

/** `fleet`: this entry is a fleet marker standing for these ships (the lead, u, is the lowest id). */
type Vis = Inst & { u: Unit; fleet?: number[] };

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
  /** own warships and tank divisions drawn last frame: id, screen x, y, radius */
  private hits: number[] = [];
  /** every unit drawn last frame: id, screen x, y, radius (hover cards for any unit) */
  private allHits: number[] = [];
  /** own fleet markers drawn last frame: member ids, screen x, y, radius */
  private fleetHits: { ids: number[]; x: number; y: number; r: number }[] = [];
  /** fleet markers drawn last frame (stats / tests) */
  fleets = 0;
  /** cargo planes that reached their drop tile: where and when, for the parachutes */
  private drops: { x: number; y: number; owner: number; born: number }[] = [];
  private planes = new Map<number, { tx: number; ty: number; owner: number }>();
  drawn = 0;
  /** Own warship to ring (hovered or picked); set by the renderer, -1 for none. */
  focusId = -1;
  /** Selected own units (warships, tank divisions) to ring; set by the renderer from ui.selection. */
  selected: ReadonlySet<number> = new Set();

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

  /** Id of your own warship or tank division drawn under the screen point, or -1. */
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

  /** The ships of your own fleet marker under the screen point (zoomed out), or null. */
  ownFleetAt(sx: number, sy: number): number[] | null {
    let best: number[] | null = null;
    let bd = Infinity;
    for (const f of this.fleetHits) {
      const d = (f.x - sx) ** 2 + (f.y - sy) ** 2;
      if (d <= f.r * f.r && d < bd) {
        bd = d;
        best = f.ids;
      }
    }
    return best;
  }

  /** Ids of your own warships and tank divisions drawn inside a screen rectangle (Shift+drag box selection). */
  ownUnitsIn(x0: number, y0: number, x1: number, y1: number): number[] {
    const lx = Math.min(x0, x1);
    const hx = Math.max(x0, x1);
    const ly = Math.min(y0, y1);
    const hy = Math.max(y0, y1);
    const out: number[] = [];
    const h = this.hits;
    for (let k = 0; k < h.length; k += 4) if (h[k + 1] >= lx && h[k + 1] <= hx && h[k + 2] >= ly && h[k + 2] <= hy) out.push(h[k]);
    return out;
  }

  /** Id of any unit drawn under the screen point (the closest), or -1. */
  unitAt(sx: number, sy: number): number {
    let best = -1;
    let bd = Infinity;
    const h = this.allHits;
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

  /** Where a unit was drawn last frame (screen px), or null when it was off screen. */
  screenOf(id: number): { x: number; y: number } | null {
    const h = this.allHits;
    for (let k = 0; k < h.length; k += 4) if (h[k] === id) return { x: h[k + 1], y: h[k + 2] };
    return null;
  }

  draw(ctx: CanvasRenderingContext2D, state: GameState, cam: Camera, frac: number, colors: readonly RGB[], humanId: number, dpr: number, nowMs: number): void {
    this.drawn = 0;
    this.hits.length = 0;
    this.allHits.length = 0;
    this.fleetHits.length = 0;
    this.fleets = 0;
    if (this.drops.length) this.drawDrops(ctx, cam, colors, nowMs);
    if (state.units.length === 0) return;
    const z = cam.zoom;
    const ox = cam.viewW / 2 - cam.x * z;
    const oy = cam.viewH / 2 - cam.y * z;
    const me = humanId;
    const base = glyphPx(z);
    let visible: Vis[] = [];
    const taken = new Set<number>();
    const grouping = z < FLEET_ZOOM;
    for (const u of state.units) {
      const t = this.tracks.get(u.id);
      const ux = t ? t.px + (t.cx - t.px) * frac : u.x;
      const uy = t ? t.py + (t.cy - t.py) * frac : u.y;
      const x = ox + (ux + 0.5) * z;
      const y = oy + (uy + 0.5) * z;
      const S = (base * GLYPHS[u.type].len) / 2;
      if (x < -40 || y < -40 || x > cam.viewW + 40 || y > cam.viewH + 40) continue;
      // enemy submarines stay hidden until close, sonar, recon or Early Warning shows them (techtree.unitVisibleTo)
      if (u.variant === 'submarine' && me > 0 && !unitVisibleTo(state, me, u)) continue;
      const own = me > 0 && u.owner === me;
      // far out, units less than a pixel apart are drawn once (your own and the cargo carriers always)
      if (z < 1 && !own && u.type !== 'transport' && u.type !== 'transportPlane' && u.type !== 'warship') {
        const key = (Math.floor(x) + 64) * 16384 + Math.floor(y) + 64;
        if (taken.has(key)) continue;
        taken.add(key);
      }
      let angle = 0;
      let moving = false;
      if (t) {
        // ease the drawn heading toward the real one (no snapping on path corners)
        let d = t.angle - t.shown;
        while (d > Math.PI) d -= 2 * Math.PI;
        while (d < -Math.PI) d += 2 * Math.PI;
        t.shown += d * 0.25;
        angle = t.shown;
        moving = t.hn >= 2 && Math.abs(t.hx[0] - t.hx[1]) + Math.abs(t.hy[0] - t.hy[1]) > 1e-4;
      }
      visible.push({ u, type: u.type, x, y, S, angle, moving });
    }
    // zoomed out: close warships of one owner become one marker (screen px, so the radius scales with the zoom)
    if (grouping) {
      const pts: FleetPoint[] = [];
      for (const e of visible) if (e.type === 'warship') pts.push({ id: e.u.id, owner: e.u.owner, x: e.x, y: e.y });
      const fleets = pts.length > 1 ? clusterFleets(pts, fleetRadiusPx(z)) : [];
      if (fleets.length) {
        const byId = new Map<number, Vis>();
        for (const e of visible) if (e.type === 'warship') byId.set(e.u.id, e);
        const gone = new Set<number>();
        const marks: Vis[] = [];
        for (const f of fleets) {
          const lead = byId.get(f.ids[0])!;
          for (const id of f.ids) gone.add(id);
          marks.push({ u: lead.u, type: 'warship', x: f.x, y: f.y, S: lead.S * 1.25, angle: lead.angle, moving: false, fleet: f.ids });
        }
        visible = visible.filter((e) => e.type !== 'warship' || !gone.has(e.u.id));
        visible.push(...marks);
        this.fleets = marks.length;
      }
    }
    for (const e of visible) {
      const r = Math.max(10, e.S + 5);
      if (e.fleet) for (const id of e.fleet) this.allHits.push(id, e.x, e.y, r);
      else this.allHits.push(e.u.id, e.x, e.y, r);
    }
    drawTrails(ctx, visible, z >= 0.45);
    // glyphs: one dark under-stroke, one faint fill, one colour stroke (and solid cargo blocks) per owner
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
      strokeGlyphs(ctx, list, css(c), css(c, 0.22), UNDER, lw);
      this.drawn += list.length;
    }
    // own warships and tank divisions: a tiny white tick under the hull, a ring while hovered, picked or selected
    // (selection.ts); clickable (hit area larger than the drawing)
    if (me > 0) {
      ctx.beginPath();
      let ring = false;
      for (const e of visible) {
        if (e.u.owner !== me || (e.type !== 'warship' && e.type !== 'tankDivision')) continue;
        const r = e.S + 3;
        const ids = e.fleet;
        if (ids ? ids.some((id) => id === this.focusId || this.selected.has(id)) : e.u.id === this.focusId || this.selected.has(e.u.id)) {
          ctx.moveTo(e.x + r, e.y);
          ctx.arc(e.x, e.y, r, 0, Math.PI * 2);
          ring = true;
        } else {
          ctx.moveTo(e.x - 2, e.y + e.S * 0.5 + 3);
          ctx.lineTo(e.x + 2, e.y + e.S * 0.5 + 3);
        }
        if (ids) {
          // every ship of the fleet sits under the marker (box selection, hover); a click takes the whole fleet
          for (const id of ids) this.hits.push(id, e.x, e.y, Math.max(14, e.S + 6));
          this.fleetHits.push({ ids, x: e.x, y: e.y, r: Math.max(14, e.S + 6) });
        } else this.hits.push(e.u.id, e.x, e.y, Math.max(14, e.S + 6));
      }
      ctx.lineWidth = ring ? 1.25 : 1.5;
      ctx.strokeStyle = 'rgba(255,255,255,0.75)';
      ctx.stroke();
    }
    // hostile transports, bombers, cargo planes and missiles coming at you: a thin red ring that breathes a little
    if (me > 0) {
      ctx.beginPath();
      let any = false;
      for (const e of visible) {
        if (!isIncoming(state, me, e.u)) continue;
        const r = e.S + 4;
        ctx.moveTo(e.x + r, e.y);
        ctx.arc(e.x, e.y, r, 0, Math.PI * 2);
        any = true;
      }
      if (any) {
        ctx.lineWidth = 1.25;
        ctx.strokeStyle = `rgba(255,107,94,${(0.45 + 0.25 * Math.sin(nowMs / 260)).toFixed(3)})`;
        ctx.stroke();
      }
    }
    // fleet markers: the number of ships in a small badge at the top right (owner-coloured edge)
    if (this.fleets) {
      for (const e of visible) {
        if (!e.fleet) continue;
        const c = colors[e.u.owner] ?? [200, 200, 200];
        countBadge(ctx, e.x + e.S * 0.9, e.y - e.S * 0.9, String(e.fleet.length), me > 0 && e.u.owner === me ? '#ffe98a' : css(c));
      }
    }
    // transports: a small troop pill and, on cargo planes, a tiny parachute mark (mid and close zoom)
    if (z >= 2) {
      for (const e of visible) {
        const u = e.u;
        if (e.type !== 'transport' && e.type !== 'transportPlane') continue;
        // army sizes are public (only the troop mix needs intel)
        const n = formatCount(armyTotal(u.troops));
        const toMe = me > 0 && u.owner !== me && state.map.owner[u.target] === me;
        const edge = u.owner === me ? '#ffe98a' : toMe ? '#ff6b5e' : css(colors[u.owner] ?? [200, 200, 200]);
        miniPill(ctx, e.x, e.y - e.S - 7, n, edge, u.owner === me ? 'up' : toMe ? 'down' : 'none');
        if (e.type === 'transportPlane') chute(ctx, e.x + e.S + 4, e.y + e.S * 0.6 + 4, css(colors[u.owner] ?? [200, 200, 200]));
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
}

/** Tiny parachute (canopy arc + two strings) marking a cargo plane. */
function chute(ctx: CanvasRenderingContext2D, x: number, y: number, color: string): void {
  for (const pass of [0, 1]) {
    ctx.beginPath();
    ctx.moveTo(x - 3, y);
    ctx.arc(x, y, 3, Math.PI, 0);
    ctx.moveTo(x - 3, y);
    ctx.lineTo(x, y + 4.5);
    ctx.lineTo(x + 3, y);
    ctx.lineWidth = pass === 0 ? 2.8 : 1.2;
    ctx.strokeStyle = pass === 0 ? UNDER : color;
    ctx.stroke();
  }
}

/** A fleet's ship count: a small round badge (a pill for 10+). */
function countBadge(ctx: CanvasRenderingContext2D, x: number, y: number, text: string, edge: string): void {
  ctx.font = `600 9px ${MAP_NUM_FAMILY}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const bh = 12;
  const bw = Math.max(bh, ctx.measureText(text).width + 6);
  ctx.beginPath();
  ctx.roundRect(x - bw / 2, y - bh / 2, bw, bh, bh / 2);
  ctx.fillStyle = 'rgba(10,13,21,0.88)';
  ctx.fill();
  ctx.lineWidth = 1;
  ctx.strokeStyle = edge;
  ctx.stroke();
  ctx.fillStyle = '#fff';
  ctx.fillText(text, x, y + 0.5);
}

/** Small rounded label with a coloured edge for troop counts; `arrow` marks your own push (up) / an incoming one (down). */
function miniPill(ctx: CanvasRenderingContext2D, x: number, y: number, text: string, edge: string, arrow: 'up' | 'down' | 'none'): void {
  ctx.font = `500 9px ${MAP_NUM_FAMILY}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const ax = arrow === 'none' ? 0 : 6;
  const bw = ctx.measureText(text).width + 6 + ax;
  const bh = 11;
  const x0 = x - bw / 2;
  ctx.beginPath();
  ctx.roundRect(x0, y - bh / 2, bw, bh, 5.5);
  ctx.fillStyle = 'rgba(10,13,21,0.8)';
  ctx.fill();
  ctx.lineWidth = 1;
  ctx.strokeStyle = edge;
  ctx.stroke();
  if (arrow !== 'none') {
    const cx = x0 + 6;
    const d = arrow === 'up' ? -1 : 1;
    ctx.beginPath();
    ctx.moveTo(cx - 2, y - d * 1.2);
    ctx.lineTo(cx, y + d * 1.2);
    ctx.lineTo(cx + 2, y - d * 1.2);
    ctx.lineWidth = 1.3;
    ctx.stroke();
  }
  ctx.fillStyle = '#fff';
  ctx.fillText(text, x + ax / 2, y + 0.5);
}
