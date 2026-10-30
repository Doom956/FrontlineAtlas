// Screen-space overlays: effect radius rings, capital stars, missile / bomber target reticles, explosions,
// floating texts, the hovered tile, the selection and target-mode previews (build ghost, strike circles, routes).
import { buildingAt } from '../../sim/buildings';
import { barrageRadius } from '../../sim/barrage';
import { ATOM_CORE_RADIUS, ATOM_RADIUS, BARRAGE_DELAY, BARRAGE_RADIUS, BOMBER_RADIUS, BUILDINGS, FORT_RADIUS_TECH, ROCKET_RADIUS, TICKS_PER_SECOND, UNITS } from '../../sim/config';
import { barrageRange } from '../../sim/barrage';
import { airfieldRadius, isDisabled, samRadius } from '../../sim/buildings';
import { areAllied } from '../../sim/diplomacy';
import { paradropRange } from '../../sim/units';
import { hasTech } from '../../sim/tech';
import { isTribe } from '../../sim/types';
import type { BuildingType, Effect, GameState } from '../../sim/types';
import type { Camera } from '../camera';
import { drawMarker, type BuildingIconId } from '../icons';
import type { Snap } from '../placement';
import { FLOATER_MS, type UiState } from '../uiState';
import { barrageReach, strikeOfMode, strikeTarget, type StrikeTarget } from '../strikes';
import { clamp, css, dashedLine, haloText, MAP_LABEL_FAMILY, MAP_NUM_FAMILY, mix, pill, setTracking, type RGB } from './common';
import type { UnitLayer } from './units';
import { markerSize } from './buildings';
import { displayColor, type DisplayRole } from './palette';

const RING_TYPES: readonly BuildingType[] = ['fort', 'sam', 'airfield', 'watchtower'];
const EFFECT_SECONDS = 1.5;

export function ringRadius(state: GameState, type: BuildingType, owner: number): number {
  const p = state.players[owner];
  if (type === 'fort') return p && hasTech(p, 'fortification') ? FORT_RADIUS_TECH : BUILDINGS.fort.radius;
  if (type === 'watchtower') return BUILDINGS.watchtower.radius * (p && hasTech(p, 'radar') ? 2 : 1);
  return BUILDINGS[type].radius;
}

/** Your land smaller than this on screen (px across): the capital gets a pulsing locator ring. */
const LOCATOR_PX = 40;

export class Overlays {
  /** first ETA (s) seen per missile / bomber, for the countdown ring */
  private etas = new Map<number, number>();
  private w = 1;
  /** the strike check under the cursor, refreshed when the tile, mode or a few ticks change */
  private targetKey = '';
  private target: StrikeTarget | null = null;
  /** barrage reach shading: the mask as a small canvas, rebuilt every 2 s of game time while aiming */
  private reachKey = '';
  private reachCanvas: HTMLCanvasElement | null = null;
  private reachCell = 1;
  /** muted map shade per colour and role, as 'r,g,b' (see mutedRgb) */
  private muted = new Map<string, string>();

  reset(w: number): void {
    this.etas.clear();
    this.w = w;
  }

