// Mobile units on the map (ships, tanks, planes, missiles), interpolated between ticks. From NEAR_ZOOM in, each unit
// is drawn by the current art style of its category (art/registry.ts through pixelSprites.ts drawMapSprite; the
// refined pixel sprites are art/refined/sprites.ts): the style gets the unit's heading, how fast it turns (planes
// bank), its speed (wake size), the zoom and a clock for animation. The owner's colour is a plate or band, never a
// tint. Planes and missiles cast a short ground shadow. Far out, every unit is a tiny solid marker in the owner's
// colour (shared by every style). Missiles and planes leave contrails and moving ships a wake, drawn by the styles of
// the 'contrails' and 'wakes' categories (one trail layer per style, anchored to the map). Paratroopers coming down
// where a cargo plane dropped its troops, and the parachute mark on cargo planes, are drawn by the 'paradrop' style.
// A small troop pill on transports at mid/close zoom; your own warships carry a tiny tick (a ring only while one is
// hovered or picked, UnitLayer.focusId); they can be clicked to give orders, the hit area is
// larger than the drawing. At far zoom units on the same pixel are drawn once and only missiles keep their trails.
// Zoomed out (FLEET_ZOOM), warships of one owner within FLEET_RADIUS tiles (or 16 px on screen) draw as one fleet
// marker with a count badge (render/fleets.ts); a click on your own marker selects that fleet (ownFleetAt).
import { TICKS_PER_SECOND } from '../../sim/config';
import { armyTotal } from '../../sim/economy';
import type { GameState, Unit } from '../../sim/types';
import type { Camera } from '../camera';
import { clamp, css, MAP_NUM_FAMILY, type RGB } from './common';
import { GLYPHS, strokeDucks, type Inst } from './unitGlyphs';
import { drawMapSprite, drawUnitMarker, isAirType, setSpriteBakeBudget, spriteLength, unitDamage, unitSpriteMods, type MapSpriteState } from './pixelSprites';
import { artStyleOf, type ArtStyle } from '../art/artStyle';
import { artFor, motionFor, styleModule } from '../art/registry';
import { spriteKey } from '../art/shared/keys';
import type { ParachuteMarkDraw, ParadropDraw, TrailLayer, TrailUnit, TrailView } from '../art/types';
import { prankView } from '../fx/prankView';
import { isKillBlast, KILL_EXACT } from '../fx/deaths';
import { isIncoming } from '../forces';
import { troopKinds, troopPill } from './troopIcons';
import { hasIntel } from '../../sim/buildings';
import { unitVisibleTo } from '../../sim/techtree';
import type { FogView } from '../fog/fogView';
import { clusterFleets, FLEET_ZOOM, fleetRadiusPx, type FleetPoint } from './fleets';

const HIST = 3;
/** Paratroopers drifting down where a cargo plane arrived (client-only effect, drawn by the 'paradrop' art style). */
const CHUTES = 6;
const UNDER = 'rgba(6,9,15,0.6)';

/** Levels of detail: below NEAR_ZOOM every unit is a tiny solid marker (and warships merge into fleet markers with a
 * count, fleets.ts); from NEAR_ZOOM on each unit is its shaded pixel sprite (pixelSprites.ts), one art pixel per screen
 * px at mid zoom, then 2, 3 and 4 px per art pixel as the camera comes closer (whole numbers keep the pixels crisp,
 * and every unit on screen shares the same pixel size). */
const NEAR_ZOOM = 3;
/** Screen px per art pixel of the unit sprites at zoom z. */
export function spriteScale(z: number): number {
  return z < 11 ? 1 : z < 22 ? 2 : z < 32 ? 3 : 4;
}
/** Sprites baked per frame at most (the rest show their marker for a frame or two). */
const BAKES_PER_FRAME = 24;
/** Base unit length on screen (CSS px) at a zoom level; each unit scales it a little (unitGlyphs.ts len). */
const glyphPx = (z: number): number => (z < NEAR_ZOOM ? clamp(6 + z * 1.1, 7, 9) : clamp(12 + (z - NEAR_ZOOM) * 3.2, 14, 48));

/** `fleet`: this entry is a fleet marker standing for these ships (the lead, u, is the lowest id). */
type Vis = Inst & { u: Unit; fleet?: number[]; turn: number; speed: number };

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
  /** how fast the drawn heading turns (rad/s, smoothed) and when it was last eased (ms) */
  turn: number;
  at: number;
}

/**
 * True when the sim's kill blast (fx/deaths.ts) lies exactly at (x, y), stamped `fromTick` or later (read-only): the
 * sim puts it at the centre of the unit it destroyed, stamped with the tick that removed it (the last tick the unit was
 * seen), so only a blast on that very spot, in the tick it vanished, means this plane was shot down. Another plane shot down beside it, or near its drop point, is not this plane's.
 */
function killBlastAt(state: GameState, x: number, y: number, fromTick: number): boolean {
  const fx = state.effects;
  for (let i = fx.length - 1, n = 0; i >= 0 && n < 400; i--, n++) {
    const e = fx[i];
    if (e.tick < fromTick) break;
    if (e.kind === 'explosion' && isKillBlast(e.radius) && Math.abs(e.x - x) < KILL_EXACT && Math.abs(e.y - y) < KILL_EXACT) return true;
  }
  return false;
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
  private planes = new Map<number, { tx: number; ty: number; owner: number; unit: Unit }>();
  drawn = 0;
  /** Own warship to ring (hovered or picked); set by the renderer, -1 for none. */
  focusId = -1;
  /** Selected own units (warships, tank divisions) to ring; set by the renderer from ui.selection. */
  selected: ReadonlySet<number> = new Set();
  /** live wakes and contrails, one layer per art style that drew them (art/types.ts TrailLayer) */
  private trailLayers = new Map<string, TrailLayer>();
  private wakeList: TrailUnit[] = [];
  private contrailList: TrailUnit[] = [];

  reset(w: number): void {
    this.tracks.clear();
    this.lastTick = -1;
    this.w = w;
    this.hits = [];
    this.drops = [];
    this.planes.clear();
    for (const l of this.trailLayers.values()) l.clear();
  }

  /** The trail layer of the current style of wakes or contrails (made on first use, kept while the game runs). */
  private trailLayer(cat: 'wakes' | 'contrails', style: ArtStyle): TrailLayer {
    const k = `${cat}|${style}`;
    let l = this.trailLayers.get(k);
    if (!l) this.trailLayers.set(k, (l = styleModule(style)[cat].createLayer()));
    return l;
  }

  /** The heading a unit's sprite was drawn at last (snapped to its 16 baked facings), or null. */
  headingOf(id: number): number | null {
    const t = this.tracks.get(id);
    if (!t) return null;
    const step = Math.PI / 8;
    return Math.round(t.shown / step) * step;
  }

  /** The heading a unit's sprite was drawn at last (eased, not snapped), or null; a unit gone this tick still has it until track(). */
  angleOf(id: number): number | null {
    return this.tracks.get(id)?.shown ?? null;
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
  /** fog of war view (set by the renderer each frame; null or inactive = no fog) */
  fog: FogView | null = null;

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
        t = { px: u.x, py: u.y, cx: u.x, cy: u.y, angle: a, shown: a, seen: state.tick, hx: new Float32Array(HIST), hy: new Float32Array(HIST), hn: 0, turn: 0, at: -1 };
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
      // a cargo plane that vanished close to its target dropped its troops: parachutes there, unless it was shot down:
      // the sim's kill blast exactly where it was when it vanished (the unit keeps that last position), in the tick
      // it vanished; its paratroopers went down with it
      const pl = this.planes.get(id);
      if (pl) {
        const lx = pl.unit.x + 0.5;
        const ly = pl.unit.y + 0.5;
        if (Math.abs(lx - pl.tx) + Math.abs(ly - pl.ty) < 6 && !killBlastAt(state, lx, ly, t.seen)) this.drops.push({ x: pl.tx, y: pl.ty, owner: pl.owner, born: nowMs });
      }
      this.planes.delete(id);
      this.tracks.delete(id);
    }
    for (const u of state.units) {
      if (u.type === 'transportPlane' && u.state === 0 && (!this.fog?.active || this.fog.unitShown(state, u))) this.planes.set(u.id, { tx: (u.target % w) + 0.5, ty: ((u.target / w) | 0) + 0.5, owner: u.owner, unit: u });
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
    if (this.drops.length) this.drawDrops(ctx, cam, colors, dpr, nowMs);
    if (state.units.length === 0) return;
    const z = cam.zoom;
    const ox = cam.viewW / 2 - cam.x * z;
    const oy = cam.viewH / 2 - cam.y * z;
    const me = humanId;
    const fog = this.fog?.active ? this.fog : null;
    const base = glyphPx(z);
    const near = z >= NEAR_ZOOM;
    const k = spriteScale(z);
    let visible: Vis[] = [];
    const taken = new Set<number>();
    const grouping = z < FLEET_ZOOM;
    for (const u of state.units) {
      const t = this.tracks.get(u.id);
      const ux = t ? t.px + (t.cx - t.px) * frac : u.x;
      const uy = t ? t.py + (t.cy - t.py) * frac : u.y;
      const x = ox + (ux + 0.5) * z;
      const y = oy + (uy + 0.5) * z;
      // half length on screen: the sprite's own length close up, the marker's size far out
      const S = near ? Math.max(6, spriteLength(u.type, u.variant, 0, k) / 2) : (base * GLYPHS[u.type].len) / 2;
      const m = Math.max(40, S + 8);
      if (x < -m || y < -m || x > cam.viewW + m || y > cam.viewH + m) continue;
      // enemy submarines stay hidden until close, sonar, recon or Early Warning shows them (techtree.unitVisibleTo)
      if (u.variant === 'submarine' && me > 0 && !unitVisibleTo(state, me, u)) continue;
      // fog of war: other nations' units only where you see them (fog/fogView.ts); hit tests follow
      if (fog && !fog.unitShown(state, u)) continue;
      const own = me > 0 && u.owner === me;
      // far out, units less than a pixel apart are drawn once (your own and the cargo carriers always)
      if (z < 1 && !own && u.type !== 'transport' && u.type !== 'transportPlane' && u.type !== 'warship') {
        const key = (Math.floor(x) + 64) * 16384 + Math.floor(y) + 64;
        if (taken.has(key)) continue;
        taken.add(key);
      }
      let angle = 0;
      let moving = false;
      let turn = 0;
      let speed = 0;
      if (t) {
        // ease the drawn heading toward the real one (no snapping on path corners)
        let d = t.angle - t.shown;
        while (d > Math.PI) d -= 2 * Math.PI;
        while (d < -Math.PI) d += 2 * Math.PI;
        t.shown += d * 0.25;
        angle = t.shown;
        // the turn rate the art sees (planes bank with it): the eased change per second, smoothed over a few frames
        const dt = t.at >= 0 ? nowMs - t.at : 0;
        if (dt > 0 && dt < 250) t.turn += ((d * 0.25 * 1000) / dt - t.turn) * 0.2;
        else if (dt >= 250) t.turn = 0;
        t.at = nowMs;
        turn = t.turn;
        moving = t.hn >= 2 && Math.abs(t.hx[0] - t.hx[1]) + Math.abs(t.hy[0] - t.hy[1]) > 1e-4;
        if (t.hn >= 2) speed = Math.hypot(t.hx[0] - t.hx[1], t.hy[0] - t.hy[1]) * TICKS_PER_SECOND;
      }
      visible.push({ u, type: u.type, x, y, S, angle, moving, id: u.id, tx: ux + 0.5, ty: uy + 0.5, turn, speed });
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
          marks.push({ u: lead.u, type: 'warship', x: f.x, y: f.y, S: lead.S * 1.25, angle: lead.angle, moving: false, fleet: f.ids, turn: 0, speed: 0 });
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
    // contrails and wakes, left where the unit went (missiles at every zoom, planes and ships from the middle zooms on)
    this.drawTrailLayers(ctx, visible, { ox, oy, zoom: z, scale: k, now: nowMs, viewW: cam.viewW, viewH: cam.viewH, dpr, full: z >= 2 });
    // far: one small solid marker per unit; mid and near: the unit's shaded pixel sprite (16 baked headings, whole
    // pixel scale): ships and tanks first, then planes, then missiles on top
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
    const drawList = prankView.ducks ? this.drawDucks(ctx, visible, colors, z) : visible;
    if (near) {
      setSpriteBakeBudget(BAKES_PER_FRAME);
      const ss = this.spriteState;
      ss.zoom = z;
      ss.scale = k;
      ss.dpr = dpr;
      ss.timeMs = nowMs;
      try {
        for (const pass of [0, 1, 2]) {
          for (const e of drawList) {
            const air = isAirType(e.type);
            const missile = e.type === 'rocket' || e.type === 'atomBomb';
            if ((pass === 0 && air) || (pass === 1 && (!air || missile)) || (pass === 2 && !missile)) continue;
            const c = colors[e.u.owner] ?? [200, 200, 200];
            ss.turnRate = e.turn;
            ss.speed = e.speed;
            ss.moving = !!e.moving;
            ss.seed = e.u.id;
            ss.damage = e.fleet ? 0 : unitDamage(e.u);
            if (e.fleet || !drawMapSprite(ctx, e.type, e.u.variant, e.x, e.y, e.angle, c, unitSpriteMods(state, e.u), ss)) drawUnitMarker(ctx, e.type, e.x, e.y, e.fleet ? e.S * 1.6 : Math.min(14, e.S * 1.5), e.angle, css(c));
          }
        }
      } finally {
        setSpriteBakeBudget(Infinity);
      }
    } else {
      for (const e of drawList) {
        const c = colors[e.u.owner] ?? [200, 200, 200];
        drawUnitMarker(ctx, e.type, e.x, e.y, e.fleet ? e.S * 1.6 : e.S * 1.5, e.angle, css(c));
      }
    }
    this.drawn += visible.length;
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
    // transports: a small troop pill (the troop markers of what it carries and the count) and, on cargo planes, a tiny
    // parachute mark (mid and close zoom)
    if (z >= 2) {
      for (const e of visible) {
        const u = e.u;
        if (e.type !== 'transport' && e.type !== 'transportPlane') continue;
        // army sizes are public; the troop mix needs intel (own, allies, recon, watchtowers; spectators see all)
        const toMe = me > 0 && u.owner !== me && state.map.owner[u.target] === me;
        const edge = u.owner === me ? '#ffe98a' : toMe ? '#ff6b5e' : css(colors[u.owner] ?? [200, 200, 200]);
        const known = me <= 0 || u.owner === me || hasIntel(state, me, u.owner);
        const owner = (colors[u.owner] ?? [200, 200, 200]) as RGB;
        troopPill(ctx, e.x, e.y - Math.max(e.S * 0.55, 8) - 12, armyTotal(u.troops), troopKinds(known ? u.troops : null), owner, { edge, arrow: u.owner === me ? 'up' : toMe ? 'down' : 'none', alarm: toMe, small: true });
        if (e.type === 'transportPlane') {
          const mk = this.markArgs;
          mk.x = e.x;
          mk.y = e.y;
          mk.half = e.S;
          mk.owner = owner;
          mk.zoom = z;
          mk.dpr = dpr;
          artFor('paradrop').drawMark(ctx, mk, motionFor('air'));
        }
      }
    }
  }

  private markArgs: ParachuteMarkDraw = { x: 0, y: 0, half: 0, owner: [200, 200, 200], zoom: 1, dpr: 1 };
  private dropArgs: ParadropDraw = { x: 0, y: 0, owner: [220, 220, 220], ageMs: 0, durMs: 1, t: 0, count: CHUTES, zoom: 1, scale: 1, seed: 0, dpr: 1 };
  private spriteState: MapSpriteState = { zoom: 1, scale: 1, dpr: 1, timeMs: 0, turnRate: 0, speed: 0, moving: false, seed: 0, damage: 0 };

  /** Wakes behind moving ships, contrails behind planes and missiles, each drawn by its category's current style. */
  private drawTrailLayers(ctx: CanvasRenderingContext2D, visible: readonly Vis[], view: TrailView): void {
    const wakes = this.wakeList;
    const trails = this.contrailList;
    wakes.length = 0;
    trails.length = 0;
    const ships = motionFor('ships');
    const air = motionFor('air');
    const missiles = motionFor('missiles');
    for (const e of visible) {
      const tr = GLYPHS[e.type].trail;
      if (tr === 'none' || e.fleet || e.id === undefined || e.tx === undefined || e.ty === undefined) continue;
      const tu: TrailUnit = { id: e.id, key: spriteKey(e.u.type, e.u.variant), x: e.x, y: e.y, tx: e.tx, ty: e.ty, angle: e.angle, half: e.S, moving: !!e.moving, speed: e.speed, turnRate: e.turn, motion: tr === 'wake' ? ships : tr === 'missile' ? missiles : air };
      (tr === 'wake' ? wakes : trails).push(tu);
    }
    // every layer that holds trails draws each frame (old ones fade out after a style change too)
    const wakeStyle = artStyleOf('wakes');
    const trailStyle = artStyleOf('contrails');
    this.trailLayer('wakes', wakeStyle);
    this.trailLayer('contrails', trailStyle);
    for (const [k, l] of this.trailLayers) {
      const [cat, style] = k.split('|');
      const current = cat === 'wakes' ? style === wakeStyle : style === trailStyle;
      l.frame(ctx, current ? (cat === 'wakes' ? wakes : trails) : [], view);
    }
  }

  /**
   * The ducks prank (fx/prankView.ts, owner console): every ship, plane and division is a rubber duck for a few
   * seconds, missiles stay missiles. Returns what is left to draw as usual.
   */
  private drawDucks(ctx: CanvasRenderingContext2D, visible: Vis[], colors: readonly RGB[], z: number): Vis[] {
    const byOwner = new Map<number, Vis[]>();
    const rest: Vis[] = [];
    for (const e of visible) {
      if (e.type === 'rocket' || e.type === 'atomBomb') {
        rest.push(e);
        continue;
      }
      let l = byOwner.get(e.u.owner);
      if (!l) byOwner.set(e.u.owner, (l = []));
      l.push(e);
    }
    for (const [owner, list] of byOwner) strokeDucks(ctx, list, css(colors[owner] ?? [200, 200, 200]), UNDER, z >= NEAR_ZOOM ? 1.6 : 1.2);
    return rest;
  }

  /** Parachutes drifting down around a drop point, in the owner's colour (the 'paradrop' art style draws them). */
  private drawDrops(ctx: CanvasRenderingContext2D, cam: Camera, colors: readonly RGB[], dpr: number, nowMs: number): void {
    const z = cam.zoom;
    const art = artFor('paradrop');
    const m = motionFor('air');
    const dur = art.durationMs(m);
    const reach = art.reachPx(z);
    const d0 = this.dropArgs;
    let keep = 0;
    for (const d of this.drops) {
      const age = nowMs - d.born;
      const t = age / dur;
      if (t >= 1) continue;
      this.drops[keep++] = d;
      const c = cam.tileToScreen(d.x, d.y);
      if (c.x < -reach || c.y < -reach || c.x > cam.viewW + reach || c.y > cam.viewH + reach) continue;
      d0.x = c.x;
      d0.y = c.y;
      d0.owner = (colors[d.owner] ?? [220, 220, 220]) as RGB;
      d0.ageMs = age;
      d0.durMs = dur;
      d0.t = t;
      d0.count = CHUTES;
      d0.zoom = z;
      d0.scale = spriteScale(z);
      // the drop's own turn of the ring of parachutes (born in ms: the look before the art switch)
      d0.seed = (((d.born * 0.001) / (Math.PI * 2)) % 1 + 1) % 1;
      d0.dpr = dpr;
      art.draw(ctx, d0, m);
    }
    this.drops.length = keep;
    ctx.globalAlpha = 1;
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