  private ring(ctx: CanvasRenderingContext2D, cam: Camera, tile: number, radius: number, color: RGB, strong: boolean): void {
    const s = cam.tileToScreen((tile % this.w) + 0.5, ((tile / this.w) | 0) + 0.5);
    ctx.beginPath();
    ctx.arc(s.x, s.y, radius * cam.zoom, 0, Math.PI * 2);
    ctx.fillStyle = css(color, strong ? 0.1 : 0.05);
    ctx.fill();
    ctx.setLineDash([5, 4]);
    ctx.lineWidth = strong ? 1.5 : 1;
    ctx.strokeStyle = css(color, strong ? 0.85 : 0.4);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  /** Effect radius of the hovered building, or of the building being placed (plus your others of that type). */
  rings(ctx: CanvasRenderingContext2D, state: GameState, cam: Camera, ui: UiState, snap: Snap | null, me: number): void {
    const hover = ui.hoverTile;
    if (ui.mode.kind === 'build' && RING_TYPES.includes(ui.mode.building)) {
      const type = ui.mode.building;
      for (const b of state.buildings.values()) {
        if (b.owner === me && b.type === type) this.ring(ctx, cam, b.tile, ringRadius(state, type, me), [180, 220, 255], false);
      }
      const at = snap && snap.tile >= 0 ? snap.tile : hover;
      if (at >= 0) this.ring(ctx, cam, at, ringRadius(state, type, me), [255, 255, 255], true);
    }
    if (hover >= 0 && ui.mode.kind !== 'build') {
      const b = buildingAt(state, hover);
      if (b && RING_TYPES.includes(b.type)) {
        const c = state.players[b.owner]?.color ?? [255, 255, 255];
        this.ring(ctx, cam, b.tile, ringRadius(state, b.type, b.owner), mix(c, [255, 255, 255], 0.5), true);
      }
    }
  }

  private star(ctx: CanvasRenderingContext2D, x: number, y: number, R: number, fill: string, stroke: string): void {
    ctx.beginPath();
    for (let k = 0; k < 10; k++) {
      const a = -Math.PI / 2 + (k * Math.PI) / 5;
      const r = k % 2 === 0 ? R : R * 0.45;
      if (k === 0) ctx.moveTo(x + Math.cos(a) * r, y + Math.sin(a) * r);
      else ctx.lineTo(x + Math.cos(a) * r, y + Math.sin(a) * r);
    }
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = stroke;
    ctx.stroke();
  }

  /**
   * Capital stars: always in the spawn phase (with a name tag and a ring; your own spot breathes), else from
   * `minZoom` on, next to the capital's city marker.
   */
  capitals(ctx: CanvasRenderingContext2D, state: GameState, cam: Camera, colors: readonly RGB[], me: number, minZoom: number, nowMs: number): void {
    const spawn = state.phase === 'spawn';
    const pulse = 0.5 + 0.5 * Math.sin(nowMs / 260);
    if (!spawn) this.locator(ctx, state, cam, me, pulse);
    if (!spawn && cam.zoom < minZoom) return;
    const v = cam.visibleTiles(8);
    for (const p of state.players) {
      if (!p || p.id === 0 || p.capital < 0 || (!p.alive && !spawn) || (spawn && !p.spawned)) continue;
      const x = p.capital % this.w;
      const y = (p.capital / this.w) | 0;
      if (x < v.x0 || x >= v.x1 || y < v.y0 || y >= v.y1) continue;
      const tribe = isTribe(p);
      // tribes get no star once the game runs: a star on every small parcel was only noise
      if (tribe && (!spawn || cam.zoom < 1.5)) continue;
      const s = cam.tileToScreen(x + 0.5, y + 0.5);
      const hasBuilding = state.map.building[p.capital] !== 0;
      const R = clamp(cam.zoom * 0.6, 5, 10) * (tribe ? 0.7 : 1);
      // top-left of the capital's city marker (its level badge sits top-right)
      const off = hasBuilding ? markerSize(cam.zoom) * 0.62 : 0;
      const sx = s.x - off;
      const sy = s.y - off;
      if (spawn) {
        const own = p.id === me;
        const rr = Math.max(R * 1.8, (own ? 5 : 3.5) * cam.zoom) * (own ? 1 + 0.25 * pulse : 1);
        ctx.beginPath();
        ctx.arc(s.x, s.y, rr, 0, Math.PI * 2);
        ctx.lineWidth = own ? 1.75 : 1.25;
        ctx.strokeStyle = own ? `rgba(255,255,255,${0.55 + 0.4 * pulse})` : css(p.color, tribe ? 0.45 : 0.5 + 0.4 * pulse);
        ctx.stroke();
      }
      if (p.id === me && !spawn) {
        // your own capital: a white ring around the star, so it stands out from the others
        ctx.beginPath();
        ctx.arc(sx, sy, R * 1.45, 0, Math.PI * 2);
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = 'rgba(255,255,255,0.9)';
        ctx.stroke();
      }
      this.star(ctx, sx, sy, R, css(colors[p.id] ?? p.color), p.id === me ? '#ffffff' : '#141414');
      if (spawn && p.id !== me && (!tribe || cam.zoom >= 3)) {
        ctx.font = tribe ? `500 12px ${MAP_LABEL_FAMILY}` : `600 12px ${MAP_LABEL_FAMILY}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'bottom';
        const track = tribe ? 0 : 0.8;
        setTracking(ctx, track);
        haloText(ctx, tribe ? p.name : p.name.toUpperCase(), sx + track / 2, sy - R - 2, tribe ? 'rgba(232,234,238,0.85)' : 'rgba(255,255,255,0.94)', 12);
        setTracking(ctx, 0);
      }
    }
  }

  /**
   * "You are here": while your land is smaller than about LOCATOR_PX on screen, a pulsing white ring (and a star)
   * around your capital, so a new player finds their nation at any zoom.
   */
  private locator(ctx: CanvasRenderingContext2D, state: GameState, cam: Camera, me: number, pulse: number): void {
    const p = me > 0 ? state.players[me] : undefined;
    if (!p || !p.alive || p.capital < 0) return;
    const size = Math.sqrt(Math.max(1, p.tiles)) * cam.zoom;
    if (size >= LOCATOR_PX) return;
    const s = cam.tileToScreen((p.capital % this.w) + 0.5, ((p.capital / this.w) | 0) + 0.5);
    if (s.x < -40 || s.y < -40 || s.x > cam.viewW + 40 || s.y > cam.viewH + 40) return;
    const r = Math.max(size * 0.55, 9) + 2.5 * pulse;
    ctx.beginPath();
    ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = 'rgba(0,0,0,0.35)';
    ctx.stroke();
    ctx.lineWidth = 1.25;
    ctx.strokeStyle = `rgba(255,255,255,${0.55 + 0.35 * pulse})`;
    ctx.stroke();
    ctx.font = `600 11px ${MAP_LABEL_FAMILY}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    setTracking(ctx, 1.2);
    haloText(ctx, 'YOU', s.x + 0.6, s.y - r - 2, 'rgba(255,255,255,0.92)', 11);
    setTracking(ctx, 0);
  }

  /** Muted map shade of a nation (the same calm colour the territory is painted with), lightened so a thin line reads over land. */
  private mutedRgb(colors: readonly RGB[], state: GameState, owner: number, me: number): string {
    const p = state.players[owner];
    const base = colors[owner] ?? p?.color ?? [200, 200, 200];
    const role: DisplayRole = owner === me ? 'own' : p && isTribe(p) ? 'tribe' : 'nation';
    const key = `${base[0]},${base[1]},${base[2]}|${role}`;
    let v = this.muted.get(key);
    if (v === undefined) {
      const m = mix(displayColor(base, { role }), [255, 255, 255], 0.3);
      v = `${m[0]},${m[1]},${m[2]}`;
      if (this.muted.size > 256) this.muted.clear();
      this.muted.set(key, v);
    }
    return v;
  }

  /**
   * A strike's blast disc at its exact map radius (`radius` tiles x zoom): a translucent fill and a crisp thin edge,
   * plus a small centre mark so the target is found even when the disc is only a few pixels wide.
   */
  private blastDisc(ctx: CanvasRenderingContext2D, x: number, y: number, radius: number, z: number, rgb: string, fillA: number, lineA: number, lineW = 1.25): number {
    const R = radius * z;
    if (R >= 1.5) {
      ctx.beginPath();
      ctx.arc(x, y, R, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(${rgb},${fillA})`;
      ctx.fill();
      // a faint dark under-stroke keeps the thin edge crisp over light and dark land
      ctx.lineWidth = lineW + 1.5;
      ctx.strokeStyle = `rgba(8,10,16,${(0.3 * lineA).toFixed(3)})`;
      ctx.stroke();
      ctx.lineWidth = lineW;
      ctx.strokeStyle = `rgba(${rgb},${lineA})`;
      ctx.stroke();
    }
    return R;
  }

  private centreMark(ctx: CanvasRenderingContext2D, x: number, y: number, rgb: string, a: number): void {
    ctx.beginPath();
    ctx.moveTo(x - 4, y);
    ctx.lineTo(x + 4, y);
    ctx.moveTo(x, y - 4);
    ctx.lineTo(x, y + 4);
    ctx.lineWidth = 1.25;
    ctx.strokeStyle = `rgba(${rgb},${a})`;
    ctx.stroke();
  }

  /** Thin countdown arc just outside the disc: full at launch, empty at impact. */
  private countdownArc(ctx: CanvasRenderingContext2D, x: number, y: number, R: number, left: number, rgb: string, a: number, w: number): void {
    if (left <= 0.001) return;
    ctx.beginPath();
    ctx.arc(x, y, R + 3, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * left);
    ctx.lineWidth = w;
    ctx.lineCap = 'round';
    ctx.strokeStyle = `rgba(${rgb},${a})`;
    ctx.stroke();
    ctx.lineCap = 'butt';
  }

  /**
   * Missiles, atom bombs and bombing runs in flight: the blast disc at the target (exact radius) with a thin
   * countdown arc. Red when it is your land, your own colour (muted) for your strikes, the attacker's muted colour
   * for strikes between other nations (lighter, so the map stays calm). Cargo planes keep a small drop mark.
   */
  telegraphs(ctx: CanvasRenderingContext2D, state: GameState, cam: Camera, units: UnitLayer, frac: number, me: number, nowMs: number, colors: readonly RGB[] = []): void {
    if (me <= 0 || state.units.length === 0) return;
    const z = cam.zoom;
    const pulse = 0.5 + 0.5 * Math.sin(nowMs / 160);
    const live = new Set<number>();
    for (const u of state.units) {
      const kind = u.type;
      const strike = kind === 'rocket' || kind === 'atomBomb' || (kind === 'bomber' && u.state === 0);
      const drop = kind === 'transportPlane' && u.state === 0;
      if (!strike && !drop) continue;
      const own = u.owner === me;
      const atMe = !own && state.map.owner[u.target] === me;
      if (drop && !own && !atMe) continue;
      live.add(u.id);
      const tx = (u.target % this.w) + 0.5;
      const ty = ((u.target / this.w) | 0) + 0.5;
      const p = units.pos(u, frac);
      const dist = Math.hypot(tx - (p.x + 0.5), ty - (p.y + 0.5));
      const eta = dist / Math.max(0.1, UNITS[kind].speed);
      let eta0 = this.etas.get(u.id);
      if (eta0 === undefined || eta0 < eta) {
        eta0 = Math.max(eta, 0.1);
        this.etas.set(u.id, eta0);
      }
      const s = cam.tileToScreen(tx, ty);
      const outer = kind === 'atomBomb' ? ATOM_RADIUS : kind === 'rocket' ? ROCKET_RADIUS : kind === 'transportPlane' ? 2.5 : BOMBER_RADIUS;
      const R = outer * z;
      if (s.x < -R - 20 || s.y < -R - 20 || s.x > cam.viewW + R + 20 || s.y > cam.viewH + R + 20) continue;
      // strikes between others stay faint and vanish when they would only be specks
      if (!own && !atMe && R < 4) continue;
      const rgb = atMe ? '236,74,58' : this.mutedRgb(colors, state, u.owner, me);
      const k = atMe ? 1 : own ? 0.75 : 0.55;
      const calm = atMe ? 0.1 + 0.06 * pulse : 0.07 * k;
      const edge = atMe ? 0.7 + 0.25 * pulse : 0.7 * k;
      if (kind === 'atomBomb') {
        this.blastDisc(ctx, s.x, s.y, ATOM_RADIUS, z, rgb, calm * 0.7, edge * 0.8);
        this.blastDisc(ctx, s.x, s.y, ATOM_CORE_RADIUS, z, rgb, calm * 1.3, edge);
      } else {
        this.blastDisc(ctx, s.x, s.y, outer, z, rgb, calm, edge);
      }
      this.centreMark(ctx, s.x, s.y, rgb, Math.min(1, edge + 0.2));
      const left = clamp(eta / eta0, 0, 1);
      this.countdownArc(ctx, s.x, s.y, Math.max(R, 5), left, rgb, atMe ? 0.95 : 0.7 * k + 0.15, atMe ? 1.75 : 1.25);
      if (atMe || (own && z >= 1.5)) {
        const label = `${eta < 9.95 ? eta.toFixed(1) : Math.round(eta)}s`;
        ctx.font = `500 11px ${MAP_NUM_FAMILY}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'bottom';
        haloText(ctx, label, s.x, s.y - Math.max(R, 5) - 6, atMe ? '#ffb3aa' : '#ffffff', 11);
      }
    }
    for (const id of this.etas.keys()) if (!live.has(id)) this.etas.delete(id);
  }

  /**
   * Artillery barrages in flight: the BARRAGE_RADIUS disc where the shells will land with a thin countdown arc (red
   * when it is your land, else the shooter's muted colour) and shells arcing in over the last second.
   */
  barrages(ctx: CanvasRenderingContext2D, state: GameState, cam: Camera, frac: number, me: number, nowMs: number, colors: readonly RGB[] = []): void {
    const list = state.barrages;
    if (!list || list.length === 0) return;
    const z = cam.zoom;
    const now = state.tick + frac;
    const pulse = 0.5 + 0.5 * Math.sin(nowMs / 160);
    for (const b of list) {
      const s = cam.tileToScreen((b.tile % this.w) + 0.5, ((b.tile / this.w) | 0) + 0.5);
      const radius = b.radius ?? BARRAGE_RADIUS;
      const R = radius * z;
      if (s.x < -R - 40 || s.y < -R - 40 || s.x > cam.viewW + R + 40 || s.y > cam.viewH + R + 40) continue;
      const atMe = me > 0 && b.owner !== me && b.target === me;
      const mine = b.owner === me;
      if (!atMe && !mine && R < 4) continue;
      const rgb = atMe ? '236,74,58' : this.mutedRgb(colors, state, b.owner, me);
      const k = atMe ? 1 : mine ? 0.75 : 0.55;
      const left = clamp((b.hitTick - now) / (BARRAGE_DELAY * TICKS_PER_SECOND), 0, 1);
      this.blastDisc(ctx, s.x, s.y, radius, z, rgb, atMe ? 0.1 + 0.06 * pulse : 0.07 * k, atMe ? 0.7 + 0.25 * pulse : 0.7 * k);
      this.centreMark(ctx, s.x, s.y, rgb, Math.min(1, 0.7 * k + 0.2));
      this.countdownArc(ctx, s.x, s.y, Math.max(R, 5), left, rgb, atMe ? 0.95 : 0.7 * k + 0.15, atMe ? 1.75 : 1.25);
      if (!atMe && !mine) continue;
      // shells: thin streaks coming down from the upper left onto points of the disc
      const p = 1 - left;
      const span = Math.max(R, 12);
      for (let n = 0; n < 5; n++) {
        const a = (n * 2.4 + b.id) % (Math.PI * 2);
        const rr = span * (0.2 + 0.7 * (((n * 53 + b.id) % 10) / 10));
        const tx = s.x + Math.cos(a) * rr;
        const ty = s.y + Math.sin(a) * rr;
        const q = clamp(p * 1.25 - n * 0.06, 0, 1);
        if (q <= 0) continue;
        const sx = tx - (1 - q) * (60 + span);
        const sy = ty - (1 - q) * (90 + span) + (1 - q) * (1 - q) * 30;
        ctx.beginPath();
        ctx.moveTo(sx - 6, sy - 9);
        ctx.lineTo(sx, sy);
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = 'rgba(255,236,190,0.8)';
        ctx.stroke();
      }
    }
  }

  effects(ctx: CanvasRenderingContext2D, state: GameState, cam: Camera, frac: number): void {
    const z = cam.zoom;
    for (const e of state.effects) {
      const age = (state.tick - e.tick + frac) / TICKS_PER_SECOND;
      const t = age / EFFECT_SECONDS;
      if (t < 0 || t >= 1) continue;
      const s = cam.tileToScreen(e.x, e.y);
      const reach = Math.max(e.radius, 1) * z * 2 + 40;
      if (e.kind !== 'shot' && (s.x < -reach || s.y < -reach || s.x > cam.viewW + reach || s.y > cam.viewH + reach)) continue;
      this.effect(ctx, e, s.x, s.y, t, cam);
    }
    ctx.globalAlpha = 1;
  }

  private effect(ctx: CanvasRenderingContext2D, e: Effect, x: number, y: number, t: number, cam: Camera): void {
    const z = cam.zoom;
    const R = Math.max(e.radius, 0.5) * z;
    // the blast disc flashes at its exact radius, then fades (rocket, bombs, atom bomb, barrage; not the small blasts)
    if (e.radius >= 4 && e.kind !== 'shot' && e.kind !== 'capture') {
      const f = t < 0.12 ? 1 : Math.max(0, 1 - (t - 0.12) / 0.88);
      const rgb = e.kind === 'nuke' ? '255,214,140' : '255,196,110';
      this.blastDisc(ctx, x, y, e.radius, z, rgb, 0.3 * f * f, 0.95 * f, 1.5);
      if (e.kind === 'nuke') this.blastDisc(ctx, x, y, ATOM_CORE_RADIUS, z, '255,150,80', 0.3 * f * f, 0.95 * f, 1.5);
    }
    switch (e.kind) {
      case 'explosion': {
        const r = Math.max(6, R) * (0.3 + 0.7 * t);
        ctx.globalAlpha = 1 - t;
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(255,150,50,0.4)';
        ctx.fill();
        ctx.lineWidth = 2;
        ctx.strokeStyle = 'rgba(255,230,160,0.9)';
        ctx.stroke();
        break;
      }
      case 'nuke': {
        const big = Math.max(20, R);
        if (t < 0.3) {
          ctx.globalAlpha = 1 - t / 0.3;
          ctx.beginPath();
          ctx.arc(x, y, big * 1.5, 0, Math.PI * 2);
          ctx.fillStyle = 'rgba(255,255,240,0.85)';
          ctx.fill();
        }
        ctx.globalAlpha = 1 - t;
        const g = ctx.createRadialGradient(x, y, 0, x, y, big * (0.5 + 0.5 * t));
        g.addColorStop(0, 'rgba(255,250,210,0.95)');
        g.addColorStop(0.4, 'rgba(255,160,40,0.8)');
        g.addColorStop(1, 'rgba(200,60,20,0)');
        ctx.beginPath();
        ctx.arc(x, y, big * (0.5 + 0.5 * t), 0, Math.PI * 2);
        ctx.fillStyle = g;
        ctx.fill();
        ctx.beginPath();
        ctx.arc(x, y, big * (0.4 + 1.3 * t), 0, Math.PI * 2);
        ctx.lineWidth = 3;
        ctx.strokeStyle = 'rgba(255,200,120,0.9)';
        ctx.stroke();
        break;
      }
      case 'shot': {
        if (e.x2 === undefined || e.y2 === undefined) break;
        const s2 = cam.tileToScreen(e.x2, e.y2);
        ctx.globalAlpha = Math.max(0, 1 - t * 2);
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(s2.x, s2.y);
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = 'rgba(255,240,150,1)';
        ctx.stroke();
        break;
      }
      case 'barrage': {
        // a ripple of small bursts over the disc (at least ~18 px across so it reads when zoomed out)
        const RB = Math.max(18, R);
        for (let k = 0; k < 7; k++) {
          const tk = t * 1.4 - k * 0.07;
          if (tk <= 0 || tk >= 1) continue;
          const a = k * 2.1 + e.x;
          const rr = RB * (0.15 + 0.8 * ((k * 37) % 10) / 10);
          const bx = x + Math.cos(a) * rr;
          const by = y + Math.sin(a) * rr;
          const br = Math.max(7, z * 1.4) * (0.5 + 0.8 * tk);
          ctx.globalAlpha = 1 - tk;
          ctx.beginPath();
          ctx.arc(bx, by, br, 0, Math.PI * 2);
          ctx.fillStyle = 'rgba(255,170,70,0.7)';
          ctx.fill();
          ctx.lineWidth = 1.5;
          ctx.strokeStyle = 'rgba(255,236,190,0.9)';
          ctx.stroke();
        }
        break;
      }
      case 'capture': {
        const r = Math.max(3, z * 0.8) * (0.5 + t);
        ctx.globalAlpha = 1 - t;
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = 'rgba(255,255,220,1)';
        ctx.beginPath();
        for (let k = 0; k < 4; k++) {
          const a = (k * Math.PI) / 2 + t * 2;
          ctx.moveTo(x + Math.cos(a) * r * 0.3, y + Math.sin(a) * r * 0.3);
          ctx.lineTo(x + Math.cos(a) * r, y + Math.sin(a) * r);
        }
        ctx.stroke();
        break;
      }
    }
    ctx.globalAlpha = 1;
  }

  /** "+120 gold" texts rising from a map position; expired ones are removed here. */
  floaters(ctx: CanvasRenderingContext2D, ui: UiState, cam: Camera, nowMs: number): void {
    const list = ui.floaters;
    if (list.length === 0) return;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `500 13px ${MAP_NUM_FAMILY}`;
    let keep = 0;
    for (let k = 0; k < list.length; k++) {
      const f = list[k];
      const t = (nowMs - f.born) / FLOATER_MS;
      if (t >= 1 || t < -0.5) continue;
      list[keep++] = f;
      if (t < 0) continue;
      const s = cam.tileToScreen(f.x, f.y);
      if (s.x < -80 || s.y < -40 || s.x > cam.viewW + 80 || s.y > cam.viewH + 40) continue;
      const y = s.y - 8 - 30 * t;
      ctx.globalAlpha = t < 0.7 ? 1 : 1 - (t - 0.7) / 0.3;
      haloText(ctx, f.text, s.x, y, f.color, 13);
    }
    list.length = keep;
    ctx.globalAlpha = 1;
  }

  private tileRect(cam: Camera, tile: number, minPx: number): { x: number; y: number; s: number } {
    const c = cam.tileToScreen((tile % this.w) + 0.5, ((tile / this.w) | 0) + 0.5);
    const s = Math.max(minPx, cam.zoom);
    return { x: c.x - s / 2, y: c.y - s / 2, s };
  }

  /** The strike check for the hovered tile (cached per tile, mode and 4 ticks). */
  private check(state: GameState, ui: UiState, tile: number): StrikeTarget | null {
    const me = state.players[state.humanId];
    if (!me || !strikeOfMode(ui.mode)) return null;
    const m = ui.mode;
    const key = `${tile}|${m.kind}|${m.kind === 'missile' ? m.missile + m.silo : m.kind === 'bomb' || m.kind === 'paradrop' ? m.airfield : ''}|${state.tick >> 2}|${ui.attackShare}`;
    if (key !== this.targetKey || !this.target) {
      this.targetKey = key;
      this.target = strikeTarget(state, me, ui, m, tile);
    }
    return this.target;
  }

  /**
   * While aiming a strike: where it can go and what stands in the way. Barrage: the land out of the guns' reach is
   * shaded. Planes and missiles: hostile SAM sites (and, for planes, fighter airfields) show their cover as red
   * dashed rings, and your launch sites are marked.
   */
  strikeZones(ctx: CanvasRenderingContext2D, state: GameState, cam: Camera, ui: UiState): void {
    const id = strikeOfMode(ui.mode);
    const me = state.players[state.humanId];
    if (!id || !me || state.phase !== 'playing') return;
    if (id === 'barrage') {
      this.drawReach(ctx, state, cam, me.id, barrageRange(me));
      return;
    }
    const planes = id === 'bomb' || id === 'paradrop';
    const own = id === 'rocket' || id === 'atomBomb' ? 'silo' : 'airfield';
    for (const b of state.buildings.values()) {
      if (b.buildLeft > 0) continue;
      if (b.owner === me.id) {
        if (b.type === own && id !== 'paradrop') this.ring(ctx, cam, b.tile, 2.5, [214, 170, 60], true);
        continue;
      }
      if (b.owner <= 0 || areAllied(state, me.id, b.owner)) continue;
      if (b.type === 'sam' && !isDisabled(state, b)) this.ring(ctx, cam, b.tile, samRadius(b), [226, 72, 52], false);
      else if (planes && b.type === 'airfield' && b.fighters > 0) this.ring(ctx, cam, b.tile, airfieldRadius(b), [226, 120, 52], false);
    }
  }

  private drawReach(ctx: CanvasRenderingContext2D, state: GameState, cam: Camera, me: number, range: number): void {
    const key = `${me}|${range}|${Math.floor(state.tick / (2 * TICKS_PER_SECOND))}|${state.map.width}`;
    if (key !== this.reachKey || !this.reachCanvas) {
      this.reachKey = key;
      const mask = barrageReach(state, me, range);
      const c = this.reachCanvas ?? document.createElement('canvas');
      c.width = mask.cw;
      c.height = mask.ch;
      const g = c.getContext('2d');
      if (!g) return;
      const img = g.createImageData(mask.cw, mask.ch);
      const px = img.data;
      for (let i = 0; i < mask.inside.length; i++) {
        const o = i * 4;
        if (mask.inside[i]) {
          px[o] = 214;
          px[o + 1] = 170;
          px[o + 2] = 60;
          px[o + 3] = 22;
        } else {
          px[o] = 6;
          px[o + 1] = 8;
          px[o + 2] = 10;
          px[o + 3] = 120;
        }
      }
      g.putImageData(img, 0, 0);
      this.reachCanvas = c;
      this.reachCell = mask.cell;
    }
    const c = this.reachCanvas;
    if (!c) return;
    const o = cam.tileToScreen(0, 0);
    const z = cam.zoom;
    ctx.save();
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(c, o.x, o.y, c.width * this.reachCell * z, c.height * this.reachCell * z);
    ctx.restore();
  }

  /**
   * The aiming disc of a strike at the pointer: translucent fill and a crisp thin edge at the exact blast radius in
   * map scale (so it grows and shrinks with the zoom), a small label with the radius, red when the strike is not
   * valid here. An atom bomb passes two rings: the outer blast and the core that turns neutral (a deeper fill).
   */
  private aimDisc(ctx: CanvasRenderingContext2D, cam: Camera, x: number, y: number, ok: boolean, rings: { radius: number; core?: boolean }[], label: string): void {
    const z = cam.zoom;
    let top = 0;
    for (const r of rings) {
      const rgb = !ok ? '226,72,52' : r.core ? '240,110,60' : '214,170,60';
      const fill = !ok ? (r.core ? 0.2 : 0.11) : r.core ? 0.2 : rings.length > 1 ? 0.1 : 0.2;
      this.blastDisc(ctx, x, y, r.radius, z, rgb, fill, ok ? 0.95 : 0.9, 1.5);
      top = Math.max(top, r.radius * z);
    }
    this.centreMark(ctx, x, y, ok ? '255,236,190' : '255,170,160', 0.9);
    ctx.font = `600 12px ${MAP_LABEL_FAMILY}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    setTracking(ctx, 0.6);
    const tw = ctx.measureText(label).width;
    const half = tw / 2 + 8;
    const lx = clamp(x, half, Math.max(half, cam.viewW - half));
    const ly = clamp(y - Math.max(top, 8) - 7, 20, Math.max(20, cam.viewH - 8));
    ctx.beginPath();
    ctx.roundRect(lx - tw / 2 - 6, ly - 16, tw + 12, 19, 6);
    ctx.fillStyle = 'rgba(10,13,21,0.62)';
    ctx.fill();
    haloText(ctx, label, lx, ly, ok ? '#f6e7b8' : '#ffb8ae', 12, 1.2);
    setTracking(ctx, 0);
  }

  /** Selection, hovered tile and the preview of the current target mode. */
  hoverAndPreview(ctx: CanvasRenderingContext2D, state: GameState, cam: Camera, ui: UiState, snap: Snap | null, units: UnitLayer, frac: number, dpr: number): void {
    const n = state.map.width * state.map.height;
    const z = cam.zoom;
    if (ui.selectedTile >= 0 && ui.selectedTile < n) {
      const r = this.tileRect(cam, ui.selectedTile, 7);
      ctx.lineWidth = 2;
      ctx.strokeStyle = '#ffd84a';
      ctx.strokeRect(r.x, r.y, r.s, r.s);
    }
    const hover = ui.hoverTile;
    if (hover < 0 || hover >= n) return;
    const hs = cam.tileToScreen((hover % this.w) + 0.5, ((hover / this.w) | 0) + 0.5);
    const mode = ui.mode;
    const circle = (radius: number, color: string, fill: string): void => {
      ctx.beginPath();
      ctx.arc(hs.x, hs.y, Math.max(radius * z, 4), 0, Math.PI * 2);
      ctx.fillStyle = fill;
      ctx.fill();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = color;
      ctx.stroke();
    };
    const lineFrom = (tile: number, color: string): void => {
      if (tile < 0 || tile >= n) return;
      const a = cam.tileToScreen((tile % this.w) + 0.5, ((tile / this.w) | 0) + 0.5);
      dashedLine(ctx, a.x, a.y, hs.x, hs.y, color);
    };
    switch (mode.kind) {
      case 'build': {
        // exactly what the click will do: build here (green), upgrade that building (blue) or why not (red)
        const at = snap && snap.tile >= 0 ? snap.tile : hover;
        const ok = !!snap && snap.tile >= 0 && snap.ok;
        const up = !!snap && snap.upgrade;
        const tone = ok ? (up ? '#4d7fb3' : '#5c8a3a') : '#b8463a';
        const line = ok ? (up ? 'rgba(130,175,225,0.9)' : 'rgba(150,200,110,0.85)') : 'rgba(230,110,90,0.8)';
        const gs = cam.tileToScreen((at % this.w) + 0.5, ((at / this.w) | 0) + 0.5);
        if (at !== hover) dashedLine(ctx, hs.x, hs.y, gs.x, gs.y, line);
        const size = Math.max(26, clamp(6 + z * 2.3, 14, 40));
        if (up) {
          // highlight the building that will be upgraded
          ctx.beginPath();
          ctx.arc(gs.x, gs.y, size * 0.85, 0, Math.PI * 2);
          ctx.lineWidth = 2.5;
          ctx.strokeStyle = ok ? 'rgba(130,175,225,0.95)' : 'rgba(230,110,90,0.9)';
          ctx.stroke();
        } else {
          const r = this.tileRect(cam, at, 6);
          ctx.fillStyle = ok ? 'rgba(120,180,80,0.45)' : 'rgba(200,70,55,0.45)';
          ctx.fillRect(r.x, r.y, r.s, r.s);
          drawMarker(ctx, mode.building as BuildingIconId, gs.x, gs.y, size, { plate: tone, dpr, alpha: 0.9 });
        }
        const text = ok ? (up ? `Upgrade to level ${snap?.level ?? ''}` : 'Build here') : snap?.error || 'Cannot build here';
        pill(ctx, gs.x, gs.y - size / 2 - (up ? size * 0.4 : 0) - 14, text, ok ? (up ? '#82afe1' : '#9cc86e') : '#e6705a', up && ok ? 'up' : 'none');
        break;
      }
      case 'bomb': {
        const t = this.check(state, ui, hover);
        if (t?.from !== undefined) lineFrom(t.from, 'rgba(255,255,255,0.6)');
        this.aimDisc(ctx, cam, hs.x, hs.y, !!t?.ok, [{ radius: BOMBER_RADIUS }], `Bombing run · radius ${BOMBER_RADIUS} tiles`);
        break;
      }
      case 'missile': {
        const t = this.check(state, ui, hover);
        if (t?.from !== undefined) lineFrom(t.from, 'rgba(255,255,255,0.6)');
        const ok = !!t?.ok;
        if (mode.missile === 'atomBomb') {
          this.aimDisc(ctx, cam, hs.x, hs.y, ok, [{ radius: ATOM_RADIUS }, { radius: ATOM_CORE_RADIUS, core: true }], `Atom bomb · core ${ATOM_CORE_RADIUS} · blast ${ATOM_RADIUS} tiles`);
        } else {
          this.aimDisc(ctx, cam, hs.x, hs.y, ok, [{ radius: ROCKET_RADIUS }], `Rocket · radius ${ROCKET_RADIUS} tiles`);
        }
        break;
      }
      case 'paradrop': {
        // the reach of each of your airfields, the drop disc and the route from the airfield that would fly
        let best = -1;
        let bestD = Infinity;
        for (const b of state.buildings.values()) {
          if (b.owner !== state.humanId || b.type !== 'airfield' || b.buildLeft > 0) continue;
          if (mode.airfield >= 0 && b.tile !== mode.airfield) continue;
          const range = paradropRange(b, state);
          const c = cam.tileToScreen((b.tile % this.w) + 0.5, ((b.tile / this.w) | 0) + 0.5);
          ctx.beginPath();
          ctx.arc(c.x, c.y, range * z, 0, Math.PI * 2);
          ctx.setLineDash([6, 5]);
          ctx.lineWidth = 1.5;
          ctx.strokeStyle = b.dropCooldown > 0 ? 'rgba(200,200,200,0.45)' : 'rgba(214,170,60,0.85)';
          ctx.stroke();
          ctx.setLineDash([]);
          const dx = (b.tile % this.w) - (hover % this.w);
          const dy = ((b.tile / this.w) | 0) - ((hover / this.w) | 0);
          const d = dx * dx + dy * dy;
          if (d <= range * range && b.dropCooldown <= 0 && d < bestD) {
            bestD = d;
            best = b.tile;
          }
        }
        if (best >= 0) lineFrom(best, 'rgba(214,170,60,0.9)');
        circle(2.5, best >= 0 ? 'rgba(214,170,60,0.95)' : 'rgba(226,72,52,0.95)', best >= 0 ? 'rgba(214,170,60,0.18)' : 'rgba(226,72,52,0.15)');
        break;
      }
      case 'barrage': {
        const ok = !!this.check(state, ui, hover)?.ok;
        this.aimDisc(ctx, cam, hs.x, hs.y, ok, [{ radius: barrageRadius(state, state.humanId) }], `Artillery barrage · radius ${barrageRadius(state, state.humanId)} tiles`);
        break;
      }
      case 'transport':
        lineFrom(mode.from, 'rgba(160,220,255,0.9)');
        circle(0.8, 'rgba(160,220,255,0.95)', 'rgba(160,220,255,0.25)');
        break;
      case 'moveWarship': {
        const u = state.units.find((q) => q.id === mode.unitId);
        if (u) {
          const p = units.pos(u, frac);
          const a = cam.tileToScreen(p.x + 0.5, p.y + 0.5);
          dashedLine(ctx, a.x, a.y, hs.x, hs.y, 'rgba(160,220,255,0.9)');
        }
        circle(0.8, 'rgba(160,220,255,0.95)', 'rgba(160,220,255,0.25)');
        break;
      }
      case 'none':
        break;
    }
    const r = this.tileRect(cam, hover, 6);
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = 'rgba(255,255,255,0.95)';
    ctx.strokeRect(r.x, r.y, r.s, r.s);
  }
}
